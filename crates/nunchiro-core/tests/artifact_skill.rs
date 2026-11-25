//! v1b-07: the artifact-authoring skill ships in the plugin, and Claude and Codex sessions start with their artifact
//! folder (`--add-dir`, `NUNCHIRO_ARTIFACTS`, and for Claude a session-only allow rule for exactly that folder).
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    api::*,
    chat::{Store, TESTED_VERSIONS, artifacts::Context},
    server::call,
};
use serde_json::{Value, json};
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
    runs: std::cell::Cell<usize>,
}
impl Core {
    fn new(tag: &str, settings: Option<&str>, plugin: Option<&str>) -> Self {
        let home = home::short(&format!("as-{tag}"));
        fs::create_dir_all(home.join("user/.claude")).unwrap();
        fs::create_dir_all(home.join("project")).unwrap();
        let user = home.join("user");
        fs::write(user.join(".claude/settings.json"), "{}\n").unwrap();
        // v1b-38: Codex 0.161.0 starts a folder without a trust entry read-only; trust the test project.
        fs::create_dir_all(user.join(".codex")).unwrap();
        fs::write(user.join(".codex/config.toml"), trusted(&home)).unwrap();
        if let Some(s) = settings {
            fs::write(home.join("settings.json"), s).unwrap();
        }
        if let Some(json) = plugin {
            fs::create_dir_all(home.join("plugin/.claude-plugin")).unwrap();
            fs::write(home.join("plugin/.claude-plugin/plugin.json"), json).unwrap();
        }
        // Each run records its argv and NUNCHIRO_ARTIFACTS in run-<n>.txt, then exits so it can be resumed.
        for (name, version) in [
            ("claude", "2.1.310 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version}'; exit; fi\nn=$(ls {home}/run-*.txt 2>/dev/null | wc -l | tr -d ' ')\n{{ printf 'ENV=%s\\n' \"${{NUNCHIRO_ARTIFACTS-unset}}\"; printf '%s\\n' \"$@\"; }} > {home}/tmp-$$ && mv {home}/tmp-$$ {home}/run-$n.txt\nsleep 1\n",
                home = home.display()
            );
            fs::write(home.join(name), script).unwrap();
            fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &user)
            .env("SHELL", "/bin/sh") // ticket 286: the shell an ended agent leaves
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            user,
            process,
            runs: 0.into(),
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
    /// Starts a session and returns (session, argv lines, NUNCHIRO_ARTIFACTS as the agent saw it).
    fn start(
        &self,
        kind: AgentKind,
        resume: Option<String>,
        args: &[&str],
    ) -> (Session, Vec<String>, String) {
        let Reply::Started { session } = call(
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
                    label: "w".into(),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume,
                },
            },
        )
        .unwrap() else {
            panic!("not started")
        };
        let n = self.runs.get();
        self.runs.set(n + 1);
        let path = self.home.join(format!("run-{n}.txt"));
        let until = Instant::now() + Duration::from_secs(30);
        while !path.exists() {
            assert!(Instant::now() < until, "fixture did not record its run");
            thread::sleep(Duration::from_millis(10));
        }
        let text = fs::read_to_string(path).unwrap();
        let mut lines = text.lines().map(str::to_string);
        let env = lines.next().unwrap().trim_start_matches("ENV=").to_string();
        (session, lines.collect(), env)
    }
    fn wait_exited(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let Ok(Reply::Snapshot { sessions, .. }) = call(&self.home, Request::Snapshot) else {
                panic!("no snapshot")
            };
            if sessions
                .iter()
                .any(|s| s.id == id && s.state != SessionState::Running)
            {
                return;
            }
            assert!(Instant::now() < until, "session did not exit");
            // Ticket 286: the agent's wrapper leaves a shell; quitting it ends the session.
            let _ = call(
                &self.home,
                Request::SendText {
                    id: id.into(),
                    text: "exit\r".into(),
                    composer: false,
                    seen: vec![],
                },
            );
            thread::sleep(Duration::from_millis(1500));
        }
    }
    fn folder(&self, id: &str) -> PathBuf {
        self.home.join("artifacts").join(id)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn trusted(home: &Path) -> String {
    format!(
        "[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
        home.join("project").display()
    )
}
fn value_after(argv: &[String], flag: &str) -> Vec<String> {
    argv.windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].clone())
        .collect()
}
fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}
fn claude_settings(argv: &[String]) -> Value {
    let paths = value_after(argv, "--settings");
    assert_eq!(paths.len(), 1, "{argv:?}");
    serde_json::from_slice(&fs::read(&paths[0]).unwrap()).unwrap()
}
/// The session's permission block. Deny: every file Claude Code loads configuration from inside an `--add-dir` folder
/// (code.claude.com/docs/en/permissions, "Additional directories grant file access, not configuration": `.claude/`
/// skills, commands, agents and settings; `CLAUDE.md`, `CLAUDE.local.md`), at any depth and in any letter case, since
/// macOS folders are case-insensitive.
fn permissions(folder: &Path) -> Value {
    let f = folder.display();
    let deny: Vec<String> = [
        "**/.claude/**",
        "**/.[cC][lL][aA][uU][dD][eE]/**",
        "**/CLAUDE.md",
        "**/[cC][lL][aA][uU][dD][eE].[mM][dD]",
        "**/CLAUDE.local.md",
        "**/[cC][lL][aA][uU][dD][eE].[lL][oO][cC][aA][lL].[mM][dD]",
    ]
    .iter()
    .map(|p| format!("Edit(/{f}/{p})"))
    .collect();
    json!({"allow": [format!("Edit(/{f}/**)")], "deny": deny})
}

