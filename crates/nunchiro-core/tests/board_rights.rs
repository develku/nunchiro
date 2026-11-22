//! Ticket 183 (V2.5-35): who may write which board card (`board::rights`), on synthetic registries.
use nunchiro_core::{
    api::*,
    board::{
        self,
        rights::{RECEIPT_NEEDED, Writer, serve},
    },
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "board-rights-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn send(
        &self,
        sessions: &[Session],
        writer: Writer,
        request: Value,
    ) -> Result<board::Snapshot, String> {
        match serve(
            &self.0,
            sessions,
            writer,
            serde_json::from_value(request).unwrap(),
        )? {
            Reply::BoardSnapshot { board } => Ok(board),
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    /// `title` added by `writer`, attached to `attach` (build role); returns its id.
    fn add(&self, sessions: &[Session], writer: Writer, title: &str, attach: &[&str]) -> String {
        let board = self
            .send(sessions, writer, json!({"op": "board_put", "id": null, "title": title, "session_id": null, "column": null}))
            .unwrap();
        let id = board
            .cards
            .iter()
            .rev()
            .find(|c| c["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        if !attach.is_empty() {
            let attachments: Vec<Value> = attach
                .iter()
                .map(|s| json!({"session_id": s, "role": "build"}))
                .collect();
            self.send(
                sessions,
                writer,
                json!({"op": "board_task_put", "id": id, "attachments": attachments}),
            )
            .unwrap();
        }
        id
    }
    fn card(&self, sessions: &[Session], id: &str) -> Value {
        let board = self
            .send(sessions, Writer::Owner, json!({"op": "board_snapshot"}))
            .unwrap();
        board.cards.iter().find(|c| c["id"] == id).unwrap().clone()
    }
    fn mv(
        &self,
        sessions: &[Session],
        writer: Writer,
        id: &str,
        column: &str,
    ) -> Result<board::Snapshot, String> {
        self.send(
            sessions,
            writer,
            json!({"op": "board_move", "source": "manual", "id": id, "column": column}),
        )
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn session(id: &str, project: &str, parent: Option<&str>) -> Session {
    let mut s: Session = serde_json::from_value(json!({
        "id": id, "kind": "claude", "project": project, "cwd": project,
        "label": format!("Label {id}"), "state": "running", "pid": 1,
        "agent_session_id": null, "agent_version": null, "untested": false
    }))
    .unwrap();
    s.parent = parent.map(String::from);
    s
}

/// Project /a: coordinator `coord` with workers `w1`, `w2`; project /b: coordinator `bc` with worker `bw`.
fn registry() -> Vec<Session> {
    vec![
        session("coord", "/a", None),
        session("w1", "/a", Some("coord")),
        session("w2", "/a", Some("coord")),
        session("bc", "/b", None),
        session("bw", "/b", Some("bc")),
    ]
}

fn last(card: &Value) -> Value {
    card["history"].as_array().unwrap().last().unwrap().clone()
}

#[test]
fn board_rights_refuse_other_card() {
    let home = Home::new();
    let s = registry();
    let mine = home.add(&s, Writer::Session("coord"), "Mine", &["w1"]);
    let other = home.add(&s, Writer::Session("coord"), "Other", &["w2"]);
    let in_b = home.add(&s, Writer::Session("bc"), "In B", &["bw"]);
    // Its own card moves.
    home.mv(&s, Writer::Session("w1"), &mine, "working")
        .unwrap();
    assert_eq!(home.card(&s, &mine)["column"], "working");
    assert_eq!(last(&home.card(&s, &mine))["actor"], "Label w1");
    // Another lane's card, and a card in another project, do not; the refusal names why and is in history.
    for id in [&other, &in_b] {
        let err = home
            .mv(&s, Writer::Session("w1"), id, "review")
            .unwrap_err();
        assert_eq!(
            err,
            "not attached to this card: a session moves only its own card"
        );
        let card = home.card(&s, id);
        assert_eq!(card["column"], "todo", "{card}");
        let entry = last(&card);
        assert_eq!(entry["kind"], "refused");
        assert_eq!(entry["actor"], "Label w1");
        assert_eq!(entry["to"], "review");
        assert_eq!(entry["reason"], err.as_str());
        // The owner can undo past it: the refusal did not change the card.
    }
    // A worker adds or edits nothing.
    let err = home
        .send(&s, Writer::Session("w1"), json!({"op": "board_put", "id": null, "title": "x", "session_id": null, "column": null}))
        .unwrap_err();
    assert!(err.starts_with("not the coordinator"), "{err}");
    let err = home
        .send(
            &s,
            Writer::Session("w1"),
            json!({"op": "board_task_put", "id": mine, "group": "M9"}),
        )
        .unwrap_err();
    assert!(err.starts_with("not the coordinator"), "{err}");
    assert_eq!(home.card(&s, &mine)["group"], "");
}

#[test]
fn board_rights_coordinator_other_project_refused() {
    let home = Home::new();
    let s = registry();
    let in_b = home.add(&s, Writer::Session("bc"), "In B", &["bw"]);
    let in_a = home.add(&s, Writer::Session("coord"), "In A", &["w1"]);
    let err = home
        .mv(&s, Writer::Session("coord"), &in_b, "working")
        .unwrap_err();
    assert_eq!(err, "card is in another project than your child sessions");
    assert_eq!(last(&home.card(&s, &in_b))["kind"], "refused");
    let err = home
        .send(
            &s,
            Writer::Session("coord"),
            json!({"op": "board_task_put", "id": in_b, "group": "M1"}),
        )
        .unwrap_err();
    assert_eq!(err, "card is in another project than your child sessions");
    // Nor can it pull a session of B onto its own card.
    let err = home
        .send(&s, Writer::Session("coord"), json!({"op": "board_task_put", "id": in_a, "attachments": [{"session_id": "bw", "role": "build"}]}))
        .unwrap_err();
    assert_eq!(
        err,
        "the card would link a session outside your child sessions' projects"
    );
    // Not even a session of B that has ended (its own card would vanish from B's lane).
    let mut ended = s.clone();
    ended.push(session("gone", "/b", None));
    ended.last_mut().unwrap().state = SessionState::Exited;
    let err = home
        .send(
            &ended,
            Writer::Session("coord"),
            json!({"op": "board_task_put", "id": in_a, "attachments": [{"session_id": "gone", "role": "build"}]}),
        )
        .unwrap_err();
    assert_eq!(
        err,
        "the card would link a session outside your child sessions' projects"
    );
    // Within its project it writes every card, Done included (with a receipt).
    home.send(&s, Writer::Session("coord"), json!({"op": "board_done", "id": in_a, "receipt": {"sha": "abc1234", "command": "cargo test", "result": "ok"}}))
        .unwrap();
    assert_eq!(home.card(&s, &in_a)["column"], "done");
}

#[test]
fn board_coordinator_from_parent_link_only() {
    let home = Home::new();
    let mut s = registry();
    // A session with no live child is no coordinator, whatever the request says: there is no caller field,
    // and an unknown key is ignored, not believed.
    let request: Request = serde_json::from_value(
        json!({"op": "board_put", "id": null, "title": "x", "session_id": null, "column": null, "caller": "coord", "coordinator": true}),
    )
    .unwrap();
    let err = serve(&home.0, &s, Writer::Session("w1"), request).unwrap_err();
    assert!(err.starts_with("not the coordinator"), "{err}");
    // Linking itself to the coordinator's card does not lend it the coordinator's rights.
    let err = home
        .send(&s, Writer::Session("w1"), json!({"op": "board_put", "id": null, "title": "x", "session_id": "coord", "column": null}))
        .unwrap_err();
    assert!(err.starts_with("not the coordinator"), "{err}");
    // A child that is not live gives no rights; a live one does.
    s.push(session("kid", "/a", Some("w1")));
    s.last_mut().unwrap().state = SessionState::Exited;
    assert!(
        home.send(
            &s,
            Writer::Session("w1"),
            json!({"op": "board_put", "id": null, "title": "x", "session_id": null, "column": null})
        )
        .is_err()
    );
    s.last_mut().unwrap().state = SessionState::Running;
    home.send(
        &s,
        Writer::Session("w1"),
        json!({"op": "board_put", "id": null, "title": "x", "session_id": null, "column": null}),
    )
    .unwrap();
}

#[test]
fn board_coordinator_lost_when_children_gone() {
    let home = Home::new();
    let mut s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    home.mv(&s, Writer::Session("coord"), &card, "working")
        .unwrap();
    for worker in &mut s {
        if worker.parent.as_deref() == Some("coord") {
            worker.state = SessionState::Exited;
        }
    }
    let err = home
        .mv(&s, Writer::Session("coord"), &card, "review")
        .unwrap_err();
    assert!(err.starts_with("not attached to this card"), "{err}");
    assert_eq!(home.card(&s, &card)["column"], "working");
    // A dead caller writes nothing either.
    let err = home
        .mv(&s, Writer::Session("w1"), &card, "review")
        .unwrap_err();
    assert_eq!(err, "caller session is not live");
}

#[test]
fn board_done_needs_receipt() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    // An agent's done without a receipt stops in Review, with the reason in history.
    home.send(
        &s,
        Writer::Session("w1"),
        json!({"op": "board_done", "id": card}),
    )
    .unwrap();
    let got = home.card(&s, &card);
    assert_eq!(got["column"], "review", "{got}");
    let history = got["history"].as_array().unwrap();
    let refused = &history[history.len() - 2];
    assert_eq!(refused["kind"], "refused");
    assert_eq!(refused["to"], "done");
    assert_eq!(refused["reason"], RECEIPT_NEEDED);
    assert_eq!(last(&got)["kind"], "move");
    assert_eq!(last(&got)["to"], "review");
    // So does a plain move into the proof column, the coordinator's included.
    home.mv(&s, Writer::Session("coord"), &card, "done")
        .unwrap();
    assert_eq!(home.card(&s, &card)["column"], "review");
    // With a receipt it lands in Done and keeps the receipt.
    home.send(&s, Writer::Session("w1"), json!({"op": "board_done", "id": card, "receipt": {"sha": "abc1234", "command": "cargo test", "result": "12 passed"}}))
        .unwrap();
    let got = home.card(&s, &card);
    assert_eq!(got["column"], "done");
    assert_eq!(got["receipt"]["result"], "12 passed");
    // The same move from the window needs no receipt.
    let window = home.add(&s, Writer::Owner, "Window", &[]);
    home.send(&s, Writer::Owner, json!({"op": "board_done", "id": window}))
        .unwrap();
    assert_eq!(home.card(&s, &window)["column"], "done");
    assert_eq!(last(&home.card(&s, &window))["actor"], "owner");
    let moved = home.add(&s, Writer::Owner, "Moved", &[]);
    home.mv(&s, Writer::Owner, &moved, "done").unwrap();
    assert_eq!(home.card(&s, &moved)["column"], "done");
}

#[test]
fn board_receipt_text_capped_and_plain() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    let before = home.card(&s, &card);
    let done = |sha: &str, command: &str, result: &str| {
        home.send(&s, Writer::Session("w1"), json!({"op": "board_done", "id": card, "receipt": {"sha": sha, "command": command, "result": result}}))
    };
    for (sha, command, result) in [
        ("abc", "cargo test\u{1b}[31m", "ok"),
        ("abc", "cargo test", "ok\nfake line"),
        ("abc\u{7}", "cargo test", "ok"),
        ("", "cargo test", "ok"),
    ] {
        assert!(
            done(sha, command, result).is_err(),
            "{command:?} {result:?}"
        );
    }
    let long = "x".repeat(board::rights::RECEIPT_FIELD_MAX + 1);
    assert!(done("abc", &long, "ok").unwrap_err().contains("4096"));
    // Refused receipts wrote nothing.
    assert_eq!(home.card(&s, &card), before);
    // The task write path takes the same check.
    assert!(home
        .send(&s, Writer::Owner, json!({"op": "board_task_put", "id": card, "receipt": {"sha": "a", "command": "b\u{0}", "result": "c"}}))
        .is_err());
    // Markup is kept as plain text, byte for byte (the window renders text, never HTML).
    done("abc", "<img src=x onerror=alert(1)>", "<b>ok</b>").unwrap();
    let got = home.card(&s, &card);
    assert_eq!(got["receipt"]["command"], "<img src=x onerror=alert(1)>");
    assert_eq!(got["receipt"]["result"], "<b>ok</b>");
}

#[test]
fn board_owner_only_requests_stay_refused() {
    // Second wall: `check_agent` refuses these first (tests/board_cli.rs over the socket).
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    for request in [
        json!({"op": "board_delete", "id": card}),
        json!({"op": "board_undo", "id": card}),
        json!({"op": "board_seen", "id": "w1", "completion_seq": 0}),
        json!({"op": "board_columns_put", "revision": "", "columns": []}),
    ] {
        assert_eq!(
            home.send(&s, Writer::Session("coord"), request.clone())
                .unwrap_err(),
            "operation not granted",
            "{request}"
        );
    }
    assert!(home.card(&s, &card)["can_undo"].as_bool().unwrap());
}

// Round 2 (security review): agent-written text is plain; control characters never reach the owner's terminal.
#[test]
fn board_agent_text_fields_plain() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    let before = home.card(&s, &card);
    for request in [
        json!({"op": "board_put", "id": null, "title": "x\u{1b}[2J", "session_id": null, "column": null}),
        json!({"op": "board_put", "id": card, "title": "Lane", "note": "a\u{7}", "session_id": "coord", "column": null}),
        json!({"op": "board_add", "title": "y\u{1b}]0;pwn\u{7}"}),
        json!({"op": "board_add", "title": "ok", "group": "g\u{1b}"}),
        json!({"op": "board_add", "title": "ok", "ref": "r\r"}),
        json!({"op": "board_task_put", "id": card, "group": "M\u{9b}1"}),
        json!({"op": "board_task_put", "id": card, "ref": "docs/\u{0}x"}),
        json!({"op": "board_task_put", "id": card, "attachments": [{"session_id": "w1", "role": "b\u{1b}[31m"}]}),
    ] {
        let err = home
            .send(&s, Writer::Session("coord"), request.clone())
            .unwrap_err();
        assert_eq!(
            err, "board text must be plain: no control characters",
            "{request}"
        );
    }
    assert_eq!(home.card(&s, &card), before);
    assert_eq!(
        home.send(&s, Writer::Owner, json!({"op": "board_snapshot"}))
            .unwrap()
            .cards
            .iter()
            .filter(|c| c["source"] == "manual")
            .count(),
        1
    );
    // A note keeps its line breaks and tabs.
    home.send(&s, Writer::Session("coord"), json!({"op": "board_put", "id": card, "title": "Lane", "note": "line 1\n\tline 2", "session_id": "coord", "column": null}))
        .unwrap();
    assert_eq!(home.card(&s, &card)["note"], "line 1\n\tline 2");
    // The owner's window text is not this check's (the window renders text, never a terminal).
    home.send(
        &s,
        Writer::Owner,
        json!({"op": "board_task_put", "id": card, "group": "M\u{1b}"}),
    )
    .unwrap();
}

// Board text safety (V2.5-35 follow-up): bidi and zero-width marks (Trojan Source) are refused like control ones.
const HIDDEN: [char; 8] = [
    '\u{202A}', '\u{202E}', '\u{2066}', '\u{2069}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}',
];

#[test]
fn board_agent_text_refuses_hidden() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    let before = home.card(&s, &card);
    for h in HIDDEN {
        let t = format!("app{h}rove");
        for request in [
            json!({"op": "board_put", "id": card, "title": t, "session_id": "coord", "column": null}),
            json!({"op": "board_put", "id": card, "title": "Lane", "note": t, "session_id": "coord", "column": null}),
            json!({"op": "board_add", "title": t}),
            json!({"op": "board_add", "title": "ok", "group": t}),
            json!({"op": "board_add", "title": "ok", "ref": t}),
            json!({"op": "board_task_put", "id": card, "group": t}),
            json!({"op": "board_task_put", "id": card, "ref": t}),
            json!({"op": "board_task_put", "id": card, "attachments": [{"session_id": "w1", "role": t}]}),
        ] {
            assert_eq!(
                home.send(&s, Writer::Session("coord"), request.clone())
                    .unwrap_err(),
                "board text must be plain: no control characters",
                "{request}"
            );
        }
    }
    assert_eq!(home.card(&s, &card), before);
    // Plain non-ASCII still passes: Korean, accented letters, a single emoji without a joiner.
    let text = "눈치 café 🚀";
    home.send(&s, Writer::Session("coord"), json!({"op": "board_put", "id": card, "title": text, "note": text, "session_id": "coord", "column": null}))
        .unwrap();
    home.send(&s, Writer::Session("coord"), json!({"op": "board_task_put", "id": card, "group": text, "ref": text, "attachments": [{"session_id": "w1", "role": text}]}))
        .unwrap();
    let got = home.card(&s, &card);
    assert_eq!(got["title"], text);
    assert_eq!(got["note"], text);
}

