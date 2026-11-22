//! Approval-v1 hash, preserving the published sorted path/content/execute-bit encoding.
//! v1b-17: immutable bytes and fd-relative O_NOFOLLOW traversal beneath the trusted home.
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path},
};
#[cfg(test)]
thread_local! {static READS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};}
#[cfg(test)]
pub(crate) fn read_count() -> usize {
    READS.with(|n| n.get())
}
const MAX_FILES: usize = 2000;
const MAX_BYTES: u64 = 32 * 1024 * 1024;
#[derive(Debug)]
pub struct SnapshotFile {
    path: String,
    bytes: Vec<u8>,
    executable: bool,
}
impl SnapshotFile {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn executable(&self) -> bool {
        self.executable
    }
}
fn openat(dir: &File, name: &str, flags: i32) -> Result<File, String> {
    let name = CString::new(name).map_err(|e| e.to_string())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(format!(
            "unsafe path or symlink: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn directory(home: &Path, relative: &Path) -> Result<File, String> {
    // The home is trusted configuration; links there are supported. Subjects are not trusted.
    let home = home.canonicalize().map_err(|e| e.to_string())?;
    let mut dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(home)
        .map_err(|e| e.to_string())?;
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                dir = openat(
                    &dir,
                    name.to_str().ok_or("non-UTF-8 path")?,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                )?
            }
            _ => return Err("unsafe approval path".into()),
        }
    }
    Ok(dir)
}
pub fn folder(home: &Path, relative: &Path) -> Result<(String, Vec<SnapshotFile>), String> {
    let dir = directory(home, relative)?;
    let mut files = vec![];
    let mut total = 0;
    walk(&dir, "", 0, &mut total, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hash = Sha256::new();
    hash.update(b"nunchiro-approval-v1\0");
    for f in &files {
        hash.update((f.path.len() as u64).to_be_bytes());
        hash.update(f.path.as_bytes());
        hash.update([f.executable as u8]);
        hash.update((f.bytes.len() as u64).to_be_bytes());
        hash.update(&f.bytes);
    }
    Ok((
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        files,
    ))
}
/// V2-4a: an `agents.toml` entry, length-prefixed field by field, so no two entries share a hash.
pub fn entry(e: &crate::acp::config::Entry) -> String {
    let mut hash = Sha256::new();
    hash.update(b"nunchiro-agent-v1\0");
    let mut field = |s: &str| {
        hash.update((s.len() as u64).to_be_bytes());
        hash.update(s.as_bytes());
    };
    field(&e.name);
    field(&e.command);
    for list in [&e.args, &e.env] {
        field(&list.len().to_string());
        list.iter().for_each(|s| field(s));
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
/// Ticket 259: a setup script's text, length-prefixed and tagged so it never shares a hash with another subject's.
pub fn text(s: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"nunchiro-setup-v1\0");
    hash.update((s.len() as u64).to_be_bytes());
    hash.update(s.as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
/// Ticket 1002 lane 2: the one hash of an outward tool call, shared by the Outbox card (`nunchiro outbox stage`), the
/// core's spend check (`Request::OutboxSpend`) and the seat's hook: the tool name and the arguments as canonical JSON
/// (object keys sorted, no whitespace), length-prefixed and tagged. Any changed byte of either is another call.
pub fn outward_call_hash(tool: &str, args: &serde_json::Value) -> String {
    fn canon(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::Value::String(k.clone()).to_string());
                    out.push(':');
                    canon(&map[k], out);
                }
                out.push('}');
            }
            serde_json::Value::Array(list) => {
                out.push('[');
                for (i, x) in list.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    canon(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut json = String::new();
    canon(args, &mut json);
    let mut hash = Sha256::new();
    hash.update(b"nunchiro-outward-call-v1\0");
    for s in [tool, json.as_str()] {
        hash.update((s.len() as u64).to_be_bytes());
        hash.update(s.as_bytes());
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
fn walk(
    dir: &File,
    prefix: &str,
    depth: usize,
    total: &mut u64,
    files: &mut Vec<SnapshotFile>,
) -> Result<(), String> {
    if depth > 64 {
        return Err("widget folder nesting exceeds limit".into());
    }
    for name in names(dir, usize::MAX)? {
        let name = name.as_str();
        let file = openat(dir, name, libc::O_RDONLY)?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if prefix.is_empty() && name == "cache" && meta.is_dir() {
            continue;
        }
        let rel = format!("{prefix}{name}");
        if meta.is_dir() {
            walk(&file, &format!("{rel}/"), depth + 1, total, files)?;
        } else if meta.is_file() {
            if files.len() >= MAX_FILES {
                return Err("widget folder has too many files".into());
            }
            let executable = meta.permissions().mode() & 0o111 != 0;
            let mut bytes = vec![];
            #[cfg(test)]
            READS.with(|n| n.set(n.get() + 1));
            file.take(MAX_BYTES.saturating_sub(*total) + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            *total += bytes.len() as u64;
            if *total > MAX_BYTES {
                return Err("widget folder is too large".into());
            }
            files.push(SnapshotFile {
                path: rel,
                bytes,
                executable,
            });
        } else {
            return Err(format!("{rel} is not a regular file"));
        }
    }
    Ok(())
}

fn names(dir: &File, limit: usize) -> Result<Vec<String>, String> {
    let mut names = vec![];
    let fd = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(std::io::Error::last_os_error().to_string());
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let stream = Stream(stream);
    loop {
        // Clear errno so an I/O error cannot silently truncate the approved folder.
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                return Err(std::io::Error::last_os_error().to_string());
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| "non-UTF-8 file name")?;
        if name == "." || name == ".." {
            continue;
        }
        if names.len() >= limit {
            return Err("approval folder metadata exceeds limit".into());
        }
        names.push(name.to_string());
    }
    Ok(names)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileStamp {
    path: String,
    device: i32,
    inode: u64,
    size: i64,
    mode: u16,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
pub(crate) fn metadata(home: &Path, relative: &Path) -> Result<Vec<FileStamp>, String> {
    let dir = directory(home, relative)?;
    let mut stamps = vec![];
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(dir.as_raw_fd(), &mut stat) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    stamps.push(file_stamp("".into(), &stat));
    metadata_walk(&dir, "", 0, &mut stamps)?;
    stamps.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(stamps)
}
fn file_stamp(path: String, stat: &libc::stat) -> FileStamp {
    let directory = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
    FileStamp {
        path,
        device: stat.st_dev,
        inode: stat.st_ino,
        size: if directory { 0 } else { stat.st_size },
        mode: stat.st_mode,
        mtime: if directory {
            (0, 0)
        } else {
            (stat.st_mtime, stat.st_mtime_nsec)
        },
        ctime: if directory {
            (0, 0)
        } else {
            (stat.st_ctime, stat.st_ctime_nsec)
        },
    }
}
fn metadata_walk(
    dir: &File,
    prefix: &str,
    depth: usize,
    out: &mut Vec<FileStamp>,
) -> Result<(), String> {
    if depth > 64 || out.len() > MAX_FILES * 2 {
        return Err("approval folder metadata exceeds limit".into());
    }
    for name in names(dir, (MAX_FILES * 2).saturating_sub(out.len()) + 1)? {
        let c_name = CString::new(name.as_bytes()).map_err(|e| e.to_string())?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                c_name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let kind = stat.st_mode & libc::S_IFMT;
        if kind == libc::S_IFDIR && prefix.is_empty() && name == "cache" {
            continue;
        }
        if kind != libc::S_IFDIR && kind != libc::S_IFREG {
            return Err("approval subject contains a symlink or special file".into());
        }
        let path = format!("{prefix}{name}");
        if out.len() >= MAX_FILES * 2 {
            return Err("approval folder metadata exceeds limit".into());
        }
        out.push(file_stamp(path.clone(), &stat));
        if kind == libc::S_IFDIR {
            metadata_walk(
                &openat(dir, &name, libc::O_RDONLY | libc::O_DIRECTORY)?,
                &format!("{path}/"),
                depth + 1,
                out,
            )?;
        }
    }
    Ok(())
}
