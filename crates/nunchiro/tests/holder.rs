//! V2-1a: per-session PTY holders as the shipped binary runs them (`nunchiro serve` starts `nunchiro hold`).
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use home::git_env;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        // Under the system temp dir, not the checkout: core.sock must fit macOS's socket path limit from any clone.
        let home = home::short("hold");
        // V2-1a r2: the Codex fixture with an input box, first on PATH.
        let codex = home.join("codex");
        fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex-picker"),
            &codex,
        )
        .unwrap();
        fs::set_permissions(&codex, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let core = serve(&home);
        let h = Self { home, core };
        wait("core start", || call(&h.home, Request::Snapshot).is_ok());
        h
    }
    /// V2-1b: `kill -9` of the core, then a new one; returns how long the new core took to answer with every listed
    /// session running again.
    fn crash_and_restart(&mut self, running: &[&str]) -> Duration {
        self.core.kill().unwrap();
        let _ = self.core.wait();
        let started = Instant::now();
        self.core = serve(&self.home);
        wait("sessions reattached", || {
            call(&self.home, Request::Snapshot).is_ok_and(|r| match r {
                Reply::Snapshot { sessions, .. } => running.iter().all(|id| {
                    sessions
                        .iter()
                        .any(|s| s.id == *id && s.state == SessionState::Running)
                }),
                _ => false,
            })
        });
        started.elapsed()
    }
    fn start(&self, args: &[&str]) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.clone(),
                    worktree: false,
                    label: "fixture".into(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            r => panic!("wrong reply {r:?}"),
        }
    }
    fn read(&self, id: &str) -> String {
        match call(
            &self.home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        )
        .unwrap()
        {
            Reply::Output { data, .. } => String::from_utf8_lossy(&data).into(),
            r => panic!("wrong reply {r:?}"),
        }
    }
    fn wait_text(&self, id: &str, text: &str) -> String {
        let mut out = String::new();
        wait(text, || {
            out = self.read(id);
            out.contains(text)
        });
        out
    }
    fn store(&self) -> Value {
        serde_json::from_slice(&fs::read(self.home.join("sessions.json")).unwrap()).unwrap()
    }
    fn holder(&self, id: &str) -> Value {
        self.store()["live"][id]["holder"].clone()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let until = Instant::now() + Duration::from_secs(10);
        while self.core.try_wait().ok().flatten().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn serve(home: &std::path::Path) -> Child {
    serve_from(env!("CARGO_BIN_EXE_nunchiro").as_ref(), home)
}
fn serve_from(exe: &std::path::Path, home: &std::path::Path) -> Child {
    cli(exe, home).arg("serve").spawn().unwrap()
}
/// The CLI at `exe` with the core's environment: the fixtures first on PATH, no session token.
fn cli(exe: &std::path::Path, home: &std::path::Path) -> Command {
    let mut cmd = git_env::scrubbed(exe);
    cmd.env("NUNCHIRO_HOME", home)
        .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
        .env("CODEX_HOME", home.join("codex-home"))
        .env_remove("NUNCHIRO_TOKEN");
    cmd
}
fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !ok() {
        assert!(Instant::now() < until, "timed out: {what}");
        thread::sleep(Duration::from_millis(20));
    }
}
/// A live, non-zombie process.
fn running(pid: u32) -> bool {
    let out = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}
