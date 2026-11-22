"""Ticket 464: scripts/gate-app-boot.sh, the gate stage that boots the RC-id app on a temp home, without the real app.

Each test copies the script into a fake worktree under the system temp dir and runs its `run` step against a stub app:
compiled launchers (so `ps` shows the bundle path as the executable, as for the real app) that run small shell
scripts acting as the window and the core CLI. `open`, `lsappinfo`, `screencapture` and `swiftc` (which "builds" a
stub window helper) come first on PATH, and HOME is a fake home, so no macOS prompt, Launch Services launch or real
window is involved. Covered: the refusals (owner home, ~/.nunchiro-*, case, symlinks, an installed or wrong app), the
step each failure names, a pass with no Screen Recording grant (the page's own picture, as over ssh) and with an ad hoc
signature (a note, no owner step), the refusals of a worktree where a Files & Folders prompt could block the window,
the core's empty NUNCHIRO_KEYCHAIN, and the stop logic (only this run's processes, by PID,
TERM then KILL, the run folder removed, a look-alike process left alone)."""
import fcntl
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/gate-app-boot.sh"
AX_SRC = ROOT / "scripts/app-click/ax.swift"
NAME = "Nunchiro RC.app"
RC_ID = "dev.nunchiro.app.rc"

# The launcher: runs <its own path>.sh with /bin/sh as a child and forwards TERM to it, like an app that quits.
LAUNCHER_C = r"""
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static volatile pid_t child;
static void fwd(int sig) { if (child > 0) kill(child, sig); _exit(128 + sig); }
int main(int argc, char **argv) {
  char script[4096];
  snprintf(script, sizeof script, "%s.sh", argv[0]);
  char **args = calloc(argc + 2, sizeof *args);
  args[0] = "/bin/sh"; args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  signal(SIGTERM, fwd);
  pid_t pid;
  if (posix_spawn(&pid, "/bin/sh", NULL, NULL, args, environ)) return 127;
  child = pid;
  int st;
  while (waitpid(pid, &st, 0) < 0) {}
  return WIFEXITED(st) ? WEXITSTATUS(st) : 128;
}
"""

# The window. Modes (words in $HOME/mode): exit, nocore, steal (takes the front), switch (another app takes it),
# lockscreen (the screen locks), waitspoof (says where it runs and waits until the test started a look-alike), blank
# (its page picture is blank), noshot (it writes no page picture), activates (it records that it became the active
# app, as gate_shot.rs `watch_active` does, while the front looks unchanged), activatesatquit (it records that only
# when told to quit, after the stage's last poll). As the RC's gate run does (gate_shot.rs), it writes
# its page picture to $NUNCHIRO_HOME/gate-shot.png, blank under NUNCHIRO_GATE_BLANK=1.
APP_SH = r"""
H=$HOME; mode=" $(cat "$H/mode" 2>/dev/null) "
echo "$NUNCHIRO_HOME" > "$H/app-home"
env > "$H/app-env"
case $mode in *" exit "*) echo "stub app: boom" >&2; exit 3 ;; esac
shot=drawn; case "$mode ${NUNCHIRO_GATE_BLANK:-}" in *" blank "* | *" 1") shot=blank ;; esac
case $mode in *" noshot "*) ;; *) echo "$shot" > "$NUNCHIRO_HOME/gate-shot.png" ;; esac
case $mode in *" steal "*) echo "$PPID" > "$H/front.pid"; echo "ASN:0x0-0x99:" > "$H/front" ;; esac
case $mode in *" switch "*) echo "ASN:0x0-0x55:" > "$H/front" ;; esac
case $mode in *" activates "*) echo "active 1794460000.25" >> "$NUNCHIRO_HOME/gate-active.log" ;; esac
case $mode in *" activatesatquit "*)
  trap 'echo "active 1794460009.50" >> "$NUNCHIRO_HOME/gate-active.log"; exit 0' TERM ;;
esac
case $mode in *" lockscreen "*) echo "locked yes asleep no console yes" > "$H/screen" ;; esac
case $mode in *" waitspoof "*)
  echo "${0%.sh}" > "$H/runexe"; i=0; while [ ! -e "$H/spoofed" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done ;;
esac
case $mode in *" nocore "*) ;; *) "$NUNCHIRO_BIN" serve update ;; esac
while :; do sleep 0.2; done
"""

# The CLI and core. Modes: foreign (core.start.json names another executable), keychain (the core's start env has no
# empty NUNCHIRO_KEYCHAIN), noprompt (the shell shows nothing), noprint (no line comes back), stubborn (the session's holder ignores TERM and stop).
CLI_SH = r"""
self=${0%.sh}; h=$NUNCHIRO_HOME; mode=" $(cat "$HOME/mode" 2>/dev/null) "
[ -z "${NUNCHIRO_TOKEN:-}" ] || echo "$*" >> "$HOME/cli-token-leak"
case "$1 $2" in
  "serve update")
    [ -S "$h/core.sock" ] || "$self" serve </dev/null >/dev/null 2>&1 &
    i=0; while [ ! -S "$h/core.sock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done ;;
  "serve ")
    exe=$self; case $mode in *" foreign "*) exe=/usr/bin/true ;; esac
    python3 -c 'import json, os, sys
env = {} if " keychain " in sys.argv[3] or "NUNCHIRO_KEYCHAIN" not in os.environ else {"NUNCHIRO_KEYCHAIN": os.environ["NUNCHIRO_KEYCHAIN"]}
json.dump({"exe": sys.argv[1], "env": env}, open(sys.argv[2], "w"))' "$exe" "$h/core.start.json" "$mode"
    exec python3 -c 'import os, socket, sys, time
h = sys.argv[1]; s = socket.socket(socket.AF_UNIX); s.bind(h + "/core.sock")
while not os.path.exists(h + "/stop"): time.sleep(0.1)
os.unlink(h + "/core.sock")' "$h" ;;
  "serve status") [ -S "$h/core.sock" ] && echo '{"core":true,"holders":[]}' || echo '{"core":false,"holders":[]}' ;;
  "serve stop")
    : > "$h/stop"; i=0; while [ -S "$h/core.sock" ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done ;;
  "session start")
    shift 2; echo "$*" > "$HOME/session-args"
    case $mode in *" noprompt "*) ;; *) printf 'stub%% ' > "$h/out" ;; esac
    "$self" holder </dev/null >/dev/null 2>&1 &
    echo '{"type":"started","session":{"id":"s1","label":"gate-app-boot"}}' ;;
  "holder ")
    case $mode in *" stubborn "*) trap '' TERM; while :; do sleep 0.1; done ;; esac
    while [ ! -e "$h/stop" ]; do sleep 0.1; done ;;
  "session send-text") printf '%s' "$4" >> "$h/typed" ;;
  "session send-keys")
    case $mode in *" noprint "*) ;; *) sh -c "$(cat "$h/typed")" >> "$h/out" 2>&1 ;; esac; : > "$h/typed" ;;
  "session read")
    python3 -c 'import json, sys
d = open(sys.argv[1], "rb").read() if __import__("os").path.exists(sys.argv[1]) else b""
print(json.dumps({"type": "output", "data": list(d), "start": 0, "end": len(d), "truncated": False}))' "$h/out" ;;
  "session close") : > "$h/closed" ;;
  "decoy ") while :; do sleep 0.2; done ;;
  *) echo "stub cli: $*" >&2; exit 2 ;;
esac
"""

