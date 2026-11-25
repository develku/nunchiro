//! CHAT-USAGE: read only the selected conversation's last 256 KiB; never return transcript text.
use crate::{
    accounts,
    api::{AgentKind, Breakdown, BreakdownRow, Reply, Response},
    sessions::Sessions,
    usage,
};
use serde_json::Value;
use std::{
    ffi::CString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const TAIL: u64 = 256 << 10;
const MAX_CACHE: usize = 128;
#[derive(Clone)]
pub(crate) struct Target {
    pub kind: AgentKind,
    pub agent_session_id: String,
    pub config_dir: Option<PathBuf>,
    pub cwd: PathBuf,
    /// The transcript the session's observer reads (it follows a linked `~/.codex/sessions`, which the confined
    /// read below refuses).
    pub transcript: Option<PathBuf>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Context {
    used: u64,
    /// None: a Claude model outside `claude_window`'s table; the status line's window may still name it (ticket 1048).
    window: Option<u64>,
}
/// The model the transcript last named and the effort that same request ran at (ticket 994), when it names one.
type Seen = (String, Option<String>);
/// B15 (ticket 991): the context fill when known, and the model the transcript last named either way.
/// Ticket 1048: `told` is the window Claude Code's status line reported for this session; it wins over the table.
fn reply_of(value: Option<Context>, seen: Option<Seen>, told: Option<u64>) -> Reply {
    let (model, effort) = seen.map_or((None, None), |(m, e)| (Some(m), e));
    let value = value.and_then(|c| {
        let window = told.or(c.window)?;
        (window > 0 && c.used <= window).then_some((c.used, window))
    });
    match (value, model) {
        (Some((used, window)), model) => Reply::SessionContext {
            used,
            window,
            model,
            effort,
            breakdown: None,
        },
        (None, Some(model)) => Reply::SessionModel { model, effort },
        (None, None) => Reply::Unknown,
    }
}
struct Cached {
    folder: PathBuf,
    id: String,
    codex: bool,
    path: PathBuf,
    stamp: (u64, i64, i64, u64, u64),
    value: Option<Context>,
    model: Option<Seen>,
    breakdown: Option<Breakdown>,
}
struct Miss {
    search: PathBuf,
    id: String,
    stamp: Option<(u64, u64, i64, i64)>,
    until: Instant,
}
#[derive(Default)]
struct Cache {
    miss: Option<Miss>,
    /// The model of the file the last `read` reached; cleared at each read's start.
    model: Option<Seen>,
    /// Ticket 1059: the /context table of that same file, as `model`.
    breakdown: Option<Breakdown>,
    entries: Vec<Cached>,
    #[cfg(test)]
    reads: Vec<(PathBuf, usize)>,
    #[cfg(test)]
    opens: Vec<PathBuf>,
    #[cfg(test)]
    stats: usize,
}
struct Reader {
    folder: PathBuf,
    id: String,
    codex: bool,
    project: String,
    cache: Arc<Mutex<Cache>>,
}
static CACHE: Mutex<Vec<Reader>> = Mutex::new(Vec::new());
/// Ticket 1048: `context_window.context_window_size` of each Claude session's last status line, by Nunchiro session id.
/// In memory only: after a core restart the next status line (each assistant message sends one) fills it again.
static TOLD: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());
const MAX_TOLD: usize = 512;

/// Ticket 1048: keeps the window the status line reports; a payload without a positive size changes nothing.
pub(crate) fn observe(id: &str, context_window: &Value) {
    let Some(size) = context_window["context_window_size"]
        .as_u64()
        .filter(|s| *s > 0)
    else {
        return;
    };
    let Ok(mut told) = TOLD.lock() else {
        return;
    };
    told.retain(|(k, _)| k != id);
    told.push((id.to_string(), size));
    if told.len() > MAX_TOLD {
        told.remove(0);
    }
}
fn told(id: &str) -> Option<u64> {
    let told = TOLD.lock().ok()?;
    told.iter().find(|(k, _)| k == id).map(|(_, s)| *s)
}

pub(crate) fn reply(home: &Path, registry: &Mutex<Sessions>, id: &str, refresh: bool) -> Response {
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    // Ticket 1059: queued only; Claude writes its answer later, so this reply still carries the previous table.
    if refresh {
        sessions.context_send(id)?;
    }
    let target = sessions.context_target(id);
    drop(sessions);
    let observed = target
        .as_ref()
        .filter(|t| t.kind == AgentKind::Codex)
        .and_then(|t| t.transcript.clone());
    let value = target.and_then(|target| {
        let agent = accounts::agent_of(target.kind)?;
        let folder = match target.config_dir.as_deref() {
            None => accounts::config_home(target.kind, None)?,
            Some(folder) => {
                let real = accounts::real_folder(home, agent, folder.file_name()?.to_str()?, false)
                    .ok()?;
                if real != folder {
                    return None;
                }
                real
            }
        };
        // Match the Claude adapter's cwd encoding; a UUID from another project is not this conversation.
        let project: String = target
            .cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        read_cached(
            &CACHE,
            &folder,
            &target.agent_session_id,
            target.kind == AgentKind::Codex,
            &project,
        )
    });
    // Look 11-17 B15: a Codex whose sessions folder is a link (the owner's) still names its model, from the file its
    // observer already reads.
    let value = match value {
        Some((c, Some(m), b)) => Some((c, Some(m), b)),
        _ => observed
            .and_then(|path| codex_tail(&path))
            .map(|(c, m)| (c, m, None))
            .or(value),
    };
    let told = told(id);
    Ok(value.map_or(Reply::Unknown, |(c, m, b)| {
        let mut reply = reply_of(c, m, told);
        if let Reply::SessionContext { breakdown, .. } = &mut reply {
            *breakdown = b;
        }
        reply
    }))
}
/// The context and model the last `TAIL` bytes of a Codex rollout name; a cut first line is skipped. The file itself is
/// never a link and never a FIFO or device (it would block or point elsewhere); its folders may be links, as the
/// owner's `~/.codex/sessions` is (security look, wave 8).
fn codex_tail(path: &Path) -> Option<(Option<Context>, Option<Seen>)> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut tail = vec![];
    file.take(TAIL).read_to_end(&mut tail).ok()?;
    Some((parse(&tail, true), model(&tail, true)))
}

