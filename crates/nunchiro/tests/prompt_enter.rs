//! Ticket V1A-15: a submit send writes its text (as a bracketed paste when the agent enabled it), then Enter as
//! its own write once the agent echoed the paste or the settle deadline passed. The paste-detecting fixture
//! submits only on a lone `\r` read, like Claude Code taking `text\r` in one read as a paste.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

const PASTE: &str = "--fixture-paste-detect";
const SILENT: &str = "--fixture-paste-silent";

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new(settle_ms: Option<u64>) -> Self {
        let home = home::short("enter");
        let mut command = Self::env(
            home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro")),
            &home,
        );
        if let Some(ms) = settle_ms {
            command.env("NUNCHIRO_SETTLE_MS", ms.to_string());
        }
        let core = command.arg("serve").spawn().unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("core.token").exists()
            || UnixStream::connect(h.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn env(mut c: Command, home: &std::path::Path) -> Command {
        c.env("NUNCHIRO_HOME", home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", home)
            .env_remove("NUNCHIRO_TOKEN")
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            );
        c
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request":request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn cli(&self, args: &[&str]) -> std::process::Output {
        let mut c = Self::env(
            home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro")),
            &self.home,
        );
        c.args(args).output().unwrap()
    }
    /// Starts a fixture agent and waits for its composer.
    fn agent(&self, kind: &str, args: &[&str]) -> String {
        let r = self
            .owner(json!({"op":"start","session":{"kind":kind,"project":self.home,"args":args}}))
            .unwrap();
        let id: String = r["session"]["id"].as_str().unwrap().into();
        self.until(|| {
            self.session(&id)["attention"]["working"] == false
                && self.screen(&id).contains(['❯', '›'])
        });
        id
    }
    fn session(&self, id: &str) -> Value {
        self.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()
            .clone()
    }
    fn screen(&self, id: &str) -> String {
        self.owner(json!({"op":"agent_read","id":id,"source":"screen","lines":200}))
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .into()
    }
    fn prompt(&self, id: &str, text: &str) -> Value {
        self.owner(json!({"op":"agent_prompt","id":id,"text":text}))
            .unwrap()["send"]
            .clone()
    }
    /// Every input chunk the paste-detecting fixture read, in order.
    fn reads(&self, id: &str) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("reads-{id}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn row(&self, id: &str, send: &Value) -> Value {
        let s = self.session(id);
        s["send_queue"]
            .as_array()
            .unwrap()
            .iter()
            .chain(s["send_log"].as_array().unwrap())
            .find(|r| r["id"] == send["id"])
            .unwrap()
            .clone()
    }
    fn until(&self, mut done: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(8);
        while !done() {
            assert!(Instant::now() < until, "timed out");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// `agent prompt --wait --until done` through the CLI; returns the session afterwards.
    fn submit(&self, id: &str, text: &str) -> Value {
        self.try_submit(id, text)
            .unwrap_or_else(|error| panic!("{text:?}: {error}"))
    }
    /// v1a-24 r4: as `submit`, but a failed CLI call gives its stderr.
    fn try_submit(&self, id: &str, text: &str) -> Result<Value, String> {
        let before = self.session(id)["completion_seq"].as_u64().unwrap();
        let r = self.cli(&[
            "agent",
            "prompt",
            id,
            text,
            "--wait",
            "--until",
            "done",
            "--timeout",
            "8000",
        ]);
        if !r.status.success() {
            return Err(String::from_utf8_lossy(&r.stderr).into());
        }
        let s = self.session(id);
        assert!(s["completion_seq"].as_u64().unwrap() > before, "{s}");
        assert_eq!(
            s["send_log"].as_array().unwrap().last().unwrap()["status"],
            "delivered"
        );
        Ok(s)
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

fn long() -> String {
    "Summarize the change in one line and stop. ".repeat(6)[..230].into()
}
fn acked(screen: &str, text: &str) -> bool {
    // The fixture prints `ACK:` + the line with newlines escaped; the 160-column screen wraps long lines.
    let flat: String = screen.lines().map(str::trim_end).collect();
    flat.contains(&format!("ACK:{}", text.replace('\n', "\\n")))
}

/// Ticket 1025 (look v26-a-S3-6): `session send-text` and `send-keys enter` right after the start submit the first
/// message, though Claude drops keys typed before its input box draws (`--fixture-slow-box`): the text waits.
#[test]
fn cli_first_message_waits_for_the_input_box() {
    let h = Harness::new(None);
    let r = h
        .owner(json!({"op":"start","session":{"kind":"claude","project":h.home,"args":["--fixture-slow-box"]}}))
        .unwrap();
    let id = r["session"]["id"].as_str().unwrap().to_string();
    for args in [["send-text", &id, "hello"], ["send-keys", &id, "enter"]] {
        let out = h.cli(&[&["session"][..], &args[..]].concat());
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    h.until(|| acked(&h.screen(&id), "hello"));
}

/// Lane w102 (look v34 c R5): text sent while a start question shows is held until `send-keys` answers it, then
/// typed into the input box; it never answers the question (the fixture prints `CHOICE:` + what was typed).
#[test]
fn cli_text_waits_out_a_start_question() {
    let h = Harness::new(None);
    let id = h.owner(json!({"op":"start","session":{"kind":"claude","project":h.home,"args":["--fixture-dialog"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.until(|| h.screen(&id).contains("Trust this folder?"));
    thread::scope(|s| {
        let text = s.spawn(|| h.cli(&["session", "send-text", &id, "hello"]));
        thread::sleep(Duration::from_millis(1500));
        assert!(
            !text.is_finished(),
            "send-text did not wait for the question"
        );
        let keys = h.cli(&["session", "send-keys", &id, "1", "enter"]);
        assert!(
            keys.status.success(),
            "{}",
            String::from_utf8_lossy(&keys.stderr)
        );
        let out = text.join().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    });
    assert!(h.screen(&id).contains("CHOICE:1"), "{}", h.screen(&id));
    h.cli(&["session", "send-keys", &id, "enter"]);
    h.until(|| acked(&h.screen(&id), "hello"));
}

/// Lane w102: with the start question still up at the bound, send-text fails, names send-keys and types nothing.
#[test]
fn cli_text_fails_on_a_start_question_at_the_bound() {
    let h = Harness::new(None);
    let id = h.owner(json!({"op":"start","session":{"kind":"claude","project":h.home,"args":["--fixture-dialog"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.until(|| h.screen(&id).contains("Trust this folder?"));
    let out = Harness::env(
        home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro")),
        &h.home,
    )
    .env("NUNCHIRO_SEND_WAIT_MS", "1000")
    .args(["session", "send-text", &id, "hello"])
    .output()
    .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success() && err.contains("start question") && err.contains("send-keys"),
        "{err}"
    );
    h.cli(&["session", "send-keys", &id, "1", "enter"]);
    h.until(|| h.screen(&id).contains("CHOICE:"));
    assert!(h.screen(&id).contains("CHOICE:1"), "{}", h.screen(&id));
}

#[test]
fn long_prompt_submits_on_paste_detecting_claude() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE]);
    h.submit(&id, &long());
    assert!(acked(&h.screen(&id), &long()), "{}", h.screen(&id));
}

#[test]
fn long_prompt_submits_on_paste_detecting_codex() {
    let h = Harness::new(None);
    let id = h.agent("codex", &[PASTE]);
    h.submit(&id, &long());
    assert!(acked(&h.screen(&id), &long()), "{}", h.screen(&id));
}

#[test]
fn multiline_and_korean_prompts_submit() {
    let h = Harness::new(None);
    for kind in ["claude", "codex"] {
        let id = h.agent(kind, &[PASTE]);
        let korean = "변경 내용을 한 줄로 요약해 주세요. "
            .repeat(20)
            .chars()
            .take(230)
            .collect::<String>();
        for text in ["first line\nsecond line\nthird", korean.as_str()] {
            h.submit(&id, text);
            assert!(acked(&h.screen(&id), text), "{kind}: {}", h.screen(&id));
        }
        assert_eq!(h.session(&id)["completion_seq"], 2);
    }
}

#[test]
fn text_and_enter_are_two_writes() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE]);
    let send = h.prompt(&id, &long());
    // The reply is built under the lock right after the text write, before any tick could write the Enter.
    assert_eq!(send["status"], "attempting");
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    h.until(|| h.reads(&id).len() >= 2);
    let reads = h.reads(&id);
    assert_eq!(
        reads,
        [format!("\x1b[200~{}\x1b[201~", long()), "\r".into()],
        "text and Enter must be two reads, text first"
    );
}

#[test]
fn short_prompt_still_submits_and_wait_returns() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[]);
    let start = Instant::now();
    h.submit(&id, "hello");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
    assert!(acked(&h.screen(&id), "hello"));
    // Without bracketed paste the send stays one write and is delivered in its reply, as before.
    let id = h.agent("claude", &[]);
    assert_eq!(h.prompt(&id, "again")["status"], "delivered");
    // A short prompt to the paste-detecting agent submits too.
    let id = h.agent("claude", &[PASTE]);
    h.submit(&id, "hi");
}

#[test]
fn interrupt_cancels_pending_enter() {
    // A silent paste and a long deadline keep the Enter pending until the interrupt, close or exit.
    let h = Harness::new(Some(60_000));
    for how in ["esc", "ctrl+c", "close", "exit"] {
        let id = h.agent("claude", &[PASTE, SILENT]);
        let send = h.prompt(&id, &long());
        assert_eq!(send["status"], "attempting");
        h.until(|| !h.reads(&id).is_empty());
        match how {
            "esc" | "ctrl+c" => {
                h.owner(json!({"op":"agent_keys","id":id,"keys":[how]}))
                    .unwrap();
            }
            "close" => {
                h.owner(json!({"op":"close","id":id})).unwrap();
            }
            _ => {
                let pid = h.session(&id)["pid"].as_u64().unwrap().to_string();
                assert!(Command::new("kill").arg(&pid).status().unwrap().success());
            }
        }
        h.until(|| h.row(&id, &send)["status"] != "attempting");
        let status = h.row(&id, &send)["status"].clone();
        assert!(
            status == "canceled" || status == "failed",
            "{how}: {status}"
        );
        thread::sleep(Duration::from_millis(300));
        assert!(
            !h.reads(&id).iter().any(|r| r == "\r"),
            "{how}: an Enter reached the PTY"
        );
        assert_eq!(h.row(&id, &send)["status"], status);
    }
}

#[test]
fn second_send_waits_for_pending_enter() {
    let h = Harness::new(Some(600));
    let id = h.agent("claude", &[PASTE, SILENT]);
    let first = h.prompt(&id, "first prompt");
    let second = h.prompt(&id, "second prompt");
    assert_eq!(first["status"], "attempting");
    assert_eq!(second["status"], "queued");
    // A model switch would type into the composer and the pending Enter would land in Claude's picker.
    assert!(
        h.owner(json!({"op":"switch_model","id":id,"model":"haiku"}))
            .is_err()
    );
    h.until(|| h.row(&id, &second)["status"] == "delivered");
    h.until(|| h.reads(&id).len() >= 4);
    assert_eq!(
        h.reads(&id),
        [
            "\x1b[200~first prompt\x1b[201~",
            "\r",
            "\x1b[200~second prompt\x1b[201~",
            "\r"
        ]
    );
    // v1a-24: the fixture prints its ACK after logging the read and a hook round trip.
    h.until(|| acked(&h.screen(&id), "first prompt") && acked(&h.screen(&id), "second prompt"));
}

#[test]
fn settle_deadline_sends_enter_and_records_timeout() {
    let h = Harness::new(Some(400));
    let id = h.agent("claude", &[PASTE, SILENT]);
    let start = Instant::now();
    let send = h.prompt(&id, &long());
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    assert!(start.elapsed() >= Duration::from_millis(400));
    assert_eq!(h.row(&id, &send)["settle"], "settle_timeout");
    h.until(|| h.session(&id)["completion_seq"] == 1);
    // An echoed paste does not record a timeout.
    let id = h.agent("claude", &[PASTE]);
    let send = h.prompt(&id, "echoed");
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    assert!(h.row(&id, &send).get("settle").is_none());
}

#[test]
fn wait_stall_clock_starts_at_the_enter_not_the_text() {
    // A settle longer than the CLI's 5 s stall window: `--wait` must still see the turn, not `agent_prompt_stalled`.
    let h = Harness::new(Some(5_500));
    let id = h.agent("claude", &[PASTE, SILENT]);
    h.submit(&id, "slow settle");
    assert_eq!(h.session(&id)["send_log"][0]["settle"], "settle_timeout");
}

/// Ticket 991 C1: an agent that reads late (Claude right after its start) still gets a paste longer than the
/// terminal's 1024-byte input queue whole and at the first try. With the old 100 ms bound a teammate's 2.7 KB brief
/// stopped after 1024 bytes, was marked failed and was never sent.
#[test]
fn a_long_paste_reaches_an_agent_that_reads_late() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE, "--fixture-slow-first-read"]);
    let text = "long brief line\n".repeat(200); // 3.2 KB
    let text = text.trim_end();
    let sent = h.try_submit(&id, text);
    assert!(sent.is_ok(), "{sent:?}");
    h.until(|| h.reads(&id).concat().contains(&text[text.len() - 40..]));
}

#[test]
fn paste_end_marker_and_oversize_prompts_are_refused() {
    let h = Harness::new(None);
    // v1a-24 r4: the agent cannot read the first paste in time, as on a loaded host (main fails so at load ~6).
    let id = h.agent("claude", &[PASTE, "--fixture-stall-first-read"]);
    for text in [
        "early end \x1b[201~ then more".into(),
        "early end \u{9b}201~ then more".into(),
        "x".repeat(100 * 1024),
    ] {
        let r = h.owner(json!({"op":"agent_prompt","id":id,"text":text}));
        assert!(r.is_err(), "{r:?}");
    }
    assert!(h.reads(&id).is_empty());
    // W20-C: a paste longer than the terminal's input queue that the agent does not read within 1.5 s is no longer
    // refused half-written: the holder sends the rest behind it, so it arrives whole at the first try.
    let text = "y".repeat(4 * 1024);
    h.submit(&id, &text);
    h.until(|| h.reads(&id).concat().contains(&text));
}

#[test]
fn dialog_or_picker_drawn_after_the_paste_drops_the_enter() {
    // Enter on a dialog presses its default choice (approve); on the picker it saves a default model.
    let h = Harness::new(None);
    for (flag, reason) in [
        ("--fixture-paste-permission", "enter_dropped_blocked"),
        ("--fixture-paste-picker", "enter_dropped_picker"),
    ] {
        let id = h.agent("claude", &[PASTE, flag]);
        let send = h.prompt(&id, &long());
        assert_eq!(send["status"], "attempting");
        h.until(|| h.row(&id, &send)["status"] != "attempting");
        let row = h.row(&id, &send);
        // Ticket 1094 rules 6-7: the user's own message whose Enter is dropped (dialog, picker, composer) waits queued.
        assert_eq!(row["status"], "queued", "{flag}");
        assert_eq!(row["settle"], reason, "{flag}");
        thread::sleep(Duration::from_millis(300));
        assert!(
            !h.reads(&id).iter().any(|r| r == "\r"),
            "{flag}: an Enter reached the PTY"
        );
        assert_ne!(h.row(&id, &send)["status"], "delivered", "{flag}");
        assert_eq!(
            h.reads(&id)
                .iter()
                .filter(|r| r.contains(&long()[..20]))
                .count(),
            1,
            "{flag}: pasted again into the dialog"
        );
        if reason == "enter_dropped_blocked" {
            assert_eq!(h.session(&id)["pending"][0]["kind"], "permission");
        }
    }
}

#[test]
fn a_dialog_cursor_row_is_not_a_held_paste() {
    // v1a-20: `❯ 1. Yes` is a dialog cursor, not the composer holding the paste; Enter on it would answer Yes.
    let h = Harness::new(Some(300));
    let id = h.agent("claude", &[PASTE, "--fixture-paste-cursor-dialog"]);
    let send = h.prompt(&id, &long());
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "queued"); // ticket 1094 rule 6: the user's dropped message waits
    assert_eq!(row["settle"], "enter_dropped_composer");
    thread::sleep(Duration::from_millis(300));
    assert!(
        !h.reads(&id).iter().any(|r| r == "\r"),
        "an Enter reached the PTY"
    );
    assert_ne!(h.row(&id, &send)["status"], "delivered");
    assert_eq!(
        h.reads(&id)
            .iter()
            .filter(|r| r.contains(&long()[..20]))
            .count(),
        1,
        "pasted again into the dialog"
    );
    assert!(
        h.screen(&id).contains("❯ 1. Yes"),
        "the dialog was answered"
    );
}

#[test]
fn a_collapsed_paste_placeholder_holds_the_paste() {
    // v1a-20 r2: real Claude draws a long paste as `[Pasted text #1 +59 lines]`; that is the composer holding it.
    let h = Harness::new(Some(5_000));
    let id = h.agent("claude", &[PASTE, "--fixture-paste-collapse"]);
    let text: Vec<String> = (1..=60)
        .map(|i| format!("line {i} of a long prompt"))
        .collect();
    let send = h.prompt(&id, &text.join("\n"));
    let start = Instant::now();
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "delivered");
    assert!(row["settle"].is_null(), "{row}");
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "Enter waited for the settle deadline"
    );
    h.until(|| h.reads(&id).iter().any(|r| r == "\r")); // v1a-24: logged after the row is delivered
    assert_eq!(h.reads(&id).iter().filter(|r| *r == "\r").count(), 1);
}

#[test]
fn a_zero_settle_override_does_not_disable_the_settle() {
    // A silent agent with NUNCHIRO_SETTLE_MS=0 still gets its Enter only after the floor, not on the next tick.
    let h = Harness::new(Some(0));
    let id = h.agent("claude", &[PASTE, SILENT]);
    let start = Instant::now();
    let send = h.prompt(&id, &long());
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    assert!(
        start.elapsed() >= Duration::from_millis(250),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_numbered_paste_and_an_undetected_dialog_does_not_get_the_enter() {
    // v1a-24: the dialog's cursor row reads like the paste's start, but it is not in the framed input box.
    let h = Harness::new(Some(300));
    let id = h.agent("claude", &[PASTE, "--fixture-paste-cursor-dialog"]);
    let send = h.prompt(&id, "1. Yes, go ahead with the plan\n2. Then run tests");
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "queued"); // ticket 1094 rule 6: the user's dropped message waits
    assert_eq!(row["settle"], "enter_dropped_composer");
    thread::sleep(Duration::from_millis(300));
    assert!(
        !h.reads(&id).iter().any(|r| r == "\r"),
        "an Enter reached the PTY"
    );
    assert_ne!(h.row(&id, &send)["status"], "delivered");
    assert_eq!(
        h.reads(&id)
            .iter()
            .filter(|r| r.contains(&"1. Yes, go ahead with the plan"[..20]))
            .count(),
        1,
        "pasted again into the dialog"
    );
    assert!(
        h.screen(&id).contains("❯ 1. Yes"),
        "the dialog was answered"
    );
}

#[test]
fn the_fixture_echoes_the_paste_start_and_the_tail_branch_is_gone() {
    // v1a-24: real agents echo the start of a paste; the box shows it and the Enter goes on the echo.
    let h = Harness::new(Some(5_000));
    let id = h.agent("claude", &[PASTE]);
    let send = h.prompt(&id, &long());
    let start = Instant::now();
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    assert_eq!(h.row(&id, &send)["status"], "delivered");
    assert!(start.elapsed() < Duration::from_secs(4), "Enter waited");
    assert!(
        h.screen(&id).contains(&format!("❯ {}", &long()[..40])),
        "{}",
        h.screen(&id)
    );
    // A menu cursor row that matches only the paste's end is not the box holding it.
    let h = Harness::new(Some(300));
    let id = h.agent("claude", &[PASTE, "--fixture-paste-menu"]);
    let send = h.prompt(&id, "Review the plan, then Continue");
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "queued"); // ticket 1094 rule 6: the user's dropped message waits
    assert_eq!(row["settle"], "enter_dropped_composer");
    assert!(!h.reads(&id).iter().any(|r| r == "\r"));
    assert_ne!(h.row(&id, &send)["status"], "delivered");
}

#[test]
fn a_collapsed_codex_paste_placeholder_holds_the_paste() {
    // v1a-24: Codex 0.161.0 draws a paste over 1000 chars as `[Pasted Content <chars> chars]`.
    let h = Harness::new(Some(5_000));
    let id = h.agent("codex", &[PASTE, "--fixture-paste-collapse"]);
    let text: Vec<String> = (1..=60)
        .map(|i| format!("line {i} of a long prompt"))
        .collect();
    let send = h.prompt(&id, &text.join("\n"));
    let start = Instant::now();
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "delivered");
    assert!(row["settle"].is_null(), "{row}");
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "Enter waited for the settle deadline"
    );
    // The fixture logs its read after the core marked the send delivered.
    h.until(|| h.reads(&id).iter().any(|r| r == "\r"));
    assert_eq!(h.reads(&id).iter().filter(|r| *r == "\r").count(), 1);
}

