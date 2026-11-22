//! Needs-decision board cards as decision queue items (ticket v1b-18), through a real core's socket.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}
impl Core {
    fn new() -> Self {
        let mut core = Self {
            home: home::short("board-queue"),
            task: None,
        };
        core.start();
        core
    }
    fn start(&mut self) {
        let path = self.home.clone();
        let _ = fs::remove_file(self.home.join("window.json"));
        self.task = Some(thread::spawn(move || server::serve_recording(&path)));
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join("window.json").exists()
            || server::call(&self.home, Request::Snapshot).is_err()
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            let _ = server::call(&self.home, Request::Stop);
            assert!(task.join().unwrap().is_ok());
        }
    }
    fn call(&self, request: Request) -> Response {
        server::call(&self.home, request)
    }
    /// `nunchiro snapshot --json`'s `board_decisions`, as JSON.
    fn decisions(&self) -> Vec<Value> {
        let reply = serde_json::to_value(self.call(Request::Snapshot).unwrap()).unwrap();
        reply["board_decisions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    /// Polls the snapshot until `ok` holds, failing after 1 s (the acceptance bound).
    fn within_1s(&self, what: &str, ok: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let until = Instant::now() + Duration::from_secs(1);
        loop {
            let d = self.decisions();
            if ok(&d) {
                return d;
            }
            assert!(Instant::now() < until, "{what}: {d:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }
    /// Two columns plus the needs-decision one; `sources` names file sources under the home.
    fn config(&self, sources: &[&str]) {
        let mut toml = "version = 1\n[[columns]]\nid = 'working'\ntitle = 'Working'\nstates = ['working']\n[[columns]]\nid = 'ask'\ntitle = 'Needs decision'\nneeds_decision = true\nstates = ['needs_decision']\n[[columns]]\nid = 'done'\ntitle = 'Done'\nstates = ['done', 'review']\n".to_string();
        if !sources.is_empty() {
            toml += "[sources]\nversion = 1\n";
            for name in sources {
                toml += &format!(
                    "[[sources.entries]]\nname = '{name}'\nkind = 'file'\npath = {:?}\n",
                    self.source(name).to_str().unwrap()
                );
            }
        }
        fs::write(self.home.join("board.toml"), toml).unwrap();
    }
    fn source(&self, name: &str) -> PathBuf {
        self.home.join(format!("{name}.json"))
    }
    fn cards(&self, name: &str, cards: Value) {
        // Write then rename, so a poll never reads half a file.
        let tmp = self.home.join(format!("{name}.tmp"));
        fs::write(&tmp, json!({ "cards": cards }).to_string()).unwrap();
        fs::rename(tmp, self.source(name)).unwrap();
    }
    fn resolve(&self, identity: &str, updated_at: u64) -> Response {
        self.call(Request::BoardResolve {
            identity: identity.into(),
            updated_at,
        })
    }
    fn board(&self) -> Value {
        serde_json::to_value(self.call(Request::BoardSnapshot).unwrap()).unwrap()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stop();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn ids(d: &[Value]) -> Vec<&str> {
    d.iter().map(|i| i["identity"].as_str().unwrap()).collect()
}
fn flagged(id: &str, updated_at: u64, question: &str) -> Value {
    json!({"id": id, "title": format!("Card {id}"), "updated_at": updated_at, "needs_decision": {"question": question}})
}
fn resolved(home: &Path) -> Value {
    serde_json::from_slice::<Value>(&fs::read(home.join("board.json")).unwrap_or_default())
        .map(|v| v["resolved"].clone())
        .unwrap_or(Value::Null)
}

#[test]
fn board_queue_newer_updated_at_reraises() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 5, "Ship it?")]));
    let d = core.within_1s("flag raises", |d| d.len() == 1);
    assert_eq!(d[0]["identity"], "integration:roadmap:a");
    assert_eq!(d[0]["question"], "Ship it?");
    assert_eq!(d[0]["updated_at"], 5);
    let reply = serde_json::to_value(core.resolve("integration:roadmap:a", 5).unwrap()).unwrap();
    assert_eq!(reply["type"], "board_decisions");
    assert_eq!(reply["board_decisions"], json!([]));
    assert!(core.decisions().is_empty());
    // The same or an older updated_at stays resolved, even with other changes.
    for (at, question) in [(5, "Ship it now?"), (4, "Older?")] {
        core.cards("roadmap", json!([flagged("a", at, question)]));
        thread::sleep(Duration::from_millis(400));
        assert!(core.decisions().is_empty(), "updated_at {at} re-raised");
    }
    core.cards("roadmap", json!([flagged("a", 6, "Again?")]));
    let d = core.within_1s("newer updated_at re-raises", |d| d.len() == 1);
    assert_eq!(d[0]["question"], "Again?");
    assert_eq!(resolved(&core.home), json!({"integration:roadmap:a": 5}));
}

#[test]
fn board_queue_column_kind_manual_and_integration_raise() {
    let core = Core::new();
    core.config(&["roadmap"]);
    let Reply::BoardSnapshot { board } = core
        .call(Request::BoardPut {
            id: None,
            title: "결정할 카드".into(),
            note: String::new(),
            session_id: None,
            column: None,
        })
        .unwrap()
    else {
        panic!()
    };
    let id = board.cards[0]["id"].as_str().unwrap().to_string();
    assert!(core.decisions().is_empty(), "working column raised");
    core.call(Request::BoardMove {
        source: nunchiro_core::board::Source::Manual,
        id: id.clone(),
        column: "ask".into(),
    })
    .unwrap();
    // The board_move ack already refreshed the items.
    let d = core.decisions();
    assert_eq!(ids(&d), [format!("manual:{id}")]);
    assert_eq!(d[0]["question"], "결정할 카드");
    assert_eq!(d[0]["source"], "manual");
    core.cards(
        "roadmap",
        json!([{"id": "c", "title": "Column card", "updated_at": 1, "column": "ask", "url": "https://example.com/c"}]),
    );
    let d = core.within_1s("integration column card", |d| d.len() == 2);
    let card = d
        .iter()
        .find(|i| i["identity"] == "integration:roadmap:c")
        .unwrap();
    assert_eq!(card["question"], "Column card");
    assert_eq!(card["source_name"], "roadmap");
    assert_eq!(card["url"], "https://example.com/c");
}

fn fixture_session(id: &str, state: &str) -> Value {
    json!({"id": id, "kind": "claude", "project": "/project", "cwd": "/project", "label": format!("Label {id}"),
        "state": state, "agent_session_id": null, "agent_version": null, "untested": false, "pid": null})
}

#[test]
fn board_queue_session_cards_raise_nothing_even_when_dragged_into_the_column() {
    let mut core = Core::new();
    core.stop();
    fs::write(
        core.home.join("sessions.json"),
        json!({"version": 1, "sessions": [fixture_session("failed", "failed"), fixture_session("ended", "exited")]})
            .to_string(),
    )
    .unwrap();
    core.config(&[]);
    core.start();
    for id in ["failed", "ended"] {
        core.call(Request::BoardMove {
            source: nunchiro_core::board::Source::Session,
            id: id.into(),
            column: "ask".into(),
        })
        .unwrap();
        // The move's own refresh, before the tick's next one.
        assert!(core.decisions().is_empty(), "session {id} raised");
    }
    let board = core.board();
    assert_eq!(
        board["board"]["cards"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["column"] == "ask")
            .count(),
        2
    );
    thread::sleep(Duration::from_millis(300));
    assert!(core.decisions().is_empty());
}

#[test]
fn board_queue_leaving_deleted_or_removed_source_drops_without_resolving() {
    let core = Core::new();
    core.config(&["roadmap"]);
    let ask = json!({"id": "c", "title": "Leaves", "updated_at": 3, "column": "ask"});
    core.cards("roadmap", json!([ask]));
    core.within_1s("raised", |d| d.len() == 1);
    core.cards(
        "roadmap",
        json!([{"id": "c", "title": "Leaves", "updated_at": 3, "column": "working"}]),
    );
    core.within_1s("left the column", |d| d.is_empty());
    // Back with the same updated_at: it was dropped, not resolved, so it shows again.
    core.cards("roadmap", json!([ask]));
    core.within_1s("back in the column", |d| d.len() == 1);
    core.cards("roadmap", json!([]));
    core.within_1s("deleted", |d| d.is_empty());
    core.cards("roadmap", json!([ask]));
    core.within_1s("re-added", |d| d.len() == 1);
    core.config(&[]);
    core.within_1s("source removed", |d| d.is_empty());
    let Reply::BoardSnapshot { board } = core
        .call(Request::BoardPut {
            id: None,
            title: "Manual".into(),
            note: String::new(),
            session_id: None,
            column: Some("ask".into()),
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(core.decisions().len(), 1);
    core.call(Request::BoardDelete {
        id: board.cards[0]["id"].as_str().unwrap().into(),
    })
    .unwrap();
    assert!(core.decisions().is_empty());
    assert_eq!(resolved(&core.home), Value::Null);
}

#[test]
fn board_queue_source_read_error_keeps_last_good_items() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 1, "Keep me?")]));
    core.within_1s("raised", |d| d.len() == 1);
    fs::write(core.source("roadmap"), "{\n bad").unwrap();
    thread::sleep(Duration::from_millis(500));
    let board = core.board();
    assert!(board["board"]["sources"][0]["error"].is_string(), "{board}");
    assert_eq!(ids(&core.decisions()), ["integration:roadmap:a"]);
}

