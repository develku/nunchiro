"""xterm.js speed and stability figures (V1A-44), measure only. Usage:
  paint.py [--quick] [--only echo,stream,mem,soak,webgl] [--no-record]
  paint.py --only stream --sizes 4,8 --engines webkit --no-record   (V1A-51 A/B comparisons)
  paint.py --profile   (V1A-51: one stream-8 WebKit job with every script task timed; prints where long frames go)

The shipped web bundle (vite build) on a release core (`nunchiro serve`, scratch NUNCHIRO_HOME), driven by Playwright
WebKit (the Tauri window's engine family; primary rows) and Chromium (second rows). Fake agents only
(workload/stream_agent.py over the seeded stream_gen.py output), so no model runs and no agent config is read.
Rows: paint-busy3 (echo to paint, 3 streaming sessions), stream-{1,4,8} (20 MiB each into visible terminals), mem-term
(per terminal with full scrollback), soak-8 (10 min, WebKit), plus the WebGL comparison on a measure-only page.
Each phase runs once at the host's load with the stated repeats; a phase whose 1-min load passes 20 is stopped and
recorded "not run: load"; none starts inside the lumen quiet windows. Every process started is tracked and stopped
here. Raw output: .scratch/measure/<stamp>-paint/; the entry goes to docs/v1/figures.md."""
import argparse, datetime as dt, hashlib, json, os, re, shutil, socket, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "workload"))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
import stream_gen  # noqa: E402
from lib import clean_env, descendants, guard_check, snapshot  # noqa: E402

WEB = ROOT / "web"
AGENT = HERE / "workload/stream_agent.py"
SCROLLBACK = int(re.search(r"TERM_DEFAULTS: TermPrefs = \{.*?\n  scrollback: (\d+),", (WEB / "src/terminal/options.ts").read_text(), re.S)[1])
ENGINES = ("webkit", "chromium")
SIZES = (1, 4, 8)
RATE = 64 * 1024  # busy and soak sessions, bytes/s
KEYS = list(rel.WORK["keys"])  # ticket 11's keys: rare uppercase letters and whole Hangul syllables
PHASES = ("echo", "stream", "mem", "soak", "webgl")
RESULTS = []  # every job's result, for the browser versions


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Core(rel.Nunchiro):
    """Ticket 11's scratch core; sessions here are fake agents in shell sessions."""

    def agent(self, label, trigger, *args):
        return self.cli("session", "start", "--kind", "shell", "--project", str(self.home), "--label", label, "--",
                        sys.executable, "-I", "-B", str(AGENT), "--label", label, "--trigger", str(trigger), *args)["session"]["id"]

    def agents(self, d, n, prefix, *args):
        sids, labels, triggers = [], {}, []
        for i in range(n):
            label, trig = f"{prefix}{i}", d / f"go-{prefix}{i}"
            sid = self.agent(label, trig, *args)
            sids.append(sid)
            labels[sid] = label
            triggers.append(str(trig))
        return dict(sessions=sids, labels=labels, triggers=triggers)


def stop_tree(pw):
    """A Playwright run still going (load stop, timeout): its tree and every process naming it responsible (the
    browser's XPC helpers). One that already exited and was reaped is left alone: its pid may be reused."""
    if pw.poll() is not None:
        return
    procs = ml.parse_ps(subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout)
    pids = set(descendants(pw.pid)) | {p for p in procs if p != pw.pid and ml.responsible_pid(p) == pw.pid}
    rel.kill_pids(sorted(pids))
    pw.kill()
    pw.wait()


def wait_load(until_s=3600):
    """Coordinator rule (round 2): start only under PAINT_LOAD_START, polled once a minute. True when it got there."""
    end = time.monotonic() + until_s
    while rel.load() >= ml.PAINT_LOAD_START:
        if time.monotonic() > end:
            return False
        time.sleep(60)
    return True


