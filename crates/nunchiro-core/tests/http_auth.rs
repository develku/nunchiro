//! Loopback window API: token, Origin allowlist and the terminal stream (spec Local API, Acceptance 11).
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with_env(&[])
    }
    fn with_env(env: &[(&str, &str)]) -> Self {
        let home = home::short("ha");
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists()
            || !matches!(
                call(&core.home, Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            )
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn window(&self) -> (u16, String) {
        let v: serde_json::Value =
            serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        (
            v["port"].as_u64().unwrap() as u16,
            v["token"].as_str().unwrap().to_string(),
        )
    }
    /// Handshake with explicit headers; `None` leaves a header out.
    fn dial(
        &self,
        origin: Option<&str>,
        protocols: Option<&str>,
        path: &str,
    ) -> Result<tungstenite::WebSocket<TcpStream>, u16> {
        let (port, _) = self.window();
        let mut req = format!("ws://127.0.0.1:{port}{path}")
            .into_client_request()
            .unwrap();
        if let Some(o) = origin {
            req.headers_mut()
                .insert("Origin", HeaderValue::from_str(o).unwrap());
        }
        if let Some(p) = protocols {
            req.headers_mut()
                .insert("Sec-WebSocket-Protocol", HeaderValue::from_str(p).unwrap());
        }
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        match tungstenite::client(req, stream) {
            Ok((ws, _)) => Ok(ws),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => {
                Err(r.status().as_u16())
            }
            Err(e) => panic!("unexpected handshake error: {e}"),
        }
    }
    fn good(&self) -> tungstenite::WebSocket<TcpStream> {
        let (_, token) = self.window();
        self.dial(
            Some(ORIGIN),
            Some(&format!("nunchiro.v1, nunchiro.token.{token}")),
            "/ws",
        )
        .expect("authorized dial")
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn reply(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64) -> serde_json::Value {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < until, "no reply for {id}");
        if let Message::Text(t) = ws.read().unwrap() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}
fn send(ws: &mut tungstenite::WebSocket<TcpStream>, v: serde_json::Value) {
    ws.send(Message::Text(v.to_string().into())).unwrap();
}

#[test]
fn token_file_is_owner_only_and_names_a_loopback_port() {
    let core = Core::new();
    let mode = fs::metadata(core.home.join("window.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    let (port, token) = core.window();
    assert!(port > 0);
    assert!(token.len() >= 64, "token must carry at least 256 bits");
}

#[test]
fn authorized_window_gets_snapshot_and_replies() {
    let core = Core::new();
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":1,"request":{"op":"snapshot"}}),
    );
    assert_eq!(reply(&mut ws, 1)["Ok"]["type"], "snapshot");
}

#[test]
fn missing_token_is_refused() {
    let core = Core::new();
    assert_eq!(
        core.dial(Some(ORIGIN), Some("nunchiro.v1"), "/ws").err(),
        Some(401)
    );
    assert_eq!(core.dial(Some(ORIGIN), None, "/ws").err(), Some(401));
}

#[test]
fn wrong_token_is_refused() {
    let core = Core::new();
    let (_, token) = core.window();
    let wrong = format!("{}0", &token[..token.len() - 1]);
    let wrong = if wrong == token {
        token.replace('a', "b")
    } else {
        wrong
    };
    assert_eq!(
        core.dial(
            Some(ORIGIN),
            Some(&format!("nunchiro.v1, nunchiro.token.{wrong}")),
            "/ws"
        )
        .err(),
        Some(401)
    );
}

#[test]
fn token_in_url_does_not_authenticate() {
    let core = Core::new();
    let (_, token) = core.window();
    assert_eq!(
        core.dial(
            Some(ORIGIN),
            Some("nunchiro.v1"),
            &format!("/ws?token={token}")
        )
        .err(),
        Some(401)
    );
}

#[test]
fn wrong_null_opaque_or_missing_origin_is_refused() {
    let core = Core::new();
    let (_, token) = core.window();
    let protocols = format!("nunchiro.v1, nunchiro.token.{token}");
    for origin in [
        Some("http://evil.example"),
        Some("null"),
        Some("file://"),
        Some("http://127.0.0.1:4174"),
        Some("http://127.0.0.1:4173.evil.example"),
        None,
    ] {
        assert_eq!(
            core.dial(origin, Some(&protocols), "/ws").err(),
            Some(403),
            "origin {origin:?} must be refused"
        );
    }
}

// v1a-38b: scrollback_edit is a window op; only the window token reaches it.
#[test]
fn scrollback_edit_needs_the_window_token() {
    let core = Core::new();
    let session = start_shell(&core, "/bin/cat");
    let (_, token) = core.window();
    let owner = fs::read_to_string(core.home.join("core.token")).unwrap();
    let wrong = format!("{}x", &token[..token.len() - 1]);
    for protocols in [
        "nunchiro.v1".to_string(),
        format!("nunchiro.v1, nunchiro.token.{wrong}"),
        format!("nunchiro.v1, nunchiro.token.{}", owner.trim()),
    ] {
        assert_eq!(
            core.dial(Some(ORIGIN), Some(&protocols), "/ws").err(),
            Some(401),
            "{protocols}"
        );
    }
    assert!(!core.home.join("exports").exists());
    // With it, the op runs (a bad id still answers with an error and writes nothing).
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":9,"request":{"op":"scrollback_edit","id":"../x"}}),
    );
    assert_eq!(reply(&mut ws, 9)["Err"], "invalid session id");
    // Extra fields are not part of the op: no path, editor or argv rides along.
    send(
        &mut ws,
        serde_json::json!({"id":10,"request":{"op":"scrollback_edit","id":session.id,"args":["/bin/sh"]}}),
    );
    send(
        &mut ws,
        serde_json::json!({"id":11,"request":{"op":"list"}}),
    );
    assert!(reply(&mut ws, 11).get("Ok").is_some());
    assert!(!core.home.join("exports").exists());
}

#[test]
fn hook_and_stop_are_not_window_requests() {
    let core = Core::new();
    let mut ws = core.good();
    send(&mut ws, serde_json::json!({"id":7,"request":{"op":"stop"}}));
    assert!(reply(&mut ws, 7)["Err"].is_string());
    send(
        &mut ws,
        serde_json::json!({"id":8,"request":{"op":"hook","id":"x","event":"Stop","payload":{}}}),
    );
    assert!(reply(&mut ws, 8)["Err"].is_string());
    assert!(matches!(
        call(&core.home, Request::Snapshot),
        Ok(Reply::Snapshot { .. })
    ));
}

#[test]
fn watched_terminal_streams_output_and_replays_scrollback() {
    let core = Core::new();
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: "cat".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let text = "눈치로 한글 입력 확인: 가나다 똠방각하 읽었어요";
    let collect = |ws: &mut tungstenite::WebSocket<TcpStream>| {
        let mut out = Vec::new();
        let until = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&out).contains(text) {
            assert!(Instant::now() < until, "no echo");
            if let Ok(Message::Binary(b)) = ws.read() {
                let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
                let head: serde_json::Value = serde_json::from_slice(&b[4..4 + n]).unwrap();
                assert_eq!(head["session"], session.id.as_str());
                out.extend_from_slice(&b[4 + n..]);
            }
        }
    };
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":1,"watch":session.id,"after":0}),
    );
    send(
        &mut ws,
        serde_json::json!({"id":2,"request":{"op":"send_text","id":session.id,"text":format!("{text}\n")}}),
    );
    collect(&mut ws);
    drop(ws);
    // A new window connection replays the scrollback from byte 0.
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":1,"watch":session.id,"after":0}),
    );
    collect(&mut ws);
}

