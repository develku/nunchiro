//! Managed worktrees: reservations, the root folder, the store, and the plan that creates and removes them.
use super::*;
impl Sessions {
    pub(crate) fn reserve_worktree(
        &mut self,
        plan: &WorktreePlan,
    ) -> Result<Option<PathBuf>, String> {
        if self.removing_worktrees.iter().any(|path| {
            plan.path.as_ref().is_some_and(|p| p.starts_with(path))
                || plan.project.as_ref().is_some_and(|p| p.starts_with(path))
        }) {
            return Err("worktree removal in progress".into());
        }
        if plan.operation != "remove" {
            return Ok(None);
        }
        let path = plan.path.clone().ok_or("remove requires --path")?;
        self.reserve_path(&path)?;
        Ok(Some(path))
    }
    /// Ticket 259: whether `reserve_path` would refuse for a running session; asked before the cleanup script, which
    /// must not run for a remove that is then refused.
    pub(crate) fn live_in(&self, path: &Path) -> bool {
        self.entries
            .values()
            .any(|e| e.meta.cwd.starts_with(path) && e.meta.state == SessionState::Running)
    }
    /// A folder about to be removed: refused while a session runs in it; a start there waits until released.
    pub(crate) fn reserve_path(&mut self, path: &Path) -> Result<(), String> {
        // One reservation per folder: a second holder's release would end the first one's.
        if self
            .removing_worktrees
            .iter()
            .any(|p| p.starts_with(path) || path.starts_with(p))
        {
            return Err("worktree removal in progress".into());
        }
        if self
            .entries
            .values()
            .any(|e| e.meta.cwd.starts_with(path) && e.meta.state == SessionState::Running)
        {
            return Err("close live worktree sessions first".into());
        }
        self.removing_worktrees.insert(path.to_path_buf());
        Ok(())
    }
    /// Ticket 990: the recorded worktree at `path` (canonical), with its team.
    pub(crate) fn recorded_worktree(&self, path: &Path) -> Option<Worktree> {
        recorded_worktree(&self.home, &self.settings, path)
    }
    /// Ticket 259: the project of the recorded worktree at `path` (canonical), read from the store without its lock.
    pub(crate) fn recorded_worktree_project(&self, path: &Path) -> Option<PathBuf> {
        recorded_worktree_project(&self.home, &self.settings, path)
    }
    /// Ticket 991 (Q7 point 1): session `id` just took its title from its first prompt. In a folder of its own (a
    /// worktree) the title is kept for the next worktree request, which runs git off this lock.
    pub(super) fn title_names_branch(&mut self, id: &str) {
        let Some(meta) = self.entries.get(id).map(|e| &e.meta) else {
            return;
        };
        if meta.cwd != meta.project && meta.machine.is_none() {
            // shortcut: a title waits for the next worktree request (a window lists every 30 s) and at most 64 are kept, rename at the title itself if a core with no window must do it.
            if self.branch_titles.len() >= 64 {
                self.branch_titles.remove(0);
            }
            self.branch_titles
                .push((meta.cwd.clone(), meta.label.clone()));
        }
    }
    pub(crate) fn take_branch_titles(&mut self) -> Vec<(PathBuf, String)> {
        std::mem::take(&mut self.branch_titles)
    }
    pub(crate) fn release_worktree(&mut self, path: Option<PathBuf>) {
        if let Some(path) = path {
            self.removing_worktrees.remove(&path);
        }
    }
    pub(crate) fn worktree_plan(
        &self,
        caller: Option<&crate::grants::Caller>,
        request: Request,
    ) -> Result<WorktreePlan, String> {
        if let Some(caller) = caller {
            self.check_token(caller, &request)?; // ticket 573: `server::worktree` runs no `check_agent`
        }
        let Request::Worktree {
            operation,
            project,
            path,
            branch,
            base,
            label,
            from,
            confirm,
        } = request
        else {
            return Err("expected worktree request".into());
        };
        if ![
            "create", "open", "list", "remove", "forget", "rename", "restore", "adopt", "branches",
            "team",
        ]
        .contains(&operation.as_str())
            || label.len() > 256
            || from.as_ref().is_some_and(|f| f.len() > 2048)
        {
            return Err("invalid worktree request".into());
        }
        // V2-8a: every op this ticket adds is the owner's (the window's) alone: discarding unsaved work, the label,
        // Undo, the record clean-up, and the one-field create (it can run the user's gh).
        if caller.is_some()
            && (confirm.is_some()
                || from.is_some()
                || ["rename", "restore", "forget", "adopt", "team"].contains(&operation.as_str()))
        {
            return Err("operation not granted".into());
        }
        // Ticket 990: the owner hands a worktree to the lead of its project (`label` is that teammate's id), or takes
        // it back (no label).
        if operation == "team" && !label.is_empty() {
            let at = path.as_ref().ok_or("requires --path")?;
            let at = fs::canonicalize(at).map_err(|e| e.to_string())?;
            let project = self
                .recorded_worktree(&at)
                .map(|w| w.project)
                .ok_or("worktree not managed")?;
            let leads = crate::team::Team::open(&self.home).lead_of(Some(&project));
            if leads.is_none_or(|t| t.id != label) {
                return Err("a worktree is handed to the lead of its project".into());
            }
        }
        // V2.5-61 B8: `branches` reads one project's refs and takes nothing else; a session caller reads only its own
        // session's project (none named means that one).
        let branches = operation == "branches";
        if branches
            && (path.is_some()
                || branch.is_some()
                || !(base.is_empty() || base == "HEAD")
                || !label.is_empty()
                || from.is_some()
                || confirm.is_some())
        {
            return Err("invalid worktree request".into());
        }
        let project = match caller {
            Some(caller) if branches => {
                let own = fs::canonicalize(&caller.project).map_err(|e| e.to_string())?;
                let named = project.map(fs::canonicalize).transpose();
                if named
                    .as_ref()
                    .is_ok_and(|p| p.as_ref().is_none_or(|p| *p == own))
                {
                    Some(own)
                } else {
                    return Err("operation not granted".into());
                }
            }
            _ if branches => Some(project.ok_or("branches requires a project")?),
            _ => project,
        };
        let path = path
            .map(|path| match fs::canonicalize(&path) {
                Ok(path) => Ok(path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
                Err(e) => Err(e.to_string()),
            })
            .transpose()?;
        let project = project
            .map(fs::canonicalize)
            .transpose()
            .map_err(|e| e.to_string())?;
        if operation == "remove"
            && path.as_ref().is_some_and(|p| {
                self.entries
                    .values()
                    .any(|e| e.meta.cwd == *p && e.meta.state == SessionState::Running)
            })
        {
            return Err("close live worktree sessions first".into());
        }
        Ok(WorktreePlan {
            home: self.home.clone(),
            root: self.worktree_root(),
            operation,
            project,
            path,
            branch,
            base,
            label,
            creator: caller.map(|c| c.id.clone()), // v1a-16; v1a-23: shown, no longer a limit
            token: caller.is_some_and(|c| self.token_of(c).is_some()),
            team: caller.and_then(|c| self.team_lead_of(&c.id)), // ticket 990
            from,
            confirm,
            dir: self.settings.worktrees_dir.clone(),
            user_home: self.settings.user_home.clone(),
            prefix: self
                .settings
                .feature::<String>("git.branch_prefix")
                .unwrap_or_default(),
            titles: vec![],
        })
    }
}
/// The recorded worktree at `path` (canonical), read from the store without its lock.
fn recorded_worktree(home: &Path, settings: &Settings, path: &Path) -> Option<Worktree> {
    let plan = WorktreePlan::owner(home, &settings.legacy_worktree_root(home), "list", None);
    let (disk, _, _) = plan.load(&home.join("worktrees.json")).ok()?;
    disk.worktrees.into_iter().find(|w| w.path == path)
}
/// Its project, for a worktree whose folder is there.
pub(super) fn recorded_worktree_project(
    home: &Path,
    settings: &Settings,
    path: &Path,
) -> Option<PathBuf> {
    recorded_worktree(home, settings, path)
        .filter(|w| !w.missing)
        .map(|w| w.project)
}
/// v25f (F7): `worktrees_dir` is an absolute path without `..`, or a relative one inside the project or one level up
/// beside it (`.worktrees`, `../.worktrees`): an optional leading `.` or `..`, then plain names. Anything else is refused
/// with the reason, so a typo never scatters worktrees somewhere odd.
pub(super) fn check_worktrees_dir(d: &Path) -> Result<(), String> {
    use std::path::Component::{CurDir, Normal, ParentDir, RootDir};
    let text = d.to_string_lossy();
    if text.is_empty() || text.len() > 1024 || text.chars().any(char::is_control) {
        return Err("the worktree folder must be a path of at most 1024 characters".into());
    }
    if text.starts_with('~') {
        return Err(format!("{text}: write the full path instead of ~"));
    }
    let mut parts = d.components().peekable();
    if d.is_absolute() {
        return if parts.all(|c| matches!(c, RootDir | Normal(_))) {
            Ok(())
        } else {
            Err(format!(
                "{text}: an absolute worktree folder may not contain .."
            ))
        };
    }
    if matches!(parts.peek(), Some(CurDir | ParentDir)) {
        parts.next();
    }
    let rest: Vec<_> = parts.collect();
    if !rest.is_empty() && rest.iter().all(|c| matches!(c, Normal(_))) {
        Ok(())
    } else {
        Err(format!(
            "{text} leaves the repository's folder: a relative worktree folder is inside the repository or beside it, like ../.worktrees; use an absolute path for anywhere else"
        ))
    }
}
/// Ticket 1061 (security): `<root>/<repo>`, the folder a project's new worktrees go in, made (0700) and canonical. The
/// root may be a link (the owner's own choice; resolved here, and a token checks the result), but `<repo>` must be a
/// real folder: whoever can write the repository's parent could plant `.worktrees/<repo>` as a link to any folder,
/// the Nunchiro folder included.
pub(super) fn worktree_parent(
    root: &Path,
    repo: &std::ffi::OsStr,
    base: Option<&Path>,
) -> Result<PathBuf, String> {
    let root = make_root(root, base)?;
    let parent = root.join(repo);
    let refused = || {
        format!(
            "worktree folder {} is a link or not a folder; Nunchiro does not follow links there{WORKTREES_DIR_HINT}",
            parent.display()
        )
    };
    if fs::symlink_metadata(&parent).is_ok_and(|m| !m.is_dir()) {
        return Err(refused());
    }
    store::private_dir(&parent).map_err(|e| {
        format!(
            "worktree folder {}: {e}{WORKTREES_DIR_HINT}",
            parent.display()
        )
    })?;
    if fs::canonicalize(&parent).ok().as_ref() != Some(&parent) {
        return Err(refused());
    }
    Ok(parent)
}
/// Ticket 1083: makes the worktrees root (0700) and returns it canonical. `base` is `<user home>/nunchiro` when the root is
/// the unset default: made 0755 (it may hold other things later) and refused when it is a link or not a folder, as
/// the 1061 checks refuse a planted `<repo>` link.
fn make_root(root: &Path, base: Option<&Path>) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let fail = |e: String| {
        format!(
            "worktree folder {}: {e}{WORKTREES_DIR_HINT}",
            root.display()
        )
    };
    if let Some(base) = base {
        match fs::symlink_metadata(base) {
            Ok(m) if !m.is_dir() => {
                return Err(fail(format!(
                    "{} is a link or not a folder; Nunchiro does not follow links there",
                    base.display()
                )));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o755)
                    .create(base)
                    .and_then(|()| fs::set_permissions(base, fs::Permissions::from_mode(0o755)))
                    .map_err(|e| fail(e.to_string()))?;
            }
            Err(e) => return Err(fail(e.to_string())),
        }
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)
        .and_then(|()| fs::canonicalize(root))
        .map_err(|e| fail(e.to_string()))
}
/// Ticket 1083: what the unset default was called from ticket 1061 until 1083 (beside the repository); its records keep working.
pub(super) const PREVIOUS_DEFAULT_DIR: &str = "../.worktrees";
/// Ticket 1061: appended to a worktree folder error, so the line names the setting that moves the folder.
const WORKTREES_DIR_HINT: &str = "; set Settings > Git & Worktrees > Folder for new worktrees (worktrees_dir) to a folder you can write";
/// v25f: the root `project`'s worktrees go under: the setting, a relative one joined to the project (lexically: the
/// check above allows only one leading `..`). Ticket 1083: unset is `<user home>/nunchiro/worktrees`: visible, not a `.nunchiro*` name (peer.rs owner_home()
/// reads those as the data folder), and never inside the data folder (a debug core there refuses the window).
pub(crate) fn worktree_root_for(
    dir: Option<&Path>,
    project: &Path,
    user_home: &Path,
) -> Result<PathBuf, String> {
    let default = user_home.join("nunchiro/worktrees");
    if dir.is_none() && !user_home.is_absolute() {
        return Err(format!(
            "the user's home folder is not known{WORKTREES_DIR_HINT}"
        ));
    }
    let d = dir.unwrap_or(&default);
    check_worktrees_dir(d)?;
    if d.is_absolute() {
        return Ok(d.to_path_buf());
    }
    let mut parts = d.components();
    let base = match d.components().next() {
        Some(std::path::Component::ParentDir) => {
            parts.next();
            project
                .parent()
                .ok_or("the repository has no parent folder")
                .map_err(|e| format!("{e}{WORKTREES_DIR_HINT}"))?
        }
        Some(std::path::Component::CurDir) => {
            parts.next();
            project
        }
        _ => project,
    };
    Ok(base.join(parts.as_path()))
}
/// The folder whose `nunchiro/worktrees` is the unset default: the user's home for the default data folder
/// (`~/.nunchiro`), else `<home>-worktrees` beside the core's own `home`, so a core on its own NUNCHIRO_HOME never
/// shares the owner's worktrees. Beside, not inside: a session's worktree is refused inside the data folder
/// (`tokens::outside_home`); its leading dots go, so it is no `.nunchiro*` folder (peer.rs `owner_home`).
pub(crate) fn worktree_user_home(home: &Path, user_home: Option<PathBuf>) -> PathBuf {
    let canon = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let home = canon(home);
    match (user_home, home.parent(), home.file_name()) {
        (Some(user), _, _) if canon(&user.join(".nunchiro")) == home => user,
        (_, Some(parent), Some(name)) => parent.join(format!(
            "{}-worktrees",
            name.to_string_lossy().trim_start_matches('.')
        )),
        _ => home,
    }
}
/// The worktree store's bytes, None when there is none. Follow-ups 1112: judged and read on one handle
/// (`store::read_regular`: no link followed, a non-blocking open, at most 1 MiB). It used to check the path's metadata
/// and then open the path again, so a link or FIFO swapped in between was followed or waited on, under worktrees.lock.
pub(super) fn read_worktree_store(file: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::ErrorKind;
    match crate::store::read_regular(file) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        // Not a regular file (a link, FIFO, device or folder), or over the cap.
        Err(e) if matches!(e.kind(), ErrorKind::InvalidInput | ErrorKind::InvalidData) => {
            Err("invalid worktree store".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorktreeStore {
    version: u32,
    worktrees: Vec<Worktree>,
}
pub(super) const WORKTREE_BUSY: &str = "worktree operation in progress"; // v1a-21
/// A worktree's git calls (add, remove, ref reads) end after this.
pub(super) const GIT_WORKTREE: std::time::Duration = std::time::Duration::from_secs(10);
/// V2-8a: the listed worktrees (with facts), the opened one, and a remove's loss when it removed nothing for it.
pub(crate) type WorktreeRun = (Vec<Worktree>, Option<Worktree>, Option<WorktreeLoss>);
/// Ticket 991 A13: a new worktree's folder is named after it (its label, else its branch's last part), as a plain
/// folder name, so the shell prompt shows the name and not an id. A taken name gets "-2", "-3" and so on.
pub(super) fn worktree_folder_name(
    label: &str,
    branch: &str,
    free: impl Fn(&str) -> bool,
) -> Result<String, String> {
    let plain = |source: &str| {
        let mut name = String::new();
        for c in source.chars() {
            let c = if c.is_alphanumeric() || c == '.' || c == '_' {
                c
            } else {
                '-'
            };
            if !(c == '-' && name.ends_with('-')) {
                name.push(c);
            }
        }
        let name: String = name
            .trim_start_matches(['.', '-'])
            .chars()
            .take(60)
            .collect();
        name.trim_end_matches(['-', '.']).to_string()
    };
    let name = [label, branch.rsplit('/').next().unwrap_or(branch)]
        .into_iter()
        .map(plain)
        .find(|n| !n.is_empty());
    let Some(name) = name else {
        return store::new_id();
    };
    if free(&name) {
        return Ok(name);
    }
    (2..100)
        .map(|n| format!("{name}-{n}"))
        .find(|n| free(n))
        .map_or_else(store::new_id, Ok)
}

pub(crate) struct WorktreePlan {
    home: PathBuf,
    root: PathBuf,
    operation: String,
    pub(super) project: Option<PathBuf>,
    path: Option<PathBuf>,
    branch: Option<String>,
    base: String,
    label: String,
    creator: Option<String>,       // v1a-16
    token: bool, // ticket 1061: a token's create stays outside the Nunchiro folder
    team: Option<String>, // ticket 990: the lead whose team a created worktree joins
    from: Option<String>, // V2-8a
    confirm: Option<WorktreeLoss>, // V2-8a
    // v25f: the `worktrees_dir` setting (where a create puts a new folder) and the branch prefix the one-field create uses.
    dir: Option<PathBuf>,
    user_home: PathBuf, // ticket 1083: where an unset `dir` lies
    prefix: String,
    /// Ticket 991 (Q7 point 1): `Sessions::take_branch_titles`, applied under worktrees.lock before the operation.
    titles: Vec<(PathBuf, String)>,
}
impl WorktreePlan {
    pub(crate) fn name_branches(&mut self, titles: Vec<(PathBuf, String)>) {
        self.titles = titles;
    }
    /// V2-8a: an owner plan for the auto-clean pass (`list`, or `remove` without a confirm).
    pub(crate) fn owner(home: &Path, root: &Path, operation: &str, path: Option<PathBuf>) -> Self {
        Self {
            home: home.to_path_buf(),
            root: root.to_path_buf(),
            operation: operation.into(),
            project: None,
            path,
            branch: None,
            base: "HEAD".into(),
            label: String::new(),
            creator: None,
            token: false,
            team: None,
            from: None,
            confirm: None,
            dir: None,
            user_home: PathBuf::new(),
            prefix: String::new(),
            titles: vec![],
        }
    }
    /// V2-8a auto-clean: a confirm the core itself gives for merged commits on the kept branch (no uncommitted files).
    pub(crate) fn excuse(&mut self, loss: Option<WorktreeLoss>) {
        self.confirm = loss.filter(|l| l.uncommitted_total == 0 && l.ignored_total == 0);
    }
    /// Ticket 259: what `server::worktree` runs the setup and cleanup scripts around.
    pub(crate) fn operation(&self) -> &str {
        &self.operation
    }
    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
    pub(crate) fn confirm(&self) -> Option<&WorktreeLoss> {
        self.confirm.as_ref()
    }
    /// Ticket 990: on `team`, the lead (teammate id) the worktree is handed to; empty takes it back.
    pub(crate) fn label(&self) -> &str {
        &self.label
    }
    /// V2.5-61 B8: the project of a `branches` read, which runs off the store (`worktree_clean::branches`), never `run`.
    pub(crate) fn branches_project(&self) -> Option<&Path> {
        self.project
            .as_deref()
            .filter(|_| self.operation == "branches")
    }
    pub(crate) fn execute(self) -> Result<(Vec<Worktree>, Option<Worktree>), String> {
        match self.run_waiting(false)? {
            (_, _, Some(_)) => Err("worktree has unsaved work".into()),
            (worktrees, opened, None) => Ok((worktrees, opened)),
        }
    }
    /// The window's, the CLI's and the auto-clean's ops wait up to 2 s for another op's lock (a list refresh) instead of
    /// failing as busy; `execute` (under the registry lock) never waits.
    pub(crate) fn run(self) -> Result<WorktreeRun, String> {
        self.run_waiting(true)
    }
    pub(super) fn run_waiting(mut self, wait: bool) -> Result<WorktreeRun, String> {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{DirBuilderExt, OpenOptionsExt},
        };
        if !self.root.is_absolute() {
            return Err("worktrees_dir must be absolute".into());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(|e| e.to_string())?;
        self.root = fs::canonicalize(&self.root).map_err(|e| e.to_string())?;
        let file = self.home.join("worktrees.json");
        // Ticket 394: a PR link's fetch and gh call, and the default base's fetch, wait on the network, so they run
        // before worktrees.lock: a slow server never holds every other worktree operation. Ticket 403 item 13: only
        // once the store reads as valid (it is read again under the lock).
        let mut early = match self.operation.as_str() {
            "create" | "restore" => {
                self.load(&file)?;
                Some(self.early()?)
            }
            _ => None,
        };
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.home.join("worktrees.lock"))
            .map_err(|e| e.to_string())?;
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if !wait || std::time::Instant::now() >= until {
                return Err(WORKTREE_BUSY.into());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (mut disk, paths, stamped) = self.load(&file)?;
        self.apply_titles(&mut disk, &file);
        let allowed = |w: &Worktree| self.project.as_ref().is_none_or(|p| *p == w.project);
        let mut opened = None;
        let mut created_note: Option<(PathBuf, String)> = None; // ticket 374: (created folder, stale default branch)
        let mut shared_note: Option<(PathBuf, Vec<String>)> = None; // ticket 253: (created folder, what failed)
        match self.operation.as_str() {
            "list" => {}
            // v25f: before the root setting changes (quit_settings), records without one keep the old root on disk. A
            // list never writes; any other write carries the stamps too.
            "stamp" => {
                if stamped {
                    store::atomic_write(
                        &file,
                        &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                    )?;
                }
                return Ok((vec![], None, None)); // no facts: this runs under the registry lock
            }
            "create" | "restore" => {
                let project = self.project.as_ref().ok_or("create requires --project")?;
                let (pr, branch, label, early_base) =
                    early.take().ok_or("create requires --project")?;
                if branch.starts_with('-') {
                    return Err("invalid branch name".into());
                }
                Self::git(
                    project,
                    &["check-ref-format".into(), "--branch".into(), branch.clone()],
                )?;
                // Ticket 403 item 18: a PR link's branch (derived or an Advanced name), checked under the lock.
                if let Some((_, sha)) = &pr {
                    crate::worktree_clean::pr_stale(project, &branch, sha)?;
                }
                // V2-8a: a kept branch (Undo, or Create reusing it) is checked out as it is; else a new one from base.
                let exists = Self::branch_exists(project, &branch);
                let folder = project.file_name().ok_or("invalid project")?;
                let mut root = self.root_for(project)?;
                let restore = self.operation == "restore";
                if restore && !exists {
                    return Err(format!("branch {branch} no longer exists"));
                }
                let path = match &self.path {
                    // Restore: the folder it was removed from. Ticket 573: a create's `--path` (as Orca's `--name`).
                    // Either is one new plain name right under one of this project's roots, never a folder that is
                    // there or a recorded worktree.
                    Some(path) => {
                        let name = path.file_name().ok_or("invalid worktree path")?;
                        // A folder not made yet is not canonical; its parent is, or (a project's first worktree) the
                        // parent's parent. Neither there: no root matches.
                        let parent = path.parent().and_then(|p| {
                            fs::canonicalize(p).ok().or_else(|| {
                                Some(fs::canonicalize(p.parent()?).ok()?.join(p.file_name()?))
                            })
                        });
                        // Ticket 1061: a create's `--path` may use the old default root only while a record of
                        // this project lies under it (load() stamps older records with it, so test the root).
                        let legacy = fs::canonicalize(self.home.join("worktrees")).ok();
                        let legacy_used = disk.worktrees.iter().any(|w| {
                            w.project == *project
                                && legacy.is_some()
                                && w.root.as_ref().and_then(|r| fs::canonicalize(r).ok()) == legacy
                        });
                        root = self
                            .known_roots(project, &disk.worktrees)?
                            .into_iter()
                            .filter(|r| {
                                restore || legacy_used || *r == root || legacy.as_ref() != Some(r)
                            })
                            .find(|r| parent.as_deref() == Some(r.join(folder).as_path()))
                            .filter(|r| {
                                let path = r.join(folder).join(name);
                                matches!(
                                    path.components().next_back(),
                                    Some(std::path::Component::Normal(_))
                                ) && !name.to_string_lossy().starts_with('.')
                                    && fs::symlink_metadata(&path).is_err()
                                    && !paths.contains(&path)
                            })
                            .ok_or(if restore {
                                "restore path is not a removed worktree of this project"
                            } else {
                                "worktree path must be a new folder right under this project's worktree folder"
                            })?;
                        root.join(folder).join(name)
                    }
                    None if restore => return Err("restore requires --path".into()),
                    None => {
                        let parent = root.join(folder);
                        let free = |name: &str| {
                            let p = parent.join(name);
                            fs::symlink_metadata(&p).is_err() && !paths.contains(&p)
                        };
                        parent.join(worktree_folder_name(&label, &branch, free)?)
                    }
                };
                // Ticket 1061 (security): `path` is right under this real, canonical folder.
                let parent = worktree_parent(&root, folder, self.default_base().as_deref())?;
                if self.token {
                    tokens::outside_home(&self.home, &parent)?;
                }
                let mut add: Vec<String> = vec!["worktree".into(), "add".into()];
                let mut stale_base = None;
                if !exists {
                    // Ticket 374: the PR's commit; else the owner's empty base is origin's default branch (fetched
                    // first), and a typed one (HEAD included) is used as it is. A session token never fetches: its
                    // empty base is refused as before (security r2).
                    let base = match &pr {
                        Some((_, commit)) => commit.clone(),
                        None if self.base.is_empty() && self.creator.is_none() => {
                            // Fetched before the lock for a branch that did not exist then.
                            let (base, stale) = early_base.ok_or(
                                "the branch changed while the worktree was made; try again",
                            )?;
                            stale_base = stale;
                            base
                        }
                        None => self.base.clone(),
                    };
                    let base = Self::git(
                        project,
                        &[
                            "rev-parse".into(),
                            "--verify".into(),
                            "--end-of-options".into(),
                            format!("{base}^{{commit}}"),
                        ],
                    )?;
                    add.extend([
                        "-b".into(),
                        branch.clone(),
                        "--".into(),
                        path.to_string_lossy().into(),
                        base.trim().into(),
                    ]);
                } else {
                    add.extend(["--".into(), path.to_string_lossy().into(), branch.clone()]);
                }
                // Ticket 403 items 1-2: create, restore and a PR head check out through one helper: no hook, no
                // submodules, no filter but lfs, scrubbed environment, redacted error.
                let add: Vec<&str> = add.iter().map(String::as_str).collect();
                crate::process::git_worktree_add(project, &add, GIT_WORKTREE)?;
                // Ticket 253: a create (not a restore) gets the project's sparse preset and shared files.
                if !restore {
                    let failed =
                        crate::worktree_shared::apply(&self.home, project, &path, GIT_WORKTREE);
                    shared_note = Some((path.clone(), failed));
                }
                disk.worktrees.push(Worktree {
                    project: project.clone(),
                    path: path.clone(),
                    branch: branch.clone(),
                    label,
                    missing: false,
                    creator: self.creator.clone(), // v1a-16
                    team: self.team.clone(),       // ticket 990
                    facts: None,
                    root: Some(root),
                    stale_base: None,
                    shared_failed: vec![],
                    // Ticket 991 (Q7 point 1): a new branch under the name `from_text` made up, not one the user typed.
                    auto_branch: !exists
                        && self.branch.is_none()
                        && pr.is_none()
                        && self
                            .from
                            .as_deref()
                            .is_some_and(crate::worktree_clean::generated),
                });
                created_note = stale_base.map(|b| (path.clone(), b));
                if let Err(e) = store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                ) {
                    // Ticket 403 item 3: the status git runs first gets a read's protection, as in Remove.
                    let shown = path.to_string_lossy();
                    let remove = ["worktree", "remove", "--", &shown];
                    let _ =
                        crate::process::git_worktree_remove(project, &path, &remove, GIT_WORKTREE);
                    return Err(format!(
                        "worktree metadata failed: {e}; inspect {}",
                        path.display()
                    ));
                }
                crate::events::worktree("created", project, &path); // ticket 573
            }
            "rename" => {
                // V2-8a: the label only; no git call, the folder and branch stay.
                let path = self.path.as_ref().ok_or("requires --path")?;
                let w = disk
                    .worktrees
                    .iter_mut()
                    .find(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                w.label = self.label.clone();
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            // V2-CF3: a folder `session start --worktree` made (detached, so it has no record) joins the managed list,
            // so the row's Rename and Remove reach it. The record only: git is read, never written.
            "adopt" => {
                let project = self.project.as_ref().ok_or("adopt requires --project")?;
                let path = self.path.as_ref().ok_or("requires --path")?;
                if !paths.contains(path) {
                    let listing = Self::git(
                        project,
                        &[
                            "worktree".into(),
                            "list".into(),
                            "--porcelain".into(),
                            "-z".into(),
                        ],
                    )?;
                    // `-z`: fields end in NUL and a record in one more, so a path (which cannot hold NUL) keeps its newlines.
                    let mut blocks = listing.split("\0\0").map(|b| {
                        let at = |key: &str| b.split('\0').find_map(|l| l.strip_prefix(key));
                        let folder = at("worktree ").and_then(|p| fs::canonicalize(p).ok());
                        let branch = at("branch refs/heads/").unwrap_or("").to_string();
                        (folder, branch)
                    });
                    // The first block is the main checkout: `project` must be it, and `path` another of its worktrees.
                    let root = self
                        .known_roots(project, &disk.worktrees)?
                        .into_iter()
                        .find(|r| path.starts_with(r));
                    let branch = (blocks
                        .next()
                        .is_some_and(|(f, _)| f.as_ref() == Some(project))
                        && Self::missing_path(path) == Ok(false)
                        && root.is_some()
                        && path != project)
                        .then(|| blocks.find(|(f, _)| f.as_ref() == Some(path)))
                        .flatten()
                        .map(|(_, branch)| branch)
                        .ok_or("not a worktree of this project")?;
                    disk.worktrees.push(Worktree {
                        project: project.clone(),
                        path: path.clone(),
                        branch,
                        label: String::new(),
                        missing: false,
                        creator: None,
                        team: None,
                        facts: None,
                        root,
                        stale_base: None,
                        shared_failed: vec![],
                        auto_branch: false,
                    });
                    store::atomic_write(
                        &file,
                        &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                    )?;
                }
            }
            "open" | "remove" | "forget" => {
                let path = self.path.as_ref().ok_or("requires --path")?;
                let index = disk
                    .worktrees
                    .iter()
                    // v1a-23: any caller opens or removes any managed worktree (the v1a-21 creator rule is gone).
                    .position(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                let mut worktree = disk.worktrees[index].clone();
                // V2-8a: the window's clean-up of a gone folder: the record only, refused once the folder is back.
                if self.operation == "forget" && !worktree.missing {
                    return Err("the worktree folder is there again; nothing was removed".into());
                }
                if self.operation == "forget" {
                    disk.worktrees.remove(index);
                    crate::events::worktree("removed", &worktree.project, path); // ticket 573
                } else if self.operation == "remove" {
                    if !worktree.missing {
                        // V2-8a: unsaved work is removed only with a confirm naming exactly what is there now.
                        let loss = crate::worktree_clean::loss(path, &worktree.project)?;
                        let lossy = loss.uncommitted_total > 0
                            || loss.unpushed_total > 0
                            || loss.ignored_total > 0;
                        if lossy && self.confirm.as_ref() != Some(&loss) {
                            let listed = disk.worktrees.into_iter().filter(allowed).collect();
                            drop(lock);
                            return Ok((Self::with_facts(listed), None, Some(loss)));
                        }
                        let mut remove: Vec<String> = vec!["worktree".into(), "remove".into()];
                        if loss.uncommitted_total > 0 {
                            remove.push("--force".into()); // confirmed above: the files listed are discarded
                        }
                        // Ticket 253: the shared links go first, so a plain remove passes and git's own refusal
                        // (a submodule, a file written since `loss`) still guards the rest.
                        crate::worktree_shared::unlink(path, &worktree.project, &loss.linked);
                        remove.extend(["--".into(), path.to_string_lossy().into()]);
                        // Ticket 394 round 4: the status git runs inside the worktree first gets a read's protection.
                        let remove: Vec<&str> = remove.iter().map(String::as_str).collect();
                        let ten = std::time::Duration::from_secs(10);
                        crate::process::git_worktree_remove(&worktree.project, path, &remove, ten)?;
                    }
                    disk.worktrees.remove(index);
                    crate::events::worktree("removed", &worktree.project, path); // ticket 573
                } else {
                    if worktree.missing {
                        return Err("managed worktree is missing".into());
                    }
                    if !self.label.is_empty() {
                        worktree.label = self.label.clone();
                        disk.worktrees[index].label = self.label.clone();
                    }
                    opened = Some(worktree);
                }
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            // Ticket 990: the team mark only; no git call.
            "team" => {
                let path = self.path.as_ref().ok_or("requires --path")?;
                let worktree = disk
                    .worktrees
                    .iter_mut()
                    .find(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                worktree.team = (!self.label.is_empty()).then(|| self.label.clone());
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            _ => return Err("invalid worktree operation".into()),
        }
        let listed = disk.worktrees.into_iter().filter(allowed).collect();
        // The counts run `git` per worktree: after the lock, so a create or remove is not refused as busy meanwhile.
        drop(lock);
        let mut listed = Self::with_facts(listed);
        if let Some((path, branch)) = created_note {
            listed
                .iter_mut()
                .filter(|w| w.path == path)
                .for_each(|w| w.stale_base = Some(branch.clone()));
        }
        if let Some((path, failed)) = shared_note
            && let Some(w) = listed.iter_mut().find(|w| w.path == path)
        {
            w.shared_failed = failed;
        }
        Ok((listed, opened, None))
    }
    /// The store on disk, checked: (store, its paths, whether a record got this run's legacy root).
    fn load(
        &self,
        file: &Path,
    ) -> Result<(WorktreeStore, std::collections::BTreeSet<PathBuf>, bool), String> {
        let mut disk = match read_worktree_store(file)? {
            None => WorktreeStore {
                version: 1,
                worktrees: vec![],
            },
            Some(bytes) => serde_json::from_slice::<WorktreeStore>(&bytes)
                .map_err(|e| format!("invalid worktree store: {e}"))?,
        };
        let mut paths = std::collections::BTreeSet::new();
        if disk.version != 1 || disk.worktrees.len() > 4096 {
            return Err("invalid worktree store relationship/version".into());
        }
        let mut stamped = false;
        for worktree in &mut disk.worktrees {
            // v25f: a record lies under the root it was made in; one from before gets this run's legacy root.
            if worktree.root.is_none() {
                worktree.root = Some(self.root.clone());
                stamped = true;
            }
            let root = worktree.root.as_deref().unwrap_or(&self.root);
            // Q9 ja-J5-1: a project folder that is gone (deleted, or its drive unmounted) marks the record missing, as
            // a gone worktree folder does, so one record does not fail the store for every project and Forget clears it.
            let project = fs::canonicalize(&worktree.project);
            let project_gone =
                matches!(&project, Err(e) if e.kind() == std::io::ErrorKind::NotFound);
            if !worktree.path.is_absolute()
                || !worktree.project.is_absolute()
                || worktree.label.len() > 256
                || !paths.insert(worktree.path.clone())
                || !root.is_absolute()
                || root
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                || !worktree.path.starts_with(root)
                || worktree
                    .path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                || (!project_gone && project.map_or(true, |p| p != worktree.project))
            {
                return Err("invalid worktree store relationship/version".into());
            }
            worktree.missing = Self::missing_path(&worktree.path)? || project_gone;
        }
        Ok((disk, paths, stamped))
    }
    /// V2-8a: counts for present folders; a count that cannot be read leaves that worktree without facts.
    fn with_facts(mut worktrees: Vec<Worktree>) -> Vec<Worktree> {
        for w in worktrees.iter_mut().filter(|w| !w.missing) {
            w.facts = crate::worktree_clean::facts(&w.path, &w.project).ok();
        }
        worktrees
    }
    /// A create's or restore's (PR, branch, label, default base), every network call included; no lock is held.
    #[allow(clippy::type_complexity)]
    fn early(
        &self,
    ) -> Result<
        (
            Option<(String, String)>,
            String,
            String,
            Option<(String, Option<String>)>,
        ),
        String,
    > {
        let project = self.project.as_ref().ok_or("create requires --project")?;
        // Ticket 374: a pasted PR link fetches the PR's code first (with an Advanced branch name too); a refusal
        // makes nothing. `pr` is (branch, commit).
        let pr = match &self.from {
            Some(from) if self.operation == "create" => {
                crate::worktree_clean::pull_request(project, from)?
            }
            _ => None,
        };
        // V2-8a: the window's one field (text, a GitHub URL, or empty) when no branch is given.
        let (branch, label) = match (&self.branch, &self.from, &pr) {
            (Some(branch), _, _) => (branch.clone(), self.label.clone()),
            (None, _, Some((branch, _))) => {
                let label = if self.label.is_empty() {
                    branch.clone()
                } else {
                    self.label.clone()
                };
                (branch.clone(), label)
            }
            (None, Some(from), None) if self.operation == "create" => {
                let (branch, label) = crate::worktree_clean::from_text(from, &self.prefix)?;
                let label = if self.label.is_empty() {
                    label
                } else {
                    self.label.clone()
                };
                (branch, label)
            }
            _ => return Err("create requires --branch".into()),
        };
        // The default base is fetched only for a branch that does not exist yet.
        let base = (self.operation == "create"
            && pr.is_none()
            && self.base.is_empty()
            && self.creator.is_none()
            && !branch.starts_with('-')
            && !Self::branch_exists(project, &branch))
        .then(|| crate::worktree_clean::default_base(project));
        Ok((pr, branch, label, base))
    }
    /// Ticket 991 (Q7 point 1, as Orca names a new worktree's branch from the first message): each title names the
    /// generated branch of the worktree its session runs in, once: the mark goes whatever the checks say, so a later
    /// prompt or session never renames (a title no name can be made of is not a naming and leaves the mark). A label that is still the generated name follows; the folder stays where it is.
    /// A store that cannot be written fails no request: git goes back to the old names and `disk` stays as read.
    fn apply_titles(&mut self, disk: &mut WorktreeStore, file: &Path) {
        let last = |branch: &str| branch.rsplit('/').next().unwrap_or(branch).to_string();
        let mut next = WorktreeStore {
            version: disk.version,
            worktrees: disk.worktrees.clone(),
        };
        let mut renamed = vec![];
        let mut changed = false;
        for (path, title) in std::mem::take(&mut self.titles) {
            let marked = |w: &&mut Worktree| w.path == path && w.auto_branch;
            let Some(w) = next.worktrees.iter_mut().find(marked) else {
                continue;
            };
            // A title with no letter or digit (emoji only) names nothing and uses nothing up: the next title may.
            let name = crate::worktree_clean::title_slug(&title);
            if name.is_empty() {
                continue;
            }
            w.auto_branch = false;
            changed = true;
            if let Some(new) = Self::named_branch(w, &name) {
                let old = std::mem::replace(&mut w.branch, new.clone());
                if w.label == last(&old) {
                    w.label = last(&new);
                }
                renamed.push((w.project.clone(), old, new));
            }
        }
        if !changed {
            return;
        }
        let saved = serde_json::to_vec_pretty(&next)
            .map_err(|e| e.to_string())
            .and_then(|bytes| store::atomic_write(file, &bytes));
        match saved {
            Ok(()) => *disk = next,
            Err(e) => {
                eprintln!("worktree branch names not saved: {e}");
                for (project, old, new) in &renamed {
                    let _ = Self::rename_branch(project, new, old);
                }
            }
        }
    }
    /// The branch `w`'s generated one was renamed to `name` (`worktree_clean::title_slug`), or none: one of these does
    /// not hold: the worktree's HEAD is that branch (so it still has the generated name), it has no upstream and no
    /// remote has a branch of its name (never pushed, as far as this repository knows: a push by URL leaves no trace
    /// to read), no other worktree has it checked out, and git takes the new name (`check-ref-format`). The prefix of
    /// the generated name is kept; a taken name gets "-2", "-3" and so on.
    fn named_branch(w: &Worktree, name: &str) -> Option<String> {
        let git = |dir: &Path, args: &[&str]| {
            let out = crate::process::git_read(dir, args, GIT_WORKTREE).ok()?;
            Some(String::from_utf8_lossy(&out).trim().to_string())
        };
        let head = ["refs/heads/", &w.branch].concat();
        if git(&w.path, &["symbolic-ref", "--quiet", "HEAD"])? != head {
            return None;
        }
        let upstream = git(&w.project, &["for-each-ref", "--format=%(upstream)", &head])?;
        let remotes = ["refs/remotes/*/", &w.branch].concat();
        let pushed = git(
            &w.project,
            &["for-each-ref", "--count=1", "--format=%(refname)", &remotes],
        )?;
        let listing = git(&w.project, &["worktree", "list", "--porcelain"])?;
        let checkouts = listing
            .lines()
            .filter(|l| l.strip_prefix("branch ") == Some(&head))
            .count();
        if !upstream.is_empty() || !pushed.is_empty() || checkouts != 1 {
            return None;
        }
        let prefix = w.branch.rsplit_once('/').map_or("", |(prefix, _)| prefix);
        let under = |name: String| match prefix {
            "" => name,
            prefix => format!("{prefix}/{name}"),
        };
        let new = std::iter::once(under(name.to_string()))
            .chain((2..100).map(|n| under(format!("{name}-{n}"))))
            .find(|new| !Self::branch_exists(&w.project, new))?;
        git(&w.project, &["check-ref-format", "--branch", &new])?;
        Self::rename_branch(&w.project, &w.branch, &new).ok()?;
        Some(new)
    }
    /// `git branch -m`: no hook runs (reference-transaction), and git moves the HEAD of the worktree that has it.
    fn rename_branch(project: &Path, from: &str, to: &str) -> Result<(), String> {
        let rename = ["branch", "-m", "--", from, to];
        let args = [&crate::auto_pull::NO_HOOKS[..], &rename].concat();
        crate::process::git_update(project, &args, GIT_WORKTREE).map(drop)
    }
    fn branch_exists(project: &Path, branch: &str) -> bool {
        Self::git(
            project,
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                "--end-of-options".into(),
                ["refs/heads/", branch].concat(),
            ],
        )
        .is_ok()
    }
    /// v25f: the setting's root for `project`, made (0700) and canonical, as create, restore and adopt record it.
    fn root_for(&self, project: &Path) -> Result<PathBuf, String> {
        let root = worktree_root_for(self.dir.as_deref(), project, &self.user_home)?;
        make_root(&root, self.default_base().as_deref())
    }
    fn default_base(&self) -> Option<PathBuf> {
        self.dir.is_none().then(|| self.user_home.join("nunchiro"))
    }
    /// v25f: where a worktree of `project` may already be, since the setting can move after a removal or a CLI-made
    /// worktree: the setting's root, the root of any stored record of the project, the unset default, the old
    /// default. Canonical, setting first.
    // shortcut: a custom root whose only record was removed is forgotten, so Undo there is refused; store past roots if
    // that shows up.
    fn known_roots(&self, project: &Path, stored: &[Worktree]) -> Result<Vec<PathBuf>, String> {
        let mut roots = vec![self.root_for(project)?];
        roots.extend(
            stored
                .iter()
                .filter(|w| w.project == project)
                .filter_map(|w| w.root.clone()),
        );
        // Ticket 1061: the unset default (beside the repository) stays known after the setting moves; ticket 1083: so does the
        // folder it was called until then.
        for d in [None, Some(Path::new(PREVIOUS_DEFAULT_DIR))] {
            roots.extend(
                worktree_root_for(d, project, &self.user_home)
                    .and_then(|r| fs::canonicalize(r).map_err(|e| e.to_string()))
                    .ok(),
            );
        }
        roots.extend(fs::canonicalize(self.home.join("worktrees")).ok());
        Ok(roots)
    }
    fn missing_path(path: &Path) -> Result<bool, String> {
        match fs::canonicalize(path) {
            Ok(canonical) if canonical == path => Ok(false),
            Ok(_) => Err("invalid aliased worktree path".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                for ancestor in path.ancestors() {
                    match fs::symlink_metadata(ancestor) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(e.to_string()),
                        Ok(meta) => {
                            if meta.file_type().is_symlink()
                                || fs::canonicalize(ancestor).map_err(|e| e.to_string())?
                                    != ancestor
                            {
                                return Err("invalid aliased worktree path".into());
                            }
                            return Ok(true);
                        }
                    }
                }
                Err("invalid worktree path".into())
            }
            Err(e) => Err(e.to_string()),
        }
    }
    /// Ticket 403 item 5: the ref reads go through `git_read` (scrubbed environment, no configured program, the error
    /// without a URL user part).
    fn git(project: &Path, args: &[String]) -> Result<String, String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::process::git_read(project, &args, GIT_WORKTREE)
            .map(|o| String::from_utf8_lossy(&o).into())
            .map_err(|e| format!("git worktree: {e}"))
    }
}