def run_job(name, engine, phase, minutes, a, setup):
    """run_once, and one retry after the load fell under the start level when load stopped it (coordinator rule)."""
    r = run_once(name, engine, phase, minutes, a, setup)
    if r.get("not_run", "").startswith("not run: load"):
        print(f"{name} {engine}: waiting for load < {ml.PAINT_LOAD_START:g} to retry once", flush=True)
        if wait_load():
            first = r
            r = run_once(name + "-retry", engine, phase, minutes, a, setup)
            r["retried_after"] = first["not_run"]
    return r


def run_once(name, engine, phase, minutes, a, setup):
    """One Playwright run of web/measure/paint.spec.ts. Returns its result with loads, or {not_run}."""
    q = ml.quiet(dt.datetime.now(dt.timezone.utc), minutes)
    if q:
        print(f"{name} {engine}: not run, lumen quiet window {q}", flush=True)
        return dict(not_run=f"not run: quiet window {q}")
    d = a.out / f"{name}-{engine}"
    d.mkdir(parents=True)
    loads, core, pw, stopped, alive = [rel.load()], None, None, None, None
    try:
        core = Core() if phase != "webgl" else None
        spec = dict(phase=phase, home=str(core.home) if core else "", bin=str(rel.CORE), out=str(d / "result.json"),
                    root_file=str(d / "root.pid"), echo=None, sessions=[], labels={}, triggers=[], keys=KEYS,
                    gap_ms=50, probe_every_ms=1000, timeout_s=600, soak_s=0, sample_every_s=60, stream=str(a.stream),
                    marks=a.marks, sizes=list(SIZES), repeats=a.repeats, page_url=f"http://127.0.0.1:{a.page_port}/")
        spec.update(setup(core, d), profile=a.profile)
        if a.echo_profile:
            spec["cpuprofile"] = str(d / "echo.cpuprofile")
        (d / "job.json").write_text(json.dumps(spec, indent=1, ensure_ascii=False))
        env = dict(core.env if core else clean_env(), PAINT_JOB=str(d / "job.json"), NUNCHIRO_WEB_PORT=str(a.port),
                   PAINT_PAGE_PORT=str(a.page_port))
        argv = [a.pnpm, "-C", str(WEB), "exec", "playwright", "test", "-c", "playwright.measure.config.ts",
                "--project", engine, "--workers=1"]
        with open(d / "playwright.log", "ab") as log:
            pw = ml.Spawned(argv, env, log)  # own responsibility: the browser's XPC helpers name this pid
        (d / "root.pid").write_text(str(pw.pid))
        until = time.monotonic() + minutes * 60 + 300
        while pw.poll() is None:
            time.sleep(5)
            loads.append(rel.load())
            if loads[-1] > ml.PAINT_LOAD_STOP:
                stopped = f"not run: load {loads[-1]} > {ml.PAINT_LOAD_STOP:g}"
                break
            if time.monotonic() > until:
                stopped = "not run: timeout"
                break
        if core:
            alive = dict(core=core.core.poll() is None, agents=len(core.tree()))
    finally:
        if pw is not None:
            stop_tree(pw)
        if core is not None:
            core.stop()
    loads.append(rel.load())
    if stopped:
        print(f"{name} {engine}: {stopped}", flush=True)
        return dict(not_run=stopped, loads=loads)
    try:
        r = json.loads((d / "result.json").read_text())
    except FileNotFoundError:
        raise RuntimeError(f"{name} {engine}: no result; see {d / 'playwright.log'}") from None
    if r.get("error"):
        raise RuntimeError(f"{name} {engine}: {r['error'][:400]}; see {d / 'playwright.log'}")
    r.update(loads=loads, alive=alive, dir=str(d.relative_to(ROOT)))
    RESULTS.append(r)
    if spec.get("echo"):
        r["echo_log"] = str(d / "echo.log")
    return r


