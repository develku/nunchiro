//! Ticket 276 (needs 65, 197; G16): Agent extensions. Custom items are folders under `$NUNCHIRO_HOME/extensions/`;
//! Nunchiro's own MCP servers live in `$NUNCHIRO_HOME/extensions/mcp.json`. The agents' own config (`~/.claude.json`,
//! `~/.claude/settings.json`, `~/.codex/config.toml`) is only read here, and only server names and commands leave this
//! module: env values never do (names only). Nothing is written under `~/.claude` or `~/.codex`; enabled items reach a
//! session through its launch flags alone (`launch_flags`).
//!
//! The three requests are the owner window's alone: `handle` refuses an agent, a remote machine and a widget.
//! `mcp.json` is a plain file an agent could write, so each entry `mcp_add` writes carries an HMAC seal under the
//! core's 0600 `extensions.key` (as `schedule`); a launch passes only entries whose seal verifies, inline.
//! Lift: Orca McpConfigSection.tsx `:305` read-only list (names and command, no write path), MIT License,
//! Copyright (c) 2026 Lovecast Inc.; only the shape fit, so nothing was copied verbatim.
//!
//! Ticket 452: an item's files are listed, read and (custom items only) saved from the owner's window. Every step from
//! `extensions/` down is `openat` with `O_NOFOLLOW` (`dirfd`), so a link planted in an item never sends a read or a
//! write outside it; a save is written under a temporary name and renamed into place.
use crate::api::{Reply, Request};
use crate::dirfd::{c, dir_at, entries, open_at};
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

/// The core `features` key holding the enabled item ids.
pub const ENABLED_KEY: &str = "extensions.enabled";
/// The shipped Nunchiro skill (`sessions/skill.rs`): on until the owner turns it off.
pub const DEFAULT_ID: &str = "nunchiro";
const CUSTOM: &str = "custom:";
/// Caps against a planted huge config or folder tree (same-user threat): past them the rest is left out.
const MAX_ITEMS: usize = 200;
const MAX_FILE: u64 = 1 << 20;
/// The agents' own config: the user's Claude config keeps per-project history and often passes 1 MiB.
const MAX_AGENT_FILE: u64 = 16 << 20;
const KEY_FILE: &str = "extensions.key";
/// Ticket 452: an item's listing stops at `MAX_LIST` files and paths of `MAX_DEPTH` names; one file's text at `MAX_TEXT`.
const MAX_LIST: usize = 200;
const MAX_DEPTH: usize = 6;
const MAX_TEXT: u64 = 256 << 10;
const MAX_DESCRIPTION: usize = 300;
const MAX_HOOK_LINES: usize = 32;
const SHIPPED: &str = "the Nunchiro skill is shipped with the app and is not changed here";
const NOT_OWN: &str = "the extensions folder is a link or not this user's own folder";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub source: String,
    // Ticket 452: what the item holds; left out when empty, so an older window reads the list as before.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// The hook events `hooks/hooks.json` listens to (`PreToolUse`, `Stop`, ...).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub files: u32,
    /// Ticket 455: each command `hooks/hooks.json` runs, bounded (`MAX_HOOK_LINES`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hook_lines: Vec<HookLine>,
}

/// One hook command: on `event`, for tools matching `matcher` (empty: every one), runs `command`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookLine {
    pub event: String,
    #[serde(default)]
    pub matcher: String,
    pub command: String,
}
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One file of an item, `path` relative to the item and `/` separated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
}

/// One MCP server as shown: `env` holds variable names only, never values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServer {
    pub agent: String,
    pub name: String,
    pub command: Vec<String>,
    pub env: Vec<String>,
    /// An own server whose seal does not verify: written or edited outside Nunchiro, so no launch gets it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
}

/// Who sent an extensions request; only the owner's window may.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Window,
    Agent,
    Remote,
    Widget,
}

/// The enabled ids, as stored; absent means the default alone.
pub fn enabled(stored: Option<Vec<String>>) -> Vec<String> {
    stored.unwrap_or_else(|| vec![DEFAULT_ID.to_string()])
}

fn dir(home: &Path) -> PathBuf {
    home.join("extensions")
}
fn own_file(home: &Path) -> PathBuf {
    dir(home).join("mcp.json")
}

/// A valid server name: it becomes a TOML key in `-c mcp_servers.<name>.*`, so letters, digits, `-` and `_` only.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `extensions/` as a real folder this user owns (`create`: made with `mkdir` first); absent and not `create` is fine.
/// A link is refused: one planted there would send Add's write, or a launch's `--plugin-dir`, into an agent's home.
/// shortcut: checked by path, so a same-user swap between this check and the write is not closed; upgrade to an
/// `openat`/`renameat` directory descriptor if the same-user limit (`sealed`) is ever lifted.
fn real_dir(home: &Path, create: bool) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if create {
        match std::fs::create_dir(dir(home)) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.to_string()),
            _ => {}
        }
    }
    match std::fs::symlink_metadata(dir(home)) {
        Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
        // SAFETY: geteuid has no preconditions and cannot fail.
        Ok(m) if m.is_dir() && m.uid() == unsafe { libc::geteuid() } => Ok(()),
        Ok(_) => Err(LINKED.into()),
    }
}

/// The custom folders' names in name order, at most `MAX_ITEMS`. A plain file is not an item. Names only: a launch
/// (`claude_flags`, under the session registry lock) reads no item's files.
fn custom_names(home: &Path) -> Vec<String> {
    let mut names: Vec<String> = real_dir(home, false)
        .and_then(|()| std::fs::read_dir(dir(home)).map_err(|e| e.to_string()))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| valid_name(n))
        .collect();
    names.sort();
    names.truncate(MAX_ITEMS);
    names
}

/// The shipped skill, then each custom folder (a Claude plugin folder) with what it holds.
pub fn items(home: &Path) -> Vec<Item> {
    let shipped = shipped_list();
    let mut out = vec![Item {
        id: DEFAULT_ID.into(),
        name: "Nunchiro skill".into(),
        kind: "skill".into(),
        source: "default".into(),
        description: clip(
            serde_json::from_str::<serde_json::Value>(SHIPPED_FILES[0].1)
                .ok()
                .and_then(|v| Some(v.get("description")?.as_str()?.to_string()))
                .unwrap_or_default(),
        ),
        skills: shipped
            .iter()
            .filter_map(|f| f.path.strip_prefix("skills/")?.strip_suffix("/SKILL.md"))
            .map(String::from)
            .collect(),
        hooks: vec![],
        files: shipped.len() as u32,
        hook_lines: vec![],
    }];
    let root = root(home).ok();
    for name in custom_names(home) {
        // Ticket 580: a folder with only skills reads "skill" (what New skill makes), only hooks "hook", else "plugin".
        let has = |part: &str| dir(home).join(&name).join(part).is_dir();
        let kind = match (has("skills"), has("hooks")) {
            (true, false) => "skill",
            (false, true) => "hook",
            _ => "plugin",
        };
        let folder = root
            .as_ref()
            .and_then(|r| dir_at(r, &c(OsStr::new(&name)).ok()?, false).ok());
        let (description, skills, hooks, files, hook_lines) =
            folder.map(|f| summary(&f)).unwrap_or_default();
        out.push(Item {
            id: format!("{CUSTOM}{name}"),
            name,
            kind: kind.into(),
            source: "custom".into(),
            description,
            skills,
            hooks,
            files,
            hook_lines,
        });
    }
    out
}

/// One config file as read under a cap.
enum Text {
    Absent,
    /// `mcp.json` is a link (`follow` false).
    Link,
    Unread,
    TooLarge(u64),
    Read(String),
}
/// `follow`: the agents' own configs are often dotfile links, so those are followed; Nunchiro's `mcp.json` never is.
fn read_capped(path: &Path, cap: u64, follow: bool) -> Text {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    // Non-blocking, and the type checked on the opened handle: a FIFO swapped in under the name cannot block the open.
    let nofollow = if follow { 0 } else { libc::O_NOFOLLOW };
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | nofollow)
        .open(path)
    {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Text::Absent,
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) && !follow => return Text::Link,
        Err(_) => return Text::Unread,
        Ok(f) => f,
    };
    let meta = match file.metadata() {
        Ok(m) if !m.is_file() => return Text::Unread,
        Ok(m) if m.len() > cap => return Text::TooLarge(m.len()),
        Ok(m) => m,
        Err(_) => return Text::Unread,
    };
    let mut text = String::new();
    match file.take(cap + 1).read_to_string(&mut text) {
        Ok(n) if n as u64 > cap => Text::TooLarge((n as u64).max(meta.len())),
        Ok(_) => Text::Read(text),
        Err(_) => Text::Unread,
    }
}

/// An agent config past `MAX_AGENT_FILE`: its servers are not shown, and the page says why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TooLarge {
    /// `~/`-relative, as the page shows it.
    pub file: String,
    pub bytes: u64,
}
/// The only part of a Claude config read here; serde skips the rest (per-project history) without keeping it.
#[derive(Deserialize)]
struct McpOnly {
    #[serde(rename = "mcpServers")]
    servers: Option<serde_json::Value>,
}

