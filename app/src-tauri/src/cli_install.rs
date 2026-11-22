//! Ticket 262 (needs 197 G19 part a): the About page's app commands. `about_info` reports the app, core and macOS
//! versions; `cli_status` and `cli_install` manage one symlink, `~/.local/bin/nunchiro` -> the `nunchiro` inside
//! `Nunchiro.app/Contents/MacOS/` (the binary docs/first-run.md copies there). Install writes that link (and
//! `~/.local/bin` when missing) and nothing else: no skill, no agent config, no shell rc file (widget check G19 fix;
//! acceptance card: nothing under the agents' own config folders). It replaces only a link into a Nunchiro.app; a
//! file, a folder or a link elsewhere stays as it is. Only an app named exactly `Nunchiro.app` installs: the RC
//! ("Nunchiro RC.app") keeps its own home (V2.5-34), and its CLI on PATH would reach the owner's `~/.nunchiro`.
//! A linked `~/.local` or `~/.local/bin` is refused (it could lead into `~/.codex` or `~/.claude`), and only the main
//! window may call `cli_status` and `cli_install` (round 2 of the lane's reviews).
//!
//! The installed / stale / conflict states and the path hint are adapted from Orca
//! `src/main/cli/cli-command-inspection.ts` (`inspectSymlink`) and `src/shared/cli-install-types.ts`
//! (`CliInstallStatus`), reduced to one macOS symlink; Orca's wrapper scripts, privileged repair, WSL and Windows
//! paths are not lifted.
//!
//! Orca licence (applies to the adapted states):
//!
//! MIT License. Copyright (c) 2026 Lovecast Inc. Permission is hereby granted, free of charge, to any person
//! obtaining a copy of this software and associated documentation files (the "Software"), to deal in the
//! Software without restriction, including without limitation the rights to use, copy, modify, merge,
//! publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//! Software is furnished to do so, subject to the following conditions: The above copyright notice and
//! this permission notice shall be included in all copies or substantial portions of the Software.
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
//! NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
//! WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//! SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
use serde::Serialize;
use std::ffi::{CStr, CString, OsStr};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The one bundle name that installs (and whose links count as ours).
const APP: &str = "Nunchiro.app";
/// The line the page shows when `~/.local/bin` is not on the login PATH.
const PATH_LINE: &str = r#"export PATH="$HOME/.local/bin:$PATH""#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NotInstalled,
    /// The link points at this app's binary.
    Installed,
    /// A link into some other (or a removed) Nunchiro.app: Install moves it here.
    Stale,
    /// A regular file that is a Nunchiro binary (an old copy): Install moves it to `nunchiro.old`, then links.
    OldCopy,
    /// Anything else at the link's place: Install refuses and writes nothing.
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub state: State,
    pub link: PathBuf,
    /// This app's binary, or `None` when this app is not a Nunchiro.app (nothing to install from).
    pub target: Option<PathBuf>,
    /// Where the link points now (resolved against its folder), when it is a link.
    pub current: Option<PathBuf>,
    pub path_hint: Option<String>,
    /// The (device, inode) of the old copy `status` classified; `put` moves only that file.
    #[serde(skip)]
    old: Option<(u64, u64)>,
}

/// `<…>/Nunchiro.app/Contents/MacOS/nunchiro`, by name only (a link to a removed copy still counts).
fn in_bundle(p: &Path) -> bool {
    let tail: Vec<_> = p
        .components()
        .rev()
        .take(4)
        .map(|c| c.as_os_str())
        .collect();
    tail == ["nunchiro", "MacOS", "Contents", APP]
}

fn on_path(login_path: &str, dir: &Path) -> bool {
    login_path
        .split(':')
        .any(|e| !e.is_empty() && Path::new(e.trim_end_matches('/')) == dir)
}

