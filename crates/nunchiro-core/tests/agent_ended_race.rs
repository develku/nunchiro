//! Ticket 488: an agent that prints its last lines and exits at once gets its why-it-ended card from those lines, even
//! when the agent-ended marker (a file, outside the terminal stream) reaches the core before that output does.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, problems::Case, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// A fake Claude that ends in the worst order: it writes its own end marker, waits until the core has answered it
/// (so the core has read the marker before any last line exists), then prints the signed-out line, marks
/// `done-<id>` and exits 0.
const LATE_LINE: &str = "m=\"agent-ended-$NUNCHIRO_SESSION\"\n\
     echo 0 > \"$m\"\n\
     i=0; while [ \"$(cat \"$m\")\" != 'seen 0' ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n\
     printf 'Please run /login\\r\\n'\n\
     : > \"done-$NUNCHIRO_SESSION\"\n\
     exit 0\n";

/// A fake Claude as a pre-488 wrapper looks to the core: once `go` exists it writes its end marker and keeps running
/// (until `exit` exists, or 30 s), so no end mark ever reaches the terminal.
const NO_MARK: &str = "i=0; while [ ! -f go ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n\
     echo 0 > \"agent-ended-$NUNCHIRO_SESSION\"\n\
     i=0; while [ ! -f exit ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n";

/// A core on a fresh home whose `claude` runs `tail` after its token is written.
fn core(tag: &str, tail: &str) -> home::ServeGuard {
    let home = home::short(tag);
    let claude = format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\n\
         printf %s \"$NUNCHIRO_TOKEN\" > \"token-$NUNCHIRO_SESSION\"\n\
         printf 'starting up\\r\\n'\n{tail}",
        home::FAKE_INPUT_RAW
    );
    fs::write(home.join("claude"), claude).unwrap();
    fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.display());
    let (codex, config) = (home.join("codex-home"), home.join("claude-home"));
    home::spawn_serve(
        &home,
        &[
            ("PATH", &path),
            ("CODEX_HOME", codex.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
            ("SHELL", "/bin/sh"),
        ],
    )
}

fn start(home: &Path) -> Session {
    match call(
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
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    }
}

fn sessions(home: &Path) -> Vec<Session> {
    let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
        panic!("snapshot")
    };
    sessions
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < until, "timed out: {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn last_line_after_the_end_marker_still_makes_the_card() {
    let core = core("aer", LATE_LINE);
    let s = start(&core.home);
    // The wrapper writes its own marker once the agent has exited; the core raised the card (or not) by then, within
    // its bound for the agent's last output.
    let marker = core.home.join(format!("agent-ended-{}", s.id));
    let done = core.home.join(format!("done-{}", s.id));
    wait("the agent ends", || {
        done.exists() && fs::read_to_string(&marker).unwrap_or_default() == "0\n"
    });
    thread::sleep(Duration::from_millis(500));
    let problem = sessions(&core.home)
        .into_iter()
        .find(|x| x.id == s.id)
        .unwrap()
        .problem;
    // Releases the wrapper, which waits for an answer the core gave before the wrapper asked.
    let _ = fs::write(&marker, "seen 0\n");
    assert_eq!(problem.map(|p| p.case), Some(Case::LoggedOut));
}

/// Review r1 of 488: no request waits for an ended agent's last output. Eight agents end together and none prints the
/// end mark; a wait under the registry lock would hold every request for up to 8 x 300 ms.
#[test]
fn agents_ending_without_the_mark_do_not_stall_requests() {
    let core = core("aes", NO_MARK);
    let ids: Vec<String> = (0..8).map(|_| start(&core.home).id).collect();
    wait("the agents run", || {
        ids.iter()
            .all(|id| core.home.join(format!("token-{id}")).exists())
    });
    fs::write(core.home.join("go"), "").unwrap();
    let mut slowest = Duration::ZERO;
    wait("the agents end", || {
        let asked = Instant::now();
        let all = sessions(&core.home);
        slowest = slowest.max(asked.elapsed());
        ids.iter()
            .all(|id| all.iter().any(|s| &s.id == id && s.agent_ended))
    });
    // Watched a little longer, past every card's 300 ms wait.
    let until = Instant::now() + Duration::from_millis(600);
    while Instant::now() < until {
        let asked = Instant::now();
        sessions(&core.home);
        slowest = slowest.max(asked.elapsed());
        thread::sleep(Duration::from_millis(10));
    }
    fs::write(core.home.join("exit"), "").unwrap();
    // Eight 300 ms waits in one pass (2.4 s) always fail this bound; the margin is for a loaded gate.
    assert!(
        slowest < Duration::from_secs(1),
        "a snapshot took {slowest:?}"
    );
}