/// A model of Claude Code's documented file-rule matching (permissions doc): only `Edit(path)` rules govern writes
/// (`Write(path)` rules never match, so none is written, ticket 287); gitignore globs; deny is checked first and matches the requested path or the
/// file it resolves to; allow needs both. Claude's own matcher (path normalization, case folding) is not modeled.
fn decide(perms: &Value, requested: &str, resolved: &str) -> &'static str {
    let rules = |key: &str| -> Vec<String> {
        perms[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                r.as_str()?
                    .strip_prefix("Edit(/")?
                    .strip_suffix(')')
                    .map(str::to_string)
            })
            .collect()
    };
    let hit = |key: &str, path: &str| rules(key).iter().any(|r| glob(r, path));
    if hit("deny", requested) || hit("deny", resolved) {
        "deny"
    } else if hit("allow", requested) && hit("allow", resolved) {
        "allow"
    } else {
        "ask"
    }
}
fn glob(pattern: &str, path: &str) -> bool {
    fn segs(p: &[&str], s: &[&str]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some(&"**"), _) => segs(&p[1..], s) || (!s.is_empty() && segs(p, &s[1..])),
            (Some(a), Some(b)) => seg(a.as_bytes(), b.as_bytes()) && segs(&p[1..], &s[1..]),
            _ => false,
        }
    }
    fn seg(p: &[u8], s: &[u8]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(b'*') => seg(&p[1..], s) || (!s.is_empty() && seg(p, &s[1..])),
            Some(b'[') => {
                let end = p.iter().position(|c| *c == b']').unwrap();
                !s.is_empty() && p[1..end].contains(&s[0]) && seg(&p[end + 1..], &s[1..])
            }
            Some(c) => s.first() == Some(c) && seg(&p[1..], &s[1..]),
        }
    }
    let split = |x: &str| {
        x.split('/')
            .filter(|c| !c.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let (p, s) = (split(pattern), split(path));
    segs(
        &p.iter().map(String::as_str).collect::<Vec<_>>(),
        &s.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

#[test]
fn artifact_skill_launch_adds_dir() {
    let core = Core::new("launch", None, None);
    for kind in [AgentKind::Claude, AgentKind::Codex] {
        let (s, argv, env) = core.start(kind, None, &[]);
        let folder = core.folder(&s.id);
        assert_eq!(
            value_after(&argv, "--add-dir"),
            [folder.display().to_string()],
            "{kind:?} {argv:?}"
        );
        assert_eq!(env, folder.display().to_string(), "{kind:?}");
        // Claude's `--add-dir` is variadic: a flag must end it, or a following prompt would be read as a folder.
        // v1b-38: Codex's takes one value (codex-cli 0.161.0 `--add-dir <DIR>`); its half passed only while no Codex
        // config made `--enable default_mode_request_user_input` follow.
        let at = argv.iter().position(|a| a == "--add-dir").unwrap();
        if kind == AgentKind::Claude {
            assert!(
                argv.get(at + 2).is_some_and(|a| a.starts_with("--")),
                "{argv:?}"
            );
        }
        assert_eq!(mode(&folder), 0o700);
        assert_eq!(mode(&core.home.join("artifacts")), 0o700);
    }
    // A resumed conversation, and a resume of that resume, keep the first run's folder.
    let (first, _, _) = core.start(AgentKind::Claude, None, &[]);
    let conversation = first.agent_session_id.clone().unwrap();
    core.wait_exited(&first.id);
    let (second, argv, env) = core.start(AgentKind::Claude, Some(conversation.clone()), &[]);
    assert_ne!(second.id, first.id);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&first.id).display().to_string()]
    );
    assert_eq!(env, core.folder(&first.id).display().to_string());
    assert!(!core.folder(&second.id).exists());
    core.wait_exited(&second.id);
    let (_, argv, _) = core.start(AgentKind::Claude, Some(conversation), &[]);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&first.id).display().to_string()]
    );
    assert_eq!(
        claude_settings(&argv)["permissions"],
        permissions(&core.folder(&first.id))
    );
    // Shell sessions get no folder and no variable.
    let record = format!(
        "printf 'ENV=%s\\n' \"${{NUNCHIRO_ARTIFACTS-unset}}\" > {h}/tmp-sh && mv {h}/tmp-sh {h}/run-{}.txt",
        core.runs.get(),
        h = core.home.display()
    );
    let (shell, argv, env) = core.start(AgentKind::Shell, None, &["/bin/sh", "-c", &record]);
    assert_eq!(env, "unset");
    assert!(argv.is_empty());
    assert!(!core.folder(&shell.id).exists());
}