/// The (device, inode) of `p` when it is a regular file whose first 16 MiB hold the name of the data-folder variable every
/// build reads. Opened without following a link and without blocking (a FIFO put there never hangs), checked on the
/// opened handle, and read at most 16 MiB, so a huge or growing file costs the same.
/// A release build's marker sits near 10 MiB of 29 MiB, hence 16 MiB, not 4.
/// shortcut: a string match, not a signature check, and a build whose marker lies past 16 MiB reads as Conflict.
fn old_copy_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    const MARK: &[u8] = b"NUNCHIRO_HOME";
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(p)
        .ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() {
        return None;
    }
    let mut head = Vec::new();
    f.take(16 << 20).read_to_end(&mut head).ok()?;
    head.windows(MARK.len())
        .any(|w| w == MARK)
        .then_some((m.dev(), m.ino()))
}

/// What sits at `~/.local/bin/nunchiro` against `target` (this app's binary, `None` outside a bundle).
pub fn status(home: &Path, target: Option<&Path>, login_path: Option<&str>) -> Status {
    let bin = home.join(".local/bin");
    let link = bin.join("nunchiro");
    let target = target.filter(|t| in_bundle(t) && t.is_file());
    // None: nothing there; Some(None): something that is not a link; Some(Some(to)): a link to `to`.
    let current = std::fs::symlink_metadata(&link).ok().map(|m| {
        m.file_type()
            .is_symlink()
            .then(|| std::fs::read_link(&link).ok().map(|t| bin.join(t)))
            .flatten()
    });
    let old = current
        .as_ref()
        .is_some_and(Option::is_none)
        .then(|| old_copy_id(&link))
        .flatten();
    let state = match &current {
        None => State::NotInstalled,
        Some(Some(c)) if target.is_some_and(|t| t == c) && c.is_file() => State::Installed,
        Some(Some(c)) if in_bundle(c) => State::Stale,
        Some(None) if old.is_some() => State::OldCopy,
        Some(_) => State::Conflict,
    };
    Status {
        state,
        target: target.map(Path::to_path_buf),
        current: current.flatten(),
        old,
        path_hint: (!login_path.is_some_and(|p| on_path(p, &bin))).then(|| PATH_LINE.into()),
        link,
    }
}

fn cvt(r: libc::c_int) -> std::io::Result<libc::c_int> {
    if r < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(r)
    }
}

/// `openat(at, name)` as a folder that is not a link.
fn open_dir(at: libc::c_int, name: &CStr) -> std::io::Result<OwnedFd> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = cvt(unsafe { libc::openat(at, name.as_ptr(), flags) })?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `~/.local/bin`, opened one level at a time from the home folder (each missing level made with `mkdirat`), so the
/// folder the link goes into is held open and a later swap of `~/.local` or `~/.local/bin` cannot redirect the write.
/// Refused when `~/.local` or `~/.local/bin` is a link or not a folder: a linked one can lead into `~/.codex` or
/// `~/.claude` or out of the home.
fn local_bin(home: &Path) -> Result<OwnedFd, String> {
    let c = CString::new(home.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
    let mut fd = cvt(unsafe { libc::open(c.as_ptr(), flags) })
        .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
        .map_err(|e| format!("cannot read {}: {e}", home.display()))?;
    let mut dir = home.to_path_buf();
    for part in [c".local", c"bin"] {
        dir.push(OsStr::from_bytes(part.to_bytes()));
        let mut open = open_dir(fd.as_raw_fd(), part);
        if open
            .as_ref()
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            match cvt(unsafe { libc::mkdirat(fd.as_raw_fd(), part.as_ptr(), 0o777) }) {
                Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => {
                    return Err(format!("cannot make {}: {e}", dir.display()));
                }
                _ => open = open_dir(fd.as_raw_fd(), part),
            }
        }
        // The error text only; the refusal itself is O_NOFOLLOW | O_DIRECTORY above.
        fd = open.map_err(|e| match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.file_type().is_symlink() => format!(
                "{} is a link; Nunchiro installs only into a real folder",
                dir.display()
            ),
            Ok(m) if !m.is_dir() => format!("{} is not a folder", dir.display()),
            _ => format!("cannot read {}: {e}", dir.display()),
        })?;
    }
    Ok(fd)
}

