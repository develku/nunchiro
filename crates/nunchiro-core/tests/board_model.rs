//! Ticket 184: card = task model, five default columns, per-card history and undo, board.toml v2.
use nunchiro_core::{api::*, board};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::PathBuf};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "board-model-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn try_as(
        &self,
        sessions: &[Session],
        actor: &str,
        request: Value,
    ) -> Result<board::Snapshot, String> {
        let reply = if matches!(
            request["op"].as_str(),
            Some("board_task_put" | "board_undo")
        ) {
            board::handle_task(
                &self.0,
                sessions,
                serde_json::from_value(request).unwrap(),
                actor,
            )?
        } else {
            board::handle_as(
                &self.0,
                sessions,
                serde_json::from_value(request).unwrap(),
                actor,
            )?
        };
        match reply {
            Reply::BoardSnapshot { board } => Ok(board),
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    fn send(&self, sessions: &[Session], request: Value) -> board::Snapshot {
        self.try_as(sessions, "owner", request).unwrap()
    }
    fn snapshot(&self, sessions: &[Session]) -> board::Snapshot {
        self.send(sessions, json!({"op": "board_snapshot"}))
    }
    fn add(&self, title: &str) -> String {
        let board = self.send(&[], json!({"op": "board_put", "id": null, "title": title, "session_id": null, "column": null}));
        board
            .cards
            .iter()
            .rev()
            .find(|c| c["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn toml(&self) -> PathBuf {
        self.0.join("board.toml")
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn session(id: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "kind": "claude", "project": "/project", "cwd": "/project",
        "label": format!("Label {id}"), "state": "running", "pid": 1,
        "agent_session_id": null, "agent_version": null, "untested": false
    }))
    .unwrap()
}

fn card<'a>(board: &'a board::Snapshot, id: &str) -> &'a Value {
    board.cards.iter().find(|c| c["id"] == id).unwrap()
}

#[test]
fn card_task_fields_round_trip() {
    let home = Home::new();
    let sessions = [session("w1"), session("r1")];
    let other = home.add("other");
    let id = home.add("task");
    let long_ref = format!("https://example.com/{}", "r".repeat(4096 - 20));
    assert_eq!(long_ref.len(), 4096);
    for (group, reference) in [("V2.5 · 보드 🚀", long_ref.as_str()), ("", "")] {
        home.send(&sessions, json!({
            "op": "board_task_put", "id": id, "group": group, "ref": reference,
            "receipt": {"sha": "f112b9f8", "command": "cargo test", "result": "ok 12 passed"},
            "waits_on": [other],
            "attachments": [{"session_id": "w1", "role": "build"}, {"session_id": "r1", "role": ""}],
        }));
        // A fresh handle call reads board.json from disk, as a restarted core does.
        let board = home.snapshot(&sessions);
        let c = card(&board, &id);
        assert_eq!(c["group"], group);
        assert_eq!(c["ref"], reference);
        assert_eq!(
            c["receipt"],
            json!({"sha": "f112b9f8", "command": "cargo test", "result": "ok 12 passed"})
        );
        assert_eq!(c["waits_on"], json!([other]));
        assert_eq!(c["attachments"][0]["session_id"], "w1");
        assert_eq!(c["attachments"][0]["role"], "build");
        assert_eq!(c["attachments"][0]["label"], "Label w1");
        assert_eq!(c["attachments"][1]["role"], "");
    }
    // Omitted fields stay; an explicit null receipt clears it.
    let board = home.send(
        &sessions,
        json!({"op": "board_task_put", "id": id, "receipt": null}),
    );
    assert_eq!(card(&board, &id)["receipt"], Value::Null);
    assert_eq!(card(&board, &id)["waits_on"], json!([other]));
    // A session that is gone keeps its attachment with no label, and resending it is accepted.
    let board = home.snapshot(&[]);
    assert_eq!(card(&board, &id)["attachments"][0]["label"], Value::Null);
    let again = card(&board, &id)["attachments"].clone();
    home.send(
        &[],
        json!({"op": "board_task_put", "id": id, "attachments": again, "group": "kept"}),
    );
    // Limits and missing sessions are refused.
    let too_long = "r".repeat(8193);
    for bad in [
        json!({"op": "board_task_put", "id": id, "ref": too_long}),
        json!({"op": "board_task_put", "id": id, "group": "g".repeat(257)}),
        json!({"op": "board_task_put", "id": id, "attachments": [{"session_id": "nobody", "role": "x"}]}),
        json!({"op": "board_task_put", "id": id, "waits_on": ["missing-card"]}),
    ] {
        assert!(home.try_as(&sessions, "owner", bad).is_err());
    }
}

