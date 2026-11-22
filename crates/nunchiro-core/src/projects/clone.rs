//! Ticket 370 item 3: `git clone` of a typed URL into a folder this job claims, with progress, Cancel and Retry.
//! Shaped like `account_signin`: start answers at once, the child runs on its own thread in its own process group, and
//! every way out other than success ends that group first and then removes the claimed folder. Owner and window only
//! (`check_agent`, the browser role's list).
//!
//! Behaviour taken from Orca at `2eb0bb63` (`src/main/git/repo-clone-path.ts`: the name from a URL, claiming with a
//! non-recursive mkdir, removing only that same folder; `src/main/ipc/repos/repo-clone-lifecycle.ts`: the percent line)
//! and T3 Code at `d14ace8` (`SourceControlRepositoryService.ts`: the 120 s limit, the env, the userinfo redaction). No
//! code is copied. T3's keep-the-folder-and-clear-it is deliberately not followed: a failed clone leaves nothing.
use crate::api::{Reply, Request, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs,
    io::{ErrorKind, Read},
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::{Component, Path, PathBuf},
    process::{Child, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub job: String,
    pub phase: Phase,
    /// git's progress label and its percent; the window translates the labels it knows.
    pub stage: Option<String>,
    pub percent: u8,
    pub kind: Option<Kind>,
    /// A refusal that is about the parent folder, not the URL.
    pub parent: bool,
    /// The target folder (also for `Exists`, which says which folder it did not touch).
    pub path: Option<PathBuf>,
    /// `Other` only: git's last error line, credentials removed.
    pub detail: Option<String>,
    /// The folder this job claimed is gone again.
    pub removed: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Cloning,
    Done,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Auth,
    Ssh,
    Timeout,
    Exists,
    Refused,
    Other,
}

struct Job {
    state: State,
    /// The process group while its leader is not yet reaped (so the id cannot have been reused).
    group: Option<i32>,
    cancel: bool,
    last_output: Instant,
    last_watched: Instant,
    /// The newest lines that are not progress, for the kind and `detail`.
    lines: VecDeque<String>,
    ended: Option<Instant>,
}
static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

#[derive(Clone, Copy)]
struct Limits {
    /// T3's 120 s, counted from the last output: a whole-job limit would end a normal large clone.
    stall: Duration,
    /// No state read for this long means no dialog is watching (a reloaded or crashed window), and the folder it holds
    /// would answer a Retry with "exists" until then.
    unwatched: Duration,
}
const LIMITS: Limits = Limits {
    stall: Duration::from_secs(120),
    // ponytail: a window whose timers are throttled past this looks abandoned; a heartbeat outside page timers if so.
    unwatched: Duration::from_secs(15),
};
const KEEP_ENDED: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(100);
const STOP_WAIT: Duration = Duration::from_secs(8);
const URL_MAX: usize = 2048;
const LINE_MAX: usize = 512;
const LINES_KEPT: usize = 20;
const DETAIL_MAX: usize = 300;

fn with<T>(f: impl FnOnce(&mut HashMap<String, Job>) -> T) -> Result<T, String> {
    let mut guard = JOBS.lock().map_err(|_| "clone list unavailable")?;
    Ok(f(guard.get_or_insert_with(HashMap::new)))
}

/// Clones that have not ended. An unreadable list counts as one, so a core swap waits rather than ends a clone.
pub(crate) fn running() -> usize {
    with(|all| all.values().filter(|j| j.ended.is_none()).count()).unwrap_or(1)
}

/// Each request answers at once with the job's state; a refused start is a failed state that has no job behind it.
pub(crate) fn handle(request: Request) -> Response {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let state = match request {
        Request::ProjectClone { url, parent } => start("git", &url, &parent, home, LIMITS)?,
        Request::ProjectCloneState { job } => with(|all| {
            let j = all.get_mut(&job).ok_or("unknown clone")?;
            j.last_watched = Instant::now();
            Ok::<_, String>(j.state.clone())
        })??,
        Request::ProjectCloneCancel { job } => with(|all| {
            let j = all.get_mut(&job).ok_or("unknown clone")?;
            j.cancel = true;
            Ok::<_, String>(j.state.clone())
        })??,
        _ => return Err("not a clone request".into()),
    };
    Ok(Reply::ProjectClone { state })
}

fn ended(kind: Kind, parent: bool, path: Option<PathBuf>, detail: Option<String>) -> State {
    State {
        job: String::new(),
        phase: Phase::Failed,
        stage: None,
        percent: 0,
        kind: Some(kind),
        parent,
        path,
        detail,
        removed: false,
    }
}

/// `https://…`, `ssh://…` or `user@host:path`, nothing else: this is the core's own check, whatever the form did.
/// `ext::`, `file://`, a local path, plain `http://` and anything an ssh or git option could hide in are refused.
fn allowed(url: &str) -> bool {
    if url.is_empty()
        || url.len() > URL_MAX
        || url.starts_with('-')
        || url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || crate::board::rights::hidden(c))
    {
        return false;
    }
    let authority_ok = |rest: &str| {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit('@').next().unwrap_or("");
        !path.is_empty()
            && !authority.starts_with('-')
            && !host.is_empty()
            && !host.starts_with('-')
    };
    if let Some(rest) = url.strip_prefix("https://").or(url.strip_prefix("ssh://")) {
        return authority_ok(rest);
    }
    let word = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    url.split_once('@')
        .and_then(|(user, rest)| Some((user, rest.split_once(':')?)))
        .is_some_and(|(user, (host, path))| {
            word(user) && word(host) && !path.is_empty() && !path.starts_with([':', '-'])
        })
}