/// Where the link `name` in `dir` points, or `None` when it is not a link.
fn read_link_at(dir: libc::c_int, name: &CStr) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    let n = unsafe { libc::readlinkat(dir, name.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    buf.truncate(usize::try_from(n).ok()?);
    Some(PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

/// A temp link name in the link's folder that cannot be guessed from the pid.
fn temp_name() -> String {
    use std::hash::{BuildHasher, RandomState};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(".nunchiro-link-{:016x}", RandomState::new().hash_one(nanos))
}

/// Writes the link `nunchiro` in `dir` (the open `~/.local/bin`). Nothing there (`NotInstalled`): one `symlinkat()`,
/// which fails when anything appeared meanwhile. A stale Nunchiro link: a new link under a random name is swapped with
/// it (`renameatx_np` `RENAME_SWAP`, so the old entry is never followed or lost), then the swapped-out entry is checked
/// with the test `status` uses for Stale: a link into a Nunchiro.app is removed; anything else (a file another installer
/// put there since `status`) is swapped back and nothing changes. A volume that cannot swap refuses; there is no
/// plain-rename fallback.
fn put(dir: &OwnedFd, target: &Path, state: State, old: Option<(u64, u64)>) -> std::io::Result<()> {
    const NAME: &CStr = c"nunchiro";
    let fd = dir.as_raw_fd();
    let to = CString::new(target.as_os_str().as_bytes())?;
    let link_to = |name: &CStr| cvt(unsafe { libc::symlinkat(to.as_ptr(), fd, name.as_ptr()) });
    if state == State::NotInstalled {
        return link_to(NAME).map(drop);
    }
    if state == State::OldCopy {
        // The old binary is moved, never deleted, and never over an earlier `nunchiro.old` (RENAME_EXCL).
        const OLD: &CStr = c"nunchiro.old";
        let mv = |from: &CStr, to: &CStr| {
            cvt(unsafe {
                libc::renameatx_np(fd, from.as_ptr(), fd, to.as_ptr(), libc::RENAME_EXCL)
            })
        };
        mv(NAME, OLD).map_err(|e| match e.raw_os_error() {
            Some(libc::EEXIST) => std::io::Error::other(
                "~/.local/bin/nunchiro.old is already there; move it, then Install again",
            ),
            _ => e,
        })?;
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        let regular =
            cvt(unsafe { libc::fstatat(fd, OLD.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) })
                .is_ok_and(|_| {
                    st.st_mode & libc::S_IFMT == libc::S_IFREG
                        && Some((st.st_dev as u64, st.st_ino)) == old
                });
        // Something else was put there since `status`: back it goes, untouched.
        let linked = if regular {
            link_to(NAME).map(drop)
        } else {
            Err(std::io::Error::other(
                "something else appeared at ~/.local/bin/nunchiro; nothing was changed",
            ))
        };
        if linked.is_err() {
            let _ = mv(OLD, NAME);
        }
        return linked;
    }
    let tmp = CString::new(temp_name())?;
    link_to(&tmp)?; // fails, removing nothing, if the name is taken
    let swap = || {
        cvt(unsafe { libc::renameatx_np(fd, tmp.as_ptr(), fd, NAME.as_ptr(), libc::RENAME_SWAP) })
    };
    // Removes the temp name only while it holds the link made above.
    let drop_ours = || {
        if read_link_at(fd, &tmp).as_deref() == Some(target) {
            unsafe { libc::unlinkat(fd, tmp.as_ptr(), 0) };
        }
    };
    if let Err(e) = swap() {
        drop_ours();
        return Err(match e.raw_os_error() {
            Some(libc::ENOTSUP) => std::io::Error::other(
                "this volume cannot swap links safely; remove the old ~/.local/bin/nunchiro and Install again",
            ),
            _ => e,
        });
    }
    // The temp name now holds what was at the link.
    if read_link_at(fd, &tmp).is_some_and(|t| in_bundle(&t)) {
        cvt(unsafe { libc::unlinkat(fd, tmp.as_ptr(), 0) })?;
        return Ok(());
    }
    swap().map_err(|e| {
        std::io::Error::other(format!(
            "something else appeared at ~/.local/bin/nunchiro and could not be put back ({e}); it is now ~/.local/bin/{}",
            tmp.to_string_lossy()
        ))
    })?;
    drop_ours();
    Err(std::io::Error::other(
        "something else appeared at ~/.local/bin/nunchiro; nothing was changed",
    ))
}

/// Links `~/.local/bin/nunchiro` to `target` unless something not ours is there; returns the status after.
pub fn install(
    home: &Path,
    target: Option<&Path>,
    login_path: Option<&str>,
) -> Result<Status, String> {
    let now = status(home, target, login_path);
    let (Some(target), State::NotInstalled | State::Stale | State::OldCopy) =
        (&now.target, now.state)
    else {
        return Ok(now); // installed already, refused (conflict), or nothing to install from
    };
    let dir = local_bin(home)?;
    put(&dir, target, now.state, now.old)
        .map_err(|e| format!("cannot link {}: {e}", now.link.display()))?;
    Ok(status(home, Some(target), login_path))
}

/// This app's own `Contents/MacOS/nunchiro` (the binary next to the app's executable).
fn bundle_binary() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("nunchiro"))
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(crate::passwd::passwd_home)
        .ok_or_else(|| "no home folder".into())
}

/// The login shell's PATH (interactive, so `~/.zshrc` counts, as VS Code's shell-environment read does with `-ilc`),
/// or `None` when it does not answer within 3 s or 64 KiB. The output is only matched, never run.
// shortcut: one shell start per About open and per Install; cache it if that ever shows.
fn login_path() -> Option<String> {
    const MARK: &str = "__NUNCHIRO_PATH__";
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", &format!(r#"printf '\n{MARK}%s\n' "$PATH""#)]);
    marked_line(cmd, MARK, Duration::from_secs(3), 64 << 10)
}

/// Runs `cmd` and returns the rest of the first line that holds `mark`, or `None` after `limit` or `cap` bytes; the child
/// is killed either way. A reader thread does the reading, since an rc background job can hold the pipe open after the
/// shell exits; that thread ends when the pipe closes (known limit: it outlives the call while such a job runs).
fn marked_line(mut cmd: Command, mark: &str, limit: Duration, cap: usize) -> Option<String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take();
    let mark = mark.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let line = loop {
            match out.as_mut().map(|o| o.read(&mut chunk)) {
                Some(Ok(n)) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                _ => break None,
            }
            let text = String::from_utf8_lossy(&buf);
            if let Some((line, _)) = text
                .split_once(&mark)
                .and_then(|(_, rest)| rest.split_once('\n'))
            {
                break Some(line.to_string());
            }
            if buf.len() >= cap {
                break None;
            }
        };
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(limit).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    line
}

