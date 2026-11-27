//! Browse online (V1A-47): the iTerm2-Color-Schemes index and single Ghostty theme files, fetched by the core at the
//! commit the built-in catalog is pinned to, validated here and cached. The window gets parsed data only: names with
//! their licence and source, and a theme as `#rrggbb` colours; raw fetched text never reaches the webview.
//!
//! The core's first outbound network path. `Client` is the shared shape for later callers: one fixed origin per
//! caller, HTTPS only, no redirects, a byte cap and a deadline, `/usr/bin/curl` with a fixed argument vector (no
//! shell; the system trust store; no TLS crate in the core).
use crate::store;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

/// The only production origin. Moving `PIN` is a code change reviewed like the catalog update: it must equal the
/// commit in web/src/themes/catalog/catalog.gen.ts (pinned by a test).
pub const ORIGIN: &str = "https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/";
pub const PIN: &str = "04a98db045eb5d71c2247ca6c050ab97290d081c";
pub const INDEX_CAP: usize = 512 * 1024;
/// web/src/themes/ghostty.ts `FILE_CAP`.
pub const THEME_CAP: usize = 64 * 1024;
const LINE_CAP: usize = 1024;
const CONNECT_SECS: &str = "5";
const TOTAL: Duration = Duration::from_secs(15);
/// Fetches in flight across all windows; a window cannot start hundreds of downloads.
const MAX_IN_FLIGHT: usize = 4;
const INDEX_FILE: &str = "licenses.yml";
const CURL: &str = "/usr/bin/curl";
/// `Client::get`'s errors for its byte cap and deadline; v2-10c's library cache maps them to its own text.
pub const TOO_LARGE: &str = "the file is too large";
pub const TIMED_OUT: &str = "the request timed out";

/// A window op, sent as `{"id":n,"request":{"op":"theme_index"}}` or `{"op":"theme_file","name":".."}`. It is not an
/// `api::Request`: the owner socket and the CLI cannot express it (window only).
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    ThemeIndex,
    ThemeFile { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "ThemesOnlineEntry"))]
pub struct Entry {
    pub name: String,
    /// SPDX id as published, `unknown` or `nonfree` included.
    pub license: String,
    pub source: String,
}

/// web/src/themes/ghostty.ts `ThemeColors`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Colors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_text: String,
    pub selection_background: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<String>,
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Theme {
    pub name: String,
    pub license: String,
    /// The pinned raw URL it came from.
    pub source: String,
    pub colors: Colors,
}

/// One fixed origin; HTTPS only, except a loopback `http://127.0.0.1:<port>/` origin that only tests construct
/// (debug builds only; never reachable from config, env or an op).
pub struct Client {
    origin: String,
    total: Duration,
}
impl Client {
    pub fn new(origin: &str, total: Duration) -> Result<Self, String> {
        if !(origin.starts_with("https://") || loopback(origin)) {
            return Err("only an https origin is allowed".into());
        }
        Ok(Self {
            origin: origin.into(),
            total,
        })
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }
    /// The body of a 200 answer at most `cap` bytes long. Any other status (3xx included, never followed), a larger
    /// body, a connect failure or the deadline is an error. `path` must already be percent-encoded.
    pub fn get(&self, path: &str, cap: usize) -> Result<Vec<u8>, String> {
        let proto = if self.origin.starts_with("https://") {
            "=https"
        } else {
            "=http"
        };
        let mut child = crate::process::command(CURL)
            // `-q` first: no ~/.curlrc can add options.
            .arg("-q")
            .args([
                "--proto",
                proto,
                "--proto-redir",
                "=https",
                "--max-redirs",
                "0",
            ])
            .args(["--fail", "-sS", "--connect-timeout", CONNECT_SECS])
            .arg("--max-time")
            .arg(format!("{:.3}", self.total.as_secs_f64()))
            .arg("--max-filesize")
            .arg(cap.to_string())
            .args(["--write-out", "%{stderr}\nstatus=%{http_code}\n"])
            .arg(self.url(path))
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run curl: {e}"))?;
        let mut guard = Reap(Some(child.id()));
        let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut body = vec![];
            let r = (&mut out).take(cap as u64 + 1).read_to_end(&mut body);
            let _ = tx.send(r.map(|_| body));
        });
        let (etx, erx) = mpsc::channel();
        thread::spawn(move || {
            let mut s = String::new();
            let _ = (&mut err).take(4096).read_to_string(&mut s);
            let _ = etx.send(s);
        });
        // curl's own --max-time normally ends it first; this deadline covers a curl that does not.
        let body = rx.recv_timeout(self.total + Duration::from_secs(2));
        let body = match body {
            Ok(Ok(b)) if b.len() <= cap => b,
            Ok(Ok(_)) => {
                guard.kill();
                let _ = child.wait();
                return Err(TOO_LARGE.into());
            }
            Ok(Err(e)) => {
                guard.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
            Err(_) => {
                guard.kill();
                let _ = child.wait();
                return Err(TIMED_OUT.into());
            }
        };
        let exit = child.wait().map_err(|e| e.to_string())?;
        guard.0 = None;
        // Bounded: a pipe end leaked into another child (std sets CLOEXEC after pipe(), so a concurrent spawn can
        // inherit it) would otherwise hold this read open for as long as that child lives.
        let stderr = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        let status = stderr
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix("status="))
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        match exit.code() {
            Some(0) if status == 200 => Ok(body),
            Some(28) => Err(TIMED_OUT.into()),
            Some(63) => Err(TOO_LARGE.into()),
            _ if status != 0 && status != 200 => {
                Err(format!("theme server answered HTTP {status}"))
            }
            Some(code) => Err(format!("the request failed (curl exit {code})")),
            None => Err("the request was stopped".into()),
        }
    }
}
fn loopback(origin: &str) -> bool {
    cfg!(debug_assertions)
        && origin
            .strip_prefix("http://127.0.0.1:")
            .and_then(|r| r.strip_suffix('/'))
            .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}
