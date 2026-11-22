//! V2-13a: the core's logs under `$NUNCHIRO_HOME/logs/` (0700): `core.log` (stderr, routed here once), `panic.log`
//! and `sessions/<id>.log`, each 0600, rotated at 10 MB keeping 5 files. Every byte goes through `redact` before it
//! reaches disk. Writers are line-buffered, so a token split across two writes is redacted as one line; a line over
//! 16 KiB is cut (its trailing partial word dropped) and the rest of it discarded.
use std::{
    cell::Cell,
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

pub const ROTATE_BYTES: u64 = 10 * 1024 * 1024;
/// The live file plus `.1`..`.4`.
pub const KEEP: usize = 5;
const LINE_MAX: usize = 16 * 1024;
/// Length cap of `excerpt`, for provider errors and command output that a log line quotes.
pub const EXCERPT_MAX: usize = 2048;
/// Live tokens registered at creation, matched exactly; kind is the `[redacted:<kind>]` label.
static TOKENS: Mutex<BTreeMap<String, &'static str>> = Mutex::new(BTreeMap::new());
/// fd 2's routing, once per process however many cores it serves (tests run several in threads).
static ROUTE: Mutex<Option<Route>> = Mutex::new(None);
/// Where the panic hook writes `panic.log` while a route is up.
static PANIC_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn register(token: &str, kind: &'static str) {
    // A short value would redact ordinary text; every real token is 32+ random characters.
    if token.len() >= 16 {
        lock_tokens().insert(token.into(), kind);
    }
}
pub fn unregister(token: &str) {
    lock_tokens().remove(token);
}
fn lock_tokens() -> std::sync::MutexGuard<'static, BTreeMap<String, &'static str>> {
    TOKENS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn dir(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("logs");
    crate::store::private_dir(&dir)?;
    Ok(dir)
}

/// The holder's per-session log (V2-1a), deleted with the session by `remove_session`.
pub fn session(home: &Path, id: &str) -> Result<Writer, String> {
    if !crate::store::valid_id(id) {
        return Err("invalid session id".into());
    }
    let dir = dir(home)?.join("sessions");
    crate::store::private_dir(&dir)?;
    Writer::open(&dir, &format!("{id}.log"))
}
pub fn remove_session(home: &Path, id: &str) -> Result<(), String> {
    if !crate::store::valid_id(id) {
        return Err("invalid session id".into());
    }
    let base = home.join("logs").join("sessions").join(format!("{id}.log"));
    let files = std::iter::once(base.clone())
        .chain((1..KEEP).map(|i| numbered(&base, i)))
        .chain(std::iter::once(next_path(&base)));
    for path in files {
        match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

/// V2-13b: what `nunchiro diagnose` keeps of `core.log`: the last `TAIL_LINES` lines or `TAIL_BYTES` bytes, whichever
/// is smaller, redacted again (a hand-edited or older file may hold what the writer never saw). Read-only; a missing
/// log, a link or a non-file reads as empty. Only the last `TAIL_BYTES` of the file are read.
pub const TAIL_LINES: usize = 200;
pub const TAIL_BYTES: usize = 64 * 1024;
pub fn tail(home: &Path) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let dir = home.join("logs");
    if fs::symlink_metadata(&dir).is_ok_and(|m| !m.is_dir()) {
        return vec![];
    }
    let Ok(mut file) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("core.log"))
    else {
        return vec![];
    };
    let Ok(meta) = file.metadata() else {
        return vec![];
    };
    if !meta.is_file() {
        return vec![];
    }
    let len = meta.len();
    let from = len.saturating_sub(TAIL_BYTES as u64);
    let mut bytes = vec![];
    if file.seek(SeekFrom::Start(from)).is_err()
        || file
            .take(TAIL_BYTES as u64)
            .read_to_end(&mut bytes)
            .is_err()
    {
        return vec![];
    }
    // A cut start lands mid-line: that partial line goes.
    if from > 0 {
        bytes.drain(
            ..bytes
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |i| i + 1),
        );
    }
    let lines: Vec<&[u8]> = bytes.split(|&b| b == b'\n').collect();
    let lines = &lines[..lines.len() - usize::from(lines.last().is_some_and(|l| l.is_empty()))];
    let mut kept: Vec<Vec<u8>> = lines[lines.len().saturating_sub(TAIL_LINES)..]
        .iter()
        .map(|l| {
            let mut line = redact(&l[..word_cut(l, LINE_MAX)]);
            line.push(b'\n');
            line
        })
        .collect();
    // Redaction can lengthen a line (a short token becomes a longer marker): oldest lines go until it fits.
    let mut total: usize = kept.iter().map(Vec::len).sum();
    let mut first = 0;
    while total > TAIL_BYTES && first < kept.len() {
        total -= kept[first].len();
        first += 1;
    }
    kept.drain(..first);
    kept.concat()
}

/// Redacted, one line, at most `EXCERPT_MAX` bytes: how a log line quotes text it does not control.
pub fn excerpt(text: &str) -> String {
    let flat: Vec<u8> = text
        .bytes()
        .map(|b| if b == b'\n' || b == b'\r' { b' ' } else { b })
        .collect();
    let mut out = redact(&flat);
    if out.len() > EXCERPT_MAX {
        out.truncate(word_cut(&out, EXCERPT_MAX));
        out.extend_from_slice(b" [cut]");
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A size-rotated, owner-only log file. `write` takes any bytes; only complete lines reach disk, redacted.
pub struct Writer {
    path: PathBuf,
    file: File,
    size: u64,
    pending: Vec<u8>,
    /// The rest of a cut line is being discarded up to its newline.
    skipping: bool,
    /// A redacted copy of each line also goes here (the core's original stderr).
    mirror: Option<RawFd>,
    /// Lines lost since the file last took one, and why; noted in the file once it takes lines again.
    dropped: u64,
    error: String,
    /// A rename in the rotation chain failed: never rotate again, a rerun would shift the moved files once more.
    stuck: Option<String>,
}
impl Writer {
    pub fn open(dir: &Path, name: &str) -> Result<Self, String> {
        let path = dir.join(name);
        let file = open(&path)?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        Ok(Self {
            path,
            file,
            size,
            pending: vec![],
            skipping: false,
            mirror: None,
            dropped: 0,
            error: String::new(),
            stuck: None,
        })
    }
    pub fn write(&mut self, mut bytes: &[u8]) -> Result<(), String> {
        let mut failed = None;
        while !bytes.is_empty() {
            let newline = bytes.iter().position(|&b| b == b'\n');
            let (part, rest) = match newline {
                Some(i) => (&bytes[..i], &bytes[i + 1..]),
                None => (bytes, &[][..]),
            };
            bytes = rest;
            if self.skipping {
                self.skipping = newline.is_none();
                continue;
            }
            self.pending.extend_from_slice(part);
            if newline.is_some() || self.pending.len() > LINE_MAX {
                let line = std::mem::take(&mut self.pending);
                self.skipping = newline.is_none();
                // A failed line is lost, but the rest of the chunk still goes through line by line, so no later
                // line starts mid-token.
                if let Err(e) = self.emit(&line) {
                    failed = Some(e);
                }
            }
        }
        failed.map_or(Ok(()), Err)
    }
    /// Writes a final line without its newline.
    pub fn flush(&mut self) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let line = std::mem::take(&mut self.pending);
        self.emit(&line)
    }
    fn emit(&mut self, line: &[u8]) -> Result<(), String> {
        let mut out = if line.len() > LINE_MAX {
            let mut out = redact(&line[..word_cut(line, LINE_MAX)]);
            out.extend_from_slice(b" [cut]");
            out
        } else {
            redact(line)
        };
        out.push(b'\n');
        self.append(&out)
    }
    /// Already redacted bytes: mirror, then rotate when due and write. A line the file cannot take (rotation or
    /// write failing) is dropped and counted; the first failure of a run is said once on the mirror.
    fn append(&mut self, out: &[u8]) -> Result<(), String> {
        self.mirror(out);
        if self.dropped > 0 {
            let note = format!("[logs: {} lines dropped: {}]\n", self.dropped, self.error);
            if self.store(note.as_bytes()).is_ok() {
                self.dropped = 0;
            }
        }
        let result = self.store(out);
        if let Err(e) = &result {
            if self.dropped == 0 {
                self.mirror(
                    format!(
                        "[logs: {}: {e}; dropping lines until it recovers]\n",
                        self.path.display()
                    )
                    .as_bytes(),
                );
            }
            self.dropped += 1;
            self.error = e.clone();
        }
        result
    }
    fn mirror(&self, bytes: &[u8]) {
        if let Some(fd) = self.mirror {
            // shortcut: one write, a short write drops the tail of the mirror copy; the file copy is complete.
            unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        }
    }
    fn store(&mut self, out: &[u8]) -> Result<(), String> {
        if self.size > 0 && self.size + out.len() as u64 > ROTATE_BYTES {
            if let Some(e) = &self.stuck {
                return Err(e.clone());
            }
            self.rotate()?;
        }
        let written = self.file.write_all(out);
        // A partial write still counts toward the cap.
        self.size = self
            .file
            .metadata()
            .map_or(self.size + out.len() as u64, |m| m.len());
        written.map_err(|e| e.to_string())
    }
    /// The next file is opened first, under a side name, so a failure to open it (no fds, no space) renames nothing:
    /// the older files stay and the full one keeps its place until a later line retries. A failed rename stops
    /// rotation for good (until the core restarts); the full file then drops lines.
    fn rotate(&mut self) -> Result<(), String> {
        let next = next_path(&self.path);
        let file = open(&next)?;
        let renamed = (|| {
            for i in (1..KEEP - 1).rev() {
                rename_if_present(&numbered(&self.path, i), &numbered(&self.path, i + 1))?;
            }
            rename_if_present(&self.path, &numbered(&self.path, 1))?;
            fs::rename(&next, &self.path).map_err(|e| e.to_string())
        })();
        if let Err(e) = renamed {
            let _ = fs::remove_file(&next);
            let e = format!("rotation stopped after a failed rename: {e}");
            self.stuck = Some(e.clone());
            return Err(e);
        }
        self.file = file;
        self.size = 0;
        Ok(())
    }
}
/// The side file `rotate` opens and leaves behind when a rename fails.
fn next_path(path: &Path) -> PathBuf {
    let mut next = path.as_os_str().to_owned();
    next.push(".next");
    PathBuf::from(next)
}
fn numbered(path: &Path, i: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{i}"));
    PathBuf::from(name)
}
fn rename_if_present(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}
fn open(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok(file)
}

struct Route {
    users: usize,
    reader: thread::JoinHandle<()>,
    original: OwnedFd,
}
/// fd 2 routed through `core.log` until the last one is dropped; a panic hook writes `panic.log`. The first core to
/// start in a process owns the route (a test process may run several).
#[must_use]
pub struct Started(());
pub fn start(home: &Path) -> Result<Started, String> {
    let mut route = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(route) = route.as_mut() {
        route.users += 1;
        return Ok(Started(()));
    }
    let dir = dir(home)?;
    let mut writer = Writer::open(&dir, "core.log")?;
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // macOS has no pipe2, so both ends are open without FD_CLOEXEC until these calls. `start` runs on the core's
    // first thread before it spawns any thread or child (`nunchiro serve` calls `serve` straight from main), so no
    // child can inherit them in that window; in a test process other threads may, which only keeps a pipe open.
    for fd in [read.as_raw_fd(), write.as_raw_fd()] {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let original = unsafe { libc::fcntl(2, libc::F_DUPFD_CLOEXEC, 3) };
    if original < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let original = unsafe { OwnedFd::from_raw_fd(original) };
    // A pipe or socket (the CLI's startup pipe, then nobody reads it) must never stall the reader: a full one drops
    // the mirror copy. A terminal or file stays as it was.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(original.as_raw_fd(), &mut stat) } == 0
        && matches!(stat.st_mode & libc::S_IFMT, libc::S_IFIFO | libc::S_IFSOCK)
    {
        let flags = unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe {
                libc::fcntl(
                    original.as_raw_fd(),
                    libc::F_SETFL,
                    flags | libc::O_NONBLOCK,
                )
            } < 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    writer.mirror = Some(original.as_raw_fd());
    if unsafe { libc::dup2(write.as_raw_fd(), 2) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    drop(write);
    let reader = thread::Builder::new()
        .name(READER.into())
        .spawn(move || {
            let read = File::from(read);
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = unsafe { libc::read(read.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n < 0
                    && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                {
                    continue;
                }
                if n <= 0 {
                    break;
                }
                // A failing or panicking write drops that chunk; the reader must keep draining fd 2.
                let chunk = &buf[..n as usize];
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| writer.write(chunk)))
                    .is_err()
                {
                    writer.pending.clear();
                    writer.skipping = false;
                }
            }
            let _ = writer.flush();
        })
        .map_err(|e| {
            unsafe { libc::dup2(original.as_raw_fd(), 2) };
            e.to_string()
        })?;
    *PANIC_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            panic_line(info);
            // The previous hook writes to fd 2, so the reader redacts it into core.log. Not from the reader itself:
            // with the pipe full it would wait on its own drain.
            if thread::current().name() != Some(READER) {
                previous(info);
            }
        }));
    });
    *route = Some(Route {
        users: 1,
        reader,
        original,
    });
    Ok(Started(()))
}
const READER: &str = "logs";
impl Drop for Started {
    /// The last one puts the original stderr back and waits briefly for the reader to write what it holds. A child
    /// that kept fd 2 open keeps the pipe alive; then the reader is left to finish on its own.
    fn drop(&mut self) {
        let mut route = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let Some(r) = route.as_mut() else { return };
        r.users -= 1;
        if r.users > 0 {
            return;
        }
        let Route {
            reader, original, ..
        } = route.take().unwrap();
        *PANIC_DIR.lock().unwrap_or_else(|e| e.into_inner()) = None;
        unsafe { libc::dup2(original.as_raw_fd(), 2) };
        // The CLI that started the core closes its end once the socket answers: a later `eprintln!` (main's
        // `nunchiro: {e}`) would fail with EPIPE and panic, so a stderr nobody reads becomes /dev/null.
        let mut poll = libc::pollfd {
            fd: 2,
            events: libc::POLLOUT,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } > 0
            && poll.revents & (libc::POLLHUP | libc::POLLERR) != 0
            && let Ok(null) = OpenOptions::new().write(true).open("/dev/null")
        {
            unsafe { libc::dup2(null.as_raw_fd(), 2) };
        }
        let until = Instant::now() + Duration::from_secs(1);
        while !reader.is_finished() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        if reader.is_finished() {
            let _ = reader.join();
        } else {
            // The reader still mirrors to this fd.
            std::mem::forget(original);
        }
    }
}

