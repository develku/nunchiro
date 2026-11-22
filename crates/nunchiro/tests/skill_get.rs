//! V2.5-31: `nunchiro skill get orchestration` serves the built-in guide; the user's folder overrides it by file name.
#[path = "../../nunchiro-core/tests/fixtures/git_env.rs"]
mod git_env;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Output,
};

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/nunchiro")
}
fn guides() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("guides/orchestration")
}
fn home(tag: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("skill-get-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("skills/orchestration")).unwrap();
    dir
}
fn get(home: &Path, args: &[&str]) -> Output {
    git_env::scrubbed(bin())
        .args(["skill", "get", "orchestration"])
        .args(args)
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap()
}
fn ok(out: Output) -> String {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn refused(out: Output) -> String {
    assert!(
        !out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    String::from_utf8(out.stderr).unwrap()
}
fn builtin(name: &str) -> String {
    fs::read_to_string(guides().join(name)).unwrap()
}

#[test]
fn skill_get_builtin() {
    let h = home("builtin");
    assert_eq!(ok(get(&h, &[])), builtin("guide.md"));
    assert_eq!(ok(get(&h, &["--file", "levels.md"])), builtin("levels.md"));
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn skill_get_override_shadows() {
    let h = home("shadow");
    fs::write(
        h.join("skills/orchestration/brief-template.md"),
        "my brief\n",
    )
    .unwrap();
    assert_eq!(ok(get(&h, &["--file", "brief-template.md"])), "my brief\n");
    assert_eq!(
        ok(get(&h, &[])),
        builtin("guide.md"),
        "other files stay built-in"
    );
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn skill_get_full() {
    let h = home("full");
    fs::write(h.join("skills/orchestration/review.md"), "my review\n").unwrap();
    let full = ok(get(&h, &["--full"]));
    for name in [
        "guide.md",
        "brief-template.md",
        "report-template.md",
        "levels.md",
    ] {
        assert!(
            full.contains(&format!("<!-- file: {name} -->\n{}", builtin(name))),
            "{name}"
        );
    }
    assert!(full.contains("<!-- file: review.md -->\nmy review\n"));
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn override_name_allowlist() {
    let h = home("allow");
    fs::write(h.join("skills/orchestration/extra.md"), "x").unwrap();
    assert!(refused(get(&h, &["--file", "extra.md"])).contains("unknown file"));
    assert!(!ok(get(&h, &["--full"])).contains("extra.md"));
    // Oversized: refused, never truncated.
    fs::write(
        h.join("skills/orchestration/guide.md"),
        "a".repeat(256 * 1024 + 1),
    )
    .unwrap();
    assert!(refused(get(&h, &[])).contains("256 KiB"));
    fs::write(
        h.join("skills/orchestration/guide.md"),
        "a".repeat(256 * 1024),
    )
    .unwrap();
    assert_eq!(ok(get(&h, &[])).len(), 256 * 1024);
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn override_symlink_refused() {
    let h = home("link");
    fs::write(h.join("secret"), "outside\n").unwrap();
    std::os::unix::fs::symlink(h.join("secret"), h.join("skills/orchestration/guide.md")).unwrap();
    let err = refused(get(&h, &[]));
    assert!(err.contains("links are refused"), "{err}");
    assert!(!err.contains("outside"));
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn file_arg_traversal_refused() {
    let h = home("trav");
    fs::write(h.join("skills/x"), "outside\n").unwrap();
    for f in ["../x", "/etc/hosts", "./guide.md", "guide.md/"] {
        let err = refused(get(&h, &["--file", f]));
        assert!(err.contains("unknown file"), "{f}: {err}");
    }
    fs::remove_dir_all(h).unwrap();
}

#[test]
fn override_folder_symlink_refused() {
    let h = home("dirlink");
    fs::create_dir_all(h.join("elsewhere")).unwrap();
    fs::write(h.join("elsewhere/guide.md"), "DIRLINK\n").unwrap();
    fs::remove_dir_all(h.join("skills/orchestration")).unwrap();
    std::os::unix::fs::symlink(h.join("elsewhere"), h.join("skills/orchestration")).unwrap();
    let err = refused(get(&h, &[]));
    assert!(
        err.contains("links are refused") && !err.contains("DIRLINK"),
        "{err}"
    );
    // A linked skills/ folder too.
    let h2 = home("dirlink2");
    fs::remove_dir_all(h2.join("skills")).unwrap();
    std::os::unix::fs::symlink(h.join("skills"), h2.join("skills")).unwrap();
    assert!(refused(get(&h2, &[])).contains("links are refused"));
    fs::remove_dir_all(h2).unwrap();
    fs::remove_dir_all(h).unwrap();
}

// V2.5-35 (ticket 183): the guide tells the coordinator how to keep the board, by the five verbs.
#[test]
fn orchestration_guide_mentions_board() {
    let h = home("board");
    let guide = ok(get(&h, &[]));
    assert!(guide.contains("nunchiro board list|add|move|done|self"));
    for verb in ["add", "move", "done", "self"] {
        assert!(
            guide.contains(&format!("`nunchiro board {verb}")),
            "guide lacks an example of board {verb}"
        );
    }
    for rule in [
        "--group <milestone id>",
        "--ref <ticket path>",
        "--receipt \"<sha> · <command> · <result>\"",
    ] {
        assert!(guide.contains(rule), "guide lacks {rule}");
    }
    fs::remove_dir_all(h).unwrap();
}
