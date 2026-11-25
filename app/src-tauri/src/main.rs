//! Nunchiro window: a Tauri shell around web/ that is a client of `nunchiro serve`.
//! It only starts the core if needed and hands the page its loopback port and token at each page load;
//! every piece of data then travels over the loopback WebSocket, never Tauri `invoke()`. Ticket 08 adds the
//! `notify` command: an OS notification for a new waiting item, whose click focuses that session.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    webview::{PageLoadEvent, PermissionKind, PermissionResponse},
};
use tauri_plugin_notification::NotificationExt;

mod artifacts;
mod browser; // v25-19
mod cli_install; // ticket 262
#[cfg(all(debug_assertions, dev))]
mod dev_load; // ticket 172
mod fonts; // v1a-67
mod gate_shot; // ticket 464 follow-up: a gate run's page picture
mod passwd; // V2.5-34 r2
mod permissions; // ticket 252
mod rc_update; // ticket 1082: the installed app updates itself (G2 for the official release)
mod save; // v1a-68
#[path = "../../../crates/nunchiro/src/update_claims.rs"]
#[allow(dead_code)] // the CLI reads the claims; the app only writes its own
mod update_claims; // ticket 1082 round 3: the update claims, shared with the CLI
mod window_chrome; // v25f-title-hidden

/// The owner's own app: bundle id, WebKit storage (`~/Library/WebKit/<bundle id>`) and core home `~/.nunchiro`.
const OWNER_IDENTIFIER: &str = "dev.nunchiro.app";
/// V2.5-34: the identifier this build was made with (`tauri.rc.conf.json` gives the RC its own), set first in `main`.
static IDENTIFIER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn identifier() -> &'static str {
    IDENTIFIER.get().map_or(OWNER_IDENTIFIER, String::as_str)
}

/// Resolved once: the environment does not change while the app runs (nothing here sets a variable).
static HOME_DIR: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();

fn home() -> Result<PathBuf, String> {
    HOME_DIR
        .get_or_init(|| resolve_home().map(|(home, _)| home))
        .clone()
}

fn resolve_home() -> Result<(PathBuf, Option<String>), String> {
    // Ticket 1111: a cargo test runs as the owner's build with no NUNCHIRO_HOME, so this gave ~/.nunchiro and
    // rc_update's start test wrote its refusal into the owner's core.log. A test never resolves a real home.
    #[cfg(test)]
    {
        static TEST_HOME: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
        TEST_HOME
            .get_or_init(|| create_test_home().map_err(|e| format!("create app test home: {e}")))
            .clone()
            .map(|home| (home, None))
    }
    #[cfg(not(test))]
    home_for(
        identifier(),
        std::env::var_os("NUNCHIRO_HOME"),
        std::env::var_os("HOME"),
        passwd::passwd_home(),
    )
}

/// Ticket 1116: create exclusively, with private permissions, before any test can write into it.
/// A collision (including a symlink) is an error; an existing path is never reused.
#[cfg(test)]
fn create_test_home() -> std::io::Result<PathBuf> {
    use std::io::Read;
    use std::os::unix::fs::DirBuilderExt;
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let home = std::env::temp_dir().join(format!(
        "nunchiro-app-test-{}-{:032x}",
        std::process::id(),
        u128::from_ne_bytes(random)
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&home)?;
    Ok(home)
}

/// The one place a build's core home comes from (V2.5-34, owner 2026-11-05: an RC build must never touch the owner's data),
/// with a note when an inherited `NUNCHIRO_HOME` was set aside. The owner's build: `NUNCHIRO_HOME`, else
/// `~/.nunchiro`. Any other identifier (the RC): `NUNCHIRO_HOME`, else `$HOME/.nunchiro-<identifier>`; a
/// `NUNCHIRO_HOME` in the owner's home is set aside for the latter (the core hands `~/.nunchiro` to every session,
/// and the real-app check overrides HOME, so neither variable can be trusted). Owner's home, after links are
/// resolved: any path with a `.nunchiro` folder in it (in any case), or one inside the passwd home's `.nunchiro` (which may itself
/// be a link elsewhere). An RC home that is still the owner's is refused. WebKit storage follows the bundle id.
fn home_for(
    identifier: &str,
    nunchiro_home: Option<OsString>,
    user_home: Option<OsString>,
    passwd_home: Option<PathBuf>,
) -> Result<(PathBuf, Option<String>), String> {
    let user_home = user_home.map(PathBuf::from);
    if identifier == OWNER_IDENTIFIER {
        let home = nunchiro_home
            .map(PathBuf::from)
            .or_else(|| user_home.map(|h| h.join(".nunchiro")))
            .ok_or("HOME is not set")?;
        return Ok((home, None));
    }
    let owner_real = passwd_home.map(|h| canon(&h.join(".nunchiro")));
    let is_owner = |p: &Path| {
        let p = canon(p);
        // macOS volumes ignore case: `.NUNCHIRO` is the same folder (realpath gives the stored case only once it exists).
        p.components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".nunchiro"))
            || owner_real.as_ref().is_some_and(|o| p.starts_with(o))
    };
    let own = user_home.map(|h| h.join(format!(".nunchiro-{identifier}")));
    let (home, note) = match nunchiro_home.map(PathBuf::from) {
        Some(set) if is_owner(&set) => {
            let note = format!(
                "{identifier} ignores NUNCHIRO_HOME {}: it is the owner app's home; using its own",
                set.display()
            );
            (own, Some(note))
        }
        Some(set) => (Some(set), None),
        None => (own, None),
    };
    let home = home.ok_or("HOME is not set")?;
    if is_owner(&home) {
        return Err(format!(
            "{identifier} refuses core home {}: it is inside the owner app's home",
            home.display()
        ));
    }
    Ok((home, note))
}

/// `p` made absolute, with links resolved as far as it exists; the part that does not exist yet is kept as written.
fn canon(p: &Path) -> PathBuf {
    let p = &std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    p.ancestors()
        .find_map(|a| Some(a.canonicalize().ok()?.join(p.strip_prefix(a).ok()?)))
        .unwrap_or_else(|| p.to_path_buf())
}

/// Ticket 464: `scripts/gate-app-boot.sh` opens an RC build in the background on a temp home with
/// `NUNCHIRO_GATE_RUN=1`. Such a run does not take the front at launch and keeps its pages in a WebKit store of its own
/// (`GATE_STORE`), not the RC's. The owner's build ignores the variable.
fn gate_run() -> bool {
    gate_run_for(
        identifier(),
        std::env::var_os("NUNCHIRO_GATE_RUN").as_deref(),
    )
}

fn gate_run_for(identifier: &str, value: Option<&std::ffi::OsStr>) -> bool {
    identifier != OWNER_IDENTIFIER && value.is_some_and(|v| v == "1")
}

/// Ticket 464 (review r3): a gate run comes with its temp home; without one it would fall back to the RC's own.
fn gate_home_missing(gate: bool, nunchiro_home: Option<&std::ffi::OsStr>) -> Option<&'static str> {
    (gate && nunchiro_home.is_none_or(|h| h.is_empty())).then_some(
        "not started: NUNCHIRO_GATE_RUN is set but NUNCHIRO_HOME is not; a gate run never uses this RC's own home",
    )
}

/// 11-20 incident: an owner-id build that is not inside `<…>.app/Contents/MacOS` (a `target/` build) would default to
/// the owner's `~/.nunchiro`; it starts only with a `NUNCHIRO_HOME` of its own. A `NUNCHIRO_HOME` that is one of
/// `owner_homes` counts as unset: every Nunchiro session hands its processes that value. Same folder: same device and
/// inode when both exist (covers links, case, the `/System/Volumes/Data` firmlink), else the same path ignoring case.
/// A `..` left after a folder that does not exist yet also counts as unset: the CLI creates that folder, and the
/// path may then lead into the owner's home.
/// A bundle where tauri builds it (`<target dir>/<profile>/bundle/macos/*.app`) is a build, not an install, and counts as
/// unbundled. Matched by `bundle/macos`, not by a `target` folder: a folder named `target` may sit above an install.
fn unbundled_owner(
    identifier: &str,
    nunchiro_home: Option<&std::ffi::OsStr>,
    exe: Option<&Path>,
    owner_homes: &[PathBuf],
) -> Option<&'static str> {
    let bundled = exe.and_then(Path::parent).is_some_and(|macos| {
        macos.ends_with("Contents/MacOS")
            && macos.ancestors().nth(2).and_then(Path::extension) == Some("app".as_ref())
            && !macos
                .ancestors()
                .nth(3)
                .is_some_and(|d| d.ends_with("bundle/macos"))
    });
    use std::os::unix::fs::MetadataExt;
    let same = |h: &Path, o: &Path| match (h.metadata(), o.metadata()) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => canon(o).as_os_str().eq_ignore_ascii_case(h.as_os_str()),
    };
    let own_home = nunchiro_home.filter(|h| !h.is_empty()).is_some_and(|h| {
        let h = canon(Path::new(h));
        !h.components().any(|c| c == std::path::Component::ParentDir)
            && !owner_homes.iter().any(|o| same(&h, o))
    });
    (identifier == OWNER_IDENTIFIER && !own_home && !bundled).then_some(
        "not started: this build is not inside an app bundle and NUNCHIRO_HOME is not set (or is the owner's ~/.nunchiro); it never uses the owner's home",
    )
}

