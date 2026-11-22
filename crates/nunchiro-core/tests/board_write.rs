// v1b-16: the GUI writer for board.toml (BoardColumnsPut).
use nunchiro_core::{api::*, board};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/board/write");

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "board-write-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn toml(&self) -> PathBuf {
        self.0.join("board.toml")
    }
    fn fixture(&self, name: &str) -> String {
        let text = fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap();
        fs::write(self.toml(), &text).unwrap();
        text
    }
    fn snapshot(&self) -> board::Snapshot {
        match board::handle(&self.0, &[], Request::BoardSnapshot).unwrap() {
            Reply::BoardSnapshot { board } => board,
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    fn put(&self, revision: &str, columns: Vec<board::Column>) -> Result<board::Snapshot, String> {
        board::handle(
            &self.0,
            &[],
            Request::BoardColumnsPut {
                revision: revision.into(),
                columns,
            },
        )
        .map(|reply| match reply {
            Reply::BoardSnapshot { board } => board,
            other => panic!("unexpected reply: {other:?}"),
        })
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn titles(board: &board::Snapshot) -> Vec<&str> {
    board.columns.iter().map(|c| c.title.as_str()).collect()
}

#[test]
fn board_write_keeps_unchanged_bytes() {
    let home = Home::new();
    home.fixture("before.toml");
    let board = home.snapshot();
    assert!(board.error.is_none(), "{:?}", board.error);
    assert!(!board.revision.is_empty());
    let mut columns = board.columns.clone();
    columns[2].title = "리뷰 대기".into();
    let after = home.put(&board.revision, columns).unwrap();
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        fs::read_to_string(format!("{FIXTURES}/renamed.toml")).unwrap()
    );
    assert_eq!(
        titles(&after),
        ["작업 중", "결정 필요", "리뷰 대기", "완료"]
    );
    assert_ne!(after.revision, board.revision);
}

#[test]
fn board_write_adds_reorders_and_deletes_columns_leaving_other_tables_alone() {
    let home = Home::new();
    let before = home.fixture("before.toml");
    let sources = &before[before.find("\n[sources]").unwrap()..];
    let board = home.snapshot();
    let mut columns = board.columns.clone();
    columns.push(board::Column {
        id: "blocked".into(),
        title: "막힘".into(),
        states: vec![],
        needs_decision: true,
        proof: false,
    });
    let board = home.put(&board.revision, columns).unwrap();
    let text = fs::read_to_string(home.toml()).unwrap();
    assert_eq!(
        text,
        before.replace(
            "\n[sources]",
            "\n[[columns]]\nid = \"blocked\"\ntitle = \"막힘\"\nneeds_decision = true\n\n[sources]"
        )
    );

    // Reorder: the moved tables keep their own bytes, comments included.
    let mut columns = board.columns.clone();
    columns.swap(0, 1);
    let board = home.put(&board.revision, columns).unwrap();
    let text = fs::read_to_string(home.toml()).unwrap();
    assert_eq!(
        titles(&board),
        ["결정 필요", "작업 중", "검토", "완료", "막힘"]
    );
    assert!(text.contains("title = \"작업 중\"   # keep this comment\nid = 'working'"));
    assert!(text.ends_with(sources));
    assert!(text.starts_with("# My board — hand edited.\nversion   =   1\n"));

    // Delete and change states and the decision mark of another column.
    let mut columns = board.columns.clone();
    columns.retain(|c| c.id != "blocked");
    columns[3].states = vec![];
    columns[3].needs_decision = true;
    let board = home.put(&board.revision, columns).unwrap();
    let text = fs::read_to_string(home.toml()).unwrap();
    assert_eq!(titles(&board), ["결정 필요", "작업 중", "검토", "완료"]);
    assert!(!text.contains("blocked"));
    assert!(text.contains("title = \"완료\"   # trailing\nstates = []\nneeds_decision = true\n"));
    assert!(text.contains("  [[columns]]\n  id = \"review\"\n  title = \"검토\"\n"));
    assert!(text.ends_with(sources));
}

#[test]
fn board_write_refuses_a_stale_revision_without_touching_the_hand_edit() {
    let home = Home::new();
    home.fixture("before.toml");
    let board = home.snapshot();
    let hand = "version = 1\n# hand edit\n[[columns]]\nid = \"only\"\ntitle = \"하나\"\n";
    // A different size guarantees a different stamp even on coarse clocks.
    fs::write(home.toml(), hand).unwrap();
    let mut columns = board.columns.clone();
    columns[0].title = "GUI".into();
    assert_eq!(
        home.put(&board.revision, columns).unwrap_err(),
        "board.toml changed, reloaded"
    );
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), hand);
    assert_eq!(titles(&home.snapshot()), ["하나"]);
}