/// Kills the child on every early return, so no curl outlives its request.
struct Reap(Option<u32>);
impl Reap {
    fn kill(&mut self) {
        if let Some(pid) = self.0.take() {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    }
}
impl Drop for Reap {
    fn drop(&mut self) {
        self.kill();
    }
}

pub struct Themes {
    client: Client,
    cache: PathBuf,
}
impl Themes {
    pub fn new(home: &Path) -> Self {
        Self {
            client: Client::new(&format!("{ORIGIN}{PIN}/"), TOTAL).expect("fixed https origin"),
            cache: home.join("theme-cache").join(PIN),
        }
    }
    /// Test seam: a loopback origin for the fake server, with a shorter deadline.
    pub fn with_origin(home: &Path, origin: &str, total: Duration) -> Result<Self, String> {
        if !loopback(origin) {
            return Err("a test origin must be http://127.0.0.1:<port>/".into());
        }
        Ok(Self {
            client: Client::new(origin, total)?,
            cache: home.join("theme-cache").join(PIN),
        })
    }

    pub fn index(&self) -> Result<Vec<Entry>, String> {
        self.dirs()?;
        let path = self.cache.join(INDEX_FILE);
        let cached = || read_cached(&path, INDEX_CAP).and_then(|b| parse_index(&b).ok());
        if let Some(list) = cached() {
            return Ok(list);
        }
        // v1a-38b: one index fetch per cache folder. A caller that finds one running waits for it and reads what it
        // cached, so a second theme click does not fail "already loading"; callers queued behind a failed fetch get
        // its error instead of each refetching (a wait is at most one fetch deadline).
        let fetch = INDEX_FETCH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(self.cache.clone())
            .or_default()
            .clone();
        let seen = fetch.0.load(std::sync::atomic::Ordering::SeqCst);
        // The guarded value is only the last error: a panic in a fetch must not disable fetching for good.
        let mut failed = fetch.1.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = cached() {
            return Ok(list);
        }
        if fetch.0.load(std::sync::atomic::Ordering::SeqCst) != seen
            && let Some(e) = failed.clone()
        {
            return Err(e);
        }
        let result = (|| {
            let bytes = self.client.get(INDEX_FILE, INDEX_CAP)?;
            let list = parse_index(&bytes)?;
            store::atomic_write(&path, &bytes)?;
            Ok(list)
        })();
        *failed = result.as_ref().err().cloned();
        fetch.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        result
    }

