//! V2.5-39 (ticket 187, needs 154 item 12, needs 155): the turn-end nudge. When a session attached to a task
//! card ends a turn and the card did not move during it, the session's next `UserPromptSubmit` hook gets one
//! context line naming the card and the move command. Claude's Stop `additionalContext` continues the turn and
//! Codex's Stop has no context field, so the line waits for the next prompt (`hookSpecificOutput.additionalContext`,
//! the one field both document for adding context without blocking).
//!
//! The session is the one the core resolved from the token and peer check; no payload field is read. The line is
//! never typed into the PTY or composer and goes through no delivery queue; nothing outside Nunchiro's home is
//! written. Card text is another session's: it is quoted, stripped and capped, and serde writes the whole line as
//! one string value.
use super::{ChangeKind, persistence};
use crate::api::Session;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

/// The history line (the approved design's "turn-end nudge sent · card did not move").
pub const HISTORY_LINE: &str = "turn-end nudge sent · card did not move";
/// The only keys a nudge output carries: top level, then inside `hookSpecificOutput`.
pub const OUTPUT_KEYS: &[&str] = &["hookSpecificOutput"];
pub const CONTEXT_KEYS: &[&str] = &["additionalContext", "hookEventName"];
/// How long after the bridge started a nudge reply may still leave; below the hook bridge's 1.6 s read and 1.8 s
/// overall bounds (`crates/nunchiro/src/hook.rs`), so a reply the bridge drops never records "sent".
///
/// V2.5-48: the bridge's overall bound counts from its own start, before it reads stdin, journals and connects;
/// the core cannot see that pre-connect delay, so the bridge sends its start as `started_ms` (wall-clock ms) and
/// the budget counts from it, never later than the core's own accept stamp ([`counted_from`]). Measured numbers:
/// REPORT.md of V2.5-48.
pub const BUDGET: Duration = Duration::from_millis(1200);
/// Card and column titles in the line, at most (the wake line's cap, ticket 159).
const TEXT_MAX: usize = 200;

#[derive(Default)]
struct Turn {
    /// When this turn's `UserPromptSubmit` arrived; none before the first prompt this core saw.
    started: Option<u64>,
    /// Card id and its `last_moved_at` at the turn end that decided the nudge; sent at the next prompt.
    pending: Option<(String, u64)>,
}

/// When the budget counts from: the bridge's reported start, clamped to `arrived` (the core's accept stamp, wall
/// clock `arrived_ms`), so a claimed future start never stretches the budget. A start more than the budget ago
/// leaves none; no claim counts from `arrived`.
pub fn counted_from(arrived: Instant, arrived_ms: u64, started_ms: Option<u64>) -> Instant {
    let age = started_ms.map_or(0, |started| arrived_ms.saturating_sub(started));
    let age = Duration::from_millis(age).min(BUDGET * 2);
    arrived.checked_sub(age).unwrap_or(arrived)
}

/// Per (home, session): in memory only, so a core restart starts every session without a turn.
static TURNS: Mutex<BTreeMap<(std::path::PathBuf, String), Turn>> = Mutex::new(BTreeMap::new());

/// [`reply`] without the history rollback, for callers that always hand the output over.
pub fn on_hook<T>(
    home: &Path,
    sessions: &[Session],
    me: &str,
    event: &str,
    arrived: Instant,
    serial: &Mutex<T>,
) -> Option<Value> {
    reply(home, sessions, me, event, arrived, serial).map(|nudge| nudge.output)
}

/// A nudge reply and what [`Nudge::unsent`] needs to take its history line back.
pub struct Nudge {
    pub output: Value,
    key: (std::path::PathBuf, String),
    card: (String, u64),
    /// board.json before the line, and its stamp after the line was written.
    before: Box<persistence::Disk>,
    saved: Option<persistence::Stamp>,
}

impl Nudge {
    /// V2.5-48: the reply could not be handed to the connection. By the write's own rule (under `serial`, only
    /// when board.json is unchanged since the line was written) board.json goes back to before the line and the
    /// nudge stays pending for the next prompt. A board write made since keeps the line, and the nudge is spent.
    pub fn unsent<T>(self, home: &Path, serial: &Mutex<T>) {
        let Ok(_serial) = serial.lock() else {
            return;
        };
        if board_stamp(home) != self.saved || self.before.save(home).is_err() {
            return;
        }
        if let Some(turn) = TURNS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.key)
            && turn.pending.is_none()
        {
            turn.pending = Some(self.card);
        }
    }
}

