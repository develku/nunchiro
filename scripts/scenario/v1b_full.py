"""Ticket v1b-25, spec Acceptance 15: every v1b path with real agents, and the user's agent config unchanged.

Run through scripts/scenario/v1b-full.sh. Each chained scenario script runs as its own sub-process (its inner guard
kept); the outer guard here decides Acceptance 15: lib.snapshot()/guard_check plus a manifest of config-like files
under ~/.claude and ~/.codex (an allowlist: both CLIs write transcripts, caches and history on every turn).
"""
import fcntl, fnmatch, hashlib, json, os, pathlib, re, shutil, signal, socket, subprocess, sys, threading, time, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402

ROOTS = (".claude", ".codex")
TOP_FILES = re.compile(r"^(settings.*\.json|hooks.*|config\.toml|CLAUDE\.md|AGENTS\.md)$")
TOP_DIRS = re.compile(r"^(hooks.*|rules|skills|plugins|agents|commands)$")
# Agent-owned paths inside the manifest dirs, relative to home, one glob per path segment (`*` never crosses a `/`).
# Anchored so a config file that merely says "cache" or "log" (hooks/cache-guard.sh, skills/s/cache/) stays in.
EXCLUDED_PATHS = (
    ".claude/plugins/cache", ".codex/plugins/cache",  # installed plugin copies, rewritten by the CLIs
    ".claude/plugins/plugin-catalog-cache.json", ".claude/plugins/plugin-directory-cache-v2.json",
    ".claude/plugins/marketplaces/*/.git", ".codex/plugins/.marketplace-plugin-source-staging/*/.git",  # clone metadata
    # claude.ai skill/plugin sync round ids that Claude Code rewrites at startup (ruling v1b-25 r2).
    ".claude/plugins/synced/*/.last-complete-round", ".claude/skills/synced/*/.last-complete-round",
    # claude.ai sync bookkeeping, changed 2 s after a Claude start in receipt r1 (ruling manifest-ruling-2); the rest of synced/* stays hashed.
    ".claude/plugins/synced/*/.marketplaces.json",
)
# Marketplace auto-update stamps every startup; hashed without `lastUpdated` so an added or removed marketplace still shows.
MARKETPLACES = os.path.join(".claude", "plugins", "known_marketplaces.json")
EXCLUDED = ("everything outside settings*.json, hooks*, config.toml, CLAUDE.md, AGENTS.md, rules, skills, plugins, agents, "
            "commands (so projects/**, sessions/**, history.jsonl, todos/**, shell-snapshots/**, logs and caches at the top level)",
            "~/.claude.json keys other than projects.*.hasTrustDialogAccepted",
            ".claude/plugins/cache/**, .codex/plugins/cache/** (installed plugin copies)",
            ".claude/plugins/plugin-catalog-cache.json, plugin-directory-cache-v2.json (catalog caches)",
            ".claude/plugins/marketplaces/*/.git/**, .codex/plugins/.marketplace-plugin-source-staging/*/.git/** (clone metadata)",
            ".claude/plugins|skills/synced/*/.last-complete-round (Claude Code sync round ids, rewritten at startup)",
            ".claude/plugins/synced/*/.marketplaces.json (Claude Code's claude.ai sync bookkeeping, changed 2 s after a Claude start in receipt r1; other synced/* files and all skill content stay hashed)",
            "lastUpdated fields of .claude/plugins/known_marketplaces.json (auto-update stamps; adds and removes still count)")


def excluded(rel):
    parts = rel.split(os.sep)
    return any(len(parts) == len(g) and all(fnmatch.fnmatchcase(a, b) for a, b in zip(parts, g))
               for g in (x.split("/") for x in EXCLUDED_PATHS))


TRUST = ".claude.json:trust:"


def _hash(path):
    if os.path.islink(path):
        return "link:" + os.readlink(path)  # the link is the config; its target is not under ~/.claude
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError as e:
        return f"ERROR: {type(e).__name__}: {e.strerror}"
    return h.hexdigest()


def _marketplaces(text):
    data = json.loads(text)
    if not isinstance(data, dict) or not all(isinstance(v, dict) for v in data.values()):
        raise ValueError("unexpected shape")
    return {k: {kk: vv for kk, vv in v.items() if kk != "lastUpdated"} for k, v in data.items()}


