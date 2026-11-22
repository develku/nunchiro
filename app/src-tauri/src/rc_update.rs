//! The app updates itself, like a normal app. Two builds do (`build_for`, the one gate behind `start`); any other
//! (cargo, a debug build, an owner-id build made without the release key) registers no plugin, opens no port and never checks.
//!
//! The official app (owner 11-21, `scripts/build-release.sh`): Developer ID signed and notarized, built with the release
//! update key. It reads `latest.json` of its channel from GitHub Releases of develku/nunchiro, and after that from the
//! local feed `<core home>/update`, served on loopback as below. The repository is private for now and a private
//! release asset needs a token; no token is put in an app (Orca and T3 Code both read public release URLs only, and T3
//! Code tests against a local update server). So GitHub answers 404 and the local feed is the one in use, filled by
//! `build-release.sh --local`. Once the repository is public GitHub answers first: no new build, nothing to clean.
//!
//! The RC build (G2, owner 11-08):
//!
//! `scripts/build-rc.sh --publish` leaves `latest.json` and a signed archive in `.scratch/rc/update/`, next to the
//! running bundle. The updater plugin can only fetch over HTTP, so this process answers those two names on a loopback
//! port of its own: no daemon, nothing for the owner to start, and it ends with the app. The core was not used because a route
//! there would also exist in the owner's core.
//!
//! Both: all of it runs here in Rust and the page is granted no `updater:*` permission, so a page can never name an
//! endpoint. A build is downloaded and verified before "Update ready" shows; a tampered one never shows and only logs a line.
//!
//! Plugin use follows monocode `src-tauri/src/lib.rs` and `src/app/model/updater.ts` and vibe-kanban
//! `crates/tauri-app/src/main.rs`; the quiet check, then a restart the user chooses, follows Orca `src/main/updater.ts`.
//! Behaviour only, no code lifted.
use std::{
    fs,
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, Url, async_runtime::Mutex};
use tauri_plugin_updater::{Update, UpdaterExt};

const RC_IDENTIFIER: &str = "dev.nunchiro.app.rc";
const MANIFEST: &str = "latest.json";
const EVERY: Duration = Duration::from_secs(5 * 60);
/// Where `scripts/build-release.sh --publish` puts the official app's releases.
const RELEASES: &str = "https://github.com/develku/nunchiro/releases";

/// The two builds that update themselves.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Build {
    Rc,
    Release,
}

impl Build {
    fn bundle(self) -> &'static str {
        match self {
            Build::Rc => "Nunchiro RC.app",
            Build::Release => "Nunchiro.app",
        }
    }

    fn archive(self) -> &'static str {
        match self {
            Build::Rc => "Nunchiro-RC.app.tar.gz",
            Build::Release => "Nunchiro.app.tar.gz",
        }
    }
}

/// Set by `start` once updates run; `boot` tells the page, so the page of any other build never shows or calls anything.
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// `has_key`: the build carries an update key. Only `build-release.sh` gives the official id one, so the same id built
/// any other way (cargo, a debug run, the owner build before releases) updates nothing.
fn build_for(identifier: &str, has_key: bool) -> Option<Build> {
    match identifier {
        RC_IDENTIFIER => Some(Build::Rc),
        crate::OWNER_IDENTIFIER if has_key => Some(Build::Release),
        _ => None,
    }
}

/// The feed a release follows, by its own version: a prerelease (`0.1.0-pre.<stamp>`) reads the fixed tag `prerelease`,
/// a release reads GitHub's "latest", which is never a prerelease. A `-` after the `+build` part is not a prerelease.
fn channel(version: &str) -> &'static str {
    match version.split('+').next() {
        Some(v) if v.contains('-') => "download/prerelease",
        _ => "latest/download",
    }
}

/// The feeds a build checks, in order: the plugin takes the first that answers with a manifest.
fn endpoints(build: Build, version: &str, port: u16) -> Vec<String> {
    let local = format!("http://127.0.0.1:{port}/{MANIFEST}");
    match build {
        Build::Rc => vec![local],
        Build::Release => vec![format!("{RELEASES}/{}/{MANIFEST}", channel(version)), local],
    }
}

struct Updates {
    build: Build,
    port: u16,
    exe: PathBuf,
    dir: PathBuf,
    /// Held through a check or an install, so the two never overlap.
    ready: Mutex<Option<Ready>>,
    /// The failure last written to core.log: one line per failure, not one per check.
    logged: std::sync::Mutex<Option<String>>,
}