fn panic_line(info: &std::panic::PanicHookInfo) {
    // Held only for an assignment in `start` and `drop`, never across code that can panic.
    let Some(dir) = PANIC_DIR.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return;
    };
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("Box<dyn Any>");
    let payload = &payload.as_bytes()[..word_cut(payload.as_bytes(), LINE_MAX)];
    let at = info.location().map_or("unknown".into(), |l| {
        format!("{}:{}:{}", l.file(), l.line(), l.column())
    });
    let thread = thread::current();
    let head = format!(
        "panic in thread '{}' at {at}: ",
        thread.name().unwrap_or("<unnamed>")
    );
    // A panic inside `redact` must not wait for the lock this thread holds: the payload is withheld. Another
    // thread's hold ends in a moment.
    let tokens = (!REDACTING.try_with(Cell::get).unwrap_or(true)).then(lock_tokens);
    // Never `redact` here: it takes the registry lock this thread may hold.
    let mut line = head.into_bytes();
    match tokens {
        Some(tokens) => line.extend(redact_with(payload, &tokens)),
        None => line.extend_from_slice(b"[redacted:busy]"),
    }
    line.push(b'\n');
    if let Ok(mut writer) = Writer::open(&dir, "panic.log") {
        let _ = writer.append(&line);
    }
}