/// The checks `main` runs first, in this order, before anything reads `home()` or opens a window or core.
fn start_refusal(
    identifier: &str,
    nunchiro_home: Option<&std::ffi::OsStr>,
    exe: Option<&Path>,
    owner_homes: &[PathBuf],
    gate: bool,
) -> Option<&'static str> {
    unbundled_owner(identifier, nunchiro_home, exe, owner_homes)
        .or_else(|| gate_home_missing(gate, nunchiro_home))
}

/// Gate-app-boot-front: a gate run's activation policy; the owner's build (`gate` false) keeps tauri's default.
#[cfg(target_os = "macos")]
fn gate_activation_policy(gate: bool) -> Option<tauri::ActivationPolicy> {
    gate.then_some(tauri::ActivationPolicy::Prohibited)
}

/// One fixed store for every gate run (macOS 14+), so runs reuse it instead of adding a store each.
#[cfg(target_os = "macos")]
const GATE_STORE: [u8; 16] = *b"nunchiro-gate464";

/// `NUNCHIRO_BIN`, then a `nunchiro` next to this executable, then `PATH`.
fn cli() -> PathBuf {
    if let Some(bin) = std::env::var_os("NUNCHIRO_BIN") {
        return bin.into();
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("nunchiro")));
    sibling
        .filter(|p| p.is_file())
        .unwrap_or_else(|| "nunchiro".into())
}

// v1a-33: an app opened from Finder has no locale, so the core and every agent it starts (they inherit its
// environment) would read and write Korean as bytes. The first non-empty of LC_ALL, LC_CTYPE, LANG decides the
// character type: a UTF-8 one is kept, else LC_CTYPE (and an empty LANG) becomes en_US.UTF-8. A non-UTF-8
// LC_ALL is kept too: only a terminal sets it, on purpose, and it would override whatever is set here anyway.
// V2.5-34: the CLI also gets this build's home, so an RC's CLI never falls back to `~/.nunchiro` on its own.
fn core_command(home: Option<&Path>, env: impl Fn(&str) -> Option<OsString>) -> Command {
    const UTF8: &str = "en_US.UTF-8";
    let get = |key| env(key).filter(|v| !v.is_empty());
    let mut cmd = Command::new(cli());
    if let Some(home) = home {
        cmd.env("NUNCHIRO_HOME", home);
    }
    let utf8 = get("LC_CTYPE").or_else(|| get("LANG")).is_some_and(|v| {
        let v = v.to_string_lossy().to_ascii_lowercase();
        v.contains("utf-8") || v.contains("utf8")
    });
    if get("LC_ALL").is_none() && !utf8 {
        cmd.env("LC_CTYPE", UTF8);
        if get("LANG").is_none() {
            cmd.env("LANG", UTF8);
        }
    }
    #[cfg(all(debug_assertions, dev))]
    if let Some(origins) = dev_load::core_origins(env("NUNCHIRO_WINDOW_ORIGINS").as_deref()) {
        cmd.env("NUNCHIRO_WINDOW_ORIGINS", origins); // ticket 172: the dev server page may open the core socket
    }
    cmd
}

/// F24: one core start or replacement at a time, so recovery never races a swap.
static CORE_START: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// F24: an older core was left running because a live session could not survive the swap.
static CORE_KEPT: AtomicBool = AtomicBool::new(false);
/// Ticket 372: whether a closed window still raises the waiting-count notification (set by `close_window`).
pub(crate) static CLOSED_ALERTS: AtomicBool = AtomicBool::new(true);
/// How often a kept core is tried again; it is replaced as soon as nothing live blocks it.
const CORE_KEPT_RETRY: Duration = Duration::from_secs(30);
const BOOT_TRIES: u32 = 6;

fn core_start_turn() -> std::sync::MutexGuard<'static, ()> {
    CORE_START
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// F24, ticket 379: the one way the app starts or replaces its core. `nunchiro serve update` from this bundle's CLI starts
/// the core when none runs and replaces an older one, whose agents reattach through their holders. It reads none of that
/// core's session data: a build can drop a value an older core still sends, and `session list` then fails before
/// anything could replace that core. A failure is logged (redacted) and leaves the core as it is.
fn ensure_core() -> Result<(), Failed> {
    ensure_core_at(&home(), own_cli().as_deref(), rc_update::log_line)
}

/// `ensure_core` with its inputs named, so a test can give it a home and a CLI of its own. Once refused, the run never
/// starts or updates a core again: a foreign core that goes away is not restarted from this app's CLI on that home.
fn ensure_core_at(
    home: &Result<PathBuf, String>,
    own: Option<&Path>,
    log: impl Fn(&str) -> bool,
) -> Result<(), Failed> {
    if FOREIGN_RUN.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Some(why) = refusal(home, own) {
        if !FOREIGN_RUN.swap(true, Ordering::Relaxed) {
            log(&why);
        }
        return Ok(());
    }
    update_core(home.as_deref().ok())
}

/// Set at the first refusal: this run leaves the core alone from then on (and its one log line is written).
static FOREIGN_RUN: AtomicBool = AtomicBool::new(false);

/// This app's own CLI (`cli`), or `None` when it would be looked up on `PATH`: a CLI found there belongs to no bundle.
fn own_cli() -> Option<PathBuf> {
    Some(cli()).filter(|c| c.components().count() > 1)
}

/// 11-20 incident: a debug build with no `NUNCHIRO_HOME` attached to `~/.nunchiro` and ran `serve update` there with
/// a stale CLI from `PATH`. Why this app runs no CLI on the core's home: the home is unknown, this app has no CLI of
/// its own (one on `PATH` is never run), or a core runs there that `own` did not start (`foreign_core`).
fn refusal(home: &Result<PathBuf, String>, own: Option<&Path>) -> Option<String> {
    let home = match home {
        Ok(home) => home,
        Err(e) => return Some(format!("not starting or updating a core: {e}")),
    };
    let Some(own) = own else {
        return Some(format!(
            "not starting or updating the core in {}: this app has no CLI of its own (none beside it, no NUNCHIRO_BIN), and one on PATH is never run",
            home.display()
        ));
    };
    foreign_core(home, own)
}

