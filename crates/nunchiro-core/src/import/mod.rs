//! V2.5-12: first run offers the conversations `claude` and `codex` already keep on this Mac. Strictly read-only over
//! `~/.claude` and `~/.codex` (needs 137): their transcripts are listed, opened for a bounded head read and, once
//! imported, scanned for Search. What "imported" means is one file in Nunchiro's own home (`import.json`: which
//! conversations the owner picked). The window sends ids only; a path always comes from this core's own listing.
//! Window only (`Op`, never a `Request`), so agent tokens and the browser role cannot express it.
use crate::{
    accounts::{Agent, agent_name, variable},
    api::{AgentKind, Reply},
    chat::{after_codex_context, project, search},
    store, usage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    /// Every conversation the agents' folders list, newest first, with whether it is imported already. 392: with
    /// `projects`, each one's own conversations from one scan, and only when every one is a project this Mac's tree holds.
    ImportList {
        #[serde(default)]
        projects: Option<Vec<String>>,
        /// Ticket 1123: only the folders (onboarding's Folder row): each one's agent, newest time and whether it is gone,
        /// never a title or any other words of a conversation. Takes no `projects`.
        #[serde(default)]
        folders_only: bool,
    },
    /// Imports these listed ids (an id the listing does not hold is refused).
    ImportAdd { ids: Vec<String> },
    /// Search over the imported conversations only.
    ImportSearch { query: String },
    /// Opens one imported conversation read-only: its chat events, bounded. Ids only; never an unlisted one.
    ImportRead { id: String },
}

/// One conversation as the window shows it. `id` is `<agent>:<file stem>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub agent: Agent,
    pub project: String,
    pub title: String,
    pub modified_ms: u64,
    pub imported: bool,
    /// Ticket 1073: a conversation a Nunchiro session ran (`ran.json`), so History never calls it started in a terminal.
    #[serde(default)]
    pub ran: bool,
}

/// Ticket 1123: one folder an agent worked in, for onboarding's Folder row. No title field: the type cannot carry the
/// words of a conversation (a first message can hold a secret).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub project: String,
    /// The agent of the newest conversation there.
    pub agent: Agent,
    pub modified_ms: u64,
    /// Not a folder on this Mac now (moved or deleted).
    pub gone: bool,
}

