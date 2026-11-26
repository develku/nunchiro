//! Approval states, content hash and the proof only the approval module can produce (ticket v1b-14).
#[path = "fixtures/cli.rs"]
mod cli;
#[path = "fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::approval::{self, Level, State};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A fresh NUNCHIRO_HOME under the repo's `.scratch/` holding a copy of the fixture widget.
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch");
        fs::create_dir_all(&root).unwrap();
        let home = root.canonicalize().unwrap().join(format!(
            "ap-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        fs::create_dir_all(home.join("widgets")).unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/approval/open-prs");
        let dest = home.join("widgets/open-prs");
        fs::create_dir(&dest).unwrap();
        for entry in fs::read_dir(fixture).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), dest.join(entry.file_name())).unwrap();
        }
        Self(home)
    }
    fn widget(&self) -> PathBuf {
        self.0.join("widgets/open-prs")
    }
    fn hash(&self) -> String {
        approval::status(&self.0, "open-prs").unwrap().hash
    }
    fn store(&self) -> PathBuf {
        self.0.join("approvals.json")
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn unapproved_until_granted() {
    let h = Home::new();
    let view = approval::status(&h.0, "open-prs").unwrap();
    assert_eq!(view.state, State::Unapproved);
    assert_eq!(view.level, None);
    assert!(approval::check(&h.0, "open-prs").is_err());
    assert!(!h.store().exists(), "looking never writes");
}

#[test]
fn approved_after_grant_and_proof_carries_the_exact_argv() {
    let h = Home::new();
    let view = approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    assert_eq!(
        (view.state, view.level),
        (State::Approved, Some(Level::Read))
    );
    let proof = approval::check(&h.0, "open-prs").unwrap();
    assert_eq!(proof.level(), Level::Read);
    assert_eq!(proof.argv(), ["sh", "open-prs.sh", "--state", "open"]);
    assert_eq!(proof.interval_secs(), Some(60));
    assert_eq!(proof.network(), ["api.github.com", "github.com"]);
    assert_eq!(proof.hash(), view.hash);
    assert_eq!(
        fs::metadata(h.store()).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn any_change_flips_to_changed_and_no_proof() {
    type Edit = fn(&Path);
    let edits: [(&str, Edit); 7] = [
        ("command file edited", |w| {
            fs::write(w.join("open-prs.sh"), "#!/bin/sh\necho '[1]'\n").unwrap()
        }),
        ("manifest edited", |w| {
            let m = fs::read_to_string(w.join("widget.toml")).unwrap();
            fs::write(w.join("widget.toml"), m.replace("60", "30")).unwrap();
        }),
        ("file added", |w| {
            fs::write(w.join("extra.txt"), "x").unwrap()
        }),
        ("file deleted", |w| {
            fs::remove_file(w.join("open-prs.sh")).unwrap()
        }),
        ("file renamed", |w| {
            fs::rename(w.join("open-prs.sh"), w.join("renamed.sh")).unwrap()
        }),
        ("exec bit dropped", |w| {
            fs::set_permissions(w.join("open-prs.sh"), fs::Permissions::from_mode(0o644)).unwrap()
        }),
        ("nested file added", |w| {
            fs::create_dir(w.join("lib")).unwrap();
            fs::write(w.join("lib/helper.sh"), "x").unwrap();
        }),
    ];
    for (name, edit) in edits {
        let h = Home::new();
        approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
        edit(&h.widget());
        // A deleted command leaves a valid manifest; every edit above must still ask again.
        let view = approval::status(&h.0, "open-prs").unwrap();
        assert_eq!(view.state, State::Changed, "{name}");
        assert!(approval::check(&h.0, "open-prs").is_err(), "{name}");
    }
}

#[test]
fn cache_folder_is_outside_the_hash_and_regrant_restores() {
    let h = Home::new();
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    fs::create_dir(h.widget().join("cache")).unwrap();
    fs::write(h.widget().join("cache/out.json"), "[]").unwrap();
    assert_eq!(
        approval::status(&h.0, "open-prs").unwrap().state,
        State::Approved
    );
    fs::write(h.widget().join("open-prs.sh"), "changed").unwrap();
    assert_eq!(
        approval::status(&h.0, "open-prs").unwrap().state,
        State::Changed
    );
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    assert!(approval::check(&h.0, "open-prs").is_ok());
}

#[test]
fn hash_matches_an_independent_computation() {
    // Computed by hand with python hashlib from the rule in the crate README, not by this crate.
    let h = Home::new();
    assert_eq!(
        h.hash(),
        include_str!("fixtures/approval/open-prs.sha256").trim()
    );
}

#[test]
fn grant_refuses_a_hash_the_user_did_not_see() {
    let h = Home::new();
    let seen = h.hash();
    fs::write(
        h.widget().join("open-prs.sh"),
        "swapped after the sheet opened",
    )
    .unwrap();
    let err = approval::grant(&h.0, "open-prs", Level::Read, &seen).unwrap_err();
    assert!(err.contains("changed"), "{err}");
    assert!(!h.store().exists());
}

#[test]
fn act_needs_the_manifest_to_declare_it() {
    let h = Home::new();
    let m = fs::read_to_string(h.widget().join("widget.toml")).unwrap();
    fs::write(
        h.widget().join("widget.toml"),
        m.replace(r#"["read", "act"]"#, r#"["read"]"#),
    )
    .unwrap();
    let err = approval::grant(&h.0, "open-prs", Level::Act, &h.hash()).unwrap_err();
    assert!(err.contains("act"), "{err}");
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
}

#[test]
fn act_grant_is_kept_and_read_regrant_downgrades() {
    let h = Home::new();
    approval::grant(&h.0, "open-prs", Level::Act, &h.hash()).unwrap();
    assert_eq!(
        approval::check(&h.0, "open-prs").unwrap().level(),
        Level::Act
    );
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    assert_eq!(
        approval::check(&h.0, "open-prs").unwrap().level(),
        Level::Read
    );
}

#[test]
fn nothing_is_spawned_by_any_approval_path() {
    let h = Home::new();
    let marker = h.0.join("marker");
    // The fixture command touches this path if it ever runs; the module has no way to run it.
    unsafe { std::env::set_var("NUNCHIRO_FIXTURE_MARKER", &marker) };
    let _ = approval::check(&h.0, "open-prs");
    approval::grant(&h.0, "open-prs", Level::Act, &h.hash()).unwrap();
    approval::check(&h.0, "open-prs").unwrap();
    fs::write(
        h.widget().join("open-prs.sh"),
        "touch \"$NUNCHIRO_FIXTURE_MARKER\"",
    )
    .unwrap();
    assert!(approval::check(&h.0, "open-prs").is_err());
    assert!(!marker.exists());
}

#[test]
fn view_shows_manifest_fields_and_equivalent_cli_line() {
    let h = Home::new();
    let v = approval::status(&h.0, "open-prs").unwrap();
    assert_eq!(v.manifest.author, "owner");
    assert_eq!(v.manifest.kind, "script");
    assert_eq!(v.manifest.command, ["sh", "open-prs.sh", "--state", "open"]);
    assert_eq!(v.manifest.interval_secs, Some(60));
    assert_eq!(v.manifest.permissions, [Level::Read, Level::Act]);
    assert_eq!(v.manifest.network, ["api.github.com", "github.com"]);
    assert_eq!(v.cli, "nunchiro widget allow open-prs --read");
    assert!(v.manifest_text.contains("open-prs.sh"));
}

#[test]
fn missing_author_reads_unknown() {
    let h = Home::new();
    let m = fs::read_to_string(h.widget().join("widget.toml")).unwrap();
    fs::write(
        h.widget().join("widget.toml"),
        m.replace("author = \"owner\"\n", ""),
    )
    .unwrap();
    assert_eq!(
        approval::status(&h.0, "open-prs").unwrap().manifest.author,
        "unknown"
    );
}

#[test]
fn manifest_is_refused_when_not_version_1_or_not_exact() {
    let cases = [
        ("version 2", "version = 1", "version = 2"),
        ("no version", "version = 1\n", ""),
        (
            "unknown field",
            "interval = 60",
            "interval = 60\nenv = [\"A=1\"]",
        ),
        ("unknown kind", "kind = \"script\"", "kind = \"daemon\""),
        (
            "empty argv",
            "command = [\"sh\", \"open-prs.sh\", \"--state\", \"open\"]",
            "command = []",
        ),
        (
            "command and entry",
            "interval = 60",
            "interval = 60\nentry = \"index.html\"",
        ),
        ("zero interval", "interval = 60", "interval = 0"),
        ("bad host", "\"github.com\"", "\"git hub.com/x\""),
        (
            "bad permission",
            "[\"read\", \"act\"]",
            "[\"read\", \"root\"]",
        ),
    ];
    for (name, from, to) in cases {
        let h = Home::new();
        let m = fs::read_to_string(h.widget().join("widget.toml")).unwrap();
        assert!(m.contains(from), "{name}");
        fs::write(h.widget().join("widget.toml"), m.replace(from, to)).unwrap();
        assert!(approval::status(&h.0, "open-prs").is_err(), "{name}");
        assert!(approval::check(&h.0, "open-prs").is_err(), "{name}");
    }
}

#[test]
fn bad_names_and_symlinks_are_refused() {
    let h = Home::new();
    for name in ["", "..", "../open-prs", "a/b", "Open", ".hidden"] {
        assert!(approval::status(&h.0, name).is_err(), "{name:?}");
    }
    std::os::unix::fs::symlink("/etc/hosts", h.widget().join("link")).unwrap();
    assert!(
        approval::status(&h.0, "open-prs")
            .unwrap_err()
            .contains("symlink")
    );
}

#[test]
fn web_widget_needs_an_entry_inside_its_folder() {
    let h = Home::new();
    let web = |entry: &str| format!("version = 1\nkind = \"web\"\nentry = \"{entry}\"\n");
    fs::write(h.widget().join("widget.toml"), web("index.html")).unwrap();
    let v = approval::status(&h.0, "open-prs").unwrap();
    assert_eq!(
        (v.manifest.kind.as_str(), v.manifest.entry.as_str()),
        ("web", "index.html")
    );
    assert_eq!(v.manifest.permissions, [Level::Read]);
    for bad in ["../x.html", "/abs.html", ""] {
        fs::write(h.widget().join("widget.toml"), web(bad)).unwrap();
        assert!(approval::status(&h.0, "open-prs").is_err(), "{bad:?}");
    }
}

#[test]
fn broken_store_is_refused_and_left_untouched() {
    let hash = "0".repeat(64);
    let good = format!(
        r#"{{"version":1,"approvals":[{{"name":"open-prs","level":"read","hash":"{hash}","granted_at_ms":1}}]}}"#
    );
    let cases = [
        ("not json", "nope".to_string()),
        ("not an object", "[]".to_string()),
        (
            "newer version",
            good.replace("\"version\":1", "\"version\":2"),
        ),
        ("wrong field type", good.replace("\"read\"", "7")),
        ("unknown level", good.replace("\"read\"", "\"root\"")),
        ("bad hash", good.replace(&hash, "xyz")),
        ("bad name", good.replace("\"open-prs\"", "\"../x\"")),
        (
            "duplicate name",
            good.replace(
                "]}",
                &format!(
                    ",{}]}}",
                    &good[good.find("{\"name").unwrap()..good.rfind("]}").unwrap()]
                ),
            ),
        ),
    ];
    for (name, body) in cases {
        let h = Home::new();
        fs::write(h.store(), &body).unwrap();
        assert!(approval::status(&h.0, "open-prs").is_err(), "{name}");
        assert!(approval::check(&h.0, "open-prs").is_err(), "{name}");
        assert!(
            approval::grant(&h.0, "open-prs", Level::Read, &h.hash_unchecked()).is_err(),
            "{name}"
        );
        assert_eq!(
            fs::read_to_string(h.store()).unwrap(),
            body,
            "{name}: store left unchanged"
        );
    }
}
impl Home {
    /// The hash without going through `status`, which refuses a broken store.
    fn hash_unchecked(&self) -> String {
        "0".repeat(64)
    }
}

#[test]
fn additive_unknown_store_fields_survive_a_grant() {
    let h = Home::new();
    fs::write(
        h.store(),
        r#"{"version":1,"approvals":[],"future":{"kept":true}}"#,
    )
    .unwrap();
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&fs::read(h.store()).unwrap()).unwrap();
    assert_eq!(v["future"]["kept"], true);
}

#[test]
fn a_manifest_swapped_during_check_never_yields_a_mismatched_proof() {
    // Regression for the hash/manifest TOCTOU: widget.toml is renamed between good and evil content while
    // `check` runs. Every Proof must carry the argv of the approved content, and every view the manifest
    // text that matches its state.
    let h = Home::new();
    let toml = h.widget().join("widget.toml");
    let good = fs::read_to_string(&toml).unwrap();
    let evil = good.replace(
        r#"["sh", "open-prs.sh", "--state", "open"]"#,
        r#"["rm", "-rf", "/x"]"#,
    );
    assert_ne!(good, evil);
    approval::grant(&h.0, "open-prs", Level::Read, &h.hash()).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let swapper = {
        let (stop, toml, tmp) = (stop.clone(), toml.clone(), h.0.join("swap.tmp"));
        std::thread::spawn(move || {
            let mut i = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                fs::write(&tmp, if i.is_multiple_of(2) { &evil } else { &good }).unwrap();
                fs::rename(&tmp, &toml).unwrap();
                i += 1;
            }
        })
    };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let (mut proofs, mut mismatched) = (0, 0);
    while std::time::Instant::now() < until {
        if let Ok(p) = approval::check(&h.0, "open-prs") {
            proofs += 1;
            mismatched += (p.argv()[0] != "sh") as u32;
        }
        if let Ok(v) = approval::status(&h.0, "open-prs") {
            let shown_evil = v.manifest_text.contains("\"rm\"");
            assert_eq!(
                shown_evil,
                v.manifest.command[0] == "rm",
                "text and parsed manifest differ"
            );
            assert!(
                !(v.state == approval::State::Approved && shown_evil),
                "approved state with unapproved manifest"
            );
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    swapper.join().unwrap();
    assert!(proofs > 0, "probe never saw an approved state");
    assert_eq!(mismatched, 0);
}

#[test]
fn control_and_bidi_characters_are_refused_in_command_and_author() {
    let hostile = [
        "\\u001b[2K",
        "\\u0085",
        "\\u007f",
        "a\\u202eb",
        "\\u2066x",
        "\\u200f",
        "tab\\there",
    ];
    for bad in hostile {
        for (field, from, to) in [
            ("arg", "\"--state\"", format!("\"{bad}\"")),
            ("program", "\"sh\"", format!("\"{bad}\"")),
            ("author", "\"owner\"", format!("\"{bad}\"")),
        ] {
            let h = Home::new();
            let m = fs::read_to_string(h.widget().join("widget.toml")).unwrap();
            assert!(m.contains(from), "{field}");
            fs::write(h.widget().join("widget.toml"), m.replacen(from, &to, 1)).unwrap();
            assert!(approval::status(&h.0, "open-prs").is_err(), "{field} {bad}");
        }
    }
    // Ordinary non-ASCII text is fine.
    let h = Home::new();
    let m = fs::read_to_string(h.widget().join("widget.toml")).unwrap();
    fs::write(
        h.widget().join("widget.toml"),
        m.replace("\"owner\"", "\"눈치로 ✓\""),
    )
    .unwrap();
    assert_eq!(
        approval::status(&h.0, "open-prs").unwrap().manifest.author,
        "눈치로 ✓"
    );
}

// Ticket 358 (327): Claude's and Codex's own command, under its own approval subject.
mod agent_command {
    use super::*;
    use nunchiro_core::api::AgentKind::{self, Claude, Codex};
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        time::{Duration, Instant},
    };

    /// A fake CLI under the home: answers `--version`, logs its environment, folder and arguments to `<path>.log`.
    fn cli(home: &Path, name: &str, body: &str) -> String {
        let path = home.join(name);
        let log = format!("{}.log", path.display());
        // Ticket 1150: the core's question before a Codex start (`fixtures/home.rs` `codex_fake`, which this file
        // does not load) is answered before the log line, so the log still holds the session's own run.
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/codex-app-server"
        );
        let script = format!(
            "#!/bin/sh\n[ \"$1\" != app-server ] || exec '{fixture}'\n{{ pwd; echo \"args=$*\"; /usr/bin/env; }} > '{log}'\n{body}\n"
        );
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path.display().to_string()
    }
    /// Ticket 474: checks run one at a time (`CHECKING`), so the slow ones take turns here and each times only itself.
    fn slow() -> std::sync::MutexGuard<'static, ()> {
        static SLOW: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SLOW.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// macOS checks a new executable at its first run (syspolicyd, XProtect); on a busy gate machine that check queued
    /// for 5 s, the whole bound of the core's confined `--version`. A real install has run before, so a fake that
    /// answers `--version` runs once here, outside any bound. Its log line is replaced by the next run.
    fn ran_once(path: String) -> String {
        let ran = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .unwrap();
        assert!(ran.status.success(), "{ran:?}");
        path
    }
    fn good(home: &Path, name: &str) -> String {
        ran_once(cli(home, name, "echo 'fake 1.0.0'"))
    }
    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    fn check(home: &Path, kind: AgentKind, path: &str, args: &[&str]) -> approval::CommandCheck {
        approval::command_check(home, kind, path.into(), words(args), vec![]).unwrap()
    }
    fn approve(home: &Path, kind: AgentKind, path: &str, args: &[&str]) {
        let hash = check(home, kind, path, args).hash.expect("check passes");
        approval::command_grant(home, kind, &hash).unwrap();
    }
    fn file(home: &Path, name: &str) -> PathBuf {
        home.join("agent-commands").join(format!("{name}.json"))
    }

    #[test]
    fn no_override_means_the_path_command() {
        let home = Home::new();
        assert!(
            approval::command_status(&home.0, Claude)
                .unwrap()
                .state
                .is_none()
        );
        assert!(approval::check_command(&home.0, Claude).unwrap().is_none());
    }

    #[test]
    fn a_change_needs_approval_and_the_approved_command_stays_in_use() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        approve(&home.0, Claude, &path, &["--one"]);
        let hash = check(&home.0, Claude, &path, &["--two"]).hash.unwrap();

        let view = approval::command_status(&home.0, Claude).unwrap();
        assert_eq!(view.state, Some(State::Approved));
        assert_eq!(
            view.pending.unwrap().args,
            ["--two"],
            "the row says it waits"
        );
        let proof = approval::check_command(&home.0, Claude).unwrap().unwrap();
        assert_eq!(
            proof.args(),
            ["--one"],
            "new sessions keep the approved one"
        );

        approval::command_grant(&home.0, Claude, &hash).unwrap();
        let proof = approval::check_command(&home.0, Claude).unwrap().unwrap();
        assert_eq!(
            (proof.path(), proof.args()),
            (path.as_str(), &["--two".to_string()][..])
        );
        assert!(
            approval::command_status(&home.0, Claude)
                .unwrap()
                .pending
                .is_none()
        );
    }

    // Q9 tt-J11-1: a grant the store cannot save leaves the approved command in use, not a refused start.
    #[test]
    fn a_grant_that_cannot_be_saved_keeps_the_approved_command() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        approve(&home.0, Claude, &path, &["--one"]);
        let hash = check(&home.0, Claude, &path, &["--two"]).hash.unwrap();
        // approvals.json is written in the home itself; the command file in its own, still writable, folder.
        fs::set_permissions(&home.0, fs::Permissions::from_mode(0o555)).unwrap();
        let granted = approval::command_grant(&home.0, Claude, &hash);
        fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(granted.is_err());

        let proof = approval::check_command(&home.0, Claude).unwrap().unwrap();
        assert_eq!(proof.args(), ["--one"], "the old grant still runs");
        let view = approval::command_status(&home.0, Claude).unwrap();
        assert_eq!(view.state, Some(State::Approved));
        assert_eq!(view.pending.unwrap().args, ["--two"], "held for a retry");
        approval::command_grant(&home.0, Claude, &hash).unwrap();
    }

    #[test]
    fn a_grant_needs_a_passing_check_of_exactly_what_was_shown() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        assert!(
            approval::command_grant(&home.0, Claude, &"0".repeat(64)).is_err(),
            "no check"
        );

        let shown = check(&home.0, Claude, &path, &["--shown"]).hash.unwrap();
        check(&home.0, Claude, &path, &["--other"]);
        assert!(
            approval::command_grant(&home.0, Claude, &shown).is_err(),
            "something else is held now"
        );

        let broken = cli(&home.0, "broken", "exit 3");
        let failed = check(&home.0, Codex, &broken, &[]);
        assert!(failed.hash.is_none() && failed.error.is_some());
        assert!(
            approval::command_status(&home.0, Codex)
                .unwrap()
                .pending
                .is_none()
        );
    }

    #[test]
    fn the_core_refuses_what_it_must_not_run_or_store() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        let refused = |path: &str, args: Vec<String>, env: Vec<String>| {
            approval::command_check(&home.0, Claude, path.into(), args, env)
                .unwrap()
                .error
                .is_some()
        };
        assert!(refused("claude", vec![], vec![]), "not absolute");
        assert!(
            refused(&format!("{path}-none"), vec![], vec![]),
            "not there"
        );
        assert!(
            refused(&path, vec!["a\nb".into()], vec![]),
            "control character"
        );
        assert!(
            refused(&path, vec![], vec!["sk-ant-secret".into()]),
            "a value in the name field"
        );
        assert!(
            approval::command_check(&home.0, AgentKind::Shell, path.clone(), vec![], vec![])
                .is_err()
        );
        assert!(!file(&home.0, "claude").exists(), "nothing was held");
    }

    #[test]
    fn the_check_is_confined_and_runs_only_version() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        // The saved env name passes no value to a binary nobody has approved yet.
        let out = approval::command_check(
            &home.0,
            Claude,
            path.clone(),
            words(&["--danger"]),
            words(&["CARGO_PKG_NAME"]),
        )
        .unwrap();
        assert_eq!(out.version.as_deref(), Some("fake 1.0.0"));
        assert!(out.env_set["CARGO_PKG_NAME"]);
        let log = fs::read_to_string(format!("{path}.log")).unwrap();
        assert!(log.contains("args=--version\n"), "{log}");
        assert!(
            !log.contains("--danger") && !log.contains("CARGO_PKG_NAME"),
            "{log}"
        );
        let folder = log.lines().next().unwrap();
        assert!(folder.contains("command-check"), "{log}");
        assert!(!Path::new(folder).exists(), "the empty folder is removed");
    }

    #[test]
    fn a_check_that_hangs_is_stopped() {
        let _slow = slow();
        let home = Home::new();
        let path = cli(&home.0, "hang", "exec /bin/sleep 60");
        let began = std::time::Instant::now();
        let out = check(&home.0, Claude, &path, &[]);
        assert!(out.hash.is_none() && out.error.is_some());
        assert!(began.elapsed() < std::time::Duration::from_secs(10));
    }

    // Ticket 474: a just-installed binary whose first run takes longer than the 5 s a known one gets passes its check.
    #[test]
    fn a_new_binary_slow_on_its_first_run_passes_its_first_check() {
        let _slow = slow();
        let home = Home::new();
        let cold = home.0.join("cold");
        let body = format!(
            "if [ -e '{0}' ]; then rm -f '{0}'; sleep 5.5; fi\necho 'fake 1.0.0'",
            cold.display()
        );
        // The OS's own first-run check happens here, outside the bound; only then is the next run made slow.
        let path = ran_once(cli(&home.0, "claude", &body));
        fs::write(&cold, "").unwrap();
        let out = check(&home.0, Claude, &path, &[]);
        assert_eq!(
            out.version.as_deref(),
            Some("fake 1.0.0"),
            "{:?}",
            out.error
        );
        assert!(out.hash.is_some() && !cold.exists());
    }

    // Ticket 474: the longer limit is one first run's; a second check of the same hanging binary gets the 5 s again.
    #[test]
    fn a_hang_gets_the_longer_limit_once() {
        let _slow = slow();
        let home = Home::new();
        let path = cli(&home.0, "hang", "exec /bin/sleep 60");
        let began = std::time::Instant::now();
        assert!(check(&home.0, Claude, &path, &[]).hash.is_none());
        assert!(began.elapsed() < std::time::Duration::from_secs(10));
        let again = std::time::Instant::now();
        let out = check(&home.0, Claude, &path, &[]);
        assert!(out.hash.is_none() && out.error.is_some());
        assert!(
            again.elapsed() < std::time::Duration::from_secs(7),
            "{:?}",
            again.elapsed()
        );
    }

    #[test]
    fn a_tampered_command_is_refused_until_it_is_approved_again() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        approve(&home.0, Claude, &path, &["--verbose"]);
        let stored = fs::read_to_string(file(&home.0, "claude")).unwrap();
        fs::write(
            file(&home.0, "claude"),
            stored.replace("--verbose", "--evil"),
        )
        .unwrap();

        let view = approval::command_status(&home.0, Claude).unwrap();
        assert_eq!(view.state, Some(State::Changed));
        let refused = approval::check_command(&home.0, Claude).unwrap_err();
        assert!(refused.contains("changed since"), "{refused}");

        approve(&home.0, Claude, &path, &["--verbose"]);
        assert!(approval::check_command(&home.0, Claude).unwrap().is_some());
    }

    #[test]
    fn a_removed_damaged_or_handmade_file_never_falls_through() {
        let home = Home::new();
        let path = good(&home.0, "codex");
        approve(&home.0, Codex, &path, &[]);
        let stored = fs::read_to_string(file(&home.0, "codex")).unwrap();

        fs::remove_file(file(&home.0, "codex")).unwrap();
        assert!(
            approval::check_command(&home.0, Codex).is_err(),
            "granted but gone"
        );
        fs::write(file(&home.0, "codex"), "{ not json").unwrap();
        assert!(approval::check_command(&home.0, Codex).is_err(), "damaged");
        assert_eq!(
            approval::command_status(&home.0, Codex).unwrap().state,
            Some(State::Changed)
        );

        // Written by hand, never granted: the other agent's file copied over with no approval behind it.
        fs::create_dir_all(home.0.join("agent-commands")).unwrap();
        fs::write(file(&home.0, "claude"), stored.replace("codex", "claude")).unwrap();
        assert!(approval::check_command(&home.0, Claude).is_err());
        assert_eq!(
            approval::command_status(&home.0, Claude).unwrap().state,
            Some(State::Unapproved)
        );
    }

    #[test]
    fn a_damaged_approvals_store_only_blocks_an_agent_with_a_command() {
        let home = Home::new();
        fs::write(home.store(), "{ not json").unwrap();
        assert!(
            approval::check_command(&home.0, Claude).unwrap().is_none(),
            "no override, no refusal"
        );
        fs::create_dir_all(home.0.join("agent-commands")).unwrap();
        fs::write(file(&home.0, "claude"), r#"{"version":1}"#).unwrap();
        assert!(approval::check_command(&home.0, Claude).is_err());
    }

    #[test]
    fn reset_recovers_from_a_damaged_approvals_store() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        approve(&home.0, Claude, &path, &[]);
        fs::write(home.store(), "{ not json").unwrap();
        assert!(approval::check_command(&home.0, Claude).is_err());

        approval::command_reset(&home.0, Claude, false).unwrap();
        assert!(approval::check_command(&home.0, Claude).unwrap().is_none());
    }

    #[test]
    fn reset_returns_to_the_path_command_and_a_draft_reset_keeps_the_approval() {
        let home = Home::new();
        let path = good(&home.0, "claude");
        approve(&home.0, Claude, &path, &["--one"]);
        check(&home.0, Claude, &path, &["--two"]);

        approval::command_reset(&home.0, Claude, true).unwrap();
        let view = approval::command_status(&home.0, Claude).unwrap();
        assert!(view.pending.is_none() && view.state == Some(State::Approved));

        approval::command_reset(&home.0, Claude, false).unwrap();
        assert!(approval::check_command(&home.0, Claude).unwrap().is_none());
        fs::write(home.0.join("agent-commands/claude.json"), "broken").unwrap();
        approval::command_reset(&home.0, Claude, false).unwrap();
        assert!(
            approval::command_status(&home.0, Claude)
                .unwrap()
                .state
                .is_none(),
            "reset repairs a damaged file"
        );
    }

    /// A real `serve` with its own HOME and agent folders, so no machine config changes what a launch does.
    struct Serve {
        home: PathBuf,
        process: std::process::Child,
    }
    impl Serve {
        fn new(tag: &str) -> Self {
            use std::process::Stdio;
            let home = std::env::temp_dir().join(format!("ns-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&home);
            fs::create_dir_all(home.join("bin")).unwrap();
            let home = home.canonicalize().unwrap();
            let process = git_env::scrubbed(cli::path())
                .arg("serve")
                .env("NUNCHIRO_HOME", &home)
                .env("HOME", &home)
                .env("CODEX_HOME", home.join("codex-home"))
                .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", home.join("bin").display()),
                )
                .env_remove("NUNCHIRO_TOKEN")
                .env_remove("NUNCHIRO_WINDOW_ORIGINS")
                .env("NUNCHIRO_SSH", "/usr/bin/false")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let serve = Self { home, process };
            wait("core ready", || {
                serve.owner(json!({"op":"snapshot"}))["Ok"]["type"] == "snapshot"
            });
            serve
        }
        fn send(&self, token: &str, request: Value) -> Value {
            let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
                return Value::Null;
            };
            s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let line = json!({"token":token,"request":request}).to_string() + "\n";
            s.write_all(line.as_bytes()).unwrap();
            let mut reply = String::new();
            let _ = BufReader::new(s).read_line(&mut reply);
            serde_json::from_str(&reply).unwrap_or(Value::Null)
        }
        fn owner(&self, request: Value) -> Value {
            let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
            self.send(&token, request)
        }
        fn approve(&self, agent: &str, path: &str, args: &[&str]) {
            let check = self.owner(
                json!({"op":"agent_command_check","agent":agent,"path":path,"args":args,"env":[]}),
            );
            let hash = check["Ok"]["check"]["hash"]
                .as_str()
                .unwrap_or_else(|| panic!("{check}"));
            let granted = self.owner(json!({"op":"agent_command_grant","agent":agent,"hash":hash}));
            assert_eq!(granted["Ok"]["view"]["state"], "approved", "{granted}");
        }
        fn start(&self, kind: &str) -> Value {
            self.owner(json!({"op":"start","session":{"kind":kind,"project":self.home,"label":kind,"args":[]}}))
        }
    }
    impl Drop for Serve {
        fn drop(&mut self) {
            let _ = self.owner(json!({"op":"stop"}));
            let _ = self.process.wait();
            let _ = fs::remove_dir_all(&self.home);
        }
    }
    fn wait(what: &str, done: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < until, "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// A fake agent that answers `--version` and otherwise stays up; its last run's arguments are in `<path>.log`.
    fn agent(dir: &Path, name: &str) -> String {
        ran_once(cli(
            dir,
            name,
            "[ \"$1\" = --version ] && { echo 'fake 1.0.0'; exit 0; }\nexec /bin/cat >/dev/null",
        ))
    }
    /// The arguments of the agent's session run (not its `--version` probe).
    fn session_args(path: &str) -> String {
        let log = format!("{path}.log");
        wait(&format!("{path} never ran a session"), || {
            fs::read_to_string(&log).is_ok_and(|t| {
                t.lines()
                    .any(|l| l.starts_with("args=") && l != "args=--version")
            })
        });
        let text = fs::read_to_string(&log).unwrap();
        text.lines()
            .find(|l| l.starts_with("args="))
            .unwrap()
            .to_string()
    }

    /// Only the owner reaches these ops, and the ACP add still refuses a Claude entry (threat 3).
    #[test]
    fn only_the_owner_reaches_the_command_ops() {
        let s = Serve::new("cmdown");
        let script = s.home.join("token.sh");
        fs::write(
            &script,
            // The shell's redirect makes the file before printf writes it; the pause stands in for a busy host.
            ": > \"$NUNCHIRO_HOME/session.token\"\nsleep 0.3\nprintf %s \"$NUNCHIRO_TOKEN\" >> \"$NUNCHIRO_HOME/session.token\"\nexec sleep 60\n",
        )
        .unwrap();
        let started = s.owner(json!({"op":"start","session":{"kind":"shell","project":s.home,"label":"s","args":["/bin/sh",script]}}));
        assert_eq!(started["Ok"]["type"], "started", "{started}");
        wait("session token", || s.home.join("session.token").exists());
        let session = fs::read_to_string(s.home.join("session.token")).unwrap();
        for request in [
            json!({"op":"agent_command_status","agent":"claude"}),
            json!({"op":"agent_command_check","agent":"claude","path":"/bin/echo","args":[],"env":[]}),
            json!({"op":"agent_command_grant","agent":"claude","hash":"0".repeat(64)}),
            json!({"op":"agent_command_reset","agent":"claude"}),
        ] {
            assert_eq!(
                s.send(&session, request.clone()),
                json!({"Err":"operation not granted"}),
                "session {request}"
            );
            assert_eq!(
                s.owner(json!({"op":"remote","machine":"elsewhere","request":request})),
                json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
                "remote {request}"
            );
        }
        assert!(
            !s.home.join("agent-commands").exists(),
            "no refused call wrote anything"
        );

        // Threat 3: the new subject approves a Claude command, and the ACP door stays shut for one.
        let fake = good(&s.home, "claude");
        s.approve("claude", &fake, &[]);
        let acp = s.owner(json!({"op":"acp_agent_add","entry":{"name":"claude","command":fake,"args":[],"env":[]}}));
        assert!(acp["Err"].is_string(), "{acp}");
    }

    #[test]
    fn a_start_outside_the_app_gets_the_approved_path_but_not_its_arguments() {
        let s = Serve::new("cmdrun");
        let on_path = agent(&s.home.join("bin"), "claude");
        let approved = agent(&s.home, "my-claude");
        s.approve("claude", &approved, &["--verbose"]);

        let started = s.start("claude");
        assert_eq!(started["Ok"]["type"], "started", "{started}");
        let args = session_args(&approved);
        assert!(
            args.contains("--session-id") && !args.contains("--verbose"),
            "{args}"
        );
        assert!(
            !fs::read_to_string(format!("{on_path}.log")).is_ok_and(|t| t.contains("--session-id"))
        );

        let reset = s.owner(json!({"op":"agent_command_reset","agent":"claude"}));
        assert!(reset["Ok"]["view"]["state"].is_null(), "{reset}");
        let started = s.start("claude");
        assert_eq!(started["Ok"]["type"], "started", "{started}");
        let args = session_args(&on_path);
        assert!(
            args.contains("--session-id") && !args.contains("--verbose"),
            "{args}"
        );
    }

    #[test]
    fn a_tampered_command_refuses_the_start_and_says_why() {
        let s = Serve::new("cmdbad");
        let approved = agent(&s.home, "my-claude");
        s.approve("claude", &approved, &["--verbose"]);
        let stored = file(&s.home, "claude");
        let text = fs::read_to_string(&stored).unwrap();
        fs::write(&stored, text.replace("--verbose", "--evil")).unwrap();

        let refused = s.start("claude");
        assert!(
            refused["Err"]
                .as_str()
                .is_some_and(|e| e.contains("changed since")),
            "{refused}"
        );
        let view = s.owner(json!({"op":"agent_command_status","agent":"claude"}));
        assert_eq!(view["Ok"]["view"]["state"], "changed", "{view}");
        assert!(
            !fs::read_to_string(format!("{approved}.log"))
                .unwrap()
                .contains("--evil")
        );
    }

    /// Threat 4, the half a socket start can show: arguments it does not get cannot cost it the hooks. The window's half
    /// (arguments on, hooks off) is in `web/tests/accounts-command.spec.ts`.
    #[test]
    fn a_codex_start_outside_the_app_keeps_its_hooks() {
        let s = Serve::new("cmdhook");
        let codex = agent(&s.home, "my-codex");
        s.approve("codex", &codex, &["--verbose"]);
        assert_eq!(s.start("codex")["Ok"]["type"], "started");
        let args = session_args(&codex);
        assert!(
            args.contains("hooks.") && !args.contains("--verbose"),
            "{args}"
        );
    }
}