#[test]
fn a_box_above_an_indented_dialog_does_not_get_the_enter() {
    // v1a-24 r2 (review MUST-1): the box really holds the paste, but a dialog shows below it.
    let h = Harness::new(Some(300));
    let id = h.agent("claude", &[PASTE, "--fixture-paste-box-then-dialog"]);
    let send = h.prompt(&id, &long());
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "queued"); // ticket 1094 rule 6: the user's dropped message waits
    assert_eq!(row["settle"], "enter_dropped_composer");
    thread::sleep(Duration::from_millis(300));
    assert!(
        !h.reads(&id).iter().any(|r| r == "\r"),
        "an Enter reached the PTY"
    );
    assert_ne!(h.row(&id, &send)["status"], "delivered");
    assert_eq!(
        h.reads(&id)
            .iter()
            .filter(|r| r.contains(&long()[..20]))
            .count(),
        1,
        "pasted again into the dialog"
    );
    assert!(
        h.screen(&id).contains(" ❯ 1. Yes"),
        "the dialog was answered"
    );
}

#[test]
fn a_number_led_status_line_still_gets_the_enter() {
    // v1a-24 r4 (review r3 SHOULD-2): `45.2% ctx`, `2.1.310` or `45.2% context left` under the box is a status
    // line, not a numbered option; the echoed paste gets its Enter.
    let h = Harness::new(Some(5_000));
    for kind in ["claude", "codex"] {
        let id = h.agent(kind, &[PASTE, "--fixture-status-line"]);
        let send = h.prompt(&id, &long());
        let start = Instant::now();
        h.until(|| h.row(&id, &send)["status"] != "attempting");
        let row = h.row(&id, &send);
        assert_eq!(row["status"], "delivered", "{kind}: {row}");
        assert!(row["settle"].is_null(), "{kind}: {row}");
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "{kind}: Enter waited"
        );
    }
}

