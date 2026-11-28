//! A bot's memory, in three layers. Layer 1 is quoted in every brief: SOUL.md, USER.md and the MEMORY.md index, one
//! dated fact per line with where it came from. Layer 2 is the topic files an index line points to
//! (`memory/<topic>.md`), read on demand. Every write goes through Nunchiro (`nunchiro memory`, `Team::window`), which
//! adds the date and the source.
//!
//! A seat that read outside content (mail, a web page, another MCP server's results), or whose tool calls the core
//! cannot see, never writes directly: what it adds waits as a proposal for the owner's look, and a line that reads like
//! an instruction is not kept at all. Changes the owner makes keep the version before them as a saved copy, kept for a
//! number of days; Forget deletes a line from the index, every saved copy, the topic files and the waiting proposals.
//!
//! Trust: the memory files sit where a seat's own file tools reach. The core keeps, in its own `memory-state/` folder, a
//! hash of every line it wrote; a line it did not write reads as `(from: unknown)`, whatever source it claims. The
//! outside-read marks and the proposals live in that folder too.
//!
//! shortcut: the hash record stops a seat's file tools (denied there), not its shell: a seat in full mode runs as the
//! same user and can rewrite the record and the marks, the same trust as sessions.json. `--from-user` is the seat's own
//! claim. Upgrade to a signed record kept outside the seat's reach if a seat is seen forging one.
use super::{Team, mask_secrets};
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

/// How many index lines a brief quotes, the line that names the older ones included.
pub(crate) const INDEX_LINES: usize = 200;
/// What a brief quotes of the index at most (a hand-written line can be long).
pub(crate) const INDEX_BYTES: usize = 32 * 1024;
const FACT_MAX: usize = 400;
const TOPIC_MAX: usize = 40;
/// Saved copies older than this go, unless the settings keep them longer.
pub const KEEP_DAYS: u64 = 30;
const DAY_MS: u64 = 86_400_000;
const PROPOSALS_MAX: usize = 100;
/// The index's second line: an index with it is in this format. One without it is migrated once (`Memory::migrate`).
pub(crate) const MARK: &str = "<!-- One fact per line: date, fact, (from: source). Change it with `nunchiro memory add` and `nunchiro memory forget`. -->";
/// The core's own folder under the home: written lines, outside-read marks and proposals.
const STATE: &str = "memory-state";
/// Nunchiro's own MCP server, as docs/cli.md names it.
const OWN_SERVER: &str = "nunchiro";

/// One write at a time across every bot: an add, a forget and an undo each read and rewrite whole files.
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) fn write_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    WRITE.lock().map_err(|_| "memory unavailable".to_string())
}

/// Where a fact came from. Nunchiro sets it, never the line's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The user said it.
    You,
    /// The bot learned it in a conversation with no outside content.
    Conversation,
    /// A line the core did not write (a file edited outside Nunchiro): its own claim is not believed.
    Unknown,
    /// Another tool's or MCP server's results. Outside sources are ordered by how much they tell: a tool, web, mail.
    Tool,
    Web,
    Mail,
}

impl Source {
    pub fn words(self) -> &'static str {
        match self {
            Source::You => "you",
            Source::Conversation => "a conversation",
            Source::Unknown => "unknown",
            Source::Tool => "a tool",
            Source::Web => "web",
            Source::Mail => "mail",
        }
    }
    fn parse(words: &str) -> Option<Source> {
        [
            Source::You,
            Source::Conversation,
            Source::Unknown,
            Source::Tool,
            Source::Web,
            Source::Mail,
        ]
        .into_iter()
        .find(|s| s.words() == words)
    }
    /// Read outside this Mac's conversation: what it brings in is a proposal.
    pub fn outside(self) -> bool {
        matches!(self, Source::Mail | Source::Web | Source::Tool)
    }
}

/// One index line. `date` and `from` are absent on a line someone wrote by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Fact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Source>,
}

impl Fact {
    fn line(&self) -> String {
        let mut line = String::from("- ");
        if let Some(date) = &self.date {
            line.push_str(date);
            line.push(' ');
        }
        line.push_str(&self.text);
        if let Some(from) = self.from {
            line.push_str(&format!(" (from: {})", from.words()));
        }
        line
    }
    /// `- 2026-11-27 Never send a mail without an Outbox card. (from: you)`; the date and the source are each optional.
    /// Any other line of text is a hand-written fact (`plain`).
    fn parse(line: &str) -> Option<Fact> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("<!--") {
            return None;
        }
        let Some(body) = line.strip_prefix("- ").map(str::trim) else {
            return Some(Fact {
                date: None,
                text: line.into(),
                from: None,
            });
        };
        let (date, body) = match body
            .get(..10)
            .filter(|d| is_date(d) && body[10..].starts_with(' '))
        {
            Some(d) => (Some(d.to_string()), body[11..].trim()),
            None => (None, body),
        };
        let (text, from) = match body
            .strip_suffix(')')
            .and_then(|b| b.rsplit_once(" (from: "))
            .and_then(|(text, from)| Some((text, Source::parse(from)?)))
        {
            Some((text, from)) => (text, Some(from)),
            None => (body, None),
        };
        (!text.trim().is_empty()).then(|| Fact {
            date,
            text: text.trim().into(),
            from,
        })
    }
    /// The fact a line of a file stands for: as this format reads it, or as the migration reads a line in an old one
    /// (`* x`, `- [ ] x`, `2026-11-02: x`).
    fn text_of(line: &str) -> Option<String> {
        match Fact::parse(line)? {
            f if f.date.is_some() || f.from.is_some() => Some(f.text),
            _ => convert(line, "").pop().map(|f| f.text),
        }
    }
}

