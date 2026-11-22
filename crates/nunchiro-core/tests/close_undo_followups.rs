//! V2-6d follow-up (ticket 92): what the id-addressed operations do to a close-pending session, through a real `serve`.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn shell(home: &Path, script: &str) -> Session {
    match call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.to_path_buf(),
                worktree: false,
                label: String::new(),
                args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        other => panic!("{other:?}"),
    }
}
fn rows(home: &Path) -> Vec<Session> {
    match call(home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions,
        other => panic!("{other:?}"),
    }
}
fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}
/// A shell that has ended and whose scrollback file the core has written.
fn ended(home: &Path) -> String {
    let id = shell(home, "printf hello").id;
    wait("the shell never ended", || {
        rows(home)
            .iter()
            .any(|s| s.id == id && s.state != SessionState::Running)
    });
    wait("no scrollback file", || {
        home.join("scrollback").join(&id).exists()
    });
    id
}
#[allow(dead_code)]
fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}
/// Every path under `dir` whose name holds `id`.
#[allow(dead_code)]
fn files_of(dir: &Path, id: &str) -> Vec<PathBuf> {
    let mut found = vec![];
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().contains(id) {
            found.push(path.clone());
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            found.extend(files_of(&path, id));
        }
    }
    found
}

// There is no id-based Resume operation: a resume is a `Start` carrying the agent's conversation id, and an agent-less
// shell has none. So the pending row is checked through every operation that names its id (the row is out of
// `entries`, so each says not found), and a `Start` that names the id as its `resume` starts an unrelated shell. Undo
// then still brings the same row back. Green on the base: this pins the behaviour, no code changed.
#[test]
fn resume_during_pending_close_refused() {
    let home = home::short("cu-res");
    let _core = home::spawn_serve(&home, &[]);
    let id = ended(&home);
    let before = rows(&home).into_iter().find(|s| s.id == id).unwrap();
    call(&home, Request::Close { id: id.clone() }).unwrap();
    for request in [
        Request::Read {
            id: id.clone(),
            after: 0,
        },
        Request::SendText {
            id: id.clone(),
            text: "x".into(),
            composer: false,
            seen: vec![],
        },
        Request::Label {
            id: id.clone(),
            label: "x".into(),
        },
    ] {
        let error = call(&home, request).unwrap_err();
        assert!(error.contains("not found"), "{error}");
    }
    let resumed = call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.clone(),
                worktree: false,
                label: String::new(),
                args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
                model: None,
                effort: None,
                resume: Some(id.clone()),
            },
        },
    );
    let Ok(Reply::Started { session: fresh }) = resumed else {
        panic!("{resumed:?}")
    };
    assert_ne!(fresh.id, id, "a new session, never the pending row");
    assert!(rows(&home).iter().all(|s| s.id != id));
    assert!(matches!(
        call(&home, Request::CloseUndo { id: id.clone() }),
        Ok(Reply::Ack)
    ));
    let after = rows(&home).into_iter().find(|s| s.id == id).unwrap();
    assert_eq!(
        serde_json::to_value(&after).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
}

// ticket-103: a conversation resumed inside the Undo window must not come back as a second row with the same
// `agent_session_id`. Undo is refused (Resume stays untouched), and the pending close then ends as usual.
#[test]
fn resume_during_window_then_undo_no_duplicate_session_id() {
    use std::os::unix::fs::PermissionsExt;
    let home = home::short("cu-dup");
    let bin = home.join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        bin.join("claude"),
        "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nif [ -f \"$NUNCHIRO_HOME/keep\" ]; then exec cat; fi\nprintf hello\n",
    )
    .unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", bin.display());
    // Ticket 286: the agent's wrapper leaves this shell; the test quits it to end the run.
    let _core = home::spawn_serve(&home, &[("PATH", &path), ("SHELL", "/bin/sh")]);
    let start = |resume: Option<String>| StartSession {
        account: None,
        kind: AgentKind::Claude,
        project: home.clone(),
        worktree: false,
        label: String::new(),
        args: vec![],
        model: None,
        effort: None,
        resume,
    };
    let Ok(Reply::Started { session: first }) = call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: start(None),
        },
    ) else {
        panic!("start failed")
    };
    let id = first.id;
    let conversation = first.agent_session_id.unwrap();
    wait("the agent never ended", || {
        let _ = call(
            &home,
            Request::SendText {
                id: id.clone(),
                text: "exit\r".into(),
                composer: false,
                seen: vec![],
            },
        );
        thread::sleep(Duration::from_millis(1500));
        rows(&home)
            .iter()
            .any(|s| s.id == id && s.state != SessionState::Running)
    });
    wait("no scrollback file", || {
        home.join("scrollback").join(&id).exists()
    });
    call(&home, Request::Close { id: id.clone() }).unwrap();
    fs::write(home.join("keep"), "").unwrap();
    let Ok(Reply::Started { session: resumed }) = call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: start(Some(conversation.clone())),
        },
    ) else {
        panic!("resume failed")
    };
    assert_ne!(resumed.id, id);
    let error = call(&home, Request::CloseUndo { id: id.clone() }).unwrap_err();
    assert_eq!(
        error,
        "this session was resumed meanwhile; it can no longer be undone"
    );
    let holding = || {
        rows(&home)
            .iter()
            .filter(|s| s.agent_session_id.as_deref() == Some(conversation.as_str()))
            .count()
    };
    assert_eq!(holding(), 1);
    // The refused Undo leaves the window to end as usual: the closed row's files go.
    let until = Instant::now() + Duration::from_secs(30);
    // (An agent's `artifacts/<id>` folder is never removed by a close, so it is not a sign of the window.)
    let left = || {
        let mut found = files_of(&home, &id);
        found.retain(|p| !p.starts_with(home.join("artifacts")));
        found
    };
    while !left().is_empty() {
        assert!(
            Instant::now() < until,
            "the pending close never ended: {:?}",
            left()
        );
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(holding(), 1);
    assert!(rows(&home).iter().all(|s| s.id != id));
}