#[test]
fn board_queue_restart_keeps_resolutions_and_raises_before_any_board_read() {
    let mut core = Core::new();
    core.config(&["roadmap"]);
    core.cards(
        "roadmap",
        json!([flagged("a", 1, "Answered"), flagged("b", 1, "Open")]),
    );
    core.within_1s("raised", |d| d.len() == 2);
    core.resolve("integration:roadmap:a", 1).unwrap();
    core.stop();
    core.cards(
        "roadmap",
        json!([
            flagged("a", 1, "Answered"),
            flagged("b", 1, "Open"),
            flagged("c", 1, "New while down")
        ]),
    );
    core.start();
    // No board request: the core registered the source at start.
    let d = core.within_1s("after restart", |d| d.len() == 2);
    assert_eq!(ids(&d), ["integration:roadmap:b", "integration:roadmap:c"]);
}

#[test]
fn board_queue_stale_resolve_is_refused_and_the_new_question_shows() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 1, "First?")]));
    core.within_1s("raised", |d| d.len() == 1);
    core.cards("roadmap", json!([flagged("a", 2, "Changed?")]));
    core.within_1s("changed", |d| d.len() == 1 && d[0]["updated_at"] == 2);
    assert_eq!(
        core.resolve("integration:roadmap:a", 1).unwrap_err(),
        "card changed"
    );
    assert_eq!(core.decisions()[0]["question"], "Changed?");
    assert_eq!(
        core.resolve("integration:roadmap:missing", 1).unwrap_err(),
        "board decision not found"
    );
    assert_eq!(resolved(&core.home), Value::Null);
}

