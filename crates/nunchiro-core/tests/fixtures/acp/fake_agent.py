"""V2-4a: a fake ACP v1 agent over stdio for the core's ACP tests.

Usage: fake_agent.py LOG [load] [v2] [hang] [auth] [info] [fsask] [child-writes]. Every line the client sends is
appended to LOG as received, so a test reads the answers the core gave. `load` declares `loadSession`; `v2` answers
`initialize` with protocol version 2. V2-4b modes (chosen by an arg of the entry, never by env): `hang` never answers;
`auth` answers `session/new` with an auth_required error; `info` writes its cwd and env names to LOG.info at start;
`fsask` asks for a file and a terminal before answering `session/new`; `child-writes` leaves a child that keeps sending
updates on the shared stdout and exits after its first prompt. Ticket 358: `nomodels` reports no model option;
`set-fails` answers session/set_config_option with an error; `many:N` adds N long model ids after the two short ones.
Ticket 1130: while a file LOG.noload exists, `session/load` answers an error (a resume whose load fails).
A prompt's first text block picks the behaviour:
  later          end the turn, then ask permission with no prompt in flight
  elicit         ask a URL elicitation, end the turn once it is answered
  cancel-me      ask permission and hold the turn; on session/cancel ask again, end the turn once that is answered
  edit:PATH      ask permission, write PATH through fs/write_text_file, report it as a completed edit with a diff, end the turn
  read:PATH      fs/read_text_file PATH, end the turn
  write:PATH     fs/write_text_file PATH, end the turn
  term           terminal/create /bin/echo, wait, read its output, release, end the turn
  say:TEXT       one agent_message_chunk, end the turn
  subagents      report two children (one running then idle, one idle with stopReason error), end the turn
  env            report the environment it was started with as a chunk, end the turn
  flood:N:SIZE   N tool_call updates whose rawInput holds SIZE bytes, end the turn
  bigout         one completed tool_call_update with a 900 KiB rawOutput (under the 1 MiB line limit), end the turn
  exit-burst:PATH  leaves `sleep 300` holding its stdout (pid in PATH), sends 600 updates and the turn's end, exits
  waits:N:PATH   a terminal running `sleep 1`, then N wait_for_exit requests at once; touches PATH.sent once sent and
                 writes PATH with the answers once all came, then releases it and ends the turn
  orphan:PATH    starts `sleep 300` (same process group), writes its pid to PATH and exits
  term-orphan:PATH  a terminal whose shell leaves `sleep 300` (ignoring SIGHUP) behind, pid in PATH; release, end turn
  outward:PATH   terminal/create of `/bin/sh -c "touch PATH # npm publish"` (a publish, as the client reads it) with one
                 variable of its own; ends the turn once the client answered (a terminal or an error)
  outward-long:PATH  the same behind 4100 harmless characters, so the publish is past what a card shows
  forge:PATH     answers ids the client never asked for (1, the next prompt id, a string); ends the turn once PATH exists
  hostile        a broken JSON line, a non-JSON line, an unknown method, a permission for another session, end turn
  longline       one 17 MiB line
"""
import json
import os
import subprocess
import sys
import threading
import time

LOG = sys.argv[1]
LOAD = "load" in sys.argv[2:]
VERSION = 2 if "v2" in sys.argv[2:] else 1
MODES = sys.argv[2:]
if "info" in MODES:
    with open(LOG + ".info", "w") as info:
        json.dump({"cwd": os.getcwd(), "env": sorted(os.environ.keys()), "pid": os.getpid()}, info)
ALL_OPTIONS = [
    {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
    {"optionId": "once", "name": "Allow", "kind": "allow_once"},
    {"optionId": "no", "name": "Reject", "kind": "reject_once"},
    {"optionId": "never", "name": "Never", "kind": "reject_always"},
]
next_id = [0]
waiting = {}  # our request id -> callback(message)
prompt = {"id": None, "session": None}


LOCK = threading.Lock()


def send(message):
    raw(json.dumps(message) + "\n")


def raw(text):
    with LOCK:
        sys.stdout.write(text)
        sys.stdout.flush()


def request(method, params, then):
    next_id[0] += 1
    rid = "agent-%d" % next_id[0]
    waiting[rid] = then
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})


def end_turn(reason="end_turn"):
    if prompt["id"] is not None:
        send({"jsonrpc": "2.0", "id": prompt["id"], "result": {"stopReason": reason}})
        prompt["id"] = None


def update(session, body):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": body}})


def permission(session, then):
    request(
        "session/request_permission",
        {"sessionId": session, "toolCall": {"toolCallId": "call-%d" % (next_id[0] + 1), "title": "Edit a.txt"},
         "options": ALL_OPTIONS},
        then,
    )


