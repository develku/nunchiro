"""Ticket 1098: the scorecard's measured figures on an isolated RC, and the scorecard page.

Usage:
  scorecard.py run [--repeats 5] [--sessions 20] [--no-build] [--out FILE]
      Builds (or reuses, --no-build) the RC bundle of startup.py, then per repeat: an install of that bundle into a fresh
      throwaway folder and its cold launch, a warm launch, the core start, idle memory and CPU of core + window + WebKit
      at 0 and at --sessions shell sessions, sessions.json and snapshot growth, and the send-to-agent latency. Then the
      gate and owner-install figures from the mainwatch log (read only) and the locale key coverage. Writes
      docs/measure/results-<date>.json (or --out).
  scorecard.py dev [--target DIR] [--out FILE]
      Maintainability figures (part p26): a cold and a warm debug build of the Rust workspace in DIR (a fresh cargo
      target, removed first), the web build, the gate's Rust test stage (scripts/cargo-test-gate.sh) on that target,
      the largest source files, and the files that two or more open lanes (local branches with a commit today that
      origin/main does not have) both change. Writes docs/measure/dev-<date>.json; `page` reads the newest one.
  scorecard.py ops [--clones DIR] [--out FILE]
      Parts p27 and p29. Deploy stability from the mainwatch and landloop logs (read only): each red episode on main
      (first RED to the next GREEN), the change failure rate over tested main tips and the minutes red; reverts landed.
      Supply chain: lockfiles tracked, audit and outdated tools present (nothing is fetched: an audit that needs the
      network is reported as not run), an SBOM, and two clean clones of origin/main (scripts/update-clone.sh from a
      local bare copy) built with --locked --offline, whose nunchiro binaries are compared. Writes ops-<date>.json.
  scorecard.py merge OUT RUN...
      One results file from several runs: every value kept, median and range over all repeats (the reported range).
  scorecard.py check FIRST SECOND
      Says, per figure, whether the SECOND run's median lies in the FIRST run's range (the repeat check); exit 1 if not.
  scorecard.py page [RESULTS]
      Renders docs/measure/scorecard.html from RESULTS (default: the newest docs/measure/results-*.json),
      docs/measure/parts.json (peer and rubric scores) and docs/measure/tasks.json (the peer task table).

Isolation: every process it starts (the app copy, its core, the core of the window phase and their sessions) gets a
fresh system-temp HOME and NUNCHIRO_HOME; no NUNCHIRO_* variable is inherited; the app runs as a copy under its own
bundle id (measurelib.OwnApp). Code that reads the passwd home instead of HOME (update claims) is not redirected.
Once per launch and once per window phase it lists, with lsof, the open files of the window, its helpers (WebKit, by
responsible pid), the core and every process under the core, and fails the run if one is under ~/.nunchiro, ~/.claude
or ~/.codex; it also fails if the owner's core is not the same process at the end. lsof sees open files at that
moment only, not a file opened and closed in between. Runs before 2026-11-24 run 4 gave the window phase the real HOME.
Stops only the PIDs it started. MEASURE_TARGET (see startup.py) puts the cargo target on another disk.
Stdlib only; the pure parts are tested by tests/scenario/test_measure_scorecard.py."""
import argparse, html, json, os, re, shutil, socket, statistics, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))

