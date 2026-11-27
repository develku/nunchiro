//! Loopback WebSocket API for the window (spec Local API; ADR Review amendments, WebSocket auth).
// Handshake gates and frame pump adapted from Zeron crates/rpc/src/server.rs and ws.rs, commit 4231cb7.
// MIT License
//
// Copyright (c) 2026 Wing
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Protocol: one WebSocket at `/ws`. The browser cannot set headers on a WebSocket, so the token rides
// in `Sec-WebSocket-Protocol: nunchiro.v1, nunchiro.token.<token>` (a header, never the URL). Client
// text frames are `{"id":n,"request":<api::Request>}`, `{"id":n,"watch":"<session>","after":byte}`
// or `{"id":n,"unwatch":"<session>"}`; replies are `{"id":n,"response":{"Ok"|"Err":..}}`. The core
// pushes `{"event":"snapshot","sessions":[..]}` on connect and on change, and terminal output as
// binary frames: 4-byte big-endian header length, header JSON `{session,start,end,truncated,replay}`, bytes.
// v1a-07b: the core also pushes `{"event":"layout","layout":..,"error":..}` on connect and when layout.toml
// changes, and `{"event":"layout_command","seq":n,"args":[..],"file":{..}}` for `nunchiro layout`; the window sends
// `{"id":n,"layout_save":{..}}`, answers commands with `{"id":n,"layout_done":seq,"text"|"error":..}` and
// marks itself as the window CLI commands go to with `{"id":n,"layout_focus":true}`; a side socket (the chat feed)
// leaves the window list with `{"id":n,"layout_feed":true}`.
// v1a-53: the window acks the output it parsed with `{"ack":"<session>","bytes":n}` (cumulative data bytes since its
// last watch of that session, no reply); from its first valid ack the core paces that window (`Pace`, `UNACKED_MAX`).
// A refused ack for a watched session gets `{"event":"ack_refused","session":..}` once per watch; the window then
// watches it afresh from its cursor, so both sides count from that watch's replay again.
pub mod browser; // V2.5-15
pub(crate) mod layout;
mod pair; // V2.5-15
mod remote_tab; // Q10
mod widget_kinds; // v1b-28
pub use widget_kinds::WIDGET_KINDS;
// Ticket 1162: two parts with their own job moved out; each child says its own in one `//!` line.
mod answer;
mod jobs;
use answer::answer;
use jobs::*;

use crate::{api::*, sessions::Sessions, store};
use serde::Deserialize;
use std::os::fd::AsRawFd;
use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request as Handshake, Response as Accepted},
    http::{HeaderValue, StatusCode},
    protocol::WebSocketConfig,
};

const PROTOCOL: &str = "nunchiro.v1";
const TOKEN_PREFIX: &str = "nunchiro.token.";
/// The packaged Tauri webview's origins on macOS (and the form newer WebKit builds report).
const DEFAULT_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];
/// Authenticated windows. Handshakes in flight have their own cap and a total deadline, so slow or
/// idle sockets (any local process can open one) cannot hold the owner's slots.
const MAX_CONNECTIONS: usize = 8;
const MAX_HANDSHAKES: usize = 16;
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(3);
// v1a-13: a socket that sends nothing at all is gone after this, well before the total deadline.
const FIRST_BYTES: Duration = Duration::from_millis(500);
// v1a-13: each eviction costs a reopening attacker at least this long, so a refill loop cannot evict the
// owner's socket before its handshake thread has read the request.
const EVICT_PAUSE: Duration = Duration::from_millis(1);
/// A window that stops reading is dropped after this, freeing its slot.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_WATCHES: usize = 64;
const MAX_MESSAGE: usize = 1 << 20;
/// The read timeout of a window loop without a wake pipe, which must poll for output.
const POLL: Duration = Duration::from_millis(8);
/// `NUNCHIRO_WINDOW_TICK_MS`: a fixed idle wait. A test makes it far longer than any echo it waits for, so a return to
/// fixed-interval polling shows up as a timeout, not as a slow host.
fn tick_override() -> Option<Duration> {
    static TICK: std::sync::OnceLock<Option<Duration>> = std::sync::OnceLock::new();
    *TICK.get_or_init(|| {
        std::env::var("NUNCHIRO_WINDOW_TICK_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(|ms: u64| Duration::from_millis(ms.clamp(1, i32::MAX as u64)))
    })
}
fn tick() -> Duration {
    tick_override().unwrap_or(POLL)
}
// v1a-27: test counters are per core home; concurrent fixture windows must not share measurements.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct OutputCounts {
    locks: std::sync::atomic::AtomicU64,
    pub(crate) passes: std::sync::atomic::AtomicU64,
}
#[cfg(test)]
pub(crate) fn output_counts(home: &Path) -> Arc<OutputCounts> {
    use std::{path::PathBuf, sync::OnceLock};
    static COUNTS: OnceLock<Mutex<BTreeMap<PathBuf, Arc<OutputCounts>>>> = OnceLock::new();
    COUNTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .entry(home.into())
        .or_default()
        .clone()
}
/// v1a-27: after a wake the loop ignores further wakes this long, so a flooding session costs each window at most
/// one output pass per interval; output that arrives meanwhile goes out in one frame.
const BATCH: Duration = Duration::from_millis(2);
/// The accept loop's longest wait; a connection ends it at once.
const ACCEPT_WAIT: Duration = Duration::from_millis(250);
const SNAPSHOT_EVERY: Duration = Duration::from_millis(100);
/// How often each window's loop looks at layout.toml for hand edits and other windows' saves.
const LAYOUT_EVERY: Duration = Duration::from_millis(250);
/// v1a-53: output bytes a window may have sent and not acked as parsed, per watched session, whatever the rest of the
/// window has unacked: a quiet session (an echo) is never held behind a busy one. Tuned on stream-8 WebKit
/// (docs/v1/figures.md, V1A-53): worst frame 137-215 ms at 4 MiB per session, 101-148 at 2, 48-86 at 1.
const UNACKED_MAX: u64 = 1 << 20;
/// v1a-53 r2: past `UNACKED_MAX`, a session may still send while the whole window has less than this unacked, so a
/// single busy session buffers its burst in the window instead of skipping it (coordinator, 2026-10-26: a window that
/// keeps up does not skip). Tuned on WebKit (docs/v1/figures.md, V1A-53 round 2): at 8 MiB stream-1 still skipped
/// (15.3-18.6 of 20 MiB), at 16 and 32 it received all 20; stream-8 stalled at 32 in 5 of 6 repeats, at 16 in 1 of 12. Past both the session is held for that window; one that falls further behind than the replay
/// resumes at its newest bytes (`Pace`). Pacing buffers nothing in the core: output is read from the session's replay
/// when it goes, so a window costs one `Pace` (24 bytes) per watch, at most `MAX_WATCHES`.
const UNACKED_TOTAL: u64 = 16 << 20;
/// `UNACKED_TOTAL`, or `NUNCHIRO_WINDOW_UNACKED_MIB` (1-1024): lets a test keep its streams short, since debug cores
/// move output slowly, as `NUNCHIRO_WINDOW_TICK_MS` does for the tick.
fn unacked_total() -> u64 {
    static TOTAL: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *TOTAL.get_or_init(|| {
        std::env::var("NUNCHIRO_WINDOW_UNACKED_MIB")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(UNACKED_TOTAL, |mib: u64| mib.clamp(1, 1024) << 20)
    })
}
// A skip sends the newest replay whole, so a session's own room must be able to hold it.
const _: () =
    assert!(UNACKED_MAX >= crate::pty::REPLAY_BYTES as u64 && UNACKED_TOTAL >= UNACKED_MAX);

/// v1a-53: one watched session's output on one window: data bytes sent since the watch, and the most the window acked
/// as parsed (`{"ack":session,"bytes":n}`). Only a connection that sent a valid ack is paced: a window that never acks
/// (an older build) gets output as before, bounded by the replay, which it skips to the newest of when it falls behind.
/// `free` below is what the window has left of `UNACKED_TOTAL`, or `None` when it is not paced.
#[derive(Default, Clone, Copy)]
struct Pace {
    sent: u64,
    acked: u64,
    /// The window was told once that it acked wrong (`ack_refused`), so it can watch afresh.
    told: bool,
}
impl Pace {
    /// Takes a cumulative ack; one lower than the last or past what was sent is refused and changes nothing.
    fn ack(&mut self, bytes: u64) -> bool {
        let ok = (self.acked..=self.sent).contains(&bytes);
        if ok {
            self.acked = bytes;
        }
        ok
    }
    fn sent(&mut self, bytes: u64) {
        self.sent += bytes;
    }
    fn unacked(&self) -> u64 {
        self.sent - self.acked
    }
    fn room(&self, free: Option<u64>) -> u64 {
        free.map_or(u64::MAX, |free| {
            UNACKED_MAX.saturating_sub(self.unacked()).max(free)
        })
    }
    /// Nothing to read now, known before the read from the bytes `pending` past the cursor: no room, or the window
    /// is further behind than the replay keeps and the room cannot take the newest replay whole.
    fn held(&self, free: Option<u64>, pending: u64) -> bool {
        let room = self.room(free);
        room == 0
            || (pending > crate::pty::REPLAY_BYTES as u64 && room < crate::pty::REPLAY_BYTES as u64)
    }
    /// How many of `len` read bytes go now; `None` holds them. A skip (`truncated`) goes whole or not at all, so the
    /// window jumps to the newest bytes, never to a part of the replay that is already old.
    fn take(&self, free: Option<u64>, len: usize, truncated: bool) -> Option<usize> {
        let room = usize::try_from(self.room(free)).unwrap_or(usize::MAX);
        if (truncated && room < len) || (room == 0 && len > 0) {
            None
        } else {
            Some(len.min(room))
        }
    }
}