def manifest(home=lib.HOME):
    """{path relative to home: sha256} of every config-like file, plus one entry per ~/.claude.json trust flag.
    An unreadable file is recorded as "ERROR: ..." and manifest_diff turns it into a problem (fail closed)."""
    out = {}
    for root in ROOTS:
        base = os.path.join(home, root)
        try:
            names = sorted(os.listdir(base))
        except OSError:
            continue
        for name in names:
            top = os.path.join(base, name)
            if os.path.isdir(top) and not os.path.islink(top):
                if not TOP_DIRS.match(name):
                    continue
                for d, dirs, files in os.walk(top):
                    dirs[:] = sorted(x for x in dirs if not os.path.islink(os.path.join(d, x)) and not excluded(os.path.relpath(os.path.join(d, x), home)))
                    dirs_links = [x for x in os.listdir(d) if os.path.islink(os.path.join(d, x)) and os.path.isdir(os.path.join(d, x))]
                    for f in sorted(files + dirs_links):
                        p = os.path.join(d, f)
                        rel = os.path.relpath(p, home)
                        if not excluded(rel):
                            out[rel] = _hash(p)
                            if rel == MARKETPLACES and not os.path.islink(p):
                                _, parsed, err = lib._read(p, _marketplaces)
                                out[rel] = "ERROR: " + err if err else hashlib.sha256(json.dumps(parsed, sort_keys=True).encode()).hexdigest()
            elif TOP_FILES.match(name):
                out[os.path.join(root, name)] = _hash(top)
    data, trust, err = lib._read(os.path.join(home, lib.CLAUDE_JSON), lib._claude_json)
    if err and err != "missing":
        out[TRUST] = "ERROR: " + err
    for project, flag in (trust[0] if trust else {}).items():
        out[TRUST + project] = str(bool(flag))
    return out


def manifest_diff(before, after, ours):
    """(problems, foreign). Any added, removed or changed manifest file is a problem, except config.toml (diffed by
    lib.guard_check, which tells ours from foreign) and trust flags (granted to one of `ours` = problem, else foreign:
    the user's Claude Code app and other agents on this host write ~/.claude.json)."""
    problems, foreign = [], []
    for when, snap in (("before", before), ("after", after)):
        problems += [f"{k}: unreadable ({when}): {v}" for k, v in snap.items() if v.startswith("ERROR")]
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k), after.get(k)
        if b == a or (b or "").startswith("ERROR") or (a or "").startswith("ERROR"):
            continue
        what = "added" if b is None else "removed" if a is None else "changed"
        if k.startswith(TRUST):
            project = k[len(TRUST):]
            (problems if a == "True" and any(o in project for o in ours) else foreign).append(f"~/.claude.json trust {what}: {project} {b} -> {a}")
        elif os.path.basename(k) == "config.toml":
            foreign.append(f"{k} {what} (diffed by the v1a guard: a change naming our paths or trust is a problem there)")
        else:
            problems.append(f"{k} {what}")
    return problems, foreign


def aggregate(rows, problems):
    """(ok, table lines). ok only when no config problem, at least one row ran, and every row that ran passed."""
    ran = [r for r in rows if r["status"] != "not run"]
    ok = not problems and bool(ran) and all(r["status"] == "pass" for r in ran)
    lines = [f"{'row':<20} {'result':<8} {'runs':<5} detail"]
    for r in rows:
        lines.append(f"{r['name']:<20} {r['status']:<8} {r.get('runs', '-')!s:<5} {r.get('error') or r.get('why') or ''}".rstrip())
    lines.append(f"{'v1b-full: config unchanged':<20} {'pass' if not problems else 'FAIL'}   1     {'; '.join(problems)[:400]}".rstrip())
    skipped = [r["name"] for r in rows if r["status"] == "not run"]
    if skipped:
        lines.append("not run: " + ", ".join(skipped))
    return ok, lines


def _ps():
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,lstart="], capture_output=True, text=True).stdout
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            table[int(parts[0])] = (int(parts[1]), parts[2])
    return table


