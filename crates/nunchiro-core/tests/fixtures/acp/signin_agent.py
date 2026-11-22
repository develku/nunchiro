"""Ticket 358: a fake ACP v1 agent for sign-in, with its signed-in state in a file so it survives between runs.

Usage: signin_agent.py STATE [mode ...]. STATE exists: signed in. `STATE.log` gets every line the client sends and
`STATE.argv` this run's arguments, `STATE.pid` its pid. Modes:
  methods:a,b,..  the authMethods reported; each of agent, agent2, terminal, env (env is env_var)
  logout          advertise agentCapabilities.auth.logout
  link:URL        `authenticate` asks a URL elicitation with URL first
  hold            `authenticate` and `logout` are never answered, and the agent outlives its stdin (only a kill ends it)
  exit            `authenticate` makes the agent exit
  flaky-check     a run that starts signed in never answers `session/new`
A run whose arguments hold `login` is the terminal method: it signs in and exits.
"""
import json
import os
import sys
import time

STATE = sys.argv[1]
MODES = sys.argv[2:]
METHODS = {
    "agent": {"id": "oauth", "name": "Sign in with Acme", "type": "agent"},
    "agent2": {"id": "sso", "name": "Company SSO", "type": "agent"},
    "terminal": {"id": "cli", "name": "Terminal login", "type": "terminal", "args": ["login", "--device"]},
    "env": {"id": "key", "name": "API key", "type": "env_var", "vars": [{"name": "ACME_KEY"}]},
}
with open(STATE + ".argv", "w") as argv:
    argv.write(" ".join(sys.argv[2:]))
with open(STATE + ".pid", "w") as pid:
    pid.write(str(os.getpid()))


if "login" in MODES:
    open(STATE, "w").close()
    sys.exit(0)
SIGNED_AT_START = os.path.exists(STATE)


def mode(prefix):
    return next((m[len(prefix):] for m in MODES if m.startswith(prefix)), None)


def send(message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
    sys.stdout.flush()


def finish_authenticate(rid):
    if "hold" in MODES:
        return
    open(STATE, "w").close()
    send({"id": rid, "result": {}})


pending = None
for line in sys.stdin:
    with open(STATE + ".log", "a") as log:
        log.write(line)
    message = json.loads(line)
    method, rid = message.get("method"), message.get("id")
    if method is None and rid == "elicit":
        if message["result"]["action"] == "accept":
            finish_authenticate(pending)
        else:
            send({"id": pending, "error": {"code": -32000, "message": "the link was declined"}})
    elif method == "initialize":
        listed = (mode("methods:") or "").split(",")
        caps = {"auth": {"logout": {}}} if "logout" in MODES else {}
        send({"id": rid, "result": {"protocolVersion": 1, "agentCapabilities": caps,
                                    "authMethods": [METHODS[m] for m in listed if m]}})
    elif method == "authenticate":
        if "exit" in MODES:
            os._exit(3)
        pending = rid
        link = mode("link:")
        if link:
            send({"id": "elicit", "method": "elicitation/create",
                  "params": {"mode": "url", "url": link, "message": "Sign in", "elicitationId": "e1"}})
        else:
            finish_authenticate(rid)
    elif method == "session/new":
        if "flaky-check" in MODES and SIGNED_AT_START:
            continue
        if os.path.exists(STATE):
            send({"id": rid, "result": {"sessionId": "s1"}})
        else:
            send({"id": rid, "error": {"code": -32000, "message": "auth_required"}})
    elif method == "logout":
        if "hold" in MODES:
            continue
        if os.path.exists(STATE):
            os.remove(STATE)
        send({"id": rid, "result": {}})
if "hold" in MODES:
    time.sleep(300)
