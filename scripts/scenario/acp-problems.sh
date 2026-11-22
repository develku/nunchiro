#!/bin/sh
# V2-4b scenario `acp_problems` (acp_problem_cards): one sub-case per ACP problem card, each with the fake ACP agent
# (crates/nunchiro-core/tests/fixtures/acp/fake_agent.py) through a real `nunchiro serve` on a test home under .scratch,
# never ~/.nunchiro, ~/.claude or ~/.codex. Each checks the failed session's card (case, cause, Details) and runs the
# fix's core call as the window does (the login tab); the window's own parts are in web/tests/acp-problem-card.spec.ts.
# Rows: not_installed, logged_out, no_answer, refused, changed (no card: the sheet opens), quiet (a running session never
# gets a card from what its agent prints). SUBCASES (space separated) picks rows; `--list` prints them; exit 1 on a failure.
# No real agent runs here. Build first: cargo build -p nunchiro.
set -eu
cd "$(dirname "$0")/../.."
ROWS="not_installed logged_out no_answer refused changed quiet"
[ "${1:-}" = --list ] && { echo "$ROWS"; exit 0; }
[ -x target/debug/nunchiro ] || { echo "Build first: cargo build -p nunchiro" >&2; exit 2; }
exec python3 -B - "$@" <<'PY'
import json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env

root = Path.cwd()
binary = root / "target/debug/nunchiro"
agent = root / "crates/nunchiro-core/tests/fixtures/acp/fake_agent.py"


class Core:
    def __init__(self, tag):
        # A short socket path (macOS sun_path) from any checkout: a resolved folder under the system temp dir.
        self.home = Path(tempfile.gettempdir()).resolve() / f"ns-acp-pb-{os.getpid()}" / tag
        shutil.rmtree(self.home, ignore_errors=True)
        self.home.mkdir(parents=True)
        self.env = clean_env({"NUNCHIRO_HOME": str(self.home), "PATH": "/usr/bin:/bin", "HOME": str(self.home / "sentinel"),
                              "CODEX_HOME": str(self.home / "codex-home"), "CLAUDE_CONFIG_DIR": str(self.home / "claude-home")})
        self.log = open(self.home / "core.log", "a")
        self.proc = subprocess.Popen([str(binary), "serve"], env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=self.log)
        if not self.wait(lambda: self.ok({"op": "snapshot"}), 15):
            raise SystemExit("core did not start")
        self.project = self.home / "p"
        self.project.mkdir()

    def ok(self, request):
        try:
            return self.call(request)
        except (OSError, RuntimeError, ValueError):
            return None

    def call(self, request):
        token = (self.home / "core.token").read_text()
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(30)
            s.connect(str(self.home / "core.sock"))
            s.sendall(json.dumps({"token": token, "request": request}).encode() + b"\n")
            data = b""
            while not data.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        reply = json.loads(data)
        if "Err" in reply:
            raise RuntimeError(reply["Err"])
        return reply["Ok"]

    def wait(self, f, secs=20):
        end = time.time() + secs
        while time.time() < end:
            v = f()
            if v:
                return v
            time.sleep(0.1)
        return None

    def add(self, name, command, args=(), env=()):
        """What the setup sheet does: add the entry, then approve the hash the core returned."""
        view = self.call({"op": "acp_agent_add", "entry": {"name": name, "command": command, "args": list(args), "env": list(env)}})["view"]
        self.call({"op": "acp_agent_grant", "name": name, "hash": view["hash"]})

    def fake(self, name, *modes):
        self.add(name, "/usr/bin/python3", [str(agent), str(self.home / f"{name}.log"), *modes])

    def start(self, name):
        return self.call({"op": "start", "session": {"kind": "acp", "project": str(self.project), "args": [name],
                                                     "model": None, "effort": None, "resume": None}})["session"]

    def sessions(self):
        return self.call({"op": "snapshot"})["sessions"]

    def failed(self, name):
        return self.wait(lambda: next((s for s in self.sessions() if s.get("acp_agent") == name and s["state"] == "failed"), None))

    def close(self):
        self.ok({"op": "stop"})
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def check(cond, what):
    if not cond:
        raise AssertionError(what)


