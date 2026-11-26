//! V2-12m-a: one Nunchiro-owned OpenSSH ControlMaster per machine alias. Its session runs
//! `nunchiro machine relay --stream`, which pushes the remote core's rows whenever they change; one-shot
//! requests ride the same master through `ControlPath`. Every relay line is untrusted data: it can only
//! replace the cached rows of its own alias, never answer or approve anything here.
use crate::{api::Session, sessions::Sessions, store};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs,
    io::Read,
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// The relay wire version. 1 was the v1a one-shot relay (exact package version). Bump it whenever the relay wire
/// changes; a newer local core then still accepts a remote one step behind.
pub const PROTOCOL: u32 = 2;
pub fn accepts(remote: u32) -> bool {
    remote == PROTOCOL || remote == PROTOCOL - 1
}
/// The relay's side of the same window: the newer local core decides, so a relay takes its own protocol and the next.
/// What sshd sets for every login and its children.
const SSH_LOGIN_ENV: [&str; 3] = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];
/// This process runs inside an SSH login.
pub fn ssh_login() -> bool {
    SSH_LOGIN_ENV.iter().any(|k| std::env::var_os(k).is_some())
}
/// Whether the session a core is born in matters for `home`: on macOS, where it decides if the login keychain can be
/// read. A run told which keychain to use (`NUNCHIRO_KEYCHAIN`: every test and scenario, through cargo's and the
/// scenarios' environment) is left out, and so is a home under the temp folder (a test binary started by hand), as
/// neither gets a login keychain item (`start_secrets`): a test run inside an SSH login starts its cores as everywhere
/// else. A fixture that names its `launchctl` opts in.
pub fn login_session_matters(home: &Path) -> bool {
    cfg!(target_os = "macos")
        && (std::env::var_os("NUNCHIRO_LAUNCHCTL").is_some()
            || std::env::var_os("NUNCHIRO_KEYCHAIN").is_none()
                && !crate::start_secrets::temp_home(home))
}
/// The core of `home` was started inside an SSH login (its start record keeps its environment): it lives in that
/// login's security session, where the login keychain cannot be read, and so does every agent it starts.
pub fn core_in_ssh_login(home: &Path) -> bool {
    login_session_matters(home)
        && crate::start_secrets::read_record(&home.join("core.start.json"))
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|v| SSH_LOGIN_ENV.iter().any(|k| v["env"][k].is_string()))
}
/// What the driving machine says for a remote core that `core_in_ssh_login`.
fn ssh_login_note(alias: &str) -> String {
    format!(
        "{alias}: agents there may not be signed in. Nunchiro on that Mac was started inside an SSH login, where the \
         login keychain cannot be read. Log in at that Mac's screen, then run `nunchiro --machine {alias} serve \
         restart` and start its sessions again."
    )
}
pub fn relay_accepts(local: u32) -> bool {
    local == PROTOCOL || local == PROTOCOL + 1
}
/// V2-12m-a r3: an answered item stays hidden while its answer is on the way, and through one push after it landed
/// (built before the remote applied it). A second push that still lists it shows it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    Sending,
    Sent,
    Seen,
}
// The v1a relay's reply to `relay --stream`: it has no channel, so it says no hello.
const V1A_RELAY: &str = "use nunchiro machine status";
// Like the one-shot reply cap.
const LINE_MAX: usize = 8 * 1024 * 1024;
// ConnectTimeout plus the remote login shell.
const HELLO_WAIT: Duration = Duration::from_secs(10);
const BACKOFF_SECS: [u64; 6] = [1, 2, 4, 8, 16, 30];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelState {
    Connecting,
    Up,
    Reconnecting,
    Down,
    VersionMismatch,
}
/// What V2-12m-b's Machines page reads: the connection state and since when, and the remote's protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub state: ChannelState,
    pub since_ms: u64,
    /// Why the channel is not up; while it is up, what the owner must do on that machine (`ssh_login_note`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub local_protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_protocol: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_version: Option<String>,
    /// Milliseconds from starting ssh to the relay hello: the one-shot status time of the last connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    // The control socket's name in `mux/`.
    #[serde(skip)]
    pub slot: usize,
}
impl Channel {
    fn new(slot: usize) -> Self {
        Self {
            slot,
            state: ChannelState::Connecting,
            since_ms: crate::queue::now_ms(),
            error: None,
            local_protocol: PROTOCOL,
            remote_protocol: None,
            remote_version: None,
            latency_ms: None,
        }
    }
}

