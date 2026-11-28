//! Ticket 573 slice 3: `nunchiro mcp`, a stdio MCP server whose tools are the CLI verbs. Each tool runs this same
//! binary with the CLI's arguments, so its behaviour, its refusals and its token (`NUNCHIRO_TOKEN`, inherited) are the
//! CLI's by construction; no rule lives here. Exit 0 is a JSON result, exit 2 (needs an answer: a timeout, a waiting
//! ask) a structured result with `needs_answer`, exit 1 an error result with the CLI's message.
//! Taken from T3 Code's orchestrator MCP server (docs/orchestration-v2/orchestrator-mcp-server.md, "Tool Surface"):
//! JSON results, a pending question as a result field rather than an error (`hasPendingQuestion`), a wait that ends
//! without cancelling. Not taken: its OAuth sign-in (a token here comes from `nunchiro token create`), batch tools.
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    process::{Command, Stdio},
};

type Build = fn(&Value) -> Result<Vec<String>, String>;
struct Tool {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    build: Build,
}

fn text(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| format!("missing string argument {key}"))
}
fn opt(v: &Value, key: &str, flag: &str, args: &mut Vec<String>) {
    match v.get(key) {
        Some(Value::String(s)) => args.extend([flag.into(), s.clone()]),
        Some(Value::Number(n)) => args.extend([flag.into(), n.to_string()]),
        _ => {}
    }
}
fn yes(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
fn until(v: &Value, args: &mut Vec<String>) {
    for state in strings(v, "until") {
        args.extend(["--until".into(), state]);
    }
    opt(v, "timeout_ms", "--timeout", args);
}
fn schema(required: &[&str], properties: Value) -> Value {
    json!({"type": "object", "properties": properties, "required": required})
}
const AGENT: &str = "session id or label";
const PROJECT: &str = "project folder (the room is this project's; default the server's folder)";

fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "agent_start",
            description: "Start an agent session (nunchiro agent start). Returns the started session.",
            schema: || {
                schema(
                    &["name", "project"],
                    json!({
                        "name": {"type": "string", "description": "label"},
                        "project": {"type": "string"},
                        "kind": {"type": "string", "enum": ["claude", "codex", "shell"]},
                        "worktree": {"type": "boolean"},
                        "model": {"type": "string"},
                        "effort": {"type": "string"},
                        "env": {"type": "object", "additionalProperties": {"type": "string"}},
                        "args": {"type": "array", "items": {"type": "string"}, "description": "arguments after --"}
                    }),
                )
            },
            build: |v| {
                let mut a = vec!["agent".into(), "start".into(), text(v, "name")?];
                a.extend(["--project".into(), text(v, "project")?]);
                opt(v, "kind", "--kind", &mut a);
                if yes(v, "worktree") {
                    a.push("--worktree".into());
                }
                opt(v, "model", "--model", &mut a);
                opt(v, "effort", "--effort", &mut a);
                if let Some(env) = v.get("env").and_then(Value::as_object) {
                    for (k, val) in env {
                        a.extend([
                            "--env".into(),
                            format!("{k}={}", val.as_str().unwrap_or_default()),
                        ]);
                    }
                }
                let rest = strings(v, "args");
                if !rest.is_empty() {
                    a.push("--".into());
                    a.extend(rest);
                }
                Ok(a)
            },
        },
        Tool {
            name: "agent_prompt",
            description: "Type a prompt into an agent and submit it (nunchiro agent prompt); with wait, until a state.",
            schema: || {
                schema(
                    &["agent", "text"],
                    json!({"agent": {"type": "string", "description": AGENT}, "text": {"type": "string"},
                        "wait": {"type": "boolean"}, "until": {"type": "array", "items": {"type": "string"}},
                        "timeout_ms": {"type": "integer"}}),
                )
            },
            build: |v| {
                let mut a = vec![
                    "agent".into(),
                    "prompt".into(),
                    text(v, "agent")?,
                    text(v, "text")?,
                ];
                if yes(v, "wait") {
                    a.push("--wait".into());
                }
                until(v, &mut a);
                Ok(a)
            },
        },
        Tool {
            name: "agent_send",
            description: "Type text into an agent without submitting it (nunchiro agent send).",
            schema: || {
                schema(
                    &["agent", "text"],
                    json!({"agent": {"type": "string", "description": AGENT}, "text": {"type": "string"}}),
                )
            },
            build: |v| {
                Ok(vec![
                    "agent".into(),
                    "send".into(),
                    text(v, "agent")?,
                    text(v, "text")?,
                ])
            },
        },
        Tool {
            name: "agent_wait",
            description: "Wait until an agent reaches a state: working, done, idle, blocked, failed, exited (nunchiro agent wait).",
            schema: || {
                schema(
                    &["agent"],
                    json!({"agent": {"type": "string", "description": AGENT},
                        "until": {"type": "array", "items": {"type": "string"}}, "timeout_ms": {"type": "integer"}}),
                )
            },
            build: |v| {
                let mut a = vec!["agent".into(), "wait".into(), text(v, "agent")?];
                until(v, &mut a);
                Ok(a)
            },
        },
        Tool {
            name: "agent_read",
            description: "Read an agent's screen or transcript (nunchiro agent read).",
            schema: || {
                schema(
                    &["agent"],
                    json!({"agent": {"type": "string", "description": AGENT}, "lines": {"type": "integer"},
                        "source": {"type": "string", "enum": ["screen", "transcript"]}}),
                )
            },
            build: |v| {
                let mut a = vec!["agent".into(), "read".into(), text(v, "agent")?];
                opt(v, "lines", "--lines", &mut a);
                opt(v, "source", "--source", &mut a);
                Ok(a)
            },
        },
        Tool {
            name: "agent_get",
            description: "One agent's record with its status (nunchiro agent get --json).",
            schema: || {
                schema(
                    &["agent"],
                    json!({"agent": {"type": "string", "description": AGENT}}),
                )
            },
            build: |v| {
                Ok(vec![
                    "agent".into(),
                    "get".into(),
                    text(v, "agent")?,
                    "--json".into(),
                ])
            },
        },
        Tool {
            name: "agent_list",
            description: "The agents this caller can see; mine = the ones it started (nunchiro agent list --json).",
            schema: || schema(&[], json!({"mine": {"type": "boolean"}})),
            build: |v| {
                let mut a = vec!["agent".into(), "list".into(), "--json".into()];
                if yes(v, "mine") {
                    a.push("--mine".into());
                }
                Ok(a)
            },
        },
        Tool {
            name: "agent_stop",
            description: "Stop and close a session by its id (nunchiro session close). A caller closes only itself and the sessions it started.",
            schema: || {
                schema(
                    &["id"],
                    json!({"id": {"type": "string", "description": "session id"}}),
                )
            },
            build: |v| Ok(vec!["session".into(), "close".into(), text(v, "id")?]),
        },
        Tool {
            name: "worktree_create",
            description: "Create a managed worktree (nunchiro worktree create).",
            schema: || {
                schema(
                    &["project"],
                    json!({"project": {"type": "string"}, "path": {"type": "string"}, "branch": {"type": "string"},
                        "base": {"type": "string"}, "label": {"type": "string"}}),
                )
            },
            build: |v| {
                let mut a = vec!["worktree".into(), "create".into(), "--no-focus".into()];
                for key in ["project", "path", "branch", "base", "label"] {
                    opt(v, key, &format!("--{key}"), &mut a);
                }
                Ok(a)
            },
        },
        Tool {
            name: "worktree_list",
            description: "The managed worktrees (nunchiro worktree list).",
            schema: || schema(&[], json!({"project": {"type": "string"}})),
            build: |v| {
                let mut a = vec!["worktree".into(), "list".into()];
                opt(v, "project", "--project", &mut a);
                Ok(a)
            },
        },
        Tool {
            name: "room_send",
            description: "Send a room message; the core stamps the sender (nunchiro agent send --to).",
            schema: || {
                schema(
                    &["body"],
                    json!({"body": {"type": "string"}, "to": {"type": "string", "description": "session id or label, or person"},
                        "thread": {"type": "string"}, "project": {"type": "string", "description": PROJECT}}),
                )
            },
            build: |v| room(v, "send", vec![], &["body"]),
        },
        Tool {
            name: "room_ask",
            description: "Ask in the room; with wait, the reply comes back in the result, or needs_answer at the timeout (nunchiro agent ask).",
            schema: || {
                schema(
                    &["body"],
                    json!({"body": {"type": "string"}, "to": {"type": "string"}, "thread": {"type": "string"},
                        "project": {"type": "string", "description": PROJECT}, "wait": {"type": "boolean"},
                        "timeout_s": {"type": "integer"}}),
                )
            },
            build: |v| {
                let mut a = vec![];
                if yes(v, "wait") {
                    a.push("--wait".into());
                }
                opt(v, "timeout_s", "--timeout", &mut a);
                room(v, "ask", a, &["body"])
            },
        },
        Tool {
            name: "room_reply",
            description: "Reply to a room message sent to this caller (nunchiro agent reply).",
            schema: || {
                schema(
                    &["message", "body"],
                    json!({"message": {"type": "string"}, "body": {"type": "string"},
                        "project": {"type": "string", "description": PROJECT}}),
                )
            },
            build: |v| room(v, "reply", vec![], &["message", "body"]),
        },
        Tool {
            name: "room_check",
            description: "This caller's unread room messages (nunchiro agent check).",
            schema: || {
                schema(
                    &[],
                    json!({"project": {"type": "string", "description": PROJECT}}),
                )
            },
            build: |v| room(v, "check", vec![], &[]),
        },
        Tool {
            name: "room_thread_read",
            description: "Every message of one room thread (nunchiro agent thread read).",
            schema: || {
                schema(
                    &["thread"],
                    json!({"thread": {"type": "string"}, "project": {"type": "string", "description": PROJECT}}),
                )
            },
            build: |v| room(v, "thread read", vec![], &["thread"]),
        },
        Tool {
            name: "memory_add",
            description: "Keep one lasting fact in this bot's memory (nunchiro memory add). Nunchiro adds the date and the source; after outside content it waits as a proposal.",
            schema: || {
                schema(
                    &["text"],
                    json!({"text": {"type": "string", "description": "one fact, one line"},
                        "topic": {"type": "string", "description": "a topic file, like mail-rules"},
                        "user": {"type": "boolean", "description": "a fact about the user (USER.md)"},
                        "from_user": {"type": "boolean", "description": "the user said it"}}),
                )
            },
            build: |v| {
                let mut a = vec!["memory".into(), "add".into(), text(v, "text")?];
                opt(v, "topic", "--topic", &mut a);
                for (key, flag) in [("user", "--user"), ("from_user", "--from-user")] {
                    if yes(v, key) {
                        a.push(flag.into());
                    }
                }
                Ok(a)
            },
        },
        Tool {
            name: "memory_forget",
            description: "Delete one line from this bot's memory everywhere it is kept (nunchiro memory forget).",
            schema: || {
                schema(
                    &["text"],
                    json!({"text": {"type": "string", "description": "words of the line"}}),
                )
            },
            build: |v| Ok(vec!["memory".into(), "forget".into(), text(v, "text")?]),
        },
        Tool {
            name: "memory_search",
            description: "Search past conversations of every agent on this Mac for words (nunchiro memory search). Secrets are masked; a hit from a conversation that read outside content marks this one too.",
            schema: || {
                schema(
                    &["query"],
                    json!({"query": {"type": "string", "description": "words to find, 1 to 256 bytes"}}),
                )
            },
            build: |v| {
                Ok(vec![
                    "memory".into(),
                    "search".into(),
                    text(v, "query")?,
                    "--json".into(),
                ])
            },
        },
        Tool {
            name: "memory_read",
            description: "This bot's memory index, or one topic file (nunchiro memory read).",
            schema: || schema(&[], json!({"topic": {"type": "string"}})),
            build: |v| {
                let mut a = vec!["memory".into(), "read".into()];
                opt(v, "topic", "--topic", &mut a);
                Ok(a)
            },
        },
    ]
}
/// `agent <verb> [options] -- <positional>...`: the options first, then `--`, so a body or id that starts with `--` is
/// never read as an option (review round 1, SHOULD 2).
fn room(
    v: &Value,
    verb: &str,
    extra: Vec<String>,
    positional: &[&str],
) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = std::iter::once("agent")
        .chain(verb.split(' '))
        .map(String::from)
        .collect();
    if verb == "send" || verb == "ask" {
        for key in ["to", "thread"] {
            opt(v, key, &format!("--{key}"), &mut a);
        }
    }
    a.extend(extra);
    // Always a project: a token caller names its room, and `agent send` is a room message only with an option before
    // its one word (a bare `send A T` types into A). The core reads a relative path from its own folder, so absolute.
    let project = match v.get("project").and_then(Value::as_str) {
        Some(p) => std::path::absolute(p),
        None => std::env::current_dir(),
    }
    .map_err(|e| e.to_string())?;
    a.extend(["--project".into(), project.to_string_lossy().into_owned()]);
    a.push("--".into());
    for key in positional {
        a.push(text(v, key)?);
    }
    Ok(a)
}