/// Binds 127.0.0.1 on an ephemeral port and writes `window.json` (the port only, 0600; v1a-13). Returns
/// the port and a fresh token, which the owner socket hands out through `window_auth`.
pub(crate) fn spawn(
    home: &Path,
    sessions: Arc<Mutex<Sessions>>,
    stopping: Arc<AtomicBool>,
) -> Result<(u16, String), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = (store::new_id()? + &store::new_id()?).replace('-', "");
    crate::logs::register(&token, "window"); // v2-13a
    // v1a-13: no token on disk; this also replaces an older window.json that carried one.
    store::atomic_write(
        &home.join("window.json"),
        serde_json::json!({ "port": port }).to_string().as_bytes(),
    )?;
    let origins = allowed_origins(std::env::var("NUNCHIRO_WINDOW_ORIGINS").ok().as_deref());
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let gate = Arc::new(Gate {
        token: token.clone(),
        origins,
        port,
        authed: AtomicUsize::new(0),
    });
    let mut handshakes = Pending::default(); // v1a-13: owned by the accept loop alone
    browser::start(home, sessions.clone(), stopping.clone()); // V2.5-15: binds nothing until turned on
    let home = home.to_path_buf();
    thread::spawn(move || {
        while !stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    // v1a-13: at the cap the new socket evicts a pending one instead of being dropped.
                    match handshakes.make_room() {
                        Ok(true) => thread::sleep(EVICT_PAUSE),
                        Ok(false) => {}
                        Err(()) => continue,
                    }
                    let Ok(read) = handshakes.add(&stream) else {
                        continue;
                    };
                    let (gate, sessions, stopping, home) = (
                        gate.clone(),
                        sessions.clone(),
                        stopping.clone(),
                        home.clone(),
                    );
                    thread::spawn(move || {
                        if let Err(e) =
                            connection(stream, &gate, &sessions, &stopping, &read, &home)
                        {
                            eprintln!("window connection ended: {e}");
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // V2.5-17: sleep until a connection arrives; the timeout only bounds how late `stopping` is seen.
                    let mut fd = libc::pollfd {
                        fd: listener.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let ready = unsafe { libc::poll(&mut fd, 1, ACCEPT_WAIT.as_millis() as i32) };
                    // A broken listener reports POLLERR/POLLNVAL at once, every time: back off instead of spinning.
                    if ready < 0 || fd.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                        thread::sleep(ACCEPT_WAIT);
                    }
                }
                Err(e) => {
                    eprintln!("window accept failed; retrying: {e}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
    Ok((port, token))
}

// v1a-13: handshakes in flight, oldest first. At the cap a newcomer evicts the oldest socket with nothing waiting
// to be read (idle, trickling, or closed); a socket whose request is in but not yet read is never evicted, and when
// every socket is like that the newcomer is dropped instead (their threads are about to read). A handshake leaves the
// list once its thread has read the whole request or ended; the flag is set without a lock.
#[derive(Default)]
struct Pending {
    list: std::collections::VecDeque<(Arc<AtomicBool>, TcpStream)>,
}
impl Pending {
    /// `Ok(false)`: room without eviction; `Ok(true)`: one socket evicted; `Err`: drop the newcomer.
    fn make_room(&mut self) -> Result<bool, ()> {
        self.list.retain(|(read, _)| !read.load(Ordering::SeqCst));
        if self.list.len() < MAX_HANDSHAKES {
            return Ok(false);
        }
        let silent = self.list.iter().position(|(_, s)| {
            let mut byte = 0u8;
            // Peek without touching the socket's blocking mode, which its handshake thread shares.
            let n = unsafe {
                libc::recv(
                    std::os::fd::AsRawFd::as_raw_fd(s),
                    (&mut byte as *mut u8).cast(),
                    1,
                    libc::MSG_PEEK | libc::MSG_DONTWAIT,
                )
            };
            n <= 0 // nothing waiting (or closed)
        });
        let (_, old) = self.list.remove(silent.ok_or(())?).ok_or(())?;
        let _ = old.shutdown(std::net::Shutdown::Both);
        Ok(true)
    }
    fn add(&mut self, stream: &TcpStream) -> Result<Arc<AtomicBool>, ()> {
        let clone = stream.try_clone().map_err(drop)?;
        let read = Arc::new(AtomicBool::new(false));
        self.list.push_back((read.clone(), clone));
        Ok(read)
    }
}

fn allowed_origins(extra: Option<&str>) -> Vec<String> {
    DEFAULT_ORIGINS
        .iter()
        .map(|s| s.to_string())
        .chain(
            extra
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                // `null` and other opaque origins can never be allowlisted.
                .filter(|o| !o.is_empty() && *o != "null" && o.contains("://"))
                .map(str::to_string),
        )
        .collect()
}

struct Gate {
    token: String,
    origins: Vec<String>,
    port: u16,
    authed: AtomicUsize,
}
impl Gate {
    /// Two independent gates, both required (Zeron's model, with its reject-any-Origin replaced by an
    /// allowlist because the window is a browser page): an exact allowlisted `Origin`, then the token.
    /// The presented token is never logged.
    #[allow(clippy::result_large_err)]
    fn check(&self, req: &Handshake, mut resp: Accepted) -> Result<Accepted, ErrorResponse> {
        let refuse = |status: StatusCode, why: &str| {
            let mut err = ErrorResponse::new(Some(why.to_string()));
            *err.status_mut() = status;
            err
        };
        let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok());
        // Host check stops DNS-rebinding pages that would otherwise pass as same-host.
        let host_ok = header("host").is_some_and(|h| {
            h == format!("127.0.0.1:{}", self.port) || h == format!("localhost:{}", self.port)
        });
        let origin_ok = header("origin").is_some_and(|o| self.origins.iter().any(|a| a == o));
        if !host_ok || !origin_ok || req.uri().path() != "/ws" {
            return Err(refuse(StatusCode::FORBIDDEN, "origin not allowed"));
        }
        let offered: Vec<&str> = header("sec-websocket-protocol")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .collect();
        let presented = offered.iter().find_map(|p| p.strip_prefix(TOKEN_PREFIX));
        if !offered.contains(&PROTOCOL)
            || !presented
                .is_some_and(|t| crate::server::token_equal(t.as_bytes(), self.token.as_bytes()))
        {
            return Err(refuse(StatusCode::UNAUTHORIZED, "missing or wrong token"));
        }
        // Take an authenticated slot only after both gates pass; `connection` releases it.
        if self
            .authed
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CONNECTIONS).then_some(n + 1)
            })
            .is_err()
        {
            return Err(refuse(StatusCode::SERVICE_UNAVAILABLE, "too many windows"));
        }
        resp.headers_mut()
            .insert("Sec-WebSocket-Protocol", HeaderValue::from_static(PROTOCOL));
        Ok(resp)
    }
}

// v1a-47: Browse online is a window op, not an `api::Request`: the owner socket and the CLI cannot send it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemeFrame {
    id: u64,
    request: crate::themes_online::Op,
}

// v2-7: Search's Sessions scope, window only like `ThemeFrame`.
#[derive(Deserialize)]
struct SearchFrame {
    id: u64,
    request: crate::chat::search::Op,
}

// V2.5-12: first-run import, window only like `SearchFrame`.
#[derive(Deserialize)]
struct ImportFrame {
    id: u64,
    request: crate::import::Op,
}

// v2-10c: the library cache's Allow, auto-allow and Remove, window only like `ThemeFrame` (the third human-only
// action in ADR Agent CLI authority).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LibsFrame {
    id: u64,
    request: crate::libs::Op,
}

// Owner 2026-11-16: teammates, window only like `LibsFrame`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TeamFrame {
    id: u64,
    request: crate::team::Op,
}

// v1a-38b: scrollback to $EDITOR, window only like `ThemeFrame`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditFrame {
    id: u64,
    request: crate::scrollback_edit::Op,
}