/// Why a core that runs in `home` is not this app's: its executable (`core.start.json`, which every core writes before
/// it listens) is not `own`, links resolved. With none running the update starts one from `own`; one that runs from the
/// same bundle path is this app's (the owner's install, then update). An unknown executable is refused.
fn foreign_core(home: &Path, own: &Path) -> Option<String> {
    std::os::unix::net::UnixStream::connect(home.join("core.sock")).ok()?;
    let started: serde_json::Value = std::fs::read(home.join("core.start.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let exe = started["exe"].as_str().map(Path::new);
    let real = |p: &Path| p.canonicalize().ok();
    if let (Some(a), Some(b)) = (real(own), exe.and_then(real))
        && a == b
    {
        return None;
    }
    Some(format!(
        "not updating the core in {}: it runs from {}, not from this app's CLI ({}); attaching only",
        home.display(),
        exe.map_or("an unknown executable".into(), |p| p.display().to_string()),
        own.display()
    ))
}

/// `nunchiro serve update` with this app's CLI on `home`.
fn update_core(home: Option<&Path>) -> Result<(), Failed> {
    let _turn = core_start_turn();
    let output = core_command(home, |key| std::env::var_os(key))
        .args(["serve", "update"])
        .output();
    let failed = match output {
        Ok(out) if out.status.success() => {
            CORE_KEPT.store(out.stdout.trim_ascii() == b"kept", Ordering::Relaxed);
            return Ok(());
        }
        Ok(out) => (
            START,
            format!(
                "nunchiro serve update failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ),
        Err(e) => (CLI, format!("cannot run the nunchiro CLI: {e}")),
    };
    rc_update::log_line(&redact(&failed.1, core_generation().as_deref()));
    Err(failed)
}

/// Ticket 430: a start failure as (kind, raw reason). Only the kind reaches the window, which maps it to a fixed message
/// (`shell.boot.fail.<kind>`); the raw reason goes only to the local log, through `redact`.
type Failed = (&'static str, String);
/// `nunchiro serve update` could not start or replace the core.
const START: &str = "start";
/// This bundle's CLI could not run at all.
const CLI: &str = "cli";
/// The core answered `window_auth` with a refusal.
const REFUSED: &str = "refused";
/// The core did not answer in time.
const TIMEOUT: &str = "timeout";

/// Ticket 430: a raw reason as the local log may keep it: the core token, and any value after `token=` or `token:`
/// (also `"token":"…"`), become `[redacted]`.
fn redact(reason: &str, token: Option<&str>) -> String {
    const GONE: &str = "[redacted]";
    let reason = match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(token) => reason.replace(token, GONE),
        None => reason.to_string(),
    };
    let (mut done, mut rest) = (String::new(), reason.as_str());
    while let Some(at) = rest.to_ascii_lowercase().find("token") {
        let tail = &rest[at + "token".len()..];
        let Some(value) = tail
            .trim_start_matches(['"', '\'', ' '])
            .strip_prefix(['=', ':'])
        else {
            done.push_str(&rest[..at + "token".len()]);
            rest = tail;
            continue;
        };
        let value = value.trim_start_matches(['"', '\'', ' ']);
        let end = value
            .find(|c: char| c.is_whitespace() || "\"'&,;}".contains(c))
            .unwrap_or(value.len());
        done.push_str(&rest[..rest.len() - value.len()]);
        done.push_str(GONE);
        rest = &value[end..];
    }
    done + rest
}

/// The page's boot object: `{port, token, ctrlSpaceTaken}`. Never logged.
// v1a-13: the window token comes from the owner socket (`window_auth`), which refuses an app started
// inside a Nunchiro session; window.json holds only the port.
fn boot() -> Result<String, Failed> {
    ensure_core()?;
    let until = Instant::now() + Duration::from_secs(5);
    let auth = loop {
        match core_reply(serde_json::json!({"op": "window_auth"})) {
            Some(reply) if reply.get("Ok").is_some() => break reply["Ok"].clone(),
            Some(reply) if reply.get("Err").is_some() => {
                return Err((
                    REFUSED,
                    format!(
                        "the core refused the window: {}",
                        reply["Err"].as_str().unwrap_or("refused")
                    ),
                ));
            }
            _ if Instant::now() > until => {
                return Err((TIMEOUT, "core did not answer window_auth".into()));
            }
            _ => thread::sleep(Duration::from_millis(50)),
        }
    };
    if let Some(port) = auth["port"].as_u64().and_then(|p| u16::try_from(p).ok()) {
        browser::note_core_port(port); // v25-19: the browser view never navigates to it
    }
    Ok(serde_json::json!({
        "port": auth["port"],
        "token": auth["token"],
        "ctrlSpaceTaken": ctrl_space_taken(),
        "rcUpdates": rc_update::active(),
        "coreKept": CORE_KEPT.load(Ordering::Relaxed),
        // 11-20 review SHOULD d: set by `ensure_core` above when this run refused to update or stop the core.
        "coreForeign": FOREIGN_RUN.load(Ordering::Relaxed),
    })
    .to_string())
}

/// Gives the page its port and token. Each core start makes new ones, so this also runs when the core is replaced: the
/// page's next reconnect reads them, and its sessions and drafts stay as they are. Off the main thread: a swap waits on
/// the old core's exit. A boot that fails (a core still winding down) is tried again. Ticket 379: the page draws nothing
/// until it hears from here, so it always hears: its boot, or within `BOOT_PATIENCE` that it is still starting or why
/// there is none (ticket 425).
fn hand_boot(webview: tauri::Webview) {
    let (sent, results) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for _ in 0..BOOT_TRIES {
            let result = boot();
            let done = result.is_ok();
            let _ = sent.send(result);
            if done {
                return;
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
    thread::spawn(move || {
        deliver_boot(&results, BOOT_PATIENCE, BOOT_GIVE_UP, |script| {
            if let Err(e) = webview.eval(&script) {
                eprintln!("nunchiro: handing the window its token failed: {e}");
            }
        });
    });
}

/// Ticket 379: the longest a window stays empty before it says something (the limit is 10 s). A swap can take longer than
/// this; ticket 425: with no attempt failed yet, what it says is that the core is still starting.
const BOOT_PATIENCE: Duration = Duration::from_secs(8);
/// Ticket 425: with no answer at all by then, the waiting state becomes "the core did not answer in time".
const BOOT_GIVE_UP: Duration = Duration::from_secs(60);

/// Passes each attempt's outcome to the page: the first boot and done. Ticket 425: after `patience` with no boot, the
/// latest error if an attempt returned one, else a waiting state; the waiting state turns into the failure at the first
/// error, or at `give_up` with no answer. A boot arriving later still replaces either.
fn deliver_boot(
    results: &std::sync::mpsc::Receiver<Result<String, Failed>>,
    patience: Duration,
    give_up: Duration,
    mut page: impl FnMut(String),
) {
    use std::sync::mpsc::RecvTimeoutError;
    let start = Instant::now();
    // Ticket 430: only the latest failure's kind is kept; its raw reason is logged (redacted) and dropped.
    let mut kind: Option<&'static str> = None;
    // What the page shows: nothing yet, the waiting state, or a failure.
    let (mut waiting, mut failed) = (false, false);
    loop {
        let due = if failed {
            None
        } else if waiting {
            Some(start + give_up)
        } else {
            Some(start + patience)
        };
        let next = match due {
            Some(due) => results.recv_timeout(due.saturating_duration_since(Instant::now())),
            None => results.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match next {
            Ok(Ok(boot)) => return page(boot_script(&boot)),
            Ok(Err((what, why))) => {
                eprintln!("nunchiro: {}", redact(&why, core_generation().as_deref()));
                kind = Some(what);
                if waiting || failed {
                    failed = true;
                    page(failed_script(what));
                }
            }
            Err(RecvTimeoutError::Timeout) if waiting => {
                failed = true;
                page(failed_script(TIMEOUT));
            }
            Err(RecvTimeoutError::Timeout) => match kind {
                Some(what) => {
                    failed = true;
                    page(failed_script(what));
                }
                None => {
                    waiting = true;
                    page(waiting_script());
                }
            },
            Err(RecvTimeoutError::Disconnected) => {
                if !failed {
                    page(failed_script(kind.unwrap_or(TIMEOUT)));
                }
                return;
            }
        }
    }
}

/// Ticket 430: every script handed to `webview.eval` goes through here (the stand-ins too), so the JSON is a safe JS
/// literal: JSON leaves U+2028, U+2029 and `<` raw, which can end a line in older engines or close a `<script>`.
fn boot_script(boot: &str) -> String {
    let boot = js_safe(boot);
    format!("window.__NUNCHIRO__ = {boot}; window.dispatchEvent(new Event('nunchiro:boot'));")
}

/// Serialized JSON as a JS-safe literal. These characters occur only inside JSON strings, where the escapes mean the same.
fn js_safe(json: &str) -> String {
    json.replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Never over a good boot: another page load's attempt may have delivered one, and its port and token are in use.
fn failed_script(kind: &str) -> String {
    stand_in_script(&serde_json::json!({"failed": kind, "port": 0, "token": ""}))
}

/// Ticket 425: the core is still starting and no attempt has failed; the page says so, not that it cannot load.
fn waiting_script() -> String {
    stand_in_script(&serde_json::json!({"waiting": true, "port": 0, "token": ""}))
}

/// A boot that stands in for the real one replaces only nothing or another stand-in.
fn stand_in_script(boot: &serde_json::Value) -> String {
    format!(
        "if (!window.__NUNCHIRO__ || window.__NUNCHIRO__.failed || window.__NUNCHIRO__.waiting) {{ {} }}",
        boot_script(&boot.to_string())
    )
}

/// What identifies the running core: `core.token` is rewritten at every core start. Never logged.
fn core_generation() -> Option<String> {
    std::fs::read_to_string(home().ok()?.join("core.token")).ok()
}

/// F24: a full stop leaves this until the next core starts; anything else that ended the core was not asked for.
fn core_was_stopped() -> bool {
    home().is_ok_and(|home| home.join("core.stopped").exists())
}

/// macOS binds Ctrl+Space to "Select the previous input source" (symbolic hotkey 60) unless the user
/// turned it off; an absent entry means the default, which is on.
fn ctrl_space_taken() -> bool {
    let Ok(out) = Command::new("defaults")
        .args(["read", "com.apple.symbolichotkeys", "AppleSymbolicHotKeys"])
        .output()
    else {
        return false;
    };
    hotkey_60_on(&String::from_utf8_lossy(&out.stdout))
}

fn hotkey_60_on(text: &str) -> bool {
    let mut lines = text.lines();
    let Some(head) = lines.by_ref().find(|l| l.trim_start().starts_with("60 =")) else {
        return true;
    };
    let indent = head.len() - head.trim_start().len();
    let entry: Vec<&str> = lines
        .take_while(|l| !(l.trim() == "};" && l.len() - l.trim_start().len() == indent))
        .collect();
    let entry = entry.join("\n");
    entry.contains("enabled = 1") && entry.contains("49,") && entry.contains("262144")
}

/// The bundled UI's own origins. The token goes only to these, and the window never navigates elsewhere;
/// links leave through the opener plugin into the user's browser.
/// `dev` says whether a URL is the dev-load server's (`dev_origin`; a parameter so a test can name one).
fn own_origin(url: &tauri::Url, dev: impl Fn(&tauri::Url) -> bool) -> bool {
    if dev(url) {
        return true;
    }
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        // Tauri serves the bundled UI from `http://tauri.localhost` on Windows only; elsewhere that host is
        // whatever answers loopback :80 (threat model A18).
        #[cfg(windows)]
        "http" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

/// Debug builds with dev web-load: the dev server's origin is the window's own (ticket 172).
#[cfg(all(debug_assertions, dev))]
use dev_load::server_origin as dev_origin;
#[cfg(not(all(debug_assertions, dev)))]
fn dev_origin(_: &tauri::Url) -> bool {
    false
}

/// Whether a loaded page gets the boot script (the window token). Every webview runs the builder's page-load handler,
/// the agent browser's child views included (threat model A18).
fn gets_boot(label: &str, url: &tauri::Url, dev: impl Fn(&tauri::Url) -> bool) -> bool {
    label == "main" && own_origin(url, dev)
}

/// One request to the core over its owner-only socket (the same envelope the CLI sends). Used for the menu
/// bar count and the lifetime setting; page data never goes this way.
fn core_call(request: serde_json::Value) -> Option<serde_json::Value> {
    core_reply(request)?.get("Ok").cloned()
}
// v1a-13: the whole `{"Ok"|"Err": ..}` reply, so `boot` can show why the core refused.
fn core_reply(request: serde_json::Value) -> Option<serde_json::Value> {
    core_reply_at(&home().ok()?, request, None)
}
/// `core_reply` to the core at `home`. With `bound` (until, bytes), the whole reply must be in by `until` and within
/// `bytes`: ticket 1130 A-D3 round 2, a core that drips bytes cannot keep the blocking worker or grow its buffer.
fn core_reply_at(
    home: &std::path::Path,
    request: serde_json::Value,
    bound: Option<(Instant, u64)>,
) -> Option<serde_json::Value> {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        os::unix::net::UnixStream,
    };
    /// Each read waits at most until `until`, so the deadline is the whole reply's, not each read's.
    struct Until(UnixStream, Instant);
    impl Read for Until {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let left = self.1.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            self.0
                .set_read_timeout(Some(left.min(Duration::from_secs(3))))?;
            self.0.read(buf)
        }
    }
    let token = std::fs::read_to_string(home.join("core.token")).ok()?;
    let mut stream = UnixStream::connect(home.join("core.sock")).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok()?;
    let line = serde_json::json!({"token": token.trim(), "request": request}).to_string() + "\n";
    stream.write_all(line.as_bytes()).ok()?;
    let mut reply = String::new();
    match bound {
        None => BufReader::new(stream).read_line(&mut reply),
        Some((until, bytes)) => {
            BufReader::new(Until(stream, until).take(bytes)).read_line(&mut reply)
        }
    }
    .ok()?;
    // Codex round-2 look: a worker that resumes after the deadline with a whole reply must not count it (a late 0).
    if bound.is_some_and(|(until, _)| Instant::now() >= until) {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&reply).ok()
}

/// V2-CF5: the tray state from one snapshot reply: (waiting count, keep-awake hold).
fn tray_state(reply: &serde_json::Value) -> Option<(usize, bool)> {
    Some((count_waiting(reply)?, keep_awake_held(reply)))
}

/// Sessions that wait on the user: a queue item, or the waiting observer (the tree's own rule).
// v1b-29: plus open board decisions; a missing or malformed field counts 0.
fn count_waiting(reply: &serde_json::Value) -> Option<usize> {
    let sessions = reply["sessions"]
        .as_array()?
        .iter()
        .filter(|s| {
            s["pending"].as_array().is_some_and(|p| !p.is_empty())
                || s["attention"]["waiting"].as_bool() == Some(true)
        })
        .count();
    Some(sessions + reply["board_decisions"].as_array().map_or(0, Vec::len))
}

fn end_with_app() -> bool {
    core_call(serde_json::json!({"op": "quit_settings"}))
        .is_some_and(|r| r["settings"]["lifetime"] == "end_with_app")
}

/// Ticket 351 r2 (security, must): the main window (the UI and its artifact frames) never captures. wry 0.57.1 grants
/// media capture when a webview has no permission handler, and the Info.plist usage strings no longer make macOS refuse,
/// so every request here is denied with no prompt. Only the in-app browser's views ask (browser/mod.rs `permit`).
fn main_window_permission(_kind: PermissionKind) -> PermissionResponse {
    PermissionResponse::Deny
}

/// The window: shown again when it exists, built otherwise. `main` is the label the capability names.
fn open_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(shown) = window_chrome::show_main(app) {
        return shown;
    }
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Nunchiro")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 560.0)
        .on_navigation(|url| own_origin(url, dev_origin) || artifacts::is_artifact_url(url))
        .on_permission_request(|_, kind| main_window_permission(kind));
    #[cfg(target_os = "macos")]
    let window = window
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(target_os = "macos")]
    let window = if gate_run() {
        window.focused(false).data_store_identifier(GATE_STORE)
    } else {
        window
    };
    // A rebuilt window starts unhardened: nothing is served until its own switches are off.
    app.state::<artifacts::Engine>().pending();
    let window = window.build()?;
    if gate_run() {
        gate_shot::behind(&window);
    }
    // Review round 2: WebRTC and preconnect are outside CSP, so the engine switches them off.
    let handle = app.clone();
    window.with_webview(move |wv| {
        #[cfg(target_os = "macos")]
        let ptr = wv.inner();
        #[cfg(not(target_os = "macos"))]
        let ptr = {
            let _ = &wv;
            std::ptr::null_mut()
        };
        handle.state::<artifacts::Engine>().harden(ptr);
    })?;
    // Gate-app-boot-ssh: a gate run (never the owner's build, see `gate_run`) writes its page's own picture into its
    // temp home, so the stage sees the paint without a Screen Recording grant. Once per app run.
    static GATE_SHOT: std::sync::Once = std::sync::Once::new();
    if gate_run()
        && let Ok(home) = home()
    {
        GATE_SHOT.call_once(|| gate_shot::start(app, home));
    }
    Ok(())
}

/// A Dock click reopens the window only when none is visible; a visible one already answers the click.
#[cfg(any(target_os = "macos", test))]
fn reopen_needed(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

/// Asks the window to show the one confirmation (it lists the running agents and pending items).
/// The flag covers a window that is still loading; the page also listens for the event.
fn ask_quit(app: &AppHandle) {
    if open_window(app).is_err() {
        return;
    }
    if let Some(page) = app.get_webview("main") {
        let _ = page.eval(
            "window.__NUNCHIRO_QUIT__ = true; window.dispatchEvent(new Event('nunchiro:quit-request'));",
        );
    }
}

/// Cmd+Q: the full quit under "end with the app", otherwise only the window goes.
fn quit_key(app: &AppHandle) {
    if end_with_app() {
        ask_quit(app);
    } else {
        close_main(app);
    }
}

/// Ticket 262: what the menu's "About Nunchiro" evaluates in the page (web/tests/about-page.spec.ts runs this exact
/// text). The flag covers a window that is still loading, as in `ask_quit`.
const ABOUT_SCRIPT: &str =
    "window.__NUNCHIRO_ABOUT__ = true; window.dispatchEvent(new Event('nunchiro:about'));";

/// Ticket 197: the app menu's "Settings…" opens Settings (never closes it: the page's own Cmd+comma toggles, and takes
/// the key first when it has focus). web/tests/system-menu.spec.ts runs this exact text.
const SETTINGS_SCRIPT: &str =
    "window.__NUNCHIRO_SETTINGS__ = true; window.dispatchEvent(new Event('nunchiro:settings'));";

/// Ticket 197 (needs 39): the menu bar's waiting item brings up the next waiting item. The flag carries the time, so a
/// window still loading runs it once its items arrive, and never long after.
const WAITING_SCRIPT: &str = "window.__NUNCHIRO_WAITING__ = Date.now(); window.dispatchEvent(new Event('nunchiro:waiting'));";

/// Shows the window, then hands the page one menu script (About, Settings, the waiting item).
fn show_page(app: &AppHandle, script: &str) {
    if open_window(app).is_err() {
        return;
    }
    if let Some(page) = app.get_webview("main") {
        let _ = page.eval(script);
    }
}

/// Closes the `main` window the way the red button does (the page may ask first).
fn close_main(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.close();
    }
}

/// Close Window lives on Cmd+Shift+W (needs 166): Cmd+W belongs to the page's `tab.close`, and muda's predefined
/// close item held a fixed Cmd+W that raced the page. The menu must never carry `CmdOrCtrl+W` again.
const CLOSE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+W";
const QUIT_ALL_ACCELERATOR: &str = "CmdOrCtrl+Alt+Q";
const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";
const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// Ticket 1071: the View menu's items run the page command of the same id (web/src/chrome/useGlobalKeys.ts listens).
/// Here, not only in the page, so the keys work while the in-app browser view holds the keyboard (as ticket 197's Cmd+comma).
const VIEW_COMMANDS: [(&str, &str, &str); 3] = [
    ("zoom.reset", "Actual Size", "CmdOrCtrl+0"),
    ("zoom.in", "Zoom In", "CmdOrCtrl+="),
    ("zoom.out", "Zoom Out", "CmdOrCtrl+-"),
];
/// Ticket 1099 (feature cohesion): File, View and Help items that run a page command and carry no key of their own. The
/// page's keys are the user's (Settings > Keyboard); a menu accelerator would answer first and ignore a rebind. The ⌘/
/// sheet (Help > Keyboard Shortcuts) lists the live keys.
const FILE_COMMANDS: [(&str, &str); 3] = [
    ("session.new", "New Session…"),
    ("worktree.create", "New Worktree…"),
    ("tab.new.browser", "New Browser Tab"),
];
const VIEW_PAGES: [(&str, &str); 5] = [
    ("palette.open", "Command Palette…"),
    ("files.quickOpen", "Go to File…"),
    ("decisions.open", "Decisions"),
    ("history.open", "History"),
    ("schedules.open", "Schedules"),
];
const HELP_COMMANDS: [(&str, &str); 1] = [("keys.sheet", "Keyboard Shortcuts")]; // the whole sheet, as ⌘/
/// The "Go to Tab" items: session.jump.1..9 on CmdOrCtrl+1..9.
const TAB_JUMPS: [&str; 9] = [
    "session.jump.1",
    "session.jump.2",
    "session.jump.3",
    "session.jump.4",
    "session.jump.5",
    "session.jump.6",
    "session.jump.7",
    "session.jump.8",
    "session.jump.9",
];

/// What a View menu item evaluates in the page; only the fixed ids above get here, so the text needs no escaping.
fn command_script(id: &str) -> String {
    format!("window.dispatchEvent(new CustomEvent('nunchiro:command', {{ detail: '{id}' }}));")
}

/// What a menu item id does; `menus()` builds the items and `on_menu_event` runs these.
#[derive(Debug, PartialEq)]
enum MenuAct {
    Open,
    QuitAll,
    Quit,
    CloseMain,
    About,
    Settings,
    Waiting,
    /// Ticket 1071: a page command from the View menu.
    Page(&'static str),
}

fn menu_act(id: &str) -> Option<MenuAct> {
    match id {
        "about" => Some(MenuAct::About),
        "settings" => Some(MenuAct::Settings),
        "waiting" => Some(MenuAct::Waiting),
        "open" => Some(MenuAct::Open),
        "quit_all" => Some(MenuAct::QuitAll),
        "quit" => Some(MenuAct::Quit),
        "close_window" => Some(MenuAct::CloseMain),
        _ => VIEW_COMMANDS
            .iter()
            .map(|(c, _, _)| *c)
            .chain(TAB_JUMPS)
            .chain(
                FILE_COMMANDS
                    .iter()
                    .chain(&VIEW_PAGES)
                    .chain(&HELP_COMMANDS)
                    .map(|(c, _)| *c),
            )
            .find(|c| *c == id)
            .map(MenuAct::Page),
    }
}

/// Shows one notification; the page decides which items notify (per-session level, ticket 08).
#[tauri::command]
fn notify<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    session: String,
    title: String,
    body: String,
) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    show_notification(&app, session, title, body)
}

fn show_notification<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session: String,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .extra("session", session)
        .show()
        .map_err(|e| e.to_string())
}

/// Ticket 372: the Dock badge for a waiting count (Orca src/main/dock/unread-badge.ts:10-11, MIT; rule only).
fn dock_label(waiting: usize) -> Option<String> {
    match waiting {
        0 => None,
        1..=99 => Some(waiting.to_string()),
        _ => Some("99+".into()),
    }
}

/// Ticket 372: with no window the page cannot alert, so a rise in the count raises one count-only notification (fixed
/// words). A first count is not a rise, and a page closed while every alert was muted turned this off.
fn closed_alert(before: Option<usize>, now: usize, window: bool, on: bool) -> Option<String> {
    (!window && on && before.is_some_and(|b| now > b))
        .then(|| format!("{now} agent{} waiting", if now == 1 { "" } else { "s" }))
}

/// Ticket 372 (T3's clear on focus): the page calls this when the window takes focus. The plugin's `remove_active` does
/// nothing on macOS, and delivery goes through NSUserNotification, so this clears the same center; a dev binary has none.
#[tauri::command]
fn clear_notifications(webview: tauri::Webview) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    #[cfg(target_os = "macos")]
    if in_bundle() {
        #[allow(deprecated)]
        // the plugin delivers through this deprecated center, so only it can clear them
        objc2_foundation::NSUserNotificationCenter::defaultUserNotificationCenter()
            .removeAllDeliveredNotifications();
    }
    Ok(())
}

/// Ticket 305: macOS's answer in the page's words (ticket 316: `default` is the Notification API's word for not asked yet).
#[cfg(target_os = "macos")]
fn permission_word(status: objc2_user_notifications::UNAuthorizationStatus) -> &'static str {
    use objc2_user_notifications::UNAuthorizationStatus as S;
    match status {
        S::Authorized | S::Provisional | S::Ephemeral => "granted",
        S::Denied => "denied",
        S::NotDetermined => "default",
        _ => "unknown",
    }
}

/// Outside an app bundle (a dev binary) currentNotificationCenter throws.
#[cfg(target_os = "macos")]
fn in_bundle() -> bool {
    objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()
        .is_some()
}

/// Ticket 316: Settings > Notifications' Ask now. macOS shows its prompt once; afterwards this just reports the answer.
#[tauri::command(async)]
fn ask_notification_permission<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<&'static str, String> {
    cli_install::main_only(&webview)?;
    #[cfg(target_os = "macos")]
    if in_bundle() {
        use objc2::runtime::Bool;
        use objc2_foundation::NSError;
        use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
        let (tx, rx) = std::sync::mpsc::channel();
        let done = block2::RcBlock::new(move |_: Bool, _: *mut NSError| {
            let _ = tx.send(());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &done,
            );
        // Waits on the person's click; an unanswered prompt reads back as still not asked.
        let _ = rx.recv_timeout(std::time::Duration::from_secs(120));
    }
    Ok(permission())
}

/// Ticket 305: the OS notification permission for Settings > Onboarding. Off the main thread: it waits for macOS's callback.
#[tauri::command(async)]
fn notification_permission<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<&'static str, String> {
    cli_install::main_only(&webview)?;
    Ok(permission())
}

