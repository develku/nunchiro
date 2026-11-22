//! Ticket 358: a tool's update and its new-version mark, against a real `nunchiro serve` with fake tools on PATH
//! (tests/fixtures/accounts/update-fake.sh) and a local fake of the npm registry. No real installer ever runs.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::{fs::symlink, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const FAKE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/accounts/update-fake.sh"
);
const OLD: &str = "2.1.319";
const NEXT: &str = "2.1.320";
/// Text a hostile registry answer carries: it must never reach a process.
const MARK: &str = "PWNED_358";

fn cli() -> PathBuf {
    cli::path()
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let limit = Instant::now() + Duration::from_secs(25);
    while !done() {
        assert!(Instant::now() < limit, "never: {what}");
        thread::sleep(Duration::from_millis(40));
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A local stand-in for registry.npmjs.org: `path` answers 200 with its body, anything else 404.
fn registry(routes: Vec<(&'static str, Vec<u8>)>) -> String {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in server.incoming().flatten() {
            let mut stream = stream;
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let _ = reader.read_line(&mut line);
            let path = line.split(' ').nth(1).unwrap_or("").to_string();
            let body = routes.iter().find(|(p, _)| *p == path).map(|(_, b)| b);
            let status = if body.is_some() { "200 OK" } else { "404 No" };
            let empty = vec![];
            let body = body.unwrap_or(&empty);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    format!("http://127.0.0.1:{port}/")
}

struct Core {
    home: PathBuf,
    user: PathBuf,
    process: Child,
    envs: Vec<(String, String)>,
}

/// Where each fake is installed before the core starts.
struct Fakes {
    home: PathBuf,
    user: PathBuf,
}
impl Fakes {
    fn new() -> Self {
        let home = home::short("up");
        let user = home.join("u");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("fake-version"), format!("{OLD} (Fake)\n")).unwrap();
        fs::write(user.join("fake-next-version"), format!("{NEXT} (Fake)\n")).unwrap();
        Self { home, user }
    }
    /// `bin/<name>` is a link to the fake at `rel` under the user's home, as a native installer leaves it.
    fn native(self, name: &str, rel: &str) -> Self {
        let real = self.user.join(rel);
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::copy(FAKE, &real).unwrap();
        symlink(&real, self.home.join("bin").join(name)).unwrap();
        self
    }
    /// A fake at `bin/<name>`, as Homebrew or a hand install leaves one: not the path any table entry names.
    fn plain(self, name: &str) -> Self {
        fs::copy(FAKE, self.home.join("bin").join(name)).unwrap();
        self
    }
    /// An npm-global tool: `bin/<name>` links into `<prefix>/lib/node_modules/<package>`, with npm in `<prefix>/bin`.
    fn npm(self, name: &str, package: &str) -> Self {
        let prefix = self.user.join("npm");
        let real = prefix.join("lib/node_modules").join(package).join("cli.js");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::create_dir_all(prefix.join("bin")).unwrap();
        fs::copy(FAKE, &real).unwrap();
        if !prefix.join("bin/npm").exists() {
            fs::copy(FAKE, prefix.join("bin/npm")).unwrap();
        }
        symlink(&real, self.home.join("bin").join(name)).unwrap();
        self
    }
    fn start(self, envs: &[(&str, &str)]) -> Core {
        // macOS checks a new executable at its first run (syspolicyd, XProtect), and on a gate machine full of fresh
        // build output that check queued for 3-5 s: past the core's 3 s `--version` bound, so the first read had no
        // version and kept that for 30 s. A real install has run before; these fakes run once here, outside any bound.
        // Ticket 474: with `auth`, which answers and exits, so the `--version` branch (a test's slow first run or hang)
        // is left for the core.
        for fake in fs::read_dir(self.home.join("bin")).unwrap() {
            let ran = Command::new(fake.unwrap().path())
                .arg("auth")
                .env("HOME", &self.user)
                .output()
                .unwrap();
            assert!(ran.status.success(), "{ran:?}");
        }
        let envs: Vec<(String, String)> = envs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let process = launch(&self.home, &self.user, &envs);
        let core = Core {
            home: self.home,
            user: self.user,
            process,
            envs,
        };
        core.ready();
        core
    }
}

fn launch(home: &Path, user: &Path, envs: &[(String, String)]) -> Child {
    home::git_env::scrubbed(cli())
        .arg("serve")
        .env("NUNCHIRO_HOME", home)
        .env("HOME", user)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", home.join("bin").display()),
        )
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .envs(envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn raw_at(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

impl Core {
    fn ready(&self) {
        until("core ready", || self.home.join("window.json").exists());
    }
    fn raw(&self, token: &str, request: Value) -> Value {
        raw_at(&self.home, token, request)
    }
    fn token(&self) -> String {
        fs::read_to_string(self.home.join("core.token"))
            .unwrap()
            .trim()
            .to_string()
    }
    fn owner(&self, request: Value) -> Value {
        self.raw(&self.token(), request)
    }
    fn mode(&self, mode: &str) {
        fs::write(self.user.join("fake-mode"), mode).unwrap();
    }
    /// The state once the first background read has finished.
    fn rows(&self) -> Vec<Value> {
        let mut rows = vec![];
        until("first version read", || {
            let r = self.owner(json!({"op":"agent_update_state"}));
            rows = r["Ok"]["rows"].as_array().cloned().unwrap_or_default();
            r["Ok"]["checked"] == true
        });
        rows
    }
    fn row(&self, tool: &str) -> Value {
        self.rows()
            .into_iter()
            .find(|r| r["tool"] == tool)
            .unwrap_or(Value::Null)
    }
    fn start_update(&self, tool: &str) -> Value {
        self.owner(json!({"op":"agent_update_start","tool":tool}))
    }
    fn cancel_update(&self, tool: &str) -> Value {
        self.owner(json!({"op":"agent_update_cancel","tool":tool}))
    }
    fn until_phase(&self, tool: &str, phase: &str) -> Value {
        let mut row = Value::Null;
        until(&format!("{tool} {phase}"), || {
            row = self.row(tool);
            row["run"]["phase"] == phase
        });
        row
    }
    fn until_no_run(&self, tool: &str) -> Value {
        let mut row = Value::Null;
        until(&format!("{tool} run over"), || {
            row = self.row(tool);
            row["run"].is_null()
        });
        row
    }
    fn file(&self, name: &str) -> String {
        fs::read_to_string(self.user.join(name)).unwrap_or_default()
    }
    fn pid(&self, name: &str) -> i32 {
        until(name, || self.file(name).ends_with('\n'));
        self.file(name).trim().parse().unwrap()
    }
    fn session_token(&self) -> String {
        let out = self.user.join("session.token");
        let script = format!(
            "printf %s \"$NUNCHIRO_TOKEN\" > '{}'; exec cat",
            out.display()
        );
        call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.clone(),
                    worktree: false,
                    label: "plain".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), script],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap();
        until("session token", || self.file("session.token").len() > 8);
        self.file("session.token")
    }
}

fn native_claude() -> Fakes {
    Fakes::new().native("claude", ".local/share/claude/versions/2.1.319")
}

// 358-update-progress: the row reads running with output that moves, then the new version, and no mark is left.
#[test]
fn update_runs_the_fixed_command_with_moving_progress() {
    let server = registry(vec![(
        "/@anthropic-ai/claude-code/latest",
        format!("{{\"version\":\"{NEXT}\"}}").into_bytes(),
    )]);
    let core = native_claude().start(&[("NUNCHIRO_UPDATE_REGISTRY", &server)]);
    let mut mark = Value::Null;
    until("the mark", || {
        mark = core.row("claude");
        mark["newer"] == true
    });
    assert_eq!(mark["can_update"], true, "{mark}");
    assert_eq!(mark["installed"], OLD);
    assert_eq!(mark["latest"], NEXT);

    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let mut seen = std::collections::BTreeSet::new();
    until("two different progress lines", || {
        if let Some(t) = core.row("claude")["run"]["text"]
            .as_str()
            .filter(|t| !t.is_empty())
        {
            seen.insert(t.to_string());
        }
        seen.len() >= 2
    });
    assert!(
        seen.iter().all(|t| t.starts_with("downloading part")),
        "{seen:?}"
    );
    let done = core.until_no_run("claude");
    assert_eq!(done["installed"], NEXT, "{done}");
    assert_eq!(done["newer"], false, "{done}");
    assert_eq!(core.file("update.log"), "claude update\n");
}

// Threat 1: a Homebrew-style path fails the condition: no button, and a direct start spawns nothing.
#[test]
fn a_path_that_fails_the_condition_gets_no_update_and_spawns_nothing() {
    let core = Fakes::new().plain("claude").plain("codex").start(&[]);
    for tool in ["claude", "codex"] {
        let row = core.row(tool);
        assert_eq!(row["can_update"], false, "{row}");
        assert_eq!(row["installed"], OLD, "the version still shows: {row}");
        assert!(core.start_update(tool)["Err"].is_string(), "{tool}");
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.file("update.log"), "", "something was spawned");
}

// Review round 2: ~/.local/bin/goose as a link to a Homebrew goose is not the install `goose update` is for.
#[test]
fn a_linked_install_path_gets_no_update_and_spawns_nothing() {
    let fakes = Fakes::new();
    let homebrew = fakes.user.join("opt/homebrew/bin/goose");
    fs::create_dir_all(homebrew.parent().unwrap()).unwrap();
    fs::copy(FAKE, &homebrew).unwrap();
    let link = fakes.user.join(".local/bin/goose");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&homebrew, &link).unwrap();
    symlink(&link, fakes.home.join("bin/goose")).unwrap();
    let core = fakes.start(&[]);
    let row = core.row("goose");
    assert_eq!(row["can_update"], false, "{row}");
    assert!(core.start_update("goose")["Err"].is_string());
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.file("update.log"), "", "something was spawned");
}

