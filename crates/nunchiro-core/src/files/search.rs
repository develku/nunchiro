//! Literal text search under a confined folder, honouring `.gitignore`.
//!
//! The walk is ours rather than the `ignore` crate's directory walker: that walker parses an ignore
//! file with no way to stop it, so a cloned repo with a huge one froze the core. Here an ignore file
//! over `MAX_IGNORE_FILE` is skipped and reported, and the deadline is checked on every entry. The
//! crate still matches the patterns (`Gitignore`).
use super::{MAX_READ, Match, SNIFF, confine, confine::Root};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

const MAX_MATCHES: usize = 200;
const MAX_QUERY: usize = 256;
const MAX_LINE: usize = 300;
const BUDGET: Duration = Duration::from_secs(2);
/// Real `.gitignore` files are a few KB; anything past this is skipped (and reported) unparsed.
const MAX_IGNORE_FILE: u64 = 64 * 1024;
/// Entries read from one folder and folders walked into: past either the walk stops early (`truncated`), so one
/// huge or very deep folder can neither fill memory nor take the whole budget before the deadline is checked.
const MAX_DIR_ENTRIES: usize = 5_000;
const MAX_DEPTH: usize = 32;
/// Names mode keeps this many name matches to rank before it cuts to `MAX_MATCHES` (ticket 821 round 2).
const NAME_POOL: usize = 5_000;
/// Searches running at once across all windows; further ones are told to retry.
const MAX_SEARCHES: usize = 3;
static RUNNING: AtomicUsize = AtomicUsize::new(0);

pub struct Found {
    pub matches: Vec<Match>,
    pub truncated: bool,
    /// Ignore files (relative paths) not applied: over the size cap, unreadable or unparsable. Names mode leaves
    /// their folders out; text search still searches them.
    pub skipped_ignore_files: Vec<String>,
}

struct Slot;
impl Slot {
    fn take() -> Option<Self> {
        RUNNING
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_SEARCHES).then_some(n + 1)
            })
            .ok()
            .map(|_| Slot)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Names {
    query: String,
    /// Files whose own name holds the query; ranked, then cut to `MAX_MATCHES`.
    hits: Vec<String>,
    /// Files where only a folder name holds it: listed after every name hit, never in their place.
    folder_only: Vec<String>,
}

/// The same order as the finder's (web/src/files/QuickOpen.tsx rankPaths): the name itself (with or without its
/// extension), a name that starts with the query, one that holds it; then the shorter path, then A to Z.
fn rank(path: &str, query: &str) -> (u8, usize, String) {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
    let tier = if name == query || stem == query {
        0
    } else if name.starts_with(query) {
        1
    } else {
        2
    };
    (tier, path.len(), path.to_string())
}

struct Walk<'a> {
    query: &'a str,
    /// Ticket 821: the lowercased query matched against each file's relative path; no file is read.
    names: Option<Names>,
    base: &'a Path,
    anchor: &'a Path,
    deadline: Instant,
    found: Found,
    done: bool,
}

pub fn search(root: &Root, query: &str, rel: &str, names: bool) -> Result<Found, String> {
    if query.is_empty() || query.len() > MAX_QUERY {
        return Err("query must be 1 to 256 bytes".into());
    }
    let _slot = Slot::take().ok_or("search busy: try again in a moment")?;
    let start = confine::open(root, rel)?;
    if !start.file.metadata().map_err(|e| e.to_string())?.is_dir() {
        return Err("not a folder".into());
    }
    let mut walk = Walk {
        query,
        names: names.then(|| Names {
            query: query.to_lowercase(),
            ..Names::default()
        }),
        base: &start.base,
        anchor: &start.anchor,
        deadline: Instant::now() + BUDGET,
        found: Found {
            matches: vec![],
            truncated: false,
            skipped_ignore_files: vec![],
        },
        done: false,
    };
    walk.dir(&start.path, &mut vec![], 0);
    if let Some(mut n) = walk.names.take() {
        n.hits.sort_by_cached_key(|p| rank(p, &n.query));
        n.folder_only.sort_by_cached_key(|p| (p.len(), p.clone()));
        let all = n.hits.into_iter().chain(n.folder_only);
        let mut paths: Vec<String> = all.take(MAX_MATCHES + 1).collect();
        if paths.len() > MAX_MATCHES {
            paths.truncate(MAX_MATCHES);
            walk.found.truncated = true;
        }
        walk.found.matches = paths
            .into_iter()
            .map(|path| Match {
                path,
                line: 0,
                text: String::new(),
            })
            .collect();
    }
    Ok(walk.found)
}

