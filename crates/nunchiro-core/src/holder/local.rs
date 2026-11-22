//! The PTY a holder owns: master, child process group, replay ring, paste mode and CPR/DA answers. V2-1a moved it
//! here from `pty.rs` unchanged except that each output read is also handed to `on_output` (the holder's socket).
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
use crate::pty::{INPUT_BYTES, Replay};
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::{
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::{Arc, Mutex},
    thread,
};

#[cfg(test)]
thread_local! {
    // v1a-27: makes the reader's `dup` fail, as fd exhaustion would.
    static FAIL_DUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static SPAWNED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

// V2-1a r2: a read holding one of these is handed on 300 ms late, as a loaded holder's last output can be.
#[cfg(test)]
pub(crate) static SLOW_MARKS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Called by the reader after it stores each read, with the agent's paste mode after it; an empty read means the
/// PTY ended.
pub type OnOutput = Box<dyn FnMut(&[u8], bool) + Send>;

/// V2-1b: what a holder keeps of its agent's output for a reattaching core: the replay ring, the agent's paste mode
/// and whether the PTY has ended. The reader updates it and calls `OnOutput` under one lock, so a core that snapshots
/// it under that lock gets every byte exactly once (in the snapshot or in the stream after it).
#[derive(Default)]
pub struct Ring {
    pub replay: Replay,
    pub paste: bool,
    pub ended: bool,
}

/// The PTY's input side. W20-C: a long paste that outlasts its bound leaves its rest in `backlog`, which one
/// background writer sends; every write made meanwhile (a key, a CPR answer) joins the backlog behind it, so no byte
/// ever lands inside the paste. W20-G: the backlog is never dropped while the agent lives; a write that would push it
/// past `BACKLOG_BYTES` fails at once instead, so every byte a write acknowledged is sent or the session has ended.
struct Input {
    writer: Box<dyn Write + Send>,
    backlog: Vec<u8>,
    /// Codex look of wave 20 (NOTE): the input channel failed for good (a write error or a zero-byte write that kept
    /// on); the backlog it held is gone and every later write reports this instead of being queued.
    broken: Option<String>,
}
/// W20-G: the most bytes the backlog holds; a full-size paste's rest plus the keys after it fit.
const BACKLOG_BYTES: usize = 2 * INPUT_BYTES;

pub struct Local {
    ring: Arc<Mutex<Ring>>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Input>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: u32,
    pgid: i32,
    stopped: bool,
    /// V2-5b: the agent's own exit code, when it ended before `stop` (not one `stop` killed).
    exit: Option<i32>,
}
/// The size the PTY opens at (rows, cols).
const START: (u16, u16) = (50, 160);
/// The PTY's size (rows, cols) as its master reads it.
fn winsize(fd: std::os::fd::RawFd) -> Option<(u16, u16)> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    (unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } == 0).then_some((ws.ws_row, ws.ws_col))
}
/// Lane w71: where the program's output stands in an escape sequence, as xterm.js's parser reads it. The size mark
/// goes in only at `Ground`: inside an open OSC 52 its ESC ended the sequence and the window ran the cut-off write.
#[derive(Clone, Copy, PartialEq)]
enum Seq {
    Ground,
    Esc,
    EscMid,
    Csi,
    Osc,
    /// DCS, SOS, PM or APC: only ST, CAN or SUB ends it (BEL ends an OSC alone).
    Str,
}
impl Seq {
    fn after(self, before: u8, byte: u8) -> Self {
        // A C1 control (U+0080 to U+009F, in UTF-8) is ESC and the byte 0x40 below it.
        let (seq, byte) = match byte {
            0x80..=0x9f if before == 0xc2 => (Seq::Esc, byte - 0x40),
            _ => (self, byte),
        };
        match (seq, byte) {
            (_, 0x1b) => Seq::Esc,
            (_, 0x18 | 0x1a) | (Seq::Osc, 0x07) => Seq::Ground,
            (Seq::Esc, b'[') => Seq::Csi,
            (Seq::Esc, b']') => Seq::Osc,
            (Seq::Esc, b'P' | b'X' | b'^' | b'_') => Seq::Str,
            (Seq::Esc, 0x20..=0x2f) => Seq::EscMid,
            (Seq::Esc | Seq::EscMid, 0x30..=0x7e) | (Seq::Csi, 0x40..=0x7e) => Seq::Ground,
            (seq, _) => seq,
        }
    }
}
/// The terminal's input queue on macOS: a write up to this size never needs the agent to read in between.
const QUEUE_BYTES: usize = 1024;

