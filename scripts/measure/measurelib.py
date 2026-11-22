"""Pure helpers for the release figures (ticket 11): footprint parsing, WebKit helper attribution,
percentiles, the figures record and the --compare rule. Python stdlib only; tested by
tests/scenario/test_measure*.py over fixture outputs."""
import atexit, ctypes, fcntl, json, os, plistlib, re, shutil, signal, statistics, subprocess, sys, tempfile, threading, time
from pathlib import Path

_libproc = ctypes.CDLL("/usr/lib/libproc.dylib")


def _exe(pid: int) -> str:
    """The kernel's executable path of `pid` (proc_pidpath), not ps's comm or args, which argv[0] can fake (Codex w21 r2)."""
    buf = ctypes.create_string_buffer(4096)
    n = _libproc.proc_pidpath(pid, buf, len(buf))
    return buf.value[:n].decode(errors="replace") if n > 0 else ""

# Relative rise above which --compare fails, set just above the repeat spread measured on 2026-10-25
# (docs/v1/figures.md, first footprint entry: up to 24 % for the window-open rows under load 8-27).
NOISE_BAND = 0.25
LATENCY_BAND = 0.50  # Nunchiro p95 per repeat was 20.6-26.3 ms (27 % spread) under load 13-18
# Round 2 (owner 2026-10-25): measure under the host's load, Nunchiro and herdr interleaved so both see it.
# Load is a recorded field; a pair whose 1-min load passed this cap is marked, not silently recorded.
LOAD_CAP = 40.0
APPS = ("nunchiro", "herdr")

# `footprint -f bytes --noCategories`: one header per process, then a summary for several pids.
PROC = re.compile(r"^(?P<name>.+?) \[(?P<pid>\d+)\]: (?:64|32)-bit\s+Footprint: (?P<bytes>\d+) B\b")
# A process that exits while footprint reads it leaves its header without a figure: skipped, not zero.
GONE = re.compile(r"^.+ \[(?P<pid>\d+)\]: (?:64|32)-bit\s*$")
# The tool sometimes breaks the header line: the figure then follows alone, indented, with the page size.
CONTINUED = re.compile(r"^\s+Footprint: (?P<bytes>\d+) B \(\d+ bytes per page\)$")
KNOWN = re.compile(r"^(?:\s+phys_footprint(?:_peak)?: \d+ B|Summary Footprint: \d+ B(?: \(may be invalid due to errors\))?)$")
# A process that exited before footprint read it (seen live 2026-11-20, the session runner's `sleep`): skipped.
EXITED = re.compile(r"^.+ \[\d+\]: .* - No such process$")
# Lines that carry a figure or a process header; anything else (separators, "Unable to find pid ...",
# "Warnings were encountered ...") is the tool's diagnostics and is ignored.
FIGURE = re.compile(r"Footprint|phys_footprint|\[\d+\]:")


class FormatError(ValueError):
    pass


def parse_footprint(text):
    """{pid: bytes} from footprint output. A figure line in a format this parser does not know is refused
    (FormatError naming the raw line) instead of guessed: a newer macOS may change the layout."""
    out, pending = {}, None
    for line in text.splitlines():
        m = PROC.match(line)
        g = GONE.match(line)
        c = CONTINUED.match(line)
        if m:
            out[int(m["pid"])] = int(m["bytes"])
        elif g:
            pending = int(g["pid"])
            continue
        elif c:
            # Without its header (cut by the tool's own diagnostics) the figure has no pid: that process is skipped.
            if pending is not None:
                out[pending] = int(c["bytes"])
        elif FIGURE.search(line) and not KNOWN.match(line) and not EXITED.match(line):
            raise FormatError(f"unknown footprint output line: {line!r}")
        pending = None
    return out


def sum_footprint(found, pids, required=()):
    """(bytes, skipped). A pid missing from the output exited mid-sample: skipped, not counted as zero.
    A required pid (core, app) that is missing is an error, not a skip."""
    missing = [p for p in required if p not in found]
    if missing:
        raise RuntimeError(f"required process gone during the sample: {missing}")
    skipped = [p for p in pids if p not in found]
    return sum(found[p] for p in pids if p in found), skipped


