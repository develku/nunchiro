//! Real owner transports, without starting any agent or editing the user's home.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, queue::Queue, server};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::net::UnixStream,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

struct Core {
    home: PathBuf,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}
impl Core {
    fn new() -> Self {
        let home = home::short("board-wire");
        let session: Value =
            serde_json::from_str::<Value>(include_str!("fixtures/board/snapshot-v1a.json"))
                .unwrap()["Ok"]["sessions"][0]
                .clone();
        fs::write(
            home.join("sessions.json"),
            json!({"version":1,"sessions":[session]}).to_string(),
        )
        .unwrap();
        Queue::open(&home)
            .unwrap()
            .register("s", AgentKind::Claude, 100)
            .unwrap();
        let path = home.clone();
        let mut core = Self {
            home,
            task: Some(thread::spawn(move || server::serve_recording(&path))),
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("core.sock").exists() || !core.home.join("window.json").exists() {
            if core.task.as_ref().unwrap().is_finished() {
                panic!(
                    "core failed: {:?}",
                    core.task.take().unwrap().join().unwrap()
                );
            }
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn raw(&self, request: Request) -> String {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut stream = UnixStream::connect(self.home.join("core.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = serde_json::to_vec(&Envelope { token, request }).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            self.raw(Request::Stop);
            assert!(task.join().unwrap().is_ok());
        }
        fs::remove_dir_all(&self.home).unwrap();
    }
}

#[test]
fn board_requests_keep_legacy_snapshot_wire_and_queue_bytes_identical() {
    let core = Core::new();
    let queue = fs::read(core.home.join("queue.json")).unwrap();
    assert_eq!(
        core.raw(Request::Snapshot),
        include_str!("fixtures/board/snapshot-v1a.json")
    );
    let board: Response = serde_json::from_str(&core.raw(Request::BoardSnapshot)).unwrap();
    assert!(matches!(board, Ok(Reply::BoardSnapshot { .. })));
    let created: Value = serde_json::from_str(&core.raw(Request::BoardPut {
        id: None,
        title: "Manual".into(),
        note: String::new(),
        session_id: Some("s".into()),
        column: None,
    }))
    .unwrap();
    assert_eq!(created["Ok"]["board"]["cards"].as_array().unwrap().len(), 2);
    assert_eq!(
        core.raw(Request::Snapshot),
        include_str!("fixtures/board/snapshot-v1a.json")
    );
    assert_eq!(fs::read(core.home.join("queue.json")).unwrap(), queue);
    fs::write(core.home.join("board.json"), b"[]").unwrap();
    assert_eq!(
        core.raw(Request::Snapshot),
        include_str!("fixtures/board/snapshot-v1a.json")
    );
    assert!(
        serde_json::from_str::<Response>(&core.raw(Request::BoardSnapshot))
            .unwrap()
            .is_err()
    );
    assert_eq!(fs::read(core.home.join("board.json")).unwrap(), b"[]");
    assert_eq!(fs::read(core.home.join("queue.json")).unwrap(), queue);
}

#[test]
fn board_requests_are_served_by_the_authenticated_window_transport() {
    let core = Core::new();
    let window: Value =
        serde_json::to_value(server::call(&core.home, Request::WindowAuth).unwrap()).unwrap();
    let port = window["port"].as_u64().unwrap();
    let mut request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("tauri://localhost"));
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!(
            "nunchiro.v1, nunchiro.token.{}",
            window["token"].as_str().unwrap()
        ))
        .unwrap(),
    );
    let stream = TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let (mut ws, _) = tungstenite::client(request, stream).unwrap();
    ws.send(Message::Text(
        json!({"id":1,"request":{"op":"board_snapshot"}})
            .to_string()
            .into(),
    ))
    .unwrap();
    loop {
        let Message::Text(text) = ws.read().unwrap() else {
            continue;
        };
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["id"] != 1 {
            continue;
        }
        assert_eq!(frame["response"]["Ok"]["type"], "board_snapshot");
        assert_eq!(
            frame["response"]["Ok"]["board"]["cards"][0]["session_id"],
            "s"
        );
        break;
    }
    ws.close(None).unwrap();
}

#[test]
fn board_drag_releases_on_a_state_change_between_board_reads() {
    let core = Core::new();
    let started: Value = serde_json::from_str(&core.raw(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: core.home.clone(),
            worktree: false,
            label: "Held".into(),
            args: vec!["/bin/sh".into(), "-c".into(), "read line".into()],
            model: None,
            effort: None,
            resume: None,
        },
    }))
    .unwrap();
    let id = started["Ok"]["session"]["id"].as_str().unwrap().to_owned();
    let moved: Response = serde_json::from_str(&core.raw(Request::BoardMove {
        source: nunchiro_core::board::Source::Session,
        id: id.clone(),
        column: "review".into(),
    }))
    .unwrap();
    assert!(moved.is_ok());
    for event in ["PermissionRequest", "UserPromptSubmit"] {
        let reply: Response = serde_json::from_str(&core.raw(Request::Hook {
            id: id.clone(),
            event: event.into(),
            payload: json!({}),
        }))
        .unwrap();
        assert!(reply.is_ok());
    }
    let board: Value = serde_json::from_str(&core.raw(Request::BoardSnapshot)).unwrap();
    let card = board["Ok"]["board"]["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap();
    assert_eq!(
        card["column"], "working",
        "waiting then working must release a held drag even without an intervening board read"
    );
}

#[test]
fn board_observer_resets_stale_context_without_changing_legacy_replies() {
    let core = Core::new();
    let reply: Response = serde_json::from_str(&core.raw(Request::BoardMove {
        source: nunchiro_core::board::Source::Session,
        id: "s".into(),
        column: "review".into(),
    }))
    .unwrap();
    assert!(reply.is_ok());
    let path = core.home.join("board.json");
    let good: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("seen", json!({"s":999})),
        ("held", {
            let mut held = good["held"].clone();
            held["s"]["completion_seq"] = json!(999);
            held
        }),
    ] {
        let mut bad = good.clone();
        bad["held"]["s"]["state"] = json!("working");
        bad[field] = value;
        let bytes = serde_json::to_vec(&bad).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            core.raw(Request::Snapshot),
            include_str!("fixtures/board/snapshot-v1a.json")
        );
        bad["seen"].as_object_mut().unwrap().remove("s");
        bad["held"].as_object_mut().unwrap().remove("s");
        let repaired: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            repaired, bad,
            "only stale markers should change for {field}"
        );
        assert!(matches!(
            serde_json::from_str::<Response>(&core.raw(Request::BoardSnapshot)).unwrap(),
            Ok(Reply::BoardSnapshot { .. })
        ));
        let stable = fs::read(&path).unwrap();
        core.raw(Request::Snapshot);
        assert_eq!(fs::read(&path).unwrap(), stable);
    }
}