/// The window loop wakes on PTY output; its idle tick is not what delivers it. With the tick set to 60 s
/// (NUNCHIRO_WINDOW_TICK_MS) and the output produced 0.5 s after the loop went idle (the tty's own echo is
/// ignored), a loop without the wake-up would show nothing for the whole wait; with it the output arrives in
/// ~0.5 s, so 10 s is slack for any host.
#[test]
fn an_echo_does_not_wait_for_the_loop_tick() {
    let core = Core::with_env(&[("NUNCHIRO_WINDOW_TICK_MS", "60000")]);
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: "late".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "read x; sleep 0.5; echo late-$x".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":1,"watch":session.id,"after":0}),
    );
    send(
        &mut ws,
        serde_json::json!({"id":2,"request":{"op":"send_text","id":session.id,"text":"tick-free\n"}}),
    );
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains("late-tick-free") {
        if let Message::Binary(b) = ws.read().expect("echo not delivered within 10 s") {
            let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
            seen.extend_from_slice(&b[4 + n..]);
        }
    }
}

#[test]
fn server_never_binds_beyond_loopback() {
    // Port of Orca's websocket-server-bind-scan: any wildcard bind in the HTTP layer fails.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/http");
    for entry in fs::read_dir(dir).unwrap() {
        let src = fs::read_to_string(entry.unwrap().path()).unwrap();
        for bad in ["0.0.0.0", "\"::\"", "[::]", "UNSPECIFIED"] {
            assert!(!src.contains(bad), "wildcard bind `{bad}` in http layer");
        }
    }
}