/// Off-loop window work per connection (v1a-38b, carried from the v1a-47 review): at most `MAX_JOBS` running or
/// holding an unsent reply, checked before any thread starts, so a frame flood cannot start threads without bound.
const MAX_JOBS: usize = 4;
/// Ticket 459: requests that run an agent's status or `--version` command (up to two 5 s runs, 15 s for a joined
/// "Your own" check) take places of their own, so a slow probe never refuses a fast read. Measured 11-22: the window's
/// connect burst holds 4 jobs at once (one an account list of ~2.4 s); Providers opening sends 4 probes at once.
const MAX_PROBE_JOBS: usize = 6;

#[derive(Deserialize)]
struct Frame {
    id: u64,
    request: Option<Request>,
    watch: Option<String>,
    #[serde(default)]
    after: u64,
    unwatch: Option<String>,
    layout_save: Option<serde_json::Value>,
    layout_done: Option<u64>,
    #[serde(default)]
    layout_focus: bool,
    /// V2.5-17: this socket is a side channel (the chat feed), not a window CLI layout commands go to.
    #[serde(default)]
    layout_feed: bool,
    #[serde(default)]
    text: String,
    error: Option<String>,
}

/// ticket 113: the user-commands read as a job; `read` is a parameter so a test can hold it.
fn dispatch_user_commands(
    jobs: &mut Jobs,
    id: u64,
    kind: AgentKind,
    read: impl FnOnce(AgentKind) -> Response + Send + 'static,
) -> Option<serde_json::Value> {
    jobs.spawn(id, move || read(kind))
}

/// CHAT-USAGE: the read runs on a job, including registry resolution and account-folder checks.
fn dispatch_session_context(
    jobs: &mut Jobs,
    id: u64,
    read: impl FnOnce() -> Response + Send + 'static,
) -> Option<serde_json::Value> {
    jobs.spawn(id, read)
}

// tungstenite's handshake callback fixes the large `ErrorResponse` error type; it cannot be boxed.
#[allow(clippy::result_large_err)]
fn connection(
    stream: TcpStream,
    gate: &Arc<Gate>,
    registry: &Arc<Mutex<Sessions>>, // v2-7: search jobs hold a clone
    stopping: &Arc<AtomicBool>,
    read: &AtomicBool, // v1a-13: leaves the pending list
    home: &Path,
) -> Result<(), String> {
    let slot = std::cell::Cell::new(false);
    let done = || read.store(true, Ordering::SeqCst);
    // v1a-13: the pending list holds a clone of this socket until the next accept, so close it explicitly.
    let closer = stream.try_clone();
    let check = |q: &Handshake, r| {
        let ok = gate.check(q, r);
        slot.set(ok.is_ok());
        ok
    };
    let result = handshake(stream, &check, &done);
    done();
    // Ticket 421 round 2: the authenticated place goes when this connection and its last job thread have ended.
    let lease = Lease::new({
        let (gate, taken) = (gate.clone(), slot.get());
        move || {
            if taken {
                gate.authed.fetch_sub(1, Ordering::SeqCst);
            }
        }
    });
    let served = result.and_then(|ws| serve(ws, registry, stopping, home, None, lease));
    if let Ok(closer) = closer {
        let _ = closer.shutdown(std::net::Shutdown::Both);
    }
    served
}

