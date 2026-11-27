//! One board for all projects; independent of the decision queue's persistence.
//!
//! ## Snapshot wire shape (V2.5-36, ticket 184)
//!
//! `Reply::BoardSnapshot { board }`. Tickets 183 (CLI, write rights), 185 (board UI) and 187 (nudge) build
//! against this; `snapshot_shape_documented` (tests/board_model.rs) fails when a key is added or dropped
//! without this list. Times are Unix milliseconds. Errors are the request's `Err(String)`; nothing is
//! written then.
//!
//! ### Snapshot
//! - `columns`: [Column], 1 to 64, board order. Without board.toml the five defaults below.
//! - `cards`: [Card]; integration source cards (`source = "integration"`) keep the shape `sources/` gives.
//! - `error`: string or null; a board.toml problem ("board.toml line N: ..."), the last good columns shown.
//! - `sources`: [source state]; omitted when board.toml names no integration source.
//! - `revision`: string, opaque board.toml stamp, "" when there is no file; echo it in `board_columns_put`.
//! - `settings`: Settings, board.toml `[settings]` (V2.5-38); the defaults without the table, the last good ones
//!   while board.toml has an error.
//!
//! ### Settings
//! - `stale_minutes`: u32, 1 to 1440 (default 10); the stale badge threshold.
//! - `turn_end_nudge`: bool (default true); ticket 187's turn-end context line.
//! - `done_days`: u32, 1, 7 or 30 (default 7); ticket 1066: a done card older than this (by `done_at`) is
//!   archived: the window's Done column leaves it out and shows it in the Archive fold, `nunchiro board list`
//!   marks it. Nothing is deleted.
//!
//! ### Column
//! - `id`: string, a store id.
//! - `title`: string, 1 to 256 bytes.
//! - `states`: [state], the session states this column claims (`working`, `needs_decision`, `review`,
//!   `done`); each state at most once on the board; may be empty (To do claims none).
//! - `needs_decision`: bool; cards here raise Decision queue items.
//! - `proof`: bool; moving a card here needs a Receipt (enforced by ticket 183's rights, not here).
//!
//! Defaults: `todo` To do (new manual cards land here), `working`, `needs-decision`, `review`, `done`
//! (`proof = true`).
//!
//! ### Card
//! Session cards and manual cards carry every key; on a session card the task keys are empty.
//! - `id`: string; a session card uses its session id.
//! - `source`: `"session"` | `"manual"` (| `"integration"`, see above).
//! - `title`: string; a session card shows the session label.
//! - `note`: string, at most 64 KiB; "" on session cards.
//! - `text`: string; what the card says (look 11-17 v5 item 9): its note, else the outcome of the ledger task its
//!   attached sessions are seats of, else its title; a session card's label. Never another session's message.
//! - `task`: string or null; the lead's ledger task this card is for, else null (look v9 B N-S3-4: the Board's
//!   "needs you" for it follows the Team view's rule).
//! - `session_id`: string or null; the single linked session of the v1 card editor (unchanged).
//! - `project`: string or null; from `session_id`, else the first live attached session.
//! - `column`: string, a column id.
//! - `state`: state or null; the live session state of a session card, null on manual cards.
//! - `stale`: bool; the session's stale flag (queue), false on manual cards.
//! - `updated_at`: u64; bumps on every change to the card (a recorded refusal is not one).
//! - `group`: string, at most 256 bytes, free text; the swimlane key ("" = no group, lane by project).
//! - `ref`: string, at most 8 KiB; ticket path or URL, "" when none.
//! - `receipt`: Receipt or null.
//! - `waits_on`: [card id], at most 64; display only. Deleting a card removes it from every list.
//! - `attachments`: [Attachment], at most 64, one per session. A session attached to a card has no
//!   automatic card of its own; an unattached session keeps one.
//! - `done_at`: u64 or null; when the card arrived in a done column (a column that takes the done state or
//!   needs proof), null elsewhere. A manual card: `last_moved_at`. A session card: the time the board first saw
//!   it there (stored, so later activity does not move it); a card that leaves Done and returns counts anew.
//! - `last_moved_at`: u64; the last column change (creation counts), for the stale badge and nudge.
//!   An edit that keeps the column does not change it.
//! - `history`: [Change], oldest first, the last 50.
//! - `can_undo`: bool; `board_undo` would restore the state before the last change.
//!
//! ### Attachment
//! - `session_id`: string, a session that existed when attached.
//! - `role`: string, at most 256 bytes, free text (build, review, ...); may be "".
//! - `label`: string or null; the session label (assignee chip), null once the session is gone.
//! - `state`: state or null; that session's live state (status dot), null once it is gone.
//!
//! ### Receipt
//! - `sha`: string, at most 4 KiB.
//! - `command`: string, at most 4 KiB.
//! - `result`: string, at most 4 KiB.
//!
//! ### Change
//! - `at`: u64.
//! - `actor`: string, 1 to 256 bytes: `owner` for the window, or the caller name ticket 183 passes.
//! - `kind`: `"create"` | `"move"` | `"edit"` | `"undo"` | `"refused"`.
//! - `from`: string or null; the column before (null on create).
//! - `to`: string; the column after, or the column a refused write asked for.
//! - `reason`: string or null; why a write was refused (set only on `refused`).
//!
//! ### Requests
//! `board_put` (create lands in the first column, To do by default), `board_move`, `board_delete` as
//! before; `board_task_put { id, group?, ref?, receipt?, waits_on?, attachments? }` (an omitted key keeps
//! its value, `"receipt": null` clears; a `waits_on` that closes a cycle, self included, or names an unknown
//! card is refused; an attachment new to the card must name a live session); `board_undo { id }` (refused when there is
//! nothing to undo; one step; on one of the last 32 deleted cards it restores the card whole, at its place, and
//! the waits on it). A write that changes nothing records nothing.
use crate::api::{BoardTaskRequest, Reply, Request, Response, Session, SessionState};
use serde::{Deserialize, Serialize};
use std::path::Path;
// v1b-17
mod config;
pub use config::Settings; // V2.5-38
mod persistence;
pub mod sources;
// v1b-18
mod decisions;
pub use decisions::{Decision, current as decisions, resolve};
// v1b-16
mod write;
// V2.5-35 (ticket 183): who may write which card; every board request goes through `rights::serve`.
pub mod rights;
// V2.5-39 (ticket 187): the turn-end nudge; its history line goes through `push_change`.
pub mod nudge;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "BoardSource"))]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Session,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "BoardState"))]
#[serde(rename_all = "snake_case")]
pub enum State {
    // A seat that has not had a turn: claimed by no column, so it sits in the first column that claims no state (To do).
    Idle,
    Working,
    NeedsDecision,
    Review,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Column {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub states: Vec<State>,
    #[serde(default)]
    pub needs_decision: bool,
    // V2.5-36: moving a card here needs a Receipt (ticket 183 enforces it).
    #[serde(default)]
    pub proof: bool,
}

// V2.5-36 (ticket 184): task card fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Receipt {
    pub sha: String,
    pub command: String,
    pub result: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Attachment {
    pub session_id: String,
    #[serde(default)]
    pub role: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub at: u64,
    pub actor: String,
    pub kind: ChangeKind,
    pub from: Option<String>,
    pub to: String,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Create,
    Move,
    Edit,
    Undo,
    Refused,
}
const HISTORY: usize = 50;
/// Q9 ko-J12-1: deleted manual cards kept for `board_undo`.
const DELETED: usize = 32;

/// Serde helper: a present key (even `null`) is `Some`, an absent one `None` via `#[serde(default)]`.
pub fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Snapshot {
    pub columns: Vec<Column>,
    pub cards: Vec<serde_json::Value>,
    pub error: Option<String>,
    // Preserve the no-source wire representation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<sources::SourceState>,
    // v1b-16: opaque board.toml stamp; empty when there is no file. Echo it in `board_columns_put`.
    #[serde(default)]
    pub revision: String,
    // V2.5-38 (ticket 186): board.toml `[settings]`.
    #[serde(default)]
    pub settings: Settings,
}

fn defaults() -> Vec<Column> {
    five(old_defaults())
}

/// Needs 43's four columns (as stored, titles kept) with To do first and Done as the proof column.
fn five(mut columns: Vec<Column>) -> Vec<Column> {
    // shortcut: the core has no locale, so To do is "할 일" when a stored title is Hangul and "To do" otherwise;
    // upgrade when the core learns the window language.
    let hangul = columns.iter().any(|c| {
        c.title
            .chars()
            .any(|ch| ('\u{AC00}'..='\u{D7A3}').contains(&ch))
    });
    columns.insert(
        0,
        Column {
            id: "todo".into(),
            title: if hangul { "할 일" } else { "To do" }.into(),
            states: vec![],
            needs_decision: false,
            proof: false,
        },
    );
    for column in &mut columns {
        column.proof = column.id == "done";
    }
    columns
}

/// True when `columns` are needs 43's four by id, states and flags; titles are the user's and are ignored.
fn is_old_defaults(columns: &[Column]) -> bool {
    let old = old_defaults();
    columns.len() == old.len()
        && columns.iter().zip(old).all(|(c, o)| {
            Column {
                title: o.title.clone(),
                ..c.clone()
            } == o
        })
}

/// Needs 43's four-column default, kept to recognise stores that still hold it (needs 150).
fn old_defaults() -> Vec<Column> {
    [
        ("working", "Working", State::Working, false),
        (
            "needs-decision",
            "Needs decision",
            State::NeedsDecision,
            true,
        ),
        ("review", "Review", State::Review, false),
        ("done", "Done", State::Done, false),
    ]
    .into_iter()
    .map(|(id, title, state, needs_decision)| Column {
        id: id.into(),
        title: title.into(),
        states: vec![state],
        needs_decision,
        proof: false,
    })
    .collect()
}

/// Called under the core's session registry lock, with its current attention snapshot.
/// History records the window's writes as `owner`; ticket 183 calls `handle_as` with the caller.
pub fn handle(home: &Path, sessions: &[Session], request: Request) -> Response {
    handle_as(home, sessions, request, "owner")
}

/// `handle` with the name history records for the writer.
pub fn handle_as(home: &Path, sessions: &[Session], request: Request, actor: &str) -> Response {
    run(home, sessions, Err(request), actor)
}

/// V2.5-36: the task writes (`board_task_put`, `board_undo`); replies with the snapshot as `handle` does.
pub fn handle_task(
    home: &Path,
    sessions: &[Session],
    request: BoardTaskRequest,
    actor: &str,
) -> Response {
    run(home, sessions, Ok(request), actor)
}

fn run(
    home: &Path,
    sessions: &[Session],
    request: Result<BoardTaskRequest, Request>,
    actor: &str,
) -> Response {
    if actor.is_empty() || actor.len() > 256 {
        return Err("board actor must have 1 to 256 bytes".into());
    }
    let mut disk = persistence::Disk::load(home)?;
    let old = disk.clone();
    let reset = reconcile_sessions(&mut disk, sessions);
    disk.reload(home);
    release_drags(&mut disk, sessions);
    let request = match request {
        Ok(task) => {
            apply_task(&mut disk, sessions, task, actor)?;
            Request::BoardSnapshot
        }
        Err(request) => request,
    };
    match request {
        Request::BoardSnapshot => {}
        Request::BoardSeen { id, completion_seq } => {
            let session = sessions
                .iter()
                .find(|s| s.id == id)
                .ok_or("board session not found")?;
            if completion_seq > session.completion_seq {
                return Err("future completion sequence".into());
            }
            let seen = disk.seen.entry(id).or_default();
            *seen = (*seen).max(completion_seq);
            if disk.seen.len() > 4096 {
                // Q9 ko-J4-1: markers of sessions no longer listed go first.
                disk.seen
                    .retain(|id, _| sessions.iter().any(|s| s.id == *id));
            }
            if disk.seen.len() > 4096 {
                return Err("board seen marker limit exceeded".into());
            }
        }
        Request::BoardPut {
            id,
            title,
            note,
            session_id,
            column,
        } => {
            validate_text(&title, &note)?;
            // A new link must name a live session; one the edited card already has may outlive it (ticket 621 drops
            // old closed rows), as attachments do.
            let had = |session: &str| {
                id.as_ref().is_some_and(|id| {
                    disk.manual
                        .iter()
                        .any(|c| c.id == *id && c.session_id.as_deref() == Some(session))
                })
            };
            if session_id
                .as_ref()
                .is_some_and(|sid| !had(sid) && !sessions.iter().any(|s| s.id == *sid))
            {
                return Err("linked board session not found".into());
            }
            let column = column.unwrap_or_else(|| disk.columns[0].id.clone());
            require_column(&disk.columns, &column)?;
            if let Some(id) = id {
                let card = manual_mut(&mut disk, &id)?;
                let before = card.clone();
                card.title = title;
                card.note = note;
                card.session_id = session_id;
                card.column = column;
                commit(card, before, actor)?;
            } else {
                if disk.manual.len() >= 4096 {
                    return Err("board manual card limit exceeded".into());
                }
                let now = crate::queue::now_ms();
                disk.manual.push(persistence::Manual {
                    id: crate::store::new_id()?,
                    title,
                    note,
                    session_id,
                    history: vec![Change {
                        at: now,
                        actor: actor.into(),
                        kind: ChangeKind::Create,
                        from: None,
                        to: column.clone(),
                        reason: None,
                    }],
                    column,
                    updated_at: now,
                    group: String::new(),
                    reference: String::new(),
                    receipt: None,
                    waits_on: vec![],
                    attachments: vec![],
                    last_moved_at: now,
                    undo: None,
                    extra: Default::default(),
                });
            }
        }
        Request::BoardDelete { id } => {
            let at = disk
                .manual
                .iter()
                .position(|c| c.id == id)
                .ok_or("manual card not found")?;
            let card = disk.manual.remove(at);
            let mut waited_by = vec![];
            // V2.5-36: no card keeps waiting on a deleted one.
            for card in &mut disk.manual {
                if card.waits_on.contains(&id) {
                    waited_by.push(card.id.clone());
                    card.waits_on.retain(|w| *w != id);
                }
            }
            // Q9 ko-J12-1: kept whole, so `board_undo` brings back every field and the waits on it.
            disk.deleted.push(persistence::Deleted {
                card,
                at,
                waited_by,
            });
            let over = disk.deleted.len().saturating_sub(DELETED);
            disk.deleted.drain(..over);
        }
        Request::BoardMove {
            source: Source::Manual,
            id,
            column,
        } => {
            require_column(&disk.columns, &column)?;
            let card = manual_mut(&mut disk, &id)?;
            let before = card.clone();
            card.column = column;
            commit(card, before, actor)?;
        }
        Request::BoardMove {
            source: Source::Session,
            id,
            column,
        } => {
            require_column(&disk.columns, &column)?;
            let session = sessions
                .iter()
                .find(|s| s.id == id)
                .ok_or("board session not found")?;
            let updated_at = next_update(
                disk.held
                    .get(&id)
                    .map_or(session.attention.last_activity, |h| h.updated_at),
            )?;
            let extra = disk
                .held
                .get(&id)
                .map(|h| h.extra.clone())
                .unwrap_or_default();
            disk.held.insert(
                id.clone(),
                persistence::Held {
                    column,
                    state: session_state(session, disk.seen.get(&id).copied().unwrap_or(0)),
                    lifecycle: session.state,
                    completion_seq: session.completion_seq,
                    updated_at,
                    extra,
                },
            );
            if disk.held.len() > 4096 {
                return Err("board held drag limit exceeded".into());
            }
        }
        // v1b-16
        Request::BoardColumnsPut { revision, columns } => {
            write::put(home, &mut disk, &revision, &columns)?;
        }
        // V2.5-38
        Request::BoardSettingsPut {
            revision,
            stale_minutes,
            turn_end_nudge,
            done_days,
        } => {
            let settings = Settings {
                stale_minutes,
                turn_end_nudge,
                done_days: done_days.unwrap_or_else(|| disk.settings.unwrap_or_default().done_days),
            };
            write::put_settings(home, &mut disk, &revision, &settings)?;
        }
        _ => return Err("not a board request".into()),
    }
    release_drags(&mut disk, sessions);
    stamp_done(&mut disk, sessions);
    if disk != old {
        disk.save(home)?;
    }
    if reset {
        eprintln!("board: stale completion markers reset");
    }
    // v1b-16
    let revision = write::revision(&disk);
    let columns = disk.columns;
    // Look 11-17 v5 item 9: a task card's text is its own task's outcome.
    let tasks = crate::ledger::Ledger::open(home).list().unwrap_or_default();
    // V2.5-36: a session attached to a task card shows under it, not as a card of its own.
    let attached: std::collections::BTreeSet<&str> = disk
        .manual
        .iter()
        .flat_map(|c| c.attachments.iter().map(|a| a.session_id.as_str()))
        .collect();
    let mut cards: Vec<_> = sessions.iter().filter(|s| !attached.contains(s.id.as_str())).map(|s| {
        let state = session_state(s, disk.seen.get(&s.id).copied().unwrap_or(0));
        let column = state_column(&columns, &state);
        let held = disk.held.get(&s.id);
        let updated_at = held.map_or(s.attention.last_activity, |h| h.updated_at.max(s.attention.last_activity));
        serde_json::json!({
            "id": s.id, "source": "session", "title": s.label, "note": "", "text": s.label, "task": null,
            "session_id": s.id, "project": s.project, "column": held.map_or(&column.id, |h| &h.column),
            "state": state, "stale": s.attention.stale,
            "updated_at": updated_at,
            // V2.5-36: task keys, empty on session cards.
            "group": "", "ref": "", "receipt": null, "waits_on": [], "attachments": [],
            "last_moved_at": updated_at, "history": [], "can_undo": false,
        })
    }).collect();
    cards.extend(
        disk.manual
            .iter()
            .map(|c| manual_card(c, &columns, sessions, &disk.seen, &tasks)),
    );
    let source_states = sources::merge(home, &columns, &mut cards);
    // Ticket 1066: when each card arrived in a done column (null elsewhere).
    for card in &mut cards {
        let done = columns.iter().any(|c| is_done(c) && card["column"] == c.id);
        let at = match card["source"].as_str() {
            Some("session") => card["id"]
                .as_str()
                .and_then(|id| disk.done_at.get(id).copied()),
            _ => card["last_moved_at"]
                .as_u64()
                .or(card["updated_at"].as_u64()),
        };
        card["done_at"] = if done {
            serde_json::json!(at)
        } else {
            serde_json::Value::Null
        };
    }
    // v1b-18: manual edits and board reads refresh the decision items at once.
    decisions::publish(home, decisions::raised(&columns, &cards), &disk.resolved);
    Ok(Reply::BoardSnapshot {
        board: Snapshot {
            columns,
            cards,
            error: disk.config_error,
            sources: source_states,
            // v1b-16
            revision,
            settings: disk.settings.unwrap_or_default(),
        },
    })
}

/// V2.5-36: `board_task_put` and `board_undo` on the loaded store; an error leaves it unwritten.
fn apply_task(
    disk: &mut persistence::Disk,
    sessions: &[Session],
    request: BoardTaskRequest,
    actor: &str,
) -> Result<(), String> {
    match request {
        BoardTaskRequest::BoardTaskPut {
            id,
            group,
            reference,
            receipt,
            waits_on,
            attachments,
        } => {
            if let Some(waits) = &waits_on {
                if let Some(missing) = waits
                    .iter()
                    .find(|w| !disk.manual.iter().any(|c| c.id == **w))
                {
                    return Err(format!("waits_on card not found: {missing}"));
                }
                if would_cycle(&disk.manual, &id, waits) {
                    return Err("waits_on would make a cycle".into());
                }
            }
            // A new attachment must name a live session; one the card already has may outlive it.
            let had = |session: &str| {
                disk.manual
                    .iter()
                    .any(|c| c.id == id && c.attachments.iter().any(|a| a.session_id == session))
            };
            if let Some(missing) = attachments
                .iter()
                .flatten()
                .find(|a| !had(&a.session_id) && !sessions.iter().any(|s| s.id == a.session_id))
            {
                return Err(format!(
                    "attached session not found: {}",
                    missing.session_id
                ));
            }
            let card = manual_mut(disk, &id)?;
            let before = card.clone();
            if let Some(group) = group {
                card.group = group;
            }
            if let Some(reference) = reference {
                card.reference = reference;
            }
            if let Some(receipt) = receipt {
                card.receipt = receipt;
            }
            if let Some(waits_on) = waits_on {
                card.waits_on = waits_on;
            }
            if let Some(attachments) = attachments {
                card.attachments = attachments;
            }
            validate_task(card)?;
            commit(card, before, actor)?;
        }
        // Q9 ko-J12-1: undo on a deleted card restores it whole (a closed linked session too).
        BoardTaskRequest::BoardUndo { id } if !disk.manual.iter().any(|c| c.id == id) => {
            let i = disk
                .deleted
                .iter()
                .rposition(|d| d.card.id == id)
                .ok_or("manual card not found")?;
            if disk.manual.len() >= 4096 {
                return Err("board manual card limit exceeded".into());
            }
            let persistence::Deleted {
                mut card,
                at,
                waited_by,
            } = disk.deleted.remove(i);
            // Nothing waits on a gone card, so its own waits close no loop; drop cards deleted since.
            card.waits_on
                .retain(|w| disk.manual.iter().any(|c| c.id == *w));
            card.undo = None;
            card.updated_at = next_update(card.updated_at)?;
            push_change(&mut card, actor, ChangeKind::Undo, None, None);
            disk.manual.insert(at.min(disk.manual.len()), card);
            for waiter in waited_by {
                if !would_cycle(&disk.manual, &waiter, std::slice::from_ref(&id))
                    && let Some(c) = disk.manual.iter_mut().find(|c| c.id == waiter)
                    && c.waits_on.len() < 64
                {
                    c.waits_on.push(id.clone());
                }
            }
        }
        BoardTaskRequest::BoardUndo { id } => {
            let mut prev = manual_mut(disk, &id)?
                .undo
                .clone()
                .ok_or("nothing to undo on this card")?;
            // The restored waits_on drops cards deleted since and must still be acyclic.
            prev.waits_on
                .retain(|w| disk.manual.iter().any(|c| c.id == *w));
            if would_cycle(&disk.manual, &id, &prev.waits_on) {
                return Err("undo would make a waits_on cycle".into());
            }
            let card = manual_mut(disk, &id)?;
            let (from, updated_at, last_moved_at) =
                (card.column.clone(), card.updated_at, card.last_moved_at);
            let history = std::mem::take(&mut card.history);
            *card = *prev;
            card.history = history;
            card.updated_at = next_update(updated_at)?;
            card.last_moved_at = if card.column == from {
                last_moved_at
            } else {
                card.updated_at
            };
            push_change(card, actor, ChangeKind::Undo, Some(from), None);
        }
    }
    Ok(())
}

/// V2.5-36: records a write the caller refused (ticket 183's rights) in the card's history; the card
/// itself does not change.
pub fn record_refusal(
    home: &Path,
    id: &str,
    actor: &str,
    to: &str,
    reason: &str,
) -> Result<(), String> {
    if actor.is_empty() || actor.len() > 256 || to.len() > 256 || reason.len() > 4096 {
        return Err("board refusal fields too long".into());
    }
    let mut disk = persistence::Disk::load(home)?;
    let card = manual_mut(&mut disk, id)?;
    let from = card.column.clone();
    push_change(
        card,
        actor,
        ChangeKind::Refused,
        Some(from),
        Some((to, reason)),
    );
    disk.save(home)
}

/// A closed ledger task takes its board cards along: every card linked or attached to one of its seats (the task's own
/// sessions) moves to the done column (real-app look 11-17 N24: a merged task's card stayed in Needs you, "1 card needs
/// you", because the lead's board rights ended with its workers). Never by title: the board is shared, and a lead could
/// name a task after another project's card. A card without a receipt gets the close as one.
pub fn retire_task(home: &Path, seats: &[String], how: &str) -> Result<(), String> {
    move_task_cards(home, seats, State::Done, Some(how), None)
}

/// Look 11-17 v5 item 8: a task whose merge waits for the user is in the needs-decision column (where the decision
/// queue's cards are), and goes back to review once the user answered. As `retire_task`, by the task's seats.
/// Look 1117 v12 B N12-S2-1: a task its lead kept no card for gets one when its merge waits (attached to its seats), so
/// the Board lists it under Needs you as the Team view, the lead's chip and Decisions do.
pub fn park_task(home: &Path, task: &crate::ledger::Task, waiting: bool) -> Result<(), String> {
    let seats: Vec<String> = task.seats.iter().map(|s| s.session.clone()).collect();
    if !waiting {
        return move_task_cards(home, &seats, State::Review, None, None);
    }
    let mut attachments: Vec<Attachment> = Vec::new();
    for s in &task.seats {
        if attachments.len() < 64 && !attachments.iter().any(|a| a.session_id == s.session) {
            attachments.push(Attachment {
                session_id: s.session.clone(),
                role: s.role.clone(),
            });
        }
    }
    // The board's title cap is 256 bytes; the card shows the task's own title anyway (`manual_card`).
    let mut title: String = task.title.trim().into();
    while title.len() > 256 {
        title.pop();
    }
    if title.is_empty() {
        title.clone_from(&task.id);
    }
    move_task_cards(
        home,
        &seats,
        State::NeedsDecision,
        None,
        Some((title, attachments)),
    )
}

/// Look 1117 v13 B N13-S2-1: one rule for "needs you" (decisions waiting for the person). A lead's task card is the
/// person's only while its merge card waits (`merging`: the tasks with an open merge card); one that sits in a
/// needs-decision column otherwise (its lead put it there for a seat blocked on the lead) shows in the Working column,
/// where the window sorts it by its seats, and is not counted.
pub fn task_cards_by_merge(board: &mut Snapshot, merging: &[String]) {
    let needs = |c: &Column| c.needs_decision || c.states.contains(&State::NeedsDecision);
    let Some(to) = board
        .columns
        .iter()
        .find(|c| c.states.contains(&State::Working))
        .or_else(|| board.columns.iter().find(|c| !needs(c)))
        .map(|c| c.id.clone())
    else {
        return;
    };
    for card in &mut board.cards {
        let waits = card["task"]
            .as_str()
            .is_none_or(|t| merging.iter().any(|m| m == t));
        if !waits
            && board
                .columns
                .iter()
                .any(|c| needs(c) && card["column"] == c.id.as_str())
        {
            card["column"] = to.clone().into();
        }
    }
}

/// The task's cards to the first column of `state` (Done: the last column when none says so); `how` closes the task and
/// is the receipt of a card without one; `make` is the card made there when the task has none.
fn move_task_cards(
    home: &Path,
    seats: &[String],
    state: State,
    how: Option<&str>,
    make: Option<(String, Vec<Attachment>)>,
) -> Result<(), String> {
    let mut disk = persistence::Disk::load(home)?;
    disk.reload(home);
    let target = disk
        .columns
        .iter()
        .find(|c| c.states.contains(&state))
        .or_else(|| {
            (state == State::Done)
                .then(|| disk.columns.last())
                .flatten()
        })
        .map(|c| c.id.clone());
    let Some(done) = target else {
        return Ok(());
    };
    let ours = |c: &persistence::Manual| {
        c.session_id.as_ref().is_some_and(|s| seats.contains(s))
            || c.attachments.iter().any(|a| seats.contains(&a.session_id))
    };
    let mut changed = false;
    for card in disk
        .manual
        .iter_mut()
        .filter(|c| c.column != done && ours(c))
    {
        let before = card.clone();
        card.column = done.clone();
        if let Some(how) = how {
            card.receipt.get_or_insert_with(|| Receipt {
                sha: "-".into(),
                command: "nunchiro task".into(),
                result: format!("task {how}"),
            });
        }
        commit(card, before, "nunchiro")?;
        changed = true;
    }
    if let Some((title, attachments)) = make
        && !attachments.is_empty()
        && !disk.manual.iter().any(ours)
        && disk.manual.len() < 4096
    {
        let now = crate::queue::now_ms();
        let card = persistence::Manual {
            id: crate::store::new_id()?,
            title,
            note: String::new(),
            session_id: None,
            history: vec![Change {
                at: now,
                actor: "nunchiro".into(),
                kind: ChangeKind::Create,
                from: None,
                to: done.clone(),
                reason: None,
            }],
            column: done,
            updated_at: now,
            group: String::new(),
            reference: String::new(),
            receipt: None,
            waits_on: vec![],
            attachments,
            last_moved_at: now,
            undo: None,
            extra: Default::default(),
        };
        validate_task(&card)?;
        disk.manual.push(card);
        changed = true;
    }
    if changed { disk.save(home) } else { Ok(()) }
}

fn manual_mut<'a>(
    disk: &'a mut persistence::Disk,
    id: &str,
) -> Result<&'a mut persistence::Manual, String> {
    disk.manual
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "manual card not found".into())
}