fn read_cached(
    cache: &Mutex<Vec<Reader>>,
    folder: &Path,
    id: &str,
    codex: bool,
    project: &str,
) -> Option<(Option<Context>, Option<Seen>, Option<Breakdown>)> {
    if !uuid(id) {
        return None;
    }
    let reader = {
        let mut readers = cache.lock().ok()?;
        if let Some(reader) = readers
            .iter()
            .find(|r| r.folder == folder && r.id == id && r.codex == codex && r.project == project)
        {
            reader.cache.clone()
        } else {
            let reader = Arc::new(Mutex::new(Cache::default()));
            if readers.len() == MAX_CACHE {
                readers.remove(0);
            }
            readers.push(Reader {
                folder: folder.into(),
                id: id.into(),
                codex,
                project: project.into(),
                cache: reader.clone(),
            });
            reader
        }
    };
    // Only this conversation waits for its disk I/O; the global cache lock covers lookup alone.
    let mut reader = reader.lock().ok()?;
    let value = reader.read(folder, id, codex, project);
    Some((value, reader.model.take(), reader.breakdown.take()))
}

#[cfg(test)]
thread_local! {
    static WALK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

impl Cache {
    fn read(&mut self, folder: &Path, id: &str, codex: bool, project: &str) -> Option<Context> {
        self.model = None;
        self.breakdown = None;
        if !uuid(id) {
            return None;
        }
        // Check every directory with O_NOFOLLOW, including the account folder. A path swap cannot redirect a read.
        let root = directory(folder)?;
        let sub = if codex { "sessions" } else { "projects" };
        child(&root, Path::new(sub), true)?;
        let project = Path::new("projects").join(project);
        let prior = self.entries.iter().position(|c| {
            c.folder == folder
                && c.id == id
                && c.codex == codex
                && (codex || c.path.parent() == Some(project.as_path()))
        });
        let path = if let Some(i) = prior {
            self.entries[i].path.clone()
        } else {
            let search = if codex {
                folder.join(sub)
            } else {
                folder.join(&project)
            };
            let stamp = fs::symlink_metadata(&search)
                .ok()
                .map(|m| (m.dev(), m.ino(), m.mtime(), m.mtime_nsec()));
            if self.miss.as_ref().is_some_and(|miss| {
                miss.search == search
                    && miss.id == id
                    && miss.stamp == stamp
                    && Instant::now() < miss.until
            }) {
                return None;
            }
            let found = (|| {
                let mut files = vec![];
                let mut budget = usage::Budget::new(500_000, 20_000, TAIL);
                #[cfg(test)]
                {
                    WALKS.with(|n| n.set(n.get() + 1));
                    WALK_HOOK.with(|hook| {
                        if let Some(hook) = hook.borrow_mut().take() {
                            hook();
                        }
                    });
                }
                usage::walk(&folder.join(sub), 0, &mut files, &mut budget);
                if budget.partial {
                    return None;
                }
                let mut matches = files.into_iter().filter(|p| {
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                        return false;
                    };
                    if codex {
                        name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl"))
                    } else {
                        name == format!("{id}.jsonl")
                            && p.parent() == Some(folder.join(&project).as_path())
                    }
                });
                let path = matches.next()?;
                if matches.next().is_some() {
                    return None;
                }
                Some(path.strip_prefix(folder).ok()?.to_path_buf())
            })();
            if found.is_none() {
                // Retry Unknown searches after one second (or sooner when the search directory changes).
                self.miss = Some(Miss {
                    search,
                    id: id.into(),
                    stamp,
                    until: Instant::now() + Duration::from_secs(1),
                });
            }
            found?
        };
        let parent = descend(root, path.parent()?)?;
        let name = path.file_name()?;
        let name = CString::new(name.as_bytes()).ok()?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: parent and name stay live; stat points to writable storage. The final link is never followed.
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
            || stat.st_mode & libc::S_IFMT != libc::S_IFREG
        {
            return None;
        }
        #[cfg(test)]
        {
            self.stats += 1;
        }
        let nanos = stat.st_mtime_nsec;
        let stamp = (
            stat.st_size as u64,
            stat.st_mtime,
            nanos,
            stat.st_dev as u64,
            stat.st_ino,
        );
        if let Some(i) = prior
            && self.entries[i].stamp == stamp
        {
            self.model = self.entries[i].model.clone();
            self.breakdown = self.entries[i].breakdown.clone();
            return self.entries[i].value;
        }
        // Canonical confinement is checked as well as descriptor-relative no-link traversal.
        if !folder
            .join(&path)
            .canonicalize()
            .ok()?
            .starts_with(folder.canonicalize().ok()?)
        {
            return None;
        }
        let mut file = child(
            &parent,
            Path::new(std::ffi::OsStr::from_bytes(name.as_bytes())),
            false,
        )?;
        #[cfg(test)]
        {
            self.opens.push(folder.join(&path));
        }
        let meta = file.metadata().ok()?;
        if !meta.is_file() || meta.ino() != stat.st_ino || meta.dev() != stat.st_dev as u64 {
            return None;
        }
        let start = meta.len().saturating_sub(TAIL);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(meta.len().min(TAIL))
            .read_to_end(&mut bytes)
            .ok()?;
        #[cfg(test)]
        {
            self.reads.push((folder.join(&path), bytes.len()));
        }
        let tail = if start > 0 {
            &bytes[bytes
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |end| end + 1)..]
        } else {
            bytes.as_slice()
        };
        let value = parse(tail, codex);
        let model = model(tail, codex);
        self.model = model.clone();
        let breakdown = if codex { None } else { breakdown(tail) };
        self.breakdown = breakdown.clone();
        if let Some(i) = prior {
            self.entries.remove(i);
        }
        if self.entries.len() == MAX_CACHE {
            self.entries.remove(0);
        }
        self.entries.push(Cached {
            folder: folder.to_path_buf(),
            id: id.into(),
            codex,
            path,
            stamp,
            value,
            model,
            breakdown,
        });
        value
    }
}

