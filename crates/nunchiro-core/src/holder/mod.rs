//! V2-1a: the per-session PTY holder (`nunchiro hold`, same binary). It owns one session's PTY (`local::Local`) and
//! serves it over an owner-only socket, `holders/<short id>.sock`, to the core's `pty::Pty` client. It admits only a
//! peer outside every session. V2-1b: it outlives its core (exit, crash or `serve restart`) and serves the next one
//! that attaches (needs 76: agents survive the core); it ends when a core stops it or collected its agent's end.
//! A core started without `use_executable` (a library user, a test binary) runs each holder on threads of its own
//! process instead: same socket, protocol and checks.
pub mod frame;
pub(crate) mod local;
#[cfg(test)]
mod stopped_tests; // tickets 433, 416
#[cfg(test)]
mod swap_tests; // ticket 379

use frame::{
    ALIVE, ATTACH, EOF, ERR, OK, OUTPUT, RESIZE, SPAWN, SPAWNED, STOP, Spawn, WRITE, read_frame,
    write_frame,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::{FileTypeExt, PermissionsExt},
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[cfg(test)]
pub(crate) type AfterBind = Box<dyn FnOnce(&Path)>;
#[cfg(test)]
thread_local! {
    // V2-1a r2: runs between the core's bind and the holder's first link (a same-uid process swapping the socket).
    pub(crate) static AFTER_BIND: std::cell::Cell<Option<AfterBind>> =
        const { std::cell::Cell::new(None) };
}
/// V2.5-47 test seam: parks session `.0`'s holder after its core's link ended and before it frees the core flag
/// (`.1` says it got there, `.2` lets it go on), so a test holds the closed-link-but-flag-taken interleaving open.
#[cfg(test)]
pub(crate) type Park = (String, mpsc::Sender<()>, mpsc::Receiver<()>);
#[cfg(test)]
pub(crate) static BEFORE_RELEASE: Mutex<Option<Park>> = Mutex::new(None);
#[cfg(test)]
fn park(id: &str) {
    let hook = BEFORE_RELEASE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take_if(|(want, ..)| want == id);
    if let Some((_, reached, go)) = hook {
        let _ = reached.send(());
        let _ = go.recv();
    }
}
/// `sun_path` holds 104 bytes with its terminating NUL.
pub const SOCKET_PATH_MAX: usize = 103;
/// How long each side waits for the other's hello, and a holder for its core.
const HELLO_WAIT: Duration = Duration::from_secs(10);
/// V2.5-47: the one answer a peer gets when its check could not finish (the process table changed under load); it
/// comes as an ERR frame in place of the hello, and the peer may try again. Fixed, so it never says why or who.
pub(crate) const PEER_CHECK_BUSY: &str = "peer check busy";

static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
/// The binary whose `hold` subcommand runs a holder; set once by `nunchiro serve` before the core starts.
pub fn use_executable(exe: PathBuf) {
    let _ = EXECUTABLE.set(exe);
}

/// What sessions.json keeps of a live session's holder (store version 2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub socket: PathBuf,
    pub protocol: u16,
    pub pid: u32,
    /// The holder's start time (microseconds since the epoch): with `pid`, one process, not a reused pid.
    pub started: u64,
}

