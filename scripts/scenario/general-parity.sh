#!/bin/sh
# Spec Acceptance 7 (general parity): a real Claude coordinator given only the Nunchiro skill starts two
# workers, prompts them, waits, reads results and answers a startup dialog. Workers are the synthetic
# fixture CLI (no tokens, no user config); the coordinator is `claude --model haiku`, retried once on the
# next cheapest model if haiku cannot finish. Runs inside the ticket-01 guard (lib.snapshot/guard_check).
# Workers are told to pass --fixture-worker so a wrapper `claude` on PATH swaps in the fixture CLI.
# Env: PARITY_MODELS (default "haiku sonnet"), PARITY_TIMEOUT_MS (default 420000).
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
export ROOT="$root"
[ -x "${CARGO_TARGET_DIR:-$root/target}/debug/nunchiro" ] || (cd "$root" && cargo build -q -p nunchiro) || exit 2
exec python3 -B -I - "$@" <<'PY'
import json, os, shutil, signal, subprocess, sys, time, uuid

ROOT = os.environ["ROOT"]
sys.path.insert(0, os.path.join(ROOT, "scripts", "scenario"))
import lib  # noqa: E402

NUNCHIRO = os.path.join(os.environ.get("CARGO_TARGET_DIR", os.path.join(ROOT, "target")), "debug", "nunchiro")
FIXTURE = os.path.join(ROOT, "crates", "nunchiro", "tests", "fixtures", "agent-cli", "claude")
REAL_CLAUDE = shutil.which("claude")
KOREAN = "한글 확인 안녕하세요"
TIMEOUT_MS = int(os.environ.get("PARITY_TIMEOUT_MS", "420000"))
MODELS = os.environ.get("PARITY_MODELS", "haiku sonnet").split()
ALLOWED = "Bash(nunchiro:*),Bash(test:*),Bash(echo:*)"  # this session only; writes no settings