def on_prompt(message):
    params = message["params"]
    session = params["sessionId"]
    prompt["id"], prompt["session"] = message["id"], session
    text = params["prompt"][0].get("text", "")
    if "child-writes" in MODES:
        update_json = json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session, "update": {"sessionUpdate": "tool_call", "toolCallId": "c", "title": "child"}}})
        # A light forked child (one write per 2 ms) so every registry pass finds something: the drain is never quiet.
        if os.fork() == 0:
            while True:
                raw(update_json + "\n")
                time.sleep(0.002)
        end_turn()
        threading.Timer(0.3, lambda: os._exit(0)).start()
    elif text == "later":
        end_turn()
        permission(session, lambda m: None)
    elif text == "elicit":
        request("elicitation/create",
                {"sessionId": session, "mode": "url", "message": "Sign in", "url": "https://example.com/x",
                 "elicitationId": "e-%d" % next_id[0]},
                lambda m: end_turn())
    elif text == "cancel-me":
        permission(session, lambda m: None)
    elif text.startswith("edit:"):
        path = text[5:]
        body = "hello\nworld\n"

        def wrote(m):
            update(session, {"sessionUpdate": "tool_call", "toolCallId": "edit-1", "title": "Edit " + path,
                             "kind": "edit", "status": "in_progress"})
            update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "edit-1", "status": "completed",
                             "content": [{"type": "diff", "path": path, "oldText": "", "newText": body}]})
            end_turn()

        def allowed(m):
            chosen = m.get("result", {}).get("outcome", {})
            if chosen.get("optionId") == "once":
                request("fs/write_text_file", {"sessionId": session, "path": path, "content": body}, wrote)
            else:
                end_turn()
        permission(session, allowed)
    elif text.startswith("read:") or text.startswith("write:"):
        kind, path = text.split(":", 1)
        if kind == "read":
            request("fs/read_text_file", {"sessionId": session, "path": path}, lambda m: end_turn())
        else:
            request("fs/write_text_file", {"sessionId": session, "path": path, "content": "written by fake"},
                    lambda m: end_turn())
    elif text == "term":
        def created(m):
            tid = m["result"]["terminalId"]
            request("terminal/wait_for_exit", {"sessionId": session, "terminalId": tid},
                    lambda m2: request("terminal/output", {"sessionId": session, "terminalId": tid},
                                       lambda m3: request("terminal/release",
                                                          {"sessionId": session, "terminalId": tid},
                                                          lambda m4: end_turn())))
        request("terminal/create", {"sessionId": session, "command": "/bin/echo", "args": ["hi from pty"]}, created)
    elif text.startswith("say:"):
        update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text[4:]}})
        end_turn()
    elif text == "subagents":
        # V2-CF4: the subagents RFD's association update. The body's own sessionId is the child, never this session.
        for body in [
            {"sessionUpdate": "subagent_update", "sessionId": "child-1", "title": "Test investigator",
             "state": {"state": "running"}},
            {"sessionUpdate": "subagent_update", "sessionId": "child-1", "state": {"state": "idle"}},
            {"sessionUpdate": "subagent_update", "sessionId": "child-2", "title": "Plan the page",
             "state": {"state": "running"}},
            {"sessionUpdate": "subagent_update", "sessionId": "child-2", "state": {"state": "idle", "stopReason": "error"}},
        ]:
            update(session, body)
        end_turn()
    elif text == "env":
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": json.dumps(sorted(os.environ.keys()))}})
        end_turn()
    elif text.startswith("flood:"):
        _, n, size = text.split(":")
        for i in range(int(n)):
            update(session, {"sessionUpdate": "tool_call", "toolCallId": "f-%d" % i, "title": "flood",
                             "rawInput": {"blob": "x" * int(size)}})
        end_turn()
    elif text == "bigout":
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "big", "status": "completed",
                         "rawOutput": "y" * (900 * 1024)})
        end_turn()
    elif text.startswith("waits:"):
        _, n, path = text.split(":", 2)
        answers = []

        def created(m):
            tid = m["result"]["terminalId"]

            def got(reply):
                answers.append(reply.get("error", {}).get("code", "exit"))
                if len(answers) == int(n):
                    with open(path, "w") as f:
                        json.dump(answers, f)
                    request("terminal/release", {"sessionId": session, "terminalId": tid}, lambda m2: end_turn())
            for _ in range(int(n)):
                request("terminal/wait_for_exit", {"sessionId": session, "terminalId": tid}, got)
            open(path + ".sent", "w").close()
        request("terminal/create", {"sessionId": session, "command": "/bin/sleep", "args": ["1"]}, created)
    elif text.startswith("exit-burst:"):
        child = subprocess.Popen(["/bin/sleep", "300"])
        with open(text[11:], "w") as f:
            f.write(str(child.pid))
        for i in range(600):
            update(session, {"sessionUpdate": "tool_call", "toolCallId": "b-%d" % i, "title": "burst"})
        end_turn()
        os._exit(0)
    elif text.startswith("orphan:"):
        child = subprocess.Popen(["/bin/sleep", "300"])
        with open(text[7:], "w") as f:
            f.write(str(child.pid))
        os._exit(0)
    elif text.startswith("term-orphan:"):
        path = text[12:]
        script = 'trap "" HUP; /bin/sleep 300 & echo $! > "$1"; exit 0'

        def created(m):
            tid = m["result"]["terminalId"]
            request("terminal/wait_for_exit", {"sessionId": session, "terminalId": tid},
                    lambda m2: request("terminal/release", {"sessionId": session, "terminalId": tid},
                                       lambda m3: end_turn()))
        request("terminal/create", {"sessionId": session, "command": "/bin/sh", "args": ["-c", script, "sh", path]},
                created)
    elif text.startswith("outward:"):
        request("terminal/create",
                {"sessionId": session, "command": "/bin/sh", "args": ["-c", 'touch "$1" # npm publish', "sh", text[8:]],
                 "env": [{"name": "NPM_CONFIG_REGISTRY", "value": "https://registry.invalid"}]},
                lambda m: end_turn())
    elif text.startswith("outward-long:"):
        script = "echo " + "a" * 4100 + '; touch "$1" # npm publish'
        request("terminal/create",
                {"sessionId": session, "command": "/bin/sh", "args": ["-c", script, "sh", text[13:]]},
                lambda m: end_turn())
    elif text.startswith("forge:"):
        pid, gate = prompt["id"], text[6:]
        for forged in [1, pid + 1 if isinstance(pid, int) else 999, "forged"]:
            send({"jsonrpc": "2.0", "id": forged, "result": {"stopReason": "end_turn"}})
        def release():
            while not os.path.exists(gate):
                time.sleep(0.01)
            end_turn()
        threading.Thread(target=release, daemon=True).start()
    elif text == "hostile":
        raw("{broken json\n")
        raw("not json at all\n")
        send({"jsonrpc": "2.0", "id": "h-1", "method": "weird/method", "params": {"sessionId": session}})
        send({"jsonrpc": "2.0", "id": "h-2", "method": "session/request_permission",
              "params": {"sessionId": "someone-else", "toolCall": {"title": "x"}, "options": ALL_OPTIONS}})
        end_turn()
    elif text == "longline":
        raw("x" * (17 * 1024 * 1024) + "\n")
    else:
        end_turn()


