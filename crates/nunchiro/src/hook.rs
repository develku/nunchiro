//! Bounded hook bridge. Journal before delivery; stdout is only an explicit user decision, or (V2.5-39, ticket 187,
//! needs 154 item 12) the turn-end nudge's one context line on `UserPromptSubmit`, in exactly the shape
//! `board::nudge::is_context` allows, or (ticket 571) the room's ask deny on `PreToolUse` and its notice line on
//! `PostToolUse`, in exactly the shapes `room::is_hook_output` allows.
use nunchiro_core::{
    api::{Envelope, Reply, Request, Response},
    queue::journal::{self, Event},
};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};
/// `hold` (ticket 991 B3): the agent gave this hook a long timeout (Claude's permission hook), so the core may keep
/// it until the person answers the card (`queue::HOLD_MS`); the bounds here follow.
pub fn run(home: &Path, event: &str, hold: bool) -> Result<(), String> {
    let extra = Duration::from_millis(if hold {
        nunchiro_core::queue::HOLD_MS
    } else {
        0
    });
    // V2.5-48: the 1.8 s bound below counts from here; the core counts the nudge budget from it too.
    let started_ms = nunchiro_core::queue::now_ms();
    let (tx, rx) = mpsc::channel();
    let home = PathBuf::from(home);
    let event = event.to_string();
    thread::spawn(move || {
        let _ = tx.send(forward(&home, &event, started_ms, hold, extra));
    });
    match rx.recv_timeout(Duration::from_millis(1800) + extra) {
        Ok(Ok(Some(decision))) => println!(
            "{}",
            serde_json::to_string(&decision).map_err(|e| e.to_string())?
        ),
        Ok(Ok(None)) => {}
        Ok(Err(e)) => eprintln!("nunchiro hook: {e}"),
        Err(_) => eprintln!("nunchiro hook: bounded timeout; no decision"),
    }
    Ok(())
}
fn forward(
    home: &Path,
    event: &str,
    started_ms: u64,
    hold: bool,
    extra: Duration,
) -> Result<Option<serde_json::Value>, String> {
    let id = env::var("NUNCHIRO_SESSION").map_err(|e| e.to_string())?;
    let name = event.to_string();
    let mut payload = vec![];
    std::io::stdin()
        .take(65537)
        .read_to_end(&mut payload)
        .map_err(|e| e.to_string())?;
    if payload.len() > 65536 {
        return Err("hook payload exceeds 64 KiB".into());
    }
    let mut payload: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    if let Some(object) = payload.as_object_mut() {
        // Ours alone: an agent's own payload never asks for the hold.
        object.remove("nunchiro_hold");
        if hold {
            object.insert("nunchiro_hold".into(), true.into());
        }
    }
    let event = Event::new(id, event.into(), payload)?;
    // Q9 pin-J11-1: the journal is the replay copy for a core that is down; a full or failing one never keeps the
    // event from the live core.
    let path = journal::write(home, &event)
        .inspect_err(|e| eprintln!("nunchiro hook: journal write failed: {e}"))
        .ok();
    let decision = exchange(home, event, started_ms, extra)?;
    let decision = decision.filter(|d| match name.as_str() {
        "UserPromptSubmit" => nunchiro_core::board::nudge::is_context(d),
        "PreToolUse" | "PostToolUse" => nunchiro_core::room::is_hook_output(&name, d),
        _ => true,
    });
    if let Some(path) = path
        && let Err(error) = fs::remove_file(path)
    {
        eprintln!("nunchiro hook: journal cleanup failed: {error}");
    }
    Ok(decision)
}
/// One hook event to the core and the core's answer to it, if it gave one; the read waits `extra` longer for a hold.
fn exchange(
    home: &Path,
    event: Event,
    started_ms: u64,
    extra: Duration,
) -> Result<Option<serde_json::Value>, String> {
    // A missing/rotated session token never falls back to owner authority.
    let token = env::var("NUNCHIRO_TOKEN").map_err(|e| e.to_string())?;
    let mut stream = UnixStream::connect(home.join("core.sock")).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1600) + extra))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(100)))
        .map_err(|e| e.to_string())?;
    let envelope = Envelope {
        token,
        request: Request::Hook {
            id: event.session_id,
            event: event.event,
            payload: event.payload,
        },
    };
    let mut envelope = serde_json::to_value(&envelope).map_err(|e| e.to_string())?;
    envelope["started_ms"] = started_ms.into();
    let mut bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream.take(65536))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let response: Response = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    match response? {
        Reply::HookDecision { decision } => Ok(decision),
        Reply::Ack => Ok(None),
        _ => Err("unexpected hook reply".into()),
    }
}

