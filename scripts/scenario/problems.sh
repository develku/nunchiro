#!/bin/sh
# V2-5b problem card scenario (`problem_cases_from_fixtures`): one sub-case per listed case, each from its fixture
# (crates/nunchiro-core/tests/fixtures/problems/), through a real `nunchiro serve` with fake agents on PATH. Each
# sub-case checks the card (case, cause, Details redacted) and runs its fix through the core calls the window makes.
# The window's own parts (Open install page, Restart core's reload, the band's place) are in
# web/tests/problem-card.spec.ts. Also: a running session never gets a card from its screen, and the hook-less start
# still detects waiting. SUBCASES (space separated) picks rows; exit 1 on any failure. No real agent runs here.
set -eu
cd "$(dirname "$0")/../.."
[ -x target/debug/nunchiro ] || { echo "Build first: cargo build --workspace" >&2; exit 2; }
exec python3 -B - "$@" <<'PY'
import json, os, shutil, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env

root = Path.cwd()
binary = root / "target/debug/nunchiro"
fixtures = root / "crates/nunchiro-core/tests/fixtures/problems"
SECRET = "sk-ant-api03-FAKEfakeFAKEfake0000-notreal"
OAUTH = "https://claude.ai/oauth/authorize?code=true&client_id=FAKE"

# One fake for claude and codex: `--version`; then the bytes of $PWD/screen (or $NUNCHIRO_HOME/screen-<kind>), then
# wait while $PWD/hold exists; exit with $PWD/code (0). `auth login` (a login tab) just waits.
FAKE = r'''#!/bin/sh
k=$(basename "$0")
[ "$1" = --version ] && { [ "$k" = codex ] && echo 'codex-cli 0.161.0' || echo '2.1.310 (Claude Code)'; exit 0; }
[ "$1" = auth ] || [ "$1" = login ] && { echo login; sleep 30; exit 0; }
echo "LAUNCH $*" >> "$NUNCHIRO_HOME/launch-$NUNCHIRO_SESSION.log"
f="$PWD/screen"; [ -f "$f" ] || f="$NUNCHIRO_HOME/screen-$k"
[ -f "$f" ] && cat "$f"
while [ -e "$PWD/hold" ]; do sleep 0.05; done
exit "$(cat "$PWD/code" 2>/dev/null || echo 0)"
'''
# v1a-06 fake transport: "down" refuses like ssh does, "old" answers a version mismatch, else the local relay.
SSH = '''#!/bin/sh
[ -e "$NUNCHIRO_FAKE_REMOTE_HOME/down" ] && { echo "ssh: connect to host fake port 22: Connection refused" >&2; exit 255; }
[ -e "$NUNCHIRO_FAKE_REMOTE_HOME/old" ] && { echo "remote protocol version mismatch" >&2; exit 1; }
exec "$FAKE_SSH" "$@"
'''