def parse_ps(text):
    """{pid: command} from `ps -A -o pid=,comm=`."""
    out = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            out[int(parts[0])] = parts[1]
    return out


def responsible_pid(pid):
    """macOS responsibility SPI (the pid Activity Monitor groups XPC helpers under); no root needed.
    WebKit's WebContent/Networking/GPU helpers are launchd XPC services (ppid 1), not children of the app."""
    f = _lib().responsibility_get_pid_responsible_for_pid
    return f(pid)


_LIB = []


def _lib():
    if not _LIB:
        lib = ctypes.CDLL(None)
        lib.responsibility_get_pid_responsible_for_pid.restype = ctypes.c_int
        lib.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]
        _LIB.append(lib)
    return _LIB[0]


class Spawned:
    """A process started with the macOS responsibility disclaimed, so it is its own responsible process and its
    WebKit XPC helpers are attributed to it. Started from inside a terminal app (this harness runs in herdr), a plain
    child would hand its helpers' responsibility to that app. Popen-like: pid, poll, terminate, kill, wait.
    A disclaimed process is its own TCC subject, and macOS blocks it in dyld opening a binary on an external volume
    (no prompt can be answered), so a binary under /Volumes runs from a copy in the system temp dir and its cwd is /."""

    copy = None

    def __init__(self, argv, env, stdout):
        if argv[0].startswith("/Volumes/"):
            self.copy = tempfile.mkdtemp(prefix="ns-spawn-")
            argv = [shutil.copy2(argv[0], self.copy), *argv[1:]]
        lib = _lib()
        attr, acts, pid = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_int()
        lib.posix_spawnattr_init(ctypes.byref(attr))
        if lib.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1):
            raise OSError("responsibility_spawnattrs_setdisclaim failed")
        lib.posix_spawn_file_actions_init(ctypes.byref(acts))
        lib.posix_spawn_file_actions_addchdir_np(ctypes.byref(acts), b"/")  # a cwd on the SSD raises the same prompt
        devnull = os.open(os.devnull, os.O_RDONLY)
        for fd, new in ((devnull, 0), (stdout.fileno(), 1), (stdout.fileno(), 2)):
            lib.posix_spawn_file_actions_adddup2(ctypes.byref(acts), fd, new)
        enc = lambda xs: (ctypes.c_char_p * (len(xs) + 1))(*[x.encode() for x in xs], None)  # noqa: E731
        err = lib.posix_spawn(ctypes.byref(pid), argv[0].encode(), ctypes.byref(acts), ctypes.byref(attr), enc(argv),
                              enc([f"{k}={v}" for k, v in env.items()]))
        os.close(devnull)
        if err:
            if self.copy:
                shutil.rmtree(self.copy, ignore_errors=True)
            raise OSError(err, os.strerror(err))
        self.pid, self.code = pid.value, None

    def poll(self):
        if self.code is None and os.waitpid(self.pid, os.WNOHANG)[0]:
            self.code = 0  # the status is not needed, only that it ended
            if self.copy:
                shutil.rmtree(self.copy, ignore_errors=True)
        return self.code

    def wait(self, timeout=None):
        until = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if until and time.monotonic() > until:
                raise subprocess.TimeoutExpired("spawned", timeout)
            time.sleep(0.05)
        return self.code

    def terminate(self, sig=15):
        # poll() reaps an exited child; after that the pid may be reused, so only an unreaped child is signalled
        if self.poll() is None:
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                pass

    def kill(self):
        self.terminate(9)


def _exit_on_term():
    """SIGTERM and SIGHUP end the script through SystemExit, so its finally blocks and atexit (OwnApp.remove) run.
    A signal the script handles or ignores itself (nohup) is left alone; only the main thread can set handlers."""
    if threading.current_thread() is not threading.main_thread():
        return
    for sig in (signal.SIGTERM, signal.SIGHUP):
        if signal.getsignal(sig) == signal.SIG_DFL:
            signal.signal(sig, lambda signum, _frame: sys.exit(128 + signum))