// Threat 2: a tool with no confirmed command never gets one.
#[test]
fn a_tool_with_no_confirmed_command_gets_no_update() {
    let core = Fakes::new()
        .plain("aider")
        .plain("grok")
        .plain("agy")
        .start(&[]);
    for tool in ["aider", "grok", "antigravity"] {
        let row = core.row(tool);
        assert_eq!(row["can_update"], false, "{row}");
        assert_eq!(row["latest"], Value::Null, "no source, no mark: {row}");
        assert_eq!(row["newer"], false, "{row}");
        assert!(core.start_update(tool)["Err"].is_string(), "{tool}");
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.file("update.log"), "", "something was spawned");
}

// Threats 2 and 3 (358-threat-update-args): shell text, an oversized body and a non-version give no mark, and the update
// runs the same fixed arguments with none of that text in the process list.
#[test]
fn a_hostile_answer_gives_no_mark_and_reaches_no_process() {
    let shell = format!("{{\"version\":\"9.9.9; touch $HOME/{MARK}\"}}");
    let server = registry(vec![
        ("/@anthropic-ai/claude-code/latest", shell.into_bytes()),
        ("/@openai/codex/latest", vec![b' '; 1024 * 1024]),
        (
            "/@google/gemini-cli/latest",
            b"{\"version\":\"latest\"}".to_vec(),
        ),
        ("/@opencode/cli/latest", b"<html>not json</html>".to_vec()),
    ]);
    let core = native_claude()
        .native("codex", ".codex/packages/standalone/releases/1/codex")
        .npm("gemini", "@google/gemini-cli")
        .npm("opencode", "@opencode/cli")
        .start(&[("NUNCHIRO_UPDATE_REGISTRY", &server)]);
    for tool in ["claude", "codex", "gemini", "opencode"] {
        let row = core.row(tool);
        assert_eq!(row["latest"], Value::Null, "{row}");
        assert_eq!(row["newer"], false, "{row}");
    }
    core.mode("hang");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    core.pid("leader.pid");
    let ps = Command::new("/bin/ps")
        .args(["-axww", "-o", "command="])
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&ps.stdout).contains(MARK),
        "text in the process list"
    );
    assert_eq!(core.file("update.log"), "claude update\n");
    assert!(!core.user.join(MARK).exists());
    core.cancel_update("claude");
    core.until_no_run("claude");
}

