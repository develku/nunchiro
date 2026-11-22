//! V2.5-87 (ticket 301): a session that ended shows no waiting decision, and an echoed terminal focus report never
//! reaches a decision's text.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    queue::{Answer, Decision, Kind},
    server::call,
    waiting::screen::Screen,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// Claude's folder-trust prompt, with the focus-in/out reports a tty echoes (`^[[I`, `^[[O`) and the raw ones. It
/// exits 1 a second after any key (Deny sends Esc; the prompt stays drawn meanwhile, as Claude's does) and 0 once `go`
/// exists.
const CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
printf '\033[2J\033[H Do you trust this folder?\r\n \342\235\257 1. Yes, I trust this folder^[[I\r\n   2. No, exit\r\n\r\n Enter to confirm \302\267 Esc to cancel\r\n^[[I\033[I^[[O\033[O\r\n'
while :; do
  [ -f go ] && exit 0
  if IFS= read -r -t 1 -n 1 k; then sleep 1; exit 1; fi
done
"#;
/// Another session's permission prompt; prints `Done <line>` once a key line reaches it.
const CODEX: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi
printf '\033[2J\033[HDo you want to proceed?\r\n1. Yes\r\n2. No\r\n'
read x
printf '\033[2J\033[HDone %s' "$x"
sleep 30
"#;

fn core(tag: &str) -> home::ServeGuard {
    let home = home::short(tag);
    install(&home);
    serve(&home)
}
fn install(home: &Path) {
    for (name, body) in [("claude", CLAUDE), ("codex", CODEX)] {
        fs::write(home.join(name), body).unwrap();
        fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
    }
}
fn serve(home: &Path) -> home::ServeGuard {
    let path = format!("{}:/usr/bin:/bin", home.display());
    let (claude, codex) = (home.join("claude-home"), home.join("codex-home"));
    home::spawn_serve(
        home,
        &[
            ("PATH", path.as_str()),
            ("CLAUDE_CONFIG_DIR", claude.to_str().unwrap()),
            ("CODEX_HOME", codex.to_str().unwrap()),
            ("SHELL", "/bin/sh"), // ticket 286: the shell an ended agent leaves
        ],
    )
}
fn start(home: &Path, kind: AgentKind) -> Session {
    let Reply::Started { session } = call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: home.to_path_buf(),
                worktree: false,
                label: "t".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    session
}
fn session(home: &Path, id: &str) -> Session {
    let Reply::Snapshot { sessions, .. } = call(home, Request::Snapshot).unwrap() else {
        panic!()
    };
    sessions.into_iter().find(|s| s.id == id).unwrap()
}
fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn pending(home: &Path, id: &str) -> Decision {
    let mut found = None;
    until("a pending decision", || {
        found = session(home, id).pending.into_iter().next();
        found.is_some()
    });
    found.unwrap()
}
fn output(home: &Path, id: &str) -> String {
    let Reply::Output { data, .. } = call(
        home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    )
    .unwrap() else {
        panic!()
    };
    String::from_utf8_lossy(&data).into()
}
/// The ended session holds nothing waiting: no item, not waiting, and a state the tree reads as ended.
fn assert_ended_clear(home: &Path, id: &str) {
    let s = session(home, id);
    assert_ne!(s.state, SessionState::Running);
    assert!(
        s.pending.is_empty(),
        "an ended session still shows {:?}",
        s.pending
    );
    assert!(!s.attention.waiting);
}
fn ended(home: &Path, id: &str) {
    until("the session to end", || {
        // Ticket 286: the agent's wrapper leaves a shell; quitting it ends the session.
        let _ = call(
            home,
            Request::SendText {
                id: id.into(),
                text: "exit\r".into(),
                composer: false,
                seen: vec![],
            },
        );
        thread::sleep(Duration::from_millis(1500));
        session(home, id).state != SessionState::Running
    });
}

#[test]
fn session_exit_clears_its_waiting_decisions() {
    let core = core("sd1");
    let a = start(&core.home, AgentKind::Claude);
    let item = pending(&core.home, &a.id);
    assert_eq!(item.kind, Kind::Dialog);
    fs::write(core.home.join("go"), "").unwrap();
    ended(&core.home, &a.id);
    assert_ended_clear(&core.home, &a.id);
    // A closed decision is never answered later.
    assert!(
        call(
            &core.home,
            Request::Answer {
                item: item.id,
                answer: Answer::AllowOnce,
                confirmed: true
            }
        )
        .is_err()
    );
}

#[test]
fn denied_trust_prompt_returns_to_exited() {
    let core = core("sd2");
    let a = start(&core.home, AgentKind::Claude);
    let item = pending(&core.home, &a.id);
    call(
        &core.home,
        Request::Answer {
            item: item.id,
            answer: Answer::Deny,
            confirmed: false,
        },
    )
    .unwrap();
    ended(&core.home, &a.id);
    assert_eq!(session(&core.home, &a.id).state, SessionState::Exited);
    assert_ended_clear(&core.home, &a.id);
    // Still clear a while later (the real-app card stayed 30 s+): ticks raise nothing for an ended session.
    thread::sleep(Duration::from_secs(2));
    assert_ended_clear(&core.home, &a.id);
}

