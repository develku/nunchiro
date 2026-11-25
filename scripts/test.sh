#!/bin/sh
# Ticket 1130 C9 (rubric p26 MD1): run a check command so it behaves the same inside a Nunchiro session as outside.
#   sh scripts/test.sh COMMAND [ARGS...]      e.g. sh scripts/test.sh cargo test -p nunchiro-core some_test
# Drops NUNCHIRO_SESSION, NUNCHIRO_TOKEN, NUNCHIRO_ARTIFACTS and NUNCHIRO_HOME (in a session that is the owner's home,
# so nothing run here reaches ~/.nunchiro), and runs COMMAND outside the session's process tree: a double fork with
# setsid, so launchd is its parent (as scripts/measure/scorecard.py outside_holder does). Inside a session the holder
# tests otherwise fail: the core refuses a peer that runs under a session holder (peer.rs).
# stdout and stderr stream apart; the exit code is COMMAND's real exit (128+N when a signal N ended it), not the end of
# its output. On INT or TERM, a runner error, or COMMAND's end, its process group (created here) gets TERM, 5 s, then KILL,
# and test.sh returns only when the group is gone. If test.sh itself is killed, the waiter stops the group the same way.
# Nothing outside that group is signalled. The holder's own rule is unchanged.
[ $# -gt 0 ] || { echo "usage: sh scripts/test.sh COMMAND [ARGS...]" >&2; exit 2; }
exec python3 -I -c '
import os, select, signal, sys, time
GRACE = 5  # seconds between TERM and KILL
cmd = sys.argv[1:]
env = {k: v for k, v in os.environ.items()
       if k not in ("NUNCHIRO_SESSION", "NUNCHIRO_TOKEN", "NUNCHIRO_ARTIFACTS", "NUNCHIRO_HOME")}
cancel = []
for s in (signal.SIGINT, signal.SIGTERM):  # before the first fork: no window where a signal ends test.sh unhandled
    signal.signal(s, lambda sig, _frame: cancel.append(sig))
r, w = os.pipe()    # COMMAND stdout
er, ew = os.pipe()  # COMMAND stderr
sr, sw = os.pipe()  # the waiter sends the exit code
hr, hw = os.pipe()  # EOF tells the waiter that test.sh is gone
first = os.fork()
if first == 0:
    try:
        os.setsid()  # a new session and process group (its id: first), out of the holder session
        if os.fork():
            os._exit(0)
        for fd in (r, er, sr, hw):
            os.close(fd)
        child = os.fork()
        if child == 0:
            for s in (signal.SIGINT, signal.SIGTERM, signal.SIGPIPE):  # Python ignores SIGPIPE; exec would keep that
                signal.signal(s, signal.SIG_DFL)
            null = os.open(os.devnull, os.O_RDONLY)
            os.dup2(null, 0); os.dup2(w, 1); os.dup2(ew, 2)
            try:
                os.execvpe(cmd[0], cmd, env)
            except OSError as e:
                os.write(2, ("test.sh: %s: %s\n" % (cmd[0], e.strerror)).encode())
                os._exit(127)
        os.close(w); os.close(ew)
        # The waiter ignores TERM and stays in the group until the final KILL, so the group id never names another group.
        for s in (signal.SIGINT, signal.SIGTERM):
            signal.signal(s, signal.SIG_IGN)
        while True:
            if select.select([hr], [], [], 0.2)[0]:  # test.sh died, even by KILL: stop the group, the waiter with it
                os.killpg(0, signal.SIGTERM)
                end = time.monotonic() + GRACE
                while not os.waitpid(child, os.WNOHANG)[0] and time.monotonic() < end:  # reap, or it stays a zombie
                    time.sleep(0.1)
                os.killpg(0, signal.SIGKILL)
            pid, status = os.waitpid(child, os.WNOHANG)
            if pid:
                break
        rc = os.waitstatus_to_exitcode(status)
        os.write(sw, b"%d\n" % (128 - rc if rc < 0 else rc))
        os.read(hr, 1)
    finally:
        os._exit(0)
for fd in (w, ew, sw, hr):
    os.close(fd)
os.waitpid(first, 0)
sinks = {r: sys.stdout.buffer, er: sys.stderr.buffer}
waiter = {sr}
rc = None


def pump(timeout):
    global rc
    for fd in select.select(list(sinks) + list(waiter), [], [], timeout)[0]:
        chunk = os.read(fd, 65536)
        if fd == sr:
            waiter.clear()
            rc = int(chunk) if chunk else None  # EOF without a code: the waiter died
        elif chunk:
            sinks[fd].write(chunk); sinks[fd].flush()
        else:
            del sinks[fd]


def signal_group(sig):
    try:
        os.killpg(first, sig)
        return True
    except (ProcessLookupError, PermissionError):  # macOS gives EPERM when only zombies are left in the group
        return False


def stop():
    signal_group(signal.SIGTERM)
    end = time.monotonic() + GRACE
    while waiter and time.monotonic() < end:
        pump(0.1)
    signal_group(signal.SIGKILL)
    for _ in range(50):
        if not signal_group(0):
            return
        time.sleep(0.1)
    sys.stderr.write("test.sh: process group %d still runs after KILL\n" % first)


try:
    while waiter and not cancel:  # output EOF is not the end: COMMAND may close its output and run on
        pump(0.2)
finally:
    stop()
end = time.monotonic() + GRACE  # the group is gone; read what it left in the pipes
while sinks and time.monotonic() < end:
    pump(0.1)
if cancel:
    sys.exit(128 + cancel[0])
if rc is None:
    sys.stderr.write("test.sh: no exit code from %s; its waiter ended early\n" % cmd[0])
    sys.exit(125)
sys.exit(rc)
' "$@"