// 358-update-mark: an older install gets the mark and number; a tool with no confirmed source gets none.
#[test]
fn an_older_install_is_marked_and_a_tool_with_no_source_is_not() {
    let server = registry(vec![
        ("/@openai/codex/latest", b"{\"version\":\"2.2.0\"}".to_vec()),
        (
            "/@google/gemini-cli/latest",
            format!("{{\"version\":\"{OLD}\"}}").into_bytes(),
        ),
    ]);
    let core = Fakes::new()
        .plain("codex")
        .npm("gemini", "@google/gemini-cli")
        .native("goose", ".local/bin/goose")
        .start(&[("NUNCHIRO_UPDATE_REGISTRY", &server)]);
    let codex = core.row("codex");
    assert_eq!(codex["newer"], true, "{codex}");
    assert_eq!(codex["latest"], "2.2.0", "{codex}");
    // A mark is about the version only: this install path has no update.
    assert_eq!(codex["can_update"], false, "{codex}");
    let gemini = core.row("gemini");
    assert_eq!(gemini["newer"], false, "same version: {gemini}");
    let goose = core.row("goose");
    assert_eq!(goose["can_update"], true, "{goose}");
    assert_eq!(goose["latest"], Value::Null, "{goose}");
    assert_eq!(goose["newer"], false, "{goose}");
}

