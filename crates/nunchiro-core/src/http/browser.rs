//! V2.5-15: the browser listener (docs/design/v25-web-access.md). Off by default; when on, one socket per address
//! (127.0.0.1 and this Mac's Tailscale addresses), plain HTTP serving the embedded web bundle, `/pair` and `/ws`.
//! A browser connection runs the window frame loop with the browser role: watch and answer, nothing else (`allowed`).
//! The window listener, its token and its gates are untouched; the window token is never accepted here.
use super::pair::{Device, Devices, Pairs, Poll};
use super::{AckFrame, ChatFrame, EditFrame, Frame, LibsFrame, SearchFrame, ThemeFrame};
use crate::{api::Request, sessions::Sessions, store};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    handshake::server::{ErrorResponse, Request as Handshake, Response as Accepted},
    http::{HeaderValue, StatusCode},
};

pub(crate) const DEFAULT_PORT: u16 = 7788;
/// T12: browsers have their own authenticated cap, so they cannot starve the Mac window's.
pub(crate) const MAX_BROWSERS: usize = 8;
const MAX_HANDSHAKES: usize = 16;
const RESCAN: Duration = Duration::from_secs(30);
/// S9: the supervisor's idle wait. A settings change rings `bell` and is seen at once; without a bell, within
/// `BELL_LESS_WAIT`. The wait only bounds how late `stopping` is seen.
const IDLE_WAIT: Duration = Duration::from_secs(1);
const BELL_LESS_WAIT: Duration = Duration::from_millis(100);
const MAX_HEAD: usize = 8 << 10;
const MAX_BODY: usize = 1 << 10;
const MAX_NOTICES: usize = 20;
/// W1: every response, 404 included. Inline style stays allowed as on the window (xterm and React style attributes).
pub(crate) const CSP: &str = "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
/// Marks the served page as the browser role (the window's copy never carries it).
const ROLE_META: &str = r#"<meta name="nunchiro-browser" content="1">"#;

// build.rs: `ASSETS: &[(path, content type, bytes)]` from web/dist, empty when the bundle was not built.
include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    enabled: bool,
    port: u16,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
        }
    }
}

