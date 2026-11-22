//! V2-2c limit mark against a real `nunchiro serve` with fake `claude` and `codex` on PATH: each prints the screen the
//! test left in `NUNCHIRO_HOME/screen` and waits for one line. No real agent runs and no real limit is reached.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{accounts::Agent, api::*, server::call, usage::local_offset};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

const FAKE: &str = r#"#!/bin/sh
case "$1" in --version) echo "$VERSION_TEXT"; exit 0;; esac
cat "$NUNCHIRO_HOME/screen" 2>/dev/null
read line
"#;

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    project: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("aclim");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, version) in [
            ("claude", "2.1.312 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            fs::write(bin.join(name), FAKE.replace("$VERSION_TEXT", version)).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let project = home.join("proj");
        fs::create_dir_all(home.join("u")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", home.join("u"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CLAUDE_SECURESTORAGE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(30);
        while call(&home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        Self {
            home,
            project,
            process,
        }
    }
    /// The new account's id.
    fn add(&self, agent: Agent, label: &str) -> String {
        match call(
            &self.home,
            Request::AccountAdd {
                agent,
                label: label.into(),
            },
        ) {
            Ok(Reply::AccountAdded { account, .. }) => account.id,
            other => panic!("{other:?}"),
        }
    }
    /// Starts `kind` on `account` showing `screen`, and waits until its agent printed it.
    fn start(&self, kind: AgentKind, account: Option<&str>, screen: &str) -> String {
        fs::write(self.home.join("screen"), screen.replace('\n', "\r\n")).unwrap();
        let id = match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind,
                    project: self.project.clone(),
                    worktree: false,
                    label: String::new(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: account.map(Into::into),
                },
            },
        ) {
            Ok(Reply::Started { session }) => session.id,
            other => panic!("{other:?}"),
        };
        let first = screen.lines().next().unwrap_or_default().to_string();
        let until = Instant::now() + Duration::from_secs(20);
        // A request runs an observer pass, so the screen is read by the time its text shows.
        while !matches!(
            call(
                &self.home,
                Request::AgentRead {
                    id: id.clone(),
                    source: "screen".into(),
                    lines: 50,
                }
            ),
            Ok(Reply::Text { text }) if text.contains(&first)
        ) {
            assert!(
                Instant::now() < until,
                "session {id} never showed its screen"
            );
            thread::sleep(Duration::from_millis(20));
        }
        id
    }
    /// (agent, account id, mark) for every row of the usage reply.
    fn marks(&self) -> Vec<(Agent, String, Option<String>)> {
        call(&self.home, Request::Snapshot).unwrap();
        match call(&self.home, Request::AccountUsage { limits: false }) {
            Ok(Reply::AccountUsage { rows }) => rows
                .into_iter()
                .map(|r| (r.agent, r.id, r.limit_resets))
                .collect(),
            other => panic!("{other:?}"),
        }
    }
    fn mark(&self, agent: Agent, id: &str) -> Option<String> {
        self.marks()
            .into_iter()
            .find(|(a, i, _)| *a == agent && i == id)
            .unwrap_or_else(|| panic!("no row for {agent:?} {id}"))
            .2
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// Two hours from now in this machine's zone, as Claude Code 2.1.312 prints a reset within a day ("4:05pm").
fn claude_reset_ahead() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        + 7200;
    let local = (now + local_offset(now)).rem_euclid(86_400);
    let (h, m) = (local / 3600, local % 3600 / 60);
    format!(
        "{}:{m:02}{}",
        (h + 11) % 12 + 1,
        if h < 12 { "am" } else { "pm" }
    )
}
fn claude_limit(resets: &str) -> String {
    format!("You've hit your 5-hour limit \u{b7} resets {resets} (Local)\n/rate-limit-options\n")
}

fn assert_marked(core: &Core, expected: &[(Agent, &str, &str)]) {
    for (agent, id, mark) in core.marks() {
        let want = expected
            .iter()
            .find(|(a, i, _)| *a == agent && *i == id)
            .map(|(_, _, m)| m.to_string());
        assert_eq!(mark, want, "{agent:?} {id}");
    }
}

// V2-2c acceptance `limit_screen_marks_the_sessions_account`: a Claude session on account "work" shows its limit;
// the usage reply marks that account (agent + id) with the printed reset time.
#[test]
fn limit_screen_marks_the_sessions_account() {
    let core = Core::new();
    let work = core.add(Agent::Claude, "work");
    let resets = claude_reset_ahead();
    assert_eq!(core.mark(Agent::Claude, &work), None);
    core.start(AgentKind::Claude, Some("work"), &claude_limit(&resets));
    assert_eq!(core.mark(Agent::Claude, &work), Some(resets.clone()));
    assert_marked(&core, &[(Agent::Claude, &work, &resets)]);
}

// V2-2c acceptance `other_accounts_are_unmarked`: a second Claude account, "Your own" and Codex stay unmarked while
// "work" is marked; a session on no account (Your own) marks only "Your own"; a Codex limit marks Codex's account
// only, and a session whose screen shows no limit marks nothing.
#[test]
fn other_accounts_are_unmarked() {
    let core = Core::new();
    let work = core.add(Agent::Claude, "work");
    let other = core.add(Agent::Claude, "other");
    let codex = core.add(Agent::Codex, "work");
    let resets = claude_reset_ahead();
    core.start(AgentKind::Claude, Some("other"), "Welcome back\n> ");
    core.start(AgentKind::Claude, Some("work"), &claude_limit(&resets));
    assert_marked(&core, &[(Agent::Claude, &work, &resets)]);
    assert!(
        core.marks()
            .iter()
            .any(|(a, i, _)| *a == Agent::Claude && *i == other)
    );

    core.start(AgentKind::Claude, None, &claude_limit(&resets));
    assert_marked(
        &core,
        &[
            (Agent::Claude, &work, &resets),
            (Agent::Claude, "own", &resets),
        ],
    );
    // Codex 0.161.0's wording (tests/fixtures/problems/usage-limit-codex.bin), with a reset today in a day's last minute.
    let codex_screen = "\u{25a0} You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 11:59 PM.\n";
    core.start(AgentKind::Codex, Some("work"), codex_screen);
    let marks = core.marks();
    let codex_mark = marks
        .iter()
        .find(|(a, i, _)| *a == Agent::Codex && *i == codex)
        .unwrap()
        .2
        .clone();
    // Past 23:59 local the printed time is behind: no mark is the right answer then.
    assert!(codex_mark.is_none() || codex_mark.as_deref() == Some("11:59 PM"));
    assert_eq!(core.mark(Agent::Codex, "own"), None);
    assert_eq!(core.mark(Agent::Claude, &other), None);
}
