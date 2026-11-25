//! Ticket 1100 part 2: the canary. Nunchiro reads the agents' terminal screens, so a new Claude Code or Codex version can
//! stop a reader silently. When the core first sees a version (its `--version` probe at a start), two checks run once:
//!
//! - Watch (passive): the first session on that version is read as usual; the canary only notes, as flags, whether the
//!   core read its input box and (Claude) its permission-mode footer within `WATCH_LIMIT`. No keys, no screen text kept.
//! - Fresh start (active, after the watch, so no owner session is starting beside it): the agent runs once in a pty under
//!   a temporary HOME, CLAUDE_CONFIG_DIR and CODEX_HOME (never the owner's: it is not signed in), env cleared, for at
//!   most `ACTIVE_LIMIT`; its first screen is read by the same readers the core uses. Then it is stopped, the
//!   daemons it started there are stopped, and the folder is removed.
//!
//! `agent-canary.json` keeps, per agent, the version and those flags and fixed failure sentences only. A failure gives
//! one card (the snapshot's problem slot) naming what no longer reads right.
use crate::api::AgentKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FILE: &str = "agent-canary.json";
const READ_MAX: u64 = 64 << 10;
/// How long the first session on a new version has to show its input box (and footer) to the core.
const WATCH_LIMIT: Duration = Duration::from_secs(120);
/// How long the fresh start may take to draw its first screen.
const ACTIVE_LIMIT: Duration = Duration::from_secs(20);
/// How long the watched session may draw nothing before another session on the version takes the watch over.
const TAKEOVER: Duration = Duration::from_secs(30);

/// This core build: its version and the time its executable was written, so every install or rebuild differs.
pub(crate) fn build() -> &'static str {
    static BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        let written = std::env::current_exe()
            .and_then(std::fs::metadata)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        format!("{}+{written}", env!("CARGO_PKG_VERSION"))
    })
}
/// The record is this version's, checked by this core build.
fn current(r: &Record, version: &str) -> bool {
    r.version == version && r.build == build()
}

pub(crate) const NO_BOX: &str = "the input box was not read within 2 minutes";
pub(crate) const NO_FOOTER: &str = "the permission-mode footer was not read within 2 minutes";
pub(crate) const NO_VERSION_LINE: &str = "its first screen does not show the version it reports";
pub(crate) const FIRST_RUN_AS_BOX: &str = "its first-run screen reads as the input box";
pub(crate) const NO_SIGN_IN: &str = "its sign-in screen is not recognized";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Record {
    pub version: String,
    /// The core build that checked it (`build`): another build checks again, so a fixed reader or a false failure
    /// does not keep its card.
    #[serde(default)]
    pub build: String,
    /// The watch ended (read or timed out).
    #[serde(default)]
    pub watched: bool,
    #[serde(default)]
    pub box_read: bool,
    #[serde(default)]
    pub footer_read: bool,
    /// The fresh start ran.
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub failed: Vec<String>,
}
type State = BTreeMap<String, Record>;

struct Watch {
    session: String,
    /// When the clock started: the last pass that showed a start dialog, else the first pass.
    since: Instant,
    /// The session's last pass: one silent for `TAKEOVER` (ended, or idle) hands the watch to the next session.
    last: Instant,
    box_read: bool,
    footer_read: bool,
}
/// Per core home: the state as last read or written, and the watch in progress per agent.
#[derive(Default)]
struct Kept {
    state: State,
    watches: BTreeMap<String, Watch>,
}
static KEPT: Mutex<BTreeMap<PathBuf, Kept>> = Mutex::new(BTreeMap::new());

fn key(kind: AgentKind) -> Option<&'static str> {
    match kind {
        AgentKind::Claude => Some("claude"),
        AgentKind::Codex => Some("codex"),
        _ => None,
    }
}
fn name(key: &str) -> &'static str {
    if key == "claude" {
        "Claude Code"
    } else {
        "Codex"
    }
}

