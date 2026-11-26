//! Ticket 1040 (Settings > Projects): the folder states of the list, and Locate: a project whose folder moved keeps
//! what the core stores under its old path. One edit, all or nothing: every store file is kept as it was before the
//! first write, and a step that fails puts them all back.
//!
//! Moved: tree.toml (group, pin, added, name), the icon file, settings.json (`worktree.scripts`, `worktree.shared`),
//! sessions.json (project, and a folder under it), worktrees.json, ledger.json, notes.json, the team (team/bots.json;
//! team/team.json before ticket 1168's move) and the room's folder.
//! Never moved, they fail closed (coordinator 2026-11-22): what the owner granted for the old folder is dropped and
//! asked again at the new one: `permission_answers` (verified-yes), the repo setup script's approval and the API tokens
//! limited to the project. The project's schedules move switched off, so nothing runs until the owner turns them on.
//! Not touched: a pending owner ask (queue.json), a machine's folder map (`machines`), import.json (where a transcript
//! came from) and the agents' own stores.
use super::*;
use crate::tree::moved_path;
use std::sync::Mutex;

pub(crate) const ALREADY: &str = "That folder is already a project in Nunchiro.";
pub(crate) const RUNNING: &str = "Stop this project's sessions, then try again.";
/// The stores Locate may write, under the core's home.
const STORES: [&str; 11] = [
    "tree.toml",
    "sessions.json",
    "settings.json",
    "ledger.json",
    "notes.json",
    "team/team.json",
    "team/bots.json", // ticket 1168: where a located project's bots are written
    "worktrees.json",
    "approvals.json",
    "tokens.json",
    "schedules.json",
];

/// The folder state of every known project. The stats run off the registry lock (a stalled mount holds this reply only).
pub fn folders(registry: &Mutex<Sessions>) -> Response {
    let projects = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .project_roots();
    let state = |p: String| {
        let state =
            crate::tree::folder_state_within(Path::new(&p), crate::tree::FOLDER_CHECK_BOUND);
        (p, state)
    };
    Ok(Reply::ProjectFolders {
        folders: projects.into_iter().map(state).collect(),
    })
}

/// The picked folder is checked on disk off the registry lock, as an added one; the edit runs under it.
pub fn serve(registry: &Mutex<Sessions>, from: &str, to: &str) -> Response {
    let to = crate::tree::located_within(to)?;
    registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .project_locate(from, &to)
}

/// Files as they were before the edit.
struct Before(Vec<(PathBuf, Option<Vec<u8>>)>);
impl Before {
    fn keep(&mut self, path: PathBuf) -> Result<(), String> {
        // A regular file only, with sessions.json's own size cap: a link is not read through, and a FIFO planted at a
        // store's name cannot hold the registry lock.
        let read = store::open_regular(&path).and_then(|file| store::read_capped(file, 64 << 20));
        let old = match read {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        self.0.push((path, old));
        Ok(())
    }
    /// Every kept file is as it was again; one that cannot be put back is logged, and the rest still are.
    fn back(self) {
        for (path, old) in self.0 {
            let put = match old {
                Some(bytes) if store::read_regular(&path).is_ok_and(|now| now == bytes) => Ok(()),
                Some(bytes) => store::atomic_write(&path, &bytes),
                None => match fs::remove_file(&path) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                    _ => Ok(()),
                },
            };
            if let Err(e) = put {
                eprintln!("locate: {} was not put back: {e}", path.display());
            }
        }
    }
}

impl Sessions {
    fn project_locate(&mut self, from: &str, to: &str) -> Response {
        let tree = self.tree.as_ref().map_err(Clone::clone)?;
        if store::kept_aside(&self.home, "sessions.json") {
            return Err(
                "a set-aside sessions.json is kept: its sessions would stay at the old folder"
                    .into(),
            );
        }
        let known = self.project_roots();
        if known.contains(to) {
            return Err(ALREADY.into());
        }
        if !known.contains(from) {
            return Err("unknown project".into());
        }
        let (old, new) = (Path::new(from), Path::new(to));
        let running = |e: &Entry| e.meta.project == old && e.meta.state == SessionState::Running;
        if self.entries.values().any(running) {
            return Err(RUNNING.into());
        }
        let next = tree.moved(from, to)?;
        let home = self.home.clone();
        let mut before = Before(vec![]);
        let icons = [old, new].map(|p| crate::projects::icon_files(&home, p));
        for file in STORES
            .map(|f| home.join(f))
            .into_iter()
            .chain(icons.concat())
        {
            before.keep(file)?;
        }
        let rows = self.rows_located(old, new);
        match self.stores_located(old, new, &next) {
            Ok(settings) => {
                self.tree = Ok(next.clone());
                self.settings = settings.unwrap_or_else(|| self.settings.clone());
                for icon in crate::projects::icon_files(&home, old) {
                    let _ = fs::remove_file(icon); // its copy is at the new name
                }
                Ok(Reply::ProjectLocated {
                    project: to.into(),
                    tree: next,
                })
            }
            Err(e) => {
                before.back();
                self.schedules = crate::schedule::Schedules::load(&home);
                for (id, project, cwd) in rows {
                    let closing = self.closing.as_mut().map(|c| &mut c.entry);
                    let row = closing.filter(|e| e.meta.id == id);
                    if let Some(entry) = row.or(self.entries.get_mut(&id)) {
                        (entry.meta.project, entry.meta.cwd) = (project, cwd);
                    }
                }
                Err(e)
            }
        }
    }

