//! V2-1b: sessions after a core restart (reattach, restored waiting items, holders of other protocol versions).
use super::*;
use std::{
    io::{Read, Write},
    os::unix::{net::UnixListener, process::CommandExt},
    time::{Duration, Instant},
};

// Holder sockets bind under this home, so it is `ns-<tag>-<pid>-<n>` in the system temp dir (AGENTS.md storage
// exception), never the checkout's `.scratch/`, whose path may push `sun_path` past 103 bytes.
fn scratch(name: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("ns-ra-{name}-{}-0", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    fs::canonicalize(home).unwrap()
}
fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < until, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn shell(core: &mut Sessions, home: &Path, args: &[&str]) -> Session {
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.into(),
            worktree: false,
            label: "fixture".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    session
}
fn snapshot(core: &mut Sessions, id: &str) -> Session {
    match core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
        _ => panic!(),
    }
}
fn permission(core: &mut Sessions, id: &str, event: &str, command: &str) {
    core.handle(Request::Hook {
        id: id.into(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "nunchiro_event_id": event,
        }),
    })
    .unwrap();
    // As the server does while the hook process waits for its answer and a window is connected.
    core.queue.connect(queue::now_ms());
    assert!(core.queue.begin_hook(event, queue::now_ms()));
}

// Acceptance `stale_request_no_write` (spec V2-1 acceptance 6): the core crashes during request A; A is restored as
// "checking" and answering it writes nothing; A expires and request B replaces it; A's restored answer still writes
// nothing to the PTY and answers no hook (neither A's nor B's).
#[test]
fn stale_request_no_write() {
    let home = scratch("stale");
    let typed = home.join("typed");
    let mut core = Sessions::open(&home).unwrap();
    let session = shell(
        &mut core,
        &home,
        &[
            "/bin/sh",
            "-c",
            r#"printf 'ready\n'; exec /bin/cat > "$0""#,
            typed.to_str().unwrap(),
        ],
    );
    wait("agent ready", || {
        String::from_utf8_lossy(&core.entries[&session.id].pty.as_ref().unwrap().snapshot())
            .contains("ready")
    });
    permission(&mut core, &session.id, "event-a", "echo A");
    let a = snapshot(&mut core, &session.id).pending.remove(0);
    assert!(a.actionable && !a.reconciled);
    let agent = session.pid.unwrap();
    // The core lets go (a crash after its last save keeps the same file): the holder and agent run on.
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    let back = snapshot(&mut core, &session.id);
    assert_eq!(back.state, SessionState::Running);
    assert_eq!(back.pid, Some(agent), "the same agent, reattached");
    // A is restored: still waiting (counted), marked checking (not actionable, reconciled), and not answerable.
    assert_eq!(back.pending.len(), 1);
    assert!(back.attention.waiting);
    let restored = &back.pending[0];
    assert_eq!(restored.id, a.id);
    assert!(!restored.actionable && restored.reconciled);
    for answer in [queue::Answer::AllowOnce, queue::Answer::Deny] {
        assert!(
            core.handle(Request::Answer {
                item: a.id.clone(),
                answer,
                confirmed: false,
            })
            .is_err()
        );
    }
    // A expired (its hook returned to the agent's own prompt); request B replaces it.
    permission(&mut core, &session.id, "event-b", "echo B");
    let b = snapshot(&mut core, &session.id).pending;
    assert_eq!(b.len(), 1, "B replaces A: {b:?}");
    assert_ne!(b[0].id, a.id, "B is never answered through A's id");
    assert!(b[0].text.contains("echo B"));
    for answer in [queue::Answer::AllowOnce, queue::Answer::Deny] {
        assert!(
            core.handle(Request::Answer {
                item: a.id.clone(),
                answer,
                confirmed: false,
            })
            .is_err()
        );
    }
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fs::read(&typed).unwrap(), b"", "0 PTY writes");
    assert_eq!(
        core.queue.hook_response("event-a"),
        None,
        "0 hook responses"
    );
    assert_eq!(
        core.queue.hook_response("event-b"),
        None,
        "0 hook responses"
    );
    // B itself, proved by its live hook, is answerable once.
    core.handle(Request::Answer {
        item: b[0].id.clone(),
        answer: queue::Answer::Deny,
        confirmed: false,
    })
    .unwrap();
    assert!(core.queue.hook_response("event-b").is_some());
    core.handle(Request::Stop).unwrap();
    assert!(!crate::peer::running_since(agent, None));
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// The reattached session's scrollback and cursors carry on, and output written while no core ran is in it.
#[test]
fn reattach_keeps_scrollback_and_writes() {
    let home = scratch("ring");
    let mut core = Sessions::open(&home).unwrap();
    let session = shell(&mut core, &home, &["/bin/cat"]);
    core.handle(Request::SendText {
        id: session.id.clone(),
        text: "before\r".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    let text = |core: &Sessions| -> String {
        String::from_utf8_lossy(&core.entries[&session.id].pty.as_ref().unwrap().snapshot()).into()
    };
    // The terminal's echo and cat's own line.
    wait("before echoed", || {
        text(&core).matches("before").count() == 2
    });
    let end = core.entries[&session.id].pty.as_ref().unwrap().end();
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert!(text(&core).contains("before"), "{}", text(&core));
    assert_eq!(
        core.entries[&session.id].pty.as_ref().unwrap().end(),
        end,
        "same cursor"
    );
    core.handle(Request::SendText {
        id: session.id.clone(),
        text: "after\r".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    wait("after echoed", || text(&core).contains("after"));
    core.handle(Request::Close {
        id: session.id.clone(),
    })
    .unwrap();
    // Closed: its token hash is gone (revoked) and its agent ended.
    assert!(
        !fs::read_to_string(home.join("sessions.json"))
            .unwrap()
            .contains("token_sha256")
    );
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// The delivery record: a core restart with 4 running sessions writes 4 before and 4 back; a first start, with none
/// running before, writes no restart row.
#[test]
fn a_restart_with_four_sessions_records_four_before_and_four_after() {
    let home = scratch("record");
    let mut core = Sessions::open(&home).unwrap();
    assert!(
        crate::record::read(&home).restarts.is_empty(),
        "a first start is no restart"
    );
    for _ in 0..4 {
        shell(&mut core, &home, &["/bin/cat"]);
    }
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    let restarts = crate::record::read(&home).restarts;
    assert_eq!(restarts.len(), 1, "{restarts:?}");
    assert_eq!((restarts[0].before, restarts[0].after), (4, 4));
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

fn restarts(home: &Path) -> Vec<(usize, usize)> {
    crate::record::read(home)
        .restarts
        .iter()
        .map(|r| (r.before, r.after))
        .collect()
}
/// The delivery record: a session whose agent ended while the core ran was not running when the core went down.
#[test]
fn a_session_that_ended_earlier_is_not_counted_at_the_restart() {
    let home = scratch("record-ended");
    let mut core = Sessions::open(&home).unwrap();
    let ids: Vec<String> = (0..4)
        .map(|_| shell(&mut core, &home, &["/bin/cat"]).id)
        .collect();
    let pid = core.entries[&ids[0]].meta.pid.unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    wait("the agent's end seen", || {
        core.tick().unwrap();
        core.entries[&ids[0]].meta.state != SessionState::Running
    });
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(restarts(&home), vec![(3, 3)]);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}
/// The delivery record: a session lost at one restart is not lost again at the next. The core that lost it ended
/// before any save (a kill -9), so sessions.json still names it running.
#[test]
fn a_session_lost_once_is_not_counted_again() {
    let home = scratch("record-lost");
    let mut core = Sessions::open(&home).unwrap();
    let ids: Vec<String> = (0..4)
        .map(|_| shell(&mut core, &home, &["/bin/cat"]).id)
        .collect();
    core.leave().unwrap();
    drop(core);
    // Its holder ended while no core ran (as `a_holder_gone_while_no_core_ran_is_not_running` makes it).
    let mut store: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
    let socket = store["live"][&ids[0]]["holder"]["socket"]
        .as_str()
        .unwrap()
        .to_string();
    fs::remove_file(socket).unwrap();
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let pid = gone.id();
    let started = crate::peer::started(pid).unwrap_or(1);
    gone.wait().unwrap();
    store["live"][&ids[0]]["holder"]["pid"] = pid.into();
    store["live"][&ids[0]]["holder"]["started"] = started.into();
    let crashed = serde_json::to_vec(&store).unwrap();
    fs::write(home.join("sessions.json"), &crashed).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(restarts(&home), vec![(4, 3)]);
    core.leave().unwrap();
    drop(core);
    fs::write(home.join("sessions.json"), &crashed).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(restarts(&home), vec![(4, 3), (3, 3)]);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// Ticket 512 (505 review): where this run's output starts survives a core restart, so a resumed session's card
/// never reads the earlier run's end mark from its seed. The seed here is a stand-in: `run_start` set as a resume's
/// seed length sets it.
#[test]
fn reattach_keeps_run_start() {
    let home = scratch("runstart");
    let mut core = Sessions::open(&home).unwrap();
    let session = shell(&mut core, &home, &["/bin/cat"]);
    let seed = 7;
    core.entries
        .get_mut(&session.id)
        .unwrap()
        .pty
        .as_mut()
        .unwrap()
        .set_run_start(seed);
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(
        core.entries[&session.id].pty.as_ref().unwrap().run_start(),
        seed
    );
    // A reattached session stores it again for the next restart.
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(
        core.entries[&session.id].pty.as_ref().unwrap().run_start(),
        seed
    );
    core.handle(Request::Close {
        id: session.id.clone(),
    })
    .unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// A session past its start is still past it after a core restart, and after the next one: a start dialog's rows on
/// its screen (a transcript view the restart found standing) make no card. One still at its start stays there.
#[test]
fn reattach_keeps_a_start_that_is_over() {
    let home = scratch("pastart");
    let mut core = Sessions::open(&home).unwrap();
    let past = shell(&mut core, &home, &["/bin/cat"]);
    let fresh = shell(&mut core, &home, &["/bin/cat"]);
    core.entries[&past.id].observer.screen.mark_started();
    for _ in 0..2 {
        core.leave().unwrap();
        drop(core);
        core = Sessions::open(&home).unwrap();
        assert!(core.entries[&past.id].pty.is_some(), "reattached");
        assert!(core.entries[&past.id].observer.screen.started());
        assert!(!core.entries[&fresh.id].observer.screen.started());
    }
    for id in [past.id, fresh.id] {
        core.handle(Request::Close { id }).unwrap();
    }
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// A holder of another protocol: it answers only the frozen hello (with `version`) and `stop`, which it records and
/// answers by ending `agent`.
struct Fake {
    stops: std::sync::mpsc::Receiver<Vec<u8>>,
}
fn fake_holder(socket: &Path, version: u16, agent: u32) -> Fake {
    let listener = UnixListener::bind(socket).unwrap();
    let (tx, stops) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut hello = crate::holder::frame::hello();
            hello[8..10].copy_from_slice(&version.to_be_bytes());
            let _ = stream.write_all(&hello);
            // A core that read the hello and left already makes this fail (EINVAL): the reads below then end.
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut got = vec![];
            let mut buf = [0; 64];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                got.extend(&buf[..n]);
                if got.len() >= 12 + 5 && got[12..17] == [0, 0, 0, 1, crate::holder::frame::STOP] {
                    unsafe { libc::killpg(agent as i32, libc::SIGKILL) };
                    let _ = crate::holder::frame::write_frame(
                        &mut stream,
                        crate::holder::frame::OK,
                        &[],
                    );
                    break;
                }
            }
            let _ = tx.send(got);
        }
    });
    Fake { stops }
}
/// A data folder whose sessions.json names a running shell session held by a holder of protocol `version` at
/// `holders/old.sock` (this test process stands in for the holder process).
fn recorded(name: &str, version: u16) -> (PathBuf, std::process::Child, Fake, String) {
    let home = scratch(name);
    let mut agent = std::process::Command::new("/bin/sleep");
    agent.arg("300").process_group(0);
    let agent = agent.spawn().unwrap();
    let started = crate::peer::started(agent.id()).unwrap();
    fs::create_dir_all(home.join("holders")).unwrap();
    let socket = home.join("holders/old.sock");
    let fake = fake_holder(&socket, version, agent.id());
    let id = store::new_id().unwrap();
    let mut row: Session = serde_json::from_value(serde_json::json!({
        "id": id, "kind": "shell", "project": home, "cwd": home, "label": "old", "state": "running",
        "agent_session_id": null, "agent_version": null, "untested": false, "pid": agent.id(),
    }))
    .unwrap();
    row.state = SessionState::Running;
    let me = std::process::id();
    let live = store::Live {
        token_sha256: store::token_sha256("agent-token"),
        holder: Some(crate::holder::Record {
            socket,
            protocol: version,
            pid: me,
            started: crate::peer::started(me).unwrap(),
        }),
        agent_started: Some(started),
        run_start: 0,
        launch_args: None,
        past_start: false,
        agent_pid: None,
    };
    store::save(&home, vec![row], BTreeMap::from([(id.clone(), live)])).unwrap();
    (home, agent, fake, id)
}

// Acceptance `older_holder_status_line` (spec V2-1 acceptance 4): the agent keeps running, the session shows the
// restart line, the agent's token still works; Restart session (close, then start) stops it through the frozen stop.
#[test]
fn older_holder_status_line() {
    let (home, mut agent, fake, id) = recorded("older", 1);
    let mut core = Sessions::open(&home).unwrap();
    let s = snapshot(&mut core, &id);
    assert_eq!(s.state, SessionState::Running);
    assert_eq!(s.pid, Some(agent.id()));
    assert_eq!(s.holder_status, Some(HolderStatus::NeedsRestart));
    // Not attached: the core read the hello and sent nothing back.
    assert_eq!(
        fake.stops.recv_timeout(Duration::from_secs(5)).unwrap(),
        Vec::<u8>::new()
    );
    core.tick().unwrap();
    assert!(
        crate::peer::running_since(agent.id(), None),
        "nothing ends the agent on its own"
    );
    assert_eq!(snapshot(&mut core, &id).state, SessionState::Running);
    assert_eq!(
        core.agent_caller("agent-token").unwrap().id,
        id,
        "its token, by hash"
    );
    assert!(core.agent_caller("another-token").is_err());
    core.handle(Request::Close { id: id.clone() }).unwrap();
    let stop = fake.stops.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(&stop[12..17], &[0, 0, 0, 1, crate::holder::frame::STOP]);
    let _ = agent.wait();
    assert!(
        core.agent_caller("agent-token").is_err(),
        "revoked on close"
    );
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Acceptance `newer_holder_not_attached` (spec V2-1 acceptance 4): not attached, "Update Nunchiro", agent untouched.
#[test]
fn newer_holder_not_attached() {
    let (home, mut agent, fake, id) = recorded("newer", crate::holder::frame::PROTOCOL + 1);
    let mut core = Sessions::open(&home).unwrap();
    let s = snapshot(&mut core, &id);
    assert_eq!(s.state, SessionState::Running);
    assert_eq!(s.holder_status, Some(HolderStatus::UpdateNunchiro));
    assert_eq!(
        fake.stops.recv_timeout(Duration::from_secs(5)).unwrap(),
        Vec::<u8>::new(),
        "no byte sent"
    );
    for _ in 0..3 {
        core.tick().unwrap();
    }
    assert!(
        crate::peer::running_since(agent.id(), None),
        "nothing ends the agent on its own"
    );
    // A newer core will attach it: the record is kept.
    assert!(
        fs::read_to_string(home.join("sessions.json"))
            .unwrap()
            .contains("old.sock")
    );
    drop(core);
    let _ = agent.kill();
    let _ = agent.wait();
    let _ = fs::remove_dir_all(home);
}

// Acceptance `unknown_holder_not_adopted` (spec V2-1 data rules): the data folder lost its sessions.json while a holder
// lives; the new core lists no session for it and leaves the holder and its agent running.
#[test]
fn unknown_holder_not_adopted() {
    let home = scratch("unknown");
    let mut core = Sessions::open(&home).unwrap();
    let session = shell(&mut core, &home, &["/bin/cat"]);
    let agent = session.pid.unwrap();
    let socket = core.entries[&session.id]
        .pty
        .as_ref()
        .unwrap()
        .holder()
        .socket
        .clone();
    core.leave().unwrap();
    drop(core);
    fs::remove_file(home.join("sessions.json")).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    match core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => assert!(sessions.is_empty(), "{sessions:?}"),
        _ => panic!(),
    }
    assert!(socket.exists(), "its socket stays");
    assert!(crate::peer::running_since(agent, None), "its agent runs on");
    // A full quit still finds it by socket scan and ends it.
    core.handle(Request::Stop).unwrap();
    wait("unknown holder's agent ends", || {
        !crate::peer::running_since(agent, None)
    });
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Spec V2-1: a holder that died took its agent; the session is never left running.
#[test]
fn a_holder_gone_while_no_core_ran_is_not_running() {
    let (home, mut agent, _fake, id) = recorded("gone", crate::holder::frame::PROTOCOL);
    // The recorded socket answers as another process would: nothing listens there now.
    fs::remove_file(home.join("holders/old.sock")).unwrap();
    let mut store: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
    // The recorded holder is a process that has ended.
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let pid = gone.id();
    let started = crate::peer::started(pid).unwrap_or(1);
    gone.wait().unwrap();
    store["live"][&id]["holder"]["pid"] = pid.into();
    store["live"][&id]["holder"]["started"] = started.into();
    fs::write(
        home.join("sessions.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let s = snapshot(&mut core, &id);
    assert_ne!(s.state, SessionState::Running);
    // Its agent (the recorded process, same start time) was ended as its holder would have.
    assert!(agent.try_wait().unwrap().is_some() || !crate::peer::running_since(agent.id(), None));
    let _ = agent.wait();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// V1A-79: a core reopened right after `leave()` finds the holder's core flag still set for a moment (the holder frees
// it when it notices the closed link); the open waits that out instead of leaving the session stale for 5 s, and the
// same agent is reattached, never a second one.
#[test]
fn reopen_right_after_leave_attaches_without_waiting() {
    let home = scratch("reopen");
    let mut core = Sessions::open(&home).unwrap();
    let session = shell(&mut core, &home, &["/bin/cat"]);
    let agent = session.pid.unwrap();
    core.leave().unwrap();
    drop(core);
    let began = Instant::now();
    let mut core = Sessions::open(&home).unwrap();
    let entry = &core.entries[&session.id];
    assert!(
        entry.pty.is_some() && entry.stale.is_none(),
        "stale after {:?}",
        began.elapsed()
    );
    assert!(began.elapsed() < Duration::from_secs(2));
    assert_eq!(entry.pty.as_ref().unwrap().pid(), agent, "the same agent");
    assert!(crate::peer::running_since(
        agent,
        entry.pty.as_ref().unwrap().agent_started()
    ));
    core.handle(Request::Stop).unwrap();
    wait("the agent ends", || {
        !crate::peer::running_since(agent, None)
    });
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// A holder at `socket` that refuses every attach as a holder with a core does, counting the connections.
fn refusing_holder(socket: &Path) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
    let _ = fs::remove_file(socket);
    let listener = UnixListener::bind(socket).unwrap();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = count.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = stream.write_all(&crate::holder::frame::hello());
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut hello = [0; 12];
            if stream.read_exact(&mut hello).is_ok()
                && crate::holder::frame::read_frame(&mut stream).is_ok()
            {
                let _ = crate::holder::frame::write_frame(
                    &mut stream,
                    crate::holder::frame::ERR,
                    b"holder already has its core",
                );
            }
        }
    });
    count
}

// V1A-79 (threat 2): `open` tries a refusing holder 5 times; the registry's refresh then tries once per STALE_RETRY and
// returns at once (it runs under the registry lock).
#[test]
fn refresh_attach_stays_single_shot() {
    let (home, mut agent, _unused, id) = recorded("single", crate::holder::frame::PROTOCOL);
    let count = refusing_holder(&home.join("holders/old.sock"));
    let tries = || count.load(std::sync::atomic::Ordering::SeqCst);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(tries(), 5, "open retries");
    assert!(core.entries[&id].pty.is_none() && core.entries[&id].stale.is_some());
    // Not yet due: nothing is tried.
    core.tick().unwrap();
    assert_eq!(tries(), 5);
    core.entries
        .get_mut(&id)
        .unwrap()
        .stale
        .as_mut()
        .unwrap()
        .retry = Instant::now();
    let began = Instant::now();
    core.tick().unwrap();
    assert_eq!(tries(), 6, "one attempt per due retry");
    assert!(
        began.elapsed() < Duration::from_millis(200),
        "{:?}",
        began.elapsed()
    );
    drop(core);
    let _ = agent.kill();
    let _ = agent.wait();
    let _ = fs::remove_dir_all(home);
}

// V1A-79 / V1A-72 / V1A-68: a Close the silent holder refuses leaves the closed-view list and the session's view alone;
// once the holder's agent is gone (as when a stopped holder runs again and stops it), the same Close succeeds and the
// session is the newest closed view. The holder here is unit-test scale: a socket that answers hello and refuses
// attach, never the stop; the real SIGSTOPped holder is `a_refused_close_of_a_shell_leaves_its_scrollback_alone`.
#[test]
fn refused_close_leaves_closed_views_untouched() {
    let (home, mut agent, _unused, id) = recorded("refused", crate::holder::frame::PROTOCOL);
    let _count = refusing_holder(&home.join("holders/old.sock"));
    // A closed shell's view already held, and this session's own saved scrollback.
    let other = "other-closed";
    let mut core = Sessions::open(&home).unwrap();
    assert!(core.entries[&id].stale.is_some());
    core.entries.get_mut(&id).unwrap().saved =
        Some(crate::pty::Saved::new(b"kept".to_vec())).into();
    core.closed_views.push_back(other.into());
    let views = |core: &Sessions| core.closed_views.iter().cloned().collect::<Vec<_>>();
    let saved = |core: &Sessions| {
        core.entries[&id]
            .saved
            .get()
            .map(|view| view.as_ref().map(|s| s.bytes()))
    };
    let (before_views, before_saved) = (views(&core), saved(&core));
    assert!(
        core.close(&id, false, false).is_err(),
        "a silent holder's Close was taken"
    );
    assert_eq!(views(&core), before_views);
    assert_eq!(saved(&core), before_saved);
    assert_eq!(core.entries[&id].meta.state, SessionState::Running);
    assert!(crate::peer::running_since(agent.id(), None));
    let _ = agent.kill();
    let _ = agent.wait();
    core.close(&id, false, false).unwrap();
    assert_eq!(views(&core), [other.to_string(), id.clone()]);
    assert_eq!(saved(&core), Some(Some(b"kept".to_vec())));
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// Ticket 286 S2: a restarted core over a session whose agent quit (its wrapper wrote the ended marker) and whose
/// holder is not attached. No refresh reads the marker for it, so `agent_caller` must, from the first request.
fn restarted_caller(name: &str, marker: impl FnOnce(&Path)) -> Result<String, String> {
    let (home, mut agent, fake, id) = recorded(name, 1);
    marker(&ended_marker(&home, &id));
    let mut core = Sessions::open(&home).unwrap();
    let caller = core.agent_caller("agent-token").map(|c| c.id);
    core.handle(Request::Close { id: id.clone() }).unwrap();
    fake.stops.recv_timeout(Duration::from_secs(5)).unwrap();
    let _ = agent.wait();
    drop(core);
    let _ = fs::remove_dir_all(home);
    caller.map(|caller| {
        assert_eq!(caller, id, "its own session");
        caller
    })
}

#[test]
fn agent_caller_refuses_ended_token_after_restart() {
    let refused = restarted_caller("ended-tok", |m| fs::write(m, "seen 0\n").unwrap()).unwrap_err();
    assert!(refused.contains("unauthorized"), "{refused}");
}

#[test]
fn agent_caller_accepts_live_token_after_restart() {
    assert!(
        restarted_caller("live-tok", |_| {}).is_ok(),
        "a live agent keeps its token"
    );
}

/// Fail closed: a marker whose state cannot be read (here a symlink loop) refuses the token.
#[test]
fn agent_caller_refuses_unreadable_marker() {
    let refused =
        restarted_caller("loop-tok", |m| std::os::unix::fs::symlink(m, m).unwrap()).unwrap_err();
    assert!(refused.contains("unauthorized"), "{refused}");
}

/// Ticket 286 S3, review round: a parent whose holder is not attached never gets the ended latch from `refresh`, so the
/// side-chat start reads the marker too.
#[test]
fn side_chat_refused_for_unattached_ended_parent() {
    super::tests::fake_agents(); // never the user's own `claude`
    let (home, mut agent, fake, id) = recorded("side-unatt", 1);
    fs::write(ended_marker(&home, &id), "seen 0\n").unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: home.clone(),
            worktree: false,
            label: "side".into(),
            args: vec![
                "--permission-mode".into(),
                "plan".into(),
                SIDE_CHAT_ARG.into(),
                id.clone(),
            ],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let started = core.start(&launch).map(|s| s.id);
    if let Ok(side) = &started {
        core.handle(Request::Close { id: side.clone() }).unwrap();
    }
    core.handle(Request::Close { id }).unwrap();
    fake.stops.recv_timeout(Duration::from_secs(5)).unwrap();
    let _ = agent.wait();
    drop(core);
    let _ = fs::remove_dir_all(home);
    let refused = started.unwrap_err();
    assert!(refused.contains("parent is not running"), "{refused}");
}

/// Ticket 1002 lane 1 (Fable round 3 review M1): a Home seat from before the lock that came back running is ended at
/// core start, its conversation resumable, and the next start of it is locked.
#[test]
fn a_pre_lock_home_seat_is_ended_at_start_and_resumes_locked() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch("prelock");
    let claude = home.join("fake-claude");
    fs::write(
        &claude,
        "#!/bin/sh\n[ \"$1\" = --version ] && { echo '2.1.310 (Claude Code)'; exit 0; }\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let check = crate::approval::command_check(
        &home,
        AgentKind::Claude,
        claude.display().to_string(),
        vec![],
        vec![],
    )
    .unwrap();
    crate::approval::command_grant(&home, AgentKind::Claude, check.hash.as_deref().unwrap())
        .unwrap();
    fs::create_dir_all(home.join("team/home")).unwrap();
    let seat_dir = crate::team::Team::open(&home).home();
    let start = |resume: Option<String>| StartSession {
        account: None,
        kind: AgentKind::Claude,
        project: seat_dir.clone(),
        worktree: false,
        label: "Chief".into(),
        args: vec![],
        model: None,
        effort: None,
        resume,
    };
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core.launch(start(None)).owner_start().prepare().unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    drop(launch);
    // The record as a core from before the lock left it, its agent still running.
    let meta = &mut core.entries.get_mut(&id).unwrap().meta;
    (meta.home_lock, meta.home_mode) = (false, None);
    let conversation = meta.agent_session_id.clone().unwrap();
    core.save().unwrap();
    core.leave().unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    let back = snapshot(&mut core, &id);
    assert_eq!(back.state, SessionState::Resumable, "ended, not reattached");
    assert!(core.entries[&id].pty.is_none());
    let resumed = core
        .launch(start(Some(conversation)))
        .owner_start()
        .prepare()
        .unwrap();
    assert!(crate::home_lock::locked(&resumed.permission));
    drop(resumed);
    let _ = core.handle(Request::Stop);
    let _ = fs::remove_dir_all(home);
}

/// Ticket 1002 lane 1 (Fable round 4 review M1-r4): a pre-lock Home Claude seat whose holder refuses every attach (as a
/// slow or busy one does at `open`) is not left for `refresh` to attach later: its recorded agent ends at core start and
/// the row is not Running.
#[test]
fn a_pre_lock_home_seat_behind_a_refusing_holder_ends_at_start() {
    let home = scratch("prelock-stale");
    fs::create_dir_all(home.join("team/home")).unwrap();
    let seat = crate::team::Team::open(&home).home();
    let mut agent = std::process::Command::new("/bin/sleep");
    agent.arg("300").process_group(0);
    let mut agent = agent.spawn().unwrap();
    let started = crate::peer::started(agent.id()).unwrap();
    fs::create_dir_all(home.join("holders")).unwrap();
    let socket = home.join("holders/old.sock");
    let _count = refusing_holder(&socket);
    let id = store::new_id().unwrap();
    // A record from before the lock: no `home_lock`, no `home_mode`.
    let row: Session = serde_json::from_value(serde_json::json!({
        "id": id, "kind": "claude", "project": seat, "cwd": seat, "label": "Chief", "state": "running",
        "agent_session_id": "c0ffee00-0000-4000-8000-000000000001", "agent_version": null, "untested": false,
        "pid": agent.id(),
    }))
    .unwrap();
    let me = std::process::id();
    let live = store::Live {
        token_sha256: store::token_sha256("agent-token"),
        holder: Some(crate::holder::Record {
            socket,
            protocol: crate::holder::frame::PROTOCOL,
            pid: me,
            started: crate::peer::started(me).unwrap(),
        }),
        agent_started: Some(started),
        run_start: 0,
        launch_args: None,
        past_start: false,
        agent_pid: None,
    };
    store::save(&home, vec![row], BTreeMap::from([(id.clone(), live)])).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    assert!(core.entries[&id].pty.is_none() && core.entries[&id].stale.is_none());
    assert_ne!(core.entries[&id].meta.state, SessionState::Running);
    wait("the pre-lock agent ends", || {
        !crate::peer::running_since(agent.id(), Some(started))
    });
    // A later refresh finds nothing to attach.
    core.tick().unwrap();
    assert_ne!(snapshot(&mut core, &id).state, SessionState::Running);
    drop(core);
    let _ = agent.kill();
    let _ = agent.wait();
    let _ = fs::remove_dir_all(home);
}