#[test]
fn artifact_skill_permission_rule_is_scoped_to_the_session_folder() {
    let core = Core::new("scope", None, None);
    let user_before = fs::read(core.user.join(".claude/settings.json")).unwrap();
    let (a, argv, _) = core.start(AgentKind::Claude, None, &[]);
    let settings = claude_settings(&argv);
    // Exactly this session's folder: the project and other sessions' folders are not allowed, so they still prompt.
    assert_eq!(settings["permissions"], permissions(&core.folder(&a.id)));
    assert!(settings["hooks"].is_object(), "hooks still injected");
    let (b, argv, _) = core.start(AgentKind::Claude, None, &[]);
    assert_eq!(
        claude_settings(&argv)["permissions"],
        permissions(&core.folder(&b.id))
    );
    // Codex gets the writable root only; no rule anywhere in its argv.
    let (_, argv, _) = core.start(AgentKind::Codex, None, &[]);
    assert!(
        !argv
            .iter()
            .any(|a| a.contains("permissions") || a.contains("Write(")),
        "{argv:?}"
    );
    assert_eq!(
        fs::read(core.user.join(".claude/settings.json")).unwrap(),
        user_before
    );
}

#[test]
fn extensions_list_hooks_are_the_claude_launch_hooks() {
    let core = Core::new("hookview", None, None);
    let (_, argv, _) = core.start(AgentKind::Claude, None, &[]);
    let mut launched = claude_settings(&argv)["hooks"].clone();
    // Ticket 1130 S1: the outward hook is the session's own guard, not one of the listed hooks; it comes last.
    let outward = launched["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        outward["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with(" hook outward")
    );
    let Reply::Extensions { hooks, .. } = call(&core.home, Request::ExtensionsList).unwrap() else {
        panic!("wrong reply")
    };
    assert_eq!(hooks.len(), 9);
    let shown: serde_json::Map<String, Value> = hooks
        .into_iter()
        .map(|h| {
            // Ticket 991 B3: Claude's permission hook waits for the card's answer.
            let handler = if h.event == "PermissionRequest" {
                json!({"type": "command", "command": format!("{} --hold", h.command), "timeout": nunchiro_core::queue::HOLD_MS / 1000 + 10})
            } else {
                json!({"type": "command", "command": h.command, "timeout": 2})
            };
            let block = if h.matcher.is_empty() {
                json!([{"hooks": [handler]}])
            } else {
                json!([{"matcher": h.matcher, "hooks": [handler]}])
            };
            (h.event, block)
        })
        .collect();
    assert_eq!(Value::Object(shown), launched);
}