/// Names and argv from a JSON `mcpServers`-shaped object; env values are dropped here, keys kept.
fn from_json(agent: &str, servers: Option<&serde_json::Value>) -> Vec<McpServer> {
    let Some(map) = servers.and_then(|v| v.as_object()) else {
        return vec![];
    };
    map.iter()
        .take(MAX_ITEMS)
        .map(|(name, v)| {
            let mut command: Vec<String> = v
                .get("command")
                .and_then(|c| c.as_str())
                .map(|c| vec![c.to_string()])
                .unwrap_or_default();
            if command.is_empty() {
                // A remote server has a URL instead of a command; the URL may carry a token, so only its kind shows.
                if v.get("url").is_some() {
                    command.push("(url)".into());
                }
            }
            command.extend(
                v.get("args")
                    .and_then(|a| a.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.as_str().map(String::from)),
            );
            let env = v
                .get("env")
                .and_then(|e| e.as_object())
                .map(|e| e.keys().cloned().collect())
                .unwrap_or_default();
            McpServer {
                agent: agent.into(),
                name: name.clone(),
                command,
                env,
                changed: false,
            }
        })
        .collect()
}

/// The agents' own servers, read only, and the configs too large to read. `user_home` is the user's home (`$HOME`); a
/// test passes a temp folder.
pub fn agent_servers(user_home: &Path) -> (Vec<McpServer>, Vec<TooLarge>) {
    let mut out = vec![];
    let mut large = vec![];
    let mut read = |rel: &str| match read_capped(&user_home.join(rel), MAX_AGENT_FILE, true) {
        Text::Read(t) => Some(t),
        Text::TooLarge(bytes) => {
            large.push(TooLarge {
                file: format!("~/{rel}"),
                bytes,
            });
            None
        }
        Text::Absent | Text::Link | Text::Unread => None,
    };
    for rel in [".claude.json", ".claude/settings.json"] {
        if let Some(c) = read(rel).and_then(|t| serde_json::from_str::<McpOnly>(&t).ok()) {
            out.extend(from_json("claude", c.servers.as_ref()));
        }
    }
    if let Some(v) = read(".codex/config.toml").and_then(|t| toml::from_str::<toml::Value>(&t).ok())
        && let Some(map) = v.get("mcp_servers").and_then(|m| m.as_table())
    {
        for (name, s) in map.iter().take(MAX_ITEMS) {
            let mut command: Vec<String> = s
                .get("command")
                .and_then(|c| c.as_str())
                .map(|c| vec![c.to_string()])
                .unwrap_or_default();
            command.extend(
                s.get("args")
                    .and_then(|a| a.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.as_str().map(String::from)),
            );
            let env = s
                .get("env")
                .and_then(|e| e.as_table())
                .map(|e| e.keys().cloned().collect())
                .unwrap_or_default();
            out.push(McpServer {
                agent: "codex".into(),
                name: name.clone(),
                command,
                env,
                changed: false,
            });
        }
    }
    (out, large)
}

/// Ticket 1002 lane 1: the claude.ai connectors Claude has connected on this machine (`claudeAiMcpEverConnected` in
/// `~/.claude.json`, read as `agent_servers` reads it). Best effort for the Home seat's wildcard deny: the seat's hook
/// refuses a connector missing here.
pub(crate) fn claude_connectors(user_home: &Path) -> Vec<String> {
    let Text::Read(text) = read_capped(&user_home.join(".claude.json"), MAX_AGENT_FILE, true)
    else {
        return vec![];
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("claudeAiMcpEverConnected")?.as_array().cloned())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(String::from))
        .take(MAX_ITEMS)
        .collect()
}

const UNREAD: &str = "mcp.json could not be read; nothing was changed";
const LINKED: &str = "the extensions folder or mcp.json is a link; nothing was changed";
/// Nunchiro's own servers (`extensions/mcp.json`, Claude's `--mcp-config` shape). Absent is empty; unreadable, over
/// the cap or not that shape is an error, so Add and Remove never rewrite a file they could not read (review S3).
fn own_raw(home: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    real_dir(home, false)?;
    match read_capped(&own_file(home), MAX_FILE, false) {
        Text::Absent => Ok(Default::default()),
        Text::Read(t) => serde_json::from_str::<serde_json::Value>(&t)
            .ok()
            .and_then(|v| v.get("mcpServers")?.as_object().cloned())
            .ok_or_else(|| UNREAD.into()),
        Text::Link => Err(LINKED.into()),
        Text::Unread | Text::TooLarge(_) => Err(UNREAD.into()),
    }
}
pub fn own_servers(home: &Path) -> Vec<McpServer> {
    let raw = own_raw(home).unwrap_or_default();
    let key = crate::schedule::key(&home.join(KEY_FILE)).ok();
    let mut out = from_json("nunchiro", Some(&serde_json::Value::Object(raw.clone())));
    for s in &mut out {
        s.changed = key
            .as_deref()
            .zip(raw.get(&s.name))
            .and_then(|(k, v)| verified(k, &s.name, v))
            .is_none();
    }
    out
}

/// The seal over one own server; name, command and args all count, so a copied or edited entry fails.
fn seal(key: &[u8], name: &str, command: &str, args: &[String]) -> String {
    let msg = serde_json::to_vec(&("extensions.mcp", name, command, args)).unwrap_or_default();
    crate::schedule::hmac(key, &msg)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// `(command, args)` when the entry's seal verifies.
fn verified(key: &[u8], name: &str, v: &serde_json::Value) -> Option<(String, Vec<String>)> {
    let command = v.get("command")?.as_str()?.to_string();
    let args = v
        .get("args")?
        .as_array()?
        .iter()
        .map(|a| a.as_str().map(String::from))
        .collect::<Option<Vec<_>>>()?;
    let mac = v.get("seal")?.as_str()?;
    (valid_name(name) && crate::schedule::same(mac, &seal(key, name, &command, &args)))
        .then_some((command, args))
}
/// The own servers a launch may pass: sealed by `mcp_add` and unchanged since.
/// Same-user limit (security review MUST 1, accepted; docs/areas/settings.md): the key is a 0600 file in the same
/// user's data folder (as `schedule.key`), and every agent runs as that user, so an agent can read or replace the key,
/// forge a seal and get its command into later launches. The seal stops a hand-written or edited entry from being
/// launched silently (it shows as changed); it is not a sandbox, the same as that agent editing the user's own
/// `~/.claude.json` or shell startup files. Upgrade with the keychain (or a separate user) when the core gets one.
fn sealed(home: &Path) -> Vec<(String, String, Vec<String>)> {
    let Ok(key) = crate::schedule::key(&home.join(KEY_FILE)) else {
        return vec![];
    };
    own_raw(home)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, v)| verified(&key, &name, &v).map(|(c, a)| (name, c, a)))
        .collect()
}

/// Ticket 1002 lane 1: the names of the sealed own servers a launch passes (`claude_flags`).
pub(crate) fn sealed_names(home: &Path) -> Vec<String> {
    sealed(home).into_iter().map(|(name, _, _)| name).collect()
}

fn write_own(
    home: &Path,
    servers: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    real_dir(home, true)?;
    let body = serde_json::json!({ "mcpServers": servers });
    crate::store::atomic_write(&own_file(home), &serde_json::to_vec_pretty(&body).unwrap())
}

/// Adds a server for Nunchiro sessions; it never touches the agent's own config. No env: a secret typed here would
/// sit in a plain file, so a server needing env gets it from the user's shell.
/// Held for the whole read-modify-write of Add and Remove. The window socket and the unix socket both reach them through
/// `owner` in this one core process (server.rs drops the registry lock first), so this serializes both transports.
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn mcp_add(home: &Path, name: &str, command: &[String]) -> Result<(), String> {
    if !valid_name(name) {
        return Err("server name: letters, digits, - and _ only".into());
    }
    if command.is_empty()
        || command.len() > 64
        || command
            .iter()
            .any(|a| a.is_empty() || a.len() > 4096 || a.contains('\0'))
    {
        return Err("command: one to 64 non-empty arguments".into());
    }
    let _held = write_lock();
    let mut servers = own_raw(home)?;
    if servers.len() >= MAX_ITEMS && !servers.contains_key(name) {
        return Err("too many servers".into());
    }
    let key = crate::schedule::key(&home.join(KEY_FILE))?;
    let args = command[1..].to_vec();
    let mac = seal(&key, name, &command[0], &args);
    servers.insert(
        name.into(),
        serde_json::json!({ "command": command[0], "args": args, "seal": mac }),
    );
    write_own(home, servers)
}

pub fn mcp_remove(home: &Path, name: &str) -> Result<(), String> {
    let _held = write_lock();
    let mut servers = own_raw(home)?;
    if servers.remove(name).is_none() {
        return Err(format!("no server {name}"));
    }
    write_own(home, servers)
}

const SHIPPED_FILES: [(&str, &str); 4] = crate::sessions::skill::FILES;

fn clip(s: String) -> String {
    shown(&s, MAX_DESCRIPTION)
}

/// Text from an item's own files, as it may be shown or printed: cut to `n` characters, and every control character
/// replaced by a visible mark, so a terminal escape planted in a hook command cannot hide part of it from the owner.
fn shown(s: &str, n: usize) -> String {
    s.chars()
        .take(n)
        .map(|c| if c.is_control() { '\u{FFFD}' } else { c })
        .collect()
}

/// `extensions/` opened by descriptor: a link or another user's folder is refused.
fn root(home: &Path) -> Result<File, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(dir(home))
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => NOT_OWN.to_string(),
            _ => format!("the extensions folder could not be opened: {e}"),
        })?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    match f.metadata() {
        Ok(m) if m.uid() == unsafe { libc::geteuid() } => Ok(f),
        _ => Err(NOT_OWN.into()),
    }
}