def card(s, case):
    check(s is not None, f"no failed session for {case}")
    p = s.get("problem") or {}
    check(p.get("case") == case, f"want {case}, got {s}")
    check("account" not in p.get("cause", "").lower(), f"a card names an account: {p}")
    return p


def not_installed():
    c = Core("ni")
    try:
        c.add("gemini", "/nonexistent/gemini", ["--experimental-acp"], ["GEMINI_API_KEY"])
        s = c.start("gemini")  # the failed row comes back at once
        p = card(s, "not_installed")
        check(s["state"] == "failed" and p["cause"] == "Gemini CLI is not installed.", p)
        check(s["pid"] is None, s)
    finally:
        c.close()


def logged_out():
    c = Core("lo")
    try:
        c.fake("signout", "auth")
        c.start("signout")
        s = c.failed("signout")
        p = card(s, "logged_out")
        check("auth_required" in p["details"], p)
        # Fix: Log in, the agent's own command from its approved entry in a visible tab, with no arguments.
        out = c.call({"op": "acp_agent_login", "name": "signout", "project": str(c.project)})["session"]
        check(out["kind"] == "shell" and out["label"] == "Login: signout" and out["state"] == "running", out)
    finally:
        c.close()


def no_answer():
    c = Core("na")
    try:
        c.fake("mute", "v2")
        c.start("mute")
        p = card(c.failed("mute"), "acp_no_answer")
        check(p["cause"] == "mute did not answer ACP: check its command." and "ACP version" in p["details"], p)
    finally:
        c.close()


def refused():
    c = Core("rf")
    try:
        (c.home / "agents.toml").write_text('[[agent]]\nname = "cl"\ncommand = "/opt/claude-acp"\nargs = []\nenv = []\n')
        try:
            c.start("cl")
            check(False, "a Claude entry without an API key started")
        except RuntimeError as e:
            check("ANTHROPIC_API_KEY" in str(e), e)
        s = next((s for s in c.sessions() if s.get("acp_agent") == "cl"), None)
        p = card(s, "acp_refused")
        check("ANTHROPIC_API_KEY" in p["cause"] and "\n" not in p["cause"] and not p.get("details"), p)
    finally:
        c.close()


def changed():
    c = Core("ch")
    try:
        c.fake("tool")
        text = (c.home / "agents.toml").read_text()
        (c.home / "agents.toml").write_text(text.replace("args = [", 'args = ["--changed", ', 1))
        before = len(c.sessions())
        try:
            c.start("tool")
            check(False, "a changed entry started")
        except RuntimeError as e:
            check("changed since it was approved" in str(e), e)
        # No card and no row: the window opens the setup sheet.
        check(len(c.sessions()) == before, c.sessions())
    finally:
        c.close()


def quiet():
    c = Core("qu")
    try:
        c.fake("talker")
        s = c.start("talker")
        check(c.wait(lambda: next((x for x in c.sessions() if x["id"] == s["id"] and x.get("model")), None)), "no handshake")
        c.call({"op": "agent_prompt", "id": s["id"], "text": "say:auth_required: Authentication required. No such file. not found."})
        time.sleep(1)
        x = next(x for x in c.sessions() if x["id"] == s["id"])
        check(x["state"] == "running" and not x.get("problem"), f"a running ACP session got a card: {x}")
    finally:
        c.close()


ROWS = [not_installed, logged_out, no_answer, refused, changed, quiet]
pick = os.environ.get("SUBCASES", "").split()
failed = 0
for row in ROWS:
    if pick and row.__name__ not in pick:
        continue
    try:
        row()
        print(f"PASS {row.__name__}")
    except Exception as e:
        failed += 1
        print(f"FAIL {row.__name__}: {e}")
print(f"acp_problem_cards: {'FAIL' if failed else 'PASS'} ({failed} failed)")
sys.exit(1 if failed else 0)
PY
