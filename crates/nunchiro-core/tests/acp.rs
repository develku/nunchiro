//! V2-4a: the ACP client in the core against a fake ACP v1 agent (`fixtures/acp/fake_agent.py`), through a real
//! `serve` over the owner socket. Tests compare tokens and never print them.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
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
    /// Extra environment for `serve` (round 2: a test HOME).
    env: Vec<(String, PathBuf)>,
    home: PathBuf,
    project: PathBuf,
    log: PathBuf,
    process: Option<Child>,
}
impl Core {
    /// A core whose `agents.toml` holds `toml` (`{fake}` is replaced by a fake agent entry's command and args).
    fn new(tag: &str, toml: &str) -> Self {
        Self::with_env(tag, toml, |_| vec![])
    }
    fn with_env(tag: &str, toml: &str, env: impl Fn(&Path) -> Vec<(String, PathBuf)>) -> Self {
        let home = home::short(tag);
        // The project is not inside the core's home: an ACP agent never reaches that (round 2).
        let project = home::short(&format!("{tag}p"));
        let env = env(&project);
        let log = home.join("agent.log");
        let fake = format!(
            "command = \"/usr/bin/python3\"\nargs = [{:?}, {:?}",
            fixture().display().to_string(),
            log.display().to_string()
        );
        // `{slow}`: the same fake behind a shim that holds each permission request back 3 s (see `SLOW_AGENT`).
        let slow = fake.replacen(
            "args = [",
            &format!(
                "args = [{:?}, ",
                home.join("slow_agent.py").display().to_string()
            ),
            1,
        ) + ", \"3\"";
        fs::write(home.join("slow_agent.py"), SLOW_AGENT).unwrap();
        fs::write(
            home.join("agents.toml"),
            toml.replace("{fake}", &fake).replace("{slow}", &slow),
        )
        .unwrap();
        let mut core = Self {
            home,
            project,
            log,
            process: None,
            env,
        };
        core.serve();
        core
    }
    fn serve(&mut self) {
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &self.home)
            .env("CLAUDE_CONFIG_DIR", self.home.join("claude-home"))
            .env("PATH", "/usr/bin:/bin")
            .env("ACP_TEST_ALLOWED", "yes")
            .env("ACP_TEST_SECRET", "must-not-reach-the-agent")
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
            .env("NUNCHIRO_SSH", "/usr/bin/false")
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(self.home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        self.process = Some(process);
        let until = Instant::now() + Duration::from_secs(30);
        while self.raw(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot" {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stop(&mut self) {
        let _ = self.raw(json!({"op":"stop"}));
        if let Some(mut process) = self.process.take() {
            let until = Instant::now() + Duration::from_secs(10);
            while process.try_wait().unwrap().is_none() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = process.kill();
            let _ = process.wait();
        }
    }
    fn raw(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        self.raw_as(&token, request)
    }
    fn raw_as(&self, token: &str, request: Value) -> Value {
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
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
    fn approve(&self, name: &str) -> String {
        let view = self.ok(json!({"op":"acp_agent_status","name":name}))["view"].clone();
        let hash = view["hash"].as_str().unwrap().to_string();
        self.ok(json!({"op":"acp_agent_grant","name":name,"hash":hash}));
        hash
    }
    fn start(&self, name: &str, resume: Option<&str>) -> Value {
        self.raw(
            json!({"op":"start","session":{"kind":"acp","project":self.project,"args":[name],
            "model":null,"effort":null,"resume":resume}}),
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
    fn prompt(&self, id: &str, text: &str) {
        self.ok(json!({"op":"agent_prompt","id":id,"text":text}));
    }
    /// The first pending item of `id` not in `seen`, and how long the test thread waited for it. The 30x test
    /// measures the product claim from the item's own `observed_at`, not from this figure.
    fn next_item(&self, id: &str, seen: &[String]) -> (Value, Duration) {
        self.next_item_within(id, seen, STALL)
    }
    fn next_item_within(&self, id: &str, seen: &[String], stall: Duration) -> (Value, Duration) {
        let began = Instant::now();
        let item = wait_until(&format!("a queue item for {id}"), stall, || {
            let session = self.session(id);
            let item = session["pending"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|i| !seen.contains(&i["id"].as_str().unwrap().to_string()))
                .cloned();
            // Progress: the agent log grew, the queue changed, or the chat moved.
            let mark = format!(
                "log {} / pending {} / chat {}",
                self.log_len(),
                session["pending"],
                self.chat(id).len()
            );
            (item, mark)
        });
        (item, began.elapsed())
    }
    fn log_len(&self) -> u64 {
        fs::metadata(&self.log).map_or(0, |m| m.len())
    }
    /// Responses the agent got from the client (lines with an id and no method), in order.
    fn responses(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m.get("method").is_none() && m.get("id").is_some())
            .collect()
    }
    fn logged(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m["method"] == method)
            .collect()
    }
    fn wait_responses(&self, count: usize) -> Vec<Value> {
        // Progress: the agent log grew (the core delivered something more).
        wait_until(&format!("{count} agent responses"), STALL, || {
            let responses = self.responses();
            let mark = format!("log {} / responses {}", self.log_len(), responses.len());
            ((responses.len() >= count).then_some(responses), mark)
        })
    }
    fn answer(&self, item: &Value, answer: &str) {
        // V2-8e: the window's allow of an ACP request (always risky) is the card's confirmed one.
        self.ok(json!({"op":"answer","item":item["id"],"answer":{"type":answer},"confirmed":true}));
    }
    /// The last agent text chunk the chat shows for `id`.
    fn chat(&self, id: &str) -> Vec<Value> {
        self.ok(json!({"op":"chat_page","id":id}))["page"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["data"].clone())
            .collect()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stop();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
            let _ = fs::remove_dir_all(&self.project);
        }
    }
}

/// How long a wait may see nothing move (agent log, queue, chat) before it gives up. Not a total budget: a wait that
/// keeps making progress under load is never cut off (V2.5-47).
const STALL: Duration = Duration::from_secs(20);

/// Polls `step` (its value when done, plus a mark of everything that can move) until it is done. Gives up only after
/// `stall` with an unchanged mark, naming what it waited for and the last mark; a hang with no progress still fails.
fn wait_until<T>(what: &str, stall: Duration, mut step: impl FnMut() -> (Option<T>, String)) -> T {
    let (mut last, mut moved) = (String::new(), Instant::now());
    loop {
        let (done, mark) = step();
        if let Some(done) = done {
            return done;
        }
        if mark != last {
            (last, moved) = (mark, Instant::now());
        }
        assert!(
            moved.elapsed() < stall,
            "no progress for {stall:?} waiting for {what}; last state: {last}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// A shim in front of the fake agent: it holds each `session/request_permission` back 3 s and sends one tool-call
/// update halfway, so the core shows progress before the late request.
const SLOW_AGENT: &str = r#"
import json, subprocess, sys, time
fixture, log, delay = sys.argv[1], sys.argv[2], float(sys.argv[3])
child = subprocess.Popen([sys.executable, fixture, log], stdout=subprocess.PIPE, text=True)
for line in child.stdout:
    if '"session/request_permission"' in line:
        time.sleep(delay / 2)
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": json.loads(line)["params"]["sessionId"],
            "update": {"sessionUpdate": "tool_call", "toolCallId": "slow", "title": "working"}}}) + "\n")
        sys.stdout.flush()
        time.sleep(delay / 2)
    sys.stdout.write(line)
    sys.stdout.flush()