/// A hook event of session `me` (the token's caller). `Stop` decides a nudge for the turn that ends;
/// `UserPromptSubmit` returns the pending one as the hook output, records it in the card history, and starts
/// the next turn. Every other event, and every case without a nudge, returns `None` and writes nothing.
///
/// No board read runs under a lock: `TURNS` covers only its map, and the caller holds no registry guard.
/// `serial` is the lock every other board writer holds (the core's session registry); it is taken only for the
/// history write, which goes out only when board.json is unchanged since the read and the reply still leaves
/// within [`BUDGET`] of `arrived` ([`counted_from`]). Otherwise the nudge stays pending for the next prompt.
/// The caller hands `output` to the connection and calls [`Nudge::unsent`] when that fails.
pub fn reply<T>(
    home: &Path,
    sessions: &[Session],
    me: &str,
    event: &str,
    arrived: Instant,
    serial: &Mutex<T>,
) -> Option<Nudge> {
    let key = (home.to_path_buf(), me.to_string());
    let turns = || TURNS.lock().unwrap_or_else(|e| e.into_inner());
    match event {
        "Stop" => {
            if !enabled(home) {
                return None;
            }
            let started = turns()
                .get(&key)
                .filter(|turn| turn.pending.is_none())?
                .started?;
            let disk = load(home).ok()?;
            let card = mine(&disk, me).filter(|c| c.last_moved_at < started)?;
            // Only for the turn that ended: a prompt that arrived meanwhile started another one.
            if let Some(turn) = turns().get_mut(&key)
                && turn.started == Some(started)
                && turn.pending.is_none()
            {
                turn.pending = Some((card.id.clone(), card.last_moved_at));
            }
            None
        }
        "UserPromptSubmit" => {
            let pending = {
                let mut turns = turns();
                // Sessions that are gone keep no turn.
                turns.retain(|(h, id), _| h != home || sessions.iter().any(|s| s.id == *id));
                let turn = turns.entry(key.clone()).or_default();
                turn.started = Some(crate::queue::now_ms());
                turn.pending.take()
            };
            let (id, moved) = pending?;
            if !enabled(home) {
                return None;
            }
            match send(home, sessions, me, &id, moved, arrived, serial) {
                Sent::Line(output, before, saved) => Some(Nudge {
                    output,
                    key,
                    card: (id, moved),
                    before,
                    saved,
                }),
                Sent::Later => {
                    if let Some(turn) = turns().get_mut(&key)
                        && turn.pending.is_none()
                    {
                        turn.pending = Some((id, moved));
                    }
                    None
                }
                Sent::No => None,
            }
        }
        _ => None,
    }
}

/// The card `me` is attached to (the most recently changed, as `board self` picks it).
fn mine<'a>(disk: &'a persistence::Disk, me: &str) -> Option<&'a persistence::Manual> {
    disk.manual
        .iter()
        .filter(|c| c.attachments.iter().any(|a| a.session_id == me))
        .max_by_key(|c| c.updated_at)
}

/// `[settings] turn_end_nudge`; on without board.toml or without the key, off when the file does not parse.
fn enabled(home: &Path) -> bool {
    match persistence::read_regular(&home.join("board.toml"), 1024 * 1024) {
        Ok(None) => true,
        Ok(Some(bytes)) => std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| super::config::turn_end_nudge(text).ok())
            .unwrap_or(false),
        Err(_) => false,
    }
}

enum Sent {
    /// The output, board.json before the line, and its stamp after.
    Line(Value, Box<persistence::Disk>, Option<persistence::Stamp>),
    /// Not now (board.json changed since the read, or the reply would be late): the nudge stays pending.
    Later,
    No,
}

/// Sends the nudge decided at the last turn end when it still holds: the same card is still `me`'s and has
/// not moved since. The history line is written first; no line goes out without it.
fn send<T>(
    home: &Path,
    sessions: &[Session],
    me: &str,
    id: &str,
    moved: u64,
    arrived: Instant,
    serial: &Mutex<T>,
) -> Sent {
    let stamp = board_stamp(home);
    let Some((before, disk, line)) = prepare(home, sessions, me, id, moved) else {
        return Sent::No;
    };
    let Ok(_serial) = serial.lock() else {
        return Sent::Later;
    };
    if arrived.elapsed() > BUDGET || board_stamp(home) != stamp {
        return Sent::Later;
    }
    match disk.save(home) {
        Ok(()) => Sent::Line(
            json!({
                "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": line}
            }),
            Box::new(before),
            board_stamp(home),
        ),
        Err(_) => Sent::No,
    }
}

