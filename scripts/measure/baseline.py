"""perf-baseline: the goal prompt's speed numbers, Nunchiro paired with herdr, five runs each. Usage:
  baseline.py cold   [--repeats 5]                 spawn to first window (Nunchiro) / first drawn screen (herdr)
  baseline.py steady [--repeats 5] [--sessions 5] [--cpu-secs 60] [--keys 100]
                                                   idle CPU, memory and terminal key-to-echo with N fixture sessions
Composer keystroke-to-paint is scripts/measure/composer.py; the terminal-tab paint is `paint.sh --only echo`.
Reuses release.py's arms (scratch homes, PIDs tracked, herdr's own server) and the fixture agent (no model, no
tokens), so the host takes no artificial load. Results print as JSON and land in .scratch/perf-baseline/<cmd>.json."""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
from lib import Session, clean_env  # noqa: E402

OUT = ROOT / ".scratch/perf-baseline"
WINWAIT_SRC = """import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let end = Date().timeIntervalSince1970 + 30
while Date().timeIntervalSince1970 < end {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: Any]
    if ((b["Width"] as? NSNumber)?.doubleValue ?? 0) > 200 { print(Date().timeIntervalSince1970 * 1000); exit(0) }
  }
  usleep(2000)
}
exit(1)
"""


def winwait():
    """Compiled once: prints the epoch ms at which `pid` first has an on-screen window wider than 200 px."""
    exe = OUT / "winwait"
    if not exe.is_file():
        src = OUT / "winwait.swift"
        src.write_text(WINWAIT_SRC)
        subprocess.run(["swiftc", "-O", str(src), "-o", str(exe)], check=True)
    return exe