/// Another session's live prompt: its item keeps its id and stays answerable, and no key reaches its PTY.
fn other_session_after_exit(tag: &str) -> (home::ServeGuard, Session, Decision) {
    let (core, b, before, _) = other_session_exit(tag);
    (core, b, before)
}

/// As `other_session_after_exit`, plus the other session's raw output taken just before the exit (a stray key written
/// by the exit tick is echoed in the same tick that flips the state, so a baseline taken after the exit would hold it).
fn other_session_exit(tag: &str) -> (home::ServeGuard, Session, Decision, (Vec<u8>, u64)) {
    let core = core(tag);
    let b = start(&core.home, AgentKind::Codex);
    let before = pending(&core.home, &b.id);
    let a = start(&core.home, AgentKind::Claude);
    pending(&core.home, &a.id);
    let baseline = raw_output(&core.home, &b.id);
    fs::write(core.home.join("go"), "").unwrap();
    ended(&core.home, &a.id);
    assert_ended_clear(&core.home, &a.id);
    (core, b, before, baseline)
}

#[test]
fn exit_keeps_other_sessions_decisions() {
    let (core, b, before) = other_session_after_exit("sd3");
    let after = session(&core.home, &b.id);
    assert_eq!(after.state, SessionState::Running);
    assert_eq!(after.pending, vec![before.clone()]);
    assert!(after.pending[0].actionable);
    call(
        &core.home,
        Request::Answer {
            item: before.id,
            answer: Answer::AllowOnce,
            confirmed: true,
        },
    )
    .unwrap();
    until("the answer to reach the other session", || {
        output(&core.home, &b.id).contains("Done 1")
    });
}

/// Everything the session printed so far, as raw bytes, with the end offset the core reports.
fn raw_output(home: &Path, id: &str) -> (Vec<u8>, u64) {
    let Reply::Output { data, end, .. } = call(
        home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    )
    .unwrap() else {
        panic!()
    };
    (data, end)
}

/// A key (even one with no newline, which the stub's `read` would swallow unseen) written to the other session would be
/// echoed by its tty, so its output would grow: the output stays byte-for-byte what it was for the whole window.
#[test]
fn exit_clear_sends_no_keys() {
    let (core, b, _, (before, end)) = other_session_exit("sd4");
    assert!(!before.is_empty(), "the prompt should be drawn");
    let window = Instant::now() + Duration::from_millis(500);
    while Instant::now() < window {
        let (now, now_end) = raw_output(&core.home, &b.id);
        assert_eq!(
            now_end, end,
            "the other session's output grew after the exit"
        );
        assert_eq!(
            now, before,
            "the other session's output changed after the exit"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!String::from_utf8_lossy(&before).contains("Done"));
}

#[test]
fn restored_decision_of_exited_session_closed() {
    let mut core = core("sd5");
    let a = start(&core.home, AgentKind::Claude);
    pending(&core.home, &a.id);
    core.stop();
    let core = serve(&core.home);
    assert_ended_clear(&core.home, &a.id);
}

#[test]
fn prompt_text_drops_focus_in_escape() {
    // As the tty echoes them (`^[[I` focus-in, `^[[O` focus-out) and raw.
    let mut screen = Screen::new(80, 8);
    screen.feed(
        " Do you trust this folder?\r\n \u{276f} 1. Yes, I trust this folder^[[I\r\n   2. No, exit^[[O\r\n^[[I\x1b[I^[[O\x1b[O ^ and ^[[\u{e9}\r\n"
            .as_bytes(),
    );
    let found = screen.detect(AgentKind::Claude).unwrap();
    assert_eq!(found.kind, Kind::Dialog);
    assert_eq!(
        found.text.trim_end(),
        " Do you trust this folder?\n \u{276f} 1. Yes, I trust this folder\n   2. No, exit\n ^ and ^[[\u{e9}"
    );
    let labels: Vec<_> = found.choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Yes, I trust this folder", "No, exit"]);
}

/// Round 2 (review MUST-1): only the focus reports go; any other caret text a command carries stays on the card as
/// written, so the card never hides what will run.
#[test]
fn permission_text_keeps_other_caret_sequences() {
    for command in [
        "grep -E '^[[:alpha:]]+' f",
        "echo ok ^[[;./9;#A",
        "printf '^[[1;2A^[[Ix'",
    ] {
        let mut screen = Screen::new(80, 8);
        screen.feed(
            format!("Would you like to run the following command?\r\n  $ {command}\r\n1. Yes\r\n2. No\r\n").as_bytes(),
        );
        let found = screen.detect(AgentKind::Codex).unwrap();
        assert_eq!(found.kind, Kind::Permission);
        let shown = found.text.lines().nth(1).unwrap();
        let expected = format!("  $ {}", command.replace("^[[I", ""));
        assert_eq!(shown, expected, "the card changed the command");
    }
}
