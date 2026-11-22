//! Script widget act (ticket v1b-20): one named test per acceptance item and edge case, through the core's unix
//! socket with the real sandbox. Targets are a recording fake `claude` (written by setup: raw PTY, every byte lands in a
//! file) or the synthetic claude/codex fixtures from crates/nunchiro/tests/fixtures/agent-cli; no real agent runs.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    approval::{self, Level},
    delivery, server,
    widgets::{self, act},
};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    sync::Once,
    thread,
    time::{Duration, Instant},
};

/// `claude --record FILE` records raw PTY input into FILE (and its token into `.token-FILE`) behind a ready `❯`; any
/// other call runs the shared fixture. `codex --version` first runs a one-shot `revoke` file (Python), so a test can
/// change or re-approve a widget while the core prepares a `start` act.
const FAKE: &str = r#"#!/usr/bin/env python3
import os, sys, tty
here = os.path.dirname(os.path.abspath(__file__))
tool = os.path.basename(sys.argv[0])
fixture = os.path.join(os.environ['NUNCHIRO_TEST_FIXTURES'], tool)
if tool == 'codex' and '--version' in sys.argv:
    claim = os.path.join(here, 'revoke.%d' % os.getpid())
    try:
        os.rename(os.path.join(here, 'revoke'), claim)
        exec(open(claim).read())
        os.remove(claim)
    except FileNotFoundError:
        pass
if '--record' not in sys.argv:
    os.execv(fixture, [fixture] + sys.argv[1:])
name = sys.argv[sys.argv.index('--record') + 1]
tty.setraw(0)
open('.token-' + name, 'w').write(os.environ.get('NUNCHIRO_TOKEN', ''))
os.write(1, '\u276f '.encode())
out = open(name, 'wb')
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data)
    out.flush()
"#;
fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../.scratch/wa-bin-{}", std::process::id()))
}
fn setup() {
    static PATH: Once = Once::new();
    PATH.call_once(|| {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../nunchiro/tests/fixtures/agent-cli")
            .canonicalize()
            .unwrap();
        let bin = bin();
        fs::create_dir_all(&bin).unwrap();
        for tool in ["claude", "codex"] {
            fs::write(bin.join(tool), FAKE).unwrap();
            fs::set_permissions(bin.join(tool), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // SAFETY: every test calls setup() before it starts a core or any other thread of its own, and Once makes
        // the others wait until these writes are done.
        unsafe {
            std::env::set_var("NUNCHIRO_TEST_FIXTURES", &fixtures);
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin.canonicalize().unwrap().display(),
                    std::env::var("PATH").unwrap()
                ),
            )
        };
    });
}

struct Core {
    home: PathBuf,
    project: PathBuf,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}
