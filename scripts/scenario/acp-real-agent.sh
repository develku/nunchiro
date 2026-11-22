#!/bin/sh
# V2-4b scenario `acp_real_agent_turn`: one ACP agent set up the way the sheet does it (add the entry, run the check, approve
# the hash the core returned), a turn that edits a file, and the chat showing the edit as a diff card event (`kind: edit`,
# the card the chat view draws) with the file really written inside the project folder.
#
# With no arguments it runs against the fake ACP agent (crates/nunchiro-core/tests/fixtures/acp/fake_agent.py), which
# proves the script. THE REAL RUN IS OWNER'S (the row stays "pending the owner" until then). With a real agent the owner has (Gemini CLI,
# OpenCode, goose):
#   1. Settings > Agents > Set up… on its row, read the checks and the approval scope, press "Approve and add"
#      (this is the human step; the script below repeats it through the same core requests on a TEST home only).
#   2. Run:  ACP_AGENT_COMMAND=/abs/path/to/gemini ACP_AGENT_ARGS="--experimental-acp" ACP_AGENT_ENV=GEMINI_API_KEY \
#            sh scripts/scenario/acp-real-agent.sh
#      Needs the agent signed in already (its own login, or the env names above set in this shell). The core runs on a home
#      under the system temp dir (never ~/.nunchiro); each permission request of the agent is answered "allow once".
#   3. In the window (your own session), start the same agent in a project, ask it to create a file, and look for the diff
#      card in the chat; tick the roadmap row only after you saw it.
# ACP_PROMPT overrides the prompt. Exit 1 on any failure; the receipt is printed. Build first: cargo build -p nunchiro.
set -eu
cd "$(dirname "$0")/../.."
[ -x target/debug/nunchiro ] || { echo "Build first: cargo build -p nunchiro" >&2; exit 2; }
exec python3 -B - "$@" <<'PY'
import json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env

root = Path.cwd()
binary = root / "target/debug/nunchiro"
fake = root / "crates/nunchiro-core/tests/fixtures/acp/fake_agent.py"
real = os.environ.get("ACP_AGENT_COMMAND")
# The core home sits under the system temp dir so core.sock fits macOS sun_path from any checkout.
home = Path(tempfile.gettempdir()).resolve() / f"ns-acp-real-{os.getpid()}"
# The project is outside the core's home: an ACP agent's file requests never reach the home.
project = root / ".scratch/acp-real-project"
for d in (home, project):
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
git = lambda *a: subprocess.run(["git", "-C", str(project), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a], check=True, capture_output=True, text=True)
git("init", "-q", "-b", "main")
git("commit", "-q", "--allow-empty", "-m", "init")
# Only the env NAMES the agent may see are passed on; their values come from this shell (never written anywhere).
names = os.environ.get("ACP_AGENT_ENV", "").split()
base = {"NUNCHIRO_HOME": str(home), "PATH": "/usr/bin:/bin", "HOME": str(home / "sentinel"), "CODEX_HOME": str(home / "codex-home"),
        "CLAUDE_CONFIG_DIR": str(home / "claude-home")}
env = clean_env({**base, **{n: os.environ[n] for n in names if n in os.environ}})
if real:
    env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")  # a real agent is usually a script that needs its interpreter
log = open(home / "core.log", "a")
proc = subprocess.Popen([str(binary), "serve"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)


def call(request, secs=30):
    token = (home / "core.token").read_text()
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(secs)
        s.connect(str(home / "core.sock"))
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


def wait(f, secs, what):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = f()
        except (OSError, RuntimeError, ValueError):
            v = None
        if v:
            return v
        time.sleep(0.2)
    raise SystemExit(f"FAIL: {what}")


try:
    wait(lambda: call({"op": "snapshot"}), 15, "core did not start")
    if real:
        entry = {"name": "real", "command": real, "args": os.environ.get("ACP_AGENT_ARGS", "").split(), "env": names}
        prompt = os.environ.get("ACP_PROMPT", "Create a file named hello.txt in this folder containing the word hello, then stop.")
    else:
        entry = {"name": "real", "command": "/usr/bin/python3", "args": [str(fake), str(home / "agent.log")], "env": []}
        prompt = f"edit:{project}/hello.txt"
    # The sheet: check first (before any approval), then add, then approve exactly the hash the add returned.
    checked = call({"op": "acp_agent_check", "entry": entry}, 40)
    print("check:", json.dumps({k: checked[k] for k in ("found_path", "version", "acp_v1_ms", "capabilities", "signed_in", "error")}))
    if checked.get("acp_v1_ms") is None or checked.get("signed_in") is False:
        raise SystemExit("FAIL: the check did not pass; fix the command or sign the agent in first")
    view = call({"op": "acp_agent_add", "entry": entry})["view"]
    call({"op": "acp_agent_grant", "name": "real", "hash": view["hash"]})
    session = call({"op": "start", "session": {"kind": "acp", "project": str(project), "args": ["real"], "model": None, "effort": None, "resume": None}})["session"]
    sid = session["id"]
    # The prompt goes once the agent finished its handshake.
    wait(lambda: call({"op": "agent_prompt", "id": sid, "text": prompt}) or True, 60, "the agent never became ready for a prompt")
    answered = []

    def turn_done():
        s = next(x for x in call({"op": "snapshot"})["sessions"] if x["id"] == sid)
        for item in s.get("pending", []):
            if item["id"] not in answered:
                answered.append(item["id"])
                call({"op": "answer", "item": item["id"], "answer": {"type": "allow_once"}, "confirmed": True})
        if s["state"] == "failed":
            raise SystemExit(f"FAIL: the session failed: {s.get('problem')}")
        return s["attention"]["completion_seq"] >= 1 and not s.get("pending")

    wait(turn_done, 240 if real else 40, "the turn did not finish")
    events = [e["data"] for e in call({"op": "chat_page", "id": sid})["page"]["events"]]
    edits = [e for e in events if e.get("kind") == "edit"]
    changed = git("status", "--porcelain").stdout.split()
    print("answered permission requests:", len(answered))
    print("diff card events:", json.dumps(edits))
    print("files changed in the project:", changed)
    if not edits:
        raise SystemExit("FAIL: the chat shows no edit (diff card) event")
    if not changed:
        raise SystemExit("FAIL: no file changed in the project folder")
    if not real:
        assert (project / "hello.txt").read_text() == "hello\nworld\n", "the fake agent's file is not as written"
    print("acp_real_agent_turn:", "PASS (real agent; the owner still looks at the window's diff card)" if real else "PASS (fake agent)")
finally:
    try:
        call({"op": "stop"})
    except Exception:
        pass
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
PY
