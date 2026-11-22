//! Ticket 13 (owner token hardening), with v1a-23 (needs 47, OWNERC = D', which replaced SHELL=A): a process inside
//! one of this core's sessions gets no window token from `window.json` or `core.token`, its owner token counts as
//! that session's caller (owner commands yes, the two human actions only as a waiting item), and refilled slow
//! sockets cannot keep the window out. Fake agents and shell sessions only. Tests compare tokens and never print them.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "tauri://localhost";
const HINT: &str = "run this from the Nunchiro window or a terminal outside Nunchiro";
const WAITING: &str = "waiting for the owner in the Nunchiro window"; // v1a-23
/// Ticket 1023: a secret-looking name in the core's environment (ticket 1008 keeps it from every agent session).
const SECRET: &str = "W45_TEST_API_SECRET";

fn cli() -> PathBuf {
    cli::path()
}
fn scratch(tag: &str) -> PathBuf {
    home::short(&format!("oh-{tag}"))
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with_env(&[])
    }
    /// Ticket 1023: a core started with `extra` in its environment (synthetic values only).
    fn with_env(extra: &[(&str, &str)]) -> Self {
        let home = scratch("core");
        fs::create_dir_all(home.join("bin")).unwrap();
        // Fake Claude: answers --version, then runs the test's agent.sh as the agent process.
        let claude = home.join("bin/claude");
        fs::write(
            &claude,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nexec /bin/sh \"$NUNCHIRO_HOME/agent.sh\"\n",
        )
        .unwrap();
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
            .env("NUNCHIRO_SSH", "/usr/bin/false") // never reach a real machine
            .envs(extra.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists()
            || core.raw(&core.owner_token(), r#"{"op":"snapshot"}"#)["Ok"]["type"] != "snapshot"
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    fn owner_token(&self) -> String {
        fs::read_to_string(self.home.join("core.token")).unwrap_or_default()
    }
    /// One socket request from this test process, which is outside every session.
    fn raw(&self, token: &str, request: &str) -> serde_json::Value {
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return serde_json::Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let line = format!(
            "{{\"token\":{},\"request\":{request}}}\n",
            serde_json::json!(token)
        );
        // Under load the core can close first; the caller's own assert then fails on Null with its message.
        if s.write_all(line.as_bytes()).is_err() {
            return serde_json::Value::Null;
        }
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null)
    }
    fn window(&self) -> (u16, String) {
        let r = self.raw(&self.owner_token(), r#"{"op":"window_auth"}"#);
        assert_eq!(r["Ok"]["type"], "window_auth", "window_auth refused");
        (
            r["Ok"]["port"].as_u64().unwrap() as u16,
            r["Ok"]["token"].as_str().unwrap().to_string(),
        )
    }
    /// Hides both owner tokens from anything a failing assertion prints.
    fn redact(&self, text: &str) -> String {
        let mut text = text.replace(self.owner_token().trim(), "<core.token>");
        let r = self.raw(&self.owner_token(), r#"{"op":"window_auth"}"#);
        if let Some(t) = r["Ok"]["token"].as_str() {
            text = text.replace(t, "<window token>");
        }
        text
    }
    fn start(&self, kind: &str, args: serde_json::Value) -> serde_json::Value {
        let request = serde_json::json!({"op":"start","session":{
            "kind":kind,"project":self.home,"label":kind,"args":args}});
        let r = self.raw(&self.owner_token(), &request.to_string());
        assert_eq!(r["Ok"]["type"], "started", "{r}");
        r["Ok"]["session"].clone()
    }
    /// Runs `script` as an agent (fake Claude) or as a plain shell session, after the probe helpers.
    fn run_in(&self, kind: &str, script: &str) -> serde_json::Value {
        let body = format!(
            "CLI='{}'\nH=\"$NUNCHIRO_HOME\"\nprobe() {{ n=$1; shift; \"$@\" > \"$H/$n.out\" 2>&1 < /dev/null; echo \"exit=$?\" >> \"$H/$n.out\"; }}\n{script}\ntouch \"$H/{kind}.done\"\nsleep 60\n",
            cli().display()
        );
        let path = self.home.join(if kind == "claude" {
            "agent.sh".to_string()
        } else {
            format!("{kind}.sh")
        });
        fs::write(&path, body).unwrap();
        let session = if kind == "claude" {
            self.start("claude", serde_json::json!([]))
        } else {
            self.start("shell", serde_json::json!(["/bin/sh", path]))
        };
        self.wait(&format!("{kind}.done"));
        session
    }
    fn wait(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join(name).exists() {
            assert!(Instant::now() < until, "{name} never appeared");
            thread::sleep(Duration::from_millis(50));
        }
        fs::read_to_string(self.home.join(name)).unwrap_or_default()
    }
    fn out(&self, name: &str) -> String {
        let text = self.wait(&format!("{name}.out"));
        let until = Instant::now() + Duration::from_secs(15);
        let mut text = text;
        while !text.contains("exit=") {
            assert!(Instant::now() < until, "{name} never finished");
            thread::sleep(Duration::from_millis(50));
            text = fs::read_to_string(self.home.join(format!("{name}.out"))).unwrap();
        }
        text
    }
    fn alive(&self) -> bool {
        self.raw(&self.owner_token(), r#"{"op":"snapshot"}"#)["Ok"]["type"] == "snapshot"
    }
    fn dial(&self, origin: &str, protocols: &str) -> Result<(), u16> {
        let (port, _) = self.window();
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(protocols).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        match tungstenite::client(req, stream) {
            Ok(_) => Ok(()),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => {
                Err(r.status().as_u16())
            }
            Err(e) => panic!("unexpected handshake error: {e}"),
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.raw(&self.owner_token(), r#"{"op":"stop"}"#);
        let until = Instant::now() + Duration::from_secs(5);
        while self.process.try_wait().ok().flatten().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

/// A shell function asking for the window token with `core.token`, as an agent that read the file would.
const WINDOW_AUTH_WITH_CORE_TOKEN: &str = r#"wa() { printf '{"token":"%s","request":{"op":"window_auth"}}\n' "$(cat "$H/core.token")" | /usr/bin/nc -U "$H/core.sock"; }"#;

#[test]
fn owner_hardening_forged_origin_without_token() {
    let core = Core::new();
    let (_, window_token) = core.window();
    let me = core.run_in(
        "claude",
        &format!(
            "{WINDOW_AUTH_WITH_CORE_TOKEN}\n\
             probe window cat \"$H/window.json\"\n\
             probe auth wa\n\
             probe tokenless env -u NUNCHIRO_TOKEN \"$CLI\" session list\n\
             probe granted \"$CLI\" session start --kind shell --project \"$H\" --label child -- /bin/sleep 60\n"
        ),
    );
    // What the agent read from window.json: the port, no token.
    let seen = core.out("window");
    assert!(
        !seen.contains(&window_token),
        "window.json still carries the token"
    );
    let file: serde_json::Value =
        serde_json::from_str(seen.split("exit=").next().unwrap()).expect("window.json is JSON");
    assert!(file.get("token").is_none(), "{file}");
    assert!(file["port"].as_u64().is_some());
    // With what it found, a forged tauri Origin gets nowhere: no token, empty token, a guess.
    for protocols in [
        "nunchiro.v1",
        "nunchiro.v1, nunchiro.token.",
        "nunchiro.v1, nunchiro.token.0000",
    ] {
        assert_eq!(core.dial(ORIGIN, protocols), Err(401), "{protocols}");
    }
    // core.token from inside the session: no window token. v1a-23 flip: the refusal is the session caller's
    // "operation not granted" (was the hint), and the token-less CLI works as that session (was refused).
    let auth = core.out("auth");
    assert!(
        !auth.contains(&window_token),
        "window_auth answered inside a session"
    );
    assert!(
        auth.contains("operation not granted"),
        "{}",
        core.redact(&auth)
    );
    let tokenless = core.out("tokenless");
    assert!(!tokenless.contains(HINT), "{}", core.redact(&tokenless));
    assert!(tokenless.contains("exit=0"), "{}", core.redact(&tokenless));
    // Its own session token: V1A-04 grants hold exactly (a child in its project is granted, stop is not).
    let granted = core.out("granted");
    assert!(granted.contains("exit=0"), "{}", core.redact(&granted));
    let snapshot = core.raw(&core.owner_token(), r#"{"op":"snapshot"}"#);
    assert!(
        snapshot["Ok"]["sessions"]
            .as_array()
            .expect("no snapshot reply (core closed the socket?)")
            .iter()
            .any(|s| s["label"] == "child" && s["id"] != me["id"]),
        "the granted start did not happen"
    );
    assert!(core.alive());
    // And the owner outside still works, with the real token.
    let (_, token) = core.window();
    assert_eq!(
        core.dial(ORIGIN, &format!("nunchiro.v1, nunchiro.token.{token}")),
        Ok(())
    );
    let log = fs::read_to_string(core.home.join("core.log")).unwrap();
    assert!(!log.contains(&token) && !log.contains(core.owner_token().trim()));
    // v1a-23 flip: the session's own stop request stops the core (was refused with the core left running).
    // Moved last: it ends every session.
    stop_from_a_session(&core, "\"$CLI\" serve stop --yes");
}

/// v1a-23: runs `command` (with `$CLI` set) in a new shell session and waits for the core to stop.
fn stop_from_a_session(core: &Core, command: &str) {
    let script = core.home.join("stop.sh");
    fs::write(
        &script,
        format!(
            "CLI='{}'\n{command} > \"$NUNCHIRO_HOME/stop.out\" 2>&1 < /dev/null\nexec sleep 60\n",
            cli().display()
        ),
    )
    .unwrap();
    core.start("shell", serde_json::json!(["/bin/sh", script]));
    let until = Instant::now() + Duration::from_secs(10);
    while core.alive() {
        assert!(
            Instant::now() < until,
            "the session's stop did not stop the core"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

/// v1a-23 (was SHELL=A, `owner_hardening_plain_shell_refused_with_hint`): plain shell sessions and agent sessions
/// alike, with or without the session token, run owner commands; a human action only raises a waiting item.
#[test]
fn owner_hardening_plain_shell_runs_owner_commands_but_not_human_actions() {
    let core = Core::new();
    fs::write(core.home.join("layout.toml"), "").unwrap();
    let layout = fs::read(core.home.join("layout.toml")).unwrap();
    let made = home::git_env::scrubbed(cli())
        .args(["widget", "new", "w"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    assert!(made.status.success());
    // `serve stop` moved to the end: it ends every session.
    let commands = [
        ("allow", "widget allow w --read"),
        ("layout", "layout remove waiting"),
    ];
    for kind in ["shell", "claude"] {
        let mut script = String::new();
        for (name, args) in commands {
            script += &format!("probe {kind}-{name} \"$CLI\" {args}\n");
            script += &format!("probe {kind}-{name}-bare env -u NUNCHIRO_TOKEN \"$CLI\" {args}\n");
        }
        core.run_in(kind, &script);
    }
    for kind in ["shell", "claude"] {
        for (name, _) in commands {
            for variant in ["", "-bare"] {
                let out = core.out(&format!("{kind}-{name}{variant}"));
                let shown = core.redact(&out);
                // v1a-23 flip (was: not exit 0, first line the hint).
                assert!(!out.contains(HINT), "{kind}-{name}{variant}: {shown}");
                let first = out.lines().next().unwrap_or("");
                if name == "allow" {
                    assert!(out.contains("exit=0"), "{kind}-{name}{variant}: {shown}");
                    assert!(first.contains(WAITING), "{kind}-{name}{variant}: {shown}");
                } else {
                    // The owner's path: the forwarder needs an open window, and none is open.
                    assert!(!out.contains("exit=0"), "{kind}-{name}{variant}: {shown}");
                    assert!(
                        first.contains("no Nunchiro window is open"),
                        "{kind}-{name}{variant}: {shown}"
                    );
                }
            }
        }
    }
    assert!(core.alive());
    assert!(!core.home.join("approvals.json").exists());
    assert_eq!(fs::read(core.home.join("layout.toml")).unwrap(), layout);
    stop_from_a_session(&core, "env -u NUNCHIRO_TOKEN \"$CLI\" serve stop --yes");
}

/// The user's own terminal (this test process) keeps owner authority token-less.
#[test]
fn owner_hardening_outside_terminal_keeps_owner() {
    let core = Core::new();
    core.run_in("shell", ""); // a live session exists; it changes nothing outside it
    let run = |args: &[&str]| {
        home::git_env::scrubbed(cli())
            .args(args)
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };
    assert!(run(&["widget", "new", "w"]).status.success());
    let allow = run(&["widget", "allow", "w", "--read"]);
    assert!(
        allow.status.success(),
        "{}",
        String::from_utf8_lossy(&allow.stderr)
    );
    assert!(core.home.join("approvals.json").exists());
    // No window is open, so layout fails, but as the owner (not with the session hint).
    let layout = run(&["layout", "remove", "waiting"]);
    assert!(!String::from_utf8_lossy(&layout.stderr).contains(HINT));
    let _ = core.window();
    let stop = run(&["serve", "stop", "--yes"]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
}

/// Hooks use the session token and never the owner's; they keep working inside sessions.
#[test]
fn owner_hardening_hooks_inside_sessions_keep_working() {
    let core = Core::new();
    let me = core.run_in(
        "claude",
        "printf '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"touch x\"}}' > \"$H/payload\"\n\
         hk() { \"$CLI\" hook PermissionRequest < \"$H/payload\"; }\n\
         probe hook hk\n",
    );
    let out = core.out("hook");
    assert!(out.contains("exit=0"), "{}", core.redact(&out));
    let snapshot = core.raw(&core.owner_token(), r#"{"op":"snapshot"}"#);
    let mine = snapshot["Ok"]["sessions"]
        .as_array()
        .expect("no snapshot reply (core closed the socket?)")
        .iter()
        .find(|s| s["id"] == me["id"])
        .unwrap()
        .clone();
    assert!(
        !mine["pending"].as_array().unwrap().is_empty(),
        "hook did not reach the queue: {}",
        core.redact(&out)
    );
}

/// `setsid` inside a session, and a grandchild whose parent exited, are still inside. The residual escape
/// (one fork: the child calls `setsid` while its parent exits, reparented to launchd) is demonstrated, not closed:
/// README "Known limit".
#[test]
fn owner_hardening_setsid_and_orphans_stay_inside() {
    let core = Core::new();
    // v1a-23: the call is a human action (`widget allow`), the one thing that still tells inside from outside
    // (was `session list`, refused inside with the hint under SHELL=A).
    core.run_in(
        "shell",
        "\"$CLI\" widget new w > /dev/null 2>&1\n\
         probe setsid /usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die; exec @ARGV' env -u NUNCHIRO_TOKEN \"$CLI\" widget allow w --read\n\
         ( ( sleep 1; probe orphan env -u NUNCHIRO_TOKEN \"$CLI\" widget allow w --read ) & )\n\
         /usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); sleep 1; exec @ARGV' /bin/sh -c 'unset NUNCHIRO_TOKEN; H=\"$1\"; \"$2\" widget allow w --read > \"$H/escape.out\" 2>&1 < /dev/null; echo \"exit=$?\" >> \"$H/escape.out\"' sh \"$H\" \"$CLI\"\n\
         unset NUNCHIRO_TOKEN\n\
         probe unset-env \"$CLI\" widget allow w --read\n",
    );
    for name in ["setsid", "orphan", "unset-env"] {
        let out = core.out(name);
        assert!(out.contains(WAITING), "{name}: {}", core.redact(&out));
        assert!(out.contains("exit=0"), "{name}: {}", core.redact(&out));
    }
    let escape = core.out("escape");
    assert!(
        escape.contains("exit=0") && escape.contains("allowed read for w"),
        "fork + setsid with the parent exiting is the documented residual escape: {}",
        core.redact(&escape)
    );
}

/// An owner-only request with `core.token` and no session variables, as a process that dropped them would send it.
const ASK_WITH_CORE_TOKEN: &str = r#"ask() { printf '{"token":"%s","request":%s}\n' "$(cat "$H/core.token")" "$1" | env -u NUNCHIRO_TOKEN -u NUNCHIRO_SESSION /usr/bin/nc -U "$H/core.sock"; }"#;

/// Ticket 1023: a session's child that drops `NUNCHIRO_TOKEN` and reads `core.token` is that session's caller, never
/// the owner: an owner-only request is refused (through the CLI and on the socket itself), and a shell it starts gets
/// the stripped environment (ticket 1008), not the owner's. The same asks from outside every session are the owner's.
#[test]
fn owner_hardening_session_child_without_token_is_not_the_owner() {
    let core = Core::with_env(&[(SECRET, "synthetic")]);
    let names = core.home.join("names.sh");
    // Only the two names the test reads, never a whole environment (the runner's own variable names stay out).
    fs::write(
        &names,
        format!(
            "#!/bin/sh\nfor n in NUNCHIRO_SESSION {SECRET}; do eval \"[ -n \\\"\\${{$n+x}}\\\" ]\" && echo $n; done > \"$NUNCHIRO_HOME/$1.tmp\"\nmv \"$NUNCHIRO_HOME/$1.tmp\" \"$NUNCHIRO_HOME/$1.names\"\nexec sleep 60\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&names, fs::Permissions::from_mode(0o700)).unwrap();
    let start = |kind: &str| {
        serde_json::json!({"op":"start","session":{"kind":"shell","project":core.home,"label":"t",
            "args":[names, kind]}})
        .to_string()
    };
    for kind in ["shell", "claude"] {
        core.run_in(
            kind,
            &format!(
                "{ASK_WITH_CORE_TOKEN}\n\
                 probe {kind}-cli env -u NUNCHIRO_TOKEN -u NUNCHIRO_SESSION \"$CLI\" token create --scope full\n\
                 probe {kind}-raw ask '{{\"op\":\"token_create\",\"scope\":\"full\",\"project\":null,\"expires_in_ms\":null}}'\n\
                 probe {kind}-setup ask '{{\"op\":\"setup_status\",\"path\":\"/tmp\"}}'\n\
                 probe {kind}-start ask '{}'\n",
                start(kind)
            ),
        );
        for name in ["cli", "raw", "setup"] {
            // The reply is never printed: an answered `token_create` carries a secret.
            let out = core.out(&format!("{kind}-{name}"));
            let refused = out.contains("operation not granted") && !out.contains("\"Ok\"");
            assert!(refused, "{kind}-{name}: answered as the owner");
        }
        let cli = core.out(&format!("{kind}-cli"));
        assert!(!cli.contains("exit=0"), "{kind}-cli: exit 0");
        let started = core.out(&format!("{kind}-start"));
        assert!(started.contains("\"started\""), "{}", core.redact(&started));
        let seen = core.wait(&format!("{kind}.names"));
        assert!(seen.lines().any(|n| n == "NUNCHIRO_SESSION"), "{seen}");
        assert!(!seen.lines().any(|n| n == SECRET), "{seen}");
    }
    assert!(!core.home.join("tokens.json").exists());
    // Outside every session the same token is the owner's, with no token in the environment: the shell keeps the
    // owner's environment and his CLI makes the token (its secret on stdout is never read or printed here).
    let r = core.raw(&core.owner_token(), &start("owner"));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let seen = core.wait("owner.names");
    assert!(seen.lines().any(|n| n == SECRET), "{seen}");
    let made = home::git_env::scrubbed(cli())
        .args(["token", "create", "--scope", "read"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(made.success(), "the owner's own terminal was refused");
    assert!(core.home.join("tokens.json").exists());
}

/// A core started inside another core's session serves its own clients normally.
#[test]
fn owner_hardening_nested_core_treats_its_clients_normally() {
    let outer = Core::new();
    let inner = scratch("inner");
    outer.run_in(
        "shell",
        &format!(
            "probe inner env -u NUNCHIRO_TOKEN NUNCHIRO_HOME='{}' \"$CLI\" session list\n",
            inner.display()
        ),
    );
    let out = outer.out("inner");
    // Stop the inner core from outside before asserting, so a failure leaves nothing running.
    let stop = home::git_env::scrubbed(cli())
        .args(["serve", "stop", "--yes"])
        .env("NUNCHIRO_HOME", &inner)
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        out.contains("exit=0"),
        "{}",
        out.replace(
            fs::read_to_string(inner.join("core.token"))
                .unwrap_or_default()
                .trim(),
            "<inner token>"
        )
    );
    assert!(stop.status.success());
    let _ = fs::remove_dir_all(&inner);
}

/// `window.json` from an older version (with a token) is replaced by a port-only one at start.
#[test]
fn owner_hardening_old_window_json_is_overwritten() {
    let core = Core::new();
    let _ = core.raw(&core.owner_token(), r#"{"op":"stop"}"#);
    let until = Instant::now() + Duration::from_secs(5);
    while core.home.join("core.sock").exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    fs::write(
        core.home.join("window.json"),
        r#"{"port":1,"token":"old-token-from-an-earlier-version"}"#,
    )
    .unwrap();
    let again = home::git_env::scrubbed(cli())
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        again.status.success(),
        "{}",
        String::from_utf8_lossy(&again.stderr)
    );
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(core.home.join("window.json")).unwrap()).unwrap();
    assert!(file.get("token").is_none() && file["port"] != 1, "{file}");
    let mode = fs::metadata(core.home.join("window.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    let _ = core.raw(&core.owner_token(), r#"{"op":"stop"}"#);
}

/// `n` slow sockets that trickle a partial request and reopen as soon as they are closed, for at least
/// 10 s, while the owner connects and authenticates at least 20 times. Idle loopback sockets, no spinning.
fn refill(n: usize) {
    let core = Core::new();
    let (port, token) = core.window();
    let stop = Arc::new(AtomicBool::new(false));
    let reopened = Arc::new(AtomicUsize::new(0));
    let attackers: Vec<_> = (0..n)
        .map(|_| {
            let (stop, reopened) = (stop.clone(), reopened.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    reopened.fetch_add(1, Ordering::SeqCst);
                    let _ = s.write_all(b"GET /ws HTTP/1.1\r\n");
                    s.set_read_timeout(Some(Duration::from_millis(300)))
                        .unwrap();
                    let mut buf = [0u8; 64];
                    // Blocks until the core closes the socket; a byte now and then keeps it "slow".
                    while !stop.load(Ordering::SeqCst) {
                        match s.read(&mut buf) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(e)
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::TimedOut =>
                            {
                                if s.write_all(b"X").is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            })
        })
        .collect();
    thread::sleep(Duration::from_millis(500));
    let started = Instant::now();
    let mut times = vec![];
    while times.len() < 20 || started.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(400));
        let t = Instant::now();
        let ok = core.dial(ORIGIN, &format!("nunchiro.v1, nunchiro.token.{token}"));
        times.push(t.elapsed());
        assert_eq!(
            ok,
            Ok(()),
            "owner refused under refill (attempt {})",
            times.len()
        );
    }
    stop.store(true, Ordering::SeqCst);
    for a in attackers {
        a.join().unwrap();
    }
    times.sort();
    let (p50, max) = (times[times.len() / 2], *times.last().unwrap());
    println!(
        "refill {n}: {} owner attempts over {:?}, p50 {p50:?}, max {max:?}, {} attacker sockets opened",
        times.len(),
        started.elapsed(),
        reopened.load(Ordering::SeqCst)
    );
    assert!(max < Duration::from_secs(2), "owner waited {max:?}");
    assert!(
        reopened.load(Ordering::SeqCst) > n,
        "the sockets were never closed and reopened"
    );
}

// Socket flood with a latency bound: kept out of the merge gate (V1A-17; host load rule). Run with
// `cargo test -p nunchiro-core --test owner_hardening refill -- --ignored` when the 1-minute load is below 15.
#[test]
#[ignore = "socket flood; run explicitly when host load is below 15"]
fn owner_hardening_handshake_refill_16() {
    refill(16);
}

// Socket flood with a latency bound: kept out of the merge gate (V1A-17; host load rule). Run with
// `cargo test -p nunchiro-core --test owner_hardening refill -- --ignored` when the 1-minute load is below 15.
#[test]
#[ignore = "socket flood; run explicitly when host load is below 15"]
fn owner_hardening_handshake_refill_40() {
    refill(40);
}

/// The window token never leaves this machine: `window_auth` wrapped for a remote machine is refused locally.
#[test]
fn owner_hardening_remote_window_auth_is_refused() {
    let core = Core::new();
    let r = core.raw(
        &core.owner_token(),
        r#"{"op":"remote","machine":"nunchiro-test-none","request":{"op":"window_auth"}}"#,
    );
    assert_eq!(
        r["Err"], "operation is local owner-only; remote forwarding is not permitted",
        "{r}"
    );
}

/// v1a-23 (needs 47, OWNERC = D'): a plain shell inside a session runs `serve restart`, which stops the core (and
/// with it this session) and starts a new one. The new core is stopped before the test ends.
#[test]
fn session_shell_runs_serve_restart() {
    let mut core = Core::new();
    let old = core.owner_token();
    let script = core.home.join("restart.sh");
    fs::write(
        &script,
        format!(
            "'{}' serve restart > \"$NUNCHIRO_HOME/restart.out\" 2>&1 < /dev/null\nexec sleep 60\n",
            cli().display()
        ),
    )
    .unwrap();
    core.start("shell", serde_json::json!(["/bin/sh", script]));
    let until = Instant::now() + Duration::from_secs(20);
    while core.owner_token() == old || !core.alive() {
        assert!(
            Instant::now() < until,
            "no new core: {}",
            core.redact(&fs::read_to_string(core.home.join("restart.out")).unwrap_or_default())
        );
        thread::sleep(Duration::from_millis(50));
    }
    let until = Instant::now() + Duration::from_secs(10);
    while core.process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "the old core is still running");
        thread::sleep(Duration::from_millis(50));
    }
    // Stop the new core (not this test's child) and wait for its socket to go.
    let _ = core.raw(&core.owner_token(), r#"{"op":"stop"}"#);
    let until = Instant::now() + Duration::from_secs(10);
    while core.home.join("core.sock").exists() {
        assert!(Instant::now() < until, "the new core did not stop");
        thread::sleep(Duration::from_millis(50));
    }
}

/// v1a-23 r2 (S3): `serve restart` from a session starts the new core from the old core's recorded start environment
/// and executable, not the asker's: a variable set only in the asking shell reaches neither the new core nor a session
/// started after the restart.
#[test]
fn session_restart_starts_the_new_core_from_the_old_cores_environment() {
    let core = Core::new();
    let old = core.owner_token();
    let script = core.home.join("restart.sh");
    fs::write(
        &script,
        format!(
            "export ASKER_ONLY=leak DYLD_FALLBACK_LIBRARY_PATH=/nonexistent-v1a23\n'{}' serve restart > \"$NUNCHIRO_HOME/restart.out\" 2>&1 < /dev/null\nexec sleep 60\n",
            cli().display()
        ),
    )
    .unwrap();
    core.start("shell", serde_json::json!(["/bin/sh", script]));
    let until = Instant::now() + Duration::from_secs(20);
    while core.owner_token() == old || !core.alive() {
        assert!(Instant::now() < until, "no new core");
        thread::sleep(Duration::from_millis(50));
    }
    // What the new core recorded about itself at start: its environment and executable.
    let started: serde_json::Value =
        serde_json::from_slice(&fs::read(core.home.join("core.start.json")).unwrap()).unwrap();
    let env = started["env"].as_object().expect("recorded env");
    assert!(
        env.get("ASKER_ONLY").is_none(),
        "the asker's variable reached the new core"
    );
    assert!(
        env.keys().all(|k| !k.starts_with("DYLD_")),
        "{:?}",
        env.keys()
    );
    assert_eq!(
        env.get("NUNCHIRO_SSH").and_then(|v| v.as_str()),
        Some("/usr/bin/false")
    );
    assert_eq!(
        PathBuf::from(started["exe"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        cli().canonicalize().unwrap()
    );
    // A session started after the restart sees the old core's environment, not the asker's.
    core.start(
        "shell",
        serde_json::json!([
            "/bin/sh",
            "-c",
            "echo \"A=${ASKER_ONLY:-none}\" > \"$NUNCHIRO_HOME/after.out\"; exec sleep 60"
        ]),
    );
    assert_eq!(core.wait("after.out").trim(), "A=none");
    let _ = core.raw(&core.owner_token(), r#"{"op":"stop"}"#);
    let until = Instant::now() + Duration::from_secs(10);
    while core.home.join("core.sock").exists() {
        assert!(Instant::now() < until, "the new core did not stop");
        thread::sleep(Duration::from_millis(50));
    }
}

/// v1a-30 (V1A-23 SHOULD-1): when the recorded executable is gone (an upgrade moved or rebuilt it), the restart swaps
/// only the executable for the asking binary and keeps the recorded environment, not the asker's.
#[test]
fn session_restart_with_a_gone_recorded_executable_keeps_the_recorded_environment() {
    let core = Core::new();
    let old = core.owner_token();
    let record = core.home.join("core.start.json");
    let mut started: serde_json::Value =
        serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    started["exe"] = serde_json::json!(core.home.join("gone/nunchiro"));
    fs::write(&record, serde_json::to_vec(&started).unwrap()).unwrap();
    let script = core.home.join("restart.sh");
    fs::write(
        &script,
        format!(
            "export ASKER_ONLY=leak\n'{}' serve restart > \"$NUNCHIRO_HOME/restart.out\" 2>&1 < /dev/null\nexec sleep 60\n",
            cli().display()
        ),
    )
    .unwrap();
    core.start("shell", serde_json::json!(["/bin/sh", script]));
    let until = Instant::now() + Duration::from_secs(20);
    while core.owner_token() == old || !core.alive() {
        assert!(Instant::now() < until, "no new core");
        thread::sleep(Duration::from_millis(50));
    }
    let started: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    let env = started["env"].as_object().expect("recorded env");
    assert!(
        env.get("ASKER_ONLY").is_none(),
        "the asker's variable reached the new core"
    );
    assert_eq!(
        env.get("NUNCHIRO_SSH").and_then(|v| v.as_str()),
        Some("/usr/bin/false")
    );
    assert_eq!(
        PathBuf::from(started["exe"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        cli().canonicalize().unwrap()
    );
    let _ = core.raw(&core.owner_token(), r#"{"op":"stop"}"#);
    let until = Instant::now() + Duration::from_secs(10);
    while core.home.join("core.sock").exists() {
        assert!(Instant::now() < until, "the new core did not stop");
        thread::sleep(Duration::from_millis(50));
    }
}