OPEN_PY = r"""#!/usr/bin/env python3
import os, plistlib, subprocess, sys
a = sys.argv[1:]
home = os.environ["HOME"]
with open(os.path.join(home, "open.log"), "a") as log:
    log.write("\n".join(a) + "\n--\n")
env = {"HOME": home, "PATH": os.environ["PATH"]}
out, i = os.devnull, 0
while i < len(a) - 1:
    if a[i] == "--env":
        k, v = a[i + 1].split("=", 1)
        env[k] = v
        i += 2
    elif a[i] in ("--stdout", "--stderr"):
        out = a[i + 1]
        i += 2
    else:
        i += 1
app = a[-1]
with open(os.path.join(app, "Contents/Info.plist"), "rb") as f:
    exe = os.path.join(app, "Contents/MacOS", plistlib.load(f)["CFBundleExecutable"])
f = open(out, "ab")
subprocess.Popen([exe], env=env, stdin=subprocess.DEVNULL, stdout=f, stderr=f, start_new_session=True, cwd="/")
"""

LSAPPINFO = r"""#!/bin/sh
f=$HOME/front
[ -f "$f" ] || echo "ASN:0x0-0x11:" > "$f"
case $1 in
  front) cat "$f" ;;
  info)
    case $4 in
      ASN:0x0-0x99:) name="Nunchiro RC"; pid=$(cat "$HOME/front.pid") ;;
      ASN:0x0-0x55:) name=Other; pid=55 ;;
      *) name=Term; pid=11 ;;
    esac
    printf '"%s" %s (in front) \n    bundleID=[ NULL ] \n    pid = %s !cgsConnection !signalled\n' "$name" "$4" "$pid" ;;
esac
"""

# The stage no longer shoots the screen (it needs a grant an ssh login lacks); a call is logged so a test can see none.
SCREENCAPTURE = r"""#!/bin/sh
echo "$*" >> "$HOME/screencapture.log"
exit 1
"""

AX_STUB = r"""#!/bin/sh
case $1 in
  access) if [ -e "$HOME/no-screen" ]; then echo "screen no"; else echo "screen yes"; fi ;;
  screen) [ ! -e "$HOME/screen-fails" ] || exit 1; cat "$HOME/screen" 2>/dev/null || echo "locked no asleep no console yes" ;;
  window) case " $(cat "$HOME/mode" 2>/dev/null) " in *" nowindow "*) exit 1 ;; esac; echo "77 0 0 1440 900" ;;
  pixel) echo "#000000 2880 1800" ;;
  bbox) echo "$*" >> "$HOME/bbox.log"; if [ "$(cat "$2")" = blank ]; then echo none; else echo "10 100 50 50"; fi ;;
  *) exit 1 ;;
esac
"""

# The build: pnpm (web build, tauri build), cargo and codesign; the bundle id comes from the --config file given.
PNPM = r"""#!/bin/sh
echo "pnpm $*" >> "$HOME/build.log"
case "$*" in
  "--filter nunchiro-web build") ;;
  "exec tauri build "*)
    conf=; for a; do case $a in *.json) conf=$a ;; esac; done
    id=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["identifier"])' "$conf")
    b="$CARGO_TARGET_DIR/debug/bundle/macos/Nunchiro RC.app"
    mkdir -p "$b/Contents/MacOS"
    python3 -c 'import plistlib, sys; plistlib.dump({"CFBundleIdentifier": sys.argv[2], "CFBundleExecutable": "nunchiro-app"}, open(sys.argv[1], "wb"))' "$b/Contents/Info.plist" "$id"
    cp "$STUB_DIR/launcher" "$b/Contents/MacOS/nunchiro-app"; cp "$STUB_DIR/app.sh" "$b/Contents/MacOS/nunchiro-app.sh"
    # The script copies only the CLI binary (here the launcher) next to the window; its stub body rides in the bundle.
    cp "$STUB_DIR/cli.sh" "$b/Contents/MacOS/nunchiro.sh" ;;
  *) exit 2 ;;
esac
"""

CARGO = r"""#!/bin/sh
echo "cargo $* NUNCHIRO_BUILD=${NUNCHIRO_BUILD:-} CARGO_TARGET_DIR=$CARGO_TARGET_DIR" >> "$HOME/build.log"
mkdir -p "$CARGO_TARGET_DIR/debug"
cp "$STUB_DIR/launcher" "$CARGO_TARGET_DIR/debug/nunchiro"; cp "$STUB_DIR/cli.sh" "$CARGO_TARGET_DIR/debug/nunchiro.sh"
"""

CODESIGN = r"""#!/bin/sh
if [ -e "$HOME/adhoc" ]; then echo "Signature=adhoc" >&2; else echo "Authority=Nunchiro Local Code Signing" >&2; fi
"""

# The volume the worktree is on: the real diskutil, unless the test wrote $HOME/disk (an external volume).
DISKUTIL = r"""#!/bin/sh
if [ -e "$HOME/disk" ]; then
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Internal</key><false/>'
  printf '<key>RemovableMedia</key><true/><key>Ejectable</key><true/></dict></plist>\n'
else
  exec /usr/sbin/diskutil "$@"
fi
"""

SWIFTC = r"""#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
echo "$out" >> "$HOME/swiftc.log"
cp "$(dirname "$0")/ax-stub" "$out" && chmod +x "$out"
"""


def write(path, text, mode=0o755):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


