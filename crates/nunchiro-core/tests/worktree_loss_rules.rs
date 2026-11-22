//! V2-8h: which git-ignored files the remove loss list names. An ignored file is excused only as output of a known
//! generator folder; secret-shaped names, unknown folders, unreadable entries and symlinks are listed. The same list
//! guards the window's remove and auto-clean. Each test runs a real `nunchiro serve` on a short temp home.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    server::call,
    worktree_clean::{Cleaner, DELAY_MS, pass},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
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
fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
const T0: u64 = 1_000_000_000;

struct Core {
    home: PathBuf,
    repo: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    /// A repo with `exclude` as its ignore rules and `markers` committed in its root.
    fn new(exclude: &str, markers: &[&str]) -> Self {
        let home = home::short("wtlr");
        let repo = home.join("repo");
        put(&repo.join("a.txt"), "a\n");
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["commit", "-q", "-m", "initial"]);
        let core = Self {
            _serve: home::spawn_serve(&home, &[("HOME", home.to_str().unwrap())]),
            repo: repo.canonicalize().unwrap(),
            home,
        };
        core.mark(markers);
        fs::write(core.repo.join(".git/info/exclude"), exclude).unwrap();
        core
    }
    fn mark(&self, markers: &[&str]) {
        if markers.is_empty() {
            return;
        }
        for m in markers {
            put(&self.repo.join(m), "");
        }
        git(
            &self.repo,
            &["add", "--"]
                .iter()
                .chain(markers)
                .copied()
                .collect::<Vec<_>>(),
        );
        git(&self.repo, &["commit", "-q", "-m", "markers"]);
    }
    fn wt(&self, operation: &str, extra: Value) -> Result<Value, String> {
        let mut r = json!({"op":"worktree","operation":operation,"project":self.repo,"path":null,"branch":null,"base":"HEAD","label":""});
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        call(&self.home, serde_json::from_value(r).unwrap())
            .map(|r| serde_json::to_value(r).unwrap())
    }
    fn create(&self, branch: &str) -> PathBuf {
        let r = self.wt("create", json!({"branch":branch})).unwrap();
        let w = r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap()
            .clone();
        PathBuf::from(w["path"].as_str().unwrap())
    }
    /// A worktree on `branch` with one commit, merged into main.
    fn merged(&self, branch: &str) -> PathBuf {
        let path = self.create(branch);
        put(&path.join(format!("{branch}.txt")), branch);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-q", "-m", branch]);
        git(
            &self.repo,
            &["merge", "-q", "--no-ff", "-m", "merge", branch],
        );
        path
    }
    /// The loss a plain remove asks to confirm (`null` when it removed at once).
    fn loss(&self, path: &Path) -> Value {
        self.wt("remove", json!({"path":path})).unwrap()["loss"].clone()
    }
    fn ignored(&self, path: &Path) -> BTreeSet<String> {
        let loss = self.loss(path);
        let listed: BTreeSet<String> = loss["ignored"]
            .as_array()
            .map(|a| a.iter().map(|e| e.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        assert_eq!(
            loss["ignored_total"].as_u64().unwrap_or(0),
            listed.len() as u64,
            "{loss}"
        );
        listed
    }
    /// Two auto-clean passes a full delay apart; the folders removed.
    fn auto_clean(&self) -> Vec<PathBuf> {
        let mut c = Cleaner::default();
        let mut run = |now| {
            pass(
                &self.home,
                &self.home.join("worktrees"),
                true,
                now,
                &[],
                &mut c,
                &mut |_| Ok(()),
                &mut |_| {},
                &|| false,
            )
        };
        assert!(run(T0).is_empty());
        run(T0 + DELAY_MS).into_iter().map(|d| d.path).collect()
    }
}
fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|e| format!("!! {e}")).collect()
}

#[test]
fn ignored_env_under_build_dir_is_listed() {
    let core = Core::new("build/\n", &["package.json"]);
    let w = core.merged("envbuild");
    put(&w.join("build/.env"), "SECRET=1");
    put(&w.join("build/out.o"), "obj");
    assert_eq!(core.ignored(&w), set(&["build/.env"]));
    assert!(
        core.auto_clean().is_empty(),
        "auto-clean removed a worktree holding build/.env"
    );
    assert!(w.join("build/.env").exists());
}

