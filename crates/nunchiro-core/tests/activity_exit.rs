//! The saved activity time of a streaming session moves at most every 10 s; a core that exits cleanly (`exit`, and the
//! `ExitIfIdle` that serve update, restart and rollback send) writes each session's exact time first, so the next
//! core reads where the session really was.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// A fake Claude that prints a line every 20 ms for about 4 s, marks `streamed-<id>`, then waits for `stop-agent`.
const STREAM: &str = "i=0; while [ $i -lt 200 ]; do printf 'line %d\\r\\n' $i; sleep 0.02; i=$((i+1)); done\n\
     : > \"streamed-$NUNCHIRO_SESSION\"\n\
     i=0; while [ ! -f stop-agent ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n";

fn core(home: &Path) -> home::ServeGuard {
    let path = format!("{}:/usr/bin:/bin", home.display());
    let (codex, config) = (home.join("codex-home"), home.join("claude-home"));
    home::spawn_serve(
        home,
        &[
            ("PATH", &path),
            ("CODEX_HOME", codex.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
            ("SHELL", "/bin/sh"),
        ],
    )
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < until, "timed out: {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_clean_exit_saves_the_streamed_activity_time() {
    let home = home::short("activity-exit");
    let claude = format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\n{STREAM}",
        home::FAKE_INPUT_RAW
    );
    fs::write(home.join("claude"), claude).unwrap();
    fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let mut first = core(&home);
    let session = match call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: home.clone(),
                worktree: false,
                label: "t".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    wait("streamed", || {
        home.join(format!("streamed-{}", session.id)).is_file()
    });
    thread::sleep(Duration::from_millis(500)); // the tick (50 ms) has observed the last lines
    let Ok(Reply::Snapshot { sessions, .. }) = call(&home, Request::Snapshot) else {
        panic!("snapshot")
    };
    let shown = sessions
        .iter()
        .find(|s| s.id == session.id)
        .unwrap()
        .attention
        .last_activity;
    let _ = call(&home, Request::Exit);
    wait("core exit", || first.child.try_wait().unwrap().is_some());
    first.stop(); // gone already; hands the home on to the next core
    let queue: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
    let saved = queue["sessions"][&session.id]["attention"]["last_activity"]
        .as_u64()
        .unwrap();
    assert!(
        saved >= shown,
        "saved {saved} is older than the {shown} the core showed before its exit"
    );
    // The agent outlived its core; the next core reattaches it, and its guard stops both and removes the home.
    fs::write(home.join("stop-agent"), "").unwrap();
    drop(core(&home));
}