def _tree(root, table):
    kids = {}
    for pid, (ppid, _) in table.items():
        kids.setdefault(ppid, []).append(pid)
    res, stack = [], [root]
    while stack:
        for k in kids.get(stack.pop(), []):
            res.append(k)
            stack.append(k)
    return res


def run_row(name, cmd, env, log, cwd=None, timeout=45 * 60, needs=()):
    """Runs one scenario step. Fails closed on a missing script; fails when any process it started (polled every
    0.5 s, matched by pid and start time) is still alive 3 s after it exits; those processes are then stopped."""
    row = {"name": name, "cmd": cmd, "status": "FAIL", "leftover_pids": []}
    missing = [p for p in (needs or ([cmd[-1]] if cmd[-1].endswith((".sh", ".py")) else [])) if not os.path.exists(p)]
    if missing:
        row["error"] = "script missing: " + ", ".join(missing)
        return row
    seen, done = {}, threading.Event()
    with open(log, "wb") as out:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)

        def poll():
            while not done.is_set():
                table = _ps()
                seen.update({pid: table[pid][1] for pid in _tree(p.pid, table)})
                done.wait(0.5)
        t = threading.Thread(target=poll, daemon=True)
        t.start()
        try:
            row["exit"] = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            row["error"] = f"timed out after {timeout} s"
            os.killpg(p.pid, signal.SIGKILL)
            row["exit"] = p.wait()
        done.set()
        t.join()
    for _ in range(30):
        table = _ps()
        left = [pid for pid, start in seen.items() if table.get(pid, (0, None))[1] == start]
        if not left:
            break
        time.sleep(0.1)
    row["leftover_pids"] = left
    for pid in left:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    text = pathlib.Path(log).read_text(errors="replace")
    if re.search(r"trust dialog|Do you trust the files|Is this a project you created or one you trust", text):
        row["error"] = row.get("error") or "trust dialog shown (never answered)"
    elif left:
        row["error"] = row.get("error") or f"left processes behind: {left}"
    elif row["exit"] != 0:
        tail = text.strip().splitlines() or ["(no output)"]
        row["error"] = row.get("error") or next((l for l in reversed(tail) if re.search(r"\d+ failed|FAIL|Error", l)), tail[-1]).strip()[:300]
    else:
        row["status"] = "pass"
    return row


