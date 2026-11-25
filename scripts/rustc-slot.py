#!/usr/bin/env python3
"""Cargo rustc-wrapper (ticket 1133, overload fixes): at most N crate compiles at once on this Mac, across every
worktree, lane, reviewer and gate copy. `jobs = 2` in .cargo/config.toml limits one cargo only; on 11-25 eight
cargos ran eight nunchiro-core compiles (1.2-1.7 GB each, 11 GB in all) on a 16 GB mini and macOS killed processes.

A slot is an flock on <dir>/slot<i>. The lock fd stays open through exec, so the slot is held by rustc itself and
freed by the kernel when rustc and any child it started (a linker) have exited or been killed: no stale slot.
The slot dir is per user, mode 0700, checked for owner and type; slot files open with O_NOFOLLOW.
Fails open: when the slot dir cannot be made or locked (a sandboxed seat), rustc runs without a slot.
Env: NUNCHIRO_RUSTC_SLOTS (default 2; 0 = no limit), NUNCHIRO_RUSTC_SLOT_DIR (default /tmp/nunchiro-rustc-slots-<uid>).
"""
import fcntl
import os
import stat
import sys
import time


def needs_slot(args):
    # Probes (`rustc -vV`, `--print`, the `___` crate cargo uses to learn target info) are cheap; only real crates wait.
    if "--crate-name" not in args:
        return False
    i = args.index("--crate-name")
    return i + 1 < len(args) and args[i + 1] != "___"


def private(st):
    # Ours, and no one else may write it: another local user could otherwise hold the slots forever or swap them.
    return st.st_uid == os.getuid() and not st.st_mode & 0o022


def open_slots(n, folder):
    try:
        os.mkdir(folder, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(folder)
    if not stat.S_ISDIR(st.st_mode) or not private(st):
        raise OSError("slot dir is not a private directory")
    fds = []
    try:
        for i in range(n):
            fd = os.open(os.path.join(folder, "slot%d" % i), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fds.append(fd)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or not private(st):
                raise OSError("slot file is not private")
    except OSError:
        for fd in fds:
            os.close(fd)
        raise
    return fds


def take_slot(n, folder):
    try:
        fds = open_slots(n, folder)
    except OSError:
        return None
    while True:
        for fd in fds:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            except OSError:
                return None
            for other in fds:
                if other != fd:
                    os.close(other)
            return fd
        time.sleep(0.2)


def main():
    args = sys.argv[1:]  # cargo calls: <wrapper> <rustc> <rustc args...>
    if not args:
        sys.exit("rustc-slot: no rustc given")
    try:
        n = int(os.environ.get("NUNCHIRO_RUSTC_SLOTS", "2"))
    except ValueError:
        n = 2
    if n > 0 and needs_slot(args[1:]):
        fd = take_slot(n, os.environ.get("NUNCHIRO_RUSTC_SLOT_DIR", "/tmp/nunchiro-rustc-slots-%d" % os.getuid()))
        if fd is not None:
            os.set_inheritable(fd, True)
    os.execvp(args[0], args)


if __name__ == "__main__":
    main()