// npm-global tools run the npm beside them with the documented arguments, and two npm updates never overlap.
#[test]
fn an_npm_tool_updates_through_its_own_npm_one_at_a_time() {
    let core = Fakes::new()
        .npm("gemini", "@google/gemini-cli")
        .npm("opencode", "@opencode/cli")
        .start(&[]);
    assert_eq!(core.row("gemini")["can_update"], true);
    core.mode("hang");
    assert_eq!(core.start_update("gemini")["Ok"]["type"], "ack");
    core.pid("leader.pid");
    let once = "npm install -g @google/gemini-cli@latest\n";
    assert_eq!(core.file("update.log"), once);
    assert!(core.start_update("opencode")["Err"].is_string());
    core.cancel_update("gemini");
    core.until_no_run("gemini");
    assert_eq!(core.file("update.log"), once);
}

// Threat 4 and 358-update-progress: cancel ends the updater and the child it started; the row is back on its old version.
#[test]
fn cancel_ends_the_whole_group_and_the_row_returns() {
    let core = native_claude().start(&[]);
    core.mode("hang");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let (leader, child) = (core.pid("leader.pid"), core.pid("child.pid"));
    core.until_phase("claude", "running");
    assert_eq!(core.cancel_update("claude")["Ok"]["type"], "ack");
    until("leader and child gone", || !alive(leader) && !alive(child));
    let row = core.until_no_run("claude");
    assert_eq!(row["installed"], OLD, "{row}");
}

// Threat 4: a core that died mid-update leaves a recorded group; the next core's start ends it.
#[test]
fn a_recorded_group_is_swept_at_core_start() {
    let mut core = native_claude().start(&[]);
    core.mode("hang");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let (leader, child) = (core.pid("leader.pid"), core.pid("child.pid"));
    core.process.kill().unwrap();
    core.process.wait().unwrap();
    assert!(
        alive(leader) && alive(child),
        "the group should outlive a crashed core"
    );
    let _ = fs::remove_file(core.home.join("window.json"));
    core.process = launch(&core.home, &core.user, &core.envs);
    core.ready();
    until("the recorded group is swept", || {
        !alive(leader) && !alive(child)
    });
}

// 358-update-progress: a failed update offers retry through the same start, which then works.
#[test]
fn a_failed_update_reports_and_a_retry_works() {
    let core = native_claude().start(&[]);
    core.mode("fail");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let failed = core.until_phase("claude", "failed");
    assert_eq!(failed["run"]["reason"], "exited", "{failed}");
    assert_eq!(failed["run"]["code"], 3, "{failed}");
    assert_eq!(
        failed["run"]["text"], "could not reach the update server",
        "{failed}"
    );
    core.mode("ok");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let done = core.until_no_run("claude");
    assert_eq!(done["installed"], NEXT, "{done}");
}

// Q9 ja-J16-1: a start that fails once its checks passed (here the core's own folder cannot be resolved) records no run,
// so the next start is not "already updating" and a core swap does not wait on it. The user's home and PATH sit outside
// the core's folder, so only that folder is gone while it is moved.
#[test]
fn a_start_that_fails_late_leaves_no_run() {
    let fakes = Fakes::new();
    let user = home::short("uu");
    fs::rename(&fakes.user, &user).unwrap();
    let fakes = Fakes { user, ..fakes }.native("claude", ".local/share/claude/versions/2.1.319");
    let bin = fakes.user.join("bin");
    fs::create_dir_all(&bin).unwrap();
    symlink(
        fs::read_link(fakes.home.join("bin/claude")).unwrap(),
        bin.join("claude"),
    )
    .unwrap();
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let core = fakes.start(&[("PATH", &path)]);
    core.rows();
    let token = core.token();
    let moved = core.home.with_extension("moved");
    fs::rename(&core.home, &moved).unwrap();
    let r = raw_at(
        &moved,
        &token,
        json!({"op":"agent_update_start","tool":"claude"}),
    );
    fs::rename(&moved, &core.home).unwrap();
    assert!(r["Err"].is_string(), "{r}");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let done = core.until_no_run("claude");
    assert_eq!(done["installed"], NEXT, "{done}");
    let user = core.user.clone();
    drop(core);
    let _ = fs::remove_dir_all(user);
}

