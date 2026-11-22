"""Waiting matrix for ticket 01. Usage: matrix.py [--runs N] [--par P] [--rows C1,C2,...]

For each run: start the agent in a PTY with per-session hooks pointing at a stub core, elicit the
waiting state, and record when each source saw it:
  screen     - the agent showed it (pattern on the PTY output; this is the reference time t_show)
  hook       - first matching hook event received by the core
  transcript - first matching line appended to the session transcript
A run passes when a listener-side source (hook or transcript) saw the item within 1 s of t_show and
nothing auto-approved it. Screen-only rows (folder trust) have no listener-side source; they pass on the
core-side screen reader's own delay (chunk arrival to pattern match, screen_delay) being within 1 s.
A run where the state never showed is "not elicited" (the model did not do what the prompt asked) and
is retried, not counted.
Answers are always deny / Esc / "No, exit"; nothing that changes user settings.
"""
import argparse, json, os, re, shutil, subprocess, sys, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import HERE, OUT, TRUSTED_CWD, Core, Session, claude_settings, clean_env, codex_argv, guard_check, snapshot, sock_path  # noqa: E402

UNTRUSTED_ROOT = os.environ.get("UNTRUSTED_ROOT", "/private/tmp/nunchiro-v1a01-untrusted")  # outside ~ and any repo
PERM = r"Do you want to proceed\?"


def ev_is(name, **kw):
    def f(e):
        if e.get("event") != name:
            return False
        try:
            p = json.loads(e.get("payload") or "{}")
        except ValueError:
            return False
        return all(v(p.get(k)) if callable(v) else p.get(k) == v for k, v in kw.items())
    return f


def tr_tool(name):
    return lambda line: '"type":"tool_use"' in line.replace(" ", "") and f'"name":"{name}"' in line.replace(" ", "")


CLAUDE_ROWS = {
    "C1": dict(title="Claude permission prompt", prompt="Use the Bash tool to run exactly: touch {f}", show=PERM,
               hook=ev_is("PermissionRequest", tool_name="Bash"), tr=tr_tool("Bash")),
    "C2": dict(title="Claude AskUserQuestion", show=r"Enter to select",
               prompt='Use the AskUserQuestion tool to ask me one question: "red or blue?" with options red and blue. Do nothing else.',
               hook=ev_is("PermissionRequest", tool_name="AskUserQuestion"), tr=tr_tool("AskUserQuestion")),
    "C3": dict(title="Claude folder trust", prompt=None, show=r"Is this a project you created or one you trust", untrusted=True,
               hook=None, tr=None),
    "C4": dict(title="Claude read outside working directory", prompt="Use the Read tool to read the file /etc/hosts. Do nothing else.",
               show=r"Read\(/etc/hosts\).*" + PERM, hook=ev_is("PermissionRequest", tool_name="Read"), tr=tr_tool("Read")),
    "C5": dict(title="Claude background task running at Stop",
               prompt="Use the Bash tool with run_in_background set to true to run: sleep 45. Then reply with the single word started and end your turn. Do not wait for it.",
               show=r"shell still running", extra={"permissions": {"allow": ["Bash(sleep:*)"]}},
               hook=ev_is("Stop", background_tasks=lambda b: any(t.get("status") == "running" for t in (b or []))), tr=None),
    "C6": dict(title="Claude subagent permission", show=PERM, timeout=90,
               prompt='Use the Agent tool to launch one general-purpose subagent whose task is: use the Bash tool to run exactly "touch {f}". Do nothing else yourself.',
               hook=ev_is("PermissionRequest", agent_id=lambda a: bool(a)), tr=None),
}


CODEX_ARGS = ["-a", "on-request", "-s", "read-only", "-c", 'approvals_reviewer="user"']  # always ask the user, never the auto reviewer


def tr_codex(word):
    return lambda line: '"type":"function_call"' in line.replace(" ", "") and word in line


CODEX_ROWS = {
    "X1": dict(title="Codex permission", agent="codex", prompt="Run the shell command: touch {f}",
               show=r"Would you like to run the following command", hook=ev_is("PermissionRequest", tool_name="Bash"), tr=tr_codex("touch")),
    "X2": dict(title="Codex question panel", agent="codex", show=r"Question 1/1", extra_args=["--enable", "default_mode_request_user_input"],
               prompt='Use the request_user_input tool to ask me one question: "red or blue?" with the options red and blue. Do nothing else.',
               hook=ev_is("PreToolUse", tool_name="request_user_input"), tr=tr_codex("request_user_input")),
    "X3": dict(title="Codex folder trust", agent="codex", prompt=None, show=r"Trust this folder\?", untrusted="git", hook=None, tr=None),
}
ALL_ROWS = dict(CLAUDE_ROWS, **CODEX_ROWS)
READY = {"claude": r"❯ +Try|manual mode on|for shortcuts", "codex": r"Ask Codex to do anything"}