/// Settings > Browser access: what the window shows and changes (window only, `BrowserFrame`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "BrowserStatus"))]
pub struct Status {
    pub enabled: bool,
    pub port: u16,
    /// `address:port` of each bound socket.
    pub addresses: Vec<String>,
    pub tailscale: bool,
    pub problem: Option<String>,
    pub devices: Vec<DeviceRow>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DeviceRow {
    pub id: String,
    pub name: String,
    pub last_used_ms: u64,
    pub peer: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Op {
    Status,
    Set { enabled: bool, port: Option<u16> },
    Answer { id: String, allow: bool },
    Revoke { device: Option<String> },
}

#[derive(Default)]
struct Bound {
    addresses: Vec<SocketAddr>,
    tailscale: bool,
    problem: Option<String>,
}

#[derive(Clone, Serialize)]
struct Notice {
    seq: u64,
    device: String,
    name: String,
    action: &'static str,
    at_ms: u64,
}

type Scan = fn() -> Vec<(String, IpAddr)>;

pub(crate) struct Browser {
    home: PathBuf,
    settings: Mutex<Settings>,
    changed: AtomicBool,
    /// Rung beside `changed`, so the supervisor's wait ends at once (send, receive; both non-blocking).
    bell: Option<(UnixStream, UnixStream)>,
    devices: Mutex<Devices>,
    pairs: Mutex<Pairs>,
    /// Open browser connections: device id, local address, a clone to shut down on revoke or unbind.
    live: Mutex<Vec<(usize, String, SocketAddr, TcpStream)>>,
    bound: Mutex<Bound>,
    notices: Mutex<(u64, VecDeque<Notice>)>,
    authed: AtomicUsize,
    handshakes: AtomicUsize,
    running: AtomicBool,
    scan: Mutex<Scan>,
    #[cfg(test)]
    pub(crate) wakes: AtomicUsize, // supervisor passes
}

/// One per core home; the window listener and the browser listener of a core share it.
pub(crate) fn of(home: &Path) -> Arc<Browser> {
    static ALL: OnceLock<Mutex<Vec<Arc<Browser>>>> = OnceLock::new();
    let mut all = ALL
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(b) = all.iter().find(|b| b.home == home) {
        return b.clone();
    }
    let settings = std::fs::read(home.join("browser-access.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let b = Arc::new(Browser {
        home: home.to_path_buf(),
        settings: Mutex::new(settings),
        changed: AtomicBool::new(true),
        bell: UnixStream::pair().ok().filter(|(tx, rx)| {
            tx.set_nonblocking(true).is_ok() && rx.set_nonblocking(true).is_ok()
        }),
        devices: Mutex::new(Devices::open(home)),
        pairs: Mutex::default(),
        live: Mutex::default(),
        bound: Mutex::default(),
        notices: Mutex::default(),
        authed: AtomicUsize::new(0),
        handshakes: AtomicUsize::new(0),
        running: AtomicBool::new(false),
        scan: Mutex::new(interfaces),
        #[cfg(test)]
        wakes: AtomicUsize::new(0),
    });
    all.push(b.clone());
    b
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts the supervisor once per running core: it binds and unbinds as the setting and the addresses change.
pub(crate) fn start(home: &Path, registry: Arc<Mutex<Sessions>>, stopping: Arc<AtomicBool>) {
    let b = of(home);
    if b.running.swap(true, Ordering::SeqCst) {
        return;
    }
    b.changed.store(true, Ordering::SeqCst);
    thread::spawn(move || {
        supervise(&b, &registry, &stopping);
        b.running.store(false, Ordering::SeqCst);
    });
}

/// Loopback, plus each Tailscale address on a `utun` interface; never a wildcard, a LAN address or another range.
pub(crate) fn candidates(interfaces: &[(String, IpAddr)]) -> Vec<IpAddr> {
    let mut out = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    for (name, ip) in interfaces {
        if name.starts_with("utun") && tailscale(*ip) && !out.contains(ip) {
            out.push(*ip);
        }
    }
    out
}

/// `100.64.0.0/10` and `fd7a:115c:a1e0::/48`.
fn tailscale(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// The second check after accept: loopback or a Tailscale range, else closed before any byte is read.
pub(crate) fn peer_allowed(ip: IpAddr) -> bool {
    let ip = unmapped(ip);
    ip.is_loopback() || tailscale(ip)
}

/// This Mac's interface addresses (`getifaddrs`).
fn interfaces() -> Vec<(String, IpAddr)> {
    let mut out = vec![];
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return out;
    }
    let mut cur = head;
    while !cur.is_null() {
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        if ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        let name = unsafe { std::ffi::CStr::from_ptr(ifa.ifa_name) }
            .to_string_lossy()
            .into_owned();
        let ip = match i32::from(unsafe { (*ifa.ifa_addr).sa_family }) {
            libc::AF_INET => {
                let sin = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
                IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)))
            }
            libc::AF_INET6 => {
                let sin6 = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in6) };
                IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr))
            }
            _ => continue,
        };
        out.push((name, ip));
    }
    unsafe { libc::freeifaddrs(head) };
    out
}

fn supervise(b: &Arc<Browser>, registry: &Arc<Mutex<Sessions>>, stopping: &Arc<AtomicBool>) {
    let mut listeners: Vec<TcpListener> = vec![];
    let mut scanned = Instant::now();
    while !stopping.load(Ordering::SeqCst) {
        #[cfg(test)]
        b.wakes.fetch_add(1, Ordering::SeqCst);
        if let Some((_, rx)) = &b.bell {
            while matches!((&*rx).read(&mut [0u8; 64]), Ok(n) if n > 0) {} // before `changed`, so no ring is lost
        }
        if b.changed.swap(false, Ordering::SeqCst) || scanned.elapsed() >= RESCAN {
            scanned = Instant::now();
            rebind(b, &mut listeners);
            b.close_expired(crate::queue::now_ms());
        }
        let mut idle = true;
        let mut failed = false;
        for l in &listeners {
            loop {
                match l.accept() {
                    Ok((stream, peer)) => {
                        idle = false;
                        let (b, registry, stopping) =
                            (b.clone(), registry.clone(), stopping.clone());
                        thread::spawn(move || connection(&b, stream, peer, &registry, &stopping));
                    }
                    Err(e) => {
                        failed |= e.kind() != std::io::ErrorKind::WouldBlock;
                        break;
                    }
                }
            }
        }
        // S9 r2: a failed accept (EMFILE with a connect pending) leaves the listener readable; poll would return at
        // once and spin, so it waits a fixed 10 ms as before.
        if failed {
            thread::sleep(Duration::from_millis(10));
        } else if idle {
            // S9: wait on the bound listeners (none while browser access is off) and the bell, not a 10 ms retry.
            // RESCAN and expiry run on their own longer clocks.
            let mut fds: Vec<_> = listeners
                .iter()
                .map(std::os::fd::AsRawFd::as_raw_fd)
                .collect();
            fds.extend(
                b.bell
                    .as_ref()
                    .map(|(_, rx)| std::os::fd::AsRawFd::as_raw_fd(rx)),
            );
            let wait = if b.bell.is_some() {
                IDLE_WAIT
            } else {
                BELL_LESS_WAIT
            };
            crate::server::wait_readable(&fds, wait);
        }
    }
    listeners.clear();
    *lock(&b.bound) = Bound::default();
    b.close_where(|_, _| true);
}

