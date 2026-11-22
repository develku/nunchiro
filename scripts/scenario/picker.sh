#!/bin/sh
# Model and effort picker scenario (ticket 10). Rows: launch-flags, claude-switch, codex-switch; RUNS (default 5)
# runs each. Default AGENTS=fake: the fixtures in crates/nunchiro/tests/fixtures stand in for claude and codex
# (coordinator ruling 2026-10-25 01:57: tests use fake agents). AGENTS=real uses the installed agents with the
# cheapest models (claude haiku -> sonnet -> haiku; codex gpt-5.6-luna) and skips Codex without quota headroom.
# Every row runs between two snapshots of the user's agent config (lib.py guard); exit 1 on any failure.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B - "$@" <<'PY'
import hashlib, json, os, re, shutil, socket, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import TRUSTED_CWD, clean_env, guard_check, snapshot

root = Path.cwd()
binary = root / "target/debug/nunchiro"
if not binary.is_file():
    raise SystemExit("Build first: cargo build --workspace")
runs = int(os.environ.get("RUNS", 5))
real = os.environ.get("AGENTS", "fake") == "real"
out = root / ".scratch/receipts" / ("picker-" + time.strftime("%Y%m%d-%H%M%S"))
out.mkdir(parents=True)
fixtures = root / "crates/nunchiro/tests/fixtures"
codex_ok = True
if real:
    usage = subprocess.run([os.path.expanduser("~/.agents/policies/usage.sh")], capture_output=True, text=True).stdout
    line = next((l for l in usage.splitlines() if l.startswith("codex .codex ")), "")
    codex_ok = bool(re.findall(r"5h (\d+)%", line)) and all(int(p) < 100 for p in re.findall(r"(?:5h|7d) (\d+)%", line))
    (out / "usage.txt").write_text(usage)
CLAUDE = ("haiku", "sonnet")
CODEX = ("gpt-5.6-luna", "gpt-6-luna")