def launch(agent, d, sock, sink, cwd, row=None, block=0):
    hook = f"{sys.executable} -I {HERE}/hook.py {sock} {sink}"
    if agent == "codex":
        argv = codex_argv(hook, cwd, bypass_trust=True, extra=CODEX_ARGS + (row or {}).get("extra_args", []), block=block)
    else:
        st = claude_settings(d + "/settings.json", hook, (row or {}).get("extra"))
        if block:
            cfg = json.load(open(st))
            for g in cfg["hooks"]["PermissionRequest"]:
                for h in g["hooks"]:
                    h["command"] += f" {block}"
            json.dump(cfg, open(st, "w"))
        argv = ["claude", "--model", "haiku", "--settings", st, "--permission-mode", "default"]
    return Session(argv, cwd, clean_env(), log=d + "/pty.log")


def transcript_watch(sink, stop, hits, pred):
    path, pos = None, 0
    while not stop.is_set():
        if path is None:
            for l in open(sink):
                try:
                    p = json.loads(json.loads(l).get("payload") or "{}")
                except ValueError:
                    continue
                path = p.get("transcript_path") or path
        if path and os.path.exists(path):
            with open(path) as f:
                f.seek(pos)
                data = f.read()
                pos = f.tell()
            for line in data.splitlines():
                if pred(line) and "t" not in hits:
                    hits["t"] = time.time()
        time.sleep(0.05)


def run_row(row_id, n, outdir):
    row = ALL_ROWS[row_id]
    agent = row.get("agent", "claude")
    d = os.path.join(outdir, f"{row_id}-{n}")
    os.makedirs(d, exist_ok=True)
    sock = sock_path()
    sink, evf = d + "/sink.jsonl", d + "/events.jsonl"
    for f in (sink, evf):
        open(f, "w").close()
    cwd = os.path.join(UNTRUSTED_ROOT, f"{row_id}-{n}-{uuid.uuid4().hex[:6]}") if row.get("untrusted") else TRUSTED_CWD
    os.makedirs(cwd, exist_ok=True)
    if row.get("untrusted") == "git":
        subprocess.run(["git", "init", "-q", cwd])
    fname = f"{row_id.lower()}_{n}_{uuid.uuid4().hex[:6]}.txt"
    core = Core(sock, evf, "record")
    s = launch(agent, d, sock, sink, cwd, row)
    stop, trh = threading.Event(), {}
    if row.get("tr"):
        threading.Thread(target=transcript_watch, args=(sink, stop, trh, row["tr"]), daemon=True).start()
    res = dict(row=row_id, run=n, dir=d)
    try:
        if row["prompt"]:
            if not s.wait_for(READY[agent], 40):
                res["error"] = "no composer"
                return res
            time.sleep(1 if agent == "claude" else 4)  # codex loads hooks/plugins after the composer shows
            t_sent = time.time()
            s.type(row["prompt"].format(f=fname), submitted=lambda: any(e["event"] == "UserPromptSubmit" for e in core.read()))
        else:
            t_sent = s.t0
        t_show = s.wait_for(row["show"], row.get("timeout", 60), since=t_sent)
        res["t_detect_screen"] = time.time()  # when the polling matcher noticed, for the screen-source delay
        if t_show is None:
            res["error"] = "not elicited"
            return res
        time.sleep(1.2)
        res["screen"] = 0.0
        res["screen_delay"] = round(res["t_detect_screen"] - t_show, 3)
        if row["hook"]:
            hits = [e["t_recv"] for e in core.read() if row["hook"](e)]
            res["hook"] = round(min(hits) - t_show, 3) if hits else None
        if row.get("tr"):
            res["transcript"] = round(trh["t"] - t_show, 3) if "t" in trh else None
        res["events"] = [e["event"] for e in core.read()]
        # answer: Esc cancels a permission/question; Claude's trust dialog defaults to "No, exit" (Enter);
        # Codex's defaults to "Trust and continue", so it gets Esc ("quit")
        s.send(b"\r" if row.get("untrusted") and agent == "claude" else b"\x1b")
        time.sleep(1.5)
        res["file_created"] = os.path.exists(os.path.join(cwd, fname))
        if row.get("untrusted"):
            time.sleep(2)
            res["exited_after_no"] = not s.alive
    finally:
        stop.set()
        s.kill()
        core.kill()
        try:
            os.unlink(sock)
        except FileNotFoundError:
            pass
        if row.get("untrusted"):
            shutil.rmtree(cwd, ignore_errors=True)
    return res


