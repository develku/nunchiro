//! Ticket 286 item 1 (needs 207, herdr's pane): quitting the agent leaves the pane on a shell in the same folder, one
//! session still Running. The shell takes the user's own keys only: agent sends, queued sends, decisions and session
//! tokens end with the agent, as they did at its exit.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// A fake Claude: prints its token to `token-<id>`, then `say` if the test wrote one, then waits until `exit-<id>`
/// exists and exits with the code in it (or after 30 s, so no agent outlives a failed run). A Ctrl+C ends it: the trap,
/// as `sh` alone keeps looping when the signal lands just after a `sleep` exited normally (it judges by the child).
fn fake_claude() -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\ntrap 'exit 130' INT\n{}\n\
         printf %s \"$NUNCHIRO_TOKEN\" > \"token-$NUNCHIRO_SESSION\"\n\
         printf 'starting up\\r\\n'\n\
         [ -f say ] && cat say\n\
         i=0; while [ ! -f \"exit-$NUNCHIRO_SESSION\" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n\
         exit $(cat \"exit-$NUNCHIRO_SESSION\" 2>/dev/null || echo 0)\n",
        home::FAKE_INPUT_RAW
    )
}

/// A core on a fresh home with the fake Claude on PATH (or none, when `claude` is false) and `/bin/sh` as the
/// user's shell. `CLAUDE_CODE_SESSION_ID` stands for the launching session's identity the launch path removes.
/// `LC_CTYPE` (and `LC_ALL`, which would override it) is the UTF-8 one the app gives its core (v1a-33, `core_command`): without it, as in a nightly started
/// with no locale, `/bin/sh`'s line editor reads the bytes of a typed `❯` as meta keys.
fn core(tag: &str, claude: bool) -> home::ServeGuard {
    let home = home::short(tag);
    if claude {
        fs::write(home.join("claude"), fake_claude()).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = format!("{}:/usr/bin:/bin", home.display());
    let (codex, config) = (home.join("codex-home"), home.join("claude-home"));
    home::spawn_serve(
        &home,
        &[
            ("PATH", &path),
            ("CODEX_HOME", codex.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
            ("SHELL", "/bin/sh"),
            ("LC_CTYPE", "en_US.UTF-8"),
            // LC_ALL beats LC_CTYPE: a caller that exports `LC_ALL=C` (a script's sort, a check) would undo the line above.
            ("LC_ALL", "en_US.UTF-8"),
            ("CLAUDE_CODE_SESSION_ID", "launching-session"),
        ],
    )
}

fn start_with(home: &Path, args: Vec<String>) -> Response {
    call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: home.to_path_buf(),
                worktree: false,
                label: "t".into(),
                args,
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
}

/// Starts a Claude session and waits until its agent runs (its token is written).
fn start(home: &Path) -> (Session, String) {
    let session = match start_with(home, vec![]) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    let token = home.join(format!("token-{}", session.id));
    wait("the agent runs", || {
        fs::metadata(&token).is_ok_and(|m| m.len() > 0)
    });
    (session.clone(), fs::read_to_string(token).unwrap())
}

fn session(home: &Path, id: &str) -> Session {
    let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
        panic!("snapshot")
    };
    sessions.into_iter().find(|s| s.id == id).unwrap()
}

fn screen(home: &Path, id: &str) -> String {
    match call(
        home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    ) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        other => panic!("{other:?}"),
    }
}