class Core:
    def __init__(self, tag):
        # Short home: the core socket path must stay under 104 bytes.
        self.home = root / ".scratch/pk" / tag
        shutil.rmtree(self.home, ignore_errors=True)
        (self.home / "bin").mkdir(parents=True)
        path = os.environ["PATH"]
        if not real:
            (self.home / "codex-home").mkdir()
            shutil.copy(fixtures / "claude-picker", self.home / "bin/claude")
            shutil.copy(fixtures / "codex-picker", self.home / "bin/codex")
            path = f"{self.home / 'bin'}:/usr/bin:/bin"
        env = clean_env({"NUNCHIRO_HOME": str(self.home), "PATH": path})
        if not real:
            env["CODEX_HOME"] = str(self.home / "codex-home")
        # A real Claude asks to trust a new folder; ticket 01's scratch cwd is already trusted.
        self.project = Path(TRUSTED_CWD) if real else self.home / "project"
        self.project.mkdir(exist_ok=True)
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

    def session(self, sid):
        return next((s for s in self.call({"op": "snapshot"})["sessions"] if s["id"] == sid), None)

    def screen(self, sid):
        return self.call({"op": "agent_read", "id": sid, "source": "screen", "lines": 60})["text"]

    def wait(self, f, secs=60):
        end = time.time() + secs
        while time.time() < end:
            v = f()
            if v:
                return v
            time.sleep(0.2)
        return None

    def start(self, kind, model, effort):
        return self.call({"op": "start", "session": {"kind": kind, "project": str(self.project), "label": "picker",
                                                      "model": model, "effort": effort, "resume": None}})["session"]

    def switch(self, sid, model, effort):
        return self.call({"op": "switch_model", "id": sid, "model": model, "effort": effort})

    def switch_lines(self):
        return [l for l in (self.home / "core.log").read_text().splitlines() if l.startswith("switch session=")]

    def close(self):
        try:
            self.call({"op": "stop"})
        except Exception:
            pass
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def ps_args(pid, want=""):
    # Right after exec, ps can still show "(python3.9)": wait up to 5 s for the argv that is expected.
    end = time.time() + 5
    while True:
        args = subprocess.run(["/bin/ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if want in args or time.time() > end:
            return args
        time.sleep(0.1)


def prompt(core, sid):
    return core.wait(lambda: "❯" in core.screen(sid) and not core.session(sid)["attention"]["working"], 90)


def claude_switch(core, sid, model, effort):
    send = core.switch(sid, model, effort)["send"]["id"]
    status = core.wait(lambda: next((r["status"] for r in core.session(sid)["send_log"] if r["id"] == send
                                     and r["status"] in ("delivered", "failed")), None), 30)
    return status, core.screen(sid)


def launch_flags(core):
    c = core.start("claude", CLAUDE[0], "low")
    x = core.start("codex", CODEX[0], "low") if codex_ok else None
    ca = ps_args(c["pid"], "--model")
    ok = f"--model {CLAUDE[0]} --effort low" in ca
    detail = {"claude_args": ca}
    if x:
        xa = ps_args(x["pid"], "-m ")
        detail["codex_args"] = xa
        ok = ok and f'-m {CODEX[0]} -c model_reasoning_effort="low"' in xa
    for s in (c, x):
        if s:
            core.call({"op": "close", "id": s["id"]})
    return ok, detail


def claude_row(core):
    s = core.start("claude", CLAUDE[0], None)
    if not prompt(core, s["id"]):
        return False, {"error": "no prompt", "screen": core.screen(s["id"])[-800:]}
    status, screen = claude_switch(core, s["id"], CLAUDE[1], "low")
    confirmed = "for this session only" in screen
    if real:  # read the agent's own status after the switch
        core.call({"op": "send_text", "id": s["id"], "text": "/status"})
        time.sleep(0.3)
        core.call({"op": "send_keys", "id": s["id"], "keys": ["enter"]})
        shown = core.wait(lambda: re.search(r"Model:\s*\S*" + CLAUDE[1], core.screen(s["id"]), re.I), 20) is not None
        core.call({"op": "send_keys", "id": s["id"], "keys": ["esc"]})
        prompt(core, s["id"])
    else:
        shown = f"MODEL:{CLAUDE[1].capitalize()} EFFORT:low" in screen
    back, _ = claude_switch(core, s["id"], CLAUDE[0], None)
    meta = core.session(s["id"])
    core.call({"op": "close", "id": s["id"]})
    lines = core.switch_lines()
    ok = status == "delivered" and confirmed and shown and back == "delivered" and meta["model"] == CLAUDE[0] and len(lines) == 2
    return ok, {"first": status, "confirmed": confirmed, "status_shows": shown, "back": back, "switch_lines": lines}


def codex_row(core):
    if not codex_ok:
        return None, {"note": "not run: Codex quota shows no headroom"}
    s = core.start("codex", CODEX[0], "low")
    sid = core.wait(lambda: core.session(s["id"])["agent_session_id"], 90)
    if not sid or (real and not prompt(core, s["id"])):
        return False, {"error": "no conversation id or prompt"}
    new = core.switch(s["id"], CODEX[1], "medium")["session"]
    args = ps_args(new["pid"], "resume")
    ok = f'resume {sid} -m {CODEX[1]} -c model_reasoning_effort="medium"' in args and core.session(s["id"]) is None
    status = core.wait(lambda: CODEX[1] in core.screen(new["id"]), 60) is not None if real else True
    core.call({"op": "close", "id": new["id"]})
    return ok and status, {"args": args, "status_line_shows_model": status, "switch_lines": core.switch_lines()}


ROWS = [("launch-flags", launch_flags), ("claude-switch", claude_row), ("codex-switch", codex_row)]
table, failed = [], False
for name, row in ROWS:
    for n in range(1, runs + 1):
        before = snapshot()
        core = Core(f"{name[:2]}{n}")
        try:
            ok, detail = row(core)
        except Exception as e:  # a failed row still runs the guard
            ok, detail = False, {"error": repr(e)}
        finally:
            core.close()
        problems, foreign = guard_check(before, snapshot(), ours=(str(core.home),))
        shutil.copy(core.home / "core.log", out / f"{name}-{n}.core.log")
        ok = ok if not problems else False
        failed |= ok is False
        table.append({"row": name, "run": n, "pass": ok, "guard_problems": problems, "foreign": foreign, **detail})
        print(f"{name:14} run {n}: {'not run' if ok is None else 'pass' if ok else 'FAIL'}"
              + (f"  guard: {problems}" if problems else ""), flush=True)
(out / "result.json").write_text(json.dumps({"agents": "real" if real else "fake", "runs": table}, indent=1))
print(f"agents={'real' if real else 'fake'} receipts={out}")
sys.exit(1 if failed else 0)
PY