fn is_date(d: &str) -> bool {
    d.len() == 10
        && d.char_indices().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        })
}

fn line_hash(line: &str) -> String {
    store::token_sha256(line.trim())
}

/// A fact that waits for the owner: it came from a seat that read outside content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Proposal {
    pub id: String,
    pub date: String,
    pub text: String,
    pub from: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub at_ms: u64,
}

/// A line from outside content that read like an instruction: not kept, only counted for the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct NotKept {
    /// The first words, so the owner can tell which.
    pub start: String,
    pub from: Source,
    pub at_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Waiting {
    version: u32,
    #[serde(default)]
    proposals: Vec<Proposal>,
    #[serde(default)]
    not_kept: Vec<NotKept>,
}

/// A saved version of the index from before a change. `kind`: `tidy`, `edit`, `undo`, or `before` (the file as it was
/// before this format, kept for good).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SavedCopy {
    pub id: String,
    pub at_ms: u64,
    pub kind: String,
    /// Lines that differ between this copy and the version after it.
    pub changed: usize,
}

/// What an add did.
#[derive(Debug, PartialEq, Eq)]
pub enum Added {
    Kept,
    /// Already in the index (or already waiting): nothing changed.
    Known,
    Proposed,
    /// It read like an instruction inside outside content.
    NotKept,
}

/// One bot's memory files.
pub struct Memory {
    /// `team/<id>`
    dir: PathBuf,
    user: PathBuf,
    /// `memory-state/<id>`: the core's own records for this bot.
    state: PathBuf,
    /// `memory-state`
    root: PathBuf,
}

impl Team {
    pub fn bot_memory(&self, id: &str) -> Result<Memory, String> {
        if !store::valid_id(id) {
            return Err("not a bot id".into());
        }
        let root = state_root(self.dir.parent().unwrap_or(&self.dir));
        Ok(Memory {
            dir: self.dir.join(id),
            user: self.user(),
            state: root.join(id),
            root,
        })
    }
}

fn state_root(home: &Path) -> PathBuf {
    home.join(STATE)
}

