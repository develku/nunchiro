#!/bin/sh
# Ticket V1A-15 real probe: one real `claude --model haiku` worker in the guard-trusted folder gets a 225-char
# `agent prompt` and then a short control prompt; each must submit and finish its turn (`agent prompt --wait`).
# Records whether the worker enabled bracketed paste (the settle route) and the send log rows.
# Runs inside the ticket-01 guard (lib.snapshot/guard_check). One worker, one attempt; never sends /model or /effort.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
export ROOT="$root"
[ -x "${CARGO_TARGET_DIR:-$root/target}/debug/nunchiro" ] || (cd "$root" && cargo build -q -j 2 -p nunchiro) || exit 2
exec python3 -B -I - "$@" <<'PY'
import json, os, shutil, signal, subprocess, sys, time, uuid

ROOT = os.environ["ROOT"]
sys.path.insert(0, os.path.join(ROOT, "scripts", "scenario"))
import lib  # noqa: E402

NUNCHIRO = os.path.join(os.environ.get("CARGO_TARGET_DIR", os.path.join(ROOT, "target")), "debug", "nunchiro")
LONG = ("Reply with exactly the word PROBE-LONG-OK and nothing else. This sentence only pads the prompt past the "
        "length that Claude Code treats as a paste, so the core has to send Enter as its own write after it.")
LONG = (LONG + " " + "pad " * 60)[:225]
SHORT = "Reply with exactly PROBE-SHORT-OK."


def main():
    work = os.path.join(ROOT, ".scratch", f"pe-{uuid.uuid4().hex[:6]}")
    home = os.path.join(work, "h")
    os.makedirs(home)
    env = lib.clean_env({"NUNCHIRO_HOME": home, "PATH": f"{os.path.dirname(NUNCHIRO)}:{os.environ['PATH']}"})
    env.pop("NUNCHIRO_TOKEN", None)
    log = {"work": work, "ok": False, "long_chars": len(LONG), "notes": []}
    core = subprocess.Popen([NUNCHIRO, "serve"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=open(os.path.join(work, "core.log"), "w"), start_new_session=True)

    def cli(*args, timeout=200):
        r = subprocess.run([NUNCHIRO, *args], env=env, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr

    pid = None
    try:
        for _ in range(100):
            if os.path.exists(os.path.join(home, "core.sock")) and cli("snapshot", "--json")[0] == 0:
                break
            time.sleep(0.1)
        rc, out, err = cli("agent", "start", "w", "--kind", "claude", "--project", lib.TRUSTED_CWD,
                           "--model", "haiku")
        if rc:
            log["notes"].append(f"worker did not start: {err.strip()}")
            return log
        sid = json.loads(out)["session"]["id"]
        pid = json.loads(out)["session"].get("pid")
        for _ in range(240):
            if "❯" in cli("agent", "read", "w", "--lines", "20")[1]:
                break
            time.sleep(0.5)
        replay = bytes(json.loads(cli("session", "read", sid)[1])["data"])
        log["bracketed_paste_seen"] = b"\x1b[?2004h" in replay
        for name, text, want in (("long", LONG, "PROBE-LONG-OK"), ("short", SHORT, "PROBE-SHORT-OK")):
            t0 = time.time()
            rc, out, err = cli("agent", "prompt", "w", text, "--wait", "--until", "done", "--timeout", "180000")
            log[f"{name}_rc"] = rc
            log[f"{name}_seconds"] = round(time.time() - t0, 1)
            if rc:
                log["notes"].append(f"{name} prompt: {err.strip()}")
            screen = cli("agent", "read", "w", "--lines", "40")[1]
            log[f"{name}_answered"] = want in screen
        s = json.loads(cli("agent", "get", "w", "--json")[1])
        log["send_log"] = [{k: x.get(k) for k in ("status", "submit", "settle")} | {"chars": len(x["content"])}
                           for x in s.get("send_log", [])]
        log["completion_seq"] = s.get("completion_seq")
        log["screen_tail"] = cli("agent", "read", "w", "--lines", "15")[1][-1200:]
        log["ok"] = all(log.get(k) == 0 for k in ("long_rc", "short_rc")) and log["long_answered"] \
            and log["short_answered"] and s.get("completion_seq", 0) >= 2
        return log
    finally:
        try:
            for x in json.loads(cli("snapshot", "--json")[1])["sessions"]:
                cli("session", "close", x["id"])
        except Exception:  # noqa: BLE001 - core already gone; the kill below still runs
            pass
        cli("serve", "stop")
        for p in [core.pid, pid]:
            if p:
                try:
                    os.kill(p, signal.SIGTERM)
                except OSError:
                    pass
        core.wait(timeout=10)
        shutil.rmtree(work, ignore_errors=True)


before = lib.snapshot()
result = main()
print(json.dumps(result, ensure_ascii=False, indent=2))
problems, foreign = lib.guard_check(before, lib.snapshot(), ours=(ROOT, lib.TRUSTED_CWD))
print("guard problems:", problems or "none")
print("guard foreign changes (not ours):", foreign or "none")
ok = result["ok"] and not problems
print("PROMPT-ENTER", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
