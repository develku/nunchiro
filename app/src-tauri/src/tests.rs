#[test]
fn test_home_does_not_follow_the_old_pid_path_symlink() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let old = std::env::temp_dir().join(format!("nunchiro-app-test-{}", std::process::id()));
    let target = std::env::temp_dir().join(format!(
        "nunchiro-app-test-target-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &old).unwrap();
    let result = super::resolve_home();
    std::fs::remove_file(&old).unwrap();
    assert!(std::fs::read_dir(&target).unwrap().next().is_none());
    std::fs::remove_dir(&target).unwrap();
    let (home, note) = result.unwrap();
    assert_ne!(home, old);
    let metadata = std::fs::symlink_metadata(&home).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    assert_eq!(super::resolve_home().unwrap().0, home);
    assert!(note.is_none());
}
/// Ticket 351 r2 (security, must): the main window denies every permission kind, and `open_window` installs the
/// handler (without one wry grants media capture).
#[test]
fn main_window_denies_every_permission() {
    use super::{PermissionKind, PermissionResponse, main_window_permission};
    for kind in [
        PermissionKind::Camera,
        PermissionKind::Microphone,
        PermissionKind::Geolocation,
        PermissionKind::Notifications,
        PermissionKind::Other,
    ] {
        assert!(matches!(
            main_window_permission(kind),
            PermissionResponse::Deny
        ));
    }
    let src = include_str!("main.rs");
    let open = &src[src.find(concat!("fn open_", "window(")).unwrap()..];
    let build = &open[..open.find(".build()?").unwrap()];
    assert!(build.contains(concat!(
        ".on_permission_request(|_, kind| main_window_",
        "permission(kind))"
    )));
}

use super::{
    CLOSE_WINDOW_ACCELERATOR, MenuAct, QUIT_ACCELERATOR, QUIT_ALL_ACCELERATOR, SOUNDS, TRAY_IDLE,
    TRAY_SIDE, TRAY_WAITING, click_script, core_command, count_waiting, gets_boot, hotkey_60_on,
    keep_awake_held, login_plist, menu_act, own_origin, reopen_needed, sound_name, tray_image,
    tray_state, tray_title_for, write_login_item,
};
use super::{
    CORE_HEALTHY, OWNER_IDENTIFIER, Restarts, gate_home_missing, gate_run_for, home_for,
    login_label_for, restart_delay,
};
use super::{
    CORE_KEPT, FOREIGN_RUN, boot_script, deliver_boot, ensure_core_at, failed_script, quit_core,
    redact, refusal, start_refusal, unbundled_owner, update_core, waiting_script,
};
use super::{SETTINGS_ACCELERATOR, SETTINGS_SCRIPT, WAITING_SCRIPT, waiting_item}; // ticket 197
use super::{closed_alert, dock_label};

/// Ticket 558: a browser view (child webview of `main`) is refused by each runtime-generic command through the real
/// IPC path; the guard runs before any argument is used, so nothing quits, writes or notifies here.
#[test]
fn app_commands_refuse_a_browser_view() {
    use super::{
        ask_notification_permission, notification_permission, notify, play_sound, quit_all,
        set_start_at_login, startup_drawn,
    };
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeResponse};
    use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};
    use tauri::webview::{InvokeRequest, WebviewBuilder};
    use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            notify,
            ask_notification_permission,
            notification_permission,
            play_sound,
            quit_all,
            set_start_at_login,
            startup_drawn,
            crate::cli_install::about_info,
            crate::window_chrome::window_buttons
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let url = "https://example.com/".parse().unwrap();
    let child = app
        .get_window("main")
        .unwrap()
        .add_child(
            WebviewBuilder::new("browser-a", WebviewUrl::External(url)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(10.0, 10.0),
        )
        .unwrap();
    for (cmd, body) in [
        ("notify", json!({"session": "", "title": "t", "body": "b"})),
        ("ask_notification_permission", json!({})),
        ("notification_permission", json!({})),
        ("play_sound", json!({"name": "Glass", "volume": 0.5})),
        ("quit_all", json!({})),
        ("set_start_at_login", json!({"on": true})),
        ("startup_drawn", json!({})),
        ("about_info", json!({})),
        ("window_buttons", json!({"shown": false})),
    ] {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        child.clone().on_message(
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_, _, response, _, _| {
                let _ = tx.send(match response {
                    InvokeResponse::Err(e) => Some(e.0),
                    InvokeResponse::Ok(_) => None,
                });
            }),
        );
        assert_eq!(rx.recv().unwrap(), Some(json!("not allowed")), "{cmd}");
    }
}

/// Ticket 558: every registered command checks the calling webview's label before it acts. The browser commands are
/// bound to the real runtime, so this reads their source; `cli_commands_answer_only_the_main_window` and the test
/// above prove the shared check refuses at run time. A command a non-main window must reach is named here with its
/// label, and nothing is today.
#[test]
fn every_registered_command_checks_the_main_window() {
    let files = [
        ("", include_str!("main.rs")),
        ("window_chrome", include_str!("window_chrome.rs")),
        ("artifacts", include_str!("artifacts/mod.rs")),
        (
            "artifacts::core_content",
            include_str!("artifacts/core_content.rs"),
        ),
        ("fonts", include_str!("fonts.rs")),
        ("save", include_str!("save.rs")),
        ("browser", include_str!("browser/mod.rs")),
        ("browser::keys", include_str!("browser/keys.rs")),
        ("browser::control", include_str!("browser/control.rs")),
        ("permissions", include_str!("permissions.rs")),
        ("cli_install", include_str!("cli_install.rs")),
        ("rc_update", include_str!("rc_update.rs")),
    ];
    // A guard named only in a comment is no guard: block comments and the text after `//` are not scanned (tickets 559, 566).
    // shortcut: not string-aware, so a `//` inside a string hides the rest of its line; that can only fail the test, never pass it.
    let strip_comments = |body: &str| {
        let (mut out, mut block) = (String::new(), 0);
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '/' && chars.peek() == Some(&'*') {
                chars.next();
                block += 1;
            } else if c == '*' && block > 0 && chars.peek() == Some(&'/') {
                chars.next();
                block -= 1;
            } else if c == '/' && block == 0 && chars.peek() == Some(&'/') {
                while chars.next_if(|n| *n != '\n').is_some() {}
            } else if block == 0 {
                out.push(c);
            }
        }
        out
    };
    let is_guarded = |name: &str, body: &str| {
        let code = strip_comments(body);
        [
                "main_only(",
                "main_window_only(",
                "label() != \"main\"",
                "ready_for(",
            ]
            .iter()
            .any(|m| code.contains(m))
                // Libs::page refuses any label but "main" (artifacts/libs.rs).
                || (name.starts_with("artifact_") && code.contains("webview.label().to_string()"))
    };
    assert!(is_guarded(
        "play_sound",
        "fn play_sound() {\n    main_only(&w)?;\n}"
    ));
    for (what, body) in [
        (
            "a line comment",
            "fn play_sound() {\n    // main_only(&w)?;\n    play();\n}",
        ),
        (
            "a block comment",
            "fn play_sound() {\n    /* main_only(&w)?; */\n    play();\n}",
        ),
        (
            "a multi-line block comment",
            "fn play_sound() {\n    /*\n    main_only(&w)?;\n    */\n    play();\n}",
        ),
        (
            "a trailing comment",
            "fn play_sound() {\n    play(); // main_only(&w)?;\n}",
        ),
    ] {
        assert!(
            !is_guarded("play_sound", body),
            "a guard only in {what} must fail"
        );
    }
    assert!(
        is_guarded(
            "play_sound",
            "fn play_sound() {\n    /* check */ main_only(&w)?; // and play\n    play();\n}"
        ),
        "a real guard beside comments must pass"
    );
    let main = files[0].1;
    let start = main.find("generate_handler![").unwrap() + "generate_handler![".len();
    let list = &main[start..start + main[start..].find(']').unwrap()];
    let names: Vec<&str> = list
        .lines()
        .map(|l| l.split("//").next().unwrap().trim().trim_end_matches(','))
        .filter(|l| !l.is_empty())
        .collect();
    assert!(names.len() > 40, "{names:?}");
    for path in names {
        let (module, name) = path.rsplit_once("::").unwrap_or(("", path));
        let src = files.iter().find(|(m, _)| *m == module).expect(path).1;
        let at = [format!("fn {name}<"), format!("fn {name}(")]
            .iter()
            .find_map(|f| src.find(f.as_str()))
            .expect(path);
        let body = &src[at..at + src[at..].find("\n}\n").unwrap()];
        let guarded = is_guarded(name, body);
        assert!(guarded, "{path} has no main-window check");
    }
}

