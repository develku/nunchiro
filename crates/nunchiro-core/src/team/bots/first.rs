//! A bot in one minute: a name and one sentence make it, and its first chat writes its SOUL file.
//!
//! What only the first chat needs is kept in the bot's own folder, `team/<id>/first.json`: a new file that no
//! earlier build opens. `bots.json` and `team.json` keep their shapes (their loaders refuse a field they do not
//! know), so a home with a new bot still opens in an earlier build, where the bot is a teammate like any other.
//! - The file is written once, when the bot is made, with the SOUL text it was made with.
//! - The first chat lasts until the SOUL file differs from that text; Undo writes that text back.
//! - The file goes when the bot's next conversation starts after that (`first_end`). One this build cannot read is
//!   no first chat: it never stops a seat from opening.
use super::{Bot, Face, SHAPES, TILES};
use crate::api::AgentKind;
use crate::store;
use crate::team::{CHANGE, JOB_MAX, NAME_MAX, Team, Teammate, check};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u32,
    /// The SOUL file as the bot was made with: what "not written yet" means, and what Undo puts back.
    soul: String,
    /// The seat the bot's template asks for (`lead` or `chief`), until the owner answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seat: Option<String>,
}

/// A bot's first chat, as the window draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct First {
    /// The bot wrote its SOUL file: the chat shows it on a card, with Undo.
    pub wrote: bool,
    /// The seat its template asks for: the chat asks the owner where it sits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat: Option<String>,
}
impl First {
    /// What the brief says in place of "say you are ready" (`brief_text`). `soul` is the bot's SOUL file.
    pub(crate) fn rules(&self, soul: &Path) -> String {
        let seat = match self.seat.as_deref() {
            Some(seat) => format!(
                "\n- The user picked the {} template. A card in this chat asks them where you sit; do not ask about a seat yourself.",
                if seat == "chief" { "Chief" } else { "Lead" }
            ),
            None => String::new(),
        };
        format!(
            "\n## Your first chat\n\
             - The user made you a moment ago from the one sentence under \"Your job\". Run no commands yet. Reply now with one short line: a greeting that ends with the one question whose answer you need most to do this job well. No list of what you can do, no choices.\n\
             - When the user answers, do one small real piece of the job right away and show the result in a few lines. If the user hands you a worktree or a task first, start from that instead.\n\
             - Then write your SOUL file yourself ({}): who you are and how you work, in the first person, three to ten short plain lines, from the job and what the user told you. Say in one line that you wrote it; the user reads, edits or undoes it on a card in this chat.{seat}",
            soul.display()
        )
    }
}

impl Team {
    fn first_file(&self, id: &str) -> PathBuf {
        self.dir.join(id).join("first.json")
    }
    fn first_stored(&self, id: &str) -> Option<Stored> {
        if !store::valid_id(id) {
            return None;
        }
        let bytes = store::read_regular(&self.first_file(id)).ok()?;
        let stored: Stored = serde_json::from_slice(&bytes).ok()?;
        (stored.version == 1).then_some(stored)
    }
    fn first_write(&self, id: &str, stored: &Stored) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
        store::atomic_write(&self.first_file(id), &bytes)
    }

    /// The bot's first chat, while it lasts.
    pub fn first(&self, id: &str) -> Option<First> {
        let stored = self.first_stored(id)?;
        let now = store::read_regular(&self.soul(id)).ok()?;
        Some(First {
            wrote: now != stored.soul.as_bytes(),
            seat: stored.seat,
        })
    }

    /// A new bot in one step. `face`: the one the owner picked (one of the 36; kept when no bot has it). `seat`: the
    /// seat its template asks for; nobody sits here, the owner answers that on a card in the first chat.
    pub fn make(
        &self,
        new: Teammate,
        face: Option<Face>,
        seat: Option<String>,
    ) -> Result<Bot, String> {
        if let Some(face) = &face
            && !(SHAPES.contains(&face.shape.as_str()) && TILES.contains(&face.tile.as_str()))
        {
            return Err("a face is one of the six shapes on one of the six tiles".into());
        }
        if seat.as_deref().is_some_and(|s| s != "lead" && s != "chief") {
            return Err("a template asks for the lead or chief seat, or for none".into());
        }
        let _one = CHANGE
            .lock()
            .map_err(|_| "team store unavailable".to_string())?;
        let all = self.save_faced(None, new, face.as_ref())?;
        let id = all.last().map(|t| t.id.clone()).unwrap_or_default();
        let first = self.soul_text(&id).and_then(|soul| {
            self.first_write(
                &id,
                &Stored {
                    version: 1,
                    soul,
                    seat,
                },
            )
        });
        // The bot is made either way: without this file it starts as a teammate always has ("say you are ready").
        if let Err(e) = first {
            eprintln!("bot {id}: its first chat was not prepared: {e}");
        }
        self.bots()?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or_else(|| "the bot was not saved".to_string())
    }

    /// Undo of the first chat's SOUL file: the text the bot was made with is the file again.
    pub fn soul_undo(&self, id: &str) -> Result<String, String> {
        let _one = CHANGE
            .lock()
            .map_err(|_| "team store unavailable".to_string())?;
        self.seat(id)?;
        let stored = self
            .first_stored(id)
            .ok_or("nothing to undo: this bot's first chat is over")?;
        store::atomic_write(&self.soul(id), stored.soul.as_bytes())?;
        Ok(stored.soul)
    }

    /// The owner said where the bot sits, or "not now": the template's question is not asked again.
    pub(super) fn seat_answered(&self, id: &str) {
        if let Some(stored) = self.first_stored(id).filter(|s| s.seat.is_some())
            && let Err(e) = self.first_write(
                id,
                &Stored {
                    seat: None,
                    ..stored
                },
            )
        {
            eprintln!("bot {id}: its seat question stays open: {e}");
        }
    }

    /// The bot's first chat is over (`open_seat`: a new conversation started after it wrote its SOUL file). Under
    /// the store's lock, as every change of this file: a seat answer that read it just before does not write it back.
    pub(crate) fn first_end(&self, id: &str) {
        let Ok(_one) = CHANGE.lock() else { return };
        if let Err(e) = std::fs::remove_file(self.first_file(id))
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("bot {id}: first.json stays: {e}");
        }
    }
}