fn read(home: &Path) -> State {
    crate::store::open_regular(&home.join(FILE))
        .and_then(|f| crate::store::read_capped(f, READ_MAX))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn with<T>(home: &Path, f: impl FnOnce(&mut Kept) -> T) -> T {
    let mut all = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    let kept = all.entry(home.to_path_buf()).or_insert_with(|| {
        // A fresh start a stopped core left behind (its folder) goes at this core's first use.
        let _ = std::fs::remove_dir_all(home.join("canary"));
        Kept {
            state: read(home),
            ..Default::default()
        }
    });
    f(kept)
}
fn save(home: &Path, state: &State) {
    let bytes = serde_json::to_vec_pretty(state).unwrap_or_default();
    if let Err(e) = crate::store::atomic_write(&home.join(FILE), &bytes) {
        eprintln!("agent canary: {e}");
    }
}

/// The core's `--version` answer for a session of `kind`. A version not seen before starts its checks.
pub(crate) fn version_seen(home: &Path, kind: AgentKind, version: &str) {
    let Some(k) = key(kind) else { return };
    // "unknown" (a failed probe) and other words without a number name no version to check.
    if !version.chars().any(|c| c.is_ascii_digit()) || version.len() > 100 {
        return;
    }
    if inside_home(home, k) {
        return;
    }
    with(home, |kept| {
        if kept.state.get(k).is_some_and(|r| current(r, version)) {
            return;
        }
        kept.state.insert(
            k.into(),
            Record {
                version: version.into(),
                build: build().into(),
                ..Default::default()
            },
        );
        kept.watches.remove(k);
        save(home, &kept.state);
    });
}

/// The program the core finds on its PATH lives inside the core's own home: a test's fake agent (a real install
/// never lives there), which would start fresh beside every test and put a card on its window. Not checked.
fn inside_home(home: &Path, program: &str) -> bool {
    let Ok(home) = home.canonicalize() else {
        return false;
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
        .is_some_and(|p| p.starts_with(&home))
}

/// True while session screens of `kind` at `version` are still watched, so the observe pass reads its flags only then.
pub(crate) fn watching(home: &Path, kind: AgentKind, version: Option<&str>) -> bool {
    let (Some(k), Some(v)) = (key(kind), version) else {
        return false;
    };
    with(home, |kept| {
        kept.state
            .get(k)
            .is_some_and(|r| current(r, v) && !r.watched)
    })
}

/// What one observe pass of a session read: its input box, its footer, and whether a start dialog or question was on
/// the screen (folder trust, a sign-in, a model prompt), which holds the watch's clock.
#[derive(Clone, Copy, Default)]
pub(crate) struct Pass {
    pub box_read: bool,
    pub footer_read: bool,
    pub dialog: bool,
}
/// One observe pass of session `id`. Returns true once the watch is over, when the fresh start should run
/// (`fresh_start`).
pub(crate) fn observed(home: &Path, kind: AgentKind, version: &str, id: &str, pass: Pass) -> bool {
    observed_at(home, kind, version, id, pass, Instant::now())
}
fn observed_at(
    home: &Path,
    kind: AgentKind,
    version: &str,
    id: &str,
    pass: Pass,
    now: Instant,
) -> bool {
    let Pass {
        box_read,
        footer_read,
        dialog,
    } = pass;
    let Some(k) = key(kind) else { return false };
    with(home, |kept| {
        if !kept
            .state
            .get(k)
            .is_some_and(|r| current(r, version) && !r.watched)
        {
            return false;
        }
        let fresh = || Watch {
            session: id.into(),
            since: now,
            last: now,
            box_read: false,
            footer_read: false,
        };
        let w = kept.watches.entry(k.into()).or_insert_with(fresh);
        if w.session != id {
            // One session at a time is watched; one that ended (or went quiet) hands it to this one.
            if now.duration_since(w.last) < TAKEOVER {
                return false;
            }
            *w = fresh();
        }
        w.last = now;
        if dialog {
            w.since = now;
        }
        w.box_read |= box_read;
        w.footer_read |= footer_read;
        let footer_needed = kind == AgentKind::Claude;
        let read_all = w.box_read && (w.footer_read || !footer_needed);
        if !read_all && now.duration_since(w.since) < WATCH_LIMIT {
            return false;
        }
        let (b, f) = (w.box_read, w.footer_read);
        let r = kept.state.get_mut(k).expect("checked above");
        r.watched = true;
        r.box_read = b;
        r.footer_read = f;
        if !b {
            r.failed.push(NO_BOX.into());
        } else if footer_needed && !f {
            r.failed.push(NO_FOOTER.into());
        }
        save(home, &kept.state);
        true
    })
}

/// The fresh start of `kind` (its program on the core's PATH), on its own thread. Its failures join the record of the
/// version it was for; a program that now reports another version (an update meanwhile, another install first on
/// PATH) checks nothing.
pub(crate) fn fresh_start(home: &Path, kind: AgentKind, version: &str) {
    let (home, version) = (home.to_path_buf(), version.to_string());
    let Some(k) = key(kind) else { return };
    std::thread::spawn(move || {
        let failed = match run_fresh(&home, kind, k, &version) {
            Ok(failed) => failed,
            Err(e) => {
                eprintln!("agent canary: {k} {version}: {e}");
                return;
            }
        };
        with(&home, |kept| {
            if let Some(r) = kept.state.get_mut(k).filter(|r| current(r, &version)) {
                r.started = true;
                r.failed.extend(failed.into_iter().map(String::from));
                save(&home, &kept.state);
            }
        });
    });
}

fn run_fresh(
    home: &Path,
    kind: AgentKind,
    program: &str,
    version: &str,
) -> Result<Vec<&'static str>, String> {
    let dir = home
        .join("canary")
        .join(format!("{program}-{}", crate::store::new_id()?));
    let since = now_micros();
    let out = fresh_in(&dir, kind, program, version);
    stop_daemons(&dir, since);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

fn fresh_in(
    dir: &Path,
    kind: AgentKind,
    program: &str,
    version: &str,
) -> Result<Vec<&'static str>, String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let own = dir.join("home");
    let project = dir.join("project");
    for d in [own.join(".claude"), own.join(".codex"), project.clone()] {
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let env = |cmd: &mut CommandBuilder| {
        cmd.env_clear();
        cmd.env("PATH", &path);
        cmd.env("HOME", &own);
        cmd.env("CLAUDE_CONFIG_DIR", own.join(".claude"));
        cmd.env("CODEX_HOME", own.join(".codex"));
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("USER", "canary");
        cmd.cwd(&project);
    };
    // The version first, in the same environment: a different program on PATH, or an update meanwhile, is not checked.
    let mut probe = crate::process::command(program);
    probe
        .arg("--version")
        .env_clear()
        .env("PATH", &path)
        .env("HOME", &own)
        .current_dir(&project);
    let reported = crate::process::output(probe, Duration::from_secs(5))?;
    if String::from_utf8_lossy(&reported.stdout).trim() != version {
        return Ok(vec![]);
    }
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(program);
    env(&mut cmd);
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let spawned = child.process_id().and_then(Spawned::of);
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let bytes = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink = bytes.clone();
    // Read to the end, also after the stop: an agent whose output nobody reads cannot finish exiting.
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 << 10];
        while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
            if n == 0 {
                break;
            }
            let mut b = sink.lock().unwrap_or_else(|e| e.into_inner());
            if b.len() < 1 << 20 {
                b.extend_from_slice(&buf[..n]);
            }
        }
    });
    let until = Instant::now() + ACTIVE_LIMIT;
    let failed = loop {
        std::thread::sleep(Duration::from_millis(250));
        let seen = bytes.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let failed = first_screen(kind, version, &seen);
        if failed.is_empty() || Instant::now() >= until {
            break failed;
        }
    };
    stop_child(&mut *child, spawned.as_ref());
    Ok(failed)
}

