// Ticket 573 slice 3: `nunchiro mcp` and outside-caller tokens end to end through a real core, with a shell running
// `cat` as the fake agent. The MCP tools give the CLI's results and the CLI's refusals; each token scope is held.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    /// Round 4: the project folder, outside the data folder (a token's start refuses one inside it).
    project: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("ctl");
        let core = Self::serve(&home);
        let h = Self {
            home,
            project: home::short("ctp"),
            core,
        };
        h.wait_up();
        h
    }
    /// Ticket 1083: the user's home of this harness's core, beside (never inside) its Nunchiro home, so a token may use
    /// the default worktrees folder there.
    fn user_home(home: &std::path::Path) -> std::path::PathBuf {
        let mut name = home.file_name().unwrap().to_os_string();
        name.push("-user");
        home.with_file_name(name)
    }
    fn serve(home: &std::path::Path) -> Child {
        std::fs::create_dir_all(Self::user_home(home)).unwrap();
        home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("serve")
            .env("HOME", Self::user_home(home))
            .env("NUNCHIRO_HOME", home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", home)
            .env_remove("NUNCHIRO_TOKEN")
            // The fake `claude` a token starts (a token may not start a shell).
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            )
            .spawn()
            .unwrap()
    }
    fn wait_up(&self) {
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join("core.token").exists()
            || UnixStream::connect(self.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// Round 6: `serve restart`: the core exits, the agents keep running in their holders, a new core reattaches.
    fn restart(&mut self) {
        let _ = self.call(&self.owner_token(), json!({"op":"exit"}));
        let until = Instant::now() + Duration::from_secs(10);
        while self.core.try_wait().unwrap().is_none() {
            assert!(Instant::now() < until, "core never exited");
            thread::sleep(Duration::from_millis(20));
        }
        self.core = Self::serve(&self.home);
        self.wait_up(); // the old core removed core.token on its way out
        let until = Instant::now() + Duration::from_secs(30);
        while self
            .call(&self.owner_token(), json!({"op":"list"}))
            .is_err()
        {
            assert!(Instant::now() < until, "the new core never answered");
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn owner_token(&self) -> String {
        fs::read_to_string(self.home.join("core.token")).unwrap()
    }
    fn call(&self, token: &str, request: Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn command(&self, token: &str, args: &[&str]) -> Command {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env("NUNCHIRO_TOKEN", token)
            .current_dir(&self.project);
        c
    }
    fn cli(&self, token: &str, args: &[&str]) -> Output {
        self.command(token, args).output().unwrap()
    }
    fn ok(&self, token: &str, args: &[&str]) -> String {
        let out = self.cli(token, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    /// The CLI's refusal message, without the `nunchiro: ` prefix.
    fn refused(&self, token: &str, args: &[&str]) -> String {
        let out = self.cli(token, args);
        assert_eq!(out.status.code(), Some(1), "{args:?} was not refused");
        String::from_utf8_lossy(&out.stderr)
            .trim()
            .trim_start_matches("nunchiro: ")
            .to_string()
    }
    fn token(&self, scope: &str) -> String {
        self.ok(&self.owner_token(), &["token", "create", "--scope", scope])
            .trim()
            .to_string()
    }
    /// A fake agent: a shell that prints READY and echoes what it is sent.
    fn start(&self, token: &str, name: &str) -> String {
        let home = self.project.to_str().unwrap();
        let out = self.ok(
            token,
            &[
                "agent",
                "start",
                name,
                "--kind",
                "shell",
                "--project",
                home,
                "--",
                "/bin/sh",
                "-c",
                "echo READY; exec cat",
            ],
        );
        let reply: Value = serde_json::from_str(&out).unwrap();
        reply["session"]["id"].as_str().unwrap().to_string()
    }
    /// A fake Claude (`tests/fixtures/agent-cli/claude`), started with no launch arguments.
    fn agent(&self, token: &str, name: &str) -> String {
        let home = self.project.to_str().unwrap();
        let out = self.ok(
            token,
            &[
                "agent",
                "start",
                name,
                "--kind",
                "claude",
                "--project",
                home,
            ],
        );
        let reply: Value = serde_json::from_str(&out).unwrap();
        reply["session"]["id"].as_str().unwrap().to_string()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        // Never a second panic here: it would abort and leave the core running.
        if let Ok(owner) = fs::read_to_string(self.home.join("core.token")) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.call(&owner, json!({"op":"stop"}))
            }));
        }
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
        let _ = fs::remove_dir_all(&self.project);
    }
}

struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}
impl Mcp {
    fn new(h: &Harness, token: &str) -> Self {
        let mut child = h
            .command(token, &["mcp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let (stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let mut mcp = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next: 0,
        };
        let init = mcp.request(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}),
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "nunchiro");
        writeln!(
            mcp.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        mcp
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":self.next,"method":method,"params":params})
        )
        .unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], self.next, "{reply}");
        reply
    }
    fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))["result"].clone()
    }
}
impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill(); // our own child, by handle
        let _ = self.child.wait();
    }
}

