//! Confined file access for the window (spec B3). Reads, plus one write (ticket 820): `write` replaces a text file the
//! window read, in a session folder, through the same confinement. Nothing here creates or deletes a file.
mod confine;
mod search;

use crate::api::{Reply, Request, Response};
pub use confine::Root;
pub use search::search;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read, path::Path, time::Duration};

/// Files over this return metadata only (spec B3).
pub const MAX_READ: u64 = 2 * 1024 * 1024; // v1b-06: pub, artifact blocks share it
/// Ticket 820: the largest file `write` edits and the largest text it takes; well under the window socket's 1 MiB message
/// (`http::MAX_MESSAGE`) after JSON escaping, so a save is refused in words and never drops the connection.
const MAX_EDIT: u64 = 512 * 1024;
const SNIFF: usize = 8192;
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    /// `dir`, `file` or `symlink`.
    pub kind: String,
    pub size: u64,
    pub ignored: bool,
    /// One git status letter (`M`, `A`, `D`, `R`, `?`, ...); a folder shows `?` when untracked and `M`
    /// when something beneath it changed. Null outside a git repository and for clean entries.
    pub git: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Text,
    Markdown,
    Image,
    Svg,
    Html,
    Binary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub kind: Kind,
    pub size: u64,
    pub too_large: bool,
    /// v1b-09: modification time at read, ms since the Unix epoch (0 if the platform has none), so the window
    /// can tell a same-size edit of a file over 2 MB.
    pub mtime_ms: u64,
    /// Text, Markdown, SVG and HTML up to 2 MB.
    pub text: Option<String>,
    /// Ticket 820: SHA-256 (hex) of the bytes read, with `text`; `file_write` takes it back to refuse a changed file.
    pub hash: Option<String>,
    /// Raw bytes of an image up to 2 MB.
    pub data: Option<Vec<u8>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Match {
    pub path: String,
    pub line: u64,
    pub text: String,
}

/// Runs one files request. The caller resolved `root` under the registry lock and dropped the lock:
/// everything here (directory walks, file reads, `git`) is slow and must never hold it.
pub fn run(root: Root, request: Request) -> Response {
    match request {
        Request::FilesList { path, .. } => {
            list(&root, &path).map(|entries| Reply::Files { entries })
        }
        Request::FileRead { path, .. } => read(&root, &path).map(Reply::File),
        Request::FileWrite {
            path, text, hash, ..
        } => write(&root, &path, &text, &hash).map(Reply::File),
        Request::FilesSearch {
            query, path, names, ..
        } => search(&root, &query, &path, names).map(|f| Reply::Matches {
            matches: f.matches,
            truncated: f.truncated,
            skipped_ignore_files: f.skipped_ignore_files,
        }),
        _ => Err("not a files request".into()),
    }
}

