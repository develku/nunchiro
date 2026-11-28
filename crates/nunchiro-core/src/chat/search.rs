//! V2-7: the Sessions scope of Search. An on-demand scan, no index: each listed session's transcript is read raw and
//! prefiltered for the query's bytes; only the lines that hold them are parsed and projected (the chat projection, in
//! memory), and the events whose text matches are the hits. A hit names its place among the session's matching events
//! (`n`); `sessions_hit` turns that into the chat cursor the window opens at, through the chat cache the chat view
//! reads (built then, as opening that chat builds it). Only registry sessions are read, through the chat view's own
//! path checks (ADR 0001 confinement).
use super::{
    TESTED_VERSIONS,
    log::Log,
    persistence::{State, read_json},
    project, tested,
};
use crate::{
    api::{AgentKind, Reply, Request, Session},
    sessions::Sessions,
    waiting::transcript,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// Window only, like `themes_online::Op`: the owner socket and agent tokens cannot express it.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    /// `sessions` in the order to scan; the window sends the rest again after each page. A newer page on the same
    /// `channel` (one Search panel) cancels this one.
    SessionsSearch {
        query: String,
        sessions: Vec<String>,
        #[serde(default)]
        channel: String,
    },
    /// The chat cursor of hit `n` of `query` in `session`; `text` (the hit's snippet) picks the matching event with
    /// that text nearest the `n`th, so a count that differs from the chat cache's still opens the hit.
    SessionsHit {
        session: String,
        query: String,
        n: usize,
        #[serde(default)]
        text: String,
    },
}