fn rebind(b: &Browser, listeners: &mut Vec<TcpListener>) {
    let settings = lock(&b.settings).clone();
    let found = (lock(&b.scan))();
    let want = if settings.enabled {
        candidates(&found)
    } else {
        vec![]
    };
    let port_ok = |l: &TcpListener| {
        l.local_addr().is_ok_and(|a| {
            want.contains(&a.ip()) && (settings.port == 0 || a.port() == settings.port)
        })
    };
    listeners.retain(port_ok);
    let mut problem = None;
    for ip in &want {
        if listeners
            .iter()
            .any(|l| l.local_addr().is_ok_and(|a| a.ip() == *ip))
        {
            continue;
        }
        match TcpListener::bind((*ip, settings.port)).and_then(|l| {
            l.set_nonblocking(true)?;
            Ok(l)
        }) {
            Ok(l) => listeners.push(l),
            // A taken port never falls back to another one: nothing is bound and the problem is shown.
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                problem = Some(format!(
                    "port {} is in use by another program",
                    settings.port
                ));
                listeners.clear();
                break;
            }
            Err(e) => {
                eprintln!("browser access: {ip} not bound: {e}");
                if ip.is_loopback() {
                    problem = Some(format!("could not listen on {ip}: {e}"));
                }
            }
        }
    }
    let addresses: Vec<SocketAddr> = listeners
        .iter()
        .filter_map(|l| l.local_addr().ok())
        .collect();
    // An address that went away (or access turned off) closes its connections.
    b.close_where(|_, local| !addresses.iter().any(|a| a.ip() == local.ip()));
    *lock(&b.bound) = Bound {
        tailscale: found
            .iter()
            .any(|(n, ip)| n.starts_with("utun") && tailscale(*ip)),
        addresses,
        problem,
    };
}

impl Browser {
    /// Registers a live connection, then checks its device again: a revoke or expiry that landed between the token
    /// check and this registration closes it here instead of leaving it open.
    fn track(&self, seq: usize, device: &str, local: SocketAddr, stream: TcpStream) -> bool {
        lock(&self.live).push((seq, device.to_string(), local, stream));
        let now = crate::queue::now_ms();
        if lock(&self.devices).active(device, now) {
            return true;
        }
        self.close_where(|d, _| d == device);
        false
    }

    /// Closes the open connections of devices unused for 30 days (the supervisor runs it on each rescan).
    fn close_expired(&self, now_ms: u64) {
        let devices = lock(&self.devices);
        self.close_where(|d, _| !devices.active(d, now_ms));
    }