/// Stamps a changed card (nothing when `card == before`): `updated_at`, `last_moved_at` on a column
/// change, one history entry, and `before` as the one-step undo.
fn commit(
    card: &mut persistence::Manual,
    before: persistence::Manual,
    actor: &str,
) -> Result<(), String> {
    if *card == before {
        return Ok(());
    }
    card.updated_at = next_update(before.updated_at)?;
    let moved = card.column != before.column;
    if moved {
        card.last_moved_at = card.updated_at;
    }
    let mut prev = before;
    prev.history.clear();
    prev.undo = None;
    let from = prev.column.clone();
    card.undo = Some(Box::new(prev));
    push_change(
        card,
        actor,
        if moved {
            ChangeKind::Move
        } else {
            ChangeKind::Edit
        },
        Some(from),
        None,
    );
    Ok(())
}

/// `refused` carries the requested column and the reason; otherwise `to` is the card's column.
fn push_change(
    card: &mut persistence::Manual,
    actor: &str,
    kind: ChangeKind,
    from: Option<String>,
    refused: Option<(&str, &str)>,
) {
    card.history.push(Change {
        at: crate::queue::now_ms(),
        actor: actor.into(),
        kind,
        from,
        to: refused.map_or_else(|| card.column.clone(), |(to, _)| to.into()),
        reason: refused.map(|(_, why)| why.into()),
    });
    let over = card.history.len().saturating_sub(HISTORY);
    card.history.drain(..over);
}