pub const MAX_QUERY: usize = 256;
const MAX_SESSIONS: usize = 10_000;
const MAX_HITS: usize = 50;
const PAGE_TIME: Duration = Duration::from_millis(250);
/// Ticket 438: one transcript's scan stops here (and at the file's size when opened); a page holds its job at most
/// about this long. Long enough that a whole transcript of a few hundred MiB is still searched in one go.
const SCAN_TIME: Duration = Duration::from_secs(5);
const _: () = assert!(SCAN_TIME.as_millis() == 20 * PAGE_TIME.as_millis());
const CHUNK: usize = 1024 * 1024;
/// `transcript::read_batch` reads 1 MiB from a line's start: a longer line never becomes chat events.
const LINE_MAX: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "SearchFound"))]
pub struct Found {
    pub session: String,
    /// `ok` (hits), `missing` (no transcript), `untested` (agent version whose chat shows final text only), `error`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub hits: Vec<Hit>,
    /// More than `MAX_HITS` events matched.
    #[serde(default)]
    pub more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Hit {
    /// Its place among the session's matching events, in chat order: the event id `sessions_hit` resolves.
    pub n: usize,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The matching text around the first match, on one line.
    pub text: String,
}

pub(crate) fn check_query(query: &str) -> Result<String, String> {
    if query.trim().is_empty() || query.len() > MAX_QUERY {
        return Err(format!("search text must be 1 to {MAX_QUERY} bytes"));
    }
    let needle = query.to_ascii_lowercase();
    // Quotes, backslashes and control characters are escaped in a transcript, so a query of only those gives no raw
    // prefilter and every line would be parsed.
    if raw_needle(&needle).is_empty() {
        return Err("search text needs at least one plain character".into());
    }
    Ok(needle)
}

/// Why `hit` failed: `Moved` is the chat cache changing generation between the build and the read (worth one more try).
enum HitError {
    Moved(String),
    Other(String),
}
impl<E: Into<String>> From<E> for HitError {
    fn from(e: E) -> Self {
        Self::Other(e.into())
    }
}
/// Runs `f` again once when the cache moved (a chat poll started a new generation between the build and the read);
/// every other error is returned at once. shortcut: every `Log::open` failure counts as moved (it returns plain
/// strings), so a corrupt log is tried twice; type its errors if that ever matters.
fn retry_if_moved<T>(mut f: impl FnMut() -> Result<T, HitError>) -> Result<T, String> {
    match f() {
        Err(HitError::Moved(_)) => f(),
        r => r,
    }
    .map_err(|(HitError::Moved(e) | HitError::Other(e))| e)
}

pub fn run(
    registry: &Mutex<Sessions>,
    home: &Path,
    op: Op,
    cancel: &AtomicBool,
) -> Result<Reply, String> {
    low_priority();
    match op {
        Op::SessionsSearch {
            query, sessions, ..
        } => search(registry, &query, &sessions, cancel),
        Op::SessionsHit {
            session,
            query,
            n,
            text,
        } => retry_if_moved(|| hit(registry, home, &session, &query, n, &text)),
    }
}

/// One page: sessions from the front of `ids` until one yields a result or the page time is spent. `scanned` says how
/// many ids were consumed; the window sends the rest. `cancel` stops between chunks.
fn search(
    registry: &Mutex<Sessions>,
    query: &str,
    sessions: &[String],
    cancel: &AtomicBool,
) -> Result<Reply, String> {
    let needle = check_query(query)?;
    if sessions.is_empty() || sessions.len() > MAX_SESSIONS {
        return Err(format!("search lists 1 to {MAX_SESSIONS} sessions"));
    }
    let started = Instant::now();
    // The registry's rows, read once per page as the window's snapshot reads them: the scan takes no chat cache slot.
    let Reply::Snapshot { sessions: rows, .. } = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .handle(Request::List)?
    else {
        return Err("session list unavailable".into());
    };
    let rows: std::collections::BTreeMap<String, Session> =
        rows.into_iter().map(|s| (s.id.clone(), s)).collect();
    let raw = raw_needle(&needle);
    let mut results = vec![];
    let mut scanned = 0;
    for id in sessions {
        if cancel.load(Ordering::Relaxed) {
            return Err("search canceled".into());
        }
        scanned += 1;
        // Ids that are not this core's sessions (crafted, or removed since the window listed them) are skipped unread.
        let Some(meta) = rows.get(id) else {
            continue;
        };
        if let Some(found) = session(meta, &needle, &raw, cancel)? {
            results.push(found);
        }
        if !results.is_empty() || started.elapsed() >= PAGE_TIME {
            break;
        }
    }
    Ok(Reply::SessionsSearch { scanned, results })
}

/// A session's transcript, checked as the chat view checks it, or the status to show instead (`None`: a shell).
pub(crate) fn transcript_of(
    meta: &Session,
    observed: Option<PathBuf>,
) -> Option<Result<PathBuf, (&'static str, Option<String>)>> {
    if meta.kind == AgentKind::Shell {
        return None;
    }
    if !tested(meta.kind, meta.agent_version.as_deref(), TESTED_VERSIONS) {
        return Some(Err(("untested", None)));
    }
    let Some(path) = observed.or_else(|| transcript::locate(meta)) else {
        return Some(Err(("missing", None)));
    };
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Err(("missing", None))),
        Err(e) => return Some(Err(("error", Some(e.to_string())))),
        Ok(_) => {}
    }
    // The chat view's check: the claimed conversation's own file under the agent's data root, symlinks resolved.
    Some(transcript::validate_path(meta, &path).map_err(|e| ("error", Some(e))))
}

fn session(
    meta: &Session,
    needle: &str,
    raw: &[u8],
    cancel: &AtomicBool,
) -> Result<Option<Found>, String> {
    let found = |status: &str, error: Option<String>| Found {
        session: meta.id.clone(),
        status: status.into(),
        error,
        hits: vec![],
        more: false,
    };
    let path = match transcript_of(meta, None) {
        None => return Ok(None),
        Some(Err((status, error))) => return Ok(Some(found(status, error))),
        Some(Ok(path)) => path,
    };
    match scan(meta.kind, &path, needle, raw, cancel) {
        // Ticket 438: a scan cut at its bound with nothing found yet still says the transcript was not read whole.
        Ok((hits, true)) if hits.is_empty() => Ok(Some(found(
            "error",
            Some("stopped at the search time limit".into()),
        ))),
        Ok((hits, _)) if hits.is_empty() => Ok(None),
        Ok((hits, more)) => Ok(Some(Found {
            hits,
            more,
            ..found("ok", None)
        })),
        Err(e) if e == "search canceled" => Err(e),
        Err(e) => Ok(Some(found("error", Some(e)))),
    }
}