/// Ticket 1073: the conversation ids (`agent_session_id`) of every session row this core saved, oldest first, at most
/// RAN_KEEP. A closed session's row leaves the store (V2-6d, ticket 621) and its conversation file stays on disk; this
/// is what still tells that conversation was Nunchiro's own. Written by `Sessions::save`, read by the listing.
/// Round 4: seeded once per home (`seed`, at the first core start that finds no `seeded` mark) from what the core kept
/// about sessions closed before this record existed.
pub(crate) const RAN: &str = "ran.json";
const RAN_KEEP: usize = 16_384;
const RAN_MAX: u64 = 2 << 20;
/// The most `chat/` names one seed reads (a bounded walk at one core start, never at a listing).
const SEED_CHAT_MAX: usize = 100_000;
#[derive(Serialize, Deserialize)]
struct RanFile {
    /// The seed ran (round 4). A round-3 file (a bare list) has none, so it is seeded once too.
    seeded: bool,
    conversations: std::collections::VecDeque<String>,
}
#[derive(Default)]
pub(crate) struct Ran {
    order: std::collections::VecDeque<String>,
    set: BTreeSet<String>,
    seeded: bool,
}
impl Ran {
    /// The ids `home` keeps; an unreadable or missing file is none (the conversations then read as before 1073).
    pub(crate) fn load(home: &Path) -> Self {
        let bytes = store::open_regular(&home.join(RAN))
            .ok()
            .and_then(|f| store::read_capped(f, RAN_MAX).ok())
            .unwrap_or_default();
        let (ids, seeded) = match serde_json::from_slice::<RanFile>(&bytes) {
            Ok(f) => (f.conversations.into(), f.seeded),
            Err(_) => (
                serde_json::from_slice::<Vec<String>>(&bytes).unwrap_or_default(),
                false,
            ),
        };
        let mut ran = Self {
            seeded,
            ..Self::default()
        };
        ran.add(ids.iter().map(String::as_str));
        ran
    }
    fn add<'a>(&mut self, ids: impl Iterator<Item = &'a str>) -> bool {
        let mut grew = false;
        for id in ids.filter(|id| !id.is_empty() && id.len() <= 200) {
            if self.set.insert(id.to_string()) {
                self.order.push_back(id.to_string());
                grew = true;
            }
        }
        while self.order.len() > RAN_KEEP {
            let old = self.order.pop_front().unwrap();
            self.set.remove(&old);
        }
        grew
    }
    fn write(&self, home: &Path) -> Result<(), String> {
        let file = RanFile {
            seeded: self.seeded,
            conversations: self.order.clone(),
        };
        let bytes = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
        store::write_capped(&home.join(RAN), &bytes, RAN_MAX)
    }
    /// Adds `ids`; writes the file only when one is new. The oldest go past RAN_KEEP.
    pub(crate) fn note<'a>(
        &mut self,
        home: &Path,
        ids: impl Iterator<Item = &'a str>,
    ) -> Result<(), String> {
        if !self.add(ids) {
            return Ok(());
        }
        self.write(home)
    }
    /// Round 4: once per home, the conversations of sessions closed before ran.json existed. Sources: `known` (the
    /// stored rows and the dropped token rows' `token_conversations`) and the chat records `chat/<claude|codex>-<id>.json`
    /// (`chat::session_key`: the agent's conversation id; never removed at a close), oldest first so the newest stay
    /// under RAN_KEEP. A row with no conversation id keys its record by the session id, which names no transcript.
    /// Once written with the mark it never runs again; a failed write runs it again at the next start.
    pub(crate) fn seed<'a>(
        &mut self,
        home: &Path,
        known: impl Iterator<Item = &'a str>,
    ) -> Result<(), String> {
        if self.seeded {
            return Ok(());
        }
        let mut chat: Vec<(std::time::SystemTime, String)> = fs::read_dir(home.join("chat"))
            .into_iter()
            .flatten()
            .take(SEED_CHAT_MAX)
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().into_string().ok()?;
                let key = name.strip_suffix(".json")?;
                let id = key
                    .strip_prefix("claude-")
                    .or_else(|| key.strip_prefix("codex-"))?;
                let at = e.metadata().ok()?.modified().ok()?;
                store::valid_id(id).then(|| (at, id.to_string()))
            })
            .collect();
        chat.sort();
        let older: Vec<String> = chat.into_iter().map(|(_, id)| id).collect();
        let known: Vec<&str> = known.collect();
        // What the old store holds first (older), then what the current rows hold (newest).
        let mut seeded = Self {
            seeded: true,
            ..Self::default()
        };
        seeded.add(older.iter().map(String::as_str));
        seeded.add(known.into_iter());
        seeded.add(self.order.iter().map(String::as_str));
        seeded.write(home)?;
        *self = seeded;
        Ok(())
    }
    /// A listed id (`<agent>:<file stem>`) is one of these: Claude's stem is the conversation id; Codex's ends with it
    /// (`rollout-<time>-<uuid>`).
    fn has(&self, item: &str) -> bool {
        let stem = item.split_once(':').map_or(item, |(_, s)| s);
        self.set.contains(stem)
            || stem
                .get(stem.len().saturating_sub(36)..)
                .is_some_and(|tail| tail.len() == 36 && self.set.contains(tail))
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    id: String,
    agent: Agent,
    project: String,
    title: String,
    modified_ms: u64,
    path: PathBuf,
}

/// The agents' transcript folders (`projects` for Claude, `sessions` for Codex).
pub struct Roots {
    pub claude: PathBuf,
    pub codex: PathBuf,
}
impl Roots {
    /// As `firstrun` finds them: the agent's config variable, else `$HOME/.claude` and `$HOME/.codex`.
    pub fn own() -> Self {
        let root = |agent, dir: &str, sub: &str| {
            std::env::var_os(variable(agent))
                .map(PathBuf::from)
                .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(dir)))
                .unwrap_or_default()
                .join(sub)
        };
        Self {
            claude: root(Agent::Claude, ".claude", "projects"),
            codex: root(Agent::Codex, ".codex", "sessions"),
        }
    }
    fn of(&self, agent: Agent) -> &Path {
        match agent {
            Agent::Claude => &self.claude,
            Agent::Codex => &self.codex,
        }
    }
}