"#;

/// Wall clock in ms, the unit of a queue item's `observed_at`.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// How long the core took to raise `item` after `sent` (the call that caused the request): the core's own
/// `observed_at`, so a starved test thread polling late does not count against the measurement.
fn reached(item: &Value, sent: u64) -> Duration {
    Duration::from_millis(item["observed_at"].as_u64().unwrap().saturating_sub(sent))
}

const FAKE: &str = "[[agent]]\nname = \"fake\"\n{fake}]\nenv = [\"ACP_TEST_ALLOWED\"]\n";

const SLOW: &str = "[[agent]]\nname = \"fake\"\n{slow}]\nenv = [\"ACP_TEST_ALLOWED\"]\n";

fn started(core: &Core) -> String {
    core.approve("fake");
    let reply = core.start("fake", None);
    reply["Ok"]["session"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("start: {reply}"))
        .to_string()
}

/// The permission answers the agent got: only allow_once / reject_once option ids or `cancelled`, never an always.
fn assert_once_only(responses: &[Value]) {
    for r in responses {
        let outcome = &r["result"]["outcome"];
        if outcome.is_object() {
            match outcome["outcome"].as_str() {
                Some("selected") => assert!(
                    matches!(outcome["optionId"].as_str(), Some("once" | "no")),
                    "{r}"
                ),
                Some("cancelled") => {}
                _ => panic!("unexpected outcome {r}"),
            }
        }
    }
}

#[test]
fn acp_requests_reach_queue_30x() {
    let core = Core::new("acpq", FAKE);
    let id = started(&core);
    let mut seen = vec![];
    let mut latencies = vec![];
    let mut answered = 0;
    for run in 0..30 {
        // A permission with no prompt in flight (the turn already ended).
        let sent = now_ms();
        core.prompt(&id, "later");
        let (item, _) = core.next_item(&id, &seen);
        latencies.push(reached(&item, sent));
        assert_eq!(item["kind"], "permission", "run {run}: {item}");
        seen.push(item["id"].as_str().unwrap().into());
        core.answer(&item, "allow_once");
        answered += 1;
        let last = core.wait_responses(answered).last().cloned().unwrap();
        assert_eq!(last["result"]["outcome"]["optionId"], "once", "run {run}");

        // An elicitation.
        let sent = now_ms();
        core.prompt(&id, "elicit");
        let (item, _) = core.next_item(&id, &seen);
        latencies.push(reached(&item, sent));
        seen.push(item["id"].as_str().unwrap().into());
        core.answer(&item, "deny");
        answered += 1;
        let last = core.wait_responses(answered).last().cloned().unwrap();
        assert_eq!(last["result"]["action"], "decline", "run {run}");

        // A request during cancel: the first one answers `cancelled`, the one the cancel raised reaches the queue.
        let sent = now_ms();
        core.prompt(&id, "cancel-me");
        let (first, _) = core.next_item(&id, &seen);
        latencies.push(reached(&first, sent));
        seen.push(first["id"].as_str().unwrap().into());
        let sent = now_ms();
        core.ok(json!({"op":"agent_keys","id":id,"keys":["esc"]}));
        answered += 1;
        let last = core.wait_responses(answered).last().cloned().unwrap();
        assert_eq!(
            last["result"]["outcome"]["outcome"], "cancelled",
            "run {run}"
        );
        let (during, _) = core.next_item(&id, &seen);
        latencies.push(reached(&during, sent));
        seen.push(during["id"].as_str().unwrap().into());
        core.answer(&during, "deny");
        answered += 1;
        let last = core.wait_responses(answered).last().cloned().unwrap();
        assert_eq!(last["result"]["outcome"]["optionId"], "no", "run {run}");
        assert_eq!(core.logged("session/cancel").len(), run + 1);
    }
    // Ticket 1114 (lead decision): keep a hard regression bound under build load; report ticket 16's 1 s target
    // separately. This interval includes socket dispatch and scheduling the fake agent as well as queue ingestion.
    latencies.sort_unstable();
    let median = latencies[latencies.len() / 2];
    let slowest = *latencies.last().unwrap();
    eprintln!("ACP queue latency: median {median:?}, slowest {slowest:?}; target median < 1s");
    assert!(slowest < Duration::from_secs(5), "slowest item {slowest:?}");
    assert_once_only(&core.responses());
}