/// The folder name a URL gives: its last path part without `.git`, under the same rule as a new project's name, and
/// never an option-like name. Only the path is looked at, so a host never becomes the folder.
fn folder_name(url: &str) -> Option<String> {
    let path = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => url.split_once(':')?.1,
    };
    let last = path.trim_end_matches('/').rsplit('/').next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (super::name_ok(name) && !name.starts_with('-')).then(|| name.to_string())
}

/// A leading `~/` is the core's HOME; after that only an absolute path with no `..` part.
pub(super) fn parent_dir(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.chars().any(|c| c.is_control()) {
        return None;
    }
    let path = match raw.strip_prefix("~/") {
        Some(rest) => home?.join(rest),
        None => PathBuf::from(raw),
    };
    (path.is_absolute() && !path.components().any(|c| c == Component::ParentDir)).then_some(path)
}

/// `protocol.ext.allow=never` stops a `ext::` transport from any redirect or config, and `--` keeps the URL an operand.
/// Ticket 403 item 7: the checkout runs no hook or fsmonitor from the user's config (`NO_PROGRAMS`).
fn argv(url: &str, target: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = crate::process::NO_PROGRAMS
        .into_iter()
        .chain([
            "-c",
            "protocol.ext.allow=never",
            "clone",
            "--progress",
            "--",
            url,
        ])
        .map(OsString::from)
        .collect();
    args.push(target.into());
    args
}

/// Ticket 403 item 7: the filter listing's limit before a clone starts.
const FILTER_LIMIT: Duration = Duration::from_secs(10);
/// The core's own session identity, which no Git child gets.
pub(super) const SESSION_ENV: [&str; 2] = ["NUNCHIRO_TOKEN", "NUNCHIRO_SESSION"];

/// No tty: git and ssh fail instead of asking. English messages, because the kind is read from them.
const ENV: [(&str, &str); 4] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_SSH_COMMAND", "ssh -oBatchMode=yes"),
    ("GIT_PROGRESS_DELAY", "0"),
    ("LC_ALL", "C"),
];

fn start(
    program: &str,
    url: &str,
    parent: &str,
    home: Option<PathBuf>,
    limits: Limits,
) -> Result<State, String> {
    let url = url.trim();
    let Some(name) = allowed(url).then(|| folder_name(url)).flatten() else {
        return Ok(ended(Kind::Refused, false, None, None));
    };
    let Some(parent) = parent_dir(parent, home.as_deref()) else {
        return Ok(ended(Kind::Refused, true, None, None));
    };
    let target = parent.join(name);
    if let Err(e) = fs::create_dir_all(&parent) {
        return Ok(ended(Kind::Other, false, None, Some(e.to_string())));
    }
    // `create_dir` (not `_all`) fails on anything already there, so only a folder made here can ever be removed.
    if let Err(e) = fs::create_dir(&target) {
        return Ok(if e.kind() == ErrorKind::AlreadyExists {
            ended(Kind::Exists, false, Some(target), None)
        } else {
            ended(Kind::Other, false, None, Some(e.to_string()))
        });
    }
    let (claimed, job, state) = release_on_err(&target, || {
        let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        let job = crate::store::new_id()?;
        let state = State {
            job: job.clone(),
            phase: Phase::Cloning,
            stage: None,
            percent: 0,
            kind: None,
            parent: false,
            path: Some(target.clone()),
            detail: None,
            removed: false,
        };
        with(|all| {
            all.retain(|_, j| j.ended.is_none_or(|t| t.elapsed() < KEEP_ENDED));
            let now = Instant::now();
            all.insert(
                job.clone(),
                Job {
                    state: state.clone(),
                    group: None,
                    cancel: false,
                    last_output: now,
                    last_watched: now,
                    lines: VecDeque::new(),
                    ended: None,
                },
            );
        })?;
        Ok(((meta.dev(), meta.ino()), job, state))
    })?;
    let (program, url) = (program.to_string(), url.to_string());
    thread::spawn(move || run(&job, &program, &url, &target, claimed, limits));
    Ok(state)
}

