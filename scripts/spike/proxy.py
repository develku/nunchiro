"""Stand-in for the core-run proxy: HTTP CONNECT only, allow-list by host name, logs each decision.
Usage: proxy.py PORTFILE LOGFILE HOST[,HOST...]  (binds 127.0.0.1, writes its port to PORTFILE)."""
import select
import socket
import socketserver
import sys
import threading

portfile, logfile, allowed = sys.argv[1], sys.argv[2], set(sys.argv[3].split(","))
lock = threading.Lock()


def log(line):
    with lock, open(logfile, "a") as f:
        f.write(line + "\n")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        request = self.rfile.readline().decode("latin1").split()
        while self.rfile.readline().strip():  # drain headers
            pass
        if len(request) < 2 or request[0] != "CONNECT":
            log(f"REFUSE method {request[:1]}")
            self.wfile.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        host, _, port = request[1].rpartition(":")
        if host.lower() not in allowed or port != "443":
            log(f"REFUSE {request[1]}")
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((host, 443), timeout=10)
        except OSError as e:
            log(f"ERROR {request[1]} {e}")
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        log(f"ALLOW {request[1]}")
        self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        pair = [self.connection, upstream]
        while True:
            ready, _, _ = select.select(pair, [], [], 30)
            if not ready:
                break
            for s in ready:
                data = s.recv(65536)
                if not data:
                    upstream.close()
                    return
                (upstream if s is self.connection else self.connection).sendall(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", 0), Handler) as srv:
    with open(portfile, "w") as f:
        f.write(str(srv.server_address[1]))
    srv.serve_forever()
