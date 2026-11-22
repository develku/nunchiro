//! v1b-18: needs-decision board cards as decision queue items. They are not session items: nothing reaches
//! queue.json or a PTY, and nothing is written back to an integration (v2). Answering records
//! `identity -> updated_at` in board.json; a card with a later `updated_at` raises again.
use super::{
    Column,
    persistence::{Disk, Stamp},
    sources::Declaration,
};
use crate::api::{Reply, Response, Session};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

pub const MAX_RESOLVED: usize = 4096;
/// The tick refreshes at most this often; board requests and answers refresh at once.
const REFRESH_EVERY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    /// `manual:<id>` or `integration:<source_name>:<id>`.
    pub identity: String,
    /// `manual` or `integration`.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub id: String,
    pub title: String,
    /// `needs_decision.question`, else the card title.
    pub question: String,
    /// An integration card's own `project`, or a manual card's linked session's project.
    pub project: Option<String>,
    pub url: Option<String>,
    pub column: String,
    pub updated_at: u64,
}

/// Open items per home, kept current by the hooks so a snapshot reads them without file or source I/O.
static CURRENT: Mutex<BTreeMap<PathBuf, (Instant, Vec<Decision>)>> = Mutex::new(BTreeMap::new());

pub fn current(home: &Path) -> Vec<Decision> {
    CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .map(|(_, d)| d.clone())
        .unwrap_or_default()
}

/// Every card that raises an item, resolved or not. Session cards never do: a waiting session is already a
/// session queue item.
pub(super) fn raised(columns: &[Column], cards: &[Value]) -> Vec<Decision> {
    cards
        .iter()
        .filter_map(|c| {
            let in_column = columns
                .iter()
                .any(|col| col.needs_decision && c["column"] == col.id);
            let flag = c["needs_decision"]["question"].as_str();
            let id = c["id"].as_str()?;
            let identity = match c["source"].as_str()? {
                // Look 1117 v12 B N12-S2-1: a lead's task card raises nothing; its merge card is the decision.
                "manual" if in_column && c["task"].is_null() => format!("manual:{id}"),
                "integration" if in_column || flag.is_some() => {
                    format!("integration:{}:{id}", c["source_name"].as_str()?)
                }
                _ => return None,
            };
            let title = c["title"].as_str()?;
            Some(Decision {
                identity,
                source: c["source"].as_str()?.into(),
                source_name: c["source_name"].as_str().map(Into::into),
                id: id.into(),
                title: title.into(),
                question: flag.unwrap_or(title).into(),
                project: c["project"].as_str().map(Into::into),
                url: c["url"].as_str().map(Into::into),
                column: c["column"].as_str()?.into(),
                updated_at: c["updated_at"].as_u64()?,
            })
        })
        .collect()
}

/// Stores and returns the open items: raised and not resolved at or after their `updated_at`.
pub(super) fn publish(
    home: &Path,
    raised: Vec<Decision>,
    resolved: &BTreeMap<String, u64>,
) -> Vec<Decision> {
    let open: Vec<_> = raised
        .into_iter()
        .filter(|d| {
            resolved
                .get(&d.identity)
                .is_none_or(|at| d.updated_at > *at)
        })
        .collect();
    CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(home.to_path_buf(), (Instant::now(), open.clone()));
    open
}

/// The tick's hook: board.json as observed, board.toml's columns and the integration cards. The first call
/// registers the integration source worker, so items appear after a restart before any board read.
pub(super) fn refresh<'a>(home: &Path, disk: &mut Disk, sessions: impl FnOnce() -> &'a [Session]) {
    let pruned = prune(home, disk);
    let due = CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .is_none_or(|(at, _)| at.elapsed() >= REFRESH_EVERY);
    // S9 r3: a changed source publishes now, not at the next due pass (the core's idle board clock is 1 s).
    let sources = super::sources::key(home);
    let moved = PUBLISHED_SOURCES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        != Some(&sources);
    if due || pruned || moved {
        publish(home, cards(home, disk, sessions), &disk.resolved);
        // The key read before the merge: a change the worker merges while this publishes is then still unpublished
        // (one extra publish at most), never recorded as published without being in it.
        PUBLISHED_SOURCES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(home.to_path_buf(), sources);
    }
}
/// S9 r3: the sources' key at each home's last publish.
static PUBLISHED_SOURCES: Mutex<BTreeMap<PathBuf, super::sources::Key>> =
    Mutex::new(BTreeMap::new());

// Q9 tt-J12-1: None while no board.toml has parsed yet, so a fixed file drops nothing.
type Declared = (Option<Stamp>, Option<Vec<Declaration>>);
/// The board.toml stamp and accepted source declarations last compared, per home.
static DECLARED: Mutex<BTreeMap<PathBuf, Declared>> = Mutex::new(BTreeMap::new());

