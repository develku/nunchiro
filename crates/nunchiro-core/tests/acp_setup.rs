//! V2-4b: the owner's ACP setup requests (`acp_agents`, `acp_agent_check`, `acp_agent_add`, `acp_agent_login`), the
//! failed-start cards, and the hand-off to a named ACP agent, through a real `serve` over the owner socket with the
//! fake ACP agent of V2-4a (`fixtures/acp/fake_agent.py`).
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli() -> PathBuf {
    cli::path()
}
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp/fake_agent.py")
}

struct Core {
    home: PathBuf,
    project: PathBuf,
    log: PathBuf,
    process: Option<Child>,
}
impl Core {
    /// A core whose `agents.toml` holds `toml` (`{fake}` is replaced by a fake agent entry's command and args).
    fn new(tag: &str, toml: &str) -> Self {
        Self::with_path(tag, toml, |_| None)
    }
    /// `path` makes the core's PATH from the project folder (fake binaries live there).
    fn with_path(tag: &str, toml: &str, path: impl Fn(&Path) -> Option<String>) -> Self {
        Self::spawned(tag, toml, path, &[])
    }
    /// With these extra variables in the core's environment.
    fn with_env(tag: &str, env: &[(&str, &str)]) -> Self {
        Self::spawned(tag, "", |_| None, env)
    }
    fn spawned(
        tag: &str,
        toml: &str,
        path: impl Fn(&Path) -> Option<String>,
        env: &[(&str, &str)],
    ) -> Self {
        let home = home::short(tag);
        let project = home::short(&format!("{tag}p"));
        let path = path(&project).unwrap_or_else(|| "/usr/bin:/bin".into());
        let log = home.join("agent.log");
        let fake = format!(
            "command = \"/usr/bin/python3\"\nargs = [{:?}, {:?}",
            fixture().display().to_string(),
            log.display().to_string()
        );
        if !toml.is_empty() {
            fs::write(home.join("agents.toml"), toml.replace("{fake}", &fake)).unwrap();
        }
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", path)
            .env("ACP_TEST_ALLOWED", "yes")
            .env("ACP_TEST_SECRET", "must-not-reach-the-agent")
            .envs(env.iter().copied())
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
            .env("NUNCHIRO_SSH", "/usr/bin/false")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            project,
            log,
            process: Some(process),
        };
        let until = Instant::now() + Duration::from_secs(30);
        while core.raw(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot" {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    fn raw(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        self.raw_as(&token, request)
    }
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
    fn err(&self, request: Value) -> String {
        let reply = self.raw(request.clone());
        reply["Err"]
            .as_str()
            .unwrap_or_else(|| panic!("{request} -> {reply}"))
            .to_string()
    }
    /// The entry of the fake agent with `modes` after the log path (see the fixture's usage line).
    fn fake(&self, name: &str, modes: &[&str], env: &[&str]) -> Value {
        let mut args = vec![
            fixture().display().to_string(),
            self.log.display().to_string(),
        ];
        args.extend(modes.iter().map(|m| m.to_string()));
        json!({"name":name,"command":"/usr/bin/python3","args":args,"env":env})
    }
    fn status(&self, name: &str) -> Value {
        self.ok(json!({"op":"acp_agent_status","name":name}))["view"].clone()
    }
    fn approve(&self, name: &str) -> String {
        let hash = self.status(name)["hash"].as_str().unwrap().to_string();
        self.ok(json!({"op":"acp_agent_grant","name":name,"hash":hash}));
        hash
    }
    fn start(&self, name: &str) -> Value {
        self.raw(
            json!({"op":"start","session":{"kind":"acp","project":self.project,"args":[name],
            "model":null,"effort":null,"resume":null}}),
        )
    }
    fn session(&self, id: &str) -> Value {
        self.ok(json!({"op":"snapshot"}))["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn sessions(&self) -> Vec<Value> {
        self.ok(json!({"op":"snapshot"}))["sessions"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn wait_state(&self, id: &str, state: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let session = self.session(id);
            if session["state"] == state {
                return session;
            }
            assert!(Instant::now() < until, "{session}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn file(&self, name: &str) -> Option<Vec<u8>> {
        fs::read(self.home.join(name)).ok()
    }
    /// A token of a running session (a shell that prints its own).
    fn session_token(&self) -> String {
        let path = self.home.join("session.token");
        let script = format!(
            "printf %s \"$NUNCHIRO_TOKEN\" > {}; exec sleep 60",
            path.display()
        );
        let r = self.raw(
            json!({"op":"start","session":{"kind":"shell","project":self.project,
            "args":["/bin/sh","-c",script],"model":null,"effort":null,"resume":null}}),
        );
        assert!(r["Ok"].is_object(), "{r}");
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(token) = fs::read_to_string(&path)
                && token.len() > 20
            {
                return token;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.raw(json!({"op":"stop"}));
        if let Some(mut process) = self.process.take() {
            let until = Instant::now() + Duration::from_secs(10);
            while process.try_wait().unwrap().is_none() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = process.kill();
            let _ = process.wait();
        }
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
            let _ = fs::remove_dir_all(&self.project);
        }
    }
}

const FAKE: &str = "[[agent]]\nname = \"fake\"\n{fake}]\nenv = [\"ACP_TEST_ALLOWED\"]\n";

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A fake `--version` binary named `name` in `dir`.
fn binary(dir: &Path, name: &str, version: &str) {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\necho '{version}'\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// A1, A2: the known list and the rows

#[test]
fn acp_agents_list_rows() {
    let core = Core::with_path("setup-rows", FAKE, |project| {
        let bin = project.join("bin");
        binary(&bin, "gemini", "gemini 1.2.3");
        binary(&bin, "aider", "aider 0.9");
        binary(&bin, "claude", "claude 2.3.1");
        Some(format!("{}:/usr/bin:/bin", bin.display()))
    });
    core.approve("fake");
    let reply = core.ok(json!({"op":"acp_agents"}));
    assert_eq!(reply["type"], "acp_agents", "{reply}");
    assert_eq!(
        reply["file"],
        core.home.join("agents.toml").display().to_string()
    );
    let terminal = reply["terminal"].as_array().unwrap();
    let agents: Vec<_> = terminal
        .iter()
        .map(|f| f["agent"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["claude", "codex"], "{reply}");
    assert_eq!(terminal[0]["found"], true);
    assert_eq!(terminal[0]["version"], "claude 2.3.1");
    let rows = reply["acp"].as_array().unwrap();
    let row = |name: &str| {
        rows.iter()
            .find(|r| r["name"] == name)
            .unwrap_or_else(|| panic!("{name}: {reply}"))
    };
    let gemini = row("gemini");
    assert_eq!(gemini["source"], "known");
    assert_eq!(gemini["label"], "Gemini CLI");
    assert_eq!(gemini["acp"], true);
    assert_eq!(gemini["args"], json!(["--acp"]));
    assert_eq!(gemini["env"], json!(["GEMINI_API_KEY"]));
    assert!(
        gemini["found_path"]
            .as_str()
            .unwrap()
            .ends_with("/bin/gemini")
    );
    assert_eq!(gemini["version"], "gemini 1.2.3");
    assert!(
        gemini["state"].is_null(),
        "not in agents.toml yet: {gemini}"
    );
    let opencode = row("opencode");
    assert!(opencode["found_path"].is_null());
    assert_eq!(opencode["install_url"], "https://opencode.ai");
    assert_eq!(row("goose")["args"], json!(["acp"]));
    let aider = row("aider");
    assert_eq!(aider["acp"], false);
    assert_eq!(aider["version"], "aider 0.9");
    // The custom row, approved: its state and hash come from the approval.
    let fake = row("fake");
    assert_eq!(fake["source"], "custom");
    assert_eq!(fake["state"], "approved");
    assert_eq!(fake["hash"], core.status("fake")["hash"]);
    // No Claude template ships (spec).
    assert!(
        rows.iter()
            .all(|r| !r["name"].as_str().unwrap().contains("claude")
                && !r["command"].as_str().unwrap().contains("claude")),
        "{reply}"
    );
}

#[test]
fn acp_agents_listing_never_runs_an_unapproved_entry() {
    let core = Core::new("setup-noexec", "");
    // A command an agents.toml entry names runs for a listing only once a human approved it.
    let ran = core.home.join("ran.txt");
    let script = core.home.join("probe.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\necho ran >> {}\necho 'probe 1.0'\n",
            ran.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    core.ok(
        json!({"op":"acp_agent_add","entry":{"name":"probe","command":script,"args":[],"env":[]}}),
    );
    let row = |reply: &Value| {
        reply["acp"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == "probe")
            .unwrap()
            .clone()
    };
    let listed = row(&core.ok(json!({"op":"acp_agents"})));
    assert_eq!(listed["found_path"], script.display().to_string());
    assert!(listed["version"].is_null(), "{listed}");
    assert!(!ran.exists(), "an unapproved entry was run for a listing");
    // Approved, then changed again: run only while it is approved as it stands.
    core.approve("probe");
    assert_eq!(
        row(&core.ok(json!({"op":"acp_agents"})))["version"],
        "probe 1.0"
    );
    assert!(ran.exists());
    fs::remove_file(&ran).unwrap();
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("args = []", "args = [\"x\"]"),
    )
    .unwrap();
    let changed = row(&core.ok(json!({"op":"acp_agents"})));
    assert_eq!(changed["state"], "changed");
    assert!(changed["version"].is_null() && !ran.exists(), "{changed}");
}

#[test]
fn acp_agents_known_entry_takes_the_agents_toml_content() {
    let core = Core::new(
        "setup-known",
        "[[agent]]\nname = \"gemini\"\ncommand = \"/opt/gemini/bin/gemini\"\nargs = [\"--acp-v1\"]\nenv = [\"MY_KEY\"]\n",
    );
    let reply = core.ok(json!({"op":"acp_agents"}));
    let rows = reply["acp"].as_array().unwrap();
    let gemini = rows.iter().find(|r| r["name"] == "gemini").unwrap();
    assert_eq!(gemini["command"], "/opt/gemini/bin/gemini");
    assert_eq!(gemini["args"], json!(["--acp-v1"]));
    assert_eq!(gemini["env"], json!(["MY_KEY"]));
    assert_eq!(gemini["state"], "unapproved");
    assert_eq!(gemini["source"], "known");
    assert_eq!(rows.iter().filter(|r| r["name"] == "gemini").count(), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Every new request is the owner's alone

#[test]
fn acp_new_requests_owner_only() {
    let core = Core::new("setup-owner", "");
    let token = core.session_token();
    let entry = core.fake("fake", &[], &["ACP_TEST_ALLOWED"]);
    let requests = [
        json!({"op":"acp_agents"}),
        json!({"op":"acp_agent_check","entry":entry}),
        json!({"op":"acp_agent_add","entry":entry}),
        json!({"op":"acp_agent_login","name":"fake","project":core.project}),
        // Ticket 358: sign-in and sign-out run the agent and change its login: never a session's or a remote's.
        json!({"op":"acp_agent_sign_in","name":"fake","method":"oauth","project":core.project}),
        json!({"op":"acp_agent_sign_in_state","attempt":"x"}),
        json!({"op":"acp_agent_sign_in_cancel","attempt":"x"}),
        json!({"op":"acp_agent_sign_out","name":"fake"}),
        // The test message runs the agent and spends its allowance.
        json!({"op":"acp_agent_try","name":"fake"}),
    ];
    // The agent CLI in a session also reads the owner token from core.token: the peer check swaps it for the
    // session's, so it is the same session caller.
    let script: String = requests
        .iter()
        .enumerate()
        .map(|(n, r)| {
            format!(
                "printf '{{\"token\":\"%s\",\"request\":%s}}\\n' \"$(cat \"$NUNCHIRO_HOME/core.token\")\" '{r}' \
                 | /usr/bin/nc -U \"$NUNCHIRO_HOME/core.sock\" > \"$NUNCHIRO_HOME/cli-{n}.out\"\n"
            )
        })
        .collect::<String>()
        + "exec sleep 30\n";
    let started = core.raw(
        json!({"op":"start","session":{"kind":"shell","project":core.project,
        "args":["/bin/sh","-c",script],"model":null,"effort":null,"resume":null}}),
    );
    assert!(started["Ok"].is_object(), "{started}");
    for (n, request) in requests.iter().enumerate() {
        let op = request["op"].as_str().unwrap();
        let reply = core.raw_as(&token, request.clone());
        assert_eq!(
            reply["Err"], "operation not granted",
            "session token {op}: {reply}"
        );
        let remote = core.raw(json!({"op":"remote","machine":"m","request":request}));
        assert!(
            remote["Err"]
                .as_str()
                .unwrap_or_default()
                .contains("local owner-only"),
            "remote {op}: {remote}"
        );
        let until = Instant::now() + Duration::from_secs(10);
        let out = loop {
            if let Some(out) = core.file(&format!("cli-{n}.out")).filter(|o| !o.is_empty()) {
                break String::from_utf8(out).unwrap();
            }
            assert!(
                Instant::now() < until,
                "the agent CLI got no answer for {op}"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(
            out.contains("operation not granted"),
            "agent CLI {op}: {out}"
        );
    }
    assert!(
        core.file("agents.toml").is_none(),
        "an add reached the file"
    );
    // The owner socket is accepted (a refused login for an unapproved agent is not a grant refusal).
    assert!(core.ok(requests[0].clone())["acp"].is_array());
    assert!(core.ok(requests[1].clone())["type"] == "acp_check");
    assert!(core.ok(requests[2].clone())["view"]["name"] == "fake");
    assert!(
        core.err(requests[3].clone())
            .contains("approve the agent first")
    );
}

// ---------------------------------------------------------------------------------------------------------------
// A3: the check before approval

#[test]
fn acp_check_handshake_reports_time_capabilities_and_sign_in() {
    let core = Core::new("setup-check", "");
    let entry = core.fake("fake", &["load"], &[]);
    let reply = core.ok(json!({"op":"acp_agent_check","entry":entry}));
    assert_eq!(reply["type"], "acp_check", "{reply}");
    assert!(
        reply["found_path"].as_str().unwrap().ends_with("python3"),
        "{reply}"
    );
    assert!(
        reply["version"].as_str().unwrap().starts_with("Python"),
        "{reply}"
    );
    assert!(reply["acp_v1_ms"].as_u64().is_some(), "{reply}");
    assert_eq!(
        reply["capabilities"],
        json!(["loadSession", "promptCapabilities.image"]),
        "{reply}"
    );
    assert_eq!(reply["signed_in"], true, "{reply}");
    assert!(reply["error"].is_null(), "{reply}");
    // A signed-out agent: the auth error is shown, redacted.
    let reply = core.ok(json!({"op":"acp_agent_check","entry":core.fake("fake", &["auth"], &[])}));
    assert_eq!(reply["signed_in"], false, "{reply}");
    assert!(reply["acp_v1_ms"].as_u64().is_some(), "{reply}");
    assert!(
        reply["error"].as_str().unwrap().contains("auth_required"),
        "{reply}"
    );
    // A v2-only agent: no v1 answer.
    let reply = core.ok(json!({"op":"acp_agent_check","entry":core.fake("fake", &["v2"], &[])}));
    assert!(
        reply["acp_v1_ms"].is_null() && reply["signed_in"].is_null(),
        "{reply}"
    );
    assert!(
        reply["error"].as_str().unwrap().contains("version"),
        "{reply}"
    );
}

#[test]
fn acp_check_handshake_confined() {
    let core = Core::new("setup-conf", "");
    fs::write(core.home.join("agents.toml"), "# mine\n").unwrap();
    let before = (core.file("approvals.json"), core.file("agents.toml"));
    // The core cwd and env stay out of reach: only the entry's allowed names, a fresh empty folder, no answer to a
    // file or terminal request.
    let entry = core.fake("fake", &["info", "fsask"], &["ACP_TEST_ALLOWED"]);
    let reply = core.ok(json!({"op":"acp_agent_check","entry":entry}));
    assert_eq!(reply["signed_in"], true, "{reply}");
    let info: Value =
        serde_json::from_slice(&fs::read(format!("{}.info", core.log.display())).unwrap()).unwrap();
    let cwd = PathBuf::from(info["cwd"].as_str().unwrap());
    assert_eq!(cwd.parent().unwrap(), core.home.join("acp-check"), "{info}");
    assert!(!cwd.exists(), "the check folder was left behind");
    let env = info["env"].to_string();
    assert!(env.contains("ACP_TEST_ALLOWED"), "{env}");
    for name in ["ACP_TEST_SECRET", "NUNCHIRO_SSH", "NUNCHIRO_HOME", "PATH"] {
        assert!(
            !env.contains(&format!("\"{name}\"")),
            "{name} leaked: {env}"
        );
    }
    // The agent asked for a file and a terminal before the session started; nothing answered.
    let log = fs::read_to_string(&core.log).unwrap();
    assert!(log.contains("session/new"), "{log}");
    let answers: Vec<Value> = log
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|m| m.get("method").is_none() && m.get("id").is_some_and(|id| id.is_string()))
        .collect();
    assert!(
        answers.is_empty(),
        "the check answered the agent: {answers:?}"
    );
    assert!(!Path::new(&format!("{}.terminal", core.log.display())).exists());
    // Never reads or writes the approvals file or agents.toml.
    assert_eq!(
        (core.file("approvals.json"), core.file("agents.toml")),
        before
    );
    // The `--version` run is confined alike: allowed env names only, in the same empty folder.
    let wrapper = core.home.join("wrap.sh");
    let seen = core.home.join("version.env");
    fs::write(&wrapper, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then env > {} ; pwd >> {}; echo 'wrap 9.9'; exit 0; fi\nexec /usr/bin/python3 {} {}\n", seen.display(), seen.display(), fixture().display(), core.log.display())).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let reply = core.ok(json!({"op":"acp_agent_check","entry":{"name":"w","command":wrapper,"args":[],"env":["ACP_TEST_ALLOWED"]}}));
    assert_eq!(reply["version"], "wrap 9.9", "{reply}");
    let text = fs::read_to_string(&seen).unwrap();
    assert!(text.contains("ACP_TEST_ALLOWED=yes"), "{text}");
    for name in [
        "ACP_TEST_SECRET=",
        "NUNCHIRO_HOME=",
        "NUNCHIRO_SSH=",
        "HOME=",
    ] {
        assert!(
            !text.contains(name),
            "{name} reached the version run: {text}"
        );
    }
    assert!(text.contains("/acp-check/"), "{text}");
    // The agent's process group is gone.
    let pid = info["pid"].as_i64().unwrap() as i32;
    let until = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < until, "agent {pid} outlived the check");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn acp_check_hang_is_killed_at_the_cap_and_claude_is_refused() {
    let core = Core::new("setup-hang", "");
    let began = Instant::now();
    let entry = core.fake("fake", &["hang", "info"], &[]);
    let reply = core.ok(json!({"op":"acp_agent_check","entry":entry}));
    let took = began.elapsed();
    assert!(
        took >= Duration::from_secs(4) && took < Duration::from_secs(8),
        "{took:?}"
    );
    assert!(
        reply["acp_v1_ms"].is_null() && reply["signed_in"].is_null(),
        "{reply}"
    );
    assert!(
        reply["error"].as_str().unwrap().contains("did not answer"),
        "{reply}"
    );
    let info: Value =
        serde_json::from_slice(&fs::read(format!("{}.info", core.log.display())).unwrap()).unwrap();
    let pid = info["pid"].as_i64().unwrap() as i32;
    assert!(!alive(pid), "the hanging agent {pid} is still running");
    assert!(
        !core
            .home
            .join("acp-check")
            .read_dir()
            .unwrap()
            .any(|_| true),
        "check folder left behind"
    );
    // A Claude entry without an API key is refused at once, without a spawn.
    let _ = fs::remove_file(&core.log);
    let _ = fs::remove_file(format!("{}.info", core.log.display()));
    let claude = json!({"name":"c","command":"/usr/bin/python3","args":[fixture(), core.log, "claude-agent-acp"],"env":[]});
    let began = Instant::now();
    let reply = core.ok(json!({"op":"acp_agent_check","entry":claude}));
    assert!(began.elapsed() < Duration::from_secs(2));
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("ANTHROPIC_API_KEY"),
        "{reply}"
    );
    assert!(!core.log.exists(), "a refused entry was spawned");
}

#[test]
fn acp_check_runs_one_at_a_time() {
    let core = std::sync::Arc::new(Core::new("setup-one", ""));
    let entry = core.fake("fake", &["hang"], &[]);
    let first = {
        let core = core.clone();
        let entry = entry.clone();
        thread::spawn(move || core.ok(json!({"op":"acp_agent_check","entry":entry})))
    };
    thread::sleep(Duration::from_millis(800));
    let second = core.err(json!({"op":"acp_agent_check","entry":entry}));
    assert!(second.contains("a check is running"), "{second}");
    let first = first.join().unwrap();
    assert!(first["error"].is_string(), "{first}");
    // Free again once the first ended.
    let again = core.ok(json!({"op":"acp_agent_check","entry":core.fake("fake", &[], &[])}));
    assert_eq!(again["signed_in"], true, "{again}");
}

// ---------------------------------------------------------------------------------------------------------------
// A4: the add

#[test]
fn acp_add_appends_validated_entry() {
    let original = "# my agents\n[[agent]]\nname = \"fake\"\ncommand = \"/usr/bin/python3\"\nargs = [\"-V\"]\nenv = []\n# the end\n";
    let core = Core::new("setup-add", original);
    // The harness wrote the file without substitution (no `{fake}` in it).
    let entry = json!({"name":"gem","command":"/opt/gem/bin/gem","args":["--실험","acp"],"env":["GEM_KEY"]});
    let reply = core.ok(json!({"op":"acp_agent_add","entry":entry}));
    assert_eq!(reply["type"], "acp_agent", "{reply}");
    assert_eq!(reply["view"]["state"], "unapproved");
    assert_eq!(reply["view"]["entry"], entry);
    let text = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    assert!(text.starts_with(original), "earlier text changed:\n{text}");
    assert_eq!(
        fs::metadata(core.home.join("agents.toml"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // Hangul round-trips through the file.
    assert_eq!(core.status("gem")["entry"], entry);
    // The same entry again writes nothing and returns its view.
    let again = core.ok(json!({"op":"acp_agent_add","entry":entry}));
    assert_eq!(again["view"]["hash"], reply["view"]["hash"]);
    assert_eq!(core.file("agents.toml").unwrap(), text.as_bytes());
    // Refused, with nothing written.
    let bad = |what: &str, entry: Value, expect: &str| {
        let e = core.err(json!({"op":"acp_agent_add","entry":entry}));
        assert!(e.contains(expect), "{what}: {e}");
        assert_eq!(
            core.file("agents.toml").unwrap(),
            text.as_bytes(),
            "{what} wrote"
        );
    };
    let base = |env: Value| json!({"name":"x","command":"/opt/x","args":[],"env":env});
    bad("value for a name", base(json!(["KEY=abc"])), "names only");
    bad("a key", base(json!(["sk-ant-xxx"])), "names only");
    bad("lowercase", base(json!(["my_key"])), "names only");
    bad(
        "control char in command",
        json!({"name":"x","command":"/opt/x\u{7}","args":[],"env":[]}),
        "control",
    );
    bad(
        "control char in arg",
        json!({"name":"x","command":"/opt/x","args":["a\nb"],"env":[]}),
        "control",
    );
    bad(
        "relative command",
        json!({"name":"x","command":"gem","args":[],"env":[]}),
        "absolute",
    );
    bad(
        "bad name",
        json!({"name":"../x","command":"/opt/x","args":[],"env":[]}),
        "name",
    );
    bad(
        "claude without a key",
        json!({"name":"x","command":"/opt/claude-acp","args":[],"env":[]}),
        "ANTHROPIC_API_KEY",
    );
    // Ticket 355: the same name with other content is the owner's change: it replaces the entry and is not approved.
    let changed = core.ok(json!({"op":"acp_agent_add","entry":{"name":"gem","command":"/opt/other","args":[],"env":[]}}));
    assert_ne!(changed["view"]["state"], "approved");
    assert_eq!(changed["view"]["entry"]["command"], "/opt/other");
    let granted =
        core.ok(json!({"op":"acp_agent_grant","name":"gem","hash":changed["view"]["hash"]}));
    assert_eq!(granted["view"]["state"], "approved");
    // An empty command removes the name.
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"gem","command":"","args":[],"env":[]}}));
    assert!(!String::from_utf8_lossy(&core.file("agents.toml").unwrap()).contains("/opt/other"));
    // Removing revokes: the same content added back asks again.
    let back = core.ok(json!({"op":"acp_agent_add","entry":{"name":"gem","command":"/opt/other","args":[],"env":[]}}));
    assert_ne!(back["view"]["state"], "approved");
    // A Claude entry with an API key env name is allowed.
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"cl","command":"/opt/claude-acp","args":[],"env":["ANTHROPIC_API_KEY"]}}));
}

#[test]
fn acp_add_creates_the_file_0600_and_never_approves() {
    let core = Core::new("setup-new", "");
    assert!(core.file("agents.toml").is_none());
    core.ok(
        json!({"op":"acp_agent_add","entry":{"name":"a","command":"/opt/a","args":[],"env":[]}}),
    );
    assert_eq!(
        fs::metadata(core.home.join("agents.toml"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(core.status("a")["state"], "unapproved");
    assert!(core.file("approvals.json").is_none());
}

#[test]
fn acp_add_then_grant_hash_matches_shown() {
    let core = Core::new("setup-hash", "");
    let entry = core.fake("fake", &[], &["ACP_TEST_ALLOWED"]);
    let added = core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let hash = added["view"]["hash"].as_str().unwrap();
    assert_eq!(hash, core.status("fake")["hash"]);
    // A different hash fails and the state stays unapproved.
    let wrong = "0".repeat(64);
    assert!(
        core.err(json!({"op":"acp_agent_grant","name":"fake","hash":wrong}))
            .contains("changed")
    );
    assert_eq!(core.status("fake")["state"], "unapproved");
    let granted = core.ok(json!({"op":"acp_agent_grant","name":"fake","hash":hash}));
    assert_eq!(granted["view"]["state"], "approved");
}

// ---------------------------------------------------------------------------------------------------------------
// A5: the login tab

#[test]
fn acp_login_needs_approved_entry() {
    let core = Core::new("setup-login", "");
    let script = core.home.join("login.sh");
    let out = core.home.join("login.out");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"ran $# args\" > {}\nexec sleep 20\n",
            out.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let entry = json!({"name":"lg","command":script,"args":["--acp"],"env":[]});
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let login = json!({"op":"acp_agent_login","name":"lg","project":core.project});
    // Unapproved, then changed: refused.
    assert!(core.err(login.clone()).contains("approve the agent first"));
    core.approve("lg");
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("--acp", "--other"),
    )
    .unwrap();
    assert!(core.err(login.clone()).contains("approve the agent first"));
    assert!(!out.exists());
    fs::write(core.home.join("agents.toml"), &toml).unwrap();
    let before = (core.file("agents.toml"), core.file("approvals.json"));
    let reply = core.ok(login.clone());
    assert_eq!(reply["type"], "started", "{reply}");
    let session = &reply["session"];
    assert_eq!(session["kind"], "shell");
    assert_eq!(session["label"], "Login: lg");
    // The shell creates the file before echo fills it, so wait for content, not for the file.
    let until = Instant::now() + Duration::from_secs(60);
    let written = loop {
        let text = fs::read_to_string(&out).unwrap_or_default();
        if !text.is_empty() || Instant::now() >= until {
            break text;
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(written.trim(), "ran 0 args", "the login did not run");
    assert_eq!(
        (core.file("agents.toml"), core.file("approvals.json")),
        before
    );
}

// ---------------------------------------------------------------------------------------------------------------
// A6: problem cards of a failed ACP start

fn problem(session: &Value) -> Value {
    session["problem"].clone()
}

#[test]
fn acp_problem_cards() {
    let core = Core::new("setup-cards", "");
    // Not installed: approved, the command is gone.
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"gone","command":"/nonexistent/agent","args":[],"env":[]}}));
    core.approve("gone");
    let reply = core.start("gone");
    let session = reply["Ok"]["session"].clone();
    assert_eq!(session["state"], "failed", "{reply}");
    assert_eq!(problem(&session)["case"], "not_installed", "{reply}");
    assert_eq!(session["acp_agent"], "gone");
    // Signed out: the agent answers session/new with auth_required.
    core.ok(json!({"op":"acp_agent_add","entry":core.fake("out", &["auth"], &[])}));
    core.approve("out");
    let id = core.start("out")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let session = core.wait_state(&id, "failed");
    assert_eq!(problem(&session)["case"], "logged_out", "{session}");
    // No ACP answer: it speaks another version, or closes its output at once.
    core.ok(json!({"op":"acp_agent_add","entry":core.fake("v2", &["v2"], &[])}));
    core.approve("v2");
    let id = core.start("v2")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let session = core.wait_state(&id, "failed");
    assert_eq!(problem(&session)["case"], "acp_no_answer", "{session}");
    assert!(
        problem(&session)["details"]
            .as_str()
            .unwrap()
            .contains("version"),
        "{session}"
    );
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"mute","command":"/usr/bin/true","args":[],"env":[]}}));
    core.approve("mute");
    let id = core.start("mute")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let session = core.wait_state(&id, "failed");
    assert_eq!(problem(&session)["case"], "acp_no_answer", "{session}");
    // Claude without an API key: the refusal sentence, one line, no fix.
    fs::write(
        core.home.join("agents.toml"),
        fs::read_to_string(core.home.join("agents.toml")).unwrap()
            + "\n[[agent]]\nname = \"cl\"\ncommand = \"/opt/claude-acp\"\nargs = []\nenv = []\n",
    )
    .unwrap();
    // The reply stays V2-4a's refusal error; the failed row beside it carries the card.
    let before = core.sessions().len();
    let reply = core.start("cl");
    assert!(
        reply["Err"].as_str().unwrap().contains("ANTHROPIC_API_KEY"),
        "{reply}"
    );
    let sessions = core.sessions();
    assert_eq!(sessions.len(), before + 1);
    let session = sessions
        .iter()
        .find(|s| s["acp_agent"] == "cl")
        .unwrap()
        .clone();
    assert_eq!(session["state"], "failed", "{session}");
    assert_eq!(problem(&session)["case"], "acp_refused", "{session}");
    assert!(
        problem(&session)["cause"]
            .as_str()
            .unwrap()
            .contains("ANTHROPIC_API_KEY")
    );
    assert!(!problem(&session)["cause"].as_str().unwrap().contains('\n'));
}