impl Local {
    /// v1a-40: the replay starts from `seed` (a resumed conversation's scrollback), capped like any output.
    pub fn spawn(
        cmd: CommandBuilder,
        seed: &[u8],
        mut on_output: OnOutput,
    ) -> Result<Self, String> {
        let pair = portable_pty::native_pty_system()
            .openpty(PtySize {
                rows: START.0,
                cols: START.1,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or("PTY has no native descriptor")?;
        // Bound writes even when an agent stops consuming input. Reader handles EAGAIN below.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(Input {
            writer: pair.master.take_writer().map_err(|e| e.to_string())?,
            backlog: vec![],
            broken: None,
        }));
        let protocol_writer = writer.clone();
        // The reader waits on its own duplicate of the master, so a closed and reused fd number is never polled.
        // v1a-27: before the spawn, like every fallible fd step, so a failure leaves no child behind. Close-on-exec
        // (atomic, as in approval/hash.rs), so no later child of this process can type into this session.
        let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        #[cfg(test)]
        let fd = if FAIL_DUP.get() {
            unsafe { libc::close(fd) };
            -1
        } else {
            fd
        };
        if fd == -1 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let wait_fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        #[cfg(test)]
        SPAWNED.set(SPAWNED.get() + 1);
        drop(pair.slave);
        let pid = child.process_id().ok_or("missing PTY child pid")?;
        // V2-1a: the holder's ring (V1A-40's 1 MiB); a reattaching core (V2-1b) reads it.
        let ring = Arc::new(Mutex::new(Ring::default()));
        ring.lock().unwrap().replay.push(seed);
        let reading = ring.clone();
        thread::spawn(move || {
            let fd = wait_fd.as_raw_fd();
            let mut paste_mode = false;
            let mut tail = [0u8; 8]; // v1a-15: last 8 output bytes, so a mode switch split across reads is seen
            let mut buf = [0; 16384];
            let mut queries = Vec::new();
            let mut replies = 0;
            let mut window = std::time::Instant::now();
            // Ticket 995 (v12-C-V10): no size yet, so the first output carries its size too: a window opening the
            // session late lays its first prompt out at the shell's width, and knows every part of the replay is sized.
            let mut size = (0, 0);
            let mut seq = Seq::Ground;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // v1a-29: record paste-mode switches before publishing the end, so a send that sees
                        // the new end also sees the mode it implies.
                        // Lane w71: the first place in this read where no escape sequence and no UTF-8 character
                        // is open, the only place a size mark may go.
                        let mut ground = None;
                        for (at, byte) in buf[..n].iter().enumerate() {
                            if ground.is_none()
                                && seq == Seq::Ground
                                && !(0x80..=0xbf).contains(byte)
                            {
                                ground = Some(at);
                            }
                            seq = seq.after(tail[7], *byte);
                            tail.rotate_left(1);
                            tail[7] = *byte;
                            match &tail {
                                b"\x1b[?2004h" => paste_mode = true,
                                b"\x1b[?2004l" => paste_mode = false,
                                _ => {}
                            }
                        }
                        #[cfg(test)]
                        if SLOW_MARKS
                            .lock()
                            .unwrap()
                            .iter()
                            .any(|m| buf[..n].windows(m.len()).any(|w| w == m.as_bytes()))
                        {
                            thread::sleep(std::time::Duration::from_millis(300));
                        }
                        {
                            let mut ring = reading.lock().unwrap_or_else(|e| e.into_inner());
                            // Look 1117 v12 A S2-A: a size change goes into the output before the bytes read after
                            // it, as XTWINOPS 8 (xterm.js ignores it live), so a replay draws each part at the size
                            // it was drawn at. shortcut: output still unread at the resize lands after the mark.
                            // w25-h gate: the mark rides in the read's own frame, so one read stays one publish
                            // (the core never sees a mark-only end carrying the mode of bytes it has not got yet).
                            // Lane w71: it waits for `ground`, in a later read if this one has none.
                            let mut marked = Vec::new();
                            if let (Some(at), Some(now)) =
                                (ground, winsize(fd).filter(|now| *now != size))
                            {
                                size = now;
                                let mark = format!("\x1b[8;{};{}t", now.0, now.1);
                                marked = [&buf[..at], mark.as_bytes(), &buf[at..n]].concat();
                            }
                            let out = if marked.is_empty() {
                                &buf[..n]
                            } else {
                                &marked[..]
                            };
                            ring.replay.push(out);
                            ring.paste = paste_mode;
                            on_output(out, paste_mode);
                        }
                        if window.elapsed().as_secs() >= 10 {
                            replies = 0;
                            window = std::time::Instant::now();
                        }
                        for byte in &buf[..n] {
                            if *byte == 27 {
                                queries.clear();
                            }
                            if !queries.is_empty() || *byte == 27 {
                                queries.push(*byte);
                            }
                            let patterns: &[(&[u8], &[u8])] = &[
                                (b"\x1b[6n", b"\x1b[1;1R"),
                                (b"\x1b[c", b"\x1b[?62;22c"),
                                (b"\x1b[0c", b"\x1b[?62;22c"),
                                (b"\x1b[>c", b"\x1b[>0;0;0c"),
                                (b"\x1b[>0c", b"\x1b[>0;0;0c"),
                            ];
                            if let Some((_, reply)) =
                                patterns.iter().find(|(query, _)| *query == queries)
                            {
                                if replies < 64 {
                                    let mut input = protocol_writer.lock().unwrap();
                                    let input = &mut *input;
                                    if input.backlog.is_empty() {
                                        let writer = &mut input.writer;
                                        let _ =
                                            writer.write_all(reply).and_then(|_| writer.flush());
                                    } else if input.backlog.len() + reply.len() <= BACKLOG_BYTES {
                                        input.backlog.extend_from_slice(reply); // W20-C: after the paste
                                    }
                                    // Codex look of wave 20 (MUST): a reply that would overfill the backlog is dropped
                                    // (a program that reads nothing cannot use it); the backlog never grows past its cap.
                                    replies += 1;
                                }
                                queries.clear();
                            } else if !patterns
                                .iter()
                                .any(|(query, _)| query.starts_with(&queries))
                            {
                                queries.clear();
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // The descriptor is non-blocking only to bound writes: sleep in poll(2) until output
                        // arrives (the 100 ms cap is a safety net), not for a fixed interval.
                        let mut p = libc::pollfd {
                            fd,
                            events: libc::POLLIN,
                            revents: 0,
                        };
                        unsafe { libc::poll(&mut p, 1, 100) };
                        if p.revents & (libc::POLLERR | libc::POLLNVAL | libc::POLLHUP) != 0 {
                            thread::sleep(std::time::Duration::from_millis(10));
                        }
                        continue;
                    }
                    Err(_) => break,
                }
            }
            let mut ring = reading.lock().unwrap_or_else(|e| e.into_inner());
            ring.ended = true;
            on_output(&[], paste_mode);
        });
        Ok(Self {
            ring,
            // portable-pty's Unix spawn calls setsid(), giving this child its own process group.
            pgid: pid as i32,
            stopped: false,
            exit: None,
            master: pair.master,
            writer,
            child,
            pid,
        })
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    /// V2-5b
    pub fn exit_code(&self) -> Option<i32> {
        self.exit
    }
    /// Ticket 433: the agent is stopped (SIGSTOP, a job-control stop or a tracer), not ended; `alive` reads it alive.
    pub fn suspended(&self) -> bool {
        !self.stopped
            && matches!(
                reported(self.pid),
                Ok(Some(libc::CLD_STOPPED | libc::CLD_TRAPPED))
            )
    }
    /// V2-1b: the output a reattaching core starts from.
    pub fn ring(&self) -> Arc<Mutex<Ring>> {
        self.ring.clone()
    }
    pub fn alive(&mut self) -> Result<bool, String> {
        if self.stopped {
            return Ok(false);
        }
        match ended(self.pid) {
            Ok(false) => Ok(true),
            Ok(true) => {
                self.stop()?;
                Ok(false)
            }
            Err(e) => {
                if e.raw_os_error() == Some(libc::ECHILD) {
                    self.stopped = true;
                }
                Err(e.to_string())
            }
        }
    }
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() > INPUT_BYTES {
            return Err("terminal input exceeds 64 KiB".into());
        }
        // V2-1a r3: an exited agent is answered at once; stopping its group is left to `alive` and `stop`, so a write
        // stays within the core's request bound.
        if self.stopped || ended(self.pid).map_err(|e| e.to_string())? {
            return Err("session has exited".into());
        }
        let mut input = self.writer.lock().unwrap();
        if let Some(why) = &input.broken {
            return Err(format!("terminal input failed: {why}"));
        }
        // W20-C: a write behind a queued paste's rest joins it, in order; the background writer sends both. W20-G: one
        // that would overfill the backlog fails here, whole, so nothing the caller was told is sent is ever dropped.
        if !input.backlog.is_empty() {
            if input.backlog.len() + data.len() > BACKLOG_BYTES {
                return Err(format!(
                    "terminal input blocked behind a queued paste ({} bytes not yet read by the agent); 0 of {} bytes delivered; no retry queued",
                    input.backlog.len(),
                    data.len()
                ));
            }
            input.backlog.extend_from_slice(data);
            return Ok(());
        }
        let Input {
            writer, backlog, ..
        } = &mut *input;
        // A write goes within 100 ms or fails: the core waits for it and must not stall behind a program that reads
        // nothing (`stalled_terminal_input_does_not_freeze_snapshot_or_stop`). One case gets 1.5 s, still inside the
        // core's 2 s request bound (`QUICK_WAIT`): a bracketed paste longer than the terminal's input queue (1024
        // bytes on macOS). It needs the agent to read in between, the agent asked for pastes so it does read, and an
        // agent busy drawing (Claude right after its start) took longer than 100 ms: ticket 991 C1, a 2.7 KB brief
        // stopped after 1024 bytes and was never sent. W20-C: on a loaded host even 1.5 s was too short (a 3.7 KB
        // brief left half-written), so a paste's rest past its bound goes to the background writer, never dropped
        // half-way by the bound.
        let paste = data.len() > QUEUE_BYTES && data.starts_with(b"\x1b[200~");
        let bound = if paste { 1500 } else { 100 };
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(bound);
        let mut sent = 0;
        while sent < data.len() {
            match writer.write(&data[sent..]) {
                Ok(0) => return Err(format!("terminal closed after {sent} bytes")),
                Ok(n) => sent += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        if paste {
                            backlog.extend_from_slice(&data[sent..]);
                            let (input, ring, pid) =
                                (self.writer.clone(), self.ring.clone(), self.pid);
                            thread::spawn(move || send_backlog(input, ring, pid));
                            return Ok(());
                        }
                        return Err(format!(
                            "terminal input blocked; {sent} of {} bytes delivered; no retry queued",
                            data.len()
                        ));
                    }
                    thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(e) => return Err(format!("terminal input failed after {sent} bytes: {e}")),
            }
        }
        writer.flush().map_err(|e| e.to_string())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 || cols > 500 || rows > 300 {
            return Err("invalid terminal dimensions".into());
        }
        self.master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        self.stop_judging(group_has_no_live_members)
    }
    /// v1a-14: `no_live_members` is the seam a test uses to see a member still exiting.
    fn stop_judging(&mut self, mut no_live_members: impl FnMut(i32) -> bool) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        let leader_live = match ended(self.pid) {
            Ok(exited) => !exited,
            Err(e) if e.raw_os_error() == Some(libc::ECHILD) => {
                self.stopped = true;
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        };
        // A reaped PID can be reused. Traverse it only while it remains our unreaped child.
        let mut owned = vec![];
        if leader_live {
            owned.push(self.pid);
            match crate::process::command("/bin/ps")
                .args(["-A", "-o", "pid=,ppid="])
                .output()
            {
                Ok(ps) if ps.status.success() => {
                    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&ps.stdout)
                        .lines()
                        .filter_map(|line| {
                            let mut words = line.split_whitespace();
                            Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
                        })
                        .collect();
                    let mut i = 0;
                    while i < owned.len() {
                        let parent = owned[i];
                        owned.extend(pairs.iter().filter(|(_, p)| *p == parent).map(|(p, _)| *p));
                        i += 1;
                    }
                }
                _ => eprintln!(
                    "process inspection failed; stopping owned PTY group {}",
                    self.pgid
                ),
            }
        }
        for pid in &owned {
            unsafe {
                libc::kill(*pid as i32, libc::SIGSTOP);
            }
        }
        // The PTY group also owns helpers reparented after its leader exits, even if ps fails.
        let group_error = (unsafe { libc::killpg(self.pgid, libc::SIGKILL) } == -1)
            .then(std::io::Error::last_os_error)
            .filter(|error| error.raw_os_error() != Some(libc::ESRCH));
        for pid in owned.iter().rev() {
            unsafe {
                libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
        self.stopped = true;
        match self.child.wait() {
            Ok(status) if !leader_live => self.exit = Some(status.exit_code() as i32),
            Ok(_) => {}
            Err(e) if e.raw_os_error() == Some(libc::ECHILD) => {}
            Err(e) => return Err(e.to_string()),
        }
        // v1a-14: judge EPERM only after every member got SIGKILL and the leader is reaped; members still
        // exiting keep Darwin answering EPERM for a moment, so look again for up to a second.
        let pgid = self.pgid;
        match group_error {
            Some(error)
                if error.raw_os_error() != Some(libc::EPERM)
                    || !group_settles(
                        || no_live_members(pgid),
                        std::time::Duration::from_secs(1),
                    ) =>
            {
                Err(error.to_string())
            }
            _ => Ok(()),
        }
    }
}
/// W20-C: the background writer. Sends `backlog` as the agent reads, holding the lock only for each try so the
/// reader's CPR answers and later writes queue behind it, and the core never waits on it. W20-G: no time limit; it
/// ends when the backlog is sent, or discards it only when the agent ended (nothing could read it any more). A write
/// error is retried like a full queue: dropping acknowledged bytes while the agent lives is the one thing it never does.
fn send_backlog(input: Arc<Mutex<Input>>, ring: Arc<Mutex<Ring>>, pid: u32) {
    /// About a second of hard failures (5 ms apart) before the channel counts as broken.
    const HARD_FAILURES: u32 = 200;
    let mut failures = 0;
    loop {
        thread::sleep(std::time::Duration::from_millis(5));
        // The ring before the input, never both: the reader takes them one at a time.
        let gone =
            ring.lock().unwrap_or_else(|e| e.into_inner()).ended || ended(pid).unwrap_or(true);
        let mut input = input.lock().unwrap_or_else(|e| e.into_inner());
        let Input {
            writer,
            backlog,
            broken,
        } = &mut *input;
        if gone {
            backlog.clear();
        } else {
            match writer.write(backlog) {
                Ok(n) if n > 0 => {
                    backlog.drain(..n);
                    failures = 0;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                // Codex look of wave 20 (NOTE): a channel that keeps failing (an error, or a write of nothing) for about
                // a second is broken: the backlog is discarded, logged, and every later write reports it.
                other => {
                    failures += 1;
                    if failures >= HARD_FAILURES {
                        let why = match other {
                            Err(e) => e.to_string(),
                            _ => "the terminal took no bytes".into(),
                        };
                        eprintln!(
                            "holder: terminal input broken, {} queued bytes discarded: {why}",
                            backlog.len()
                        );
                        backlog.clear();
                        *broken = Some(why);
                    }
                }
            }
        }
        if backlog.is_empty() {
            let _ = writer.flush();
            return;
        }
    }
}
// Ticket 433: Darwin's waitid reports a stopped child under WEXITED alone, so `process::exited` reads a stopped agent
// as ended; here only an exit, a kill or a core dump ends it. WNOWAIT keeps the leader reserved, as `exited` does.
fn ended(pid: u32) -> std::io::Result<bool> {
    Ok(reported(pid)?
        .is_some_and(|code| [libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED].contains(&code)))
}
fn reported(pid: u32) -> std::io::Result<Option<i32>> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let flags = libc::WEXITED | libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT;
        if unsafe { libc::waitid(libc::P_PID, pid, &mut info, flags) } == 0 {
            return Ok((unsafe { info.si_pid() } != 0).then_some(info.si_code));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
// v1a-14: read-only looks, never another killpg: once the group empties its id may be reused.
fn group_settles(mut no_live_members: impl FnMut() -> bool, wait: std::time::Duration) -> bool {
    let until = std::time::Instant::now() + wait;
    loop {
        if no_live_members() {
            return true;
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
}
fn group_has_no_live_members(pgid: i32) -> bool {
    // Darwin returns EPERM for a group containing only its unreaped zombie leader.
    let mut ps = crate::process::command("/bin/ps");
    ps.args(["-A", "-o", "pgid=,stat="]);
    let Ok(output) = crate::process::output(ps, std::time::Duration::from_secs(1)) else {
        return false;
    };
    output.status.success()
        && !String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            let mut words = line.split_whitespace();
            words.next().and_then(|word| word.parse::<i32>().ok()) == Some(pgid)
                && words.next().is_none_or(|state| !state.starts_with('Z'))
        })
}

impl Drop for Local {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::RawFd;
    use std::os::unix::process::CommandExt;
    fn quiet() -> OnOutput {
        Box::new(|_, _| {})
    }
    // v1a-27 r2: a child the holder starts later must not inherit a session's PTY master, or it could type into
    // that session. Every descriptor of this process on the same master (portable-pty's own, the reader's, the
    // writer's and the reader thread's wait dup) is close-on-exec.
    #[test]
    fn no_descriptor_of_a_session_master_survives_exec() {
        let pty = Local::spawn(CommandBuilder::new("/bin/cat"), &[], quiet()).unwrap();
        let identity = |fd: RawFd| {
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            (unsafe { libc::fstat(fd, &mut st) } == 0).then_some((st.st_dev, st.st_ino, st.st_rdev))
        };
        let master = identity(pty.master.as_raw_fd().unwrap()).unwrap();
        let mut found = 0;
        for fd in 0..4096 {
            if identity(fd) == Some(master) {
                found += 1;
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                assert!(
                    flags & libc::FD_CLOEXEC != 0,
                    "fd {fd} on the master is inherited by exec"
                );
            }
        }
        assert!(
            found >= 2,
            "expected the master and the reader's dup, found {found}"
        );
    }
    // v1a-27 S2: a failing fd step leaves no child behind. A child would die of the master's hangup before it
    // could leave a trace, so the test counts children started on this thread instead.
    #[test]
    fn a_failed_dup_starts_no_child() {
        FAIL_DUP.set(true);
        let before = SPAWNED.get();
        let result = Local::spawn(CommandBuilder::new("/bin/sleep"), &[], quiet());
        FAIL_DUP.set(false);
        assert!(result.is_err());
        assert_eq!(
            SPAWNED.get(),
            before,
            "a child was started before the failing step"
        );
    }
    #[test]
    fn close_stop_and_drop_after_exit_never_signal_a_reused_group() {
        for drop_only in [false, true] {
            let mut pty = Local::spawn(CommandBuilder::new("/usr/bin/true"), &[], quiet()).unwrap();
            let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while pty.alive().unwrap() {
                assert!(std::time::Instant::now() < until);
                thread::sleep(std::time::Duration::from_millis(10));
            }
            // Model PID reuse with another group owned by this test, never an external victim.
            let mut other = std::process::Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap();
            pty.pgid = other.id() as i32;
            if !drop_only {
                pty.stop().unwrap();
                pty.stop().unwrap();
            }
            drop(pty);
            thread::sleep(std::time::Duration::from_millis(30));
            let signalled = other.try_wait().unwrap().is_some();
            let _ = other.kill();
            let _ = other.wait();
            assert!(
                !signalled,
                "Exited cleanup signalled a reused group (drop_only={drop_only})"
            );
        }
    }
    /// A program that prints READY in raw mode, then runs `then`; the output it draws is collected.
    fn raw(then: &str) -> (Local, Arc<Mutex<Vec<u8>>>) {
        let out = Arc::new(Mutex::new(vec![]));
        let seen = out.clone();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", &format!("stty raw -echo; printf READY; {then}")]);
        let pty = Local::spawn(
            command,
            &[],
            Box::new(move |bytes, _| seen.lock().unwrap().extend_from_slice(bytes)),
        )
        .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !out.lock().unwrap().windows(5).any(|w| w == b"READY") {
            assert!(std::time::Instant::now() < until, "never ready");
            thread::sleep(std::time::Duration::from_millis(5));
        }
        (pty, out)
    }
    // Ticket 995 (v12-C-V10): the first output carries the PTY's size, after the seed, in the ring and in the stream.
    // (Drop stops both agents.)
    #[test]
    fn the_first_output_starts_with_the_size_mark() {
        let (pty, out) = raw("exec sleep 30");
        assert_eq!(*out.lock().unwrap(), b"\x1b[8;50;160tREADY");
        assert_eq!(
            pty.ring.lock().unwrap().replay.parts().0,
            b"\x1b[8;50;160tREADY"
        );
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf X; exec sleep 30"]);
        let seeded = Local::spawn(command, b"seed|", quiet()).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !seeded.ring.lock().unwrap().replay.parts().0.ends_with(b"X") {
            assert!(std::time::Instant::now() < until, "no output");
            thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            seeded.ring.lock().unwrap().replay.parts().0,
            b"seed|\x1b[8;50;160tX"
        );
    }
    // Lane w71: a resize while the program's escape sequence is still open. The mark's ESC ended an open OSC 52 in
    // xterm.js, which then ran the cut-off write (a 1.4 MB write over the cap was accepted as its first 66,816 bytes).
    #[test]
    fn a_size_mark_never_lands_inside_an_open_escape_sequence() {
        let (mut pty, out) = raw(
            "printf '\\033]52;c;AAAA'; dd bs=1 count=1 >/dev/null 2>&1; printf 'BBBB\\007done'; exec sleep 30",
        );
        let wait = |end: &[u8]| {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !out.lock().unwrap().ends_with(end) {
                assert!(std::time::Instant::now() < until, "no {end:?}");
                thread::sleep(std::time::Duration::from_millis(5));
            }
        };
        wait(b"AAAA");
        pty.resize(100, 40).unwrap();
        pty.write(b"x").unwrap();
        wait(b"done");
        assert_eq!(
            String::from_utf8_lossy(&out.lock().unwrap()),
            "\x1b[8;50;160tREADY\x1b]52;c;AAAABBBB\x07\x1b[8;40;100tdone"
        );
    }
    // Where each stream is back at ground, by the same walk the reader does (a mark may go before that byte).
    #[test]
    fn ground_is_found_only_after_a_sequence_ends() {
        let ground = |bytes: &[u8]| {
            let (mut seq, mut before) = (Seq::Ground, 0);
            let mut at = vec![];
            for (i, byte) in bytes.iter().enumerate() {
                if seq == Seq::Ground && !(0x80..=0xbf).contains(byte) {
                    at.push(i);
                }
                seq = seq.after(before, *byte);
                before = *byte;
            }
            at
        };
        assert_eq!(ground(b"a\x1b[38;5;196mb"), [0, 1, 12]);
        assert_eq!(ground(b"\x1b]52;c;AA\x07b"), [0, 10]);
        assert_eq!(ground(b"\x1b]0;t\x1b\\b"), [0, 7]); // ST
        assert_eq!(ground(b"\x1b]0;t\x1b[0mb"), [0, 9]); // an ESC that is not ST starts the next sequence
        assert_eq!(ground(b"\x1bPq\x07#\x1b\\b"), [0, 7]); // BEL does not end a DCS
        assert_eq!(ground(b"\x1b_G\x18b\x1b(Bc"), [0, 4, 5, 8]); // CAN; ESC ( B
        assert_eq!(ground("\u{9d}52;c;AA\u{9c}b".as_bytes()), [0, 11]); // C1 OSC and ST
        assert_eq!(ground("\u{9b}0mb".as_bytes()), [0, 4]); // C1 CSI
        assert_eq!(ground("a\u{d55c}b".as_bytes()), [0, 1, 4]); // never inside a character
    }
    fn paste(len: usize) -> Vec<u8> {
        let text: Vec<u8> = (0..len).map(|i| b'a' + (i % 26) as u8).collect();
        [b"\x1b[200~", &text[..], b"\x1b[201~"].concat()
    }
    // W20-C: a long paste to an agent that reads late (a loaded host) is never left half-written: past its 1.5 s
    // bound the rest goes to the background writer and the write succeeds; a later key waits behind it, in order.
    #[test]
    fn a_long_paste_to_a_late_reader_arrives_whole_with_later_input_after_it() {
        let (mut pty, out) = raw("sleep 3; exec cat");
        let paste = paste(4096);
        let asked = std::time::Instant::now();
        pty.write(&paste).unwrap();
        assert!(asked.elapsed() < std::time::Duration::from_secs(2));
        assert!(
            !pty.writer.lock().unwrap().backlog.is_empty(),
            "the rest was not queued"
        );
        pty.write(b"AFTER").unwrap();
        let want = [&b"\x1b[8;50;160tREADY"[..], &paste, b"AFTER"].concat();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while out.lock().unwrap().len() < want.len() {
            assert!(std::time::Instant::now() < until, "the paste never arrived");
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(*out.lock().unwrap() == want, "bytes lost or out of order");
        pty.stop().unwrap();
    }
    // W20-G: a queued paste to an agent that reads nothing is never dropped while the agent lives; a write that
    // would overfill the backlog fails at once, whole; only the agent's end discards the backlog.
    #[test]
    fn a_queued_paste_to_a_program_that_reads_nothing_stays_queued_and_an_overfill_fails_at_once() {
        let (mut pty, _out) = raw("exec sleep 30");
        pty.write(&paste(4096)).unwrap();
        pty.write(&vec![b'y'; INPUT_BYTES]).unwrap();
        thread::sleep(std::time::Duration::from_secs(1));
        let queued = pty.writer.lock().unwrap().backlog.clone();
        assert!(queued.len() > INPUT_BYTES, "the paste's rest was dropped");
        assert!(
            queued.ends_with(&vec![b'y'; INPUT_BYTES]),
            "a later write was dropped"
        );
        let asked = std::time::Instant::now();
        let error = pty.write(&vec![b'z'; INPUT_BYTES]).unwrap_err();
        assert!(asked.elapsed() < std::time::Duration::from_millis(100));
        assert!(
            error.starts_with("terminal input blocked behind a queued paste"),
            "{error}"
        );
        assert!(
            pty.writer.lock().unwrap().backlog == queued,
            "the refused write was queued or the backlog dropped"
        );
        pty.stop().unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !pty.writer.lock().unwrap().backlog.is_empty() {
            assert!(
                std::time::Instant::now() < until,
                "never discarded after the agent ended"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    // V2-1a r3: a write after the agent exited is answered at once, without the group stop (which may wait out
    // members still exiting), so it stays within the core's 2 s request bound.
    #[test]
    fn a_write_after_exit_answers_at_once() {
        let mut pty = Local::spawn(CommandBuilder::new("/usr/bin/true"), &[], quiet()).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !crate::process::exited(pty.pid).unwrap() {
            assert!(std::time::Instant::now() < until);
            thread::sleep(std::time::Duration::from_millis(5));
        }
        let asked = std::time::Instant::now();
        assert_eq!(pty.write(b"x").unwrap_err(), "session has exited");
        assert!(asked.elapsed() < std::time::Duration::from_millis(100));
        assert!(!pty.stopped, "the stop is left to alive and stop");
        assert!(!pty.alive().unwrap());
    }
    // v1a-14
    #[test]
    fn eperm_waits_for_members_that_are_still_exiting_but_not_for_live_ones() {
        let wait = std::time::Duration::from_secs(1);
        let mut looks = 0;
        assert!(group_settles(
            || {
                looks += 1;
                looks > 3
            },
            wait
        ));
        // v1a-17: counted rather than timed. Looks are at least 20 ms apart, so a 100 ms wait allows at most six;
        // a seventh means it kept looking at a live member.
        let mut looks = 0;
        assert!(!group_settles(
            || {
                looks += 1;
                assert!(looks <= 6, "kept looking at a live member");
                false
            },
            std::time::Duration::from_millis(100)
        ));
    }
    // v1a-14
    #[test]
    fn stop_waits_out_a_member_still_exiting_after_its_leader_died() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "/bin/sleep 30 & exit 0"]);
        let mut pty = Local::spawn(command, &[], quiet()).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !crate::process::exited(pty.pid).unwrap() {
            assert!(std::time::Instant::now() < until);
            thread::sleep(std::time::Duration::from_millis(5));
        }
        // v1a-20: the leader's exit hangs up the terminal, so `sleep` dies of SIGHUP a moment later; until it has,
        // killpg still finds it and returns 0. Wait for the group to hold only the unreaped zombie leader, which
        // Darwin answers with EPERM.
        while !group_has_no_live_members(pty.pgid) {
            assert!(std::time::Instant::now() < until);
            thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(unsafe { libc::killpg(pty.pgid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        );
        let pgid = pty.pgid;
        let mut looks = 0;
        // The first looks see the member still exiting, as a loaded host does.
        let stopped = pty.stop_judging(|pgid| {
            looks += 1;
            looks > 2 && group_has_no_live_members(pgid)
        });
        assert_eq!(stopped, Ok(()));
        assert!(looks > 2);
        assert!(group_has_no_live_members(pgid));
    }
}