/// The transcript's complete lines that hold `raw`, projected as `read_batch` and the chat cache would (a line over
/// `LINE_MAX` or unparsable is skipped; a half-written last line is not read yet), and their matching events. The
/// bool is `more`: over `MAX_HITS` matched, or (ticket 438) `SCAN_TIME` ran out first, shown as `+` either way.
pub(crate) fn scan(
    kind: AgentKind,
    path: &Path,
    needle: &str,
    raw: &[u8],
    cancel: &AtomicBool,
) -> Result<(Vec<Hit>, bool), String> {
    scan_until(kind, path, needle, raw, cancel, Instant::now() + SCAN_TIME)
}
fn scan_until(
    kind: AgentKind,
    path: &Path,
    needle: &str,
    raw: &[u8],
    cancel: &AtomicBool,
    until: Instant,
) -> Result<(Vec<Hit>, bool), String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("transcript is not a regular file".into());
    }
    #[cfg(test)]
    if let Some(grow) = tests::AFTER_OPEN.take() {
        grow(path);
    }
    // Ticket 438: only the bytes there when opened; what an agent appends meanwhile is the next search's.
    let mut file = file.take(meta.len());
    let mut buf: Vec<u8> = Vec::with_capacity(2 * CHUNK);
    let mut lower: Vec<u8> = Vec::with_capacity(2 * CHUNK);
    let mut discarding = false;
    let (mut hits, mut n, mut more) = (vec![], 0, false);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("search canceled".into());
        }
        if Instant::now() >= until {
            return Ok((hits, true));
        }
        let held = buf.len();
        buf.resize(held + CHUNK, 0);
        let got = file.read(&mut buf[held..]).map_err(|e| e.to_string())?;
        buf.truncate(held + got);
        if got == 0 {
            return Ok((hits, more));
        }
        let Some(last) = buf.iter().rposition(|b| *b == b'\n') else {
            // A line already longer than `LINE_MAX` is dropped up to its end, as `read_batch` drops it.
            if buf.len() >= LINE_MAX {
                buf.clear();
                discarding = true;
            }
            continue;
        };
        lower.clear();
        lower.extend_from_slice(&buf[..last]);
        lower.make_ascii_lowercase();
        let mut first = 0;
        if discarding {
            first = buf.iter().position(|b| *b == b'\n').unwrap() + 1;
            discarding = false;
        }
        let mut at = first;
        while let Some(i) = lower.get(at..).and_then(|h| find(h, raw)) {
            let hit = at + i;
            let start = lower[..hit]
                .iter()
                .rposition(|b| *b == b'\n')
                .map_or(0, |p| p + 1)
                .max(first);
            let end = lower[hit..]
                .iter()
                .position(|b| *b == b'\n')
                .map_or(last, |p| hit + p);
            at = end + 1;
            let line = &buf[start..end];
            if line.len() + 1 > LINE_MAX {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            for event in project(kind, &record) {
                let Some(text) = matching(&event, needle) else {
                    continue;
                };
                if hits.len() == MAX_HITS {
                    more = true;
                } else {
                    hits.push(Hit {
                        n,
                        kind: event["kind"].as_str().unwrap_or_default().into(),
                        role: event["role"].as_str().map(str::to_string),
                        text,
                    });
                }
                n += 1;
            }
            if at > last {
                break;
            }
        }
        buf.drain(..=last);
    }
}

/// Builds the session's chat cache as opening its chat does, then finds the hit among its matching events: the one
/// whose snippet is `text`, nearest the `n`th (the scan's count can differ, from a cache built by an older
/// projection or a line the raw prefilter missed), else the `n`th.
fn hit(
    registry: &Mutex<Sessions>,
    home: &Path,
    id: &str,
    query: &str,
    n: usize,
    text: &str,
) -> Result<Reply, HitError> {
    let needle = check_query(query)?;
    let plan = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .chat_plan(id, None, None)
        .map_err(|_| "session not found")?;
    let meta = plan.meta.clone();
    match transcript_of(&meta, plan.path.clone()) {
        None => return Err("session not found".into()),
        Some(Err((status, error))) => return Err(error.unwrap_or_else(|| status.into()).into()),
        Some(Ok(_)) => {}
    }
    plan.read()?;
    let dir = home.join("chat");
    let key = super::session_key(&meta);
    let state: State = read_json(&dir.join(format!("{key}.json")))?
        .ok_or_else(|| HitError::Moved("chat cache missing".into()))?;
    // The log files of an older generation are gone or shorter than the state just read says.
    let log = Log::open(&dir, state.events).map_err(HitError::Moved)?;
    let (mut seen, mut nth, mut best) = (0usize, None, None::<(usize, u64)>);
    log.each(|event| {
        if let Some(snippet) = matching(&event.data, &needle) {
            if seen == n {
                nth = Some(event.cursor);
            }
            let off = seen.abs_diff(n);
            if snippet == text && best.is_none_or(|(d, _)| off < d) {
                best = Some((off, event.cursor));
            }
            seen += 1;
        }
        Ok(())
    })?;
    Ok(Reply::SessionsHit {
        cursor: best.map(|(_, c)| c).or(nth),
        generation: state.generation,
    })
}

