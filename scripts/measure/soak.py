"""The 24 h soak of docs/measure/rubric.md ("Owner-run steps", 24 h soak; anchors soak_clean_hours of p08 and
mem_growth_24h_ratio of p33). An RC core on its own NUNCHIRO_HOME (a fresh folder under lib.SCENARIO_HOMES, the core
binary copied into it so a day-long run reads nothing off an external disk) holds --sessions real Claude seats on the
owner's sign-ins (haiku, the cheapest model, no MCP server) in a folder Claude already trusts, inside the config guard of
scripts/scenario/v1b-full.sh. Every --every seconds (10 min) each seat gets a heartbeat prompt (`agent prompt`,
`reply ok #<n>`); then the core is checked alive, every seat still listed and running, and the footprint of the core
and its holders (the app; the agents' own footprint beside it) is sampled. Minute 2 is the base sample.

The run ends at --hours or at the first failure: the core gone (crash), a heartbeat whose exact text is not above the
agent's input box within 30 s (stuck terminal), or a seat no longer running (lost session). Each sample is appended to
the raw file at once, so `--report FILE` gives the figures of a stopped run too. Figures (`figures`, pure, tested by
tests/scenario/test_measure_soak.py): soak_clean_hours (hours to the first failure, 24 for a clean day; needs 20
sessions, the step's size) and mem_growth_24h_ratio (the app's footprint at the end over minute 2; needs a clean day of
at least 5 sessions, the anchor's size). Only those reached are written into docs/measure/manual-<date>.json.

Usage: soak.py --nunchiro BIN [--sessions 5] [--hours 24] [--every 600] [--project-root DIR] [--out FILE]
       soak.py --self-test --nunchiro BIN   (the fixture agent of accuracy.py on a throwaway HOME, 2 seats, 4 min,
                                             a heartbeat every 30 s; never written)
       soak.py --report FILE
A seat the core holds for memory pressure is never started with --anyway: the start is retried every 10 min for
--start-within hours, with nothing kept from the held try. Stops only the PIDs it started (the core, and the holders and agents of its own sessions). Stdlib only."""
import argparse, json, os, re, shutil, signal, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import accuracy as acc  # noqa: E402
import lib  # noqa: E402

BASE_S = 120  # minute 2, the soak bar's base (measurelib.GROWTH_AT)
STEP_SESSIONS, ANCHOR_SESSIONS, DAY_H = 20, 5, 24  # rubric: the step's 20 sessions; the memory anchor's 5; a day


def figures(lines):
    """Figures of a run's raw lines (pure): the head, then one line per sample, then an end line when it ended."""
    head, ticks = lines[0], [l for l in lines[1:] if "app" in l]
    fail = next((l for l in ticks if not l["core"] or l["lost"] or l["stuck"]), None)
    at = lambda l: round(l["t"] / 3600, 1)  # noqa: E731
    failure = fail and ("core gone (crash)" if not fail["core"] else
                        f"lost session {', '.join(fail['lost'])}" if fail["lost"] else
                        f"stuck terminal {', '.join(fail['stuck'])}") + f" at {at(fail)} h"
    last = ticks[-1] if ticks else None
    base = next((l for l in ticks if l["t"] >= BASE_S), None)
    growth = round(last["app"] / base["app"], 3) if base and last is not base else None
    day = bool(last) and last["t"] >= DAY_H * 3600
    clean = at(fail) if fail else (min(DAY_H, at(last)) if last else 0)
    written, why = {}, []
    if head["self_test"]:
        why.append("self-test on the fixture agent")
    else:
        if head["sessions"] < ANCHOR_SESSIONS:
            why.append(f"mem_growth_24h_ratio needs {ANCHOR_SESSIONS} sessions, ran {head['sessions']}")
        elif fail:
            why.append(f"mem_growth_24h_ratio: the run failed at {at(fail)} h")
        elif not day or growth is None:
            why.append(f"mem_growth_24h_ratio: stopped at {at(last) if last else 0} h of {DAY_H}")
        else:
            written["mem_growth_24h_ratio"] = growth
        if head["sessions"] < STEP_SESSIONS:
            why.append(f"soak_clean_hours needs {STEP_SESSIONS} sessions, ran {head['sessions']}")
        elif not fail and not day:
            why.append(f"soak_clean_hours: stopped at {at(last) if last else 0} h with no failure")
        else:
            written["soak_clean_hours"] = DAY_H if not fail else clean
    return dict(clean_hours=clean, failure=failure, growth=growth, samples=len(ticks), written=written, not_written=why,
                app_mib=[(round(l["t"] / 60), round(l["app"] / 2**20, 1)) for l in ticks])