/// True when `id` waiting on `waits` closes a loop through the stored `waits_on` edges (self included).
fn would_cycle(manual: &[persistence::Manual], id: &str, waits: &[String]) -> bool {
    let mut stack: Vec<&str> = waits.iter().map(String::as_str).collect();
    let mut seen = std::collections::BTreeSet::new();
    while let Some(next) = stack.pop() {
        if next == id {
            return true;
        }
        if seen.insert(next)
            && let Some(card) = manual.iter().find(|c| c.id == next)
        {
            stack.extend(card.waits_on.iter().map(String::as_str));
        }
    }
    false
}

fn validate_task(card: &persistence::Manual) -> Result<(), String> {
    let receipt = card
        .receipt
        .as_ref()
        .is_some_and(|r| r.sha.len() > 4096 || r.command.len() > 4096 || r.result.len() > 4096);
    let mut sessions = std::collections::BTreeSet::new();
    if card.group.len() > 256
        || card.reference.len() > 8192
        || receipt
        || card.waits_on.len() > 64
        || card.attachments.len() > 64
        || card.waits_on.iter().any(|w| !crate::store::valid_id(w))
        || card.attachments.iter().any(|a| {
            !crate::store::valid_id(&a.session_id)
                || a.role.len() > 256
                || !sessions.insert(&a.session_id)
        })
    {
        return Err(
            "board task fields: group at most 256 bytes, ref 8 KiB, receipt fields 4 KiB; \
                    at most 64 valid waits_on ids and 64 distinct attached sessions, role 256 bytes"
                .into(),
        );
    }
    Ok(())
}

