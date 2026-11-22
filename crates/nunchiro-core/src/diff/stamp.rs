//! Ticket 463: a stamp of what a folder's git state depends on, read from the file system without starting git, so a
//! window's periodic read is answered again only after something changed. The core has no file watcher; git's own
//! untracked cache uses the same signals (each tracked file's stat, folder times for new files).
use std::{
    collections::{BTreeSet, hash_map::DefaultHasher},
    ffi::OsStr,
    hash::{Hash, Hasher},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

/// The folder that holds `dir`'s `.git` (a folder, or a file in a linked worktree or submodule).
pub(crate) fn top(dir: &Path) -> Option<&Path> {
    dir.ancestors()
        .find(|a| a.join(".git").symlink_metadata().is_ok())
}

/// The same value while nothing `dir`'s git answers read has changed: HEAD and the ref it names, the index, packed
/// and origin's refs, a local main and master, a fetch, the config and excludes, every tracked file, `listed` (paths
/// relative to `dir`, the untracked files a list showed), and every folder from each of those up to the top. Outside any repository, only a
/// new `.git` above changes it. `None` when the repository cannot be read this way (a SHA-256 object format, a
/// split index, an index this reader does not know): the caller asks git each time.
pub(crate) fn stamp<'a>(dir: &Path, listed: impl IntoIterator<Item = &'a str>) -> Option<u64> {
    let mut h = DefaultHasher::new();
    let Some(top) = top(dir) else {
        "outside".hash(&mut h);
        return Some(h.finish());
    };
    let (gitdir, common) = git_dirs(top)?;
    let config = std::fs::read(common.join("config")).unwrap_or_default();
    if config
        .to_ascii_lowercase()
        .windows(12)
        .any(|w| w == b"objectformat")
    {
        return None;
    }
    let mut paths: Vec<PathBuf> = ["HEAD", "index"]
        .iter()
        .map(|p| gitdir.join(p))
        .chain(
            [
                "config",
                "packed-refs",
                "FETCH_HEAD",
                "info/exclude",
                "refs/remotes/origin",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
                "refs/remotes/origin/master",
                // Ticket 501: the git facts count a branch's commits ahead of a local main or master.
                "refs/heads/main",
                "refs/heads/master",
            ]
            .iter()
            .map(|p| common.join(p)),
        )
        .collect();
    let head = std::fs::read_to_string(gitdir.join("HEAD")).unwrap_or_default();
    // Security r2/r3 (501): a hand-made HEAD's `..` or absolute part never leaves the git dir.
    if let Some(r) = head
        .trim()
        .strip_prefix("ref: ")
        .filter(|r| inside(Path::new(r)))
    {
        paths.push(common.join(r));
        // Ticket 501 review: a push rewrites origin's ref of the branch, a folder below the stamped one when the name
        // has a slash (feature/x). `refs/heads//abs` passes the check above, so the branch part is checked too.
        if let Some(b) = r.strip_prefix("refs/heads/")
            && inside(Path::new(b))
        {
            paths.push(common.join("refs/remotes/origin").join(b));
        }
    }
    let tracked = match std::fs::read(gitdir.join("index")) {
        Ok(index) => index_paths(&index)?,
        // A repository where nothing was added yet has no index.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(_) => return None,
    };
    let mut folders = BTreeSet::from([top.to_path_buf(), dir.to_path_buf()]);
    let files = tracked
        .iter()
        .map(|p| Path::new(OsStr::from_bytes(p)))
        .filter(|p| inside(p))
        .map(|p| top.join(p))
        .chain(listed.into_iter().map(|p| dir.join(p)));
    for file in files {
        // Every folder up to the top: a new file in a folder that holds only folders changes that folder's time. The
        // walk stops at a folder already stamped, so each folder costs one insert.
        let mut parent = file.parent();
        while let Some(p) = parent.filter(|p| p.starts_with(top) && folders.insert(p.to_path_buf()))
        {
            parent = p.parent();
        }
        paths.push(file);
    }
    paths.extend(folders);
    for p in &paths {
        p.hash(&mut h);
        meta(p).hash(&mut h);
    }
    Some(h.finish())
}