impl Memory {
    pub fn index(&self) -> PathBuf {
        self.dir.join("MEMORY.md")
    }
    fn folder(&self) -> PathBuf {
        self.dir.join("memory")
    }
    fn copies(&self) -> PathBuf {
        self.folder().join("copies")
    }
    fn waiting_file(&self) -> PathBuf {
        self.state.join("proposals.json")
    }
    fn topic(&self, name: &str) -> Result<PathBuf, String> {
        let name = name.strip_suffix(".md").unwrap_or(name);
        let ok = !name.is_empty()
            && name.len() <= TOPIC_MAX
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !name.starts_with('-');
        if !ok {
            return Err(format!(
                "a topic name has 1 to {TOPIC_MAX} lowercase letters, digits and dashes, like mail-rules"
            ));
        }
        Ok(self.folder().join(format!("{name}.md")))
    }
    /// The topic files and the saved copies, each a file the core wrote.
    fn files_in(dir: &Path) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md") && p.is_file())
            .collect();
        out.sort();
        out
    }

    fn read_text(path: &Path) -> String {
        store::read_regular(path)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    }

    /// Where the core keeps the hashes of the lines it wrote to `path`.
    fn record(&self, path: &Path) -> PathBuf {
        if path == self.user {
            return self.root.join("USER.md.json");
        }
        let name = path
            .strip_prefix(&self.dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('/', "_");
        self.state.join(format!("{name}.json"))
    }
    fn trusted(&self, path: &Path) -> BTreeSet<String> {
        store::read_regular(&self.record(path))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
    /// Writes `text` to `path`. The lines it trusts afterwards: those it trusted before, and the lines in `new`.
    fn write_kept(&self, path: &Path, text: &str, new: &[String]) -> Result<(), String> {
        let before = self.trusted(path);
        let new: BTreeSet<String> = new.iter().map(|l| line_hash(l)).collect();
        let trusted: BTreeSet<String> = text
            .lines()
            .map(line_hash)
            .filter(|h| before.contains(h) || new.contains(h))
            .collect();
        for dir in [
            Some(self.dir.as_path()),
            path.parent(),
            Some(self.state.as_path()),
        ]
        .into_iter()
        .flatten()
        {
            store::private_dir(dir)?;
        }
        store::private_dir(&self.root)?;
        // The record first: a crash between the two leaves lines distrusted, never a planted line trusted.
        let record = serde_json::to_vec(&trusted).map_err(|e| e.to_string())?;
        store::atomic_write(&self.record(path), &record)?;
        store::atomic_write(path, text.as_bytes())
    }
    /// The facts of a file the core keeps: each line it did not write reads as `(from: unknown)`.
    fn read_facts(&self, path: &Path) -> Vec<Fact> {
        let trusted = self.trusted(path);
        Self::read_text(path)
            .lines()
            .filter(|l| *l != MARK)
            .filter_map(|l| {
                let mut f = Fact::parse(l)?;
                if !trusted.contains(&line_hash(l)) {
                    f.from = Some(Source::Unknown);
                }
                Some(f)
            })
            .collect()
    }

    /// The index in this format: an index without the format line is saved as it was (a `before` copy, kept for good)
    /// and rewritten as dated lines, newest first, each bullet or line of text one fact from a conversation, dated by
    /// the file. An older build reads the new file as plain text, as it read the old one.
    pub(crate) fn migrate(&self) -> Result<(), String> {
        let path = self.index();
        let Ok(bytes) = store::read_regular(&path) else {
            return Ok(());
        };
        let old = String::from_utf8_lossy(&bytes).into_owned();
        if old.lines().nth(1) == Some(MARK) {
            return Ok(());
        }
        let modified = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or_else(crate::queue::now_ms, |d| d.as_millis() as u64);
        let mut facts = convert(&old, &crate::loops::today(modified));
        facts.sort_by(|a, b| b.date.cmp(&a.date));
        self.save_copy(&old, "before", crate::queue::now_ms(), true)?;
        self.write_facts(&facts)
    }

    /// A new bot's index.
    pub(crate) fn empty() -> String {
        Self::render(&[])
    }
    fn render(facts: &[Fact]) -> String {
        let mut text = format!("# Memory\n{MARK}\n\n");
        for f in facts {
            text.push_str(&f.line());
            text.push('\n');
        }
        text
    }
    /// The index as `facts`: every line is the core's, so every line is trusted (a distrusted one says `unknown`).
    fn write_facts(&self, facts: &[Fact]) -> Result<(), String> {
        let text = mask_secrets(&Self::render(facts)).0;
        let lines: Vec<String> = text.lines().map(String::from).collect();
        self.write_kept(&self.index(), &text, &lines)
    }

    fn facts_now(&self) -> Result<Vec<Fact>, String> {
        self.migrate()?;
        Ok(self.read_facts(&self.index()))
    }
    /// The index's lines, newest first.
    pub fn facts(&self) -> Result<Vec<Fact>, String> {
        let _one = write_lock()?;
        self.facts_now()
    }

    /// The index as a brief quotes it: masked, at most `INDEX_LINES` lines and `INDEX_BYTES`, the newest first; when
    /// older lines are left out, the last quoted line says how many.
    pub(crate) fn quote(&self) -> String {
        let facts = match self.facts() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("memory index not read: {e}");
                return String::new();
            }
        };
        let lines: Vec<String> = facts
            .iter()
            .map(|f| {
                let mut l = mask_secrets(&f.line()).0;
                l.retain(|c| !c.is_control() || c == '\t');
                l
            })
            .collect();
        let (mut out, mut size) = (vec![], 0);
        for l in &lines {
            let room = out.len() + 1 < INDEX_LINES || lines.len() <= INDEX_LINES;
            if !room || size + l.len() + 1 > INDEX_BYTES - 200 {
                break;
            }
            size += l.len() + 1;
            out.push(l.as_str());
        }
        let left = lines.len() - out.len();
        let mut text = out.join("\n");
        if left > 0 {
            text.push_str(&format!(
                "\n[{left} older lines are not quoted here: `nunchiro memory read` shows the whole index]"
            ));
        }
        text
    }

    /// USER.md as a brief quotes it: a line that claims a source the core did not write says `(from: unknown)`.
    pub(crate) fn user_text(&self) -> String {
        let trusted = self.trusted(&self.user);
        Self::read_text(&self.user)
            .lines()
            .map(|l| match Fact::parse(l) {
                Some(f) if f.from.is_some() && !trusted.contains(&line_hash(l)) => Fact {
                    from: Some(Source::Unknown),
                    ..f
                }
                .line(),
                _ => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// One fact, checked: one line of text, no secret, no source of its own.
    fn check_text(text: &str) -> Result<String, String> {
        if text.trim().contains(['\n', '\r']) {
            return Err("one fact per line: add each line by itself".into());
        }
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() || text.chars().count() > FACT_MAX {
            return Err(format!("a memory line has 1 to {FACT_MAX} characters"));
        }
        if text.chars().any(char::is_control) || text.contains("(from: ") {
            return Err(
                "a memory line is one line of text; Nunchiro adds the date and the source".into(),
            );
        }
        if mask_secrets(&text).1 > 0 {
            return Err(
                "this looks like a secret (a key, a token or a password): memory never keeps one"
                    .into(),
            );
        }
        Ok(text)
    }

    /// Adds one fact. `from` outside: it waits as a proposal, or is not kept when it reads like an instruction.
    /// `topic`: the line goes to that topic file, and the index gets a line that points to it if none does.
    pub fn add(
        &self,
        text: &str,
        from: Source,
        topic: Option<&str>,
        now_ms: u64,
    ) -> Result<Added, String> {
        let text = Self::check_text(text)?;
        let _one = write_lock()?;
        let date = crate::loops::today(now_ms);
        let topic_path = topic.map(|t| self.topic(t)).transpose()?;
        if from.outside() {
            return self.propose(text, from, topic.map(String::from), date, now_ms);
        }
        self.put(
            Fact {
                date: Some(date),
                text,
                from: Some(from),
            },
            topic_path,
        )
    }
    /// Keeps `fact` in the index, or in the topic file at `topic_path` with an index line that points to it.
    fn put(&self, fact: Fact, topic_path: Option<PathBuf>) -> Result<Added, String> {
        let mut facts = self.facts_now()?;
        match topic_path {
            None => {
                if facts.iter().any(|f| f.text == fact.text) {
                    return Ok(Added::Known);
                }
                facts.insert(0, fact);
            }
            Some(path) => {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let mut body = Self::read_text(&path);
                if self.read_facts(&path).iter().any(|f| f.text == fact.text) {
                    return Ok(Added::Known);
                }
                if body.is_empty() {
                    body = format!("# {}\n\n", name.trim_end_matches(".md"));
                }
                body.push_str(&fact.line());
                body.push('\n');
                self.write_kept(&path, &body, &[fact.line()])?;
                if facts.iter().any(|f| f.text.contains(name.as_ref())) {
                    return Ok(Added::Kept);
                }
                facts.insert(
                    0,
                    Fact {
                        text: format!("{}: see {name}", title(&name)),
                        ..fact
                    },
                );
            }
        }
        self.write_facts(&facts)?;
        Ok(Added::Kept)
    }

    /// A fact about the user, in the shared USER.md (no copies: every bot reads it).
    pub fn add_user(&self, text: &str, from: Source, now_ms: u64) -> Result<Added, String> {
        let text = Self::check_text(text)?;
        let _one = write_lock()?;
        let date = crate::loops::today(now_ms);
        if from.outside() {
            return self.propose(text, from, Some(USER_TOPIC.into()), date, now_ms);
        }
        if self.read_facts(&self.user).iter().any(|f| f.text == text) {
            return Ok(Added::Known);
        }
        self.append_user(&Fact {
            date: Some(date),
            text,
            from: Some(from),
        })?;
        Ok(Added::Kept)
    }
    fn append_user(&self, fact: &Fact) -> Result<(), String> {
        let mut body = Self::read_text(&self.user);
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(&fact.line());
        body.push('\n');
        self.write_kept(&self.user, &body, &[fact.line()])
    }

    fn waiting(&self) -> Waiting {
        store::read_regular(&self.waiting_file())
            .ok()
            .and_then(|b| serde_json::from_slice::<Waiting>(&b).ok())
            .filter(|w| w.version == 1)
            .unwrap_or(Waiting {
                version: 1,
                ..Waiting::default()
            })
    }
    fn write_waiting(&self, w: &Waiting) -> Result<(), String> {
        store::private_dir(&self.root)?;
        store::private_dir(&self.state)?;
        let bytes = serde_json::to_vec_pretty(w).map_err(|e| e.to_string())?;
        store::atomic_write(&self.waiting_file(), &bytes)
    }
    fn propose(
        &self,
        text: String,
        from: Source,
        topic: Option<String>,
        date: String,
        now_ms: u64,
    ) -> Result<Added, String> {
        let mut w = self.waiting();
        if instruction_like(&text) {
            w.not_kept.push(NotKept {
                start: text.chars().take(48).collect(),
                from,
                at_ms: now_ms,
            });
            let cut = w.not_kept.len().saturating_sub(PROPOSALS_MAX);
            w.not_kept.drain(..cut);
            self.write_waiting(&w)?;
            return Ok(Added::NotKept);
        }
        if w.proposals
            .iter()
            .any(|p| p.text == text && p.topic == topic)
        {
            return Ok(Added::Known);
        }
        if w.proposals.len() >= PROPOSALS_MAX {
            return Err(format!(
                "{PROPOSALS_MAX} proposals already wait for the user's look; nothing more is kept until then"
            ));
        }
        w.proposals.push(Proposal {
            id: store::new_id()?,
            date,
            text,
            from,
            topic,
            at_ms: now_ms,
        });
        self.write_waiting(&w)?;
        Ok(Added::Proposed)
    }

    /// The proposals that wait, and the lines that were not kept.
    pub fn proposals(&self) -> (Vec<Proposal>, Vec<NotKept>) {
        let w = self.waiting();
        (w.proposals, w.not_kept)
    }

    /// The owner's look at a proposal: `keep` adds it with its own source and date, otherwise it goes.
    pub fn settle(&self, id: &str, keep: bool) -> Result<(), String> {
        let _one = write_lock()?;
        let mut w = self.waiting();
        let at = w
            .proposals
            .iter()
            .position(|p| p.id == id)
            .ok_or("no such proposal")?;
        let p = w.proposals.remove(at);
        if keep {
            // Kept with its own date and source: the line says it came from outside.
            let fact = Fact {
                date: Some(p.date),
                text: p.text,
                from: Some(p.from),
            };
            match p.topic.as_deref() {
                Some(USER_TOPIC) => self.append_user(&fact)?,
                topic => {
                    self.put(fact, topic.map(|t| self.topic(t)).transpose()?)?;
                }
            }
        }
        self.write_waiting(&w)
    }

    /// Every file a line may be kept in: the index, USER.md, the topic files and the saved copies.
    fn kept_in(&self) -> Vec<PathBuf> {
        let mut files = vec![self.index(), self.user.clone()];
        files.extend(Self::files_in(&self.folder()));
        files.extend(Self::files_in(&self.copies()));
        files
    }

    /// Deletes one line: from the index, every saved copy (old-format lines too), every topic file, USER.md when it is
    /// there, and the waiting proposals. `words`: the line's text, or words only one line holds. A forget a crash cut
    /// short finds what is left and finishes.
    pub fn forget(&self, words: &str) -> Result<String, String> {
        let words = words.trim();
        if words.is_empty() {
            return Err("say which line: its text, or words only that line holds".into());
        }
        let _one = write_lock()?;
        self.migrate()?;
        let files = self.kept_in();
        let mut all: BTreeSet<String> = files
            .iter()
            .flat_map(|f| {
                Self::read_text(f)
                    .lines()
                    .filter_map(Fact::text_of)
                    .collect::<Vec<_>>()
            })
            .collect();
        all.extend(self.waiting().proposals.into_iter().map(|p| p.text));
        let lower = words.to_lowercase();
        let text = match all.get(words) {
            Some(t) => t.clone(),
            None => {
                let hits: Vec<&String> = all
                    .iter()
                    .filter(|t| t.to_lowercase().contains(&lower))
                    .collect();
                match hits.as_slice() {
                    [one] => (*one).clone(),
                    [] => return Err(format!("no memory line holds \"{words}\"")),
                    many => {
                        return Err(format!(
                            "{} lines hold \"{words}\"; say more of the one to forget:\n{}",
                            many.len(),
                            many.iter()
                                .take(5)
                                .map(|t| format!("- {t}"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        ));
                    }
                }
            }
        };
        // The search index, the copies and topic files first, the index last: a rerun after a crash still finds the line.
        crate::chat::recall::forget(self.root.parent().unwrap_or(&self.root), &text)?;
        for file in files.iter().rev() {
            let body = Self::read_text(file);
            let kept: Vec<&str> = body
                .lines()
                .filter(|l| Fact::text_of(l).as_ref() != Some(&text))
                .collect();
            if kept.len() != body.lines().count() {
                self.write_kept(file, &(kept.join("\n") + "\n"), &[])?;
            }
        }
        let mut w = self.waiting();
        let before = w.proposals.len();
        w.proposals.retain(|p| p.text != text);
        if w.proposals.len() != before {
            self.write_waiting(&w)?;
        }
        Ok(text)
    }

    /// The index (no topic) with the topic files listed, or one topic file.
    pub fn read(&self, topic: Option<&str>) -> Result<String, String> {
        let shown = |facts: Vec<Fact>| {
            facts
                .iter()
                .map(|f| mask_secrets(&f.line()).0 + "\n")
                .collect::<String>()
        };
        match topic {
            Some(t) => {
                let path = self.topic(t)?;
                if !path.is_file() {
                    return Err(format!("no topic file {}", path.display()));
                }
                Ok(shown(self.read_facts(&path)))
            }
            None => {
                let mut text = shown(self.facts()?);
                let topics = self.topics();
                if !topics.is_empty() {
                    text.push_str("\nTopic files (`nunchiro memory read <topic>`):\n");
                    for (name, lines) in topics {
                        text.push_str(&format!("- {name} ({lines} lines)\n"));
                    }
                }
                Ok(text)
            }
        }
    }

    /// The topic files, by name, with their line counts.
    pub fn topics(&self) -> Vec<(String, usize)> {
        Self::files_in(&self.folder())
            .into_iter()
            .map(|p| {
                let lines = self.read_facts(&p).len();
                (
                    p.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    lines,
                )
            })
            .collect()
    }

    /// Masks what `mask_secrets` finds in the index and USER.md and writes the files back (a line the core trusted
    /// stays trusted); how many it masked, and USER.md's length after.
    pub(crate) fn mask_files(&self) -> (usize, usize) {
        let Ok(_one) = write_lock() else {
            return (0, 0);
        };
        let mut masked = 0;
        for path in [self.index(), self.user.clone()] {
            let trusted = self.trusted(&path);
            let text = Self::read_text(&path);
            let (out, n) = mask_secrets(&text);
            if n == 0 {
                continue;
            }
            let carried: Vec<String> = text
                .lines()
                .zip(out.lines())
                .filter(|(was, _)| trusted.contains(&line_hash(was)))
                .map(|(_, now)| now.to_string())
                .collect();
            match self.write_kept(&path, &out, &carried) {
                Ok(()) => masked += n,
                Err(e) => eprintln!("{}: masked text not written back: {e}", path.display()),
            }
        }
        (masked, Self::read_text(&self.user).len())
    }

    /// `trust`: the copy's lines keep the trust they had in the index (a `before` copy is trusted as it is: it is what
    /// the migration read).
    fn save_copy(&self, text: &str, kind: &str, now_ms: u64, trust: bool) -> Result<(), String> {
        let mut at = now_ms;
        while self.copies().join(format!("{at}-{kind}.md")).exists() {
            at += 1;
        }
        // Masked as the index is: a copy never keeps a secret the index lost.
        let text = mask_secrets(text).0;
        let index = self.trusted(&self.index());
        let new: Vec<String> = text
            .lines()
            .filter(|l| trust || index.contains(&line_hash(l)))
            .map(String::from)
            .collect();
        self.write_kept(&self.copies().join(format!("{at}-{kind}.md")), &text, &new)
    }

    /// The owner's edit of the whole index (the Memory tab's Edit): the version before it is a saved copy. A line the
    /// owner wrote without a source is theirs, dated today; secrets are masked.
    pub fn edit(&self, text: &str, now_ms: u64) -> Result<(), String> {
        if text.len() > INDEX_BYTES {
            return Err(format!("the index has at most {} KB", INDEX_BYTES / 1024));
        }
        if text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("the index is plain text".into());
        }
        let _one = write_lock()?;
        let before_facts = self.facts_now()?;
        let today = crate::loops::today(now_ms);
        let facts: Vec<Fact> = mask_secrets(text)
            .0
            .lines()
            .filter(|l| *l != MARK)
            .filter_map(Fact::parse)
            .map(|f| match f.from {
                // A line the owner left as it was keeps what the core knew of it.
                Some(_) => before_facts
                    .iter()
                    .find(|b| b.text == f.text && b.date == f.date)
                    .cloned()
                    .unwrap_or(Fact {
                        from: Some(Source::You),
                        ..f
                    }),
                None => Fact {
                    date: f.date.or(Some(today.clone())),
                    from: Some(Source::You),
                    ..f
                },
            })
            .collect();
        if facts == before_facts {
            return Ok(());
        }
        self.save_copy(&Self::read_text(&self.index()), "edit", now_ms, false)?;
        self.write_facts(&facts)
    }

    /// A new version of the index that replaces the current one, which is kept as a saved copy of `kind` (night tidy).
    pub fn replace(&self, facts: &[Fact], kind: &str, now_ms: u64) -> Result<(), String> {
        let _one = write_lock()?;
        self.migrate()?;
        self.save_copy(&Self::read_text(&self.index()), kind, now_ms, false)?;
        self.write_facts(facts)
    }

    /// The saved copies, newest first. Copies past `keep_days` go first (a `before` copy is kept for good).
    pub fn saved_copies(&self, keep_days: u64, now_ms: u64) -> Vec<SavedCopy> {
        let mut copies: Vec<(u64, String, PathBuf)> = Self::files_in(&self.copies())
            .into_iter()
            .filter_map(|p| {
                let stem = p.file_stem()?.to_str()?.to_string();
                let (at, kind) = stem.split_once('-')?;
                Some((at.parse().ok()?, kind.to_string(), p))
            })
            .collect();
        copies.retain(|(at, kind, path)| {
            let keep = kind == "before" || now_ms.saturating_sub(*at) <= keep_days * DAY_MS;
            if !keep {
                let _ = fs::remove_file(path);
                let _ = fs::remove_file(self.record(path));
            }
            keep
        });
        copies.sort_by_key(|c| std::cmp::Reverse(c.0));
        let mut after = Self::read_text(&self.index());
        copies
            .into_iter()
            .map(|(at_ms, kind, path)| {
                let text = Self::read_text(&path);
                let changed = changed_lines(&text, &after);
                after = text;
                SavedCopy {
                    id: format!("{at_ms}-{kind}"),
                    at_ms,
                    kind,
                    changed,
                }
            })
            .collect()
    }

    /// Puts a saved copy back as the index; the index it replaces is kept as an `undo` copy. A line of the copy the
    /// core did not write comes back as `(from: unknown)`.
    pub fn undo(&self, copy: &str, now_ms: u64) -> Result<(), String> {
        if !copy.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("no such saved copy".into());
        }
        let path = self.copies().join(format!("{copy}.md"));
        if !path.is_file() {
            return Err("that saved copy is gone".into());
        }
        let _one = write_lock()?;
        let text = Self::read_text(&path);
        let trusted = self.trusted(&path);
        let facts: Vec<Fact> = if text.lines().nth(1) == Some(MARK) {
            self.read_facts(&path)
        } else {
            // A `before` copy is the old free-form file: it comes back in this format, dated by the copy.
            let at = copy
                .split('-')
                .next()
                .and_then(|a| a.parse().ok())
                .unwrap_or(now_ms);
            let date = crate::loops::today(at);
            text.lines()
                .flat_map(|l| {
                    let known = trusted.contains(&line_hash(l));
                    convert(l, &date).into_iter().map(move |mut f| {
                        if !known {
                            f.from = Some(Source::Unknown);
                        }
                        f
                    })
                })
                .collect()
        };
        self.save_copy(&Self::read_text(&self.index()), "undo", now_ms, false)?;
        self.write_facts(&facts)
    }
}

/// An index from before this format as facts: each bullet or line of text one fact from a conversation, dated `date`
/// unless it starts with its own date (a log line).
fn convert(old: &str, date: &str) -> Vec<Fact> {
    old.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("<!--"))
        .map(|l| {
            let body = l
                .trim_start_matches(['-', '*'])
                .trim()
                .trim_start_matches("[ ]")
                .trim_start_matches("[x]")
                .trim();
            let (date, text) = match body.get(..10).filter(|d| is_date(d)) {
                Some(d) => (
                    d.to_string(),
                    body[10..].trim_start_matches([':', ' ']).trim(),
                ),
                None => (date.to_string(), body),
            };
            Fact {
                date: Some(date),
                text: text.to_string(),
                from: Some(Source::Conversation),
            }
        })
        .filter(|f| !f.text.is_empty())
        .collect()
}

fn mark_file(home: &Path, session: &str) -> Result<PathBuf, String> {
    if !store::valid_id(session) {
        return Err("not a session id".into());
    }
    Ok(state_root(home).join("outside").join(session))
}
/// Every mark this core made, by its file: a mark deleted from the disk, or one the disk refused, still holds while
/// the core runs.
static MARKS: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Source>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());
/// This session's conversation read outside content (`outside_of`), or heard from one that did. Kept in the core's own
/// folder, out of the seats' file tools' way, so a core restart does not clear it.
pub fn mark_outside(home: &Path, session: &str, source: Source) -> Result<(), String> {
    let path = mark_file(home, session)?;
    if let Ok(mut marks) = MARKS.lock() {
        let held = marks.entry(path.clone()).or_insert(source);
        *held = (*held).max(source);
    }
    if on_disk(&path) >= Some(source) {
        return Ok(());
    }
    store::private_dir(&state_root(home))?;
    store::private_dir(&state_root(home).join("outside"))?;
    store::atomic_write(&path, source.words().as_bytes())
}
/// A mark file's source: only an outside one counts (a planted "you" lowers nothing), and one that cannot be read
/// fails closed.
fn on_disk(path: &Path) -> Option<Source> {
    match store::read_regular(path) {
        Ok(b) => Source::parse(String::from_utf8_lossy(&b).trim())
            .filter(|s| s.outside())
            .or(Some(Source::Tool)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => Some(Source::Tool),
    }
}
/// What outside content any of `sessions` (a seat and the runs it continues) read, the most telling first.
pub fn outside(home: &Path, sessions: &[String]) -> Option<Source> {
    sessions
        .iter()
        .filter_map(|s| {
            let path = mark_file(home, s).ok()?;
            let held = MARKS.lock().ok().and_then(|m| m.get(&path).copied());
            on_disk(&path).max(held)
        })
        .max()
}

/// What a tool call reads from outside this Mac's conversation, by its name and input as an agent's hook gives them
/// (Claude and Codex): a mail connector, a web fetch or search, another MCP server's results, or a shell command that
/// fetches a page, an issue or a repository. Nunchiro's own MCP server is not outside.
/// shortcut: a shell command is judged by its words (`curl`, `wget`, `nunchiro browser`, `gh`, `git clone|pull|fetch`), so
/// a script that fetches passes (`bash -c "$x"`, `python3 -c ...`, a script file); upgrade to marking every shell call
/// if a fetched page is seen reaching memory that way.
pub fn outside_of(tool: &str, input: &serde_json::Value) -> Option<Source> {
    let lower = tool.to_lowercase();
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let server = rest.split("__").next().unwrap_or_default().to_lowercase();
        return match server {
            s if s == OWN_SERVER => None,
            s if s == crate::outward::MAIL.to_lowercase() || s.contains("mail") => {
                Some(Source::Mail)
            }
            s if s.contains("browser") || s.contains("fetch") || s.contains("web") => {
                Some(Source::Web)
            }
            _ => Some(Source::Tool),
        };
    }
    if matches!(
        lower.as_str(),
        "webfetch" | "websearch" | "web_fetch" | "web_search"
    ) {
        return Some(Source::Web);
    }
    let command = input["command"]
        .as_str()
        .map(String::from)
        .or_else(|| {
            input["command"].as_array().map(|a| {
                a.iter()
                    .filter_map(|w| w.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        })
        .unwrap_or_default();
    // A word in quotes, or a program named by its full path, reads as its bare name.
    let words: Vec<&str> = command
        .split(|c: char| c.is_whitespace() || ";|&()\"'`".contains(c))
        .filter(|w| !w.is_empty())
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .collect();
    let fetches = words.iter().enumerate().any(|(i, w)| {
        let next = words.get(i + 1).copied().unwrap_or_default();
        matches!(*w, "curl" | "wget" | "gh")
            || (*w == "nunchiro" && next == "browser")
            || (*w == "git" && matches!(next, "clone" | "pull" | "fetch"))
    });
    fetches.then_some(Source::Web)
}

/// The Bots view's Memory settings, for every bot (`MEMORY_KEY`). Fields a later build adds are read as their default
/// by this one, so no field is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct Settings {
    /// Days a saved copy is kept: 7, 30 or 90.
    pub keep_days: u64,
    /// Search past conversations (`chat::recall`); off deletes the index.
    pub search: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            keep_days: KEEP_DAYS,
            search: true,
        }
    }
}
pub const MEMORY_KEY: &str = "team.memory";
/// A value the window may store under `MEMORY_KEY`.
pub(crate) fn check_settings(value: &serde_json::Value) -> Result<(), String> {
    let s: Settings =
        serde_json::from_value(value.clone()).map_err(|e| format!("memory settings: {e}"))?;
    if ![7, 30, 90].contains(&s.keep_days) {
        return Err("saved copies are kept 7, 30 or 90 days".into());
    }
    Ok(())
}