def run_killed(n, outdir, agent="claude", block=20, hang=False):
    """Core killed (or, with hang, alive but never answering) while a PermissionRequest hook is blocked on it."""
    rid = ("K" if agent == "claude" else "XK") + ("H" if hang else "")
    d = os.path.join(outdir, f"{rid}-{n}")
    os.makedirs(d, exist_ok=True)
    sock = sock_path()
    sink, evf = d + "/sink.jsonl", d + "/events.jsonl"
    for f in (sink, evf):
        open(f, "w").close()
    fname = f"k_{n}_{uuid.uuid4().hex[:6]}.txt"
    core = Core(sock, evf, "hold")
    s = launch(agent, d, sock, sink, TRUSTED_CWD, block=block)
    res = dict(row=rid, run=n, dir=d)
    perm = PERM if agent == "claude" else CODEX_ROWS["X1"]["show"]
    try:
        if not s.wait_for(READY[agent], 40):
            res["error"] = "no composer"
            return res
        time.sleep(1 if agent == "claude" else 4)
        t_sent = time.time()
        s.type(f"Use the Bash tool to run exactly: touch {fname}" if agent == "claude" else f"Run the shell command: touch {fname}", submitted=lambda: any(e["event"] == "UserPromptSubmit" for e in core.read()))
        end = time.time() + 60
        while time.time() < end and not any(e["event"] == "PermissionRequest" for e in core.read()):
            time.sleep(0.05)
        if not any(e["event"] == "PermissionRequest" for e in core.read()):
            res["error"] = "not elicited"
            return res
        res["prompt_visible_while_hook_blocked"] = s.wait_for(perm, 3, since=t_sent) is not None
        t_kill = time.time()
        if not hang:
            core.kill()
        # the hook sees EOF and returns no decision; the agent must keep (or show) its own prompt
        end = time.time() + block + 5
        hook_end = None
        while time.time() < end and hook_end is None:
            for l in open(sink):
                r = json.loads(l)
                if r.get("event") == "PermissionRequest" and "t_hook_end" in r:
                    hook_end = r
            time.sleep(0.05)
        res["hook_returned_after_kill"] = round(hook_end["t_hook_end"] - t_kill, 3) if hook_end else None
        t_prompt = s.wait_for(perm, block + 15, since=t_sent)
        res["own_prompt_shown_s_after_hook_return"] = round(max(0.0, t_prompt - hook_end["t_hook_end"]), 3) if t_prompt and hook_end else None
        time.sleep(1.0)
        res["file_created_before_answer"] = os.path.exists(os.path.join(TRUSTED_CWD, fname))
        # core restart: the item is still on screen (screen state restores it; the persisted queue is ticket 03)
        if not hang:
            core.start()
        res["restored_from_screen_on_core_start"] = bool(re.search(perm, s.text_since(t_kill - 30)))
        # prove the agent's own prompt is live: answer "1. Yes" (this time only); the file appears only now
        s.send(b"1" if agent == "claude" else b"y")
        t1 = time.time()
        while time.time() < t1 + 15 and not os.path.exists(os.path.join(TRUSTED_CWD, fname)):
            time.sleep(0.1)
        res["own_prompt_after_hook"] = os.path.exists(os.path.join(TRUSTED_CWD, fname))
        res["file_created"] = res["file_created_before_answer"]
    finally:
        s.kill()
        core.kill()
        for p in (sock, os.path.join(TRUSTED_CWD, fname)):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
    return res


BOUND = 1.0  # seconds, spec Acceptance 1


def screen_only(row_id):
    row = ALL_ROWS.get(row_id)
    return bool(row) and not (row["hook"] or row["tr"])


def source_times(r):
    """Seconds relative to t_show per source that could be the listener's; None when it never saw it."""
    if screen_only(r["row"]):
        return {"screen": r.get("screen_delay")}
    return {k: r.get(k) for k in ("hook", "transcript")}


def caught(r):
    return any(t is not None and t <= BOUND for t in source_times(r).values())


