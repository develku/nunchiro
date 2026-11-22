//! Ticket 421: window connection churn against a real `nunchiro serve`. A client that opens a window, starts slow
//! off-loop jobs and closes, again and again, holds at most the connection cap; another window's own jobs still run,
//! and once the jobs end the core is back to the threads it started with. The core is its own process, so its thread
//! count is not shared with other tests.
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
/// Each `first_run` job runs both fakes' `--version`: about 4 s of one job thread.
const SLOW_VERSION: &str = "#!/bin/sh\n[ \"$1\" = --version ] && sleep 2 && echo 1.0\nexit 0\n";

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

/// The window port and token the core hands its owner.
fn auth(dir: &std::path::Path) -> (u16, String) {
    let auth: Value = serde_json::to_value(call(dir, Request::WindowAuth).unwrap()).unwrap();
    (
        auth["port"].as_u64().unwrap() as u16,
        auth["token"].as_str().unwrap().to_string(),
    )
}

#[test]
fn connection_churn_keeps_job_threads_bounded() {
    let dir = home::short("churn");
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    for name in ["claude", "codex"] {
        fs::write(bin.join(name), SLOW_VERSION).unwrap();
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let core = home::spawn_serve(&dir, &[("PATH", &path)]);
    let pid = core.child.id();
    let (port, token) = auth(&dir);
    thread::sleep(Duration::from_millis(300)); // the core's start-up work settles
    let start = threads(pid);
    let mut keeper = window(port, &token).expect("the first window");
    // Churn: each accepted window starts MAX_JOBS slow jobs and closes at once.
    let (mut accepted, mut refused) = (0, 0);
    for round in 0..30u64 {
        let Some(mut ws) = window(port, &token) else {
            refused += 1;
            continue;
        };
        accepted += 1;
        for i in 0..MAX_JOBS as u64 {
            let frame = format!(
                r#"{{"id":{},"request":{{"op":"first_run"}}}}"#,
                round * 10 + i
            );
            ws.send(Message::Text(frame.into())).unwrap();
        }
        // Answered in order after the job frames: every job frame has been handled.
        ws.send(Message::Text(
            r#"{"id":9999,"request":{"op":"list"}}"#.into(),
        ))
        .unwrap();
        reply(&mut ws, 9999);
    }
    let held = threads(pid) - start;
    // The other window's own off-loop request still gets a job place and its answer.
    keeper
        .send(Message::Text(
            r#"{"id":1,"request":{"op":"first_run"}}"#.into(),
        ))
        .unwrap();
    let answer = reply(&mut keeper, 1);
    drop(keeper);
    let until = Instant::now() + Duration::from_secs(30);
    while threads(pid) > start && Instant::now() < until {
        thread::sleep(Duration::from_millis(50));
    }
    let end = threads(pid);
    assert!(
        answer.get("Ok").is_some(),
        "the other window's job: {answer}"
    );
    assert!(
        accepted < MAX_CONNECTIONS,
        "{accepted} churned windows were let in while their jobs ran ({refused} refused)"
    );
    // Every connection place in use, each with its serve thread and all its job threads.
    assert!(
        held <= (MAX_CONNECTIONS * (1 + MAX_JOBS)) as i32,
        "{held} threads more than at the start"
    );
    assert!(
        end <= start,
        "{end} threads at the end, {start} at the start"
    );
}

/// Ticket 421 round 3: a job that would wait forever keeps its connection's place (the lease) forever. `agents.toml` as
/// a FIFO with no writer was such a job (a plain open waits for a writer); now the AcpAgents request answers with the
/// loader's error at once, and once the window closes every connection place is free again.
#[test]
fn a_fifo_agents_toml_answers_at_once_and_frees_the_place() {
    let dir = home::short("fifo");
    let fifo = std::ffi::CString::new(
        dir.join("agents.toml")
            .into_os_string()
            .into_encoded_bytes(),
    )
    .unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let _core = home::spawn_serve(&dir, &[]);
    let (port, token) = auth(&dir);
    let mut ws = window(port, &token).expect("a window");
    ws.send(Message::Text(
        r#"{"id":1,"request":{"op":"acp_agents"}}"#.into(),
    ))
    .unwrap();
    let asked = Instant::now();
    let answer = reply(&mut ws, 1); // a hung job fails here, at the 20 s read timeout
    let took = asked.elapsed();
    drop(ws);
    assert_eq!(answer["Err"], "agents.toml: not a regular file", "{answer}");
    assert!(took < Duration::from_secs(5), "answered after {took:?}");
    // The closed window's place is free: all MAX_CONNECTIONS windows get in (its close is seen a moment later).
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
}