#[test]
fn board_queue_resolve_refuses_a_session_token() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 1, "Owner only?")]));
    core.within_1s("raised", |d| d.len() == 1);
    let Reply::Started { session } = core
        .call(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: "token".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    else {
        panic!()
    };
    let until = Instant::now() + Duration::from_secs(5);
    let token = loop {
        let Reply::Output { data, .. } = core
            .call(Request::Read {
                id: session.id.clone(),
                after: 0,
            })
            .unwrap()
        else {
            panic!()
        };
        let text = String::from_utf8_lossy(&data).into_owned();
        if let Some(line) = text
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
        {
            break line.trim().to_string();
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    };
    use std::io::{BufRead, BufReader, Write};
    let as_session = |request: Value| -> Value {
        let mut s = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };
    let answer =
        json!({"op": "board_resolve", "identity": "integration:roadmap:a", "updated_at": 1});
    assert_eq!(
        as_session(answer.clone()),
        json!({"Err": "operation not granted"})
    );
    assert_eq!(
        as_session(json!({"op": "remote", "machine": "x", "request": answer})),
        json!({"Err": "remote operation not granted"})
    );
    // A session's own snapshot carries no board decisions.
    assert!(as_session(json!({"op": "snapshot"}))["Ok"]["board_decisions"].is_null());
    assert_eq!(core.decisions().len(), 1);
    assert_eq!(resolved(&core.home), Value::Null);
    core.call(Request::Close { id: session.id }).unwrap();
}

#[test]
fn board_queue_same_id_in_two_sources_is_two_items() {
    let core = Core::new();
    core.config(&["jira", "linear"]);
    core.cards("jira", json!([flagged("x", 1, "From Jira")]));
    core.cards("linear", json!([flagged("x", 1, "From Linear")]));
    let d = core.within_1s("two items", |d| d.len() == 2);
    assert_eq!(ids(&d), ["integration:jira:x", "integration:linear:x"]);
    core.resolve("integration:jira:x", 1).unwrap();
    assert_eq!(ids(&core.decisions()), ["integration:linear:x"]);
}

#[test]
fn board_queue_counts_every_one_of_500_flagged_cards() {
    let core = Core::new();
    core.config(&["bulk"]);
    let cards: Vec<_> = (0..500)
        .map(|i| flagged(&format!("c{i}"), 1, "Many?"))
        .collect();
    core.cards("bulk", json!(cards));
    core.within_1s("500 items", |d| d.len() == 500);
}

#[test]
fn board_queue_project_comes_from_the_card_or_the_linked_session() {
    let mut core = Core::new();
    core.stop();
    fs::write(
        core.home.join("sessions.json"),
        json!({"version": 1, "sessions": [fixture_session("s", "exited")]}).to_string(),
    )
    .unwrap();
    core.config(&["roadmap"]);
    core.start();
    core.cards(
        "roadmap",
        json!([
            flagged("none", 1, "No project"),
            {"id": "known", "title": "Known", "updated_at": 1, "project": "/project", "needs_decision": {"question": "Q"}},
        ]),
    );
    core.call(Request::BoardPut {
        id: None,
        title: "Linked".into(),
        note: String::new(),
        session_id: Some("s".into()),
        column: Some("ask".into()),
    })
    .unwrap();
    let d = core.within_1s("three items", |d| d.len() == 3);
    let project = |identity: &str| {
        d.iter()
            .find(|i| {
                i["identity"].as_str().unwrap().ends_with(identity) || i["source"] == identity
            })
            .unwrap()["project"]
            .clone()
    };
    assert_eq!(project(":none"), Value::Null);
    assert_eq!(project(":known"), "/project");
    assert_eq!(project("manual"), "/project");
}

#[test]
fn board_queue_resolutions_are_bounded_and_evict_the_oldest() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 10_000, "Bound?")]));
    core.within_1s("raised", |d| d.len() == 1);
    let mut board: Value =
        serde_json::from_slice(&fs::read(core.home.join("board.json")).unwrap_or_else(|_| {
            core.board();
            fs::read(core.home.join("board.json")).unwrap()
        }))
        .unwrap();
    board["resolved"] = (0..4096)
        .map(|i| (format!("manual:old{i}"), json!(i + 1)))
        .collect::<serde_json::Map<_, _>>()
        .into();
    fs::write(core.home.join("board.json"), board.to_string()).unwrap();
    core.resolve("integration:roadmap:a", 10_000).unwrap();
    let r = resolved(&core.home);
    let r = r.as_object().unwrap();
    assert_eq!(r.len(), 4096);
    assert!(!r.contains_key("manual:old0"), "oldest kept");
    assert_eq!(r["integration:roadmap:a"], 10_000);
}