class OwnApp:
    """A copy of the app under its own bundle id and ad-hoc signature, so a run never reads or writes the WebKit store
    of the owner's installed app (dev.nunchiro.app). src is an .app folder (copied) or a bare executable (wrapped in a
    minimal bundle). exe is what to start; remove() deletes the copy and the folders macOS made for its id, never
    another id's. (2026-10-31, ticket 179: measure runs and the click harness shared the owner's store.)"""

    def __init__(self, src):
        src = Path(src)
        self.tmp = Path(tempfile.mkdtemp(prefix="ns-own-"))  # system temp: see Spawned on /Volumes
        self.bundle_id = f"dev.nunchiro.own.{self.tmp.name.split('-')[-1].lower()}"
        self.bundle = self.tmp / "Nunchiro.app"
        plist = self.bundle / "Contents/Info.plist"
        if src.is_dir():
            subprocess.run(["ditto", str(src), str(self.bundle)], check=True)
            subprocess.run(["plutil", "-replace", "CFBundleIdentifier", "-string", self.bundle_id, str(plist)], check=True)
            self.exe = self.bundle / "Contents/MacOS/nunchiro-app"
        else:
            (self.bundle / "Contents/MacOS").mkdir(parents=True)
            self.exe = Path(shutil.copy2(src, self.bundle / "Contents/MacOS" / src.name))
            plist.write_bytes(plistlib.dumps({"CFBundleIdentifier": self.bundle_id, "CFBundleExecutable": src.name,
                                              "CFBundleName": "Nunchiro", "CFBundlePackageType": "APPL"}))
        subprocess.run(["codesign", "--force", "--deep", "-s", "-", str(self.bundle)], check=True, capture_output=True)
        lib = Path.home() / "Library"
        self.owned_dirs = [lib / d / self.bundle_id for d in ("WebKit", "Caches", "HTTPStorages")]
        self.owned_dirs.append(lib / "Saved Application State" / f"{self.bundle_id}.savedState")
        atexit.register(self.remove)  # a script that never reaches remove() still ends its copy's processes
        _exit_on_term()

    def _running(self):
        """PIDs of processes started from this copy (its app, a core the app started, their session holders)."""
        roots = tuple({f"{self.tmp}/", f"{self.tmp.resolve()}/"})
        pids = (int(p) for p in subprocess.run(["ps", "-axo", "pid="], capture_output=True, text=True).stdout.split())
        return [pid for pid in pids if pid != os.getpid() and _exe(pid).startswith(roots)]

    def stop_processes(self):
        """Ends every process still running from this copy, whoever started it (a script's relaunch, the app's own
        core). The copy's folder is unique to this OwnApp, so a match by its path is ours."""
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
            pids = self._running()
            roots = tuple({f"{self.tmp}/", f"{self.tmp.resolve()}/"})
            for pid in pids:
                try:
                    if _exe(pid).startswith(roots):  # checked again just before the signal: a reused pid is not ours
                        os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            until = time.monotonic() + wait
            while pids and time.monotonic() < until:
                time.sleep(0.1)
                pids = self._running()
            if not pids:
                return

    def remove(self):
        self.stop_processes()
        shutil.rmtree(self.tmp, ignore_errors=True)
        for d in self.owned_dirs:
            if self.bundle_id in d.name:  # only this copy's own id
                shutil.rmtree(d, ignore_errors=True)


def attribute(procs, responsible, app_pid, exclude=()):
    """Helpers of the window app: every process whose responsible pid is the app, minus the app itself and
    `exclude` (the core tree, started by us before the app). Returns (pids, webkit_pids)."""
    pids = sorted(p for p in procs if p != app_pid and p not in exclude and responsible.get(p) == app_pid)
    return pids, [p for p in pids if "com.apple.WebKit" in procs[p]]