    pub fn theme(&self, name: &str) -> Result<Theme, String> {
        if !valid_name(name) {
            return Err("not a theme name".into());
        }
        let _slot = Slot::take(&self.cache, name)?;
        let entry = self
            .index()?
            .into_iter()
            .find(|e| e.name == name)
            .ok_or("that theme is not in the index")?;
        let file = format!("ghostty/{}", encode(name));
        let path = self.cache.join(cache_name(name));
        let colors = match read_cached(&path, THEME_CAP).map(|b| parse_theme(&b)) {
            Some(Ok(colors)) => colors,
            _ => {
                let bytes = self.client.get(&file, THEME_CAP)?;
                let colors = parse_theme(&bytes)?;
                store::atomic_write(&path, &bytes)?;
                colors
            }
        };
        Ok(Theme {
            name: entry.name,
            license: entry.license,
            source: self.client.url(&file),
            colors,
        })
    }
    /// `theme-cache/` and `theme-cache/<PIN>/`: private, never through a symlink.
    fn dirs(&self) -> Result<(), String> {
        store::private_dir(self.cache.parent().unwrap())?;
        store::private_dir(&self.cache)
    }
}

/// At most one fetch per theme name and `MAX_IN_FLIGHT` in all per cache folder (one per core); the index has
/// `INDEX_FETCH`.
struct Slot((PathBuf, String));
static IN_FLIGHT: Mutex<BTreeSet<(PathBuf, String)>> = Mutex::new(BTreeSet::new());
/// Per cache folder: index fetches finished, and the lock held while one runs (holding the last one's error).
type IndexFetch = Arc<(std::sync::atomic::AtomicU64, Mutex<Option<String>>)>;
static INDEX_FETCH: Mutex<BTreeMap<PathBuf, IndexFetch>> = Mutex::new(BTreeMap::new());
impl Slot {
    fn take(cache: &Path, name: &str) -> Result<Self, String> {
        let key = (cache.to_path_buf(), name.to_string());
        let mut set = IN_FLIGHT.lock().map_err(|_| "theme fetcher unavailable")?;
        if set.contains(&key) {
            return Err("already loading that theme".into());
        }
        if set.iter().filter(|(c, _)| c == cache).count() >= MAX_IN_FLIGHT {
            return Err("too many themes loading; try again".into());
        }
        set.insert(key.clone());
        Ok(Self(key))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut set) = IN_FLIGHT.lock() {
            set.remove(&self.0);
        }
    }
}

fn read_cached(path: &Path, cap: usize) -> Option<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()
        // Ticket 421 round 3: only a regular file; a FIFO would hold the job (and `INDEX_FETCH`) forever.
        .filter(|f| f.metadata().is_ok_and(|m| m.is_file()))?;
    let mut bytes = vec![];
    file.take(cap as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= cap).then_some(bytes)
}

/// The cache file of a theme: the sha256 of its name, so a name never becomes a path.
pub fn cache_name(name: &str) -> String {
    Sha256::digest(name.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A name the window may ask for: what the index can hold, and nothing that could change the path.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.contains(['/', '\\', '%'])
        && !name.contains("..")
        && !name.chars().any(char::is_control)
}

/// Percent-encodes everything but RFC 3986 unreserved characters.
fn encode(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// licenses.yml as update.py `licences()` reads it: top-level keys (quoted keys unquoted the same way), each with
/// indented `key: value` lines. Deeper-indented lines continue the previous value (a folded quoted string). Entries
/// whose name the window could not ask for are left out.
pub fn parse_index(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the theme index is not UTF-8")?;
    let bad = |n: usize| format!("the theme index is malformed at line {n}");
    let mut out: Vec<(String, Vec<(String, String)>)> = vec![];
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            let key = line
                .trim_end()
                .strip_suffix(':')
                .ok_or_else(|| bad(i + 1))?;
            let key = if let Some(k) = key.strip_prefix('\'').and_then(|k| k.strip_suffix('\'')) {
                k.replace("''", "'")
            } else if key.starts_with('"') {
                serde_json::from_str::<String>(key).map_err(|_| bad(i + 1))?
            } else {
                key.to_string()
            };
            out.push((key, vec![]));
            continue;
        }
        let fields = &mut out.last_mut().ok_or_else(|| bad(i + 1))?.1;
        let field = line
            .strip_prefix("  ")
            .filter(|l| !l.starts_with(' '))
            .and_then(|l| l.split_once(':'))
            .filter(|(k, _)| {
                !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            });
        match field {
            Some((k, v)) => fields.push((k.into(), v.trim().into())),
            None => {
                let (_, v) = fields.last_mut().ok_or_else(|| bad(i + 1))?;
                v.push(' ');
                v.push_str(line.trim());
            }
        }
    }
    let unquote = |v: &str| {
        if let Some(s) = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
            s.replace("''", "'")
        } else if let Some(s) = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            s.to_string()
        } else {
            v.to_string()
        }
    };
    let clean = |v: String, max: usize| -> String {
        v.chars().filter(|c| !c.is_control()).take(max).collect()
    };
    // Every upstream entry names its licence; an entry without one, or no entries, is not the index.
    if out.is_empty() {
        return Err("the theme index lists no themes".into());
    }
    if let Some((name, _)) = out
        .iter()
        .find(|(_, f)| !f.iter().any(|(k, _)| k == "license"))
    {
        return Err(format!("the theme index has no licence for {name:?}"));
    }
    Ok(out
        .into_iter()
        .filter(|(name, _)| valid_name(name))
        .map(|(name, fields)| {
            let get = |k: &str| fields.iter().find(|(f, _)| f == k).map(|(_, v)| unquote(v));
            Entry {
                // 100: what the window keeps on an imported theme (web/src/settings.ts).
                license: clean(
                    get("license")
                        .filter(|l| !l.is_empty())
                        .unwrap_or_else(|| "unknown".into()),
                    100,
                ),
                source: clean(get("source").unwrap_or_default(), 500),
                name,
            }
        })
        .collect())
}

