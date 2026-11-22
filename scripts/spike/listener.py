"""Stand-in for the core's loopback port and Unix socket: accepts and logs, never answers.
Usage: listener.py tcp|unix PORTFILE_OR_PATH LOGFILE"""
import os
import socket
import sys
import threading

kind, where, logfile = sys.argv[1:4]
if kind == "tcp":
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    open(where, "w").write(str(s.getsockname()[1]))
else:
    if os.path.exists(where):
        os.unlink(where)
    s = socket.socket(socket.AF_UNIX)
    s.bind(where)
s.listen(8)
while True:
    c, _ = s.accept()
    with open(logfile, "a") as f:
        f.write("ACCEPT\n")
    threading.Timer(2, c.close).start()
