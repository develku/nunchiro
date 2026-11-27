// Plugins under review: what the owner approves is exactly what can run. A plugin is approved whole and shows every
// part's rights; `plugin check` runs with none of the rights it asks for; a long command never holds the core's
// answer; a draft for the message box is checked; off and remove stop and forget; no token or agent gets past.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Output,
    time::{Duration, Instant},
};

/// The user's home, beside (never inside) the Nunchiro home.
fn user(home: &Path) -> PathBuf {
    let mut name = home.file_name().unwrap().to_os_string();
    name.push("-user");
    let u = home.with_file_name(name);
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
fn call(home: &Path, token: &str, request: Value) -> Value {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

/// A plugin `p` with one command `c` (`show`), its script `script`, and `extra` lines in its [[command]].
fn plugin(home: &Path, show: &str, script: &str, extra: &str) -> PathBuf {
    let dir = home.join("plugins/p");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plugin.toml"),
        format!("id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\n\n[[command]]\nname = \"c\"\ncommand = [\"/bin/sh\", \"c.sh\"]\nshow = \"{show}\"\n{extra}\n"),
    )
    .unwrap();
    std::fs::write(dir.join("c.sh"), format!("#!/bin/sh\n{script}\n")).unwrap();
    dir
}
struct Core {
    home: PathBuf,
    owner: String,
    _guard: home::ServeGuard,
}
fn core(tag: &str) -> Core {
    let home = home::short(tag);
    std::fs::write(home.join("settings.json"), r#"{"script_widgets": true}"#).unwrap();
    let u = user(&home);
    let guard = home::spawn_serve(&home, &[("HOME", u.to_str().unwrap())]);
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    Core {
        home,
        owner,
        _guard: guard,
    }
}
fn run(c: &Core, poll: bool) -> Value {
    call(
        &c.home,
        &c.owner,
        json!({"op": "plugin", "action": {"do": "run", "id": "p", "command": "c", "poll": poll}}),
    )
}
/// The run's end: polls until the core says it is no longer running.
fn finished(c: &Core) -> Value {
    let mut r = run(c, false);
    let until = Instant::now() + Duration::from_secs(15);
    while r["Ok"]["run"]["running"] == true {
        assert!(Instant::now() < until, "the run never ended");
        std::thread::sleep(Duration::from_millis(100));
        r = run(c, true);
    }
    r
}

#[test]
fn a_part_cannot_be_approved_alone() {
    let c = core("prp");
    plugin(&c.home, "note", "echo hi", "read = [\"~/notes\"]");
    ok(&c.home, &["plugin", "on", "p"]);
    for name in ["plugin__p__c", "plugin:p/c"] {
        let status = call(
            &c.home,
            &c.owner,
            json!({"op": "approval_status", "name": name}),
        );
        assert!(status["Err"].is_string(), "{name}: {status}");
        let grant = call(
            &c.home,
            &c.owner,
            json!({"op": "approval_grant", "name": name, "level": "read", "hash": "0".repeat(64)}),
        );
        assert!(grant["Err"].is_string(), "{name}: {grant}");
    }
    assert!(
        !nunchiro(&c.home, &["widget", "allow", "plugin__p__c", "--read"])
            .status
            .success()
    );
    // An agent asking for one part is refused, never turned into an owner's card.
    let out = user(&c.home).join("agent-out");
    let script = format!(
        "'{}' widget allow plugin__p__c --read > '{}' 2>&1; exec cat",
        env!("CARGO_BIN_EXE_nunchiro"),
        out.display()
    );
    ok(
        &c.home,
        &[
            "agent",
            "start",
            "s",
            "--kind",
            "shell",
            "--project",
            user(&c.home).to_str().unwrap(),
            "--",
            "/bin/sh",
            "-c",
            &script,
        ],
    );
    let until = Instant::now() + Duration::from_secs(20);
    while std::fs::read_to_string(&out).map_or(true, |t| t.is_empty()) {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(50));
    }
    let said = std::fs::read_to_string(&out).unwrap();
    assert!(!said.contains("waiting for the owner"), "{said}");
    assert!(ok(&c.home, &["plugin", "list"]).contains("not approved"));
}

#[test]
fn allow_and_the_sheet_show_each_parts_rights() {
    let c = core("prr");
    plugin(
        &c.home,
        "send",
        "echo hi",
        "network = [\"api.github.com\"]\nread = [\"~/notes\"]",
    );
    let status = call(
        &c.home,
        &c.owner,
        json!({"op": "approval_status", "name": "plugin:p"}),
    );
    let part = &status["Ok"]["view"]["parts"][0];
    assert_eq!(part["network"], json!(["api.github.com"]), "{status}");
    assert_eq!(part["read"], json!(["~/notes"]), "{status}");
    assert_eq!(part["writes_draft"], true, "{status}");
    let said = ok(&c.home, &["plugin", "allow", "p"]);
    assert!(
        said.contains("network: api.github.com")
            && said.contains("reads beyond its project: ~/notes"),
        "{said}"
    );
    assert!(said.contains("writes into the message box"), "{said}");
}

#[test]
fn check_runs_with_none_of_the_rights_it_asks_for() {
    let c = core("prc");
    let secret = user(&c.home).join("secret");
    std::fs::create_dir_all(&secret).unwrap();
    std::fs::write(secret.join("key.txt"), "TOP-SECRET-VALUE").unwrap();
    plugin(
        &c.home,
        "note",
        &format!(
            "/bin/cat '{}' 2>&1 || echo DENIED",
            secret.join("key.txt").display()
        ),
        "read = [\"~/secret\"]",
    );
    let said = ok(&c.home, &["plugin", "check", "p"]);
    assert!(!said.contains("TOP-SECRET-VALUE"), "{said}");
    // Off, script parts are checked but not run.
    std::fs::write(c.home.join("settings.json"), r#"{"script_widgets": false}"#).unwrap();
    let said = ok(&c.home, &["plugin", "check", "p"]);
    assert!(
        said.contains("not run") && !said.contains("TOP-SECRET-VALUE"),
        "{said}"
    );
    // Approved, the same part reads what it declared: the approval is what grants it.
    std::fs::write(c.home.join("settings.json"), r#"{"script_widgets": true}"#).unwrap();
    ok(&c.home, &["plugin", "allow", "p"]);
    ok(&c.home, &["plugin", "on", "p"]);
    let r = finished(&c);
    assert!(
        r["Ok"]["run"]["output"]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("TOP-SECRET-VALUE"),
        "{r}"
    );
}