pub fn redact(line: &[u8]) -> Vec<u8> {
    let tokens = lock_tokens();
    REDACTING.set(true);
    let out = redact_with(line, &tokens);
    REDACTING.set(false);
    out
}
/// v1a-74: `redact` for a large text (a saved scrollback): the registry is copied and released first, so hooks,
/// the queue and answers never wait on it for the whole text.
pub fn mask(text: &[u8]) -> Vec<u8> {
    let tokens = lock_tokens().clone();
    redact_with(text, &tokens)
}
thread_local! {
    /// This thread holds the registry in `redact`; stays set if redaction panics, which is what the hook needs.
    static REDACTING: Cell<bool> = const { Cell::new(false) };
}
fn redact_with(line: &[u8], tokens: &BTreeMap<String, &'static str>) -> Vec<u8> {
    let mut out = line.to_vec();
    for (token, kind) in tokens {
        out = replace_all(&out, token.as_bytes(), &marker(kind));
    }
    shapes(&keys(&out))
}
fn marker(kind: &str) -> Vec<u8> {
    format!("[redacted:{kind}]").into_bytes()
}
/// v1a-74: the marker for `value`, then each escape sequence and control byte inside it in order, so a masked value
/// never swallows a colour, a cursor move or an OSC terminator (the terminal state after it stays the same).
fn masked(out: &mut Vec<u8>, kind: &str, value: &[u8]) {
    out.extend(marker(kind));
    let mut i = 0;
    while i < value.len() {
        if value[i] == 0x1b {
            let n = escape_len(&value[i..]);
            // A CSI whose final byte is past the value is secret text, not a sequence.
            if n <= 2 || (0x40..=0x7e).contains(&value[i + n - 1]) {
                out.extend_from_slice(&value[i..i + n]);
            }
            i += n;
        } else {
            if value[i] < 0x20 || value[i] == 0x7f {
                out.push(value[i]);
            }
            i += 1;
        }
    }
}
fn replace_all(text: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with(needle) {
            out.extend_from_slice(with);
            i += needle.len();
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}
/// Key words whose value is a secret whatever its shape, matched as the end of the key (`OPENAI_API_KEY`,
/// `refresh_token`, `x-api-key`, `DB_PASSWORD`). Wider than the hook journal's whole-key list on purpose: log text
/// names keys in more ways than hook JSON does.
const SECRET_KEYS: [&[u8]; 8] = [
    b"token",
    b"api_key",
    b"apikey",
    b"api-key",
    b"password",
    b"passwd",
    b"secret",
    b"credentials",
];
/// Header-like key endings whose value runs to the end of the line (it may hold spaces), with their marker kind:
/// `Authorization`, `X-Authorization`, `HTTP_AUTHORIZATION`, `Set-Cookie`.
const HEADERS: [(&[u8], &str); 2] = [(b"authorization", "authorization"), (b"cookie", "secret")];
fn key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}
/// A secret key or header word followed by `:` or `=` (quotes and spaces allowed around it): its value, quoted or
/// up to a delimiter (a header: to the end of the line). `Bearer <word>` anywhere: the word.
fn keys(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    // Whether text[i] starts a word: a colour escape ends one (`ESC[31mpassword`).
    let mut start = true;
    while i < text.len() {
        if text[i] == 0x1b {
            let n = escape_len(&text[i..]);
            out.extend_from_slice(&text[i..i + n]);
            i += n;
            start = true;
            continue;
        }
        if start && key_byte(text[i]) {
            let end = i + text[i..].iter().take_while(|&&b| key_byte(b)).count();
            let word = text[i..end].to_ascii_lowercase();
            let header = HEADERS
                .iter()
                .find(|(h, _)| word.ends_with(h))
                .map(|(_, k)| *k);
            let kind = header.or(SECRET_KEYS
                .iter()
                .any(|k| word.ends_with(k))
                .then_some("secret"));
            if let Some(kind) = kind
                && let Some((from, to)) = value_span(text, end, header.is_some())
            {
                out.extend_from_slice(&text[i..from]);
                masked(&mut out, kind, &text[from..to]);
                i = to;
                start = false;
                continue;
            }
        }
        start = !key_byte(text[i]);
        if starts_with_ignore_case(&text[i..], b"bearer ") && (i == 0 || !word_byte(text[i - 1])) {
            let start = i + b"bearer ".len();
            let end = start
                + text[start..]
                    .iter()
                    .take_while(|&&b| !b.is_ascii_whitespace() && !matches!(b, b'"' | b'\''))
                    .count();
            if end - start >= 8 {
                out.extend_from_slice(&text[i..start]);
                masked(&mut out, "bearer", &text[start..end]);
                i = end;
                continue;
            }
        }
        out.push(text[i]);
        i += 1;
    }
    out
}
/// Where the value after a key word ending at `j` starts and stops, if a `:` or `=` follows it. Spaces, quotes and
/// colour escapes may sit around the `:` (`jq -C` output).
fn value_span(text: &[u8], mut j: usize, header: bool) -> Option<(usize, usize)> {
    let skip = |mut j: usize, quotes: bool| {
        while j < text.len() {
            match text[j] {
                0x1b => j += escape_len(&text[j..]),
                b' ' | b'\t' => j += 1,
                b'"' | b'\'' if quotes => j += 1,
                _ => break,
            }
        }
        j
    };
    j = skip(j, true);
    if !matches!(text.get(j), Some(b':' | b'=')) {
        return None;
    }
    j = skip(j + 1, false);
    let quote = text.get(j).copied().filter(|&b| b == b'"' || b == b'\'');
    if quote.is_some() {
        j += 1;
    }
    let mut end = j;
    while end < text.len() {
        let b = text[end];
        let stop = match quote {
            // An escaped quote (`\"` in JSON) is part of the value.
            Some(q) => (b == q && text[end - 1] != b'\\') || b == b'\n',
            None if header => matches!(b, b'"' | b'\'' | b'\n'),
            None => b.is_ascii_whitespace() || b",;&)]}\"'".contains(&b) || b == 0x1b,
        };
        if stop {
            break;
        }
        end += 1;
    }
    (end > j).then_some((j, end))
}
fn starts_with_ignore_case(text: &[u8], prefix: &[u8]) -> bool {
    text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}
