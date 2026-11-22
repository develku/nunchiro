//! Ticket 253 (G22; needs 197): what a new worktree shares with its project. The owner lists paths per project (core
//! `features` key `worktree.shared`: project path -> `Shared`), each linked (the default: a secret then has one copy,
//! widget-check G22) or copied from the project root, plus an optional sparse checkout preset. A create (never a restore)
//! applies them right after `git worktree add`; one path that fails is named in the reply and never fails the create.
//!
//! A path stays inside the project: relative, no `..` or `.git` part, and its source resolves (links followed) under the
//! project root. Nothing is written over what git checked out, and no folder on the way may be a link. The paths copied
//! are recorded in the worktree's git folder, so the loss check lists a copy as an untracked file and never excuses it.
//! Shapes after Orca's worktree shared paths (src/main/ipc/worktree-symlinks.ts: skip a missing source, never replace a
//! target that is there, dereference a copy's source) and sparse presets (`git sparse-checkout set --cone`), MIT License,
//! Copyright (c) 2026 Lovecast Inc.; no code taken (theirs is Node with APFS clones and a copy budget).
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub const FEATURE: &str = "worktree.shared";
/// The most files, and the most sparse folders, one project lists.
pub const MAX: usize = 32;
/// In the worktree's git folder (git removes it with the worktree): the paths a create copied, one per line.
const RECORD: &str = "nunchiro-copied";
const RECORD_MAX: u64 = 64 * 1024;
const OUTSIDE: &str = "is outside the project";
const GIT: Duration = Duration::from_secs(10);
/// Copies run under worktrees.lock (Codex look, round 2): at most this per file, and `COPY_TOTAL` per create.
pub const COPY_MAX: u64 = 10 << 20;
pub const COPY_TOTAL: u64 = 50 << 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Link,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    #[serde(default)]
    pub mode: Mode,
}

/// One project's values.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Shared {
    pub files: Vec<File>,
    pub sparse: Vec<String>,
}

/// `path` as plain relative parts: never absolute, empty, `..`, `.git` (any case), a leading `-` or a control character.
pub fn rel(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    let plain = |c: Component| matches!(c, Component::Normal(n) if !n.eq_ignore_ascii_case(".git"));
    (!path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('-')
        && !path.chars().any(char::is_control)
        && p.components().all(plain))
    .then(|| p.to_path_buf())
}

/// `path` in the canonical `root`: `None` when nothing is there, else where it resolves with links followed, which must be
/// inside `root` (not `root` itself, not its `.git`).
fn resolve(root: &Path, path: &str) -> Result<Option<PathBuf>, &'static str> {
    let source = root.join(rel(path).ok_or(OUTSIDE)?);
    match fs::canonicalize(&source) {
        Ok(real) => match real.strip_prefix(root) {
            Ok(inner)
                if inner.components().all(
                    |c| matches!(c, Component::Normal(n) if !n.eq_ignore_ascii_case(".git")),
                ) && inner.components().next().is_some() =>
            {
                Ok(Some(real))
            }
            _ => Err(OUTSIDE),
        },
        // A link to nothing (or past an unreadable folder) could point anywhere later: refused, never followed.
        Err(_) if fs::symlink_metadata(&source).is_ok() => Err("is a link that does not resolve"),
        Err(_) => Ok(None),
    }
}

/// The save-time check (`quit_settings`): each project's lists within `MAX` and every path inside its project.
pub fn check(value: &serde_json::Value) -> Result<(), String> {
    let map: BTreeMap<String, Shared> =
        serde_json::from_value(value.clone()).map_err(|e| format!("invalid {FEATURE}: {e}"))?;
    for (project, s) in &map {
        if s.files.len() > MAX || s.sparse.len() > MAX {
            return Err(format!(
                "{FEATURE}: at most {MAX} files and {MAX} folders per project"
            ));
        }
        // A project folder that is not there (yet) gets the plain-path check alone; a create checks again.
        let root = fs::canonicalize(project).unwrap_or_else(|_| PathBuf::from(project));
        for p in s.files.iter().map(|f| &f.path).chain(&s.sparse) {
            resolve(&root, p).map_err(|e| format!("shared path {p:?} {e}"))?;
        }
    }
    Ok(())
}

/// The project's values from `settings.json` in `home` (keyed by the project path as the window lists it, or canonical).
fn stored(home: &Path, project: &Path) -> Shared {
    let map = crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v.get("features")?.get(FEATURE)?.clone()).ok());
    crate::worktree_setup::for_project(map, project)
}

