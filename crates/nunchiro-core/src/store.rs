//! Atomic metadata persistence; malformed stores are never overwritten.
use crate::api::{AgentKind, Session, SessionState};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

/// V2-1a: the store version this core writes for queue.json, and for a sessions.json without token records; it reads 1
/// (as "no holder") and 2, and sessions.json also as TOKEN_VERSION.
pub const VERSION: u64 = 2;
/// Ticket 752 round 2: sessions.json's version when it holds `token_conversations`. A core that reads only 1 and 2
/// sets such a file aside (`other_version`, v1b-40) instead of loading it and saving the records away, which would let
/// a dropped token conversation resume without the token's limits. A store without records stays version 2, so a
/// home that never dropped a token row is not set aside by an older core. Only sessions.json uses it (queue.json
/// stays at VERSION).
pub const TOKEN_VERSION: u64 = 3;
#[derive(Serialize, Deserialize)]
struct Store {
    version: u64,
    sessions: Vec<Session>,
    // V2-1a (version 2): live sessions' records, by session id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    live: BTreeMap<String, Live>,
    /// Ticket 752: the conversations of dropped Closed token rows, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    token_conversations: Vec<TokenConversation>,
}
/// Ticket 752: what a dropped Closed token row leaves, so a resume of its conversation still runs under the token's
/// limits and another token's is refused (`Sessions::spawn`). It is written in the same atomic save as the drop, so no
/// crash leaves a store with neither the row nor this. Never sent to a window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenConversation {
    pub kind: AgentKind,
    pub conversation: String,
    pub origin: String,
}
/// Ticket 752: the most `TokenConversation`s kept. When they would not fit, token rows are no longer dropped, so an
/// origin is never lost (`Sessions::drop_closed`).
pub const TOKEN_CONVERSATIONS: usize = 4096;
/// V2-1a: what a live session keeps beside its row (store version 2), never sent to a window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Live {
    /// SHA-256 (lowercase hex) of the session token: written before the agent launches, removed when the session
    /// is closed or removed, which revokes it.
    pub token_sha256: String,
    pub holder: Option<crate::holder::Record>,
    /// V2-1b: the agent's start time, so a later core tells it from another process on its pid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_started: Option<u64>,
    /// Ticket 512: where the run's output starts in the replay (`Pty::run_start`), after a resumed conversation's seed;
    /// the holder does not keep it. 0 (and absent) for a run with no seed.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub run_start: u64,
    /// W35 round 5: the arguments the run was started with (a resume's own), so a fast mode restart can repeat them after
    /// a core restart; none for a start with `--env`. Kept here, never on a session row a window or another session reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_args: Option<Vec<String>>,
    /// V2-1b: the agent's pid when its row was saved running (the row's `pid`, which loading clears); not stored here.
    #[serde(skip)]
    pub agent_pid: Option<u32>,
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}
/// V2-1a: lowercase hex SHA-256 of a session token, as sessions.json keeps it.
pub fn token_sha256(token: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
pub fn load(home: &Path) -> Result<Vec<Session>, String> {
    load_live(home).map(|(sessions, _)| sessions)
}
#[cfg(test)]
pub fn load_live(home: &Path) -> Result<(Vec<Session>, BTreeMap<String, Live>), String> {
    load_all(home).map(|(sessions, live, ..)| (sessions, live))
}
/// The stored rows, live records and dropped token conversations (ticket 752).
pub type Loaded = (Vec<Session>, BTreeMap<String, Live>, Vec<TokenConversation>);
/// `Loaded` and whether some set-aside origins may be lost (ticket 961, `load_all`).
pub type LoadedAll = (
    Vec<Session>,
    BTreeMap<String, Live>,
    Vec<TokenConversation>,
    bool,
);
/// The most bytes read of sessions.json, and of one set-aside copy for its token records (it also holds every row).
const SESSIONS_READ_MAX: u64 = 64 << 20;
/// Ticket 752 round 3: sessions.json, plus the token records of every version 3 file an older core set aside
/// (`sessions.json.v3.<time>[.<k>].aside`, v1b-40). An older core sets a version 3 store aside and starts a new one
/// without records, so after an upgrade again only these keep the origins a resume needs. Only `token_conversations`
/// and the token origins of its rows (ticket 961) are read from an aside file, never a row itself; a file that cannot be
/// read or holds a bad record is skipped with a log line. Records join by conversation id, the loaded store's first,
/// and stop at TOKEN_CONVERSATIONS. The last value says some origins may be lost (a file skipped, or records over the
/// cap), so a token's resume of a conversation with no known origin is refused (`Sessions::spawn`).
pub fn load_all(home: &Path) -> Result<LoadedAll, String> {
    let (sessions, live, mut records) = load_main(home)?;
    let mut lost = false;
    let mut asides: Vec<_> = fs::read_dir(home)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("sessions.json.v3.") && n.ends_with(".aside"))
        })
        .collect();
    asides.sort();
    for path in asides {
        let read = || -> Result<(Vec<TokenConversation>, bool), String> {
            #[derive(Deserialize)]
            struct Aside {
                #[serde(default)]
                sessions: Vec<serde_json::Value>,
                #[serde(default)]
                token_conversations: Vec<TokenConversation>,
            }
            let file = open_regular(&path).map_err(|e| e.to_string())?;
            let bytes = read_capped(file, SESSIONS_READ_MAX).map_err(|e| e.to_string())?;
            let aside: Aside = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !valid_records(&aside.token_conversations) {
                return Err("invalid token record".into());
            }
            // Ticket 961: a row is read only for its stored origin (the row's own, `Session::token_origin`); a row
            // without one, or without a conversation to resume, gives none. Others' fields are never judged, so a
            // newer row shape does not hide the origins.
            // A bad row marks origins lost but keeps the file's records that were judged valid.
            let mut found = aside.token_conversations;
            let mut partial = false;
            for row in &aside.sessions {
                let (Some(origin), Some(conversation)) = (
                    row.get("token_origin").filter(|o| !o.is_null()),
                    row.get("agent_session_id").filter(|c| !c.is_null()),
                ) else {
                    continue;
                };
                let record = (|| -> Option<TokenConversation> {
                    Some(TokenConversation {
                        kind: serde_json::from_value(row.get("kind").cloned().unwrap_or_default())
                            .ok()?,
                        conversation: serde_json::from_value(conversation.clone()).ok()?,
                        origin: serde_json::from_value(origin.clone()).ok()?,
                    })
                })();
                match record.filter(valid_record) {
                    Some(record) => found.push(record),
                    None => partial = true,
                }
            }
            Ok((found, partial))
        };
        match read() {
            Ok((found, partial)) => {
                if partial {
                    lost = true;
                    eprintln!("{}: a row's token origin not read", path.display());
                }
                for record in found {
                    if records
                        .iter()
                        .any(|r| r.conversation == record.conversation)
                    {
                        continue;
                    }
                    if records.len() >= TOKEN_CONVERSATIONS {
                        lost = true;
                        eprintln!(
                            "{}: token records over {TOKEN_CONVERSATIONS} not merged",
                            path.display()
                        );
                        break;
                    }
                    records.push(record);
                }
            }
            Err(e) => {
                lost = true;
                eprintln!("{}: token records not read: {e}", path.display());
            }
        }
    }
    Ok((sessions, live, records, lost))
}
/// Ticket 752: the origin becomes a session's token origin on resume; only a token caller id is accepted.
fn valid_records(records: &[TokenConversation]) -> bool {
    records.len() <= TOKEN_CONVERSATIONS && records.iter().all(valid_record)
}
fn valid_record(t: &TokenConversation) -> bool {
    valid_id(&t.conversation)
        && t.origin.len() <= 256
        && t.origin
            .strip_prefix(crate::tokens::CALLER)
            .is_some_and(|id| !id.is_empty())
}
/// The sessions and, from a version 2 file, the live records; a version 1 file has none (and is copied once to
/// `sessions.json.v1` before this core writes version 2).
fn load_main(home: &Path) -> Result<Loaded, String> {
    let path = home.join("sessions.json");
    // v1b-40 r2: bytes and metadata from one handle, so a set-aside can prove it moves the file that was judged.
    // Q9 zh-hant-J9-2: a FIFO or a file over the cap is refused, never waited on or read whole; a link is followed
    // (owners keep dotfiles as links) and its target judged.
    let read = |path: &Path| -> std::io::Result<(fs::Metadata, Vec<u8>)> {
        let file = open_regular_following(path)?;
        let judged = file.metadata()?;
        Ok((judged, read_capped(file, SESSIONS_READ_MAX)?))
    };
    let (judged, bytes) = match read(&path) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((vec![], BTreeMap::new(), vec![]));
        }
        Err(e) => return Err(format!("sessions.json: {e}")),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid metadata: {e}"))?;
    if !value.is_object() {
        return Err("invalid metadata: expected an object".into());
    }
    if let Some(version) = other_version(&value).filter(|v| *v != TOKEN_VERSION) {
        set_aside(&path, &judged, version)?;
        return Ok((vec![], BTreeMap::new(), vec![]));
    }
    // Past `other_version`, `version` is 1, 2, TOKEN_VERSION or not an integer (refused by the typed parse).
    let mut store: Store =
        serde_json::from_value(value).map_err(|e| format!("invalid metadata: {e}"))?;
    if store.version == 1 {
        // A v1 file never had live records; one that names some is not a v1 file.
        if !store.live.is_empty() {
            return Err("invalid metadata relationship".into());
        }
        keep_v1(&path, &bytes)?;
    }
    // v2-2b: an account folder is `<home>/accounts/<agent>/<id>`, under the home as given or as resolved.
    let homes = [
        home.to_path_buf(),
        fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()),
    ];
    let account_folder = |kind: AgentKind, d: &Path| {
        let agent = match kind {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Shell | AgentKind::Acp => return false,
        };
        d.file_name()
            .and_then(|id| id.to_str())
            .is_some_and(valid_id)
            && homes
                .iter()
                .any(|h| d.parent() == Some(h.join("accounts").join(agent).as_path()))
    };
    let mut ids = HashSet::new();
    for s in &mut store.sessions {
        if !valid_id(&s.id)
            || !ids.insert(s.id.clone())
            || !s.project.is_absolute()
            || !s.cwd.is_absolute()
            || s.agent_session_id.as_ref().is_some_and(|id| !valid_id(id))
            // v1b-11: the start commit reaches `git` as a revision; only a full object name is accepted.
            || matches!(&s.start_commit, Some(crate::diff::Base::Commit { sha }) if !crate::diff::valid_sha(sha))
            // v1b-07: the artifact folder id becomes a path and an `--add-dir`; only an id is accepted.
            || s.artifacts.as_ref().is_some_and(|id| !valid_id(id))
            // v2-2b: an account folder is absolute and belongs to an agent session; its label comes with it and is a
            // valid account name (it reaches tab titles).
            || s.config_dir.as_ref().is_some_and(|d| !account_folder(s.kind, d))
            || s.account.is_some() != s.config_dir.is_some()
            || s.account.as_deref().is_some_and(|l| crate::accounts::check_label(l).is_err())
            || (s.state == SessionState::Running && s.pid.is_none())
            || (s.state != SessionState::Running && s.pid.is_some())
        {
            return Err("invalid metadata relationship".into());
        }
        if let Some(live) = store.live.get(&s.id)
            && (live.token_sha256.len() != 64
                || !live
                    .token_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || live
                    .holder
                    .as_ref()
                    .is_some_and(|h| !h.socket.is_absolute()))
        {
            return Err("invalid metadata relationship".into());
        }
        if let Some(live) = store.live.get_mut(&s.id)
            && s.state == SessionState::Running
        {
            live.agent_pid = s.pid;
        }
        s.pid = None;
        // ACCOUNTPICK: the folder must still be one the registry names and a real folder (not a link); otherwise the
        // record keeps no folder or account and is not resumable, so no spawn env or transcript read uses it.
        let mut held_back = false;
        if let Some(folder) = s.config_dir.clone()
            && let Err(reason) = crate::accounts::agent_of(s.kind)
                .ok_or_else(|| "not an agent session".to_string())
                .and_then(|agent| crate::accounts::folder_again(home, agent, &folder))
        {
            // Q9 zh-hant-J9-1: an accounts.toml that cannot be read now (a hand edit half done) says nothing about
            // this account; the fields stay for the next start and only this run does not resume it.
            held_back = crate::accounts::registered(home).is_err();
            eprintln!(
                "session {}: account folder {} not used ({reason}); the session is not resumable{}",
                s.id,
                folder.display(),
                if held_back {
                    " until the account list reads again"
                } else {
                    ""
                }
            );
            if !held_back {
                s.config_dir = None;
                s.account = None;
                s.agent_session_id = None;
            }
        }
        if s.state != SessionState::Closed {
            s.state = if s.kind != AgentKind::Shell && s.agent_session_id.is_some() && !held_back {
                SessionState::Resumable
            } else {
                SessionState::Exited
            };
        }
    }
    // A record without its row is a launch that never finished (its hash is saved first): dropped, unless it names
    // a holder, which only a launched session has.
    if store
        .live
        .iter()
        .any(|(id, live)| !ids.contains(id) && live.holder.is_some())
    {
        return Err("invalid metadata relationship".into());
    }
    store.live.retain(|id, _| ids.contains(id));
    if !valid_records(&store.token_conversations) {
        return Err("invalid metadata relationship".into());
    }
    Ok((store.sessions, store.live, store.token_conversations))
}
/// v1b-40: the integer `version` of a well-formed store object when this core does not read it (V2-1a: 1 and 2
/// are read); anything else is left to the typed parse (a missing or non-integer version stays malformed and refused).
pub fn other_version(value: &serde_json::Value) -> Option<u64> {
    value["version"]
        .as_u64()
        .filter(|v| !(1..=VERSION).contains(v))
}
/// V2-1a: a version 1 state file's bytes, kept once as `<name>.v1` (0600) before the first version 2 write, so an
/// older core's data survives the upgrade. An existing copy, from an earlier upgrade, is never replaced.
pub fn keep_v1(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut name = path
        .file_name()
        .ok_or("state file has no name")?
        .to_os_string();
    name.push(".v1");
    let copy = path.with_file_name(name);
    if fs::symlink_metadata(&copy).is_ok() {
        return Ok(());
    }
    // Written whole under a temporary name, then linked: never a partial or replaced copy.
    let tmp = path.with_extension(format!("{}.tmp", new_id()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match fs::hard_link(&tmp, &copy) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        fs::File::open(path.parent().unwrap())?.sync_all()
    })()
    .map_err(|e| format!("{}: {e}", copy.display()));
    let _ = fs::remove_file(&tmp);
    result
}
/// v1b-40: names tried (`.1` .. `.999` after the plain one) before a set-aside gives up.
const ASIDE_NAMES: u32 = 1000;
/// v1b-40: keeps a store of another version as `<name>.v<N>.<unix-time>[.<k>].aside` beside it (owner-only, never
/// overwriting) so the core can start empty. Only the regular file `judged` (the metadata of the handle its bytes
/// were read from) is moved, never a link.
pub fn set_aside(path: &Path, judged: &fs::Metadata, version: u64) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if !judged.is_file() || !fs::symlink_metadata(path).is_ok_and(|m| m.is_file()) {
        return Err("state file is not a regular file".into());
    }
    let dir = path.parent().ok_or("state file has no folder")?;
    let name = path
        .file_name()
        .ok_or("state file has no name")?
        .to_string_lossy();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // A hard link never replaces an existing name (a plain rename would); the original name goes only after.
    let mut kept = None;
    for k in 0..ASIDE_NAMES {
        let suffix = if k == 0 {
            String::new()
        } else {
            format!(".{k}")
        };
        let aside = dir.join(format!("{name}.v{version}.{now}{suffix}.aside"));
        match fs::hard_link(path, &aside) {
            Ok(()) => {
                kept = Some(aside);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    let aside = kept.ok_or("no free name to set the state file aside")?;
    // The new name must hold the judged file, unchanged; otherwise drop only the new name.
    let same = |m: &fs::Metadata| {
        m.is_file()
            && (m.dev(), m.ino(), m.len(), m.mtime(), m.mtime_nsec())
                == (
                    judged.dev(),
                    judged.ino(),
                    judged.len(),
                    judged.mtime(),
                    judged.mtime_nsec(),
                )
    };
    if !fs::symlink_metadata(&aside).is_ok_and(|m| same(&m)) {
        if let Err(e) = fs::remove_file(&aside) {
            eprintln!(
                "state file set-aside: could not remove {}: {e}",
                aside.display()
            );
        }
        return Err("state file changed while it was set aside".into());
    }
    fs::set_permissions(&aside, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    fs::remove_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())?;
    eprintln!(
        "state file {} has version {version}; kept as {} and started empty",
        path.display(),
        aside.display()
    );
    Ok(())
}
/// v1b-40 r2: whether `home` holds a set-aside copy of the state file `name` (any version, any time). An unreadable
/// folder counts as holding one, so a caller that only cleans up keeps everything.
pub fn kept_aside(home: &Path, name: &str) -> bool {
    let prefix = format!("{name}.v");
    fs::read_dir(home).map_or(true, |entries| {
        entries.flatten().any(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".aside"))
        })
    })
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
#[cfg(test)]
pub fn save(
    home: &Path,
    sessions: Vec<Session>,
    live: BTreeMap<String, Live>,
) -> Result<(), String> {
    save_all(home, sessions, live, vec![])
}
pub fn save_all(
    home: &Path,
    sessions: Vec<Session>,
    live: BTreeMap<String, Live>,
    token_conversations: Vec<TokenConversation>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&Store {
        version: match token_conversations.is_empty() {
            true => VERSION,
            false => TOKEN_VERSION,
        },
        sessions,
        live,
        token_conversations,
    })
    .map_err(|e| e.to_string())?;
    write_capped(&home.join("sessions.json"), &bytes, SESSIONS_READ_MAX)
}
/// Ticket 421 round 3: `path` opened for reading only when it is a regular file, judged on the open handle. The open is
/// non-blocking, so a FIFO with no writer (which a plain open waits on forever) is refused at once, as is a device or a
/// folder; a missing file stays `NotFound` for the caller. A link at `path` is refused the same way (`O_NOFOLLOW`): the
/// core writes its files with `atomic_write`, which replaces a link, so none of its own files is one.
pub(crate) fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    open_checked(path, libc::O_NOFOLLOW)
}
/// `open_regular` that follows a link, for a file the owner may keep as one (Claude's settings, outside the core's home).
pub(crate) fn open_regular_following(path: &Path) -> std::io::Result<fs::File> {
    open_checked(path, 0)
}
fn open_checked(path: &Path, flags: i32) -> std::io::Result<fs::File> {
    let not_regular =
        || std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file");
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | flags)
        .open(path)
    {
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Err(not_regular()),
        file => file?,
    };
    if !file.metadata()?.is_file() {
        return Err(not_regular());
    }
    Ok(file)
}
/// What `read_regular` reads at most; a caller that needs more reads through `read_capped` with its own cap. A file read
/// with a cap is written with `write_capped` and the same cap, so the core never writes what it then refuses to read.
pub(crate) const READ_MAX: u64 = 1 << 20;
/// `settings.json`'s cap: room for every feature the limits allow (256 values of 4 KiB, flat) and the rest of the file.
pub(crate) const SETTINGS_READ_MAX: u64 = 4 << 20;
/// `fs::read` through `open_regular`: a link, FIFO, device or folder is refused instead of read (or waited on), and a
/// file over `READ_MAX` is an error.
pub(crate) fn read_regular(path: &Path) -> std::io::Result<Vec<u8>> {
    read_capped(open_regular(path)?, READ_MAX)
}
/// `read_regular` of `settings.json`, with its cap.
pub(crate) fn read_settings(path: &Path) -> std::io::Result<Vec<u8>> {
    read_capped(open_regular(path)?, SETTINGS_READ_MAX)
}
/// `atomic_write` of a file its readers read with the cap `max`: a write over it is refused and the file stays as it was.
pub(crate) fn write_capped(path: &Path, bytes: &[u8], max: u64) -> Result<(), String> {
    if bytes.len() as u64 > max {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!(
            "{name} would be {} bytes, over its {max}-byte limit; nothing was written",
            bytes.len()
        ));
    }
    atomic_write(path, bytes)
}
/// All of `file` when it holds at most `max` bytes; a longer one is an error, never a cut the caller cannot see.
pub(crate) fn read_capped(file: fs::File, max: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, max + 1), &mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file is over the {max}-byte read limit"),
        ));
    }
    Ok(bytes)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", new_id()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::File::open(path.parent().unwrap())?.sync_all()
    })()
    .map_err(|e: std::io::Error| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
pub fn private_dir(path: &Path) -> Result<(), String> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("data folder must not be a symlink".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
pub fn new_id() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

#[cfg(test)]
#[path = "../tests/fixtures/aside.rs"]
pub(crate) mod aside_fixture;

// v1b-11
#[cfg(test)]
mod tests {
    use super::aside_fixture::asides;
    use super::*;

    fn load_with_sha(sha: &str) -> Result<Vec<Session>, String> {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("store-sha-{}-{}", std::process::id(), sha.len()))
            .join(sha.replace(['/', '='], "_"));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let record = serde_json::json!({"version":1,"sessions":[{
            "id":"s1","kind":"shell","project":"/p","cwd":"/p","label":"","state":"exited",
            "agent_session_id":null,"agent_version":null,"untested":false,"pid":null,
            "start_commit":{"kind":"commit","sha":sha}}]});
        fs::write(home.join("sessions.json"), record.to_string()).unwrap();
        let out = load(&home);
        let _ = fs::remove_dir_all(&home);
        out
    }

    #[test]
    fn diff_load_refuses_a_start_commit_that_is_not_a_full_lowercase_sha() {
        for sha in [
            "--output=/tmp/victim",
            "HEAD",
            "abc1234",
            &"A".repeat(40),
            &"a".repeat(41),
            &"g".repeat(40),
        ] {
            assert_eq!(
                load_with_sha(sha).err().as_deref(),
                Some("invalid metadata relationship"),
                "{sha} was accepted"
            );
        }
        for sha in ["a".repeat(40), "0123456789abcdef".repeat(4)] {
            assert!(load_with_sha(&sha).is_ok(), "{sha} was refused");
        }
    }

    // V2-2b acceptance `old_record_loads_without_config_dir`, with the broken-store cases: a record without the field
    // (version 1 or 2) loads as "Your own"; one with it keeps it through a save; a wrong type, a folder that is not
    // this home's `accounts/<agent>/<id>` for the session's agent, or on a shell session is refused.
    #[test]
    fn old_record_loads_without_config_dir() {
        // ACCOUNTPICK: a kept folder is one the registry names and the home really holds (the real path, as sessions store it).
        let home = fs::canonicalize(scratch("config-dir")).unwrap();
        fs::create_dir_all(home.join("accounts/codex/a1")).unwrap();
        fs::write(
            home.join("accounts.toml"),
            "version = 1\n[[accounts]]\nagent = \"codex\"\nid = \"a1\"\nlabel = \"회사 work\"\n",
        )
        .unwrap();
        let row = |kind: &str, extra: serde_json::Value| {
            let mut row = serde_json::json!({
                "id":"s1","kind":kind,"project":"/p","cwd":"/p","label":"","state":"exited",
                "agent_session_id":"c1","agent_version":null,"untested":false,"pid":null});
            row.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            row
        };
        let load_one = |version: u64, row: serde_json::Value| {
            fs::write(
                home.join("sessions.json"),
                serde_json::json!({"version":version,"sessions":[row]}).to_string(),
            )
            .unwrap();
            load(&home)
        };
        for version in [1, 2] {
            let sessions = load_one(version, row("claude", serde_json::json!({}))).unwrap();
            assert_eq!(sessions[0].config_dir, None);
        }
        let folder = home.join("accounts/codex/a1");
        let account = serde_json::json!({"config_dir":folder,"account":"회사 work"});
        let sessions = load_one(2, row("codex", account)).unwrap();
        let kept = |s: &Session| (s.config_dir.clone(), s.account.clone());
        let want = (Some(folder.clone()), Some("회사 work".to_string()));
        assert_eq!(kept(&sessions[0]), want);
        save(&home, sessions, BTreeMap::new()).unwrap();
        assert_eq!(kept(&load(&home).unwrap()[0]), want);
        let err = load_one(2, row("claude", serde_json::json!({"config_dir":7}))).unwrap_err();
        assert!(err.starts_with("invalid metadata:"), "{err}");
        let claude = home.join("accounts/claude/a1");
        for bad in [
            row(
                "claude",
                serde_json::json!({"config_dir":"accounts/claude/a1","account":"w"}),
            ),
            row(
                "claude",
                serde_json::json!({"config_dir":"/etc","account":"w"}),
            ),
            row(
                "codex",
                serde_json::json!({"config_dir":claude,"account":"w"}),
            ),
            row(
                "shell",
                serde_json::json!({"config_dir":claude,"account":"w"}),
            ),
            row("claude", serde_json::json!({"config_dir":claude})),
            row("claude", serde_json::json!({"account":"w"})),
            row(
                "claude",
                serde_json::json!({"config_dir":claude,"account":"w\u{1b}[2J"}),
            ),
        ] {
            assert_eq!(
                load_one(2, bad.clone()).unwrap_err(),
                "invalid metadata relationship"
            );
            // A refused file is left as it was.
            let kept: serde_json::Value =
                serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
            assert_eq!(kept["sessions"][0], bad);
        }
        let _ = fs::remove_dir_all(&home);
    }

    // Q9 zh-hant-J9-1: an accounts.toml that does not read at start keeps an account session's folder, account and
    // conversation (only this run does not resume it); an account gone from a list that reads clears them.
    #[test]
    fn unreadable_account_list_keeps_the_session_account() {
        let home = fs::canonicalize(scratch("registry-broken")).unwrap();
        let folder = home.join("accounts/codex/a1");
        fs::create_dir_all(&folder).unwrap();
        let listed =
            "version = 1\n[[accounts]]\nagent = \"codex\"\nid = \"a1\"\nlabel = \"work\"\n";
        let row = serde_json::json!({"version":2,"sessions":[{
            "id":"s1","kind":"codex","project":"/p","cwd":"/p","label":"","state":"exited",
            "agent_session_id":"c1","agent_version":null,"untested":false,"pid":null,
            "config_dir":folder,"account":"work"}]});
        fs::write(home.join("sessions.json"), row.to_string()).unwrap();
        let fields = |s: &Session| {
            (
                s.config_dir.clone(),
                s.account.clone(),
                s.agent_session_id.clone(),
            )
        };
        let want = (
            Some(folder.clone()),
            Some("work".to_string()),
            Some("c1".to_string()),
        );
        fs::write(home.join("accounts.toml"), "version = 1\n[[accounts").unwrap();
        let sessions = load(&home).unwrap();
        assert_eq!(fields(&sessions[0]), want);
        assert_eq!(sessions[0].state, SessionState::Exited);
        save(&home, sessions, BTreeMap::new()).unwrap();
        fs::write(home.join("accounts.toml"), listed).unwrap();
        let sessions = load(&home).unwrap();
        assert_eq!(fields(&sessions[0]), want);
        assert_eq!(sessions[0].state, SessionState::Resumable);
        fs::write(home.join("accounts.toml"), "version = 1\n").unwrap();
        assert_eq!(fields(&load(&home).unwrap()[0]), (None, None, None));
        let _ = fs::remove_dir_all(&home);
    }

    // v1b-40
    fn scratch(tag: &str) -> std::path::PathBuf {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("store-aside-{tag}-{}", new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        home
    }
    #[test]
    fn sessions_newer_version_set_aside() {
        let home = scratch("newer");
        // V2-1a: this core reads 1, 2 and 3 (ticket 752 round 2), so 4 is the newer core's.
        let bytes = br#"{"version":4,"sessions":{"shape":"from a newer core"}}"#;
        fs::write(home.join("sessions.json"), bytes).unwrap();
        assert!(load(&home).unwrap().is_empty());
        let kept = asides(&home);
        assert_eq!(kept.len(), 1);
        let (name, kept_bytes) = &kept[0];
        assert!(name.starts_with("sessions.json.v4."), "{name}");
        assert_eq!(kept_bytes, bytes);
        let mode = fs::metadata(home.join(name)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(!home.join("sessions.json").exists());
        // The next start finds no store and stays empty; the kept file is untouched.
        assert!(load(&home).unwrap().is_empty());
        assert_eq!(asides(&home), kept);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn malformed_store_still_refused() {
        let home = scratch("malformed");
        for bytes in [
            "{",
            "[]",
            r#"{"sessions":[]}"#,
            r#"{"version":"2","sessions":[]}"#,
            r#"{"version":-1,"sessions":[]}"#,
            r#"{"version":2.5,"sessions":[]}"#,
            r#"{"version":2,"sessions":{}}"#,
            r#"{"version":1,"sessions":{}}"#,
        ] {
            fs::write(home.join("sessions.json"), bytes).unwrap();
            assert!(load(&home).is_err(), "{bytes} was accepted");
            assert_eq!(
                fs::read_to_string(home.join("sessions.json")).unwrap(),
                bytes
            );
            assert!(asides(&home).is_empty(), "{bytes} was set aside");
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn aside_never_overwrites() {
        let home = scratch("collide");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Names this second and the next are already taken.
        for t in [now, now + 1] {
            fs::write(home.join(format!("sessions.json.v4.{t}.aside")), b"taken").unwrap();
        }
        for n in ['a', 'b'] {
            let bytes = format!(r#"{{"version":4,"n":"{n}"}}"#);
            fs::write(home.join("sessions.json"), &bytes).unwrap();
            assert!(load(&home).unwrap().is_empty());
        }
        let kept: Vec<Vec<u8>> = asides(&home).into_iter().map(|(_, b)| b).collect();
        assert_eq!(kept.len(), 4);
        assert_eq!(kept.iter().filter(|b| *b == b"taken").count(), 2);
        assert!(kept.contains(&br#"{"version":4,"n":"a"}"#.to_vec()));
        assert!(kept.contains(&br#"{"version":4,"n":"b"}"#.to_vec()));
        let _ = fs::remove_dir_all(&home);
    }

    // v1b-40 r2: a file swapped in after it was judged is not the one set aside.
    #[test]
    fn set_aside_refuses_a_file_other_than_the_judged_one() {
        let home = scratch("swapped");
        let path = home.join("sessions.json");
        fs::write(&path, br#"{"version":2}"#).unwrap();
        let judged = fs::symlink_metadata(&path).unwrap();
        fs::write(home.join("new"), br#"{"version":3}"#).unwrap();
        fs::rename(home.join("new"), &path).unwrap();
        assert_eq!(
            set_aside(&path, &judged, 2).err().as_deref(),
            Some("state file changed while it was set aside")
        );
        assert_eq!(fs::read(&path).unwrap(), br#"{"version":3}"#);
        assert!(asides(&home).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    // Q9 zh-hant-J9-2: a FIFO at sessions.json refuses the store at once (core start used to wait on it forever).
    #[test]
    fn a_fifo_store_is_refused_at_once() {
        let home = scratch("fifo");
        let c = std::ffi::CString::new(home.join("sessions.json").as_os_str().as_encoded_bytes())
            .unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let at = home.clone();
        std::thread::spawn(move || tx.send(load(&at).map(|_| ())));
        let loaded = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a FIFO read blocked");
        assert_eq!(loaded, Err("sessions.json: not a regular file".into()));
        let _ = fs::remove_dir_all(&home);
    }

    // Q9 zh-hant-J9-2 follow-up: a sessions.json kept as a link to a regular file loads.
    #[test]
    fn a_symlinked_store_loads() {
        let home = scratch("link-ok");
        let target = home.join("elsewhere.json");
        fs::write(&target, br#"{"version":2,"sessions":[]}"#).unwrap();
        std::os::unix::fs::symlink(&target, home.join("sessions.json")).unwrap();
        assert!(load(&home).unwrap().is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_symlinked_newer_store_is_refused_not_moved() {
        let home = scratch("link");
        let target = home.join("elsewhere.json");
        fs::write(&target, br#"{"version":3}"#).unwrap();
        std::os::unix::fs::symlink(&target, home.join("sessions.json")).unwrap();
        assert!(load(&home).is_err());
        assert!(
            fs::symlink_metadata(home.join("sessions.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(asides(&home).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    // Ticket 752: a dropped token row's record survives a save and load; one whose origin is not a token caller, or
    // whose conversation is not an id, refuses the store.
    #[test]
    fn token_conversations_round_trip_and_bad_ones_refuse_the_store() {
        let home = scratch("token-conv");
        let record = TokenConversation {
            kind: AgentKind::Claude,
            conversation: "c1".into(),
            origin: "token-a".into(),
        };
        save_all(&home, vec![], BTreeMap::new(), vec![record.clone()]).unwrap();
        let loaded = load_all(&home).unwrap();
        assert_eq!((loaded.2, loaded.3), (vec![record.clone()], false));
        // Round 2 (security MUST): a store with records is version 3, which an older core's `other_version` (unchanged,
        // reads 1 and 2) sets aside instead of loading; one without records stays version 2.
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
        assert_eq!(written["version"], TOKEN_VERSION);
        assert_eq!(other_version(&written), Some(TOKEN_VERSION));
        save_all(&home, vec![], BTreeMap::new(), vec![]).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
        assert_eq!(written["version"], VERSION);
        // An unknown higher version is set aside, not loaded.
        let mut newer = written.clone();
        newer["version"] = serde_json::json!(TOKEN_VERSION + 1);
        newer["token_conversations"] = serde_json::json!([record]);
        fs::write(home.join("sessions.json"), newer.to_string()).unwrap();
        let (rows, live, records, _) = load_all(&home).unwrap();
        assert!(rows.is_empty() && live.is_empty() && records.is_empty());
        assert!(kept_aside(&home, "sessions.json"));
        assert!(!home.join("sessions.json").exists());
        for bad in [("c1", "owner"), ("c1", "token-"), ("../x", "token-a")] {
            let record = TokenConversation {
                conversation: bad.0.into(),
                origin: bad.1.into(),
                ..record.clone()
            };
            save_all(&home, vec![], BTreeMap::new(), vec![record]).unwrap();
            assert!(load_all(&home).is_err(), "{bad:?}");
        }
        let _ = fs::remove_dir_all(&home);
    }

    // Ticket 752 round 3: records of version 3 aside files join the loaded ones by conversation id; an aside file that
    // is malformed, holds a bad record or is a link is skipped, and a version 4 aside file is not read.
    #[test]
    fn aside_token_records_merge_and_bad_aside_files_are_skipped() {
        let home = scratch("aside-merge");
        let record = |conversation: &str, origin: &str| TokenConversation {
            kind: AgentKind::Claude,
            conversation: conversation.into(),
            origin: origin.into(),
        };
        save_all(
            &home,
            vec![],
            BTreeMap::new(),
            vec![record("c1", "token-a")],
        )
        .unwrap();
        let aside = |name: &str, records: serde_json::Value| {
            let body =
                serde_json::json!({"version": 3, "sessions": [], "token_conversations": records});
            fs::write(home.join(name), body.to_string()).unwrap();
        };
        aside(
            "sessions.json.v3.1.aside",
            serde_json::json!([record("c1", "token-z"), record("c2", "token-b")]),
        );
        aside(
            "sessions.json.v3.2.aside",
            serde_json::json!([record("c3", "owner")]),
        );
        aside(
            "sessions.json.v4.3.aside",
            serde_json::json!([record("c4", "token-d")]),
        );
        fs::write(home.join("sessions.json.v3.4.aside"), "{").unwrap();
        std::os::unix::fs::symlink(
            home.join("sessions.json.v3.1.aside"),
            home.join("sessions.json.v3.5.aside"),
        )
        .unwrap();
        let (_, _, records, lost) = load_all(&home).unwrap();
        assert_eq!(
            records,
            vec![record("c1", "token-a"), record("c2", "token-b")]
        );
        assert!(
            lost,
            "ticket 961: a skipped aside file may have held origins"
        );
        let _ = fs::remove_dir_all(&home);
    }
    // Ticket 961 round 2: a full store and an aside of duplicates lose nothing; one new record over the cap does, and
    // a bad row keeps the file's valid records but marks the loss.
    #[test]
    fn aside_at_cap_and_bad_rows_mark_loss_only_when_origins_are_lost() {
        let home = scratch("aside-cap");
        let record = |conversation: &str, origin: &str| TokenConversation {
            kind: AgentKind::Claude,
            conversation: conversation.into(),
            origin: origin.into(),
        };
        let full: Vec<_> = (0..TOKEN_CONVERSATIONS)
            .map(|i| record(&format!("c{i}"), "token-a"))
            .collect();
        save_all(&home, vec![], BTreeMap::new(), full).unwrap();
        let aside = |records: serde_json::Value, sessions: serde_json::Value| {
            let body = serde_json::json!({"version": 3, "sessions": sessions, "token_conversations": records});
            fs::write(home.join("sessions.json.v3.1.aside"), body.to_string()).unwrap();
        };
        aside(
            serde_json::json!([record("c0", "token-b")]),
            serde_json::json!([]),
        );
        assert!(!load_all(&home).unwrap().3, "duplicates only: nothing lost");
        aside(
            serde_json::json!([record("new", "token-b")]),
            serde_json::json!([]),
        );
        assert!(
            load_all(&home).unwrap().3,
            "a new record over the cap is lost"
        );
        save_all(&home, vec![], BTreeMap::new(), vec![]).unwrap();
        aside(
            serde_json::json!([record("k1", "token-b")]),
            serde_json::json!([{"kind": "claude", "agent_session_id": "k2", "token_origin": "owner"}]),
        );
        let (_, _, records, lost) = load_all(&home).unwrap();
        assert_eq!(records, vec![record("k1", "token-b")]);
        assert!(lost, "a bad row may have held an origin");
        let _ = fs::remove_dir_all(&home);
    }

    // V2-1a
    const V1: &str = r#"{"version":1,"sessions":[{"id":"s1","kind":"shell","project":"/p","cwd":"/p","label":"",
        "state":"running","agent_session_id":null,"agent_version":null,"untested":false,"pid":42}]}"#;
    #[test]
    fn store_v1_reads_as_no_holder() {
        let home = scratch("v1");
        fs::write(home.join("sessions.json"), V1).unwrap();
        let (sessions, live) = load_live(&home).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].state, SessionState::Exited);
        assert_eq!(sessions[0].pid, None);
        assert!(live.is_empty());
        // A "v1" file naming live records is not one.
        let mut forged: serde_json::Value = serde_json::from_str(V1).unwrap();
        forged["live"] = serde_json::json!({"s1":{"token_sha256":"0".repeat(64),"holder":null}});
        fs::write(home.join("sessions.json"), forged.to_string()).unwrap();
        assert!(load_live(&home).is_err());
        let _ = fs::remove_dir_all(&home);
    }
    #[test]
    fn store_v1_backup_kept() {
        let home = scratch("v1-backup");
        fs::write(home.join("sessions.json"), V1).unwrap();
        let (sessions, _) = load_live(&home).unwrap();
        assert_eq!(
            fs::read(home.join("sessions.json.v1")).unwrap(),
            V1.as_bytes()
        );
        let mode = fs::metadata(home.join("sessions.json.v1"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        save(&home, sessions, BTreeMap::new()).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
        assert_eq!(written["version"], 2);
        // Once: a later v1 file (an older core ran again) never replaces the first copy.
        fs::write(home.join("sessions.json"), V1.replace("/p", "/q")).unwrap();
        load_live(&home).unwrap();
        assert_eq!(
            fs::read(home.join("sessions.json.v1")).unwrap(),
            V1.as_bytes()
        );
        // A v2 file is never copied; nothing else is left behind.
        let names: Vec<_> = fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let _ = fs::remove_dir_all(&home);
    }
    #[test]
    fn store_v2_live_records_round_trip_and_are_checked() {
        let home = scratch("v2");
        let mut sessions = {
            fs::write(home.join("sessions.json"), V1).unwrap();
            load_live(&home).unwrap().0
        };
        sessions[0].state = SessionState::Running;
        sessions[0].pid = Some(7);
        let live = Live {
            token_sha256: token_sha256("t"),
            holder: Some(crate::holder::Record {
                socket: "/h/holders/a.sock".into(),
                protocol: 1,
                pid: 9,
                started: 5,
            }),
            agent_started: Some(11),
            run_start: 0,
            launch_args: None,
            // V2-1b: the running row's pid, which loading clears from the row.
            agent_pid: Some(7),
        };
        save(
            &home,
            sessions,
            BTreeMap::from([("s1".to_string(), live.clone())]),
        )
        .unwrap();
        let (_, read) = load_live(&home).unwrap();
        assert_eq!(read["s1"], live);
        // SHA-256("t"), a known value.
        assert_eq!(
            live.token_sha256,
            "e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8"
        );
        let good: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
        for (path, bad) in [
            ("/live/s1/token_sha256", serde_json::json!("E3")),
            ("/live/s1/token_sha256", serde_json::json!(7)),
            ("/live/s1/holder/socket", serde_json::json!("relative.sock")),
        ] {
            let mut broken = good.clone();
            *broken.pointer_mut(path).unwrap() = bad;
            fs::write(home.join("sessions.json"), broken.to_string()).unwrap();
            assert!(load_live(&home).is_err(), "{path}");
            assert_eq!(
                fs::read_to_string(home.join("sessions.json")).unwrap(),
                broken.to_string()
            );
        }
        let mut orphan = good.clone();
        orphan["live"]["s2"] = orphan["live"]["s1"].clone();
        fs::write(home.join("sessions.json"), orphan.to_string()).unwrap();
        assert!(load_live(&home).is_err(), "a holder without its session");
        // A launch that never finished (hash saved, no row yet) is dropped.
        orphan["live"]["s2"]["holder"] = serde_json::Value::Null;
        fs::write(home.join("sessions.json"), orphan.to_string()).unwrap();
        assert_eq!(
            load_live(&home).unwrap().1.keys().collect::<Vec<_>>(),
            ["s1"]
        );
        let _ = fs::remove_dir_all(&home);
    }

    // v1b-07
    #[test]
    fn artifact_skill_load_refuses_an_artifact_folder_that_is_not_an_id() {
        let load_with = |artifacts: serde_json::Value| {
            let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.scratch")
                .join(format!(
                    "store-art-{}-{}",
                    std::process::id(),
                    artifacts.to_string().len()
                ));
            let _ = fs::remove_dir_all(&home);
            fs::create_dir_all(&home).unwrap();
            let record = serde_json::json!({"version":1,"sessions":[{
                "id":"s1","kind":"claude","project":"/p","cwd":"/p","label":"","state":"exited",
                "agent_session_id":"c1","agent_version":null,"untested":false,"pid":null,
                "artifacts":artifacts}]});
            let bytes = record.to_string();
            fs::write(home.join("sessions.json"), &bytes).unwrap();
            let out = load(&home);
            // A refused store is left as it was.
            assert_eq!(
                fs::read_to_string(home.join("sessions.json")).unwrap(),
                bytes
            );
            let _ = fs::remove_dir_all(&home);
            out
        };
        for bad in ["../s2", "", "a/b", "/abs"] {
            assert_eq!(
                load_with(bad.into()).err().as_deref(),
                Some("invalid metadata relationship"),
                "{bad} was accepted"
            );
        }
        assert!(load_with(7.into()).is_err(), "a number was accepted");
        let ok = load_with("s0".into()).unwrap();
        assert_eq!(ok[0].artifacts.as_deref(), Some("s0"));
        assert!(
            load_with(serde_json::Value::Null).unwrap()[0]
                .artifacts
                .is_none()
        );
    }
}

#[cfg(test)]
mod regular_tests {
    // Ticket 421 round 3: a FIFO with no writer is refused at once (a plain open waits for a writer forever), a folder
    // is refused, a regular file reads, and a missing one stays NotFound for the caller.
    #[test]
    fn read_regular_refuses_what_is_not_a_regular_file() {
        let dir = std::env::temp_dir().join(format!("ns-regular-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("fifo");
        let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        std::fs::write(dir.join("file"), b"ok").unwrap();
        let asked = std::time::Instant::now();
        let refused = super::read_regular(&fifo).unwrap_err();
        let took = asked.elapsed();
        let folder = super::read_regular(&dir).unwrap_err();
        let file = super::read_regular(&dir.join("file")).unwrap();
        let missing = super::read_regular(&dir.join("missing")).unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(refused.to_string(), "not a regular file");
        assert!(took < std::time::Duration::from_secs(1), "{took:?}");
        assert_eq!(folder.to_string(), "not a regular file");
        assert_eq!(file, b"ok");
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
    }
    /// v37-store-nofollow: a link at the path is refused like a FIFO, whatever it points at; only the following open
    /// reads through one. A file over the cap is an error, never cut short.
    #[test]
    fn read_regular_refuses_a_link_and_a_file_over_its_cap() {
        let dir = std::env::temp_dir().join(format!("ns-nofollow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file"), b"ok").unwrap();
        let c = std::ffi::CString::new(dir.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        for (link, target) in [
            ("to-file", "file"),
            ("to-fifo", "fifo"),
            ("dangling", "gone"),
        ] {
            std::os::unix::fs::symlink(dir.join(target), dir.join(link)).unwrap();
        }
        let refused = |name: &str| {
            let read = super::read_regular(&dir.join(name))
                .unwrap_err()
                .to_string();
            let open = super::open_regular(&dir.join(name))
                .unwrap_err()
                .to_string();
            (read, open)
        };
        let links = ["to-file", "to-fifo", "dangling"].map(refused);
        let followed = super::read_capped(
            super::open_regular_following(&dir.join("to-file")).unwrap(),
            2,
        );
        let at_cap = std::fs::File::create(dir.join("at-cap")).unwrap();
        at_cap.set_len(super::READ_MAX).unwrap();
        let over = std::fs::File::create(dir.join("over")).unwrap();
        over.set_len(super::READ_MAX + 1).unwrap();
        let at_cap = super::read_regular(&dir.join("at-cap")).map(|b| b.len() as u64);
        let over_default = super::read_regular(&dir.join("over")).unwrap_err();
        let over_own =
            super::read_capped(super::open_regular(&dir.join("file")).unwrap(), 1).unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        for (read, open) in &links {
            assert_eq!(
                (read.as_str(), open.as_str()),
                ("not a regular file", "not a regular file")
            );
        }
        assert_eq!(followed.unwrap(), b"ok");
        assert_eq!(at_cap.unwrap(), super::READ_MAX);
        assert_eq!(over_default.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(
            over_default.to_string(),
            "file is over the 1048576-byte read limit"
        );
        assert_eq!(over_own.to_string(), "file is over the 1-byte read limit");
    }
    /// v37-store-nofollow round 2: a write its reader could not read back is refused before anything is written.
    #[test]
    fn write_capped_refuses_what_its_reader_would_refuse() {
        let dir = std::env::temp_dir().join(format!("ns-capped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let at_cap = super::write_capped(&path, b"12345", 5);
        let over = super::write_capped(&path, b"123456", 5);
        let read = super::read_capped(super::open_regular(&path).unwrap(), 5);
        std::fs::remove_dir_all(&dir).unwrap();
        at_cap.unwrap();
        assert_eq!(
            over.unwrap_err(),
            "settings.json would be 6 bytes, over its 5-byte limit; nothing was written"
        );
        assert_eq!(read.unwrap(), b"12345");
    }
}