OUT_DIR = ROOT / "docs/measure"
SHOTS = OUT_DIR / "shots"
# The coordinator's mainwatch log lives in the main checkout's .scratch (a worktree shares its git common dir).
_COMMON = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                         capture_output=True, text=True).stdout.strip()
MAINWATCH = Path(os.environ.get("MEASURE_MAINWATCH") or Path(_COMMON or ROOT / ".git").parent / ".scratch/fable/mainwatch.log")
OWNER_HOME = Path.home() / ".nunchiro"
# The owner's folders a run must never open: the Nunchiro home and the agents' own settings (read through HOME).
OWNER_DIRS = [OWNER_HOME, Path.home() / ".claude", Path.home() / ".codex"]
LANGS = ("ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "pt")

# Anchors: (100 at, 0 at). The same table is in docs/measure/rubric.md; change both together.
ANCHORS = {
    "launch_warm_s": (0.5, 3.0), "launch_cold_s": (1.0, 5.0), "core_start_s": (0.1, 2.0), "send_ms": (50, 1000),
    "idle_cpu_pct": (0.2, 5.0), "idle_mib": (150, 1100), "mib_per_session": (1, 20), "sessions_json_kib_per_session": (1, 50),
    "snapshot_kib_per_session": (2, 50), "installs_ok_pct": (100, 0), "owner_installs_landed_pct": (100, 0),
    "gate_green_pct": (100, 70), "gate_median_min": (5, 30), "locale_coverage_pct": (100, 80),
}
# Which figures make each number part (rubric.md, "Parts and methods").
NUMBER_PARTS = {
    "p05": ["installs_ok_pct", "owner_installs_landed_pct"],
    "p08": ["launches_drawn_pct", "sessions_alive_pct", "gate_green_pct"],
    "p12": ["gate_green_pct", "gate_median_min"],
    "p14": ["idle_cpu_pct", "idle_mib", "mib_per_session", "sessions_json_kib_per_session", "snapshot_kib_per_session"],
    "p15": ["launch_warm_s", "launch_cold_s", "core_start_s", "send_ms"],
    "p18": ["locale_coverage_pct"],
}
ANCHORS.update(launches_drawn_pct=(100, 80), sessions_alive_pct=(100, 80),
               build_cold_min=(3, 20), build_warm_s=(15, 180), web_build_s=(15, 120), test_stage_min=(3, 20),
               largest_file_lines=(2000, 15000), files_over_2000=(0, 20), shared_files_open_lanes=(0, 10))
ANCHORS.update(change_failure_pct=(5, 30), restore_median_min=(60, 1440))
NUMBER_PARTS["p27"] = ["change_failure_pct", "restore_median_min"]
LANDLOOP = MAINWATCH.parent / "landloop.log"
NUMBER_PARTS["p26"] = ["build_cold_min", "build_warm_s", "web_build_s", "test_stage_min", "gate_median_min",
                       "largest_file_lines", "files_over_2000", "shared_files_open_lanes"]
SOURCE = re.compile(r"\.(rs|ts|tsx|css|py|sh)$")
NOT_SOURCE = re.compile(r"(^|/)(tests?|fixtures)/|_tests?\.rs$|/tests\.rs$|\.spec\.ts$|\.test\.m?[jt]sx?$|(^|/)i18n/areas/")


def points(value, best, worst):
    """Linear score between the 0 point and the 100 point, clamped; works for lower-is-better and higher-is-better."""
    if value is None:
        return 0
    return round(max(0.0, min(1.0, (value - worst) / (best - worst))) * 100)


def mean_known(values):
    known = [v for v in values if v is not None]
    return round(statistics.mean(known)) if known else 0


def stats(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return dict(median=None, min=None, max=None, n=0, values=values)
    return dict(median=round(statistics.median(vals), 3), min=round(min(vals), 3), max=round(max(vals), 3), n=len(vals), values=values)


def parse_mainwatch(text, runs=30, installs=20):
    """Gate runs ("testing <sha>" then "GREEN|RED <sha>") with their minutes, and owner install outcomes.
    A run that crosses midnight adds 24 h. Lines of other kinds are ignored."""
    def secs(hms):
        h, m, s = map(int, hms.split(":"))
        return h * 3600 + m * 60 + s
    gates, pending, inst = [], {}, []
    for line in text.splitlines():
        m = re.match(r"^(\d\d:\d\d:\d\d) testing ([0-9a-f]{40})$", line)
        if m:
            pending[m[2]] = secs(m[1])
            continue
        m = re.match(r"^(\d\d:\d\d:\d\d) (GREEN|RED) ([0-9a-f]{40})\b", line)
        if m and m[3] in pending:
            d = secs(m[1]) - pending.pop(m[3])
            gates.append(dict(sha=m[3][:9], verdict=m[2], minutes=round((d + 86400 if d < 0 else d) / 60, 1)))
            continue
        m = re.match(r"^\d\d:\d\d:\d\d owner (?:install|build of) ([0-9a-f]{40})[: ](.*)$", line)
        if m:
            rest = m[2]
            inst.append("installed" if "installed" in rest else "failed" if "FAILED" in rest else "skipped")
    last, li = gates[-runs:], inst[-installs:]
    green = sum(g["verdict"] == "GREEN" for g in last)
    return dict(runs=len(last), green=green, green_pct=round(100 * green / len(last), 1) if last else None,
                median_min=statistics.median([g["minutes"] for g in last]) if last else None,
                min_min=min((g["minutes"] for g in last), default=None), max_min=max((g["minutes"] for g in last), default=None),
                installs=dict(n=len(li), installed=li.count("installed"), skipped=li.count("skipped"), failed=li.count("failed"),
                              landed_pct=round(100 * li.count("installed") / len(li), 1) if li else None))


def within(first, second):
    """{figure: (second median, first min, first max, inside)} for the figures both runs have."""
    out = {}
    for k, a in first["figures"].items():
        b = second["figures"].get(k)
        if b and None not in (a["min"], a["max"], b["median"]):
            out[k] = (b["median"], a["min"], a["max"], a["min"] <= b["median"] <= a["max"])
    return out


def parse_deploys(text, start=None):
    """Red episodes on main from the mainwatch log: from the first RED after green to the next GREEN. The log has times
    only; a time earlier than the one before it starts a new day (shortcut: a gap of more than a day is not seen; the
    log is read in one sitting by its owner's loop, so gaps are hours). Infra reds ("red at ... no named failure") are
    not change failures."""
    day, last, tested, episodes, open_, culprits = 0, None, 0, [], None, set()
    import datetime
    label = lambda d, hh, mm: f"{(start + datetime.timedelta(days=d)).isoformat() if start else f'day {d}'} {hh}:{mm}"  # noqa: E731
    for line in text.splitlines():
        c = re.match(r"^\d\d:\d\d:\d\d culprit ([0-9a-f]{40})", line)
        if c:
            culprits.add(c[1][:9])
        m = re.match(r"^(\d\d):(\d\d):(\d\d) (testing|GREEN|RED) ([0-9a-f]{40})", line)
        if not m:
            continue
        t = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
        if last is not None and t < last:
            day += 1
        last = t
        at = day * 86400 + t
        if m[4] == "testing":
            tested += 1
        elif m[4] == "RED" and open_ is None:
            open_ = dict(sha=m[5][:9], red_at=label(day, m[1], m[2]), t=at)
        elif m[4] == "GREEN" and open_ is not None:
            episodes.append(dict(sha=open_["sha"], red_at=open_["red_at"], green_at=label(day, m[1], m[2]),
                                 minutes=round((at - open_["t"]) / 60)))
            open_ = None
    mins = [e["minutes"] for e in episodes]
    # A change failure is a landing that broke main: a culprit lane, or a red episode with none named.
    failures = max(len(episodes) + (open_ is not None), len(culprits))
    return dict(tested=tested, episodes=episodes, still_red=open_ is not None, culprits=sorted(culprits), failures=failures,
                change_failure_pct=round(100 * failures / tested, 1) if tested else None,
                restore_median_min=statistics.median(mins) if mins else None, restore_max_min=max(mins, default=None))


def reverts_landed(text):
    """Lanes named fable-revert-* in the landloop log's landed lists."""
    out = []
    for m in re.finditer(r'"landed": \[([^\]]*)\]', text):
        out += [x for x in re.findall(r'"([^"]+)"', m[1]) if x.startswith("fable-revert-")]
    return out


def largest(paths_lines, limit=2000):
    """(top 5 [(path, lines)], count over limit) for source files that are not tests, fixtures or i18n catalogues."""
    src = sorted(((p, n) for p, n in paths_lines if SOURCE.search(p) and not NOT_SOURCE.search(p)), key=lambda x: -x[1])
    return src[:5], sum(n > limit for _, n in src)


def shared_files(lanes):
    """{path: [lane, ...]} for the paths two or more lanes change."""
    by = {}
    for lane, files in lanes.items():
        for f in files:
            by.setdefault(f, []).append(lane)
    return {f: sorted(ls) for f, ls in sorted(by.items()) if len(ls) > 1}


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True).stdout


def open_lanes():
    """{branch: changed files} for local branches with a commit today that origin/main does not contain."""
    today = time.strftime("%Y-%m-%d")
    out = {}
    for line in git("for-each-ref", "refs/heads", "--format=%(refname:short) %(committerdate:short)").splitlines():
        name, day = line.rsplit(" ", 1)
        if day != today or not git("rev-list", "-1", f"origin/main..{name}").strip():
            continue
        base = git("merge-base", "origin/main", name).strip()
        out[name] = [f for f in git("diff", "--name-only", base, name).splitlines() if f]
    return out


MARK = ".scorecard-owned"


def own_folder(path):
    """A folder this script may empty: a new path (made here, with a marker file), or one holding the marker from an
    earlier run of this script. Refused: a link, /, a home, any folder above a home or above this checkout, the owner's
    Nunchiro home or anything in it, any git checkout, this checkout and its target. Returns the empty folder."""
    raw = Path(path).expanduser()
    p = raw.resolve()
    home, root = Path.home().resolve(), ROOT.resolve()
    why = ("is a link" if raw.is_symlink() else
           "is / or a top folder" if len(p.parts) < 3 else
           "is a home or above one" if home.is_relative_to(p) else
           "is this checkout or above it" if root.is_relative_to(p) else
           "is this checkout's target" if p == root / "target" else
           "is in the owner's Nunchiro home" if p.is_relative_to(OWNER_HOME.resolve()) else
           "is a git checkout" if (p / ".git").exists() else None)
    if why:
        raise SystemExit(f"refused: {p} {why}")
    if p.exists():
        if not (p / MARK).is_file():
            raise SystemExit(f"refused: {p} exists and was not made by scorecard.py (no {MARK} in it)")
        shutil.rmtree(p)
    p.mkdir(parents=True)
    (p / MARK).write_text("Made by scripts/measure/scorecard.py, which may empty this folder on its next run.\n")
    return p


def outside_holder(cmd, env, timeout=3600):
    """(seconds, exit code, output) of cmd run with launchd as its parent: a double fork, so no Nunchiro holder is
    above it (crates/nunchiro-core/src/peer.rs under_holder walks the parents; 29 holder tests fail inside a session).
    The run is bounded by timeout (exit 124); the waiting side polls its result file."""
    box = Path(tempfile.mkdtemp(prefix="ns-detach-"))
    t0 = time.monotonic()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            if os.fork():
                os._exit(0)
            with open(box / "out", "wb") as f:
                try:
                    rc = subprocess.run(cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT,
                                        timeout=timeout).returncode
                except subprocess.TimeoutExpired:
                    rc = 124
            (box / "rc.tmp").write_text(str(rc))
            os.replace(box / "rc.tmp", box / "rc")
        finally:
            os._exit(0)
    os.waitpid(pid, 0)
    while not (box / "rc").exists():
        if time.monotonic() - t0 > timeout + 120:
            raise SystemExit(f"the detached run gave no result in {timeout + 120} s; its output is in {box}")
        time.sleep(2)
    out = (box / "out").read_text(errors="replace")
    rc = int((box / "rc").read_text())
    shutil.rmtree(box, ignore_errors=True)
    return round(time.monotonic() - t0, 1), rc, out


# Ticket 1130 C9 (MD2 evidence): one setup-free command in a fresh worktree; a small targeted test, cold build included.
MD2_CMD = ["sh", "scripts/test.sh", "cargo", "test", "-p", "nunchiro", "--test", "version"]


def fresh_worktree_test(env, target, root=ROOT, cmd=MD2_CMD):
    """MD2: seconds from `git worktree add` of HEAD to the end of cmd run in it (its own empty CARGO_TARGET_DIR), and
    cmd's exit code. The worktree is removed after."""
    wt = Path(tempfile.mkdtemp(prefix="ns-md2-")) / "wt"
    shutil.rmtree(target, ignore_errors=True)
    t0 = time.monotonic()
    try:
        # A failed worktree add is recorded like a failed cmd, so the other dev figures are kept.
        p = subprocess.run(["git", "worktree", "add", "--detach", "-q", str(wt), "HEAD"], cwd=root, capture_output=True, text=True)
        if p.returncode == 0:
            p = subprocess.run(cmd, cwd=wt, env=dict(env, CARGO_TARGET_DIR=str(target)), capture_output=True, text=True)
        secs = round(time.monotonic() - t0, 1)
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(wt)], cwd=root, capture_output=True)
        shutil.rmtree(wt.parent, ignore_errors=True)
    return dict(seconds=secs, exit=p.returncode, steps=1, copy=False, command=" ".join(cmd), tail=(p.stdout + p.stderr)[-300:] if p.returncode else "")


