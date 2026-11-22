//! V2.5-38 (ticket 186): board.toml `[settings]` (`stale_minutes`, `turn_end_nudge`) through
//! `board_settings_put`: the owner's and the window's only, revision checked, written with toml_edit.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    board::{
        self,
        rights::{Writer, serve},
    },
    server::call,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "board-settings-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn toml(&self) -> PathBuf {
        self.0.join("board.toml")
    }
    fn send(&self, writer: Writer, request: Value) -> Result<board::Snapshot, String> {
        match serve(
            &self.0,
            &[],
            writer,
            serde_json::from_value(request).unwrap(),
        )? {
            Reply::BoardSnapshot { board } => Ok(board),
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    fn snapshot(&self) -> board::Snapshot {
        self.send(Writer::Owner, json!({"op": "board_snapshot"}))
            .unwrap()
    }
    fn put(&self, revision: &str, stale: u32, nudge: bool) -> Result<board::Snapshot, String> {
        self.send(
            Writer::Owner,
            json!({"op": "board_settings_put", "revision": revision, "stale_minutes": stale, "turn_end_nudge": nudge}),
        )
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const HAND: &str = "# my board\nversion = 2\n\n[[columns]]\nid = \"todo\"   # first\ntitle = \"할 일\"\n\n[[columns]]\nid = \"done\"\ntitle = \"Done\"\nstates = [\"done\"]\nproof = true\n";

#[test]
fn board_settings_put_round_trip() {
    let home = Home::new();
    fs::write(home.toml(), HAND).unwrap();
    let before = home.snapshot();
    assert_eq!(
        before.settings,
        board::Settings {
            stale_minutes: 10,
            turn_end_nudge: true
        }
    );
    let after = home.put(&before.revision, 5, false).unwrap();
    assert_eq!(
        after.settings,
        board::Settings {
            stale_minutes: 5,
            turn_end_nudge: false
        }
    );
    // Columns and comments keep their bytes; `[settings]` is appended.
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        format!("{HAND}\n[settings]\nstale_minutes = 5\nturn_end_nudge = false\n")
    );
    assert_eq!(after.columns, before.columns);
    assert_ne!(after.revision, before.revision);
    // A second write edits the values in place, keeping a comment on the line.
    let text = fs::read_to_string(home.toml())
        .unwrap()
        .replace("stale_minutes = 5", "stale_minutes = 5 # team rule");
    fs::write(home.toml(), &text).unwrap();
    let now = home.snapshot();
    let again = home.put(&now.revision, 30, false).unwrap();
    assert_eq!(again.settings.stale_minutes, 30);
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        text.replace("stale_minutes = 5 ", "stale_minutes = 30 ")
    );
    // The snapshot JSON carries both keys.
    let wire = serde_json::to_value(&again).unwrap();
    assert_eq!(
        wire["settings"],
        json!({"stale_minutes": 30, "turn_end_nudge": false})
    );
}

#[test]
fn board_settings_put_round_trip_edges() {
    let home = Home::new();
    fs::write(home.toml(), HAND).unwrap();
    let board = home.snapshot();
    // Out of range: refused, nothing written.
    for stale in [0, 1441, u32::MAX] {
        assert_eq!(
            home.put(&board.revision, stale, true).unwrap_err(),
            "settings.stale_minutes must be 1 to 1440"
        );
        assert_eq!(fs::read_to_string(home.toml()).unwrap(), HAND);
    }
    // Wrong types never reach the writer: the request does not parse.
    for bad in [
        json!({"op": "board_settings_put", "revision": board.revision, "stale_minutes": "5", "turn_end_nudge": true}),
        json!({"op": "board_settings_put", "revision": board.revision, "stale_minutes": -1, "turn_end_nudge": true}),
        json!({"op": "board_settings_put", "revision": board.revision, "stale_minutes": 5, "turn_end_nudge": "no"}),
        json!({"op": "board_settings_put", "revision": board.revision, "stale_minutes": 5}),
    ] {
        assert!(
            serde_json::from_value::<Request>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    // A stale revision (a column edit saved first) is refused with the columns' line; the file keeps its bytes.
    let mut columns = board.columns.clone();
    columns[0].title = "Backlog".into();
    home.send(
        Writer::Owner,
        json!({"op": "board_columns_put", "revision": board.revision, "columns": columns}),
    )
    .unwrap();
    let saved = fs::read_to_string(home.toml()).unwrap();
    assert_eq!(
        home.put(&board.revision, 5, false).unwrap_err(),
        "board.toml changed, reloaded"
    );
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), saved);
    // A broken board.toml is refused whole, bytes unchanged.
    fs::write(home.toml(), "version = 2\ncolumns = 3\n").unwrap();
    let broken = home.snapshot();
    assert!(broken.error.is_some());
    assert!(home.put(&broken.revision, 5, false).is_err());
    assert_eq!(
        fs::read_to_string(home.toml()).unwrap(),
        "version = 2\ncolumns = 3\n"
    );
}

#[test]
fn board_settings_put_creates_only_what_is_needed() {
    let home = Home::new();
    let board = home.snapshot();
    assert_eq!(board.revision, "");
    let after = home.put("", 5, true).unwrap();
    let text = fs::read_to_string(home.toml()).unwrap();
    // The board as shown (the five default columns, so the file parses) and the settings; no other table.
    assert!(
        text.starts_with("version = 2\n\n[[columns]]\nid = \"todo\"\n"),
        "{text}"
    );
    assert!(
        text.ends_with("\n[settings]\nstale_minutes = 5\nturn_end_nudge = true\n"),
        "{text}"
    );
    assert_eq!(text.matches("[[columns]]").count(), 5);
    assert!(!text.contains("[sources]"));
    assert_eq!(after.columns, board.columns);
    assert_eq!(after.settings.stale_minutes, 5);
}

#[test]
fn board_settings_both_keys_parse() {
    let home = Home::new();
    let cases = [
        ("", Some((10, true))),
        ("\n[settings]\nturn_end_nudge = false\n", Some((10, false))),
        (
            "\n[settings]\nstale_minutes = 3\nturn_end_nudge = false\n",
            Some((3, false)),
        ),
        ("\n[settings]\nturn_end_nudge = true\nloud = 1\n", None),
    ];
    for (tail, want) in cases {
        fs::write(home.toml(), format!("{HAND}{tail}")).unwrap();
        let board = home.snapshot();
        match want {
            Some((stale, nudge)) => {
                assert!(board.error.is_none(), "{tail}: {:?}", board.error);
                assert_eq!(
                    (board.settings.stale_minutes, board.settings.turn_end_nudge),
                    (stale, nudge),
                    "{tail}"
                );
            }
            None => assert!(
                board
                    .error
                    .as_deref()
                    .is_some_and(|e| e.contains("unknown field")),
                "{tail}: {:?}",
                board.error
            ),
        }
    }
}

// Threat 1: an agent's session token cannot turn the nudge off or hide stale cards. The rights check refuses it
// (second wall) and, through a real `serve`, `check_agent` refuses it first; board.toml keeps its bytes.
#[test]
fn board_settings_put_agent_refused() {
    let home = Home::new();
    fs::write(home.toml(), HAND).unwrap();
    let board = home.snapshot();
    assert_eq!(
        home.send(
            Writer::Session("w1"),
            json!({"op": "board_settings_put", "revision": board.revision, "stale_minutes": 1440, "turn_end_nudge": false}),
        )
        .unwrap_err(),
        "operation not granted"
    );
    assert_eq!(fs::read_to_string(home.toml()).unwrap(), HAND);

    let home = home::short("bset");
    fs::write(home.join("board.toml"), HAND).unwrap();
    let _core = home::spawn_serve(&home, &[]);
    let token = agent_token(&home);
    let revision = match call(&home, Request::BoardSnapshot).unwrap() {
        Reply::BoardSnapshot { board } => board.revision,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        raw(
            &home,
            &token,
            json!({"op": "board_settings_put", "revision": revision, "stale_minutes": 1440, "turn_end_nudge": false})
        ),
        json!({"Err": "operation not granted"})
    );
    assert_eq!(fs::read_to_string(home.join("board.toml")).unwrap(), HAND);
    // The owner's own call through the same core writes.
    match call(
        &home,
        Request::BoardSettingsPut {
            revision,
            stale_minutes: 7,
            turn_end_nudge: true,
        },
    )
    .unwrap()
    {
        Reply::BoardSnapshot { board } => assert_eq!(board.settings.stale_minutes, 7),
        other => panic!("{other:?}"),
    }
}

fn agent_token(home: &Path) -> String {
    let id = match call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.to_path_buf(),
                worktree: false,
                label: String::new(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session.id,
        other => panic!("{other:?}"),
    };
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(Reply::Output { data, .. }) = call(
            home,
            Request::Read {
                id: id.clone(),
                after: 0,
            },
        ) && let Some(t) = String::from_utf8_lossy(&data)
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            && !t.trim().is_empty()
        {
            return t.trim().to_string();
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    }
}

fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token": token, "request": request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}