fn hex(v: &str) -> Option<String> {
    (v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| v.to_ascii_lowercase())
}

/// web/src/themes/ghostty.ts `parseGhostty`, with the same defaults, but strict: fetched text with a bad colour, a
/// palette index outside 0-15, a NUL, non-UTF-8 bytes or no background/foreground is refused, not repaired.
pub fn parse_theme(bytes: &[u8]) -> Result<Colors, String> {
    let bad = |why: &str| Err(format!("not a valid theme file: {why}"));
    if bytes.len() > THEME_CAP {
        return bad("too large");
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bad("not UTF-8");
    };
    if text.contains('\0') {
        return bad("NUL byte");
    }
    const DEFAULT_PALETTE: [&str; 16] = [
        "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
        "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
    ];
    let mut palette: Vec<String> = DEFAULT_PALETTE.iter().map(|s| s.to_string()).collect();
    let mut set: [Option<String>; 6] = Default::default();
    const KEYS: [&str; 6] = [
        "background",
        "foreground",
        "cursor-color",
        "cursor-text",
        "selection-background",
        "selection-foreground",
    ];
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.chars().count() > LINE_CAP {
            continue;
        }
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some((key, value)) = t.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key == "palette" {
            let parsed = value.split_once('=').and_then(|(n, v)| {
                let n = n.trim_end();
                let v = v.trim_start();
                (n.len() <= 2 && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| n.parse::<usize>().ok())
                    .flatten()
                    .filter(|n| *n <= 15)
                    .zip(hex(v))
            });
            let Some((n, v)) = parsed else {
                return bad("palette entry");
            };
            palette[n] = v;
        } else if let Some(i) = KEYS.iter().position(|k| *k == key) {
            let Some(v) = hex(value) else {
                return bad(key);
            };
            set[i] = Some(v);
        }
    }
    let [bg, fg, cursor, cursor_text, sel_bg, sel_fg] = set;
    let (Some(background), Some(foreground)) = (bg, fg) else {
        return bad("needs background and foreground");
    };
    let selection_foreground = match (&sel_fg, &sel_bg) {
        (Some(f), _) => Some(f.clone()),
        (None, Some(_)) => None,
        (None, None) => Some(background.clone()),
    };
    Ok(Colors {
        cursor: cursor.unwrap_or_else(|| foreground.clone()),
        cursor_text: cursor_text.unwrap_or_else(|| background.clone()),
        selection_background: sel_bg.unwrap_or_else(|| foreground.clone()),
        selection_foreground,
        palette,
        background,
        foreground,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_origin_is_pinned_to_the_catalog_commit_and_https_only() {
        assert_eq!(
            ORIGIN,
            "https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/"
        );
        let catalog = include_str!("../../../web/src/themes/catalog/catalog.gen.ts");
        assert!(
            catalog.contains(&format!("export const COMMIT = \"{PIN}\";")),
            "PIN must move together with the catalog"
        );
        let t = Themes::new(Path::new("/nonexistent"));
        assert_eq!(t.client.url(""), format!("{ORIGIN}{PIN}/"));
        assert_eq!(t.client.total, Duration::from_secs(15));
        for bad in [
            "http://raw.githubusercontent.com/",
            "http://127.0.0.1.evil/",
            "ftp://x/",
        ] {
            assert!(Client::new(bad, TOTAL).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_are_percent_encoded_except_unreserved_characters() {
        assert_eq!(encode("Rose Pine+ (é)"), "Rose%20Pine%2B%20%28%C3%A9%29");
        assert_eq!(encode("a-b_c.d~e"), "a-b_c.d~e");
    }
}