#[test]
fn board_json_broken_task_fields_refused_unchanged() {
    let home = Home::new();
    let id = home.add("task");
    let path = home.0.join("board.json");
    let good: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (key, value) in [
        ("waits_on", json!("not-a-list")),
        ("waits_on", json!(["../bad id"])),
        ("attachments", json!([{"session_id": "bad id", "role": ""}])),
        ("waits_on", json!(["gone"])),
        ("waits_on", json!([id])),
        (
            "history",
            json!([{"at": 1, "actor": "owner", "kind": "bogus", "from": null, "to": "todo", "reason": null}]),
        ),
    ] {
        let mut broken = good.clone();
        broken["manual"][0][key] = value;
        let bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            home.try_as(&[], "owner", json!({"op": "board_snapshot"}))
                .is_err(),
            "{key}"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn attached_session_has_no_auto_card() {
    let home = Home::new();
    let mut w1 = session("w1");
    w1.attention.working = true; // in a turn (ticket 1090: a seat at its prompt is not working)
    let sessions = [w1, session("free")];
    let id = home.add("task");
    let board = home.send(&sessions, json!({"op": "board_task_put", "id": id, "attachments": [{"session_id": "w1", "role": "build"}]}));
    let ids: Vec<_> = board
        .cards
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&"w1"), "{ids:?}");
    assert!(ids.contains(&"free"));
    assert_eq!(card(&board, &id)["attachments"][0]["state"], "working");
}

/// Ticket 1090: a seat is working only while it is in a turn. A seat that never finished a turn and is not in one (an
/// agent at its first prompt, a shell) counted as working before, so the board said "working" far more than agents ran.
#[test]
fn seat_is_working_only_in_a_turn() {
    let home = Home::new();
    let mut busy = session("busy");
    busy.attention.working = true;
    let sessions = [session("idle"), busy, session("fresh")];
    let id = home.add("task");
    let board = home.send(&sessions, json!({"op": "board_task_put", "id": id, "attachments": [{"session_id": "idle", "role": "build"}, {"session_id": "busy", "role": "review"}]}));
    let task = card(&board, &id);
    assert_ne!(task["attachments"][0]["state"], "working", "an idle seat");
    assert_eq!(
        task["attachments"][1]["state"], "working",
        "a seat in a turn"
    );
    let fresh = card(&board, "fresh");
    assert_ne!(fresh["state"], "working", "a session card with no turn yet");
    assert_ne!(fresh["column"], "working");
}

#[test]
fn seat_with_no_turn_is_neutral() {
    let home = Home::new();
    let mut busy = session("busy");
    busy.attention.working = true;
    let mut ended = session("ended"); // one finished turn, already seen
    ended.completion_seq = 1;
    let sessions = [session("fresh"), session("seat"), busy, ended];
    let id = home.add("task");
    let board = home.send(&sessions, json!({"op": "board_task_put", "id": id, "attachments": [{"session_id": "seat", "role": "build"}]}));
    for state in [
        card(&board, "fresh")["state"].clone(),
        card(&board, &id)["attachments"][0]["state"].clone(),
    ] {
        assert_eq!(state, "idle", "no turn yet is neither Review nor Done");
    }
    assert_eq!(
        card(&board, "fresh")["column"],
        "todo",
        "the neutral column"
    );
    assert_eq!(card(&board, "busy")["state"], "working");
    let board = home.send(
        &sessions,
        json!({"op": "board_seen", "id": "ended", "completion_seq": 1}),
    );
    assert_eq!(
        card(&board, "ended")["state"],
        "done",
        "after its turn is seen, as before"
    );
}

