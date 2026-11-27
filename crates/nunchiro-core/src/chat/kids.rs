//! V2-CF4: a session's sub-agents as a read-only projection of what the agent's own transcript already says.
//! No new protocol and no new store: only the three sources the ticket proved (a Claude `Task`/`Agent` call, a Codex
//! spawn call, and an ACP `subagent_update`). A kind that reports no child identity shows nothing, never a zero.
use crate::api::{AgentKind, Session};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

/// What the tree says under the session row: `↳ N` is `kids.len()` (working and done both count, as the mockup).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kids {
    pub kids: Vec<Kid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Kid {
    /// The launch call's id: one launch, one child, however many records replay it.
    pub id: String,
    /// "Explore: find ssh -G callers".
    pub label: String,
    pub state: KidState,
    /// The launch record's own `timestamp` as epoch seconds: the one time the transcript states. Absent when the record
    /// carries none (a kind or version that dates nothing), which is why it is not a `Working` fact by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum KidState {
    /// The agent said it is working: an ACP `subagent_update` running or requires_action.
    Working,
    Done,
    Failed,
    /// Launched, but the evidence never said how it ended. One with a `started_at` is read as running by the tree;
    /// one without stays unknown and is shown as nothing.
    Unknown,
}

const LAUNCHES: [&str; 3] = ["Task", "Agent", "spawn_agent"];
const RECORD_MAX: usize = 1 << 20;
/// The bound on one read: the transcript's last 256 KiB, as CHAT-USAGE reads usage (session_context.rs).
pub const TAIL: u64 = 256 << 10;

/// Codex stores a launch `message` encrypted (`gAAAA…`, one word): that is not text to show.
fn ciphertext(s: &str) -> bool {
    s.starts_with("gAAAA") && !s.contains(char::is_whitespace)
}

/// The label a child shows: its description, else the first line of its prompt, else the agent's own title. A Codex
/// launch whose message is encrypted or empty falls back to its `task_name` (`/root/spec_r2` shows as `spec_r2`).
fn label(v: &Value) -> String {
    let first = |s: &str| s.lines().next().unwrap_or_default().trim().to_string();
    ["description", "prompt", "message", "title", "name"]
        .iter()
        .filter_map(|k| v[*k].as_str())
        .filter(|s| !ciphertext(s.trim()))
        .map(first)
        .find(|s| !s.is_empty())
        .or_else(|| {
            let task = v["task_name"].as_str()?.rsplit('/').next()?.trim();
            (!task.is_empty()).then(|| task.to_string())
        })
        .unwrap_or_else(|| "Sub-agent".into())
}

fn label_of(input: &Value) -> String {
    if let Some(s) = input.as_str()
        && let Ok(v) = serde_json::from_str::<Value>(s)
    {
        return label(&v);
    }
    label(input)
}

fn text_of(output: &Value) -> &str {
    output
        .as_str()
        .or_else(|| output["content"].as_str())
        .or_else(|| output["text"].as_str())
        .or_else(|| output["message"].as_str())
        .unwrap_or_default()
}

/// A launch result that itself reports a failure ("Child failed: ...", "Error: ...").
fn failed_result(output: &Value) -> bool {
    let t = text_of(output).trim_start();
    ["child failed", "error", "failed", "interrupted"]
        .iter()
        .any(|w| t.get(..w.len()).is_some_and(|h| h.eq_ignore_ascii_case(w)))
}

/// Claude: a sidechain's `end_turn` names the launch (`parentToolUseID`) that owned it.
fn claude_sidechain(record: &Value, kids: &mut [Kid]) {
    if record["isSidechain"] != true
        || record["type"] != "assistant"
        || !matches!(
            record["message"]["stop_reason"].as_str(),
            Some("end_turn" | "refusal")
        )
    {
        return;
    }
    let Some(kid) = record["parentToolUseID"]
        .as_str()
        .and_then(|id| kids.iter_mut().find(|k| k.id == id))
    else {
        return;
    };
    kid.state = if record["message"]["stop_reason"] == "refusal" {
        KidState::Failed
    } else {
        KidState::Done
    };
}

