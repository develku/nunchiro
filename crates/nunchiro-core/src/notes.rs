//! Ticket 990 slice h: notes (concept approved by the owner on 2026-11-16 night). A note is a lesson of one or two lines
//! that the user accepted on a card. It has a scope (about the user, a role's craft, or one project and maybe an area
//! of it), a source and a date, and the user edits or removes it line by line. Nothing an agent writes becomes a note
//! by itself: a seat proposes a lesson on its task (`ledger::Lesson`), and only the user's yes on the merge card
//! copies it here. A dropped task's lessons go with it.
//!
//! One file, `<home>/notes.json`. The repo's own rule files are not written (not yet: the user exports by hand).
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_MAX: u64 = 4 << 20;
const NOTES_MAX: usize = 1000;
pub const TEXT_MAX: usize = 300;
/// What one brief quotes, newest first: about 2,000 tokens.
const QUOTE_MAX: usize = 6 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "NotesScope"))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    /// About the user: every seat everywhere reads it.
    Me,
    /// A role's craft: every seat of that role reads it, in every project.
    Role { role: String },
    /// One project; `area` is a folder of it (repo-relative) when the lesson is about that part only.
    Project {
        project: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Note {
    pub id: String,
    pub text: String,
    pub scope: Scope,
    /// Who learned it and where, in plain words ("Reviewer · review-tax, task t3: Tax in cents").
    pub source: String,
    /// A repo-relative file the lesson is about; the list flags the note when the file is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cites: Option<String>,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited: Option<u64>,
}

/// A note as the list shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "NotesListed"))]
pub struct Listed {
    #[serde(flatten)]
    pub note: Note,
    /// The cited file is no longer in the project: the lesson may be out of date.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    next: u32,
    notes: Vec<Note>,
}

static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct Notes {
    file: PathBuf,
}

pub(crate) fn line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // A note is read by agents and shown in lists: what the logs mask is masked here too.
    let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
    flat.chars().take(TEXT_MAX).collect()
}

/// A repo-relative path with no way out of the project; anything else is dropped, not joined.
pub(crate) fn inside(path: &str) -> Option<String> {
    let p = Path::new(path.trim());
    let fine = !path.trim().is_empty()
        && path.len() <= 512
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
    fine.then(|| path.trim().to_string())
}

impl Notes {
    pub fn open(home: &Path) -> Self {
        Self {
            file: home.join("notes.json"),
        }
    }