impl Walk<'_> {
    fn out_of_budget(&mut self) -> bool {
        let full = match &self.names {
            Some(n) => n.hits.len() >= NAME_POOL,
            None => self.found.matches.len() >= MAX_MATCHES,
        };
        if !self.done && (Instant::now() >= self.deadline || full) {
            self.done = true;
            self.found.truncated = true;
        }
        self.done
    }

    /// Only the ignore files of this folder tree apply: a parent repo's rules or the user's global ones
    /// would hide files the window shows. Hidden files are searched; `.git` never is; links are not followed.
    fn dir(&mut self, dir: &Path, rules: &mut Vec<Gitignore>, depth: usize) {
        if depth > MAX_DEPTH {
            self.found.truncated = true;
            return;
        }
        // Re-verify the folder itself: a link swapped in for it after the parent was listed.
        if confine::open_under(dir, self.base).is_err() {
            return;
        }
        let mut pushed = false;
        let ignore_file = dir.join(".gitignore");
        if let Ok(meta) = ignore_file.symlink_metadata()
            && meta.is_file()
        {
            // Never opened when over the cap: parsing a huge one is what froze the core.
            let built = (meta.len() <= MAX_IGNORE_FILE)
                .then(|| self.open(&ignore_file))
                .flatten()
                .and_then(|file| {
                    let mut text = String::new();
                    file.take(MAX_IGNORE_FILE).read_to_string(&mut text).ok()?;
                    let mut b = GitignoreBuilder::new(dir);
                    for line in text.lines() {
                        let _ = b.add_line(None, line);
                    }
                    b.build().ok()
                });
            if let Some(g) = built {
                rules.push(g);
                pushed = true;
            } else {
                if let Ok(rel) = ignore_file.strip_prefix(self.anchor) {
                    self.found
                        .skipped_ignore_files
                        .push(rel.to_string_lossy().into_owned());
                }
                // Names mode fails closed: without its rules this folder could list the very files they ignore.
                if self.names.is_some() {
                    return;
                }
            }
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            if pushed {
                rules.pop();
            }
            return;
        };
        let mut read: Vec<_> = read.flatten().take(MAX_DIR_ENTRIES + 1).collect();
        if read.len() > MAX_DIR_ENTRIES {
            read.truncate(MAX_DIR_ENTRIES);
            self.found.truncated = true;
        }
        let mut entries: Vec<(String, PathBuf, bool)> = read
            .into_iter()
            .filter_map(|e| {
                let t = e.file_type().ok()?;
                (t.is_dir() || t.is_file()).then(|| {
                    (
                        e.file_name().to_string_lossy().into_owned(),
                        e.path(),
                        t.is_dir(),
                    )
                })
            })
            .collect();
        entries.sort();
        for (name, path, is_dir) in entries {
            if self.out_of_budget() {
                break;
            }
            if name.eq_ignore_ascii_case(".git") || ignored(rules, &path, is_dir) {
                continue;
            }
            if is_dir {
                self.dir(&path, rules, depth + 1);
            } else {
                self.file(&path);
            }
        }
        if pushed {
            rules.pop();
        }
    }

    fn open(&self, path: &Path) -> Option<std::fs::File> {
        confine::open_under(path, self.base).ok()
    }

    fn file(&mut self, path: &Path) {
        if let Some(n) = &mut self.names {
            if let Ok(rel) = path.strip_prefix(self.anchor) {
                let rel = rel.to_string_lossy().into_owned();
                let lower = rel.to_lowercase();
                let name = lower.rsplit('/').next().unwrap_or(&lower);
                if name.contains(n.query.as_str()) {
                    n.hits.push(rel);
                } else if lower.contains(n.query.as_str()) {
                    if n.folder_only.len() < MAX_MATCHES {
                        n.folder_only.push(rel);
                    } else {
                        self.found.truncated = true;
                    }
                }
            }
            return;
        }
        let Some(file) = self.open(path) else {
            return;
        };
        let mut bytes = Vec::new();
        if file.take(MAX_READ + 1).read_to_end(&mut bytes).is_err()
            || bytes.len() as u64 > MAX_READ
            || bytes[..bytes.len().min(SNIFF)].contains(&0)
        {
            return;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return;
        };
        let Ok(rel) = path.strip_prefix(self.anchor) else {
            return;
        };
        for (i, line) in text.lines().enumerate() {
            if line.contains(self.query) {
                if self.found.matches.len() >= MAX_MATCHES {
                    self.done = true;
                    self.found.truncated = true;
                    return;
                }
                self.found.matches.push(Match {
                    path: rel.to_string_lossy().into_owned(),
                    line: i as u64 + 1,
                    text: line.chars().take(MAX_LINE).collect(),
                });
            }
        }
    }
}

/// Deepest ignore file first; the first rule that says ignore or whitelist decides.
fn ignored(rules: &[Gitignore], path: &Path, is_dir: bool) -> bool {
    for g in rules.iter().rev() {
        let m = g.matched(path, is_dir);
        if m.is_ignore() {
            return true;
        }
        if m.is_whitelist() {
            return false;
        }
    }
    false
}