#[test]
fn regenerable_output_still_excused() {
    let core = Core::new("target/\nnode_modules/\ndist/\nbuild/\n", &[]);
    // Created before any marker is committed: no Cargo.toml, no generator marker in its root.
    let bare = core.create("bare");
    core.mark(&["Cargo.toml", "package.json"]);
    let built = core.create("built");
    for w in [&bare, &built] {
        put(&w.join("target/debug/x"), "bin");
        put(&w.join("node_modules/a/b"), "js");
        put(&w.join("dist/app.js"), "js");
        put(&w.join("build/out.o"), "obj");
    }
    assert_eq!(core.ignored(&built), set(&[]));
    assert!(!built.exists(), "build output alone is a one-click remove");
    assert_eq!(core.ignored(&bare), set(&["build/", "target/"]));
}

#[test]
fn unknown_ignored_file_is_listed() {
    let core = Core::new("notes/\n", &["package.json"]);
    let w = core.create("notes");
    put(&w.join("notes/todo.md"), "hand work");
    assert_eq!(core.ignored(&w), set(&["notes/"]));
}

#[test]
fn secret_shaped_names_always_listed() {
    let core = Core::new(
        ".env.local\nid_ed25519\na.pem\ntarget/\nnode_modules/\ndist/\n",
        &["Cargo.toml", "package.json"],
    );
    let w = core.create("secrets");
    for f in [
        ".env.local",
        "id_ed25519",
        "a.pem",
        "target/x/.env",
        "target/K.PEM",
        "target/db/app.sqlite3",
        "node_modules/p/credentials.json",
        "node_modules/x/server.crt",
        "target/a.PFX",
        "target/id_ecdsa",
        "dist/prod.env",
        "dist/.envrc",
        "node_modules/p/.npmrc",
        "target/debug/x",
        "node_modules/p/index.js",
        "target/id_rsa.pub.d",
    ] {
        put(&w.join(f), "x");
    }
    assert_eq!(
        core.ignored(&w),
        set(&[
            ".env.local",
            "a.pem",
            "id_ed25519",
            "dist/.envrc",
            "dist/prod.env",
            "node_modules/p/.npmrc",
            "node_modules/p/credentials.json",
            "node_modules/x/server.crt",
            "target/K.PEM",
            "target/a.PFX",
            "target/id_ecdsa",
            "target/id_rsa.pub.d",
            "target/db/app.sqlite3",
            "target/x/.env",
        ])
    );
}