#[test]
fn mcp_tools_are_the_cli_verbs() {
    let h = Harness::new();
    let owner = h.owner_token();
    let mut mcp = Mcp::new(&h, &owner);
    let tools = mcp.request("tools/list", json!({}));
    let names: Vec<_> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for want in [
        "agent_start",
        "agent_read",
        "agent_wait",
        "room_send",
        "worktree_create",
    ] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
    let home = h.project.to_str().unwrap();
    let started = mcp.tool(
        "agent_start",
        json!({"name": "fake", "project": home, "kind": "shell", "args": ["/bin/sh", "-c", "echo READY; exec cat"]}),
    );
    assert_eq!(started["isError"], false, "{started}");
    let id = started["structuredContent"]["result"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let read = mcp.tool("agent_read", json!({"agent": "fake"}));
        assert_eq!(read["isError"], false, "{read}");
        if read["structuredContent"]["result"]["text"]
            .as_str()
            .is_some_and(|t| t.contains("READY"))
        {
            break;
        }
        assert!(Instant::now() < until, "no READY: {read}");
        thread::sleep(Duration::from_millis(100));
    }
    let sent = mcp.tool(
        "room_send",
        json!({"body": "hello", "to": "person", "project": home}),
    );
    assert_eq!(sent["isError"], false, "{sent}");
    let message = &sent["structuredContent"]["result"];
    assert_eq!(
        (message["body"].as_str(), message["to"].as_str()),
        (Some("hello"), Some("person"))
    );
    // A refusal is the CLI's, word for word.
    let mcp_refusal = mcp.tool("agent_read", json!({"agent": "nobody"}));
    assert_eq!(mcp_refusal["isError"], true);
    assert_eq!(
        mcp_refusal["structuredContent"]["error"].as_str().unwrap(),
        h.refused(&owner, &["agent", "read", "nobody"])
    );
    // So is a token's: a read token cannot start, through either surface.
    let read = h.token("read");
    let mut limited = Mcp::new(&h, &read);
    let refusal = limited.tool(
        "agent_start",
        json!({"name": "x", "project": home, "kind": "shell", "args": ["cat"]}),
    );
    let cli = h.refused(
        &read,
        &[
            "agent",
            "start",
            "x",
            "--kind",
            "shell",
            "--project",
            home,
            "--",
            "cat",
        ],
    );
    assert_eq!(refusal["structuredContent"]["error"].as_str().unwrap(), cli);
    assert!(cli.contains("read token"), "{cli}");
    // The read token still reads.
    let listed = limited.tool("agent_get", json!({"agent": id}));
    assert_eq!(listed["isError"], false, "{listed}");
    // Exit 2 is a result to act on, not an error; and a call that waits holds up no other request (its own thread).
    let ask = json!({"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"room_ask",
        "arguments":{"body": "anyone?", "to": "person", "project": home, "wait": true, "timeout_s": 2}}});
    writeln!(mcp.stdin, "{ask}").unwrap();
    writeln!(
        mcp.stdin,
        "{}",
        json!({"jsonrpc":"2.0","id":101,"method":"ping"})
    )
    .unwrap();
    let mut line = String::new();
    mcp.stdout.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["id"],
        101,
        "ping waited behind the ask"
    );
    line.clear();
    mcp.stdout.read_line(&mut line).unwrap();
    let asked: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(asked["id"], 100);
    let asked = &asked["result"];
    assert_eq!(
        (
            asked["isError"].as_bool(),
            asked["structuredContent"]["needs_answer"].as_bool()
        ),
        (Some(false), Some(true)),
        "{asked}"
    );
}

#[test]
fn token_scopes_hold() {
    let h = Harness::new();
    let owner = h.owner_token();
    let home = h.project.to_str().unwrap();
    // Create: the secret is printed once and only its hash is stored.
    let read = h.token("read");
    let stored = fs::read_to_string(h.home.join("tokens.json")).unwrap();
    assert!(!stored.contains(&read));
    let listed: Value = serde_json::from_str(&h.ok(&owner, &["token", "list", "--json"])).unwrap();
    assert_eq!(listed[0]["scope"], "read");
    assert!(listed[0].get("hash").is_none(), "{listed}");
    // Read: lists and reads, never starts.
    let theirs = h.start(&owner, "theirs");
    h.ok(&read, &["agent", "list", "--json"]);
    h.ok(&read, &["agent", "get", "theirs", "--json"]);
    assert!(
        h.refused(
            &read,
            &[
                "agent",
                "start",
                "x",
                "--kind",
                "shell",
                "--project",
                home,
                "--",
                "cat"
            ]
        )
        .contains("not granted")
    );
    assert!(
        h.refused(
            &read,
            &["agent", "send", "--to", "person", "--project", home, "hi"]
        )
        .contains("not granted")
    );
    // Supervised: starts and stops its own sessions, never another's.
    let supervised = h.token("supervised");
    let mine = h.agent(&supervised, "mine");
    let mine_list: Value =
        serde_json::from_str(&h.ok(&supervised, &["agent", "list", "--json", "--mine"])).unwrap();
    assert_eq!(mine_list.as_array().unwrap().len(), 1, "{mine_list}");
    assert!(
        h.refused(&supervised, &["session", "close", &theirs])
            .contains("sessions it started")
    );
    h.ok(
        &supervised,
        &["agent", "send", "--to", "person", "--project", home, "hi"],
    );
    assert!(
        h.refused(&supervised, &["worktree", "create", "--project", home])
            .contains("not granted")
    );
    h.ok(&supervised, &["session", "close", &mine]);
    // No scope answers a permission or a dialog, types keys, or changes a setting.
    let full = h.token("full");
    for token in [&read, &supervised, &full] {
        assert!(
            h.refused(token, &["session", "send-keys", &theirs, "enter"])
                .contains("not granted")
        );
        assert!(
            h.refused(token, &["permission-answers", "on", "--project", home])
                .contains("not granted")
        );
        let answer = h.call(
            token,
            json!({"op":"answer","item":"x","answer":{"type":"allow_once"}}),
        );
        assert!(answer.unwrap_err().contains("not granted"));
        // Tokens are the owner's to make.
        assert!(h.refused(token, &["token", "list"]).contains("not granted"));
    }
    // Revoke: the next call is unauthorized.
    let id = listed[0]["id"].as_str().unwrap();
    h.ok(&owner, &["token", "revoke", id]);
    assert_eq!(
        h.refused(&read, &["agent", "list", "--json"]),
        "unauthorized"
    );
    // A project token reaches only its project.
    let other = h.home.join("other");
    fs::create_dir_all(&other).unwrap();
    let scoped = h
        .ok(
            &owner,
            &[
                "token",
                "create",
                "--scope",
                "full",
                "--project",
                other.to_str().unwrap(),
            ],
        )
        .trim()
        .to_string();
    let seen: Value = serde_json::from_str(&h.ok(&scoped, &["agent", "list", "--json"])).unwrap();
    assert_eq!(
        seen,
        json!([]),
        "a project token saw another project's session"
    );
    assert!(
        h.refused(&scoped, &["agent", "read", &theirs])
            .contains("not found")
    );
    assert_eq!(
        h.call(&scoped, json!({"op":"agent_get","id":theirs}))
            .unwrap_err(),
        "outside the token's project"
    );
}

