//! Ticket 501: the Diff dock's git facts come from the 463 stamp too, and the 5-minute fallback re-read happens.
//! One test in its own binary: it puts a counting `git` first on this process's PATH and shortens the fallback through
//! the env, which would race with any other test in the same process.
#[path = "fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::{
    api::{Reply, Request},
    diff::{self, Base, Scope},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn git_runs(log: &Path) -> usize {
    fs::read_to_string(log).map_or(0, |t| t.lines().count())
}

#[test]
fn diff_list_runs_git_only_after_a_change_or_the_fallback() {
    let top = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("diff-idle-{}", std::process::id()));
    let _ = fs::remove_dir_all(&top);
    let (dir, bin) = (top.join("repo"), top.join("bin"));
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&bin).unwrap();
    let real = git_env::scrubbed("/bin/sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let real = String::from_utf8(real.stdout).unwrap().trim().to_string();
    assert!(real.starts_with('/'), "no git on PATH");
    let log = top.join("git.log");
    fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexec '{real}' \"$@\"\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o700)).unwrap();
    // The fixture's own git is the real one, never counted.
    let fixture = |args: &[&str]| {
        let out = git_env::scrubbed(&real)
            .arg("-C")
            .arg(&dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(["-c", "gc.auto=0", "-c", "maintenance.auto=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    };
    fixture(&["init", "-q", "-b", "main"]);
    fs::write(dir.join("a.txt"), "a\n").unwrap();
    fixture(&["add", "-A"]);
    fixture(&["commit", "-q", "-m", "init"]);
    fs::write(dir.join("a.txt"), "changed\n").unwrap();
    let sha = fixture(&["rev-parse", "HEAD"]).trim().to_string();
    let path = std::env::var("PATH").unwrap_or_default();
    // SAFETY: the only test in this binary; nothing else reads the env while it is set.
    unsafe { std::env::set_var("PATH", format!("{}:{path}", bin.display())) };

    let ask = |git: bool| {
        let request = Request::DiffList {
            session: "s".into(),
            scope: Scope::Session,
            git,
            fresh: false,
        };
        match diff::run(
            dir.clone(),
            Some(Base::Commit { sha: sha.clone() }),
            request,
        )
        .unwrap()
        {
            Reply::Diff { files, git, .. } => (files.len(), git),
            other => panic!("not a diff reply: {other:?}"),
        }
    };
    // The Diff dock's read: git once, then the same facts from the stamp while nothing changed.
    let (files, facts) = ask(true);
    let facts = facts.expect("asked for facts");
    assert!(files == 1 && facts.dirty, "{facts:?}");
    let first = git_runs(&log);
    assert!(first > 0, "the first read ran no git");
    for _ in 0..3 {
        let (_, again) = ask(true);
        assert_eq!(again.as_ref(), Some(&facts));
    }
    assert_eq!(git_runs(&log), first, "an unchanged folder ran git again");
    // The status bar's list (no facts) is kept apart and never answers with facts.
    assert_eq!(ask(false).1, None);
    let lists = git_runs(&log);
    assert!(ask(false).1.is_none() && git_runs(&log) == lists);

    // A change is seen at the next read: git runs, and the facts follow it.
    fixture(&["commit", "-q", "-am", "second"]);
    let (files, after) = ask(true);
    let after = after.expect("facts");
    assert!(git_runs(&log) > lists, "a commit was not read");
    assert!(files == 1 && !after.dirty, "{after:?}");

    // Ticket 463's fallback: past it, the next read runs git though nothing changed.
    // SAFETY: as above.
    // 3 s: under load one facts read (25 git runs) alone can take a second.
    unsafe { std::env::set_var("NUNCHIRO_DIFF_FALLBACK_MS", "3000") };
    let window = Duration::from_millis(3000);
    // A loaded host can let the window pass between two reads, so the "not before the fallback" check counts only a
    // round whose reads all ended inside it, measured from before both lists were kept.
    for round in 0.. {
        thread::sleep(window + Duration::from_millis(100));
        let runs = git_runs(&log);
        let kept_from = Instant::now();
        ask(true);
        let facts_runs = git_runs(&log);
        assert!(
            facts_runs > runs,
            "the fallback did not read the facts again"
        );
        ask(false);
        let before = git_runs(&log);
        assert!(
            before > facts_runs,
            "the fallback did not read the list again"
        );
        ask(true);
        ask(false);
        if kept_from.elapsed() < window {
            assert_eq!(git_runs(&log), before, "read again before the fallback");
            break;
        }
        assert!(round < 10, "every round took longer than the fallback");
    }

    unsafe { std::env::set_var("PATH", path) };
    fs::remove_dir_all(top).unwrap();
}