/// A removed source, or a name now declared for another input, is another integration: its resolutions go,
/// so a reused name never inherits an answer. Runs when board.toml changes; an invalid board.toml keeps all.
/// True when an accepted board.toml was compared: its declarations or columns may have changed, so publish now.
fn prune(home: &Path, disk: &mut Disk) -> bool {
    let path = home.join("board.toml");
    let stamp = std::fs::symlink_metadata(&path).ok().map(|m| Stamp::of(&m));
    let mut declared = DECLARED.lock().unwrap_or_else(|e| e.into_inner());
    let known = declared.get(home);
    if known.is_some_and(|(at, _)| *at == stamp) {
        return false;
    }
    let next = match &stamp {
        None => Some(vec![]),
        Some(_) => super::persistence::read_regular(&path, 1024 * 1024)
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|t| super::config::parse_document(&t).ok())
            .map(|(_, s)| s.map_or(vec![], |s| s.entries)),
    };
    let Some(next) = next else {
        let before = known.and_then(|(_, d)| d.clone());
        declared.insert(home.to_path_buf(), (stamp, before));
        return false;
    };
    let before = known.and_then(|(_, d)| d.clone());
    let gone = |name: &str| {
        let now = next.iter().find(|d| d.name == name);
        now.is_none()
            || before
                .as_ref()
                .is_some_and(|b| b.iter().find(|d| d.name == name) != now)
    };
    let count = disk.resolved.len();
    disk.resolved.retain(|identity, _| {
        identity
            .strip_prefix("integration:")
            .and_then(|rest| rest.split_once(':'))
            .is_none_or(|(name, _)| !gone(name))
    });
    let dropped = count - disk.resolved.len();
    if dropped > 0 {
        match disk.save(home) {
            Ok(()) => {
                eprintln!("board: dropped {dropped} resolutions of removed or replaced sources")
            }
            // Not recorded as compared, so the next tick tries again.
            Err(e) => {
                eprintln!("board: dropping resolutions of removed sources failed: {e}");
                return false;
            }
        }
    }
    declared.insert(home.to_path_buf(), (stamp, Some(next)));
    // 538: not only `dropped > 0`. A new source is absent from the sources key until a publish registers it, so a
    // board.toml change inside REFRESH_EVERY of the last publish otherwise waited for the 1 s idle board clock.
    true
}

fn cards<'a>(home: &Path, disk: &Disk, sessions: impl FnOnce() -> &'a [Session]) -> Vec<Decision> {
    let mut view = Disk {
        columns: disk.columns.clone(),
        config_stamp: disk.config_stamp.clone(),
        ..Disk::default()
    };
    view.reload(home);
    let columns = view.columns;
    let asking: Vec<_> = disk
        .manual
        .iter()
        .filter(|c| {
            let column = super::manual_column(c, &columns);
            columns
                .iter()
                .any(|col| col.needs_decision && col.id == column)
        })
        .collect();
    let mut cards = vec![];
    if !asking.is_empty() {
        let sessions = sessions();
        cards.extend(
            asking
                .into_iter()
                .map(|c| super::manual_card(c, &columns, sessions, &disk.seen, &[])),
        );
    }
    if home.join("board.toml").exists() {
        super::sources::merge(home, &columns, &mut cards);
    }
    raised(&columns, &cards)
}

/// `board_resolve`: owner only (sessions are refused before this). Answers against the cards as they are now.
pub fn resolve(home: &Path, sessions: &[Session], identity: &str, updated_at: u64) -> Response {
    let mut disk = Disk::load(home)?;
    let raised = cards(home, &disk, || sessions);
    let card = raised
        .iter()
        .find(|d| d.identity == identity)
        .ok_or("board decision not found")?;
    if card.updated_at != updated_at {
        return Err("card changed".into());
    }
    if disk.resolved.get(identity) != Some(&updated_at) {
        disk.resolved.insert(identity.into(), updated_at);
        while disk.resolved.len() > MAX_RESOLVED {
            // The oldest other: the one just made always stays, whatever its updated_at.
            let oldest = disk
                .resolved
                .iter()
                .filter(|(id, _)| id.as_str() != identity)
                .min_by_key(|(id, at)| (**at, (*id).clone()))
                .map(|(id, _)| id.clone())
                .unwrap_or_default();
            disk.resolved.remove(&oldest);
            eprintln!("board: {MAX_RESOLVED} resolutions kept; forgot the oldest, {oldest}");
        }
        disk.save(home)?;
    }
    Ok(Reply::BoardDecisions {
        board_decisions: publish(home, raised, &disk.resolved),
    })
}
