use super::{BATCH, Message, Ordering, POLL, SNAPSHOT_EVERY, allowed_origins};
use std::{
    thread,
    time::{Duration, Instant},
};
use tungstenite::client::IntoClientRequest;

// v1a-38b: a flood of off-loop frames starts at most MAX_JOBS threads; a slot frees only when its reply is taken.
#[test]
fn a_frame_flood_starts_at_most_max_jobs_and_refuses_the_rest() {
    use super::{Jobs, MAX_JOBS};
    use std::sync::{Arc, Barrier, atomic::AtomicUsize};
    let mut jobs = Jobs::new(super::Lease::new(|| {}));
    let started = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Barrier::new(MAX_JOBS + 1));
    let mut refused = vec![];
    for id in 0..100 {
        let (started, gate) = (started.clone(), gate.clone());
        if let Some(out) = jobs.spawn(id, move || {
            started.fetch_add(1, Ordering::SeqCst);
            gate.wait();
            Ok(super::Reply::Ack)
        }) {
            refused.push(out);
        }
    }
    assert_eq!(refused.len(), 100 - MAX_JOBS);
    assert_eq!(
        refused[0]["response"]["Err"],
        "too many requests in flight; try again"
    );
    assert_eq!(refused[0]["id"], MAX_JOBS as u64);
    gate.wait();
    let until = Instant::now() + Duration::from_secs(5);
    let mut replies = vec![];
    while replies.len() < MAX_JOBS {
        assert!(Instant::now() < until, "replies missing");
        replies.extend(jobs.ready());
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(started.load(Ordering::SeqCst), MAX_JOBS);
    // Every slot is free again; a panicking job still answers and frees its slot.
    assert!(jobs.spawn(200, || panic!("job")).is_none());
    let until = Instant::now() + Duration::from_secs(5);
    let reply = loop {
        assert!(Instant::now() < until, "no reply from the panicking job");
        if let Some(r) = jobs.ready() {
            break r;
        }
        thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(reply["response"]["Err"], "request failed");
    assert_eq!(jobs.open, 0);
}

// Ticket 459: probes that fill their own places (a status or `--version` command held for seconds) never refuse a
// fast read on the same connection, and the probe lane stays bounded: one past `MAX_PROBE_JOBS` is refused.
#[test]
fn slow_probes_do_not_refuse_a_fast_read() {
    use super::MAX_PROBE_JOBS;
    let (mut ws, stopping, home) = window("probe-lane");
    let slow = home.join("slow-agent");
    std::fs::write(&slow, "#!/bin/sh\nsleep 1\necho 1.0.0\n").unwrap();
    std::fs::set_permissions(&slow, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    // The core runs one command check at a time, so these hold their places for 1 s, 2 s, ... 6 s.
    for id in 1..=MAX_PROBE_JOBS as u64 + 1 {
        let frame = serde_json::json!({"id": id, "request": {"op": "agent_command_check", "agent": "claude",
            "path": slow, "args": [], "env": []}});
        ws.send(Message::Text(frame.to_string().into())).unwrap();
    }
    let read = serde_json::json!({"id": 100, "request": {"op": "worktree", "operation": "list", "project": null,
        "path": null, "branch": null, "base": "HEAD", "label": ""}});
    ws.send(Message::Text(read.to_string().into())).unwrap();
    let sent = Instant::now();
    let busy = serde_json::json!({"Err": "too many requests in flight; try again"});
    let (mut fast, mut refused, mut checked) = (None, vec![], vec![]);
    // Every check answers before the test ends, so none holds the core's one check place for another test.
    while fast.is_none() || refused.is_empty() || checked.len() < MAX_PROBE_JOBS {
        assert!(
            sent.elapsed() < Duration::from_secs(40),
            "fast {fast:?}, refused {refused:?}, checked {checked:?}"
        );
        let Ok(Message::Text(text)) = ws.read() else {
            continue;
        };
        let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
        match reply["id"].as_u64() {
            Some(100) => fast = Some((reply["response"].clone(), sent.elapsed())),
            Some(id) if reply["response"] == busy => refused.push(id),
            Some(id) if id <= MAX_PROBE_JOBS as u64 => {
                assert_eq!(
                    reply["response"]["Ok"]["check"]["version"], "1.0.0",
                    "{reply}"
                );
                checked.push(id);
            }
            _ => {}
        }
    }
    let (response, took) = fast.unwrap();
    assert!(response.get("Ok").is_some(), "the fast read: {response}");
    assert!(
        took < Duration::from_secs(1),
        "the fast read waited {took:?} behind the probes"
    );
    assert_eq!(refused, vec![MAX_PROBE_JOBS as u64 + 1]);
    stopping.store(true, Ordering::SeqCst);
}

// Codex note on lane w87: a folder check that never returns holds neither the frame loop (another request on the
// same connection answers at once) nor its own reply past the bound (that folder reads as offline).
#[test]
fn a_stalled_folder_check_does_not_hold_the_connection() {
    let _turn = crate::tree::CHECKS_TEST
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (mut ws, stopping, home) = window("folders-stall");
    let (stuck, fine) = (home.join("stuck"), home.join("fine"));
    for (id, dir) in [(1, &stuck), (2, &fine)] {
        std::fs::create_dir_all(dir).unwrap();
        let add = serde_json::json!({"id": id, "request": {"op": "tree_edit",
            "edit": {"op": "add", "project": dir, "added": true}}});
        ws.send(Message::Text(add.to_string().into())).unwrap();
    }
    let mut added = 0;
    while added < 2 {
        if let Ok(Message::Text(text)) = ws.read() {
            let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
            if matches!(reply["id"].as_u64(), Some(1 | 2)) {
                assert!(reply["response"]["Ok"].is_object(), "{reply}");
                added += 1;
            }
        }
    }
    crate::tree::STALLED.lock().unwrap().insert(stuck.clone());
    let folders = serde_json::json!({"id": 10, "request": {"op": "project_folders"}});
    ws.send(Message::Text(folders.to_string().into())).unwrap();
    let read = serde_json::json!({"id": 11, "request": {"op": "worktree", "operation": "list", "project": null,
        "path": null, "branch": null, "base": "HEAD", "label": ""}});
    ws.send(Message::Text(read.to_string().into())).unwrap();
    let sent = Instant::now();
    let (mut fast, mut states) = (None, None);
    while states.is_none() {
        assert!(sent.elapsed() < Duration::from_secs(20), "no folder states");
        let Ok(Message::Text(text)) = ws.read() else {
            continue;
        };
        let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
        match reply["id"].as_u64() {
            Some(11) => fast = Some(sent.elapsed()),
            Some(10) => states = Some((reply["response"].clone(), sent.elapsed())),
            _ => {}
        }
    }
    crate::tree::STALLED.lock().unwrap().remove(&stuck);
    let took = fast.expect("the other request answered before the folder states");
    assert!(
        took < Duration::from_secs(1),
        "the other request waited {took:?}"
    );
    let (states, after) = states.unwrap();
    let of = |p: &std::path::Path| states["Ok"]["folders"][p.to_str().unwrap()].clone();
    assert_eq!(of(&stuck), "offline", "{states}");
    assert_eq!(of(&fine), "ok", "{states}");
    assert!(after >= crate::tree::FOLDER_CHECK_BOUND, "{after:?}");
    stopping.store(true, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&home);
}

// Lane w96: a Locate whose picked folder never answers does not hold the connection, and is refused after the bound.
#[test]
fn a_stalled_locate_check_does_not_hold_the_connection() {
    let _turn = crate::tree::CHECKS_TEST
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (mut ws, stopping, home) = window("locate-stall");
    let stuck = home.join("stuck");
    std::fs::create_dir_all(&stuck).unwrap();
    crate::tree::STALLED.lock().unwrap().insert(stuck.clone());
    let locate = serde_json::json!({"id": 10, "request": {"op": "project_locate",
        "from": home.join("gone"), "to": stuck}});
    ws.send(Message::Text(locate.to_string().into())).unwrap();
    let read = serde_json::json!({"id": 11, "request": {"op": "worktree", "operation": "list", "project": null,
        "path": null, "branch": null, "base": "HEAD", "label": ""}});
    ws.send(Message::Text(read.to_string().into())).unwrap();
    let sent = Instant::now();
    let (mut fast, mut located) = (None, None);
    while located.is_none() {
        assert!(sent.elapsed() < Duration::from_secs(20), "no locate answer");
        let Ok(Message::Text(text)) = ws.read() else {
            continue;
        };
        let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
        match reply["id"].as_u64() {
            Some(11) => fast = Some(sent.elapsed()),
            Some(10) => located = Some((reply["response"].clone(), sent.elapsed())),
            _ => {}
        }
    }
    crate::tree::STALLED.lock().unwrap().remove(&stuck);
    let took = fast.expect("the other request answered before the locate");
    assert!(
        took < Duration::from_secs(1),
        "the other request waited {took:?}"
    );
    let (located, after) = located.unwrap();
    assert!(
        located["Err"].as_str().unwrap().contains("did not answer"),
        "{located}"
    );
    assert!(after >= crate::tree::FOLDER_CHECK_BOUND, "{after:?}");
    stopping.store(true, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&home);
}

// ticket 113: the user-commands read is a job; a slow read does not hold the frame loop.
#[test]
fn user_commands_not_on_frame_loop() {
    use super::{Jobs, dispatch_user_commands};
    use crate::api::AgentKind;
    use std::sync::{Arc, Barrier};
    let mut jobs = Jobs::new(super::Lease::new(|| {}));
    let gate = Arc::new(Barrier::new(2));
    let held = gate.clone();
    let refused = dispatch_user_commands(&mut jobs, 7, AgentKind::Claude, move |_| {
        held.wait(); // the read, blocked until the test lets it finish
        Ok(super::Reply::UserCommands { rows: vec![] })
    });
    // This call returned while the read is still blocked, and nothing is ready yet.
    assert!(refused.is_none());
    assert!(jobs.ready().is_none());
    gate.wait();
    let until = Instant::now() + Duration::from_secs(5);
    let reply = loop {
        assert!(Instant::now() < until, "no reply from the job");
        if let Some(r) = jobs.ready() {
            break r;
        }
        thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["response"]["Ok"]["type"], "user_commands");
}

#[test]
fn usage_op_off_frame_loop() {
    use super::{Jobs, dispatch_session_context};
    let mut jobs = Jobs::new(super::Lease::new(|| {}));
    let (release, held) = std::sync::mpsc::channel();
    assert!(
        dispatch_session_context(&mut jobs, 7, move || {
            let _ = held.recv_timeout(Duration::from_secs(2));
            Ok(super::Reply::Unknown)
        })
        .is_none()
    );
    assert!(jobs.spawn(8, || Ok(super::Reply::Ack)).is_none());
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            Instant::now() < until,
            "another request blocked behind the read"
        );
        if let Some(reply) = jobs.ready() {
            assert_eq!(reply["id"], 8);
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    release.send(()).unwrap();
}

// Q9 psn-J12-5: the tree's burst of sub-agent reads queues behind a read the volume holds; none is refused, none
// holds the frame loop, and they answer in order once the read ends.
#[test]
fn subagent_reads_queue_off_the_frame_loop() {
    let (release, held) = std::sync::mpsc::channel::<()>();
    let held = std::sync::Mutex::new(held);
    let reads = super::KidReads::start(super::Lease::new(|| {}), move |id, _| {
        if id == "slow" {
            let _ = held.lock().unwrap().recv_timeout(Duration::from_secs(5));
        }
        Ok(super::Reply::Ack)
    })
    .unwrap();
    assert!(reads.ask(1, "slow".into(), None).is_none());
    for id in 2..12 {
        assert!(
            reads.ask(id, format!("s{id}"), None).is_none(),
            "{id} refused"
        );
    }
    thread::sleep(Duration::from_millis(50));
    assert!(reads.ready().is_none(), "nothing passes the held read");
    release.send(()).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let mut ids = vec![];
    while ids.len() < 11 {
        assert!(Instant::now() < until, "replies missing: {ids:?}");
        ids.extend(reads.ready().map(|r| r["id"].as_u64().unwrap()));
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(ids, (1..12).collect::<Vec<_>>());
}

// v1a-13 r2: eviction, on real loopback sockets; no timing is measured.
mod pending {
    use super::super::{MAX_HANDSHAKES, Pending};
    use std::{
        io::{ErrorKind, Read, Write},
        net::{TcpListener, TcpStream},
        sync::atomic::Ordering,
        time::{Duration, Instant},
    };
    /// `MAX_HANDSHAKES` accepted sockets in the list, oldest first, with their client ends.
    fn full() -> (Pending, Vec<TcpStream>, Vec<TcpStream>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut p = Pending::default();
        let (mut clients, mut servers) = (vec![], vec![]);
        for _ in 0..MAX_HANDSHAKES {
            clients.push(TcpStream::connect(listener.local_addr().unwrap()).unwrap());
            let (s, _) = listener.accept().unwrap();
            assert!(!p.make_room().unwrap());
            p.add(&s).unwrap();
            servers.push(s);
        }
        (p, clients, servers)
    }
    /// The client sends its whole request; returns once the server end can see it (still unread).
    fn send_request(client: &mut TcpStream, server: &TcpStream) {
        client
            .write_all(b"GET /ws HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        let mut byte = [0u8; 1];
        server.set_nonblocking(true).unwrap();
        while !matches!(server.peek(&mut byte), Ok(n) if n > 0) {
            assert!(Instant::now() < until, "request never arrived");
            std::thread::sleep(Duration::from_millis(1));
        }
        server.set_nonblocking(false).unwrap();
    }
    fn closed(client: &mut TcpStream) -> bool {
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        // v1a-21: a read timeout means the socket is still open, not closed.
        match client.read(&mut [0u8; 1]) {
            Ok(n) => n == 0,
            Err(e) => !matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut),
        }
    }
    fn open(client: &mut TcpStream) -> bool {
        client.set_nonblocking(true).unwrap();
        matches!(client.read(&mut [0u8; 1]), Err(e) if e.kind() == ErrorKind::WouldBlock)
    }

    #[test]
    fn the_17th_socket_evicts_the_oldest_that_sent_nothing() {
        let (mut p, mut clients, servers) = full();
        // The oldest socket is the owner's: its request is in, its thread has not read it yet.
        send_request(&mut clients[0], &servers[0]);
        assert_eq!(p.make_room(), Ok(true));
        // v1a-21: each message states the condition its assert checks.
        assert!(
            closed(&mut clients[1]),
            "the oldest silent socket is closed"
        );
        assert!(open(&mut clients[0]), "the owner's socket stays open");
        for c in &mut clients[2..] {
            assert!(open(c));
        }
        assert_eq!(p.list.len(), MAX_HANDSHAKES - 1);
    }

    #[test]
    fn a_socket_that_sent_its_request_is_never_evicted() {
        let (mut p, mut clients, servers) = full();
        for (c, s) in clients.iter_mut().zip(&servers) {
            send_request(c, s);
        }
        // Every pending socket is waiting for its thread: the newcomer waits instead.
        assert_eq!(p.make_room(), Err(()));
        for c in &mut clients {
            assert!(open(c));
        }
    }

    #[test]
    fn a_handshake_whose_request_was_read_leaves_the_list() {
        let (mut p, _clients, _servers) = full();
        p.list[3].0.store(true, Ordering::SeqCst);
        assert_eq!(p.make_room(), Ok(false), "a freed place needs no eviction");
        assert_eq!(p.list.len(), MAX_HANDSHAKES - 1);
    }
}
// v1a-27 S1: count this core home's registry locks and passes independently of other fixtures.
// Phase 1: session B, which the window does not
// watch, streams for 1 s; a loop woken into the registry by each read counts far more locks than the resyncs
// allow, and an unbatched loop far more passes. Phase 2: the watched session A streams for 1 s; batching keeps
// the loop at one output pass per `BATCH`, and its output is read off the registry, which it takes only to resync.
#[test]
fn a_window_takes_the_registry_only_to_resync_its_watches() {
    use crate::{api::StartSession, sessions::Sessions};
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("wake-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let registry = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
    let stopping = Arc::new(AtomicBool::new(false));
    let (port, token) = super::spawn(&home, registry.clone(), stopping.clone()).unwrap();
    let start = |script: &str| {
        let mut r = registry.lock().unwrap();
        let mut launch = r
            .launch(StartSession {
                account: None,
                kind: crate::api::AgentKind::Shell,
                project: home.clone(),
                worktree: false,
                label: String::new(),
                args: vec!["/usr/bin/perl".into(), "-e".into(), script.into()],
                model: None,
                effort: None,
                resume: None,
            })
            .prepare()
            .unwrap();
        let session = r.start(&launch).unwrap();
        launch.committed = true;
        session.id
    };
    let done = |id: &str| {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            let Ok(crate::api::Reply::Output { data, .. }) = registry.lock().unwrap().output(id, 0)
            else {
                panic!("read failed")
            };
            if data.windows(4).any(|w| w == b"DONE") {
                return;
            }
            assert!(Instant::now() < until, "{id} did not finish");
            thread::sleep(Duration::from_millis(20));
        }
    };
    // Each waits for its line on stdin, so nothing streams before the phase begins.
    let a = start(
        r#"use Time::HiRes qw(time); $|=1; <STDIN>; my $t=time+1; print "a" x 100, "\n" while time<$t; print "DO", "NE\n"; sleep 600"#,
    );
    let b = start(
        r#"use Time::HiRes qw(time); $|=1; <STDIN>; my $t=time+1; print "b" x 100, "\n" while time<$t; print "DO", "NE\n"; sleep 600"#,
    );
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Origin", "tauri://localhost".parse().unwrap());
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("nunchiro.v1, nunchiro.token.{token}")
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tungstenite::connect(req).unwrap();
    ws.send(Message::Text(
        serde_json::json!({"id":1,"watch":a,"after":0})
            .to_string()
            .into(),
    ))
    .unwrap();
    // The replay frame for A: the watch is live.
    while !matches!(ws.read().unwrap(), Message::Binary(_)) {}
    let feed = |id: &str| {
        let request = crate::api::Request::SendText {
            id: id.into(),
            text: "go\n".into(),
            composer: false,
            seen: vec![],
        };
        registry.lock().unwrap().handle(request).unwrap();
    };
    let counts = super::output_counts(&home);
    let locks = || counts.locks.load(Ordering::SeqCst);
    let passes = || counts.passes.load(Ordering::SeqCst);
    let (before, passed, at) = (locks(), passes(), Instant::now());
    feed(&b);
    done(&b);
    let (unwatched, quiet) = (locks() - before, at.elapsed());
    let unwatched_passes = passes() - passed;
    // A reader drains the window so its sends never block.
    let reading = Arc::new(AtomicBool::new(true));
    let reader = {
        let reading = reading.clone();
        if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_mut() {
            s.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        }
        thread::spawn(move || {
            while reading.load(Ordering::SeqCst) {
                let _ = ws.read();
            }
        })
    };
    let (before, passed, at) = (locks(), passes(), Instant::now());
    feed(&a);
    done(&a);
    let (watched, streamed) = (locks() - before, at.elapsed());
    let watched_passes = passes() - passed;
    reading.store(false, Ordering::SeqCst);
    reader.join().unwrap();
    stopping.store(true, Ordering::SeqCst);
    let _ = registry.lock().unwrap().stop();
    let _ = std::fs::remove_dir_all(&home);
    eprintln!(
        "v1a-27 output-pass registry locks: B unwatched {unwatched} ({unwatched_passes} passes) in {quiet:?}, A watched {watched} ({watched_passes} passes) in {streamed:?}"
    );
    // Resyncs alone run once per SNAPSHOT_EVERY; the slack covers the done() polls' 20 ms granularity.
    let resyncs = |d: Duration| (d.as_millis() / SNAPSHOT_EVERY.as_millis()) as u64 + 5;
    assert!(
        unwatched <= resyncs(quiet),
        "{unwatched} locks for unwatched output in {quiet:?}"
    );
    // Each pass follows a wake (at most one per BATCH) or an idle tick (POLL).
    let ticks = |d: Duration| (d.as_millis() / POLL.as_millis()) as u64;
    let batches = |d: Duration| (d.as_millis() / BATCH.as_millis()) as u64;
    assert!(
        unwatched_passes <= batches(quiet) + ticks(quiet) + 5,
        "{unwatched_passes} passes for unwatched output in {quiet:?}"
    );
    assert!(
        watched_passes <= batches(streamed) + resyncs(streamed),
        "{watched_passes} passes in {streamed:?}"
    );
    // Watched output between resyncs is read from the session's own ring: a key's echo never waits for a registry
    // lock the core's tick or another request holds.
    assert!(
        watched <= resyncs(streamed),
        "{watched} registry locks for watched output in {streamed:?}"
    );
}

/// v1a-55: a core with no sessions and one authenticated window on it; the core stops when `stopping` is set.
fn window(
    name: &str,
) -> (
    tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
    std::path::PathBuf,
) {
    use crate::sessions::Sessions;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("{name}-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let registry = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
    let stopping = Arc::new(AtomicBool::new(false));
    let (port, token) = super::spawn(&home, registry, stopping.clone()).unwrap();
    (connect(port, &token), stopping, home)
}

fn connect(
    port: u16,
    token: &str,
) -> tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>> {
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Origin", "tauri://localhost".parse().unwrap());
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("nunchiro.v1, nunchiro.token.{token}")
            .parse()
            .unwrap(),
    );
    let (ws, _) = tungstenite::connect(req).unwrap();
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    ws
}

/// V2.5-17 r2: a request beside `layout_feed` is refused, and the socket stays the window layout commands go to.
#[test]
fn layout_feed_with_request_refused() {
    let (mut ws, stopping, home) = window("layout-feed-request");
    let frame = r#"{"id":1,"layout_feed":true,"request":{"op":"list"}}"#;
    ws.send(Message::Text(frame.into())).unwrap();
    let reply = loop {
        let Message::Text(text) = ws.read().unwrap() else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        if v["id"] == 1 {
            break v;
        }
    };
    let forward = {
        let home = home.clone();
        std::thread::spawn(move || {
            super::layout::forward(&home, vec!["add".into(), "board".into()])
        })
    };
    let seq = loop {
        let Ok(Message::Text(text)) = ws.read() else {
            break None;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        if v["event"] == "layout_command" {
            break v["seq"].as_u64();
        }
    };
    if let Some(seq) = seq {
        let done = serde_json::json!({"id":2,"layout_done":seq,"text":"add board"});
        ws.send(Message::Text(done.to_string().into())).unwrap();
    }
    let result = forward.join().unwrap();
    stopping.store(true, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(reply["response"]["Err"], "layout_feed takes no request");
    assert_eq!(result, Ok("add board".into()));
}

/// V2.5-17: the chat feed's socket is the newest, but a layout command still goes to the window that answers.
#[test]
fn layout_command_reaches_window() {
    use crate::sessions::Sessions;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("layout-feed-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let registry = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
    let stopping = Arc::new(AtomicBool::new(false));
    let (port, token) = super::spawn(&home, registry, stopping.clone()).unwrap();
    let mut main = connect(port, &token);
    main.read().unwrap(); // the layout event: the main socket is being served
    let mut feed = connect(port, &token);
    feed.send(Message::Text(r#"{"id":1,"layout_feed":true}"#.into()))
        .unwrap();
    // Its ack: the core has handled the frame. The feed's first message is the layout event every window gets on
    // connect, which can come before the frame is handled; taking it for the ack let the command go to the feed.
    loop {
        let Message::Text(text) = feed.read().unwrap() else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        if v["id"] == 1 {
            assert_eq!(v["response"]["Ok"]["type"], "ack", "{v}");
            break;
        }
    }
    let forward = {
        let home = home.clone();
        std::thread::spawn(move || {
            super::layout::forward(&home, vec!["add".into(), "board".into()])
        })
    };
    let seq = loop {
        let Ok(Message::Text(text)) = main.read() else {
            break None;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        if v["event"] == "layout_command" {
            break v["seq"].as_u64();
        }
    };
    if let Some(seq) = seq {
        let done = serde_json::json!({"id":2,"layout_done":seq,"text":"add board"});
        main.send(Message::Text(done.to_string().into())).unwrap();
    }
    let result = forward.join().unwrap();
    stopping.store(true, Ordering::SeqCst);
    drop(feed);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(result, Ok("add board".into()));
}

// v1a-55: the core answers a window's Close with its own before ending the TCP stream (a clean close).
#[test]
fn close_frame_answered_before_eof() {
    let (mut ws, stopping, home) = window("close-answered");
    ws.close(None).unwrap();
    let answered = loop {
        match ws.read() {
            Ok(Message::Close(_)) => break true,
            Ok(_) => {}
            // The stream ended (or reset) before the core's Close frame.
            Err(_) => break false,
        }
    };
    stopping.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&home);
    assert!(answered, "the core's Close frame arrives before EOF");
}

// v1a-55: a peer that sends Close and never reads cannot hold the connection thread. Once the core has read the
// Close, the peer's receive window and the core's send buffer are filled, so the reply cannot go; the write
// timeout ends the flush. (Filled before the Close, the peer's Close segment would reopen the window.) A raw
// stream with a short timeout stands in for `serve`'s `Deadline`, whose writes pass through to the socket and its
// WRITE_TIMEOUT; this proves the reply is not retried, not that `connection()` exits.
#[test]
fn close_peer_not_reading_bounded() {
    use std::io::{ErrorKind, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut peer = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (core, _) = listener.accept().unwrap();
    let bound = Duration::from_millis(200);
    core.set_write_timeout(Some(bound)).unwrap();
    core.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // A masked Close frame with no payload, as a client sends it.
    peer.write_all(&[0x88, 0x80, 1, 2, 3, 4]).unwrap();
    let mut ws =
        tungstenite::WebSocket::from_raw_socket(core, tungstenite::protocol::Role::Server, None);
    assert!(matches!(ws.read(), Ok(Message::Close(_))));
    // Filled until a blocking one-byte write, the kind the reply makes, times out: however slowly the stack
    // settles or the buffers grow, the reply then finds no room.
    let core = ws.get_mut();
    let chunk = [0u8; 64 << 10];
    let (mut filled, until) = (0, Instant::now() + Duration::from_secs(20));
    loop {
        assert!(
            Instant::now() < until,
            "buffers still taking bytes after {filled}"
        );
        core.set_nonblocking(true).unwrap();
        for size in [chunk.len(), 4096, 64, 1] {
            loop {
                match core.write(&chunk[..size]) {
                    Ok(n) => filled += n,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) => panic!("{e}"),
                }
            }
        }
        core.set_nonblocking(false).unwrap();
        match core.write(&chunk[..1]) {
            Ok(n) => filled += n,
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => break,
            Err(e) => panic!("{e}"),
        }
    }
    assert!(filled >= 64 << 10, "only {filled} bytes filled");
    let (done, result) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(super::close_reply(&mut ws));
    });
    // No retry: one timed-out write ends the reply, well inside 5 s.
    let reply = result
        .recv_timeout(Duration::from_secs(5))
        .expect("the connection thread is still held 5 s after the Close");
    assert!(reply.is_err(), "the reply could not be written: {reply:?}");
    drop(peer);
}
#[test]
fn opaque_origins_cannot_be_allowlisted() {
    let o = allowed_origins(Some("null, file, http://127.0.0.1:4173 ,"));
    assert_eq!(
        o,
        [
            "tauri://localhost",
            "http://tauri.localhost",
            "http://127.0.0.1:4173"
        ]
    );
}
// Ticket 39: the window's hand-off answers a stopping core as the owner socket does, before it looks up any
// session (none starts, so the count stays 0).
#[test]
fn http_handoff_refused_while_stopping() {
    use crate::sessions::Sessions;
    use std::sync::{Mutex, atomic::AtomicBool};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("http-handoff-stopping-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let registry = Mutex::new(Sessions::open(&home).unwrap());
    let frame = serde_json::from_value(serde_json::json!({
        "id": 7,
        "request": {"op": "handoff_send", "from": "a-session", "to": "codex", "text": "go on"},
    }))
    .unwrap();
    let out = super::answer(
        frame,
        &registry,
        &AtomicBool::new(true),
        &mut Default::default(),
        &home,
        Some(&super::layout::Window::open(&home)),
        &mut super::layout::stamp(&home),
    );
    assert_eq!(out["response"]["Err"], "core is stopping", "{out}");
    let count = match registry
        .lock()
        .unwrap()
        .handle(crate::api::Request::Snapshot)
    {
        Ok(crate::api::Reply::Snapshot { sessions, .. }) => sessions.len(),
        other => panic!("{other:?}"),
    };
    assert_eq!(count, 0);
    let _ = std::fs::remove_dir_all(&home);
}

/// Q9 en-b-J6-2, en-b-J7-1: the window's `request` stalls in a disk read, as on a hung network mount (`stall` puts
/// the hook on the asking thread). While it stalls, a snapshot from another thread is still answered. Returns
/// whether it was, and the stalled request's answer once released.
fn snapshot_answered_while_stalled(
    name: &str,
    stall: fn(Box<dyn FnOnce()>),
    request: impl FnOnce(&std::path::Path) -> serde_json::Value + Send,
) -> (
    bool,
    serde_json::Value,
    std::sync::Mutex<crate::sessions::Sessions>,
    std::path::PathBuf,
) {
    use std::sync::{Mutex, atomic::AtomicBool, mpsc};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("http-stall-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let registry = Mutex::new(crate::sessions::Sessions::open(&home).unwrap());
    let (stalled, in_read) = mpsc::channel();
    let (release, gate) = mpsc::channel::<()>();
    let (answered, out) = thread::scope(|s| {
        // Owned here, so a failed wait below drops it and the stalled read ends instead of hanging the scope.
        let release = release;
        let (registry, home) = (&registry, &home);
        let asking = s.spawn(move || {
            stall(Box::new(move || {
                stalled.send(()).unwrap();
                let _ = gate.recv();
            }));
            let frame =
                serde_json::from_value(serde_json::json!({ "id": 1, "request": request(home) }))
                    .unwrap();
            super::answer(
                frame,
                registry,
                &AtomicBool::new(false),
                &mut Default::default(),
                home,
                Some(&super::layout::Window::open(home)),
                &mut super::layout::stamp(home),
            )
        });
        in_read
            .recv_timeout(Duration::from_secs(30))
            .expect("the request reached its disk read");
        let (tx, rx) = mpsc::channel();
        s.spawn(move || {
            tx.send(
                registry
                    .lock()
                    .unwrap()
                    .handle(crate::api::Request::Snapshot)
                    .is_ok(),
            )
        });
        // 30 s: a starved host must not read as the lock being held again (the bug waits forever).
        let answered = rx.recv_timeout(Duration::from_secs(30)) == Ok(true);
        release.send(()).unwrap();
        (answered, asking.join().unwrap())
    });
    (answered, out, registry, home)
}

// Q9 en-b-J6-2: a project folder added to the tree is checked on disk off the registry lock.
#[test]
fn tree_add_folder_check_holds_no_registry_lock() {
    let (answered, out, registry, home) = snapshot_answered_while_stalled(
        "tree-add",
        |hook| crate::tree::IN_DISK_CHECK.set(Some(hook)),
        |home| serde_json::json!({ "op": "tree_edit", "edit": { "op": "add", "project": home, "added": true } }),
    );
    assert!(answered, "a snapshot waited on the folder check");
    assert!(out["response"]["Ok"].is_object(), "{out}");
    drop(registry);
    let _ = std::fs::remove_dir_all(&home);
}

// Ticket 1040: a Locate's picked folder is checked on disk off the registry lock, as an added one.
#[test]
fn project_locate_folder_check_holds_no_registry_lock() {
    let (answered, out, registry, home) = snapshot_answered_while_stalled(
        "project-locate",
        |hook| crate::tree::IN_DISK_CHECK.set(Some(hook)),
        |home| serde_json::json!({ "op": "project_locate", "from": "/nowhere/old", "to": home }),
    );
    assert!(answered, "a snapshot waited on the folder check");
    assert_eq!(out["response"]["Err"], "unknown project", "{out}");
    drop(registry);
    let _ = std::fs::remove_dir_all(&home);
}

// Q9 en-b-J7-1: a Codex start reads its sandbox config while it is prepared, off the registry lock.
#[test]
fn codex_start_sandbox_read_holds_no_registry_lock() {
    use crate::api::AgentKind;
    use std::os::unix::fs::PermissionsExt;
    let (answered, out, registry, home) = snapshot_answered_while_stalled(
        "codex-start",
        |hook| crate::codex_sandbox::IN_READ.set(Some(hook)),
        |home| {
            // An approved fake `codex` that answers --version and then reads stdin. Ticket 1150: and says yes
            // when the core asks it, before the start, whether it runs the outward hook.
            let codex = home.join("codex");
            let fixture = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/codex-app-server"
            );
            let script = format!(
                "#!/bin/sh\n[ \"$1\" != app-server ] || exec '{fixture}'\n[ \"$1\" = --version ] && {{ echo 'codex-cli 0.161.0'; exit 0; }}\nexec cat >/dev/null\n"
            );
            std::fs::write(&codex, script).unwrap();
            std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o700)).unwrap();
            let path = codex.to_str().unwrap().to_string();
            let check =
                crate::approval::command_check(home, AgentKind::Codex, path, vec![], vec![])
                    .unwrap();
            crate::approval::command_grant(home, AgentKind::Codex, check.hash.as_deref().unwrap())
                .unwrap();
            serde_json::json!({ "op": "start", "session": {
                "kind": "codex", "project": home, "args": ["-s", "read-only"], "model": null, "effort": null, "resume": null,
            } })
        },
    );
    assert!(answered, "a snapshot waited on the Codex sandbox read");
    assert_eq!(out["response"]["Ok"]["type"], "started", "{out}");
    let _ = registry
        .into_inner()
        .unwrap()
        .handle(crate::api::Request::Stop);
    let _ = std::fs::remove_dir_all(&home);
}
