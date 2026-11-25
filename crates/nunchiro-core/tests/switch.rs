//! V2-3b: agent switch inside a conversation (`handoff_send`), through fake agents only. Each fake logs every
//! stdin read as hex, so a test sees exactly the bytes Nunchiro wrote to its PTY.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

/// One script for both agents (named by argv0). Prints a ready prompt, reports a Codex conversation id through the
/// SessionStart hook in its args, and appends `READ <hex>` per stdin read to `stdin-<session>.log`.
const FAKE: &str = r#"#!/usr/bin/env python3
import json, os, re, subprocess, sys, tty
if '--version' in sys.argv:
    print('codex-cli 0.161.0' if sys.argv[0].endswith('codex') else '2.1.310 (Claude Code)')
    raise SystemExit
codex = sys.argv[0].endswith('codex')
home = os.environ['NUNCHIRO_HOME']
log = open(os.path.join(home, 'stdin-' + os.environ['NUNCHIRO_SESSION'] + '.log'), 'a')
log.write('LAUNCH ' + json.dumps(sys.argv[1:]) + '\n')
log.flush()
open(os.path.join(home, 'token-' + os.environ['NUNCHIRO_SESSION']), 'w').write(os.environ.get('NUNCHIRO_TOKEN', ''))
for arg in sys.argv[1:]:
    if codex and arg.startswith('hooks.SessionStart='):
        command = json.loads(re.search(r'command=("(?:[^"\\]|\\.)*")', arg).group(1))
        subprocess.run(command, shell=True, input=json.dumps({'session_id': 'FAKE-CODEX-' + os.environ['NUNCHIRO_SESSION'][:8]}).encode(), check=True)
tty.setraw(0)
sys.stdout.write('\x1b[2J\x1b[H' + ('› ' if codex else '❯ ') + '\r\n')
sys.stdout.flush()
while True:
    data = os.read(0, 4096)
    if not data:
        break
    log.write('READ ' + data.hex() + '\n')
    log.flush()
