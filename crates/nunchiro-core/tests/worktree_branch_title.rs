//! Ticket 991 (Q7 point 1): a worktree made with the generated branch name (`wt-xxxx`, nothing typed) gets its branch
//! named from the first prompt of a session in it, once, at the next worktree request. Each test runs a real
//! `nunchiro serve` on a short home with a temp repository and a fake Claude that only stays open.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const FAKE_CLAUDE: &str = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit 0; fi\nif [ \"$1 $2\" = 'auth status' ]; then exit 2; fi\nexec cat >/dev/null\n";

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Core {
    home: PathBuf,
    repo: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    fn new(tag: &str) -> Self {
        let home = home::short(tag);
        fs::write(home.join("claude"), FAKE_CLAUDE).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        let repo = home.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let path = format!("{}:/usr/bin:/bin", home.display());
        let config = home.join("claude-home");
        let envs = [
            ("PATH", path.as_str()),
            ("HOME", home.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
        ];
        let serve = home::spawn_serve(&home, &envs);
        Self {
            home,
            repo,
            _serve: serve,
        }
    }
    fn worktree(&self, operation: &str, from: Option<&str>, branch: Option<&str>) -> Vec<Worktree> {
        let request = Request::Worktree {
            operation: operation.into(),
            project: (operation == "create").then(|| self.repo.clone()),
            path: None,
            branch: branch.map(String::from),
            base: "HEAD".into(),
            label: String::new(),
            from: from.map(String::from),
            confirm: None,
        };
        match call(&self.home, request) {
            Ok(Reply::Worktrees { worktrees, .. }) => worktrees,
            other => panic!("worktree {operation}: {other:?}"),
        }
    }
    /// The window's one field, as the composer's "New worktree" sends it (`from` empty: the generated name).
    fn create(&self, from: &str) -> Worktree {
        self.worktree("create", Some(from), None).pop().unwrap()
    }
    /// The record of `path` as the next worktree request lists it: the request that applies a title.
    fn listed(&self, path: &Path) -> Worktree {
        let all = self.worktree("list", None, None);
        all.into_iter().find(|w| w.path == path).unwrap()
    }
    /// A Claude session in `folder`, with no name, as the composer starts it.
    fn session_in(&self, folder: &Path) -> String {
        let session = StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: self.repo.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        };
        let request = Request::Start {
            receipt: None,
            env: Default::default(),
            folder: Some(folder.to_path_buf()),
            session,
        };
        match call(&self.home, request) {
            Ok(Reply::Started { session }) => {
                assert_eq!(session.cwd, folder);
                session.id
            }
            other => panic!("start: {other:?}"),
        }
    }
    /// Claude's own prompt hook: the session's first one gives it its title.
    fn prompt(&self, id: &str, text: &str) {
        let request = Request::Hook {
            id: id.into(),
            event: "UserPromptSubmit".into(),
            payload: json!({ "prompt": text }),
        };
        call(&self.home, request).unwrap();
    }
    fn label(&self, id: &str) -> String {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&self.home, Request::Snapshot) else {
            panic!("snapshot");
        };
        sessions.into_iter().find(|s| s.id == id).unwrap().label
    }
    fn head(&self, folder: &Path) -> String {
        git(folder, &["symbolic-ref", "--short", "HEAD"])
    }
    fn has_branch(&self, branch: &str) -> bool {
        let name = format!("refs/heads/{branch}");
        !git(&self.repo, &["for-each-ref", "--format=%(refname)", &name]).is_empty()
    }
    /// A worktree with the generated name and a session in it; (record, session id).
    fn generated(&self) -> (Worktree, String) {
        let made = self.create("");
        assert!(made.auto_branch, "{made:?}");
        assert!(made.branch.starts_with("wt-"), "{made:?}");
        assert_eq!(self.head(&made.path), made.branch);
        let id = self.session_in(&made.path);
        (made, id)
    }
    /// After a title that must not rename: the branch, the label and the folder are as made, and the one chance is used.
    fn assert_kept(&self, made: &Worktree, why: &str) {
        let now = self.listed(&made.path);
        assert_eq!(now.branch, made.branch, "{why}");
        assert_eq!(now.label, made.label, "{why}");
        assert!(!now.auto_branch, "{why}: asked once");
        assert!(self.has_branch(&made.branch), "{why}");
    }
}