#[test]
fn dock_badge_is_the_waiting_count_capped_at_99_plus() {
    assert_eq!(dock_label(0), None);
    assert_eq!(dock_label(2).as_deref(), Some("2"));
    assert_eq!(dock_label(99).as_deref(), Some("99"));
    assert_eq!(dock_label(100).as_deref(), Some("99+"));
}

#[test]
fn closed_window_alerts_once_per_rise_with_the_count_only() {
    assert_eq!(
        closed_alert(Some(2), 3, false, true).as_deref(),
        Some("3 agents waiting")
    );
    assert_eq!(
        closed_alert(Some(0), 1, false, true).as_deref(),
        Some("1 agent waiting")
    );
    assert_eq!(
        closed_alert(None, 3, false, true),
        None,
        "a first count is not a rise"
    );
    assert_eq!(
        closed_alert(Some(3), 2, false, true),
        None,
        "a fall never alerts"
    );
    assert_eq!(
        closed_alert(Some(2), 3, true, true),
        None,
        "the open page alerts itself"
    );
    assert_eq!(
        closed_alert(Some(2), 3, false, false),
        None,
        "closed while muted"
    );
}
use serde_json::json;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::Duration;

/// Held by a test that reads or writes process-wide state (`NUNCHIRO_BIN`, `CORE_KEPT`).
static PROCESS_STATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Ticket 379, the real RC's bug: after an update the new CLI cannot read the old core's session list (a value it no
// longer knows). Starting the core must not depend on that read, or nothing ever replaces the old core.
#[test]
fn a_core_whose_sessions_this_cli_cannot_read_is_still_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let _state = PROCESS_STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("nunchiro-379-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (cli, asked) = (dir.join("nunchiro"), dir.join("asked"));
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\n[ \"$1\" = serve ] && {{ echo replaced; exit 0; }}\necho 'nunchiro: unknown variant `ask`' >&2\nexit 1\n",
        asked.display()
    );
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();

    // Safety: `PROCESS_STATE` is held, and the variable is read only through std's locked environment calls.
    unsafe { std::env::set_var("NUNCHIRO_BIN", &cli) };
    let result = update_core(Some(&dir)); // its own home, never the test process's `~/.nunchiro`
    unsafe { std::env::remove_var("NUNCHIRO_BIN") };

    result.unwrap();
    assert_eq!(std::fs::read_to_string(&asked).unwrap(), "serve update\n");
    assert!(!CORE_KEPT.load(std::sync::atomic::Ordering::Relaxed));
    std::fs::remove_dir_all(&dir).unwrap();
}

// 11-20 incident: a core started from one CLI is updated only by an app whose own CLI is that same file.
#[test]
fn only_a_core_started_from_this_apps_cli_is_updated() {
    let dir = std::env::temp_dir().join(format!("nunchiro-w33-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let (mine, other) = (dir.join("mine/nunchiro"), dir.join("other/nunchiro"));
    for cli in [&mine, &other] {
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(cli, "").unwrap();
    }
    let linked = dir.join("linked");
    std::os::unix::fs::symlink(mine.parent().unwrap(), &linked).unwrap();
    let started = |exe: &std::path::Path| {
        let start = json!({"exe": exe}).to_string();
        std::fs::write(home.join("core.start.json"), start).unwrap()
    };

    let at = Ok(home.clone());
    // No core runs: the update starts one from this app's CLI.
    started(&other);
    assert_eq!(refusal(&at, Some(&mine)), None);
    // No CLI of its own, or no home: refused before any socket test.
    assert!(refusal(&at, None).is_some());
    assert!(refusal(&Err("HOME is not set".into()), Some(&mine)).is_some());

    let _core = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    started(&mine);
    assert_eq!(refusal(&at, Some(&mine)), None);
    assert_eq!(refusal(&at, Some(&linked.join("nunchiro"))), None);
    // Another CLI's core, a CLI from PATH, and a core whose executable is unknown are refused.
    let refused = refusal(&at, Some(&other)).unwrap();
    assert!(refused.contains("attaching only"), "{refused}");
    assert!(refusal(&at, None).is_some());
    started(&dir.join("gone/nunchiro"));
    assert!(refusal(&at, Some(&mine)).is_some());
    std::fs::remove_file(home.join("core.start.json")).unwrap();
    assert!(refusal(&at, Some(&mine)).is_some());
    std::fs::remove_dir_all(&dir).unwrap();
}

// 11-20 review: `ensure_core` runs the CLI only when nothing refuses, and never again in a run after a refusal.
#[test]
fn a_refused_run_never_runs_the_cli() {
    use std::os::unix::fs::PermissionsExt;
    let _state = PROCESS_STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("nunchiro-w33w-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (home, other) = (dir.join("home"), dir.join("other"));
    std::fs::create_dir_all(&home).unwrap();
    let (cli, asked) = (dir.join("nunchiro"), dir.join("asked"));
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\necho current\n",
        asked.display()
    );
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&other, "").unwrap();
    let start = json!({"exe": other}).to_string();
    std::fs::write(home.join("core.start.json"), start).unwrap();
    let logged = std::sync::Mutex::new(Vec::new());
    let log = |line: &str| {
        logged.lock().unwrap().push(line.to_string());
        true
    };
    let ran = || std::fs::read_to_string(&asked).unwrap_or_default();
    let at = Ok(home.clone());

    // Safety: `PROCESS_STATE` is held, and the variable is read only through std's locked environment calls.
    unsafe { std::env::set_var("NUNCHIRO_BIN", &cli) };
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    // No CLI of its own and no core: nothing runs.
    ensure_core_at(&at, None, log).unwrap();
    assert_eq!(ran(), "");
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    ensure_core_at(&Err("HOME is not set".into()), Some(&cli), log).unwrap();
    assert_eq!(ran(), "");
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    // Another CLI's core listens: attached, not updated, one line logged.
    let core = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    ensure_core_at(&at, Some(&cli), log).unwrap();
    ensure_core_at(&at, Some(&cli), log).unwrap();
    assert_eq!(ran(), "");
    // That core goes away: this run still starts nothing on its home.
    drop(core);
    std::fs::remove_file(home.join("core.sock")).unwrap();
    ensure_core_at(&at, Some(&cli), log).unwrap();
    assert_eq!(ran(), "");
    assert_eq!(
        logged.lock().unwrap().len(),
        3,
        "{:?}",
        logged.lock().unwrap()
    );
    // A run that was never refused starts the core with its own CLI.
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    ensure_core_at(&at, Some(&cli), log).unwrap();
    unsafe { std::env::remove_var("NUNCHIRO_BIN") };
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(ran(), "serve update\n");
    std::fs::remove_dir_all(&dir).unwrap();
}

// 11-20 review SHOULD c: a refused run quits without `serve stop` and still exits; an unrefused one stops the core.
#[test]
fn a_refused_quit_never_stops_the_core() {
    use std::os::unix::fs::PermissionsExt;
    let _state = PROCESS_STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("nunchiro-w35q-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (home, other) = (dir.join("home"), dir.join("other"));
    std::fs::create_dir_all(&home).unwrap();
    let (cli, asked) = (dir.join("nunchiro"), dir.join("asked"));
    let script = format!("#!/bin/sh\necho \"$*\" >> '{}'\n", asked.display());
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&other, "").unwrap();
    let start = json!({"exe": other}).to_string();
    std::fs::write(home.join("core.start.json"), start).unwrap();
    let ran = || std::fs::read_to_string(&asked).unwrap_or_default();
    let at = Ok(home.clone());
    let quit = |own: Option<&std::path::Path>| {
        let (exited, logged) = (std::cell::Cell::new(false), std::cell::Cell::new(0));
        let log = |_: &str| {
            logged.set(logged.get() + 1);
            true
        };
        quit_core(&at, own, log, || exited.set(true)).unwrap();
        (exited.get(), logged.get())
    };

    // Safety: `PROCESS_STATE` is held, and the variable is read only through std's locked environment calls.
    unsafe { std::env::set_var("NUNCHIRO_BIN", &cli) };
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    // No CLI of its own: closes, logs why, stops nothing.
    assert_eq!(quit(None), (true, 1));
    // An earlier refusal in this run, with no core left: still nothing stopped.
    FOREIGN_RUN.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(quit(Some(&cli)), (true, 1));
    FOREIGN_RUN.store(false, std::sync::atomic::Ordering::Relaxed);
    // Another CLI's core listens.
    let core = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    assert_eq!(quit(Some(&cli)), (true, 1));
    assert_eq!(ran(), "");
    drop(core);
    std::fs::remove_file(home.join("core.sock")).unwrap();
    // Not refused: `serve stop` runs on its own CLI, then the app exits.
    assert_eq!(quit(Some(&cli)), (true, 0));
    unsafe { std::env::remove_var("NUNCHIRO_BIN") };
    assert_eq!(ran(), "serve stop --yes\n");
    std::fs::remove_dir_all(&dir).unwrap();
}

// 11-20 review SHOULD c: `main` runs `start_refusal` first; within it the owner check comes before the gate check.
#[test]
fn start_checks_run_in_order() {
    let debug = Some(std::path::Path::new("/w/target/debug/nunchiro-app"));
    let unbundled = unbundled_owner(OWNER_IDENTIFIER, None, debug, &[]);
    assert!(unbundled.is_some());
    assert_eq!(
        start_refusal(OWNER_IDENTIFIER, None, debug, &[], true),
        unbundled
    );
    let gate = gate_home_missing(true, None);
    assert_eq!(
        start_refusal("dev.nunchiro.app.rc", None, debug, &[], true),
        gate
    );
    let home = Some(OsStr::new("/w/.scratch/h"));
    assert_eq!(
        start_refusal("dev.nunchiro.app.rc", home, debug, &[], true),
        None
    );
}

// 11-20 review: an owner-id build outside an app bundle starts only with a home of its own.
#[test]
fn an_unbundled_owner_build_needs_its_own_home() {
    fn exe(p: &str) -> Option<&std::path::Path> {
        Some(std::path::Path::new(p))
    }
    let app = exe("/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app");
    let debug = exe("/w/target/debug/deps/nunchiro_app-0123");
    let home = Some(OsStr::new("/w/.scratch/h"));
    let id = OWNER_IDENTIFIER;
    assert!(unbundled_owner(id, None, debug, &[]).is_some());
    assert!(unbundled_owner(id, Some(OsStr::new("")), debug, &[]).is_some());
    assert!(unbundled_owner(id, None, None, &[]).is_some());
    assert!(unbundled_owner(id, None, exe("/w/Contents/MacOS/x"), &[]).is_some());
    assert!(unbundled_owner(id, home, debug, &[]).is_none());
    assert!(unbundled_owner(id, None, app, &[]).is_none());
    assert!(unbundled_owner("dev.nunchiro.app.rc", None, debug, &[]).is_none());
    // 11-20 review SHOULD b: a bundle still in the build folder is not the installed app.
    for built in [
        "/w/target/release/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro-app",
        "/w/target/debug/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro-app",
        "/w/.scratch/gate-target/debug/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro-app",
    ] {
        assert!(
            unbundled_owner(id, None, exe(built), &[]).is_some(),
            "{built}"
        );
        assert!(
            unbundled_owner(id, home, exe(built), &[]).is_none(),
            "{built}"
        );
    }
    // Review round 2 NOTE a: a folder named `target` above an installed app is not a build folder.
    let installed = exe("/Users/target/Applications/Nunchiro.app/Contents/MacOS/nunchiro-app");
    assert!(unbundled_owner(id, None, installed, &[]).is_none());

    // 11-20 review SHOULD a: naming the owner's home is the same as naming none (a session hands it to every
    // process), also with a trailing slash, another case or through a link.
    let dir = std::env::temp_dir().join(format!("nunchiro-w35-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let owner = dir.join("user/.nunchiro");
    std::fs::create_dir_all(&owner).unwrap();
    std::os::unix::fs::symlink(&owner, dir.join("link")).unwrap();
    let owners = [owner.clone()];
    let named = |h: &std::path::Path| unbundled_owner(id, Some(h.as_os_str()), debug, &owners);
    assert!(named(&owner).is_some());
    assert!(named(&dir.join("user/.nunchiro/")).is_some());
    assert!(named(&dir.join("user/.NUNCHIRO")).is_some());
    assert!(named(&dir.join("link")).is_some());
    // 11-20 review round 2: the firmlink spelling (same device and inode), and a `..` after a missing folder.
    let real = owner.canonicalize().unwrap();
    let firm = std::path::Path::new("/System/Volumes/Data").join(real.strip_prefix("/").unwrap());
    assert!(firm.is_dir(), "{}", firm.display());
    assert!(named(&firm).is_some());
    assert!(named(&dir.join("user/nope/../.nunchiro")).is_some());
    assert!(named(&dir.join("user/.nunchiro/nope/..")).is_some());
    assert!(named(&dir.join("elsewhere/nope/..")).is_some());
    assert!(named(&dir.join("user/.nunchiro/worktrees/w/.scratch/h")).is_none());
    assert!(named(&dir.join("other")).is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Runs `deliver_boot` on its own thread with `patience` and `give_up` in ms. The test sends attempts on the first
/// channel and reads what the page is handed from the second, step by step, so the order never rests on sleeps.
#[allow(clippy::type_complexity)]
fn delivery(
    patience: u64,
    give_up: u64,
) -> (
    std::sync::mpsc::Sender<Result<String, super::Failed>>,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
) {
    let (sent, results) = std::sync::mpsc::channel();
    let (shown, page) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || {
        deliver_boot(
            &results,
            Duration::from_millis(patience),
            Duration::from_millis(give_up),
            |s| shown.send(s).unwrap(),
        );
    });
    (sent, page, waiter)
}

const GOOD: &str = r#"window.__NUNCHIRO__ = {"port":1}"#;
const LONG: u64 = 60_000;

fn next(page: &std::sync::mpsc::Receiver<String>) -> String {
    page.recv_timeout(Duration::from_secs(10)).unwrap()
}

// Ticket 425: a core slow to start but fine shows a waiting state, never the failure; its boot then lands.
#[test]
fn a_slow_but_fine_boot_waits_without_an_error_and_then_lands() {
    let (sent, page, waiter) = delivery(20, LONG);
    let first = next(&page);
    assert!(first.contains(r#""waiting":true"#), "{first}");
    assert!(!first.contains(r#""failed":"#), "{first}");
    sent.send(Ok(r#"{"port":1}"#.into())).unwrap();
    let boot = next(&page);
    assert!(boot.starts_with(GOOD), "{boot}");
    waiter.join().unwrap();
    assert!(page.try_recv().is_err(), "nothing after the boot");
}

// Ticket 425: an attempt that returned an error before the patience ran out shows that error at the patience, not
// the waiting state; a boot that follows still replaces it.
#[test]
fn an_error_before_the_patience_shows_the_failure_and_a_late_boot_still_lands() {
    let (sent, page, waiter) = delivery(20, LONG);
    sent.send(Err(("start", "core stop timed out".into())))
        .unwrap();
    let first = next(&page);
    assert!(first.contains(r#""failed":"start""#), "{first}");
    assert!(!first.contains("core stop timed out"), "{first}");
    sent.send(Ok(r#"{"port":1}"#.into())).unwrap();
    let boot = next(&page);
    assert!(boot.starts_with(GOOD), "{boot}");
    waiter.join().unwrap();
}

// Ticket 425: an error after the waiting state shows turns it into the failure at once.
#[test]
fn an_error_while_waiting_turns_into_the_failure() {
    let (sent, page, waiter) = delivery(20, LONG);
    let first = next(&page);
    assert!(first.contains(r#""waiting":true"#), "{first}");
    sent.send(Err(("start", "core stop timed out".into())))
        .unwrap();
    let failed = next(&page);
    assert!(failed.contains(r#""failed":"start""#), "{failed}");
    assert!(!failed.contains("core stop timed out"), "{failed}");
    drop(sent);
    waiter.join().unwrap();
}

// Ticket 379 kept by 425: a window never stays empty. Nothing at all: the waiting state, then at the outer bound the
// failure saying the core did not answer; the boot that follows still reaches the page.
#[test]
fn nothing_until_the_outer_bound_shows_why_and_a_late_boot_still_lands() {
    let (sent, page, waiter) = delivery(10, 40);
    let first = next(&page);
    assert!(first.contains(r#""waiting":true"#), "{first}");
    let failed = next(&page);
    assert!(failed.contains(r#""failed":"timeout""#), "{failed}");
    sent.send(Ok(r#"{"port":1}"#.into())).unwrap();
    let boot = next(&page);
    assert!(boot.starts_with(GOOD), "{boot}");
    waiter.join().unwrap();
    // A stand-in never replaces a boot already handed over.
    for stand_in in [failed_script("x"), waiting_script()] {
        assert!(
                stand_in.starts_with(
                    "if (!window.__NUNCHIRO__ || window.__NUNCHIRO__.failed || window.__NUNCHIRO__.waiting)"
                ),
                "{stand_in}"
            );
    }
}

// A boot thread that ends with nothing delivered still leaves the page a reason, before or after the waiting state.
#[test]
fn attempts_that_end_without_a_boot_leave_the_failure() {
    let (sent, page, waiter) = delivery(LONG, LONG);
    drop(sent);
    let early = next(&page);
    assert!(early.contains(r#""failed":"timeout""#), "{early}");
    waiter.join().unwrap();
    let (sent, page, waiter) = delivery(10, LONG);
    let first = next(&page);
    assert!(first.contains(r#""waiting":true"#), "{first}");
    drop(sent);
    let late = next(&page);
    assert!(late.contains(r#""failed":"timeout""#), "{late}");
    waiter.join().unwrap();
}

// Ticket 430: what JSON leaves raw (U+2028, U+2029, `<`) is escaped in every script the window evaluates, so a
// `</script>` or a line separator in a value never ends the script; the value it carries stays the same.
#[test]
fn boot_scripts_escape_line_separators_and_angle_brackets() {
    let raw = "\u{2028}\u{2029}</script>";
    let json = serde_json::json!({ "port": 1, "note": raw }).to_string();
    for script in [boot_script(&json), failed_script(raw), waiting_script()] {
        for bad in ['\u{2028}', '\u{2029}', '<'] {
            assert!(!script.contains(bad), "{bad:?} in {script}");
        }
    }
    let script = boot_script(&json);
    assert!(
        script.contains(r#""note":"\u2028\u2029\u003c/script>""#),
        "{script}"
    );
    let literal = script
        .strip_prefix("window.__NUNCHIRO__ = ")
        .and_then(|s| s.split_once("; window.dispatchEvent"))
        .unwrap()
        .0;
    let back: serde_json::Value = serde_json::from_str(literal).unwrap();
    assert_eq!(back["note"], raw);
}

// Ticket 430: a start failure whose reason holds a token reaches the window as its kind alone, and the log line keeps
// neither the core token nor any `token=` / `"token":` value.
#[test]
fn a_reason_holding_a_token_reaches_neither_the_window_nor_the_log() {
    let why = r#"serve update failed: token=s3cr3t-abc, sent {"token":"s3cr3t-def"} with core-tok-42 at core.token"#;
    let (sent, page, waiter) = delivery(LONG, LONG);
    sent.send(Err(("refused", why.into()))).unwrap();
    drop(sent);
    let shown = next(&page);
    waiter.join().unwrap();
    assert!(shown.contains(r#""failed":"refused""#), "{shown}");
    for secret in ["s3cr3t", "core-tok-42", "serve update"] {
        assert!(!shown.contains(secret), "{secret} in {shown}");
    }
    let logged = redact(why, Some("core-tok-42\n"));
    for secret in ["s3cr3t", "core-tok-42"] {
        assert!(!logged.contains(secret), "{secret} in {logged}");
    }
    assert_eq!(
        logged,
        r#"serve update failed: token=[redacted], sent {"token":"[redacted]"} with [redacted] at core.token"#
    );
    assert_eq!(redact("TOKEN: abc def", None), "TOKEN: [redacted] def");
    assert_eq!(redact("no secret here", Some("")), "no secret here");
}

// F24: a core that keeps dying is retried slower and slower, and never gives up.
#[test]
fn restart_delay_doubles_to_a_ceiling() {
    assert_eq!(restart_delay(0), Duration::from_millis(500));
    assert_eq!(restart_delay(1), Duration::from_secs(1));
    assert_eq!(restart_delay(40), Duration::from_secs(10));
}

// F24 r2: a core that starts and dies at once keeps backing off; only a stretch of health clears that.
#[test]
fn restarts_back_off_until_the_core_stays_healthy() {
    let t0 = std::time::Instant::now();
    let at = |secs| t0 + Duration::from_secs(secs);
    let mut r = Restarts::new(t0);
    assert!(r.due(t0));
    r.attempted(t0); // the core came up
    r.answered(at(1)); // and answered once
    r.missed(); // and died
    assert!(!r.due(t0));
    r.attempted(at(1));
    assert!(!r.due(at(1)), "a quick death does not clear the backoff");
    assert!(r.due(at(2)));
    r.answered(at(2));
    r.answered(at(2) + CORE_HEALTHY);
    r.attempted(at(3) + CORE_HEALTHY);
    assert!(
        r.due(at(3) + CORE_HEALTHY + Duration::from_millis(500)),
        "a healthy stretch starts over"
    );
}

// needs 166, threat 2: Cmd+W belongs to the page's `tab.close`. The Window menu's Close Window sits on Cmd+Shift+W,
// no menu item takes Cmd+W (the predefined close item did, and raced the page), and its event closes `main`.
#[test]
fn close_window_menu_item_leaves_cmd_w_to_the_page() {
    assert_eq!(CLOSE_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+W");
    for accelerator in [
        CLOSE_WINDOW_ACCELERATOR,
        QUIT_ACCELERATOR,
        QUIT_ALL_ACCELERATOR,
    ] {
        assert_ne!(accelerator, "CmdOrCtrl+W");
    }
    let source = include_str!("main.rs");
    assert!(!source.contains(concat!("PredefinedMenuItem::", "close_window")));
    assert_eq!(menu_act("close_window"), Some(MenuAct::CloseMain));
    assert_eq!(menu_act("quit"), Some(MenuAct::Quit));
    assert_eq!(menu_act("unknown"), None);
    // Ticket 262: "About Nunchiro" sits first in the Nunchiro menu and has no accelerator.
    assert_eq!(menu_act("about"), Some(MenuAct::About));
    assert!(
        source.contains(r#"MenuItem::with_id(app, "about", "About Nunchiro", true, None::<&str>)"#)
    );
}

// needs 171: a Dock click reopens only a window that is not visible (threat 1: no second `main`, no forced window).
#[test]
fn dock_click_reopens_only_without_a_visible_window() {
    assert!(reopen_needed(false));
    assert!(!reopen_needed(true));
}

// Owner report 2026-11-01: `header.title` is a drag region; Tauri's drag script calls these two window commands,
// so the capability must grant them or a drag and a double-click (zoom) do nothing.
#[test]
fn title_bar_double_click_zooms() {
    let caps: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let granted: Vec<&str> = caps["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert!(granted.contains(&"core:window:allow-internal-toggle-maximize"));
    assert!(granted.contains(&"core:window:allow-start-dragging"));
}

// logo-assets: tray_template
#[test]
fn tray_image_is_template_at_zero_and_orange_non_template_when_waiting() {
    assert_eq!(tray_image(0), (TRAY_IDLE, true));
    assert_eq!(tray_image(1), (TRAY_WAITING, false));
    assert_eq!(tray_image(7), (TRAY_WAITING, false));
    assert_ne!(TRAY_IDLE, TRAY_WAITING);
    assert_eq!(tray_title_for(0, false), None);
    assert_eq!(tray_title_for(3, false).as_deref(), Some("3"));
    let side = (TRAY_SIDE * TRAY_SIDE * 4) as usize;
    assert_eq!((TRAY_IDLE.len(), TRAY_WAITING.len()), (side, side));
    let pixels = |rgba: &'static [u8]| rgba.chunks(4).filter(|p| p[3] > 0).collect::<Vec<_>>();
    // template: black + alpha only
    assert!(!pixels(TRAY_IDLE).is_empty() && pixels(TRAY_IDLE).iter().all(|p| p[..3] == [0, 0, 0]));
    // waiting: the eye is the brand orange #e8590c
    assert!(
        pixels(TRAY_WAITING)
            .iter()
            .any(|p| p[..3] == [0xe8, 0x59, 0x0c])
    );
}

// v1a-33
fn locale(env: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
    let mut set: Vec<_> = core_command(None, |key| {
        env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.into())
    })
    .get_envs()
    .map(|(k, v)| {
        let s = |x: &OsStr| x.to_string_lossy().into_owned();
        (s(k), v.map(s))
    })
    .collect();
    set.sort();
    set
}

// v1a-33
#[test]
fn finder_started_core_gets_a_utf8_locale() {
    let utf8 = Some("en_US.UTF-8".to_string());
    assert_eq!(
        locale(&[]),
        vec![
            ("LANG".into(), utf8.clone()),
            ("LC_CTYPE".into(), utf8.clone())
        ]
    );
    // An empty value counts as unset.
    assert_eq!(
        locale(&[("LANG", "")]),
        vec![
            ("LANG".into(), utf8.clone()),
            ("LC_CTYPE".into(), utf8.clone())
        ]
    );
    // A non-UTF-8 LANG is kept for messages and dates; only the character type turns UTF-8.
    assert_eq!(locale(&[("LANG", "C")]), vec![("LC_CTYPE".into(), utf8)]);
}

// v1a-33
#[test]
fn an_existing_utf8_locale_or_an_explicit_lc_all_is_kept() {
    assert!(locale(&[("LANG", "ko_KR.UTF-8")]).is_empty());
    assert!(locale(&[("LC_CTYPE", "UTF-8")]).is_empty());
    assert!(locale(&[("LANG", "C"), ("LC_CTYPE", "ko_KR.utf8")]).is_empty());
    assert!(locale(&[("LC_ALL", "en_US.UTF-8")]).is_empty());
    assert!(locale(&[("LC_ALL", "C")]).is_empty());
}

// V2-CF5 acceptance: keep_awake_menu_bar_indicator (the title half). The cup leads while held and is the only
// title when nothing waits; a core without the field reads as not held.
#[test]
fn keep_awake_menu_bar_indicator() {
    assert_eq!(tray_title_for(0, false), None);
    assert_eq!(tray_title_for(3, false).as_deref(), Some("3"));
    assert_eq!(tray_title_for(0, true).as_deref(), Some("☕"));
    assert_eq!(tray_title_for(2, true).as_deref(), Some("☕ 2"));
    // The snapshot reply is the source; an older core's reply has no field.
    assert!(keep_awake_held(
        &json!({"sessions": [], "keep_awake_held": true})
    ));
    assert!(!keep_awake_held(
        &json!({"sessions": [], "keep_awake_held": false})
    ));
    assert!(!keep_awake_held(&json!({"sessions": []})));
    assert_eq!(
        tray_state(&json!({"sessions": [], "keep_awake_held": true})),
        Some((0, true))
    );
}

// v1b-29
#[test]
fn menu_bar_counts_board_decisions_with_waiting_sessions() {
    let reply = json!({
        "sessions": [{"pending": [{"id": "q1"}]}, {"pending": []}],
        "board_decisions": [{"card_id": "a"}, {"card_id": "b"}],
    });
    assert_eq!(count_waiting(&reply), Some(3));
}

// v1b-29
#[test]
fn menu_bar_without_board_decisions_counts_as_before() {
    let sessions = json!([
        {"pending": [{"id": "q1"}]},
        {"pending": [], "attention": {"waiting": true}},
        {"pending": [], "attention": {"waiting": false}},
    ]);
    assert_eq!(count_waiting(&json!({"sessions": sessions})), Some(2));
    assert_eq!(
        count_waiting(&json!({"sessions": [], "board_decisions": []})),
        Some(0)
    );
}

// v1b-29
#[test]
fn a_malformed_board_decisions_field_does_not_hide_waiting_sessions() {
    for bad in [
        json!("oops"),
        json!({"card_id": "a"}),
        json!(7),
        json!(null),
    ] {
        let reply = json!({"sessions": [{"pending": [{"id": "q1"}]}], "board_decisions": bad});
        assert_eq!(count_waiting(&reply), Some(1));
    }
}

// v1a-38: the page offers exactly the names this shell plays (web/src/settings.ts SOUNDS).
#[test]
fn the_page_sound_list_matches_the_allowlist() {
    let page = include_str!("../../../web/src/settings.ts");
    let line = page
        .lines()
        .find(|l| l.starts_with("export const SOUNDS = ["))
        .expect("SOUNDS in settings.ts");
    let listed: Vec<&str> = line.split('\'').skip(1).step_by(2).collect();
    assert_eq!(listed, SOUNDS);
}

// v1a-38
#[test]
fn play_sound_takes_only_listed_system_sound_names() {
    assert_eq!(sound_name("Glass"), Some("Glass"));
    assert_eq!(sound_name("Ping"), Some("Ping"));
    for bad in [
        "glass",
        "",
        "../Glass",
        "/System/Library/Sounds/Glass.aiff",
        "Glass.aiff",
        "Glass ",
    ] {
        assert_eq!(sound_name(bad), None, "{bad:?}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn notification_permission_reported_from_shell() {
    use objc2_user_notifications::UNAuthorizationStatus as S;
    for (status, word) in [
        (S::Authorized, "granted"),
        (S::Provisional, "granted"),
        (S::Ephemeral, "granted"),
        (S::Denied, "denied"),
        (S::NotDetermined, "default"),
    ] {
        assert_eq!(crate::permission_word(status), word);
    }
}

#[test]
fn notification_click_names_only_a_plain_session_id() {
    let ok = click_script("3b12ee33-db1e-425d-b460-28edaf5eb2b7").unwrap();
    assert!(ok.contains(r#"{ session: "3b12ee33-db1e-425d-b460-28edaf5eb2b7" }"#));
    assert_eq!(click_script("x'));alert(1);//"), None);
    assert_eq!(click_script(""), None);
}
// Ticket 197: a board decision's notification carries its queue item id (`identity@updated_at`); its click focuses
// that card. Anything else that is not a plain session id still only opens the window.
#[test]
fn notification_click_on_a_board_decision_focuses_its_item() {
    let ok = click_script("integration:roadmap:NUN-42@1700000000").unwrap();
    assert!(
        ok.contains(r#"{ item: "integration:roadmap:NUN-42@1700000000" }"#),
        "{ok}"
    );
    assert!(ok.contains(
            r#"window.__NUNCHIRO_FOCUS__ = { id: "integration:roadmap:NUN-42@1700000000", at: Date.now() };"#
        ));
    assert!(
        click_script("manual:c1@2")
            .unwrap()
            .contains(r#"{ item: "manual:c1@2" }"#)
    );
    // JSON-quoted, so a quote, a space or any script stays inside one string literal; a control is refused.
    let quoted = click_script(r#"manual:a"b@1"#).unwrap();
    assert!(quoted.contains(r#""manual:a\"b@1""#), "{quoted}");
    for free in ["manual:a b@1", "manual:카드 1@1", "manual:é@1"] {
        let s = click_script(free).unwrap();
        assert!(
            s.contains(&format!(
                "{{ item: {} }}",
                serde_json::to_string(free).unwrap()
            )),
            "{s}"
        );
    }
    // Ticket 430's escapes: a line separator or `</script>` in a card id never ends the script.
    let odd = click_script("manual:\u{2028}</script>@1").unwrap();
    assert!(!odd.contains('\u{2028}') && !odd.contains('<'), "{odd}");
    for bad in ["manual:a\nb@1", "manual:a\u{7}@1", "other:a@1", "manual:"] {
        assert_eq!(click_script(bad), None, "{bad}");
    }
    assert_eq!(click_script(&format!("manual:{}", "a".repeat(600))), None);
}

// Ticket 197: the app menu holds Settings... on Cmd+comma (so it works when the page has no focus), and the Window
// menu has Zoom and Bring All to Front.
#[test]
fn app_menu_has_settings_on_cmd_comma_zoom_and_bring_all_to_front() {
    assert_eq!(SETTINGS_ACCELERATOR, "CmdOrCtrl+,");
    assert_eq!(menu_act("settings"), Some(MenuAct::Settings));
    let source = include_str!("main.rs");
    let menus = &source[source.find(concat!("fn men", "us(")).unwrap()..];
    let menus = &menus[..menus.find("\n}\n").unwrap()];
    // Whitespace aside (rustfmt wraps the call).
    let flat: String = menus.split_whitespace().collect();
    assert!(flat.contains(
        r#"MenuItem::with_id(app,"settings","Settings…",true,Some(SETTINGS_ACCELERATOR),)"#
    ));
    assert!(menus.contains("PredefinedMenuItem::maximize(app, None)"));
    assert!(flat.contains("&[&about,&sep0,&settings,&sep1,&hide,&sep,&quit_all,&quit,]"));
    assert!(menus.contains("PredefinedMenuItem::bring_all_to_front(app, None)"));
    assert!(SETTINGS_SCRIPT.contains("'nunchiro:settings'"));
}

// Ticket 1071: View > Actual Size / Zoom In / Zoom Out and Go to Tab 1..9, each on its key, run their page command.
#[test]
fn view_menu_has_zoom_and_the_nine_tab_jumps() {
    use super::{TAB_JUMPS, VIEW_COMMANDS, command_script};
    assert_eq!(
        VIEW_COMMANDS,
        [
            ("zoom.reset", "Actual Size", "CmdOrCtrl+0"),
            ("zoom.in", "Zoom In", "CmdOrCtrl+="),
            ("zoom.out", "Zoom Out", "CmdOrCtrl+-"),
        ]
    );
    for (n, id) in TAB_JUMPS.iter().enumerate() {
        assert_eq!(*id, format!("session.jump.{}", n + 1));
        assert_eq!(menu_act(id), Some(MenuAct::Page(id)));
    }
    for (id, _, _) in VIEW_COMMANDS {
        assert_eq!(menu_act(id), Some(MenuAct::Page(id)));
    }
    assert_eq!(menu_act("session.jump.10"), None);
    assert_eq!(
        command_script("zoom.in"),
        "window.dispatchEvent(new CustomEvent('nunchiro:command', { detail: 'zoom.in' }));"
    );
    let source = include_str!("main.rs");
    let menus = &source[source.find(concat!("fn men", "us(")).unwrap()..];
    let menus = &menus[..menus.find("\n}\n").unwrap()];
    let flat: String = menus.split_whitespace().collect();
    assert!(flat.contains(r#"Some(format!("CmdOrCtrl+{n}"))"#));
    assert!(flat.contains(r#"Submenu::with_items(app,"GotoTab",true,&jump_refs)"#));
    assert!(flat.contains("Menu::with_items(app,&[&nunchiro,&file,&edit,&view,&window,&help])"));
}

// Ticket 1099: File, View and Help items run their page command, with no menu key (the page's keys are the user's).
#[test]
fn page_menu_items_run_their_command_with_no_key() {
    use super::{FILE_COMMANDS, HELP_COMMANDS, VIEW_PAGES};
    for (id, _) in FILE_COMMANDS
        .iter()
        .chain(&VIEW_PAGES)
        .chain(&HELP_COMMANDS)
    {
        assert_eq!(menu_act(id), Some(MenuAct::Page(id)));
    }
    assert_eq!(FILE_COMMANDS[0], ("session.new", "New Session…"));
    assert_eq!(FILE_COMMANDS[1], ("worktree.create", "New Worktree…"));
    assert_eq!(HELP_COMMANDS, [("keys.sheet", "Keyboard Shortcuts")]);
    let source = include_str!("main.rs");
    let menus = &source[source.find(concat!("fn men", "us(")).unwrap()..];
    let menus = &menus[..menus.find("\n}\n").unwrap()];
    let flat: String = menus.split_whitespace().collect();
    assert!(flat.contains("MenuItem::with_id(app,*id,*title,true,None::<&str>)"));
}

// Ticket 197 (needs 39): the menu bar menu names the waiting count, and its item leads to the next waiting item.
#[test]
fn tray_menu_names_the_waiting_count_and_leads_to_it() {
    assert_eq!(waiting_item(0), ("No waiting items".to_string(), false));
    assert_eq!(waiting_item(1), ("Show 1 waiting item".to_string(), true));
    assert_eq!(
        waiting_item(12),
        ("Show 12 waiting items".to_string(), true)
    );
    assert_eq!(menu_act("waiting"), Some(MenuAct::Waiting));
    assert!(WAITING_SCRIPT.contains("'nunchiro:waiting'"));
    let source = include_str!("main.rs");
    assert!(source.contains(concat!("&[&waiting, &sep, &open, ", "&quit_all]")));
    assert!(source.contains(concat!("item.0.set_text(", "text)")));
}

#[test]
fn token_goes_only_to_the_bundled_ui() {
    let ok = |u: &str| own_origin(&u.parse().unwrap(), |_| false);
    assert!(ok("tauri://localhost/index.html"));
    #[cfg(windows)]
    assert!(ok("http://tauri.localhost/"));
    #[cfg(not(windows))]
    assert!(!ok("http://tauri.localhost/"));
    for bad in [
        "https://example.com/",
        "http://localhost:4173/",
        "http://tauri.localhost.evil.example/",
        "http://tauri.localhost:8080/",
        "tauri://evil/",
        "file:///etc/passwd",
        "about:blank",
    ] {
        assert!(!ok(bad), "{bad}");
    }
}
#[test]
fn main_window_still_trusts_tauri_scheme() {
    assert!(own_origin(
        &"tauri://localhost/index.html".parse().unwrap(),
        |_| false
    ));
}
#[test]
#[cfg(not(windows))]
fn own_origin_http_tauri_localhost_false_on_macos() {
    let url: tauri::Url = "http://tauri.localhost/".parse().unwrap();
    assert!(!own_origin(&url, |_| false));
    assert!(!gets_boot("main", &url, |_| false));
}
#[test]
fn boot_only_for_main_label() {
    let dev: tauri::Url = "http://localhost:5173/".parse().unwrap();
    let is_dev = |u: &tauri::Url| u.origin() == dev.origin();
    let urls = ["tauri://localhost/index.html", "http://localhost:5173/"];
    for u in urls {
        let url = u.parse().unwrap();
        assert!(gets_boot("main", &url, is_dev), "main at {u}");
        for other in [
            "browser-0123456789abcdef",
            "browser-A",
            "browser-0123456789abcdef-2",
            "Main",
            "main2",
            "",
        ] {
            assert!(!gets_boot(other, &url, is_dev), "{other:?} at {u}");
        }
    }
    // `http://tauri.localhost` is the bundled UI on Windows only; elsewhere it is a loopback :80 page.
    let tl = "http://tauri.localhost/".parse().unwrap();
    assert_eq!(gets_boot("main", &tl, is_dev), cfg!(windows));
    assert!(!gets_boot("browser-A", &tl, is_dev));
    // Without dev web-load the dev server is just a loopback page, even for the main window.
    assert!(!gets_boot("main", &dev, |_| false));
}
const ON: &str = "{\n        60 =         {\n            enabled = 1;\n            value =             {\n                parameters =                 (\n                    32,\n                    49,\n                    262144\n                );\n                type = standard;\n            };\n        };\n        61 =         {\n            enabled = 1;\n        };\n}";
#[test]
fn reads_the_previous_input_source_hotkey() {
    assert!(hotkey_60_on(ON));
    assert!(!hotkey_60_on(&ON.replacen("enabled = 1", "enabled = 0", 1)));
    // Rebound to another key: Ctrl+Space is free.
    assert!(!hotkey_60_on(&ON.replace("49,", "50,")));
    // Never customised: the macOS default (on) applies.
    assert!(hotkey_60_on("{\n        61 =         {\n        };\n}"));
}
// v1a-09
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
#[test]
fn start_at_login_writes_and_removes_only_its_own_plist() {
    let dir = scratch("login");
    let other = dir.join("com.example.other.plist");
    std::fs::write(&other, "keep").unwrap();
    let exe = std::path::Path::new("/Applications/Nunchiro & Co/Nunchiro");
    let label = login_label_for(OWNER_IDENTIFIER);
    write_login_item(&dir, &label, exe, true).unwrap();
    let ours = dir.join("dev.nunchiro.app.login.plist");
    let text = std::fs::read_to_string(&ours).unwrap();
    assert_eq!(text, login_plist(&label, exe));
    assert!(text.contains(
        "<string>/Applications/Nunchiro &amp; Co/Nunchiro</string><string>--login</string>"
    ));
    assert!(text.contains("<key>RunAtLoad</key><true/>"));
    write_login_item(&dir, &label, exe, false).unwrap();
    write_login_item(&dir, &label, exe, false).unwrap(); // already off is fine
    assert!(!ours.exists());
    assert_eq!(std::fs::read_to_string(&other).unwrap(), "keep");
    std::fs::remove_dir_all(dir).unwrap();
}

// V2.5-34: the home the CLI the app starts is given (None: inherited from the app's environment).
fn cli_home(home: Option<&std::path::Path>) -> Option<String> {
    core_command(home, |_| None)
        .get_envs()
        .find(|(k, _)| *k == "NUNCHIRO_HOME")
        .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
}

const RC: &str = "dev.nunchiro.app.rc";

/// RC home for `HOME`, `NUNCHIRO_HOME` and a fake passwd home; the note says whether NUNCHIRO_HOME was set aside.
fn rc_home(
    user: &std::path::Path,
    nunchiro_home: Option<&std::path::Path>,
    passwd: &std::path::Path,
) -> Result<(PathBuf, bool), String> {
    home_for(
        RC,
        nunchiro_home.map(Into::into),
        Some(user.into()),
        Some(passwd.into()),
    )
    .map(|(h, note)| (h, note.is_some()))
}

/// A fake passwd home with its own `.nunchiro` under .scratch; the real `~/.nunchiro` is never touched.
fn fake_owner(name: &str) -> PathBuf {
    let passwd = scratch(name);
    std::fs::create_dir_all(passwd.join(".nunchiro")).unwrap();
    passwd
}

// V2.5-34 (owner 2026-11-05): an RC build's core home, login item and CLI never reach the owner's.
#[test]
fn rc_home_is_not_owner_home() {
    let passwd = fake_owner("rc-home");
    let user = std::path::Path::new("/u");
    let own = PathBuf::from("/u/.nunchiro-dev.nunchiro.app.rc");
    assert_eq!(rc_home(user, None, &passwd).unwrap(), (own.clone(), false));
    // The core gives every session NUNCHIRO_HOME=~/.nunchiro: set aside however spelled, the RC home instead.
    for owner in ["/u/.nunchiro", "/u/./.nunchiro", "/u/.nunchiro/"] {
        let got = rc_home(user, Some(owner.as_ref()), &passwd).unwrap();
        assert_eq!(got, (own.clone(), true), "{owner}");
    }
    // A temp home (the click harness) is kept.
    let temp = PathBuf::from("/tmp/ns-click-1/home");
    assert_eq!(rc_home(user, Some(&temp), &passwd).unwrap(), (temp, false));
    // The CLI it starts gets that home, so it never finds ~/.nunchiro by itself.
    assert_eq!(cli_home(Some(&own)).as_deref(), own.to_str());
    assert_eq!(login_label_for(RC), "dev.nunchiro.app.rc.login");
    std::fs::remove_dir_all(passwd).unwrap();
}

// V2.5-34 r2 (review MUST): the real-app check overrides HOME, so `$HOME/.nunchiro` is not the owner's home.
#[test]
fn rc_refuses_owner_home_via_nunchiro_home_env() {
    let passwd = fake_owner("rc-env");
    let user = std::path::Path::new("/tmp/x");
    let own = PathBuf::from("/tmp/x/.nunchiro-dev.nunchiro.app.rc");
    let owner = passwd.join(".nunchiro");
    for set in [owner.clone(), owner.join("sessions"), owner.join("new/sub")] {
        let got = rc_home(user, Some(&set), &passwd).unwrap();
        assert_eq!(got, (own.clone(), true), "{}", set.display());
    }
    // Any folder named .nunchiro is an owner home by its name, whoever's it is.
    assert_eq!(
        rc_home(user, Some("/elsewhere/.nunchiro".as_ref()), &passwd).unwrap(),
        (own.clone(), true)
    );
    // An owner home that is itself a link to a data folder: the data folder is the owner's too.
    let moved = fake_owner("rc-env-moved");
    std::fs::remove_dir(moved.join(".nunchiro")).unwrap();
    std::fs::create_dir(moved.join("data")).unwrap();
    std::os::unix::fs::symlink(moved.join("data"), moved.join(".nunchiro")).unwrap();
    assert_eq!(
        rc_home(user, Some(&moved.join("data")), &moved).unwrap(),
        (own.clone(), true)
    );
    // A HOME inside the owner's home leaves no RC home to fall back to: refused, the app exits.
    assert!(rc_home(&owner, None, &passwd).is_err());
    assert!(rc_home(&owner, Some(&owner), &passwd).is_err());
    std::fs::remove_dir_all(passwd).unwrap();
    std::fs::remove_dir_all(moved).unwrap();
}

// V2.5-34 r2: links are resolved before the comparison, also when the path below the link does not exist yet.
#[test]
fn rc_refuses_symlink_to_owner_home() {
    let passwd = fake_owner("rc-link");
    let user = std::path::Path::new("/tmp/x");
    let own = PathBuf::from("/tmp/x/.nunchiro-dev.nunchiro.app.rc");
    let link = passwd.join("innocent");
    std::os::unix::fs::symlink(passwd.join(".nunchiro"), &link).unwrap();
    for set in [link.clone(), link.join("not-yet")] {
        let got = rc_home(user, Some(&set), &passwd).unwrap();
        assert_eq!(got, (own.clone(), true), "{}", set.display());
    }
    std::fs::remove_dir_all(passwd).unwrap();
}

// V2.5-34 r3 (security review): macOS volumes ignore case, so `.NUNCHIRO` or `DATA` names the owner's folder too.
#[test]
fn rc_refuses_owner_home_spelled_in_another_case() {
    let passwd = fake_owner("rc-case");
    let user = std::path::Path::new("/tmp/x");
    let own = PathBuf::from("/tmp/x/.nunchiro-dev.nunchiro.app.rc");
    for name in [".NUNCHIRO", ".Nunchiro/sessions", ".nunchirO/new/sub"] {
        let set = passwd.join(name);
        let got = rc_home(user, Some(&set), &passwd).unwrap();
        assert_eq!(got, (own.clone(), true), "{}", set.display());
    }
    // Not created yet, so no link resolution gives the stored case: the name alone must match, ignoring case.
    let fresh = scratch("rc-case-fresh");
    for set in [fresh.join(".NUNCHIRO"), fresh.join(".Nunchiro/new")] {
        let got = rc_home(user, Some(&set), &fresh).unwrap();
        assert_eq!(got, (own.clone(), true), "{}", set.display());
    }
    assert_eq!(
        rc_home(user, Some("/elsewhere/.NUNCHIRO".as_ref()), &fresh).unwrap(),
        (own.clone(), true)
    );
    std::fs::remove_dir_all(fresh).unwrap();
    // An owner home linked to a data folder, named in another case: caught only where the volume ignores case.
    let moved = fake_owner("rc-case-moved");
    std::fs::remove_dir(moved.join(".nunchiro")).unwrap();
    std::fs::create_dir(moved.join("data")).unwrap();
    std::os::unix::fs::symlink(moved.join("data"), moved.join(".nunchiro")).unwrap();
    if moved.join("DATA").exists() {
        for set in [moved.join("DATA"), moved.join("DATA/sessions")] {
            let got = rc_home(user, Some(&set), &moved).unwrap();
            assert_eq!(got, (own.clone(), true), "{}", set.display());
        }
    }
    std::fs::remove_dir_all(passwd).unwrap();
    std::fs::remove_dir_all(moved).unwrap();
}

// V2.5-34 r3: a relative path that does not exist yet is made absolute against the working directory.
#[test]
fn canon_makes_a_relative_path_absolute() {
    let got = super::canon(std::path::Path::new("rc-not-yet/x"));
    assert!(got.is_absolute(), "{}", got.display());
    assert!(got.ends_with("rc-not-yet/x"));
}

// Ticket 464: only an RC build started by the gate with the exact value runs in the background on its own store.
#[test]
fn gate_run_only_for_rc_with_flag() {
    let one = std::ffi::OsStr::new("1");
    assert!(gate_run_for("dev.nunchiro.app.rc", Some(one)));
    assert!(!gate_run_for(OWNER_IDENTIFIER, Some(one)));
    assert!(!gate_run_for("dev.nunchiro.app.rc", None));
    for other in ["0", "", "yes", "1 "] {
        assert!(!gate_run_for(
            "dev.nunchiro.app.rc",
            Some(std::ffi::OsStr::new(other))
        ));
    }
}

// Gate-app-boot-front: only a gate run is made unable to activate; the owner's build keeps tauri's default policy.
#[cfg(target_os = "macos")]
#[test]
fn only_a_gate_run_cannot_activate() {
    assert!(super::gate_activation_policy(false).is_none());
    assert!(matches!(
        super::gate_activation_policy(true),
        Some(tauri::ActivationPolicy::Prohibited)
    ));
    assert!(!gate_run_for(
        OWNER_IDENTIFIER,
        Some(std::ffi::OsStr::new("1"))
    ));
}

// Ticket 464 (review r3): a gate run without a home of its own stops before a window or core starts.
#[test]
fn gate_run_refuses_without_home() {
    let home = std::ffi::OsStr::new("/w/.scratch/gAbC123");
    assert!(gate_home_missing(true, None).is_some());
    assert!(gate_home_missing(true, Some(std::ffi::OsStr::new(""))).is_some());
    assert!(gate_home_missing(true, Some(home)).is_none());
    assert!(gate_home_missing(false, None).is_none());
}

// V2.5-34: the owner's build keeps `~/.nunchiro`, its NUNCHIRO_HOME override and its login item.
#[test]
fn normal_build_identity_unchanged() {
    let owner = |nh: Option<&str>, user: Option<&str>| {
        home_for(
            OWNER_IDENTIFIER,
            nh.map(Into::into),
            user.map(Into::into),
            Some("/u".into()),
        )
    };
    assert_eq!(OWNER_IDENTIFIER, "dev.nunchiro.app");
    assert_eq!(
        owner(None, Some("/u")).unwrap(),
        (PathBuf::from("/u/.nunchiro"), None)
    );
    for home in ["/u/.nunchiro", "/tmp/ns-t-1"] {
        assert_eq!(
            owner(Some(home), Some("/tmp/x")).unwrap(),
            (PathBuf::from(home), None)
        );
    }
    assert!(owner(None, None).is_err());
    assert_eq!(cli_home(None), None); // no home: inherited, as before
    assert_eq!(login_label_for(OWNER_IDENTIFIER), "dev.nunchiro.app.login");
}
