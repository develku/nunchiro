//! Diff against a session's start commit, library level (spec B3 Diff, Acceptance 10; ticket 11).
//! Fixture repos are built at test time under `.scratch/`.
#[path = "fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::{
    api::{Reply, Request, Response},
    diff::{self, Base},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};

struct Repo {
    top: PathBuf,
    dir: PathBuf,
}
impl Repo {
    /// An empty folder; `git` makes it a repository.
    fn folder() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let top = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "diff-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        let _ = fs::remove_dir_all(&top);
        fs::create_dir_all(top.join("repo")).unwrap();
        let top = top.canonicalize().unwrap();
        Self {
            dir: top.join("repo"),
            top,
        }
    }
    fn new() -> Self {
        let r = Self::folder();
        r.git(&["init", "-q"]);
        r
    }
    fn git(&self, args: &[&str]) -> String {
        let out = git_env::scrubbed("git")
            .arg("-C")
            .arg(&self.dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            // No background gc or maintenance from the fixture's own writes (stash, commit).
            .args(["-c", "gc.auto=0", "-c", "maintenance.auto=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }
    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let p = self.dir.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }
    fn commit(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.top);
    }
}

fn ok(r: Response) -> Value {
    serde_json::to_value(r.unwrap_or_else(|e| panic!("refused: {e}"))).unwrap()
}
fn list(dir: &Path, base: Option<Base>) -> Value {
    ok(diff::run(
        dir.into(),
        base,
        Request::DiffList {
            session: "s".into(),
            scope: Default::default(),
            git: false,
            fresh: false,
        },
    ))
}
fn patch(dir: &Path, base: &Base, path: &str) -> Response {
    diff::run(
        dir.into(),
        Some(base.clone()),
        Request::DiffFile {
            session: "s".into(),
            path: path.into(),
            scope: Default::default(),
        },
    )
}
/// `path status` pairs of a list reply, sorted.
fn names(v: &Value) -> Vec<(String, String)> {
    let mut out: Vec<_> = v["files"]
        .as_array()
        .unwrap_or_else(|| panic!("no files: {v}"))
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap().to_string(),
                f["status"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    out.sort();
    out
}
fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}
fn file<'a>(v: &'a Value, path: &str) -> &'a Value {
    v["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == path)
        .unwrap_or_else(|| panic!("no {path} in {v}"))
}
fn text(r: Response) -> String {
    let v = ok(r);
    v["patch"]
        .as_str()
        .unwrap_or_else(|| panic!("no patch: {v}"))
        .to_string()
}

#[test]
fn diff_lists_exactly_the_changed_and_untracked_files_against_the_start_commit() {
    let r = Repo::new();
    for f in ["a.txt", "b.txt", "c.txt", "clean.txt"] {
        r.write(f, format!("{f}\n"));
    }
    r.write(".gitignore", "*.log\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    assert!(matches!(base, Base::Commit { .. }), "{base:?}");
    // A commit made after the start still counts: the base is the start commit, not today's HEAD.
    r.write("b.txt", "b committed later\n");
    r.commit("later");
    r.write("a.txt", "a changed\n");
    fs::remove_file(r.dir.join("c.txt")).unwrap();
    r.write("d/new.txt", "untracked\n");
    r.write("e.txt", "staged new\n");
    r.git(&["add", "e.txt"]);
    r.write("noise.log", "ignored\n");
    let v = list(&r.dir, Some(base));
    assert_eq!(
        names(&v),
        pairs(&[
            ("a.txt", "M"),
            ("b.txt", "M"),
            ("c.txt", "D"),
            ("d/new.txt", "?"),
            ("e.txt", "A"),
        ])
    );
    assert_eq!(v["truncated"], false);
    assert_eq!(file(&v, "a.txt")["additions"], 1);
    assert_eq!(file(&v, "a.txt")["deletions"], 1);
    assert_eq!(file(&v, "d/new.txt")["additions"], 1);
}

#[test]
fn diff_a_non_git_folder_is_an_empty_state_not_an_error() {
    let r = Repo::folder();
    r.write("plain.txt", "not tracked by anything\n");
    let base = diff::start(&r.dir);
    assert_eq!(base, Base::NotGit);
    let v = list(&r.dir, Some(base));
    assert_eq!(v["base"], json!({"kind": "not_git"}));
    assert_eq!(v["files"], json!([]));
}

#[test]
fn diff_an_unknown_start_commit_lists_nothing_and_never_falls_back_to_head() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "changed\n");
    let v = list(&r.dir, None);
    assert_eq!(v["base"], Value::Null);
    assert_eq!(v["files"], json!([]));
}