/// Ticket 1002 lane 1, layer 2: the Home seat lock's PreToolUse hook (`nunchiro_core::home_lock::decide`). `args`:
/// `--mode <name>` (the start's effective mode; anything else is Ask). Decided here; only an outward tool
/// asks the core, to spend the owner's yes for this exact call. Fail closed (Fable check M1): a payload it cannot read
/// exits 2 and a failed run blocks (`onFailure`), so Claude refuses the call; a core that is down or says no refuses it.
/// The largest tool call the lock reads (a Write of a big file included); a larger one is refused, never judged in part.
const PAYLOAD_MAX: u64 = 16 << 20;
pub fn home_lock(home: &Path, args: &[String]) -> ! {
    use nunchiro_core::home_lock::{
        Decision, NO_CARD, NO_MCP_FLAG, decide_locked, hook_output, named, spend,
    };
    let mode = match args {
        [flag, mode, ..] if flag == "--mode" => named(mode),
        _ => named(""), // no mode named: Ask, the strictest
    };
    let no_mcp = args.iter().any(|a| a == NO_MCP_FLAG);
    let mut payload = vec![];
    let call = std::io::stdin()
        .take(PAYLOAD_MAX + 1)
        .read_to_end(&mut payload)
        .ok()
        .filter(|n| *n as u64 <= PAYLOAD_MAX)
        .and_then(|_| serde_json::from_slice::<serde_json::Value>(&payload).ok());
    let Some((tool, input)) = call.and_then(|v| {
        let tool = v.get("tool_name")?.as_str()?.to_string();
        Some((tool, v.get("tool_input").cloned().unwrap_or_default()))
    }) else {
        eprintln!("Home seat lock: this tool call could not be read, so it is refused");
        std::process::exit(2);
    };
    let out = match decide_locked(&tool, &input, mode, home, no_mcp) {
        Decision::Mode => None,
        Decision::Allow(why) => Some(hook_output("allow", why)),
        Decision::Ask(why) => Some(hook_output("ask", why)),
        Decision::Deny(why) => Some(hook_output("deny", why)),
        Decision::Spend => Some(
            match env::var("NUNCHIRO_TOKEN")
                .map_err(|e| e.to_string())
                .and_then(|token| spend(&home.join("core.sock"), &token, &tool, &input))
            {
                Ok(_card) => hook_output(
                    "allow",
                    "Home seat: the owner said yes to this exact call on its Outbox card",
                ),
                Err(e) => {
                    eprintln!("Home seat lock: {e}");
                    hook_output("deny", NO_CARD)
                }
            },
        ),
    };
    if let Some(out) = out {
        println!("{out}");
    }
    std::process::exit(0);
}

/// Ticket 1130 S1: every Claude session's own PreToolUse hook (`nunchiro_core::outward`): an outward call asks, in
/// every permission mode, decided here without the core (a core that is down never opens it). `--home-lock`: a locked
/// Home seat, whose lock hook gates its connector calls by the Outbox card; only shell publish commands ask here. A
/// payload it cannot read asks too. Ticket 1149, `--codex`: every Codex session's, where the same call waits for the
/// owner's card (`codex_card`) and a payload it cannot read is refused. Ticket 1151: an outward call the card would
/// not show whole (`shown_whole`) is refused for Claude too, not asked; a call that is not outward is not looked at.
pub fn outward(home: &Path, args: &[String]) -> ! {
    use nunchiro_core::{home_lock::hook_output, outward::kind};
    let locked = args.iter().any(|a| a == "--home-lock");
    let codex = args.iter().any(|a| a == "--codex");
    let mut payload = vec![];
    let call = std::io::stdin()
        .take(PAYLOAD_MAX + 1)
        .read_to_end(&mut payload)
        .ok()
        .filter(|n| *n as u64 <= PAYLOAD_MAX)
        .and_then(|_| serde_json::from_slice::<serde_json::Value>(&payload).ok());
    let out = match call
        .as_ref()
        .and_then(|v| Some((v.get("tool_name")?.as_str()?, v)))
    {
        None if codex => Some(hook_output(
            "deny",
            "Nunchiro could not read this tool call, so it is refused",
        )),
        None => Some(hook_output(
            "ask",
            "Nunchiro could not read this tool call, so it asks",
        )),
        Some((tool, v)) => kind(
            tool,
            v.get("tool_input").unwrap_or(&serde_json::Value::Null),
        )
        .filter(|k| !(locked && k.mcp()))
        .and_then(|k| match codex {
            true => codex_card(home, v, k),
            false if shown_whole(v) => Some(hook_output("ask", k.reason())),
            false => Some(hook_output(
                "deny",
                &not_shown(k, "it has a field named like a secret"),
            )),
        }),
    };
    if let Some(out) = out {
        println!("{out}");
    }
    std::process::exit(0);
}

