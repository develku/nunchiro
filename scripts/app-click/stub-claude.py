#!/usr/bin/env python3
"""Stand-in `claude` for repro scenarios (ticket 171): no model, no tokens, no access to the owner's config or keychain.
Login/logout/--version print and exit. A session run (core passes --settings with its hooks) fires those hooks like
Claude would, per `--stub-mode working|waiting|idle`, then sleeps quietly so the session stays live."""
import json, subprocess, sys, time

a = sys.argv[1:]
if "--settings" not in a:
    print("stub claude", " ".join(a))
    sys.exit(0)
mode = a[a.index("--stub-mode") + 1] if "--stub-mode" in a else "working"
hooks = json.load(open(a[a.index("--settings") + 1])).get("hooks", {})


def fire(event, wait=True, **extra):
    for block in hooks.get(event, []):
        for h in block.get("hooks", []):
            p = subprocess.Popen(h["command"], shell=True, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, text=True)
            p.stdin.write(json.dumps({"hook_event_name": event, "session_id": "stub", **extra}))
            p.stdin.close()
            if wait:
                p.wait(timeout=10)


print("stub claude ready", flush=True)
fire("SessionStart")
fire("UserPromptSubmit", prompt="step")
if mode == "waiting":
    # A permission ask blocks until answered, as Claude's own does; it stays open while the scenario looks.
    fire("PermissionRequest", wait=False, tool_name="Bash", tool_input={"command": "npm install"})
elif mode == "idle":
    fire("Stop")
time.sleep(900)
