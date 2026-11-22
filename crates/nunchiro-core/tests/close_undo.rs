//! V2-6d: the two-phase close of a stopped or done session through a real `serve`: the Undo is the owner's and the
//! window's only, and a core that ends inside the 10 s window leaves the close finished on its next start.
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

// V2-6d acceptance 4: a session token is refused the Undo (and the close stays pending); the owner's token undoes it.
#[test]
fn undo_op_owner_only() {
    let home = home::short("cu-own");
    let _core = home::spawn_serve(&home, &[]);
    let id = ended(&home);
    let agent = shell(&home, "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat").id;
    let mut token = String::new();
    wait("session printed no token", || {
        let Ok(Reply::Output { data, .. }) = call(
            &home,
            Request::Read {
                id: agent.clone(),
                after: 0,
            },
        ) else {
            return false;
        };
        let text = String::from_utf8_lossy(&data).into_owned();
        text.lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            .map(|t| token = t.trim().to_string())
            .is_some()
    });
    call(&home, Request::Close { id: id.clone() }).unwrap();
    assert_eq!(
        raw(&home, &token, json!({"op":"close_undo","id":id})),
        json!({"Err":"operation not granted"})
    );
    assert!(rows(&home).iter().all(|s| s.id != id));
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let undone = raw(&home, owner.trim(), json!({"op":"close_undo","id":id}));
    assert_eq!(undone["Ok"]["type"], "ack", "{undone}");
    assert!(rows(&home).iter().any(|s| s.id == id));
}

// V2-6d acceptance 5: a core that dies inside the window (no Stop, no tick after the close) leaves the close done on
// its next start: no row, no record, no file of the session. Chosen over bringing the row back, because the row was
// already gone from the user's view and a crash must not resurrect what the user closed.
#[test]
fn restart_during_window_finishes_close() {
    let home = home::short("cu-rst");
    let mut core = home::spawn_serve(&home, &[]);
    let id = ended(&home);
    // A hooks file as an agent session leaves one; the shell itself writes none.
    fs::write(home.join(format!("hooks-{id}.json")), "{}").unwrap();
    assert!(!files_of(&home, &id).is_empty());
    call(&home, Request::Close { id: id.clone() }).unwrap();
    let _ = core.child.kill(); // a crash: no Stop reaches it
    core.stop();
    let _core = home::spawn_serve(&home, &[]);
    assert!(rows(&home).iter().all(|s| s.id != id));
    assert!(
        !fs::read_to_string(home.join("sessions.json"))
            .unwrap()
            .contains(&id)
    );
    assert_eq!(files_of(&home, &id), Vec::<PathBuf>::new());
    let undone = call(&home, Request::CloseUndo { id: id.clone() });
    assert_eq!(undone.unwrap_err(), "this close can no longer be undone");
}
