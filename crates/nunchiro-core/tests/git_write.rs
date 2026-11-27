//! The Diff panel's Push, run by the app: `git_write::push` against a local bare remote in a temp folder. The confirmed
//! head commit is checked again, the default branch, a detached HEAD and a branch behind its remote are refused, a
//! first push sets the upstream, and a refusal (the remote's hook, a pre-push hook) comes back as a sentence with git's
//! own lines under it. Nothing here reaches a network remote.
#[path = "fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::git_write::{self, Pushed, Shown};
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

/// What the strip shows for `dir` now (the window reads it from the Diff list's git facts); a state with no push target
/// shows the head alone.
fn shown(dir: &Path) -> Shown {
    git_write::shown(dir).unwrap_or_else(|| Shown {
        head: git(dir, &["rev-parse", "HEAD"]),
        ..Default::default()
    })
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
    let got = git_write::push(&r.work(), &shown(&r.work())).unwrap();
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
    let strip = shown(&r.work());
    let before = r.remote("parser-fix");
    r.commit("made after the strip showed");
    let e = git_write::push(&r.work(), &strip).unwrap_err();
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
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert_eq!(e, "not pushed: this is the default branch");
    // Detached.
    git(&r.work(), &["checkout", "-q", "--detach"]);
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert_eq!(e, "not pushed: HEAD is not on a branch");
    // Nothing ahead.
    git(&r.work(), &["checkout", "-q", "-b", "same"]);
    git(&r.work(), &["push", "-q", "-u", "origin", "same"]);
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
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
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
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
    let got = git_write::push(&r.work(), &shown(&r.work())).unwrap();
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
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
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
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
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
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert_eq!(
        e,
        "not pushed: this branch has no remote set and there are several (fork, upstream)"
    );
    // remote.pushDefault picks one.
    git(&r.work(), &["config", "remote.pushDefault", "fork"]);
    let got = git_write::push(&r.work(), &shown(&r.work())).unwrap();
    assert_eq!(got.remote, "fork");
}

#[test]
fn push_refuses_when_where_it_goes_changed_after_the_strip() {
    let r = Repo::new("target");
    r.tracked("shown-branch", 1);
    git(&r.work(), &["push", "-q", "origin", "main:release"]);
    // Another branch name at the same head.
    let strip = shown(&r.work());
    git(&r.work(), &["checkout", "-q", "-b", "other-branch"]);
    let e = git_write::push(&r.work(), &strip).unwrap_err();
    assert_eq!(
        e,
        "nothing was sent: where this pushes changed after this was shown (now origin/other-branch)"
    );
    assert_eq!(r.remote("other-branch"), "");
    // The same branch, its upstream moved to another remote branch.
    git(&r.work(), &["checkout", "-q", "shown-branch"]);
    let strip = shown(&r.work());
    git(&r.work(), &["fetch", "-q", "origin"]);
    git(&r.work(), &["branch", "-q", "-u", "origin/release"]);
    let release = r.remote("release");
    let e = git_write::push(&r.work(), &strip).unwrap_err();
    assert!(e.starts_with("nothing was sent: where this pushes changed"), "{e}");
    assert_eq!(r.remote("release"), release, "origin/release moved");
    // The same names, the remote's push URL changed.
    git(&r.work(), &["branch", "-q", "-u", "origin/shown-branch"]);
    let strip = shown(&r.work());
    git(&r.root, &["init", "-q", "--bare", "-b", "main", "elsewhere.git"]);
    let elsewhere = r.root.join("elsewhere.git");
    git(&r.work(), &["remote", "set-url", "--push", "origin", elsewhere.to_str().unwrap()]);
    let e = git_write::push(&r.work(), &strip).unwrap_err();
    assert!(e.starts_with("nothing was sent: where this pushes changed"), "{e}");
}

#[test]
fn push_sends_no_tags_and_no_submodules() {
    let r = Repo::new("tags");
    r.tracked("parser-fix", 1);
    git(&r.work(), &["config", "push.followTags", "true"]);
    git(&r.work(), &["config", "push.recurseSubmodules", "on-demand"]);
    git(&r.work(), &["tag", "-a", "-m", "private", "v9", "HEAD"]);
    git_write::push(&r.work(), &shown(&r.work())).unwrap();
    let tags = git(&r.origin(), &["tag", "--list"]);
    assert_eq!(tags, "", "a tag went out");
}

#[test]
fn the_push_remotes_own_default_branch_is_refused() {
    let r = Repo::new("forkdefault");
    git(&r.root, &["init", "-q", "--bare", "-b", "trunk", "fork.git"]);
    let fork = r.root.join("fork.git");
    git(&r.work(), &["remote", "add", "fork", fork.to_str().unwrap()]);
    git(&r.work(), &["push", "-q", "fork", "main:trunk"]);
    git(&r.work(), &["remote", "set-head", "fork", "trunk"]);
    git(&r.work(), &["checkout", "-q", "-b", "work", "--track", "fork/trunk"]);
    r.commit("on the fork's default");
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert_eq!(e, "not pushed: this is the default branch");
}

/// A remote reached through `core.sshCommand` set to a script: what git prints when sign-in fails or the network is
/// down, and a push that never ends.
fn ssh_remote(r: &Repo, script: &str) {
    let bin = r.root.join("fake-ssh");
    fs::write(&bin, script).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    git(&r.work(), &["config", "core.sshCommand", bin.to_str().unwrap()]);
    git(&r.work(), &["remote", "set-url", "--push", "origin", "ssh://git@example.invalid/o/r.git"]);
}

#[test]
fn sign_in_network_and_timeout_failures_are_sentences() {
    let r = Repo::new("ssh");
    r.tracked("parser-fix", 1);
    ssh_remote(&r, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n");
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert!(e.starts_with("not pushed: git needs you to sign in\n"), "{e}");
    ssh_remote(&r, "#!/bin/sh\necho 'ssh: connect to host example.invalid port 22: Network is unreachable' >&2\nexit 255\n");
    let e = git_write::push(&r.work(), &shown(&r.work())).unwrap_err();
    assert!(e.starts_with("not pushed: git push failed\n") && e.contains("Network is unreachable"), "{e}");
    ssh_remote(&r, "#!/bin/sh\nexec /bin/sleep 30\n");
    let e = git_write::push_within(&r.work(), &shown(&r.work()), std::time::Duration::from_secs(2)).unwrap_err();
    assert_eq!(e, "not pushed: git push did not finish in 2 seconds");
}