def cputime(pids):
    """Summed CPU seconds of the pids (ps TIME is mm:ss.hh); a vanished pid counts 0."""
    out = subprocess.run(["ps", "-o", "time=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    total = 0.0
    for line in out.split():
        parts = [float(x) for x in line.replace("-", ":").split(":")]
        total += sum(v * m for v, m in zip(reversed(parts), (1, 60, 3600, 86400)))
    return total


def cold_nunchiro():
    """App spawned with no core running: the app starts the core (app/src-tauri ensure_core), the window appears."""
    home = Path(tempfile.mkdtemp(prefix="ns-mr-"))  # off the external SSD: see release.Nunchiro
    env = clean_env({"NUNCHIRO_HOME": str(home), "NUNCHIRO_BIN": str(rel.CORE)})
    log = open(home / "app.log", "ab")
    t0 = time.time() * 1000
    own = ml.OwnApp(rel.APP)  # own bundle id: never the owner's WebKit store
    app = ml.Spawned([str(own.exe)], env, log)
    try:
        got = subprocess.run([str(winwait()), str(app.pid)], capture_output=True, text=True, timeout=40).stdout.strip()
        return round(float(got) - t0) if got else None
    finally:
        app.kill()
        subprocess.run([str(rel.CORE), "serve", "stop", "--yes"], env=env, capture_output=True, timeout=60)
        shutil.rmtree(home, ignore_errors=True)
        own.remove()


def cold_herdr():
    """Nothing running: spawn the server, attach the client as it answers; spawn to the first frame that shows the UI."""
    real = ROOT / ".scratch" / f"h{int(time.time()) % 10000}"
    (real / ".config/herdr").mkdir(parents=True)
    home = rel.short_home(real)
    cfg = home / ".config/herdr/config.toml"
    cfg.write_text("onboarding = false\n")
    env = clean_env({"HOME": str(home), "HERDR_CONFIG_PATH": str(cfg)})
    for k in ("SSH_AUTH_SOCK", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"):
        env.pop(k, None)
    sock = home / ".config/herdr/herdr.sock"
    t0 = time.time()
    server = subprocess.Popen(["herdr", "server"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    c = None
    try:
        while not sock.exists() and time.time() < t0 + 15:
            time.sleep(0.002)
        c = Session(["herdr"], str(home), env)
        until = time.time() + 20
        while time.time() < until:
            with c.lock:
                seen = list(c.chunks)
            if sum(len(b) for _, b in seen) > 400:  # a drawn screen, not the alternate-screen switch alone
                return round((seen[-1][0] - t0) * 1000)
            time.sleep(0.002)
        return None
    finally:
        if c is not None:
            c.kill()
        subprocess.run(["herdr", "server", "stop"], env=env, capture_output=True, timeout=30)
        server.terminate()
        if home != real:
            home.unlink()


def cold(a):
    res = {"nunchiro": [], "herdr": []}
    for _, r, app in ml.order([0], a.repeats):
        ms = cold_nunchiro() if app == "nunchiro" else cold_herdr()
        res[app].append(ms)
        print(f"cold {app} repeat {r + 1}: {ms} ms", flush=True)
    return {k: dict(runs=v, **summary(v)) for k, v in res.items()}


def summary(v):
    ok = [x for x in v if x is not None]
    return dict(median=ml.median(ok), min=min(ok), max=max(ok), spread=round(ml.spread(ok), 3)) if ok else {}


def steady_one(app, a):
    arm = rel.Nunchiro(v1b="plain") if app == "nunchiro" else rel.Herdr(v1b=True)
    rec = []
    try:
        sids = [arm.start(i) for i in range(a.sessions)]
        arm.wait_ready(sids)
        arm.after_ready(sids)
        log = arm.home / "echo.log"
        target = arm.start_echo(log)
        time.sleep(10)
        arm.open()
        time.sleep(12)
        time.sleep(3)  # no arm.after_open(): `layout add board` gets no answer from the window (see report)
        mem = [rel.sample(arm, "idle", True, rec)["app_mib"] for _ in range(3)]
        required, hp, _, agents = arm.parts(True)
        ours = required + hp
        c0, t0 = cputime(ours), time.monotonic()
        a0 = cputime(agents)
        k0 = cputime(required[:1])  # the core (nunchiro) or server (herdr): the split the window's cost shows in
        time.sleep(a.cpu_secs)
        dt = time.monotonic() - t0
        cpu = (cputime(ours) - c0) / dt * 100
        cpu_agents = (cputime(agents) - a0) / dt * 100
        cpu_core = (cputime(required[:1]) - k0) / dt * 100
        if app == "herdr":  # PtyKeys waits for the literal ECHO_READY, which herdr's diff redraw splits; the log proves each read
            arm.h("workspace", "focus", arm.echo_ws)
            time.sleep(2)
            chan = rel.PtyKeys.__new__(rel.PtyKeys)
            chan.c, chan.log = arm.client, ml.EchoLog(log)
        else:
            chan = arm.keys(target, ml.EchoLog(log))
        lat = []
        for i in range(a.keys):
            ms, _ = chan.key(rel.WORK["keys"][i % len(rel.WORK["keys"])].encode())
            lat.append(2000.0 if ms is None else ms)
            time.sleep(0.05)
        return dict(mem_mib=max(mem), cpu_pct=round(cpu, 2), core_cpu_pct=round(cpu_core, 2), agents_cpu_pct=round(cpu_agents, 2),
                    p50_ms=round(ml.pct(lat, 50), 2), p95_ms=round(ml.pct(lat, 95), 2),
                    misses=sum(x == 2000.0 for x in lat), load=rel.load())
    finally:
        arm.stop()


def steady(a):
    res = {"nunchiro": [], "herdr": []}
    for _, r, app in ml.order([a.sessions], a.repeats):
        free = rel.memory_free_pct()
        if free is not None and free < 20:
            raise RuntimeError(f"memory free {free}% below 20%; refusing to load the host further")
        x = steady_one(app, a)
        res[app].append(x)
        print(f"steady {app} repeat {r + 1}: {x}", flush=True)
    out = {}
    for app, xs in res.items():
        out[app] = dict(runs=xs, **{k: summary([x[k] for x in xs]) for k in ("mem_mib", "cpu_pct", "agents_cpu_pct", "p50_ms", "p95_ms")})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("cold", "steady"))
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--sessions", type=int, default=5)
    ap.add_argument("--cpu-secs", type=int, default=60)
    ap.add_argument("--keys", type=int, default=100)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rel.preflight()
    if rel.load() >= ml.PAINT_LOAD_START:
        raise SystemExit(f"1-min load {rel.load()} >= {ml.PAINT_LOAD_START:g}; not measuring")
    res = dict(cold=cold, steady=steady)[a.cmd](a)
    res["versions"] = rel.versions()
    (OUT / f"{a.cmd}.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "versions"}, indent=1))


if __name__ == "__main__":
    main()
