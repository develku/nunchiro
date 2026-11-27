//! Ticket 178 finding 20 (needs 149): "Add account" signs in through the browser, like Orca, instead of a visible
//! terminal tab. The agent's own login runs headless in the account folder with only that folder as its config
//! override; its sign-in link is opened in the default browser (`open`) once it passes the allowlist below; a pasted
//! code goes only to the login's stdin. Signed in is what the agent's own status command says (`accounts::probe`),
//! never a credential file or the Keychain. A new account is registered only once signed in, so no session can start
//! on a folder whose sign-in is still running, and a failed attempt's folder is deleted only while signed out.
//!
//! Ported from Orca at `0cee6cbd`: `src/main/claude-accounts/claude-sign-in-browser.ts` (the BROWSER helper that writes
//! the link to a file, `isClaudeLocalSignInLink`), `claude-pasted-code-login.ts` (the 10-minute timeout, the code on
//! stdin, "did not accept that code"), `claude-login-session.ts` (no link within 60 s fails the attempt) and
//! `src/main/codex-accounts/codex-login-auth-url.ts` (the marker, the trailing-whitespace rule, host auth.openai.com).
//!
//! Orca: MIT License, Copyright (c) 2026 Lovecast Inc.
//! Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//! documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//! the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//! to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//! copyright notice and this permission notice shall be included in all copies or substantial portions of the
//! Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//! SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//! OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//! DEALINGS IN THE SOFTWARE.
use crate::{
    accounts::{self, Account, Agent, SignedIn, agent_name, variable},
    api::{Reply, Request, Response},
    store,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    fs::{self, File},
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

/// What the page shows for one attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AccountSigninState"))]
pub struct State {
    pub attempt: String,
    pub agent: Agent,
    pub phase: Phase,
    /// The sign-in link, once it passed the allowlist (opened in the browser and offered by Copy link).
    pub link: Option<String>,
    /// The login reads a pasted code (Claude); Codex finishes through its own local callback only.
    pub paste: bool,
    pub reason: Option<Reason>,
    /// The login's exit code, for `Reason::Exited`.
    pub code: Option<i32>,
    /// The account, once signed in (or kept because its state could not be read).
    pub account: Option<Account>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AccountSigninPhase"))]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    Waiting,
    SignedIn,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AccountSigninReason"))]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// Orca's "did not accept that code": the login exited non-zero after a pasted code.
    CodeRejected,
    Exited,
    NoLink,
    BadLink,
    TimedOut,
    /// The login exited 0, but the status command does not say signed in.
    NotSignedIn,
    StartFailed,
    /// Signed-in state unreadable: a new folder is kept (registered), never deleted on a guess.
    Unknown,
    /// The new account's folder is kept, but the account list could not be saved.
    NotSaved,
}

struct Attempt {
    state: State,
    folder: PathBuf,
    stdin: Option<ChildStdin>,
    /// The login's process group while its leader is not yet reaped (so the id cannot have been reused).
    group: Option<i32>,
    /// This attempt made the folder (a new account, registered only once signed in).
    created: bool,
    code_sent: bool,
    cancel: bool,
    ended: Option<Instant>,
}
static ATTEMPTS: Mutex<Option<HashMap<String, Attempt>>> = Mutex::new(None);
const LIVE_AT_ONCE: usize = 4;
/// An ended attempt stays readable this long.
const KEEP_ENDED: Duration = Duration::from_secs(600);
// Orca: allow time to sign in on another device; a link must arrive well before that.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const LINK_WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(100);
const MAX_SCAN: usize = 8_000;
const MAX_LINK: usize = 4_096;
const MAX_CODE: usize = 1_024;
const HELPER: &str = ".nunchiro-sign-in-browser";
// Claude discards BROWSER's stdout, so the helper hands the link over in a file next to itself.
const HELPER_SCRIPT: &str =
    "#!/bin/sh\nprintf '%s' \"$1\" > \"$0.tmp\" && mv \"$0.tmp\" \"$0.link\"\n";
const CODEX_MARKER: &str = "navigate to this url to authenticate:";

/// A test may shorten (never lengthen) a wait through the core's env, as `NUNCHIRO_SETTLE_MS` does.
pub(crate) fn wait(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .map_or(default, |d| d.min(default))
}

fn with<T>(f: impl FnOnce(&mut HashMap<String, Attempt>) -> T) -> Result<T, String> {
    let mut guard = ATTEMPTS.lock().map_err(|_| "sign-in list unavailable")?;
    Ok(f(guard.get_or_insert_with(HashMap::new)))
}

/// F24: sign-ins that have not ended. An unreadable list counts as one, so a swap waits rather than kills a login.
pub(crate) fn running() -> usize {
    with(|all| all.values().filter(|a| a.ended.is_none()).count()).unwrap_or(1)
        + crate::agent_update::running()
        + crate::acp::add::signing_in()
}

/// A sign-in that has not ended runs on `folder` (an account remove waits for it).
pub(crate) fn busy(folder: &Path) -> bool {
    with(|all| {
        all.values()
            .any(|a| a.ended.is_none() && a.folder == folder)
    })
    .unwrap_or(true)
}

/// Owner and window only: `check_agent` refuses every AccountSignIn* request to session callers before this runs.
/// Each request returns at once; the login runs on its own thread.
/// `in_use` says whether a session (live or resumable, a logout tab included) holds an existing account's folder.
pub(crate) fn handle(home: &Path, request: Request, in_use: impl Fn(&Path) -> bool) -> Response {
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    match request {
        Request::AccountSignIn { agent, label, id } => {
            start(&home, agent, &label, id.as_deref(), in_use)
        }
        Request::AccountSignInCode { attempt, code } => paste(&attempt, code),
        Request::AccountSignInCancel { attempt } => with(|all| {
            let a = all.get_mut(&attempt).ok_or("unknown sign-in")?;
            a.cancel = true;
            Ok(Reply::Ack)
        })?,
        Request::AccountSignInState { attempt } => with(|all| {
            all.get(&attempt)
                .map(|a| Reply::AccountSignInState {
                    state: a.state.clone(),
                })
                .ok_or_else(|| "unknown sign-in".to_string())
        })?,
        _ => Err("not a sign-in request".into()),
    }
}

fn start(
    home: &Path,
    agent: Agent,
    label: &str,
    id: Option<&str>,
    in_use: impl Fn(&Path) -> bool,
) -> Response {
    if id == Some(accounts::OWN) {
        return Err(
            "the agent's own account signs in only in a terminal; browser sign-in is for added accounts".into(),
        );
    }
    // Checked and inserted under one lock, so two starts on one account cannot both pass.
    with(|all| {
        all.retain(|_, a| a.ended.is_none_or(|t| t.elapsed() < KEEP_ENDED));
        if all.values().filter(|a| a.ended.is_none()).count() >= LIVE_AT_ONCE {
            return Err(format!("at most {LIVE_AT_ONCE} sign-ins at once"));
        }
        let (account_id, folder, label, created) = match id {
            Some(id) => {
                let (folder, label) = accounts::by_id(home, agent, id)?;
                // A logout or agent on the folder would race the new login (a remove's Move would trash it).
                if in_use(&folder) {
                    return Err(format!(
                        "account {label:?} is in use; close its sessions first"
                    ));
                }
                (id.to_string(), folder, label, false)
            }
            None => {
                accounts::check_label(label)?;
                if all.values().any(|a| {
                    a.ended.is_none()
                        && a.state.agent == agent
                        && a.state.account.as_ref().is_some_and(|x| x.label == label)
                }) {
                    return Err(format!("{label:?} is already signing in"));
                }
                let pending = all
                    .values()
                    .filter(|a| a.ended.is_none() && a.created)
                    .count();
                let (id, folder) = accounts::fresh(home, agent, label, pending)?;
                (id, folder, label.to_string(), true)
            }
        };
        if all
            .values()
            .any(|a| a.ended.is_none() && a.folder == folder)
        {
            return Err(format!("{label:?} is already signing in"));
        }
        let attempt = store::new_id()?;
        all.insert(
            attempt.clone(),
            Attempt {
                state: State {
                    attempt: attempt.clone(),
                    agent,
                    phase: Phase::Starting,
                    link: None,
                    paste: agent == Agent::Claude,
                    reason: None,
                    code: None,
                    // The name the attempt signs in; `signed_in` stays No until the status command says otherwise.
                    account: Some(Account {
                        agent,
                        id: account_id.clone(),
                        label: label.clone(),
                        folder: folder.clone(),
                        signed_in: SignedIn::No,
                        default: false,
                        session_default: false,
                        fell_back: false,
                        checking: false,
                        plan: None,
                    }),
                },
                folder: folder.clone(),
                stdin: None,
                group: None,
                created,
                code_sent: false,
                cancel: false,
                ended: None,
            },
        );
        let (owned, key, rollback) = (
            home.to_path_buf(),
            attempt.clone(),
            created.then(|| account_id.clone()),
        );
        // `thread::spawn` would panic under this lock and poison it: every folder busy, every swap waiting.
        if let Err(e) =
            spawn(move || run(&owned, &key, agent, &folder, &account_id, &label, created))
        {
            all.remove(&attempt);
            if let Some(id) = rollback {
                let _ = accounts::discard(home, agent, &id);
            }
            return Err(format!("could not start the sign-in: {e}"));
        }
        Ok(Reply::AccountSignInStarted { attempt })
    })?
}

/// The sign-in thread; a test makes the OS refuse it (Q9 psn-J11-1).
fn spawn(f: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
    #[cfg(test)]
    if REFUSE_SPAWN.take() {
        return Err(std::io::Error::other("refused by the test"));
    }
    thread::Builder::new().spawn(f).map(drop)
}
#[cfg(test)]
thread_local! {
    static REFUSE_SPAWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The pasted code goes to the login's stdin and nowhere else; `code` is dropped on return.
fn paste(attempt: &str, code: String) -> Response {
    // A code is one line of visible ASCII: no newline can add a second answer.
    if code.is_empty() || code.len() > MAX_CODE || !code.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("that does not look like a sign-in code".into());
    }
    with(|all| {
        let a = all.get_mut(attempt).ok_or("unknown sign-in")?;
        if a.state.phase != Phase::Waiting || !a.state.paste {
            return Err("this sign-in does not take a code now".to_string());
        }
        // One code per attempt (Orca's flow too): a second write could block on a pipe the login no longer reads,
        // and this runs under the core's locks.
        if a.code_sent {
            return Err("a code was already sent; start the sign-in again".to_string());
        }
        let stdin = a.stdin.as_mut().ok_or("the login no longer reads a code")?;
        let mut line = code.into_bytes();
        line.push(b'\n');
        let sent = stdin.write_all(&line).and_then(|()| stdin.flush());
        // shortcut: clears this copy only; the request's own buffers in the transport are freed, not cleared.
        line.fill(0);
        sent.map_err(|_| "the login no longer reads a code".to_string())?;
        a.code_sent = true;
        Ok(Reply::Ack)
    })?
}

enum End {
    Exited(Option<i32>),
    Cancelled,
    TimedOut,
    NoLink,
    BadLink,
    StartFailed,
}

fn run(home: &Path, key: &str, agent: Agent, folder: &Path, id: &str, label: &str, created: bool) {
    let end = login(home, key, agent, folder);
    if agent == Agent::Claude {
        let helper = folder.join(HELPER);
        for path in helper_files(&helper) {
            let _ = fs::remove_file(path);
        }
    }
    let code_sent = with(|all| {
        all.get_mut(key).map(|a| {
            a.stdin = None;
            a.code_sent
        })
    })
    .ok()
    .flatten()
    .unwrap_or(false);
    // Orca's lesson: a login killed after it signed in still signed in; only the status command decides.
    let signed = match end {
        End::StartFailed => SignedIn::No,
        _ => accounts::probe(agent, Some(folder)),
    };
    let row = |signed_in| Account {
        agent,
        id: id.into(),
        label: label.into(),
        folder: folder.into(),
        signed_in,
        default: false,
        session_default: false,
        fell_back: false,
        checking: false,
        plan: None,
    };
    let mut saved = true;
    let account = match (created, signed) {
        (true, SignedIn::No) => {
            if let Err(e) = accounts::discard(home, agent, id) {
                eprintln!("sign-in rollback failed: {e}");
            }
            None
        }
        (true, state) => accounts::enroll(home, agent, id, label, state)
            .inspect_err(|e| {
                saved = false;
                eprintln!("sign-in could not register the account: {e}");
            })
            .ok(),
        (false, state) => Some(row(state)),
    };
    let (phase, reason, code) = match (signed, end) {
        _ if !saved => (Phase::Failed, Some(Reason::NotSaved), None),
        (SignedIn::Yes, _) => (Phase::SignedIn, None, None),
        (_, End::Cancelled) => (Phase::Cancelled, None, None),
        (SignedIn::Unknown, _) => (Phase::Failed, Some(Reason::Unknown), None),
        (_, End::Exited(Some(0))) => (Phase::Failed, Some(Reason::NotSignedIn), None),
        (_, End::Exited(_)) if code_sent => (Phase::Failed, Some(Reason::CodeRejected), None),
        (_, End::Exited(c)) => (Phase::Failed, Some(Reason::Exited), c),
        (_, End::TimedOut) => (Phase::Failed, Some(Reason::TimedOut), None),
        (_, End::NoLink) => (Phase::Failed, Some(Reason::NoLink), None),
        (_, End::BadLink) => (Phase::Failed, Some(Reason::BadLink), None),
        (_, End::StartFailed) => (Phase::Failed, Some(Reason::StartFailed), None),
    };
    let _ = with(|all| {
        if let Some(a) = all.get_mut(key) {
            a.state.phase = phase;
            a.state.reason = reason;
            a.state.code = code;
            a.state.account = account;
            a.ended = Some(Instant::now());
        }
    });
}

/// The helper and the two files it writes beside itself.
fn helper_files(helper: &Path) -> [PathBuf; 3] {
    [
        helper.to_path_buf(),
        suffixed(helper, ".link"),
        suffixed(helper, ".tmp"),
    ]
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    s.into()
}

/// Runs the login until it exits, is cancelled or times out; the process group it started is killed on every other
/// way out, so no login, helper or local callback server stays behind.
fn login(home: &Path, key: &str, agent: Agent, folder: &Path) -> End {
    let helper = folder.join(HELPER);
    let mut command = crate::process::command(agent_name(agent));
    command.args(match agent {
        Agent::Claude => ["auth", "login", "--claudeai"].as_slice(),
        Agent::Codex => ["login"].as_slice(),
    });
    // The env a login tab gets (the core's, minus the launching session's identity, every account override and key),
    // then only this folder.
    for (k, _) in std::env::vars_os().filter(|(k, _)| crate::sessions::is_parent_session_env(k)) {
        command.env_remove(k);
    }
    for k in crate::sessions::ACCOUNT_ENV.iter().chain(&[
        "NUNCHIRO_TOKEN",
        "NUNCHIRO_SESSION",
        "BROWSER",
    ]) {
        command.env_remove(k);
    }
    command.env(variable(agent), folder);
    if agent == Agent::Claude {
        if prepare_helper(&helper).is_err() {
            return End::StartFailed;
        }
        command.env("BROWSER", &helper);
    }
    command
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let Ok(child) = command.spawn() else {
        return End::StartFailed;
    };
    let record = record(home, child.id() as i32);
    let end = watch(key, agent, &helper, child);
    if let Some(record) = record {
        record.remove();
    }
    end
}

/// The rest of `login`, from a spawned child until it is reaped.
fn watch(key: &str, agent: Agent, helper: &Path, mut child: Child) -> End {
    let scan = Arc::new(Mutex::new(String::new()));
    for out in [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let scan = scan.clone();
        thread::spawn(move || drain(out, &scan));
    }
    let _ = with(|all| {
        if let Some(a) = all.get_mut(key) {
            a.stdin = child.stdin.take();
            a.group = Some(child.id() as i32);
            // A stop that ran before the group was known could not kill it: do it here.
            if a.cancel {
                unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
            }
        }
    });
    let started = Instant::now();
    let (timeout, link_wait) = (
        wait("NUNCHIRO_SIGNIN_TIMEOUT_MS", LOGIN_TIMEOUT),
        wait("NUNCHIRO_SIGNIN_LINK_MS", LINK_WAIT),
    );
    let mut linked = false;
    loop {
        if exited(&child) {
            // The leader is a zombie until reaped, so its group id cannot be reused yet: anything it left running
            // (a callback server) goes with it.
            unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
            return End::Exited(reap(key, &mut child));
        }
        let cancel = with(|all| all.get(key).is_none_or(|a| a.cancel)).unwrap_or(true);
        if cancel {
            return stop(key, &mut child, End::Cancelled);
        }
        if started.elapsed() >= timeout {
            return stop(key, &mut child, End::TimedOut);
        }
        if !linked {
            let found = match agent {
                Agent::Claude => helper_link(&suffixed(helper, ".link")),
                Agent::Codex => scan.lock().ok().and_then(|s| codex_link(&s)),
            };
            match found {
                Some(link) if allowed(agent, &link) => {
                    linked = true;
                    let _ = with(|all| {
                        if let Some(a) = all.get_mut(key) {
                            a.state.link = Some(link.clone());
                            a.state.phase = Phase::Waiting;
                        }
                    });
                    open(link);
                }
                Some(_) => return stop(key, &mut child, End::BadLink),
                None if started.elapsed() >= link_wait => {
                    return stop(key, &mut child, End::NoLink);
                }
                None => {}
            }
        }
        thread::sleep(POLL);
    }
}

/// The child has exited, checked without reaping it (`WNOWAIT`).
pub(crate) fn exited(child: &Child) -> bool {
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

fn stop(key: &str, child: &mut Child, end: End) -> End {
    // The group this login leads (`process_group(0)`): only what it started.
    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    reap(key, child);
    end
}

/// Forgets the group under the lock, then reaps the leader: `stop_all` never signals a reaped (reusable) id.
fn reap(key: &str, child: &mut Child) -> Option<i32> {
    let _ = with(|all| all.get_mut(key).map(|a| a.group = None));
    child.wait().ok().and_then(|s| s.code())
}

/// The longest `stop_all` waits for the attempts to finish: one status probe (5 s) plus the registry write.
const STOP_WAIT: Duration = Duration::from_secs(8);

/// Round 2: the core is stopping, so every running login and what it started (a Codex callback server on port 1455)
/// goes now. The attempt threads then finish as usual (status probe, then register or roll back): a login that signed
/// in just before the stop is registered, never left as an unlisted folder holding its login.
pub(crate) fn stop_all() {
    crate::agent_update::stop_all(); // ticket 358: no updater outlives the core
    crate::acp::add::stop_sign_ins(); // ticket 358: nor an ACP agent signing in
    let _ = with(|all| {
        for a in all.values_mut() {
            a.cancel = true;
            if let Some(group) = a.group.take() {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
    });
    // shortcut: bounded; a probe that hangs past STOP_WAIT leaves its new folder unregistered (logged by nobody).
    let until = Instant::now() + STOP_WAIT;
    while Instant::now() < until
        && with(|all| all.values().any(|a| a.ended.is_none())).unwrap_or(false)
    {
        thread::sleep(POLL);
    }
}

/// Where a core records each running login's group (`<pgid>` holding the leader's start time), so the next core
/// can end a group a crashed core left behind (as `sandbox::sweep` does for runs). Tool updates (ticket 358) record here too.
const RECORDS: &str = ".signin-logins";

/// The records folder, held by one descriptor: created 0700 if missing, opened without following a link, owned by this
/// user, mode fixed to 0700. Every later step goes through this descriptor, so a same-user process that swaps the
/// folder for a link afterwards changes nothing here. A link at the folder's own name is removed (the link only, never
/// its target) and the folder recreated.
fn open_records(home: &Path) -> Option<File> {
    let dir = home.join(RECORDS);
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        let _ = fs::remove_file(&dir);
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .ok()?;
    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::open(path.as_ptr(), flags) };
    if fd < 0 {
        return None; // a link or a non-folder swapped in at the name
    }
    let dir = unsafe { File::from_raw_fd(fd) };
    let meta = dir.metadata().ok()?; // fstat on the held descriptor
    if !trusted_dir(meta.is_dir(), meta.uid(), unsafe { libc::geteuid() }) {
        return None; // a foreign folder: this login goes unrecorded, nothing is written through it
    }
    if meta.permissions().mode() & 0o777 != 0o700 {
        dir.set_permissions(fs::Permissions::from_mode(0o700))
            .ok()?; // fchmod
    }
    Some(dir)
}

/// True only for a folder owned by `me`: the records folder is never trusted when another user owns it.
fn trusted_dir(is_dir: bool, owner: u32, me: u32) -> bool {
    is_dir && owner == me
}

/// `name` in the held folder `dir`, opened with `flags` (always `O_NOFOLLOW | O_CLOEXEC`), never through a link.
fn open_at(dir: &File, name: &CStr, flags: libc::c_int) -> Option<File> {
    let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600 as libc::c_uint) };
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

/// Removes `name` itself from the held folder: a planted link goes, its target stays.
fn unlink_at(dir: &File, name: &CStr) {
    unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
}

/// A written record: the held folder and the record's name, so removing it is one `unlinkat`.
pub(crate) struct Record {
    dir: File,
    name: CString,
}

impl Record {
    pub(crate) fn remove(self) {
        unlink_at(&self.dir, &self.name);
    }
}

pub(crate) fn record(home: &Path, pgid: i32) -> Option<Record> {
    record_in(&open_records(home)?, pgid)
}

fn record_in(dir: &File, pgid: i32) -> Option<Record> {
    let (s, u) = crate::sandbox::group_start(pgid)?;
    let name = CString::new(pgid.to_string()).ok()?;
    unlink_at(dir, &name); // a file or link already at the name goes; a folder there makes the create fail
    open_at(dir, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?
        .write_all(format!("{s}.{u}").as_bytes())
        .ok()?;
    Some(Record {
        dir: dir.try_clone().ok()?, // dup with close-on-exec
        name,
    })
}

/// The longest record a core writes is two u64s and a dot (41 bytes); anything longer is not ours.
const MAX_RECORD: u64 = 64;

/// At core start: kill each login group a dead core at `home` recorded whose leader is still that process (same
/// start time, so a reused pid is never signalled), and drop every record.
pub(crate) fn sweep(home: &Path) {
    if fs::symlink_metadata(home.join(RECORDS)).is_err() {
        return; // nothing recorded: a sweep never creates the folder
    }
    if let Some(dir) = open_records(home) {
        sweep_in(&dir);
    }
}

fn sweep_in(dir: &File) {
    for name in names(dir) {
        // Digits only: a name that is anything else is removed below, never parsed into a pid.
        let pgid = name
            .to_str()
            .ok()
            .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|n| n.parse::<i32>().ok());
        let start = pgid.and(read_record(dir, &name)).and_then(|t| {
            let (s, u) = t.trim().split_once('.')?;
            Some((s.parse::<u64>().ok()?, u.parse::<u64>().ok()?))
        });
        if let (Some(pgid), Some(start)) = (pgid, start)
            && pgid > 1
            && crate::sandbox::group_start(pgid) == Some(start)
        {
            // shortcut: one group SIGKILL; a member whose leader already died is missed (sandbox's kill_group
            // retries by member), upgrade if a login's leader is seen exiting before its children.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
        unlink_at(dir, &name);
    }
}

/// The most entries one listing returns.
// shortcut: the rest stays for the next sweep (it runs at each core start); upgrade if a login ever leaves more
// than 4096 records.
const MAX_NAMES: usize = 4096;

/// Up to `MAX_NAMES` entry names in the held folder (not `.` and `..`), listed through a duplicate of its descriptor.
fn names(dir: &File) -> Vec<CString> {
    let Ok(dup) = dir.try_clone() else {
        return vec![];
    };
    let fd = dup.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return vec![];
    }
    unsafe { libc::rewinddir(stream) }; // the dup shares the offset of `dir`
    let mut out = vec![];
    while out.len() < MAX_NAMES {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            out.push(name.to_owned());
        }
    }
    unsafe { libc::closedir(stream) };
    out
}

/// A record's text: a plain file (never through a link) of at most `MAX_RECORD` bytes of UTF-8, else None.
fn read_record(dir: &File, name: &CStr) -> Option<String> {
    let file = open_at(dir, name, libc::O_RDONLY | libc::O_NONBLOCK)?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_RECORD {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Keeps the last `MAX_SCAN` bytes of output for the link search; nothing is logged or kept after the attempt.
pub(crate) fn drain(mut out: Box<dyn Read + Send>, scan: &Mutex<String>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = out.read(&mut buf) {
        if n == 0 {
            break;
        }
        if let Ok(mut s) = scan.lock() {
            s.push_str(&String::from_utf8_lossy(&buf[..n]));
            if s.len() > MAX_SCAN {
                let mut cut = s.len() - MAX_SCAN;
                while !s.is_char_boundary(cut) {
                    cut += 1;
                }
                s.drain(..cut);
            }
        }
    }
}

/// The BROWSER helper, new (never through a planted name) and 0700, inside the 0700 account folder.
fn prepare_helper(helper: &Path) -> std::io::Result<()> {
    for path in helper_files(helper) {
        match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(libc::O_NOFOLLOW)
        .open(helper)?
        .write_all(HELPER_SCRIPT.as_bytes())
}

fn helper_link(path: &Path) -> Option<String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return Some(String::new()); // anything there but a plain file fails the attempt
    }
    let mut text = String::new();
    file.take(MAX_LINK as u64 + 1)
        .read_to_string(&mut text)
        .ok()?;
    Some(
        text.trim_matches(|c: char| c.is_ascii_whitespace())
            .to_string(),
    )
}

/// Opens the link in the default browser; nothing of its output is read.
fn open(link: String) {
    if let Some(recorded) = crate::opener::recorded(std::slice::from_ref(&link)) {
        if let Err(e) = recorded {
            eprintln!("sign-in: {e}");
        }
        return;
    }
    thread::spawn(move || {
        let mut command = crate::process::command("open");
        command.arg(&link).stdin(Stdio::null());
        if let Err(e) = crate::process::output(command, Duration::from_secs(10)) {
            eprintln!("sign-in: could not open the browser: {e}");
        }
    });
}

/// The one gate for every link opened or offered: Claude's local sign-in link (https claude.ai or claude.com with a
/// localhost or 127.0.0.1 redirect, Orca `isClaudeLocalSignInLink`) or Codex's (https auth.openai.com). Visible ASCII
/// only, no user part, no port, exact lower-case hosts.
pub(crate) fn allowed(agent: Agent, link: &str) -> bool {
    let Some((host, rest)) = split(link, "https://") else {
        return false;
    };
    match agent {
        Agent::Codex => host == "auth.openai.com" && path(rest) == "/oauth/authorize",
        Agent::Claude => {
            matches!(host, "claude.ai" | "claude.com")
                && matches!(path(rest), "/oauth/authorize" | "/cai/oauth/authorize")
                && param(rest, "redirect_uri").is_some_and(|r| {
                    split(&r, "http://").is_some_and(|(h, _)| {
                        let name = h.rsplit_once(':').map_or(h, |(name, port)| {
                            if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
                                name
                            } else {
                                h
                            }
                        });
                        matches!(name, "localhost" | "127.0.0.1")
                    })
                })
        }
    }
}

/// Ticket 358: an ACP agent's sign-in link. The host is that agent's own, so what holds is the rest of the gate above: https,
/// visible ASCII, no user part, no port, and an exact lower-case dotted name (never an address or `localhost`).
pub(crate) fn allowed_acp(link: &str) -> bool {
    split(link, "https://").is_some_and(|(host, rest)| {
        !rest.contains('\\')
            && host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
            && host.split_once('.').is_some()
            && host
                .rsplit('.')
                .next()
                .is_some_and(|top| !top.is_empty() && top.bytes().all(|b| b.is_ascii_lowercase()))
    })
}

/// The path part of `rest` (before the query or fragment).
fn path(rest: &str) -> &str {
    rest.split(['?', '#']).next().unwrap_or("")
}

/// (authority, rest) of `link` under `scheme`, when the link is visible ASCII and the authority has no user part.
fn split<'a>(link: &'a str, scheme: &str) -> Option<(&'a str, &'a str)> {
    if link.len() > MAX_LINK || !link.bytes().all(|b| b.is_ascii_graphic()) {
        return None;
    }
    let rest = link.strip_prefix(scheme)?;
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(end);
    (!host.is_empty() && !host.contains('@')).then_some((host, tail))
}