impl Core {
    fn new(tag: &str, settings: &str) -> Self {
        setup();
        let home = home::short(&format!("wa-{tag}"));
        fs::create_dir_all(home.join("p/proj")).unwrap();
        fs::write(home.join("settings.json"), settings).unwrap();
        let path = home.clone();
        let task = thread::spawn(move || server::serve_recording(&path));
        let start = Instant::now();
        // The socket file appears at bind, a moment before listen: wait for a connect, not the file.
        while UnixStream::connect(home.join("core.sock")).is_err() {
            assert!(start.elapsed() < Duration::from_secs(30));
            thread::sleep(Duration::from_millis(10));
        }
        Self {
            project: home.join("p/proj"),
            home,
            task: Some(task),
        }
    }
    fn on(tag: &str) -> Self {
        Self::new(tag, r#"{"script_widgets":true}"#)
    }
    fn owner(&self, request: Request) -> Response {
        raw(
            &self.home,
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
    fn start(&self, kind: AgentKind, label: &str, project: &Path, args: &[&str]) -> Session {
        let Reply::Started { session } = self
            .owner(Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: project.into(),
                    worktree: false,
                    label: label.into(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            })
            .unwrap()
        else {
            panic!("not started")
        };
        session
    }
    /// A raw, echo-free `/bin/cat` into `<project>/<file>`: the file holds exactly the bytes the PTY got.
    /// A recording Claude: `<project>/<file>` holds exactly the bytes its PTY got.
    fn target(&self, label: &str, file: &str) -> Session {
        let s = self.start(AgentKind::Claude, label, &self.project, &["--record", file]);
        assert!(wait(|| self.project.join(file).exists(), 10));
        assert!(wait(|| self.screen(&s.id).contains('\u{276f}'), 10));
        s
    }
    fn bytes(&self, file: &str) -> Vec<u8> {
        fs::read(self.project.join(file)).unwrap()
    }
    fn widget(&self, name: &str, rows: serde_json::Value, act: &str) {
        let d = self.home.join("widgets").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!(
                "version=1\nkind='script'\ncommand=['/bin/sh','w.sh']\ninterval=10\npermissions=['read','act']\n{act}"
            ),
        )
        .unwrap();
        fs::write(d.join("w.sh"), "/bin/cat rows.json\n").unwrap();
        fs::write(d.join("rows.json"), rows.to_string()).unwrap();
    }
    fn grant(&self, name: &str, level: Level) {
        let v = approval::status(&self.home, name).unwrap();
        approval::grant(&self.home, name, level, &v.hash).unwrap();
    }
    fn run(&self, name: &str, session: &str) -> widgets::Run {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let Reply::WidgetRun { run } = self
                .owner(Request::WidgetRun {
                    name: name.into(),
                    session: Some(session.into()),
                })
                .unwrap()
            else {
                panic!()
            };
            if !run.running || Instant::now() > until {
                assert!(run.error.is_none(), "{:?}", run.error);
                return run;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn act(&self, name: &str, session: &str, row: usize, ran_at_ms: u64) -> Response {
        self.owner(Request::WidgetAct {
            name: name.into(),
            session: Some(session.into()),
            row: Some(row),
            ran_at_ms: Some(ran_at_ms),
            text: None,
            target: None,
            hash: None,
            frame: None,
        })
    }
    fn session(&self, id: &str) -> Session {
        let Reply::Snapshot { sessions, .. } = self.owner(Request::Snapshot).unwrap() else {
            panic!()
        };
        sessions.into_iter().find(|s| s.id == id).unwrap()
    }
    fn screen(&self, id: &str) -> String {
        let Reply::Output { data, .. } = self
            .owner(Request::Read {
                id: id.into(),
                after: 0,
            })
            .unwrap()
        else {
            panic!()
        };
        String::from_utf8_lossy(&data).into_owned()
    }
    /// One `pick` widget granted at `level` whose [act] sends to the `target` session; returns (target, run).
    fn pick(&self, level: Level, rows: serde_json::Value) -> (Session, u64) {
        let target = self.target("target", "received");
        self.widget(
            "pick",
            rows,
            "[act]\ntemplate = \"look at {title} #{n}\"\nsession = \"target\"\n",
        );
        self.grant("pick", level);
        let ran = self.run("pick", &target.id).ran_at_ms;
        (target, ran)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.owner(Request::Stop);
        if let Some(t) = self.task.take() {
            t.join().unwrap().unwrap();
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn raw(home: &Path, token: &str, request: Request) -> Response {
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
    serde_json::from_str(&reply).unwrap()
}
fn wait(mut f: impl FnMut() -> bool, secs: u64) -> bool {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if f() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    f()
}
fn rows() -> serde_json::Value {
    serde_json::json!([{"title": "리뷰 🎉 PR", "n": 12}, {"title": "second", "n": 2}])
}
const SENT: &[u8] = "look at 리뷰 🎉 PR #12".as_bytes();

#[test]
fn widgets_act_without_grant_sends_nothing() {
    let core = Core::on("nogrant");
    let (target, ran) = core.pick(Level::Read, rows());
    let e = core.act("pick", &target.id, 0, ran).unwrap_err();
    assert!(e.contains("act is not allowed"), "{e}");
    thread::sleep(Duration::from_millis(300));
    assert!(core.session(&target.id).send_log.is_empty());
    assert!(core.bytes("received").is_empty());
    // The list tells the window rows are not clickable.
    let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
        panic!()
    };
    assert!(
        list.widgets
            .iter()
            .find(|w| w.name == "pick")
            .unwrap()
            .act
            .is_none()
    );
}

#[test]
fn widgets_act_one_click_sends_once() {
    let core = Core::on("once");
    let (target, ran) = core.pick(Level::Act, rows());
    let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
        panic!()
    };
    let listed = list.widgets.iter().find(|w| w.name == "pick").unwrap();
    assert_eq!(
        listed.act.as_ref().unwrap().session.as_deref(),
        Some("target")
    );
    let Reply::WidgetAct { session, send } = core.act("pick", &target.id, 0, ran).unwrap() else {
        panic!()
    };
    assert_eq!(
        (session.as_str(), send.status.as_str()),
        (target.id.as_str(), "delivered")
    );
    // A double click inside 1 s returns the first send and sends nothing more.
    let Reply::WidgetAct { send: again, .. } = core.act("pick", &target.id, 0, ran).unwrap() else {
        panic!()
    };
    assert_eq!(again.id, send.id);
    assert!(wait(|| core.bytes("received") == SENT, 5));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.bytes("received"), SENT);
    assert_eq!(core.session(&target.id).send_log.len(), 1);
    // A later click is a new click.
    thread::sleep(act::AGAIN);
    core.act("pick", &target.id, 0, ran).unwrap();
    assert!(wait(|| core.bytes("received") == [SENT, SENT].concat(), 5));
    assert_eq!(core.session(&target.id).send_log.len(), 2);
}

#[test]
fn widgets_act_logged_and_marked() {
    let core = Core::on("logged");
    let (target, ran) = core.pick(Level::Act, rows());
    core.act("pick", &target.id, 1, ran).unwrap();
    let log = core.session(&target.id).send_log;
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].sender, "widget:pick");
    assert_eq!(log[0].content, "look at second #2");
    assert!(!log[0].submit);
    // The stored registry (what `snapshot --json` and a restart read) keeps the widget sender.
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(stored.contains("\"sender\": \"widget:pick\""), "{stored}");
}

#[test]
fn widgets_act_never_without_click() {
    let core = Core::on("noclick");
    let (target, _) = core.pick(Level::Act, rows());
    // The output changes over several runs (each edit is reviewed and allowed again); nothing is ever sent.
    for i in 0..3 {
        fs::write(
            core.home.join("widgets/pick/rows.json"),
            serde_json::json!([{"title": format!("run {i}"), "n": i}]).to_string(),
        )
        .unwrap();
        core.grant("pick", Level::Act);
        let Some(widgets::Output::Json { text }) = core.run("pick", &target.id).output else {
            panic!()
        };
        assert!(text.contains(&format!("run {i}")));
    }
    thread::sleep(Duration::from_millis(500));
    assert!(core.session(&target.id).send_log.is_empty());
    assert!(core.session(&target.id).send_queue.is_empty());
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_cannot_answer() {
    // The request has exactly these fields: no answer, item, keys or text reaches the core from the window.
    let v = serde_json::to_value(Request::WidgetAct {
        name: "w".into(),
        session: Some("s".into()),
        row: Some(0),
        ran_at_ms: Some(1),
        text: None,
        target: None,
        hash: None,
        frame: None,
    })
    .unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["name", "op", "ran_at_ms", "row", "session"]);
    assert_eq!(v["op"], "widget_act");
    assert!(widgets::WINDOW_REQUESTS.contains(&"widget_act"));
    assert!(
        !widgets::WINDOW_REQUESTS
            .iter()
            .any(|op| op.contains("answer"))
    );
    // A session with an open permission prompt: the act is refused and the decision stays pending.
    let core = Core::on("answer");
    let agent = core.start(
        AgentKind::Claude,
        "target",
        &core.project,
        &["--fixture-permission"],
    );
    assert!(wait(|| !core.session(&agent.id).pending.is_empty(), 10));
    core.widget(
        "pick",
        serde_json::json!([{"title": "1", "n": 1}]),
        "[act]\ntemplate = \"{title}\"\nsession = \"target\"\n",
    );
    core.grant("pick", Level::Act);
    let ran = core.run("pick", &agent.id).ran_at_ms;
    let e = core.act("pick", &agent.id, 0, ran).unwrap_err();
    assert_eq!(e, "agent_blocked");
    let s = core.session(&agent.id);
    assert_eq!(s.pending.len(), 1);
    assert!(s.send_log.is_empty() && s.send_queue.is_empty());
    assert!(!core.screen(&agent.id).contains("CHOICE:"));
}

#[test]
fn widgets_act_changed_after_grant_refused() {
    let core = Core::on("changed");
    let (target, ran) = core.pick(Level::Act, rows());
    fs::write(
        core.home.join("widgets/pick/w.sh"),
        "/bin/cat rows.json\n# edited\n",
    )
    .unwrap();
    let e = core.act("pick", &target.id, 0, ran).unwrap_err();
    assert!(e.contains("changed"), "{e}");
    let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
        panic!()
    };
    let w = list.widgets.iter().find(|w| w.name == "pick").unwrap();
    assert_eq!(w.state, Some(approval::State::Changed));
    assert!(w.act.is_none());
    // Allowed again at read only: still no act.
    core.grant("pick", Level::Read);
    let ran = core.run("pick", &target.id).ran_at_ms;
    assert!(
        core.act("pick", &target.id, 0, ran)
            .unwrap_err()
            .contains("act is not allowed")
    );
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_session_token_refused() {
    let core = Core::on("token");
    let (target, ran) = core.pick(Level::Act, rows());
    let token = fs::read_to_string(core.project.join(".token-received")).unwrap();
    assert!(!token.is_empty());
    let e = raw(
        &core.home,
        &token,
        Request::WidgetAct {
            name: "pick".into(),
            session: Some(target.id.clone()),
            row: Some(0),
            ran_at_ms: Some(ran),
            text: None,
            target: None,
            hash: None,
            frame: None,
        },
    )
    .unwrap_err();
    assert_eq!(e, "operation not granted");
    // Nor through a remote forward.
    let e = core
        .owner(Request::Remote {
            machine: "m".into(),
            request: Box::new(Request::WidgetAct {
                name: "pick".into(),
                session: Some(target.id.clone()),
                row: Some(0),
                ran_at_ms: Some(ran),
                text: None,
                target: None,
                hash: None,
                frame: None,
            }),
        })
        .unwrap_err();
    assert!(e.contains("local owner-only"), "{e}");
    thread::sleep(Duration::from_millis(300));
    assert!(core.session(&target.id).send_log.is_empty());
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_leading_command_characters_refused() {
    for text in [
        "/model opus",
        " /effort high",
        "!rm -rf x",
        "#remember this",
        "\u{200b}/model x",
        "ok\n/model x",
        "\t#x",
    ] {
        assert_eq!(
            act::check_leading(text).unwrap_err(),
            act::LEADING,
            "{text:?}"
        );
    }
    for text in ["look at /model", "a # b", "리뷰 !"] {
        act::check_leading(text).unwrap();
    }
    let core = Core::on("leading");
    let target = core.target("target", "received");
    core.widget(
        "pick",
        serde_json::json!([{"t": "/model opus"}, {"t": "!ls"}, {"t": "#mem"}, {"t": "fine"}]),
        "[act]\ntemplate = \"{t}\"\nsession = \"target\"\n",
    );
    core.grant("pick", Level::Act);
    let ran = core.run("pick", &target.id).ran_at_ms;
    for row in 0..3 {
        assert_eq!(
            core.act("pick", &target.id, row, ran).unwrap_err(),
            act::LEADING
        );
    }
    // A template whose second line starts with `/`.
    core.widget(
        "two",
        serde_json::json!([{"t": "x"}]),
        "[act]\ntemplate = \"{t}\\n/model haiku\"\nsession = \"target\"\n",
    );
    core.grant("two", Level::Act);
    let ran2 = core.run("two", &target.id).ran_at_ms;
    assert_eq!(
        core.act("two", &target.id, 0, ran2).unwrap_err(),
        act::LEADING
    );
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("received").is_empty());
    core.act("pick", &target.id, 3, ran).unwrap();
    assert!(wait(|| core.bytes("received") == b"fine", 5));
}

#[test]
fn widgets_act_check_text_refused() {
    let core = Core::on("checktext");
    let big = "x".repeat(70 * 1024);
    let (target, ran) = core.pick(
        Level::Act,
        serde_json::json!([{"title": "bell\u{7}", "n": 1}, {"title": "esc\u{1b}[2J", "n": 2}, {"title": big, "n": 3}]),
    );
    for row in 0..3 {
        assert_eq!(
            core.act("pick", &target.id, row, ran).unwrap_err(),
            "invalid send text"
        );
    }
    thread::sleep(Duration::from_millis(300));
    assert!(core.session(&target.id).send_log.is_empty());
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_template_values_refused() {
    let row = serde_json::json!({"s": "ok", "n": 1.5, "b": true, "z": null, "a": [1], "o": {"k": 1}, "nl": "a\nb", "cr": "a\rb"});
    assert_eq!(act::render("{s} {n} {b}", &row).unwrap(), "ok 1.5 true");
    assert!(
        act::render("{missing}", &row)
            .unwrap_err()
            .contains("no field missing")
    );
    for f in ["z", "a", "o"] {
        assert!(
            act::render(&format!("{{{f}}}"), &row)
                .unwrap_err()
                .contains("not a string"),
            "{f}"
        );
    }
    for f in ["nl", "cr"] {
        assert!(
            act::render(&format!("{{{f}}}"), &row)
                .unwrap_err()
                .contains("newline"),
            "{f}"
        );
    }
    assert!(act::render("{s}", &serde_json::json!("scalar row")).is_err());
    let core = Core::on("values");
    let (target, ran) = core.pick(
        Level::Act,
        serde_json::json!([{"n": 1}, {"title": null, "n": 2}, {"title": ["x"], "n": 3}, {"title": "a\nb", "n": 4}, "scalar"]),
    );
    for row in 0..5 {
        assert!(core.act("pick", &target.id, row, ran).is_err(), "{row}");
    }
    thread::sleep(Duration::from_millis(300));
    assert!(core.session(&target.id).send_log.is_empty());
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_manifest_rules() {
    let core = Core::on("manifest");
    let write = |name: &str, perms: &str, extra: &str| {
        let d = core.home.join("widgets").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!(
                "version=1\nkind='script'\ncommand=['/bin/true']\npermissions={perms}\n{extra}"
            ),
        )
        .unwrap();
        approval::status(&core.home, name)
    };
    let ok = "[act]\ntemplate='{t}'\nsession='x'\n";
    write("good", "['read','act']", ok).unwrap();
    write(
        "start",
        "['read','act']",
        "[act]\ntemplate='{t}'\nstart='codex'\n",
    )
    .unwrap();
    for (name, perms, extra) in [
        ("noact", "['read']", ok),
        (
            "both",
            "['read','act']",
            "[act]\ntemplate='{t}'\nsession='x'\nstart='claude'\n",
        ),
        ("neither", "['read','act']", "[act]\ntemplate='{t}'\n"),
        (
            "shell",
            "['read','act']",
            "[act]\ntemplate='{t}'\nstart='shell'\n",
        ),
        (
            "gemini",
            "['read','act']",
            "[act]\ntemplate='{t}'\nstart='gemini'\n",
        ),
        (
            "unknown",
            "['read','act']",
            "[act]\ntemplate='{t}'\nsession='x'\nkeys=['enter']\n",
        ),
        (
            "brace",
            "['read','act']",
            "[act]\ntemplate='{a b}'\nsession='x'\n",
        ),
        (
            "close",
            "['read','act']",
            "[act]\ntemplate='a } b'\nsession='x'\n",
        ),
        (
            "open",
            "['read','act']",
            "[act]\ntemplate='a { b'\nsession='x'\n",
        ),
        (
            "empty",
            "['read','act']",
            "[act]\ntemplate=' '\nsession='x'\n",
        ),
        (
            "ctrl",
            "['read','act']",
            "[act]\ntemplate=\"a\\u001bb\"\nsession='x'\n",
        ),
        (
            "bidi",
            "['read','act']",
            "[act]\ntemplate=\"a\\u202eb\"\nsession='x'\n",
        ),
        (
            "label",
            "['read','act']",
            "[act]\ntemplate='{t}'\nsession=' '\n",
        ),
    ] {
        assert!(write(name, perms, extra).is_err(), "{name} parsed");
    }
    // The sheet shows the table verbatim from the parsed, hashed manifest.
    let v = approval::status(&core.home, "good").unwrap();
    let a = v.manifest.act.unwrap();
    assert_eq!(
        (a.template.as_str(), a.session.as_deref(), a.start),
        ("{t}", Some("x"), None)
    );
    assert!(v.manifest_text.contains("[act]"));
}

#[test]
fn widgets_act_target_by_label() {
    let core = Core::on("label");
    let (target, ran) = core.pick(Level::Act, rows());
    let twin = core.target("target", "twin");
    assert_eq!(
        core.act("pick", &target.id, 0, ran).unwrap_err(),
        "2 sessions named target"
    );
    core.owner(Request::Close {
        id: twin.id.clone(),
    })
    .unwrap();
    // Another project's session with the label never counts; an exited one neither.
    let other = core.home.join("p/other");
    fs::create_dir_all(&other).unwrap();
    core.start(AgentKind::Shell, "target2", &other, &["/bin/cat"]);
    core.widget(
        "miss",
        serde_json::json!([{"t": "x"}]),
        "[act]\ntemplate = \"{t}\"\nsession = \"target2\"\n",
    );
    core.grant("miss", Level::Act);
    let r = core.run("miss", &target.id).ran_at_ms;
    assert_eq!(
        core.act("miss", &target.id, 0, r).unwrap_err(),
        "no session named target2"
    );
    assert!(core.bytes("twin").is_empty() && core.bytes("received").is_empty());
    core.act("pick", &target.id, 0, ran).unwrap();
    assert!(wait(|| core.bytes("received") == SENT, 5));
    // A placement without a session has no project, so no act.
    let e = core
        .owner(Request::WidgetAct {
            name: "pick".into(),
            session: None,
            row: Some(0),
            ran_at_ms: Some(ran),
            text: None,
            target: None,
            hash: None,
            frame: None,
        })
        .unwrap_err();
    assert!(e.contains("placement's session"), "{e}");
}

#[test]
fn widgets_act_closed_target_cancels_queued() {
    let core = Core::on("closed");
    let agent = core.start(
        AgentKind::Claude,
        "target",
        &core.project,
        &["--fixture-busy"],
    );
    assert!(wait(|| core.session(&agent.id).attention.working, 10));
    core.widget(
        "pick",
        serde_json::json!([{"t": "queued text"}]),
        "[act]\ntemplate = \"{t}\"\nsession = \"target\"\n",
    );
    core.grant("pick", Level::Act);
    let ran = core.run("pick", &agent.id).ran_at_ms;
    let Reply::WidgetAct { send, .. } = core.act("pick", &agent.id, 0, ran).unwrap() else {
        panic!()
    };
    assert_eq!(send.status, "queued");
    core.owner(Request::Close {
        id: agent.id.clone(),
    })
    .unwrap();
    assert!(wait(
        || core
            .session(&agent.id)
            .send_log
            .iter()
            .any(|s| s.id == send.id && s.status == "canceled"),
        5
    ));
}

#[test]
fn widgets_act_queued_needs_current_grant() {
    let core = Core::on("queued");
    let busy = |label: &str| {
        let a = core.start(AgentKind::Claude, label, &core.project, &["--fixture-busy"]);
        assert!(wait(|| core.session(&a.id).attention.working, 10));
        a
    };
    let (kept, dropped) = (busy("kept"), busy("dropped"));
    for (name, label) in [("keep", "kept"), ("drop", "dropped")] {
        core.widget(
            name,
            serde_json::json!([{"t": format!("from {name}")}]),
            &format!("[act]\ntemplate = \"{{t}}\"\nsession = \"{label}\"\n"),
        );
        core.grant(name, Level::Act);
    }
    for (name, agent) in [("keep", &kept), ("drop", &dropped)] {
        let ran = core.run(name, &agent.id).ran_at_ms;
        let Reply::WidgetAct { send, .. } = core.act(name, &agent.id, 0, ran).unwrap() else {
            panic!()
        };
        assert_eq!(send.status, "queued");
    }
    // `drop` changes while its act waits; then both agents finish their turn.
    fs::write(
        core.home.join("widgets/drop/w.sh"),
        "/bin/cat rows.json\n# edited\n",
    )
    .unwrap();
    for agent in [&kept, &dropped] {
        core.owner(Request::SendText {
            id: agent.id.clone(),
            text: "FINISH\r".into(),
            composer: false,
            seen: vec![],
        })
        .unwrap();
    }
    // The fixture does not echo typed text, so the log row is the evidence of delivery.
    assert!(wait(
        || core
            .session(&kept.id)
            .send_log
            .iter()
            .any(|s| s.sender == "widget:keep" && s.status == "delivered"),
        10
    ));
    assert!(wait(
        || core
            .session(&dropped.id)
            .send_log
            .iter()
            .any(|s| s.sender == "widget:drop" && s.status == "canceled"),
        5
    ));
}

#[test]
fn widgets_act_start_session() {
    let core = Core::on("start");
    let place = core.target("place", "received");
    for kind in ["claude", "codex"] {
        let name = format!("start-{kind}");
        core.widget(
            &name,
            serde_json::json!([{"t": format!("hello {kind} 안녕 🎉")}, {"t": "/model opus"}]),
            &format!("[act]\ntemplate = \"{{t}}\"\nstart = \"{kind}\"\n"),
        );
        core.grant(&name, Level::Act);
        let ran = core.run(&name, &place.id).ran_at_ms;
        // A `/` first prompt is refused before anything starts.
        let Reply::Snapshot {
            sessions: before, ..
        } = core.owner(Request::Snapshot).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            core.act(&name, &place.id, 1, ran).unwrap_err(),
            act::LEADING
        );
        let Reply::Snapshot {
            sessions: after, ..
        } = core.owner(Request::Snapshot).unwrap()
        else {
            panic!()
        };
        assert_eq!(before.len(), after.len());
        let Reply::WidgetAct { session, send } = core.act(&name, &place.id, 0, ran).unwrap() else {
            panic!()
        };
        assert!(send.submit);
        let s = core.session(&session);
        assert_eq!(serde_json::to_value(s.kind).unwrap(), kind);
        assert_eq!(
            (s.project.as_path(), s.label.as_str()),
            (core.project.as_path(), name.as_str())
        );
        let ack = format!("ACK:hello {kind} 안녕 🎉");
        assert!(
            wait(|| core.screen(&session).contains(&ack), 10),
            "{}",
            core.screen(&session)
        );
        let log = core.session(&session).send_log;
        assert_eq!(log.len(), 1);
        assert_eq!(
            (log[0].sender.as_str(), log[0].status.as_str()),
            (format!("widget:{name}").as_str(), "delivered")
        );
        assert_eq!(core.screen(&session).matches(&ack).count(), 1);
    }
}

#[test]
fn widgets_act_stale_row_refused() {
    let core = Core::on("stale");
    let (target, ran) = core.pick(Level::Act, rows());
    assert_eq!(
        core.act("pick", &target.id, 0, ran - 1).unwrap_err(),
        act::CHANGED
    );
    assert_eq!(
        core.act("pick", &target.id, 2, ran).unwrap_err(),
        act::CHANGED
    );
    // Text output has no act.
    fs::write(core.home.join("widgets/pick/rows.json"), "plain text").unwrap();
    core.grant("pick", Level::Act);
    let ran = core.run("pick", &target.id).ran_at_ms;
    assert!(
        core.act("pick", &target.id, 0, ran)
            .unwrap_err()
            .contains("JSON array")
    );
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("received").is_empty());
}

#[test]
fn widgets_act_setting_off_refused() {
    let core = Core::new("off", "{}");
    let target = core.target("target", "received");
    core.widget(
        "pick",
        rows(),
        "[act]\ntemplate = \"{title}\"\nsession = \"target\"\n",
    );
    core.grant("pick", Level::Act);
    assert_eq!(
        core.act("pick", &target.id, 0, 1).unwrap_err(),
        widgets::OFF
    );
    assert!(core.session(&target.id).send_log.is_empty());
}

#[test]
fn widgets_act_hangul_emoji_byte_exact() {
    let core = Core::on("bytes");
    let (target, ran) = core.pick(
        Level::Act,
        serde_json::json!([{"title": "한글 조합 ㄱㅏ 👩‍👩‍👧 é", "n": -3}]),
    );
    core.act("pick", &target.id, 0, ran).unwrap();
    let want = "look at 한글 조합 ㄱㅏ 👩‍👩‍👧 é #-3".as_bytes();
    assert!(
        wait(|| core.bytes("received") == want, 5),
        "{:?}",
        core.bytes("received")
    );
}

#[test]
fn widgets_act_sender_validation() {
    let row = |sender: &str| delivery::Send {
        id: "a1".into(),
        sender: sender.into(),
        at: 1,
        completion_seq: 0,
        last_activity: 0,
        content: "x".into(),
        keys: vec![],
        submit: false,
        status: "delivered".into(),
        settle: None,
        remote: None,
    };
    delivery::validate(&[row("widget:pick-2")]).unwrap();
    delivery::validate(&[row("user")]).unwrap();
    for bad in [
        "widget:",
        "widget:Pick",
        "widget:../x",
        "widget:-a",
        "widget:a b",
        "widgets:a",
    ] {
        assert!(delivery::validate(&[row(bad)]).is_err(), "{bad}");
    }
}

#[test]
fn widgets_act_invisible_or_bidi_value_refused() {
    let core = Core::on("bidi");
    let (target, ran) = core.pick(
        Level::Act,
        serde_json::json!([
            {"title": "fix \u{202e}cod.exe", "n": 1},
            {"title": "/mo\u{200b}del", "n": 2},
            {"title": "a\u{2066}b\u{2069}", "n": 3},
            {"title": "리뷰 ❤️ 👩‍👩‍👧", "n": 4}
        ]),
    );
    for (row, code) in [(0, "U+202E"), (1, "U+200B"), (2, "U+2066")] {
        let e = core.act("pick", &target.id, row, ran).unwrap_err();
        assert!(e.contains("invisible") && e.contains(code), "{row}: {e}");
    }
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("received").is_empty());
    assert!(core.session(&target.id).send_log.is_empty());
    // Hangul, an emoji with its presentation selector and a ZWJ family still go through byte-exact.
    core.act("pick", &target.id, 3, ran).unwrap();
    let want = "look at 리뷰 ❤️ 👩‍👩‍👧 #4".as_bytes();
    assert!(
        wait(|| core.bytes("received") == want, 5),
        "{:?}",
        core.bytes("received")
    );
}

