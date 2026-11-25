//! The Nunchiro skill reaches Claude sessions through `--plugin-dir` and touches no user config.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    user: PathBuf,
    process: Child,
}
impl Core {
    fn new(tag: &str) -> Self {
        Self::with_plugin(tag, None)
    }
    fn with_plugin(tag: &str, existing: Option<&str>) -> Self {
        let home = home::short(&format!("skill-{tag}"));
        fs::create_dir_all(home.join("user/.claude")).unwrap();
        let user = home.join("user");
        fs::write(user.join(".claude/settings.json"), "{}\n").unwrap();
        fs::write(user.join(".claude.json"), "{\"projects\":{}}\n").unwrap();
        if let Some(json) = existing {
            fs::create_dir_all(home.join("plugin/.claude-plugin")).unwrap();
            fs::write(home.join("plugin/.claude-plugin/plugin.json"), json).unwrap();
        }
        for (name, version) in [
            ("claude", "2.1.310 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version}'; exit; fi\nprintf '%s\\n' \"$@\" > argv-{name}.txt\nsleep 30\n"
            );
            fs::write(home.join(name), home::codex_fake(&script)).unwrap();
            fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &user)
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            user,
            process,
        };
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
    fn start(&self, kind: AgentKind) -> String {
        let Reply::Started { .. } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.clone(),
                    worktree: false,
                    label: "w".into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!("not started")
        };
        let name = if kind == AgentKind::Claude {
            "claude"
        } else {
            "codex"
        };
        let argv = self.home.join(format!("argv-{name}.txt"));
        let until = Instant::now() + Duration::from_secs(5);
        while !argv.exists() {
            assert!(
                Instant::now() < until,
                "fixture did not record its arguments"
            );
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(50));
        fs::read_to_string(argv).unwrap()
    }
    fn user_bytes(&self) -> Vec<Vec<u8>> {
        [".claude/settings.json", ".claude.json"]
            .iter()
            .map(|f| fs::read(self.user.join(f)).unwrap())
            .collect()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(
            self.home
                .parent()
                .unwrap()
                .join(self.home.file_name().unwrap()),
        );
    }
}
fn repo_skill() -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugin/skills/nunchiro/SKILL.md"),
    )
    .unwrap()
}

#[test]
fn claude_session_gets_plugin_dir_and_user_config_is_byte_identical() {
    let core = Core::new("claude");
    let before = core.user_bytes();
    let argv = core.start(AgentKind::Claude);
    let dir = core.home.join("plugin");
    assert!(argv.lines().any(|l| l == "--plugin-dir"), "{argv}");
    assert!(argv.lines().any(|l| Path::new(l) == dir), "{argv}");
    assert_eq!(
        fs::read_to_string(dir.join("skills/nunchiro/SKILL.md")).unwrap(),
        repo_skill()
    );
    assert!(dir.join(".claude-plugin/plugin.json").exists());
    assert_eq!(core.user_bytes(), before);
    assert!(
        !core.user.join(".claude/plugins").exists() && !core.user.join(".claude/skills").exists()
    );
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for sub in ["skills", "skills/nunchiro", ".claude-plugin"] {
        assert_eq!(
            fs::metadata(dir.join(sub)).unwrap().permissions().mode() & 0o777,
            0o700,
            "{sub}"
        );
    }
    assert_eq!(
        fs::metadata(dir.join("skills/nunchiro/SKILL.md"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn codex_session_gets_no_plugin_dir() {
    let core = Core::new("codex");
    assert!(!core.start(AgentKind::Codex).contains("--plugin-dir"));
}

#[test]
fn newer_plugin_version_is_left_untouched() {
    let newer = "{\"name\":\"nunchiro\",\"version\":\"999\"}";
    let core = Core::with_plugin("newer", Some(newer));
    core.start(AgentKind::Claude);
    assert_eq!(
        fs::read_to_string(core.home.join("plugin/.claude-plugin/plugin.json")).unwrap(),
        newer
    );
}

#[test]
fn invalid_plugin_json_is_left_untouched() {
    let junk = "not json";
    let core = Core::with_plugin("junk", Some(junk));
    core.start(AgentKind::Claude);
    assert_eq!(
        fs::read_to_string(core.home.join("plugin/.claude-plugin/plugin.json")).unwrap(),
        junk
    );
}
