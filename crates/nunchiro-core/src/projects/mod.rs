//! V2.5-15 (ticket 154, needs 139): the new-project wizard's folder, "Open in editor", and a project's chosen icon.
//! Every path the window names must lie inside a project root the core already knows; an icon is a chosen image only
//! (no favicon fetch, no network) of at most 256 KiB, kept under `<home>/project-icons/`.
pub(crate) mod clone;

use crate::api::{Reply, Response};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub const ICON_MAX: usize = 256 << 10;
const NAME_MAX: usize = 64;
const APP_MAX: usize = 64;
const ICONS: &str = "project-icons";
/// Optional, one line: the application `open -a` uses instead of the default text editor (no UI yet).
const EDITOR_APP: &str = "editor-app";
const LOCATION_BAD: &str = "the location must start with / or ~/ and cannot contain ..";
/// T3's limits: `git init` 10 s, the commit 30 s (a slow hook or signing prompt ends here, not in the window).
const INIT_LIMIT: Duration = Duration::from_secs(10);
const COMMIT_LIMIT: Duration = Duration::from_secs(30);

/// `<parent>/<name>` as a new Git repository; `parent` defaults to `~/Projects`. The name is one plain folder name.
pub fn create(name: &str, parent: Option<&str>) -> Response {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let parent = match parent {
        Some(raw) => clone::parent_dir(raw, home.as_deref()).ok_or(LOCATION_BAD)?,
        None => home.ok_or("no HOME")?.join("Projects"),
    };
    create_in(&parent, name)
}

/// One plain folder name; `create_in` and a clone's name from its URL share this rule.
fn name_ok(name: &str) -> bool {
    !(name.is_empty()
        || name.chars().count() > NAME_MAX
        || name.starts_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\' || crate::board::rights::hidden(c)))
}

fn create_in(parent: &Path, name: &str) -> Response {
    let name = name.trim();
    if !name_ok(name) {
        return Err(
            "project name must be 1-64 characters, no slash, not starting with a dot".into(),
        );
    }
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let path = parent.join(name);
    // `create_dir` (not `_all`) fails when the folder exists, so an existing project is never taken over.
    fs::create_dir(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "a folder with that name already exists".into()
        } else {
            e.to_string()
        }
    })?;
    // The folder is never removed from here on: a Git failure is the reply's warning.
    let (repo, warning) = match init_repo(&path) {
        Ok(()) => (true, first_commit(&path).err()),
        Err(e) => (false, Some(e)),
    };
    Ok(Reply::ProjectCreated {
        path,
        repo,
        warning,
    })
}

/// A core started from a Git hook inherits these, and they would point the steps at that other repository. Ticket 403
/// item 8: nor does config come from the environment (`process::scrub` also drops each `GIT_CONFIG_KEY_n`/`VALUE_n`).
pub(crate) const HOOK_REPOSITORY_ENV: [&str; 11] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_NAMESPACE",
    // Round 2: it overrides every `protocol.<name>.allow`, the `ext::` refusal included.
    "GIT_ALLOW_PROTOCOL",
];

/// `inherited` is the core's variable names: no step gets the session's identity or its messaging channel. Ticket 403
/// item 7: no hook or fsmonitor from config runs (`NO_PROGRAMS`); `git_step` switches off the filters.
fn git_command(dir: &Path, args: &[&str], inherited: impl Iterator<Item = OsString>) -> Command {
    let mut c = crate::process::command("git");
    c.current_dir(dir)
        .args(crate::process::NO_PROGRAMS)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0");
    let inherited: Vec<OsString> = inherited.collect();
    for k in inherited
        .iter()
        .filter(|k| crate::sessions::is_parent_session_env(k))
    {
        c.env_remove(k);
    }
    for k in clone::SESSION_ENV {
        c.env_remove(k);
    }
    crate::process::scrub(&mut c, inherited.into_iter());
    c
}

