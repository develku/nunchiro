//! The installed app updates itself (ticket 1082, owner 11-23: one channel, the latest build that passed; sessions are
//! kept). `build_for` is the one gate behind `start`: only this app's own id, run from an installed `Nunchiro.app`,
//! updates. The isolated test build (the RC, its own id and home) and any build where cargo or tauri left it register
//! nothing and never check.
//!
//! Every such build reads the update folder the owner set in Settings > About (`<core home>/update-source`) through its
//! own CLI: `nunchiro update status` finds a new build there, `nunchiro update install` checks it, swaps the bundle and
//! replaces the core while the holders keep the sessions, and puts the backup back on any failure
//! (crates/nunchiro/src/update.rs). The app then relaunches.
//!
//! The official release (owner 11-21, `scripts/build-release.sh`: Developer ID signed, notarized, with the release update
//! key) also reads `latest.json` from GitHub Releases of nunchiro/nunchiro, then the local feed `<core home>/update`
//! served on loopback (the updater plugin fetches only over HTTP). The repository is private for now and a private
//! release asset needs a token; no token is put in an app (Orca and T3 Code both read public release URLs only). So
//! GitHub answers 404 and the local feed is the one in use, filled by `build-release.sh --local`. All of it runs here in
//! Rust and the page is granted no `updater:*` permission, so a page can never name an endpoint. A build is downloaded
//! and verified (signature, signed version, never older than the stored floor) before it shows; a tampered one never
//! shows and only logs a line. Ticket 1107: the verified archive then installs through the same CLI transaction as a
//! folder build (`nunchiro update install --archive`), never through the plugin's own install. Both ways end in the
//! same relaunch.
//!
//! Plugin use follows monocode `src-tauri/src/lib.rs` and `src/app/model/updater.ts` and vibe-kanban
//! `crates/tauri-app/src/main.rs`; the quiet check, then a restart the user chooses, follows Orca `src/main/updater.ts`.
//! Behaviour only, no code lifted.
use std::{
    fs,
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, Url, async_runtime::Mutex};
use tauri_plugin_updater::{Update, UpdaterExt};

const MANIFEST: &str = "latest.json";
const ARCHIVE: &str = "Nunchiro.app.tar.gz";
const EVERY: Duration = Duration::from_secs(10 * 60);
/// Where `scripts/build-release.sh --publish` puts the official app's releases.
const RELEASES: &str = "https://github.com/nunchiro/nunchiro/releases";
/// Ticket 1082: the update folder, one line in the core home (the CLI reads the same file).
const SOURCE: &str = "update-source";
/// Ticket 1107 (plan section 4): the highest version this home has run, in the core home; a feed build older than it is
/// never offered. An intentional rollback is the owner's own act, outside the updater.
const FLOOR: &str = "update-floor";
/// Ticket 1107: the verified feed archive while the CLI installs it, in the core home; removed afterwards.
const FEED_ARCHIVE: &str = "update-feed.tar.gz";

/// The two builds that update themselves.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Build {
    /// A build from main: only the update folder.
    Local,
    /// The official release: the update folder, then its signed feed.
    Release,
}

/// Set by `start` once updates run; `boot` tells the page, so the page of any other build never shows or calls anything.
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// `has_key`: the build carries the release update key, which only `build-release.sh` gives. Any other identifier is
/// the isolated test build (or another copy) and never updates.
fn build_for(identifier: &str, has_key: bool) -> Option<Build> {
    match identifier {
        crate::OWNER_IDENTIFIER if has_key => Some(Build::Release),
        crate::OWNER_IDENTIFIER => Some(Build::Local),
        _ => None,
    }
}

/// The feeds a release checks, in order: the plugin takes the first that answers with a manifest. GitHub's "latest" is
/// never a prerelease; ticket 1107 removed the prerelease feed (daily builds come from the update folder).
fn endpoints(port: u16) -> Vec<String> {
    vec![
        format!("{RELEASES}/latest/download/{MANIFEST}"),
        format!("http://127.0.0.1:{port}/{MANIFEST}"),
    ]
}

struct Updates {
    exe: PathBuf,
    /// This app's own CLI, which reads the update folder; `None` asks only the feed.
    cli: Option<PathBuf>,
    /// The official release's signed feed; `None` in a build from main.
    feed: Option<Feed>,
    /// Held through a check or an install, so the two never overlap.
    ready: Mutex<Option<Ready>>,
    /// The failure last written to core.log: one line per failure, not one per check.
    logged: std::sync::Mutex<Option<String>>,
}

struct Feed {
    port: u16,
    endpoints: Vec<String>,
    /// The version floor file (`FLOOR`).
    floor: PathBuf,
}

/// A build whose signature has passed; these exact bytes are the ones installed.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

/// The local feed folder of an installed `Nunchiro.app` (`<core home>/update`), which also proves the running bundle
/// may be replaced: anywhere but where tauri builds it (`bundle/macos`, a build and not an install, as
/// `unbundled_owner` has it). `exe` has its links resolved.
fn update_dir(exe: &Path, home: &Path) -> Result<PathBuf, String> {
    exe.ancestors()
        .nth(3)
        .filter(|b| {
            b.ends_with("Nunchiro.app")
                && exe.parent().is_some_and(|m| m.ends_with("Contents/MacOS"))
        })
        .and_then(Path::parent)
        .filter(|d| !d.ends_with("bundle/macos"))
        .map(|_| home.join("update"))
        .ok_or_else(|| {
            format!(
                "refused: {} is not an installed Nunchiro.app",
                exe.display()
            )
        })
}

