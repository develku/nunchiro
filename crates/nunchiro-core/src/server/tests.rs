use super::*;

/// Q9 en-a-J5-1: a connection thread that panics leaves no count behind, so a stop's wait still ends.
#[test]
fn a_panicking_connection_leaves_no_count() {
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ran = counted(&active, || panic!("handler panic")).unwrap();
    assert!(ran.join().is_err());
    assert_eq!(active.load(Ordering::SeqCst), 0);
}

/// Q9 en-a-J5-3: a session that ended within the last tick before a SIGTERM has its scrollback on disk after the
/// signal's exit, not left in the queue.
#[test]
fn exit_on_signal_writes_queued_scrollback() {
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("srv-signal-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/sh".into(), "-c".into(), "printf hello".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    drop(launch);
    let sessions = Mutex::new(core);
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !sessions.lock().unwrap().scrollback_pending() {
        sessions.lock().unwrap().handle(Request::Snapshot).unwrap();
        assert!(std::time::Instant::now() < until, "the shell never exited");
        thread::sleep(Duration::from_millis(20));
    }
    exit_on_signal(&home, &sessions);
    assert!(crate::scrollback::load(&home, &id).unwrap().is_some());
    assert!(home.join(STOPPED).exists());
    drop(sessions);
    let _ = fs::remove_dir_all(&home);
}

/// Ticket 305: a request that waited on the registry lock while a Stop or Exit ran has not run. It gets the
/// wind-down refusal (NOT_SERVED after an exit or a signal, which the CLI reruns on the next core;
/// NOT_SERVED_QUIT after a full stop), never the bare "core is stopping", which the CLI does not retry.
#[test]
fn a_request_queued_behind_a_stop_or_exit_is_not_served() {
    for (quit, expected) in [(false, NOT_SERVED), (true, NOT_SERVED_QUIT)] {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("srv-queued-{quit}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let sessions = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
        // The Stop or Exit has run and released the lock: both flags are set when this request takes it.
        let (stopping, quitting) = (Arc::new(AtomicBool::new(true)), AtomicBool::new(quit));
        let (mut client, mut server) = UnixStream::pair().unwrap();
        writeln!(
            client,
            "{}",
            serde_json::json!({"token": "t", "request": {"op": "list"}})
        )
        .unwrap();
        let window = (0, String::new());
        connection(
            &mut server,
            "t",
            &sessions,
            &stopping,
            &quitting,
            &home,
            &window,
        )
        .unwrap();
        drop(server);
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        let reply: Response = serde_json::from_str(&line).unwrap();
        assert_eq!(reply.unwrap_err(), expected, "quit: {quit}");
        let _ = fs::remove_dir_all(&home);
    }
}

/// Q9 en-b-J6-2, owner-socket path: an added folder is checked on disk before `connection` takes the registry
/// lock. While the check stalls (as on a hung mount), a snapshot from another thread is still answered.
#[test]
fn owner_socket_tree_add_checks_the_folder_off_the_registry_lock() {
    use std::sync::mpsc;
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("srv-tree-add-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let sessions = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
    let (stopping, quitting) = (Arc::new(AtomicBool::new(false)), AtomicBool::new(false));
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let request = serde_json::json!({ "op": "tree_edit", "edit": { "op": "add", "project": home, "added": true } });
    writeln!(
        client,
        "{}",
        serde_json::json!({ "token": "t", "request": request })
    )
    .unwrap();
    let (stalled, in_check) = mpsc::channel();
    let (release, gate) = mpsc::channel::<()>();
    let answered = thread::scope(|s| {
        let release = release; // dropped if a wait below fails, so the stalled check ends
        let (sessions, stopping, quitting, home) = (&sessions, &stopping, &quitting, &home);
        let serving = s.spawn(move || {
            crate::tree::IN_DISK_CHECK.set(Some(Box::new(move || {
                stalled.send(()).unwrap();
                let _ = gate.recv();
            })));
            connection(
                &mut server,
                "t",
                sessions,
                stopping,
                quitting,
                home,
                &(0, String::new()),
            )
        });
        in_check
            .recv_timeout(Duration::from_secs(30))
            .expect("the request reached its folder check");
        let (tx, rx) = mpsc::channel();
        s.spawn(move || tx.send(sessions.lock().unwrap().handle(Request::Snapshot).is_ok()));
        let answered = rx.recv_timeout(Duration::from_secs(30)) == Ok(true);
        release.send(()).unwrap();
        serving.join().unwrap().unwrap();
        answered
    });
    assert!(answered, "a snapshot waited on the folder check");
    let mut line = String::new();
    BufReader::new(client).read_line(&mut line).unwrap();
    let reply: Response = serde_json::from_str(&line).unwrap();
    assert!(reply.is_ok(), "{line}");
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn flock_failure_names_a_non_contention_errno() {
    let busy = std::io::Error::from_raw_os_error(libc::EWOULDBLOCK);
    assert_eq!(flock_failure(busy), "core already running");
    let other = flock_failure(std::io::Error::from_raw_os_error(libc::ENOLCK));
    assert!(
        other.contains("core.lock")
            && other.ends_with(&std::io::Error::from_raw_os_error(libc::ENOLCK).to_string()),
        "{other}"
    );
}