/// The custom item's folder name, or `None` for the shipped skill.
fn target(id: &str) -> Result<Option<String>, String> {
    if id == DEFAULT_ID {
        return Ok(None);
    }
    match id.strip_prefix(CUSTOM) {
        Some(name) if valid_name(name) => Ok(Some(name.into())),
        _ => Err(format!("no extension {id}")),
    }
}

fn item_dir(home: &Path, name: &str) -> Result<File, String> {
    dir_at(&root(home)?, &c(OsStr::new(name))?, false).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT) => format!("no extension {CUSTOM}{name}"),
        _ => io_error(name, e),
    })
}

fn io_error(path: &str, e: std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::ENOENT) => format!("{path} was not found"),
        Some(libc::ELOOP) => format!("{path} is reached through a link; links are not followed"),
        Some(libc::ENOTDIR) => {
            format!("{path}: a part of the path is a link or a file; links are not followed")
        }
        _ => format!("{path} could not be used: {e}"),
    }
}

fn valid_part(p: &str) -> bool {
    !p.is_empty() && p != "." && p != ".." && p.len() <= 100 && !p.chars().any(char::is_control)
}

/// `path` as its names, each checked: never empty, `.` or `..`, no control character, at most `MAX_DEPTH` of them.
fn parts(path: &str) -> Result<Vec<CString>, String> {
    let names: Vec<&str> = path.split('/').collect();
    if names.len() > MAX_DEPTH || !names.iter().all(|p| valid_part(p)) {
        return Err(
            "path: 1 to 6 names joined by /, each 1 to 100 bytes, not . or .., no control characters"
                .into(),
        );
    }
    names.into_iter().map(|p| c(OsStr::new(p))).collect()
}

/// The folder holding the path's last name, reached from `item` one name at a time; `create` makes missing folders.
fn descend(item: &File, parts: &[CString], create: bool, path: &str) -> Result<File, String> {
    let mut at = item.try_clone().map_err(|e| e.to_string())?;
    for p in &parts[..parts.len() - 1] {
        at = dir_at(&at, p, create).map_err(|e| io_error(path, e))?;
    }
    Ok(at)
}

/// `name`'s `lstat` mode (type and permission bits) and size, never following a link.
fn stat_at(dir: &File, name: &CStr) -> Option<(libc::mode_t, u64)> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0;
    ok.then_some((st.st_mode, st.st_size as u64))
}

fn read_text(dir: &File, name: &CStr, path: &str) -> Result<String, String> {
    use std::io::Read;
    let file =
        open_at(dir, name, libc::O_RDONLY | libc::O_NONBLOCK, 0).map_err(|e| io_error(path, e))?;
    let meta = file.metadata().map_err(|e| io_error(path, e))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a regular file"));
    }
    let too_large = || format!("{path} is larger than 256 KiB; it is not shown here");
    if meta.len() > MAX_TEXT {
        return Err(too_large());
    }
    let mut bytes = vec![];
    file.take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(path, e))?;
    if bytes.len() as u64 > MAX_TEXT {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))
}

/// One file of `item` by its relative path, or `None` when anything on the way is missing, a link or unreadable.
fn read_rel(item: &File, path: &str) -> Option<String> {
    let parts = parts(path).ok()?;
    read_text(
        &descend(item, &parts, false, path).ok()?,
        parts.last()?,
        path,
    )
    .ok()
}

struct Listing {
    files: Vec<FileEntry>,
    folders: usize,
    more: bool,
}

/// Regular files and folders only (a link is neither listed nor entered), under `MAX_LIST` and `MAX_DEPTH`.
fn walk(dir: &File, prefix: &str, depth: usize, out: &mut Listing) {
    let Ok(mut names) = entries(dir, MAX_LIST + 1, |t| {
        t == libc::DT_REG || t == libc::DT_DIR
    }) else {
        return;
    };
    if names.len() > MAX_LIST {
        out.more = true;
    }
    names.sort();
    for (name, kind) in names {
        let Some(text) = name.to_str().ok().filter(|t| valid_part(t)) else {
            continue;
        };
        let path = if prefix.is_empty() {
            text.to_string()
        } else {
            format!("{prefix}/{text}")
        };
        if kind == libc::DT_DIR {
            if depth + 1 >= MAX_DEPTH || out.folders >= MAX_LIST {
                out.more = true;
            } else if let Ok(sub) = dir_at(dir, &name, false) {
                out.folders += 1;
                walk(&sub, &path, depth + 1, out);
            }
        } else if out.files.len() >= MAX_LIST {
            out.more = true;
            return;
        } else if let Some((mode, bytes)) = stat_at(dir, &name)
            && mode & libc::S_IFMT == libc::S_IFREG
        {
            out.files.push(FileEntry { path, bytes });
        }
    }
}

fn list_files(item: &File) -> (Vec<FileEntry>, bool) {
    let mut out = Listing {
        files: vec![],
        folders: 0,
        more: false,
    };
    walk(item, "", 0, &mut out);
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    (out.files, out.more)
}

fn shipped_list() -> Vec<FileEntry> {
    let mut files: Vec<FileEntry> = SHIPPED_FILES
        .iter()
        .map(|(path, body)| FileEntry {
            path: path.to_string(),
            bytes: body.len() as u64,
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// The `description:` line of a SKILL.md's frontmatter.
fn front_description(text: &str) -> Option<String> {
    let head = text.strip_prefix("---\n")?;
    let head = &head[..head.find("\n---")?];
    let value = head
        .lines()
        .find_map(|l| l.strip_prefix("description:"))?
        .trim();
    Some(serde_json::from_str::<String>(value).unwrap_or_else(|_| value.trim_matches('\'').into()))
}

/// The commands of a Claude plugin `hooks.json`; event and matcher cut at 64 characters, a command at 300.
fn hook_lines(v: &serde_json::Value) -> Vec<HookLine> {
    let cut = shown;
    let mut out = vec![];
    let events = v.get("hooks").and_then(|h| h.as_object());
    for (event, blocks) in events.into_iter().flatten() {
        for block in blocks.as_array().into_iter().flatten() {
            let matcher = block.get("matcher").and_then(|m| m.as_str()).unwrap_or("");
            let handlers = block.get("hooks").and_then(|h| h.as_array());
            for command in handlers
                .into_iter()
                .flatten()
                .filter_map(|h| h.get("command")?.as_str())
            {
                if out.len() == MAX_HOOK_LINES {
                    return out;
                }
                out.push(HookLine {
                    event: cut(event, 64),
                    matcher: cut(matcher, 64),
                    command: cut(command, 300),
                });
            }
        }
    }
    out
}

/// What a custom item holds: description, skill names, hook events, file count, hook commands.
fn summary(item: &File) -> (String, Vec<String>, Vec<String>, u32, Vec<HookLine>) {
    let skills_dir = c(OsStr::new("skills"))
        .ok()
        .and_then(|n| dir_at(item, &n, false).ok());
    let mut skills: Vec<String> = skills_dir
        .as_ref()
        .and_then(|d| entries(d, MAX_ITEMS, |t| t == libc::DT_DIR).ok())
        .into_iter()
        .flatten()
        .filter_map(|(name, _)| name.into_string().ok())
        .filter(|name| valid_part(name))
        .filter(|name| read_rel_is_file(item, &format!("skills/{name}/SKILL.md")))
        .collect();
    skills.sort();
    let description = read_rel(item, ".claude-plugin/plugin.json")
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| Some(v.get("description")?.as_str()?.to_string()))
        .or_else(|| {
            front_description(&read_rel(
                item,
                &format!("skills/{}/SKILL.md", skills.first()?),
            )?)
        })
        .map(clip)
        .unwrap_or_default();
    let hooks_json = read_rel(item, "hooks/hooks.json")
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let hooks = hooks_json
        .as_ref()
        .and_then(|v| {
            Some(
                // Names from a file anyone of this user's programs can write: few, and short.
                v.get("hooks")?
                    .as_object()?
                    .keys()
                    .take(32)
                    .map(|k| shown(k, 64))
                    .collect(),
            )
        })
        .unwrap_or_default();
    let files = list_files(item).0.len() as u32;
    let lines = hooks_json.as_ref().map(hook_lines).unwrap_or_default();
    (description, skills, hooks, files, lines)
}

/// Whether `path` in `item` is a regular file, reached without a link.
fn read_rel_is_file(item: &File, path: &str) -> bool {
    parts(path).is_ok_and(|parts| {
        descend(item, &parts, false, path)
            .ok()
            .and_then(|d| stat_at(&d, parts.last()?))
            .is_some_and(|(mode, _)| mode & libc::S_IFMT == libc::S_IFREG)
    })
}

fn item_files(home: &Path, id: &str) -> Result<Reply, String> {
    let (files, more, editable) = match target(id)? {
        None => (shipped_list(), false, false),
        Some(name) => {
            let (files, more) = list_files(&item_dir(home, &name)?);
            (files, more, true)
        }
    };
    Ok(Reply::ExtensionsFiles {
        id: id.into(),
        editable,
        files,
        more,
    })
}

fn item_read(home: &Path, id: &str, path: &str) -> Result<Reply, String> {
    let name = target(id)?;
    let text = match &name {
        None => SHIPPED_FILES
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, body)| body.to_string())
            .ok_or_else(|| format!("{path} was not found"))?,
        Some(name) => {
            let parts = parts(path)?;
            let at = descend(&item_dir(home, name)?, &parts, false, path)?;
            read_text(&at, &parts[parts.len() - 1], path)?
        }
    };
    Ok(Reply::ExtensionsFile {
        id: id.into(),
        path: path.into(),
        text,
        editable: name.is_some(),
    })
}

