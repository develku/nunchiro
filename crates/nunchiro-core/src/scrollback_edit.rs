//! V1A-38b: scrollback to $EDITOR. A window op (not an `api::Request`: the owner socket, session tokens and the CLI
//! cannot express it) that writes a session's whole log, escapes stripped, to `exports/<session id>/scrollback.txt`
//! and starts a plain shell session that opens it. The window sends only the session id; the path and the argv are
//! the core's. Nothing is typed into any PTY (ADR 0001).
use crate::{
    api::{self, AgentKind, Request, Session, StartSession},
    sessions::Sessions,
    store,
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CStr, CString},
    fs::{self, File, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Sent as `{"id":n,"request":{"op":"scrollback_edit","id":"<session id>"}}`.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    ScrollbackEdit { id: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    /// `truncated`: the log had already dropped its oldest bytes (`REPLAY_BYTES`), so the file starts mid-log.
    ScrollbackEdit { session: Session, truncated: bool },
}

pub const LOGIN_SHELL: &str = "/bin/zsh";
/// Runs as `zsh -l -c SCRIPT nunchiro-edit <path>`: the path is `$1`, never part of the script. `eval` splits an
/// `$EDITOR` with flags (`code -w`) in zsh too; it sees the literal `"$1"`, not the path. Ticket 800: a test core
/// adds `$2` (`RECORDED`), so the script never runs `open -t`; the core records it itself (`record_fallback`).
pub const SCRIPT: &str =
    r#"if [ -n "$EDITOR" ]; then eval "$EDITOR"' "$1"'; elif [ -z "$2" ]; then open -t "$1"; fi"#;
pub const RECORDED: &str = "recorded";

pub fn argv(path: &Path) -> Result<Vec<String>, String> {
    let path = path.to_str().ok_or("data folder path is not UTF-8")?;
    let mut argv: Vec<String> = [LOGIN_SHELL, "-l", "-c", SCRIPT, "nunchiro-edit", path]
        .map(String::from)
        .to_vec();
    if crate::opener::record().is_some() {
        argv.push(RECORDED.into());
    }
    Ok(argv)
}

/// Ticket 800: a test core records the script's `open -t` fallback through the opener's checked writer, never the
/// shell. It judges `$EDITOR` from the core's own environment, which the session inherits.
fn record_fallback(path: &Path) -> Result<(), String> {
    if std::env::var_os("EDITOR").is_some_and(|e| !e.is_empty()) {
        return Ok(());
    }
    let path = path.to_str().ok_or("data folder path is not UTF-8")?;
    crate::opener::recorded(&["-t".into(), path.into()]).unwrap_or(Ok(()))
}

/// The log as text: lossy UTF-8, CSI, OSC, DCS/SOS/PM/APC and other ESC sequences (7- and 8-bit) removed, and every
/// control character but `\n` and `\t`.
pub fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let kind = match c {
            // A lone ESC before a control or the end goes; the control is handled on its own.
            '\x1b' => match chars.peek() {
                Some(&n) if ('\x20'..='\x7e').contains(&n) => chars.next(),
                _ => continue,
            },
            '\u{9b}' => Some('['),
            '\u{9d}' => Some(']'),
            '\u{90}' => Some('P'),
            '\u{98}' => Some('X'),
            '\u{9e}' => Some('^'),
            '\u{9f}' => Some('_'),
            '\n' | '\t' => {
                out.push(c);
                continue;
            }
            c if c.is_control() => continue,
            c => {
                out.push(c);
                continue;
            }
        };
        match kind {
            // CSI: parameter and intermediate bytes, then one final byte.
            Some('[') => {
                while let Some(&n) = chars.peek() {
                    if !('\x20'..='\x3f').contains(&n) {
                        if ('\x40'..='\x7e').contains(&n) {
                            chars.next();
                        }
                        break;
                    }
                    chars.next();
                }
            }
            // A string up to BEL or ST. shortcut: it also ends at a newline, so one unterminated OSC cannot swallow
            // the rest of the log; a DCS payload with newlines (sixel) leaves its later lines as text.
            Some(']' | 'P' | 'X' | '^' | '_') => {
                while let Some(&n) = chars.peek() {
                    match n {
                        '\n' => break,
                        '\x07' | '\u{9c}' => {
                            chars.next();
                            break;
                        }
                        '\x1b' => {
                            chars.next();
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                        _ => {
                            chars.next();
                        }
                    }
                }
            }
            // Other ESC sequences: intermediates, then one final byte.
            Some(n) if ('\x20'..='\x2f').contains(&n) => {
                while chars.peek().is_some_and(|n| ('\x20'..='\x2f').contains(n)) {
                    chars.next();
                }
                chars.next();
            }
            _ => {}
        }
    }
    out
}

