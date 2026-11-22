//! Ticket 1036: Claude's 5 h and weekly limits from what Claude Code hands its status line command. A fake `claude`
//! runs the status line command its `--settings` file names, with a status line JSON on stdin, as Claude Code does.
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
    time::{Duration, Instant, SystemTime},
};

struct Core {
    home: PathBuf,
    process: Child,
}
/// The fake claude: finds the status line command in its `--settings` file, runs it with `status.json` on stdin and
/// keeps what it printed in `line.txt`, then waits.
const CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.330 (Claude Code)'; exit; fi
set=
while [ $# -gt 0 ]; do [ "$1" = --settings ] && set=$2; shift; done
cmd=$(sed -n 's/.*"statusLine":{"command":"\([^"]*\)".*/\1/p' "$set")
printf '%s' "$cmd" > cmd.txt
/bin/sh -c "$cmd" < status.json > line.tmp && mv line.tmp line.txt
sleep 30
"#;
impl Core {
    fn new(status: &str) -> Self {
        let home = home::short("cl");
        fs::write(home.join("status.json"), status).unwrap();
        fs::write(home.join("claude"), CLAUDE).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("claude-home")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CODEX_HOME", home.join("codex-home"))
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
            assert!(Instant::now() < until, "core did not start");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn request(&self, r: Request) -> Response {
        call(&self.home, r)
    }
    fn start(&self) {
        self.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: self.home.clone(),
                worktree: false,
                label: "test".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap();
    }
    /// The status line's output, once the fake claude has run it.
    fn line(&self) -> String {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(s) = fs::read_to_string(self.home.join("line.txt")) {
                return s;
            }
            assert!(Instant::now() < until, "the status line never ran");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn claude_row(&self) -> nunchiro_core::usage::Row {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Ok(Reply::AccountUsage { rows }) =
                self.request(Request::AccountUsage { limits: true })
            else {
                panic!("no usage reply");
            };
            let row = rows
                .into_iter()
                .find(|r| r.agent == nunchiro_core::accounts::Agent::Claude && r.id == "own")
                .unwrap();
            if row.limits_at.is_some() || Instant::now() > until {
                return row;
            }
            thread::sleep(Duration::from_millis(50));
        }
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
fn now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn status(five: f64, week: f64) -> String {
    let (r5, r7) = (now() + 3 * 3600, now() + 2 * 86_400);
    format!(
        r#"{{"session_id":"x","model":{{"display_name":"Opus"}},"rate_limits":{{"five_hour":{{"used_percentage":{five},"resets_at":{r5}}},"seven_day":{{"used_percentage":{week},"resets_at":{r7}}}}}}}"#
    )
}

#[test]
fn statusline_rate_limits_fill_the_claude_row() {
    let core = Core::new(&status(37.0, 82.4));
    core.start();
    core.line();
    let row = core.claude_row();
    let (s, w) = (row.session.unwrap(), row.weekly.unwrap());
    assert_eq!((s.left_pct, w.left_pct), (63, 18));
    assert!((s.resets_at - now() - 3 * 3600).abs() < 60, "{s:?}");
    assert!((now() - row.limits_at.unwrap()).abs() < 60);
    // The record is percentages and times only, in the core's home, owner-only.
    let kept = core.home.join("claude-limits.json");
    assert_eq!(
        fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let text = fs::read_to_string(kept).unwrap();
    assert!(
        !text.contains("Opus") && !text.contains("session_id"),
        "{text}"
    );
    // The session ran our status line command, from its own settings file.
    assert!(core.cmd().contains("hook statusline"));
}

#[test]
fn statusline_runs_the_users_own_command_with_the_same_input() {
    let core = Core::new(&status(10.0, 20.0));
    fs::write(
        core.home.join("claude-home/settings.json"),
        format!(
            r#"{{"statusLine":{{"type":"command","command":"cat > {}; echo OWN-LINE"}}}}"#,
            core.home.join("own-stdin.json").display()
        ),
    )
    .unwrap();
    core.start();
    assert_eq!(core.line(), "OWN-LINE\n");
    assert_eq!(
        fs::read_to_string(core.home.join("own-stdin.json")).unwrap(),
        fs::read_to_string(core.home.join("status.json")).unwrap()
    );
    assert_eq!(core.claude_row().weekly.unwrap().left_pct, 80);
}

#[test]
fn statusline_without_limits_or_core_prints_the_line_and_records_nothing() {
    // An API-key login has no `rate_limits`: nothing is recorded, the row stays without limits ("no data").
    let core = Core::new(r#"{"session_id":"x"}"#);
    core.start();
    assert_eq!(core.line(), "");
    let row = core.claude_row();
    assert_eq!((row.session, row.weekly, row.limits_at), (None, None, None));
    assert!(!core.home.join("claude-limits.json").exists());
}

#[test]
fn statusline_path_makes_no_outbound_call() {
    // The status line path talks to the core's own Unix socket only: no HTTP client, no network socket, no curl.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let hook = fs::read_to_string(root.join("nunchiro/src/hook.rs")).unwrap();
    let part = &hook[hook.find("pub fn statusline").unwrap()..];
    let usage = fs::read_to_string(root.join("nunchiro-core/src/usage.rs")).unwrap();
    let record =
        &usage[usage.find("pub struct Told").unwrap()..usage.find("fn told_window").unwrap()];
    for code in [part, record] {
        for banned in ["TcpStream", "curl", "http", "reqwest", "ureq", "oauth"] {
            assert!(
                !code.contains(banned),
                "the status line path names {banned}"
            );
        }
    }
}
impl Core {
    fn cmd(&self) -> String {
        fs::read_to_string(self.home.join("cmd.txt")).unwrap_or_default()
    }
}