fn ps(pid: u32, field: &str) -> u32 {
    let out = Command::new("/bin/ps")
        .args(["-o", field, "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}
fn ppid(pid: u32) -> u32 {
    ps(pid, "ppid=")
}
fn sha256(text: &str) -> String {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            c.stdin.take().unwrap().write_all(text.as_bytes())?;
            c.wait_with_output()
        })
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .into()
}

#[test]
fn core_exit_still_stops_agents() {
    // A full quit ends the holder and its agent with the core; V2-1b (needs 76): a crash leaves both running.
    for crash in [false, true] {
        let mut h = Harness::new();
        let s = h.start(&["/bin/sh", "-c", "printf 'up\\n'; exec /bin/sleep 300"]);
        h.wait_text(&s.id, "up");
        let agent = s.pid.unwrap();
        let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
        let socket = PathBuf::from(h.holder(&s.id)["socket"].as_str().unwrap());
        assert!(socket.exists());
        // The agent is the holder's child, and the holder is a process of its own, outside the core's group.
        assert_eq!(ppid(agent), holder);
        assert_ne!(holder, h.core.id());
        assert_ne!(ps(holder, "pgid="), ps(h.core.id(), "pgid="));
        assert!(running(holder) && running(agent));
        if crash {
            h.core.kill().unwrap();
        } else {
            call(&h.home, Request::Stop).unwrap();
        }
        let _ = h.core.wait();
        if crash {
            thread::sleep(Duration::from_millis(500));
            assert!(running(holder) && running(agent), "they outlive the core");
            assert!(socket.exists());
            h.crash_and_restart(&[&s.id]);
            call(&h.home, Request::Stop).unwrap();
            let _ = h.core.wait();
        }
        wait("holder and agent end", || {
            !running(holder) && !running(agent)
        });
        assert!(!socket.exists(), "the holder removed its socket");
    }
}

#[test]
fn inside_peer_via_holder() {
    let h = Harness::new();
    // From inside a holder-backed session, the window token request goes out with the core token, as an agent that
    // read the file would send it: the core still names the session as the caller and refuses it.
    let out = h.home.join("inside.out");
    let script = r#"printf '{"token":"%s","request":{"op":"window_auth"}}\n' "$(cat "$NUNCHIRO_HOME/core.token")" | /usr/bin/nc -U "$NUNCHIRO_HOME/core.sock" > "$1.tmp"; mv "$1.tmp" "$1"; exec sleep 30"#;
    let s = h.start(&["/bin/sh", "-c", script, "inside", out.to_str().unwrap()]);
    wait("inside reply", || out.exists());
    let inside: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
    // Refused as the session's caller, not by a failed peer check ("owner peer check failed; ...").
    assert_eq!(inside["Err"], "operation not granted", "{inside}");
    assert_eq!(
        ppid(s.pid.unwrap()),
        h.holder(&s.id)["pid"].as_u64().unwrap() as u32
    );
    // The same request from outside every session is the owner's.
    let token = fs::read_to_string(h.home.join("core.token")).unwrap();
    let mut owner = UnixStream::connect(h.home.join("core.sock")).unwrap();
    writeln!(
        owner,
        "{}",
        json!({"token": token, "request": {"op":"window_auth"}})
    )
    .unwrap();
    let mut reply = String::new();
    owner.read_to_string(&mut reply).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert!(reply.get("Ok").is_some(), "{reply}");
}

#[test]
fn holder_refuses_inside_peer() {
    let h = Harness::new();
    let b = h.start(&["/bin/cat"]);
    let socket = h.holder(&b.id)["socket"].as_str().unwrap().to_string();
    // An agent in session A connects to holder B's socket: refused before a byte is sent.
    let script = r#"n=$(/usr/bin/nc -U "$1" < /dev/null | wc -c | tr -d ' '); printf 'GOT:%s:\n' "$n"; exec sleep 30"#;
    let a = h.start(&["/bin/sh", "-c", script, "inside", &socket]);
    h.wait_text(&a.id, "GOT:0:");
    let log = fs::read_to_string(h.home.join("logs/sessions").join(format!("{}.log", b.id)))
        .unwrap_or_default();
    assert!(
        log.contains(&format!("inside session {}", a.pid.unwrap())),
        "{log}"
    );
    // A peer outside every session gets the hello, then is turned away: B already has its core.
    let mut outside = UnixStream::connect(&socket).unwrap();
    outside
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut hello = [0; 12];
    outside.read_exact(&mut hello).unwrap();
    assert_eq!(&hello[..8], b"NUNHOLD\0");
    outside.write_all(&hello).unwrap();
    let mut rest = vec![];
    outside.read_to_end(&mut rest).unwrap();
    assert!(
        String::from_utf8_lossy(&rest).contains("already has its core"),
        "{rest:?}"
    );
    // B still serves its core.
    call(
        &h.home,
        Request::SendText {
            id: b.id.clone(),
            text: "still here\n".into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
    h.wait_text(&b.id, "still here");
}

#[test]
fn token_hash_visible_to_the_agent() {
    let h = Harness::new();
    // The agent's first act: is the hash of its own token already in sessions.json?
    let script = r#"t=$(printf %s "$NUNCHIRO_TOKEN" | /usr/bin/shasum -a 256 | cut -c1-64); if grep -q "\"$t\"" "$NUNCHIRO_HOME/sessions.json"; then printf 'HASH:yes\n'; else printf 'HASH:no\n'; fi; exec sleep 30"#;
    let s = h.start(&["/bin/sh", "-c", script]);
    let out = h.wait_text(&s.id, "HASH:");
    assert!(out.contains("HASH:yes"), "{out}");
    let store = h.store();
    assert_eq!(store["version"], 2);
    assert_eq!(
        store["live"][&s.id]["token_sha256"].as_str().unwrap().len(),
        64
    );
}

#[test]
fn token_hash_deleted_on_close() {
    let h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'TOKEN:%s:\\n' \"$NUNCHIRO_TOKEN\"; exec sleep 30",
    ]);
    let out = h.wait_text(&s.id, ":\r\n");
    let token = out
        .split("TOKEN:")
        .nth(1)
        .unwrap()
        .split(':')
        .next()
        .unwrap();
    let hash = sha256(token);
    let bytes = fs::read_to_string(h.home.join("sessions.json")).unwrap();
    assert!(bytes.contains(&hash));
    assert!(!bytes.contains(token), "the token itself is never stored");
    call(&h.home, Request::Close { id: s.id.clone() }).unwrap();
    let bytes = fs::read_to_string(h.home.join("sessions.json")).unwrap();
    assert!(!bytes.contains(&hash), "{bytes}");
    assert!(h.store()["live"].get(&s.id).is_none());
}

impl Harness {
    fn codex(&self) -> Session {
        let s = match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: codex_start(&self.home, None),
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            r => panic!("wrong reply {r:?}"),
        };
        self.codex_ready(&s.id)
    }
    /// Ticket 286 r6: a Codex worker started by the session holding `token` (its record's `parent`).
    fn codex_worker(&self, token: &str) -> Session {
        let start = json!({"op":"start","session":codex_start(&self.home, None)});
        let reply = raw(self, token, start);
        self.codex_ready(
            reply["Ok"]["session"]["id"]
                .as_str()
                .unwrap_or_else(|| panic!("{reply}")),
        )
    }
    fn codex_ready(&self, id: &str) -> Session {
        self.wait_text(id, "gpt-fixture");
        wait("the Codex conversation id", || {
            self.session(id).agent_session_id.is_some()
        });
        self.session(id)
    }
    fn session(&self, id: &str) -> Session {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|x| x.id == id).unwrap(),
            r => panic!("wrong reply {r:?}"),
        }
    }
    /// Resuming the conversation `conversation` in a new session.
    fn resume(&self, conversation: &str) -> Result<Reply, String> {
        call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: codex_start(&self.home, Some(conversation.into())),
            },
        )
    }
    /// Processes of this harness running `codex resume <conversation>`: a second agent on the conversation.
    fn resumed(&self, conversation: &str) -> usize {
        let home = self.home.to_string_lossy();
        let ps = Command::new("/bin/ps")
            .args(["-A", "-o", "args="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&ps.stdout)
            .lines()
            // The test's shell wrapper carries the same arguments as the agent it runs.
            // The fixture conversation id is shared by every checkout's gate on the host: count only this home's.
            .filter(|l| {
                l.contains(&format!("resume {conversation}"))
                    && l.contains(home.as_ref())
                    && !l.starts_with("/bin/sh")
            })
            .count()
    }
}
fn codex_start(home: &std::path::Path, resume: Option<String>) -> StartSession {
    StartSession {
        account: None,
        kind: AgentKind::Codex,
        project: home.to_path_buf(),
        worktree: false,
        label: String::new(),
        args: vec![],
        model: Some("gpt-6-luna".into()),
        effort: Some("medium".into()),
        resume,
    }
}
/// Resumes a SIGSTOPped holder however the test ends, so no stopped holder or Codex stays on the host.
struct Resume(u32);
impl Resume {
    fn stop(pid: u32) -> Self {
        assert!(
            Command::new("/bin/kill")
                .args(["-STOP", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        );
        Self(pid)
    }
}
impl Drop for Resume {
    fn drop(&mut self) {
        let _ = Command::new("/bin/kill")
            .args(["-CONT", &self.0.to_string()])
            .status();
    }
}

// V2-1a r3: a holder that stops answering (SIGSTOP) costs the core one request bound, and while its agent lives the
// session stays running: no resume, no close by a session, no second Codex on the conversation; when the holder runs
// again the session answers. V2-1b (carried review item): the owner's close ends such an agent itself.
#[test]
fn a_silent_holder_keeps_a_live_agent_running() {
    let h = Harness::new();
    // V2-1b: closes below come from another session (an agent could stop its own holder to keep closes failing).
    let other = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let other_token = token(&h.wait_text(&other.id, "tok:"));
    let s = h.codex();
    let conversation = s.agent_session_id.clone().unwrap();
    let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
    let agent = s.pid.unwrap();
    let resume = Resume::stop(holder);
    let asked = Instant::now();
    let state = h.session(&s.id).state;
    let took = asked.elapsed();
    let resumed = h.resume(&conversation);
    let closes = [
        as_agent(
            &h,
            &other.id,
            &other_token,
            &["session", "close", &s.id],
            "",
        ),
        as_agent(
            &h,
            &other.id,
            &other_token,
            &["session", "close", &s.id],
            "",
        ),
    ];
    // A closed session leaves the snapshot.
    let later = match call(&h.home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => {
            sessions.into_iter().find(|x| x.id == s.id).map(|x| x.state)
        }
        r => panic!("wrong reply {r:?}"),
    };
    let second = h.resumed(&conversation);
    drop(resume);
    assert!(took < Duration::from_secs(5), "refresh took {took:?}");
    assert_eq!(state, SessionState::Running);
    assert_eq!(resumed.unwrap_err(), "conversation is already running");
    for close in &closes {
        assert!(!close, "a session's close was taken");
    }
    assert_eq!(later, Some(SessionState::Running));
    assert!(running(agent));
    assert_eq!(second, 0, "a second Codex started on the conversation");
    // The holder runs again: the same session answers.
    call(
        &h.home,
        Request::SendText {
            id: s.id.clone(),
            text: "again\n".into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
    h.wait_text(&s.id, "ACK:again");
    assert_eq!(h.session(&s.id).state, SessionState::Running);
    // V2-1b: silent again, the owner's close ends the recorded agent (and its holder); never a second Codex.
    let resume = Resume::stop(holder);
    call(&h.home, Request::Close { id: s.id.clone() }).unwrap();
    drop(resume);
    assert!(!running(agent));
    wait("the holder ends", || !running(holder));
    assert_eq!(h.resumed(&conversation), 0);
}

// V1A-72: a Close the silent holder refuses changes nothing: the pending decision stays actionable and unreconciled;
// once the holder answers, the same Close succeeds and then reconciles it.
#[test]
fn a_refused_close_leaves_the_queue_untouched() {
    let h = Harness::new();
    // V2-1b: the owner's Close ends a silent holder's agent itself; a session's Close is the one still refused.
    let other = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let other_token = token(&h.wait_text(&other.id, "tok:"));
    // Ticket 286 r6: `other` started it, so its Close passes the caller check and reaches the holder.
    let s = h.codex_worker(&other_token);
    let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
    // The decision is raised the way a Codex hook does: a PermissionRequest through the core.
    call(
        &h.home,
        Request::Hook {
            id: s.id.clone(),
            event: "PermissionRequest".into(),
            payload: json!({"tool_name":"Bash","tool_input":{"command":"true"}}),
        },
    )
    .unwrap();
    // The item as the queue file holds it: (actionable, reconciled).
    let item = || {
        let queue: Value =
            serde_json::from_slice(&fs::read(h.home.join("queue.json")).unwrap()).unwrap();
        let items = queue["sessions"][&s.id]["items"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(items.len(), 1, "{items:?}");
        (
            items[0]["actionable"].as_bool().unwrap(),
            items[0]["reconciled"].as_bool().unwrap(),
        )
    };
    assert_eq!(item(), (true, false));
    assert_eq!(h.session(&s.id).pending.len(), 1);
    let resume = Resume::stop(holder);
    let refusal = as_agent_out(
        &h,
        &other.id,
        &other_token,
        &["session", "close", &s.id],
        "",
    );
    let refused = !refusal.status.success();
    let (during, pending) = (item(), h.session(&s.id).pending.len());
    drop(resume);
    assert!(refused, "a session's Close of a silent holder was taken");
    // Refused for the stop, not for the caller: the same token still works.
    let why = String::from_utf8_lossy(&refusal.stderr);
    assert!(
        why.contains("did not answer") && why.contains("the agent still runs"),
        "{why}"
    );
    assert!(as_agent(
        &h,
        &other.id,
        &other_token,
        &["session", "list"],
        ""
    ));
    assert_eq!(during, (true, false), "a refused Close touched the queue");
    assert_eq!(pending, 1);
    // The holder answers again and the Close goes through: only Close sets Closed (a stop alone leaves it Exited).
    call(&h.home, Request::Close { id: s.id.clone() }).unwrap();
    assert_eq!(item(), (false, true));
    assert_eq!(h.session(&s.id).state, SessionState::Closed);
}

// V1A-79 (V1A-68, V1A-72): a Close a silent holder refuses leaves a shell as it was: running, the same replay, its
// scrollback file untouched; once the holder answers the Close succeeds, the replay stays readable from memory and
// the Close creates no scrollback file.
#[test]
fn a_refused_close_of_a_shell_leaves_its_scrollback_alone() {
    let h = Harness::new();
    let other = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let other_token = token(&h.wait_text(&other.id, "tok:"));
    // Ticket 286 r6: `other` started it, so its Close passes the caller check and reaches the holder.
    let started = raw(
        &h,
        &other_token,
        json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c","printf 'replay-text\\n'; exec /bin/cat"]}}),
    );
    let s = h.session(
        started["Ok"]["session"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("{started}")),
    );
    let replay = h.wait_text(&s.id, "replay-text");
    let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
    let file = h.home.join("scrollback").join(&s.id);
    let before = fs::read(&file).ok();
    let resume = Resume::stop(holder);
    let refusal = as_agent_out(
        &h,
        &other.id,
        &other_token,
        &["session", "close", &s.id],
        "",
    );
    let (running, after) = (h.session(&s.id).state, fs::read(&file).ok());
    let same = h.read(&s.id);
    drop(resume);
    assert!(
        !refusal.status.success(),
        "a session's Close of a silent holder was taken"
    );
    assert!(
        String::from_utf8_lossy(&refusal.stderr).contains("did not answer"),
        "{}",
        String::from_utf8_lossy(&refusal.stderr)
    );
    assert_eq!(running, SessionState::Running);
    assert_eq!(same, replay, "the replay changed");
    assert_eq!(after, before, "a refused Close touched the scrollback file");
    call(&h.home, Request::Close { id: s.id.clone() }).unwrap();
    assert_eq!(h.session(&s.id).state, SessionState::Closed);
    assert!(
        h.read(&s.id).contains("replay-text"),
        "the replay is kept in memory"
    );
    assert_eq!(
        fs::read(&file).ok(),
        None,
        "Close writes no scrollback file for a shell"
    );
}

// V2-1b r6 (V1A-72 rule, owner path): a full quit whose stop a silent holder refuses leaves the queue untouched.
#[test]
fn a_failed_owner_stop_leaves_the_queue_untouched() {
    let h = Harness::new();
    let s = h.codex();
    let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
    call(
        &h.home,
        Request::Hook {
            id: s.id.clone(),
            event: "PermissionRequest".into(),
            payload: json!({"tool_name":"Bash","tool_input":{"command":"true"}}),
        },
    )
    .unwrap();
    let item = || {
        let queue: Value =
            serde_json::from_slice(&fs::read(h.home.join("queue.json")).unwrap()).unwrap();
        let items = queue["sessions"][&s.id]["items"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(items.len(), 1, "{items:?}");
        (
            items[0]["actionable"].as_bool().unwrap(),
            items[0]["reconciled"].as_bool().unwrap(),
        )
    };
    assert_eq!(item(), (true, false));
    let resume = Resume::stop(holder);
    // A core tick finds the holder silent first, so the stop's request is answered at once.
    thread::sleep(Duration::from_millis(2500));
    let stopped = call(&h.home, Request::Stop);
    let during = item();
    drop(resume);
    assert!(stopped.is_err(), "{stopped:?}");
    assert_eq!(during, (true, false), "a refused stop touched the queue");
    assert_eq!(h.session(&s.id).state, SessionState::Running);
}

// V1A-87: the scan counts only this harness's own agents; another checkout's gate on the same host runs the same
// fixture conversation id, so a host-wide match is not evidence of a second agent here.
#[test]
fn resumed_ignores_another_checkouts_agent_on_the_same_conversation() {
    let h = Harness::new();
    let mut other = Command::new("/usr/bin/python3")
        .args([
            "-c",
            "import time; time.sleep(30)",
            "resume",
            "FAKE-CODEX-123",
        ])
        .spawn()
        .unwrap();
    let seen = Command::new("/bin/ps")
        .args(["-o", "args=", "-p", &other.id().to_string()])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&seen.stdout).contains("resume FAKE-CODEX-123"));
    let count = h.resumed("FAKE-CODEX-123");
    other.kill().unwrap();
    other.wait().unwrap();
    assert_eq!(count, 0);
}

// V2-1a r3: a holder that dies while its agent lives (the agent ignores the hangup): the core ends the agent's group
// as the holder would, and at no point do two agents run on the conversation.
#[test]
fn a_gone_holder_never_lets_a_second_agent_start() {
    let h = Harness::new();
    // The fixture under a leader that ignores SIGHUP and outlives it.
    let real = h.home.join("codex-real");
    fs::rename(h.home.join("codex"), &real).unwrap();
    fs::write(
        h.home.join("codex"),
        format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && exec {real} \"$@\"\ntrap '' HUP\n{real} \"$@\"\nexec /bin/sleep 300\n",
            real = real.display()
        ),
    )
    .unwrap();
    fs::set_permissions(
        h.home.join("codex"),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let s = h.codex();
    let conversation = s.agent_session_id.clone().unwrap();
    let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
    let agent = s.pid.unwrap();
    assert!(
        Command::new("/bin/kill")
            .args(["-KILL", &holder.to_string()])
            .status()
            .unwrap()
            .success()
    );
    // The leader ignores the hangup and would sleep 300 s: it ends only because the core (its next tick, or the
    // request below) killed its group as the holder would have.
    wait("the core ends the orphaned agent", || !running(agent));
    let switched = call(
        &h.home,
        Request::SwitchModel {
            id: s.id.clone(),
            model: Some("gpt-5.6-luna".into()),
            effort: None,
            fast: None,
            ultracode: None,
        },
    );
    // The session ended with its agent, so nothing is restarted in its place.
    assert_eq!(switched.unwrap_err(), "agent is not running");
    assert_eq!(h.resumed(&conversation), 0);
    // The conversation is free again only now that its agent has ended: one agent on it.
    assert!(h.resume(&conversation).is_ok());
    wait("the resumed agent", || h.resumed(&conversation) >= 1);
    assert_eq!(h.resumed(&conversation), 1);
}

// V2-1a r3: the hello has one deadline, so a peer trickling bytes is cut within it, not after a timeout per byte.
#[test]
fn a_trickling_peer_is_cut_at_the_hello_deadline() {
    let h = Harness::new();
    let s = h.start(&["/bin/cat"]);
    let socket = h.holder(&s.id)["socket"].as_str().unwrap().to_string();
    let mut peer = UnixStream::connect(&socket).unwrap();
    let mut hello = [0; 12];
    peer.read_exact(&mut hello).unwrap();
    let began = Instant::now();
    for byte in b"NUNHOLD\0\0\x01\0" {
        if peer.write_all(&[*byte]).is_err() {
            break;
        }
        thread::sleep(Duration::from_millis(700));
        if began.elapsed() > Duration::from_secs(5) {
            break;
        }
    }
    // A socket the holder closed may refuse a timeout (EINVAL), which is fine.
    let _ = peer.set_read_timeout(Some(Duration::from_secs(1)));
    let mut rest = vec![];
    let read = peer.read_to_end(&mut rest);
    assert!(rest.is_empty(), "{rest:?}");
    // Cut at the 2 s deadline: the writes after it fail or go unread; at most 4 s with the 700 ms steps.
    assert!(began.elapsed() < Duration::from_secs(7));
    // Closed by the holder, not left waiting (a still-open socket would time out here).
    assert!(
        read.as_ref()
            .map_or_else(|e| e.kind() != std::io::ErrorKind::WouldBlock, |_| true),
        "the holder closed the trickling peer: {read:?}"
    );
}

// V2-1a r2: a peer that connects and says nothing holds nothing up: the next peer gets its hello at once.
#[test]
fn a_silent_peer_does_not_hold_up_the_holder() {
    let h = Harness::new();
    let s = h.start(&["/bin/cat"]);
    let socket = h.holder(&s.id)["socket"].as_str().unwrap().to_string();
    let _silent = UnixStream::connect(&socket).unwrap();
    let mut next = UnixStream::connect(&socket).unwrap();
    next.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut hello = [0; 12];
    next.read_exact(&mut hello).unwrap();
    assert_eq!(&hello[..8], b"NUNHOLD\0");
    // A second session starts meanwhile.
    let t = h.start(&["/bin/sh", "-c", "printf 'second\\n'; exec sleep 30"]);
    h.wait_text(&t.id, "second");
}

// V2-1b: the session token as its agent printed it (test fixture only).
fn token(out: &str) -> String {
    out.split("tok:")
        .nth(1)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .to_string()
}
/// `nunchiro <args>` as the agent of `id` would run it (its token and session), from outside every session: whether
/// the core took it (the hook command exits 0 either way, so the agent is never blocked; it reports on stderr).
fn as_agent(h: &Harness, id: &str, token: &str, args: &[&str], stdin: &str) -> bool {
    let out = as_agent_out(h, id, token, args, stdin);
    out.status.success() && out.stderr.is_empty()
}
fn as_agent_out(
    h: &Harness,
    id: &str,
    token: &str,
    args: &[&str],
    stdin: &str,
) -> std::process::Output {
    let mut child = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(args)
        .env("NUNCHIRO_HOME", &h.home)
        .env("NUNCHIRO_TOKEN", token)
        .env("NUNCHIRO_SESSION", id)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
fn pending(h: &Harness) -> usize {
    match call(&h.home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.iter().map(|s| s.pending.len()).sum(),
        r => panic!("wrong reply {r:?}"),
    }
}

/// V2-1b: how soon a new core has its sessions back, and how many of 30 rounds may miss it (a loaded host's stall).
const REATTACH: Duration = Duration::from_secs(2);
const SLOW_ROUNDS: usize = 3;

// V2-1b acceptance `core_kill9_30x_reattach`, with shell agents (the real-agent run is scripts/scenario/reattach.sh):
// 3 agents and one pending permission, 30 core kills. Every agent keeps its pid, sessions are back within 2 s of the
// new core's start, scrollback is intact, the waiting count is 1 whenever a core answers and the item stays restored
// (never answerable), the agent's CLI call and hook post work after each restart and fail after the session closes.
#[test]
fn core_kill9_reattach_30x() {
    let mut h = Harness::new();
    let printer = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let out = h.wait_text(&printer.id, "tok:");
    let tok = token(&out);
    let quiet = h.start(&["/bin/sh", "-c", "printf 'quiet up\\n'; exec /bin/sleep 600"]);
    let asking = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'asking up\\n'; exec /bin/sleep 600",
    ]);
    h.wait_text(&quiet.id, "quiet up");
    h.wait_text(&asking.id, "asking up");
    call(
        &h.home,
        Request::Hook {
            id: asking.id.clone(),
            event: "PermissionRequest".into(),
            payload: json!({"tool_name": "Bash", "tool_input": {"command": "echo A"}, "nunchiro_event_id": "a"}),
        },
    )
    .unwrap();
    assert_eq!(pending(&h), 1);
    let ids = [printer.id.as_str(), quiet.id.as_str(), asking.id.as_str()];
    let pids: Vec<u32> = [&printer, &quiet, &asking]
        .iter()
        .map(|s| s.pid.unwrap())
        .collect();
    let mut slow = vec![];
    for round in 0..30 {
        let took = h.crash_and_restart(&ids);
        if took >= REATTACH {
            slow.push(took);
        }
        match call(&h.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => {
                for (id, pid) in ids.iter().zip(&pids) {
                    let s = sessions.iter().find(|s| s.id == *id).unwrap();
                    assert_eq!(s.pid, Some(*pid), "round {round}: same agent");
                }
                let items: Vec<_> = sessions.iter().flat_map(|s| &s.pending).collect();
                assert_eq!(items.len(), 1, "round {round}: waiting count 1");
                assert!(
                    !items[0].actionable && items[0].reconciled,
                    "round {round}: restored, checking"
                );
            }
            r => panic!("wrong reply {r:?}"),
        }
        assert!(
            h.read(&printer.id).contains(&format!("tok:{tok}")),
            "round {round}: scrollback"
        );
        assert!(
            as_agent(&h, &printer.id, &tok, &["session", "list"], ""),
            "round {round}: agent CLI"
        );
        assert!(
            as_agent(&h, &printer.id, &tok, &["hook", "Notification"], "{}"),
            "round {round}: hook post"
        );
    }
    // W27: counted, not the slowest of 30. A delay in the reattach itself (an attach that waits out its bound, a holder
    // that keeps its old core) comes back every round, while a stall of the loaded host lands in one: 3.7 s once beside
    // other builds, where rounds take 30 to 300 ms here beside CPU and disk load. Each round still has to come back
    // (`wait`, 15 s).
    assert!(
        slow.len() <= SLOW_ROUNDS,
        "{} of 30 reattaches took {REATTACH:?} or more: {slow:?}",
        slow.len()
    );
    for pid in &pids {
        assert!(running(*pid));
    }
    // Typing still reaches the reattached agent.
    call(
        &h.home,
        Request::SendText {
            id: printer.id.clone(),
            text: "still here\r".into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
    h.wait_text(&printer.id, "still here");
    call(
        &h.home,
        Request::Close {
            id: printer.id.clone(),
        },
    )
    .unwrap();
    assert!(
        !as_agent(&h, &printer.id, &tok, &["session", "list"], ""),
        "revoked after close"
    );
    assert!(
        !as_agent(&h, &printer.id, &tok, &["hook", "Notification"], "{}"),
        "revoked after close"
    );
}

// V2-1b acceptance `serve_restart_new_build` (binary level): a newer build installed over the core's executable and
// `nunchiro serve restart`: the same agent pids, session ids and agent tokens.
#[test]
fn serve_restart_new_build() {
    let mut h = Harness::new();
    // The core runs from an installed copy, which the "update" then replaces (a new file at the same path).
    let installed = h.home.join("bin/nunchiro");
    fs::create_dir_all(installed.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), &installed).unwrap();
    call(&h.home, Request::Stop).unwrap();
    let _ = h.core.wait();
    h.core = git_env::scrubbed(&installed)
        .arg("serve")
        .env("NUNCHIRO_HOME", &h.home)
        .env("PATH", format!("{}:/usr/bin:/bin", h.home.display()))
        .env_remove("NUNCHIRO_TOKEN")
        .spawn()
        .unwrap();
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let tok = token(&h.wait_text(&s.id, "tok:"));
    let agent = s.pid.unwrap();
    let old_core = h.core.id();
    let fresh = h.home.join("bin/nunchiro.new");
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), &fresh).unwrap();
    fs::rename(&fresh, &installed).unwrap();
    let restarted = git_env::scrubbed(&installed)
        .args(["serve", "restart"])
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .status()
        .unwrap();
    assert!(restarted.success());
    let _ = h.core.wait();
    let session = h.session(&s.id);
    assert_eq!(session.state, SessionState::Running);
    assert_eq!(session.pid, Some(agent));
    assert!(running(agent));
    assert!(as_agent(&h, &s.id, &tok, &["session", "list"], ""));
    let core = fs::read_to_string(h.home.join("logs/core.log")).unwrap_or_default();
    assert!(!core.contains(&tok), "the token never reaches the log");
    // The new core is not our child: stop it through the CLI (Drop's Stop does), and check the old one is gone.
    assert!(!running(old_core));
}

// Ticket 353: an app update swaps the whole bundle folder under a live holder (renames, as tauri-plugin-updater does).
// Unlike the file swap above, that leaves the holder's own executable path unreadable for good.
#[test]
fn a_holder_whose_bundle_was_replaced_reattaches() {
    let mut h = Harness::new();
    let app = h.home.join("app");
    let exe = app.join("nunchiro");
    fs::create_dir(&app).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), &exe).unwrap();
    let installed = |home: &std::path::Path| {
        git_env::scrubbed(&exe)
            .arg("serve")
            .env("NUNCHIRO_HOME", home)
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap()
    };
    call(&h.home, Request::Stop).unwrap();
    let _ = h.core.wait();
    h.core = installed(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    let go = h.home.join("go");
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'before\\n'; while [ ! -e \"$0\" ]; do sleep 0.05; done; printf 'after\\n'; exec /bin/cat",
        go.to_str().unwrap(),
    ]);
    h.wait_text(&s.id, "before");
    h.core.kill().unwrap();
    let _ = h.core.wait();

