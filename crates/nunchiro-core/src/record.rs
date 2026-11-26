//! A record of delivery and core restarts for `nunchiro serve status`: per local day, prompts delivered, prompts the
//! core sent again by itself after a dropped Enter, and prompts that needed a person; per core start that found
//! running sessions, how many ran before and how many came back. Counts only, never message text. A missing file reads
//! as empty; an unreadable one is moved aside (its history kept) and a new one started; a write that fails is logged:
//! the record never stops a delivery or a start.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const FILE: &str = "record.json";
/// Days kept, and shown.
pub const DAYS: u64 = 30;
const DAY_MS: u64 = 86_400_000;
/// Restart rows, and lost agents remembered, kept at most, whatever their age.
const RESTARTS: usize = 200;
/// Unreadable records kept aside at most; past it the record is left as it is and nothing more is counted.
const ASIDE: usize = 5;
const BROKEN: &str = "record.broken-";
static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Day {
    pub delivered: u64,
    pub resent: u64,
    pub person: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Restart {
    pub at_ms: u64,
    pub before: usize,
    pub after: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Record {
    /// Local `YYYY-MM-DD` to that day's counts.
    pub days: BTreeMap<String, Day>,
    pub restarts: Vec<Restart>,
    /// Agents (`pid:start`) a restart counted lost. A core killed before its next save leaves them named running in
    /// sessions.json; the next start does not count them again.
    pub lost: Vec<String>,
}

/// The record of the last `DAYS` days in `home`; empty when the file is missing or unreadable.
pub fn read(home: &Path) -> Record {
    let mut record: Record = std::fs::read(home.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    trim(&mut record, crate::queue::now_ms());
    record
}

fn trim(record: &mut Record, now: u64) {
    let since = now.saturating_sub((DAYS - 1) * DAY_MS);
    let first = crate::loops::today(since);
    record.days.retain(|day, _| *day >= first);
    record.restarts.retain(|r| r.at_ms >= since);
    let over = record.restarts.len().saturating_sub(RESTARTS);
    record.restarts.drain(..over);
    let over = record.lost.len().saturating_sub(RESTARTS);
    record.lost.drain(..over);
}

/// The record to change: `None` when it must be left as it is (not a plain file, or unreadable and not moved aside).
fn load(home: &Path) -> Option<Record> {
    let path = home.join(FILE);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Record::default()),
        Ok(m) if m.is_file() => {}
        Ok(_) => {
            eprintln!(
                "delivery record not kept: {} is not a plain file",
                path.display()
            );
            return None;
        }
        Err(e) => {
            eprintln!("delivery record not kept: {e}");
            return None;
        }
    }
    if let Some(record) = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        return Some(record);
    }
    let kept = std::fs::read_dir(home).map_or(ASIDE, |d| {
        d.filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(BROKEN))
            .count()
    });
    if kept >= ASIDE {
        eprintln!(
            "delivery record not kept: {} is unreadable and {kept} are set aside already",
            path.display()
        );
        return None;
    }
    let aside = home.join(format!("{BROKEN}{}.json", crate::queue::now_ms()));
    match std::fs::rename(&path, &aside) {
        Ok(()) => {
            eprintln!(
                "delivery record unreadable: moved to {}; a new one starts",
                aside.display()
            );
            Some(Record::default())
        }
        Err(e) => {
            eprintln!("delivery record not kept: unreadable and not moved aside: {e}");
            None
        }
    }
}

fn change(home: &Path, f: impl FnOnce(&mut Record)) {
    let _one = CHANGE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut record) = load(home) else {
        return;
    };
    trim(&mut record, crate::queue::now_ms());
    f(&mut record);
    let written = serde_json::to_vec(&record)
        .map_err(|e| e.to_string())
        .and_then(|bytes| crate::store::atomic_write(&home.join(FILE), &bytes));
    if let Err(e) = written {
        eprintln!("delivery record not kept: {e}");
    }
}

/// Today's counts go up: a prompt delivered (`resent` when the core sent it again after a dropped Enter), or one that
/// needed a person.
pub(crate) fn count(home: &Path, delivered: bool, resent: bool, person: bool) {
    change(home, |r| {
        let day = r
            .days
            .entry(crate::loops::today(crate::queue::now_ms()))
            .or_default();
        day.delivered = day.delivered.saturating_add(u64::from(delivered));
        day.resent = day.resent.saturating_add(u64::from(resent));
        day.person = day.person.saturating_add(u64::from(person));
    });
}

