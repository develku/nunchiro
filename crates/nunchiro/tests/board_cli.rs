// V2.5-35 (ticket 183): `nunchiro board list|add|move|done|self` against a real core, with session tokens.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command, Output},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("bcli");
        let core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("core.token").exists()
            || UnixStream::connect(h.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn call(&self, token: &str, request: Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.home.join("core.sock")).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        self.call(
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
    /// A shell session that prints its token; started by `token`'s session, or by the owner.
    fn start(&self, token: Option<&str>) -> (String, String) {
        self.start_in(token, &self.home)
    }
    fn start_in(&self, token: Option<&str>, project: &std::path::Path) -> (String, String) {
        let request = json!({"op":"start","session":{"kind":"shell","project":project,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}});
        let reply = match token {
            Some(token) => self.call(token, request),
            None => self.owner(request),
        }
        .unwrap();
        let id = reply["session"]["id"].as_str().unwrap().to_string();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id})).unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            if let Some(line) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return (id, line.trim().into());
            }
            assert!(Instant::now() < until, "no token from {id}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn cli(&self, token: Option<&str>, args: &[&str]) -> Output {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.arg("board")
            .args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN");
        if let Some(t) = token {
            c.env("NUNCHIRO_TOKEN", t);
        }
        c.output().unwrap()
    }
    fn json(&self, token: Option<&str>, args: &[&str]) -> Value {
        let out = self.cli(token, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    /// The window's read.
    fn board(&self) -> Value {
        self.owner(json!({"op":"board_snapshot"})).unwrap()["board"].clone()
    }
    fn card(&self, id: &str) -> Value {
        self.board()["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    }
    /// The history name of a session: its label, or its id when the label is empty.
    fn label(&self, id: &str) -> String {
        let snap = self.owner(json!({"op":"snapshot"})).unwrap();
        let label = snap["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["label"]
            .as_str()
            .unwrap()
            .to_string();
        if label.is_empty() { id.into() } else { label }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op": "stop"}));
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn last(card: &Value) -> Value {
    card["history"].as_array().unwrap().last().unwrap().clone()
}
fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into()
}

#[test]
fn board_cli_round_trip() {
    let h = Harness::new();
    let (coord, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    // Labelled, so history shows the label rather than the id.
    h.owner(json!({"op": "label", "id": coord, "label": "lead"}))
        .unwrap();
    let label = h.label(&coord);
    assert_eq!(label, "lead");
    let card = h.json(
        Some(&coord_token),
        &[
            "add",
            "Lane A",
            "--group",
            "V2.5",
            "--ref",
            "docs/tickets/183.md",
            "--attach",
            &worker,
            "--role",
            "build",
            "--json",
        ],
    );
    let id = card["id"].as_str().unwrap().to_string();
    let got = h.card(&id);
    assert_eq!(got["column"], "todo");
    assert_eq!(got["group"], "V2.5");
    assert_eq!(got["ref"], "docs/tickets/183.md");
    assert_eq!(got["attachments"][0]["session_id"], worker.as_str());
    assert_eq!(got["attachments"][0]["role"], "build");
    assert_eq!(got["history"][0]["actor"], label.as_str());
    // The coordinator moves it; the window sees the move under its label.
    let out = h.cli(Some(&coord_token), &["move", &id, "Working"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(h.card(&id)["column"], "working");
    assert_eq!(last(&h.card(&id))["actor"], label.as_str());
    // The worker moves its own card too.
    let out = h.cli(Some(&worker_token), &["move", &id, "review"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(last(&h.card(&id))["actor"], h.label(&worker).as_str());
    // Done with a receipt.
    let done = h.json(
        Some(&coord_token),
        &[
            "done",
            &id,
            "--receipt",
            "abc1234 · cargo test · 12 passed",
            "--json",
        ],
    );
    assert_eq!(done["column"], "done");
    let got = h.card(&id);
    assert_eq!(got["column"], "done");
    assert_eq!(
        got["receipt"],
        json!({"sha": "abc1234", "command": "cargo test", "result": "12 passed"})
    );
    assert_eq!(last(&got)["actor"], label.as_str());
    // `list` shows it as one line, and `--json` is the window's snapshot.
    let out = h.cli(Some(&worker_token), &["list"]);
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(text.lines().count(), 1, "{text}");
    assert!(
        text.starts_with(&format!("{id}\tdone\tLane A\tV2.5\tdocs/tickets/183.md\t")),
        "{text}"
    );
    assert!(
        text.trim_end()
            .ends_with("abc1234 · cargo test · 12 passed"),
        "{text}"
    );
    assert_eq!(
        h.json(None, &["list", "--json"])["cards"],
        h.board()["cards"]
    );
}

#[test]
fn board_rights_refuse_other_card() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (w1, _) = h.start(Some(&coord_token));
    let (_, w2_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane 1", "--attach", &w1, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let out = h.cli(Some(&w2_token), &["move", &id, "done"]);
    assert!(!out.status.success());
    assert_eq!(
        stderr(&out),
        "nunchiro: not attached to this card: a session moves only its own card\n"
    );
    let got = h.card(&id);
    assert_eq!(got["column"], "todo");
    assert_eq!(last(&got)["kind"], "refused");
    // A worker adds nothing.
    let out = h.cli(Some(&w2_token), &["add", "Mine now"]);
    assert!(
        stderr(&out).starts_with("nunchiro: not the coordinator"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn board_done_needs_receipt() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let out = h.cli(Some(&worker_token), &["done", &id]);
    assert!(!out.status.success());
    assert_eq!(
        stderr(&out),
        "nunchiro: receipt missing · stopped in Review on the way to Done (sha, command, result needed)\n"
    );
    let got = h.card(&id);
    assert_eq!(got["column"], "review");
    let history = got["history"].as_array().unwrap();
    assert_eq!(
        history[history.len() - 2]["reason"],
        "receipt needed (sha, command, result)"
    );
    // The owner's done (the window's request) needs none.
    let out = h.cli(None, &["done", &id]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(h.card(&id)["column"], "done");
    assert_eq!(last(&h.card(&id))["actor"], "owner");
}

#[test]
fn board_self_prints_attached_card() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &[
            "add", "Lane", "--attach", &worker, "--role", "review", "--json",
        ],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let out = h.cli(Some(&worker_token), &["self"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).starts_with(&format!("{id}\ttodo\tLane\t")));
    assert_eq!(
        h.json(Some(&worker_token), &["self", "--json"])["id"],
        id.as_str()
    );
    // No attached card: a clear line, exit 0; `--json` gives null.
    let out = h.cli(Some(&coord_token), &["self"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "no card is attached to this session\n"
    );
    assert_eq!(h.json(Some(&coord_token), &["self", "--json"]), Value::Null);
    // Outside a session there is no "self".
    assert!(!h.cli(None, &["self"]).status.success());
}

#[test]
fn board_cli_errors() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, _) = h.start(Some(&coord_token));
    let a = h.json(
        Some(&coord_token),
        &["add", "A", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = h.json(
        Some(&coord_token),
        &["add", "B", "--waits-on", &a, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(h.card(&b)["waits_on"], json!([a]));
    let before = h.board();
    for (args, line) in [
        (
            vec!["move", "nosuchcard", "working"],
            "board card not found: nosuchcard",
        ),
        (
            vec!["move", a.as_str(), "nosuchcolumn"],
            "board column not found: nosuchcolumn",
        ),
        (
            vec!["done", a.as_str(), "--receipt", "abc1234 cargo test ok"],
            "malformed --receipt",
        ),
        (
            vec!["add", "C", "--waits-on", "nosuchcard"],
            "waits_on card not found: nosuchcard",
        ),
        (
            vec!["add", "C", "--attach", "nosuchsession"],
            "attached session not found: nosuchsession",
        ),
    ] {
        let out = h.cli(Some(&coord_token), &args);
        assert!(!out.status.success(), "{args:?}");
        let err = stderr(&out);
        assert_eq!(err.lines().count(), 1, "{args:?}: {err}");
        assert!(
            err.starts_with(&format!("nunchiro: {line}")),
            "{args:?}: {err}"
        );
    }
    // A `--waits-on` that would close a cycle is refused by the model (184); `add` can only make a new card,
    // which nothing waits on yet, so the cycle is driven through the same task write the CLI's add uses.
    let cycle = h
        .call(
            &coord_token,
            json!({"op": "board_task_put", "id": a, "waits_on": [b]}),
        )
        .unwrap_err();
    assert_eq!(cycle, "waits_on would make a cycle");
    // Nothing was written: no card, no history entry, no field changed.
    assert_eq!(h.board()["cards"], before["cards"]);
}

#[test]
fn board_rights_no_token_escalation() {
    let h = Harness::new();
    let (coord, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    // No request field names the caller: a worker naming the coordinator is still the worker.
    let err = h
        .call(&worker_token, json!({"op": "board_add", "title": "x", "caller": coord, "session_id": coord, "coordinator": true}))
        .unwrap_err();
    assert!(err.starts_with("not the coordinator"), "{err}");
    // An owner token used from inside a session is that session's caller (v1a-23), not the owner: the worker,
    // with the session token removed, still cannot add a card.
    let out = h.home.join("inside.txt");
    let script = r#"env -u NUNCHIRO_TOKEN "$1" board add Inside > "$3.tmp" 2>&1; echo "exit $?" >> "$3.tmp"; mv "$3.tmp" "$3"; exec sleep 30"#;
    h.call(
        &worker_token,
        json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c",script,"inside",env!("CARGO_BIN_EXE_nunchiro"),h.home,out]}}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(20);
    while !out.exists() {
        assert!(Instant::now() < until, "inside add never answered");
        thread::sleep(Duration::from_millis(50));
    }
    let raw = fs::read_to_string(&out).unwrap();
    // The inside session has no children: refused as a session, where the owner would have succeeded.
    assert!(raw.contains("nunchiro: not the coordinator"), "{raw}");
    assert!(raw.ends_with("exit 1\n"), "{raw}");
    assert!(
        !h.board()["cards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["title"] == "Inside")
    );
    // A forged token is refused outright.
    assert!(!h.cli(Some("forged"), &["list"]).status.success());
    let _ = worker;
}

#[test]
fn board_owner_only_requests_stay_refused() {
    let h = Harness::new();
    let (coord, coord_token) = h.start(None);
    let (worker, _) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let revision = h.board()["revision"].clone();
    // Even the coordinator: delete, undo, seen, columns, resolve and the integration sources stay the owner's.
    for request in [
        json!({"op": "board_delete", "id": id}),
        json!({"op": "board_undo", "id": id}),
        json!({"op": "board_seen", "id": coord, "completion_seq": 0}),
        json!({"op": "board_columns_put", "revision": revision, "columns": []}),
        json!({"op": "board_resolve", "identity": id, "updated_at": 0}),
        json!({"op": "board_source_status", "name": "gh"}),
        json!({"op": "board_source_move", "name": "gh", "id": "1", "column": "done"}),
    ] {
        assert_eq!(
            h.call(&coord_token, request.clone()),
            Err("operation not granted".into()),
            "{request}"
        );
    }
    // A source grant becomes a waiting item for the owner, never a grant.
    let grant = h.call(
        &coord_token,
        json!({"op": "board_source_grant", "name": "gh", "level": "read", "hash": "0"}),
    );
    assert!(
        grant.as_ref().map_or(true, |r| r.get("item").is_some()),
        "{grant:?}"
    );
    assert!(h.card(&id)["can_undo"].as_bool().unwrap());
    // The owner keeps all of them.
    h.owner(json!({"op": "board_undo", "id": id})).unwrap();
    h.owner(json!({"op": "board_delete", "id": id})).unwrap();
}

// Round 2 (security review): a stored card with control characters (written before the check, or by the owner)
// prints escaped, never raw, in `board list` and `board self`.
#[test]
fn board_list_escapes_control_characters() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.owner(json!({"op": "board_put", "id": id, "title": "T\u{1b}[2J\u{9b}x", "session_id": null, "column": null}))
        .unwrap();
    h.owner(json!({"op": "board_task_put", "id": id, "group": "g\u{7}", "ref": "r\tq", "attachments": [{"session_id": worker, "role": "b\u{1b}]0;x"}]}))
        .unwrap();
    for (token, args) in [
        (None, vec!["list"]),
        (Some(worker_token.as_str()), vec!["self"]),
    ] {
        let out = h.cli(token, &args);
        assert!(out.status.success(), "{}", stderr(&out));
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            !text
                .trim_end_matches('\n')
                .chars()
                .any(|c| c.is_control() && c != '\t'),
            "{text:?}"
        );
        let fields: Vec<&str> = text.trim_end().split('\t').collect();
        assert_eq!(fields[2], "T\\u{1b}[2J\\u{9b}x", "{text:?}");
        assert_eq!(fields[3], "g\\u{7}");
        assert_eq!(fields[4], "r\\u{9}q");
        assert!(fields[5].ends_with(":b\\u{1b}]0;x"), "{text:?}");
    }
}

// Round 2: a session on another machine (`forwarded`, V1A-06) reaches no board verb: `check_owned` grants remote
// callers only requests that target a session they own, and no board request targets one.
#[test]
fn board_remote_callers_refused() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, _) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let before = h.board();
    for request in [
        json!({"op": "board_snapshot"}),
        json!({"op": "board_self"}),
        json!({"op": "board_add", "title": "remote"}),
        json!({"op": "board_put", "id": null, "title": "remote", "session_id": null, "column": null}),
        json!({"op": "board_move", "source": "manual", "id": id, "column": "done"}),
        json!({"op": "board_task_put", "id": id, "group": "R"}),
        json!({"op": "board_done", "id": id, "receipt": {"sha": "a", "command": "b", "result": "c"}}),
    ] {
        let reply = h.owner(json!({"op": "forwarded", "caller": {"id": "remote-a", "project": h.home}, "request": request}));
        assert_eq!(reply, Err("operation not granted".into()), "{request}");
    }
    assert_eq!(h.board()["cards"], before["cards"]);
}

// Board text safety (V2.5-35 follow-up): stored bidi and zero-width marks (the owner's, or from before the check)
// print escaped in `board list` and `board self`.
#[test]
fn board_list_escapes_hidden_characters() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.owner(json!({"op": "board_put", "id": id, "title": "ev\u{202e}orppa", "session_id": null, "column": null}))
        .unwrap();
    h.owner(json!({"op": "board_task_put", "id": id, "group": "g\u{200b}x", "ref": "r\u{2066}q\u{2069}", "attachments": [{"session_id": worker, "role": "b\u{200d}\u{feff}"}]}))
        .unwrap();
    for (token, args) in [
        (None, vec!["list"]),
        (Some(worker_token.as_str()), vec!["self"]),
    ] {
        let out = h.cli(token, &args);
        assert!(out.status.success(), "{}", stderr(&out));
        let text = String::from_utf8(out.stdout).unwrap();
        let fields: Vec<&str> = text.trim_end().split('\t').collect();
        assert_eq!(fields[2], "ev\\u{202e}orppa", "{text:?}");
        assert_eq!(fields[3], "g\\u{200b}x");
        assert_eq!(fields[4], "r\\u{2066}q\\u{2069}");
        assert!(fields[5].ends_with(":b\\u{200d}\\u{feff}"), "{text:?}");
    }
}

// V2.5-35 hidden-chars: `--json` keeps stored text but writes hidden characters as `\uXXXX` escapes.
#[test]
fn board_json_escapes_hidden() {
    let h = Harness::new();
    let (_, coord_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coord_token));
    let id = h.json(
        Some(&coord_token),
        &["add", "Lane", "--attach", &worker, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    // DEL and C1 (U+009B is a one-byte CSI) are controls serde writes raw; they get the same escape.
    let title = "a\u{202E}b\u{E0041}c\u{061C}d\u{7F}e\u{9B}31m";
    h.owner(
        json!({"op": "board_put", "id": id, "title": title, "session_id": null, "column": null}),
    )
    .unwrap();
    for (token, args) in [
        (None, vec!["list", "--json"]),
        (Some(worker_token.as_str()), vec!["self", "--json"]),
    ] {
        let out = h.cli(token, &args);
        assert!(out.status.success(), "{}", stderr(&out));
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            !text
                .trim_end()
                .chars()
                .any(|c| c.is_control() || nunchiro_core::board::rights::hidden(c)),
            "{text:?}"
        );
        assert!(
            text.contains(r"a\u202eb\udb40\udc41c\u061cd\u007fe\u009b31m"),
            "{text:?}"
        );
        let value: Value = serde_json::from_str(&text).unwrap();
        let card = if args[0] == "self" {
            value
        } else {
            value["cards"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == id.as_str())
                .unwrap()
                .clone()
        };
        assert_eq!(card["title"], title);
    }
}

// V2.5-69 (ticket 289, needs 208): the agent card CLI. `create` is `add` with a column and a one-line why; `note`
// rewrites the why; `next` and `needs-you` name the watch columns for whatever columns the board has.
#[test]
fn agent_cli_places_next_card() {
    let h = Harness::new();
    let (coord, coord_token) = h.start(None);
    let (_worker, _) = h.start(Some(&coord_token));
    // A queued lane goes to Next with its why; no flag, no column: the first column, where Next is derived from.
    let next = h.json(
        Some(&coord_token),
        &[
            "create",
            "Lane Q",
            "--why",
            "waits for the schema lane",
            "--json",
        ],
    );
    let id = next["id"].as_str().unwrap().to_string();
    let got = h.card(&id);
    assert_eq!(got["column"], "todo");
    assert_eq!(got["note"], "waits for the schema lane");
    assert_eq!(got["project"], h.home.to_str().unwrap());
    assert_eq!(got["session_id"], coord.as_str());
    // An item blocked on the owner goes to Needs you with its why, in one call.
    let ask = h.json(
        Some(&coord_token),
        &[
            "create",
            "Pick a name",
            "--column",
            "needs-you",
            "--why",
            "two names tie",
            "--json",
        ],
    );
    let ask_id = ask["id"].as_str().unwrap().to_string();
    assert_eq!(h.card(&ask_id)["column"], "needs-decision");
    assert_eq!(h.card(&ask_id)["note"], "two names tie");
    // `add` keeps working as the alias.
    let added = h.json(Some(&coord_token), &["add", "Old way", "--json"]);
    assert_eq!(h.card(added["id"].as_str().unwrap())["column"], "todo");
    // `note` rewrites the why; `move ... next` goes back to the column Next is derived from.
    let out = h.cli(Some(&coord_token), &["note", &id, "schema lane merged"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(h.card(&id)["note"], "schema lane merged");
    assert_eq!(h.card(&id)["column"], "todo");
    let out = h.cli(Some(&coord_token), &["move", &ask_id, "next"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(h.card(&ask_id)["column"], "todo");
    // One line: a why with a line break is refused and writes nothing.
    let before = h.board()["cards"].as_array().unwrap().len();
    let out = h.cli(
        Some(&coord_token),
        &["create", "Two lines", "--why", "a\nb"],
    );
    assert!(!out.status.success());
    assert!(stderr(&out).contains("one line"), "{}", stderr(&out));
    assert_eq!(h.board()["cards"].as_array().unwrap().len(), before);
    // An unknown column is refused before anything is written.
    let before = h.board()["cards"].as_array().unwrap().len();
    let out = h.cli(
        Some(&coord_token),
        &["create", "Nowhere", "--column", "later"],
    );
    assert!(
        stderr(&out).contains("board column not found: later"),
        "{}",
        stderr(&out)
    );
    assert_eq!(h.board()["cards"].as_array().unwrap().len(), before);
    // The history names the writer.
    assert_eq!(last(&h.card(&id))["kind"], "edit");
}

#[test]
fn agent_cannot_move_other_project_cards() {
    let h = Harness::new();
    let elsewhere = h.home.join("other-project");
    fs::create_dir_all(&elsewhere).unwrap();
    let (_coord, coord_token) = h.start(None);
    let (_kid, _) = h.start(Some(&coord_token));
    // The owner puts a card in another project (its session lives there).
    let (outsider, _) = h.start_in(None, &elsewhere);
    let id = h.json(
        None,
        &["create", "Not yours", "--attach", &outsider, "--json"],
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    for args in [
        vec!["move", id.as_str(), "working"],
        vec!["note", id.as_str(), "mine now"],
        vec!["done", id.as_str(), "--receipt", "abc1234 · true · ok"],
    ] {
        let out = h.cli(Some(&coord_token), &args);
        assert!(!out.status.success(), "{args:?}");
        assert_eq!(
            stderr(&out),
            "nunchiro: card is in another project than your child sessions\n",
            "{args:?}"
        );
    }
    let got = h.card(&id);
    assert_eq!(got["column"], "todo");
    assert_eq!(got["note"], "");
    assert_eq!(last(&got)["kind"], "refused");
    // Creating a card that attaches another project's session is refused too, and leaves no card.
    let before = h.board()["cards"].as_array().unwrap().len();
    let out = h.cli(
        Some(&coord_token),
        &["create", "Smuggled", "--attach", &outsider, "--why", "x"],
    );
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("outside your child sessions"),
        "{}",
        stderr(&out)
    );
    assert_eq!(h.board()["cards"].as_array().unwrap().len(), before);
}

// V2.5-69 (ticket 289): `--help` and docs/cli.md agree on the board verbs, and `board --help` names each of them.
#[test]
fn cli_docs_match_help_for_board() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = Command::new("sh")
        .arg(root.join("scripts/check-cli-docs.sh"))
        .env("NUNCHIRO_BIN", env!("CARGO_BIN_EXE_nunchiro"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let help = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["board", "--help"])
        .output()
        .unwrap();
    let help = String::from_utf8_lossy(&help.stdout).to_string();
    for verb in ["create", "add", "move", "done", "note", "self", "list"] {
        assert!(help.contains(&format!("nunchiro board {verb} ")), "{verb}");
    }
    let docs = fs::read_to_string(root.join("docs/cli.md")).unwrap();
    for verb in ["create", "add", "note"] {
        assert!(
            docs.contains(&format!("### `nunchiro board {verb} ")),
            "{verb}"
        );
    }
}
