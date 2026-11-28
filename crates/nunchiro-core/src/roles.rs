//! Ticket 990 slice i: roles (concept approved by the owner on 2026-11-16 night). A role is the user's: a name, what it
//! does, and the agent and model it runs with. It is the same in every project, has no memory of its own (what it
//! learned is a note with the role's scope) and no permissions of its own (the project grants those). A seat is one
//! session of a role on one task, named "<Role> · <task>".
//!
//! Nothing to register: Builder and Reviewer exist with no setup. A lead proposes a new role on a card
//! (`OwnerAsk::Role`); only the user's yes adds it. One file, `<home>/roles.json`, written only once a role differs
//! from the defaults.
use crate::api::AgentKind;
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What `store::read_regular` reads.
const FILE_MAX: u64 = store::READ_MAX;
const ROLES_MAX: usize = 30;
const NAME_MAX: usize = 40;
const JOB_MAX: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Role {
    pub name: String,
    /// What a seat of this role does, in a few lines: it opens the seat's first prompt.
    pub job: String,
    pub kind: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Whether its seats change files. One live writer per worktree.
    pub writes: bool,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    roles: Vec<Role>,
}

static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct Roles {
    file: PathBuf,
}

/// The two roles every user has with no setup.
pub fn defaults() -> Vec<Role> {
    vec![
        Role {
            name: "Builder".into(),
            job: "Build the task in its worktree: the change, its tests, and a short report of what you did and \
                  what you did not check. Ask your lead when the task does not say (`nunchiro agent ask`). Propose \
                  a lesson worth keeping with `nunchiro task learn`."
                .into(),
            kind: AgentKind::Claude,
            model: None,
            effort: None,
            writes: true,
        },
        Role {
            name: "Reviewer".into(),
            job: "Review the task's change against its acceptance conditions for the files as they are now. Read \
                  the code around the diff and run the checks. Do not edit files. Record the verdict with \
                  `nunchiro task pass \"<one line>\"` or `nunchiro task changes \"<what must change>\"`."
                .into(),
            kind: AgentKind::Claude,
            model: None,
            effort: None,
            writes: false,
        },
    ]
}

fn line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
    flat.chars().take(max).collect()
}

/// A role as it may be stored: one-line name with no seat separator, a job, and Claude or Codex (a role's job is typed
/// into its session, so a shell is never a role).
pub fn checked(role: Role) -> Result<Role, String> {
    let name = line(&role.name, NAME_MAX);
    if name.is_empty() || name.contains('·') {
        return Err("a role needs a short name without `·`".into());
    }
    let job = line(&role.job, JOB_MAX);
    if job.is_empty() {
        return Err("a role needs what it does, in a line or two".into());
    }
    if !matches!(role.kind, AgentKind::Claude | AgentKind::Codex) {
        return Err("a role runs Claude or Codex".into());
    }
    crate::sessions::check_model(role.kind, role.model.as_deref(), role.effort.as_deref())?;
    Ok(Role { name, job, ..role })
}

impl Roles {
    pub fn open(home: &Path) -> Self {
        Self {
            file: home.join("roles.json"),
        }
    }

    /// The user's roles; the defaults until the file exists.
    pub fn list(&self) -> Result<Vec<Role>, String> {
        let bytes = match store::read_regular(&self.file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(defaults()),
            Err(e) => return Err(e.to_string()),
        };
        let stored: Stored =
            serde_json::from_slice(&bytes).map_err(|e| format!("roles.json: {e}"))?;
        if stored.version != 1 {
            return Err(format!(
                "roles.json has version {}, this build reads 1",
                stored.version
            ));
        }
        // The file is not signed and a role's job is typed into a session: each one is checked again as it is read.
        // Q9 pin-J24-1: a model or effort a later build retired falls back to the agent's default; it fails no list
        // (and so no `get`, which would make a reviewer seat a writer).
        let current = |role: Role| match crate::sessions::check_model(
            role.kind,
            role.model.as_deref(),
            role.effort.as_deref(),
        ) {
            Err(e) if matches!(role.kind, AgentKind::Claude | AgentKind::Codex) => {
                eprintln!("roles.json: {}: {e}, using the agent's default", role.name);
                Role {
                    model: None,
                    effort: None,
                    ..role
                }
            }
            _ => role,
        };
        stored.roles.into_iter().map(current).map(checked).collect()
    }

