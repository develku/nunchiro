#!/bin/sh
# Real agent turns, one per agent kind: OWNER-RUN (it uses your agents' own sign-ins and a little of each one's allowance).
# A core starts on a home under the system temp dir (never ~/.nunchiro, never the installed app). For each ACP kind of the
# bundled list (crates/nunchiro-core/src/acp/known.toml) that this Mac's PATH finds, it does what the window does: the
# check, add, approve the hash the add returned, then the test message ("Reply with the one word: ready.", confined in an
# empty folder, 60 s, every request of the agent refused). Claude and Codex run the chat rows of scripts/scenario/v1b-full.sh
# (they need target/debug/nunchiro: `cargo build -p nunchiro` with no CARGO_TARGET_DIR). A kind counts only when all three
# hold: the message was sent, an answer was read, the turn's end was seen.
#
#   sh scripts/scenario/agent-kinds.sh                 every kind found
#   sh scripts/scenario/agent-kinds.sh --only opencode,claude
#   sh scripts/scenario/agent-kinds.sh --self-test     the fake ACP agent only; its record says self_test: true and never counts
#
# Prints a table and writes docs/measure/evidence/agent-kinds-<date>.json (per kind: executable path, version, the three
# flags, ms, the failure sentence; at most 80 characters of answer; a rerun the same day merges by kind). The core binary is $NUNCHIRO_BIN, else
# ${CARGO_TARGET_DIR:-target}/debug/nunchiro. Exit 1 when a kind that ran failed.
set -eu
cd "$(dirname "$0")/../.."
bin="${NUNCHIRO_BIN:-${CARGO_TARGET_DIR:-target}/debug/nunchiro}"
[ -x "$bin" ] || { echo "Build first: cargo build -p nunchiro (looked for $bin)" >&2; exit 2; }
NUNCHIRO_BIN="$bin" exec python3 -B - "$@" <<'PY'
import datetime, json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env

args = sys.argv[1:]
self_test = "--self-test" in args
only = None
if "--only" in args:
    only = set(args[args.index("--only") + 1].split(","))
