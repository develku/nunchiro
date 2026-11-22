//! Ticket 431: "Your own" checks whose windows close while they wait. Each closed window's check jobs (one runs the
//! status command, the rest join it) keep that window's connection place until they end, so a client that opens a
//! window, asks for checks and closes, again and again, holds at most the connection cap; once the check lands, the core
//! is back to the threads it started with and every place is free. Against a real `nunchiro serve` with a fake `claude`.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::Request, server::call};
use serde_json::Value;
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket, client::IntoClientRequest, http::HeaderValue};

/// `http::MAX_CONNECTIONS` and `http::MAX_JOBS` (crate-private).
const MAX_CONNECTIONS: usize = 8;
const MAX_JOBS: usize = 4;
/// A status command that takes 3 s, so the check's joiners outlive their windows; it logs each run.
const SLOW_STATUS: &str = "#!/bin/sh\ncase \"$1\" in --version) echo 2.1.311; exit 0;; esac\n\
[ \"$1 $2\" = \"auth status\" ] || exit 2\necho run >> \"$HOME/probes.log\"\nsleep 3\n\
echo '{\"loggedIn\": true}'\nexit 0\n";

/// The core process's thread count, from the kernel.
fn threads(pid: u32) -> i32 {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTASKINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    assert_eq!(n, size);
    info.pti_threadnum
}

/// A window connection, or `None` when the core refuses it ("too many windows").
fn window(port: u16, token: &str) -> Option<WebSocket<TcpStream>> {
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Origin", HeaderValue::from_static("tauri://localhost"));
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
    );
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut ws = tungstenite::client(req, stream).ok()?.0;
    ws.read().unwrap(); // the layout event: the connection is served
    Some(ws)
}

/// The reply to frame `id`.
fn reply(ws: &mut WebSocket<TcpStream>, id: u64) -> Value {
    loop {
        if let Message::Text(text) = ws.read().unwrap() {
            let v: Value = serde_json::from_str(&text).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}

#[test]
fn closed_windows_check_joiners_are_counted_and_end() {
    let dir = home::short("chk");
    let (bin, user, config) = (dir.join("bin"), dir.join("u"), dir.join("u/.claude"));
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&config).unwrap();
    fs::write(bin.join("claude"), SLOW_STATUS).unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let core = home::spawn_serve(
        &dir,
        &[
            ("PATH", &path),
            ("HOME", user.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
        ],
    );
    let pid = core.child.id();
    let auth: Value = serde_json::to_value(call(&dir, Request::WindowAuth).unwrap()).unwrap();
    let (port, token) = (
        auth["port"].as_u64().unwrap() as u16,
        auth["token"].as_str().unwrap().to_string(),
    );
    thread::sleep(Duration::from_millis(300)); // the core's start-up work settles
    let start = threads(pid);
    // Churn: each accepted window asks MAX_JOBS checks (the first starts the probe, the rest join it) and closes.
    let (mut accepted, mut refused) = (0, 0);
    for round in 0..30u64 {
        let Some(mut ws) = window(port, &token) else {
            refused += 1;
            continue;
        };
        accepted += 1;
        for i in 0..MAX_JOBS as u64 {
            let frame = format!(
                r#"{{"id":{},"request":{{"op":"account_check","agent":"claude","force":true}}}}"#,
                round * 10 + i
            );
            ws.send(Message::Text(frame.into())).unwrap();
        }
        // Answered in order after the check frames: every check frame has been handled.
        ws.send(Message::Text(
            r#"{"id":9999,"request":{"op":"list"}}"#.into(),
        ))
        .unwrap();
        reply(&mut ws, 9999);
    }
    let held = threads(pid) - start;
    let until = Instant::now() + Duration::from_secs(30);
    while threads(pid) > start && Instant::now() < until {
        thread::sleep(Duration::from_millis(50));
    }
    let end = threads(pid);
    // The detached jobs held their windows' places: the churn was refused once the cap was reached.
    assert!(
        accepted <= MAX_CONNECTIONS && refused > 0,
        "{accepted} churned windows let in, {refused} refused"
    );
    assert!(
        held <= (MAX_CONNECTIONS * (1 + MAX_JOBS)) as i32,
        "{held} threads more than at the start"
    );
    assert!(
        end <= start,
        "{end} threads at the end, {start} at the start"
    );
    // Every place is free again: all MAX_CONNECTIONS windows get in (a close is seen a moment later).
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let open: Vec<_> = (0..MAX_CONNECTIONS)
            .filter_map(|_| window(port, &token))
            .collect();
        if open.len() == MAX_CONNECTIONS {
            break;
        }
        assert!(Instant::now() < until, "only {} windows got in", open.len());
        drop(open);
        thread::sleep(Duration::from_millis(50));
    }
    // One status run served every window's checks (the forced ones joined it).
    let runs = fs::read_to_string(user.join("probes.log")).unwrap_or_default();
    assert_eq!(runs.lines().count(), 1, "{runs}");
}
