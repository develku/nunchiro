use nunchiro_core::{
    api::{Reply, Request},
    board,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "sources-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn snapshot(&self) -> serde_json::Value {
        match board::handle(&self.0, &[], Request::BoardSnapshot).unwrap() {
            Reply::BoardSnapshot { board } => serde_json::to_value(board).unwrap(),
            _ => panic!("unexpected reply"),
        }
    }
    fn config(&self) {
        fs::write(self.0.join("board.toml"), format!("version = 1\n[[columns]]\nid = 'working'\ntitle = 'Working'\n[sources]\nversion = 1\n[[sources.entries]]\nname = 'roadmap'\nkind = 'file'\npath = {:?}\n", self.0.join("cards.json").to_str().unwrap())).unwrap();
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn board_sources_file_bad_json_keeps_last_good_and_never_writes_input() {
    let h = Home::new();
    h.config();
    use sha2::{Digest, Sha256};
    let good = include_str!("fixtures/board_sources/cards.json");
    fs::write(h.0.join("cards.json"), good).unwrap();
    let first = h.snapshot();
    assert_eq!(first["cards"][0]["title"], "한국어 카드");
    assert_eq!(
        Sha256::digest(fs::read(h.0.join("cards.json")).unwrap()),
        Sha256::digest(good.as_bytes())
    );
    fs::write(h.0.join("cards.json"), "{\n bad").unwrap();
    let bad = h.snapshot();
    assert_eq!(bad["cards"], first["cards"]);
    assert!(
        bad["sources"][0]["error"]
            .as_str()
            .unwrap()
            .contains("line 2")
    );
    assert_eq!(
        fs::read_to_string(h.0.join("cards.json")).unwrap(),
        "{\n bad"
    );
}
#[test]
fn board_sources_unapproved_or_changed_command_never_spawns() {
    let h = Home::new();
    let dir = h.0.join("sources/demo");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\ninterval=1\n",
    )
    .unwrap();
    fs::write(
        dir.join("run.sh"),
        "echo spawned > \"$NUNCHIRO_CACHE/spawned\"\necho '{\"cards\":[]}'\n",
    )
    .unwrap();
    assert!(nunchiro_core::approval::check_source(&h.0, "demo").is_err());
    let view = nunchiro_core::approval::source_status(&h.0, "demo").unwrap();
    nunchiro_core::approval::grant_source(
        &h.0,
        "demo",
        nunchiro_core::approval::Level::Read,
        &view.hash,
    )
    .unwrap();
    assert!(nunchiro_core::approval::check(&h.0, "demo").is_err());
    fs::write(
        dir.join("run.sh"),
        "echo changed > \"$NUNCHIRO_CACHE/spawned\"\n",
    )
    .unwrap();
    assert!(nunchiro_core::approval::check_source(&h.0, "demo").is_err());
    assert!(!dir.join("cache/spawned").exists());
}
#[test]
fn board_sources_snapshot_survives_change_and_intermediate_symlink_is_refused() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    let d = h.0.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(d.join("run.sh"), "echo original\n").unwrap();
    let v = approval::source_status(&h.0, "demo").unwrap();
    approval::grant_source(&h.0, "demo", Level::Read, &v.hash).unwrap();
    let proof = approval::check_source(&h.0, "demo").unwrap();
    fs::write(d.join("run.sh"), "echo changed\n").unwrap();
    assert_eq!(
        proof
            .files()
            .iter()
            .find(|f| f.path() == "run.sh")
            .unwrap()
            .bytes(),
        b"echo original\n"
    );
    assert!(approval::check_source(&h.0, "demo").is_err());
    fs::rename(h.0.join("sources"), h.0.join("real-sources")).unwrap();
    std::os::unix::fs::symlink(h.0.join("real-sources"), h.0.join("sources")).unwrap();
    assert!(
        approval::source_status(&h.0, "demo")
            .unwrap_err()
            .contains("symlink")
    );
}
#[test]
fn board_sources_schema_round_trip_newer_and_unknown_refused_untouched() {
    let h = Home::new();
    h.config();
    fs::write(
        h.0.join("cards.json"),
        include_str!("fixtures/board_sources/cards.json"),
    )
    .unwrap();
    let first = h.snapshot();
    assert!(first["error"].is_null(), "{first}");
    let text = fs::read_to_string(h.0.join("board.toml")).unwrap();
    let value: toml::Value = toml::from_str(&text).unwrap();
    fs::write(h.0.join("board.toml"), toml::to_string(&value).unwrap()).unwrap();
    assert_eq!(h.snapshot()["cards"], first["cards"]);
    for invalid in [
        text.replace("[sources]\nversion = 1", "[sources]\nversion = 2"),
        text.replace(
            "[sources]\nversion = 1",
            "[sources]\nversion = 1\nunknown = true",
        ),
    ] {
        fs::write(h.0.join("board.toml"), &invalid).unwrap();
        let b = h.snapshot();
        assert!(b["error"].as_str().is_some(), "{b}");
        assert_eq!(b["cards"], first["cards"]);
        assert_eq!(fs::read_to_string(h.0.join("board.toml")).unwrap(), invalid);
    }
}
#[test]
fn board_sources_command_feeds_cards_and_move_is_read_only() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    let d = h.0.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\ninterval=1\n",
    )
    .unwrap();
    let script = "echo '{\"cards\":[{\"id\":\"cmd\",\"title\":\"명령 카드\",\"updated_at\":7}]}'\n";
    fs::write(d.join("run.sh"), script).unwrap();
    fs::write(h.0.join("board.toml"),"version=1\n[[columns]]\nid='working'\ntitle='Working'\n[[columns]]\nid='done'\ntitle='Done'\n[sources]\nversion=1\n[[sources.entries]]\nname='command'\nkind='command'\nsubject='demo'\n").unwrap();
    let first = h.snapshot();
    assert!(
        first["sources"][0]["error"]
            .as_str()
            .unwrap()
            .contains("approval")
    );
    assert!(!d.join("cache").exists());
    let v = approval::source_status(&h.0, "demo").unwrap();
    approval::grant_source(&h.0, "demo", Level::Read, &v.hash).unwrap();
    let start = std::time::Instant::now();
    let board = loop {
        let b = h.snapshot();
        if !b["cards"].as_array().unwrap().is_empty() {
            break b;
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(5), "{b}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(board["cards"][0]["title"], "명령 카드");
    board::sources::move_card(&h.0, "command", "cmd", "done").unwrap();
    assert_eq!(h.snapshot()["cards"][0]["column"], "done");
    assert_eq!(fs::read_to_string(d.join("run.sh")).unwrap(), script);
    fs::write(
        d.join("run.sh"),
        "echo should-not-run > \"$NUNCHIRO_CACHE/spawned\"\n",
    )
    .unwrap();
    let changed = h.snapshot();
    assert!(
        changed["sources"][0]["error"]
            .as_str()
            .unwrap()
            .contains("approval")
    );
    assert!(!d.join("cache/spawned").exists());
}
#[test]
fn board_sources_card_trust_boundary_validation() {
    use board::sources::parse;
    for text in [
        r#"{}"#,
        r#"{"cards":[{"id":"a","title":"T"}]}"#,
        r#"{"cards":[{"id":"a","title":"T","updated_at":"1"}]}"#,
        r#"{"cards":[{"id":"a","title":"","updated_at":1}]}"#,
        r#"{"cards":[{"id":"a","title":"T","updated_at":1,"url":"javascript:alert(1)"}]}"#,
        r#"{"cards":[{"id":"a","title":"T","updated_at":1,"url":"ftp://example.com/"}]}"#,
        r#"{"cards":[{"id":"a","title":"T","updated_at":1,"url":"https://"}]}"#,
        r#"{"cards":[{"id":"a","title":"T","updated_at":1},{"id":"a","title":"U","updated_at":2}]}"#,
    ] {
        assert!(parse(text.as_bytes()).is_err(), "{text}");
    }
    assert!(parse(&vec![b' '; 1024 * 1024 + 1]).is_err());
    let card = serde_json::json!({"id":"a","title":"T","updated_at":1});
    let cards = serde_json::json!({"cards":vec![card;4097]});
    assert!(parse(&serde_json::to_vec(&cards).unwrap()).is_err());
    assert!(parse(br#"{"cards":[{"id":"a","title":"T","updated_at":1,"url":"https://example.com/","needs_decision":{"question":"Approve?"},"ignored":true}]}"#).is_ok());
}
#[test]
fn board_sources_widget_and_source_grants_cannot_cross_namespaces() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    for kind in ["widgets", "sources"] {
        let d = h.0.join(kind).join("same");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            "version=1\nkind='integration'\ncommand=['/usr/bin/true']\n",
        )
        .unwrap();
    }
    let v = approval::status(&h.0, "same").unwrap();
    approval::grant(&h.0, "same", Level::Read, &v.hash).unwrap();
    assert!(approval::check_source(&h.0, "same").is_err());
    let v = approval::source_status(&h.0, "same").unwrap();
    approval::grant_source(&h.0, "same", Level::Read, &v.hash).unwrap();
    assert!(approval::check(&h.0, "same").is_ok());
    assert!(approval::check_source(&h.0, "same").is_ok());
    let bytes = fs::read(h.0.join("approvals.json")).unwrap();
    let mut store: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    store["approvals"]
        .as_array_mut()
        .unwrap()
        .retain(|a| a["kind"] == "source");
    fs::write(
        h.0.join("approvals.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
    assert!(approval::check(&h.0, "same").is_err());
    assert!(approval::check_source(&h.0, "same").is_ok());
    for invalid in [
        serde_json::json!([]),
        serde_json::json!({"version":1,"approvals":"wrong"}),
        serde_json::json!({"version":1,"approvals":[store["approvals"][0].clone(),store["approvals"][0].clone()]}),
    ] {
        let bytes = serde_json::to_vec(&invalid).unwrap();
        fs::write(h.0.join("approvals.json"), &bytes).unwrap();
        assert!(approval::source_status(&h.0, "same").is_err());
        assert_eq!(fs::read(h.0.join("approvals.json")).unwrap(), bytes);
    }
}
#[test]
fn board_sources_two_commands_can_run_together_without_overlapping_themselves() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    let mut config =
        "version=1\n[[columns]]\nid='working'\ntitle='Working'\n[sources]\nversion=1\n".to_string();
    for name in ["first", "second"] {
        let d = h.0.join("sources").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\ninterval=1\n",
        )
        .unwrap();
        fs::write(d.join("run.sh"),format!("echo started >> \"$NUNCHIRO_CACHE/runs\"\n/bin/sleep 1\necho '{{\"cards\":[{{\"id\":\"{name}\",\"title\":\"{name}\",\"updated_at\":1}}]}}'\n")).unwrap();
        let v = approval::source_status(&h.0, name).unwrap();
        approval::grant_source(&h.0, name, Level::Read, &v.hash).unwrap();
        config +=
            &format!("[[sources.entries]]\nname='{name}'\nkind='command'\nsubject='{name}'\n");
    }
    fs::write(h.0.join("board.toml"), config).unwrap();
    let b = h.snapshot();
    assert!(
        b["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["running"] == true)
    );
    let start = std::time::Instant::now();
    loop {
        let b = h.snapshot();
        if b["cards"].as_array().unwrap().len() == 2 {
            break;
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(8), "{b}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    for _ in 0..3 {
        h.snapshot();
    }
    for name in ["first", "second"] {
        assert_eq!(
            fs::read_to_string(h.0.join("sources").join(name).join("cache/runs")).unwrap(),
            "started\n"
        );
    }
    assert_eq!(board::sources::INTERVAL_FLOOR_SECS, 30);
}
#[test]
fn board_sources_deleted_config_clears_sources_and_replacement_reloads_input() {
    let h = Home::new();
    h.config();
    fs::write(
        h.0.join("cards.json"),
        include_str!("fixtures/board_sources/cards.json"),
    )
    .unwrap();
    assert_eq!(h.snapshot()["cards"].as_array().unwrap().len(), 1);
    fs::remove_file(h.0.join("board.toml")).unwrap();
    let b = h.snapshot();
    assert!(b.get("sources").is_none());
    assert!(b["cards"].as_array().unwrap().is_empty());
    h.config();
    assert_eq!(h.snapshot()["cards"].as_array().unwrap().len(), 1);
    fs::write(
        h.0.join("new.json"),
        r#"{"cards":[{"id":"new","title":"New input","updated_at":1}]}"#,
    )
    .unwrap();
    let config = fs::read_to_string(h.0.join("board.toml"))
        .unwrap()
        .replace("cards.json", "new.json");
    fs::write(h.0.join("board.toml"), config).unwrap();
    assert_eq!(h.snapshot()["cards"][0]["id"], "new");
}
#[test]
fn board_sources_interval_runs_without_board_polling() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    let d = h.0.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\ninterval=1\n",
    )
    .unwrap();
    fs::write(
        d.join("run.sh"),
        "echo run >> \"$NUNCHIRO_CACHE/runs\"\necho '{\"cards\":[]}'\n",
    )
    .unwrap();
    let v = approval::source_status(&h.0, "demo").unwrap();
    approval::grant_source(&h.0, "demo", Level::Read, &v.hash).unwrap();
    fs::write(h.0.join("board.toml"),"version=1\n[[columns]]\nid='working'\ntitle='Working'\n[sources]\nversion=1\n[[sources.entries]]\nname='demo'\nkind='command'\nsubject='demo'\n").unwrap();
    h.snapshot(); // Register once; no subsequent board read may drive the second run.
    let start = std::time::Instant::now();
    // v1a-17: the 30 s floor (asserted below) is the contract; this deadline only turns a background run that
    // never comes into a failure, and is no bound on how soon after the floor it comes.
    loop {
        if fs::read_to_string(d.join("cache/runs"))
            .unwrap_or_default()
            .lines()
            .count()
            >= 2
        {
            break;
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(90),
            "background interval did not run"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(start.elapsed() >= std::time::Duration::from_secs(30));
}

#[test]
fn board_sources_symlinked_trusted_home_works_but_subject_symlinks_are_refused() {
    use nunchiro_core::approval::{self, Level};
    use std::os::unix::fs::symlink;
    let h = Home::new();
    let real = h.0.join("real");
    fs::create_dir_all(&real).unwrap();
    let link = h.0.join("linked-home");
    symlink(&real, &link).unwrap();
    for root in ["widgets", "sources"] {
        let dir = real.join(root).join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("widget.toml"),
            "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\n",
        )
        .unwrap();
        fs::write(dir.join("run.sh"), "echo approved\n").unwrap();
    }
    let v = approval::status(&link, "demo").unwrap();
    approval::grant(&link, "demo", Level::Read, &v.hash).unwrap();
    assert!(approval::check(&link, "demo").is_ok());
    let v = approval::source_status(&link, "demo").unwrap();
    approval::grant_source(&link, "demo", Level::Read, &v.hash).unwrap();
    assert!(approval::check_source(&link, "demo").is_ok());
    for root in ["widgets", "sources"] {
        let dir = real.join(root).join("demo");
        symlink(h.0.join("outside"), dir.join("nested")).unwrap();
        let status = if root == "widgets" {
            approval::status(&link, "demo")
        } else {
            approval::source_status(&link, "demo")
        };
        assert!(status.is_err());
        fs::remove_file(dir.join("nested")).unwrap();
        fs::rename(&dir, real.join(format!("{root}-saved"))).unwrap();
        symlink(real.join(format!("{root}-saved")), &dir).unwrap();
        let status = if root == "widgets" {
            approval::status(&link, "demo")
        } else {
            approval::source_status(&link, "demo")
        };
        assert!(status.is_err());
        fs::remove_file(&dir).unwrap();
        fs::rename(real.join(format!("{root}-saved")), &dir).unwrap();
        fs::rename(real.join(root), real.join(format!("{root}-root-saved"))).unwrap();
        symlink(real.join(format!("{root}-root-saved")), real.join(root)).unwrap();
        let status = if root == "widgets" {
            approval::status(&link, "demo")
        } else {
            approval::source_status(&link, "demo")
        };
        assert!(status.is_err());
    }
}

#[test]
fn board_sources_approval_errors_name_the_integration_source() {
    use nunchiro_core::approval::{self, Level};
    let h = Home::new();
    let d = h.0.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/usr/bin/true']\n",
    )
    .unwrap();
    for error in [
        approval::check_source(&h.0, "demo").unwrap_err(),
        approval::source_status(&h.0, "../bad").unwrap_err(),
        approval::grant_source(&h.0, "demo", Level::Read, "stale").unwrap_err(),
    ] {
        assert!(error.contains("integration source"), "{error}");
        assert!(!error.contains("widget "), "{error}");
    }
}

#[test]
fn board_sources_foreground_metadata_rejects_oversized_flat_folder() {
    let h = Home::new();
    let d = h.0.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    for n in 0..4001 {
        fs::write(d.join(n.to_string()), "").unwrap();
    }
    fs::write(h.0.join("board.toml"), "version=1\n[[columns]]\nid='working'\ntitle='Working'\n[sources]\nversion=1\n[[sources.entries]]\nname='demo'\nkind='command'\nsubject='demo'\n").unwrap();
    let first = h.snapshot();
    assert!(
        first["sources"][0]["error"]
            .as_str()
            .unwrap()
            .contains("metadata exceeds limit"),
        "{first}"
    );
}
