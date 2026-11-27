// Plugins end to end: `plugin new` makes a plugin `plugin check` passes, and the example plugin in docs/api/examples
// runs nothing until it is on and approved, then shows its panel and runs its command; a change stops it again, and
// no session or token may list, run or turn on a plugin.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Output,
};

const EXAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/api/examples/plugins/quiet-hours"
);

fn user(home: &Path) -> PathBuf {
    let u = home.join("user");
    std::fs::create_dir_all(&u).unwrap();
    u
}
fn nunchiro(home: &Path, args: &[&str]) -> Output {
    home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(args)
        .env("NUNCHIRO_HOME", home)
        .env("HOME", user(home))
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap()
}
fn ok(home: &Path, args: &[&str]) -> String {
    let out = nunchiro(home, args);
    assert!(
        out.status.success(),
        "{args:?}: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn refused(home: &Path, args: &[&str]) -> String {
    let out = nunchiro(home, args);
    assert!(!out.status.success(), "{args:?} was not refused");
    String::from_utf8(out.stderr).unwrap()
}
fn call(home: &Path, token: &str, request: Value) -> Value {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}
fn copy(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

#[test]
fn a_new_plugin_passes_its_check() {
    let home = home::short("pln");
    ok(
        &home,
        &["plugin", "new", "quiet", "--with", "panel,command,setting"],
    );
    let out = ok(&home, &["plugin", "check", "quiet"]);
    assert!(
        out.contains("ok\tmain") && out.contains("ok\thello\tHello from a plugin command."),
        "{out}"
    );
    // A part that fails makes the check fail.
    std::fs::write(home.join("plugins/quiet/command.sh"), "#!/bin/sh\nexit 3\n").unwrap();
    assert!(refused(&home, &["plugin", "check", "quiet"]).contains("failed"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn the_example_runs_only_when_on_and_approved() {
    let home = home::short("plx");
    std::fs::write(home.join("settings.json"), r#"{"script_widgets": true}"#).unwrap();
    copy(Path::new(EXAMPLE), &home.join("plugins/quiet-hours"));
    let u = user(&home);
    let core = home::spawn_serve(&home, &[("HOME", u.to_str().unwrap())]);
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    let panels = |home: &Path| {
        let list = call(home, &owner, json!({"op": "widget_list"}));
        list["Ok"]["list"]["widgets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let cache = home.join("plugins/quiet-hours/cache");

    assert_eq!(
        ok(&home, &["plugin", "list"]).trim(),
        "quiet-hours\toff\tnot approved"
    );
    assert!(panels(&home).is_empty());
    assert!(refused(&home, &["plugin", "run", "quiet-hours", "status"]).contains("off"));
    ok(&home, &["plugin", "on", "quiet-hours"]);
    assert_eq!(panels(&home), ["plugin:quiet-hours/now"]);
    assert!(refused(&home, &["plugin", "run", "quiet-hours", "status"]).contains("needs approval"));
    let run = call(
        &home,
        &owner,
        json!({"op": "widget_run", "name": "plugin:quiet-hours/now"}),
    );
    assert!(
        run["Err"].as_str().unwrap().contains("needs approval"),
        "{run}"
    );
    assert!(!cache.exists(), "something ran before approval");

    // A session token and a full token reach no plugin request.
    let full = ok(&home, &["token", "create", "--scope", "full"]);
    for action in [
        json!({"do": "list"}),
        json!({"do": "set", "id": "quiet-hours", "on": true}),
    ] {
        let reply = call(
            &home,
            full.trim(),
            json!({"op": "plugin", "action": action}),
        );
        assert!(reply["Err"].as_str().is_some(), "{reply}");
    }
    // An agent's own `plugin on` (inside its session) is refused like the window's other owner requests.
    let out = u.join("agent-out");
    let script = format!(
        "'{}' plugin on quiet-hours > '{}' 2>&1; exec cat",
        env!("CARGO_BIN_EXE_nunchiro"),
        out.display()
    );
    ok(
        &home,
        &[
            "agent",
            "start",
            "s",
            "--kind",
            "shell",
            "--project",
            u.to_str().unwrap(),
            "--",
            "/bin/sh",
            "-c",
            &script,
        ],
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::fs::read_to_string(&out).map_or(true, |t| t.is_empty()) {
        assert!(
            std::time::Instant::now() < until,
            "the agent's call never answered"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        std::fs::read_to_string(&out)
            .unwrap()
            .contains("not granted")
    );
    ok(&home, &["plugin", "off", "quiet-hours"]);
    ok(&home, &["plugin", "on", "quiet-hours"]);

    assert!(ok(&home, &["plugin", "allow", "quiet-hours"]).contains("approved plugin quiet-hours"));
    assert_eq!(
        ok(&home, &["plugin", "list"]).trim(),
        "quiet-hours\ton\tapproved"
    );
    let status = ok(&home, &["plugin", "run", "quiet-hours", "status"]);
    assert!(
        status.contains("quiet") && status.contains("22:00"),
        "{status}"
    );
    let run = call(
        &home,
        &owner,
        json!({"op": "widget_run", "name": "plugin:quiet-hours/now"}),
    );
    assert!(
        run["Ok"]["run"]["output"]["text"]
            .as_str()
            .unwrap()
            .contains("quiet from"),
        "{run}"
    );
    // A setting reaches the next run.
    let set = call(
        &home,
        &owner,
        json!({"op": "plugin", "action": {"do": "setting", "id": "quiet-hours", "key": "start", "value": "21:30"}}),
    );
    assert_eq!(set["Ok"]["plugins"][0]["values"]["start"], "21:30", "{set}");
    assert!(ok(&home, &["plugin", "run", "quiet-hours", "status"]).contains("21:30"));
    let bad = call(
        &home,
        &owner,
        json!({"op": "plugin", "action": {"do": "setting", "id": "quiet-hours", "key": "start", "value": "late"}}),
    );
    assert!(bad["Err"].as_str().unwrap().contains("time"), "{bad}");

    // Any change asks again and stops every part.
    std::fs::write(
        home.join("plugins/quiet-hours/status.sh"),
        "#!/bin/sh\necho changed\n",
    )
    .unwrap();
    assert_eq!(
        ok(&home, &["plugin", "list"]).trim(),
        "quiet-hours\ton\tchanged since approval"
    );
    assert!(refused(&home, &["plugin", "run", "quiet-hours", "status"]).contains("changed"));
    let run = call(
        &home,
        &owner,
        json!({"op": "widget_run", "name": "plugin:quiet-hours/now"}),
    );
    assert!(run["Err"].as_str().unwrap().contains("changed"), "{run}");

    ok(&home, &["plugin", "remove", "quiet-hours"]);
    assert!(ok(&home, &["plugin", "list"]).contains("no plugins"));
    assert!(home.join("plugins/.removed").read_dir().unwrap().count() == 1);
    drop(core);
}