def window_parts(tree, procs, responsible, root, exclude=()):
    """Pids a terminal window adds to herdr: its descendants (the attached herdr client, the login shell) plus
    every process whose responsible pid is `root`, minus `root` itself and `exclude` (the herdr server tree,
    whose panes are counted as agents, so nothing is counted twice)."""
    helpers, _ = attribute(procs, responsible, root, exclude)
    return sorted((set(tree) | set(helpers)) - set(exclude) - {root})


def pct(values, p):
    """Nearest-rank percentile over the sorted values (same rule as ticket 01's echo_latency.py)."""
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def median(values):
    return statistics.median(values)


def spread(values):
    """(max - min) / median: the repeat-to-repeat noise of one row."""
    m = median(values)
    return (max(values) - min(values)) / m if m else 0.0


def order(sizes, repeats, apps=APPS):
    """Run order: for each size and repeat, every app back to back (A, B, A, B ...)."""
    return [(n, r, app) for n in sizes for r in range(repeats) for app in apps]


def pair(nunchiro, herdr):
    """One recorded row from both apps' repeat values: medians, Nunchiro/herdr ratio, repeat spreads."""
    a = median(nunchiro) if nunchiro else None
    b = median(herdr) if herdr else None
    return dict(nunchiro=a, herdr=b, ratio=round(a / b, 3) if a is not None and b else None,
                spread_nunchiro=spread(nunchiro) if nunchiro else None, spread_herdr=spread(herdr) if herdr else None)


def load_range(loads):
    return [min(loads), max(loads)]


def load_mark(rng, cap=LOAD_CAP):
    return f"extreme load: 1-min load reached {rng[1]} (cap {cap})" if rng[1] > cap else None


class EchoLog:
    """echo_target.py's read log (`<monotonic_ns> <hex>` per read), read as it grows; a line still being
    written is left for the next poll."""

    def __init__(self, path):
        self.path, self.pos, self.reads = path, 0, []

    def poll(self):
        try:
            with open(self.path, "rb") as f:
                f.seek(self.pos)
                data = f.read()
        except FileNotFoundError:
            return
        done = data.rfind(b"\n") + 1
        self.pos += done
        for line in data[:done].decode().splitlines():
            if line.strip():
                t, h = line.split()
                self.reads.append((int(t), h))

    def read_between(self, hx, after_ns, before_ns):
        """When the target read `hx` inside the window, else None."""
        self.poll()
        return next((t for t, h in self.reads if h == hx and after_ns <= t <= before_ns), None)


# Figures record: newest entry first; each entry ends with one machine-readable comment line.
MARK = re.compile(r"^<!-- measure:(?P<kind>\w+) (?P<json>\{.*\}) -->$", re.M)
HEADER = "# Release figures\n\nNewest entry first. Written by `scripts/measure/footprint.sh`, `scripts/measure/latency.sh` and `scripts/measure/paint.sh`.\n"


def last_entry(text, kind):
    """The newest recorded entry of `kind` ({rows, ...}) or None (fresh checkout, or none of that kind)."""
    for m in MARK.finditer(text or ""):
        if m["kind"] == kind:
            return json.loads(m["json"])
    return None


def compare(prev, cur, band, reason=None):
    """(ok, lines). A row whose value rose by more than `band` (relative) since `prev` fails unless a
    reason is given; the reason is then recorded. Rows absent on either side are listed, not judged."""
    if prev is None:
        return True, ["no previous entry: first entry written"]
    ok, lines = True, []
    for row, value in sorted(cur.items()):
        before = prev.get(row)
        if before is None or value is None:
            lines.append(f"{row}: no previous value")
            continue
        rise = (value - before) / before if before else 0.0
        if rise > band:
            ok = False
            lines.append(f"{row}: rose {before} -> {value} (+{rise:.0%}, band {band:.0%})")
        else:
            lines.append(f"{row}: {before} -> {value} ({rise:+.0%}) within band {band:.0%}")
    if not ok and reason:
        lines.append(f"rise accepted, reason: {reason}")
        ok = True
    return ok, lines


