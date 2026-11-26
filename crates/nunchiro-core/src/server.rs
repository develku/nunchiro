//! Owner-only unix socket: one bounded JSON request and response per connection.
use crate::{api::*, sessions::Sessions, store};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
// Ticket 1162: two parts with their own job moved out; each child says its own in one `//!` line.
mod start_record;
mod worktree_op;
use start_record::record_start;
pub(crate) use worktree_op::worktree;
const FRAME_BYTES: u64 = 512 * 1024;
/// A stopping core's reply to a request it never ran, while it winds down for an `exit` (`serve restart`) or a signal:
/// the agents stay for a next core, so the CLI sends such a request once more, to that core (ticket 305).
pub const NOT_SERVED: &str = "core is stopping; request not served";
/// The same reply during an owner's full stop, which sticks: the CLI does not retry it or start a core (ticket 305).
pub const NOT_SERVED_QUIT: &str = "core is quitting; request not served";
/// F24: a core's answer to `exit_if_idle` while exiting would lose work; it keeps running.
pub const EXIT_BUSY: &str = "core is busy; not exiting";
/// The core.log line for each request a winding-down core refused unread (ticket 305).
pub const NOT_SERVED_LOG: &str = "request not served: core is winding down";
pub fn call(home: &Path, request: Request) -> Response {
    call_by(home, request, None)
}
/// `call` whose whole reply must be in by `until` (ticket 1130 A-D3 round 2): a peer that drips bytes without a newline
/// renews each 15 s read, so only this bounds the time.
pub fn call_by(home: &Path, request: Request, until: Option<Instant>) -> Response {
    // Ticket 1023: reading `core.token` here makes no caller the owner. The core judges the connecting process itself
    // (`inside_token`), so a session's child that drops NUNCHIRO_TOKEN is still that session's caller.
    let token = std::env::var("NUNCHIRO_TOKEN")
        .or_else(|_| fs::read_to_string(home.join("core.token")))
        .map_err(|e| e.to_string())?;
    // v1a-06: CLI commands always authenticate to their own core first.
    let request = if let Ok(machine) = std::env::var("NUNCHIRO_MACHINE") {
        Request::Remote {
            machine,
            request: Box::new(request),
        }
    } else {
        request
    };
    call_with_token_by(home, &token, request, until)
}
pub(crate) fn call_with_token(home: &Path, token: &str, request: Request) -> Response {
    call_with_token_by(home, token, request, None)
}
fn call_with_token_by(
    home: &Path,
    token: &str,
    request: Request,
    until: Option<Instant>,
) -> Response {
    let mut stream = UnixStream::connect(home.join("core.sock")).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    // V2-1b: `serve restart` asks the core to exit
    let stopping = matches!(
        request,
        Request::Stop | Request::Exit | Request::ExitIfIdle { .. }
    );
    let mut bytes = serde_json::to_vec(&Envelope {
        token: token.into(),
        request,
    })
    .map_err(|e| e.to_string())?;
    if bytes.len() as u64 >= FRAME_BYTES {
        return Err("request exceeds frame limit".into());
    }
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(Until { stream, until }.take(8 * 1024 * 1024))
        .read_line(&mut line)
        .map_err(|e| {
            if stopping
                && matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                )
            {
                "core did not answer stop".into()
            } else {
                e.to_string()
            }
        })?;
    serde_json::from_str(&line).map_err(|e| e.to_string())?
}

/// A reply stream whose every read waits at most until `until`, so the deadline is the whole reply's, not each read's.
struct Until {
    stream: UnixStream,
    until: Option<Instant>,
}
impl Read for Until {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if let Some(until) = self.until {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            // macOS answers EINVAL to SO_RCVTIMEO once the peer has closed: a core that replied and hung up before
            // this first read. The reply is still there to read, and a closed peer cannot make the read wait.
            match self
                .stream
                .set_read_timeout(Some(left.min(Duration::from_secs(15))))
            {
                Err(e) if e.raw_os_error() != Some(libc::EINVAL) => return Err(e),
                _ => {}
            }
        }
        self.stream.read(buf)
    }
}

/// v1a-66: macOS `sun_path` holds 103 bytes plus the NUL; Linux's 108 is not used, so a home that works on one
/// platform works on both.
pub const SOCKET_PATH_MAX: usize = 103;

/// F24: this binary's build stamp (an RC's or an official release's), set once by `nunchiro serve`; `core.start.json`
/// keeps it for `serve update`.
pub static BUILD: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
/// Ticket 1082: this binary's git commit (short), set once by `nunchiro serve`; `core.start.json` keeps it, so an update
/// can tell that the running core is the new build.
pub static COMMIT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// F24: left by a full stop or a signal until the next core starts, so the app can tell those from a crash.
const STOPPED: &str = "core.stopped";

static SIGNALLED: AtomicBool = AtomicBool::new(false);
extern "C" fn signalled(_: libc::c_int) {
    SIGNALLED.store(true, Ordering::SeqCst); // an atomic store is async-signal-safe
}
/// Routes SIGTERM, SIGINT and SIGHUP to `SIGNALLED`, which the accept loop polls. A signal the core was started
/// ignoring (`nohup`) stays ignored.
fn on_signals() {
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe {
            let mut old: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(sig, std::ptr::null(), &mut old) != 0
                || old.sa_sigaction == libc::SIG_IGN
            {
                continue;
            }
            let mut new: libc::sigaction = std::mem::zeroed();
            new.sa_sigaction = signalled as extern "C" fn(libc::c_int) as libc::sighandler_t;
            new.sa_flags = libc::SA_RESTART | libc::SA_RESETHAND; // a second signal kills at once; the sweep covers it
            libc::sigemptyset(&mut new.sa_mask);
            libc::sigaction(sig, &new, std::ptr::null_mut());
        }
    }
}
/// `EWOULDBLOCK` means another core holds the lock; any other errno (`flock` unsupported here) is named.
fn flock_failure(error: std::io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::EWOULDBLOCK) => "core already running".into(),
        _ => format!("cannot lock core.lock: {error}"),
    }
}

pub fn serve(home: &Path) -> Result<(), String> {
    serve_with(home, false)
}

/// Ticket 841: `serve` for a test that runs the core in its own process. It records what it would hand to macOS
/// `open` in `<home>/opened.argv`, under the same checks as `NUNCHIRO_TEST_OPENER=record`: a release build or a
/// `.nunchiro*` home opens for real. The first core in a process decides, so every in-process test core uses this.
pub fn serve_recording(home: &Path) -> Result<(), String> {
    serve_with(home, true)
}