#[test]
fn artifact_skill_hook_injection_off_keeps_folder_and_rule() {
    let core = Core::new("nohooks", Some(r#"{"disable_hook_injection":true}"#), None);
    let (s, argv, env) = core.start(AgentKind::Claude, None, &[]);
    let folder = core.folder(&s.id);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [folder.display().to_string()]
    );
    assert_eq!(env, folder.display().to_string());
    // Ticket 1130 S1: the outward hook stays with Nunchiro's hooks off, and no other layer may turn it off.
    let mut settings = claude_settings(&argv);
    let outward = settings["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        outward["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with(" hook outward")
    );
    assert_eq!(
        settings,
        json!({"permissions": permissions(&folder), "disableAllHooks": false, "hooks": {"PreToolUse": []}})
    );
    let (s, argv, _) = core.start(AgentKind::Codex, None, &[]);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&s.id).display().to_string()]
    );
    // Ticket 1149: only the outward hook and its trust, as for Claude above.
    let hooks: Vec<&String> = argv.iter().filter(|a| a.starts_with("hooks.")).collect();
    assert!(
        hooks.len() == 2
            && hooks[0].contains("hook outward --codex")
            && hooks[1].starts_with("hooks.state="),
        "{argv:?}"
    );
}

#[test]
fn artifact_skill_plugin_install_adds_the_skill_file() {
    let repo = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugin/skills/artifacts/SKILL.md"),
    )
    .unwrap();
    // An installed version-1 plugin from before this ticket gains the file.
    let core = Core::new(
        "install",
        None,
        Some(r#"{"name":"nunchiro","version":"1"}"#),
    );
    core.start(AgentKind::Claude, None, &[]);
    let file = core.home.join("plugin/skills/artifacts/SKILL.md");
    assert_eq!(fs::read_to_string(&file).unwrap(), repo);
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
    assert!(core.home.join("plugin/skills/nunchiro/SKILL.md").exists());
    for (tag, json) in [
        ("newer", r#"{"name":"nunchiro","version":"999"}"#),
        ("junk", "not json"),
    ] {
        let core = Core::new(tag, None, Some(json));
        core.start(AgentKind::Claude, None, &[]);
        assert!(!core.home.join("plugin/skills/artifacts").exists(), "{tag}");
        assert_eq!(
            fs::read_to_string(core.home.join("plugin/.claude-plugin/plugin.json")).unwrap(),
            json
        );
    }
}

#[test]
fn artifact_skill_written_file_maps_to_data_root() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("artskill-detect-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let home = base.join("home");
    fs::create_dir_all(base.join("project")).unwrap();
    fs::create_dir_all(home.join("artifacts/s1")).unwrap();
    let base = base.canonicalize().unwrap();
    let (project, mine, other) = (
        base.join("project"),
        base.join("home/artifacts/s1"),
        base.join("home/artifacts/s2"),
    );
    let page = "<html><head><title>Chart</title></head></html>";
    let n = std::cell::Cell::new(0);
    let uuid = || {
        n.set(n.get() + 1);
        format!("00000000-0000-4000-8000-{:012}", n.get())
    };
    let write = |id: &str, path: String| {
        [
            json!({"type":"assistant","uuid":uuid(),"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Write","input":{"file_path":path,"content":page}}]}}),
            json!({"type":"user","uuid":uuid(),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"File created","is_error":false}]}}),
        ]
    };
    let lines: Vec<String> = [
        write("w1", mine.join("chart.html").display().to_string()),
        write("w2", other.join("x.html").display().to_string()),
        write("w3", format!("{}/../s2/y.html", mine.display())),
        write("w4", project.join("site.html").display().to_string()),
    ]
    .into_iter()
    .flatten()
    .map(|v| v.to_string())
    .collect();
    let transcript = base.join("t.jsonl");
    fs::write(&transcript, lines.join("\n") + "\n").unwrap();
    let mut store = Store::open(&home, "s1").unwrap();
    let ctx = Context {
        session: "s1",
        folder: &project,
        artifacts: &mine,
    };
    store
        .refresh_with(AgentKind::Claude, &transcript, Some(&ctx))
        .unwrap();
    let found: Vec<Value> = store
        .page(
            AgentKind::Claude,
            Some(
                TESTED_VERSIONS
                    .iter()
                    .find(|v| v.0 == AgentKind::Claude)
                    .unwrap()
                    .1,
            ),
            TESTED_VERSIONS,
            None,
        )
        .unwrap()
        .events
        .into_iter()
        .map(|e| e.data)
        .filter(|e| e["kind"] == "artifact")
        .collect();
    let by = |id: &str| found.iter().find(|e| e["tool_id"] == id).unwrap().clone();
    assert_eq!(
        (by("w1")["root"].as_str(), by("w1")["path"].as_str()),
        (Some("data"), Some("artifacts/s1/chart.html"))
    );
    for id in ["w2", "w3"] {
        assert_ne!(by(id)["root"], "data", "{id}: {:?}", by(id));
    }
    assert_eq!(
        (by("w4")["root"].as_str(), by("w4")["path"].as_str()),
        (Some("s1"), Some("site.html"))
    );
    let _ = fs::remove_dir_all(&base);
}