/// After a create's `git worktree add` of `worktree`: the sparse preset, then each shared path. Returns what failed, each
/// as `<path>: <reason>`; nothing here fails the create.
pub(crate) fn apply(
    home: &Path,
    project: &Path,
    worktree: &Path,
    timeout: Duration,
) -> Vec<String> {
    let s = stored(home, project);
    let mut failed = vec![];
    let Ok(root) = fs::canonicalize(project) else {
        return failed;
    };
    // A hand-edited settings file is held to the save-time limit too.
    let (files, sparse) = (
        &s.files[..s.files.len().min(MAX)],
        &s.sparse[..s.sparse.len().min(MAX)],
    );
    if !sparse.is_empty() {
        match sparse.iter().find(|f| resolve(&root, f).is_err()) {
            Some(f) => failed.push(format!("sparse checkout: {f} {OUTSIDE}")),
            None => {
                let mut args = vec!["sparse-checkout", "set", "--cone", "--"];
                args.extend(sparse.iter().map(String::as_str));
                // The checkout helper: no hook, no filter but lfs, scrubbed environment (ticket 403).
                if let Err(e) = crate::process::git_worktree_add(worktree, &args, timeout) {
                    failed.push(format!("sparse checkout: {e}"));
                }
            }
        }
    }
    // Recorded before any copy is made, so a copy is never left that the loss check does not know.
    let copies: Vec<&str> = files
        .iter()
        .filter(|f| f.mode == Mode::Copy && rel(&f.path).is_some())
        .map(|f| f.path.as_str())
        .collect();
    let recorded = copies.is_empty() || record(worktree, &copies).is_ok();
    let mut budget = COPY_TOTAL;
    for f in files {
        let result = if f.mode == Mode::Copy && !recorded {
            Err("could not record the copy, so it was not made".into())
        } else {
            share(&root, worktree, f, &mut budget)
        };
        if let Err(e) = result {
            failed.push(format!("{}: {e}", f.path));
        }
    }
    failed
}

/// One shared path into `worktree`; nothing to do when the project has no such path or the worktree has it already.
fn share(root: &Path, worktree: &Path, f: &File, budget: &mut u64) -> Result<(), String> {
    let Some(real) = resolve(root, &f.path)? else {
        return Ok(());
    };
    let rel = rel(&f.path).ok_or(OUTSIDE)?;
    let target = worktree.join(&rel);
    // Never over what git checked out (or anything else there): the worktree's own file wins.
    if fs::symlink_metadata(&target).is_ok() {
        return Ok(());
    }
    folders(worktree, rel.parent())?;
    // The folder made or found is still the worktree's own (no link swapped in on the way since `folders`).
    let parent = target.parent().ok_or(OUTSIDE)?;
    if fs::canonicalize(parent).ok()
        != fs::canonicalize(worktree)
            .ok()
            .map(|w| w.join(rel.parent().unwrap_or(Path::new(""))))
    {
        return Err("a folder on its way in the worktree changed while it was shared".into());
    }
    match f.mode {
        // The link names the project's path, not where it resolves: the loss check knows it by that.
        Mode::Link => symlink(root.join(&rel), &target).map_err(|e| e.to_string()),
        Mode::Copy => {
            let src = open_source(root, &real)?;
            copy(src, &target, budget)
        }
    }
}

/// The checked source of a copy, opened: its last part never followed (`O_NOFOLLOW`), and the file held is the one at
/// `real` inside `root` after the open (same device and inode), so a path swapped for a link meanwhile is refused.
fn open_source(root: &Path, real: &Path) -> Result<fs::File, String> {
    let file = crate::store::open_regular(real).map_err(|e| match e.kind() {
        io::ErrorKind::InvalidInput => "Copy is for files; use Link for a folder".to_string(),
        _ => e.to_string(),
    })?;
    same_file(&file, root, real)?;
    Ok(file)
}
/// Whether the open `file` is the one at `real`, which still resolves to itself inside `root`.
fn same_file(file: &fs::File, root: &Path, real: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    const CHANGED: &str = "changed while it was shared, so it was not copied";
    let held = file.metadata().map_err(|e| e.to_string())?;
    let now = fs::symlink_metadata(real).map_err(|_| CHANGED)?;
    let still = fs::canonicalize(real).is_ok_and(|r| r == real && r.starts_with(root));
    if !still || (held.dev(), held.ino()) != (now.dev(), now.ino()) {
        return Err(CHANGED.into());
    }
    Ok(())
}

/// The folders on the way to a shared path, made as needed; one there that is a link (a checked-out symlink could point
/// anywhere) or a file refuses.
fn folders(worktree: &Path, parent: Option<&Path>) -> Result<(), String> {
    let mut at = worktree.to_path_buf();
    for part in parent.into_iter().flat_map(Path::components) {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err("a folder on its way in the worktree is a file or a link".into()),
            Err(_) => fs::create_dir(&at).map_err(|e| e.to_string())?,
        }
    }
    Ok(())
}