fn short(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// `$NUNCHIRO_HOME/holders/<short id>.sock`, or, when that would not fit `sun_path`, a short owner-only folder
/// `/tmp/nunchiro-<uid>/` with the home's short hash in the name.
pub fn socket_path(home: &Path, id: &str) -> Result<PathBuf, String> {
    let name = format!("{}.sock", short(id.as_bytes()));
    let path = home.join("holders").join(&name);
    if path.as_os_str().len() <= SOCKET_PATH_MAX {
        crate::store::private_dir(&home.join("holders"))?;
        return Ok(path);
    }
    let path = fallback_dir()?.join(format!("{}-{name}", short(home.as_os_str().as_bytes())));
    if path.as_os_str().len() > SOCKET_PATH_MAX {
        return Err("holder socket path too long".into());
    }
    Ok(path)
}
fn fallback_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let uid = unsafe { libc::geteuid() };
    let dir = PathBuf::from(format!("/tmp/nunchiro-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.to_string()),
        _ => {}
    }
    // /tmp is shared: only a real folder of ours, closed to others, is used.
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(format!("{} is not an owner-only folder", dir.display()));
    }
    Ok(dir)
}
/// V2-1b: the holder sockets in this data folder: `holders/` and this home's names in the short fallback folder.
pub fn sockets(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![(home.join("holders"), String::new())];
    if let Ok(dir) = fallback_dir() {
        dirs.push((dir, short(home.as_os_str().as_bytes()) + "-"));
    }
    let mut found = vec![];
    for (dir, prefix) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix)
                && name.ends_with(".sock")
                && entry.file_type().is_ok_and(|t| t.is_socket())
            {
                found.push(entry.path());
            }
        }
    }
    found.sort();
    found
}
/// Core start (V2-1b: after reattaching): removes sockets nothing listens on any more and returns the live ones no
/// session record names ("unknown holders": never adopted, left running).
pub fn clean(home: &Path, recorded: &std::collections::BTreeSet<PathBuf>) -> Vec<PathBuf> {
    let mut unknown = vec![];
    for path in sockets(home) {
        if recorded.contains(&path) {
            continue;
        }
        match UnixStream::connect(&path) {
            Ok(_) => unknown.push(path),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                let _ = std::fs::remove_file(&path);
            }
            Err(_) => unknown.push(path),
        }
    }
    unknown
}
/// V2-1b: ends the holder listening at `path` and its agent through the frozen hello and `stop` (any version reads
/// them), as a full quit does for every socket it finds. Sends nothing to a peer of another user.
/// With `holder` (a recorded holder's pid and start time) the socket's peer must be exactly that process.
pub fn stop_at(path: &Path, holder: Option<(u32, u64)>) -> Result<(), String> {
    // A peer that only probed the socket (a core's start, `serve status`) holds it for a moment.
    for _ in 0..5 {
        match stop_once(path, holder) {
            Err(e) if e == "holder already has its core" || e == PEER_CHECK_BUSY => {
                thread::sleep(Duration::from_millis(100))
            }
            result => return result,
        }
    }
    stop_once(path, holder)
}
fn stop_once(path: &Path, holder: Option<(u32, u64)>) -> Result<(), String> {
    let mut link = UnixStream::connect(path).map_err(|e| e.to_string())?;
    let peer = crate::peer::of(&link).map_err(|e| e.to_string())?;
    if peer.uid != unsafe { libc::geteuid() } {
        return Err("holder socket served by another user".into());
    }
    if let Some((pid, started)) = holder
        && (peer.pid as u32 != pid || !crate::peer::is_same(pid, started))
    {
        return Err(format!(
            "the socket is served by pid {}, not holder {pid}",
            peer.pid
        ));
    }
    link.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    link.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    read_hello_or_busy(&mut link)?;
    link.write_all(&frame::hello()).map_err(|e| e.to_string())?;
    write_frame(&mut link, STOP, &[]).map_err(|e| e.to_string())?;
    // The stop may wait out a group still exiting (about a second).
    link.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    match read_frame(&mut link).map_err(|e| e.to_string())? {
        (OK, _) => Ok(()),
        (ERR, why) => Err(String::from_utf8_lossy(&why).into_owned()),
        _ => Err("unexpected holder reply".into()),
    }
}
/// Core side: starts session `id`'s holder and returns the connected, version-checked link and its record.
/// V2-1a r2: the core's link is one end of a socket pair the holder inherits, never a connect by path, so a process
/// that swaps the socket file cannot receive the spawn frame (with the session token) or the core's writes.
pub(crate) fn start(home: &Path, id: &str) -> Result<(UnixStream, Record), String> {
    let path = socket_path(home, id)?;
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err("holder socket already exists".into());
    }
    // The socket's folder is owner-only (`holders/` 0700, or the checked fallback), so the moment before the
    // 0600 below lets no other user reach it.
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    #[cfg(test)]
    if let Some(hook) = AFTER_BIND.take() {
        hook(&path);
    }
    let started = (|| {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        let (mut link, theirs) = UnixStream::pair().map_err(|e| e.to_string())?;
        let pid = match EXECUTABLE.get() {
            Some(exe) => {
                // The listener becomes the holder's stdin and its link its stdout; outside the core's process group.
                let mut child = crate::process::command(exe)
                    .arg("hold")
                    .arg(id)
                    .env("NUNCHIRO_HOME", home)
                    .stdin(Stdio::from(OwnedFd::from(listener)))
                    .stdout(Stdio::from(OwnedFd::from(theirs)))
                    .stderr(Stdio::null())
                    .process_group(0)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                let pid = child.id();
                thread::spawn(move || {
                    let _ = child.wait();
                });
                pid
            }
            None => {
                let (home, id) = (home.to_path_buf(), id.to_string());
                thread::spawn(move || serve(listener, theirs, &home, &id));
                std::process::id()
            }
        };
        link.set_read_timeout(Some(HELLO_WAIT))
            .map_err(|e| e.to_string())?;
        link.write_all(&frame::hello()).map_err(|e| e.to_string())?;
        let theirs = frame::read_hello(&mut link)?;
        if !frame::compatible(theirs) {
            return Err(format!("holder speaks protocol {}", theirs.0));
        }
        link.set_read_timeout(None).map_err(|e| e.to_string())?;
        let started = crate::peer::started(pid).map_err(|e| e.to_string())?;
        Ok((
            link,
            Record {
                socket: path.clone(),
                protocol: theirs.0.min(frame::PROTOCOL),
                pid,
                started,
            },
        ))
    })();
    if started.is_err() {
        // The holder ends when its link closes.
        let _ = std::fs::remove_file(&path);
    }
    started
}
/// Core side: what a holder runs, in the frame's encoding. The environment is read whole and raw (a value that is
/// not UTF-8 survives): this process's variables and the ones the command adds, minus those it removed.
pub(crate) fn encode(cmd: &portable_pty::CommandBuilder, seed: &[u8]) -> Vec<u8> {
    let mut keys: Vec<std::ffi::OsString> = std::env::vars_os().map(|(k, _)| k).collect();
    keys.extend(cmd.iter_extra_env_as_str().map(|(k, _)| k.into()));
    keys.sort();
    keys.dedup();
    Spawn {
        argv: cmd
            .get_argv()
            .iter()
            .map(|a| a.as_bytes().to_vec())
            .collect(),
        env: keys
            .iter()
            .filter_map(|k| Some((k.as_bytes().to_vec(), cmd.get_env(k)?.as_bytes().to_vec())))
            .collect(),
        cwd: cmd.get_cwd().map(|c| c.as_bytes().to_vec()),
        seed: seed.to_vec(),
    }
    .encode()
}