/// The folder must be a real folder of this user with mode 0700; anything else is refused, never repaired, so no
/// other local user can reach a master through it.
pub fn private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let shown = dir.display();
    if let Err(e) = fs::symlink_metadata(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("ssh control folder {shown}: {e}"));
        }
        fs::DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .or_else(|e| {
                (e.kind() == std::io::ErrorKind::AlreadyExists)
                    .then_some(())
                    .ok_or(e)
            })
            .map_err(|e| format!("ssh control folder {shown}: {e}"))?;
    }
    let meta = fs::symlink_metadata(dir).map_err(|e| format!("ssh control folder {shown}: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err(format!(
            "ssh control folder {shown} is not a plain folder; refused"
        ));
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!(
            "ssh control folder {shown} is owned by another user; refused"
        ));
    }
    if meta.mode() & 0o777 != 0o700 {
        return Err(format!(
            "ssh control folder {shown} has mode {:o}, not 0700; refused",
            meta.mode() & 0o777
        ));
    }
    Ok(())
}
/// `<NUNCHIRO_HOME>/mux/<slot>`. Slots count this core's channels: unlike a short hash, two aliases never share a
/// socket, and the path fits macOS `sun_path` even under a long test home.
pub fn control_path(home: &Path, slot: usize) -> Result<PathBuf, String> {
    let dir = home.join("mux");
    private_dir(&dir)?;
    let path = dir.join(slot.to_string());
    // OpenSSH binds `<path>.<16 random characters>` first, then renames it.
    if path.as_os_str().len() + 17 > crate::server::SOCKET_PATH_MAX {
        return Err(format!("ssh control path {} is too long", path.display()));
    }
    Ok(path)
}
/// Every ssh vector starts like this; options only through `-o`, never `-F` or a config edit.
pub(crate) fn ssh_args(master: Option<(&Path, bool)>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=3",
        "-o",
        "StrictHostKeyChecking=yes",
    ]
    .map(OsString::from)
    .into();
    if let Some((path, own)) = master {
        let mut control = OsString::from("ControlPath=");
        control.push(path);
        let options: &[&str] = if own {
            &[
                "ControlMaster=yes",
                "ControlPersist=no",
                "ServerAliveInterval=15",
                "ServerAliveCountMax=2",
            ]
        } else {
            &["ControlMaster=no"]
        };
        for option in options {
            args.extend(["-o".into(), (*option).into()]);
        }
        args.extend(["-o".into(), control]);
    }
    args
}

/// The relay runs in the remote user's login shell (a Linux host may have no zsh), so its PATH is the one they set up.
/// `sh -c` comes first because the shell that reads this line may be fish or csh, which do not know `${SHELL:-…}`.
/// Both are constants: nothing the user typed is ever in the remote command.
pub(crate) fn remote_command(stream: bool) -> &'static str {
    if stream {
        r#"exec sh -c 'exec "${SHELL:-/bin/sh}" -lc "exec nunchiro machine relay --stream"'"#
    } else {
        r#"exec sh -c 'exec "${SHELL:-/bin/sh}" -lc "exec nunchiro machine relay"'"#
    }
}
/// The whole ssh vector. `master`: `(path, true)` starts the ControlMaster and its streaming relay; `(path, false)`
/// rides it; `None` is a one-shot connection. The alias and the saved host, user and port are checked here and go
/// as their own arguments before `--` or as the destination, never into the remote command.
pub(crate) fn remote_argv(
    home: &Path,
    alias: &str,
    master: Option<(&Path, bool)>,
) -> Result<Vec<OsString>, String> {
    super::valid_alias(alias)?;
    let stream = matches!(master, Some((_, true)));
    let mut args = super::discovery::options(home, alias)?;
    args.extend(ssh_args(master));
    args.extend(["--".into(), alias.into(), remote_command(stream).into()]);
    Ok(args)
}