/// The query as JSON writes it inside a string, longest run without escaped characters (transcripts escape quotes,
/// backslashes and control characters). shortcut: text a writer stored as `\uXXXX` escapes (Codex tool arguments are
/// JSON inside a string) is not found by the scan; parse every line holding `\u` if that ever matters.
pub(crate) fn raw_needle(needle: &str) -> Vec<u8> {
    needle
        .split(|c: char| c == '"' || c == '\\' || c.is_control())
        .max_by_key(|s| s.len())
        .unwrap_or_default()
        .as_bytes()
        .to_vec()
}

/// The first index of `needle`; an empty needle (a query of quotes only) is found at once, so every line is parsed.
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    let Some((&first, rest)) = needle.split_first() else {
        return Some(0);
    };
    let mut at = 0;
    while let Some(i) = hay.get(at..)?.iter().position(|&b| b == first) {
        let start = at + i;
        if hay[start + 1..].starts_with(rest) {
            return Some(start);
        }
        at = start + 1;
    }
    None
}

/// Keys whose values are identities or image bytes, never text a reader searched for.
const SKIP: &[&str] = &["kind", "role", "tool_id", "turn_id", "source", "operation"];

/// The snippet of the first string in a chat event that holds the needle (ASCII case-insensitive). Artifact cards
/// are not searched: the cache adds them only when their file saves, so counting them would shift `n`.
fn matching(event: &Value, needle: &str) -> Option<String> {
    if matches!(event["kind"].as_str(), Some("artifact" | "skipped")) {
        return None;
    }
    text(event, needle)
}
fn text(data: &Value, needle: &str) -> Option<String> {
    match data {
        Value::String(s) => {
            s.to_ascii_lowercase().find(needle)?;
            // Look 1117 v9 (A N-S3-1): a lead's brief is a long paste; its hit reads as the title does, without the tags.
            let s = crate::import::without_paste_marks(s);
            let at = s.to_ascii_lowercase().find(needle)?;
            Some(snippet(&s, at, needle.len()))
        }
        Value::Array(a) => a.iter().find_map(|v| text(v, needle)),
        Value::Object(o) => o
            .iter()
            .filter(|(k, _)| !SKIP.contains(&k.as_str()))
            .find_map(|(_, v)| text(v, needle)),
        _ => None,
    }
}

pub(crate) fn snippet(s: &str, at: usize, len: usize) -> String {
    let mut start = at.saturating_sub(60);
    while !s.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + len + 140).min(s.len());
    while !s.is_char_boundary(end) {
        end += 1;
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(
        s[start..end]
            .chars()
            .map(|c| if c.is_whitespace() { ' ' } else { c }),
    );
    if end < s.len() {
        out.push('…');
    }
    out
}