pub fn list(root: &Root, rel: &str) -> Result<Vec<FileEntry>, String> {
    if let Root::Data(home) = root
        && Path::new(rel).components().all(|c| c.as_os_str() == ".")
    {
        // The data root itself shows only its viewable subfolders.
        return Ok(confine::DATA_VIEWABLE
            .iter()
            .filter(|d| home.join(d).is_dir())
            .map(|d| FileEntry {
                name: d.to_string(),
                kind: "dir".into(),
                size: 0,
                ignored: false,
                git: None,
            })
            .collect());
    }
    let dir = confine::open(root, rel)?;
    if !dir.file.metadata().map_err(|e| e.to_string())?.is_dir() {
        return Err("not a folder".into());
    }
    let git = matches!(root, Root::Folder(_))
        .then(|| GitView::of(&dir.path))
        .flatten();
    let mut out = Vec::new();
    // shortcut: lists by path after the confinement check, so a swap in this window can only rename
    // entries (names and sizes are returned, never content); upgrade if listings ever carry content.
    for e in std::fs::read_dir(&dir.path)
        .map_err(|e| e.to_string())?
        .flatten()
        .take(MAX_ENTRIES)
    {
        let name = e.file_name().to_string_lossy().into_owned();
        if matches!(root, Root::Folder(_)) && name == ".git" {
            continue;
        }
        let Ok(meta) = e.path().symlink_metadata() else {
            continue;
        };
        let t = meta.file_type();
        out.push(FileEntry {
            kind: if t.is_symlink() {
                "symlink"
            } else if t.is_dir() {
                "dir"
            } else {
                "file"
            }
            .into(),
            size: if t.is_file() { meta.len() } else { 0 },
            ignored: git
                .as_ref()
                .is_some_and(|g| g.all_ignored || g.ignored.contains(&name)),
            git: git.as_ref().and_then(|g| {
                g.status
                    .get(&name)
                    .cloned()
                    .or_else(|| g.all_untracked.then(|| "?".into()))
            }),
            name,
        });
    }
    out.sort_by(|a, b| {
        (b.kind == "dir")
            .cmp(&(a.kind == "dir"))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

pub fn read(root: &Root, rel: &str) -> Result<FileContent, String> {
    let opened = confine::open(root, rel)?;
    let meta = opened.file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let size = meta.len();
    let too_large = size > MAX_READ;
    let mut bytes = Vec::new();
    opened
        .file
        .take(if too_large { SNIFF as u64 } else { MAX_READ })
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let ext = Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let kind = sniff(&ext, &bytes, !too_large);
    let is_text = matches!(kind, Kind::Text | Kind::Markdown | Kind::Svg | Kind::Html);
    Ok(FileContent {
        kind,
        size,
        too_large,
        mtime_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64),
        hash: (is_text && !too_large).then(|| sha256(&bytes)),
        text: (is_text && !too_large).then(|| String::from_utf8_lossy(&bytes).into_owned()),
        data: (kind == Kind::Image && !too_large).then_some(bytes),
    })
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Ticket 820: replaces the text file at `rel` with `text` when its bytes still hash to `hash` (the `file_read` reply's),
/// and returns it as read again. Session folders only, never the data root. Confinement is the read's (`confine::open`):
/// `..`, absolute paths, `.git` and links out are refused. Then the file's own folder is opened and checked the same way
/// and every later step goes through that folder's descriptor (`openat`, `renameat`), so a folder swapped for a link after
/// the check cannot move the write out of the root. A link inside the root is written at its target, never replaced.
/// The write is a temp file in the same folder, given the file's permissions, synced and renamed over it.
pub fn write(root: &Root, rel: &str, text: &str, hash: &str) -> Result<FileContent, String> {
    use std::{
        ffi::CString, io::Write, os::fd::AsRawFd, os::unix::ffi::OsStrExt,
        os::unix::fs::PermissionsExt,
    };
    if !matches!(root, Root::Folder(_)) {
        return Err("path not allowed".into());
    }
    let opened = confine::open(root, rel)?;
    if !opened.file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("not a file".into());
    }
    let folder = opened
        .path
        .parent()
        .and_then(|p| p.strip_prefix(&opened.base).ok())
        .ok_or("outside root")?;
    let dir = confine::open(root, &folder.to_string_lossy())?;
    let name = CString::new(opened.path.file_name().ok_or("not a file")?.as_bytes())
        .map_err(|_| "path not allowed")?;
    let at = |name: &CString, flags: i32, mode: libc::c_uint| {
        // SAFETY: a valid descriptor and a NUL-terminated name; the result is checked before use.
        let fd = unsafe {
            libc::openat(
                dir.file.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: `fd` was just opened and is owned by nothing else.
        Ok(unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd) })
    };
    let current = at(&name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let meta = current.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_EDIT {
        return Err("file is over 512 KiB; it is not edited here".into());
    }
    let bytes = crate::store::read_capped(current, MAX_EDIT).map_err(|e| e.to_string())?;
    let ext = Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // A file the viewer shows as binary, or one with a byte that is not UTF-8 anywhere, would be changed by a save.
    if std::str::from_utf8(&bytes).is_err()
        || !matches!(
            sniff(&ext, &bytes, true),
            Kind::Text | Kind::Markdown | Kind::Svg | Kind::Html
        )
    {
        return Err("not a text file; it is not edited here".into());
    }
    // shortcut: a change between this check and the rename below is not caught (editors share the gap); upgrade with a
    // lease if agents writing the same file mid-save ever loses work.
    if sha256(&bytes) != hash {
        return Err("the file changed on disk since it was opened; nothing was saved".into());
    }
    if text.len() as u64 > MAX_EDIT {
        return Err("the text is over 512 KiB; nothing was saved".into());
    }
    let temp = CString::new(format!(".nunchiro-{}.save", crate::store::new_id()?)).unwrap();
    let mut file = at(&temp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| {
            file.set_permissions(std::fs::Permissions::from_mode(
                meta.permissions().mode() & 0o777,
            ))
        })
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            // SAFETY: one valid folder descriptor and two NUL-terminated names.
            let placed = unsafe {
                libc::renameat(
                    dir.file.as_raw_fd(),
                    temp.as_ptr(),
                    dir.file.as_raw_fd(),
                    name.as_ptr(),
                )
            };
            if placed == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    if let Err(e) = written {
        // SAFETY: as above; a temp that is already gone is no error worth reporting over `e`.
        unsafe { libc::unlinkat(dir.file.as_raw_fd(), temp.as_ptr(), 0) };
        return Err(e.to_string());
    }
    let _ = dir.file.sync_all();
    read(root, rel)
}

/// Content decides (image magic, NUL bytes, UTF-8); the extension only picks among text kinds.
fn sniff(ext: &str, bytes: &[u8], complete: bool) -> Kind {
    let head = &bytes[..bytes.len().min(SNIFF)];
    if head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(&[0xFF, 0xD8, 0xFF])
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
    {
        return Kind::Image;
    }
    let text = match std::str::from_utf8(head) {
        Ok(t) => t,
        // The sniff window can cut a character in half when the file is longer than it.
        Err(e) if e.error_len().is_none() && (!complete || head.len() == SNIFF) => {
            std::str::from_utf8(&head[..e.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return Kind::Binary,
    };
    if head.contains(&0) {
        return Kind::Binary;
    }
    match ext {
        "svg" => Kind::Svg,
        "html" | "htm" => Kind::Html,
        "md" | "markdown" => Kind::Markdown,
        _ if text.trim_start().starts_with("<svg") => Kind::Svg,
        _ => Kind::Text,
    }
}

/// `git status` of one folder, read without writing (no index refresh, no fsmonitor hook).
struct GitView {
    status: HashMap<String, String>,
    ignored: std::collections::HashSet<String>,
    /// The listed folder itself is ignored.
    all_ignored: bool,
    /// The listed folder lies inside an untracked folder.
    all_untracked: bool,
}
impl GitView {
    fn of(dir: &Path) -> Option<Self> {
        let git = |args: &[&str]| crate::process::git_read(dir, args, Duration::from_secs(5)).ok();
        let prefix = String::from_utf8(git(&["rev-parse", "--show-prefix"])?).ok()?;
        let prefix = prefix.trim_end_matches('\n');
        let raw = git(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=matching",
            "--untracked-files=normal",
            "--",
            ".",
        ])?;
        let mut view = Self {
            status: HashMap::new(),
            ignored: Default::default(),
            all_ignored: false,
            all_untracked: false,
        };
        let mut records = raw.split(|b| *b == 0).filter(|r| !r.is_empty());
        while let Some(r) = records.next() {
            let (Some(xy), Some(path)) = (r.get(..2), r.get(3..)) else {
                continue;
            };
            let (x, y) = (xy[0] as char, xy[1] as char);
            if x == 'R' || x == 'C' {
                records.next(); // original path of a rename or copy
            }
            let path = String::from_utf8_lossy(path);
            // A folder that is the listed one or an ancestor of it, wholly ignored or untracked,
            // covers everything listed.
            let covers = path.ends_with('/') && prefix.starts_with(path.as_ref());
            if covers {
                match xy {
                    b"!!" => view.all_ignored = true,
                    b"??" => view.all_untracked = true,
                    _ => {}
                }
                continue;
            }
            let Some(rest) = path.strip_prefix(prefix) else {
                continue;
            };
            let name = rest.split('/').next().unwrap_or("").to_string();
            let exact = rest.trim_end_matches('/') == name;
            if name.is_empty() {
                continue;
            }
            if xy == b"!!" {
                if exact {
                    view.ignored.insert(name);
                }
                continue;
            }
            let letter = if xy == b"??" {
                '?'
            } else if y != ' ' {
                y
            } else {
                x
            };
            view.status
                .entry(name)
                .or_insert_with(|| if exact { letter } else { 'M' }.to_string());
        }
        Some(view)
    }
}