/// Starts the alias' channel once (owner snapshots only). The alias stays in `refreshing` while its thread runs, so
/// a stopping core waits for the master to be reaped.
pub(crate) fn ensure(
    sessions: &mut Sessions,
    registry: &Arc<Mutex<Sessions>>,
    home: &Path,
    alias: &str,
    stopping: &Arc<AtomicBool>,
) {
    if super::valid_alias(alias).is_err()
        || stopping.load(Ordering::SeqCst)
        || sessions.remote.refreshing.contains(alias)
        || sessions.remote.forgetting.contains(alias)
    {
        return;
    }
    let slot = sessions.remote.next_slot;
    sessions.remote.next_slot += 1;
    let cancel = Arc::new(AtomicBool::new(false));
    let retry = Arc::new(AtomicBool::new(false));
    sessions.remote.retry.insert(alias.into(), retry.clone());
    sessions.remote.cancel.insert(alias.into(), cancel.clone());
    sessions
        .remote
        .channels
        .insert(alias.into(), Channel::new(slot));
    sessions.remote.refreshing.insert(alias.into());
    let (registry, home, alias, stopping) = (
        registry.clone(),
        home.to_path_buf(),
        alias.to_string(),
        stopping.clone(),
    );
    thread::spawn(move || {
        // Even after a panic, a stopping core must not wait on this alias forever.
        struct Done<'a>(&'a Mutex<Sessions>, &'a str);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
                s.remote.refreshing.remove(self.1);
                s.remote.cancel.remove(self.1);
                s.remote.retry.remove(self.1);
            }
        }
        let _done = Done(&registry, &alias);
        run(
            &registry,
            &home,
            &alias,
            slot,
            &Stop {
                core: stopping,
                machine: cancel,
                retry,
            },
        );
    });
}