// Round 2 (both reviews, MUST 1): a token never runs a command line. The reviewers' reproduction started a shell that
// copied core.token, then read it from the screen; it must fail at its first call for every scope that can start.
#[test]
fn tokens_never_reach_a_shell() {
    let h = Harness::new();
    let owner = h.owner_token();
    let home = h.project.to_str().unwrap();
    h.start(&owner, "owners-shell");
    let leak = h.home.join("owner-token-copy");
    let copy = format!(
        "cp '{}' '{}'; exec cat",
        h.home.join("core.token").display(),
        leak.display()
    );
    let (supervised, full) = (h.token("supervised"), h.token("full"));
    let scoped = h
        .ok(
            &owner,
            &[
                "token",
                "create",
                "--scope",
                "supervised",
                "--project",
                home,
            ],
        )
        .trim()
        .to_string();
    for token in [&supervised, &full, &scoped] {
        let raw = h.call(
            token,
            json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c",copy]}}),
        );
        assert!(
            raw.as_ref().is_err_and(|e| e.contains("not granted")),
            "{raw:?}"
        );
        assert!(
            h.refused(
                token,
                &[
                    "agent",
                    "start",
                    "s",
                    "--kind",
                    "shell",
                    "--project",
                    home,
                    "--",
                    "/bin/sh",
                    "-c",
                    &copy
                ]
            )
            .contains("not granted")
        );
        // Typing into the owner's shell session, through every typing verb.
        for verb in ["send", "prompt"] {
            let refusal = h.refused(token, &["agent", verb, "owners-shell", "cat core.token"]);
            assert!(refusal.contains("shell"), "{verb}: {refusal}");
        }
        // A token's agent takes no launch arguments: no print mode, no settings file.
        for args in [&["-p", "hi"][..], &["--settings", "/tmp/s.json"][..]] {
            let mut argv = vec![
                "agent",
                "start",
                "p",
                "--kind",
                "claude",
                "--project",
                home,
                "--",
            ];
            argv.extend(args);
            assert!(
                h.refused(token, &argv).contains("launch arguments"),
                "{args:?}"
            );
        }
    }
    let mut mcp = Mcp::new(&h, &full);
    let refusal = mcp.tool(
        "agent_start",
        json!({"name": "m", "project": home, "kind": "shell", "args": ["/bin/sh", "-c", copy]}),
    );
    assert_eq!(refusal["isError"], true, "{refusal}");
    thread::sleep(Duration::from_millis(500));
    assert!(!leak.exists(), "a token copied the owner token");
    // A token's own agent: text that the agent runs as a command (`!`) or a slash command never reaches it.
    h.agent(&full, "fa");
    for text in ["!cat core.token", "  /permissions"] {
        assert!(
            h.refused(&full, &["agent", "prompt", "fa", text])
                .contains("command"),
            "{text}"
        );
    }
}

// Round 2 (security SHOULD 3): a supervised token types into and prompts only the sessions it started.
#[test]
fn supervised_types_only_into_its_own_sessions() {
    let h = Harness::new();
    let owner = h.owner_token();
    h.agent(&owner, "theirs");
    let supervised = h.token("supervised");
    h.agent(&supervised, "mine");
    assert!(
        h.refused(&supervised, &["agent", "send", "theirs", "hello"])
            .contains("sessions it started")
    );
    assert!(
        h.refused(&supervised, &["agent", "prompt", "theirs", "hello"])
            .contains("sessions it started")
    );
    h.ok(&supervised, &["agent", "send", "mine", "hello"]);
    // Round 3: a full token too; the owner's agents run without the token's folder deny.
    let full = h.token("full");
    for verb in ["send", "prompt"] {
        assert!(
            h.refused(&full, &["agent", verb, "theirs", "print core.token"])
                .contains("sessions it started")
        );
    }
    h.agent(&full, "full-own");
    h.ok(&full, &["agent", "send", "full-own", "hello"]);
}

// Round 2 (review SHOULD 2, security NOTE 4): a room body or positional word is never read as an option.
#[test]
fn room_bodies_are_never_options() {
    let h = Harness::new();
    let owner = h.owner_token();
    let home = h.project.to_str().unwrap();
    let supervised = h.token("supervised");
    let sent: Value = serde_json::from_str(&h.ok(
        &supervised,
        &[
            "agent",
            "send",
            "--to",
            "person",
            "--project",
            home,
            "--",
            "--to x",
        ],
    ))
    .unwrap();
    assert_eq!(
        (sent["body"].as_str(), sent["to"].as_str()),
        (Some("--to x"), Some("person"))
    );
    let leading: Value = serde_json::from_str(&h.ok(
        &supervised,
        &[
            "agent",
            "ask",
            "--to",
            "person",
            "--project",
            home,
            "--",
            "--help",
        ],
    ))
    .unwrap();
    assert_eq!(leading["body"], "--help");
    let mut mcp = Mcp::new(&h, &owner);
    let reply = mcp.tool(
        "room_reply",
        json!({"message": leading["id"], "body": "--thread", "project": home}),
    );
    assert_eq!(reply["isError"], false, "{reply}");
    let message = &reply["structuredContent"]["result"];
    assert_eq!(
        (message["body"].as_str(), message["to"].as_str()),
        (Some("--thread"), sent["from"].as_str())
    );
    let send = mcp.tool(
        "room_send",
        json!({"body": "--to x", "to": "person", "project": home}),
    );
    assert_eq!(
        send["structuredContent"]["result"]["body"], "--to x",
        "{send}"
    );
    let thread = mcp.tool(
        "room_thread_read",
        json!({"thread": leading["thread"], "project": home}),
    );
    assert_eq!(thread["isError"], false, "{thread}");
}

/// Round 3: polls the owner's event log until `id` shows, so a token's view is compared with a full log.
fn owner_saw(h: &Harness, since: &Value, id: &str) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let r = h
            .call(&h.owner_token(), json!({"op":"events","since":since}))
            .unwrap();
        if r["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["session"] == id)
        {
            return;
        }
        assert!(Instant::now() < until, "owner never saw {id}: {r}");
        thread::sleep(Duration::from_millis(50));
    }
}