def passed(r):
    if r.get("error"):
        return None
    if r["row"] in ("K", "XK", "KH", "XKH"):
        return bool(r.get("hook_returned_after_kill") is not None and r.get("own_prompt_after_hook")
                    and r.get("file_created") is False and r.get("restored_from_screen_on_core_start"))
    return caught(r) and r.get("file_created") is False  # "no auto-approve" is its own condition; absent = unknown


def rescore(paths):
    """Recompute `pass` over saved results.jsonl files (no agent is started)."""
    out = []
    for path in paths:
        for l in open(path):
            if l.strip():
                r = json.loads(l)
                if "row" in r:
                    r["pass"] = passed(r)
                else:
                    r.update(row="?", problem=f"{path}: record without a row key", **{"pass": False})
                out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--par", type=int, default=4)
    ap.add_argument("--rows", default="C1,C2,C3,C4,C5,C6,K")
    ap.add_argument("--block", type=int, default=20, help="seconds a PermissionRequest hook waits for the core")
    ap.add_argument("--rescore", nargs="+", metavar="RESULTS", help="re-score saved results.jsonl files and print the table")
    ap.add_argument("--out", default=os.path.join(OUT, "matrix-" + time.strftime("%Y%m%d-%H%M%S")))
    a = ap.parse_args()
    if a.rescore:
        results = rescore(a.rescore)
        for r in results:
            if r.get("problem"):
                print("problem:", r["problem"])
        summary(results, [r for r in ALL_ROWS if any(x["row"] == r for x in results)] + sorted({x["row"] for x in results} - set(ALL_ROWS)))
        return
    a.out = os.path.abspath(a.out)
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(TRUSTED_CWD, exist_ok=True)
    rows = a.rows.split(",")
    before = snapshot()
    results, lock = [], threading.Lock()

    def job(row_id, n):
        for attempt in range(3):  # retry only "not elicited" / startup errors
            if row_id in ("K", "XK", "KH", "XKH"):
                r = run_killed(f"{n}.{attempt}", a.out, "claude" if row_id.startswith("K") else "codex",
                               block=a.block, hang=row_id.endswith("H"))
            else:
                r = run_row(row_id, f"{n}.{attempt}", a.out)
            if not r.get("error"):
                break
        r["pass"] = passed(r)
        with lock:
            results.append(r)
            open(os.path.join(a.out, "results.jsonl"), "a").write(json.dumps(r) + "\n")
        print(json.dumps({k: v for k, v in r.items() if k not in ("dir", "events")}), flush=True)

    with ThreadPoolExecutor(a.par) as ex:
        for n in range(a.runs):
            for row_id in rows:
                ex.submit(job, row_id, n)
    problems, foreign = guard_check(before, snapshot(), [TRUSTED_CWD, UNTRUSTED_ROOT, HERE])
    summary(results, rows)
    print("guard problems:", problems or "none")
    print("foreign changes (not by this harness):", foreign or "none")
    json.dump({"problems": problems, "foreign": foreign}, open(os.path.join(a.out, "guard.json"), "w"))
    sys.exit(1 if problems else 0)


def summary(results, rows):
    titles = dict({k: v["title"] for k, v in ALL_ROWS.items()}, K="Core killed mid-permission (Claude)",
                  XK="Core killed mid-permission (Codex)",
                  KH="Core hung mid-permission (Claude)", XKH="Core hung mid-permission (Codex)")
    print(f"\n| Row | Pass | Not elicited | hook <=1s | transcript <=1s | screen-only <=1s | hook p50/max s | screen delay max s |")
    print("|---|---|---|---|---|---|---|---|")
    for rid in rows:
        rs = [r for r in results if r["row"] == rid]
        ok = [r for r in rs if r.get("pass")]
        el = [r for r in rs if r.get("pass") is not None]
        ne = [r for r in rs if r.get("error")]
        hk = sorted(r["hook"] for r in el if r.get("hook") is not None)
        f = lambda k: sum(1 for r in el if r.get(k) is not None and r[k] <= BOUND)
        hs = f"{hk[len(hk) // 2]:.2f}/{hk[-1]:.2f}" if hk else "-"
        so = screen_only(rid)
        sd = [r["screen_delay"] for r in el if r.get("screen_delay") is not None]
        sdm = f"{max(sd):.3f}" if sd else "-"
        print(f"| {rid} {titles.get(rid, rid)}{' (screen-only)' if so else ''} | {len(ok)}/{len(el)} | {len(ne)} | "
              f"{'-' if so else f('hook')} | {'-' if so else f('transcript')} | {f('screen_delay') if so else '-'} | {hs} | {sdm} |")


if __name__ == "__main__":
    main()
