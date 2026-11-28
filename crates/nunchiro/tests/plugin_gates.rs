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
    // A plugin with a check asks again after any change, its script alone included: it decides nothing until then.
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
    let _ = pair(&c, &script);
    let read = || std::fs::read_to_string(&out).unwrap_or_default();
    until("refused it", &read);
}

#[test]
fn a_schedules_task_is_checked_before_it_is_sent() {
    let c = core("pgt");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": false, "reason": "No tasks tonight."}\n'"#,
        "refuse",
        true,
    );
    // A project folder that is not the user's home (a session there does not make the home a project).
    let project = user(&c.home).join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    ok(
        &c.home,
        &[
            "agent",
            "start",
            "here",
            "--kind",
            "shell",
            "--project",
            project.to_str().unwrap(),
            "--",
            "/bin/sh",
            "-c",
            "exec cat",
        ],
    );
    let add = call(
        &c.home,
        &c.owner,
        json!({"op": "schedule_add", "run": {"kind": "claude", "project": project, "label": "nightly", "task": "Tidy the repo."}, "at": "03:00", "daily": true}),
    );
    let id = add["Ok"]["schedules"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(!id.is_empty(), "{add}");
    let run = call(
        &c.home,
        &c.owner,
        json!({"op": "schedule_run_now", "id": id}),
    );
    assert!(run.to_string().contains("No tasks tonight."), "{run}");
}

#[test]
fn a_hung_check_never_holds_a_send_past_the_budget() {
    let c = core("pgb");
    plugin(
        &c.home,
        "prompt.send.before",
        "/bin/sleep 30",
        "allow",
        true,
    );
    // Six agent sends at once through a check that never answers: each is answered within the 10 s budget (the CLI
    // gives up at 15 s), and each is then delivered, as `on_error = "allow"` says.
    let out = user(&c.home).join("times");
    let script = format!(
        "for i in 1 2 3 4 5 6; do ( s=$(/bin/date +%s); '{{bin}}' agent send {{to}} m$i >/dev/null 2>&1; echo \"$? $(( $(/bin/date +%s) - s ))\" >> '{}' ) & done; wait",
        out.display()
    );
    let (_, read) = pair(&c, &script);
    let end = Instant::now() + Duration::from_secs(40);
    while std::fs::read_to_string(&out).map_or(0, |t| t.lines().count()) < 6 {
        assert!(
            Instant::now() < end,
            "not all sends answered: {:?}",
            std::fs::read_to_string(&out)
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    for line in std::fs::read_to_string(&out).unwrap().lines() {
        let (code, secs) = line.split_once(' ').unwrap();
        assert_eq!(code, "0", "a send failed: {line}");
        // Under the CLI's 15 s reply limit: the 10 s budget plus starting the CLI on a loaded machine.
        assert!(secs.parse::<u64>().unwrap() < 15, "a send took {secs} s");
    }
    for i in 1..=6 {
        until(&format!("m{i}"), &read);
    }
}

#[test]
fn a_room_reply_that_would_be_refused_never_reaches_a_check() {
    let c = core("pgm");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": false, "reason": "checked"}\n'"#,
        "refuse",
        true,
    );
    let out = user(&c.home).join("reply-out");
    let script = format!(
        "'{{bin}}' agent reply no-such-message 'words' > '{}' 2>&1",
        out.display()
    );
    let _ = pair(&c, &script);
    let read = || std::fs::read_to_string(&out).unwrap_or_default();
    let end = Instant::now() + Duration::from_secs(15);
    while read().is_empty() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        read().contains("not found") && !read().contains("checked"),
        "{}",
        read()
    );
}

#[test]
fn a_changed_room_message_names_the_plugin() {
    let c = core("pgn");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": true, "text": "seen-rs-words"}\n'"#,
        "refuse",
        true,
    );
    let project = user(&c.home).join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let script = format!(
        "'{}' agent send --to person 'raw room words'; exec cat",
        env!("CARGO_BIN_EXE_nunchiro")
    );
    ok(
        &c.home,
        &[
            "agent",
            "start",
            "w",
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
    let end = Instant::now() + Duration::from_secs(15);
    let message = loop {
        let read = call(
            &c.home,
            &c.owner,
            json!({"op": "room_read", "project": project}),
        );
        if let Some(m) = read["Ok"]["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["body"] == "seen-rs-words")
        {
            break m.clone();
        }
        assert!(Instant::now() < end, "{read}");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(message["changed_by"], "Guard", "{message}");
    assert!(
        !message.to_string().contains("raw room words"),
        "the original stays out of the room: {message}"
    );
}

#[test]
fn a_refused_send_exits_non_zero() {
    let c = core("pgx");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": false, "reason": "No."}\n'"#,
        "refuse",
        true,
    );
    let out = user(&c.home).join("exit");
    let script = format!(
        // An agent's three ways to send: to a session, text into a session, to the room.
        "'{{bin}}' agent send {{to}} words >/dev/null 2>&1; a=$?; '{{bin}}' session send-text {{to}} words >/dev/null 2>&1; b=$?; '{{bin}}' agent send --to person words >/dev/null 2>&1; echo \"$a $b $?\" > '{}'",
        out.display()
    );
    let _ = pair(&c, &script);
    let end = Instant::now() + Duration::from_secs(15);
    while std::fs::read_to_string(&out).map_or(true, |t| t.is_empty()) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
    let codes = std::fs::read_to_string(&out).unwrap();
    assert!(
        codes.split_whitespace().all(|c| c != "0"),
        "a refused send exited 0: {codes}"
    );
}

#[test]
fn a_check_skipped_for_no_time_is_counted_on_the_plugin() {
    let c = core("pgk");
    plugin(
        &c.home,
        "prompt.send.before",
        "/bin/sleep 30",
        "allow",
        true,
    );
    let out = user(&c.home).join("done");
    let script = format!(
        "for i in 1 2 3; do '{{bin}}' agent send {{to}} m$i >/dev/null 2>&1 & done; wait; echo done > '{}'",
        out.display()
    );
    let _ = pair(&c, &script);
    let end = Instant::now() + Duration::from_secs(40);
    while !out.exists() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(200));
    }
    let listed: Value = serde_json::from_str(&ok(&c.home, &["plugin", "list", "--json"])).unwrap();
    assert!(listed[0]["skipped"].as_u64().unwrap_or(0) >= 1, "{listed}");
}

