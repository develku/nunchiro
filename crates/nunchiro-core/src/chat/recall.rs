//! Bot memory, layer 3: search over past conversations. The user's and the agents' words of every session the registry
//! lists are copied, secrets masked, into `memory-search/` in the Nunchiro home (one file per conversation, kept up to
//! date by each transcript's size and time), and a seat searches that copy with `nunchiro memory search`. Turning it
//! off deletes the folder; `forget` deletes the lines that hold a forgotten memory line and keeps them out after.
//! The agents' own transcripts stay theirs: this never changes or deletes them.
use super::{project, search};
use crate::{api::AgentKind, store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Seek, SeekFrom},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

/// The folder in the Nunchiro home; the seats' deny rules cover it (`sessions::memory::deny_memory`).
pub const DIR: &str = "memory-search";
pub(crate) const RULE: &str = "memory-search/**";
pub const OFF: &str =
    "search past conversations is off: the user turns it on in Bots, under Memory";
const MANIFEST: &str = "index.json";
const FORGOTTEN: &str = "forgotten.json";
/// `transcript::read_batch` reads 1 MiB from a line's start: a longer line is no chat event.
const LINE_MAX: usize = 1024 * 1024;
const HITS_MAX: usize = 20;

/// One refresh at a time; `FILES` is held per conversation written and by `forget`, so a forget never waits a whole
/// first build.
static REFRESH: Mutex<()> = Mutex::new(());
static FILES: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Manifest {
    updated_ms: u64,
    sessions: BTreeMap<String, Entry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    /// The transcript's bytes read, up to its last whole line, and its time then.
    read: u64,
    mtime_ms: u64,
    kind: AgentKind,
    label: String,
    lines: usize,
    bytes: u64,
}
/// One indexed line: the record's time, `user` or `assistant`, and the masked text on one line.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Line {
    at: String,
    role: String,
    text: String,
}

/// A conversation to index: a registry session and its checked transcript.
pub struct Source {
    pub id: String,
    pub kind: AgentKind,
    pub label: String,
    pub path: PathBuf,
}

/// The registry's conversations whose transcript the chat view would read (its path checks, ADR 0001).
pub fn sources(registry: &Mutex<crate::sessions::Sessions>) -> Result<Vec<Source>, String> {
    let crate::api::Reply::Snapshot { sessions, .. } = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .handle(crate::api::Request::List)?
    else {
        return Err("session list unavailable".into());
    };
    Ok(sessions
        .into_iter()
        .filter_map(|s| match search::transcript_of(&s, None) {
            Some(Ok(path)) => Some(Source {
                id: s.id,
                kind: s.kind,
                label: s.label,
                path,
            }),
            _ => None,
        })
        .collect())
}

/// `nunchiro memory search`, which `serve` answers.
pub(crate) fn asked(request: &crate::api::Request) -> bool {
    matches!(request, crate::api::Request::BotMemory { operation, .. } if operation == "search")
}

/// `nunchiro memory search` from a seat (its token), or the owner's own shell: the index brought up to date and
/// searched off the registry's lock; a hit from a conversation that read outside content marks the reader, as reading
/// that conversation would.
pub(crate) fn serve(
    registry: &Mutex<crate::sessions::Sessions>,
    sessions: std::sync::MutexGuard<'_, crate::sessions::Sessions>,
    owner: bool,
    token: &str,
    request: &crate::api::Request,
    home: &Path,
) -> crate::api::Response {
    let crate::api::Request::BotMemory { text: words, .. } = request else {
        return Err("not a memory request".into());
    };
    let reader = match owner {
        true => None,
        false => {
            let caller = sessions.agent_caller(token)?;
            sessions.check_agent(&caller, request)?;
            Some(caller.id)
        }
    };
    if !on(sessions.feature(crate::team::MEMORY_KEY).as_ref()) {
        return Err(OFF.into());
    }
    drop(sessions);
    refresh(home, &sources(registry)?, crate::queue::now_ms())?;
    let (hits, total) = find(home, words)?;
    let sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    if let Some(reader) = reader
        && let Some(source) = hits
            .iter()
            .filter_map(|h| sessions.read_outside(&h.session))
            .max()
    {
        crate::team::mark_outside(home, &reader, source)?;
    }
    Ok(crate::api::Reply::MemoryHits { hits, total })
}

