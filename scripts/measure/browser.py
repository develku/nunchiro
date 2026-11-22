#!/usr/bin/env python3
"""V2.5-20 / WP5: reruns the browser findings table (memory per tab, snapshot size and time, verb latency) for
Nunchiro's browser (`nunchiro browser`, WKWebView in the app) against ego lite, on the same public pages.

Usage: browser.py --app <Nunchiro app binary> --cli <nunchiro cli> [--runs 5] [--out DIR] [--only nunchiro|ego]
       [--page NAME=URL ...] [--idle-after SECONDS]
Nunchiro also gets fill (first text field of the full snapshot), press Tab, 10 s idle CPU (app + WebKit helpers, before
the page and after the actions; --idle-after waits that long first, ticket 998 L9: a parked page is throttled once
unused for 5 s) and a click (first link, last since it may leave the page; its done line is kept as click_line), then a
warm goto (ticket 998 w34: the same page again in the same app and agent store, so its HTTP cache and connections are warm
as ego's always are; the cold goto stays the first verb), then a restart goto (w35: the app relaunched on the same store
after the same quiet wait, so a new process and new connections but the cache the first app left), and per verb the hop split the CLI prints with
NUNCHIRO_BROWSER_HOPS=1 (ticket 998 L3): to_core (CLI start -> core queue), queue (-> app pickup), app (pickup ->
answer; of it main = main-thread wait, calls = page/native calls, settle = settle waits), back (answer -> CLI end).
Inputs: PAGES below (public, no login). Every run is one fresh arm: a new isolated NUNCHIRO_HOME with its own app and one
agent session (Nunchiro), or a new ego task space that is finished afterwards (ego). One load, one snapshot, one scroll per
run; nothing loops, so the host (live trading) sees no artificial load.
Memory = macOS `footprint` (phys_footprint) of everything the browser owns after the page loaded minus the same sum before
the tab existed: Nunchiro = app + WebKit helpers (responsible-pid attribution, core excluded); ego = every process under
/ego lite.app/. Both are the cost of one tab, not of the whole browser.
Proves: the table below on this host, this day, these pages. Does not prove: logged-in sites, pages with heavy script,
steady-state CPU, or the cost of an agent turn (see docs/research/browser/measure-2026-10-31.md)."""
import argparse, json, os, re, shlex, shutil, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scenario"))
import baseline as bl  # noqa: E402
import measurelib as ml  # noqa: E402

PAGES = {
    "example": "https://example.com/",
    "hackernews": "https://news.ycombinator.com/",
    "wikipedia": "https://en.wikipedia.org/wiki/Web_browser",
}
SETTLE = 2.0  # seconds between "page loaded" and the footprint sample
IDLE = 10.0  # seconds of idle CPU sampled after the actions
RUNNER = """H="$1"; Q="$H/q/$2"; mkdir -p "$Q"; touch "$Q/ready"
while :; do
  for f in "$Q"/*.cmd; do
    [ -e "$f" ] || continue
    sh "$f" > "${f%.cmd}.tmp" 2>&1 < /dev/null; echo "exit=$?" >> "${f%.cmd}.tmp"
    mv "${f%.cmd}.tmp" "${f%.cmd}.out"; rm -f "$f"
  done
  sleep 0.05
done
"""
EGO_SCRIPT = """
const t0 = Date.now();
const task = await taskSpace(%(space)s);
const page = task.page("p1");
const step = async (name, fn) => { const s = Date.now(); const r = await fn(); return [name, Date.now() - s, r]; };
const out = {};
if (%(phase)s === "load") {
  const [, ms] = await step("goto", () => page.goto(%(url)s));
  out.goto_ms = ms; out.space = task.spaceId;
} else {
  const [, sms, snap] = await step("snapshot", () => page.snapshot());
  const [, fms, full] = await step("full", () => page.snapshot({ scope: "full_page" }));
  await page.mouse.move(400, 400);
  const [, cms] = await step("scroll", () => page.mouse.wheel(0, 600));
  out.snapshot_ms = sms; out.snapshot_chars = snap.length; out.full_ms = fms; out.full_chars = full.length; out.scroll_ms = cms;
  await task.finish({ keep: [] });
}
out.total_ms = Date.now() - t0;
console.log("RESULT " + JSON.stringify(out));
"""


