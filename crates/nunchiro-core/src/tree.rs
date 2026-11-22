//! V2-9a: `tree.toml`, the project groups, pins and fold state of the project tree, stored per machine and served to
//! the window. Project paths are only strings here: never opened, stat-ed or joined. A malformed file is refused and
//! left as it is; a file of another version is set aside (V1B-40) and the core starts with an empty tree.
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

const VERSION: i64 = 1;
/// Ticket 880: the folder is there but the app may not read it (a removable volume without its macOS access grant).
pub const NO_ACCESS: &str = "no access to that folder";

#[cfg(test)]
thread_local! {
    pub(crate) static IN_DISK_CHECK: std::cell::Cell<Option<Box<dyn FnOnce()>>> = const { std::cell::Cell::new(None) };
}
/// Why `add` refuses a typed folder, or None. `is_dir()` is false for any stat error, so a permission refusal said
/// "not a folder" for a folder that exists; the listing is tried too, since a stat can pass where reading the folder cannot.
/// EACCES is the folder's owner or mode, which System Settings cannot fix, so it is said by name (as a refused start
/// says it, `sessions::FILE_MODE`); EPERM is macOS privacy (`NO_ACCESS`).
fn add_refusal(project: &Path) -> Option<String> {
    #[cfg(test)]
    if let Some(hook) = IN_DISK_CHECK.take() {
        hook(); // Q9 en-b-J6-2: a test stalls the check as a hung mount would
    }
    let denied = |e: &std::io::Error| -> Option<String> {
        match e.raw_os_error() {
            Some(libc::EACCES) => Some(format!("no permission to read {}", project.display())),
            _ if e.kind() == std::io::ErrorKind::PermissionDenied => Some(NO_ACCESS.into()),
            _ => None,
        }
    };
    match fs::metadata(project) {
        Ok(m) if !m.is_dir() => Some("not a folder".into()),
        Ok(_) => fs::read_dir(project).err().and_then(|e| denied(&e)),
        Err(e) => Some(denied(&e).unwrap_or_else(|| "not a folder".into())),
    }
}
/// Ticket 1040: what Settings > Projects says about a project's folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderState {
    Ok,
    /// Not there, and its disk is.
    Missing,
    /// On an external disk that is not mounted: nothing to locate, the disk comes back.
    Offline,
    /// EPERM or EACCES: the folder may be there, the app may not read it.
    NoAccess,
}
/// Codex note on lane w87: how long Settings > Projects waits on one folder's check.
pub const FOLDER_CHECK_BOUND: std::time::Duration = std::time::Duration::from_secs(2);
/// Test only: folders whose check stalls, as on a hung mount, until the test takes them out.
#[cfg(test)]
pub(crate) static STALLED: std::sync::Mutex<BTreeSet<std::path::PathBuf>> =
    std::sync::Mutex::new(BTreeSet::new());
/// Stats `project`: callers run it off the registry lock, as `TreeEdit::checked` (a stalled mount holds only its own request).
pub fn folder_state(project: &Path) -> FolderState {
    folder_state_in(project, Path::new("/Volumes"))
}
/// Codex security look on w91: folder-check threads alive at once, across every connection. A check holds its place until
/// its filesystem call returns (a hung mount keeps it), not until its caller stops waiting.
pub const MAX_FOLDER_CHECKS: usize = 4;
/// The folders whose check thread still runs: the per-path dedupe and the `MAX_FOLDER_CHECKS` count in one set.
static RUNNING: std::sync::Mutex<BTreeSet<std::path::PathBuf>> =
    std::sync::Mutex::new(BTreeSet::new());