fn directory(path: &Path) -> Option<File> {
    if !path.is_absolute() {
        return None;
    }
    let root = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open("/")
        .ok()?;
    descend(root, path.strip_prefix("/").ok()?)
}
fn descend(mut dir: File, path: &Path) -> Option<File> {
    for part in path.components() {
        let Component::Normal(name) = part else {
            return None;
        };
        dir = child(&dir, Path::new(name), true)?;
    }
    Some(dir)
}
fn child(parent: &File, name: &Path, dir: bool) -> Option<File> {
    let name = CString::new(name.as_os_str().as_bytes()).ok()?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if dir { libc::O_DIRECTORY } else { 0 };
    // SAFETY: parent is an open directory and name is a live NUL-terminated component; ownership passes to File.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

fn parse(bytes: &[u8], codex: bool) -> Option<Context> {
    for line in bytes.split(|&b| b == b'\n').rev() {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let (used, window) = if codex {
            if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" {
                continue;
            }
            let info = &v["payload"]["info"];
            // Codex tui/token_usage.rs: last_token_usage is active context; total_token_usage is cumulative.
            (
                info["last_token_usage"]["total_tokens"].as_u64()?,
                Some(info["model_context_window"].as_u64()?),
            )
        } else {
            if v["type"] != "assistant"
                || v["isSidechain"] == true
                || v.get("parentToolUseID").is_some_and(|p| !p.is_null())
            {
                continue;
            }
            let message = &v["message"];
            let usage = &message["usage"];
            if !usage.is_object() {
                return None;
            }
            let used = usage["input_tokens"]
                .as_u64()?
                .checked_add(
                    usage
                        .get("cache_read_input_tokens")
                        .map_or(Some(0), Value::as_u64)?,
                )?
                .checked_add(
                    usage
                        .get("cache_creation_input_tokens")
                        .map_or(Some(0), Value::as_u64)?,
                )?;
            (used, claude_window(message["model"].as_str()?))
        };
        // The window check is in `reply_of`, where the status line's window can replace the table's.
        return Some(Context { used, window });
    }
    None
}
/// B15 (ticket 991): the newest model the transcript names: Claude's main-chain assistant `message.model` (not its
/// `<synthetic>` error stand-in), Codex's `turn_context` `payload.model`. A short, plain id only.
/// Ticket 994: with the effort of that same line, as the agent sent it: Claude's top-level `effort` (its request's
/// `output_config.effort`, absent when none was sent), Codex's `payload.effort`. A short lowercase word only.
fn model(bytes: &[u8], codex: bool) -> Option<Seen> {
    bytes.split(|&b| b == b'\n').rev().find_map(|line| {
        let v = serde_json::from_slice::<Value>(line).ok()?;
        let (m, e) = if codex {
            (v["type"] == "turn_context")
                .then(|| Some((v["payload"]["model"].as_str()?, &v["payload"]["effort"])))??
        } else {
            let main = v["type"] == "assistant"
                && v["isSidechain"] != true
                && v.get("parentToolUseID").is_none_or(Value::is_null);
            main.then(|| Some((v["message"]["model"].as_str()?, &v["effort"])))??
        };
        let effort = e.as_str().filter(|e| {
            (1..=16).contains(&e.len())
                && e.bytes()
                    .all(|b| b.is_ascii_lowercase() || b"-_".contains(&b))
        });
        (m.len() <= 64
            && !m.is_empty()
            && m.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._[]".contains(&b)))
        .then(|| (m.to_string(), effort.map(str::to_string)))
    })
}
/// Ticket 1059: Claude's own record of a /context answer (`isMeta` user text); the chat and the turn tracker skip it too.
pub(crate) fn context_usage(v: &Value) -> Option<&str> {
    (v["type"] == "user" && v["isMeta"] == true)
        .then(|| v["message"]["content"].as_str())??
        .strip_prefix("## Context Usage")
}
/// Ticket 1059: the newest /context table in the tail. A /clear, /new or /compact after it, or a compaction, drops it:
/// that table no longer describes the conversation.
// shortcut: a table older than the 256 KiB tail is not seen; press Show breakdown again (a long turn can push it out).
fn breakdown(bytes: &[u8]) -> Option<Breakdown> {
    let reset = |text: &str| {
        ["/clear", "/new", "/compact"].iter().any(|c| {
            text.trim_start()
                .starts_with(&format!("<command-name>{c}</command-name>"))
        })
    };
    for line in bytes.split(|&b| b == b'\n').rev() {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        // Claude 2.1.329 wrote a command line as user text; today's Claude writes a system `local_command` record.
        if v["subtype"] == "compact_boundary"
            || [&v["content"], &v["message"]["content"]]
                .iter()
                .any(|t| t.as_str().is_some_and(reset))
        {
            return None;
        }
        let Some(text) = context_usage(&v) else {
            continue;
        };
        let Some(at) = v["timestamp"]
            .as_str()
            .and_then(crate::usage::epoch)
            .and_then(|s| u64::try_from(s).ok())
        else {
            continue;
        };
        let at = at * 1000;
        return Some(Breakdown {
            at,
            rows: rows(text),
        });
    }
    None
}
/// The "Estimated usage by category" table only; the MCP, memory and skills tables after it are not read. A row whose
/// numbers do not read (the header, the `|---|` line) is skipped; any label is kept as Claude wrote it.
fn rows(text: &str) -> Vec<BreakdownRow> {
    let Some((_, table)) = text.split_once("### Estimated usage by category") else {
        return vec![];
    };
    table
        .lines()
        .map(str::trim)
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .filter_map(|l| {
            let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            let [label, tokens, pct] = cells[..] else {
                return None;
            };
            let pct: f64 = pct.strip_suffix('%')?.parse().ok()?;
            Some(BreakdownRow {
                label: label.chars().take(64).collect(),
                tokens: tokens_of(tokens)?,
                pct: pct.is_finite().then_some(pct)?,
            })
        })
        .take(32)
        .collect()
}
/// "4.5k" = 4500, "1m" = 1000000, "812" = 812, as /context writes its counts.
fn tokens_of(text: &str) -> Option<u64> {
    let (number, unit) = match text.as_bytes().last()? {
        b'k' | b'K' => (&text[..text.len() - 1], 1e3),
        b'm' | b'M' => (&text[..text.len() - 1], 1e6),
        _ => (text, 1.0),
    };
    let n: f64 = number.replace(',', "").parse().ok()?;
    (n.is_finite() && n >= 0.0).then(|| (n * unit).round() as u64)
}
/// Ticket 1059: /context goes only into a live local Claude at rest: a working turn would take it as queued input, a
/// question would take its Enter as an answer, and words already in the box would be sent with it.
pub(crate) fn may_refresh(
    claude: bool,
    working: bool,
    asking: bool,
    typed: bool,
) -> Result<(), String> {
    let why = if !claude {
        "the breakdown is read from a local Claude session only"
    } else if asking {
        "a question is waiting for an answer"
    } else if working {
        "the agent is working"
    } else if typed {
        "words are typed in the terminal input"
    } else {
        return Ok(());
    };
    Err(format!("context breakdown not sent: {why}"))
}
/// Ticket 1059: the /context record as a real Claude wrote it on 2026-11-23 (the table, then a section not read).
#[cfg(test)]
pub(crate) fn context_record() -> Value {
    let table = "## Context Usage\n\n**Model:** claude-fable-5-2  \n**Tokens:** 255.7k / 1m (26%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 4.5k | 0.4% |\n| System tools | 3.4k | 0.3% |\n| MCP server instructions | 1.1k | 0.1% |\n| Memory files | 4.3k | 0.4% |\n| Skills | 10k | 1.0% |\n| Messages | 232.5k | 23.2% |\n| Free space | 711.3k | 71.1% |\n| Autocompact buffer | 33k | 3.3% |\n\n### MCP Tools\n\n| Tool | Server | Tokens |\n|------|--------|--------|\n| mcp__x__y | x | 1.2k |\n";
    serde_json::json!({"type":"user","isMeta":true,"timestamp":"2026-11-23T02:22:39.372Z","message":{"role":"user","content":table}})
}
fn claude_window(model: &str) -> Option<u64> {
    // Owner-approved CHAT-USAGE table (needs 66/121); standard 200k windows:
    // https://platform.claude.com/docs/en/build-with-claude/context-windows
    // 5.5 IDs advertise 1M in https://platform.claude.com/docs/en/models/overview; leave them Unknown here.
    // Never infer a window from a prefix or strip a [1m] suffix; >200k usage is Unknown.
    const MODELS: &[&str] = &[
        "claude-opus-4-20250514",
        "claude-opus-4-1-20250805",
        "claude-sonnet-4-20250514",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-5-20251101",
    ];
    MODELS.contains(&model).then_some(200_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    /// Look 11-17 B15: a rollout the observer reads names its model (the reply's fallback for a linked folder).
    #[test]
    fn b15_codex_tail_names_the_model() {
        let dir = root();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout.jsonl");
        let ctx = r#"{"type":"turn_context","payload":{"model":"gpt-6.1-sol","cwd":"/p"}}"#;
        fs::write(&file, format!("{{cut line\n{ctx}\n")).unwrap();
        assert_eq!(
            codex_tail(&file).unwrap().1.map(|s| s.0).as_deref(),
            Some("gpt-6.1-sol")
        );
        // A linked folder (the owner's ~/.codex/sessions) is followed; a linked file or a FIFO is refused.
        let linked = dir.join("linked-dir");
        std::os::unix::fs::symlink(&dir, &linked).unwrap();
        assert!(codex_tail(&linked.join("rollout.jsonl")).is_some());
        let link = dir.join("link.jsonl");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(codex_tail(&link).is_none());
        let fifo = dir.join("fifo.jsonl");
        let c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(codex_tail(&fifo).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
    fn root() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "context-reader-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(p.join("projects/p")).unwrap();
        p.canonicalize().unwrap()
    }
    fn line(input: u64) -> String {
        format!(
            "{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-sonnet-4-20250514\",\"usage\":{{\"input_tokens\":{input}}}}}}}\n"
        )
    }
    #[test]
    fn context_cold_walk_does_not_hold_global_cache_lock() {
        use std::{
            sync::{Arc, mpsc},
            time::{Duration, Instant},
        };
        let p = root();
        let other = "00000000-0000-4000-8000-000000000002";
        fs::write(p.join(format!("projects/p/{ID}.jsonl")), line(1)).unwrap();
        fs::write(p.join(format!("projects/p/{other}.jsonl")), line(2)).unwrap();
        let caches = Arc::new(Mutex::default());
        assert_eq!(
            read_cached(&caches, &p, ID, false, "p")
                .unwrap()
                .0
                .unwrap()
                .used,
            1
        );
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let cold_cache = caches.clone();
        let cold_root = p.clone();
        let cold = std::thread::spawn(move || {
            WALK_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }))
            });
            let start = Instant::now();
            let value = read_cached(&cold_cache, &cold_root, other, false, "p");
            (value, start.elapsed())
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let hit_cache = caches.clone();
        let hit_root = p.clone();
        let (hit_tx, hit_rx) = mpsc::channel();
        let hit = std::thread::spawn(move || {
            let start = Instant::now();
            let value = read_cached(&hit_cache, &hit_root, ID, false, "p");
            hit_tx.send((value, start.elapsed())).unwrap();
        });
        let result = hit_rx.recv_timeout(Duration::from_millis(250));
        release_tx.send(()).unwrap();
        let (cold_value, cold_cost) = cold.join().unwrap();
        hit.join().unwrap();
        assert_eq!(cold_value.unwrap().0.unwrap().used, 2);
        eprintln!("controlled cold scan/read cost: {cold_cost:?}; cache hit: {result:?}");
        fs::remove_dir_all(p).unwrap();
        assert_eq!(
            result
                .expect("cache hit blocked behind cold walk")
                .0
                .unwrap()
                .0
                .unwrap()
                .used,
            1
        );
    }

    #[test]
    fn b15_model_is_the_newest_main_chain_model() {
        let claude = concat!(
            r#"{"type":"assistant","message":{"model":"claude-fable-5-2","usage":{"input_tokens":1}}}"#,
            "\n",
            r#"{"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-4-5"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
            "\n"
        );
        assert_eq!(
            model(claude.as_bytes(), false).map(|s| s.0).as_deref(),
            Some("claude-fable-5-2")
        );
        let codex = concat!(
            r#"{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count"}}"#
        );
        assert_eq!(
            model(codex.as_bytes(), true).map(|s| s.0).as_deref(),
            Some("gpt-6.1-sol")
        );
        assert_eq!(model(claude.as_bytes(), true), None);
    }

    /// Look v9 S2-6 (ticket 994): the effort is the one the newest main-chain request ran at (Claude 2.1.327 writes
    /// it beside `requestedModel`; Codex in `turn_context`), none when that line names none or an odd value.
    #[test]
    fn t994_model_carries_the_effort_of_its_line() {
        let seen = |text: &str, codex| model(text.as_bytes(), codex);
        let claude = concat!(
            r#"{"type":"assistant","effort":"medium","message":{"model":"claude-sonnet-5-5"}}"#,
            "\n",
            r#"{"type":"assistant","effort":"high","perTurnEffort":"high","message":{"model":"claude-opus-5-5"}}"#,
            "\n",
            r#"{"type":"assistant","isSidechain":true,"effort":"low","message":{"model":"claude-haiku-4-5"}}"#,
        );
        assert_eq!(
            seen(claude, false),
            Some(("claude-opus-5-5".into(), Some("high".into())))
        );
        let none = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5"}}"#;
        assert_eq!(seen(none, false), Some(("claude-haiku-4-5".into(), None)));
        let odd =
            r#"{"type":"assistant","effort":"High <b>","message":{"model":"claude-opus-5-5"}}"#;
        assert_eq!(seen(odd, false), Some(("claude-opus-5-5".into(), None)));
        let codex = r#"{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"xhigh"}}"#;
        assert_eq!(
            seen(codex, true),
            Some(("gpt-6.1-sol".into(), Some("xhigh".into())))
        );
    }

    #[test]
    fn context_miss_cache_invalidates() {
        use std::time::{Duration, Instant};
        let p = root();
        fs::create_dir_all(p.join("sessions/2026/10")).unwrap();
        WALKS.with(|n| n.set(0));
        let mut cache = Cache::default();
        let start = Instant::now();
        for _ in 0..10 {
            assert_eq!(cache.read(&p, ID, true, "p"), None);
        }
        let walks = WALKS.with(|n| n.get());
        eprintln!("10 repeated misses: {walks} walks, {:?}", start.elapsed());
        assert_eq!(walks, 1, "repeated miss repeated the directory walk");
        let path = p.join(format!("sessions/2026/10/rollout-test-{ID}.jsonl"));
        fs::write(&path, r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":12},"model_context_window":200000}}}"#).unwrap();
        assert_eq!(
            cache.read(&p, ID, true, "p"),
            None,
            "nested creation remains Unknown until expiry"
        );
        std::thread::sleep(Duration::from_millis(1100));
        assert_eq!(cache.read(&p, ID, true, "p").unwrap().used, 12);
        assert_eq!(WALKS.with(|n| n.get()), 2);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn context_reader_security_regressions() {
        usage_op_reads_transcript_only_read_budget();
        usage_op_off_frame_loop_unchanged_file_one_stat_no_read();
        usage_unknown_tail_is_cached();
        usage_path_confined_opener_never_reads_outside_or_decoys();
        usage_counts_input_and_cache_partial_line_and_bad_store();
        let p = root();
        fs::create_dir_all(p.join("sessions/a")).unwrap();
        fs::create_dir_all(p.join("sessions/b")).unwrap();
        for dir in ["a", "b"] {
            fs::write(
                p.join(format!("sessions/{dir}/rollout-test-{ID}.jsonl")),
                line(1),
            )
            .unwrap();
        }
        let mut cache = Cache::default();
        assert_eq!(
            cache.read(&p, ID, true, "p"),
            None,
            "ambiguous transcript refused"
        );
        assert!(cache.opens.is_empty());
        assert!(cache.reads.is_empty());
        fs::write(p.join(format!("projects/p/{ID}.jsonl")), line(7)).unwrap();
        assert_eq!(
            cache.read(&p, ID, false, "p").unwrap().used,
            7,
            "Codex miss cannot hide Claude hit"
        );
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn usage_op_reads_transcript_only_read_budget() {
        let p = root();
        let path = p.join(format!("projects/p/{ID}.jsonl"));
        let mut bytes = vec![b'x'; 5 << 20];
        bytes.push(b'\n');
        bytes.extend(line(124000).bytes());
        fs::write(&path, bytes).unwrap();
        fs::write(p.join("projects/p/decoy.jsonl"), line(1)).unwrap();
        fs::create_dir_all(p.join("projects/p/archive")).unwrap();
        fs::write(p.join(format!("projects/p/archive/{ID}.jsonl")), line(1)).unwrap();
        let mut cache = Cache::default();
        assert_eq!(
            cache.read(&p, ID, false, "p"),
            Some(Context {
                used: 124000,
                window: Some(200000)
            })
        );
        assert_eq!(cache.reads, vec![(path.clone(), 262_144)]);
        assert_eq!(cache.opens, vec![path]);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn usage_op_off_frame_loop_unchanged_file_one_stat_no_read() {
        let p = root();
        let path = p.join(format!("projects/p/{ID}.jsonl"));
        fs::write(&path, line(1)).unwrap();
        let mut cache = Cache::default();
        assert_eq!(
            cache.read(&p, ID, false, "p"),
            Some(Context {
                used: 1,
                window: Some(200000)
            })
        );
        cache.reads.clear();
        cache.opens.clear();
        cache.stats = 0;
        assert_eq!(
            cache.read(&p, ID, false, "p"),
            Some(Context {
                used: 1,
                window: Some(200000)
            })
        );
        assert_eq!(cache.stats, 1);
        assert!(cache.reads.is_empty());
        assert!(cache.opens.is_empty());
        fs::write(&path, line(12000)).unwrap();
        assert_eq!(
            cache.read(&p, ID, false, "p"),
            Some(Context {
                used: 12000,
                window: Some(200000)
            })
        );
        assert_eq!(cache.reads.len(), 1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn usage_unknown_tail_is_cached() {
        let p = root();
        fs::write(
            p.join(format!("projects/p/{ID}.jsonl")),
            vec![b'x'; 300 << 10],
        )
        .unwrap();
        let mut cache = Cache::default();
        assert_eq!(cache.read(&p, ID, false, "p"), None);
        assert_eq!(cache.read(&p, ID, false, "p"), None);
        assert_eq!(
            cache.reads.len(),
            1,
            "an unchanged unknown tail is read only once"
        );
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn usage_path_confined_opener_never_reads_outside_or_decoys() {
        let p = root();
        let outside = p.join("outside.jsonl");
        fs::write(&outside, line(124000)).unwrap();
        let path = p.join(format!("projects/p/{ID}.jsonl"));
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        let mut cache = Cache::default();
        for id in [
            "../outside",
            "p/session",
            "..",
            "00000000-0000-4000-8000-000000000001/extra",
        ] {
            assert_eq!(cache.read(&p, id, false, "p"), None);
        }
        fs::write(p.join("projects/p/not-a-uuid.jsonl"), line(123)).unwrap();
        assert_eq!(cache.read(&p, "not-a-uuid", false, "p"), None);
        assert_eq!(cache.read(&p, ID, false, "p"), None);
        assert!(cache.reads.is_empty());
        assert!(cache.opens.is_empty());
        fs::remove_file(&path).unwrap();
        fs::write(&path, line(1)).unwrap();
        assert!(cache.read(&p, ID, false, "p").is_some());
        cache.reads.clear();
        cache.opens.clear();
        fs::rename(p.join("projects"), p.join("moved")).unwrap();
        std::os::unix::fs::symlink(p.join("moved"), p.join("projects")).unwrap();
        assert_eq!(cache.read(&p, ID, false, "p"), None);
        assert!(cache.reads.is_empty());
        assert!(cache.opens.is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    /// Ticket 1048: a 1M session (a model outside the table) answers with the window its status line reported; with no
    /// status line it still answers no number, never a guessed window.
    #[test]
    fn t1048_status_line_window_wins_and_no_guess() {
        let fill = Some(Context {
            used: 359_900,
            window: None,
        });
        let seen = || Some(("claude-fable-5-2".to_string(), None));
        let id = "t1048-session";
        assert_eq!(told(id), None);
        observe(
            id,
            &serde_json::json!({"context_window_size": 1_000_000, "used_percentage": 36}),
        );
        assert_eq!(told(id), Some(1_000_000));
        // A status line without a size (before the first response) keeps what was told.
        observe(id, &Value::Null);
        observe(id, &serde_json::json!({"context_window_size": null}));
        assert_eq!(told(id), Some(1_000_000));
        assert!(matches!(
            reply_of(fill, seen(), told(id)),
            Reply::SessionContext {
                used: 359_900,
                window: 1_000_000,
                ..
            }
        ));
        // The status line wins over the table, too.
        let table = Some(Context {
            used: 250_000,
            window: Some(200_000),
        });
        assert!(matches!(
            reply_of(table, None, told(id)),
            Reply::SessionContext {
                window: 1_000_000,
                ..
            }
        ));
        assert!(matches!(
            reply_of(fill, seen(), None),
            Reply::SessionModel { .. }
        ));
        assert!(matches!(reply_of(fill, None, None), Reply::Unknown));
        assert_eq!(told("t1048-other"), None);
    }
    #[test]
    fn usage_counts_input_and_cache_partial_line_and_bad_store() {
        let p = root();
        let path = p.join(format!("projects/p/{ID}.jsonl"));
        let mut bytes = vec![b'x'; 300 << 10];
        bytes.extend(b"\n");
        bytes.extend(line(124000).bytes());
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            Cache::default().read(&p, ID, false, "p"),
            Some(Context {
                used: 124000,
                window: Some(200000)
            })
        );
        // Ticket 1048: a fill above its window is read, then refused where the status line's window can replace it.
        let excessive = line(250000);
        for over in [
            excessive.as_bytes(),
            br#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":20},"model_context_window":10}}}"#,
        ] {
            fs::write(&path, over).unwrap();
            let read = Cache::default().read(&p, ID, false, "p");
            assert!(matches!(reply_of(read, None, None), Reply::Unknown));
        }
        for bad in [
            b"{broken".as_slice(),
            b"[]",
            br#"{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":"12"}}}"#,
        ] {
            fs::write(&path, bad).unwrap();
            let before = fs::read(&path).unwrap();
            assert_eq!(Cache::default().read(&p, ID, false, "p"), None);
            assert_eq!(fs::read(&path).unwrap(), before);
        }
        fs::remove_dir_all(p).unwrap();
    }
    /// Ticket 1059: the fixture's table reads to its 8 rows; the MCP section after it is not read.
    #[test]
    fn t1059_context_table_reads_eight_rows() {
        let record = context_record();
        let got = breakdown(format!("{record}\n").as_bytes()).unwrap();
        assert_eq!(got.at, 1795400559000);
        let rows: Vec<(&str, u64, f64)> = got
            .rows
            .iter()
            .map(|r| (r.label.as_str(), r.tokens, r.pct))
            .collect();
        assert_eq!(
            rows,
            [
                ("System prompt", 4_500, 0.4),
                ("System tools", 3_400, 0.3),
                ("MCP server instructions", 1_100, 0.1),
                ("Memory files", 4_300, 0.4),
                ("Skills", 10_000, 1.0),
                ("Messages", 232_500, 23.2),
                ("Free space", 711_300, 71.1),
                ("Autocompact buffer", 33_000, 3.3),
            ]
        );
        assert_eq!(tokens_of("1m"), Some(1_000_000));
        assert_eq!(tokens_of("711.3k"), Some(711_300));
        assert_eq!(tokens_of("812"), Some(812));
        assert_eq!(tokens_of("k"), None);
    }
    /// Ticket 1059: a /context record without its table is the could-not-read state (no rows), not an error.
    #[test]
    fn t1059_record_without_table_reads_no_rows() {
        let mut record = context_record();
        record["message"]["content"] = "## Context Usage\n\n**Tokens:** 1k / 1m (0%)\n".into();
        let got = breakdown(format!("{record}\n").as_bytes()).unwrap();
        assert!(got.rows.is_empty());
        // Without any /context record there is no breakdown at all.
        assert_eq!(breakdown(line(1).as_bytes()), None);
    }
    /// Ticket 1059: after /clear, /new, /compact (either record form) or a compaction the cached table is dropped.
    #[test]
    fn t1059_breakdown_dropped_after_clear() {
        let record = context_record();
        let later = [
            json!({"type":"system","subtype":"local_command","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>"}),
            json!({"type":"user","message":{"role":"user","content":"<command-name>/new</command-name>"}}),
            json!({"type":"system","subtype":"local_command","content":"<command-name>/compact</command-name>"}),
            json!({"type":"system","subtype":"compact_boundary"}),
        ];
        for after in later {
            assert_eq!(
                breakdown(format!("{record}\n{after}\n").as_bytes()),
                None,
                "{after}"
            );
        }
        // Another command (or a turn) after it keeps it.
        let other = json!({"type":"system","subtype":"local_command","content":"<command-name>/context</command-name>"});
        assert!(breakdown(format!("{record}\n{other}\n{}", line(5)).as_bytes()).is_some());
        // Through the reader's cache: the same file read again after /clear answers no breakdown.
        let p = root();
        let path = p.join(format!("projects/p/{ID}.jsonl"));
        fs::write(&path, format!("{}{record}\n", line(1))).unwrap();
        let caches = Mutex::default();
        assert!(
            read_cached(&caches, &p, ID, false, "p")
                .unwrap()
                .2
                .is_some()
        );
        fs::write(&path, format!("{}{record}\n{}\n", line(1), later_clear())).unwrap();
        assert!(
            read_cached(&caches, &p, ID, false, "p")
                .unwrap()
                .2
                .is_none()
        );
        fs::remove_dir_all(p).unwrap();
    }
    fn later_clear() -> Value {
        json!({"type":"system","subtype":"local_command","content":"<command-name>/clear</command-name>"})
    }
    /// Ticket 1059: /context goes in only for a local Claude at rest.
    #[test]
    fn t1059_refresh_refused_unless_idle_claude() {
        assert_eq!(may_refresh(true, false, false, false), Ok(()));
        let why = |r: Result<(), String>| r.unwrap_err();
        assert_eq!(
            why(may_refresh(false, false, false, false)),
            "context breakdown not sent: the breakdown is read from a local Claude session only"
        );
        assert_eq!(
            why(may_refresh(true, true, false, false)),
            "context breakdown not sent: the agent is working"
        );
        assert_eq!(
            why(may_refresh(true, true, true, false)),
            "context breakdown not sent: a question is waiting for an answer"
        );
        assert_eq!(
            why(may_refresh(true, false, false, true)),
            "context breakdown not sent: words are typed in the terminal input"
        );
    }
}
