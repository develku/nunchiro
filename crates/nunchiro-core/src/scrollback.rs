//! v1a-40: a stopped PTY's replay at `$NUNCHIRO_HOME/scrollback/<session id>`, owner-only, at most `REPLAY_BYTES`.
//! v1a-74 (needs 79): written only while the owner keeps history; unredacted (what the terminal showed) unless the
//! owner turned masking on.
use crate::{pty::REPLAY_BYTES, store};
use std::{
    ffi::{CStr, CString},
    fs::{self, File, OpenOptions},
    io::{Read, Seek},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
};

fn path(home: &Path, id: &str) -> Result<PathBuf, String> {
    if !store::valid_id(id) {
        return Err("invalid session id".into());
    }
    Ok(home.join("scrollback").join(id))
}

/// Whether the folder exists; a symlinked one is refused, so nothing is read or removed through it.
fn folder(path: &Path) -> Result<bool, String> {
    match path.parent().unwrap().symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => Err("data folder must not be a symlink".into()),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// v1a-74: `mask` writes `logs::mask` of the replay before the cut, so a cut never leaves half a secret. A full
/// replay may start mid-secret (the ring dropped its head), so a masked save drops its first line (to a `\n` or `\r`).
pub fn save(home: &Path, id: &str, bytes: &[u8], mask: bool) -> Result<(), String> {
    let path = path(home, id)?;
    let masked;
    let bytes = if mask {
        masked = crate::logs::mask(whole_lines(bytes));
        &masked
    } else {
        bytes
    };
    write(&path, bytes)
}

/// A full replay without its first line (to a `\n` or `\r`), which may start mid-secret; a shorter one whole.
fn whole_lines(bytes: &[u8]) -> &[u8] {
    if bytes.len() < REPLAY_BYTES {
        return bytes;
    }
    let from = bytes
        .iter()
        .position(|&b| b == b'\n' || b == b'\r')
        .map_or(bytes.len(), |i| i + 1);
    &bytes[from..]
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    store::private_dir(path.parent().unwrap())?;
    store::atomic_write(path, &bytes[bytes.len().saturating_sub(REPLAY_BYTES)..])
}

/// V1A-74 follow-up: an ended session's saved file, masked in place once the owner turns masking on. A file that
/// does not load (a symlinked folder or file) is an error, never followed; a missing one is left missing.
pub fn remask(home: &Path, id: &str) -> Result<(), String> {
    let Some(bytes) = load(home, id)? else {
        return Ok(());
    };
    write(&path(home, id)?, &mask_again(whole_lines(&bytes))?)
}

/// `logs::mask` of a text that may hold markers of an earlier mask, which keeps them as they are: `logs::mask` alone
/// reads `KEY=[redacted:secret]` as a key whose value stops at `]` and adds a `]` each time. Each marker stands in as
/// a unique word (a value the rules mask like the one it replaced, so a key, header or bearer value around it is still
/// masked whole) and a unique escape (which ends the word, so a key shape after it still starts one). After the
/// mask, word and escape become the marker again; an escape whose word was masked goes.
fn mask_again(text: &[u8]) -> Result<Vec<u8>, String> {
    // Random digits: output cannot forge a stand-in.
    let nonce: String = store::new_id()?
        .bytes()
        .filter(u8::is_ascii_hexdigit)
        .map(|b| char::from(b'0' + b % 10))
        .collect();
    let (word, escape) = (format!("rdct{nonce}x"), format!("\x1b[{nonce};"));
    let mut markers = vec![];
    let mut stood_in = Vec::with_capacity(text.len());
    let mut rest = text;
    while let Some((at, len)) = marker(rest) {
        stood_in.extend_from_slice(&rest[..at]);
        stood_in.extend(format!("{word}{0}{escape}{0}~", markers.len()).bytes());
        markers.push(&rest[at..at + len]);
        rest = &rest[at + len..];
    }
    stood_in.extend_from_slice(rest);
    let masked = crate::logs::mask(&stood_in);
    // `prefix` then a marker's index then `end`: the index and the length.
    let stand_in = |text: &[u8], prefix: &str, end: &[u8]| {
        let after = text.strip_prefix(prefix.as_bytes())?;
        let digits = after.iter().take_while(|b| b.is_ascii_digit()).count();
        let n: usize = std::str::from_utf8(&after[..digits]).ok()?.parse().ok()?;
        (n < markers.len() && after[digits..].starts_with(end))
            .then_some((n, prefix.len() + digits + end.len()))
    };
    let mut out = Vec::with_capacity(masked.len());
    let mut i = 0;
    while i < masked.len() {
        if let Some((n, len)) = stand_in(&masked[i..], &word, b"")
            && let Some((m, end)) = stand_in(&masked[i + len..], &escape, b"~")
            && m == n
        {
            out.extend_from_slice(markers[n]);
            i += len + end;
        } else if let Some((_, end)) = stand_in(&masked[i..], &escape, b"~") {
            i += end;
        } else {
            out.push(masked[i]);
            i += 1;
        }
    }
    Ok(out)
}

/// The kinds `logs` writes in a marker (registered tokens, key and header rules, token shapes). Only these are
/// taken as an earlier marker: text shaped like `[redacted:sk-ant-...]` is output, and is masked like any other.
/// A kind missing here is masked again (fail closed: a stray `]`, never a kept secret).
const KINDS: [&str; 12] = [
    "core",
    "session",
    "window",
    "authorization",
    "secret",
    "bearer",
    "anthropic",
    "openai",
    "github",
    "slack",
    "aws",
    "jwt",
];

/// The first `[redacted:<kind>]` in `text` with a kind of `KINDS`: where it starts and how long it is.
fn marker(text: &[u8]) -> Option<(usize, usize)> {
    const OPEN: &[u8] = b"[redacted:";
    let mut from = 0;
    while let Some(at) = text[from..].windows(OPEN.len()).position(|w| w == OPEN) {
        let at = from + at;
        let rest = &text[at + OPEN.len()..];
        if let Some(kind) = KINDS.iter().find(|kind| {
            rest.strip_prefix(kind.as_bytes())
                .is_some_and(|after| after.first() == Some(&b']'))
        }) {
            return Some((at, OPEN.len() + kind.len() + 1));
        }
        from = at + 1;
    }
    None
}

/// The session ids that have a saved file; a symlinked folder lists nothing (an error).
pub fn saved_ids(home: &Path) -> Result<Vec<String>, String> {
    let Some(folder) = open_folder(home)? else {
        return Ok(vec![]);
    };
    Ok(names(&folder)?
        .into_iter()
        .filter_map(|name| name.into_string().ok())
        .filter(|name| store::valid_id(name))
        .collect())
}

/// `None` when nothing was saved; a symlinked folder or file is refused, never followed.
pub fn load(home: &Path, id: &str) -> Result<Option<Vec<u8>>, String> {
    let path = path(home, id)?;
    if !folder(&path)? {
        return Ok(None);
    }
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("scrollback is not a file".into());
    }
    // Like the replay, an oversize file keeps its newest bytes.
    file.seek(std::io::SeekFrom::Start(
        meta.len().saturating_sub(REPLAY_BYTES as u64),
    ))
    .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(REPLAY_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(Some(bytes))
}

pub fn remove(home: &Path, id: &str) -> Result<(), String> {
    let path = path(home, id)?;
    if !folder(&path)? {
        return Ok(());
    }
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Removes every file in the folder whose name `keep` refuses (an id with no open row, a leftover temp file);
/// failures are logged. A symlinked folder is left alone, and a symlink inside is removed, never followed.
pub fn sweep(home: &Path, keep: impl Fn(&str) -> bool) {
    match open_folder(home) {
        Ok(Some(folder)) => sweep_in(&folder, keep),
        Ok(None) => {}
        Err(e) => eprintln!("scrollback sweep: {e}"),
    }
}

/// v1b-38 (V1A-40 review): the folder opened once without following a link; the sweep lists and deletes through
/// this handle, so a folder swapped for a symlink after the open cannot redirect a delete.
fn open_folder(home: &Path) -> Result<Option<File>, String> {
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(home.join("scrollback"))
    {
        Ok(folder) => Ok(Some(folder)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            Err("data folder must not be a symlink".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn sweep_in(folder: &File, keep: impl Fn(&str) -> bool) {
    let names = match names(folder) {
        Ok(names) => names,
        Err(e) => return eprintln!("scrollback sweep: {e}"),
    };
    for name in names {
        if name.to_str().is_ok_and(&keep) {
            continue;
        }
        // unlinkat without AT_REMOVEDIR removes a link itself and refuses a folder.
        if unsafe { libc::unlinkat(folder.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            let e = std::io::Error::last_os_error();
            eprintln!("scrollback sweep {}: {e}", name.to_string_lossy());
        }
    }
}

/// The entry names of an open folder, read from a duplicate of its handle.
pub(crate) fn names(folder: &File) -> Result<Vec<CString>, String> {
    let fd = unsafe { libc::fcntl(folder.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
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
    // The duplicate shares the read offset; start from the top whatever read it before.
    unsafe { libc::rewinddir(stream.0) };
    let mut names = vec![];
    loop {
        unsafe { *libc::__error() = 0 };
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(0) {
                return Err(e.to_string());
            }
            return Ok(names);
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name != c"." && name != c".." {
            names.push(name.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("scrollback-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn an_id_that_is_not_a_file_name_is_refused() {
        let home = home("id");
        for id in ["../x", "a/b", "", "/abs"] {
            assert!(save(&home, id, b"x", false).is_err(), "{id}");
            assert!(load(&home, id).is_err(), "{id}");
            assert!(remove(&home, id).is_err(), "{id}");
        }
        assert!(!home.join("x").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_symlinked_file_is_not_read() {
        let home = home("link");
        fs::write(home.join("secret"), b"secret").unwrap();
        save(&home, "s1", b"ok", false).unwrap();
        assert_eq!(load(&home, "s1").unwrap().as_deref(), Some(&b"ok"[..]));
        fs::remove_file(home.join("scrollback/s1")).unwrap();
        std::os::unix::fs::symlink(home.join("secret"), home.join("scrollback/s1")).unwrap();
        assert!(load(&home, "s1").is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn nothing_is_removed_through_a_symlinked_folder() {
        let home = home("rmlink");
        fs::create_dir(home.join("elsewhere")).unwrap();
        fs::write(home.join("elsewhere/s1"), b"keep").unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), home.join("scrollback")).unwrap();
        assert!(remove(&home, "s1").is_err());
        assert!(home.join("elsewhere/s1").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn sweep_never_follows_a_symlinked_folder() {
        let home = home("sweeplink");
        fs::create_dir(home.join("elsewhere")).unwrap();
        fs::write(home.join("elsewhere/x"), b"keep").unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), home.join("scrollback")).unwrap();
        sweep(&home, |_| false);
        assert!(home.join("elsewhere/x").exists());
        let _ = fs::remove_dir_all(&home);
    }

    // v1b-38 (V1A-40 review): the sweep goes through the folder it opened, so a swap after the check is harmless.
    #[test]
    fn sweep_after_a_folder_swap_deletes_nothing_elsewhere() {
        let home = home("sweepswap");
        save(&home, "s1", b"x", false).unwrap();
        save(&home, "keep", b"x", false).unwrap();
        let opened = open_folder(&home).unwrap().unwrap();
        fs::rename(home.join("scrollback"), home.join("moved")).unwrap();
        fs::create_dir(home.join("elsewhere")).unwrap();
        fs::write(home.join("elsewhere/s1"), b"keep").unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), home.join("scrollback")).unwrap();
        sweep_in(&opened, |id| id == "keep");
        assert!(home.join("elsewhere/s1").exists());
        assert!(!home.join("moved/s1").exists());
        assert!(home.join("moved/keep").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn sweep_removes_a_symlink_inside_not_its_target() {
        let home = home("sweepinner");
        save(&home, "keep", b"x", false).unwrap();
        fs::write(home.join("target"), b"keep").unwrap();
        std::os::unix::fs::symlink(home.join("target"), home.join("scrollback/link")).unwrap();
        fs::write(home.join("scrollback/.tmp-1"), b"x").unwrap();
        sweep(&home, |id| id == "keep");
        assert!(home.join("target").exists());
        assert!(home.join("scrollback/link").symlink_metadata().is_err());
        assert!(!home.join("scrollback/.tmp-1").exists());
        assert!(home.join("scrollback/keep").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_oversize_file_loads_its_newest_bytes() {
        let home = home("big");
        save(&home, "s1", b"x", false).unwrap();
        let mut big = vec![b'o'; 10];
        big.extend(vec![b'n'; REPLAY_BYTES]);
        fs::write(home.join("scrollback/s1"), &big).unwrap();
        assert_eq!(
            load(&home, "s1").unwrap().unwrap(),
            vec![b'n'; REPLAY_BYTES]
        );
        let _ = fs::remove_dir_all(&home);
    }

    // V1A-74 follow-up acceptance 5 (threat 4): masking an ended row's file in place; twice equals once, the file
    // stays within REPLAY_BYTES, and a symlinked file or folder is refused, never followed or written through.
    #[test]
    fn mask_rewrite_is_idempotent_and_bounded() {
        let home = home("remask");
        let line = b"API_KEY=hunter2plainvalue Authorization: Bearer abcdefgh12345678 sk-ant-TEST0000000000abcdef\n";
        let mut plain = b"tail of a secret: ant-TEST0000000000abcdef\n".to_vec();
        plain.extend(line.repeat(REPLAY_BYTES / line.len() + 1));
        save(&home, "s1", &plain, false).unwrap();
        assert_eq!(load(&home, "s1").unwrap().unwrap().len(), REPLAY_BYTES);
        remask(&home, "s1").unwrap();
        let once = load(&home, "s1").unwrap().unwrap();
        assert!(once.len() <= REPLAY_BYTES);
        for secret in [&b"hunter2"[..], b"abcdefgh1234", b"TEST0000"] {
            assert!(!once.windows(secret.len()).any(|w| w == secret));
        }
        assert!(
            once.ends_with(b"API_KEY=[redacted:secret] Authorization: [redacted:authorization]\n")
        );
        remask(&home, "s1").unwrap();
        assert_eq!(load(&home, "s1").unwrap().unwrap(), once);
        // A short file is masked whole, with no line dropped; again, twice equals once.
        save(&home, "s2", b"first API_KEY=hunter2plainvalue\nok\n", false).unwrap();
        remask(&home, "s2").unwrap();
        let once = load(&home, "s2").unwrap().unwrap();
        assert_eq!(once, b"first API_KEY=[redacted:secret]\nok\n");
        remask(&home, "s2").unwrap();
        assert_eq!(load(&home, "s2").unwrap().unwrap(), once);
        // Security review: a marker the terminal printed never cuts a key, header or bearer value off its secret.
        for (n, line) in [
            &b"password=\"[redacted:x] hunter2plainvalue\"\n"[..],
            b"Authorization: [redacted:x] Basic aHVudGVyMnBsYWlu\n",
            b"curl -H 'X: Bearer [redacted:x]hunter2plainvalue'\n",
            b"[redacted:x]sk-ant-TEST0000000000abcdef\n",
        ]
        .iter()
        .enumerate()
        {
            let id = format!("p{n}");
            save(&home, &id, line, false).unwrap();
            remask(&home, &id).unwrap();
            let once = load(&home, &id).unwrap().unwrap();
            for secret in [&b"hunter2"[..], b"aHVudGVy", b"TEST0000", b"\x1b"] {
                assert!(!once.windows(secret.len()).any(|w| w == secret), "{n}");
            }
            remask(&home, &id).unwrap();
            assert_eq!(load(&home, &id).unwrap().unwrap(), once, "{n}");
        }
        // Nothing saved: nothing written.
        remask(&home, "none").unwrap();
        assert!(!home.join("scrollback/none").exists());
        // A symlinked file.
        fs::write(home.join("target"), b"API_KEY=hunter2plainvalue\n").unwrap();
        fs::remove_file(home.join("scrollback/s1")).unwrap();
        std::os::unix::fs::symlink(home.join("target"), home.join("scrollback/s1")).unwrap();
        assert!(remask(&home, "s1").is_err());
        assert_eq!(
            fs::read(home.join("target")).unwrap(),
            b"API_KEY=hunter2plainvalue\n"
        );
        assert!(
            home.join("scrollback/s1")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // A symlinked folder.
        let other = super::tests::home("remask-elsewhere");
        fs::create_dir(other.join("scrollback")).unwrap();
        fs::write(other.join("scrollback/s1"), b"API_KEY=hunter2plainvalue\n").unwrap();
        fs::rename(home.join("scrollback"), home.join("moved")).unwrap();
        std::os::unix::fs::symlink(other.join("scrollback"), home.join("scrollback")).unwrap();
        assert!(remask(&home, "s1").is_err());
        assert!(saved_ids(&home).is_err());
        assert_eq!(
            fs::read(other.join("scrollback/s1")).unwrap(),
            b"API_KEY=hunter2plainvalue\n"
        );
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&other);
    }

    // Round 2 review: only the kinds `logs` writes are kept as earlier markers; a secret dressed as one is masked.
    #[test]
    fn remask_does_not_trust_secret_shaped_marker() {
        let home = home("remask-shaped");
        for (n, (line, secret)) in [
            (
                &b"[redacted:sk-ant-TEST0000000000abcdef]\n"[..],
                &b"TEST0000"[..],
            ),
            (
                b"[redacted:ghp_abcdefghijklmnopqrstuvwxyz0123456789]\n",
                b"ghp_abcdefgh",
            ),
            (
                b"key [redacted:sk-ant-TEST0000000000abcdef] [redacted:secret]\n",
                b"TEST0000",
            ),
        ]
        .iter()
        .enumerate()
        {
            let id = format!("s{n}");
            save(&home, &id, line, false).unwrap();
            remask(&home, &id).unwrap();
            let once = load(&home, &id).unwrap().unwrap();
            assert!(!once.windows(secret.len()).any(|w| w == *secret), "{n}");
            assert!(once.windows(10).any(|w| w == b"[redacted:"), "{n}");
            remask(&home, &id).unwrap();
            assert_eq!(load(&home, &id).unwrap().unwrap(), once, "{n}");
        }
        // Every kind `logs` writes is kept as it is.
        let kept: Vec<u8> = KINDS
            .iter()
            .flat_map(|kind| format!("x [redacted:{kind}] y\n").into_bytes())
            .collect();
        save(&home, "kinds", &kept, false).unwrap();
        remask(&home, "kinds").unwrap();
        assert_eq!(load(&home, "kinds").unwrap().unwrap(), kept);
        let _ = fs::remove_dir_all(&home);
    }

    // v1a-74: masked before the cut, so a secret across the REPLAY_BYTES boundary never leaves its tail; a full
    // replay's first line may itself start mid-secret, so a masked save drops it.
    #[test]
    fn mask_then_cut_at_the_1mib_boundary() {
        let home = home("maskcut");
        let secret = b"sk-ant-TEST0000000000abcdef";
        for k in 1..secret.len() {
            let mut bytes = vec![b'x'; 100];
            bytes.push(b'\n');
            bytes.extend(secret);
            bytes.push(b' ');
            bytes.extend(vec![b'y'; REPLAY_BYTES + k - secret.len() - 1]);
            assert_eq!(bytes.len() - REPLAY_BYTES, 101 + k);
            save(&home, "s1", &bytes, false).unwrap();
            let plain = load(&home, "s1").unwrap().unwrap();
            assert!(plain.starts_with(&secret[k..]), "{k}");
            save(&home, "s1", &bytes, true).unwrap();
            let masked = load(&home, "s1").unwrap().unwrap();
            assert!(masked.len() <= REPLAY_BYTES);
            assert!(!masked.starts_with(&secret[k..]), "{k}");
            assert!(
                !masked.windows(4).any(|w| w == b"TEST" || w == b"cdef"),
                "{k}"
            );
        }
        let mut full = secret[3..].to_vec();
        full.extend(b" tail\n");
        full.resize(REPLAY_BYTES, b'z');
        save(&home, "s1", &full, true).unwrap();
        let masked = load(&home, "s1").unwrap().unwrap();
        assert!(!masked.windows(4).any(|w| w == b"cdef"));
        assert!(masked.starts_with(b"zzz"));
        // A replay drawn with carriage returns only (a progress bar) still keeps all but its first line.
        let mut bar = secret[3..].to_vec();
        bar.extend(b" 1%\r");
        bar.resize(REPLAY_BYTES, b'z');
        save(&home, "s1", &bar, true).unwrap();
        let masked = load(&home, "s1").unwrap().unwrap();
        assert!(!masked.windows(4).any(|w| w == b"cdef"));
        assert!(masked.starts_with(b"zzz"));
        let _ = fs::remove_dir_all(&home);
    }
}