fn start_shell(core: &Core, program: &str) -> Session {
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: "s".into(),
                args: vec![program.into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    session
}

#[test]
fn slow_unauthenticated_sockets_cannot_lock_the_owner_out() {
    use std::io::Write;
    let core = Core::new();
    let (port, _) = core.window();
    // Slowloris: many sockets that trickle a byte now and then and never finish the handshake.
    let mut slow: Vec<TcpStream> = (0..12)
        .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
        .collect();
    for s in &mut slow {
        s.write_all(b"GET /ws HTTP/1.1\r\n").unwrap();
    }
    thread::sleep(Duration::from_millis(200));
    let mut ws = core.good();
    // v1a-17: the slow sockets hold their handshakes until the core's 3 s deadline closes them. Each still open
    // shows the owner got in beside them, not after they expired.
    for s in &slow {
        s.set_nonblocking(true).unwrap();
        let open = matches!(s.peek(&mut [0]), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock);
        s.set_nonblocking(false).unwrap();
        assert!(open, "the owner waited for a slow socket to expire");
    }
    send(
        &mut ws,
        serde_json::json!({"id":1,"request":{"op":"snapshot"}}),
    );
    assert_eq!(reply(&mut ws, 1)["Ok"]["type"], "snapshot");
    // The handshake has a total deadline: trickling bytes does not keep a socket open past it.
    let mut victim = slow.pop().unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    let closed = loop {
        if victim.write_all(b"X").is_err() || Instant::now() > until {
            break Instant::now() <= until;
        }
        thread::sleep(Duration::from_millis(300));
    };
    assert!(
        closed,
        "trickling socket stayed open past the handshake deadline"
    );
}

#[test]
fn a_window_that_never_reads_is_dropped_and_frees_its_slot() {
    let core = Core::new();
    // v1a-13 r2: a firehose the test switches off. While it runs, every waiting-observer pass feeds up to 1 MiB
    // through the screen parser under the registry lock, so a request can wait seconds on a loaded host; the probe
    // below runs only after the output stopped.
    // v1a-21: bounded (at most 256 MiB, then it stops by itself), switched off by the stop file, and it confirms
    // its stop with a file and a last output marker.
    let firehose = core.home.join("firehose.sh");
    fs::write(
        &firehose,
        "#!/bin/sh\nhead -c 1048576 /dev/zero | tr '\\0' '\\n' > \"$0.chunk\"\ni=0\nwhile [ $i -lt 256 ] && [ ! -f \"$0.stop\" ]; do cat \"$0.chunk\"; i=$((i+1)); done\nprintf 'FIREHOSE-%s\\n' STOPPED\n: > \"$0.stopped\"\nexec sleep 600\n",
    )
    .unwrap();
    fs::set_permissions(&firehose, fs::Permissions::from_mode(0o700)).unwrap();
    // Stops the firehose when the test panics before it switches it off.
    struct StopOnDrop(PathBuf);
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "");
        }
    }
    let stop = StopOnDrop(core.home.join("firehose.sh.stop"));
    let session = start_shell(&core, firehose.to_str().unwrap());
    // Fill every authenticated slot with clients that watch a firehose and never read.
    let stuck: Vec<_> = (0..8)
        .map(|_| {
            let mut ws = core.good();
            send(
                &mut ws,
                serde_json::json!({"id":1,"watch":session.id,"after":0}),
            );
            ws
        })
        .collect();
    // The server's send blocks only once the kernel socket buffers are full (size varies with load);
    // from then on the 2 s write timeout drops the reader.
    let until = Instant::now() + Duration::from_secs(20);
    let mut ws = loop {
        let (_, token) = core.window();
        if let Ok(ws) = core.dial(
            Some(ORIGIN),
            Some(&format!("nunchiro.v1, nunchiro.token.{token}")),
            "/ws",
        ) {
            break ws;
        }
        assert!(Instant::now() < until, "stuck readers kept every slot");
        thread::sleep(Duration::from_millis(200));
    };
    // A slot was freed. Stop the output; the firehose confirms its stop, then the output is read to its marker.
    // The deadlines only turn a hang into a failure.
    drop(stop);
    let until = Instant::now() + Duration::from_secs(20);
    while !core.home.join("firehose.sh.stopped").exists() {
        assert!(
            Instant::now() < until,
            "the firehose did not confirm its stop"
        );
        thread::sleep(Duration::from_millis(20));
    }
    loop {
        let Ok(Reply::Output { data, .. }) = call(
            &core.home,
            Request::Read {
                id: session.id.clone(),
                after: 0,
            },
        ) else {
            panic!("session read failed");
        };
        if data.windows(16).any(|w| w == b"FIREHOSE-STOPPED") {
            break;
        }
        assert!(
            Instant::now() < until,
            "the stop marker never reached the output"
        );
        thread::sleep(Duration::from_millis(20));
    }
    send(
        &mut ws,
        serde_json::json!({"id":2,"request":{"op":"snapshot"}}),
    );
    assert_eq!(reply(&mut ws, 2)["Ok"]["type"], "snapshot");
    drop(stuck);
}