    let (new, old) = (h.home.join("app.new"), h.home.join("app.old"));
    fs::create_dir(&new).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), new.join("nunchiro")).unwrap();
    fs::rename(&app, &old).unwrap();
    fs::rename(&new, &app).unwrap();
    fs::remove_dir_all(&old).unwrap();

    h.core = installed(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    // An unattached session also reads Running, but has no replay: the ring's text proves the attach.
    h.wait_text(&s.id, "before");
    fs::write(&go, "").unwrap();
    assert!(h.wait_text(&s.id, "after").contains("before"));
    assert_eq!(h.session(&s.id).pid, s.pid);
}

// V2-1b acceptance `full_quit_leaves_nothing` (binary level): after a crash and a reattach, plus a holder no record
// names, `serve stop --yes` leaves no holder and no agent it started.
#[test]
fn full_quit_leaves_nothing() {
    let mut h = Harness::new();
    let a = h.start(&["/bin/sh", "-c", "printf 'a up\\n'; exec /bin/sleep 600"]);
    let b = h.start(&["/bin/sh", "-c", "printf 'b up\\n'; exec /bin/sleep 600"]);
    h.wait_text(&a.id, "a up");
    h.wait_text(&b.id, "b up");
    let holders: Vec<u32> = [&a, &b]
        .iter()
        .map(|s| h.holder(&s.id)["pid"].as_u64().unwrap() as u32)
        .collect();
    let agents = [a.pid.unwrap(), b.pid.unwrap()];
    h.crash_and_restart(&[&a.id, &b.id]);
    // B's record is lost while no core runs: its holder becomes unknown, found only by the socket scan.
    h.core.kill().unwrap();
    let _ = h.core.wait();
    let mut store = h.store();
    store["live"].as_object_mut().unwrap().remove(&b.id);
    store["sessions"]
        .as_array_mut()
        .unwrap()
        .retain(|s| s["id"] != b.id.as_str());
    fs::write(
        h.home.join("sessions.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
    h.core = serve(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    let status = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["serve", "status"])
        .env("NUNCHIRO_HOME", &h.home)
        .output()
        .unwrap();
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["core"], true);
    let orphaned: Vec<_> = status["holders"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["orphaned"] == true)
        .collect();
    assert_eq!(orphaned.len(), 1, "{status}");
    assert!(
        running(agents[1]),
        "an unknown holder is not adopted, and not ended"
    );
    let quit = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["serve", "stop", "--yes"])
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .status()
        .unwrap();
    assert!(quit.success());
    let _ = h.core.wait();
    wait("every holder and agent ends", || {
        holders.iter().chain(&agents).all(|pid| !running(*pid))
    });
    assert!(nunchiro_core::holder::sockets(&h.home).is_empty());
}

