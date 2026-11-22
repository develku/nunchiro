//! v1a-40: after a core restart the window's watch of a stopped session replays its saved scrollback.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    net::TcpStream,
    path::Path,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";

fn serve(home: &Path) -> home::ServeGuard {
    home::spawn_serve(home, &[("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)])
}

#[test]
fn a_stopped_session_watch_replays_saved_scrollback_after_restart() {
    let home = home::short("sbw");
    let mut first = serve(&home);
    let Reply::Started { session } = call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.clone(),
                worktree: false,
                label: "mark".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'MARK-1'; exec /bin/cat".into(),
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
    let until = Instant::now() + Duration::from_secs(5);
    while !matches!(
        call(&home, Request::Read { id: session.id.clone(), after: 0 }),
        Ok(Reply::Output { ref data, .. }) if String::from_utf8_lossy(data).contains("MARK-1")
    ) {
        assert!(Instant::now() < until, "no MARK-1");
        thread::sleep(Duration::from_millis(20));
    }
    first.stop();
    let _second = serve(&home);

    let v = serde_json::to_value(call(&home, Request::WindowAuth).unwrap()).unwrap();
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
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (mut ws, _) = tungstenite::client(req, stream).unwrap();
    ws.send(Message::Text(
        serde_json::json!({"id":1,"watch":session.id,"after":0})
            .to_string()
            .into(),
    ))
    .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let frame = loop {
        assert!(Instant::now() < until, "no replay frame");
        match ws.read().unwrap() {
            Message::Binary(b) => break b,
            Message::Text(t) => assert!(!t.contains("unwatched"), "{t}"),
            _ => {}
        }
    };
    let n = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    let head: serde_json::Value = serde_json::from_slice(&frame[4..4 + n]).unwrap();
    assert_eq!(head["session"], session.id.as_str());
    assert_eq!(head["replay"], true);
    assert!(String::from_utf8_lossy(&frame[4 + n..]).contains("MARK-1"));
    drop(ws);
}
