//! CHAT-STOP characterization (no src change): the key gating the window's Stop button and Esc rely on. A lone `esc`
//! passes a pending decision, every other send is refused `agent_blocked`, and the window's `send_keys ["esc"]`
//! reaches the PTY once. Same harness as perm_chip.rs (fixtures untouched). Fake agents only.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("chatstop");
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        fs::copy(fixtures.join("claude-mode"), home.join("claude")).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(core.request(Request::Snapshot), Ok(Reply::Snapshot { .. })) {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn request(&self, r: Request) -> Response {
        call(&self.home, r)
    }
    fn start(&self, kind: AgentKind) -> Session {
        match self.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: self.home.clone(),
                worktree: false,
                label: "mode".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Ok(Reply::Started { session }) => session,
            other => panic!("start failed: {other:?}"),
        }
    }
    fn session(&self, id: &str) -> Session {
        match self.request(Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
            _ => panic!(),
        }
    }
    fn wait(&self, what: &str, f: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// Every stdin read the fake agent saw, as hex.
    fn reads(&self, id: &str) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("stdin-{id}.log")))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.strip_prefix("READ ").map(str::to_string))
            .collect()
    }
    /// The window's raw key path (`send_keys`), the one Stop and Esc use: ungated, written straight to the PTY.
    fn agent_keys(&self, id: &str, keys: &[&str]) -> Response {
        self.request(Request::AgentKeys {
            id: id.into(),
            keys: keys.iter().map(|k| k.to_string()).collect(),
        })
    }
    /// As the window sends them: with the pending item ids it has drawn for the session (ticket 115).
    fn keys(&self, id: &str, keys: &[&str]) -> Response {
        self.request(Request::SendKeys {
            id: id.into(),
            keys: keys.iter().map(|k| k.to_string()).collect(),
            seen: self
                .session(id)
                .pending
                .iter()
                .map(|p| p.id.clone())
                .collect(),
            composer: false,
        })
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.request(Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn dialog(core: &Core, id: &str) {
    core.wait("the box", || core.session(id).permission_mode.is_some());
    core.request(Request::SendText {
        id: id.into(),
        text: "D".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the dialog", || {
        core.session(id)
            .pending
            .iter()
            .any(|p| !p.choices.is_empty())
    });
}

#[test]
fn key_gating_unchanged() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    dialog(&core, &id);
    assert_eq!(core.reads(&id), ["44"]);
    // The gated (agent / queued) path: Enter would approve the dialog's default choice, text would type into it.
    let enter = core.agent_keys(&id, &["enter"]).unwrap_err();
    assert!(enter.contains("agent_blocked"), "{enter}");
    let text = core
        .request(Request::AgentSend {
            id: id.clone(),
            text: "hello".into(),
        })
        .unwrap_err();
    assert!(text.contains("agent_blocked"), "{text}");
    let compound = core.agent_keys(&id, &["esc", "enter"]).unwrap_err();
    assert!(compound.contains("agent_blocked"), "{compound}");
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        core.reads(&id),
        ["44"],
        "nothing but the D byte reached the agent"
    );
    // A lone esc is the interrupt: allowed past the pending decision, once.
    core.agent_keys(&id, &["esc"]).unwrap();
    core.wait("the esc to land", || core.reads(&id) == ["44", "1b"]);
}

/// The window's own `send_keys` is not gated by a pending decision (only a model switch refuses it): the web must
/// not send it while one is shown. Pinned so a core change that gates it is noticed.
#[test]
fn window_send_keys_is_raw() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    dialog(&core, &id);
    core.keys(&id, &["esc"]).unwrap();
    core.wait("the esc to land", || core.reads(&id) == ["44", "1b"]);
}

#[test]
fn window_esc_reaches_the_pty_once() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the box", || core.session(&id).permission_mode.is_some());
    core.keys(&id, &["esc"]).unwrap();
    core.wait("the esc to land", || core.reads(&id) == ["1b"]);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.reads(&id), ["1b"], "one press, one byte");
}
