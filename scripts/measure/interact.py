"""Q4 speed: input event to painted result for the window's everyday actions, in the shipped web bundle on a release core.
Usage:
  interact.py [--repeats 30] [--engines webkit,chromium] [--max-load 15] [--no-build] [--hold SECONDS]
Rows (interact.mjs says what "painted" means for each): opening a session from the tree (terminal, chat), switching tabs
(terminal->chat, chat->terminal, chat->long chat), Settings (cold, warm), the Board, the Team view, its Room part, the
composer (composer.mjs, the same report) and wheel-scrolling a long chat (frame times).
Fixture: 20 sessions in 3 projects (shells printing a screen, fixture-Claude chats; one 5,000-event chat), a lead with two
tasks in the git project. One scratch core (system temp home), one `vite preview`, one Playwright browser per engine; every
PID started is stopped here. Result: .scratch/perf-baseline/interact.json and a printed table, with the 1-min load at
start and end. --hold keeps the fixture up (job file printed) to drive it by hand."""
import argparse, json, os, shutil, signal, socket, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
import workload_v1b as w1b  # noqa: E402

OUT = ROOT / ".scratch/perf-baseline"
PROJECTS = {"shop": 7, "docs": 6, "infra": 6}  # sessions per project before the lead (shop's): 19 + the lead = 20
CHATS = {"shop": ["history", "chat-a"], "docs": ["chat-b", "chat-c"], "infra": ["chat-d"]}
LONG_EVENTS = w1b.EVENTS  # the long chat: the 5,000-event v1b transcript
SHORT_EVENTS = 40
BUDGET_MS = 100


def private(path, text):
    """A job file holds the scratch core's owner token: only this user may read it."""
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(text)
    os.chmod(path, 0o600)  # an older run's file keeps its old mode otherwise

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def window_request(auth, request, timeout=30):
    """One window-only request (team ops) over the core's WebSocket, as the window sends it."""
    ws = rel.WS(auth["port"], auth["token"])
    try:
        ws.send({"request": request})
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            got = ws.recv(max(0.1, until - time.monotonic()))
            if got and got[0] == 1:
                msg = json.loads(got[1])
                if msg.get("id") == 1:
                    resp = msg["response"]
                    if "Err" in resp:
                        raise RuntimeError(f"{request['op']}: {resp['Err']}")
                    return resp["Ok"]
        raise RuntimeError(f"{request['op']}: no answer in {timeout} s")
    finally:
        ws.s.close()