    pub fn get(&self, name: &str) -> Option<Role> {
        let name = name.trim().to_lowercase();
        self.list()
            .ok()?
            .into_iter()
            .find(|r| r.name.to_lowercase() == name)
    }

    /// Adds the role, or replaces the one of the same name.
    pub fn save(&self, role: Role) -> Result<Vec<Role>, String> {
        let role = checked(role)?;
        let _one = CHANGE.lock().map_err(|_| "roles unavailable".to_string())?;
        let mut all = self.list()?;
        let at = all
            .iter()
            .position(|r| r.name.to_lowercase() == role.name.to_lowercase());
        match at {
            Some(at) => all[at] = role,
            None if all.len() >= ROLES_MAX => {
                return Err(format!("at most {ROLES_MAX} roles"));
            }
            None => all.push(role),
        }
        self.write(&all)?;
        Ok(all)
    }

    /// Removes a role. Builder and Reviewer stay: the default way of working needs both.
    pub fn remove(&self, name: &str) -> Result<Vec<Role>, String> {
        let name = name.trim().to_lowercase();
        if ["builder", "reviewer"].contains(&name.as_str()) {
            return Err("Builder and Reviewer stay; change their model instead".into());
        }
        let _one = CHANGE.lock().map_err(|_| "roles unavailable".to_string())?;
        let mut all = self.list()?;
        let before = all.len();
        all.retain(|r| r.name.to_lowercase() != name);
        if all.len() == before {
            return Err(format!("no role {name}"));
        }
        self.write(&all)?;
        Ok(all)
    }

    fn write(&self, roles: &[Role]) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&Stored {
            version: 1,
            roles: roles.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        store::write_capped(&self.file, &bytes, FILE_MAX)
    }
}

/// A seat's name: the role and its assignment.
pub fn seat_name(role: &str, task: &str) -> String {
    let task = task.trim();
    let Some((at, next)) = task.char_indices().nth(40) else {
        return format!("{role} · {task}");
    };
    // Look 1117 v9 (B N-S3-5): a long task is cut after its last whole word, and says so with "…".
    let head = &task[..at];
    let head = match head.rsplit_once(char::is_whitespace) {
        Some((words, _)) if !next.is_whitespace() => words,
        _ => head,
    };
    format!("{role} · {}…", head.trim_end())
}

/// The role a session's name says, and whether it writes: "<Role> · <task>" for a role the user has; else the older
/// rule (a name that starts with `review` reviews, any other agent builds), so a lead that names its sessions the
/// guide's old way still gets one writer and a reviewer.
pub fn of(home: &Path, name: &str) -> (String, bool) {
    if let Some((role, _)) = name.split_once('·')
        && let Some(role) = Roles::open(home).get(role)
    {
        return (role.name.to_lowercase(), role.writes);
    }
    if name.trim().to_lowercase().starts_with("review") {
        ("reviewer".into(), false)
    } else {
        ("builder".into(), true)
    }
}