def timed(cmd, env, cwd=ROOT):
    t0 = time.monotonic()
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    return round(time.monotonic() - t0, 1), p


def dev_cmd(a):
    from lib import clean_env
    env = {k: v for k, v in clean_env().items() if not k.startswith("NUNCHIRO_")}
    target = own_folder(a.target)
    env.update(CARGO_TARGET_DIR=str(target))
    load0 = round(os.getloadavg()[0], 2)
    cold, p = timed(["cargo", "build", "--workspace"], env)
    if p.returncode:
        raise SystemExit(f"cold build failed: {p.stderr[-800:]}")
    # A warm rebuild after a one-file change in the core crate (the file most lanes touch is in it).
    touched = ROOT / "crates/nunchiro-core/src/lib.rs"
    os.utime(touched)
    warm, p = timed(["cargo", "build", "--workspace"], env)
    web, pw = timed(["pnpm", "--filter", "nunchiro-web", "build"], env)
    md2 = fresh_worktree_test(env, target / "md2")
    tests, test_rc, test_out = outside_holder(["sh", "scripts/cargo-test-gate.sh"], env)
    summary = next((l for l in reversed(test_out.splitlines()) if "Summary" in l or "test result" in l), "")
    files = [(p, int(n)) for n, p in (l.split(None, 1) for l in subprocess.run(
        "git ls-files -z | xargs -0 wc -l", shell=True, cwd=ROOT, capture_output=True, text=True).stdout.splitlines()
        if l.strip() and not l.strip().endswith(" total"))]
    top, over = largest(files)
    lanes = open_lanes()
    shared = shared_files(lanes)
    out = dict(date=time.strftime("%Y-%m-%d %H:%M"), commit=git("rev-parse", "--short", "HEAD").strip(), load=[load0, round(os.getloadavg()[0], 2)],
               figures=dict(build_cold_min=round(cold / 60, 2), build_warm_s=warm, web_build_s=web if pw.returncode == 0 else None,
                            test_stage_min=round(tests / 60, 2), largest_file_lines=top[0][1] if top else None,
                            files_over_2000=over, shared_files_open_lanes=len(shared)),
               test_stage=dict(exit=test_rc, summary=summary.strip(), run="detached: launchd is its parent, no Nunchiro holder above it"), largest_files=top, open_lanes={k: len(v) for k, v in lanes.items()},
               shared=shared, warm_touch=str(touched.relative_to(ROOT)), md2=md2)
    path = Path(a.out) if a.out else OUT_DIR / f"dev-{time.strftime('%Y-%m-%d')}.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out["figures"]), out["test_stage"], f"wrote {path}")