def profile_summary(r):
    """V1A-51: each frame gap over the stall bar split by task kind (ms summed over the tasks that started in it, the
    longest one, WebSocket bytes), `other` = the gap no script task covers (style, layout, paint, GC)."""
    stall = ml.STALL_MS
    ts, tasks = r["recorded"]["frames"], r["profile"]
    out = []
    for a, b in zip(ts, ts[1:]):
        if b - a <= stall:
            continue
        inside = [t for t in tasks if a <= t[0] < b]
        kinds = {}
        for _, ms, kind, n in inside:
            k = kinds.setdefault(kind, dict(ms=0.0, n=0, max_ms=0.0, bytes=0))
            k["ms"] += ms
            k["n"] += 1
            k["max_ms"] = max(k["max_ms"], ms)
            k["bytes"] += n
        for k in kinds.values():
            k["ms"], k["max_ms"] = round(k["ms"], 1), round(k["max_ms"], 1)
        out.append(dict(at_ms=round(a - r["recorded"]["t0"]), gap_ms=round(b - a), kinds=kinds,
                        other_ms=round(b - a - sum(k["ms"] for k in kinds.values()))))
    return out


def frames_of(r, t0, t1):
    rec = r.get("recorded") or {}
    ts = [t for t in rec.get("frames", []) if t0 <= t <= t1]
    s = ml.frame_stats(ts)
    s["valid"] = ml.frames_valid(r.get("idle_fps"))
    longs = [d for st, d in rec.get("long", []) if t0 <= st <= t1]
    s["long_max_ms"] = round(max(longs, default=0), 1) if r["engine"] == "chromium" else None
    s["long_stalls"] = sum(d > ml.STALL_MS for d in longs)  # accepted bar: no long task > 200 ms (Chromium reports them)
    return s


def keys_of(r, field):
    return ml.judge_keys(r.get(field) or [], ml.EchoLog(r["echo_log"]))


# Phases: (name, engine, minutes budget, setup) -> results; the analysis below turns them into rows.

def echo_phase(a, engine):
    def setup(core, d):
        log = d / "echo.log"
        spec = core.agents(d, a.busy, "b", "--stream", str(a.stream), "--rate", str(RATE), "--loop", "--heartbeat", "2")
        return dict(spec, echo=core.start_echo(log), keys=[KEYS[i % len(KEYS)] for i in range(a.n)])
    return [run_job(f"echo-r{r}", engine, "echo", 5, a, setup) for r in range(a.repeats)]


def stream_phase(a, engine):
    out = {}
    for r in range(a.repeats):
        for n in a.sizes:
            def setup(core, d, n=n):
                return dict(core.agents(d, n, "s", "--stream", str(a.stream)), echo=core.start_echo(d / "echo.log"))
            out.setdefault(n, []).append(run_job(f"stream{n}-r{r}", engine, "stream", 12, a, setup))
    return out


def mem_phase(a, engine):
    def setup(core, d):
        return dict(core.agents(d, 8, "m", "--fill", str(SCROLLBACK + 200)), timeout_s=300)
    return run_job("mem", engine, "mem", 8, a, setup)


def soak_phase(a, engine):
    def setup(core, d):
        return dict(core.agents(d, 8, "k", "--stream", str(a.stream), "--rate", str(RATE), "--loop", "--heartbeat", "2"),
                    soak_s=a.soak_min * 60)
    return run_job("soak", engine, "soak", a.soak_min + 4, a, setup)


def webgl_phase(a, engine):
    return run_job("webgl", engine, "webgl", 20, a, lambda core, d: {})


def load_rng(*rs):
    loads = [ld for r in rs if r for ld in r.get("loads", [])]
    return ml.load_range(loads) if loads else None


def echo_row(rs):
    ran = [r for r in rs if not r.get("not_run")]
    if not ran:
        return dict(not_run=rs[0]["not_run"], load=load_rng(*rs))
    per = [keys_of(r, "keys") for r in ran]
    judged = [x for j, _, _ in per for x in j]
    if not judged:
        return dict(not_run="not run: no keys recorded", load=load_rng(*rs))
    dom = [k["dom_ms"] for r in ran for k in r["keys"] if k["dom_ms"] is not None]
    row = dict(n=len(judged), misses=sum(m for _, m, _ in per), unread=sum(u for _, _, u in per),
               p50_ms=round(ml.pct(judged, 50), 2), p95_ms=round(ml.pct(judged, 95), 2), max_ms=round(max(judged), 2),
               dom_p95_ms=round(ml.pct(dom, 95), 2) if dom else None, p95_per_repeat=[round(ml.pct(j, 95), 2) for j, _, _ in per],
               idle_fps=[r["idle_fps"] for r in ran], late=[frames_of(r, 0, 1e12)["late"] for r in ran],
               load=load_rng(*ran), browser=ran[0]["browser"], skipped_repeats=len(rs) - len(ran),
               frames_valid=all(ml.frames_valid(r["idle_fps"]) for r in ran), retried=sum("retried_after" in r for r in ran))
    row["passed"], row["bar"] = ml.paint_bar(row)
    if row["skipped_repeats"] or not row["frames_valid"]:
        row["passed"] = None  # a partial or frame-throttled row is reported, never judged
    return row