#[test]
fn board_queue_removed_or_replaced_source_drops_its_resolutions() {
    let core = Core::new();
    core.config(&["roadmap", "other"]);
    core.cards("roadmap", json!([flagged("a", 1, "Reused name?")]));
    core.cards("other", json!([flagged("b", 1, "Stays?")]));
    core.within_1s("raised", |d| d.len() == 2);
    core.resolve("integration:roadmap:a", 1).unwrap();
    core.resolve("integration:other:b", 1).unwrap();
    // Removed: a later source with the same name must not inherit the answer.
    core.config(&["other"]);
    let until = Instant::now() + Duration::from_secs(1);
    while resolved(&core.home).get("integration:roadmap:a").is_some() {
        assert!(Instant::now() < until, "{}", resolved(&core.home));
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(resolved(&core.home), json!({"integration:other:b": 1}));
    core.config(&["roadmap", "other"]);
    core.within_1s("same name re-added raises again", |d| {
        ids(d) == ["integration:roadmap:a"]
    });
    // Replaced: the same name pointing at another input is another integration.
    core.resolve("integration:roadmap:a", 1).unwrap();
    fs::copy(core.source("roadmap"), core.source("moved")).unwrap();
    let toml = fs::read_to_string(core.home.join("board.toml"))
        .unwrap()
        .replace(
            core.source("roadmap").to_str().unwrap(),
            core.source("moved").to_str().unwrap(),
        );
    fs::write(core.home.join("board.toml"), toml).unwrap();
    core.within_1s("replaced declaration raises again", |d| {
        ids(d) == ["integration:roadmap:a"]
    });
    assert_eq!(resolved(&core.home), json!({"integration:other:b": 1}));
}

#[test]
fn board_queue_full_store_never_evicts_the_resolution_just_made() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 0, "Oldest of all?")]));
    core.within_1s("raised", |d| d.len() == 1);
    core.board();
    let mut board: Value =
        serde_json::from_slice(&fs::read(core.home.join("board.json")).unwrap()).unwrap();
    board["resolved"] = (0..4096)
        .map(|i| (format!("manual:new{i}"), json!(1_000_000 + i)))
        .collect::<serde_json::Map<_, _>>()
        .into();
    fs::write(core.home.join("board.json"), board.to_string()).unwrap();
    core.resolve("integration:roadmap:a", 0).unwrap();
    let r = resolved(&core.home);
    let r = r.as_object().unwrap();
    assert_eq!(r.len(), 4096);
    assert_eq!(
        r["integration:roadmap:a"], 0,
        "the new resolution evicted itself"
    );
    assert!(!r.contains_key("manual:new0"), "the oldest other was kept");
    thread::sleep(Duration::from_millis(300));
    assert!(core.decisions().is_empty(), "resolved card still raised");
}