#[test]
fn unattached_session_keeps_auto_card() {
    let home = Home::new();
    let mut w1 = session("w1");
    w1.attention.working = true; // ticket 1090: in a turn
    let sessions = [w1];
    home.add("task");
    let board = home.snapshot(&sessions);
    let auto = card(&board, "w1");
    assert_eq!(auto["source"], "session");
    assert_eq!(auto["column"], "working");
    assert_eq!(auto["title"], "Label w1");
}

#[test]
fn default_five_columns_new_card_todo() {
    let home = Home::new();
    let board = home.snapshot(&[]);
    let titles: Vec<_> = board.columns.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(
        titles,
        ["To do", "Working", "Needs decision", "Review", "Done"]
    );
    let proof: Vec<_> = board.columns.iter().map(|c| c.proof).collect();
    assert_eq!(proof, [false, false, false, false, true]);
    assert!(board.columns[0].states.is_empty());
    let id = home.add("task");
    assert_eq!(card(&home.snapshot(&[]), &id)["column"], "todo");
    assert!(!home.toml().exists());
}

#[test]
fn history_records_and_undo_last() {
    let home = Home::new();
    let id = home.add("task");
    let mv = |actor: &str, column: &str| {
        home.try_as(
            &[],
            actor,
            json!({"op": "board_move", "source": "manual", "id": id, "column": column}),
        )
        .unwrap()
    };
    mv("owner", "working");
    mv("coordinator", "review");
    let board = mv("Label w1", "done");
    let history = card(&board, &id)["history"].as_array().unwrap().clone();
    let moves: Vec<_> = history
        .iter()
        .filter(|h| h["kind"] == "move")
        .map(|h| {
            (
                h["actor"].as_str().unwrap(),
                h["from"].as_str().unwrap(),
                h["to"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        moves,
        [
            ("owner", "todo", "working"),
            ("coordinator", "working", "review"),
            ("Label w1", "review", "done")
        ]
    );
    assert!(history.iter().all(|h| h["at"].as_u64().unwrap() > 0));
    assert_eq!(card(&board, &id)["can_undo"], true);
    let board = home.send(&[], json!({"op": "board_undo", "id": id}));
    assert_eq!(card(&board, &id)["column"], "review");
    assert_eq!(
        card(&board, &id)["history"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["kind"],
        "undo"
    );
    assert_eq!(card(&board, &id)["can_undo"], false);
    // One step: a second undo is refused, as is undo on a card with no change to undo.
    assert!(
        home.try_as(&[], "owner", json!({"op": "board_undo", "id": id}))
            .is_err()
    );
    let fresh = home.add("fresh");
    assert!(
        home.try_as(&[], "owner", json!({"op": "board_undo", "id": fresh}))
            .is_err()
    );
    // A refusal a caller passes is recorded without moving the card.
    board::record_refusal(&home.0, &id, "Label w1", "done", "Done needs a receipt").unwrap();
    let board = home.snapshot(&[]);
    let last = card(&board, &id)["history"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(
        (
            last["kind"].as_str(),
            last["reason"].as_str(),
            last["to"].as_str()
        ),
        (Some("refused"), Some("Done needs a receipt"), Some("done"))
    );
    assert_eq!(card(&board, &id)["column"], "review");
    // Bounded: the last 50 per card.
    for i in 0..60 {
        mv("owner", if i % 2 == 0 { "working" } else { "review" });
    }
    let board = home.snapshot(&[]);
    let history = card(&board, &id)["history"].as_array().unwrap();
    assert_eq!(history.len(), 50);
    assert_eq!(history.last().unwrap()["to"], "review");
}

#[test]
fn waits_on_cycle_refused() {
    let home = Home::new();
    let (a, b, c) = (home.add("a"), home.add("b"), home.add("c"));
    home.send(
        &[],
        json!({"op": "board_task_put", "id": a, "waits_on": [b]}),
    );
    home.send(
        &[],
        json!({"op": "board_task_put", "id": b, "waits_on": [c]}),
    );
    let before = fs::read(home.0.join("board.json")).unwrap();
    for (id, waits) in [(&c, &a), (&a, &a)] {
        let error = home
            .try_as(
                &[],
                "owner",
                json!({"op": "board_task_put", "id": id, "waits_on": [waits]}),
            )
            .unwrap_err();
        assert!(error.contains("cycle"), "{error}");
        assert_eq!(fs::read(home.0.join("board.json")).unwrap(), before);
    }
    // Undo cannot bring a cycle back: c drops its wait on a, b waits on c, undo on c would restore c -> a.
    home.send(
        &[],
        json!({"op": "board_task_put", "id": b, "waits_on": []}),
    );
    home.send(
        &[],
        json!({"op": "board_task_put", "id": c, "waits_on": [a]}),
    );
    home.send(
        &[],
        json!({"op": "board_task_put", "id": c, "waits_on": []}),
    );
    home.send(
        &[],
        json!({"op": "board_task_put", "id": b, "waits_on": [c]}),
    );
    let error = home
        .try_as(&[], "owner", json!({"op": "board_undo", "id": c}))
        .unwrap_err();
    assert!(error.contains("cycle"), "{error}");
    // Deleting a card drops it from every waits_on.
    let board = home.send(&[], json!({"op": "board_delete", "id": b}));
    assert_eq!(card(&board, &a)["waits_on"], json!([]));
}

#[test]
fn last_moved_at_set_on_move() {
    let home = Home::new();
    let id = home.add("task");
    let first = card(&home.snapshot(&[]), &id)["last_moved_at"]
        .as_u64()
        .unwrap();
    assert!(first > 0);
    std::thread::sleep(std::time::Duration::from_millis(5));
    let board = home.send(
        &[],
        json!({"op": "board_move", "source": "manual", "id": id, "column": "working"}),
    );
    let moved = card(&board, &id)["last_moved_at"].as_u64().unwrap();
    assert!(moved > first);
    let history = card(&board, &id)["history"].as_array().unwrap().len();
    std::thread::sleep(std::time::Duration::from_millis(5));
    // A no-op write (same column, same fields) changes nothing.
    let board = home.send(
        &[],
        json!({"op": "board_move", "source": "manual", "id": id, "column": "working"}),
    );
    let board2 = home.send(&[], json!({"op": "board_put", "id": id, "title": "task", "session_id": null, "column": "working"}));
    for b in [&board, &board2] {
        assert_eq!(card(b, &id)["last_moved_at"].as_u64().unwrap(), moved);
        assert_eq!(card(b, &id)["history"].as_array().unwrap().len(), history);
    }
    // An edit that keeps the column is history but not a move.
    let board = home.send(&[], json!({"op": "board_task_put", "id": id, "group": "g"}));
    assert_eq!(card(&board, &id)["last_moved_at"].as_u64().unwrap(), moved);
}

const OLD_DEFAULT: &str = "# kept comment\nversion = 1\n\n[[columns]]\nid = \"working\"\ntitle = \"Working\"\nstates = [\"working\"]\n\n\
    [[columns]]\nid = \"needs-decision\"\ntitle = \"Needs decision\"\nstates = [\"needs_decision\"]\nneeds_decision = true\n\n\
    [[columns]]\nid = \"review\"\ntitle = \"Review\"\nstates = [\"review\"]\n\n[[columns]]\nid = \"done\"\ntitle = \"Done\"\nstates = [\"done\"]\n";

#[test]
fn board_toml_v1_default_migrates() {
    let home = Home::new();
    fs::write(home.toml(), OLD_DEFAULT).unwrap();
    let board = home.snapshot(&[]);
    assert!(board.error.is_none(), "{:?}", board.error);
    let titles: Vec<_> = board.columns.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(
        titles,
        ["To do", "Working", "Needs decision", "Review", "Done"]
    );
    let text = fs::read_to_string(home.toml()).unwrap();
    assert!(text.starts_with("# kept comment\nversion = 2\n"), "{text}");
    assert!(
        text.contains("id = \"todo\"\ntitle = \"To do\"\n"),
        "{text}"
    );
    assert!(
        text.contains("id = \"done\"\ntitle = \"Done\"\nstates = [\"done\"]\nproof = true\n"),
        "{text}"
    );
    // Once: the v2 file is read as is, and the revision names the migrated file.
    let again = home.snapshot(&[]);
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), text);
    assert_eq!(again.revision, board.revision);
    // An old board.json that kept the four default columns (no board.toml) also moves to the five.
    let other = Home::new();
    other.add("x");
    let path = other.0.join("board.json");
    let mut disk: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["columns"] = json!([
        {"id": "working", "title": "Working", "states": ["working"], "needs_decision": false},
        {"id": "needs-decision", "title": "Needs decision", "states": ["needs_decision"], "needs_decision": true},
        {"id": "review", "title": "Review", "states": ["review"], "needs_decision": false},
        {"id": "done", "title": "Done", "states": ["done"], "needs_decision": false},
    ]);
    fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
    assert_eq!(other.snapshot(&[]).columns.len(), 5);
}

#[test]
fn board_toml_v1_custom_kept() {
    let home = Home::new();
    let custom = OLD_DEFAULT.replace("title = \"Review\"", "title = \"검토\"");
    fs::write(home.toml(), &custom).unwrap();
    let board = home.snapshot(&[]);
    assert!(board.error.is_none());
    let titles: Vec<_> = board.columns.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, ["Working", "Needs decision", "검토", "Done"]);
    assert!(board.columns.iter().all(|c| !c.proof));
    // A hand-edited file is read as v2 and never rewritten for the version alone.
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), custom);
    // Putting needs 43's four back through the GUI stamps version 2, so no later read migrates them.
    let old_four: Vec<_> = board
        .columns
        .iter()
        .map(|c| board::Column {
            title: c.title.replace("검토", "Review"),
            ..c.clone()
        })
        .collect();
    let after = home.send(
        &[],
        json!({"op": "board_columns_put", "revision": board.revision, "columns": old_four}),
    );
    assert!(after.error.is_none(), "{:?}", after.error);
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        OLD_DEFAULT.replace("version = 1", "version = 2")
    );
    assert_eq!(home.snapshot(&[]).columns.len(), 4);
    // A v2 file with `proof` parses; a v3 file is refused.
    fs::write(
        home.toml(),
        custom.replace("version = 1", "version = 2").replace(
            "states = [\"done\"]\n",
            "states = [\"done\"]\nproof = true\n",
        ),
    )
    .unwrap();
    assert!(home.snapshot(&[]).columns.last().unwrap().proof);
    fs::write(home.toml(), custom.replace("version = 1", "version = 3")).unwrap();
    assert!(home.snapshot(&[]).error.is_some());
}