def stream_row(n, rs, size):
    ran = [r for r in rs if not r.get("not_run")]
    if not ran:
        return dict(not_run=rs[0]["not_run"], terminals=n, load=load_rng(*rs))
    walls, painted, stalls, late, worst, longs, probes, valid, delivered = [], [], [], [], [], [], [], True, []
    for r in ran:
        t0 = r["recorded"]["t0"]
        ends = [e for e in r["ends"].values() if isinstance(e, (int, float))]
        painted.append(len(ends))
        end = max(ends) if len(ends) == n else max(r["recorded"]["frames"][-1:] or [t0])
        walls.append(round((end - t0) / 1000, 2) if len(ends) == n else None)
        f = frames_of(r, t0, end)
        valid &= f["valid"]
        stalls.append(f["stalls"] + f["long_stalls"])
        late.append(f["late"])
        worst.append(f["worst_ms"])
        longs.append(f["long_max_ms"])
        probes += keys_of(r, "probes")[0]
        # A session with no frames is left out, not counted as a 0 MiB terminal.
        by = {k: ml.delivery(v) for k, v in r["wsframes"].items() if v} if "wsframes" in r else r.get("delivered") or {}
        got = [d for d in by.values() if d]
        delivered.append(round(sum(d["bytes"] for d in got) / max(1, len(got)) / 2**20, 1) if got else None)
    done = [w for w in walls if w is not None]
    row = dict(terminals=n, painted=painted, tails=[r.get("tails") for r in ran], wall_s=walls, wall_median_s=ml.median(done) if done else None,
               delivered_mib=delivered, stalls=stalls, late=late,
               worst_frame_ms=worst, long_max_ms=longs, frames_valid=valid, probe_n=len(probes),
               probe_p95_ms=round(ml.pct(probes, 95), 1) if probes else None, probe_max_ms=round(max(probes), 1) if probes else None,
               idle_fps=[r["idle_fps"] for r in ran], load=load_rng(*ran), browser=ran[0]["browser"],
               skipped_repeats=len(rs) - len(ran), retried=sum("retried_after" in r for r in ran))
    row["passed"], row["bar"] = ml.stream_bar(row)
    if row["skipped_repeats"] or (not valid and n == 8):
        row["passed"] = None  # partial, or frames throttled where the bar judges stalls: reported, not judged
    return row


def mem_row(r):
    if r.get("not_run"):
        return dict(not_run=r["not_run"], load=load_rng(r))
    med = lambda xs, k: ml.median([x[k] for x in xs])  # noqa: E731
    base, loaded = med(r["base"], "bytes"), med(r["loaded"], "bytes")
    sizes = sorted(set(re.findall(r"@@ (\d+x\d+)", " ".join(r.get("sizes", [])))))  # cols x rows, from each end marker
    row = dict(terminals=r["terminals"], scrollback=SCROLLBACK, fill=SCROLLBACK + 200, sizes=sizes, base_mib=rel.mib(base), loaded_mib=rel.mib(loaded),
               per_terminal_mib=ml.per_terminal(base, loaded, r["terminals"]), load=load_rng(r), browser=r["browser"])
    if r["engine"] == "chromium":
        row["heap_per_terminal_mib"] = ml.per_terminal(med(r["base"], "heap"), med(r["loaded"], "heap"), r["terminals"])
    row["retried"] = int("retried_after" in r)
    row["passed"], row["bar"] = ml.mem_bar(row["per_terminal_mib"])
    return row