#[test]
fn board_queue_broken_resolutions_store_is_refused_untouched() {
    let core = Core::new();
    core.config(&["roadmap"]);
    core.cards("roadmap", json!([flagged("a", 1, "Broken?")]));
    core.within_1s("raised", |d| d.len() == 1);
    core.board();
    let good: Value =
        serde_json::from_slice(&fs::read(core.home.join("board.json")).unwrap()).unwrap();
    let too_many: serde_json::Map<_, _> = (0..4097)
        .map(|i| (format!("manual:{i}"), json!(1)))
        .collect();
    for bad in [
        json!([]),
        json!({"manual:x": "one"}),
        json!({"": 1}),
        json!(too_many),
    ] {
        let mut store = good.clone();
        store["resolved"] = bad;
        let bytes = store.to_string();
        fs::write(core.home.join("board.json"), &bytes).unwrap();
        assert!(core.resolve("integration:roadmap:a", 1).is_err());
        assert!(core.call(Request::BoardSnapshot).is_err());
        // The last good items stay and the snapshot still answers.
        assert_eq!(core.decisions().len(), 1);
        assert_eq!(
            fs::read_to_string(core.home.join("board.json")).unwrap(),
            bytes
        );
    }
}

// Q9 tt-J12-1: a core that starts while board.toml does not parse keeps the answers once the file is fixed.
#[test]
fn board_queue_start_on_a_broken_board_toml_keeps_resolutions_when_fixed() {
    let mut old = Core::new();
    old.config(&["roadmap"]);
    old.cards(
        "roadmap",
        json!([flagged("a", 1, "Answered"), flagged("b", 1, "Open")]),
    );
    old.within_1s("raised", |d| d.len() == 2);
    old.resolve("integration:roadmap:a", 1).unwrap();
    old.stop();
    // A home this process never compared, as after a restart.
    let mut core = Core {
        home: home::short("board-queue"),
        task: None,
    };
    fs::copy(old.home.join("board.json"), core.home.join("board.json")).unwrap();
    fs::copy(old.source("roadmap"), core.source("roadmap")).unwrap();
    fs::write(core.home.join("board.toml"), "version = [").unwrap();
    core.start();
    core.decisions();
    core.config(&["roadmap"]);
    core.within_1s("fixed", |d| ids(d) == ["integration:roadmap:b"]);
    assert_eq!(resolved(&core.home), json!({"integration:roadmap:a": 1}));
}