#[test]
fn board_receipt_refuses_hidden() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    let before = home.card(&s, &card);
    for h in HIDDEN {
        let bad = format!("FAIL{h}ok");
        for (sha, command, result) in [
            (bad.as_str(), "cargo test", "ok"),
            ("abc", bad.as_str(), "ok"),
            ("abc", "cargo test", bad.as_str()),
        ] {
            let err = home
                .send(&s, Writer::Session("w1"), json!({"op": "board_done", "id": card, "receipt": {"sha": sha, "command": command, "result": result}}))
                .unwrap_err();
            assert_eq!(
                err, "receipt must be plain text: no control characters",
                "{h:?}"
            );
        }
    }
    // The shared set's later members: the Arabic letter mark and a tag character (V2.5-35 hidden-chars).
    for h in ['\u{061C}', '\u{E0041}'] {
        let bad = format!("FAIL{h}ok");
        let err = home
            .send(&s, Writer::Session("w1"), json!({"op": "board_done", "id": card, "receipt": {"sha": "abc", "command": "cargo test", "result": bad}}))
            .unwrap_err();
        assert_eq!(
            err, "receipt must be plain text: no control characters",
            "{h:?}"
        );
    }
    assert_eq!(home.card(&s, &card), before);
    // The task write path takes the same check.
    assert!(home
        .send(&s, Writer::Owner, json!({"op": "board_task_put", "id": card, "receipt": {"sha": "a", "command": "b", "result": "pass\u{202E}"}}))
        .is_err());
}

