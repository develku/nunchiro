// Plugin checks (`[[gate]]`, docs/plugins.md) end to end through a real core: an approved, on check that refuses
// stops an agent's and a token's new session with the plugin's reason and no way past it, stops the owner's start
// with Start anyway (`--anyway`) as the way past; a check that replaces text changes what an agent sends; a check that
// hangs is stopped at 5 s and its `on_error` decides. Off, unapproved or changed, a plugin decides nothing.
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

/// The user's home and project folder, beside (never inside) the Nunchiro home: a token's session may not work in it.
fn user(home: &Path) -> PathBuf {
    let mut name = home.file_name().unwrap().to_os_string();
    name.push("-user");
    let u = home.with_file_name(name);
    std::fs::create_dir_all(&u).unwrap();
    u
}
fn nunchiro(home: &Path, token: Option<&str>, args: &[&str]) -> Output {
    let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    c.args(args)
        .env("NUNCHIRO_HOME", home)
        .env("HOME", user(home))
        .env_remove("NUNCHIRO_TOKEN");
    if let Some(t) = token {
        c.env("NUNCHIRO_TOKEN", t);
    }
    c.output().unwrap()
}
fn ok(home: &Path, args: &[&str]) -> String {
    let out = nunchiro(home, None, args);
    assert!(
        out.status.success(),
        "{args:?}: {}",
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

/// A plugin `guard` with one check, `script` as its gate.sh; on and approved unless `approve` is false.
fn plugin(home: &Path, on: &str, script: &str, on_error: &str, approve: bool) {
    let dir = home.join("plugins/guard");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plugin.toml"),
        format!("id = \"guard\"\nname = \"Guard\"\nversion = \"1.0.0\"\n\n[[gate]]\nname = \"g\"\non = \"{on}\"\ncommand = [\"/bin/sh\", \"gate.sh\"]\non_error = \"{on_error}\"\n"),
    )
    .unwrap();
    std::fs::write(dir.join("gate.sh"), format!("#!/bin/sh\n{script}\n")).unwrap();
    if approve {
        ok(home, &["plugin", "allow", "guard"]);
    }
    ok(home, &["plugin", "on", "guard"]);
}
const REFUSE: &str = r#"printf '{"allow": false, "reason": "Quiet hours until 07:00."}\n'"#;

struct Core {
    home: PathBuf,
    _guard: home::ServeGuard,
    owner: String,
}
fn core(tag: &str) -> Core {
    let home = home::short(tag);
    std::fs::write(home.join("settings.json"), r#"{"script_widgets": true}"#).unwrap();
    let u = user(&home);
    let guard = home::spawn_serve(&home, &[("HOME", u.to_str().unwrap())]);
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    Core {
        home,
        _guard: guard,
        owner,
    }
}
/// A new agent session, as the owner's CLI asks for it (a fake `claude`, never started: the check runs first).
fn start(home: &Path, token: Option<&str>, anyway: bool) -> Output {
    let project = user(home);
    let mut args = vec![
        "agent",
        "start",
        "a",
        "--kind",
        "claude",
        "--project",
        project.to_str().unwrap(),
    ];
    if anyway {
        args.push("--anyway");
    }
    nunchiro(home, token, &args)
}
fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn a_refusing_check_stops_new_sessions_with_its_reason() {
    let c = core("pgr");
    plugin(&c.home, "session.start.before", REFUSE, "refuse", true);
    // The owner: the sentence and a way past (the window shows Start anyway; the CLI's --anyway).
    let owner = start(&c.home, None, false);
    assert!(!owner.status.success());
    assert!(
        stderr(&owner).contains("Guard stopped this start: Quiet hours until 07:00."),
        "{}",
        stderr(&owner)
    );
    let anyway = start(&c.home, None, true);
    assert!(
        !stderr(&anyway).contains("stopped this start"),
        "{}",
        stderr(&anyway)
    );
    // A token: refused with the reason, and it cannot say anyway.
    let token = ok(&c.home, &["token", "create", "--scope", "supervised"]);
    let refused = start(&c.home, Some(token.trim()), false);
    assert!(
        stderr(&refused)
            .contains("refused it: Quiet hours until 07:00. Only the owner can start it anyway."),
        "{}",
        stderr(&refused)
    );
    let reply = call(
        &c.home,
        token.trim(),
        json!({"op": "start_anyway", "start": {"op": "start", "session": {"kind": "claude", "project": user(&c.home)}}}),
    );
    assert!(reply["Err"].is_string(), "{reply}");
    // A plain terminal is not a new agent seat: not checked.
    let shell = nunchiro(
        &c.home,
        None,
        &[
            "agent",
            "start",
            "t",
            "--kind",
            "shell",
            "--project",
            user(&c.home).to_str().unwrap(),
            "--",
            "/bin/sh",
            "-c",
            "exec cat",
        ],
    );
    assert!(shell.status.success(), "{}", stderr(&shell));
}

#[test]
fn an_off_unapproved_or_changed_plugin_decides_nothing() {
    let c = core("pgo");
    plugin(&c.home, "session.start.before", REFUSE, "refuse", false);
    assert!(!stderr(&start(&c.home, None, false)).contains("stopped this start"));
    // Not approved: no check process ran at all (a run makes its cache folder).
    assert!(!c.home.join("plugins/guard/cache").exists());
    ok(&c.home, &["plugin", "allow", "guard"]);
    assert!(stderr(&start(&c.home, None, false)).contains("stopped this start"));
    std::fs::write(
        c.home.join("plugins/guard/gate.sh"),
        format!("#!/bin/sh\n{REFUSE}\n# changed\n"),
    )
    .unwrap();
    assert!(!stderr(&start(&c.home, None, false)).contains("stopped this start"));
    ok(&c.home, &["plugin", "allow", "guard"]);
    ok(&c.home, &["plugin", "off", "guard"]);
    assert!(!stderr(&start(&c.home, None, false)).contains("stopped this start"));
}

#[test]
fn a_hanging_check_is_stopped_and_on_error_decides() {
    let c = core("pgh");
    plugin(
        &c.home,
        "session.start.before",
        "/bin/sleep 10",
        "refuse",
        true,
    );
    let t = Instant::now();
    let out = start(&c.home, None, false);
    assert!(
        stderr(&out).contains("Guard stopped this start: its check did not answer"),
        "{}",
        stderr(&out)
    );
    assert!(t.elapsed() < Duration::from_secs(9), "{:?}", t.elapsed());
    plugin(
        &c.home,
        "session.start.before",
        "/bin/sleep 10",
        "allow",
        true,
    );
    assert!(!stderr(&start(&c.home, None, false)).contains("stopped this start"));
}

#[test]
fn a_check_replaces_what_an_agent_sends_but_never_the_owners_words() {
    let c = core("pgs");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": true, "text": "replaced by the plugin"}\n'"#,
        "refuse",
        true,
    );
    let project = user(&c.home);
    let start = |name: &str| {
        let out = ok(
            &c.home,
            &[
                "agent",
                "start",
                name,
                "--kind",
                "shell",
                "--project",
                project.to_str().unwrap(),
                "--",
                "/bin/sh",
                "-c",
                "echo READY; exec cat",
            ],
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        v["session"]["id"].as_str().unwrap().to_string()
    };
    let to = start("to");
    let read = |id: &str| {
        let r = call(&c.home, &c.owner, json!({"op": "read", "id": id}));
        let bytes: Vec<u8> = r["Ok"]["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b.as_u64().map(|b| b as u8))
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let wait = |id: &str, what: &str| {
        let until = Instant::now() + Duration::from_secs(10);
        while !read(id).contains(what) {
            assert!(
                Instant::now() < until,
                "{what} never reached {id}: {}",
                read(id)
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    wait(&to, "READY");
    // The owner's send: unchanged, and no check ran.
    ok(&c.home, &["session", "send-text", &to, "owner words"]);
    wait(&to, "owner words");
    assert!(
        !c.home.join("plugins/guard/cache").exists(),
        "a check ran for the owner's words"
    );
    // An agent's send (from inside its session): replaced before it is delivered.
    let script = format!(
        "'{}' agent send {to} 'agent words'; exec cat",
        env!("CARGO_BIN_EXE_nunchiro")
    );
    ok(
        &c.home,
        &[
            "agent",
            "start",
            "from",
            "--kind",
            "shell",
            "--project",
            project.to_str().unwrap(),
            "--",
            "/bin/sh",
            "-c",
            &script,
        ],
    );
    wait(&to, "replaced by the plugin");
    assert!(!read(&to).contains("agent words"));
}

/// Shell sessions in `c`'s user folder: `to` echoes what it gets; `from` runs `script` (from inside its session, so as
/// an agent) and then `cat`. Returns `to`'s id and a reader of its screen.
fn pair(c: &Core, script: &str) -> (String, impl Fn() -> String + use<>) {
    let project = user(&c.home);
    let start = |name: &str, run: &str| {
        let out = ok(
            &c.home,
            &[
                "agent",
                "start",
                name,
                "--kind",
                "shell",
                "--project",
                project.to_str().unwrap(),
                "--",
                "/bin/sh",
                "-c",
                run,
            ],
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        v["session"]["id"].as_str().unwrap().to_string()
    };
    let to = start("to", "echo READY; exec cat");
    let read = {
        let (home, owner, to) = (c.home.clone(), c.owner.clone(), to.clone());
        move || {
            let r = call(&home, &owner, json!({"op": "read", "id": to}));
            let bytes: Vec<u8> = r["Ok"]["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| b.as_u64().map(|b| b as u8))
                .collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    let script = script
        .replace("{to}", &to)
        .replace("{bin}", env!("CARGO_BIN_EXE_nunchiro"));
    start("from", &format!("{script}; exec cat"));
    (to, read)
}
fn until(what: &str, read: &dyn Fn() -> String) {
    let end = Instant::now() + Duration::from_secs(15);
    while !read().contains(what) {
        assert!(Instant::now() < end, "{what} never arrived: {}", read());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn every_way_an_agent_sends_text_is_checked() {
    let c = core("pga");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": true, "text": "replaced by the plugin"}\n'"#,
        "refuse",
        true,
    );
    // `session send-text`, then a room reply: both from inside an agent's session.
    let (_, read) = pair(&c, "'{bin}' session send-text {to} 'raw agent words'");
    until("replaced by the plugin", &read);
    assert!(!read().contains("raw agent words"), "{}", read());
}

#[test]
fn two_checks_at_once_each_read_their_own_message() {
    let c = core("pgc");
    // The check echoes the text it was given, after a pause, so two runs overlap.
    let echo = r#"t=$(/usr/bin/sed -n 's/.*"text":"\([a-z]*\)".*/\1/p' "$NUNCHIRO_CONTEXT"); /bin/sleep 1; printf '{"allow": true, "text": "seen-%s"}\n' "$t""#;
    plugin(&c.home, "prompt.send.before", echo, "refuse", true);
    let (_, read) = pair(
        &c,
        "'{bin}' agent send {to} alpha & /bin/sleep 0.2; '{bin}' agent send {to} beta; wait",
    );
    until("seen-alpha", &read);
    until("seen-beta", &read);
}

#[test]
fn the_send_log_keeps_the_original_and_the_plugin() {
    let c = core("pgl");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": true, "text": "replaced by the plugin"}\n'"#,
        "refuse",
        true,
    );
    let (to, read) = pair(&c, "'{bin}' agent send {to} 'first words'");
    until("replaced by the plugin", &read);
    let snap = call(&c.home, &c.owner, json!({"op": "snapshot"}));
    let row = snap["Ok"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == to.as_str())
        .unwrap()["send_log"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["content"] == "replaced by the plugin")
        .cloned()
        .unwrap_or_default();
    assert_eq!(row["replaced"]["plugin"], "Guard", "{row}");
    assert_eq!(row["replaced"]["original"], "first words", "{row}");
}

#[test]
fn the_sheet_says_what_a_check_can_do() {
    let c = core("pgw");
    plugin(&c.home, "prompt.send.before", "exit 0", "allow", false);
    let view = call(
        &c.home,
        &c.owner,
        json!({"op": "approval_status", "name": "plugin:guard"}),
    );
    let part = &view["Ok"]["view"]["parts"][0];
    assert_eq!(part["kind"], "check");
    assert_eq!(part["check_on"], "prompt.send.before", "{view}");
    assert_eq!(part["on_error"], "allow", "{view}");
}

#[test]
fn an_agent_resuming_a_conversation_is_checked() {
    let c = core("pgr2");
    plugin(&c.home, "session.start.before", REFUSE, "refuse", true);
    let out = user(&c.home).join("resume-out");
    let script = format!(
        "'{}' session start --kind claude --project '{}' --resume abc > '{}' 2>&1",
        env!("CARGO_BIN_EXE_nunchiro"),
        user(&c.home).display(),
        out.display()
    );
    pair(&c, &script);
    let read = || std::fs::read_to_string(&out).unwrap_or_default();
    until("refused it", &read);
}
