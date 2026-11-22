//! Ticket 222 (B19): the files each finished turn wrote, carried on its `turn` event as `files` for Diff's
//! "Latest turn" scope and the chat's per-turn row. Own code (no local T3 Code checkout to port from).
//! Paths are page text: relative to the session project, outside paths, `..` and hidden characters dropped.
use super::{command_result, project};
use crate::api::AgentKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::path::{Component, Path};

/// Paths kept per turn; the rest of a larger turn is not listed.
pub const CAP: usize = 200;
/// `exec_command` call ids tracked per turn. A transcript with no `task_started` never clears the map, so past this
/// the oldest tracked id is evicted for a new one; an evicted id's `function_call_output` passes through as before
/// ticket 139.
pub const MAX_EXEC_CALLS: usize = 256;
/// Claude's file-writing tools; Codex writes through apply_patch, which the projection already turns into `edit` events.
const WRITERS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
/// Real-app 11-10 defect 3: tools that change no file, beside the writers above and Codex's apply_patch (turned into
/// `edit` events). Any other tool (a shell, Codex `exec`, a subagent, an MCP tool) may write files the list cannot
/// name, so its turn carries `files_partial`.
const QUIET: [&str; 16] = [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "NotebookRead",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "TodoRead",
    "ExitPlanMode",
    "AskUserQuestion",
    "ToolSearch",
    "apply_patch",
    "update_plan",
    "view_image",
    "web_search",
];

/// The open turn's paths so far and the project root, kept between transcript batches by the chat store.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Tracker {
    root: Option<String>,
    files: Vec<String>,
    /// Ticket 139: this turn's Codex `exec_command` call ids, false until the call has a result. A finished-command
    /// record is shown only for an open id, and a later `function_call_output` for a shown id is dropped, so one
    /// call shows one result. Cleared at each turn start; old saved states have none.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    exec_calls: BTreeMap<String, bool>,
    /// V2.5-25: the ids of `exec_calls` oldest first, so a full map drops the oldest call. Old saved states have none.
    #[serde(default, skip_serializing_if = "VecDeque::is_empty")]
    exec_order: VecDeque<String>,
    /// The open turn ran a tool outside WRITERS and QUIET. Old saved states have none.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    partial: bool,
}

impl Tracker {
    /// `chat::project`, plus `files` on each finished turn event (the paths since the previous turn boundary).
    pub fn project(&mut self, kind: AgentKind, record: &Value) -> Vec<Value> {
        // Claude stamps every record with the session cwd; Codex names it in session_meta and turn_context.
        let cwd = match kind {
            AgentKind::Claude => record["cwd"].as_str(),
            _ => record["payload"]["cwd"].as_str(),
        };
        if let Some(cwd) = cwd.filter(|c| c.starts_with('/')) {
            self.root = Some(cwd.to_string());
        }
        let mut events = project(kind, record);
        for event in &mut events {
            match event["kind"].as_str() {
                Some("tool_use")
                    if WRITERS.contains(&event["name"].as_str().unwrap_or_default()) =>
                {
                    let input = &event["input"];
                    let path = input["file_path"]
                        .as_str()
                        .or(input["notebook_path"].as_str());
                    self.add(path);
                }
                Some("tool_use")
                    if !QUIET.contains(&event["name"].as_str().unwrap_or_default()) =>
                {
                    self.partial = true;
                }
                Some("edit") => {
                    self.add(event["path"].as_str());
                    self.add(event["destination"].as_str());
                }
                Some("turn") => match event["state"].as_str() {
                    Some("completed" | "interrupted") => {
                        event["files"] = std::mem::take(&mut self.files).into();
                        if std::mem::take(&mut self.partial) {
                            event["files_partial"] = true.into();
                        }
                    }
                    _ => {
                        self.files.clear();
                        self.partial = false;
                        self.exec_calls.clear();
                        self.exec_order.clear();
                    }
                },
                _ => {}
            }
        }
        if kind == AgentKind::Codex {
            events.retain(|e| self.keeps(e));
            if let Some(result) = command_result(record)
                && let Some(shown) = result["tool_id"]
                    .as_str()
                    .and_then(|id| self.exec_calls.get_mut(id))
                && !*shown
            {
                *shown = true;
                events.push(result);
            }
        }
        events
    }

    /// Opens an `exec_command` call; drops a result for a call that already has one.
    fn keeps(&mut self, event: &Value) -> bool {
        match (event["kind"].as_str(), event["tool_id"].as_str()) {
            (Some("tool_use"), Some(id)) if event["name"] == "exec_command" => {
                if !self.exec_calls.contains_key(id) {
                    if self.exec_calls.len() >= MAX_EXEC_CALLS {
                        // A state saved before `exec_order` has none: fall back to the smallest id.
                        let old = self
                            .exec_order
                            .pop_front()
                            .or_else(|| self.exec_calls.keys().next().cloned());
                        old.map(|old| self.exec_calls.remove(&old));
                    }
                    self.exec_calls.insert(id.into(), false);
                    self.exec_order.push_back(id.into());
                }
            }
            (Some("tool_result"), Some(id)) => {
                if let Some(shown) = self.exec_calls.get_mut(id) {
                    return !std::mem::replace(shown, true);
                }
            }
            _ => {}
        }
        true
    }

    fn add(&mut self, path: Option<&str>) {
        if let Some(rel) = path.and_then(|p| relative(self.root.as_deref(), p))
            && self.files.len() < CAP
            && !self.files.contains(&rel)
        {
            self.files.push(rel);
        }
    }
}

/// `path` relative to `root`; None for a path outside it, with a `..`, or with control or hidden characters.
pub fn relative(root: Option<&str>, path: &str) -> Option<String> {
    if path
        .chars()
        .any(|c| c.is_control() || crate::board::rights::hidden(c))
    {
        return None;
    }
    let path = Path::new(path);
    let rel = if path.is_absolute() {
        path.strip_prefix(root?).ok()?
    } else {
        path
    };
    let mut parts = vec![];
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}