/// A build whose signature has passed; these exact bytes are the ones installed.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

/// The folder a running build takes local updates from, which also proves the running bundle may be replaced.
/// The official app: `<core home>/update`, for a `Nunchiro.app` anywhere but where tauri builds it (`bundle/macos`,
/// a build and not an install, as `unbundled_owner` has it).
/// An RC: only `<…>/.scratch/rc/Nunchiro RC.app`, and never anything with an Applications folder in its path, in any
/// case (macOS volumes ignore case, and `/System/Volumes/Data/Applications` is `/Applications`).
/// `exe` has its links resolved.
fn update_dir(build: Build, exe: &Path, home: &Path) -> Result<PathBuf, String> {
    let bundle = exe.ancestors().nth(3).filter(|b| {
        b.ends_with(build.bundle()) && exe.parent().is_some_and(|m| m.ends_with("Contents/MacOS"))
    });
    if build == Build::Release {
        return bundle
            .and_then(Path::parent)
            .filter(|d| !d.ends_with("bundle/macos"))
            .map(|_| home.join("update"))
            .ok_or_else(|| {
                format!(
                    "refused: {} is not an installed Nunchiro.app",
                    exe.display()
                )
            });
    }
    let applications = exe
        .components()
        .any(|c| matches!(c, Component::Normal(n) if n.eq_ignore_ascii_case("applications")));
    if applications {
        return Err(format!("refused: {} is under Applications", exe.display()));
    }
    let rc = bundle
        .and_then(Path::parent)
        .filter(|rc| rc.ends_with(".scratch/rc"));
    rc.map(|rc| rc.join("update")).ok_or_else(|| {
        format!(
            "refused: {} is not the bundle in .scratch/rc",
            exe.display()
        )
    })
}

/// This executable and its local feed folder, or why this bundle is not one to replace.
fn located(build: Build) -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| format!("cannot resolve this executable: {e}"))?;
    Ok((update_dir(build, &exe, &crate::home()?)?, exe))
}

/// Everything a self-updating build does and any other build does not; `identifier` is the build's own.
pub fn start<R: Runtime>(app: &AppHandle<R>, identifier: &str) -> tauri::Result<()> {
    let key = app.config().plugins.0.get("updater");
    let has_key = key.is_some_and(|u| u["pubkey"].as_str().is_some_and(|k| !k.is_empty()));
    let Some(build) = build_for(identifier, has_key) else {
        return Ok(());
    };
    let (dir, exe) = match located(build) {
        Ok(found) => found,
        Err(e) => {
            log_line(&e);
            return Ok(());
        }
    };
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let port = serve(dir.clone(), build.archive())?;
    app.manage(Updates {
        build,
        port,
        exe,
        dir,
        ready: Mutex::new(None),
        logged: std::sync::Mutex::new(None),
    });
    ACTIVE.store(true, Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = check(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
    Ok(())
}

/// The version that is ready to install, if any. A failure is logged here and reaches the caller only as an `Err`.
async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let updates = app.state::<Updates>();
    let found = find(app, &updates).await;
    match &found {
        Ok(version) => {
            *lock(&updates.logged) = None;
            if version.is_some() {
                let _ = app.emit_to("main", "rc-update", version);
            }
        }
        Err(e) => note(&updates, e),
    }
    found
}

async fn find<R: Runtime>(app: &AppHandle<R>, updates: &Updates) -> Result<Option<String>, String> {
    let mut ready = updates.ready.lock().await;
    let held = |r: &Option<Ready>| r.as_ref().map(|r| r.update.version.clone());
    // Nothing published yet is the normal state of a fresh build, not a failure.
    if updates.build == Build::Rc && !updates.dir.join(MANIFEST).is_file() {
        return Ok(held(&ready));
    }
    let failed = |e: tauri_plugin_updater::Error| format!("update check failed: {e}");
    let version = app.package_info().version.to_string();
    let feeds = endpoints(updates.build, &version, updates.port)
        .iter()
        .map(|e| e.parse())
        .collect::<Result<Vec<Url>, _>>()
        .map_err(|e| format!("bad endpoint: {e}"))?;
    // shortcut: no proxy, because the loopback feed must never go through one; a user behind a proxy gets no update
    // from GitHub. Upgrade when one asks.
    let checked = app
        .updater_builder()
        .endpoints(feeds)
        .map_err(failed)?
        .executable_path(&updates.exe)
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(failed)?
        .check()
        .await;
    let mut update = match checked {
        Ok(Some(update)) => update,
        // Every feed answered and none holds a manifest: nothing is published where this build can read it (the
        // private-repository period with an empty local feed). An unreachable feed is another error, and is logged.
        Ok(None) | Err(tauri_plugin_updater::Error::ReleaseNotFound) => return Ok(held(&ready)),
        Err(e) => return Err(failed(e)),
    };
    if ready
        .as_ref()
        .is_some_and(|r| r.update.version == update.version)
    {
        return Ok(held(&ready));
    }
    if !trusted_archive(updates.build, &update.download_url, updates.port) {
        return Err(format!("refused: archive at {}", update.download_url));
    }
    // The whole archive has to arrive within this, over the network for a release.
    update.timeout = Some(Duration::from_secs(10 * 60));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(failed)?;
    *ready = Some(Ready { update, bytes });
    Ok(held(&ready))
}

/// The insecure-transport option is on for the whole plugin; this and the endpoints above are what limit it. An archive
/// comes from this process (the local feed); the official app also takes one from its own GitHub releases. The signature
/// is what proves the bytes either way.
fn trusted_archive(build: Build, url: &Url, port: u16) -> bool {
    let local = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.path() == format!("/{}", build.archive());
    // `Url` has already resolved any `..`, so the prefix is the real folder.
    local || (build == Build::Release && url.as_str().starts_with(&format!("{RELEASES}/download/")))
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn note(updates: &Updates, failure: &str) {
    let mut logged = lock(&updates.logged);
    // Only a line that was written counts: the core may not have made its log yet at the first check.
    if logged.as_deref() != Some(failure) && log_line(failure) {
        *logged = Some(failure.to_string());
    }
}

/// One line in the core's log (appended; the core owns creating and rotating it).
pub fn log_line(line: &str) -> bool {
    let Ok(home) = crate::home() else {
        return false;
    };
    fs::OpenOptions::new()
        .append(true)
        .open(home.join("logs/core.log"))
        .and_then(|mut f| writeln!(f, "rc-update: {}", line.replace('\n', " ")))
        .is_ok()
}

fn serve(dir: PathBuf, archive: &'static str) -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let dir = dir.clone();
            thread::spawn(move || {
                let _ = answer(stream, &dir, port, archive);
            });
        }
    });
    Ok(port)
}

