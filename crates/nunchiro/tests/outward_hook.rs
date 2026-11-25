//! Ticket 1130 S1: `nunchiro hook outward` itself, as Claude runs it in every session: an outward call asks with no
//! core and no token (a core that is down never opens it), other calls get no answer (the mode decides), a locked Home
//! seat leaves its connector calls to the Outbox card, and a payload it cannot read asks.
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn hook(args: &[&str], payload: &[u8]) -> Option<(String, String)> {
    let home = std::env::temp_dir().join(format!("noh-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["hook", "outward"])
        .args(args)
        .env("NUNCHIRO_HOME", &home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(payload);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    if out.stdout.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let inner = &v["hookSpecificOutput"];
    assert_eq!(inner["hookEventName"], "PreToolUse");
    Some((
        inner["permissionDecision"].as_str().unwrap().into(),
        inner["permissionDecisionReason"].as_str().unwrap().into(),
    ))
}

fn call(tool: &str, input: Value) -> Vec<u8> {
    json!({"tool_name": tool, "tool_input": input})
        .to_string()
        .into_bytes()
}

#[test]
fn t1130_outward_calls_ask_in_every_session() {
    let mail = call(
        "mcp__claude_ai_Gmail__send_message",
        json!({"to": ["a@example.org"], "body": "b"}),
    );
    let (decision, reason) = hook(&[], &mail).expect("a mail send asks");
    assert_eq!(decision, "ask");
    assert!(reason.starts_with("Send mail:"), "{reason}");
    let publish = call("Bash", json!({"command": "npm publish"}));
    assert_eq!(hook(&[], &publish).unwrap().0, "ask");
    // Round 2: Codex's passing payloads now ask (a comment's or a wrapper's dry run, npx, an aliased connector).
    for (tool, input) in [
        ("Bash", json!({"command": "npm publish # --dry-run"})),
        ("Bash", json!({"command": "sh -c 'npm publish' --dry-run"})),
        ("Bash", json!({"command": "npx --yes npm@10 publish"})),
        ("Bash", json!({"command": "gh gist create -p=true note.md"})),
        ("Bash", json!({"command": "grep x | npm publish"})),
        ("Bash", json!({"command": "yarn publish --dry-run"})),
        ("mcp__gmail__reply", json!({"body": "b"})),
        ("mcp__calendar__create_event", json!({"title": "t"})),
    ] {
        assert_eq!(
            hook(&[], &call(tool, input.clone())).unwrap().0,
            "ask",
            "{input}"
        );
    }
    for (tool, input) in [
        ("Bash", json!({"command": "git push origin main"})),
        ("Bash", json!({"command": "gh pr create --fill"})),
        ("Bash", json!({"command": "grep -rn publish src"})),
        (
            "Bash",
            json!({"command": "git commit -m 'fix artifact publish card'"}),
        ),
        (
            "mcp__claude_ai_Gmail__search_threads",
            json!({"query": "x"}),
        ),
    ] {
        assert_eq!(hook(&[], &call(tool, input)), None, "{tool}");
    }
    // A locked Home seat: the Outbox card gates its mail; its shell publish still asks.
    assert_eq!(hook(&["--home-lock"], &mail), None);
    assert_eq!(hook(&["--home-lock"], &publish).unwrap().0, "ask");
    assert_eq!(hook(&[], b"not json").unwrap().0, "ask");
}

/// Ticket 1149: as Codex runs it (`--codex`). Codex 0.161 has no "ask" and lets a tool run when its hook fails, so the
/// hook holds for the owner's card and denies unless the owner allowed: with no core to raise a card (no token, no
/// socket) an outward call is denied, and so is a payload it cannot read. Other calls get no answer. The card itself
/// is in nunchiro-core's tests/waiting_core.rs.
#[test]
fn t1149_codex_outward_calls_are_denied_without_a_card() {
    let publish = call("Bash", json!({"command": "npm publish"}));
    let (decision, reason) = hook(&["--codex"], &publish).expect("a publish is decided");
    assert_eq!(decision, "deny");
    assert!(reason.starts_with("Publish:"), "{reason}");
    let mail = call("mcp__gmail__send_message", json!({"body": "b"}));
    assert_eq!(hook(&["--codex"], &mail).unwrap().0, "deny");
    let push = call("Bash", json!({"command": "git push origin main"}));
    assert_eq!(hook(&["--codex"], &push), None);
    assert_eq!(hook(&["--codex"], b"not json").unwrap().0, "deny");
}

/// Ticket 1151: the owner never allows what the card does not show. The card's text is the call's input as the hook
/// event carries it, and the event leaves out fields named like a secret, at any depth; Claude would run the call with
/// them. So an outward Claude call with such a field is refused, as a Codex one is (ticket 1149), and its reason never
/// repeats the value. A call that is not outward is still not answered, with or without such a field.
#[test]
fn t1151_claude_outward_call_with_a_field_the_card_hides_is_refused() {
    for input in [
        json!({"text": "t", "token": "s3cr3t-value"}),
        json!({"text": "t", "headers": {"Authorization": "s3cr3t-value"}}),
        json!({"text": "t", "to": [{"name": "a", "Password": "s3cr3t-value"}]}),
    ] {
        let post = call("mcp__slack__post_message", input.clone());
        let (decision, reason) = hook(&[], &post).expect("decided");
        assert_eq!(decision, "deny", "{input}");
        assert!(reason.starts_with("Send or post:"), "{reason}");
        assert!(reason.contains("named like a secret"), "{reason}");
        assert!(!reason.contains("s3cr3t-value"), "{reason}");
        // Codex's refusal (ticket 1149 round 2) is the same rule.
        let (decision, codex) = hook(&["--codex"], &post).expect("decided");
        assert_eq!(decision, "deny");
        assert!(codex.contains("named like a secret"), "{codex}");
    }
    let publish = call(
        "Bash",
        json!({"command": "npm publish", "auth": "s3cr3t-value"}),
    );
    assert_eq!(hook(&[], &publish).unwrap().0, "deny");
    // Unchanged: the same call without the field asks; a call that is not outward gets no answer; a locked Home seat's
    // connector call is the Outbox card's.
    let plain = call(
        "mcp__slack__post_message",
        json!({"text": "t", "author": "a"}),
    );
    assert_eq!(hook(&[], &plain).unwrap().0, "ask");
    for (tool, input) in [
        ("mcp__vault__get_item", json!({"token": "s3cr3t-value"})),
        ("Bash", json!({"command": "ls", "password": "s3cr3t-value"})),
    ] {
        assert_eq!(hook(&[], &call(tool, input)), None, "{tool}");
    }
    let locked = call("mcp__slack__post_message", json!({"token": "s3cr3t-value"}));
    assert_eq!(hook(&["--home-lock"], &locked), None);
}