#[test]
fn board_write_refuses_while_the_current_file_is_invalid() {
    let home = Home::new();
    let bad = "version = 1\n\n[[columns]]\nid = \"a\"\ntitle = 3\n";
    fs::write(home.toml(), bad).unwrap();
    let board = home.snapshot();
    let error = board.error.clone().unwrap();
    assert!(error.starts_with("board.toml line 5"), "{error}");
    assert_eq!(home.put(&board.revision, board.columns).unwrap_err(), error);
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), bad);
}

#[test]
fn board_write_creates_the_file_from_the_columns_when_absent() {
    let home = Home::new();
    let board = home.snapshot();
    assert_eq!(board.revision, "");
    let mut columns = board.columns.clone();
    columns[0].title = "진행".into();
    let after = home.put("", columns).unwrap();
    assert_eq!(
        titles(&after),
        ["진행", "Working", "Needs decision", "Review", "Done"]
    );
    assert!(after.error.is_none());
    let meta = fs::metadata(home.toml()).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        "version = 2\n\n[[columns]]\nid = \"todo\"\ntitle = \"진행\"\n\n\
         [[columns]]\nid = \"working\"\ntitle = \"Working\"\nstates = [\"working\"]\n\n\
         [[columns]]\nid = \"needs-decision\"\ntitle = \"Needs decision\"\nstates = [\"needs_decision\"]\n\
         needs_decision = true\n\n[[columns]]\nid = \"review\"\ntitle = \"Review\"\nstates = [\"review\"]\n\n\
         [[columns]]\nid = \"done\"\ntitle = \"Done\"\nstates = [\"done\"]\nproof = true\n"
    );
}

#[test]
fn board_write_keeps_an_existing_file_mode() {
    let home = Home::new();
    home.fixture("before.toml");
    fs::set_permissions(home.toml(), fs::Permissions::from_mode(0o640)).unwrap();
    let board = home.snapshot();
    let mut columns = board.columns.clone();
    columns[1].title = "판단".into();
    home.put(&board.revision, columns).unwrap();
    let meta = fs::metadata(home.toml()).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o640);
}

#[test]
fn board_write_refuses_symlinked_oversized_and_version_2_files_untouched() {
    let home = Home::new();
    let real = home.0.join("real.toml");
    let text = fs::read_to_string(format!("{FIXTURES}/before.toml")).unwrap();
    fs::write(&real, &text).unwrap();
    std::os::unix::fs::symlink(&real, home.toml()).unwrap();
    let board = home.snapshot();
    assert!(board.error.is_some());
    assert!(home.put(&board.revision, board.columns.clone()).is_err());
    assert!(fs::symlink_metadata(home.toml()).unwrap().is_symlink());
    assert_eq!(fs::read_to_string(&real).unwrap(), text);
    fs::remove_file(home.toml()).unwrap();

    let big = format!("{text}#{}\n", "x".repeat(1024 * 1024));
    fs::write(home.toml(), &big).unwrap();
    let board = home.snapshot();
    assert!(board.error.is_some());
    assert!(home.put(&board.revision, board.columns.clone()).is_err());
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), big);

    let v2 = text.replace("version   =   1", "version = 3");
    fs::write(home.toml(), &v2).unwrap();
    let board = home.snapshot();
    let error = board.error.clone().unwrap();
    assert!(error.contains("unsupported board version"), "{error}");
    assert_eq!(home.put(&board.revision, board.columns).unwrap_err(), error);
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), v2);
}

