//! Ticket 253 (G22): a create links or copies the project's shared files into the new worktree and applies its sparse
//! preset; a path outside the project is refused when saved and skipped at create. Each test runs a real
//! `nunchiro serve` on a short temp home.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::server::call;
use serde_json::{Value, json};
use std::{
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

struct Core {
    home: PathBuf,
    repo: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    /// A repo with `tracked` committed and `.env` ignored.
    fn new(tracked: &[(&str, &str)]) -> Self {
        let home = home::short("wtsh");
        let repo = home.join("repo");
        put(&repo.join("a.txt"), "a\n");
        for (f, text) in tracked {
            put(&repo.join(f), text);
        }
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "initial"]);
        fs::write(repo.join(".git/info/exclude"), ".env\n.env.local\n").unwrap();
        Self {
            _serve: home::spawn_serve(&home, &[("HOME", home.to_str().unwrap())]),
            repo: repo.canonicalize().unwrap(),
            home,
        }
    }
    fn json(&self, request: Value) -> Result<Value, String> {
        call(&self.home, serde_json::from_value(request).unwrap())
            .map(|r| serde_json::to_value(r).unwrap())
    }
    fn shared(&self, value: Value) -> Result<Value, String> {
        let patch = json!({"features": {"worktree.shared": {self.repo.to_str().unwrap(): value}}});
        self.json(json!({"op":"quit_settings","patch":patch}))
    }
    /// Writes the setting straight into settings.json, as an older or hand-edited file would hold it.
    fn shared_on_disk(&self, value: Value) {
        let file = self.home.join("settings.json");
        let mut s: Value = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(json!({}));
        s["features"]["worktree.shared"] = json!({self.repo.to_str().unwrap(): value});
        fs::write(&file, serde_json::to_vec(&s).unwrap()).unwrap();
    }
    /// The created worktree's reply entry.
    fn create(&self, branch: &str) -> Value {
        let r = self
            .json(json!({"op":"worktree","operation":"create","project":self.repo,"path":null,"branch":branch,"base":"HEAD","label":""}))
            .unwrap();
        r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap()
            .clone()
    }
}
fn path_of(w: &Value) -> PathBuf {
    PathBuf::from(w["path"].as_str().unwrap())
}

#[test]
fn worktree_create_links_shared_files_from_project_root() {
    let core = Core::new(&[]);
    put(&core.repo.join(".env"), "SECRET=1\n");
    put(&core.repo.join("config/master.key"), "k\n");
    // Link is the mode when none is given.
    core.shared(json!({"files": [{"path": ".env"}, {"path": "config/master.key", "mode": "link"}, {"path": "absent.txt"}]}))
        .unwrap();
    let w = core.create("linked");
    let wt = path_of(&w);
    assert_eq!(
        fs::read_link(wt.join(".env")).unwrap(),
        core.repo.join(".env")
    );
    assert_eq!(
        fs::read_link(wt.join("config/master.key")).unwrap(),
        core.repo.join("config/master.key")
    );
    assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1\n");
    // A path the project does not have is nothing to share, not a failure.
    assert!(fs::symlink_metadata(wt.join("absent.txt")).is_err());
    assert!(w.get("shared_failed").is_none(), "{w}");
}