fn permission() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};
        if !in_bundle() {
            return "unknown";
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let done = block2::RcBlock::new(move |s: std::ptr::NonNull<UNNotificationSettings>| {
            let _ = tx.send(unsafe { s.as_ref() }.authorizationStatus());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&done);
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_or("unknown", permission_word)
    }
    #[cfg(not(target_os = "macos"))]
    "unknown"
}

/// v1a-38: the macOS system sounds (/System/Library/Sounds) the page may name; any other name is refused.
const SOUNDS: [&str; 14] = [
    "Basso",
    "Blow",
    "Bottle",
    "Frog",
    "Funk",
    "Glass",
    "Hero",
    "Morse",
    "Ping",
    "Pop",
    "Purr",
    "Sosumi",
    "Submarine",
    "Tink",
];

fn sound_name(name: &str) -> Option<&'static str> {
    SOUNDS.iter().copied().find(|s| *s == name)
}

/// Plays one allowlisted system sound by name (the page decides when); it never shows or focuses the window.
#[tauri::command]
fn play_sound<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    name: String,
    volume: f32,
) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    let name = sound_name(&name).ok_or("unknown sound")?;
    #[cfg(target_os = "macos")]
    {
        let sound = objc2_app_kit::NSSound::soundNamed(&objc2_foundation::NSString::from_str(name))
            .ok_or("sound not found")?;
        sound.setVolume(volume.clamp(0.0, 1.0));
        sound.play();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (name, volume);
    Ok(())
}