#[test]
fn generated_branch_is_named_once_from_the_first_prompt() {
    let core = Core::new("wtt-once");
    let (made, id) = core.generated();
    // A slash command gives no title, so it names nothing and uses nothing up.
    core.prompt(&id, "/model sonnet");
    let still = core.listed(&made.path);
    assert_eq!(
        (still.branch.as_str(), still.auto_branch),
        (made.branch.as_str(), true)
    );
    core.prompt(&id, "Fix the login bug in app.py\nand more below");
    assert_eq!(core.label(&id), "Fix the login bug in app.py");
    let named = core.listed(&made.path);
    assert_eq!(named.branch, "fix-the-login-bug-in-app-py");
    assert_eq!(
        named.label, "fix-the-login-bug-in-app-py",
        "the generated label follows"
    );
    assert!(!named.auto_branch);
    // Git: the worktree's HEAD moved with the branch, the old name is gone, and the folder is where it was.
    assert_eq!(core.head(&made.path), "fix-the-login-bug-in-app-py");
    assert!(!core.has_branch(&made.branch));
    assert_eq!(named.path, made.path);
    assert!(made.path.join(".git").exists());
    // A second prompt, and a second session's first prompt in the same folder, rename nothing.
    core.prompt(&id, "Now do something else entirely");
    let other = core.session_in(&made.path);
    core.prompt(&other, "A different first prompt");
    assert_eq!(core.label(&other), "A different first prompt");
    let after = core.listed(&made.path);
    assert_eq!(after.branch, "fix-the-login-bug-in-app-py");
    assert_eq!(core.head(&made.path), "fix-the-login-bug-in-app-py");
    assert!(!core.has_branch("a-different-first-prompt"));
}

#[test]
fn the_name_keeps_the_prefix_fits_forty_characters_and_steps_past_a_taken_one() {
    let core = Core::new("wtt-name");
    let patch = LifetimePatch {
        features: Some([("git.branch_prefix".into(), "nunchiro/".into())].into()),
        ..Default::default()
    };
    call(&core.home, Request::QuitSettings { patch }).unwrap();
    // The title is cut at 40 characters before the name is made: no hyphen is left at the end.
    let made = core.create("");
    assert!(made.branch.starts_with("nunchiro/wt-"), "{made:?}");
    let id = core.session_in(&made.path);
    core.prompt(
        &id,
        "Add a tax(rate) function to app.py with a test, then run the tests",
    );
    let named = core.listed(&made.path);
    assert_eq!(
        named.branch,
        "nunchiro/add-a-tax-rate-function-to-app-py-with"
    );
    assert_eq!(named.label, "add-a-tax-rate-function-to-app-py-with");
    let name = named.branch.strip_prefix("nunchiro/").unwrap();
    assert!(
        name.len() <= 40
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    );
    assert_eq!(core.head(&made.path), named.branch);
    // The same title again: the name is taken, so "-2", then "-3" (a branch of that name with no worktree counts too).
    git(&core.repo, &["branch", "nunchiro/same-words-3"]);
    for want in [
        "nunchiro/same-words",
        "nunchiro/same-words-2",
        "nunchiro/same-words-4",
    ] {
        let made = core.create("");
        let id = core.session_in(&made.path);
        core.prompt(&id, "Same words");
        assert_eq!(core.listed(&made.path).branch, want);
        assert_eq!(core.head(&made.path), want);
    }
}

#[test]
fn a_branch_the_user_named_is_never_renamed() {
    let core = Core::new("wtt-user");
    // Typed in the one field, and typed as the branch itself (Advanced): neither is the generated name.
    let typed = core.create("my feature");
    assert_eq!(
        (typed.branch.as_str(), typed.auto_branch),
        ("my-feature", false)
    );
    let exact = core
        .worktree("create", None, Some("wt-mine"))
        .pop()
        .unwrap();
    assert_eq!(
        (exact.branch.as_str(), exact.auto_branch),
        ("wt-mine", false)
    );
    for made in [&typed, &exact] {
        let id = core.session_in(&made.path);
        core.prompt(&id, "Rename me if you dare");
        let now = core.listed(&made.path);
        assert_eq!(
            (now.branch.as_str(), now.label.as_str()),
            (made.branch.as_str(), made.label.as_str())
        );
        assert_eq!(core.head(&made.path), made.branch);
    }
    assert!(!core.has_branch("rename-me-if-you-dare"));
    // The user renamed the generated branch by hand before the first prompt: HEAD is no longer the recorded branch.
    let (made, id) = core.generated();
    git(&made.path, &["branch", "-m", "by-hand"]);
    core.prompt(&id, "Rename me if you dare");
    assert_eq!(core.head(&made.path), "by-hand");
    assert!(!core.has_branch("rename-me-if-you-dare"));
    assert!(!core.listed(&made.path).auto_branch);
}