/// A request with a session's own token, as its CLI sends one (no owner peer check).
fn call_as(home: &Path, token: &str, request: Request) -> Response {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let line = json!({"token": token, "request": request}).to_string() + "\n";
    s.write_all(line.as_bytes()).unwrap();
    let mut reply = String::new();
    BufReader::new(s).read_line(&mut reply).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < until, "timed out: {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// The user's own terminal keys (the terminal view's `send_text`).
fn type_keys(home: &Path, id: &str, text: &str) -> Response {
    call(
        home,
        Request::SendText {
            id: id.into(),
            text: text.into(),
            seen: vec![],
            composer: false,
        },
    )
}

/// Ends the fake agent with `code` and waits until a shell runs the user's line in the session's folder.
fn quit_agent(home: &Path, id: &str, code: &str) {
    // Ticket 484: written whole, then renamed in. The fake leaves at the file's first sight and `exit $(cat ...)` of
    // a file `fs::write` has created but not yet filled is a clean exit 0, which raises no card.
    let exit = home.join(format!("exit-{id}"));
    fs::write(exit.with_extension("tmp"), code).unwrap();
    fs::rename(exit.with_extension("tmp"), exit).unwrap();
    shell_answers(home, id);
}

/// Waits until a shell in the session's folder runs a line the user types (typed again until one answers).
fn shell_answers(home: &Path, id: &str) {
    let folder = home.display().to_string();
    let until = Instant::now() + Duration::from_secs(20);
    let mut n = 0;
    loop {
        n += 1;
        let marker = format!("shell-{}", n * 1000 + 42);
        // The arithmetic is done by the shell: the echoed line itself never contains the answer.
        let _ = type_keys(home, id, &format!("echo shell-$(({n}*1000+42)) $PWD\r"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if screen(home, id).contains(&format!("{marker} {folder}")) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            Instant::now() < until,
            "no shell answered after the agent quit"
        );
    }
}

#[test]
fn agent_exit_leaves_shell() {
    let core = core("aes", true);
    let (s, _) = start(&core.home);
    quit_agent(&core.home, &s.id, "0");
    let now = session(&core.home, &s.id);
    assert_eq!(
        now.state,
        SessionState::Running,
        "one session, still running"
    );
    // Environment: the shell keeps the launch path's identity cleaning (the launching session's variables are gone,
    // this session's are set).
    type_keys(
        &core.home,
        &s.id,
        "echo \"env-[$CLAUDE_CODE_SESSION_ID]-[$NUNCHIRO_SESSION]\"\r",
    )
    .unwrap();
    let expect = format!("env-[]-[{}]", s.id);
    wait("the shell shows its environment", || {
        screen(&core.home, &s.id).contains(&expect)
    });
}

// Ticket 286 item 1 r5 (card C-20261106-06): "done" follows the agent's end. The record the window reads says so and
// the board card is Done, while the shell it left is still Running for the user's keys.
#[test]
fn agent_end_reads_done_while_the_shell_runs() {
    let core = core("aed", true);
    let (s, _) = start(&core.home);
    let card = |home: &Path| {
        let Ok(Reply::BoardSnapshot { board }) = call(home, Request::BoardSnapshot) else {
            panic!("board snapshot")
        };
        board
            .cards
            .into_iter()
            .find(|c| c["session_id"] == s.id.as_str())
            .unwrap()["state"]
            .clone()
    };
    assert!(!session(&core.home, &s.id).agent_ended);
    assert_ne!(card(&core.home), "done", "a live agent's card");
    quit_agent(&core.home, &s.id, "0");
    let now = session(&core.home, &s.id);
    assert_eq!(now.state, SessionState::Running, "the shell still runs");
    assert!(now.agent_ended, "the record says the agent ended");
    assert_eq!(card(&core.home), "done", "the board card is Done");
    // Lane w59: the run's end is stamped when the agent ends, for History's run length.
    assert!(now.ended_at >= now.started_at && now.ended_at.is_some());
}

#[test]
fn ctrl_c_that_ends_the_agent_leaves_the_shell() {
    let core = core("aec", true);
    let (s, _) = start(&core.home);
    call(
        &core.home,
        Request::SendKeys {
            id: s.id.clone(),
            keys: vec!["ctrl+c".into()],
            seen: vec![],
            composer: false,
        },
    )
    .unwrap();
    shell_answers(&core.home, &s.id);
    assert_eq!(session(&core.home, &s.id).state, SessionState::Running);
}

#[test]
fn quitting_the_shell_after_the_agent_ends_the_session() {
    let core = core("aeq", true);
    let (s, _) = start(&core.home);
    assert_eq!(
        session(&core.home, &s.id).ended_at,
        None,
        "a run still going"
    );
    quit_agent(&core.home, &s.id, "0");
    let ended = session(&core.home, &s.id).ended_at;
    type_keys(&core.home, &s.id, "exit\r").unwrap();
    wait("the session ends", || {
        session(&core.home, &s.id).state == SessionState::Exited
    });
    // Lane w59: the shell's later exit keeps the time the agent's run ended.
    assert_eq!(session(&core.home, &s.id).ended_at, ended);
    assert!(ended.is_some());
}

#[test]
fn agent_send_refused_after_agent_ended() {
    let core = core("aer", true);
    let (ended, ended_token) = start(&core.home);
    let (other, other_token) = start(&core.home);
    let send = |token: &str| {
        call_as(
            &core.home,
            token,
            Request::AgentSend {
                id: ended.id.clone(),
                text: "rm -rf important".into(),
            },
        )
    };
    // Before: another agent's send queues (the fake has no composer), as for any running agent.
    assert!(
        matches!(send(&other_token), Ok(Reply::Delivery { .. })),
        "a send to a running agent is taken"
    );
    quit_agent(&core.home, &ended.id, "0");
    let refused = send(&other_token).unwrap_err();
    assert!(refused.contains("agent is not running"), "{refused}");
    // The owner's prompt (the delivery path) is refused the same way; only the user's own keys reach the shell.
    let owner = call(
        &core.home,
        Request::AgentPrompt {
            id: ended.id.clone(),
            text: "echo owner-$((40+2))".into(),
        },
    )
    .unwrap_err();
    assert!(owner.contains("agent is not running"), "{owner}");
    // The ended agent's own token acts for no one now: a process it left behind cannot send as it.
    let gone = call_as(
        &core.home,
        &ended_token,
        Request::AgentSend {
            id: other.id.clone(),
            text: "hi".into(),
        },
    )
    .unwrap_err();
    assert!(gone.contains("unauthorized"), "{gone}");
    let hook = call_as(
        &core.home,
        &ended_token,
        Request::Hook {
            id: ended.id.clone(),
            event: "Notification".into(),
            payload: json!({"message": "after the end"}),
        },
    );
    assert!(hook.is_err(), "{hook:?}");
    thread::sleep(Duration::from_millis(500));
    let text = screen(&core.home, &ended.id);
    assert!(!text.contains("rm -rf important"), "{text}");
    assert!(!text.contains("owner-42"), "{text}");
}

#[test]
fn queued_sends_cancelled_when_agent_ends() {
    let core = core("aeu", true);
    let (s, _) = start(&core.home);
    for n in 0..5 {
        match call(
            &core.home,
            Request::AgentSend {
                id: s.id.clone(),
                text: format!("queued-{n}"),
            },
        ) {
            Ok(Reply::Delivery { send }) => assert_eq!(send.status, "queued"),
            other => panic!("{other:?}"),
        }
    }
    quit_agent(&core.home, &s.id, "0");
    wait("all five canceled", || {
        let s = session(&core.home, &s.id);
        s.send_queue.is_empty() && s.send_log.iter().filter(|s| s.status == "canceled").count() == 5
    });
    thread::sleep(Duration::from_millis(500));
    let text = screen(&core.home, &s.id);
    assert!(
        !text.contains("queued-"),
        "a canceled send was typed: {text}"
    );
    assert_eq!(session(&core.home, &s.id).state, SessionState::Running);
}

/// Claude's folder-trust prompt, as `stale_decision.rs` draws it: the observer queues it as a decision.
const TRUST: &str = "\x1b[2J\x1b[H Do you trust this folder?\r\n \u{276f} 1. Yes, I trust this folder\r\n   2. No, exit\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n";

#[test]
fn decisions_close_when_agent_ends() {
    let core = core("aed", true);
    fs::write(core.home.join("say"), TRUST).unwrap();
    let (s, _) = start(&core.home);
    wait("the prompt is a decision", || {
        !session(&core.home, &s.id).pending.is_empty()
    });
    let item = session(&core.home, &s.id).pending[0].id.clone();
    quit_agent(&core.home, &s.id, "0");
    let now = session(&core.home, &s.id);
    assert!(now.pending.is_empty(), "{:?}", now.pending);
    assert!(!now.attention.waiting, "{:?}", now.attention);
    // An answer to it now would type its keys into the shell: refused.
    let answer = call(
        &core.home,
        Request::Answer {
            item,
            answer: nunchiro_core::queue::Answer::Choose { index: 0 },
            confirmed: false,
        },
    );
    assert!(answer.is_err(), "{answer:?}");
    // The closed item does not hold the user's own keys: Esc (Stop's gate) and a line both reach the shell.
    call(
        &core.home,
        Request::SendKeys {
            id: s.id.clone(),
            keys: vec!["esc".into()],
            seen: vec![],
            composer: false,
        },
    )
    .unwrap();
    shell_answers(&core.home, &s.id);
}

#[test]
fn why_it_ended_card_on_agent_exit() {
    let core = core("aew", true);
    fs::write(core.home.join("say"), "Please run /login\r\n").unwrap();
    let (s, _) = start(&core.home);
    // Ticket 484: the card is read from the agent's last screen when it ends, so the agent ends only once its sign-in
    // line is on that screen; the token file says only that the agent started.
    wait("the agent's sign-in line is on its screen", || {
        screen(&core.home, &s.id).contains("Please run /login")
    });
    assert!(session(&core.home, &s.id).problem.is_none());
    quit_agent(&core.home, &s.id, "1");
    let now = session(&core.home, &s.id);
    let problem = now.problem.clone().unwrap_or_else(|| {
        panic!(
            "no why-it-ended card: ended {} state {:?}\n{}",
            now.agent_ended,
            now.state,
            screen(&core.home, &s.id)
        )
    });
    assert_eq!(
        problem.case,
        nunchiro_core::problems::Case::LoggedOut,
        "{problem:?}"
    );
    assert_eq!(now.state, SessionState::Running);
    // Quitting the shell ends the session with the agent's card, not one read from the shell's screen.
    type_keys(&core.home, &s.id, "exit\r").unwrap();
    wait("the session ends", || {
        session(&core.home, &s.id).state == SessionState::Exited
    });
    let after = session(&core.home, &s.id).problem.map(|p| p.case);
    assert_eq!(after, Some(nunchiro_core::problems::Case::LoggedOut));
}

#[test]
fn shell_prompt_is_not_a_composer() {
    let core = core("aep", true);
    let (s, _) = start(&core.home);
    quit_agent(&core.home, &s.id, "0");
    // Claude's own composer glyph as the shell's prompt, then a line that looks like Claude's choice list.
    type_keys(
        &core.home,
        &s.id,
        "PS1='\u{276f} '; printf '\\342\\235\\257 1. Yes\\r\\n  2. No\\r\\n'\r",
    )
    .unwrap();
    wait("the prompt is drawn", || {
        screen(&core.home, &s.id).matches('\u{276f}').count() >= 3
    });
    thread::sleep(Duration::from_millis(500));
    let now = session(&core.home, &s.id);
    assert!(
        now.pending.is_empty(),
        "a shell line became a decision: {:?}",
        now.pending
    );
    assert!(
        !now.attention.waiting && !now.attention.working,
        "{:?}",
        now.attention
    );
    assert!(now.permission_mode.is_none());
    let send = call(
        &core.home,
        Request::AgentPrompt {
            id: s.id.clone(),
            text: "echo typed-$((3+4))".into(),
        },
    );
    assert!(send.unwrap_err().contains("agent is not running"));
    thread::sleep(Duration::from_millis(500));
    assert!(!screen(&core.home, &s.id).contains("typed-7"));
}

/// A Start with no agent binary fails as before (a Failed row with its "not installed" card, never a shell). The Codex
/// model switch's restart, which skips the version probe, is pinned in `picker_switch.rs` ("did not restart").
#[test]
fn missing_agent_binary_fails_start() {
    let core = core("aem", false);
    let session = match start_with(&core.home, vec![]) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!(session.state, SessionState::Failed, "{session:?}");
    assert_eq!(
        session.problem.map(|p| p.case),
        Some(nunchiro_core::problems::Case::NotInstalled)
    );
    thread::sleep(Duration::from_millis(500));
    assert_ne!(
        session_state(&core.home, &session.id),
        SessionState::Running
    );
}

fn session_state(home: &Path, id: &str) -> SessionState {
    session(home, id).state
}

fn start_side(home: &Path, parent: &str) -> Response {
    start_with(
        home,
        vec![
            "--permission-mode".into(),
            "plan".into(),
            SIDE_CHAT_ARG.into(),
            parent.into(),
        ],
    )
}

#[test]
fn side_chat_starts_for_live_parent() {
    let core = core("asl", true);
    let (parent, _) = start(&core.home);
    match start_side(&core.home, &parent.id) {
        Ok(Reply::Started { session }) => assert_eq!(session.state, SessionState::Running),
        other => panic!("{other:?}"),
    }
}

/// Ticket 286 S3: the parent row stays Running on its shell, but its agent is gone, so no side chat starts from it.
#[test]
fn side_chat_refused_for_ended_parent() {
    let core = core("asr", true);
    let (parent, _) = start(&core.home);
    quit_agent(&core.home, &parent.id, "0");
    let refused = start_side(&core.home, &parent.id).unwrap_err();
    assert!(refused.contains("parent is not running"), "{refused}");
    let Ok(Reply::Snapshot { sessions, .. }) = call(&core.home, Request::Snapshot) else {
        panic!("snapshot")
    };
    assert!(!sessions.iter().any(|s| s.side_chat), "no side chat row");
}

#[test]
fn side_chat_not_wrapped() {
    let core = core("aes2", true);
    let (parent, _) = start(&core.home);
    let side = match start_side(&core.home, &parent.id) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert!(side.side_chat);
    wait("the side chat's agent runs", || {
        fs::metadata(core.home.join(format!("token-{}", side.id))).is_ok_and(|m| m.len() > 0)
    });
    fs::write(core.home.join(format!("exit-{}", side.id)), "0").unwrap();
    wait("the side chat ends with its agent", || {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&core.home, Request::Snapshot) else {
            panic!("snapshot")
        };
        sessions
            .iter()
            .find(|s| s.id == side.id)
            .is_none_or(|s| s.state != SessionState::Running)
    });
}

fn send_text(home: &Path, id: &str, text: &str, composer: bool) -> Response {
    call(
        home,
        Request::SendText {
            id: id.into(),
            text: text.into(),
            seen: vec![],
            composer,
        },
    )
}

fn send_enter(home: &Path, id: &str, composer: bool) -> Response {
    call(
        home,
        Request::SendKeys {
            id: id.into(),
            keys: vec!["enter".into()],
            seen: vec![],
            composer,
        },
    )
}

/// Ticket 286 item 1, owner card C-20261106-03: after the agent ends, the chat composer never types into the shell it
/// left (a message sent just as the agent quits would run as a command). Its text and its Enter are refused with
/// `AGENT_ENDED` and write nothing.
#[test]
fn composer_refused_after_agent_exit() {
    let core = core("aek", true);
    let (s, _) = start(&core.home);
    quit_agent(&core.home, &s.id, "0");
    let text = send_text(&core.home, &s.id, "echo pinned-$((2+3))", true).unwrap_err();
    assert!(
        text.starts_with(nunchiro_core::delivery::AGENT_ENDED),
        "{text}"
    );
    let enter = send_enter(&core.home, &s.id, true).unwrap_err();
    assert!(
        enter.starts_with(nunchiro_core::delivery::AGENT_ENDED),
        "{enter}"
    );
    // A terminal line after the refusals: had the composer's text reached the shell, this Enter would run it too.
    type_keys(&core.home, &s.id, "echo after-$((1+1))\r").unwrap();
    wait("the terminal line ran", || {
        screen(&core.home, &s.id).contains("after-2")
    });
    assert!(!screen(&core.home, &s.id).contains("pinned-5"));
}

/// The other side of C-20261106-03: the terminal's own text and keys (`composer: false`) still reach the shell.
#[test]
fn terminal_input_reaches_shell_after_agent_exit() {
    let core = core("aet", true);
    let (s, _) = start(&core.home);
    quit_agent(&core.home, &s.id, "0");
    send_text(&core.home, &s.id, "echo term-$((3+4))", false).unwrap();
    send_enter(&core.home, &s.id, false).unwrap();
    wait("the shell ran the terminal line", || {
        screen(&core.home, &s.id).contains("term-7")
    });
}

// Ticket 286 item 1 r5, coordinator scope (owner question: ended workers must not pile up shells). A worker is a
// session another session started (`agent start`, the record's `parent`).
fn worker_session(label: &str, home: &Path) -> StartSession {
    StartSession {
        account: None,
        kind: AgentKind::Claude,
        project: home.to_path_buf(),
        worktree: false,
        label: label.into(),
        args: vec![],
        model: None,
        effort: None,
        resume: None,
    }
}

fn start_worker(home: &Path, lead_token: &str, label: &str) -> Response {
    call_as(
        home,
        lead_token,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: worker_session(label, home),
        },
    )
}