/// A click on a notification (`tap`) shows the window and opens that session's tab. The flag covers a
/// window that is still loading, as in `ask_quit`.
fn on_click(app: &AppHandle, session: Option<&str>) {
    if open_window(app).is_err() {
        return;
    }
    if let (Some(page), Some(script)) = (app.get_webview("main"), session.and_then(click_script)) {
        let _ = page.eval(&script);
    }
}

/// The page event for a clicked notification: a plain session id opens that session; a board decision's queue item id
/// (ticket 197: `manual:` or `integration:`, then `@updated_at`) focuses its card. `None` for anything else, or none at
/// all (the test notification, ticket 372's closed-window count: a click only opens the window).
fn click_script(session: &str) -> Option<String> {
    let id = js_safe(&serde_json::to_string(session).ok()?);
    if !session.is_empty()
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Some(format!(
            "window.__NUNCHIRO_OPEN__ = {id}; window.dispatchEvent(new CustomEvent('nunchiro:notify.click', {{ detail: {{ session: {id} }} }}));"
        ));
    }
    // Card ids are free text (a space, any script): JSON quoting keeps any of them one string literal; controls are refused.
    let board = ["manual:", "integration:"]
        .iter()
        .any(|p| session.len() > p.len() && session.starts_with(p));
    (board && session.len() <= 512 && !session.chars().any(char::is_control))
        .then(|| format!("window.__NUNCHIRO_FOCUS__ = {{ id: {id}, at: Date.now() }}; window.dispatchEvent(new CustomEvent('nunchiro:notify.click', {{ detail: {{ item: {id} }} }}));"))
}