def ops_cmd(a):
    out = dict(date=time.strftime("%Y-%m-%d %H:%M"), commit=git("rev-parse", "--short", "origin/main").strip())
    mw = MAINWATCH.read_text() if MAINWATCH.is_file() else ""
    import datetime
    ll = LANDLOOP.read_text() if LANDLOOP.is_file() else ""
    first = re.search(r'"ts": "(\d{4}-\d\d-\d\d)T', ll)  # the landloop and mainwatch logs start in the same minute
    deploy = parse_deploys(mw, datetime.date.fromisoformat(first[1]) if first else None)
    deploy["reverts_landed"] = reverts_landed(ll) if ll else None
    deploy["revert_holds"] = len(re.findall(r"HOLD: [0-9a-f]{40}: the revert of", mw))
    deploy["reverts_queued"] = len(re.findall(r"revert lane \S+ queued for", mw))
    out["deploy"] = deploy
    have = lambda *cmd: subprocess.run(list(cmd), capture_output=True).returncode == 0  # noqa: E731
    sup = dict(tools={"cargo audit": have("cargo", "audit", "--version"), "cargo outdated": have("cargo", "outdated", "--version"),
                      "cargo deny": have("cargo", "deny", "--version")},
               not_run="pnpm audit and pnpm outdated send the package list to the npm registry; cargo audit needs the RustSec database from the network: not run (offline-safe rule)",
               lockfiles=[f for f in ("Cargo.lock", "app/src-tauri/Cargo.lock", "pnpm-lock.yaml") if git("ls-files", f).strip()],
               sbom_files=[f for f in git("ls-files").splitlines() if re.search(r"sbom|cyclonedx|spdx", f, re.I)],
               dependabot=bool(git("ls-files", ".github/dependabot.yml", "renovate.json").strip()))
    meta = subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked", "--offline"], cwd=ROOT, capture_output=True, text=True)
    if meta.returncode == 0:
        pk = json.loads(meta.stdout)["packages"]
        names = {}
        for p in pk:
            names.setdefault(p["name"], set()).add(p["version"])
        sup.update(rust_packages=len(pk), rust_duplicate_names=sum(len(v) > 1 for v in names.values()))
    lock = (ROOT / "pnpm-lock.yaml").read_text()
    sup["npm_packages"] = len(re.findall(r"^  '?[@a-z0-9][^:\n]*@[0-9][^:\n]*'?:\s*$", lock.split("\nsnapshots:")[0], re.M))
    if a.clones:
        sup["clean_clone"] = clean_clone_build(Path(a.clones))
    out["supply"] = sup
    path = Path(a.out) if a.out else OUT_DIR / f"ops-{time.strftime('%Y-%m-%d')}.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(dict(deploy={k: v for k, v in deploy.items() if k != "episodes"}, clean=sup.get("clean_clone"))), f"wrote {path}")


def clean_clone_build(base):
    """Two clones of origin/main through scripts/update-clone.sh (taken from origin/main when this checkout lacks it),
    from a local bare copy (no network, no keychain), each built with cargo --release --locked --offline -p nunchiro
    in its own target; the two binaries' sha256 are compared."""
    import hashlib
    base = own_folder(base)
    script = ROOT / "scripts/update-clone.sh"
    if not script.is_file():
        script = base / "update-clone.sh"
        script.write_text(git("show", "origin/main:scripts/update-clone.sh"))
    bare = base / "main.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    subprocess.run(["git", "-C", str(ROOT), "push", "-q", str(bare), "origin/main:refs/heads/main"], check=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("NUNCHIRO_")}
    res = {}
    for side in ("a", "b"):
        d = base / side
        c = subprocess.run(["sh", str(script), str(d)], env=dict(env, NUNCHIRO_UPDATE_REPO=str(bare)), capture_output=True, text=True)
        if c.returncode:
            return dict(error=f"update-clone.sh: {c.stderr.strip()[-300:]}")
        secs, p = timed(["cargo", "build", "--release", "--locked", "--offline", "-p", "nunchiro"], dict(env, CARGO_TARGET_DIR=str(d / "target")), cwd=d)
        if p.returncode:
            return dict(error=f"build {side}: {p.stderr.strip()[-400:]}")
        res[side] = dict(commit=c.stdout.strip()[:9], build_min=round(secs / 60, 2),
                         sha256=hashlib.sha256((d / "target/release/nunchiro").read_bytes()).hexdigest())
    res["same_binary"] = res["a"]["sha256"] == res["b"]["sha256"]
    return res


def merge(runs):
    """Several runs as one: values joined per figure, counts summed, the owner check failing if any run's did."""
    first = runs[0]
    out = dict(first, date=" / ".join(r["date"] for r in runs), repeats=sum(r["repeats"] for r in runs),
               load=[min(r["load"][0] for r in runs), max(r["load"][1] for r in runs)],
               figures={k: dict(stats([v for r in runs for v in r["figures"][k]["values"]]),
                                run_medians=[m for r in runs for m in r["figures"][k].get("run_medians", [r["figures"][k]["median"]])])
                        for k in first["figures"]},
               repeat_loads=[x for r in runs for x in r.get("repeat_loads", [])],
               run_loads=[r["load"] for r in runs],
               installs={k: sum(r["installs"][k] for r in runs) for k in ("ok", "of")},
               launches={k: sum(r["launches"][k] for r in runs) for k in ("drawn", "of")},
               sessions_alive_pct=stats([v for r in runs for v in r["sessions_alive_pct"]["values"]]),
               owner_check=dict(same=all(r["owner_check"]["same"] for r in runs),
                                owner_files_open_by_our_processes=[h for r in runs for h in r["owner_check"]["owner_files_open_by_our_processes"]],
                                owner_core=sorted({p for r in runs for p in r["owner_check"]["owner_core_before"] or []})),
               runs=len(runs))
    return out


def score_numbers(figs):
    """{part: (score, [(figure, value, points)])} for the number parts; a missing figure scores 0 (never skipped)."""
    out = {}
    for part, names in NUMBER_PARTS.items():
        rows = [(n, figs.get(n), points(figs.get(n), *ANCHORS[n])) for n in names]
        out[part] = (round(sum(p for _, _, p in rows) / len(rows)), rows)
    return out


def combine(number_rows, checks):
    """Number + rubric parts: each figure and each check is one item (rubric.md)."""
    items = [p for _, _, p in number_rows] + [{"pass": 100, "partial": 50, "fail": 0}[c["verdict"]] for c in checks]
    return round(sum(items) / len(items)) if items else 0


def peer_scores(tasks, apps):
    """tasks: {task: {app: {"result", "steps"}}}. Per task: 100 x fewest steps / app steps, partial halves, no = 0,
    unknown (the feature is documented but its steps were not found) = None, left out of the means and of the best.
    Returns {app: {task: score}}."""
    out = {a: {} for a in apps}
    for t, by in tasks.items():
        done = [c["steps"] for c in by.values() if c.get("result") in ("yes", "partial") and c.get("steps")]
        best = min(done) if done else None
        for a in apps:
            c = by.get(a) or {}
            if c.get("result") == "unknown":
                out[a][t] = None
            elif c.get("result") not in ("yes", "partial") or not c.get("steps") or best is None:
                out[a][t] = 0
            else:
                out[a][t] = round(100 * best / c["steps"] * (0.5 if c["result"] == "partial" else 1))
    return out