/// Writes `text` to `<home>/exports/<id>/scrollback.txt` (folders 0700, never through a symlink; file 0600,
/// replaced whole) and returns its absolute path.
pub fn export(home: &Path, id: &str, text: &str) -> Result<PathBuf, String> {
    if !store::valid_id(id) {
        return Err("invalid session id".into());
    }
    let parent = home.join("exports");
    store::private_dir(&parent)?;
    let dir = parent.join(id);
    store::private_dir(&dir)?;
    let path = fs::canonicalize(&dir)
        .map_err(|e| e.to_string())?
        .join("scrollback.txt");
    store::atomic_write(&path, text.as_bytes())?;
    Ok(path)
}

/// Round 2: an export is kept until its session is deleted. Removes `exports/<id>/` and its files, never through a
/// link: both folders are opened `O_NOFOLLOW` and emptied and removed through their handles, and a folder that is not
/// this user's private (0700-style) one is refused and left as it is.
pub(crate) fn remove(home: &Path, id: &str) -> Result<(), String> {
    if !store::valid_id(id) {
        return Err("invalid session id".into());
    }
    let Some(exports) = open_exports(home)? else {
        return Ok(());
    };
    let name = CString::new(id).map_err(|e| e.to_string())?;
    remove_in(&exports, &name)
}

/// At core start, as `scrollback::sweep`: removes each export folder whose name `keep` refuses; failures are logged.
pub(crate) fn sweep(home: &Path, keep: impl Fn(&str) -> bool) {
    let exports = match open_exports(home) {
        Ok(Some(exports)) => exports,
        Ok(None) => return,
        Err(e) => return eprintln!("exports sweep: {e}"),
    };
    let names = match crate::scrollback::names(&exports) {
        Ok(names) => names,
        Err(e) => return eprintln!("exports sweep: {e}"),
    };
    for name in names {
        if name.to_str().is_ok_and(&keep) {
            continue;
        }
        if let Err(e) = remove_in(&exports, &name) {
            eprintln!("exports sweep {}: {e}", name.to_string_lossy());
        }
    }
}

fn open_exports(home: &Path) -> Result<Option<File>, String> {
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(home.join("exports"))
    {
        Ok(folder) => Ok(Some(folder)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            Err("data folder must not be a symlink".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn remove_in(exports: &File, name: &CStr) -> Result<(), String> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(exports.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        let e = std::io::Error::last_os_error();
        return match e.raw_os_error() {
            Some(libc::ENOENT) => Ok(()),
            Some(libc::ELOOP | libc::ENOTDIR) => {
                Err("export folder is not a private folder".into())
            }
            _ => Err(e.to_string()),
        };
    }
    let dir = unsafe { File::from_raw_fd(fd) };
    let meta = dir.metadata().map_err(|e| e.to_string())?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("export folder is not a private folder".into());
    }
    for entry in crate::scrollback::names(&dir)? {
        // Without AT_REMOVEDIR: a link is removed itself, a folder inside is refused (the removal then fails).
        if unsafe { libc::unlinkat(dir.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    if unsafe { libc::unlinkat(exports.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// The window's op. The log is read and the editor session started under the registry lock, as `Read` and `Start`.
pub(crate) fn run(home: &Path, registry: &Mutex<Sessions>, op: Op) -> Result<Reply, String> {
    let Op::ScrollbackEdit { id } = op;
    if !store::valid_id(&id) {
        return Err("invalid session id".into());
    }
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let (log, project) = {
        let mut sessions = lock()?;
        let Ok(api::Reply::Snapshot { sessions: list, .. }) = sessions.handle(Request::List) else {
            return Err("session list unavailable".into());
        };
        let project = list
            .into_iter()
            .find(|s| s.id == id && s.machine.is_none())
            .ok_or("session not found")?
            .project;
        let log = sessions.handle(Request::Read {
            id: id.clone(),
            after: 0,
        })?;
        (log, project)
    };
    let api::Reply::Output {
        data, truncated, ..
    } = log
    else {
        return Err("session has no log".into());
    };
    let path = export(home, &id, &plain(&data))?;
    let start = StartSession {
        account: None,
        kind: AgentKind::Shell,
        project,
        worktree: false,
        label: "scrollback".into(),
        args: argv(&path)?,
        model: None,
        effort: None,
        resume: None,
    };
    // As `Request::Start` in the window loop: prepare off the lock, start under it.
    // Ticket 1008 round 4: a window op, the owner's own tab, so it keeps his environment.
    let launch = lock()?.launch(start).owner_terminal();
    let mut launch = launch.prepare()?;
    let session = lock()?.start(&launch)?;
    launch.committed = true;
    record_fallback(&path)?;
    Ok(Reply::ScrollbackEdit { session, truncated })
}