// V2-1b acceptance `holder_kill9_30x_no_ghost` (binary level): `kill -9` of a holder, 30 times: never a ghost
// "running" session; one with a conversation becomes resumable.
#[test]
fn holder_kill9_no_ghost_30x() {
    let h = Harness::new();
    for round in 0..30 {
        let s = if round % 10 == 0 {
            h.codex()
        } else {
            let s = h.start(&["/bin/sh", "-c", "printf 'up\\n'; exec /bin/sleep 600"]);
            h.wait_text(&s.id, "up");
            s
        };
        let holder = h.holder(&s.id)["pid"].as_u64().unwrap() as u32;
        let agent = s.pid.unwrap();
        assert!(
            Command::new("/bin/kill")
                .args(["-9", &holder.to_string()])
                .status()
                .unwrap()
                .success()
        );
        wait("the session is not running", || {
            h.session(&s.id).state != SessionState::Running
        });
        let after = h.session(&s.id);
        if after.agent_session_id.is_some() {
            assert_eq!(after.state, SessionState::Resumable, "round {round}");
        }
        wait("no agent left", || !running(agent));
    }
}

/// One request on the core socket with `token`, as any process can send it (no CLI behaviour in between).
fn raw(h: &Harness, token: &str, request: Value) -> Value {
    let mut s = UnixStream::connect(h.home.join("core.sock")).unwrap();
    writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
    let mut reply = String::new();
    s.read_to_string(&mut reply).unwrap();
    serde_json::from_str(&reply).unwrap()
}
fn owner_exit(h: &mut Harness) {
    let token = fs::read_to_string(h.home.join("core.token")).unwrap();
    assert!(raw(h, &token, json!({"op":"exit"})).get("Ok").is_some());
    let _ = h.core.wait();
}