# ---------------------------------------------------------------- run (needs the RC build and macOS)

def owner_core_pid():
    sock = OWNER_HOME / "core.sock"
    if not sock.exists():
        return None
    out = subprocess.run(["lsof", "-t", str(sock)], capture_output=True, text=True).stdout.split()
    return sorted(set(out))


def touches_owner(pids):
    """Files under the owner's folders (OWNER_DIRS) that any of the pids has open at this moment (expected empty)."""
    roots = tuple(f"{d}/" for d in OWNER_DIRS)
    hits = []
    for pid in sorted(set(pids)):
        out = subprocess.run(["lsof", "-Fn", "-p", str(pid)], capture_output=True, text=True).stdout
        hits += [f"{pid}:{l[1:]}" for l in out.splitlines() if l.startswith("n") and l[1:].startswith(roots)]
    return hits


def home_of(pid):
    """The HOME in a process's environment (ps eww shows it for the user's own processes), or None."""
    out = subprocess.run(["ps", "eww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"(?:^| )HOME=(\S+)", out)
    return m[1] if m else None


def must_home(pids, home, seen):
    """Fails the run when a process we started does not carry the fresh HOME; counts the ones that do."""
    for pid in pids:
        h = home_of(pid)
        if h != str(home):
            raise SystemExit(f"refused: process {pid} has HOME={h}, not the run's own {home}")
        seen.append(pid)


def our_pids(app_pid, core_pid):
    """The window, its WebKit and other helpers (by responsible pid), the core and everything under it (holders,
    sessions)."""
    import release as rel
    from lib import descendants
    pids = [app_pid] + rel.helpers(app_pid, set())[0]
    if core_pid:
        pids += [core_pid] + list(descendants(core_pid))
    return pids


def fresh(prefix):
    d = Path(tempfile.mkdtemp(prefix=prefix)).resolve()
    if d.is_relative_to(OWNER_HOME.resolve()):
        raise SystemExit(f"refused: {d} is inside the owner's home")
    return d


def run_cmd(a):
    import baseline as bl
    import release as rel
    import startup as su
    import measurelib as ml
    from lib import clean_env

    app = su.BUILD / su.NAME if a.no_build else su.build()
    cli = app / "Contents/MacOS/nunchiro"
    if not cli.is_file():
        raise SystemExit(f"no build at {app}; run without --no-build")
    owner_before = owner_core_pid()
    base_env = {k: v for k, v in clean_env().items() if not k.startswith("NUNCHIRO_")}
    figs = {k: [] for k in ("launch_cold_s", "launch_warm_s", "core_start_s", "send_ms", "idle_cpu_pct", "idle_mib",
                            "mib_per_session", "sessions_json_kib_per_session", "snapshot_kib_per_session", "cpu_pct_sessions",
                            "mib_sessions")}
    installs, drawn, launches, alive, touched, loads, checked, homes_ok = 0, 0, 0, [], [], [], [], []
    SHOTS.mkdir(parents=True, exist_ok=True)
    for r in range(a.repeats):
        loads.append(rel.load())
        # 1. install: copy the bundle into a fresh throwaway folder, check it is whole, start it cold, wait for DRAWN.
        inst = fresh("ns-inst-")
        home, nhome = fresh("ns-sh-"), fresh("ns-sn-")
        ok = subprocess.run(["ditto", str(app), str(inst / su.NAME)]).returncode == 0
        ok = ok and subprocess.run([str(inst / su.NAME / "Contents/MacOS/nunchiro"), "--version"], capture_output=True,
                                   env=dict(base_env, HOME=str(home), NUNCHIRO_HOME=str(nhome))).returncode == 0
        own = ml.OwnApp(inst / su.NAME)
        own_cli = own.exe.parent / "nunchiro"
        env = dict(base_env, HOME=str(home), NUNCHIRO_HOME=str(nhome), NUNCHIRO_BIN=str(own_cli), NUNCHIRO_GATE_RUN="1",
                   NUNCHIRO_KEYCHAIN="")
        log = open(nhome.parent / f"{nhome.name}-app.log", "ab")
        try:
            for kind in ("launch_cold_s", "launch_warm_s"):
                run = su.Run(own.exe, env, log)
                s = run.wait()
                launches += 1
                drawn += s is not None
                figs[kind].append(s)
                if s is not None and r == 0 and kind == "launch_warm_s":
                    time.sleep(3)
                    shot(nhome, "nunchiro-launch")
                try:
                    core = su.core_pid(nhome)
                except RuntimeError:
                    core = None
                must_home([p for p in (run.proc.pid, core) if p], home, homes_ok)
                checked.append(len(set(our_pids(run.proc.pid, core))))
                touched += touches_owner(our_pids(run.proc.pid, core))
                run.stop(env, own_cli, nhome)
            installs += ok and figs["launch_cold_s"][-1] is not None
        finally:
            own.remove()
            shutil.rmtree(inst, ignore_errors=True)
        print(f"repeat {r + 1}: install {'ok' if ok else 'FAILED'}, cold {figs['launch_cold_s'][-1]} s, warm {figs['launch_warm_s'][-1]} s", flush=True)

        # 2. core start, window, sessions, growth, latency on one fresh home (release.Nunchiro, own bundle id).
        rel.CORE, rel.APP = cli, app
        # release.Nunchiro gives the core and window a fresh NUNCHIRO_HOME but the real HOME; this run gives them a
        # fresh HOME too, so neither reads the owner's agent settings (~/.claude, ~/.codex).
        home2 = fresh("ns-sh-")
        rel.clean_env = lambda extra=None: clean_env(dict(extra or {}, HOME=str(home2)))
        t0 = time.monotonic()
        try:
            arm = rel.Nunchiro()
        finally:
            rel.clean_env = clean_env
        figs["core_start_s"].append(round(time.monotonic() - t0, 3))
        try:
            sj = arm.home / "sessions.json"
            snap0 = len(json.dumps(arm.call({"op": "snapshot"})))
            sj0 = sj.stat().st_size if sj.exists() else 0
            # A normal launch (it takes the front once): a gate run shoots its page every second, which inflated the
            # window's idle CPU to 5.26 % in ticket 549 and to 50 % in this script's first try.
            arm.open()
            time.sleep(a.settle)  # loads, connects, draws, settles
            rec = []
            m0 = rel.sample(arm, "idle0", True, rec)
            pids = lambda: [arm.core.pid, arm.app.pid] + arm.parts(True)[1]  # noqa: E731
            c0, t1 = bl.cputime(pids()), time.monotonic()
            time.sleep(a.idle_secs)
            figs["idle_cpu_pct"].append(round((bl.cputime(pids()) - c0) / (time.monotonic() - t1) * 100, 2))
            figs["idle_mib"].append(m0["app_mib"])
            sids = [arm.cli("session", "start", "--kind", "shell", "--project", str(arm.home), "--label", f"s{i}", "--",
                            "/bin/cat")["session"]["id"] for i in range(a.sessions)]
            time.sleep(a.settle)
            m1 = rel.sample(arm, "idleN", True, rec)
            c0, t1 = bl.cputime(pids()), time.monotonic()
            time.sleep(a.idle_secs)
            figs["cpu_pct_sessions"].append(round((bl.cputime(pids()) - c0) / (time.monotonic() - t1) * 100, 2))
            figs["mib_sessions"].append(m1["app_mib"])
            figs["mib_per_session"].append(round((m1["app_mib"] - m0["app_mib"]) / a.sessions, 2))
            snap1 = len(json.dumps(arm.call({"op": "snapshot"})))
            figs["snapshot_kib_per_session"].append(round((snap1 - snap0) / a.sessions / 1024, 2))
            figs["sessions_json_kib_per_session"].append(round(((sj.stat().st_size if sj.exists() else 0) - sj0) / a.sessions / 1024, 2))
            live = {s["id"] for s in arm.call({"op": "snapshot"})["sessions"]}
            alive.append(round(100 * len(set(sids) & live) / len(sids), 1))
            figs["send_ms"].append(send_latency(arm, a.sends))
            must_home([arm.core.pid, arm.app.pid], home2, homes_ok)
            checked.append(len(set(our_pids(arm.app.pid, arm.core.pid))))
            touched += touches_owner(our_pids(arm.app.pid, arm.core.pid))
            if r == 0:  # one picture of the window with the sessions: a gate run draws its page to gate-shot.png
                arm.close()
                arm.env["NUNCHIRO_GATE_RUN"] = "1"
                arm.open()
                time.sleep(a.settle)
                shot(arm.home, f"nunchiro-{a.sessions}-sessions")
        finally:
            arm.stop()
            shutil.rmtree(home2, ignore_errors=True)
        print(f"repeat {r + 1}: core {figs['core_start_s'][-1]} s, idle {figs['idle_mib'][-1]} MiB {figs['idle_cpu_pct'][-1]} %, "
              f"{a.sessions} sessions {figs['mib_sessions'][-1]} MiB, send {figs['send_ms'][-1]} ms", flush=True)
    loads.append(rel.load())
    owner_after = owner_core_pid()
    mw = parse_mainwatch(MAINWATCH.read_text()) if MAINWATCH.is_file() else None
    out = dict(
        date=time.strftime("%Y-%m-%d %H:%M"), commit=rel.versions()["commit"], host=rel.versions()["host"],
        macos=rel.versions()["macos"], repeats=a.repeats, sessions=a.sessions, load=ml.load_range(loads),
        figures={k: stats(v) for k, v in figs.items()},
        installs=dict(ok=installs, of=a.repeats), launches=dict(drawn=drawn, of=launches), sessions_alive_pct=stats(alive),
        mainwatch=mw, locale=locale_coverage(),
        repeat_loads=loads[:-1],
        owner_check=dict(owner_core_before=owner_before, owner_core_after=owner_after, same=owner_before == owner_after,
                         owner_files_open_by_our_processes=touched, dirs_checked=[d.name for d in OWNER_DIRS],
                         processes_checked_per_sample=checked, home_verified_processes=len(homes_ok), home="fresh temp HOME and NUNCHIRO_HOME for every process started"),
    )
    path = Path(a.out) if a.out else OUT_DIR / f"results-{time.strftime('%Y-%m-%d')}.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}")
    if touched or owner_before != owner_after:
        raise SystemExit(f"owner check FAILED: {out['owner_check']}")


def shot(home, name):
    """The gate run's own page picture, kept as a 1200 px JPEG (a PNG of the full window is about 0.5 MB)."""
    if (home / "gate-shot.png").is_file():
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", "1200", str(home / "gate-shot.png"), "--out", str(SHOTS / f"{name}.jpg")],
                       capture_output=True, check=True)