// v1b-18: one manual-card shape and column fallback for board reads and decision items.
fn manual_column<'a>(card: &'a persistence::Manual, columns: &'a [Column]) -> &'a str {
    if columns.iter().any(|column| column.id == card.column) {
        &card.column
    } else {
        &columns[0].id
    }
}
fn manual_card(
    c: &persistence::Manual,
    columns: &[Column],
    sessions: &[Session],
    seen: &std::collections::BTreeMap<String, u64>,
    tasks: &[crate::ledger::Task],
) -> serde_json::Value {
    let live = |id: &str| sessions.iter().find(|s| s.id == id);
    // By its attached sessions only: a lead's session is the `session_id` of every card it made.
    let task = tasks
        .iter()
        .filter(|t| {
            t.seats
                .iter()
                .any(|s| c.attachments.iter().any(|a| a.session_id == s.session))
        })
        .max_by_key(|t| (t.closed.is_none(), t.updated));
    let text = if !c.note.trim().is_empty() {
        c.note.as_str()
    } else {
        task.map_or(c.title.as_str(), |t| t.title.as_str())
    };
    // Look 1117 v13 Home S3-2: a merged task's seats are gone; its card stays in its task's place, not "no group".
    let project = c
        .session_id
        .as_deref()
        .and_then(live)
        .or_else(|| c.attachments.iter().find_map(|a| live(&a.session_id)))
        .map(|s| &s.project)
        .or(task.map(|t| &t.place));
    let attachments: Vec<_> = c
        .attachments
        .iter()
        .map(|a| {
            let s = live(&a.session_id);
            serde_json::json!({
                "session_id": a.session_id, "role": a.role,
                "label": s.map(|s| &s.label),
                "state": s.map(|s| session_state(s, seen.get(&s.id).copied().unwrap_or(0))),
            })
        })
        .collect();
    serde_json::json!({
        "id": c.id, "source": "manual", "title": c.title, "note": c.note, "text": text,
        "session_id": c.session_id, "project": project, "column": manual_column(c, columns),
        "state": null, "stale": false, "updated_at": c.updated_at,
        "group": c.group, "ref": c.reference, "receipt": c.receipt, "waits_on": c.waits_on,
        "attachments": attachments, "last_moved_at": c.last_moved_at, "history": c.history,
        "can_undo": c.undo.is_some(),
        // Look v9 B N-S3-4: the lead's task this card is for; the Board reads "needs you" for it by the Team view's rule.
        "task": task.map(|t| &t.id),
    })
}