/// The `ProductVersion` of /System/Library/CoreServices/SystemVersion.plist (an XML plist).
fn macos_version() -> Option<String> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    let rest = plist.split_once("<key>ProductVersion</key>")?.1;
    let v = rest
        .split_once("<string>")?
        .1
        .split_once("</string>")?
        .0
        .trim();
    (!v.is_empty() && v.len() < 32).then(|| v.to_string())
}

#[derive(Serialize)]
pub struct Info {
    app: String,
    core: Option<String>,
    macos: Option<String>,
    /// The bundle's Resources folder, which holds THIRD_PARTY_NOTICES.md and the two package licence lists.
    resources: Option<PathBuf>,
}

/// The app's version, the core's (`nunchiro --version` of the CLI this app starts the core with) and macOS's.
#[tauri::command(async)]
pub fn about_info<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
) -> Result<Info, String> {
    use tauri::Manager as _;
    main_only(&webview)?;
    let core = Command::new(crate::cli())
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().strip_prefix("nunchiro ").map(str::to_string));
    Ok(Info {
        app: app.package_info().version.to_string(),
        core,
        macos: macos_version(),
        resources: app.path().resource_dir().ok(),
    })
}

/// Only the owner's main window may read or install (house pattern, save.rs `save_text`).
pub(crate) fn main_only<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    (webview.label() == "main")
        .then_some(())
        .ok_or_else(|| "not allowed".into())
}

