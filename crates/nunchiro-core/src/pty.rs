//! The core's side of a session terminal: a bounded, lossless byte replay window and, since V2-1a, `Pty`, the client of
//! the session's holder (`holder/`), which owns the PTY itself.
// Adapted from Zeron terminals.rs, commit 4231cb7. MIT License, Copyright (c) 2026 Wing.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
use crate::holder::frame::{self, read_frame, write_frame};
use portable_pty::CommandBuilder;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    os::fd::{AsRawFd, RawFd},
    os::unix::net::UnixStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

/// Output wake-ups: each window loop subscribes, and a PTY reader writes one byte to every subscriber after it
/// stores output, so the loop forwards it at once instead of at its next fixed tick. Byte values carry nothing.
static WAKERS: Mutex<Vec<(u64, UnixStream)>> = Mutex::new(Vec::new());

pub struct Wake {
    id: u64,
    rx: UnixStream,
}
impl Wake {
    pub fn subscribe() -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let (tx, rx) = UnixStream::pair()?;
        tx.set_nonblocking(true)?;
        rx.set_nonblocking(true)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        WAKERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((id, tx));
        Ok(Self { id, rx })
    }
    pub fn fd(&self) -> RawFd {
        self.rx.as_raw_fd()
    }
    /// Discards the pending wake-up bytes (a full pipe drops further ones, which is enough to wake); whether any came.
    pub fn drain(&self) -> bool {
        let mut buf = [0u8; 64];
        let mut woke = false;
        while matches!((&self.rx).read(&mut buf), Ok(n) if n > 0) {
            woke = true;
        }
        woke
    }
}
impl Drop for Wake {
    fn drop(&mut self) {
        WAKERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _)| *id != self.id);
    }
}
fn notify_output() {
    for (_, tx) in WAKERS.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        let _ = (&*tx).write(&[1]);
    }
}
/// S9: wakes every window loop for something other than output (a layout command, a finished job's reply), so its
/// idle wait can last until its next timed check.
pub(crate) fn wake_windows() {
    notify_output();
}

#[cfg(test)]
thread_local! {
    // v1a-29: the next spawned reader waits on this after it publishes each read, until a message or a hangup.
    // It also holds the query replies of that read, so do not use it with an agent waiting on one.
    pub(crate) static HOLD_AFTER_PUBLISH: std::cell::RefCell<Option<std::sync::mpsc::Receiver<()>>> =
        const { std::cell::RefCell::new(None) };
}

pub const REPLAY_BYTES: usize = 1024 * 1024;
pub const INPUT_BYTES: usize = 64 * 1024;

/// v1a-27: see `Pty::tail`.
pub struct Tail(Arc<Mutex<Replay>>);
impl Tail {
    pub fn end(&self) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).end
    }
    /// The bytes after `after`, from the same ring `Pty::read` reads, without the session registry.
    pub(crate) fn read(&self, after: u64) -> Result<crate::api::Reply, String> {
        let r = self.0.lock().unwrap_or_else(|e| e.into_inner());
        r.read_at_most(after, usize::MAX)
    }
}

#[derive(Default)]
pub(crate) struct Replay {
    bytes: VecDeque<u8>,
    end: u64,
}
impl Replay {
    pub(crate) fn push(&mut self, data: &[u8]) {
        self.end += data.len() as u64;
        self.bytes.extend(data);
        let excess = self.bytes.len().saturating_sub(REPLAY_BYTES);
        self.bytes.drain(..excess);
    }
    /// V2-1b: the ring's bytes and end cursor, as a holder hands them to a reattaching core.
    pub(crate) fn parts(&self) -> (Vec<u8>, u64) {
        (self.bytes.iter().copied().collect(), self.end)
    }
    pub(crate) fn from_parts(bytes: Vec<u8>, end: u64) -> Self {
        let mut replay = Self {
            bytes: bytes.into(),
            end,
        };
        let excess = replay.bytes.len().saturating_sub(REPLAY_BYTES);
        replay.bytes.drain(..excess);
        replay
    }
    pub(crate) fn read_at_most(&self, after: u64, max: usize) -> Result<crate::api::Reply, String> {
        if after > self.end {
            return Err("output cursor is ahead of session".into());
        }
        let first = self.end - self.bytes.len() as u64;
        let start = after.max(first);
        Ok(crate::api::Reply::Output {
            data: self
                .bytes
                .iter()
                .skip((start - first) as usize)
                .take(max)
                .copied()
                .collect(),
            start,
            end: self.end,
            truncated: after < first,
        })
    }
}

/// v1a-40: a stopped session's replay restored from its scrollback file.
pub struct Saved(Arc<Mutex<Replay>>);
impl Saved {
    pub fn new(bytes: Vec<u8>) -> Self {
        // The file keeps no cursor: a full window had older output dropped, so it starts one byte in and a read
        // from 0 reports `truncated`. shortcut: output of exactly REPLAY_BYTES with nothing dropped reads as
        // truncated too; store the end cursor if a client ever needs cursors stable across a restart.
        let dropped = (bytes.len() >= REPLAY_BYTES) as u64;
        Self(Arc::new(Mutex::new(Replay {
            end: bytes.len() as u64 + dropped,
            bytes: bytes.into(),
        })))
    }
    pub fn read(&self, after: u64) -> Result<crate::api::Reply, String> {
        let r = self.0.lock().unwrap_or_else(|e| e.into_inner());
        r.read_at_most(after, usize::MAX)
    }
    pub fn tail(&self) -> Tail {
        Tail(self.0.clone())
    }
    pub fn bytes(&self) -> Vec<u8> {
        let r = self.0.lock().unwrap_or_else(|e| e.into_inner());
        r.bytes.iter().copied().collect()
    }
}

/// V2-1b: what a reattach found.
pub enum Attach {
    Attached(Box<Pty>),
    /// A holder of an older protocol: its agent keeps running; the session needs a restart.
    Older(u16),
    /// A holder newer than this core: not attached ("Update Nunchiro").
    Newer(u16),
    /// No holder answers there as the recorded process.
    Gone(String),
}