const MAX_ITEMS: usize = 2_000;
const MAX_IDS: usize = 2_000;
/// 392: projects one listing may name (the window asks for its whole tree at once).
const MAX_PROJECTS: usize = 200;
const HEAD: u64 = 64 * 1024;
const TITLE: usize = 80;
/// How Claude opens the summary that carries a resumed conversation on.
const CONTINUED: &str = "This session is being continued from a previous conversation";
/// Bytes read from the start of a transcript, whole lines only, and chat events returned from them.
const MAX_READ: u64 = 8 << 20;
const MAX_ENTRIES: usize = 5_000;
/// How far past `MAX_READ` the cut-off lines are counted (a lower bound beyond it).
const COUNT_MAX: u64 = 64 << 20;
const STORE: &str = "import.json";
/// Larger than any list the window keeps (`MAX_ITEMS` conversations, a title of `TITLE` characters each).
const STORE_MAX: u64 = 4 << 20;

/// `tree`: the projects this Mac's tree holds, asked only when a list names a project.
pub fn window(
    home: &Path,
    op: Op,
    tree: impl FnOnce() -> Result<BTreeSet<String>, String>,
    cancel: &AtomicBool,
) -> Result<Reply, String> {
    let roots = Roots::own();
    match op {
        Op::ImportList {
            projects: None,
            folders_only: true,
        } => Ok(Reply::ImportFolders {
            folders: folders(list(&roots, home)?),
        }),
        Op::ImportList {
            projects: Some(_),
            folders_only: true,
        } => Err("folders_only takes no projects".into()),
        Op::ImportList {
            projects: None,
            folders_only: false,
        } => Ok(Reply::ImportList {
            items: list(&roots, home)?,
        }),
        Op::ImportList {
            projects: Some(projects),
            folders_only: false,
        } => Ok(Reply::ImportProjects {
            projects: listed(&roots, home, &projects, &tree()?)?,
        }),
        Op::ImportAdd { ids } => add(&roots, home, &ids).map(|total| Reply::ImportAdded { total }),
        Op::ImportSearch { query } => search_imported(&roots, home, &query, cancel)
            .map(|results| Reply::ImportSearch { results }),
        Op::ImportRead { id } => read(&roots, home, &id),
    }
}

fn kind(agent: Agent) -> AgentKind {
    match agent {
        Agent::Claude => AgentKind::Claude,
        Agent::Codex => AgentKind::Codex,
    }
}

fn stored(home: &Path) -> Result<Vec<Stored>, String> {
    let path = home.join(STORE);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
        Ok(m) if !m.is_file() || m.len() > STORE_MAX => {
            return Err(format!("{STORE} is not a regular file under 4 MiB"));
        }
        Ok(_) => {}
    }
    let file = crate::store::open_regular(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&crate::store::read_capped(file, STORE_MAX).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{STORE} is unreadable: {e}"))
}

/// The conversation files of one agent. Claude keeps `projects/<p>/<id>.jsonl` (deeper files are sub-agent logs).
fn files(roots: &Roots, agent: Agent) -> Vec<PathBuf> {
    let root = roots.of(agent);
    // A link as the folder itself is not followed either.
    if !fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
        return vec![];
    }
    let mut files = vec![];
    usage::walk(root, 0, &mut files, &mut usage::Budget::request());
    if agent == Agent::Claude {
        files.retain(|f| f.parent().and_then(Path::parent) == Some(root));
    }
    files
}