class Fixture(unittest.TestCase):
    """Stubs and helpers; the tests are split into classes so the scenario runner runs them side by side."""

    @classmethod
    def setUpClass(cls):
        # /tmp, not the worktree: the temp home must stay short enough for a holder socket (the script checks).
        cls.base = Path(tempfile.mkdtemp(prefix="gab", dir="/tmp")).resolve()
        src = cls.base / "launcher.c"
        src.write_text(LAUNCHER_C)
        cls.launcher = cls.base / "launcher"
        subprocess.run(["cc", "-O", "-o", str(cls.launcher), str(src)], check=True, capture_output=True)
        cls.bin = cls.base / "bin"
        write(cls.bin / "open", OPEN_PY)
        write(cls.bin / "lsappinfo", LSAPPINFO)
        write(cls.bin / "screencapture", SCREENCAPTURE)
        write(cls.bin / "swiftc", SWIFTC)
        write(cls.bin / "ax-stub", AX_STUB)
        write(cls.bin / "pnpm", PNPM)
        write(cls.bin / "cargo", CARGO)
        write(cls.bin / "codesign", CODESIGN)
        write(cls.bin / "diskutil", DISKUTIL)
        write(cls.base / "app.sh", APP_SH)
        write(cls.base / "cli.sh", CLI_SH)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="c", dir=self.base))
        self.home = self.case / "u"
        self.home.mkdir()
        (self.home / "front").write_text("ASN:0x0-0x11:\n")
        # Registered first, so it runs last: after every process this test started was stopped, pass or fail.
        self.addCleanup(self.nothing_left)

    def nothing_left(self):
        """No process of this case is left: not the stage's (its run folder) and not the test's own look-alikes."""
        try:
            left = []
            for _ in range(50):
                left = self.case_processes()
                if not left:
                    break
                time.sleep(0.1)
            self.assertEqual(left, [], "a process started by this test or its stage outlived it")
        finally:
            shutil.rmtree(self.case, ignore_errors=True)

    def case_processes(self):
        out = subprocess.run(["ps", "-axww", "-o", "pid=,args="], capture_output=True, text=True).stdout
        return [l.strip() for l in out.splitlines() if str(self.case) + "/" in l]

    def own(self, argv, **kw):
        """Starts a process of the test itself and stops it, with every process under it, when the test ends (pass or
        fail). The stub launcher cannot forward KILL, so killing only its PID would orphan its /bin/sh child."""
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
        self.addCleanup(self.stop_tree, p)
        return p

    @staticmethod
    def tree(root):
        """root and its descendants still running, deepest first, from one `ps` listing of pid and ppid."""
        out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout
        kids = {}
        for pid, ppid in (map(int, l.split()) for l in out.splitlines()):
            kids.setdefault(ppid, []).append(pid)
        alive = {pid for pids in kids.values() for pid in pids}
        order, todo = [], [root] if root in alive else []
        while todo:
            pid = todo.pop()
            order.append(pid)
            todo.extend(kids.get(pid, []))
        return order[::-1]

    def stop_tree(self, p):
        """Once `p` is reaped its PID may be reused, so it is never looked up again; what was under it was signalled in
        the same pass, children first, and the end-of-test check (`nothing_left`) catches anything left."""
        for _ in range(20):
            if p.poll() is not None:
                break
            recorded = self.tree(p.pid)
            if not recorded:
                break
            for pid in recorded:  # children before their parent, so none is orphaned first
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    @staticmethod
    def end_stage(stage):
        """A stage left running by a failed test gets TERM, which its own trap turns into the full stop."""
        if stage.poll() is None:
            stage.terminate()
            try:
                stage.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                stage.kill()
                stage.communicate()

    # --- fixtures ---
    def repo(self, at=None):
        root = Path(at) if at else self.case / "w"
        (root / "scripts/app-click").mkdir(parents=True)
        shutil.copy2(SCRIPT, root / "scripts/gate-app-boot.sh")
        shutil.copy2(AX_SRC, root / "scripts/app-click/ax.swift")
        return root

    def app(self, root, where=None, bundle_id=RC_ID):
        app = Path(where) if where else root / ".scratch/gate-app-boot" / NAME
        macos = app / "Contents/MacOS"
        macos.mkdir(parents=True)
        with open(app / "Contents/Info.plist", "wb") as f:
            plistlib.dump({"CFBundleIdentifier": bundle_id, "CFBundleExecutable": "nunchiro-app",
                           "CFBundleName": "Nunchiro RC"}, f)
        for exe, sh in (("nunchiro-app", APP_SH), ("nunchiro", CLI_SH)):
            shutil.copy2(self.launcher, macos / exe)
            write(macos / f"{exe}.sh", sh)
        return app

    def mode(self, *words):
        (self.home / "mode").write_text(" ".join(words))

    def env(self, wait=3, extra_env=None):
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:{os.path.dirname(sys.executable)}:/usr/bin:/bin:/usr/sbin:/sbin",
               "GATE_APP_BOOT_WAIT": str(wait), "NUNCHIRO_TOKEN": "leaked-token", "TMPDIR": str(self.case),
               "STUB_DIR": str(self.base)}
        env.update(extra_env or {})
        return env

    def run_stage(self, root, *args, wait=3, extra_env=None):
        env = self.env(wait, extra_env)
        args = [a for a in args if a] if args else ["run"]
        return subprocess.run(["sh", str(root / "scripts/gate-app-boot.sh"), *args], env=env,
                              capture_output=True, text=True, timeout=120)

    def leftovers(self):
        out = subprocess.run(["ps", "-axww", "-o", "pid=,args="], capture_output=True, text=True).stdout
        return [l for l in out.splitlines() if str(self.case) + "/" in l and "/.scratch/gate-app-boot/r." in l]

    def decoy(self, app):
        """A look-alike: the same stub CLI, run from the source bundle (outside the run folder), not by the stage."""
        return self.own([str(app / "Contents/MacOS/nunchiro"), "decoy"], env={**os.environ, "HOME": str(self.home)})

    def runs(self, root):
        """What a run leaves: run folders and temp homes (both removed at the end)."""
        out = root / ".scratch/gate-app-boot"
        found = sorted(p.name for p in out.glob("r.*")) if out.is_dir() else []
        scratch = root / ".scratch"
        return found + (sorted(p.name for p in scratch.glob("g??????")) if scratch.is_dir() else [])

    def assert_step(self, r, step, code=1, root=None):
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        self.assertRegex(r.stderr, rf"(?m)^gate-app-boot: {re.escape(step)}: ")
        # Ticket 487: every exit 1 leaves the failing step in .scratch/gate-app-boot/failed for gate-failures.sh;
        # any other exit leaves no marker. Every worktree a test makes is under self.case.
        marks = [p for p in self.case.rglob("failed") if p.parent.name == "gate-app-boot"]
        if code == 1:
            self.assertEqual(len(marks), 1, marks)
            self.assertEqual(marks[0].read_bytes(), step.encode() + b"\n")
        else:
            self.assertEqual(marks, [], f"exit {code} left a failure marker")

    def assert_nothing_started(self):
        self.assertFalse((self.home / "open.log").exists(), "the app was opened")


