//! V2.5-35 (ticket 183, needs 154 items 3, 9, 13): who may write which board card. Every board request,
//! from the window, the owner's CLI and session callers alike, goes through `serve`, and every write there
//! through `check`.
//!
//! - The owner (the window, or the CLI outside every session) writes every card; no receipt needed.
//! - The coordinator of a project, a live session that is the `parent` of at least one live session in that
//!   project, writes every card of that project, Done included. Computed from the registry on every write,
//!   never from a request field; the caller is the session the core resolved from the token and peer check.
//! - Any other session moves only a card it is attached to.
//! - An agent's move into a `proof` column without a receipt lands in Review instead (`RECEIPT_NEEDED`).
//!
//! Writes and refusals land in the card history under the caller's label.
use super::{Column, Receipt, Snapshot, Source, State, handle_as, handle_task, record_refusal};
use crate::api::{BoardTaskRequest, Reply, Request, Response, Session, SessionState};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path};

pub const RECEIPT_NEEDED: &str = "receipt needed (sha, command, result)";
/// One receipt field (sha, command, result) at most, as the store caps it (ticket 184).
pub const RECEIPT_FIELD_MAX: usize = 4096;

/// Who writes: the owner, or a session by the id the core resolved from its token and the peer check.
#[derive(Clone, Copy, Debug)]
pub enum Writer<'a> {
    Owner,
    Session(&'a str),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// Do the write, but into this column (Review) instead of the `proof` column it asked for.
    Review(String),
    Refuse(String),
}

/// One board write, as the rights check sees it.
pub struct Write<'a> {
    /// The card before the write (snapshot JSON); `None` creates one.
    pub card: Option<&'a Value>,
    /// The sessions linked to the card after the write: `session_id`, then the attachments.
    pub links: Vec<String>,
    /// The column the write puts the card in, when that changes it (or on create).
    pub to: Option<&'a str>,
    /// The card carries a receipt after the write.
    pub receipt: bool,
    /// The write only moves the card (the one write an attached session may make).
    pub move_only: bool,
}

/// The rights rule; pure, so the window and the CLI share it.
pub fn check(sessions: &[Session], columns: &[Column], writer: Writer, write: &Write) -> Verdict {
    check_as(sessions, columns, writer, write, false)
}
/// `check`, with `lead`: the caller is the seat of its place's lead (ticket 990). A lead is the coordinator of its own
/// project whether or not a worker of its is live now: in a real run it closed its workers after the merge and could
/// not move their cards to Done.
pub fn check_as(
    sessions: &[Session],
    columns: &[Column],
    writer: Writer,
    write: &Write,
    lead: bool,
) -> Verdict {
    let Writer::Session(caller) = writer else {
        return Verdict::Allow;
    };
    let live = |id: &str| {
        sessions
            .iter()
            .find(|s| s.id == id && s.state == SessionState::Running)
    };
    let refuse = |why: &str| Verdict::Refuse(why.into());
    if live(caller).is_none() {
        return refuse("caller session is not live");
    }
    let projects: BTreeSet<&Path> = sessions
        .iter()
        .filter(|s| s.state == SessionState::Running && s.parent.as_deref() == Some(caller))
        .chain(live(caller).filter(|_| lead))
        .map(|s| s.project.as_path())
        .collect();
    if projects.is_empty() {
        let attached = write.card.is_some_and(|c| {
            c["attachments"]
                .as_array()
                .is_some_and(|a| a.iter().any(|a| a["session_id"] == caller))
        });
        if !write.move_only {
            return refuse(
                "not the coordinator (no live child sessions): only the coordinator adds or edits cards",
            );
        }
        if !attached {
            return refuse("not attached to this card: a session moves only its own card");
        }
    } else {
        if let Some(card) = write.card
            && !card["project"]
                .as_str()
                .is_some_and(|p| projects.contains(Path::new(p)))
        {
            return refuse("card is in another project than your child sessions");
        }
        // Every linked session the registry knows (live or not) is in those projects, and one is live.
        let linked: Vec<&Session> = write
            .links
            .iter()
            .filter_map(|id| sessions.iter().find(|s| s.id == *id))
            .collect();
        // A lead's card may hold only sessions that ended (its workers after the merge).
        if !(lead || linked.iter().any(|s| live(&s.id).is_some()))
            || linked
                .iter()
                .any(|s| !projects.contains(s.project.as_path()))
        {
            return refuse("the card would link a session outside your child sessions' projects");
        }
    }
    if let Some(to) = write.to
        && columns.iter().any(|c| c.id == to && c.proof)
        && !write.receipt
    {
        return match review_column(columns) {
            Some(review) => Verdict::Review(review.into()),
            None => Verdict::Refuse(format!("{RECEIPT_NEEDED}; the board has no Review column")),
        };
    }
    Verdict::Allow
}

