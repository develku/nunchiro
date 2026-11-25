//! Version-local transcript adapter: only turn/tool records, no credential files.
use crate::api::{AgentKind, Session};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
/// A record's turn and tool events. Each carries `at`, when the record was written (epoch ms, from its `timestamp`):
/// the queue reads a transcript after the fact, and a record ends only what was asked before it was written.
pub fn events(kind: AgentKind, v: &Value) -> Vec<(String, Value)> {
    let mut out = events_of(kind, v);
    let at = v["timestamp"].as_str().and_then(|t| {
        let ms = t.get(19..23).filter(|f| f.starts_with('.'));
        let ms = ms.and_then(|f| f[1..].parse::<u64>().ok()).unwrap_or(0);
        Some(u64::try_from(crate::usage::epoch(t)?).ok()? * 1000 + ms)
    });
    if let Some(at) = at {
        for (_, payload) in &mut out {
            payload["at"] = at.into();
        }
    }
    out
}
fn events_of(kind: AgentKind, v: &Value) -> Vec<(String, Value)> {
    let mut out = vec![];
    match kind {
        AgentKind::Claude => {
            let message = &v["message"];
            let content = message["content"].as_array();
            // Ticket 1094: a background task that ends while a turn runs is told to Claude as a queued command (an
            // attachment record), not as a user record. Missed, the task stayed counted, the turn's Stop was held for
            // it, and the session read as working for the rest of the night.
            if v["type"] == "attachment" && v["attachment"]["type"] == "queued_command" {
                if let Some(id) = task_done(v["attachment"]["prompt"].as_str().unwrap_or("")) {
                    out.push(("TaskCompleted".into(), json!({"task_id":id})));
                }
                return out;
            }
            if v["type"] == "user" {
                let text = message["content"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        content
                            .map(|a| {
                                a.iter()
                                    .filter_map(|c| c["text"].as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default()
                    });
                // Ticket 1059: /context's table is a hidden note of a local command, not a prompt: no turn starts.
                if crate::session_context::context_usage(v).is_some() {
                    return out;
                }
                if text.trim_start().starts_with("<task-notification>") {
                    if let Some(id) = task_done(&text) {
                        out.push(("TaskCompleted".into(), json!({"task_id":id})));
                    }
                    return out;
                }
                // W35 look v23 S2-1: a slash command's own records (Claude 2.1.329 writes the command line as
                // `<command-name>/x</command-name>...` and a local command's answer as `<local-command-stdout>`).
                if text.trim_start().starts_with("<command-name>") {
                    out.push(("CommandSubmit".into(), json!({})));
                    return out;
                }
                if text.trim_start().starts_with("<local-command-stdout>") {
                    out.push(("CommandDone".into(), json!({})));
                    return out;
                }
                if ["<system-reminder>", "<bash-input>", "<local-command-"]
                    .iter()
                    .any(|marker| text.trim_start().starts_with(marker))
                {
                    return out;
                }
                // Claude's own record of an interrupt ends the turn; it is not a new prompt (look 11-17 N0).
                if text
                    .trim_start()
                    .starts_with("[Request interrupted by user")
                {
                    out.push(("Interrupted".into(), json!({})));
                    return out;
                }
                if let Some(id) = v["toolUseResult"]["backgroundTaskId"].as_str().or_else(|| {
                    v["toolUseResult"]["agentId"]
                        .as_str()
                        .filter(|_| v["toolUseResult"]["isAsync"] == true)
                }) {
                    out.push(("BackgroundStarted".into(), json!({"task_id":id})));
                }
                let results = content.is_some_and(|a| a.iter().any(|c| c["type"] == "tool_result"));
                out.push((
                    if results {
                        "ToolResult"
                    } else {
                        "UserPromptSubmit"
                    }
                    .into(),
                    json!({"prompt_id":v["uuid"]}),
                ));
            }
            if let Some(content) = content {
                for c in content {
                    if c["type"] == "tool_use" && c["name"] == "AskUserQuestion" {
                        out.push((
                            "Question".into(),
                            json!({"tool_name":c["name"],"tool_input":c["input"]}),
                        ));
                    }
                }
            }
            // Ticket 1056: Code Mode writes each shell call a script makes as a virtual record with stop_reason
            // "stop_sequence" in the middle of the turn. Read as a Stop, it ended the turn early; the real Stop then
            // counted nothing, and the send queue waited for a finished turn for ever.
            if v["isVirtual"] != true
                && ["end_turn", "max_tokens", "stop_sequence", "refusal"]
                    .iter()
                    .any(|r| message["stop_reason"] == *r)
            {
                out.push(("Stop".into(), json!({})));
            }
            if v["type"] == "system" && v["subtype"] == "turn_duration" {
                out.push(("Stop".into(), json!({})));
            }
        }
        AgentKind::Codex => {
            let p = &v["payload"];
            if v["type"] == "event_msg" {
                let event = match p["type"].as_str() {
                    Some("task_started") => Some("UserPromptSubmit"),
                    Some("task_complete") => Some("Stop"),
                    Some("turn_aborted") => Some("Interrupted"),
                    _ => None,
                };
                if let Some(event) = event {
                    out.push((event.into(), json!({"turn_id":p["turn_id"]})));
                }
            }
            if v["type"] == "response_item"
                && p["type"] == "function_call"
                && (p["name"] == "request_user_input" || p["name"] == "request_user_input_async")
            {
                let input = p["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or(Value::Null);
                out.push((
                    "Question".into(),
                    json!({"tool_name":p["name"],"tool_input":input,"tool_use_id":p["call_id"]}),
                ));
            }
            if v["type"] == "response_item" && p["type"] == "function_call_output" {
                // Ticket 691: only an accepted `request_user_input_async` leaves its question open.
                let output = p["output"]
                    .as_str()
                    .or_else(|| p["output"]["content"].as_str());
                let open = output.and_then(|o| serde_json::from_str::<Value>(o).ok())
                    == Some(json!({"accepted": true}));
                out.push((
                    "ToolResult".into(),
                    json!({"tool_use_id":p["call_id"],"open":open}),
                ));
            }
            // Ticket 691: the answer to `request_user_input_async` arrives as a user message, maybe mid-turn.
            if v["type"] == "response_item" && p["type"] == "message" && p["role"] == "user" {
                out.push(("Answered".into(), json!({})));
            }
        }
        AgentKind::Shell | AgentKind::Acp => {} // V2-4a: an ACP chat comes from `session/update`
    }
    out
}
/// The task id of a `<task-notification>` that says its background task ended.
fn task_done(text: &str) -> Option<&str> {
    fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
        let start = format!("<{name}>");
        let end = format!("</{name}>");
        text.split_once(&start)?.1.split_once(&end).map(|(v, _)| v)
    }
    if !text.trim_start().starts_with("<task-notification>") {
        return None;
    }
    let id = tag(text, "task-id")?;
    matches!(tag(text, "status"), Some("completed" | "failed" | "killed")).then_some(id)
}
pub fn locate(session: &Session) -> Option<PathBuf> {
    let id = session.agent_session_id.as_ref()?;
    // v2-2b: the session's account folder, else "Your own".
    let root = crate::accounts::config_home(session.kind, session.config_dir.as_deref())?;
    match session.kind {
        AgentKind::Claude => {
            let cwd = session
                .cwd
                .to_string_lossy()
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_string()
                    } else {
                        "-".into()
                    }
                })
                .collect::<String>();
            Some(root.join("projects").join(cwd).join(format!("{id}.jsonl")))
        }
        AgentKind::Codex => {
            let mut dirs = vec![root.join("sessions")];
            let mut found = vec![];
            let mut visited = 0;
            while let Some(dir) = dirs.pop() {
                for entry in fs::read_dir(dir).ok()?.flatten() {
                    visited += 1;
                    if visited > 20000 {
                        return None;
                    }
                    let ty = entry.file_type().ok()?;
                    if ty.is_dir() {
                        dirs.push(entry.path());
                    } else if ty.is_file()
                        && entry
                            .file_name()
                            .to_str()
                            .is_some_and(|n| n.ends_with(&format!("{id}.jsonl")))
                    {
                        let mut first = String::new();
                        use std::io::BufRead;
                        std::io::BufReader::new(fs::File::open(entry.path()).ok()?.take(65536))
                            .read_line(&mut first)
                            .ok()?;
                        let v: Value = serde_json::from_str(&first).ok()?;
                        if v["type"] == "session_meta"
                            && v["payload"]["id"] == *id
                            && v["payload"]["cwd"].as_str().map(Path::new) == Some(&session.cwd)
                        {
                            found.push(entry.path());
                        }
                    }
                }
            }
            (found.len() == 1).then(|| found.remove(0))
        }
        AgentKind::Shell | AgentKind::Acp => None,
    }
}
/// Cursor, skipped-line count and event effects commit together in the queue.
pub struct Batch {
    pub key: String,
    pub end: u64,
    pub records: Vec<Value>,
    pub skipped: u64,
    pub discarding: bool,
}
pub fn read(
    path: &Path,
    previous_key: &str,
    offset: u64,
) -> Result<Option<(String, u64, Vec<Value>)>, String> {
    Ok(read_batch(path, previous_key, offset, false)?.map(|b| (b.key, b.end, b.records)))
}
pub fn read_batch(
    path: &Path,
    previous_key: &str,
    offset: u64,
    discarding: bool,
) -> Result<Option<Batch>, String> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    read_batch_from(&file, path, previous_key, offset, discarding)
}
/// The next batch of a transcript already open, so a reader that keyed the file reads that same file even if the
/// agent renames a new one over its path meanwhile.
pub fn read_batch_from(
    mut file: &fs::File,
    path: &Path,
    previous_key: &str,
    offset: u64,
    mut discarding: bool,
) -> Result<Option<Batch>, String> {
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("transcript is not a regular file".into());
    }
    let key = format!("{}:{}:{}", path.display(), meta.dev(), meta.ino());
    let offset = if key == previous_key && offset <= meta.len() {
        offset
    } else {
        discarding = false;
        0
    };
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    file.take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let Some(last) = bytes.iter().rposition(|b| *b == b'\n') else {
        return if !bytes.is_empty() && (discarding || bytes.len() == 1024 * 1024) {
            Ok(Some(Batch {
                key,
                end: offset + bytes.len() as u64,
                records: vec![],
                skipped: u64::from(!discarding),
                discarding: true,
            }))
        } else {
            Ok(None)
        };
    };
    let mut records = vec![];
    let mut skipped = 0;
    for line in bytes[..=last].split(|b| *b == b'\n') {
        if discarding {
            discarding = false;
            continue;
        }
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice(line) {
            Ok(record) => records.push(record),
            Err(_) => skipped += 1,
        }
    }
    Ok(Some(Batch {
        key,
        end: offset + last as u64 + 1,
        records,
        skipped,
        discarding: false,
    }))
}

