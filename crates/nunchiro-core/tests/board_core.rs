use nunchiro_core::{api::*, board};
use std::{fs, path::PathBuf};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "board-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn request(&self, sessions: &[Session], request: Request) -> board::Snapshot {
        match board::handle(&self.0, sessions, request).unwrap() {
            Reply::BoardSnapshot { board } => board,
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    fn snapshot(&self, sessions: &[Session]) -> board::Snapshot {
        self.request(sessions, Request::BoardSnapshot)
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn board_fresh_install_has_the_approved_four_columns_without_writing_user_config() {
    let home = Home::new();
    let board = home.snapshot(&[]);
    assert_eq!(
        board
            .columns
            .iter()
            .map(|c| c.title.as_str())
            .collect::<Vec<_>>(),
        ["To do", "Working", "Needs decision", "Review", "Done"]
    );
    assert_eq!(
        board
            .columns
            .iter()
            .map(|c| c.needs_decision)
            .collect::<Vec<_>>(),
        [false, false, true, false, false]
    );
    assert!(board.cards.is_empty());
    assert!(board.error.is_none());
    assert!(!home.0.join("board.toml").exists());
}

fn session(id: &str) -> Session {
    serde_json::from_value(serde_json::json!({
        "id": id, "kind": "claude", "project": "/project", "cwd": "/project",
        "label": format!("Label {id}"), "state": "running", "pid": 1,
        "agent_session_id": null, "agent_version": null, "untested": false
    }))
    .unwrap()
}

#[test]
fn board_places_one_labelled_card_per_session_using_queue_attention() {
    let home = Home::new();
    let mut queue = nunchiro_core::queue::Queue::open(&home.0).unwrap();
    let mut sessions = vec![
        session("working"),
        session("waiting"),
        session("review"),
        session("done"),
        session("failed"),
        session("stale"),
    ];
    for s in &sessions {
        queue.register(&s.id, s.kind, 100).unwrap();
    }
    queue
        .observe(
            "waiting",
            "PermissionRequest",
            &serde_json::json!({}),
            "hook",
            200,
        )
        .unwrap();
    queue
        .observe(
            "review",
            "UserPromptSubmit",
            &serde_json::json!({}),
            "hook",
            200,
        )
        .unwrap();
    queue
        .observe("review", "Stop", &serde_json::json!({}), "hook", 300)
        .unwrap();
    queue.close("failed", true).unwrap();
    // B14 (ticket 991): only a turn in progress goes stale.
    queue
        .observe(
            "stale",
            "UserPromptSubmit",
            &serde_json::json!({}),
            "hook",
            100,
        )
        .unwrap();
    queue
        .tick(
            1_200_100,
            nunchiro_core::queue::DEFAULT_STALE_MS,
            &std::collections::BTreeSet::from(["stale".into()]),
        )
        .unwrap();
    for s in &mut sessions {
        *s.attention = queue.attention(&s.id);
        s.completion_seq = s.attention.completion_seq;
    }
    sessions[3].state = SessionState::Exited;
    sessions[3].pid = None;
    sessions[4].state = SessionState::Failed;
    sessions[4].pid = None;
    let board = home.snapshot(&sessions);
    assert_eq!(board.cards.len(), 6);
    let columns: Vec<_> = board
        .cards
        .iter()
        .map(|c| c["column"].as_str().unwrap())
        .collect();
    assert_eq!(
        columns,
        [
            "working",
            "needs-decision",
            "review",
            "done",
            "needs-decision",
            "working"
        ]
    );
    assert_eq!(board.cards[0]["title"], "Label working");
    assert_eq!(board.cards[0]["session_id"], "working");
    assert_eq!(board.cards[5]["stale"], true);
}

#[test]
fn board_reloads_columns_and_invalid_toml_keeps_last_good_with_a_line() {
    let home = Home::new();
    let path = home.0.join("board.toml");
    let custom = include_str!("fixtures/board/custom.toml");
    fs::write(&path, custom).unwrap();
    let first = home.snapshot(&[session("s")]);
    assert_eq!(first.columns[0].id, "active");
    assert_eq!(first.cards[0]["column"], "active");
    for (bytes, line) in [
        ("version = 1\n[[columns]]\n# invalid id\nid = @\n", 4),
        ("version = 2\n", 1),
        ("version = 1\ncolumns = []\n", 2),
        (
            "version = 1\n[[columns]]\nid = 'x'\ntitle = 'X'\nstates = ['wrong']\n",
            5,
        ),
        (
            "version = 1\n[[columns]]\nid = 'x'\ntitle = 'X'\n[[columns]]\nid = 'x'\ntitle = 'Duplicate'\n",
            6,
        ),
    ] {
        fs::write(&path, bytes).unwrap();
        let board = home.snapshot(&[]);
        assert_eq!(board.columns, first.columns);
        assert!(
            board
                .error
                .as_ref()
                .unwrap()
                .contains(&format!("line {line}")),
            "{:?}",
            board.error
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
    fs::write(
        &path,
        "version = 1\n[[columns]]\nid = 'only'\ntitle = 'Only'\n",
    )
    .unwrap();
    let board = home.snapshot(&[session("s")]);
    assert!(board.error.is_none());
    assert_eq!(board.columns.len(), 1);
    assert_eq!(
        board.cards[0]["column"], "only",
        "an unclaimed state uses the first column"
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        home.snapshot(&[]).columns,
        board.columns,
        "a removed config retains the last good board"
    );
}

#[test]
fn board_seen_completion_is_durable_and_stale_seen_cannot_hide_a_new_turn() {
    let home = Home::new();
    let mut s = session("seen");
    s.completion_seq = 1;
    assert_eq!(
        home.snapshot(std::slice::from_ref(&s)).cards[0]["column"],
        "review"
    );
    let board = home.request(
        std::slice::from_ref(&s),
        Request::BoardSeen {
            id: s.id.clone(),
            completion_seq: 1,
        },
    );
    assert_eq!(board.cards[0]["column"], "done");
    assert_eq!(
        home.snapshot(std::slice::from_ref(&s)).cards[0]["column"],
        "done"
    );
    s.completion_seq = 2;
    let board = home.request(
        std::slice::from_ref(&s),
        Request::BoardSeen {
            id: s.id.clone(),
            completion_seq: 1,
        },
    );
    assert_eq!(board.cards[0]["column"], "review");
    assert!(
        board::handle(
            &home.0,
            std::slice::from_ref(&s),
            Request::BoardSeen {
                id: s.id.clone(),
                completion_seq: 3
            }
        )
        .is_err()
    );
    s.attention.working = true;
    assert_eq!(home.snapshot(&[s]).cards[0]["column"], "working");
}

#[test]
fn board_manual_card_create_edit_link_move_delete_survives_restart() {
    let home = Home::new();
    let s = session("linked");
    let created = home.request(
        std::slice::from_ref(&s),
        Request::BoardPut {
            id: None,
            title: "Read review".into(),
            note: "Check evidence".into(),
            session_id: Some(s.id.clone()),
            column: None,
        },
    );
    let card = created
        .cards
        .iter()
        .find(|c| c["source"] == "manual")
        .unwrap();
    let id = card["id"].as_str().unwrap().to_owned();
    assert_eq!(card["session_id"], "linked");
    assert_eq!(card["column"], "todo");
    let created_at = card["updated_at"].as_u64().unwrap();
    let edited = home.request(
        &[s],
        Request::BoardPut {
            id: Some(id.clone()),
            title: "Review read".into(),
            note: "Done".into(),
            session_id: None,
            column: Some("review".into()),
        },
    );
    let card = edited
        .cards
        .iter()
        .find(|c| c["source"] == "manual")
        .unwrap();
    assert!(card["updated_at"].as_u64().unwrap() > created_at);
    let restored = home.snapshot(&[]);
    assert_eq!(restored.cards.len(), 1);
    assert_eq!(restored.cards[0]["title"], "Review read");
    assert_eq!(restored.cards[0]["note"], "Done");
    assert!(restored.cards[0]["session_id"].is_null());
    let board = home.request(
        &[],
        Request::BoardMove {
            source: board::Source::Manual,
            id: id.clone(),
            column: "done".into(),
        },
    );
    assert_eq!(board.cards[0]["column"], "done");
    assert!(
        home.request(&[], Request::BoardDelete { id })
            .cards
            .is_empty()
    );
    assert!(home.snapshot(&[]).cards.is_empty());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(home.0.join("board.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&home.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

// Ticket 621: the core drops old closed rows, so a card's linked session can leave the snapshot; editing the card
// keeps working with its own link, while a new link to a gone session is still refused.
#[test]
fn board_card_edit_keeps_a_link_whose_session_is_gone() {
    let home = Home::new();
    let s = session("linked");
    let created = home.request(
        std::slice::from_ref(&s),
        Request::BoardPut {
            id: None,
            title: "Read review".into(),
            note: String::new(),
            session_id: Some(s.id.clone()),
            column: None,
        },
    );
    let manual = |b: &board::Snapshot| {
        b.cards
            .iter()
            .find(|c| c["source"] == "manual")
            .unwrap()
            .clone()
    };
    let id = manual(&created)["id"].as_str().unwrap().to_owned();
    let put = |id: Option<String>, session: &str| Request::BoardPut {
        id,
        title: "Review read".into(),
        note: String::new(),
        session_id: Some(session.into()),
        column: None,
    };
    let edited = home.request(&[], put(Some(id.clone()), "linked"));
    assert_eq!(manual(&edited)["title"], "Review read");
    assert_eq!(manual(&edited)["session_id"], "linked");
    for refused in [put(Some(id), "other"), put(None, "linked")] {
        assert_eq!(
            board::handle(&home.0, &[], refused).unwrap_err(),
            "linked board session not found"
        );
    }
}

#[test]
fn board_drag_holds_across_activity_and_restart_but_releases_on_state_change() {
    let home = Home::new();
    let mut s = session("dragged");
    let moved = home.request(
        std::slice::from_ref(&s),
        Request::BoardMove {
            source: board::Source::Session,
            id: s.id.clone(),
            column: "review".into(),
        },
    );
    assert_eq!(moved.cards[0]["column"], "review");
    s.label = "Renamed".into();
    s.attention.last_activity += 100;
    assert_eq!(
        home.snapshot(std::slice::from_ref(&s)).cards[0]["column"],
        "review"
    );
    s.attention.waiting = true;
    assert_eq!(
        home.snapshot(std::slice::from_ref(&s)).cards[0]["column"],
        "needs-decision"
    );
    s.attention.waiting = false;
    assert_eq!(
        home.snapshot(std::slice::from_ref(&s)).cards[0]["column"],
        "working"
    );
    let _ = home.request(
        std::slice::from_ref(&s),
        Request::BoardMove {
            source: board::Source::Session,
            id: s.id.clone(),
            column: "review".into(),
        },
    );
    s.completion_seq += 1;
    s.attention.working = true;
    assert_eq!(
        home.snapshot(&[s]).cards[0]["column"],
        "working",
        "a new completion releases a drag even if both observed states are working"
    );
}

#[test]
fn board_broken_and_newer_store_is_refused_without_changing_its_bytes() {
    let home = Home::new();
    home.request(
        &[],
        Request::BoardPut {
            id: None,
            title: "Preserve".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
    );
    let path = home.0.join("board.json");
    let good: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut wrong_type = good.clone();
    wrong_type["manual"][0]["note"] = serde_json::json!(4);
    let mut newer = good.clone();
    newer["version"] = serde_json::json!(2);
    let mut duplicate = good.clone();
    duplicate["manual"]
        .as_array_mut()
        .unwrap()
        .push(good["manual"][0].clone());
    let mut bad_link = good.clone();
    bad_link["manual"][0]["session_id"] = serde_json::json!("bad/id");
    let mut bad_seen = good.clone();
    bad_seen["seen"] = serde_json::json!({"bad/id":1});
    let mut no_columns = good.clone();
    no_columns["columns"] = serde_json::json!([]);
    for bad in [
        serde_json::json!([]),
        wrong_type,
        newer,
        duplicate,
        bad_link,
        bad_seen,
        no_columns,
    ] {
        let bytes = serde_json::to_vec(&bad).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            board::handle(&home.0, &[], Request::BoardSnapshot).is_err(),
            "accepted {bad}"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn board_invalid_requests_leave_store_unchanged_and_updates_preserve_extra_fields() {
    let home = Home::new();
    home.request(
        &[],
        Request::BoardPut {
            id: None,
            title: "Keep".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
    );
    let path = home.0.join("board.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["future"] = serde_json::json!({"retain":true});
    disk["manual"][0]["future"] = serde_json::json!("retain");
    let id = disk["manual"][0]["id"].as_str().unwrap().to_owned();
    let bytes = serde_json::to_vec(&disk).unwrap();
    fs::write(&path, &bytes).unwrap();
    for request in [
        Request::BoardPut {
            id: None,
            title: " ".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
        Request::BoardPut {
            id: None,
            title: "Valid".into(),
            note: String::new(),
            session_id: Some("missing".into()),
            column: None,
        },
        Request::BoardPut {
            id: Some("missing".into()),
            title: "Valid".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
        Request::BoardMove {
            source: board::Source::Manual,
            id: id.clone(),
            column: "missing".into(),
        },
        Request::BoardDelete {
            id: "missing".into(),
        },
        Request::BoardSeen {
            id: "missing".into(),
            completion_seq: 0,
        },
    ] {
        assert!(board::handle(&home.0, &[], request).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    home.request(
        &[],
        Request::BoardMove {
            source: board::Source::Manual,
            id,
            column: "review".into(),
        },
    );
    let disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(disk["future"], serde_json::json!({"retain":true}));
    assert_eq!(disk["manual"][0]["future"], "retain");
}

#[test]
fn board_nonregular_inputs_are_refused_without_following_or_overwriting_them() {
    use std::os::unix::fs::symlink;
    let home = Home::new();
    let config = home.0.join("outside.toml");
    let text = include_str!("fixtures/board/custom.toml");
    fs::write(&config, text).unwrap();
    symlink(&config, home.0.join("board.toml")).unwrap();
    let board = home.snapshot(&[]);
    assert!(board.error.unwrap().contains("line 1"));
    assert_eq!(board.columns[0].id, "todo");
    assert_eq!(fs::read_to_string(&config).unwrap(), text);
    let outside = home.0.join("outside.json");
    let bytes = fs::read(home.0.join("board.json")).unwrap();
    fs::write(&outside, &bytes).unwrap();
    fs::remove_file(home.0.join("board.json")).unwrap();
    symlink(&outside, home.0.join("board.json")).unwrap();
    assert!(board::handle(&home.0, &[], Request::BoardSnapshot).is_err());
    assert_eq!(fs::read(&outside).unwrap(), bytes);
    assert!(
        home.0
            .join("board.json")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn board_unchanged_snapshots_and_noop_manual_updates_do_not_rewrite_store() {
    use std::os::unix::fs::MetadataExt;
    let home = Home::new();
    home.request(
        &[],
        Request::BoardPut {
            id: None,
            title: "Keep".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
    );
    let path = home.0.join("board.json");
    let first = home.snapshot(&[]);
    let inode = fs::metadata(&path).unwrap().ino();
    let id = first.cards[0]["id"].as_str().unwrap().to_owned();
    let board = home.request(
        &[],
        Request::BoardPut {
            id: Some(id),
            title: "Keep".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
    );
    assert_eq!(board.cards, first.cards);
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
}

#[test]
fn board_future_seen_store_stamp_is_reset_without_hiding_unread_turn() {
    let home = Home::new();
    let mut s = session("s");
    s.completion_seq = 1;
    home.request(
        std::slice::from_ref(&s),
        Request::BoardSeen {
            id: s.id.clone(),
            completion_seq: 1,
        },
    );
    let path = home.0.join("board.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["seen"]["s"] = serde_json::json!(2);
    let bytes = serde_json::to_vec(&disk).unwrap();
    fs::write(&path, &bytes).unwrap();
    let board = home.snapshot(std::slice::from_ref(&s));
    assert_eq!(board.cards[0]["column"], "review");
    disk["seen"].as_object_mut().unwrap().remove("s");
    let repaired: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(repaired, disk, "only the stale seen marker should change");
    let stable = fs::read(&path).unwrap();
    home.snapshot(&[s]);
    assert_eq!(fs::read(&path).unwrap(), stable);
}

#[test]
fn board_moving_a_held_session_preserves_future_record_fields() {
    let home = Home::new();
    let s = session("s");
    home.request(
        std::slice::from_ref(&s),
        Request::BoardMove {
            source: board::Source::Session,
            id: s.id.clone(),
            column: "review".into(),
        },
    );
    let path = home.0.join("board.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["held"]["s"]["future"] = serde_json::json!("preserve");
    fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
    home.request(
        &[s],
        Request::BoardMove {
            source: board::Source::Session,
            id: "s".into(),
            column: "done".into(),
        },
    );
    let disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(disk["held"]["s"]["future"], "preserve");
}

#[test]
fn board_future_held_completion_releases_the_card_without_other_changes() {
    let home = Home::new();
    let s = session("s");
    home.request(
        std::slice::from_ref(&s),
        Request::BoardMove {
            source: board::Source::Session,
            id: s.id.clone(),
            column: "review".into(),
        },
    );
    let path = home.0.join("board.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["held"]["s"]["completion_seq"] = serde_json::json!(999);
    let bytes = serde_json::to_vec(&disk).unwrap();
    fs::write(&path, &bytes).unwrap();
    let board = home.snapshot(std::slice::from_ref(&s));
    assert_eq!(board.cards[0]["column"], "working");
    disk["held"].as_object_mut().unwrap().remove("s");
    let repaired: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(repaired, disk, "only the stale held marker should change");
    let stable = fs::read(&path).unwrap();
    home.snapshot(&[s]);
    assert_eq!(fs::read(&path).unwrap(), stable);
}

/// Needs 43's four stored columns (ids, states, flags), with the given titles in the order working, needs-decision, review, done.
fn four_old(titles: [&str; 4]) -> serde_json::Value {
    serde_json::json!([
        {"id": "working", "title": titles[0], "states": ["working"], "needs_decision": false},
        {"id": "needs-decision", "title": titles[1], "states": ["needs_decision"], "needs_decision": true},
        {"id": "review", "title": titles[2], "states": ["review"], "needs_decision": false},
        {"id": "done", "title": titles[3], "states": ["done"], "needs_decision": false},
    ])
}

fn store_with(home: &Home, columns: serde_json::Value) {
    let store = serde_json::json!({"version": 1, "columns": columns});
    fs::write(
        home.0.join("board.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
}

#[test]
fn board_korean_titles_insert_todo_first_keeps_titles() {
    let home = Home::new();
    store_with(&home, four_old(["진행", "결정 필요", "검토", "완료"]));
    let board = home.snapshot(&[]);
    assert!(board.error.is_none(), "{:?}", board.error);
    let ids: Vec<_> = board.columns.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["todo", "working", "needs-decision", "review", "done"]);
    let titles: Vec<_> = board.columns.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, ["할 일", "진행", "결정 필요", "검토", "완료"]);
    assert!(board.columns[0].states.is_empty());
    let proof: Vec<_> = board.columns.iter().map(|c| c.proof).collect();
    assert_eq!(proof, [false, false, false, false, true]);
}

#[test]
fn board_english_default_store_migration_unchanged() {
    let home = Home::new();
    store_with(
        &home,
        four_old(["Working", "Needs decision", "Review", "Done"]),
    );
    let board = home.snapshot(&[]);
    // The literal five the tree produced before the title-blind match: same ids, titles, states, flags.
    let expected = serde_json::json!([
        {"id": "todo", "title": "To do", "states": [], "needs_decision": false, "proof": false},
        {"id": "working", "title": "Working", "states": ["working"], "needs_decision": false, "proof": false},
        {"id": "needs-decision", "title": "Needs decision", "states": ["needs_decision"], "needs_decision": true, "proof": false},
        {"id": "review", "title": "Review", "states": ["review"], "needs_decision": false, "proof": false},
        {"id": "done", "title": "Done", "states": ["done"], "needs_decision": false, "proof": true},
    ]);
    assert_eq!(serde_json::to_value(&board.columns).unwrap(), expected);
}

#[test]
fn board_store_with_a_changed_shape_is_not_migrated() {
    // Titles are ignored, structure is not: a user-made column set stays as stored.
    let home = Home::new();
    let mut columns = four_old(["진행", "결정 필요", "검토", "완료"]);
    columns[2]["states"] = serde_json::json!(["review", "done"]);
    columns[3]["states"] = serde_json::json!([]);
    store_with(&home, columns);
    let ids: Vec<_> = home
        .snapshot(&[])
        .columns
        .iter()
        .map(|c| c.id.clone())
        .collect();
    assert_eq!(ids, ["working", "needs-decision", "review", "done"]);
}