#[test]
fn unapproved_acp_start_is_a_plain_error_with_no_card_and_no_row() {
    let core = Core::new("setup-sheet", "");
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"gone","command":"/nonexistent/agent","args":[],"env":[]}}));
    let before = core.sessions().len();
    // Never approved: a plain error (the window opens the sheet), no card, no session.
    let reply = core.start("gone");
    assert!(
        reply["Err"].as_str().unwrap().contains("not approved"),
        "{reply}"
    );
    // Approved, then changed: the same.
    core.approve("gone");
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("/nonexistent/agent", "/nonexistent/other"),
    )
    .unwrap();
    let reply = core.start("gone");
    assert!(
        reply["Err"].as_str().unwrap().contains("changed"),
        "{reply}"
    );
    assert_eq!(core.sessions().len(), before);
}

#[test]
fn non_owner_acp_failure_records_nothing() {
    let core = Core::new("setup-nonowner", "");
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"gone","command":"/nonexistent/agent","args":[],"env":[]}}));
    core.approve("gone");
    let token = core.session_token();
    let before = core.sessions().len();
    let reply = core.raw_as(
        &token,
        json!({"op":"start","session":{"kind":"acp","project":core.project,"args":["gone"],
        "model":null,"effort":null,"resume":null}}),
    );
    assert!(reply["Err"].is_string(), "{reply}");
    assert_eq!(
        core.sessions().len(),
        before,
        "a session caller's failed start was recorded"
    );
}