/// `nunchiro hold <session id>`: fd 0 is the listening socket the core bound, fd 1 the core's link. Internal; only a
/// core starts it.
pub fn main(home: &Path, args: &[String]) -> Result<(), String> {
    let [id] = args else {
        return Err("usage: nunchiro hold <session id> (started by the core)".into());
    };
    if !crate::store::valid_id(id) {
        return Err("invalid session id".into());
    }
    // `listen` again succeeds only on a bound stream socket (a terminal or a connected socket is refused).
    if unsafe { libc::listen(0, 16) } != 0 {
        return Err("nunchiro hold is started by the core".into());
    }
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(1, &mut st) } != 0 || st.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        return Err("nunchiro hold is started by the core".into());
    }
    // Off fds 0 and 1 and close-on-exec, so the agent never inherits them; both become /dev/null.
    let null = std::fs::File::options()
        .read(true)
        .write(true)
        .open("/dev/null")
        .map_err(|e| e.to_string())?;
    let mut moved = [0; 2];
    for fd in [0, 1] {
        moved[fd as usize] = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if moved[fd as usize] == -1
            || unsafe { libc::dup2(std::os::fd::AsRawFd::as_raw_fd(&null), fd) } == -1
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let listener = unsafe { UnixListener::from_raw_fd(moved[0]) };
    let link = unsafe { UnixStream::from_raw_fd(moved[1]) };
    // V2-1b (carried from V2-1a): stderr is /dev/null, so a panic goes to the session log, redacted like every line.
    let (log_home, log_id) = (home.to_path_buf(), id.clone());
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut log) = crate::logs::session(&log_home, &log_id) {
            let _ = log.write(format!("holder {}: panic: {info}\n", std::process::id()).as_bytes());
        }
    }));
    serve(listener, link, home, id);
    Ok(())
}