/// Test only: the folder-state tests share `RUNNING`, so they take turns.
#[cfg(test)]
pub(crate) static CHECKS_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// `folder_state` on its own thread, waited on for at most `bound`: a disk that does not answer reads as offline. A folder
/// whose check still runs is not checked again, and with `MAX_FOLDER_CHECKS` checks running none starts: either reads as
/// offline at once and is tried again on the next read, so a hung mount holds at most that many threads.
pub fn folder_state_within(project: &Path, bound: std::time::Duration) -> FolderState {
    bounded(project, bound, FolderState::Offline, folder_state)
}
/// Lane w96: a Locate whose picked folder's disk did not answer in `FOLDER_CHECK_BOUND` (shown as written, projects.tsx).
pub(crate) const DISK_SILENT: &str = "That folder's disk did not answer. Try again.";
/// Lane w96: Locate's disk check (`located`) on the same bounded checks; a disk that does not answer refuses the Locate.
pub fn located_within(to: &str) -> Result<String, String> {
    let busy = Err(DISK_SILENT.to_string());
    bounded(Path::new(to), FOLDER_CHECK_BOUND, busy, |p| {
        located(p.to_str().unwrap_or_default())
    })
}
/// `check` of `project` on its own thread in a `RUNNING` place, waited on for at most `bound`; `busy` when it is not
/// started or not done in time.
fn bounded<T: Clone + Send + 'static>(
    project: &Path,
    bound: std::time::Duration,
    busy: T,
    check: impl FnOnce(&Path) -> T + Send + 'static,
) -> T {
    // The thread-local stall hook is this caller's: it marks the disk check reached (the registry-lock tests).
    #[cfg(test)]
    if let Some(hook) = IN_DISK_CHECK.take() {
        hook();
    }
    let running = || RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut set = running();
        if set.len() >= MAX_FOLDER_CHECKS || !set.insert(project.into()) {
            return busy;
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let path = project.to_path_buf();
    let spawned = std::thread::Builder::new().spawn(move || {
        let state = check(&path);
        running().remove(&path);
        let _ = tx.send(state);
    });
    if spawned.is_err() {
        running().remove(project);
        return busy;
    }
    rx.recv_timeout(bound).unwrap_or(busy)
}
#[cfg(test)]
fn stall(project: &Path) {
    while STALLED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(project)
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
fn folder_state_in(project: &Path, volumes: &Path) -> FolderState {
    #[cfg(test)]
    if let Some(hook) = IN_DISK_CHECK.take() {
        hook();
    }
    #[cfg(test)]
    stall(project);
    let denied = |e: &std::io::Error| e.kind() == std::io::ErrorKind::PermissionDenied;
    match fs::metadata(project) {
        // The listing is tried too: a stat can pass where reading the folder cannot (`add_refusal`).
        Ok(m) if m.is_dir() => match fs::read_dir(project) {
            Err(e) if denied(&e) => FolderState::NoAccess,
            _ => FolderState::Ok,
        },
        Ok(_) => FolderState::Missing,
        Err(e) if denied(&e) => FolderState::NoAccess,
        Err(_) => match project
            .strip_prefix(volumes)
            .ok()
            .and_then(|p| p.iter().next())
        {
            Some(disk) if !volumes.join(disk).exists() => FolderState::Offline,
            _ => FolderState::Missing,
        },
    }
}
/// Ticket 1040 (Locate): `path` at its new place when it is `from` or lies under it; None for any other path.
pub fn moved_path(path: &Path, from: &Path, to: &Path) -> Option<std::path::PathBuf> {
    let rest = path.strip_prefix(from).ok()?;
    Some(if rest.as_os_str().is_empty() {
        to.into()
    } else {
        to.join(rest)
    })
}
/// Ticket 1040: the disk half of a Locate, off the registry lock: the picked folder must be one `add` would take, and is
/// stored as sessions store their project (canonical).
pub fn located(to: &str) -> Result<String, String> {
    #[cfg(test)]
    stall(Path::new(to));
    match (TreeEdit::Add {
        project: to.into(),
        added: true,
    })
    .checked()?
    {
        TreeEdit::Add { project, .. } => Ok(project),
        _ => unreachable!("checked keeps the edit's kind"),
    }
}
const FILE_MAX: u64 = 1024 * 1024;
const NAME_MAX_CHARS: usize = 64;
const PATH_MAX_BYTES: usize = 4096;
const KEY_MAX_BYTES: usize = 512;
const GROUPS_MAX: usize = 256;
const PROJECTS_MAX: usize = 4096;
const FOLDED_MAX: usize = 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Tree {
    /// Display order is creation order.
    pub groups: Vec<TreeGroup>,
    pub pins: Vec<String>,
    /// Fold keys, two shapes: `group:<name>` is a folded group. `quiet:<name>` and `quiet:` (the ungrouped "Other
    /// projects" line) are the quiet lines the owner has opened, because quiet lines start folded (needs 89).
    pub folded: Vec<String>,
    /// F15: projects added by picking their folder, shown with no session until removed (`Add` false).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
    /// 370: the names the owner chose, by project path; a project not listed reads as its folder name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub names: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeGroup {
    pub name: String,
    pub projects: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TreeEdit {
    /// A group is born with its first member: the project moves in from any other group.
    GroupCreate {
        name: String,
        project: String,
    },
    GroupRename {
        from: String,
        to: String,
    },
    /// Members become ungrouped.
    GroupDissolve {
        name: String,
    },
    /// `index` is the place among the target group's projects once the moved one has left it (so it is also the final
    /// place); absent appends, past the end clamps. Added for the Undo of a move; an older client sends none.
    ProjectMove {
        project: String,
        group: Option<String>,
        #[serde(default)]
        index: Option<usize>,
    },
    Pin {
        project: String,
        pinned: bool,
    },
    /// F15: a picked folder is a project before any session starts in it; `added` false removes it again.
    Add {
        project: String,
        added: bool,
    },
    /// 370: the name shown for a project; empty goes back to its folder name.
    ProjectName {
        project: String,
        name: String,
    },
    Fold {
        key: String,
        folded: bool,
    },
    /// Restores a prior folding exactly.
    FoldSet {
        folded: Vec<String>,
    },
}
impl TreeEdit {
    /// The disk half of an Add, which callers run before they take the registry lock (Q9 en-b-J6-2: a stat on a stalled
    /// network mount held every request). Ticket 702: a typed path is added like a picked one, so a typo must not become
    /// a project row; only on add, removing a project whose folder is gone stays possible. Ticket 991 A5: stored as
    /// sessions store their project (canonical), so /var/x and /private/var/x are one row.
    pub fn checked(self) -> Result<Self, String> {
        match self {
            TreeEdit::Add {
                project,
                added: true,
            } => {
                if let Some(why) = add_refusal(Path::new(&project)) {
                    return Err(why);
                }
                let project = fs::canonicalize(&project)
                    .ok()
                    .and_then(|p| p.to_str().map(String::from))
                    .unwrap_or(project);
                Ok(TreeEdit::Add {
                    project,
                    added: true,
                })
            }
            edit => Ok(edit),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: i64,
    #[serde(default)]
    folded: Vec<String>,
    #[serde(default)]
    pins: Vec<String>,
    #[serde(default)]
    groups: Vec<TreeGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    added: Vec<String>,
    // Absent when empty: an older core refuses a file with this key (deny_unknown_fields).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    names: BTreeMap<String, String>,
}

fn check_name(name: &str) -> Result<(), String> {
    let chars = name.chars().count();
    if name != name.trim()
        || !(1..=NAME_MAX_CHARS).contains(&chars)
        || name.chars().any(char::is_control)
    {
        return Err(format!(
            "name must be 1-{NAME_MAX_CHARS} characters, trimmed, without control characters"
        ));
    }
    Ok(())
}
fn check_project(project: &str) -> Result<(), String> {
    if project.len() > PATH_MAX_BYTES || project.contains('\0') || !Path::new(project).is_absolute()
    {
        return Err(format!(
            "project must be an absolute path of at most {PATH_MAX_BYTES} bytes without NUL"
        ));
    }
    Ok(())
}
fn check_key(key: &str) -> Result<(), String> {
    if key.len() > KEY_MAX_BYTES
        || key.chars().any(char::is_control)
        || !(key.starts_with("group:") || key.starts_with("quiet:"))
    {
        return Err("invalid fold key".into());
    }
    Ok(())
}
/// Unique and within `max`: pins and fold keys.
fn check_list(
    what: &str,
    list: &[String],
    max: usize,
    check: fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    if list.len() > max {
        return Err(format!("too many {what}"));
    }
    for item in list {
        check(item)?;
        if !seen.insert(item) {
            return Err(format!("duplicate in {what}"));
        }
    }
    Ok(())
}

impl Tree {
    /// The whole tree must hold: names, paths, keys, sizes, one group per project. A loaded file and every edit's
    /// result pass through here, so the file the core writes is one it would read back.
    fn validate(&self) -> Result<(), String> {
        if self.groups.len() > GROUPS_MAX {
            return Err("too many groups".into());
        }
        let (mut names, mut members) = (BTreeSet::new(), BTreeSet::new());
        for group in &self.groups {
            check_name(&group.name)?;
            if !names.insert(&group.name) {
                return Err(format!("duplicate group name {}", group.name));
            }
            for project in &group.projects {
                check_project(project)?;
                if !members.insert(project) {
                    return Err("a project is in two groups".into());
                }
            }
        }
        if members.len() > PROJECTS_MAX {
            return Err("too many grouped projects".into());
        }
        check_list("pins", &self.pins, PROJECTS_MAX, check_project)?;
        check_list("added projects", &self.added, PROJECTS_MAX, check_project)?;
        if self.names.len() > PROJECTS_MAX {
            return Err("too many project names".into());
        }
        for (project, name) in &self.names {
            check_project(project)?;
            check_name(name)?;
        }
        check_list("fold keys", &self.folded, FOLDED_MAX, check_key)
    }
    /// Drops projects no session record names and none added (from groups and pins), then groups left empty.
    pub fn prune(&mut self, known: &BTreeSet<String>) {
        let known = &self.known(known);
        for group in &mut self.groups {
            group.projects.retain(|p| known.contains(p));
        }
        self.groups.retain(|g| !g.projects.is_empty());
        self.pins.retain(|p| known.contains(p));
        self.names.retain(|p, _| known.contains(p));
    }
    /// F15: `sessions` (the projects some session record names) and the added ones.
    pub fn known(&self, sessions: &BTreeSet<String>) -> BTreeSet<String> {
        sessions.iter().chain(&self.added).cloned().collect()
    }
    /// Ticket 1040 (Locate): `from`'s group place, pin, `added` line and name now belong to `to`, each where it was.
    /// `to` must not be a project yet: the caller refuses that first, and a twin is refused here by `validate`.
    pub fn moved(&self, from: &str, to: &str) -> Result<Tree, String> {
        check_project(to)?;
        let swap = |list: &mut Vec<String>| {
            for p in list.iter_mut().filter(|p| *p == from) {
                *p = to.into();
            }
        };
        let mut next = self.clone();
        next.groups.iter_mut().for_each(|g| swap(&mut g.projects));
        swap(&mut next.pins);
        swap(&mut next.added);
        if let Some(name) = next.names.remove(from) {
            next.names.insert(to.into(), name);
        }
        next.validate()?;
        Ok(next)
    }
    fn take(&mut self, project: &str) {
        for group in &mut self.groups {
            group.projects.retain(|p| p != project);
        }
    }
    fn group_mut(&mut self, name: &str) -> Result<&mut TreeGroup, String> {
        self.groups
            .iter_mut()
            .find(|g| g.name == name)
            .ok_or_else(|| format!("unknown group {name}"))
    }
    /// Fold keys of groups that do not exist: `group:<name>` and `quiet:<name>`; `quiet:` (the ungrouped line) stays.
    fn prune_folds(&mut self) {
        let names: BTreeSet<&str> = self.groups.iter().map(|g| g.name.as_str()).collect();
        let live = |key: &str| {
            let name = &key[6..];
            name.is_empty() || names.contains(name)
        };
        let folded: Vec<String> = self.folded.iter().filter(|k| live(k)).cloned().collect();
        self.folded = folded;
    }
    /// The tree after `edit`, validated and pruned; `self` is never changed, so a refused edit changes nothing.
    /// `known` is the projects some session record names; `None` when the session store is set aside, so nothing
    /// is known and nothing is pruned or refused for being unknown.
    pub fn edited(
        &self,
        edit: &TreeEdit,
        known: Option<&BTreeSet<String>>,
    ) -> Result<Tree, String> {
        let unknown = |project: &str| match known {
            Some(known) if !known.contains(project) && !self.added.iter().any(|p| p == project) => {
                Err("unknown project".to_string())
            }
            _ => Ok(()),
        };
        let mut next = self.clone();
        match edit {
            TreeEdit::GroupCreate { name, project } => {
                check_project(project)?;
                unknown(project)?;
                next.take(project);
                next.groups.push(TreeGroup {
                    name: name.trim().into(),
                    projects: vec![project.clone()],
                });
            }
            TreeEdit::GroupRename { from, to } => {
                let (from, to) = (from.trim(), to.trim());
                next.group_mut(from)?.name = to.into();
                // The fold keys follow the name; a key already listed for `to` keeps its first place, no twin.
                let mut seen = BTreeSet::new();
                next.folded = std::mem::take(&mut next.folded)
                    .into_iter()
                    .map(|k| {
                        let kind = ["group:", "quiet:"]
                            .into_iter()
                            .find(|p| k.strip_prefix(p) == Some(from));
                        kind.map_or(k, |p| format!("{p}{to}"))
                    })
                    .filter(|k| seen.insert(k.clone()))
                    .collect();
            }
            TreeEdit::GroupDissolve { name } => {
                let name = name.trim();
                next.group_mut(name)?;
                next.groups.retain(|g| g.name != name);
            }
            TreeEdit::ProjectMove {
                project,
                group,
                index,
            } => {
                check_project(project)?;
                unknown(project)?;
                // Resolve the target first: an unknown group is refused before the project leaves its own.
                let target = group.as_deref().map(str::trim);
                if let Some(name) = target {
                    next.group_mut(name)?;
                }
                next.take(project);
                if let Some(name) = target {
                    let projects = &mut next.group_mut(name)?.projects;
                    projects.insert(
                        index.map_or(projects.len(), |i| i.min(projects.len())),
                        project.clone(),
                    );
                }
            }
            TreeEdit::Pin { project, pinned } => {
                check_project(project)?;
                // Unpinning a project that is gone stays possible.
                if *pinned {
                    unknown(project)?;
                }
                next.pins.retain(|p| p != project);
                if *pinned {
                    next.pins.push(project.clone());
                }
            }
            TreeEdit::Add { project, added } => {
                // The folder checks ran in `checked`, off the registry lock.
                check_project(project)?;
                next.added.retain(|p| p != project);
                if *added {
                    next.added.push(project.clone());
                }
            }
            TreeEdit::ProjectName { project, name } => {
                check_project(project)?;
                let name = name.trim();
                // Clearing the name of a project that is gone stays possible.
                if name.is_empty() {
                    next.names.remove(project);
                } else {
                    unknown(project)?;
                    next.names.insert(project.clone(), name.into());
                }
            }
            TreeEdit::Fold { key, folded } => {
                check_key(key)?;
                next.folded.retain(|k| k != key);
                if *folded {
                    next.folded.push(key.clone());
                }
            }
            TreeEdit::FoldSet { folded } => {
                let mut seen = BTreeSet::new();
                next.folded = folded.iter().filter(|k| seen.insert(*k)).cloned().collect();
            }
        }
        next.validate()?;
        next.prune_folds();
        if let Some(known) = known {
            next.prune(known);
        }
        Ok(next)
    }
    /// Reads `<home>/tree.toml`. Missing is an empty tree; another version is set aside (V1B-40) and starts empty;
    /// anything else that is not a valid version 1 file (a link, oversized, unknown keys, duplicates) is an error and
    /// the file is not touched.
    pub fn load(home: &Path) -> Result<Tree, String> {
        let path = home.join("tree.toml");
        // NOFOLLOW: a symlinked file is refused, never read through. Bytes and metadata come from one handle.
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Tree::default()),
            Err(e) => return Err(format!("tree.toml: {e}")),
        };
        let meta = file.metadata().map_err(|e| format!("tree.toml: {e}"))?;
        if !meta.is_file() || meta.len() > FILE_MAX {
            return Err("tree.toml is not a regular file or is too large".into());
        }
        let mut bytes = Vec::new();
        file.take(FILE_MAX + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("tree.toml: {e}"))?;
        let text = std::str::from_utf8(&bytes).map_err(|e| format!("tree.toml: {e}"))?;
        let table: toml::Table = text.parse().map_err(|e| format!("tree.toml: {e}"))?;
        if let Some(version) = table
            .get("version")
            .and_then(toml::Value::as_integer)
            .filter(|v| *v != VERSION && *v >= 0)
        {
            store::set_aside(&path, &meta, version as u64)?;
            return Ok(Tree::default());
        }
        let file: File = table.try_into().map_err(|e| format!("tree.toml: {e}"))?;
        if file.version != VERSION {
            return Err("tree.toml: unsupported version".into());
        }
        let tree = Tree {
            groups: file.groups,
            pins: file.pins,
            folded: file.folded,
            added: file.added,
            names: file.names,
        };
        tree.validate().map_err(|e| format!("tree.toml: {e}"))?;
        Ok(tree)
    }
    /// Atomic, owner-only write of version 1. Refuses to replace anything but a regular file or nothing.
    pub fn save(&self, home: &Path) -> Result<(), String> {
        let path = home.join("tree.toml");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err("tree.toml is not a regular file".into());
        }
        let text = toml::to_string(&File {
            version: VERSION,
            folded: self.folded.clone(),
            pins: self.pins.clone(),
            groups: self.groups.clone(),
            added: self.added.clone(),
            names: self.names.clone(),
        })
        .map_err(|e| e.to_string())?;
        // The loader refuses a bigger file: never write one the core cannot read back.
        if text.len() as u64 > FILE_MAX {
            return Err("tree.toml would exceed its size limit".into());
        }
        store::atomic_write(&path, text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "/work/api-server";
    fn home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nunchiro-names-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn named(tree: &Tree, name: &str) -> Result<Tree, String> {
        let edit = TreeEdit::ProjectName {
            project: P.into(),
            name: name.into(),
        };
        tree.edited(&edit, Some(&BTreeSet::from([P.to_string()])))
    }

    #[test]
    fn no_names_writes_no_key_and_still_reads() {
        let dir = home("none");
        let tree = Tree {
            added: vec![P.into()],
            ..Tree::default()
        };
        tree.save(&dir).unwrap();
        assert!(
            !fs::read_to_string(dir.join("tree.toml"))
                .unwrap()
                .contains("names")
        );
        assert_eq!(Tree::load(&dir).unwrap(), tree);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_round_trip_and_empty_clears() {
        let dir = home("trip");
        let tree = named(&Tree::default(), "  api-staging ").unwrap();
        assert_eq!(tree.names[P], "api-staging");
        tree.save(&dir).unwrap();
        assert_eq!(Tree::load(&dir).unwrap(), tree);
        let cleared = named(&tree, "   ").unwrap();
        assert!(cleared.names.is_empty());
        cleared.save(&dir).unwrap();
        assert!(
            !fs::read_to_string(dir.join("tree.toml"))
                .unwrap()
                .contains("names")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_long_or_unknown_name_is_refused() {
        let tree = Tree::default();
        assert!(named(&tree, &"가".repeat(64)).is_ok());
        assert!(named(&tree, &"가".repeat(65)).unwrap_err().contains("1-64"));
        let edit = TreeEdit::ProjectName {
            project: "/elsewhere".into(),
            name: "x".into(),
        };
        assert_eq!(
            tree.edited(&edit, Some(&BTreeSet::new())).unwrap_err(),
            "unknown project"
        );
    }

    #[test]
    fn a_name_leaves_with_its_project() {
        let tree = named(&Tree::default(), "api-staging").unwrap();
        let edit = TreeEdit::Fold {
            key: "quiet:".into(),
            folded: true,
        };
        assert!(
            tree.edited(&edit, Some(&BTreeSet::new()))
                .unwrap()
                .names
                .is_empty()
        );
        // The session store set aside knows nothing: nothing is dropped.
        assert_eq!(tree.edited(&edit, None).unwrap().names[P], "api-staging");
    }

    #[test]
    fn add_refuses_a_missing_folder_and_remove_still_works() {
        let dir = fs::canonicalize(home("add")).unwrap();
        let folder = dir.to_string_lossy().into_owned();
        let add = |project: &str, added: bool| TreeEdit::Add {
            project: project.into(),
            added,
        };
        let tree = Tree::default()
            .edited(&add(&folder, true).checked().unwrap(), None)
            .unwrap();
        assert_eq!(tree.added, std::slice::from_ref(&folder));
        let typo = format!("{folder}/no-such-folder");
        assert_eq!(add(&typo, true).checked().unwrap_err(), "not a folder");
        // Q9 en-b-J6-2: under the registry lock the edit reads no disk; the refusal above came before it.
        assert!(tree.edited(&add(&typo, true), None).is_ok());
        let file = dir.join("a-file");
        fs::write(&file, "").unwrap();
        assert!(add(&file.to_string_lossy(), true).checked().is_err());
        // The folder goes away: removing its row still works.
        fs::remove_dir_all(&dir).unwrap();
        assert!(
            tree.edited(&add(&folder, false), None)
                .unwrap()
                .added
                .is_empty()
        );
    }

    /// Ticket 991 A5: a folder added through a symlink is stored at its real path, once.
    #[test]
    fn add_stores_the_real_path() {
        let dir = fs::canonicalize(home("addlink")).unwrap();
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let add = |project: &Path| TreeEdit::Add {
            project: project.to_string_lossy().into_owned(),
            added: true,
        };
        let tree = Tree::default()
            .edited(&add(&link).checked().unwrap(), None)
            .unwrap();
        let tree = tree.edited(&add(&real).checked().unwrap(), None).unwrap();
        assert_eq!(tree.added, [real.to_string_lossy().into_owned()]);
    }

    #[test]
    fn add_refuses_an_unreadable_folder_with_its_own_reason() {
        use std::os::unix::fs::PermissionsExt;
        let dir = home("noaccess");
        let shut = dir.join("shut");
        let inside = shut.join("inner");
        fs::create_dir_all(&inside).unwrap();
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o000)).unwrap();
        let add = |project: &Path| {
            TreeEdit::Add {
                project: project.to_string_lossy().into_owned(),
                added: true,
            }
            .checked()
        };
        // Root reads any folder; there is nothing to refuse then.
        if fs::read_dir(&shut).is_err() {
            // The listing is refused (EACCES), and a stat below it too: both name the folder's mode, never "not a folder".
            assert_eq!(
                add(&shut).unwrap_err(),
                format!("no permission to read {}", shut.display())
            );
            assert_eq!(
                add(&inside).unwrap_err(),
                format!("no permission to read {}", inside.display())
            );
        }
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o755)).unwrap();
        // A folder that is not there still says so.
        assert_eq!(add(&dir.join("gone")).unwrap_err(), "not a folder");
        assert!(add(&inside).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    // Codex security look on w91: checks that never return hold at most `MAX_FOLDER_CHECKS` threads across 50 folders;
    // once one returns, a new folder's check starts as usual.
    #[test]
    fn hung_folder_checks_hold_at_most_the_bound_of_threads() {
        let _turn = CHECKS_TEST.lock().unwrap_or_else(|e| e.into_inner());
        let dir = home("folder-bound");
        let hung: Vec<_> = (0..50).map(|i| dir.join(format!("hung-{i}"))).collect();
        STALLED.lock().unwrap().extend(hung.iter().cloned());
        let short = std::time::Duration::from_millis(20);
        let running = || RUNNING.lock().unwrap().len();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while running() > 0 {
            assert!(
                std::time::Instant::now() < until,
                "another test's check never ended"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        for p in &hung {
            assert_eq!(folder_state_within(p, short), FolderState::Offline);
        }
        assert_eq!(
            running(),
            MAX_FOLDER_CHECKS,
            "threads started for 50 hung folders"
        );
        // Full: a folder that would answer at once is not started either.
        fs::create_dir_all(dir.join("ok")).unwrap();
        assert_eq!(
            folder_state_within(&dir.join("ok"), short),
            FolderState::Offline
        );
        // One hung check returns; its place is free again and the next check runs.
        let first = RUNNING.lock().unwrap().iter().next().unwrap().clone();
        STALLED.lock().unwrap().remove(&first);
        while running() >= MAX_FOLDER_CHECKS {
            assert!(
                std::time::Instant::now() < until,
                "the returned check kept its place"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            folder_state_within(&dir.join("ok"), FOLDER_CHECK_BOUND),
            FolderState::Ok
        );
        STALLED.lock().unwrap().clear();
        while running() > 0 {
            assert!(
                std::time::Instant::now() < until,
                "stalled checks never ended"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    // Ticket 1040: a folder on a disk that is not mounted is offline, never "not found", and a refused read is neither.
    #[test]
    fn folder_state_tells_missing_from_offline_and_no_access() {
        use std::os::unix::fs::PermissionsExt;
        let dir = home("folder-state");
        let volumes = dir.join("Volumes");
        let here = volumes.join("Work/api");
        fs::create_dir_all(&here).unwrap();
        let state = |p: &Path| folder_state_in(p, &volumes);
        assert_eq!(state(&here), FolderState::Ok);
        // The disk is there, the folder is not.
        assert_eq!(state(&volumes.join("Work/gone")), FolderState::Missing);
        // The disk is not mounted: its folder and the disk itself.
        assert_eq!(
            state(&volumes.join("Archive/photo-tools")),
            FolderState::Offline
        );
        assert_eq!(state(&volumes.join("Archive")), FolderState::Offline);
        // Not on an external disk at all.
        assert_eq!(state(&dir.join("gone")), FolderState::Missing);
        // A file where the folder was is not the folder.
        fs::write(dir.join("file"), "x").unwrap();
        assert_eq!(state(&dir.join("file")), FolderState::Missing);
        let shut = dir.join("shut");
        fs::create_dir_all(shut.join("inner")).unwrap();
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads any folder; there is nothing to refuse then.
        if fs::read_dir(&shut).is_err() {
            assert_eq!(state(&shut), FolderState::NoAccess);
            assert_eq!(state(&shut.join("inner")), FolderState::NoAccess);
        }
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            serde_json::to_string(&FolderState::NoAccess).unwrap(),
            "\"no_access\""
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    // Ticket 1040: Locate moves the group place, the pin, `added` and the name to the new path, and nothing else.
    #[test]
    fn moved_rekeys_group_pin_added_and_name_in_place() {
        let (old, new, other) = ("/work/old-blog", "/work/blog-2024", "/work/api");
        let tree = Tree {
            groups: vec![TreeGroup {
                name: "Work".into(),
                projects: vec![other.into(), old.into()],
            }],
            pins: vec![old.into(), other.into()],
            folded: vec!["group:Work".into()],
            added: vec![other.into(), old.into()],
            names: BTreeMap::from([(old.to_string(), "Blog".to_string())]),
        };
        let next = tree.moved(old, new).unwrap();
        assert_eq!(next.groups[0].projects, [other, new]);
        assert_eq!(next.pins, [new, other]);
        assert_eq!(next.added, [other, new]);
        assert_eq!(
            next.names,
            BTreeMap::from([(new.to_string(), "Blog".to_string())])
        );
        assert_eq!(next.folded, tree.folded);
        assert!(!toml::to_string(&next.groups[0]).unwrap().contains(old));
        // A tree that does not name the project stays as it is.
        let bare = Tree::default().moved(old, new).unwrap();
        assert_eq!(bare, Tree::default());
        // A relative target is refused and the tree is as it was.
        assert!(tree.moved(old, "blog").is_err());
    }
}
