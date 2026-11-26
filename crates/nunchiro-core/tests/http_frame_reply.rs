//! V2.5-37 follow-up: a window frame the core cannot parse is answered when its `id` is readable.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
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
        let home = home::short("fr");
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
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
    fn window(&self) -> tungstenite::WebSocket<TcpStream> {
        let v = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let port = v["port"].as_u64().unwrap() as u16;
        let token = v["token"].as_str().unwrap();
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static(ORIGIN));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // A 200 ms read timeout polls later reads only; the handshake gets the core's own bound.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let ws = tungstenite::client(req, stream).expect("authorized dial").0;
        ws.get_ref()
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        ws
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

fn send(ws: &mut tungstenite::WebSocket<TcpStream>, text: &str) {
    ws.send(Message::Text(text.to_string().into())).unwrap();
}

/// Every reply-shaped frame (one with an `id`) seen within `wait`.
fn replies(ws: &mut tungstenite::WebSocket<TcpStream>, wait: Duration) -> Vec<Value> {
    let until = Instant::now() + wait;
    let mut out = vec![];
    while Instant::now() < until {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("response").is_some() {
                    out.push(v);
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("socket failed: {e}"),
        }
    }
    out
}

fn only_error(got: &[Value], id: u64) -> String {
    let mine: Vec<_> = got.iter().filter(|v| v["id"] == id).collect();
    assert_eq!(mine.len(), 1, "one reply for {id}: {got:?}");
    mine[0]["response"]["Err"]
        .as_str()
        .unwrap_or_else(|| panic!("an error reply for {id}: {:?}", mine[0]))
        .to_string()
}

#[test]
fn bad_frame_with_id_gets_error() {
    let core = Core::new();
    let mut ws = core.window();
    send(&mut ws, r#"{"id": 7, "request": {"op": "board_undo"}}"#);
    send(&mut ws, r#"{"id": 8, "request": {"op": "no_such_op"}}"#);
    let got = replies(&mut ws, Duration::from_secs(1));
    let seven = only_error(&got, 7);
    let eight = only_error(&got, 8);
    assert!(!seven.contains("board_undo"), "no echo: {seven}");
    assert!(!eight.contains("no_such_op"), "no echo: {eight}");
}

#[test]
fn bad_frame_without_id_dropped() {
    let core = Core::new();
    let mut ws = core.window();
    send(&mut ws, "not json");
    send(&mut ws, r#"{"request": {}}"#);
    send(&mut ws, r#"{"id": 3, "request": {"op": "snapshot"}}"#);
    let got = replies(&mut ws, Duration::from_secs(1));
    assert_eq!(got.len(), 1, "only the valid frame is answered: {got:?}");
    assert_eq!(got[0]["id"], 3);
    assert_eq!(got[0]["response"]["Ok"]["type"], "snapshot");
}

#[test]
fn refused_undo_answers() {
    let core = Core::new();
    let mut ws = core.window();
    // The window's Undo on a card with nothing to undo (web/src/board/Board.tsx onUndo, api.ts send).
    send(
        &mut ws,
        &json!({"id": 4, "request": {"op": "board_undo", "id": "m-nothing"}}).to_string(),
    );
    let got = replies(&mut ws, Duration::from_secs(1));
    only_error(&got, 4);
}
