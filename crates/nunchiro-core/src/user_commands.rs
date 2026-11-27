//! Ticket 98: the composer `/` menu's user-level commands and skills, listed from `<home>/.claude/commands`,
//! `<home>/.claude/skills` and `<home>/.codex/prompts`. Read only: the module calls `read_dir`, `symlink_metadata` and
//! an `O_NOFOLLOW | O_NONBLOCK` read-only open, and nothing else touches the filesystem. A link, a FIFO or any
//! non-regular entry is skipped, never followed; a missing or unreadable path gives fewer rows, never an error.
//! Ticket 371: also the user's enabled Claude plugins, found through `installed_plugins.json` and `settings.json`.
//! Which installs count and how a skill is named follow Orca `claude-plugin-skill-sources.ts` and T3 Code
//! `ClaudeSkills.ts` (behaviour only, no code copied). A plugin root must lie in `<home>/.claude/plugins`; one
//! `canonicalize` confirms that, the only call here that resolves links, and nothing is read through its result.
use crate::api::{AgentKind, Reply, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "UserCommandsRow"))]
pub struct Row {
    pub name: String,
    pub description: String,
    /// `command`, `skill` or `prompt`.
    pub source: String,
}

const MAX_DEPTH: usize = 4; // path components below `commands`
const MAX_ENTRIES: usize = 200; // examined per directory
const MAX_ROWS: usize = 300;
// Directories the `commands` walk may open in total: a tree of empty folders (up to 200 per level, 4 levels) cannot cost
// more than this many `read_dir` calls; a normal tree has a few dozen.
const MAX_VISITS: usize = 500;
const MAX_FILE: u64 = 64 << 10;
const MAX_READ: u64 = 8 << 10;
const MAX_DESCRIPTION: usize = 120;
const MAX_PLUGIN_INDEX: u64 = 4 << 20; // installed_plugins.json and settings.json, each

/// The window's reply: the rows for `kind` under the user's `$HOME`; no `$HOME` gives none.
pub fn reply(kind: AgentKind) -> Response {
    let rows = std::env::var_os("HOME")
        .map(|home| list(Path::new(&home), kind))
        .unwrap_or_default();
    Ok(Reply::UserCommands { rows })
}