#[test]
fn widgets_act_shell_target_refused() {
    let core = Core::on("shell");
    let shell = core.start(
        AgentKind::Shell,
        "target",
        &core.project,
        &["/bin/sh", "-c", "stty raw -echo; exec /bin/cat > shell.bin"],
    );
    assert!(wait(|| core.project.join("shell.bin").exists(), 5));
    core.widget(
        "pick",
        serde_json::json!([{"t": "$(touch pwned)"}]),
        "[act]\ntemplate = \"{t}\\n\"\nsession = \"target\"\n",
    );
    core.grant("pick", Level::Act);
    let ran = core.run("pick", &shell.id).ran_at_ms;
    let e = core.act("pick", &shell.id, 0, ran).unwrap_err();
    assert!(e.contains("shell") && e.contains("Claude or Codex"), "{e}");
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("shell.bin").is_empty());
    assert!(core.session(&shell.id).send_log.is_empty());
    assert!(!core.project.join("pwned").exists());
}

#[test]
fn widgets_act_grant_rechecked_right_before_the_send() {
    let core = Core::on("recheck");
    let place = core.target("place", "received");
    core.widget(
        "late",
        serde_json::json!([{"t": "hello"}]),
        "[act]\ntemplate = \"{t}\"\nstart = \"codex\"\n",
    );
    core.grant("late", Level::Act);
    let ran = core.run("late", &place.id).ran_at_ms;
    // `codex --version` runs inside launch preparation, after the act's approval check: it edits the widget there.
    let script = core.home.join("widgets/late/w.sh");
    fs::write(
        bin().join("revoke"),
        format!(
            "open({:?}, 'a').write('# revoked\\n')\n",
            script.to_str().unwrap()
        ),
    )
    .unwrap();
    let e = core.act("late", &place.id, 0, ran).unwrap_err();
    assert!(
        fs::read_to_string(&script).unwrap().contains("# revoked"),
        "revoke did not run"
    );
    assert!(e.contains("before the send"), "{e}");
    let Reply::Snapshot { sessions, .. } = core.owner(Request::Snapshot).unwrap() else {
        panic!()
    };
    let started = sessions
        .iter()
        .find(|s| s.label == "late")
        .expect("the start ran");
    assert!(started.send_log.is_empty() && started.send_queue.is_empty());
    // Q9 zh-hant-J12-1: the refused send closes the session it started, so no agent runs on without its prompt.
    assert_eq!(started.state, SessionState::Closed);
}