/// A worker started by the session whose token is `lead_token`, once its agent runs.
fn worker(home: &Path, lead_token: &str) -> Session {
    let session = match start_worker(home, lead_token, "worker") {
        Ok(Reply::Started { session }) => session,
        other => panic!("worker start: {other:?}"),
    };
    let token = home.join(format!("token-{}", session.id));
    wait("the worker's agent runs", || {
        fs::metadata(&token).is_ok_and(|m| m.len() > 0)
    });
    session
}

/// The session's state, or `None` once the snapshot no longer lists it.
fn listed_state(home: &Path, id: &str) -> Option<SessionState> {
    let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
        panic!("snapshot")
    };
    sessions.into_iter().find(|s| s.id == id).map(|s| s.state)
}

#[test]
fn finished_worker_closes_at_agent_end() {
    let core = core("aew", true);
    let (lead, lead_token) = start(&core.home);
    let w = worker(&core.home, &lead_token);
    assert_eq!(
        session(&core.home, &w.id).parent.as_deref(),
        Some(lead.id.as_str())
    );
    fs::write(core.home.join(format!("exit-{}", w.id)), "0").unwrap();
    // No shell is left; the row reads closed (or is gone).
    wait("the finished worker closes", || {
        matches!(
            listed_state(&core.home, &w.id),
            Some(SessionState::Closed) | None
        )
    });
    // A session the user started keeps its shell.
    assert_eq!(session(&core.home, &lead.id).state, SessionState::Running);
}

// Ticket 286 r6 (Opus review of round 5): a worker whose agent fails keeps its shell and its why-it-ended card; only
// a clean end closes it.
#[test]
fn failed_worker_keeps_its_card() {
    let core = core("aef", true);
    let (_, lead_token) = start(&core.home);
    let w = worker(&core.home, &lead_token);
    quit_agent(&core.home, &w.id, "3");
    let now = session(&core.home, &w.id);
    assert_eq!(
        now.state,
        SessionState::Running,
        "the failed worker is kept"
    );
    assert!(now.agent_ended);
    let problem = now.problem.expect("its why-it-ended card");
    assert!(
        problem.details.contains("exited with code 3"),
        "{problem:?}"
    );
}