/// A claim that never became a job gives its folder back. `remove_dir` only takes an empty folder.
fn release_on_err<T>(target: &Path, step: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    step().inspect_err(|_| {
        let _ = fs::remove_dir(target);
    })
}

enum End {
    Exited(bool),
    Cancelled,
    TimedOut,
    StartFailed(String),
}

fn run(key: &str, program: &str, url: &str, target: &Path, claimed: (u64, u64), limits: Limits) {
    let end = clone_child(key, program, url, target, limits);
    let lines: Vec<String> = with(|all| all.get(key).map(|j| j.lines.iter().cloned().collect()))
        .ok()
        .flatten()
        .unwrap_or_default();
    let (mut phase, mut kind, mut detail) = match end {
        End::Exited(true) => (Phase::Done, None, None),
        End::Cancelled => (Phase::Cancelled, None, None),
        End::TimedOut => (Phase::Failed, Some(Kind::Timeout), None),
        End::StartFailed(e) => (Phase::Failed, Some(Kind::Other), Some(e)),
        End::Exited(false) => {
            let kind = classify(url, &lines);
            let detail = (kind == Kind::Other)
                .then(|| error_line(url, &lines))
                .flatten();
            (Phase::Failed, Some(kind), detail)
        }
    };
    let removed = phase != Phase::Done && remove_claimed(target, claimed);
    if phase == Phase::Cancelled && !removed {
        // The form must not come back as if nothing were left behind.
        (phase, kind, detail) = (Phase::Failed, Some(Kind::Other), None);
    }
    let _ = with(|all| {
        if let Some(j) = all.get_mut(key) {
            j.state.phase = phase;
            j.state.kind = kind;
            j.state.detail = detail;
            j.state.removed = removed;
            j.lines.clear();
            j.ended = Some(Instant::now());
        }
    });
}

/// Removes the folder only while it is the very one this job made (a same-named replacement is not ours).
fn remove_claimed(target: &Path, claimed: (u64, u64)) -> bool {
    match fs::symlink_metadata(target) {
        Ok(m) if m.is_dir() && (m.dev(), m.ino()) == claimed => fs::remove_dir_all(target).is_ok(),
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        _ => false,
    }
}