// v1b-07 round 2
#[test]
fn artifact_skill_folder_with_planted_claude_config_gets_no_allow_rule() {
    let core = Core::new("planted", None, None);
    let (first, _, _) = core.start(AgentKind::Claude, None, &[]);
    let conversation = first.agent_session_id.clone().unwrap();
    core.wait_exited(&first.id);
    let folder = core.folder(&first.id);
    // Any letter case: the macOS folder `.Claude` is the `.claude` Claude Code loads skills from.
    fs::create_dir_all(folder.join(".Claude/skills/x")).unwrap();
    let (run, argv, _) = core.start(AgentKind::Claude, Some(conversation.clone()), &[]);
    let settings = claude_settings(&argv);
    assert!(settings["permissions"].get("allow").is_none(), "{settings}");
    assert_eq!(
        settings["permissions"]["deny"],
        permissions(&folder)["deny"]
    );
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [folder.display().to_string()]
    );
    let mut last = run.id;
    fs::remove_dir_all(folder.join(".Claude")).unwrap();
    for planted in ["CLAUDE.md", "claude.local.md"] {
        fs::write(folder.join(planted), "x").unwrap();
        core.wait_exited(&last);
        let (run, argv, _) = core.start(AgentKind::Claude, Some(conversation.clone()), &[]);
        assert!(
            claude_settings(&argv)["permissions"].get("allow").is_none(),
            "{planted}"
        );
        fs::remove_file(folder.join(planted)).unwrap();
        last = run.id;
    }
    // Once the folder is clean again, the allow rule comes back.
    core.wait_exited(&last);
    let (_, argv, _) = core.start(AgentKind::Claude, Some(conversation), &[]);
    assert_eq!(claude_settings(&argv)["permissions"], permissions(&folder));
}

#[test]
fn artifact_skill_rules_allow_only_plain_files_in_the_folder() {
    let f = "/data/artifacts/s1";
    let perms = permissions(Path::new(f));
    let same = |p: &str| decide(&perms, p, p);
    for p in [
        "chart.html",
        "sub/x.svg",
        "notes.md",
        "claude-notes.md",
        ".claudette/x.html",
    ] {
        assert_eq!(same(&format!("{f}/{p}")), "allow", "{p}");
    }
    // Configuration Claude Code loads from an added folder, at any depth and in any letter case.
    for p in [
        ".claude/skills/x/SKILL.md",
        ".Claude/skills/x/SKILL.md",
        ".CLAUDE/commands/c.md",
        "a/b/.claude/agents/x.md",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/rules/r.md",
        "CLAUDE.md",
        "claude.md",
        "sub/CLAUDE.local.md",
        "Claude.Local.MD",
    ] {
        assert_eq!(same(&format!("{f}/{p}")), "deny", "{p}");
    }
    // `..` out of the folder: the raw string matches `F/**` textually, so the rule text alone cannot refuse it; Claude
    // checks the path it resolves to as well, and allow needs both (decided by Claude's resolver, not the rules).
    assert_eq!(
        decide(
            &perms,
            &format!("{f}/../s2/x.html"),
            "/data/artifacts/s2/x.html"
        ),
        "ask"
    );
    // Outside the folder: asks.
    for p in [
        "/data/artifacts/s2/x.html".to_string(),
        format!("{f}-evil/x.html"),
        "/data/artifacts/S1/x.html".into(),
        "/DATA/artifacts/s1/x.html".into(),
        "/project/x.html".into(),
    ] {
        assert_eq!(same(&p), "ask", "{p}");
    }
    // A symlink inside the folder: allowed only when its target is too; a target in config is denied.
    assert_eq!(
        decide(&perms, &format!("{f}/link/x.html"), "/elsewhere/x.html"),
        "ask"
    );
    assert_eq!(
        decide(
            &perms,
            &format!("{f}/link/x.html"),
            &format!("{f}/real/x.html")
        ),
        "allow"
    );
    assert_eq!(
        decide(
            &perms,
            &format!("{f}/link/SKILL.md"),
            &format!("{f}/.claude/skills/x/SKILL.md")
        ),
        "deny"
    );
    // Only `Edit(path)` rules carry the decision (and the only rules written, ticket 287).
    let edit_only = json!({
        "allow": perms["allow"].as_array().unwrap().iter().filter(|r| r.as_str().unwrap().starts_with("Edit(")).collect::<Vec<_>>(),
        "deny": perms["deny"].as_array().unwrap().iter().filter(|r| r.as_str().unwrap().starts_with("Edit(")).collect::<Vec<_>>(),
    });
    assert_eq!(
        decide(
            &edit_only,
            &format!("{f}/.Claude/skills/SKILL.md"),
            &format!("{f}/.Claude/skills/SKILL.md")
        ),
        "deny"
    );
}