class Core:
    def __init__(self, tag, path_bin=True, before=None):
        self.home = root / ".scratch/pb" / tag
        shutil.rmtree(self.home, ignore_errors=True)
        (self.home / "bin").mkdir(parents=True)
        (self.home / "remote").mkdir()
        if path_bin:
            for name in ("claude", "codex"):
                (self.home / "bin" / name).write_text(FAKE)
                (self.home / "bin" / name).chmod(0o700)
        (self.home / "bin/ssh").write_text(SSH)
        (self.home / "bin/ssh").chmod(0o700)
        if before:
            before(self.home)
        self.env = clean_env({"NUNCHIRO_HOME": str(self.home), "PATH": f"{self.home / 'bin'}:/usr/bin:/bin",
                              "CODEX_HOME": str(self.home / "codex-home"), "CLAUDE_CONFIG_DIR": str(self.home / "claude-home"),
                              "HOME": str(self.home / "sentinel"), "NUNCHIRO_SSH": str(self.home / "bin/ssh"),
                              "FAKE_SSH": str(root / "scripts/scenario/fake-ssh"), "NUNCHIRO_BIN": str(binary),
                              "NUNCHIRO_FAKE_REMOTE_HOME": str(self.home / "remote")})
        self.spawn()

    def spawn(self):
        self.log = open(self.home / "core.log", "a")
        self.proc = subprocess.Popen([str(binary), "serve"], env=self.env, stdin=subprocess.DEVNULL,
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

    def cli(self, *args):
        return subprocess.run([str(binary), *args], env=self.env, capture_output=True, text=True, timeout=60)

    def project(self, name, screen=None, code=None, hold=False):
        p = self.home / "p" / name
        p.mkdir(parents=True, exist_ok=True)
        if screen is not None:
            (p / "screen").write_bytes(screen)
        if code is not None:
            (p / "code").write_text(str(code))
        if hold:
            (p / "hold").write_text("")
        return p.resolve()

    def start(self, kind, project, label="p"):
        return self.call({"op": "start", "session": {"kind": kind, "project": str(project), "label": label,
                                                     "model": None, "effort": None, "resume": None}})["session"]

    def session(self, sid, request=None):
        return next((s for s in self.call(request or {"op": "snapshot"})["sessions"] if s["id"] == sid), None)

    def ended(self, sid):
        return self.wait(lambda: (s := self.session(sid)) and s["state"] != "running" and s)

    def wait(self, f, secs=20):
        end = time.time() + secs
        while time.time() < end:
            v = f()
            if v:
                return v
            time.sleep(0.1)
        return None

    def close(self):
        self.ok({"op": "stop"})
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


class Skip(Exception):
    pass


def fx(name):
    return (fixtures / name).read_bytes()


def check(cond, what):
    if not cond:
        raise AssertionError(what)


def card(s, case):
    p = (s or {}).get("problem") or {}
    check(p.get("case") == case, f"want {case}, got {s}")
    for secret in (SECRET, "client_id", "oauth"):
        check(secret not in p.get("details", ""), f"Details leaks {secret}: {p}")
    check("account" not in p.get("cause", "").lower(), f"a card names another account: {p}")
    return p


def not_installed():
    c = Core("ni", path_bin=False)
    try:
        s = c.start("claude", c.project("a"))
        p = card(s, "not_installed")
        check(s["state"] == "failed" and "claude is not on PATH" in p["cause"], s)
        # Fix: Open install page, in the window (problem-card.spec). The core's part: the row is a failed tab.
        check(c.session(s["id"])["state"] == "failed", "the failed row is gone")
    finally:
        c.close()


def logged_out():
    c = Core("lo")
    try:
        screen = fx("logged-out-claude.bin") + f"\r\n{OAUTH}\r\nkey {SECRET}\r\n".encode()
        s = c.ended(c.start("claude", c.project("a", screen=screen))["id"])
        card(s, "logged_out")
        # Fix: Log in, the V2-2a login tab (an account's own folder and the agent's own login).
        added = c.call({"op": "account_add", "agent": "claude", "label": "Claude login"})
        check(added["session"]["kind"] == "shell" and added["session"]["state"] == "running", added)
    finally:
        c.close()


def usage_limit():
    c = Core("ul")
    try:
        s = c.ended(c.start("codex", c.project("a", screen=fx("usage-limit-codex.bin"), code=1))["id"])
        p = card(s, "usage_limit")
        check(p.get("reset") == "2:20 PM" and "Resets 2:20 PM per Codex" in p["cause"], p)
        # Fix: Switch agent (V2-3b), never another account: the handoff starts Claude in the same folder.
        switched = c.call({"op": "handoff_send", "from": s["id"], "to": "claude", "text": "go on"})
        check(switched["session"]["kind"] == "claude", switched)
    finally:
        c.close()


def hook_trust():
    c = Core("ht")
    try:
        project = c.project("a", screen=fx("hook-trust-codex.bin"), code=2)
        s = c.ended(c.start("codex", project)["id"])
        card(s, "hook_trust")
        # Fix: Start without Nunchiro hooks. The next run shows Codex's approval overlay; waiting is still found.
        (project / "screen").write_bytes((root / "crates/nunchiro-core/tests/fixtures/codex-approval/0.161.0-synthetic-frame.txt")
                                         .read_text().split("=== own\n", 1)[1].split("\n===", 1)[0].replace("\n", "\r\n").encode())
        (project / "code").write_text("0")
        (project / "hold").write_text("")
        n = c.call({"op": "problem_fix", "id": s["id"], "fix": "start_without_hooks"})["session"]
        check(n.get("without_hooks") is True, n)
        launch = (c.home / f"launch-{n['id']}.log").read_text() if c.wait(lambda: (c.home / f"launch-{n['id']}.log").exists()) else ""
        check(launch and "hook" not in launch, f"hooks still injected: {launch}")
        waiting = c.wait(lambda: (x := c.session(n["id"])) and (x["attention"]["waiting"] or x["pending"]) and x)
        check(waiting, f"waiting not detected without hooks: {c.session(n['id'])}")
        (project / "hold").unlink()
    finally:
        c.close()


def machine():
    c = Core("ma")
    try:
        r = c.call({"op": "remote", "machine": "fake", "request": {"op": "start", "session": {
            "kind": "shell", "project": "/tmp", "label": "r", "args": ["/bin/cat"]}}})
        sid = r["session"]["id"]
        check(c.wait(lambda: (s := c.session(sid)) and s.get("machine") == "fake"), "remote row never shown")
        for flag, case in (("down", "machine_unreachable"), ("old", "version_mismatch")):
            (c.home / "remote" / flag).write_text("")
            s = c.wait(lambda: (x := c.session(sid)) and (x.get("problem") or {}).get("case") == case and x)
            card(s or c.session(sid), case)
            # Fix: Retry / Machine status: the status names the cause; once the machine answers, the card goes.
            status = c.call({"op": "machine_status", "label": "fake"})["machines"][0]
            check(status["status"] == ("unreachable" if flag == "down" else "version_mismatch"), status)
            (c.home / "remote" / flag).unlink()
            check(c.wait(lambda: (x := c.session(sid)) and not x.get("problem")), "the card stayed after Retry")
        c.ok({"op": "remote", "machine": "fake", "request": {"op": "close", "id": sid}})
        c.ok({"op": "remote", "machine": "fake", "request": {"op": "stop"}})
    finally:
        c.close()


def folder_permission():
    c = Core("fp")
    project = c.project("locked", hold=True)
    try:
        project.chmod(0o100)
        s = c.start("claude", project)
        s = c.wait(lambda: (x := c.session(s["id"])) and x.get("problem") and x)
        card(s, "folder_permission")
        check(s["state"] == "running", "the agent keeps running")
        # Fix: the V1A-33 guidance (Open Settings, then the window's close and start); the start works once allowed.
        project.chmod(0o700)
        (project / "hold").unlink()
        c.call({"op": "close", "id": s["id"]})
        (project / "hold").write_text("")
        n = c.start("claude", project)
        time.sleep(3)  # past the folder probe's bound (v1a-33 PROBE_BOUND, 2 s)
        check((x := c.session(n["id"])) and x["state"] == "running" and not x.get("problem"), f"restart: {x}")
        (project / "hold").unlink()
    finally:
        project.chmod(0o700)
        c.close()


def core_unreachable():
    c = Core("cu")
    try:
        s = c.start("claude", c.project("a", hold=True))
        # Fix: Restart core (`serve restart`): the agent keeps running and the next core reattaches it.
        out = c.cli("serve", "restart")
        check(out.returncode == 0, out.stderr)
        check(c.wait(lambda: (x := c.ok({"op": "snapshot"})) and any(r["id"] == s["id"] and r["state"] == "running" for r in x["sessions"])),
              "the session did not survive Restart core")
        (Path(s["project"]) / "hold").unlink()
    finally:
        c.close()


def holder_after_update():
    # An older-protocol holder needs a past build; its card comes from V2-1b's holder_status, which
    # problems::tests::kept_and_machine_cards and sessions::reattach_tests drive. Not run here.
    raise Skip("an older holder needs a past build (covered by cargo test kept_and_machine_cards, reattach_tests)")


def set_aside():
    c = Core("sa", before=lambda h: (h / "sessions.json").write_text('{"version": 99, "sessions": []}'))
    try:
        snap = c.call({"op": "snapshot"})
        p = (snap.get("problem") or {})
        check(p.get("case") == "set_aside", snap)
        # The notice stays until the owner removes the set-aside file; then the next core shows none.
        for f in c.home.glob("sessions.json.v99.*.aside"):
            f.unlink()
        c.close()
        c.spawn()
        check("problem" not in c.call({"op": "snapshot"}), "the notice stayed after removal")
    finally:
        c.close()


def generic():
    c = Core("ge")
    try:
        project = c.project("a", screen=fx("unknown-exit.bin"), code=3)
        s = c.ended(c.start("claude", project)["id"])
        p = card(s, "unexpected")
        check(p["cause"] == "Session ended unexpectedly (exit code 3).", p)
        (project / "code").write_text("0")
        n = c.call({"op": "problem_fix", "id": s["id"], "fix": "restart"})["session"]
        check(n["project"] == s["project"] and c.session(s["id"])["state"] == "closed", n)
    finally:
        c.close()


def running_never_restart():
    c = Core("rn")
    try:
        project = c.project("a", screen=fx("crafted-running.bin"), hold=True)
        s = c.start("codex", project)
        time.sleep(1)
        x = c.session(s["id"])
        check(x["state"] == "running" and not x.get("problem"), f"a running session got a card: {x}")
        for fix in ("restart", "start_without_hooks"):
            try:
                c.call({"op": "problem_fix", "id": s["id"], "fix": fix})
                check(False, f"{fix} ran on a working session")
            except RuntimeError as e:
                check("only an ended session" in str(e), e)
        (project / "hold").unlink()
    finally:
        c.close()


ROWS = [not_installed, logged_out, usage_limit, hook_trust, machine, folder_permission, core_unreachable,
        holder_after_update, set_aside, generic, running_never_restart]
pick = os.environ.get("SUBCASES", "").split()
failed = 0
for row in ROWS:
    if pick and row.__name__ not in pick:
        continue
    try:
        row()
        print(f"PASS {row.__name__}")
    except Skip as e:
        print(f"SKIP {row.__name__}: {e}")
    except Exception as e:
        failed += 1
        print(f"FAIL {row.__name__}: {e}")
print(f"problem_cases_from_fixtures: {'FAIL' if failed else 'PASS'} ({failed} failed)")
sys.exit(1 if failed else 0)
PY