/// Admits at most this many peers at a time; others are closed unanswered.
const ADMITTING: usize = 8;
/// How long an admitted peer has to send its hello.
const PEER_HELLO_WAIT: Duration = Duration::from_secs(2);
/// V2-1b: how long a holder whose agent ended waits for a core to collect that (spec: 10 minutes).
const ORPHAN_WAIT: Duration = Duration::from_secs(600);
#[cfg(test)]
pub(crate) static ORPHAN_WAIT_TEST: std::sync::Mutex<Option<Duration>> =
    std::sync::Mutex::new(None);
/// Ticket 416 round 2: how long a holder with no core waits for its data folder or socket to come back.
const GONE_WAIT: Duration = Duration::from_secs(30);
fn orphan_wait() -> Duration {
    #[cfg(test)]
    if let Some(wait) = *ORPHAN_WAIT_TEST.lock().unwrap_or_else(|e| e.into_inner()) {
        return wait;
    }
    ORPHAN_WAIT
}

/// V2-1b: what a holder keeps across its cores.
struct Held {
    pty: Option<local::Local>,
    /// Where the agent's output goes: the attached core's link (from its SPAWN, or after its ATTACH); none between
    /// cores, when output only fills the ring.
    out: Arc<Mutex<Option<Writer>>>,
    /// A core received the agent's end (an ALIVE answered "ended", or a STOP): the holder may exit.
    collected: bool,
    /// The agent's start time, read once at launch (a later read could see another process on a reused pid).
    started: u64,
}
type Writer = Arc<Mutex<UnixStream>>;