#[test]
fn widgets_act_format_characters_refused() {
    let core = Core::on("format");
    let values = [
        "\u{E0001}",
        "tag \u{E0049}\u{E0047}\u{E004E}",
        "\u{E0100}",
        "soft\u{AD}hyphen",
        "\u{FFF9}ann\u{FFFB}",
        "mongol\u{180E}",
        "cgj\u{34F}",
    ];
    let mut rows: Vec<serde_json::Value> = values
        .iter()
        .map(|v| serde_json::json!({"title": v, "n": 0}))
        .collect();
    rows.push(serde_json::json!({"title": "한글 ❤️ 👩‍👩‍👧 ✔︎", "n": 9}));
    let (target, ran) = core.pick(Level::Act, serde_json::Value::Array(rows));
    for (row, code) in [
        "U+E0001", "U+E0049", "U+E0100", "U+00AD", "U+FFF9", "U+180E", "U+034F",
    ]
    .iter()
    .enumerate()
    {
        let e = core.act("pick", &target.id, row, ran).unwrap_err();
        assert!(e.contains("invisible") && e.contains(code), "{row}: {e}");
    }
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("received").is_empty());
    assert!(core.session(&target.id).send_log.is_empty());
    // Hangul, ZWJ emoji and variation selectors (U+FE0F, U+FE0E) still go through byte-exact.
    core.act("pick", &target.id, values.len(), ran).unwrap();
    let want = "look at 한글 ❤️ 👩‍👩‍👧 ✔︎ #9".as_bytes();
    assert!(
        wait(|| core.bytes("received") == want, 5),
        "{:?}",
        core.bytes("received")
    );
}