#[tauri::command(async)]
pub fn cli_status<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Result<Status, String> {
    main_only(&webview)?;
    Ok(status(
        &user_home()?,
        bundle_binary().as_deref(),
        login_path().as_deref(),
    ))
}

#[tauri::command(async)]
pub fn cli_install<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Result<Status, String> {
    main_only(&webview)?;
    install(
        &user_home()?,
        bundle_binary().as_deref(),
        login_path().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    /// A fresh folder under the repo's `.scratch`, removed by `Drop` when a test passes.
    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Dir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../.scratch/cli-install-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir.canonicalize().unwrap())
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            if !std::thread::panicking() {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// `<root>/<apps>/Nunchiro.app/Contents/MacOS/nunchiro`, a plain file.
    fn bundle(root: &Path, apps: &str, app: &str) -> PathBuf {
        let bin = root.join(apps).join(app).join("Contents/MacOS/nunchiro");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        bin
    }

    const ON_PATH: &str = "/usr/bin:/bin";

    fn on_path(home: &Path) -> String {
        format!("/usr/bin:{}/.local/bin:/bin", home.display())
    }

    #[test]
    fn cli_install_links_bundle_binary_into_local_bin() {
        let d = Dir::new();
        let home = d.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = home.join(".local/bin/nunchiro");
        let path = on_path(&home);
        assert_eq!(
            status(&home, Some(&bin), Some(&path)).state,
            State::NotInstalled
        );
        // ~/.local/bin is made when missing; the link points at the bundle's binary itself.
        let s = install(&home, Some(&bin), Some(&path)).unwrap();
        assert_eq!(s.state, State::Installed);
        assert_eq!(s.link, link);
        assert_eq!(std::fs::read_link(&link).unwrap(), bin);
        assert_eq!(s.current.as_deref(), Some(bin.as_path()));
        // Again: nothing changes.
        assert_eq!(
            install(&home, Some(&bin), Some(&path)).unwrap().state,
            State::Installed
        );
        // A link into another Nunchiro.app (an older copy) is stale and moves to this one.
        let old = bundle(&d.0, "Old", "Nunchiro.app");
        std::fs::remove_file(&link).unwrap();
        symlink(&old, &link).unwrap();
        assert_eq!(status(&home, Some(&bin), Some(&path)).state, State::Stale);
        assert_eq!(
            install(&home, Some(&bin), Some(&path)).unwrap().state,
            State::Installed
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), bin);
        // A dangling link into a Nunchiro.app that is gone is stale too.
        std::fs::remove_file(&link).unwrap();
        symlink(d.0.join("Gone/Nunchiro.app/Contents/MacOS/nunchiro"), &link).unwrap();
        assert_eq!(status(&home, Some(&bin), Some(&path)).state, State::Stale);
        // Only Nunchiro.app installs: the RC ("Nunchiro RC.app") or a dev build outside a bundle writes nothing.
        let rc = bundle(&d.0, "rc", "Nunchiro RC.app");
        std::fs::remove_file(&link).unwrap();
        for target in [
            Some(rc.as_path()),
            Some(d.0.join("target/debug/nunchiro").as_path()),
            None,
        ] {
            let s = install(&home, target, Some(&path)).unwrap();
            assert_eq!(s.target, None, "{target:?}");
            assert_eq!(s.state, State::NotInstalled);
            assert!(std::fs::symlink_metadata(&link).is_err());
        }
    }

    #[test]
    fn cli_install_refuses_foreign_file() {
        let d = Dir::new();
        let home = d.0.join("home");
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = home.join(".local/bin/nunchiro");
        let path = on_path(&home);
        // A regular file (the `cargo install` copy of docs/first-run.md), a link elsewhere, a folder: each stays as it was.
        std::fs::write(&link, b"cargo-installed").unwrap();
        let s = install(&home, Some(&bin), Some(&path)).unwrap();
        assert_eq!(s.state, State::Conflict);
        assert_eq!(std::fs::read(&link).unwrap(), b"cargo-installed");
        std::fs::remove_file(&link).unwrap();
        symlink("/usr/bin/true", &link).unwrap();
        let s = install(&home, Some(&bin), Some(&path)).unwrap();
        assert_eq!(s.state, State::Conflict);
        assert_eq!(s.current.as_deref(), Some(Path::new("/usr/bin/true")));
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            Path::new("/usr/bin/true")
        );
        std::fs::remove_file(&link).unwrap();
        std::fs::create_dir(&link).unwrap();
        assert_eq!(
            install(&home, Some(&bin), Some(&path)).unwrap().state,
            State::Conflict
        );
        assert!(link.is_dir());
        // No temporary link is left beside it.
        let names: Vec<_> = std::fs::read_dir(home.join(".local/bin"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["nunchiro"]);
    }

    #[test]
    fn cli_install_moves_an_old_nunchiro_copy_aside_then_links() {
        let d = Dir::new();
        let home = d.0.join("home");
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = home.join(".local/bin/nunchiro");
        let path = on_path(&home);
        std::fs::write(&link, b"\x7fELF old NUNCHIRO_HOME build").unwrap();
        assert_eq!(status(&home, Some(&bin), Some(&path)).state, State::OldCopy);
        // An earlier nunchiro.old is never replaced: nothing changes.
        let old = home.join(".local/bin/nunchiro.old");
        std::fs::write(&old, b"earlier").unwrap();
        assert!(install(&home, Some(&bin), Some(&path)).is_err());
        assert!(link.is_file() && std::fs::read(&old).unwrap() == b"earlier");
        std::fs::remove_file(&old).unwrap();
        let s = install(&home, Some(&bin), Some(&path)).unwrap();
        assert_eq!(s.state, State::Installed);
        assert_eq!(
            std::fs::read(&old).unwrap(),
            b"\x7fELF old NUNCHIRO_HOME build"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), bin);
    }

    #[test]
    fn cli_install_old_copy_check_is_bounded_and_identity_checked() {
        let d = Dir::new();
        let home = d.0.join("home");
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = home.join(".local/bin/nunchiro");
        let path = on_path(&home);
        // The marker past the first 16 MiB reads as a Conflict, as before.
        let mut late = vec![0u8; 17 << 20];
        late.extend(b"NUNCHIRO_HOME");
        std::fs::write(&link, &late).unwrap();
        assert_eq!(
            status(&home, Some(&bin), Some(&path)).state,
            State::Conflict
        );
        // A FIFO there is a Conflict at once, never a hang.
        std::fs::remove_file(&link).unwrap();
        let fifo = CString::new(link.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            status(&home, Some(&bin), Some(&path)).state,
            State::Conflict
        );
        std::fs::remove_file(&link).unwrap();
        // Another file put there after `status` is moved back and nothing is linked.
        std::fs::write(&link, b"NUNCHIRO_HOME one").unwrap();
        let seen = status(&home, Some(&bin), Some(&path));
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, b"someone else's").unwrap();
        let dir = local_bin(&home).unwrap();
        assert!(put(&dir, &bin, State::OldCopy, seen.old).is_err());
        assert_eq!(std::fs::read(&link).unwrap(), b"someone else's");
        assert!(!home.join(".local/bin/nunchiro.old").exists());
    }

    /// Every path under `root` with its kind and content (a link's target, a file's bytes).
    fn tree(root: &Path) -> BTreeMap<PathBuf, String> {
        let mut out = BTreeMap::new();
        let mut todo = vec![root.to_path_buf()];
        while let Some(dir) = todo.pop() {
            for e in std::fs::read_dir(&dir).unwrap() {
                let p = e.unwrap().path();
                let m = std::fs::symlink_metadata(&p).unwrap();
                let v = if m.file_type().is_symlink() {
                    format!("link {}", std::fs::read_link(&p).unwrap().display())
                } else if m.is_dir() {
                    todo.push(p.clone());
                    "dir".into()
                } else {
                    format!("file {:?}", std::fs::read(&p).unwrap())
                };
                out.insert(p.strip_prefix(root).unwrap().to_path_buf(), v);
            }
        }
        out
    }

    #[test]
    fn cli_install_writes_nothing_under_claude_or_codex() {
        let d = Dir::new();
        let home = d.0.join("home");
        for (f, body) in [
            (".claude/settings.json", "{}"),
            (".claude/skills/x/SKILL.md", "x"),
            (".codex/config.toml", "model = \"x\""),
            (".zshrc", "# mine"),
        ] {
            std::fs::create_dir_all(home.join(f).parent().unwrap()).unwrap();
            std::fs::write(home.join(f), body).unwrap();
        }
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let before = tree(&home);
        install(&home, Some(&bin), Some(ON_PATH)).unwrap();
        let after = tree(&home);
        // Exactly the link and the folders that hold it are new; nothing else changed (no skill, no agent config, no rc file).
        let mut added: Vec<_> = after
            .keys()
            .filter(|k| !before.contains_key(*k))
            .cloned()
            .collect();
        added.sort();
        assert_eq!(
            added,
            [".local", ".local/bin", ".local/bin/nunchiro"].map(PathBuf::from)
        );
        for (k, v) in &before {
            assert_eq!(after.get(k), Some(v), "{k:?} changed");
        }
    }

    #[test]
    fn cli_install_refuses_linked_local_bin() {
        // ~/.local/bin (or ~/.local) linked into an agent home or out of the home: refused, nothing written there.
        let d = Dir::new();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        for (n, (linked, into)) in [
            (".local/bin", ".codex/bin"),
            (".local/bin", ".claude/bin"),
            (".local", ".codex/local"),
            (".local/bin", "../elsewhere/bin"),
        ]
        .into_iter()
        .enumerate()
        {
            let home = d.0.join(format!("home-{n}"));
            let to = home.join(into);
            std::fs::create_dir_all(&to).unwrap();
            std::fs::create_dir_all(home.join(linked).parent().unwrap()).unwrap();
            symlink(&to, home.join(linked)).unwrap();
            let before = tree(&to);
            let err = install(&home, Some(&bin), Some(ON_PATH)).unwrap_err();
            assert!(err.contains("is a link"), "{linked} -> {into}: {err}");
            assert_eq!(
                tree(&to),
                before,
                "{linked} -> {into}: wrote into the link's target"
            );
        }
    }

    #[test]
    fn cli_install_new_link_never_replaces_what_appeared() {
        let d = Dir::new();
        let home = d.0.join("home");
        let dir = home.join(".local/bin");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = dir.join("nunchiro");
        // Nothing was there when status looked; a file appeared before the link is made: plain symlink() refuses.
        std::fs::write(&link, b"appeared").unwrap();
        assert!(put(&local_bin(&home).unwrap(), &bin, State::NotInstalled, None).is_err());
        assert_eq!(std::fs::read(&link).unwrap(), b"appeared");
        std::fs::remove_file(&link).unwrap();
        // A stale link is replaced through a temp link whose name is not the pid; a file planted at the old fixed
        // name is neither removed nor used.
        let planted = dir.join(format!(".nunchiro-link-{}", std::process::id()));
        std::fs::write(&planted, b"planted").unwrap();
        symlink(d.0.join("Old/Nunchiro.app/Contents/MacOS/nunchiro"), &link).unwrap();
        put(&local_bin(&home).unwrap(), &bin, State::Stale, None).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), bin);
        assert_eq!(std::fs::read(&planted).unwrap(), b"planted");
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        let planted_name = planted.file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(names, [planted_name, "nunchiro".to_string()]);
        assert_ne!(temp_name(), temp_name());
    }

    #[test]
    fn cli_install_stale_replace_keeps_a_file_that_appeared() {
        let d = Dir::new();
        let home = d.0.join("home");
        let dir = home.join(".local/bin");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let link = dir.join("nunchiro");
        // A stale Nunchiro link when status looks; another installer puts a regular file there before the link is
        // written: the file survives byte for byte and the error names it.
        symlink(d.0.join("Old/Nunchiro.app/Contents/MacOS/nunchiro"), &link).unwrap();
        assert_eq!(status(&home, Some(&bin), None).state, State::Stale);
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, b"brew-installed\x00\xff").unwrap();
        let err = put(&local_bin(&home).unwrap(), &bin, State::Stale, None).unwrap_err();
        assert_eq!(std::fs::read(&link).unwrap(), b"brew-installed\x00\xff");
        assert!(
            !std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            err.to_string().contains("something else appeared at"),
            "{err}"
        );
        // No temp link is left beside it.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["nunchiro"]);
    }

    #[test]
    fn cli_install_writes_into_the_folder_it_checked() {
        let d = Dir::new();
        let home = d.0.join("home");
        let dir = home.join(".local/bin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(home.join(".codex/bin")).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        // ~/.local/bin is checked and opened, then moved away and replaced by a link into an agent home before the
        // write: the link lands in the folder that was checked, nothing in the agent home.
        let fd = local_bin(&home).unwrap();
        std::fs::rename(&dir, home.join("moved")).unwrap();
        symlink(home.join(".codex/bin"), &dir).unwrap();
        put(&fd, &bin, State::NotInstalled, None).unwrap();
        assert_eq!(
            std::fs::read_link(home.join("moved/nunchiro")).unwrap(),
            bin
        );
        assert_eq!(
            std::fs::read_dir(home.join(".codex/bin")).unwrap().count(),
            0
        );
    }

    #[test]
    fn login_path_read_is_bounded() {
        let sh = |script: &str| {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", script]);
            c
        };
        let quick = Duration::from_secs(2);
        // A background job keeps the pipe open after the shell printed PATH: the line still comes back at once.
        let started = Instant::now();
        let got = marked_line(
            sh(r"printf '\n__M__/a:/b\n'; sleep 4 &"),
            "__M__",
            Duration::from_secs(3),
            1 << 16,
        );
        assert_eq!(got.as_deref(), Some("/a:/b"));
        assert!(started.elapsed() < quick, "{:?}", started.elapsed());
        // Endless output without the mark stops at the byte cap; silence stops at the time limit.
        let started = Instant::now();
        assert_eq!(
            marked_line(sh("yes"), "__M__", Duration::from_secs(3), 1 << 16),
            None
        );
        assert!(started.elapsed() < quick, "{:?}", started.elapsed());
        let started = Instant::now();
        assert_eq!(
            marked_line(sh("sleep 4"), "__M__", Duration::from_millis(300), 1 << 16),
            None
        );
        assert!(started.elapsed() < quick, "{:?}", started.elapsed());
    }

    #[test]
    fn cli_commands_answer_only_the_main_window() {
        use tauri::ipc::InvokeResponse;
        use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};
        use tauri::webview::InvokeRequest;
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![cli_status, cli_install])
            .build(mock_context(noop_assets()))
            .unwrap();
        // A webview that is not the owner's main window (a browser view, a later second window).
        let other = tauri::WebviewWindowBuilder::new(&app, "browser-1", Default::default())
            .build()
            .unwrap();
        for cmd in ["cli_status", "cli_install"] {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            AsRef::<tauri::Webview<_>>::as_ref(&other)
                .clone()
                .on_message(
                    InvokeRequest {
                        cmd: cmd.into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: serde_json::json!({}).into(),
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
            assert_eq!(
                rx.recv().unwrap(),
                Some(serde_json::json!("not allowed")),
                "{cmd}"
            );
        }
    }

    #[test]
    fn cli_install_reports_path_hint_when_not_on_path() {
        let d = Dir::new();
        let home = d.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let bin = bundle(&d.0, "Applications", "Nunchiro.app");
        let hint = Some("export PATH=\"$HOME/.local/bin:$PATH\"");
        // Not on the login PATH, or the login PATH could not be read: the line to add.
        let s = install(&home, Some(&bin), Some(ON_PATH)).unwrap();
        assert_eq!(s.state, State::Installed);
        assert_eq!(s.path_hint.as_deref(), hint);
        assert_eq!(status(&home, Some(&bin), None).path_hint.as_deref(), hint);
        // On it (with or without a trailing slash): no hint.
        assert_eq!(
            status(&home, Some(&bin), Some(&on_path(&home)))
                .path_hint
                .as_deref(),
            None
        );
        let slash = format!("{}/.local/bin/:/bin", home.display());
        assert_eq!(status(&home, Some(&bin), Some(&slash)).path_hint, None);
    }
}