/// How long a stopped agent has after SIGHUP before SIGKILL, and again to be reaped after it.
const GRACE: Duration = Duration::from_secs(2);

/// A process this check started, by pid and start time: signalled only while it is still that process.
struct Spawned {
    pid: u32,
    started: u64,
}
impl Spawned {
    fn of(pid: u32) -> Option<Self> {
        Some(Self {
            pid,
            started: crate::peer::started(pid).ok()?,
        })
    }
    fn signal(&self, signal: i32) {
        if crate::peer::is_same(self.pid, self.started) {
            // SAFETY: a signal to a live process with the pid and start time this check recorded for its own child.
            unsafe { libc::kill(self.pid as i32, signal) };
        }
    }
}

/// Ends the check's own agent within about `2 * GRACE`: SIGHUP (an agent may ignore it), then SIGKILL, each followed
/// by a bounded wait to reap it. The child stays unreaped until then, so its pid cannot belong to another process.
fn stop_child(child: &mut (dyn portable_pty::Child + Send + Sync), spawned: Option<&Spawned>) {
    let reaped = |child: &mut (dyn portable_pty::Child + Send + Sync)| {
        let until = Instant::now() + GRACE;
        loop {
            if !matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let Some(own) = spawned else {
        // The child handle is ours and has not been reaped, so its pid cannot have been reused.
        if let Err(e) = child.kill() {
            eprintln!("agent canary: could not kill owned child: {e}");
        }
        if !reaped(child) {
            eprintln!("agent canary: owned child did not end after kill");
        }
        return;
    };
    own.signal(libc::SIGHUP);
    if reaped(child) {
        return;
    }
    own.signal(libc::SIGKILL);
    if !reaped(child) {
        eprintln!("agent canary: pid {} did not end after SIGKILL", own.pid);
    }
}

/// What the readers make of a fresh, signed-out first screen; empty when all read right.
pub(crate) fn first_screen(kind: AgentKind, version: &str, bytes: &[u8]) -> Vec<&'static str> {
    let mut screen = crate::waiting::screen::Screen::new(100, 30);
    screen.feed(bytes);
    let text = screen.text();
    let mut failed = vec![];
    match kind {
        AgentKind::Claude => {
            // Recorded with 2.1.331: "Welcome to Claude Code v2.1.331" over its theme picker, rows without numbers.
            let number = version.split_whitespace().next().unwrap_or_default();
            // The welcome line scrolls off a 30-row screen under the picker: it is looked for in all that was drawn.
            let mut all = crate::waiting::screen::Screen::new(100, 400);
            all.feed(bytes);
            if !all
                .text()
                .contains(&format!("Welcome to Claude Code v{number}"))
            {
                failed.push(NO_VERSION_LINE);
            }
            if crate::waiting::screen::past_start(&text) {
                failed.push(FIRST_RUN_AS_BOX);
            }
        }
        AgentKind::Codex
            if crate::problems::ended(kind, bytes, None, false).map(|p| p.case)
                != Some(crate::problems::Case::LoggedOut) =>
        {
            failed.push(NO_SIGN_IN);
        }
        _ => {}
    }
    failed
}

/// Codex 0.161.0 starts an app-server daemon (and its updater) from CODEX_HOME that outlives it, sometimes a moment
/// after the agent stopped. Each writes its pid and start time to `app-server-daemon/<name>.pid` in this check's
/// temporary CODEX_HOME. Only a process that matches such a file exactly (same pid and start time, started after this
/// check began, its executable inside this check's folder) is stopped; nothing is chosen by name or arguments.
/// Looked for again until 5 s passed, or 2 s with none left.
fn stop_daemons(dir: &Path, since: u64) {
    stop_daemons_with_log(dir, since, |message| eprintln!("{message}"));
}

fn stop_daemons_with_log(dir: &Path, since: u64, mut log: impl FnMut(&str)) {
    let Ok(root) = dir.canonicalize() else {
        return;
    };
    let files = root.join("home/.codex/app-server-daemon");
    let start = Instant::now();
    let mut proved = std::collections::BTreeSet::new();
    let mut unproved = std::collections::BTreeSet::new();
    loop {
        let mut left = false;
        for name in ["daemon.pid", "daemon-updater.pid"] {
            let file = files.join(name);
            if let Some(own) = daemon_of(&file, &root, since) {
                proved.insert(name);
                own.signal(libc::SIGKILL);
                left = true;
            } else if !proved.contains(name)
                && file.symlink_metadata().is_ok()
                && unproved.insert(name)
            {
                log(&format!(
                    "agent canary: {name} does not prove an owned daemon; leaving it unsignalled"
                ));
            }
        }
        let spent = start.elapsed();
        if spent >= Duration::from_secs(5) || !left && spent >= Duration::from_secs(2) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The live process a daemon pid file names, when it is provably this check's own.
fn daemon_of(file: &Path, root: &Path, since: u64) -> Option<Spawned> {
    let v: serde_json::Value = crate::store::open_regular(file)
        .and_then(|f| crate::store::read_capped(f, 4 << 10))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())?;
    let pid = u32::try_from(v["pid"].as_u64()?).ok().filter(|p| *p > 1)?;
    let id = &v["processIdentity"];
    let started = id["startSeconds"].as_u64()? * 1_000_000 + id["startMicroseconds"].as_u64()?;
    (started >= since && crate::peer::is_same(pid, started) && exe_inside(pid, root))
        .then_some(Spawned { pid, started })
}

fn exe_inside(pid: u32, root: &Path) -> bool {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is PROC_PIDPATHINFO_MAXSIZE bytes, as proc_pidpath requires.
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return false;
    }
    buf.truncate(n as usize);
    use std::os::unix::ffi::OsStrExt;
    Path::new(std::ffi::OsStr::from_bytes(&buf)).starts_with(root)
}

fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// The card: one, naming the agent, its version and what no longer reads right; none while all read.
pub(crate) fn problem(home: &Path) -> Option<crate::problems::Problem> {
    with(home, |kept| {
        let failing: Vec<(&String, &Record)> = kept
            .state
            .iter()
            .filter(|(_, r)| !r.failed.is_empty() && r.build == build())
            .collect();
        let (k, r) = failing.first()?;
        let details = failing
            .iter()
            .flat_map(|(k, r)| {
                r.failed
                    .iter()
                    .map(move |f| format!("{} {}: {f}", name(k), r.version))
            })
            .collect::<Vec<_>>()
            .join("\n");
        Some(crate::problems::Problem {
            case: crate::problems::Case::AgentChanged,
            cause: format!(
                "{} {} changed what Nunchiro reads: {}. Waiting, questions or the composer may not show right.",
                name(k),
                r.version
                    .split_whitespace()
                    .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .unwrap_or(&r.version),
                r.failed[0]
            ),
            reset: None,
            details,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_without_a_readable_start_time_is_killed_and_reaped() {
        #[derive(Debug, Default)]
        struct FakeChild {
            killed: bool,
            reaped: bool,
        }
        impl portable_pty::ChildKiller for FakeChild {
            fn kill(&mut self) -> std::io::Result<()> {
                self.killed = true;
                Ok(())
            }
            fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
                unreachable!("cleanup does not clone its child")
            }
        }
        impl portable_pty::Child for FakeChild {
            fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
                self.reaped = self.killed;
                Ok(self
                    .reaped
                    .then(|| portable_pty::ExitStatus::with_exit_code(1)))
            }
            fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
                unreachable!("cleanup must use a bounded wait")
            }
            fn process_id(&self) -> Option<u32> {
                Some(i32::MAX as u32)
            }
        }
        let mut child = FakeChild::default();
        let spawned = portable_pty::Child::process_id(&child).and_then(Spawned::of);
        assert!(spawned.is_none());
        stop_child(&mut child, spawned.as_ref());
        assert!(
            child.killed,
            "the owned child must be killed without a start time"
        );
        assert!(child.reaped, "the killed child must be reaped");
    }

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/canary")
                .join(name),
        )
        .unwrap()
    }
    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("nunchiro-canary-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    /// Recorded in a pty (100x30) with a fresh HOME, CLAUDE_CONFIG_DIR and CODEX_HOME, not signed in, 12 s each.
    #[test]
    fn fresh_first_screens_of_the_recorded_versions_read_right() {
        assert_eq!(
            first_screen(
                AgentKind::Claude,
                "2.1.331 (Claude Code)",
                &fixture("claude-2.1.331-fresh.bin")
            ),
            Vec::<&str>::new()
        );
        assert_eq!(
            first_screen(
                AgentKind::Codex,
                "codex-cli 0.161.0",
                &fixture("codex-0.161.0-fresh.bin")
            ),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn a_program_inside_the_core_home_is_not_checked() {
        let h = home("inside");
        assert!(!inside_home(&h, "definitely-not-an-agent-1100"));
        assert!(!inside_home(&h, "sh")); // /bin/sh: outside
    }

    #[test]
    fn a_changed_first_screen_fails_with_what_no_longer_reads() {
        // Another version than the screen shows, and the welcome screen of a later Claude that lost its line.
        let claude = fixture("claude-2.1.331-fresh.bin");
        assert_eq!(
            first_screen(AgentKind::Claude, "2.1.340 (Claude Code)", &claude),
            [NO_VERSION_LINE]
        );
        assert_eq!(
            first_screen(
                AgentKind::Claude,
                "2.1.331 (Claude Code)",
                "\u{276f} \r\n".as_bytes()
            ),
            [NO_VERSION_LINE, FIRST_RUN_AS_BOX]
        );
        assert_eq!(
            first_screen(
                AgentKind::Codex,
                "codex-cli 0.172.0",
                b"Welcome to Codex\r\n> Start"
            ),
            [NO_SIGN_IN]
        );
    }

    /// The real installed agents, by hand only (`cargo test -p nunchiro-core --features live --lib real_fresh_start`): each
    /// fresh start reads right, leaves no folder behind and no daemon running from it.
    #[cfg(feature = "live")]
    #[test]
    fn real_fresh_start() {
        let h = home("real");
        for (kind, program) in [(AgentKind::Claude, "claude"), (AgentKind::Codex, "codex")] {
            let out = std::process::Command::new(program)
                .arg("--version")
                .output()
                .unwrap();
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            assert_eq!(
                run_fresh(&h, kind, program, &version).unwrap(),
                Vec::<&str>::new(),
                "{version}"
            );
        }
        assert_eq!(std::fs::read_dir(h.join("canary")).unwrap().count(), 0);
        let ps = std::process::Command::new("/bin/ps")
            .args(["-axo", "args="])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&ps.stdout).contains(&h.display().to_string()));
        std::fs::remove_dir_all(&h).unwrap();
    }

    fn pass(box_read: bool, footer_read: bool) -> Pass {
        Pass {
            box_read,
            footer_read,
            dialog: false,
        }
    }

    #[test]
    fn a_new_version_is_watched_once_and_a_missed_box_makes_one_card() {
        let h = home("watch");
        assert!(problem(&h).is_none());
        version_seen(&h, AgentKind::Claude, "2.1.331 (Claude Code)");
        version_seen(&h, AgentKind::Claude, "unknown"); // no number: ignored
        assert!(watching(
            &h,
            AgentKind::Claude,
            Some("2.1.331 (Claude Code)")
        ));
        assert!(!watching(&h, AgentKind::Codex, Some("codex-cli 0.161.0")));
        let t0 = Instant::now();
        let v = "2.1.331 (Claude Code)";
        // Box and footer read: the watch ends at once, nothing failed.
        assert!(!observed_at(
            &h,
            AgentKind::Claude,
            v,
            "a",
            pass(true, false),
            t0
        ));
        assert!(!observed_at(
            &h,
            AgentKind::Claude,
            v,
            "b",
            pass(true, true),
            t0
        )); // one session at a time
        assert!(observed_at(
            &h,
            AgentKind::Claude,
            v,
            "a",
            pass(false, true),
            t0
        ));
        assert!(!watching(&h, AgentKind::Claude, Some(v)));
        assert!(problem(&h).is_none());
        // The stored flags are all the file holds of the screens.
        let stored: State = serde_json::from_slice(&std::fs::read(h.join(FILE)).unwrap()).unwrap();
        assert_eq!(
            stored["claude"],
            Record {
                version: v.into(),
                build: build().into(),
                watched: true,
                box_read: true,
                footer_read: true,
                ..Default::default()
            }
        );
        // A later Codex whose box is never read within the limit: one card names it.
        let c = "codex-cli 0.172.0";
        version_seen(&h, AgentKind::Codex, c);
        assert!(!observed_at(
            &h,
            AgentKind::Codex,
            c,
            "x",
            pass(false, false),
            t0
        ));
        assert!(observed_at(
            &h,
            AgentKind::Codex,
            c,
            "x",
            pass(false, false),
            t0 + WATCH_LIMIT
        ));
        let p = problem(&h).unwrap();
        assert_eq!(p.case, crate::problems::Case::AgentChanged);
        assert!(
            p.cause.starts_with(
                "Codex 0.172.0 changed what Nunchiro reads: the input box was not read"
            ),
            "{}",
            p.cause
        );
        // Seen again (another start on it): nothing restarts; a new version replaces the record and the card goes.
        version_seen(&h, AgentKind::Codex, c);
        assert!(problem(&h).is_some());
        version_seen(&h, AgentKind::Codex, "codex-cli 0.173.0");
        assert!(problem(&h).is_none());
        std::fs::remove_dir_all(&h).unwrap();
    }

    /// Review r1 MUST: a failure another core build recorded (before a Nunchiro fix, or a false one) shows no card, and
    /// the version is watched again by this build. A fresh start a stopped core left behind is swept.
    #[test]
    fn a_record_from_another_core_build_gives_no_card_and_is_checked_again() {
        let h = home("build");
        let v = "codex-cli 0.172.0";
        let old = Record {
            version: v.into(),
            build: "0.0.1+1".into(),
            watched: true,
            started: true,
            failed: vec![NO_SIGN_IN.into()],
            ..Default::default()
        };
        let state: State = [("codex".to_string(), old)].into();
        std::fs::write(h.join(FILE), serde_json::to_vec(&state).unwrap()).unwrap();
        std::fs::create_dir_all(h.join("canary/codex-left")).unwrap();
        assert!(problem(&h).is_none());
        assert!(!h.join("canary").exists());
        assert!(!watching(&h, AgentKind::Codex, Some(v)));
        version_seen(&h, AgentKind::Codex, v);
        assert!(watching(&h, AgentKind::Codex, Some(v)));
        let stored: State = serde_json::from_slice(&std::fs::read(h.join(FILE)).unwrap()).unwrap();
        assert_eq!(
            (stored["codex"].build.as_str(), stored["codex"].failed.len()),
            (build(), 0)
        );
        std::fs::remove_dir_all(&h).unwrap();
    }

    /// Review r1 SHOULD 2 and 3: a start dialog holds the clock, and a watched session that went silent (ended) hands the
    /// watch to the next session on the version.
    #[test]
    fn a_dialog_holds_the_clock_and_a_silent_session_hands_the_watch_over() {
        let h = home("clock");
        let v = "codex-cli 0.172.0";
        version_seen(&h, AgentKind::Codex, v);
        let t0 = Instant::now();
        let dialog = Pass {
            dialog: true,
            ..Default::default()
        };
        assert!(!observed_at(&h, AgentKind::Codex, v, "a", dialog, t0));
        // Three minutes on a trust or sign-in dialog: no failure yet.
        assert!(!observed_at(
            &h,
            AgentKind::Codex,
            v,
            "a",
            dialog,
            t0 + Duration::from_secs(180)
        ));
        // "a" ends; "b" is refused while "a" was heard from within TAKEOVER, then takes the watch with a fresh clock.
        assert!(!observed_at(
            &h,
            AgentKind::Codex,
            v,
            "b",
            pass(false, false),
            t0 + Duration::from_secs(190)
        ));
        let later = t0 + Duration::from_secs(180) + TAKEOVER;
        assert!(!observed_at(
            &h,
            AgentKind::Codex,
            v,
            "b",
            pass(false, false),
            later
        ));
        assert!(observed_at(
            &h,
            AgentKind::Codex,
            v,
            "b",
            pass(true, false),
            later + Duration::from_secs(1)
        ));
        assert!(problem(&h).is_none());
        std::fs::remove_dir_all(&h).unwrap();
    }

    /// Security look r3 MUST 1: a process that only names the check's folder in its arguments is never signalled; a
    /// daemon that its pid file names exactly, running from inside the folder, is.
    #[test]
    fn only_a_daemon_its_pid_file_proves_is_stopped() {
        let h = home("daemons");
        let dir = h.join("canary/codex-x");
        let files = dir.join("home/.codex/app-server-daemon");
        std::fs::create_dir_all(&files).unwrap();
        let since = now_micros() - 1_000_000;
        // Names the folder in its arguments, as an editor or a grep might: left alone.
        let mut bystander = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30", &dir.display().to_string()])
            .spawn()
            .unwrap();
        // A daemon from inside the folder, with its pid file.
        let exe = dir.join("home/.codex/sleep");
        std::fs::copy("/bin/sleep", &exe).unwrap();
        let mut daemon = std::process::Command::new(&exe).arg("30").spawn().unwrap();
        let started = crate::peer::started(daemon.id()).unwrap();
        let identity = serde_json::json!({ "pid": daemon.id(), "processIdentity": {
            "startSeconds": started / 1_000_000, "startMicroseconds": started % 1_000_000 } });
        std::fs::write(files.join("daemon.pid"), identity.to_string()).unwrap();
        // The bystander's pid in a pid file is refused too: its executable is not inside the folder.
        let b = crate::peer::started(bystander.id()).unwrap();
        let forged = serde_json::json!({ "pid": bystander.id(), "processIdentity": {
            "startSeconds": b / 1_000_000, "startMicroseconds": b % 1_000_000 } });
        std::fs::write(files.join("daemon-updater.pid"), forged.to_string()).unwrap();
        let mut warnings = Vec::new();
        stop_daemons_with_log(&dir, since, |message| warnings.push(message.to_owned()));
        assert!(
            daemon.wait().unwrap().code().is_none(),
            "the daemon was killed"
        );
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "the bystander still runs"
        );
        bystander.kill().unwrap();
        bystander.wait().unwrap();
        std::fs::remove_dir_all(&h).unwrap();
        // Warn once for the unproved bystander, never for the stale file of the daemon just killed.
        assert_eq!(
            warnings,
            [
                "agent canary: daemon-updater.pid does not prove an owned daemon; leaving it unsignalled"
            ]
        );
    }

    /// Security look r3 MUST 2: an agent that ignores SIGHUP is killed after the grace period and reaped; the fresh
    /// start ends in bounded time.
    #[test]
    fn a_fresh_start_that_ignores_sighup_ends_within_its_grace() {
        let h = home("sighup");
        let fake = h.join("fake-agent");
        std::fs::write(
            &fake,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '9.9.9 (Claude Code)'; exit; fi\ntrap '' HUP\necho $$ > \"$HOME/pid\"\nprintf 'Welcome to Claude Code v9.9.9\\r\\n'\nwhile :; do sleep 0.1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        let dir = h.join("canary/claude-x");
        let at = Instant::now();
        let failed = fresh_in(
            &dir,
            AgentKind::Claude,
            &fake.display().to_string(),
            "9.9.9 (Claude Code)",
        )
        .unwrap();
        assert_eq!(failed, Vec::<&str>::new());
        assert!(at.elapsed() < Duration::from_secs(10), "{:?}", at.elapsed());
        let pid: i32 = std::fs::read_to_string(dir.join("home/pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only asks whether the pid exists.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "the agent is gone and reaped"
        );
        std::fs::remove_dir_all(&h).unwrap();
    }
}
