"""Q4 speed in the release app's own window (WKWebView) on the release core: the rows of interact.py plus a cold open
of the long chat, the composer while the long chat is open, the B17 slow-list actions and the lead-row press (v9 Home S3-7).
Usage:
  [NUNCHIRO_MEASURE_CORE=<release core>] interact_window.py [--repeats 30] [--max-load 6] [--no-build | --build-only] [--only a,b]
Build (skipped with --no-build): the shipped web bundle (`vite build`, the normal config) into .scratch/q4w/page, plus
interact_window.js (the in-window driver, never in web/dist) loaded by a script tag in that copy's index.html, then a
release app (`tauri build --no-bundle`, release profile) whose frontendDist is that copy, in its own target dir
.scratch/q4w/target (or MEASURE_TARGET). No app source and no normal build output changes. The chat-open-mark row is
p33's long-chat open (scorecard.py chatopen).
Run: interact.py's fixture (20 sessions, a 5,000-event chat, a lead with two tasks) on a scratch core, plus one changed
file in shop's git repo (the Diff row) and one manual card (the card rows); the app started by release.Nunchiro.open()
(its own bundle id, the scratch NUNCHIRO_HOME); the driver takes the job over the WebSocket sink and sends a row at a
time. Every PID started is stopped here. Result: .scratch/perf-baseline/interact-window.json and the printed table
(p50/p95/max as interact.py), with the 1-min load at start and end. Limits: 100 ms p95; 50 ms per frame for the scroll
row; 1 s for the B17 rows and the lead row."""
import argparse, json, os, shutil, signal, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import interact as ia  # noqa: E402
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
import window as win  # noqa: E402

Q4W = ROOT / ".scratch/q4w"
PAGE = Q4W / "page"
TARGET = Path(os.environ.get("MEASURE_TARGET") or Q4W / "target")  # MEASURE_TARGET: a roomier disk, as startup.py
APP = TARGET / "release/nunchiro-app"
OUT = ROOT / ".scratch/perf-baseline"
CARD = "Q4 card"
SLOW = {"diff-open", "decisions-open", "side-chat-open", "card-open", "card-save", "lead-row-team"}


def limit(name):
    return 50 if name == "scroll-long-chat" else 1000 if name in SLOW else ia.BUDGET_MS


def build(port):
    """The shipped bundle plus the driver, and a release app embedding it. The sink port is fixed at build time."""
    web = ROOT / "web"
    subprocess.run(["pnpm", "-C", str(web), "exec", "vite", "build", "--logLevel", "error", "--outDir", str(PAGE), "--emptyOutDir"], check=True)
    (PAGE / "q4w.js").write_text(f"window.__Q4W_SINK__ = {port};\n" + (HERE / "interact_window.js").read_text())
    index = PAGE / "index.html"
    html = index.read_text()
    if "q4w.js" not in html:  # a classic script runs before the bundle's module script: its listeners are first
        html = html.replace("<head>", '<head>\n    <script src="/q4w.js"></script>', 1)
        index.write_text(html)
    (Q4W / "sink.json").write_text(json.dumps(dict(port=port)))
    cfg = json.dumps({"build": {"frontendDist": str(PAGE), "beforeBuildCommand": ""}})
    env = dict(os.environ, CARGO_TARGET_DIR=str(TARGET), CARGO_BUILD_JOBS=os.environ.get("CARGO_BUILD_JOBS", "4"))
    subprocess.run(["pnpm", "--dir", str(ROOT / "app"), "exec", "tauri", "build", "--no-bundle", "--config", cfg], check=True, env=env)
    if not APP.is_file():
        raise SystemExit(f"no release app at {APP} after the build")