/// Ticket 549: the page's first snapshot has drawn. `scripts/measure/startup.py` times launch to this stderr line.
#[tauri::command]
fn startup_drawn<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    use std::io::Write;
    // Not eprintln!: it panics when stderr is a closed pipe (`nunchiro-app 2>&1 | head -1`), and this runs on every launch.
    let _ = writeln!(std::io::stderr(), "nunchiro: startup: first snapshot drawn");
    Ok(())
}

/// The confirmed full quit: `nunchiro serve stop` ends every agent and the core, then this process leaves.
#[tauri::command]
fn quit_all<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    quit_core(&home(), own_cli().as_deref(), rc_update::log_line, || {
        app.exit(0)
    })
}

/// `quit_all` with its inputs named, so a test can give it a home, a CLI and an exit of its own.
fn quit_core(
    home: &Result<PathBuf, String>,
    own: Option<&Path>,
    log: impl Fn(&str) -> bool,
    exit: impl FnOnce(),
) -> Result<(), String> {
    // 11-20 incident: a core this app did not start is never stopped from here; the app still closes (no error, or
    // Cmd+Q would never quit).
    let refused = refusal(home, own);
    if FOREIGN_RUN.load(Ordering::Relaxed) || refused.is_some() {
        let why = refused
            .as_deref()
            .unwrap_or("this run attached to a core it did not start");
        log(&format!("quit without `serve stop`: {why}"));
        exit();
        return Ok(());
    }
    let status = core_command(home.as_deref().ok(), |key| std::env::var_os(key))
        .args(["serve", "stop", "--yes"])
        .stdout(Stdio::null())
        .status()
        .map_err(|e| format!("cannot run the nunchiro CLI: {e}"))?;
    // A core that is already gone is the state the user asked for.
    if !status.success() && core_call(serde_json::json!({"op": "snapshot"})).is_some() {
        return Err(format!("nunchiro serve stop failed ({status})"));
    }
    exit();
    Ok(())
}

/// `dev.nunchiro.app.login` for the owner's build; the RC's own label never replaces the owner's login item (V2.5-34).
fn login_label_for(identifier: &str) -> String {
    format!("{identifier}.login")
}

/// `~/Library/LaunchAgents`, or the folder named by `NUNCHIRO_LAUNCH_AGENTS` (tests point it at .scratch).
fn launch_agents_dir() -> Result<PathBuf, String> {
    std::env::var_os("NUNCHIRO_LAUNCH_AGENTS")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/LaunchAgents")))
        .ok_or_else(|| "HOME is not set".into())
}

fn login_plist(label: &str, exe: &std::path::Path) -> String {
    let exe = exe
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{label}</string>\n  <key>ProgramArguments</key><array><string>{exe}</string><string>--login</string></array>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n"
    )
}