/// Home look S1-1: a lead's `agent send <assistant> "<job>"` to an agent submits it (the job was typed and never sent);
/// to a shell it stays the exact text with no Enter.
#[test]
fn s1_1_agent_send_to_an_agent_submits() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE]);
    let r = h.cli(&["agent", "send", &id, "do your job"]);
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    h.until(|| h.reads(&id).len() >= 2);
    assert_eq!(
        h.reads(&id),
        ["\x1b[200~do your job\x1b[201~".to_string(), "\r".into()]
    );
}

/// Look 11-17 v8 N1: an Enter the agent did not take (it came while Claude still drew its first screen) left the
/// prompt in the input box: session "running", chat empty, for minutes. The core looks again: no turn began and the
/// box still holds exactly the sent words, so Enter goes once more. The words are never typed a second time.
#[test]
fn an_enter_the_agent_lost_is_pressed_once_more() {
    const SWALLOW: &str = "--fixture-swallow-enter";
    let h = Harness::new(None);
    // The core's own delivery (a queued or agent send).
    let id = h.agent("claude", &[PASTE, SWALLOW]);
    let send = h.prompt(&id, "make hello.txt");
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    h.until(|| acked(&h.screen(&id), "make hello.txt"));
    assert_eq!(
        h.reads(&id),
        ["\x1b[200~make hello.txt\x1b[201~", "\r", "\r"],
        "one paste, then Enter twice"
    );
    // The window's composer: its text, then its Enter.
    let id = h.agent("claude", &[PASTE, SWALLOW]);
    let composer = |request: Value| {
        let mut request = request;
        request["id"] = json!(id);
        request["composer"] = json!(true);
        h.owner(request).unwrap();
    };
    composer(json!({"op":"send_text","text":"\x1b[200~count the files\x1b[201~"}));
    h.until(|| h.screen(&id).contains("count the files"));
    composer(json!({"op":"send_keys","keys":["enter"]}));
    h.until(|| acked(&h.screen(&id), "count the files"));
    assert_eq!(
        h.reads(&id),
        ["\x1b[200~count the files\x1b[201~", "\r", "\r"]
    );
    // A turn that began gets no second Enter (nor does an empty box).
    thread::sleep(Duration::from_secs(3));
    assert_eq!(h.reads(&id).len(), 3);
}