// Round 3 item 1 (code SHOULD 3): every scope reads `events`; a project token sees its project's only, never another's.
#[test]
fn tokens_read_events_of_their_project_only() {
    let h = Harness::new();
    let owner = h.owner_token();
    let other = h.home.join("other");
    fs::create_dir(&other).unwrap();
    let since = h.call(&owner, json!({"op":"events"})).unwrap()["latest"].clone();
    let here = h.agent(&owner, "here");
    let there = h
        .call(
            &owner,
            json!({"op":"start","session":{"kind":"claude","project":other,"label":"there"}}),
        )
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    owner_saw(&h, &since, &here);
    owner_saw(&h, &since, &there);
    let ids = |token: &str, project: Option<&PathBuf>| {
        let mut request = json!({"op":"events","since":since});
        if let Some(p) = project {
            request["project"] = json!(p);
        }
        let r = h.call(token, request).unwrap();
        r["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["session"].as_str().map(String::from))
            .collect::<Vec<_>>()
    };
    for scope in ["read", "supervised", "full"] {
        let all = ids(&h.token(scope), None);
        assert!(
            all.contains(&here) && all.contains(&there),
            "{scope}: {all:?}"
        );
    }
    let home = h.project.to_str().unwrap();
    let scoped = h
        .ok(
            &owner,
            &["token", "create", "--scope", "read", "--project", home],
        )
        .trim()
        .to_string();
    let seen = ids(&scoped, None);
    assert!(seen.contains(&here), "{seen:?}");
    assert!(
        !seen.contains(&there),
        "a project token saw another project: {seen:?}"
    );
    assert!(
        ids(&scoped, Some(&other)).is_empty(),
        "naming the other project"
    );
    // The CLI verb a script uses: a stream until the reader goes away, so it is read for 2 s and stopped.
    let mut stream = h
        .command(&scoped, &["events", "--since", &since.to_string()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_secs(2));
    stream.kill().unwrap();
    let out = String::from_utf8_lossy(&stream.wait_with_output().unwrap().stdout).into_owned();
    assert!(out.contains(&here) && !out.contains(&there), "{out}");
}

// Ticket 573: room messages join the event stream, scoped like the room: the owner sees every project's, a token made
// for a project sees that project's room only, and a token for another project sees none of it.
#[test]
fn room_events_follow_the_rooms_scope() {
    let h = Harness::new();
    let owner = h.owner_token();
    let a = h.project.to_str().unwrap();
    let b_dir = h.home.join("other");
    fs::create_dir(&b_dir).unwrap();
    let b = b_dir.to_str().unwrap();
    let since = h.call(&owner, json!({"op":"events"})).unwrap()["latest"].clone();
    let supervised = h.token("supervised");
    for (project, body) in [(a, "alpha-note"), (b, "beta-note")] {
        h.ok(
            &supervised,
            &[
                "agent",
                "send",
                "--to",
                "person",
                "--project",
                project,
                body,
            ],
        );
    }
    let scoped = |project: &str| {
        h.ok(
            &owner,
            &["token", "create", "--scope", "read", "--project", project],
        )
        .trim()
        .to_string()
    };
    // (project, body) of each room event a token sees.
    let rooms = |token: &str| -> Vec<(String, String)> {
        let r = h.call(token, json!({"op":"events","since":since})).unwrap();
        r["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "room_message")
            .map(|e| {
                // The core stamps the sender and the kind; the body is data.
                assert!(e["data"]["from"].as_str().unwrap().starts_with("token-"));
                assert_eq!(
                    (e["data"]["created_by"].as_str(), e["data"]["kind"].as_str()),
                    (Some("agent"), Some("message"))
                );
                assert_eq!(e["data"]["to"], "person");
                assert!(e["data"]["id"].is_string() && e["data"]["thread"].is_string());
                (
                    e["project"].as_str().unwrap().to_string(),
                    e["data"]["body"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    let bodies = |seen: &[(String, String)]| seen.iter().map(|s| s.1.clone()).collect::<Vec<_>>();
    // The owner, and a token for every project, see both rooms.
    assert_eq!(bodies(&rooms(&owner)), ["alpha-note", "beta-note"]);
    assert_eq!(
        bodies(&rooms(&h.token("read"))),
        ["alpha-note", "beta-note"]
    );
    // A read token for project A sees A's messages and never B's, and the other way round.
    let same = rooms(&scoped(a));
    assert_eq!(bodies(&same), ["alpha-note"], "{same:?}");
    let other = rooms(&scoped(b));
    assert_eq!(bodies(&other), ["beta-note"], "{other:?}");
    // The owner narrows with --project; a token cannot widen its scope by naming the other project.
    let r = h
        .call(&scoped(a), json!({"op":"events","since":since,"project":b}))
        .unwrap();
    assert_eq!(r["events"], json!([]), "{r}");
}

// Round 3 item 2: the whole room (`RoomRead`) is the person's view; no token reads it. A token's start receipt is its own.
#[test]
fn tokens_never_read_the_whole_room_and_own_their_receipts() {
    let h = Harness::new();
    let home = h.project.to_str().unwrap();
    let supervised = h.token("supervised");
    h.ok(
        &supervised,
        &[
            "agent",
            "send",
            "--to",
            "person",
            "--project",
            home,
            "hello",
        ],
    );
    assert!(
        h.call(&h.owner_token(), json!({"op":"room_read","project":home}))
            .is_ok()
    );
    for scope in ["read", "supervised", "full"] {
        let refused = h
            .call(&h.token(scope), json!({"op":"room_read","project":home}))
            .unwrap_err();
        assert!(refused.contains("not granted"), "{scope}: {refused}");
    }
    let start = |token: &str| -> Value {
        serde_json::from_str(&h.ok(
            token,
            &[
                "agent",
                "start",
                "r",
                "--kind",
                "claude",
                "--project",
                home,
                "--receipt",
                "same",
            ],
        ))
        .unwrap()
    };
    let first = start(&supervised);
    let again = start(&supervised);
    assert_eq!(
        again["session"]["id"], first["session"]["id"],
        "a retry starts again"
    );
    let other = start(&h.token("supervised"));
    assert_ne!(
        other["session"]["id"], first["session"]["id"],
        "another token's receipt"
    );
    assert_ne!(
        start(&h.owner_token())["session"]["id"],
        first["session"]["id"]
    );
}

// Round 3 item 3: an agent a token starts never reads the Nunchiro folder, even when the user's settings auto-allow
// reads: its Claude settings deny Read and Edit there and run Bash in a sandbox that cannot leave. Codex has no such
// setting, so a token starts no Codex. The owner token on a screen reaches a token as [redacted].
#[test]
fn a_tokens_agent_is_kept_out_of_the_nunchiro_folder() {
    let h = Harness::new();
    let owner = h.owner_token();
    let home = h.project.to_str().unwrap();
    let full = h.token("full");
    let settings = |id: &str| -> Value {
        serde_json::from_slice(&fs::read(h.home.join(format!("hooks-{id}.json"))).unwrap()).unwrap()
    };
    let canonical = fs::canonicalize(&h.home).unwrap();
    for token in [&full, &h.token("supervised")] {
        let s = settings(&h.agent(token, "kept"));
        let deny = s["permissions"]["deny"].as_array().unwrap();
        for dir in [&h.home, &canonical] {
            for tool in ["Read", "Edit"] {
                let rule = format!("{tool}(/{}/**)", dir.display());
                assert!(deny.contains(&json!(rule)), "{rule} missing: {s}");
            }
        }
        assert_eq!(
            s["sandbox"],
            json!({"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,
                "autoAllowBashIfSandboxed":false})
        );
        assert!(s["hooks"].is_object(), "the hooks stay: {s}");
    }
    // The owner's own agent keeps the user's settings.
    let s = settings(&h.agent(&owner, "owners"));
    assert!(s.get("sandbox").is_none(), "{s}");
    assert!(!s.to_string().contains(&format!("Read(/{home}")), "{s}");
    // Codex, and a shell through `worktree open`, are refused.
    let codex = h.refused(
        &full,
        &["agent", "start", "c", "--kind", "codex", "--project", home],
    );
    assert!(codex.contains("only Claude"), "{codex}");
    let open = h
        .call(
            &full,
            json!({"op":"worktree","operation":"open","project":h.home,"path":h.home.join("w"),
                "branch":null,"base":"","label":""}),
        )
        .unwrap_err();
    assert!(open.contains("no shell"), "{open}");
    // A token types into no agent that has ended (ticket 286 leaves a shell on its screen).
    let ended = h.agent(&full, "ended");
    // The session pid is the wrapper; stopping its child (the fake Claude) leaves the wrapper's shell running.
    let agent = agent_pid(&h, &ended);
    assert!(Command::new("kill").arg(&agent).status().unwrap().success());
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let out = h.cli(&full, &["agent", "send", &ended, "cat core.token"]);
        if out.status.code() == Some(1) {
            assert!(
                String::from_utf8_lossy(&out.stderr).contains("shell"),
                "{out:?}"
            );
            let state = h
                .call(&owner, json!({"op":"agent_get","id":ended}))
                .unwrap();
            assert_eq!(
                state["session"]["state"], "running",
                "the shell is still there: {state}"
            );
            break;
        }
        assert!(Instant::now() < until, "an ended agent took a token's text");
        thread::sleep(Duration::from_millis(100));
    }
    // Second guard: the owner token printed on a screen reads as [redacted] for a token, as typed for the owner.
    h.call(
        &owner,
        json!({"op":"start","session":{"kind":"shell","project":h.home,"label":"printer",
            "args":["/bin/sh","-c",format!("cat '{}'; echo; exec cat", h.home.join("core.token").display())]}}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !h.ok(&owner, &["agent", "read", "printer"]).contains(&owner) {
        assert!(Instant::now() < until, "the screen never showed the token");
        thread::sleep(Duration::from_millis(50));
    }
    let read = h.ok(&full, &["agent", "read", "printer"]);
    assert!(
        !read.contains(&owner) && read.contains("[redacted]"),
        "{read}"
    );
    let mut mcp = Mcp::new(&h, &full);
    let read = mcp.tool("agent_read", json!({"agent": "printer"}));
    assert!(
        !read.to_string().contains(&owner) && read.to_string().contains("[redacted]"),
        "{read}"
    );
    // Round 6 (security r5 SHOULD 2): a token session's own credential reads it as [redacted] too.
    let reader = h.agent(&full, "reader");
    let read = h.ok(
        &session_credential(&h, &reader),
        &["agent", "read", "printer"],
    );
    assert!(
        !read.contains(&owner) && read.contains("[redacted]"),
        "{read}"
    );
}

/// Round 4: the settings file the core wrote for session `id`.
fn session_settings(h: &Harness, id: &str) -> Value {
    serde_json::from_slice(&fs::read(h.home.join(format!("hooks-{id}.json"))).unwrap()).unwrap()
}
fn kept_out(s: &Value) -> bool {
    s["sandbox"]["enabled"] == true
        && s["permissions"]["deny"].as_array().is_some_and(|d| {
            d.iter()
                .any(|r| r.as_str().is_some_and(|r| r.starts_with("Read(")))
        })
}
/// The token id behind a secret, through the owner's list (the newest token).
fn newest_token_id(h: &Harness) -> String {
    let list: Value =
        serde_json::from_str(&h.ok(&h.owner_token(), &["token", "list", "--json"])).unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .max_by_key(|t| t["created_ms"].as_u64())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

// Round 4 (security MUST 1): a run that continues a token session is a token session, whoever resumes it.
#[test]
fn a_resumed_token_session_stays_kept_out() {
    let h = Harness::new();
    let owner = h.owner_token();
    let supervised = h.token("supervised");
    let token_id = format!("token-{}", newest_token_id(&h));
    let first = h.agent(&supervised, "first");
    let got = h
        .call(&owner, json!({"op":"agent_get","id":first}))
        .unwrap();
    let conversation = got["session"]["agent_session_id"]
        .as_str()
        .expect("conversation")
        .to_string();
    assert!(kept_out(&session_settings(&h, &first)));
    h.call(&supervised, json!({"op":"close","id":first}))
        .unwrap();
    // The reviewer's sequence: the owner starts the same conversation again (the window's Resume).
    let resumed = h
        .call(
            &owner,
            json!({"op":"start","session":{"kind":"claude","project":h.project,"label":"again",
                "resume":conversation}}),
        )
        .unwrap()["session"]
        .clone();
    let resumed_id = resumed["id"].as_str().unwrap();
    assert_ne!(resumed_id, first);
    assert_eq!(resumed["parent"], token_id.as_str(), "{resumed}");
    let s = session_settings(&h, resumed_id);
    assert!(kept_out(&s), "the resumed run has no keep_out: {s}");
    // The token reaches that restricted run, and still none of the owner's.
    h.ok(&supervised, &["agent", "send", resumed_id, "hello"]);
    let theirs = h.agent(&owner, "theirs");
    assert!(!kept_out(&session_settings(&h, &theirs)));
    assert!(
        h.refused(&supervised, &["agent", "send", &theirs, "hello"])
            .contains("sessions it started")
    );
}

/// The pid of a session's agent process (the fake Claude, the wrapper's child), polled for: just after a start the
/// wrapper's child can still be its `$(stty -g)` subshell or a fork not yet exec'd as the agent.
fn agent_pid(h: &Harness, id: &str) -> String {
    let got = h
        .call(&h.owner_token(), json!({"op":"agent_get","id":id}))
        .unwrap();
    let wrapper = got["session"]["pid"].as_u64().expect("pid").to_string();
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let children = Command::new("pgrep")
            .args(["-P", &wrapper])
            .output()
            .unwrap();
        for pid in String::from_utf8_lossy(&children.stdout).split_whitespace() {
            let ps = Command::new("ps")
                .args(["-ww", "-o", "command=", "-p", pid])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&ps.stdout).contains("agent-cli/claude") {
                return pid.to_string();
            }
        }
        assert!(
            Instant::now() < until,
            "{id}: no agent process under {wrapper}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// The `NUNCHIRO_TOKEN` in a session's agent process (the wrapper's child), read as the reviewer did.
fn session_credential(h: &Harness, id: &str) -> String {
    let agent = agent_pid(h, id);
    let ps = Command::new("ps")
        .args(["-E", "-ww", "-o", "command=", "-p", &agent])
        .output()
        .unwrap();
    let env = String::from_utf8_lossy(&ps.stdout).into_owned();
    env.split_whitespace()
        .find_map(|w| w.strip_prefix("NUNCHIRO_TOKEN="))
        .unwrap_or_else(|| panic!("no credential in {env}"))
        .to_string()
}

// Round 4 (security MUST 2): a token session's own credential is the token, never a plain session caller.
#[test]
fn a_token_sessions_credential_is_the_token() {
    let h = Harness::new();
    let owner = h.owner_token();
    let home = h.project.to_str().unwrap();
    let theirs = h.agent(&owner, "theirs");
    let supervised = h.token("supervised");
    let token_id = format!("token-{}", newest_token_id(&h));
    let mine = h.agent(&supervised, "mine");
    let credential = session_credential(&h, &mine);
    assert!(!credential.starts_with("nunchiro_"), "a session credential");
    let shell = h
        .call(
            &credential,
            json!({"op":"start","session":{"kind":"shell","project":h.project,"args":["/bin/sh","-c","exec cat"]}}),
        )
        .unwrap_err();
    assert!(shell.contains("only Claude"), "{shell}");
    assert!(
        h.refused(&credential, &["agent", "send", &theirs, "hello"])
            .contains("sessions it started")
    );
    let room = h
        .call(&credential, json!({"op":"room_read","project":home}))
        .unwrap_err();
    assert!(room.contains("not granted"), "{room}");
    // A start made with it is the token's, with keep_out, and the token reaches it.
    let child = h.agent(&credential, "child");
    assert!(kept_out(&session_settings(&h, &child)));
    let got = h
        .call(&owner, json!({"op":"agent_get","id":child}))
        .unwrap();
    // Round 5: its parent is the token session (one link below the token), so the token reaches it by origin.
    assert_eq!(got["session"]["parent"], mine.as_str(), "{got}");
    h.ok(&supervised, &["agent", "send", &child, "hello"]);
    // Round 5 (security r4 MUST 1): it reaches this Mac's core only, as the token's own secret does.
    for presented in [&supervised, &credential] {
        let remote = h
            .call(
                presented,
                json!({"op":"remote","machine":"m1","request":{"op":"list"}}),
            )
            .unwrap_err();
        assert!(remote.contains("another machine"), "{remote}");
    }
    // It ends with the token.
    h.ok(
        &owner,
        &["token", "revoke", token_id.trim_start_matches("token-")],
    );
    assert_eq!(
        h.call(&credential, json!({"op":"agent_list","mine":false}))
            .unwrap_err(),
        "unauthorized"
    );
}

// Round 4 (security SHOULD 4, NOTE 5): a token works outside the data folder, stops no core, and acts only on what it
// started or created.
#[test]
fn a_token_works_outside_the_data_folder_and_on_its_own() {
    let h = Harness::new();
    let owner = h.owner_token();
    let full = h.token("full");
    let start = |project: &std::path::Path, worktree: bool| {
        h.call(
            &full,
            json!({"op":"start","session":{"kind":"claude","project":project,"worktree":worktree}}),
        )
    };
    for inside in [
        h.home.clone(),
        h.home.join("plugin"),
        h.home.parent().unwrap().to_path_buf(),
    ] {
        let refused = start(&inside, false).unwrap_err();
        assert!(
            refused.contains("outside the Nunchiro folder"),
            "{inside:?}: {refused}"
        );
    }
    // The core, the window's layout and the owner's sessions are not a token's.
    for request in [
        json!({"op":"stop"}),
        json!({"op":"layout","args":["split"]}),
    ] {
        let refused = h.call(&full, request.clone()).unwrap_err();
        assert!(refused.contains("not granted"), "{request}: {refused}");
    }
    let theirs = h.agent(&owner, "theirs");
    for request in [
        json!({"op":"label","id":theirs,"label":"x"}),
        json!({"op":"resize","id":theirs,"cols":80,"rows":24}),
    ] {
        let refused = h.call(&full, request.clone()).unwrap_err();
        assert!(
            refused.contains("sessions it started"),
            "{request}: {refused}"
        );
    }
    let mine = h.agent(&full, "mine");
    h.call(&full, json!({"op":"label","id":mine,"label":"renamed"}))
        .unwrap();
    // Worktrees: a token removes the one it created, not the owner's. Ticket 1061: the repository is a folder of the
    // project folder, so the default root (beside the repository) is removed with it.
    let repo = &h.project.join("repo");
    fs::create_dir_all(repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let create = |token: &str, branch: &str| -> PathBuf {
        let r = h
            .call(
                token,
                json!({"op":"worktree","operation":"create","project":repo,"path":null,"branch":branch,
                    "base":"HEAD","label":branch}),
            )
            .unwrap();
        let w = r["worktrees"].as_array().unwrap();
        PathBuf::from(
            w.iter().find(|w| w["label"] == branch).expect("created")["path"]
                .as_str()
                .unwrap(),
        )
    };
    let remove = |token: &str, path: &PathBuf| {
        h.call(
            token,
            json!({"op":"worktree","operation":"remove","project":repo,"path":path,"branch":null,"base":"","label":""}),
        )
    };
    // Tickets 1061, 1083: the default worktree folder is beside this core's own home, so a token's --worktree start goes there.
    let beside = own_worktrees(&h.home).join("repo");
    let started = start(repo, true).unwrap();
    let cwd = started["session"]["cwd"].as_str().unwrap_or_default();
    assert!(cwd.starts_with(beside.to_str().unwrap()), "{started}");
    // A setting that points inside the Nunchiro folder is still refused for a token.
    let set = |dir: &str| {
        h.call(
            &owner,
            json!({"op":"quit_settings","patch":{"worktrees_dir":dir}}),
        )
        .unwrap()
    };
    set(h.home.join("wt").to_str().unwrap());
    let refused = start(repo, true).unwrap_err();
    assert!(refused.contains("worktree folder"), "{refused}");
    set("");
    let owners = create(&owner, "owners");
    assert!(owners.starts_with(&beside), "{owners:?}");
    // Round 5 (security r4 NOTE 3): a token's `--path` is never inside the Nunchiro folder.
    let inside = h
        .call(
            &full,
            json!({"op":"worktree","operation":"create","project":repo,"path":h.home.join("worktrees/repo/inside"),
                "branch":"inside","base":"HEAD","label":"inside"}),
        )
        .unwrap_err();
    assert!(inside.contains("outside the Nunchiro folder"), "{inside}");
    let tokens = create(&full, "tokens");
    let refused = remove(&full, &owners).unwrap_err();
    assert!(refused.contains("worktrees it created"), "{refused}");
    remove(&full, &tokens).unwrap();
}

// Ticket 1061 (security MUST): the default root sits in a folder other programs of the user may write. A
// planted `<root>/<repo>` link is refused for a token and the owner, and nothing lands where it points. A linked
// the root itself is resolved (the owner may move it to another disk that way), and a token is checked on the result.
#[test]
fn a_linked_worktree_folder_never_moves_a_checkout() {
    let h = Harness::new();
    let owner = h.owner_token();
    let full = h.token("full");
    let repo = &h.project.join("repo");
    fs::create_dir_all(repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=F",
            "-c",
            "user.email=f@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "i",
        ],
    ] {
        let git = home::git_env::scrubbed("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output();
        assert!(git.unwrap().status.success());
    }
    let start = |token: &str| {
        h.call(
            token,
            json!({"op":"start","session":{"kind":"claude","project":repo,"worktree":true}}),
        )
    };
    let create = |token: &str, branch: &str| {
        h.call(
            token,
            json!({"op":"worktree","operation":"create","project":repo,"path":null,"branch":branch,
                "base":"HEAD","label":branch}),
        )
    };
    let planted = h.home.join("planted");
    fs::create_dir_all(&planted).unwrap();
    let worktrees = own_worktrees(&h.home);
    fs::create_dir_all(&worktrees).unwrap();
    std::os::unix::fs::symlink(&planted, worktrees.join("repo")).unwrap();
    for (who, refused) in [
        ("token start", start(&full).unwrap_err()),
        ("owner start", start(&owner).unwrap_err()),
        ("token create", create(&full, "a").unwrap_err()),
        ("owner create", create(&owner, "b").unwrap_err()),
    ] {
        assert!(
            refused.contains("is a link or not a folder"),
            "{who}: {refused}"
        );
    }
    assert_eq!(
        fs::read_dir(&planted).unwrap().count(),
        0,
        "nothing under the link's target"
    );
    // A linked root into the Nunchiro folder: resolved, so a token is refused and the owner's lands there.
    fs::remove_file(worktrees.join("repo")).unwrap();
    fs::remove_dir(&worktrees).unwrap();
    std::os::unix::fs::symlink(&planted, &worktrees).unwrap();
    for refused in [start(&full).unwrap_err(), create(&full, "c").unwrap_err()] {
        assert!(refused.contains("the Nunchiro folder"), "{refused}");
    }
    create(&owner, "d").unwrap();
    // The normal case: a real root works for both.
    fs::remove_file(&worktrees).unwrap();
    start(&full).unwrap();
    create(&full, "e").unwrap();
}

// Round 5 (review r4 MUST 1): a token session keeps its own room seat: it reads and answers what is sent to it, from
// its own seat. Its limits stay the token's (the round 4 tests).
#[test]
fn a_token_session_keeps_its_own_room_seat() {
    let h = Harness::new();
    let project = h.project.to_str().unwrap();
    let scoped = h
        .ok(
            &h.owner_token(),
            &[
                "token",
                "create",
                "--scope",
                "supervised",
                "--project",
                project,
            ],
        )
        .trim()
        .to_string();
    let worker = h.agent(&scoped, "worker");
    let credential = session_credential(&h, &worker);
    let sent: Value = serde_json::from_str(&h.ok(
        &scoped,
        &[
            "agent",
            "send",
            "--to",
            &worker,
            "--project",
            project,
            "task for worker",
        ],
    ))
    .unwrap();
    assert!(
        sent["from"].as_str().unwrap().starts_with("token-"),
        "{sent}"
    );
    let inbox = h.ok(&credential, &["agent", "check"]);
    let message: Value = serde_json::from_str(
        inbox
            .lines()
            .find(|l| l.contains("task for worker"))
            .unwrap_or_else(|| panic!("the worker never saw its message: {inbox:?}")),
    )
    .unwrap();
    assert_eq!(message["to"], worker.as_str());
    let reply: Value = serde_json::from_str(&h.ok(
        &credential,
        &["agent", "reply", message["id"].as_str().unwrap(), "done"],
    ))
    .unwrap();
    assert_eq!(
        (reply["from"].as_str(), reply["to"].as_str()),
        (Some(worker.as_str()), sent["from"].as_str()),
        "{reply}"
    );
    // The token's own inbox gets the reply; the token's seat and the worker's stay apart.
    let token_inbox = h.ok(&scoped, &["agent", "check", "--project", project]);
    assert!(token_inbox.contains("done"), "{token_inbox}");
    // Still the token's limits.
    let shell = h
        .call(
            &credential,
            json!({"op":"start","session":{"kind":"shell","project":h.project,"args":["/bin/sh","-c","exec cat"]}}),
        )
        .unwrap_err();
    assert!(shell.contains("only Claude"), "{shell}");
}

/// Round 6: a token starts A; A's own credential starts B. Returns (token, A, B, B's credential).
fn token_chain(h: &Harness) -> (String, String, String, String) {
    let token = h.token("supervised");
    let a = h.agent(&token, "a");
    let b = h.agent(&session_credential(h, &a), "b");
    let credential = session_credential(h, &b);
    (token, a, b, credential)
}
/// B's credential still carries the token's limits: no shell, none of the owner's sessions, no other machine, and
/// keep_out on its own starts.
fn still_limited(h: &Harness, credential: &str, theirs: &str, step: &str) {
    let shell = h
        .call(
            credential,
            json!({"op":"start","session":{"kind":"shell","project":h.project,
                "args":["/bin/sh","-c","cat core.token; exec cat"]}}),
        )
        .unwrap_err();
    assert!(shell.contains("only Claude"), "{step}: {shell}");
    assert!(
        h.refused(credential, &["agent", "send", theirs, "hello"])
            .contains("sessions it started"),
        "{step}"
    );
    let remote = h
        .call(
            credential,
            json!({"op":"remote","machine":"m1","request":{"op":"list"}}),
        )
        .unwrap_err();
    assert!(remote.contains("another machine"), "{step}: {remote}");
    let child = h.agent(credential, &format!("child-{step}"));
    assert!(kept_out(&session_settings(h, &child)), "{step}");
}

// Round 6 (security r5 MUST 1): the origin is stored on the session, so a child of a token session stays one after its
// parent's record goes (a close), and after a core restart.
#[test]
fn a_child_stays_a_token_session_after_its_parent_closes() {
    let mut h = Harness::new();
    let theirs = h.agent(&h.owner_token(), "theirs");
    let (token, a, b, credential) = token_chain(&h);
    still_limited(&h, &credential, &theirs, "a-live");
    // A stopped session's close takes its record out of the registry at once (`close_later`), the reviewer's case. So
    // stop A's run first: its wrapper, a process this test's core started, by its recorded pid.
    let got = h
        .call(&h.owner_token(), json!({"op":"agent_get","id":a}))
        .unwrap();
    let pid = got["session"]["pid"].as_u64().expect("pid").to_string();
    assert!(Command::new("kill").arg(&pid).status().unwrap().success());
    let until = Instant::now() + Duration::from_secs(10);
    while h
        .call(&h.owner_token(), json!({"op":"agent_get","id":a}))
        .unwrap()["session"]["state"]
        == "running"
    {
        assert!(Instant::now() < until, "A never stopped");
        thread::sleep(Duration::from_millis(50));
    }
    h.call(&token, json!({"op":"close","id":a})).unwrap();
    assert!(
        h.call(&h.owner_token(), json!({"op":"agent_get","id":a}))
            .is_err(),
        "A's record is out of the registry"
    );
    still_limited(&h, &credential, &theirs, "a-closed");
    h.ok(&token, &["agent", "send", &b, "still yours"]);
    h.restart();
    let theirs = h.agent(&h.owner_token(), "theirs-again");
    still_limited(&h, &credential, &theirs, "restarted");
    h.ok(&token, &["agent", "send", &b, "still yours"]);
}

// Round 6 (security r5 MUST 1): the same when A's record is replaced by a resume, and a resume of B keeps keep_out.
#[test]
fn a_child_stays_a_token_session_after_its_parent_resumes() {
    let h = Harness::new();
    let owner = h.owner_token();
    let theirs = h.agent(&owner, "theirs");
    let (token, a, b, credential) = token_chain(&h);
    let conversation = |id: &str| {
        h.call(&owner, json!({"op":"agent_get","id":id})).unwrap()["session"]["agent_session_id"]
            .as_str()
            .expect("conversation")
            .to_string()
    };
    let resume = |id: &str| -> String {
        let c = conversation(id);
        h.call(&owner, json!({"op":"close","id":id})).unwrap();
        h.call(
            &owner,
            json!({"op":"start","session":{"kind":"claude","project":h.project,"label":"again","resume":c}}),
        )
        .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let a2 = resume(&a);
    assert!(kept_out(&session_settings(&h, &a2)));
    still_limited(&h, &credential, &theirs, "a-resumed");
    let b2 = resume(&b);
    assert!(kept_out(&session_settings(&h, &b2)), "a resume of B");
    let got = h.call(&owner, json!({"op":"agent_get","id":b2})).unwrap();
    assert!(
        got["session"]["token_origin"]
            .as_str()
            .is_some_and(|t| t.starts_with("token-")),
        "{got}"
    );
    h.ok(&token, &["agent", "send", &b2, "still yours"]);
    still_limited(&h, &session_credential(&h, &b2), &theirs, "b-resumed");
}

// Round 6 (review r5 MUST 1): the stored origin has no depth limit. A chain of 20 starts, each made with the last
// session's own credential, ends in a session whose credential is still the token's.
#[test]
fn a_token_session_chain_of_twenty_stays_limited() {
    let h = Harness::new();
    let theirs = h.agent(&h.owner_token(), "theirs");
    let token = h.token("supervised");
    let mut last = h.agent(&token, "s1");
    for n in 2..=20 {
        last = h.agent(&session_credential(&h, &last), &format!("s{n}"));
    }
    let credential = session_credential(&h, &last);
    assert!(
        h.refused(&credential, &["agent", "send", &theirs, "hello"])
            .contains("sessions it started")
    );
    assert!(kept_out(&session_settings(&h, &last)));
    h.ok(&token, &["agent", "send", &last, "still yours"]);
}

/// A core on its own NUNCHIRO_HOME keeps its unset-default worktrees beside that home, not in the user's home.
fn own_worktrees(home: &std::path::Path) -> std::path::PathBuf {
    let home = std::fs::canonicalize(home).unwrap();
    let name = format!(
        "{}-worktrees",
        home.file_name()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches('.')
    );
    home.with_file_name(name).join("nunchiro/worktrees")
}