    /// The project's session rows (the one in its close-undo window too) at the new folder; what they were, to put back.
    fn rows_located(&mut self, from: &Path, to: &Path) -> Vec<(String, PathBuf, PathBuf)> {
        let closing = self.closing.as_mut().map(|c| &mut c.entry);
        let mine = self.entries.values_mut().chain(closing);
        mine.filter(|e| e.meta.project == from)
            .map(|e| {
                let cwd = moved_path(&e.meta.cwd, from, to).unwrap_or_else(|| e.meta.cwd.clone());
                let was = std::mem::replace(&mut e.meta.project, to.into());
                (
                    e.meta.id.clone(),
                    was,
                    std::mem::replace(&mut e.meta.cwd, cwd),
                )
            })
            .collect()
    }

    /// Every store on disk at the new path, each through its own writer. The settings to hold when they changed.
    fn stores_located(
        &mut self,
        from: &Path,
        to: &Path,
        tree: &crate::tree::Tree,
    ) -> Result<Option<Settings>, String> {
        let home = self.home.clone();
        tree.save(&home)?;
        let settings = settings_located(&home, from, to)?;
        crate::ledger::Ledger::open(&home).locate(from, to)?;
        crate::notes::Notes::open(&home).locate(from, to)?;
        crate::team::Team::open(&home).locate(from, to)?;
        worktrees_located(&home, from, to)?;
        // Grants fail closed: the old folder's are dropped, none is carried to the new one.
        crate::tokens::revoke_project(&home, from)?;
        setup_approval_dropped(&home, from)?;
        self.schedules.locate(from, to)?; // moved switched off
        self.save()?;
        for (old, new) in crate::projects::icon_files(&home, from)
            .into_iter()
            .zip(crate::projects::icon_files(&home, to))
        {
            let _ = fs::remove_file(&new); // an icon left by a project removed from this folder
            if let Ok(bytes) = store::read_regular(&old) {
                store::atomic_write(&new, &bytes)?;
            }
        }
        // Last, as a rename has no way back here: nothing after it can fail.
        // shortcut: a room already at the new folder (of a project removed from it) stays, and this project's room is
        // left where it was; merge the two logs if someone meets it.
        let rooms = [from, to].map(|p| crate::room::Log::open(&home, p).dir().to_path_buf());
        if rooms[0].is_dir() && !rooms[1].exists() {
            fs::rename(&rooms[0], &rooms[1]).map_err(|e| format!("room: {e}"))?;
        }
        Ok(settings)
    }
}

/// The repo setup script's approval of the old folder is forgotten: the new folder's script is asked about again.
fn setup_approval_dropped(home: &Path, from: &Path) -> Result<(), String> {
    let mut approvals = crate::approval::store::load(home)?;
    let setup = crate::approval::SubjectKind::Setup;
    let name = crate::approval::setup_name(from);
    if approvals.find(setup, &name).is_none() {
        return Ok(());
    }
    approvals.remove(setup, &name);
    approvals.save(home)
}