/// The Memory group's line: on, how many conversations, how big, when.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Status {
    pub on: bool,
    pub conversations: usize,
    pub bytes: u64,
    /// 0: not built yet.
    pub updated_ms: u64,
}

/// A line that holds the search words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "MemoryHit"))]
pub struct Hit {
    pub session: String,
    pub label: String,
    pub kind: AgentKind,
    /// The transcript record's time, as the agent wrote it.
    pub at: String,
    pub role: String,
    /// The masked text around the first match, on one line.
    pub text: String,
}

fn dir(home: &Path) -> PathBuf {
    home.join(DIR)
}
fn file_of(home: &Path, id: &str) -> PathBuf {
    dir(home).join(format!("{id}.jsonl"))
}
fn read_json<T: Default + for<'a> Deserialize<'a>>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn lines_of(path: &Path) -> Vec<Line> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}
fn hash(line: &Line) -> String {
    store::token_sha256(&line.text)
}

/// Search is on unless the Bots view's Memory group turned it off (`team.memory.search`).
pub fn on(settings: Option<&crate::team::MemorySettings>) -> bool {
    settings.is_none_or(|s| s.search)
}

/// Turned off: the index goes, whole. A refresh running now stops writing.
pub fn clear(home: &Path) -> Result<(), String> {
    let _files = FILES.lock().map_err(|_| "memory search unavailable")?;
    match fs::remove_dir_all(dir(home)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn status(home: &Path, on: bool) -> Status {
    let m: Manifest = read_json(&dir(home).join(MANIFEST));
    Status {
        on,
        conversations: m.sessions.len(),
        bytes: m.sessions.values().map(|e| e.bytes).sum(),
        updated_ms: m.updated_ms,
    }
}

/// Brings the index up to `sources`: a transcript that grew is read from where the last refresh stopped, one that
/// shrank or changed time without growing is read again, and a conversation no longer listed leaves the index.
pub fn refresh(home: &Path, sources: &[Source], now_ms: u64) -> Result<(), String> {
    let _one = REFRESH.lock().map_err(|_| "memory search unavailable")?;
    // A refresh writes only while its folder is there: `clear` removed it under `FILES`, so this one stops.
    // shortcut: a refresh whose caller read "on" just before the owner turned it off makes the folder again; it is
    // deleted at the next off. Re-read the setting here if that is ever seen.
    store::private_dir(&dir(home))?;
    let live = || match dir(home).is_dir() {
        true => Ok(()),
        false => Err("search past conversations was turned off".to_string()),
    };
    let mut manifest: Manifest = read_json(&dir(home).join(MANIFEST));
    for source in sources {
        if !store::valid_id(&source.id) {
            continue;
        }
        let Ok(meta) = fs::metadata(&source.path) else {
            continue;
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let old = manifest.sessions.get(&source.id);
        if old.is_some_and(|e| e.mtime_ms == mtime_ms && e.read == meta.len()) {
            continue;
        }
        let from = old.filter(|e| e.read <= meta.len()).map_or(0, |e| e.read);
        let (new, read) = match extract(source.kind, &source.path, from) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("memory search: session {} not indexed: {e}", source.id);
                continue;
            }
        };
        let _files = FILES.lock().map_err(|_| "memory search unavailable")?;
        live()?;
        let forgotten: BTreeSet<String> = read_json(&dir(home).join(FORGOTTEN));
        let path = file_of(home, &source.id);
        let mut lines = if from == 0 { vec![] } else { lines_of(&path) };
        lines.extend(new.into_iter().filter(|l| !forgotten.contains(&hash(l))));
        let body: String = lines
            .iter()
            .filter_map(|l| serde_json::to_string(l).ok())
            .map(|l| l + "\n")
            .collect();
        store::atomic_write(&path, body.as_bytes())?;
        manifest.sessions.insert(
            source.id.clone(),
            Entry {
                read: from + read,
                mtime_ms,
                kind: source.kind,
                label: source.label.clone(),
                lines: lines.len(),
                bytes: body.len() as u64,
            },
        );
    }
    let _files = FILES.lock().map_err(|_| "memory search unavailable")?;
    live()?;
    let listed: BTreeSet<&str> = sources.iter().map(|s| s.id.as_str()).collect();
    manifest.sessions.retain(|id, _| {
        let keep = listed.contains(id.as_str());
        if !keep {
            let _ = fs::remove_file(file_of(home, id));
        }
        keep
    });
    manifest.updated_ms = now_ms;
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    store::atomic_write(&dir(home).join(MANIFEST), &bytes)
}

/// The user's and the agent's words in the transcript's whole lines after byte `from`, masked, and how many bytes
/// those lines took (a half-written last line is the next refresh's).
fn extract(kind: AgentKind, path: &Path, from: u64) -> Result<(Vec<Line>, u64), String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("transcript is not a regular file".into());
    }
    file.seek(SeekFrom::Start(from))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let (mut out, mut read, mut buf) = (vec![], 0u64, vec![]);
    loop {
        buf.clear();
        let got = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| e.to_string())?;
        if got == 0 || buf.last() != Some(&b'\n') {
            return Ok((out, read));
        }
        read += got as u64;
        if got > LINE_MAX {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let at = record["timestamp"].as_str().unwrap_or_default().to_string();
        for event in project(kind, &record) {
            let role = match (event["kind"].as_str(), event["role"].as_str()) {
                (Some("message"), Some(r @ ("user" | "assistant"))) => r,
                (Some("task_result"), _) => "assistant",
                _ => continue,
            };
            let Some(text) = event["text"].as_str().filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let one: String = text
                .chars()
                .map(|c| if c.is_whitespace() { ' ' } else { c })
                .collect();
            out.push(Line {
                at: at.clone(),
                role: role.into(),
                text: crate::team::mask_secrets(&one).0,
            });
        }
    }
}