/// The wait takes a 3 s late request that shows progress (a tool-call update at 1.5 s) although it is longer than the stall.
#[test]
fn acp_queue_wait_follows_progress() {
    let core = Core::new("acpp", SLOW);
    let id = started(&core);
    let stall = Duration::from_millis(2500);
    core.prompt(&id, "later");
    let (item, took) = core.next_item_within(&id, &[], stall);
    assert_eq!(item["kind"], "permission", "{item}");
    assert!(
        took > stall,
        "the request came after {took:?}: the test must outlast the stall"
    );
}

/// A silent agent (the turn ends, no request) fails the wait within the stall, saying what it waited for.
#[test]
fn acp_queue_wait_gives_up_without_progress() {
    let core = Core::new("acpg", FAKE);
    let id = started(&core);
    let stall = Duration::from_millis(1500);
    core.prompt(&id, "quiet");
    let began = Instant::now();
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        core.next_item_within(&id, &[], stall)
    }))
    .expect_err("a silent agent must fail the wait");
    let message = failed.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(
        message.contains("a queue item")
            && message.contains("no progress")
            && message.contains(&id),
        "{message}"
    );
    assert!(
        began.elapsed() < stall + Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
}

#[test]
fn acp_done_waits_for_open_requests_and_reads_config() {
    let core = Core::new("acpd", FAKE);
    let id = started(&core);
    core.prompt(&id, "say:hello from fake");
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&id)["attention"]["completion_seq"] != 1 {
        assert!(Instant::now() < until, "{}", core.session(&id));
        thread::sleep(Duration::from_millis(10));
    }
    let session = core.session(&id);
    assert_eq!(session["kind"], "acp");
    assert_eq!(session["acp_agent"], "fake");
    assert_eq!(session["model"], "fast");
    assert_eq!(session["effort"], "high");
    assert!(
        core.chat(&id).iter().any(|d| d["kind"] == "message"
            && d["role"] == "assistant"
            && d["text"] == "hello from fake"),
        "{:?}",
        core.chat(&id)
    );
    // `end_turn` with an open request is not done.
    core.prompt(&id, "later");
    let (item, _) = core.next_item(&id, &[]);
    assert_eq!(core.session(&id)["attention"]["waiting"], true);
    core.answer(&item, "deny");
    // Only allowed env names reach the agent.
    core.prompt(&id, "env");
    let until = Instant::now() + Duration::from_secs(10);
    let env = loop {
        if let Some(text) = core.chat(&id).iter().rev().find_map(|d| {
            d["text"]
                .as_str()
                .filter(|t| t.starts_with('['))
                .map(String::from)
        }) {
            break text;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    };
    assert!(env.contains("ACP_TEST_ALLOWED"), "{env}");
    for name in ["ACP_TEST_SECRET", "NUNCHIRO_SSH", "NUNCHIRO_HOME", "PATH"] {
        assert!(
            !env.contains(&format!("\"{name}\"")),
            "{name} leaked: {env}"
        );
    }
}