// V2-1b r3 (S1b): a session caller cannot make the core exit (leaving holders without a core); the owner still can.
// `stop` stays a session's (v1a-23, OWNERC D'; owner_hardening.rs): it ends every holder with the core.
#[test]
fn a_session_caller_cannot_make_the_core_exit() {
    let mut h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let tok = token(&h.wait_text(&s.id, "tok:"));
    let reply = raw(&h, &tok, json!({"op": "exit"}));
    assert_eq!(reply["Err"], "operation not granted", "{reply}");
    thread::sleep(Duration::from_millis(200));
    assert!(h.core.try_wait().unwrap().is_none(), "the core went away");
    owner_exit(&mut h);
    h.core = serve(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    assert_eq!(h.session(&s.id).state, SessionState::Running);
}

// Ticket 1154 (11-25 16:06: an update install put the old build back, "17 session(s) did not come back within 30 s").
// After the owner's core exit (an update, a restart) whichever CLI call comes first starts the next core, and with
// agents at work that is often one from inside a session. That core kept the session's id, so every holder
// refused it as "inside session" for as long as it ran: no session came back. Bounded as the install's own check is.
#[test]
fn a_core_a_session_started_gets_every_session_back() {
    let mut h = Harness::new();
    let cats: Vec<Session> = (0..3).map(|_| h.start(&["/bin/cat"])).collect();
    // An agent's CLI call that stays (`events` follows until its reader goes away): the one that starts the next core
    // still runs inside its session while that core looks for its holders, so the core must be no child of it either.
    // Nothing else here starts a core (`call` only connects).
    let script = r#"while :; do "$1" events > /dev/null 2>&1; sleep 0.2; done"#;
    let caller = h.start(&[
        "/bin/sh",
        "-c",
        script,
        "inside",
        env!("CARGO_BIN_EXE_nunchiro"),
    ]);
    owner_exit(&mut h);
    let read = |s: &Session| {
        let id = s.id.clone();
        call(&h.home, Request::Read { id, after: 0 }).is_ok()
    };
    let until = Instant::now() + Duration::from_secs(30);
    while !cats.iter().chain([&caller]).all(read) {
        let log = |s: &Session| {
            fs::read_to_string(h.home.join("logs/sessions").join(format!("{}.log", s.id)))
                .unwrap_or_default()
        };
        assert!(
            Instant::now() < until,
            "the sessions did not come back within 30 s; a holder's log:\n{}",
            log(&cats[0])
        );
        thread::sleep(Duration::from_millis(100));
    }
}

// V2-1b r3 (S1a): two holders from different executable paths in one data folder, both without a core. An agent in a
// session held from path Y connects to the path-X holder of session B and asks to attach as its core: refused, and
// nothing reaches B's agent.
#[test]
fn an_agent_under_another_paths_holder_cannot_attach_as_core() {
    let mut h = Harness::new();
    let typed = h.home.join("typed-b");
    let b = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'b up\\n'; exec /bin/cat > \"$0\"",
        typed.to_str().unwrap(),
    ]);
    h.wait_text(&b.id, "b up");
    let b_socket = h.holder(&b.id)["socket"].as_str().unwrap().to_string();
    owner_exit(&mut h);
    // The next core (and its holders) run from another path: an installed copy of the same build.
    let other = h.home.join("other/nunchiro");
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), &other).unwrap();
    h.core = git_env::scrubbed(&other)
        .arg("serve")
        .env("NUNCHIRO_HOME", &h.home)
        .env("PATH", format!("{}:/usr/bin:/bin", h.home.display()))
        .env_remove("NUNCHIRO_TOKEN")
        .spawn()
        .unwrap();
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    let go = h.home.join("go");
    let result = h.home.join("attach.out");
    let attacker = h.home.join("attach.py");
    fs::write(
        &attacker,
        r#"import socket, struct, sys, os, time
sock, go, out = sys.argv[1:4]
while not os.path.exists(go): time.sleep(0.02)
s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sock)
head = b""
try:
    s.recv(12)
    s.sendall(b"NUNHOLD\0\x00\x02\x00\x01" + struct.pack(">IB", 1, 6))
    while len(head) < 5:
        part = s.recv(5 - len(head))
        if not part: break
        head += part