/// Writes `text` to `path` in `item`: missing folders made, under a temporary name renamed into place, so a half
/// write never has the final name. A file there keeps its mode (a hook script stays executable).
fn write_at(item: &File, path: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let parts = parts(path)?;
    if text.len() as u64 > MAX_TEXT {
        return Err("text is larger than 256 KiB; nothing was saved".into());
    }
    let at = descend(item, &parts, true, path)?;
    let last = &parts[parts.len() - 1];
    let mode = match stat_at(&at, last).map(|(m, _)| (m & libc::S_IFMT, u32::from(m) & 0o777)) {
        None => 0o600,
        Some((libc::S_IFREG, mode)) => mode,
        Some((libc::S_IFDIR, _)) => return Err(format!("{path} is a folder; nothing was saved")),
        Some((libc::S_IFLNK, _)) => {
            return Err(format!("{path} is a link; links are not followed"));
        }
        Some(_) => return Err(format!("{path} is not a regular file; nothing was saved")),
    };
    let temp = c(OsStr::new(&format!(".{}.save", crate::store::new_id()?)))?;
    let mut file = open_at(
        &at,
        &temp,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .map_err(|e| io_error(path, e))?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| file.set_permissions(std::fs::Permissions::from_mode(mode)))
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            let placed = unsafe {
                libc::renameat(at.as_raw_fd(), temp.as_ptr(), at.as_raw_fd(), last.as_ptr())
            };
            if placed == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    if let Err(e) = written {
        unsafe { libc::unlinkat(at.as_raw_fd(), temp.as_ptr(), 0) };
        return Err(format!("{path} could not be saved: {e}"));
    }
    Ok(())
}

fn item_save(
    home: &Path,
    id: &str,
    path: &str,
    text: &str,
    base: Option<&str>,
) -> Result<Reply, String> {
    let Some(name) = target(id)? else {
        return Err(SHIPPED.into());
    };
    {
        let _held = write_lock();
        let item = item_dir(home, &name)?;
        // shortcut: an outside write between this read and the rename is not caught (as files/mod.rs `save`).
        if let Some(base) = base
            && read_rel(&item, path).as_deref() != Some(base)
        {
            return Err("the file changed on disk since it was opened; nothing was saved".into());
        }
        write_at(&item, path, text)?;
    }
    item_read(home, id, path)
}

/// A new custom item laid out as the shipped plugin: `.claude-plugin/plugin.json` and one `skills/<name>/SKILL.md`.
/// It stays off: the enabled list is not touched.
fn skill_new(home: &Path, name: &str, description: &str, hook: bool) -> Result<(), String> {
    if !valid_name(name) {
        return Err("skill name: letters, digits, - and _ only".into());
    }
    if description.trim().is_empty()
        || description.chars().count() > MAX_DESCRIPTION
        || description.chars().any(char::is_control)
    {
        return Err("description: one line of 1 to 300 characters".into());
    }
    let _held = write_lock();
    real_dir(home, true)?;
    let root = root(home)?;
    let folder = c(OsStr::new(name))?;
    if unsafe { libc::mkdirat(root.as_raw_fd(), folder.as_ptr(), 0o700) } != 0 {
        let e = std::io::Error::last_os_error();
        return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("an extension named {name} already exists")
        } else {
            io_error(name, e)
        });
    }
    let item = dir_at(&root, &folder, false).map_err(|e| io_error(name, e))?;
    let manifest = serde_json::json!({ "name": name, "version": "1", "description": description });
    write_at(
        &item,
        ".claude-plugin/plugin.json",
        &format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )?;
    if hook {
        // One harmless command (it only prints) on one event, so the file shows the shape; the item stays off.
        return write_at(
            &item,
            "hooks/hooks.json",
            r#"{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "echo 'A session finished its turn.'" }
        ]
      }
    ]
  }
}
"#,
        );
    }
    let quoted = serde_json::to_string(description).unwrap();
    write_at(
        &item,
        &format!("skills/{name}/SKILL.md"),
        &format!(
            "---\nname: {name}\ndescription: {quoted}\n---\n\n\
             Write here what this skill does and when the agent should use it.\n\
             Then the steps the agent should follow, as a short list.\n\
             Keep the description above to one line: the agent reads it to decide when to load this skill.\n"
        ),
    )
}

/// Ticket 991 C11: the files are the user's, so a removed custom item is moved, not deleted: into
/// `extensions/.removed/<name>-<unix seconds>` (a dot name is never listed as an item, so nothing loads it), by directory
/// descriptors as every other write here.
pub(crate) const REMOVED: &str = ".removed";
fn item_remove(home: &Path, id: &str) -> Result<(), String> {
    let name = target(id)?.ok_or_else(|| SHIPPED.to_string())?;
    let _held = write_lock();
    let root = root(home)?;
    item_dir(home, &name)?; // a missing item says so, a link is refused
    let removed = c(OsStr::new(REMOVED))?;
    if unsafe { libc::mkdirat(root.as_raw_fd(), removed.as_ptr(), 0o700) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(io_error(REMOVED, e));
        }
    }
    let bin = dir_at(&root, &removed, false).map_err(|e| io_error(REMOVED, e))?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let from = c(OsStr::new(&name))?;
    let to = c(OsStr::new(&format!("{name}-{secs}")))?;
    // SAFETY: both descriptors are open directories and both names are NUL-terminated single path parts.
    if unsafe {
        libc::renameat(
            root.as_raw_fd(),
            from.as_ptr(),
            bin.as_raw_fd(),
            to.as_ptr(),
        )
    } != 0
    {
        return Err(io_error(&name, std::io::Error::last_os_error()));
    }
    Ok(())
}

fn list(home: &Path, user_home: &Path) -> Reply {
    let (mcp, mcp_too_large) = agent_servers(user_home);
    Reply::Extensions {
        dir: dir(home).to_string_lossy().into_owned(),
        items: items(home),
        mcp,
        mcp_too_large,
        own: own_servers(home),
        hooks: crate::sessions::nunchiro_hooks().unwrap_or_default(),
    }
}

/// The owner-only requests. Every caller but the owner's window is refused before anything is read.
pub fn handle(
    home: &Path,
    user_home: &Path,
    caller: Caller,
    request: Request,
) -> Result<Reply, String> {
    if caller != Caller::Window {
        return Err("operation not granted".into());
    }
    match request {
        Request::ExtensionsList => {}
        Request::ExtensionsMcpAdd { name, command } => mcp_add(home, &name, &command)?,
        Request::ExtensionsMcpRemove { name } => mcp_remove(home, &name)?,
        Request::ExtensionsSkillNew {
            name,
            description,
            hook,
        } => skill_new(home, &name, &description, hook)?,
        Request::ExtensionsItemFiles { id } => return item_files(home, &id),
        Request::ExtensionsItemRead { id, path } => return item_read(home, &id, &path),
        Request::ExtensionsItemSave {
            id,
            path,
            text,
            base,
        } => {
            return item_save(home, &id, &path, &text, base.as_deref());
        }
        Request::ExtensionsItemRemove { id } => item_remove(home, &id)?,
        _ => return Err("not an extensions request".into()),
    }
    Ok(list(home, user_home))
}

/// The owner's request from the window or the token-less CLI; session callers were refused before this (`check`) and a
/// remote machine never gets it forwarded (server.rs local owner-only list). Reads the agents' config under `$HOME`.
pub fn owner(home: &Path, request: Request) -> Result<Reply, String> {
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    handle(home, &user_home, Caller::Window, request)
}

/// Claude: `--plugin-dir` per enabled custom folder, and `--mcp-config` with the sealed own servers as inline JSON (the
/// file's path would let Claude read it again after this check). The shipped skill's
/// own `--plugin-dir` stays in `sessions.rs` (it installs the files first); `default_on` tells it whether to add it.
pub fn claude_flags(home: &Path, enabled: &[String]) -> Vec<OsString> {
    let mut out = vec![];
    for name in custom_names(home)
        .into_iter()
        .filter(|n| enabled.contains(&format!("{CUSTOM}{n}")))
    {
        out.push("--plugin-dir".into());
        out.push(dir(home).join(&name).into_os_string());
    }
    let servers: serde_json::Map<String, serde_json::Value> = sealed(home)
        .into_iter()
        .map(|(name, command, args)| {
            (
                name,
                serde_json::json!({ "command": command, "args": args }),
            )
        })
        .collect();
    // `--mcp-config` takes several values (`<configs...>`); the one-word `=` form ends at its own value, so the
    // user's prompt after it is never read as a config (checked on claude 2.1.x: `--mcp-config=/x p` reads only /x).
    if !servers.is_empty() {
        out.push(
            format!(
                "--mcp-config={}",
                serde_json::json!({ "mcpServers": servers })
            )
            .into(),
        );
    }
    out
}