/// Rows for `kind`, sorted by name; at most `MAX_ROWS`.
pub fn list(home: &Path, kind: AgentKind) -> Vec<Row> {
    let mut rows = Vec::new();
    match kind {
        AgentKind::Claude => {
            walk(&home.join(".claude/commands"), "", 1, &mut 0, &mut rows);
            skills(&home.join(".claude/skills"), "", &mut rows);
            // Last, so a plugin's rows can never push out the user's own at `MAX_ROWS`.
            plugins(home, &mut rows);
        }
        AgentKind::Codex => prompts(&home.join(".codex/prompts"), &mut rows),
        AgentKind::Shell | AgentKind::Acp => {}
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

/// The directory's first `MAX_ENTRIES` entries by name, each with its type read without following a link.
fn entries(dir: &Path) -> Vec<(String, PathBuf, fs::Metadata)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = read
        .flatten()
        .take(MAX_ENTRIES)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let meta = fs::symlink_metadata(e.path()).ok()?;
            Some((name, e.path(), meta))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// `commands/**/*.md`; `prefix` is the namespace so far (`ns:`), `depth` the level of `dir`'s entries, `visits` the
/// directories opened so far; the walk stops at `MAX_VISITS` and keeps the rows found.
fn walk(dir: &Path, prefix: &str, depth: usize, visits: &mut usize, rows: &mut Vec<Row>) {
    if *visits >= MAX_VISITS {
        return;
    }
    *visits += 1;
    for (name, path, meta) in entries(dir) {
        if rows.len() >= MAX_ROWS || *visits >= MAX_VISITS {
            return;
        }
        if meta.is_dir() && depth < MAX_DEPTH {
            walk(&path, &format!("{prefix}{name}:"), depth + 1, visits, rows);
        } else if let (true, Some(stem)) = (meta.is_file(), name.strip_suffix(".md")) {
            push(rows, format!("{prefix}{stem}"), &path, "command");
        }
    }
}

/// `skills/<dir>/SKILL.md`; `prefix` is the plugin's namespace (`name:`), empty for the user's own.
fn skills(dir: &Path, prefix: &str, rows: &mut Vec<Row>) {
    for (name, path, meta) in entries(dir) {
        if rows.len() >= MAX_ROWS {
            return;
        }
        if meta.is_dir() {
            push(
                rows,
                format!("{prefix}{name}"),
                &path.join("SKILL.md"),
                "skill",
            );
        }
    }
}

/// A directory itself, not a link to one: `read_dir` would follow a link at the path it is given.
fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

/// A name that reads as one word in the menu: it comes from a plugin's own JSON.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `.claude-plugin/plugin.json`'s name, else the key before `@`; `None` when neither is a plain name.
fn plugin_name(root: &Path, key: &str) -> Option<String> {
    let dir = root.join(".claude-plugin");
    let own = real_dir(&dir)
        .then(|| json(&dir.join("plugin.json"), MAX_FILE))
        .flatten();
    own.as_ref()
        .and_then(|doc| doc["name"].as_str())
        .filter(|n| plain_name(n))
        .or_else(|| key.split('@').next().filter(|n| plain_name(n)))
        .map(String::from)
}

/// `path` with every link resolved; `None` when it cannot be.
fn resolved(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

/// Whether `root` lies in the plugin folder, as written (`base`) and once links are resolved (`real_base`).
fn in_plugin_folder(root: &Path, base: &Path, real_base: &Path) -> bool {
    root.starts_with(base)
        && !root.components().any(|c| c == Component::ParentDir)
        && resolved(root).is_some_and(|real| real.starts_with(real_base))
}

/// `commands/**/*.md` and `skills/*` of each enabled plugin installed at user scope. A project-scope install is left
/// out: `reply` has no session folder to match it against. `installPath` comes from a file, so a root outside
/// `<home>/.claude/plugins`, or a root or a `commands` or `skills` that is a link, is refused, and one visit budget
/// covers every plugin.
fn plugins(home: &Path, rows: &mut Vec<Row>) {
    let (Some(index), Some(settings)) = (
        json(
            &home.join(".claude/plugins/installed_plugins.json"),
            MAX_PLUGIN_INDEX,
        ),
        json(&home.join(".claude/settings.json"), MAX_PLUGIN_INDEX),
    ) else {
        return;
    };
    let (Some(installed), Some(enabled)) = (
        index["plugins"].as_object(),
        settings["enabledPlugins"].as_object(),
    ) else {
        return;
    };
    let base = home.join(".claude/plugins");
    let Some(real_base) = resolved(&base) else {
        return;
    };
    let mut visits = 0;
    for (key, installs) in installed {
        if rows.len() >= MAX_ROWS || visits >= MAX_VISITS {
            return;
        }
        if enabled.get(key) != Some(&Value::Bool(true)) {
            continue;
        }
        let root = installs.as_array().and_then(|list| {
            list.iter()
                .filter(|i| i["scope"] == "user")
                .find_map(|i| i["installPath"].as_str())
        });
        let Some(root) = root.map(Path::new).filter(|p| p.is_absolute()) else {
            continue;
        };
        visits += 1;
        if !in_plugin_folder(root, &base, &real_base) || !real_dir(root) {
            continue;
        }
        let Some(name) = plugin_name(root, key) else {
            continue;
        };
        let prefix = format!("{name}:");
        let commands = root.join("commands");
        if real_dir(&commands) {
            walk(&commands, &prefix, 1, &mut visits, rows);
        }
        let dir = root.join("skills");
        if real_dir(&dir) {
            skills(&dir, &prefix, rows);
        }
    }
}

/// `prompts/*.md`, not nested.
fn prompts(dir: &Path, rows: &mut Vec<Row>) {
    for (name, path, meta) in entries(dir) {
        if rows.len() >= MAX_ROWS {
            return;
        }
        if let (true, Some(stem)) = (meta.is_file(), name.strip_suffix(".md")) {
            push(rows, stem.to_string(), &path, "prompt");
        }
    }
}

fn push(rows: &mut Vec<Row>, name: String, file: &Path, source: &'static str) {
    if let Some(description) = describe(file) {
        rows.push(Row {
            name,
            description,
            source: source.into(),
        });
    }
}

/// `path` opened for reading if it is a regular file of at most `max` bytes.
fn open_regular(path: &Path, max: u64) -> Option<fs::File> {
    // The open does not follow a link and cannot block on a FIFO swapped in after the listing; the type is checked on
    // the opened handle. A hard link is a regular file, so it is read like any other: its first line shows, by design.
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    (meta.is_file() && meta.len() <= max).then_some(file)
}

/// The JSON document in a regular file of at most `max` bytes (the read is capped too: the file can grow after the check).
fn json(path: &Path, max: u64) -> Option<Value> {
    let mut buf = Vec::new();
    open_regular(path, max)?
        .take(max)
        .read_to_end(&mut buf)
        .ok()?;
    serde_json::from_slice(&buf).ok()
}

/// The description of a regular file of at most `MAX_FILE` bytes, from its first `MAX_READ` bytes; `None` skips the row.
fn describe(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    open_regular(path, MAX_FILE)?
        .take(MAX_READ)
        .read_to_end(&mut buf)
        .ok()?;
    Some(description(&String::from_utf8_lossy(&buf)))
}

/// The front matter's `description:` value, else the first non-empty body line, cut to `MAX_DESCRIPTION` characters.
fn description(text: &str) -> String {
    let mut lines = text.lines();
    let mut body = Vec::new();
    let mut described = None;
    if text.starts_with("---") && lines.next().is_some_and(|l| l.trim_end() == "---") {
        let mut front = Vec::new();
        for line in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
            front.push(line);
        }
        let mut it = front.iter();
        while let Some(line) = it.next() {
            if let Some(value) = line.strip_prefix("description:") {
                let value = value.trim();
                // A block scalar (`>`, `|`) keeps its text on the next lines.
                let value = if value.is_empty() || value.starts_with(['>', '|']) {
                    it.find(|l| !l.trim().is_empty()).map_or("", |l| l.trim())
                } else {
                    value
                };
                described = Some(value.trim_matches(['"', '\'']).trim().to_string());
                break;
            }
        }
    }
    body.extend(lines);
    let text = described
        .filter(|d| !d.is_empty())
        .or_else(|| {
            body.iter()
                .map(|l| l.trim())
                .find(|l| !l.is_empty())
                .map(String::from)
        })
        .unwrap_or_default();
    text.chars().take(MAX_DESCRIPTION).collect()
}
