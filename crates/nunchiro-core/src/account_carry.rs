//! Ticket 451 step 2: a conversation continues on another account. Claude Code finds a conversation only by its record
//! file, `<config folder>/projects/<folder name>/<conversation id>.jsonl` (checked on 2.1.322: with the file there it goes
//! on to the login, without it "No conversation found"), so the record is copied into the other account's folder, at the
//! same place, before the session resumes there. The old account keeps its copy; nothing is moved or deleted.
//!
//! What is trusted: the two folders come from the account registry or the user's own config folder, never from a
//! request; the id is `store::valid_id`. Below the folders nothing is followed: every step down is `openat` with
//! `O_NOFOLLOW`, the record must be a regular file, and the copy is made under a temporary name and linked into place, so
//! a half copy never has the final name. A record already there is replaced only by a longer copy of itself (Q9
//! psn-J25-1: carried back after turns on the other account); any other one is left as it is.
use crate::dirfd::{c, dir_at, entries, open_at};
use std::{ffi::CString, fs::File, io, os::fd::AsRawFd, path::Path};

/// More than any conversation record seen (the largest on the owner's machines is under 100 MiB).
const MAX_RECORD: u64 = 1 << 30;
/// Project folders looked at for the record before giving up.
const MAX_FOLDERS: usize = 20_000;
const PROJECTS: &str = "projects";

/// The names of the folders in `dir` (links and files left out), at most `MAX_FOLDERS`.
fn folders(dir: &File) -> Result<Vec<CString>, String> {
    let all = entries(dir, MAX_FOLDERS, |t| t == libc::DT_DIR)?;
    Ok(all.into_iter().map(|(name, _)| name).collect())
}

/// True when the first `len` bytes of `long` are the whole of `short` (`len` is `short`'s length); a read error or a
/// file shorter than that is false.
fn begins_with(long: &File, short: &File, len: u64) -> bool {
    use std::os::unix::fs::FileExt;
    let (mut a, mut b) = (vec![0; 1 << 16], vec![0; 1 << 16]);
    let mut at = 0;
    while at < len {
        let n = (len - at).min(a.len() as u64) as usize;
        if long.read_exact_at(&mut a[..n], at).is_err()
            || short.read_exact_at(&mut b[..n], at).is_err()
            || a[..n] != b[..n]
        {
            return false;
        }
        at += n as u64;
    }
    true
}