def attempt(model):
    work = os.path.join(ROOT, ".scratch", f"pp-{uuid.uuid4().hex[:6]}")
    home, bindir = (os.path.join(work, d) for d in ("h", "bin"))
    for d in (home, bindir):
        os.makedirs(d)
    wrapper = os.path.join(bindir, "claude")
    with open(wrapper, "w") as f:  # workers (marked --fixture-worker) are the fixture; the coordinator is the real claude
        f.write(f'#!/bin/sh\nfor a in "$@"; do [ "$a" = --fixture-worker ] && exec "{FIXTURE}" "$@"; done\nexec "{REAL_CLAUDE}" "$@"\n')
    os.chmod(wrapper, 0o755)
    env = lib.clean_env({"NUNCHIRO_HOME": home, "PATH": f"{bindir}:{os.path.dirname(NUNCHIRO)}:{os.environ['PATH']}"})
    env.pop("NUNCHIRO_TOKEN", None)
    log = {"model": model, "work": work, "ok": False, "notes": []}
    core = subprocess.Popen([NUNCHIRO, "serve"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=open(os.path.join(work, "core.log"), "w"), start_new_session=True)

    def cli(*args, timeout=60):
        r = subprocess.run([NUNCHIRO, *args], env=env, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr

    def snap():
        return {s["label"]: s for s in json.loads(cli("snapshot", "--json")[1])["sessions"]}

    pids = []
    try:
        for _ in range(100):
            if os.path.exists(os.path.join(home, "core.sock")) and cli("snapshot", "--json")[0] == 0:
                break
            time.sleep(0.1)
        rc, out, err = cli("agent", "start", "coord", "--kind", "claude", "--project", lib.TRUSTED_CWD,
                           "--model", model, "--", "--allowedTools", ALLOWED)
        if rc:
            log["notes"].append(f"coordinator did not start: {err.strip()}")
            return log
        for _ in range(240):  # the composer shows a prompt marker once the coordinator is ready
            if "❯" in cli("agent", "read", "coord", "--lines", "20")[1]:
                break
            time.sleep(0.5)
        task = (
            "Use the nunchiro skill and only the nunchiro CLI. "
            f"Start two Claude workers named w1 and w2 in your own project folder {lib.TRUSTED_CWD}. Start w1 with the extra arguments `-- --fixture-worker` and w2 with `-- --fixture-worker --fixture-dialog` (test-harness flags). "
            f"Send w1 the prompt '{KOREAN}'. w2 opens a startup dialog: read it and answer it by exiting or declining, never by trusting or allowing always. "
            "Then send w2 the prompt 'second worker'. Wait until both finish their turn, read both results, "
            "and finish by writing one line starting with PARITY: that quotes what each worker answered."
        )
        t0 = time.time()
        # Known core defect (REPORT): `agent prompt` writes text+Enter in one burst, which Claude treats as a paste
        # for long text, so Enter becomes a newline. The driver types the task, then presses Enter separately.
        coord_id = json.loads(out)["session"]["id"]
        cli("session", "send-text", coord_id, task)
        time.sleep(1)
        cli("session", "send-keys", coord_id, "enter")
        # Poll the record instead of `agent wait`: the coordinator's screen quotes a worker's dialog, which the
        # core's screen detector reports as a dialog on the coordinator (REPORT), so its status never reads "done".
        rc, err = 1, "agent_wait_timeout"
        while time.time() - t0 < TIMEOUT_MS / 1000:
            time.sleep(2)
            c = snap().get("coord", {})
            if c.get("completion_seq", 0) >= 1 and not c.get("attention", {}).get("working"):
                rc, err = 0, ""
                break
        log["coordinator_seconds"] = round(time.time() - t0)
        log["coordinator_rc"] = rc
        if rc:
            log["notes"].append(f"coordinator prompt: {err.strip()}")
        sessions = snap()
        pids = [s["pid"] for s in sessions.values() if s.get("pid")]
        log["coordinator_screen"] = cli("agent", "read", "coord", "--lines", "30")[1][-1500:]
        checks = {}
        for name, want in (("w1", KOREAN), ("w2", "second worker")):
            s = sessions.get(name)
            screen = cli("agent", "read", name, "--lines", "30")[1] if s else ""
            sends = [x["content"] for x in (s or {}).get("send_log", []) if x["status"] == "delivered"]
            checks[f"{name} started"] = s is not None
            checks[f"{name} prompted with {want!r}"] = want in sends
            checks[f"{name} result read ({'ACK:' + want!r})"] = f"ACK:{want}" in screen
            checks[f"{name} finished a turn"] = bool(s) and s["completion_seq"] >= 1
        w2 = sessions.get("w2") or {}
        keys = [k for x in w2.get("send_log", []) for k in x.get("keys", [])]
        checks["w2 dialog answered with esc"] = keys == ["esc"] or "esc" in keys
        checks["no trusting key sent to w2"] = not {"1", "enter"} & set(keys)
        log["checks"] = checks
        log["ok"] = all(checks.values())
        return log
    finally:
        try:
            for s in snap().values():
                cli("session", "close", s["id"])
        except Exception:  # noqa: BLE001 - core already gone; the kill below still runs
            pass
        cli("serve", "stop")
        for pid in [core.pid, *pids]:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        core.wait(timeout=10)
        left = [p for p in pids if _alive(p)]
        if left:
            log["notes"].append(f"processes still alive: {left}")
            log["ok"] = False
        shutil.rmtree(work, ignore_errors=True)


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


before = lib.snapshot()
runs = []
for model in MODELS:
    runs.append(attempt(model))
    print(json.dumps(runs[-1], ensure_ascii=False, indent=2))
    if runs[-1]["ok"]:
        break
problems, foreign = lib.guard_check(before, lib.snapshot(), ours=(ROOT, lib.TRUSTED_CWD))
print("guard problems:", problems or "none")
print("guard foreign changes (not ours):", foreign or "none")
ok = bool(runs) and runs[-1]["ok"] and not problems
print("PARITY", "PASS" if ok else "FAIL", "models tried:", [r["model"] for r in runs])
sys.exit(0 if ok else 1)
PY