// V2.5-35 hidden-chars: tag characters (an invisible ASCII channel a model reads) and the Arabic letter mark.
#[test]
fn board_agent_text_refuses_tags() {
    let home = Home::new();
    let s = registry();
    let card = home.add(&s, Writer::Session("coord"), "Lane", &["w1"]);
    let before = home.card(&s, &card);
    for h in [
        '\u{061C}',
        '\u{E0001}',
        '\u{E0041}',
        '\u{E007F}',
        '\u{202E}',
        '\u{200B}',
        '\u{FEFF}',
    ] {
        let t = format!("app{h}rove");
        for request in [
            json!({"op": "board_put", "id": card, "title": t, "session_id": "coord", "column": null}),
            json!({"op": "board_put", "id": card, "title": "Lane", "note": t, "session_id": "coord", "column": null}),
            json!({"op": "board_add", "title": t}),
            json!({"op": "board_add", "title": "ok", "group": t}),
            json!({"op": "board_add", "title": "ok", "ref": t}),
            json!({"op": "board_task_put", "id": card, "group": t}),
            json!({"op": "board_task_put", "id": card, "ref": t}),
            json!({"op": "board_task_put", "id": card, "attachments": [{"session_id": "w1", "role": t}]}),
        ] {
            assert_eq!(
                home.send(&s, Writer::Session("coord"), request.clone())
                    .unwrap_err(),
                "board text must be plain: no control characters",
                "{request}"
            );
        }
    }
    assert_eq!(home.card(&s, &card), before);
    let text = "눈치 café 🚀";
    home.send(&s, Writer::Session("coord"), json!({"op": "board_put", "id": card, "title": text, "note": text, "session_id": "coord", "column": null}))
        .unwrap();
    home.send(&s, Writer::Session("coord"), json!({"op": "board_task_put", "id": card, "group": text, "ref": text, "attachments": [{"session_id": "w1", "role": text}]}))
        .unwrap();
    assert_eq!(home.card(&s, &card)["title"], text);
}