/// The two published files by exact name, and nothing else. Neither is secret: the signature is what protects them.
fn answer(mut stream: TcpStream, dir: &Path, port: u16, archive: &str) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut head = [0; 2048];
    let read = stream.read(&mut head)?;
    let head = String::from_utf8_lossy(&head[..read]);
    let path = head
        .strip_prefix("GET /")
        .and_then(|rest| rest.split(' ').next());
    let body = match path {
        Some(MANIFEST) => fs::read(dir.join(MANIFEST))
            .ok()
            .and_then(|m| local_manifest(&m, &format!("http://127.0.0.1:{port}/{archive}"))),
        Some(name) if name == archive => fs::read(dir.join(archive)).ok(),
        _ => None,
    };
    let (status, body) = match body {
        Some(body) => ("200 OK", body),
        None => ("404 Not Found", Vec::new()),
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

/// The manifest as this process serves it: each platform's archive is the one in this folder, whatever address the
/// manifest was published with (GitHub's for a release, a placeholder port for an RC).
fn local_manifest(manifest: &[u8], archive: &str) -> Option<Vec<u8>> {
    let mut manifest: serde_json::Value = serde_json::from_slice(manifest).ok()?;
    for platform in manifest["platforms"].as_object_mut()?.values_mut() {
        platform["url"] = archive.into();
    }
    serde_json::to_vec(&manifest).ok()
}

/// Whatever the build is, only the main window of a running updater gets past this.
fn ready_for<'a>(
    app: &'a AppHandle,
    webview: &tauri::Webview,
) -> Result<tauri::State<'a, Updates>, String> {
    crate::cli_install::main_only(webview)?;
    app.try_state::<Updates>()
        .ok_or_else(|| "updates are off in this build".to_string())
}

