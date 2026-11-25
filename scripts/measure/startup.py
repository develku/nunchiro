"""Ticket 549 (scorecard S9): launch to a usable window, cold and warm, then the core's idle CPU, on a release RC app.
Usage: startup.py [--repeats 5] [--idle-secs 60] [--no-build]

Builds a release bundle with the RC config (identifier dev.nunchiro.app.rc, RC CLI next to the window) into
.scratch/startup, then copies it under its own bundle id (measurelib.OwnApp: never the owner's or the RC's WebKit
store). Each run starts that copy with HOME and NUNCHIRO_HOME under this worktree's .scratch and NUNCHIRO_GATE_RUN=1
(the gate-app-boot mode: the window never takes the front and stays behind, so a run never steals the person's
focus). "Usable" = the page's first core snapshot has drawn: web/src/App.tsx asks the app for `startup_drawn` once,
which prints DRAWN on stderr; launch = just before the exec. Run 1 starts on a fresh HOME and NUNCHIRO_HOME (cold);
later runs keep both (warm). Between runs the window and its core are stopped, so each run starts the core too.
After the last run that window and core are stopped and the app starts once more as the person gets it (no
NUNCHIRO_GATE_RUN: a gate run shoots its own page once a second, which inflated the window to 5.26% in ticket 549; the
normal launch takes the front once, as the app does). Then the core's and the window's CPU are sampled over
--idle-secs. Stops only the PIDs it started. Prints a table; raw JSON in .scratch/measure/<stamp>-startup/."""
import argparse, json, os, shutil, subprocess, sys, threading, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import baseline as bl  # noqa: E402
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
from lib import clean_env  # noqa: E402

BUILD = ROOT / ".scratch/startup"
NAME = "Nunchiro RC.app"
DRAWN = b"nunchiro: startup: first snapshot drawn"
SETTLE_S = 10  # after the last window drew, before the idle sample (the s9-idle-tick method)
WAIT_S = 60  # per launch, to DRAWN


def summarize(seconds):
    """Run 1 is cold, the rest warm. None = the run never drew."""
    warm = [s for s in seconds[1:] if s is not None]
    return dict(cold_s=seconds[0] if seconds else None, warm_median_s=round(ml.median(warm), 3) if warm else None,
                warm_s=seconds[1:], missed=sum(s is None for s in seconds))


def cpu_pct(before, after, secs):
    return round((after - before) / secs * 100, 2)


def normal_env(env):
    """The launch environment of a person's app: the gate switch removed (it changes the window's work and focus)."""
    return {k: v for k, v in env.items() if k != "NUNCHIRO_GATE_RUN"}


def verdict(r):
    """S9: under 2 s to a usable window (cold and warm), idle near zero (read as under 0.5% for the core, the
    s9-idle-tick bar, and under 1% for the window process, ticket 569)."""
    times = [r["cold_s"], r["warm_median_s"]]
    ok = None not in times and max(times) < 2 and r["idle_core_cpu_pct"] < 0.5 and r["idle_window_cpu_pct"] < 1
    return "pass" if ok else "fail"


def build():
    # MEASURE_TARGET: a cargo target on a roomier disk (ticket 1098); the bundle still lands in BUILD.
    target = Path(os.environ.get("MEASURE_TARGET") or BUILD / "target")
    env = dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS=os.environ.get("CARGO_BUILD_JOBS", "2"))
    subprocess.run(["pnpm", "--filter", "nunchiro-web", "build"], cwd=ROOT, env=env, check=True)
    subprocess.run(["pnpm", "exec", "tauri", "build", "--bundles", "app", "--config", "src-tauri/tauri.rc.conf.json"],
                   cwd=ROOT / "app", env=env, check=True)
    # NUNCHIRO_BUILD: an RC CLI, which refuses to start a core on the owner's home (see gate-app-boot.sh build).
    subprocess.run(["cargo", "build", "--release", "--locked", "-p", "nunchiro"], cwd=ROOT, env=dict(env, NUNCHIRO_BUILD="1"), check=True)
    app = BUILD / NAME
    own_dirs(app)  # refuses a linked .scratch/startup, as rmtree follows a linked parent
    shutil.copytree(target / "release/bundle/macos" / NAME, app, symlinks=True, dirs_exist_ok=True)
    shutil.copy2(target / "release/nunchiro", app / "Contents/MacOS/nunchiro")  # the window prefers the CLI next to it
    return app


def own_dirs(*dirs):
    """Fresh scratch folders of this worktree; a link (to the owner's home, say) is refused, never followed."""
    scratch = (ROOT / ".scratch").resolve()
    for d in dirs:
        if d.is_symlink() or not d.resolve().is_relative_to(scratch):
            raise SystemExit(f"refused: {d} is not this worktree's own .scratch folder")
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)