#[test]
fn the_room_copy_of_a_changed_agent_send_names_the_plugin() {
    let c = core("pgy");
    plugin(
        &c.home,
        "prompt.send.before",
        r#"printf '{"allow": true, "text": "seen-agent-words"}\n'"#,
        "refuse",
        true,
    );
    let project = user(&c.home).join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
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
    let to = start("to", "exec cat");
    start(
        "from",
        &format!(
            "'{}' agent send {to} 'raw words'; exec cat",
            env!("CARGO_BIN_EXE_nunchiro")
        ),
    );
    let end = Instant::now() + Duration::from_secs(15);
    let line = loop {
        let read = call(
            &c.home,
            &c.owner,
            json!({"op": "room_read", "project": project}),
        );
        if let Some(m) = read["Ok"]["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["body"] == "seen-agent-words")
        {
            break m.clone();
        }
        assert!(Instant::now() < end, "{read}");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(line["kind"], "typed", "{line}");
    assert_eq!(line["changed_by"], "Guard", "{line}");
}

/// Marks `guard` as installed from a catalogue whose kill list (as the core keeps it, read now) names it.
fn killed_by_catalogue(home: &Path, reason: &str) {
    let origin = "https://raw.githubusercontent.com/develku/nunchiro/";
    let file = home.join("plugins.json");
    let mut store: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    store["installed"] =
        json!({"guard": {"commit": "0123456789abcdef0123456789abcdef01234567", "origin": origin}});
    store["on"] = json!([]); // a refresh turns it off
    std::fs::write(&file, store.to_string()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    std::fs::write(
        home.join("plugin-kill-list.json"),
        json!({"lists": {origin: [now, [{"id": "guard", "reason": reason}]]}}).to_string(),
    )
    .unwrap();
}

#[test]
fn a_blocked_check_that_fails_closed_keeps_refusing() {
    let c = core("pgk");
    // Its script would let everything through: it is not run; the block refuses.
    plugin(
        &c.home,
        "session.start.before",
        r#"printf '{"allow": true}\n'"#,
        "refuse",
        true,
    );
    killed_by_catalogue(&c.home, "It sent files to a stranger.");
    let out = start(&c.home, None, false);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains(
            "Guard stopped this start: blocked by its catalogue: It sent files to a stranger."
        ),
        "{}",
        stderr(&out)
    );
    // A blocked check that fails open decides nothing.
    plugin(
        &c.home,
        "session.start.before",
        r#"printf '{"allow": true}\n'"#,
        "allow",
        true,
    );
    killed_by_catalogue(&c.home, "It sent files to a stranger.");
    assert!(!stderr(&start(&c.home, None, false)).contains("stopped this start"));
}

#[test]
fn two_switches_at_once_both_stay() {
    // Turning two plugins on together: neither switch is lost (one lock around every change of plugins.json).
    let c = core("pgl");
    for id in ["a1", "a2", "a3", "a4"] {
        let dir = c.home.join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("plugin.toml"),
            format!("id = \"{id}\"\nname = \"{id}\"\nversion = \"1\"\n"),
        )
        .unwrap();
    }
    let runs: Vec<_> = ["a1", "a2", "a3", "a4"]
        .into_iter()
        .map(|id| {
            let home = c.home.clone();
            std::thread::spawn(move || ok(&home, &["plugin", "on", id]))
        })
        .collect();
    for r in runs {
        r.join().unwrap();
    }
    let store: serde_json::Value =
        serde_json::from_slice(&std::fs::read(c.home.join("plugins.json")).unwrap()).unwrap();
    assert_eq!(store["on"], json!(["a1", "a2", "a3", "a4"]));
}