/// Project folder, title and conversation id from the head of a transcript: one bounded read, never the whole file.
fn head(agent: Agent, path: &Path) -> Option<(String, String)> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let mut buf = vec![];
    (&mut file).take(HEAD).read_to_end(&mut buf).ok()?;
    // The cut can end inside a line; only complete lines are read.
    let complete = &buf[..buf.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1)];
    let (mut folder, mut title, mut fallback) = (String::new(), String::new(), String::new());
    for line in complete.split(|b| *b == b'\n') {
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if folder.is_empty() {
            let cwd = match agent {
                Agent::Claude => &record["cwd"],
                Agent::Codex => &record["payload"]["cwd"],
            };
            folder = cwd.as_str().unwrap_or_default().into();
        }
        if title.is_empty() {
            let events = project(kind(agent), &record);
            let text = events
                .iter()
                .find(|e| e["kind"] == "message" && e["role"] == "user")
                .and_then(|e| e["text"].as_str())
                .unwrap_or_default();
            // Ticket 378: a resumed, compacted or slash-command start is not the person's first request.
            let own = match agent {
                Agent::Claude
                    if record["isMeta"] == true
                        || record["isCompactSummary"] == true
                        || text.trim_start().starts_with("<command-")
                        || text.trim_start().starts_with(CONTINUED) =>
                {
                    ""
                }
                Agent::Claude => text,
                Agent::Codex => after_codex_context(text),
            };
            // Look 11-17 (area A): a paste (a lead's brief) is titled by its first real line, never by its mark.
            let words = |t: &str| {
                let bare = without_paste_marks(t);
                let t = if bare == t {
                    t
                } else {
                    bare.lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or_default()
                };
                t.split_whitespace().collect::<Vec<_>>().join(" ")
            };
            title = words(own);
            if fallback.is_empty() {
                fallback = words(text);
            }
        }
        if !folder.is_empty() && !title.is_empty() {
            break;
        }
    }
    if title.is_empty() {
        title = fallback;
    }
    Some((folder, title.chars().take(TITLE).collect()))
}