def compare_v1b(figures_text, cur, band, reason=None):
    """`compare` of the v1b rows (`nunchiro-v1b-<state>-<n>`) against the newest v1a footprint entry's
    `nunchiro-<state>-<n>` rows. Rows are renamed so the messages name the v1b row."""
    prev = last_entry(figures_text, "footprint")
    if prev is None:
        return True, ["no v1a entry in the record: nothing to compare, first v1b entry written"]
    return compare({k.replace("nunchiro-", "nunchiro-v1b-", 1): v for k, v in prev["rows"].items()}, cur, band, reason)


def component_delta(v1b, baseline):
    """MiB the chat view, artifacts and board add per component (core, app, webkit) plus their total."""
    d = {k: round(v1b[k] - baseline[k], 1) for k in ("core", "app", "webkit")}
    d["total"] = round(sum(d.values()), 1)
    return d


def prepend_entry(path, body, kind, data):
    """Writes `body` plus its machine line as the newest entry; creates the file on a fresh checkout."""
    try:
        old = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        old = HEADER
    head, sep, rest = old.partition("\n## ")
    entry = body.rstrip() + "\n\n" + f"<!-- measure:{kind} {json.dumps(data, ensure_ascii=False, sort_keys=True)} -->\n"
    new = head.rstrip() + "\n\n" + entry + ("\n## " + rest if sep else "")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(new)
    os.replace(tmp, path)


class Lock:
    """One measure run at a time on this checkout (`.scratch/measure.lock`); a second run refuses to start."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.f = open(path, "a+")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.f.close()
            raise SystemExit(f"another measure run holds {path}; refusing to start")


# Paint figures (V1A-44, scripts/measure/paint.sh): frames, stalls, stuck terminals, growth, the read-log rule for
# painted echoes, the browser's web-content processes, the lumen quiet windows and the proposed pass bars.
LATE_MS, STALL_MS = 33.0, 200.0  # a frame later than two 60 Hz vsyncs; a main-thread stall a user sees
MIN_FPS = 30  # idle rAF rate below this: the engine throttles frames (headless Chromium: 8-12), frame figures invalid; load alone gave 43-46
STUCK_S = 5.0
GROWTH_AT, GROWTH_MAX = 2, 1.25
PAINT_P95_MS, PAINT_N, PROBE_MS, MEM_MIB, SOAK_MIN = 50, 300, 250, 40, 10  # proposed bars (ticket 44)
PAINT_LOAD_STOP = 20.0  # coordinator (round 2): a phase stops past this 1-min load; one retry, then "not run: load"
PAINT_LOAD_START = 15.0  # coordinator (round 2): the run and a retry start only under this 1-min load
QUIET = (((19, 45), (20, 15)), ((23, 30), (0, 30)))  # lumen quiet windows, UTC
BARS = dict(paint=f"p95 < {PAINT_P95_MS} ms, n >= {PAINT_N}, 0 missed (missed = 2 s)",
            stream=f"all end markers painted; 8 terminals: no stall > {STALL_MS:g} ms, mid-stream probe paints < {PROBE_MS} ms",
            mem=f"per-terminal increase with full scrollback < {MEM_MIB} MiB",
            soak=f"{SOAK_MIN} min, 0 crashes, 0 stuck terminals (heartbeat painted within {STUCK_S:g} s), "
                 f"footprint at end <= {GROWTH_MAX} x minute {GROWTH_AT}")


def frame_stats(ts, late=LATE_MS, stall=STALL_MS):
    """rAF timestamps (ms) -> frames, late intervals (> late), stalls (> stall), worst and p95 interval."""
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    return dict(frames=len(ts), late=sum(g > late for g in gaps), stalls=sum(g > stall for g in gaps),
                worst_ms=round(max(gaps), 1) if gaps else None, p95_ms=round(pct(gaps, 95), 1) if gaps else None)


def frames_valid(idle_fps):
    return idle_fps is not None and idle_fps >= MIN_FPS


def stuck(painted, terms, start, end, limit=STUCK_S):
    """{term: worst gap s} for each terminal whose heartbeat went unpainted for more than `limit`, counting from
    `start` to its first painted heartbeat and from its last one to `end`."""
    out = {}
    for t in terms:
        times = [start] + sorted(painted.get(t, [])) + [end]
        worst = max(b - a for a, b in zip(times, times[1:]))
        if worst > limit:
            out[t] = round(worst, 2)
    return out


def growth(samples, at=GROWTH_AT, bound=GROWTH_MAX):
    """(ok, end / value at minute `at`) over (minute, bytes) samples; (None, None) when no sample at `at`."""
    ref = next((v for m, v in samples if m == at), None)
    if not ref:
        return None, None
    ratio = samples[-1][1] / ref
    return ratio <= bound, round(ratio, 3)  # judged unrounded: 1.2501 is over 1.25


def per_terminal(base, loaded, n):
    """MiB each of `n` terminals adds over the baseline (bytes in)."""
    return round((loaded - base) / n / 2**20, 1)


def judge_keys(keys, log):
    """(judged ms, misses, unread) from the page's key records ({hex, send_ns, done_ns, ms}). A key counts only
    when painted (ms) and the target logged reading it between send and paint; otherwise it is the 2 s miss.
    `unread` counts painted keys without that read (a redraw cannot pass as the echo)."""
    judged, misses, unread = [], 0, 0
    for k in keys:
        if k["ms"] is not None and log.read_between(k["hex"], k["send_ns"], k["done_ns"]):
            judged.append(k["ms"])
            continue
        misses += 1
        unread += k["ms"] is not None
        judged.append(2000.0)
    return judged, misses, unread


WEB_CONTENT = {"webkit": "com.apple.WebKit.WebContent", "chromium": "Helper (Renderer)"}


def web_content(procs, responsible, tree, root, engine):
    """Web-content pids of the browser this run launched: processes under `root` (descendants in `tree`, or launchd
    XPC services whose responsible pid is `root`) whose command names the engine's page process."""
    if engine not in WEB_CONTENT:
        raise ValueError(f"unknown engine {engine!r}")
    ours = set(tree) | {p for p in procs if responsible.get(p) == root}
    return sorted(p for p in ours if p in procs and WEB_CONTENT[engine] in procs[p])