CONFIG = [
    {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "fast",
     "options": [{"value": "fast", "name": "Fast"}, {"value": "smart", "name": "Smart"}]},
    {"id": "think", "name": "Thinking", "category": "thought_level", "type": "select", "currentValue": "high",
     "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]},
]
if "nomodels" in MODES:
    CONFIG = CONFIG[1:]
for many in [m[5:] for m in MODES if m.startswith("many:")]:
    CONFIG[0]["options"] += [{"value": "provider/long-model-name-%03d-preview" % i, "name": "Long model %d" % i}
                             for i in range(int(many))]

for line in sys.stdin:
    with open(LOG, "a") as log:
        log.write(line if line.endswith("\n") else line + "\n")
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    if method is None:
        then = waiting.pop(message.get("id"), None)
        if then:
            then(message)
        continue
    rid = message.get("id")
    if method == "initialize" and "hang" in MODES:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": VERSION,
                                                       "agentCapabilities": {"loadSession": LOAD,
                                                                             "promptCapabilities": {"image": True}},
                                                       "authMethods": []}})
    elif method == "session/new" and "auth" in MODES:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "auth_required: run gemini login"}})
    elif method == "session/new" and "fsask" in MODES:
        request("fs/read_text_file", {"sessionId": "x", "path": LOG}, lambda m: None)
        request("terminal/create", {"sessionId": "x", "command": "/usr/bin/touch", "args": [LOG + ".terminal"]},
                lambda m: None)
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "fake-%d" % os.getpid(), "configOptions": CONFIG}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "fake-%d" % os.getpid(), "configOptions": CONFIG}})
    elif method == "session/load" and os.path.exists(LOG + ".noload"):
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "session not found"}})
    elif method == "session/load":
        session = message["params"]["sessionId"]
        update(session, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "replayed"}})
        send({"jsonrpc": "2.0", "id": rid, "result": {"configOptions": CONFIG}})
    elif method == "session/set_config_option" and "set-fails" in MODES:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "model unavailable"}})
    elif method == "session/set_config_option":
        next(o for o in CONFIG if o["id"] == message["params"]["configId"])["currentValue"] = message["params"]["value"]
        send({"jsonrpc": "2.0", "id": rid, "result": {"configOptions": CONFIG}})
    elif method == "session/prompt":
        on_prompt(message)
    elif method == "session/cancel":
        # A request during cancel: the client must still show it.
        permission(message["params"]["sessionId"], lambda m: end_turn("cancelled"))
    elif rid is not None:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})