#[test]
fn board_toml_broken_refused_whole() {
    let home = Home::new();
    let broken = OLD_DEFAULT.replace("title = \"Done\"", "title = 3");
    fs::write(home.toml(), &broken).unwrap();
    let board = home.snapshot(&[]);
    let error = board.error.unwrap();
    assert!(error.starts_with("board.toml line "), "{error}");
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), broken);
}

/// Reads the backticked names under one `//! ### <section>` heading of the board module header.
fn documented(section: &str) -> BTreeSet<String> {
    let header = include_str!("../src/board/mod.rs");
    let mut inside = false;
    let mut names = BTreeSet::new();
    for line in header.lines().take_while(|l| l.starts_with("//!")) {
        let line = line.trim_start_matches("//!").trim();
        if let Some(name) = line.strip_prefix("### ") {
            inside = name == section;
        } else if inside && let Some(rest) = line.strip_prefix("- `") {
            names.insert(rest.split('`').next().unwrap().to_string());
        }
    }
    assert!(!names.is_empty(), "no section {section}");
    names
}
fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

/// Ticket 1066 rule 3: a session card's done time is stored when the board first sees it in Done; later activity
/// moves its `updated_at`, not its `done_at`. A card that leaves Done and returns counts from its newest arrival.
#[test]
fn session_done_time_does_not_move_on_update() {
    let home = Home::new();
    let ended = |activity: u64| {
        let mut s = serde_json::to_value(session("w1")).unwrap();
        s["state"] = json!("exited");
        s["attention"]["last_activity"] = json!(activity);
        serde_json::from_value::<Session>(s).unwrap()
    };
    let at = |board: &board::Snapshot| card(board, "w1")["done_at"].clone();
    assert_eq!(at(&home.snapshot(&[ended(1000)])), json!(1000));
    let later = home.snapshot(&[ended(9000)]);
    assert_eq!(
        (card(&later, "w1")["updated_at"].clone(), at(&later)),
        (json!(9000), json!(1000))
    );
    // Out of Done (running again, in a turn) and back: the newest arrival.
    let mut again = session("w1");
    again.attention.working = true;
    assert_eq!(at(&home.snapshot(&[again])), Value::Null);
    assert_eq!(at(&home.snapshot(&[ended(12000)])), json!(12000));
    // A manual card: its last move into Done.
    let id = home.add("task");
    assert_eq!(card(&home.snapshot(&[]), &id)["done_at"], Value::Null);
    let moved = home.send(
        &[],
        json!({"op": "board_move", "source": "manual", "id": id, "column": "done"}),
    );
    assert_eq!(
        card(&moved, &id)["done_at"],
        card(&moved, &id)["last_moved_at"]
    );
}