def send_latency(arm, n):
    """Median ms from just before `nunchiro session send-text` to the bytes read in the session's PTY (echo_target.py
    stamps each read with time.monotonic_ns, the same system clock as here)."""
    log = arm.home / "echo.log"
    sid = arm.start_echo(log)
    until = time.monotonic() + 20
    while "ECHO_READY" not in arm.screen(sid) and time.monotonic() < until:
        time.sleep(0.2)
    lat = []
    for i in range(n):
        token = f"q{i:03d}z"
        t = time.monotonic_ns()
        arm.cli("session", "send-text", sid, token)
        hexed, end = token.encode().hex(), time.monotonic() + 5
        while time.monotonic() < end:
            hit = next((l for l in log.read_text().splitlines() if hexed in l), None) if log.exists() else None
            if hit:
                lat.append((int(hit.split()[0]) - t) / 1e6)
                break
            time.sleep(0.005)
    return round(statistics.median(lat), 1) if len(lat) == n else None


def locale_coverage():
    """Per language: share of the English keys it has, over web/src/i18n/areas (node strips the TypeScript types)."""
    js = ("import {readdirSync} from 'node:fs'; const d=process.argv[1]; const en={}, l={};"
          "for (const f of readdirSync(d).filter(n=>n.endsWith('.ts'))) { const m=await import(d+'/'+f);"
          "Object.assign(en, m.en||{}); for (const [k0,v] of Object.entries(m)) { const k=k0.replace(/^zhHan([st])$/,'zh-Han$1'); if (k!=='en') Object.assign(l[k] ??= {}, v); } }"
          "console.log(JSON.stringify({en:Object.keys(en).length, langs:Object.fromEntries(Object.entries(l).map(([k,v])=>[k,Object.keys(v).filter(x=>x in en).length]))}))")
    p = subprocess.run(["node", "--input-type=module", "-e", js, str(ROOT / "web/src/i18n/areas")], capture_output=True, text=True)
    if p.returncode:
        return dict(error=p.stderr.strip()[-300:])
    d = json.loads(p.stdout)
    per = {k: round(100 * d["langs"].get(k, 0) / d["en"], 1) for k in LANGS}
    return dict(english_keys=d["en"], per_language_pct=per, mean_pct=round(statistics.mean(per.values()), 1))


# ---------------------------------------------------------------- page

