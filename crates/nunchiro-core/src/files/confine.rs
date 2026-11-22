//! Root confinement: a request names a root and a relative path; the opened file must still sit under
//! the canonical root after opening, so a symlink swapped in after the check cannot lead out.
use std::{
    fs::{self, File},
    io,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
};

/// What a request may read. `Data` is Nunchiro's home: only the viewable subfolders are reachable,
/// never `window.json`, `sessions.json`, the queue, journals or any token.
pub enum Root {
    Folder(PathBuf),
    Data(PathBuf),
}
pub(super) const DATA_VIEWABLE: [&str; 2] = ["artifacts", "images"];

pub(super) struct Opened {
    pub file: File,
    /// Verified canonical path of what was opened.
    pub path: PathBuf,
    /// Search results and listings are named relative to this (the folder, or the data home).
    pub anchor: PathBuf,
    /// Canonical confinement root: everything opened under this request must stay inside it.
    pub base: PathBuf,
}

/// `.git` holds remotes that can carry tokens, so it is never served, at any depth. Compared
/// case-insensitively because the default macOS volume is.
fn in_git_dir(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .as_encoded_bytes()
            .eq_ignore_ascii_case(b".git")
    })
}

pub(super) fn open(root: &Root, rel: &str) -> Result<Opened, String> {
    let rel = Path::new(rel);
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(p) => parts.push(p),
            Component::CurDir => {}
            _ if rel.as_os_str().is_empty() => {}
            _ => return Err("path not allowed".into()),
        }
    }
    if rel.as_os_str().as_encoded_bytes().contains(&0) || in_git_dir(rel) {
        return Err("path not allowed".into());
    }
    let (anchor, base) = match root {
        Root::Folder(dir) => {
            let dir = fs::canonicalize(dir).map_err(|_| "root unavailable")?;
            (dir.clone(), dir)
        }
        Root::Data(home) => {
            let first = parts.first().ok_or("path not allowed")?;
            if !DATA_VIEWABLE.iter().any(|d| first == d) {
                return Err("path not allowed".into());
            }
            let home = fs::canonicalize(home).map_err(|_| "root unavailable")?;
            let base = fs::canonicalize(home.join(first)).map_err(|_| "not found")?;
            (home, base)
        }
    };
    let real = fs::canonicalize(parts.iter().fold(anchor.clone(), |p, c| p.join(c)))
        .map_err(|_| "not found")?;
    if !real.starts_with(&base) {
        return Err("outside root".into());
    }
    // A link inside the root can point into `.git` too.
    if in_git_dir(real.strip_prefix(&base).unwrap_or(&real)) {
        return Err("path not allowed".into());
    }
    // O_NONBLOCK so a FIFO swapped in cannot hang the core; O_NOFOLLOW so the last component is real.
    let file = open_under(&real, &base).map_err(|e| e.to_string())?;
    let now = fd_path(&file).map_err(|_| "not readable")?;
    let kind = file.metadata().map_err(|_| "not readable")?.file_type();
    if !kind.is_file() && !kind.is_dir() {
        return Err("not a regular file or folder".into());
    }
    Ok(Opened {
        file,
        path: now,
        anchor,
        base,
    })
}

/// Opens `path` without following a final link or blocking, then checks where the descriptor really
/// points: an intermediate folder swapped for a link after any earlier check is caught here.
pub(super) fn open_under(path: &Path, base: &Path) -> Result<File, &'static str> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "not readable")?;
    let now = fd_path(&file).map_err(|_| "not readable")?;
    if !now.starts_with(base) {
        return Err("outside root");
    }
    if in_git_dir(now.strip_prefix(base).unwrap_or(&now)) {
        return Err("path not allowed");
    }
    Ok(file)
}

#[cfg(target_os = "macos")]
fn fd_path(file: &File) -> io::Result<PathBuf> {
    use std::{ffi::OsStr, os::fd::AsRawFd, os::unix::ffi::OsStrExt};
    let mut buf = [0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(OsStr::from_bytes(&buf[..n])))
}
#[cfg(not(target_os = "macos"))]
fn fd_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_open_under_refuses_a_folder_swapped_for_a_link_out() {
        let dir =
            fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch"))
                .unwrap();
        let top = dir.join(format!("confine-{}", std::process::id()));
        let (base, outside) = (top.join("base"), top.join("outside"));
        fs::create_dir_all(base.join("d")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(base.join("d/f.txt"), "inside").unwrap();
        fs::write(outside.join("f.txt"), "outside").unwrap();
        let base = fs::canonicalize(base).unwrap();
        // The path string still passes a lexical prefix check, as it would after a swap.
        let path = base.join("d/f.txt");
        assert!(open_under(&path, &base).is_ok());
        fs::remove_dir_all(base.join("d")).unwrap();
        symlink_dir(&outside, &base.join("d"));
        assert_eq!(open_under(&path, &base).err(), Some("outside root"));
        fs::remove_dir_all(top).unwrap();
    }
    fn symlink_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }
}