root = Path.cwd()
binary = Path(os.environ["NUNCHIRO_BIN"]).resolve()
fake = root / "crates/nunchiro-core/tests/fixtures/acp/fake_agent.py"
home = Path(tempfile.gettempdir()).resolve() / f"ns-kinds-{os.getpid()}"
shutil.rmtree(home, ignore_errors=True)
home.mkdir(parents=True)
# The agents keep their own sign-ins under the real HOME; an entry passes on only the variable names it lists.
env = clean_env({"NUNCHIRO_HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                 "HOME": os.environ.get("HOME", str(home / "sentinel"))})
if self_test:
    env["HOME"] = str(home / "sentinel")
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


def wait_core():
    end = time.time() + 15
    while time.time() < end:
        try:
            return call({"op": "snapshot"})
        except (OSError, RuntimeError, ValueError):
            time.sleep(0.2)
    raise SystemExit("FAIL: core did not start")


def acp_kind(entry):
    """The window's path for one entry: check, add, approve, test message. Returns the record row."""
    row = {"kind": entry["name"], "path": entry["command"], "version": None, "sent": False, "answer_read": False,
           "turn_end": False, "ms": None, "text": "", "failure": None}
    try:
        check = call({"op": "acp_agent_check", "entry": entry}, 40)
        row["version"] = check.get("version")
        if check.get("acp_v1_ms") is None:
            row["failure"] = "check: " + (check.get("error") or "no ACP answer")
            return row
        view = call({"op": "acp_agent_add", "entry": entry})["view"]
        call({"op": "acp_agent_grant", "name": entry["name"], "hash": view["hash"]})
        turn = call({"op": "acp_agent_try", "name": entry["name"]}, 90)["turn"]
        row.update({k: turn[k] for k in ("sent", "answer_read", "turn_end", "ms", "text")})
        row["version"] = turn.get("version") or row["version"]
        if turn.get("failure"):
            row["failure"] = f"{turn['failure']}: {turn.get('error') or ''}".strip()
    except (OSError, RuntimeError, ValueError) as e:
        row["failure"] = str(e)[:200]
    return row


def terminal_kind(agent):
    """Claude and Codex: the chat row of v1b-full (a message goes in, the answer shows, the turn's end is read)."""
    path = shutil.which(agent)
    row = {"kind": agent, "path": path, "version": None, "sent": False, "answer_read": False, "turn_end": False,
           "ms": None, "text": "", "failure": None}
    try:
        row["version"] = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()[:80] or None
    except (OSError, subprocess.TimeoutExpired):
        pass
    began = time.time()
    out = subprocess.run([sys.executable, "-B", "scripts/scenario/v1b_full.py"], capture_output=True, text=True,
                         env={**os.environ, "V1B_FULL_ROWS": f"chat-{agent}"}, timeout=900)
    row["ms"] = int((time.time() - began) * 1000)
    tail = (out.stdout + out.stderr).strip().splitlines()[-3:]
    if out.returncode == 0 and "not run" not in " ".join(tail):
        row.update(sent=True, answer_read=True, turn_end=True)
    else:
        row["failure"] = " / ".join(tail)[-200:] or f"exit {out.returncode}"
    return row


rows, skipped = [], []
try:
    wait_core()
    if self_test:
        entries = [{"name": "fake", "command": "/usr/bin/python3", "args": [str(fake), str(home / "agent.log")], "env": []}]
        terminal = []
    else:
        listed = call({"op": "acp_agents"})["acp"]
        entries = []
        for r in listed:
            if r["source"] != "known" or not r["acp"] or (only and r["name"] not in only):
                continue
            if not r.get("found_path"):
                skipped.append((r["name"], "not installed"))
                continue
            entries.append({"name": r["name"], "command": r["found_path"], "args": r["args"], "env": r["env"]})
        terminal = [a for a in ("claude", "codex") if not only or a in only]
    for entry in entries:
        rows.append(acp_kind(entry))
    for agent in terminal:
        if shutil.which(agent):
            rows.append(terminal_kind(agent))
        else:
            skipped.append((agent, "not installed"))
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

yes = lambda b: "yes" if b else "no"
print(f"{'kind':<12} {'version':<24} sent answer turn-end  time   result")
for r in rows:
    ok = r["sent"] and r["answer_read"] and r["turn_end"]
    secs = f"{r['ms'] / 1000:.1f} s" if r["ms"] is not None else "-"
    print(f"{r['kind']:<12} {(r['version'] or '-')[:24]:<24} {yes(r['sent']):<4} {yes(r['answer_read']):<6} "
          f"{yes(r['turn_end']):<9} {secs:<6} {'PASS' if ok else 'FAIL ' + (r['failure'] or '')}")
for name, why in skipped:
    print(f"{name:<12} {'-':<24} -    -      -         -      SKIP {why}")
passed = [r for r in rows if r["sent"] and r["answer_read"] and r["turn_end"]]
failed = len(rows) - len(passed)
date = datetime.date.today().isoformat()
record = {"date": date, "self_test": self_test, "counted": 0 if self_test else len(passed),
          "kinds": rows, "skipped": [{"kind": n, "why": w} for n, w in skipped]}
# A self-test never lands in the evidence folder.
out = home.parent / f"agent-kinds-selftest-{os.getpid()}.json" if self_test else root / f"docs/measure/evidence/agent-kinds-{date}.json"
if not self_test and out.exists():
    # A rerun the same day (say with --only) replaces its own kinds and keeps the rest of the day's record.
    try:
        old = json.loads(out.read_text())
    except ValueError:
        old = {}
    ran = {r["kind"] for r in rows} | {n for n, _ in skipped}
    record["kinds"] = [r for r in old.get("kinds", []) if r["kind"] not in ran] + rows
    record["skipped"] = [s for s in old.get("skipped", []) if s["kind"] not in ran] + record["skipped"]
    record["counted"] = sum(1 for r in record["kinds"] if r["sent"] and r["answer_read"] and r["turn_end"])
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(record, indent=2) + "\n")
shutil.rmtree(home, ignore_errors=True)
print(f"{len(passed)} kinds completed a real turn · {failed} failed · {len(skipped)} skipped"
      + (" (self-test: not counted)" if self_test else ""))
print(f"record: {out}")
sys.exit(1 if failed or (self_test and not passed) else 0)
PY