#[test]
fn core_refuses_unconfirmed_file_check() {
    let core = Core::new("setup-confirm", "");
    let entry = core.fake("filed", &[], &[]);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let check = |entry: &Value, confirmed: Option<bool>| {
        let mut request = json!({"op":"acp_agent_check","entry":entry});
        if let Some(c) = confirmed {
            request["confirmed"] = json!(c);
        }
        core.raw(request)
    };
    // In agents.toml and not approved: refused without the click, and nothing ran.
    let _ = fs::remove_file(&core.log);
    let refused = check(&entry, None);
    assert!(
        refused["Err"].as_str().unwrap().contains("Run check"),
        "{refused}"
    );
    assert!(check(&entry, Some(false))["Err"].is_string());
    assert!(!core.log.exists(), "an unconfirmed file entry was run");
    // Confirmed: runs.
    assert_eq!(check(&entry, Some(true))["Ok"]["signed_in"], true);
    // Approved as it stands: no click needed. Changed again: needs the click.
    core.approve("filed");
    assert_eq!(check(&entry, None)["Ok"]["signed_in"], true);
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("args = [", "args = [\"--swapped\", "),
    )
    .unwrap();
    let swapped = core.status("filed")["entry"].clone();
    assert_eq!(core.status("filed")["state"], "changed");
    let _ = fs::remove_file(&core.log);
    assert!(check(&swapped, None)["Err"].is_string());
    assert!(
        !core.log.exists(),
        "a changed file entry was run unconfirmed"
    );
    // An entry typed in the sheet (not in the file) keeps the automatic check.
    assert_eq!(
        check(&core.fake("typed", &[], &[]), None)["Ok"]["signed_in"],
        true
    );
}