class Run:
    """One launch: the window process, its stderr copied to the log, the time DRAWN arrived."""

    def __init__(self, exe, env, log):
        self.drawn, self.log = threading.Event(), log
        self.t0 = time.monotonic()
        self.proc = subprocess.Popen([str(exe)], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.PIPE)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stderr:
            if DRAWN in line and not self.drawn.is_set():
                self.secs = round(time.monotonic() - self.t0, 3)
                self.drawn.set()
            self.log.write(line)
            self.log.flush()

    def wait(self):
        return self.secs if self.drawn.wait(WAIT_S) else None

    def stop(self, env, cli, nhome):
        try:
            core = core_pid(nhome)
        except RuntimeError:
            core = None
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        # The core the window started under this run's NUNCHIRO_HOME (it outlives the window by design).
        subprocess.run([str(cli), "serve", "stop", "--yes"], env=env, capture_output=True, timeout=60)
        # `serve stop` answers before the core has exited: the next launch must not meet a core that is still ending.
        until = time.monotonic() + 20
        while core and time.monotonic() < until:
            try:
                os.kill(core, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        if core:
            raise RuntimeError(f"core {core} still running 20 s after serve stop")


def core_pid(nhome):
    """The process holding this run's own core socket open (a path only this run's core has)."""
    out = subprocess.run(["lsof", "-t", str(nhome / "core.sock")], capture_output=True, text=True).stdout.split()
    if len(out) != 1:
        raise RuntimeError(f"expected one process on {nhome / 'core.sock'}, found {out}")
    return int(out[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--idle-secs", type=int, default=60)
    ap.add_argument("--no-build", action="store_true", help=f"use the last build in {BUILD.relative_to(ROOT)}")
    a = ap.parse_args()
    app = BUILD / NAME if a.no_build else build()
    if not (app / "Contents/MacOS/nunchiro").is_file():
        raise SystemExit(f"no build at {app}; run without --no-build")
    out = ROOT / ".scratch/measure" / time.strftime("%Y%m%d-%H%M%S-startup")
    out.mkdir(parents=True)
    home, nhome = ROOT / ".scratch/suh", ROOT / ".scratch/sun"  # short: holder sockets must stay < 104 bytes
    own_dirs(home, nhome)
    own = ml.OwnApp(app)
    cli = own.exe.parent / "nunchiro"
    env = {k: v for k, v in clean_env().items() if not k.startswith("NUNCHIRO_")}  # never inherit the owner's home or token
    env.update(HOME=str(home), NUNCHIRO_HOME=str(nhome), NUNCHIRO_BIN=str(cli), NUNCHIRO_GATE_RUN="1", NUNCHIRO_KEYCHAIN="")
    print(f"waiting for 1-min load < {ml.PAINT_LOAD_START:g}", flush=True)
    while rel.load() >= ml.PAINT_LOAD_START:
        time.sleep(60)
    loads, seconds, run, idle = [rel.load()], [], None, {}
    log = open(out / "app.log", "ab")
    try:
        for i in range(a.repeats):
            run = Run(own.exe, env, log)
            seconds.append(run.wait())
            loads.append(rel.load())
            print(f"run {i + 1} ({'cold' if i == 0 else 'warm'}): {seconds[-1]} s", flush=True)
            if i < a.repeats - 1:
                run.stop(env, cli, nhome)
                run = None
        if run and seconds[-1] is not None:
            run.stop(env, cli, nhome)
            run = Run(own.exe, normal_env(env), log)  # ticket 569: the idle sample runs in a normal, non-gate launch
            if run.wait() is None:
                raise SystemExit("the normal launch never drew; no idle figure")
            print("normal launch drawn, settling then sampling idle", flush=True)
            time.sleep(SETTLE_S)
            pids = [core_pid(nhome), run.proc.pid]
            c0, a0, t0 = bl.cputime(pids[:1]), bl.cputime(pids[1:]), time.monotonic()
            time.sleep(a.idle_secs)
            dt = time.monotonic() - t0
            idle = dict(idle_core_cpu_pct=cpu_pct(c0, bl.cputime(pids[:1]), dt), idle_window_cpu_pct=cpu_pct(a0, bl.cputime(pids[1:]), dt),
                        idle_secs=round(dt, 1))
            loads.append(rel.load())
    finally:
        if run:
            run.stop(env, cli, nhome)
        own.remove()
    r = dict(summarize(seconds), **idle, runs_s=seconds, load=ml.load_range(loads), versions=rel.versions())
    if idle:
        r["s9"] = verdict(r)
    (out / "result.json").write_text(json.dumps(r, indent=1))
    print(f"\n| cold s | warm median s | idle core CPU % ({a.idle_secs} s) | idle window CPU % (normal launch) | S9 |\n|---|---|---|---|---|\n"
          f"| {r['cold_s']} | {r['warm_median_s']} | {r.get('idle_core_cpu_pct')} | {r.get('idle_window_cpu_pct')} | {r.get('s9', 'not run')} |")
    print(f"runs {seconds}; load {r['load']}; {r['versions']['host']}, {r['versions']['commit']}; raw {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