/// N1's limits: words the user typed into the terminal after the lost Enter are theirs (no Enter from the core), and
/// an agent that never takes the Enter gets it a bounded number of times.
#[test]
fn a_lost_enter_is_not_pressed_over_the_users_own_words_nor_for_ever() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE, "--fixture-swallow-enter"]);
    let send = h.prompt(&id, "make hello.txt");
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    h.owner(json!({"op":"send_text","id":id,"text":" and more"}))
        .unwrap();
    thread::sleep(Duration::from_secs(4));
    assert_eq!(
        h.reads(&id).iter().filter(|r| *r == "\r").count(),
        1,
        "{:?}",
        h.reads(&id)
    );
    // An agent that shows the words and takes no Enter at all is pressed twice more, then left.
    let id = h.agent("claude", &[PASTE, "--fixture-swallow-all-enters"]);
    let send = h.prompt(&id, "make hello.txt");
    h.until(|| h.row(&id, &send)["status"] == "delivered");
    thread::sleep(Duration::from_secs(9));
    assert_eq!(
        h.reads(&id).iter().filter(|r| *r == "\r").count(),
        3,
        "{:?}",
        h.reads(&id)
    );
}

/// Ticket 1121: the screen of a real idle 2.1.331 Builder in auto mode, as the core read it, lost the box's bottom rule
/// and showed its footer in pieces. No box was read, so the Enter was dropped as "composer" after 21 s.
#[test]
fn the_auto_mode_footer_gets_the_enter() {
    let h = Harness::new(None);
    let id = h.agent("claude", &[PASTE, "--fixture-auto-footer"]);
    let start = Instant::now();
    h.submit(&id, "1 new message: run nunchiro agent check");
    assert!(start.elapsed() < Duration::from_secs(4), "Enter waited");
    assert_eq!(h.reads(&id).iter().filter(|r| *r == "\r").count(), 1);
}

/// Ticket 1121: an idle agent whose output is never quiet gets its Enter once the box showed the paste and still
/// shows exactly it past the settle time; before, the paste was dropped and sat typed in the box.
#[test]
fn a_never_quiet_screen_gets_the_enter_on_box_proof() {
    let h = Harness::new(Some(300));
    let id = h.agent("claude", &[PASTE, "--fixture-ticking-footer"]);
    let send = h.prompt(&id, "hello there");
    h.until(|| h.row(&id, &send)["status"] != "attempting");
    let row = h.row(&id, &send);
    assert_eq!(row["status"], "delivered", "{row}");
    h.until(|| h.reads(&id).iter().any(|r| r == "\r"));
    assert_eq!(h.reads(&id).iter().filter(|r| *r == "\r").count(), 1);
    assert!(acked(&h.screen(&id), "hello there"), "{}", h.screen(&id));
}