def footprint_sum(pids):
    p = subprocess.run(["footprint", "-f", "bytes", "--noCategories", *map(str, pids)], capture_output=True, text=True)
    found = ml.parse_footprint(p.stdout + "\n" + p.stderr)
    return ml.sum_footprint(found, pids, required=pids[:1])[0]  # pids[0] is the app/browser root: its loss is an error


def procs():
    out = subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout
    return ml.parse_ps(out)


def load_avg():
    return os.getloadavg()[0]


class NunchiroArm:
    """One isolated core + release app + a shell session whose commands are real `nunchiro browser` calls."""

    def __init__(self, app, cli):
        # Short system-temp home (core.sock path < 104 bytes) and a binary copy off the SSD (removable-volume prompt).
        self.home = tempfile.mkdtemp(prefix="ns-bm-")
        self.cli = shutil.copy2(cli, os.path.join(self.home, "nunchiro"))
        self.env = {k: v for k, v in os.environ.items() if k not in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION", "CARGO_TARGET_DIR")}
        self.env.update({"NUNCHIRO_HOME": self.home, "NUNCHIRO_LOGIN_PATH": "off", "NUNCHIRO_BIN": self.cli,
                         "NUNCHIRO_BROWSER_HOPS": "1"})
        self.log = open(os.path.join(self.home, "app.log"), "ab")
        self.own = ml.OwnApp(app)  # own bundle id: never the owner's WebKit store
        self.app = ml.Spawned([str(self.own.exe)], self.env, self.log)
        self.n = 0
        runner = os.path.join(self.home, "runner.sh")
        open(runner, "w").write(RUNNER)
        self.q = os.path.join(self.home, "q", "s")
        self.wait(lambda: os.path.exists(os.path.join(self.home, "core.sock")), 30, "core socket")
        r = self.run_cli("session", "open", "--project", self.home, "--", "/bin/sh", runner, self.home, "s")
        self.wait(lambda: os.path.exists(os.path.join(self.q, "ready")), 30, "session runner")
        json.loads(r.stdout)

    @staticmethod
    def wait(cond, secs, what):
        until = time.time() + secs
        while not cond():
            if time.time() > until:
                raise TimeoutError(what)
            time.sleep(0.05)

    def run_cli(self, *args):
        return subprocess.run([self.cli, *args], env=self.env, capture_output=True, text=True, timeout=60)

    def verb(self, *args):
        """(wall ms, exit code, stdout, hop split) of one `nunchiro browser <verb>` run inside the agent session."""
        self.n += 1
        base = os.path.join(self.q, f"{self.n:03d}")
        line = shlex.quote(self.cli) + " browser " + " ".join(shlex.quote(a) for a in args)
        open(base + ".tmp-cmd", "w").write(line + "\n")
        t = time.perf_counter()
        os.rename(base + ".tmp-cmd", base + ".cmd")
        self.wait(lambda: os.path.exists(base + ".out"), 60, line)
        ms = (time.perf_counter() - t) * 1000
        body, _, code = open(base + ".out").read().rpartition("exit=")
        body, split = hops(body)
        return ms, int(code.strip() or 1), body, split

    def pids(self):
        """The app and its WebKit helpers only: the core, the session's shell and its short-lived children (a runner's
        `sleep` made footprint fail a run, w34) are not the browser."""
        allp = procs()
        resp = {p: ml.responsible_pid(p) for p in allp}
        _, webkit = ml.attribute(allp, resp, self.app.pid)
        return [self.app.pid, *webkit]

    def footprint(self):
        pids = self.pids()
        return footprint_sum(pids), len(pids)

    def idle_cpu(self, secs=IDLE):
        """CPU % of the app and its WebKit helpers over `secs` with nothing asked of them. The core (busy for its first
        seconds) and this harness's session runner are left out: they are not the browser."""
        pids = self.pids()
        c0, t0 = bl.cputime(pids), time.monotonic()
        time.sleep(secs)
        return (bl.cputime(pids) - c0) / (time.monotonic() - t0) * 100

    def restart(self):
        """Ticket 998 w35: ends the app (only its own pid) and starts it again on the same bundle id, so the agent's
        profile store is the one the first app wrote: the daily cold start, a known page after a relaunch. The core and
        the session stay."""
        self.app.terminate()
        self.app.wait(10)
        self.app = ml.Spawned([str(self.own.exe)], self.env, self.log)

    def close(self):
        self.app.terminate()
        try:
            self.app.wait(10)
        except subprocess.TimeoutExpired:
            self.app.kill()
        self.run_cli("serve", "stop", "--yes")
        shutil.rmtree(self.home, ignore_errors=True)
        self.own.remove()


def hops(out):
    """(output without the hop line, hop split in ms) of one verb; {} when the CLI printed none (an older build)."""
    keep, split = [], {}
    for line in out.splitlines(keepends=True):
        if not line.startswith("hops {"):
            keep.append(line)
            continue
        h = json.loads(line[5:])
        if "picked" not in h:  # an app without the split (older build): the CLI's ends alone
            continue
        us = lambda a, b: (h[b] - h[a]) / 1000  # noqa: E731 - same Mac clock, microseconds
        split = {"to_core": us("cli_start", "queued"), "queue": us("queued", "picked"), "app": us("picked", "answered"),
                 "back": us("answered", "cli_end"), "cli": us("cli_start", "cli_end"),
                 **{k: h[k] for k in ("main_ms", "call_ms", "calls", "settle_ms", "wake_ms") if k in h}}
    return "".join(keep), split


def first_row(snapshot, roles):
    """Index and label of the first snapshot row whose role is in `roles` (`[3] textbox Search = ""`)."""
    for line in snapshot.splitlines():
        m = re.match(r"\[(\d+)\] (\w+) (.*)", line)
        if m and m.group(2) in roles:
            return m.group(1), m.group(3)[:60]
    return None, None


def run_nunchiro(app, cli, url, idle_after=0.0):
    arm = NunchiroArm(app, cli)
    split = {}

    def verb(name, *args, need=True):
        ms, code, out, split[name] = arm.verb(*args)
        if code and need:
            raise RuntimeError(f"{name} failed: {out[:300]}")
        return ms, code, out

    try:
        time.sleep(SETTLE)
        before, np_before = arm.footprint()
        idle_before = arm.idle_cpu()
        goto_ms, _, _ = verb("goto", "goto", url)
        time.sleep(SETTLE)
        after, np_after = arm.footprint()
        snap_ms, _, snap = verb("snapshot", "snapshot")
        tree_ms, _, tree = verb("tree", "snapshot", "--tree", need=False)
        full_ms, _, full = verb("full", "snapshot", "--full", need=False)
        r = {"mem_mib": (after - before) / 2**20, "procs_before": np_before, "procs_after": np_after,
             "goto_ms": goto_ms, "snapshot_ms": snap_ms, "snapshot_chars": len(snap), "tree_ms": tree_ms,
             "tree_chars": len(tree), "full_ms": full_ms, "full_chars": len(full)}
        field, r["fill_target"] = first_row(full, ("textbox", "searchbox"))
        link, r["click_target"] = first_row(full, ("link",))
        if field:
            r["fill_ms"], r["fill_exit"], _ = verb("fill", "fill", field, "nunchiro", need=False)
        r["press_ms"], _, _ = verb("press", "press", "Tab")
        r["scroll_ms"], _, _ = verb("scroll", "scroll", "down")
        time.sleep(idle_after)
        r["idle_after_s"] = idle_after
        r["idle_cpu_pct"] = arm.idle_cpu()
        r["idle_cpu_before_pct"], r["idle_cpu_page_pct"] = idle_before, r["idle_cpu_pct"] - idle_before
        if link:
            r["click_ms"], r["click_exit"], out = verb("click", "click", link, need=False)
            r["click_line"] = next((l for l in out.splitlines() if l.startswith("clicked")), out[:200])
        # about:blank is refused (agent pages load http/https only); a goto to the same address is still a new document.
        r["warm_goto_ms"], _, _ = verb("warm_goto", "goto", url)
        # A relaunch on the same store: new process, new connections, the HTTP cache the first app left (w35).
        arm.restart()
        time.sleep(SETTLE + IDLE)  # the same quiet start the cold goto had
        r["restart_goto_ms"], _, _ = verb("restart_goto", "goto", url)
        r["hops"] = split
        return r
    finally:
        arm.close()


def ego(script):
    t = time.perf_counter()
    p = subprocess.run(["ego-browser", "nodejs", "-e", script], capture_output=True, text=True, timeout=120)
    wall = (time.perf_counter() - t) * 1000
    lines = [l[l.index("RESULT "):] for l in (p.stdout + p.stderr).splitlines() if "RESULT {" in l]
    if p.returncode or not lines:
        raise RuntimeError(f"ego-browser failed ({p.returncode}): {(p.stdout + p.stderr)[-400:]}")
    return json.loads(lines[-1][7:]), wall


def ego_footprint():
    pids = [p for p, c in procs().items() if "/ego lite.app/" in c]
    return footprint_sum(pids), len(pids)


def space(tag):
    """The ego task space for one page, as a JS string literal: a --page NAME is text, never code (998 L3 security NOTE)."""
    return json.dumps("nunchiro-measure-" + tag)


def run_ego(url, tag):
    before, np_before = ego_footprint()
    load, load_wall = ego(EGO_SCRIPT % {"space": space(tag), "phase": '"load"', "url": json.dumps(url)})
    time.sleep(SETTLE)
    after, np_after = ego_footprint()
    res, round_wall = ego(EGO_SCRIPT % {"space": space(tag), "phase": '"read"', "url": json.dumps(url)})
    return {"mem_mib": (after - before) / 2**20, "procs_before": np_before, "procs_after": np_after,
            "goto_ms": load["goto_ms"], "goto_round_wall_ms": load_wall, "read_round_wall_ms": round_wall, **res}


def summarize(runs, key):
    xs = [r[key] for r in runs if key in r]
    return {"median": ml.median(xs), "min": min(xs), "max": max(xs)} if xs else None


def table(results):
    metrics = [("mem_mib", "memory per tab, MiB"), ("goto_ms", "load (goto), ms"), ("snapshot_chars", "snapshot, chars"),
               ("snapshot_ms", "snapshot, ms"), ("full_chars", "full snapshot, chars"), ("scroll_ms", "scroll, ms"),
               ("fill_ms", "fill, ms"), ("press_ms", "press Tab, ms"), ("click_ms", "click first link, ms"),
               ("idle_cpu_before_pct", "idle CPU before the page, %"), ("idle_cpu_pct", "idle CPU with the page, %"),
               ("idle_cpu_page_pct", "idle CPU of the page (difference), %")]
    cell = lambda v: "-" if v is None else f"{v['median']:.1f} ({v['min']:.1f}-{v['max']:.1f})"  # noqa: E731
    lines = ["| Page | Metric | Nunchiro median (range) | ego lite median (range) | Nunchiro / ego |", "|---|---|---|---|---|"]
    for page in PAGES:
        for key, label in metrics:
            n = summarize(results["nunchiro"][page], key)
            e = summarize(results["ego"][page], key)
            ratio = f"{n['median'] / e['median']:.2f}" if n and e and e["median"] else "-"
            lines.append(f"| {page} | {label} | {cell(n)} | {cell(e)} | {ratio} |")
    lines += ["", "| Page | Verb | to core | queue | app (main wait / calls / settle) | back | CLI total | wall |",
              "|---|---|---|---|---|---|---|---|"]
    for page in PAGES:
        runs = results["nunchiro"][page]
        for name in ("goto", "snapshot", "fill", "press", "scroll", "click", "warm_goto", "restart_goto"):
            h = [r["hops"][name] for r in runs if r.get("hops", {}).get(name)]
            if not h:
                continue
            m = {k: ml.median([x[k] for x in h]) for k in h[0]}
            wall = ml.median([r[f"{name}_ms"] for r in runs if f"{name}_ms" in r])
            lines.append(f"| {page} | {name} | {m['to_core']:.1f} | {m['queue']:.1f} | {m['app']:.1f} ({m['main_ms']:.1f} / "
                         f"{m['call_ms']:.1f} in {m['calls']:.0f} / {m['settle_ms']:.1f}) | {m['back']:.1f} | {m['cli']:.1f} | {wall:.1f} |")
    # The bar (needs 13: within 1.2x ego lite) is read on the warm ratio, like for like: ego's profile keeps its HTTP
    # cache and connections across task spaces. The cold ratio (a new app and store per run) stays next to it.
    # Restart = the app relaunched on the store the cold goto filled (w35): the daily cold start of a known page.
    lines += ["", "| Page | Nunchiro cold goto (new store) | Nunchiro restart goto (same store) | Nunchiro warm goto | "
              "ego lite goto (warm cache) | warm ratio (bar) | restart ratio | cold ratio |", "|---|---|---|---|---|---|---|---|"]
    for page in PAGES:
        c, r, w, e = (summarize(results[arm][page], key) for arm, key in
                      (("nunchiro", "goto_ms"), ("nunchiro", "restart_goto_ms"), ("nunchiro", "warm_goto_ms"), ("ego", "goto_ms")))
        ratio = lambda n: f"{n['median'] / e['median']:.2f}" if n and e and e["median"] else "-"  # noqa: E731
        lines.append(f"| {page} | {cell(c)} | {cell(r)} | {cell(w)} | {cell(e)} | {ratio(w)} | {ratio(r)} | {ratio(c)} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", default="docs/research/browser/measure-raw")
    ap.add_argument("--only", choices=["nunchiro", "ego"])
    ap.add_argument("--page", action="append", metavar="NAME=URL", help="pages to use instead of PAGES (repeatable)")
    ap.add_argument("--idle-after", type=float, default=0.0, help="seconds to wait after the actions before idle CPU")
    a = ap.parse_args()
    if a.page:  # e.g. when a page's host does not resolve on this network
        PAGES.clear()
        PAGES.update(p.split("=", 1) for p in a.page)
    a.app, a.cli = os.path.abspath(a.app), os.path.abspath(a.cli)  # Spawned runs the app with cwd /
    os.makedirs(a.out, exist_ok=True)
    meta = {"date": time.strftime("%Y-%m-%d %H:%M:%S"), "pages": PAGES, "runs": a.runs, "settle_s": SETTLE,
            "load_start": load_avg(), "host": subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip(),
            "ego_version": subprocess.run(["defaults", "read", "/Applications/ego lite.app/Contents/Info", "CFBundleShortVersionString"],
                                          capture_output=True, text=True).stdout.strip(),
            "nunchiro_commit": subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()}
    results = {"meta": meta, "nunchiro": {p: [] for p in PAGES}, "ego": {p: [] for p in PAGES}}
    if not a.only or a.only == "ego":  # warm ego once so its first-launch cost is not in run 1 (a blank round, space finished)
        ego(EGO_SCRIPT % {"space": space("warm"), "phase": '"load"', "url": json.dumps("about:blank")})
        ego(EGO_SCRIPT % {"space": space("warm"), "phase": '"read"', "url": '""'})
        meta["ego_baseline_procs"] = ego_footprint()
    for i in range(a.runs):
        for page, url in PAGES.items():  # interleave arms per run so both see the same host conditions
            if not a.only or a.only == "nunchiro":
                results["nunchiro"][page].append({**run_nunchiro(a.app, a.cli, url, a.idle_after), "load": load_avg()})
            if not a.only or a.only == "ego":
                results["ego"][page].append({**run_ego(url, f"{page}-{i}"), "load": load_avg()})
            print(f"run {i + 1}/{a.runs} {page} done", file=sys.stderr, flush=True)
    meta["load_end"] = load_avg()
    with open(os.path.join(a.out, "browser.json" if not a.only else f"browser-{a.only}.json"), "w") as f:
        json.dump(results, f, indent=1)
    print(table(results))


if __name__ == "__main__":
    main()