except OSError: pass
op = head[4] if len(head) == 5 else -1
if op == 0x81:
    s.sendall(struct.pack(">IB", 7, 3) + b"pwned\n")
    time.sleep(0.5)
open(out, "w").write(str(op))
"#,
    )
    .unwrap();
    let a = h.start(&[
        "/usr/bin/python3",
        attacker.to_str().unwrap(),
        &b_socket,
        go.to_str().unwrap(),
        result.to_str().unwrap(),
    ]);
    let a_holder = h.holder(&a.id)["pid"].as_u64().unwrap() as u32;
    assert_eq!(ppid(a.pid.unwrap()), a_holder);
    owner_exit(&mut h);
    fs::write(&go, "").unwrap();
    wait("the attacker's answer", || result.exists());
    let op = fs::read_to_string(&result).unwrap();
    assert_ne!(op, "129", "an agent attached as the holder's core");
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        fs::read(&typed).unwrap_or_default(),
        b"",
        "keys reached session B"
    );
    // A core still attaches both.
    h.core = serve(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    wait("B reattached", || {
        h.session(&b.id).state == SessionState::Running
    });
}

// V2-1b r3 (S2): the core is killed (-9) and the agent's permission hook fires before a new core runs: the hook
// journals it and fails open. The next core replays the journal: the item comes back waiting and marked checking (not
// answerable) until fresh proof, like a restored item.
#[test]
fn a_hook_replayed_after_a_crash_waits_for_fresh_proof() {
    let mut h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'tok:%s\\n' \"$NUNCHIRO_TOKEN\"; exec /bin/cat",
    ]);
    let tok = token(&h.wait_text(&s.id, "tok:"));
    h.core.kill().unwrap();
    let _ = h.core.wait();
    let mut hook = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["hook", "PermissionRequest"])
        .env("NUNCHIRO_HOME", &h.home)
        .env("NUNCHIRO_TOKEN", &tok)
        .env("NUNCHIRO_SESSION", &s.id)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    hook.stdin
        .take()
        .unwrap()
        .write_all(br#"{"tool_name":"Bash","tool_input":{"command":"echo A"}}"#)
        .unwrap();
    let _ = hook.wait();
    h.core = serve(&h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());
    let back = h.session(&s.id);
    assert_eq!(back.state, SessionState::Running);
    assert_eq!(back.pending.len(), 1, "still waiting");
    let item = &back.pending[0];
    assert!(
        !item.actionable && item.reconciled,
        "replayed item answerable: {item:?}"
    );
    assert!(item.hook_event_id.is_none());
    assert!(
        call(
            &h.home,
            Request::Answer {
                item: item.id.clone(),
                answer: nunchiro_core::queue::Answer::AllowOnce,
                confirmed: false,
            }
        )
        .is_err()
    );
}