/// One line as a card shows it: no line break, no control or hidden character (they hide or reorder what the owner
/// reads before a yes), what the logs mask is masked, and cut.
fn line(text: &str, max: usize) -> String {
    let shown: String = text
        .chars()
        .filter(|c| c.is_whitespace() || !(c.is_control() || crate::board::rights::hidden(*c)))
        .collect();
    let flat = shown.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
    flat.chars().take(max).collect()
}
/// The bot a yes on an offer makes: Claude on its newest model, in the offering bot's place.
pub(crate) fn offered(name: String, job: String, project: Option<PathBuf>) -> Teammate {
    Teammate {
        id: String::new(),
        name,
        job,
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project,
        lead: false,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    }
}
impl Team {
    /// A bot's offer of a new bot as its card will show it (name, job, why, who offers), checked as the yes will check
    /// it: an offer the owner could not say yes to is refused here, where the bot still hears why.
    pub(crate) fn offer(
        &self,
        from: &Teammate,
        name: &str,
        job: &str,
        why: &str,
    ) -> Result<(String, String, String, String), String> {
        let why = line(why, 300);
        if why.is_empty() {
            return Err("say why in a line: what you counted (--why)".into());
        }
        let new = offered(
            line(name, NAME_MAX),
            line(job, JOB_MAX),
            from.project.clone(),
        );
        check(&new)?;
        let taken = |t: &Teammate| {
            t.project == new.project && t.name.to_lowercase() == new.name.to_lowercase()
        };
        if self.list()?.iter().any(taken) {
            return Err(format!("a teammate named {} already exists", new.name));
        }
        Ok((new.name, new.job, why, line(&from.name, NAME_MAX)))
    }
}

/// The owner hands a worktree to a bot: what the bot reads as its next prompt. The folder is one that is really
/// there (no relative path, no symlink on the way), and the goal is plain text.
// shortcut: the hand-over is a prompt and nothing is recorded, so the tree does not show the worktree under the bot;
// record it with the task ledger once a bot's own work has a place there.
pub(crate) fn hand_text(worktree: &Path, goal: Option<&str>) -> Result<String, String> {
    let shown = worktree.to_string_lossy();
    if !worktree.is_absolute()
        || std::fs::canonicalize(worktree).ok().as_deref() != Some(worktree)
        || !worktree.is_dir()
        || shown.chars().any(char::is_control)
    {
        return Err("a worktree to hand over must be a real folder, not through a symlink".into());
    }
    let goal = goal.map(str::trim).filter(|g| !g.is_empty());
    if goal.is_some_and(|g| {
        g.chars().count() > JOB_MAX || g.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
    }) {
        return Err(format!(
            "what to do with a worktree has at most {JOB_MAX} characters and no control characters"
        ));
    }
    let what = match goal {
        Some(goal) => format!("What the user wants done with it:\n{goal}"),
        None => "The user gave no goal for it yet. Run no commands: reply with one line that says you have it and asks what to do with it, then wait.".into(),
    };
    Ok(format!(
        "The user hands you a worktree: {shown}\n\
         It is yours to work in from now on. Look at what is there first (its status and its last commits), change files only inside it, and report here.\n\
         \n\
         {what}"
    ))
}