/// Python for the fake's one-shot hook: rewrite `name`'s template and approve it again at act level over the socket.
fn regrant_hook(core: &Core, name: &str, template: &str) -> String {
    let toml = core.home.join("widgets").join(name).join("widget.toml");
    let text = fs::read_to_string(&toml).unwrap();
    let start = text.find("template = ").unwrap();
    let end = start + text[start..].find('\n').unwrap();
    let new = format!(
        "{}template = \"{template}\"{}",
        &text[..start],
        &text[end..]
    );
    format!(
        r#"import json, socket
open({toml:?}, 'w').write({new:?})
def call(req):
    s = socket.socket(socket.AF_UNIX)
    s.connect({sock:?})
    s.sendall((json.dumps({{'token': open({token:?}).read(), 'request': req}}) + '\n').encode())
    data = b''
    while not data.endswith(b'\n'):
        data += s.recv(65536)
    return json.loads(data)['Ok']['view']
view = call({{'op': 'approval_status', 'name': {name:?}}})
call({{'op': 'approval_grant', 'name': {name:?}, 'level': 'act', 'hash': view['hash']}})
"#,
        toml = toml.to_str().unwrap(),
        sock = core.home.join("core.sock").to_str().unwrap(),
        token = core.home.join("core.token").to_str().unwrap(),
    )
}

