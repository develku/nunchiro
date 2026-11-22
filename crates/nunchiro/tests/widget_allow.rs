//! `nunchiro widget allow` and the trust rule behind it: only the user grants (ticket v1b-14).
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    approval::{self, Level, State},
    server::call,
};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Output,
    thread,
    time::{Duration, Instant},
};

const BIN: &str = env!("CARGO_BIN_EXE_nunchiro");

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let home = home::short("wa");
        let dest = home.join("widgets/open-prs");
        fs::create_dir_all(&dest).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../nunchiro-core/tests/fixtures/approval/open-prs");
        for entry in fs::read_dir(fixture).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), dest.join(entry.file_name())).unwrap();
        }
        Self(home)
    }
    fn cli(&self, args: &[&str]) -> Output {
        home::git_env::scrubbed(BIN)
            .args(args)
            .env("NUNCHIRO_HOME", &self.0)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .output()
            .unwrap()
    }
    fn store(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.0.join("approvals.json")).unwrap()).unwrap()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(BIN)
            .args(["serve", "stop"])
            .env("NUNCHIRO_HOME", &self.0)
            .output();
        thread::sleep(Duration::from_millis(100));
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn widget_allow_read_stores_the_same_grant_as_the_window_request() {
    let cli = Home::new();
    let out = cli.cli(&["widget", "allow", "open-prs", "--read"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(
        text(&out.stdout).contains("sh open-prs.sh --state open"),
        "the output names the exact command"
    );
    assert_eq!(
        approval::status(&cli.0, "open-prs").unwrap().state,
        State::Approved
    );

    // The window sends the same request over its WebSocket; both reach `Sessions::handle`.
    let window = Home::new();
    out_ok(&window.cli(&["widget", "allow", "open-prs", "--act"]));
    let Reply::ApprovalStatus { view } = call(
        &window.0,
        Request::ApprovalStatus {
            name: "open-prs".into(),
        },
    )
    .unwrap() else {
        panic!()
    };
    call(
        &window.0,
        Request::ApprovalGrant {
            name: "open-prs".into(),
            level: Level::Read,
            hash: view.hash,
        },
    )
    .unwrap();

    let (a, b) = (
        cli.store()["approvals"][0].take(),
        window.store()["approvals"][0].take(),
    );
    for field in ["name", "level", "hash"] {
        assert_eq!(a[field], b[field], "{field}");
    }
}
fn out_ok(o: &Output) {
    assert!(o.status.success(), "{}", text(&o.stderr));
}

#[test]
fn widget_act_is_a_separate_flag_and_unknown_widgets_fail() {
    let h = Home::new();
    out_ok(&h.cli(&["widget", "allow", "open-prs", "--act"]));
    assert_eq!(h.store()["approvals"][0]["level"], "act");
    let bad = h.cli(&["widget", "allow", "missing", "--read"]);
    assert!(!bad.status.success());
    let usage = h.cli(&["widget", "allow", "open-prs"]);
    assert!(text(&usage.stderr).contains("usage"));
}

#[test]
fn widget_allow_refuses_inside_a_session_environment_and_writes_nothing() {
    let h = Home::new();
    let out = home::git_env::scrubbed(BIN)
        .args(["widget", "allow", "open-prs", "--read"])
        .env("NUNCHIRO_HOME", &h.0)
        .env("NUNCHIRO_TOKEN", "session-token")
        .output()
        .unwrap();
    assert!(!out.status.success());
    // v1a-23 flip: the CLI no longer refuses on the environment alone; the core refuses a token that names no live
    // session (was the session hint, before a core was started).
    assert!(
        text(&out.stderr).contains("unauthorized"),
        "{}",
        text(&out.stderr)
    );
    assert!(!h.0.join("approvals.json").exists());
    assert!(
        h.0.join("core.sock").exists(),
        "v1a-23 flip: the core was started to ask (was: not started)"
    );
}

/// Runs `program` in a real session so it gets the token the core issues, and returns what it printed.
fn in_session(h: &Home, script: &str) -> String {
    let started = call(
        &h.0,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: h.0.clone(),
                worktree: false,
                label: "agent".into(),
                args: vec!["sh".into(), "-c".into(), script.into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap();
    let Reply::Started { session } = started else {
        panic!()
    };
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let Reply::Output { data, .. } = call(
            &h.0,
            Request::Read {
                id: session.id.clone(),
                after: 0,
            },
        )
        .unwrap() else {
            panic!()
        };
        let out = String::from_utf8_lossy(&data).into_owned();
        if out.contains("END") {
            return out;
        }
        assert!(Instant::now() < until, "session printed no END: {out}");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn widget_session_cannot_approve_by_cli_or_by_its_token() {
    let h = Home::new();
    out_ok(&h.cli(&["session", "list"]));
    // 1. The CLI inside the session asks the owner instead of approving (v1a-23 flip: was the session hint).
    let out = in_session(
        &h,
        &format!("{BIN} widget allow open-prs --read 2>&1; echo END; sleep 30"),
    );
    assert!(out.contains(WAITING), "{out}");
    // 2. The session's own token on the core socket does not approve either: the core raises the waiting item
    // (v1a-23 flip: was "operation not granted").
    let out = in_session(&h, "echo TOKEN=$NUNCHIRO_TOKEN; echo END; sleep 30");
    let token = out
        .lines()
        .find_map(|l| l.trim().split_once("TOKEN=").map(|(_, t)| t))
        .expect("token printed")
        .to_string();
    let hash = approval::status(&h.0, "open-prs").unwrap().hash;
    let reply = raw(
        &h.0,
        &token,
        Request::ApprovalGrant {
            name: "open-prs".into(),
            level: Level::Read,
            hash,
        },
    );
    assert!(reply.contains(r#""type":"waiting""#), "{reply}");
    assert!(!h.0.join("approvals.json").exists());
}

fn raw(home: &Path, token: &str, request: Request) -> String {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    let mut line = serde_json::to_vec(&Envelope {
        token: token.into(),
        request,
    })
    .unwrap();
    line.push(b'\n');
    s.write_all(&line).unwrap();
    let mut reply = String::new();
    BufReader::new(s).read_line(&mut reply).unwrap();
    reply
}

// v1a-23 (needs 47): from a session, `widget allow` raises one waiting item for the owner instead of approving.
const WAITING: &str = "waiting for the owner in the Nunchiro window";
fn owner_items(h: &Home) -> Vec<serde_json::Value> {
    let token = fs::read_to_string(h.0.join("core.token")).unwrap();
    let reply: serde_json::Value =
        serde_json::from_str(&raw(&h.0, &token, Request::Snapshot)).unwrap();
    reply["Ok"]["owner_decisions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn raise(h: &Home) -> serde_json::Value {
    out_ok(&h.cli(&["session", "list"]));
    let out = in_session(
        h,
        &format!("{BIN} widget allow open-prs --read; echo EXIT=$?; echo END; sleep 30"),
    );
    assert!(out.contains(WAITING) && out.contains("EXIT=0"), "{out}");
    let items = owner_items(h);
    assert_eq!(items.len(), 1, "{items:?}");
    items[0].clone()
}

#[test]
fn widget_allow_from_session_raises_waiting_item_and_does_not_approve() {
    let h = Home::new();
    out_ok(&h.cli(&["session", "list"]));
    let out = in_session(
        &h,
        &format!(
            "{BIN} widget allow open-prs --read; echo EXIT=$?; {BIN} widget allow open-prs --read; echo EXIT=$?; \
             {BIN} widget allow missing --read; echo MISSING=$?; echo END; sleep 30"
        ),
    );
    assert_eq!(out.matches(WAITING).count(), 2, "{out}");
    assert_eq!(out.matches("EXIT=0").count(), 2, "{out}");
    assert!(out.contains("MISSING=1"), "{out}");
    assert!(!h.0.join("approvals.json").exists());
    let status = approval::status(&h.0, "open-prs").unwrap();
    assert_eq!(status.state, State::Unapproved);
    let items = owner_items(&h);
    assert_eq!(
        items.len(),
        1,
        "one item on repeat, none for an unknown widget: {items:?}"
    );
    let ask = &items[0]["owner"];
    assert_eq!(ask["type"], "approval");
    assert_eq!(ask["subject"], "widget");
    assert_eq!(ask["name"], "open-prs");
    assert_eq!(ask["level"], "read");
    assert_eq!(ask["hash"], status.hash.as_str());
}

#[test]
fn owner_click_on_widget_item_approves_at_shown_hash() {
    let h = Home::new();
    let item = raise(&h);
    let hash = item["owner"]["hash"].as_str().unwrap().to_string();
    call(
        &h.0,
        Request::ApprovalGrant {
            name: "open-prs".into(),
            level: Level::Read,
            hash: hash.clone(),
        },
    )
    .unwrap();
    let status = approval::status(&h.0, "open-prs").unwrap();
    assert_eq!(status.state, State::Approved);
    assert_eq!(status.hash, hash);
    assert!(owner_items(&h).is_empty(), "the approval answered the item");
}

#[test]
fn widget_item_click_after_manifest_change_asks_again() {
    let h = Home::new();
    let item = raise(&h);
    let hash = item["owner"]["hash"].as_str().unwrap().to_string();
    let script = h.0.join("widgets/open-prs/open-prs.sh");
    let mut body = fs::read(&script).unwrap();
    body.extend_from_slice(b"\n# changed after the ask\n");
    fs::write(&script, body).unwrap();
    let r = call(
        &h.0,
        Request::ApprovalGrant {
            name: "open-prs".into(),
            level: Level::Read,
            hash,
        },
    );
    assert!(r.is_err(), "{r:?}");
    assert_ne!(
        approval::status(&h.0, "open-prs").unwrap().state,
        State::Approved
    );
    assert_eq!(
        owner_items(&h).len(),
        1,
        "the item stays until the owner approves what is there now"
    );
}

#[test]
fn widget_allow_outside_session_unchanged() {
    let h = Home::new();
    out_ok(&h.cli(&["widget", "allow", "open-prs", "--read"]));
    assert_eq!(
        approval::status(&h.0, "open-prs").unwrap().state,
        State::Approved
    );
    assert!(owner_items(&h).is_empty());
}