def soak_row(r):
    if r.get("not_run"):
        return dict(not_run=r["not_run"], load=load_rng(r))
    samples = [(round(s["minute"]), s["bytes"]) for s in r["samples"]]
    painted = {label: [t / 1000 for _, t in hb] for label, hb in r["hb"].items()}
    stuck = ml.stuck(painted, sorted(r["hb"]), r["t0"] / 1000, r["t_end"] / 1000)
    crashes = r["crashes"] + (not r["connected"]) + (not r["alive"]["core"]) + (r["alive"]["agents"] < 8)
    row = dict(minutes=samples[-1][0], crashes=crashes, stuck=stuck, growth=ml.growth(samples),
               footprint_mib=[(m, rel.mib(b)) for m, b in samples], heartbeats=sum(len(v) for v in painted.values()),
               alive=r["alive"], load=load_rng(r), browser=r["browser"])
    row["retried"] = int("retried_after" in r)
    row["passed"], row["bar"] = ml.soak_bar(row)
    return row


def webgl_rows(r):
    if r.get("not_run"):
        return dict(not_run=r["not_run"], load=load_rng(r))
    out = {}
    for run in r["runs"]:
        key = f"{run['renderer']}-{run['n']}"
        g = out.setdefault(key, dict(walls=[], stalls=[], late=[], errors=[], lost=0, idle_fps=[]))
        g["idle_fps"].append(run["idle_fps"])
        if run.get("error"):
            g["errors"].append(run["error"])
            continue
        f = ml.frame_stats([t for t in run["frames"] if t >= run["t0"]])
        g["walls"].append(round(run["wall_ms"] / 1000, 2))
        g["stalls"].append(f["stalls"])
        g["late"].append(f["late"])
        g["lost"] += run["context_lost"]
    for g in out.values():
        g["wall_median_s"] = ml.median(g["walls"]) if g["walls"] else None
        g["frames_valid"] = all(ml.frames_valid(x) for x in g["idle_fps"])
    return dict(rows=out, load=load_rng(r), browser=r["browser"], retried=int("retried_after" in r))


def verdict(row):
    if row.get("not_run"):
        return row["not_run"]
    return {True: "**pass**", False: "**miss**", None: "not judged"}[row.get("passed")]


def fmt_mib(xs):
    return f"{xs} MiB" if xs and any(x is not None for x in xs) else "not counted"


def skipped(row):
    out = f"; **{row['skipped_repeats']} repeat(s) not run (load or quiet window)**" if row.get("skipped_repeats") else ""
    return out + (f"; {row['retried']} job(s) retried after a load stop" if row.get("retried") else "")


def rng(row):
    return f"{row['load'][0]}-{row['load'][1]}" if row.get("load") else ""