/// The record's own `timestamp` as epoch seconds, when it carries one.
fn started_at(record: &Value) -> Option<i64> {
    crate::usage::epoch(record["timestamp"].as_str()?)
}

/// Folds one transcript record into `kids`, in the order the record came. Idempotent per launch id, so a replayed or
/// duplicated record never doubles a child or moves a finished one back to working.
pub fn fold(kind: AgentKind, record: &Value, kids: &mut Kids) {
    match kind {
        AgentKind::Claude => {
            claude_sidechain(record, &mut kids.kids);
            for block in record["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
            {
                match block["type"].as_str() {
                    Some("tool_use")
                        if LAUNCHES.contains(&block["name"].as_str().unwrap_or("")) =>
                    {
                        if let Some(id) = block["id"].as_str()
                            && !kids.kids.iter().any(|k| k.id == id)
                        {
                            kids.kids.push(Kid {
                                id: id.into(),
                                label: label_of(&block["input"]),
                                // A launch's return is not its work: nothing says it is done yet.
                                state: KidState::Unknown,
                                started_at: started_at(record),
                            });
                        }
                    }
                    Some("tool_result") => {
                        let Some(kid) = block["tool_use_id"]
                            .as_str()
                            .and_then(|id| kids.kids.iter_mut().find(|k| k.id == id))
                        else {
                            continue;
                        };
                        if block["is_error"] == true || failed_result(&block["content"]) {
                            kid.state = KidState::Failed;
                        }
                    }
                    _ => {}
                }
            }
        }
        AgentKind::Codex => {
            let p = &record["payload"];
            if record["type"] != "response_item" {
                return;
            }
            match p["type"].as_str() {
                Some("function_call" | "custom_tool_call")
                    if LAUNCHES.contains(&p["name"].as_str().unwrap_or("")) =>
                {
                    if let Some(id) = p["call_id"].as_str()
                        && !kids.kids.iter().any(|k| k.id == id)
                    {
                        let input = p["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .or_else(|| p.get("input").cloned())
                            .unwrap_or(Value::Null);
                        kids.kids.push(Kid {
                            id: id.into(),
                            label: label_of(&input),
                            state: KidState::Unknown,
                            started_at: started_at(record),
                        });
                    }
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    if let Some(id) = p["call_id"].as_str()
                        && let Some(kid) = kids.kids.iter_mut().find(|k| k.id == id)
                        && failed_result(&p["output"])
                    {
                        kid.state = KidState::Failed;
                    }
                }
                _ => {}
            }
        }
        // V2-4a: the ACP path reports children in `subagent_update` (acp/mod.rs), not in a transcript.
        AgentKind::Acp | AgentKind::Shell => {}
    }
}

/// The same fold for an ACP `session/update` (`subagent_update` from the subagents RFD: the body's own `sessionId` is
/// the child, `state.state` its work state). Kept here so both paths read the same `Kids`. The update carries no time of
/// its own, so an ACP child has no `started_at`: its age is never shown, only the state the agent reported.
pub fn fold_acp(update: &Value, kids: &mut Kids) {
    if update["sessionUpdate"] != "subagent_update" {
        return;
    }
    let Some(id) = update["sessionId"].as_str() else {
        return;
    };
    if !kids.kids.iter().any(|k| k.id == id) {
        kids.kids.push(Kid {
            id: id.into(),
            label: label(update),
            state: KidState::Unknown,
            started_at: None,
        });
    }
    let Some(kid) = kids.kids.iter_mut().find(|k| k.id == id) else {
        return;
    };
    match update["state"]["state"].as_str() {
        Some("running") | Some("requires_action") => kid.state = KidState::Working,
        Some("idle") => {
            kid.state = if update["state"]["stopReason"] == "error" {
                KidState::Failed
            } else {
                KidState::Done
            }
        }
        _ => {} // unknown: the agent has not said
    }
}

/// Calls `each` for every complete JSON record in the last `TAIL` bytes of `path` and returns whether the read began
/// mid-file (the cut first line is not a record). A record over `RECORD_MAX` is skipped, never parsed.
fn tail_records(path: &Path, mut each: impl FnMut(Value)) -> std::io::Result<bool> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut first = start > 0; // a tail starts mid-record: the cut first line is not a record
    while reader.read_until(b'\n', &mut line)? > 0 {
        if std::mem::replace(&mut first, false) {
            line.clear();
            continue;
        }
        if line.len() <= RECORD_MAX
            && let Ok(record) = serde_json::from_slice::<Value>(&line)
        {
            each(record);
        }
        line.clear();
    }
    Ok(start > 0)
}

/// Folds the last `TAIL` bytes of the session's transcript and nothing before it (as CHAT-USAGE reads the usage tail).
/// `Err` only when the file is there but unreadable: a session with no transcript has no children, which is not an error.
///
/// shortcut: only the last 256 KiB is read, so a child launched before that window (a long transcript on a core that
/// restarted, or hours of output) is not listed, and its end is not seen; keep a per-session incremental offset if
/// children must survive the whole transcript.
pub fn of(meta: &Session, path: Option<&Path>) -> Result<Kids, String> {
    let mut kids = Kids::default();
    if matches!(meta.kind, AgentKind::Shell | AgentKind::Acp) {
        return Ok(kids);
    }
    let Some(path) = path else {
        return Ok(kids);
    };
    match tail_records(path, |record| fold(meta.kind, &record, &mut kids)) {
        Ok(_) => Ok(kids),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(kids),
        Err(e) => Err(e.to_string()),
    }
}

// ---- needs 169: opening one sub-agent's own output (window only, read only) -------------------------------------------

/// Where an opened sub-agent's rows come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "KidsSource"))]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The child's own transcript file.
    Child,
    /// No child file (ACP, older agent, not written yet): the parent's chat, at the launch call.
    Parent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Opened {
    pub source: Source,
    /// The child's newest events (at most `EVENTS_MAX`); empty for `Parent`. Each event's `cursor` is its 0-based index
    /// in this reply, NOT a cursor of the parent's chat: never pass it to `jumpTo` or `chat_page`.
    pub events: Vec<super::Event>,
    /// The tail cut or the event cap dropped older records.
    pub truncated: bool,
    /// `Parent` only: the cursor of the launch call in the parent's chat, when the chat's newest pages hold it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

pub const EVENTS_MAX: usize = 400;
const META_FILES_MAX: usize = 200;
const ROLLOUTS_MAX: usize = 4000;
const FIRST_LINE_MAX: u64 = 64 << 10;
/// `rollout-2026-10-27T08-15-15`: the start time Codex puts first in a rollout's file name (it sorts by time).
const STAMP: usize = 27;

/// A launch id the window may ask for: Claude `toolu_…` and Codex `call_…` ids are `[A-Za-z0-9_-]`.
pub fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
thread_local! {
    /// Every rollout `first_line` was asked to open, for the scan-start test.
    static OPENED: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A regular file that is not a symlink (a link could point anywhere).
fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

fn plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir())
}

/// The first line of `path`, at most `FIRST_LINE_MAX` bytes; `None` for a longer line or an unreadable file.
fn first_line(path: &Path) -> Option<Value> {
    #[cfg(test)]
    OPENED.with(|o| o.borrow_mut().push(path.to_path_buf()));
    if !plain_file(path) {
        return None;
    }
    let mut text = Vec::new();
    BufReader::new(fs::File::open(path).ok()?.take(FIRST_LINE_MAX))
        .read_until(b'\n', &mut text)
        .ok()?;
    if text.last() != Some(&b'\n') && text.len() as u64 >= FIRST_LINE_MAX {
        return None;
    }
    serde_json::from_slice(&text).ok()
}

/// The child's own transcript for launch `kid`, built only from the parent transcript path the registry trusts.
/// `Ok(None)`: this agent kind or version keeps no such file, or it is not there (yet).
///
/// shortcut: a Claude session with more than `META_FILES_MAX` sub-agents, or a Codex home with more than
/// `ROLLOUTS_MAX` later rollouts, can miss the child; the window then falls back to the parent's launch call.
pub fn child_transcript(
    meta: &Session,
    parent: &Path,
    kid: &str,
) -> Result<Option<PathBuf>, String> {
    if !valid_id(kid) {
        return Err("invalid sub-agent id".into());
    }
    Ok(match meta.kind {
        AgentKind::Claude => claude_child(parent, kid),
        AgentKind::Codex => codex_child(parent, kid),
        AgentKind::Acp | AgentKind::Shell => None,
    })
}

/// `<…>/<session-id>/subagents/agent-<agentId>.jsonl`, found by the `toolUseId` in its `.meta.json` beside it.
fn claude_child(parent: &Path, kid: &str) -> Option<PathBuf> {
    let home = parent.parent()?;
    let dir = home.join(parent.file_stem()?).join("subagents");
    if !plain_dir(&dir) {
        return None;
    }
    let (dir, home) = (dir.canonicalize().ok()?, home.canonicalize().ok()?);
    if !dir.starts_with(&home) {
        return None;
    }
    let mut seen = 0;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let name = entry.file_name();
        let Some(agent) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".meta.json"))
            .filter(|a| a.starts_with("agent-") && valid_id(a))
        else {
            continue;
        };
        seen += 1;
        if seen > META_FILES_MAX {
            return None;
        }
        if small_json(&entry.path()).is_some_and(|m| m["toolUseId"] == kid) {
            let child = dir.join(format!("{agent}.jsonl"));
            let real = child.canonicalize().ok()?;
            return (plain_file(&child) && real.starts_with(&dir)).then_some(real);
        }
    }
    None
}