// V2-1b r3 (S3, spec V2-1 acceptance 7): after a reattach, a process inside the session presenting the owner token is
// still that session's caller, not the owner.
#[test]
fn an_inside_peer_of_a_reattached_session_is_its_caller() {
    let mut h = Harness::new();
    let go = h.home.join("go");
    let out = h.home.join("inside.out");
    let script = r#"while [ ! -e "$2" ]; do sleep 0.05; done; printf '{"token":"%s","request":{"op":"window_auth"}}\n' "$(cat "$NUNCHIRO_HOME/core.token")" | /usr/bin/nc -U "$NUNCHIRO_HOME/core.sock" > "$1.tmp"; mv "$1.tmp" "$1"; exec sleep 30"#;
    let s = h.start(&[
        "/bin/sh",
        "-c",
        script,
        "inside",
        out.to_str().unwrap(),
        go.to_str().unwrap(),
    ]);
    h.crash_and_restart(&[&s.id]);
    fs::write(&go, "").unwrap();
    wait("inside reply", || out.exists());
    let inside: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
    assert_eq!(inside["Err"], "operation not granted", "{inside}");
}

/// S6: `serve update` replaces only a core older than its own RC stamp (`NUNCHIRO_BUILD`, read at compile time), so the
/// newer build is this crate built with a stamp, in a target folder of its own: the test's binary stays unstamped.
/// Ticket 1156: that folder sits in the active target dir (next to this test binary's <target>/<profile>/deps/, the
/// rule of fixtures/cli.rs), so CARGO_TARGET_DIR holds; with none set it is <workspace>/target/core-swap-stamped.
fn stamped_build() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let exe = std::env::current_exe().unwrap();
    let target = exe
        .ancestors()
        .nth(3)
        .expect("<target>/<profile>/deps/<test>")
        .join("core-swap-stamped");
    let out = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args([
            "build",
            "--offline",
            "--locked",
            "-p",
            "nunchiro",
            "-j",
            "4", // the brief's job limit: this build is not under the outer cargo's -j
        ])
        .env("CARGO_TARGET_DIR", &target) // not --target-dir <path>: gen-gate-paths takes literal arguments only
        .env("NUNCHIRO_BUILD", "2")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    target.join("debug/nunchiro")
}

/// S6: the window as the app runs it: a port and token from the owner socket's `window_auth` (new for every core),
/// then `/ws` with the app's origin.
struct Window(tungstenite::WebSocket<std::net::TcpStream>);
impl Window {
    fn connect(home: &std::path::Path) -> Result<Self, String> {
        let Reply::WindowAuth { port, token } = call(home, Request::WindowAuth)? else {
            return Err("not a window_auth reply".into());
        };
        Self::dial(port, &token)
    }
    fn dial(port: u16, token: &str) -> Result<Self, String> {
        use tungstenite::{client::IntoClientRequest, http::HeaderValue};
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        let headers = req.headers_mut();
        headers.insert("Origin", HeaderValue::from_static("tauri://localhost"));
        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream =
            std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let (ws, _) = tungstenite::client(req, stream).map_err(|e| e.to_string())?;
        Ok(Self(ws))
    }
    /// What the page does after a close: it reconnects with what the app hands it once the next core answers.
    fn reconnect(home: &std::path::Path) -> Self {
        let mut window = None;
        wait("the window reconnects", || {
            window = Self::connect(home).ok();
            window.is_some()
        });
        window.unwrap()
    }
    /// The next message, `None` while none comes (100 ms); panics once the connection has ended.
    fn next(&mut self) -> Option<tungstenite::Message> {
        match self.0.read() {
            Ok(m) => Some(m),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                None
            }
            Err(e) => panic!("window connection ended: {e}"),
        }
    }
    /// The first pushed snapshot whose sessions all run: their ids, sorted.
    fn running_sessions(&mut self) -> Vec<String> {
        let mut ids = None;
        wait("a snapshot of running sessions", || {
            if let Some(tungstenite::Message::Text(t)) = self.next() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if let Some(sessions) = v["sessions"]
                    .as_array()
                    .filter(|_| v["event"] == "snapshot")
                    && sessions.iter().all(|s| s["state"] == "running")
                {
                    let mut listed: Vec<String> = sessions
                        .iter()
                        .map(|s| s["id"].as_str().unwrap().to_string())
                        .collect();
                    listed.sort();
                    ids = Some(listed);
                }
            }
            ids.is_some()
        });
        ids.unwrap()
    }
    /// Whether the core ended this connection within the wait bound.
    fn ended(&mut self) -> bool {
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            match self.0.read() {
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) | Ok(tungstenite::Message::Close(_)) => return true,
                Ok(_) => {}
            }
        }
        false
    }
    /// The replay a watch of `id` from its first byte gets.
    fn replay(&mut self, id: &str) -> String {
        self.0
            .send(tungstenite::Message::Text(
                json!({"id": 1, "watch": id, "after": 0}).to_string().into(),
            ))
            .unwrap();
        let mut text = None;
        wait("the watch's replay frame", || {
            if let Some(tungstenite::Message::Binary(b)) = self.next() {
                let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
                let head: Value = serde_json::from_slice(&b[4..4 + n]).unwrap();
                if head["session"] == id && head["replay"] == true {
                    text = Some(String::from_utf8_lossy(&b[4 + n..]).into_owned());
                }
            }
            text.is_some()
        });
        text.unwrap()
    }
}
fn send_text(h: &Harness, id: &str, text: &str) {
    call(
        &h.home,
        Request::SendText {
            id: id.into(),
            text: text.into(),
            composer: false,
            seen: vec![],
        },
    )
    .unwrap();
}
fn listed(h: &Harness) -> Vec<String> {
    match call(&h.home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => {
            let mut ids: Vec<String> = sessions.into_iter().map(|s| s.id).collect();
            ids.sort();
            ids
        }
        r => panic!("wrong reply {r:?}"),
    }
}