    fn close_where(&self, close: impl Fn(&str, &SocketAddr) -> bool) {
        lock(&self.live).retain(|(_, device, local, stream)| {
            let gone = close(device, local);
            if gone {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            !gone
        });
    }

    pub(crate) fn status(&self) -> Status {
        let settings = lock(&self.settings).clone();
        let bound = lock(&self.bound);
        Status {
            enabled: settings.enabled,
            port: settings.port,
            addresses: bound.addresses.iter().map(SocketAddr::to_string).collect(),
            tailscale: bound.tailscale,
            problem: bound.problem.clone(),
            devices: lock(&self.devices)
                .list
                .iter()
                .map(|d| DeviceRow {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    last_used_ms: d.last_used_ms,
                    peer: d.peer.clone(),
                })
                .collect(),
        }
    }

    /// Settings > Browser access and the pairing sheet; reached only from the window frame loop.
    pub(crate) fn window_op(&self, op: Op) -> crate::api::Response {
        match op {
            Op::Status => {}
            Op::Set { enabled, port } => {
                let mut settings = lock(&self.settings).clone();
                settings.enabled = enabled;
                if let Some(port) = port {
                    if port != 0 && port < 1024 {
                        return Err("pick a port from 1024 to 65535".into());
                    }
                    settings.port = port;
                }
                store::atomic_write(
                    &self.home.join("browser-access.json"),
                    serde_json::to_string(&settings)
                        .map_err(|e| e.to_string())?
                        .as_bytes(),
                )?;
                *lock(&self.settings) = settings;
                self.changed.store(true, Ordering::SeqCst);
                if let Some((tx, _)) = &self.bell {
                    let _ = (&*tx).write(&[1]); // a full bell is already rung
                }
                // The supervisor rebinds at once; answer with what it bound.
                let until = Instant::now() + Duration::from_secs(2);
                while self.changed.load(Ordering::SeqCst) && Instant::now() < until {
                    thread::sleep(Duration::from_millis(5));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Op::Answer { id, allow } => {
                let mut devices = lock(&self.devices);
                lock(&self.pairs).answer(
                    &id,
                    allow,
                    &mut devices,
                    Instant::now(),
                    crate::queue::now_ms(),
                )?;
            }
            Op::Revoke { device } => {
                let gone = lock(&self.devices).revoke(device.as_deref())?;
                self.close_where(|d, _| gone.iter().any(|g| g == d));
            }
        }
        Ok(crate::api::Reply::BrowserAccess {
            status: self.status(),
        })
    }

    /// The window's `browser` event: pending pairings for the sheet and what browsers did (needs 80).
    pub(crate) fn event(&self) -> serde_json::Value {
        let mut pairs = lock(&self.pairs);
        pairs.expire_now();
        let notices = lock(&self.notices);
        serde_json::json!({
            "event": "browser",
            "pending": pairs.pending,
            "notices": notices.1,
        })
    }

    fn notice(&self, device: &Device, action: &'static str) {
        eprintln!("browser {action} from device {}", device.id);
        let mut n = lock(&self.notices);
        n.0 += 1;
        let seq = n.0;
        n.1.push_back(Notice {
            seq,
            device: device.id.clone(),
            name: device.name.clone(),
            action,
            at_ms: crate::queue::now_ms(),
        });
        if n.1.len() > MAX_NOTICES {
            n.1.pop_front();
        }
    }
}

/// A browser connection's frame gate, checked before dispatch with the window loop's own parse order.
/// `Ok(Some(action))` is a change the Mac window is told about.
pub(crate) fn allowed(text: &str) -> Result<Option<&'static str>, String> {
    let refused = || Err("not allowed from the browser".to_string());
    if serde_json::from_str::<AckFrame>(text).is_ok()
        || serde_json::from_str::<ChatFrame>(text).is_ok()
    {
        return Ok(None);
    }
    if serde_json::from_str::<ThemeFrame>(text).is_ok()
        || serde_json::from_str::<LibsFrame>(text).is_ok()
        || serde_json::from_str::<SearchFrame>(text).is_ok()
        || serde_json::from_str::<EditFrame>(text).is_ok()
        || serde_json::from_str::<super::BrowserFrame>(text).is_ok()
    {
        return refused();
    }
    // Deny by default: a frame the loop would drop as malformed is refused here first.
    let Ok(frame) = serde_json::from_str::<Frame>(text) else {
        return refused();
    };
    if frame.layout_save.is_some() || frame.layout_done.is_some() || frame.layout_focus {
        return refused();
    }
    // One purpose per frame: the window loop's dispatch order then cannot run a part this gate did not check.
    match (&frame.request, &frame.watch, &frame.unwatch) {
        // Ticket 362: Shift+Tab is `ESC [ Z` and can reach Skip permissions. A lone Esc (Stop) still passes.
        (Some(Request::SendText { text, .. }), None, None)
            if text != "\x1b" && text.contains(['\x1b', '\u{9b}']) =>
        {
            refused()
        }
        // Ticket 1059: the refresh types /context into the session; it is the owner window's alone, the read stays Watch.
        (Some(Request::SessionContext { refresh: true, .. }), None, None) => refused(),
        (None, Some(_), None) | (None, None, Some(_)) => Ok(None),
        (Some(request), None, None) if request_allowed(request) => Ok(match request {
            Request::Answer { .. } => Some("answer"),
            Request::SendText { .. } => Some("reply"),
            _ => None,
        }),
        _ => refused(),
    }
}

/// Section 5: watch and answer. Exhaustive on purpose: a new request fails to compile until it is classified here.
pub(crate) fn request_allowed(request: &Request) -> bool {
    use Request::*;
    match request {
        // Watch.
        List
        | Snapshot
        | Read { .. }
        | TreeGet
        | Subagents { .. }
        | SessionContext { .. }
        | PrChip { .. }
        | BoardSnapshot
        | DiffList { .. }
        | DiffFile { .. }
        | UserCommands { .. }
        | AgentModels // ticket 1100: the model list the window sees, no paths
        | ChatPage { .. } => true,
        // Answer.
        Answer { .. } | SendText { .. } => true,
        // Refused in the first cut; starting sessions is a later ticket that widens this on purpose.
        RemoteService { .. }
        | Remote { .. }
        | AddMachine { .. }
        | ForgetMachine { .. }
        | MachineDetails { .. }
        | MachineAliases
        | MachineProbe { .. }
        | MachineShare // ticket 1050
        | MachineTrust { .. }
        | MachineStatus { .. }
        | Forwarded { .. }
        | HandoffPreview { .. }
        | HandoffSend { .. }
        | PrLive { .. }
        | PrLiveSet { .. }
        | PrWatch { .. }
        | PrFront { .. }
        | PrView { .. } // V2.5-8/9: owner items stay on the Mac
        | PrList
        | PrMerge { .. }
        | PrBranch { .. } // ticket 373: runs the user's gh on the Mac
        | GitPush { .. } // pushes as the user: the Mac window's confirm alone
        | PrDraft { .. }
        | PrCreate { .. } // pushes and creates a PR as the user: the Mac window's form alone
        | PrWrite { .. } // runs the agent CLI on the session's account
        | PrWriteCancel { .. }
        | LibsResolve { .. }
        | LibsEntry { .. }
        | TokenCreate { .. }
        | TokenList
        | TokenRevoke { .. }
        | AccountList
        | AccountCheck { .. }
        | AccountAdd { .. }
        | AccountUsage { .. }
        | UsageDetail { .. } // v4 Usage page: owner window only, as AccountUsage
        | CodexResetRead { .. } // needs 225: owner window and owner socket only
        | CodexResetUse { .. }
        | CodexResetLog
        | AccountRemove { .. }
        | AccountRename { .. } // ticket 358: owner and window only
        | GitProviders { .. } // v25f: owner and window only
        | AccountSignIn { .. } // ticket 178 finding 20: owner and window only
        | AccountSignInCode { .. }
        | AccountSignInCancel { .. }
        | AccountSignInState { .. }
        | FirstRun
        | ProjectCreate { .. }
        | ProjectClone { .. }
        | ProjectCloneState { .. }
        | ProjectCloneCancel { .. }
        | OpenInEditor { .. }
        | EditorApps
        | ProjectIconSet { .. }
        | ProjectIconGet { .. }
        | ProjectFolders // ticket 1040: the owner's folders
        | ProjectLocate { .. }
        | ProblemFix { .. }
        | LimitResume { .. } // ticket 372: owner and window only
        | Typing { .. } // owner and window only
        | SendNow { .. }
        | SendLater { .. }
        | SendAttach { .. }
        | SendDetach { .. }
        | Direct { .. }
        | DraftTaken { .. }
        | DraftPutBack { .. }
        | TakeBack { .. }
        | TeamOpen { .. } // ticket 990: a lead's session only
        | Task { .. } // ticket 990 slice g: the owner's window and sessions, never a page
        | Note { .. } // ticket 990 slice h
        | Role { .. } // ticket 990 slice i
        | Worktree { .. }
        | AgentSend { .. }
        | AgentPrompt { .. }
        | SteerNow { .. }
        | AgentKeys { .. }
        | AgentRead { .. }
        | AgentGet { .. }
        | Events { .. } // ticket 573
        | AgentList { .. } // V2.5-30: like `agent get`, an agent's command
        | RoomSend { .. } // ticket 571: the room view is a later slice
        | RoomReply { .. }
        | RoomCheck { .. }
        | RoomThread { .. }
        | RoomRead { .. }
        | RoomPin { .. }
        | RoomAnswer { .. }
        | CancelSend { .. }
        | BoardSeen { .. }
        | BoardPut { .. }
        | BoardDelete { .. }
        | BoardMove { .. }
        | BoardResolve { .. }
        | BoardColumnsPut { .. }
        | BoardSettingsPut { .. } // V2.5-38: classified as BoardColumnsPut
        | BoardTaskPut { .. } // V2.5-35: board writes stay off the browser, like BoardPut
        | BoardUndo { .. }
        | BoardDone { .. }
        | BoardAdd { .. }
        | BoardSelf
        | TreeEdit { .. }
        | Start { .. }
        | StartAnyway { .. }
        | StartOrWait { .. } // the starts waiting for memory are the owner's
        | MemoryWaitList
        | MemoryWaitGo { .. }
        | MemoryWaitCancel { .. }
        | SendKeys { .. }
        | Resize { .. }
        | Close { .. }
        | CloseUndo { .. }
        | CloseIdle { .. }
        | Label { .. }
        | Hook { .. }
        | QueueConnect
        | Stop
        | Exit
        | ExitIfIdle { .. }
        | ExitBlockers { .. }
        | WindowAuth
        // V2.5-20: agent browser verbs are session-token only; the app's job poll is the owner's.
        | Browser { .. }
        | BrowserNext
        | BrowserDone { .. }
        | BoardSourceStatus { .. }
        | BoardSourceGrant { .. }
        | BoardSourceMove { .. }
        | FilesList { .. }
        | FileRead { .. }
        | FileWrite { .. } // ticket 820: the owner window's alone
        | FilesSearch { .. }
        | AcpAgentStatus { .. }
        | AcpAgentGrant { .. }
        | AcpAgents
        | AcpAgentCheck { .. }
        | AcpAgentAdd { .. }
        | AcpAgentLogin { .. }
        | AcpAgentSignIn { .. }
        | AcpAgentSignInState { .. }
        | AcpAgentSignInCancel { .. }
        | AcpAgentSignOut { .. }
        | AcpAgentTry { .. }
        | AgentUpdateStart { .. } // ticket 358: owner and window only
        | AgentUpdateCancel { .. }
        | AgentUpdateState
        | ExtensionsList // ticket 276: the owner window's alone
        | ExtensionsMcpAdd { .. }
        | ExtensionsMcpRemove { .. }
        | ExtensionsItemFiles { .. }
        | ExtensionsItemRead { .. }
        | ExtensionsItemSave { .. }
        | ExtensionsSkillNew { .. }
        | ExtensionsItemRemove { .. }
        | ApprovalStatus { .. }
        | ApprovalGrant { .. }
        | SetupStatus { .. } // ticket 259: a setup approval is the Mac owner's
        | SetupGrant { .. }
        | AgentCommandStatus { .. } // ticket 358
        | AgentCommandCheck { .. }
        | AgentCommandGrant { .. }
        | AgentCommandReset { .. }
        | QuitSettings { .. }
        | PermissionAnswers { .. }
        | Layout { .. }
        | WidgetList
        | WidgetRun { .. }
        | WidgetAct { .. }
        | WidgetPage { .. }
        | Plugin { .. }
        | Trigger { .. }
        | SwitchModel { .. }
        | SetMode { .. } // CHAT-MODELIST: owner window only
        | AgentPermissionGet // ticket 362: the owner's setting
        | AgentPermissionSet { .. }
        | ImagePut { .. }
        // V2.5-11: a timer that starts agent work is the owner's on the Mac.
        | ScheduleList
        | ScheduleAdd { .. }
        | ScheduleRemove { .. }
        | ScheduleRunNow { .. } // ticket 993
        | SchedulePause { .. }
        | SchedulePropose { .. }
        | ScheduleChange { .. }
        | BotOffer { .. } // a bot's seat only
        | OutboxStage { .. } // ticket 1002
        | OutboxSpend { .. }
        | SessionTidy { .. } => false, // ticket 1113: local lead CLI only
    }
}

/// A browser's view of one connection: who it is and the Browser to tell the Mac window through.
pub(crate) struct Role {
    pub device: Device,
    pub browser: Arc<Browser>,
}
impl Role {
    /// The gate in front of dispatch; `Err` is the refusal the loop sends back.
    pub(crate) fn check(&self, text: &str, registry: &Mutex<Sessions>) -> Result<(), String> {
        let Some(action) = allowed(text)? else {
            return Ok(());
        };
        // C2: an owner item (turning on permission answers, a widget or source approval) is a grant, so it is
        // answered on the Mac only; a browser answers what agents asked.
        if let Ok(Frame {
            request: Some(Request::Answer { item, .. }),
            ..
        }) = serde_json::from_str::<Frame>(text)
            && lock(registry).queue.owner_decision(&item).is_some()
        {
            return Err("answer this on the Mac".into());
        }
        self.browser.notice(&self.device, action);
        Ok(())
    }
}

struct Head {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    len: usize,
}
impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        let mut found = self.headers.iter().filter(|(n, _)| n == name);
        let first = found.next()?;
        // A repeated Host or Origin is refused rather than guessed.
        found.next().is_none().then_some(first.1.as_str())
    }
}