/// The one value of query parameter `name`, percent-decoded; none when absent, repeated or not valid UTF-8.
fn param(rest: &str, name: &str) -> Option<String> {
    let query = rest.split_once('?')?.1;
    let query = query.split('#').next().unwrap_or("");
    let mut value = None;
    for (k, v) in query.split('&').filter_map(|kv| kv.split_once('=')) {
        // Keys compare decoded, so `redirect%5Furi` is the same key as the server would read it.
        if decode(k).as_deref() != Some(name) {
            continue;
        }
        if value.replace(v).is_some() {
            return None;
        }
    }
    decode(value?)
}

/// Percent-decoding; none for a bad escape or bytes that are not UTF-8.
fn decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Orca `parseCodexLoginAuthUrl`: the first https link after the marker, once whitespace follows it (a chunk cut
/// mid-link waits), trailing punctuation dropped. Escape sequences are removed first.
pub(crate) fn codex_link(output: &str) -> Option<String> {
    let plain = strip_ansi(output);
    let at = plain.to_ascii_lowercase().find(CODEX_MARKER)?;
    let after = &plain[at + CODEX_MARKER.len()..];
    let start = after.find("https://")?;
    let tail = &after[start..];
    let end = tail.find(|c: char| c.is_whitespace())?;
    Some(
        tail[..end]
            .trim_end_matches(['.', ',', ';', ':', ')', ']'])
            .to_string(),
    )
}

/// Drops CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL|ST`) sequences and any other lone ESC pair.
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    // Threat 2: only the two link shapes pass; look-alikes, other schemes, user parts, ports and bytes do not.
    #[test]
    fn signin_link_allowlist() {
        let local = "https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=x";
        assert!(allowed(Agent::Claude, local));
        assert!(allowed(
            Agent::Claude,
            "https://claude.com/cai/oauth/authorize?redirect_uri=http://127.0.0.1:9/callback"
        ));
        assert!(allowed(
            Agent::Codex,
            "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
        ));
        for bad in [
            local.replacen("https", "http", 1),
            local.replacen("claude.ai", "claude.ai.evil.com", 1),
            local.replacen("claude.ai", "evilclaude.ai", 1),
            local.replacen("claude.ai", "CLAUDE.AI", 1),
            local.replacen("claude.ai", "claude.ai:8443", 1),
            local.replacen("claude.ai", "claude.ai@evil.com", 1),
            local.replacen("claude.ai", "evil.com\\@claude.ai", 1),
            local.replacen("localhost", "localhost.evil.com", 1),
            local.replacen("http%3A", "https%3A", 1),
            // The platform's pasted-code page is not a local redirect.
            local.replacen(
                "http%3A%2F%2Flocalhost%3A54545%2Fcallback",
                "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
                1,
            ),
            format!("{local}&redirect_uri=https%3A%2F%2Fevil.com"),
            // A key spelled with an escape still counts as the same key.
            format!("{local}&redirect%5Furi=https%3A%2F%2Fevil.com"),
            // An allowed host with any other path (round 2: exact authorize paths only).
            local.replacen("/oauth/authorize", "/logout", 1),
            local.replacen("/oauth/authorize", "/oauth/authorize/x", 1),
            local.replacen("/oauth/authorize", "/OAUTH/authorize", 1),
            local.replacen("/oauth/authorize", "", 1),
            "https://claude.ai/oauth/authorize".into(),
            "file:///etc/passwd".into(),
            "javascript:alert(1)".into(),
            format!("{local} x"),
            format!("{local}\u{7}"),
            format!("{local}\u{202e}"),
            format!("{local}\n"),
        ] {
            assert!(!allowed(Agent::Claude, &bad), "{bad:?}");
        }
        for bad in [
            "https://auth.openai.com.evil.com/x",
            "http://auth.openai.com/x",
            "https://openai.com/x",
            "https://user@auth.openai.com/x",
            "https://auth.openai.com/x",
            "https://auth.openai.com/oauth/authorize/../token",
        ] {
            assert!(!allowed(Agent::Codex, bad), "{bad}");
        }
        // A Claude link is never a Codex link, nor the other way round.
        assert!(!allowed(Agent::Codex, local));
        assert!(!allowed(
            Agent::Claude,
            "https://auth.openai.com/oauth/authorize?redirect_uri=http://localhost:1/"
        ));
    }
    #[test]
    fn codex_link_after_marker_once_complete() {
        let url = "https://auth.openai.com/oauth/authorize?client_id=app&state=s";
        let out = format!(
            "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n\u{1b}[94m{url}\u{1b}[0m\n"
        );
        assert_eq!(codex_link(&out).as_deref(), Some(url));
        // Split across chunks: no whitespace after the link yet, so nothing is published.
        let cut = format!("Navigate to this URL to authenticate:\n{}", &url[..30]);
        assert_eq!(codex_link(&cut), None);
        // An update or docs link before the marker is never offered.
        assert_eq!(
            codex_link("see https://github.com/openai/codex/releases \n"),
            None
        );
        assert_eq!(
            codex_link(&format!("navigate to this url to authenticate: {url}). \n")).as_deref(),
            Some(url)
        );
    }

    // V2.5-46: the records folder is held by descriptor, so a swap after it was opened changes nothing.
    fn scratch(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("signin-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }
    /// A process leading its own group, as a login does; killed on drop.
    struct Leader(Child);
    impl Leader {
        fn new() -> Self {
            Self(
                Command::new("/bin/sleep")
                    .arg("600")
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            )
        }
        fn pid(&self) -> i32 {
            self.0.id() as i32
        }
        fn start(&self) -> String {
            let (s, u) = crate::sandbox::group_start(self.pid()).unwrap();
            format!("{s}.{u}")
        }
        fn alive(&mut self) -> bool {
            self.0.try_wait().unwrap().is_none()
        }
    }
    impl Drop for Leader {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    /// The folder renamed to `moved` and a link to `outside` put at its name, as a same-user attacker would.
    fn swap(root: &Path, outside: &Path) -> PathBuf {
        let moved = root.join("moved");
        fs::rename(root.join(RECORDS), &moved).unwrap();
        std::os::unix::fs::symlink(outside, root.join(RECORDS)).unwrap();
        moved
    }
    // Q9 psn-J11-1: the OS refuses the sign-in thread. The start says so, no attempt stays, the folder it made is gone,
    // and the list still answers: a panic under its lock once poisoned it (every folder busy, every swap waiting).
    #[test]
    fn a_refused_sign_in_thread_leaves_the_list_usable() {
        let home = scratch("refused-thread");
        for _ in 0..2 {
            REFUSE_SPAWN.set(true);
            let err = start(&home, Agent::Claude, "Refused", None, |_| false).unwrap_err();
            assert!(err.starts_with("could not start the sign-in"), "{err}");
        }
        assert!(!ATTEMPTS.is_poisoned());
        let left = with(|all| all.values().filter(|a| a.folder.starts_with(&home)).count());
        assert_eq!(left, Ok(0));
        assert_eq!(
            fs::read_dir(home.join("accounts/claude")).unwrap().count(),
            0
        );
        assert!(!busy(&home.join("accounts/claude/any")));
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn record_survives_folder_swap() {
        let root = scratch("rec-swap");
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        let dir = open_records(&root).unwrap();
        // Threat 4: the held descriptor is not inherited by a login child.
        assert_ne!(
            unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        let moved = swap(&root, &outside);
        let login = Leader::new();
        let record = record_in(&dir, login.pid()).expect("recorded");
        assert_ne!(
            unsafe { libc::fcntl(record.dir.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        let file = moved.join(login.pid().to_string());
        let meta = fs::symlink_metadata(&file).expect("record in the original folder");
        assert!(meta.file_type().is_file());
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::read_dir(&outside).unwrap().count(),
            0,
            "written through the link"
        );
        record.remove();
        assert!(!file.exists());
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn sweep_survives_folder_swap() {
        let root = scratch("sweep-swap");
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        let dir = open_records(&root).unwrap();
        let (mut first, mut second, mut stale) = (Leader::new(), Leader::new(), Leader::new());
        let records = root.join(RECORDS);
        fs::write(records.join(first.pid().to_string()), first.start()).unwrap();
        // Threat 2: a record whose start time does not match is dropped without a signal.
        fs::write(records.join(stale.pid().to_string()), "1.0").unwrap();
        fs::write(outside.join(second.pid().to_string()), second.start()).unwrap();
        let moved = swap(&root, &outside);
        sweep_in(&dir);
        let until = Instant::now() + Duration::from_secs(5);
        while first.alive() {
            assert!(Instant::now() < until, "the recorded login was not ended");
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(300));
        assert!(
            second.alive(),
            "a process named through the link was signalled"
        );
        assert!(stale.alive(), "a mismatching record was acted on");
        assert!(
            outside.join(second.pid().to_string()).exists(),
            "the link target's record was deleted"
        );
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0, "records kept");
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn record_replaces_planted_link_at_known_pgid() {
        let root = scratch("plant");
        let dir = open_records(&root).unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, "keep").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o644)).unwrap();
        let login = Leader::new();
        let planted = root.join(RECORDS).join(login.pid().to_string());
        std::os::unix::fs::symlink(&outside, &planted).unwrap();
        let record = record_in(&dir, login.pid()).expect("recorded");
        let meta = fs::symlink_metadata(&planted).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
        record.remove();
        fs::remove_dir_all(&root).unwrap();
    }
    // Threat 3 and 5: a FIFO and a non-numeric name in the folder are removed, never opened blocking or parsed.
    #[test]
    fn sweep_removes_fifo_and_hostile_names() {
        let root = scratch("hostile");
        let dir = open_records(&root).unwrap();
        let records = root.join(RECORDS);
        let fifo = CString::new(records.join("4242").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        for name in ["+7", "..x", "notes.txt", "9999999999999"] {
            fs::write(records.join(name), "1.0").unwrap();
        }
        sweep_in(&dir);
        assert_eq!(fs::read_dir(&records).unwrap().count(), 0);
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn open_records_replaces_a_link_and_fixes_mode() {
        let root = scratch("open");
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join(RECORDS)).unwrap();
        assert!(open_records(&root).is_some());
        let meta = fs::symlink_metadata(root.join(RECORDS)).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert!(outside.join("keep").exists());
        fs::set_permissions(root.join(RECORDS), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(open_records(&root).is_some());
        assert_eq!(
            fs::metadata(root.join(RECORDS))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(&root).unwrap();
    }
    // V2.5-46 followup: the foreign-owner refusal as a predicate (a `noowners` volume cannot host a real foreign folder).
    #[test]
    fn trusted_dir_refuses_other_owner() {
        let me = unsafe { libc::geteuid() };
        assert!(!trusted_dir(true, me + 1, me));
        assert!(trusted_dir(true, me, me));
        assert!(!trusted_dir(false, me, me));
    }
    // Threat 2: a folder holding more than MAX_NAMES entries is listed only up to the cap.
    #[test]
    fn names_stops_at_the_cap() {
        let root = scratch("cap");
        let dir = open_records(&root).unwrap();
        let records = root.join(RECORDS);
        for i in 0..3 {
            fs::write(records.join(format!("f{i}")), "").unwrap();
        }
        assert_eq!(names(&dir).len(), 3, "`.` and `..` must be skipped");
        for i in 3..MAX_NAMES + 10 {
            fs::write(records.join(format!("f{i}")), "").unwrap();
        }
        assert_eq!(names(&dir).len(), MAX_NAMES);
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn sweep_removes_up_to_the_cap() {
        let root = scratch("capsweep");
        let dir = open_records(&root).unwrap();
        let records = root.join(RECORDS);
        for i in 0..MAX_NAMES + 10 {
            fs::write(records.join(format!("stale{i}")), "1.0").unwrap();
        }
        sweep_in(&dir);
        assert_eq!(fs::read_dir(&records).unwrap().count(), 10);
        sweep_in(&dir);
        assert_eq!(fs::read_dir(&records).unwrap().count(), 0);
        fs::remove_dir_all(&root).unwrap();
    }
}