/// Codex: each sealed own server as `-c mcp_servers.<name>.command=…` and `.args=[…]`.
/// shortcut: custom plugin folders do not reach Codex (it has no plugin folder flag); upgrade when Codex gets one.
pub fn codex_flags(home: &Path) -> Vec<OsString> {
    let mut out = vec![];
    for (name, command, args) in sealed(home) {
        out.push("-c".into());
        out.push(
            format!(
                "mcp_servers.{name}.command={}",
                serde_json::to_string(&command).unwrap()
            )
            .into(),
        );
        out.push("-c".into());
        out.push(
            format!(
                "mcp_servers.{name}.args={}",
                serde_json::to_string(&args).unwrap()
            )
            .into(),
        );
    }
    out
}

/// Ticket 456: a stored `extensions.enabled` change may add the shipped skill freely; any other id it adds (a custom
/// item, whose files can run commands: hooks, plugin.json hooks, .mcp.json servers; or an id with no folder yet, which
/// one dropped in later would fill) must be in `confirmed`, the ids the owner turned on after reading them.
pub fn check_enabled(
    before: &[String],
    next: &serde_json::Value,
    confirmed: &[String],
) -> Result<(), String> {
    // A value that is not a list of ids reads as the default at launch (`enabled`), so it adds nothing.
    let Ok(next) = serde_json::from_value::<Vec<String>>(next.clone()) else {
        return Ok(());
    };
    match next
        .iter()
        .find(|id| *id != DEFAULT_ID && !before.contains(id) && !confirmed.contains(id))
    {
        Some(id) => Err(format!(
            "{id} was not turned on: it can run commands, so it is turned on only after you read them (Settings > Skills & hooks, or `nunchiro extensions on {id}`)"
        )),
        None => Ok(()),
    }
}