fn check_request(core: &Core, entry: &Value, confirmed: Option<bool>) -> Value {
    let mut request = json!({"op":"acp_agent_check","entry":entry});
    if let Some(c) = confirmed {
        request["confirmed"] = json!(c);
    }
    core.raw(request)
}

#[test]
fn load_failure_is_not_absent_entry() {
    for broken_as_dir in [false, true] {
        let core = Core::new("setup-loadfail", "");
        let entry = core.fake("filed", &[], &[]);
        core.ok(json!({"op":"acp_agent_add","entry":entry}));
        let path = core.home.join("agents.toml");
        let good = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        if broken_as_dir {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, "[[agent\nname = ").unwrap();
        }
        let _ = fs::remove_file(&core.log);
        let refused = check_request(&core, &entry, None);
        let err = refused["Err"]
            .as_str()
            .unwrap_or_else(|| panic!("{refused}"));
        assert!(err.contains("agents.toml") && err.contains("fix"), "{err}");
        assert!(
            !core.log.exists(),
            "a check ran with agents.toml unloadable"
        );
        // Repaired: still in the file and not approved, so the click is needed; confirmed it runs.
        if broken_as_dir {
            fs::remove_dir(&path).unwrap();
        }
        fs::write(&path, good).unwrap();
        let refused = check_request(&core, &entry, None);
        assert!(
            refused["Err"].as_str().unwrap().contains("Run check"),
            "{refused}"
        );
        assert!(!core.log.exists());
        assert_eq!(
            check_request(&core, &entry, Some(true))["Ok"]["signed_in"],
            true
        );
    }
}

