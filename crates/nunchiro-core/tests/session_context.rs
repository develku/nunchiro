//! Ticket 97: the window supplies only a Nunchiro session id; all fixtures are synthetic.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::Request, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    time::Duration,
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
const UUID: &str = "00000000-0000-4000-8000-000000000001";
const DECOY: &str = "00000000-0000-4000-8000-000000000002";
struct Core {
    serve: home::ServeGuard,
    data: PathBuf,
}
impl Core {
    fn new(kind: &str, agent_id: Option<&str>, machine: Option<&str>) -> Self {
        Self::build(kind, agent_id, machine, false)
    }
    fn build(kind: &str, agent_id: Option<&str>, machine: Option<&str>, account: bool) -> Self {
        let h = home::short("ctx");
        let data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(h.file_name().unwrap());
        fs::create_dir_all(data.join("agent/projects/p")).unwrap();
        fs::create_dir_all(data.join("own-home")).unwrap();
        let data = data.canonicalize().unwrap();
        let mut row = json!({"id":"abcd1234","kind":kind,"project":data,"cwd":data,"label":"context fixture","state":"exited","agent_session_id":agent_id,"agent_version":null,"untested":false,"pid":null,"machine":machine});
        if account {
            let folder = h.join("accounts/claude/abcd1234");
            fs::create_dir_all(folder.join("projects/p")).unwrap();
            fs::write(h.join("accounts.toml"), "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"abcd1234\"\nlabel = \"Work\"\n").unwrap();
            row["config_dir"] = json!(folder);
            row["account"] = json!("Work");
        }
        fs::write(
            h.join("sessions.json"),
            json!({"version":2,"sessions":[row.clone(), {"id":"dcba4321","kind":kind,"project":data,"cwd":data.join("other-project"),"label":"other project","state":"exited","agent_session_id":agent_id,"agent_version":null,"untested":false,"pid":null,"machine":null}]}).to_string(),
        )
        .unwrap();
        let data = data.canonicalize().unwrap();
        let agent = data.join("agent");
        let own = data.join("own-home");
        let ssh = data.join("ssh-stub");
        fs::write(&ssh, "#!/bin/sh\nprintf called >> \"$HOME/ssh-called\"\nprintf '{\"Ok\":{\"type\":\"ack\"}}\\n'\n").unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let serve = home::spawn_serve(
            &h,
            &[
                ("HOME", own.to_str().unwrap()),
                ("CLAUDE_CONFIG_DIR", agent.to_str().unwrap()),
                ("CODEX_HOME", agent.to_str().unwrap()),
                ("NUNCHIRO_SSH", ssh.to_str().unwrap()),
            ],
        );
        let core = Self { serve, data };
        fs::create_dir_all(core.path().parent().unwrap()).unwrap();
        if account {
            fs::create_dir_all(
                core.serve
                    .home
                    .join("accounts/claude/abcd1234/projects")
                    .join(core.project_folder()),
            )
            .unwrap();
        }
        core
    }
    fn project_folder(&self) -> String {
        self.data
            .to_string_lossy()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect()
    }
    fn path(&self) -> PathBuf {
        self.data
            .join("agent/projects")
            .join(self.project_folder())
            .join(format!("{UUID}.jsonl"))
    }
    fn write(&self, line: Value) {
        fs::write(self.path(), format!("{line}\n")).unwrap();
    }
    fn get(&self, id: &str) -> Value {
        let info =
            serde_json::to_value(call(&self.serve.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", info["port"])
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                info["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":{"op":"session_context","id":id}})
                .to_string()
                .into(),
        ))
        .unwrap();
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.data);
    }
}
fn assistant(input: u64) -> Value {
    json!({"type":"assistant","isSidechain":false,"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":input,"cache_read_input_tokens":20000,"cache_creation_input_tokens":4000,"output_tokens":999}}})
}
fn known(used: u64, window: u64) -> Value {
    json!({"Ok":{"type":"session_context","used":used,"window":window,"model":"claude-sonnet-4-20250514"}})
}
fn known_codex(used: u64, window: u64) -> Value {
    json!({"Ok":{"type":"session_context","used":used,"window":window}})
}
fn unknown() -> Value {
    json!({"Ok":{"type":"unknown"}})
}
#[test]
fn usage_op_reads_transcript_only() {
    let c = Core::new("claude", Some(UUID), None);
    let mut bytes = vec![b'x'; 5 << 20];
    bytes.push(b'\n');
    bytes.extend(format!("{}\n", assistant(100000)).as_bytes());
    fs::write(c.path(), bytes).unwrap();
    fs::write(
        c.path().with_file_name(format!("{DECOY}.jsonl")),
        format!("{}\n", assistant(1)),
    )
    .unwrap();
    assert_eq!(c.get("abcd1234"), known(124000, 200000));
    assert_eq!(
        c.get(DECOY),
        unknown(),
        "a transcript uuid is not a Nunchiro session id"
    );
}
#[test]
fn usage_unknown_is_not_zero() {
    for (kind, id, machine) in [
        ("claude", None, None),
        ("acp", Some(UUID), None),
        ("shell", Some(UUID), None),
        ("claude", Some(UUID), Some("elsewhere")),
    ] {
        let c = Core::new(kind, id, machine);
        c.write(assistant(100000));
        assert_eq!(c.get("abcd1234"), unknown());
    }
    let c = Core::new("claude", Some(UUID), None);
    assert_eq!(c.get("abcd1234"), unknown());
    c.write(json!({"type":"user","message":{"content":"no assistant"}}));
    assert_eq!(c.get("abcd1234"), unknown());
}
#[test]
fn usage_never_guesses_window() {
    let c = Core::new("claude", Some(UUID), None);
    for model in ["unknown-model", "claude-opus-5-5", "claude-sonnet-5-5"] {
        let mut line = assistant(100);
        line["message"]["model"] = json!(model);
        c.write(line);
        // B15 (ticket 991): no window is guessed, but the model the transcript names is still told.
        assert_eq!(
            c.get("abcd1234"),
            json!({"Ok":{"type":"session_model","model":model}}),
            "{model} has no verified 200k window"
        );
    }
    c.write(assistant(226000));
    assert_eq!(
        c.get("abcd1234"),
        json!({"Ok":{"type":"session_model","model":"claude-sonnet-4-20250514"}})
    );
}
#[test]
fn usage_path_confined() {
    for part in ["file", "projects", "account"] {
        let c = Core::new("claude", Some(UUID), None);
        c.write(assistant(100000));
        let path = match part {
            "file" => c.path(),
            "projects" => c.data.join("agent/projects"),
            _ => c.data.join("agent"),
        };
        let outside = c.data.join("outside");
        fs::rename(&path, &outside).unwrap();
        symlink(&outside, &path).unwrap();
        assert_eq!(c.get("abcd1234"), unknown(), "{part}");
    }
    for id in [
        "../outside",
        "p/session",
        "..",
        "00000000-0000-4000-8000-000000000001/extra",
    ] {
        let c = Core::new("claude", Some(UUID), None);
        c.write(assistant(100000));
        assert_eq!(c.get(id), unknown());
    }
}
#[test]
fn usage_counts_input_and_cache() {
    let c = Core::new("claude", Some(UUID), None);
    let mut side = assistant(1);
    side["isSidechain"] = json!(true);
    fs::write(
        c.path(),
        format!("{}\n{}\n{side}\n", assistant(1), assistant(100000)),
    )
    .unwrap();
    assert_eq!(c.get("abcd1234"), known(124000, 200000));
    // The only assistant usage is before the tail. Its suffix is not a complete JSON line.
    let mut bytes = format!("{}\n", assistant(100000)).into_bytes();
    bytes.extend(vec![b'x'; 300 << 10]);
    fs::write(c.path(), bytes).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
}
#[test]
fn usage_codex_window_from_rollout() {
    let c = Core::new("codex", Some(UUID), None);
    let path = c.data.join(format!(
        "agent/sessions/2026/10/29/rollout-2026-10-29T09-00-00-{UUID}.jsonl"
    ));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    // Shape checked against a real Codex token_count event; values and session id are synthetic.
    let mut event = json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1900000},"last_token_usage":{"input_tokens":124000,"total_tokens":125000},"model_context_window":200000}}});
    fs::write(&path, format!("{event}\n")).unwrap();
    assert_eq!(c.get("abcd1234"), known_codex(125000, 200000));
    event["payload"]["info"]["model_context_window"] = json!(1000000);
    fs::write(&path, format!("{event}\n")).unwrap();
    assert_eq!(c.get("abcd1234"), known_codex(125000, 1000000));
    event["payload"]["info"]
        .as_object_mut()
        .unwrap()
        .remove("model_context_window");
    fs::write(&path, format!("{event}\n")).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
}

