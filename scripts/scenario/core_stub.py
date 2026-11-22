"""Stand-in for `nunchiro serve` hook intake. argv: <sock> <events.jsonl> <mode>
mode record: log and close. hold: log and keep blocking hooks waiting (to be killed). deny: answer deny."""
import json, os, socket, sys, threading, time

sock_path, events, mode = sys.argv[1:4]
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass
srv = socket.socket(socket.AF_UNIX)
srv.bind(sock_path)
srv.listen(64)
held = []


def handle(c):
    line = c.makefile().readline()
    t = time.time()
    try:
        d = json.loads(line)
    except ValueError:
        c.close()
        return
    with open(events, "a") as f:
        f.write(json.dumps({"t_recv": t, "event": d.get("event"), "t_hook": d.get("t_hook"), "blocking": d.get("blocking"),
                            "payload": d.get("payload")}) + "\n")
    if d.get("blocking") and mode == "hold":
        held.append(c)
        return
    if d.get("blocking") and mode == "deny":
        c.sendall(b'{"behavior":"deny"}\n')
    c.close()


while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