#[test]
fn typed_command_equal_to_file_entry_message() {
    let core = Core::new("setup-typed-equal", "");
    let entry = core.fake("filed", &[], &[]);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let _ = fs::remove_file(&core.log);
    let refused = check_request(&core, &entry, None);
    let err = refused["Err"]
        .as_str()
        .unwrap_or_else(|| panic!("{refused}"));
    assert!(
        err.contains("identical to one in agents.toml") && err.contains("Run check"),
        "{err}"
    );
    assert!(!core.log.exists());
    assert_eq!(
        check_request(&core, &core.fake("typed", &[], &[]), None)["Ok"]["signed_in"],
        true
    );
}

#[test]
fn running_acp_oversize_line_no_card() {
    let toml = "[[agent]]\nname = \"fake\"\n{fake}]\nenv = []\n";
    let core = Core::new("setup-oversize", toml);
    core.approve("fake");
    let id = core.start("fake")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&id)["model"].is_null() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    // After the handshake the agent sends a line over the limit: the session fails, with no "no answer" card.
    core.ok(json!({"op":"agent_prompt","id":id,"text":"longline"}));
    let session = core.wait_state(&id, "failed");
    assert!(session["problem"].is_null(), "{session}");
}

#[test]
fn acp_output_cannot_raise_card() {
    let toml = "[[agent]]\nname = \"fake\"\n{fake}]\nenv = []\n";
    let core = Core::new("setup-text", toml);
    core.approve("fake");
    let id = core.start("fake")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&id)["model"].is_null() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    core.ok(json!({"op":"agent_prompt","id":id,"text":"say:auth_required: Authentication required, No such file, not found"}));
    thread::sleep(Duration::from_millis(500));
    let session = core.session(&id);
    assert_eq!(session["state"], "running", "{session}");
    assert!(session["problem"].is_null(), "{session}");
}

// ---------------------------------------------------------------------------------------------------------------
// A8: hand off to a named ACP agent