#[test]
fn usage_op_reads_registered_account_transcript_only() {
    let c = Core::build("claude", Some(UUID), None, true);
    c.write(assistant(1)); // own-account decoy with the same transcript UUID
    let folder = c.serve.home.join("accounts/claude/abcd1234");
    fs::write(
        folder
            .join("projects")
            .join(c.project_folder())
            .join(format!("{UUID}.jsonl")),
        format!("{}\n", assistant(100000)),
    )
    .unwrap();
    assert_eq!(c.get("abcd1234"), known(124000, 200000));
    fs::rename(&folder, c.serve.home.join("outside-account")).unwrap();
    symlink(c.serve.home.join("outside-account"), &folder).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
}

#[test]
fn usage_op_off_frame_loop() {
    // The transport must route the public operation to the job seam exercised by the slow-reader unit test.
    let source = include_str!("../src/http/mod.rs");
    let branch = source
        .split("Some(Request::SessionContext { .. })) => {")
        .nth(1)
        .expect("no context operation on the frame loop");
    let branch = branch
        .split("Some(Request::AccountUsage { .. })")
        .next()
        .unwrap();
    assert!(branch.contains("dispatch_session_context("));
    let helper = source
        .split("fn dispatch_session_context(")
        .nth(1)
        .unwrap()
        .split("// tungstenite")
        .next()
        .unwrap();
    assert!(helper.contains("jobs.spawn(id, read)"));
}