class Pass(Fixture):
    def test_pass_boots_on_temp_home_and_cleans_up(self):
        root = self.repo()
        app = self.app(root)
        decoy = self.decoy(app)
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stderr, r"gate-app-boot: pass: launch \d+s, core \d+s, window \d+s, shell \d+s, total \d+s")
        # Opened in the background, a new instance, fresh, with this run's home and CLI, and nothing inherited.
        opened = (self.home / "open.log").read_text().split("\n--\n")[0].splitlines()
        for flag in ("-g", "-n"):
            self.assertIn(flag, opened)
        # Not -a (an app by name could be the owner's) and not -F (it deletes the bundle id's saved state).
        self.assertNotIn("-a", opened)
        self.assertNotIn("-F", opened)
        home = (self.home / "app-home").read_text().strip()
        # The home is a short folder of its own (review r1 MUST 1); the app copy lives in the run folder.
        self.assertRegex(home, "^" + re.escape(str(root)) + r"/\.scratch/g[A-Za-z0-9]{6}$")
        self.assertIn(f"NUNCHIRO_HOME={home}", opened)
        self.assertIn("NUNCHIRO_GATE_RUN=1", opened)
        bins = [a for a in opened if a.startswith("NUNCHIRO_BIN=")]
        self.assertEqual(len(bins), 1)
        self.assertRegex(bins[0], "^NUNCHIRO_BIN=" + re.escape(str(root)) +
                         r"/\.scratch/gate-app-boot/r\.[A-Za-z0-9]{6}/Nunchiro RC\.app/Contents/MacOS/nunchiro$")
        self.assertNotIn("NUNCHIRO_TOKEN", (self.home / "app-env").read_text())
        # The picture is the page's own (no screen capture), checked whole: the traffic lights are not in it.
        self.assertRegex((self.home / "bbox.log").read_text(), r"^bbox \S+/shot\.png 0 0 2880 1800$")
        self.assertFalse((self.home / "screencapture.log").exists(), "the stage shot the screen")
        self.assertIn("NUNCHIRO_GATE_BLANK=0", opened)
        # No prompt: the core keeps no start secrets in a keychain, and the CLI calls say the same.
        self.assertIn("NUNCHIRO_KEYCHAIN=", opened)
        self.assertNotIn("owner step", r.stderr)
        self.assertNotIn("note: ad hoc", r.stderr)
        self.assertEqual((root / ".scratch/gate-app-boot/window-last.png").read_text().strip(), "drawn")
        # The shell was zsh without startup files, and the run folder (the temp home with it) is gone.
        self.assertEqual(self.runs(root), [])
        self.assertIsNone(decoy.poll(), "the stage stopped a process it did not start")
        self.assertEqual(self.leftovers(), [])

    def test_session_is_a_shell_without_startup_files(self):
        root = self.repo()
        self.app(root)
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        args = (self.home / "session-args").read_text().split()
        self.assertEqual(args[:2], ["--kind", "shell"])
        self.assertEqual(args[-3:], ["--", "/bin/zsh", "-f"])
        # The CLI never ran with the gate's own session token.
        self.assertFalse((self.home / "cli-token-leak").exists())


