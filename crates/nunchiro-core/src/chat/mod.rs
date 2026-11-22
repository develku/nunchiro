// Claude content/structuredPatch schema port: claude-code-viewer, commit 9367cf0.
// MIT License
//
// Copyright (c) 2025 Claude Code Viewer
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//! Version 1 chat projection; agent transcripts are always read-only.
use crate::api::AgentKind;
use serde_json::{Value, json};

fn hidden(text: &str) -> bool {
    [
        "<system-reminder>",
        "<bash-input>",
        "<local-command-",
        "<task-notification>",
    ]
    .iter()
    .any(|marker| text.trim_start().starts_with(marker))
}

/// Blocks Codex wraps whole in one tag (the lists T3 Code's and Orca's rollout readers drop; own code).
const CODEX_BLOCKS: [&str; 8] = [
    "environment_context",
    "user_instructions",
    "INSTRUCTIONS",
    "recommended_plugins",
    "in-app-browser-context",
    "codex_internal_context",
    "goal_context",
    "current_datetime",
];
/// Ticket 383: the labels of blocks Codex adds itself; any other label is judged by the block's shape.
const CODEX_INJECTED_LABELS: [&str; 2] = ["agents_md.", "environments."];
/// Ticket 383: shown for a turn that finished with no last message and no error message of its own.
const CODEX_NO_REPLY: &str =
    "Codex ended this turn without a reply. Open the terminal for details.";

/// Ticket 383: block `index` of a Codex `user` record is text Codex added (AGENTS.md, environment context), not the
/// person's words. 0.162 labels each block; a record without labels is judged by the whole block's shape, so text that
/// only mentions a marker stays visible.
fn codex_injected(payload: &Value, index: usize, text: &str) -> bool {
    match payload["internal_chat_message_metadata_passthrough"]["content_item_kinds"][index]
        .as_str()
    {
        Some(kind) if kind.starts_with("user.") => false,
        Some(kind) if CODEX_INJECTED_LABELS.iter().any(|l| kind.starts_with(l)) => true,
        _ => {
            let t = text.trim();
            (t.starts_with("# AGENTS.md instructions for ")
                && t.contains("\n\n<INSTRUCTIONS>")
                && t.ends_with("</INSTRUCTIONS>"))
                || CODEX_BLOCKS.iter().any(|name| {
                    t.strip_prefix('<')
                        .and_then(|rest| rest.strip_prefix(name))
                        .is_some_and(|rest| rest.starts_with(['>', ' ']))
                        && t.ends_with(&format!("</{name}>"))
                })
        }
    }
}

/// Ticket 378: `text` past the context blocks Codex puts before the person's words in the same block (T3's title preamble).
pub(crate) fn after_codex_context(text: &str) -> &str {
    let mut t = text.trim_start();
    loop {
        let close = if t.starts_with("# AGENTS.md instructions for ") {
            Some("</INSTRUCTIONS>".to_string())
        } else {
            CODEX_BLOCKS.iter().find_map(|name| {
                let rest = t.strip_prefix('<')?.strip_prefix(name)?;
                rest.starts_with(['>', ' ']).then(|| format!("</{name}>"))
            })
        };
        match close.and_then(|c| t.find(&c).map(|i| i + c.len())) {
            Some(end) => t = t[end..].trim_start(),
            None => return t,
        }
    }
}

pub fn project(kind: AgentKind, record: &Value) -> Vec<Value> {
    project_record(kind, record)
        .into_iter()
        .map(|mut event| {
            if valid_data(&event) {
                // v2-8b: the PR badge ages from the result's own record time; absent on old stored events.
                if event["kind"] == "tool_result"
                    && let Some(at) = record["timestamp"].as_str()
                {
                    event["at"] = at.into();
                }
                event
            } else {
                json!({"kind":"skipped","count":1})
            }
        })
        .collect()
}