#[test]
fn board_write_refuses_deleting_the_last_column_and_invalid_columns() {
    let home = Home::new();
    let text = home.fixture("before.toml");
    let board = home.snapshot();
    let error = home.put(&board.revision, vec![]).unwrap_err();
    assert!(error.contains("expected 1 to 64 columns"), "{error}");
    let mut columns = board.columns.clone();
    columns[0].id = "bad id".into();
    assert!(home.put(&board.revision, columns).is_err());
    let mut columns = board.columns.clone();
    columns[0].states = columns[1].states.clone();
    assert!(home.put(&board.revision, columns).is_err());
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), text);
}

#[test]
fn board_write_leaves_a_column_without_states_untouched() {
    // Review r1 MUST 1: `todo` has no `states` key; editing another column must not add one.
    let home = Home::new();
    let before = home.fixture("hand.toml");
    let board = home.snapshot();
    let mut columns = board.columns.clone();
    columns[1].title = "하는 중".into();
    home.put(&board.revision, columns).unwrap();
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        before.replace("title = \"진행 중\"", "title = \"하는 중\"")
    );
}

#[test]
fn board_write_rewrites_an_inline_columns_array_as_tables() {
    // Documented: an inline `columns = [...]` array becomes `[[columns]]` tables; other bytes stay.
    let home = Home::new();
    fs::write(
        home.toml(),
        "# top\nversion = 1\ncolumns = [{ id = \"a\", title = \"A\" }, { id = \"b\", title = \"B\", states = [\"done\"] }]\n",
    )
    .unwrap();
    let board = home.snapshot();
    assert!(board.error.is_none(), "{:?}", board.error);
    let mut columns = board.columns.clone();
    columns[0].title = "에이".into();
    let after = home.put(&board.revision, columns).unwrap();
    assert_eq!(titles(&after), ["에이", "B"]);
    let text = fs::read_to_string(home.toml()).unwrap();
    assert!(text.starts_with("# top\nversion = 1\n"), "{text}");
    assert!(
        text.contains("[[columns]]\nid = \"a\"\ntitle = \"에이\"\n"),
        "{text}"
    );
    assert!(
        !text.contains("id = \"a\"\ntitle = \"에이\"\nstates"),
        "{text}"
    );
}

#[test]
fn board_add_card_lands_in_todo_after_migration() {
    // A board.json that kept the four old columns under Korean titles: "+ Card" must reach To do, not Working.
    let home = Home::new();
    let columns = serde_json::json!([
        {"id": "working", "title": "진행", "states": ["working"], "needs_decision": false},
        {"id": "needs-decision", "title": "결정 필요", "states": ["needs_decision"], "needs_decision": true},
        {"id": "review", "title": "검토", "states": ["review"], "needs_decision": false},
        {"id": "done", "title": "완료", "states": ["done"], "needs_decision": false},
    ]);
    let store = serde_json::json!({"version": 1, "columns": columns});
    fs::write(
        home.0.join("board.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
    let reply = board::handle(
        &home.0,
        &[],
        Request::BoardPut {
            id: None,
            title: "new".into(),
            note: String::new(),
            session_id: None,
            column: None,
        },
    )
    .unwrap();
    let Reply::BoardSnapshot { board } = reply else {
        panic!("unexpected reply: {reply:?}")
    };
    assert_eq!(board.cards.len(), 1);
    assert_eq!(board.cards[0]["column"], "todo");
}