/// `text` without Claude's `<pasted_content …>` and `</pasted_content>` tags (what was pasted stays).
pub(crate) fn without_paste_marks(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tag = &rest[at..];
        let name = tag
            .strip_prefix("</")
            .or_else(|| tag.strip_prefix('<'))
            .unwrap_or("");
        // The name first, then one search for its end: a search for '>' after every '<' was quadratic on text with
        // many '<' and no '>' (Codex look of wave 17). No '>' after a paste tag means none after any later one either.
        let paste = name
            .strip_prefix("pasted_content")
            .is_some_and(|r| r.starts_with([' ', '>', '\n']));
        match paste.then(|| tag.find('>')) {
            Some(Some(end)) => rest = &tag[end + 1..],
            Some(None) => {
                out.push_str(tag);
                return out;
            }
            None => {
                out.push('<');
                rest = &tag[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn id_of(agent: Agent, path: &Path) -> Option<String> {
    Some(format!(
        "{}:{}",
        agent_name(agent),
        path.file_stem()?.to_str()?
    ))
}

fn scan(roots: &Roots) -> Vec<Stored> {
    // Newest first by file time, cut to `MAX_ITEMS`, and only then read heads: a big tree costs 2 000 reads, not all.
    let mut files: Vec<(Agent, PathBuf, u64)> = [Agent::Claude, Agent::Codex]
        .into_iter()
        .flat_map(|agent| files(roots, agent).into_iter().map(move |p| (agent, p)))
        .filter_map(|(agent, path)| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            let ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            Some((agent, path, ms))
        })
        .collect();
    files.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    files.truncate(MAX_ITEMS);
    files
        .into_iter()
        .filter_map(|(agent, path, modified_ms)| {
            let (project, title) = head(agent, &path)?;
            Some(Stored {
                id: id_of(agent, &path)?,
                agent,
                project,
                title,
                modified_ms,
                path,
            })
        })
        .collect()
}

pub fn list(roots: &Roots, home: &Path) -> Result<Vec<Item>, String> {
    let kept = stored(home)?;
    let ran = Ran::load(home);
    Ok(scan(roots)
        .into_iter()
        .map(|s| Item {
            imported: kept.iter().any(|k| k.id == s.id),
            ran: ran.has(&s.id),
            id: s.id,
            agent: s.agent,
            project: s.project,
            title: s.title,
            modified_ms: s.modified_ms,
        })
        .collect())
}

/// Each recorded absolute folder once, newest first, with the agent of its newest conversation and whether it is gone:
/// one look per folder, never a read of its contents. Titles are dropped here, before anything is serialized.
fn folders(items: Vec<Item>) -> Vec<Folder> {
    let mut newest: BTreeMap<String, (u64, Agent)> = BTreeMap::new();
    for i in items.into_iter().filter(|i| i.project.starts_with('/')) {
        let e = newest.entry(i.project).or_insert((i.modified_ms, i.agent));
        if i.modified_ms > e.0 {
            *e = (i.modified_ms, i.agent);
        }
    }
    let mut out: Vec<Folder> = newest
        .into_iter()
        .map(|(project, (modified_ms, agent))| Folder {
            gone: !Path::new(&project).is_dir(),
            project,
            agent,
            modified_ms,
        })
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.modified_ms));
    out
}

/// 392: the projects the window's tree holds for this Mac: the session projects and the added ones. A machine's
/// sessions are labelled on their way to the window, never kept in this core's records, so none is here.
pub(crate) fn tree_projects(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    home: &Path,
) -> Result<BTreeSet<String>, String> {
    let sessions = registry
        .lock()
        .map_err(|_| "sessions unavailable")?
        .known_projects();
    // As `Sessions::project_roots`: a tree file that cannot be read leaves the session projects.
    Ok(crate::tree::Tree::load(home).map_or_else(|_| sessions.clone(), |t| t.known(&sessions)))
}

/// A project the tree holds, else the tree's own refusal: the same words whether or not transcripts name it.
fn held(project: &str, tree: &BTreeSet<String>) -> Result<(), String> {
    if Path::new(project).is_absolute() && tree.contains(project) {
        Ok(())
    } else {
        Err("unknown project".into())
    }
}

/// 392: `projects`, every one held by the tree (else the whole request is refused, so no answer tells which exist), at
/// most `MAX_PROJECTS`, each answered from one scan.
fn listed(
    roots: &Roots,
    home: &Path,
    projects: &[String],
    tree: &BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<Item>>, String> {
    if projects.len() > MAX_PROJECTS {
        return Err(format!("a listing takes at most {MAX_PROJECTS} projects"));
    }
    for project in projects {
        held(project, tree)?;
    }
    lists_in(roots, home, projects)
}

/// For each project, the listed conversations recorded in exactly it (one trailing slash aside on either side): never
/// a parent, a sibling or a sub-folder. The recorded folder is text an agent wrote, so it is compared, never resolved,
/// and no project folder is opened. One scan for all of them: the same cost and caps as `list`.
pub fn lists_in(
    roots: &Roots,
    home: &Path,
    projects: &[String],
) -> Result<BTreeMap<String, Vec<Item>>, String> {
    let trim = |p: &str| p.strip_suffix('/').unwrap_or(p).to_string();
    let all = list(roots, home)?;
    Ok(projects
        .iter()
        .map(|project| {
            let want = trim(project);
            let mine = all
                .iter()
                .filter(|i| !i.project.is_empty() && trim(&i.project) == want)
                .cloned()
                .collect();
            (project.clone(), mine)
        })
        .collect())
}

/// Adds the listed `ids` to the imported set; returns how many conversations are imported now.
pub fn add(roots: &Roots, home: &Path, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() || ids.len() > MAX_IDS {
        return Err(format!("import takes 1 to {MAX_IDS} conversations"));
    }
    let mut kept = stored(home)?;
    let mut listing = scan(roots);
    for id in ids {
        if kept.iter().any(|k| &k.id == id) {
            continue;
        }
        let at = listing
            .iter()
            .position(|s| &s.id == id)
            .ok_or_else(|| format!("conversation {id} is not in the agents' folders"))?;
        kept.push(listing.swap_remove(at));
    }
    let bytes = serde_json::to_vec(&kept).map_err(|e| e.to_string())?;
    store::write_capped(&home.join(STORE), &bytes, STORE_MAX)?;
    Ok(kept.len())
}

/// One imported conversation as the chat feed's events. The id is resolved only against `import.json`; the stored
/// path must still be this agent's own regular transcript under its folder (as in `search_imported`) and is opened
/// without following a link or blocking on a pipe. Reads at most `MAX_READ` bytes; never writes.
pub fn read(roots: &Roots, home: &Path, id: &str) -> Result<Reply, String> {
    let item = stored(home)?
        .into_iter()
        .find(|k| k.id == id)
        .ok_or("not imported")?;
    let in_folder = fs::canonicalize(&item.path).is_ok_and(|p| {
        fs::canonicalize(roots.of(item.agent)).is_ok_and(|root| p.starts_with(root))
    });
    if !in_folder || !fs::symlink_metadata(&item.path).is_ok_and(|m| m.is_file()) {
        return Err("not a transcript under the agent's folder".into());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&item.path)
        .map_err(|e| e.to_string())?;
    // The file just opened, not the path checked above, must be the regular file.
    let len = file
        .metadata()
        .ok()
        .filter(|m| m.is_file())
        .ok_or("not a transcript under the agent's folder")?
        .len();
    let mut buf = vec![];
    (&mut file)
        .take(MAX_READ)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let mut truncated = len > MAX_READ;
    let mut left_out = 0;
    if truncated {
        // The cut can end inside a line: keep complete lines, count the lines after them.
        let keep = buf.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1);
        left_out += count_lines(&mut file, keep as u64);
        buf.truncate(keep);
    }
    let mut entries = vec![];
    for line in buf.split(|b| *b == b'\n') {
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        for data in project(kind(item.agent), &record) {
            if entries.len() == MAX_ENTRIES {
                (truncated, left_out) = (true, left_out + 1);
                continue;
            }
            let event = crate::chat::Event {
                schema_version: 1,
                cursor: entries.len() as u64 + 1,
                data,
            };
            entries.push(serde_json::to_value(event).map_err(|e| e.to_string())?);
        }
    }
    Ok(Reply::ImportRead {
        id: item.id,
        agent: item.agent,
        project: item.project,
        title: item.title,
        entries,
        truncated,
        left_out,
    })
}

/// Lines from `from` on, counted by their newline (a last line without one counts too): streamed, at most `COUNT_MAX`.
// ponytail: a lower bound past COUNT_MAX; a paged read is the upgrade if exact counts matter.
fn count_lines(file: &mut fs::File, from: u64) -> usize {
    use std::io::{Seek, SeekFrom};
    let (mut n, mut seen, mut last) = (0, 0u64, b'\n');
    let mut chunk = vec![0u8; 64 * 1024];
    if file.seek(SeekFrom::Start(from)).is_err() {
        return 0;
    }
    while seen < COUNT_MAX {
        match file.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(got) => {
                n += chunk[..got].iter().filter(|c| **c == b'\n').count();
                (seen, last) = (seen + got as u64, chunk[got - 1]);
            }
        }
    }
    n + usize::from(last != b'\n')
}

