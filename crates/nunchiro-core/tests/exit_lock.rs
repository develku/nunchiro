// Ticket 300, end to end: an agent that exits with a long send queue must not hold the registry lock (and the accept
// loop, where the tick runs) for one save per canceled send; other sessions' hooks and registry calls keep answering.
// What the exit pass does under the lock itself is counted, not timed, in
// `sessions::tests::exit_does_not_block_other_sessions_lock_hold`; here the exit tick also runs its own writes (queue
// close, the exited row's save), so the bound is looser.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

fn start(home: &Path, label: &str) -> Session {
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
                label: label.into(),
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

fn session(home: &Path, id: &str) -> Session {
    let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
        panic!("snapshot")
    };
    sessions.into_iter().find(|s| s.id == id).unwrap()
}

/// A request with a session's own token, as its hook bridge sends one (no owner peer check, which walks processes).
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
        thread::sleep(Duration::from_millis(10));
    }
}

/// Sends queued behind the exiting agent: as many as its send log keeps (`delivery::SEND_LOG_LIMIT`, 256), so each is
/// still there to count as canceled.
const SENDS: usize = 250;
/// What the exit may add to the slowest call of another session, at least (see `bound` below).
const ADDED: Duration = Duration::from_millis(1000);

#[test]
fn exit_with_pending_sends_keeps_the_core_answering() {
    let home = home::short("exl");
    // No composer and no finished turn on screen, so every send queues; the agent exits once its `exit-<id>` file
    // appears (or after 30 s, so no agent outlives a failed run).
    fs::write(
        home.join("claude"),
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\n\
             printf %s \"$NUNCHIRO_TOKEN\" > \"token-$NUNCHIRO_SESSION\"\n\
             printf 'starting up\\r\\n'\n\
             i=0; while [ ! -f \"exit-$NUNCHIRO_SESSION\" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done\n",
            home::FAKE_INPUT_RAW
        ),
    )
    .unwrap();
    fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.display());
    let (codex, claude) = (home.join("codex-home"), home.join("claude-home"));
    let _core = home::spawn_serve(
        &home,
        &[
            ("PATH", &path),
            ("CODEX_HOME", codex.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", claude.to_str().unwrap()),
        ],
    );
    let exiting = start(&home, "exiting");
    let other = start(&home, "other");
    let token = home.join(format!("token-{}", other.id));
    wait("the other agent runs", || {
        fs::metadata(&token).is_ok_and(|m| m.len() > 0)
    });
    let token = fs::read_to_string(token).unwrap();
    for n in 0..SENDS {
        match call(
            &home,
            Request::AgentSend {
                id: exiting.id.clone(),
                text: format!("queued {n}"),
            },
        ) {
            Ok(Reply::Delivery { send }) => assert_eq!(send.status, "queued"),
            other => panic!("{other:?}"),
        }
    }

    // Probe the other session's hook and a registry call back to back, from before the exit until after the cancel.
    // Each call costs tens of ms on its own in a debug build on a loaded host (off the lock), so the bound is on what
    // the exit adds: the slowest call after it, less the slowest one before it. One save per canceled send added
    // 500-900 ms with 50 sends (10 to 18 ms a save); one save adds under 140 ms at load average 26.
    // Ticket 991: with 50 sends and a 300 ms bound the two cases were too close for a loaded host (302 ms seen at load
    // average 30 beside a whole test run, with nothing wrong). The queue is now `SENDS` long, so the blocked case
    // costs seconds on an idle host (and more on a loaded one, as each save slows down with it), and the bound is
    // `ADDED`: the good case added 0 to 33 ms here at load average 14, the blocked one 2.5 s at its fastest.
    let stop = Arc::new(AtomicBool::new(false));
    let probe = {
        let (home, id, stop) = (home.clone(), other.id.clone(), stop.clone());
        let token = token.clone();
        thread::spawn(move || {
            let mut calls = vec![];
            while !stop.load(Ordering::SeqCst) {
                let t = Instant::now();
                let reply = call_as(
                    &home,
                    &token,
                    Request::Hook {
                        id: id.clone(),
                        event: "Notification".into(),
                        payload: json!({"message": "probe"}),
                    },
                );
                assert!(reply.is_ok(), "{reply:?}");
                calls.push(("hook", t, t.elapsed()));
                let t = Instant::now();
                let reply = call_as(&home, &token, Request::AgentGet { id: id.clone() });
                assert!(matches!(reply, Ok(Reply::Agent { .. })), "{reply:?}");
                calls.push(("registry", t, t.elapsed()));
            }
            calls
        })
    };
    thread::sleep(Duration::from_millis(500));
    let exit = Instant::now();
    fs::write(home.join(format!("exit-{}", exiting.id)), "").unwrap();
    wait("every queued send canceled", || {
        let s = session(&home, &exiting.id);
        s.send_queue.is_empty()
            && s.send_log.iter().filter(|s| s.status == "canceled").count() == SENDS
    });
    thread::sleep(Duration::from_millis(200));
    stop.store(true, Ordering::SeqCst);
    let calls = probe.join().unwrap();
    // W27: the exit tick itself saves a few times under the lock (the exited row, the cancel, the row again: 3 saves,
    // one tick of 315 ms beside a disk-flush loop), and each save is an F_FULLFSYNC whose time follows the disk, not the
    // CPU. A registry call has no save, so beside builds' disk writes it went 3 ms before the exit and 1.29 s during it,
    // with nothing wrong. So the bound scales with what one save costs in this run: the median hook (one save each),
    // at a tenth of what one save per canceled send would hold the lock for. That case stays 10 times over the bound
    // at any disk speed, and the good case's few saves 8 times under it; `ADDED` is the floor for a fast disk.
    let mut hooks: Vec<Duration> = calls
        .iter()
        .filter(|(k, _, _)| *k == "hook")
        .map(|(_, _, d)| *d)
        .collect();
    hooks.sort();
    let save = hooks[hooks.len() / 2];
    let bound = ADDED.max(save * (SENDS / 10) as u32);
    for kind in ["hook", "registry"] {
        let slowest = |before: bool| {
            calls
                .iter()
                .filter(|(k, t, d)| *k == kind && (*t + *d < exit) == before)
                .map(|(_, _, d)| *d)
                .max()
                .unwrap_or_else(|| {
                    panic!(
                        "no {kind} call finished {}",
                        ["after", "before"][before as usize]
                    )
                })
        };
        let (base, during) = (slowest(true), slowest(false));
        assert!(
            during.saturating_sub(base) < bound,
            "{kind}: slowest {during:?} during the exit, {base:?} before it, bound {bound:?} (median hook {save:?})"
        );
    }
}