#[test]
fn snapshot_shape_documented() {
    let home = Home::new();
    let sessions = [session("w1"), session("free")];
    let id = home.add("task");
    home.send(&sessions, json!({"op": "board_task_put", "id": id, "receipt": {"sha": "a", "command": "b", "result": "c"}, "attachments": [{"session_id": "w1", "role": "build"}]}));
    board::record_refusal(&home.0, &id, "w1", "done", "why").unwrap();
    let board = serde_json::to_value(home.snapshot(&sessions)).unwrap();
    let mut top = keys(&board);
    top.insert("sources".into()); // omitted when no integration source is configured
    assert_eq!(top, documented("Snapshot"));
    assert_eq!(keys(&board["columns"][0]), documented("Column"));
    assert_eq!(keys(&board["settings"]), documented("Settings")); // V2.5-38
    let cards = board["cards"].as_array().unwrap();
    let manual = cards.iter().find(|c| c["source"] == "manual").unwrap();
    let auto = cards.iter().find(|c| c["source"] == "session").unwrap();
    assert_eq!(keys(manual), documented("Card"));
    assert_eq!(keys(auto), documented("Card"));
    assert_eq!(keys(&manual["attachments"][0]), documented("Attachment"));
    assert_eq!(keys(&manual["receipt"]), documented("Receipt"));
    let history = manual["history"].as_array().unwrap();
    let mut change = BTreeSet::new();
    history.iter().for_each(|h| change.extend(keys(h)));
    assert_eq!(change, documented("Change"));
}