def lock(path):
    """An exclusive lock held for the life of the process, or None when another run holds it."""
    f = open(path, "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f


def headroom():
    """Codex 5h and 7d usage below 95% on the default home, from the shared usage script; unknown counts as none."""
    try:
        text = subprocess.run(["bash", os.path.expanduser("~/.agents/policies/usage.sh")], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return False, "usage.sh failed"
    line = next((l for l in text.splitlines() if l.startswith("codex .codex")), "")
    m = re.search(r"5h (\d+)%", line)
    # the weekly window empties too: a 7d at 100 % fails every turn even with 5h at 0 %
    used = [int(p) for p in re.findall(r"(?:5h|7d) (\d+)%", line)]
    return (bool(m) and all(p < 95 for p in used)), line.strip() or "no codex line"


def chat_codex(root):
    """Row chat-codex: one Codex turn (cheapest model, read-only sandbox) in a Nunchiro session; the chat page the
    window renders (owner API chat_page, the same page the window's `chat` frame returns) carries the user prompt
    and the assistant reply. Trust is a -c override for this run only; no dialog is ever answered."""
    binary = str(root / "target/debug/nunchiro")
    tag = uuid.uuid4().hex[:5]
    home = lib.scenario_home("x" + tag)
    project = home / "project"
    project.mkdir()
    env = lib.clean_env({"NUNCHIRO_HOME": str(home)})
    for key in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION"):
        env.pop(key, None)

    def cli(*args):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
        if p.returncode:
            raise RuntimeError(p.stderr.strip() or p.stdout.strip())
        return json.loads(p.stdout) if p.stdout.strip() else {}

    def ask(request):
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(home / "core.sock"))
            s.settimeout(20)
            s.sendall((json.dumps({"token": (home / "core.token").read_text().strip(), "request": request}) + "\n").encode())
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        r = json.loads(buf)
        if "Err" in r:
            raise RuntimeError(f"{request['op']}: {r['Err']}")
        return r["Ok"]

    word = "NUNCHIRO_CODEX_CHAT_" + tag.upper()
    core = None
    try:
        with open(home / "core.log", "wb") as log:
            core = subprocess.Popen([binary, "serve"], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        until = time.monotonic() + 10
        while not (home / "core.token").exists() or not (home / "core.sock").exists():
            if core.poll() is not None or time.monotonic() > until:
                raise RuntimeError("core did not start")
            time.sleep(0.05)
        s = cli("session", "start", "--kind", "codex", "--project", str(project), "--model", lib.CODEX_MODEL, "--effort", "low",
                "--label", "chat-codex", "--", "-s", "read-only", "-c", f'projects."{project}".trust_level="trusted"')["session"]
        until = time.monotonic() + 100
        while True:
            text = lib.visible(bytes(cli("session", "read", s["id"])["data"]))
            if re.search(r"Do you trust the files|Trust this folder\?|Is this a project you created or one you trust", text):
                raise RuntimeError("trust dialog shown (never answered)")
            if re.search(r"Ask Codex to do anything|% context left|context left", text, re.I):
                break
            if time.monotonic() > until:
                raise RuntimeError("agent not ready: " + text[-300:])
            time.sleep(0.2)
        time.sleep(4)
        cli("session", "send-text", s["id"], f"\x1b[200~Reply exactly {word}. Do not use tools.\x1b[201~")
        time.sleep(0.8)
        cli("session", "send-keys", s["id"], "enter")
        until = time.monotonic() + 180
        while True:
            events = json.dumps(ask({"op": "chat_page", "id": s["id"], "before": None, "after": None}))
            page = json.loads(events)
            msgs = [e for e in _walk(page) if e.get("kind") == "message" and word in str(e.get("text"))]
            roles = {m.get("role") for m in msgs}
            if {"user", "assistant"} <= roles:
                print(json.dumps({"row": "chat-codex", "pass": True, "session": s["id"], "events": len(page.get("events", []))}))
                return 0
            if time.monotonic() > until:
                raise RuntimeError(f"chat page lacks the turn (roles seen with the word: {sorted(r for r in roles if r)})")
            time.sleep(1)
    except Exception as error:
        print(json.dumps({"row": "chat-codex", "pass": False, "error": str(error)}))
        return 1
    finally:
        if core is not None:
            try:
                cli("serve", "stop")
                core.wait(timeout=10)
            except Exception:
                for pid in reversed(lib.descendants(core.pid)):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if core.poll() is None:
                    core.kill()
                core.wait()
        shutil.rmtree(home, ignore_errors=True)


def _walk(x):
    if isinstance(x, dict):
        yield x
        for v in x.values():
            yield from _walk(v)
    elif isinstance(x, list):
        for v in x:
            yield from _walk(v)


def _port(want):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", int(want)))
            return want, None
        except OSError:
            holder = subprocess.run(["lsof", "-nP", f"-iTCP:{want}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True).stdout.split()
        s.bind(("127.0.0.1", 0))
        return str(s.getsockname()[1]), f"port {want} busy (holder pid {','.join(holder) or 'unknown'})"


def main(root):
    scratch = root / ".scratch"
    scratch.mkdir(exist_ok=True)
    held = lock(scratch / "v1b-full.lock")
    if held is None:
        print("v1b-full: another run holds .scratch/v1b-full.lock; refusing")
        return 2
    load = os.getloadavg()[0]
    hm = time.gmtime().tm_hour * 60 + time.gmtime().tm_min
    if load >= 15 or hm >= 23 * 60 + 30 or hm < 30 or 19 * 60 + 45 <= hm < 20 * 60 + 15:
        print(f"v1b-full: not now (1-min load {load:.1f}, {time.strftime('%H:%MZ', time.gmtime())}); rulings 05:02/05:03")
        return 2
    out = scratch / ("v1b-full-" + time.strftime("%Y%m%d-%H%M%S"))
    out.mkdir()
    print("manifest excludes (agent-owned):", "; ".join(EXCLUDED), flush=True)
    before, m_before = lib.snapshot(), manifest()
    port, port_note = _port(os.environ.get("NUNCHIRO_WEB_PORT", "4198"))
    env = {**os.environ, "RUNS": os.environ.get("RUNS", "1"), "NUNCHIRO_WEB_PORT": port}
    sc = str(root / "scripts/scenario")
    plan = [
        ("script-widget-act", [["sh", f"{sc}/v1b-script-widget.sh"], ["sh", f"{sc}/v1b-widget-act.sh"]], {}, None),
        ("web-widget-act", [["pnpm", "exec", "playwright", "test", "web-widgets.spec.ts", "--project", "chromium", "--workers", "1", "--reporter", "line"]],
         {"cwd": root / "web", "needs": [str(root / "web/tests/web-widgets.spec.ts"), str(root / "web/node_modules")]}, None),
        ("diff-card", [["sh", f"{sc}/v1b-diff.sh"]], {}, None),
        ("chat-claude", [["sh", f"{sc}/v1b-chat.sh"]], {}, None),
        ("chat-codex", [[sys.executable, "-B", f"{sc}/v1b_full.py", "chat-codex"]], {}, "codex"),
        ("images-claude", [["sh", f"{sc}/v1b-images.sh"]], {"env": {"ROWS": "claude-image"}}, None),
        ("images-codex", [["sh", f"{sc}/v1b-images.sh"]], {"env": {"ROWS": "codex-image"}}, "codex"),
        ("artifact-skill", [["sh", f"{sc}/v1b-artifact-skill.sh"]], {}, "codex-part"),
    ]
    only = os.environ.get("V1B_FULL_ROWS", "").split()
    rows, codex_line = [], "not read (no Codex row selected)"
    try:
        for name, cmds, opts, agent in plan:
            if only and name not in only:
                continue
            if agent:  # read when the row starts, as the chained scripts do
                ok_codex, codex_line = headroom()
                if agent == "codex-part":
                    opts = {"env": {"ROWS": "claude-chart codex-chart" if ok_codex else "claude-chart"}}
            if agent == "codex" and not ok_codex:
                row = {"name": name, "status": "not run", "runs": 0, "why": "no Codex headroom: " + codex_line}
            else:
                steps = [run_row(name, cmd, {**env, **opts.get("env", {})}, str(out / f"{name}-{i}.log"), cwd=opts.get("cwd"), needs=opts.get("needs", ()))
                         for i, cmd in enumerate(cmds)]
                bad = [s for s in steps if s["status"] != "pass"]
                row = {"name": name, "status": "FAIL" if bad else "pass", "runs": int(env["RUNS"]), "steps": steps,
                       "error": "; ".join(f"{os.path.basename(s['cmd'][-1])}: {s.get('error')}" for s in bad)}
                if name == "artifact-skill" and not ok_codex:
                    row["why"] = "codex-chart not run (no Codex headroom)"
            rows.append(row)
            print(json.dumps({k: row.get(k) for k in ("name", "status", "runs", "error", "why")}), flush=True)
    finally:
        after, m_after = lib.snapshot(), manifest()
        ours = [str(scratch), sc, lib.SCENARIO_HOMES, lib.TRUSTED_CWD]
        problems, foreign = lib.guard_check(before, after, ours)
        m_problems, m_foreign = manifest_diff(m_before, m_after, ours)
        problems, foreign = problems + m_problems, foreign + m_foreign
        ok, lines = aggregate(rows, problems)
        receipt = {"check": "v1b-full", "pass": ok, "rows": rows, "config_problems": problems, "foreign": foreign,
                   "manifest_files": len(m_before), "manifest_excludes": EXCLUDED, "codex_headroom": codex_line,
                   "web_port": port, "port_note": port_note, "load_at_start": load}
        (out / "result.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False))
        print("\n".join(lines))
        print(f"manifest: {len(m_before)} files and trust flags hashed; foreign changes: {foreign or 'none'}")
        print("codex headroom:", codex_line, "|", "web port:", port, port_note or "")
        print("receipt:", out / "result.json")
    return 0 if ok else 1


if __name__ == "__main__":
    here = pathlib.Path(__file__).resolve().parent.parent.parent
    sys.exit(chat_codex(here) if sys.argv[1:] == ["chat-codex"] else main(here))