#[test]
fn widgets_act_reapproval_between_render_and_send_refused() {
    let core = Core::on("reapprove");
    let place = core.target("place", "received");
    core.widget(
        "swap",
        serde_json::json!([{"t": "old row"}]),
        "[act]\ntemplate = \"{t}\"\nstart = \"codex\"\n",
    );
    core.grant("swap", Level::Act);
    let ran = core.run("swap", &place.id).ran_at_ms;
    // During launch preparation the widget gets another template and is approved again at act level.
    fs::write(bin().join("revoke"), regrant_hook(&core, "swap", "NEW {t}")).unwrap();
    let e = core.act("swap", &place.id, 0, ran).unwrap_err();
    let v = approval::status(&core.home, "swap").unwrap();
    assert_eq!(v.state, approval::State::Approved, "the hook re-approved");
    assert_eq!(v.manifest.act.unwrap().template, "NEW {t}");
    assert_eq!(e, act::CHANGED);
    let Reply::Snapshot { sessions, .. } = core.owner(Request::Snapshot).unwrap() else {
        panic!()
    };
    let started = sessions
        .iter()
        .find(|s| s.label == "swap")
        .expect("the start ran");
    assert!(started.send_log.is_empty() && started.send_queue.is_empty());
    // Q9 zh-hant-J12-1: the refused send closes the session it started, so no agent runs on without its prompt.
    assert_eq!(started.state, SessionState::Closed);
}