/// Copies the record of Claude conversation `id` from config folder `from` to config folder `to`. Ok when the record is
/// in `to` afterwards: copied now, or there already. One there already is replaced when the source is that record with
/// more turns after it, else left as it is.
pub(crate) fn claude(from: &Path, to: &Path, id: &str) -> Result<(), String> {
    if !crate::store::valid_id(id) {
        return Err("invalid resume session id".into());
    }
    let file = c(std::ffi::OsStr::new(&format!("{id}.jsonl")))?;
    let projects = c(std::ffi::OsStr::new(PROJECTS))?;
    let gone = || "this conversation's record was not found on the account it ran on".to_string();
    let source_root = File::open(from).map_err(|_| gone())?;
    let source_projects = dir_at(&source_root, &projects, false).map_err(|_| gone())?;
    let mut found = None;
    for name in folders(&source_projects)? {
        let Ok(folder) = dir_at(&source_projects, &name, false) else {
            continue;
        };
        // Only a regular file is the record: a FIFO or a folder under that name is passed over.
        if let Ok(record) = open_at(&folder, &file, libc::O_RDONLY | libc::O_NONBLOCK, 0)
            && record.metadata().is_ok_and(|m| m.is_file())
        {
            found = Some((name, record));
            break;
        }
    }
    let (name, mut record) = found.ok_or_else(gone)?;
    let meta = record.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(gone());
    }
    if meta.len() > MAX_RECORD {
        return Err("this conversation's record is too large to copy".into());
    }
    let linked = |e: io::Error| {
        format!("the other account's projects folder could not be used ({e}); nothing was copied")
    };
    let target_root =
        File::open(to).map_err(|_| "the other account's folder was not found".to_string())?;
    let target_projects = dir_at(&target_root, &projects, true).map_err(linked)?;
    let target = dir_at(&target_projects, &name, true).map_err(linked)?;
    // There already (continued here before). A link or anything else under that name is refused: the resume would
    // read through it.
    let mut held: libc::stat = unsafe { std::mem::zeroed() };
    let exists = unsafe {
        libc::fstatat(
            target.as_raw_fd(),
            file.as_ptr(),
            &mut held,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0;
    if exists {
        if held.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err("the other account holds something that is not a record under this conversation's name; nothing was copied".into());
        }
        // Q9 psn-J25-1: the copy there is an older part of this record (carried there, then continued here): it is
        // replaced, or the resume would lack these turns. Otherwise it may hold turns of its own, so it stays.
        let older = open_at(&target, &file, libc::O_RDONLY | libc::O_NONBLOCK, 0)
            .ok()
            // A different file swapped in meanwhile fails the same-record check before the rename.
            .filter(|f| f.metadata().is_ok_and(|m| m.is_file()));
        let len = held.st_size as u64;
        if !(meta.len() > len && older.is_some_and(|older| begins_with(&record, &older, len))) {
            return Ok(());
        }
    }
    let temp = c(std::ffi::OsStr::new(&format!(
        ".{id}.{}.carry",
        crate::store::new_id()?
    )))?;
    let mut copy = open_at(
        &target,
        &temp,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .map_err(|e| e.to_string())?;
    let remove_temp = || unsafe { libc::unlinkat(target.as_raw_fd(), temp.as_ptr(), 0) };
    let written = io::copy(&mut io::Read::take(&mut record, MAX_RECORD), &mut copy)
        .and_then(|_| copy.sync_all());
    if let Err(e) = written {
        remove_temp();
        return Err(format!(
            "the conversation's record could not be copied: {e}"
        ));
    }
    let placed = if exists {
        // Replaced only while it is still the record compared above: one written to meanwhile stays.
        let mut now: libc::stat = unsafe { std::mem::zeroed() };
        let same = unsafe {
            libc::fstatat(
                target.as_raw_fd(),
                file.as_ptr(),
                &mut now,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
            && (now.st_ino, now.st_size, now.st_mtime, now.st_mtime_nsec)
                == (held.st_ino, held.st_size, held.st_mtime, held.st_mtime_nsec);
        if !same {
            remove_temp();
            return Ok(());
        }
        unsafe {
            libc::renameat(
                target.as_raw_fd(),
                temp.as_ptr(),
                target.as_raw_fd(),
                file.as_ptr(),
            )
        }
    } else {
        // A link, not a rename: a record that appeared meanwhile is never replaced.
        unsafe {
            libc::linkat(
                target.as_raw_fd(),
                temp.as_ptr(),
                target.as_raw_fd(),
                file.as_ptr(),
                0,
            )
        }
    };
    let error = (placed != 0).then(io::Error::last_os_error);
    remove_temp();
    match error {
        None => Ok(()),
        Some(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Some(e) => Err(format!(
            "the conversation's record could not be copied: {e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink, path::PathBuf};

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    fn roots(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("carry-{tag}-{}", crate::store::new_id().unwrap()));
        let (from, to) = (base.join("from"), base.join("to"));
        fs::create_dir_all(from.join("projects/-work-app")).unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(
            from.join(format!("projects/-work-app/{ID}.jsonl")),
            "one\ntwo\n",
        )
        .unwrap();
        (base, from, to)
    }
    fn there(to: &Path) -> PathBuf {
        to.join(format!("projects/-work-app/{ID}.jsonl"))
    }

    #[test]
    fn copies_the_record_to_the_same_place_and_keeps_the_source() {
        let (base, from, to) = roots("copy");
        claude(&from, &to, ID).unwrap();
        assert_eq!(fs::read_to_string(there(&to)).unwrap(), "one\ntwo\n");
        assert_eq!(fs::read_to_string(there(&from)).unwrap(), "one\ntwo\n");
        // Owner only, and no temporary name is left.
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(there(&to)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let names: Vec<_> = fs::read_dir(to.join("projects/-work-app"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_record_already_there_is_left_as_it_is() {
        let (base, from, to) = roots("kept");
        fs::create_dir_all(to.join("projects/-work-app")).unwrap();
        fs::write(there(&to), "one\ntwo\nthree, written on this account\n").unwrap();
        claude(&from, &to, ID).unwrap();
        assert_eq!(
            fs::read_to_string(there(&to)).unwrap(),
            "one\ntwo\nthree, written on this account\n"
        );
        fs::remove_dir_all(base).unwrap();
    }

    // Q9 psn-J25-1: carried A to B, continued on B, carried back to A: A's older copy gets B's turns.
    #[test]
    fn an_older_part_of_the_record_there_is_replaced_by_the_longer_one() {
        let (base, from, to) = roots("back");
        fs::create_dir_all(to.join("projects/-work-app")).unwrap();
        fs::write(there(&to), "one\n").unwrap();
        claude(&from, &to, ID).unwrap();
        assert_eq!(fs::read_to_string(there(&to)).unwrap(), "one\ntwo\n");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(there(&to)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let names = fs::read_dir(to.join("projects/-work-app")).unwrap().count();
        assert_eq!(names, 1, "no temporary name is left");
        // A copy there that went its own way (not a beginning of the source) stays.
        fs::write(there(&to), "one\nthree\n").unwrap();
        claude(&from, &to, ID).unwrap();
        assert_eq!(fs::read_to_string(there(&to)).unwrap(), "one\nthree\n");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refuses_a_bad_id_a_missing_record_and_links() {
        let (base, from, to) = roots("refuse");
        assert!(claude(&from, &to, "../x").is_err());
        assert!(
            claude(&from, &to, "99999999-2222-4333-8444-555555555555")
                .unwrap_err()
                .contains("not found")
        );
        assert!(!to.join("projects").exists(), "a refusal makes nothing");
        // The record is a link to a file elsewhere: not read.
        let secret = base.join("secret");
        fs::write(&secret, "elsewhere").unwrap();
        let record = there(&from);
        fs::remove_file(&record).unwrap();
        symlink(&secret, &record).unwrap();
        assert!(claude(&from, &to, ID).unwrap_err().contains("not found"));
        // A link under the record's name in the target is refused, not read through.
        fs::remove_file(&record).unwrap();
        fs::write(&record, "one\n").unwrap();
        fs::create_dir_all(to.join("projects/-work-app")).unwrap();
        symlink(&secret, there(&to)).unwrap();
        assert!(claude(&from, &to, ID).unwrap_err().contains("not a record"));
        fs::remove_dir_all(to.join("projects")).unwrap();
        // A folder named like the record in an earlier project folder is passed over; the real record is found.
        fs::create_dir_all(from.join(format!("projects/-a-first/{ID}.jsonl"))).unwrap();
        claude(&from, &to, ID).unwrap();
        assert_eq!(fs::read_to_string(there(&to)).unwrap(), "one\n");
        fs::remove_dir_all(to.join("projects")).unwrap();
        fs::remove_dir_all(from.join("projects/-a-first")).unwrap();
        // The target's projects folder is a link to a folder elsewhere: nothing is written through it.
        fs::remove_file(&record).unwrap();
        fs::write(&record, "one\n").unwrap();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, to.join("projects")).unwrap();
        assert!(
            claude(&from, &to, ID)
                .unwrap_err()
                .contains("nothing was copied")
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(base).unwrap();
    }
}
