//! Settings › Git "Keep default branch up to date" (final.html new.autoPull; `git.auto_pull`, off by default). Every 15
//! minutes a project checkout that sits clean on its default branch, with no session running in it, takes a
//! fast-forward from origin. After Orca's "keep local main up to date" (idea only): uncommitted changes and local-only
//! commits are left alone.
use crate::sessions::Sessions;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const EVERY: Duration = Duration::from_secs(15 * 60);
const LOCAL: Duration = Duration::from_secs(10);
/// Long, because a timeout kills git: mid-merge that would leave a lock file in the user's repository.
const SLOW: Duration = Duration::from_secs(120);
/// Nobody is watching this run, so a repository's hooks do not fire from it.
pub(crate) const NO_HOOKS: [&str; 2] = ["-c", "core.hooksPath=/dev/null"];
/// Ticket 374: a pasted PR's checkout (a fork's content) does not recurse into submodules, whatever the user's config.
pub(crate) const NO_SUBMODULES: [&str; 2] = ["-c", "submodule.recurse=false"];

fn text(dir: &Path, args: &[&str]) -> Result<String, String> {
    crate::process::git_read(dir, args, LOCAL)
        .map(|o| String::from_utf8_lossy(&o).trim().to_string())
}

/// Origin's default branch name (`main`), read from the local `origin/HEAD`; Err with no origin or no `origin/HEAD`.
/// Shared with a new worktree's base (ticket 374).
pub(crate) fn origin_default(project: &Path) -> Result<String, String> {
    let origin = text(
        project,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    origin
        .strip_prefix("origin/")
        .filter(|b| !b.is_empty())
        .map(String::from)
        .ok_or_else(|| "origin/HEAD is not on origin".into())
}

/// Fast-forwards `project` when it qualifies. An Err (no origin, offline, a diverged branch) changes nothing; `pass` logs it.
fn update(project: &Path) -> Result<(), String> {
    let head = ["symbolic-ref", "--quiet", "--short"];
    let branch = &origin_default(project)?;
    if text(project, &[&head[..], &["HEAD"]].concat())? != *branch
        || !text(project, &["status", "--porcelain"])?.is_empty()
    {
        return Ok(());
    }
    // The name comes from the remote and a ref may start with a dash: the full ref can never read as an option.
    let source = format!("refs/heads/{branch}");
    let fetch = ["fetch", "--quiet", "--end-of-options", "origin", &source];
    crate::process::git_read(project, &[&NO_HOOKS[..], &fetch].concat(), SLOW)?;
    let merge = ["merge", "--ff-only", "--quiet", "FETCH_HEAD"];
    crate::process::git_update(project, &[&NO_HOOKS[..], &merge].concat(), SLOW).map(drop)
}

/// One at a time: a slow remote costs this thread only. A session anywhere inside a checkout keeps its files still.
fn pass(projects: &BTreeSet<String>, running: &[PathBuf], stopping: &AtomicBool) {
    for project in projects.iter().map(Path::new) {
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        if !running.iter().any(|cwd| cwd.starts_with(project))
            && let Err(e) = update(project)
        {
            eprintln!("auto-pull {}: {e}", project.display());
        }
    }
}

/// Does nothing while the setting is off; ends with the core.
pub(crate) fn spawn(
    registry: Arc<Mutex<Sessions>>,
    stopping: Arc<AtomicBool>,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("auto-pull".into())
        .spawn(move || {
            let mut next = Instant::now() + EVERY;
            while !stopping.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(250));
                if Instant::now() < next {
                    continue;
                }
                next = Instant::now() + EVERY;
                let Ok(view) = registry.lock().map(|s| s.auto_pull_view()) else {
                    return;
                };
                if let Some((projects, running)) = view {
                    pass(&projects, &running, &stopping);
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut c = Command::new("git");
        for k in crate::process::FIXTURE_SCRUB {
            c.env_remove(k);
        }
        let out = c
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=F", "-c", "user.email=f@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    /// A bare origin on `main` with one commit, a clone to pull into, and a writer that pushes the next commit.
    fn repos(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "nunchiro-ap-{tag}-{}-{}",
            std::process::id(),
            crate::store::new_id().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        git(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "origin"],
        );
        git(&root, &["clone", "--quiet", "origin", "writer"]);
        let writer = root.join("writer");
        git(&writer, &["checkout", "--quiet", "-B", "main"]);
        push(&writer, "one");
        git(&root, &["clone", "--quiet", "origin", "local"]);
        (root.clone(), root.join("local"), writer)
    }
    fn push(writer: &Path, name: &str) {
        fs::write(writer.join(name), name).unwrap();
        git(writer, &["add", "."]);
        git(writer, &["commit", "--quiet", "-m", name]);
        git(writer, &["push", "--quiet", "origin", "HEAD:main"]);
    }
    fn run(local: &Path, running: &[PathBuf]) {
        let projects = BTreeSet::from([local.to_str().unwrap().to_string()]);
        pass(&projects, running, &AtomicBool::new(false));
    }
    fn head(dir: &Path) -> String {
        git(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn clean_default_branch_fast_forwards() {
        let (root, local, writer) = repos("clean");
        push(&writer, "two");
        run(&local, &[]);
        assert_eq!(head(&local), head(&writer));
        assert!(local.join("two").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// `git branch` refuses this name but a ref may carry it, and a clone copies it from a hostile remote's HEAD.
    #[test]
    fn a_flag_shaped_default_branch_stays_a_ref_name() {
        use std::os::unix::fs::PermissionsExt;
        let (root, local, writer) = repos("dash");
        let (ran, evil) = (root.join("ran"), root.join("evil"));
        fs::write(&evil, format!("#!/bin/sh\ntouch {}\n", ran.display())).unwrap();
        fs::set_permissions(&evil, fs::Permissions::from_mode(0o755)).unwrap();
        let name = format!("--upload-pack={}", evil.display());
        let (heads, remotes) = (
            format!("refs/heads/{name}"),
            format!("refs/remotes/origin/{name}"),
        );

        push(&writer, "two");
        let origin = root.join("origin");
        git(&origin, &["update-ref", &heads, "refs/heads/main"]);
        git(&local, &["update-ref", &heads, "HEAD"]);
        git(&local, &["symbolic-ref", "HEAD", &heads]);
        git(&local, &["update-ref", &remotes, "HEAD"]);
        git(
            &local,
            &["symbolic-ref", "refs/remotes/origin/HEAD", &remotes],
        );

        run(&local, &[]);
        assert!(!ran.exists(), "the branch name ran as --upload-pack");
        assert_eq!(head(&local), head(&writer));
        fs::remove_dir_all(root).unwrap();
    }

    /// Ticket 394 round 2: a failed origin fetch's error, which `pass` logs as is, carries no `user:token@`.
    #[test]
    fn fetch_error_for_the_log_drops_the_url_user_part() {
        let (root, local, _) = repos("secret");
        // A path, so git names it in its error with no network call.
        let url = format!("{}/user:tok3n@github.com/acme/app", root.display());
        git(&local, &["remote", "set-url", "origin", &url]);
        let e = update(&local).unwrap_err();
        fs::remove_dir_all(root).unwrap();
        assert!(
            e.contains("github.com/acme/app") && !e.contains("tok3n"),
            "{e}"
        );
    }

    #[test]
    fn leaves_every_checkout_it_must_not_move() {
        // Uncommitted changes.
        let (root, local, writer) = repos("dirty");
        let before = head(&local);
        push(&writer, "two");
        fs::write(local.join("mine"), "work").unwrap();
        run(&local, &[]);
        assert_eq!(head(&local), before);
        fs::remove_file(local.join("mine")).unwrap();

        // A session running inside it.
        run(&local, &[local.join("sub")]);
        assert_eq!(head(&local), before);

        // Another branch is checked out.
        git(&local, &["checkout", "--quiet", "-b", "feature"]);
        run(&local, &[]);
        assert_eq!(head(&local), before);
        git(&local, &["checkout", "--quiet", "main"]);

        // Local-only commits: diverged, so no merge commit and no reset.
        fs::write(local.join("own"), "own").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "--quiet", "-m", "own"]);
        let mine = head(&local);
        run(&local, &[]);
        assert_eq!(head(&local), mine);
        fs::remove_dir_all(root).unwrap();
    }
}
