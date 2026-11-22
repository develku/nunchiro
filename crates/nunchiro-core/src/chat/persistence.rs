use super::{
    Event, Page, artifacts,
    log::{Log, Position},
    tested,
};
use crate::{api::AgentKind, store, waiting::transcript};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
const META_LIMIT: u64 = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct State {
    pub(super) version: u32,
    pub(super) generation: u64,
    pub(super) key: String,
    pub(super) offset: u64,
    pub(super) discarding: bool,
    pub(super) fingerprint: Option<[u64; 2]>,
    pub(super) events: Position,
    pub(super) skipped: u64,
    #[serde(flatten)]
    pub(super) extra: BTreeMap<String, Value>,
}
#[derive(Clone, Serialize, Deserialize)]
struct FinalState {
    version: u32,
    log: Position,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let mut f = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > META_LIMIT {
        return Err("invalid or oversized chat metadata".into());
    }
    let mut bytes = vec![];
    f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("invalid chat metadata: {e}"))
}
pub(super) struct Stops {
    path: PathBuf,
    lock: PathBuf,
    state: FinalState,
    log: Log,
}
impl Stops {
    pub fn open(dir: &Path, id: &str) -> Result<Self, String> {
        let path = dir.join(format!("{id}.stops.json"));
        let state = match read_json::<FinalState>(&path)? {
            Some(s) if s.version == 1 => s,
            Some(_) => return Err("unsupported Stop store version".into()),
            None => FinalState {
                version: 1,
                log: Position {
                    id: store::new_id()?,
                    count: 0,
                    end: 0,
                },
                extra: BTreeMap::new(),
            },
        };
        let log = Log::open(dir, state.log.clone())?;
        Ok(Self {
            path,
            lock: dir.join(format!("{id}.stops.lock")),
            state,
            log,
        })
    }
    pub fn append(&mut self, turn: &str, text: &str) -> Result<(), String> {
        if turn.is_empty() {
            return Err("missing chat turn id".into());
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.lock)
            .map_err(|e| e.to_string())?;
        if !lock.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("invalid Stop lock".into());
        }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if let Some(state) = read_json::<FinalState>(&self.path)? {
            if state.version != 1 {
                return Err("unsupported Stop store version".into());
            }
            if state.log.count != self.state.log.count || state.log.id != self.state.log.id {
                self.log = Log::open(self.path.parent().unwrap(), state.log.clone())?;
                self.state = state;
            }
        }
        let mut found = false;
        self.log.each(|e| {
            found |= e.data["turn_id"] == turn;
            Ok(())
        })?;
        if found {
            return Ok(());
        }
        let mut next = self.log.clone();
        next.append([json!({"kind":"final_text","turn_id":turn,"text":text})])?;
        let mut state = self.state.clone();
        state.log = next.position.clone();
        store::atomic_write(
            &self.path,
            &serde_json::to_vec(&state).map_err(|e| e.to_string())?,
        )?;
        self.log = next;
        self.state = state;
        Ok(())
    }
    pub fn page(
        &self,
        kind: AgentKind,
        version: Option<&str>,
        before: Option<u64>,
        after: Option<u64>,
        generation: u64,
        skipped: u64,
    ) -> Result<Page, String> {
        let end = self.log.position.count + 1;
        let banner = Event {
            schema_version: 1,
            cursor: 1,
            data: json!({"kind":"version_banner","agent":kind,"version":version.unwrap_or("unknown")}),
        };
        let (start, stop, newest) = bounds(end, before, after)?;
        let mut events = self
            .log
            .range(start.saturating_sub(1), stop.saturating_sub(1), newest)?;
        for event in &mut events {
            event.cursor += 1;
        }
        if start == 0 {
            events.insert(0, banner.clone());
            if events.len() > 200 {
                if newest {
                    events.remove(0);
                } else {
                    events.pop();
                }
            }
        }
        let before = events
            .first()
            .and_then(|e| (e.cursor > 1).then_some(e.cursor));
        Ok(Page {
            schema_version: 1,
            generation,
            events,
            before: if after.is_some() { None } else { before },
            end,
            banner: Some(banner),
            no_transcript: None,
            skipped,
        })
    }
}
pub(super) struct StopSlot {
    pub value: Mutex<Option<Stops>>,
    pub busy: std::sync::atomic::AtomicBool,
}
impl Default for StopSlot {
    fn default() -> Self {
        Self {
            value: Mutex::new(None),
            busy: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
pub struct Store {
    dir: PathBuf,
    id: String,
    path: PathBuf,
    state: State,
    events: Log,
    pub(super) stops: Arc<StopSlot>,
}
impl Store {
    pub fn open(home: &Path, id: &str) -> Result<Self, String> {
        Self::open_with_stops(home, id, Arc::default())
    }
    pub(super) fn open_with_stops(
        home: &Path,
        id: &str,
        stops: Arc<StopSlot>,
    ) -> Result<Self, String> {
        if !store::valid_id(
            id.strip_prefix("claude-")
                .or_else(|| id.strip_prefix("codex-"))
                .or_else(|| id.strip_prefix("shell-"))
                .unwrap_or(id),
        ) {
            return Err("invalid chat session id".into());
        }
        let dir = home.join("chat");
        store::private_dir(&dir)?;
        let path = dir.join(format!("{id}.json"));
        let state = if path.exists() && super::legacy::version(&path)? == 1 {
            super::legacy::migrate(&dir, id, &path, &stops)?
        } else {
            match read_json::<State>(&path)? {
                Some(s) => s,
                None => State {
                    version: 2,
                    generation: 0,
                    key: String::new(),
                    offset: 0,
                    discarding: false,
                    fingerprint: None,
                    events: Position {
                        id: store::new_id()?,
                        count: 0,
                        end: 0,
                    },
                    skipped: 0,
                    extra: BTreeMap::new(),
                },
            }
        };
        if state.version != 2
            || state.extra.contains_key("feed")
            || state.extra.contains_key("finals")
            || (state.key.is_empty() && (state.offset != 0 || state.discarding))
        {
            return Err("invalid or unsupported chat metadata".into());
        }
        let events = Log::open(&dir, state.events.clone())?;
        Ok(Self {
            dir,
            id: id.into(),
            path,
            state,
            events,
            stops,
        })
    }
    fn save(&mut self, mut state: State, events: Log) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
        // Q9 ja-J19-1: read_json refuses a file over META_LIMIT; drop the open turn's file list rather than write one.
        if bytes.len() as u64 > META_LIMIT && state.extra.remove("turn_files").is_some() {
            bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
        }
        store::atomic_write(&self.path, &bytes)?;
        if self.events.position.id != events.position.id {
            self.events.remove();
        }
        self.state = state;
        self.events = events;
        Ok(())
    }
    pub fn stop(&mut self, turn: &str, text: &str) -> Result<(), String> {
        self.with_stops(|s| s.append(turn, text))?;
        if !self.path.exists() {
            self.save(self.state.clone(), self.events.clone())?;
        }
        Ok(())
    }
    fn with_stops<T>(&self, f: impl FnOnce(&mut Stops) -> Result<T, String>) -> Result<T, String> {
        let mut slot = self
            .stops
            .value
            .lock()
            .map_err(|_| "Stop store unavailable")?;
        if slot.is_none() {
            *slot = Some(Stops::open(&self.dir, &self.id)?);
        }
        f(slot.as_mut().unwrap())
    }
    pub fn refresh(&mut self, kind: AgentKind, path: &Path) -> Result<(), String> {
        self.refresh_with(kind, path, None)
    }
    // v1b-06: with a context, artifact events follow the events that confirm them. A cache indexed without
    // artifacts (no `artifacts` key, as main wrote it) starts a new generation once, so its history backfills.
    pub fn refresh_with(
        &mut self,
        kind: AgentKind,
        path: &Path,
        artifacts: Option<&artifacts::Context>,
    ) -> Result<(), String> {
        // Ticket 383: a Codex cache indexed before injected blocks were dropped re-reads once, so a resumed chat loses them.
        let backfill = !self.state.key.is_empty()
            && ((artifacts.is_some() && !self.state.extra.contains_key("artifacts"))
                || (kind == AgentKind::Codex && !self.state.extra.contains_key("codex_injected"))
                // Ticket 409: a cache that counted bookkeeping records as skipped re-reads once without them.
                || (self.state.skipped > 0 && !self.state.extra.contains_key("skip_409")));
        // end v1b-06
        let mut source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| e.to_string())?;
        let meta = source.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("transcript is not a regular file".into());
        }
        let key = format!("{}:{}:{}", path.display(), meta.dev(), meta.ino());
        let changed = !self.state.key.is_empty()
            && (key != self.state.key
                || meta.len() < self.state.offset
                || self.state.fingerprint != Some(fingerprint(&mut source, self.state.offset)?));
        if changed || backfill
        /* v1b-06 */
        {
            let mut state = self.state.clone();
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or("chat generation overflow")?;
            state.key = String::new();
            state.offset = 0;
            state.discarding = false;
            state.fingerprint = None;
            state.skipped = 0;
            state.extra.remove("turn_files"); // ticket 222: a re-read starts with no open turn
            let events = Log::fresh(&self.dir)?;
            state.events = events.position.clone();
            self.save(state, events)?;
        }
        // The file keyed above, not a reopen by name: an agent's rotation (one rename) mid-index is seen by the next read.
        while let Some(batch) = transcript::read_batch_from(
            &source,
            path,
            &self.state.key,
            self.state.offset,
            self.state.discarding,
        )? {
            let mut state = self.state.clone();
            let mut events = self.events.clone();
            let mut values = vec![];
            let mut skipped = batch.skipped;
            // Ticket 222: the open turn's paths carry over between batches, so its finished turn event lists them.
            let mut turns: super::turn_files::Tracker = (state.extra.get("turn_files").cloned())
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            for record in batch.records {
                for event in turns.project(kind, &record) {
                    if event["kind"] == "skipped" {
                        skipped += 1;
                        continue;
                    }
                    // v1b-06: a block's bytes are saved before its event; a failed save shows no card.
                    let found = artifacts.map(|ctx| {
                        artifacts::detect(&event, |id| tool_use(&values, &events, id), ctx)
                    });
                    values.push(event);
                    for f in found.into_iter().flatten() {
                        let saved = match &f.block {
                            Some(bytes) => artifacts::save(
                                self.dir.parent().unwrap_or(&self.dir),
                                f.event["path"].as_str().unwrap_or_default(),
                                bytes,
                            ),
                            None => Ok(()),
                        };
                        if saved.is_ok() {
                            values.push(f.event);
                        }
                    }
                    // end v1b-06
                }
            }
            if skipped > 0 {
                values.push(json!({"kind":"skipped","count":skipped}));
            }
            if !values.is_empty() {
                events.append(values)?;
            }
            state.generation = state.generation.max(1);
            state.key = batch.key;
            state.offset = batch.end;
            state.discarding = batch.discarding;
            state.fingerprint = Some(fingerprint(&mut source, state.offset)?);
            state.events = events.position.clone();
            state.skipped = state.skipped.saturating_add(skipped);
            state.extra.insert("turn_files".into(), json!(turns)); // ticket 222
            if artifacts.is_some() {
                state.extra.insert("artifacts".into(), json!(1)); // v1b-06
            }
            if kind == AgentKind::Codex {
                state.extra.insert("codex_injected".into(), json!(1)); // ticket 383
            }
            state.extra.insert("skip_409".into(), json!(1));
            self.save(state, events)?;
        }
        Ok(())
    }
    pub fn page(
        &self,
        kind: AgentKind,
        version: Option<&str>,
        versions: &[(AgentKind, &str)],
        before: Option<u64>,
    ) -> Result<Page, String> {
        self.query(kind, version, versions, before, None)
    }
    pub fn since(
        &self,
        kind: AgentKind,
        version: Option<&str>,
        versions: &[(AgentKind, &str)],
        after: u64,
    ) -> Result<Page, String> {
        self.query(kind, version, versions, None, Some(after))
    }
    fn query(
        &self,
        kind: AgentKind,
        version: Option<&str>,
        versions: &[(AgentKind, &str)],
        before: Option<u64>,
        after: Option<u64>,
    ) -> Result<Page, String> {
        if !tested(kind, version, versions) {
            return self.with_stops(|s| {
                s.page(
                    kind,
                    version,
                    before,
                    after,
                    self.state.generation,
                    self.state.skipped,
                )
            });
        }
        let end = self.events.position.count;
        let (start, stop, newest) = bounds(end, before, after)?;
        let events = self.events.range(start, stop, newest)?;
        let before = events
            .first()
            .and_then(|e| (e.cursor > 1).then_some(e.cursor));
        Ok(Page {
            schema_version: 1,
            generation: self.state.generation,
            events,
            before: if after.is_some() { None } else { before },
            end,
            banner: None,
            no_transcript: None,
            skipped: self.state.skipped,
        })
    }
    pub fn generation(&self) -> u64 {
        self.state.generation
    }
}
// v1b-06: the call of a tool result, in this batch or among the last 200 indexed events.
fn tool_use(values: &[Value], events: &Log, id: &str) -> Option<Value> {
    let is = |d: &Value| d["kind"] == "tool_use" && d["tool_id"] == id;
    values.iter().rev().find(|d| is(d)).cloned().or_else(|| {
        let count = events.position.count;
        events
            .range(count.saturating_sub(200), count, true)
            .ok()?
            .into_iter()
            .rev()
            .find(|e| is(&e.data))
            .map(|e| e.data)
    })
}
fn bounds(end: u64, before: Option<u64>, after: Option<u64>) -> Result<(u64, u64, bool), String> {
    if before.is_some() && after.is_some()
        || before.is_some_and(|n| n == 0 || n > end + 1)
        || after.is_some_and(|n| n > end)
    {
        return Err("invalid chat cursor".into());
    }
    if let Some(after) = after {
        return Ok((after, end.min(after + 200), false));
    }
    let stop = before.map(|n| n - 1).unwrap_or(end);
    Ok((stop.saturating_sub(200), stop, true))
}
fn fingerprint(file: &mut File, offset: u64) -> Result<[u64; 2], String> {
    fn hash(file: &mut File, start: u64, len: usize) -> Result<u64, String> {
        let mut bytes = vec![0; len];
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        }))
    }
    let n = offset.min(4096) as usize;
    Ok([hash(file, 0, n)?, hash(file, offset - n as u64, n)?])
}