/// A change the owner makes on a bot's Memory tab.
#[derive(Debug, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    /// Delete one line everywhere (`Memory::forget`); `text` is the line's exact text.
    Forget { text: String },
    /// The whole index as the owner wrote it (`Memory::edit`).
    Edit { text: String },
    /// Put a saved copy back (`Memory::undo`).
    Undo { copy: String },
}

/// A bot's memory as its Memory tab draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct View {
    /// The index, newest first.
    pub facts: Vec<Fact>,
    /// The index file as text, for Edit (its heading and format line left out).
    pub text: String,
    /// How many index lines a brief quotes.
    pub limit: usize,
    pub soul_lines: usize,
    pub user_lines: usize,
    /// Topic files: name and lines.
    pub topics: Vec<(String, usize)>,
    pub copies: Vec<SavedCopy>,
    /// Proposals that wait for the owner's look, and lines not kept.
    pub proposals: usize,
    pub not_kept: usize,
    pub keep_days: u64,
}

impl Memory {
    /// The Memory tab's view, after `change`.
    pub fn view(
        &self,
        soul: &Path,
        change: Option<Change>,
        settings: &Settings,
    ) -> Result<View, String> {
        let now = crate::queue::now_ms();
        match change {
            Some(Change::Forget { text }) => self.forget(&text).map(drop)?,
            Some(Change::Edit { text }) => self.edit(&text, now)?,
            Some(Change::Undo { copy }) => self.undo(&copy, now)?,
            None => {}
        }
        let facts = self.facts()?;
        let lines = |p: &Path| {
            Self::read_text(p)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        };
        let (proposals, not_kept) = self.proposals();
        Ok(View {
            text: facts.iter().map(|f| f.line() + "\n").collect(),
            facts,
            limit: INDEX_LINES,
            soul_lines: lines(soul),
            user_lines: lines(&self.user),
            topics: self.topics(),
            copies: self.saved_copies(settings.keep_days, now),
            proposals: proposals.len(),
            not_kept: not_kept.len(),
            keep_days: settings.keep_days,
        })
    }
}

