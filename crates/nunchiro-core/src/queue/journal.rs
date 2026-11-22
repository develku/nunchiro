//! Owner-local bounded hook journal. Contains events, never tokens or saved decisions.
use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
};
pub const MAX_EVENTS: usize = 1024;
pub const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_EVENT_BYTES: u64 = 128 * 1024;
pub const QUARANTINE_MAX_FILES: usize = 64;
pub const QUARANTINE_MAX_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
pub struct Event {
    pub version: u32,
    pub event_id: String,
    pub session_id: String,
    pub event: String,
    pub payload: Value,
    pub created: u64,
}
impl Event {
    pub fn new(session_id: String, event: String, mut payload: Value) -> Result<Self, String> {
        let event_id = store::new_id()?;
        let created = super::now_ms();
        fn redact(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    map.retain(|key, _| {
                        ![
                            "token",
                            "authorization",
                            "password",
                            "api_key",
                            "access_token",
                            "refresh_token",
                            "credentials",
                            "auth",
                        ]
                        .contains(&key.to_lowercase().as_str())
                    });
                    for v in map.values_mut() {
                        redact(v);
                    }
                }
                Value::Array(a) => {
                    for v in a {
                        redact(v);
                    }
                }
                _ => {}
            }
        }
        redact(&mut payload);
        let object = payload
            .as_object_mut()
            .ok_or("hook payload must be an object")?;
        object.insert("nunchiro_event_id".into(), event_id.clone().into());
        object.insert("nunchiro_created".into(), created.into());
        Ok(Self {
            version: 1,
            event_id,
            session_id,
            event,
            payload,
            created,
        })
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || !store::valid_id(&self.event_id)
            || !store::valid_id(&self.session_id)
            || self.event.len() > 128
            || !self.payload.is_object()
            || self.payload["nunchiro_event_id"].as_str() != Some(self.event_id.as_str())
        {
            return Err("invalid hook journal event".into());
        }
        Ok(())
    }
}
pub fn write(home: &Path, event: &Event) -> Result<PathBuf, String> {
    event.validate()?;
    store::private_dir(home)?;
    let dir = home.join("hook-journal");
    store::private_dir(&dir)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("journal.lock"))
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        if std::time::Instant::now() >= deadline {
            return Err("hook journal busy".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Unreadable entries we did not write still count toward the cap but never fail this write.
    let mut entries = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json")
            && !matches!(read_event(&path, super::now_ms()), Ok(None))
        {
            entries += 1;
        }
    }
    if entries >= MAX_EVENTS {
        return Err("hook journal full".into());
    }
    let path = dir.join(format!("{}.json", event.event_id));
    let bytes = serde_json::to_vec(event).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_EVENT_BYTES {
        return Err("hook journal event too large".into());
    }
    store::atomic_write(&path, &bytes)?;
    Ok(path)
}
pub fn read(home: &Path, now: u64) -> Result<Vec<(PathBuf, Event)>, String> {
    let dir = home.join("hook-journal");
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
        Ok(meta) if !meta.is_dir() => return Err("invalid hook journal directory".into()),
        _ => {}
    }
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if out.len() >= MAX_EVENTS {
            return Err("hook journal count limit exceeded".into());
        }
        if let Some(event) = read_event(&path, now)? {
            out.push((path, event));
        }
    }
    out.sort_by(|a, b| {
        a.1.created
            .cmp(&b.1.created)
            .then(a.1.event_id.cmp(&b.1.event_id))
    });
    Ok(out)
}

fn read_event(path: &Path, now: u64) -> Result<Option<Event>, String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_EVENT_BYTES {
        return Err("invalid hook journal size/type".into());
    }
    let mut bytes = vec![];
    file.by_ref()
        .take(MAX_EVENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_EVENT_BYTES {
        return Err("hook journal size exceeded".into());
    }
    let event: Event =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid hook journal: {e}"))?;
    event.validate()?;
    if path.file_stem().and_then(|s| s.to_str()) != Some(&event.event_id)
        || event.created > now + 60_000
    {
        return Err("invalid hook journal identity/time".into());
    }
    if now.saturating_sub(event.created) > MAX_AGE_MS {
        fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    Ok(Some(event))
}

/// Startup preserves rejected bytes outside the replay/admission directory, capped at
/// `QUARANTINE_MAX_FILES` / `QUARANTINE_MAX_BYTES` (oldest pruned first). Returns the pruned count.
pub fn quarantine(home: &Path, path: &Path, reason: &str) -> Result<usize, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = home.join("hook-journal-quarantine");
    store::private_dir(&dir)?;
    let name = store::new_id()?;
    let target = dir.join(format!("{name}.json"));
    // Never follow a rejected symlink while tightening permissions.
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(path, &target).map_err(|e| e.to_string())?;
    eprintln!("hook journal quarantined {}: {reason}", target.display());
    // Pruning is best-effort: a failure here must not stop valid events from replaying.
    let pruned = prune_quarantine(&dir, &target).unwrap_or_else(|error| {
        eprintln!("hook journal quarantine prune failed: {error}");
        0
    });
    Ok(pruned)
}

struct Quarantined {
    changed: (i64, i64),
    path: PathBuf,
    len: u64,
}

/// Oldest-first by ctime (rename keeps the rejected file's old mtime). The file just
/// quarantined is exempt, so a single over-cap reject is kept rather than lost.
fn prune_quarantine(dir: &Path, newest: &Path) -> Result<usize, String> {
    use std::os::unix::fs::MetadataExt;
    let mut files = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_file() && entry.path() != newest {
            files.push(Quarantined {
                changed: (meta.ctime(), meta.ctime_nsec()),
                path: entry.path(),
                len: meta.len(),
            });
        }
    }
    files.sort_by_key(|f| f.changed);
    let newest_len = fs::metadata(newest).map(|m| m.len()).unwrap_or(0);
    let mut total = newest_len + files.iter().map(|f| f.len).sum::<u64>();
    let mut count = files.len() + 1;
    let mut pruned = 0;
    for file in files {
        if count <= QUARANTINE_MAX_FILES && total <= QUARANTINE_MAX_BYTES {
            break;
        }
        fs::remove_file(&file.path).map_err(|e| e.to_string())?;
        count -= 1;
        total -= file.len;
        pruned += 1;
    }
    if pruned > 0 {
        eprintln!("hook journal quarantine cap reached: pruned {pruned} oldest files");
    }
    Ok(pruned)
}

pub fn recover(home: &Path, now: u64) -> Result<(Vec<(PathBuf, Event)>, usize), String> {
    let dir = home.join("hook-journal");
    if !dir.exists() {
        return Ok((vec![], 0));
    }
    let mut out = vec![];
    let mut rejected = 0;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match read_event(&path, now) {
            Ok(Some(event)) if out.len() < MAX_EVENTS => out.push((path, event)),
            Ok(None) => {}
            result => {
                let reason = result
                    .err()
                    .unwrap_or_else(|| "hook journal count limit exceeded".into());
                // Pruned evidence is gone, so it joins the "unavailable" count in snapshot attention.
                // Q9 pin-J11-2: a quarantine that fails is logged; the valid events still replay.
                rejected += 1 + quarantine(home, &path, &reason).unwrap_or_else(|error| {
                    eprintln!("hook journal quarantine failed: {error}");
                    0
                });
            }
        }
    }
    out.sort_by(|a, b| {
        a.1.created
            .cmp(&b.1.created)
            .then(a.1.event_id.cmp(&b.1.event_id))
    });
    Ok((out, rejected))
}