/// The board before and with the history line added, and the line; none when the nudge no longer holds.
fn prepare(
    home: &Path,
    sessions: &[Session],
    me: &str,
    id: &str,
    moved: u64,
) -> Option<(persistence::Disk, persistence::Disk, String)> {
    let mut disk = load(home).ok()?;
    disk.reload(home);
    if disk.config_error.is_some() {
        return None;
    }
    let card = mine(&disk, me).filter(|c| c.id == id && c.last_moved_at == moved)?;
    let columns = &disk.columns;
    let at = columns
        .iter()
        .position(|c| c.id == super::manual_column(card, columns))?;
    // Done work goes to Review (the approved design's "move it to Review"): the column claiming the review state
    // when it lies ahead, else the next one; in the last column there is nowhere to move it.
    let next = columns[at + 1..]
        .iter()
        .find(|c| c.states.contains(&super::State::Review))
        .or(columns.get(at + 1))?;
    let line = text(&card.id, &card.title, &columns[at].title, &next.id);
    let before = disk.clone();
    let actor = super::rights::actor(sessions, super::rights::Writer::Session(me));
    let stored = super::manual_mut(&mut disk, id).ok()?;
    let column = stored.column.clone();
    super::push_change(
        stored,
        &actor,
        ChangeKind::Edit,
        Some(column.clone()),
        Some((&column, HISTORY_LINE)),
    );
    Some((before, disk, line))
}

/// board.json's stamp; none when it is missing or cannot be read (then any later change is still a change).
fn board_stamp(home: &Path) -> Option<persistence::Stamp> {
    std::fs::symlink_metadata(home.join("board.json"))
        .ok()
        .map(|meta| persistence::Stamp::of(&meta))
}

/// True only for a nudge output: exactly `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
/// "additionalContext": <one line>}}`. The hook bridge prints nothing else for `UserPromptSubmit`.
pub fn is_context(output: &Value) -> bool {
    fn keys(v: &Value) -> Option<Vec<&str>> {
        let mut keys: Vec<_> = v.as_object()?.keys().map(String::as_str).collect();
        keys.sort_unstable();
        Some(keys)
    }
    let inner = &output["hookSpecificOutput"];
    keys(output).as_deref() == Some(OUTPUT_KEYS)
        && keys(inner).as_deref() == Some(CONTEXT_KEYS)
        && inner["hookEventName"] == "UserPromptSubmit"
        && inner["additionalContext"]
            .as_str()
            .is_some_and(|line| !line.chars().any(char::is_control))
}

/// `Board: #<id> "<title>" is still in "<column>". If you are done, run: nunchiro board move <id> <next>`.
/// Ids are store ids (no quotes, spaces or control characters); titles are data.
pub fn text(id: &str, title: &str, column: &str, next: &str) -> String {
    format!(
        "Board: #{id} \"{}\" is still in \"{}\". If you are done, run: nunchiro board move {id} {next}",
        quoted(title),
        quoted(column)
    )
}

/// The wake line's rule (ticket 159, `sessions::wake::one_line`, private to `sessions`): the first line,
/// control and hidden (`board::rights::hidden`) characters dropped, at most 200 chars; `"` becomes `'` and
/// `\` becomes `/`, so the quotes around it stay the only ones.
fn quoted(text: &str) -> String {
    let line = text.split(['\n', '\r']).next().unwrap_or_default();
    line.chars()
        .filter(|c| !c.is_control() && !super::rights::hidden(*c))
        .collect::<String>()
        .trim()
        .chars()
        .take(TEXT_MAX)
        .map(|c| match c {
            '"' => '\'',
            '\\' => '/',
            c => c,
        })
        .collect()
}

fn load(home: &Path) -> Result<persistence::Disk, String> {
    #[cfg(debug_assertions)]
    seam(home);
    persistence::Disk::load(home)
}

/// Test seam, debug builds only (release builds compile it out): each board read here first appends a line to
/// `<home>/nudge-loads` when that file exists, then waits while `<home>/nudge-park` exists, at most 3 s.
#[cfg(debug_assertions)]
fn seam(home: &Path) {
    use std::io::Write;
    if let Ok(mut loads) = std::fs::OpenOptions::new()
        .append(true)
        .open(home.join("nudge-loads"))
    {
        let _ = loads.write_all(b"load\n");
    }
    let until = Instant::now() + Duration::from_secs(3);
    while home.join("nudge-park").exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
}