/// The topic name a USER.md proposal carries.
pub(crate) const USER_TOPIC: &str = "user";

fn title(file: &str) -> String {
    let name = file.trim_end_matches(".md").replace('-', " ");
    let mut c = name.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

fn changed_lines(a: &str, b: &str) -> usize {
    let set = |t: &str| -> BTreeSet<String> {
        t.lines()
            .filter(|l| l.starts_with("- "))
            .map(String::from)
            .collect()
    };
    set(a).symmetric_difference(&set(b)).count()
}

/// A line from outside content that tells the reader to do something is not a fact about the user: it is not kept.
/// shortcut: a word list, so a reworded instruction passes as a proposal (the owner still sees it, unchecked); upgrade
/// to the night tidy's model judging each proposal if one gets through.
pub(crate) fn instruction_like(text: &str) -> bool {
    let t = text.to_lowercase();
    const SAYS: &[&str] = &[
        "ignore previous",
        "ignore all",
        "ignore the above",
        "ignore your",
        "disregard",
        "new instructions",
        "system prompt",
        "you must",
        "you should always",
        "from now on",
        "do not tell",
        "don't tell",
        "forward all",
        "forward every",
        "always forward",
        "send all",
        "send every",
        "always send",
        "always reply",
        "delete all",
        "run this",
        "execute",
    ];
    SAYS.iter().any(|s| t.contains(s))
}

#[cfg(test)]
#[path = "memory/tests.rs"]
mod tests;