/// N24 (look 11-17): a closed task's cards leave Needs you, by its seats only; a card with the same title (another
/// project's) and other cards stay (security look, wave 8).
#[test]
fn n24_a_closed_task_retires_its_cards() {
    let home = Home::new();
    let sessions = [session("w1")];
    let (by_seat, by_title, other) = (home.add("lane"), home.add("Add slug"), home.add("Other"));
    home.send(&sessions, json!({"op": "board_task_put", "id": by_seat, "attachments": [{"session_id": "w1", "role": "build"}]}));
    for id in [&by_seat, &by_title, &other] {
        home.send(
            &sessions,
            json!({"op": "board_move", "source": "manual", "id": id, "column": "needs-decision"}),
        );
    }
    board::retire_task(&home.0, &["w1".into()], "merged").unwrap();
    let board = home.snapshot(&sessions);
    assert_eq!(card(&board, &by_seat)["column"], "done");
    assert_eq!(card(&board, &by_seat)["receipt"]["result"], "task merged");
    for id in [&by_title, &other] {
        assert_eq!(card(&board, id)["column"], "needs-decision");
    }
}

/// Look 11-17 v5 item 8: a task whose merge waits for the user is in the needs-decision column, by its seats only, and
/// goes to review once the user answered. Look 1117 v12 B N12-S2-1: a task its lead kept no card for gets one, and a
/// task card raises no decision item of its own (its merge card is the decision).
#[test]
fn v5_8_a_task_waiting_for_its_merge_is_in_needs_decision() {
    let home = Home::new();
    let sessions = [session("w1"), session("w2"), session("r2")];
    let ledger = nunchiro_core::ledger::Ledger::open(&home.0);
    let seated = |title: &str, seats: &[(&str, &str)]| {
        let (task, _) = ledger.make(&home.0, None, title, &[], false, 1).unwrap();
        for (seat, role) in seats {
            ledger
                .seat_on(&task.id, seat, role, None, 1, &|_| true)
                .unwrap();
        }
        ledger
            .list()
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap()
    };
    let (slug, greet) = (
        seated("Add slug", &[("w1", "Builder")]),
        seated(
            "Greet in greet.py",
            &[("w2", "Builder"), ("r2", "Reviewer")],
        ),
    );
    let (ours, other) = (home.add("Add slug"), home.add("Other"));
    home.send(&sessions, json!({"op": "board_task_put", "id": ours, "attachments": [{"session_id": "w1", "role": "build"}]}));
    for id in [&ours, &other] {
        home.send(
            &sessions,
            json!({"op": "board_move", "source": "manual", "id": id, "column": "working"}),
        );
    }
    board::park_task(&home.0, &slug, true).unwrap();
    board::park_task(&home.0, &greet, true).unwrap();
    let board = home.snapshot(&sessions);
    assert_eq!(card(&board, &ours)["column"], "needs-decision");
    assert_eq!(card(&board, &other)["column"], "working");
    assert!(
        card(&board, &ours)["receipt"].is_null(),
        "no receipt: the task is open"
    );
    let made: Vec<&Value> = board
        .cards
        .iter()
        .filter(|c| c["task"] == greet.id.as_str())
        .collect();
    assert_eq!(
        made.len(),
        1,
        "one card for the task its lead kept none for"
    );
    assert_eq!(
        (
            &made[0]["column"],
            &made[0]["text"],
            made[0]["attachments"].as_array().unwrap().len()
        ),
        (&json!("needs-decision"), &json!("Greet in greet.py"), 2)
    );
    assert!(
        !board
            .cards
            .iter()
            .any(|c| c["session_id"] == "w2" || c["session_id"] == "r2"),
        "its seats show under it"
    );
    assert!(
        board::decisions(&home.0).is_empty(),
        "the merge card is the decision"
    );
    board::park_task(&home.0, &slug, false).unwrap();
    board::park_task(&home.0, &greet, true).unwrap();
    let board = home.snapshot(&sessions);
    assert_eq!(card(&board, &ours)["column"], "review");
    assert_eq!(
        board
            .cards
            .iter()
            .filter(|c| c["task"] == greet.id.as_str())
            .count(),
        1,
        "asked again: still one card"
    );
    // Look 1117 v13 Home S3-2: once its seats are gone (merged, closed) the card stays in its task's place.
    let board = home.snapshot(&[]);
    let made = board
        .cards
        .iter()
        .find(|c| c["task"] == greet.id.as_str())
        .unwrap();
    assert_eq!(made["project"], json!(greet.place));
}