def flat(res, dev=None):
    """The figure values the anchors read, from one results file (and the newest dev file, for p26)."""
    f = {k: v["median"] for k, v in res["figures"].items()}
    f.update((dev or {}).get("figures", {}))
    mw = res.get("mainwatch") or {}
    f.update(installs_ok_pct=round(100 * res["installs"]["ok"] / res["installs"]["of"], 1), owner_installs_landed_pct=(mw.get("installs") or {}).get("landed_pct"),
             gate_green_pct=mw.get("green_pct"), gate_median_min=mw.get("median_min"),
             launches_drawn_pct=round(100 * res["launches"]["drawn"] / res["launches"]["of"], 1) if res["launches"]["of"] else None,
             sessions_alive_pct=res["sessions_alive_pct"]["median"], locale_coverage_pct=(res.get("locale") or {}).get("mean_pct"))
    return f


def page_cmd(a):
    results = Path(a.results) if a.results else max(OUT_DIR.glob("results-*.json"))
    res = json.loads(results.read_text())
    parts = json.loads((OUT_DIR / "parts.json").read_text())
    tasks = json.loads((OUT_DIR / "tasks.json").read_text())
    devs = sorted(OUT_DIR.glob("dev-*.json"))
    dev = json.loads(devs[-1].read_text()) if devs else None
    opss = sorted(OUT_DIR.glob("ops-*.json"))
    if opss:  # p27 figures ride with the dev figures into flat()
        ops = json.loads(opss[-1].read_text())
        dev = dict(dev or {}, ops=ops)
        dev.setdefault("figures", {})
        dev["figures"] = dict(dev["figures"], change_failure_pct=ops["deploy"]["change_failure_pct"],
                              restore_median_min=ops["deploy"]["restore_median_min"])
    (OUT_DIR / "scorecard.html").write_text(render(res, parts, tasks, results.name, dev))
    print(f"wrote {OUT_DIR.relative_to(ROOT)}/scorecard.html from {results.name}")


def render(res, parts, tasks, results_name, dev=None):
    e = html.escape
    figs = flat(res, dev)
    nums = score_numbers(figs)
    apps = tasks["apps"]
    peer = peer_scores(tasks["tasks"], apps)
    rows = []
    for p in parts["parts"]:
        pid, method = p["id"], p["method"]
        checks = p.get("checks", [])
        ev = []
        if pid in nums:
            ev += [f"{n} = {v} ({pt} pts)" for n, v, pt in nums[pid][1]]
        if method == "peer-tasks":
            sc = mean_known(peer["Nunchiro"][t] for t in p["tasks"])
            best = max(apps, key=lambda x: mean_known(peer[x][t] for t in p["tasks"]))
            ev.append(f"tasks {', '.join(p['tasks'])}: Nunchiro {sc}; best {best} {mean_known(peer[best][t] for t in p['tasks'])}")
            for t in p["tasks"]:
                c = tasks["tasks"][t]["Nunchiro"]
                top = max(apps, key=lambda x: peer[x][t] or 0)
                ev.append(f"{t} {tasks['names'][t]}: Nunchiro {peer['Nunchiro'][t]} ({c.get('result')}, {c.get('steps')} steps: "
                          f"{c.get('path')}; {c.get('evidence')}); best {top}, {tasks['tasks'][t][top].get('steps')} steps")
        elif method == "peer-rows":
            sc = p["score"]
        elif pid in nums and checks:
            sc = combine(nums[pid][1], checks)
        elif pid in nums:
            sc = nums[pid][0]
        else:
            sc = round(sum({"pass": 20, "partial": 10, "fail": 0}[c["verdict"]] for c in checks) * 5 / len(checks))
        ev += [f"{c['id']} {c['verdict']}: {c['evidence']}" for c in checks]
        ev += p.get("evidence", [])
        rows.append((pid, p["name"], sc, p["label"], ev, p.get("was")))
    avg = round(statistics.mean(r[2] for r in rows), 1)
    devsec = ""
    ops = (dev or {}).get("ops")
    if ops:
        d, sp = ops["deploy"], ops["supply"]
        devsec += (f"<h2>Deploy stability and supply chain (scorecard.py ops, {e(ops['date'])}, origin/main {e(ops['commit'])})</h2><ul>"
                   f"<li>Tested main tips: {d['tested']}; landings that broke main (culprit lanes): {d['failures']}; red episodes: {len(d['episodes'])}{' (main is red now)' if d['still_red'] else ''}; "
                   f"change failure rate {d['change_failure_pct']} %; minutes red: median {d['restore_median_min']}, max {d['restore_max_min']}</li>"
                   + "".join(f"<li>{e(x['sha'])}: red {e(x['red_at'])}, green {e(x['green_at'])}, {x['minutes']} min</li>" for x in d["episodes"])
                   + f"<li>Reverts landed: {e(', '.join(d['reverts_landed'] or []))}; reverts queued by mainwatch: {d['reverts_queued']}; held: {d['revert_holds']}</li>"
                   f"<li>Supply: {e(json.dumps({k: v for k, v in sp.items() if k != 'not_run'}))}</li><li>{e(sp['not_run'])}</li></ul>")
    if dev and dev.get("date"):
        devsec += (f"<h2>Maintainability details (scorecard.py dev, {e(dev['date'])}, commit {e(dev['commit'])}, load {dev['load'][0]}-{dev['load'][1]})</h2><ul>"
                  f"<li>Rust test stage: exit {dev['test_stage']['exit']}, {e(dev['test_stage']['summary'])}</li>"
                  f"<li>Largest source files: {e(', '.join(f'{p} {n}' for p, n in dev['largest_files']))}</li>"
                  f"<li>Open lanes today (changed files): {e(', '.join(f'{k} {v}' for k, v in dev['open_lanes'].items()))}</li>"
                  + "".join(f"<li>{e(f)}: {e(', '.join(ls))}</li>" for f, ls in dev["shared"].items()) + "</ul>")
    trs = "".join(
        f"<tr><td>{e(n)}</td><td class=s>{s}</td><td class=b><div class=bar style='width:{s}%'></div></td><td>{e(m)}</td>"
        f"<td class=s>{'' if w is None else w}</td><td><details><summary>{len(ev)} items</summary><ul>"
        + "".join(f"<li>{e(x)}</li>" for x in ev) + "</ul></details></td></tr>"
        for _, n, s, m, ev, w in sorted(rows, key=lambda r: r[2]))
    head = "".join(f"<th>{e(x)}</th>" for x in apps)
    trows = ""
    for t, by in tasks["tasks"].items():
        cells = ""
        for x in apps:
            c = by.get(x) or {}
            shot = "".join(f" <a href='shots/{e(s)}'>shot</a>" for s in c.get("shots", []))
            steps = c.get("steps")
            tf = (tasks.get("timed") or {}).get(x, {}).get(t)  # a figure of this run, e.g. the cold launch for T1
            fv = res["figures"].get(tf) if tf else None
            timed = (f"<br><i>timed: {e(tf)} {fv['median']} s (repeats {fv['min']}-{fv['max']}; run medians "
                     f"{', '.join(map(str, fv.get('run_medians', [fv['median']])))})</i>") if fv else ""
            cells += (f"<td class=c title='{e(c.get('path', ''))} | {e(c.get('evidence', ''))}'><b>{'?' if peer[x][t] is None else peer[x][t]}</b><br>"
                      f"{e(c.get('result', '?'))}{'' if steps is None else f', {steps} step' + ('' if steps == 1 else 's')}{timed}"
                      f"{('<br><span class=n>' + e(c['stuck']) + '</span>') if c.get('stuck') else ''}{shot}</td>")
        trows += f"<tr><td><b>{e(t)}</b> {e(tasks['names'][t])}</td>{cells}</tr>"
    means = "".join(f"<td class=c><b>{mean_known(peer[x].values())}</b></td>" for x in apps)
    f = res["figures"]
    def runs_cell(v):
        rm = [m for m in v.get("run_medians", []) if m is not None]
        return f"{', '.join(map(str, rm))} (spread {round(max(rm) - min(rm), 3)})" if len(rm) > 1 else "one run"
    numtab = "".join(f"<tr><td>{e(k)}</td><td class=s>{v['median']}</td><td class=s>{v['min']} - {v['max']}</td>"
                     f"<td class=s>{runs_cell(v)}</td><td class=s>{v['n']}</td></tr>" for k, v in f.items())
    shots = "".join(f"<figure><img src='shots/{e(s)}' alt='{e(c)}'><figcaption>{e(c)}</figcaption></figure>" for s, c in tasks.get("gallery", []))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nunchiro scorecard (measured)</title>