/// Whether the shipped skill is on.
pub fn default_on(enabled: &[String]) -> bool {
    enabled.iter().any(|e| e == DEFAULT_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nunchiro-ext-{tag}-{}-{}",
            std::process::id(),
            crate::store::new_id().unwrap()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn mcp_list_is_read_only_and_hides_env_values() {
        let home = tmp("home");
        let user = tmp("user");
        std::fs::create_dir_all(user.join(".codex")).unwrap();
        std::fs::create_dir_all(user.join(".claude")).unwrap();
        let claude = r#"{"mcpServers":{"github":{"command":"gh-mcp","args":["--stdio"],"env":{"GITHUB_TOKEN":"SECRET-VALUE-1"}},"remote":{"url":"https://x.test/?token=SECRET-VALUE-3"}}}"#;
        let codex = "[mcp_servers.db]\ncommand = \"db-mcp\"\nargs = [\"-v\"]\n[mcp_servers.db.env]\nDB_PASS = \"SECRET-VALUE-2\"\n";
        std::fs::write(user.join(".claude.json"), claude).unwrap();
        std::fs::write(user.join(".codex/config.toml"), codex).unwrap();
        let before = (
            std::fs::read(user.join(".claude.json")).unwrap(),
            std::fs::read(user.join(".codex/config.toml")).unwrap(),
        );

        let reply = handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap();
        let text = serde_json::to_string(&reply).unwrap();
        assert!(
            !text.contains("SECRET-VALUE"),
            "an env value or URL token left the module: {text}"
        );
        let Reply::Extensions { mcp, .. } = reply else {
            panic!("wrong reply")
        };
        let gh = mcp.iter().find(|s| s.name == "github").unwrap();
        assert_eq!(
            (gh.agent.as_str(), gh.command.clone(), gh.env.clone()),
            (
                "claude",
                vec!["gh-mcp".to_string(), "--stdio".into()],
                vec!["GITHUB_TOKEN".to_string()]
            )
        );
        let db = mcp.iter().find(|s| s.name == "db").unwrap();
        assert_eq!(
            (db.agent.as_str(), db.env.clone()),
            ("codex", vec!["DB_PASS".to_string()])
        );
        // Read only: the agents' files are byte-identical, and `Debug` of the list carries no value either.
        assert!(!format!("{mcp:?}").contains("SECRET-VALUE"));
        assert_eq!(
            before,
            (
                std::fs::read(user.join(".claude.json")).unwrap(),
                std::fs::read(user.join(".codex/config.toml")).unwrap()
            )
        );
        assert_eq!(std::fs::read_dir(user.join(".claude")).unwrap().count(), 0);
    }

    #[test]
    fn mcp_add_goes_per_session_via_mcp_config() {
        let home = tmp("home");
        let user = tmp("user");
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        let add = Request::ExtensionsMcpAdd {
            name: "files".into(),
            command: vec!["files-mcp".into(), "--root".into(), "/tmp/x".into()],
        };
        let Reply::Extensions { own, .. } = handle(&home, &user, Caller::Window, add).unwrap()
        else {
            panic!()
        };
        assert_eq!(own.len(), 1);
        // Claude gets the verified servers inline, never the path of a file an agent can write.
        let flags = claude_flags(&home, &enabled(None));
        assert_eq!(flags.len(), 1, "{flags:?}");
        let inline = flags[0].to_str().unwrap().strip_prefix("--mcp-config=");
        let inline: serde_json::Value = serde_json::from_str(inline.unwrap()).unwrap();
        assert_eq!(
            inline,
            serde_json::json!({"mcpServers":{"files":{"command":"files-mcp","args":["--root","/tmp/x"]}}})
        );
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join("extensions/mcp.json")).unwrap())
                .unwrap();
        assert_eq!(file["mcpServers"]["files"]["command"], "files-mcp");
        let codex: Vec<String> = codex_flags(&home)
            .into_iter()
            .map(|o| o.into_string().unwrap())
            .collect();
        assert_eq!(
            codex,
            [
                "-c",
                "mcp_servers.files.command=\"files-mcp\"",
                "-c",
                "mcp_servers.files.args=[\"--root\",\"/tmp/x\"]"
            ]
        );
        // A name that would break out of the TOML key is refused.
        assert!(mcp_add(&home, "a.b=1", &["x".into()]).is_err());
        assert!(mcp_add(&home, "ok", &[]).is_err());
        // Remove drops it from the next launch; nothing went into the user's home.
        handle(
            &home,
            &user,
            Caller::Window,
            Request::ExtensionsMcpRemove {
                name: "files".into(),
            },
        )
        .unwrap();
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        assert_eq!(std::fs::read_dir(&user).unwrap().count(), 0);
    }

    // Review M1: mcp.json is plain JSON an agent can write, so only an entry the owner's window sealed reaches a launch.
    #[test]
    fn hand_written_or_edited_own_server_never_reaches_a_launch() {
        let home = tmp("home");
        let user = tmp("user");
        let file = home.join("extensions/mcp.json");
        let names = |flags: Vec<OsString>| -> Vec<String> {
            flags
                .into_iter()
                .map(|o| o.into_string().unwrap())
                .collect()
        };
        // Hand-written: no seal, so neither agent launches it, and the list says it changed outside Nunchiro.
        std::fs::create_dir_all(home.join("extensions")).unwrap();
        std::fs::write(
            &file,
            r#"{"mcpServers":{"x":{"command":"sh","args":["-c","evil"]}}}"#,
        )
        .unwrap();
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        assert!(codex_flags(&home).is_empty());
        assert!(
            own_servers(&home)
                .iter()
                .all(|s| s.name == "x" && s.changed)
        );
        // Added from the window: sealed and launched; the hand-written one stays out.
        let add = Request::ExtensionsMcpAdd {
            name: "files".into(),
            command: vec!["files-mcp".into(), "-v".into()],
        };
        handle(&home, &user, Caller::Window, add).unwrap();
        let claude = names(claude_flags(&home, &enabled(None)));
        assert_eq!(claude.len(), 1);
        assert!(
            claude[0].contains("files-mcp") && !claude[0].contains("evil"),
            "{claude:?}"
        );
        let files_only = [
            "-c",
            "mcp_servers.files.command=\"files-mcp\"",
            "-c",
            "mcp_servers.files.args=[\"-v\"]",
        ];
        assert_eq!(names(codex_flags(&home)), files_only);
        let mut listed: Vec<(String, bool)> = own_servers(&home)
            .into_iter()
            .map(|s| (s.name, s.changed))
            .collect();
        listed.sort();
        assert_eq!(
            listed,
            [("files".to_string(), false), ("x".to_string(), true)]
        );
        // Edited after the seal (args swapped, seal kept): out again.
        let mut v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        v["mcpServers"]["files"]["args"] = serde_json::json!(["-c", "evil"]);
        std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        assert!(codex_flags(&home).is_empty());
        assert!(own_servers(&home).iter().all(|s| s.changed));
        // A seal copied onto another name does not verify either; the restored original does.
        v["mcpServers"]["files"]["args"] = serde_json::json!(["-v"]);
        v["mcpServers"]["other"] = v["mcpServers"]["files"].clone();
        std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(names(codex_flags(&home)), files_only);
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(user);
    }

    // Review S3: an mcp.json that cannot be read, is over the cap or is not JSON is never rewritten by Add or Remove.
    #[test]
    fn unreadable_own_mcp_json_is_never_rewritten() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("home");
        let file = home.join("extensions/mcp.json");
        std::fs::create_dir_all(home.join("extensions")).unwrap();
        let big = format!(
            r#"{{"mcpServers":{{}},"pad":"{}"}}"#,
            "x".repeat(MAX_FILE as usize)
        );
        for (what, body, mode) in [
            ("bad JSON", "{not json".to_string(), 0o600),
            ("over the cap", big, 0o600),
            ("unreadable", r#"{"mcpServers":{}}"#.to_string(), 0o000),
        ] {
            std::fs::write(&file, &body).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(
                mcp_add(&home, "files", &["files-mcp".into()]).unwrap_err(),
                "mcp.json could not be read; nothing was changed",
                "{what}"
            );
            assert_eq!(
                mcp_remove(&home, "files").unwrap_err(),
                "mcp.json could not be read; nothing was changed",
                "{what}"
            );
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(std::fs::read_to_string(&file).unwrap(), body, "{what}");
        }
        // Absent is not an error: the first Add writes it.
        std::fs::remove_file(&file).unwrap();
        mcp_add(&home, "files", &["files-mcp".into()]).unwrap();
        let _ = std::fs::remove_dir_all(home);
    }

    // Review SHOULD 1: the user's Claude config often passes 1 MiB (it keeps per-project history); its servers still
    // show, and one past the larger cap says so instead of reading as "no servers".
    #[test]
    fn large_agent_config_is_read() {
        let home = tmp("home");
        let user = tmp("user");
        let config = user.join(".claude.json");
        let body = |pad: usize| {
            format!(
                r#"{{"projects":{{"/p":{{"history":"{}"}}}},"mcpServers":{{"github":{{"command":"gh-mcp"}}}}}}"#,
                "x".repeat(pad)
            )
        };
        std::fs::write(&config, body(3 << 20)).unwrap();
        let Reply::Extensions { mcp, .. } =
            handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            mcp.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["github"]
        );
        // Past the larger cap: not read, and named with its size.
        std::fs::write(&config, body(MAX_AGENT_FILE as usize)).unwrap();
        let size = std::fs::metadata(&config).unwrap().len();
        let Reply::Extensions {
            mcp, mcp_too_large, ..
        } = handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap()
        else {
            panic!()
        };
        assert!(mcp.is_empty());
        assert_eq!(
            mcp_too_large,
            [TooLarge {
                file: "~/.claude.json".into(),
                bytes: size
            }]
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(user);
    }

    fn own_names(home: &Path) -> Vec<String> {
        own_raw(home).unwrap().keys().cloned().collect()
    }

    // Review MUST 2: Add and Remove are one transaction each, whichever transport sent them.
    #[test]
    fn concurrent_add_and_remove_lose_nothing_and_resurrect_nothing() {
        let home = tmp("race");
        let add = |name: String| {
            let home = home.clone();
            std::thread::spawn(move || mcp_add(&home, &name, &["x-mcp".into()]).unwrap())
        };
        for i in 0..40 {
            mcp_add(&home, "gone", &["gone-mcp".into()]).unwrap();
            let h = home.clone();
            let remove = std::thread::spawn(move || mcp_remove(&h, "gone").unwrap());
            let (a, b) = (add(format!("a{i}")), add(format!("b{i}")));
            for t in [remove, a, b] {
                t.join().unwrap();
            }
            let names = own_names(&home);
            assert!(
                !names.contains(&"gone".to_string()),
                "round {i}: a removed server came back: {names:?}"
            );
            for n in [format!("a{i}"), format!("b{i}")] {
                assert!(names.contains(&n), "round {i}: {n} was lost: {names:?}");
            }
        }
        let _ = std::fs::remove_dir_all(home);
    }

    // Review SHOULD (:315): a planted `extensions` link (or `mcp.json` link) never sends a write or read elsewhere.
    #[test]
    fn symlinked_extensions_folder_or_mcp_json_is_refused() {
        let home = tmp("home");
        let agent = tmp("agent-home");
        std::fs::create_dir_all(agent.join("plug")).unwrap();
        std::os::unix::fs::symlink(&agent, home.join("extensions")).unwrap();
        let err = mcp_add(&home, "files", &["files-mcp".into()]).unwrap_err();
        assert_eq!(err, LINKED);
        assert_eq!(mcp_remove(&home, "files").unwrap_err(), LINKED);
        let left: Vec<_> = std::fs::read_dir(&agent)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["plug"], "a write went into the agent home");
        // The linked folder's subfolders are not items, so no launch gets `--plugin-dir` into it.
        assert_eq!(items(&home).len(), 1);
        assert!(claude_flags(&home, &[format!("{CUSTOM}plug")]).is_empty());

        // A real folder with `mcp.json` linked to a file elsewhere: refused, the target untouched.
        std::fs::remove_file(home.join("extensions")).unwrap();
        std::fs::create_dir(home.join("extensions")).unwrap();
        let target = agent.join("config.json");
        std::fs::write(&target, r#"{"mcpServers":{}}"#).unwrap();
        std::os::unix::fs::symlink(&target, home.join("extensions/mcp.json")).unwrap();
        assert_eq!(
            mcp_add(&home, "files", &["files-mcp".into()]).unwrap_err(),
            LINKED
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"mcpServers":{}}"#
        );
        assert!(
            home.join("extensions/mcp.json")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(agent);
    }

    // Review SHOULD (:132): a FIFO in place of `mcp.json`, even one swapped in between a check and the open, never
    // blocks a list, a launch or an Add.
    #[test]
    fn fifo_in_place_of_mcp_json_never_hangs() {
        use std::time::{Duration, Instant};
        let home = tmp("fifo");
        let file = home.join("extensions/mcp.json");
        std::fs::create_dir_all(home.join("extensions")).unwrap();
        let fifo = |p: &Path| {
            let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        };
        fifo(&file);
        let (tx, rx) = std::sync::mpsc::channel();
        let h = home.clone();
        std::thread::spawn(move || {
            let add = mcp_add(&h, "files", &["files-mcp".into()]);
            let list = handle(&h, &h, Caller::Window, Request::ExtensionsList).map(|_| ());
            let flags = (claude_flags(&h, &enabled(None)), codex_flags(&h));
            tx.send((add, list, flags)).unwrap();
        });
        let (add, list, flags) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a FIFO mcp.json blocked");
        assert_eq!(add.unwrap_err(), UNREAD);
        assert!(list.is_ok());
        assert!(flags.0.is_empty() && flags.1.is_empty());

        // Swapped between a regular file and a FIFO while being read: every read still returns.
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s, f) = (stop.clone(), file.clone());
        let swapper = std::thread::spawn(move || {
            while !s.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = std::fs::remove_file(&f);
                let _ = std::fs::write(&f, r#"{"mcpServers":{}}"#);
                let _ = std::fs::remove_file(&f);
                fifo(&f);
            }
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let h = home.clone();
        std::thread::spawn(move || {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(2) {
                let _ = own_raw(&h);
            }
            tx.send(()).unwrap();
        });
        let hung = rx.recv_timeout(Duration::from_secs(10)).is_err();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(!hung, "a FIFO swapped in after the check blocked the open");
        swapper.join().unwrap();
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn extension_ops_refused_from_agent_remote_and_widget() {
        let home = tmp("home");
        let user = tmp("user");
        for caller in [Caller::Agent, Caller::Remote, Caller::Widget] {
            for request in [
                Request::ExtensionsList,
                Request::ExtensionsMcpAdd {
                    name: "evil".into(),
                    command: vec!["sh".into()],
                },
                Request::ExtensionsMcpRemove {
                    name: "evil".into(),
                },
                Request::ExtensionsItemFiles {
                    id: DEFAULT_ID.into(),
                },
                Request::ExtensionsItemRead {
                    id: DEFAULT_ID.into(),
                    path: "skills/nunchiro/SKILL.md".into(),
                },
                Request::ExtensionsItemSave {
                    id: "custom:evil".into(),
                    path: "SKILL.md".into(),
                    text: "x".into(),
                    base: None,
                },
                Request::ExtensionsSkillNew {
                    name: "evil".into(),
                    description: "x".into(),
                    hook: false,
                },
            ] {
                let op = format!("{request:?}");
                assert_eq!(
                    handle(&home, &user, caller, request).unwrap_err(),
                    "operation not granted",
                    "{caller:?} {op}"
                );
            }
        }
        assert!(
            !home.join("extensions").exists(),
            "a refused add, save or new skill wrote a file"
        );
        // The browser-role allowlist and the agent check refuse the ops too (tables in http/browser_tests.rs).
        for op in [
            r#"{"op":"extensions_list"}"#,
            r#"{"op":"extensions_mcp_add","name":"x","command":["x"]}"#,
            r#"{"op":"extensions_mcp_remove","name":"x"}"#,
            r#"{"op":"extensions_item_files","id":"nunchiro"}"#,
            r#"{"op":"extensions_item_read","id":"nunchiro","path":"x"}"#,
            r#"{"op":"extensions_item_save","id":"custom:x","path":"x","text":"x"}"#,
            r#"{"op":"extensions_skill_new","name":"x","description":"x"}"#,
            r#"{"op":"extensions_skill_new","name":"x","description":"x","hook":true}"#,
        ] {
            let frame = format!(r#"{{"id":1,"request":{op}}}"#);
            assert!(crate::http::browser::allowed(&frame).is_err(), "{frame}");
        }
        // Remote: the ops sit in server.rs's local owner-only list, so they are never forwarded to another machine.
        // The agent half (`check_agent`) is `sessions::tests::extension_ops_refused_to_session_callers`.
        let server = include_str!("server.rs");
        let local = &server[..server
            .find("operation is local owner-only; remote forwarding is not permitted")
            .unwrap()];
        for op in [
            "Request::ExtensionsList",
            "Request::ExtensionsMcpAdd",
            "Request::ExtensionsMcpRemove",
            "Request::ExtensionsItemFiles",
            "Request::ExtensionsItemRead",
            "Request::ExtensionsItemSave",
            "Request::ExtensionsSkillNew",
            "Request::ExtensionsItemRemove",
        ] {
            assert!(
                local.contains(op),
                "{op} is not in the local owner-only list"
            );
        }
        // Widget: the web widget bridge serves read data only; no extensions op is reachable from it.
        assert!(!include_str!("widgets/web.rs").contains("Extensions"));
    }

    // Ticket 452
    fn window(home: &Path, request: Request) -> Result<Reply, String> {
        handle(home, home, Caller::Window, request)
    }
    fn read(home: &Path, id: &str, path: &str) -> Result<String, String> {
        match window(
            home,
            Request::ExtensionsItemRead {
                id: id.into(),
                path: path.into(),
            },
        )? {
            Reply::ExtensionsFile { text, .. } => Ok(text),
            _ => panic!("wrong reply"),
        }
    }
    fn save(home: &Path, path: &str, text: &str) -> Result<Reply, String> {
        window(
            home,
            Request::ExtensionsItemSave {
                id: "custom:mine".into(),
                path: path.into(),
                text: text.into(),
                base: None,
            },
        )
    }
    fn listed(home: &Path, id: &str) -> (Vec<String>, bool, bool) {
        match window(home, Request::ExtensionsItemFiles { id: id.into() }).unwrap() {
            Reply::ExtensionsFiles {
                files,
                more,
                editable,
                ..
            } => (files.into_iter().map(|f| f.path).collect(), more, editable),
            _ => panic!("wrong reply"),
        }
    }
    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn items_say_what_they_hold() {
        let home = tmp("summary");
        let mine = home.join("extensions/mine");
        write(
            &mine.join("skills/zeta/SKILL.md"),
            "---\nname: zeta\ndescription: \"Zeta: second.\"\n---\nbody\n",
        );
        write(
            &mine.join("skills/alpha/SKILL.md"),
            "---\nname: alpha\ndescription: Alpha does the first thing.\n---\nbody\n",
        );
        std::fs::create_dir_all(mine.join("skills/empty")).unwrap();
        write(
            &mine.join("hooks/hooks.json"),
            r#"{"hooks":{"PreToolUse":[],"Stop":[]}}"#,
        );
        write(&mine.join("hooks/run.sh"), "echo hi\n");
        let all = items(&home);
        let mine = all.iter().find(|i| i.id == "custom:mine").unwrap();
        // No plugin.json: the first skill's frontmatter gives the description.
        assert_eq!(mine.description, "Alpha does the first thing.");
        assert_eq!(mine.skills, ["alpha", "zeta"]);
        assert_eq!(mine.hooks, ["PreToolUse", "Stop"]);
        assert_eq!(mine.files, 4);
        // plugin.json wins, clipped to 300 characters.
        write(
            &home.join("extensions/mine/.claude-plugin/plugin.json"),
            &format!(r#"{{"name":"mine","description":"{}"}}"#, "é".repeat(400)),
        );
        let mine = items(&home).remove(1);
        assert_eq!(mine.description, "é".repeat(300));
        assert_eq!(mine.files, 5);
        // The shipped skill: from the embedded files, not from disk.
        let shipped = &all[0];
        assert_eq!(shipped.id, DEFAULT_ID);
        assert!(shipped.description.starts_with("How to start, prompt"));
        assert_eq!(shipped.skills, ["artifacts", "nunchiro", "orchestration"]);
        assert!(shipped.hooks.is_empty());
        assert_eq!(shipped.files, 4);
        // An old reader's shape still parses, and empty fields are left out.
        let old: Item = serde_json::from_str(
            r#"{"id":"custom:x","name":"x","kind":"plugin","source":"custom"}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&old).unwrap(),
            r#"{"id":"custom:x","name":"x","kind":"plugin","source":"custom"}"#
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn files_are_listed_bounded_and_links_never_followed() {
        let home = tmp("list");
        let outside = tmp("outside");
        write(&outside.join("secret.txt"), "secret");
        let mine = home.join("extensions/mine");
        write(&mine.join("b.md"), "b");
        write(&mine.join("a/b/c/d/e/f.md"), "six names");
        write(&mine.join("a/b/c/d/e/g/h.md"), "seven names");
        std::os::unix::fs::symlink(outside.join("secret.txt"), mine.join("file-link")).unwrap();
        std::os::unix::fs::symlink(&outside, mine.join("folder-link")).unwrap();
        let (files, more, editable) = listed(&home, "custom:mine");
        assert_eq!(files, ["a/b/c/d/e/f.md", "b.md"]);
        assert!(more, "the seventh level was cut");
        assert!(editable);
        let Reply::ExtensionsFiles { files, .. } = window(
            &home,
            Request::ExtensionsItemFiles {
                id: "custom:mine".into(),
            },
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(files[1].bytes, 1);
        // At most 200 files.
        for i in 0..205 {
            write(&mine.join(format!("many/{i:03}.md")), "x");
        }
        let (files, more, _) = listed(&home, "custom:mine");
        assert_eq!(files.len(), MAX_LIST);
        assert!(more);
        // The shipped skill: the embedded files, read-only.
        let (files, more, editable) = listed(&home, DEFAULT_ID);
        assert_eq!(
            files,
            [
                ".claude-plugin/plugin.json",
                "skills/artifacts/SKILL.md",
                "skills/nunchiro/SKILL.md",
                "skills/orchestration/SKILL.md"
            ]
        );
        assert!(!more && !editable);
        assert!(
            window(
                &home,
                Request::ExtensionsItemFiles {
                    id: "custom:../x".into()
                }
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn reads_are_refused_outside_the_item_through_links_and_past_the_caps() {
        let home = tmp("read");
        let outside = tmp("outside");
        write(&outside.join("secret.txt"), "secret");
        let mine = home.join("extensions/mine");
        write(&mine.join("skills/s/SKILL.md"), "hello");
        write(&home.join("extensions/other/x.md"), "other item");
        assert_eq!(
            read(&home, "custom:mine", "skills/s/SKILL.md").unwrap(),
            "hello"
        );
        let Reply::ExtensionsFile { editable, .. } = window(
            &home,
            Request::ExtensionsItemRead {
                id: DEFAULT_ID.into(),
                path: "skills/nunchiro/SKILL.md".into(),
            },
        )
        .unwrap() else {
            panic!()
        };
        assert!(!editable);
        for bad in [
            "../other/x.md",
            "skills/../../other/x.md",
            "./x",
            "/etc/passwd",
            "a//b",
            "",
            "a\u{1}b",
        ] {
            assert!(
                read(&home, "custom:mine", bad)
                    .unwrap_err()
                    .starts_with("path:"),
                "{bad}"
            );
        }
        assert!(read(&home, "custom:mine", &["a"; 7].join("/")).is_err());
        assert!(read(&home, "custom:mine", &"a".repeat(101)).is_err());
        std::os::unix::fs::symlink(&outside, mine.join("mid")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), mine.join("last")).unwrap();
        for linked in ["mid/secret.txt", "last"] {
            let err = read(&home, "custom:mine", linked).unwrap_err();
            assert!(err.contains("link"), "{linked}: {err}");
        }
        // The item itself a link: refused too.
        std::os::unix::fs::symlink(&outside, home.join("extensions/linked")).unwrap();
        assert!(read(&home, "custom:linked", "secret.txt").is_err());
        write(&mine.join("big.md"), &"x".repeat(MAX_TEXT as usize + 1));
        assert!(
            read(&home, "custom:mine", "big.md")
                .unwrap_err()
                .contains("256 KiB")
        );
        std::fs::write(mine.join("bin"), [0xff, 0xfe, 0]).unwrap();
        assert!(
            read(&home, "custom:mine", "bin")
                .unwrap_err()
                .contains("UTF-8")
        );
        assert!(
            read(&home, "custom:mine", "skills")
                .unwrap_err()
                .contains("regular file")
        );
        assert!(
            read(&home, "custom:mine", "gone.md")
                .unwrap_err()
                .contains("not found")
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn saves_replace_in_place_and_never_go_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("save");
        let outside = tmp("outside");
        let mine = home.join("extensions/mine");
        write(&mine.join("hooks/run.sh"), "old\n");
        std::fs::set_permissions(
            mine.join("hooks/run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        // Replaces, keeps the mode, and the reply is the file read back.
        let Reply::ExtensionsFile {
            text,
            editable,
            path,
            ..
        } = save(&home, "hooks/run.sh", "new\n").unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (text.as_str(), editable, path.as_str()),
            ("new\n", true, "hooks/run.sh")
        );
        assert_eq!(
            std::fs::metadata(mine.join("hooks/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        // Q9 en-b-J13-4: with the text it opened, a save over a file changed on disk since, or now unreadable, is refused.
        let based = |base: &str| {
            window(
                &home,
                Request::ExtensionsItemSave {
                    id: "custom:mine".into(),
                    path: "hooks/run.sh".into(),
                    text: "mine\n".into(),
                    base: Some(base.into()),
                },
            )
        };
        write(&mine.join("hooks/run.sh"), "theirs\n");
        assert_eq!(
            based("new\n").unwrap_err(),
            "the file changed on disk since it was opened; nothing was saved"
        );
        std::fs::write(mine.join("hooks/run.sh"), [0xff, 0xfe]).unwrap();
        assert!(based("").is_err());
        write(&mine.join("hooks/run.sh"), "theirs\n");
        based("theirs\n").unwrap();
        assert_eq!(
            read(&home, "custom:mine", "hooks/run.sh").unwrap(),
            "mine\n"
        );
        // Writes a new file and makes the folders on the way.
        save(&home, "skills/fresh/SKILL.md", "fresh").unwrap();
        assert_eq!(
            std::fs::read_to_string(mine.join("skills/fresh/SKILL.md")).unwrap(),
            "fresh"
        );
        // No temporary file is left anywhere.
        let (files, _, _) = listed(&home, "custom:mine");
        assert_eq!(files, ["hooks/run.sh", "skills/fresh/SKILL.md"]);
        let hidden = std::fs::read_dir(mine.join("hooks"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
            })
            .count();
        assert_eq!(hidden, 0);
        // The shipped skill is never written.
        assert_eq!(
            window(
                &home,
                Request::ExtensionsItemSave {
                    id: DEFAULT_ID.into(),
                    path: "skills/nunchiro/SKILL.md".into(),
                    text: "x".into(),
                    base: None,
                },
            )
            .unwrap_err(),
            SHIPPED
        );
        // Through a link (in the middle or as the file): refused, nothing written outside.
        write(&outside.join("target.md"), "untouched");
        std::os::unix::fs::symlink(&outside, mine.join("mid")).unwrap();
        std::os::unix::fs::symlink(outside.join("target.md"), mine.join("last.md")).unwrap();
        assert!(save(&home, "mid/new.md", "x").unwrap_err().contains("link"));
        assert!(
            save(&home, "mid/target.md", "x")
                .unwrap_err()
                .contains("link")
        );
        assert!(save(&home, "last.md", "x").unwrap_err().contains("link"));
        assert!(save(&home, "../other.md", "x").is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("target.md")).unwrap(),
            "untouched"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        assert!(!home.join("extensions/other.md").exists());
        // A folder as the target, too large, or a missing item: refused.
        assert!(save(&home, "skills", "x").unwrap_err().contains("folder"));
        assert!(save(&home, "big.md", &"x".repeat(MAX_TEXT as usize + 1)).is_err());
        assert!(!mine.join("big.md").exists());
        std::fs::remove_dir_all(&mine).unwrap();
        assert!(save(&home, "a.md", "x").is_err());
        assert!(!mine.exists(), "a save never makes the item itself");
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn new_skill_is_made_listed_and_left_off() {
        let home = tmp("new");
        let new = |name: &str, description: &str| {
            window(
                &home,
                Request::ExtensionsSkillNew {
                    name: name.into(),
                    description: description.into(),
                    hook: false,
                },
            )
        };
        let Reply::Extensions { items, .. } =
            new("review", "Checks a \"diff\" before merge.").unwrap()
        else {
            panic!()
        };
        let item = items.iter().find(|i| i.id == "custom:review").unwrap();
        assert_eq!(item.skills, ["review"]);
        // Ticket 580: what New skill makes reads as a skill, not a plugin.
        assert_eq!(item.kind, "skill");
        assert_eq!(item.description, "Checks a \"diff\" before merge.");
        assert_eq!(item.files, 2);
        let skill = read(&home, "custom:review", "skills/review/SKILL.md").unwrap();
        assert!(
            skill.starts_with(
                "---\nname: review\ndescription: \"Checks a \\\"diff\\\" before merge.\"\n---\n"
            ),
            "{skill}"
        );
        assert_eq!(skill.lines().skip(5).count(), 3, "{skill}");
        let manifest: serde_json::Value = serde_json::from_str(
            &read(&home, "custom:review", ".claude-plugin/plugin.json").unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "review");
        // Off: no launch flag for it with the default enabled list.
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        // An existing name in any form, a bad name or a bad description: refused.
        assert!(
            new("review", "again")
                .unwrap_err()
                .contains("already exists")
        );
        std::os::unix::fs::symlink("/nowhere", home.join("extensions/dangling")).unwrap();
        assert!(new("dangling", "x").unwrap_err().contains("already exists"));
        std::fs::write(home.join("extensions/plain"), "").unwrap();
        assert!(new("plain", "x").unwrap_err().contains("already exists"));
        for bad in ["../x", "a b", "", "a.b"] {
            assert!(new(bad, "x").is_err(), "{bad}");
        }
        for bad in ["", "two\nlines", &"x".repeat(301)] {
            assert!(new("ok", bad).is_err(), "{bad:?}");
        }
        assert!(!home.join("extensions/ok").exists());
        let _ = std::fs::remove_dir_all(home);
    }

    /// Ticket 991 C11: Remove moves a custom item's folder under `.removed/` (its files kept), and the list drops it; the
    /// shipped skill, a missing item and a linked item are refused.
    #[test]
    fn remove_moves_a_custom_item_aside_and_keeps_its_files() {
        let home = tmp("remove");
        let ask = |request| window(&home, request);
        ask(Request::ExtensionsSkillNew {
            name: "review".into(),
            description: "x".into(),
            hook: false,
        })
        .unwrap();
        let remove = |id: &str| ask(Request::ExtensionsItemRemove { id: id.into() });
        let Reply::Extensions { items, .. } = remove("custom:review").unwrap() else {
            panic!()
        };
        assert!(items.iter().all(|i| i.id != "custom:review"));
        let kept: Vec<_> = std::fs::read_dir(home.join("extensions/.removed"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(kept.len(), 1);
        assert!(kept[0].starts_with("review-"));
        let moved = home.join("extensions/.removed").join(&kept[0]);
        assert!(moved.join("skills/review/SKILL.md").is_file());
        assert_eq!(remove("nunchiro").unwrap_err(), SHIPPED);
        assert!(
            remove("custom:review")
                .unwrap_err()
                .contains("no extension")
        );
        assert!(remove("custom:../x").is_err());
        std::os::unix::fs::symlink(&moved, home.join("extensions/linked")).unwrap();
        assert!(remove("custom:linked").is_err());
        assert!(
            home.join("extensions/linked").is_symlink(),
            "a link is not moved"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn new_hook_is_made_listed_with_its_command_and_left_off() {
        let home = tmp("newhook");
        let Reply::Extensions { items, .. } = window(
            &home,
            Request::ExtensionsSkillNew {
                name: "log-stop".into(),
                description: "Prints a line when a turn ends.".into(),
                hook: true,
            },
        )
        .unwrap() else {
            panic!()
        };
        let item = items.iter().find(|i| i.id == "custom:log-stop").unwrap();
        assert_eq!(item.kind, "hook");
        assert_eq!(item.description, "Prints a line when a turn ends.");
        assert_eq!(item.hooks, ["Stop"]);
        assert_eq!(item.hook_lines.len(), 1);
        assert_eq!(item.hook_lines[0].event, "Stop");
        assert!(item.skills.is_empty());
        assert_eq!(item.files, 2);
        assert!(claude_flags(&home, &enabled(None)).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_control_character_in_a_hook_command_is_shown_as_a_mark() {
        // A terminal escape that would erase the line: the owner must see that something is there.
        let v = serde_json::json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "rm -rf ~ #\u{1b}[2K\r./done.sh"}]}]}});
        let lines = hook_lines(&v);
        assert_eq!(lines.len(), 1);
        assert!(
            !lines[0].command.chars().any(char::is_control),
            "{:?}",
            lines[0].command
        );
        assert!(
            lines[0]
                .command
                .starts_with("rm -rf ~ #\u{FFFD}[2K\u{FFFD}./done.sh")
        );
        assert_eq!(clip("a\u{7}b".into()), "a\u{FFFD}b");
    }

    #[test]
    fn hook_lines_show_each_command_bounded() {
        let home = tmp("hooklines");
        let hooks = home.join("extensions/guard/hooks/hooks.json");
        write(
            &hooks,
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./check.sh"},{"type":"command","command":"./log.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"./done.sh"}]}]}}"#,
        );
        let line = |event: &str, matcher: &str, command: &str| HookLine {
            event: event.into(),
            matcher: matcher.into(),
            command: command.into(),
        };
        let lines = || items(&home).remove(1).hook_lines;
        assert_eq!(
            lines(),
            [
                line("PreToolUse", "Bash", "./check.sh"),
                line("PreToolUse", "Bash", "./log.sh"),
                line("Stop", "", "./done.sh"),
            ]
        );
        let many: Vec<serde_json::Value> = (0..33)
            .map(|n| serde_json::json!({"type":"command","command":format!("c{n}")}))
            .collect();
        let long = "x".repeat(400);
        let body = serde_json::json!({"hooks":{
            "A": [{"matcher": "m".repeat(70), "hooks": [{"type":"command","command": long}]}],
            "B": [{"hooks": many}],
        }});
        write(&hooks, &body.to_string());
        let got = lines();
        assert_eq!(got.len(), 32);
        assert_eq!(got[0].command, "x".repeat(300));
        assert_eq!(got[0].matcher, "m".repeat(64));
        assert_eq!(got[31].command, "c30");
        write(&hooks, "not json {");
        assert!(lines().is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn claude_flags_never_open_an_item_file() {
        let home = tmp("flagsfifo");
        let item = home.join("extensions/held/hooks");
        std::fs::create_dir_all(&item).unwrap();
        let fifo = c(item.join("hooks.json").as_os_str()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let flags = claude_flags(&home, &["custom:held".into()]);
        assert_eq!(
            flags,
            [
                OsString::from("--plugin-dir"),
                home.join("extensions/held").into_os_string()
            ]
        );
        let _ = std::fs::remove_dir_all(home);
    }
}