struct Stop {
    core: Arc<AtomicBool>,
    machine: Arc<AtomicBool>,
    retry: Arc<AtomicBool>,
}
impl Stop {
    fn stopped(&self) -> bool {
        self.core.load(Ordering::SeqCst) || self.machine.load(Ordering::SeqCst)
    }
}
enum End {
    Lost(String),
    // The master ended on its own; its exit status is added once it is reaped.
    Closed(String),
    Mismatch(String),
    Stopped,
}
fn run(registry: &Mutex<Sessions>, home: &Path, alias: &str, slot: usize, stopping: &Stop) {
    let mut step = 0;
    let mut was_up = false;
    while !stopping.stopped() {
        let (state, error) = match attempt(
            registry,
            home,
            alias,
            slot,
            stopping,
            &mut step,
            &mut was_up,
        ) {
            End::Stopped => return,
            End::Mismatch(error) => {
                step = BACKOFF_SECS.len() - 1;
                (ChannelState::VersionMismatch, error)
            }
            End::Lost(error) | End::Closed(error) => {
                let state = if was_up && step < BACKOFF_SECS.len() - 1 {
                    ChannelState::Reconnecting
                } else {
                    ChannelState::Down
                };
                (state, error)
            }
        };
        let Ok(mut s) = registry.lock() else { return };
        // V2-5b: the last rows stay, each with the card saying why they are not current.
        // shortcut: a first connection that never came up has no cached rows, so it shows only in machine status (no
        // row card); upgrade when V2-12m-b's machine row carries the card.
        let problem = crate::problems::machine(alias, &error);
        for row in s.remote.cache.get_mut(alias).into_iter().flatten() {
            row.problem = Some(problem.clone());
        }
        set(&mut s, alias, state, Some(error));
        drop(s);
        let until = Instant::now() + Duration::from_secs(BACKOFF_SECS[step]);
        step = (step + 1).min(BACKOFF_SECS.len() - 1);
        while Instant::now() < until {
            if stopping.retry.swap(false, Ordering::SeqCst) {
                break;
            }
            if stopping.stopped() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
fn set(s: &mut Sessions, alias: &str, state: ChannelState, error: Option<String>) {
    let Some(channel) = s.remote.channels.get_mut(alias) else {
        return;
    };
    if channel.state == ChannelState::Up && state != ChannelState::Up {
        channel.latency_ms = None;
    }
    if channel.state != state {
        channel.since_ms = crate::queue::now_ms();
    }
    channel.state = state;
    channel.error = error;
}
fn attempt(
    registry: &Mutex<Sessions>,
    home: &Path,
    alias: &str,
    slot: usize,
    stopping: &Stop,
    step: &mut usize,
    was_up: &mut bool,
) -> End {
    let path = match control_path(home, slot) {
        Ok(path) => path,
        Err(e) => return End::Lost(e),
    };
    // Only this core's channel uses this name in its private folder; a leftover is an earlier master's.
    let _ = fs::remove_file(&path);
    let mut command =
        crate::process::command(std::env::var_os("NUNCHIRO_SSH").unwrap_or_else(|| "ssh".into()));
    let args = match remote_argv(home, alias, Some((&path, true))) {
        Ok(a) => a,
        Err(e) => return End::Lost(e),
    };
    command
        .args(args)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_MACHINE")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return End::Lost(format!("machine {alias}: SSH {e}")),
    };
    let end = stream(&mut child, registry, alias, stopping, step, was_up);
    // The master's group ends here, before wait() frees its PID (and with the core: its stdin closes on exit).
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let status = child
        .wait()
        .map(|s| s.to_string())
        .unwrap_or_else(|e| e.to_string());
    let _ = fs::remove_file(&path);
    match end {
        End::Closed(stderr) if stderr.contains(V1A_RELAY) => End::Mismatch(format!(
            "version mismatch: remote relay has no channel (protocol 1, v1a), local protocol {PROTOCOL} (nunchiro {})",
            env!("CARGO_PKG_VERSION")
        )),
        End::Closed(stderr) => End::Lost(format!("machine {alias}: SSH {status}: {stderr}")),
        end => end,
    }
}
fn stream(
    child: &mut std::process::Child,
    registry: &Mutex<Sessions>,
    alias: &str,
    stopping: &Stop,
    step: &mut usize,
    was_up: &mut bool,
) -> End {
    let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) else {
        return End::Lost("ssh pipes unavailable".into());
    };
    for fd in [out.as_raw_fd(), err.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            return End::Lost(std::io::Error::last_os_error().to_string());
        }
    }
    let started = Instant::now();
    let mut hello = false;
    let mut line = Vec::new();
    let mut stderr = Vec::new();
    let mut buf = vec![0; 64 * 1024];
    let mut err_open = true;
    loop {
        if stopping.stopped() {
            return End::Stopped;
        }
        let mut progress = false;
        match err.read(&mut buf) {
            // A closed stderr stays readable (EOF) and would make the poll below spin.
            Ok(0) => err_open = false,
            Ok(n) => {
                progress = true;
                // Keep only the tail for the error text.
                stderr.extend_from_slice(&buf[..n]);
                let cut = stderr.len().saturating_sub(4096);
                stderr.drain(..cut);
            }
            _ => {}
        }
        match out.read(&mut buf) {
            Ok(0) => {
                while let Ok(n @ 1..) = err.read(&mut buf) {
                    stderr.extend_from_slice(&buf[..n]);
                }
                let cut = stderr.len().saturating_sub(4096);
                stderr.drain(..cut);
                return End::Closed(clean_text(&stderr));
            }
            Ok(n) => {
                progress = true;
                for &byte in &buf[..n] {
                    if byte != b'\n' {
                        line.push(byte);
                        if line.len() > LINE_MAX {
                            return End::Lost(format!("machine {alias}: relay line over 8 MiB"));
                        }
                        continue;
                    }
                    let text = std::mem::take(&mut line);
                    if hello {
                        // Q9 pin-J9-1: the backoff resets at the first push, not at the hello, so a relay that greets
                        // and then exits (its core cannot start) backs off instead of reopening SSH every second.
                        *step = 0;
                        accept(registry, alias, stopping, &text);
                        continue;
                    }
                    match greet(&text) {
                        Ok((protocol, version)) if accepts(protocol) => {
                            hello = true;
                            *was_up = true;
                            let Ok(mut s) = registry.lock() else {
                                return End::Stopped;
                            };
                            set(&mut s, alias, ChannelState::Up, None);
                            if let Some(channel) = s.remote.channels.get_mut(alias) {
                                channel.remote_protocol = Some(protocol);
                                channel.remote_version = Some(version);
                                channel.latency_ms = Some(started.elapsed().as_millis() as u64);
                            }
                        }
                        Ok((protocol, version)) => {
                            if let Ok(mut s) = registry.lock()
                                && let Some(channel) = s.remote.channels.get_mut(alias)
                            {
                                channel.remote_protocol = Some(protocol);
                                channel.remote_version = Some(version.clone());
                            }
                            return End::Mismatch(format!(
                                "version mismatch: remote protocol {protocol} (nunchiro {version}), local protocol \
                                 {PROTOCOL} (nunchiro {})",
                                env!("CARGO_PKG_VERSION")
                            ));
                        }
                        Err(e) => return End::Lost(format!("machine {alias}: {e}")),
                    }
                }
            }
            Err(e)
                if [
                    std::io::ErrorKind::WouldBlock,
                    std::io::ErrorKind::Interrupted,
                ]
                .contains(&e.kind()) => {}
            Err(e) => return End::Lost(e.to_string()),
        }
        if !hello && started.elapsed() > HELLO_WAIT {
            return End::Lost(format!(
                "machine {alias}: no relay hello within {} s: {}",
                HELLO_WAIT.as_secs(),
                clean_text(&stderr)
            ));
        }
        if !progress {
            // Wait on readiness, not on time: a sleep here capped the stream at one pipe buffer per tick (V2.5-41).
            // The 20 ms timeout keeps the stop and hello checks above responsive.
            let err_fd = if err_open { err.as_raw_fd() } else { -1 };
            let mut fds = [out.as_raw_fd(), err_fd].map(|fd| libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            });
            unsafe { libc::poll(fds.as_mut_ptr(), 2, 20) };
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Line {
    Hello {
        protocol: u32,
        version: String,
    },
    Sessions {
        sessions: Vec<Session>,
        /// The relay's `core_in_ssh_login`; absent from a relay that does not say.
        #[serde(default)]
        ssh_login: bool,
    },
}
fn greet(line: &[u8]) -> Result<(u32, String), String> {
    match serde_json::from_slice(line) {
        Ok(Line::Hello { protocol, version })
            if !version.is_empty()
                && version.len() <= 64
                && version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-+.".contains(&b)) =>
        {
            Ok((protocol, version))
        }
        _ => Err("the relay did not start with a valid hello".into()),
    }
}
// A malformed, unknown or repeated-hello line is dropped; a sessions line replaces this alias' rows.
fn accept(registry: &Mutex<Sessions>, alias: &str, stopping: &Stop, line: &[u8]) {
    let Ok(Line::Sessions {
        sessions,
        ssh_login,
    }) = serde_json::from_slice(line)
    else {
        return;
    };
    let mut rows = clean(alias, sessions);
    if let Ok(mut s) = registry.lock()
        && !stopping.stopped()
    {
        // A push read before the remote applied an answer must not offer that item again; once a push no longer
        // holds it, the remote is done with it and the mark goes.
        let pushed: BTreeSet<String> = rows
            .iter()
            .flat_map(|r| r.pending.iter().map(|d| d.id.clone()))
            .collect();
        let mut unseen_pending = BTreeSet::new();
        if let Some(unseen) = s.remote.unseen_starts.get_mut(alias) {
            for row in &rows {
                unseen.remove(&row.id);
            }
            unseen_pending.extend(
                unseen
                    .values()
                    .flat_map(|r| r.pending.iter().map(|d| d.id.clone())),
            );
            rows.extend(unseen.values().cloned());
        }
        let answered = s.remote.answered.entry(alias.into()).or_default();
        answered.retain(|id, mark| {
            // A retained start is older data: only a real push can advance or retire its answer mark.
            if unseen_pending.contains(id) && !pushed.contains(id) {
                return true;
            }
            let keep = pushed.contains(id) && *mark != Mark::Seen;
            if *mark == Mark::Sent {
                *mark = Mark::Seen;
            }
            keep
        });
        for row in &mut rows {
            row.pending.retain(|d| !answered.contains_key(&d.id));
        }
        s.remote.cache.insert(alias.into(), rows);
        // The flag only chooses this side's own sentence; no text of the relay's is shown.
        if let Some(channel) = s.remote.channels.get_mut(alias)
            && channel.state == ChannelState::Up
        {
            channel.error = ssh_login.then(|| ssh_login_note(alias));
        }
    }
}
/// Rows keep only well-formed, unique ids, and only the decisions of their own session.
pub(crate) fn clean(alias: &str, rows: Vec<Session>) -> Vec<Session> {
    let mut ids = BTreeSet::new();
    rows.into_iter()
        .filter(|row| store::valid_id(&row.id) && ids.insert(row.id.clone()))
        .map(|mut row| {
            let mut items = BTreeSet::new();
            row.pending.retain(|d| {
                d.session_id == row.id && store::valid_id(&d.id) && items.insert(d.id.clone())
            });
            row.machine = Some(alias.into());
            row
        })
        .collect()
}
// Remote stderr reaches only the status text: control characters out, bounded.
fn clean_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(512)
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn argv_home(name: &str, settings: &str) -> PathBuf {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("argv-{name}-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("settings.json"), settings).unwrap();
        home
    }
    // The remote command no longer names /bin/zsh; the whole vector is pinned, strict host-key options included.
    #[test]
    fn remote_argv_is_pinned() {
        let home = argv_home(
            "pin",
            r#"{"machines":{"box":{"host":"box.lan","user":"me","port":2222}}}"#,
        );
        let text = |master| -> Vec<String> {
            remote_argv(&home, "box", master)
                .unwrap()
                .into_iter()
                .map(|a| a.into_string().unwrap())
                .collect()
        };
        let head = "-o HostName=box.lan -o User=me -o Port=2222 -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=yes";
        assert_eq!(
            text(None).join(" "),
            format!(
                r#"{head} -- box exec sh -c 'exec "${{SHELL:-/bin/sh}}" -lc "exec nunchiro machine relay"'"#
            )
        );
        assert_eq!(
            text(Some((Path::new("/m/0"), true))).join(" "),
            format!(
                r#"{head} -o ControlMaster=yes -o ControlPersist=no -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o ControlPath=/m/0 -- box exec sh -c 'exec "${{SHELL:-/bin/sh}}" -lc "exec nunchiro machine relay --stream"'"#
            )
        );
        // The command is one argument, the last one, and the alias is the only thing after `--` before it.
        let args = text(Some((Path::new("/m/0"), false)));
        assert_eq!(args[args.len() - 3..], ["--", "box", remote_command(false)]);
        let _ = fs::remove_dir_all(home);
    }
    // Shell and option characters in any user-supplied field stop the vector from being built at all.
    #[test]
    fn remote_argv_refuses_hostile_fields() {
        let hostile = [
            "x;touch /tmp/p",
            "$(id)",
            "`id`",
            "a b",
            "a'b",
            "a\"b",
            "a\nb",
            "a|b",
            "a&b",
            "-oProxyCommand=id",
        ];
        let home = argv_home("alias", "{}");
        for alias in hostile {
            assert!(remote_argv(&home, alias, None).is_err(), "alias {alias:?}");
        }
        let _ = fs::remove_dir_all(home);
        for field in ["host", "user"] {
            for value in hostile {
                let mut config = serde_json::json!({"host":"box.lan","user":"me","port":22});
                config[field] = value.into();
                let home = argv_home(
                    "field",
                    &serde_json::json!({"machines":{"box":config}}).to_string(),
                );
                assert!(
                    remote_argv(&home, "box", None).is_err(),
                    "{field} {value:?}"
                );
                let _ = fs::remove_dir_all(home);
            }
        }
        for port in ["0", "65536", "\"22;id\"", "-1"] {
            let home = argv_home(
                "port",
                &format!(r#"{{"machines":{{"box":{{"host":"box.lan","port":{port}}}}}}}"#),
            );
            assert!(remote_argv(&home, "box", None).is_err(), "port {port}");
            let _ = fs::remove_dir_all(home);
        }
        for command in [remote_command(false), remote_command(true)] {
            assert!(!command.contains("zsh") && !command.contains("box"));
        }
    }

    // V2.5-23 r3: the latency belongs to the connection that said hello; leaving Up drops it, staying Up keeps it.
    #[test]
    fn latency_cleared_when_state_leaves_up() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("latency-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let mut s = Sessions::open(&home).unwrap();
        let mut channel = Channel::new(0);
        channel.state = ChannelState::Up;
        channel.latency_ms = Some(42);
        s.remote.channels.insert("box".into(), channel);
        set(&mut s, "box", ChannelState::Up, None);
        assert_eq!(s.remote.channels["box"].latency_ms, Some(42));
        set(
            &mut s,
            "box",
            ChannelState::Reconnecting,
            Some("lost".into()),
        );
        assert_eq!(s.remote.channels["box"].latency_ms, None);
        let _ = fs::remove_dir_all(&home);
    }

    // V2.5-41: a pipe that refills after each drain used to cost a 20 ms sleep per pipe buffer (16 KiB on macOS),
    // so a large push took ~10 s and a 9 MB line ~14 s. The stream now waits on readiness, not on time.
    #[test]
    fn stream_reads_a_large_push_without_sleeping_per_buffer() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("stream-rate-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let registry = Mutex::new(Sessions::open(&home).unwrap());
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "printf '{\"type\":\"hello\",\"protocol\":2,\"version\":\"0\"}\\n'; head -c 9000000 /dev/zero | tr '\\0' a; sleep 30",
            ])
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stop = Stop {
            core: Arc::default(),
            machine: Arc::default(),
            retry: Arc::default(),
        };
        let started = Instant::now();
        let end = stream(&mut child, &registry, "box", &stop, &mut 0, &mut false);
        let took = started.elapsed();
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
        let _ = child.wait();
        let _ = fs::remove_dir_all(&home);
        assert!(
            matches!(&end, End::Lost(e) if e.contains("over 8 MiB")),
            "the oversize line drops the master"
        );
        // ~0.1 s when reads wait on readiness; ~10 s with a sleep per buffer.
        assert!(took < Duration::from_secs(4), "8 MiB took {took:?}");
    }
}