#[test]
fn diff_a_repo_with_no_commits_diffs_against_nothing() {
    let r = Repo::new();
    let base = diff::start(&r.dir);
    assert_eq!(base, Base::NoCommits);
    r.write("staged.txt", "s\n");
    r.git(&["add", "staged.txt"]);
    r.write("loose.txt", "l\n");
    // Committing after the start does not hide the work done since.
    r.write("committed.txt", "c\n");
    r.git(&["add", "committed.txt"]);
    r.git(&["commit", "-q", "-m", "first"]);
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(
        names(&v),
        pairs(&[
            ("committed.txt", "A"),
            ("loose.txt", "?"),
            ("staged.txt", "A"),
        ])
    );
    assert!(text(patch(&r.dir, &base, "committed.txt")).contains("+c"));
}

#[test]
fn diff_a_binary_file_is_its_name_and_binary() {
    let r = Repo::new();
    r.write("blob.bin", [0u8, 1, 2, 0, 255]);
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("blob.bin", [0u8, 9, 9, 0, 255, 7]);
    r.write("new.bin", [0u8, 0, 1]);
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(file(&v, "blob.bin")["binary"], true);
    assert_eq!(file(&v, "new.bin")["binary"], true);
    for p in ["blob.bin", "new.bin"] {
        let f = ok(patch(&r.dir, &base, p));
        assert_eq!(f["binary"], true, "{f}");
        assert_eq!(f["patch"], Value::Null);
    }
}

#[test]
fn diff_a_huge_file_is_marked_too_large_instead_of_failing() {
    let r = Repo::new();
    r.write("big.txt", "old line\n".repeat(30_000));
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("big.txt", "new line\n".repeat(30_000));
    r.write("huge-new.txt", "x\n".repeat(200_000));
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(file(&v, "big.txt")["additions"], 30_000);
    for p in ["big.txt", "huge-new.txt"] {
        let f = ok(patch(&r.dir, &base, p));
        assert_eq!(f["too_large"], true, "{p}: {f}");
        assert_eq!(f["patch"], Value::Null);
    }
}

#[test]
fn diff_many_files_are_bounded_and_marked_truncated() {
    let r = Repo::new();
    r.write("keep.txt", "k\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    for i in 0..(diff::MAX_FILES + 50) {
        r.write(&format!("many/{i:05}.txt"), "n\n");
    }
    let v = list(&r.dir, Some(base));
    assert_eq!(v["truncated"], true);
    assert_eq!(v["files"].as_array().unwrap().len(), diff::MAX_FILES);
}

