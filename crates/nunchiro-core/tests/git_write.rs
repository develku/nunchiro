//! The Diff panel's Push, run by the app: `git_write::push` against a local bare remote in a temp folder. The confirmed
//! head commit is checked again, the default branch, a detached HEAD and a branch behind its remote are refused, a
//! first push sets the upstream, and a refusal (the remote's hook, a pre-push hook) comes back as a sentence with git's
//! own lines under it. Nothing here reaches a network remote.
#[path = "fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::git_write::{self, Pushed};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_env::scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
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

/// A temp folder holding `origin.git` (bare, HEAD main) and `work`, a clone on `main` with one pushed commit.
struct Repo {
    root: PathBuf,
}
impl Repo {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("nunchiro-gw-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        git(&root, &["init", "-q", "-b", "main", "work"]);
        let r = Self { root };
        r.commit("base");
        git(
            &r.work(),
            &["remote", "add", "origin", r.origin().to_str().unwrap()],
        );
        git(&r.work(), &["push", "-q", "-u", "origin", "main"]);
        git(&r.work(), &["remote", "set-head", "origin", "main"]);
        r
    }
    fn work(&self) -> PathBuf {
        self.root.join("work")
    }
    fn origin(&self) -> PathBuf {
        self.root.join("origin.git")
    }
    fn commit(&self, msg: &str) {
        git(&self.work(), &["commit", "-q", "--allow-empty", "-m", msg]);
    }
    fn head(&self) -> String {
        git(&self.work(), &["rev-parse", "HEAD"])
    }
    /// The bare remote's `refs/heads/<branch>`, or "" when it has none.
    fn remote(&self, branch: &str) -> String {
        let out = git_env::scrubbed("git")
            .arg("-C")
            .arg(self.origin())
            .args([
                "rev-parse",
                "--verify",
                "-q",
                &format!("refs/heads/{branch}"),
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    /// A branch with `n` local commits, tracking `origin/<name>` that holds the base.
    fn tracked(&self, name: &str, n: usize) {
        git(&self.work(), &["checkout", "-q", "-b", name]);
        git(&self.work(), &["push", "-q", "-u", "origin", name]);
        for i in 0..n {
            self.commit(&format!("change {i}"));
        }
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn hook(dir: &Path, name: &str, script: &str) {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn push_moves_the_remote_branch_to_the_confirmed_head() {
    let r = Repo::new("ahead");
    r.tracked("parser-fix", 3);
    let head = r.head();
    let got = git_write::push(&r.work(), &head).unwrap();
    assert_eq!(
        got,
        Pushed {
            pushed: 3,
            remote: "origin".into(),
            branch: "parser-fix".into()
        }
    );
    assert_eq!(r.remote("parser-fix"), head);
}

#[test]
fn push_refuses_a_head_that_changed_after_it_was_shown() {
    let r = Repo::new("changed");
    r.tracked("parser-fix", 1);
    let shown = r.head();
    let before = r.remote("parser-fix");
    r.commit("made after the strip showed");
    let e = git_write::push(&r.work(), &shown).unwrap_err();
    let new = &r.head()[..7];
    assert_eq!(
        e,
        format!("nothing was sent: the branch changed after this was shown (new head {new})")
    );
    assert_eq!(r.remote("parser-fix"), before, "the remote moved");
}

#[test]
fn push_refuses_default_detached_behind_and_nothing_ahead() {
    let r = Repo::new("refuse");
    // The default branch, one commit ahead of origin/main.
    r.commit("on main");
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert_eq!(e, "not pushed: this is the default branch");
    // Detached.
    git(&r.work(), &["checkout", "-q", "--detach"]);
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert_eq!(e, "not pushed: HEAD is not on a branch");
    // Nothing ahead.
    git(&r.work(), &["checkout", "-q", "-b", "same"]);
    git(&r.work(), &["push", "-q", "-u", "origin", "same"]);
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert_eq!(e, "not pushed: there are no new commits to push");
    // Behind 1 (and ahead 1): the remote gained a commit this clone lacks.
    let other = r.root.join("other");
    git(
        &r.root,
        &["clone", "-q", r.origin().to_str().unwrap(), "other"],
    );
    git(&other, &["checkout", "-q", "same"]);
    git(&other, &["commit", "-q", "--allow-empty", "-m", "theirs"]);
    git(&other, &["push", "-q", "origin", "same"]);
    git(&r.work(), &["fetch", "-q", "origin"]);
    r.commit("mine");
    let theirs = r.remote("same");
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert_eq!(e, "not pushed: origin has newer commits on same");
    assert_eq!(r.remote("same"), theirs, "the remote moved");
}

#[test]
fn first_push_sets_the_upstream() {
    let r = Repo::new("upstream");
    git(&r.work(), &["checkout", "-q", "-b", "new-work"]);
    r.commit("one");
    r.commit("two");
    let head = r.head();
    let got = git_write::push(&r.work(), &head).unwrap();
    assert_eq!((got.pushed, got.branch.as_str()), (2, "new-work"));
    assert_eq!(r.remote("new-work"), head);
    assert_eq!(
        git(&r.work(), &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/new-work"
    );
}

#[test]
fn a_rejecting_remote_and_a_failing_pre_push_hook_are_sentences() {
    let r = Repo::new("hooks");
    r.tracked("parser-fix", 1);
    let before = r.remote("parser-fix");
    hook(
        &r.origin().join("hooks"),
        "pre-receive",
        "#!/bin/sh\necho 'policy: no pushes today' >&2\nexit 1\n",
    );
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert!(
        e.starts_with("not pushed: origin refused the push\n"),
        "{e}"
    );
    assert!(e.contains("policy: no pushes today"), "{e}");
    fs::remove_file(r.origin().join("hooks/pre-receive")).unwrap();
    // The folder's own pre-push hook runs, as it does for a push in a terminal.
    let lines: String = (1..=30)
        .map(|i| format!("echo 'check {i}' >&2\n"))
        .collect();
    hook(
        &r.work().join(".git/hooks"),
        "pre-push",
        &format!("#!/bin/sh\n{lines}exit 1\n"),
    );
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert!(
        e.starts_with("not pushed: the pre-push hook failed\n"),
        "{e}"
    );
    assert!(
        e.contains("check 30") && !e.contains("check 10\n"),
        "the last 20 lines: {e}"
    );
    assert_eq!(r.remote("parser-fix"), before, "the remote moved");
}

#[test]
fn several_remotes_and_none_chosen_is_refused_with_the_list() {
    let r = Repo::new("remotes");
    git(&r.work(), &["remote", "rename", "origin", "upstream"]);
    git(
        &r.work(),
        &["remote", "add", "fork", r.origin().to_str().unwrap()],
    );
    git(&r.work(), &["checkout", "-q", "-b", "new-work"]);
    r.commit("one");
    let e = git_write::push(&r.work(), &r.head()).unwrap_err();
    assert_eq!(
        e,
        "not pushed: this branch has no remote set and there are several (fork, upstream)"
    );
    // remote.pushDefault picks one.
    git(&r.work(), &["config", "remote.pushDefault", "fork"]);
    let got = git_write::push(&r.work(), &r.head()).unwrap();
    assert_eq!(got.remote, "fork");
}