#[test]
fn acp_fs_confined() {
    let core = Core::new("acpf", FAKE);
    let id = started(&core);
    fs::write(core.project.join("inside.txt"), "inside text").unwrap();
    let outside = core.home.join("outside.txt");
    fs::write(&outside, "secret").unwrap();
    std::os::unix::fs::symlink(&outside, core.project.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&core.home, core.project.join("linkdir")).unwrap();
    fs::hard_link(&outside, core.project.join("hard.txt")).unwrap();
    let project = core.project.display().to_string();
    // Each prompt makes the agent send one fs request, so the client sends one response.
    let mut count = 0;
    let mut ask = |text: String| -> Value {
        core.prompt(&id, &text);
        count += 1;
        core.wait_responses(count).last().cloned().unwrap()
    };
    // Inside the root: read and write work.
    let read = ask(format!("read:{project}/inside.txt"));
    assert_eq!(read["result"]["content"], "inside text", "{read}");
    let wrote = ask(format!("write:{project}/new.txt"));
    assert!(wrote.get("error").is_none(), "{wrote}");
    assert_eq!(
        fs::read_to_string(core.project.join("new.txt")).unwrap(),
        "written by fake"
    );
    // Outside, `..`, a relative path and through symlinks out: refused, nothing read or written.
    for path in [
        outside.display().to_string(),
        format!("{project}/../outside.txt"),
        "inside.txt".into(),
        format!("{project}/link.txt"),
        format!("{project}/linkdir/outside.txt"),
        "/etc/hosts".into(),
    ] {
        let read = ask(format!("read:{path}"));
        assert!(read["error"].is_object(), "read {path}: {read}");
        assert!(!read.to_string().contains("secret"));
        let wrote = ask(format!("write:{path}"));
        assert!(wrote["error"].is_object(), "write {path}: {wrote}");
    }
    // A hard link to a file outside: never written (nor truncated).
    let wrote = ask(format!("write:{project}/hard.txt"));
    assert!(wrote["error"].is_object(), "write hard link: {wrote}");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    assert!(!core.home.join("outside.txt.tmp").exists());
    // Terminals run in a core PTY in the session root.
    core.prompt(&id, "term");
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let output = core
            .responses()
            .iter()
            .find_map(|r| r["result"]["output"].as_str().map(String::from));
        if let Some(output) = output {
            assert!(output.contains("hi from pty"), "{output}");
            break;
        }
        assert!(Instant::now() < until, "{:?}", core.responses());
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn acp_unapproved_entry_no_launch() {
    let core = Core::new("acpu", FAKE);
    // Never approved.
    let reply = core.start("fake", None);
    assert!(
        reply["Err"].as_str().unwrap().contains("not approved"),
        "{reply}"
    );
    // Approved, then edited (a session agent rewrites the command): refused until approved again.
    let hash = core.approve("fake");
    let toml = fs::read_to_string(core.home.join("agents.toml")).unwrap();
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("/usr/bin/python3", "/bin/sh"),
    )
    .unwrap();
    let reply = core.start("fake", None);
    assert!(
        reply["Err"].as_str().unwrap().contains("changed"),
        "{reply}"
    );
    // An allowed env name added is a change too.
    fs::write(
        core.home.join("agents.toml"),
        toml.replace(
            "\"ACP_TEST_ALLOWED\"",
            "\"ACP_TEST_ALLOWED\", \"ACP_TEST_SECRET\"",
        ),
    )
    .unwrap();
    let reply = core.start("fake", None);
    assert!(
        reply["Err"].as_str().unwrap().contains("changed"),
        "{reply}"
    );
    // A grant quoting the old hash is refused.
    let reply = core.raw(json!({"op":"acp_agent_grant","name":"fake","hash":hash}));
    assert!(reply["Err"].is_string(), "{reply}");
    assert!(!core.log.exists(), "the agent was launched");
    // Restored and approved as it is now: launches.
    fs::write(core.home.join("agents.toml"), &toml).unwrap();
    assert!(core.start("fake", None)["Ok"].is_object());
    // A value for an env name, or an unknown key, is refused as a whole file.
    fs::write(
        core.home.join("agents.toml"),
        toml.replace("env = [", "secret = \"x\"\nenv = ["),
    )
    .unwrap();
    assert!(core.raw(json!({"op":"acp_agent_status","name":"fake"}))["Err"].is_string());
}

#[test]
fn acp_claude_needs_api_key_env() {
    let claude = |env: &str| {
        format!(
            "[[agent]]\nname = \"claude-acp\"\ncommand = \"/usr/local/bin/claude-agent-acp\"\nargs = []\nenv = [{env}]\n[[agent]]\nname = \"wrap\"\ncommand = \"/usr/bin/npx\"\nargs = [\"@agentclientprotocol/claude-agent-acp\"]\nenv = [{env}]\n"
        )
    };
    for (env, ok) in [
        ("", false),
        ("\"HOME\"", false),
        ("\"CLAUDE_CODE_USE_BEDROCK\"", false),
        ("\"CLAUDE_CODE_USE_VERTEX\"", false),
        ("\"ANTHROPIC_API_KEY\"", true),
        ("\"CLAUDE_CODE_USE_BEDROCK\", \"AWS_PROFILE\"", true),
        ("\"CLAUDE_CODE_USE_BEDROCK\", \"AWS_ACCESS_KEY_ID\"", true),
        (
            "\"CLAUDE_CODE_USE_VERTEX\", \"ANTHROPIC_VERTEX_PROJECT_ID\"",
            true,
        ),
    ] {
        let core = Core::new("acpc", &claude(env));
        for name in ["claude-acp", "wrap"] {
            let view = core.ok(json!({"op":"acp_agent_status","name":name}))["view"].clone();
            let grant = core.raw(json!({"op":"acp_agent_grant","name":name,"hash":view["hash"]}));
            let start = core.start(name, None);
            if ok {
                assert!(view["refused"].is_null(), "{env}: {view}");
                assert!(grant["Ok"].is_object(), "{env}: {grant}");
                // Accepted: it gets past the refusal and fails only because the command does not exist here.
                assert!(
                    !start.to_string().contains("ANTHROPIC_API_KEY"),
                    "{env}: {start}"
                );
            } else {
                assert!(
                    view["refused"]
                        .as_str()
                        .unwrap()
                        .contains("ANTHROPIC_API_KEY"),
                    "{env}: {view}"
                );
                assert!(grant["Err"].is_string(), "{env}: {grant}");
                assert!(
                    start["Err"].as_str().unwrap().contains("ANTHROPIC_API_KEY"),
                    "{env}: {start}"
                );
            }
        }
    }
}

