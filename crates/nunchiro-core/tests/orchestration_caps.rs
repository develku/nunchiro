//! V2.5-31 (needs 145): Settings > Orchestration. The core sets no worker or depth limit (owner F5); the skill reaches
//! Claude through the plugin folder and Codex through one constant `-c` line, never through agent config; with the
//! setting off neither is passed.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const SHELL: &str = "env > \"$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION\" && mv \"$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION\" \"$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION\"; exec sleep 60";

struct Core {
    home: PathBuf,
    user: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    fn new(tag: &str) -> Self {
        let home = home::short(&format!("orch-{tag}"));
        let user = home.join("user");
        fs::create_dir_all(&user).unwrap();
        for (name, version) in [
            ("claude", "2.1.310 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version}'; exit; fi\nprintf '%s\\n' \"$@\" > \"$NUNCHIRO_HOME/argv-$NUNCHIRO_SESSION\"\nsleep 30\n"
            );
            fs::write(home.join(name), home::codex_fake(&script)).unwrap();
            fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = format!("{}:/usr/bin:/bin", home.display());
        let serve = home::spawn_serve(&home, &[("PATH", &path), ("HOME", user.to_str().unwrap())]);
        Self {
            home,
            user,
            _serve: serve,
        }
    }
    fn session(kind: AgentKind, project: &Path, label: &str, args: Vec<String>) -> StartSession {
        StartSession {
            account: None,
            kind,
            project: project.into(),
            worktree: false,
            label: label.into(),
            args,
            model: None,
            effort: None,
            resume: None,
        }
    }
    fn owner_start(&self, kind: AgentKind, label: &str) -> String {
        let args = if kind == AgentKind::Shell {
            vec!["/bin/sh".into(), "-c".into(), SHELL.into()]
        } else {
            vec![]
        };
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: Self::session(kind, &self.home, label, args),
            },
        ) {
            Ok(Reply::Started { session }) => session.id,
            other => panic!("{other:?}"),
        }
    }
    /// The recorded file `<prefix>-<id>`, once the fake agent wrote it.
    fn wait_file(&self, prefix: &str, id: &str) -> String {
        let path = self.home.join(format!("{prefix}-{id}"));
        let until = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(Instant::now() < until, "{id} never wrote {prefix}");
            thread::sleep(Duration::from_millis(20));
        }
        fs::read_to_string(path).unwrap()
    }
    fn token(&self, id: &str) -> String {
        let env: BTreeMap<String, String> = self
            .wait_file("env", id)
            .lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        env["NUNCHIRO_TOKEN"].clone()
    }
    /// One request with a session's token, as that session's agent sends it.
    fn as_session(&self, id: &str, request: Request) -> Response {
        let mut stream = UnixStream::connect(self.home.join("core.sock")).unwrap();
        let mut line = serde_json::to_vec(&Envelope {
            token: self.token(id),
            request,
        })
        .unwrap();
        line.push(b'\n');
        stream.write_all(&line).unwrap();
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply).unwrap();
        serde_json::from_str(&reply).unwrap()
    }
    /// A shell worker started by session `caller`.
    fn worker_start(&self, caller: &str, label: &str) -> Result<String, String> {
        let session = Self::session(
            AgentKind::Shell,
            &self.home,
            label,
            vec!["/bin/sh".into(), "-c".into(), SHELL.into()],
        );
        match self.as_session(
            caller,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session,
            },
        ) {
            Ok(Reply::Started { session }) => Ok(session.id),
            Ok(other) => panic!("{other:?}"),
            Err(e) => Err(e),
        }
    }
    fn set(&self, patch: OrchestrationPatch) -> OrchestrationSettings {
        match call(
            &self.home,
            Request::QuitSettings {
                patch: LifetimePatch {
                    orchestration: Some(patch),
                    ..Default::default()
                },
            },
        ) {
            Ok(Reply::QuitSettings { settings }) => settings.orchestration,
            other => panic!("{other:?}"),
        }
    }
    /// Every path under `dir`, with its bytes for files.
    fn tree(dir: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        let mut out = BTreeMap::new();
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.insert(path.clone(), None);
                out.extend(Self::tree(&path));
            } else {
                out.insert(path.clone(), fs::read(&path).ok());
            }
        }
        out
    }
}

#[test]
fn no_worker_or_depth_limit() {
    let core = Core::new("none");
    assert!(core.set(OrchestrationPatch::default()).enabled);
    let lead = core.owner_start(AgentKind::Shell, "lead");
    for n in 0..10 {
        core.worker_start(&lead, &format!("w{n}")).unwrap();
    }
    let mut at = lead;
    for level in 0..4 {
        at = core.worker_start(&at, &format!("level{level}")).unwrap();
    }
}

#[test]
fn old_settings_keys_still_load() {
    let old: OrchestrationSettings = serde_json::from_str(
        r#"{"enabled":false,"level":"strict","max_workers":3,"max_depth":2,"merge":"auto","auto_close_finished":false}"#,
    )
    .unwrap();
    assert!(!old.enabled);
}

