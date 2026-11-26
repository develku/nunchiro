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
    /// An own server added for one project: only sessions of that project folder get it. Absent: every project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
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
                project: None,
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
                project: None,
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
        s.project = raw
            .get(&s.name)
            .and_then(|v| v.get("project")?.as_str().map(String::from));
        s.changed = key
            .as_deref()
            .zip(raw.get(&s.name))
            .and_then(|(k, v)| verified(k, &s.name, v))
            .is_none();
    }
    out
}

/// The seal over one own server; name, command, args and project all count, so a copied or edited entry fails.
/// A global entry's seal is the older build's, unchanged, so that build still starts it; a one-project entry's adds the
/// project, so that build's check fails it and never starts it everywhere.
fn seal(key: &[u8], name: &str, command: &str, args: &[String], project: Option<&str>) -> String {
    let msg = match project {
        None => serde_json::to_vec(&("extensions.mcp", name, command, args)),
        Some(p) => serde_json::to_vec(&("extensions.mcp", name, command, args, p)),
    }
    .unwrap_or_default();
    crate::schedule::hmac(key, &msg)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// `(command, args, project)` when the entry's seal verifies. A `project` that is there but not text fails.
fn verified(key: &[u8], name: &str, v: &serde_json::Value) -> Option<Own> {
    let command = v.get("command")?.as_str()?.to_string();
    let args = v
        .get("args")?
        .as_array()?
        .iter()
        .map(|a| a.as_str().map(String::from))
        .collect::<Option<Vec<_>>>()?;
    let project = match v.get("project") {
        None => None,
        Some(p) => Some(p.as_str()?.to_string()),
    };
    let mac = v.get("seal")?.as_str()?;
    (valid_name(name)
        && crate::schedule::same(mac, &seal(key, name, &command, &args, project.as_deref())))
    .then_some((command, args, project))
}
type Own = (String, Vec<String>, Option<String>);
/// The own servers a launch may pass: sealed by `mcp_add` and unchanged since.
/// Same-user limit (security review MUST 1, accepted; docs/areas/settings.md): the key is a 0600 file in the same
/// user's data folder (as `schedule.key`), and every agent runs as that user, so an agent can read or replace the key,
/// forge a seal and get its command into later launches. The seal stops a hand-written or edited entry from being
/// launched silently (it shows as changed); it is not a sandbox, the same as that agent editing the user's own
/// `~/.claude.json` or shell startup files. Upgrade with the keychain (or a separate user) when the core gets one.
fn sealed(home: &Path) -> Vec<(String, Own)> {
    let Ok(key) = crate::schedule::key(&home.join(KEY_FILE)) else {
        return vec![];
    };
    own_raw(home)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, v)| verified(&key, &name, &v).map(|own| (name, own)))
        .collect()
}
/// The sealed own servers a session of `project` (its project folder, also for a worktree session) gets.
fn sealed_for(home: &Path, project: &Path) -> Vec<(String, String, Vec<String>)> {
    sealed(home)
        .into_iter()
        .filter(|(_, (_, _, p))| p.as_deref().is_none_or(|p| Path::new(p) == project))
        .map(|(name, (c, a, _))| (name, c, a))
        .collect()
}

/// Ticket 1002 lane 1: the names of the sealed own servers a launch passes (`claude_flags`).
pub(crate) fn sealed_names(home: &Path) -> Vec<String> {
    sealed(home).into_iter().map(|(name, _)| name).collect()
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

/// `project`: only sessions of that project folder get the server; `None`, every project.
pub fn mcp_add(
    home: &Path,
    name: &str,
    command: &[String],
    project: Option<&Path>,
) -> Result<(), String> {
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
    let project = match project {
        None => None,
        Some(p) => Some(
            p.to_str()
                .filter(|s| p.is_absolute() && s.len() <= 4096 && !s.contains('\0'))
                .ok_or("project: a full folder path")?,
        ),
    };
    let _held = write_lock();
    let mut servers = own_raw(home)?;
    if servers.len() >= MAX_ITEMS && !servers.contains_key(name) {
        return Err("too many servers".into());
    }
    // One name is one server: added again for the same projects it is replaced, for other projects it is refused.
    if let Some(was) = servers
        .get(name)
        .map(|v| v.get("project").and_then(|p| p.as_str()))
        && was != project
    {
        return Err(format!(
            "a server named {name} is already added for {}; remove it first or pick another name",
            was.unwrap_or("all projects")
        ));
    }
    let key = crate::schedule::key(&home.join(KEY_FILE))?;
    let args = command[1..].to_vec();
    let mac = seal(&key, name, &command[0], &args, project);
    let mut entry = serde_json::json!({ "command": command[0], "args": args, "seal": mac });
    if let Some(p) = project {
        entry["project"] = p.into();
    }
    servers.insert(name.into(), entry);
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
        Request::ExtensionsMcpAdd {
            name,
            command,
            project,
        } => mcp_add(home, &name, &command, project.as_deref())?,
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
pub fn claude_flags(home: &Path, enabled: &[String], project: &Path) -> Vec<OsString> {
    let mut out = vec![];
    for name in custom_names(home)
        .into_iter()
        .filter(|n| enabled.contains(&format!("{CUSTOM}{n}")))
    {
        out.push("--plugin-dir".into());
        out.push(dir(home).join(&name).into_os_string());
    }
    let servers: serde_json::Map<String, serde_json::Value> = sealed_for(home, project)
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

/// Codex: each sealed own server for `project` as `-c mcp_servers.<name>.command=…` and `.args=[…]`.
/// shortcut: custom plugin folders do not reach Codex (it has no plugin folder flag); upgrade when Codex gets one.
pub fn codex_flags(home: &Path, project: &Path) -> Vec<OsString> {
    let mut out = vec![];
    for (name, command, args) in sealed_for(home, project) {
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
mod tests;
