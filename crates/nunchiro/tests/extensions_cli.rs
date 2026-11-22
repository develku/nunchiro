//! Ticket 455: `nunchiro extensions` from a terminal, as the owner; refused inside an agent session.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Output,
    thread,
    time::{Duration, Instant},
};

struct Cli {
    core: home::ServeGuard,
    user: PathBuf,
}
impl Cli {
    fn new(tag: &str) -> Self {
        let home = home::short(tag);
        let user = home.join("user");
        fs::create_dir_all(&user).unwrap();
        let core = home::spawn_serve(&home, &[("HOME", user.to_str().unwrap())]);
        Self { core, user }
    }
    fn home(&self) -> &Path {
        &self.core.home
    }
    fn run(&self, token: Option<&str>, args: &[&str]) -> Output {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", self.home())
            .env("HOME", &self.user)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN");
        if let Some(t) = token {
            c.env("NUNCHIRO_TOKEN", t);
        }
        c.output().unwrap()
    }
    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(None, args);
        assert!(out.status.success(), "{args:?}: {}", text(&out.stderr));
        text(&out.stdout)
    }
    fn err(&self, args: &[&str]) -> String {
        let out = self.run(None, args);
        assert_eq!(
            out.status.code(),
            Some(1),
            "{args:?}: {}",
            text(&out.stdout)
        );
        text(&out.stderr)
    }
    fn enabled(&self) -> serde_json::Value {
        let Ok(Reply::QuitSettings { settings }) = call(
            self.home(),
            Request::QuitSettings {
                patch: Default::default(),
            },
        ) else {
            panic!("no settings")
        };
        settings
            .features
            .get("extensions.enabled")
            .cloned()
            .unwrap_or_default()
    }
}
fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn extensions_list_show_new_on_off() {
    let cli = Cli::new("extc");
    let usage = cli.ok(&["extensions"]);
    assert!(
        usage.starts_with("usage: nunchiro extensions list"),
        "{usage}"
    );
    assert!(
        cli.ok(&["--help"])
            .contains("nunchiro extensions list|show|new|on|off")
    );

    let made = cli.ok(&["extensions", "new", "notes", "--about", "Keeps notes tidy."]);
    println!("new: {made}");
    assert!(
        made.contains("extensions/notes; edit skills/notes/SKILL.md there"),
        "{made}"
    );
    assert!(made.contains("It is off: turn it on with"), "{made}");

    let list = cli.ok(&["extensions", "list"]);
    println!("list:\n{list}");
    let lines: Vec<&str> = list.lines().collect();
    assert!(
        lines[0].starts_with("nunchiro\tskill\ton\tHow to start"),
        "{list}"
    );
    assert_eq!(lines[1], "custom:notes\tskill\toff\tKeeps notes tidy.");
    // Ticket 580: the window's two Nunchiro switches are rows of their own, after the items.
    assert!(lines[2].starts_with("nunchiro-hooks\thook\ton\t"), "{list}");
    assert!(lines[3].starts_with("orchestration\tskill\ton\t"), "{list}");
    let json: serde_json::Value =
        serde_json::from_str(&cli.ok(&["extensions", "list", "--json"])).unwrap();
    assert_eq!(json[0]["enabled"], true);
    assert_eq!(json[1]["id"], "custom:notes");
    assert_eq!(json[1]["enabled"], false);
    assert_eq!(json[2]["id"], "nunchiro-hooks");
    assert_eq!(json[3]["enabled"], true);

    let show = cli.ok(&["extensions", "show", "custom:notes"]);
    println!("show:\n{show}");
    assert!(
        show.starts_with("custom:notes (skill, off)\nKeeps notes tidy.\nfolder: "),
        "{show}"
    );
    assert!(
        show.contains("/extensions/notes\nskills: notes\nfiles:\n"),
        "{show}"
    );
    assert!(show.contains("  skills/notes/SKILL.md\t"), "{show}");
    let file = cli.ok(&[
        "extensions",
        "show",
        "custom:notes",
        "skills/notes/SKILL.md",
    ]);
    assert!(file.starts_with("---\nname: notes\n"), "{file}");
    assert!(
        cli.ok(&["extensions", "show", "nunchiro"])
            .contains("skills: artifacts, nunchiro, orchestration")
    );

    // Security look r2: every custom item asks first, even one with no listed hooks.
    let asked = cli.err(&["extensions", "on", "custom:notes"]);
    assert!(asked.contains("pass --yes"), "{asked}");
    cli.ok(&["extensions", "on", "custom:notes", "--yes"]);
    assert_eq!(
        cli.enabled(),
        serde_json::json!(["nunchiro", "custom:notes"])
    );
    cli.ok(&["extensions", "off", "nunchiro"]);
    assert_eq!(cli.enabled(), serde_json::json!(["custom:notes"]));

    let unknown = cli.err(&["extensions", "on", "custom:nope"]);
    assert_eq!(
        unknown,
        "nunchiro: no extension custom:nope; known: nunchiro, custom:notes\n"
    );
    assert_eq!(cli.enabled(), serde_json::json!(["custom:notes"]));
}