/// Holder side: serves its core on `link`; V2-1b: when that link ends the agent keeps running and the holder waits
/// for the next core on `listener` (one at a time). It exits once a core collected its agent's end, when no agent
/// was started, when its agent ended (433: or stayed stopped) and no core came within `ORPHAN_WAIT`, or (416) when
/// its data folder or socket stayed gone for `GONE_WAIT` while no core is attached; dropping the PTY then stops what is left of the
/// agent's group. Peers are checked on threads of their own, so none delays the core.
fn serve(listener: UnixListener, link: UnixStream, home: &Path, id: &str) {
    let log = Arc::new(Mutex::new(crate::logs::session(home, id).ok()));
    let note = {
        let log = log.clone();
        move |line: String| {
            if let Some(w) = log.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                let _ = w.write(format!("holder {}: {line}\n", std::process::id()).as_bytes());
            }
        }
    };
    let path = listener
        .local_addr()
        .ok()
        .and_then(|a| a.as_pathname().map(Path::to_path_buf));
    let done = Arc::new(AtomicBool::new(false));
    // The first link is the core that started this holder.
    let attached = Arc::new(AtomicBool::new(true));
    let (cores, next) = mpsc::channel::<UnixStream>();
    {
        let (done, note, attached) = (done.clone(), note.clone(), attached.clone());
        let admitting = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        thread::spawn(move || {
            for stream in listener.incoming() {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                if admitting.fetch_add(1, Ordering::SeqCst) >= ADMITTING {
                    admitting.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let (slot, note, attached, cores) = (
                    admitting.clone(),
                    note.clone(),
                    attached.clone(),
                    cores.clone(),
                );
                let spawned = thread::Builder::new().spawn(move || {
                    match admit(&mut stream, &attached) {
                        Ok(()) => {
                            if cores.send(stream).is_err() {
                                attached.store(false, Ordering::SeqCst);
                            }
                        }
                        Err(e) => note(format!("refused a connection: {e}")),
                    }
                    slot.fetch_sub(1, Ordering::SeqCst);
                });
                if spawned.is_err() {
                    admitting.fetch_sub(1, Ordering::SeqCst);
                }
            }
        });
    }
    let mut held = Held {
        pty: None,
        out: Arc::new(Mutex::new(None)),
        collected: false,
        started: 0,
    };
    let mut link = match hello(&link) {
        Ok(()) => {
            note("core attached".into());
            Some(link)
        }
        Err(e) => {
            note(format!("core hello failed: {e}"));
            None
        }
    };
    'held: loop {
        if let Some(core) = link.take() {
            if let Err(e) = own(core, home, &note, &mut held) {
                note(format!("core link ended: {e}"));
            }
            *held.out.lock().unwrap_or_else(|e| e.into_inner()) = None;
            #[cfg(test)]
            park(id);
            attached.store(false, Ordering::SeqCst);
        }
        let Some(pty) = held.pty.as_mut() else { break };
        if held.collected {
            break;
        }
        // No core: the agent runs on; once it ended, a core has `ORPHAN_WAIT` to collect that. Ticket 433: a stopped
        // agent gets the same wait to be resumed; a resume or a reattach (a fresh pass of this loop) cancels it.
        let mut ended: Option<std::time::Instant> = None;
        let mut suspended: Option<std::time::Instant> = None;
        let mut missing: Option<std::time::Instant> = None;
        loop {
            match next.recv_timeout(Duration::from_secs(1)) {
                Ok(core) => {
                    note("core reattached".into());
                    link = Some(core);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Ticket 416: with its data folder or its socket gone, no core can ever reach this holder again.
                    // Round 2: only once it stayed gone for `GONE_WAIT`, so a volume that is away for a moment (an
                    // external disk remounting) keeps its agents; any look that finds both resets the count.
                    let gone = |p: &Path| matches!(std::fs::symlink_metadata(p), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
                    if gone(home) || path.as_deref().is_some_and(gone) {
                        let since = *missing.get_or_insert_with(|| {
                            note("data folder or socket missing".into());
                            std::time::Instant::now()
                        });
                        if since.elapsed() >= GONE_WAIT {
                            note("data folder or socket stayed missing; exiting".into());
                            break 'held;
                        }
                    } else if missing.take().is_some() {
                        note("data folder and socket are back".into());
                    }
                    if ended.is_none() && !matches!(pty.alive(), Ok(true)) {
                        note("agent ended without a core".into());
                        ended = Some(std::time::Instant::now());
                    }
                    if ended.is_some_and(|at| at.elapsed() >= orphan_wait()) {
                        note("no core collected the agent's end; exiting".into());
                        break 'held;
                    }
                    match (ended.is_none() && pty.suspended(), suspended) {
                        (true, None) => {
                            note("agent stopped without a core".into());
                            suspended = Some(std::time::Instant::now());
                        }
                        (true, Some(at)) if at.elapsed() >= orphan_wait() => {
                            note(
                                "the stopped agent was not resumed and no core came; exiting"
                                    .into(),
                            );
                            break 'held;
                        }
                        (false, Some(_)) => suspended = None,
                        _ => {}
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break 'held,
            }
        }
    }
    done.store(true, Ordering::SeqCst);
    if let Some(path) = path {
        // Wakes the acceptor so it sees `done` (in a core holding its PTYs, the thread would otherwise stay).
        let _ = UnixStream::connect(&path);
        let _ = std::fs::remove_file(&path);
    }
}
/// A peer's first read: the holder's hello, or the exact `PEER_CHECK_BUSY` frame a holder sends in its place (then
/// `Err(PEER_CHECK_BUSY)`). Any other first bytes are not a holder's.
pub(crate) fn read_hello_or_busy(r: &mut impl std::io::Read) -> Result<(u16, u16), String> {
    let mut first = [0; 12];
    r.read_exact(&mut first)
        .map_err(|e| format!("holder hello: {e}"))?;
    if first[..8] == frame::MAGIC {
        return frame::read_hello(&mut &first[..]);
    }
    let mut busy = vec![];
    write_frame(&mut busy, ERR, PEER_CHECK_BUSY.as_bytes()).map_err(|e| e.to_string())?;
    let mut rest = vec![0; busy.len() - first.len()];
    if first[..] != busy[..first.len()]
        || r.read_exact(&mut rest).is_err()
        || rest != busy[first.len()..]
    {
        return Err("not a holder hello".into());
    }
    Err(PEER_CHECK_BUSY.into())
}
/// The hello both ways on the core's link.
fn hello(mut link: &UnixStream) -> Result<(), String> {
    link.set_read_timeout(Some(HELLO_WAIT))
        .map_err(|e| e.to_string())?;
    link.write_all(&frame::hello()).map_err(|e| e.to_string())?;
    let theirs = frame::read_hello(&mut link)?;
    if !frame::compatible(theirs) {
        let why = format!("protocol {} not supported", theirs.0);
        let _ = write_frame(&mut link, ERR, why.as_bytes());
        return Err(why);
    }
    link.set_read_timeout(None).map_err(|e| e.to_string())
}
/// V2.5-47: the check could not finish (the process table changed under load), so the peer hears the fixed
/// `PEER_CHECK_BUSY` and may try again. A definitive refusal (another uid, inside a session) is closed unanswered.
fn busy(stream: &mut UnixStream, e: std::io::Error) -> Result<(), String> {
    let _ = write_frame(stream, ERR, PEER_CHECK_BUSY.as_bytes());
    // Open until the peer hangs up (at most the hello's wait): a core checks this holder's pid before it reads, and
    // that check fails on a link already closed.
    let _ = stream.set_read_timeout(Some(PEER_HELLO_WAIT));
    let _ = std::io::Read::read(stream, &mut [0; 1]);
    Err(format!("peer check failed: {e}"))
}
/// A peer on the socket: the peer check, then the hello both ways. V2-1b: a compatible peer becomes this holder's
/// core when it has none (`Ok`); while one is attached it is told so and closed, so two cores never share a holder.
fn admit(stream: &mut UnixStream, attached: &AtomicBool) -> Result<(), String> {
    stream
        .set_write_timeout(Some(PEER_HELLO_WAIT))
        .map_err(|e| e.to_string())?;
    let peer = match crate::peer::of(stream) {
        Ok(peer) => peer,
        Err(e) => return busy(stream, e),
    };
    #[cfg(test)]
    if let Err(e) = crate::peer::busy_once(stream) {
        return busy(stream, e);
    }
    if peer.uid != unsafe { libc::geteuid() } {
        return Err("another uid".into());
    }
    let leaders = match crate::peer::held_leaders() {
        Ok(leaders) => leaders,
        Err(e) => return busy(stream, e),
    };
    match crate::peer::containing(&peer, &leaders) {
        Ok(None) => {}
        Ok(Some(leader)) => return Err(format!("pid {} is inside session {leader}", peer.pid)),
        Err(e) => return busy(stream, e),
    }
    // V2-1b r3 (S1): a session held from another executable path is not in `leaders`; any holder's descendant is
    // refused, so no agent becomes a core (with WRITE) of a holder that has none.
    match crate::peer::under_holder(&peer) {
        Ok(false) => {}
        Ok(true) => return Err(format!("pid {} runs under a session holder", peer.pid)),
        Err(e) => return busy(stream, e),
    }
    stream
        .write_all(&frame::hello())
        .map_err(|e| e.to_string())?;
    // V2-1a r3: one deadline for the whole hello, so a peer trickling bytes is cut at it.
    let deadline = std::time::Instant::now() + PEER_HELLO_WAIT;
    let mut hello = [0; 12];
    let mut got = 0;
    while got < hello.len() {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err("peer hello timed out".into());
        }
        stream
            .set_read_timeout(Some(left))
            .map_err(|e| e.to_string())?;
        match std::io::Read::read(stream, &mut hello[got..]) {
            Ok(0) => return Err("peer closed before its hello".into()),
            Ok(n) => got += n,
            Err(e) => return Err(format!("peer hello: {e}")),
        }
    }
    let theirs = frame::read_hello(&mut &hello[..])?;
    let why = if !frame::compatible(theirs) {
        format!("protocol {} not supported", theirs.0)
    } else if attached
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;
        return Ok(());
    } else {
        "holder already has its core".to_string()
    };
    let _ = write_frame(stream, ERR, why.as_bytes());
    // Pty flake S4: open until the peer hangs up (at most the hello's wait). A peer that sends its next frame after
    // this close gets a broken pipe in place of the answer, which `attach_retrying` does not retry.
    let _ = stream.set_read_timeout(Some(PEER_HELLO_WAIT));
    let _ = std::io::Read::read(stream, &mut [0; 1]);
    Err(why)
}
/// Serves one core's requests until its link ends.
fn own(
    link: UnixStream,
    #[cfg_attr(not(test), allow(unused_variables))] home: &Path,
    note: &(impl Fn(String) + Clone + Send + 'static),
    held: &mut Held,
) -> Result<(), String> {
    // A core that stops reading loses its link (a frame cut by the timeout leaves it unusable); V2-1b: the agent
    // runs on for the next core.
    link.set_write_timeout(Some(HELLO_WAIT))
        .map_err(|e| e.to_string())?;
    let writer: Writer = Arc::new(Mutex::new(link.try_clone().map_err(|e| e.to_string())?));
    let reply = |op: u8, payload: &[u8]| {
        write_frame(
            &mut *writer.lock().unwrap_or_else(|e| e.into_inner()),
            op,
            payload,
        )
        .map_err(|e| e.to_string())
    };
    let answer = |result: Result<Vec<u8>, String>| match result {
        Ok(payload) => reply(OK, &payload),
        Err(e) => reply(ERR, e.as_bytes()),
    };
    let mut link = link;
    loop {
        let (op, payload) = read_frame(&mut link).map_err(|e| e.to_string())?;
        match (op, held.pty.as_mut()) {
            (STOP, None) => answer(Ok(vec![]))?,
            (STOP, Some(pty)) => {
                let stopped = pty.stop();
                held.collected |= stopped.is_ok();
                answer(stopped.map(|_| vec![]))?
            }
            (SPAWN, None) => {
                let spawned = Spawn::decode(&payload).and_then(|spawn| {
                    *held.out.lock().unwrap_or_else(|e| e.into_inner()) = Some(writer.clone());
                    let out = held.out.clone();
                    let on_output: local::OnOutput = Box::new(move |data, paste| {
                        let out = out.lock().unwrap_or_else(|e| e.into_inner());
                        let Some(w) = out.as_ref() else { return };
                        let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                        let sent = if data.is_empty() {
                            write_frame(&mut *w, EOF, &[])
                        } else {
                            write_frame(&mut *w, OUTPUT, &[&[paste as u8], data].concat())
                        };
                        if sent.is_err() {
                            let _ = w.shutdown(std::net::Shutdown::Both);
                        }
                    });
                    // V2-1a test: what sessions.json held when the agent was launched.
                    #[cfg(test)]
                    let _ = std::fs::copy(
                        home.join("sessions.json"),
                        home.join("sessions.at-launch.json"),
                    );
                    local::Local::spawn(command(&spawn), &spawn.seed, on_output)
                });
                match spawned {
                    Ok(spawned) => {
                        note(format!("agent pid {} started", spawned.pid()));
                        // V2-1b: with the agent's start time, so the core tells it from a later process on its pid.
                        let started = crate::peer::started(spawned.pid()).unwrap_or(0);
                        let mut payload = spawned.pid().to_be_bytes().to_vec();
                        payload.extend(started.to_be_bytes());
                        reply(SPAWNED, &payload)?;
                        held.pty = Some(spawned);
                        held.started = started;
                    }
                    Err(e) => answer(Err(e))?,
                }
            }
            (ATTACH, Some(pty)) => {
                // Under the ring's lock no output is stored or sent, so the snapshot and the stream after it meet
                // exactly: each byte reaches the core once.
                let ring = pty.ring();
                let ring = ring.lock().unwrap_or_else(|e| e.into_inner());
                let (bytes, end) = ring.replay.parts();
                let mut payload = pty.pid().to_be_bytes().to_vec();
                payload.extend(held.started.to_be_bytes());
                payload.extend([ring.paste as u8, ring.ended as u8]);
                payload.extend(end.to_be_bytes());
                payload.extend(bytes);
                reply(OK, &payload)?;
                *held.out.lock().unwrap_or_else(|e| e.into_inner()) = Some(writer.clone());
            }
            (WRITE, Some(pty)) => answer(pty.write(&payload).map(|_| vec![]))?,
            (RESIZE, Some(_)) if payload.len() != 4 => {
                answer(Err("invalid resize request".into()))?
            }
            (RESIZE, Some(pty)) => answer(
                pty.resize(
                    u16::from_be_bytes([payload[0], payload[1]]),
                    u16::from_be_bytes([payload[2], payload[3]]),
                )
                .map(|_| vec![]),
            )?,
            (ALIVE, Some(pty)) => {
                let alive = pty.alive();
                let ended = matches!(alive, Ok(false));
                // V2-5b: "ended" carries the exit code when known; a core of an earlier version reads any answer but
                // [1] as ended.
                let code = pty.exit_code().map(i32::to_be_bytes);
                answer(alive.map(|alive| {
                    std::iter::once(alive as u8)
                        .chain(code.filter(|_| !alive).into_iter().flatten())
                        .collect()
                }))?;
                // Q9 fr-J8-2: collected only once the answer went out; a lost reply leaves the end for the next core.
                held.collected |= ended;
            }
            (SPAWN, Some(_)) => answer(Err("agent already started".into()))?,
            (WRITE | RESIZE | ALIVE | ATTACH, None) => answer(Err("no agent started".into()))?,
            _ => answer(Err(format!("unknown holder request {op:#04x}")))?,
        }
    }
}
fn command(spawn: &Spawn) -> portable_pty::CommandBuilder {
    use std::ffi::OsString;
    let os = |b: &Vec<u8>| OsString::from_vec(b.clone());
    let mut cmd = portable_pty::CommandBuilder::from_argv(spawn.argv.iter().map(os).collect());
    cmd.env_clear();
    for (k, v) in &spawn.env {
        cmd.env(os(k), os(v));
    }
    if let Some(cwd) = &spawn.cwd {
        cmd.cwd(os(cwd));
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_under_104() {
        // The system temp dir, as the integration tests' `ns-<tag>-<pid>-<n>` homes: a checkout's `.scratch/` may be long.
        let base = std::env::temp_dir().canonicalize().unwrap();
        let short_home = base.join(format!("ns-h-{}-0", std::process::id()));
        let long_home = base.join("x".repeat(120)).join("y".repeat(60));
        for home in [&short_home, &long_home] {
            let path = socket_path(home, &crate::store::new_id().unwrap()).unwrap();
            assert!(path.as_os_str().len() <= 104, "{}", path.display());
            // Bindable, so the length check matches the kernel's.
            let _ = std::fs::remove_file(&path);
            drop(UnixListener::bind(&path).unwrap());
            std::fs::remove_file(&path).unwrap();
        }
        assert!(
            socket_path(&short_home, "a")
                .unwrap()
                .starts_with(&short_home)
        );
        let fallback = socket_path(&long_home, "a").unwrap();
        assert!(fallback.starts_with(fallback_dir().unwrap()));
        // Two homes never share a fallback name.
        assert_ne!(fallback, socket_path(&long_home.join("z"), "a").unwrap());
        let _ = std::fs::remove_dir_all(&short_home);
    }
}