/// v1b-35: Codex 0.161.0 exits 1 at start when its effective sandbox is read-only and `--add-dir` is given ("Ignoring
/// --add-dir ... effective permissions do not allow additional writable roots"). Each read-only row was seen to exit a
/// real codex-cli 0.161.0 with `--add-dir`; each writable row stayed up (`-s` wins over `-c sandbox_mode` either way).
#[test]
fn artifact_skill_read_only_codex_gets_no_add_dir() {
    let core = Core::new("readonly", None, None);
    let read_only: &[&[&str]] = &[
        &["-s", "read-only"],
        &["--sandbox", "read-only"],
        &["--sandbox=read-only"],
        &["-sread-only"],
        &["-s=read-only"],
        &["-c=sandbox_mode=read-only"],
        &["-c", "sandbox_mode=\"read-only\""],
        &["--config", "sandbox_mode='read-only'"],
        &["--config=sandbox_mode=read-only"],
        &["-s", "workspace-write", "-s", "read-only"],
        &[
            "-c",
            "sandbox_mode=\"workspace-write\"",
            "-c",
            "sandbox_mode=\"read-only\"",
        ],
    ];
    for args in read_only {
        let (s, argv, env) = core.start(AgentKind::Codex, None, args);
        assert!(!argv.iter().any(|a| a == "--add-dir"), "{args:?}: {argv:?}");
        // The folder and the variable stay; the session just cannot write there.
        assert_eq!(env, core.folder(&s.id).display().to_string());
    }
    let writable: &[&[&str]] = &[
        &[],
        &["-s", "workspace-write"],
        &["--sandbox=danger-full-access"],
        &["-s", "read-only", "-s", "workspace-write"],
        &["-c", "sandbox_mode=\"read-only\"", "-s", "workspace-write"],
        &["-s", "workspace-write", "-c", "sandbox_mode=\"read-only\""],
        &["-c", "sandbox_workspace_write.network_access=true"],
    ];
    for args in writable {
        let (s, argv, _) = core.start(AgentKind::Codex, None, args);
        assert_eq!(
            value_after(&argv, "--add-dir"),
            [core.folder(&s.id).display().to_string()],
            "{args:?}: {argv:?}"
        );
    }
    // v1b-38: read-only set in Codex's config layers (each row exits a real codex-cli 0.161.0 with `--add-dir`).
    let codex = core.user.join(".codex");
    let ro = "sandbox_mode = \"read-only\"\n";
    let layers: &[(&str, &[&str])] = &[(ro, &[]), ("", &["-p", "ro"])];
    fs::write(codex.join("ro.config.toml"), ro).unwrap();
    for (top, args) in layers {
        fs::write(
            codex.join("config.toml"),
            format!("{top}{}", trusted(&core.home)),
        )
        .unwrap();
        let (s, argv, env) = core.start(AgentKind::Codex, None, args);
        assert!(
            !argv.iter().any(|a| a == "--add-dir"),
            "{top:?} {args:?}: {argv:?}"
        );
        assert_eq!(env, core.folder(&s.id).display().to_string());
    }
    fs::create_dir_all(core.home.join("project/.codex")).unwrap();
    fs::write(core.home.join("project/.codex/config.toml"), ro).unwrap();
    let (_, argv, _) = core.start(AgentKind::Codex, None, &[]);
    assert!(
        !argv.iter().any(|a| a == "--add-dir"),
        "project layer: {argv:?}"
    );
    let (s, argv, _) = core.start(AgentKind::Codex, None, &["-s", "workspace-write"]);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&s.id).display().to_string()],
        "launch over config"
    );
    fs::remove_file(core.home.join("project/.codex/config.toml")).unwrap();
    // No config at all: a folder without a trust entry is read-only.
    fs::remove_file(codex.join("config.toml")).unwrap();
    let (_, argv, _) = core.start(AgentKind::Codex, None, &[]);
    assert!(
        !argv.iter().any(|a| a == "--add-dir"),
        "no config: {argv:?}"
    );
    // Invalid config (Codex refuses to start on it): the folder is added as before.
    fs::write(codex.join("config.toml"), "sandbox_mode = \n").unwrap();
    let (s, argv, _) = core.start(AgentKind::Codex, None, &[]);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&s.id).display().to_string()],
        "invalid config"
    );
    // Claude has no such pair: a Claude session given the same words keeps its folder.
    let (s, argv, _) = core.start(AgentKind::Claude, None, &["-s", "read-only"]);
    assert_eq!(
        value_after(&argv, "--add-dir"),
        [core.folder(&s.id).display().to_string()]
    );
}