/// What a path's stat says about a change to it; `None` when it is gone.
fn meta(p: &Path) -> Option<(i64, i64, i64, i64, u64, u64, u32)> {
    p.symlink_metadata().ok().map(|m| {
        (
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
            m.size(),
            m.ino(),
            m.mode(),
        )
    })
}

/// Q9 pop-J25-1: one file's `meta` as a number a JavaScript number holds exactly (53 bits); `None` when it is gone.
pub(crate) fn file(p: &Path) -> Option<u64> {
    let mut h = DefaultHasher::new();
    meta(p)?.hash(&mut h);
    Some(h.finish() >> 11)
}

/// Follow-ups 1112: an index path that stays under the top when joined to it: relative, with no `..` part. Git never
/// writes another kind; one in a hand-made index would make the stamp stat files outside the worktree.
fn inside(p: &Path) -> bool {
    p.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// The repository folder of the worktree at `top` and the common folder its refs live in.
fn git_dirs(top: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot = top.join(".git");
    let gitdir = if dot.is_dir() {
        dot
    } else {
        // A linked worktree or submodule: `gitdir: <path>`, relative to `top` when not absolute.
        let text = std::fs::read_to_string(&dot).ok()?;
        top.join(text.trim().strip_prefix("gitdir: ")?)
    };
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(text) => gitdir.join(text.trim()),
        Err(_) => gitdir.clone(),
    };
    Some((gitdir, common))
}

/// The paths of an index file (format versions 2 to 4, SHA-1), relative to the worktree's top. `None` for anything
/// else, and for a split index, whose entries are partly in another file.
fn index_paths(b: &[u8]) -> Option<Vec<Vec<u8>>> {
    let word = |at: usize| Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize);
    if b.get(..4)? != b"DIRC" {
        return None;
    }
    let version = word(4)?;
    if !(2..=4).contains(&version) {
        return None;
    }
    let count = word(8)?;
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(count.min(1 << 20));
    let mut at = 12;
    for _ in 0..count {
        let start = at;
        // 40 bytes of stat data, a 20-byte object name, 16 bits of flags (an extended flag adds 16 more in v3+).
        let flags = u16::from_be_bytes(b.get(at + 60..at + 62)?.try_into().ok()?);
        at += 62;
        if version >= 3 && flags & 0x4000 != 0 {
            at += 2;
        }
        let path = if version == 4 {
            // The previous path less `strip` bytes at its end, then this entry's NUL-ended rest; no padding.
            let (strip, n) = varint(b.get(at..)?)?;
            at += n;
            let end = at + b.get(at..)?.iter().position(|c| *c == 0)?;
            let prev = out.last().map_or(&[][..], Vec::as_slice);
            let mut p = prev.get(..prev.len().checked_sub(strip)?)?.to_vec();
            p.extend_from_slice(&b[at..end]);
            at = end + 1;
            p
        } else {
            // NUL-padded to a multiple of 8 from the entry's start, at least one NUL.
            let end = at + b.get(at..)?.iter().position(|c| *c == 0)?;
            let p = b[at..end].to_vec();
            at = start + (end - start + 8) / 8 * 8;
            p
        };
        out.push(path);
    }
    // Extensions, then the 20-byte checksum.
    while at + 8 <= b.len().checked_sub(20)? {
        if b.get(at..at + 4)? == b"link" {
            return None;
        }
        at += 8 + word(at + 4)?;
    }
    Some(out)
}

