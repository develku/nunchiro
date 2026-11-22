"""Minimal PTY relay (stand-in for the core's PTY ownership). argv: <sock> <cwd> -- <argv...>
Owns the PTY, accepts one client on a unix socket and copies bytes both ways."""
import os, pty, select, socket, sys

sock_path, cwd = sys.argv[1], sys.argv[2]
argv = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
srv = socket.socket(socket.AF_UNIX)
srv.bind(sock_path)
srv.listen(1)
c, _ = srv.accept()
c.setblocking(False)
try:
    while True:
        r, _, _ = select.select([fd, c], [], [])
        if fd in r:
            b = os.read(fd, 65536)
            if not b:
                break
            c.sendall(b)
            if b"\x1b[6n" in b:
                os.write(fd, b"\x1b[1;1R")
        if c in r:
            b = c.recv(65536)
            if not b:
                break
            os.write(fd, b)
except OSError:
    pass
finally:
    os.kill(pid, 9)
    os.unlink(sock_path)