#[test]
fn watch_needs_an_existing_session_and_is_bounded() {
    let core = Core::new();
    let mut ws = core.good();
    send(
        &mut ws,
        serde_json::json!({"id":1,"watch":"no-such-session","after":0}),
    );
    assert!(reply(&mut ws, 1)["Err"].is_string());
    let session = start_shell(&core, "/bin/cat");
    send(
        &mut ws,
        serde_json::json!({"id":2,"watch":session.id,"after":0}),
    );
    assert!(reply(&mut ws, 2)["Ok"].is_object());
    // Re-watching the same session replaces its cursor; the map never grows past its bound.
    send(
        &mut ws,
        serde_json::json!({"id":99,"watch":session.id,"after":0}),
    );
    assert!(reply(&mut ws, 99)["Ok"].is_object());
}

#[test]
fn the_first_frame_after_a_watch_marks_the_replay_even_when_empty() {
    let core = Core::new();
    let session = start_shell(&core, "/bin/cat");
    let mut ws = core.good();
    let next_head = |ws: &mut tungstenite::WebSocket<TcpStream>| loop {
        if let Message::Binary(b) = ws.read().unwrap() {
            let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
            break serde_json::from_slice::<serde_json::Value>(&b[4..4 + n]).unwrap();
        }
    };
    send(
        &mut ws,
        serde_json::json!({"id":1,"watch":session.id,"after":0}),
    );
    let first = next_head(&mut ws);
    assert_eq!(first["replay"], true);
    assert_eq!(first["start"], first["end"], "nothing written yet");
    send(
        &mut ws,
        serde_json::json!({"id":2,"request":{"op":"send_text","id":session.id,"text":"live\n"}}),
    );
    assert_eq!(next_head(&mut ws)["replay"], false);
}

