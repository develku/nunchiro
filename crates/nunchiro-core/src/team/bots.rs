//! Ticket 1168 (owner 2026-11-26, mockup docs/design/bots-1166.html): one Bot. A bot is today's teammate with a face,
//! a seat and a SOUL file; Chief and Lead are seats a bot sits in, not other kinds of object. Its id is the teammate
//! id, so sessions, the task ledger and schedules keep pointing at it.
//!
//! Where it is kept: `team/bots.json`, with its own version. The older files are never given a new shape:
//! - With no `bots.json`, the roster is read from `team/team.json` as before. A read never writes.
//! - The first change copies `team.json` to `team.json.v1.bak` and then writes `bots.json` (temp file, then rename).
//! - `team.json` is left as it is, with one exception: a bot it has never held is added to it, in the exact shape an
//!   older build writes (`mirror_new`). An older build that met a schedule or a ledger lead whose id it did not know
//!   failed that run ("is no longer a teammate"); see `tests::an_older_build_*`. That row is written before
//!   `bots.json` is, so no crash leaves a bot this build has and an older build cannot find.
//! - Every change reads, checks and writes under the one store lock (`CHANGE`).
//! - `ledger.json` and `schedules.json` are not written here at all.
//!
//! `Team::list` and the window's `team_*` ops stay as a view over the bots (`Bot::teammate`), so nothing else in the
//! core changed with this move.
use super::{CHANGE, FILE_MAX, Level, Team, Teammate, agent_key};
use crate::api::AgentKind;
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The head shapes and tile colours a face is drawn from (the window draws them; the core only names them).
pub const SHAPES: [&str; 6] = ["bun", "bear", "round", "drop", "cat", "bot"];
pub const TILES: [&str; 6] = ["lilac", "sky", "mint", "peach", "teal", "slate"];
const SOUL_MAX: usize = 16 * 1024;
const BACKUP: &str = "team.json.v1.bak";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Face {
    pub shape: String,
    pub tile: String,
}
/// One of the 36 faces: the shape is `k % 6`, the tile `k / 6`.
fn face_at(k: usize) -> Face {
    Face {
        shape: SHAPES[k % 6].into(),
        tile: TILES[k / 6 % 6].into(),
    }
}
/// The id's own place among the 36 (FNV-1a), the same in every build and on every machine.
fn face_index(id: &str) -> usize {
    let h = id.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    (h % 36) as usize
}
/// The face an id derives by itself. A bot has it unless another bot of its home had it first (`face_free`).
pub fn face_of(id: &str) -> Face {
    face_at(face_index(id))
}
/// The face a bot takes in a home where `taken` are in use: its id's own when that is free, else the next free one,
/// seven places on each time (7 and 36 share no factor, so every face is tried, and the shape and the tile both
/// change). With all 36 in use it is the id's own: more bots than faces must share.
/// Known limit, recorded and not fixed (Codex look, ticket 1168 round 2): a home holds up to 50 bots
/// (`MAX_TEAMMATES`) and there are 36 faces, so from the 37th bot on a face repeats.
fn face_free(id: &str, taken: &[Face]) -> Face {
    let own = face_index(id);
    (0..36)
        .map(|n| face_at((own + 7 * n) % 36))
        .find(|f| !taken.contains(f))
        .unwrap_or_else(|| face_at(own))
}
/// The roster as bots, in its own order (the order they were made in). A bot with a face (`kept`) keeps it; each
/// other one takes a free face in turn, so no two bots of one home share a face while one is left (a face is who a
/// bot is on the roster). The same roster always gives the same faces.
fn with_faces(teammates: &[Teammate], kept: impl Fn(&str) -> Option<Face>) -> Vec<Bot> {
    let mut taken: Vec<Face> = teammates.iter().filter_map(|t| kept(&t.id)).collect();
    teammates
        .iter()
        .map(|t| {
            let face = kept(&t.id).unwrap_or_else(|| {
                let face = face_free(&t.id, &taken);
                taken.push(face.clone());
                face
            });
            Bot::of(t, face)
        })
        .collect()
}