    fn read(&self) -> Result<Stored, String> {
        let bytes = match store::open_regular(&self.file)
            .and_then(|file| store::read_capped(file, FILE_MAX))
        {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Stored {
                    version: 1,
                    next: 1,
                    notes: vec![],
                });
            }
            Err(e) => return Err(format!("notes.json: {e}")),
        };
        let stored: Stored =
            serde_json::from_slice(&bytes).map_err(|e| format!("notes.json: {e}"))?;
        if stored.version != 1 {
            return Err(format!(
                "notes.json has version {}, this build reads 1",
                stored.version
            ));
        }
        Ok(stored)
    }

    /// Ticket 1040 (Locate): the project's notes follow it to its new folder. No file is made where there was none.
    pub(crate) fn locate(&self, from: &Path, to: &Path) -> Result<(), String> {
        let of = |n: &Note| matches!(&n.scope, Scope::Project { project, .. } if project == from);
        if !self.read()?.notes.iter().any(of) {
            return Ok(());
        }
        self.change(|stored| {
            for note in &mut stored.notes {
                if let Scope::Project { project, .. } = &mut note.scope
                    && project == from
                {
                    *project = to.into();
                }
            }
            Ok(())
        })
    }

    fn change<T>(&self, f: impl FnOnce(&mut Stored) -> Result<T, String>) -> Result<T, String> {
        let _one = CHANGE.lock().map_err(|_| "notes unavailable".to_string())?;
        let mut stored = self.read()?;
        let out = f(&mut stored)?;
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
        // Never a file its own reader refuses.
        store::write_capped(&self.file, &bytes, FILE_MAX)?;
        Ok(out)
    }

    /// Every note, newest first, each flagged when its cited file is gone.
    pub fn list(&self) -> Result<Vec<Listed>, String> {
        let mut notes = self.read()?.notes;
        notes.sort_by_key(|n| std::cmp::Reverse(n.at));
        Ok(notes
            .into_iter()
            .map(|note| {
                let missing = match (&note.scope, &note.cites) {
                    (Scope::Project { project, .. }, Some(file)) => {
                        project.join(file).symlink_metadata().is_err()
                    }
                    _ => false,
                };
                Listed { note, missing }
            })
            .collect())
    }

    /// The user's yes: one new note. The same words in the same scope are one note.
    pub fn keep(
        &self,
        text: &str,
        scope: Scope,
        source: &str,
        cites: Option<&str>,
        now: u64,
    ) -> Result<Note, String> {
        let text = line(text);
        if text.is_empty() {
            return Err("a note needs its lesson in a line or two".into());
        }
        let scope = match scope {
            Scope::Role { role } => {
                let role = line(&role).to_lowercase();
                if role.is_empty() || role.len() > 40 {
                    return Err("a role note names its role".into());
                }
                Scope::Role { role }
            }
            Scope::Project { project, area } => Scope::Project {
                // The place a seat is matched by is the project's real path (`/private/var/…` for `/var/…`): a note
                // kept under another spelling of the same folder reached no seat (real run 11-17).
                project: std::fs::canonicalize(&project).unwrap_or(project),
                area: area.as_deref().and_then(inside),
            },
            Scope::Me => Scope::Me,
        };
        self.change(|s| {
            if let Some(same) = s.notes.iter().find(|n| n.scope == scope && n.text == text) {
                return Ok(same.clone());
            }
            if s.notes.len() >= NOTES_MAX {
                return Err(format!(
                    "the list holds at most {NOTES_MAX} notes; remove some first"
                ));
            }
            let note = Note {
                id: format!("n{}", s.next),
                text,
                scope,
                source: line(source),
                cites: cites.and_then(inside),
                at: now,
                edited: None,
            };
            s.next += 1;
            s.notes.push(note.clone());
            Ok(note)
        })
    }

    /// The user rewrites one note's words or moves it to another scope.
    pub fn edit(
        &self,
        id: &str,
        text: Option<&str>,
        scope: Option<Scope>,
        now: u64,
    ) -> Result<Note, String> {
        self.change(|s| {
            let n = s
                .notes
                .iter_mut()
                .find(|n| n.id == id)
                .ok_or_else(|| format!("no note {id}"))?;
            if let Some(text) = text {
                let text = line(text);
                if text.is_empty() {
                    return Err("a note needs its lesson in a line or two".into());
                }
                n.text = text;
            }
            if let Some(scope) = scope {
                n.scope = scope;
            }
            n.edited = Some(now);
            Ok(n.clone())
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.change(|s| {
            let before = s.notes.len();
            s.notes.retain(|n| n.id != id);
            if s.notes.len() == before {
                return Err(format!("no note {id}"));
            }
            Ok(())
        })
    }

    /// The notes one seat reads: about the user, its role's, and its project's (an area note only says where it
    /// applies; the seat judges). Newest first.
    pub fn for_seat(&self, project: Option<&Path>, role: Option<&str>) -> Vec<Note> {
        let Ok(listed) = self.list() else {
            return vec![];
        };
        listed
            .into_iter()
            .filter(|l| !l.missing)
            .map(|l| l.note)
            .filter(|n| match &n.scope {
                Scope::Me => true,
                Scope::Role { role: r } => role.is_some_and(|x| x.to_lowercase() == *r),
                Scope::Project { project: p, .. } => project.is_some_and(|x| {
                    x == p
                        || std::fs::canonicalize(x)
                            .is_ok_and(|x| std::fs::canonicalize(p).is_ok_and(|p| x == p))
                }),
            })
            .collect()
    }
}

/// The notes as a block for a brief or a first prompt; empty when there is none. Cut at `QUOTE_MAX`, newest kept.
pub fn quote(notes: &[Note]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Notes the user accepted earlier (lessons from past work; follow them unless the user says otherwise now):\n",
    );
    for n in notes {
        let scope = match &n.scope {
            Scope::Me => "about the user".to_string(),
            Scope::Role { role } => format!("{role} craft"),
            Scope::Project { area: Some(a), .. } => format!("this project, {a}"),
            Scope::Project { .. } => "this project".to_string(),
        };
        let row = format!("- {} ({scope})\n", n.text);
        if out.len() + row.len() > QUOTE_MAX {
            out += "- (older notes are left out)\n";
            break;
        }
        out += &row;
    }
    out
}