#[test]
fn diff_renamed_and_deleted_files_show_their_old_path_and_removed_lines() {
    let r = Repo::new();
    r.write("old-name.txt", "same content\nkept\n");
    r.write("gone.txt", "bye\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    r.git(&["mv", "old-name.txt", "new-name.txt"]);
    fs::remove_file(r.dir.join("gone.txt")).unwrap();
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(
        names(&v),
        pairs(&[("gone.txt", "D"), ("new-name.txt", "R")])
    );
    assert_eq!(file(&v, "new-name.txt")["old_path"], "old-name.txt");
    let renamed = ok(patch(&r.dir, &base, "new-name.txt"));
    assert_eq!(renamed["old_path"], "old-name.txt");
    assert!(text(patch(&r.dir, &base, "gone.txt")).contains("-bye"));
}

#[test]
fn diff_crlf_and_a_missing_final_newline_survive_in_the_patch() {
    let r = Repo::new();
    r.git(&["config", "core.autocrlf", "false"]);
    r.write("crlf.txt", "one\r\ntwo\r\n");
    r.write("tail.txt", "end\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("crlf.txt", "one\r\nTWO\r\n");
    r.write("tail.txt", "end");
    r.write("loose.txt", "a\r\nno newline");
    assert!(text(patch(&r.dir, &base, "crlf.txt")).contains("+TWO\r\n"));
    assert!(text(patch(&r.dir, &base, "tail.txt")).contains("\\ No newline at end of file"));
    let loose = text(patch(&r.dir, &base, "loose.txt"));
    assert!(
        loose.contains("+a\r\n+no newline\n\\ No newline at end of file"),
        "{loose}"
    );
    assert!(loose.contains("@@ -0,0 +1,2 @@"), "{loose}");
}

#[test]
fn diff_korean_file_names_and_content_come_back_unquoted() {
    let r = Repo::new();
    r.write("문서/메모.txt", "안녕\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("문서/메모.txt", "안녕하세요\n");
    r.write("새 파일.md", "# 제목\n");
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(
        names(&v),
        pairs(&[("문서/메모.txt", "M"), ("새 파일.md", "?")])
    );
    assert!(text(patch(&r.dir, &base, "문서/메모.txt")).contains("+안녕하세요"));
    assert!(text(patch(&r.dir, &base, "새 파일.md")).contains("+# 제목"));
}

#[test]
fn diff_a_patch_is_served_only_for_a_listed_change() {
    let r = Repo::new();
    r.write("clean.txt", "c\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("a.txt", "a\n");
    for p in [
        "clean.txt",
        "../a.txt",
        "/etc/hosts",
        ".git/config",
        "*.txt",
        "",
    ] {
        assert!(patch(&r.dir, &base, p).is_err(), "{p} was served");
    }
}

#[test]
fn diff_an_untracked_link_out_of_the_folder_is_never_read() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    fs::write(r.top.join("secret.txt"), "outside-secret\n").unwrap();
    symlink(r.top.join("secret.txt"), r.dir.join("link_out")).unwrap();
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(names(&v), pairs(&[("link_out", "?")]));
    let served = format!("{:?}", patch(&r.dir, &base, "link_out"));
    assert!(!served.contains("outside-secret"), "{served}");
}

#[test]
fn diff_a_subfolder_session_sees_only_its_folder_with_relative_paths() {
    let r = Repo::new();
    r.write("app/in.txt", "i\n");
    r.write("other/out.txt", "o\n");
    r.commit("init");
    let sub = r.dir.join("app");
    let base = diff::start(&sub);
    r.write("app/in.txt", "changed\n");
    r.write("app/new.txt", "n\n");
    r.write("other/out.txt", "changed\n");
    let v = list(&sub, Some(base.clone()));
    assert_eq!(names(&v), pairs(&[("in.txt", "M"), ("new.txt", "?")]));
    assert!(text(patch(&sub, &base, "in.txt")).contains("+changed"));
}

#[test]
fn diff_writes_nothing_to_git() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit("init");
    r.write("s.txt", "stash me\n");
    r.git(&["stash", "push", "-u", "-q", "-m", "fixture"]);
    r.git(&["pack-refs", "--all"]);
    let base = diff::start(&r.dir);
    // A stat-only touch (a second after the index was written, so it is not racy-clean) makes a
    // refreshing git rewrite the index.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    r.write("b.txt", "b\n");
    r.write("a.txt", "changed\n");
    r.write("u.txt", "untracked\n");
    let sum = |r: &Repo| {
        let mut out = vec![];
        for p in [".git/index", ".git/packed-refs", ".git/HEAD"] {
            out.push((p.to_string(), fs::read(r.dir.join(p)).ok()));
        }
        out.push(("refs".into(), Some(r.git(&["for-each-ref"]).into_bytes())));
        out.push(("stash".into(), Some(r.git(&["stash", "list"]).into_bytes())));
        let mut lock = vec![];
        for e in fs::read_dir(r.dir.join(".git")).unwrap().flatten() {
            lock.push(e.file_name().to_string_lossy().into_owned());
        }
        lock.sort();
        out.push(("git dir".into(), Some(lock.join(",").into_bytes())));
        out
    };
    let before = sum(&r);
    let before_mtime = fs::metadata(r.dir.join(".git/index"))
        .unwrap()
        .modified()
        .unwrap();
    list(&r.dir, Some(base.clone()));
    for p in ["a.txt", "u.txt"] {
        ok(patch(&r.dir, &base, p));
    }
    assert_eq!(sum(&r), before);
    assert_eq!(
        fs::metadata(r.dir.join(".git/index"))
            .unwrap()
            .modified()
            .unwrap(),
        before_mtime
    );
}

#[test]
fn diff_reply_shapes_are_stable() {
    // Published interface for tickets 12 and 13.
    let r: Request = serde_json::from_value(json!({"op":"diff_list","session":"s1"})).unwrap();
    assert!(matches!(r, Request::DiffList { .. }));
    let r: Request =
        serde_json::from_value(json!({"op":"diff_file","session":"s1","path":"a.txt"})).unwrap();
    assert!(matches!(r, Request::DiffFile { .. }));
    let reply = Reply::Diff {
        base: Some(Base::Commit { sha: "abc".into() }),
        base_missing: false,
        files: vec![],
        truncated: false,
        branch: None,
        git: None,
    };
    assert_eq!(
        serde_json::to_value(reply).unwrap(),
        json!({"type":"diff","base":{"kind":"commit","sha":"abc"},"base_missing":false,"files":[],"truncated":false})
    );
}

// Round 2 (review fixes).

#[test]
fn diff_an_option_looking_start_commit_is_never_read_as_an_option() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "changed\n");
    let victim = r.top.join("victim.txt");
    fs::write(&victim, "keep me\n").unwrap();
    // A stored record is validated on load; this proves the git calls themselves hold if one slips through.
    let base = Base::Commit {
        sha: format!("--output={}", victim.display()),
    };
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(v["base_missing"], true, "{v}");
    assert_eq!(v["files"], json!([]));
    assert!(patch(&r.dir, &base, "a.txt").is_err());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me\n");
}