class BootSteps(Fixture):
    """The step each failure names, up to the window."""

    def test_launch_fails_when_the_app_exits(self):
        root = self.repo()
        self.app(root)
        self.mode("exit")
        r = self.run_stage(root)
        self.assert_step(r, "launch")
        self.assertEqual(self.runs(root), [])

    def test_core_fails_when_no_core_answers(self):
        root = self.repo()
        self.app(root)
        self.mode("nocore")
        r = self.run_stage(root)
        self.assert_step(r, "core")
        self.assertIn("no core answered on", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_core_fails_when_started_from_another_cli(self):
        root = self.repo()
        self.app(root)
        self.mode("foreign")
        r = self.run_stage(root)
        self.assert_step(r, "core")
        self.assertIn("runs /usr/bin/true, not this run's CLI", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_window_fails_when_blank(self):
        root = self.repo()
        self.app(root)
        self.mode("blank")
        r = self.run_stage(root)
        self.assert_step(r, "window")
        self.assertIn("did not draw", r.stderr)
        self.assertEqual((root / ".scratch/gate-app-boot/window-blank.png").read_text().strip(), "blank")
        self.assertEqual(self.runs(root), [])

    def test_window_fails_when_the_page_writes_no_picture(self):
        root = self.repo()
        self.app(root)
        self.mode("noshot")
        r = self.run_stage(root)
        self.assert_step(r, "window")
        self.assertEqual(self.runs(root), [])

    def test_blank_request_reaches_the_app_and_fails_the_window(self):
        """The red check: GATE_APP_BOOT_BLANK=1 asks the gate run to hide its page, and the stage must catch it."""
        root = self.repo()
        self.app(root)
        r = self.run_stage(root, extra_env={"GATE_APP_BOOT_BLANK": "1"})
        self.assert_step(r, "window")
        opened = (self.home / "open.log").read_text().split("\n--\n")[0].splitlines()
        self.assertIn("NUNCHIRO_GATE_BLANK=1", opened)
        self.assertEqual((root / ".scratch/gate-app-boot/window-blank.png").read_text().strip(), "blank")
        self.assertEqual(self.runs(root), [])

    def test_window_fails_when_missing(self):
        root = self.repo()
        self.app(root)
        self.mode("nowindow")
        self.assert_step(self.run_stage(root), "window")
        self.assertEqual(self.runs(root), [])


class LaterSteps(Fixture):
    """The step each failure names, from the session on, and the permission and usage exits."""

    def test_session_fails_when_the_shell_prints_nothing(self):
        root = self.repo()
        self.app(root)
        for mode, cause in (("noprompt", "printed nothing (no prompt)"), ("noprint", "the shell did not print gateok")):
            with self.subTest(mode=mode):
                self.mode(mode)
                r = self.run_stage(root)
                self.assert_step(r, "session")
                self.assertIn(cause, r.stderr)
                self.assertEqual(self.runs(root), [])

    def test_frontmost_fails_when_the_rc_takes_the_front(self):
        root = self.repo()
        self.app(root)
        self.mode("steal")
        r = self.run_stage(root)
        self.assert_step(r, "frontmost")
        self.assertIn("became the frontmost app", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_frontmost_fails_when_the_front_app_changed(self):
        root = self.repo()
        self.app(root)
        self.mode("switch")
        r = self.run_stage(root)
        # gate-app-boot-front: the RC never was front nor active, so this is the person at the machine: exit 4.
        self.assert_step(r, "frontmost", 4)
        self.assertIn("Term before, Other after, and the RC never was the front or active app", r.stderr)

    def test_frontmost_fails_when_the_rc_became_active_between_polls(self):
        """gate-app-boot-front: the RC's own record of an activation fails the stage even when no poll saw it in front
        (the 11-12 MacBook run: the front read the same at every poll, then Finder took it when the RC quit)."""
        root = self.repo()
        self.app(root)
        self.mode("activates")
        r = self.run_stage(root)
        self.assert_step(r, "frontmost")
        self.assertIn("became the active app (1 time(s), first at 1794460000.25)", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_frontmost_fails_when_the_rc_became_active_while_quitting(self):
        root = self.repo()
        self.app(root)
        self.mode("activatesatquit")
        r = self.run_stage(root)
        self.assert_step(r, "frontmost")
        self.assertIn("became the active app (1 time(s), first at 1794460009.50)", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_passes_without_screen_recording(self):
        """gate-app-boot-ssh: an ssh login has no Screen Recording grant (`ax access` says no); the stage passes anyway,
        since the picture is the page's own, and neither asks for the grant nor shoots the screen."""
        root = self.repo()
        self.app(root)
        (self.home / "no-screen").write_text("")
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, r"gate-app-boot: pass: ")
        self.assertNotIn("Screen Recording", r.stderr)
        self.assertNotIn("owner step", r.stderr)
        self.assertFalse((self.home / "screencapture.log").exists(), "the stage shot the screen")
        self.assertNotIn("Screen & System Audio Recording", SCRIPT.read_text())
        self.assertEqual(self.runs(root), [])

    SKIP = r"(?m)^gate-app-boot: skipped: {} at the {} step \(a machine state; the coordinator's RC check covers this build\)$"

    def git_repo(self, root):
        git = ["git", "-C", str(root), "-c", "user.name=gate", "-c", "user.email=gate@example.invalid"]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "add", "scripts"], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "candidate"], check=True)
        return subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

    def test_screen_state_before_launch_is_skipped(self):
        """Round 3 (coordinator): a locked screen, a sleeping display or a session off the console is a machine state.
        The stage says so loudly, logs it with the candidate sha and time, starts nothing and passes (exit 0)."""
        root = self.repo()
        self.app(root)
        sha = self.git_repo(root)
        states = (("locked yes asleep no console yes", "the screen is locked"),
                  ("locked no asleep yes console yes", "the display is asleep"),
                  ("locked no asleep no console no", "this user's session is not on the console"))
        for state, why in states:
            with self.subTest(state=state):
                (self.home / "screen").write_text(state + "\n")
                r = self.run_stage(root)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertRegex(r.stderr, self.SKIP.format(re.escape(why), "launch"))
                self.assertNotIn("pass:", r.stderr)
                self.assert_nothing_started()
                self.assertEqual(self.runs(root), [])
        log = (root / ".scratch/gate-app-boot/skips.log").read_text().splitlines()
        self.assertEqual(len(log), 3)
        for line, (_, why) in zip(log, states):
            self.assertRegex(line, self.SKIP.format(re.escape(why), "launch")[4:-1] +
                             rf" sha={sha} time=\d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_screen_locking_during_the_window_step_is_skipped_after_the_stop(self):
        root = self.repo()
        self.app(root)
        self.mode("lockscreen")
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, self.SKIP.format("the screen is locked", "window"))
        # Not a git repo here: the sha is written as unknown, and what the run started is stopped.
        self.assertRegex((root / ".scratch/gate-app-boot/skips.log").read_text(), r" sha=unknown time=\S+Z\n$")
        self.assertEqual(self.runs(root), [])
        self.assertEqual(self.leftovers(), [])

    def test_unreadable_screen_state_is_not_a_skip(self):
        root = self.repo()
        self.app(root)
        (self.home / "screen-fails").write_text("")
        r = self.run_stage(root)
        self.assert_step(r, "screen", 4)
        self.assertIn("unknown", r.stderr)
        self.assert_nothing_started()

    def test_ad_hoc_app_runs_with_a_note(self):
        """Round 2 (coordinator): no grant has to hold across builds, so an ad hoc signature is a note, not exit 4."""
        root = self.repo()
        self.app(root)
        (self.home / "adhoc").write_text("")
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr.count("gate-app-boot: note: ad hoc signature (no local signing identity)\n"), 1)
        self.assertRegex(r.stderr, r"gate-app-boot: pass: ")
        self.assertNotIn("owner step", r.stderr)
        self.assertIn("\n# No owner step", SCRIPT.read_text())
        self.assertEqual(self.runs(root), [])

    def test_core_without_an_empty_keychain_fails(self):
        root = self.repo()
        self.app(root)
        self.mode("keychain")
        r = self.run_stage(root)
        self.assert_step(r, "core")
        self.assertIn("NUNCHIRO_KEYCHAIN", r.stderr)
        self.assertEqual(self.runs(root), [])

    def test_removable_volume_exits_4_before_launch(self):
        root = self.repo()
        self.app(root)
        (self.home / "disk").write_text("")
        r = self.run_stage(root)
        self.assert_step(r, "volume", 4)
        self.assertIn("removable or external volume", r.stderr)
        self.assert_nothing_started()

    def test_guarded_folder_exits_4_before_launch(self):
        for folder in ("Documents", "Desktop", "Downloads"):
            with self.subTest(folder=folder):
                root = self.repo(self.home / folder / "w")
                self.app(root)
                r = self.run_stage(root)
                self.assert_step(r, "volume", 4)
                self.assertIn(f"~/{folder}", r.stderr)
                self.assert_nothing_started()

    def test_usage(self):
        root = self.repo()
        for args in (("nope",), ("run", "a", "b"), ("build", "x")):
            r = self.run_stage(root, *args)
            self.assert_step(r, "usage", 2)