/// The characters a key or token is made of; a run of them is one word.
fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}
/// Each word that starts like a known provider key, whole.
fn shapes(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        // A colour or cursor sequence separates words, so `ESC[31msk-ant-…` is still a key at word start.
        if text[i] == 0x1b {
            let n = escape_len(&text[i..]);
            out.extend_from_slice(&text[i..i + n]);
            i += n;
            continue;
        }
        if !word_byte(text[i]) {
            out.push(text[i]);
            i += 1;
            continue;
        }
        let end = i + text[i..].iter().take_while(|&&b| word_byte(b)).count();
        let word = &text[i..end];
        match shape(word) {
            Some(kind) => out.extend(marker(kind)),
            None => out.extend_from_slice(word),
        }
        i = end;
    }
    out
}
/// A CSI sequence (`ESC [` parameters, final byte: `k + 3` counts ESC, `[` and the final byte) whole; any other escape is its two bytes, so an OSC body (a
/// hyperlink URL) is still scanned.
fn escape_len(text: &[u8]) -> usize {
    match text.get(1) {
        Some(b'[') => text[2..]
            .iter()
            .position(|b| (0x40..=0x7e).contains(b))
            .map_or(text.len(), |k| k + 3),
        Some(_) => 2,
        None => 1,
    }
}
fn shape(word: &[u8]) -> Option<&'static str> {
    let tail =
        |prefix: &[u8], min: usize| word.starts_with(prefix) && word.len() >= prefix.len() + min;
    if tail(b"sk-ant-", 10) {
        Some("anthropic")
    } else if tail(b"sk-", 20) {
        Some("openai")
    } else if [b"ghp_", b"gho_", b"ghu_", b"ghs_", b"ghr_"]
        .iter()
        .any(|p| tail(*p, 20))
        || tail(b"github_pat_", 20)
    {
        Some("github")
    } else if [b"xoxb-", b"xoxp-", b"xoxa-", b"xoxr-", b"xoxs-"]
        .iter()
        .any(|p| tail(*p, 10))
    {
        Some("slack")
    } else if (word.starts_with(b"AKIA") || word.starts_with(b"ASIA"))
        && word.len() >= 20
        && word[4..20]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        Some("aws")
    } else if word.starts_with(b"eyJ")
        && word.split(|&b| b == b'.').filter(|p| p.len() >= 4).count() >= 3
    {
        Some("jwt")
    } else {
        None
    }
}
/// The longest prefix of at most `max` bytes that does not end inside a run of non-space bytes, so a cut never
/// writes the first part of a secret.
fn word_cut(text: &[u8], max: usize) -> usize {
    if text.len() <= max {
        return text.len();
    }
    if text[max].is_ascii_whitespace() {
        return max;
    }
    text[..max]
        .iter()
        .rposition(|b| b.is_ascii_whitespace())
        .map_or(0, |i| i + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_and_cuts() {
        let none = BTreeMap::new();
        let r = |s: &str| String::from_utf8(redact_with(s.as_bytes(), &none)).unwrap();
        assert_eq!(
            r("task-0123456789012345678901234 disk-x"),
            "task-0123456789012345678901234 disk-x"
        );
        assert_eq!(r("key=sk-0123456789abcdefghij"), "key=[redacted:openai]");
        assert_eq!(
            r("Authorization: Bearer abc def\"x"),
            "Authorization: [redacted:authorization]\"x"
        );
        assert_eq!(
            r("{\"authorization\": \"Basic Zm9v\"}"),
            "{\"authorization\": \"[redacted:authorization]\"}"
        );
        assert_eq!(
            r("use bearer abcdefgh1234 now"),
            "use bearer [redacted:bearer] now"
        );
        assert_eq!(word_cut(b"ab cdef", 5), 3);
        assert_eq!(word_cut(b"abcdef", 3), 0);
        assert_eq!(word_cut(b"abc def", 3), 3);
    }

    // v1a-74: a masked value keeps every escape and control byte inside it, in order, after its marker.
    #[test]
    fn mask_keeps_controls_inside_a_masked_value() {
        let m = |s: &[u8]| mask(s);
        assert_eq!(
            m(b"Authorization: Basic ab\x1b[32mcd\x1b[0m ef\r\n"),
            b"Authorization: [redacted:authorization]\x1b[32m\x1b[0m\r\n"
        );
        assert_eq!(
            m(b"Bearer abcdefgh\x1b[0mij"),
            b"Bearer [redacted:bearer]\x1b[0m"
        );
        // An unterminated CSI inside a value is secret text, not a sequence: none of it is kept.
        assert_eq!(
            m(b"Authorization: Basic \x1b[0123456789\n"),
            b"Authorization: [redacted:authorization]\n"
        );
        assert_eq!(
            m(b"\x1b]8;;https://x/?token=abc\x07link\x1b]8;;\x07"),
            b"\x1b]8;;https://x/?token=[redacted:secret]\x07\x1b]8;;\x07"
        );
    }
    // v1a-74: a bulk mask copies the registry and lets it go, so hooks and answers never wait on a long save.
    #[test]
    fn mask_save_releases_registry_lock() {
        let big = b"API_KEY=v sk-ant-TEST0000000000abcdef plain words\n".repeat(400_000);
        let worker = thread::spawn(move || mask(&big));
        thread::sleep(Duration::from_millis(20));
        assert!(!worker.is_finished(), "the mask ended before the probe");
        let mut free = false;
        while !free && !worker.is_finished() {
            free = TOKENS.try_lock().is_ok();
            thread::yield_now();
        }
        assert!(free, "the registry stayed locked for the whole mask");
        assert!(!worker.join().unwrap().windows(6).any(|w| w == b"abcdef"));
    }
}
