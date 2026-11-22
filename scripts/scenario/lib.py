"""Throwaway PTY harness for ticket 01 (PTY-path check). Python stdlib only.

Drives the user's real `claude` / `codex` in a PTY, keeps a timestamped output log,
and exposes a crude screen-text view (escape sequences stripped) for screen-state matching.
"""
import difflib, fcntl, hashlib, json, os, pty, re, select, signal, struct, subprocess, sys, termios, threading, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, ".scratch", "v1a-01")
HOME = os.path.expanduser("~")
# Trusted by inheritance from ~ (Claude) so no trust dialog is answered;
# an untrusted cwd is used only by the folder-trust rows, which answer "No".
TRUSTED_CWD = os.path.join(HOME, "Library/Caches/nunchiro-v1a01-cwd")  # outside any repo: no CLAUDE.md import dialog

CLAUDE_JSON = ".claude.json"
# Order kept for callers that index it: settings.json, .claude.json, config.toml.
REQUIRED = (".claude/settings.json", CLAUDE_JSON, ".codex/config.toml")  # missing or unreadable = guard problem
OPTIONAL = (".claude/settings.local.json", ".codex/hooks.json")  # absent is fine if it was absent before
GUARDED = [os.path.join(HOME, p) for p in REQUIRED + OPTIONAL]
RETRY_WAIT = 0.5  # another process may be mid-write; one retry rides that out


def sock_path(prefix="nv1a"):
    return f"/private/tmp/{prefix}-{uuid.uuid4().hex[:8]}.sock"  # unix socket paths are limited to 104 bytes


# Env from the parent herdr/Claude session must not leak into scenario agents
# (herdr's user hook would report them as this pane).
SCRUB = re.compile(r"^(HERDR_|CLAUDE|CODEX_|AI_AGENT|AGENT_BACKEND|ANTHROPIC_)")


def clean_env(extra=None):
    env = {k: v for k, v in os.environ.items() if not SCRUB.match(k)}
    env["TERM"] = "xterm-256color"
    env["NUNCHIRO_LOGIN_PATH"] = "off"  # ticket 576: a test core keeps the PATH it is given (/etc/zprofile adds /opt/homebrew/bin)
    env.setdefault("NUNCHIRO_KEYCHAIN", "")  # ticket 457: a real-HOME core keeps no start secrets in the login keychain
    env.update(extra or {})
    return env


def sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError:
        return None


def _claude_json(text):
    """Validated ~/.claude.json: (trust flags, top-level keys). Raises ValueError on a wrong shape."""
    cj = json.loads(text)
    projects = cj.get("projects", {}) if isinstance(cj, dict) else None
    if not isinstance(projects, dict) or not all(isinstance(v, dict) for v in projects.values()):
        raise ValueError("unexpected shape")
    return {k: v.get("hasTrustDialogAccepted") for k, v in projects.items()}, sorted(cj)


def _read(path, parse=None):
    """(bytes, parsed, error). One read gives both hash and text; a failed read or parse is retried once."""
    err = None
    for attempt in range(2):
        try:
            with open(path, "rb") as f:
                data = f.read()
            return data, parse(data.decode(errors="replace")) if parse else None, None
        except FileNotFoundError:
            return None, None, "missing"
        except Exception as e:  # noqa: BLE001 - unreadable, half-written, or wrong-shaped
            err = f"{type(e).__name__}: {e}"
            if attempt == 0:
                time.sleep(RETRY_WAIT)
    return None, None, err


def snapshot(home=HOME):
    """Guard state of the user's agent config. Never raises: a missing required file, or any file that
    is unreadable or (for .claude.json) wrong-shaped, is recorded in snap["error"] ({path: reason}) and
    guard_check turns it into a problem (fail closed). `home` is for tests only."""
    snap = {"text": {}, "error": {}}
    for rel in REQUIRED + OPTIONAL:
        p = os.path.join(home, rel)
        data, parsed, err = _read(p, _claude_json if rel == CLAUDE_JSON else None)
        snap[p] = hashlib.sha256(data).hexdigest() if data is not None else None
        if rel != CLAUDE_JSON:
            snap["text"][p] = data.decode(errors="replace") if data is not None else ""
        if err and not (err == "missing" and rel in OPTIONAL):
            snap["error"][p] = err
        if parsed:
            snap["claude.json:trust"], snap["claude.json:keys"] = parsed
    return snap