/// One Chief for the office (Home), one Lead per project; a bot with no seat works for whoever opens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SeatFile", into = "SeatFile")]
pub enum Seat {
    None,
    Chief,
    Lead { project: PathBuf },
}
/// A seat as the file and the window write it: `{"kind":"lead","project":"/p"}`. Read by hand: serde's tagged enums
/// take an unknown field on a variant with no fields without a word, and this file refuses what it does not know.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeatFile {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<PathBuf>,
}
impl TryFrom<SeatFile> for Seat {
    type Error = String;
    fn try_from(f: SeatFile) -> Result<Seat, String> {
        match (f.kind.as_str(), f.project) {
            ("none", None) => Ok(Seat::None),
            ("chief", None) => Ok(Seat::Chief),
            ("lead", Some(project)) => Ok(Seat::Lead { project }),
            ("none" | "chief" | "lead", _) => {
                Err("a lead seat names its project, another seat names none".into())
            }
            (other, _) => Err(format!(
                "unknown variant `{other}`, expected `none`, `chief` or `lead`"
            )),
        }
    }
}
impl From<Seat> for SeatFile {
    fn from(seat: Seat) -> SeatFile {
        let (kind, project) = match seat {
            Seat::None => ("none", None),
            Seat::Chief => ("chief", None),
            Seat::Lead { project } => ("lead", Some(project)),
        };
        SeatFile {
            kind: kind.into(),
            project,
        }
    }
}

/// `follow`: the agent's own newest model, and a task's level picks within it. `pinned`: this model, whatever is asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RuleFile", into = "RuleFile")]
pub enum ModelRule {
    Follow,
    Pinned {
        model: String,
        effort: Option<String>,
    },
}
/// A model rule as the file writes it: `{"rule":"pinned","model":"opus","effort":"high"}` (read by hand, as `SeatFile`).
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleFile {
    rule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}
impl TryFrom<RuleFile> for ModelRule {
    type Error = String;
    fn try_from(f: RuleFile) -> Result<ModelRule, String> {
        match (f.rule.as_str(), f.model, f.effort) {
            ("follow", None, None) => Ok(ModelRule::Follow),
            ("pinned", Some(model), effort) => Ok(ModelRule::Pinned { model, effort }),
            ("follow" | "pinned", ..) => {
                Err("a pinned rule names its model, a follow rule names none".into())
            }
            (other, ..) => Err(format!(
                "unknown variant `{other}`, expected `follow` or `pinned`"
            )),
        }
    }
}
impl From<ModelRule> for RuleFile {
    fn from(rule: ModelRule) -> RuleFile {
        match rule {
            ModelRule::Follow => RuleFile {
                rule: "follow".into(),
                model: None,
                effort: None,
            },
            ModelRule::Pinned { model, effort } => RuleFile {
                rule: "pinned".into(),
                model: Some(model),
                effort,
            },
        }
    }
}