/// The CLI's output as JSON: one JSON value, several JSON lines as an array, anything else as `{"text": ...}`.
fn parse_output(stdout: &str) -> Value {
    let stdout = stdout.trim_end();
    if let Ok(v) = serde_json::from_str(stdout) {
        return v;
    }
    let lines: Result<Vec<Value>, _> = stdout.lines().map(serde_json::from_str).collect();
    match lines {
        Ok(lines) => Value::Array(lines),
        Err(_) => json!({"text": stdout}),
    }
}
fn call_tool(params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);
    let result = (|| {
        let tool = tools()
            .into_iter()
            .find(|t| t.name == name)
            .ok_or_else(|| format!("unknown tool {name}"))?;
        let argv = (tool.build)(args)?;
        Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(&argv)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())
    })();
    let (structured, is_error) = match result {
        Err(e) => (json!({"error": e}), true),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let message = stderr.trim().trim_start_matches("nunchiro: ").to_string();
            match out.status.code() {
                Some(0) => (
                    json!({"result": parse_output(&String::from_utf8_lossy(&out.stdout))}),
                    false,
                ),
                // Needs an answer (T3's `hasPendingQuestion`): a result to act on, not a failure.
                Some(2) => (json!({"needs_answer": true, "message": message}), false),
                _ => (json!({"error": message}), true),
            }
        }
    };
    json!({
        "content": [{"type": "text", "text": structured.to_string()}],
        "structuredContent": structured,
        "isError": is_error,
    })
}
fn handle(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone(); // a notification gets no reply
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "nunchiro", "version": env!("CARGO_PKG_VERSION")},
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools().iter().map(|t| json!({
            "name": t.name, "description": t.description, "inputSchema": (t.schema)(),
        })).collect::<Vec<_>>()}),
        "tools/call" => call_tool(&message["params"]),
        _ => {
            return Some(json!({"jsonrpc": "2.0", "id": id,
                "error": {"code": -32601, "message": format!("method not found: {method}")}}));
        }
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn write(reply: &Value) -> Result<(), String> {
    let mut out = std::io::stdout().lock(); // one whole line per reply, whichever thread writes it
    writeln!(out, "{reply}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}
/// One JSON-RPC message per line on stdin, one reply per line on stdout (the MCP stdio transport). A tool call runs on
/// its own thread and its reply carries its id, so a long `agent_wait` or `room_ask` never holds up `ping` or another
/// call. In-flight calls end with the server when stdin closes.
pub fn run() -> Result<(), String> {
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(message) if message["method"] == "tools/call" && message.get("id").is_some() => {
                std::thread::spawn(move || {
                    if let Some(reply) = handle(&message) {
                        let _ = write(&reply); // a closed stdout has no one left to tell
                    }
                });
            }
            Ok(message) => {
                if let Some(reply) = handle(&message) {
                    write(&reply)?;
                }
            }
            Err(e) => write(&json!({"jsonrpc": "2.0", "id": null,
                "error": {"code": -32700, "message": e.to_string()}}))?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_build_the_cli_arguments() {
        let build = |name: &str, args: Value| {
            (tools().into_iter().find(|t| t.name == name).unwrap().build)(&args)
        };
        assert_eq!(
            build("agent_start", json!({"name": "w", "project": "/p", "kind": "shell", "env": {"A": "1"}, "args": ["cat"]})).unwrap(),
            ["agent", "start", "w", "--project", "/p", "--kind", "shell", "--env", "A=1", "--", "cat"]
        );
        assert_eq!(
            build("room_send", json!({"body": "--to x", "project": "/p"})).unwrap(),
            ["agent", "send", "--project", "/p", "--", "--to x"]
        );
        assert_eq!(
            build(
                "room_reply",
                json!({"message": "m", "body": "--thread", "project": "/p"})
            )
            .unwrap(),
            ["agent", "reply", "--project", "/p", "--", "m", "--thread"]
        );
        assert_eq!(
            build(
                "agent_wait",
                json!({"agent": "w", "until": ["idle"], "timeout_ms": 5})
            )
            .unwrap(),
            ["agent", "wait", "w", "--until", "idle", "--timeout", "5"]
        );
        assert!(build("agent_read", json!({})).is_err());
    }

    #[test]
    fn output_is_json() {
        assert_eq!(parse_output("{\"a\":1}\n"), json!({"a": 1}));
        assert_eq!(
            parse_output("{\"a\":1}\n{\"a\":2}\n"),
            json!([{"a": 1}, {"a": 2}])
        );
        assert_eq!(parse_output("$ ls\n"), json!({"text": "$ ls"}));
        assert_eq!(parse_output(""), json!([]));
    }
}