/// Writes or removes only this app's own plist. It never calls `launchctl`: macOS loads the folder at login.
fn write_login_item(
    dir: &std::path::Path,
    label: &str,
    exe: &std::path::Path,
    on: bool,
) -> Result<(), String> {
    let path = dir.join(format!("{label}.plist"));
    if !on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{label}.tmp"));
    std::fs::write(&tmp, login_plist(label, exe)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_start_at_login<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    on: bool,
) -> Result<(), String> {
    cli_install::main_only(&webview)?;
    write_login_item(
        &launch_agents_dir()?,
        &login_label_for(identifier()),
        &std::env::current_exe().map_err(|e| e.to_string())?,
        on,
    )
}

fn menus(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let quit_all = MenuItem::with_id(
        app,
        "quit_all",
        "Quit and stop all agents",
        true,
        Some(QUIT_ALL_ACCELERATOR),
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nunchiro", true, Some(QUIT_ACCELERATOR))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    // Ticket 262: first, as in every Mac app; it opens Settings > About.
    let about = MenuItem::with_id(app, "about", "About Nunchiro", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    // Ticket 197: here, not only in the page, so Cmd+comma works while the page has no focus (an in-app browser view).
    let settings = MenuItem::with_id(
        app,
        "settings",
        "Settings…",
        true,
        Some(SETTINGS_ACCELERATOR),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let nunchiro = Submenu::with_items(
        app,
        "Nunchiro",
        true,
        &[
            &about, &sep0, &settings, &sep1, &hide, &sep, &quit_all, &quit,
        ],
    )?;
    // Without an Edit menu macOS drops Cmd+C/V/X/A/Z in the webview.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?, // muda's macOS item: "Zoom", performZoom:
            &MenuItem::with_id(
                app,
                "close_window",
                "Close Window",
                true,
                Some(CLOSE_WINDOW_ACCELERATOR),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let zoom = VIEW_COMMANDS
        .iter()
        .map(|(id, title, keys)| MenuItem::with_id(app, *id, *title, true, Some(*keys)))
        .collect::<tauri::Result<Vec<_>>>()?;
    let jumps = TAB_JUMPS
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let n = i + 1;
            MenuItem::with_id(
                app,
                *id,
                format!("Tab {n}"),
                true,
                Some(format!("CmdOrCtrl+{n}")),
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let jump_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        jumps.iter().map(|m| m as _).collect();
    let go_to_tab = Submenu::with_items(app, "Go to Tab", true, &jump_refs)?;
    // Ticket 1099: page commands without a menu key (FILE_COMMANDS, VIEW_PAGES, HELP_COMMANDS).
    let page = |list: &[(&str, &str)]| {
        list.iter()
            .map(|(id, title)| MenuItem::with_id(app, *id, *title, true, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()
    };
    let (files, pages, helps) = (
        page(&FILE_COMMANDS)?,
        page(&VIEW_PAGES)?,
        page(&HELP_COMMANDS)?,
    );
    let file = Submenu::with_items(app, "File", true, &[&files[0], &files[1], &files[2]])?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &pages[0],
            &pages[1],
            &PredefinedMenuItem::separator(app)?,
            &pages[2],
            &pages[3],
            &pages[4],
            &PredefinedMenuItem::separator(app)?,
            &zoom[0],
            &zoom[1],
            &zoom[2],
            &PredefinedMenuItem::separator(app)?,
            &go_to_tab,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&helps[0]])?;
    #[cfg(all(debug_assertions, dev))]
    if let Some(develop) = dev_load::menu(app)? {
        return Menu::with_items(
            app,
            &[&nunchiro, &file, &edit, &view, &window, &help, &develop],
        );
    }
    Menu::with_items(app, &[&nunchiro, &file, &edit, &view, &window, &help])
}

// Menu bar glyphs (docs/brand/assets, 16-unit, rendered at 32 px, raw RGBA beside their PNGs: tauri's PNG decoder
// is a Cargo feature that adds packages). The idle one is black + alpha so macOS tints the template; the waiting
// one keeps its orange eye, so it must stay non-template.
const TRAY_SIDE: u32 = 32;
const TRAY_IDLE: &[u8] = include_bytes!("../icons/tray/menubar@2x.rgba");
const TRAY_WAITING: &[u8] = include_bytes!("../icons/tray/menubar-waiting@2x.rgba");

/// The menu bar image for a waiting count, and whether macOS should treat it as a template.
fn tray_image(waiting: usize) -> (&'static [u8], bool) {
    if waiting == 0 {
        (TRAY_IDLE, true)
    } else {
        (TRAY_WAITING, false)
    }
}

/// V2-CF5: the menu bar title. A cup leads while the keep-awake hold is on; the waiting count keeps its place after
/// it, and the cup alone needs no count.
fn tray_title_for(waiting: usize, keep_awake: bool) -> Option<String> {
    let count = (waiting > 0).then(|| waiting.to_string());
    match (keep_awake, count) {
        (true, Some(n)) => Some(format!("☕ {n}")),
        (true, None) => Some("☕".into()),
        (false, n) => n,
    }
}

/// V2-CF5: whether the snapshot says the hold is on; a core without the field reads as off.
fn keep_awake_held(reply: &serde_json::Value) -> bool {
    reply["keep_awake_held"].as_bool() == Some(true)
}

/// Ticket 197 (needs 39): the menu bar menu's first item, (text, enabled), for a waiting count.
fn waiting_item(waiting: usize) -> (String, bool) {
    match waiting {
        0 => ("No waiting items".into(), false),
        1 => ("Show 1 waiting item".into(), true),
        n => (format!("Show {n} waiting items"), true),
    }
}

/// The menu bar menu's waiting item, kept so `watch_core` can rename it.
struct WaitingItem(MenuItem<tauri::Wry>);

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let (text, on) = waiting_item(0);
    let waiting = MenuItem::with_id(app, "waiting", text, on, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Nunchiro", true, None::<&str>)?;
    let quit_all = MenuItem::with_id(
        app,
        "quit_all",
        "Quit and stop all agents",
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&waiting, &sep, &open, &quit_all])?;
    app.manage(WaitingItem(waiting));
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Nunchiro");
    let (bytes, template) = tray_image(0);
    builder = builder
        .icon(tauri::image::Image::new(bytes, TRAY_SIDE, TRAY_SIDE))
        .icon_as_template(template);
    builder.build(app)?;
    Ok(())
}

/// The wait before the next restart of a core that keeps failing: doubles from 500 ms up to 10 s (t3code
/// `DesktopBackendManager`).
fn restart_delay(failures: u32) -> Duration {
    Duration::from_millis(500)
        .saturating_mul(2u32.saturating_pow(failures))
        .min(Duration::from_secs(10))
}

/// How long a core must keep answering before its earlier deaths stop counting.
const CORE_HEALTHY: Duration = Duration::from_secs(30);

/// F24 r2: when the next restart may run. Every attempt backs off, also one whose core came up and then died at once.
struct Restarts {
    failures: u32,
    next: Instant,
    healthy_since: Option<Instant>,
}

impl Restarts {
    fn new(now: Instant) -> Self {
        Self {
            failures: 0,
            next: now,
            healthy_since: None,
        }
    }

    fn due(&self, now: Instant) -> bool {
        now >= self.next
    }

    fn attempted(&mut self, now: Instant) {
        self.next = now + restart_delay(self.failures);
        self.failures = self.failures.saturating_add(1);
    }

    fn answered(&mut self, now: Instant) {
        let since = *self.healthy_since.get_or_insert(now);
        if now.duration_since(since) >= CORE_HEALTHY {
            self.failures = 0;
        }
    }

    fn missed(&mut self) {
        self.healthy_since = None;
    }
}

/// F24 r2: its own thread, because a swap can take 40 s and the tray and the core watch must not wait for it.
fn retry_kept_core() {
    thread::spawn(|| {
        loop {
            thread::sleep(CORE_KEPT_RETRY);
            if CORE_KEPT.load(Ordering::Relaxed) {
                let _ = ensure_core();
            }
        }
    });
}

/// Keeps the menu bar count current while the core runs. F24: once the core was seen and then stays gone, a stop that
/// was asked for (a full stop or a signal, `core.stopped`) ends the app, so no icon is left behind; a crash starts it
/// again, and its agents reattach through their holders. A new core means a new port and token, so the page is handed those.
fn watch_core(app: AppHandle) {
    retry_kept_core();
    thread::spawn(move || {
        let (mut seen, mut missed, mut shown) = (false, 0, None);
        let mut generation = None;
        let mut restarts = Restarts::new(Instant::now());
        loop {
            thread::sleep(Duration::from_millis(1000));
            if let Some(now) = core_generation() {
                if generation.as_ref().is_some_and(|known| *known != now)
                    && let Some(page) = app.get_webview("main")
                {
                    hand_boot(page);
                }
                generation = Some(now);
            }
            match core_call(serde_json::json!({"op": "snapshot"})).and_then(|r| tray_state(&r)) {
                Some((n, cup)) => {
                    (seen, missed) = (true, 0);
                    restarts.answered(Instant::now());
                    if shown != Some((n, cup)) {
                        let window = app.get_webview("main").is_some();
                        let on = CLOSED_ALERTS.load(Ordering::Relaxed);
                        if let Some(title) = closed_alert(shown.map(|(b, _)| b), n, window, on) {
                            // An empty session: a click only opens the window (`on_click`).
                            let _ = show_notification(&app, String::new(), title, String::new());
                        }
                        shown = Some((n, cup));
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            // Ticket 372: the Dock badge outlives the window (Tauri's set_badge_count needs one).
                            #[cfg(target_os = "macos")]
                            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                                let label =
                                    dock_label(n).map(|l| objc2_foundation::NSString::from_str(&l));
                                objc2_app_kit::NSApplication::sharedApplication(mtm)
                                    .dockTile()
                                    .setBadgeLabel(label.as_deref());
                            }
                            if let Some(tray) = handle.tray_by_id("main") {
                                let (bytes, template) = tray_image(n);
                                let icon = tauri::image::Image::new(bytes, TRAY_SIDE, TRAY_SIDE);
                                let _ = tray.set_icon(Some(icon));
                                let _ = tray.set_icon_as_template(template);
                                let _ = tray.set_title(tray_title_for(n, cup));
                            }
                            if let Some(item) = handle.try_state::<WaitingItem>() {
                                let (text, on) = waiting_item(n);
                                let _ = item.0.set_text(text);
                                let _ = item.0.set_enabled(on);
                            }
                        });
                    }
                }
                None if seen => {
                    missed += 1;
                    restarts.missed();
                    if missed < 3 {
                        continue;
                    }
                    if core_was_stopped() {
                        app.exit(0);
                        return;
                    }
                    if restarts.due(Instant::now()) {
                        let _ = ensure_core();
                        restarts.attempted(Instant::now());
                    }
                }
                None => {}
            }
        }
    });
}

fn main() {
    let login = std::env::args().any(|a| a == "--login");
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    // V2.5-34: before anything reads `home()`. An RC whose home would be the owner's stops here, before a window or core.
    let _ = IDENTIFIER.set(context.config().identifier.clone());
    if let Some(e) = start_refusal(
        identifier(),
        std::env::var_os("NUNCHIRO_HOME").as_deref(),
        std::env::current_exe().ok().as_deref(),
        &[
            std::env::var_os("HOME").map(PathBuf::from),
            passwd::passwd_home(),
        ]
        .into_iter()
        .flatten()
        .map(|h| h.join(".nunchiro"))
        .collect::<Vec<_>>(),
        gate_run(),
    ) {
        eprintln!("nunchiro: {e}");
        std::process::exit(2);
    }
    match resolve_home() {
        Ok((_, Some(note))) => eprintln!("nunchiro: {note}"),
        Err(e) if identifier() != OWNER_IDENTIFIER => {
            eprintln!("nunchiro: {e}");
            std::process::exit(2);
        }
        _ => {}
    }
    // Ticket 172: dev web-load exists only in a debug build; a bad value stops before any window or core starts.
    #[cfg(all(debug_assertions, dev))]
    match dev_load::apply(&mut context) {
        Ok(Some(note)) => eprintln!("nunchiro: {note}"),
        Ok(None) => {}
        Err(e) => {
            eprintln!("nunchiro: {e}");
            std::process::exit(2);
        }
    }
    #[cfg(not(all(debug_assertions, dev)))]
    if std::env::var_os("NUNCHIRO_WEB").is_some() {
        eprintln!("nunchiro: NUNCHIRO_WEB is refused: this build serves only its embedded UI");
        std::process::exit(2);
    }
    // Gate-app-boot-front: a gate run records each time it becomes the active app, from before its event loop runs.
    if gate_run()
        && let Ok(home) = home()
    {
        gate_shot::watch_active(&home);
    }
    let builder = tauri::Builder::default();
    // Ticket 464: a gate run does not ask to be activated over another app; gate-app-boot-front below makes it unable
    // to activate at all.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!gate_run());
    let app = builder
        // Ticket 307: its page script runs in every webview and takes `target=_blank` clicks for itself; in the browser view
        // that IPC is refused, so the click did nothing and WebKit never asked `browser::popup`. The window's own links do not use it.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // v1b-09: asynchronous, so a page load waiting on the core's `file_read` never blocks the main thread.
        .register_asynchronous_uri_scheme_protocol(artifacts::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // The blocking pool is bounded; each core call times out after 3 s (`core_call`).
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(
                    match (
                        app.try_state::<Arc<dyn artifacts::Content>>(),
                        app.try_state::<artifacts::Grants>(),
                        app.try_state::<artifacts::Engine>(),
                        app.try_state::<Arc<artifacts::Libs>>(), // v2-10c
                    ) {
                        (Some(content), Some(grants), Some(engine), Some(libs)) => {
                            artifacts::serve_with(
                                &request,
                                &**content,
                                &grants,
                                engine.hardened(),
                                &libs,
                            )
                        }
                        _ => tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new())
                            .unwrap_or_default(),
                    },
                )
            });
        })
        // end v1b-09
        .invoke_handler(tauri::generate_handler![
            window_chrome::close_window,
            quit_all,
            set_start_at_login,
            artifacts::artifact_grant,
            artifacts::core_content::artifact_open, // v1b-09
            artifacts::artifact_lib_cards,          // v2-10c
            artifacts::artifact_open_with,          // v2-10c
            notify,
            notification_permission,     // ticket 305
            ask_notification_permission, // ticket 316
            clear_notifications,         // ticket 372
            play_sound,                  // v1a-38
            fonts::font_families,        // v1a-67
            fonts::font_list,            // v25f: the picker lists every installed family
            fonts::font_faces,           // v1a-67
            save::save_text,             // v1a-68
            browser::browser_show,       // v25-19
            browser::browser_hide,
            browser::browser_go,
            browser::browser_back,
            browser::browser_reload,
            browser::browser_forward,
            browser::browser_stop,
            browser::browser_nav,
            browser::browser_tabs, // ticket 328 part 2
            browser::browser_take, // ticket 997 L7
            browser::browser_popup_clear,
            browser::browser_forget,
            browser::browser_profiles, // ticket 264
            browser::browser_profile_clear,
            browser::browser_profile_remove,
            browser::browser_signed_in,
            browser::browser_annotate,   // V2.5-22
            browser::keys::browser_keys, // ticket 535
            browser::keys::browser_refocus,
            browser::control::browser_control, // V2.5-21
            browser::control::browser_hand_back,
            permissions::permission_status, // ticket 252
            permissions::media_status,      // ticket 351
            cli_install::about_info,        // ticket 262
            cli_install::cli_status,
            cli_install::cli_install,
            rc_update::rc_update_check, // G2: refused unless this build updates itself
            rc_update::rc_update_install,
            rc_update::update_source,      // ticket 1082
            window_chrome::window_buttons, // v25f-title-hidden
            startup_drawn                  // ticket 549
        ])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            browser::selftest(app.handle().clone()); // v25-19
            #[cfg(debug_assertions)]
            browser::annotate_selftest(app.handle().clone()); // V2.5-22
            browser::start_agent(app.handle().clone()); // V2.5-20: `nunchiro browser` jobs from the core
            browser::start_control(app.handle().clone()); // V2.5-21: the owner's input pauses the agent
            #[cfg(debug_assertions)]
            browser::test_hook(app.handle().clone());
            // v1b-09: artifacts resolve through the core's `file_read` (06 registers its own ids the same way).
            let content = Arc::new(artifacts::CoreContent::new(|root, path| {
                artifacts::html_of(&core_call(
                    serde_json::json!({"op": "file_read", "root": root, "path": path}),
                )?)
            }));
            app.manage::<Arc<dyn artifacts::Content>>(content.clone());
            app.manage(content);
            // end v1b-09
            app.manage(artifacts::Grants::open(
                home()?.join("artifact-grants.json"),
            ));
            app.manage(artifacts::Engine::default());
            app.manage(Arc::new(artifacts::Libs::new(core_call))); // v2-10c: resolve and store entries via the core
            let handle = app.handle();
            let clicks = handle.clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() == "tap" {
                    let session = performed
                        .notification()
                        .and_then(|n| n.extra().get("session"))
                        .and_then(|v| v.as_str());
                    on_click(&clicks, session);
                }
            })?;
            handle.set_menu(menus(handle)?)?;
            tray(handle)?;
            handle.on_menu_event(|app, event| match menu_act(event.id().as_ref()) {
                Some(MenuAct::Open) => {
                    let _ = open_window(app);
                }
                Some(MenuAct::QuitAll) => ask_quit(app),
                Some(MenuAct::Quit) => quit_key(app),
                Some(MenuAct::CloseMain) => close_main(app),
                Some(MenuAct::About) => show_page(app, ABOUT_SCRIPT),
                Some(MenuAct::Settings) => show_page(app, SETTINGS_SCRIPT),
                Some(MenuAct::Waiting) => show_page(app, WAITING_SCRIPT),
                Some(MenuAct::Page(id)) => show_page(app, &command_script(id)),
                #[cfg(all(debug_assertions, dev))]
                None if event.id().as_ref() == dev_load::RELOAD => dev_load::reload(app),
                None => {}
            });
            watch_core(handle.clone());
            rc_update::start(handle, identifier())?; // ticket 1082: returns at once outside an installed Nunchiro.app
            if login {
                // Started at login: the core runs, the menu bar icon shows, no window pops up.
                thread::spawn(|| {
                    let _ = ensure_core();
                });
            } else {
                open_window(handle)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A close keeps the agents running; the page shows the one-time notice first. A page that is
            // not ready (still loading, crashed) must not trap the window open.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if !window_chrome::ask_page_to_close(window) {
                    let _ = window.destroy();
                }
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished
                || !gets_boot(webview.label(), payload.url(), dev_origin)
            {
                return;
            }
            hand_boot(webview.clone());
        })
        .build(context)
        .expect("error while building the Nunchiro window");
    // Gate-app-boot-front: a gate run can never be the active app, so it never takes the keyboard or the front from
    // the person at the machine, and its quit never hands the front to another app (Finder). Set on the built app
    // before the event loop runs: tao applies it at launch, before its own `activateIgnoringOtherApps`, which a
    // non-activating policy turns into nothing. The window still draws for the page's picture (gate_shot.rs).
    #[cfg(target_os = "macos")]
    let app = {
        let mut app = app;
        if let Some(policy) = gate_activation_policy(gate_run()) {
            app.set_activation_policy(policy);
        }
        app
    };
    app.run(|app, event| match event {
        // The last window closing is not a quit: the menu bar icon and the agents stay.
        tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        // A Dock click with no visible window: show the hidden window, or build it again (the tray's "Open Nunchiro").
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } if reopen_needed(has_visible_windows) => {
            let _ = open_window(app);
        }
        _ => {
            let _ = app;
        }
    });
}

#[cfg(test)]
mod tests;
