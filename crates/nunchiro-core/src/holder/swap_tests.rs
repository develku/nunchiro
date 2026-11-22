//! Ticket 379: the swap an app update does (`exit_if_idle`, then a next core on the same home) keeps a running session.
use crate::{api::*, sessions::Sessions};
use std::{
    fs,
    time::{Duration, Instant},
};

fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < until, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn output(core: &mut Sessions, id: &str) -> String {
    match core.handle(Request::Read {
        id: id.into(),
        after: 0,
    }) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        other => panic!("{other:?}"),
    }
}

fn session(core: &mut Sessions, id: &str) -> Session {
    match core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
        _ => panic!(),
    }
}

#[test]
fn a_running_session_survives_the_core_swap() {
    // Under the system temp dir: holder sockets bind under this home, and `.scratch` paths can pass `sun_path`.
    let home = std::env::temp_dir().join(format!("ns-swap-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let typed = home.join("typed");
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: "fixture".into(),
            args: [
                "/bin/sh",
                "-c",
                r#"printf 'before\n'; exec /bin/cat > "$0""#,
                typed.to_str().unwrap(),
            ]
            .map(String::from)
            .to_vec(),
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let started = core.start(&launch).unwrap();
    launch.committed = true;
    wait("agent ready", || {
        output(&mut core, &started.id).contains("before")
    });

    let reply = core.handle(Request::ExitIfIdle {
        holder_floor: super::frame::MIN_COMPATIBLE,
    });
    assert!(matches!(reply, Ok(Reply::Ack)), "{reply:?}");
    drop(core);

    let mut core = Sessions::open(&home).unwrap();
    let back = session(&mut core, &started.id);
    assert_eq!(back.state, SessionState::Running);
    assert_eq!(back.pid, started.pid, "the same agent, not a new one");
    assert!(output(&mut core, &started.id).contains("before"));
    core.handle(Request::SendText {
        id: started.id.clone(),
        text: "after\r".into(),
        seen: vec![],
        composer: false,
    })
    .unwrap();
    wait("input reaches the agent", || {
        fs::read_to_string(&typed).is_ok_and(|t| t.contains("after"))
    });
    core.stop().unwrap();
    fs::remove_dir_all(&home).unwrap();
}