/// The lines that hold `query` (ASCII case-insensitive), newest first, at most `HITS_MAX`, and how many matched.
pub fn find(home: &Path, query: &str) -> Result<(Vec<Hit>, usize), String> {
    let needle = search::check_query(query)?;
    let manifest: Manifest = read_json(&dir(home).join(MANIFEST));
    let mut hits = vec![];
    for (id, entry) in &manifest.sessions {
        for line in lines_of(&file_of(home, id)) {
            let lower = line.text.to_ascii_lowercase();
            let Some(at) = lower.find(&needle) else {
                continue;
            };
            hits.push(Hit {
                session: id.clone(),
                label: entry.label.clone(),
                kind: entry.kind,
                at: line.at,
                role: line.role,
                text: search::snippet(&line.text, at, needle.len()),
            });
        }
    }
    let total = hits.len();
    hits.sort_by(|a, b| b.at.cmp(&a.at));
    hits.truncate(HITS_MAX);
    Ok((hits, total))
}

/// A forgotten memory line leaves the index too: every indexed line that holds its text goes, and stays out when its
/// transcript is read again.
pub fn forget(home: &Path, text: &str) -> Result<(), String> {
    let needle = text.trim().to_lowercase();
    if needle.is_empty() || !dir(home).is_dir() {
        return Ok(());
    }
    let _files = FILES.lock().map_err(|_| "memory search unavailable")?;
    let forgotten_path = dir(home).join(FORGOTTEN);
    let mut forgotten: BTreeSet<String> = read_json(&forgotten_path);
    let mut manifest: Manifest = read_json(&dir(home).join(MANIFEST));
    let before = forgotten.len();
    for (id, entry) in manifest.sessions.iter_mut() {
        let path = file_of(home, id);
        let lines = lines_of(&path);
        let (gone, kept): (Vec<Line>, Vec<Line>) = lines
            .into_iter()
            .partition(|l| l.text.to_lowercase().contains(&needle));
        if gone.is_empty() {
            continue;
        }
        forgotten.extend(gone.iter().map(hash));
        let body: String = kept
            .iter()
            .filter_map(|l| serde_json::to_string(l).ok())
            .map(|l| l + "\n")
            .collect();
        store::atomic_write(&path, body.as_bytes())?;
        entry.lines = kept.len();
        entry.bytes = body.len() as u64;
    }
    if forgotten.len() == before {
        return Ok(());
    }
    let f = serde_json::to_vec(&forgotten).map_err(|e| e.to_string())?;
    store::atomic_write(&forgotten_path, &f)?;
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    store::atomic_write(&dir(home).join(MANIFEST), &bytes)
}

#[cfg(test)]
mod tests;