fn clone_child(key: &str, program: &str, url: &str, target: &Path, limits: Limits) -> End {
    let mut command = crate::process::command(program);
    command.args(argv(url, target));
    command.envs(ENV);
    for k in SESSION_ENV {
        command.env_remove(k);
    }
    // Ticket 403 items 7 and 8: no config from the environment, and every filter the user's config names switched off.
    crate::process::scrub(&mut command, std::env::vars_os().map(|(k, _)| k));
    let parent = target.parent().unwrap_or(target);
    if let Err(e) = crate::process::filters_off(&mut command, parent, FILTER_LIMIT) {
        return End::StartFailed(e);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return End::StartFailed(e.to_string()),
    };
    let group = child.id() as i32;
    let reader = child.stderr.take().map(|err| {
        let key = key.to_string();
        thread::spawn(move || read_progress(&key, err))
    });
    let _ = with(|all| {
        if let Some(j) = all.get_mut(key) {
            j.group = Some(group);
            // Silence counts from the spawn, not from before the filter listing.
            j.last_output = Instant::now();
            // A stop that ran before the group was known could not kill it: do it here.
            if j.cancel {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
    });
    let end = loop {
        if exited(&child) {
            // The leader is a zombie until reaped, so its group id cannot be reused yet: helpers it left go with it.
            unsafe { libc::killpg(group, libc::SIGKILL) };
            // A stop can kill the leader before this loop sees the flag; a clone that finished anyway stays finished.
            let cancelled = with(|all| all.get(key).is_none_or(|j| j.cancel)).unwrap_or(true);
            let ok = reap(key, &mut child);
            break if cancelled && !ok {
                End::Cancelled
            } else {
                End::Exited(ok)
            };
        }
        let (cancel, stalled, abandoned) = with(|all| {
            all.get(key).map_or((true, false, false), |j| {
                (
                    j.cancel,
                    j.last_output.elapsed() >= limits.stall,
                    j.last_watched.elapsed() >= limits.unwatched,
                )
            })
        })
        .unwrap_or((true, false, false));
        if cancel || abandoned || stalled {
            unsafe { libc::killpg(group, libc::SIGKILL) };
            reap(key, &mut child);
            break if stalled && !cancel && !abandoned {
                End::TimedOut
            } else {
                End::Cancelled
            };
        }
        thread::sleep(POLL);
    };
    // The group is gone, so the pipe closes; the wait is bounded for a helper that left the group and kept it open.
    if let Some(reader) = reader {
        let until = Instant::now() + Duration::from_secs(1);
        while !reader.is_finished() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
    }
    end
}

/// ponytail: copied from `account_signin::exited`, which this lane does not own; share it when both can be edited.
/// The child has exited, checked without reaping it (`WNOWAIT`).
fn exited(child: &Child) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let r = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    r == 0 && info.si_pid != 0
}

/// Forgets the group under the lock, then reaps the leader: `stop_all` never signals a reaped (reusable) id.
fn reap(key: &str, child: &mut Child) -> bool {
    let _ = with(|all| all.get_mut(key).map(|j| j.group = None));
    child.wait().is_ok_and(|s| s.success())
}

/// The core is stopping: every clone's group goes now, and the job threads remove their folders. Bounded, as
/// `account_signin::stop_all` is.
pub(crate) fn stop_all() {
    // Ticket 404: the lib tests run many cores in this one process, and a core test's `stop` or `leave` can land at any
    // point of a clone test here (seconds long under load): it ended them as Cancelled. A real core is alone.
    stop_where(|_, j| !cfg!(test) || !test_job(j));
}

/// This module's tests clone into `ns-clone-*` scratch folders.
fn test_job(j: &Job) -> bool {
    let parent = j
        .state
        .path
        .as_deref()
        .and_then(|p| p.parent()?.file_name());
    parent.is_some_and(|n| n.to_string_lossy().starts_with("ns-clone-"))
}

/// `hit` is always true outside tests, which share this process-wide list and must only stop their own job.
fn stop_where(hit: impl Fn(&str, &Job) -> bool) {
    let _ = with(|all| {
        for (_, j) in all.iter_mut().filter(|(k, j)| hit(k, j)) {
            j.cancel = true;
            if let Some(group) = j.group.take() {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
    });
    let live =
        || with(|all| all.iter().any(|(k, j)| hit(k, j) && j.ended.is_none())).unwrap_or(false);
    let until = Instant::now() + STOP_WAIT;
    while Instant::now() < until && live() {
        thread::sleep(POLL);
    }
}

/// Every byte counts as output for the stall limit; `\r` and `\n` both end a progress line.
fn read_progress(key: &str, mut err: impl Read) {
    let mut buf = [0; 8192];
    let mut line = Vec::new();
    while let Ok(n) = err.read(&mut buf) {
        if n == 0 {
            break;
        }
        let mut done = Vec::new();
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                done.push(String::from_utf8_lossy(&line).into_owned());
                line.clear();
            } else if line.len() < LINE_MAX {
                line.push(b);
            }
        }
        let _ = with(|all| {
            let Some(j) = all.get_mut(key) else { return };
            j.last_output = Instant::now();
            for text in done {
                match percent_line(&text) {
                    Some((stage, percent)) => {
                        j.state.stage = Some(stage);
                        j.state.percent = percent;
                    }
                    None if !text.trim().is_empty() => {
                        if j.lines.len() == LINES_KEPT {
                            j.lines.pop_front();
                        }
                        j.lines.push_back(text);
                    }
                    None => {}
                }
            }
        });
    }
}

/// Orca's `^([\w\s]+):\s+(\d+)%`: `Receiving objects:  42% (…)`. A `remote: …` line never matches.
fn percent_line(line: &str) -> Option<(String, u8)> {
    let (stage, rest) = line.split_once(':')?;
    if stage.is_empty()
        || !stage
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == ' ')
    {
        return None;
    }
    let rest = rest.strip_prefix(char::is_whitespace)?.trim_start();
    let digits = rest.find('%').map(|i| &rest[..i])?;
    let percent: u32 = digits.parse().ok()?;
    Some((stage.trim().to_string(), percent.min(100) as u8))
}

fn classify(url: &str, lines: &[String]) -> Kind {
    let text = lines.join("\n").to_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    let is_ssh = !url.starts_with("https://");
    if is_ssh
        && any(&[
            "permission denied",
            "host key verification failed",
            "too many authentication failures",
            "no more authentication methods",
        ])
    {
        return Kind::Ssh;
    }
    if !is_ssh
        && any(&[
            "authentication failed",
            "could not read username",
            "could not read password",
            "terminal prompts disabled",
            "invalid username or password",
            "http basic: access denied",
        ])
    {
        return Kind::Auth;
    }
    Kind::Other
}

/// git's last `fatal:` or `error:` line, with anything secret from the URL removed.
fn error_line(url: &str, lines: &[String]) -> Option<String> {
    let line = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))?;
    Some(redact(line, url).chars().take(DETAIL_MAX).collect())
}

