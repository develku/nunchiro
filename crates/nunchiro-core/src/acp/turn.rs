//! The test message of an approved ACP agent's row (Settings > Accounts): one real turn on record. It runs confined as the
//! setup check does (`probe::run`: its own process group, only the entry's allowed env names, a fresh empty folder under
//! `<home>/acp-check/`), sends `initialize`, `session/new` and one `session/prompt` with a fixed sentence, reads the
//! agent's text and waits for the prompt's `stopReason`, for at most `CAP`. Every request of the agent (a permission, a
//! file, a terminal) is refused. Only the owner's click starts it; the last result per agent is kept in `agent-turns.json`.
use super::{add, probe};
use crate::api::{Reply, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const PROMPT: &str = "Reply with the one word: ready.";
const CAP: Duration = Duration::from_secs(60);
const FILE: &str = "agent-turns.json";
/// What is kept of the answer (the window shows it in one line).
const TEXT_MAX: usize = 80;
/// What is read of the answer at most before it is cut.
const READ_MAX: usize = 4096;
const INITIALIZE: u64 = 0;
const OPEN: u64 = 1;
const ASK: u64 = 2;
/// How often a wait looks at Cancel and at the core stopping.
const TICK: Duration = Duration::from_millis(100);

/// The three flags are the scorecard's words: a prompt sent, an answer read, the turn's end seen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub sent: bool,
    pub answer_read: bool,
    pub turn_end: bool,
    /// From the start of the run to the turn's end (or to the failure).
    pub ms: u64,
    /// The answer's first `TEXT_MAX` characters, control characters removed.
    pub text: String,
    /// The agent's `--version`, as the check reads it.
    pub version: Option<String>,
    /// Why the try failed: `no_answer`, `not_signed_in`, `error` (the agent's own words in `error`), `empty`, `no_end`
    /// (it stopped before the turn ended) or `other`; none when it answered.
    pub failure: Option<String>,
    /// The failure's detail, one line.
    pub error: Option<String>,
    /// Unix seconds of the try.
    pub at: u64,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// The records file's read-modify-write.
static WRITE: Mutex<()> = Mutex::new(());

struct Running;
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// The last result of every agent tried on this home.
pub(crate) fn turns(home: &Path) -> BTreeMap<String, Turn> {
    crate::store::read_regular(&home.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// `cancel` ends the running try (it answers `Cancelled.`); otherwise one try of the approved entry `name`.
pub(crate) fn try_turn(
    home: &Path,
    name: &str,
    cancel: bool,
    stopping: Option<&AtomicBool>,
) -> Response {
    if cancel {
        CANCEL.store(true, Ordering::SeqCst);
        return Ok(Reply::Ack);
    }
    let view = add::approved(home, name)?;
    RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "a test message is running".to_string())?;
    let _running = Running;
    CANCEL.store(false, Ordering::SeqCst);
    let began = Instant::now();
    let mut turn = Turn {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
        ..Turn::default()
    };
    let cap = crate::account_signin::wait("NUNCHIRO_ACP_TRY_CAP_MS", CAP);
    let stop =
        || CANCEL.load(Ordering::SeqCst) || stopping.is_some_and(|s| s.load(Ordering::SeqCst));
    let result = run(home, &view.entry, cap, &stop, &mut turn);
    turn.ms = began.elapsed().as_millis() as u64;
    match result {
        // A cancelled try keeps the last result.
        Err(Failed("cancelled", e)) => return Err(e),
        Err(Failed(kind, e)) => {
            (turn.failure, turn.error) = (Some(kind.into()), Some(clean(&e, 200)))
        }
        Ok(()) => {}
    }
    save(home, name, &turn)?;
    Ok(Reply::AcpTurn { turn })
}

fn save(home: &Path, name: &str, turn: &Turn) -> Result<(), String> {
    let _write = WRITE.lock().map_err(|_| "test results unavailable")?;
    let mut all = turns(home);
    all.insert(name.to_string(), turn.clone());
    let bytes = serde_json::to_vec(&all).map_err(|e| e.to_string())?;
    crate::store::write_capped(&home.join(FILE), &bytes, crate::store::READ_MAX)
}

/// A failure's kind (see `Turn::failure`) and its one-line detail.
struct Failed(&'static str, String);
impl From<String> for Failed {
    fn from(e: String) -> Self {
        Self("other", e)
    }
}
fn fail<T>(kind: &'static str, e: impl Into<String>) -> Result<T, Failed> {
    Err(Failed(kind, e.into()))
}

fn run(
    home: &Path,
    entry: &super::config::Entry,
    cap: Duration,
    stop: &dyn Fn() -> bool,
    turn: &mut Turn,
) -> Result<(), Failed> {
    let path =
        super::found(&entry.command).ok_or_else(|| format!("{} was not found.", entry.command))?;
    let folder = probe::folder(home)?;
    turn.version = probe::version(&path, entry, &folder.0);
    let began = Instant::now();
    let mut agent = probe::run(entry, &path, &folder)?;
    // A core that dies mid-try leaves no agent behind: the next start kills the recorded group.
    let record = crate::account_signin::record(home, agent.pid());
    let result = converse(&mut agent, &folder, began, cap, stop, turn);
    drop(agent);
    if let Some(record) = record {
        record.remove();
    }
    result
}

fn converse(
    agent: &mut probe::Run,
    folder: &probe::Folder,
    began: Instant,
    cap: Duration,
    stop: &dyn Fn() -> bool,
    turn: &mut Turn,
) -> Result<(), Failed> {
    // No `fs` and no `terminal`: the agent is told it may not ask for them (and is refused if it does).
    agent.send(probe::initialize(json!({})))?;
    let mut stage = "initialize";
    let mut text = String::new();
    loop {
        if stop() {
            return fail("cancelled", "Cancelled.");
        }
        let left = cap.saturating_sub(began.elapsed());
        if left.is_zero() {
            let secs = cap.as_secs();
            return if turn.sent {
                fail("no_answer", format!("No answer in {secs} seconds."))
            } else {
                fail(
                    "other",
                    format!("The agent did not answer {stage} within {secs} seconds."),
                )
            };
        }
        let message = match agent.messages.recv_timeout(left.min(TICK)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let e = format!("The agent closed its output before answering {stage}.");
                return fail(if turn.sent { "no_end" } else { "other" }, e);
            }
        };
        if let Some(method) = message["method"].as_str() {
            if let Some(id) = message.get("id").filter(|id| !id.is_null()) {
                agent.send(refusal(id, method, &message["params"]))?;
            } else if method == "session/update" {
                read_text(&message["params"]["update"], &mut text);
            }
            continue;
        }
        let error = message.get("error").filter(|e| !e.is_null());
        let said = error.map(|e| {
            e["message"]
                .as_str()
                .map_or_else(|| e.to_string(), String::from)
        });
        match (message["id"].as_u64(), stage) {
            (Some(INITIALIZE), "initialize") => {
                if let Some(e) = said {
                    return fail("other", format!("initialize: {e}"));
                }
                stage = "session/new";
                agent.send(json!({"jsonrpc":"2.0","id":OPEN,"method":"session/new",
                    "params":{"cwd":folder.0.display().to_string(),"mcpServers":[]}}))?;
            }
            (Some(OPEN), "session/new") => {
                if let Some(e) = said {
                    return if probe::auth_required(&message["error"], &e) {
                        fail("not_signed_in", clean(&e, 200))
                    } else {
                        fail(
                            "other",
                            format!("The session did not start: {}", clean(&e, 200)),
                        )
                    };
                }
                let session = message["result"]["sessionId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "session/new answered no session id.".to_string())?;
                stage = "the message";
                agent.send(json!({"jsonrpc":"2.0","id":ASK,"method":"session/prompt",
                    "params":{"sessionId":session,"prompt":[{"type":"text","text":PROMPT}]}}))?;
                turn.sent = true;
            }
            (Some(ASK), "the message") => {
                if let Some(e) = said {
                    return fail("error", clean(&e, 200));
                }
                turn.turn_end = message["result"]["stopReason"].is_string();
                if !turn.turn_end {
                    return fail("no_end", "The prompt's answer has no stop reason.");
                }
                turn.text = clean(&text, TEXT_MAX);
                turn.answer_read = !turn.text.is_empty();
                if !turn.answer_read {
                    return fail("empty", "The turn ended with no text.");
                }
                return Ok(());
            }
            _ => {}
        }
    }
}

/// The agent's text chunks, appended up to `READ_MAX`.
fn read_text(update: &Value, text: &mut String) {
    if update["sessionUpdate"] == "agent_message_chunk"
        && update["content"]["type"] == "text"
        && let Some(chunk) = update["content"]["text"].as_str()
    {
        text.extend(chunk.chars().take(READ_MAX.saturating_sub(text.len())));
    }
}

/// A permission is answered with its reject option (or `cancelled` when it has none); anything else is an error.
fn refusal(id: &Value, method: &str, params: &Value) -> Value {
    if method == "session/request_permission" {
        let options = params["options"].as_array().into_iter().flatten();
        let outcome = options
            .clone()
            .find(|o| o["kind"] == "reject_once")
            .or_else(|| options.clone().find(|o| o["kind"] == "reject_always"))
            .and_then(|o| o["optionId"].as_str())
            .map_or_else(
                || json!({"outcome":"cancelled"}),
                |option| json!({"outcome":"selected","optionId":option}),
            );
        return json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}});
    }
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"refused: this is a test message"}})
}

/// Control characters removed, spaces trimmed, at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    let kept: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    kept.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_drops_control_characters_and_cuts() {
        assert_eq!(clean(" ready\u{7}\n", 80), "ready");
        assert_eq!(clean("a\u{1b}[31mb", 80), "a [31mb");
        assert_eq!(clean(&"x".repeat(100), 80).len(), 80);
    }

    #[test]
    fn refusal_picks_the_reject_option() {
        let params = json!({"options":[{"optionId":"y","kind":"allow_once"},{"optionId":"n","kind":"reject_once"}]});
        let answer = refusal(&json!("a-1"), "session/request_permission", &params);
        assert_eq!(answer["result"]["outcome"]["optionId"], "n");
        let none = refusal(
            &json!(3),
            "session/request_permission",
            &json!({"options":[]}),
        );
        assert_eq!(none["result"]["outcome"]["outcome"], "cancelled");
        assert!(refusal(&json!(4), "fs/read_text_file", &json!({}))["error"].is_object());
    }
}
