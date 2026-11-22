//! Ticket 374: a new worktree's base (origin's default branch, fetched first), through the window's create, with a
//! local bare "GitHub" (a `url.<path>.insteadOf` rewrite stands in for github.com). No test here runs `gh`: the PR
//! link's tests are in tests/worktree_facts.rs, with a fake `gh` on the core's PATH.
use crate::api::{Request, Worktree, WorktreeLoss};
use crate::sessions::Sessions;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=F", "-c", "user.email=f@example.invalid"])
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
fn root(name: &str) -> PathBuf {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::fs::canonicalize(home).unwrap()
}
const URL: &str = "https://github.com/acme/demo.git";
/// A bare origin (`main` at one commit), a writer that pushes to it, and the project: a clone whose origin reads as
/// github.com/acme/demo, checked out on a feature branch with a local commit.
fn repos(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = root(name);
    git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    let origin = root.join("origin.git");
    git(&root, &["clone", "-q", "origin.git", "writer"]);
    let writer = root.join("writer");
    git(&writer, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&writer, &["push", "-q", "origin", "HEAD:main"]);
    git(&root, &["clone", "-q", "origin.git", "project"]);
    let project = std::fs::canonicalize(root.join("project")).unwrap();
    let rewrite = format!("url.{}.insteadOf", origin.display());
    git(&project, &["config", &rewrite, URL]);
    git(&project, &["remote", "set-url", "origin", URL]);
    git(&project, &["switch", "-q", "-c", "feature"]);
    git(
        &project,
        &["commit", "-q", "--allow-empty", "-m", "local work"],
    );
    (root, writer, project)
}
fn create(
    core: &Sessions,
    project: &Path,
    from: &str,
    branch: Option<&str>,
    base: &str,
) -> Result<Vec<Worktree>, String> {
    core.worktree_plan(
        None,
        Request::Worktree {
            operation: "create".into(),
            project: Some(project.to_path_buf()),
            path: None,
            branch: branch.map(String::from),
            base: base.into(),
            label: String::new(),
            from: Some(from.into()),
            confirm: None,
        },
    )?
    .run()
    .map(|r| r.0)
}
fn remove(core: &Sessions, path: &Path) -> Option<WorktreeLoss> {
    core.worktree_plan(
        None,
        Request::Worktree {
            operation: "remove".into(),
            project: None,
            path: Some(path.to_path_buf()),
            branch: None,
            base: "HEAD".into(),
            label: String::new(),
            from: None,
            confirm: None,
        },
    )
    .unwrap()
    .run()
    .unwrap()
    .2
}
fn stale(w: &Worktree) -> Option<String> {
    serde_json::to_value(w).unwrap()["stale_base"]
        .as_str()
        .map(String::from)
}

// Acceptance 4 and threat 3: with the main folder on a feature branch and GitHub main ahead, a new worktree starts at
// GitHub main's latest, shows no unpushed commits and removes without asking; one with a real commit still asks.
// Offline it starts at the last fetched main and says so; a typed HEAD keeps the old base.
#[test]
fn new_worktree_starts_from_origin_default_and_owns_no_phantom_commits() {
    let (root, writer, project) = repos("wtb-default");
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let core = Sessions::open(&home).unwrap();
    git(
        &writer,
        &["commit", "-q", "--allow-empty", "-m", "on github"],
    );
    git(&writer, &["push", "-q", "origin", "HEAD:main"]);
    let latest = git(&writer, &["rev-parse", "HEAD"]);

    let made = create(&core, &project, "fix-login", None, "").unwrap();
    let w = made.last().unwrap().clone();
    assert_eq!(git(&w.path, &["rev-parse", "HEAD"]), latest);
    assert_eq!(stale(&w), None, "fetched: no note");
    assert_eq!(w.facts.as_ref().unwrap().unpushed, 0, "no phantom commits");
    assert_eq!(remove(&core, &w.path), None, "removes without asking");
    assert!(!w.path.exists());

    let w = create(&core, &project, "real", None, "")
        .unwrap()
        .pop()
        .unwrap();
    git(&w.path, &["commit", "-q", "--allow-empty", "-m", "mine"]);
    let loss = remove(&core, &w.path).expect("a real commit still asks");
    assert_eq!(loss.unpushed_total, 1);
    assert!(w.path.exists());

    // Offline: GitHub moved on, but this Mac cannot reach it.
    git(&writer, &["commit", "-q", "--allow-empty", "-m", "unseen"]);
    git(&writer, &["push", "-q", "origin", "HEAD:main"]);
    let rewrite = format!("url.{}.insteadOf", root.join("gone.git").display());
    git(
        &project,
        &[
            "config",
            "--unset-all",
            &format!("url.{}.insteadOf", root.join("origin.git").display()),
        ],
    );
    git(&project, &["config", &rewrite, URL]);
    let w = create(&core, &project, "offline", None, "")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        git(&w.path, &["rev-parse", "HEAD"]),
        latest,
        "last fetched main"
    );
    assert_eq!(stale(&w).as_deref(), Some("main"));

    let w = create(&core, &project, "old-way", None, "HEAD")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        git(&w.path, &["rev-parse", "HEAD"]),
        git(&project, &["rev-parse", "HEAD"]),
        "a typed HEAD keeps the main folder's commit"
    );
    let _ = std::fs::remove_dir_all(root);
}

// A project with no origin keeps HEAD, as before.
#[test]
fn no_origin_keeps_head() {
    let root = root("wtb-noorigin");
    let project = root.join("p");
    std::fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
    git(&project, &["commit", "-q", "--allow-empty", "-m", "x"]);
    let core = Sessions::open(&root.join("home")).unwrap();
    let w = create(&core, &project, "n", None, "")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        git(&w.path, &["rev-parse", "HEAD"]),
        git(&project, &["rev-parse", "HEAD"])
    );
    let _ = std::fs::remove_dir_all(root);
}
