//! Ticket 260 (G28): the login shell's environment reaches Claude, Codex and shell PTY sessions (on by default; off
//! passes only PATH, locale, SSH_AUTH_SOCK and the listed names), never the core's own environment, a widget run or an
//! ACP agent. Each test runs a real `serve` with a fake `$SHELL` and its own HOME (no owner rc file is read): the fake
//! exports marker variables, then runs the probe's own command line with /bin/sh, so the real `printf`/`env -0` framing
//! is what the core parses.
#[path = "fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

/// The only variables the fake agent records: the markers and what the tests check (round 2: never a whole environment,
/// so no runner credential is written to the test folder or printed by a failing assertion).
const RECORDED: &str = "FROM_SHELL LISTED LANG SSH_AUTH_SOCK CORE_ONLY PATH NUNCHIRO_HOME TERM NUNCHIRO_LOGIN_PATH_PROBE NUNCHIRO_SESSION W36_TEST_API_SECRET SHELL_API_TOKEN W36_RAW_SECRET NUNCHIRO_TOKEN W75_CACHE_URL";

/// The fake login shell: the user's setup (an rc file's exports, a folder added to PATH), then the probe's argv.
const SHELL_ENV: &str = "export FROM_SHELL=shell-marker LISTED=listed-value LANG=xx_XX.UTF-8 \
SSH_AUTH_SOCK=/tmp/shell-agent.sock CORE_ONLY=shell-value NUNCHIRO_HOME=/bogus TERM=dumb ACP_TEST_ALLOWED=shell-value SHELL_API_TOKEN=shell-secret";

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    /// `shell_body` runs as the fake `$SHELL` (its args are the probe's `-ilc <command>`); `{bin}` is the folder that
    /// holds the only `claude`, which writes its environment to `<home>/claude.env`.
    fn new(tag: &str, shell_body: &str) -> Self {
        let home = home::short(tag);
        let bin = home.join("login-bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(home.join("proj")).unwrap();
        script(
            &bin.join("claude"),
            &format!(
                "case \"$1\" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nfor n in {RECORDED}; do eval \"if [ -n \\\"\\${{$n+x}}\\\" ]; then printf '%s=%s\\\\n' $n \\\"\\$$n\\\"; fi\"; done > {h}/claude.tmp && mv {h}/claude.tmp {h}/claude.env\nread line",
                h = home.display()
            ),
        );
        let shell = home.join("fake-shell");
        script(
            &shell,
            &shell_body.replace("{bin}", &bin.display().to_string()),
        );
        // Round 2 (security): a cleared environment plus only synthetic values, so no runner credential reaches the core,
        // its sessions or the files a failed test leaves behind.
        let process = home::git_env::scrubbed(home::cli::path())
            .env_clear()
            .envs(std::env::var_os("TMPDIR").map(|t| ("TMPDIR", t)))
            .env("NUNCHIRO_TEST_OPENER", "record")
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &home)
            .env("ZDOTDIR", &home)
            .env("SHELL", &shell)
            .env_remove("NUNCHIRO_LOGIN_PATH") // the probe runs, as in the app
            // `core-bin` first: empty but in the test that puts a `git` there (ticket 1024).
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                    home.join("core-bin").display()
                ),
            )
            .env("CORE_ONLY", "core-value")
            .env("W36_TEST_API_SECRET", "core-secret") // ticket 1008
            // Ticket 1024: a plain name whose value is a URL with a password.
            .env("W75_CACHE_URL", "redis://u:core-url-pw@cache.invalid/0")
            // Round 2 (Codex MUST): a secret name whose value is not UTF-8.
            .env(
                "W36_RAW_SECRET",
                <std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(b"raw-\xff"),
            )
            .env("ACP_TEST_ALLOWED", "core-value")
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while core.raw(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot" {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    /// The usual fake: the user's exports and a login folder on PATH, then the probe's own command line.
    fn on(tag: &str) -> Self {
        Self::new(
            tag,
            &format!("{SHELL_ENV}\nexport PATH={{bin}}:\"$PATH\"\nexec /bin/sh -c \"$2\""),
        )
    }
    fn raw(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        self.raw_as(token.trim(), request)
    }
    /// A request with `token`: the core's own (the owner's terminal) or a session's (that session is the caller).
    fn raw_as(&self, token: &str, request: Value) -> Value {
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let line = json!({"token": token, "request": request}).to_string() + "\n";
        s.write_all(line.as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(Value::Null)
    }
    fn ok(&self, request: Value) -> Value {
        let reply = self.raw(request.clone());
        assert!(reply["Ok"].is_object(), "{request} -> {reply}");
        reply["Ok"].clone()
    }
    fn features(&self, features: Value) {
        self.ok(json!({"op":"quit_settings","patch":{"features":features}}));
    }
    /// Starts a Claude session (the `claude` on the login PATH only) and returns the environment it ran with.
    fn claude_env(&self) -> BTreeMap<String, String> {
        self.env_of("claude", json!([]))
    }
    /// The same fake run as a shell tab's program (ticket 1008).
    fn shell_env(&self) -> BTreeMap<String, String> {
        let fake = self.home.join("login-bin/claude");
        self.env_of("shell", json!([fake]))
    }
    fn env_of(&self, kind: &str, args: Value) -> BTreeMap<String, String> {
        self.env_as(None, kind, args)
    }
    /// The environment of a `kind` session started by the session whose token is `caller` (None: the owner).
    fn env_as(&self, caller: Option<&str>, kind: &str, args: Value) -> BTreeMap<String, String> {
        let file = self.home.join("claude.env");
        let _ = fs::remove_file(&file);
        let request = json!({"op":"start","session":{"kind":kind,"project":self.home.join("proj"),
            "args":args,"model":null,"effort":null,"resume":null}});
        let started = match caller {
            None => self.ok(request),
            Some(token) => {
                let reply = self.raw_as(token, request.clone());
                assert!(reply["Ok"].is_object(), "{request} -> {reply}");
                reply["Ok"].clone()
            }
        };
        assert!(started["session"]["id"].is_string(), "{started}");
        let until = Instant::now() + Duration::from_secs(20);
        while !file.exists() {
            assert!(Instant::now() < until, "the session never ran the agent");
            thread::sleep(Duration::from_millis(20));
        }
        String::from_utf8_lossy(&fs::read(file).unwrap())
            .lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.raw(json!({"op":"stop"}));
        let until = Instant::now() + Duration::from_secs(10);
        while self.process.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

#[test]
fn shell_env_passed_to_pty_session_by_default() {
    let core = Core::on("uenv-on");
    let env = core.claude_env();
    assert_eq!(env["FROM_SHELL"], "shell-marker");
    assert_eq!(env["LISTED"], "listed-value");
    assert_eq!(env["LANG"], "xx_XX.UTF-8");
    // A shell value wins over the core's inherited one.
    assert_eq!(env["CORE_ONLY"], "shell-value");
    assert!(
        core.ok(json!({"op":"quit_settings"}))["settings"]["shell_env_error"].is_null(),
        "read without an error"
    );
}

#[test]
fn shell_env_off_passes_only_base_and_listed_names() {
    let core = Core::on("uenv-off");
    core.features(json!({"env.inherit_shell": false, "env.names": ["LISTED"]}));
    let env = core.claude_env();
    assert!(!env.contains_key("FROM_SHELL"), "{:?}", env.keys());
    assert_eq!(env["LISTED"], "listed-value");
    assert_eq!(env["LANG"], "xx_XX.UTF-8");
    assert_eq!(env["SSH_AUTH_SOCK"], "/tmp/shell-agent.sock");
    // Not listed: the core's own value, as before the ticket.
    assert_eq!(env["CORE_ONLY"], "core-value");
}

#[test]
fn shell_env_resolves_agent_on_shell_path() {
    // The core started with the launchd PATH; `claude` is only in the folder the login shell adds.
    let core = Core::on("uenv-path");
    let env = core.claude_env();
    let bin = core.home.join("login-bin").display().to_string();
    assert!(env["PATH"].split(':').any(|d| d == bin), "{}", env["PATH"]);
    // Off, the program is still found: the login PATH is the core's own since ticket 575.
    let off = Core::on("uenv-path-off");
    off.features(json!({"env.inherit_shell": false}));
    assert!(
        off.claude_env()["PATH"]
            .split(':')
            .any(|d| d.ends_with("login-bin"))
    );
}

#[test]
fn shell_env_never_changes_core_process_env() {
    // Off with no names: a session gets the core's own environment, which has no shell-only variable.
    let core = Core::on("uenv-core");
    core.features(json!({"env.inherit_shell": false}));
    let env = core.claude_env();
    assert!(!env.contains_key("FROM_SHELL"), "{:?}", env.keys());
    assert!(!env.contains_key("LISTED"), "{:?}", env.keys());
    assert_eq!(env["CORE_ONLY"], "core-value");
}

#[test]
fn shell_env_failure_keeps_core_env_and_reports() {
    // PATH answers, the environment does not (a shell without `env -0`, or one that prints only PATH).
    let core = Core::new(
        "uenv-fail",
        &format!(
            "{SHELL_ENV}\nprintf %s __NUNCHIRO_LOGIN_PATH__{{bin}}:\"$PATH\"__NUNCHIRO_LOGIN_PATH__"
        ),
    );
    let env = core.claude_env();
    assert!(!env.contains_key("FROM_SHELL"), "{:?}", env.keys());
    assert_eq!(env["CORE_ONLY"], "core-value");
    let error = core.ok(json!({"op":"quit_settings"}))["settings"]["shell_env_error"].clone();
    assert!(
        error
            .as_str()
            .is_some_and(|e| e.contains("no whole environment")),
        "{error}"
    );
    let log = fs::read_to_string(core.home.join("logs/core.log")).unwrap();
    assert!(log.contains("login environment: not read"), "{log}");
    assert!(!log.contains("shell-marker"), "{log}");
}

#[test]
fn nunchiro_vars_win_over_shell_values() {
    let core = Core::on("uenv-own");
    let env = core.claude_env();
    assert_eq!(env["NUNCHIRO_HOME"], core.home.display().to_string());
    assert_eq!(env["TERM"], "xterm-256color");
    assert!(
        !env.contains_key("NUNCHIRO_LOGIN_PATH_PROBE"),
        "{:?}",
        env.keys()
    );
    assert!(env["NUNCHIRO_SESSION"].len() > 4);
    // The log counts the variables and never shows a value.
    let log = fs::read_to_string(core.home.join("logs/core.log")).unwrap();
    assert!(
        log.contains("login environment: ") && log.contains(" variables"),
        "{log}"
    );
    assert!(!log.contains("shell-marker"), "{log}");
}

#[test]
fn widget_run_env_unchanged_with_shell_env_on() {
    let core = Core::on("uenv-wg");
    core.ok(json!({"op":"quit_settings","patch":{"script_widgets":true}}));
    let dir = core.home.join("widgets/envnames");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(dir.join("run.sh"), "env | cut -d= -f1 | sort\n").unwrap();
    let hash = core.ok(json!({"op":"approval_status","name":"envnames"}))["view"]["hash"].clone();
    core.ok(json!({"op":"approval_grant","name":"envnames","level":"read","hash":hash}));
    // The core answers within 250 ms and lets a longer run (a loaded host) finish in the background: ask until it ends.
    let until = Instant::now() + Duration::from_secs(30);
    let run = loop {
        let run = core.ok(json!({"op":"widget_run","name":"envnames"}))["run"].clone();
        if run["running"] != true {
            break run;
        }
        assert!(Instant::now() < until, "the widget run never ended: {run}");
        thread::sleep(Duration::from_millis(50));
    };
    let names = run["output"]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{run}"));
    assert!(names.lines().any(|n| n == "NUNCHIRO_CACHE"), "{names}");
    for shell_only in ["FROM_SHELL", "LISTED", "SSH_AUTH_SOCK", "CORE_ONLY"] {
        assert!(
            !names.lines().any(|n| n == shell_only),
            "{shell_only}: {names}"
        );
    }
}

#[test]
fn acp_agent_env_unchanged_with_shell_env_on() {
    let core = Core::on("uenv-acp");
    let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp/fake_agent.py");
    let log = core.home.join("agent.log");
    fs::write(
        core.home.join("agents.toml"),
        format!(
            "[[agent]]\nname = \"fake\"\ncommand = \"/usr/bin/python3\"\nargs = [{:?}, {:?}, \"info\"]\nenv = [\"ACP_TEST_ALLOWED\"]\n",
            fake.display().to_string(),
            log.display().to_string()
        ),
    )
    .unwrap();
    let hash = core.ok(json!({"op":"acp_agent_status","name":"fake"}))["view"]["hash"].clone();
    core.ok(json!({"op":"acp_agent_grant","name":"fake","hash":hash}));
    let started = core.raw(
        json!({"op":"start","session":{"kind":"acp","project":core.home.join("proj"),
        "args":["fake"],"model":null,"effort":null,"resume":null}}),
    );
    assert!(started["Ok"]["session"]["id"].is_string(), "{started}");
    let info = PathBuf::from(format!("{}.info", log.display()));
    let until = Instant::now() + Duration::from_secs(20);
    while fs::read_to_string(&info).map_or(true, |t| serde_json::from_str::<Value>(&t).is_err()) {
        assert!(Instant::now() < until, "the ACP agent never started");
        thread::sleep(Duration::from_millis(20));
    }
    let names: Value = serde_json::from_str(&fs::read_to_string(&info).unwrap()).unwrap();
    let names: Vec<&str> = names["env"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    // Only the approved name (the approval binds names); no shell-only variable rides along.
    assert!(names.contains(&"ACP_TEST_ALLOWED"), "{names:?}");
    for shell_only in ["FROM_SHELL", "LISTED", "SSH_AUTH_SOCK", "CORE_ONLY"] {
        assert!(!names.contains(&shell_only), "{shell_only}: {names:?}");
    }
}

// Ticket 1008: an agent session starts without secret-looking names from the core or the login shell, unless listed or
// the setting is off; a shell tab keeps them. Settings lists the names, never a value.
#[test]
fn agent_sessions_start_without_secret_names() {
    let core = Core::on("uenv-secret");
    let agent = core.claude_env();
    assert!(
        !agent.contains_key("W36_TEST_API_SECRET"),
        "{:?}",
        agent.keys()
    );
    assert!(!agent.contains_key("SHELL_API_TOKEN"), "{:?}", agent.keys());
    assert!(!agent.contains_key("W36_RAW_SECRET"), "{:?}", agent.keys());
    // Ticket 1024: a URL with a password is left out under any name.
    assert!(!agent.contains_key("W75_CACHE_URL"), "{:?}", agent.keys());
    assert_eq!(agent["FROM_SHELL"], "shell-marker");
    assert_eq!(agent["CORE_ONLY"], "shell-value");
    let shell = core.shell_env();
    assert_eq!(shell["W36_TEST_API_SECRET"], "core-secret");
    assert_eq!(shell["SHELL_API_TOKEN"], "shell-secret");
    assert!(shell.contains_key("W36_RAW_SECRET"), "{:?}", shell.keys());
    assert!(shell.contains_key("W75_CACHE_URL"), "{:?}", shell.keys());
    // Round 2 (Fable M1): a shell an agent starts (`nunchiro session start --kind shell`) is stripped like the agent.
    let fake = core.home.join("login-bin/claude");
    let by_agent = core.env_as(Some(&agent["NUNCHIRO_TOKEN"]), "shell", json!([fake]));
    assert!(
        by_agent.contains_key("NUNCHIRO_SESSION"),
        "{:?}",
        by_agent.keys()
    );
    for name in ["W36_TEST_API_SECRET", "SHELL_API_TOKEN", "W36_RAW_SECRET"] {
        assert!(
            !by_agent.contains_key(name),
            "{name}: {:?}",
            by_agent.keys()
        );
    }
    let settings = core.ok(json!({"op":"quit_settings"}))["settings"].clone();
    assert_eq!(
        settings["secret_env_names"],
        json!([
            "SHELL_API_TOKEN",
            "W36_RAW_SECRET",
            "W36_TEST_API_SECRET",
            "W75_CACHE_URL"
        ])
    );
    assert!(!settings.to_string().contains("core-secret"), "{settings}");
    assert!(!settings.to_string().contains("core-url-pw"), "{settings}");
    // A listed exact name passes; the other stays out.
    core.features(json!({"env.keep_secrets": ["W36_TEST_API_SECRET"]}));
    let agent = core.claude_env();
    assert_eq!(agent["W36_TEST_API_SECRET"], "core-secret");
    assert!(!agent.contains_key("SHELL_API_TOKEN"), "{:?}", agent.keys());
    // Off: today's environment.
    core.features(json!({"env.strip_secrets": false, "env.keep_secrets": null}));
    let agent = core.claude_env();
    assert_eq!(agent["W36_TEST_API_SECRET"], "core-secret");
    assert_eq!(agent["SHELL_API_TOKEN"], "shell-secret");
}

// Ticket 1008 round 4 (Fable M1): a shell the owner opens on a worktree row (the window or his `nunchiro worktree
// open`) keeps his environment; the same open asked by an agent session is stripped.
#[test]
fn owner_worktree_shell_keeps_secrets_agent_one_does_not() {
    // With no arguments the fake shell is the worktree tab's own shell: it records its environment first.
    let core = Core::new(
        "uenv-wt",
        &format!(
            "if [ $# -eq 0 ]; then exec {{bin}}/claude; fi\n{SHELL_ENV}\nexport PATH={{bin}}:\"$PATH\"\nexec /bin/sh -c \"$2\""
        ),
    );
    let proj = core.home.join("proj");
    for args in [
        &["init", "-q"][..],
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "c",
        ],
    ] {
        assert!(
            std::process::Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&proj)
                .env("HOME", &core.home)
                .status()
                .unwrap()
                .success()
        );
    }
    let made = core.ok(
        json!({"op":"worktree","operation":"create","project":proj,"path":null,
        "branch":"w36","base":"HEAD","label":""}),
    );
    let path = made["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["branch"] == "w36")
        .unwrap_or_else(|| panic!("{made}"))["path"]
        .clone();
    let open = |token: Option<&str>| {
        let file = core.home.join("claude.env");
        let _ = fs::remove_file(&file);
        let request = json!({"op":"worktree","operation":"open","project":null,"path":path,
            "branch":null,"base":"HEAD","label":""});
        let reply = match token {
            None => core.raw(request),
            Some(t) => core.raw_as(t, request),
        };
        assert!(reply["Ok"]["session"]["id"].is_string(), "{reply}");
        let until = Instant::now() + Duration::from_secs(30);
        while !file.exists() {
            assert!(Instant::now() < until, "the worktree shell never ran");
            thread::sleep(Duration::from_millis(20));
        }
        String::from_utf8_lossy(&fs::read(&file).unwrap())
            .lines()
            .filter_map(|l| l.split_once('=').map(|(k, _)| k.to_string()))
            .collect::<Vec<_>>()
    };
    let owner = open(None);
    assert!(
        owner.iter().any(|k| k == "W36_TEST_API_SECRET"),
        "{owner:?}"
    );
    let agent = core.claude_env();
    let by_agent = open(Some(&agent["NUNCHIRO_TOKEN"]));
    assert!(
        by_agent.iter().any(|k| k == "NUNCHIRO_SESSION"),
        "{by_agent:?}"
    );
    assert!(
        !by_agent.iter().any(|k| k == "W36_TEST_API_SECRET"),
        "{by_agent:?}"
    );
}

// Ticket 1009 round 5 (Codex MUST): the login probe never gets the core's secret-looking variables.
#[test]
fn login_probe_gets_no_secret_names() {
    let core = Core::new(
        "uenv-probe",
        &format!(
            "env | cut -d= -f1 > \"$(dirname \"$0\")/probe.names\"\n{SHELL_ENV}\nexport PATH={{bin}}:\"$PATH\"\nexec /bin/sh -c \"$2\""
        ),
    );
    let names = fs::read_to_string(core.home.join("probe.names")).unwrap();
    assert!(names.lines().any(|n| n == "CORE_ONLY"), "{names}");
    for secret in ["W36_TEST_API_SECRET", "W36_RAW_SECRET", "W75_CACHE_URL"] {
        assert!(!names.lines().any(|n| n == secret), "{secret}: {names}");
    }
}

// Ticket 1024: a program the core starts for itself gets none of the core's secret variables. `git` is found on the
// PATH (a restart takes it from the editable `core.start.json`), and `ps eww` shows a child's environment to any
// process of the same user: a fake `git` records the names it got, and the session holder (a live child of the core)
// is read with `ps` from here (`ps` shows no environment of a system binary such as the fake's /bin/sh, so the holder,
// the core's own executable, is the one to read). Every value is synthetic.
#[test]
fn core_children_get_no_secret() {
    const VALUES: [&str; 2] = ["core-secret", "core-url-pw"];
    let core = Core::on("uenv-kids");
    let seen = core.home.join("git-seen");
    fs::create_dir_all(&seen).unwrap();
    fs::create_dir_all(core.home.join("core-bin")).unwrap();
    script(
        &core.home.join("core-bin/git"),
        &format!(
            "env | cut -d= -f1 > {d}/$$.names\nexec /usr/bin/git \"$@\"",
            d = seen.display()
        ),
    );
    let proj = core.home.join("proj");
    assert!(
        std::process::Command::new("/usr/bin/git")
            .args(["init", "-q"])
            .current_dir(&proj)
            .env("HOME", &core.home)
            .status()
            .unwrap()
            .success()
    );
    // Any request that reads the folder with git.
    let reply = core.raw(
        json!({"op":"worktree","operation":"create","project":proj,"path":null,
        "branch":"w75","base":"HEAD","label":""}),
    );
    let names: Vec<String> = fs::read_dir(&seen)
        .unwrap()
        .map(|e| String::from_utf8_lossy(&fs::read(e.unwrap().path()).unwrap()).into_owned())
        .collect();
    assert!(
        !names.is_empty(),
        "the core never ran the git on its PATH: {reply}"
    );
    for names in &names {
        // The rest of the core's environment is still there.
        assert!(names.lines().any(|n| n == "CORE_ONLY"), "{names}");
        for secret in ["W36_TEST_API_SECRET", "W36_RAW_SECRET", "W75_CACHE_URL"] {
            assert!(!names.lines().any(|n| n == secret), "{secret}: {names}");
        }
    }
    // A live child: the holder of a session.
    core.claude_env();
    let table = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
        .unwrap();
    let core_pid = core.process.id().to_string();
    let children: Vec<String> = String::from_utf8_lossy(&table.stdout)
        .lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            let (pid, parent) = (words.next()?, words.next()?);
            (parent == core_pid).then(|| pid.to_string())
        })
        .collect();
    let mut holders = 0;
    for pid in children {
        let out = std::process::Command::new("/bin/ps")
            .args(["eww", "-o", "command=", "-p", &pid])
            .output()
            .unwrap();
        let shown = String::from_utf8_lossy(&out.stdout);
        if shown.contains(" hold ") && shown.contains("CORE_ONLY=core-value") {
            holders += 1;
        }
        for value in VALUES {
            assert!(!shown.contains(value), "{value} in a child's ps");
        }
    }
    assert_eq!(holders, 1, "the session's holder and its environment");
}
