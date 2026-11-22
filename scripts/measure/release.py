"""Release figures (ticket 11, spec Acceptance 9 and 10), Nunchiro paired with herdr. Usage:
  release.py footprint [--v1b] [--sessions 3,10] [--repeats 3] [--compare] [--reason TEXT] [--no-record]
  release.py latency [--n 300] [--repeats 3] [--compare] [--reason TEXT] [--no-record]

Round 2 (owner 2026-10-25): measured under the host's load as it is, Nunchiro and herdr interleaved (A, B per
repeat) with the same workload (scripts/measure/workload/workload.json), so both see the same load; each row
records both values, their ratio and the load range. Nunchiro runs from the release builds under a scratch
NUNCHIRO_HOME; herdr runs as its own server with HOME under .scratch (the owner's herdr server is never contacted).
Real `claude --model haiku` agents, between two snapshots of the user's agent config (ticket-01 guard).
Results go to docs/v1/figures.md (newest first), raw samples to .scratch/measure/<run>/. Stops only its PIDs."""
import argparse, base64, hashlib, json, os, re, shutil, socket, struct, subprocess, sys, tempfile, time, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import workload_v1b as w1b  # noqa: E402
from lib import TRUSTED_CWD, Session, clean_env, descendants, guard_check, snapshot, visible  # noqa: E402

CORE = Path(os.environ.get("NUNCHIRO_MEASURE_CORE") or ROOT / "target/release/nunchiro")  # the override is for tests
APP = Path(os.environ.get("NUNCHIRO_MEASURE_APP") or ROOT / "target/release/nunchiro-app")  # the override is for tests
FIGURES = ROOT / "docs/v1/figures.md"
WORK = json.loads((HERE / "workload/workload.json").read_text())
REAL_HOME = os.path.expanduser("~")
OWNER_HERDR_CONFIG = os.path.join(REAL_HOME, ".config/herdr/config.toml")
ORCA_REF = "1,091 MB RSS (ADR 0001, the owner's Mac; RSS, not footprint; not re-measured: Orca not installed, the owner ORCA=A)"
TRUST = r"Is this a project you created or one you trust|Allow external CLAUDE.md"


def load():
    return round(os.getloadavg()[0], 2)


def short_home(real):
    """herdr-client.sock under a home must fit sun_path (103 bytes): a long checkout path gets a temp-dir alias
    (the same exception as the core test homes); the files stay under .scratch."""
    if len(str(real / ".config/herdr/herdr-client.sock")) <= 100:
        return real
    alias = Path(tempfile.gettempdir()) / f"ns-{real.name}"
    alias.symlink_to(real)
    return alias


def mib(b):
    return round(b / 2**20, 1)


def kill_pids(pids):
    for pid in pids:
        try:
            os.kill(pid, 9)
        except (ProcessLookupError, PermissionError):
            pass


V1B_WORK = dict(agent=["--fixture-silent"], ready=w1b.READY, busy_prompts=["step"])  # fixture CLI: no model, nothing streams, no core hooks (herdr has none)
V1B_COLUMNS = ["working", "review", "done"]  # where the board's session cards are placed (round robin)


class Arm:
    """What both apps provide to the footprint and latency runs. Sessions are opaque ids."""
    name = ""
    work = WORK
    claude = "claude"

    def prepare_v1b(self, chat):
        """Fixture CLI wrapper, project and (chat) the generated files under this arm's scratch home; PATH and
        CLAUDE_CONFIG_DIR point there, never at ~/.claude."""
        self.work, self.v1b = V1B_WORK, w1b.prepare(self.home / "v1b", chat=chat)
        scratch = (os.path.realpath(ROOT / ".scratch") + os.sep, os.path.realpath(self.home) + os.sep)
        for key in ("bin", "config", "project"):
            if not os.path.realpath(self.v1b[key]).startswith(scratch):
                raise RuntimeError(f"v1b {key} {self.v1b[key]} is outside {scratch}; refusing")
        self.env["PATH"] = self.v1b["bin"] + os.pathsep + self.env["PATH"]
        self.env["CLAUDE_CONFIG_DIR"] = self.v1b["config"]
        self.claude = str(Path(self.v1b["bin"]) / "claude")

    def after_ready(self, sids):
        """Hook between the agents being ready and the window opening."""

    def after_open(self):
        """Hook after the window opened."""

    def turn_tick(self):
        """Hook before each in-turn sample."""

    def wait_ready(self, sids, timeout=120):
        """Every agent must reach its ready prompt; otherwise the run aborts (no figures of an idle tree)."""
        until, left = time.monotonic() + timeout, set(sids)
        while left and time.monotonic() < until:
            for sid in list(left):
                text = self.screen(sid)
                if re.search(TRUST, text):
                    raise RuntimeError(f"{self.name} {sid}: startup trust dialog; refusing to answer it")
                if re.search(self.work["ready"], text, re.I | re.S):
                    left.discard(sid)
            time.sleep(0.5)
        if left:
            raise RuntimeError(f"{self.name}: agents did not reach their ready prompt in {timeout} s: {sorted(left)}; run aborted")

    def activity(self, sid):
        """Changes while the session's output changes."""
        return hashlib.sha256(self.screen(sid, recent=True).encode()).hexdigest()