/// A whole small JSON file (the meta file is one line of JSON), bounded like a first line.
fn small_json(path: &Path) -> Option<Value> {
    if !plain_file(path) {
        return None;
    }
    let mut text = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(FIRST_LINE_MAX)
        .read_to_end(&mut text)
        .ok()?;
    serde_json::from_slice(&text).ok()
}

/// The parent's `spawn_agent` output for `kid` names the child (`{"task_name":"/root/spec"}`); the child's rollout
/// says it was spawned by this parent thread under that `agent_path`.
fn codex_child(parent: &Path, kid: &str) -> Option<PathBuf> {
    let name = parent.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    let thread = stem.get(stem.len().checked_sub(36)?..)?;
    if !thread.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return None;
    }
    let mut task = None;
    let _ = tail_records(parent, |r| {
        let p = &r["payload"];
        if r["type"] == "response_item"
            && p["type"] == "function_call_output"
            && p["call_id"] == kid
        {
            let out = p["output"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| p["output"].clone());
            task = out["task_name"].as_str().map(str::to_string);
        }
    });
    let task = task?;
    let day = parent.parent()?;
    let root = day
        .ancestors()
        .find(|a| a.file_name().is_some_and(|n| n == "sessions"))?;
    let root = root.canonicalize().ok()?;
    // The rollouts of the parent's day and later (a child never predates its parent), oldest first.
    let sorted = |dir: &Path| {
        let mut v: Vec<_> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| plain_dir(&e.path()))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        v.sort();
        v
    };
    let (pd, pm, py) = (
        day.file_name()?.to_str()?,
        day.parent()?.file_name()?.to_str()?,
        day.parent()?.parent()?.file_name()?.to_str()?,
    );
    let started = name.get(..STAMP);
    let mut files = 0;
    for y in sorted(&root).into_iter().filter(|y| y.as_str() >= py) {
        for m in sorted(&root.join(&y))
            .into_iter()
            .filter(|m| y.as_str() > py || m.as_str() >= pm)
        {
            for d in sorted(&root.join(&y).join(&m))
                .into_iter()
                .filter(|d| (y.as_str(), m.as_str()) > (py, pm) || d.as_str() >= pd)
            {
                let dir = root.join(&y).join(&m).join(&d);
                // A child never predates its parent: on the parent's own day, only rollouts started at or after the parent's
                // start time (the `rollout-YYYY-MM-DDTHH-MM-SS` stamp of its file name) are opened.
                let same_day = (y.as_str(), m.as_str(), d.as_str()) == (py, pm, pd);
                let mut names: Vec<_> = fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                    .filter(|n| !same_day || n.get(..STAMP) >= started)
                    .collect();
                names.sort();
                for n in names {
                    files += 1;
                    if files > ROLLOUTS_MAX {
                        return None;
                    }
                    let path = dir.join(&n);
                    let spawn = first_line(&path)
                        .map(|f| f["payload"]["source"]["subagent"]["thread_spawn"].clone());
                    if spawn.is_some_and(|s| {
                        s["parent_thread_id"] == thread && s["agent_path"] == task.as_str()
                    }) {
                        let real = path.canonicalize().ok()?;
                        return real.starts_with(&root).then_some(real);
                    }
                }
            }
        }
    }
    None
}