def body(rows, ver, a, out, ld0, ld1):
    mib = a.stream_size / 2**20
    lines = [f"## {time.strftime('%Y-%m-%d %H:%M')} paint, Nunchiro {ver['commit']}{' (dirty)' if ver['dirty'] else ''}, xterm.js {ver['xterm']}", "",
             f"macOS {ver['macos']}, {ver['host']} {ver['memory_gib']} GiB, {ver['cores']} cores; release core; shipped bundle "
             f"(vite build) in Playwright {ver['playwright']}: WebKit {ver.get('webkit', '?')} headless, Chromium {ver.get('chromium', '?')} "
             f"headed; 1440 x 900 at 2x. Fake agents only (`stream_agent.py`), stream `stream_gen.py` seed {stream_gen.SEED}, "
             f"{a.stream_size} bytes, sha256 `{a.stream_sha}`. `SCROLLBACK` {SCROLLBACK}. Measured under the host's load, 1-min "
             f"load {ld0} at start, {ld1} at end. Command: `sh scripts/measure/paint.sh{' --quick' if a.quick else ''}`. "
             f"Raw: `{out.relative_to(ROOT)}/`.", "",
             "| Row | Engine | Result | Bar | Verdict | 1-min load |", "|---|---|---|---|---|---|"]
    for e in ENGINES:
        r = rows.get(f"paint-busy3-{e}")
        if r:
            res = r.get("not_run") or (f"n {r['n']} ({r['misses']} missed, {r['unread']} painted unread), p50 {r['p50_ms']} ms, "
                                       f"p95 {r['p95_ms']} ms, max {r['max_ms']} ms; in rows (before the frame) p95 {r['dom_p95_ms']} ms; "
                                       f"p95 per repeat {r['p95_per_repeat']}; idle fps {r['idle_fps']}"
                                       + skipped(r) + ("" if r["frames_valid"] else "; **frames throttled**"))
            lines.append(f"| `paint-busy3` | {e} | {res} | {ml.BARS['paint']} | {verdict(r)} | {rng(r)} |")
    for n in SIZES:
        for e in ENGINES:
            r = rows.get(f"stream-{n}-{e}")
            if not r:
                continue
            res = r.get("not_run") or (f"painted {r['painted']}/{n} (stream tail shown {r['tails']}), wall to the end marker {r['wall_s']} s (median {r['wall_median_s']} s), "
                                       f"received per terminal {fmt_mib(r.get('delivered_mib'))} of {mib:g} MiB, stalls > 200 ms (frame gaps{' + long tasks' if e == 'chromium' else ''}) {r['stalls']}, late frames {r['late']}, "
                                       f"worst frame {r['worst_frame_ms']} ms" + (f", longest task {r['long_max_ms']} ms" if e == "chromium" else "")
                                       + f"; probe n {r['probe_n']}, p95 {r['probe_p95_ms']} ms, max {r['probe_max_ms']} ms"
                                       + ("" if r["frames_valid"] else f"; **frames throttled (idle fps {r['idle_fps']})**") + skipped(r))
            lines.append(f"| `stream-{n}` | {e} | {res} | {'all markers painted' if n < 8 else ml.BARS['stream']} | {verdict(r)} | {rng(r)} |")
    for e in ENGINES:
        r = rows.get(f"mem-term-{e}")
        if r:
            res = r.get("not_run") or (f"{r['per_terminal_mib']} MiB per terminal ({r['terminals']} terminals of {'/'.join(r['sizes']) or '?'} "
                                       f"cells, {r['fill']} lines each; "
                                       f"web content {r['base_mib']} -> {r['loaded_mib']} MiB)"
                                       + (f"; JS heap {r['heap_per_terminal_mib']} MiB per terminal" if "heap_per_terminal_mib" in r else "") + skipped(r))
            lines.append(f"| `mem-term` | {e} | {res} | {ml.BARS['mem']} | {verdict(r)} | {rng(r)} |")
    r = rows.get("soak-8-webkit")
    if r:
        res = r.get("not_run") or (f"{r['minutes']} min, {r['crashes']} crashes, stuck {r['stuck'] or 0}, footprint end / minute 2 "
                                   f"{r['growth'][1]}, MiB by minute {r['footprint_mib']}, {r['heartbeats']} heartbeats painted" + skipped(r))
        lines.append(f"| `soak-8` | webkit | {res} | {ml.BARS['soak']} | {verdict(r)} | {rng(r)} |")
    for e in ENGINES:
        w = rows.get(f"webgl-{e}")
        if not w:
            continue
        if w.get("not_run"):
            lines.append(f"| `webgl-*` | {e} | {w['not_run']} | none (reference) | | |")
            continue
        for n in SIZES:
            parts = []
            for kind in ("dom", "webgl"):
                g = w["rows"].get(f"{kind}-{n}", {})
                err = f", errors {g['errors'][:1]}" if g.get("errors") else ""
                parts.append(f"{kind}: wall {g.get('walls')} s (median {g.get('wall_median_s')} s), stalls {g.get('stalls')}, "
                             f"late {g.get('late')}{err}" + (f", context lost {g['lost']}" if g.get("lost") else "")
                             + ("" if g.get("frames_valid", True) else f", **frames throttled (idle fps {g['idle_fps']})**"))
            lines.append(f"| `webgl-{n}` | {e} | {'; '.join(parts)}{skipped(w)} | none (reference) | | {rng(w)} |")
    lines += ["", f"Stream rows: {mib:g} MiB per terminal written as fast as the PTY takes it, an echo session visible beside "
              "them for the probe key (one per second). The core keeps the last 1 MiB per session; a window further behind "
              "skips to the newest output (`[earlier output trimmed]`), so the wall time is the time to catch up and paint "
              "the end, and \"received\" is what the window was sent and parsed, counted from its WebSocket frames "
              "(each byte once). The probe key is one per second, so a stream row has only a few probes (probe n): a "
              "small sample. Busy and soak sessions stream at 64 KiB/s with a heartbeat every 2 s.",
              "", "What this entry does not prove: the Tauri WKWebView itself (Playwright's WebKit build, headless; Chromium "
              "headed), the owner's display, GPU and Retina panel (1440 x 900 at 2x emulated on the Mac mini's 4K display), real agents' "
              "output mix (fixed seeded stream), Codex sessions, IME composition (Hangul enters as whole committed syllables), "
              "and memory of one wide pane: `mem-term` panes are the 8-pane grid's size (recorded in the row), while the "
              "window's memory grows with pane width (Terminal.tsx: 10,000 lines of a 200-column pane were about 25 MiB)."]
    return lines


