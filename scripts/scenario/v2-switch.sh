#!/bin/sh
# V2-3b agent switch scenario. Rows: switch_claude_codex_claude, switch_no_pty_write_before_enter,
# switch_pending_permission_stays; RUNS (default 3) runs each. Fake agents only (coordinator ruling 2026-10-25 01:57):
# one script stands in for claude and codex and logs every stdin read as hex, so the rows read exactly what Nunchiro
# wrote to each PTY. The window's steps map to core calls: choosing an agent fetches `handoff_preview` (nothing else);
# Esc or the chip's X drops it (no call); Enter sends `handoff_send` with the preview plus the typed message.
# Every row runs between two snapshots of the user's agent config (lib.py guard); exit 1 on any failure.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B - "$@" <<'PY'
import json, os, shutil, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env, guard_check, snapshot

root = Path.cwd()
binary = root / "target/debug/nunchiro"
if not binary.is_file():
    raise SystemExit("Build first: cargo build --workspace")
runs = int(os.environ.get("RUNS", 3))
out = root / ".scratch/receipts" / ("v2-switch-" + time.strftime("%Y%m%d-%H%M%S"))
out.mkdir(parents=True)

FAKE = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys, tty
codex = sys.argv[0].endswith('codex')
if '--version' in sys.argv:
    print('codex-cli 0.161.0' if codex else '2.1.310 (Claude Code)')
    raise SystemExit
home = os.environ['NUNCHIRO_HOME']
log = open(os.path.join(home, 'stdin-' + os.environ['NUNCHIRO_SESSION'] + '.log'), 'a')
log.write('LAUNCH ' + json.dumps(sys.argv[1:]) + '\n')
log.flush()
open(os.path.join(home, 'token-' + os.environ['NUNCHIRO_SESSION']), 'w').write(os.environ.get('NUNCHIRO_TOKEN', ''))
for arg in sys.argv[1:]:
    if codex and arg.startswith('hooks.SessionStart='):
        command = json.loads(re.search(r'command=("(?:[^"\\]|\\.)*")', arg).group(1))
        subprocess.run(command, shell=True, input=json.dumps({'session_id': 'FAKE-CODEX-' + os.environ['NUNCHIRO_SESSION'][:8]}).encode(), check=True)
tty.setraw(0)
sys.stdout.write('\x1b[2J\x1b[H' + ('› ' if codex else '❯ ') + '\r\n')
sys.stdout.flush()
while True:
    data = os.read(0, 4096)
    if not data:
        break
    log.write('READ ' + data.hex() + '\n')
    log.flush()