#[test]
fn session_cannot_write_orchestration_settings() {
    let core = Core::new("owner");
    let lead = core.owner_start(AgentKind::Shell, "lead");
    for patch in [
        OrchestrationPatch {
            enabled: Some(false),
            ..Default::default()
        },
        OrchestrationPatch {
            create_override: Some(true),
            ..Default::default()
        },
    ] {
        let reply = core.as_session(
            &lead,
            Request::QuitSettings {
                patch: LifetimePatch {
                    orchestration: Some(patch),
                    ..Default::default()
                },
            },
        );
        assert!(reply.is_err(), "{reply:?}");
    }
    assert!(core.set(OrchestrationPatch::default()).enabled);
    assert!(!core.home.join("skills/orchestration").exists());
}

#[test]
fn create_override_makes_an_empty_folder_and_keeps_files() {
    let core = Core::new("mkdir");
    let dir = core.home.join("skills/orchestration");
    assert!(!dir.exists(), "reading settings must not create it");
    let patch = OrchestrationPatch {
        create_override: Some(true),
        ..Default::default()
    };
    core.set(patch);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    fs::write(dir.join("guide.md"), "mine\n").unwrap();
    core.set(patch);
    assert_eq!(fs::read_to_string(dir.join("guide.md")).unwrap(), "mine\n");
}

const STUB: &str = "plugin/skills/orchestration/SKILL.md";
fn instruction(argv: &str) -> Option<&str> {
    let lines: Vec<&str> = argv.lines().collect();
    lines
        .windows(2)
        .find(|w| w[0] == "-c" && w[1].starts_with("developer_instructions="))
        .map(|w| w[1])
}

#[test]
fn launch_writes_no_agent_config() {
    let core = Core::new("cfg");
    let before = Core::tree(&core.user);
    let claude = core.owner_start(AgentKind::Claude, "c");
    let codex = core.owner_start(AgentKind::Codex, "x");
    core.wait_file("argv", &claude);
    core.wait_file("argv", &codex);
    assert_eq!(Core::tree(&core.user), before);
    assert!(!core.user.join(".claude").exists() && !core.user.join(".codex").exists());
    assert!(core.home.join(STUB).exists());
}

#[test]
fn codex_instruction_constant() {
    let core = Core::new("codexline");
    let a = core.owner_start(AgentKind::Codex, "first");
    let b = core.owner_start(AgentKind::Codex, "second \" ; rm -rf $HOME");
    let (a, b) = (core.wait_file("argv", &a), core.wait_file("argv", &b));
    let line = instruction(&a).expect("Codex gets the instruction line");
    assert_eq!(Some(line), instruction(&b), "same line whatever the label");
    assert!(line.contains("nunchiro skill get orchestration"), "{line}");
    assert!(!line.contains("first") && !line.contains(&*core.home.to_string_lossy()));
}

#[test]
fn disabled_not_passed() {
    let core = Core::new("off");
    let on = core.owner_start(AgentKind::Claude, "on");
    core.wait_file("argv", &on);
    assert!(core.home.join(STUB).exists());
    assert!(
        !core
            .set(OrchestrationPatch {
                enabled: Some(false),
                ..Default::default()
            })
            .enabled
    );
    let claude = core.owner_start(AgentKind::Claude, "c");
    let codex = core.owner_start(AgentKind::Codex, "x");
    let argv = core.wait_file("argv", &claude);
    assert!(argv.lines().any(|l| l == "--plugin-dir"), "{argv}");
    assert!(!core.home.join(STUB).exists());
    assert!(core.home.join("plugin/skills/nunchiro/SKILL.md").exists());
    assert_eq!(instruction(&core.wait_file("argv", &codex)), None);
}

#[test]
fn update_keeps_user_override() {
    let core = Core::new("keep");
    let mine = core.home.join("skills/orchestration");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("guide.md"), "my guide\n").unwrap();
    fs::write(mine.join("brief-template.md"), "my brief\n").unwrap();
    let before = Core::tree(&mine);
    let id = core.owner_start(AgentKind::Claude, "c");
    core.wait_file("argv", &id);
    core.owner_start(AgentKind::Codex, "x");
    assert_eq!(Core::tree(&mine), before);
}

#[test]
fn disabled_removes_stub_from_newer_plugin_copy() {
    let core = Core::new("newer");
    let manifest = core.home.join("plugin/.claude-plugin/plugin.json");
    fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    fs::write(&manifest, "{\"version\":\"99\"}").unwrap();
    fs::create_dir_all(core.home.join(STUB).parent().unwrap()).unwrap();
    fs::write(core.home.join(STUB), "old stub").unwrap();
    core.set(OrchestrationPatch {
        enabled: Some(false),
        ..Default::default()
    });
    let id = core.owner_start(AgentKind::Claude, "c");
    core.wait_file("argv", &id);
    assert!(!core.home.join(STUB).exists());
    assert_eq!(
        fs::read_to_string(&manifest).unwrap(),
        "{\"version\":\"99\"}"
    );
}