/// `Request::Role`.
pub(crate) fn serve(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    operation: String,
    role: Option<Role>,
    name: Option<String>,
    why: Option<String>,
) -> crate::api::Response {
    let lock = || {
        registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())
    };
    let (home, who) = {
        let sessions = lock()?;
        (
            sessions.home().to_path_buf(),
            sessions.task_caller(caller, None)?,
        )
    };
    let roles = Roles::open(&home);
    let owner = who.session.is_none();
    match operation.as_str() {
        "list" => {}
        "save" if owner => {
            roles.save(role.ok_or("a role to save")?)?;
        }
        "remove" if owner => {
            roles.remove(name.as_deref().ok_or("name the role")?)?;
        }
        "save" | "remove" => return Err("only the user changes roles".into()),
        "propose" => {
            let (Some(session), true) = (&who.session, who.decides) else {
                return Err("only the lead of a place proposes a role".into());
            };
            let role = checked(role.ok_or("a role to propose")?)?;
            if roles.get(&role.name).is_some() {
                return Err(format!("the role {} already exists", role.name));
            }
            let why = line(why.as_deref().unwrap_or_default(), JOB_MAX);
            if why.is_empty() {
                return Err("say why in a line: what you counted (--why)".into());
            }
            let place = who.place.clone().ok_or("no place for this session")?;
            lock()?.ask_role(session, role, why, place)?;
        }
        _ => return Err("unknown role operation".into()),
    }
    Ok(crate::api::Reply::Roles {
        roles: roles.list()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("roles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn two_roles_with_no_setup_and_a_new_one_is_the_users() {
        let home = home("list");
        let roles = Roles::open(&home);
        assert_eq!(
            roles
                .list()
                .unwrap()
                .iter()
                .map(|r| (r.name.as_str(), r.writes))
                .collect::<Vec<_>>(),
            [("Builder", true), ("Reviewer", false)]
        );
        assert!(!home.join("roles.json").exists(), "a read writes nothing");
        // A seat's name says its role; an unknown word before the dot, or the guide's old names, fall back.
        assert_eq!(of(&home, "Reviewer · tax"), ("reviewer".into(), false));
        assert_eq!(of(&home, "builder · tax"), ("builder".into(), true));
        assert_eq!(of(&home, "review-tax"), ("reviewer".into(), false));
        assert_eq!(of(&home, "lane-tax"), ("builder".into(), true));
        assert_eq!(
            of(&home, "Frontend reviewer · header"),
            ("builder".into(), true)
        );
        assert_eq!(
            seat_name("Reviewer", " Tax in integer cents "),
            "Reviewer · Tax in integer cents"
        );
        assert_eq!(
            seat_name(
                "Builder",
                "Create w2.txt containing the word the user picks"
            ),
            "Builder · Create w2.txt containing the word the…"
        );

        let new = Role {
            name: " Frontend   reviewer ".into(),
            job: "Review web/ for style\nand accessibility.".into(),
            kind: AgentKind::Claude,
            model: None,
            effort: None,
            writes: false,
        };
        let all = roles.save(new.clone()).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            (all[2].name.as_str(), all[2].job.as_str()),
            (
                "Frontend reviewer",
                "Review web/ for style and accessibility."
            )
        );
        assert_eq!(
            of(&home, "Frontend reviewer · header"),
            ("frontend reviewer".into(), false)
        );
        // The same name again replaces; a shell, a name with the seat separator, and an empty job are refused.
        assert_eq!(roles.save(new.clone()).unwrap().len(), 3);
        for bad in [
            Role {
                kind: AgentKind::Shell,
                ..new.clone()
            },
            Role {
                name: "A · B".into(),
                ..new.clone()
            },
            Role {
                job: "  ".into(),
                ..new.clone()
            },
        ] {
            assert!(roles.save(bad).is_err());
        }
        assert!(roles.remove("reviewer").is_err());
        assert_eq!(roles.remove("FRONTEND REVIEWER").unwrap().len(), 2);
        assert!(roles.get("frontend reviewer").is_none());
    }

    /// Q9 pin-J24-1: a stored role whose model a newer build retired still lists, gets and saves.
    #[test]
    fn a_retired_model_falls_back_to_the_default() {
        let home = home("retired");
        let mut all = defaults();
        all[1].model = Some("retired-model".into());
        all[1].effort = Some("high".into());
        std::fs::write(
            home.join("roles.json"),
            serde_json::json!({"version": 1, "roles": all}).to_string(),
        )
        .unwrap();
        let roles = Roles::open(&home);
        let reviewer = roles.get("reviewer").unwrap();
        assert_eq!(
            (reviewer.model, reviewer.effort, reviewer.writes),
            (None, None, false)
        );
        assert_eq!(of(&home, "Reviewer · tax"), ("reviewer".into(), false));
        assert!(roles.remove("builder").is_err());
        assert_eq!(roles.save(defaults()[0].clone()).unwrap().len(), 2);
    }
}