#[test]
fn classification_error_is_listed() {
    let core = Core::new("target/\n", &["Cargo.toml"]);
    let w = core.create("locked");
    put(&w.join("target/locked/secret.txt"), "x");
    put(&w.join("target/ok.o"), "obj");
    let locked = w.join("target/locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let listed = core.ignored(&w);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(listed, set(&["target/locked/"]));
}

#[test]
fn symlink_out_of_worktree_not_followed() {
    let core = Core::new("link\nnode_modules/\n", &["package.json"]);
    let outside = core.home.join("outside");
    put(&outside.join("keep.txt"), "keep");
    put(&outside.join(".env"), "SECRET=1");
    let w = core.merged("linked");
    symlink(&outside, w.join("link")).unwrap();
    fs::create_dir_all(w.join("node_modules")).unwrap();
    symlink(&outside, w.join("node_modules/ln")).unwrap();
    // Followed, `link/.env` or `node_modules/ln/.env` would show; the link is named by its own path only.
    assert_eq!(core.ignored(&w), set(&["link"]));
    assert!(core.auto_clean().is_empty());
    let loss = core.loss(&w);
    core.wt("remove", json!({"path":w,"confirm":loss})).unwrap();
    assert!(!w.exists());
    assert!(outside.join("keep.txt").exists() && outside.join(".env").exists());
}

#[test]
fn known_regenerable_names_excused_at_any_depth() {
    let core = Core::new(
        ".DS_Store\n*.pyc\n__pycache__/\n.venv/\n.cache/\ncoverage/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n\
         .turbo/\n.next/\nnode_modules/\ntarget/\n.scratch/\n",
        &[],
    );
    // Created before the markers: a `.venv/` with no Python project file beside it is listed.
    let bare = core.create("novenv");
    put(&bare.join(".venv/lib/x.py"), "x");
    core.mark(&[
        "pyproject.toml",
        "pkg/mod.py",
        "packages/a/package.json",
        "crates/c/Cargo.toml",
    ]);
    let w = core.create("deep");
    for f in [
        ".DS_Store",
        "pkg/.DS_Store",
        "pkg/stray.pyc",
        "pkg/__pycache__/mod.cpython-313.pyc",
        ".venv/lib/x.py",
        ".cache/a",
        "coverage/lcov.info",
        ".pytest_cache/v",
        ".mypy_cache/v",
        ".ruff_cache/v",
        ".turbo/v",
        ".next/v",
        "packages/a/node_modules/x/i.js",
        "crates/c/target/debug/x",
        // Still listed: a secret name inside output, and `.scratch/` (it holds evidence) even around output.
        "packages/a/node_modules/x/.env",
        "pkg/__pycache__/id_dsa",
        ".scratch/notes.md",
        ".scratch/node_modules/x",
    ] {
        put(&w.join(f), "x");
    }
    assert_eq!(
        core.ignored(&w),
        set(&[
            ".scratch/",
            "packages/a/node_modules/x/.env",
            "pkg/__pycache__/id_dsa",
        ])
    );
    assert_eq!(core.ignored(&bare), set(&[".venv/"]));
}

#[test]
fn control_and_bidi_characters_are_escaped() {
    let core = Core::new("node_modules/\n", &["package.json"]);
    let w = core.create("bidi");
    put(&w.join("node_modules/p/a\u{202e}gpj.env"), "x");
    put(&w.join("node_modules/p/x\u{7}.pem"), "x");
    git(
        &w,
        &["commit", "-q", "--allow-empty", "-m", "fix \u{202e}txt.exe"],
    );
    let loss = core.loss(&w);
    let text = loss.to_string();
    assert!(
        !text.contains('\u{202e}') && !text.contains('\u{7}'),
        "{text}"
    );
    assert_eq!(
        core.ignored(&w),
        set(&[
            "node_modules/p/a\\u{202e}gpj.env",
            "node_modules/p/x\\u{7}.pem"
        ])
    );
    let subject = loss["unpushed"][0].as_str().unwrap();
    assert!(subject.ends_with(" fix \\u{202e}txt.exe"), "{subject}");
}

/// Ticket 253 (G22): a shared copy is an untracked file to the loss check even when git ignores it, so removing the
/// worktree never hides a copied secret; a shared link is listed as linked and loses nothing.
#[test]
fn worktree_loss_lists_copied_shared_file_and_marks_linked_one() {
    let core = Core::new(".env\n.env.local\n", &[]);
    put(&core.repo.join(".env"), "LINKED=1");
    put(&core.repo.join(".env.local"), "COPIED=1");
    // Not ignored by git: a plain remove refuses it unless the link goes first.
    put(&core.repo.join("notes.md"), "NOTES=1");
    let shared = json!({"files": [{"path": ".env"}, {"path": ".env.local", "mode": "copy"}, {"path": "notes.md"}]});
    let patch = json!({"features": {"worktree.shared": {core.repo.to_str().unwrap(): shared}}});
    call(
        &core.home,
        serde_json::from_value(json!({"op":"quit_settings","patch":patch})).unwrap(),
    )
    .unwrap();
    // `merged` by hand: its `git add .` would commit the notes.md link.
    let w = core.create("shared");
    put(&w.join("shared.txt"), "shared");
    git(&w, &["add", "shared.txt"]);
    git(&w, &["commit", "-q", "-m", "shared"]);
    git(
        &core.repo,
        &["merge", "-q", "--no-ff", "-m", "merge", "shared"],
    );
    assert!(
        fs::symlink_metadata(w.join(".env"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let loss = core.loss(&w);
    assert_eq!(loss["uncommitted"], json!(["?? .env.local"]), "{loss}");
    assert_eq!(loss["uncommitted_total"], 1, "{loss}");
    assert_eq!(loss["ignored_total"], 0, "{loss}");
    let mut linked: Vec<&str> = loss["linked"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    linked.sort();
    assert_eq!(linked, [".env", "notes.md"], "{loss}");
    assert!(
        core.auto_clean().is_empty(),
        "auto-clean removed a worktree holding a copied secret"
    );
    // Without the copy only the link is left: a plain remove goes ahead, and the project keeps its own file.
    fs::remove_file(w.join(".env.local")).unwrap();
    assert!(fs::read_link(w.join("notes.md")).is_ok());
    assert_eq!(core.loss(&w), Value::Null);
    assert!(!w.exists());
    assert_eq!(
        fs::read_to_string(core.repo.join(".env")).unwrap(),
        "LINKED=1"
    );
    assert_eq!(
        fs::read_to_string(core.repo.join("notes.md")).unwrap(),
        "NOTES=1"
    );
}