/// A stream whose reads share one deadline, so trickling a byte at a time cannot extend the handshake.
struct Deadline {
    stream: TcpStream,
    until: Option<Instant>,
    first: Option<Instant>, // v1a-13: FIRST_BYTES deadline until the first byte arrives
    wake: Option<crate::pty::Wake>, // set once authenticated: an idle read also ends on PTY output
    quiet: Option<Instant>, // v1a-27: set by a wake; until then an idle read ignores the wake
    // S9: the loop's next timed check (snapshot, resync, layout); an idle read with a wake pipe waits until then.
    due: Instant,
}
impl std::io::Read for Deadline {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if let Some(until) = self.until {
            let until = self.first.map_or(until, |first| first.min(until)); // v1a-13
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            self.stream.set_read_timeout(Some(left))?;
        } else if let Some(wake) = &self.wake {
            // tungstenite reads only when it has no complete frame buffered: this is the idle wait. Return to the
            // loop when output arrives or the tick passes; sleep only until the socket has bytes otherwise.
            let mut fds = [
                libc::pollfd {
                    fd: self.stream.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake.fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // v1a-27: within `BATCH` of a wake, wait on the socket alone first; output that arrives meanwhile
            // stays in the wake pipe and goes out with the next pass, so any flood costs each loop one pass per
            // `BATCH`.
            let left = (self.quiet.take()).map_or(Duration::ZERO, |q| {
                q.saturating_duration_since(Instant::now())
            });
            if !left.is_zero() {
                unsafe { libc::poll(fds.as_mut_ptr(), 1, left.as_micros().div_ceil(1000) as i32) };
            }
            if fds[0].revents == 0 {
                // S9: no fixed tick: output, a layout command or a job reply wakes the loop (`pty::wake_windows`).
                let idle = tick_override()
                    .unwrap_or_else(|| self.due.saturating_duration_since(Instant::now()));
                unsafe { libc::poll(fds.as_mut_ptr(), 2, idle.as_micros().div_ceil(1000) as i32) };
                if fds[0].revents == 0 {
                    wake.drain(); // only now: output that arrived beside a frame must still wake the next idle wait
                    if fds[1].revents != 0 {
                        self.quiet = Some(Instant::now() + BATCH);
                    }
                    return Err(std::io::ErrorKind::WouldBlock.into());
                }
            }
        }
        let n = self.stream.read(buf)?;
        if n > 0 {
            self.first = None; // v1a-13
        }
        Ok(n)
    }
}
impl std::io::Write for Deadline {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stream.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

#[allow(clippy::result_large_err)]
fn handshake(
    stream: TcpStream,
    check: &dyn Fn(&Handshake, Accepted) -> Result<Accepted, ErrorResponse>, // V2.5-15: window or browser gate
    read: &dyn Fn(), // v1a-13: the request is in; the socket can no longer be evicted
) -> Result<tungstenite::WebSocket<Deadline>, String> {
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(WRITE_TIMEOUT))
        .map_err(|e| e.to_string())?;
    // Keystrokes and their echoes are tiny frames: Nagle would hold each one behind a delayed ACK.
    let _ = stream.set_nodelay(true);
    // V2.5-17: tungstenite zero-fills its whole read buffer on every read, and an idle tick or PTY wake is a read
    // that ends in WouldBlock: at the 128 KiB default that was most of an open window's idle core CPU.
    let config = WebSocketConfig::default()
        .read_buffer_size(4096)
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let now = Instant::now();
    let stream = Deadline {
        stream,
        until: Some(now + HANDSHAKE_DEADLINE),
        first: Some(now + FIRST_BYTES),
        wake: None,
        quiet: None,
        due: now,
    };
    let mut ws = tungstenite::accept_hdr_with_config(
        stream,
        |q: &Handshake, r| {
            read();
            check(q, r)
        },
        Some(config),
    )
    .map_err(|e| e.to_string())?;
    ws.get_mut().until = None;
    ws.get_mut()
        .stream
        .set_read_timeout(Some(tick()))
        .map_err(|e| e.to_string())?;
    ws.get_mut().wake = crate::pty::Wake::subscribe().ok();
    Ok(ws)
}

/// v1a-55: reading a Close queued tungstenite's reply; one flush writes it and ends in ConnectionClosed. Each of its
/// writes is bounded by the socket's write timeout (WRITE_TIMEOUT), and a failed flush is not retried, so a peer that
/// stopped reading cannot hold the connection thread.
fn close_reply<S: std::io::Read + std::io::Write>(
    ws: &mut tungstenite::WebSocket<S>,
) -> Result<(), String> {
    match ws.flush() {
        Ok(()) | Err(tungstenite::Error::ConnectionClosed) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn serve(
    mut ws: tungstenite::WebSocket<Deadline>,
    registry: &Arc<Mutex<Sessions>>,
    stopping: &Arc<AtomicBool>,
    home: &Path,
    role: Option<&browser::Role>, // V2.5-15: a browser connection; `None` is the Mac window
    lease: Arc<Lease>,            // ticket 421 round 2: this connection's admission place
) -> Result<(), String> {
    #[cfg(test)]
    let output_counts = output_counts(home);
    // V2.5-15: a browser is never a window CLI layout commands go to, and gets no layout.
    let mut window = role.is_none().then(|| layout::Window::open(home));
    let mut feed = false; // V2.5-17: the chat feed reads chat only: no snapshots, browser or machine events
    let mut layout_stamp = layout::stamp(home);
    let mut layout_at = Instant::now();
    if role.is_none() {
        ws.send(Message::Text(layout::event(home).to_string().into()))
            .map_err(|e| e.to_string())?;
    }
    let browsers = browser::of(home);
    let mut last_browser = String::new();
    let mut last_wait = None;
    // Session id -> (byte cursor, replay frame still owed, v1a-53 pacing).
    let mut watches: BTreeMap<String, (u64, bool, Pace)> = BTreeMap::new();
    // v1a-53: this window acked output, so it is paced (`Pace`); and whether a refused ack was logged yet.
    let (mut paced, mut warned) = (false, false);
    let mut turn = 0; // v1a-53 r2
    // v1a-27: each watched session's replay end, read without the registry; refreshed by every registry pass.
    let mut tails: BTreeMap<String, crate::pty::Tail> = BTreeMap::new();
    let mut synced_at = Instant::now();
    // v1b-02
    let mut chat_watches: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
    let mut last_snapshot = String::new();
    let mut snapshot_at = Instant::now() - SNAPSHOT_EVERY;
    // Ticket 592: the newest core event this window has heard of; room events after it are pushed.
    let mut room_since = crate::events::read(None, |_| false).1;
    // v1a-47: Browse online replies, sent by the loop when a fetch finishes.
    // Q10: a tab on a session of an SSH machine (remote_tab.rs), started at the first such frame of this window.
    let remote_lease = lease.clone();
    let mut remote: Option<remote_tab::RemoteTab> = None;
    let mut remote_watches: std::collections::BTreeSet<String> = Default::default();
    let kid_lease = lease.clone();
    let mut kid_reads: Option<KidReads> = None; // Q9 psn-J12-5
    let mut probes = Jobs::with_cap(lease.clone(), MAX_PROBE_JOBS); // ticket 459
    let mut jobs = Jobs::new(lease);
    // v2-7: per Search panel (`channel`), a newer page cancels the one still scanning; at most 8 panels kept.
    let mut search_cancel = SearchCancel(vec![]);
    while !stopping.load(Ordering::SeqCst) {
        // S9: an idle read lasts until the next timed check below, not a fixed 8 ms tick.
        let layout_due = window.is_some().then(|| layout_at + LAYOUT_EVERY);
        ws.get_mut().due = (snapshot_at.min(synced_at) + SNAPSHOT_EVERY)
            .min(layout_due.unwrap_or(snapshot_at + SNAPSHOT_EVERY));
        match ws.read() {
            Ok(Message::Text(text)) => {
                // V2.5-15: the browser role's allowlist, before any dispatch below.
                if let Some(role) = role
                    && let Err(error) = role.check(&text, registry)
                {
                    let id = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v.get("id").and_then(|i| i.as_u64()));
                    if let Some(id) = id {
                        let response: Response = Err(error);
                        ws.send(Message::Text(
                            serde_json::json!({"id":id,"response":response})
                                .to_string()
                                .into(),
                        ))
                        .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // V2.5-15: Settings > Browser access and the pairing sheet, window only like `ThemeFrame`.
                if let Ok(frame) = serde_json::from_str::<BrowserFrame>(&text) {
                    let response = browsers.window_op(frame.browser);
                    ws.send(Message::Text(
                        serde_json::json!({"id":frame.id,"response":response})
                            .to_string()
                            .into(),
                    ))
                    .map_err(|e| e.to_string())?;
                    continue;
                }
                // v1a-53: first, as the most frequent frame. No reply; a refused ack changes nothing.
                if let Ok(frame) = serde_json::from_str::<AckFrame>(&text) {
                    // Q10: a remote session's read waits for the window's acks (remote_tab.rs `held`).
                    if remote_watches.contains(&frame.ack) {
                        if let Some(tab) = &remote {
                            tab.ack(&frame.ack, frame.bytes);
                        }
                        continue;
                    }
                    let (ok, tell) = match watches.get_mut(&frame.ack) {
                        Some((_, _, pace)) => {
                            let ok = pace.ack(frame.bytes);
                            let tell = !ok && !pace.told;
                            pace.told |= tell;
                            (ok, tell)
                        }
                        None => (false, false),
                    };
                    paced |= ok;
                    // v1a-53 r2: the window's count drifted from ours; held, the session would never resume.
                    if tell {
                        let event = serde_json::json!({"event":"ack_refused","session":frame.ack});
                        ws.send(Message::Text(event.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    if !ok && !warned {
                        warned = true;
                        eprintln!(
                            "window ack refused (unwatched session, lower than before, or past what was sent); further refusals on this connection are not logged"
                        );
                    }
                    continue;
                }
                // v1b-02
                if let Ok(frame) = serde_json::from_str::<ChatFrame>(&text) {
                    let response: Response = (|| {
                        if frame.before.is_none()
                            && !chat_watches.contains_key(&frame.chat)
                            && chat_watches.len() >= MAX_WATCHES
                        {
                            return Err("too many watched chat sessions".into());
                        }
                        let reply = read_chat(registry, &frame.chat, frame.before, None, None)?;
                        if frame.before.is_none()
                            && let Reply::ChatPage { page, .. } = &reply
                        {
                            chat_watches
                                .insert(frame.chat, (page.end, page.skipped, page.generation));
                        }
                        Ok(reply)
                    })();
                    ws.send(Message::Text(
                        serde_json::json!({"id":frame.id,"response":response})
                            .to_string()
                            .into(),
                    ))
                    .map_err(|e| e.to_string())?;
                    continue;
                }
                // v1a-47: a fetch can take 15 s, so it runs off this loop and its reply follows when done.
                if let Ok(frame) = serde_json::from_str::<ThemeFrame>(&text) {
                    let home = home.to_path_buf();
                    let refused = jobs.spawn(frame.id, move || {
                        use crate::themes_online::{Op, Themes};
                        let themes = Themes::new(&home);
                        match frame.request {
                            Op::ThemeIndex => {
                                themes.index().map(|themes| Reply::ThemeIndex { themes })
                            }
                            Op::ThemeFile { name } => {
                                themes.theme(&name).map(|theme| Reply::Theme { theme })
                            }
                        }
                    });
                    if let Some(out) = refused {
                        ws.send(Message::Text(out.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // v2-10c: an Allow fetches for up to 30 s, so it runs off this loop like a theme fetch.
                if let Ok(frame) = serde_json::from_str::<LibsFrame>(&text) {
                    let home = home.to_path_buf();
                    let refused =
                        jobs.spawn(frame.id, move || crate::libs::window(&home, frame.request));
                    if let Some(out) = refused {
                        ws.send(Message::Text(out.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // Owner 2026-11-16: teammates read and write small files, off this loop like the library ops.
                if let Ok(frame) = serde_json::from_str::<TeamFrame>(&text) {
                    // The list is one small file read, asked by every window at connect: on the loop, so it never takes
                    // one of the MAX_JOBS places from the connect burst (import-tree round 2 saw it refused).
                    if matches!(frame.request, crate::team::Op::TeamList) {
                        let response: Response = crate::team::window(registry, home, frame.request);
                        ws.send(Message::Text(
                            serde_json::json!({"id":frame.id,"response":response})
                                .to_string()
                                .into(),
                        ))
                        .map_err(|e| e.to_string())?;
                        continue;
                    }
                    let (registry, home) = (registry.clone(), home.to_path_buf());
                    let refused = jobs.spawn(frame.id, move || {
                        crate::team::window(&registry, &home, frame.request)
                    });
                    if let Some(out) = refused {
                        ws.send(Message::Text(out.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // V2.5-12: lists and scans the agents' transcript folders, so off this loop.
                if let Ok(frame) = serde_json::from_str::<ImportFrame>(&text) {
                    let home = home.to_path_buf();
                    let registry = registry.clone(); // 392: a project list asks which projects the tree holds
                    let refused = jobs.spawn(frame.id, move || {
                        let tree = || crate::import::tree_projects(&registry, &home);
                        crate::import::window(&home, frame.request, tree, &AtomicBool::new(false))
                    });
                    if let Some(out) = refused {
                        ws.send(Message::Text(out.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // v2-7: a scan reads transcripts for up to a page's time, so it runs off this loop like a theme fetch.
                if let Ok(frame) = serde_json::from_str::<SearchFrame>(&text) {
                    let cancel = Arc::new(AtomicBool::new(false));
                    if let crate::chat::search::Op::SessionsSearch { channel, .. } = &frame.request
                    {
                        if let Some(i) = search_cancel.0.iter().position(|(c, _)| c == channel) {
                            search_cancel.0.remove(i).1.store(true, Ordering::Relaxed);
                        }
                        // A finished page's flag is the list's only holder; a running job holds the other.
                        search_cancel.0.retain(|(_, c)| Arc::strong_count(c) > 1);
                        if search_cancel.0.len() >= 8 {
                            search_cancel.0.remove(0).1.store(true, Ordering::Relaxed);
                        }
                        search_cancel.0.push((channel.clone(), cancel.clone()));
                    }
                    let (registry, home) = (registry.clone(), home.to_path_buf());
                    let refused = jobs.spawn(frame.id, move || {
                        crate::chat::search::run(&registry, &home, frame.request, &cancel)
                    });
                    if let Some(out) = refused {
                        ws.send(Message::Text(out.to_string().into()))
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                // v1a-38b: a file write and a PTY spawn, like `Start`: inline, one at a time per window.
                if let Ok(frame) = serde_json::from_str::<EditFrame>(&text) {
                    let response = crate::scrollback_edit::run(home, registry, frame.request);
                    ws.send(Message::Text(
                        serde_json::json!({"id":frame.id,"response":response})
                            .to_string()
                            .into(),
                    ))
                    .map_err(|e| e.to_string())?;
                    continue;
                }
                let out = match serde_json::from_str::<Frame>(&text) {
                    // v2-2a: the probes take up to 5 s, so the list runs off this loop (it needs no registry).
                    // v2-2c: the usage totals read transcript files, so they run off this loop too.
                    // v2-5a: runs `--version` probes, so off the frame loop.
                    // V2.5-17: the feed sends this first; until then it counts as a window for a few ms.
                    // The marker frame carries nothing else: a request beside it is refused, not run unmarked.
                    Ok(frame) if frame.layout_feed && frame.request.is_some() => {
                        let response: Response = Err("layout_feed takes no request".into());
                        Some(serde_json::json!({"id":frame.id,"response":response}))
                    }
                    Ok(frame) if frame.layout_feed => {
                        window = None;
                        feed = true;
                        let response: Response = Ok(Reply::Ack);
                        Some(serde_json::json!({"id":frame.id,"response":response}))
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::FirstRun)) => {
                        jobs.spawn(frame.id, crate::firstrun::reply)
                    }
                    // V2-8a: `git` per worktree and a `gh` call of up to 10 s: off this loop. The window holds the owner
                    // token; the same path as the CLI's.
                    Ok(frame) if matches!(frame.request, Some(Request::Worktree { .. })) => {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::server::worktree(&registry, None, request, None)
                        })
                    }
                    // Ticket 259: a grant starts the worktree's setup tab; the window holds the owner token.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::SetupStatus { .. } | Request::SetupGrant { .. })
                        ) =>
                    {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::worktree_setup::serve(&registry, request)
                        })
                    }
                    // Ticket 990 slices g to i: the window reads and changes the ledger, notes and roles with the
                    // owner's reach, as on the socket; a task's revision reads git, so off this loop.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(
                                Request::Task { .. } | Request::Note { .. } | Request::Role { .. }
                            )
                        ) =>
                    {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::ledger::dispatch(&registry, None, request)
                        })
                    }
                    // Ticket 993: Run now starts a session (a seat's brief, a launch check): off this loop, with the
                    // owner's reach as on the socket.
                    Ok(frame) if matches!(frame.request, Some(Request::ScheduleRunNow { .. })) => {
                        let registry = registry.clone();
                        let Some(Request::ScheduleRunNow { id }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || crate::schedule::run_now(&registry, &id))
                    }
                    // Ticket 373: the by-branch lookup runs git and gh: off this loop, as the PR view.
                    Ok(frame) if matches!(frame.request, Some(Request::PrBranch { .. })) => {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || crate::pr::answer(&registry, request))
                    }
                    // The Diff panel's Push runs git for up to 120 s: off this loop.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(
                                Request::GitPush { .. }
                                    | Request::PrDraft { .. }
                                    | Request::PrCreate { .. }
                            )
                        ) =>
                    {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::git_write::answer(&registry, request)
                        })
                    }
                    // The form's Write with AI runs the agent CLI for up to 60 s: off this loop.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::PrWrite { .. } | Request::PrWriteCancel { .. })
                        ) =>
                    {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::text_gen::answer(&registry, request)
                        })
                    }
                    // V2.5-8/9: `gh` runs of up to 15 s (a merge up to 60 s): off this loop.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(
                                Request::PrView { .. } | Request::PrList | Request::PrMerge { .. }
                            )
                        ) =>
                    {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || crate::pr::answer(&registry, request))
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::SessionContext { .. })) => {
                        let Some(Request::SessionContext { id, refresh }) = frame.request else {
                            unreachable!()
                        };
                        let registry = registry.clone();
                        let home = home.to_path_buf();
                        dispatch_session_context(&mut jobs, frame.id, move || {
                            crate::session_context::reply(&home, &registry, &id, refresh)
                        })
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::ForgetMachine { .. })) => {
                        let registry = registry.clone();
                        let Some(Request::ForgetMachine { alias }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || {
                            crate::sessions::forget_machine(&registry, &alias)
                        })
                    }
                    // Ticket 980: a request for a machine (the New session card's start there) waits on ssh: off this
                    // loop, under the owner's forwarding rules (real SSH look 11-17: this loop had no arm for it).
                    Ok(frame) if matches!(frame.request, Some(Request::Remote { .. })) => {
                        let (registry, stopping) = (registry.clone(), stopping.clone());
                        let home = home.to_path_buf();
                        let Some(Request::Remote { machine, request }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || {
                            crate::server::remote_from_owner(
                                &registry, &home, "", machine, *request, &stopping,
                            )
                        })
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::MachineStatus { .. })) => {
                        let registry = registry.clone();
                        let home = home.to_path_buf();
                        let Some(Request::MachineStatus { label, retry }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || {
                            crate::machines::status(&registry, &home, label, retry)
                        })
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::MachineDetails { .. })) => {
                        let registry = registry.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            let Request::MachineDetails { alias } = request else {
                                unreachable!()
                            };
                            crate::machines::discovery::reply(&registry, alias)
                        })
                    }
                    // v25f: the Add form's suggestions read files and its Test waits on ssh: off this loop too.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(
                                Request::MachineAliases
                                    | Request::MachineProbe { .. }
                                    | Request::MachineShare
                                    | Request::MachineTrust { .. }
                            )
                        ) =>
                    {
                        let registry = registry.clone();
                        let home = home.to_path_buf();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || match request {
                            Request::MachineProbe { host, user, port } => {
                                crate::machines::aliases::probe(&host, user.as_deref(), port)
                            }
                            Request::MachineShare => crate::machines::share::reply(),
                            Request::MachineTrust { alias, link } => {
                                crate::machines::share::trust(&registry, &home, &alias, &link)
                            }
                            _ => crate::machines::aliases::reply(&registry, &home),
                        })
                    }
                    // Ticket 370: `git init` and the first commit, each with a limit: off this loop.
                    Ok(frame) if matches!(frame.request, Some(Request::ProjectCreate { .. })) => {
                        let Some(Request::ProjectCreate { name, parent }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || {
                            crate::projects::create(&name, parent.as_deref())
                        })
                    }
                    // v25f: runs each source-control CLI for up to 5 s: off this loop.
                    Ok(frame) if matches!(frame.request, Some(Request::GitProviders { .. })) => {
                        let Some(Request::GitProviders { login, logout }) = frame.request else {
                            unreachable!()
                        };
                        let (registry, stopping) = (registry.clone(), stopping.clone());
                        jobs.spawn(frame.id, move || {
                            crate::git_providers::handle(&registry, Some(&stopping), login, logout)
                        })
                    }
                    Ok(frame) if matches!(frame.request, Some(Request::AccountUsage { .. })) => {
                        let (home, registry) = (home.to_path_buf(), registry.clone());
                        let Some(Request::AccountUsage { limits }) = frame.request else {
                            unreachable!()
                        };
                        jobs.spawn(frame.id, move || {
                            let reply = crate::usage::reply(&home, limits);
                            crate::account_near::after_usage(
                                &registry,
                                &home,
                                &reply,
                                crate::queue::now_ms() as i64 / 1000,
                            );
                            reply
                        })
                    }
                    // v4 Usage page: up to 90 days of transcripts, off this loop.
                    Ok(frame) if matches!(frame.request, Some(Request::UsageDetail { .. })) => {
                        let home = home.to_path_buf();
                        let Some(Request::UsageDetail {
                            days,
                            account,
                            sessions,
                        }) = frame.request
                        else {
                            unreachable!()
                        };
                        let filter = crate::usage::Filter::new(account, sessions);
                        jobs.spawn(frame.id, move || {
                            crate::usage::detail_reply(&home, days, filter)
                        })
                    }
                    // Needs 225: the window is the owner; codex runs for up to 40 s, so off this loop. The log is one small
                    // file read and runs on the loop, so it never takes one of the MAX_JOBS places.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::CodexResetRead { .. } | Request::CodexResetUse { .. })
                        ) =>
                    {
                        let home = home.to_path_buf();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || crate::codex_reset::owner(&home, request))
                    }
                    // ticket 113: reads up to 300 small files in the user's agent folders: off this loop.
                    Ok(frame) if matches!(frame.request, Some(Request::UserCommands { .. })) => {
                        let Some(Request::UserCommands { kind }) = frame.request else {
                            unreachable!()
                        };
                        dispatch_user_commands(
                            &mut jobs,
                            frame.id,
                            kind,
                            crate::user_commands::reply,
                        )
                    }
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::AccountList | Request::AccountCheck { .. })
                        ) =>
                    {
                        let home = home.to_path_buf();
                        let request = frame.request.unwrap();
                        probes.spawn(frame.id, move || {
                            crate::accounts::probe_reply(&home, request)
                        })
                    }
                    // Ticket 358: sign-in reads the reported methods first and sign-out waits for the answer.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::AcpAgentSignIn { .. } | Request::AcpAgentSignOut { .. })
                        ) =>
                    {
                        let (registry, home) = (registry.clone(), home.to_path_buf());
                        let stopping = stopping.clone();
                        let request = frame.request.unwrap();
                        jobs.spawn(frame.id, move || {
                            crate::acp::setup(&home, &registry, Some(&stopping), request)
                        })
                    }
                    // V2-4b: the agent list probes `--version` and the check runs the typed command for up to 5 s.
                    Ok(frame)
                        if matches!(
                            frame.request,
                            Some(Request::AcpAgents | Request::AcpAgentCheck { .. })
                        ) =>
                    {
                        let (registry, home) = (registry.clone(), home.to_path_buf());
                        let request = frame.request.unwrap();
                        probes.spawn(frame.id, move || {
                            crate::acp::setup(&home, &registry, None, request)
                        })
                    }
                    // Codex note on lane w87: the folder checks stat each project, which a stalled disk holds: off this loop.
                    Ok(frame) if matches!(frame.request, Some(Request::ProjectFolders)) => {
                        let registry = registry.clone();
                        probes.spawn(frame.id, move || {
                            crate::sessions::locate::folders(&registry)
                        })
                    }
                    // Lane w96: Locate's folder check stats the picked folder: off this loop too.
                    Ok(Frame {
                        id,
                        request: Some(Request::ProjectLocate { from, to }),
                        ..
                    }) => {
                        let registry = registry.clone();
                        probes.spawn(id, move || {
                            crate::sessions::locate::serve(&registry, &from, &to)
                        })
                    }
                    // Ticket 358: runs the typed path's `--version` for up to 5 s.
                    Ok(Frame {
                        id,
                        request:
                            Some(Request::AgentCommandCheck {
                                agent,
                                path,
                                args,
                                env,
                            }),
                        ..
                    }) => {
                        let home = home.to_path_buf();
                        probes.spawn(id, move || {
                            crate::approval::command_check(&home, agent, path, args, env)
                                .map(|check| Reply::CommandCheck { check })
                        })
                    }
                    // Q9 psn-J12-5: off this loop (`KidReads`).
                    Ok(Frame {
                        id: frame,
                        request: Some(Request::Subagents { id, open }),
                        ..
                    }) => {
                        if kid_reads.is_none() {
                            let registry = registry.clone();
                            kid_reads = KidReads::start(kid_lease.clone(), move |id, open| {
                                read_subagents(&registry, id, open)
                            });
                        }
                        match &kid_reads {
                            Some(reads) => reads.ask(frame, id, open),
                            None => {
                                let response: Response =
                                    Err("could not start the request; try again".into());
                                Some(serde_json::json!({"id":frame,"response":response}))
                            }
                        }
                    }
                    // Q10: the owner window's frame on a row an SSH machine pushed goes to that machine, never a browser's.
                    Ok(frame) => match role
                        .is_none()
                        .then(|| remote_route(registry, &frame, &remote_watches))
                        .flatten()
                    {
                        Some(alias) => {
                            let tab = remote.get_or_insert_with(|| {
                                remote_tab::RemoteTab::start(
                                    registry,
                                    home,
                                    stopping,
                                    remote_lease.clone(),
                                )
                            });
                            let ack = |response: Response| {
                                Some(serde_json::json!({"id":frame.id,"response":response}))
                            };
                            if let Some(id) = frame.watch {
                                if !remote_watches.contains(&id)
                                    && watches.len() + remote_watches.len() >= MAX_WATCHES
                                {
                                    ack(Err("too many watched sessions".into()))
                                } else {
                                    match tab.watch(id.clone(), alias, frame.after) {
                                        Ok(()) => {
                                            remote_watches.insert(id);
                                            ack(Ok(Reply::Ack))
                                        }
                                        Err(busy) => ack(Err(busy)),
                                    }
                                }
                            } else if let Some(id) = frame.unwatch {
                                // Refused (the queue is full): the watch stays listed, so a later unwatch still reaches it.
                                match tab.unwatch(id.clone()) {
                                    Ok(()) => {
                                        remote_watches.remove(&id);
                                        ack(Ok(Reply::Ack))
                                    }
                                    Err(busy) => ack(Err(busy)),
                                }
                            } else if let Some(request) = frame.request {
                                match tab.call(frame.id, alias, request) {
                                    Ok(()) => None,
                                    Err(busy) => ack(Err(busy)),
                                }
                            } else {
                                None
                            }
                        }
                        None => Some(answer(
                            frame,
                            registry,
                            stopping,
                            &mut watches,
                            home,
                            window.as_ref(),
                            &mut layout_stamp,
                        )),
                    },
                    // V2.5-37: a frame whose `id` is readable gets a fixed refusal (no frame text echoed), so the
                    // window does not wait on an unknown op or a missing field; without one it is dropped, as in Zeron.
                    Err(_) => serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v.get("id")?.as_u64())
                        .map(|id| {
                            let response: Response = Err("malformed request".into());
                            serde_json::json!({"id":id,"response":response})
                        }),
                };
                if let Some(out) = out {
                    ws.send(Message::Text(out.to_string().into()))
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok(Message::Close(_)) => return close_reply(&mut ws),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(tungstenite::Error::ConnectionClosed) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
        while let Some(reply) = jobs.ready().or_else(|| probes.ready()) {
            ws.send(Message::Text(reply.to_string().into()))
                .map_err(|e| e.to_string())?;
        }
        while let Some(reply) = kid_reads.as_ref().and_then(KidReads::ready) {
            ws.send(Message::Text(reply.to_string().into()))
                .map_err(|e| e.to_string())?;
        }
        while let Some(out) = remote.as_ref().and_then(remote_tab::RemoteTab::ready) {
            ws.send(match out {
                remote_tab::Out::Text(text) => Message::Text(text.into()),
                remote_tab::Out::Binary(bytes) => Message::Binary(bytes.into()),
            })
            .map_err(|e| e.to_string())?;
        }
        let mut cursors: Vec<(String, (u64, bool, Pace))> =
            watches.iter().map(|(k, v)| (k.clone(), *v)).collect();
        // v1a-53 r2: each pass starts at the next session, so no session id always gets first claim on `UNACKED_TOTAL`.
        if !cursors.is_empty() {
            turn = (turn + 1) % cursors.len();
            cursors.rotate_left(turn);
        }
        // A registry pass per watch at least every SNAPSHOT_EVERY still reports ended or replaced sessions.
        #[cfg(test)]
        output_counts.passes.fetch_add(1, Ordering::SeqCst);
        let resync = synced_at.elapsed() >= SNAPSHOT_EVERY;
        if resync {
            synced_at = Instant::now();
            tails.retain(|id, _| watches.contains_key(id));
        }
        // v1a-53 r2: what this window has left of `UNACKED_TOTAL`, kept current as frames go below.
        let mut unacked: u64 = cursors.iter().map(|(_, (_, _, p))| p.unacked()).sum();
        for (id, (cursor, replay, mut pace)) in cursors {
            let free = paced.then(|| unacked_total().saturating_sub(unacked));
            // v1a-27: a wake from a session this window does not watch moves no tail here, so it costs no lock.
            // v1a-53: nor does a session held for this window, until it has room; a resync still checks it exists.
            let pending = tails.get(&id).map(|t| t.end().saturating_sub(cursor));
            let held = !replay && pending.is_some_and(|p| pace.held(free, p));
            if !replay && !resync && (held || pending == Some(0)) {
                continue;
            }
            #[cfg(test)]
            output_counts.locks.fetch_add(1, Ordering::SeqCst);
            let (read, tail) = {
                let registry = registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                // v1a-53: a held session is read at its end: nothing copied, only whether it is still there.
                let at = if held {
                    cursor + pending.unwrap_or(0)
                } else {
                    cursor
                };
                (registry.output(&id, at), registry.tail(&id))
            };
            match tail {
                Some(tail) => tails.insert(id.clone(), tail),
                None => tails.remove(&id),
            };
            if held && read.is_ok() {
                continue;
            }
            // v1a-53: only what the window has room for goes; a skip goes whole or waits (`Pace::take`).
            let read = match read {
                Ok(Reply::Output {
                    mut data,
                    start,
                    end,
                    truncated,
                }) => match pace.take(free, data.len(), truncated) {
                    Some(n) => {
                        let end = if n < data.len() {
                            start + n as u64
                        } else {
                            end
                        };
                        data.truncate(n);
                        Ok(Reply::Output {
                            data,
                            start,
                            end,
                            truncated,
                        })
                    }
                    None => continue,
                },
                other => other,
            };
            match read {
                Ok(Reply::Output {
                    data,
                    start,
                    end,
                    truncated,
                }) if replay || !data.is_empty() || truncated => {
                    // The first frame after a watch is the replay, sent even when empty, so the window
                    // can tell old output (whose terminal queries it must not answer) from live output.
                    let bytes = output_frame(&id, start, end, truncated, replay, &data);
                    ws.send(Message::Binary(bytes.into()))
                        .map_err(|e| e.to_string())?;
                    pace.sent(data.len() as u64);
                    unacked += data.len() as u64;
                    watches.insert(id, (end, false, pace));
                }
                Ok(_) => {}
                Err(error) => {
                    watches.remove(&id);
                    tails.remove(&id);
                    let event = serde_json::json!({"event":"unwatched","session":id,"error":error});
                    ws.send(Message::Text(event.to_string().into()))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if window.is_some() && layout_at.elapsed() >= LAYOUT_EVERY {
            layout_at = Instant::now();
            let now = layout::stamp(home);
            if now != layout_stamp {
                layout_stamp = now;
                ws.send(Message::Text(layout::event(home).to_string().into()))
                    .map_err(|e| e.to_string())?;
            }
        }
        if let Some((seq, args)) = window.as_ref().and_then(layout::Window::next_command) {
            // The file as it is now rides along, so the window never applies a command to a stale layout.
            let file = layout::event(home);
            let event =
                serde_json::json!({"event":"layout_command","seq":seq,"args":args,"file":file});
            if let Err(e) = ws.send(Message::Text(event.to_string().into())) {
                layout::done(home, seq, Err("the window closed before answering".into()));
                return Err(e.to_string());
            }
        }
        // v1b-02: chat polling shares the snapshot cadence, not the 8 ms terminal cadence.
        if snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            for (session, (after, skipped, generation)) in chat_watches.clone() {
                let reply = read_chat(registry, &session, None, Some(after), Some(generation));
                match reply {
                    Ok(Reply::ChatPage { page, .. })
                        if !page.events.is_empty()
                            || page.skipped != skipped
                            || page.generation != generation =>
                    {
                        let cursor = page.events.last().map(|e| e.cursor).unwrap_or(page.end);
                        ws.send(Message::Text(
                            serde_json::json!({"event":if page.generation!=generation {"chat_reset"}else{"chat"},"session":session,"page":page})
                                .to_string()
                                .into(),
                        ))
                        .map_err(|e| e.to_string())?;
                        chat_watches.insert(session, (cursor, page.skipped, page.generation));
                    }
                    Err(error) => {
                        chat_watches.remove(&session);
                        ws.send(Message::Text(serde_json::json!({"event":"chat_error","session":session,"error":error}).to_string().into())).map_err(|e|e.to_string())?;
                    }
                    _ => {}
                }
            }
        }
        // Ticket 592: the Mac window hears that a room changed (the core event stream's `room_*` events), so its Room
        // panel reads at once instead of polling. No project or body: the panel's incremental `room_read` stays the one
        // read path, and a window's project path need not match the room's canonical one.
        if role.is_none() && !feed && snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            // The schedule list the same way (`schedules_changed`): the Schedules widget reads `schedule_list` when it
            // hears `{"event":"schedules"}`.
            let schedules = |e: &crate::events::Event| e.kind == "schedules_changed";
            let (events, latest, gap) = crate::events::read(Some(room_since), |e| {
                e.kind.starts_with("room_") || schedules(e)
            });
            if gap || events.iter().any(|e| !schedules(e)) {
                ws.send(Message::Text(r#"{"event":"room"}"#.into()))
                    .map_err(|e| e.to_string())?;
            }
            if gap || events.iter().any(schedules) {
                ws.send(Message::Text(r#"{"event":"schedules"}"#.into()))
                    .map_err(|e| e.to_string())?;
            }
            room_since = latest;
        }
        // V2.5-15: the Mac window hears of pairings and of what browsers did.
        if role.is_none() && !feed && snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            let event = browsers.event().to_string();
            if event != last_browser {
                ws.send(Message::Text(event.clone().into()))
                    .map_err(|e| e.to_string())?;
                last_browser = event;
            }
        }
        // The starts waiting for memory: the Mac window's status bar item, sent when the list or its notes change.
        if role.is_none() && !feed && snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            let version = crate::pressure::version();
            if Some(version) != last_wait {
                ws.send(Message::Text(crate::pressure::event().into()))
                    .map_err(|e| e.to_string())?;
                last_wait = Some(version);
            }
        }
        if feed && snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            snapshot_at = Instant::now();
        }
        if snapshot_at.elapsed() >= SNAPSHOT_EVERY {
            snapshot_at = Instant::now();
            #[cfg(test)]
            crate::machines::refresh_tests::record(home, true);
            // MachineDetails reports registry errors; they must not disconnect local windows.
            let _ = crate::machines::ensure_channels(registry, home, stopping);
            let mut snapshot = registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .snapshot();
            // Q10: the owner window shows the machines' pushed rows, as the owner socket's snapshot does.
            if role.is_none()
                && let Ok(reply) = &mut snapshot
            {
                let _ = crate::machines::snapshot(registry, home, "", true, reply, stopping);
            }
            if let Ok(Reply::Snapshot {
                mut sessions,
                board_decisions,
                owner_decisions,
                ..
            }) = snapshot
            {
                // Look 11-17 v8 (area B S2-1): a question is drawn with its choices or not yet (`question_held`).
                let now = crate::queue::now_ms();
                for session in &mut sessions {
                    session
                        .pending
                        .retain(|i| !crate::sessions::question_held(i, now));
                }
                // S9: written straight to text (no `serde_json::Value` of every row) every 100 ms, to compare.
                #[derive(serde::Serialize)]
                struct Event<'a> {
                    event: &'static str,
                    sessions: &'a [crate::api::Session],
                    // v1b-18: present only when there are board decisions.
                    #[serde(skip_serializing_if = "<[_]>::is_empty")]
                    board_decisions: &'a [crate::board::Decision],
                    // v1a-23: likewise the items sessions asked the owner to answer.
                    #[serde(skip_serializing_if = "<[_]>::is_empty")]
                    owner_decisions: &'a [crate::queue::Decision],
                }
                let event = serde_json::to_string(&Event {
                    event: "snapshot",
                    sessions: &sessions,
                    board_decisions: &board_decisions,
                    owner_decisions: &owner_decisions,
                })
                .map_err(|e| e.to_string())?;
                if event != last_snapshot {
                    ws.send(Message::Text(event.clone().into()))
                        .map_err(|e| e.to_string())?;
                    last_snapshot = event;
                }
            }
        }
    }
    let _ = ws.close(None);
    Ok(())
}