// The window client waits out a core that answers its handshake late, as a loaded CI runner does (the swap test's
// first connect once failed with "Interrupted handshake (WouldBlock)" after 100 ms). The core is stopped between
// `window_auth` and the dial, so the request sits unanswered for 300 ms.
#[test]
fn window_waits_out_a_late_handshake() {
    let h = Harness::new();
    let Reply::WindowAuth { port, token } = call(&h.home, Request::WindowAuth).unwrap() else {
        panic!("not a window_auth reply");
    };
    let core = h.core.id() as libc::pid_t;
    assert_eq!(unsafe { libc::kill(core, libc::SIGSTOP) }, 0);
    let resume = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        unsafe { libc::kill(core, libc::SIGCONT) };
    });
    let dialed = Window::dial(port, &token);
    resume.join().unwrap();
    assert_eq!(dialed.unwrap().running_sessions(), Vec::<String>::new());
}

// S6 (scorecard stability): the owner's two core swaps with a shell, a Codex fixture agent and a window connected:
// (a) `serve restart`, (b) `serve update` from a newer, stamped build installed over the core's executable. After
// each, the same sessions with the same holders and agents, the shell's earlier output replayed and a new command
// answered, no second Codex on the conversation, and the window back on the next core with the same sessions.
#[test]
fn core_swap_keeps_sessions_and_the_window() {
    let mut h = Harness::new();
    let newer = stamped_build();
    let installed = h.home.join("bin/nunchiro");
    fs::create_dir_all(installed.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), &installed).unwrap();
    call(&h.home, Request::Stop).unwrap();
    let _ = h.core.wait();
    h.core = serve_from(&installed, &h.home);
    wait("core start", || call(&h.home, Request::Snapshot).is_ok());

    let shell = h.start(&["/bin/sh"]);
    send_text(&h, &shell.id, "echo one-$((40+2))\r");
    h.wait_text(&shell.id, "one-42");
    let codex = h.codex();
    let conversation = codex.agent_session_id.clone().unwrap();
    let ids = listed(&h);
    assert_eq!(ids.len(), 2);
    let holders: Vec<Value> = [&shell, &codex]
        .iter()
        .map(|s| h.holder(&s.id)["pid"].clone())
        .collect();
    let mut window = Window::connect(&h.home).unwrap();
    assert_eq!(window.running_sessions(), ids);

    for (round, swap) in ["restart", "update"].into_iter().enumerate() {
        if swap == "update" {
            // As an update installs: a new file renamed over the path the core runs from.
            let fresh = h.home.join("bin/nunchiro.new");
            fs::copy(&newer, &fresh).unwrap();
            fs::rename(&fresh, &installed).unwrap();
        }
        let generation = fs::read(h.home.join("core.token")).unwrap();
        let began = Instant::now();
        let out = cli(&installed, &h.home)
            .args(["serve", swap])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{swap}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        if swap == "update" {
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "replaced");
        }
        assert!(
            window.ended(),
            "{swap}: the old core ends the window's connection"
        );
        window = Window::reconnect(&h.home);
        assert_ne!(
            fs::read(h.home.join("core.token")).unwrap(),
            generation,
            "{swap}: the window is on the next core"
        );
        assert_eq!(
            window.running_sessions(),
            ids,
            "{swap}: the window sees the same sessions"
        );
        let took = began.elapsed();
        assert!(
            took < Duration::from_secs(10),
            "{swap}: window back after {took:?}"
        );

        assert_eq!(listed(&h), ids, "{swap}: same sessions listed");
        for (s, holder) in [&shell, &codex].iter().zip(&holders) {
            assert_eq!(&h.holder(&s.id)["pid"], holder, "{swap}: same holder");
            assert!(running(holder.as_u64().unwrap() as u32));
            let now = h.session(&s.id);
            assert_eq!(now.state, SessionState::Running, "{swap}");
            assert_eq!(now.pid, s.pid, "{swap}: same agent");
        }
        // The shell: its earlier output replayed, and a new command answered.
        assert!(h.read(&shell.id).contains("one-42"), "{swap}: replay");
        assert!(
            window.replay(&shell.id).contains("one-42"),
            "{swap}: the window's replay"
        );
        send_text(&h, &shell.id, &format!("echo two-$(({round}+100))\r"));
        h.wait_text(&shell.id, &format!("two-{}", round + 100));
        // The agent: the same Codex answers, and nothing resumed its conversation a second time.
        assert_eq!(h.resumed(&conversation), 0, "{swap}: a second Codex");
        send_text(&h, &codex.id, &format!("after-{swap}\n"));
        h.wait_text(&codex.id, &format!("ACK:after-{swap}"));
    }
    // The update put the stamped build in charge.
    let start: Value =
        serde_json::from_slice(&fs::read(h.home.join("core.start.json")).unwrap()).unwrap();
    assert_eq!(start["build"], 2, "{start}");
}

/// Line numbers after "R" in `bytes`; a partial line at either edge is skipped.
fn printed(bytes: &[u8]) -> Vec<u64> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    lines.pop(); // after the last newline: partial or empty
    lines
        .iter()
        .skip(1) // before the first newline: maybe partial
        .filter_map(|l| l.trim_end_matches('\r').strip_prefix('R')?.parse().ok())
        .collect()
}
fn contiguous(numbers: &[u64]) -> bool {
    numbers.windows(2).all(|w| w[1] == w[0] + 1)
}
fn output(h: &Harness, id: &str, after: u64) -> (Vec<u8>, u64, u64, bool) {
    match call(
        &h.home,
        Request::Read {
            id: id.into(),
            after,
        },
    )
    .unwrap()
    {
        Reply::Output {
            data,
            start,
            end,
            truncated,
        } => (data, start, end, truncated),
        r => panic!("wrong reply {r:?}"),
    }
}

// S6: a swap while the shell prints without pause. The next core's replay continues at the byte the old core's reads
// ended on, or says what the ring dropped (truncated, a later start); every line after that is there, in order.
#[test]
fn core_swap_mid_output_loses_no_bytes() {
    let h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "i=0; while :; do i=$((i+1)); echo R$i; [ $((i % 200)) -eq 0 ] && sleep 0.01; done",
    ]);
    h.wait_text(&s.id, "R2000\r\n");
    let (before, _, cursor, _) = output(&h, &s.id, 0);
    let last = *printed(&before).last().unwrap();
    let out = cli(env!("CARGO_BIN_EXE_nunchiro").as_ref(), &h.home)
        .args(["serve", "restart"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // Well past the swap: the reattached session has gone on printing.
    let mut after = (Vec::new(), 0, 0, false);
    wait("output after the swap", || {
        after = output(&h, &s.id, cursor);
        printed(&after.0).last().is_some_and(|n| *n > last + 5000)
    });
    let (data, start, _, truncated) = after;
    if truncated {
        assert!(start > cursor, "a truncated replay names what it dropped");
        assert!(
            contiguous(&printed(&data)),
            "a line missing after the dropped part"
        );
    } else {
        assert_eq!(
            start, cursor,
            "the replay starts where the old core's reads ended"
        );
        let joined = [before, data].concat();
        assert!(
            contiguous(&printed(&joined)),
            "a line missing across the swap"
        );
    }
    eprintln!(
        "mid-output swap: truncated={truncated}, dropped={}",
        start.saturating_sub(cursor)
    );
}