/// What today's team rules still read and a Bot has no word for yet, kept whole so a seat opens after the move
/// exactly as before it: the project of a bot with no seat, and ticket 992's level rule (`Teammate::level`,
/// `level_max`, `next_level`; `effort` is the one a follow-rule seat falls back to). Left out when empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<Level>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level_max: Option<Level>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_level: Option<Level>,
}
impl V1 {
    fn is_empty(&self) -> bool {
        *self == V1::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bot {
    /// The teammate id, unchanged by the move.
    pub id: String,
    pub name: String,
    pub job: String,
    pub face: Face,
    pub seat: Seat,
    /// "claude", "codex", or an ACP agent as `acp:<its name in agents.toml>` (`agent_key`).
    pub agent: String,
    pub model: ModelRule,
    #[serde(default, skip_serializing_if = "V1::is_empty")]
    pub v1: V1,
}

impl Bot {
    /// The teammate as a bot. Nothing of it is dropped: `teammate` gives the same teammate back.
    pub fn of(t: &Teammate, face: Face) -> Bot {
        let seat = match (t.lead, &t.project) {
            (true, Some(project)) => Seat::Lead {
                project: project.clone(),
            },
            (true, None) => Seat::Chief,
            (false, _) => Seat::None,
        };
        let model = match &t.model {
            Some(model) => ModelRule::Pinned {
                model: model.clone(),
                effort: t.effort.clone(),
            },
            None => ModelRule::Follow,
        };
        Bot {
            id: t.id.clone(),
            name: t.name.clone(),
            job: t.job.clone(),
            face,
            seat,
            agent: agent_key(t.kind, t.agent.as_deref()),
            model,
            v1: V1 {
                project: t.project.clone().filter(|_| !t.lead),
                effort: t.effort.clone().filter(|_| t.model.is_none()),
                level: t.level,
                level_max: t.level_max,
                next_level: t.next_level,
            },
        }
    }

    /// The bot as the rest of the core reads it. A bot that says one thing twice (a seat's project and another one, a
    /// pinned effort and another one) is refused: one of the two would be dropped without a word.
    pub fn teammate(&self) -> Result<Teammate, String> {
        let refuse = |why: &str| Err(format!("bots.json: {}: {why}", self.name));
        let (kind, agent) = match self.agent.as_str() {
            "claude" => (AgentKind::Claude, None),
            "codex" => (AgentKind::Codex, None),
            other => match other.strip_prefix("acp:") {
                Some(name) if crate::approval::valid_name(name) => {
                    (AgentKind::Acp, Some(name.to_string()))
                }
                _ => return refuse("a bot runs Claude, Codex or an ACP agent"),
            },
        };
        if self.seat != Seat::None && self.v1.project.is_some() {
            return refuse("a bot in a seat has no other project");
        }
        let (lead, project) = match &self.seat {
            Seat::None => (false, self.v1.project.clone()),
            Seat::Chief => (true, None),
            Seat::Lead { project } => (true, Some(project.clone())),
        };
        let (model, effort) = match &self.model {
            ModelRule::Pinned { .. } if self.v1.effort.is_some() => {
                return refuse("a pinned model has its own effort");
            }
            ModelRule::Pinned { model, effort } => (Some(model.clone()), effort.clone()),
            ModelRule::Follow => (None, self.v1.effort.clone()),
        };
        Ok(Teammate {
            id: self.id.clone(),
            name: self.name.clone(),
            job: self.job.clone(),
            kind,
            model,
            effort,
            project,
            lead,
            level: self.v1.level,
            level_max: self.v1.level_max,
            next_level: self.v1.next_level,
            agent,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u32,
    bots: Vec<Bot>,
}

/// A face word goes into the window as it is: a short plain token, whatever shapes a later build adds.
fn plain(word: &str) -> bool {
    !word.is_empty() && word.len() <= 20 && word.bytes().all(|c| c.is_ascii_lowercase())
}

#[cfg(test)]
thread_local! {
    /// A test's stand-in for a disk that fails between the two files a change writes (the older builds' `team.json`
    /// row, then `bots.json`): the error it gives. With no new bot it is simply the failed write of `bots.json`.
    pub(super) static FAIL_BETWEEN: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    /// The same for the write of `team.json` itself.
    pub(super) static FAIL_MIRROR: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    /// Run once by a seat change between its check of the seat and its write: a test's other request arrives there.
    pub(super) static AT_SEAT_CHECK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

impl Team {
    fn bots_file(&self) -> PathBuf {
        self.dir.join("bots.json")
    }
    /// Who the bot is, in its own words: beside its memory file.
    pub fn soul(&self, id: &str) -> PathBuf {
        self.dir.join(id).join("SOUL.md")
    }

    /// `bots.json` as it is; `None` while there is none (the roster is still `team.json`'s). One this build cannot
    /// read (another version, a field it does not know, a broken file) is an error and never read around.
    pub(super) fn stored_bots(&self) -> Result<Option<Vec<Bot>>, String> {
        let bytes = match store::read_regular(&self.bots_file()) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("bots.json: {e}")),
        };
        if bytes.len() as u64 > FILE_MAX {
            return Err("bots.json is too large".into());
        }
        let stored: Stored =
            serde_json::from_slice(&bytes).map_err(|e| format!("bots.json: {e}"))?;
        if stored.version != 1 {
            return Err(format!(
                "bots.json has version {}, this build reads 1",
                stored.version
            ));
        }
        for b in &stored.bots {
            // As `list_v1`: an id is a folder name under `team/`, and the agent is never a shell.
            if !store::valid_id(&b.id) {
                return Err(format!(
                    "bots.json holds an id that is not a bot id: {:?}",
                    b.id
                ));
            }
            if !plain(&b.face.shape) || !plain(&b.face.tile) {
                return Err(format!("bots.json: {}: a face is two plain words", b.name));
            }
            b.teammate()?;
        }
        Ok(Some(stored.bots))
    }

    /// The roster as bots. Before the move each teammate of `team.json` is shown as the bot it will become.
    pub fn bots(&self) -> Result<Vec<Bot>, String> {
        match self.stored_bots()? {
            Some(bots) => Ok(bots),
            None => Ok(with_faces(&self.list_v1()?, |_| None)),
        }
    }

    /// Every change of the roster ends here. The first one is the move: `team.json` is copied aside before
    /// `bots.json` appears, and the faces the roster showed until now (`bots`) are the ones written. A bot keeps the
    /// face it has; a new one takes a free one (`with_faces`).
    /// Two files, in this order: the older builds' row for a bot `team.json` does not hold (`mirror_new`), then
    /// `bots.json`. A crash between them leaves a row in `team.json` for a bot this build never got, which costs
    /// nothing; the other order left a bot here that an older build could not find. A `bots.json` write that fails
    /// puts `team.json` back as it was, so a change that did not happen changed no file.
    /// `wish`: the face the owner picked for the bot of this id, a new one (`first::make`). It is kept when no bot of
    /// the home has it; a face is never taken from a bot, so a taken one falls back to a free one.
    pub(super) fn write_bots(
        &self,
        teammates: &[Teammate],
        wish: Option<(&str, &Face)>,
    ) -> Result<(), String> {
        store::private_dir(&self.dir)?;
        let old = match self.stored_bots()? {
            Some(bots) => bots,
            None => {
                self.backup_v1()?;
                self.bots()?
            }
        };
        let kept = |id: &str| match old.iter().find(|b| b.id == id) {
            Some(bot) => Some(bot.face.clone()),
            None => wish
                .filter(|(new, face)| *new == id && !old.iter().any(|b| b.face == **face))
                .map(|(_, face)| face.clone()),
        };
        let bots = with_faces(teammates, kept);
        let bytes =
            serde_json::to_vec_pretty(&Stored { version: 1, bots }).map_err(|e| e.to_string())?;
        let v1_before = store::read_regular(&self.file()).ok();
        let mirrored = self.mirror_new(teammates)?;
        let written = self.commit(&bytes);
        if written.is_err() && mirrored {
            let back = match &v1_before {
                Some(bytes) => store::atomic_write(&self.file(), bytes),
                None => std::fs::remove_file(self.file()).map_err(|e| e.to_string()),
            };
            if let Err(e) = back {
                eprintln!("team.json keeps a row for a bot that was not saved: {e}");
            }
        }
        written
    }

    /// `bots.json` itself: temp file, then rename.
    fn commit(&self, bytes: &[u8]) -> Result<(), String> {
        #[cfg(test)]
        if let Some(failed) = FAIL_BETWEEN.get() {
            return Err(failed.into());
        }
        store::atomic_write(&self.bots_file(), bytes)
    }

    /// `team.json` as it is now, kept beside it before the first `bots.json` is written. A copy that is already there
    /// with the same bytes is the copy; one with other bytes is never written over (the next free name is used).
    fn backup_v1(&self) -> Result<(), String> {
        let bytes = match store::read_regular(&self.file()) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("team.json: {e}")),
        };
        for n in 0..100 {
            let path = self.dir.join(match n {
                0 => BACKUP.to_string(),
                n => format!("{BACKUP}.{n}"),
            });
            match store::read_regular(&path) {
                Ok(kept) if kept == bytes => return Ok(()),
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return store::atomic_write(&path, &bytes);
                }
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
        Err("team.json has too many backups; move some away".into())
    }

    /// An older build reads `team.json` only. A bot it does not hold is added there as that build would have added it
    /// (the exact v1 shape; a new lead takes the role from its place's earlier lead), so its schedules still run and
    /// its tasks still have their lead after a step back to that build. Entries already there are not changed
    /// otherwise. `true`: the file was written.
    /// Every bot of the roster is looked for, not only a new one: a bot that is missing there for any reason (a file
    /// put back from a copy, a crash of an earlier order) is added by the next change, whatever it is about.
    /// A write that fails is the change's own error and nothing is saved: a bot is never made here without its row
    /// there. A `team.json` this build cannot read by the v1 rules is another matter: it is left alone and said in
    /// the log, and the change goes on (an older build cannot read that file either, and a broken file only older
    /// builds read must not stop every change here).
    // shortcut: a change to a bot `team.json` already holds (a rename, another model) is not mirrored, so an older
    // build shows it as of the move; mirror the whole roster if that proves to matter.
    fn mirror_new(&self, all: &[Teammate]) -> Result<bool, String> {
        let mut v1 = match self.list_v1() {
            Ok(v1) => v1,
            Err(e) => {
                eprintln!("team.json (read by older builds) is left as it is: {e}");
                return Ok(false);
            }
        };
        let new: Vec<&Teammate> = all
            .iter()
            .filter(|t| !v1.iter().any(|o| o.id == t.id))
            .collect();
        if new.is_empty() {
            return Ok(false);
        }
        for t in new {
            for o in v1.iter_mut().filter(|o| t.lead && o.project == t.project) {
                o.lead = false;
            }
            v1.push(t.clone());
        }
        #[cfg(test)]
        if let Some(failed) = FAIL_MIRROR.get() {
            return Err(failed.into());
        }
        self.write_v1(v1).map(|()| true)
    }

    /// A bot takes a seat, or leaves it. One Chief, one Lead per project: a seat that is held is refused with its
    /// holder's name (the owner moves that bot out first; nothing is taken from a bot by a side effect).
    /// The roster is read under the store's lock and the lock is held until the write: two requests for one seat
    /// get one yes and one refusal, and a change that landed just before is in the roster this one writes.
    pub fn sit(&self, id: &str, seat: Seat) -> Result<Vec<Bot>, String> {
        let _one = CHANGE
            .lock()
            .map_err(|_| "team store unavailable".to_string())?;
        let all = self.list()?;
        let mate = all
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("no teammate {id}"))?;
        let place = match &seat {
            Seat::None => mate.project.clone(),
            Seat::Chief => None,
            Seat::Lead { project } => Some(project.clone()),
        };
        let lead = seat != Seat::None;
        if let Some(holder) = all
            .iter()
            .find(|t| lead && t.lead && t.id != id && t.project == place)
        {
            return Err(match &place {
                None => format!("{} is the Chief; one office has one Chief", holder.name),
                Some(p) => format!(
                    "{} leads {}; one project has one Lead",
                    holder.name,
                    p.file_name().unwrap_or_default().to_string_lossy()
                ),
            });
        }
        let next = Teammate {
            project: place,
            lead,
            ..mate.clone()
        };
        #[cfg(test)]
        if let Some(arrives) = AT_SEAT_CHECK.take() {
            arrives();
        }
        self.save_locked(Some(id.into()), next)?;
        // The owner answered where the bot sits (a seat, or "not now"): a template's seat card is over.
        self.seat_answered(id);
        self.bots()
    }

    /// The bot's SOUL text. Until the file exists it reads as the job it will be seeded from.
    pub fn soul_text(&self, id: &str) -> Result<String, String> {
        let (mate, _) = self.seat(id)?;
        match store::read_regular(&self.soul(id)) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(format!("{}\n", mate.job)),
            Err(e) => Err(format!("SOUL.md: {e}")),
        }
    }
    /// The owner's edit of a bot's SOUL file.
    pub fn soul_save(&self, id: &str, text: &str) -> Result<String, String> {
        let _one = CHANGE
            .lock()
            .map_err(|_| "team store unavailable".to_string())?;
        self.seat(id)?;
        let text: String = text.chars().filter(|c| *c != '\r').collect();
        if text.trim().is_empty() {
            return Err("a SOUL needs at least one line".into());
        }
        if text.len() > SOUL_MAX
            || text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("a SOUL has at most 16 KB and no control characters".into());
        }
        let text = format!("{}\n", text.trim_end());
        store::private_dir(&self.dir.join(id))?;
        store::atomic_write(&self.soul(id), text.as_bytes())?;
        Ok(text)
    }
}

mod first;
pub use first::First;
pub(super) use first::hand_text;
pub(crate) use first::offered;

#[cfg(test)]
mod tests;