def quiet(now, minutes):
    """The lumen quiet window ("HH:MM-HH:MMZ") that [now, now + minutes] touches (UTC), else None."""
    start = now.hour * 60 + now.minute
    for (h1, m1), (h2, m2) in QUIET:
        a, b = h1 * 60 + m1, h2 * 60 + m2
        b += 1440 if b < a else 0
        for s in (start, start + 1440, start - 1440):
            if s < b and s + minutes > a:
                return f"{h1:02d}:{m1:02d}-{h2:02d}:{m2:02d}Z"
    return None


def paint_bar(r):
    ok = r["p95_ms"] < PAINT_P95_MS and r["n"] >= PAINT_N and r["misses"] == 0
    return ok, BARS["paint"]


def stream_bar(r):
    ok = all(p == r["terminals"] for p in r["painted"])
    if r["terminals"] == 8:
        ok = ok and not any(r["stalls"]) and r["probe_max_ms"] is not None and r["probe_max_ms"] < PROBE_MS
    return ok, BARS["stream"]


def mem_bar(per_term_mib):
    return per_term_mib < MEM_MIB, BARS["mem"]


def soak_bar(r):
    ok = r["minutes"] >= SOAK_MIN and r["crashes"] == 0 and not r["stuck"] and r["growth"][0] is True
    return ok, BARS["soak"]


def delivery(frames):
    """{bytes, skipped, frames} of one session's output frames ([start, length] as the window received them). Each byte
    counts once: a repeated or overlapping frame adds only bytes past the furthest seen; a gap before a frame's start
    is output the core skipped (it keeps 1 MiB per session)."""
    seen = got = skipped = n = 0
    for start, length in frames:
        new = start + length - max(start, seen)
        if new <= 0:
            continue
        skipped += max(0, start - seen)
        got += new
        n += 1
        seen = start + length
    return dict(bytes=got, skipped=skipped, frames=n)
