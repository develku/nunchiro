//! Descending a folder tree by directory descriptor with `O_NOFOLLOW` at every step, so a link planted anywhere on the
//! way is never followed (ticket 451 step 2 `account_carry`, ticket 452 `extensions`).
use std::{
    ffi::{CStr, CString, OsStr},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
};

pub(crate) fn c(name: &OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes()).map_err(|_| "invalid name".to_string())
}

pub(crate) fn open_at(
    dir: &File,
    name: &CStr,
    flags: libc::c_int,
    mode: libc::c_uint,
) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// The folder `name` under `dir`, never through a link; with `create`, made (owner only) when it is not there.
pub(crate) fn dir_at(dir: &File, name: &CStr, create: bool) -> io::Result<File> {
    if create {
        let made = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
        if made != 0 {
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::AlreadyExists {
                return Err(e);
            }
        }
    }
    open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
}

/// The names and `d_type`s of the entries in `dir` that `keep` takes, at most `max` of them.
pub(crate) fn entries(
    dir: &File,
    max: usize,
    keep: impl Fn(u8) -> bool,
) -> Result<Vec<(CString, u8)>, String> {
    // A second descriptor: `fdopendir` owns the one it is given.
    let fd = unsafe { libc::dup(dir.as_raw_fd()) };
    if fd < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(io::Error::last_os_error().to_string());
    }
    let mut out = vec![];
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() || out.len() >= max {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let kind = unsafe { (*entry).d_type };
        if keep(kind) && !matches!(name.to_bytes(), b"." | b"..") {
            out.push((name.to_owned(), kind));
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(out)
}
