//! A record of delivery and core restarts for `nunchiro serve status`: per local day, prompts delivered, prompts the
//! core sent again by itself after a dropped Enter, and prompts that needed a person; per core start that found
//! running sessions, how many ran before and how many came back. Counts only, never message text. A missing or broken
//! file reads as empty, and a write that fails is logged: the record never stops a delivery or a start.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const FILE: &str = "record.json";
/// Days kept, and shown.
pub const DAYS: u64 = 30;
const DAY_MS: u64 = 86_400_000;
/// Restart rows kept at most, whatever their age.
const RESTARTS: usize = 200;
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
}

fn change(home: &Path, f: impl FnOnce(&mut Record)) {
    let _one = CHANGE.lock().unwrap_or_else(|e| e.into_inner());
    let mut record = read(home);
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
        day.delivered += u64::from(delivered);
        day.resent += u64::from(resent);
        day.person += u64::from(person);
    });
}

/// A core start found `before` sessions the last core ran, and `after` of them came back.
pub(crate) fn restart(home: &Path, before: usize, after: usize) {
    change(home, |r| {
        r.restarts.push(Restart {
            at_ms: crate::queue::now_ms(),
            before,
            after,
        })
    });
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
        let home = home("gone").join("not-there");
        count(&home, true, true, false);
        restart(&home, 1, 1);
        assert_eq!(read(&home), Record::default());
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