/// Reads the request head without consuming it, so `/ws` hands the untouched bytes to the WebSocket handshake.
fn peek_head(stream: &TcpStream) -> Option<Head> {
    let until = Instant::now() + super::HANDSHAKE_DEADLINE;
    let mut buf = vec![0u8; MAX_HEAD];
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        stream.set_read_timeout(Some(left)).ok()?;
        let n = stream.peek(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            return parse_head(&buf[..end], end + 4);
        }
        if n == MAX_HEAD {
            return None;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn parse_head(bytes: &[u8], len: usize) -> Option<Head> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers = lines
        .map(|l| {
            let (n, v) = l.split_once(':')?;
            Some((n.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Head {
        method,
        path,
        headers,
        len,
    })
}

/// W3, W4: the bound IP literal of the accepting socket, or `localhost` on loopback. No other name (MagicDNS,
/// `*.ts.net` behind `tailscale serve`, a rebinding name) passes.
pub(crate) fn host_allowed(host: &str, local: SocketAddr) -> bool {
    let port = local.port();
    let literal = match local.ip() {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    };
    host == literal || (local.ip().is_loopback() && host == format!("localhost:{port}"))
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8], extra: &[(&str, &str)]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nContent-Security-Policy: {CSP}\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        body.len()
    );
    for (n, v) in extra {
        head.push_str(&format!("{n}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn text(stream: &mut TcpStream, status: &str, body: &str) {
    respond(
        stream,
        status,
        "text/plain; charset=utf-8",
        body.as_bytes(),
        &[],
    );
}

fn json(stream: &mut TcpStream, status: &str, value: serde_json::Value) {
    respond(
        stream,
        status,
        "application/json",
        value.to_string().as_bytes(),
        &[("Cache-Control", "no-store")],
    );
}

/// W2: only the embedded bundle, matched exactly; no file path, no decoding, no listing.
pub(crate) fn asset(path: &str) -> Option<(&'static str, std::borrow::Cow<'static, [u8]>)> {
    let path = path.split('?').next().unwrap_or("");
    let path = if path == "/" { "/index.html" } else { path };
    let (_, ctype, bytes) = ASSETS.iter().find(|(p, _, _)| *p == path)?;
    if path == "/index.html" {
        let html =
            String::from_utf8_lossy(bytes).replacen("<head>", &format!("<head>{ROLE_META}"), 1);
        return Some((ctype, html.into_bytes().into()));
    }
    Some((ctype, (*bytes).into()))
}

struct Count<'a>(&'a AtomicUsize);
impl Drop for Count<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn connection(
    b: &Arc<Browser>,
    mut stream: TcpStream,
    peer: SocketAddr,
    registry: &Arc<Mutex<Sessions>>,
    stopping: &Arc<AtomicBool>,
) {
    if !peer_allowed(peer.ip()) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return;
    }
    if b.handshakes.fetch_add(1, Ordering::SeqCst) >= MAX_HANDSHAKES {
        b.handshakes.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    let handshake = Count(&b.handshakes);
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(super::WRITE_TIMEOUT));
    let Ok(local) = stream.local_addr() else {
        return;
    };
    let Some(head) = peek_head(&stream) else {
        return text(&mut stream, "400 Bad Request", "bad request");
    };
    let path = head.path.split('?').next().unwrap_or("").to_string();
    // Only `/ws` leaves the head unread, for the WebSocket handshake. A reply over unread bytes would be lost to the
    // reset that closing such a socket sends.
    let consume = |stream: &mut TcpStream| stream.read_exact(&mut vec![0u8; head.len]).is_ok();
    if (head.method != "GET" || path != "/ws") && !consume(&mut stream) {
        return;
    }
    let refuse = |stream: &mut TcpStream, why: &str| {
        if head.method == "GET" && path == "/ws" && !consume(stream) {
            return;
        }
        text(stream, "403 Forbidden", why)
    };
    let Some(host) = head.header("host").filter(|h| host_allowed(h, local)) else {
        return refuse(&mut stream, "host not allowed");
    };
    let origin_ok = head.header("origin") == Some(&format!("http://{host}"));
    match (head.method.as_str(), path.as_str()) {
        ("GET", "/ws") => {
            if !origin_ok {
                return refuse(&mut stream, "origin not allowed");
            }
            let device = std::cell::RefCell::new(None);
            #[allow(clippy::result_large_err)] // tungstenite fixes the `ErrorResponse` error type
            let check = |q: &Handshake, r: Accepted| check_ws(b, q, r, &device);
            let ws = super::handshake(stream, &check, &|| {});
            drop(handshake);
            // Some once the token passed: an authenticated slot is held until the end of this block.
            let Some(device) = device.into_inner() else {
                return;
            };
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let seq = NEXT.fetch_add(1, Ordering::SeqCst);
            // An untracked connection could not be revoked, so it is not served.
            let tracked = match ws.as_ref().map(|ws| ws.get_ref().stream.try_clone()) {
                Ok(Ok(clone)) => b.track(seq, &device.id, local, clone),
                _ => false,
            };
            let ws = if tracked {
                ws
            } else {
                Err("browser connection revoked or not tracked".to_string())
            };
            let role = Role {
                device,
                browser: b.clone(),
            };
            // Ticket 421 round 2: the place goes when this connection and its last job thread have ended.
            let lease = super::Lease::new({
                let b = b.clone();
                move || {
                    b.authed.fetch_sub(1, Ordering::SeqCst);
                }
            });
            let served =
                ws.and_then(|ws| super::serve(ws, registry, stopping, &b.home, Some(&role), lease));
            lock(&b.live).retain(|(s, ..)| *s != seq);
            if let Err(e) = served {
                eprintln!("browser connection ended: {e}");
            }
        }
        ("POST", "/pair") => {
            // A cross-site form cannot send JSON; then the exact origin.
            let json_type = head
                .header("content-type")
                .is_some_and(|t| t.split(';').next() == Some("application/json"));
            if !json_type || !origin_ok {
                return text(&mut stream, "403 Forbidden", "not allowed");
            }
            let len: usize = head
                .header("content-length")
                .and_then(|l| l.parse().ok())
                .unwrap_or(usize::MAX);
            if len > MAX_BODY {
                return text(&mut stream, "413 Payload Too Large", "too large");
            }
            let mut body = vec![0u8; len];
            if stream.read_exact(&mut body).is_err() {
                return;
            }
            #[derive(Deserialize)]
            struct Ask {
                name: String,
            }
            let Ok(ask) = serde_json::from_slice::<Ask>(&body) else {
                return text(&mut stream, "400 Bad Request", "bad request");
            };
            let peer = unmapped(peer.ip());
            match lock(&b.pairs).start(&ask.name, peer, Instant::now()) {
                Ok(r) => json(
                    &mut stream,
                    "200 OK",
                    serde_json::json!({"id": r.id, "code": r.code}),
                ),
                Err(e) => json(
                    &mut stream,
                    "429 Too Many Requests",
                    serde_json::json!({"error": e}),
                ),
            }
        }
        ("GET", p) if p.starts_with("/pair/") => {
            if head.header("origin").is_some() && !origin_ok {
                return text(&mut stream, "403 Forbidden", "origin not allowed");
            }
            let id = &p["/pair/".len()..];
            let state = if id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                lock(&b.pairs).poll(id, Instant::now())
            } else {
                Poll::Refused
            };
            let value = match state {
                Poll::Waiting => serde_json::json!({"state": "waiting"}),
                Poll::Allowed(token) => serde_json::json!({"state": "allowed", "token": token}),
                Poll::Refused => serde_json::json!({"state": "refused"}),
            };
            json(&mut stream, "200 OK", value);
        }
        ("GET", p) => match asset(p) {
            Some((ctype, bytes)) => respond(&mut stream, "200 OK", ctype, &bytes, &[]),
            None if ASSETS.is_empty() && p == "/" => text(
                &mut stream,
                "503 Service Unavailable",
                "this Nunchiro was built without its web bundle",
            ),
            None => text(&mut stream, "404 Not Found", "not found"),
        },
        _ => text(&mut stream, "404 Not Found", "not found"),
    }
}

pub(crate) fn unmapped(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    }
}

#[allow(clippy::result_large_err)]
fn check_ws(
    b: &Browser,
    req: &Handshake,
    mut resp: Accepted,
    device: &std::cell::RefCell<Option<Device>>,
) -> Result<Accepted, ErrorResponse> {
    let refuse = |status: StatusCode, why: &str| {
        let mut err = ErrorResponse::new(Some(why.to_string()));
        *err.status_mut() = status;
        err.headers_mut()
            .insert("Content-Security-Policy", HeaderValue::from_static(CSP));
        err
    };
    let offered: Vec<&str> = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .collect();
    let presented = offered
        .iter()
        .find_map(|p| p.strip_prefix(super::TOKEN_PREFIX));
    // W11: only a device token; the window token is never in the device store.
    let found = presented
        .filter(|_| offered.contains(&super::PROTOCOL))
        .and_then(|t| lock(&b.devices).check(t, crate::queue::now_ms()));
    let Some(found) = found else {
        return Err(refuse(StatusCode::UNAUTHORIZED, "missing or wrong token"));
    };
    if b.authed
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_BROWSERS).then_some(n + 1)
        })
        .is_err()
    {
        return Err(refuse(StatusCode::SERVICE_UNAVAILABLE, "too many browsers"));
    }
    *device.borrow_mut() = Some(found);
    resp.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(super::PROTOCOL),
    );
    resp.headers_mut()
        .insert("Content-Security-Policy", HeaderValue::from_static(CSP));
    Ok(resp)
}

#[cfg(test)]
pub(crate) fn set_scan(home: &Path, scan: Scan) {
    *lock(&of(home).scan) = scan;
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