/// V2-1a: a session terminal served by its holder. The interface is v1a's; the replay is mirrored here from the
/// holder's output stream (same cursors: both start from the seed), so reads, cursors and paste mode never wait on
/// the socket, while write, resize, alive and stop are the holder's answers.
pub struct Pty {
    link: Mutex<Link>,
    replay: Arc<Mutex<Replay>>,
    pid: u32,
    /// V2-1a r3: the agent's start time, read once it launched: tells it from a later process on the same pid.
    agent_started: Option<u64>,
    stopped: bool,
    alive: Arc<AtomicBool>,
    // v1a-15: the agent's last bracketed-paste mode switch (`ESC[?2004h` on, `ESC[?2004l` off), as the holder saw it.
    paste: Arc<AtomicBool>,
    holder: crate::holder::Record,
    /// V2-1a r3: when the holder first said the agent ended while its last output was still on the way.
    ended: Option<std::time::Instant>,
    /// V2-1b: the holder died (rather than reporting its agent's end).
    lost: bool,
    /// V2-5b: the agent's exit code, when its holder reported one (an older holder does not).
    exit: Option<i32>,
    /// S9 r3: when the holder was last asked `alive`.
    asked: Option<std::time::Instant>,
    /// Ticket 505: where this run's output starts in the replay, after a resumed conversation's seed (which can hold
    /// an earlier run's end mark). 0 for a session attached at core start.
    run_start: u64,
    /// v19-Q9-cx: the last write was refused because the agent does not read its terminal; the next whole write clears it.
    input_blocked: bool,
}
struct Link {
    stream: UnixStream,
    replies: mpsc::Receiver<(u8, Vec<u8>)>,
    /// The holder ended (end of stream, or the link failed): no more requests.
    gone: bool,
    /// V2-1a r3: replies still owed to requests that timed out. Replies come in order on the one stream, so these
    /// are the next ones in; they are dropped, and until they are in the holder counts as silent.
    late: usize,
    /// V2-1a r3: a frame was cut by the write bound (the holder stopped reading). The link is closed for writing, so
    /// the holder, when it runs, reads a short frame and ends (stopping its agent); until then it counts as silent.
    cut: bool,
}
/// V2-1a r2: the bound of a request made under the registry lock (alive, write, resize), so one silent holder
/// cannot hold the core for long.
pub(crate) const QUICK_WAIT: Duration = Duration::from_secs(2);
/// A stop or spawn: it may wait out a group still exiting (about a second) and `ps`.
const SLOW_WAIT: Duration = Duration::from_secs(15);
/// How long an ended agent's last output may take to arrive before the session counts as ended.
const TAIL_WAIT: Duration = Duration::from_secs(1);
/// S9 r3: the slowest a live session's holder is asked `alive` when no event said its agent ended.
const ALIVE_RECHECK: Duration = Duration::from_secs(1);
const ATTACH_TRIES: u32 = 5;
const ATTACH_GAP: Duration = Duration::from_millis(100);
const CORE_HELD: &str = "holder already has its core";
const HOLDER_GONE: &str = "session holder ended";
const HOLDER_SILENT: &str = "session holder did not answer";
const AGENT_OUTLIVED: &str = "session holder ended and its agent did not stop";
impl Pty {
    /// v1a-40: the replay starts from `seed` (a resumed conversation's scrollback), capped like any output.
    /// V2-1a: `id`'s holder is started under `home` and runs `cmd`.
    pub fn spawn(
        home: &std::path::Path,
        id: &str,
        cmd: CommandBuilder,
        seed: &[u8],
    ) -> Result<Self, String> {
        let spawn = crate::holder::encode(&cmd, seed);
        let (stream, holder) = crate::holder::start(home, id)?;
        let mut replay = Replay::default();
        replay.push(seed);
        let mut pty = Self::over(stream, replay, false, true, holder)?;
        pty.run_start = seed.len() as u64;
        let (op, payload) = pty.request(frame::SPAWN, &spawn, SLOW_WAIT)?;
        match (op, payload.as_slice()) {
            (frame::SPAWNED, [pid @ .., _, _, _, _, _, _, _, _]) if pid.len() == 4 => {
                pty.pid = u32::from_be_bytes([pid[0], pid[1], pid[2], pid[3]]);
                // V2-1b: the holder read the start time at launch; 0 means it could not.
                let started = u64::from_be_bytes(payload[4..].try_into().unwrap());
                pty.agent_started = (started != 0)
                    .then_some(started)
                    .or_else(|| crate::peer::started(pty.pid).ok());
            }
            (frame::ERR, why) => {
                pty.stopped = true;
                return Err(String::from_utf8_lossy(why).into_owned());
            }
            _ => {
                pty.stopped = true;
                return Err("unexpected holder reply".into());
            }
        }
        Ok(pty)
    }
    /// V2-1b: reattaches to the live holder `record` names, after a core restart. Connects by path, so before it sends
    /// a byte it checks the peer is that holder process (pid and start time); then the versions: only a holder of this
    /// protocol is attached. Its ring becomes the replay, so cursors and scrollback carry on.
    /// `wait` bounds each read (a holder stopped by its own agent answers nothing; a retry under the registry lock
    /// passes a short one).
    pub fn attach(record: &crate::holder::Record, wait: Duration) -> Attach {
        let stream = match UnixStream::connect(&record.socket) {
            Ok(stream) => stream,
            Err(e) => return Attach::Gone(e.to_string()),
        };
        match crate::peer::of(&stream) {
            Ok(peer)
                if peer.pid as u32 == record.pid
                    && crate::peer::is_same(record.pid, record.started) => {}
            Ok(peer) => {
                return Attach::Gone(format!(
                    "the socket is served by pid {}, not holder {}",
                    peer.pid, record.pid
                ));
            }
            Err(e) => return Attach::Gone(e.to_string()),
        }
        let attached = (|| {
            let mut stream = stream;
            stream
                .set_read_timeout(Some(wait))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(wait))
                .map_err(|e| e.to_string())?;
            // Only this protocol attaches: an older holder lacks ATTACH, and one newer than this core is never
            // attached (spec V2-1 "Versions"), even when its hello says it still speaks this one.
            // V2.5-47: a holder that could not finish its peer check answers `PEER_CHECK_BUSY` in place of the hello.
            let (version, _) = crate::holder::read_hello_or_busy(&mut stream)?;
            if version > frame::PROTOCOL {
                return Ok(Attach::Newer(version));
            }
            if version < frame::PROTOCOL {
                return Ok(Attach::Older(version));
            }
            stream
                .write_all(&frame::hello())
                .map_err(|e| e.to_string())?;
            write_frame(&mut stream, frame::ATTACH, &[]).map_err(|e| e.to_string())?;
            let (op, payload) = read_frame(&mut stream).map_err(|e| e.to_string())?;
            if op == frame::ERR {
                return Err(String::from_utf8_lossy(&payload).into_owned());
            }
            if op != frame::OK || payload.len() < 22 {
                return Err("unexpected holder reply".into());
            }
            let pid = u32::from_be_bytes(payload[..4].try_into().unwrap());
            let started = u64::from_be_bytes(payload[4..12].try_into().unwrap());
            let (paste, ended) = (payload[12] == 1, payload[13] == 1);
            let end = u64::from_be_bytes(payload[14..22].try_into().unwrap());
            let bytes = payload[22..].to_vec();
            if pid == 0 || end < bytes.len() as u64 || bytes.len() > REPLAY_BYTES {
                return Err("invalid holder ring".into());
            }
            stream.set_read_timeout(None).map_err(|e| e.to_string())?;
            let mut pty = Self::over(
                stream,
                Replay::from_parts(bytes, end),
                paste,
                !ended,
                record.clone(),
            )?;
            pty.pid = pid;
            pty.agent_started = (started != 0).then_some(started);
            Ok(Attach::Attached(Box::new(pty)))
        })();
        attached.unwrap_or_else(Attach::Gone)
    }
    /// V1A-79: `attach`, tried again while the holder only says it still has its core (it frees that flag when it
    /// notices the old link closed, a moment after `leave`), or (V2.5-47) that its peer check could not finish: up to
    /// 5 tries, 100 ms apart. Any other answer returns at once. Never call it under the registry lock; the guard stays
    /// the holder's.
    pub fn attach_retrying(record: &crate::holder::Record, wait: Duration) -> Attach {
        let mut tries = 1;
        loop {
            let result = Self::attach(record, wait);
            if tries == ATTACH_TRIES
                || !matches!(&result, Attach::Gone(why) if why == CORE_HELD || why == crate::holder::PEER_CHECK_BUSY)
            {
                return result;
            }
            tries += 1;
            thread::sleep(ATTACH_GAP);
        }
    }
    /// The client over a link to its holder: the reader mirrors output into `replay` and hands replies to requests.
    fn over(
        stream: UnixStream,
        replay: Replay,
        paste: bool,
        reading: bool,
        holder: crate::holder::Record,
    ) -> Result<Self, String> {
        let replay = Arc::new(Mutex::new(replay));
        let alive = Arc::new(AtomicBool::new(reading));
        let paste = Arc::new(AtomicBool::new(paste));
        let (tx, replies) = mpsc::channel();
        // A holder that stops reading cannot hold a request (and the registry lock) past its bound.
        stream
            .set_write_timeout(Some(QUICK_WAIT))
            .map_err(|e| e.to_string())?;
        let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
        let (output, reading, paste_mode) = (replay.clone(), alive.clone(), paste.clone());
        let publish = move |payload: Vec<u8>| {
            // v1a-29: the mode before the end, so a send that sees the new end also sees the mode.
            paste_mode.store(payload[0] == 1, Ordering::SeqCst);
            output
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(&payload[1..]);
            notify_output();
        };
        #[allow(unused_mut)]
        let mut publish: Box<dyn FnMut(Vec<u8>) + Send> = Box::new(publish);
        // v1a-29: a held reader holds only publishing; the holder's replies keep arriving.
        #[cfg(test)]
        if let Some(hold) = HOLD_AFTER_PUBLISH.take() {
            let (held, queued) = mpsc::channel::<Vec<u8>>();
            let mut inner = publish;
            thread::spawn(move || {
                for payload in queued {
                    inner(payload);
                    let _ = hold.recv();
                }
            });
            publish = Box::new(move |payload| {
                let _ = held.send(payload);
            });
        }
        thread::spawn(move || {
            while let Ok((op, payload)) = read_frame(&mut reader) {
                match op {
                    frame::OUTPUT if !payload.is_empty() => publish(payload),
                    frame::OUTPUT => {}
                    frame::EOF => {
                        reading.store(false, Ordering::SeqCst);
                        notify_output(); // S9 r3: the idle tick checks this session now
                    }
                    _ => {
                        if tx.send((op, payload)).is_err() {
                            break;
                        }
                    }
                }
            }
            reading.store(false, Ordering::SeqCst);
            notify_output(); // S9 r3: a holder that died is seen at once, not at the idle tick
        });
        Ok(Self {
            link: Mutex::new(Link {
                stream,
                replies,
                gone: false,
                late: 0,
                cut: false,
            }),
            replay,
            pid: 0,
            agent_started: None,
            stopped: false,
            alive,
            paste,
            holder,
            ended: None,
            lost: false,
            exit: None,
            asked: None,
            run_start: 0,
            input_blocked: false,
        })
    }
    /// V2-1b: the core lets go of this session without ending it (a core exit or `serve restart`): the link closes
    /// and the holder keeps its agent for the next core.
    pub fn leave(mut self) {
        self.finish();
    }
    /// V2-1b: whether the session ended because its holder died.
    pub fn lost(&self) -> bool {
        self.lost
    }
    /// V2-5b: the agent's exit code, once its holder reported the end.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit
    }
    /// V2-1b: the agent's start time, as sessions.json keeps it.
    pub fn agent_started(&self) -> Option<u64> {
        self.agent_started
    }
    /// One request and its reply within `wait`; `Err` only when the holder cannot be asked.
    fn request(&self, op: u8, payload: &[u8], wait: Duration) -> Result<(u8, Vec<u8>), String> {
        let mut link = self.link.lock().unwrap_or_else(|e| e.into_inner());
        if link.gone {
            return Err(HOLDER_GONE.into());
        }
        if link.cut {
            return Err(match link.replies.try_recv() {
                Err(mpsc::TryRecvError::Disconnected) => {
                    link.gone = true;
                    HOLDER_GONE
                }
                _ => HOLDER_SILENT,
            }
            .into());
        }
        while link.late > 0 {
            match link.replies.try_recv() {
                Ok(_) => link.late -= 1,
                // Still owed: nothing more is sent to a holder that has not answered.
                Err(mpsc::TryRecvError::Empty) => return Err(HOLDER_SILENT.into()),
                Err(mpsc::TryRecvError::Disconnected) => {
                    link.gone = true;
                    return Err(HOLDER_GONE.into());
                }
            }
        }
        if let Err(e) = write_frame(&mut link.stream, op, payload) {
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) {
                link.cut = true;
                let _ = link.stream.shutdown(std::net::Shutdown::Write);
                return Err(HOLDER_SILENT.into());
            }
            link.gone = true;
            return Err(HOLDER_GONE.into());
        }
        match link.replies.recv_timeout(wait) {
            Ok(reply) => Ok(reply),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                link.late += 1;
                Err(HOLDER_SILENT.into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                link.gone = true;
                Err(HOLDER_GONE.into())
            }
        }
    }
    /// The holder's `OK` payload or its error text.
    fn ask(&self, op: u8, payload: &[u8], wait: Duration) -> Result<Vec<u8>, String> {
        match self.request(op, payload, wait)? {
            (frame::OK, payload) => Ok(payload),
            (frame::ERR, why) => Err(String::from_utf8_lossy(&why).into_owned()),
            _ => Err("unexpected holder reply".into()),
        }
    }
    /// V2-1a: the holder's record for sessions.json.
    pub fn holder(&self) -> &crate::holder::Record {
        &self.holder
    }
    pub fn lifetime(&self) -> Arc<AtomicBool> {
        self.alive.clone()
    }
    /// v1a-15: whether the agent has bracketed paste on.
    pub fn bracketed_paste(&self) -> bool {
        self.paste.load(Ordering::SeqCst)
    }
    /// v1a-15: the replay cursor after the newest output byte.
    /// Ticket 505: see the field.
    pub fn run_start(&self) -> u64 {
        self.run_start
    }
    /// Ticket 512: a reattached session's `run_start`, as the last core stored it (the holder does not keep it).
    pub(crate) fn set_run_start(&mut self, at: u64) {
        self.run_start = at;
    }
    pub fn end(&self) -> u64 {
        self.replay.lock().unwrap_or_else(|e| e.into_inner()).end
    }
    /// v1a-27: the replay's end cursor, readable without the session registry.
    pub fn tail(&self) -> Tail {
        Tail(self.replay.clone())
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn input_blocked(&self) -> bool {
        self.input_blocked
    }
    pub fn alive(&mut self) -> Result<bool, String> {
        if self.stopped {
            return Ok(false);
        }
        // S9 r3: no round trip per tick while nothing says the agent ended. A holder that dies closes the link (the
        // reader clears `alive`), an agent that ends sends its end of output or leaves the process table (a zombie
        // counts as ended), and each is seen at the next tick; anything else within `ALIVE_RECHECK`.
        if self.ended.is_none()
            && self.alive.load(Ordering::SeqCst)
            && self.asked.is_some_and(|at| at.elapsed() < ALIVE_RECHECK)
            && self.agent_live()
        {
            return Ok(true);
        }
        self.asked = Some(std::time::Instant::now());
        match self.ask(frame::ALIVE, &[], QUICK_WAIT) {
            Ok(answer) if answer == [1] => Ok(true),
            // The holder stopped the exited agent's group (as v1a's `alive` did). V2-1a r3: until its last output is
            // in (the end-of-output frame), within a bound, the session still counts as running, so a saved
            // scrollback keeps it; checked again next tick rather than waited for under the registry lock.
            Ok(answer) => {
                // V2-5b: a holder of this version follows "ended" with the exit code.
                if let [0, a, b, c, d] = answer[..] {
                    self.exit = Some(i32::from_be_bytes([a, b, c, d]));
                }
                let since = *self.ended.get_or_insert_with(std::time::Instant::now);
                if self.alive.load(Ordering::SeqCst) && since.elapsed() < TAIL_WAIT {
                    return Ok(true);
                }
                self.finish();
                Ok(false)
            }
            // V2-1a r3: a silent holder ends nothing: the session runs while its agent does.
            Err(e) if e == HOLDER_SILENT => {
                if self.agent_live() {
                    Ok(true)
                } else {
                    self.finish();
                    Ok(false)
                }
            }
            Err(e) if e == HOLDER_GONE => {
                eprintln!("session holder {} ended", self.holder.pid);
                self.lost = true;
                if self.bury() {
                    Ok(false)
                } else {
                    Err(AGENT_OUTLIVED.into())
                }
            }
            Err(e) => Err(e),
        }
    }
    /// V2-1a r3: whether the agent's leader lives, from the process table (it holds without the holder); a process on
    /// the same pid with another start time is not it. Unreadable counts as live, which refuses rather than starts.
    fn agent_live(&self) -> bool {
        crate::peer::running_since(self.pid, self.agent_started)
    }
    /// V2-1a r3: whether this session's agent may still run; while it does, its conversation does not start again.
    pub fn agent_running(&self) -> bool {
        !self.stopped && self.agent_live()
    }
    /// V2-1a r3: the holder is gone. Ends the agent's group as the holder would have (a session leader's group id is
    /// its pid, and the leader still lives, so the group is the agent's); `true` once the agent has ended.
    /// Signals only the process read back with the agent's start time; waits briefly (under the registry lock): a
    /// group still dying is reported as outliving its holder, and a later tick finds it gone.
    fn bury(&mut self) -> bool {
        if let Some(started) = self.agent_started
            && crate::peer::is_same(self.pid, started)
        {
            unsafe { libc::killpg(self.pid as i32, libc::SIGKILL) };
            let until = std::time::Instant::now() + Duration::from_millis(200);
            while self.agent_live() && std::time::Instant::now() < until {
                thread::sleep(Duration::from_millis(10));
            }
        }
        let ended = !self.agent_live();
        if ended {
            self.finish();
        }
        ended
    }
    /// Stopped: the link closes, so the holder exits; the mirrored replay stays readable.
    fn finish(&mut self) {
        self.stopped = true;
        self.alive.store(false, Ordering::SeqCst);
        let link = self.link.get_mut().unwrap_or_else(|e| e.into_inner());
        link.gone = true;
        let _ = link.stream.shutdown(std::net::Shutdown::Both);
    }

    pub fn read(&self, after: u64) -> Result<crate::api::Reply, String> {
        self.read_at_most(after, usize::MAX)
    }
    /// v1a-19: `read`, copying at most `max` bytes; `end` stays the newest cursor.
    pub fn read_at_most(&self, after: u64, max: usize) -> Result<crate::api::Reply, String> {
        let r = self.replay.lock().unwrap_or_else(|e| e.into_inner());
        r.read_at_most(after, max)
    }
    /// v1a-40: the replay's bytes, copied under its mutex once.
    pub fn snapshot(&self) -> Vec<u8> {
        let r = self.replay.lock().unwrap_or_else(|e| e.into_inner());
        r.bytes.iter().copied().collect()
    }
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() > INPUT_BYTES {
            return Err("terminal input exceeds 64 KiB".into());
        }
        if self.stopped {
            return Err("session has exited".into());
        }
        // The holder checks the agent is alive, then writes within v1a's 100 ms bound.
        let result = match self.ask(frame::WRITE, data, QUICK_WAIT) {
            Err(e) if e == HOLDER_GONE => {
                // Q9 es-J6-1: as `alive` does, so the session is resumable, not a normal exit.
                self.lost = true;
                Err(if self.bury() {
                    "session has exited"
                } else {
                    AGENT_OUTLIVED
                }
                .into())
            }
            result => result.map(|_| ()),
        };
        // v19-Q9-cx: a refused write was told to its sender only, so the tree read the session as idle.
        match &result {
            Ok(()) => self.input_blocked = false,
            Err(e) if e.starts_with("terminal input blocked") => self.input_blocked = true,
            Err(_) => {}
        }
        result
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 || cols > 500 || rows > 300 {
            return Err("invalid terminal dimensions".into());
        }
        // shortcut: a stopped session's holder is gone, so its resize is a no-op (v1a resized a master no process
        // read). Keep the holder until close if a client ever reads a stopped terminal's size.
        if self.stopped {
            return Ok(());
        }
        let mut size = cols.to_be_bytes().to_vec();
        size.extend(rows.to_be_bytes());
        self.ask(frame::RESIZE, &size, QUICK_WAIT).map(|_| ())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        // S9 r3: asked within QUICK_WAIT first, as the per-tick ask did before: a silent holder then refuses the stop at
        // once (its reply is owed) instead of after SLOW_WAIT.
        if !self.stopped {
            self.asked = None;
            let _ = self.alive();
        }
        if self.stopped {
            return Ok(());
        }
        match self.ask(frame::STOP, &[], SLOW_WAIT) {
            Ok(_) => {
                self.finish();
                Ok(())
            }
            Err(e) if e == HOLDER_GONE => {
                if self.bury() {
                    Ok(())
                } else {
                    Err(AGENT_OUTLIVED.into())
                }
            }
            // V2-1a r3: the agent may still run, so this is an error (a close or a Codex switch refuses) and the
            // session stays as it is; an agent that already ended counts as stopped.
            Err(e) if e == HOLDER_SILENT => {
                if self.agent_live() {
                    Err(format!("{e}; the agent still runs"))
                } else {
                    self.finish();
                    Ok(())
                }
            }
            Err(e) => Err(e),
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.stop();
        // Closing the link ends the holder (V2-1a: it lives as long as its core's link).
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn home() -> std::path::PathBuf {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("pty-{}", crate::store::new_id().unwrap()));
        std::fs::create_dir_all(&home).unwrap();
        home
    }
    fn wait(what: &str, mut ok: impl FnMut() -> bool) {
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while !ok() {
            assert!(std::time::Instant::now() < until, "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn text(pty: &Pty, after: u64) -> String {
        match pty.read(after).unwrap() {
            crate::api::Reply::Output { data, .. } => String::from_utf8_lossy(&data).into(),
            _ => unreachable!(),
        }
    }

    // V2-1a acceptance: v1a's `Pty` interface, served by a holder (in this test process: no `use_executable`).
    #[test]
    fn pty_client_same_interface() {
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "printf 'ready\n'; printf '\\033[?2004h'; printf '\\033[6n'; IFS= read -r a; printf 'got:%s\n' \"$a\"; read b",
        ]);
        let mut pty = Pty::spawn(&home, "s-interface", cmd, b"seed|").unwrap();
        assert!(pty.pid() > 0);
        assert_ne!(pty.pid(), std::process::id());
        // The seed is the replay's start, before any output arrives.
        assert!(text(&pty, 0).starts_with("seed|"));
        wait("ready", || text(&pty, 0).contains("ready"));
        wait("paste mode", || pty.bracketed_paste());
        let lifetime = pty.lifetime();
        assert!(lifetime.load(Ordering::SeqCst));
        let tail = pty.tail();
        // The holder answered the cursor query (CPR) itself: `read` got it as input.
        pty.write(b"line\n").unwrap();
        wait("echo", || text(&pty, 0).contains("got:\x1b[1;1Rline"));
        assert_eq!(tail.end(), pty.end());
        assert_eq!(pty.snapshot(), text(&pty, 0).into_bytes());
        // Cursors: a read after `end` is refused, a capped read keeps `end` newest.
        let end = pty.end();
        assert!(pty.read(end + 1).is_err());
        match pty.read_at_most(0, 2).unwrap() {
            crate::api::Reply::Output {
                data,
                start,
                end: e,
                truncated,
            } => {
                assert_eq!(
                    (data.as_slice(), start, e, truncated),
                    (&b"se"[..], 0, end, false)
                );
            }
            _ => unreachable!(),
        }
        assert_eq!(
            pty.write(&vec![b'x'; INPUT_BYTES + 1]).unwrap_err(),
            "terminal input exceeds 64 KiB"
        );
        assert_eq!(
            pty.resize(0, 10).unwrap_err(),
            "invalid terminal dimensions"
        );
        pty.resize(100, 40).unwrap();
        assert!(pty.alive().unwrap());
        pty.write(b"bye\n").unwrap();
        wait("exit", || !pty.alive().unwrap());
        assert!(!lifetime.load(Ordering::SeqCst));
        assert_eq!(pty.write(b"x").unwrap_err(), "session has exited");
        pty.stop().unwrap();
        pty.stop().unwrap();
        // The replay outlives the agent and its holder.
        assert!(text(&pty, 0).contains("got:"));
        let socket = pty.holder().socket.clone();
        drop(pty);
        wait("socket removed", || !socket.exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2-1a r2 (security MUST): a process that swaps the holder's socket path between the core's bind and its first
    // link gets nothing: the core's link to its holder is not reached through the path.
    #[test]
    fn start_never_talks_to_a_rebound_socket() {
        let home = home();
        let (tx, rx) = mpsc::channel();
        crate::holder::AFTER_BIND.set(Some(Box::new(move |path: &std::path::Path| {
            std::fs::remove_file(path).unwrap();
            let rogue = std::os::unix::net::UnixListener::bind(path).unwrap();
            rogue.set_nonblocking(true).unwrap();
            tx.send(rogue).unwrap();
        })));
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "IFS= read -r a; printf 'got:%s\\n' \"$a\"; exec sleep 30",
        ]);
        let started = Pty::spawn(&home, "s-rebound", cmd, &[]);
        let rogue = rx.recv().unwrap();
        let reached = rogue.accept().is_ok();
        let mut pty = started.unwrap();
        assert!(!reached, "the core connected to the swapped socket");
        pty.write(b"secret\n").unwrap();
        wait("echo", || text(&pty, 0).contains("got:secret"));
        assert!(
            rogue.accept().is_err(),
            "nothing reached the swapped socket"
        );
        drop(pty);
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2-1b: a holder outlives its core's link; the next core attaches once (a second is refused while one is
    // attached), and the output stream after the ring's snapshot carries on with no byte lost or doubled.
    #[test]
    fn a_left_holder_is_attached_once_with_every_byte() {
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "i=0; while [ $i -lt 30000 ]; do echo $i; i=$((i+1)); done; exec sleep 30",
        ]);
        let pty = Pty::spawn(&home, "s-left", cmd, &[]).unwrap();
        let (record, agent) = (pty.holder().clone(), pty.pid());
        wait("output started", || text(&pty, 0).contains("\n100\r"));
        pty.leave();
        let Attach::Attached(mut pty) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("not attached")
        };
        assert_eq!(pty.pid(), agent);
        assert!(
            matches!(Pty::attach(&record, QUICK_WAIT), Attach::Gone(why) if why == "holder already has its core"),
            "a second core attached"
        );
        wait("output finished", || text(&pty, 0).contains("\n29999\r"));
        // The terminal sometimes ends a line with "\r\r\n"; only the numbers matter.
        let lines: Vec<u32> = text(&pty, 0)
            .split('\n')
            .filter_map(|l| {
                // The first line starts with the holder's size mark (ticket 995).
                let l = l.trim_start_matches("\x1b[8;50;160t");
                l.trim_end_matches('\r').parse().ok()
            })
            .collect();
        assert_eq!(
            lines,
            (0..30000).collect::<Vec<_>>(),
            "a byte lost or doubled"
        );
        pty.write(b"x").unwrap();
        pty.stop().unwrap();
        assert!(!crate::peer::running_since(agent, None));
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2-1b (spec V2-1 Orphans): with no core, a holder keeps running while its agent does, and exits on its own
    // only once its agent ended and no core collected that within the orphan wait (10 minutes; shortened here).
    #[test]
    fn an_orphan_holder_exits_only_after_its_agent_and_the_wait() {
        *crate::holder::ORPHAN_WAIT_TEST.lock().unwrap() = Some(Duration::from_millis(1500));
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'up\\n'; read x; exit 0"]);
        let mut pty = Pty::spawn(&home, "s-orphan", cmd, &[]).unwrap();
        let (socket, agent) = (pty.holder().socket.clone(), pty.pid());
        wait("up", || text(&pty, 0).contains("up"));
        pty.write(b"\n").unwrap();
        // Leave before the agent's end is collected: nothing collects it.
        pty.leave();
        wait("agent ends", || !crate::peer::running_since(agent, None));
        thread::sleep(Duration::from_millis(700));
        assert!(
            socket.exists(),
            "the holder left before the orphan wait passed"
        );
        wait("the holder exits after the orphan wait", || {
            !socket.exists()
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2-1b (carried V2-1a review): a reattaching core connects by path, so it checks the socket's peer is the
    // recorded holder process before it sends a byte.
    #[test]
    fn attach_never_talks_to_another_process_on_the_socket() {
        let home = home();
        // Under the system temp dir: a socket path must fit `sun_path` (AGENTS.md storage exception).
        let path = std::env::temp_dir().join(format!("ns-imp-{}-0.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let got = home.join("got");
        let mut impostor = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "exec /usr/bin/nc -lU \"$0\" > \"$1\"",
                path.to_str().unwrap(),
                got.to_str().unwrap(),
            ])
            .spawn()
            .unwrap();
        let me = std::process::id();
        let record = crate::holder::Record {
            socket: path.clone(),
            protocol: frame::PROTOCOL,
            pid: me,
            started: crate::peer::started(me).unwrap(),
        };
        // `nc -lU` creates the path before it listens, so a connect can be refused first; only a connection that
        // reaches the peer check gives "not holder", and that is the answer required.
        let until = std::time::Instant::now() + Duration::from_secs(10);
        let why = loop {
            match Pty::attach(&record, QUICK_WAIT) {
                Attach::Gone(why) if why.contains("refused") || why.contains("No such file") => {
                    assert!(
                        std::time::Instant::now() < until,
                        "impostor never listened: {why}"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Attach::Gone(why) => break why,
                _ => panic!("attached to another process"),
            }
        };
        assert!(why.contains("not holder"), "{why}");
        thread::sleep(Duration::from_millis(200));
        let _ = impostor.kill();
        let _ = impostor.wait();
        assert_eq!(
            std::fs::read(&got).unwrap_or_default(),
            b"",
            "a byte reached another process"
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// V1A-79: a holder that answers each attach with `replies[n]` (`true` admits it with an empty ring, `false`
    /// refuses as a holder with a core does; the last reply repeats), recording the instant of each attempt. This
    /// test process stands in for the holder process, so the peer check passes.
    fn refusing(
        replies: &'static [bool],
        hello_version: u16,
    ) -> (crate::holder::Record, Arc<Mutex<Vec<std::time::Instant>>>) {
        busy_then(0, replies, hello_version)
    }
    /// The bytes a holder sends, in place of its hello, to a peer whose check could not finish.
    const BUSY_FRAME: &[u8] = b"\0\0\0\x10\x82peer check busy";
    /// V2.5-47: `refusing`, whose first `busy` attempts get `BUSY_FRAME` and are closed.
    fn busy_then(
        busy: usize,
        replies: &'static [bool],
        hello_version: u16,
    ) -> (crate::holder::Record, Arc<Mutex<Vec<std::time::Instant>>>) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "ns-rt-{}-{}.sock",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_file(&path);
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let seen = attempts.clone();
        thread::spawn(move || {
            for (n, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { return };
                seen.lock().unwrap().push(std::time::Instant::now());
                if n < busy {
                    let _ = stream.write_all(BUSY_FRAME);
                    // As the holder: open until the client, which checks this pid first, hangs up.
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.read(&mut [0; 1]);
                    continue;
                }
                let n = n - busy;
                let mut hello = frame::hello();
                hello[8..10].copy_from_slice(&hello_version.to_be_bytes());
                let _ = stream.write_all(&hello);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut theirs = [0; 12];
                if stream.read_exact(&mut theirs).is_err() || read_frame(&mut stream).is_err() {
                    continue;
                }
                if replies[n.min(replies.len() - 1)] {
                    let mut ok = vec![0, 0, 0, 7];
                    ok.extend(1u64.to_be_bytes());
                    ok.extend([0, 0]);
                    ok.extend(0u64.to_be_bytes());
                    let _ = write_frame(&mut stream, frame::OK, &ok);
                    // Keep the link open: dropping it would end the client's reader, which is fine, but a test
                    // may look at the attached session.
                    thread::sleep(Duration::from_secs(1));
                } else {
                    let _ = write_frame(&mut stream, frame::ERR, b"holder already has its core");
                }
            }
        });
        let me = std::process::id();
        let record = crate::holder::Record {
            socket: path,
            protocol: frame::PROTOCOL,
            pid: me,
            started: crate::peer::started(me).unwrap(),
        };
        (record, attempts)
    }
    fn gaps(attempts: &Mutex<Vec<std::time::Instant>>) -> Vec<Duration> {
        let at = attempts.lock().unwrap();
        at.windows(2).map(|w| w[1] - w[0]).collect()
    }

    // V1A-79: a holder that frees its core flag after two refusals is attached on the third try, and no more.
    #[test]
    fn attach_retrying_attaches_when_the_flag_frees() {
        let (record, attempts) = refusing(&[false, false, true], frame::PROTOCOL);
        let Attach::Attached(_) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("not attached")
        };
        assert_eq!(attempts.lock().unwrap().len(), 3, "exactly 3 attempts");
        let _ = std::fs::remove_file(&record.socket);
    }

    // V1A-79 (threat 2): a holder that keeps refusing is tried 5 times, 100 ms apart, then the refusal comes back.
    #[test]
    fn attach_retrying_does_not_busy_loop() {
        let (record, attempts) = refusing(&[false], frame::PROTOCOL);
        let began = std::time::Instant::now();
        assert!(
            matches!(Pty::attach_retrying(&record, QUICK_WAIT), Attach::Gone(why) if why == "holder already has its core")
        );
        assert!(began.elapsed() < Duration::from_secs(3));
        assert_eq!(attempts.lock().unwrap().len(), 5, "exactly 5 attempts");
        for gap in gaps(&attempts) {
            assert!(gap >= Duration::from_millis(90), "a gap of {gap:?}");
        }
        let _ = std::fs::remove_file(&record.socket);
        // Any other answer returns after one attempt.
        for version in [frame::PROTOCOL + 1, frame::PROTOCOL - 1] {
            let (record, attempts) = refusing(&[false], version);
            match Pty::attach_retrying(&record, QUICK_WAIT) {
                Attach::Newer(v) | Attach::Older(v) => assert_eq!(v, version),
                _ => panic!("not a version answer"),
            }
            assert_eq!(attempts.lock().unwrap().len(), 1, "version {version}");
            let _ = std::fs::remove_file(&record.socket);
        }
        // A socket served by another process (peer check fails) is not retried.
        let (mut record, attempts) = refusing(&[false], frame::PROTOCOL);
        record.pid += 1;
        assert!(
            matches!(Pty::attach_retrying(&record, QUICK_WAIT), Attach::Gone(why) if why.contains("not holder"))
        );
        // The client returns before the fake holder's accept thread records the connection.
        wait("the attempt is seen", || {
            attempts.lock().unwrap().len() == 1
        });
        thread::sleep(Duration::from_millis(250));
        assert_eq!(attempts.lock().unwrap().len(), 1, "peer check");
        let _ = std::fs::remove_file(&record.socket);
    }

    // V1A-79 (threat 1): the retry never admits a second core while the first is attached.
    #[test]
    fn attach_retrying_never_attaches_a_second_core() {
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "IFS= read -r a; printf 'got:%s\\n' \"$a\"; exec sleep 30",
        ]);
        let first = Pty::spawn(&home, "s-second", cmd, &[]).unwrap();
        let record = first.holder().clone();
        first.leave();
        let mut a = match Pty::attach_retrying(&record, QUICK_WAIT) {
            Attach::Attached(a) => a,
            Attach::Gone(why) => panic!("core A not attached: {why}"),
            Attach::Older(v) | Attach::Newer(v) => panic!("core A not attached: protocol {v}"),
        };
        let began = std::time::Instant::now();
        match Pty::attach_retrying(&record, QUICK_WAIT) {
            Attach::Gone(why) => assert_eq!(why, CORE_HELD, "the second attach's refusal"),
            _ => panic!("a second core attached"),
        }
        let took = began.elapsed();
        assert!(
            took >= Duration::from_millis(400) && took < Duration::from_secs(3),
            "{took:?}"
        );
        a.write(b"hi\n").unwrap();
        wait("echo", || text(&a, 0).contains("got:hi"));
        // Threat 2: once A's link ends the flag frees, so the session is not stranded: a third core attaches.
        a.leave();
        let Attach::Attached(mut third) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("no core attached after A left")
        };
        assert!(text(&third, 0).contains("got:hi"), "the ring carries over");
        third.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // Pty flake S4: a refused second core that writes its ATTACH after the holder has answered must still read the
    // answer. The holder used to close at once; the late write then failed (broken pipe) and the refusal was lost,
    // which `attach_retrying` does not retry. The late write is forced here with a pause.
    #[test]
    fn refused_core_reads_the_refusal_after_a_late_write() {
        let home = home();
        let first = Pty::spawn(&home, "s-late", sleeper(), &[]).unwrap();
        let record = first.holder().clone();
        first.leave();
        let Attach::Attached(mut a) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("core A not attached")
        };
        let mut peer = UnixStream::connect(&record.socket).unwrap();
        peer.set_read_timeout(Some(QUICK_WAIT)).unwrap();
        crate::holder::read_hello_or_busy(&mut peer).unwrap();
        peer.write_all(&frame::hello()).unwrap();
        thread::sleep(Duration::from_millis(300));
        write_frame(&mut peer, frame::ATTACH, &[])
            .expect("the holder closed before the late ATTACH");
        let (op, why) = read_frame(&mut peer).unwrap();
        assert_eq!((op, &why[..]), (frame::ERR, CORE_HELD.as_bytes()));
        a.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2.5-47: the holder frees its core flag only after the old link's service ended. Hold that gap open (link closed,
    // flag still taken) and no attach is admitted; let go and two racing cores get exactly one admission.
    #[test]
    fn second_core_refused_under_forced_interleaving() {
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "exec sleep 30"]);
        let first = Pty::spawn(&home, "s-forced", cmd, &[]).unwrap();
        let record = first.holder().clone();
        let (reached_tx, reached) = mpsc::channel();
        let (release, go) = mpsc::channel();
        *crate::holder::BEFORE_RELEASE.lock().unwrap() = Some(("s-forced".into(), reached_tx, go));
        first.leave();
        reached
            .recv_timeout(Duration::from_secs(10))
            .expect("the holder noticed the closed link");
        for _ in 0..3 {
            assert!(
                matches!(Pty::attach(&record, QUICK_WAIT), Attach::Gone(why) if why == CORE_HELD),
                "a core was admitted while the flag was taken"
            );
        }
        release.send(()).unwrap();
        let race = |record: crate::holder::Record| {
            thread::spawn(move || Pty::attach_retrying(&record, QUICK_WAIT))
        };
        let (x, y) = (race(record.clone()), race(record.clone()));
        let (x, y) = (x.join().unwrap(), y.join().unwrap());
        let (mut winner, loser) = match (x, y) {
            (Attach::Attached(w), l) | (l, Attach::Attached(w)) => (w, l),
            _ => panic!("no core attached after the flag freed"),
        };
        assert!(
            matches!(loser, Attach::Gone(ref why) if why == CORE_HELD),
            "two cores shared one holder"
        );
        winner.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // Look 1117 v9 (A S3-3): a shell at its prompt holds its terminal; a command it runs takes it, until it ends.
    #[test]
    fn foreground_job_is_a_running_command() {
        let home = home();
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-f", "-i"]);
        let mut pty = Pty::spawn(&home, "s-fg", cmd, &[]).unwrap();
        wait("prompt", || !text(&pty, 0).is_empty());
        assert!(!crate::peer::foreground_job(pty.pid()));
        pty.write(b"sleep 30\n").unwrap();
        wait("sleep in front", || crate::peer::foreground_job(pty.pid()));
        pty.write(b"\x03").unwrap();
        wait("back at the prompt", || {
            !crate::peer::foreground_job(pty.pid())
        });
        pty.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }
    fn sleeper() -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "echo up; exec sleep 30"]);
        cmd
    }
    /// V2.5-47: the next peer check on `record`'s holder fails as a busy process table makes it.
    fn busy_next(record: &crate::holder::Record) {
        crate::peer::BUSY_ONCE
            .lock()
            .unwrap()
            .push(record.socket.clone());
    }
    /// What the holder at `record` sends a peer that says nothing and hangs up, until it closes the link or 2 s pass.
    fn first_bytes(record: &crate::holder::Record) -> Vec<u8> {
        let mut peer = UnixStream::connect(&record.socket).unwrap();
        peer.set_read_timeout(Some(QUICK_WAIT)).unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        let mut got = vec![];
        let _ = peer.read_to_end(&mut got);
        got
    }
    fn holder_log(home: &std::path::Path, id: &str) -> String {
        std::fs::read_to_string(home.join("logs/sessions").join(format!("{id}.log")))
            .unwrap_or_default()
    }

    // V2.5-47: a peer check that could not finish is answered with exactly the fixed ERR frame, then the link closes.
    #[test]
    fn holder_transient_peer_check_sends_fixed_err() {
        let home = home();
        let mut pty = Pty::spawn(&home, "s-busy", sleeper(), &[]).unwrap();
        let record = pty.holder().clone();
        busy_next(&record);
        let mut peer = UnixStream::connect(&record.socket).unwrap();
        peer.set_read_timeout(Some(QUICK_WAIT)).unwrap();
        let mut answer = [0; BUSY_FRAME.len()];
        peer.read_exact(&mut answer).unwrap();
        assert_eq!(&answer[..], BUSY_FRAME);
        assert!(crate::peer::BUSY_ONCE.lock().unwrap().is_empty());
        // The holder keeps the link until the peer hangs up, so a client that checks the holder's pid only after
        // the answer arrived (`attach` checks before it reads) still can.
        thread::sleep(Duration::from_millis(200));
        assert_eq!(crate::peer::of(&peer).unwrap().pid as u32, record.pid);
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        let began = std::time::Instant::now();
        let mut rest = vec![];
        peer.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"", "nothing after the frame");
        assert!(began.elapsed() < Duration::from_secs(1), "the link closed");
        pty.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2.5-47 (threat 1): the busy answer names no reason, pid or path; a definitive refusal (a peer inside another
    // session) still receives nothing, so the frame does not tell a peer which kind it is.
    #[test]
    fn holder_refusal_frame_leaks_no_reason() {
        let home = home();
        let mut target = Pty::spawn(&home, "s-target", sleeper(), &[]).unwrap();
        let record = target.holder().clone();
        busy_next(&record);
        let got = first_bytes(&record);
        assert!(!got.is_empty(), "no busy answer");
        let socket = record.socket.as_os_str().as_encoded_bytes().to_vec();
        for needle in [
            b"process".to_vec(),
            b"failed".to_vec(),
            b"session".to_vec(),
            record.pid.to_string().into_bytes(),
            target.pid().to_string().into_bytes(),
            socket,
        ] {
            assert!(
                !got.windows(needle.len()).any(|w| w == needle),
                "the answer carries {:?}",
                String::from_utf8_lossy(&needle)
            );
        }
        let out = home.join("inside.out");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            &format!(
                "sleep 1 | /usr/bin/nc -U '{}' > '{}'; echo checked; exec sleep 30",
                record.socket.display(),
                out.display()
            ),
        ]);
        let mut inside = Pty::spawn(&home, "s-inside", cmd, &[]).unwrap();
        wait("the inside peer ran", || {
            text(&inside, 0).contains("checked")
        });
        wait("the holder refused it", || {
            holder_log(&home, "s-target").contains("is inside session")
        });
        assert_eq!(
            std::fs::read(&out).unwrap(),
            b"",
            "a refused peer received bytes"
        );
        inside.stop().unwrap();
        target.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2.5-47 (threat 2): a peer whose check failed never reaches the hello or the core flag; the next core attaches.
    #[test]
    fn holder_transient_peer_check_keeps_flag_free() {
        let home = home();
        let first = Pty::spawn(&home, "s-free", sleeper(), &[]).unwrap();
        let (record, agent) = (first.holder().clone(), first.pid());
        first.leave();
        busy_next(&record);
        match Pty::attach(&record, QUICK_WAIT) {
            Attach::Gone(why) => assert_eq!(why, "peer check busy"),
            _ => panic!("a peer whose check failed was answered otherwise"),
        }
        let Attach::Attached(mut next) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("the next core was not attached")
        };
        assert_eq!(next.pid(), agent);
        wait("the reattach is logged", || {
            holder_log(&home, "s-free").contains("core reattached")
        });
        let log = holder_log(&home, "s-free");
        assert_eq!(log.matches("core reattached").count(), 1, "{log}");
        assert_eq!(log.matches("peer check failed").count(), 1, "{log}");
        next.stop().unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2.5-47: a full quit's stop retries the busy answer like `CORE_HELD`, so one failed check does not leave the
    // holder running.
    #[test]
    fn stop_at_retries_peer_check_busy() {
        let home = home();
        let pty = Pty::spawn(&home, "s-stop", sleeper(), &[]).unwrap();
        let (record, agent) = (pty.holder().clone(), pty.pid());
        pty.leave();
        busy_next(&record);
        crate::holder::stop_at(&record.socket, Some((record.pid, record.started))).unwrap();
        wait("the agent ended", || {
            !crate::peer::running_since(agent, None)
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    // V2.5-47: one busy answer is retried like `CORE_HELD`; the second try attaches.
    #[test]
    fn attach_retrying_retries_peer_check_busy() {
        let (record, attempts) = busy_then(1, &[true], frame::PROTOCOL);
        let Attach::Attached(_) = Pty::attach_retrying(&record, QUICK_WAIT) else {
            panic!("not attached")
        };
        assert_eq!(
            attempts.lock().unwrap().len(),
            2,
            "attached on the second try"
        );
        for gap in gaps(&attempts) {
            assert!(gap >= Duration::from_millis(90), "a gap of {gap:?}");
        }
        let _ = std::fs::remove_file(&record.socket);
    }

    // V2.5-47 (threat 3): a holder that stays busy is tried 5 times, 100 ms apart, then the fixed code comes back.
    #[test]
    fn attach_retrying_peer_check_busy_is_bounded() {
        let (record, attempts) = busy_then(usize::MAX, &[true], frame::PROTOCOL);
        let began = std::time::Instant::now();
        match Pty::attach_retrying(&record, QUICK_WAIT) {
            Attach::Gone(why) => assert_eq!(why, "peer check busy"),
            _ => panic!("not the busy answer"),
        }
        assert!(began.elapsed() < Duration::from_secs(3));
        assert_eq!(attempts.lock().unwrap().len(), 5, "exactly 5 attempts");
        for gap in gaps(&attempts) {
            assert!(gap >= Duration::from_millis(90), "a gap of {gap:?}");
        }
        let _ = std::fs::remove_file(&record.socket);
    }

    // V2-1a r3: a session whose holder never reads (`_holder` is the other end) or is gone (`replies` dropped), around
    // a live process of this test that leads its own group, as an agent does.
    fn fake(
        agent: &std::process::Child,
        started: u64,
    ) -> (Pty, UnixStream, mpsc::Sender<(u8, Vec<u8>)>) {
        let (stream, holder) = UnixStream::pair().unwrap();
        stream.set_write_timeout(Some(QUICK_WAIT)).unwrap();
        let (tx, replies) = mpsc::channel();
        let pty = Pty {
            link: Mutex::new(Link {
                stream,
                replies,
                gone: false,
                late: 0,
                cut: false,
            }),
            replay: Default::default(),
            pid: agent.id(),
            agent_started: Some(started),
            stopped: false,
            alive: Arc::new(AtomicBool::new(true)),
            paste: Default::default(),
            holder: crate::holder::Record {
                socket: "/nowhere".into(),
                protocol: 1,
                pid: 0,
                started: 0,
            },
            ended: None,
            lost: false,
            exit: None,
            asked: None,
            run_start: 0,
            input_blocked: false,
        };
        (pty, holder, tx)
    }
    fn agent() -> (std::process::Child, u64) {
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let started = crate::peer::started(child.id()).unwrap();
        (child, started)
    }
    fn reap(mut child: std::process::Child) {
        let _ = child.kill();
        let _ = child.wait();
    }
    /// Whether `child` has exited, polled until `within` (its SIGKILL arrives asynchronously).
    fn exited(child: &mut std::process::Child, within: Duration) -> bool {
        let until = std::time::Instant::now() + within;
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= until {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        true
    }

    // V2-1a r3 (review MUST): a write cut by its bound (the holder stopped reading) leaves a silent holder, not a
    // gone one: its live agent is not killed, and the cut link is closed for writing so the holder ends when it runs.
    #[test]
    fn a_cut_write_kills_no_agent() {
        let (child, started) = agent();
        let (mut pty, holder, _replies) = fake(&child, started);
        let err = pty.write(&vec![b'x'; INPUT_BYTES]).unwrap_err();
        assert_eq!(err, HOLDER_SILENT);
        assert!(pty.alive().unwrap(), "the agent still runs");
        assert!(
            pty.stop().is_err(),
            "a silent holder's live agent is not stopped by the core"
        );
        // The holder, once it reads, finds the link closed after the cut frame.
        holder.set_nonblocking(true).unwrap();
        let mut sink = vec![];
        let _ = (&holder).read_to_end(&mut sink);
        let mut child = child;
        assert!(child.try_wait().unwrap().is_none(), "the agent was killed");
        reap(child);
    }

    // V2-1a r3 (review MUST): a gone holder's agent pid, reused by another process, is never signalled.
    #[test]
    fn a_reused_agent_pid_is_never_killed() {
        // The same process, recognised by its start time, is ended. `replies` dropped is a gone holder at once (no
        // bounded ask runs out), and SIGKILL reaches the group a moment later: `latency` is how long that took.
        let (mut child, started) = agent();
        let (mut pty, _holder, replies) = fake(&child, started);
        drop(replies);
        // A group still dying is reported as outliving its holder; a later tick finds it gone.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let ended = loop {
            match pty.alive() {
                Err(e) if e == AGENT_OUTLIVED && std::time::Instant::now() < until => {
                    thread::sleep(Duration::from_millis(10))
                }
                other => break other,
            }
        };
        assert_eq!(ended, Ok(false));
        assert!(pty.link.lock().unwrap().gone, "the holder-gone path ran");
        let at = std::time::Instant::now();
        assert!(
            exited(&mut child, Duration::from_secs(5)),
            "the agent was not ended"
        );
        let latency = at.elapsed();
        // Another process on the pid (the start time differs) is not signalled: watch as long as the kill took to show
        // (at least 200 ms, 5x that latency) and it must still run.
        let (mut child, started) = agent();
        let (mut pty, _holder, replies) = fake(&child, started + 1);
        drop(replies);
        assert!(pty.alive().is_ok());
        assert!(pty.link.lock().unwrap().gone, "the holder-gone path ran");
        assert!(
            !exited(&mut child, (latency * 5).max(Duration::from_millis(200))),
            "another process's group was killed"
        );
        reap(child);
    }

    // Q9 es-J6-1: a write that finds the holder gone marks the session lost, as `alive` does: it is resumable.
    #[test]
    fn a_write_to_a_gone_holder_marks_the_session_lost() {
        let (mut child, started) = agent();
        let (mut pty, _holder, replies) = fake(&child, started);
        drop(replies);
        assert!(pty.write(b"x").is_err());
        assert!(pty.lost(), "a gone holder read as a normal exit");
        assert!(exited(&mut child, Duration::from_secs(5)));
    }

    // V2-1a r2: an agent's last burst before it exits is in the replay once `alive` says it ended (so the saved
    // scrollback keeps it), though it reaches the core after the holder's answer.
    #[test]
    fn exit_keeps_the_last_burst() {
        let home = home();
        crate::holder::local::SLOW_MARKS
            .lock()
            .unwrap()
            .push("SLOW-TAIL");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "i=0; while [ $i -lt 2000 ]; do echo \"line $i ..................................................\"; i=$((i+1)); done; echo SLOW-TAIL END-OF-BURST",
        ]);
        let mut pty = Pty::spawn(&home, "s-burst", cmd, &[]).unwrap();
        wait("exit", || !pty.alive().unwrap());
        assert!(text(&pty, 0).contains("END-OF-BURST"));
        let _ = std::fs::remove_dir_all(&home);
    }

    // S9 r3: a running agent's `alive` asks its holder once per ALIVE_RECHECK, not per call; an agent killed outside the
    // holder is still seen ended (it leaves the process table, so the next call asks).
    #[test]
    fn alive_asks_the_holder_only_when_needed() {
        let home = home();
        let mut pty = Pty::spawn(&home, "s-alive", CommandBuilder::new("/bin/cat"), &[]).unwrap();
        assert!(pty.alive().unwrap());
        let asked = pty.asked;
        for _ in 0..20 {
            assert!(pty.alive().unwrap());
        }
        assert_eq!(pty.asked, asked, "a running agent's holder was asked again");
        unsafe { libc::kill(pty.pid() as i32, libc::SIGKILL) };
        wait("exit", || !pty.alive().unwrap());
        assert_ne!(pty.asked, asked);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn stop_ends_a_running_agent_and_its_holder() {
        let home = home();
        let mut pty = Pty::spawn(&home, "s-stop", CommandBuilder::new("/bin/cat"), &[]).unwrap();
        let pid = pty.pid() as i32;
        assert!(pty.alive().unwrap());
        pty.stop().unwrap();
        assert!(!pty.alive().unwrap());
        // The agent was this process's child (the holder runs here); stop reaped it.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        wait("socket removed", || !pty.holder().socket.exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_failed_spawn_leaves_no_holder() {
        let home = home();
        let err = Pty::spawn(
            &home,
            "s-missing",
            CommandBuilder::new("/no/such/agent"),
            &[],
        );
        assert!(err.is_err());
        let socket = crate::holder::socket_path(&home, "s-missing").unwrap();
        wait("socket removed", || !socket.exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