/// Tickets 1149 round 2 and 1151: the owner never allows what the card does not show. The card's text is the call's
/// input as the hook event carries it, and `Event::new` leaves out every field named like a secret (at any depth),
/// while the agent would run the call with them. False too when no event can be made of the call.
fn shown_whole(call: &serde_json::Value) -> bool {
    Event::new(String::new(), String::new(), call.clone())
        .is_ok_and(|e| e.payload["tool_input"] == call["tool_input"])
}
/// What the agent is told when its outward call is refused for that (`why`); a field's name and value are not repeated.
fn not_shown(kind: nunchiro_core::outward::Kind, why: &str) -> String {
    format!(
        "{}: this call cannot be shown whole on Nunchiro's card ({why}), so the user was not asked and it did not run",
        kind.reason().split(':').next().unwrap_or_default()
    )
}

/// Ticket 1149: Codex 0.161 has no "ask" for a PreToolUse hook: only "deny" (or exit 2) stops the tool, and a hook that
/// answers anything else, fails or times out lets it run (probe 2026-11-26, docs/cli.md). So the hook asks itself: the
/// call goes to the core as a held permission request (`--hold`'s path), the owner answers its card, and everything
/// but the owner's allow is a deny: a deny, no window to ask, no answer in `HOLD_MS`, no core, no token, any error.
/// `None` (no output): the owner allowed it and Codex runs the tool.
fn codex_card(
    home: &Path,
    call: &serde_json::Value,
    kind: nunchiro_core::outward::Kind,
) -> Option<serde_json::Value> {
    use nunchiro_core::{home_lock::hook_output, queue};
    let head = kind.reason().split(':').next().unwrap_or_default();
    let mut payload = call.clone();
    payload["nunchiro_hold"] = true.into();
    let large = payload.to_string().len() > 65536;
    let event = env::var("NUNCHIRO_SESSION")
        .map_err(|e| e.to_string())
        .and_then(|id| Event::new(id, "PermissionRequest".into(), payload));
    // Round 2: a call too large for a card, or with a field the event drops (`shown_whole`), is refused, not asked.
    if large || !shown_whole(call) {
        let why = "it is over 64 KiB, or has a field named like a secret";
        return Some(hook_output("deny", &not_shown(kind, why)));
    }
    let asked = event.and_then(|event| {
        let extra = Duration::from_millis(queue::HOLD_MS);
        exchange(home, event, queue::now_ms(), extra)
    });
    let decision = match &asked {
        Ok(Some(d)) => &d["hookSpecificOutput"]["decision"],
        Ok(None) => &serde_json::Value::Null,
        Err(e) => {
            eprintln!("nunchiro hook: {e}");
            &serde_json::Value::Null
        }
    };
    if decision["behavior"] == "allow" {
        return None;
    }
    // The owner's own deny carries their words (or the plain "do not retry"); anything else names why nothing ran.
    let unanswered = format!(
        "{head}: Nunchiro asks the user before every outward action and got no yes, so this did not run. Tell the user; they answer in Nunchiro"
    );
    let why = match decision["behavior"] == "deny" {
        true => decision["message"].as_str().unwrap_or(queue::DENY_PLAIN),
        false => &unanswered,
    };
    Some(hook_output("deny", why))
}

