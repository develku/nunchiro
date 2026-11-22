//! V2-2d: removing an account, against a real `nunchiro serve` with fake `claude` and `codex` on PATH. A remove is
//! three owner steps: check (refused while in use; the count of sessions that lose their history), logout (the
//! agent's own logout in a visible tab) and move (into `accounts/.trash/<id>-<ts>/`, after logout exits 0 or the owner
//! confirms the leftovers). The fakes record the env and argv they ran with. No real agent runs here.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    accounts::{self, Agent},
    api::*,
    server::call,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

// Login records its env and exits at once (or waits for one line while `login-hold` exists). Logout records its env, its argv and whether its folder was still in place, then exits with
// the code in `logout-code-<name>` (0 when absent). Any other start records its env and waits for one line.
const FAKE: &str = r#"#!/bin/sh
# While `hold` exists, `--version` (which a Start runs off the registry lock) marks itself and waits, at most 3 s.
case "$1" in --version)
  if [ -e "$NUNCHIRO_HOME/hold" ]; then
    : > "$NUNCHIRO_HOME/version-held"
    i=0; while [ -e "$NUNCHIRO_HOME/hold" ] && [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done
  fi
  echo "$VERSION_TEXT"; exit 0;;
esac
D="${CLAUDE_CONFIG_DIR:-$CODEX_HOME}"
n=$(basename "$0")
case "$*" in
  "auth login"|login) env > "$NUNCHIRO_HOME/login-$n.tmp" && mv "$NUNCHIRO_HOME/login-$n.tmp" "$NUNCHIRO_HOME/login-$n.env"
    # While `login-hold` exists the login stays open, like a real one waiting for its pasted code.
    [ -e "$NUNCHIRO_HOME/login-hold" ] && read line
    exit 0;;
  "auth logout"|logout)
    { env; [ -d "$D" ] && echo "FOLDER_PRESENT=yes"; echo "ARGV=$*"; } > "$NUNCHIRO_HOME/logout-$n.tmp"
    mv "$NUNCHIRO_HOME/logout-$n.tmp" "$NUNCHIRO_HOME/logout-$n.env"
    exit "$(cat "$NUNCHIRO_HOME/logout-code-$n" 2>/dev/null || echo 0)";;