/// The child's newest events, from the last `TAIL` bytes of its own transcript (Claude's `isSidechain` flag is cleared
/// on a copy so its messages and tools project as the chat's own). Read only.
pub fn read_child(kind: AgentKind, file: &Path) -> Result<(Vec<super::Event>, bool), String> {
    let mut data: Vec<Value> = vec![];
    let cut = tail_records(file, |mut record| {
        if kind == AgentKind::Claude
            && let Some(o) = record.as_object_mut()
        {
            o.insert("isSidechain".into(), false.into());
        }
        data.extend(super::project(kind, &record));
    })
    .map_err(|e| e.to_string())?;
    let capped = data.len() > EVENTS_MAX;
    let events = data
        .split_off(data.len().saturating_sub(EVENTS_MAX))
        .into_iter()
        .enumerate()
        .map(|(i, data)| super::Event {
            schema_version: 1,
            cursor: i as u64,
            data,
        })
        .collect();
    Ok((events, cut || capped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn run(kind: AgentKind, records: &[Value]) -> Kids {
        let mut kids = Kids::default();
        for r in records {
            fold(kind, r, &mut kids);
        }
        kids
    }

    fn task(id: &str, name: &str) -> Value {
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,
            "input":{"description":"Explore: find ssh -G callers","prompt":"look"}}]}})
    }

    /// subagent_count_all_reported_kinds: each kind's launch makes one child, with its own label.
    #[test]
    fn subagent_count_all_reported_kinds() {
        let claude = run(
            AgentKind::Claude,
            &[task("t1", "Task"), task("t2", "Agent")],
        );
        assert_eq!(claude.kids.len(), 2);
        assert!(
            claude
                .kids
                .iter()
                .all(|k| k.label == "Explore: find ssh -G callers")
        );
        let codex = run(
            AgentKind::Codex,
            &[
                json!({"type":"response_item","payload":{"type":"function_call","call_id":"c1",
                "name":"spawn_agent","arguments":"{\"message\":\"Check the result\"}"}}),
            ],
        );
        assert_eq!(codex.kids.len(), 1);
        assert_eq!(codex.kids[0].label, "Check the result");
        let mut acp = Kids::default();
        fold_acp(
            &json!({"sessionUpdate":"subagent_update","sessionId":"sess_child_1","title":"Test investigator"}),
            &mut acp,
        );
        assert_eq!(acp.kids.len(), 1);
        assert_eq!(acp.kids[0].label, "Test investigator");
        // A kind with no reported child identity shows nothing.
        assert_eq!(run(AgentKind::Shell, &[task("t1", "Task")]).kids.len(), 0);
    }

    /// subagent_start_time_from_its_launch_record: the launch record's own `timestamp` is the only time the transcript
    /// states, and a record without one leaves the child dateless rather than dated to now.
    #[test]
    fn subagent_start_time_from_its_launch_record() {
        let dated = |at: Option<&str>| {
            let mut r = task("t1", "Task");
            if let Some(at) = at {
                r["timestamp"] = at.into();
            }
            r
        };
        let kids = run(
            AgentKind::Claude,
            &[dated(Some("2026-10-24T01:00:05.000Z"))],
        );
        // 2026-10-24T01:00:05Z, the same reader the usage tail uses.
        assert_eq!(kids.kids[0].started_at, Some(1_792_803_605));
        assert_eq!(
            run(AgentKind::Claude, &[dated(None)]).kids[0].started_at,
            None
        );
        assert_eq!(
            run(AgentKind::Claude, &[dated(Some("yesterday"))]).kids[0].started_at,
            None
        );
        // Codex dates its records the same way; an ACP update carries no time at all.
        let codex = run(
            AgentKind::Codex,
            &[
                json!({"type":"response_item","timestamp":"2026-10-24T01:00:05.000Z",
                "payload":{"type":"function_call","call_id":"c1","name":"spawn_agent","arguments":"{}"}}),
            ],
        );
        assert_eq!(codex.kids[0].started_at, Some(1_792_803_605));
        let mut acp = Kids::default();
        fold_acp(
            &json!({"sessionUpdate":"subagent_update","sessionId":"c1","state":{"state":"running"}}),
            &mut acp,
        );
        assert_eq!(acp.kids[0].started_at, None);
        assert_eq!(acp.kids[0].state, KidState::Working);
    }

    /// codex_child_label_from_task_name: an encrypted or empty launch message shows the task name; real text wins.
    #[test]
    fn codex_child_label_from_task_name() {
        let call =
            |args: &str| {
                run(
                AgentKind::Codex,
                &[json!({"type":"response_item","payload":{"type":"function_call","call_id":"c1",
                "name":"spawn_agent","arguments":args}})],
            )
            .kids[0]
                .label
                .clone()
            };
        let secret = "gAAAAABfakefakefakefakefakefakefakefakefakefakefakefakefakefakefake0fake";
        assert_eq!(
            call(&format!(
                r#"{{"task_name":"/root/spec_r2","message":"{secret}"}}"#
            )),
            "spec_r2"
        );
        assert_eq!(call(r#"{"task_name":"spec_r2","message":""}"#), "spec_r2");
        // Text that merely starts that way, or any real message, is shown as before.
        assert_eq!(
            call(r#"{"task_name":"spec_r2","message":"gAAAA is how it starts"}"#),
            "gAAAA is how it starts"
        );
        assert_eq!(
            call(r#"{"task_name":"spec_r2","message":"Check it"}"#),
            "Check it"
        );
        assert_eq!(call(r#"{"message":""}"#), "Sub-agent");
    }

    /// codex_scan_bounded: the rollout search starts at the parent's start time, not at midnight of its day: a matching
    /// rollout from earlier the same day is never opened, and the later one is found.
    #[test]
    fn codex_scan_starts_at_the_parent_start() {
        const PARENT: &str = "01a17a48-3755-7943-8016-6371dcb1467d";
        let root = std::env::temp_dir().join(format!("kids-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let day = root.join("sessions/2026/10/27");
        fs::create_dir_all(&day).unwrap();
        let child = |id: &str| {
            json!({"type":"session_meta","payload":{"id":id,"source":{"subagent":{"thread_spawn":
                {"parent_thread_id":PARENT,"agent_path":"/root/spec"}}}}})
            .to_string()
                + "\n"
        };
        let parent = day.join(format!("rollout-2026-10-27T08-15-15-{PARENT}.jsonl"));
        let line = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1",
            "output":"{\"task_name\":\"/root/spec\"}"}});
        fs::write(&parent, format!("{line}\n")).unwrap();
        // Same date, earlier than the parent (it also claims to be the parent's child), and a later, real one.
        let older =
            day.join("rollout-2026-10-27T01-00-00-00000000-0000-4000-8000-000000000001.jsonl");
        let later =
            day.join("rollout-2026-10-27T08-16-26-00000000-0000-4000-8000-000000000002.jsonl");
        fs::write(&older, child("00000000-0000-4000-8000-000000000001")).unwrap();
        fs::write(&later, child("00000000-0000-4000-8000-000000000002")).unwrap();
        OPENED.with(|o| o.borrow_mut().clear());
        let found = codex_child(&parent, "c1").expect("the later child");
        assert_eq!(found, later.canonicalize().unwrap());
        let opened = OPENED.with(|o| o.borrow().clone());
        assert!(
            !opened.contains(&older),
            "opened a rollout older than the parent: {opened:?}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A replayed record and a duplicate update never double a child.
    #[test]
    fn replay_does_not_double_count() {
        let r = task("t1", "Task");
        assert_eq!(
            run(AgentKind::Claude, &[r.clone(), r.clone(), r.clone()])
                .kids
                .len(),
            1
        );
        let mut acp = Kids::default();
        let u = json!({"sessionUpdate":"subagent_update","sessionId":"c1","title":"Plan"});
        fold_acp(&u, &mut acp);
        fold_acp(&u, &mut acp);
        assert_eq!(acp.kids.len(), 1);
    }

    /// Launch return alone does not imply finished work; a sidechain end, or a failed result, is explicit.
    #[test]
    fn finished_failed_unknown_are_explicit() {
        let launched = run(
            AgentKind::Claude,
            &[
                task("t1", "Task"),
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
            ],
        );
        assert_eq!(launched.kids[0].state, KidState::Unknown);
        let failed = run(
            AgentKind::Claude,
            &[
                task("t1", "Task"),
                json!({"type":"user","message":{"content":[
                    {"type":"tool_result","tool_use_id":"t1","content":"Child failed: boom"}]}}),
            ],
        );
        assert_eq!(failed.kids[0].state, KidState::Failed);
        let ended = run(
            AgentKind::Claude,
            &[
                task("t1", "Task"),
                json!({"type":"assistant","isSidechain":true,"parentToolUseID":"t1",
                "message":{"stop_reason":"end_turn","content":[]}}),
            ],
        );
        assert_eq!(ended.kids[0].state, KidState::Done);
        let mut acp = Kids::default();
        fold_acp(
            &json!({"sessionUpdate":"subagent_update","sessionId":"c1","state":{"state":"running"}}),
            &mut acp,
        );
        assert_eq!(acp.kids[0].state, KidState::Working);
        fold_acp(
            &json!({"sessionUpdate":"subagent_update","sessionId":"c1","state":{"state":"idle","stopReason":"error"}}),
            &mut acp,
        );
        assert_eq!(acp.kids[0].state, KidState::Failed);
    }

    fn meta(kind: AgentKind) -> Session {
        serde_json::from_value(json!({
            "id": "s1", "kind": kind, "project": "/p", "cwd": "/p", "label": "one", "state": "running",
            "agent_session_id": null, "agent_version": null, "untested": false, "pid": null,
            "attention": {"completion_seq": 0, "working": false, "waiting": false, "stale": false,
            "failed": false, "last_activity": 0, "background": 0}, "pending": []
        }))
        .expect("session meta")
    }

    fn write(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("kids-{}-{name}", std::process::id()));
        fs::write(&path, bytes).expect("fixture");
        path
    }

    /// `of` reads at most the last 256 KiB: a child launched before that window is out of the read, and the cut
    /// first line never folds as a record.
    #[test]
    fn of_reads_only_the_tail() {
        let record = |id: &str| serde_json::to_string(&task(id, "Task")).unwrap();
        let filler = format!("{}\n", "x".repeat(2048));
        let mut body = record("old");
        body.push('\n');
        let mut bytes = body.into_bytes();
        while (bytes.len() as u64) < TAIL + 4096 {
            bytes.extend_from_slice(filler.as_bytes());
        }
        bytes.extend_from_slice(format!("{}\n{}\n", record("new"), record("new2")).as_bytes());
        let path = write("tail.jsonl", &bytes);
        let kids = of(&meta(AgentKind::Claude), Some(&path)).expect("read");
        let _ = fs::remove_file(&path);
        assert_eq!(
            kids.kids.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
            ["new", "new2"]
        );
    }

    /// A short transcript is read whole, from its first record.
    #[test]
    fn of_reads_a_short_transcript_whole() {
        let path = write(
            "short.jsonl",
            format!("{}\n", serde_json::to_string(&task("t1", "Task")).unwrap()).as_bytes(),
        );
        let kids = of(&meta(AgentKind::Claude), Some(&path)).expect("read");
        let _ = fs::remove_file(&path);
        assert_eq!(kids.kids.len(), 1);
        assert_eq!(kids.kids[0].label, "Explore: find ssh -G callers");
    }

    /// Another session's launch never joins this one: the fold sees only its own transcript.
    #[test]
    fn only_this_transcripts_children() {
        let mine = run(AgentKind::Claude, &[task("t1", "Task")]);
        let theirs = run(AgentKind::Claude, &[task("t2", "Task")]);
        assert_eq!(mine.kids[0].id, "t1");
        assert_eq!(theirs.kids[0].id, "t2");
    }
}