/// `src`'s bytes and permission bits into a new file at `to` (`create_new` and `O_NOFOLLOW`: never over anything, never
/// through a link), within `COPY_MAX` and what is left of the create's `budget`. Any failure removes what was written.
fn copy(src: fs::File, to: &Path, budget: &mut u64) -> Result<(), String> {
    use io::Read;
    let meta = src.metadata().map_err(|e| e.to_string())?;
    let limit = COPY_MAX.min(*budget);
    let over = |size: u64| {
        if size > COPY_MAX {
            format!("is over the {} MiB copy limit; use Link", COPY_MAX >> 20)
        } else {
            format!(
                "would pass the {} MiB a create copies in all; use Link",
                COPY_TOTAL >> 20
            )
        }
    };
    if meta.len() > limit {
        return Err(over(meta.len()));
    }
    let mut dst = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(meta.permissions().mode() & 0o777)
        .open(to)
        .map_err(|e| e.to_string())?;
    // One byte past the limit tells a file that grew since its size was read.
    let copied = io::copy(&mut src.take(limit + 1), &mut dst)
        .map_err(|e| e.to_string())
        .and_then(|n| if n > limit { Err(over(n)) } else { Ok(n) });
    match copied {
        Ok(n) => {
            *budget -= n;
            Ok(())
        }
        Err(e) => {
            drop(dst);
            let _ = fs::remove_file(to);
            Err(e)
        }
    }
}

fn git_dir(worktree: &Path) -> Option<PathBuf> {
    let out = crate::process::git_read(worktree, &["rev-parse", "--absolute-git-dir"], GIT).ok()?;
    Some(PathBuf::from(String::from_utf8(out).ok()?.trim()))
}
fn record(worktree: &Path, copies: &[&str]) -> Result<(), String> {
    let dir = git_dir(worktree).ok_or("no git folder")?;
    crate::store::atomic_write(&dir.join(RECORD), copies.join("\n").as_bytes())
}

/// The loss check's half (`worktree_clean::loss`): whether `rel` in `worktree` is a link a create made, to the project's
/// own path, so removing it loses nothing.
pub(crate) fn linked(worktree: &Path, root: Option<&Path>, rel: &str) -> bool {
    let (Some(root), Some(r)) = (root, self::rel(rel.trim_end_matches('/'))) else {
        return false;
    };
    fs::read_link(worktree.join(&r)).is_ok_and(|to| to == root.join(&r))
}

/// Before a remove: each of `rels` that is still a create's link to the project's own path is unlinked (never followed).
pub(crate) fn unlink(worktree: &Path, project: &Path, rels: &[String]) {
    let root = fs::canonicalize(project).ok();
    for r in rels.iter().filter(|r| linked(worktree, root.as_deref(), r)) {
        let _ = fs::remove_file(worktree.join(r.trim_end_matches('/')));
    }
}

/// The loss check's other half: the copies a create made that are still untracked files (not links) in `worktree`.
pub(crate) fn copies(worktree: &Path) -> Vec<String> {
    let Some(text) = git_dir(worktree)
        .and_then(|d| crate::store::open_regular(&d.join(RECORD)).ok())
        .and_then(|f| crate::store::read_capped(f, RECORD_MAX).ok())
        .and_then(|b| String::from_utf8(b).ok())
    else {
        return vec![];
    };
    let there: Vec<&str> = text
        .lines()
        .filter(|p| rel(p).is_some())
        .filter(|p| fs::symlink_metadata(worktree.join(p)).is_ok_and(|m| m.is_file()))
        .collect();
    if there.is_empty() {
        return vec![];
    }
    // A copy committed since is the branch's file now, not a loss.
    let mut args = vec!["ls-files", "-z", "--cached", "--"];
    args.extend(there.iter().copied());
    let tracked = crate::process::git_read(worktree, &args, GIT).unwrap_or_default();
    let tracked: Vec<&[u8]> = tracked.split(|b| *b == 0).collect();
    there
        .into_iter()
        .filter(|p| !tracked.contains(&p.as_bytes()))
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    // Codex look, round 2: a source swapped for a link to an outside file between the check and the open is refused,
    // since the file held is not the one at the checked path.
    #[test]
    fn copy_source_swapped_after_check_is_refused() {
        let dir = std::env::temp_dir().join(format!("nunchiro-wtsh-{}", std::process::id()));
        let root = dir.join("project");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        fs::write(root.join(".env"), "in").unwrap();
        fs::write(dir.join("outside"), "out").unwrap();
        let real = resolve(&root, ".env").unwrap().unwrap();
        assert!(open_source(&root, &real).is_ok());
        // What a swap leaves: the handle is the outside file, the checked path another file.
        let outside = fs::File::open(dir.join("outside")).unwrap();
        assert!(
            same_file(&outside, &root, &real)
                .unwrap_err()
                .contains("changed")
        );
        fs::remove_file(&real).unwrap();
        symlink(dir.join("outside"), &real).unwrap();
        assert!(
            open_source(&root, &real).is_err(),
            "a link in the last part is never followed"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