esac
env > "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" && mv "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" "$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION"
read line
"#;

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    user: PathBuf,
    project: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with(&[])
    }
    /// `vars`: extra env for the core, which runs in `<home>/cwd`.
    fn with(vars: &[(&str, &str)]) -> Self {
        let home = home::short("arm");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, version) in [
            ("claude", "2.1.311 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            fs::write(bin.join(name), FAKE.replace("$VERSION_TEXT", version)).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // The user's own trees, which no remove may touch.
        let user = home.join("u");
        for dir in [".claude", ".codex"] {
            fs::create_dir_all(user.join(dir).join("skills")).unwrap();
            fs::write(user.join(dir).join("settings.json"), "{}").unwrap();
        }
        let project = home.join("proj");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        let mut core = Self {
            process: serve(&home, vars),
            home,
            user,
            project,
        };
        core.ready();
        core
    }
    fn ready(&mut self) {
        let until = Instant::now() + Duration::from_secs(30);
        while call(&self.home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// `kill -9` of the core, then a new one over the same home (the holders keep the agents).
    fn crash_and_restart(&mut self) {
        self.process.kill().unwrap();
        let _ = self.process.wait();
        self.process = serve(&self.home, &[]);
        self.ready();
    }
    fn add(&self, agent: Agent, label: &str) -> Value {
        match call(
            &self.home,
            Request::AccountAdd {
                agent,
                label: label.into(),
            },
        ) {
            Ok(Reply::AccountAdded { account, session }) => {
                self.exited(&session.id);
                serde_json::to_value(account).unwrap()
            }
            other => panic!("{other:?}"),
        }
    }
    fn start(&self, kind: AgentKind, account: &str, label: &str) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind,
                    project: self.project.clone(),
                    worktree: false,
                    label: label.into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: Some(account.into()),
                },
            },
        ) {
            Ok(Reply::Started { session }) => {
                self.wait(&format!("env-{}", session.id));
                session
            }
            other => panic!("{other:?}"),
        }
    }
    fn sessions(&self) -> Vec<Session> {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions,
            _ => panic!(),
        }
    }
    fn session(&self, id: &str) -> Session {
        self.sessions().into_iter().find(|s| s.id == id).unwrap()
    }
    fn exited(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(15);
        while self.session(id).state == SessionState::Running {
            assert!(Instant::now() < until, "session {id} never exited");
            // Ticket 286: the agent's wrapper leaves a shell; quitting it ends the session.
            let _ = call(
                &self.home,
                Request::SendText {
                    id: id.into(),
                    text: "exit\r".into(),
                    composer: false,
                    seen: vec![],
                },
            );
            thread::sleep(Duration::from_millis(1500));
        }
    }
    /// Ends a fake agent (its one line) and waits until the core sees it exit.
    fn end(&self, id: &str) {
        call(
            &self.home,
            Request::SendText {
                id: id.into(),
                text: "\r".into(),
                composer: false,
                seen: vec![],
            },
        )
        .unwrap();
        self.exited(id);
    }
    fn wait(&self, name: &str) -> String {
        let path = self.home.join(name);
        let until = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(Instant::now() < until, "{name} never appeared");
            thread::sleep(Duration::from_millis(20));
        }
        fs::read_to_string(path).unwrap()
    }
    fn remove(&self, account: &Value, step: RemoveStep, leftovers: bool) -> Response {
        call(
            &self.home,
            Request::AccountRemove {
                agent: serde_json::from_value(account["agent"].clone()).unwrap(),
                id: account["id"].as_str().unwrap().into(),
                step,
                leftovers,
            },
        )
    }
    /// Runs the logout tab and waits for it to exit.
    fn logout(&self, account: &Value) -> Session {
        match self.remove(account, RemoveStep::Logout, false) {
            Ok(Reply::AccountLogout { session }) => {
                self.exited(&session.id);
                session
            }
            other => panic!("{other:?}"),
        }
    }
    fn owner(&self, request: Value) -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        writeln!(sock, "{}", json!({"token":token.trim(),"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
    fn listed(&self) -> Vec<String> {
        match call(&self.home, Request::AccountList) {
            Ok(Reply::Accounts { accounts }) => accounts.into_iter().map(|a| a.id).collect(),
            other => panic!("{other:?}"),
        }
    }
    fn trash(&self) -> PathBuf {
        self.home.join("accounts/.trash")
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn serve(home: &Path, vars: &[(&str, &str)]) -> Child {
    home::git_env::scrubbed(cli())
        .arg("serve")
        .current_dir(home.join("cwd"))
        .env("NUNCHIRO_HOME", home)
        .env("HOME", home.join("u"))
        .env("SHELL", "/bin/sh") // ticket 286: the shell an ended agent leaves
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", home.join("bin").display()),
        )
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(home.join("core.log")).unwrap())
        .envs(vars.iter().copied())
        .spawn()
        .unwrap()
}
/// Every path under `dir` with its kind, size and link target, so a move or delete anywhere shows.
fn tree(dir: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).unwrap().flatten() {
            let m = fs::symlink_metadata(entry.path()).unwrap();
            out.insert(
                entry.path().strip_prefix(dir).unwrap().to_path_buf(),
                format!(
                    "{:?} {} {:?}",
                    m.file_type(),
                    m.len(),
                    fs::read_link(entry.path()).ok()
                ),
            );
            if m.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    out
}
fn env_of(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn folder(account: &Value) -> PathBuf {
    PathBuf::from(account["folder"].as_str().unwrap())
}
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
const DAY: u64 = 24 * 60 * 60;

// Acceptance `account_remove_refused_in_use` (threat 3): a live session and a resumable session each block every
// step; the refusal names both. Once both are closed, the check counts the stopped one as losing its history (needs
// 120: the closed resumable row is deleted).
#[test]
fn account_remove_refused_in_use() {
    let mut core = Core::new();
    let account = core.add(Agent::Claude, "work");
    let resumable = core.start(AgentKind::Claude, "work", "resumable one");
    core.end(&resumable.id);
    let live = core.start(AgentKind::Claude, "work", "live one");
    // Another account's session never blocks this one.
    core.add(Agent::Claude, "other");
    core.start(AgentKind::Claude, "other", "elsewhere");
    core.crash_and_restart();
    assert_eq!(core.session(&live.id).state, SessionState::Running);
    assert_eq!(core.session(&resumable.id).state, SessionState::Resumable);
    let before = tree(&core.home.join("accounts"));
    for step in [RemoveStep::Check, RemoveStep::Logout, RemoveStep::Move] {
        let err = core.remove(&account, step, true).unwrap_err();
        assert!(
            err.contains("live one") && err.contains("resumable one") && !err.contains("elsewhere"),
            "{step:?}: {err}"
        );
    }
    assert!(
        !core.home.join("logout-claude.env").exists(),
        "no logout ran"
    );
    assert_eq!(tree(&core.home.join("accounts")), before);
    // Only the resumable one left: still refused, naming it alone. needs 120: the live one is stopped by its Close
    // (a working session's close keeps its row); a stopped or done row's Close deletes it after the Undo window.
    call(
        &core.home,
        Request::Close {
            id: live.id.clone(),
        },
    )
    .unwrap();
    let err = core.remove(&account, RemoveStep::Check, false).unwrap_err();
    assert!(
        err.contains("resumable one") && !err.contains("live one"),
        "{err}"
    );
    call(
        &core.home,
        Request::Close {
            id: resumable.id.clone(),
        },
    )
    .unwrap();
    // Ticket 92: inside the Undo window the closed row still blocks (Undo would bring it back); it counts as gone
    // once the window has ended, which the core's tick does after 10 s.
    let err = core.remove(&account, RemoveStep::Check, false).unwrap_err();
    assert!(err.contains("resumable one"), "{err}");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match core.remove(&account, RemoveStep::Check, false) {
            Ok(Reply::AccountRemoveCheck { sessions }) => break assert_eq!(sessions, 1), // needs 120: the resumable row is gone
            other => assert!(std::time::Instant::now() < until, "{other:?}"),
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

// Acceptance `account_remove_path_guard` (threats 1 and 2): a `..` path, `..`, `.trash` and "Your own" ids, a
// symlinked account folder, and a link swapped in after the check are each refused; nothing outside `accounts/`
// moves or is deleted, and the link's target is never entered.
#[test]
fn account_remove_path_guard() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    let outside = core.home.join("outside");
    fs::create_dir_all(outside.join("keep")).unwrap();
    fs::write(outside.join("keep/file"), "precious").unwrap();
    let user = tree(&core.user);
    let kept = tree(&outside);
    for id in ["../../u/.claude", "..", ".trash", "own", "", "a/b"] {
        for step in ["check", "logout", "move"] {
            if id == "own" && step == "logout" {
                continue; // ticket 322: Your own may sign out (own_logout_has_no_override); it is never checked or moved
            }
            let r = core.owner(json!({"op":"account_remove","agent":"claude","id":id,"step":step,"leftovers":true}));
            assert!(r.get("Err").is_some(), "{id:?} {step}: {r}");
        }
    }
    // A symlinked account folder: refused at every step, the link left in place and its target untouched.
    let real = folder(&account);
    let aside = core.home.join("aside");
    fs::rename(&real, &aside).unwrap();
    symlink(&outside, &real).unwrap();
    for step in [RemoveStep::Check, RemoveStep::Logout, RemoveStep::Move] {
        let err = core.remove(&account, step, true).unwrap_err();
        assert!(err.contains("link"), "{step:?}: {err}");
    }
    assert!(
        !core.home.join("logout-claude.env").exists(),
        "no logout ran"
    );
    assert!(
        fs::symlink_metadata(&real)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    // TOCTOU at the step seam: the check passes on the real folder, then a link takes its place before the move.
    fs::remove_file(&real).unwrap();
    fs::rename(&aside, &real).unwrap();
    assert!(matches!(
        core.remove(&account, RemoveStep::Check, false),
        Ok(Reply::AccountRemoveCheck { sessions: 0 })
    ));
    fs::rename(&real, &aside).unwrap();
    symlink(&outside, &real).unwrap();
    assert!(core.remove(&account, RemoveStep::Move, true).is_err());
    assert!(
        fs::symlink_metadata(&real)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(tree(&outside), kept);
    assert_eq!(tree(&core.user), user);
    assert!(
        !core.trash().exists() || fs::read_dir(core.trash()).unwrap().next().is_none(),
        "nothing went to the trash"
    );
    // A symlinked `accounts/claude` folder is refused the same way.
    fs::remove_file(&real).unwrap();
    fs::rename(&aside, &real).unwrap();
    let agent_dir = core.home.join("accounts/claude");
    fs::rename(&agent_dir, core.home.join("claude-aside")).unwrap();
    symlink(core.home.join("claude-aside"), &agent_dir).unwrap();
    assert!(core.remove(&account, RemoveStep::Move, true).is_err());
    assert!(
        core.home
            .join("claude-aside")
            .join(account["id"].as_str().unwrap())
            .is_dir()
    );
    assert!(
        core.listed()
            .contains(&account["id"].as_str().unwrap().to_string())
    );
}

// Acceptance `account_remove_trash_7d` (threat 4), fake clock: the removed folder lands whole under
// `.trash/<id>-<ts>/` and leaves the list; a sweep keeps it until 7 days have passed, then deletes it. The sweep
// follows no link (a link entry and a link inside an old entry leave their targets alone), skips names it did not
// make, and runs at core start.
#[test]
fn account_remove_trash_7d() {
    let mut core = Core::new();
    let account = core.add(Agent::Codex, "old");
    let id = account["id"].as_str().unwrap().to_string();
    fs::write(folder(&account).join("auth-marker"), "x").unwrap();
    core.logout(&account);
    let from = unix_now();
    let trash = match core.remove(&account, RemoveStep::Move, false) {
        Ok(Reply::AccountRemoved { trash }) => trash,
        other => panic!("{other:?}"),
    };
    let to = unix_now();
    assert_eq!(trash.parent(), Some(core.trash().as_path()));
    let name = trash.file_name().unwrap().to_str().unwrap();
    let ts: u64 = name
        .strip_prefix(&format!("{id}-"))
        .unwrap()
        .parse()
        .unwrap();
    assert!((from..=to).contains(&ts), "{name}");
    assert_eq!(fs::read_to_string(trash.join("auth-marker")).unwrap(), "x");
    assert!(!folder(&account).exists());
    assert!(!core.listed().contains(&id));
    // Planted entries: a link to an outside folder, an old real folder holding a link out, a name the core never
    // makes, and a file.
    let outside = core.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("file"), "precious").unwrap();
    let kept = tree(&outside);
    symlink(&outside, core.trash().join("a1-1")).unwrap();
    fs::create_dir_all(core.trash().join("b2-1/sub")).unwrap();
    symlink(&outside, core.trash().join("b2-1/sub/out")).unwrap();
    symlink(outside.join("file"), core.trash().join("b2-1/f")).unwrap();
    fs::create_dir_all(core.trash().join("not-a-stamp-x")).unwrap();
    fs::create_dir_all(core.trash().join("..x-1")).unwrap();
    fs::write(core.trash().join("c3-1"), "file").unwrap();
    let at = |secs: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
    accounts::sweep(&core.home, at(ts + 7 * DAY - 1)).unwrap();
    assert!(trash.is_dir(), "kept before 7 days");
    assert!(
        !core.trash().join("b2-1").exists(),
        "an old real entry goes"
    );
    assert!(
        fs::symlink_metadata(core.trash().join("a1-1")).is_ok(),
        "a link entry is left alone"
    );
    assert!(core.trash().join("not-a-stamp-x").is_dir() && core.trash().join("..x-1").is_dir());
    assert!(core.trash().join("c3-1").is_file());
    assert_eq!(tree(&outside), kept);
    accounts::sweep(&core.home, at(ts + 7 * DAY + 1)).unwrap();
    assert!(!trash.exists(), "gone after 7 days");
    assert_eq!(tree(&outside), kept);
    // At core start: an entry stamped long ago goes, a fresh one stays.
    fs::create_dir_all(core.trash().join("d4-1000")).unwrap();
    let fresh = core.trash().join(format!("e5-{}", unix_now()));
    fs::create_dir_all(&fresh).unwrap();
    core.crash_and_restart();
    assert!(!core.trash().join("d4-1000").exists());
    assert!(fresh.is_dir());
    assert_eq!(tree(&outside), kept);
}

// Acceptance `account_remove_logout_then_move`: the logout tab runs the agent's own logout with only the account's
// override, while the folder is still in place; exit 0 moves at once, a non-zero exit asks to confirm the leftovers
// and moves only after that confirm.
// Ticket 322: Your own runs the agent's own logout with no config override (an override would name another stored
// login), and its config folder stays where it is.
#[test]
fn own_logout_has_no_override() {
    let core = Core::new();
    let user = tree(&core.user);
    let r = core.owner(
        json!({"op":"account_remove","agent":"claude","id":"own","step":"logout","leftovers":false}),
    );
    assert!(r.get("Ok").is_some(), "{r}");
    let env = env_of(&core.wait("logout-claude.env"));
    assert_eq!(env["ARGV"], "auth logout");
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR"));
    assert_eq!(tree(&core.user), user);
}

#[test]
fn account_remove_logout_then_move() {
    let core = Core::new();
    let claude = core.add(Agent::Claude, "work");
    let session = core.logout(&claude);
    assert_eq!(session.label, "Logout: work");
    let env = env_of(&core.wait("logout-claude.env"));
    assert_eq!(env["ARGV"], "auth logout");
    assert_eq!(
        env["CLAUDE_CONFIG_DIR"],
        folder(&claude).display().to_string()
    );
    assert_eq!(env.get("FOLDER_PRESENT").map(String::as_str), Some("yes"));
    assert!(!env.contains_key("CODEX_HOME"));
    assert!(matches!(
        core.remove(&claude, RemoveStep::Move, false),
        Ok(Reply::AccountRemoved { .. })
    ));
    assert!(!folder(&claude).exists());

    // Codex: logout exits 3, so the move asks first and leaves the folder in place.
    fs::write(core.home.join("logout-code-codex"), "3").unwrap();
    let codex = core.add(Agent::Codex, "home");
    core.logout(&codex);
    let env = env_of(&core.wait("logout-codex.env"));
    assert_eq!(env["ARGV"], "logout");
    assert_eq!(env["CODEX_HOME"], folder(&codex).display().to_string());
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR"));
    match core.remove(&codex, RemoveStep::Move, false) {
        Ok(Reply::AccountLeftovers { code }) => assert_eq!(code, Some(3)),
        other => panic!("{other:?}"),
    }
    assert!(folder(&codex).is_dir());
    assert!(matches!(
        core.remove(&codex, RemoveStep::Move, true),
        Ok(Reply::AccountRemoved { .. })
    ));
    assert!(!folder(&codex).exists());

    // A move without any logout has no exit to go by: it asks too.
    let third = core.add(Agent::Claude, "third");
    assert!(matches!(
        core.remove(&third, RemoveStep::Move, false),
        Ok(Reply::AccountLeftovers { code: None })
    ));
    assert!(folder(&third).is_dir());
}

// Round 2: a `.logout-<id>` status of 0 left by an earlier attempt (logout, then a new login) never lets a later move skip
// the leftovers question: the check that starts every remove clears it.
#[test]
fn stale_logout_state_is_cleared_on_check() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    core.logout(&account);
    let state = core.home.join(format!(
        "accounts/claude/.logout-{}",
        account["id"].as_str().unwrap()
    ));
    assert_eq!(fs::read_to_string(&state).unwrap().trim(), "0");
    assert!(matches!(
        core.remove(&account, RemoveStep::Check, false),
        Ok(Reply::AccountRemoveCheck { .. })
    ));
    assert!(!state.exists());
    assert!(matches!(
        core.remove(&account, RemoveStep::Move, false),
        Ok(Reply::AccountLeftovers { code: None })
    ));
    assert!(folder(&account).is_dir());
}

// Round 2: a Start on the account prepared off the lock before the move (its `--version` still running) is refused
// when it reaches the lock after the move: no agent runs on the moved folder and none is made again.
#[test]
fn prepared_start_refused_after_move() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    let before = core.sessions().len();
    fs::write(core.home.join("hold"), "").unwrap();
    let home = core.home.clone();
    let project = core.project.clone();
    let start = thread::spawn(move || {
        call(
            &home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind: AgentKind::Claude,
                    project,
                    worktree: false,
                    label: "late".into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: Some("work".into()),
                },
            },
        )
    });
    core.wait("version-held");
    assert!(matches!(
        core.remove(&account, RemoveStep::Move, true),
        Ok(Reply::AccountRemoved { .. })
    ));
    fs::remove_file(core.home.join("hold")).unwrap();
    let err = start.join().unwrap().unwrap_err();
    assert!(err.contains("no longer in the account list"), "{err}");
    assert_eq!(core.sessions().len(), before);
    assert!(!folder(&account).exists(), "no agent made the folder again");
}

// Round 2: an entry deeper than the sweep's depth cap is left in place with a logged reason; the core still starts and
// sweeps the other old entries.
#[test]
fn trash_sweep_survives_a_deep_tree() {
    let mut core = Core::new();
    let deep = core.trash().join("a1-1000");
    // Past the cap (64 levels), well within PATH_MAX for this short home.
    let mut path = deep.clone();
    for _ in 0..100 {
        path.push("d");
    }
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("f"), "x").unwrap();
    // Siblings beside the deep branch, so a delete that started before finding the depth would show.
    for i in 0..30 {
        fs::write(deep.join(format!("s{i}")), "x").unwrap();
    }
    let whole = tree(&deep);
    fs::create_dir_all(core.trash().join("b2-1000/sub")).unwrap();
    core.crash_and_restart();
    assert_eq!(tree(&deep), whole, "the deep entry stays whole");
    assert!(
        !core.trash().join("b2-1000").exists(),
        "the others are swept"
    );
    let log = fs::read_to_string(core.home.join("core.log")).unwrap_or_default()
        + &fs::read_dir(core.home.join("logs"))
            .map(|d| {
                d.flatten()
                    .map(|e| fs::read_to_string(e.path()).unwrap_or_default())
                    .collect::<String>()
            })
            .unwrap_or_default();
    assert!(log.contains("a1-1000") && log.contains("deeper"), "{log}");
}