fn release_drags(disk: &mut persistence::Disk, sessions: &[Session]) {
    disk.held.retain(|id, held| {
        disk.columns.iter().any(|c| c.id == held.column)
            && sessions.iter().any(|s| {
                s.id == *id
                    && s.state == held.lifecycle
                    && s.completion_seq == held.completion_seq
                    && session_state(s, disk.seen.get(id).copied().unwrap_or(0)) == held.state
            })
    });
}

/// A column that takes the done state or needs proof (the web's `isDone`).
fn is_done(column: &Column) -> bool {
    column.states.contains(&State::Done) || column.proof
}

/// Ticket 1066: keeps `done_at` for the session cards now in a done column: the stored time stays, a new arrival gets
/// the card's `updated_at` (the finish time when the board is read soon after). A card that leaves Done, or its
/// session, drops out, so a later return counts from its newest arrival.
fn stamp_done(disk: &mut persistence::Disk, sessions: &[Session]) {
    let attached: std::collections::BTreeSet<&str> = disk
        .manual
        .iter()
        .flat_map(|c| c.attachments.iter().map(|a| a.session_id.as_str()))
        .collect();
    let mut now_done = std::collections::BTreeMap::new();
    for s in sessions
        .iter()
        .filter(|s| !attached.contains(s.id.as_str()))
    {
        let state = session_state(s, disk.seen.get(&s.id).copied().unwrap_or(0));
        let held = disk.held.get(&s.id);
        let column = held.map_or_else(
            || state_column(&disk.columns, &state),
            |h| {
                disk.columns
                    .iter()
                    .find(|c| c.id == h.column)
                    .unwrap_or(&disk.columns[0])
            },
        );
        if is_done(column) {
            let at = disk.done_at.get(&s.id).copied().unwrap_or_else(|| {
                held.map_or(s.attention.last_activity, |h| {
                    h.updated_at.max(s.attention.last_activity)
                })
            });
            now_done.insert(s.id.clone(), at);
        }
    }
    disk.done_at = now_done;
}