def versions(results):
    v = lambda *a: subprocess.run(list(a), capture_output=True, text=True).stdout.strip()  # noqa: E731
    pkg = lambda p: json.loads((WEB / "node_modules" / p / "package.json").read_text())["version"]  # noqa: E731
    out = dict(macos=v("sw_vers", "-productVersion") + " " + v("sw_vers", "-buildVersion"),
               commit=v("git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"),
               dirty=bool(v("git", "-C", str(ROOT), "status", "--porcelain", "--", "crates", "app", "web", "scripts/measure")),
               host=v("sysctl", "-n", "hw.model"), memory_gib=int(v("sysctl", "-n", "hw.memsize")) // 2**30, cores=os.cpu_count(),
               xterm=pkg("@xterm/xterm"), addon_webgl=pkg("@xterm/addon-webgl"), playwright=pkg("@playwright/test"))
    for r in results:
        if r.get("browser"):
            out.setdefault(r["engine"], r["browser"])
    return out


def build(a):
    for cfg in ([], ["-c", "measure/vite.config.ts"]):
        subprocess.run([a.pnpm, "-C", str(WEB), "exec", "vite", "build", "--logLevel", "error", *cfg], check=True,
                       env=dict(os.environ, PAINT_PAGE_PORT=str(a.page_port)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="smoke: 1 repeat, 30 keys, 1 MiB stream, 1 min soak")
    ap.add_argument("--only", default=",".join(PHASES))
    ap.add_argument("--no-record", action="store_true")
    ap.add_argument("--profile", action="store_true", help="V1A-51: one stream-8 WebKit job, every task timed; no record")
    ap.add_argument("--echo-profile", action="store_true", help="perf-remeasure: one Chromium echo job (100 keys, 3 streams) with a CPU profile; no record")
    ap.add_argument("--marks", action="store_true", help="V2.5-18 r2: echo keys also record WebSocket send and echo-frame arrival marks (result.json keys[].send_ms/recv_ms)")
    ap.add_argument("--busy", type=int, default=3, help="V2.5-18 r2: streaming sessions beside the echo session (default 3; 0 = the echo session alone)")
    ap.add_argument("--sizes", help="stream terminal counts, e.g. 4,8 (V1A-51 comparisons)")
    ap.add_argument("--engines", help="webkit and/or chromium")
    ap.add_argument("--repeats", type=int, help="override the repeat count (perf-baseline asks for 5)")
    a = ap.parse_args()
    a.sizes = tuple(int(n) for n in a.sizes.split(",")) if a.sizes else SIZES
    engines = tuple(a.engines.split(",")) if a.engines else ENGINES
    if set(engines) - set(ENGINES):
        raise SystemExit(f"--engines takes {','.join(ENGINES)}")
    if a.profile:
        a.only, a.sizes, engines, a.no_record = "stream", (8,), ("webkit",), True
    if a.echo_profile:
        a.only, engines, a.no_record = "echo", ("chromium",), True
    a.no_record |= a.quick  # smoke figures are not results: a quick run never writes the record
    only = a.only.split(",")
    if set(only) - set(PHASES):
        raise SystemExit(f"--only takes {','.join(PHASES)}")
    want = a.repeats
    a.repeats, a.n, a.stream_size, a.soak_min = (1, 30, 2**20, 1) if a.quick else (3, 300, stream_gen.SIZE, 10)
    if a.profile or a.echo_profile:
        a.repeats = 1
    if a.echo_profile:
        a.n = 100
    elif want and not a.profile:
        a.repeats = want
    lock = ml.Lock(str(ROOT / ".scratch/measure.lock"))  # noqa: F841 - held until exit
    a.pnpm = shutil.which("pnpm")
    if not rel.CORE.is_file() or not a.pnpm:
        raise SystemExit(f"needs the release core {rel.CORE} (scripts/measure/build.sh) and pnpm on PATH")
    a.out = ROOT / ".scratch/measure" / time.strftime("%Y%m%d-%H%M%S-paint")
    a.out.mkdir(parents=True)
    a.stream = a.out / "stream.bin"
    data = stream_gen.generate(a.stream_size)
    a.stream.write_bytes(data)
    a.stream_sha = hashlib.sha256(data).hexdigest()
    a.port, a.page_port = free_port(), free_port()
    os.environ["NUNCHIRO_WINDOW_ORIGINS"] = f"http://127.0.0.1:{a.port}"  # the scratch core accepts the preview's origin
    if not a.quick:
        print(f"waiting for 1-min load < {ml.PAINT_LOAD_START:g} (polled once a minute)", flush=True)
        if not wait_load():
            raise SystemExit(f"1-min load stayed at or above {ml.PAINT_LOAD_START:g} for an hour; nothing measured")
    ld0 = rel.load()
    guard_before = snapshot()
    raw, rows = dict(load_start=ld0, stream_sha=a.stream_sha, stream_size=a.stream_size), {}
    try:
        build(a)
        for e in engines:
            if "echo" in only:
                raw[f"echo-{e}"] = rs = echo_phase(a, e)
                rows[f"paint-busy3-{e}"] = echo_row(rs)
            if "stream" in only:
                raw[f"stream-{e}"] = by = stream_phase(a, e)
                for n, rs in by.items():
                    rows[f"stream-{n}-{e}"] = stream_row(n, rs, a.stream_size)
            if "mem" in only:
                raw[f"mem-{e}"] = r = mem_phase(a, e)
                rows[f"mem-term-{e}"] = mem_row(r)
            if "webgl" in only:
                raw[f"webgl-{e}"] = r = webgl_phase(a, e)
                rows[f"webgl-{e}"] = webgl_rows(r)
        if "soak" in only:  # one soak, primary engine (brief: soak 1)
            raw["soak-webkit"] = r = soak_phase(a, "webkit")
            rows["soak-8-webkit"] = soak_row(r)
    finally:
        problems, foreign = guard_check(guard_before, snapshot(), [str(ROOT / ".scratch"), str(HERE)])
        raw.update(rows=rows, guard_problems=problems, guard_foreign=foreign, load_end=rel.load())
        (a.out / "result.json").write_text(json.dumps(raw, indent=1, ensure_ascii=False, default=str))
    if problems:
        raise SystemExit(f"guard: user config changed during this run: {problems}")
    if a.profile:
        for r in raw["stream-webkit"][8]:
            if not r.get("not_run"):
                print(json.dumps(profile_summary(r), indent=1))
    if a.echo_profile:
        for r in raw["echo-chromium"]:
            if not r.get("not_run"):
                print(json.dumps(dict(cpuprofile=r.get("cpuprofile"), cpu_top=r.get("cpu_top")), indent=1))
    ver = versions(RESULTS)
    lines = body(rows, ver, a, a.out, ld0, raw["load_end"])
    if a.no_record:
        print("\n".join(lines))
        return
    ml.prepend_entry(str(rel.FIGURES), "\n".join(lines), "paint", dict(rows=rows, versions=ver, stream_sha=a.stream_sha))
    print(f"recorded in {rel.FIGURES.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