// A `git` ahead of the real one: while `hold-git` exists, a call on an account folder (the tab's prepare reads its HEAD
// off the registry lock) marks itself and waits, at most 3 s. Every other call is the real git.
const FAKE_GIT: &str = r#"#!/bin/sh
case "$2" in */accounts/*)
  if [ -e "$NUNCHIRO_HOME/hold-git" ]; then
    : > "$NUNCHIRO_HOME/git-held"
    i=0; while [ -e "$NUNCHIRO_HOME/hold-git" ] && [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done
  fi;;
esac
exec /usr/bin/git "$@"
"#;
impl Core {
    fn hold_git(&self) {
        let git = self.home.join("bin/git");
        fs::write(&git, FAKE_GIT).unwrap();
        fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(self.home.join("hold-git"), "").unwrap();
    }
    fn logout_in_background(&self, account: &Value) -> thread::JoinHandle<Response> {
        let (home, agent, id) = (
            self.home.clone(),
            serde_json::from_value(account["agent"].clone()).unwrap(),
            account["id"].as_str().unwrap().to_string(),
        );
        thread::spawn(move || {
            call(
                &home,
                Request::AccountRemove {
                    agent,
                    id,
                    step: RemoveStep::Logout,
                    leftovers: false,
                },
            )
        })
    }
}

// Acceptance `logout_refused_when_a_session_lands_before_the_tab`: a session recorded on the account after Logout's
// check passed and before its tab starts makes Logout refuse with the in-use wording; no logout tab exists.
#[test]
fn logout_refused_when_a_session_lands_before_the_tab() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    core.hold_git();
    let logout = core.logout_in_background(&account);
    // Logout passed its first check and is preparing its tab off the lock.
    core.wait("git-held");
    let late = core.start(AgentKind::Claude, "work", "late one");
    fs::remove_file(core.home.join("hold-git")).unwrap();
    let err = logout.join().unwrap().unwrap_err();
    assert_eq!(
        err, r#"account "work" is in use by "late one"; close them first"#,
        "{err}"
    );
    assert!(
        !core
            .sessions()
            .iter()
            .any(|s| s.label.starts_with("Logout:")),
        "no logout tab"
    );
    assert!(
        !core.home.join("logout-claude.env").exists(),
        "no logout ran"
    );
    assert_eq!(core.session(&late.id).state, SessionState::Running);
}

// Acceptance `check_and_tab_start_share_one_lock_hold`: the race the other way. A start prepared before Logout reaches
// the lock only after the tab started (so Logout succeeds). Ticket 32: that start is now refused there, so no session
// lands on the account (before, it was recorded and Move refused, naming it).
#[test]
fn check_and_tab_start_share_one_lock_hold() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    fs::write(core.home.join("hold"), "").unwrap();
    let (home, project) = (core.home.clone(), core.project.clone());
    let start = thread::spawn(move || {
        call(
            &home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind: AgentKind::Claude,
                    project,
                    worktree: false,
                    label: "after the tab".into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: Some("work".into()),
                },
            },
        )
    });
    core.wait("version-held");
    let tab = core.logout(&account);
    assert_eq!(tab.label, "Logout: work");
    fs::remove_file(core.home.join("hold")).unwrap();
    let err = start.join().unwrap().unwrap_err();
    assert!(err.contains("Logout: work"), "{err}");
    assert!(!core.sessions().iter().any(|s| s.label == "after the tab"));
    assert!(folder(&account).is_dir(), "the folder stays until Move");
}

// Ticket 32 acceptance `start_refused_while_account_logs_out`: a Start on the account prepared before Logout's check (its
// `--version` held) and recorded after the logout tab started is refused with the in-use wording, and no session is
// recorded; so is a new Start while the logout tab is listed. Move still refuses while anything stands in the folder.
#[test]
fn start_refused_while_account_logs_out() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    let before = core.sessions().len();
    let start = |home: PathBuf, project: PathBuf| {
        call(
            &home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind: AgentKind::Claude,
                    project,
                    worktree: false,
                    label: "late".into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: Some("work".into()),
                },
            },
        )
    };
    fs::write(core.home.join("hold"), "").unwrap();
    let (home, project) = (core.home.clone(), core.project.clone());
    let late = thread::spawn(move || start(home, project));
    // The Start is preparing off the lock; Logout's check passes and its tab starts.
    core.wait("version-held");
    let tab = core.logout(&account);
    fs::remove_file(core.home.join("hold")).unwrap();
    let in_use = r#"account "work" is in use by "Logout: work"; close them first"#;
    assert_eq!(late.join().unwrap().unwrap_err(), in_use);
    assert_eq!(
        start(core.home.clone(), core.project.clone()).unwrap_err(),
        in_use
    );
    let sessions = core.sessions();
    assert_eq!(
        sessions.len(),
        before + 1,
        "only the logout tab: {sessions:?}"
    );
    assert!(sessions.iter().any(|s| s.id == tab.id));
    // A shell standing in the folder is no agent on the account, but Move still refuses while it runs.
    let shell = match call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                kind: AgentKind::Shell,
                project: folder(&account),
                worktree: false,
                label: "inside".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
                account: None,
            },
        },
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    let err = core.remove(&account, RemoveStep::Move, true).unwrap_err();
    assert!(err.contains("inside"), "{err}");
    assert!(folder(&account).is_dir(), "the folder stays");
    assert_eq!(core.session(&shell.id).state, SessionState::Running);
}

// Acceptance `login_tab_unchanged`: the login tab (the other user of `tab`) runs the agent's own login in the account
// folder with only that folder as its override.
#[test]
fn login_tab_unchanged() {
    let core = Core::new();
    for (agent, name, variable) in [
        (Agent::Claude, "claude", "CLAUDE_CONFIG_DIR"),
        (Agent::Codex, "codex", "CODEX_HOME"),
    ] {
        let account = core.add(agent, "work");
        let env = env_of(&core.wait(&format!("login-{name}.env")));
        assert_eq!(env.get(variable).map(PathBuf::from), Some(folder(&account)));
        let tab = core
            .sessions()
            .into_iter()
            .find(|s| s.label == "Login: work" && s.project == folder(&account))
            .expect("login tab");
        assert_eq!(tab.kind, AgentKind::Shell);
    }
}

// Ticket 76: the logout mark is on disk, so a core restart keeps refusing agent starts on the account folder.
fn start_on(core: &Core, account: &str) -> Result<Reply, String> {
    call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                kind: AgentKind::Claude,
                project: core.project.clone(),
                worktree: false,
                label: "late".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
                account: Some(account.into()),
            },
        },
    )
}
fn logouts_file(core: &Core) -> Value {
    serde_json::from_str(&fs::read_to_string(core.home.join("logouts.json")).unwrap()).unwrap()
}

#[test]
fn logout_survives_core_restart() {
    let mut core = Core::new();
    let account = core.add(Agent::Claude, "work");
    core.logout(&account);
    core.crash_and_restart();
    assert_eq!(
        start_on(&core, "work").unwrap_err(),
        r#"account "work" is in use by "Logout: work"; close them first"#
    );
    let file = logouts_file(&core);
    assert_eq!(file["version"], 1);
    assert!(
        file["logouts"]
            .get(folder(&account).to_str().unwrap())
            .is_some(),
        "{file}"
    );
}

#[test]
fn logout_mark_ends_with_login_and_move() {
    let mut core = Core::new();
    let account = core.add(Agent::Claude, "work");
    core.logout(&account);
    core.crash_and_restart();
    assert!(matches!(
        core.remove(&account, RemoveStep::Move, false),
        Ok(Reply::AccountRemoved { .. })
    ));
    assert!(
        logouts_file(&core)["logouts"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    core.crash_and_restart();
    let refusal = start_on(&core, "work").unwrap_err();
    assert!(!refusal.contains("is in use by"), "{refusal}");
}

// Ticket 178 (needs 149 finding 9): a stale login tab is the account's only blocker. The refusal names it; closing it
// through the plain Close and running the remove again from Check passes, and the folder then goes to the trash.
fn add_held(core: &Core, agent: Agent, label: &str) -> (Value, Session) {
    fs::write(core.home.join("login-hold"), "").unwrap();
    match call(
        &core.home,
        Request::AccountAdd {
            agent,
            label: label.into(),
        },
    ) {
        Ok(Reply::AccountAdded { account, session }) => {
            core.wait(&format!("login-{}.env", accounts::agent_name(agent)));
            assert_eq!(core.session(&session.id).state, SessionState::Running);
            (serde_json::to_value(account).unwrap(), session)
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn close_and_remove_completes() {
    let core = Core::new();
    let (account, login) = add_held(&core, Agent::Claude, "work");
    let err = core.remove(&account, RemoveStep::Check, false).unwrap_err();
    assert_eq!(
        err, r#"account "work" is in use by "Login: work"; close them first"#,
        "{err}"
    );
    call(
        &core.home,
        Request::Close {
            id: login.id.clone(),
        },
    )
    .unwrap();
    assert!(matches!(
        core.remove(&account, RemoveStep::Check, false),
        Ok(Reply::AccountRemoveCheck { sessions: 0 })
    ));
    core.logout(&account);
    assert!(matches!(
        core.remove(&account, RemoveStep::Move, false),
        Ok(Reply::AccountRemoved { .. })
    ));
    assert!(!folder(&account).exists());
    assert!(
        core.listed()
            .iter()
            .all(|id| id != account["id"].as_str().unwrap())
    );
}

// Threat 3: a session that starts on the account between the close and the rerun is refused by the rerun's Check,
// named, and nothing moves.
#[test]
fn close_and_remove_refuses_session_landing_between() {
    let core = Core::new();
    let (account, login) = add_held(&core, Agent::Claude, "work");
    assert!(core.remove(&account, RemoveStep::Check, false).is_err());
    call(
        &core.home,
        Request::Close {
            id: login.id.clone(),
        },
    )
    .unwrap();
    let late = core.start(AgentKind::Claude, "work", "late one");
    for step in [RemoveStep::Check, RemoveStep::Logout, RemoveStep::Move] {
        let err = core.remove(&account, step, true).unwrap_err();
        assert_eq!(
            err, r#"account "work" is in use by "late one"; close them first"#,
            "{step:?}"
        );
    }
    assert!(folder(&account).exists());
    assert_eq!(core.session(&late.id).state, SessionState::Running);
    assert!(
        !core.home.join("logout-claude.env").exists(),
        "no logout ran"
    );
}

// Ticket 322: the default for new sessions is refused at the first remove step, also for a window with a stale list.
#[test]
fn default_account_is_not_removed() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    fs::write(
        core.home.join("settings.json"),
        json!({"features": {"accounts.default.claude": account["id"]}}).to_string(),
    )
    .unwrap();
    let err = core.remove(&account, RemoveStep::Check, false).unwrap_err();
    assert!(err.contains("default for new sessions"), "{err}");
    assert!(folder(&account).exists());
}

// Ticket 322 (security review): only tabs the core starts for an account carry the flag. A shell asking for the same
// folder and label does not, and a login step is for Your own alone.
#[test]
fn account_tab_flag_is_set_by_the_core_only() {
    let core = Core::new();
    let account = core.add(Agent::Claude, "work");
    let err = core.remove(&account, RemoveStep::Login, false).unwrap_err();
    assert!(err.contains("only the agent's own account"), "{err}");
    assert!(core.logout(&account).account_tab);
    let own = core.owner(
        json!({"op":"account_remove","agent":"claude","id":"own","step":"login","leftovers":false}),
    );
    assert_eq!(own["Ok"]["session"]["account_tab"], true, "{own}");
    assert_eq!(own["Ok"]["session"]["label"], "Login: Default", "{own}");
    let spoof = core.owner(json!({"op":"start","session":{
        "kind":"shell","project":core.user.join(".claude"),"label":"Login: Default","args":["/bin/cat"],
        "model":null,"effort":null,"resume":null,
    }}));
    assert!(spoof["Ok"]["session"]["id"].is_string(), "{spoof}");
    assert!(spoof["Ok"]["session"]["account_tab"].is_null(), "{spoof}");
}

// Ticket 509: a new user who installed Claude but never ran it has no ~/.claude. Sign in for "Your own" still starts the
// login tab (the folder is made, owner-only, as Claude makes it on first run); a folder that exists is left as it is.
#[test]
fn own_login_without_config_folder_starts() {
    let core = Core::new();
    let folder = core.user.join(".claude");
    fs::remove_dir_all(&folder).unwrap();
    let own = core.owner(
        json!({"op":"account_remove","agent":"claude","id":"own","step":"login","leftovers":false}),
    );
    assert_eq!(own["Ok"]["session"]["label"], "Login: Default", "{own}");
    let env = core.wait("login-claude.env");
    assert!(!env.contains("CLAUDE_CONFIG_DIR="), "{env}");
    let meta = fs::symlink_metadata(&folder).unwrap();
    assert!(meta.is_dir());
    assert_eq!(meta.permissions().mode() & 0o777, 0o700);
    // Nothing else is written in the user's home, and the Codex folder (present) is untouched.
    let mut names: Vec<_> = fs::read_dir(&core.user)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [".claude", ".codex"]);
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);

    // An existing folder keeps its mode.
    let codex = core.user.join(".codex");
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o755)).unwrap();
    let own = core.owner(
        json!({"op":"account_remove","agent":"codex","id":"own","step":"login","leftovers":false}),
    );
    assert_eq!(own["Ok"]["session"]["label"], "Login: Default", "{own}");
    core.wait("login-codex.env");
    assert_eq!(
        fs::metadata(&codex).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

// Ticket 509 review r1: a relative config variable (a literal `~` set without shell expansion, or any relative value) is
// never made relative to the core's working folder; the press fails as before and nothing is created anywhere.
#[test]
fn own_login_relative_config_folder_makes_nothing() {
    for value in ["~", "rel/claude"] {
        let core = Core::with(&[("CLAUDE_CONFIG_DIR", value)]);
        let own = core.owner(
            json!({"op":"account_remove","agent":"claude","id":"own","step":"login","leftovers":false}),
        );
        assert!(own["Err"].is_string(), "{value}: {own}");
        assert_eq!(
            fs::read_dir(core.home.join("cwd")).unwrap().count(),
            0,
            "{value}"
        );
        assert!(
            !core.home.join("~").exists() && !core.user.join("~").exists(),
            "{value}"
        );
        assert!(!core.home.join("login-claude.env").exists(), "{value}");
    }
}