#[test]
fn handoff_to_acp_starts_named_agent() {
    let core = Core::new("setup-hand", FAKE);
    // The session handed off from: a Claude session needs the claude binary, so a second ACP agent stands in.
    let from_toml = "\n[[agent]]\nname = \"other\"\ncommand = \"/usr/bin/python3\"\nargs = [\"FIXTURE\", \"LOG2\"]\nenv = []\n"
        .replace("FIXTURE", &fixture().display().to_string())
        .replace("LOG2", &core.home.join("other.log").display().to_string());
    fs::write(
        core.home.join("agents.toml"),
        fs::read_to_string(core.home.join("agents.toml")).unwrap() + &from_toml,
    )
    .unwrap();
    core.approve("other");
    let from = core.start("other")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let send = |acp_agent: Value| {
        let mut request = json!({"op":"handoff_send","from":from,"to":"acp","text":"carry on"});
        if !acp_agent.is_null() {
            request["acp_agent"] = acp_agent;
        }
        core.raw(request)
    };
    // Missing, empty, unknown and unapproved names are refused.
    for (what, name) in [
        ("missing", Value::Null),
        ("empty", json!("")),
        ("unknown", json!("nope")),
    ] {
        let reply = send(name);
        assert!(reply["Err"].is_string(), "{what}: {reply}");
    }
    assert!(
        send(json!("fake"))["Err"]
            .as_str()
            .unwrap()
            .contains("not approved")
    );
    // Approved: the named agent starts in the folder and gets the text.
    core.approve("fake");
    let reply = send(json!("fake"));
    assert_eq!(reply["Ok"]["session"]["acp_agent"], "fake", "{reply}");
    assert_eq!(reply["Ok"]["session"]["kind"], "acp");
    assert_eq!(
        reply["Ok"]["session"]["project"],
        reply["Ok"]["session"]["cwd"]
    );
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let log = fs::read_to_string(&core.log).unwrap_or_default();
        if log.contains("carry on") {
            break;
        }
        assert!(
            Instant::now() < until,
            "the agent never got the text: {log}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    // A name for another kind is refused.
    let reply = core
        .raw(json!({"op":"handoff_send","from":from,"to":"codex","text":"x","acp_agent":"fake"}));
    assert!(reply["Err"].is_string(), "{reply}");
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket 358: failed rows (diagnostics text, links) and the display name

fn acp_row(core: &Core, name: &str) -> Value {
    core.ok(json!({"op":"acp_agents"}))["acp"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .cloned()
        .unwrap_or_else(|| panic!("no row {name}"))
}

fn diagnostics(core: &Core, name: &str) -> String {
    acp_row(core, name)["diagnostics"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// `ACP_TEST_SECRET` holds this in the core's environment (`Core::with_path`).
const PLANTED: &str = "must-not-reach-the-agent";

#[test]
fn acp_diagnostics_carry_no_value() {
    let core = Core::new("setup-diag", "");
    let bin = core.project.join("bin");
    // The value in every place a careless text would pick it up: the argument and the version output.
    binary(&bin, "leaky", &format!("leaky 3.4.5 {PLANTED}"));
    let command = bin.join("leaky").display().to_string();
    let entry = json!({"name":"leaky","command":command,"args":[format!("--key={PLANTED}")],
        "env":["ACP_TEST_SECRET","NO_SUCH_VARIABLE"],"display":"shown name"});
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    core.approve("leaky");
    let text = diagnostics(&core, "leaky");
    for wanted in [
        "name: leaky",
        "state: approved",
        "failure: variable missing",
        "version: 3.4.5",
        "ACP_TEST_SECRET: set",
        "NO_SUCH_VARIABLE: unset",
    ] {
        assert!(text.contains(wanted), "{wanted}: {text}");
    }
    assert!(text.contains(&format!("path: {command}")), "{text}");
    for absent in [PLANTED, "--key", "shown name"] {
        assert!(!text.contains(absent), "{absent}: {text}");
    }
    // The command gone: the failure says so.
    fs::remove_file(bin.join("leaky")).unwrap();
    let text = diagnostics(&core, "leaky");
    assert!(text.contains("failure: command not found"), "{text}");
    assert!(!text.contains(PLANTED), "{text}");
}

#[test]
fn acp_links_come_from_the_bundled_table_only() {
    let core = Core::new("setup-links", FAKE);
    let gemini = acp_row(&core, "gemini");
    assert_eq!(gemini["docs_url"], "https://geminicli.com/docs/");
    assert_eq!(
        gemini["source_url"],
        "https://github.com/google-gemini/gemini-cli"
    );
    // A custom entry has no table row, so no link.
    let fake = acp_row(&core, "fake");
    assert!(fake["docs_url"].is_null() && fake["source_url"].is_null());
    // A settings file cannot supply one: the whole file is refused.
    let core = Core::new(
        "setup-linkf",
        "[[agent]]\nname = \"x\"\ncommand = \"/bin/x\"\ndocs_url = \"http://evil.example\"\n",
    );
    let refused = core.err(json!({"op":"acp_agents"}));
    assert!(refused.contains("docs_url"), "{refused}");
}

#[test]
fn acp_display_name_keeps_the_entry_approved() {
    let core = Core::new("setup-disp", "");
    let mut entry = core.fake("mine", &[], &[]);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let hash = core.approve("mine");
    // Trimmed and stored; the approval is untouched.
    entry["display"] = json!("  내 제미니  ");
    let view = core.ok(json!({"op":"acp_agent_add","entry":entry}))["view"].clone();
    assert_eq!(view["state"], "approved", "{view}");
    assert_eq!(view["hash"], hash.as_str());
    assert_eq!(view["entry"]["display"], "내 제미니");
    let row = acp_row(&core, "mine");
    assert_eq!(row["label"], "내 제미니");
    assert_eq!(row["display"], "내 제미니");
    assert_eq!(row["state"], "approved");
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    assert!(toml.contains("display = \"내 제미니\""), "{toml}");
    // It still launches on the same grant.
    let id = core.start("mine")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    core.wait_state(&id, "running");
    // The failed-start card of an entry with a display name uses that name.
    core.ok(
        json!({"op":"acp_agent_add","entry":{"name":"gone","command":"/nonexistent/agent",
        "args":[],"env":[],"display":"내 도구"}}),
    );
    core.approve("gone");
    assert_eq!(acp_row(&core, "gone")["label"], "내 도구");
    let session = core.start("gone")["Ok"]["session"].clone();
    assert_eq!(
        problem(&session)["cause"],
        "내 도구 is not installed.",
        "{session}"
    );
    // Empty removes it: back to the entry's own name, still approved.
    entry["display"] = json!("   ");
    let view = core.ok(json!({"op":"acp_agent_add","entry":entry}))["view"].clone();
    assert_eq!(view["state"], "approved", "{view}");
    assert_eq!(acp_row(&core, "mine")["label"], "mine");
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    assert!(!toml.contains("display = \"내 제미니\""), "{toml}");
    // A format character (a right-to-left override) is refused, as an account name's is.
    entry["display"] = json!("a\u{202e}b");
    assert!(core.raw(json!({"op":"acp_agent_add","entry":entry}))["Err"].is_string());
    // A display name does not turn a file entry into a typed one: the unconfirmed check is still refused.
    let mut filed = core.fake("filed", &[], &[]);
    filed["display"] = json!("Filed");
    core.ok(json!({"op":"acp_agent_add","entry":filed}));
    filed.as_object_mut().unwrap().remove("display");
    let refused = core.raw(json!({"op":"acp_agent_check","entry":filed}));
    assert!(
        refused["Err"].as_str().unwrap_or("").contains("Run check"),
        "{refused}"
    );
}

#[test]
fn acp_display_cannot_relabel_an_approved_entry() {
    let core = Core::new("setup-relab", "");
    let mut other = core.fake("other", &[], &[]);
    other["display"] = json!("다른 도구");
    core.ok(json!({"op":"acp_agent_add","entry":other}));
    core.approve("other");
    let mut entry = core.fake("mine", &[], &[]);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    core.approve("mine");
    let before = core.file("agents.toml").unwrap();
    // Through the owner's op: refused, and the file stays as it was.
    entry["display"] = json!("Gemini CLI");
    assert!(core.raw(json!({"op":"acp_agent_add","entry":entry}))["Err"].is_string());
    assert_eq!(core.file("agents.toml").unwrap(), before);
    // Written straight into the file, as an agent could: that row shows its real name, and nothing else is lost.
    let text = String::from_utf8(before).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        format!("{text}display = \"Claude Code\"\n"),
    )
    .unwrap();
    let row = acp_row(&core, "mine");
    assert_eq!(row["label"], "mine", "{row}");
    assert!(row["display"].is_null(), "{row}");
    assert_eq!(row["state"], "approved", "{row}");
    assert_eq!(acp_row(&core, "other")["label"], "다른 도구");
    let id = core.start("mine")["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    core.wait_state(&id, "running");
    // The stale label blocks no later write by the owner, the removal of that entry included.
    let third = core.fake("third", &[], &[]);
    core.ok(json!({"op":"acp_agent_add","entry":third}));
    core.ok(json!({"op":"acp_agent_add","entry":{"name":"mine","command":"","args":[],"env":[]}}));
    let toml = String::from_utf8(core.file("agents.toml").unwrap()).unwrap();
    assert!(!toml.contains("Claude Code"), "{toml}");
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket 358: sign-in by the methods the agent reports, its link, cancel and sign-out

fn signin_entry(core: &Core, name: &str, modes: &[&str]) -> Value {
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp/signin_agent.py");
    let mut args = vec![
        fixture.display().to_string(),
        core.home
            .join(format!("{name}.state"))
            .display()
            .to_string(),
    ];
    args.extend(modes.iter().map(|m| m.to_string()));
    json!({"name":name,"command":"/usr/bin/python3","args":args,"env":[]})
}
fn approved_signin(core: &Core, name: &str, modes: &[&str]) -> Value {
    let entry = signin_entry(core, name, modes);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    core.approve(name);
    entry
}
fn check_of(core: &Core, entry: &Value) -> Value {
    core.ok(json!({"op":"acp_agent_check","entry":entry}))
}
fn sign_in(core: &Core, name: &str, method: &str) -> Value {
    core.ok(json!({"op":"acp_agent_sign_in","name":name,"method":method,"project":core.project}))
}
/// Polls the attempt until `done` holds for its state.
fn sign_in_until(core: &Core, attempt: &str, done: impl Fn(&Value) -> bool) -> Value {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let state =
            core.ok(json!({"op":"acp_agent_sign_in_state","attempt":attempt}))["state"].clone();
        if done(&state) {
            return state;
        }
        assert!(Instant::now() < until, "sign-in stuck at {state}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn attempt_of(reply: &Value) -> String {
    assert_eq!(reply["type"], "acp_sign_in", "{reply}");
    reply["state"]["attempt"].as_str().unwrap().to_string()
}
fn ended(state: &Value) -> bool {
    !matches!(state["phase"].as_str(), Some("starting" | "waiting"))
}

#[test]
fn acp_check_reports_only_the_methods_it_can_offer() {
    let core = Core::new("signin-methods", "");
    // Threat 1: agent, terminal and env_var reported: env_var is never offered.
    let check = check_of(
        &core,
        &signin_entry(&core, "three", &["methods:agent,terminal,env"]),
    );
    let methods = check["auth_methods"].as_array().unwrap();
    let got: Vec<_> = methods
        .iter()
        .map(|m| (m["id"].as_str().unwrap(), m["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(got, [("oauth", "agent"), ("cli", "terminal")], "{check}");
    assert_eq!(check["can_logout"], false);
    assert!(
        !check.to_string().contains("--device"),
        "a terminal method's args reached the window: {check}"
    );
    let one = check_of(
        &core,
        &signin_entry(&core, "one", &["methods:agent", "logout"]),
    );
    assert_eq!(one["auth_methods"].as_array().unwrap().len(), 1, "{one}");
    assert_eq!(one["can_logout"], true);
    let none = check_of(&core, &signin_entry(&core, "none", &[]));
    assert_eq!(none["auth_methods"], json!([]), "{none}");
}

#[test]
fn acp_sign_in_needs_approval_and_a_reported_method() {
    let core = Core::new("signin-gate", "");
    let entry = signin_entry(&core, "sg", &["methods:agent,env"]);
    core.ok(json!({"op":"acp_agent_add","entry":entry}));
    let ask = |method: &str| json!({"op":"acp_agent_sign_in","name":"sg","method":method,"project":core.project});
    assert!(core.err(ask("oauth")).contains("approve the agent first"));
    core.approve("sg");
    assert!(
        core.err(ask("key")).contains("no longer reports"),
        "env_var was accepted"
    );
    assert!(core.err(ask("made-up")).contains("no longer reports"));
    assert!(!core.home.join("sg.state").exists());
}

#[test]
fn acp_sign_in_shows_the_link_and_cancel_ends_the_agent() {
    let core = Core::new("signin-cancel", "");
    approved_signin(
        &core,
        "sg",
        &[
            "methods:agent",
            "link:https://acme.example/login?x=1",
            "hold",
        ],
    );
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    let state = sign_in_until(&core, &attempt, |s| !s["link"].is_null());
    assert_eq!(state["link"], "https://acme.example/login?x=1");
    assert_eq!(state["phase"], "waiting");
    let log = fs::read_to_string(core.home.join("sg.state.log")).unwrap();
    assert!(log.contains("\"methodId\":\"oauth\""), "{log}");
    assert!(log.contains("\"action\":\"accept\""), "{log}");
    let pid: i32 = fs::read_to_string(core.home.join("sg.state.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(alive(pid));
    core.ok(json!({"op":"acp_agent_sign_in_cancel","attempt":attempt}));
    let state = sign_in_until(&core, &attempt, ended);
    assert_eq!(state["phase"], "cancelled", "{state}");
    let until = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < until, "the agent outlived the cancel");
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!core.home.join("sg.state").exists());
    assert_eq!(
        fs::read_dir(core.home.join("acp-check")).unwrap().count(),
        0,
        "the folder was left behind"
    );
}

#[test]
fn acp_sign_in_refuses_a_link_that_is_not_https() {
    let core = Core::new("signin-link", "");
    // Threat 2: declined, never shown.
    approved_signin(
        &core,
        "sg",
        &["methods:agent", "link:http://acme.example/login"],
    );
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    let state = sign_in_until(&core, &attempt, ended);
    assert!(state["link"].is_null(), "{state}");
    assert_eq!(state["phase"], "failed", "{state}");
    assert_eq!(state["reason"], "bad_link", "{state}");
    let log = fs::read_to_string(core.home.join("sg.state.log")).unwrap();
    assert!(log.contains("\"action\":\"decline\""), "{log}");
}

#[test]
fn acp_sign_in_then_sign_out_where_advertised() {
    let core = Core::new("signin-out", "");
    let entry = approved_signin(&core, "sg", &["methods:agent", "logout"]);
    assert_eq!(check_of(&core, &entry)["signed_in"], false);
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    let state = sign_in_until(&core, &attempt, ended);
    assert_eq!(state["phase"], "signed_in", "{state}");
    assert_eq!(check_of(&core, &entry)["signed_in"], true);
    assert_eq!(
        core.ok(json!({"op":"acp_agent_sign_out","name":"sg"}))["type"],
        "ack"
    );
    assert_eq!(check_of(&core, &entry)["signed_in"], false);
    // No logout advertised: refused, and the agent is never asked.
    let plain = approved_signin(&core, "pl", &["methods:agent"]);
    fs::write(core.home.join("pl.state"), "").unwrap();
    assert_eq!(check_of(&core, &plain)["can_logout"], false);
    assert!(
        core.err(json!({"op":"acp_agent_sign_out","name":"pl"}))
            .contains("does not offer")
    );
    assert!(core.home.join("pl.state").exists());
    let log = fs::read_to_string(core.home.join("pl.state.log")).unwrap();
    assert!(!log.contains("\"logout\""), "{log}");
}

#[test]
fn acp_terminal_method_opens_a_tab_with_its_own_args() {
    let core = Core::new("signin-term", "");
    approved_signin(&core, "sg", &["methods:agent,terminal"]);
    let reply = sign_in(&core, "sg", "cli");
    assert_eq!(reply["type"], "started", "{reply}");
    assert_eq!(reply["session"]["kind"], "shell");
    assert_eq!(reply["session"]["label"], "Login: sg");
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let argv = fs::read_to_string(core.home.join("sg.state.argv")).unwrap_or_default();
        if argv.ends_with("login --device") {
            assert!(
                argv.contains("methods:agent,terminal"),
                "the entry's own args were dropped: {argv}"
            );
            break;
        }
        assert!(
            Instant::now() < until,
            "the terminal method did not run with its args: {argv}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn pid_of(core: &Core, name: &str) -> i32 {
    fs::read_to_string(core.home.join(format!("{name}.state.pid")))
        .unwrap()
        .parse()
        .unwrap()
}
fn wait_gone(pid: i32, what: &str) {
    let until = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn acp_sign_in_waits_for_a_running_check() {
    let core = std::sync::Arc::new(Core::new("signin-slot", ""));
    approved_signin(&core, "sg", &["methods:agent"]);
    let entry = core.fake("fake", &["hang"], &[]);
    let holding = {
        let core = core.clone();
        thread::spawn(move || core.ok(json!({"op":"acp_agent_check","entry":entry})))
    };
    thread::sleep(Duration::from_millis(800));
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    assert_eq!(sign_in_until(&core, &attempt, ended)["phase"], "signed_in");
    holding.join().unwrap();
}

#[test]
fn acp_sign_in_times_out_and_ends_the_agent() {
    let core = Core::with_env("signin-time", &[("NUNCHIRO_SIGNIN_TIMEOUT_MS", "300")]);
    approved_signin(&core, "sg", &["methods:agent", "hold"]);
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    let state = sign_in_until(&core, &attempt, ended);
    assert_eq!(state["phase"], "failed", "{state}");
    assert_eq!(state["reason"], "timed_out", "{state}");
    wait_gone(pid_of(&core, "sg"), "the agent outlived the timeout");
}

#[test]
fn acp_sign_in_fails_when_the_agent_exits() {
    let core = Core::new("signin-exit", "");
    approved_signin(&core, "sg", &["methods:agent", "exit"]);
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    let state = sign_in_until(&core, &attempt, ended);
    assert_eq!(state["phase"], "failed", "{state}");
    assert_eq!(state["reason"], "exited", "{state}");
    assert!(state["link"].is_null(), "{state}");
}

#[test]
fn acp_sign_in_pressed_twice_keeps_one_attempt_and_the_check_names_it() {
    let core = Core::new("signin-twice", "");
    let entry = approved_signin(&core, "sg", &["methods:agent", "hold"]);
    let attempt = attempt_of(&sign_in(&core, "sg", "oauth"));
    sign_in_until(&core, &attempt, |s| s["phase"] == "waiting");
    let again =
        json!({"op":"acp_agent_sign_in","name":"sg","method":"oauth","project":core.project});
    assert!(core.err(again).contains("already signing in"));
    // A reloaded window finds the running attempt here.
    let live = check_of(&core, &entry)["sign_in"].clone();
    assert_eq!(live["attempt"], attempt.as_str(), "{live}");
    assert_eq!(live["method"], "oauth", "{live}");
    core.ok(json!({"op":"acp_agent_sign_in_cancel","attempt":attempt}));
    sign_in_until(&core, &attempt, ended);
    assert!(check_of(&core, &entry)["sign_in"].is_null());
}

#[test]
fn acp_stopping_core_ends_sign_in_and_sign_out() {
    let core = Core::new("signin-stop", "");
    approved_signin(&core, "si", &["methods:agent", "hold"]);
    approved_signin(&core, "so", &["methods:agent", "logout", "hold"]);
    let attempt = attempt_of(&sign_in(&core, "si", "oauth"));
    sign_in_until(&core, &attempt, |s| s["phase"] == "waiting");
    let signing_in = pid_of(&core, "si");
    // The sign-out holds its connection for as long as the agent does not answer.
    let token = fs::read_to_string(core.home.join("core.token")).unwrap();
    let mut held = UnixStream::connect(core.home.join("core.sock")).unwrap();
    let line = json!({"token": token, "request": {"op":"acp_agent_sign_out","name":"so"}})
        .to_string()
        + "\n";
    held.write_all(line.as_bytes()).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !core
        .file("so.state.log")
        .is_some_and(|log| String::from_utf8_lossy(&log).contains("\"logout\""))
    {
        assert!(
            Instant::now() < until,
            "the sign-out never reached the agent"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let signing_out = pid_of(&core, "so");
    core.raw(json!({"op":"stop"}));
    wait_gone(signing_in, "a sign-in outlived the core");
    wait_gone(signing_out, "a sign-out outlived the core");
}

// ---------------------------------------------------------------------------------------------------------------
// The test message: one real turn of an approved agent, confined as the check, on the owner's click only

fn approved_fake(core: &Core, name: &str, modes: &[&str]) {
    core.ok(json!({"op":"acp_agent_add","entry":core.fake(name, modes, &[])}));
    core.approve(name);
}
fn try_turn(core: &Core, name: &str) -> Value {
    let reply = core.ok(json!({"op":"acp_agent_try","name":name}));
    assert_eq!(reply["type"], "acp_turn", "{reply}");
    reply["turn"].clone()
}
fn info(core: &Core) -> Value {
    serde_json::from_slice(&core.file("agent.log.info").unwrap()).unwrap()
}
fn check_folders(core: &Core) -> usize {
    fs::read_dir(core.home.join("acp-check")).map_or(0, |d| d.count())
}

#[test]
fn acp_try_answers_in_the_check_folder_and_is_recorded() {
    let core = Core::new("try-ok", "");
    approved_fake(&core, "fake", &["info"]);
    let turn = try_turn(&core, "fake");
    assert_eq!(turn["sent"], true, "{turn}");
    assert_eq!(turn["answer_read"], true, "{turn}");
    assert_eq!(turn["turn_end"], true, "{turn}");
    // Control characters are gone and the text is trimmed.
    assert_eq!(turn["text"], "ready", "{turn}");
    assert!(turn["error"].is_null(), "{turn}");
    assert!(turn["at"].as_u64().unwrap() > 0, "{turn}");
    // It ran in a fresh folder under acp-check/, never a project, and that folder is gone.
    let cwd = info(&core)["cwd"].as_str().unwrap().to_string();
    assert!(cwd.contains("/acp-check/"), "{cwd}");
    assert!(!Path::new(&cwd).exists(), "{cwd}");
    wait_gone(info(&core)["pid"].as_i64().unwrap() as i32, "the agent outlived the try");
    // The prompt is the fixed text.
    let log = String::from_utf8(core.file("agent.log").unwrap()).unwrap();
    assert!(log.contains("Reply with the one word: ready."), "{log}");
    // The last result is stored and listed.
    let listed = core.ok(json!({"op":"acp_agents"}))["turns"]["fake"].clone();
    assert_eq!(listed["text"], "ready", "{listed}");
    assert!(core.file("agent-turns.json").is_some());
}

#[test]
fn acp_try_needs_approval() {
    let core = Core::new("try-unapproved", "");
    core.ok(json!({"op":"acp_agent_add","entry":core.fake("fake", &[], &[])}));
    assert!(core.err(json!({"op":"acp_agent_try","name":"fake"})).contains("approve the agent first"));
    assert!(core.file("agent.log").is_none(), "an unapproved agent ran");
}

#[test]
fn acp_try_no_answer_fails_at_the_cap_and_ends_the_agent() {
    let core = Core::with_env("try-silent", &[("NUNCHIRO_ACP_TRY_CAP_MS", "800")]);
    approved_fake(&core, "fake", &["info", "try-silent"]);
    let turn = try_turn(&core, "fake");
    assert_eq!(turn["sent"], true, "{turn}");
    assert_eq!(turn["answer_read"], false, "{turn}");
    assert_eq!(turn["turn_end"], false, "{turn}");
    assert!(turn["error"].as_str().unwrap().contains("No answer"), "{turn}");
    wait_gone(info(&core)["pid"].as_i64().unwrap() as i32, "the agent outlived the cap");
    assert_eq!(check_folders(&core), 0);
}

#[test]
fn acp_try_empty_answer_and_error_result_fail() {
    let core = Core::new("try-empty", "");
    approved_fake(&core, "empty", &["try-empty"]);
    let turn = try_turn(&core, "empty");
    assert_eq!(turn["turn_end"], true, "{turn}");
    assert_eq!(turn["answer_read"], false, "{turn}");
    assert!(turn["error"].is_string(), "{turn}");
    approved_fake(&core, "error", &["try-error"]);
    let turn = try_turn(&core, "error");
    assert_eq!(turn["sent"], true, "{turn}");
    assert_eq!(turn["turn_end"], false, "{turn}");
    assert!(turn["error"].as_str().unwrap().contains("quota exceeded"), "{turn}");
}

#[test]
fn acp_try_auth_required_is_a_sign_in_failure() {
    let core = Core::new("try-auth", "");
    approved_fake(&core, "fake", &["auth"]);
    let turn = try_turn(&core, "fake");
    assert_eq!(turn["sent"], false, "{turn}");
    assert!(turn["error"].as_str().unwrap().contains("sign"), "{turn}");
}

#[test]
fn acp_try_refuses_what_the_agent_asks() {
    let core = Core::new("try-ask", "");
    approved_fake(&core, "fake", &["try-ask"]);
    let turn = try_turn(&core, "fake");
    assert_eq!(turn["turn_end"], true, "{turn}");
    let log = String::from_utf8(core.file("agent.log").unwrap()).unwrap();
    let answer = log
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|m| m["id"].as_str().is_some_and(|id| id.starts_with("agent-")))
        .unwrap_or_else(|| panic!("no answer to the permission request: {log}"));
    assert_eq!(answer["result"]["outcome"]["optionId"], "no", "{answer}");
    assert_eq!(check_folders(&core), 0);
}

#[test]
fn acp_try_refused_for_a_full_token() {
    let core = Core::new("try-full", "");
    approved_fake(&core, "fake", &[]);
    let made = core.ok(json!({"op":"token_create","scope":"full"}));
    let reply = core.raw_as(made["secret"].as_str().unwrap(), json!({"op":"acp_agent_try","name":"fake"}));
    assert!(reply["Err"].is_string(), "{reply}");
    assert!(core.file("agent.log").is_none(), "a full token ran the agent");
}