/// `Request::Note`. The owner keeps, edits and removes; a session only reads what applies to it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn serve(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    operation: String,
    id: Option<String>,
    text: Option<String>,
    scope: Option<Scope>,
    task: Option<String>,
    lesson: Option<usize>,
) -> crate::api::Response {
    let (home, who) = {
        let sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())?;
        (
            sessions.home().to_path_buf(),
            sessions.task_caller(caller, None)?,
        )
    };
    let notes = Notes::open(&home);
    let now = crate::queue::now_ms();
    if let Some(session) = &who.session {
        if operation != "list" {
            return Err("only the user keeps, edits and removes notes".into());
        }
        // A seat reads its role's notes; the lead and any other session read the place's and the user's.
        let ledger = crate::ledger::Ledger::open(&home);
        let role = ledger
            .of_seat(session)
            .and_then(|t| t.seats.into_iter().find(|s| s.session == *session))
            .map(|s| s.role)
            .or_else(|| who.decides.then(|| "lead".to_string()));
        let listed = notes
            .for_seat(who.place.as_deref(), role.as_deref())
            .into_iter()
            .map(|note| Listed {
                note,
                missing: false,
            })
            .collect();
        return Ok(crate::api::Reply::Notes { notes: listed });
    }
    match operation.as_str() {
        "list" => {}
        "keep" => {
            let scope = scope.ok_or("a note needs its scope")?;
            match task {
                // A lesson from a task's merge card: its words unless the user rewrote them on the card.
                Some(task) => {
                    let ledger = crate::ledger::Ledger::open(&home);
                    let t = ledger
                        .list()?
                        .into_iter()
                        .find(|t| t.id == task)
                        .ok_or_else(|| format!("no task {task}"))?;
                    if t.closed.is_some() {
                        return Err(format!(
                            "task {} is closed; nothing is kept from a closed task",
                            t.id
                        ));
                    }
                    // The user's yes is to the lesson as the merge card shows it. A seat that proposes other lessons
                    // after the card opened changes the task, not the card, so the card's own copy is what is kept.
                    let shown = registry
                        .lock()
                        .map_err(|_| "session registry unavailable".to_string())?
                        .merge_lessons(&t.id)
                        .ok_or("this task has no merge card: a lesson is kept from its card")?;
                    let l = shown
                        .get(lesson.ok_or("name the lesson by its number")?)
                        .ok_or("no such lesson on this task's card")?;
                    notes.keep(
                        text.as_deref().unwrap_or(&l.text),
                        scope,
                        &format!("{}, task {}: {}", l.name, t.id, t.title),
                        l.cites.as_deref(),
                        now,
                    )?;
                }
                None => {
                    notes.keep(
                        text.as_deref().unwrap_or_default(),
                        scope,
                        "the user",
                        None,
                        now,
                    )?;
                }
            }
        }
        "edit" => {
            notes.edit(
                id.as_deref().ok_or("name the note")?,
                text.as_deref(),
                scope,
                now,
            )?;
        }
        "remove" => notes.remove(id.as_deref().ok_or("name the note")?)?,
        _ => return Err("unknown note operation".into()),
    }
    Ok(crate::api::Reply::Notes {
        notes: notes.list()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("notes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn a_project_note_reaches_a_seat_under_any_spelling_of_the_folder() {
        let home = home("spelling");
        let proj = home.join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let link = home.join("link");
        std::os::unix::fs::symlink(&proj, &link).unwrap();
        let notes = Notes::open(&home);
        let scope = Scope::Project {
            project: link.clone(),
            area: None,
        };
        let kept = notes.keep("Money is integer cents.", scope, "the user", None, 1);
        assert_eq!(
            kept.unwrap().scope,
            Scope::Project {
                project: proj.clone(),
                area: None
            },
            "stored under the real path"
        );
        assert_eq!(notes.for_seat(Some(&proj), Some("builder")).len(), 1);
        assert_eq!(notes.for_seat(Some(&link), Some("builder")).len(), 1);
        assert_eq!(notes.for_seat(Some(&home.join("other")), None).len(), 0);
        assert_eq!(notes.for_seat(Some(&home.join("gone")), None).len(), 0);
    }

    #[test]
    fn notes_are_kept_once_edited_removed_and_flagged() {
        let home = home("list");
        let proj = home.join("p");
        std::fs::create_dir_all(proj.join("shop")).unwrap();
        std::fs::write(proj.join("shop/codes.py"), "x").unwrap();
        let notes = Notes::open(&home);
        let here = || Scope::Project {
            project: proj.clone(),
            area: Some("shop".into()),
        };
        let a = notes
            .keep(
                "Codes are stored  lower-case:\ncompare lower-case.",
                here(),
                "Builder · lane-discount, task t3: Discount codes",
                Some("shop/codes.py"),
                10,
            )
            .unwrap();
        assert_eq!(
            (a.id.as_str(), a.text.as_str()),
            ("n1", "Codes are stored lower-case: compare lower-case.")
        );
        // The same lesson accepted again is the same note.
        assert_eq!(
            notes
                .keep(
                    "Codes are stored lower-case: compare lower-case.",
                    here(),
                    "x",
                    None,
                    11
                )
                .unwrap()
                .id,
            "n1"
        );
        let b = notes
            .keep(
                "A test must fail without the fix.",
                Scope::Role {
                    role: "Reviewer".into(),
                },
                "Reviewer · review-discount",
                None,
                20,
            )
            .unwrap();
        let c = notes
            .keep("Answer in Korean.", Scope::Me, "the user", None, 30)
            .unwrap();
        // A path that leaves the project is never kept as a citation or an area.
        let d = notes
            .keep(
                "x",
                Scope::Project {
                    project: proj.clone(),
                    area: Some("../etc".into()),
                },
                "s",
                Some("/etc/passwd"),
                40,
            )
            .unwrap();
        assert!(
            d.cites.is_none()
                && d.scope
                    == Scope::Project {
                        project: proj.clone(),
                        area: None
                    }
        );
        notes.remove(&d.id).unwrap();

        // Who reads what: a builder here, a reviewer elsewhere, a seat with no role in another project.
        let texts = |project: Option<&Path>, role: Option<&str>| {
            notes
                .for_seat(project, role)
                .into_iter()
                .map(|n| n.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(texts(Some(&proj), Some("builder")), ["n3", "n1"]);
        assert_eq!(texts(Some(&home.join("q")), Some("REVIEWER")), ["n3", "n2"]);
        assert_eq!(texts(None, None), ["n3"]);
        let block = quote(&notes.for_seat(Some(&proj), Some("reviewer")));
        assert!(
            block.contains("- Answer in Korean. (about the user)")
                && block.contains("(reviewer craft)")
                && block.contains("(this project, shop)"),
            "{block}"
        );
        assert_eq!(quote(&[]), "");

        // The user rewrites one and moves it; the cited file goes: the note is flagged and no seat reads it.
        let edited = notes
            .edit(&b.id, Some("A test must fail first."), None, 50)
            .unwrap();
        assert_eq!(
            (edited.text.as_str(), edited.edited),
            ("A test must fail first.", Some(50))
        );
        std::fs::remove_file(proj.join("shop/codes.py")).unwrap();
        let listed = notes.list().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|l| (l.note.id.as_str(), l.missing))
                .collect::<Vec<_>>(),
            [("n3", false), ("n2", false), ("n1", true)]
        );
        assert_eq!(texts(Some(&proj), Some("builder")), ["n3"]);
        notes.remove(&c.id).unwrap();
        assert!(notes.remove(&c.id).is_err());
        assert_eq!(Notes::open(&home).list().unwrap().len(), 2);
    }
}