fn project_record(kind: AgentKind, record: &Value) -> Vec<Value> {
    // Ticket 409: a line that parses but is no record (a bare string, number, list) could not be read.
    if !record.is_object() {
        return vec![json!({"kind":"skipped","count":1})];
    }
    let mut out = vec![];
    // Look 11-17 N12: Claude's own filler after a resume of an interrupted turn, no answer from the model.
    if kind == AgentKind::Claude
        && record["type"] == "assistant"
        && record["message"]["model"] == "<synthetic>"
        && record["message"]["content"]
            .as_array()
            .is_some_and(|b| b.iter().all(|b| b["text"] == "No response requested."))
    {
        return out;
    }
    if kind == AgentKind::Claude && record["isSidechain"] == true {
        if record["type"] == "assistant"
            && record["message"]["stop_reason"] == "end_turn"
            && record["parentToolUseID"].is_string()
            && let Some(blocks) = record["message"]["content"].as_array()
        {
            let text = blocks
                .iter()
                .filter_map(|b| b.as_str().or_else(|| b["text"].as_str()))
                .filter(|t| !hidden(t))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                out.push(
                    json!({"kind":"task_result","tool_id":record["parentToolUseID"],"text":text}),
                );
            }
        }
        return out;
    }
    // Ticket 222: Claude closes each turn with a turn_duration record; the turn event carries that turn's files.
    if kind == AgentKind::Claude
        && record["type"] == "system"
        && record["subtype"] == "turn_duration"
    {
        return vec![json!({"kind":"turn","turn_id":record["uuid"],"state":"completed"})];
    }
    if kind == AgentKind::Claude && record["type"] == "user" {
        let content = &record["message"]["content"];
        let text = content
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                content.as_array().map(|a| {
                    a.iter()
                        .filter_map(|b| b.as_str().or_else(|| b["text"].as_str()))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            })
            .unwrap_or_default();
        // Q9 pop-J15-1: no whole-record drop on a hidden first block; the loops below hide each hidden block alone.
        if text.starts_with("[Request interrupted by user") {
            return vec![json!({"kind":"turn","turn_id":record["uuid"],"state":"interrupted"})];
        }
    }
    // Look 1117 v10 N10-S2-4: what the user sent while Claude worked reaches it mid-turn as a `queued_command`
    // attachment, never as a user record; it is the user's message all the same (a peer's or a continuation is not).
    if kind == AgentKind::Claude
        && record["type"] == "attachment"
        && record["attachment"]["type"] == "queued_command"
        && record["attachment"]["commandMode"] == "prompt"
        && record["attachment"]["origin"]["kind"] == "human"
    {
        let prompt = &record["attachment"]["prompt"];
        return project_record(
            kind,
            &json!({"type":"user","uuid":record["uuid"],"message":{"role":"user","content":prompt}}),
        );
    }
    // Ticket 409: Claude adds bookkeeping record types often (attachment, api-request, ai-title, mode, ...). One that
    // carries no message is not part of the conversation and is not counted; `api-request-blob` copies sent messages.
    if kind == AgentKind::Claude
        && !matches!(
            record["type"].as_str(),
            Some(
                "user"
                    | "assistant"
                    | "system"
                    | "progress"
                    | "file-history-snapshot"
                    | "queue-operation"
                    | "summary"
            )
        )
    {
        return if record.get("message").is_none() || record["type"] == "api-request-blob" {
            vec![]
        } else {
            vec![json!({"kind":"skipped","count":1})]
        };
    }
    if kind == AgentKind::Claude
        && matches!(record["type"].as_str(), Some("user" | "assistant"))
        && let Some(text) = record["message"]["content"].as_str()
        && !hidden(text)
    {
        out.push(json!({"kind":"message", "role":record["type"], "text":text}));
    }
    if kind == AgentKind::Claude
        && let Some(blocks) = record["message"]["content"].as_array()
    {
        for block in blocks {
            if let Some(text) = block.as_str() {
                if !hidden(text) {
                    out.push(json!({"kind":"message","role":record["type"],"text":text}));
                }
                continue;
            }
            if block["type"] == "text"
                && let Some(text) = block["text"].as_str()
                && !hidden(text)
            {
                out.push(json!({"kind":"message","role":record["type"],"text":text}));
            }
            if block["type"] == "thinking"
                && let Some(text) = block["thinking"].as_str()
            {
                out.push(json!({"kind":"thinking","text":text}));
            }
            if block["type"] == "tool_use" {
                out.push(json!({"kind":"tool_use","tool_id":block["id"],"name":block["name"],"input":block["input"]}));
            }
            if block["type"] == "tool_result" {
                out.push(json!({"kind":"tool_result","tool_id":block["tool_use_id"],"output":block["content"],"is_error":block["is_error"].as_bool().unwrap_or(false)}));
            }
            if block["type"] == "image" {
                out.push(json!({"kind":"image", "role":record["type"], "source":block["source"]}));
            }
            if !matches!(
                block["type"].as_str(),
                Some(
                    "text"
                        | "thinking"
                        | "redacted_thinking"
                        | "tool_use"
                        | "tool_result"
                        | "image"
                )
            ) {
                out.push(json!({"kind":"skipped","count":1}));
            }
        }
    }
    if kind == AgentKind::Claude
        && let Some(hunks) = record["toolUseResult"]["structuredPatch"].as_array()
    {
        let lines: Vec<&str> = hunks
            .iter()
            .filter_map(|h| h["lines"].as_array())
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let tool_id = record["message"]["content"]
            .as_array()
            .and_then(|blocks| blocks.iter().find(|b| b["type"] == "tool_result"))
            .map(|b| b["tool_use_id"].clone())
            .unwrap_or(Value::Null);
        out.push(json!({"kind":"edit","tool_id":tool_id,"path":record["toolUseResult"]["filePath"],"added":lines.iter().filter(|l| l.starts_with('+')).count(),"removed":lines.iter().filter(|l| l.starts_with('-')).count(),"hunks":hunks}));
    }
    if kind == AgentKind::Codex
        && record["type"] == "response_item"
        && record["payload"]["type"] == "message"
        // Ticket 383: Codex's own setup text (sandbox, skills), never part of the conversation.
        && record["payload"]["role"] != "developer"
    {
        let p = &record["payload"];
        if let Some(blocks) = p["content"].as_array() {
            for (index, block) in blocks.iter().enumerate() {
                match block["type"].as_str() {
                    Some("input_text" | "output_text") => if let Some(text) = block["text"].as_str() && !hidden(text) && !(p["role"] == "user" && codex_injected(p, index, text)) { out.push(json!({"kind":"message","role":p["role"],"text":text})); },
                    Some("local_image") => out.push(json!({"kind":"image","role":p["role"],"source":{"type":"path","path":block["path"]}})),
                    Some("input_image") => out.push(json!({"kind":"image","role":p["role"],"source":{"type":"url","url":block["image_url"]}})),
                    _ => out.push(json!({"kind":"skipped","count":1})),
                }
            }
        }
    }
    if kind == AgentKind::Codex
        && record["type"] == "response_item"
        && record["payload"]["type"] == "reasoning"
    {
        let text = record["payload"]["summary"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|b| b.as_str().or_else(|| b["text"].as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        out.push(json!({"kind":"thinking","text":text}));
    }
    if kind == AgentKind::Codex && record["type"] == "response_item" {
        let p = &record["payload"];
        if matches!(
            p["type"].as_str(),
            Some("function_call" | "custom_tool_call")
        ) {
            let input = p["arguments"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| {
                    p.get("input")
                        .cloned()
                        .unwrap_or_else(|| p["arguments"].clone())
                });
            out.push(
                json!({"kind":"tool_use","tool_id":p["call_id"],"name":p["name"],"input":input}),
            );
            if p["name"] == "apply_patch" {
                let patch = input
                    .as_str()
                    .or_else(|| input["patch"].as_str())
                    .or_else(|| input["input"].as_str())
                    .unwrap_or_default();
                patch_edits(patch, &p["call_id"], &mut out);
            } else if p["name"] == "exec" {
                // v1b-37: Codex 0.161 applies patches through `tools.apply_patch(` inside the exec script.
                for patch in artifacts::exec_patches(input.as_str().unwrap_or_default()) {
                    patch_edits(&patch, &p["call_id"], &mut out);
                }
            }
        }
        if matches!(
            p["type"].as_str(),
            Some("function_call_output" | "custom_tool_call_output")
        ) {
            out.push(json!({"kind":"tool_result","tool_id":p["call_id"],"output":p["output"],"is_error":false}));
        }
    }
    if kind == AgentKind::Codex {
        let p = &record["payload"];
        if record["type"] == "event_msg" {
            let state = match p["type"].as_str() {
                Some("task_started") => Some("started"),
                Some("task_complete") => Some("completed"),
                Some("turn_aborted") => Some("interrupted"),
                _ => None,
            };
            if p["type"] == "task_complete"
                && p.get("last_agent_message").is_some_and(Value::is_null)
            {
                let text = p["error"]["message"]
                    .as_str()
                    .filter(|m| !m.trim().is_empty()) // a blank row would be silence again
                    .unwrap_or(CODEX_NO_REPLY);
                out.push(json!({"kind":"message","role":"assistant","text":text}));
            }
            if let Some(state) = state {
                out.push(json!({"kind":"turn","turn_id":p["turn_id"],"state":state}));
            }
        } else if (!matches!(
            record["type"].as_str(),
            Some(
                "response_item"
                    | "session_meta"
                    | "turn_context"
                    | "compacted"
                    | "world_state"
                    | "token_usage_record"
            )
        ) && (p.get("content").is_some() || p.get("message").is_some()))
            || (record["type"] == "response_item"
                && !matches!(
                    p["type"].as_str(),
                    Some(
                        "message"
                            | "reasoning"
                            | "function_call"
                            | "custom_tool_call"
                            | "function_call_output"
                            | "custom_tool_call_output"
                            // Ticket 409: a subagent's note to its parent, encrypted; nothing to draw.
                            | "agent_message"
                    )
                ))
        {
            // Ticket 409: other record types (session_meta, world_state, inter_agent_communication_metadata, ...) are
            // bookkeeping; only one that carries text the chat cannot draw is counted.
            out.push(json!({"kind":"skipped","count":1}));
        }
    }
    out
}

/// Ticket 139: the `tool_result` of a finished Codex command, from `exec_command_end` or 0.161.0's
/// `item_completed` / `CommandExecution`. None unless the record names its call and carries an integer exit
/// code: success is only an explicit exit 0 with a `completed` (or absent) status. The text has the shape of
/// Codex's own `function_call_output` receipt, which the web test summary reads. Stateless: whether the call
/// exists or already has a result is the stream's business (`turn_files::Tracker`).
pub(crate) fn command_result(record: &Value) -> Option<Value> {
    let p = &record["payload"];
    if record["type"] != "event_msg" {
        return None;
    }
    let (id, body) = match (p["type"].as_str(), p["item"]["type"].as_str()) {
        (Some("exec_command_end"), _) => (&p["call_id"], p),
        (Some("item_completed"), Some("CommandExecution")) => (&p["item"]["id"], &p["item"]),
        _ => return None,
    };
    let code = body["exit_code"].as_i64()?;
    let wall = match (
        body["duration"]["secs"].as_u64(),
        body["duration"]["nanos"].as_u64(),
    ) {
        (Some(s), Some(n)) => format!("{:.4} seconds", s as f64 + n as f64 / 1e9),
        _ => "unknown".into(),
    };
    let text = ["aggregated_output", "formatted_output", "stdout"]
        .iter()
        .find_map(|k| body[*k].as_str())
        .unwrap_or_default();
    let ok = code == 0 && body["status"].as_str().is_none_or(|s| s == "completed");
    let mut event = json!({"kind":"tool_result","tool_id":id,"output":format!("Wall time: {wall}\nProcess exited with code {code}\nOutput:\n{text}"),"is_error":!ok});
    if let Some(at) = record["timestamp"].as_str() {
        event["at"] = at.into(); // same as `project`: the PR badge ages from the record time
    }
    valid_data(&event).then_some(event)
}

fn valid_data(data: &Value) -> bool {
    let text = |name: &str| data[name].is_string();
    let role = || matches!(data["role"].as_str(), Some("user" | "assistant"));
    match data["kind"].as_str() {
        Some("message") => role() && text("text"),
        Some("image") => {
            role()
                && match data["source"]["type"].as_str() {
                    Some("base64") => {
                        data["source"]["data"].is_string()
                            && data["source"]["media_type"].is_string()
                    }
                    Some("url") => data["source"]["url"].is_string(),
                    Some("path") => data["source"]["path"].is_string(),
                    _ => false,
                }
        }
        Some("thinking") => text("text"),
        Some("tool_use") => {
            text("tool_id")
                && text("name")
                && (data["input"].is_object() || data["input"].is_string())
        }
        Some("tool_result") => {
            text("tool_id")
                && (data["output"].is_string() || data["output"].is_array())
                && data["is_error"].is_boolean()
        }
        Some("task_result") => text("tool_id") && text("text"),
        Some("edit") => {
            text("tool_id")
                && text("path")
                && data["added"].is_u64()
                && (data["removed"].is_u64()
                    || (data["operation"] == "delete" && data["removed"].is_null()))
                && (data["operation"] != "move" || text("destination"))
                && data["hunks"].as_array().is_some_and(|hunks| {
                    hunks.iter().all(|h| {
                        h.is_string()
                            || (["oldStart", "oldLines", "newStart", "newLines"]
                                .iter()
                                .all(|key| h[key].is_u64())
                                && h["lines"]
                                    .as_array()
                                    .is_some_and(|lines| lines.iter().all(Value::is_string)))
                    })
                })
        }
        Some("turn") => {
            (data["turn_id"].is_null() || text("turn_id"))
                && matches!(
                    data["state"].as_str(),
                    Some("started" | "completed" | "interrupted")
                )
        }
        Some("skipped") => data["count"].as_u64().is_some_and(|n| n > 0),
        Some("version_banner") => {
            matches!(data["agent"].as_str(), Some("claude" | "codex" | "shell")) && text("version")
        }
        Some("final_text") => text("turn_id") && text("text"),
        Some("artifact") => artifacts::valid(data), // v1b-06
        _ => false,
    }
}

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub schema_version: u32,
    pub cursor: u64,
    pub data: Value,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Page {
    #[serde(default)]
    pub generation: u64,
    pub schema_version: u32,
    /// Pinned version event; also appears at its normal history cursor. Consumers deduplicate it.
    pub banner: Option<Event>,
    pub skipped: u64,
    pub events: Vec<Event>,
    /// Exclusive cursor for the next older page; absent at the beginning.
    pub before: Option<u64>,
    /// Latest cursor, including when the page is empty.
    pub end: u64,
    /// Ticket 212 (A5): why no transcript could be read for this session, in words. Absent while one is read, so
    /// the wire of such a page stays byte-identical; the window shows it for a session that works without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_transcript: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Feed {
    events: Vec<Event>,
}
impl Feed {
    pub fn push(&mut self, data: Value) {
        self.events.push(Event {
            schema_version: 1,
            cursor: self.events.len() as u64 + 1,
            data,
        });
    }
    pub fn since(&self, after: u64) -> Result<Page, String> {
        if after > self.events.len() as u64 {
            return Err("invalid chat cursor".into());
        }
        Ok(Page {
            generation: 0,
            schema_version: 1,
            banner: None,
            no_transcript: None,
            skipped: 0,
            events: self
                .events
                .iter()
                .skip(after as usize)
                .take(200)
                .cloned()
                .collect(),
            before: None,
            end: self.events.len() as u64,
        })
    }
    pub fn page(&self, before: Option<u64>) -> Result<Page, String> {
        let end = self.events.len() as u64;
        if before.is_some_and(|c| c == 0 || c > end + 1) {
            return Err("invalid chat cursor".into());
        }
        let stop = before
            .map(|c| c.saturating_sub(1) as usize)
            .unwrap_or(self.events.len());
        let start = stop.saturating_sub(200);
        Ok(Page {
            generation: 0,
            schema_version: 1,
            banner: None,
            no_transcript: None,
            skipped: 0,
            events: self.events[start..stop].to_vec(),
            before: (start > 0).then_some(start as u64 + 1),
            end,
        })
    }
}

/// Shared with session launch; tests can supply an empty list to `Store::page`.
pub const TESTED_VERSIONS: &[(AgentKind, &str)] = &[
    (AgentKind::Claude, "2.1.310 (Claude Code)"),
    (AgentKind::Codex, "codex-cli 0.161.0"),
    (AgentKind::Codex, "codex-cli 0.162.1"), // ticket 383: fixtures/chat/codex-0.162.1
];
pub fn tested(kind: AgentKind, version: Option<&str>, versions: &[(AgentKind, &str)]) -> bool {
    kind == AgentKind::Shell
        || versions
            .iter()
            .any(|(k, v)| *k == kind && version.is_some_and(|x| minor_key(x) == minor_key(v)))
}

/// The version string with its patch number cut: "2.1.310 (Claude Code)" -> "2.1 (Claude Code)".
/// A string without `major.minor.patch` is kept whole, so it only matches itself.
fn minor_key(v: &str) -> String {
    let b = v.as_bytes();
    for (i, c) in b.iter().enumerate() {
        if !c.is_ascii_digit() || (i > 0 && (b[i - 1].is_ascii_digit() || b[i - 1] == b'.')) {
            continue;
        }
        let mut dots = 0;
        let mut j = i;
        while j < b.len() && (b[j].is_ascii_digit() || (b[j] == b'.' && dots < 2)) {
            dots += (b[j] == b'.') as u8;
            j += 1;
        }
        if let Some(cut) = v[i..j].rfind('.').filter(|_| dots == 2) {
            return format!("{}{}", &v[..i + cut], &v[j..]);
        }
    }
    v.to_string()
}

#[cfg(test)]
mod tested_tests {
    use super::*;

    #[test]
    fn patch_update_stays_tested() {
        let t = &[
            (AgentKind::Claude, "2.1.310 (Claude Code)"),
            (AgentKind::Codex, "codex-cli 0.161.0"),
        ];
        assert!(tested(AgentKind::Claude, Some("2.1.314 (Claude Code)"), t));
        assert!(tested(AgentKind::Codex, Some("codex-cli 0.161.9"), t));
    }

    #[test]
    fn minor_update_untested() {
        let t = &[
            (AgentKind::Claude, "2.1.310 (Claude Code)"),
            (AgentKind::Codex, "codex-cli 0.161.0"),
        ];
        assert!(!tested(AgentKind::Claude, Some("2.2.0 (Claude Code)"), t));
        assert!(!tested(AgentKind::Claude, Some("2.1.314 (Other)"), t));
        assert!(!tested(AgentKind::Claude, None, t));
        assert!(!tested(AgentKind::Codex, Some("codex-cli 0.162.0"), t));
    }
}

/// One `edit` event per file of an apply_patch body.
fn patch_edits(patch: &str, call_id: &Value, out: &mut Vec<Value>) {
    let mut path = None;
    let mut deleting = false;
    let mut destination = None;
    let mut hunks: Vec<&str> = vec![];
    for line in patch.lines().chain(std::iter::once("*** End Patch")) {
        if line.starts_with("*** ") && !line.starts_with("*** Move to:") {
            if let Some(path) = path.take() {
                let added = hunks.iter().filter(|l| l.starts_with('+')).count();
                let removed = hunks.iter().filter(|l| l.starts_with('-')).count();
                let mut edit = json!({"kind":"edit","tool_id":call_id,"path":path,"added":added,"removed":removed,"hunks":hunks});
                if deleting {
                    edit["operation"] = json!("delete");
                    // The request names the file but contains no deleted preimage.
                    edit["removed"] = Value::Null;
                }
                if let Some(to) = destination.take() {
                    edit["operation"] = json!("move");
                    edit["destination"] = json!(to);
                }
                out.push(edit);
                hunks.clear();
            }
            deleting = line.starts_with("*** Delete File: ");
            path = line
                .strip_prefix("*** Update File: ")
                .or_else(|| line.strip_prefix("*** Add File: "))
                .or_else(|| line.strip_prefix("*** Delete File: "));
        } else if let Some(to) = line.strip_prefix("*** Move to: ") {
            destination = Some(to);
        } else if path.is_some() && !(hunks.is_empty() && line.trim_end() == "@@") {
            // Look 11-17 N11: Codex opens each file's change with a bare `@@`; first, it separates nothing.
            hunks.push(line);
        }
    }
}

pub mod artifacts; // v1b-06
pub mod handoff; // v2-3a
pub mod kids; // V2-CF4: a session's sub-agents, read-only
mod legacy;
mod log;
mod persistence;
pub mod pr; // v2-8b
pub mod search; // v2-7
mod service;
pub mod turn_files; // ticket 222 (B19)
pub use persistence::Store;
pub use service::{Cache, ReadPlan, StopPlan};

/// Session ids change on explicit resume; agent conversation identities do not.
pub fn session_key(session: &crate::api::Session) -> String {
    let kind = match session.kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Shell => "shell",
        AgentKind::Acp => "acp", // V2-4a
    };
    format!(
        "{kind}-{}",
        session.agent_session_id.as_deref().unwrap_or(&session.id)
    )
}

// A replayed journal already has the latest queue sequence; its event id remains turn-local.
pub(crate) fn stop_turn(payload: &Value, completion: u64) -> String {
    payload["turn_id"]
        .as_str()
        .or_else(|| payload["prompt_id"].as_str())
        .map(str::to_string)
        .or_else(|| {
            payload["nunchiro_event_id"]
                .as_str()
                .map(|id| format!("event-{id}"))
        })
        .unwrap_or_else(|| format!("completion-{completion}"))
}
