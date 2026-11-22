//! Ticket 187 (V2.5-39): the turn-end nudge end to end. A synthetic agent
//! (`nunchiro-core/tests/fixtures/nudge-agent`) runs each turn through the hook commands the core gave it, so the
//! line goes core -> `nunchiro hook` -> the agent's hook stdout, and the agent logs every PTY read.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use nunchiro_core::board::nudge::{HISTORY_LINE, is_context};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Child,
    thread,
    time::{Duration, Instant, SystemTime},
};

struct Harness {
    home: PathBuf,
    /// HOME, CLAUDE_CONFIG_DIR and CODEX_HOME of the core and its agents.
    user: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("nudge");
        let user = home.join("user");
        for dir in [".claude", ".codex", "claude-data", "codex-data"] {
            fs::create_dir_all(user.join(dir)).unwrap();
        }
        // Existing agent config the nudge must leave byte-identical (Codex hooks need CODEX_HOME without config).
        fs::write(user.join(".claude/settings.json"), "{\"model\":\"x\"}").unwrap();
        fs::write(user.join(".codex/config.toml"), "model = \"x\"\n").unwrap();
        fs::write(user.join("claude-data/settings.json"), "{}").unwrap();
        fs::write(user.join("codex-data/auth-fixture.txt"), "fixture").unwrap();
        let core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &user)
            .env("CLAUDE_CONFIG_DIR", user.join("claude-data"))
            .env("CODEX_HOME", user.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env("NUNCHIRO_SETTLE_MS", "50")
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .env(
                "PATH",
                // `<home>/bin` first: a test that writes its own agent there (`fake`) runs that one.
                format!(
                    "{}:{}/../nunchiro-core/tests/fixtures/nudge-agent:{}",
                    home.join("bin").display(),
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            )
            .arg("serve")
            .spawn()
            .unwrap();
        let h = Self { home, user, core };
        h.until(|| {
            h.home.join("core.token").exists()
                && UnixStream::connect(h.home.join("core.sock")).is_ok()
        });
        h
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    /// A `claude` that only records its session token and reads its PTY; the test sends its hooks itself.
    fn fake(&self) {
        use std::os::unix::fs::PermissionsExt;
        let bin = self.home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(
            bin.join("claude"),
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '99.0.0 fixture'; exit; fi\nprintf %s \"$NUNCHIRO_TOKEN\" > \"$NUNCHIRO_HOME/token-$NUNCHIRO_SESSION\"\nprintf '\\342\\235\\257 \\n'\nexec cat >/dev/null\n",
        )
        .unwrap();
        fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    /// Session `id`'s own hook call `event`, with its token (as `nunchiro hook` sends it); the reply and its time.
    fn hook(&self, id: &str, event: &str) -> (Value, Duration) {
        let token = fs::read_to_string(self.home.join(format!("token-{id}"))).unwrap();
        let at = Instant::now();
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let request = json!({"op":"hook","id":id,"event":event,"payload":{}});
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        (serde_json::from_str(&line).unwrap(), at.elapsed())
    }
    /// Counts and parks the nudge's board reads (`board::nudge`'s debug-build seam); waits for the first.
    fn park_next_read(&self) -> impl Fn() + '_ {
        fs::write(self.home.join("nudge-loads"), "").unwrap();
        fs::write(self.home.join("nudge-park"), "").unwrap();
        move || {
            self.until(|| {
                !fs::read_to_string(self.home.join("nudge-loads"))
                    .unwrap()
                    .is_empty()
            })
        }
    }
    fn unpark(&self) {
        fs::remove_file(self.home.join("nudge-park")).unwrap();
    }
    fn until(&self, mut done: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(15);
        while !done() {
            assert!(Instant::now() < until, "timed out");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn agent(&self, kind: &str, args: &[&str]) -> String {
        let r = self
            .owner(json!({"op":"start","session":{"kind":kind,"project":self.home,"args":args}}))
            .unwrap();
        let id: String = r["session"]["id"].as_str().unwrap().into();
        self.until(|| {
            self.owner(json!({"op":"agent_read","id":id,"source":"screen","lines":50}))
                .is_ok_and(|r| r["text"].as_str().unwrap_or_default().contains('❯'))
        });
        id
    }
    /// A card in Working attached to `session`; returns its id.
    fn card(&self, title: &str, session: &str) -> String {
        let board = self
            .owner(json!({"op":"board_put","id":null,"title":title,"session_id":null,"column":"working"}))
            .unwrap();
        let id = board["board"]["cards"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|c| c["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        self.owner(json!({"op":"board_task_put","id":id,"attachments":[{"session_id":session,"role":"build"}]}))
            .unwrap();
        id
    }
    fn history(&self, card: &str) -> Vec<Value> {
        let board = self.owner(json!({"op":"board_snapshot"})).unwrap();
        board["board"]["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == card)
            .unwrap()["history"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn log(&self, name: &str, id: &str) -> Vec<Value> {
        fs::read_to_string(self.home.join(format!("{name}-{id}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    /// One prompt, through the ordinary prompt path; waits for the agent's turn to end.
    fn turn(&self, id: &str, text: &str) -> Value {
        let n = self.log("ctx", id).len();
        self.owner(json!({"op":"agent_prompt","id":id,"text":text}))
            .unwrap();
        self.until(|| self.log("ctx", id).len() > n);
        // The Stop hook runs after the context is logged; let it land.
        thread::sleep(Duration::from_millis(300));
        self.log("ctx", id)[n].clone()
    }
    /// Every file under the agent config trees, with its bytes and mtime.
    fn config(&self) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, (Vec<u8>, SystemTime)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
                    out.insert(path.clone(), (fs::read(&path).unwrap(), mtime));
                }
            }
        }
        let mut out = BTreeMap::new();
        for dir in [".claude", ".codex", "claude-data", "codex-data"] {
            walk(&self.user.join(dir), &mut out);
        }
        out
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op":"stop"}));
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn nudge(ctx: &Value) -> Option<Value> {
    let out = ctx["stdout"].as_str().unwrap().trim();
    (!out.is_empty()).then(|| serde_json::from_str(out).unwrap())
}

fn nudges(history: &[Value]) -> usize {
    history
        .iter()
        .filter(|h| h["reason"] == HISTORY_LINE)
        .count()
}

/// Two turns of `kind`: the first ends with its card unmoved, so the second prompt's hook prints the nudge.
fn nudged(kind: &str) {
    let h = Harness::new();
    let a = h.agent(kind, &[]);
    let card = h.card("Parser", &a);
    thread::sleep(Duration::from_millis(5));
    assert_eq!(nudge(&h.turn(&a, "one")), None);
    let before = h.config();
    let ctx = h.turn(&a, "two");
    let out = nudge(&ctx).expect("nudge on the next prompt");
    // nudge_never_blocks_or_continues: the bridge printed exactly the one context field.
    assert!(is_context(&out), "{out}");
    let line = out["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(
        line,
        format!(
            "Board: #{card} \"Parser\" is still in \"Working\". If you are done, run: nunchiro board move {card} review"
        )
    );
    // The 1.8 s bound holds with a nudge pending.
    assert!(ctx["ms"].as_u64().unwrap() < 1800, "{ctx}");
    // nudge_never_types: the PTY read only the two prompts and their Enters; the composer held only them.
    let reads: String = h
        .log("pty", &a)
        .iter()
        .map(|r| r.as_str().unwrap().to_string())
        .collect();
    assert_eq!(reads, "one\rtwo\r");
    assert_eq!(h.log("composer", &a), [json!("one"), json!("two")]);
    // nudge_writes_no_agent_config.
    assert_eq!(h.config(), before);
    assert_eq!(nudges(&h.history(&card)), 1);
    // The next unmoved turn gives one more.
    assert!(nudge(&h.turn(&a, "three")).is_some());
    assert_eq!(nudges(&h.history(&card)), 2);
}

#[test]
fn nudge_reaches_claude_on_user_prompt_submit() {
    nudged("claude");
}

#[test]
fn nudge_reaches_codex_on_user_prompt_submit() {
    nudged("codex");
}

#[test]
fn nudge_only_own_card_and_ignores_payload_session_id() {
    let h = Harness::new();
    let b = h.agent("claude", &[]);
    // A's hook payloads all carry `session_id: <B>`, and it also sends a hook naming B's id with its own token.
    let a = h.agent("claude", &["--fixture-forge", &b]);
    let mine = h.card("Mine", &a);
    let theirs = h.card("Theirs", &b);
    thread::sleep(Duration::from_millis(5));
    h.turn(&a, "one");
    let ctx = h.turn(&a, "two");
    let line = nudge(&ctx).unwrap()["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(line.contains(&format!("#{mine} \"Mine\"")), "{line}");
    assert!(!line.contains(&theirs));
    assert_eq!(nudges(&h.history(&mine)), 1);
    assert_eq!(nudges(&h.history(&theirs)), 0);
    // The hook naming B with A's token is refused and gives no nudge.
    let forged: Value = serde_json::from_str(ctx["forged_id"].as_str().unwrap().trim()).unwrap();
    assert!(
        forged.get("Err").is_some() || forged.get("error").is_some(),
        "{forged}"
    );
    // B never had a turn: its next prompt gets nothing, and its card no history line.
    assert_eq!(nudge(&h.turn(&b, "hello")), None);
    assert_eq!(nudges(&h.history(&theirs)), 0);
}

/// Session `a` with a card in Working and one turn begun (its prompt arrived).
fn begun(h: &Harness) -> String {
    h.fake();
    let a = h.agent("claude", &[]);
    h.card("Parser", &a);
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "UserPromptSubmit");
    thread::sleep(Duration::from_millis(5));
    a
}

#[test]
fn stop_reads_board_outside_locks() {
    let h = Harness::new();
    let a = begun(&h);
    let b = h.agent("claude", &[]);
    let parked = h.park_next_read();
    thread::scope(|scope| {
        let stop = scope.spawn(|| h.hook(&a, "Stop"));
        parked();
        // While a's Stop is parked in its board read, a registry request and another session's hook complete.
        let at = Instant::now();
        h.owner(json!({"op":"snapshot"})).unwrap();
        assert!(
            at.elapsed() < Duration::from_millis(500),
            "snapshot {:?}",
            at.elapsed()
        );
        let (reply, took) = h.hook(&b, "UserPromptSubmit");
        assert_eq!(reply["Ok"]["type"], "ack", "{reply}");
        assert!(took < Duration::from_millis(500), "hook {took:?}");
        h.unpark();
        assert_eq!(stop.join().unwrap().0["Ok"]["type"], "ack");
    });
    // The parked Stop still decided the nudge: the next prompt gets it.
    let (reply, _) = h.hook(&a, "UserPromptSubmit");
    assert!(is_context(&reply["Ok"]["decision"]), "{reply}");
}

#[test]
fn permission_answer_not_blocked_by_nudge() {
    let h = Harness::new();
    let a = begun(&h);
    // The turn ends unmoved, so the next prompt's hook reads the board to send the nudge.
    h.hook(&a, "Stop");
    h.owner(json!({"op":"queue_connect"})).unwrap();
    let parked = h.park_next_read();
    thread::scope(|scope| {
        let prompt = scope.spawn(|| h.hook(&a, "UserPromptSubmit"));
        parked();
        let permission = scope.spawn(|| {
            let at = Instant::now();
            let reply = h.owner(json!({"op":"hook","id":a,"event":"PermissionRequest",
                "payload":{"tool_name":"Bash","tool_input":{"command":"true"},"nunchiro_event_id":"ev-lock"}}));
            (reply, at.elapsed())
        });
        // The owner answers the decision while the nudge's board read is still parked.
        let item = loop {
            let snapshot = h.owner(json!({"op":"snapshot"})).unwrap();
            let pending = snapshot["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == a)
                .unwrap()["pending"]
                .clone();
            if let Some(item) = pending.as_array().and_then(|p| p.first()) {
                break item["id"].clone();
            }
            assert!(!permission.is_finished(), "hook ended before the answer");
            thread::sleep(Duration::from_millis(10));
        };
        h.owner(json!({"op":"answer","item":item,"answer":{"type":"deny"},"confirmed":false}))
            .unwrap();
        let (reply, took) = permission.join().unwrap();
        let reply = reply.unwrap();
        assert_eq!(reply["type"], "hook_decision", "{reply}");
        assert_eq!(
            reply["decision"]["hookSpecificOutput"]["decision"]["behavior"], "deny",
            "{reply}"
        );
        // Inside the bridge's 1.8 s bound.
        assert!(took < Duration::from_millis(1800), "{took:?}");
        h.unpark();
        prompt.join().unwrap();
    });
}

/// Runs the real bridge (`nunchiro hook <event>`) as session `id`, writing its stdin payload after `delay`.
fn bridge(h: &Harness, id: &str, event: &str, delay: Duration) -> String {
    bridge_with(h, id, event, delay, "{}")
}
fn bridge_with(h: &Harness, id: &str, event: &str, delay: Duration, payload: &str) -> String {
    use std::process::Stdio;
    let token = fs::read_to_string(h.home.join(format!("token-{id}"))).unwrap();
    let mut child = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["hook", event])
        .env("NUNCHIRO_HOME", &h.home)
        .env("NUNCHIRO_SESSION", id)
        .env("NUNCHIRO_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // The fixed pre-connect delay: the bridge reads stdin to its end before it journals and connects.
    thread::sleep(delay);
    stdin.write_all(payload.as_bytes()).unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap()
}

// V2.5-48: the budget counts from the bridge's start, not the core's accept. A bridge that waited 1.3 s on its stdin
// before connecting is past the 1.2 s budget: no nudge, no history line, and the nudge stays pending.
#[test]
fn nudge_budget_counts_from_bridge_start() {
    let h = Harness::new();
    h.fake();
    let a = h.agent("claude", &[]);
    let card = h.card("Parser", &a);
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "UserPromptSubmit");
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "Stop");
    assert_eq!(
        bridge(&h, &a, "UserPromptSubmit", Duration::from_millis(1300)),
        ""
    );
    assert_eq!(nudges(&h.history(&card)), 0);
    // A prompt without the delay gets it, through the same bridge, with one line.
    let out: Value =
        serde_json::from_str(bridge(&h, &a, "UserPromptSubmit", Duration::ZERO).trim()).unwrap();
    assert!(is_context(&out), "{out}");
    assert_eq!(nudges(&h.history(&card)), 1);
}

// V2.5-48: a reply the core cannot hand over (the client closed while the nudge's board read was parked) leaves no
// history line; the nudge stays pending and the next prompt's delivered reply writes exactly one.
#[test]
fn nudge_history_follows_the_reply_end_to_end() {
    let h = Harness::new();
    h.fake();
    let a = h.agent("claude", &[]);
    let card = h.card("Parser", &a);
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "UserPromptSubmit");
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "Stop");
    let token = fs::read_to_string(h.home.join(format!("token-{a}"))).unwrap();
    let parked = h.park_next_read();
    let mut s = UnixStream::connect(h.home.join("core.sock")).unwrap();
    let request = json!({"op":"hook","id":a,"event":"UserPromptSubmit","payload":{}});
    writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
    parked();
    drop(s);
    h.unpark();
    // The core's reply write fails and takes the line back: a later prompt gets the nudge, and the card holds
    // only that delivered reply's line.
    h.until(|| is_context(&h.hook(&a, "UserPromptSubmit").0["Ok"]["decision"]));
    assert_eq!(nudges(&h.history(&card)), 1);
}

// Ticket 571 (hooks slice) end to end: a child Claude session's AskUserQuestion through the real bridge becomes an ask
// to its lead and the bridge prints the deny; the person's queue shows nothing. A bridge past the budget (the deny
// would be dropped) records no ask and the question reaches the person's queue as before.
#[test]
fn child_question_redirect_through_the_bridge() {
    let h = Harness::new();
    h.fake();
    let lead = h.agent("claude", &[]);
    let token = fs::read_to_string(h.home.join(format!("token-{lead}"))).unwrap();
    let mut s = UnixStream::connect(h.home.join("core.sock")).unwrap();
    let start = json!({"op":"start","session":{"kind":"claude","project":h.home}});
    writeln!(s, "{}", json!({"token": token, "request": start})).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    let child = reply["Ok"]["session"]["id"].as_str().unwrap().to_string();
    h.until(|| h.home.join(format!("token-{child}")).exists());
    let question = |text: &str| {
        json!({"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":text,"options":[{"label":"8080"}]}]}})
            .to_string()
    };
    let pending = || {
        h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == child.as_str())
            .unwrap()["pending"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["kind"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let asks = || {
        h.owner(json!({"op":"room_thread","thread":format!("q-{child}"),"project":h.home}))
            .unwrap()["messages"]
            .as_array()
            .unwrap()
            .len()
    };
    let out = bridge_with(
        &h,
        &child,
        "PreToolUse",
        Duration::ZERO,
        &question("Which port?"),
    );
    let out: Value = serde_json::from_str(out.trim()).unwrap();
    assert!(
        nunchiro_core::room::is_hook_output("PreToolUse", &out),
        "{out}"
    );
    assert_eq!(asks(), 1);
    assert!(pending().is_empty(), "the person is not asked");
    // Past the budget: nothing printed, no second ask, and the person's queue holds the question.
    let late = bridge_with(
        &h,
        &child,
        "PreToolUse",
        Duration::from_millis(1300),
        &question("Which host?"),
    );
    assert_eq!(late, "");
    assert_eq!(asks(), 1);
    assert_eq!(pending(), ["question"]);
}

// Q9 pin-J11-1: a full hook journal (leftovers of hooks killed after their answer) never keeps an event from the live
// core: the bridge still forwards it, and the turn's prompt still gets its nudge.
#[test]
fn full_hook_journal_still_reaches_the_core() {
    let h = Harness::new();
    h.fake();
    let a = h.agent("claude", &[]);
    let card = h.card("Parser", &a);
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "UserPromptSubmit");
    thread::sleep(Duration::from_millis(5));
    h.hook(&a, "Stop");
    let journal = h.home.join("hook-journal");
    fs::create_dir_all(&journal).unwrap();
    for n in 0..nunchiro_core::queue::journal::MAX_EVENTS {
        fs::write(journal.join(format!("left-{n}.json")), "{}").unwrap();
    }
    let out: Value =
        serde_json::from_str(bridge(&h, &a, "UserPromptSubmit", Duration::ZERO).trim()).unwrap();
    assert!(is_context(&out), "{out}");
    assert_eq!(nudges(&h.history(&card)), 1);
}
