//! V2-8a: auto-clean of merged worktrees. Every clock here is a number passed in (no test sleeps through the delay);
//! the worktrees are made by a real `nunchiro serve` on a short temp home, never a real one.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    api::*,
    server::call,
    worktree_clean::{Candidate, Cleaner, DELAY_MS, merged, pass},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

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
    String::from_utf8_lossy(&out.stdout).into_owned()
}
fn commit(dir: &Path, file: &str, text: &str, msg: &str) {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}
fn repo(at: &Path) -> PathBuf {
    fs::create_dir_all(at).unwrap();
    git(at, &["init", "-q", "-b", "main"]);
    commit(at, "a.txt", "a\n", "initial");
    at.canonicalize().unwrap()
}
const T0: u64 = 1_000_000_000;

struct Core {
    home: PathBuf,
    repo: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("wtac");
        let repo = repo(&home.join("repo"));
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            repo,
            process,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn wt(&self, operation: &str, extra: Value) -> Result<Value, String> {
        let mut r = json!({"op":"worktree","operation":operation,"project":self.repo,"path":null,"branch":null,"base":"HEAD","label":""});
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        call(&self.home, serde_json::from_value(r).unwrap())
            .map(|r| serde_json::to_value(r).unwrap())
    }
    /// A worktree on `branch` with one commit, merged into main by a plain merge.
    fn merged_worktree(&self, branch: &str) -> PathBuf {
        let r = self.wt("create", json!({"branch":branch})).unwrap();
        let w = r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap();
        let path = PathBuf::from(w["path"].as_str().unwrap());
        commit(&path, &format!("{branch}.txt"), branch, branch);
        git(
            &self.repo,
            &["merge", "-q", "--no-ff", "-m", "merge", branch],
        );
        path
    }
    fn pass(
        &self,
        cleaner: &mut Cleaner,
        on: bool,
        now: u64,
        running: &[PathBuf],
    ) -> Vec<WorktreeCleaned> {
        pass(
            &self.home,
            &self.home.join("worktrees"),
            on,
            now,
            running,
            cleaner,
            &mut |_| Ok(()),
            &mut |_| {},
            &|| false,
        )
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

#[test]
fn auto_clean_default_off() {
    let core = Core::new();
    let Reply::QuitSettings { settings } = call(
        &core.home,
        Request::QuitSettings {
            patch: LifetimePatch::default(),
        },
    )
    .unwrap() else {
        panic!()
    };
    assert!(
        !settings.auto_clean_worktrees,
        "auto-clean is on in a fresh home"
    );
    let path = core.merged_worktree("done");
    let mut c = Cleaner::default();
    for now in [T0, T0 + DELAY_MS + 1, T0 + 10 * DELAY_MS] {
        assert!(core.pass(&mut c, false, now, &[]).is_empty());
    }
    assert!(path.exists(), "removed while the setting is off");
}

#[test]
fn auto_clean_never_removes_dirty_or_running() {
    let core = Core::new();
    let control = core.merged_worktree("control");
    let dirty = core.merged_worktree("dirty");
    fs::write(dirty.join("wip.txt"), "x").unwrap();
    let running = core.merged_worktree("running");
    let r = core.wt("create", json!({"branch":"open"})).unwrap();
    let open = PathBuf::from(
        r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == "open")
            .unwrap()["path"]
            .as_str()
            .unwrap(),
    );
    commit(&open, "open.txt", "open", "not merged");
    let extra = core.merged_worktree("extra");
    commit(&extra, "more.txt", "more", "after the merge");
    let mut c = Cleaner::default();
    assert!(
        core.pass(&mut c, true, T0, std::slice::from_ref(&running))
            .is_empty(),
        "removed at first sight"
    );
    assert!(
        core.pass(
            &mut c,
            true,
            T0 + DELAY_MS - 1,
            std::slice::from_ref(&running)
        )
        .is_empty(),
        "removed before 10 minutes"
    );
    let done = core.pass(&mut c, true, T0 + DELAY_MS, std::slice::from_ref(&running));
    assert_eq!(
        done.iter().map(|d| d.path.clone()).collect::<Vec<_>>(),
        vec![control.clone()]
    );
    for p in [&dirty, &running, &open, &extra] {
        assert!(p.exists(), "{} removed", p.display());
    }
    // A merge seen less than 10 minutes ago: left alone, then due.
    let late = core.merged_worktree("late");
    assert!(
        core.pass(
            &mut c,
            true,
            T0 + DELAY_MS + 1,
            std::slice::from_ref(&running)
        )
        .is_empty()
    );
    assert!(late.exists());
    // The setting turned off mid-delay cancels: on again, the 10 minutes start over.
    assert!(core.pass(&mut c, false, T0 + DELAY_MS + 2, &[]).is_empty());
    assert!(
        core.pass(
            &mut c,
            true,
            T0 + 2 * DELAY_MS + 2,
            std::slice::from_ref(&running)
        )
        .is_empty()
    );
    assert!(late.exists(), "the off turn did not cancel the delay");
}

#[test]
fn due_needs_every_condition_for_the_whole_delay() {
    let p = PathBuf::from("/x");
    let ok = Candidate {
        path: p.clone(),
        merged: true,
        uncommitted: 0,
        running: false,
    };
    let mut c = Cleaner::default();
    assert!(c.due(true, T0, std::slice::from_ref(&ok)).is_empty());
    // Dirty for one look: the clock restarts.
    assert!(
        c.due(
            true,
            T0 + 1,
            &[Candidate {
                uncommitted: 1,
                ..ok.clone()
            }]
        )
        .is_empty()
    );
    assert!(
        c.due(true, T0 + DELAY_MS, std::slice::from_ref(&ok))
            .is_empty()
    );
    assert_eq!(
        c.due(true, T0 + 2 * DELAY_MS, std::slice::from_ref(&ok)),
        vec![p.clone()]
    );
    // Gone from the list: forgotten.
    let mut c = Cleaner::default();
    c.due(true, T0, std::slice::from_ref(&ok));
    c.due(true, T0 + 1, &[]);
    assert!(
        c.due(true, T0 + DELAY_MS, std::slice::from_ref(&ok))
            .is_empty()
    );
    for bad in [
        Candidate {
            running: true,
            ..ok.clone()
        },
        Candidate {
            merged: false,
            ..ok.clone()
        },
    ] {
        let mut c = Cleaner::default();
        c.due(true, T0, std::slice::from_ref(&bad));
        assert!(
            c.due(true, T0 + 2 * DELAY_MS, std::slice::from_ref(&bad))
                .is_empty()
        );
    }
}

#[test]
fn auto_clean_recognises_squash_and_rebase() {
    let dir = home::short("wtm");
    let r = repo(&dir.join("r"));
    // Squash: two commits on the branch become one on main.
    git(&r, &["switch", "-q", "-c", "squashed"]);
    commit(&r, "s1.txt", "1", "s1");
    commit(&r, "s2.txt", "2", "s2");
    git(&r, &["switch", "-q", "main"]);
    commit(&r, "m.txt", "m", "main moves on");
    git(&r, &["merge", "-q", "--squash", "squashed"]);
    git(&r, &["commit", "-q", "-m", "squash"]);
    // Rebase: the branch's commit replayed onto main.
    git(&r, &["switch", "-q", "-c", "rebased", "HEAD~2"]);
    commit(&r, "r.txt", "r", "rebased work");
    git(&r, &["switch", "-q", "main"]);
    git(&r, &["cherry-pick", "rebased"]);
    // Plain merge, and fast-forward.
    git(&r, &["switch", "-q", "-c", "ff"]);
    commit(&r, "ff.txt", "ff", "ff");
    git(&r, &["switch", "-q", "main"]);
    git(&r, &["merge", "-q", "--ff-only", "ff"]);
    // Not merged: an extra commit after a squash; a branch that never moved; one never merged.
    git(&r, &["switch", "-q", "-c", "extra"]);
    commit(&r, "e1.txt", "1", "e1");
    git(&r, &["switch", "-q", "main"]);
    git(&r, &["merge", "-q", "--squash", "extra"]);
    git(&r, &["commit", "-q", "-m", "squash extra"]);
    git(&r, &["switch", "-q", "extra"]);
    commit(&r, "e2.txt", "2", "e2 after the squash");
    git(&r, &["switch", "-q", "main"]);
    git(&r, &["branch", "fresh"]);
    git(&r, &["switch", "-q", "-c", "open"]);
    commit(&r, "o.txt", "o", "open");
    git(&r, &["switch", "-q", "main"]);
    for b in ["squashed", "rebased", "ff"] {
        assert!(merged(&r, b), "{b} not recognised as merged");
    }
    for b in ["extra", "fresh", "open", "no-such-branch", "--all"] {
        assert!(!merged(&r, b), "{b} recognised as merged");
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn auto_clean_nonforce_branch_kept_one_toast() {
    let core = Core::new();
    let path = core.merged_worktree("due");
    let mut c = Cleaner::default();
    assert!(core.pass(&mut c, true, T0, &[]).is_empty());
    let done = core.pass(&mut c, true, T0 + DELAY_MS, &[]);
    assert_eq!(done.len(), 1, "{done:?}");
    assert_eq!((done[0].branch.as_str(), &done[0].path), ("due", &path));
    assert!(!path.exists());
    assert!(
        git(&core.repo, &["branch", "--list", "due"]).contains("due"),
        "branch not kept"
    );
    assert!(
        core.pass(&mut c, true, T0 + 2 * DELAY_MS, &[]).is_empty(),
        "a second toast for the same removal"
    );
    // Undo, as in undo_readds_from_kept_branch.
    core.wt(
        "restore",
        json!({"path":path,"branch":"due","label":done[0].label}),
    )
    .unwrap();
    assert!(path.exists());
    // A tree that becomes dirty between the check and the remove: nothing is removed, no toast.
    let mut c = Cleaner::default();
    core.pass(&mut c, true, T0, &[]);
    let mut dirtied = |p: &Path| {
        fs::write(p.join("late.txt"), "x").unwrap();
        Ok(())
    };
    let done = pass(
        &core.home,
        &core.home.join("worktrees"),
        true,
        T0 + DELAY_MS,
        &[],
        &mut c,
        &mut dirtied,
        &mut |_| {},
        &|| false,
    );
    assert!(done.is_empty(), "{done:?}");
    assert!(path.join("late.txt").exists());
    // A reservation refused (a session started there meanwhile): nothing is removed.
    fs::remove_file(path.join("late.txt")).unwrap();
    let done = pass(
        &core.home,
        &core.home.join("worktrees"),
        true,
        T0 + 2 * DELAY_MS,
        &[],
        &mut c,
        &mut |_| Err("close live worktree sessions first".into()),
        &mut |_| {},
        &|| false,
    );
    assert!(done.is_empty() && path.exists());
}

#[test]
fn auto_clean_removes_a_squash_merged_worktree_whose_commits_are_not_pushed() {
    // The common GitHub flow: squash-merged, the remote branch deleted, the local commits never "pushed" anywhere.
    let core = Core::new();
    let r = core.wt("create", json!({"branch":"squashy"})).unwrap();
    let w = r["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["branch"] == "squashy")
        .unwrap()
        .clone();
    let path = PathBuf::from(w["path"].as_str().unwrap());
    commit(&path, "s1.txt", "1", "s1");
    commit(&path, "s2.txt", "2", "s2");
    git(&core.repo, &["merge", "-q", "--squash", "squashy"]);
    git(&core.repo, &["commit", "-q", "-m", "squash"]);
    let mut c = Cleaner::default();
    assert!(core.pass(&mut c, true, T0, &[]).is_empty());
    let done = core.pass(&mut c, true, T0 + DELAY_MS, &[]);
    assert_eq!(done.len(), 1, "{done:?}");
    assert!(!path.exists());
    assert!(git(&core.repo, &["branch", "--list", "squashy"]).contains("squashy"));
}

#[test]
fn auto_clean_skips_ignored_files_other_than_build_output() {
    // `.env` is git-ignored: a remove would delete it, so it is unsaved work. `target/` beside a `Cargo.toml` is build
    // output: not (V2-8h). A `.env` inside `target/` is listed too.
    let core = Core::new();
    commit(&core.repo, "Cargo.toml", "", "cargo");
    fs::write(core.repo.join(".git/info/exclude"), ".env\ntarget/\n").unwrap();
    let env = core.merged_worktree("with-env");
    fs::write(env.join(".env"), "SECRET=1").unwrap();
    let built = core.merged_worktree("built");
    fs::create_dir_all(built.join("target/debug")).unwrap();
    fs::write(built.join("target/debug/x"), "bin").unwrap();
    let nested = core.merged_worktree("nested-env");
    fs::create_dir_all(nested.join("target/debug")).unwrap();
    fs::write(nested.join("target/debug/.env"), "SECRET=1").unwrap();
    let mut c = Cleaner::default();
    core.pass(&mut c, true, T0, &[]);
    let done = core.pass(&mut c, true, T0 + DELAY_MS, &[]);
    assert_eq!(
        done.iter().map(|d| d.path.clone()).collect::<Vec<_>>(),
        vec![built.clone()]
    );
    assert!(
        env.join(".env").exists(),
        "auto-clean deleted an ignored .env"
    );
    assert!(
        nested.join("target/debug/.env").exists(),
        "auto-clean deleted a .env inside target/"
    );
    assert!(!built.exists());
}

#[test]
fn a_stopping_core_starts_no_removal() {
    let looks = std::cell::Cell::new(0);
    let core = Core::new();
    let path = core.merged_worktree("stopping");
    let mut c = Cleaner::default();
    core.pass(&mut c, true, T0, &[]);
    let root = core.home.join("worktrees");
    let done = pass(
        &core.home,
        &root,
        true,
        T0 + DELAY_MS,
        &[],
        &mut c,
        &mut |_| Ok(()),
        &mut |_| {},
        // The core starts stopping after the pass began: past its first look.
        &|| {
            looks.set(looks.get() + 1);
            looks.get() > 1
        },
    );
    assert!(done.is_empty() && path.exists());
}