/// One deadline for the filter listing and the step.
fn git_step(dir: &Path, args: &[&str], limit: Duration) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut c = git_command(dir, args, std::env::vars_os().map(|(k, _)| k));
    crate::process::filters_off(&mut c, dir, limit)?;
    let out = crate::process::output(c, limit.saturating_sub(start.elapsed()))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(stderr.trim().lines().last().unwrap_or("git failed").into())
}

/// Behaviour of T3 Code's `scaffoldRepository` (`ManagedProjectFolders.ts`, MIT): the configured first branch or `main`,
/// then `first_commit`, which New worktree needs (HEAD must exist). The caller tells the two failures apart.
fn init_repo(dir: &Path) -> Result<(), String> {
    let configured =
        crate::process::git_read(dir, &["config", "--get", "init.defaultBranch"], INIT_LIMIT)
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default();
    let branch = if configured.is_empty() {
        "main"
    } else {
        &configured
    };
    git_step(
        dir,
        &["init", "-q", &format!("--initial-branch={branch}")],
        INIT_LIMIT,
    )
}

/// Empty, so Git itself adds nothing beside `.git`. No hook or fsmonitor runs (`git_command`); the process-group stop at
/// `COMMIT_LIMIT` bounds the commit itself.
fn first_commit(dir: &Path) -> Result<(), String> {
    git_step(
        dir,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--no-verify",
            "--allow-empty",
            "-m",
            "Initial commit",
        ],
        COMMIT_LIMIT,
    )
}

/// The canonical `path`, only when it is a known project root or lies inside one.
pub(crate) fn inside(path: &Path, known: &BTreeSet<String>) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|_| "no such path")?;
    // A session started in `/` or the home folder does not make everything under it a project.
    let home = std::env::var_os("HOME").and_then(|h| {
        Path::new(&h)
            .canonicalize()
            .ok()
            .map(PathBuf::into_os_string)
    });
    known
        .iter()
        .filter_map(|root| Path::new(root).canonicalize().ok())
        .filter(|root| root != Path::new("/") && Some(root.as_os_str()) != home.as_deref())
        .any(|root| path.starts_with(root))
        .then_some(path)
        .ok_or_else(|| "path is outside every project".into())
}

/// A fixed argument vector for macOS `open`: the default text editor, or the chosen app. Ticket 375: with a line and an
/// editor that has a URL handler, `open <scheme>://file/<path>:<line>` (a CLI `--goto` would not reach a running app
/// through `open`); the scheme comes from a fixed list and the path is the confined one, percent-encoded.
fn argv(app: Option<&str>, path: &Path, line: Option<u32>) -> Vec<String> {
    let scheme = app.and_then(|a| match a {
        "Visual Studio Code" => Some("vscode"),
        "Cursor" => Some("cursor"),
        "Zed" => Some("zed"),
        _ => None,
    });
    if let (Some(scheme), Some(line)) = (scheme, line) {
        let enc: String = path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .map(|&b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        return vec![format!("{scheme}://file{enc}:{}", line.max(1))];
    }
    let path = path.to_string_lossy().into_owned();
    match app {
        Some(app) => vec!["-a".into(), app.into(), path],
        None => vec!["-t".into(), path],
    }
}

/// An app name `open -a` may take: one plain line, never an option.
fn app_ok(line: &str) -> bool {
    !line.is_empty()
        && line.len() <= APP_MAX
        && !line.starts_with('-')
        && !line.chars().any(char::is_control)
}

fn app(home: &Path) -> Option<String> {
    // Q9 psn-J14-1: never a FIFO or a huge file (the caller holds the registry lock); a link is followed.
    let path = home.join(EDITOR_APP);
    let read = crate::store::open_regular_following(&path)
        .and_then(|f| crate::store::read_capped(f, crate::store::READ_MAX));
    let line = match read {
        Ok(bytes) => String::from_utf8(bytes).ok()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("{}: {e}; the default editor is used", path.display());
            return None;
        }
    };
    let line = line.trim();
    app_ok(line).then(|| line.to_string())
}