fn reconcile_sessions(disk: &mut persistence::Disk, sessions: &[Session]) -> bool {
    let mut reset = false;
    for session in sessions {
        let seen_ahead = disk
            .seen
            .get(&session.id)
            .is_some_and(|seen| *seen > session.completion_seq);
        if seen_ahead
            || disk
                .held
                .get(&session.id)
                .is_some_and(|held| held.completion_seq > session.completion_seq)
        {
            if seen_ahead {
                disk.seen.remove(&session.id);
            }
            disk.held.remove(&session.id);
            reset = true;
        }
    }
    reset
}

/// The last board.json `observe` parsed, with the stamp it had.
static LOADED: std::sync::Mutex<
    Option<(std::path::PathBuf, persistence::Stamp, persistence::Disk)>,
> = std::sync::Mutex::new(None);

/// Observe outgoing states before another core mutation can hide a transition between board reads.
pub(crate) fn observe(home: &Path, sessions: impl FnOnce() -> Vec<Session>) -> Result<(), String> {
    // v1b-18: the tick also refreshes decision items (and, without board.json, still reads board.toml's sources).
    let sessions = std::cell::LazyCell::new(sessions);
    let stamp = match std::fs::symlink_metadata(home.join("board.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            decisions::refresh(home, &mut persistence::Disk::default(), || &sessions);
            return Ok(());
        }
        Err(e) => return Err(e.to_string()),
        Ok(meta) => persistence::Stamp::of(&meta),
    };
    // The idle tick re-reads board.json only when its stamp (mtime, inode, size, ctime) moved.
    let cached = LOADED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(h, s, _)| h == home && *s == stamp)
        .map(|(_, _, d)| d.clone());
    let mut disk = match cached {
        Some(disk) => disk,
        None => {
            let disk = persistence::Disk::load(home)?;
            *LOADED.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((home.to_path_buf(), stamp, disk.clone()));
            disk
        }
    };
    decisions::refresh(home, &mut disk, || &sessions);
    let done_before = disk.done_at.clone();
    stamp_done(&mut disk, &sessions);
    let stamped = disk.done_at != done_before;
    if !stamped && disk.held.is_empty() && disk.seen.is_empty() {
        return Ok(());
    }
    let count = disk.held.len();
    let reset = reconcile_sessions(&mut disk, &sessions);
    release_drags(&mut disk, &sessions);
    if reset || stamped || disk.held.len() != count {
        disk.save(home)?;
    }
    if reset {
        eprintln!("board: stale completion markers reset");
    }
    Ok(())
}