class Stop(Fixture):
    def test_stubborn_process_gets_kill_and_decoy_survives(self):
        root = self.repo()
        app = self.app(root)
        decoy = self.decoy(app)
        self.mode("stubborn")
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("sent TERM", r.stderr)
        self.assertIn("sent KILL", r.stderr)
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.runs(root), [])
        self.assertIsNone(decoy.poll())

    def test_lookalike_argv0_in_the_run_folder_is_not_signalled(self):
        """Review r1 SHOULD 2: `ps comm` is argv[0], which any process can set. A process started outside the run, whose
        argv[0] names the run's own app executable, must survive the stop: the real executable path decides."""
        root = self.repo()
        self.app(root)
        self.mode("waitspoof")
        stage = subprocess.Popen(["sh", str(root / "scripts/gate-app-boot.sh"), "run"], env=self.env(),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.end_stage, stage)
        runexe = self.home / "runexe"
        for _ in range(200):
            if runexe.exists() and runexe.read_text().strip():
                break
            time.sleep(0.05)
        exe = runexe.read_text().strip()
        self.assertIn("/.scratch/gate-app-boot/r.", exe)
        spoof = self.own([sys.executable, "-c", "import os, sys; os.execv('/bin/sleep', [sys.argv[1], '120'])", exe])
        for _ in range(100):
            ps = subprocess.run(["ps", "-o", "comm=", "-p", str(spoof.pid)], capture_output=True, text=True).stdout
            if ps.strip() == exe:
                break
            time.sleep(0.05)
        (self.home / "spoofed").write_text("")
        out, err = stage.communicate(timeout=120)
        self.assertEqual(stage.returncode, 0, err)
        self.assertIsNone(spoof.poll(), "the stage signalled a process it did not start")
        self.assertNotIn("sent TERM", err)

    def test_stop_logic_signals_only_recorded_pids(self):
        script = SCRIPT.read_text()
        self.assertNotRegex(script, r"\b(pkill|killall)\b")
        for kill in re.findall(r".*\bkill\b.*", script):
            if kill.lstrip().startswith("#"):
                continue
            self.assertRegex(kill, r'kill (-TERM|"-\$1"|-0) "?\$(p|app_pid)"?', kill)


class Build(Fixture):
    def build_repo(self, rc_id=RC_ID):
        root = self.repo()
        conf = root / "app/src-tauri/tauri.rc.conf.json"
        conf.parent.mkdir(parents=True)
        conf.write_text('{"identifier": "%s", "productName": "Nunchiro RC"}' % rc_id)
        write(root / "scripts/local-signing.sh", '#!/bin/sh\necho "sign $*" >> "$HOME/build.log"\n')
        return root

    def test_build_then_stage(self):
        root = self.build_repo()
        r = self.run_stage(root, "build")
        self.assertEqual(r.returncode, 0, r.stderr)
        app = root / ".scratch/gate-app-boot" / NAME
        self.assertEqual(r.stdout.strip(), str(app))
        self.assertRegex(r.stderr, r"gate-app-boot: build: web \d+s, tauri \d+s, cli \d+s, total \d+s")
        log = (self.home / "build.log").read_text()
        target = root / ".scratch/gate-app-boot/target"
        self.assertIn("pnpm exec tauri build --debug --bundles app --config src-tauri/tauri.rc.conf.json\n", log)
        self.assertIn(f"cargo build --locked -p nunchiro NUNCHIRO_BUILD=1 CARGO_TARGET_DIR={target}\n", log)
        self.assertIn(f"sign {app}\n", log)
        self.assertTrue(os.access(app / "Contents/MacOS/nunchiro", os.X_OK))
        # No argument: build, then the stage on that build.
        r = self.run_stage(root, "")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, r"build took \d+s[\s\S]*gate-app-boot: pass: ")
        self.assertEqual(self.runs(root), [])

    def test_build_ad_hoc_signature_runs_with_one_note(self):
        root = self.build_repo()
        (self.home / "adhoc").write_text("")
        r = self.run_stage(root, "")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr.count("gate-app-boot: note: ad hoc signature (no local signing identity)\n"), 1)
        self.assertRegex(r.stderr, r"build took \d+s[\s\S]*gate-app-boot: pass: ")
        self.assertEqual(self.runs(root), [])

    def test_build_refuses_another_bundle_id(self):
        root = self.build_repo("dev.nunchiro.app")
        r = self.run_stage(root, "build")
        self.assert_step(r, "build", 3)
        self.assertIn("refused: the bundle id is dev.nunchiro.app", r.stderr)


class Marker(Fixture):
    """Ticket 487: the marker is this run's: removed at the start of every run (pass, skip, any exit), written only on
    exit 1, and a marker the script cannot remove makes it exit 75 (infra) rather than leave an old name behind."""

    def plant(self, root, text="core\n"):
        m = root / ".scratch/gate-app-boot/failed"
        m.parent.mkdir(parents=True, exist_ok=True)
        m.write_text(text)
        return m

    def test_pass_removes_an_old_marker(self):
        root = self.repo()
        self.app(root)
        m = self.plant(root)
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(m.exists(), "a pass left the old marker")

    def test_skip_and_exit_4_remove_an_old_marker(self):
        root = self.repo()
        self.app(root)
        m = self.plant(root)
        (self.home / "screen").write_text("locked yes asleep no console yes\n")
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("skipped:", r.stderr)
        self.assertFalse(m.exists(), "a skip left the old marker")
        (self.home / "screen").unlink()
        self.plant(root)
        (self.home / "disk").write_text("")
        self.assert_step(self.run_stage(root), "volume", 4)

    def test_build_failure_writes_the_build_step(self):
        root = self.repo()  # no tauri config, no local-signing.sh: the build fails
        write(self.bin.parent / "nopnpm" / "pnpm", "#!/bin/sh\nexit 1\n")
        self.plant(root, "window\n")
        started = root / ".scratch/gate-app-boot/started"
        started.write_text("")
        os.utime(started, (1, 1))  # an earlier run's
        r = self.run_stage(root, "", extra_env={"PATH": f"{self.bin.parent / 'nopnpm'}:{self.env()['PATH']}"})
        self.assert_step(r, "build")
        shutil.rmtree(self.bin.parent / "nopnpm")
        # ticket 495: this run wrote `started` before `failed`, which gate-failures.sh requires
        failed = root / ".scratch/gate-app-boot/failed"
        self.assertGreater(started.stat().st_mtime, 1)
        self.assertGreaterEqual(failed.stat().st_mtime, started.stat().st_mtime)

    def test_usage_removes_an_old_started(self):
        root = self.repo()
        self.plant(root)
        started = root / ".scratch/gate-app-boot/started"
        started.write_text("")
        self.assert_step(self.run_stage(root, "nope"), "usage", 2)
        self.assertFalse(started.exists(), "an earlier run's started survived a run")

    def test_usage_and_refusal_leave_no_marker(self):
        root = self.repo()
        self.plant(root)
        self.assert_step(self.run_stage(root, "nope"), "usage", 2)
        self.plant(root)
        wrong = self.app(root, self.case / "wrong" / NAME, bundle_id="dev.nunchiro.app")
        self.assert_step(self.run_stage(root, "run", str(wrong)), "app", 3)

    def test_marker_through_a_symlink_is_never_written(self):
        # own_dir refuses a linked .scratch/gate-app-boot (exit 3) before anything is written through it
        root = self.repo()
        (root / ".scratch").mkdir()
        target = self.case / "elsewhere"
        target.mkdir()
        (root / ".scratch/gate-app-boot").symlink_to(target)
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual(list(target.iterdir()), [])

    @unittest.skipUnless(hasattr(os, "chflags"), "chflags uchg is BSD/macOS")
    def test_marker_that_cannot_be_removed_is_infra(self):
        root = self.repo()
        self.app(root)
        m = self.plant(root)
        os.chflags(m, __import__("stat").UF_IMMUTABLE)
        self.addCleanup(lambda: m.exists() and os.chflags(m, 0))
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 75, r.stderr)
        self.assertRegex(r.stderr, r"(?m)^gate-app-boot: marker: cannot remove ")
        self.assert_nothing_started()