#[test]
fn widgets_act_queued_reapproval_canceled() {
    let core = Core::on("queuedswap");
    let agent = core.start(
        AgentKind::Claude,
        "busy",
        &core.project,
        &["--fixture-busy"],
    );
    assert!(wait(|| core.session(&agent.id).attention.working, 10));
    core.widget(
        "swap",
        serde_json::json!([{"t": "old row"}]),
        "[act]\ntemplate = \"{t}\"\nsession = \"busy\"\n",
    );
    core.grant("swap", Level::Act);
    let ran = core.run("swap", &agent.id).ran_at_ms;
    let Reply::WidgetAct { send, .. } = core.act("swap", &agent.id, 0, ran).unwrap() else {
        panic!()
    };
    assert_eq!(send.status, "queued");
    // Approved again with another template while the act waits: the waiting text is the old approval's, so it goes.
    let toml = core.home.join("widgets/swap/widget.toml");
    let text = fs::read_to_string(&toml)
        .unwrap()
        .replace("template = \"{t}\"", "template = \"NEW {t}\"");
    fs::write(&toml, text).unwrap();
    core.grant("swap", Level::Act);
    core.owner(Request::SendText {
        id: agent.id.clone(),
        text: "FINISH\r".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    assert!(wait(
        || core
            .session(&agent.id)
            .send_log
            .iter()
            .any(|s| s.id == send.id && s.status == "canceled"),
        10
    ));
}

// v1b-21: blank-looking fillers are refused; joiners and variation selectors are capped at one per visible character.
#[test]
fn widgets_act_blank_fillers_and_joiner_runs_refused() {
    for c in [
        '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{2800}', '\u{17B4}', '\u{17B5}',
    ] {
        let e = act::check_visible(&format!("look{c}")).unwrap_err();
        assert!(e.contains(&format!("U+{:04X}", c as u32)), "{e}");
    }
    for text in [
        "a\u{200D}\u{200D}",
        "a\u{200C}\u{200C}\u{200C}",
        "\u{FE0F}",
        "ok \u{FE0F}\u{FE0F}\u{FE0F}",
        // v1b-21 r2: a run follows a visible character: one selector, then at most one joiner.
        &format!("Deploy now{}", "\u{FE0F}".repeat(9)),
        "a\u{FE0F}\u{FE0F}",
        "a \u{200D}b",
        "a\u{200D}\u{FE0F}",
    ] {
        assert!(
            act::check_visible(text).unwrap_err().contains("joiner"),
            "{text:?}"
        );
    }
    for text in ["한글 ❤️ 👩‍👩‍👧 ✔︎", "❤️‍🔥", "👨‍👩‍👧‍👦", "🏳️‍🌈", "시작\u{200C}끝", "plain"]
    {
        act::check_visible(text).unwrap();
    }
}

// v1b-21: a number is sent only when the table prints it the same way (JSON.stringify).
#[test]
fn widgets_act_numbers_the_table_prints_differently_refused() {
    let row: serde_json::Value =
        serde_json::from_str(r#"{"i": 42, "neg": -7, "f": 1.5, "one": 1.0, "e": 1e21, "big": 12345678901234567890, "safe": 9007199254740991}"#).unwrap();
    assert_eq!(
        act::render("{i} {neg} {f} {safe}", &row).unwrap(),
        "42 -7 1.5 9007199254740991"
    );
    for f in ["one", "e", "big"] {
        assert!(
            act::render(&format!("{{{f}}}"), &row)
                .unwrap_err()
                .contains("table shows"),
            "{f}"
        );
    }
}

// v1b-21: the table shows at most 64 columns and 500 rows (web/src/widgets/output.ts); an act never sends from a
// table that hides a column, nor from a row past the cap.
#[test]
fn widgets_act_hidden_columns_and_rows_refused() {
    let output = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/widgets/output.ts"),
    )
    .unwrap();
    assert!(output.contains(&format!("MAX_ROWS = {};", act::TABLE_ROWS)));
    assert!(output.contains(&format!("MAX_COLUMNS = {};", act::TABLE_COLUMNS)));
    let core = Core::on("hidden");
    let mut wide = serde_json::Map::new();
    wide.insert("title".into(), "seen".into());
    wide.insert("n".into(), 1.into());
    for i in 0..act::TABLE_COLUMNS - 1 {
        wide.insert(format!("c{i:02}"), "x".into());
    }
    let mut rows = vec![serde_json::Value::Object(wide)];
    rows.extend((0..act::TABLE_ROWS).map(|i| serde_json::json!({"title": "row", "n": i})));
    // Without the wide row the same rows act, except the one past the row cap.
    act::check_shown(&rows[1..], 0).unwrap();
    act::check_shown(&rows[1..], act::TABLE_ROWS - 1).unwrap();
    assert!(
        act::check_shown(&rows[1..], act::TABLE_ROWS)
            .unwrap_err()
            .contains("hides")
    );
    let (target, ran) = core.pick(Level::Act, serde_json::Value::Array(rows));
    for row in [0, 1] {
        let e = core.act("pick", &target.id, row, ran).unwrap_err();
        assert!(e.contains("hides"), "{row}: {e}");
    }
    thread::sleep(Duration::from_millis(300));
    assert!(core.bytes("received").is_empty());
}

// v1b-21: `start` acts stop at START_LIMIT running sessions of the widget in the project.
#[test]
fn widgets_act_start_sessions_capped() {
    let core = Core::on("startcap");
    let place = core.target("place", "received");
    let rows: Vec<_> = (0..=act::START_LIMIT)
        .map(|i| serde_json::json!({"t": format!("job {i}")}))
        .collect();
    core.widget(
        "starter",
        serde_json::Value::Array(rows),
        "[act]\ntemplate = \"{t}\"\nstart = \"codex\"\n",
    );
    core.grant("starter", Level::Act);
    let ran = core.run("starter", &place.id).ran_at_ms;
    for row in 0..act::START_LIMIT {
        core.act("starter", &place.id, row, ran).unwrap();
    }
    let e = core
        .act("starter", &place.id, act::START_LIMIT, ran)
        .unwrap_err();
    assert!(e.contains("running sessions"), "{e}");
    let Reply::Snapshot { sessions, .. } = core.owner(Request::Snapshot).unwrap() else {
        panic!()
    };
    assert_eq!(
        sessions.iter().filter(|s| s.label == "starter").count(),
        act::START_LIMIT
    );
}

// v1b-21 r3 (ruling: allowlist): a character passes only if it is a letter, mark, number, punctuation, symbol or
// space separator and not Default_Ignorable, or newline/tab; U+200C/U+200D/U+FE0E/U+FE0F only after a visible one.
#[test]
fn widgets_act_allowlist_refuses_every_other_class() {
    for c in [
        '\u{1B}',
        '\u{7F}',
        '\u{85}', // Cc
        '\u{AD}',
        '\u{600}',
        '\u{200B}',
        '\u{2066}',
        '\u{FEFF}',
        '\u{110BD}', // Cf
        '\u{E000}',
        '\u{F0000}',
        '\u{10FFFD}', // Co
        '\u{378}',
        '\u{0FFFF}',
        '\u{2FFFE}', // Cn
        '\u{2028}',
        '\u{2029}', // Zl, Zp
        '\u{E0000}',
        '\u{E0001}',
        '\u{E0002}',
        '\u{E001F}',
        '\u{E0020}',
        '\u{E007F}',
        '\u{E0080}',
        '\u{E00FF}',
        '\u{E0100}',
        '\u{E01EF}',
        '\u{E01F0}',
        '\u{E0FFF}',
        '\u{FFF0}',
        '\u{FFF8}', // Default_Ignorable ranges
        '\u{FE00}',
        '\u{FE0D}',
        '\u{180B}',
        '\u{180F}',
        '\u{034F}', // other variation selectors, CGJ
        '\u{115F}',
        '\u{1160}',
        '\u{3164}',
        '\u{FFA0}',
        '\u{17B4}',
        '\u{17B5}',
        '\u{2800}', // blank-looking
    ] {
        for text in [
            format!("look{c}"),
            format!("{c}look"),
            format!("a{c}{c}{c}b"),
        ] {
            let e = act::check_visible(&text).unwrap_err();
            assert!(e.contains(&format!("U+{:04X}", c as u32)), "{text:?}: {e}");
        }
    }
    for text in [
        "한글 안녕하세요",
        "漢字かなカナ",
        "👨‍👩‍👧‍👦 family",
        "1️⃣ #️⃣ keycaps",
        "🇰🇷🇯🇵 flags",
        "🏳️‍🌈 ❤️‍🔥 👁️‍🗨️",
        "café e\u{301} Ångström ñ",
        "tab\tand\nnewline",
        "✔\u{FE0E} 시작\u{200C}끝",
        "non\u{A0}breaking \u{3000}ideographic space",
    ] {
        act::check_visible(text).unwrap_or_else(|e| panic!("{text:?}: {e}"));
    }
}

// v1b-31 (S3): a character carries at most 4 combining marks, and the blank-drawing U+16FE4 and U+1D159 are refused
// beside U+2800; emoji, keycaps and flags still pass.
#[test]
fn act_text_refuses_mark_stacks_and_blank_drawing_characters() {
    let marks = "\u{036C}\u{0364}\u{036B}\u{0369}\u{0363}";
    for text in [
        format!("ok a{marks}"),
        format!("a{}\u{200D}{}", &marks[..4], &marks[..6]),
        marks.to_string(),
    ] {
        assert!(
            act::check_visible(&text).unwrap_err().contains("marks"),
            "{text:?}"
        );
    }
    // The sheet refuses the template too, not only the send.
    assert!(act::fields(&format!("look a{marks}")).is_err());
    act::fields(&format!("look a{}", &marks[..8])).unwrap();
    for c in ['\u{16FE4}', '\u{1D159}', '\u{2800}'] {
        let e = act::check_visible(&format!("look{c}")).unwrap_err();
        assert!(e.contains(&format!("U+{:04X}", c as u32)), "{e}");
    }
    for text in [
        format!("ok a{}", &marks[..8]),
        // A space starts a new base: 4 marks on each side.
        format!("a{} {}", &marks[..8], &marks[2..10]),
        "1️⃣ #️⃣ 🇰🇷 🏳️‍🌈 👩‍👩‍👧 한글 Tiếng Việt".to_string(),
    ] {
        act::check_visible(&text).unwrap_or_else(|e| panic!("{text:?}: {e}"));
    }
}

// V2.5-35 hidden-chars: act text refuses every character the shared board set (`board::rights::hidden`) refuses,
// sampled at each range's ends and middle, so the two cannot drift. Alone, each is refused; between two letters,
// each is refused except ZWNJ and ZWJ, which act keeps after a visible character for Hangul and emoji (v1b-21 r2).
#[test]
fn act_refuses_shared_hidden_set() {
    let samples = [
        '\u{061C}',
        '\u{200B}',
        '\u{200D}',
        '\u{200F}',
        '\u{2028}',
        '\u{202B}',
        '\u{202E}',
        '\u{2060}',
        '\u{2067}',
        '\u{206F}',
        '\u{FEFF}',
        '\u{E0000}',
        '\u{E0041}',
        '\u{E007F}',
    ];
    for c in samples {
        assert!(
            nunchiro_core::board::rights::hidden(c),
            "{c:?} not in the shared set"
        );
        assert!(act::check_visible(&c.to_string()).is_err(), "{c:?} alone");
        if !matches!(c, '\u{200C}' | '\u{200D}') {
            assert!(
                act::check_visible(&format!("a{c}b")).is_err(),
                "{c:?} between letters"
            );
        }
    }
}