#[test]
fn newest_reply_without_usage_is_unknown() {
    let c = Core::new("claude", Some(UUID), None);
    for usage in [
        Value::Null,
        json!([]),
        json!("invalid"),
        json!({"input_tokens":"bad"}),
    ] {
        let mut newest = assistant(1);
        newest["message"]["usage"] = usage;
        let bytes = format!("{}\n{newest}\n", assistant(100000));
        fs::write(c.path(), &bytes).unwrap();
        // B15: an unreadable usage is no fill, but the model is still the one it names.
        assert_eq!(
            c.get("abcd1234"),
            json!({"Ok":{"type":"session_model","model":"claude-sonnet-4-20250514"}}),
            "newest usage: {newest}"
        );
        assert_eq!(fs::read_to_string(c.path()).unwrap(), bytes);
    }
}

#[test]
fn transcript_in_another_project_is_unknown() {
    let c = Core::new("claude", Some(UUID), None);
    let other = c
        .data
        .join(format!("agent/projects/another-project/{UUID}.jsonl"));
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::write(&other, format!("{}\n", assistant(100000))).unwrap();
    let before = fs::read(&other).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
    assert_eq!(fs::read(&other).unwrap(), before);
}
#[test]
fn transcript_in_another_project_is_unknown_after_cache_warm() {
    let c = Core::new("claude", Some(UUID), None);
    let encoded: String = c
        .data
        .join("other-project")
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let other = c
        .data
        .join("agent/projects")
        .join(encoded)
        .join(format!("{UUID}.jsonl"));
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::write(&other, format!("{}\n", assistant(100000))).unwrap();
    assert_eq!(c.get("dcba4321"), known(124000, 200000));
    // A duplicate in an unrelated project must not let the warmed B result fill A's ring.
    let duplicate = c
        .data
        .join(format!("agent/projects/duplicate/{UUID}.jsonl"));
    fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
    fs::copy(&other, &duplicate).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
    c.write(assistant(50000));
    assert_eq!(c.get("abcd1234"), known(74000, 200000));
    assert_eq!(c.get("dcba4321"), known(124000, 200000));
    fs::remove_file(c.path()).unwrap();
    assert_eq!(c.get("abcd1234"), unknown());
}

#[test]
fn remote_session_context_refused_locally() {
    let c = Core::new("claude", Some(UUID), None);
    let result = call(
        &c.serve.home,
        Request::Remote {
            machine: "fixture".into(),
            request: Box::new(Request::SessionContext {
                id: "abcd1234".into(),
            }),
        },
    );
    let marker = c.data.join("own-home/ssh-called");
    assert!(
        !marker.exists(),
        "Remote(SessionContext) invoked SSH: {result:?}"
    );
    assert_eq!(
        result.unwrap_err(),
        "operation is local owner-only; remote forwarding is not permitted"
    );
    // Positive control: the same installed stub is reached by an allowed remote request.
    let result = call(
        &c.serve.home,
        Request::Remote {
            machine: "fixture".into(),
            request: Box::new(Request::Snapshot),
        },
    )
    .unwrap();
    assert!(matches!(result, nunchiro_core::api::Reply::Ack));
    assert!(marker.exists(), "SSH stub positive control was not invoked");
}