class Held(Exception):
    """The core held a seat for memory pressure (crates/nunchiro-core/src/pressure.rs): nothing measured, try later."""


class Soak:
    def __init__(self, nunchiro, sessions, project_root, self_test):
        self.self_test, self.work = self_test, lib.scenario_home("soak-")
        self.n = str(shutil.copy2(nunchiro, self.work / "nunchiro"))
        self.home = self.work / "h"
        self.home.mkdir(mode=0o700)
        if self_test:
            bin_ = self.work / "bin"
            bin_.mkdir()
            shutil.copy(acc.FAKE, bin_ / "claude")
            os.chmod(bin_ / "claude", 0o700)
            self.env = {"PATH": f"{bin_}:/usr/bin:/bin", "TERM": "xterm-256color", "NUNCHIRO_LOGIN_PATH": "off",
                        "NUNCHIRO_KEYCHAIN": "", "HOME": str(self.home), "NUNCHIRO_HOME": str(self.home),
                        "CLAUDE_CONFIG_DIR": str(self.home / "claude-data")}
            self.project = self.work / "proj"
        else:
            self.env = lib.clean_env({"NUNCHIRO_HOME": str(self.home)})  # the real HOME: the owner's sign-ins
            for key in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION", "NUNCHIRO_MACHINE"):
                self.env.pop(key, None)
            self.project = Path(project_root) / ("soak-" + self.work.name[-6:])
        self.project.mkdir(parents=True)
        self.core = subprocess.Popen([self.n, "serve"], env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=open(self.home / "serve.log", "w"), stderr=subprocess.STDOUT)
        acc.until(lambda: (self.home / "core.sock").exists(), 20, "core start")
        self.seats, self.sessions = {}, sessions
        # None of the owner's own MCP servers, once per seat for a day; the fixture reads no MCP config
        self.no_mcp = [] if self_test else ["--", "--strict-mcp-config", "--mcp-config", '{"mcpServers": {}}']

    def cli(self, *args, timeout=60):
        try:
            r = subprocess.run([self.n, *args], env=self.env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return -1, "", f"no answer in {timeout} s"
        return r.returncode, r.stdout, r.stderr

    def start(self):
        for i in range(self.sessions):
            label = f"soak-c{i}"
            rc, out, err = self.cli("agent", "start", label, "--kind", "claude", "--project", str(self.project),
                                    "--model", acc.CLAUDE_MODEL, *self.no_mcp, timeout=90)
            if rc and "low on memory" in (err or out):
                raise Held(f"agent start {label}: {(err or out).strip()}")  # the core's memory hold; never --anyway
            if rc:
                raise SystemExit(f"agent start {label}: {err or out}")
            self.seats[label] = json.loads(out.splitlines()[-1])["session"]["id"]
        for label in self.seats:
            def ready(label=label):
                text = self.screen(label)
                if acc.TRUST.search(text):
                    raise SystemExit(f"{label}: a trust dialog shows (never answered here); give a folder Claude trusts")
                return re.search(r"for shortcuts|mode on|context left|^❯ ", text, re.M | re.I)
            acc.until(ready, 120, f"seat {label} ready")

    def screen(self, label):
        rc, out, _ = self.cli("agent", "read", self.seats[label], "--lines", "60", timeout=20)
        return out if rc == 0 else ""

    def heartbeat(self, label, k):
        """True when `reply ok #k` shows above the input box within 30 s; then the turn is waited for."""
        text = f"reply ok #{k}"
        self.cli("agent", "prompt", self.seats[label], text, timeout=30)
        ok = acc.until(lambda: acc.submitted(self.screen(label), text)[0], 30)
        if ok:
            self.cli("agent", "wait", self.seats[label], "--until", "done", "--until", "idle", "--timeout", "120000",
                     timeout=130)
        return ok

    def lost(self):
        rc, out, _ = self.cli("agent", "list", "--json", timeout=20)
        if rc:
            return list(self.seats)
        running = {x["id"] for x in json.loads(out) if x.get("state") == "running"}
        return [label for label, sid in self.seats.items() if sid not in running]

    def parts(self):
        import scorecard
        holders = scorecard.holder_pids(scorecard.ps_args(), ids=set(self.seats.values()))
        return holders, [p for h in holders for p in lib.descendants(h)]

    def sample(self, t, stuck):
        import release as rel
        alive = self.core.poll() is None
        lost = self.lost() if alive else list(self.seats)
        holders, agents = self.parts()
        found = rel.footprint(([self.core.pid] if alive else []) + holders + agents)
        app = sum(found.get(p, 0) for p in [self.core.pid, *holders])
        return dict(t=round(t), app=app, agents=sum(found.get(p, 0) for p in agents), holders=len(holders),
                    core=alive, lost=lost, stuck=stuck, load=rel.load())

    def stop(self):
        holders, agents = self.parts()
        for sid in self.seats.values():
            self.cli("session", "close", sid, timeout=30)
        try:
            subprocess.run([self.n, "serve", "stop", "--yes"], env=self.env, capture_output=True, timeout=30)
            self.core.wait(10)
        except subprocess.TimeoutExpired:
            pass
        import release as rel
        rel.kill_pids([self.core.pid, *holders, *agents])  # only this soak's own core, holders and agents
        self.core.wait()


def run(a, raw):
    s = Soak(a.nunchiro, a.sessions, a.project_root, a.self_test)
    def write(line):
        with raw.open("a") as f:
            f.write(json.dumps(line) + "\n")
    began, beats = False, 0
    try:
        s.start()
        version = subprocess.run(["claude", "--version"], env=s.env, capture_output=True, text=True).stdout.strip()
        write(dict(start=time.strftime("%Y-%m-%d %H:%M"), sessions=a.sessions, hours=a.hours, every=a.every,
                   self_test=a.self_test, agent=f"claude {version} --model {acc.CLAUDE_MODEL}", core_pid=s.core.pid,
                   home=str(s.home), project=str(s.project)))
        began = True
        t0, k = time.monotonic(), 0
        due = BASE_S
        while True:
            time.sleep(max(0, due - (time.monotonic() - t0)))
            stuck = []
            if due > BASE_S:
                for label in s.seats:
                    beats += 1
                    if not s.heartbeat(label, k):
                        stuck.append(label)
                    k += 1
            line = s.sample(time.monotonic() - t0, stuck)
            write(line)
            if not line["core"] or line["lost"] or stuck or line["t"] >= a.hours * 3600:
                break
            due += a.every
    finally:
        try:
            s.stop()
        finally:
            if began:
                write(dict(end=time.strftime("%Y-%m-%d %H:%M"), heartbeats=beats))
            shutil.rmtree(s.work, ignore_errors=True)


def report(raw, out=None):
    lines = [json.loads(l) for l in raw.read_text().splitlines() if l.strip()]
    f = figures(lines)
    print(json.dumps(f, indent=1))
    head, ticks = lines[0], [l for l in lines[1:] if "app" in l]
    end = {}
    for l in lines:
        if "end" in l:
            end.update(l)  # the run's own end line, then the guard's
    if f["written"]:
        import scorecard
        base = next(l for l in ticks if l["t"] >= BASE_S)
        scorecard.write_manual(out, f["written"], (
            f"soak.py {head['start']} to {end.get('end', 'not ended')}: {head['sessions']} real seats ({head['agent']}) on an "
            f"RC core with its own NUNCHIRO_HOME, a heartbeat every {head['every'] // 60} min ({end.get('heartbeats')} sent); "
            f"failure: {f['failure'] or 'none'}; clean hours {f['clean_hours']}; footprint of core + holders minute 2 "
            f"{round(base['app'] / 2**20, 1)} MiB, end {round(ticks[-1]['app'] / 2**20, 1)} MiB (ratio {f['growth']}); the agents' "
            f"own {round(base['agents'] / 2**20, 1)} to {round(ticks[-1]['agents'] / 2**20, 1)} MiB; config guard: "
            f"{end.get('guard_problems') or 'clean'}; raw {raw.name}"))
    else:
        print("not written: " + "; ".join(f["not_written"]))
    return f


def main(argv=None):
    ap = argparse.ArgumentParser(prog="soak", description="the 24 h soak; see docs/measure/rubric.md")
    ap.add_argument("--nunchiro", help="an RC nunchiro (NUNCHIRO_BUILD=1 cargo build --release -p nunchiro)")
    ap.add_argument("--sessions", type=int, default=ANCHOR_SESSIONS)
    ap.add_argument("--hours", type=float, default=DAY_H)
    ap.add_argument("--every", type=int, default=600)
    ap.add_argument("--project-root", help="a folder here that Claude already trusts (default: lib.TRUSTED_CWD)")
    ap.add_argument("--start-within", type=float, default=8, help="hours to keep retrying a start the core holds "
                    "for memory pressure, every 10 min (default 8)")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--report", help="the figures of a raw file")
    ap.add_argument("--raw", help="the raw file (default docs/measure/soak-<date>.jsonl, a self-test's in .scratch)")
    ap.add_argument("--out", help="the manual file (default docs/measure/manual-<date>.json)")
    a = ap.parse_args(argv)
    if a.report:
        return report(Path(a.report), a.out)
    if not a.nunchiro:
        ap.error("--nunchiro is required")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # a stop still closes the seats and the core
    if a.self_test:
        a.sessions, a.hours, a.every = 2, 4 / 60, 30
    else:
        import release as rel
        free = rel.memory_free_pct()
        if free is not None and free < 25:
            raise SystemExit(f"memory free {free} % (< 25 %): not starting {a.sessions} real seats")
        a.project_root = a.project_root or lib.TRUSTED_CWD
        Path(a.project_root).mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d")
    raw = Path(a.raw) if a.raw else (ROOT / ".scratch" / f"soak-selftest-{time.strftime('%H%M%S')}.jsonl" if a.self_test
                                     else ROOT / "docs/measure" / f"soak-{stamp}.jsonl")
    raw.parent.mkdir(parents=True, exist_ok=True)
    def attempts():
        until = time.monotonic() + a.start_within * 3600
        while True:
            try:
                return run(a, raw)
            except Held as e:
                if time.monotonic() > until:
                    raise SystemExit(f"{e}; still held after {a.start_within} h, nothing measured")
                print(f"{time.strftime('%H:%M')} {e}; retrying in 10 min", flush=True)
                time.sleep(600)
    if a.self_test:
        attempts()
    else:
        problems = acc.guarded(attempts)[1]
        with raw.open("a") as f:
            f.write(json.dumps(dict(end=time.strftime("%Y-%m-%d %H:%M"), guard_problems=problems)) + "\n")
    print(f"raw samples: {raw}")
    return report(raw, a.out if not a.self_test else os.devnull)


if __name__ == "__main__":
    main()