/// Ticket 287: Claude Code 2.1.318 warns "Write(path) ... is not matched by file permission checks; only Edit(path)
/// rules are" for a `Write(...)` rule, so a session's settings carry `Edit(//<abs>/...)` rules only, nothing else.
#[test]
fn no_never_matches_warning_at_start() {
    let core = Core::new("nowarn", None, None);
    let (s, argv, _) = core.start(AgentKind::Claude, None, &[]);
    let permissions = claude_settings(&argv)["permissions"].clone();
    let folder = core.folder(&s.id).display().to_string();
    for key in ["allow", "deny"] {
        let rules = permissions[key].as_array().unwrap();
        assert!(!rules.is_empty(), "{key}");
        for rule in rules {
            let rule = rule.as_str().unwrap();
            assert!(
                rule.starts_with(&format!("Edit(/{folder}/")),
                "{key} rule {rule} is not an Edit rule under //{folder}"
            );
        }
    }
}

/// Ticket 287, real-agent check (needs a signed-in `claude` on PATH; one cheap Haiku call):
/// `cargo test -p nunchiro-core --features live --test artifact_skill deny_rules_enforced_by_current_claude -- --nocapture`.
/// The session's own permission block goes to the installed Claude Code: a Write to the folder's `CLAUDE.md`,
/// `claude.md` (another letter case) and `sub/CLAUDE.md` is refused, an ordinary file is written, and the debug log has
/// no "not matched by file permission checks" line. The `.claude/x` refusal is asserted too but proves nothing about
/// the session's rules: Claude Code 2.1.318 guards `.claude/` by itself (control run with no deny rule, ticket 287
/// review S1); only the three rule-only paths attribute the refusal to the rules. Records `claude --version` (what
/// this does not prove: other versions, NotebookEdit).
#[cfg(feature = "live")]
#[test]
fn deny_rules_enforced_by_current_claude() {
    use std::process::Command;
    let core = Core::new("real", None, None);
    let (s, argv, _) = core.start(AgentKind::Claude, None, &[]);
    let folder = core.folder(&s.id);
    let rules = json!({"permissions": claude_settings(&argv)["permissions"]});
    let settings = core.home.join("only-permissions.json");
    fs::write(&settings, rules.to_string()).unwrap();
    let version = Command::new("claude").arg("--version").output().unwrap();
    eprintln!(
        "claude --version: {}",
        String::from_utf8_lossy(&version.stdout).trim()
    );
    let log = core.home.join("claude-debug.txt");
    let out = Command::new("claude")
        .current_dir(core.home.join("project"))
        .args([
            "-p",
            "--model",
            "haiku",
            "--tools",
            "Write,Edit",
            "--disable-slash-commands",
            "--strict-mcp-config",
        ])
        .args([
            "--setting-sources",
            "",
            "--output-format",
            "stream-json",
            "--verbose",
            "--debug-file",
        ])
        .arg(&log)
        .arg("--settings")
        .arg(&settings)
        .arg("--add-dir")
        .arg(&folder)
        .args([
            "--system-prompt",
            "Write files exactly as told with the Write tool, one call per file.",
        ])
        .arg(format!(
            "Write the text hi to each of these files: {f}/ok.txt, {f}/.claude/x, {f}/CLAUDE.md, {f}/claude.md, {f}/sub/CLAUDE.md",
            f = folder.display()
        ))
        .output()
        .unwrap();
    let stream = String::from_utf8_lossy(&out.stdout);
    let result: Value = stream
        .lines()
        .last()
        .and_then(|l| serde_json::from_str(l).ok())
        .unwrap_or(Value::Null);
    let denied: Vec<&str> = result["permission_denials"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| d["tool_input"]["file_path"].as_str())
        .collect();
    eprintln!("refused writes: {denied:?}");
    assert!(
        folder.join("ok.txt").exists(),
        "the allowed file was not written"
    );
    for gone in [".claude/x", "CLAUDE.md", "sub/CLAUDE.md"] {
        assert!(!folder.join(gone).exists(), "{gone} write went through");
    }
    // `claude.md` is the same file as CLAUDE.md on a case-insensitive disk, so its refusal is read from the denials.
    assert_eq!(denied.len(), 4, "{denied:?}");
    for rule_only in ["/CLAUDE.md", "/claude.md", "/sub/CLAUDE.md"] {
        assert!(
            denied.iter().any(|p| p.ends_with(rule_only)),
            "{rule_only} not refused: {denied:?}"
        );
    }
    let debug = fs::read_to_string(&log).unwrap();
    assert!(
        !debug.contains("not matched by file permission checks"),
        "{debug}"
    );
}