fn serve_with(home: &Path, record: bool) -> Result<(), String> {
    let sock = home.join("core.sock");
    let len = sock.as_os_str().len();
    if len > SOCKET_PATH_MAX {
        return Err(format!(
            "core socket path {} is {len} bytes, over the {SOCKET_PATH_MAX}-byte unix socket limit; use a shorter NUNCHIRO_HOME",
            sock.display()
        ));
    }
    store::private_dir(home)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(home.join("core.lock"))
        .map_err(|e| e.to_string())?;
    // The advisory lock spans the entire core lifetime, including stale-socket recovery.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(flock_failure(std::io::Error::last_os_error()));
    }
    crate::opener::init(home, record); // ticket 800
    crate::login_path::adopt_requested(); // ticket 575: no thread runs yet (`logs::start` below starts the first)
    // v2-13a: from here, under the lock (one writer per log), stderr (every `eprintln!`) and panics go through the
    // redacting writer under logs/.
    let logs = crate::logs::start(home)?;
    // Ticket 1130 C-C3: from here each event is also kept on disk; a core without its journal still serves.
    let journal = crate::events::journal(home)
        .map_err(|e| eprintln!("event journal: {e}"))
        .ok();
    let result = serve_locked(home);
    if let Err(e) = &result {
        eprintln!("core stopped: {e}");
    }
    drop(journal);
    drop(logs);
    result
}
fn serve_locked(home: &Path) -> Result<(), String> {
    let _ = fs::remove_file(home.join(STOPPED)); // F24: this core is not the one a full stop ended
    if let Some(note) = crate::login_path::note() {
        eprintln!("{note}"); // ticket 575: once, PATH only
    }
    record_start(home)?; // v1a-23 r2
    crate::images::clean(home); // v1b-05: parts of uploads an earlier core never finished
    // v2-2d: removed accounts past their 7 days; a failed sweep never stops the core.
    if let Err(e) = crate::accounts::sweep(home, std::time::SystemTime::now()) {
        eprintln!("account trash sweep: {e}");
    }
    crate::account_signin::sweep(home); // V2.5-34i: logins a crashed core left running
    let sessions = Arc::new(Mutex::new(Sessions::open(home)?));
    let sock = home.join("core.sock");
    if let Ok(meta) = fs::symlink_metadata(&sock) {
        if !meta.file_type().is_socket() {
            return Err("core socket path is not a socket".into());
        }
        fs::remove_file(&sock).map_err(|e| e.to_string())?;
    }
    let token = store::new_id()? + &store::new_id()?;
    crate::logs::register(&token, "core"); // v2-13a
    store::atomic_write(&home.join("core.token"), token.as_bytes())?;
    let listener = UnixListener::bind(&sock).map_err(|e| e.to_string())?;
    fs::set_permissions(&sock, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stopping = Arc::new(AtomicBool::new(false));
    // Ticket 305: set with `stopping` by a full stop only, so a request refused in the wind-down says it will not be
    // served by a next core either.
    let quitting = Arc::new(AtomicBool::new(false));
    on_signals();
    let window = Arc::new(crate::http::spawn(
        home,
        sessions.clone(),
        stopping.clone(),
    )?); // v1a-13
    let observer_registry = sessions.clone();
    let observer_stopping = stopping.clone();
    let observer = thread::spawn(move || {
        // S9 r3: as the tick: every TICK while output or a transcript line came in the last ACTIVE, else every IDLE_TICK.
        let wake = crate::pty::Wake::subscribe().ok();
        let mut active_until = std::time::Instant::now() + ACTIVE;
        while !observer_stopping.load(Ordering::SeqCst) {
            let jobs = {
                let Ok(mut registry) = observer_registry.lock() else {
                    break;
                };
                registry.transcript_jobs()
            };
            for job in jobs {
                if observer_stopping.load(Ordering::SeqCst) {
                    return;
                }
                let (path, result) = job.read();
                // S9 r3: nothing new at the same path changes nothing; skip the registry lock and its board pass.
                if matches!(result, Ok(None)) && path == job.path {
                    continue;
                }
                active_until = std::time::Instant::now() + ACTIVE;
                let Ok(mut registry) = observer_registry.lock() else {
                    return;
                };
                if observer_stopping.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(error) = registry.apply_transcript(job, path, result) {
                    eprintln!("transcript observer: {error}");
                }
            }
            let period = if std::time::Instant::now() < active_until {
                TICK
            } else {
                IDLE_TICK
            };
            // Only an idle wait ends on output: while active, output keeps it at TICK, never faster.
            match &wake {
                Some(wake) if period == IDLE_TICK => wait_readable(&[wake.fd()], period),
                _ => thread::sleep(period),
            }
            if wake.as_ref().is_some_and(crate::pty::Wake::drain) {
                active_until = std::time::Instant::now() + ACTIVE;
            }
        }
    });
    // V2-8a: the auto-clean task; it does nothing while its setting is off.
    let cleaner =
        crate::worktree_clean::spawn(home.to_path_buf(), sessions.clone(), stopping.clone())
            .map_err(|e| e.to_string())?;
    // Ticket 335: the default-branch fast-forward; it does nothing while its setting is off.
    let _auto_pull =
        crate::auto_pull::spawn(sessions.clone(), stopping.clone()).map_err(|e| e.to_string())?;
    // V2-CF5: the keep-awake task; it holds nothing while its setting is off.
    let keep_awake = crate::keep_awake::spawn_ticker(sessions.clone(), stopping.clone())
        .map_err(|e| e.to_string())?;
    // Ticket 1081: team auto-advance, a pass about every 30 s on its own thread (git and files read off the lock).
    let _advance = crate::advance::spawn(sessions.clone(), home.to_path_buf(), stopping.clone())
        .map_err(|e| e.to_string())?;
    // V2.5-11: scheduled runs; it sees `stopping` before each start.
    let _schedule =
        crate::schedule::spawn(sessions.clone(), stopping.clone()).map_err(|e| e.to_string())?;
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let draining = Arc::new(AtomicBool::new(false)); // V1A-74 follow-up
    let judging = Arc::new(AtomicBool::new(false)); // ticket 1004: a check-in judge runs
    let mut last_tick = std::time::Instant::now();
    // S9 r3: the tick runs every TICK while anything moved in the last ACTIVE (a core request, agent output, an agent's
    // end or a holder's), else every IDLE_TICK. Output and holder ends ring `wake`, which this loop waits on.
    let wake = crate::pty::Wake::subscribe().ok();
    let mut active_until = std::time::Instant::now() + ACTIVE;
    while !stopping.load(Ordering::SeqCst) {
        // V2.5-34i: SIGTERM, SIGINT or SIGHUP takes the `exit` path (agents keep running for the next core, no
        // sign-in login outlives this one), then the core winds down as after an `exit` request.
        if SIGNALLED.load(Ordering::SeqCst) {
            exit_on_signal(home, &sessions);
            stopping.store(true, Ordering::SeqCst);
            continue;
        }
        if wake.as_ref().is_some_and(crate::pty::Wake::drain) {
            active_until = std::time::Instant::now() + ACTIVE;
        }
        let period = if std::time::Instant::now() < active_until {
            TICK
        } else {
            IDLE_TICK
        };
        if last_tick.elapsed() >= period {
            let pending = {
                let mut registry = sessions
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                if let Err(error) = registry.tick() {
                    eprintln!("waiting observer: {error}");
                }
                registry.scrollback_pending()
            };
            // Ticket 1002 lane 2: an Outbox card past its undo time wakes the Home lead to send it, off the lock.
            crate::team::wake_goals(&sessions);
            // V1A-74 follow-up: exited sessions' scrollback is masked and written on its own thread, off the
            // registry lock and off this loop, so neither accepts nor the next tick wait for it.
            if pending && !draining.swap(true, Ordering::SeqCst) {
                let (registry, done) = (sessions.clone(), draining.clone());
                let spawned = thread::Builder::new().spawn(move || {
                    // Cleared on the way out even if the drain panics, so a later tick drains again.
                    struct Done(Arc<AtomicBool>);
                    impl Drop for Done {
                        fn drop(&mut self) {
                            self.0.store(false, Ordering::SeqCst);
                        }
                    }
                    let _done = Done(done);
                    Sessions::drain_scrollback(&registry);
                });
                if let Err(e) = spawned {
                    eprintln!("scrollback drain: no thread ({e}); trying at the next tick");
                    draining.store(false, Ordering::SeqCst);
                }
            }
            // Ticket 1004: a seat's turn ended (a check-in): whether its task moved is read from git, so off the
            // registry lock and off this loop, as the scrollback above. One judge thread at a time; what waits for
            // it is one check-in per task.
            Sessions::start_judge(&sessions, home, &judging);
            last_tick = std::time::Instant::now();
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                active_until = std::time::Instant::now() + ACTIVE;
                if let Err(e) = stream.set_nonblocking(false) {
                    eprintln!("socket configuration failed; retrying: {e}");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if active.load(Ordering::SeqCst) >= 32 {
                    continue;
                }
                let sessions = sessions.clone();
                let token = token.clone();
                let stopping = stopping.clone();
                let quitting = quitting.clone();
                let home = home.to_path_buf(); // v1a-06
                let window = window.clone(); // v1a-13
                let spawned = counted(&active, move || {
                    let result = connection(
                        &mut stream,
                        &token,
                        &sessions,
                        &stopping,
                        &quitting,
                        &home,
                        &window,
                    );
                    if let Err(e) = result {
                        eprintln!("socket request failed: {e}");
                    }
                });
                if let Err(e) = spawned {
                    eprintln!("socket request: no thread ({e}); closed unanswered");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // S9: wait on the listener until a connect arrives or the next tick is due, not a 10 ms retry. r3: or
                // until output wakes the tick.
                let left = period.saturating_sub(last_tick.elapsed());
                let listener = std::os::fd::AsRawFd::as_raw_fd(&listener);
                // Only an idle wait ends on output: while active, output keeps the tick at TICK, never faster.
                match &wake {
                    Some(wake) if period == IDLE_TICK => {
                        wait_readable(&[listener, wake.fd()], left)
                    }
                    _ => wait_readable(&[listener], left),
                }
            }
            Err(e) => {
                eprintln!("socket accept failed; retrying: {e}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    // Launch preparation is outside the registry; let its bounded commands and rollback finish. For the first 5 s of
    // that wait, a connect that queued after the stop reply gets NOT_SERVED rather than a closed socket; refusals never
    // extend the wait. After it, or in the instant between the last accept and the drop, a connect is refused or
    // closed unanswered.
    let (refusing, until) = (
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        std::time::Instant::now() + Duration::from_secs(5),
    );
    let quit = quitting.load(Ordering::SeqCst); // ticket 305: stored before `stopping`, which ended the loop
    let refuse = |mut stream: UnixStream| {
        // Over the cap a connect is dropped unanswered, as in the accept loop.
        if refusing.load(Ordering::SeqCst) >= 32 {
            return;
        }
        refusing.fetch_add(1, Ordering::SeqCst);
        let done = refusing.clone();
        let spawned = thread::Builder::new().spawn(move || {
            refuse_stopping(&mut stream, quit);
            done.fetch_sub(1, Ordering::SeqCst);
        });
        if spawned.is_err() {
            refusing.fetch_sub(1, Ordering::SeqCst);
        }
    };
    while active.load(Ordering::SeqCst) != 0 && std::time::Instant::now() < until {
        match listener.accept() {
            Ok((stream, _)) => refuse(stream),
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    // The connects that queued during the last sleep; bounded, so a connect flood cannot hold the drop.
    for _ in 0..32 {
        match listener.accept() {
            Ok((stream, _)) => refuse(stream),
            Err(_) => break,
        }
    }
    drop(listener);
    while active.load(Ordering::SeqCst) != 0 {
        thread::sleep(Duration::from_millis(10));
    }
    // v1a-06: each refresh has a bounded transport; let it retire its owned SSH group.
    while !sessions
        .lock()
        .map_err(|_| "session registry unavailable")?
        .remote
        .refreshing
        .is_empty()
    {
        thread::sleep(Duration::from_millis(10));
    }
    // Outside filesystem I/O cannot keep the core alive; late results are discarded above.
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    while !observer.is_finished() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    if observer.is_finished() {
        observer
            .join()
            .map_err(|_| "transcript observer stopped unexpectedly")?;
    }
    // V2-8a: the auto-clean pass sees `stopping` before each step and starts no new removal; one already started
    // (its git calls are bounded) finishes. Waited for up to 30 s; past that the core exits and a half-done removal is
    // a gone record the window cleans up.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !cleaner.is_finished() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    // V2-CF5: at most one tick (1 s) to release its assertion, and never more than 2 s.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !keep_awake.is_finished() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    fs::remove_file(sock).map_err(|e| e.to_string())?;
    Ok(())
}
/// The reply to a connection the stopping core accepted after its accept loop ended: one short read of the
/// request (so the reply does not race unread input), then NOT_SERVED. Bounded to about 200 ms per peer.
/// V2.5-34i: the `exit` a signal asks for. Q9 en-a-J5-3: as after an `exit` request, the scrollback of sessions that
/// ended just before is written (after a drain already running on the tick's thread) before the core winds down.
fn exit_on_signal(home: &Path, sessions: &Mutex<Sessions>) {
    let _ = fs::write(home.join(STOPPED), b""); // F24: asked for, so the app does not start it again
    if let Err(e) = sessions
        .lock()
        .map_err(|_| "session registry unavailable".to_string())
        .and_then(|mut r| r.leave())
    {
        eprintln!("exit on signal: {e}");
    }
    Sessions::drain_scrollback(sessions);
}

fn refuse_stopping(stream: &mut UnixStream, quit: bool) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
    // A connect that sends nothing (the CLI's liveness probe) is not logged.
    if stream.read(&mut [0; 4096]).is_ok_and(|n| n > 0) {
        eprintln!("{NOT_SERVED_LOG}");
    }
    let response: Response = Err(if quit { NOT_SERVED_QUIT } else { NOT_SERVED }.into());
    if let Ok(mut bytes) = serde_json::to_vec(&response) {
        bytes.push(b'\n');
        let _ = stream.write_all(&bytes);
    }
}

/// The owner's request for another machine: the CLI's `--machine`, and the window's New session on a machine (ticket
/// 980; real SSH look 11-17: the window's own loop had no arm for it, so every start there was refused with "transport
/// requires owner dispatch"). A local owner-only operation is never forwarded.
pub(crate) fn remote_from_owner(
    sessions: &Mutex<Sessions>,
    home: &Path,
    token: &str,
    machine: String,
    request: Request,
    stopping: &AtomicBool,
) -> Response {
    // v1a-06 merge: these new window/owner APIs stay local, never SSH-forwarded.
    if matches!(
        request,
        Request::ChatPage { .. }
            | Request::HandoffPreview { .. } // v2-3b
            | Request::HandoffSend { .. }
            | Request::PrChip { .. } // v2-8b
            | Request::PrLive { .. } // v2-8c
            | Request::PrLiveSet { .. }
            | Request::PrWatch { .. }
            | Request::PrFront { .. }
            | Request::PrView { .. } // V2.5-8/9
            | Request::PrList
            | Request::PrMerge { .. }
            | Request::PrBranch { .. } // ticket 373
            | Request::FilesList { .. }
            | Request::FileRead { .. }
            | Request::FileWrite { .. } // ticket 820: a write on this Mac only
            | Request::FilesSearch { .. }
            | Request::ApprovalStatus { .. }
            | Request::ApprovalGrant { .. }
            | Request::SetupStatus { .. } // ticket 259: this Mac's worktrees and approvals
            | Request::SetupGrant { .. }
            | Request::AgentCommandStatus { .. } // ticket 358: this Mac's own command
            | Request::AgentCommandCheck { .. }
            | Request::AgentCommandGrant { .. }
            | Request::AgentCommandReset { .. }
            | Request::AcpAgentStatus { .. } // V2-4a: approving an agent is local and human-only
            | Request::AcpAgentGrant { .. }
            | Request::AcpAgents // V2-4b: the setup requests are local and the owner's alone
            | Request::AcpAgentCheck { .. }
            | Request::AcpAgentAdd { .. }
            | Request::AcpAgentLogin { .. }
            | Request::AcpAgentSignIn { .. }
            | Request::AcpAgentSignInState { .. }
            | Request::AcpAgentSignInCancel { .. }
            | Request::AcpAgentSignOut { .. }
            | Request::AgentUpdateStart { .. } // ticket 358: an installer runs here
            | Request::AgentUpdateCancel { .. }
            | Request::AgentUpdateState
            | Request::ExtensionsList // ticket 276: agent extensions are this Mac owner's alone
            | Request::ExtensionsMcpAdd { .. }
            | Request::ExtensionsMcpRemove { .. }
            | Request::ExtensionsItemFiles { .. }
            | Request::ExtensionsItemRead { .. }
            | Request::ExtensionsItemSave { .. }
            | Request::ExtensionsSkillNew { .. }
            | Request::ExtensionsItemRemove { .. }
            | Request::BoardResolve { .. } // v1b-18
            | Request::WidgetList // v1b-19
            | Request::WidgetRun { .. } // v1b-19
            | Request::WidgetAct { .. } // v1b-20
            | Request::WidgetPage { .. } // v1b-22
            | Request::ImagePut { .. } // v1b-05
            | Request::AccountList // v2-2a
            | Request::AccountCheck { .. }
            | Request::AccountAdd { .. }
            | Request::AccountRemove { .. } // v2-2d
            | Request::AccountRename { .. } // ticket 358
            | Request::AccountSignIn { .. } // ticket 178 finding 20: a login runs and a browser opens here
            | Request::AccountSignInCode { .. }
            | Request::AccountSignInCancel { .. }
            | Request::AccountSignInState { .. }
            | Request::AddMachine { .. }
            | Request::ForgetMachine { .. }
            | Request::MachineDetails { .. }
            | Request::MachineAliases // v25f: reads this Mac's ~/.ssh
            | Request::MachineProbe { .. }
            | Request::MachineShare // ticket 1050
            | Request::MachineTrust { .. }
            | Request::SessionContext { .. } // CHAT-USAGE: window-local transcript data
            | Request::Subagents { .. } // V2-CF4: window-local transcript data, as SessionContext
            | Request::AccountUsage { .. } // v2-2c
            | Request::UsageDetail { .. } // v4 Usage page
            | Request::CodexResetRead { .. } // needs 225: a reset is never used on or from another machine
            | Request::CodexResetUse { .. }
            | Request::CodexResetLog
            | Request::UserCommands { .. } // ticket-98
            | Request::FirstRun // v2-5a
            | Request::GitProviders { .. } // v25f: the CLI logins of this Mac
            | Request::ProjectCreate { .. } // ticket 370: makes a folder at a typed location
            | Request::OpenInEditor { .. } // V2.5-15: an editor opens on this Mac only
            | Request::EditorApps // ticket 375: this Mac's apps
            | Request::ProblemFix { .. } // v2-5b
            | Request::LimitResume { .. } // ticket 372: a timer that types into a local session
            | Request::TeamOpen { .. } // ticket 990: a seat opens on this Mac, for its own lead
            | Request::Task { .. } // ticket 990 slice g: the ledger is this core's
            | Request::Note { .. } // ticket 990 slice h
            | Request::Role { .. } // ticket 990 slice i
            | Request::CloseUndo { .. } // V2-6d
            | Request::CloseIdle { .. } // ticket 1130: the window's restart for a new MCP server
            | Request::ScheduleList // V2.5-11: a timer that starts agent work stays local
            | Request::ScheduleAdd { .. }
            | Request::ScheduleRemove { .. }
            | Request::ScheduleRunNow { .. } // ticket 993
            | Request::SchedulePause { .. }
            | Request::SchedulePropose { .. }
            | Request::ScheduleChange { .. }
            | Request::BotOffer { .. } // a bot is made on this Mac, by its owner's yes
            | Request::OutboxStage { .. } // ticket 1002: the Outbox is this Mac's
            | Request::OutboxSpend { .. }
            | Request::LibsResolve { .. } // v2-10c
            | Request::LibsEntry { .. }
            | Request::TokenCreate { .. } // ticket 573: a token is for this core only
            | Request::TokenList
            | Request::TokenRevoke { .. }
            | Request::WindowAuth // v1a-13: the window token never leaves this machine
    ) {
        return Err("operation is local owner-only; remote forwarding is not permitted".into());
    }
    crate::machines::dispatch(sessions, home, true, token, machine, request, stopping)
}

fn connection(
    stream: &mut UnixStream,
    token: &str,
    sessions: &Arc<Mutex<Sessions>>,
    stopping: &Arc<AtomicBool>,
    quitting: &AtomicBool,  // ticket 305
    home: &Path,            // v1a-06
    window: &(u16, String), // v1a-13
) -> Result<(), String> {
    let peer = crate::peer::of(stream); // v1a-13: read at once, before the peer can exit
    // V2.5-39, V2.5-48: the turn-end nudge's reply budget counts from here at the latest (`nudge::counted_from`).
    let (arrived, arrived_ms) = (std::time::Instant::now(), crate::queue::now_ms());
    // V2.5-48: a nudge whose history line is written, until its reply is handed over.
    let mut nudged = None;
    // Ticket 571: the question hook whose ask is recorded, until its deny is handed over.
    let mut asked = None;
    // A peer that already closed (the CLI's liveness probe) makes macOS `setsockopt` fail with EINVAL: nothing to
    // serve, nothing to log.
    for set in [UnixStream::set_read_timeout, UnixStream::set_write_timeout] {
        match set(stream, Some(Duration::from_secs(2))) {
            Err(e) if e.raw_os_error() == Some(libc::EINVAL) => return Ok(()),
            result => result.map_err(|e| e.to_string())?,
        }
    }
    let mut line = String::new();
    BufReader::new((&mut *stream).take(FRAME_BYTES))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let mut outside = false; // ticket 573 round 3: an outside token's request
    let mut presented = None; // round 6: a non-owner credential, resolved for the redaction below
    let peer_fd = std::os::fd::AsRawFd::as_raw_fd(stream);
    let response: Response = (|| {
        if !line.ends_with('\n') {
            return Err("incomplete or oversized request".into());
        }
        let mut env: Envelope = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        outside = env.token.starts_with(crate::tokens::SECRET_PREFIX);
        // v1a-06: network I/O never holds the local session registry.
        let mut owner = token_equal(env.token.as_bytes(), token.as_bytes());
        // v1a-13, v1a-23 (needs 47): the owner token is owner authority only for a peer outside every session of
        // this core. From inside one it is that session's caller, exactly like its session token (owner commands,
        // not the human set). Every later owner check below therefore sees an outside peer.
        if owner && let Some(session_token) = inside_token(&peer, sessions)? {
            env.token = session_token;
            owner = false;
        }
        if !owner {
            presented = Some(env.token.clone());
        }
        if let Request::WindowAuth = env.request {
            // Ticket 1002 (Fable lane 2 review M1): the window's token (which answers Outbox cards) goes to the app only.
            let app = peer.as_ref().is_ok_and(|p| crate::peer::is_app(p, home));
            return if owner && app {
                Ok(Reply::WindowAuth {
                    port: window.0,
                    token: window.1.clone(),
                })
            } else {
                Err("operation not granted".into())
            };
        }
        // V2.5-20: browser verbs wait for the app off the registry lock; the space is the session the token resolves to.
        if let Some(reply) = crate::browser::serve(home, owner, &env.request, || {
            let sessions = sessions
                .lock()
                .map_err(|_| "session registry unavailable")?;
            let caller = sessions.agent_caller(&env.token)?;
            // Ticket 1002 lane 1 (Fable check M4): the chief of staff has no browser in v1 (the owner's logins).
            if sessions.locked(&caller.id) {
                return Err("the chief of staff's seat has no browser in v1".into());
            }
            // Ticket 573: a browser space is a session's; no token has one, nor a token session (round 5).
            match sessions.token_of(&caller) {
                Some(_) => Err("operation not granted".into()),
                None => Ok(caller.id),
            }
        }) {
            return reply;
        }
        // v2-10c: the library cache, read by the owner only (the app's `serve`); never a session or remote caller.
        // Unlocked: a resolve hashes stored files and never waits on the network.
        match &env.request {
            Request::LibsResolve { .. }
            | Request::LibsEntry { .. }
            | Request::TokenCreate { .. }
            | Request::TokenList
            | Request::TokenRevoke { .. }
                if !owner =>
            {
                return Err("operation not granted".into());
            }
            // Ticket 573: outside-caller tokens are the owner's to make; the file is read without the registry lock.
            Request::TokenCreate {
                scope,
                project,
                expires_in_ms,
            } => {
                return crate::tokens::create(home, *scope, project.as_deref(), *expires_in_ms)
                    .map(|(token, secret)| Reply::TokenCreated { token, secret });
            }
            Request::TokenList => {
                return crate::tokens::list(home).map(|tokens| Reply::Tokens { tokens });
            }
            Request::TokenRevoke { id } => {
                return crate::tokens::revoke(home, id).map(|()| Reply::Ack);
            }
            Request::LibsResolve { urls, requester } => {
                return crate::libs::Libs::open(home)
                    .resolve(urls, requester)
                    .map(|results| Reply::LibsResolve { results });
            }
            Request::LibsEntry { sha384 } => {
                let found = crate::libs::Libs::open(home).served(sha384);
                return Ok(Reply::LibsEntry {
                    path: found.as_ref().map(|(_, p)| p.clone()),
                    entry: found.map(|(e, _)| e),
                });
            }
            _ => {}
        }
        match env.request {
            Request::Remote { machine, request } if owner => {
                return remote_from_owner(sessions, home, &env.token, machine, *request, stopping);
            }
            Request::MachineStatus { label, retry } if owner => {
                return crate::machines::status(sessions, home, label, retry);
            }
            Request::Forwarded { caller, request } if owner => {
                return crate::machines::forwarded(sessions, caller, *request, stopping);
            }
            _ => {}
        }
        let registry = sessions;
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        // Ticket 1002 lane 1 (Fable review S1, Codex MUST): a locked seat's request is judged before every arm below
        // (agent read, events, worktrees, ask_owner cards, Remote), not only in `check_agent`.
        if !owner
            && let Ok(caller) = sessions.agent_caller(&env.token)
            && sessions.locked(&caller.id)
        {
            sessions.check_locked(&caller, &env.request)?;
        }
        if let Request::AgentRead { id, source, lines } = &env.request
            && source == "transcript"
        {
            if stopping.load(Ordering::SeqCst) {
                return Err("core is stopping".into());
            }
            let owner = token_equal(env.token.as_bytes(), token.as_bytes());
            if !owner {
                let caller = sessions.agent_caller(&env.token)?;
                sessions.check_agent(&caller, &env.request)?;
            }
            let plan = sessions.transcript_read(id, *lines)?;
            drop(sessions);
            let reply = plan.read();
            let sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            if stopping.load(Ordering::SeqCst) {
                return Err("core is stopping".into());
            }
            if !owner {
                let caller = sessions.agent_caller(&env.token)?;
                sessions.check_agent(&caller, &env.request)?;
            }
            if !sessions.transcript_read_current(&plan) {
                return Err("transcript identity changed during read".into());
            }
            return reply;
        }
        // Ticket 573 slice 2: a session's token (or the owner token from inside a session, swapped above) reads its own
        // project's events only.
        if let Request::Events { project, since } = &env.request {
            let owner = token_equal(env.token.as_bytes(), token.as_bytes());
            // A remote-flagged caller (V1A-04) sees only the sessions it owns, as in its snapshot.
            let (mine, room, owned) = if owner {
                (None, None, None)
            } else {
                let caller = sessions.agent_caller(&env.token)?;
                sessions.check_agent(&caller, &env.request)?;
                let owned = sessions.owned_sessions(&caller);
                // Ticket 573 round 3: an outside token for every project has an empty project.
                let mine = Some(caller.project.clone()).filter(|p| !p.as_os_str().is_empty());
                // Room events follow the room API: a session reads its room (the top of its parent chain), a token
                // the project it was made for. A caller with no room sees none.
                let room = match mine {
                    Some(_) if caller.id.starts_with(crate::tokens::CALLER) => mine.clone(),
                    Some(_) => Some(sessions.room_project(&caller.id).unwrap_or_default()),
                    None => None,
                };
                (mine, room, owned)
            };
            drop(sessions);
            // A token's project is canonical; a session's may not be (/var and /private/var).
            let within = |m: &Option<std::path::PathBuf>, p: &Path| {
                m.as_ref().is_none_or(|m| {
                    *m == p
                        || fs::canonicalize(p).is_ok_and(|p| p == *m)
                        || fs::canonicalize(m).is_ok_and(|m| m == p)
                })
            };
            let (events, latest, gap) = crate::events::read(*since, |e| {
                within(
                    if e.kind.starts_with("room_") {
                        &room
                    } else {
                        &mine
                    },
                    &e.project,
                ) && project.as_ref().is_none_or(|q| *q == e.project)
                    && owned
                        .as_ref()
                        .is_none_or(|o| e.session.as_ref().is_some_and(|s| o.contains(s)))
            });
            return Ok(Reply::Events {
                events,
                latest,
                gap,
            });
        }
        // Ticket 259: a setup approval is a person's in the window or the token-less CLI; never a session's or a token's.
        if let Request::SetupStatus { .. } | Request::SetupGrant { .. } = &env.request {
            if !owner {
                return Err("operation not granted".into());
            }
            drop(sessions);
            return crate::worktree_setup::serve(registry, env.request);
        }
        if let Request::Worktree { .. } = &env.request {
            let owner = token_equal(env.token.as_bytes(), token.as_bytes());
            drop(sessions);
            return worktree(
                registry,
                (!owner).then_some(env.token.as_str()),
                env.request,
                Some(stopping.as_ref()),
            );
        }
        // v1a-23: a session caller runs the owner path below with its caller checks: the human set becomes a
        // waiting item (`ask_owner`), `check_agent` refuses what stays the user's, `handle_agent` keeps send
        // attribution and the answer rules.
        let caller = if owner || sessions.authorize_hook(&env.token, &env.request) {
            None
        } else {
            // Ticket 1002 lane 1 (Fable check M5c): a locked seat's lock does not exist on another machine.
            if matches!(env.request, Request::Remote { .. })
                && sessions
                    .agent_caller(&env.token)
                    .is_ok_and(|c| sessions.locked(&c.id))
            {
                return Err("the chief of staff's seat works on this Mac only".into());
            }
            if let Request::Remote { machine, request } = env.request {
                // Ticket 573: an outside token reaches this Mac's core only. Round 5 (security r4 MUST 1): by the resolved
                // caller, so a token session's own credential, which is the token (`agent_caller`), is held too.
                if sessions
                    .agent_caller(&env.token)
                    .is_ok_and(|c| sessions.token_of(&c).is_some())
                {
                    return Err("operation not granted to a token on another machine".into());
                }
                drop(sessions);
                return crate::grants::dispatch_remote(
                    registry, &env.token, machine, *request, stopping,
                );
            }
            let caller = sessions.agent_caller(&env.token)?;
            if let Some(reply) = sessions.ask_owner(&caller, &env.request) {
                return reply;
            }
            sessions.check_agent(&caller, &env.request)?;
            Some(caller)
        };
        // Ticket 305: a request that waited on the registry lock while a Stop or Exit ran has not run, so it gets the
        // wind-down refusal (the CLI reruns NOT_SERVED on the next core), not the bare "core is stopping".
        if stopping.load(Ordering::SeqCst) {
            return Err(if quitting.load(Ordering::SeqCst) {
                NOT_SERVED_QUIT
            } else {
                NOT_SERVED
            }
            .into());
        }
        // Q9 en-b-J6-2: an added folder is checked on disk off the registry lock (owner only: `check_agent` above).
        if caller.is_none()
            && let Request::TreeEdit { edit } = env.request
        {
            drop(sessions);
            let edit = edit.checked()?;
            return registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .handle(Request::TreeEdit { edit });
        }
        // Ticket 1040: as the added folder above (owner only).
        if caller.is_none() && matches!(env.request, Request::ProjectFolders) {
            drop(sessions);
            return crate::sessions::locate::folders(registry);
        }
        if caller.is_none()
            && let Request::ProjectLocate { from, to } = &env.request
        {
            drop(sessions);
            return crate::sessions::locate::serve(registry, from, to);
        }
        if caller.is_none() && matches!(env.request, Request::SwitchModel { .. }) {
            drop(sessions);
            return crate::sessions::switch_model(registry, env.request); // Q9 en-b-J7-2
        }
        if let Request::ForgetMachine { alias } = env.request {
            drop(sessions);
            return crate::sessions::forget_machine(registry, &alias);
        }
        if let Request::MachineDetails { alias } = env.request {
            drop(sessions);
            return crate::machines::discovery::reply(registry, alias);
        }
        // v25f: outside the registry lock, as MachineDetails; a probe may wait on ssh for seconds.
        if let Request::MachineAliases = env.request {
            drop(sessions);
            return crate::machines::aliases::reply(registry, home);
        }
        if let Request::MachineProbe { host, user, port } = env.request {
            drop(sessions);
            return crate::machines::aliases::probe(&host, user.as_deref(), port);
        }
        if let Request::MachineShare = env.request {
            drop(sessions);
            return crate::machines::share::reply();
        }
        if let Request::MachineTrust { alias, link } = env.request {
            drop(sessions);
            return crate::machines::share::trust(registry, home, &alias, &link);
        }
        // v1b-19: owner only (v1a-23: `check_agent` above refuses these to session callers).
        if matches!(
            env.request,
            Request::WidgetList | Request::WidgetRun { .. } | Request::WidgetPage { .. } // v1b-22
        ) {
            return crate::widgets::handle(home, sessions, env.request);
        }
        // v1b-20: owner only, like the two above; the act locks the registry itself.
        if matches!(env.request, Request::WidgetAct { .. }) {
            drop(sessions);
            return crate::widgets::act::handle(home, registry, Some(stopping), env.request);
        }
        // v2-2a: owner only (`check_agent` above refuses session callers); probes and the login start run unlocked.
        // v2-2d: so does remove, which takes the registry lock itself.
        if matches!(
            env.request,
            Request::AccountList
                | Request::AccountCheck { .. }
                | Request::AccountAdd { .. }
                | Request::AccountRename { .. }
                | Request::AccountRemove { .. }
        ) {
            drop(sessions);
            return crate::accounts::handle(home, registry, Some(stopping), env.request);
        }
        // Needs 225: codex runs for up to 40 s, so off the registry lock. A session caller reaches only the use (its ask,
        // under the owner's policy); `check_agent` above refused it the read and the log.
        if matches!(
            env.request,
            Request::CodexResetRead { .. } | Request::CodexResetUse { .. } | Request::CodexResetLog
        ) {
            drop(sessions);
            return match (env.request, &caller) {
                (Request::CodexResetUse { reason, .. }, Some(caller)) => {
                    crate::codex_reset::agent_use(registry, home, caller, &reason)
                }
                (_, Some(_)) => Err("operation not granted".into()),
                (request, None) => crate::codex_reset::owner(home, request),
            };
        }
        // Ticket 370: owner only, like the rest here; a Git step may wait up to its limit, so off the lock.
        if let Request::ProjectCreate { name, parent } = env.request {
            drop(sessions);
            return crate::projects::create(&name, parent.as_deref());
        }
        // v25f: owner only (`check_agent` refuses session callers); the probe runs CLIs for seconds, so off the lock.
        if let Request::GitProviders { login, logout } = env.request {
            drop(sessions);
            return crate::git_providers::handle(registry, Some(stopping), login, logout);
        }
        // v2-2c: reads transcripts, so off the registry lock.
        if let Request::AccountUsage { limits } = env.request {
            drop(sessions);
            let reply = crate::usage::reply(home, limits);
            crate::account_near::after_usage(
                registry,
                home,
                &reply,
                crate::queue::now_ms() as i64 / 1000,
            );
            return reply;
        }
        if let Request::UsageDetail {
            days,
            account,
            sessions: only,
        } = env.request
        {
            drop(sessions);
            return crate::usage::detail_reply(
                home,
                days,
                crate::usage::Filter::new(account, only),
            );
        }
        // ticket-98: owner only (`check_agent` refuses session callers); reads the user's command files, off the registry lock.
        if let Request::UserCommands { kind } = &env.request {
            let kind = *kind;
            drop(sessions);
            return crate::user_commands::reply(kind);
        }
        // v2-5a: owner only like the accounts; runs `--version`, so off the registry lock.
        if matches!(env.request, Request::FirstRun) {
            drop(sessions);
            return crate::firstrun::reply();
        }
        // v2-5b: owner only (`check_agent` refuses session callers); launch preparation runs unlocked.
        if let Request::ProblemFix { id, fix } = &env.request {
            drop(sessions);
            return crate::sessions::problem_fix(registry, Some(stopping), id, *fix);
        }
        // v2-3b: owner only (`check_agent` refuses session callers); chat reads and launch preparation run unlocked.
        if let Request::HandoffPreview {
            id,
            through,
            last_five,
        } = &env.request
        {
            drop(sessions);
            return crate::http::read_handoff(registry, id, through.as_deref(), *last_five);
        }
        if let Request::HandoffSend {
            from,
            to,
            text,
            acp_agent,
        } = &env.request
        {
            drop(sessions);
            return crate::sessions::handoff_send(
                registry,
                Some(stopping),
                from,
                *to,
                acp_agent.as_deref(),
                text,
            );
        }
        // V2-4b: the setup requests are the owner's alone (`check_agent` refuses session callers): the list runs
        // `--version` probes, the check runs the typed command for up to 5 s, the login starts a tab; all off the lock.
        if matches!(
            env.request,
            Request::AcpAgents
                | Request::AcpAgentCheck { .. }
                | Request::AcpAgentAdd { .. }
                | Request::AcpAgentLogin { .. }
                | Request::AcpAgentSignIn { .. }
                | Request::AcpAgentSignInState { .. }
                | Request::AcpAgentSignInCancel { .. }
                | Request::AcpAgentSignOut { .. }
        ) {
            drop(sessions);
            return crate::acp::setup(home, registry, Some(stopping), env.request);
        }
        // Ticket 358: runs the typed path's `--version` for up to 5 s, off the lock.
        if let Request::AgentCommandCheck {
            agent,
            path,
            args,
            env,
        } = env.request
        {
            drop(sessions);
            return crate::approval::command_check(home, agent, path, args, env)
                .map(|check| Reply::CommandCheck { check });
        }
        // Ticket 276: the owner's extensions requests (session callers were refused by `check`); file reads, off the lock.
        if matches!(
            env.request,
            Request::ExtensionsList
                | Request::ExtensionsMcpAdd { .. }
                | Request::ExtensionsMcpRemove { .. }
                | Request::ExtensionsItemFiles { .. }
                | Request::ExtensionsItemRead { .. }
                | Request::ExtensionsItemSave { .. }
                | Request::ExtensionsSkillNew { .. }
                | Request::ExtensionsItemRemove { .. }
        ) {
            drop(sessions);
            return crate::extensions::owner(home, env.request);
        }
        // v1b-02: authorization above is unchanged; no chat I/O under the registry lock.
        if let Request::ChatPage { id, before, after } = &env.request {
            let id = id.clone();
            // V2-4a: an ACP chat is the agent's `session/update`s, held in memory.
            if let Some(page) = sessions.acp_chat(&id, *before, *after) {
                return page.map(|page| Reply::ChatPage { session: id, page });
            }
            let plan = sessions.chat_plan(&id, *before, *after)?;
            drop(sessions);
            return plan
                .read()
                .map(|page| Reply::ChatPage { session: id, page });
        }
        // Ticket 990: a lead opens a teammate of its place; the seat starts as the lead's worker.
        if let Request::TeamOpen { name, level } = &env.request {
            let caller = caller.as_ref().ok_or(
                "team open is for a lead's session; the owner opens a teammate in Settings > Team",
            )?;
            let id = sessions.lead_may_open(caller, name)?;
            drop(sessions);
            return crate::team::open_seat(
                registry,
                &id,
                None,
                *level,
                crate::team::Opener::Lead(caller),
            )
            .map(crate::team::Opened::reply);
        }
        // Ticket 993: the owner's Run now (`check_agent` above refused a session caller); the start runs off the lock.
        if let Request::ScheduleRunNow { id } = &env.request {
            drop(sessions);
            return crate::schedule::run_now(registry, id);
        }
        // Ticket 990 slices g to i: the ledger, notes and roles read git and small files, off the lock.
        if matches!(
            env.request,
            Request::Task { .. } | Request::Note { .. } | Request::Role { .. }
        ) {
            drop(sessions);
            return crate::ledger::dispatch(registry, caller.as_ref(), env.request);
        }
        if let Request::Start {
            session,
            folder,
            env: start_env,
            receipt,
        } = env.request
        {
            // Ticket 573 slice 2 (Orca): a receipt is the caller's own; a retry waits out a start still running with it.
            let mut claim = Receipt(None);
            if let Some(receipt) = receipt {
                check_receipt(&receipt)?;
                let key = (caller.as_ref().map(|c| c.id.clone()), receipt);
                let until = std::time::Instant::now() + RECEIPT_WAIT;
                loop {
                    match receipt_claim(&key) {
                        None => break,
                        Some(Some(id)) => {
                            return sessions.handle(Request::AgentGet { id }).map(|r| match r {
                                Reply::Agent { session } => Reply::Started { session },
                                r => r,
                            });
                        }
                        Some(None) if std::time::Instant::now() < until => {
                            drop(sessions);
                            thread::sleep(Duration::from_millis(50));
                            sessions = registry
                                .lock()
                                .map_err(|_| "session registry unavailable")?;
                        }
                        Some(None) => {
                            return Err(
                                "start_receipt_busy: a start with this receipt still runs".into()
                            );
                        }
                    }
                }
                claim.0 = Some(key);
            }
            let mut launch = sessions
                .launch_as(caller.as_ref(), session.clone(), false)?
                .with_folder(folder.clone())
                .with_env(start_env)?;
            if caller.is_none() {
                launch = launch.owner_terminal(); // ticket 1008 round 2
            }
            drop(sessions);
            // v2-5b: the owner's Start of a missing agent still opens a tab, with its card.
            let mut launch = match (launch.prepare(), &caller) {
                (Ok(launch), _) => launch,
                (Err(e), None) => {
                    return registry
                        .lock()
                        .map_err(|_| "session registry unavailable")?
                        .start_failed_at(&session, folder.as_deref(), e);
                }
                (Err(e), Some(_)) => return Err(e),
            };
            let result = {
                let mut sessions = registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                if stopping.load(Ordering::SeqCst) {
                    Err("core is stopping".into())
                } else if let Some(caller) = &caller {
                    sessions
                        .agent_caller(&env.token)
                        .and_then(|_| sessions.start_granted(caller, &launch, false))
                } else {
                    sessions.start(&launch)
                }
            };
            // F15: off the lock, so a folder that does not answer holds this request only.
            let result = result.map_err(|e| {
                crate::sessions::refused_start(
                    crate::sessions::probe_folder,
                    session.kind,
                    &launch.cwd,
                    e,
                )
            });
            if let Ok(session) = &result {
                launch.committed = true;
                claim.started(&session.id);
            }
            // V2-4b: an owner's ACP agent that cannot start leaves a failed row with its card (none for an entry not
            // approved or changed: the window opens the setup sheet). A session caller's failure records nothing.
            if let Err(e) = &result
                && caller.is_none()
                && session.kind == AgentKind::Acp
            {
                return registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?
                    .start_failed_at(&session, folder.as_deref(), e.clone());
            }
            return result.map(|session| Reply::Started { session });
        }
        if let Request::Layout { args } = env.request {
            drop(sessions);
            return crate::http::layout::forward(home, args).map(|text| Reply::Text { text });
        }
        // v1b-08: file and git work runs after the registry lock is released.
        if let Some(root) = sessions.file_root(&env.request) {
            let root = root?;
            drop(sessions);
            return crate::files::run(root, env.request);
        }
        // v1b-11: diff `git` work too.
        if let Some(root) = sessions.diff_root(&env.request) {
            let (dir, base) = root?;
            drop(sessions);
            return crate::diff::run(dir, base, env.request);
        }
        // v1b-05: the image write runs after the registry lock is released.
        if let Some(home) = sessions.image_home(&env.request) {
            let home = home?;
            drop(sessions);
            return crate::images::run(&home, env.request);
        }
        // Ticket 1002 lane 2 (check M7f): an Outbox card is answered in the owner's window only. A process outside the
        // session tree reaches this socket as the owner (core.token), so an answer here never approves one.
        if let Request::Answer { item, .. } = &env.request
            && sessions.outward_card(item)
        {
            return Err("an Outbox card is answered in the Nunchiro window only".into());
        }
        // Ticket 396: an owner answer in a resize's redraw gap waits for the redraw, the registry released between tries.
        if caller.is_none() && matches!(env.request, Request::Answer { .. }) {
            drop(sessions);
            let reply = Sessions::past_busy_worktree(registry, |sessions| {
                if stopping.load(Ordering::SeqCst) {
                    return Err("core is stopping".into());
                }
                sessions.handle(env.request.clone())
            })
            .map(|(_, reply)| reply);
            // Home view change 4: a goal card's Send wakes the project's lead, its seat opened off the lock.
            crate::team::wake_goals(registry);
            return reply;
        }
        let hook_event = match &env.request {
            Request::Hook { event, payload, .. } if event == "PermissionRequest" => {
                payload["nunchiro_event_id"].as_str().map(str::to_string)
            }
            _ => None,
        };
        let hook_session = match &env.request {
            Request::Hook { id, .. } => Some(id.clone()),
            _ => None,
        };
        // Ticket 991 B3: set by `nunchiro hook --hold`, whose own bounds and the agent's hook timeout are long too.
        let hold = matches!(&env.request, Request::Hook { payload, .. } if payload["nunchiro_hold"] == true);
        let aggregate = matches!(env.request, Request::Snapshot); // v1a-06
        let listed = matches!(env.request, Request::Snapshot | Request::List); // v1a-06
        // v1b-02: retain payload until the existing queue/waiting effects have completed.
        let chat_stop = match &env.request {
            Request::Hook { id, event, payload } if event == "Stop" => {
                Some((id.clone(), payload.clone()))
            }
            _ => None,
        };
        // V2-1b: exit leaves the agents. F24: `exit_if_idle` stops only when its reply is Ok (below).
        let stop = matches!(
            env.request,
            Request::Stop | Request::Exit | Request::ExitIfIdle { .. }
        );
        let quit = matches!(env.request, Request::Stop); // ticket 305: a full stop sticks
        // V2.5-39 (ticket 187): the turn-end nudge is for the session the token and peer check resolved, the hook's
        // own; the owner's hook calls and every payload field are ignored.
        let nudge = match &env.request {
            Request::Hook { id, event, .. }
                if !owner && (event == "Stop" || event == "UserPromptSubmit") =>
            {
                sessions
                    .agent_caller(&env.token)
                    .ok()
                    .filter(|caller| caller.id == *id)
                    .map(|caller| (caller.id, event.clone()))
            }
            _ => None,
        };
        // Ticket 571 (hooks slice): a session's own question tool call may become an ask to its lead
        // (`Sessions::room_question`). The ask is recorded only while the deny can still reach the bridge (the nudge's
        // budget, counted from the bridge's start); later, or for the owner's hook calls, the hook takes today's path.
        let question = match &env.request {
            Request::Hook { id, event, payload }
                if !owner
                    && caller.is_none()
                    && event == "PreToolUse"
                    && crate::board::nudge::counted_from(
                        arrived,
                        arrived_ms,
                        started_ms(&line),
                    )
                    .elapsed()
                        <= crate::board::nudge::BUDGET =>
            {
                sessions
                    .room_question(id, event, payload)
                    .map(|decision| (decision, env.request.clone()))
            }
            _ => None,
        };
        let reply = match (&caller, question) {
            (_, Some((decision, hook))) => {
                asked = Some(hook);
                Ok(Reply::HookDecision {
                    decision: Some(decision),
                })
            }
            (Some(caller), None) => sessions.handle_agent(caller, env.request), // v1a-23
            (None, None) => sessions.handle(env.request),
        };
        if let Some(event) = hook_event.filter(|_| reply.is_ok()) {
            let wait = sessions.queue.begin_hook(&event, crate::queue::now_ms());
            // Ticket 991 B3: the one long waiter of this event; any other caller keeps the 1.4 s bound.
            // Only a request the hook itself can answer (allow or deny): a question's choice is typed on the agent's
            // own dialog, which is paired with its card once the hook has returned (seen with a real lead's question).
            let answerable = sessions.queue.items().iter().any(|i| {
                i.hook_event_id.as_deref() == Some(event.as_str())
                    && i.kind == crate::queue::Kind::Permission
            });
            // Look 11-17 v8 (area B S2-1): a question's hook is not waited for at all. Its answer is typed on the agent's
            // dialog, and while the hook waits the queue passes over that dialog's frames: the card stood 1.4 s with
            // the question and no choices. Ended now (below), the dialog pairs with the card as soon as it is drawn.
            let question = sessions.queue.items().iter().any(|i| {
                i.hook_event_id.as_deref() == Some(event.as_str())
                    && i.kind == crate::queue::Kind::Question
            });
            let wait = wait && !question;
            let long = wait
                && hold
                && answerable
                && sessions.queue.hold_hook(&event, crate::queue::now_ms());
            drop(sessions);
            let deadline = std::time::Instant::now() + Duration::from_millis(1400);
            let decision = loop {
                let mut sessions = registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                if let Some(decision) = sessions.queue.hook_response(&event) {
                    sessions.queue.end_hook(&event);
                    break Some(decision);
                }
                if !wait
                    || stopping.load(Ordering::SeqCst)
                    || !sessions.queue.hook_waits(&event, crate::queue::now_ms())
                    || (long && peer_gone(peer_fd))
                    || (!long && std::time::Instant::now() >= deadline)
                {
                    // A short waiter beside the event's long one (a replay) leaves that hold as it is.
                    if long || !sessions.queue.long_held(&event) {
                        sessions.queue.end_hook(&event);
                        if let Some(id) = &hook_session {
                            if hold {
                                sessions.unanswered_hold(id, &event); // ticket 1149
                            }
                            sessions.reread_screen(id);
                        }
                    }
                    break None;
                }
                drop(sessions);
                thread::sleep(Duration::from_millis(10));
            };
            return Ok(Reply::HookDecision { decision });
        }
        // V2.5-39: a pending nudge is the UserPromptSubmit reply, one context field (`board::nudge::on_hook`); a Stop
        // only decides it and keeps its Ack. The board is read after the registry guard is released; `on_hook`
        // re-takes the registry only for the history write. A Stop's v1b-02 plan is taken under the guard first and
        // its durable append still precedes the reply.
        let nudge =
            nudge
                .filter(|_| reply.is_ok())
                .and_then(|(me, event)| match sessions.snapshot() {
                    Ok(Reply::Snapshot { sessions: list, .. }) => Some((list, me, event)),
                    _ => None,
                });
        if let Some((list, me, event)) = nudge {
            let plan = match &chat_stop {
                Some((id, payload)) => sessions.chat_stop_plan(id, payload)?,
                None => None,
            };
            drop(sessions);
            if let Some(plan) = plan {
                plan.persist_bounded()?;
            }
            let from = crate::board::nudge::counted_from(arrived, arrived_ms, started_ms(&line));
            return match crate::board::nudge::reply(home, &list, &me, &event, from, registry) {
                Some(nudge) => {
                    let decision = Some(nudge.output.clone());
                    nudged = Some(nudge);
                    Ok(Reply::HookDecision { decision })
                }
                None => reply,
            };
        }
        // v1b-02: only the durable append moves; success still precedes the existing Ack.
        if reply.is_ok()
            && let Some((id, payload)) = chat_stop
        {
            let plan = sessions.chat_stop_plan(&id, &payload)?;
            drop(sessions);
            if let Some(plan) = plan {
                plan.persist_bounded()?;
            }
            return reply;
        }
        if stop && reply.is_ok() {
            if quit {
                quitting.store(true, Ordering::SeqCst); // before `stopping`, so the wind-down reads it
                let _ = fs::write(home.join(STOPPED), b""); // F24: before the socket goes
            }
            stopping.store(true, Ordering::SeqCst);
        }
        // v1a-06: append cached remote rows after releasing local state.
        drop(sessions);
        // v1a-40, V1A-74 follow-up: the stopped sessions' scrollback is on disk before the Stop reply, written after
        // the registry lock is released.
        if stop {
            Sessions::drain_scrollback(registry);
        }
        // Ticket 457: after a full stop no session is left to restart from, so the start secrets' item goes (in process,
        // no dialog, outside the registry lock).
        if quit
            && reply.is_ok()
            && let Some(keychain) = crate::start_secrets::keychain(|k| std::env::var(k).ok())
        {
            crate::start_secrets::forget(&keychain, home);
        }
        let mut reply = reply?;
        if owner && aggregate {
            crate::machines::snapshot(registry, home, &env.token, true, &mut reply, stopping)?;
        } else if caller.is_some() && listed {
            crate::machines::snapshot(registry, home, &env.token, false, &mut reply, stopping)?;
        }
        Ok(reply)
    })();
    let mut bytes = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    // Ticket 573 round 3, a second guard behind `keep_out`: a reply to an outside token never carries the owner token
    // as typed (a screen an agent printed it on). shortcut: an encoded or split value is not caught; `keep_out` is the
    // boundary.
    // Round 6 (security r5 SHOULD 2): also for a token session's own credential, whose stored origin is a token.
    if !outside && let Some(presented) = &presented {
        outside = sessions.lock().is_ok_and(|s| {
            s.agent_caller(presented)
                .is_ok_and(|c| s.token_of(&c).is_some())
        });
    }
    if outside && !token.is_empty() {
        bytes = String::from_utf8_lossy(&bytes)
            .replace(token, "[redacted]")
            .into_bytes();
    }
    bytes.push(b'\n');
    let written = stream.write_all(&bytes);
    if written.is_err()
        && let Some(nudge) = nudged
    {
        nudge.unsent(home, sessions);
    }
    // The deny did not leave: the question takes today's path too (the person's queue item); the ask stays in the
    // log, so the lead may still answer it.
    if written.is_err()
        && let Some(hook) = asked
        && let Ok(mut sessions) = sessions.lock()
    {
        let _ = sessions.handle(hook);
    }
    written.map_err(|e| e.to_string())
}
/// V2.5-48: the hook bridge's start (`started_ms`, beside `token` and `request`); the core clamps it
/// (`nudge::counted_from`).
/// Whether the peer closed its end: a held hook's client the agent ended (its timeout, or the person's interrupt).
fn peer_gone(fd: i32) -> bool {
    let mut byte = 0u8;
    // SAFETY: a one-byte, non-blocking peek on the descriptor this connection owns for the whole call.
    let n = unsafe {
        libc::recv(
            fd,
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    n == 0
}
fn started_ms(line: &str) -> Option<u64> {
    #[derive(serde::Deserialize)]
    struct Started {
        started_ms: Option<u64>,
    }
    serde_json::from_str::<Started>(line)
        .ok()
        .and_then(|s| s.started_ms)
}
// v1a-13, v1a-23: for a peer inside a live session of this core, that session's token; `None` outside. A peer of
// another uid, or one the check cannot place, is refused (fail closed).
// Ticket 1023: the peer is the pid the kernel recorded at `connect`, placed by its ancestors and session id against
// the leaders this core started; nothing the caller sends or sets (its environment, the token it read) is asked.
// shortcut: this names a caller, it is no sandbox. A process that left its session's tree is the owner again (one
// fork with `setsid` while the parent exits, a child that outlives its session, a start through launchd or ssh;
// README "Known limit"). Upgrade when that must hold against a hostile agent: docs/v1/owner-boundary-spike.md.
fn inside_token(
    peer: &std::io::Result<crate::peer::Peer>,
    sessions: &Mutex<Sessions>,
) -> Result<Option<String>, String> {
    let refused = |e: String| {
        eprintln!("owner peer check failed; owner authority refused: {e}");
        "owner peer check failed; owner authority refused".to_string()
    };
    let peer = peer.as_ref().map_err(|e| refused(e.to_string()))?;
    if peer.uid != unsafe { libc::geteuid() } {
        return Err(refused("another uid".into()));
    }
    let leaders = sessions
        .lock()
        .map_err(|_| "session registry unavailable")?
        .live_leaders()
        .map_err(refused)?;
    let pairs: Vec<(u32, u32)> = leaders.iter().map(|(l, (h, _))| (*l, *h)).collect();
    match crate::peer::containing(peer, &pairs) {
        Ok(None) => Ok(None),
        Ok(Some(leader)) => leaders
            .get(&leader)
            .and_then(|(_, token)| token.clone())
            .map(Some)
            .ok_or_else(|| refused("the session has no token".into())),
        Err(e) => Err(refused(e.to_string())),
    }
}
/// Ticket 573 slice 2: how long a start retried with a receipt waits for the first start with it.
const RECEIPT_WAIT: Duration = Duration::from_secs(60);
/// Ticket 573: a receipt is 1-128 printable ASCII characters without spaces, so the store stays small.
pub fn check_receipt(receipt: &str) -> Result<(), String> {
    if (1..=128).contains(&receipt.len()) && receipt.bytes().all(|b| b.is_ascii_graphic()) {
        Ok(())
    } else {
        Err(
            "start_receipt_invalid: a receipt is 1-128 printable ASCII characters, no spaces"
                .into(),
        )
    }
}
/// Start receipts kept, oldest dropped first.
const RECEIPTS_MAX: usize = 1024;
/// (the starting session's id, or `None` for the owner; the receipt)
type ReceiptKey = (Option<String>, String);
// shortcut: receipts live in this core's memory, so a retry after a core restart starts again; upgrade by storing the
// receipt with the session record if retries across restarts are needed.
static RECEIPTS: Mutex<std::collections::VecDeque<(ReceiptKey, Option<String>)>> =
    Mutex::new(std::collections::VecDeque::new());
/// `None`: the receipt is new and now claimed by this start. `Some(None)`: a start with it still runs.
/// `Some(Some(id))`: it started session `id`.
fn receipt_claim(key: &ReceiptKey) -> Option<Option<String>> {
    let mut receipts = RECEIPTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, id)) = receipts.iter().find(|(k, _)| k == key) {
        return Some(id.clone());
    }
    if receipts.len() >= RECEIPTS_MAX {
        // Never drop a claim still starting: its retry would start a second session.
        if let Some(done) = receipts.iter().position(|(_, id)| id.is_some()) {
            receipts.remove(done);
        }
    }
    receipts.push_back((key.clone(), None));
    None
}
/// A claimed receipt; dropped before `started`, it is released so a later retry starts again.
struct Receipt(Option<ReceiptKey>);
impl Receipt {
    fn started(&mut self, id: &str) {
        let Some(key) = self.0.take() else { return };
        let mut receipts = RECEIPTS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(row) = receipts.iter_mut().find(|(k, _)| *k == key) {
            row.1 = Some(id.into());
        }
    }
}
impl Drop for Receipt {
    fn drop(&mut self) {
        if let Some(key) = self.0.take() {
            let mut receipts = RECEIPTS.lock().unwrap_or_else(|e| e.into_inner());
            receipts.retain(|(k, _)| *k != key);
        }
    }
}
pub(crate) fn token_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The registry tick: observers, delivery and the board run this often.
const TICK: Duration = Duration::from_millis(50);
/// S9 r3: the tick once nothing moved for ACTIVE: what it still finds then is an agent that ended without a last output
/// (seen in the process table) or a clock (a stale mark, a limit resume), which this bounds.
const IDLE_TICK: Duration = Duration::from_millis(250);
/// S9 r3: how long the tick stays at TICK after a request, output or an agent's end.
const ACTIVE: Duration = Duration::from_secs(2);
/// S9: blocks until one of `fds` is readable (an accept is waiting) or `timeout` passes; an accept loop's idle wait.
pub(crate) fn wait_readable(fds: &[std::os::fd::RawFd], timeout: Duration) {
    let mut fds: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let ms = timeout.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
    // SAFETY: `fds` is a live, correctly sized array of pollfd for the duration of the call.
    unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, ms) };
}
/// Q9 en-a-J5-1: runs `work` on its own thread counted in `active`. The count drops when it ends, panics or gets no
/// thread, so the stop's wait for `active == 0` always ends.
fn counted(
    active: &Arc<std::sync::atomic::AtomicUsize>,
    work: impl FnOnce() + Send + 'static,
) -> std::io::Result<thread::JoinHandle<()>> {
    struct Leave(Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Leave {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    active.fetch_add(1, Ordering::SeqCst);
    let leave = Leave(active.clone());
    thread::Builder::new().spawn(move || {
        let _leave = leave;
        work()
    })
}
#[cfg(test)]
mod tests;