#[test]
fn worktree_create_copies_when_mode_copy_and_never_overwrites_checked_out_file() {
    let core = Core::new(&[("config/app.yml", "tracked\n")]);
    put(&core.repo.join(".env"), "SECRET=1\n");
    fs::set_permissions(core.repo.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    // The project's checkout differs from the commit; the worktree keeps what git checked out.
    put(&core.repo.join("config/app.yml"), "local edit\n");
    core.shared(json!({"files": [{"path": ".env", "mode": "copy"}, {"path": "config/app.yml", "mode": "copy"}]}))
        .unwrap();
    let wt = path_of(&core.create("copied"));
    let env = fs::symlink_metadata(wt.join(".env")).unwrap();
    assert!(env.is_file(), "a copy, not a link");
    assert_eq!(env.permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1\n");
    // The copy is the worktree's own: an edit there leaves the project's file alone.
    fs::write(wt.join(".env"), "CHANGED\n").unwrap();
    assert_eq!(
        fs::read_to_string(core.repo.join(".env")).unwrap(),
        "SECRET=1\n"
    );
    assert_eq!(
        fs::read_to_string(wt.join("config/app.yml")).unwrap(),
        "tracked\n"
    );
}

#[test]
fn worktree_shared_path_outside_project_is_refused_and_skipped() {
    let core = Core::new(&[]);
    let outside = core.home.join("outside.txt");
    put(&outside, "not the project's\n");
    symlink(&outside, core.repo.join("escape")).unwrap();
    symlink(core.home.join("nowhere"), core.repo.join("dangling")).unwrap();
    for bad in [
        "/etc/hosts",
        "../outside.txt",
        "a/../../outside.txt",
        ".git/config",
        "escape",
        "dangling",
        "-x",
        ".GIT/config",
        "a\u{7}b",
    ] {
        let e = core.shared(json!({"files": [{"path": bad}]})).unwrap_err();
        assert!(
            e.contains("shared path") || e.contains("invalid"),
            "{bad}: {e}"
        );
        let e = core.shared(json!({"sparse": [bad]})).unwrap_err();
        assert!(
            e.contains("shared path") || e.contains("invalid"),
            "{bad}: {e}"
        );
    }
    let many: Vec<Value> = (0..33).map(|i| json!({"path": format!("f{i}")})).collect();
    assert!(
        core.shared(json!({"files": many}))
            .unwrap_err()
            .contains("at most 32")
    );
    // Nothing was stored, so a create shares nothing.
    let wt = path_of(&core.create("refused"));
    assert!(fs::symlink_metadata(wt.join("escape")).is_err());
    // A file edited by hand past the check: each bad path is skipped at create and named; the good one still links.
    put(&core.repo.join(".env"), "S=1\n");
    core.shared_on_disk(json!({"files": [{"path": "../outside.txt"}, {"path": "escape", "mode": "copy"}, {"path": ".env"}]}));
    let w = core.create("skipped");
    let wt = path_of(&w);
    assert!(fs::symlink_metadata(wt.join("escape")).is_err());
    assert!(!wt.parent().unwrap().join("outside.txt").exists());
    assert_eq!(
        fs::read_link(wt.join(".env")).unwrap(),
        core.repo.join(".env")
    );
    let failed: Vec<&str> = w["shared_failed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        failed,
        [
            "../outside.txt: is outside the project",
            "escape: is outside the project"
        ],
        "{w}"
    );
}

#[test]
fn worktree_create_applies_sparse_preset() {
    let core = Core::new(&[("web/a.ts", "a"), ("crates/b.rs", "b"), ("docs/c.md", "c")]);
    core.shared(json!({"sparse": ["web", "docs"]})).unwrap();
    let wt = path_of(&core.create("sparse"));
    assert!(wt.join("web/a.ts").exists());
    assert!(wt.join("docs/c.md").exists());
    assert!(
        wt.join("a.txt").exists(),
        "cone mode keeps the root's files"
    );
    assert!(!wt.join("crates").exists(), "outside the preset");
    // The project's own checkout stays whole.
    assert!(core.repo.join("crates/b.rs").exists());
}

#[test]
fn worktree_create_reports_failed_shared_path_and_still_creates() {
    let core = Core::new(&[("docs/readme.md", "r")]);
    put(&core.repo.join("locked.key"), "k");
    fs::set_permissions(
        core.repo.join("locked.key"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    put(&core.repo.join("assets/logo.svg"), "<svg/>");
    put(&core.repo.join(".env"), "S=1\n");
    // Copies run under the worktree lock, so they are bounded: 10 MiB a file, 50 MiB a create (sparse files: no disk).
    let sized = |name: &str, mib: u64| {
        fs::File::create(core.repo.join(name))
            .unwrap()
            .set_len(mib << 20)
            .unwrap()
    };
    sized("big.bin", 11);
    for i in 0..6 {
        sized(&format!("part{i}.bin"), 9);
    }
    let parts = (0..6).map(|i| json!({"path": format!("part{i}.bin"), "mode": "copy"}));
    let mut files = vec![
        json!({"path": "locked.key", "mode": "copy"}),
        json!({"path": "assets", "mode": "copy"}),
        json!({"path": ".env"}),
        json!({"path": "big.bin", "mode": "copy"}),
    ];
    files.extend(parts);
    core.shared(json!({ "files": files })).unwrap();
    let w = core.create("partial");
    let wt = path_of(&w);
    assert!(wt.join("a.txt").exists(), "the create went ahead");
    assert_eq!(
        fs::read_link(wt.join(".env")).unwrap(),
        core.repo.join(".env")
    );
    assert!(
        fs::symlink_metadata(wt.join("locked.key")).is_err(),
        "no partial copy left"
    );
    let failed: Vec<&str> = w["shared_failed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(failed.len(), 4, "{w}");
    assert!(
        failed[0].starts_with("locked.key: ") && failed[0].contains("denied"),
        "{failed:?}"
    );
    assert_eq!(
        failed[1..],
        [
            "assets: Copy is for files; use Link for a folder",
            "big.bin: is over the 10 MiB copy limit; use Link",
            "part5.bin: would pass the 50 MiB a create copies in all; use Link",
        ]
    );
    assert!(fs::symlink_metadata(wt.join("big.bin")).is_err());
    assert!(fs::symlink_metadata(wt.join("part5.bin")).is_err());
    assert_eq!(fs::metadata(wt.join("part4.bin")).unwrap().len(), 9 << 20);
    // It is listed in the store like any other worktree.
    let list = core
        .json(json!({"op":"worktree","operation":"list","project":core.repo,"path":null,"branch":null,"base":"HEAD","label":""}))
        .unwrap();
    assert!(
        list["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["path"] == w["path"] && x.get("shared_failed").is_none())
    );
    fs::set_permissions(
        core.repo.join("locked.key"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
}
