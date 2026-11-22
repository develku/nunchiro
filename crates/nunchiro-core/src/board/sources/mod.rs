//! Read-only integration inputs, isolated from manual/session board persistence.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
pub const INTERVAL_FLOOR_SECS: u64 = 30;
const MAX_BYTES: u64 = 1024 * 1024;
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceDocument {
    pub version: u32,
    pub entries: Vec<Declaration>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Declaration {
    pub name: String,
    pub input: Input,
}
impl<'de> Deserialize<'de> for Declaration {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            name: String,
            kind: String,
            path: Option<PathBuf>,
            subject: Option<String>,
        }
        let r = Raw::deserialize(deserializer)?;
        let input = match (r.kind.as_str(), r.path, r.subject) {
            ("file", Some(path), None) => Input::File { path },
            ("command", None, Some(subject)) => Input::Command { subject },
            _ => {
                return Err(serde::de::Error::custom(
                    "file needs path only; command needs subject only",
                ));
            }
        };
        Ok(Self {
            name: r.name,
            input,
        })
    }
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    File { path: PathBuf },
    Command { subject: String },
}
impl SourceDocument {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("unsupported sources version".into());
        }
        if self.entries.len() > 64 {
            return Err("at most 64 integration sources".into());
        }
        let mut names = BTreeSet::new();
        for d in &self.entries {
            if !crate::store::valid_id(&d.name) || !names.insert(&d.name) {
                return Err("invalid or duplicate integration source name".into());
            }
            match &d.input {
                Input::File { path } if !path.is_absolute() => {
                    return Err("integration source path must be absolute".into());
                }
                Input::Command { subject } if !crate::approval::valid_name(subject) => {
                    return Err("invalid integration source subject".into());
                }
                _ => {}
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceState {
    pub name: String,
    pub error: Option<String>,
    pub running: bool,
}
type SubjectMetadata = Result<
    (
        Vec<crate::approval::FileStamp>,
        Option<(i64, i64, u64, u64, i64, i64)>,
    ),
    String,
>;
struct CommandResult {
    subject: String,
    metadata: SubjectMetadata,
    proof_hash: Option<String>,
    interval: std::time::Duration,
    started: Option<std::time::Instant>,
    result: Result<Option<Vec<serde_json::Value>>, String>,
}
#[derive(Default)]
struct Runtime {
    command: Option<std::sync::mpsc::Receiver<CommandResult>>,
    last_run: Option<std::time::Instant>,
    checked: Option<SubjectMetadata>,
    proof_hash: Option<String>,
    last_check: Option<std::time::Instant>,
    interval: Option<std::time::Duration>,
    moved: BTreeMap<String, String>,
    cards: Vec<serde_json::Value>,
    error: Option<String>,
    stamp: Option<(i64, i64, u64, u64, i64, i64)>,
}
#[derive(Default)]
struct Home {
    config_stamp: Option<(i64, i64, u64, u64, i64, i64)>,
    declarations: Vec<Declaration>,
    sources: BTreeMap<String, Runtime>,
    /// S9 r3: `fingerprint` after the last merge.
    seen: u64,
}
static HOMES: OnceLock<Mutex<BTreeMap<PathBuf, Home>>> = OnceLock::new();
/// S9 r3: moves whenever a merge finds a home's sources changed (new cards, an error, a finished command run).
static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// S9 r3: what the board's cards read of each source and the board files' stamps, cheaply: a file's stamp, a command's last run, errors, the card
/// count and local moves (new cards come with a new stamp or a new run).
fn fingerprint(home: &Path, state: &Home) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    // The board files too: an outside edit wakes the idle tick, whose board key holds their stamps.
    for file in ["board.json", "board.toml"] {
        fs::symlink_metadata(home.join(file))
            .ok()
            .map(|m| stamp(&m))
            .hash(&mut h);
    }
    for d in &state.declarations {
        d.name.hash(&mut h);
        if let Some(r) = state.sources.get(&d.name) {
            (
                &r.stamp,
                &r.error,
                r.cards.len(),
                r.last_run,
                r.command.is_some(),
                &r.moved,
            )
                .hash(&mut h);
        }
    }
    h.finish()
}
/// S9 r3: for the core's board key: the sources' revision and each declared file source's stamp, so a changed source is
/// observed at the next refresh, never on the idle board clock. One `lstat` per file source.
pub(crate) type Key = (u64, Vec<Option<(i64, i64, u64, u64, i64, i64)>>);
pub(crate) fn key(home: &Path) -> Key {
    let homes = HOMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let stamps = homes.get(home).map_or(vec![], |state| {
        state
            .declarations
            .iter()
            .filter_map(|d| match &d.input {
                Input::File { path } => Some(fs::symlink_metadata(path).ok().map(|m| stamp(&m))),
                Input::Command { .. } => None,
            })
            .collect()
    });
    (REVISION.load(std::sync::atomic::Ordering::SeqCst), stamps)
}
fn stamp(m: &fs::Metadata) -> (i64, i64, u64, u64, i64, i64) {
    (
        m.mtime(),
        m.mtime_nsec(),
        m.ino(),
        m.len(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("line 1: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("line 1: integration source must be a regular file".into());
    }
    let mut bytes = vec![];
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("line 1: integration source exceeds 1 MiB".into());
    }
    Ok(bytes)
}
#[derive(Deserialize)]
struct Cards {
    cards: Vec<Card>,
}
#[derive(Deserialize, Serialize)]
struct Card {
    id: String,
    title: String,
    updated_at: u64,
    column: Option<String>,
    url: Option<String>,
    project: Option<String>,
    note: Option<String>,
    needs_decision: Option<Decision>,
}
#[derive(Deserialize, Serialize)]
struct Decision {
    question: String,
}
pub fn parse(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("line 1: integration source exceeds 1 MiB".into());
    }
    let doc: Cards =
        serde_json::from_slice(bytes).map_err(|e| format!("line {}: {}", e.line(), e))?;
    if doc.cards.len() > 4096 {
        return Err("line 1: at most 4096 cards".into());
    }
    let mut ids = BTreeSet::new();
    let mut cards = vec![];
    for c in doc.cards {
        if c.id.trim().is_empty() || c.id.len() > 256 || !ids.insert(c.id.clone()) {
            return Err("line 1: invalid or duplicate card id".into());
        }
        if c.title.trim().is_empty()
            || c.title.len() > 256
            || c.note.as_ref().is_some_and(|s| s.len() > 65536)
            || c.project.as_ref().is_some_and(|s| s.len() > 4096)
            || c.column.as_ref().is_some_and(|s| s.len() > 256)
            || c.needs_decision
                .as_ref()
                .is_some_and(|d| d.question.trim().is_empty() || d.question.len() > 65536)
        {
            return Err("line 1: invalid card text".into());
        }
        if let Some(url) = &c.url {
            let uri = url
                .parse::<tungstenite::http::Uri>()
                .map_err(|_| "line 1: invalid card URL")?;
            if url.len() > 8192
                || !matches!(uri.scheme_str(), Some("http" | "https"))
                || uri.authority().is_none()
                || uri.host().is_none_or(str::is_empty)
            {
                return Err("line 1: URL must use http or https with a host".into());
            }
        }
        cards.push(serde_json::to_value(c).map_err(|e| e.to_string())?);
    }
    Ok(cards)
}
fn merge_inner(
    home: &Path,
    columns: &[super::Column],
    cards: &mut Vec<serde_json::Value>,
    background: bool,
) -> Vec<SourceState> {
    let mut homes = HOMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let state = homes.entry(home.to_path_buf()).or_default();
    let path = home.join("board.toml");
    if let Ok(meta) = fs::symlink_metadata(&path) {
        let next = stamp(&meta);
        if state.config_stamp != Some(next) {
            // Only accepted whole documents may replace declarations.
            if let Ok(bytes) = read(&path)
                && let Ok(text) = std::str::from_utf8(&bytes)
                && let Ok((_, sources)) = super::config::parse_document(text)
            {
                let next = sources.map_or(vec![], |s| s.entries);
                for d in &next {
                    if state.declarations.iter().find(|old| old.name == d.name) != Some(d)
                        && let Some(r) = state.sources.get_mut(&d.name)
                    {
                        r.cards.clear();
                        r.error = None;
                        r.stamp = None;
                        r.last_run = None;
                        r.last_check = None;
                        r.checked = None;
                        r.proof_hash = None;
                        r.interval = None;
                        r.moved.clear();
                    }
                }
                state
                    .sources
                    .retain(|name, _| next.iter().any(|d| d.name == *name));
                state.declarations = next;
            }
            state.config_stamp = Some(next);
        }
    }
    if !path.exists() {
        state.declarations.clear();
        state.sources.clear();
        state.config_stamp = None;
    }
    let mut statuses = vec![];
    for d in &state.declarations {
        let runtime = state.sources.entry(d.name.clone()).or_default();
        match &d.input {
            Input::File { path } => {
                let next = fs::symlink_metadata(path).map(|m| stamp(&m));
                if next.as_ref().ok() != runtime.stamp.as_ref() || next.is_err() {
                    match read(path).and_then(|b| parse(&b)) {
                        Ok(c) => {
                            runtime
                                .moved
                                .retain(|id, _| c.iter().any(|card| card["id"] == *id));
                            runtime.cards = c;
                            runtime.error = None;
                        }
                        Err(e) => runtime.error = Some(e),
                    }
                    runtime.stamp = next.ok();
                }
            }
            Input::Command { subject } => poll_command(home, subject, runtime, background),
        }
        // S9 r3: the background pass only reads; its cards would be dropped.
        for c in runtime.cards.iter().filter(|_| !background) {
            let mut c = c.clone();
            if let Some(column) = runtime.moved.get(c["id"].as_str().unwrap_or("")) {
                c["column"] = column.clone().into();
            }
            c["source"] = "integration".into();
            c["source_name"] = d.name.clone().into();
            if !columns.iter().any(|column| c["column"] == column.id) {
                c["column"] = columns[0].id.clone().into();
            }
            cards.push(c);
        }
        statuses.push(SourceState {
            name: d.name.clone(),
            error: runtime.error.clone(),
            running: runtime.command.is_some(),
        });
    }
    // S9 r3: a change wakes the core's idle tick, whose board key then moves (`key`).
    let now = fingerprint(home, state);
    if now != state.seen {
        state.seen = now;
        REVISION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        crate::pty::wake_windows();
    }
    statuses
}

fn subject_metadata(home: &Path, subject: &str) -> SubjectMetadata {
    let files = crate::approval::source_metadata(home, subject)?;
    let approvals = match fs::symlink_metadata(home.join("approvals.json")) {
        Ok(meta) => Some(stamp(&meta)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    Ok((files, approvals))
}
fn poll_command(home: &Path, subject: &str, runtime: &mut Runtime, background: bool) {
    let metadata = subject_metadata(home, subject);
    if let Some(receiver) = &runtime.command {
        match receiver.try_recv() {
            Ok(outcome) => {
                if outcome.subject == subject {
                    runtime.last_run = outcome.started.or(runtime.last_run);
                    if outcome.metadata == metadata {
                        runtime.checked = Some(metadata.clone());
                        runtime.proof_hash = outcome.proof_hash;
                        runtime.interval = Some(outcome.interval);
                        match outcome.result {
                            Ok(Some(cards)) => {
                                runtime.cards = cards;
                                runtime.error = None;
                            }
                            Ok(None) => runtime.error = None,
                            Err(e) => runtime.error = Some(e),
                        }
                    }
                }
                runtime.command = None;
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                runtime.command = None;
                runtime.error = Some("integration source worker disconnected".into());
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
    }
    let changed = runtime.checked.as_ref() != Some(&metadata);
    if changed {
        runtime.proof_hash = None;
        runtime.error =
            Some("needs approval: integration source changed; checking approval".into());
    }
    if let Err(e) = &metadata {
        runtime.error = Some(format!("needs approval: {e}"));
        runtime.checked = Some(metadata);
        return;
    }
    if runtime.command.is_some() {
        return;
    }
    let interval = runtime
        .interval
        .unwrap_or(std::time::Duration::from_secs(INTERVAL_FLOOR_SECS));
    let due = runtime
        .last_run
        .is_none_or(|last| last.elapsed() >= interval);
    if !changed
        && (runtime.proof_hash.is_none()
            || !due
            || (background
                && runtime
                    .last_check
                    .is_some_and(|last| last.elapsed() < interval)))
    {
        return;
    }
    runtime.last_check = Some(std::time::Instant::now());
    let (send, receive) = std::sync::mpsc::channel();
    runtime.command = Some(receive);
    let home = home.to_path_buf();
    let subject = subject.to_string();
    std::thread::spawn(move || {
        let result = check_command(&home, &subject, due);
        let _ = send.send(result);
    });
}
fn check_command(home: &Path, subject: &str, due: bool) -> CommandResult {
    let mut outcome = CommandResult {
        subject: subject.into(),
        metadata: subject_metadata(home, subject),
        proof_hash: None,
        interval: std::time::Duration::from_secs(INTERVAL_FLOOR_SECS),
        started: None,
        result: Ok(None),
    };
    outcome.result = (|| {
        outcome.metadata.as_ref().map_err(Clone::clone)?;
        // Full bytes and approval are checked only in this worker, immediately before a run.
        let proof = crate::approval::check_source(home, subject)
            .map_err(|e| format!("needs approval: {e}"))?;
        if proof.manifest().kind != "integration" {
            return Err("integration source manifest kind must be integration".into());
        }
        if subject_metadata(home, subject) != outcome.metadata {
            return Err("needs approval: integration source changed during check".into());
        }
        outcome.proof_hash = Some(proof.hash().to_string());
        outcome.interval = std::time::Duration::from_secs(
            proof
                .interval_secs()
                .unwrap_or(INTERVAL_FLOOR_SECS)
                .max(INTERVAL_FLOOR_SECS),
        );
        if !due {
            return Ok(None);
        }
        let user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME missing; sandbox disabled")?;
        let cache = home.join("sources").join(subject).join("cache");
        let profile = crate::sandbox::Profile::new(home.to_path_buf(), cache, user_home);
        outcome.started = Some(std::time::Instant::now());
        crate::sandbox::run(&profile, &proof)
            .and_then(|b| parse(&b))
            .map(Some)
    })();
    outcome
}

/// Local position only; the source file and approved command inputs remain read-only.
pub fn move_card(home: &Path, name: &str, id: &str, column: &str) -> Result<(), String> {
    let disk = super::persistence::Disk::load(home)?;
    super::require_column(&disk.columns, column)?;
    let mut homes = HOMES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "integration source state unavailable")?;
    let state = homes.get_mut(home).ok_or("integration source not found")?;
    let source = state
        .sources
        .get_mut(name)
        .ok_or("integration source not found")?;
    if !source.cards.iter().any(|c| c["id"] == id) {
        return Err("integration source card not found".into());
    }
    source.moved.insert(id.into(), column.into());
    Ok(())
}

/// Start the core-lifetime polling worker once a board has registered its home.
pub fn merge(
    home: &Path,
    columns: &[super::Column],
    cards: &mut Vec<serde_json::Value>,
) -> Vec<SourceState> {
    static TIMER: std::sync::Once = std::sync::Once::new();
    TIMER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                // S9 r3: 100 ms (was 250): this pass is what notices a changed source or board file while the
                // core's tick idles at 250 ms, and wakes it (`merge_inner`).
                std::thread::sleep(std::time::Duration::from_millis(100));
                let homes = {
                    let mut homes = HOMES
                        .get_or_init(Default::default)
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    homes.retain(|home, _| home.is_dir());
                    homes.keys().cloned().collect::<Vec<_>>()
                };
                for home in homes {
                    let mut ignored = vec![];
                    merge_inner(&home, &super::defaults(), &mut ignored, true);
                }
            }
        });
    });
    merge_inner(home, columns, cards, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn board_sources_foreground_snapshot_never_reads_command_bytes() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "source-no-read-{}",
                crate::store::new_id().unwrap()
            ));
        fs::create_dir_all(home.join("sources/demo")).unwrap();
        fs::write(
            home.join("sources/demo/widget.toml"),
            "version=1\nkind='integration'\ncommand=['/usr/bin/true']\n",
        )
        .unwrap();
        fs::write(home.join("sources/demo/payload"), vec![b'x'; 1024 * 1024]).unwrap();
        fs::write(home.join("board.toml"),"version=1\n[[columns]]\nid='working'\ntitle='Working'\n[sources]\nversion=1\n[[sources.entries]]\nname='demo'\nkind='command'\nsubject='demo'\n").unwrap();
        let before = crate::approval::read_count();
        super::super::handle(&home, &[], crate::api::Request::BoardSnapshot).unwrap();
        assert_eq!(
            crate::approval::read_count(),
            before,
            "foreground hashed command bytes"
        );
        fs::write(home.join("sources/demo/payload"), "changed").unwrap();
        super::super::handle(&home, &[], crate::api::Request::BoardSnapshot).unwrap();
        assert_eq!(
            crate::approval::read_count(),
            before,
            "foreground read changed command bytes"
        );
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn board_sources_session_authority_cannot_status_grant_or_move() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "source-authority-{}",
                crate::store::new_id().unwrap()
            ));
        fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let mut sessions = crate::sessions::Sessions::open(&home).unwrap();
        let caller = crate::grants::Caller {
            id: "fixture".into(),
            project: home.clone(),
        };
        for request in [
            crate::api::Request::BoardSourceStatus {
                name: "demo".into(),
            },
            crate::api::Request::BoardSourceGrant {
                name: "demo".into(),
                level: crate::approval::Level::Read,
                hash: "a".repeat(64),
            },
            crate::api::Request::BoardSourceMove {
                name: "demo".into(),
                id: "card".into(),
                column: "done".into(),
            },
        ] {
            assert_eq!(
                sessions.handle_agent(&caller, request).unwrap_err(),
                "operation not granted"
            );
        }
        drop(sessions);
        fs::remove_dir_all(home).unwrap();
    }
}