def guard_check(before, after, ours=()):
    """Returns (problems, foreign_changes).

    Fails closed: a required file that is missing or unreadable (before or after) is a problem.
    settings.json, settings.local.json and hooks.json must not change at all. This host also runs the
    ChatGPT/Codex app and other agents that rewrite config.toml and ~/.claude.json, so config.toml is
    diffed: a change that mentions one of `ours` (scenario cwds, hook paths) or a trust grant is a
    problem; the rest is reported as foreign (written by a process this harness did not start).
    """
    problems, foreign = [], []
    for when, snap in (("before", before), ("after", after)):
        problems += [f"{p}: guard cannot read it ({when}): {e}" for p, e in snap.get("error", {}).items()]
    for p in before["text"]:
        if before[p] == after.get(p):
            continue
        diff = [l for l in difflib.unified_diff(before["text"][p].splitlines(), after["text"].get(p, "").splitlines(), lineterm="", n=0)
                if l[:1] in "+-" and not l.startswith(("+++", "---"))]
        mine = [l for l in diff if any(o in l for o in ours) or "trusted_hash" in l or "hooks" in l]
        (problems if mine or os.path.basename(p) != "config.toml" else foreign).append(f"{p}: {mine or diff[:6] or 'presence or bytes changed'}")
    bt, at = before.get("claude.json:trust", {}), after.get("claude.json:trust", {})
    for k, v in at.items():
        if v and not bt.get(k):
            (problems if any(o in k for o in ours) else foreign).append(f"~/.claude.json trust granted: {k}")
    new_keys = set(after.get("claude.json:keys", [])) - set(before.get("claude.json:keys", []))
    if new_keys:
        foreign.append(f"~/.claude.json new top-level keys: {sorted(new_keys)}")
    return problems, foreign


ESC = re.compile(rb"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]")


def visible(raw: bytes) -> str:
    # shortcut: no real VT emulation; cursor moves become spaces, so text split across moves still
    # matches with \s+. Upgrade to a real emulator (xterm headless / alacritty_terminal) in ticket 03.
    t = ESC.sub(b" ", raw).decode("utf-8", "replace")
    return re.sub(r"[ \t\r\x00-\x08\x0b-\x1f]+", " ", t)


