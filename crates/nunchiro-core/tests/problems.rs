//! V2-5b: the problem card through a real `nunchiro serve`, with fake agents on PATH. An unknown exit code shows the
//! generic card and its Restart starts the session again; a clean exit and a running session get none.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli() -> PathBuf {
    cli::path()
}

/// A fake `claude`: answers `--version`, prints a line, then exits with the code in `$H/code` (0 when absent), or
/// waits while `$H/hold` exists.
const FAKE: &str = "#!/bin/sh\n[ \"$1\" = --version ] && { echo '2.1.312 (Claude Code)'; exit 0; }\nH=\"$NUNCHIRO_HOME\"\necho \"$*\" > \"$H/args-$NUNCHIRO_SESSION\"\necho \"working on it\"\ncat \"$H/say\" 2>/dev/null\nwhile [ -e \"$H/hold\" ]; do sleep 0.1; done\nexit \"$(cat \"$H/code\" 2>/dev/null || echo 0)\"\n";

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new(tag: &str) -> Self {
        let home = home::short(tag);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(home.join("project")).unwrap();
        // The same fake answers as codex too (hook trust is a Codex card).
        for name in ["claude", "codex"] {
            fs::write(bin.join(name), home::codex_fake(FAKE)).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("CODEX_HOME", home.join("codex-home"))
            .env("SHELL", "/bin/sh") // ticket 286: the shell an ended agent leaves
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while core.call(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot" {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    fn call(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let line = json!({"token": token, "request": request}).to_string() + "\n";
        s.write_all(line.as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(Value::Null)
    }
    fn start(&self) -> String {
        self.start_kind("claude")
    }
    fn start_kind(&self, kind: &str) -> String {
        let r = self.call(
            json!({"op":"start","session":{"kind":kind,"project":self.home.join("project"),
            "label":"p","model":null,"effort":null,"resume":null}}),
        );
        assert_eq!(r["Ok"]["type"], "started", "{r}");
        r["Ok"]["session"]["id"].as_str().unwrap().to_string()
    }
    fn session(&self, id: &str) -> Value {
        let r = self.call(json!({"op":"snapshot"}));
        r["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn ended(&self, id: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let s = self.session(id);
            if s["state"] != "running" {
                return s;
            }
            assert!(Instant::now() < until, "{id} never ended: {s}");
            // Ticket 286: the agent's wrapper leaves a shell; quitting it ends the session.
            self.call(json!({"op":"send_text","id":id,"text":"exit\r"}));
            thread::sleep(Duration::from_millis(1500));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.call(json!({"op":"stop"}));
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

#[test]
fn problem_unknown_exit_generic() {
    let core = Core::new("pb");
    fs::write(core.home.join("code"), "3").unwrap();
    let id = core.start();
    let s = core.ended(&id);
    assert_eq!(s["problem"]["case"], "unexpected", "{s}");
    assert_eq!(
        s["problem"]["cause"],
        "Session ended unexpectedly (exit code 3)."
    );
    // The fix: Restart starts the agent again in the same folder and the old row goes.
    fs::write(core.home.join("code"), "0").unwrap();
    let r = core.call(json!({"op":"problem_fix","id":id,"fix":"restart"}));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let next = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    assert_ne!(next, id);
    let old = core.session(&id);
    assert_eq!(old["state"], "closed", "{old}");
    assert!(
        old.get("problem").is_none(),
        "a closed row keeps its card: {old}"
    );
    // A clean exit shows no card.
    assert!(core.ended(&next).get("problem").is_none());
}

#[test]
fn problem_fix_refuses_a_running_session() {
    let core = Core::new("pr");
    fs::write(core.home.join("hold"), "").unwrap();
    let id = core.start();
    for fix in ["restart", "start_without_hooks"] {
        let r = core.call(json!({"op":"problem_fix","id":id,"fix":fix}));
        assert_eq!(r["Err"], "only an ended session can be restarted", "{r}");
    }
    let s = core.session(&id);
    assert_eq!(s["state"], "running");
    assert!(s.get("problem").is_none(), "{s}");
    fs::remove_file(core.home.join("hold")).unwrap();
}

/// Ticket 286: an agent that quit leaves its shell Running; the card's Restart still accepts it (a live agent is
/// refused above).
#[test]
fn problem_fix_restarts_a_session_whose_agent_ended() {
    let core = Core::new("pe");
    fs::write(core.home.join("code"), "3").unwrap();
    let id = core.start();
    let marker = core.home.join(format!("agent-ended-{id}"));
    let until = Instant::now() + Duration::from_secs(30);
    while !fs::read_to_string(&marker).is_ok_and(|m| m.starts_with("seen")) {
        assert!(Instant::now() < until, "{id}: the agent never ended");
        thread::sleep(Duration::from_millis(20));
    }
    let s = core.session(&id);
    assert_eq!(
        (&s["state"], &s["problem"]["case"]),
        (&json!("running"), &json!("unexpected")),
        "{s}"
    );
    fs::write(core.home.join("code"), "0").unwrap();
    let r = core.call(json!({"op":"problem_fix","id":id,"fix":"restart"}));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    assert_eq!(core.session(&id)["state"], "closed");
    let next = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    core.ended(&next);
}

/// Ticket 436: a FIFO at a running agent's end marker is refused, not waited on: List and the next registry user
/// answer at once (before, the marker's blocking open held the registry mutex until a writer came).
#[test]
fn fifo_end_marker_does_not_block_list() {
    let core = Core::new("pf");
    fs::write(core.home.join("hold"), "").unwrap();
    let id = core.start();
    let marker = core.home.join(format!("agent-ended-{id}"));
    let c = std::ffi::CString::new(marker.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    for op in ["list", "snapshot"] {
        let asked = Instant::now();
        let r = core.call(json!({"op":op}));
        assert_eq!(r["Ok"]["type"], "snapshot", "{op}: {r}");
        assert!(
            asked.elapsed() < Duration::from_secs(5),
            "{op}: {:?}",
            asked.elapsed()
        );
    }
    assert_eq!(core.session(&id)["state"], "running");
    fs::remove_file(&marker).unwrap();
    fs::remove_file(core.home.join("hold")).unwrap();
}

#[test]
fn problem_not_installed_opens_a_failed_tab() {
    let core = Core::new("pn");
    fs::remove_file(core.home.join("bin/claude")).unwrap();
    let id = core.start();
    let s = core.session(&id);
    assert_eq!(
        (&s["state"], &s["problem"]["case"]),
        (&json!("failed"), &json!("not_installed")),
        "{s}"
    );
    assert_eq!(
        s["problem"]["cause"],
        "Claude is not installed (claude is not on PATH)."
    );
}

#[test]
fn problem_start_without_hooks_runs_hookless() {
    let core = Core::new("ph");
    fs::write(core.home.join("code"), "3").unwrap();
    // The fix is the card's own: a generic card offers Restart, never a hook-less start.
    let generic = core.start();
    core.ended(&generic);
    let r = core.call(json!({"op":"problem_fix","id":generic,"fix":"start_without_hooks"}));
    assert_eq!(r["Err"], "this card offers another fix", "{r}");
    fs::write(
        core.home.join("say"),
        "error: hook trust could not be written\n",
    )
    .unwrap();
    let id = core.start_kind("codex");
    assert_eq!(core.ended(&id)["problem"]["case"], "hook_trust");
    let args =
        |id: &str| fs::read_to_string(core.home.join(format!("args-{id}"))).unwrap_or_default();
    assert!(
        args(&id).contains("--dangerously-bypass-hook-trust"),
        "{}",
        args(&id)
    );
    let r = core.call(json!({"op":"problem_fix","id":id,"fix":"restart"}));
    assert_eq!(r["Err"], "this card offers another fix", "{r}");
    fs::remove_file(core.home.join("say")).unwrap();
    fs::write(core.home.join("hold"), "").unwrap();
    let r = core.call(json!({"op":"problem_fix","id":id,"fix":"start_without_hooks"}));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let next = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(core.session(&next)["without_hooks"], true);
    let launched = Instant::now() + Duration::from_secs(10);
    while args(&next).is_empty() && Instant::now() < launched {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !args(&next).is_empty(),
        "the hook-less start never launched"
    );
    // None of Nunchiro's own hooks and no trust bypass. Ticket 1149: the outward hook stays (as Claude's does), in `-c`
    // values that no Codex refuses.
    let hookless = args(&next);
    assert!(
        !hookless.contains("--dangerously-bypass-hook-trust")
            && !hookless.contains("hook PermissionRequest")
            && hookless.contains("hook outward --codex"),
        "{hookless}"
    );
    fs::remove_file(core.home.join("hold")).unwrap();
}

#[test]
fn acp_failed_maps_the_errors_the_acp_code_produces() {
    use nunchiro_core::problems::{Case, acp_failed};
    let case = |e: &str| acp_failed("Gemini CLI", e).map(|p| p.case);
    assert_eq!(
        case("acp agent /x/gemini: No such file or directory (os error 2)"),
        Some(Case::NotInstalled)
    );
    assert_eq!(
        case("session start: auth_required: run gemini login"),
        Some(Case::LoggedOut)
    );
    assert_eq!(
        case("the agent speaks ACP version 2; Nunchiro speaks version 1"),
        Some(Case::AcpNoAnswer)
    );
    assert_eq!(
        case("the agent closed its output before answering ACP"),
        Some(Case::AcpNoAnswer)
    );
    assert_eq!(
        case("acp agent /x/gemini: Permission denied (os error 13)"),
        Some(Case::AcpNoAnswer)
    );
    let claude = nunchiro_core::acp::config::claude_refusal(&nunchiro_core::acp::config::Entry {
        name: "c".into(),
        command: "/x/claude-acp".into(),
        args: vec![],
        env: vec![],
        display: None,
    })
    .unwrap();
    let refused = acp_failed("c", &claude).unwrap();
    assert_eq!(refused.case, Case::AcpRefused);
    assert_eq!(refused.cause, claude);
    // No card: the window opens the sheet (not approved, changed), or a plain error stays plain.
    for error in [
        "agent is not approved",
        "agent changed since it was approved",
        "an ACP agent cannot run in your home folder itself; pick a project folder",
        "no resumable session of this agent",
        "no agent \"x\" in agents.toml",
    ] {
        assert!(case(error).is_none(), "{error}");
    }
    let named = acp_failed("Gemini CLI", "acp agent /x: No such file").unwrap();
    assert_eq!(named.cause, "Gemini CLI is not installed.");
}