/// Ticket 375: the editors Settings offers, as `open -a` names them.
const EDITORS: [&str; 10] = [
    "Visual Studio Code",
    "Cursor",
    "Windsurf",
    "Zed",
    "Sublime Text",
    "Nova",
    "BBEdit",
    "TextMate",
    "Xcode",
    "TextEdit",
];

/// Ticket 375: the known editors installed in /Applications (or /System/Applications) or ~/Applications.
pub fn editor_apps() -> Response {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs: Vec<PathBuf> = ["/Applications", "/System/Applications"]
        .into_iter()
        .map(PathBuf::from)
        .chain(home.map(|h| h.join("Applications")))
        .collect();
    let apps = EDITORS
        .iter()
        .filter(|a| dirs.iter().any(|d| d.join(format!("{a}.app")).is_dir()))
        .map(|a| a.to_string())
        .collect();
    Ok(Reply::EditorApps { apps })
}

/// `chosen` is Settings' `editor.app` (checked as the file is); else the `editor-app` file, else the default editor.
pub fn open_in_editor(
    home: &Path,
    path: &Path,
    line: Option<u32>,
    known: &BTreeSet<String>,
    chosen: Option<String>,
) -> Response {
    let path = inside(path, known)?;
    let app = chosen.filter(|a| app_ok(a)).or_else(|| app(home));
    let args = argv(app.as_deref(), &path, line);
    if let Some(recorded) = crate::opener::recorded(&args) {
        return recorded.map(|()| Reply::Ack);
    }
    let mut child = crate::process::command("open")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // `open` returns at once: a failure inside a second is the answer, a slower one is reaped in the background.
    for _ in 0..10 {
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(format!("the editor did not open ({status})"));
            }
            Ok(Some(_)) => return Ok(Reply::Ack),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    std::thread::spawn(move || child.wait());
    Ok(Reply::Ack)
}

fn icon_stem(home: &Path, project: &Path) -> PathBuf {
    let hex: String = Sha256::digest(project.as_os_str().as_encoded_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    home.join(ICONS).join(hex)
}

/// Ticket 1040 (Locate): every file `project`'s icon can be, one per kind.
pub(crate) fn icon_files(home: &Path, project: &Path) -> Vec<PathBuf> {
    let stem = icon_stem(home, project);
    KINDS.map(|(ext, _)| stem.with_extension(ext)).into()
}

const KINDS: [(&str, &str); 3] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("svg", "image/svg+xml"),
];

/// PNG, JPEG or SVG (shown only as an `<img>`, which runs no script); anything else, GIF and WebP included, is refused.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
        let head = head.trim_start_matches('\u{feff}').trim_start();
        ((head.starts_with("<svg") || head.starts_with("<?xml")) && head.contains("<svg"))
            .then_some("svg")
    }
}