"#;

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("switch");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(home.join("codex-home")).unwrap();
        fs::create_dir_all(home.join("project")).unwrap();
        for name in ["claude", "codex"] {
            fs::write(home.join("bin").join(name), home::codex_fake(FAKE)).unwrap();
            fs::set_permissions(
                home.join("bin").join(name),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CODEX_HOME", home.join("codex-home"))
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(
            call(&core.home, Request::Snapshot),
            Ok(Reply::Snapshot { .. })
        ) {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn start(&self, kind: AgentKind, model: Option<&str>) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.join("project"),
                    worktree: false,
                    label: "switch".into(),
                    args: vec![],
                    model: model.map(Into::into),
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            other => panic!("{other:?}"),
        }
    }
    fn sessions(&self) -> Vec<Session> {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions,
            _ => panic!(),
        }
    }
    fn session(&self, id: &str) -> Option<Session> {
        self.sessions().into_iter().find(|s| s.id == id)
    }
    /// The owner socket, raw, so a refusal reads as the wire shows it.
    fn raw(&self, token: &str, request: Value) -> Value {
        let mut sock = UnixStream::connect(self.home.join("core.sock")).unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
    fn owner(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        self.raw(token.trim(), request)
    }
    fn handoff(&self, from: &str, to: &str, text: &str) -> Value {
        self.owner(json!({"op":"handoff_send","from":from,"to":to,"text":text}))
    }
    /// Bytes read by the fake agent of `id` so far.
    fn written(&self, id: &str) -> Vec<u8> {
        let log = fs::read_to_string(self.home.join(format!("stdin-{id}.log"))).unwrap_or_default();
        log.lines()
            .filter_map(|l| l.strip_prefix("READ "))
            .flat_map(|h| {
                (0..h.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    fn wait<T>(&self, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(Instant::now() < until, "timed out: {what}");
            thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

fn session(reply: &Value) -> Session {
    serde_json::from_value(reply["Ok"]["session"].clone()).unwrap_or_else(|_| panic!("{reply}"))
}

#[test]
fn switch_claude_codex_claude_core() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, Some("sonnet"));
    // The text as the window sends it, with control sequences an edited chip could carry.
    let reply = core.handoff(
        &claude.id,
        "codex",
        "Handoff from Claude\n\tnext\x1b[31m ask\x07\r",
    );
    let codex = session(&reply);
    assert_eq!(codex.kind, AgentKind::Codex);
    assert_eq!(codex.cwd, claude.cwd, "same folder");
    let sent = b"Handoff from Claude\n\tnext[31m ask\r".to_vec();
    core.wait("codex got the handoff", || {
        (core.written(&codex.id) == sent).then_some(())
    });
    assert!(
        core.written(&claude.id).is_empty(),
        "nothing typed into Claude"
    );
    let conversation = codex.conversation.clone().expect("conversation id");
    assert_eq!(
        core.session(&claude.id).unwrap().conversation,
        Some(conversation.clone())
    );

    // Back to Claude: the same session, not a new one.
    let back = session(&core.handoff(&codex.id, "claude", "back"));
    assert_eq!(back.id, claude.id);
    core.wait("claude got the handoff", || {
        (core.written(&claude.id) == b"back\r").then_some(())
    });
    assert_eq!(core.sessions().len(), 2);
}

#[test]
fn switch_new_target_takes_last_model_of_its_agent() {
    let core = Core::new();
    let earlier = core.start(AgentKind::Codex, Some("gpt-6-luna"));
    call(&core.home, Request::Close { id: earlier.id }).unwrap();
    let claude = core.start(AgentKind::Claude, None);
    let codex = session(&core.handoff(&claude.id, "codex", "go"));
    assert_eq!(codex.model.as_deref(), Some("gpt-6-luna"));
}

#[test]
fn switch_reuse_resumable() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    let codex = session(&core.handoff(&claude.id, "codex", "first"));
    let agent_id = core.wait("codex reported its id", || {
        core.session(&codex.id).and_then(|s| s.agent_session_id)
    });
    call(
        &core.home,
        Request::Close {
            id: codex.id.clone(),
        },
    )
    .unwrap();
    assert_eq!(core.session(&codex.id).unwrap().state, SessionState::Closed);

    let again = session(&core.handoff(&claude.id, "codex", "second"));
    assert_eq!(
        again.agent_session_id.as_deref(),
        Some(agent_id.as_str()),
        "resumed"
    );
    assert_eq!(again.conversation, codex.conversation);
    let codexes: Vec<_> = core
        .sessions()
        .into_iter()
        .filter(|s| s.kind == AgentKind::Codex)
        .collect();
    assert_eq!(codexes.len(), 1, "not duplicated: {codexes:?}");
    core.wait("resumed codex got the text", || {
        (core.written(&again.id) == b"second\r").then_some(())
    });
}

#[test]
fn switch_pending_permission_stays_core() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    call(
        &core.home,
        Request::Hook {
            id: claude.id.clone(),
            event: "PermissionRequest".into(),
            payload: json!({"tool_name":"Bash","tool_input":{"command":"true"}}),
        },
    )
    .unwrap();
    let pending = |id: &str| core.session(id).unwrap().pending.len();
    assert_eq!(pending(&claude.id), 1);
    let codex = session(&core.handoff(&claude.id, "codex", "go"));
    assert_eq!(pending(&claude.id), 1, "stays on Claude");
    assert_eq!(pending(&codex.id), 0, "never on Codex");
    assert_eq!(
        core.session(&claude.id).unwrap().state,
        SessionState::Running
    );
}

#[test]
fn switch_refusals_start_nothing() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    for (to, text, why) in [
        ("claude", "x", "another agent"),
        ("shell", "x", "another agent"),
        ("codex", "", "nothing to send"),
    ] {
        let reply = core.handoff(&claude.id, to, text);
        assert!(
            reply["Err"].as_str().is_some_and(|e| e.contains(why)),
            "{to}: {reply}"
        );
    }
    let long = "a".repeat(70_000);
    assert!(core.handoff(&claude.id, "codex", &long)["Err"].is_string());
    assert!(core.handoff("missing", "codex", "x")["Err"].is_string());
    assert_eq!(core.sessions().len(), 1, "no session started");
    assert!(core.written(&claude.id).is_empty());
}

#[test]
fn handoff_preview_is_owner_only() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    // The owner socket answers it (before V2-3b only the window could).
    let reply = core.owner(json!({"op":"handoff_preview","id":claude.id}));
    let text = reply["Ok"]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{reply}"));
    assert!(
        text.starts_with("Handoff from Claude (0 turns, session "),
        "{text}"
    );
    let reply = core.owner(
        json!({"op":"remote","machine":"m","request":{"op":"handoff_preview","id":claude.id}}),
    );
    assert!(
        reply["Err"]
            .as_str()
            .is_some_and(|e| e.contains("local owner-only")),
        "{reply}"
    );
    let reply = core.owner(json!({"op":"remote","machine":"m","request":{"op":"handoff_send","from":claude.id,"to":"codex","text":"x"}}));
    assert!(
        reply["Err"]
            .as_str()
            .is_some_and(|e| e.contains("local owner-only")),
        "{reply}"
    );
}

#[test]
fn handoff_preview_refused_for_session_token() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    let token = core.wait("claude's token", || {
        fs::read_to_string(core.home.join(format!("token-{}", claude.id)))
            .ok()
            .filter(|t| !t.is_empty())
    });
    for request in [
        json!({"op":"handoff_preview","id":claude.id}),
        json!({"op":"handoff_send","from":claude.id,"to":"codex","text":"x"}),
    ] {
        assert_eq!(
            core.raw(&token, request),
            json!({"Err":"operation not granted"})
        );
    }
    assert_eq!(core.sessions().len(), 1, "no session started");
}

// Two Enters at once (a double press, a second window): one target session, both texts on it.
#[test]
fn switch_concurrent_enters_start_one_target() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, None);
    let replies: Vec<Value> = thread::scope(|scope| {
        let runs: Vec<_> = ["one", "two"]
            .map(|text| scope.spawn(|| core.handoff(&claude.id, "codex", text)))
            .into_iter()
            .collect();
        runs.into_iter().map(|r| r.join().unwrap()).collect()
    });
    let ids: Vec<String> = replies.iter().map(|r| session(r).id).collect();
    assert_eq!(ids[0], ids[1], "{replies:?}");
    let codexes = core
        .sessions()
        .into_iter()
        .filter(|s| s.kind == AgentKind::Codex)
        .count();
    assert_eq!(codexes, 1);
}