/// Ticket 276 round 3 (code SHOULD 3): Claude's `--add-dir` and `--mcp-config` are variadic (`<directories...>`,
/// `<configs...>`): in the split form they take every following word up to the next flag. With no hooks, no allow rule
/// and no other extension flag, the user's prompt must still be the prompt. Ticket 1130 S1: `--settings` (one word) now
/// always carries the outward hook.
#[test]
fn variadic_launch_flags_never_swallow_the_prompt() {
    // `{` in the home path: `folder_permissions` gives no rule for a glob character, so no `--settings` is written.
    let core = Core::new(
        "v{276",
        Some(r#"{"disable_hook_injection":true,"features":{"extensions.enabled":[]}}"#),
        None,
    );
    // What a variadic flag in the split form would take: the words after it up to the next flag.
    let swallowed = |argv: &[String]| -> Vec<String> {
        let mut out = vec![];
        for (i, a) in argv.iter().enumerate() {
            if a == "--add-dir" || a == "--mcp-config" {
                out.extend(
                    argv[i + 1..]
                        .iter()
                        .skip(1)
                        .take_while(|w| !w.starts_with('-'))
                        .cloned(),
                );
            }
        }
        out
    };
    let (_, argv, _) = core.start(AgentKind::Claude, None, &["fix the bug"]);
    assert!(argv.iter().any(|a| a.starts_with("--add-dir")), "{argv:?}");
    assert_eq!(argv.last().unwrap(), "fix the bug");
    assert!(swallowed(&argv).is_empty(), "{argv:?}");
    // Same with a sealed own MCP server: `--mcp-config` is then the last extension flag.
    call(
        &core.home,
        Request::ExtensionsMcpAdd {
            name: "files".into(),
            command: vec!["files-mcp".into()],
        },
    )
    .unwrap();
    let (_, argv, _) = core.start(AgentKind::Claude, None, &["fix the bug"]);
    assert!(
        argv.iter().any(|a| a.starts_with("--mcp-config")),
        "{argv:?}"
    );
    assert_eq!(argv.last().unwrap(), "fix the bug");
    assert!(swallowed(&argv).is_empty(), "{argv:?}");
}
