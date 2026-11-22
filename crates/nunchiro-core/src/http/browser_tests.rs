//! V2.5-15: the browser listener over real sockets (docs/design/v25-web-access.md section 7, threat model section B).
use super::*;
use std::path::PathBuf;
use tungstenite::client::IntoClientRequest;

struct Core {
    home: PathBuf,
    stopping: Arc<AtomicBool>,
    window_port: u16,
    window_token: String,
    browser: Arc<Browser>,
    registry: Arc<Mutex<Sessions>>,
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(50));
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn core(tag: &str) -> Core {
    let home = std::env::temp_dir().join(format!("ns-browser-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    std::fs::write(home.join("machines.json"), r#"{"version":1,"machines":[]}"#).unwrap();
    let registry = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
    let stopping = Arc::new(AtomicBool::new(false));
    // No real interfaces: a test never binds this Mac's Tailscale address.
    set_scan(&home, Vec::new);
    let (window_port, window_token) =
        crate::http::spawn(&home, registry.clone(), stopping.clone()).unwrap();
    Core {
        registry,
        browser: of(&home),
        home,
        stopping,
        window_port,
        window_token,
    }
}

impl Core {
    /// Turns access on with an ephemeral port; returns the loopback address it bound.
    fn enable(&self) -> SocketAddr {
        let status = self.set(true);
        assert_eq!(status.problem, None);
        status.addresses[0].parse().unwrap()
    }
    fn set(&self, enabled: bool) -> Status {
        match self.browser.window_op(Op::Set {
            enabled,
            port: Some(0),
        }) {
            Ok(crate::api::Reply::BrowserAccess { status }) => status,
            other => panic!("{other:?}"),
        }
    }
    /// The whole approval: the browser asks, the Mac window allows, the browser polls its token.
    fn pair(&self, addr: SocketAddr, name: &str) -> String {
        let (status, _, body) = post_pair(addr, &format!("{addr}"), name);
        assert!(status.contains("200"), "{status} {body}");
        let id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        self.browser
            .window_op(Op::Answer {
                id: id.clone(),
                allow: true,
            })
            .unwrap();
        let (_, _, body) = get(addr, &format!("{addr}"), &format!("/pair/{id}"), &[]);
        let v: serde_json::Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["state"], "allowed");
        v["token"].as_str().unwrap().to_string()
    }
    fn window_ws(&self, token: &str) -> Result<Ws, tungstenite::Error> {
        let addr: SocketAddr = format!("127.0.0.1:{}", self.window_port).parse().unwrap();
        ws(
            addr,
            &format!("127.0.0.1:{}", self.window_port),
            Some("tauri://localhost"),
            token,
        )
    }
}

type Ws = tungstenite::WebSocket<TcpStream>;

fn raw(addr: SocketAddr, request: &str) -> (String, String, String) {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(request.as_bytes()).unwrap();
    let mut out = vec![];
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let (status, headers) = head.split_once("\r\n").unwrap_or((head, ""));
    (
        status.to_string(),
        headers.to_ascii_lowercase(),
        body.to_string(),
    )
}

fn get(addr: SocketAddr, host: &str, path: &str, extra: &[&str]) -> (String, String, String) {
    let extra: String = extra.iter().map(|h| format!("{h}\r\n")).collect();
    raw(
        addr,
        &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n"),
    )
}

fn post_pair(addr: SocketAddr, host: &str, name: &str) -> (String, String, String) {
    post(
        addr,
        host,
        &format!("http://{host}"),
        "application/json",
        name,
    )
}

fn post(
    addr: SocketAddr,
    host: &str,
    origin: &str,
    ctype: &str,
    name: &str,
) -> (String, String, String) {
    let body = serde_json::json!({ "name": name }).to_string();
    raw(
        addr,
        &format!(
            "POST /pair HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn ws(
    addr: SocketAddr,
    host: &str,
    origin: Option<&str>,
    token: &str,
) -> Result<Ws, tungstenite::Error> {
    let mut request = format!("ws://{host}/ws").into_client_request().unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("nunchiro.v1, nunchiro.token.{token}")
            .parse()
            .unwrap(),
    );
    let socket = TcpStream::connect(addr).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    tungstenite::client(request, socket)
        .map(|(ws, _)| ws)
        .map_err(|e| match e {
            tungstenite::HandshakeError::Failure(e) => e,
            tungstenite::HandshakeError::Interrupted(_) => panic!("interrupted"),
        })
}

fn browser_ws(addr: SocketAddr, token: &str) -> Result<Ws, tungstenite::Error> {
    ws(
        addr,
        &addr.to_string(),
        Some(&format!("http://{addr}")),
        token,
    )
}

fn status_of(e: tungstenite::Error) -> u16 {
    match e {
        tungstenite::Error::Http(r) => r.status().as_u16(),
        other => panic!("not an HTTP refusal: {other}"),
    }
}

/// The reply to frame `id`, skipping pushed events.
fn reply(ws: &mut Ws, id: u64) -> serde_json::Value {
    loop {
        if let tungstenite::Message::Text(t) = ws.read().unwrap() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}

#[test]
fn browser_off_by_default_binds_nothing() {
    let c = core("off");
    thread::sleep(Duration::from_millis(100));
    let s = c.browser.status();
    assert!(!s.enabled);
    assert_eq!(s.port, DEFAULT_PORT);
    assert!(s.addresses.is_empty(), "{:?}", s.addresses);
    assert!(!c.home.join("browser-access.json").exists());
    // Turned on and off again: nothing stays bound and the address refuses connections.
    let addr = c.enable();
    assert!(c.set(false).addresses.is_empty());
    assert!(TcpStream::connect(addr).is_err());
}

#[test]
fn browser_binds_loopback_and_tailscale_only() {
    let found: Vec<(String, IpAddr)> = vec![
        ("lo0".into(), "127.0.0.1".parse().unwrap()),
        ("en0".into(), "192.168.1.5".parse().unwrap()),
        // Wildcards from bytes: tests/http_auth.rs scans this folder for wildcard literals.
        ("en0".into(), IpAddr::from([0u8; 4])),
        ("en0".into(), IpAddr::from([0u16; 8])),
        ("en0".into(), "100.70.0.1".parse().unwrap()), // CGNAT, but not on utun
        ("utun2".into(), "10.8.0.2".parse().unwrap()), // another VPN
        ("utun3".into(), "100.101.102.103".parse().unwrap()),
        ("utun3".into(), "fd7a:115c:a1e0::1234".parse().unwrap()),
        ("utun4".into(), "fd7a:115c:a1e1::1".parse().unwrap()),
    ];
    let want: Vec<IpAddr> = vec![
        "127.0.0.1".parse().unwrap(),
        "100.101.102.103".parse().unwrap(),
        "fd7a:115c:a1e0::1234".parse().unwrap(),
    ];
    assert_eq!(candidates(&found), want);
    // Real sockets: with a LAN and a fake Tailscale address reported, only loopback binds (the fake one is not this
    // Mac's, so its bind fails and is skipped without a problem).
    let c = core("binds");
    set_scan(&c.home, || {
        vec![
            ("en0".into(), "192.168.1.5".parse().unwrap()),
            ("utun9".into(), "100.127.255.254".parse().unwrap()),
        ]
    });
    let s = c.set(true);
    assert_eq!(s.addresses.len(), 1, "{:?}", s.addresses);
    assert!(s.addresses[0].starts_with("127.0.0.1:"));
    assert!(
        s.tailscale,
        "a utun address in range counts as Tailscale found"
    );
    assert_eq!(s.problem, None);
}

#[test]
fn browser_refuses_peer_outside_ranges() {
    for ok in [
        "127.0.0.1",
        "127.0.0.9",
        "::1",
        "100.64.0.1",
        "100.127.255.255",
        "fd7a:115c:a1e0::1",
        "::ffff:100.100.1.1",
    ] {
        assert!(peer_allowed(ok.parse().unwrap()), "{ok}");
    }
    for no in [
        "192.168.1.5",
        "10.0.0.1",
        "100.63.255.255",
        "100.128.0.1",
        "8.8.8.8",
        "fd7a:115c:a1e1::1",
        "fe80::1",
        "::ffff:192.168.0.1",
    ] {
        assert!(!peer_allowed(no.parse().unwrap()), "{no}");
    }
    assert!(!peer_allowed(IpAddr::from([0u8; 4])), "the v4 wildcard");
}

#[test]
fn browser_refuses_wrong_host() {
    let c = core("host");
    let addr = c.enable();
    let port = addr.port();
    for host in [
        format!("evil.example:{port}"),
        format!("127.0.0.1:{}", port + 1),
        format!("127.0.0.2:{port}"),
        "127.0.0.1".to_string(),
        format!("100.100.1.1:{port}"),
    ] {
        let (status, _, _) = get(addr, &host, "/", &[]);
        assert!(status.contains("403"), "{host}: {status}");
        let refused = ws(addr, &host, Some(&format!("http://{host}")), "x").unwrap_err();
        assert_eq!(status_of(refused), 403, "{host}");
    }
    let (status, _, _) = raw(addr, "GET / HTTP/1.1\r\n\r\n");
    assert!(status.contains("403"), "no Host: {status}");
    let twice = format!("GET / HTTP/1.1\r\nHost: {addr}\r\nHost: {addr}\r\n\r\n");
    assert!(raw(addr, &twice).0.contains("403"), "a repeated Host");
    let (status, _, _) = get(addr, &format!("localhost:{port}"), "/nope", &[]);
    assert!(
        status.contains("404"),
        "localhost on loopback passes the Host gate: {status}"
    );
}

#[test]
fn browser_refuses_tsnet_host_on_loopback() {
    let c = core("tsnet");
    let addr = c.enable();
    let port = addr.port();
    for host in [
        format!("mac.tail1234.ts.net:{port}"),
        "mac.tail1234.ts.net".to_string(),
        format!("mac:{port}"),
    ] {
        let (status, _, _) = get(addr, &host, "/", &[]);
        assert!(status.contains("403"), "{host}: {status}");
        let (status, _, _) = post(
            addr,
            &host,
            &format!("https://{host}"),
            "application/json",
            "x",
        );
        assert!(status.contains("403"), "{host}: {status}");
    }
}

#[test]
fn browser_refuses_foreign_origin() {
    let c = core("origin");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let host = addr.to_string();
    let other_port = format!("http://127.0.0.1:{}", addr.port() + 1);
    for origin in [
        Some("http://evil.example"),
        Some("null"),
        None,
        Some("tauri://localhost"),
        Some("http://tauri.localhost"),
        Some(other_port.as_str()),
        Some(&*format!("https://{host}")),
    ] {
        let refused = ws(addr, &host, origin, &token).unwrap_err();
        assert_eq!(status_of(refused), 403, "{origin:?}");
        if let Some(origin) = origin {
            let (status, _, _) = post(addr, &host, origin, "application/json", "x");
            assert!(status.contains("403"), "{origin}: {status}");
        }
    }
    // A cross-site form cannot send JSON.
    for ctype in [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
    ] {
        let (status, _, _) = post(addr, &host, &format!("http://{host}"), ctype, "x");
        assert!(status.contains("403"), "{ctype}: {status}");
    }
    assert!(browser_ws(addr, &token).is_ok(), "the exact origin passes");
    assert!(
        c.browser.status().devices.len() == 1,
        "no refused post paired anything"
    );
}

#[test]
fn browser_refuses_window_token() {
    let c = core("wintoken");
    let addr = c.enable();
    let refused = browser_ws(addr, &c.window_token).unwrap_err();
    assert_eq!(status_of(refused), 401);
}

#[test]
fn window_gates_unchanged() {
    let c = core("window");
    let addr = c.enable();
    let device = c.pair(addr, "Phone");
    // The window listener knows its own token only; a device token is not a window token.
    assert_eq!(status_of(c.window_ws(&device).unwrap_err()), 401);
    assert!(c.window_ws(&c.window_token).is_ok());
    // The window origin and host rules stand: the browser origin is not a window origin.
    let window: SocketAddr = format!("127.0.0.1:{}", c.window_port).parse().unwrap();
    let refused = ws(
        window,
        &window.to_string(),
        Some(&format!("http://{window}")),
        &c.window_token,
    );
    assert_eq!(status_of(refused.unwrap_err()), 403);
}

#[test]
fn browser_refuses_unpaired_and_revoked_token() {
    let c = core("revoked");
    let addr = c.enable();
    assert_eq!(
        status_of(browser_ws(addr, "0123456789abcdef0123456789abcdef").unwrap_err()),
        401
    );
    assert_eq!(status_of(browser_ws(addr, "").unwrap_err()), 401);
    let token = c.pair(addr, "Phone");
    assert!(browser_ws(addr, &token).is_ok());
    let id = c.browser.status().devices[0].id.clone();
    c.browser
        .window_op(Op::Revoke { device: Some(id) })
        .unwrap();
    assert_eq!(status_of(browser_ws(addr, &token).unwrap_err()), 401);
}

#[test]
fn revoke_closes_live_connection() {
    let c = core("revokelive");
    let addr = c.enable();
    let a = c.pair(addr, "Phone");
    let b = c.pair(addr, "Laptop");
    let mut phone = browser_ws(addr, &a).unwrap();
    let mut laptop = browser_ws(addr, &b).unwrap();
    phone
        .send(tungstenite::Message::Text(
            r#"{"id":1,"request":{"op":"list"}}"#.into(),
        ))
        .unwrap();
    assert!(reply(&mut phone, 1).get("Ok").is_some());
    let id = c
        .browser
        .status()
        .devices
        .iter()
        .find(|d| d.name == "Phone")
        .unwrap()
        .id
        .clone();
    let started = Instant::now();
    c.browser
        .window_op(Op::Revoke { device: Some(id) })
        .unwrap();
    let closed = loop {
        match phone.read() {
            Ok(_) => continue,
            Err(_) => break started.elapsed(),
        }
    };
    assert!(closed < Duration::from_secs(2), "{closed:?}");
    laptop
        .send(tungstenite::Message::Text(
            r#"{"id":2,"request":{"op":"list"}}"#.into(),
        ))
        .unwrap();
    assert!(
        reply(&mut laptop, 2).get("Ok").is_some(),
        "another device stays connected"
    );
    // Revoke all, and turning access off, close the rest.
    c.browser.window_op(Op::Revoke { device: None }).unwrap();
    assert!(laptop.read().is_err() || laptop.read().is_err());
    assert!(c.browser.status().devices.is_empty());
}

#[test]
fn browser_role_allowlist_table() {
    let ok = |frame: &str| allowed(frame).is_ok();
    let allowed_frames = [
        r#"{"ack":"s","bytes":1}"#,
        r#"{"id":1,"chat":"s","before":null}"#,
        r#"{"id":1,"watch":"s","after":0}"#,
        r#"{"id":1,"unwatch":"s"}"#,
        r#"{"id":1,"request":{"op":"list"}}"#,
        r#"{"id":1,"request":{"op":"snapshot"}}"#,
        r#"{"id":1,"request":{"op":"answer","item":"i","answer":{"type":"allow_once"}}}"#,
        r#"{"id":1,"request":{"op":"send_text","id":"s","text":"hi"}}"#,
        r#"{"id":1,"request":{"op":"chat_page","id":"s"}}"#,
    ];
    for f in allowed_frames {
        assert!(ok(f), "{f}");
    }
    let refused_frames = [
        "not json",
        r#"{"id":1,"request":{"op":"no_such_op"}}"#,
        r#"{"id":1,"request":{"op":"start","session":{"id":"s","kind":"shell","cwd":"/tmp"}}}"#,
        r#"{"id":1,"request":{"op":"stop"}}"#,
        r#"{"id":1,"request":{"op":"exit"}}"#,
        r#"{"id":1,"request":{"op":"exit_if_idle","holder_floor":1}}"#,
        r#"{"id":1,"request":{"op":"window_auth"}}"#,
        r#"{"id":1,"request":{"op":"browser","verb":{"verb":"tabs"}}}"#,
        r#"{"id":1,"request":{"op":"browser_next"}}"#,
        r#"{"id":1,"request":{"op":"browser_done","id":1,"result":{"Ok":1}}}"#,
        r#"{"id":1,"request":{"op":"send_keys","id":"s","keys":["Enter"]}}"#,
        r#"{"id":1,"request":{"op":"close","id":"s"}}"#,
        r#"{"id":1,"request":{"op":"files_list","id":"s","path":""}}"#,
        r#"{"id":1,"request":{"op":"widget_list"}}"#,
        // Ticket 276: the agent extensions ops are the owner window's alone.
        r#"{"id":1,"request":{"op":"extensions_list"}}"#,
        r#"{"id":1,"request":{"op":"extensions_mcp_add","name":"x","command":["x"]}}"#,
        r#"{"id":1,"request":{"op":"extensions_mcp_remove","name":"x"}}"#,
        // Ticket 452
        r#"{"id":1,"request":{"op":"extensions_item_files","id":"nunchiro"}}"#,
        r#"{"id":1,"request":{"op":"extensions_item_read","id":"nunchiro","path":"x"}}"#,
        r#"{"id":1,"request":{"op":"extensions_item_save","id":"custom:x","path":"x","text":"x"}}"#,
        r#"{"id":1,"request":{"op":"extensions_skill_new","name":"x","description":"x"}}"#,
        r#"{"id":1,"layout_save":{}}"#,
        r#"{"id":1,"layout_done":1}"#,
        r#"{"id":1,"layout_focus":true}"#,
        r#"{"id":1,"watch":"s","request":{"op":"first_run"}}"#,
        r#"{"id":1,"watch":"s","request":{"op":"list"}}"#,
        r#"{"id":1,"request":{"op":"theme_index"}}"#,
        r#"{"id":1,"request":{"op":"pr_view","url":"https://github.com/o/r/pull/1"}}"#,
        r#"{"id":1,"request":{"op":"pr_list"}}"#,
        r#"{"id":1,"request":{"op":"pr_branch","path":"/tmp"}}"#, // ticket 373
        // V2.5-38: board settings stay the Mac window's, like board_columns_put.
        r#"{"id":1,"request":{"op":"board_settings_put","revision":"","stale_minutes":1440,"turn_end_nudge":false}}"#,
        r#"{"id":1,"request":{"op":"pr_merge","url":"https://github.com/o/r/pull/1","method":"squash","head":"0123456789abcdef0123456789abcdef01234567"}}"#,
        // Ticket 264: the profile ops are the Mac window's alone, and no core request carries them.
        r#"{"id":1,"request":{"op":"browser_profiles"}}"#,
        r#"{"id":1,"request":{"op":"browser_profile_clear","profile":"default"}}"#,
        r#"{"id":1,"request":{"op":"browser_profile_remove","profile":"default"}}"#,
        r#"{"id":1,"request":{"op":"quit_settings","patch":{"features":{"browser.profiles":{}}}}}"#,
        r#"{"id":1,"browser":{"op":"status"}}"#,
        r#"{"id":1,"browser":{"op":"answer","id":"x","allow":true}}"#,
    ];
    for f in refused_frames {
        assert_eq!(
            allowed(f),
            Err("not allowed from the browser".into()),
            "{f}"
        );
    }
    // Every request variant by name: the exhaustive match in `request_allowed` makes a new variant a compile
    // error until classified, and this list pins each classification.
    let watch_and_answer = [
        "List",
        "Snapshot",
        "Read",
        "TreeGet",
        "Subagents",
        "SessionContext",
        "PrChip",
        "BoardSnapshot",
        "DiffList",
        "DiffFile",
        "UserCommands",
        "ChatPage",
        "Answer",
        "SendText",
    ];
    let source = include_str!("browser.rs");
    let body = &source[source.find("pub(crate) fn request_allowed").unwrap()..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let (yes, no) = body.split_once("=> true,\n        // Refused").unwrap();
    let names = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| w.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
            .filter(|w| !["Watch", "Answer.", "Request", "Refused"].contains(w))
            .map(String::from)
            .collect()
    };
    let mut yes = names(yes);
    yes.dedup();
    let mut want: Vec<String> = watch_and_answer.iter().map(|s| s.to_string()).collect();
    want.sort();
    yes.sort();
    yes.dedup();
    assert_eq!(yes, want);
    for refused in [
        "Start",
        "Close",
        "CloseUndo",
        "Exit",
        "Stop",
        "Hook",
        "SendKeys",
        "Resize",
        "SwitchModel",
        "HandoffSend",
        "AcpAgentSignIn", // ticket 358
        "AcpAgentSignInState",
        "AcpAgentSignInCancel",
        "AcpAgentSignOut",
        "AgentUpdateStart", // ticket 358
        "AgentUpdateCancel",
        "AgentUpdateState",
        "AgentSend",
        "AgentPrompt",
        "AgentKeys",
        "AccountAdd",
        "AccountRename", // ticket 358
        "AddMachine",
        "Remote",
        "Forwarded",
        "WidgetRun",
        "WidgetAct",
        "ApprovalGrant",
        "AgentCommandStatus", // ticket 358
        "AgentCommandCheck",
        "AgentCommandGrant",
        "AgentCommandReset",
        "AcpAgentGrant",
        "ExtensionsList", // ticket 276
        "ExtensionsMcpAdd",
        "ExtensionsMcpRemove",
        "ExtensionsItemFiles",
        "ExtensionsItemRead",
        "ExtensionsItemSave",
        "ExtensionsSkillNew",
        "ExtensionsItemRemove",
        "BoardSourceGrant",
        "PermissionAnswers",
        "AgentPermissionGet",
        "AgentPermissionSet",
        "FileRead",
        "FileWrite", // ticket 820
        "FilesList",
        "Worktree",
        "ProblemFix",
        "QuitSettings",
        "GitProviders",
        "Layout",
        "BoardPut",
        "TreeEdit",
        "ImagePut",
        "WindowAuth",
        "FirstRun",
        "PrLive",
        "PrView",
        "PrList",
        "PrMerge",
        "PrBranch", // ticket 373
    ] {
        assert!(
            names(no).iter().any(|n| n == refused),
            "{refused} is refused"
        );
    }
}

#[test]
fn browser_role_refuses_over_the_socket() {
    let c = core("role");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    let start =
        r#"{"id":7,"request":{"op":"start","session":{"id":"x","kind":"shell","cwd":"/tmp"}}}"#;
    b.send(tungstenite::Message::Text(start.into())).unwrap();
    assert_eq!(reply(&mut b, 7)["Err"], "not allowed from the browser");
    b.send(tungstenite::Message::Text(
        r#"{"id":8,"request":{"op":"snapshot"}}"#.into(),
    ))
    .unwrap();
    assert!(reply(&mut b, 8).get("Ok").is_some());
}

/// Ticket 358: a paired browser never signs an ACP agent in or out.
#[test]
fn browser_role_refuses_acp_sign_in_ops() {
    let c = core("acpsignin");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    for (id, request) in [
        r#"{"op":"acp_agent_sign_in","name":"a","method":"m"}"#,
        r#"{"op":"acp_agent_sign_in_state","attempt":"x"}"#,
        r#"{"op":"acp_agent_sign_in_cancel","attempt":"x"}"#,
        r#"{"op":"acp_agent_sign_out","name":"a"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let frame = format!(r#"{{"id":{id},"request":{request}}}"#);
        b.send(tungstenite::Message::Text(frame.into())).unwrap();
        assert_eq!(
            reply(&mut b, id as u64)["Err"],
            "not allowed from the browser",
            "{request}"
        );
    }
}

/// Ticket 358: a paired browser never reads, checks, approves or resets Claude's or Codex's command.
#[test]
fn browser_role_refuses_agent_command_ops() {
    let c = core("agentcmd");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    for (id, request) in [
        r#"{"op":"agent_command_status","agent":"claude"}"#,
        r#"{"op":"agent_command_check","agent":"claude","path":"/bin/echo"}"#,
        r#"{"op":"agent_command_grant","agent":"claude","hash":"00"}"#,
        r#"{"op":"agent_command_reset","agent":"claude"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let frame = format!(r#"{{"id":{id},"request":{request}}}"#);
        b.send(tungstenite::Message::Text(frame.into())).unwrap();
        assert_eq!(
            reply(&mut b, id as u64)["Err"],
            "not allowed from the browser",
            "{request}"
        );
    }
}

/// V2.5-9 (security review SHOULD): a paired browser can never merge, even with a well-formed request.
#[test]
fn browser_role_refuses_pr_merge() {
    let c = core("prmerge");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    let merge = r#"{"id":9,"request":{"op":"pr_merge","url":"https://github.com/o/r/pull/1","method":"squash","head":"0123456789abcdef0123456789abcdef01234567"}}"#;
    b.send(tungstenite::Message::Text(merge.into())).unwrap();
    assert_eq!(reply(&mut b, 9)["Err"], "not allowed from the browser");
}

#[test]
fn pair_answer_window_only() {
    let c = core("windowonly");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let (_, _, body) = post_pair(addr, &addr.to_string(), "Second");
    let id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The browser path has no frame that approves anything.
    let mut b = browser_ws(addr, &token).unwrap();
    let answer = serde_json::json!({"id":3,"browser":{"op":"answer","id":id,"allow":true}});
    b.send(tungstenite::Message::Text(answer.to_string().into()))
        .unwrap();
    assert_eq!(reply(&mut b, 3)["Err"], "not allowed from the browser");
    // Nor does the owner socket: it reads only `api::Request`, which has no browser op.
    for op in [
        "browser",
        "browser_access",
        "pair_answer",
        "browser_pair_answer",
    ] {
        let r = serde_json::json!({"op":op,"id":id,"allow":true});
        assert!(
            serde_json::from_value::<crate::api::Request>(r).is_err(),
            "{op}"
        );
    }
    assert_eq!(c.browser.status().devices.len(), 1);
    // The Mac window can, and its `browser` event carries the pending sheet.
    let mut w = c.window_ws(&c.window_token).unwrap();
    let pending = loop {
        if let tungstenite::Message::Text(t) = w.read().unwrap() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "browser" {
                break v["pending"].clone();
            }
        }
    };
    assert_eq!(pending[0]["id"], id.as_str());
    assert_eq!(pending[0]["name"], "Second");
    assert_eq!(pending[0]["loopback"], true);
    w.send(tungstenite::Message::Text(answer.to_string().into()))
        .unwrap();
    assert!(
        reply(&mut w, 3)["Ok"]["status"]["devices"]
            .as_array()
            .unwrap()
            .len()
            == 2
    );
}

#[test]
fn browser_answer_noticed_on_mac() {
    let c = core("notice");
    let addr = c.enable();
    let token = c.pair(addr, "the owner's phone");
    let mut w = c.window_ws(&c.window_token).unwrap();
    let mut b = browser_ws(addr, &token).unwrap();
    let send = r#"{"id":4,"request":{"op":"send_text","id":"nope","text":"yes"}}"#;
    b.send(tungstenite::Message::Text(send.into())).unwrap();
    reply(&mut b, 4);
    let answer =
        r#"{"id":5,"request":{"op":"answer","item":"nope","answer":{"type":"allow_once"}}}"#;
    b.send(tungstenite::Message::Text(answer.into())).unwrap();
    reply(&mut b, 5);
    let until = Instant::now() + Duration::from_secs(3);
    let notices = loop {
        assert!(Instant::now() < until, "no notice reached the window");
        if let tungstenite::Message::Text(t) = w.read().unwrap() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "browser" && v["notices"].as_array().is_some_and(|n| n.len() == 2) {
                break v["notices"].clone();
            }
        }
    };
    assert_eq!(notices[0]["name"], "the owner's phone");
    assert_eq!(notices[0]["action"], "reply");
    assert_eq!(notices[1]["action"], "answer");
    // A watch is not a change: no notice for it.
    b.send(tungstenite::Message::Text(
        r#"{"id":6,"request":{"op":"list"}}"#.into(),
    ))
    .unwrap();
    reply(&mut b, 6);
    assert_eq!(c.browser.event()["notices"].as_array().unwrap().len(), 2);
}

#[test]
fn browser_responses_carry_csp() {
    let c = core("csp");
    let addr = c.enable();
    let host = addr.to_string();
    let csp = format!("content-security-policy: {}", CSP.to_ascii_lowercase());
    let responses = [
        get(addr, &host, "/", &[]),
        get(addr, &host, "/nope", &[]),
        get(addr, &host, "/pair/abc", &[]),
        get(addr, "evil.example", "/", &[]),
        post_pair(addr, &host, "x"),
        get(addr, &host, "/ws", &["Origin: http://evil.example"]),
    ];
    for (status, headers, _) in &responses {
        assert!(headers.contains(&csp), "{status}: {headers}");
        assert!(headers.contains("x-frame-options: deny"), "{status}");
        assert!(headers.contains("referrer-policy: no-referrer"), "{status}");
        assert!(CSP.contains("frame-ancestors 'none'") && CSP.contains("script-src 'self'"));
    }
    assert!(responses[2].1.contains("cache-control: no-store"));
    assert!(responses[4].1.contains("cache-control: no-store"));
    // The token refusal from the WebSocket handshake too.
    let refused = browser_ws(addr, "wrong").unwrap_err();
    match refused {
        tungstenite::Error::Http(r) => {
            assert_eq!(r.headers()["content-security-policy"], CSP);
        }
        other => panic!("{other}"),
    }
}

#[test]
fn browser_bundle_has_no_inline_script() {
    let source = include_str!("../../../../web/index.html");
    let mut htmls: Vec<String> = vec![source.to_string()];
    htmls.extend(
        ASSETS
            .iter()
            .filter(|(p, _, _)| p.ends_with(".html"))
            .map(|(_, _, b)| String::from_utf8_lossy(b).to_string()),
    );
    for html in &htmls {
        for tag in html.split("<script").skip(1) {
            let open = &tag[..tag.find('>').unwrap()];
            assert!(open.contains("src="), "inline script: <script{open}>");
            let after = &tag[tag.find('>').unwrap() + 1..];
            assert!(after.trim_start().starts_with("</script>"), "script body");
        }
        assert!(
            !html.contains(" onload=") && !html.contains(" onclick="),
            "inline handler"
        );
    }
}

#[test]
fn browser_serves_only_embedded_assets() {
    let c = core("assets");
    let addr = c.enable();
    let host = addr.to_string();
    std::fs::write(c.home.join("secret.txt"), "secret").unwrap();
    for path in [
        "/../Cargo.toml",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/..%2f..%2fetc%2fpasswd",
        "/assets/",
        "/assets",
        "/secret.txt",
        "/browser-devices.json",
        "/window.json",
        "//etc/passwd",
        "/src/main.tsx",
    ] {
        let (status, _, body) = get(addr, &host, path, &[]);
        assert!(status.contains("404"), "{path}: {status}");
        assert!(
            !body.contains("secret") && !body.contains("root:"),
            "{path}"
        );
    }
    let (status, _, _) = raw(addr, &format!("DELETE / HTTP/1.1\r\nHost: {host}\r\n\r\n"));
    assert!(status.contains("404"));
    let (status, headers, body) = get(addr, &host, "/", &[]);
    if ASSETS.is_empty() {
        assert!(status.contains("503"), "{status}");
    } else {
        assert!(status.contains("200"), "{status}");
        assert!(headers.contains("text/html"));
        assert!(body.contains(r#"<meta name="nunchiro-browser" content="1">"#));
        let (path, ctype, bytes) = ASSETS.iter().find(|(p, _, _)| p.ends_with(".js")).unwrap();
        let (status, headers, _) = get(addr, &host, path, &[]);
        assert!(status.contains("200") && headers.contains(ctype), "{path}");
        assert!(!bytes.is_empty());
    }
}

#[test]
fn browser_origin_serves_no_artifacts() {
    // W1, C3: artifacts and web widgets stay on `nunchiro-artifact` in the app; this origin serves none.
    assert!(
        ASSETS
            .iter()
            .all(|(p, _, _)| !p.contains("artifact") || p.starts_with("/assets/"))
    );
    let c = core("artifacts");
    let addr = c.enable();
    for path in [
        "/artifact/x/index.html",
        "/artifacts/x",
        "/nunchiro-artifact/x",
        "/widgets/x/index.html",
    ] {
        let (status, _, _) = get(addr, &addr.to_string(), path, &[]);
        assert!(status.contains("404"), "{path}: {status}");
    }
}

#[test]
fn browser_cap_does_not_starve_window() {
    let c = core("cap");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let held: Vec<Ws> = (0..MAX_BROWSERS)
        .map(|_| browser_ws(addr, &token).unwrap())
        .collect();
    assert_eq!(status_of(browser_ws(addr, &token).unwrap_err()), 503);
    assert!(
        c.window_ws(&c.window_token).is_ok(),
        "the Mac window still connects"
    );
    drop(held);
}

#[test]
fn browser_port_taken_shows_problem() {
    let c = core("taken");
    let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    let reply = c
        .browser
        .window_op(Op::Set {
            enabled: true,
            port: Some(port),
        })
        .unwrap();
    let crate::api::Reply::BrowserAccess { status } = reply else {
        panic!()
    };
    assert!(
        status.addresses.is_empty(),
        "never falls back to another port"
    );
    assert_eq!(
        status.problem.as_deref(),
        Some(&*format!("port {port} is in use by another program"))
    );
    assert!(
        c.browser
            .window_op(Op::Set {
                enabled: true,
                port: Some(80)
            })
            .is_err()
    );
    // The setting persists across a reload of the core.
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(c.home.join("browser-access.json")).unwrap())
            .unwrap();
    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["port"], port);
}

#[test]
fn browser_cannot_answer_owner_items() {
    let c = core("owner");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let id = c
        .registry
        .lock()
        .unwrap()
        .queue
        .ask_owner(
            "some-session",
            crate::queue::OwnerAsk::PermissionAnswers {
                project: "/tmp/project".into(),
            },
        )
        .unwrap();
    let mut b = browser_ws(addr, &token).unwrap();
    for answer in ["allow_once", "deny"] {
        let frame = serde_json::json!({"id":9,"request":{"op":"answer","item":id,"answer":{"type":answer}}});
        b.send(tungstenite::Message::Text(frame.to_string().into()))
            .unwrap();
        assert_eq!(
            reply(&mut b, 9)["Err"],
            "answer this on the Mac",
            "{answer}"
        );
    }
    assert!(
        c.registry
            .lock()
            .unwrap()
            .queue
            .owner_decision(&id)
            .is_some(),
        "left for the Mac"
    );
    assert!(c.browser.event()["notices"].as_array().unwrap().is_empty());
}

#[test]
fn revoke_race_closes_socket() {
    let c = core("race");
    let addr = c.enable();
    let _token = c.pair(addr, "Phone");
    let id = c.browser.status().devices[0].id.clone();
    // The token passed, then a revoke lands before the connection is registered.
    c.browser
        .window_op(Op::Revoke {
            device: Some(id.clone()),
        })
        .unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (server, _) = listener.accept().unwrap();
    let local = server.local_addr().unwrap();
    assert!(
        !c.browser.track(1, &id, local, server),
        "registration re-checks the device"
    );
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(
        client.read(&mut [0u8; 1]).unwrap(),
        0,
        "the socket is closed"
    );
    assert!(lock(&c.browser.live).is_empty());
}

#[test]
fn idle_expiry_closes_live() {
    let c = core("idlelive");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut phone = browser_ws(addr, &token).unwrap();
    phone
        .send(tungstenite::Message::Text(
            r#"{"id":1,"request":{"op":"list"}}"#.into(),
        ))
        .unwrap();
    assert!(reply(&mut phone, 1).get("Ok").is_some());
    let used = c.browser.status().devices[0].last_used_ms;
    c.browser
        .close_expired(used + super::super::pair::IDLE_EXPIRY_MS);
    assert!(
        !lock(&c.browser.live).is_empty(),
        "day 30 still counts as used"
    );
    let started = Instant::now();
    c.browser
        .close_expired(used + super::super::pair::IDLE_EXPIRY_MS + 1);
    // Closed, not a read timeout: the socket ends well before its 5 s timeout.
    let error = loop {
        match phone.read() {
            Ok(_) => continue,
            Err(e) => break e,
        }
    };
    assert!(started.elapsed() < Duration::from_secs(2), "{error}");
    assert!(
        !matches!(&error, tungstenite::Error::Io(e) if e.kind() == std::io::ErrorKind::WouldBlock),
        "{error}"
    );
}

// Ticket 362: a paired device cannot press Shift+Tab, in any encoding; Stop (a lone Esc), Ctrl-C and text still pass.
#[test]
fn browser_cannot_send_mode_keys() {
    let frame = |text: &str| {
        format!(r#"{{"id":1,"request":{{"op":"send_text","id":"s","text":"{text}"}}}}"#)
    };
    for text in [
        r"\u001b[Z",
        r"\u001b[1;2Z",
        r"\u001b[9;2u",
        r"\u009bZ",
        r"hi\u001b[Z",
    ] {
        assert!(allowed(&frame(text)).is_err(), "{text}");
    }
    for text in [r"\u001b", r"\u0003", r"yes\r"] {
        assert_eq!(allowed(&frame(text)), Ok(Some("reply")), "{text}");
    }
}

#[test]
fn threat_note_sendtext() {
    let doc = include_str!("../../../../docs/design/v25-threat-model.md");
    let w9 = doc.lines().find(|l| l.starts_with("| W9 |")).unwrap();
    assert!(w9.contains("`SendText` passes control bytes"), "{w9}");
    assert!(
        w9.contains("the same as the window's") && w9.contains("noticed on the Mac"),
        "{w9}"
    );
}

#[test]
fn web_smoke_lists_specs() {
    // The merge-gate script is not in the public export (scripts/public-exclude.txt): nothing to check there.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/web-smoke.sh");
    if !std::path::Path::new(path).exists() {
        return;
    }
    let smoke = std::fs::read_to_string(path).unwrap();
    let specs = smoke.lines().find(|l| l.starts_with("specs=")).unwrap();
    for spec in ["web-access-browser.spec", "web-access-insecure.spec"] {
        assert!(
            specs.split(['"', ' ']).any(|s| s == spec),
            "{spec} in {specs}"
        );
    }
}

/// Ticket 358, whole bundle: every op the eight lanes added is in all three owner-only lists (a session caller, a remote
/// caller, a browser). The agent half runs over the socket too: `bundle_358_ops_are_refused_to_a_session` in tests/acp.rs.
#[test]
fn bundle_358_ops_are_in_every_owner_only_list() {
    let sessions = include_str!("../sessions.rs");
    let agent = &sessions[sessions.find("pub(crate) fn check_agent").unwrap()..];
    let agent = &agent[..agent.find("Request::Close { id }").unwrap()];
    // Only the `matches!` that refuses forwarding: from the Remote arm to its refusal.
    let server = include_str!("../server.rs");
    let remote = &server[server.find("pub(crate) fn remote_from_owner").unwrap()..];
    let remote = &remote[remote.find("matches!(").unwrap()
        ..remote
            .find("operation is local owner-only; remote forwarding is not permitted")
            .unwrap()];
    let source = include_str!("browser.rs");
    let browser = &source[source.find("pub(crate) fn request_allowed").unwrap()..];
    let browser = &browser[browser.find("// Refused").unwrap()..browser.find("=> false,").unwrap()];
    let has = |list: &str, op: &str| {
        list.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| word == op)
    };
    for op in [
        "AccountRename",
        "AgentUpdateStart",
        "AgentUpdateCancel",
        "AgentUpdateState",
        "AcpAgentSignIn",
        "AcpAgentSignInState",
        "AcpAgentSignInCancel",
        "AcpAgentSignOut",
        "AgentCommandStatus",
        "AgentCommandCheck",
        "AgentCommandGrant",
        "AgentCommandReset",
    ] {
        assert!(has(agent, op), "{op}: session list");
        assert!(has(remote, op), "{op}: remote list");
        assert!(has(browser, op), "{op}: browser list");
    }
}

/// Ticket 358, whole bundle: the ops the other browser tests do not send, refused over a paired browser's socket.
#[test]
fn browser_role_refuses_bundle_358_ops() {
    let c = core("bundle358");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    for (id, request) in [
        r#"{"op":"switch_model","id":"x","model":"fast","effort":null}"#,
        r#"{"op":"account_rename","agent":"claude","id":"a","label":"b"}"#,
        r#"{"op":"agent_update_start","tool":"claude"}"#,
        r#"{"op":"agent_update_cancel","tool":"claude"}"#,
        r#"{"op":"agent_update_state"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let frame = format!(r#"{{"id":{id},"request":{request}}}"#);
        b.send(tungstenite::Message::Text(frame.into())).unwrap();
        assert_eq!(
            reply(&mut b, id as u64)["Err"],
            "not allowed from the browser",
            "{request}"
        );
    }
}

/// Ticket 373: a paired browser never runs the by-branch PR lookup (the user's own gh in a worktree folder).
#[test]
fn browser_role_refuses_pr_branch() {
    let c = core("prbranch");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    let ask = r#"{"id":11,"request":{"op":"pr_branch","path":"/tmp"}}"#;
    b.send(tungstenite::Message::Text(ask.into())).unwrap();
    assert_eq!(reply(&mut b, 11)["Err"], "not allowed from the browser");
}

/// Ticket 372 threat 2: a paired browser cannot arm or cancel a resume at reset; it is in the browser's refused list.
#[test]
fn browser_role_refuses_limit_resume() {
    let source = include_str!("browser.rs");
    let browser = &source[source.find("pub(crate) fn request_allowed").unwrap()..];
    let browser = &browser[browser.find("// Refused").unwrap()..browser.find("=> false,").unwrap()];
    assert!(browser.contains("LimitResume"), "browser list");
    let c = core("limit372");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    for (id, on) in [(1u64, true), (2, false)] {
        let frame =
            format!(r#"{{"id":{id},"request":{{"op":"limit_resume","id":"x","on":{on}}}}}"#);
        b.send(tungstenite::Message::Text(frame.into())).unwrap();
        assert_eq!(
            reply(&mut b, id)["Err"],
            "not allowed from the browser",
            "{on}"
        );
    }
}

/// Ticket 259: a paired browser neither reads nor grants a worktree setup script (a grant runs it on this Mac).
#[test]
fn browser_role_refuses_setup_ops() {
    let c = core("setup259");
    let addr = c.enable();
    let token = c.pair(addr, "Phone");
    let mut b = browser_ws(addr, &token).unwrap();
    for (id, request) in [
        r#"{"op":"setup_status","path":"/tmp"}"#,
        r#"{"op":"setup_grant","path":"/tmp","hash":"00"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let frame = format!(r#"{{"id":{id},"request":{request}}}"#);
        b.send(tungstenite::Message::Text(frame.into())).unwrap();
        assert_eq!(
            reply(&mut b, id as u64)["Err"],
            "not allowed from the browser",
            "{request}"
        );
    }
}