/// A terminal output frame: its JSON head's length (4 bytes, big-endian), the head, then the bytes. The first frame
/// after a watch is the replay, sent even when empty, so the window can tell old output (whose terminal queries it
/// must not answer) from live output.
fn output_frame(
    id: &str,
    start: u64,
    end: u64,
    truncated: bool,
    replay: bool,
    data: &[u8],
) -> Vec<u8> {
    let head = serde_json::json!({
        "session": id, "start": start, "end": end, "truncated": truncated, "replay": replay
    })
    .to_string();
    let mut bytes = (head.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(head.as_bytes());
    bytes.extend_from_slice(data);
    bytes
}

/// Q10: the machine a window frame on a pushed remote row goes to: a watch, an unwatch of a remote watch, a terminal's
/// read, keys, text, resize or close, or an answer to a pushed decision. `None` for anything of this core.
fn remote_route(
    registry: &Mutex<Sessions>,
    frame: &Frame,
    remote_watches: &std::collections::BTreeSet<String>,
) -> Option<String> {
    if frame.layout_focus || frame.layout_save.is_some() || frame.layout_done.is_some() {
        return None;
    }
    let sessions = registry.lock().ok()?;
    let holder = |id: &str| crate::machines::holder(&sessions, id);
    if let Some(id) = &frame.watch {
        return holder(id);
    }
    if let Some(id) = &frame.unwatch {
        return remote_watches.contains(id).then(String::new);
    }
    match frame.request.as_ref()? {
        Request::Read { id, .. }
        | Request::SendText { id, .. }
        | Request::SendKeys { id, .. }
        | Request::Resize { id, .. }
        | Request::Close { id } => holder(id),
        Request::Answer { item, .. } => crate::machines::item_holder(&sessions, item),
        _ => None,
    }
}

// v1b-02: lock lifetime ends before plan.read_live performs filesystem work.
fn read_chat(
    registry: &Mutex<Sessions>,
    id: &str,
    before: Option<u64>,
    after: Option<u64>,
    generation: Option<u64>,
) -> Response {
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    // V2-4a: an ACP chat is the agent's `session/update`s, held in memory.
    if let Some(page) = sessions.acp_chat(id, before, after) {
        return page.map(|page| Reply::ChatPage {
            session: id.into(),
            page,
        });
    }
    let plan = sessions.chat_plan(id, before, after)?;
    drop(sessions);
    plan.read_live(generation).map(|page| Reply::ChatPage {
        session: id.into(),
        page,
    })
}

// v2-3a: walks the chat back to the last switch (or the start), then builds the handoff off the registry lock.
pub(crate) fn read_handoff(
    registry: &Mutex<Sessions>,
    id: &str,
    through: Option<&str>,
    last_five: bool,
) -> Response {
    let (kind, root) = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .handoff_meta(id)?;
    let (events, older_cut) =
        crate::chat::handoff::collect_through(through, |before, generation| {
            match read_chat(registry, id, before, None, generation)? {
                Reply::ChatPage { page, .. } => Ok(page),
                _ => Err("chat unavailable".into()),
            }
        })?;
    let name = match kind {
        AgentKind::Claude => "Claude",
        AgentKind::Codex => "Codex",
        AgentKind::Shell => "Shell",
        AgentKind::Acp => "ACP agent", // V2-4a
    };
    let build = if last_five {
        crate::chat::handoff::build_last_five
    } else {
        crate::chat::handoff::build
    };
    let h = build(&events, name, id, &root, older_cut);
    // v2-3b: the preview is the text as it would be sent (redacted, no control characters).
    let text = crate::chat::handoff::outgoing(&h.text);
    Ok(Reply::Handoff {
        bytes: text.len(),
        text,
        prompts: h.prompts,
        files: h.files,
    })
}

// v2-8b: reads the newest chat pages (at most 20) up to the first that yields a chip. Transcript text only.
// Ticket 419: then up to `PAST_CHIP` older pages until the chip's PR create shows, so a PR an agent made on an older
// page keeps Merge.
fn read_pr_chip(registry: &Mutex<Sessions>, id: &str) -> Response {
    const PAGES: usize = 20;
    // shortcut: a create more than 4 pages (8 MiB) before the chip's page is not seen, so that PR gets no Merge; pr_chip
    // runs per card, row and chat view, and a chip with no create here would read all 20 pages each time. Cache the
    // created links per session if such a PR shows up.
    const PAST_CHIP: usize = 4;
    let (mut before, mut generation, mut events, mut chip, mut past) =
        (None, None, vec![], None, 0);
    for _ in 0..PAGES {
        let read = read_chat(registry, id, before, None, generation);
        // A session with no conversation to read (a terminal) still shows the PR the app made for it.
        let Ok(Reply::ChatPage { page, .. }) = read else {
            let made = crate::pr_live::made_chip(id);
            if made.as_ref().is_none_or(|c| c.linked.is_some()) {
                link_from_output(registry, id);
            }
            if let Some(chip) = made {
                return Ok(Reply::PrChip { chip: Some(chip) });
            }
            read?;
            return Err("chat unavailable".into());
        };
        // Every later page must match the first page's generation: after a reset, start over from the newest page.
        if generation.is_some_and(|g| g != page.generation) {
            (before, generation, chip, past) = (None, None, None, 0);
            events.clear();
            continue;
        }
        generation = Some(page.generation);
        // Older pages go in front, so a result on a newer page still meets its tool_use.
        events.splice(0..0, page.events.into_iter().map(|e| e.data));
        // The chip is the one the newest pages give; older pages only add creates.
        chip = chip.or_else(|| crate::chat::pr::scan(&events));
        if let Some(c) = &chip {
            if past == PAST_CHIP || crate::chat::pr::created(&events).contains(&c.url) {
                break;
            }
            past += 1;
        }
        before = page.before;
        if before.is_none() {
            break;
        }
    }
    if chip.is_some() {
        crate::pr_live::note_created(&events); // v2-8c
    }
    // A PR the app created from the Diff panel, or one the agent printed in its terminal, until the transcript names one.
    let chip = chip.or_else(|| crate::pr_live::made_chip(id));
    // No PR yet, or one linked from the output: look again (the agent may open a new PR on another branch).
    if chip.as_ref().is_none_or(|c| c.linked.is_some()) {
        link_from_output(registry, id);
    }
    Ok(Reply::PrChip { chip })
}

/// The auto-link's input: the session's terminal output, with live PR status on; the gh check runs off this thread.
fn link_from_output(registry: &Mutex<Sessions>, id: &str) {
    let Ok(mut sessions) = registry.lock() else {
        return;
    };
    let on = sessions
        .pr_live(None, None, None)
        .is_ok_and(|(on, _, _)| on);
    // The rate limit before the output is copied under the lock.
    if !on || !crate::pr_live::link_due(id) {
        return;
    }
    let agent = sessions.session_meta(id).ok().map(|m| match m.kind {
        crate::api::AgentKind::Claude => "Claude".to_string(),
        crate::api::AgentKind::Codex => "Codex".to_string(),
        crate::api::AgentKind::Acp => m.acp_agent.unwrap_or_else(|| "the agent".into()),
        crate::api::AgentKind::Shell => "Shell".to_string(),
    });
    if let (Some(agent), Some((dir, output))) = (agent, sessions.output_tail(id)) {
        drop(sessions);
        crate::pr_live::link_later(id, agent, dir, &output);
    }
}

// V2-CF4: the tree's sub-agent rows. An ACP agent's children are held in memory; the other kinds' are folded off the
// registry lock from the last 256 KiB of the session's own transcript (chat::kids), so nothing is sent or written.
// Needs 169: with `open` the reply also carries that child's own output (its transcript file, found from the parent
// transcript path alone) or, with no such file, where the launch sits in the parent's chat.
fn read_subagents(registry: &Mutex<Sessions>, id: &str, open: Option<&str>) -> Response {
    if let Some(kid) = open
        && !crate::chat::kids::valid_id(kid)
    {
        return Err("invalid sub-agent id".into());
    }
    let (kids, fold) = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .kids_source(id)?;
    // Off the registry lock (look 11-17 v4 B S1-1): the locate may walk a folder that blocks.
    let fold = fold.and_then(|(meta, path)| {
        let path = path.or_else(|| crate::waiting::transcript::locate(&meta))?;
        Some((meta, path))
    });
    let (kids, parent) = match fold {
        Some((meta, path)) => (
            crate::chat::kids::of(&meta, Some(&path))?,
            Some((meta, path)),
        ),
        None => (kids, None),
    };
    let opened = open
        .map(|kid| open_subagent(registry, id, kid, parent.as_ref()))
        .transpose()?;
    Ok(Reply::Subagents {
        session: id.into(),
        kids: kids.kids,
        opened,
    })
}

fn open_subagent(
    registry: &Mutex<Sessions>,
    id: &str,
    kid: &str,
    parent: Option<&(crate::api::Session, std::path::PathBuf)>,
) -> Result<crate::chat::kids::Opened, String> {
    use crate::chat::kids::{Opened, Source};
    if let Some((meta, path)) = parent
        && let Some(file) = crate::chat::kids::child_transcript(meta, path, kid)?
    {
        let (events, truncated) = crate::chat::kids::read_child(meta.kind, &file)?;
        return Ok(Opened {
            source: Source::Child,
            events,
            truncated,
            cursor: None,
        });
    }
    Ok(Opened {
        source: Source::Parent,
        events: vec![],
        truncated: false,
        cursor: launch_cursor(registry, id, kid),
    })
}

// The cursor of the launch call `kid` in the parent's chat: the newest pages only (at most 20, as `read_pr_chip`).
fn launch_cursor(registry: &Mutex<Sessions>, id: &str, kid: &str) -> Option<u64> {
    let (mut before, mut generation) = (None, None);
    for _ in 0..20 {
        let Ok(Reply::ChatPage { page, .. }) = read_chat(registry, id, before, None, generation)
        else {
            return None;
        };
        if generation.is_some_and(|g| g != page.generation) {
            (before, generation) = (None, None);
            continue;
        }
        generation = Some(page.generation);
        if let Some(e) = page
            .events
            .iter()
            .find(|e| e.data["kind"] == "tool_use" && e.data["tool_id"] == kid)
        {
            return Some(e.cursor);
        }
        before = Some(page.before?); // no older page: the call is not in the chat's reach
    }
    None
}

#[cfg(test)]
mod flow_tests; // v1a-53

#[cfg(test)]
mod tests;

/// v1a-53: the window parsed `bytes` of the session's output since its last watch (the data of the Output frames).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AckFrame {
    ack: String,
    bytes: u64,
}

// v1b-02: a newest-page request subscribes; older-page requests leave its live cursor alone.
#[derive(Deserialize)]
struct ChatFrame {
    id: u64,
    chat: String,
    before: Option<u64>,
}

// V2.5-15: Settings > Browser access and the pairing sheet's Allow / Deny; window only, never an `api::Request`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserFrame {
    id: u64,
    browser: browser::Op,
}
