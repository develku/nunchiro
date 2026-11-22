"""Real-app click harness (ticket 171, needs 149): drive the installed Nunchiro.app like a user on a temp home.

The installed bundle is copied to the system temp dir and started with its own core on a fresh NUNCHIRO_HOME, so
The owner's running app, core and ~/.nunchiro are never touched. Every process here is ours by PID and is stopped by PID.
Clicks go through Accessibility (AXPress on the WKWebView's elements) or CGEvent at screen points; keys are posted to
the app's pid; captures are `screencapture -l <window>`. A window that does not answer an AX call for 5 s raises Hang
(exit 3), which callers report as a failure, never as a timeout.

The web console is not reachable: the release app is built without devtools (no Tauri `devtools` feature), so a
page error shows only as what the window draws. Needs Accessibility and Screen Recording for the calling process."""
import os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "scripts/measure"))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
from measurelib import OwnApp  # noqa: E402
from lib import clean_env  # noqa: E402

INSTALLED = Path(os.environ.get("APP_CLICK_APP", Path.home() / "Applications/Nunchiro.app"))
BUILD = ROOT / ".scratch/app-click"
HANG = 3
# Controls are named "#dom-id|Label": the id first (it survives a label change), the label as the fallback (ax.swift).
SETTINGS = "#icon-settings|Settings"
APPEARANCE = "#snav-appearance|Appearance"


class Hang(Exception):
    """The window did not answer for 5 s: a freeze, reported as a failure."""


def ax_exe():
    """The Swift helper, compiled once per source change into .scratch/app-click."""
    src = HERE / "ax.swift"
    exe = BUILD / f"ax-{int(src.stat().st_mtime)}"
    if not exe.is_file():
        BUILD.mkdir(parents=True, exist_ok=True)
        subprocess.run(["swiftc", "-O", str(src), "-o", str(exe)], check=True)
    return exe


def ax(*args, timeout=30):
    p = subprocess.run([str(ax_exe()), *map(str, args)], capture_output=True, text=True, timeout=timeout)
    if p.returncode == HANG:
        raise Hang(p.stderr.strip())
    if p.returncode:
        raise RuntimeError(f"ax {args[0]}: {p.stderr.strip()}")
    return p.stdout


