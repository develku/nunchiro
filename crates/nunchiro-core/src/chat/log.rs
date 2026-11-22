//! Append-only event data and fixed-width on-disk offsets; bounded resident tail.
use super::{Event, valid_data};
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
const MAX_RECORD: usize = 2 * 1024 * 1024;
const RECENT_BYTES: usize = 256 * 1024;
pub(super) const PAGE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Position {
    pub id: String,
    pub count: u64,
    pub end: u64,
}
#[derive(Clone)]
pub(super) struct Log {
    pub position: Position,
    data: PathBuf,
    index: PathBuf,
    recent: VecDeque<(Event, usize)>,
    bytes: usize,
}
fn file(path: &Path, write: bool) -> Result<File, String> {
    let f = OpenOptions::new()
        .read(true)
        .write(write)
        .create(write)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !f.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("chat log is not a regular file".into());
    }
    Ok(f)
}
fn record(reader: &mut impl Read) -> Result<(Event, usize), String> {
    let mut length = [0; 8];
    reader.read_exact(&mut length).map_err(|e| e.to_string())?;
    let len = u64::from_be_bytes(length);
    if len > MAX_RECORD as u64 {
        return Err("oversized chat log record".into());
    }
    let mut bytes = vec![0; len as usize];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let event: Event = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if event.schema_version != 1 || !valid_data(&event.data) {
        return Err("invalid chat log event".into());
    }
    Ok((event, len as usize + 8))
}
impl Log {
    pub fn open(dir: &Path, position: Position) -> Result<Self, String> {
        if !store::valid_id(&position.id) {
            return Err("invalid chat log identity".into());
        }
        let mut log = Self {
            data: dir.join(format!("{}.events", position.id)),
            index: dir.join(format!("{}.index", position.id)),
            position,
            recent: VecDeque::new(),
            bytes: 0,
        };
        if log.position.count == 0 {
            if log.position.end != 0 {
                return Err("invalid empty chat log".into());
            }
            return Ok(log);
        }
        let data = file(&log.data, false)?;
        let index = file(&log.index, false)?;
        if data.metadata().map_err(|e| e.to_string())?.len() < log.position.end
            || index.metadata().map_err(|e| e.to_string())?.len()
                < log
                    .position
                    .count
                    .checked_mul(8)
                    .ok_or("chat log count overflow")?
        {
            return Err("incomplete chat log".into());
        }
        for e in log.range(
            log.position.count.saturating_sub(200),
            log.position.count,
            false,
        )? {
            let bytes = serde_json::to_vec(&e).map_err(|e| e.to_string())?.len() + 8;
            log.remember(e, bytes);
        }
        Ok(log)
    }
    pub fn fresh(dir: &Path) -> Result<Self, String> {
        Self::open(
            dir,
            Position {
                id: store::new_id()?,
                count: 0,
                end: 0,
            },
        )
    }
    fn remember(&mut self, event: Event, len: usize) {
        self.bytes += len;
        self.recent.push_back((event, len));
        while self.recent.len() > 200 || self.bytes > RECENT_BYTES {
            if let Some((_, n)) = self.recent.pop_front() {
                self.bytes -= n;
            }
        }
    }
    pub fn append(
        &mut self,
        values: impl IntoIterator<Item = serde_json::Value>,
    ) -> Result<(), String> {
        let mut data = file(&self.data, true)?;
        let mut index = file(&self.index, true)?;
        // Only bytes beyond the atomically committed positions are uncommitted crash tails.
        data.set_len(self.position.end).map_err(|e| e.to_string())?;
        index
            .set_len(self.position.count * 8)
            .map_err(|e| e.to_string())?;
        data.seek(SeekFrom::Start(self.position.end))
            .map_err(|e| e.to_string())?;
        index
            .seek(SeekFrom::Start(self.position.count * 8))
            .map_err(|e| e.to_string())?;
        for value in values {
            if !valid_data(&value) {
                return Err("invalid chat append event".into());
            }
            let event = Event {
                schema_version: 1,
                cursor: self.position.count + 1,
                data: value,
            };
            let bytes = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_RECORD {
                return Err("oversized chat append event".into());
            }
            index
                .write_all(&self.position.end.to_be_bytes())
                .map_err(|e| e.to_string())?;
            data.write_all(&(bytes.len() as u64).to_be_bytes())
                .map_err(|e| e.to_string())?;
            data.write_all(&bytes).map_err(|e| e.to_string())?;
            self.position.end += 8 + bytes.len() as u64;
            self.position.count += 1;
            self.remember(event, bytes.len() + 8);
        }
        data.sync_all().map_err(|e| e.to_string())?;
        index.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Zero-based half-open range, at most 200 records and 2 MiB per page.
    pub fn range(&self, start: u64, end: u64, newest: bool) -> Result<Vec<Event>, String> {
        if start > end || end > self.position.count || end - start > 200 {
            return Err("invalid chat log range".into());
        }
        if start == end {
            return Ok(vec![]);
        }
        if self
            .recent
            .front()
            .is_some_and(|(e, _)| e.cursor <= start + 1)
            && self.recent.back().is_some_and(|(e, _)| e.cursor >= end)
        {
            let events = self
                .recent
                .iter()
                .filter(|(e, _)| e.cursor > start && e.cursor <= end)
                .map(|(e, n)| (e.clone(), *n))
                .collect::<Vec<_>>();
            return Ok(limit(events, newest));
        }
        let mut index = file(&self.index, false)?;
        index
            .seek(SeekFrom::Start(start * 8))
            .map_err(|e| e.to_string())?;
        let mut offset = [0; 8];
        index.read_exact(&mut offset).map_err(|e| e.to_string())?;
        let first = u64::from_be_bytes(offset);
        if first >= self.position.end {
            return Err("invalid chat data offset".into());
        }
        let mut data = file(&self.data, false)?;
        data.seek(SeekFrom::Start(first))
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(data);
        let mut events = VecDeque::new();
        let mut bytes = 0;
        for cursor in start + 1..=end {
            let (e, n) = record(&mut reader)?;
            if e.cursor != cursor {
                return Err("invalid chat cursor relation".into());
            }
            if !newest && bytes + n > PAGE_BYTES && !events.is_empty() {
                break;
            }
            bytes += n;
            events.push_back((e, n));
            while newest && bytes > PAGE_BYTES && events.len() > 1 {
                bytes -= events.pop_front().unwrap().1;
            }
        }
        Ok(events.into_iter().map(|(e, _)| e).collect())
    }
    pub fn each(&self, mut f: impl FnMut(Event) -> Result<(), String>) -> Result<(), String> {
        if self.position.count == 0 {
            return Ok(());
        }
        let mut data = BufReader::new(file(&self.data, false)?);
        for cursor in 1..=self.position.count {
            let (e, _) = record(&mut data)?;
            if e.cursor != cursor {
                return Err("invalid chat cursor relation".into());
            }
            f(e)?;
        }
        Ok(())
    }
    pub fn remove(&self) {
        let _ = fs::remove_file(&self.data);
        let _ = fs::remove_file(&self.index);
    }
}
fn limit(mut events: Vec<(Event, usize)>, newest: bool) -> Vec<Event> {
    if newest {
        events.reverse();
    }
    let mut size = 0;
    let mut out = vec![];
    for (e, n) in events {
        if size + n > PAGE_BYTES && !out.is_empty() {
            break;
        }
        size += n;
        out.push(e);
    }
    if newest {
        out.reverse();
    }
    out
}