/// Ticket 580: a hook item is made from the CLI, listed with its command, and Nunchiro's own two switches are
/// shown and turned off and on like the window's.
#[test]
fn extensions_new_hook_and_nunchiro_switches() {
    let cli = Cli::new("extk");
    let made = cli.ok(&[
        "extensions",
        "new",
        "log-stop",
        "--about",
        "Prints a line.",
        "--hook",
    ]);
    assert!(made.contains("edit hooks/hooks.json there"), "{made}");
    let show = cli.ok(&["extensions", "show", "custom:log-stop"]);
    assert!(show.starts_with("custom:log-stop (hook, off)\n"), "{show}");
    assert!(show.contains("hooks:\n  Stop: echo "), "{show}");
    let shown = cli.ok(&["extensions", "show", "nunchiro-hooks"]);
    assert!(shown.starts_with("nunchiro-hooks (hook, on)\n"), "{shown}");
    assert!(shown.contains("  SessionStart: "), "{shown}");
    assert_eq!(
        cli.ok(&["extensions", "off", "nunchiro-hooks"]),
        "nunchiro-hooks is off for new sessions\n"
    );
    cli.ok(&["extensions", "off", "orchestration"]);
    let list = cli.ok(&["extensions", "list"]);
    assert!(list.contains("nunchiro-hooks\thook\toff\t"), "{list}");
    assert!(list.contains("orchestration\tskill\toff\t"), "{list}");
    cli.ok(&["extensions", "on", "nunchiro-hooks"]);
    cli.ok(&["extensions", "on", "orchestration"]);
    let list = cli.ok(&["extensions", "list"]);
    assert!(list.contains("nunchiro-hooks\thook\ton\t"), "{list}");
    assert!(list.contains("orchestration\tskill\ton\t"), "{list}");
    let files = cli.err(&["extensions", "show", "nunchiro-hooks", "x"]);
    assert!(files.contains("has no files here"), "{files}");
}

/// Ticket 587: the text list ends a long description at a word and marks the cut; `--json` keeps the full text.
#[test]
fn extensions_list_cuts_a_long_description_at_a_word() {
    let cli = Cli::new("extw");
    let long = "Writes release notes from merged pull requests and posts them to the team channel every Friday.";
    cli.ok(&["extensions", "new", "notes", "--about", long]);
    let word = "x".repeat(120);
    cli.ok(&["extensions", "new", "word", "--about", &word]);
    let list = cli.ok(&["extensions", "list"]);
    println!("list:\n{list}");
    let row = |id: &str| {
        list.lines()
            .find(|l| l.starts_with(id))
            .unwrap()
            .to_string()
    };
    assert!(
        row("custom:notes").ends_with(
            "\tWrites release notes from merged pull requests and posts them to the team…"
        ),
        "{list}"
    );
    assert!(
        row("custom:word").ends_with(&format!("\t{}…", "x".repeat(79))),
        "{list}"
    );
    // Nunchiro's own rows are cut the same way: no row ends inside a word.
    for id in ["nunchiro-hooks", "orchestration"] {
        let about = row(id).rsplit('\t').next().unwrap().to_string();
        assert!(
            about.ends_with('…') && about.chars().count() <= 80,
            "{about}"
        );
        assert!(
            !about.trim_end_matches('…').ends_with(char::is_whitespace),
            "{about}"
        );
    }
    let json: serde_json::Value =
        serde_json::from_str(&cli.ok(&["extensions", "list", "--json"])).unwrap();
    let all: Vec<&str> = json
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["description"].as_str().unwrap())
        .collect();
    assert!(
        all.contains(&long) && all.contains(&word.as_str()),
        "{json}"
    );
}

#[test]
fn extensions_on_with_hooks_needs_yes() {
    let cli = Cli::new("exth");
    let hooks = cli.home().join("extensions/guard/hooks/hooks.json");
    fs::create_dir_all(hooks.parent().unwrap()).unwrap();
    fs::write(
        &hooks,
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./check.sh"}]}]}}"#,
    )
    .unwrap();
    let out = cli.run(None, &["extensions", "on", "custom:guard"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stdout).contains("  PreToolUse [Bash]: ./check.sh"),
        "{}",
        text(&out.stdout)
    );
    assert!(
        text(&out.stderr).contains("pass --yes"),
        "{}",
        text(&out.stderr)
    );
    assert_eq!(cli.enabled(), serde_json::Value::Null);
    assert!(
        cli.ok(&["extensions", "show", "custom:guard"])
            .contains("hooks:\n  PreToolUse [Bash]: ./check.sh\n")
    );
    cli.ok(&["extensions", "on", "custom:guard", "--yes"]);
    assert_eq!(
        cli.enabled(),
        serde_json::json!(["nunchiro", "custom:guard"])
    );
}

#[test]
fn extensions_refused_inside_an_agent_session() {
    let cli = Cli::new("exts");
    let file = cli.home().join("token.txt");
    let script = format!(
        "printf %s \"$NUNCHIRO_TOKEN\" > {}.tmp && mv {0}.tmp {0}; exec cat",
        file.display()
    );
    let Ok(Reply::Started { .. }) = call(
        cli.home(),
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: cli.home().to_path_buf(),
                worktree: false,
                label: "s".into(),
                args: vec!["/bin/sh".into(), "-c".into(), script],
                model: None,
                effort: None,
                resume: None,
            },
        },
    ) else {
        panic!("not started")
    };
    let until = Instant::now() + Duration::from_secs(10);
    while !file.exists() {
        assert!(Instant::now() < until, "no token");
        thread::sleep(Duration::from_millis(20));
    }
    let token = fs::read_to_string(&file).unwrap();
    for args in [
        &["extensions", "list"][..],
        &["extensions", "show", "nunchiro"],
        &["extensions", "new", "x", "--about", "y"],
        &["extensions", "on", "nunchiro"],
        &["extensions", "off", "nunchiro"],
    ] {
        let out = cli.run(Some(&token), args);
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        assert_eq!(
            text(&out.stderr),
            "nunchiro: operation not granted\n",
            "{args:?}"
        );
    }
    assert!(!cli.home().join("extensions/x").exists());
    assert_eq!(cli.enabled(), serde_json::Value::Null);
}