class App:
    """One copy of the app with its own core and home. Use as a context manager; stop() removes everything."""

    def __init__(self, app=INSTALLED, shots=None, env=None, before=None, store=None):
        """env: extra variables for core and app (a stub PATH, say). before(app): runs after the core is up and
        before the window opens (CLI fixtures). store: a localstorage.sqlite3 file (a copy of an old store) seeded
        into this copy's own WebKit folder before launch, so the window starts with those stored values."""
        self.tmp = Path(tempfile.mkdtemp(prefix="ns-click-"))  # system temp: see measurelib.Spawned on /Volumes
        self.home = self.tmp / "home"
        self.home.mkdir()
        if self.home.resolve() == (Path.home() / ".nunchiro").resolve():
            raise RuntimeError("refusing to run on the real home")
        self.shots = Path(shots or BUILD / "shots")
        self.shots.mkdir(parents=True, exist_ok=True)
        # The window keeps its settings (bars, theme, tab order) in WebKit localStorage under ~/Library/WebKit/<bundle
        # id>. The installed id is the owner's live app's store, so the copy gets its own id and ad-hoc signature
        # (measurelib.OwnApp); stop() removes the copy and the folders macOS makes for it.
        self.own = OwnApp(app)
        self.bundle_id = self.own.bundle_id
        bundle = self.own.bundle
        if store:
            self._seed(Path(store))
        macos = bundle / "Contents/MacOS"
        self.core_bin = macos / "nunchiro"
        self.env = clean_env({"NUNCHIRO_HOME": str(self.home), "NUNCHIRO_BIN": str(self.core_bin)})
        for k in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION"):
            self.env.pop(k, None)
        self.env.update(env or {})
        self.log = open(self.tmp / "app.log", "ab")
        self.core = subprocess.Popen([str(self.core_bin), "serve"], env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=self.log, stderr=self.log, cwd="/")
        self.app = None
        try:
            self._wait(lambda: (self.home / "core.sock").exists(), 15, "core did not start")
            if before:
                before(self)
            # A plain child, not measurelib.Spawned: a disclaimed copy is its own macOS privacy subject with no
            # grant for removable volumes. When that copy started its own core (a quit and reopen runs `serve update`)
            # and the core read a link into /Volumes, macOS asked "access files on a removable volume"; unanswered,
            # the question blocked every read of /Volumes on the Mac (2026-11-17, three times). A plain child keeps
            # the terminal's grant, and so does every core it starts. Only a memory measure needs the disclaim.
            self.app = subprocess.Popen([str(macos / "nunchiro-app")], env=self.env, stdin=subprocess.DEVNULL,
                                        stdout=self.log, stderr=self.log, cwd="/")
            self.pid = self.app.pid
            self._wait(self._has_window, 30, "no window")
            self._wait(lambda: self.find(SETTINGS), 30, "page did not draw (no Settings control)")
        except BaseException:
            self.stop()
            raise

    def _webkit_default(self):
        return Path.home() / "Library/WebKit" / self.bundle_id / "WebsiteData/Default"

    def _seed(self, store):
        """Origin folders are named by a hash salted per store: reuse the installed app's salt (read only) so the
        tauri:// origin maps to the same folder name, then put the copy there. Writes only under our bundle id."""
        owner = Path.home() / "Library/WebKit/dev.nunchiro.app/WebsiteData/Default"
        origin = next(p.name for p in owner.iterdir() if p.is_dir())
        dest = self._webkit_default() / origin / origin / "LocalStorage"
        dest.mkdir(parents=True)
        shutil.copy2(owner / "salt", self._webkit_default() / "salt")
        (dest.parent / "origin").write_bytes((owner / origin / origin / "origin").read_bytes())
        shutil.copy2(store, dest / "localstorage.sqlite3")

    def stored(self):
        """This copy's localStorage as {key: parsed JSON or text}, read from a snapshot of its own store."""
        import json, sqlite3
        out = {}
        for db in self._webkit_default().glob("*/*/LocalStorage/localstorage.sqlite3"):
            snap = self.tmp / "store-snap"
            snap.mkdir(exist_ok=True)
            for f in db.parent.glob("localstorage.sqlite3*"):
                shutil.copy2(f, snap / f.name)
            c = sqlite3.connect(str(snap / "localstorage.sqlite3"))
            for k, v in c.execute("select key, value from ItemTable"):
                text = bytes(v).decode("utf-16-le")
                try:
                    out[k] = json.loads(text)
                except ValueError:
                    out[k] = text
            c.close()
        return out

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()

    @staticmethod
    def _wait(cond, secs, why):
        until = time.monotonic() + secs
        while time.monotonic() < until:
            try:
                if cond():
                    return
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(0.3)
        raise RuntimeError(why)

    def _has_window(self):
        """An on-screen window only: a closed window can linger off screen in the window list."""
        try:
            return int(ax("window", self.pid, "onscreen").split()[3]) > 200
        except RuntimeError:
            return False

    def window(self):
        """(window number, x, y, w, h) of the app's front window."""
        return tuple(int(v) for v in ax("window", self.pid).split())

    def cli(self, *args):
        """The bundled core CLI on this App's home; returns stdout."""
        p = subprocess.run([str(self.core_bin), *map(str, args)], env=self.env, capture_output=True, text=True,
                           timeout=30, cwd="/")
        if p.returncode:
            raise RuntimeError(f"nunchiro {' '.join(map(str, args[:2]))}: {p.stderr.strip() or p.stdout.strip()}")
        return p.stdout

    def ping(self):
        ax("ping", self.pid)

    def tree(self, depth=40):
        return ax("tree", self.pid, depth, timeout=60)

    def find(self, text):
        """Frames (x, y, w, h, role) of elements whose title, description or value equals text."""
        out = []
        for line in ax("find", self.pid, text, timeout=60).splitlines():
            x, y, w, h, role = line.split(" ", 4)
            out.append((int(x), int(y), int(w), int(h), role))
        return out

    def press(self, text, nth=1, settle=0.8):
        ax("press", self.pid, text, nth, timeout=60)
        time.sleep(settle)
        self.ping()

    def activate(self):
        """Brings the app's window to the front; False when macOS left another app frontmost."""
        front = ax("activate", self.pid).strip() == "ok"
        time.sleep(0.4)
        return front

    def click(self, x, y, settle=0.6, right=False):
        self.activate()
        ax("rclick" if right else "click", self.pid, x, y)
        time.sleep(settle)
        # A click that hands focus away (a tooltip, a new window) leaves later hovers and keys unseen: take it back.
        # Not after a right click: raising the window would close the context menu it opened.
        if not right and not self.activate():
            print(f"harness: window not frontmost after click at {x},{y}", file=sys.stderr)
        self.ping()

    def move(self, x, y):
        """Pointer move over our window (hover); a background window draws no hover state, so activate first."""
        self.activate()
        ax("move", self.pid, x, y)

    def drag(self, x0, y0, x1, y1, settle=0.8):
        self.activate()
        ax("drag", self.pid, x0, y0, x1, y1)
        time.sleep(settle)
        self.ping()

    def down(self, x, y):
        self.activate()
        ax("down", self.pid, x, y)

    def dragto(self, x, y):
        ax("dragto", self.pid, x, y)

    def up(self, x, y):
        ax("up", self.pid, x, y)

    def type(self, text):
        ax("type", self.pid, text)

    def key(self, code, mods=""):
        self.activate()
        ax("key", self.pid, code, mods)
        time.sleep(0.4)

    def capture(self, name):
        """PNG of the window (no shadow) in self.shots; returns its path."""
        out = self.shots / f"{name}.png"
        subprocess.run(["screencapture", "-x", "-o", "-l", str(self.window()[0]), str(out)], check=True, timeout=30)
        if not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError(f"capture {name} wrote nothing")
        return out

    def quit(self):
        """The app menu's "Quit Nunchiro" on our copy. By design (main.rs quit_key) that closes the window and keeps
        the menu-bar process and core; stop() ends those. True when the window is gone within 10 s."""
        ax("menu", self.pid, "Quit Nunchiro")
        until = time.monotonic() + 10
        while time.monotonic() < until:
            if not self._has_window():
                return True
            if self.find("Close the window"):  # first close on a fresh store explains that agents keep running
                ax("press", self.pid, "Close the window")
            time.sleep(0.3)
        return False

    def stop(self):
        """Ends only what this App started, by PID, and removes its temp dir."""
        if self.app and self.app.poll() is None:
            self.app.terminate()
            try:
                self.app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.app.kill()
        subprocess.run([str(self.core_bin), "serve", "stop", "--yes"], env=self.env, capture_output=True, timeout=30)
        if self.core.poll() is None:
            self.core.terminate()
            try:
                self.core.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.core.kill()
        self.log.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.own.remove()
