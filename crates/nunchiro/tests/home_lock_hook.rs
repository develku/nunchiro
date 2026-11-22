//! Ticket 1002 lane 1 (Fable review, round 2): `nunchiro hook home-lock` itself, as Claude runs it. It fails closed: a
//! payload it cannot read exits 2 (Claude refuses the call), an outward call with no token or a core that says no is
//! denied. The allow-once path through a real core is in nunchiro-core's tests/outbox.rs.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Output, Stdio},
};

const SEND: &str = "mcp__claude_ai_Gmail__send_message";

fn hook(home: &Path, token: Option<&str>, payload: &[u8]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_nunchiro"));
    cmd.args(["hook", "home-lock", "--mode", "full-access"])
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(t) = token {
        cmd.env("NUNCHIRO_TOKEN", t);
    }
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // A refused oversized payload may close the pipe before it is all written.
    let _ = stdin.write_all(payload);
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn decision(out: &Output) -> String {
    assert!(out.status.success(), "{out:?}");
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    v["hookSpecificOutput"]["permissionDecision"]
        .as_str()
        .unwrap()
        .into()
}

fn call(tool: &str) -> Vec<u8> {
    json!({"tool_name": tool, "tool_input": {"to": ["a@example.org"], "subject": "s", "body": "b"}})
        .to_string()
        .into_bytes()
}

#[test]
fn the_lock_hook_fails_closed() {
    let home = std::env::temp_dir().join(format!("nlh-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // Unreadable or over 16 MiB: exit 2, never judged in part.
    assert_eq!(hook(&home, None, b"not json").status.code(), Some(2));
    let big = format!(
        "{{\"tool_name\":\"Read\",\"tool_input\":{{\"x\":\"{}\"}}}}",
        "a".repeat((16 << 20) + 1)
    );
    assert_eq!(hook(&home, None, big.as_bytes()).status.code(), Some(2));
    // No token, no core: an outward call is denied.
    assert_eq!(decision(&hook(&home, None, &call(SEND))), "deny");
    assert_eq!(decision(&hook(&home, Some("t"), &call(SEND))), "deny");
    // A core that says no (or answers anything but the card id) is denied too.
    let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    let core = std::thread::spawn(move || {
        for reply in [json!({"Err": "no card"}), json!({"Ok": {"type": "ack"}})] {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["request"]["op"], "outbox_spend");
            assert_eq!(v["request"]["tool"], SEND);
            (&stream)
                .write_all(format!("{reply}\n").as_bytes())
                .unwrap();
        }
    });
    assert_eq!(decision(&hook(&home, Some("t"), &call(SEND))), "deny");
    assert_eq!(decision(&hook(&home, Some("t"), &call(SEND))), "deny");
    core.join().unwrap();
    // Not on the list, a write tool, or another server: denied without asking the core. A read in Full access: allowed.
    for tool in ["WebFetch", "mcp__claude_ai_Gmail__reply", "mcp__own__send"] {
        assert_eq!(decision(&hook(&home, None, &call(tool))), "deny", "{tool}");
    }
    assert_eq!(
        decision(&hook(
            &home,
            None,
            &call("mcp__claude_ai_Gmail__search_threads")
        )),
        "allow"
    );
    std::fs::remove_dir_all(home).unwrap();
}