/// Git's offset varint (varint.c `decode_varint`): the value and the bytes it took.
fn varint(b: &[u8]) -> Option<(usize, usize)> {
    let mut c = *b.first()?;
    let mut value = (c & 127) as usize;
    let mut n = 1;
    while c & 128 != 0 {
        c = *b.get(n)?;
        n += 1;
        value = value.checked_add(1)?.checked_mul(128)? | (c & 127) as usize;
    }
    Some((value, n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Reply, Request};

    fn repo(name: &str) -> (PathBuf, impl Fn(&[&str]) -> Vec<u8>) {
        let top = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("stamp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        std::fs::create_dir_all(top.join("src")).unwrap();
        let dir = top.clone();
        let git = move |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
            out.stdout
        };
        git(&["init", "-q", "-b", "main"]);
        (top, git)
    }

    /// The paths read from the index are `git ls-files`' in each index version, a long shared prefix (v4) included.
    #[test]
    fn index_paths_match_ls_files() {
        let (top, git) = repo("index");
        for n in 0..30 {
            let name = format!("src/{}{n}.rs", "a_rather_long_shared_prefix_".repeat(n % 3));
            std::fs::write(top.join(name), "x\n").unwrap();
        }
        std::fs::write(top.join("é ü.txt"), "x\n").unwrap();
        git(&["add", "-A"]);
        let check = |version: &str| {
            git(&["update-index", "--index-version", version]);
            let index = std::fs::read(top.join(".git/index")).unwrap();
            assert_eq!(&index[4..8], &version.parse::<u32>().unwrap().to_be_bytes());
            let want: Vec<Vec<u8>> = git(&["ls-files", "-z"])
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .map(<[u8]>::to_vec)
                .collect();
            assert_eq!(index_paths(&index), Some(want), "index version {version}");
        };
        check("2");
        // `-N` sets the extended flag (intent to add): version 3 entries carry 2 more bytes, and git keeps 3 or 4.
        std::fs::write(top.join("later.txt"), "x\n").unwrap();
        git(&["add", "-N", "later.txt"]);
        check("3");
        check("4");
        // A split index keeps entries in another file: not read here.
        git(&["update-index", "--split-index"]);
        assert_eq!(
            index_paths(&std::fs::read(top.join(".git/index")).unwrap()),
            None
        );
        assert_eq!(index_paths(b"DIRC\0\0\0\x09"), None);
        std::fs::remove_dir_all(&top).unwrap();
    }

    /// Review r1 (ticket 501): a push on a branch with a slash rewrites only `refs/remotes/origin/feature/x`, a folder
    /// below the stamped `refs/remotes/origin`; the Diff dock's ahead count must follow it.
    #[test]
    fn a_push_on_a_slash_branch_changes_the_stamp() {
        let (top, git) = repo("push");
        let remote = top.with_extension("remote");
        let _ = std::fs::remove_dir_all(&remote);
        git(&["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&["checkout", "-q", "-b", "feature/x"]);
        git(&["push", "-q", "-u", "origin", "feature/x"]);
        git(&["commit", "-q", "--allow-empty", "-m", "ahead"]);
        let before = stamp(&top, []);
        assert!(before.is_some());
        git(&["push", "-q"]);
        assert_ne!(stamp(&top, []), before, "a push was not seen");
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&remote).unwrap();
    }

    /// Security r2 (ticket 501): a hand-made HEAD whose branch has a `..` or an absolute part never makes the stamp
    /// look at a file outside the git dir through origin's ref of that branch.
    #[test]
    fn a_head_branch_outside_the_git_dir_is_skipped() {
        let (top, git) = repo("headout");
        let top = top.canonicalize().unwrap();
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let outside = top.with_file_name(format!(
            "{}-out",
            top.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("f.txt");
        std::fs::write(&target, "x\n").unwrap();
        let name = outside.file_name().unwrap().to_string_lossy().into_owned();
        // A repository with a remote has this folder; the kernel resolves `..` only through folders that exist.
        std::fs::create_dir_all(top.join(".git/refs/remotes/origin")).unwrap();
        // `.git/refs/remotes/origin/` and five `..` is the folder above the top; `.git/refs/heads/` and five is one
        // more up, where nothing is, so only the origin ref could reach the target.
        for b in [
            format!("../../../../../{name}/f.txt"),
            format!("/{}", target.display()),
        ] {
            std::fs::write(top.join(".git/HEAD"), format!("ref: refs/heads/{b}\n")).unwrap();
            let before = stamp(&top, []);
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(&target, format!("changed for {b}\n")).unwrap();
            assert_eq!(stamp(&top, []), before, "the stamp read {b}");
        }
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// Each change the window's counts and list must follow changes the stamp; nothing changing keeps it.
    #[test]
    fn stamp_follows_each_change() {
        let (top, git) = repo("follow");
        std::fs::write(top.join("src/a.rs"), "a\n").unwrap();
        std::fs::write(top.join("src/b.rs"), "b\n").unwrap();
        std::fs::create_dir_all(top.join("crates/one/src")).unwrap();
        std::fs::write(top.join("crates/one/src/lib.rs"), "1\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "start"]);
        std::fs::write(top.join("notes.md"), "draft\n").unwrap();
        let listed = ["notes.md"];
        let now = || stamp(&top, listed).unwrap();
        let mut last = now();
        assert_eq!(now(), last, "nothing changed");
        let changed = |what: &str, last: &mut u64| {
            let s = now();
            assert_ne!(s, *last, "{what}");
            *last = s;
        };
        // An in-place edit of a clean tracked file (an append keeps its folder's time).
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(top.join("src/b.rs"))
            .unwrap()
            .write_all(b"more\n")
            .unwrap();
        changed("edit of a clean file", &mut last);
        std::fs::write(top.join("notes.md"), "draft 2\n").unwrap();
        changed("edit of a listed untracked file", &mut last);
        std::fs::write(top.join("src/new.rs"), "n\n").unwrap();
        changed("new untracked file", &mut last);
        // Round 2: `crates/` holds only folders, so no tracked file has it as its own folder.
        std::fs::create_dir_all(top.join("crates/two/src")).unwrap();
        std::fs::write(top.join("crates/two/src/lib.rs"), "2\n").unwrap();
        changed("new folder in a folder that holds only folders", &mut last);
        git(&["add", "src/b.rs"]);
        changed("stage", &mut last);
        git(&["commit", "-q", "-m", "more"]);
        changed("commit", &mut last);
        git(&["switch", "-q", "-c", "other"]);
        changed("branch switch", &mut last);
        assert_eq!(now(), last, "nothing changed");
        std::fs::remove_dir_all(&top).unwrap();
    }

    /// Follow-ups 1112: an index entry naming an absolute path or one with a `..` part is skipped, so the stamp never
    /// stats outside the worktree. Git refuses such entries; a hand-edited index can hold them.
    #[test]
    fn index_entries_outside_the_top_are_skipped() {
        let (top, git) = repo("outside");
        // The test folder's path holds `..`; the stand-ins below need the plain one.
        let top = top.canonicalize().unwrap();
        let outside = top.with_file_name(format!(
            "{}-out",
            top.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("f.txt");
        std::fs::write(&target, "x\n").unwrap();
        // Same-length stand-ins, renamed in the index bytes below: `x<abs path>` becomes `/<abs path>`, and
        // `xx/<name>-out/f.txt` becomes `../<name>-out/f.txt`.
        let abs = target.to_string_lossy().into_owned();
        let abs_stand = format!("x{}", &abs[1..]);
        let up = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        let up_stand = format!("xx/{}/f.txt", &up[3..]);
        let up = format!("{up}/f.txt");
        for stand in [&abs_stand, &up_stand] {
            std::fs::create_dir_all(top.join(stand).parent().unwrap()).unwrap();
            std::fs::write(top.join(stand), "x\n").unwrap();
        }
        std::fs::write(top.join("src/a.rs"), "a\n").unwrap();
        // `-f`: the absolute stand-in runs through `.scratch/`, which an owner's global excludes may name.
        git(&["add", "-f", "--", &abs_stand, &up_stand, "src/a.rs"]);
        git(&["update-index", "--index-version", "2"]);
        let mut index = std::fs::read(top.join(".git/index")).unwrap();
        for (stand, real) in [(&abs_stand, &abs), (&up_stand, &up)] {
            let at = index
                .windows(stand.len())
                .position(|w| w == stand.as_bytes())
                .unwrap();
            index[at..at + stand.len()].copy_from_slice(real.as_bytes());
        }
        std::fs::write(top.join(".git/index"), &index).unwrap();
        let paths = index_paths(&index).unwrap();
        assert!(
            paths.contains(&abs.clone().into_bytes()) && paths.contains(&up.clone().into_bytes())
        );
        let before = stamp(&top, []).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&target, "changed outside\n").unwrap();
        std::fs::write(outside.join("new.txt"), "n\n").unwrap();
        assert_eq!(
            stamp(&top, []).unwrap(),
            before,
            "nothing outside the top is stamped"
        );
        assert!(
            inside(Path::new("src/a.rs"))
                && inside(Path::new("a..b/c"))
                && inside(Path::new("./a"))
        );
        assert!(
            !inside(Path::new("/etc/hosts"))
                && !inside(Path::new("a/../../b"))
                && !inside(Path::new(".."))
        );
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// Ticket 512 (501 security r3): a hand-made HEAD naming a ref with a `..` part or an absolute ref is not stamped,
    /// so the stamp never stats outside the git folder.
    #[test]
    fn head_ref_outside_the_git_dir_is_skipped() {
        let (top, _git) = repo("headref");
        let top = top.canonicalize().unwrap();
        let outside = top.with_file_name(format!(
            "{}-ref",
            top.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("x");
        std::fs::write(&target, "x\n").unwrap();
        let up = format!("../../{}/x", outside.file_name().unwrap().to_string_lossy());
        for r in [up, target.to_string_lossy().into_owned()] {
            std::fs::write(top.join(".git/HEAD"), format!("ref: {r}\n")).unwrap();
            let before = stamp(&top, []).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(&target, format!("changed {r}\n")).unwrap();
            assert_eq!(stamp(&top, []).unwrap(), before, "{r} is not stamped");
        }
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// A list kept from its stamp follows an edit of a file that had no change, a new untracked file and an edit of
    /// that file once it is listed.
    #[test]
    fn kept_list_follows_an_edit() {
        let (top, git) = repo("kept");
        std::fs::write(top.join("src/a.rs"), "a\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "start"]);
        let base = Some(crate::diff::start(&top));
        let list = || {
            let request = Request::DiffList {
                session: "s".into(),
                scope: crate::diff::Scope::Session,
                git: false,
                fresh: false,
            };
            match crate::diff::run(top.clone(), base.clone(), request) {
                Ok(Reply::Diff { files, .. }) => files
                    .into_iter()
                    .map(|c| format!("{} +{}", c.path, c.additions.unwrap_or_default()))
                    .collect::<Vec<_>>(),
                r => panic!("{r:?}"),
            }
        };
        assert!(list().is_empty());
        assert!(list().is_empty());
        std::fs::write(top.join("src/a.rs"), "a\nb\n").unwrap();
        assert_eq!(list(), ["src/a.rs +1"]);
        std::fs::write(top.join("notes.md"), "one\n").unwrap();
        assert_eq!(list(), ["notes.md +1", "src/a.rs +1"]);
        assert_eq!(list(), ["notes.md +1", "src/a.rs +1"]);
        std::fs::write(top.join("notes.md"), "one\ntwo\n").unwrap();
        assert_eq!(list(), ["notes.md +2", "src/a.rs +1"]);
        std::fs::remove_dir_all(&top).unwrap();
    }

    /// Round 2: a list a person asked for (`fresh`: Diff opened, Refresh) runs git while the stamp holds; the timer's
    /// is answered from the kept list.
    #[test]
    fn fresh_list_reads_git_while_the_stamp_holds() {
        let (top, git) = repo("fresh");
        std::fs::write(top.join("src/a.rs"), "a\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "start"]);
        let base = Some(crate::diff::start(&top));
        let list = |fresh: bool| {
            let request = Request::DiffList {
                session: "s".into(),
                scope: crate::diff::Scope::Session,
                git: false,
                fresh,
            };
            match crate::diff::run(top.clone(), base.clone(), request) {
                Ok(Reply::Diff { files, .. }) => {
                    files.into_iter().map(|c| c.path).collect::<Vec<_>>()
                }
                r => panic!("{r:?}"),
            }
        };
        std::fs::write(top.join("src/a.rs"), "a\nb\n").unwrap();
        assert_eq!(list(false), ["src/a.rs"]);
        // Empty the kept list, so an answer from it shows.
        let key = (top.clone(), base.clone(), false);
        crate::diff::LISTS
            .lock()
            .unwrap()
            .get_mut(&key)
            .unwrap()
            .files
            .clear();
        assert!(
            list(false).is_empty(),
            "the timer's read is answered from the kept list"
        );
        assert_eq!(list(true), ["src/a.rs"], "a fresh read runs git");
        // Round 3: the fresh read replaces the kept list, so the timer's next read does not bring the old one back.
        assert_eq!(
            list(false),
            ["src/a.rs"],
            "the plain read after a fresh one"
        );
        std::fs::remove_dir_all(&top).unwrap();
    }
}
