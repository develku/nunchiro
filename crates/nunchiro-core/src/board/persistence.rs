use super::{Column, defaults};
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Disk {
    pub version: u32,
    pub columns: Vec<Column>,
    pub config_stamp: Option<Stamp>,
    pub config_error: Option<String>,
    #[serde(default)]
    pub seen: BTreeMap<String, u64>,
    #[serde(default)]
    pub manual: Vec<Manual>,
    #[serde(default)]
    pub held: BTreeMap<String, Held>,
    // v1b-18: decision identity -> the `updated_at` the user resolved; absent loads empty.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resolved: BTreeMap<String, u64>,
    // V2.5-38: board.toml `[settings]` as last read, kept with the stamp like the columns. None: not read yet
    // (a board.json from before V2.5-38 has a stamp but no settings), so the next reload reads the file again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<super::Settings>,
    // Q9 ko-J12-1: the last deleted manual cards, whole, for `board_undo`; oldest dropped first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<Deleted>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Deleted {
    pub card: Manual,
    /// The card's place in `manual` and the cards that waited on it.
    pub at: usize,
    pub waited_by: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Stamp(i64, i64, u64, u64, i64, i64);
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Manual {
    pub id: String,
    pub title: String,
    pub note: String,
    pub session_id: Option<String>,
    pub column: String,
    pub updated_at: u64,
    // V2.5-36 (ticket 184): task fields; absent in older stores and load empty.
    #[serde(default)]
    pub group: String,
    #[serde(default, rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub receipt: Option<super::Receipt>,
    #[serde(default)]
    pub waits_on: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<super::Attachment>,
    #[serde(default)]
    pub last_moved_at: u64,
    #[serde(default)]
    pub history: Vec<super::Change>,
    // The card as it was before its last change; `board_undo` restores it once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo: Option<Box<Manual>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Held {
    pub column: String,
    pub state: super::State,
    pub lifecycle: crate::api::SessionState,
    pub completion_seq: u64,
    pub updated_at: u64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
impl Stamp {
    pub fn of(meta: &fs::Metadata) -> Self {
        Self(
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ino(),
            meta.len(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }
}
impl Default for Disk {
    fn default() -> Self {
        Self {
            version: 1,
            columns: defaults(),
            config_stamp: None,
            config_error: None,
            seen: BTreeMap::new(),
            manual: vec![],
            held: BTreeMap::new(),
            resolved: BTreeMap::new(), // v1b-18
            settings: None,            // V2.5-38
            deleted: vec![],
            extra: BTreeMap::new(),
        }
    }
}
impl Disk {
    pub fn load(home: &Path) -> Result<Self, String> {
        let Some(bytes) = read_regular(&home.join("board.json"), 8 * 1024 * 1024)? else {
            return Ok(Self::default());
        };
        let mut disk: Self =
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid board store: {e}"))?;
        // V2.5-36 (needs 150): with no board.toml behind them, needs 43's four stored defaults move to the
        // five (columns from a board.toml are its business: `reload` migrates the file). Titles are the user's:
        // renamed (Korean) titles still match and are kept.
        if disk.config_stamp.is_none() && super::is_old_defaults(&disk.columns) {
            disk.columns = super::five(std::mem::take(&mut disk.columns));
        }
        if disk.version != 1 {
            return Err("unsupported board store version".into());
        }
        if disk.seen.len() > 4096 || disk.seen.keys().any(|id| !store::valid_id(id)) {
            return Err("invalid board seen markers".into());
        }
        if disk.held.len() > 4096
            || disk
                .held
                .iter()
                .any(|(id, held)| !store::valid_id(id) || !store::valid_id(&held.column))
        {
            return Err("invalid board held drag relationship".into());
        }
        // v1b-18
        if disk.resolved.len() > super::decisions::MAX_RESOLVED
            || disk
                .resolved
                .keys()
                .any(|id| id.is_empty() || id.len() > 1024)
        {
            return Err("invalid board resolutions".into());
        }
        if disk.columns.is_empty() || disk.columns.len() > 64 {
            return Err("invalid board store columns".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut states = Vec::new();
        for c in &disk.columns {
            if !store::valid_id(&c.id)
                || !ids.insert(&c.id)
                || c.title.trim().is_empty()
                || c.title.len() > 256
            {
                return Err("invalid board store column relationship".into());
            }
            for s in &c.states {
                if states.contains(s) {
                    return Err("duplicate board store state".into());
                }
                states.push(s.clone());
            }
        }
        let mut ids = std::collections::BTreeSet::new();
        if disk.manual.len() > 4096 {
            return Err("board manual card limit exceeded".into());
        }
        for card in &disk.manual {
            if !store::valid_id(&card.id)
                || !ids.insert(&card.id)
                || !store::valid_id(&card.column)
                || card
                    .session_id
                    .as_ref()
                    .is_some_and(|id| !store::valid_id(id))
            {
                return Err("invalid board manual card relationship".into());
            }
            super::validate_text(&card.title, &card.note)?;
            super::validate_task(card)?;
            if card.history.len() > super::HISTORY
                || card
                    .undo
                    .as_ref()
                    .is_some_and(|u| u.undo.is_some() || !u.history.is_empty())
            {
                return Err("invalid board card history".into());
            }
            if let Some(undo) = &card.undo {
                super::validate_text(&undo.title, &undo.note)?;
                super::validate_task(undo)?;
            }
        }
        // waits_on names stored cards and never loops (the write path refuses both).
        for card in &disk.manual {
            if card.waits_on.iter().any(|w| !ids.contains(w))
                || super::would_cycle(&disk.manual, &card.id, &card.waits_on)
            {
                return Err("invalid board waits_on relationship".into());
            }
        }
        for card in &mut disk.manual {
            if card.last_moved_at == 0 {
                card.last_moved_at = card.updated_at;
            }
        }
        Ok(disk)
    }
    pub fn reload(&mut self, home: &Path) {
        let path = home.join("board.toml");
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.config_stamp = None;
                self.config_error = None;
                self.settings = None;
                return;
            }
            Err(e) => {
                self.config_error = Some(format!("board.toml line 1: {e}"));
                return;
            }
        };
        let stamp = Stamp::of(&meta);
        if self.config_stamp.as_ref() == Some(&stamp)
            && (self.settings.is_some() || self.config_error.is_some())
        {
            return;
        }
        let mut stamp = stamp;
        let result = read_regular(&path, 1024 * 1024).and_then(|bytes| {
            let bytes = bytes.ok_or("board.toml disappeared during reload")?;
            let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
            let (version, columns) = super::config::parse_versioned(text)?;
            let settings = super::config::settings(text)?;
            // V2.5-36 (needs 150): a version-1 file still on needs 43's four defaults is rewritten
            // once to version 2 with the five; any other version-1 file is read as is, bytes kept.
            if version == 1 && columns == super::old_defaults() {
                match super::write::migrate_v1(&path, text, &meta) {
                    Ok(new) => {
                        stamp = new;
                        return Ok((defaults(), settings));
                    }
                    Err(e) => eprintln!("board: board.toml migration not written: {e}"),
                }
            }
            Ok((columns, settings))
        });
        match result {
            Ok((columns, settings)) => {
                self.columns = columns;
                self.settings = Some(settings);
                self.config_error = None;
            }
            Err(error) => {
                self.config_error = Some(if error.starts_with("board.toml line ") {
                    error
                } else {
                    format!("board.toml line 1: {error}")
                })
            }
        }
        self.config_stamp = Some(stamp);
    }
    pub fn save(&self, home: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("board store exceeds 8 MiB".into());
        }
        store::private_dir(home)?;
        store::atomic_write(&home.join("board.json"), &bytes)
    }
}

// v1b-16: shared with the GUI writer; v1b-18: with decisions (board.toml declarations).
pub(super) fn read_regular(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit {
        return Err(format!("invalid or oversized {}", path.display()));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("board file exceeds limit".into());
    }
    Ok(Some(bytes))
}