/// This executable and its local feed folder, or why this bundle is not one to replace.
fn located() -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| format!("cannot resolve this executable: {e}"))?;
    Ok((update_dir(&exe, &crate::home()?)?, exe))
}

/// Everything a self-updating build does and any other build does not; `identifier` is the build's own.
pub fn start<R: Runtime>(app: &AppHandle<R>, identifier: &str) -> tauri::Result<()> {
    let key = app.config().plugins.0.get("updater");
    let has_key = key.is_some_and(|u| u["pubkey"].as_str().is_some_and(|k| !k.is_empty()));
    let Some(build) = build_for(identifier, has_key) else {
        return Ok(());
    };
    let (dir, exe) = match located() {
        Ok(found) => found,
        Err(e) => {
            log_line(&e);
            return Ok(());
        }
    };
    let feed = if build == Build::Release {
        app.plugin(tauri_plugin_updater::Builder::new().build())?;
        // `dir` is `<core home>/update`, so this is the floor file in the core home
        let floor = dir.with_file_name(FLOOR);
        if let Err(e) = raise_floor(&floor, &app.package_info().version) {
            log_line(&format!("update floor: {e}"));
        }
        let port = serve(dir)?;
        Some(Feed {
            port,
            endpoints: endpoints(port),
            floor,
        })
    } else {
        None
    };
    // Release and folder builds of this app only (`build_for` above); an isolated test build never gets here.
    if let (Ok(home), Some(user)) = (crate::home(), crate::passwd::passwd_home())
        && let Err(e) = claim_own(&exe, &home, &crate::update_claims::claims(&user))
    {
        log_line(&format!("update claim: {e}"));
    }
    app.manage(Updates {
        exe,
        cli: crate::own_cli(),
        feed,
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

/// The version or commit that is ready to install, if any. A failure is logged here and reaches the caller only as an `Err`.
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

/// How long `update status` may take; it holds the updater lock.
const STATUS_LIMIT: Duration = Duration::from_secs(30);
/// Round 6: an outer limit for `update install` too, well past the sum of its own bounded steps (copy and signature
/// check 300 s each, a busy core 300 s, the new core 120 s, sessions 30 s, a rollback about 60 s); reached only when one
/// of those broke.
const INSTALL_LIMIT: Duration = Duration::from_secs(20 * 60);

/// `nunchiro update <what>` from this app's CLI on its core home: its stdout, or its own words for the failure.
/// `archive`: install the verified feed archive at that path instead of the update folder's build (ticket 1107).
async fn update_cli(what: &'static str, archive: Option<PathBuf>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::home()?;
        let mut cmd = crate::core_command(Some(&home), |key| std::env::var_os(key));
        cmd.args(["update", what]);
        if let Some(archive) = &archive {
            cmd.arg("--archive").arg(archive);
        }
        let limit = if what == "status" {
            STATUS_LIMIT
        } else {
            INSTALL_LIMIT
        };
        // The twin of the CLI's subprocess runs: one helper (update_claims.rs), no pipes, group kill at the limit.
        // status: its one JSON line, no file past 64 KiB (soft RLIMIT_FSIZE; its git raises it for itself). install: its stderr is the owner's plain
        // reason; it cannot have a file limit (its ditto writes the bundle) and it is the app's own CLI, not a candidate.
        let output = if what == "status" {
            crate::update_claims::Output::KeepBounded
        } else {
            crate::update_claims::Output::Keep
        };
        let out =
            crate::update_claims::run_limited(&mut cmd, &home, Some(limit), output, || Ok(()))
                .map_err(|why| format!("the nunchiro CLI {why}"))?;
        let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
        if out.status.success() {
            Ok(text(&out.stdout))
        } else {
            Err(reason(&text(&out.stderr)).to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The CLI's own words for a failure: from its last "nunchiro: " on, so the "waiting for ..." lines it printed before
/// (ticket 1130 A-D3) are not part of the reason.
fn reason(stderr: &str) -> &str {
    stderr
        .rfind("nunchiro: ")
        .map_or(stderr, |at| &stderr[at + "nunchiro: ".len()..])
}

/// Ticket 1130 A-D3: while the CLI waits for a busy core, the window shows how many chats or jobs it waits for. It asks
/// the core the CLI's question every 2 s until the first 0, when the CLI goes on to the swap.
/// holder_floor 0: the app does not know the holder floor; the CLI's own count adds old holders, which are rare.
fn show_waiting<R: Runtime>(app: &AppHandle<R>) -> Waiting {
    let app = app.clone();
    poll_waiting(crate::home().ok(), move |count| {
        let _ = app.emit_to("main", "rc-update-wait", count);
    })
}

/// Round 2 (Codex MUST): one progress question's whole reply must be in within `ASK_LIMIT` and `ASK_BYTES`. Aborting
/// the waiter does not stop a blocking read already running, so this bound is what ends the last read of a finished or
/// cancelled install.
const ASK_LIMIT: Duration = Duration::from_secs(2);
const ASK_BYTES: u64 = 4096;

/// The progress waiter; dropping it (the install done, failed, or its future dropped) stops the questions.
struct Waiting(tauri::async_runtime::JoinHandle<()>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn poll_waiting(home: Option<PathBuf>, emit: impl Fn(u64) + Send + 'static) -> Waiting {
    Waiting(tauri::async_runtime::spawn(async move {
        let Some(home) = home else { return };
        loop {
            let home = home.clone();
            let ask = move || {
                let request = serde_json::json!({"op": "exit_blockers", "holder_floor": 0});
                let bound = (std::time::Instant::now() + ASK_LIMIT, ASK_BYTES);
                crate::core_reply_at(&home, request, Some(bound))
            };
            let count = tauri::async_runtime::spawn_blocking(ask)
                .await
                .ok()
                .flatten()
                .and_then(|reply| reply["Ok"]["count"].as_u64())
                .unwrap_or(0);
            emit(count);
            if count == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }))
}

/// The commit of a new build in the update folder (short, as the page shows it), or why the folder was refused.
async fn local(updates: &Updates) -> Result<Option<String>, String> {
    if updates.cli.is_none() {
        return Ok(None);
    }
    let status: serde_json::Value =
        serde_json::from_str(&update_cli("status", None).await?).map_err(|e| e.to_string())?;
    match status["state"].as_str() {
        Some("ready") => Ok(status["commit"]
            .as_str()
            .map(|c| c.chars().take(9).collect())),
        Some("refused") => Err(status["reason"].as_str().unwrap_or("refused").to_string()),
        _ => {
            // Why a folder build is not offered (older, off main, main unreachable), one line per reason.
            static SAID: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
            if let Some(why) = status["reason"].as_str() {
                once(&SAID, why);
            }
            Ok(None)
        }
    }
}

async fn find<R: Runtime>(app: &AppHandle<R>, updates: &Updates) -> Result<Option<String>, String> {
    let mut ready = updates.ready.lock().await;
    if let Some(commit) = local(updates).await? {
        return Ok(Some(commit));
    }
    let held = |r: &Option<Ready>| r.as_ref().map(|r| r.update.version.clone());
    let Some(feed) = &updates.feed else {
        return Ok(None);
    };
    let failed = |e: tauri_plugin_updater::Error| format!("update check failed: {e}");
    let feeds = feed
        .endpoints
        .iter()
        .map(|e| e.parse())
        .collect::<Result<Vec<Url>, _>>()
        .map_err(|e| format!("bad endpoint: {e}"))?;
    let floor = floor(&feed.floor);
    // shortcut: no proxy, because the loopback feed must never go through one; a user behind a proxy gets no update
    // from GitHub. Upgrade when one asks.
    let checked = app
        .updater_builder()
        .endpoints(feeds)
        .map_err(failed)?
        // The plugin's own rule (newer than this app), and never older than the floor.
        .version_comparator(move |current, remote| {
            remote.version > current && floor.as_ref().is_none_or(|f| remote.version >= *f)
        })
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
    if !trusted_archive(&update.download_url, feed.port) {
        return Err(format!("refused: archive at {}", update.download_url));
    }
    // The whole archive has to arrive within this, over the network for a release.
    update.timeout = Some(Duration::from_secs(10 * 60));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(failed)?;
    *ready = Some(Ready { update, bytes });
    Ok(held(&ready))
}

/// The insecure-transport option is on for the whole plugin; this and the endpoints above are what limit it. An archive
/// comes from this process (the local feed) or from the official GitHub releases. The signature is what proves the
/// bytes either way.
fn trusted_archive(url: &Url, port: u16) -> bool {
    let local = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.path() == format!("/{ARCHIVE}");
    // `Url` has already resolved any `..`, so the prefix is the real folder.
    local || url.as_str().starts_with(&format!("{RELEASES}/download/"))
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn note(updates: &Updates, failure: &str) {
    once(&updates.logged, failure);
}

/// Logs `line` unless it is the line last logged from `slot`.
fn once(slot: &std::sync::Mutex<Option<String>>, line: &str) {
    let mut logged = lock(slot);
    // Only a line that was written counts: the core may not have made its log yet at the first check.
    if logged.as_deref() != Some(line) && log_line(line) {
        *logged = Some(line.to_string());
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

fn serve(dir: PathBuf) -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let dir = dir.clone();
            thread::spawn(move || {
                let _ = answer(stream, &dir, port);
            });
        }
    });
    Ok(port)
}

/// The two published files by exact name, and nothing else. Neither is secret: the signature is what protects them.
fn answer(mut stream: TcpStream, dir: &Path, port: u16) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut head = [0; 2048];
    let read = stream.read(&mut head)?;
    let head = String::from_utf8_lossy(&head[..read]);
    let path = head
        .strip_prefix("GET /")
        .and_then(|rest| rest.split(' ').next());
    let body = match path {
        // Security round 3: opened first and judged on the descriptor, bounded (no FIFO wait, no huge read).
        Some(MANIFEST) => crate::update_claims::read_small(&dir.join(MANIFEST), 64 * 1024)
            .and_then(|m| local_manifest(&m, &format!("http://127.0.0.1:{port}/{ARCHIVE}"))),
        Some(ARCHIVE) => crate::update_claims::read_small(&dir.join(ARCHIVE), 1 << 30),
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
/// manifest was published with (GitHub's).
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

/// Ticket 1082: the update folder (Settings > About). `Some` sets it (empty turns updates off); the answer is the folder now set.
#[tauri::command]
pub fn update_source(
    app: AppHandle,
    webview: tauri::Webview,
    folder: Option<String>,
) -> Result<String, String> {
    ready_for(&app, &webview)?;
    let file = crate::home()?.join(SOURCE);
    if let Some(folder) = folder {
        let folder = folder.trim();
        if folder.is_empty() {
            match fs::remove_file(&file) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        } else if !Path::new(folder).is_absolute() || folder.contains('\n') || folder.len() > 4000 {
            return Err(format!("not a full folder path: {folder}"));
        } else {
            save(&file, format!("{folder}\n").as_bytes())?;
        }
    }
    Ok(read_small(&file).unwrap_or_default().trim().to_string())
}

/// The stored version floor, if any; an unreadable one counts as none and is written again at the next start.
fn floor(file: &Path) -> Option<semver::Version> {
    semver::Version::parse(read_small(file)?.trim()).ok()
}

/// At start: the floor becomes this app's version when that is higher.
fn raise_floor(file: &Path, running: &semver::Version) -> Result<(), String> {
    if floor(file).is_some_and(|f| f >= *running) {
        return Ok(());
    }
    save(file, format!("{running}\n").as_bytes())
}

/// Security round 3: `fs::write` follows a link at `file` and truncates its target. A new file beside it (O_EXCL, so
/// no link is followed) is renamed over it; a link or a non-file at `file` is refused.
fn save(file: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if fs::symlink_metadata(file).is_ok_and(|m| !m.is_file()) {
        return Err(format!(
            "refused: {} is a link or not a file",
            file.display()
        ));
    }
    let new = file.with_extension("new");
    let _ = fs::remove_file(&new); // a leftover, or a link: removes the entry itself, never its target
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&new)
        .map_err(|e| format!("{}: {e}", new.display()))?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&new, file).map_err(|e| e.to_string())
}

/// A small regular file's text, opened first and judged on the descriptor (update_claims.rs): a planted link, FIFO or
/// huge file reads as none.
fn read_small(path: &Path) -> Option<String> {
    String::from_utf8(crate::update_claims::read_small(path, 64 * 1024)?).ok()
}

/// Security round 3: the window claims its own installed bundle for its own home, the first time any home does. Only
/// this app process writes a claim (never the CLI or a core, which an agent can run under a home of its own); the
/// CLI's `update install` then accepts this home only.
fn claim_own(exe: &Path, home: &Path, claims: &Path) -> Result<bool, String> {
    let bundle = exe.ancestors().nth(3).ok_or("no bundle")?;
    crate::update_claims::claim(claims, bundle, home)
}

/// Installs what is ready and relaunches. A build in the update folder goes first, then a verified release from the
/// feed; either way this app's CLI swaps the bundle and the core and has put everything back when it fails (1082).
#[tauri::command]
pub async fn rc_update_install(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    let updates = ready_for(&app, &webview)?;
    let ready = updates.ready.lock().await;
    let waiting = show_waiting(&app);
    let result = match local(&updates).await {
        Ok(Some(_)) => update_cli("install", None).await.map(drop),
        Err(e) => Err(e),
        Ok(None) => match ready.as_ref() {
            None => Err("no verified update is ready".to_string()),
            Some(r) => feed_install(&r.bytes).await,
        },
    };
    drop(waiting);
    let _ = app.emit_to("main", "rc-update-wait", 0);
    if let Err(e) = result {
        note(&updates, &e);
        return Err(e);
    }
    app.restart()
}

/// Ticket 1107: the verified archive goes to this app's CLI as a private file of the core home, which installs it as it
/// installs a folder build: stamp, Part B, backup, swap, core replace, every session back, or the rollback.
async fn feed_install(bytes: &[u8]) -> Result<(), String> {
    located()?; // asked again at the moment of replacing
    let file = crate::home()?.join(FEED_ARCHIVE);
    save(&file, bytes)?;
    let done = update_cli("install", Some(file.clone())).await.map(drop);
    let _ = fs::remove_file(&file);
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-app-1082-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Ticket 1130 A-D3 round 2: a stand-in core at a new home that answers every question with `answer`; each
    /// connection is counted.
    fn odd_core(
        name: &str,
        answer: fn(&mut std::os::unix::net::UnixStream),
    ) -> (PathBuf, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::BufRead;
        let home = scratch(name);
        fs::write(home.join("core.token"), "test").unwrap();
        let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = asked.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut request = String::new();
                let _ = std::io::BufReader::new(&stream).read_line(&mut request);
                answer(&mut stream);
            }
        });
        (home, asked)
    }

    const THREE: &str = "{\"Ok\":{\"type\":\"exit_blockers\",\"count\":3}}\n";

    fn ask(home: &Path, limit: Duration) -> Option<u64> {
        let bound = (std::time::Instant::now() + limit, ASK_BYTES);
        let request = serde_json::json!({"op": "exit_blockers", "holder_floor": 0});
        crate::core_reply_at(home, request, Some(bound)).and_then(|r| r["Ok"]["count"].as_u64())
    }

    // Ticket 1130 A-D3 round 2 (Codex MUST): the progress reply must be whole, small and in time. Before, the reader took
    // any size and each dripped byte renewed its 3 s read.
    #[test]
    fn a_progress_reply_that_is_too_big_or_too_late_is_not_read() {
        use std::io::Write;
        fn whole(stream: &mut std::os::unix::net::UnixStream) {
            let _ = stream.write_all(THREE.as_bytes());
        }
        // A whole reply well inside ASK_LIMIT but late by a busy host's scheduling, as a loaded test runner answers.
        fn whole_but_slow(stream: &mut std::os::unix::net::UnixStream) {
            std::thread::sleep(Duration::from_millis(400));
            let _ = stream.write_all(THREE.as_bytes());
        }
        fn oversized(stream: &mut std::os::unix::net::UnixStream) {
            let _ = stream.write_all(" ".repeat(ASK_BYTES as usize + 1).as_bytes());
            let _ = stream.write_all(THREE.as_bytes());
        }
        // A byte every 100 ms for 3 s, then the reply: a read that each byte renewed would end only at 3 s.
        fn drip_then_late(stream: &mut std::os::unix::net::UnixStream) {
            for _ in 0..30 {
                if stream.write_all(b" ").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = stream.write_all(THREE.as_bytes());
        }
        // Whole replies get the app's own limit: a busy host may take a few hundred ms to answer.
        let (home, _) = odd_core("ask-whole", whole);
        assert_eq!(ask(&home, ASK_LIMIT), Some(3));
        let (home, _) = odd_core("ask-slow", whole_but_slow);
        assert_eq!(
            ask(&home, ASK_LIMIT),
            Some(3),
            "a whole reply inside ASK_LIMIT"
        );
        let (home, _) = odd_core("ask-big", oversized);
        assert_eq!(ask(&home, ASK_LIMIT), None, "a reply past ASK_BYTES");
        let (home, _) = odd_core("ask-late", drip_then_late);
        let start = std::time::Instant::now();
        assert_eq!(
            ask(&home, Duration::from_millis(300)),
            None,
            "a reply after the limit"
        );
        // Ended by the 300 ms deadline, not by the drip's end at 3 s; the slack is for a busy host.
        assert!(start.elapsed() < Duration::from_millis(2000));
    }

    // Ticket 1130 A-D3 round 2 (Codex MUST): cancelling the install while a progress read runs ends that read within
    // ASK_LIMIT and asks nothing more. Before, aborting the waiter left the blocking read running for as long as the core
    // dripped bytes.
    #[test]
    fn cancelling_the_install_ends_a_progress_read_that_is_running() {
        use std::io::Write;
        static CLOSED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
        fn drip(stream: &mut std::os::unix::net::UnixStream) {
            for _ in 0..100 {
                if stream.write_all(b" ").is_err() {
                    *CLOSED.lock().unwrap() = Some(std::time::Instant::now());
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let (home, asked) = odd_core("cancel", drip);
        let waiting = poll_waiting(Some(home), |_| {});
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        let cancelled = std::time::Instant::now();
        drop(waiting);
        let deadline = cancelled + ASK_LIMIT + Duration::from_secs(1);
        while CLOSED.lock().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let closed = CLOSED
            .lock()
            .unwrap()
            .expect("the read still runs after the cancel");
        assert!(closed - cancelled < ASK_LIMIT + Duration::from_secs(1));
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            asked.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "no question after the cancel"
        );
    }

    // Ticket 1130 A-D3: the CLI's progress lines before its failure are not the reason shown.
    #[test]
    fn the_shown_reason_is_the_cli_failure_without_its_waiting_lines() {
        let stderr = "waiting for 2 chat(s) or job(s) to finish\nwaiting for 1 chat(s) or job(s) to finish\nnunchiro: refused: 1 chat(s) or job(s) still need the running core after 300 s; nothing was changed";
        assert_eq!(
            reason(stderr),
            "refused: 1 chat(s) or job(s) still need the running core after 300 s; nothing was changed"
        );
        assert_eq!(
            reason("nunchiro: no new build is ready"),
            "no new build is ready"
        );
        assert_eq!(reason("plain words"), "plain words");
    }

    #[test]
    fn the_window_claims_its_own_bundle_once() {
        let dir = scratch("claim");
        let exe = dir.join("Nunchiro.app/Contents/MacOS/nunchiro-app");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let (home, other, claims) = (dir.join("home"), dir.join("other"), dir.join("claims"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&other).unwrap();
        assert!(claim_own(&exe, &home, &claims).unwrap());
        // a later start under another home takes nothing
        assert!(!claim_own(&exe, &other, &claims).unwrap());
        assert_eq!(
            crate::update_claims::claimant(&claims, &dir.join("Nunchiro.app")),
            Some(home.canonicalize().unwrap())
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saving_the_folder_never_follows_a_link() {
        let dir = scratch("save");
        let (file, target) = (dir.join("update-source"), dir.join("target"));
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, &file).unwrap();
        let why = save(&file, b"/x\n").unwrap_err();
        assert!(why.contains("is a link"), "{why}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        // a link planted at the new file beside it is removed, not written through
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&target, file.with_extension("new")).unwrap();
        save(&file, b"/x\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        assert_eq!(read_small(&file).unwrap(), "/x\n");
        assert!(
            !fs::symlink_metadata(&file)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_planted_fifo_or_huge_file_reads_as_none() {
        let dir = scratch("fifo");
        let file = dir.join("update-source");
        let c = std::ffi::CString::new(file.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_small(&file).is_none()); // returns at once
        fs::remove_file(&file).unwrap();
        fs::write(&file, vec![b'/'; 64 * 1024 + 1]).unwrap();
        assert!(read_small(&file).is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_status_call_that_hangs_is_cut_at_its_limit() {
        let dir = scratch("limited");
        let run = |cmd: &mut std::process::Command, limit| {
            crate::update_claims::run_limited(
                cmd,
                &dir,
                Some(limit),
                crate::update_claims::Output::KeepBounded,
                || Ok(()),
            )
        };
        let started = std::time::Instant::now();
        let why = run(
            std::process::Command::new("/bin/sleep").arg("30"),
            Duration::from_millis(300),
        )
        .err()
        .unwrap();
        assert!(why.contains("did not end within"), "{why}");
        assert!(started.elapsed() < Duration::from_secs(5));
        let out = run(
            std::process::Command::new("/bin/echo").arg("ok"),
            Duration::from_secs(5),
        )
        .ok()
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok\n");
        // round 6: a background process that keeps the output and outlives the CLI does not hold the call
        let bg = dir.join("bg.pid");
        let started = std::time::Instant::now();
        let out = run(
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("sleep 30 & echo $! > {}; echo ready", bg.display())),
            Duration::from_secs(10),
        )
        .ok()
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ready\n");
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = fs::read_to_string(&bg).unwrap().trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "killed with its group once the CLI ended"
        );
        // a flood stops at 64 KiB on disk (RLIMIT_FSIZE), and 64 KiB is read
        let out = run(
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg("head -c 5000000 /dev/zero"),
            Duration::from_secs(20),
        )
        .ok()
        .unwrap();
        assert_eq!(out.stdout.len(), 64 * 1024);
        // no file is left behind in the scratch folder
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1); // bg.pid
        fs::remove_dir_all(dir).unwrap();
    }

    const HOME: &str = "/Users/k/.nunchiro";

    #[test]
    fn only_this_app_updates_and_an_isolated_test_build_never() {
        assert_eq!(
            build_for(crate::OWNER_IDENTIFIER, true),
            Some(Build::Release)
        );
        assert_eq!(
            build_for(crate::OWNER_IDENTIFIER, false),
            Some(Build::Local)
        );
        // the isolated test build keeps its own id and home, key or not
        for other in ["dev.nunchiro.app.rc", "dev.nunchiro.app.rc2", ""] {
            assert_eq!(build_for(other, true), None, "{other}");
            assert_eq!(build_for(other, false), None, "{other}");
        }
    }

    // An isolated test build, and this app run from outside an installed bundle (a cargo test): no plugin, no port, no
    // state, and the page is told nothing.
    #[test]
    fn a_test_build_or_an_uninstalled_app_starts_nothing() {
        // Ticket 1111: `start` logs its refusal to crate::home(); a test resolving the owner's home wrote to its core.log.
        let home = crate::home().unwrap();
        assert!(
            !home.components().any(|c| c.as_os_str() == ".nunchiro"),
            "{}",
            home.display()
        );
        for id in ["dev.nunchiro.app.rc", crate::OWNER_IDENTIFIER] {
            let app = tauri::test::mock_app();
            start(app.handle(), id).unwrap();
            assert!(app.try_state::<Updates>().is_none(), "{id}");
            assert!(!active(), "{id}");
        }
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
    fn the_official_app_asks_github_first_then_this_process() {
        let local = "http://127.0.0.1:4000/latest.json";
        // every version, a prerelease too, reads GitHub's "latest" (ticket 1107: no prerelease feed)
        assert_eq!(
            endpoints(4000),
            [
                "https://github.com/nunchiro/nunchiro/releases/latest/download/latest.json",
                local
            ]
        );
    }

    #[test]
    fn the_app_reads_the_feed_in_its_core_home_wherever_it_is_installed() {
        for exe in [
            "/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app",
            "/Users/k/n/.scratch/release/prerelease/Nunchiro.app/Contents/MacOS/nunchiro-app",
        ] {
            assert_eq!(
                update_dir(Path::new(exe), Path::new(HOME)).unwrap(),
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
            assert!(
                update_dir(Path::new(exe), Path::new(HOME)).is_err(),
                "{exe}"
            );
        }
    }

    #[test]
    fn an_archive_is_taken_only_from_this_process_or_the_official_releases() {
        let url = |s: &str| s.parse::<Url>().unwrap();
        let good = format!("http://127.0.0.1:4000/{ARCHIVE}");
        assert!(trusted_archive(&url(&good), 4000));
        assert!(!trusted_archive(&url(&good), 4001));
        let github =
            "https://github.com/nunchiro/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz";
        assert!(trusted_archive(&url(github), 4000));
        for bad in [
            format!("https://127.0.0.1:4000/{ARCHIVE}"),
            format!("http://localhost:4000/{ARCHIVE}"),
            format!("http://example.com:4000/{ARCHIVE}"),
            "http://127.0.0.1:4000/other.tar.gz".to_string(),
            "http://127.0.0.1:4000/Nunchiro-RC.app.tar.gz".to_string(),
            "http://github.com/nunchiro/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz"
                .into(),
            "https://github.com/someone/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz"
                .into(),
            "https://github.com/nunchiro/nunchiro/releases/download/../../../../someone/x/a.tar.gz"
                .into(),
            "https://github.com@example.com/nunchiro/nunchiro/releases/download/v0.1.0/a.tar.gz"
                .into(),
            "https://github.com.example.com/nunchiro/nunchiro/releases/download/v0.1.0/a.tar.gz"
                .into(),
            "https://example.com/nunchiro/nunchiro/releases/download/v0.1.0/Nunchiro.app.tar.gz"
                .into(),
        ] {
            assert!(!trusted_archive(&url(&bad), 4000), "{bad}");
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

    #[test]
    fn the_feed_answers_a_planted_fifo_at_once() {
        let dir = feed("fifo");
        let c = std::ffi::CString::new(dir.join(ARCHIVE).as_os_str().as_encoded_bytes()).unwrap();
        let _ = fs::remove_file(dir.join(ARCHIVE));
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let port = serve(dir.clone()).unwrap();
        assert!(get(port, &format!("/{ARCHIVE}")).starts_with("HTTP/1.1 404"));
        fs::remove_dir_all(dir).unwrap();
    }

    fn feed(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rc-update-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_server_answers_the_two_names_with_its_own_port() {
        let archive = ARCHIVE;
        let dir = feed("serve");
        fs::write(dir.parent().unwrap().join("secret"), "no").unwrap();
        // as build-release.sh publishes it: the archive's GitHub address
        let manifest = format!(
            r#"{{"version":"1.0.0","platforms":{{"darwin-aarch64":{{"signature":"s","url":"{RELEASES}/download/v1.0.0/{archive}"}}}}}}"#
        );
        fs::write(dir.join(MANIFEST), manifest).unwrap();
        fs::write(dir.join(archive), "bytes").unwrap();
        let port = serve(dir.clone()).unwrap();
        let reply = get(port, "/latest.json");
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains(&format!(r#""url":"http://127.0.0.1:{port}/{archive}""#)));
        assert!(!reply.contains("github.com") && reply.contains(r#""signature":"s""#));
        assert!(get(port, &format!("/{archive}")).ends_with("bytes"));
        for path in [
            "/",
            "/../secret",
            "/latest.json/",
            "/latest.json?x=1",
            "/Nunchiro-RC.app.tar.gz",
        ] {
            assert!(get(port, path).starts_with("HTTP/1.1 404"), "{path}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// Ticket 1107: a minisign key pair made for this test run; its private half never leaves the process. Legacy "Ed"
    /// mode, which the plugin accepts; `tauri signer` prehashes, which changes only the bytes the signature covers.
    struct Signer {
        key: ring::signature::Ed25519KeyPair,
        id: [u8; 8],
    }

    fn b64(bytes: impl AsRef<[u8]>) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    impl Signer {
        fn new() -> Self {
            use ring::rand::SecureRandom as _;
            let rng = ring::rand::SystemRandom::new();
            let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
            let mut id = [0; 8];
            rng.fill(&mut id).unwrap();
            let key = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
            Self { key, id }
        }

        /// The public key as the updater config takes it: base64 of minisign's two-line key file.
        fn pubkey(&self) -> String {
            use ring::signature::KeyPair as _;
            let key = [b"Ed".as_slice(), &self.id, self.key.public_key().as_ref()].concat();
            b64(format!(
                "untrusted comment: minisign public key\n{}\n",
                b64(key)
            ))
        }

        /// What `tauri signer sign --app-version <version>` puts in latest.json for `data`.
        fn sign(&self, data: &[u8], version: &str) -> String {
            let sig = self.key.sign(data);
            let trusted = format!("timestamp:1795244176\tfile:{ARCHIVE}\tversion:{version}");
            let global = self.key.sign(&[sig.as_ref(), trusted.as_bytes()].concat());
            let line = [b"Ed".as_slice(), &self.id, sig.as_ref()].concat();
            b64(format!(
                "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {trusted}\n{}\n",
                b64(line),
                b64(global.as_ref())
            ))
        }
    }

    const ARCHIVE_BYTES: &[u8] = b"nunchiro test archive";

    /// One fixture feed: `latest.json` announces `version` with `signature`, the archive holds `archive`, the stored
    /// floor is `floor`. `url`: the manifest is served as written by a plain server, so its archive address stays.
    struct Fixture<'a> {
        version: &'a str,
        archive: &'a [u8],
        signature: String,
        floor: Option<&'a str>,
        url: Option<&'a str>,
    }

    impl<'a> Fixture<'a> {
        /// The archive signed by `by` for `version`, announced as that version.
        fn signed(by: &Signer, version: &'a str) -> Self {
            Fixture {
                version,
                archive: ARCHIVE_BYTES,
                signature: by.sign(ARCHIVE_BYTES, version),
                floor: None,
                url: None,
            }
        }
    }

    /// Serves `body` to every request, as GitHub serves a release's latest.json; its port.
    fn plain_server(body: String) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let _ = stream.read(&mut [0; 2048]);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    /// One check of `fixture` by an app of version 0.1.0 (the mock's) that trusts `trusted`, with its own folder as the
    /// core home's stand-in; nothing reads ~/.nunchiro, asks GitHub or runs a CLI.
    fn checked(name: &str, trusted: &Signer, fixture: Fixture) -> Result<Option<String>, String> {
        let dir = feed(name);
        let platform = serde_json::json!({
            "signature": fixture.signature,
            "url": fixture.url.unwrap_or("http://127.0.0.1:0/x"),
        });
        let manifest = serde_json::json!({
            "version": fixture.version,
            "platforms": {"darwin-aarch64": platform, "darwin-x86_64": platform},
        });
        fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        fs::write(dir.join(ARCHIVE), fixture.archive).unwrap();
        let floor = dir.join(FLOOR);
        if let Some(f) = fixture.floor {
            fs::write(&floor, format!("{f}\n")).unwrap();
        }
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": trusted.pubkey(), "endpoints": [], "dangerousInsecureTransportProtocol": true, "requireSignedVersion": true}),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let port = serve(dir.clone()).unwrap();
        let endpoint = match fixture.url {
            Some(_) => plain_server(manifest.to_string()),
            None => port,
        };
        let updates = Updates {
            exe: "/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app".into(),
            cli: None,
            feed: Some(Feed {
                port,
                endpoints: vec![format!("http://127.0.0.1:{endpoint}/{MANIFEST}")],
                floor,
            }),
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
                .map(|_| fixture.archive)
        );
        fs::remove_dir_all(dir).unwrap();
        found
    }

    #[test]
    fn a_signed_newer_build_is_ready_with_exactly_its_verified_bytes() {
        let key = Signer::new();
        assert_eq!(
            checked("new", &key, Fixture::signed(&key, "99.0.0")),
            Ok(Some("99.0.0".into()))
        );
    }

    #[test]
    fn a_bad_signature_is_refused() {
        let key = Signer::new();
        // other bytes under the signature of the real archive
        let tampered = checked(
            "tampered",
            &key,
            Fixture {
                archive: b"nunchiro test archivE",
                ..Fixture::signed(&key, "99.0.0")
            },
        )
        .unwrap_err();
        assert!(
            tampered.contains("signature verification failed"),
            "{tampered}"
        );
        // a valid signature by a key this app does not trust
        let other =
            checked("other-key", &key, Fixture::signed(&Signer::new(), "99.0.0")).unwrap_err();
        assert!(other.contains("created with a different key"), "{other}");
    }

    #[test]
    fn a_version_the_signature_was_not_made_for_is_refused() {
        let key = Signer::new();
        // the real archive announced as a version its signature was not made for
        let renamed = checked(
            "renamed",
            &key,
            Fixture {
                version: "99.0.1",
                ..Fixture::signed(&key, "99.0.0")
            },
        )
        .unwrap_err();
        assert!(renamed.contains("signed for version 99.0.0"), "{renamed}");
    }

    #[test]
    fn an_older_build_or_one_below_the_floor_is_never_offered() {
        let key = Signer::new();
        // not newer than this app (0.1.0), each validly signed for its own version
        for old in ["0.1.0", "0.0.9", "0.1.0-pre.20261121083000"] {
            assert_eq!(
                checked("old", &key, Fixture::signed(&key, old)),
                Ok(None),
                "{old}"
            );
        }
        // newer than this app, but older than a version this home has already run
        let below = Fixture {
            floor: Some("100.0.0"),
            ..Fixture::signed(&key, "99.0.0")
        };
        assert_eq!(checked("below", &key, below), Ok(None));
        let at = Fixture {
            floor: Some("99.0.0"),
            ..Fixture::signed(&key, "99.0.0")
        };
        assert_eq!(checked("at-floor", &key, at), Ok(Some("99.0.0".into())));
    }

    #[test]
    fn an_archive_from_another_repository_is_refused_before_download() {
        let key = Signer::new();
        let foreign = Fixture {
            url: Some(
                "https://github.com/someone/nunchiro/releases/download/v99.0.0/Nunchiro.app.tar.gz",
            ),
            ..Fixture::signed(&key, "99.0.0")
        };
        let why = checked("foreign", &key, foreign).unwrap_err();
        assert_eq!(
            why,
            "refused: archive at https://github.com/someone/nunchiro/releases/download/v99.0.0/Nunchiro.app.tar.gz"
        );
    }

    #[test]
    fn the_floor_rises_to_the_running_version_and_never_falls() {
        let dir = scratch("floor");
        let file = dir.join(FLOOR);
        let v = |s: &str| semver::Version::parse(s).unwrap();
        raise_floor(&file, &v("0.2.0")).unwrap();
        assert_eq!(floor(&file), Some(v("0.2.0")));
        raise_floor(&file, &v("0.1.0")).unwrap();
        assert_eq!(
            floor(&file),
            Some(v("0.2.0")),
            "an older app keeps the floor"
        );
        raise_floor(&file, &v("0.3.0")).unwrap();
        assert_eq!(floor(&file), Some(v("0.3.0")));
        // unreadable: counts as none and is written again
        fs::write(&file, "junk").unwrap();
        assert_eq!(floor(&file), None);
        raise_floor(&file, &v("0.3.0")).unwrap();
        assert_eq!(floor(&file), Some(v("0.3.0")));
        fs::remove_dir_all(dir).unwrap();
    }
}