#[test]
fn board_actor_label_hidden_falls_back() {
    for h in ['\u{202E}', '\u{E0041}'] {
        let home = Home::new();
        let mut s = registry();
        s[0].label = format!("Coord{h}inator");
        let card = home.add(&s, Writer::Session("coord"), "Lane", &[]);
        assert_eq!(last(&home.card(&s, &card))["actor"], "coord", "{h:?}");
    }
}

/// Ticket 990: the seat of a place's lead is the coordinator of its own project also when no worker of its is live
/// (in a real run the lead closed its workers after the merge and could not move their cards to Done). A session
/// that only carries a teammate's mark, or a lead's mark for another project's card, gets nothing from it.
#[test]
fn a_leads_seat_writes_its_projects_cards_with_no_live_worker() {
    use nunchiro_core::{
        api::AgentKind,
        team::{Team, Teammate},
    };
    let home = Home::new();
    let project = home.0.join("a");
    fs::create_dir_all(&project).unwrap();
    let project = fs::canonicalize(project).unwrap();
    let a = project.to_str().unwrap();
    let mate = |name: &str, lead: bool| Teammate {
        id: String::new(),
        name: name.into(),
        job: "x".into(),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project: Some(project.clone()),
        lead,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    };
    let team = Team::open(&home.0);
    team.save(None, mate("Lead", true)).unwrap();
    let all = team.save(None, mate("Helper", false)).unwrap();
    let id = |name: &str| all.iter().find(|t| t.name == name).unwrap().id.clone();
    let mut lead = session("lead", a, None);
    lead.teammate = Some(id("Lead"));
    let mut helper = session("helper", a, None);
    helper.teammate = Some(id("Helper"));
    let mut worker = session("w1", a, Some("lead"));
    let mut s = vec![lead, helper, worker.clone(), session("other", "/b", None)];
    let card = home.add(&s, Writer::Session("lead"), "Lane", &["w1"]);
    // The worker ends: the lead has no live child now.
    worker.state = SessionState::Exited;
    s[2] = worker;
    home.send(&s, Writer::Session("lead"), json!({"op": "board_done", "id": card, "receipt": {"sha": "abc1234", "command": "cargo test", "result": "ok"}}))
        .unwrap();
    assert_eq!(home.card(&s, &card)["column"], "done");
    // A teammate that is not the lead is no coordinator.
    let err = home
        .send(&s, Writer::Session("helper"), json!({"op": "board_put", "id": null, "title": "x", "session_id": null, "column": null}))
        .unwrap_err();
    assert!(err.contains("not the coordinator"), "{err}");
}
