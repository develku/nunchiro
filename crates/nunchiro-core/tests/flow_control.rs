//! v1a-53: the core paces each window by the output bytes it acked as parsed, over a real socket and a real core.
//! A session prints numbered lines on a trigger; windows watch it and ack (or do not), and each frame's bytes are
//! checked against the numbering, so a dropped, repeated or reordered byte shows.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    net::TcpStream,
    path::PathBuf,
    process::{Child, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";
/// The per-window total these cores run with (`NUNCHIRO_WINDOW_UNACKED_MIB`; the default `http::UNACKED_TOTAL` would
/// need streams too long for debug cores), the per-session room (`UNACKED_MAX`) and the replay (`pty::REPLAY_BYTES`).
/// A window watching one session may have the whole total unacked.
const TOTAL: u64 = 2 << 20;
const ROOM: u64 = 1 << 20;
const REPLAY: u64 = 1 << 20;
/// Lines of "%07d\n" the session prints (9 bytes each with the PTY's \r\n): one and a half totals and 4 MiB, so a
/// window that acks nothing falls more than a replay behind.
const LINES: u64 = (TOTAL * 3 / 2 + (4 << 20)) / 9;
/// 64 KiB writes at most every 8 ms, so a window that acks at once never falls a replay behind on a busy host.
const SCRIPT: &str = r#"$|=1; <STDIN>; my $b=""; for my $i (0..LINES-1) { $b.=sprintf("%07d\n",$i); if (length($b)>=65536) { print $b; $b=""; select(undef,undef,undef,0.008) } } print $b, "DONE"; sleep 600"#;

/// One core at a time in this binary (V1A-80): each test pushes about 10 MB through a debug core, and nine of them
/// at once starve each other's readers until the core drops a window that stopped reading for `WRITE_TIMEOUT`.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

struct Core {
    home: PathBuf,
    child: Child,
    /// Dropped last, after the core is stopped and its home removed.
    _turn: MutexGuard<'static, ()>,
}
impl Core {
    fn new(tag: &str) -> Self {
        let turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let home = home::short(&format!("flow-{tag}"));
        let bin = cli::path();
        let child = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("NUNCHIRO_WINDOW_UNACKED_MIB", (TOTAL >> 20).to_string())
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // The guard first: a readiness timeout below must still stop the daemon.
        let core = Self {
            home,
            child,
            _turn: turn,
        };
        let until = Instant::now() + Duration::from_secs(5);
        while !core.home.join("window.json").exists()
            || !matches!(
                call(&core.home, Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            )
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    /// A session that prints the numbered lines once it reads a line. Echo is off, so the typed trigger is not output.
    fn session(&self) -> String {
        let script = SCRIPT.replace("LINES", &LINES.to_string());
        let id = self.start(&format!(
            "stty -echo; printf R; exec /usr/bin/perl -e '{script}'"
        ));
        // `R` once echo is off, so the trigger sent next is not echoed into the stream.
        self.wait(&id, b"R");
        id
    }
    fn start(&self, sh: &str) -> String {
        let Reply::Started { session } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.clone(),
                    worktree: false,
                    label: "flow".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), sh.into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        session.id
    }
    fn go(&self, id: &str) {
        call(
            &self.home,
            Request::SendText {
                id: id.into(),
                text: "go\n".into(),
                composer: false,
                seen: vec![],
            },
        )
        .unwrap();
    }
    /// Waits until the session's output ends with `tail`, and returns its end cursor: the PTY reader read it all.
    fn wait(&self, id: &str, tail: &[u8]) -> u64 {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(Reply::Output { data, end, .. }) = call(
                &self.home,
                Request::Read {
                    id: id.into(),
                    after: 0,
                },
            ) && data.ends_with(tail)
            {
                return end;
            }
            assert!(
                Instant::now() < until,
                "{id} output did not end with {tail:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// Waits until the PTY reader read the whole stream, reading (never acking) the window's frames meanwhile, so
    /// only pacing can stop its output. Returns them and the session's end cursor.
    fn finish(&self, id: &str, w: &mut Window) -> (Vec<Frame>, u64) {
        let until = Instant::now() + Duration::from_secs(30);
        let mut frames = vec![];
        loop {
            frames.extend(w.drain(Duration::from_millis(100)));
            if let Ok(Reply::Output { data, end, .. }) = call(
                &self.home,
                Request::Read {
                    id: id.into(),
                    after: 0,
                },
            ) && data.ends_with(b"DONE")
            {
                frames.extend(w.drain(Duration::from_millis(500)));
                return (frames, end);
            }
            assert!(Instant::now() < until, "the PTY reader stopped");
        }
    }
    fn window(&self) -> Window {
        self.try_window().unwrap()
    }
    fn try_window(&self) -> Result<Window, tungstenite::Error> {
        let v = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let port = v["port"].as_u64().unwrap() as u16;
        let token = v["token"].as_str().unwrap();
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static(ORIGIN));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // A 100 ms read timeout polls later reads only; the handshake gets the core's own bound.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (ws, _) = tungstenite::client(req, stream).map_err(|e| match e {
            tungstenite::HandshakeError::Failure(e) => e,
            tungstenite::HandshakeError::Interrupted(_) => tungstenite::Error::ConnectionClosed,
        })?;
        ws.get_ref()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        Ok(Window { ws })
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[derive(Debug)]
struct Frame {
    start: u64,
    end: u64,
    truncated: bool,
    replay: bool,
    data: Vec<u8>,
}

struct Window {
    ws: WebSocket<TcpStream>,
}
impl Window {
    fn send(&mut self, v: serde_json::Value) {
        self.ws.send(Message::Text(v.to_string().into())).unwrap();
    }
    fn watch(&mut self, id: &str) -> Frame {
        self.send(serde_json::json!({"id":1,"watch":id,"after":0}));
        let f = self.frame(Duration::from_secs(5)).expect("no replay frame");
        assert!(f.replay);
        f
    }
    fn ack(&mut self, id: &str, bytes: u64) {
        self.send(serde_json::json!({"ack":id,"bytes":bytes}));
    }
    /// The next output frame, or `None` when none comes within `wait`.
    fn frame(&mut self, wait: Duration) -> Option<Frame> {
        let until = Instant::now() + wait;
        while Instant::now() < until {
            match self.ws.read() {
                Ok(Message::Binary(b)) => {
                    let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
                    let head: serde_json::Value = serde_json::from_slice(&b[4..4 + n]).unwrap();
                    return Some(Frame {
                        start: head["start"].as_u64().unwrap(),
                        end: head["end"].as_u64().unwrap(),
                        truncated: head["truncated"].as_bool().unwrap(),
                        replay: head["replay"].as_bool().unwrap(),
                        data: b[4 + n..].to_vec(),
                    });
                }
                Ok(Message::Text(t)) => assert!(!t.contains("unwatched"), "{t}"),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => panic!("{e}"),
            }
        }
        None
    }
    /// Frames until none comes for `quiet`, never acking.
    fn drain(&mut self, quiet: Duration) -> Vec<Frame> {
        std::iter::from_fn(|| self.frame(quiet)).collect()
    }
}

/// The line numbers in `bytes` (after "R"), asserting every complete line is the one after the last; `None` before
/// the first line. A partial line at either edge is skipped.
fn numbers(bytes: &[u8]) -> Vec<u64> {
    let text = String::from_utf8_lossy(bytes);
    // The holder's size mark comes before the first output (ticket 995).
    let text = text.trim_start_matches("\x1b[8;50;160t");
    let text = text.strip_prefix('R').unwrap_or(text);
    let mut out: Vec<u64> = vec![];
    // The tty sometimes writes \r\r\n for a newline.
    for line in text.split('\n').map(|l| l.trim_end_matches('\r')) {
        if line.len() == 7
            && let Ok(n) = line.parse::<u64>()
        {
            if let Some(last) = out.last() {
                assert_eq!(n, last + 1, "line {n} follows {last}");
            }
            out.push(n);
        }
    }
    out
}

/// Frames that join with no gap and no skip: each starts where the one before ended.
#[track_caller]
fn contiguous(frames: &[Frame], from: u64) -> u64 {
    runs(frames, from);
    assert!(frames.iter().all(|f| !f.truncated), "unexpected skip");
    frames.last().map_or(from, |f| f.end)
}

/// Frames in order with nothing repeated: each starts where the one before ended, or, marked as a skip, later. Returns
/// each run's bytes (a skip starts a new run).
#[track_caller]
fn runs(frames: &[Frame], from: u64) -> Vec<Vec<u8>> {
    let mut at = from;
    let mut out: Vec<Vec<u8>> = vec![vec![]];
    for f in frames {
        assert_eq!(f.end - f.start, f.data.len() as u64);
        if f.truncated {
            assert!(f.start > at, "a skip went back: {} after {at}", f.start);
            out.push(vec![]);
        } else {
            assert_eq!(f.start, at, "gap or overlap");
        }
        out.last_mut().unwrap().extend(&f.data);
        at = f.end;
    }
    out
}

#[test]
fn slow_window_does_not_block_fast() {
    let core = Core::new("slow");
    let id = core.session();
    let mut slow = core.window();
    let mut fast = core.window();
    let replay = slow.watch(&id);
    // Its ack makes `slow` a paced window; it acks nothing after.
    slow.ack(&id, replay.data.len() as u64);
    let first = fast.watch(&id);
    let fast_id = id.clone();
    let fast = thread::spawn(move || {
        let mut frames = vec![first];
        let mut acked = frames[0].data.len() as u64;
        fast.ack(&fast_id, acked);
        // One overall deadline, not a gap between frames: a reader the host starves for seconds is late, not blocked.
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            let Some(f) = fast.frame(Duration::from_millis(500)) else {
                continue;
            };
            acked += f.data.len() as u64;
            fast.ack(&fast_id, acked);
            let done = f.data.ends_with(b"DONE");
            frames.push(f);
            if done {
                break;
            }
        }
        frames
    });
    let went = Instant::now();
    core.go(&id);
    let (held, end) = core.finish(&id, &mut slow);
    let streamed = went.elapsed();
    let fast = fast.join().unwrap();
    // The fast window reached the end of the stream (its last frame ends with DONE at the session's end cursor) while
    // the slow one was held: had the slow window paced it, it would have stopped at the slow one's cap.
    let last = fast.last().unwrap();
    // Where it stopped tells a stalled window (far behind the end) from a slow host (the stream itself near 30 s).
    assert!(
        last.data.ends_with(b"DONE"),
        "the fast window never saw DONE: it got to {} of {end} in {} frames ({} skips); the PTY read it all in {streamed:?}",
        last.end,
        fast.len(),
        fast.iter().filter(|f| f.truncated).count()
    );
    assert_eq!(last.end, end);
    // Every byte in order, once. A reader the host starved for more than a replay is skipped ahead, marked as a skip
    // (as for any window, before V1A-53); only then may bytes be missing, and the numbering still never goes back.
    let mut runs = runs(&fast[1..], fast[0].end);
    runs[0].splice(0..0, fast[0].data.clone());
    let mut next = 0;
    for run in &runs {
        let n = numbers(run);
        if let Some(first) = n.first() {
            assert!(
                *first >= next,
                "line {first} after {next}: numbering went back"
            );
            next = n.last().unwrap() + 1;
        }
    }
    // Floor, so the allowance above cannot pass vacuously: the fast window was not paced by the slow one. Either it got
    // more than a total (a paced window stops there) or the session skipped it ahead (a starved reader, which a paced
    // window never is). Not both, and no cap on skips: a host that starves the reader twice is still not pacing it.
    let got = fast.iter().map(|f| f.data.len() as u64).sum::<u64>();
    assert!(
        got > TOTAL || runs.len() > 1,
        "the fast window got {got} bytes, no more than {TOTAL}, and was never skipped"
    );
    if runs.len() == 1 {
        assert_eq!(numbers(&runs[0]), (0..LINES).collect::<Vec<_>>());
    }
    let sent: u64 = held.iter().map(|f| f.data.len() as u64).sum();
    assert!(sent <= TOTAL, "a window that acks nothing got {sent} bytes");
    assert!(sent > 0);
    assert_eq!(contiguous(&held, replay.end), replay.end + sent);
    assert!(
        end > replay.end + sent + REPLAY,
        "the slow window was not held"
    );
}

/// A paced window that stops acking until the session finished, then acks all it was sent: (frames before, frames
/// after, the session's end).
fn held_then_caught_up(tag: &str) -> (Vec<Frame>, Vec<Frame>, u64) {
    let core = Core::new(tag);
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    w.ack(&id, replay.data.len() as u64);
    core.go(&id);
    let (held, end) = core.finish(&id, &mut w);
    let mut before = vec![replay];
    before.extend(held);
    let sent: u64 = before.iter().map(|f| f.data.len() as u64).sum();
    w.ack(&id, sent);
    let after = w.drain(Duration::from_millis(500));
    (before, after, end)
}

#[test]
fn backlog_skips_to_newest_replay_bytes() {
    let (before, after, end) = held_then_caught_up("skip");
    let last = before.last().unwrap().end;
    assert!(end - last > REPLAY, "not behind by more than the replay");
    let [skip] = &after[..] else {
        panic!("one frame after catching up, got {}", after.len())
    };
    // The newest 1 MiB, marked as a jump; nothing between the held bytes and it was sent.
    assert!(skip.truncated && !skip.replay);
    assert_eq!((skip.start, skip.end), (end - REPLAY, end));
    assert_eq!(skip.data.len() as u64, REPLAY);
    assert!(skip.data.ends_with(b"DONE"));
}

#[test]
fn accepted_bytes_stay_ordered() {
    let (before, after, _) = held_then_caught_up("order");
    // Every byte the window was sent, in order and once; a skip only jumps ahead (a loaded host can make the core
    // itself fall a replay behind the PTY before the hold, as before V1A-53).
    let mut frames = before;
    let first = frames.remove(0);
    frames.extend(after);
    let mut runs = runs(&frames, first.end);
    runs[0].splice(0..0, first.data);
    let mut last: Option<u64> = None;
    for run in &runs {
        let n = numbers(run);
        if let (Some(last), Some(next)) = (last, n.first()) {
            assert!(
                *next > last + 1,
                "after a skip the numbering resumes later, never earlier"
            );
        }
        last = n.last().copied().or(last);
    }
    assert_eq!(numbers(&runs[0])[0], 0);
    assert_eq!(last, Some(LINES - 1));
    assert!(runs.len() >= 2, "no skip");
}

#[test]
fn disconnect_mid_backlog_cleans_up() {
    let core = Core::new("drop");
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    w.ack(&id, replay.data.len() as u64);
    core.go(&id);
    let (held, end) = core.finish(&id, &mut w);
    assert!(!held.is_empty());
    drop(w);
    // The held window's slot is free again: the core takes eight windows (its cap) at once.
    let mut windows: Vec<Window> = vec![];
    // v1a-80c: the core notices the closed socket on its own tick; a failure deadline, not a speed bound.
    let until = Instant::now() + Duration::from_secs(60);
    while windows.len() < 8 {
        match core.try_window() {
            Ok(w) => windows.push(w),
            Err(_) if Instant::now() < until => thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("the held window's slot was not freed: {e}"),
        }
    }
    // A new window gets a normal replay: the newest 1 MiB, then nothing more.
    let again = windows[7].watch(&id);
    assert!(again.truncated);
    assert_eq!((again.start, again.end), (end - REPLAY, end));
    assert!(windows[7].drain(Duration::from_millis(300)).is_empty());
}

#[test]
fn a_window_that_never_acks_is_not_held() {
    let core = Core::new("old");
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    core.go(&id);
    // An older window build sends no acks: it is not paced, so it reads to the end (skipping when it falls a
    // replay behind, as before), never waiting on acks that will not come.
    let (mut frames, end) = core.finish(&id, &mut w);
    // The last frames may still be on their way once the PTY reader finished: wait for the one that ends the stream.
    let until = Instant::now() + Duration::from_secs(30);
    while frames.last().is_none_or(|f| f.end < end) && Instant::now() < until {
        frames.extend(w.drain(Duration::from_millis(100)));
    }
    let last = frames.last().expect("output reached the window");
    assert!(last.data.ends_with(b"DONE"));
    // By cursor, not bytes delivered: a window the host starved skips ahead, and skipped bytes are not delivered. A
    // paced window with no acks would stop within TOTAL of its replay.
    assert!(
        last.end - replay.end > TOTAL,
        "the cursor stopped {} bytes past the replay: held at the window",
        last.end - replay.end
    );
    assert!(frames[0].start >= replay.end);
}

#[test]
fn rewatch_while_held_counts_afresh() {
    let core = Core::new("rewatch");
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    w.ack(&id, replay.data.len() as u64);
    core.go(&id);
    let (held, end) = core.finish(&id, &mut w);
    // The replay was acked, so at most a window follows it.
    let sent: u64 = held.iter().map(|f| f.data.len() as u64).sum();
    assert!(
        sent <= TOTAL && end - replay.end - sent > REPLAY,
        "not held"
    );
    // A rewatch while held (a second view of the session) gets its replay at once: the count starts again from it.
    let again = w.watch(&id);
    assert_eq!((again.start, again.end), (end - REPLAY, end));
    assert!(again.truncated && again.data.ends_with(b"DONE"));
}

#[test]
fn a_held_session_that_ends_is_reported() {
    let core = Core::new("ended");
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    w.ack(&id, replay.data.len() as u64);
    core.go(&id);
    let (held, end) = core.finish(&id, &mut w);
    let sent: u64 = held.iter().map(|f| f.data.len() as u64).sum();
    assert!(end - replay.end - sent > REPLAY, "not held");
    call(&core.home, Request::Close { id: id.clone() }).unwrap();
    // Held or not, the window learns within a resync that the session is gone.
    let until = Instant::now() + Duration::from_secs(1);
    loop {
        assert!(Instant::now() < until, "no unwatched event while held");
        match w.ws.read() {
            Ok(Message::Text(t)) if t.contains("unwatched") => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{e}"),
        }
    }
}

#[test]
fn forged_acks_change_nothing() {
    let core = Core::new("forged");
    let id = core.session();
    let mut w = core.window();
    let replay = w.watch(&id);
    w.ack(&id, replay.data.len() as u64);
    core.go(&id);
    let (held, end) = core.finish(&id, &mut w);
    let sent = replay.data.len() as u64 + held.iter().map(|f| f.data.len() as u64).sum::<u64>();
    assert!(end - replay.end - sent > REPLAY, "not held");
    // Past what was sent, and lower than the last: neither frees a byte. The first refusal is reported once, so a
    // window whose count drifted can watch afresh.
    w.ack(&id, sent + 1);
    w.ack(&id, 0);
    w.ack(&id, u64::MAX);
    let mut refused = 0;
    let until = Instant::now() + Duration::from_millis(500);
    while Instant::now() < until {
        match w.ws.read() {
            Ok(Message::Text(t)) if t.contains("ack_refused") => refused += 1,
            Ok(Message::Binary(_)) => panic!("a forged ack freed output"),
            _ => {}
        }
    }
    assert_eq!(refused, 1);
    // A malformed ack is not an ack either.
    w.send(serde_json::json!({"ack": id, "bytes": sent, "extra": 1}));
    w.send(serde_json::json!({"ack": id, "bytes": -1}));
    assert!(w.drain(Duration::from_millis(300)).is_empty());
    // The true count still works: the window catches up and skips to the newest output.
    w.ack(&id, sent);
    let skip = w
        .frame(Duration::from_secs(2))
        .expect("the true ack frees the session");
    assert!(skip.truncated && skip.end == end);
}

#[test]
fn a_quiet_session_is_not_held_behind_a_busy_one() {
    let core = Core::new("quiet");
    let busy = core.session();
    let quiet = core.start("exec /bin/cat");
    let mut w = core.window();
    let replay = w.watch(&busy);
    w.ack(&busy, replay.data.len() as u64);
    let first = w.watch(&quiet);
    w.ack(&quiet, first.data.len() as u64);
    core.go(&busy);
    // The busy session uses the window's whole total and is held.
    let (held, _) = core.finish(&busy, &mut w);
    let used: u64 = held.iter().map(|f| f.data.len() as u64).sum();
    assert!(
        used >= TOTAL - ROOM,
        "busy session not held at the total: {used}"
    );
    // The quiet one still gets its echo at once.
    call(
        &core.home,
        Request::SendText {
            id: quiet.clone(),
            text: "ping\n".into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
    let echo = w
        .frame(Duration::from_secs(2))
        .expect("the quiet session was held");
    assert!(String::from_utf8_lossy(&echo.data).contains("ping"));
}