fn review_column(columns: &[Column]) -> Option<&str> {
    columns
        .iter()
        .find(|c| c.states.contains(&State::Review))
        .or_else(|| columns.iter().find(|c| c.id == "review"))
        .map(|c| c.id.as_str())
}

/// The column `board_done` moves into: the first `proof` column, else the one claiming `done`.
fn done_column(columns: &[Column]) -> Option<&str> {
    columns
        .iter()
        .find(|c| c.proof)
        .or_else(|| columns.iter().find(|c| c.states.contains(&State::Done)))
        .map(|c| c.id.as_str())
}

/// The one shared hidden-character set: bidi overrides, isolates and the Arabic letter mark, zero-width and
/// line-separator marks (Unicode Cf/Zl/Zp) reorder or hide what a reader sees (Trojan Source); tag characters are an
/// invisible text channel a model reads as ASCII. Used by board text, the wake line, the nudge line and deny notes.
pub fn hidden(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{E0000}'..='\u{E007F}')
}

/// A receipt is plain text: no control or hidden characters, each field 1 to `RECEIPT_FIELD_MAX` bytes.
pub fn check_receipt(receipt: &Receipt) -> Result<(), String> {
    for field in [&receipt.sha, &receipt.command, &receipt.result] {
        if field.trim().is_empty() || field.len() > RECEIPT_FIELD_MAX {
            return Err(format!(
                "receipt fields (sha, command, result) need 1 to {RECEIPT_FIELD_MAX} bytes each"
            ));
        }
        if field.chars().any(|c| c.is_control() || hidden(c)) {
            return Err("receipt must be plain text: no control characters".into());
        }
    }
    Ok(())
}

/// Agent-written card text (title, note, group, ref, role) has no control or hidden characters; a note keeps `\n`
/// and `\t`.
fn check_text(request: &Request) -> Result<(), String> {
    let plain = |text: &str| !text.chars().any(|c| c.is_control() || hidden(c));
    let roles =
        |list: &Option<Vec<super::Attachment>>| list.iter().flatten().all(|a| plain(&a.role));
    let ok = match request {
        Request::BoardPut { title, note, .. } => {
            plain(title)
                && !note
                    .chars()
                    .any(|c| (c.is_control() && c != '\n' && c != '\t') || hidden(c))
        }
        Request::BoardAdd {
            title,
            group,
            reference,
            attachments,
            ..
        } => {
            plain(title)
                && group.as_deref().is_none_or(plain)
                && reference.as_deref().is_none_or(plain)
                && roles(attachments)
        }
        Request::BoardTaskPut {
            group,
            reference,
            attachments,
            ..
        } => {
            group.as_deref().is_none_or(plain)
                && reference.as_deref().is_none_or(plain)
                && roles(attachments)
        }
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err("board text must be plain: no control characters".into())
    }
}

/// The history name of a writer: `owner`, or the session's label (its id when the label is empty, has
/// control or hidden characters or reads as the owner's).
pub(super) fn actor(sessions: &[Session], writer: Writer) -> String {
    match writer {
        Writer::Owner => "owner".into(),
        Writer::Session(id) => sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.label.trim())
            .filter(|l| {
                !l.is_empty()
                    && l.len() <= 256
                    && !l.chars().any(|c| c.is_control() || hidden(c))
                    && !["owner", "window", "user"].contains(&l.to_ascii_lowercase().as_str())
            })
            .unwrap_or(id)
            .into(),
    }
}