/// Removes the URL's own user and password wherever they appear, then any `scheme://…@` userinfo left (T3's rule).
fn redact(text: &str, url: &str) -> String {
    let mut out = text.to_string();
    if let Some((_, rest)) = url.split_once("://") {
        let authority = rest.split('/').next().unwrap_or("");
        if let Some((info, _)) = authority.rsplit_once('@') {
            let mut secrets = vec![info];
            secrets.extend(info.split(':'));
            // A one-letter username would otherwise mask that letter everywhere in the line.
            for secret in secrets.into_iter().filter(|s| s.chars().count() >= 3) {
                out = out.replace(secret, "***");
            }
        }
    }
    let mut clean = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        clean.push_str(head);
        // Not at `/`: a password can hold one. An `@` later in a path costs only some of the shown URL.
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"'))
            .unwrap_or(tail.len());
        rest = match tail[..end].rfind('@') {
            Some(at) => &tail[at + 1..],
            None => tail,
        };
    }
    clean.push_str(rest);
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const LONG: Limits = Limits {
        stall: Duration::from_secs(120),
        unwatched: Duration::from_secs(120),
    };

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ns-clone-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        // The cleanup tests compare real paths, and macOS temp is behind a link.
        p.canonicalize().unwrap()
    }

    /// A stand-in for `git`: `$1`..`$N` are the real argv, so its target is the last argument.
    fn stand_in(dir: &Path, body: &str) -> String {
        let path = dir.join("fake-git");
        let script =
            format!("#!/bin/sh\n[ \"$1\" = probe ] && exit 0\nfor target; do :; done\n{body}\n");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        // A fork on another test thread can briefly hold the write descriptor (ETXTBSY). Once one exec works, no later
        // fork can have inherited it.
        while let Err(e) = Command::new(&path).arg("probe").status() {
            assert_eq!(e.raw_os_error(), Some(libc::ETXTBSY), "{e}");
            thread::sleep(Duration::from_millis(5));
        }
        path.to_str().unwrap().to_string()
    }

    fn begin(program: &str, url: &str, parent: &Path, limits: Limits) -> State {
        start(program, url, parent.to_str().unwrap(), None, limits).unwrap()
    }

    fn read(job: &str) -> State {
        with(|all| {
            let j = all.get_mut(job).unwrap();
            j.last_watched = Instant::now();
            j.state.clone()
        })
        .unwrap()
    }

    fn finish(job: &str) -> State {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            let state = read(job);
            if state.phase != Phase::Cloning {
                return state;
            }
            assert!(Instant::now() < until, "clone did not end");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for(path: &Path) {
        let until = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(Instant::now() < until, "{path:?} never appeared");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn gone(pid: i32) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            let mut status = 0;
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn project_clone_refuses_every_url_outside_the_allowlist() {
        let d = scratch("urls");
        for bad in [
            "ext::sh -c x",
            "ext::x",
            "-oProxyCommand=x",
            "ssh://-oProxyCommand=x/a",
            "git@-oProxyCommand=x:a",
            "file:///a",
            "/local/path",
            "http://h/a",
            "https://h/a\nb",
            "https://h/a\u{7}b",
            "https://h/a b",
            "",
        ] {
            let s = begin("/nonexistent/git", bad, &d, LONG);
            assert_eq!(
                (s.phase, s.kind, s.job.as_str()),
                (Phase::Failed, Some(Kind::Refused), ""),
                "{bad:?}"
            );
        }
        assert_eq!(
            fs::read_dir(&d).unwrap().count(),
            0,
            "a refusal claims nothing"
        );
        for good in [
            "https://github.com/a/b.git",
            "ssh://git@github.com/a/b.git",
            "git@github.com:a/b.git",
        ] {
            assert!(allowed(good), "{good}");
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_folder_name_follows_the_project_name_rule() {
        let d = scratch("names");
        for bad in [
            "https://h/..",
            "https://h/.git",
            "https://h/-x",
            "https://h/",
        ] {
            let s = begin("/nonexistent/git", bad, &d, LONG);
            assert_eq!(s.kind, Some(Kind::Refused), "{bad:?}");
        }
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        assert_eq!(folder_name("https://h/a/b.git/").as_deref(), Some("b"));
        assert_eq!(folder_name("git@h:a/b.git").as_deref(), Some("b"));
        assert_eq!(folder_name("git@h:b").as_deref(), Some("b"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_parent_expands_home_and_refuses_relative_and_dotdot() {
        let home = Path::new("/h/me");
        assert_eq!(
            parent_dir("~/Projects", Some(home)),
            Some(home.join("Projects"))
        );
        assert_eq!(parent_dir(" /a/b ", None), Some(PathBuf::from("/a/b")));
        for bad in ["a/b", "~", "~other/x", "/a/../b", "~/../b", "", "/a\nb"] {
            assert_eq!(parent_dir(bad, Some(home)), None, "{bad:?}");
        }
        let d = scratch("parent");
        let s = start("/nonexistent/git", "https://h/a", "rel", None, LONG).unwrap();
        assert_eq!((s.kind, s.parent), (Some(Kind::Refused), true));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_argv_has_the_protocol_guard_then_double_dash_before_the_url() {
        let d = scratch("argv");
        let git = stand_in(
            &d,
            &format!(
                "printf '%s\\n' \"$@\" > {o}/argv\n\
                 printf '%s\\n%s\\n' \"$GIT_TERMINAL_PROMPT\" \"$GIT_SSH_COMMAND\" > {o}/env",
                o = d.display()
            ),
        );
        let s = begin(&git, "https://h/repo.git", &d, LONG);
        assert_eq!(finish(&s.job).phase, Phase::Done);
        let target = d.join("repo");
        assert!(target.is_dir(), "success keeps the folder");
        let argv = fs::read_to_string(d.join("argv")).unwrap();
        let argv: Vec<&str> = argv.lines().collect();
        assert_eq!(
            argv,
            [
                // Ticket 403 item 7: no hook or fsmonitor from the user's config runs in the checkout.
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.ext.allow=never",
                "clone",
                "--progress",
                "--",
                "https://h/repo.git",
                target.to_str().unwrap()
            ]
        );
        assert_eq!(
            fs::read_to_string(d.join("env")).unwrap(),
            "0\nssh -oBatchMode=yes\n",
            "no tty: both prompts fail instead of hanging"
        );
        fs::remove_dir_all(d).unwrap();
    }

    /// Round 2 (review R3): a clone switches off every filter the user's config names (`filters_off`). The stand-in
    /// runs real git with a global config that defines `filter.evil.smudge` and maps the URL to a local repository
    /// whose `.gitattributes` picks it; the parent folder's config names `evil` too, as the user's would.
    #[test]
    fn project_clone_runs_no_configured_filter() {
        let d = scratch("filter");
        let git = |dir: &Path, args: &[&str]| {
            let mut c = Command::new("git");
            for k in crate::process::FIXTURE_SCRUB {
                c.env_remove(k);
            }
            let ok = c
                .current_dir(dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&d, &["init", "-q"]);
        git(&d, &["config", "filter.evil.clean", "cat"]);
        let src = d.join("src");
        fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        fs::write(src.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        fs::write(src.join("a.txt"), "a\n").unwrap();
        git(&src, &["add", "-A"]);
        git(&src, &["commit", "-q", "-m", "init"]);
        let marker = d.join("ran");
        let global = d.join("global.gitconfig");
        fs::write(
            &global,
            format!(
                "[filter \"evil\"]\n\tsmudge = \"sh -c 'echo ran >> {}; cat'\"\n\
                 [url \"file://{}\"]\n\tinsteadOf = https://h/repo.git\n\
                 [protocol \"file\"]\n\tallow = always\n",
                marker.display(),
                src.display()
            ),
        )
        .unwrap();
        let fake = stand_in(
            &d,
            &format!("GIT_CONFIG_GLOBAL='{}' exec git \"$@\"", global.display()),
        );
        let s = begin(&fake, "https://h/repo.git", &d, LONG);
        let end = finish(&s.job);
        let cloned = d.join("repo/a.txt").exists();
        let ran = marker.exists();
        fs::remove_dir_all(&d).unwrap();
        assert_eq!(end.phase, Phase::Done, "{end:?}");
        assert!(cloned, "the clone checked nothing out");
        assert!(!ran, "a clone ran a configured filter");
    }

    #[test]
    fn project_clone_reports_percent_from_git_progress() {
        let d = scratch("percent");
        let hold = d.join("hold");
        let git = stand_in(
            &d,
            &format!(
                "printf 'Cloning into x\\nremote: Counting objects:  10%% (1/9)\\rReceiving objects:  42%% (4/9)\\r' >&2\n\
                 while [ ! -f {h} ]; do sleep 0.02; done",
                h = hold.display()
            ),
        );
        let s = begin(&git, "https://h/repo.git", &d, LONG);
        let until = Instant::now() + Duration::from_secs(10);
        while read(&s.job).percent == 0 {
            assert!(Instant::now() < until, "no progress");
            thread::sleep(Duration::from_millis(10));
        }
        let seen = read(&s.job);
        assert_eq!(
            (seen.stage.as_deref(), seen.percent),
            (Some("Receiving objects"), 42)
        );
        fs::write(&hold, "").unwrap();
        assert_eq!(finish(&s.job).phase, Phase::Done);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_silence_past_the_stall_limit_is_a_timeout_and_removes_the_folder() {
        let d = scratch("stall");
        let git = stand_in(&d, "echo x > \"$target/partial\"\nexec sleep 600");
        let limits = Limits {
            stall: Duration::from_millis(400),
            ..LONG
        };
        let s = begin(&git, "https://h/repo.git", &d, limits);
        let end = finish(&s.job);
        assert_eq!((end.phase, end.kind), (Phase::Failed, Some(Kind::Timeout)));
        assert!(end.removed);
        assert!(!d.join("repo").exists());
        fs::remove_dir_all(d).unwrap();
    }

    // Fake time: the 120 s limit at 1/120 scale. Output every 0.1 s for three whole limits: the limit is on silence.
    #[test]
    fn project_clone_a_slow_clone_that_keeps_printing_passes_the_limit() {
        let d = scratch("slow");
        let git = stand_in(
            &d,
            "i=0\nwhile [ $i -lt 30 ]; do echo tick >&2; sleep 0.1; i=$((i+1)); done",
        );
        let limits = Limits {
            stall: Duration::from_secs(1),
            ..LONG
        };
        let s = begin(&git, "https://h/repo.git", &d, limits);
        let end = finish(&s.job);
        assert_eq!((end.phase, end.kind), (Phase::Done, None));
        assert!(d.join("repo").is_dir());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_never_touches_a_folder_it_did_not_claim() {
        let d = scratch("exists");
        let target = d.join("repo");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("mine"), "keep").unwrap();
        let ran = d.join("ran");
        let git = stand_in(&d, &format!("touch {}", ran.display()));
        let s = begin(&git, "https://h/repo.git", &d, LONG);
        assert_eq!((s.phase, s.kind), (Phase::Failed, Some(Kind::Exists)));
        assert_eq!(s.path.as_deref(), Some(target.as_path()));
        assert_eq!((s.job.as_str(), s.removed), ("", false));
        // Nothing started, so neither a failure nor a Cancel has anything to clean up.
        assert!(matches!(
            handle(Request::ProjectCloneCancel { job: s.job.clone() }),
            Err(e) if e == "unknown clone"
        ));
        thread::sleep(Duration::from_millis(200));
        assert!(!ran.exists(), "git never ran");
        assert_eq!(fs::read_to_string(target.join("mine")).unwrap(), "keep");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_only_removes_the_very_folder_it_made() {
        let d = scratch("identity");
        let target = d.join("repo");
        fs::create_dir(&target).unwrap();
        let m = fs::symlink_metadata(&target).unwrap();
        let claimed = (m.dev(), m.ino());
        // Someone swapped in another folder after the claim.
        fs::remove_dir(&target).unwrap();
        let spare = d.join("spare");
        fs::create_dir(&spare).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("theirs"), "keep").unwrap();
        fs::remove_dir(&spare).unwrap();
        let now = fs::symlink_metadata(&target).unwrap();
        assert_ne!((now.dev(), now.ino()), claimed, "the swap gave a new inode");
        assert!(!remove_claimed(&target, claimed));
        assert!(target.join("theirs").exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_cancel_ends_the_process_group_then_removes_only_its_folder() {
        let d = scratch("cancel");
        fs::create_dir(d.join("sibling")).unwrap();
        fs::write(d.join("sibling/file"), "keep").unwrap();
        let (git_pid, child_pid) = (d.join("git.pid"), d.join("child.pid"));
        let git = stand_in(
            &d,
            &format!(
                "echo x > \"$target/partial\"\nsleep 600 &\necho $! > {c}\necho $$ > {g}\nwait",
                c = child_pid.display(),
                g = git_pid.display()
            ),
        );
        let s = begin(&git, "https://h/repo.git", &d, LONG);
        wait_for(&git_pid);
        let pid = |p: &Path| {
            fs::read_to_string(p)
                .unwrap()
                .trim()
                .parse::<i32>()
                .unwrap()
        };
        let (leader, helper) = (pid(&git_pid), pid(&child_pid));
        handle(Request::ProjectCloneCancel { job: s.job.clone() }).unwrap();
        let end = finish(&s.job);
        assert_eq!((end.phase, end.removed), (Phase::Cancelled, true));
        assert!(gone(leader), "the stand-in is gone");
        assert!(gone(helper), "its child is gone");
        assert!(!d.join("repo").exists(), "the claimed folder is gone");
        assert_eq!(fs::read_to_string(d.join("sibling/file")).unwrap(), "keep");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_failure_removes_its_folder_and_says_a_kind() {
        let d = scratch("fail");
        for (url, says, kind, dir) in [
            (
                "https://h/auth.git",
                "fatal: could not read Username for 'https://h': terminal prompts disabled",
                Kind::Auth,
                "auth",
            ),
            (
                "git@h:keys.git",
                "git@h: Permission denied (publickey).",
                Kind::Ssh,
                "keys",
            ),
            (
                "https://h/gone.git",
                "fatal: unable to access 'https://h/gone.git/': Could not resolve host: h",
                Kind::Other,
                "gone",
            ),
        ] {
            let git = stand_in(
                &d,
                &format!("echo x > \"$target/partial\"\necho \"{says}\" >&2\nexit 128"),
            );
            let s = begin(&git, url, &d, LONG);
            let end = finish(&s.job);
            assert_eq!(
                (end.phase, end.kind, end.removed),
                (Phase::Failed, Some(kind), true),
                "{url}"
            );
            assert!(!d.join(dir).exists());
            assert_eq!(end.detail.is_some(), kind == Kind::Other, "{url}");
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_a_job_nobody_reads_is_cancelled() {
        let d = scratch("watch");
        let git = stand_in(&d, "exec sleep 600");
        let limits = Limits {
            unwatched: Duration::from_millis(300),
            ..LONG
        };
        let s = begin(&git, "https://h/repo.git", &d, limits);
        let until = Instant::now() + Duration::from_secs(10);
        let end = loop {
            // Looks without counting as a watcher.
            let state = with(|all| all[&s.job].state.clone()).unwrap();
            if state.phase != Phase::Cloning {
                break state;
            }
            assert!(Instant::now() < until, "still running");
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!((end.phase, end.removed), (Phase::Cancelled, true));
        assert!(!d.join("repo").exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_never_repeats_credentials_from_the_url() {
        let d = scratch("secret");
        let url = "https://user:s3cr3t@h/repo.git";
        let git = stand_in(
            &d,
            "echo \"fatal: unable to access 'https://user:s3cr3t@h/repo.git/': bad s3cr3t and ftp://other:p4ss@z/y\" >&2\nexit 128",
        );
        let s = begin(&git, url, &d, LONG);
        let end = finish(&s.job);
        assert_eq!(end.kind, Some(Kind::Other));
        let replies = format!(
            "{}{}{:?}",
            serde_json::to_string(&s).unwrap(),
            serde_json::to_string(&end).unwrap(),
            handle(Request::ProjectCloneState { job: s.job.clone() }),
        );
        for secret in ["s3cr3t", "user:", "p4ss"] {
            assert!(!replies.contains(secret), "{secret} in {replies}");
        }
        assert!(
            end.detail.unwrap().contains("unable to access"),
            "the reason stays"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_redact_skips_short_secrets_and_reads_past_a_slash() {
        let line = redact("fatal: cannot reach a host", "https://a:secret@h/r");
        assert_eq!(
            line, "fatal: cannot reach a host",
            "a one-letter user masks nothing"
        );
        let line = redact("fatal: bad secret here", "https://a:secret@h/r");
        assert_eq!(line, "fatal: bad *** here");
        let line = redact("fatal: at 'https://u:pa/ss@h/a/': no", "https://h/a");
        assert_eq!(line, "fatal: at 'https://h/a/': no");
    }

    #[test]
    fn project_clone_a_claim_that_never_became_a_job_gives_its_folder_back() {
        let d = scratch("release");
        let target = d.join("repo");
        fs::create_dir(&target).unwrap();
        assert!(release_on_err(&target, || Err::<(), _>("no id".to_string())).is_err());
        assert!(!target.exists(), "the empty claim is gone");
        fs::create_dir(&target).unwrap();
        assert!(release_on_err(&target, || Ok(())).is_ok());
        assert!(target.is_dir(), "a claim that became a job stays");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_stop_all_ends_a_running_clone_and_its_folder() {
        let d = scratch("stopall");
        let started = d.join("started");
        let git = stand_in(&d, &format!("touch {}\nexec sleep 600", started.display()));
        let s = begin(&git, "https://h/repo.git", &d, LONG);
        wait_for(&started);
        stop_where(|k, _| k == s.job);
        let end = finish(&s.job);
        assert_eq!((end.phase, end.removed), (Phase::Cancelled, true));
        assert!(!d.join("repo").exists());
        fs::remove_dir_all(d).unwrap();
    }

    // Ticket 404: another lib test stopping its core ends every clone but this module's own.
    #[test]
    fn project_clone_a_core_test_stop_leaves_these_tests_alone() {
        let d = scratch("corestop");
        let other = d.join("other");
        let git = stand_in(&d, "exec sleep 600");
        let mine = begin(&git, "https://h/repo.git", &d, LONG);
        let theirs = begin(&git, "https://h/repo.git", &other, LONG);
        stop_all();
        let end = finish(&theirs.job);
        assert_eq!((end.phase, end.removed), (Phase::Cancelled, true));
        assert_eq!(read(&mine.job).phase, Phase::Cloning);
        stop_where(|k, _| k == mine.job);
        assert_eq!(finish(&mine.job).phase, Phase::Cancelled);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_clone_percent_line_reads_only_a_stage_and_a_number() {
        assert_eq!(
            percent_line("Resolving deltas:  100% (5/5), done."),
            Some(("Resolving deltas".to_string(), 100))
        );
        for no in [
            "remote: Counting objects:  10% (1/9)",
            "fatal: nope",
            "Cloning into 'x'...",
        ] {
            assert_eq!(percent_line(no), None, "{no}");
        }
    }
}