#[test]
fn a_pushed_or_tracking_branch_is_not_renamed() {
    let core = Core::new("wtt-pushed");
    let remote = core.home.join("remote.git");
    git(
        &core.home,
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(
        &core.repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&core.repo, &["push", "-q", "origin", "main"]);
    // Pushed with no upstream set: the remote has a branch of that name.
    let (made, id) = core.generated();
    git(&made.path, &["push", "-q", "origin", &made.branch]);
    core.prompt(&id, "Pushed already");
    core.assert_kept(&made, "pushed");
    // An upstream set, nothing pushed under its own name.
    let (made, id) = core.generated();
    git(
        &made.path,
        &["branch", "-q", "--set-upstream-to=origin/main"],
    );
    core.prompt(&id, "Tracks a branch");
    core.assert_kept(&made, "upstream");
    assert!(!core.has_branch("pushed-already") && !core.has_branch("tracks-a-branch"));
    // Neither holds: named, with the remote there.
    let (made, id) = core.generated();
    core.prompt(&id, "Still local");
    assert_eq!(core.listed(&made.path).branch, "still-local");
}

#[test]
fn a_moved_head_renames_nothing() {
    let core = Core::new("wtt-head");
    // The worktree is on another branch now.
    let (made, id) = core.generated();
    git(&made.path, &["switch", "-q", "-c", "elsewhere"]);
    core.prompt(&id, "Head moved away");
    core.assert_kept(&made, "another branch checked out");
    assert_eq!(core.head(&made.path), "elsewhere");
    // Detached.
    let (made, id) = core.generated();
    git(&made.path, &["switch", "-q", "--detach"]);
    core.prompt(&id, "Head is detached");
    core.assert_kept(&made, "detached");
    assert!(!core.has_branch("head-moved-away") && !core.has_branch("head-is-detached"));
}

// The owner writes Korean: the name keeps the title's own script (Unicode letters and digits, ASCII lowercased).
#[test]
fn a_title_in_another_script_names_the_branch_and_an_emoji_only_title_keeps_the_chance() {
    let core = Core::new("wtt-script");
    let (made, id) = core.generated();
    core.prompt(&id, "로그인 버그를 고쳐 줘");
    assert_eq!(core.label(&id), "로그인 버그를 고쳐 줘");
    let named = core.listed(&made.path);
    assert_eq!(named.branch, "로그인-버그를-고쳐-줘");
    assert_eq!(named.label, "로그인-버그를-고쳐-줘");
    assert!(!named.auto_branch);
    assert_eq!(core.head(&made.path), "로그인-버그를-고쳐-줘");
    assert!(!core.has_branch(&made.branch));
    // Mixed scripts, punctuation and a number; then the same words again take "-2".
    for want in ["fix-로그인-bug-12", "fix-로그인-bug-12-2"] {
        let (made, id) = core.generated();
        core.prompt(&id, "Fix 로그인 bug #12!");
        assert_eq!(core.listed(&made.path).branch, want);
        assert_eq!(core.head(&made.path), want);
    }
    // Nothing to make a name of: the generated name stays and so does the mark, for the next title in the folder.
    let (made, id) = core.generated();
    core.prompt(&id, "🎉🎉");
    assert_eq!(core.label(&id), "🎉🎉");
    let kept = core.listed(&made.path);
    assert_eq!(
        (kept.branch.as_str(), kept.auto_branch),
        (made.branch.as_str(), true)
    );
    assert_eq!(core.head(&made.path), made.branch);
    let next = core.session_in(&made.path);
    core.prompt(&next, "日本語のタイトル");
    let named = core.listed(&made.path);
    assert_eq!(
        (named.branch.as_str(), named.auto_branch),
        ("日本語のタイトル", false)
    );
    assert_eq!(core.head(&made.path), "日本語のタイトル");
}