def fixture(arm, lead=True):
    """20 sessions in 3 projects, one long chat, a lead with two tasks. Returns the ids the page script needs.
    lead=False: the 19 sessions without the lead, which needs the window's token (the core gives it to its app only)."""
    projects = {}
    for name in PROJECTS:
        p = arm.home / "p" / name
        p.mkdir(parents=True)
        projects[name] = os.path.realpath(p)
    git = lambda *a: subprocess.run(["git", "-C", projects["shop"], "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a],  # noqa: E731
                                    check=True, capture_output=True)
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "init")
    terms, chats = {}, {}
    for name, n in PROJECTS.items():
        for i in range(n - len(CHATS[name])):
            label = f"{name}-t{i}"
            # A terminal screen: 60 numbered lines, then the marker the page waits for.
            script = f'i=0; while [ $i -lt 60 ]; do echo "{label} line $i: the quick brown fox"; i=$((i+1)); done; echo FIXTURE_READY {label}; exec cat'
            sid = arm.cli("session", "start", "--kind", "shell", "--project", projects[name], "--label", label, "--", "/bin/sh", "-c", script)["session"]["id"]
            terms[label] = sid
        for label in CHATS[name]:
            sid = arm.cli("session", "start", "--kind", "claude", "--project", projects[name], "--label", label, "--",
                          "--fixture-silent", "--fixture-transcript")["session"]["id"]
            chats[label] = (sid, projects[name])
    arm.wait_ready(list(terms.values()) + [s for s, _ in chats.values()])
    snap = {s["id"]: s for s in arm.call({"op": "snapshot"})["sessions"]}
    for label, (sid, project) in chats.items():
        slug = "".join(c if c.isascii() and c.isalnum() else "-" for c in project)
        path = Path(arm.v1b["config"]) / "projects" / slug / f"{snap[sid]['agent_session_id']}.jsonl"
        until = time.monotonic() + 15
        while not path.is_file() and time.monotonic() < until:
            time.sleep(0.2)
        events = LONG_EVENTS if label == "history" else SHORT_EVENTS
        data, n = w1b.transcript(Path(project), events)
        tmp = path.with_suffix(".new")  # a new inode: the core re-indexes
        tmp.write_bytes(data)
        os.replace(tmp, path)
        until = time.monotonic() + 30
        while True:
            got = arm.chat_count(sid)[0]
            if got == n or time.monotonic() > until:
                break
            time.sleep(0.5)
        if got != n:
            raise RuntimeError(f"chat {label}: core serves {got} events, expected {n}; refusing to measure a partial chat")
    if not lead:
        return dict(auth=None, terms=terms, chats={k: v[0] for k, v in chats.items()}, lead=None, projects=projects,
                    long_events=LONG_EVENTS)
    # The lead (ticket 990): a teammate that leads shop, its seat opened as Settings > Team > Open does, two tasks.
    (arm.home / "team").mkdir(exist_ok=True)
    (arm.home / "team/team.json").write_text(json.dumps({"version": 1, "teammates": [
        {"id": "lead-main", "name": "Lead", "job": "Runs the shop.", "kind": "claude", "project": projects["shop"], "lead": True}]}))
    auth = arm.call({"op": "window_auth"})
    auth = auth.get("WindowAuth", auth)
    lead = window_request(auth, {"op": "team_open", "id": "lead-main"})["session"]["id"]
    for text in ("Round the tax to 2 decimals", "Speed up the checkout page"):
        arm.call({"op": "task", "operation": "new", "project": projects["shop"], "text": text})
    tasks = arm.call({"op": "task", "operation": "list", "project": projects["shop"]})
    tasks = tasks.get("Tasks", tasks)["tasks"]
    if len(tasks) != 2:
        raise RuntimeError(f"expected 2 tasks in shop, the ledger has {len(tasks)}")
    total = len(terms) + len(chats) + 1
    if total != 20:
        raise RuntimeError(f"fixture has {total} sessions, expected 20")
    return dict(auth=auth, terms=terms, chats={k: v[0] for k, v in chats.items()}, lead=lead, projects=projects,
                long_events=LONG_EVENTS)


def summary(ms):
    return dict(n=len(ms), median=round(ml.median(ms), 1), p95=round(ml.pct(ms, 95), 1), max=round(max(ms), 1))