/// Waiting detection and the window's own frames go first: the scan runs at utility QoS (CPU and disk).
fn low_priority() {
    #[cfg(target_os = "macos")]
    // SAFETY: changes only the calling thread's QoS class; a failure leaves the default, which is harmless.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_needle_keeps_the_longest_unescaped_run() {
        assert_eq!(raw_needle("say \"retire now\" ok"), b"retire now");
        assert_eq!(raw_needle("plain"), b"plain");
    }
    #[test]
    fn query_without_plain_character_is_refused() {
        for q in ["\"", "\\", "\"\\\"", "\u{1}"] {
            assert!(check_query(q).is_err(), "{q:?}");
        }
        assert_eq!(
            check_query("\"").unwrap_err(),
            "search text needs at least one plain character"
        );
        assert_eq!(check_query("A\"b").unwrap(), "a\"b");
    }
    #[test]
    fn hit_retries_only_when_the_cache_moved() {
        let mut attempts = 0;
        let moved_once = retry_if_moved(|| {
            attempts += 1;
            if attempts == 1 {
                Err(HitError::Moved("chat cache missing".into()))
            } else {
                Ok(7)
            }
        });
        assert_eq!((moved_once, attempts), (Ok(7), 2));
        // Another failure whose text happens to hold "chat" is returned at once.
        let mut attempts = 0;
        let other = retry_if_moved(|| -> Result<u8, HitError> {
            attempts += 1;
            Err(HitError::Other("session chat-1 not found".into()))
        });
        assert_eq!(
            (other, attempts),
            (Err("session chat-1 not found".into()), 1)
        );
        // A cache that keeps moving is tried twice, not forever.
        let mut attempts = 0;
        let _ = retry_if_moved(|| -> Result<u8, HitError> {
            attempts += 1;
            Err(HitError::Moved("incomplete chat log".into()))
        });
        assert_eq!(attempts, 2);
    }
    #[test]
    fn find_and_snippet_cover_edges() {
        assert_eq!(find(b"abcabd", b"abd"), Some(3));
        assert_eq!(find(b"ab", b"abc"), None);
        let s = format!("{}그룹 정리{}", "가".repeat(40), "x".repeat(300));
        let at = s.find("그룹").unwrap();
        let out = snippet(&s, at, "그룹 정리".len());
        assert!(out.starts_with('…') && out.ends_with('…') && out.contains("그룹 정리"));
    }
    std::thread_local! {
        /// Run once by the next `scan_until` on this thread, right after it opened the transcript.
        pub(super) static AFTER_OPEN: std::cell::Cell<Option<fn(&Path)>> = const { std::cell::Cell::new(None) };
    }
    fn line(text: &str) -> String {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string()
            + "\n"
    }
    /// Ticket 438: a transcript is read to its size when the scan opened it; a match an agent appends after the open
    /// is the next search's. A scan out of time returns what it found as `more`; a canceled one stops.
    #[test]
    fn scan_of_a_growing_transcript_ends_within_its_bounds() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("ns-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, line("first zebra")).unwrap();
        AFTER_OPEN.set(Some(|path| {
            let mut f = OpenOptions::new().append(true).open(path).unwrap();
            f.write_all(line("late zebra").as_bytes()).unwrap();
        }));
        let (raw, never) = (raw_needle("zebra"), AtomicBool::new(false));
        let asked = Instant::now();
        let first = scan(AgentKind::Claude, &path, "zebra", &raw, &never);
        let grew = std::fs::read_to_string(&path).unwrap();
        let late = scan_until(AgentKind::Claude, &path, "zebra", &raw, &never, asked);
        let canceled = scan(
            AgentKind::Claude,
            &path,
            "zebra",
            &raw,
            &AtomicBool::new(true),
        );
        let next = scan(AgentKind::Claude, &path, "zebra", &raw, &never);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(grew.contains("late zebra"), "the hook did not append");
        let (hits, more) = first.unwrap();
        assert!(!more);
        assert_eq!(
            hits.iter().map(|h| h.text.as_str()).collect::<Vec<_>>(),
            ["first zebra"]
        );
        assert!(late.is_ok_and(|(hits, more)| hits.is_empty() && more));
        assert_eq!(canceled.unwrap_err(), "search canceled");
        assert_eq!(next.unwrap().0.len(), 2);
    }
    #[test]
    fn matching_skips_identities_and_image_bytes() {
        let event = serde_json::json!({"kind":"image","role":"user","source":{"type":"base64","data":"retire"}});
        assert_eq!(matching(&event, "retire"), None);
        let event = serde_json::json!({"kind":"tool_use","tool_id":"retire","name":"Bash","input":{"command":"retire x"}});
        assert_eq!(matching(&event, "retire").as_deref(), Some("retire x"));
        let event = serde_json::json!({"kind":"user","text":"<pasted_content id=\"6597\" lines=\"9\">\nSay you are ready.\n</pasted_content id=\"6597\">"});
        assert_eq!(
            matching(&event, "ready").as_deref(),
            Some(" Say you are ready. ")
        );
        assert_eq!(matching(&event, "pasted_content"), None);
    }
}