/// settings.json with the project's own values under the new path: its setup scripts and shared files. Its
/// verified-yes switch (`permission_answers`) is dropped, not moved. None when it holds none of them.
fn settings_located(home: &Path, from: &Path, to: &Path) -> Result<Option<Settings>, String> {
    let (Some(from), Some(to)) = (from.to_str(), to.to_str()) else {
        return Ok(None);
    };
    let path = home.join("settings.json");
    let mut file = settings_file(&path)?;
    let mut changed = false;
    for (at, moves) in [
        ("/features/worktree.scripts", true),
        ("/features/worktree.shared", true),
        ("/permission_answers", false),
    ] {
        let map = file.pointer_mut(at).and_then(|v| v.as_object_mut());
        if let Some(map) = map
            && let Some(value) = map.remove(from)
        {
            if moves {
                map.insert(to.into(), value);
            }
            changed = true;
        }
    }
    if !changed {
        return Ok(None);
    }
    let next =
        serde_json::from_value(file.clone()).map_err(|e| format!("invalid settings: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
    Ok(Some(next))
}

/// worktrees.json under its own lock, as every worktree operation: the project's records, and their folders when the
/// worktrees lie inside the project. Git's own links of a moved repository are the user's `git worktree repair`.
fn worktrees_located(home: &Path, from: &Path, to: &Path) -> Result<(), String> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let file = home.join("worktrees.json");
    if !file.exists() {
        return Ok(());
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(home.join("worktrees.lock"))
        .map_err(|e| e.to_string())?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        if std::time::Instant::now() >= until {
            return Err(WORKTREE_BUSY.into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let Some(bytes) = read_worktree_store(&file)? else {
        return Ok(());
    };
    let mut disk: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid worktree store: {e}"))?;
    let records = disk.get_mut("worktrees").and_then(|w| w.as_array_mut());
    let mut changed = false;
    for record in records.into_iter().flatten() {
        if record
            .get("project")
            .and_then(|p| p.as_str())
            .map(Path::new)
            != Some(from)
        {
            continue;
        }
        for key in ["project", "path", "root"] {
            let at = record.get(key).and_then(|p| p.as_str()).map(Path::new);
            if let Some(next) = at.and_then(|p| moved_path(p, from, to)) {
                record[key] = serde_json::json!(next);
                changed = true;
            }
        }
    }
    if changed {
        let bytes = serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?;
        store::atomic_write(&file, &bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-locate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn settings_and_worktrees_follow_the_project_and_its_grants_are_dropped() {
        let dir = home("stores");
        let (old, new, other) = (
            Path::new("/w/old-blog"),
            Path::new("/w/blog-2024"),
            "/w/api",
        );
        // settings.json: the project's own values move; another project's, and a value that only looks alike, stay.
        let scripts = json!({"setup": "make"});
        fs::write(
            dir.join("settings.json"),
            json!({"keep_awake": true, "permission_answers": {"/w/old-blog": true, other: true},
                "features": {"worktree.scripts": {"/w/old-blog": scripts, "/w/old-blog-2": scripts},
                    "worktree.shared": {other: {"files": [], "sparse": ["a"]}}, "editor.app": "/w/old-blog"}})
            .to_string(),
        )
        .unwrap();
        let next = settings_located(&dir, old, new).unwrap().unwrap();
        // The verified-yes switch is dropped, not moved; another project's stays.
        assert_eq!(next.permission_answers.get(new), None);
        assert_eq!(next.permission_answers.len(), 1);
        assert_eq!(
            read(&dir.join("settings.json")),
            json!({"keep_awake": true, "permission_answers": {other: true},
                "features": {"worktree.scripts": {"/w/blog-2024": scripts, "/w/old-blog-2": scripts},
                    "worktree.shared": {other: {"files": [], "sparse": ["a"]}}, "editor.app": "/w/old-blog"}})
        );
        assert!(settings_located(&dir, old, new).unwrap().is_none());

        // worktrees.json: the project's records, and a worktree folder inside the project; another project's stay.
        let record = |project: &str, path: &str| json!({"project": project, "path": path, "branch": "b", "label": "l", "root": "/wt"});
        fs::write(
            dir.join("worktrees.json"),
            json!({"version": 1, "worktrees": [record("/w/old-blog", "/wt/old-blog/a"),
                record("/w/old-blog", "/w/old-blog/.wt/b"), record(other, "/w/old-blog/x")]})
            .to_string(),
        )
        .unwrap();
        worktrees_located(&dir, old, new).unwrap();
        assert_eq!(
            read(&dir.join("worktrees.json"))["worktrees"],
            json!([
                record("/w/blog-2024", "/wt/old-blog/a"),
                record("/w/blog-2024", "/w/blog-2024/.wt/b"),
                record(other, "/w/old-blog/x")
            ])
        );

        // tokens.json: a token limited to the project is revoked; one for every project is as it was.
        let real = fs::canonicalize(&dir).unwrap();
        let (mine, secret) =
            crate::tokens::create(&dir, crate::tokens::Scope::Read, Some(&real), None).unwrap();
        let (all, _) = crate::tokens::create(&dir, crate::tokens::Scope::Read, None, None).unwrap();
        crate::tokens::revoke_project(&dir, &real).unwrap();
        let listed = crate::tokens::list(&dir).unwrap();
        assert_eq!(listed.iter().map(|t| &t.id).collect::<Vec<_>>(), [&all.id]);
        assert!(
            crate::tokens::verify(&dir, &secret).is_none(),
            "{}",
            mine.id
        );

        // approvals.json: the old folder's setup-script approval is forgotten and the new folder has none; another
        // project's stays.
        let script = "pnpm install";
        let hash = crate::approval::setup_status(&dir, old, old, script)
            .unwrap()
            .hash;
        for project in [old, Path::new(other)] {
            crate::approval::grant_setup(&dir, project, project, script, &hash).unwrap();
        }
        setup_approval_dropped(&dir, old).unwrap();
        let state = |p: &Path| {
            crate::approval::setup_status(&dir, p, p, script)
                .unwrap()
                .state
        };
        use crate::approval::State;
        assert_eq!(
            [state(old), state(new), state(Path::new(other))],
            [State::Unapproved, State::Unapproved, State::Approved]
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