class Session:
    def __init__(self, argv, cwd, env, cols=160, rows=50, log=None):
        self.argv, self.t0 = argv, time.time()
        self.chunks = []  # (t, bytes)
        self.lock = threading.Lock()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.log = open(log, "wb") if log else None
        self.alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while self.alive:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.2)
                if not r:
                    continue
                b = os.read(self.fd, 65536)
            except OSError:
                break
            if not b:
                break
            now = time.time()
            with self.lock:
                self.chunks.append((now, b))
            if self.log:
                self.log.write(b)
                self.log.flush()
            # answer cursor-position / device-attribute queries so TUIs do not stall
            if b"\x1b[6n" in b:
                self.send(b"\x1b[1;1R")
            if b"\x1b[c" in b or b"\x1b[0c" in b:
                self.send(b"\x1b[?62;22c")
        self.alive = False

    def send(self, data):
        if isinstance(data, str):
            data = data.encode()
        try:
            os.write(self.fd, data)
        except OSError:
            pass

    def type(self, text, enter=True, submitted=None):
        """Bracketed paste, then Enter on its own (a burst ending in \\r is taken as pasted text).
        `submitted()` returning False after 1.5 s re-sends Enter, at most 3 times."""
        self.send(b"\x1b[200~" + text.encode() + b"\x1b[201~")
        if not enter:
            return
        for _ in range(3):
            time.sleep(0.8)
            self.send(b"\r")
            if submitted is None:
                return
            time.sleep(1.5)
            if submitted():
                return

    def text_since(self, t=0.0, tail=200_000):
        with self.lock:
            raw = b"".join(b for ts, b in self.chunks if ts >= t)
        return visible(raw[-tail:])

    def wait_for(self, pattern, timeout, since=0.0):
        """Time of the first output chunk after which `pattern` matches the output since `since`."""
        rx = re.compile(pattern, re.I | re.S)
        end, i, acc = time.time() + timeout, 0, b""
        while True:
            with self.lock:
                new = [c for c in self.chunks if c[0] >= since][i:]
            for ts, b in new:
                acc += b
                i += 1
                if rx.search(visible(acc[-200_000:])):
                    return ts
            if time.time() > end or (not self.alive and not new):
                return None
            time.sleep(0.05)

    def kill(self):
        kids = descendants(self.pid)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                break
            for _ in range(20):
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.1)
            else:
                continue
            break
        self.alive = False
        for p in kids + descendants(self.pid):  # only descendants of our own pid
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def descendants(pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout
    kids = {}
    for line in out.split("\n"):
        if line.strip():
            p, pp = map(int, line.split())
            kids.setdefault(pp, []).append(p)
    res, stack = [], [pid]
    while stack:
        for k in kids.get(stack.pop(), []):
            res.append(k)
            stack.append(k)
    return res


class Core:
    """The listener: core_stub.py as a separate process so it can be SIGKILLed mid-permission."""

    def __init__(self, sock, events, mode="record"):
        self.sock, self.events, self.mode = sock, events, mode
        self.start()

    def start(self):
        self.p = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "core_stub.py"), self.sock, self.events, self.mode])
        for _ in range(50):
            if os.path.exists(self.sock):
                return
            time.sleep(0.05)

    def kill(self):
        self.p.kill()
        self.p.wait()

    def read(self):
        try:
            return [json.loads(l) for l in open(self.events) if l.strip()]
        except FileNotFoundError:
            return []


def claude_settings(path, hook_cmd, extra=None):
    """Per-session --settings file: every hook event goes to hook.py; nothing touches ~/.claude."""
    events = ["PermissionRequest", "Notification", "Stop", "SubagentStop", "PreToolUse", "PostToolUse",
              "UserPromptSubmit", "SessionStart", "SubagentStart"]
    hooks = {}
    for e in events:
        h = {"type": "command", "command": f"{hook_cmd} {e}", "timeout": 30}
        hooks[e] = [{"matcher": "*", "hooks": [h]}] if e in ("PreToolUse", "PostToolUse", "PermissionRequest") else [{"hooks": [h]}]
    s = {"hooks": hooks}
    s.update(extra or {})
    json.dump(s, open(path, "w"), indent=1)
    return path


CODEX_EVENTS = ["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop",
                "SubagentStart", "SubagentStop"]
CODEX_MODEL = "gpt-5.6-luna"  # cheapest listed by `codex debug models` (0.161.0): "Older fast and efficient model"


def codex_argv(hook_cmd, cwd=None, trust_cwd=False, bypass_trust=False, extra=(), block=0):
    """Per-session Codex hooks as `-c hooks.<Event>=[...]` overrides; nothing is written to ~/.codex."""
    a = ["codex", "--no-daemon", "-m", CODEX_MODEL, "-c", 'model_reasoning_effort="low"']
    for e in CODEX_EVENTS:
        a += ["-c", f'hooks.{e}=[{{hooks=[{{type="command",command="{hook_cmd} {e}{f" {block}" if block and e == "PermissionRequest" else ""}",timeout=30}}]}}]']
    if trust_cwd and cwd:
        a += ["-c", f'projects."{cwd}".trust_level="trusted"']
    if bypass_trust:
        a.append("--dangerously-bypass-hook-trust")
    return a + list(extra)