/// Hits in the imported conversations, as Search's Sessions scope reports them (`session` is the import id).
pub fn search_imported(
    roots: &Roots,
    home: &Path,
    query: &str,
    cancel: &AtomicBool,
) -> Result<Vec<search::Found>, String> {
    let needle = search::check_query(query)?;
    let raw = search::raw_needle(&needle);
    let mut results = vec![];
    for item in stored(home)? {
        if cancel.load(Ordering::Relaxed) {
            return Err("search canceled".into());
        }
        // The file must still be this agent's own regular transcript under its folder, as when it was listed.
        let own = fs::canonicalize(&item.path).is_ok_and(|p| {
            fs::canonicalize(roots.of(item.agent)).is_ok_and(|root| p.starts_with(root))
        }) && fs::symlink_metadata(&item.path).is_ok_and(|m| m.is_file());
        if !own {
            continue;
        }
        match search::scan(kind(item.agent), &item.path, &needle, &raw, cancel) {
            Ok((hits, _)) if hits.is_empty() => {}
            Ok((hits, more)) => results.push(search::Found {
                session: item.id,
                status: "ok".into(),
                error: None,
                hits,
                more,
            }),
            Err(e) if e == "search canceled" => return Err(e),
            Err(e) => results.push(search::Found {
                session: item.id,
                status: "error".into(),
                error: Some(e),
                hits: vec![],
                more: false,
            }),
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests;