/// Look 11-17 v5 item 9: a task card's text is its own task's outcome, never its session's last message; its note wins
/// when it has one, and a card with no task says its title.
#[test]
fn v5_9_a_task_card_says_its_own_outcome() {
    let home = Home::new();
    let sessions = [session("lead"), session("w1"), session("w2")];
    let ledger = nunchiro_core::ledger::Ledger::open(&home.0);
    for (title, seat) in [
        ("Add slug(name) in slug.py", "w1"),
        ("Greet in greet.py", "w2"),
    ] {
        let (task, _) = ledger.make(&home.0, None, title, &[], false, 1).unwrap();
        ledger
            .seat_on(&task.id, seat, "Builder", None, 1, &|_| true)
            .unwrap();
    }
    let (a, b, c) = (home.add("slug"), home.add("greet"), home.add("Loose card"));
    for (id, seat) in [(&a, "w1"), (&b, "w2")] {
        home.send(&sessions, json!({"op": "board_task_put", "id": id, "attachments": [{"session_id": seat, "role": "build"}]}));
    }
    let board = serde_json::to_value(home.snapshot(&sessions)).unwrap();
    let text = |id: &str| {
        board["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == id)
            .unwrap()["text"]
            .clone()
    };
    assert_eq!(text(&a), "Add slug(name) in slug.py");
    assert_eq!(text(&b), "Greet in greet.py");
    assert_eq!(text(&c), "Loose card");
}

// Q9 ko-J12-1: undo of a delete brings the card back whole, the waits on it too, after its session closed.
#[test]
fn undo_restores_a_deleted_card_whole() {
    let home = Home::new();
    let sessions = [session("w1")];
    let a = home.add("a");
    let b = home.add("b");
    home.send(&sessions, json!({"op": "board_put", "id": a, "title": "a", "note": "n", "session_id": "w1", "column": "working"}));
    home.send(
        &sessions,
        json!({
            "op": "board_task_put", "id": a, "group": "g", "ref": "r",
            "receipt": {"sha": "s", "command": "c", "result": "ok"},
            "attachments": [{"session_id": "w1", "role": "build"}],
        }),
    );
    home.send(
        &sessions,
        json!({"op": "board_task_put", "id": b, "waits_on": [a]}),
    );
    let kept = card(&home.snapshot(&sessions), &a).clone();
    home.send(&sessions, json!({"op": "board_delete", "id": a}));
    // w1 has closed since.
    let board = home.send(&[], json!({"op": "board_undo", "id": a}));
    let c = card(&board, &a);
    for key in [
        "title",
        "note",
        "session_id",
        "column",
        "group",
        "ref",
        "receipt",
    ] {
        assert_eq!(c[key], kept[key], "{key}");
    }
    assert_eq!(c["attachments"][0]["role"], "build");
    assert_eq!(card(&board, &b)["waits_on"], json!([a]));
    assert_eq!(board.cards.iter().position(|c| c["id"] == a), Some(0));
    // Once: a second undo has no deleted card to restore and no change to undo.
    assert!(
        home.try_as(&[], "owner", json!({"op": "board_undo", "id": a}))
            .is_err()
    );
    let error = home
        .try_as(&[], "owner", json!({"op": "board_undo", "id": "m-none"}))
        .unwrap_err();
    assert_eq!(error, "manual card not found");
}