#[test]
fn diff_a_start_commit_that_no_longer_exists_is_a_typed_state() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "changed\n");
    let base = Base::Commit {
        sha: "0".repeat(40),
    };
    let v = list(&r.dir, Some(base.clone()));
    assert_eq!(v["base_missing"], true, "{v}");
    assert_eq!(v["files"], json!([]));
    let e = patch(&r.dir, &base, "a.txt").unwrap_err();
    assert_eq!(e, "start commit no longer exists");
    // A known start commit is not missing.
    let ok = list(&r.dir, Some(diff::start(&r.dir)));
    assert_eq!(ok["base_missing"], false);
}

#[test]
fn diff_untracked_names_cut_by_the_output_cap_list_no_partial_path() {
    let r = Repo::new();
    r.write("keep.txt", "k\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    let long = "n".repeat(180);
    // About 75 KB of names, more than the output cap.
    for i in 0..400 {
        r.write(&format!("{long}{i:04}.txt"), "n\n");
    }
    let v = list(&r.dir, Some(base));
    assert_eq!(v["truncated"], true);
    let files = v["files"].as_array().unwrap();
    assert!(!files.is_empty());
    for f in files {
        let p = f["path"].as_str().unwrap();
        assert!(
            r.dir.join(p).is_file(),
            "listed a path that does not exist: {p}"
        );
    }
}

#[test]
fn diff_file_looks_up_one_path_even_beyond_the_list_cap() {
    let r = Repo::new();
    r.write("keep.txt", "k\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    for i in 0..(diff::MAX_FILES + 10) {
        r.write(&format!("many/{i:05}.txt"), "n\n");
    }
    r.write("zz-last.txt", "beyond the cap\n");
    let v = list(&r.dir, Some(base.clone()));
    assert!(
        v["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["path"] != "zz-last.txt")
    );
    assert!(text(patch(&r.dir, &base, "zz-last.txt")).contains("+beyond the cap"));
    r.write("keep.txt", "k changed\n");
    assert!(text(patch(&r.dir, &base, "keep.txt")).contains("+k changed"));
    assert!(patch(&r.dir, &base, "many").is_err());
}

// Ticket 374: the Branch scope compares with where HEAD left origin's default branch.

fn branch_list(dir: &Path, base: Option<Base>) -> Value {
    ok(diff::run(
        dir.into(),
        base,
        Request::DiffList {
            session: "s".into(),
            scope: diff::Scope::Branch,
            git: false,
            fresh: false,
        },
    ))
}
fn branch_patch(dir: &Path, base: Base, path: &str) -> Response {
    diff::run(
        dir.into(),
        Some(base),
        Request::DiffFile {
            session: "s".into(),
            path: path.into(),
            scope: diff::Scope::Branch,
        },
    )
}
fn pair(path: &str, status: &str) -> (String, String) {
    (path.into(), status.into())
}

#[test]
fn diff_branch_scope_lists_every_commit_since_origin_default() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    let main = r.git(&["rev-parse", "HEAD"]).trim().to_string();
    // A last-fetched origin, as a clone leaves it; no network.
    r.git(&["update-ref", "refs/remotes/origin/main", &main]);
    r.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    r.git(&["checkout", "-q", "-B", "main"]);
    // On the default branch there is nothing to compare: the list says so and falls back to the session.
    let v = branch_list(&r.dir, Some(Base::Commit { sha: main.clone() }));
    assert_eq!(v["branch"], json!({"kind":"on_default"}), "{v}");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.write("b.txt", "b\n");
    r.commit("one");
    let since = Base::Commit {
        sha: r.git(&["rev-parse", "HEAD"]).trim().to_string(),
    };
    r.write("c.txt", "c\n");
    r.commit("two");
    // The session started after the first commit: its own list misses b.txt, the Branch list has both commits.
    let v = list(&r.dir, Some(since.clone()));
    assert_eq!(names(&v), [pair("c.txt", "A")]);
    assert_eq!(v["branch"], json!({"kind":"ready","default":"origin/main"}));
    let v = branch_list(&r.dir, Some(since.clone()));
    assert_eq!(names(&v), [pair("b.txt", "A"), pair("c.txt", "A")]);
    assert_eq!(v["base"], json!({"kind":"commit","sha":main}));
    assert!(text(branch_patch(&r.dir, since, "b.txt")).contains("+b"));
}

#[test]
fn diff_branch_scope_without_origin_says_so_and_refuses_a_patch() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit("init");
    let start = Base::Commit {
        sha: r.git(&["rev-parse", "HEAD"]).trim().to_string(),
    };
    r.write("a.txt", "changed\n");
    let v = branch_list(&r.dir, Some(start.clone()));
    assert_eq!(v["branch"], json!({"kind":"no_origin"}));
    assert_eq!(names(&v), [pair("a.txt", "M")]);
    assert_eq!(
        branch_patch(&r.dir, start, "a.txt").unwrap_err(),
        "no branch to compare with"
    );
}

/// Q9 pop-J25-1: a second edit with the same status and counts (one line changed twice) gives the file a new stamp, so
/// Diff re-reads its patch; a deleted file has none.
#[test]
fn diff_list_stamp_changes_with_a_same_count_edit() {
    let r = Repo::new();
    r.write("a.txt", "one\n");
    r.write("gone.txt", "g\n");
    r.commit("init");
    let base = diff::start(&r.dir);
    r.write("a.txt", "two\n");
    fs::remove_file(r.dir.join("gone.txt")).unwrap();
    r.write("new.txt", "n\n");
    let first = list(&r.dir, Some(base.clone()));
    r.write("a.txt", "three\n");
    r.write("new.txt", "m\n");
    let second = list(&r.dir, Some(base));
    for path in ["a.txt", "new.txt"] {
        let (a, b) = (file(&first, path), file(&second, path));
        assert_eq!(
            (&a["additions"], &a["deletions"]),
            (&b["additions"], &b["deletions"])
        );
        assert!(a["stamp"].is_u64(), "{a}");
        assert_ne!(a["stamp"], b["stamp"], "{path}");
    }
    assert_eq!(file(&second, "gone.txt")["stamp"], Value::Null);
}