'''


def sent(text):
    """What the core may write for `text`: control characters but newline and tab removed, then Enter."""
    return "".join(c for c in text if c in "\n\t" or not (ord(c) < 0x20 or 0x7f <= ord(c) < 0xa0)).encode() + b"\r"


class Core:
    def __init__(self, tag):
        # Short home: the core socket path must stay under 104 bytes.
        self.home = root / ".scratch/sw" / tag
        shutil.rmtree(self.home, ignore_errors=True)
        for d in ("bin", "codex-home", "project"):
            (self.home / d).mkdir(parents=True)
        for name in ("claude", "codex"):
            (self.home / "bin" / name).write_text(FAKE)
            (self.home / "bin" / name).chmod(0o700)
        env = clean_env({"NUNCHIRO_HOME": str(self.home), "PATH": f"{self.home / 'bin'}:/usr/bin:/bin",
                         "CODEX_HOME": str(self.home / "codex-home"), "CLAUDE_CONFIG_DIR": str(self.home / "claude-home")})
        self.log = open(self.home / "core.log", "w")
        self.proc = subprocess.Popen([str(binary), "serve"], env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=self.log)
        end = time.time() + 10
        while time.time() < end:
            try:
                self.call({"op": "snapshot"})
                return
            except OSError:
                time.sleep(0.05)
        raise SystemExit("core did not start")

    def call(self, request):
        token = (self.home / "core.token").read_text()
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(20)
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

    def sessions(self):
        return self.call({"op": "snapshot"})["sessions"]

    def session(self, sid):
        return next((s for s in self.sessions() if s["id"] == sid), None)

    def written(self, sid):
        path = self.home / f"stdin-{sid}.log"
        lines = path.read_text().splitlines() if path.exists() else []
        return b"".join(bytes.fromhex(l[5:]) for l in lines if l.startswith("READ "))

    def wait(self, f, secs=30):
        end = time.time() + secs
        while time.time() < end:
            v = f()
            if v:
                return v
            time.sleep(0.1)
        return None

    def start(self, kind):
        s = self.call({"op": "start", "session": {"kind": kind, "project": str(self.home / "project"), "label": "switch",
                                                  "model": None, "effort": None, "resume": None}})["session"]
        # At its prompt: the fake drew it (a launch line is in its log).
        self.wait(lambda: (self.home / f"stdin-{s['id']}.log").exists())
        return s

    def choose(self, sid):
        """The window's pick of another agent: one preview read, nothing else."""
        return self.call({"op": "handoff_preview", "id": sid})

    def enter(self, sid, to, text):
        return self.call({"op": "handoff_send", "from": sid, "to": to, "text": text})

    def close(self):
        try:
            self.call({"op": "stop"})
        except Exception:
            pass
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def claude_codex_claude(core):
    claude = core.start("claude")
    preview = core.choose(claude["id"])
    # The typed message carries what an edited chip could: an escape sequence and a bell.
    text = preview["text"] + "\n\nnext: run the tests \x1b[31mnow\x07"
    codex = core.enter(claude["id"], "codex", text)["session"]
    got = core.wait(lambda: core.written(codex["id"]) == sent(text) or None)
    back = core.enter(codex["id"], "claude", "back to you")["session"]
    got_back = core.wait(lambda: core.written(claude["id"]) == sent("back to you") or None)
    ok = bool(got) and bool(got_back) and back["id"] == claude["id"] and codex["kind"] == "codex" \
        and codex["cwd"] == claude["cwd"] and len(core.sessions()) == 2
    return ok, {"codex_bytes": core.written(codex["id"]).decode(errors="replace"), "expected": sent(text).decode(),
                "back_id_same": back["id"] == claude["id"], "sessions": len(core.sessions())}


def no_pty_write_before_enter(core):
    claude = core.start("claude")
    before = [s["id"] for s in core.sessions()]
    core.choose(claude["id"])
    time.sleep(1)  # anything the pick could have typed has landed by now
    quiet = core.written(claude["id"]) == b"" and [s["id"] for s in core.sessions()] == before
    # Esc: the window drops the chip; no call. Still nothing.
    time.sleep(0.5)
    after_esc = core.written(claude["id"]) == b"" and [s["id"] for s in core.sessions()] == before
    codex = core.enter(claude["id"], "codex", core.choose(claude["id"])["text"])["session"]
    landed = core.wait(lambda: core.written(codex["id"]) != b"" or None)
    ok = quiet and after_esc and bool(landed) and core.written(claude["id"]) == b""
    return ok, {"bytes_before_enter": 0 if quiet else len(core.written(claude["id"])), "new_sessions_after_esc": 0 if after_esc else 1}


def pending_permission_stays(core):
    claude = core.start("claude")
    # Codex is already in the conversation, so the switch below is quick: the hook holds its answer for 1.8 s only.
    core.enter(core.enter(claude["id"], "codex", "warm up")["session"]["id"], "claude", "and back")
    # The agent's own blocking hook, as Claude runs it: it waits for the answer.
    token = core.wait(lambda: (core.home / f"token-{claude['id']}").read_text() or None)
    env = clean_env({"NUNCHIRO_HOME": str(core.home), "NUNCHIRO_SESSION": claude["id"], "NUNCHIRO_TOKEN": token})
    core.call({"op": "queue_connect"})  # a connected window: the core holds the hook for its answer
    hook = subprocess.Popen([str(binary), "hook", "PermissionRequest"], env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    hook.stdin.write(json.dumps({"tool_name": "Bash", "tool_input": {"command": "true"}}).encode())
    hook.stdin.close()
    waiting = lambda: sum(len(s["pending"]) for s in core.sessions())
    count = core.wait(waiting)
    codex = core.enter(claude["id"], "codex", "carry on")["session"]
    on_claude = core.session(claude["id"])["pending"]
    on_codex = core.session(codex["id"])["pending"]
    unchanged = waiting() == count == 1
    core.call({"op": "answer", "item": on_claude[0]["id"], "answer": {"type": "deny"}})
    try:
        answer = hook.communicate(timeout=10)[0].decode()
    except subprocess.TimeoutExpired:
        hook.kill()
        answer = ""
    answered = "deny" in answer and core.session(claude["id"])["pending"] == []
    ok = len(on_claude) == 1 and on_codex == [] and unchanged and answered
    return ok, {"claude_pending": len(on_claude), "codex_pending": len(on_codex), "waiting_before": count,
                "hook_answer_on_claude": answer.strip()[:200]}


ROWS = [("switch_claude_codex_claude", claude_codex_claude), ("switch_no_pty_write_before_enter", no_pty_write_before_enter),
        ("switch_pending_permission_stays", pending_permission_stays)]
table, failed = [], False
for i, (name, row) in enumerate(ROWS):
    for n in range(1, runs + 1):
        before = snapshot()
        core = Core(f"r{i}{n}")
        try:
            ok, detail = row(core)
        except Exception as e:  # a failed row still runs the guard
            ok, detail = False, {"error": repr(e)}
        finally:
            core.close()
        problems, foreign = guard_check(before, snapshot(), ours=(str(core.home),))
        shutil.copy(core.home / "core.log", out / f"{name}-{n}.core.log")
        ok = ok and not problems
        failed |= not ok
        table.append({"row": name, "run": n, "pass": ok, "guard_problems": problems, "foreign": foreign, **detail})
        print(f"{name:34} run {n}: {'pass' if ok else 'FAIL'}" + (f"  guard: {problems}" if problems else ""), flush=True)
        if ok:
            shutil.rmtree(core.home, ignore_errors=True)
(out / "result.json").write_text(json.dumps({"agents": "fake", "runs": table}, indent=1))
print(f"receipts={out}")
sys.exit(1 if failed else 0)
PY