/// Hooks may name only this conversation's transcript inside its agent data root.
pub fn validate_path(session: &Session, path: &Path) -> Result<PathBuf, String> {
    let id = session
        .agent_session_id
        .as_deref()
        .ok_or("transcript identity is not known")?;
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err("invalid transcript path".into());
    }
    // v2-2b: the session's account folder, else "Your own" (a shell has none).
    let root = crate::accounts::config_home(session.kind, session.config_dir.as_deref());
    let expected =
        match session.kind {
            AgentKind::Claude => {
                let cwd = session
                    .cwd
                    .to_string_lossy()
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect::<String>();
                let parent = root.ok_or("HOME missing")?.join("projects").join(cwd);
                if path.file_name().and_then(|n| n.to_str()) != Some(&format!("{id}.jsonl")) {
                    return Err("transcript conversation mismatch".into());
                }
                parent
            }
            AgentKind::Codex => {
                if !path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                    n.starts_with("rollout-") && n.ends_with(&format!("{id}.jsonl"))
                }) {
                    return Err("transcript conversation mismatch".into());
                }
                root.ok_or("HOME missing")?.join("sessions")
            }
            AgentKind::Shell => return Err("shell sessions have no agent transcript".into()),
            AgentKind::Acp => return Err("ACP sessions have no agent transcript".into()), // V2-4a
        };
    let expected = expected.canonicalize().map_err(|e| e.to_string())?;
    // v1b-02 r2: canonicalization must not change the claimed conversation's filename.
    let name = path
        .file_name()
        .ok_or("invalid transcript filename")?
        .to_owned();
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if path.file_name() != Some(name.as_os_str()) {
        return Err("resolved transcript conversation mismatch".into());
    }
    if !path.starts_with(expected) {
        return Err("transcript outside session data root".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::SessionState;

    fn session(kind: AgentKind, cwd: &Path, config_dir: Option<PathBuf>) -> Session {
        serde_json::from_value(json!({
            "id": "s", "kind": kind, "project": cwd, "cwd": cwd, "label": "", "state": SessionState::Running,
            "agent_session_id": "0123456789abcdef0123456789abcdef", "agent_version": null, "untested": false,
            "pid": null, "config_dir": config_dir,
        }))
        .unwrap()
    }

    // Ticket 1056: a Code Mode shell call's virtual record is no Stop; a real record with the same stop_reason is.
    #[test]
    fn a_virtual_record_ends_no_turn() {
        let mut v = json!({"type":"assistant","isVirtual":true,"message":{"model":"<synthetic>","role":"assistant",
            "stop_reason":"stop_sequence","content":[{"type":"tool_use","id":"repl_1","name":"Bash","input":{}}]}});
        assert!(
            events(AgentKind::Claude, &v)
                .iter()
                .all(|(e, _)| e != "Stop")
        );
        v["isVirtual"] = false.into();
        assert!(
            events(AgentKind::Claude, &v)
                .iter()
                .any(|(e, _)| e == "Stop")
        );
    }

    // Ticket 1059: the /context table record starts no turn, so the session never reads as working after /context.
    #[test]
    fn t1059_context_record_is_no_prompt() {
        let v = crate::session_context::context_record();
        assert_eq!(events(AgentKind::Claude, &v), vec![]);
    }

    // Look 11-17 N0: Claude's interrupt record ends the turn; it never starts a new one.
    #[test]
    fn n0_claude_interrupt_record_is_no_prompt() {
        for text in [
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
        ] {
            let v = json!({"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":text}]}});
            assert_eq!(
                events(AgentKind::Claude, &v),
                vec![("Interrupted".to_string(), json!({}))]
            );
        }
    }

    // V2-2b acceptance `adapters_use_config_dir`: transcript lookup and the hook path check resolve under the
    // session's account folder when set, under "Your own" (the core's variable, else HOME's default) when not.
    #[test]
    fn adapters_use_config_dir() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("adapters-{}", std::process::id()));
        let cwd = root.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let (root, cwd) = (root.canonicalize().unwrap(), cwd.canonicalize().unwrap());
        let account = root.join("accounts/codex/a1");
        let id = "0123456789abcdef0123456789abcdef";

        let claude = session(AgentKind::Claude, &cwd, Some(account.clone()));
        let dashed: String = cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        assert_eq!(
            locate(&claude).unwrap(),
            account
                .join("projects")
                .join(&dashed)
                .join(format!("{id}.jsonl"))
        );
        let own_claude = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".claude"));
        assert_eq!(
            locate(&session(AgentKind::Claude, &cwd, None)).unwrap(),
            own_claude
                .join("projects")
                .join(&dashed)
                .join(format!("{id}.jsonl"))
        );

        let rollout = account.join(format!("sessions/2026/10/27/rollout-x-{id}.jsonl"));
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(
            &rollout,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}})
            ),
        )
        .unwrap();
        let codex = session(AgentKind::Codex, &cwd, Some(account.clone()));
        assert_eq!(locate(&codex).unwrap(), rollout);
        assert_eq!(validate_path(&codex, &rollout).unwrap(), rollout);
        // "Your own" never finds or accepts the account's transcript.
        let own_codex = session(AgentKind::Codex, &cwd, None);
        assert_ne!(locate(&own_codex).as_ref(), Some(&rollout));
        assert!(validate_path(&own_codex, &rollout).is_err());
        // An account session never accepts a transcript outside its folder.
        let other = root.join(format!("elsewhere/sessions/rollout-x-{id}.jsonl"));
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::copy(&rollout, &other).unwrap();
        assert!(validate_path(&codex, &other).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