/// Also the page's first read: a build already verified answers at once.
#[tauri::command]
pub async fn rc_update_check(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<Option<String>, String> {
    ready_for(&app, &webview)?;
    check(&app).await
}

/// Replaces the running bundle with the verified build and relaunches; the core is its own process and stays up
/// until the relaunched app's first page load replaces it (F24, `crate::ensure_core`).
#[tauri::command]
pub async fn rc_update_install(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    let updates = ready_for(&app, &webview)?;
    let ready = updates.ready.lock().await;
    let result = match ready.as_ref() {
        None => Err("no verified update is ready".to_string()),
        // Asked again at the moment of replacing: the plugin swaps whatever bundle holds this executable.
        Some(r) => located(updates.build).and_then(|_| {
            r.update
                .install(&r.bytes)
                .map_err(|e| format!("install failed: {e}"))
        }),
    };
    if let Err(e) = result {
        note(&updates, &e);
        return Err(e);
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const RC: &str = "/Users/k/Projects/n/.scratch/rc/Nunchiro RC.app/Contents/MacOS/nunchiro-app";
    const HOME: &str = "/Users/k/.nunchiro";

    #[test]
    fn only_the_rc_and_a_keyed_official_build_update() {
        assert_eq!(build_for("dev.nunchiro.app.rc", true), Some(Build::Rc));
        assert_eq!(build_for("dev.nunchiro.app.rc", false), Some(Build::Rc));
        assert_eq!(
            build_for(crate::OWNER_IDENTIFIER, true),
            Some(Build::Release)
        );
        // No update key: cargo, a debug run, the owner build made by hand.
        assert_eq!(build_for(crate::OWNER_IDENTIFIER, false), None);
        for other in ["dev.nunchiro.app.rc2", ""] {
            assert_eq!(build_for(other, true), None, "{other}");
        }
    }

    // A build without the release key: no plugin, no port, no state, and the page is told nothing.
    #[test]
    fn an_owner_build_without_a_key_starts_nothing() {
        let app = tauri::test::mock_app();
        start(app.handle(), crate::OWNER_IDENTIFIER).unwrap();
        assert!(app.try_state::<Updates>().is_none());
        assert!(!active());
    }

    #[test]
    fn the_plugin_is_registered_only_inside_the_gate() {
        let main = include_str!("main.rs");
        assert_eq!(main.matches("tauri_plugin_updater").count(), 0);
        assert_eq!(main.matches("rc_update::start(").count(), 1);
        // The non-test half of this file holds the one registration, after the gate.
        let source = include_str!("rc_update.rs");
        let gate = source.find("build_for(identifier, has_key) else").unwrap();
        let plugin = source.find("app.plugin(tauri_plugin_updater").unwrap();
        assert!(gate < plugin);
    }

    #[test]
    fn the_page_gets_no_updater_permission_and_the_owner_no_updater_config() {
        let caps = include_str!("../capabilities/default.json");
        assert!(!caps.contains("updater:") && !caps.contains("process:"));
        let owner: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(owner["plugins"]["updater"].is_null());
    }

    // No key at all: build-rc.sh and build-release.sh pass this machine's public key as a --config overlay, so a build
    // never edits a file. The private keys live in ~/.config/nunchiro-rc and ~/.config/nunchiro-release.
    #[test]
    fn the_rc_and_release_configs_hold_no_key_and_no_endpoint() {
        for conf in [
            include_str!("../tauri.rc.conf.json"),
            include_str!("../tauri.release.conf.json"),
        ] {
            let conf: serde_json::Value = serde_json::from_str(conf).unwrap();
            let updater = &conf["plugins"]["updater"];
            assert_eq!(updater["endpoints"], serde_json::json!([]));
            assert_eq!(updater["requireSignedVersion"], true);
            let keys: Vec<_> = updater.as_object().unwrap().keys().collect();
            assert_eq!(keys.len(), 3, "{keys:?}");
            assert!(updater["pubkey"].is_null());
        }
    }

    #[test]
    fn a_build_follows_the_channel_of_its_own_version() {
        for release in ["0.1.0", "1.2.3", "0.1.0+build-7"] {
            assert_eq!(channel(release), "latest/download", "{release}");
        }
        for pre in [
            "0.1.0-pre.20261121083000",
            "1.0.0-rc.1",
            "0.1.0-pre.1+build-7",
        ] {
            assert_eq!(channel(pre), "download/prerelease", "{pre}");
        }
    }

    #[test]
    fn the_official_app_asks_github_first_and_the_rc_only_this_process() {
        let local = "http://127.0.0.1:4000/latest.json";
        assert_eq!(endpoints(Build::Rc, "0.1.0-rc.5", 4000), [local]);
        assert_eq!(
            endpoints(Build::Release, "0.1.0", 4000),
            [
                "https://github.com/develku/nunchiro/releases/latest/download/latest.json",
                local
            ]
        );
        assert_eq!(
            endpoints(Build::Release, "0.1.0-pre.5", 4000),
            [
                "https://github.com/develku/nunchiro/releases/download/prerelease/latest.json",
                local
            ]
        );
    }

    #[test]
    fn updates_come_only_from_the_folder_beside_the_rc_bundle() {
        assert_eq!(
            update_dir(Build::Rc, Path::new(RC), Path::new(HOME)).unwrap(),
            Path::new("/Users/k/Projects/n/.scratch/rc/update")
        );
    }

    #[test]
    fn applications_folders_and_other_bundles_are_refused() {
        for exe in [
            "/Applications/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/applications/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/Users/k/Applications/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/System/Volumes/Data/Applications/.scratch/rc/Nunchiro RC.app/Contents/MacOS/x",
            "/Users/k/Applications/.scratch/rc/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/.scratch/rc/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/tmp/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/Users/k/.scratch/rc/Nunchiro RC.app/Contents/Resources/nunchiro-app",
            "/Users/k/.scratch/rc/nunchiro-app",
        ] {
            let dir = update_dir(Build::Rc, Path::new(exe), Path::new(HOME));
            assert!(dir.is_err(), "{exe}");
        }
    }

    #[test]
    fn the_official_app_reads_the_feed_in_its_core_home_wherever_it_is_installed() {
        for exe in [
            "/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/n/.scratch/release/prerelease/Nunchiro.app/Contents/MacOS/nunchiro-app",
        ] {
            assert_eq!(
                update_dir(Build::Release, Path::new(exe), Path::new(HOME)).unwrap(),
                Path::new("/Users/k/.nunchiro/update"),
                "{exe}"
            );
        }
        for exe in [
            // where tauri builds it: a build, not an install
            "/Users/k/n/target/release/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/n/target/release/nunchiro-app",
            "/Applications/Nunchiro RC.app/Contents/MacOS/nunchiro-app",
            "/Applications/Nunchiro.app/Contents/Resources/nunchiro-app",
        ] {
            let dir = update_dir(Build::Release, Path::new(exe), Path::new(HOME));
            assert!(dir.is_err(), "{exe}");
        }
    }

    #[test]
    fn an_archive_is_taken_only_from_this_process_or_the_official_releases() {
        let url = |s: &str| s.parse::<Url>().unwrap();
        let rc = Build::Rc.archive();
        let good = format!("http://127.0.0.1:4000/{rc}");
        assert!(trusted_archive(Build::Rc, &url(&good), 4000));
        assert!(!trusted_archive(Build::Rc, &url(&good), 4001));
        // each build serves its own archive name
        assert!(!trusted_archive(Build::Release, &url(&good), 4000));
        let github =
            "https://github.com/develku/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz";
        assert!(trusted_archive(Build::Release, &url(github), 4000));
        assert!(trusted_archive(
            Build::Release,
            &url("http://127.0.0.1:4000/Nunchiro.app.tar.gz"),
            4000
        ));
        for bad in [
            format!("https://127.0.0.1:4000/{rc}"),
            format!("http://localhost:4000/{rc}"),
            format!("http://example.com:4000/{rc}"),
            "http://127.0.0.1:4000/other.tar.gz".to_string(),
            github.to_string(),
        ] {
            assert!(!trusted_archive(Build::Rc, &url(&bad), 4000), "{bad}");
        }
        for bad in [
            "http://github.com/develku/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz",
            "https://github.com/someone/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz",
            "https://github.com/develku/nunchiro/releases/download/../../../../someone/x/a.tar.gz",
            "https://github.com@example.com/develku/nunchiro/releases/download/v0.1.0/a.tar.gz",
            "https://github.com.example.com/develku/nunchiro/releases/download/v0.1.0/a.tar.gz",
            "https://example.com/develku/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz",
        ] {
            assert!(!trusted_archive(Build::Release, &url(bad), 4000), "{bad}");
        }
    }

    fn get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        // one write: `write!` splits the request, and the server reads only its first fragment
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    fn feed(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rc-update-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_server_answers_the_two_names_with_its_own_port() {
        let archive = Build::Release.archive();
        let dir = feed("serve");
        fs::write(dir.parent().unwrap().join("secret"), "no").unwrap();
        // as build-release.sh publishes it: the archive's GitHub address
        let manifest = format!(
            r#"{{"version":"1.0.0","platforms":{{"darwin-aarch64":{{"signature":"s","url":"{RELEASES}/download/v1.0.0/{archive}"}}}}}}"#
        );
        fs::write(dir.join(MANIFEST), manifest).unwrap();
        fs::write(dir.join(archive), "bytes").unwrap();
        let port = serve(dir.clone(), archive).unwrap();
        let reply = get(port, "/latest.json");
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains(&format!(r#""url":"http://127.0.0.1:{port}/{archive}""#)));
        assert!(!reply.contains("github.com") && reply.contains(r#""signature":"s""#));
        assert!(get(port, &format!("/{archive}")).ends_with("bytes"));
        let rc = Build::Rc.archive();
        for path in [
            "/",
            "/../secret",
            "/latest.json/",
            "/latest.json?x=1",
            &format!("/{rc}"),
        ] {
            assert!(get(port, path).starts_with("HTTP/1.1 404"), "{path}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    // A pair made once for this test with `tauri signer`; its private half was deleted. SIGNED is the signature of
    // ARCHIVE_BYTES, made for version 99.0.0.
    const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0Njc4QjUzODczODEzRUMKUldUc0V6aUhVNHRuTktBRUxwRVhzYzd1Q0ZQTiszcHhYVjVuZGtUcVc3b1E5Zm9meHdWQ3hWankK";
    const SIGNED: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUc0V6aUhVNHRuTlArd2oyQUhQUjMxeTkxTFpnSDczVUpUTldIYTNCczRIZDlFU1hRK2grMlprMXRpMzJHL0dIQ0wxT1NZaXFLZ012cUZMbkVCY3FBNnF3czFrWFZRUXdzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MjQ0MTc2CWZpbGU6YS50YXIuZ3oJdmVyc2lvbjo5OS4wLjAKc3NXVUI1M1VKYTdNVERwSW1rYXhUSzdpa2VIK25rcTJUOWFoUjN3Wm5CamtnTVNUeEJlbjJsOXFZV3lwdldaRFROaXZmeUhFNVc1bjZHaXhtZFpVQ1E9PQo=";
    const ARCHIVE_BYTES: &str = "nunchiro test archive";

    /// One check of a feed holding `version` and `archive`, by an app of version 0.1.0 (the mock's) that trusts TEST_KEY.
    fn checked(name: &str, version: &str, archive: &str) -> Result<Option<String>, String> {
        let dir = feed(name);
        let platform = serde_json::json!({"signature": SIGNED, "url": "http://127.0.0.1:0/x"});
        let manifest = serde_json::json!({
            "version": version,
            "platforms": {"darwin-aarch64": platform, "darwin-x86_64": platform},
        });
        fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        fs::write(dir.join(Build::Rc.archive()), archive).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": TEST_KEY, "endpoints": [], "dangerousInsecureTransportProtocol": true, "requireSignedVersion": true}),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updates = Updates {
            build: Build::Rc,
            port: serve(dir.clone(), Build::Rc.archive()).unwrap(),
            exe: RC.into(),
            dir: dir.clone(),
            ready: Mutex::new(None),
            logged: std::sync::Mutex::new(None),
        };
        let found = tauri::async_runtime::block_on(find(app.handle(), &updates));
        // What "Update ready" would install is exactly what was verified, or nothing.
        let ready = tauri::async_runtime::block_on(updates.ready.lock());
        assert_eq!(
            ready.as_ref().map(|r| r.bytes.as_slice()),
            found
                .as_ref()
                .ok()
                .and_then(|v| v.as_ref())
                .map(|_| ARCHIVE_BYTES.as_bytes())
        );
        fs::remove_dir_all(dir).unwrap();
        found
    }

    #[test]
    fn only_a_newer_version_is_an_update() {
        for old in ["0.1.0", "0.0.9", "0.1.0-pre.20261121083000"] {
            assert_eq!(checked("old", old, ARCHIVE_BYTES), Ok(None), "{old}");
        }
        assert_eq!(
            checked("new", "99.0.0", ARCHIVE_BYTES),
            Ok(Some("99.0.0".into()))
        );
    }

    #[test]
    fn a_bad_signature_is_refused() {
        // other bytes under the signature of the real archive
        let tampered = checked("tampered", "99.0.0", "nunchiro test archivE").unwrap_err();
        assert!(
            tampered.contains("signature verification failed"),
            "{tampered}"
        );
        // the real archive announced as a version its signature was not made for
        let renamed = checked("renamed", "99.0.1", ARCHIVE_BYTES).unwrap_err();
        assert!(renamed.contains("signed for version 99.0.0"), "{renamed}");
    }
}
