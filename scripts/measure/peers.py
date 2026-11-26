"""Ticket 1171: launch time, idle memory and idle CPU of an installed peer app (Orca, T3 Code), for the scorecard's
peer-based anchors (docs/measure/rubric.md). Usage:
  peers.py "/Applications/Orca.app" [--launches 4] [--settle 45] [--cpu-secs 60] [--out FILE]

The app starts through LaunchServices (`open -g`: as a person's click does, but not in front) on the owner's own
profile as it is. Nothing is clicked, typed, signed in or changed. Launch = just before `open` to the first on-screen
window of the app's main process wider than 200 px (baseline.py winwait); that is earlier than "first content drawn",
which Nunchiro's own launch figure waits for, so the peer's figure is a floor. The last launch is kept open: after
--settle seconds, `footprint` (phys_footprint) of the main process, its descendants and the processes it is
responsible for, then their CPU over --cpu-secs. Processes of the app that ran before (a background daemon the app
keeps, with its sessions) are listed and left alone; they are not in the sums.
Refuses to run when the app's main process already runs. Stops only the PIDs it saw start under its own launch
(SIGTERM to the main process, the app's own quit path; SIGKILL after 15 s for what is left of that set).
Stdlib only; the pure parts are tested by tests/scenario/test_measure_peers.py."""
import argparse, json, os, plistlib, statistics, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))


def ps_table():
    """{pid: (ppid, command)} of every process."""
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
    return parse_ps3(out)


def parse_ps3(text):
    table = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit():
            table[int(parts[0])] = (int(parts[1]), parts[2])
    return table


def tree(table, root):
    """root and every process under it."""
    kids = {}
    for pid, (ppid, _) in table.items():
        kids.setdefault(ppid, []).append(pid)
    out, stack = [root], [root]
    while stack:
        for k in kids.get(stack.pop(), []):
            out.append(k)
            stack.append(k)
    return out


def summary(launch_ms):
    """The first launch (the app had not run since the login or for a long time) and the median of the later ones."""
    warm = [m for m in launch_ms[1:] if m is not None]
    return dict(first_ms=launch_ms[0] if launch_ms else None, warm_median_ms=round(statistics.median(warm)) if warm else None,
                warm_ms=launch_ms[1:], missed=sum(m is None for m in launch_ms))


def stop(pids, main):
    """SIGTERM to the main process (the app's own quit path), then to what is left of the pids this run saw start,
    then SIGKILL to those; returns the pids still alive at the end."""
    def alive():
        table = ps_table()
        return [p for p in pids if p in table]

    def signal_and_wait(targets, sig, wait):
        for p in targets:
            try:
                os.kill(p, sig)
            except (ProcessLookupError, PermissionError):
                pass
        until = time.monotonic() + wait
        while alive() and time.monotonic() < until:
            time.sleep(0.2)

    signal_and_wait([main], 15, 15)
    signal_and_wait(alive(), 15, 5)
    signal_and_wait(alive(), 9, 5)
    return alive()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("app")
    ap.add_argument("--launches", type=int, default=4)
    ap.add_argument("--settle", type=int, default=45)
    ap.add_argument("--cpu-secs", type=int, default=60)
    ap.add_argument("--out")
    a = ap.parse_args()
    import baseline as bl
    import measurelib as ml
    import release as rel

    app = Path(a.app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    exe = str(app / "Contents/MacOS" / info["CFBundleExecutable"])
    before = ps_table()
    if any(cmd == exe for _, cmd in before.values()):
        raise SystemExit(f"refused: {app.name} already runs; it is not ours to measure or stop")
    word = app.stem.split(" ")[0].lower()  # "orca", "t3": for the two lists of the app's other processes (shown, never stopped)
    already = sorted(p for p, (_, cmd) in before.items() if word in cmd.lower())
    bl.OUT.mkdir(parents=True, exist_ok=True)
    winwait = bl.winwait()
    launches, sample, left = [], None, []
    for i in range(a.launches):
        seen, main_pid = set(), None
        t0 = time.time() * 1000
        subprocess.run(["open", "-g", str(app)], check=True)
        until = time.monotonic() + 20
        while main_pid is None and time.monotonic() < until:
            main_pid = next((p for p, (_, cmd) in ps_table().items() if cmd == exe and p not in before), None)
        if main_pid is None:
            raise SystemExit(f"{app.name}: no main process 20 s after open")
        try:
            got = subprocess.run([str(winwait), str(main_pid)], capture_output=True, text=True, timeout=40).stdout.strip()
            launches.append(round(float(got) - t0) if got else None)
            print(f"launch {i + 1}: {launches[-1]} ms", flush=True)

            def ours():
                table = ps_table()
                procs = {p: cmd for p, (_, cmd) in table.items()}
                resp = {p: ml.responsible_pid(p) for p in procs}
                pids = set(tree(table, main_pid)) | set(ml.attribute(procs, resp, main_pid)[0])
                return sorted(p for p in pids if p not in before)
            if i < a.launches - 1:
                time.sleep(5)
                seen |= set(ours())
            else:
                time.sleep(a.settle)
                pids = ours()
                seen |= set(pids)
                found = rel.footprint(pids)
                rss = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout.split()
                c0, t1 = bl.cputime(pids), time.monotonic()
                time.sleep(a.cpu_secs)
                cpu = round((bl.cputime(pids) - c0) / (time.monotonic() - t1) * 100, 2)
                seen |= set(ours())
                sample = dict(processes=len(pids), footprint_mib=rel.mib(sum(found.values())), rss_mib=round(sum(map(int, rss)) / 1024, 1),
                              idle_cpu_pct=cpu, settle_s=a.settle, cpu_secs=a.cpu_secs, load=rel.load())
        finally:
            left += stop(seen | {main_pid}, main_pid)
            time.sleep(3)
    after = ps_table()
    out = dict(app=app.name, version=info.get("CFBundleShortVersionString"), date=time.strftime("%Y-%m-%d %H:%M"),
               host=rel.versions()["host"], macos=rel.versions()["macos"], launch=summary(launches), idle=sample,
               profile="the owner's own profile as it was; nothing clicked, no agent session started by this run",
               ran_before_and_left_alone=[dict(pid=p, command=before[p][1].rsplit("/", 1)[-1], still_running=p in after) for p in already],
               our_pids_left=left,
               started_during_the_run_and_still_running=sorted(
                   cmd.rsplit("/", 1)[-1] for p, (_, cmd) in after.items() if p not in before and word in cmd.lower()))
    text = json.dumps(out, indent=1) + "\n"
    if a.out:
        Path(a.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()