def extra_fixture(arm, fx):
    """One changed tracked file in shop (Diff lists it) and one manual card on the Board."""
    shop = fx["projects"]["shop"]
    git = lambda *a: subprocess.run(["git", "-C", shop, "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a], check=True, capture_output=True)  # noqa: E731
    Path(shop, "notes.md").write_text("one\ntwo\nthree\n")
    git("add", "notes.md")
    git("commit", "-q", "-m", "notes")
    Path(shop, "notes.md").write_text("one\ntwo changed\nthree\nfour\n")
    req = {"op": "board_put", "id": None, "title": CARD, "note": "", "column": "review", "session_id": None}
    ask = lambda r: ia.window_request(fx["auth"], r)  # noqa: E731 - board ops as the window sends them
    ask(req)
    cards = ask({"op": "board_snapshot"})
    if CARD not in json.dumps(cards, ensure_ascii=False):
        raise RuntimeError(f"the manual card {CARD!r} is not on the board")


def screenshot(pid, name, out, swift):
    wid = win.window_id(pid, swift)
    shot = out / f"{name}.png"
    if wid:
        subprocess.run(["screencapture", "-x", "-o", "-l", wid, str(shot)], timeout=30, capture_output=True)
    return str(shot.relative_to(ROOT)) if shot.is_file() else None


def collect(sink, job, pid, out, swift, timeout):
    """Accepts the page (again after each reload), sends it the job, gathers rows until {done}."""
    rows, shots, fatal = {}, {}, None
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        sink.accept(max(1, until - time.monotonic()))
        sink.send(json.dumps(job))
        try:
            while True:
                m = sink.recv()
                if "row" in m:
                    name = m.pop("row")
                    rows[name] = m
                    print(f"  {name}: {m.get('error') or str(len(m['ms'])) + ' samples'}", flush=True)
                elif "log" in m:
                    pass
                elif "shot" in m:
                    shots[m["shot"]] = screenshot(pid, m["shot"], out, swift)
                    sink.send("k")
                elif "fatal" in m:
                    shots["fatal"] = screenshot(pid, "fatal", out, swift)
                    fatal = m
                    return rows, shots, fatal
                elif m.get("done"):
                    return rows, shots, fatal
        except (ConnectionError, ValueError, OSError):
            sink.conn.close()  # a reload (settings cold): the page connects again
    return rows, shots, f"no done in {timeout} s"


def summarise(got):
    rows = {}
    for name, r in got.items():
        if r.get("error") or not r.get("ms"):
            rows[name] = dict(error=r.get("error") or "no samples", what=r.get("what", ""))
        elif r.get("frames"):
            rows[name] = dict(ia.summary(r["ms"]), what=r["what"], frames=len(r["ms"]), over50=sum(x > 50 for x in r["ms"]),
                              rows=r.get("rows"), repeats=r.get("repeats"))
        else:
            rows[name] = dict(ia.summary(r["ms"]), what=r["what"], misses=sum(x >= 5000 for x in r["ms"]),
                              **({"firstFrame": r["firstFrame"]} if r.get("firstFrame") else {}),
                              **({"slow": r["slow"]} if r.get("slow") else {}))
    return rows


def table(rows):
    lines = [f"{'row':34} {'engine':9} {'median':>7} {'p95':>7} {'max':>7} {'n':>4}  limit  painted"]
    for name, r in rows.items():
        if "p95" not in r:
            lines.append(f"{name:34} {'app':9} {'-':>7} {'-':>7} {'-':>7} {'-':>4}  {limit(name):5}  {r.get('error', '')}")
            continue
        flag = " * OVER" if r["p95"] > limit(name) else ""
        lines.append(f"{name:34} {'app':9} {r['median']:7} {r['p95']:7} {r['max']:7} {r['n']:4}  {limit(name):5}  {r['what']}{flag}"
                     + (f"; frames > 50 ms: {r['over50']} of {r['frames']}" if "over50" in r else "")
                     + (f"; first frame after the press: {r['firstFrame']}" if "firstFrame" in r else ""))
    return "\n".join(lines)


def measure(sink, repeats, composer_n, max_load, only, tag="q4w"):
    """One window run of the driver's rows (`only`: name prefixes, empty = all) -> (result dict, run folder)."""
    if not rel.CORE.is_file():
        raise SystemExit(f"needs the release core {rel.CORE} (or NUNCHIRO_MEASURE_CORE)")
    load0 = rel.load()
    if load0 >= max_load:
        raise SystemExit(f"1-min load {load0} >= {max_load:g}; not measuring")
    lock = ml.Lock(str(ROOT / ".scratch/measure.lock"))  # noqa: F841
    out = ROOT / ".scratch/measure" / time.strftime(f"%Y%m%d-%H%M%S-{tag}")
    out.mkdir(parents=True)
    swift = out / "window_id.swift"
    swift.write_text(win.WINDOW_ID)
    rel.APP = APP  # release.Nunchiro.open() starts this binary under its own bundle id
    arm = rel.Nunchiro(v1b="plain")
    res = dict(load_start=load0, budget_ms=ia.BUDGET_MS, app=str(APP), core=str(rel.CORE), home=str(arm.home))
    try:
        fx = ia.fixture(arm)
        if not only or any(not p.startswith("chat-open-mark") for p in only):
            extra_fixture(arm, fx)
        job = dict(terms=fx["terms"], chats=fx["chats"], lead=fx["lead"], long_events=fx["long_events"], repeats=repeats,
                   composer_n=composer_n, keys=list(rel.WORK["keys"]), card_title=CARD, only=only)
        arm.open()
        got, shots, fatal = collect(sink, job, arm.app.pid, out, swift, timeout=3600)
        res.update(rows=summarise(got), raw=got, shots=shots, fatal=fatal, sessions=len(fx["terms"]) + len(fx["chats"]) + 1)
    finally:
        arm.stop()
    res["load_end"] = rel.load()
    res["versions"] = rel.versions()
    return res, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=30)
    ap.add_argument("--composer-n", type=int, default=100)
    ap.add_argument("--max-load", type=float, default=6.0, help="refuse to start above this 1-min load")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--build-only", action="store_true")
    a = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    if a.no_build:
        sink = win.Sink(json.loads((Q4W / "sink.json").read_text())["port"])
    else:
        sink = win.Sink()
        build(sink.port)
        if a.build_only:
            return
    res, out = measure(sink, a.repeats, a.composer_n, a.max_load, [x for x in a.only.split(",") if x])
    (OUT / "interact-window.json").parent.mkdir(parents=True, exist_ok=True)
    (OUT / "interact-window.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
    shutil.copy2(OUT / "interact-window.json", out / "result.json")
    print(table(res["rows"]))
    if res.get("fatal"):
        print(f"driver stopped: {res['fatal']}")
    print(f"1-min load: {res['load_start']} at start, {res['load_end']} at end. Result: {(out / 'result.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
