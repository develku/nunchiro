//! Task dependencies, part 1: a task records the tasks it waits for (`nunchiro task new --after`, `nunchiro task
//! after`), the CLI says what each waits for, and every wrong order is refused with its sentence. Driven through the
//! real CLI against a real core, as the owner and as a session that is no lead.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}
fn output(home: &Path, id: &str) -> String {
    match call(
        home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    ) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        _ => String::new(),
    }
}

/// The owner's shell: `nunchiro task <args> --project <dir>`; (ok, stdout, stderr).
fn task(home: &Path, project: &Path, args: &[&str]) -> (bool, String, String) {
    let out = home::git_env::scrubbed(home::cli::path())
        .arg("task")
        .args(args)
        .arg("--project")
        .arg(project)
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn a_task_waits_for_others_and_a_wrong_order_is_refused() {
    let home = home::short("after");
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let proj = home.join("proj");
    let other = home.join("other");
    fs::create_dir_all(&proj).unwrap();
    fs::create_dir_all(&other).unwrap();
    let (proj, other) = (
        fs::canonicalize(proj).unwrap(),
        fs::canonicalize(other).unwrap(),
    );
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    let config = home.join("claude-home").to_string_lossy().into_owned();
    let serve = || {
        home::spawn_serve(
            &home,
            &[("PATH", path.as_str()), ("CLAUDE_CONFIG_DIR", &config)],
        )
    };
    let mut core = serve();
    let run = |args: &[&str]| task(&home, &proj, args);
    let ok = |args: &[&str]| {
        let (ok, out, err) = run(args);
        assert!(ok, "{args:?}: {err}");
        out
    };
    let refused = |args: &[&str], sentence: &str| {
        let (ok, out, err) = run(args);
        assert!(!ok && err.contains(sentence), "{args:?} -> {out}{err}");
    };

    // Red first: before this change `--after` is an unknown task option.
    ok(&["new", "a"]);
    let made = ok(&["new", "b", "--after", "t1"]);
    assert!(made.starts_with("t2 [idle] b\n"), "{made}");
    assert!(made.contains("  waits for t1 \"a\" (plan)\n"), "{made}");
    assert!(
        ok(&["show", "t1"]).contains("  1 task waits for this\n"),
        "the blocker says it"
    );
    // The first line of the list is the place's line, as before.
    let list = ok(&["list"]);
    assert!(list.starts_with("Way of working here: "), "{list}");
    let json: Value = serde_json::from_str(&ok(&["show", "t2", "--json"])).unwrap();
    assert_eq!(json["tasks"][0]["after"], json!(["t1"]), "{json}");

    refused(
        &["after", "t2", "t2"],
        "Refused: a task cannot wait for itself.",
    );
    refused(
        &["after", "t2", "t99"],
        "Refused: no open task t99 in this project.",
    );
    let (ok_other, _, err) = task(&home, &other, &["new", "x"]);
    assert!(ok_other, "{err}");
    refused(
        &["after", "t2", "t3"],
        "Refused: no open task t3 in this project.",
    );
    refused(
        &["after", "t1", "t2"],
        "Refused: \"a\" would wait for \"b\", which already waits for it.",
    );
    ok(&["new", "c", "--after", "t2"]);
    ok(&["new", "d", "--after", "t4"]);
    refused(
        &["after", "t1", "t5"],
        "Refused: \"a\" would wait for \"d\", which already waits for it.",
    );
    ok(&["new", "e"]);
    ok(&["drop", "t6"]);
    refused(
        &["after", "t2", "t6"],
        "Refused: \"e\" was dropped; a task cannot wait for it.",
    );
    refused(
        &["new", "f", "--after", "t6"],
        "Refused: \"e\" was dropped; a task cannot wait for it.",
    );
    let mut nine = vec!["after", "t2"];
    let ids: Vec<String> = (0..9)
        .map(|n| {
            let out = ok(&["new", &format!("n{n}")]);
            out.split(' ').next().unwrap().to_string()
        })
        .collect();
    nine.extend(ids.iter().map(String::as_str));
    refused(&nine, "Refused: a task waits for at most 8 tasks.");
    // Nothing refused was kept: b still waits for a alone.
    let b = ok(&["show", "t2"]);
    assert!(b.contains("  waits for t1 \"a\" (plan)\n") && !b.contains("waits for t6"), "{b}");
    // A bare `task after <id>` names nothing: refused, so nothing is cleared by a slip.
    let (bare, _, _) = run(&["after", "t2"]);
    assert!(!bare);

    // a lands (done): b no longer waits; a no longer has a waiting task.
    ok(&["done", "t1"]);
    let b = ok(&["show", "t2"]);
    assert!(!b.contains("waits for"), "{b}");
    // A core restart keeps the order.
    core.stop();
    let mut core = serve();
    assert!(
        ok(&["show", "t4"]).contains("  waits for t2 \"b\" (plan)\n"),
        "kept over a restart"
    );
    let cleared = ok(&["after", "t4", "--none"]);
    assert!(!cleared.contains("waits for"), "{cleared}");
    assert!(ok(&["show", "t4"]).contains("  order set by the user\n"));

    // A session that is no lead of the place is refused, as for `task new`.
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let started = raw(
        &home,
        owner.trim(),
        json!({"op":"start","session":{"account":null,"kind":"claude","project":proj,"worktree":false,"label":"outsider","args":[],"model":null,"effort":null,"resume":null}}),
    );
    let outsider = started["Ok"]["session"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    let mut token = String::new();
    wait("the outsider printed no token", || {
        output(&home, &outsider)
            .split("TOKEN=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .filter(|t| !t.is_empty())
            .map(|t| token = t.to_string())
            .is_some()
    });
    let no = raw(
        &home,
        &token,
        json!({"op":"task","operation":"after","id":"t5","after":["t4"]}),
    );
    assert!(
        no["Err"]
            .as_str()
            .is_some_and(|e| e.contains("only the lead of a place or the user")),
        "{no}"
    );
    let no = raw(
        &home,
        &token,
        json!({"op":"task","operation":"new","text":"g","after":["t4"]}),
    );
    assert!(no["Err"].is_string(), "{no}");
    raw(&home, owner.trim(), json!({"op":"close","id":outsider}));
    core.stop();
    let _ = fs::remove_dir_all(&home);
}
