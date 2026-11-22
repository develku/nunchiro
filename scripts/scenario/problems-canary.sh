#!/bin/sh
# V2-5b nightly canary (`problem_real_not_installed_logged_out`): the real `claude` and `codex` give their cards.
#   not installed: a core whose PATH has neither agent: Start gives a failed tab with the not_installed card.
#   logged out: a core whose PATH has the real agent and a fresh CLAUDE_CONFIG_DIR / CODEX_HOME and HOME (under
#   .scratch): the agent shows its own sign-in screen; Ctrl-C ends it and the card is logged_out.
# An agent that is not installed on this Mac is skipped with a printed reason. One agent runs at a time, for a few
# seconds; the user's ~/.claude and ~/.codex are snapshotted before and after (lib.py guard). Exit 1 on any failure.
set -eu
cd "$(dirname "$0")/../.."
[ -x target/debug/nunchiro ] || { echo "Build first: cargo build --workspace" >&2; exit 2; }
exec python3 -B - "$@" <<'PY'
import json, os, shutil, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env, guard_check, snapshot

root = Path.cwd()
binary = root / "target/debug/nunchiro"
real = {k: shutil.which(k) for k in ("claude", "codex")}


class Core:
    def __init__(self, tag, path):
        self.home = root / ".scratch/pc" / tag
        shutil.rmtree(self.home, ignore_errors=True)
        for d in ("project", "sentinel", "claude-home", "codex-home"):
            (self.home / d).mkdir(parents=True)
        env = clean_env({"NUNCHIRO_HOME": str(self.home), "PATH": path, "HOME": str(self.home / "sentinel"),
                         "CLAUDE_CONFIG_DIR": str(self.home / "claude-home"), "CODEX_HOME": str(self.home / "codex-home")})
        self.log = open(self.home / "core.log", "w")
        self.proc = subprocess.Popen([str(binary), "serve"], env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=self.log)
        if not self.wait(lambda: self.ok({"op": "snapshot"}), 15):
            raise SystemExit("core did not start")

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

    def session(self, sid):
        return next((s for s in self.call({"op": "snapshot"})["sessions"] if s["id"] == sid), None)

    def screen(self, sid):
        return self.ok({"op": "agent_read", "id": sid, "source": "screen", "lines": 60}) or {}

    def wait(self, f, secs=20):
        end = time.time() + secs
        while time.time() < end:
            v = f()
            if v:
                return v
            time.sleep(0.2)
        return None

    def start(self, kind):
        return self.call({"op": "start", "session": {"kind": kind, "project": str(self.home / "project"), "label": "canary",
                                                     "model": None, "effort": None, "resume": None}})["session"]

    def close(self):
        self.ok({"op": "stop"})
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def not_installed(kind):
    c = Core(f"ni-{kind}", "/usr/bin:/bin")
    try:
        s = c.start(kind)
        p = s.get("problem") or {}
        assert s["state"] == "failed" and p.get("case") == "not_installed", s
    finally:
        c.close()


SIGNIN = {"claude": "Select login method", "codex": "Sign in with ChatGPT"}


def logged_out(kind):
    c = Core(f"lo-{kind}", f"{Path(real[kind]).parent}:/usr/bin:/bin")
    try:
        sid = c.start(kind)["id"]
        text = lambda: (c.screen(sid).get("text") or "")
        # Claude asks for a theme first; Enter takes the default and shows its sign-in choice.
        if kind == "claude" and c.wait(lambda: "text style" in text(), 30):
            c.call({"op": "send_keys", "id": sid, "keys": ["enter"]})
        c.wait(lambda: SIGNIN[kind] in text(), 30)
        for _ in range(3):
            c.ok({"op": "send_keys", "id": sid, "keys": ["ctrl+c"]})
            time.sleep(0.3)
        s = c.wait(lambda: (x := c.session(sid)) and x["state"] != "running" and x, 30)
        assert s, f"{kind} did not exit on Ctrl-C; screen: {text()[-400:]}"
        p = s.get("problem") or {}
        assert p.get("case") == "logged_out", f"{s}; screen: {text()[-400:]}"
        assert "oauth" not in p.get("details", "").lower(), p
    finally:
        c.close()


before = snapshot()
failed = 0
for kind in ("claude", "codex"):
    for row in (not_installed, logged_out):
        name = f"{row.__name__}_{kind}"
        if row is logged_out and not real[kind]:
            print(f"SKIP {name}: {kind} is not on this Mac's PATH")
            continue
        try:
            row(kind)
            print(f"PASS {name}")
        except Exception as e:
            failed += 1
            print(f"FAIL {name}: {e}")
problems, foreign = guard_check(before, snapshot())
for p in problems:
    failed += 1
    print(f"FAIL guard: {p}")
for f in foreign:
    print(f"note: foreign config change: {f}")
print(f"problem_real_not_installed_logged_out: {'FAIL' if failed else 'PASS'} ({failed} failed)")
sys.exit(1 if failed else 0)
PY