def table(res):
    lines = [f"{'row':34} {'engine':9} {'median':>7} {'p95':>7} {'max':>7} {'n':>4}  painted"]
    for engine, rows in res["engines"].items():
        for name, r in rows.items():
            if "p95" not in r:
                lines.append(f"{name:34} {engine:9} {'-':>7} {'-':>7} {'-':>7} {'-':>4}  {r.get('error', '')}")
                continue
            flag = " *" if r["p95"] > (50 if name == "scroll-long-chat" else BUDGET_MS) else ""
            lines.append(f"{name:34} {engine:9} {r['median']:7} {r['p95']:7} {r['max']:7} {r['n']:4}  {r['what']}{flag}"
                         + (f"; frames > 50 ms: {r['over50']} of {r['frames']}" if "over50" in r else ""))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=30)
    ap.add_argument("--engines", default="webkit,chromium")
    ap.add_argument("--max-load", type=float, default=ml.PAINT_LOAD_START, help="refuse to start above this 1-min load")
    ap.add_argument("--composer-n", type=int, default=100)
    ap.add_argument("--only", default="", help="comma-separated row prefixes (default: all)")
    ap.add_argument("--profile", default="", help="Chromium: CPU profile of the named row (top self-time functions)")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--hold", type=int, default=0)
    a = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # a stopped run still stops its core and preview (finally)
    OUT.mkdir(parents=True, exist_ok=True)
    pnpm = shutil.which("pnpm")
    if not rel.CORE.is_file() or not pnpm:
        raise SystemExit(f"needs the release core {rel.CORE} (cargo build --release -p nunchiro) and pnpm on PATH")
    load0 = rel.load()
    if load0 >= a.max_load:
        raise SystemExit(f"1-min load {load0} >= {a.max_load:g}; not measuring (--max-load to override)")
    lock = ml.Lock(str(ROOT / ".scratch/measure.lock"))  # noqa: F841 - one measure run at a time
    web, port = ROOT / "web", free_port()
    os.environ["NUNCHIRO_WINDOW_ORIGINS"] = f"http://127.0.0.1:{port}"  # the scratch core accepts the preview's origin
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.expanduser("~/Library/Caches/ms-playwright"))
    if not a.no_build:
        subprocess.run([pnpm, "-C", str(web), "exec", "vite", "build", "--logLevel", "error"], check=True)
    arm, preview = rel.Nunchiro(v1b="plain"), None
    res = dict(load_start=load0, engines={}, budget_ms=BUDGET_MS)
    try:
        fx = fixture(arm)
        # The vite shim execs node, so the PID started here is the server itself (pnpm exec would leave a child behind).
        preview = subprocess.Popen([str(web / "node_modules/.bin/vite"), "preview", "--port", str(port), "--strictPort"], cwd=web,
                                   stdout=open(OUT / "preview.log", "ab"), stderr=subprocess.STDOUT)
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.2)
        base = dict(url=f"http://127.0.0.1:{port}/", port=fx["auth"]["port"], token=fx["auth"]["token"])
        if a.hold:
            job = OUT / "interact-hold.job.json"
            private(job, json.dumps(dict(base, **fx, engine="webkit", repeats=a.repeats, out=str(OUT / "interact-hold.json"))))
            print(f"holding {a.hold} s; job {job}", flush=True)
            time.sleep(a.hold)
            return
        for engine in a.engines.split(","):
            job = OUT / f"interact-{engine}.job.json"
            out = OUT / f"interact-{engine}.out.json"
            private(job, json.dumps(dict(base, **fx, engine=engine, repeats=a.repeats, out=str(out),
                                           only=[x for x in a.only.split(",") if x], profile=a.profile)))
            subprocess.run(["node", str(HERE / "interact.mjs"), str(job)], check=True, timeout=1800)
            got = json.loads(out.read_text())
            rows = {}
            for name, r in got["rows"].items():
                if r.get("error"):
                    rows[name] = r
                elif "frames" in r:  # the scroll row: frame intervals, not one latency per repeat
                    rows[name] = dict(summary(r["ms"]), what=r["what"], frames=len(r["ms"]), over50=sum(x > 50 for x in r["ms"]),
                                      rows=r.get("rows"), repeats=r["repeats"])
                else:
                    rows[name] = dict(summary(r["ms"]), what=r["what"], **({"top": r["top"]} if r.get("top") else {}),
                                      **({"renders": r["renders"]} if r.get("renders") else {}))
            if not a.only or any("composer".startswith(x) for x in a.only.split(",")):
                cjob = OUT / f"interact-composer-{engine}.job.json"
                cout = OUT / f"interact-composer-{engine}.json"
                private(cjob, json.dumps(dict(base, engine=engine, open=f'.tree .row.wt2[data-menu-session="{fx["chats"]["chat-a"]}"]', n=a.composer_n, keys=list(rel.WORK["keys"]), out=str(cout), profile=False)))
                subprocess.run(["node", str(HERE / "composer.mjs"), str(cjob)], check=True, timeout=600)
                ms = [x for x in json.loads(cout.read_text())["ms"]]
                rows["composer-keystroke"] = dict(summary(ms), misses=sum(x == 2000 for x in ms),
                                                  what="composer.mjs: keydown to the animation frame after the input event")
            res["engines"][engine] = rows
            print(table(dict(engines={engine: rows})), flush=True)
    finally:
        if preview is not None:
            preview.terminate()
            try:
                preview.wait(timeout=10)
            except subprocess.TimeoutExpired:
                preview.kill()
        arm.stop()
    res["load_end"] = rel.load()
    res["versions"] = rel.versions()
    (OUT / "interact.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
    print(table(res))
    print(f"1-min load: {res['load_start']} at start, {res['load_end']} at end. Result: {(OUT / 'interact.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