fn snapshot(home: &Path, sessions: &[Session]) -> Result<Snapshot, String> {
    match handle_as(home, sessions, Request::BoardSnapshot, "owner")? {
        Reply::BoardSnapshot { board } => Ok(board),
        _ => Err("board snapshot expected".into()),
    }
}

fn attached(card: &Value) -> Vec<String> {
    card["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["session_id"].as_str().map(String::from))
        .collect()
}

/// The card's linked sessions: `session_id`, then the attachments.
fn links(card: &Value) -> Vec<String> {
    let mut links: Vec<String> = card["session_id"]
        .as_str()
        .map(String::from)
        .into_iter()
        .collect();
    links.extend(attached(card));
    links
}

/// Does an allowed write, into the column the verdict picked when it is `Some`.
type Perform<'a> = Box<dyn Fn(Option<String>) -> Response + 'a>;

/// Every board request; `handle_as` / `handle_task` do the write after `check` allowed it.
pub fn serve(home: &Path, sessions: &[Session], writer: Writer, request: Request) -> Response {
    let actor = &actor(sessions, writer);
    let session = matches!(writer, Writer::Session(_));
    match request {
        Request::BoardSnapshot => return handle_as(home, sessions, request, actor),
        Request::BoardSelf => {
            let Writer::Session(caller) = writer else {
                return Err("board self runs inside a session".into());
            };
            let mut board = snapshot(home, sessions)?;
            let mine = board
                .cards
                .iter()
                .filter(|c| c["source"] == "manual")
                .filter(|c| {
                    c["attachments"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|a| a["session_id"] == caller))
                })
                .max_by_key(|c| c["updated_at"].as_u64())
                .cloned();
            board.cards = mine.into_iter().collect();
            return Ok(Reply::BoardSnapshot { board });
        }
        // Owner only (the window's own edits); `check_agent` refuses these first, this is the second wall.
        Request::BoardSeen { .. }
        | Request::BoardDelete { .. }
        | Request::BoardColumnsPut { .. }
        | Request::BoardSettingsPut { .. } // V2.5-38
        | Request::BoardUndo { .. }
            if session =>
        {
            return Err("operation not granted".into());
        }
        Request::BoardUndo { id } => {
            return handle_task(home, sessions, BoardTaskRequest::BoardUndo { id }, actor);
        }
        Request::BoardSeen { .. }
        | Request::BoardDelete { .. }
        | Request::BoardColumnsPut { .. }
        | Request::BoardSettingsPut { .. } => {
            return handle_as(home, sessions, request, actor);
        }
        Request::BoardTaskPut {
            receipt: Some(Some(ref r)),
            ..
        }
        | Request::BoardDone {
            receipt: Some(ref r),
            ..
        } => check_receipt(r)?,
        _ => {}
    }
    // An agent's card text reaches the owner's terminal (`board list`): plain text only.
    if session {
        check_text(&request)?;
    }
    // The owner's and the window's writes go to the model unchanged; `check` would allow them all.
    if !session {
        match request {
            Request::BoardTaskPut {
                id,
                group,
                reference,
                receipt,
                waits_on,
                attachments,
            } => {
                let task = BoardTaskRequest::BoardTaskPut {
                    id,
                    group,
                    reference,
                    receipt,
                    waits_on,
                    attachments,
                };
                return handle_task(home, sessions, task, actor);
            }
            Request::BoardPut { .. } | Request::BoardMove { .. } => {
                return handle_as(home, sessions, request, actor);
            }
            _ => {}
        }
    }
    let board = snapshot(home, sessions)?;
    let manual = |id: &str| {
        board
            .cards
            .iter()
            .find(|c| c["source"] == "manual" && c["id"] == id)
            .ok_or_else(|| format!("board card not found: {id}"))
    };
    let has_receipt = |card: &Value| !card["receipt"].is_null();
    let first = board.columns[0].id.clone();
    // The write, then the request that does it with the column the verdict picked.
    let (write, op): (Write, Perform) = match request {
        Request::BoardPut {
            id,
            title,
            note,
            session_id,
            column,
        } => {
            let card = id.as_deref().map(manual).transpose()?;
            // An agent's new card is linked to its writer, so it has a project from the start.
            let session_id = match writer {
                Writer::Session(caller) if id.is_none() && session_id.is_none() => {
                    Some(caller.to_string())
                }
                _ => session_id,
            };
            let mut linked: Vec<String> = session_id.iter().cloned().collect();
            linked.extend(card.map(attached).unwrap_or_default());
            let target = column.clone().unwrap_or_else(|| first.clone());
            let changes = card.is_none_or(|c| c["column"] != target.as_str());
            let to = changes
                .then(|| board.columns.iter().find(|c| c.id == target))
                .flatten();
            (
                Write {
                    card,
                    links: linked,
                    to: to.map(|c| c.id.as_str()),
                    receipt: card.is_some_and(has_receipt),
                    move_only: false,
                },
                Box::new(move |over: Option<String>| {
                    handle_as(
                        home,
                        sessions,
                        Request::BoardPut {
                            id: id.clone(),
                            title: title.clone(),
                            note: note.clone(),
                            session_id: session_id.clone(),
                            column: over.or_else(|| column.clone()),
                        },
                        actor,
                    )
                }),
            )
        }
        Request::BoardAdd {
            title,
            group,
            reference,
            waits_on,
            attachments,
        } => {
            let session_id = match writer {
                Writer::Session(caller) => Some(caller.to_string()),
                Writer::Owner => None,
            };
            let mut linked: Vec<String> = session_id.iter().cloned().collect();
            linked.extend(attachments.iter().flatten().map(|a| a.session_id.clone()));
            let before: BTreeSet<String> = board
                .cards
                .iter()
                .filter(|c| c["source"] == "manual")
                .filter_map(|c| c["id"].as_str().map(String::from))
                .collect();
            let task = group.is_some()
                || reference.is_some()
                || waits_on.is_some()
                || attachments.is_some();
            (
                Write {
                    card: None,
                    links: linked,
                    to: Some(board.columns[0].id.as_str()),
                    receipt: false,
                    move_only: false,
                },
                Box::new(move |_| {
                    let put = Request::BoardPut {
                        id: None,
                        title: title.clone(),
                        note: String::new(),
                        session_id: session_id.clone(),
                        column: None,
                    };
                    let reply = handle_as(home, sessions, put, actor)?;
                    if !task {
                        return Ok(reply);
                    }
                    let Reply::BoardSnapshot { board } = &reply else {
                        return Err("board snapshot expected".into());
                    };
                    let id = board
                        .cards
                        .iter()
                        .filter(|c| c["source"] == "manual" && c["title"] == title.as_str())
                        .filter_map(|c| c["id"].as_str())
                        .find(|id| !before.contains(*id))
                        .ok_or("new board card not found")?
                        .to_string();
                    let task = BoardTaskRequest::BoardTaskPut {
                        id: id.clone(),
                        group: group.clone(),
                        reference: reference.clone(),
                        receipt: None,
                        waits_on: waits_on.clone(),
                        attachments: attachments.clone(),
                    };
                    // A refused task field takes the new card back out: the add writes all or nothing.
                    handle_task(home, sessions, task, actor).inspect_err(|_| {
                        if let Err(e) =
                            handle_as(home, sessions, Request::BoardDelete { id }, actor)
                        {
                            eprintln!("board: refused add not taken back: {e}");
                        }
                    })
                }),
            )
        }
        Request::BoardMove { source, id, column } => {
            let kind = match source {
                Source::Manual => "manual",
                Source::Session => "session",
            };
            let card = board
                .cards
                .iter()
                .find(|c| c["source"] == kind && c["id"] == id.as_str());
            let card = card.ok_or_else(|| format!("board card not found: {id}"))?;
            let to = board
                .columns
                .iter()
                .find(|c| c.id == column)
                .map(|c| c.id.as_str());
            (
                Write {
                    card: Some(card),
                    links: links(card),
                    to,
                    receipt: has_receipt(card),
                    move_only: true,
                },
                Box::new(move |over: Option<String>| {
                    handle_as(
                        home,
                        sessions,
                        Request::BoardMove {
                            source,
                            id: id.clone(),
                            column: over.unwrap_or_else(|| column.clone()),
                        },
                        actor,
                    )
                }),
            )
        }
        Request::BoardTaskPut {
            id,
            group,
            reference,
            receipt,
            waits_on,
            attachments,
        } => {
            let card = manual(&id)?;
            let mut linked: Vec<String> = card["session_id"]
                .as_str()
                .map(String::from)
                .into_iter()
                .collect();
            match &attachments {
                Some(list) => linked.extend(list.iter().map(|a| a.session_id.clone())),
                None => linked.extend(attached(card)),
            }
            let task = BoardTaskRequest::BoardTaskPut {
                id,
                group,
                reference,
                receipt,
                waits_on,
                attachments,
            };
            (
                Write {
                    card: Some(card),
                    links: linked,
                    to: None,
                    receipt: has_receipt(card),
                    move_only: false,
                },
                Box::new(move |_| handle_task(home, sessions, task.clone(), actor)),
            )
        }
        Request::BoardDone { id, receipt } => {
            let card = manual(&id)?;
            let to = done_column(&board.columns).ok_or("the board has no Done column")?;
            let done = to.to_string();
            (
                Write {
                    card: Some(card),
                    links: links(card),
                    to: Some(to),
                    receipt: receipt.is_some() || has_receipt(card),
                    move_only: true,
                },
                Box::new(move |over: Option<String>| {
                    // A redirected move stores no receipt: there was none.
                    if over.is_none()
                        && let Some(receipt) = &receipt
                    {
                        let put = BoardTaskRequest::BoardTaskPut {
                            id: id.clone(),
                            group: None,
                            reference: None,
                            receipt: Some(Some(receipt.clone())),
                            waits_on: None,
                            attachments: None,
                        };
                        handle_task(home, sessions, put, actor)?;
                    }
                    let column = over.unwrap_or_else(|| done.clone());
                    handle_as(
                        home,
                        sessions,
                        Request::BoardMove {
                            source: Source::Manual,
                            id: id.clone(),
                            column,
                        },
                        actor,
                    )
                }),
            )
        }
        _ => return Err("not a board request".into()),
    };
    let card = write.card.filter(|c| c["source"] == "manual");
    let record = |to: Option<&str>, why: &str| {
        if let Some(card) = card {
            let id = card["id"].as_str().unwrap_or_default();
            let to = to.or_else(|| card["column"].as_str()).unwrap_or_default();
            if let Err(e) = record_refusal(home, id, actor, to, why) {
                eprintln!("board: refusal not recorded: {e}");
            }
        }
    };
    // Ticket 990: the caller is the seat of a lead teammate (the mark the core put on the session when it opened it).
    let lead = match writer {
        Writer::Session(caller) => sessions
            .iter()
            .find(|s| s.id == caller)
            .and_then(|s| s.teammate.as_deref())
            .is_some_and(|mate| {
                crate::team::Team::open(home)
                    .list()
                    .is_ok_and(|all| all.iter().any(|t| t.lead && t.id == mate))
            }),
        Writer::Owner => false,
    };
    match check_as(sessions, &board.columns, writer, &write, lead) {
        Verdict::Allow => op(None),
        Verdict::Review(review) => {
            record(write.to, RECEIPT_NEEDED);
            op(Some(review))
        }
        Verdict::Refuse(why) => {
            record(write.to, &why);
            Err(why)
        }
    }
}