#[test]
fn acp_entry_with_claude_only_in_a_folder_name_is_allowed() {
    let toml = "[[agent]]\nname = \"notes\"\ncommand = \"/usr/bin/python3\"\nargs = [\"/Users/x/claude-notes/fake_agent.py\", \"--cwd\", \"/Users/x/claude-notes/\"]\nenv = []\n";
    let core = Core::new("acpn", toml);
    let view = core.ok(json!({"op":"acp_agent_status","name":"notes"}))["view"].clone();
    assert!(view["refused"].is_null(), "{view}");
    let grant = core.raw(json!({"op":"acp_agent_grant","name":"notes","hash":view["hash"]}));
    assert!(grant["Ok"].is_object(), "{grant}");
}

#[test]
fn acp_restore_stopped_resumable() {
    for load in [true, false] {
        let toml = if load {
            FAKE.replace("{fake}", "{fake}, \"load\"")
        } else {
            FAKE.into()
        };
        let mut core = Core::new("acpr", &toml);
        let id = started(&core);
        core.prompt(&id, "say:before restart");
        let until = Instant::now() + Duration::from_secs(10);
        while core.session(&id)["attention"]["completion_seq"] != 1 {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        let agent_session = core.session(&id)["agent_session_id"].clone();
        core.stop();
        core.serve();
        let session = core.session(&id);
        assert_eq!(session["pid"], Value::Null);
        if !load {
            assert_eq!(session["state"], "exited", "{session}");
            assert_eq!(session["agent_session_id"], Value::Null);
            continue;
        }
        assert_eq!(session["state"], "resumable", "{session}");
        assert_eq!(session["agent_session_id"], agent_session);
        let resumed = core.start("fake", agent_session.as_str());
        let new = resumed["Ok"]["session"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("{resumed}"))
            .to_string();
        let until = Instant::now() + Duration::from_secs(10);
        while core.logged("session/load").is_empty() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            core.logged("session/load")[0]["params"]["sessionId"],
            agent_session
        );
        let until = Instant::now() + Duration::from_secs(10);
        while !core.chat(&new).iter().any(|d| d["text"] == "replayed") {
            assert!(Instant::now() < until, "{:?}", core.chat(&new));
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn acp_v2_only_agent_is_refused() {
    let core = Core::new("acpv", &FAKE.replace("{fake}", "{fake}, \"v2\""));
    let id = started(&core);
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&id)["state"] == "running" {
        assert!(Instant::now() < until, "{}", core.session(&id));
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(core.session(&id)["state"], "failed");
    assert!(core.logged("session/new").is_empty());
}

// Round 2 (review MUSTs and promoted SHOULDs).

/// The agent's answer to each prompt that sends one request: the client's response to it.
fn asker(core: &Core, id: &str) -> impl FnMut(String) -> Value {
    let mut count = core.responses().len();
    move |text: String| {
        core.prompt(id, &text);
        count += 1;
        core.wait_responses(count).last().cloned().unwrap()
    }
}
fn wait_completion(core: &Core, id: &str, seq: u64) {
    let until = Instant::now() + Duration::from_secs(20);
    while core.session(id)["attention"]["completion_seq"].as_u64() < Some(seq) {
        assert!(Instant::now() < until, "{}", core.session(id));
        thread::sleep(Duration::from_millis(10));
    }
}
/// Every chat event the core still holds for `id`, oldest first, and the page's `skipped`.
fn whole_chat(core: &Core, id: &str) -> (Vec<Value>, u64) {
    let (mut events, mut after, mut skipped) = (vec![], 0u64, 0);
    loop {
        let page = core.ok(json!({"op":"chat_page","id":id,"after":after}))["page"].clone();
        skipped = page["skipped"].as_u64().unwrap_or(skipped);
        let got = page["events"].as_array().cloned().unwrap_or_default();
        if got.is_empty() {
            return (events, skipped);
        }
        after = got.last().unwrap()["cursor"].as_u64().unwrap();
        events.extend(got);
    }
}
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}
fn gone(path: &Path) {
    let until = Instant::now() + Duration::from_secs(10);
    let pid = loop {
        if let Some(pid) = fs::read_to_string(path)
            .ok()
            .and_then(|p| p.trim().parse::<i32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < until, "no pid in {}", path.display());
        thread::sleep(Duration::from_millis(10));
    };
    let until = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        if Instant::now() > until {
            unsafe { libc::kill(pid, libc::SIGKILL) };
            panic!("process {pid} outlived its group's end");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn acp_feed_bytes_are_capped() {
    let core = Core::new("acpb", FAKE);
    let id = started(&core);
    // 400 events of ~60 KB (24 MB) through one session.
    core.prompt(&id, "flood:400:60000");
    wait_completion(&core, &id, 1);
    let (events, skipped) = whole_chat(&core, &id);
    let bytes: usize = events.iter().map(|e| e["data"].to_string().len()).sum();
    assert!(skipped > 0, "nothing dropped");
    assert!(bytes <= 8 * 1024 * 1024, "{bytes} bytes held");
    assert!(
        events
            .iter()
            .all(|e| e["data"].to_string().len() <= 64 * 1024)
    );
    // The newest are kept: the turn's end is the last event, and cursors run on.
    assert_eq!(events.last().unwrap()["data"]["state"], "completed");
    assert!(events[0]["cursor"].as_u64().unwrap() > skipped);
    // The session still works.
    core.prompt(&id, "say:after the flood");
    wait_completion(&core, &id, 2);
}

#[test]
fn acp_large_tool_output_is_truncated() {
    let core = Core::new("acpt", FAKE);
    let id = started(&core);
    core.prompt(&id, "bigout");
    wait_completion(&core, &id, 1);
    let result = core
        .chat(&id)
        .into_iter()
        .find(|d| d["kind"] == "tool_result")
        .unwrap();
    assert_eq!(result["truncated"], true, "{}", &result.to_string()[..200]);
    assert!(result.to_string().len() <= 64 * 1024);
    assert!(result["output"].as_str().unwrap().starts_with("yyyy"));
}

/// Core threads, from the process table.
fn threads(pid: u32) -> usize {
    let out = Command::new("/bin/ps")
        .args(["-M", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .count()
        .saturating_sub(1)
}

#[test]
fn acp_many_wait_for_exit_requests_use_bounded_threads() {
    let core = Core::new("acpw", FAKE);
    let id = started(&core);
    let pid = core.process.as_ref().unwrap().id();
    let before = threads(pid);
    let answers = core.home.join("waits.json");
    core.prompt(&id, &format!("waits:200:{}", answers.display()));
    let sent = answers.with_extension("json.sent");
    let until = Instant::now() + Duration::from_secs(10);
    while !sent.exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(100));
    let during = threads(pid);
    assert!(during <= before + 16, "threads {before} -> {during}");
    wait_completion(&core, &id, 1);
    let answers: Vec<Value> = serde_json::from_str(&fs::read_to_string(&answers).unwrap()).unwrap();
    let exits = answers.iter().filter(|a| *a == "exit").count();
    let refused = answers.iter().filter(|a| **a == -32000).count();
    assert_eq!((exits, refused), (64, 136), "{answers:?}");
}

/// A shell session's own token (it writes it where the test reads it).
fn session_token(core: &Core) -> String {
    let path = core.home.join("session.token");
    let script = format!(
        "printf %s \"$NUNCHIRO_TOKEN\" > {}; exec sleep 60",
        path.display()
    );
    let r = core.raw(
        json!({"op":"start","session":{"kind":"shell","project":core.project,
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

#[test]
fn acp_elicitation_answer_from_session_refused_when_answers_off() {
    let core = Core::new("acpe", FAKE);
    let id = started(&core);
    let token = session_token(&core);
    core.prompt(&id, "elicit");
    let (item, _) = core.next_item(&id, &[]);
    let r = core.raw_as(
        &token,
        json!({"op":"answer","item":item["id"],"answer":{"type":"allow_once"}}),
    );
    assert!(
        r["Err"]
            .as_str()
            .unwrap_or_default()
            .contains("permission_answers_disabled"),
        "{r}"
    );
    assert!(
        core.responses().is_empty(),
        "the agent got an answer: {:?}",
        core.responses()
    );
    // Deny stays a session's to give; the owner may allow.
    let r = core.raw_as(
        &token,
        json!({"op":"answer","item":item["id"],"answer":{"type":"deny"}}),
    );
    assert!(r["Ok"].is_object(), "{r}");
    assert_eq!(core.wait_responses(1)[0]["result"]["action"], "decline");
}

#[test]
fn acp_process_groups_end_after_their_leader() {
    let core = Core::new("acpg", FAKE);
    let id = started(&core);
    // A terminal whose shell exited, leaving a child that ignores SIGHUP: release ends it.
    let left = core.home.join("term.pid");
    core.prompt(&id, &format!("term-orphan:{}", left.display()));
    wait_completion(&core, &id, 1);
    gone(&left);
    // The agent exits leaving a child behind: the session's end takes the child too.
    let orphan = core.home.join("agent.pid");
    core.prompt(&id, &format!("orphan:{}", orphan.display()));
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&id)["state"] == "running" {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    }
    gone(&orphan);
}

#[test]
fn acp_forged_response_does_not_end_the_turn() {
    let core = Core::new("acpo", FAKE);
    let id = started(&core);
    // The agent holds the turn open until the gate file exists, so no load can end it early.
    let gate = core.home.join("forge.gate");
    core.prompt(&id, &format!("forge:{}", gate.display()));
    // The core logs each forged answer it drops; three of them mean it has handled all three.
    let until = Instant::now() + Duration::from_secs(20);
    while fs::read_to_string(core.home.join("core.log"))
        .unwrap_or_default()
        .matches("ignored a response to no request in flight")
        .count()
        < 3
    {
        assert!(Instant::now() < until, "forged answers never handled");
        thread::sleep(Duration::from_millis(10));
    }
    let session = core.session(&id);
    assert_eq!(session["attention"]["working"], true, "{session}");
    assert_eq!(session["attention"]["completion_seq"], 0);
    fs::write(&gate, "").unwrap();
    wait_completion(&core, &id, 1);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(core.session(&id)["attention"]["completion_seq"], 1);
}

#[test]
fn acp_hostile_agent_input() {
    let core = Core::new("acph", FAKE);
    let id = started(&core);
    core.prompt(&id, "hostile");
    wait_completion(&core, &id, 1);
    let responses = core.wait_responses(2);
    let by = |rid: &str| responses.iter().find(|r| r["id"] == rid).cloned().unwrap();
    assert_eq!(by("h-1")["error"]["code"], -32601);
    assert!(by("h-2")["error"].is_object());
    let session = core.session(&id);
    assert_eq!(session["state"], "running");
    assert!(
        session["pending"].as_array().unwrap().is_empty(),
        "{session}"
    );
    // An ACP start names no account.
    let r = core.raw(
        json!({"op":"start","session":{"kind":"acp","project":core.project,"args":["fake"],
        "model":null,"effort":null,"resume":null,"account":"work"}}),
    );
    assert!(
        r["Err"].as_str().unwrap_or_default().contains("account"),
        "{r}"
    );
    // A 17 MiB line ends the session as failed.
    core.prompt(&id, "longline");
    let until = Instant::now() + Duration::from_secs(20);
    while core.session(&id)["state"] == "running" {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(core.session(&id)["state"], "failed");
}

#[test]
fn acp_fs_refuses_agent_config_and_core_home() {
    // HOME inside the project, holding agent config; the core's home is a second root.
    let core = Core::with_env("acpk", FAKE, |project| {
        vec![("HOME".into(), project.join("u"))]
    });
    let user = core.project.join("u");
    for dir in [".claude", ".codex", "work"] {
        fs::create_dir_all(user.join(dir)).unwrap();
        fs::write(user.join(dir).join("f.txt"), "config").unwrap();
    }
    core.approve("fake");
    // HOME itself is never a root.
    let r = core.raw(
        json!({"op":"start","session":{"kind":"acp","project":user,"args":["fake"],
        "model":null,"effort":null,"resume":null}}),
    );
    assert!(
        r["Err"]
            .as_str()
            .unwrap_or_default()
            .contains("home folder"),
        "{r}"
    );
    let id = core.start("fake", None)["Ok"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut ask = asker(&core, &id);
    let u = user.display().to_string();
    let ok = ask(format!("read:{u}/work/f.txt"));
    assert_eq!(ok["result"]["content"], "config", "{ok}");
    for dir in [".claude", ".codex"] {
        let read = ask(format!("read:{u}/{dir}/f.txt"));
        assert!(read["error"].is_object(), "{read}");
        let wrote = ask(format!("write:{u}/{dir}/f.txt"));
        assert!(wrote["error"].is_object(), "{wrote}");
        assert_eq!(
            fs::read_to_string(user.join(dir).join("f.txt")).unwrap(),
            "config"
        );
    }
    // The core's home as the root: its token and files stay out of reach.
    let r = core.raw(
        json!({"op":"start","session":{"kind":"acp","project":core.home,"args":["fake"],
        "model":null,"effort":null,"resume":null}}),
    );
    let id = r["Ok"]["session"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{r}"))
        .to_string();
    let mut ask = asker(&core, &id);
    let h = core.home.display().to_string();
    for file in ["core.token", "agents.toml", "approvals.json"] {
        let read = ask(format!("read:{h}/{file}"));
        assert!(read["error"].is_object(), "{file}: {read}");
    }
    let wrote = ask(format!("write:{h}/agents.toml"));
    assert!(wrote["error"].is_object(), "{wrote}");
}

/// Round 3: an agent that exits right after a burst (a child keeping its stdout open, so no EOF) still has every event
/// applied, its turn's end included, before the session ends.
#[test]
fn acp_final_turn_end_survives_exit() {
    let core = Core::new("acpx", FAKE);
    let id = started(&core);
    let left = core.home.join("burst.pid");
    core.prompt(&id, &format!("exit-burst:{}", left.display()));
    let until = Instant::now() + Duration::from_secs(20);
    while core.session(&id)["state"] == "running" {
        assert!(Instant::now() < until, "{}", core.session(&id));
        thread::sleep(Duration::from_millis(10));
    }
    let session = core.session(&id);
    assert_eq!(session["state"], "exited", "{session}");
    assert_eq!(
        session["attention"]["completion_seq"], 1,
        "the turn's end was lost: {session}"
    );
    gone(&left);
}

#[test]
fn acp_exit_drain_total_cap() {
    // V2-4b A7: an exited agent whose child keeps sending updates never goes quiet; the drain still ends at 2 s.
    let toml = "[[agent]]\nname = \"fake\"\n{fake}, \"child-writes\"]\nenv = []\n";
    let core = Core::new("acp-drain-cap", toml);
    let id = started(&core);
    let began = Instant::now();
    core.prompt(&id, "go");
    let ended = loop {
        if core.session(&id)["state"] != "running" {
            break began.elapsed();
        }
        assert!(
            began.elapsed() < Duration::from_secs(8),
            "the session never ended: {}",
            core.session(&id)
        );
        thread::sleep(Duration::from_millis(20));
    };
    assert!(ended < Duration::from_secs(3), "ended after {ended:?}");
}

/// Ticket 358: the agent's row as the window reads it.
fn row(core: &Core, name: &str) -> Value {
    core.ok(json!({"op":"acp_agents"}))["acp"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .cloned()
        .unwrap()
}
fn model_of(core: &Core, id: &str, want: &str) {
    wait_until(&format!("model {want}"), STALL, || {
        let model = core.session(id)["model"].clone();
        ((model == want).then_some(()), format!("model {model}"))
    });
}

/// Ticket 358 threats 1 and 2: a pick reaches the agent as `session/set_config_option`, only with a value the agent
/// reported, and the list outlives the core.
#[test]
fn acp_model_choice_sends_set_config_option() {
    let mut core = Core::new("acpm", FAKE);
    let id = started(&core);
    model_of(&core, &id, "fast");
    let models = json!([{"value":"fast","label":"Fast"},{"value":"smart","label":"Smart"}]);
    assert_eq!(row(&core, "fake")["models"], models);

    let pick =
        |model: &str| core.raw(json!({"op":"switch_model","id":id,"model":model,"effort":null}));
    assert_eq!(
        pick("not-listed")["Err"],
        "this agent did not report that model"
    );
    assert!(core.logged("session/set_config_option").is_empty());

    assert!(pick("smart")["Ok"].is_object());
    model_of(&core, &id, "smart");
    let sent = core.logged("session/set_config_option");
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["params"]["configId"], "model");
    assert_eq!(sent[0]["params"]["value"], "smart");
    assert!(
        sent[0]["params"]["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("fake-")
    );

    // Picking what it already runs sends nothing; a turn in flight refuses the switch.
    assert!(pick("smart")["Ok"].is_object());
    assert_eq!(core.logged("session/set_config_option").len(), 1);
    core.prompt(&id, "cancel-me");
    let refused = pick("fast");
    assert!(
        refused["Err"].as_str().unwrap().contains("idle"),
        "{refused}"
    );
    assert_eq!(core.logged("session/set_config_option").len(), 1);

    core.stop();
    core.serve();
    assert_eq!(row(&core, "fake")["models"], models);
}

/// Ticket 358: the agent's refusal leaves the model as it was and says so in the chat.
#[test]
fn acp_model_refused_by_the_agent_is_said_in_the_chat() {
    let core = Core::new(
        "acpr",
        "[[agent]]\nname = \"fake\"\n{fake}, \"set-fails\"]\nenv = []\n",
    );
    let id = started(&core);
    model_of(&core, &id, "fast");
    core.ok(json!({"op":"switch_model","id":id,"model":"smart","effort":null}));
    let said = wait_until("the refusal in the chat", STALL, || {
        let chat = core.chat(&id);
        let found = chat
            .iter()
            .find(|d| d["text"] == "Model change failed: model unavailable")
            .cloned();
        (found, format!("chat {}", chat.len()))
    });
    assert_eq!(said["role"], "assistant");
    assert_eq!(core.session(&id)["model"], "fast");
}

/// Ticket 358: an agent that reports no model option has no list, and nothing can be sent to it.
#[test]
fn acp_agent_reporting_no_models_has_none_to_pick() {
    let core = Core::new(
        "acpn",
        "[[agent]]\nname = \"fake\"\n{fake}, \"nomodels\"]\nenv = []\n",
    );
    let id = started(&core);
    wait_until("the session ready", STALL, || {
        let effort = core.session(&id)["effort"].clone();
        ((effort == "high").then_some(()), format!("effort {effort}"))
    });
    assert_eq!(row(&core, "fake")["models"], json!([]));
    let reply = core.raw(json!({"op":"switch_model","id":id,"model":"fast","effort":null}));
    assert_eq!(reply["Err"], "this agent reports no models");
    assert!(core.logged("session/set_config_option").is_empty());
}

/// Ticket 358, whole bundle: a session calling the socket directly is refused every op the eight lanes added.
#[test]
fn bundle_358_ops_are_refused_to_a_session() {
    let core = Core::new("acpo", FAKE);
    let token = session_token(&core);
    for request in [
        json!({"op":"account_rename","agent":"claude","id":"a","label":"b"}),
        json!({"op":"agent_update_start","tool":"claude"}),
        json!({"op":"agent_update_cancel","tool":"claude"}),
        json!({"op":"agent_update_state"}),
        json!({"op":"acp_agent_sign_in","name":"fake","method":"m"}),
        json!({"op":"acp_agent_sign_in_state","attempt":"x"}),
        json!({"op":"acp_agent_sign_in_cancel","attempt":"x"}),
        json!({"op":"acp_agent_sign_out","name":"fake"}),
        json!({"op":"agent_command_status","agent":"claude"}),
        json!({"op":"agent_command_check","agent":"claude","path":"/bin/echo"}),
        json!({"op":"agent_command_grant","agent":"claude","hash":"00"}),
        json!({"op":"agent_command_reset","agent":"claude"}),
        json!({"op":"switch_model","id":"x","model":"fast","effort":null}),
    ] {
        let reply = core.raw_as(&token, request.clone());
        assert_eq!(
            reply["Err"], "operation not granted",
            "{request} -> {reply}"
        );
    }
}