// T3's unchanged versus succeeded: exit 0 with the same version is not reported as updated.
#[test]
fn an_update_that_changes_nothing_says_so() {
    let core = native_claude().start(&[]);
    core.mode("same");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let row = core.until_phase("claude", "unchanged");
    assert_eq!(row["installed"], OLD, "{row}");
}

// The 5-minute cap, shortened: a hung installer ends as failed and its group goes.
#[test]
fn a_hung_update_times_out() {
    let core = native_claude().start(&[("NUNCHIRO_UPDATE_TIMEOUT_MS", "1200")]);
    core.mode("hang");
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let (leader, child) = (core.pid("leader.pid"), core.pid("child.pid"));
    let row = core.until_phase("claude", "failed");
    assert_eq!(row["run"]["reason"], "timed_out", "{row}");
    until("group gone", || !alive(leader) && !alive(child));
}

// Operator-only: an agent in a session and a remote caller are refused all three ops, and nothing runs.
#[test]
fn update_ops_are_refused_to_a_session_and_a_remote_caller() {
    let core = native_claude().start(&[]);
    let session = core.session_token();
    for request in [
        json!({"op":"agent_update_start","tool":"claude"}),
        json!({"op":"agent_update_cancel","tool":"claude"}),
        json!({"op":"agent_update_state"}),
    ] {
        assert_eq!(
            core.raw(&session, request.clone()),
            json!({"Err":"operation not granted"}),
            "{request}"
        );
        let remote = json!({"op":"remote","machine":"elsewhere","request":request});
        assert_eq!(
            core.owner(remote),
            json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "{request}"
        );
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.file("update.log"), "", "something was spawned");
}

/// Ticket 474: seconds a new binary's first `--version` takes here, past the 3 s a known binary gets.
const COLD: &str = "3.5";

// Ticket 474, Accounts version: a just-installed binary whose first run is slow still shows its version on the first
// read, not after the next one 30 s later.
#[test]
fn a_new_binary_slow_on_its_first_run_shows_its_version() {
    let fakes = native_claude();
    fs::write(fakes.user.join("fake-cold"), COLD).unwrap();
    let core = fakes.start(&[]);
    let row = core.row("claude");
    assert_eq!(row["installed"], OLD, "{row}");
    assert!(
        !core.user.join("fake-cold").exists(),
        "the slow run happened"
    );
}

// Ticket 474, update result: the updater replaces the binary, whose first run is slow; the row reads updated, not
// "changed nothing".
#[test]
fn an_update_whose_new_binary_is_slow_once_reads_as_updated() {
    let core = native_claude().start(&[]);
    assert_eq!(core.row("claude")["installed"], OLD);
    core.mode("new-binary");
    fs::write(core.user.join("fake-cold-after"), COLD).unwrap();
    assert_eq!(core.start_update("claude")["Ok"]["type"], "ack");
    let done = core.until_no_run("claude");
    assert_eq!(done["installed"], NEXT, "{done}");
    assert!(
        !core.user.join("fake-cold").exists(),
        "the slow run happened"
    );
}

// Ticket 474: a binary whose `--version` never answers is still stopped; the read ends without a version, in the same
// order of time as the 3 s limit (one longer first run, 8 s).
#[test]
fn a_version_that_hangs_is_still_stopped() {
    let fakes = native_claude();
    fs::write(fakes.user.join("fake-version-hangs"), "").unwrap();
    let began = Instant::now();
    let core = fakes.start(&[]);
    let row = core.row("claude");
    assert!(row["installed"].is_null(), "{row}");
    assert!(
        began.elapsed() < Duration::from_secs(15),
        "{:?}",
        began.elapsed()
    );
}
