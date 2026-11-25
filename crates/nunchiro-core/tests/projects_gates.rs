//! V2.5-15: the project ops are the owner's and the window's alone. A session token, the browser role and a remote
//! forward each stay refused; the owner runs them (editor and folder paths stay inside the test's home).
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    time::Duration,
};

fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}

fn requests(home: &Path) -> [Value; 8] {
    let p = home.to_str().unwrap();
    [
        json!({"op":"project_create","name":"x"}),
        json!({"op":"open_in_editor","path":p}),
        json!({"op":"editor_apps"}),
        json!({"op":"project_icon_set","project":p,"data_b64":""}),
        json!({"op":"project_icon_get","project":p}),
        json!({"op":"project_clone","url":"https://h/a","parent":p}),
        json!({"op":"project_clone_state","job":"j"}),
        json!({"op":"project_clone_cancel","job":"j"}),
    ]
}

#[test]
fn project_ops_refuse_a_session_token() {
    let home = home::short("pj-tok");
    let _core = home::spawn_serve(&home, &[]);
    let started = call(
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
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap();
    let Reply::Started { session } = started else {
        panic!("{started:?}")
    };
    let until = std::time::Instant::now() + Duration::from_secs(10);
    let token = loop {
        if let Ok(Reply::Output { data, .. }) = call(
            &home,
            Request::Read {
                id: session.id.clone(),
                after: 0,
            },
        ) && let Some(t) = String::from_utf8_lossy(&data)
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t.trim().to_string()))
        {
            break t;
        }
        assert!(std::time::Instant::now() < until, "no token");
        std::thread::sleep(Duration::from_millis(20));
    };
    for request in requests(&home) {
        assert_eq!(
            raw(&home, &token, request.clone()),
            json!({"Err":"operation not granted"}),
            "{request}"
        );
    }
}

#[test]
fn open_in_editor_is_not_forwarded_to_a_machine() {
    let home = home::short("pj-fwd");
    let _core = home::spawn_serve(&home, &[]);
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    let forwarded = raw(
        &home,
        owner.trim(),
        json!({"op":"remote","machine":"nowhere","request":{"op":"open_in_editor","path":"/tmp"}}),
    );
    assert_eq!(
        forwarded["Err"],
        "operation is local owner-only; remote forwarding is not permitted"
    );
}

// Ticket 800: a test core records the argv it would hand to `open` and starts nothing. A fake `open` first on PATH
// marks a spawn, so the old behaviour fails here without any real app opening.
#[test]
fn a_test_core_records_open_in_editor_and_spawns_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let home = home::short("pj-rec");
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("open"), "#!/bin/sh\ntouch \"$0.ran\"\n").unwrap();
    std::fs::set_permissions(bin.join("open"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let _core = home::spawn_serve(&home, &[("PATH", &path)]);
    call(
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
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap();
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    let p = home.to_str().unwrap();
    assert_eq!(
        raw(&home, owner.trim(), json!({"op":"open_in_editor","path":p}))["Ok"]["type"],
        "ack"
    );
    assert_eq!(
        std::fs::read_to_string(home.join("opened.argv")).unwrap(),
        format!("open\n-t\n{p}\n")
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!bin.join("open.ran").exists(), "a real `open` ran");
}

// Ticket 1061: with worktrees_dir unset, a worktree under the old default root (<home>/worktrees/<project>/) that no
// session sits in still opens in the editor; only the new default root used to count.
#[test]
fn open_in_editor_accepts_a_legacy_root_worktree() {
    let home = home::short("pj-leg");
    let project = home::short("pj-legp");
    let _core = home::spawn_serve(&home, &[]);
    call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.clone(),
                worktree: false,
                label: String::new(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap();
    let wt = home
        .join("worktrees")
        .join(project.file_name().unwrap())
        .join("old");
    std::fs::create_dir_all(&wt).unwrap();
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    let p = wt.to_str().unwrap();
    let answer = raw(&home, owner.trim(), json!({"op":"open_in_editor","path":p}));
    assert_eq!(answer["Ok"]["type"], "ack", "{p}: {answer}");
}