class TargetDir(Fixture):
    """Ticket 487: GATE_APP_BOOT_TARGET_DIR (opt-in) moves the cargo target out of the worktree, so a gate worktree
    cleaned with `git clean -ffdx` keeps a warm build. Refused (exit 3, nothing built): a relative path, a path in or
    above the worktree, $HOME itself, the owner's Nunchiro home, or a link leading to one of those."""

    def build_repo(self):
        root = self.repo()
        conf = root / "app/src-tauri/tauri.rc.conf.json"
        conf.parent.mkdir(parents=True)
        conf.write_text('{"identifier": "%s", "productName": "Nunchiro RC"}' % RC_ID)
        write(root / "scripts/local-signing.sh", '#!/bin/sh\necho "sign $*" >> "$HOME/build.log"\n')
        return root

    def test_unset_keeps_the_worktree_target(self):
        root = self.build_repo()
        r = self.run_stage(root, "build", extra_env={"GATE_APP_BOOT_TARGET_DIR": ""})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"CARGO_TARGET_DIR={root}/.scratch/gate-app-boot/target\n", (self.home / "build.log").read_text())

    def test_builds_into_the_given_dir_and_runs_from_the_worktree_copy(self):
        root = self.build_repo()
        cache = self.case / "cache" / "gab"  # made when missing
        r = self.run_stage(root, "", extra_env={"GATE_APP_BOOT_TARGET_DIR": str(cache)})
        self.assertEqual(r.returncode, 0, r.stderr)
        log = (self.home / "build.log").read_text()
        self.assertIn(f"cargo build --locked -p nunchiro NUNCHIRO_BUILD=1 CARGO_TARGET_DIR={cache}\n", log)
        self.assertNotIn(f"{root}/.scratch/gate-app-boot/target", log)
        self.assertTrue((cache / "debug/bundle/macos" / NAME / "Contents/Info.plist").is_file())
        # the stage runs the copy in the worktree, never the shared bundle
        self.assertTrue((root / ".scratch/gate-app-boot" / NAME / "Contents/Info.plist").is_file())
        self.assertIn(str(root / ".scratch/gate-app-boot/r."), (self.home / "open.log").read_text())
        self.assertNotIn(str(cache), (self.home / "open.log").read_text())
        self.assertRegex(r.stderr, rf"gate-app-boot: build: target {re.escape(str(cache))}")
        self.assertRegex(r.stderr, r"gate-app-boot: pass: ")

    def test_held_lock_gives_up_with_75(self):
        # ticket 495: another build holding the shared target past GATE_APP_BOOT_LOCK_WAIT is infra (75), not a wait
        # until the gate's own timeout. The old script waits for good: the 30 s timeout below fails it.
        root = self.build_repo()
        cache = self.case / "cache"
        cache.mkdir()
        with open(cache / ".gate-app-boot.lock", "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            t0 = time.monotonic()
            r = subprocess.run(["sh", str(root / "scripts/gate-app-boot.sh"), "build"], capture_output=True, text=True,
                               timeout=30, env=self.env(extra_env={"GATE_APP_BOOT_TARGET_DIR": str(cache),
                                                                   "GATE_APP_BOOT_LOCK_WAIT": "2"}))
            took = time.monotonic() - t0
        self.assert_step(r, "build", 75)
        self.assertIn("gate-app-boot: build: waiting for another build in", r.stderr)
        self.assertRegex(r.stderr, r"(?m)^gate-app-boot: build: another build held .* for over 2s ")
        self.assertLess(took, 20)
        self.assertFalse((self.home / "build.log").exists(), "built without the lock")
        # the lock free again: the same run builds
        r = self.run_stage(root, "build", extra_env={"GATE_APP_BOOT_TARGET_DIR": str(cache),
                                                     "GATE_APP_BOOT_LOCK_WAIT": "2"})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_target_over_the_cap_is_trimmed_inside_only(self):
        # ticket 495: the shared target must not grow without end; only names inside it go, never a link's target
        root = self.build_repo()
        cache = self.case / "cache"
        outside = self.case / "outside"
        outside.mkdir()
        (outside / "keep").write_bytes(b"x" * 2_000_000)
        env = {"GATE_APP_BOOT_TARGET_DIR": str(cache)}
        inc = cache / "debug/incremental"
        inc.mkdir(parents=True)
        (inc / "big").write_bytes(b"x" * 2_000_000)
        (inc / "link").symlink_to(outside)
        # under the default cap (8192 MB): nothing removed
        r = self.run_stage(root, "build", extra_env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((inc / "big").exists())
        # over a 1 MB cap: debug/incremental goes; the rest (here about 0 MB) is under, so debug stays
        r = self.run_stage(root, "build", extra_env={**env, "GATE_APP_BOOT_TARGET_MAX_MB": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, r"(?m)^gate-app-boot: build: target .* over 1 MB: removing debug/incremental$")
        self.assertFalse(inc.exists())
        self.assertTrue((cache / "debug/bundle/macos" / NAME).is_dir())
        # still over after that: all of debug goes, the lock file stays
        deps = cache / "debug/deps"
        deps.mkdir(parents=True, exist_ok=True)
        (deps / "big").write_bytes(b"x" * 2_000_000)
        (deps / "link").symlink_to(outside)
        r = self.run_stage(root, "", extra_env={**env, "GATE_APP_BOOT_TARGET_MAX_MB": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, r"(?m)^gate-app-boot: build: target .* removing debug$")
        self.assertFalse((cache / "debug").exists())
        self.assertTrue((cache / ".gate-app-boot.lock").exists())
        self.assertRegex(r.stderr, r"gate-app-boot: pass: ")  # the stage ran the worktree copy, made before the trim
        self.assertEqual((outside / "keep").stat().st_size, 2_000_000)
        self.assertTrue(root.exists() and (root / "scripts/gate-app-boot.sh").exists())

    def test_target_with_debug_as_a_link_is_not_trimmed(self):
        # review r1 MUST 1: rm -rf <target>/debug/incremental follows a linked `debug` and deletes outside the target
        root = self.build_repo()
        cache = self.case / "cache"
        cache.mkdir()
        (cache / "big").write_bytes(b"x" * 2_000_000)
        outside = self.case / "outside"
        (outside / "incremental").mkdir(parents=True)
        (outside / "incremental/precious").write_bytes(b"x" * 2_000_000)
        (cache / "debug").symlink_to(outside)
        r = self.run_stage(root, "build", extra_env={"GATE_APP_BOOT_TARGET_DIR": str(cache),
                                                     "GATE_APP_BOOT_TARGET_MAX_MB": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((outside / "incremental/precious").exists(), "deleted outside the target: " + r.stderr)
        self.assertRegex(r.stderr, r"(?m)^gate-app-boot: build: .*/debug is a link: not trimmed$")
        self.assertTrue((cache / "debug").is_symlink())

    def test_refused_paths(self):
        root = self.build_repo()
        link = self.case / "link"
        link.symlink_to(self.home / ".nunchiro")
        (self.home / ".nunchiro").mkdir()
        bad = {
            "relative": "cache/gab",
            "inside the worktree": str(root / "target"),
            "inside the worktree's .scratch": str(root / ".scratch/shared"),
            "the worktree itself": str(root),
            "above the worktree": str(root.parent),
            "the filesystem root": "/",
            "HOME itself": str(self.home),
            "the owner's home": str(self.home / ".nunchiro"),
            "inside the owner's home": str(self.home / ".nunchiro/target"),
            "an RC's default home": str(self.home / ".nunchiro-dev.nunchiro.app.rc/t"),
            "a link to the owner's home": str(link / "t"),
            "a newline": str(self.case / "a\nb"),
        }
        for name, path in bad.items():
            with self.subTest(name):
                r = self.run_stage(root, "build", extra_env={"GATE_APP_BOOT_TARGET_DIR": path})
                self.assert_step(r, "build", 3)
                self.assertIn("refused: GATE_APP_BOOT_TARGET_DIR", r.stderr)
                self.assertFalse((self.home / "build.log").exists(), "built into a refused dir")
        self.assertEqual(list((self.home / ".nunchiro").iterdir()), [])
        self.assertFalse((root / "target").exists())


class Refusals(Fixture):
    def assert_refused(self, root, what, step="run", *args):
        r = self.run_stage(root, *(args or ("run",)))
        self.assert_step(r, step, 3)
        self.assertIn(f"refused: {what}", r.stderr)
        self.assert_nothing_started()

    def test_refuses_worktree_in_owner_home(self):
        for folder in (".nunchiro", ".nunchiro-dev.nunchiro.app.rc", ".NUNCHIRO", ".Nunchiro-other"):
            with self.subTest(folder=folder):
                root = self.repo(self.home / folder / "w")
                self.app(root)
                self.assert_refused(root, "this worktree")
                shutil.rmtree(self.home / folder)

    def test_refuses_worktree_behind_owner_home_link(self):
        real = self.home / "data"
        real.mkdir()
        (self.home / ".nunchiro").symlink_to(real)
        root = self.repo(real / "w")
        self.app(root)
        self.assert_refused(root, "this worktree")

    def test_refuses_scratch_symlink(self):
        root = self.repo()
        other = self.case / "elsewhere"
        other.mkdir()
        (root / ".scratch").symlink_to(other)
        self.assert_refused(root, ".scratch is a symlink")
        self.assertEqual(list(other.iterdir()), [])

    def test_refuses_out_symlink(self):
        root = self.repo()
        (root / ".scratch").mkdir()
        target = self.home / ".nunchiro-dev.nunchiro.app.rc"
        target.mkdir()
        (root / ".scratch/gate-app-boot").symlink_to(target)
        self.assert_refused(root, ".scratch/gate-app-boot is a symlink")
        self.assertEqual(list(target.iterdir()), [])

    def test_refuses_symlinked_or_foreign_app(self):
        root = self.repo()
        real = self.app(root, self.case / "elsewhere" / NAME)
        link = self.case / "link.app"
        link.symlink_to(real)
        self.assert_refused(root, f"{link} is a symlink", "app", "run", str(link))
        wrong = self.app(root, self.case / "wrong" / NAME, bundle_id="dev.nunchiro.app")
        self.assert_refused(root, "the bundle id is dev.nunchiro.app", "app", "run", str(wrong))
        for folder in ("Applications/x", "applications/y"):  # one folder on a case-insensitive volume
            installed = self.app(root, self.case / folder / NAME)
            self.assert_refused(root, f"{installed} is an installed app", "app", "run", str(installed))

    def test_passes_from_a_worktree_as_long_as_the_gates(self):
        """Review r1 MUST 1: the MacBook gate worktree path is 51 bytes; a 60-byte one must still boot."""
        root = self.case / ("w" * (60 - len(str(self.case)) - 1))
        self.assertEqual(len(str(root)), 60)
        self.repo(root)
        self.app(root)
        r = self.run_stage(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stderr, "gate-app-boot: pass: ")

    def test_long_home_fails_before_launch(self):
        root = self.repo(self.case / ("d" * 60) / "w")
        self.app(root)
        r = self.run_stage(root)
        self.assert_step(r, "home")
        self.assertIn("a holder socket would not fit", r.stderr)
        self.assert_nothing_started()
        self.assertEqual(self.runs(root), [])

    def test_inherited_variables_are_not_used_by_the_stop(self):
        """Review r3 (security): `app`, `session` and the like in the gate's environment must not reach the stop when
        a run fails before setting them, or it would run that bundle's CLI (and lsregister -u on it)."""
        root = self.repo(self.case / ("d" * 60) / "w")
        self.app(root)
        stray = self.case / "stray.app"
        write(stray / "Contents/MacOS/nunchiro", '#!/bin/sh\necho "$*" >> "%s"\n' % (self.home / "stray-ran"))
        r = self.run_stage(root, extra_env={"app": str(stray), "session": "x", "app_pid": "1", "home": str(stray),
                                            "stop_failed": ""})
        self.assert_step(r, "home")
        self.assertFalse((self.home / "stray-ran").exists(), "the stop ran an inherited bundle's CLI")
        self.assertTrue(stray.is_dir())
        self.assert_nothing_started()
        self.assertEqual(self.runs(root), [])


if __name__ == "__main__":
    unittest.main()