/// A core start: each agent (`pid:start`) the last core ran, and whether it came back. One counted lost before is
/// left out; with none left no row is written.
pub(crate) fn restart(home: &Path, running: &[(String, bool)]) {
    if running.is_empty() {
        return;
    }
    change(home, |r| {
        let ran: Vec<_> = running
            .iter()
            .filter(|(a, _)| !r.lost.contains(a))
            .collect();
        if ran.is_empty() {
            return;
        }
        r.restarts.push(Restart {
            at_ms: crate::queue::now_ms(),
            before: ran.len(),
            after: ran.iter().filter(|(_, back)| *back).count(),
        });
        r.lost
            .extend(ran.iter().filter(|(_, back)| !back).map(|(a, _)| a.clone()));
    });
}

/// Removes the record's temporary files a killed core left (`store::atomic_write` names them `record.<id>.tmp`).
pub(crate) fn sweep(home: &Path) {
    let Ok(dir) = std::fs::read_dir(home) else {
        return;
    };
    for e in dir.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("record.") && name.ends_with(".tmp") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// `YYYY-MM-DD HH:MM` local time, for the CLI.
pub fn when(at_ms: u64) -> String {
    let secs = (at_ms / 1000) as i64;
    let local = (secs + crate::usage::local_offset(secs)).rem_euclid(86_400);
    format!(
        "{} {:02}:{:02}",
        crate::loops::today(at_ms),
        local / 3600,
        local % 3600 / 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("ns-record-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn a_broken_file_reads_empty_and_the_next_count_replaces_it() {
        let home = home("broken");
        std::fs::write(home.join(FILE), b"{\"days\": [not json").unwrap();
        assert_eq!(read(&home), Record::default());
        count(&home, true, false, false);
        let days = read(&home).days;
        assert_eq!(days.values().map(|d| d.delivered).sum::<u64>(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_count_into_a_missing_folder_is_only_logged() {
        let base = home("gone");
        let home = base.join("not-there");
        count(&home, true, true, false);
        restart(&home, &[("1:1".into(), true)]);
        assert_eq!(read(&home), Record::default());
        let _ = std::fs::remove_dir_all(base);
    }

    fn aside(home: &Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(home)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.to_string_lossy().contains("record.broken-"))
            .collect()
    }

    #[test]
    fn an_unreadable_record_is_moved_aside_not_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let home = home("aside");
        let mut old = Record::default();
        old.days.insert(
            crate::loops::today(crate::queue::now_ms()),
            Day {
                delivered: 7,
                ..Day::default()
            },
        );
        let bytes = serde_json::to_vec(&old).unwrap();
        std::fs::write(home.join(FILE), &bytes).unwrap();
        std::fs::set_permissions(home.join(FILE), std::fs::Permissions::from_mode(0o000)).unwrap();
        count(&home, true, false, false);
        let moved = aside(&home);
        assert_eq!(moved.len(), 1, "{moved:?}");
        std::fs::set_permissions(&moved[0], std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            std::fs::read(&moved[0]).unwrap(),
            bytes,
            "the history is kept"
        );
        assert_eq!(
            read(&home).days.values().map(|d| d.delivered).sum::<u64>(),
            1
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_in_the_records_place_is_left_alone() {
        let home = home("folder");
        std::fs::create_dir(home.join(FILE)).unwrap();
        count(&home, true, false, false);
        assert!(home.join(FILE).is_dir());
        assert!(aside(&home).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn counts_stop_at_the_largest_number() {
        let home = home("max");
        let mut full = Record::default();
        full.days.insert(
            crate::loops::today(crate::queue::now_ms()),
            Day {
                delivered: u64::MAX,
                resent: u64::MAX,
                person: u64::MAX,
            },
        );
        std::fs::write(home.join(FILE), serde_json::to_vec(&full).unwrap()).unwrap();
        count(&home, true, true, true);
        assert_eq!(read(&home), full);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_start_sweeps_temporary_files_a_killed_core_left() {
        let home = home("sweep");
        std::fs::write(home.join("record.abc123.tmp"), b"half").unwrap();
        std::fs::write(home.join("sessions.abc123.tmp"), b"not ours").unwrap();
        sweep(&home);
        assert!(!home.join("record.abc123.tmp").exists());
        assert!(home.join("sessions.abc123.tmp").exists());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn days_and_restarts_older_than_thirty_days_go() {
        let now = crate::queue::now_ms();
        let old = now - DAYS * DAY_MS;
        let mut record = Record::default();
        record.days.insert(
            crate::loops::today(old),
            Day {
                delivered: 9,
                ..Day::default()
            },
        );
        record.days.insert(crate::loops::today(now), Day::default());
        record.restarts.push(Restart {
            at_ms: old,
            before: 3,
            after: 1,
        });
        for _ in 0..RESTARTS + 5 {
            record.restarts.push(Restart {
                at_ms: now,
                before: 1,
                after: 1,
            });
        }
        trim(&mut record, now);
        assert_eq!(record.days.len(), 1);
        assert!(!record.days.contains_key(&crate::loops::today(old)));
        assert_eq!(record.restarts.len(), RESTARTS);
        assert!(record.restarts.iter().all(|r| r.at_ms == now));
    }
}
