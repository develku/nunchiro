//! Ticket 172: dev web-load at the binary. A refused value must stop the app before any window or core starts,
//! so each run gets a temp home, a `NUNCHIRO_BIN` that starts nothing, and a kill after a short wait.
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// Exit code and stderr, or `None` when the app was still running after 15 s (it would have opened a window).
fn run(app: &Path, web: &str, tag: &str) -> Option<(i32, String)> {
    run_with(app, tag, |cmd, home| {
        cmd.env("NUNCHIRO_WEB", web).env("NUNCHIRO_HOME", home);
    })
}

/// `run` with the home variables set by `env`, given a fresh folder of this worktree's `.scratch`.
fn run_with(app: &Path, tag: &str, env: impl FnOnce(&mut Command, &Path)) -> Option<(i32, String)> {
    let home = repo().join(format!(
        ".scratch/dev-load-bin/{tag}-{}",
        std::process::id()
    )); // binds no socket
    std::fs::create_dir_all(&home).unwrap();
    let mut cmd = Command::new(app);
    env(&mut cmd, &home);
    let mut child = cmd
        .env("NUNCHIRO_BIN", "/usr/bin/false")
        .current_dir(repo())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() > until {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut err = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut err).unwrap();
    let _ = std::fs::remove_dir_all(&home);
    status.map(|s| (s.code().unwrap_or(-1), err))
}

#[test]
fn dev_load_localhost_only() {
    let app = Path::new(env!("CARGO_BIN_EXE_nunchiro-app"));
    let outside = std::env::temp_dir().canonicalize().unwrap();
    for (tag, web) in [
        ("remote", "http://example.com:5173"),
        ("lan", "http://192.168.1.2:5173"),
        ("tls", "https://localhost:5173"),
        ("outside", outside.to_str().unwrap()),
        ("parent", "web/../.."),
    ] {
        let (code, err) = run(app, web, tag)
            .unwrap_or_else(|| panic!("{web}: the app started instead of refusing"));
        assert_eq!(code, 2, "{web}: {err}");
        assert!(
            err.contains("refused") || err.contains("not found"),
            "{web}: {err}"
        );
    }
}

/// 11-20 review SHOULD c: `main` runs the owner start check before any window or core. A `target/` build whose
/// NUNCHIRO_HOME is `$HOME/.nunchiro` (a temp HOME here) exits 2 at once.
#[test]
fn unbundled_owner_build_stops_first() {
    let app = Path::new(env!("CARGO_BIN_EXE_nunchiro-app"));
    let (code, err) = run_with(app, "owner", |cmd, home| {
        cmd.env("HOME", home)
            .env("NUNCHIRO_HOME", home.join(".nunchiro"))
            .env_remove("NUNCHIRO_WEB");
    })
    .expect("the app started instead of refusing");
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("not inside an app bundle"), "{err}");
}

/// On the shipped binary (`cd app && pnpm exec tauri build --no-bundle`, or `NUNCHIRO_RELEASE_APP=<path>`):
/// a valid dev value is refused before any window, and no dev web-load code is in the file.
#[test]
#[ignore = "needs a release build; run with --ignored after tauri build --no-bundle"]
fn release_has_no_dev_load() {
    let app = std::env::var_os("NUNCHIRO_RELEASE_APP")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo().join("target/release/nunchiro-app")); // the root .cargo/config target-dir
    let bytes = std::fs::read(&app).unwrap_or_else(|e| panic!("{}: {e}", app.display()));
    let dist = repo().join("web/dist");
    assert!(dist.join("index.html").is_file(), "build web/dist first");
    for (tag, web) in [
        ("folder", dist.to_str().unwrap()),
        ("server", "http://localhost:5173"),
    ] {
        let (code, err) =
            run(&app, web, tag).unwrap_or_else(|| panic!("{web}: the release app started"));
        assert_eq!(code, 2, "{web}: {err}");
        assert!(err.contains("NUNCHIRO_WEB is refused"), "{web}: {err}");
    }
    let has = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
    assert!(
        !has(b"dev web-load"),
        "dev web-load strings are in the release binary"
    );
    assert!(
        !has(b"Reload UI"),
        "the Develop menu is in the release binary"
    );
}