class Nunchiro(Arm):
    """One core with its sessions and (optionally) the window app; everything started is tracked by PID."""
    name = "nunchiro"

    def __init__(self, v1b=None):
        """v1b: None (ticket 11 workload), "chat" (V1B-24: 5,000-event transcript, 3 artifacts) or "plain" (the same
        fixture sessions and board without the transcript: the per-component baseline of the same window)."""
        # System temp, not .scratch: the window app runs with its responsibility disclaimed (ml.Spawned), so reading a
        # home on the external SSD raises a removable-volume prompt nobody answers and the page never loads.
        # Short too: the core socket path must stay < 104 bytes.
        self.home = Path(tempfile.mkdtemp(prefix="ns-mr-"))
        # The app runs NUNCHIRO_BIN itself, under its own TCC subject: a copy off the SSD (see above).
        self.env = clean_env({"NUNCHIRO_HOME": str(self.home), "NUNCHIRO_BIN": shutil.copy2(CORE, self.home / "nunchiro")})
        for k in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION"):
            self.env.pop(k, None)
        self.owned, self.app, self.mode, self.tailed = set(), None, v1b, 0
        if v1b:
            self.prepare_v1b(chat=v1b == "chat")
            (self.home / "board.toml").write_text(w1b.BOARD_TOML)
        log = open(self.home / "core.log", "ab")
        self.core = subprocess.Popen([str(CORE), "serve"], env=self.env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        self.owned.add(self.core.pid)
        until = time.monotonic() + 15
        try:
            while True:
                try:
                    self.call({"op": "snapshot"})
                    return
                except OSError:
                    if self.core.poll() is not None or time.monotonic() > until:
                        raise RuntimeError("core did not start")
                    time.sleep(0.05)
        except BaseException:
            kill_pids(self.owned)  # the caller has no arm to stop yet
            raise

    def call(self, request, timeout=20):
        token = (self.home / "core.token").read_text()
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(timeout)
            s.connect(str(self.home / "core.sock"))
            s.sendall(json.dumps({"token": token, "request": request}).encode() + b"\n")
            data = b""
            while not data.endswith(b"\n"):
                chunk = s.recv(1 << 20)
                if not chunk:
                    break
                data += chunk
        reply = json.loads(data)
        if "Err" in reply:
            raise RuntimeError(reply["Err"])
        return reply["Ok"]

    def cli(self, *args):
        p = subprocess.run([str(CORE), *args], env=self.env, capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError(f"nunchiro {args[:2]}: {p.stderr.strip() or p.stdout.strip()}")
        return json.loads(p.stdout)

    def screen(self, sid, recent=False):
        data = bytes(self.cli("session", "read", sid)["data"])
        return visible(data[-20000:] if recent else data)

    def start(self, i):
        if self.mode:  # session 0 writes a one-line transcript (the fixture's own); "chat" replaces it after_ready
            args = ["--", *self.work["agent"], *(["--fixture-transcript"] if i == 0 else [])]
            return self.cli("session", "start", "--kind", "claude", "--project", self.v1b["project"], "--label", f"m{i}", *args)["session"]["id"]
        return self.cli("session", "start", "--kind", "claude", "--project", TRUSTED_CWD, "--label", f"m{i}", *WORK["agent"])["session"]["id"]

    def transcript_path(self, sid):
        """Where the core reads this session's transcript (the hook payload path of the fixture CLI)."""
        agent_id = next(s for s in self.call({"op": "snapshot"})["sessions"] if s["id"] == sid)["agent_session_id"]
        slug = "".join(c if c.isascii() and c.isalnum() else "-" for c in os.path.realpath(self.v1b["project"]))
        return Path(self.v1b["config"]) / "projects" / slug / f"{agent_id}.jsonl"

    def chat_count(self, sid):
        """(events, artifact events, skipped) the core serves for the session, paging back from the newest."""
        n = arts = 0
        before = None
        while True:
            reply = self.call({"op": "chat_page", "id": sid, "before": before, "after": None})
            page = reply.get("ChatPage", reply)["page"]
            n += len(page["events"])
            arts += sum(e["data"]["kind"] == "artifact" for e in page["events"])
            before = page["before"]
            if before is None:
                return n, arts, page["skipped"], page["banner"]

    def after_ready(self, sids):
        if not self.mode:
            return
        for i, sid in enumerate(sids):  # session cards placed across the default columns
            self.call({"op": "board_move", "source": "session", "id": sid, "column": V1B_COLUMNS[i % 3]})
        if self.mode != "chat":
            return
        path = self.transcript_path(sids[0])
        until = time.monotonic() + 15
        while not path.is_file() and time.monotonic() < until:
            time.sleep(0.2)
        tmp = path.with_suffix(".new")  # a new inode: the core starts a new generation and re-indexes
        tmp.write_bytes(Path(self.v1b["transcript"]).read_bytes())
        os.replace(tmp, path)
        self.chat_path, self.chat_sid = path, sids[0]
        # The first page must come from the core's own projection of the generated file, not an empty chat.
        until = time.monotonic() + 30
        while True:
            n, arts, skipped, banner = self.chat_count(sids[0])
            if (n, arts) == (w1b.EVENTS, 3) or time.monotonic() > until:
                break
            time.sleep(0.5)
        if (n, arts, skipped, banner) != (w1b.EVENTS, 3, 0, None):
            raise RuntimeError(f"core serves {n} events, {arts} artifact cards, {skipped} skipped, banner {banner}; "
                               f"expected {w1b.EVENTS}, 3, 0, none: refusing to measure an empty or partial chat")
        self.served = dict(events=n, artifacts=arts)

    def after_open(self):
        if self.mode:
            self.cli("layout", "add", "board")  # forwarded to the open window; fails when no window is connected
            time.sleep(3)

    def turn_tick(self):
        """A live tail: three events appended to the chat session's transcript per in-turn sample, which the
        open window receives and renders (scrolling the WebView is not reachable from outside)."""
        if self.mode == "chat":
            lines = [json.dumps({"type": "assistant", "uuid": f"tail-{self.tailed + i}", "message": {"content": [{"type": "text", "text": f"live {self.tailed + i} 라이브"}]}}, ensure_ascii=False) for i in range(3)]
            with open(self.chat_path, "ab") as f:
                f.write(("\n".join(lines) + "\n").encode())
            self.tailed += 3

    def start_echo(self, log):
        return self.cli("session", "start", "--kind", "shell", "--project", str(self.home), "--label", "echo", "--",
                        sys.executable, "-I", str(HERE / "echo_target.py"), str(log))["session"]["id"]

    def prompt(self, sid, text):
        self.cli("session", "send-text", sid, "\x1b[200~" + text + "\x1b[201~")
        time.sleep(0.8)
        self.cli("session", "send-keys", sid, "enter")

    def esc(self, sid):
        self.cli("session", "send-keys", sid, "esc")

    def open(self):
        log = open(self.home / "app.log", "ab")
        self.own = ml.OwnApp(APP)  # own bundle id: never the owner's WebKit store
        self.app = ml.Spawned([str(self.own.exe)], self.env, log)  # own responsibility: see Spawned
        self.owned.add(self.app.pid)

    def close(self):
        """Window closed = the window process gone, core and agents running (Nunchiro's default lifetime)."""
        self.app.terminate()
        try:
            self.app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.app.kill()
            self.app.wait()
        pid, self.app = self.app.pid, None
        until = time.monotonic() + 15
        while time.monotonic() < until and helpers(pid, set())[0]:
            time.sleep(0.5)
        return len(helpers(pid, set())[0])

    def tree(self):
        return set(descendants(self.core.pid))

    def parts(self, window):
        """(required pids, helper pids, webkit helper pids, agent pids) for one sample."""
        agents = sorted(self.tree())
        if not window:
            return [self.core.pid], [], [], agents
        hp, webkit = helpers(self.app.pid, set(agents) | {self.core.pid})
        if not webkit:
            raise RuntimeError("window open but zero WebKit helpers found by responsible pid; refusing to report a sum")
        return [self.core.pid, self.app.pid], hp, webkit, agents

    def keys(self, target, log):
        auth = self.call({"op": "window_auth"})
        auth = auth.get("WindowAuth", auth)
        return WSKeys(WS(auth["port"], auth["token"]), target, log)

    def stop(self):
        if self.app is not None:
            self.app.kill()
            self.app.wait()
        tree = self.tree() if self.core.poll() is None else set()
        try:
            self.cli("serve", "stop", "--yes")
            self.core.wait(timeout=20)
        except Exception:  # noqa: BLE001 - fall through to the PID kill below
            pass
        kill_pids(self.owned | tree)
        self.owned.clear()
        if getattr(self, "own", None):
            self.own.remove()
        shutil.rmtree(self.home, ignore_errors=True)


class Herdr(Arm):
    """A dedicated herdr server: HOME and HERDR_CONFIG_PATH under .scratch, every HERDR_* variable scrubbed, so the
    socket is .scratch/hr/<id>/.config/herdr/herdr.sock (checked before any change). Agents get the real HOME back."""
    name = "herdr"

    def __init__(self, v1b=False):
        # short: herdr-client.sock under it must fit sockaddr_un (104 bytes)
        real = ROOT / ".scratch" / ("h" + uuid.uuid4().hex[:4])
        (real / ".config/herdr").mkdir(parents=True)
        self.home = short_home(real)
        cfg = self.home / ".config/herdr/config.toml"
        cfg.write_text("onboarding = false\n")  # first-run modal would cover the panes
        self.env = clean_env({"HOME": str(self.home), "HERDR_CONFIG_PATH": str(cfg)})
        # An inherited SSH_AUTH_SOCK (this harness runs inside the owner's herdr) makes the server link its agent socket
        # to the owner's herdr; TERM_PROGRAM names that herdr too.
        for k in ("SSH_AUTH_SOCK", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"):
            self.env.pop(k, None)
        self.owned, self.client = set(), None
        if v1b:  # the same fixture CLI as Nunchiro's sessions; no transcript (herdr has no chat view)
            self.prepare_v1b(chat=False)
        self.server = subprocess.Popen(["herdr", "server"], env=self.env, stdin=subprocess.DEVNULL,
                                       stdout=open(self.home / "server.out", "ab"), stderr=subprocess.STDOUT)
        self.owned.add(self.server.pid)
        sock = str(self.home / ".config/herdr/herdr.sock")
        until = time.monotonic() + 15
        try:
            while True:
                st = subprocess.run(["herdr", "status", "server"], env=self.env, capture_output=True, text=True, timeout=20).stdout
                if "status: running" in st:
                    if f"socket: {sock}" not in st:
                        raise RuntimeError(f"herdr answered from another socket; refusing to touch it: {st!r}")
                    return
                if self.server.poll() is not None or time.monotonic() > until:
                    raise RuntimeError("herdr server did not start")
                time.sleep(0.2)
        except BaseException:
            kill_pids(self.owned)  # the caller has no arm to stop yet
            raise

    def h(self, *args, raw=False):
        p = subprocess.run(["herdr", *args], env=self.env, capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError(f"herdr {args[:2]}: {p.stderr.strip() or p.stdout.strip()}")
        return p.stdout if raw else json.loads(p.stdout) if p.stdout.strip() else None

    def screen(self, sid, recent=False):
        return self.h("pane", "read", sid, "--source", "recent" if recent else "visible", "--lines", "200", raw=True)

    def _workspace(self, label, command, focus=False):
        ws = self.h("workspace", "create", "--cwd", TRUSTED_CWD, "--label", label, "--focus" if focus else "--no-focus")
        pane = ws["result"]["root_pane"]["pane_id"]
        until = time.monotonic() + 15
        while not re.search(r"[%$#❯]\s*$", self.screen(pane).rstrip() + " ") and time.monotonic() < until:
            time.sleep(0.2)  # the pane's shell prompt
        self.h("pane", "run", pane, command)
        return pane, ws["result"]["workspace"]["workspace_id"]

    def start(self, i):
        args = " ".join(a for a in self.work["agent"] if a != "--")
        return self._workspace(f"m{i}", f"HOME='{REAL_HOME}' exec '{self.claude}' {args}")[0]

    def start_echo(self, log):
        pane, self.echo_ws = self._workspace("echo", f"exec {sys.executable} -I '{HERE / 'echo_target.py'}' '{log}'")
        return pane

    def prompt(self, sid, text):
        self.h("pane", "send-text", sid, text)
        time.sleep(0.8)
        self.h("pane", "send-keys", sid, "enter")

    def esc(self, sid):
        self.h("pane", "send-keys", sid, "esc")

    def open(self):
        """Client attached in a 160x50 PTY (Nunchiro's window counterpart; the terminal emulator around it is not counted)."""
        self.client = Session(["herdr"], str(self.home), self.env)
        self.owned.add(self.client.pid)
        if not self.client.wait_for(r"m0|echo", 15):
            raise RuntimeError("herdr client did not draw its workspaces")

    def close(self):
        """Client gone, server and agents running (herdr's detach)."""
        self.client.kill()
        self.client = None
        return 0

    def tree(self):
        return set(descendants(self.server.pid))

    def parts(self, window):
        agents = sorted(self.tree())
        return [self.server.pid] + ([self.client.pid] if window else []), [], [], agents

    def keys(self, target, log):
        self.h("workspace", "focus", self.echo_ws)
        time.sleep(1)
        return PtyKeys(self.client, log)

    def stop(self):
        tree = self.tree() if self.server.poll() is None else set()
        if self.client is not None:
            self.client.kill()
        self.server.terminate()
        try:
            self.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        kill_pids(self.owned | tree)
        self.owned.clear()
        if self.home.is_symlink():
            self.home.unlink()


ARMS = {"nunchiro": Nunchiro, "herdr": Herdr}
V1B_APPS = ("nunchiro", "plain", "herdr")  # plain = Nunchiro without the transcript: same fixtures, board and window


def make_arm(app, v1b=False):
    if not v1b:
        return ARMS[app]()
    return Herdr(v1b=True) if app == "herdr" else Nunchiro(v1b="chat" if app == "nunchiro" else "plain")


class HerdrGhostty(Herdr):
    """herdr plus one Ghostty window whose command is the herdr client, attached to this arm's own scratch server
    (HOME and HERDR_CONFIG_PATH from self.env; the owner's herdr, sessions and Ghostty windows are never contacted).
    Started and killed by the PID we launched, nothing else. Footprint only: the window counts as the herdr
    'app' (Ghostty + its descendants + responsible-pid helpers), the way Nunchiro's window app does."""
    name = "herdr-ghostty"
    GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty"

    def open(self):
        env = dict(self.env, XDG_CONFIG_HOME=str(self.home / ".config"))  # scratch config: no user Ghostty settings
        self.ghostty = subprocess.Popen(
            [self.GHOSTTY, "--window-save-state=never", "--confirm-close-surface=false", "--quit-after-last-window-closed=true",
             "--window-width=160", "--window-height=50",
             "-e", "env", f"HOME={self.home}", "herdr"],  # macOS login(1) resets HOME to the real one
            env=env, stdin=subprocess.DEVNULL, stdout=open(self.home / "ghostty.out", "ab"), stderr=subprocess.STDOUT)
        self.owned.add(self.ghostty.pid)
        until = time.monotonic() + 20
        while time.monotonic() < until:
            procs = ml.parse_ps(subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout)
            clients = [p for p in descendants(self.ghostty.pid) if procs.get(p, "").endswith("herdr")]
            if clients:
                # Proof the client is on this arm's scratch server, not the owner's: login(1) and env must have left HOME alone.
                env = subprocess.run(["ps", "eww", "-p", str(clients[0])], capture_output=True, text=True).stdout
                if f"HOME={self.home} " not in env + " " or f"HERDR_CONFIG_PATH={self.home}/" not in env:
                    raise RuntimeError("the herdr client in the ghostty window does not carry the scratch HOME/HERDR_CONFIG_PATH; refusing")
                return
            if self.ghostty.poll() is not None:
                self.owned.discard(self.ghostty.pid)
                raise RuntimeError("ghostty exited before the herdr client started")
            time.sleep(0.3)
        raise RuntimeError("no herdr client under the ghostty window; refusing to report a footprint without it")

    def close(self):
        kill_pids([self.ghostty.pid] + descendants(self.ghostty.pid))
        self.ghostty.wait()
        self.owned.discard(self.ghostty.pid)  # reaped: the PID may be reused, never signal it again
        return 0

    def parts(self, window):
        agents = sorted(self.tree())
        if not window:
            return [self.server.pid], [], [], agents
        procs = ml.parse_ps(subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout)
        gpid = self.ghostty.pid
        extra = ml.window_parts(descendants(gpid), procs, {p: ml.responsible_pid(p) for p in procs}, gpid, set(agents) | {self.server.pid})
        return [self.server.pid, gpid], extra, [], agents

    def stop(self):
        if getattr(self, "ghostty", None) is not None and self.ghostty.poll() is None:
            self.close()
        super().stop()


ARMS[HerdrGhostty.name] = HerdrGhostty


def helpers(app_pid, exclude):
    procs = ml.parse_ps(subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout)
    resp = {p: ml.responsible_pid(p) for p in procs}
    return ml.attribute(procs, resp, app_pid, exclude)


def footprint(pids):
    p = subprocess.run(["footprint", "-f", "bytes", "--noCategories", *map(str, pids)], capture_output=True, text=True)
    return ml.parse_footprint(p.stdout + "\n" + p.stderr)


def sample(arm, phase, window, rec):
    """One sample: app = core or server (+ window app and its helpers, or the herdr client); agents = every
    process under the core or server (for herdr this includes each pane's shell)."""
    ld = load()
    required, hp, webkit, agents = arm.parts(window)
    ours = required + hp
    found = footprint(ours + agents)
    n, skipped = ml.sum_footprint(found, ours, required=required)
    a, a_skipped = ml.sum_footprint(found, agents)
    s = dict(phase=phase, load=ld, app_mib=mib(n), agents_mib=mib(a), parts_mib=[mib(found[p]) for p in required],
             helpers=len(hp), webkit=len(webkit), helpers_mib=mib(sum(found.get(p, 0) for p in hp)),
             webkit_mib=mib(sum(found.get(p, 0) for p in webkit)),
             agent_procs=len(agents), skipped=skipped + a_skipped)
    rec.append(s)
    return s


def measure_state(arm, window, rec, sids):
    """3 idle + 5 in-turn samples 2 s apart (ticket-01 method); max over the samples."""
    samples = []
    for _ in range(3):
        samples.append(sample(arm, "idle", window, rec))
        time.sleep(2)
    for i, sid in enumerate(sids):
        arm.prompt(sid, arm.work["busy_prompts"][i % len(arm.work["busy_prompts"])])
    time.sleep(4)
    for _ in range(5):
        arm.turn_tick()
        samples.append(sample(arm, "turn", window, rec))
        time.sleep(2)
    before = {sid: arm.activity(sid) for sid in sids}
    time.sleep(1.5)
    streaming = sum(arm.activity(sid) != before[sid] for sid in sids)
    for sid in sids if arm.work is WORK else []:  # end the turn so the next state starts idle (the fixture has none; its Esc calls a core hook)
        arm.esc(sid)
    time.sleep(3)
    top = max(samples, key=lambda s: s["app_mib"])  # components of the sample the maximum came from
    comps = dict(core=top["parts_mib"][0], app=round(top["app_mib"] - top["parts_mib"][0] - top["webkit_mib"], 1), webkit=top["webkit_mib"])
    return dict(app_mib=top["app_mib"], agents_mib=max(s["agents_mib"] for s in samples), components=comps,
                streaming_at_end=f"{streaming}/{len(sids)}", loads=[s["load"] for s in samples])


def versions():
    v = lambda *a: subprocess.run(list(a), capture_output=True, text=True).stdout.strip()  # noqa: E731
    return dict(macos=v("sw_vers", "-productVersion") + " " + v("sw_vers", "-buildVersion"),
                commit=v("git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"),
                dirty=bool(v("git", "-C", str(ROOT), "status", "--porcelain", "--", "crates", "app", "web")),
                claude=v("claude", "--version"), herdr=v("herdr", "--version"), host=v("sysctl", "-n", "hw.model"),
                memory_gib=int(v("sysctl", "-n", "hw.memsize")) // 2**30, cores=os.cpu_count())


def memory_free_pct():
    m = re.search(r"free percentage: (\d+)%", subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout)
    return int(m[1]) if m else None


def preflight():
    for b in (CORE, APP):
        if not b.is_file():
            raise SystemExit(f"missing release build {b}; run scripts/measure/build.sh")
    if subprocess.run(["herdr", "--version"], capture_output=True).returncode:
        raise SystemExit("herdr is not installed; the comparison needs it")


def footprint_cmd(a, out, raw):
    sizes = [int(x) for x in a.sessions.split(",")]
    reps, tag = {}, "v1b-" if a.v1b else ""
    apps = V1B_APPS if a.v1b else ml.APPS + ((HerdrGhostty.name,) if a.ghostty else ())
    for n, r, app in ml.order(sizes, a.repeats, apps):
        free = memory_free_pct()
        if free is not None and free < 20:
            raise RuntimeError(f"memory free {free}% below 20% before {app} {n} sessions; refusing to load the host further")
        arm, rec = None, []
        try:
            arm = make_arm(app, a.v1b)
            sids = [arm.start(i) for i in range(n)]
            arm.wait_ready(sids)
            arm.after_ready(sids)
            time.sleep(10)  # let plugins settle (ticket-01 waited 15 s for MCP servers; none here)
            arm.open()
            time.sleep(12)  # window loads, connects and renders its terminals
            arm.after_open()
            opened = measure_state(arm, True, rec, sids)
            opened["lingering_helpers"] = arm.close()
            closed = None
            if app != HerdrGhostty.name:  # with its window gone this arm is plain herdr: already the herdr arm's closed row
                time.sleep(3)
                closed = measure_state(arm, False, rec, sids)
        finally:
            if arm is not None:  # a failed start must not leave the scratch core or server running
                arm.stop()
            (out / f"samples-{app}-{n}-{r}.json").write_text(json.dumps(rec, indent=1))
        for state, res in (("open", opened), ("closed", closed)):
            if res:
                reps.setdefault(f"{tag}{state}-{n}", {}).setdefault(app, []).append(res)
        done = f", closed {closed['app_mib']} / {closed['agents_mib']} MiB" if closed else ""
        print(f"{app} {n} sessions repeat {r + 1}: open {opened['app_mib']} / {opened['agents_mib']} MiB{done}, "
              f"load {ml.load_range(opened['loads'] + (closed['loads'] if closed else []))}", flush=True)
    pairs = {}
    for row, by in reps.items():
        get = lambda app, k: [x[k] for x in by.get(app, [])]  # noqa: E731
        p = ml.pair(get("nunchiro", "app_mib"), get("herdr", "app_mib"))
        p["agents"] = ml.pair(get("nunchiro", "agents_mib"), get("herdr", "agents_mib"))
        if get(HerdrGhostty.name, "app_mib"):  # herdr + one Ghostty window: the ratio is Nunchiro / that sum
            g = ml.pair(get("nunchiro", "app_mib"), get(HerdrGhostty.name, "app_mib"))
            p["ghostty"] = dict(mib=g["herdr"], ratio=g["ratio"], spread=g["spread_herdr"])
        p["load"] = ml.load_range([ld for app in by for x in by[app] for ld in x["loads"]])
        p["mark"] = ml.load_mark(p["load"])
        p["streaming_at_end"] = {app: [x["streaming_at_end"] for x in by[app]] for app in by}
        if a.v1b:
            comp = lambda app: {k: ml.median([x["components"][k] for x in by[app]]) for k in ("core", "app", "webkit")}  # noqa: E731
            p["plain"] = ml.median([x["app_mib"] for x in by["plain"]])
            p["components"] = {app: comp(app) for app in ("nunchiro", "plain")}
            p["delta"] = ml.component_delta(p["components"]["nunchiro"], p["components"]["plain"])
        pairs[row] = p
    raw.update(reps=reps, pairs=pairs)
    rows = {f"nunchiro-{row}": p["nunchiro"] for row, p in pairs.items()}
    return rows, pairs


class WS:
    """Minimal WebSocket client: the window's protocol (token in Sec-WebSocket-Protocol, tauri origin)."""

    def __init__(self, port, token):
        self.s = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: tauri://localhost\r\n"
                        f"Sec-WebSocket-Protocol: nunchiro.v1, nunchiro.token.{token}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(f"websocket refused: {head[:80]!r}")
        self.buf, self.next = b"", 1

    def send(self, obj):
        data = json.dumps(dict(obj, id=self.next)).encode()
        self.next += 1
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 16)
            if not chunk:
                raise RuntimeError("websocket closed")
            self.buf += chunk

    def recv(self, timeout):
        """(opcode, payload) or None on timeout."""
        self.s.settimeout(timeout)
        try:
            self._need(2)
            op, n = self.buf[0] & 0x0F, self.buf[1] & 0x7F
            off = 2
            if n == 126:
                self._need(4)
                n, off = struct.unpack(">H", self.buf[2:4])[0], 4
            elif n == 127:
                self._need(10)
                n, off = struct.unpack(">Q", self.buf[2:10])[0], 10
            self._need(off + n)
        except socket.timeout:
            return None
        payload, self.buf = self.buf[off:off + n], self.buf[off + n:]
        if op == 9:  # ping: answer so the core keeps us
            mask = os.urandom(4)
            self.s.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        return op, payload


class WSKeys:
    """Nunchiro: a key goes in as the window sends it (`send_text`); the echo is the target's output frame."""

    def __init__(self, ws, target, log):
        self.ws, self.target, self.log = ws, target, log
        ws.send({"watch": target, "after": 0})
        self.seen = b""
        until = time.monotonic() + 15
        while b"ECHO_READY" not in self.seen and time.monotonic() < until:
            self._pump(0.5)
        if b"ECHO_READY" not in self.seen:
            raise RuntimeError("echo target did not start")

    def _pump(self, timeout):
        got = self.ws.recv(timeout)
        if got and got[0] == 2:
            n = struct.unpack(">I", got[1][:4])[0]
            if json.loads(got[1][4:4 + n])["session"] == self.target:
                self.seen += got[1][4 + n:]

    def key(self, k, timeout=2.0):
        """(ms, send_ns) or (None, send_ns)."""
        self.seen = b""
        t = time.monotonic_ns()
        self.ws.send({"request": {"op": "send_text", "id": self.target, "text": k.decode()}})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._pump(max(0.001, deadline - time.monotonic()))
            if k in self.seen:
                now = time.monotonic_ns()
                if self.log.read_between(k.hex(), t, now):
                    return (now - t) / 1e6, t
        return None, t


class PtyKeys:
    """herdr: a key is typed into the client's PTY (as the terminal would); the echo is the client drawing it."""

    def __init__(self, client, log):
        self.c, self.log = client, log
        if not client.wait_for("ECHO_READY", 15):
            raise RuntimeError("echo target not shown in the herdr client")

    def key(self, k, timeout=2.0):
        t, wall = time.monotonic_ns(), time.time()
        mark = len(self.c.chunks)
        self.c.send(k)
        deadline = time.monotonic() + timeout
        acc = b""
        while time.monotonic() < deadline:
            with self.c.lock:
                new = self.c.chunks[mark:]
            for ts, b in new:
                acc += b
                mark += 1
                det = t + int((ts - wall) * 1e9)
                # Only after the target read the key: a sidebar or status redraw cannot pass as the echo.
                if k in acc and self.log.read_between(k.hex(), t, det):
                    return (ts - wall) * 1000, t
            time.sleep(0.0005)
        return None, t


def latency_one(app, n, out, r):
    arm, rec = None, {}
    try:
        arm = ARMS[app]()
        busy = [arm.start(i) for i in range(3)]
        log = arm.home / "echo.log"
        target = arm.start_echo(log)
        arm.wait_ready(busy)
        arm.open()  # Nunchiro: the window watches the sessions too; herdr: keys go through the client
        time.sleep(12)
        if app == "nunchiro":
            arm.parts(True)  # refuses a window with zero WebKit helpers
        chan = arm.keys(target, ml.EchoLog(log))
        for i, sid in enumerate(busy):
            arm.prompt(sid, WORK["busy_prompts"][i % 2])
        time.sleep(8)  # let the busy turns start streaming
        keys, lat, misses, loads, hangul = WORK["keys"], [], 0, [load()], []
        for i in range(n):
            k = keys[i % len(keys)].encode()
            ms, _ = chan.key(k)
            if ms is None:
                misses += 1
            else:
                lat.append(ms)
                if len(k) > 1:
                    hangul.append(ms)
            if i % 50 == 49:
                loads.append(load())
            time.sleep(0.05)
        before = {sid: arm.activity(sid) for sid in busy}
        time.sleep(1.5)
        streaming = sum(arm.activity(sid) != before[sid] for sid in busy)
        loads.append(load())
        judged = lat + [2000.0] * misses  # a key never echoed counts as the 2 s timeout, never dropped
        rec = dict(app=app, repeat=r, judged=judged, hangul=hangul, misses=misses, loads=loads,
                   busy_streaming_at_end=f"{streaming}/3")
    finally:
        if arm is not None:
            arm.stop()
        (out / f"latency-{app}-{r}.json").write_text(json.dumps(rec, indent=1))
    p95 = ml.pct(judged, 95)
    print(f"{app} latency repeat {r + 1}: n {len(judged)} misses {misses} p50 {ml.pct(judged, 50):.2f} p95 {p95:.2f} ms, "
          f"busy at end {streaming}/3, load {ml.load_range(loads)}", flush=True)
    return rec


def latency_cmd(a, out, raw):
    runs = {}
    for _, r, app in ml.order([3], a.repeats):
        runs.setdefault(app, []).append(latency_one(app, a.n, out, r))
    res = {}
    for app, rs in runs.items():
        allk = [x for rr in rs for x in rr["judged"]]
        hg = [x for rr in rs for x in rr["hangul"]]
        res[app] = dict(n=len(allk), misses=sum(rr["misses"] for rr in rs), p50_ms=round(ml.pct(allk, 50), 2),
                        p95_ms=round(ml.pct(allk, 95), 2), max_ms=round(max(allk), 2),
                        hangul_n=len(hg), hangul_p95_ms=round(ml.pct(hg, 95), 2) if hg else None,
                        p95_per_repeat=[round(ml.pct(rr["judged"], 95), 2) for rr in rs],
                        busy_at_end=[rr["busy_streaming_at_end"] for rr in rs])
    loads = [ld for rs in runs.values() for rr in rs for ld in rr["loads"]]
    pair = dict(p50=ml.pair([res["nunchiro"]["p50_ms"]], [res["herdr"]["p50_ms"]]),
                p95=ml.pair([res["nunchiro"]["p95_ms"]], [res["herdr"]["p95_ms"]]),
                load=ml.load_range(loads), mark=ml.load_mark(ml.load_range(loads)))
    relay = subprocess.run([sys.executable, "-I", str(HERE / "echo_latency.py"), "--target", "cat", "--n", "300"],
                           capture_output=True, text=True)
    relay = json.loads(relay.stdout.strip().splitlines()[-1]) if relay.returncode == 0 else {"error": relay.stderr[-300:]}
    raw.update(res=res, pair=pair, relay=relay)
    # Compared row: Nunchiro's own pooled p95 held steady under load; the ratio swings with herdr's p95
    # (4.5-21 ms per repeat), so it is recorded but not judged.
    rows = {"nunchiro-busy3-p95": res["nunchiro"]["p95_ms"]}
    return rows, (res, pair, relay)


def write_entry(kind, body_lines, data, a):
    text = FIGURES.read_text() if FIGURES.exists() else ""
    prev = ml.last_entry(text, kind)
    band = ml.LATENCY_BAND if kind == "latency" else ml.NOISE_BAND
    if not a.compare:
        ok, lines = True, []
    elif kind == "footprint_v1b":  # compared with the newest v1a footprint entry, not with an earlier v1b one
        ok, lines = ml.compare_v1b(text, data["rows"], band, a.reason)
    else:
        ok, lines = ml.compare(prev and prev["rows"], data["rows"], band, a.reason)
    for l in lines:
        print("compare:", l)
    if not ok:
        print(f"compare: a figure rose above the {band:.0%} noise band; not recorded. Rerun with --reason TEXT to record it.")
        return False
    body = "\n".join(body_lines + ([f"\nCompare (`--compare`, band {band:.0%}):", ""] + [f"- {l}" for l in lines] if lines else []))
    if a.reason:
        data["reason"] = a.reason
    ml.prepend_entry(str(FIGURES), body, kind, data)
    print(f"recorded in {FIGURES.relative_to(ROOT)}")
    return True


def fmt_spread(p):
    return " / ".join("-" if x is None else f"{x:.0%}" for x in (p["spread_nunchiro"], p["spread_herdr"]))


def footprint_body(rows, pairs, a):
    g = a.ghostty
    body = [f"`footprint` (phys_footprint), MiB; max of 3 idle + 5 in-turn samples 2 s apart, median of {a.repeats} repeats, "
            "Nunchiro and herdr interleaved per repeat. Nunchiro = core (+ app + helpers by responsible pid, window open). "
            "herdr = server (+ attached client, open). Agents = everything under the core or server (herdr: + each pane's shell)."
            + (" herdr+Ghostty = the herdr server plus one Ghostty window (Ghostty, its descendants and responsible-pid helpers; "
               "the herdr client runs inside it) attached to the same kind of scratch server; open rows only, closed it is plain herdr."
               if g else ""), "",
            "| Row | Nunchiro | herdr |" + (" herdr+Ghostty | Ratio N/(h+G) |" if g else "") + " Ratio N/h | Agents N / h | Spread N / h | 1-min load |",
            "|---|---|---|" + ("---|---|" if g else "") + "---|---|---|---|"]
    sizes = a.sessions.split(",")
    for state in ("open", "closed"):
        for n in sizes:
            p = pairs[f"{state}-{n}"]
            mark = f" **{p['mark']}**" if p["mark"] else ""
            gh = ((f" {p['ghostty']['mib']} | {p['ghostty']['ratio']} |" if "ghostty" in p else " not run | |") if g else "")
            body.append(f"| `{state}-{n}` | {p['nunchiro']} | {p['herdr']} |{gh} {p['ratio']} | {p['agents']['nunchiro']} / "
                        f"{p['agents']['herdr']} | {fmt_spread(p)} | {p['load'][0]}-{p['load'][1]}{mark} |")
    body.append(f"| `orca-*` | reference only: {ORCA_REF} | | " + ("| | " if g else "") + "| not run | | |")
    return body


ORCA_MB = 1091


def footprint_v1b_body(rows, pairs, a):
    body = [f"`footprint` (phys_footprint), MiB; max of 3 idle + 5 in-turn samples 2 s apart, median of {a.repeats} repeats, "
            "Nunchiro, plain Nunchiro and herdr interleaved per repeat. **Nunchiro** = core + app + WebKit helpers, window open on "
            "the chat view of a 5,000-event session (3 inline artifact cards) with the board widget shown; **plain** = the same "
            "fixture sessions, board and window without that transcript; **delta** = Nunchiro minus plain per component (core / "
            "app / WebKit). herdr = server (+ attached client, open) with the same fixture sessions. Agents = the fixture CLI "
            "processes under the core or server (herdr: + each pane's shell), not real agents. In-turn samples append 3 events "
            "each to the chat transcript (live tail); the WebView is not scrolled.", "",
            "| Row | Nunchiro | plain | herdr | Ratio N/h | Delta core / app / WebKit | Agents N / h | Spread N / h | 1-min load |",
            "|---|---|---|---|---|---|---|---|---|"]
    for state in ("open", "closed"):
        for n in a.sessions.split(","):
            p = pairs[f"v1b-{state}-{n}"]
            d = p["delta"]
            mark = f" **{p['mark']}**" if p["mark"] else ""
            body.append(f"| `v1b-{state}-{n}` | {p['nunchiro']} | {p['plain']} | {p['herdr']} | {p['ratio']} | {d['total']:+} "
                        f"({d['core']:+} / {d['app']:+} / {d['webkit']:+}) | {p['agents']['nunchiro']} / {p['agents']['herdr']} | "
                        f"{fmt_spread(p)} | {p['load'][0]}-{p['load'][1]}{mark} |")
    body += ["", f"Still below Orca? Reference only, {ORCA_REF}; indicative, not like for like (RSS against phys_footprint, another "
             "Mac and workload):", ""]
    for n in a.sessions.split(","):
        p = pairs[f"v1b-open-{n}"]
        mb = round(p["nunchiro"] * 1.048576, 1)
        body.append(f"- `v1b-open-{n}`: Nunchiro {p['nunchiro']} MiB = {mb} MB against {ORCA_MB} MB: "
                    + ("below." if mb < ORCA_MB else "**not below: finding, see the dominant component in the delta column.**"))
    return body


def latency_body(res, pair, relay):
    n, h = res["nunchiro"], res["herdr"]
    mark = f" **{pair['mark']}**" if pair["mark"] else ""
    row = lambda name, x: (f"| `{name}` | {x['n']} ({x['misses']} missed) | {x['p50_ms']} ms | {x['p95_ms']} ms | {x['max_ms']} ms | "  # noqa: E731
                           f"{x['hangul_n']} keys, p95 {x['hangul_p95_ms']} ms | {x['p95_per_repeat']} | {x['busy_at_end']} |")
    return ["Keystroke to echo, 3 busy claude sessions, keys 50 ms apart into a raw-mode echo target "
            "(`echo_target.py`) in its own session; pooled over the repeats, Nunchiro and herdr interleaved. Nunchiro: "
            "key sent as the window sends it (WebSocket `send_text`), echo = the target's output frame, window app open. "
            "herdr: key typed into the attached client's PTY, echo = the client drawing it. An echo counts only after "
            "the target logged reading that key.", "",
            "| Row | n | p50 | p95 | max | Hangul | p95 per repeat | Busy at end |", "|---|---|---|---|---|---|---|---|",
            row("nunchiro-busy3", n), row("herdr-busy3", h),
            f"| `ratio N/h` | | {pair['p50']['ratio']} | {pair['p95']['ratio']} | | | | |",
            f"| `relay-cat` (ticket-01 Python relay, no app) | {relay.get('n')} | {relay.get('p50_ms')} ms | "
            f"{relay.get('p95_ms')} ms | {relay.get('max_ms')} ms | | | |",
            "| `orca-busy3` | not run | | | | | | Orca not installed (the owner ORCA=A); no latency reference |", "",
            f"1-min load during the pair: {pair['load'][0]}-{pair['load'][1]}{mark}."]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["footprint", "latency"])
    ap.add_argument("--sessions", default="3,10")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--v1b", action="store_true", help="footprint with the chat view on a 5,000-event session, 3 artifacts, the board")
    ap.add_argument("--ghostty", action="store_true", help="footprint: add the herdr + one Ghostty window arm (open rows)")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--reason")
    ap.add_argument("--no-record", action="store_true", help="measure only; do not write docs/v1/figures.md")
    a = ap.parse_args()
    if a.v1b and a.kind != "footprint":
        raise SystemExit("--v1b applies to footprint")
    if a.v1b and a.ghostty:
        raise SystemExit("--ghostty does not apply to --v1b (the v1b arms are Nunchiro, plain Nunchiro and herdr); run it without --v1b")
    lock = ml.Lock(str(ROOT / ".scratch/measure.lock"))  # noqa: F841 - held until exit
    preflight()
    out = ROOT / ".scratch/measure" / time.strftime(f"%Y%m%d-%H%M%S-{a.kind}")
    out.mkdir(parents=True)
    ver = versions()
    ld0 = load()
    guard_before, herdr_cfg = snapshot(), ml_sha(OWNER_HERDR_CONFIG)
    raw = dict(versions=ver, load_start=ld0)
    try:
        if a.kind == "footprint":
            rows, pairs = footprint_cmd(a, out, raw)
        else:
            rows, (res, pair, relay) = latency_cmd(a, out, raw)
    finally:
        problems, foreign = guard_check(guard_before, snapshot(), [str(ROOT / ".scratch"), str(HERE)])
        if ml_sha(OWNER_HERDR_CONFIG) != herdr_cfg:
            problems.append(f"{OWNER_HERDR_CONFIG} changed during the run")
        raw.update(guard_problems=problems, guard_foreign=foreign, load_end=load())
        (out / "result.json").write_text(json.dumps(raw, indent=1, ensure_ascii=False))
    if problems:
        raise SystemExit(f"guard: user config changed during this run: {problems}")
    when, kind = time.strftime("%Y-%m-%d %H:%M"), a.kind
    head = [f"## {when} {a.kind}{' v1b' if a.v1b else ''}, Nunchiro {ver['commit']}{' (dirty)' if ver['dirty'] else ''} vs {ver['herdr']}", "",
            f"macOS {ver['macos']}, {ver['host']} {ver['memory_gib']} GiB, {ver['cores']} cores; "
            + (f"fixture Claude CLI reporting `{w1b.VERSION}` (no model)" if a.v1b else f"{ver['claude']} (`claude --model haiku --strict-mcp-config`)")
            + f"; Nunchiro release builds. Measured under the host's own load "
            f"(other lanes, live trading), 1-min load {ld0} at start, {load()} at end. "
            f"Command: `sh scripts/measure/{a.kind}.sh{' --v1b' if a.v1b else ''}{' --compare' if a.compare else ''}`. Raw: `{out.relative_to(ROOT)}/`.", ""]
    if a.v1b:
        body = head + footprint_v1b_body(rows, pairs, a)
        data = dict(rows=rows, pairs=pairs, versions=ver)
        kind = "footprint_v1b"
    elif a.kind == "footprint":
        body = head + footprint_body(rows, pairs, a)
        data = dict(rows=rows, pairs=pairs, versions=ver)
    else:
        body = head + latency_body(res, pair, relay)
        data = dict(rows=rows, res=res, pair=pair, versions=ver)
    if a.no_record:
        print("\n".join(body))
        return
    sys.exit(0 if write_entry(kind, body, data, a) else 1)


def ml_sha(path):
    try:
        return hashlib.sha256(open(path, "rb").read()).hexdigest()
    except FileNotFoundError:
        return None


if __name__ == "__main__":
    main()