<style>body{{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:16px;color:#1d1d1f;background:#fff}}
@media(prefers-color-scheme:dark){{body{{background:#1c1c1e;color:#f2f2f7}}td,th{{border-color:#3a3a3c!important}}}}
h1{{font-size:18px;margin:0 0 4px}}h2{{font-size:15px;margin:22px 0 6px}}.n{{color:#8e8e93;font-size:12px}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #e5e5ea;padding:5px 7px;text-align:left;vertical-align:top}}
td.s{{text-align:center;font-variant-numeric:tabular-nums}}td.c{{text-align:center;font-size:12px}}td.b{{width:22%}}
.bar{{height:8px;border-radius:4px;background:#0a84ff}}ul{{margin:4px 0;padding-left:18px;font-size:12px}}
figure{{display:inline-block;margin:6px;width:300px;vertical-align:top}}img{{width:100%;border:1px solid #8e8e93}}figcaption{{font-size:12px}}</style></head><body>
<h1>Nunchiro scorecard</h1><div class=n>Measured {e(res['date'])} on commit {e(res['commit'])} ({e(res['host'])}, macOS {e(res['macos'])}, 1-min load {res['load'][0]}-{res['load'][1]}),
{res['repeats']} repeats{f" over {res['runs']} runs" if res.get('runs') else ''}; figures from {e(results_name)}. Each part 0-100 on its own. Method and checks: rubric.md; tasks: tasks.md.
"was" = the lead's estimate of 2026-11-24 (before measuring).</div>
<h2>All {len(rows)} parts, average {avg}</h2><table><tr><th>Part</th><th>Score</th><th></th><th>Method</th><th>was</th><th>Evidence</th></tr>{trs}</table>
<h2>Limits of this scorecard</h2><ul>{"".join(f"<li>{e(x)}</li>" for x in parts.get("limits", []))}</ul>
<h2>Peer tasks (100 = the best app on that task)</h2>
<div class=n>{e(tasks['note'])}</div>
<table><tr><th>Task</th>{head}</tr>{trows}<tr><td><b>Mean</b></td>{means}</tr></table>
<h2>Shots</h2>{shots}
{devsec}
<h2>Measured figures (median and range over all repeats; each run's median and the run-to-run spread)</h2>
<table><tr><th>Figure</th><th>Median</th><th>Range (all repeats)</th><th>Run medians (run-to-run spread)</th><th>n</th></tr>{numtab}</table>
<div class=n>1-min load per run: {e(json.dumps(res.get('run_loads') or [res['load']]))}</div>
<div class=n>Gate (mainwatch, last {(res.get('mainwatch') or {}).get('runs')} runs): {e(json.dumps(res.get('mainwatch'), ensure_ascii=False))}<br>
Locale: {e(json.dumps(res.get('locale'), ensure_ascii=False))}<br>Owner check: {e(json.dumps(res['owner_check']))}</div>
</body></html>
"""


def merge_cmd(a):
    out = merge([json.loads(Path(p).read_text()) for p in a.runs])
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {a.out} ({out['repeats']} repeats from {len(a.runs)} runs)")


def check_cmd(a):
    rows = within(json.loads(Path(a.first).read_text()), json.loads(Path(a.second).read_text()))
    for k, (m, lo, hi, ok) in rows.items():
        print(f"{'ok ' if ok else 'OUT'} {k}: second median {m}, first range {lo}-{hi}")
    sys.exit(0 if all(r[3] for r in rows.values()) else 1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--repeats", type=int, default=5)
    r.add_argument("--sessions", type=int, default=20)
    r.add_argument("--idle-secs", type=int, default=30)
    r.add_argument("--sends", type=int, default=20)
    r.add_argument("--settle", type=int, default=20, help="seconds after the window opens and after the sessions start")
    r.add_argument("--no-build", action="store_true")
    r.add_argument("--out")
    o = sub.add_parser("ops")
    o.add_argument("--clones", help="a new folder for the two clean clones, or one an earlier run made; without it no clone build")
    o.add_argument("--out")
    d = sub.add_parser("dev")
    d.add_argument("--target", required=True, help="a new folder, or one an earlier run made (it holds .scorecard-owned)")
    d.add_argument("--out")
    m = sub.add_parser("merge")
    m.add_argument("out")
    m.add_argument("runs", nargs="+")
    c = sub.add_parser("check")
    c.add_argument("first")
    c.add_argument("second")
    p = sub.add_parser("page")
    p.add_argument("results", nargs="?")
    a = ap.parse_args()
    {"run": run_cmd, "ops": ops_cmd, "dev": dev_cmd, "merge": merge_cmd, "check": check_cmd, "page": page_cmd}[a.cmd](a)


if __name__ == "__main__":
    main()