pub fn icon_set(home: &Path, project: &Path, data_b64: &str, known: &BTreeSet<String>) -> Response {
    let project = project
        .to_str()
        .filter(|p| known.contains(*p))
        .ok_or("unknown project")?;
    if data_b64.len() > ICON_MAX / 3 * 4 + 4 {
        return Err("icon is over 256 KiB".into());
    }
    let bytes = crate::images::decode(data_b64)?;
    if bytes.len() > ICON_MAX {
        return Err("icon is over 256 KiB".into());
    }
    let ext = sniff(&bytes).ok_or("icon must be a PNG, JPEG or SVG image")?;
    let stem = icon_stem(home, Path::new(project));
    crate::store::private_dir(&home.join(ICONS))?;
    // The old kinds go first, so a removal that fails leaves the old icon and an error, never a stale one beside the new.
    for (other, _) in KINDS.iter().filter(|(e, _)| *e != ext) {
        match fs::remove_file(stem.with_extension(other)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    crate::store::atomic_write(&stem.with_extension(ext), &bytes)?;
    Ok(Reply::Ack)
}

pub fn icon_get(home: &Path, project: &Path) -> Response {
    let stem = icon_stem(home, project);
    for (ext, mime) in KINDS {
        if let Ok(bytes) = crate::store::read_regular(&stem.with_extension(ext)) {
            return Ok(Reply::ProjectIcon {
                mime: Some(mime.into()),
                data_b64: Some(encode(&bytes)),
            });
        }
    }
    Ok(Reply::ProjectIcon {
        mime: None,
        data_b64: None,
    })
}

fn encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() {
                T[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ns-proj-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn known(p: &Path) -> BTreeSet<String> {
        BTreeSet::from([p.to_str().unwrap().to_string()])
    }
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000";

    #[test]
    fn create_makes_a_plain_new_folder_only() {
        let d = scratch("create");
        assert!(
            matches!(create_in(&d, " alpha "), Ok(Reply::ProjectCreated { path, .. }) if path == d.join("alpha"))
        );
        assert!(create_in(&d, "alpha").is_err(), "existing folder");
        for bad in ["", "..", ".hid", "a/b", "a\\b", "a\nb", &"x".repeat(65)] {
            assert!(create_in(&d, bad).is_err(), "{bad:?}");
        }
        fs::remove_dir_all(d).unwrap();
    }

    // V2.5-49: a project name refuses the one shared hidden set (`board::rights::hidden`), not a narrower copy.
    #[test]
    fn projects_name_refuses_shared_hidden_set() {
        let d = scratch("hidden");
        for c in [
            '\u{061C}',
            '\u{E0041}',
            '\u{2028}',
            '\u{2066}',
            '\u{206F}',
            '\u{200B}',
            '\u{202E}',
            '\u{FEFF}',
        ] {
            let name = format!("a{c}b");
            assert!(
                matches!(create_in(&d, &name), Err(e) if e.starts_with("project name must be")),
                "{c:?}"
            );
            assert!(!d.join(&name).exists(), "{c:?} created");
        }
        for good in ["프로젝트", "café-naïve", "\u{1F680}"] {
            assert!(create_in(&d, good).is_ok(), "{good:?}");
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn open_in_editor_rejects_outside_root() {
        let d = scratch("open");
        let (root, other) = (d.join("root"), d.join("other"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&other, root.join("link")).unwrap();
        let k = known(&root);
        for out in [
            other.clone(),
            root.join("src/../../other"),
            root.join("link"),
            root.join("missing"),
            d.clone(),
        ] {
            assert!(open_in_editor(&d, &out, None, &k, None).is_err(), "{out:?}");
        }
        assert!(inside(&root.join("src"), &k).is_ok());
        assert!(inside(&root, &k).is_ok());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn editor_argv_is_fixed() {
        let p = Path::new("/a/b");
        assert_eq!(argv(None, p, None), ["-t", "/a/b"]);
        assert_eq!(argv(Some("Zed"), p, None), ["-a", "Zed", "/a/b"]);
        // Ticket 375: a line jump is the editor's own URL with the path encoded; without a handler the file opens.
        let odd = Path::new("/a b/c?#%.rs");
        assert_eq!(
            argv(Some("Cursor"), odd, Some(12)),
            ["cursor://file/a%20b/c%3F%23%25.rs:12"]
        );
        assert_eq!(
            argv(Some("Visual Studio Code"), p, Some(0)),
            ["vscode://file/a/b:1"]
        );
        assert_eq!(
            argv(Some("TextEdit"), p, Some(3)),
            ["-a", "TextEdit", "/a/b"]
        );
        assert_eq!(argv(None, p, Some(3)), ["-t", "/a/b"]);
        let d = scratch("app");
        fs::write(d.join(EDITOR_APP), "-evil\n").unwrap();
        assert_eq!(app(&d), None);
        fs::write(d.join(EDITOR_APP), "Visual Studio Code\n").unwrap();
        assert_eq!(app(&d).as_deref(), Some("Visual Studio Code"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_icon_rejects_bad_type() {
        let d = scratch("icon");
        let k = known(Path::new("/p"));
        let set = |b: &[u8]| icon_set(&d, Path::new("/p"), &encode(b), &k);
        for bad in [
            &b"GIF89a.."[..],
            b"RIFFxxxxWEBP",
            b"<html><script>",
            b"plain",
            b"",
        ] {
            assert!(set(bad).is_err(), "{bad:?}");
        }
        assert!(
            icon_set(&d, Path::new("/other"), &encode(PNG), &k).is_err(),
            "unknown project"
        );
        assert!(
            set(&[PNG, &vec![0; ICON_MAX]].concat()).is_err(),
            "over 256 KiB"
        );
        assert!(
            set(&[PNG, &vec![0; ICON_MAX - PNG.len()]].concat()).is_ok(),
            "exactly 256 KiB"
        );
        assert!(
            set(b"<?xml version='1.0'?><svg/>").is_ok(),
            "svg replaces png"
        );
        let Ok(Reply::ProjectIcon { mime, data_b64 }) = icon_get(&d, Path::new("/p")) else {
            panic!()
        };
        assert_eq!(mime.as_deref(), Some("image/svg+xml"));
        assert_eq!(
            crate::images::decode(&data_b64.unwrap()).unwrap(),
            b"<?xml version='1.0'?><svg/>"
        );
        assert!(matches!(
            icon_get(&d, Path::new("/none")),
            Ok(Reply::ProjectIcon { mime: None, .. })
        ));
        fs::remove_dir_all(d).unwrap();
    }

    // Q9 psn-J14-1: a FIFO at the editor-app file or an icon path is refused at once, not waited on under the lock.
    #[test]
    fn a_fifo_editor_app_or_icon_is_refused_at_once() {
        let d = scratch("fifo");
        let icon = icon_stem(&d, Path::new("/p")).with_extension("png");
        fs::create_dir_all(icon.parent().unwrap()).unwrap();
        for path in [d.join(EDITOR_APP), icon] {
            let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let home = d.clone();
        std::thread::spawn(move || {
            let _ = tx.send((app(&home), icon_get(&home, Path::new("/p"))));
        });
        let (app, icon) = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a FIFO read blocked");
        assert_eq!(app, None);
        assert!(matches!(icon, Ok(Reply::ProjectIcon { mime: None, .. })));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_ops_refuse_the_browser_role() {
        for op in [
            r#"{"op":"project_create","name":"x"}"#,
            r#"{"op":"project_create","name":"x","parent":"/p"}"#,
            r#"{"op":"open_in_editor","path":"/p"}"#,
            r#"{"op":"project_icon_set","project":"/p","data_b64":""}"#,
            r#"{"op":"project_icon_get","project":"/p"}"#,
            r#"{"op":"project_clone","url":"https://h/a","parent":"/p"}"#,
            r#"{"op":"project_clone_state","job":"j"}"#,
            r#"{"op":"project_clone_cancel","job":"j"}"#,
        ] {
            let request = serde_json::from_str(op).unwrap();
            assert!(!crate::http::browser::request_allowed(&request), "{op}");
        }
    }

    // Ticket 370 item 8, threats "bad location" and "existing folder".
    #[test]
    fn project_create_refuses_bad_locations_and_leaves_an_existing_folder_alone() {
        let d = scratch("location");
        let up = format!("{}/x/../y", d.display());
        for bad in ["relative/place", up.as_str(), "", "~other/p"] {
            assert!(
                matches!(create("fresh", Some(bad)), Err(e) if e == LOCATION_BAD),
                "{bad:?}"
            );
        }
        assert!(!d.join("x").exists() && !d.join("y").exists());
        assert!(!Path::new("relative").exists());

        fs::create_dir(d.join("taken")).unwrap();
        fs::write(d.join("taken/keep"), "mine").unwrap();
        assert!(create(" taken ", d.to_str()).is_err());
        assert_eq!(fs::read_to_string(d.join("taken/keep")).unwrap(), "mine");
        assert!(
            !d.join("taken/.git").exists(),
            "no git init on an existing folder"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn git_steps_do_not_inherit_the_session_or_a_hooks_repository() {
        let inherited = ["CLAUDE_CODE_MESSAGING_X", "PATH"].map(OsString::from);
        let c = git_command(Path::new("/"), &[], inherited.into_iter());
        let removed: Vec<_> = c
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k)
            .collect();
        for k in clone::SESSION_ENV
            .iter()
            .chain(&HOOK_REPOSITORY_ENV)
            .chain(&["CLAUDE_CODE_MESSAGING_X"])
        {
            assert!(removed.contains(&std::ffi::OsStr::new(k)), "{k}");
        }
        assert!(!removed.contains(&std::ffi::OsStr::new("PATH")));
    }

    /// Ticket 403 item 7: the first commit runs no hook or fsmonitor that config names (here the folder's own, which
    /// stands in for the user's: the command-line switch-offs win over both).
    #[test]
    fn first_commit_runs_no_configured_hook_or_fsmonitor() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("no-programs");
        fs::create_dir_all(&d).unwrap();
        init_repo(&d).unwrap();
        let marker = d.with_extension("ran");
        let hooks = d.with_extension("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let script = format!("#!/bin/sh\necho ran >> '{}'\n", marker.display());
        for name in ["post-commit", "pre-commit", "fsmonitor"] {
            fs::write(hooks.join(name), &script).unwrap();
            fs::set_permissions(hooks.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut config = fs::read_to_string(d.join(".git/config")).unwrap();
        config.push_str(&format!(
            "[core]\n\thooksPath = {}\n\tfsmonitor = {}\n[user]\n\tname = t\n\temail = t@example.com\n",
            hooks.display(),
            hooks.join("fsmonitor").display()
        ));
        fs::write(d.join(".git/config"), config).unwrap();
        let commit = first_commit(&d);
        let ran = marker.exists();
        let _ = fs::remove_file(&marker);
        fs::remove_dir_all(&hooks).unwrap();
        fs::remove_dir_all(&d).unwrap();
        assert!(commit.is_ok(), "{commit:?}");
        assert!(!ran, "a configured hook or fsmonitor ran");
    }

    /// Round 2 (review R3): a step switches off every filter config names (`filters_off`): an add of a file the
    /// folder's `.gitattributes` gives a configured clean filter never runs it.
    #[test]
    fn git_step_runs_no_configured_filter() {
        let d = scratch("step-filter");
        init_repo(&d).unwrap();
        let marker = d.with_extension("ran");
        let mut config = fs::read_to_string(d.join(".git/config")).unwrap();
        config.push_str(&format!(
            "[filter \"evil\"]\n\tclean = \"sh -c 'echo ran >> {}; cat'\"\n",
            marker.display()
        ));
        fs::write(d.join(".git/config"), config).unwrap();
        fs::write(d.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        fs::write(d.join("a.txt"), "a\n").unwrap();
        let add = git_step(&d, &["add", "a.txt"], INIT_LIMIT);
        let ran = marker.exists();
        let _ = fs::remove_file(&marker);
        fs::remove_dir_all(&d).unwrap();
        assert!(add.is_ok(), "{add:?}");
        assert!(!ran, "a step ran a configured filter");
    }

    #[test]
    fn project_create_is_never_forwarded_to_a_paired_machine() {
        assert!(
            include_str!("../server.rs")
                .split("operation is local owner-only")
                .next()
                .unwrap()
                .contains("Request::ProjectCreate")
        );
    }

    #[test]
    fn a_root_of_slash_or_home_covers_nothing() {
        let d = scratch("broad");
        fs::write(d.join("f"), "").unwrap();
        assert!(inside(&d.join("f"), &known(&d)).is_ok());
        assert!(inside(&d.join("f"), &BTreeSet::from(["/".to_string()])).is_err());
        assert!(
            create_in(&d, "a\u{202e}b").is_err(),
            "bidi override in a name"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn base64_round_trips_every_padding() {
        for n in 0..8 {
            let b: Vec<u8> = (0..n).map(|i| i * 37).collect();
            assert_eq!(crate::images::decode(&encode(&b)).unwrap(), b);
        }
    }
}