/// v1a-27 S1: one session streaming output without a pause (2 KB bursts a millisecond apart: unpaced, the observer's
/// parse took 70 to 90 ms of the 100 ms bound by itself and 130 to 150 ms on a loaded host; a loop that ends when the
/// test creates its stop file, then it sleeps) must not slow owner requests that take the registry lock. Seven windows watch a quiet
/// session and one watches the stream. Method (V1A-80): the median of 30 owner `read` calls while the stream runs
/// against the larger of two idle medians, one before the stream and one after `FLOOD-DONE`, so ambient load that
/// moves between the measurements counts on the idle side; bound 5x, from at least 20 ms. The owner socket's own
/// accept loop sets the idle figure and the waiting observer's parse under the registry dominates the flood figure,
/// so this guards against gross contention only (it passed before v1a-27 too: 12.9 to 66.5 ms flood medians);
/// `http::tests` counts the window loop's registry locks directly.
#[test]
fn an_owner_request_stays_fast_while_one_session_floods() {
    fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(30);
        while !ready() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }
    let core = Core::new();
    let stop_file = core.home.join("flood.stop");
    let flood = core.home.join("flood.sh");
    fs::write(
        &flood,
        format!(
            "#!/bin/sh\nread go\nexec /usr/bin/perl -e '$|=1; while (!-e $ARGV[0]) {{ print((\"x\" x 100, \"\\n\") x 20); select(undef,undef,undef,0.001) }} print \"FLOOD-DONE\\n\"; sleep 600' {}\n",
            stop_file.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&flood, fs::Permissions::from_mode(0o700)).unwrap();
    let flood = start_shell(&core, flood.to_str().unwrap());
    let quiet = start_shell(&core, "/bin/cat");
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let readers: Vec<_> = (0..8)
        .map(|i| {
            let mut ws = core.good();
            let id = if i == 0 { &flood.id } else { &quiet.id };
            send(&mut ws, serde_json::json!({"id":1,"watch":id,"after":0}));
            ws.get_mut()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            let stop = stop.clone();
            thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    match ws.read() {
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            })
        })
        .collect();
    let median = || {
        let mut t: Vec<Duration> = (0..30)
            .map(|_| {
                let at = Instant::now();
                assert!(matches!(
                    call(
                        &core.home,
                        Request::Read {
                            id: quiet.id.clone(),
                            after: 0
                        }
                    ),
                    Ok(Reply::Output { .. })
                ));
                let took = at.elapsed();
                thread::sleep(Duration::from_millis(20));
                took
            })
            .collect();
        t.sort();
        t[15]
    };
    let flooded = |done: bool| {
        let Ok(Reply::Output { data, .. }) = call(
            &core.home,
            Request::Read {
                id: flood.id.clone(),
                after: 0,
            },
        ) else {
            panic!()
        };
        data.windows(10).any(|w| w == b"FLOOD-DONE") == done
    };
    let idle_before = median();
    call(
        &core.home,
        Request::SendText {
            id: flood.id.clone(),
            text: "go\n".into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
    // The stream has started when flood lines show (the typed `go` is echoed, so any output proves nothing), and it
    // runs until the stop file: it cannot end under the samples.
    wait_until("the stream starts", || {
        matches!(
            call(&core.home, Request::Read { id: flood.id.clone(), after: 0 }),
            Ok(Reply::Output { data, .. }) if data.windows(8).any(|w| w == b"xxxxxxxx")
        )
    });
    let busy = median();
    assert!(flooded(false), "the stream ended before the samples did");
    fs::write(&stop_file, "").unwrap();
    wait_until("FLOOD-DONE", || flooded(true));
    let idle_after = median();
    let idle = idle_before.max(idle_after);
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    for r in readers {
        r.join().unwrap();
    }
    let Ok(Reply::Output { end, .. }) = call(
        &core.home,
        Request::Read {
            id: flood.id.clone(),
            after: 0,
        },
    ) else {
        panic!()
    };
    eprintln!(
        "v1a-27 owner read median: idle {idle_before:?} then {idle_after:?}, flood {busy:?}, flood bytes {end}"
    );
    // The flood was real: it measured 2.06 MB (2064496 bytes) on the mini; a quarter of that, 512 KB, still fails a
    // stalled flood and leaves room for a slow host (the size grows with how long the samples run).
    assert!(end >= 512 << 10, "the flood sent only {end} bytes");
    // The idle median swings between about 8 and 45 ms with the accept loop's 10 ms sleep and the observer's
    // 50 ms tick, so the 5x bound starts from at least 20 ms.
    assert!(
        busy < idle.max(Duration::from_millis(20)) * 5,
        "idle {idle:?}, flood {busy:?}"
    );
}

/// V2.5-17 r2: the window snapshot reads the state the registry tick keeps current; a real change (the session's process
/// exits) still reaches the window as the next pushed snapshot, within the 100 ms snapshot cadence plus one 50 ms tick.
/// Measured ~106 ms; the 1.5 s bound catches a lost push or a slow fallback cadence, not host load.
#[test]
fn snapshot_change_latency_unchanged() {
    let core = Core::new();
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: "exits".into(),
                args: vec!["/bin/sh".into(), "-c".into(), "read x; exit 0".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let mut ws = core.good();
    let state = |v: &serde_json::Value| {
        v["sessions"]
            .as_array()
            .and_then(|s| s.iter().find(|s| s["id"] == session.id.as_str()))
            .map(|s| s["state"].clone())
    };
    loop {
        let Message::Text(t) = ws.read().unwrap() else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        if v["event"] == "snapshot" && state(&v) == Some("running".into()) {
            break;
        }
    }
    send(
        &mut ws,
        serde_json::json!({"id":1,"request":{"op":"send_text","id":session.id,"text":"\n"}}),
    );
    let sent = Instant::now();
    let latency = loop {
        assert!(
            sent.elapsed() < Duration::from_secs(5),
            "exit never reached the window"
        );
        let Message::Text(t) = ws.read().unwrap() else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        if v["event"] == "snapshot" && state(&v).is_some_and(|s| s != "running") {
            break sent.elapsed();
        }
    };
    eprintln!("snapshot_change_latency_unchanged: {latency:?}");
    assert!(
        latency < Duration::from_millis(1500),
        "exit reached the window after {latency:?}"
    );
}