fn require_column(columns: &[Column], id: &str) -> Result<(), String> {
    if columns.iter().any(|c| c.id == id) {
        Ok(())
    } else {
        Err("board column not found".into())
    }
}
fn validate_text(title: &str, note: &str) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 256 || note.len() > 65536 {
        Err("board title must have 1 to 256 bytes; note at most 65536 bytes".into())
    } else {
        Ok(())
    }
}
fn next_update(previous: u64) -> Result<u64, String> {
    Ok(crate::queue::now_ms().max(previous.checked_add(1).ok_or("board timestamp overflow")?))
}

/// The column a session card lands in: the first that claims its state; an idle seat (no state to claim) takes the first
/// column that claims none (To do), and any card with no match the first column.
fn state_column<'a>(columns: &'a [Column], state: &State) -> &'a Column {
    let wanted = |c: &&Column| match state {
        State::Idle => c.states.is_empty(),
        _ => c.states.contains(state),
    };
    columns.iter().find(wanted).unwrap_or(&columns[0])
}

fn session_state(session: &Session, seen: u64) -> State {
    // Reuse 03's Synara attention projection and stale flag, never a second clock.
    // Ticket 286 item 1 r5: an agent that quit is done, though the shell it left still runs.
    if session.agent_ended
        || matches!(
            session.state,
            SessionState::Exited | SessionState::Closed | SessionState::Resumable
        )
    {
        State::Done
    } else if session.state == SessionState::Failed
        || session.attention.failed
        || session.attention.waiting
    {
        State::NeedsDecision
    } else if session.attention.working || session.attention.background > 0 {
        // Ticket 1090: only a turn in progress is working. A session that never finished a turn (an agent at its
        // first prompt, a shell) counted as working before, so the board said "working" far more often than agents ran.
        State::Working
    } else if session.completion_seq > seen {
        State::Review
    } else if session.completion_seq == 0 && session.kind != crate::api::AgentKind::Shell {
        // Tickets 1091, 1092: a seat with no turn yet is neither finished work nor work to review. A shell has no turns, so it keeps its old state.
        State::Idle
    } else {
        State::Done
    }
}
