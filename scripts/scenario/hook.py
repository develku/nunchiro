"""Per-session hook for Claude and Codex: forwards the event to the core socket.

argv: <sock> <sink.jsonl> <event> [block_seconds]
Blocking events (PermissionRequest) wait up to block_seconds for the core's answer. If the core is
gone, hung, or answers nothing, the hook prints nothing and exits 0, so the agent falls back to its
own prompt. It never prints an allow.
"""
import json, os, socket, sys, time

sock_path, sink, event = sys.argv[1:4]
block = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
t_start = time.time()
payload = sys.stdin.read()
rec = {"t_hook": t_start, "event": event, "pid": os.getppid(), "payload": payload[:20000]}
with open(sink, "a") as f:
    f.write(json.dumps(rec) + "\n")
blocking = event == "PermissionRequest" and block > 0
try:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1.0)
    s.connect(sock_path)
    s.sendall((json.dumps(dict(rec, blocking=blocking)) + "\n").encode())
    if blocking:
        s.settimeout(block)
        reply = s.makefile().readline()
        d = json.loads(reply) if reply.strip() else {}
        if d.get("behavior") == "deny":  # only deny is ever relayed by this harness
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                     "decision": {"behavior": "deny", "message": "denied by test core"}}}))
except (OSError, ValueError):
    pass
with open(sink, "a") as f:
    f.write(json.dumps({"t_hook_end": time.time(), "event": event, "dur": time.time() - t_start}) + "\n")