/// Ticket 1036: Claude Code's status line command in a Nunchiro session. Claude pipes it JSON with `rate_limits`
/// (`five_hour`, `seven_day`: `used_percentage`, `resets_at`); only `rate_limits` goes to the core, as a `StatusLine`
/// hook of this session (its token), for the usage bar. The user's own status line command (project local, project,
/// then their Claude settings, as Claude Code layers them) runs with the same input and its output is the line, so
/// the user's status line is unchanged. The core is waited on at most `STATUS_WAIT`; it never blocks the line.
const STATUS_WAIT: Duration = Duration::from_millis(500);
pub fn statusline(home: &Path) {
    let mut input = vec![];
    if std::io::stdin()
        .take(1 << 20)
        .read_to_end(&mut input)
        .is_err()
    {
        return;
    }
    let (tx, rx) = mpsc::channel();
    if let Some(payload) = forwarded(&input) {
        let home = home.to_path_buf();
        thread::spawn(move || {
            let _ = tx.send(tell(&home, payload));
        });
    }
    if let Some(command) = own_status_line() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(std::process::Stdio::piped())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&input);
            }
            let _ = child.wait();
        }
    }
    let _ = rx.recv_timeout(STATUS_WAIT);
}
/// What of the status line JSON goes to the core: `rate_limits` (ticket 1036) and `context_window` (ticket 1048, the
/// session's real window for the Context widget), each only when it is an object; None when neither is.
fn forwarded(input: &[u8]) -> Option<serde_json::Value> {
    let v = serde_json::from_slice::<serde_json::Value>(input).ok()?;
    let out: serde_json::Map<_, _> = ["rate_limits", "context_window"]
        .into_iter()
        .filter(|k| v[*k].is_object())
        .map(|k| (k.to_string(), v[k].clone()))
        .collect();
    (!out.is_empty()).then_some(out.into())
}
fn tell(home: &Path, payload: serde_json::Value) -> Result<(), String> {
    let id = env::var("NUNCHIRO_SESSION").map_err(|e| e.to_string())?;
    let token = env::var("NUNCHIRO_TOKEN").map_err(|e| e.to_string())?;
    let mut stream = UnixStream::connect(home.join("core.sock")).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(STATUS_WAIT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(STATUS_WAIT))
        .map_err(|e| e.to_string())?;
    let envelope = Envelope {
        token,
        request: Request::Hook {
            id,
            event: "StatusLine".into(),
            payload,
        },
    };
    let mut bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream.take(65536))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    Ok(())
}
/// The status line command the user set, read as Claude Code layers settings: the folder's
/// `.claude/settings.local.json`, then `.claude/settings.json`, then the account's (`CLAUDE_CONFIG_DIR`) or
/// `~/.claude/settings.json`. Ours (in the session's `--settings` file) is never one of these.
fn own_status_line() -> Option<String> {
    let user = env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")));
    let files = [
        Some(PathBuf::from(".claude/settings.local.json")),
        Some(PathBuf::from(".claude/settings.json")),
        user.map(|u| u.join("settings.json")),
    ];
    files.into_iter().flatten().find_map(|f| {
        let v: serde_json::Value = serde_json::from_slice(&fs::read(f).ok()?).ok()?;
        let command = v["statusLine"]["command"].as_str()?.trim().to_string();
        // A line that names this command again would run itself.
        (!command.is_empty() && !command.contains("hook statusline")).then_some(command)
    })
}

#[cfg(test)]
mod tests {
    use super::forwarded;
    use serde_json::json;
    /// Ticket 1048: the status line's `context_window` goes to the core beside `rate_limits`; without it, the payload is
    /// what ticket 1036 sent.
    #[test]
    fn t1048_statusline_forwards_context_window() {
        let limits = json!({"five_hour": {"used_percentage": 12.0, "resets_at": 1}});
        let window = json!({"context_window_size": 1_000_000, "used_percentage": 36});
        let both = json!({"model": {"id": "x"}, "rate_limits": limits, "context_window": window});
        assert_eq!(
            forwarded(both.to_string().as_bytes()),
            Some(json!({"rate_limits": limits, "context_window": window}))
        );
        let old = json!({"model": {"id": "x"}, "rate_limits": limits});
        assert_eq!(
            forwarded(old.to_string().as_bytes()),
            Some(json!({"rate_limits": limits}))
        );
        let only = json!({"context_window": window, "rate_limits": null});
        assert_eq!(
            forwarded(only.to_string().as_bytes()),
            Some(json!({"context_window": window}))
        );
        assert_eq!(forwarded(br#"{"model":{"id":"x"}}"#), None);
        assert_eq!(forwarded(b"not json"), None);
    }
}
