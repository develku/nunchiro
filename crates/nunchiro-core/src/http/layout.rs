//! `layout.toml` (spec Window (v1a), Layout edit; needs 37): validated, written and watched here. The layout
//! actions themselves live in the window (web/src/layout/), so `nunchiro layout ...` is forwarded to a
//! connected window, which applies it exactly as its edit command line would and saves the result.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use toml::Spanned;

use super::WIDGET_KINDS; // v1b-28

pub(crate) const FILE: &str = "layout.toml";
const VERSION: i64 = 1;
const MAX_DEPTH: usize = 12;
const MAX_ZONES: usize = 64;
const MAX_CHILDREN: usize = 16;
const MAX_TABS: usize = 16;
const MAX_ARGS: usize = 32;
const HISTORY: usize = 3;
const ANSWER_WITHIN: Duration = Duration::from_secs(5);
fn header() -> String {
    format!(
        "# Nunchiro layout: written by the window and `nunchiro layout`, editable by hand.\n\
# Widgets: {}; \"kind@session\" pins one to a session.\n\
# size = pixels along the parent split (absent: share the rest). The window rewrites this file on each change.\n\n",
        WIDGET_KINDS.join(", ")
    )
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Layout {
    version: i64,
    /// The Lock switch is gone (ticket 1031): an older file's or window's `locked` is read and dropped, never written.
    #[serde(default, skip_serializing, rename = "locked")]
    _locked: serde::de::IgnoredAny,
    root: Node,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    split: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    widgets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Node>>,
}

// The same shape with source spans, so an error names the line it is on.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpannedLayout {
    version: Spanned<i64>,
    #[serde(default, rename = "locked")]
    _locked: serde::de::IgnoredAny,
    root: Spanned<SpannedNode>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpannedNode {
    id: Spanned<String>,
    size: Option<Spanned<u32>>,
    split: Option<Spanned<String>>,
    widgets: Option<Spanned<Vec<Spanned<String>>>>,
    active: Option<Spanned<u32>>,
    children: Option<Spanned<Vec<Spanned<SpannedNode>>>>,
}

/// Parses and checks a layout file; errors read `layout.toml line N: why`.
pub(crate) fn parse(text: &str) -> Result<Layout, String> {
    let error = |at: usize, why: &str| {
        let line = text.as_bytes()[..at.min(text.len())]
            .iter()
            .filter(|b| **b == b'\n')
            .count()
            + 1;
        format!("{FILE} line {line}: {why}")
    };
    let de = |e: toml::de::Error| error(e.span().map_or(0, |s| s.start), e.message());
    // The version comes first, so a newer file is named as newer, not as unknown fields.
    #[derive(Deserialize)]
    struct Head {
        version: Option<Spanned<toml::Value>>,
    }
    let head: Head = toml::from_str(text).map_err(de)?;
    if let Some(v) = head.version
        && let Some(n) = v.get_ref().as_integer()
        && n > VERSION
    {
        return Err(error(
            v.span().start,
            &format!("version {n} is newer than this Nunchiro reads ({VERSION})"),
        ));
    }
    let doc: SpannedLayout = toml::from_str(text).map_err(de)?;
    if *doc.version.get_ref() != VERSION {
        return Err(error(
            doc.version.span().start,
            "unsupported layout version",
        ));
    }
    let mut ids = Vec::new();
    // No "at least one of tree, agents, waiting" rule (needs 26, 31): the Tree is required and always in the window, and
    // shows waiting (D5b, needs 31 allows a signal-only panel); coordinator decision 2026-11-02, A22 / needs 107.
    let root = check(doc.root, 0, &mut ids, &error)?;
    Ok(Layout {
        version: VERSION,
        _locked: serde::de::IgnoredAny,
        root,
    })
}

fn check(
    node: Spanned<SpannedNode>,
    depth: usize,
    ids: &mut Vec<String>,
    error: &dyn Fn(usize, &str) -> String,
) -> Result<Node, String> {
    let at = node.span().start;
    let n = node.into_inner();
    if depth > MAX_DEPTH {
        return Err(error(at, "zones nest too deep"));
    }
    let id = n.id.get_ref();
    if !crate::store::valid_id(id) || ids.contains(id) || ids.len() >= MAX_ZONES {
        return Err(error(
            n.id.span().start,
            "zone id must be unique letters, digits or '-' (at most 64 zones)",
        ));
    }
    ids.push(id.clone());
    if let Some(size) = &n.size
        && !(1..=10_000).contains(size.get_ref())
    {
        return Err(error(size.span().start, "size must be 1 to 10000 px"));
    }
    let (split, children, widgets) = match (n.split, n.children, n.widgets) {
        (Some(split), Some(children), None) => {
            if !["row", "column"].contains(&split.get_ref().as_str()) {
                return Err(error(
                    split.span().start,
                    "split must be \"row\" or \"column\"",
                ));
            }
            if !(2..=MAX_CHILDREN).contains(&children.get_ref().len()) {
                return Err(error(children.span().start, "a split needs 2 to 16 zones"));
            }
            let kids = children
                .into_inner()
                .into_iter()
                .map(|c| check(c, depth + 1, ids, error))
                .collect::<Result<Vec<_>, _>>()?;
            (Some(split.into_inner()), Some(kids), None)
        }
        (None, None, Some(widgets)) => {
            if !(1..=MAX_TABS).contains(&widgets.get_ref().len()) {
                return Err(error(widgets.span().start, "a zone holds 1 to 16 widgets"));
            }
            if let Some(active) = &n.active
                && *active.get_ref() as usize >= widgets.get_ref().len()
            {
                return Err(error(active.span().start, "active is past the last widget"));
            }
            let mut out = Vec::new();
            for w in widgets.into_inner() {
                let (kind, pin) = w.get_ref().split_once('@').unwrap_or((w.get_ref(), ""));
                let pinned = w.get_ref().contains('@');
                // v1b-19: `widget:<name>` names a user widget by syntax only, so a missing one still loads.
                let user = kind
                    .strip_prefix("widget:")
                    .is_some_and(crate::approval::valid_name);
                // Ticket 1070: the Agents widget is retired; an old file that names it still loads (the window drops it).
                if !WIDGET_KINDS.contains(&kind) && kind != "agents" && !user {
                    return Err(error(
                        w.span().start,
                        &format!(
                            "unknown widget \"{kind}\"; widgets: {}",
                            WIDGET_KINDS.join(", ")
                        ),
                    ));
                }
                if pinned
                    && (pin.trim().is_empty()
                        || pin.len() > 128
                        || pin.chars().any(char::is_control))
                {
                    return Err(error(
                        w.span().start,
                        "pin must name a session (1 to 128 bytes)",
                    ));
                }
                out.push(w.into_inner());
            }
            (None, None, Some(out))
        }
        _ => {
            return Err(error(
                at,
                "a zone has either split and children, or widgets",
            ));
        }
    };
    Ok(Node {
        id: n.id.into_inner(),
        size: n.size.map(Spanned::into_inner),
        split,
        widgets,
        active: n.active.map(Spanned::into_inner).filter(|a| *a > 0),
        children,
    })
}

/// The file as the window sees it: `layout` is null when there is no file (the default applies) or when it is
/// invalid (the window keeps its last good layout and shows `error`).
pub(crate) fn event(home: &Path) -> serde_json::Value {
    let (layout, error) = match std::fs::read_to_string(home.join(FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, None),
        Err(e) => (None, Some(format!("{FILE}: {e}"))),
        Ok(text) => match parse(&text) {
            Ok(layout) => (serde_json::to_value(layout).ok(), None),
            Err(e) => (None, Some(e)),
        },
    };
    serde_json::json!({ "event": "layout", "layout": layout, "error": error })
}

/// What a window compares for change detection: the core's write generation and the bytes (None: no file). The
/// generation catches writes that end with the same bytes between two polls (save, then CLI undo); the bytes catch
/// hand edits.
pub(crate) type Stamp = (u64, Option<Vec<u8>>);
pub(crate) fn stamp(home: &Path) -> Stamp {
    (
        with(home, |b| b.generation),
        std::fs::read(home.join(FILE)).ok(),
    )
}

/// The file's text, `None` when there is none. Any other read error (not text, unreadable) keeps it untouched, as a
/// parse error does: only a missing file may be written fresh.
fn current(home: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(home.join(FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "{FILE}: {e} (kept untouched: fix or remove it to save layout changes)"
        )),
    }
}

/// Serialises read-check-write of the file between window saves and CLI undo (one core process per home).
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// Writes the window's layout. A file that does not parse (hand edit, newer version) is never overwritten.
/// Returns the stamp of this write, so the saving window's watch does not echo its own change back to it.
pub(crate) fn save(home: &Path, layout: serde_json::Value) -> Result<Stamp, String> {
    let _file = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = current(home)?;
    if let Some(Err(e)) = current.as_deref().map(parse) {
        return Err(format!(
            "{e} (kept untouched: fix or remove it to save layout changes)"
        ));
    }
    let layout: Layout = serde_json::from_value(layout).map_err(|e| format!("layout: {e}"))?;
    let text = format!(
        "{}{}",
        header(),
        toml::to_string(&layout).map_err(|e| e.to_string())?
    );
    parse(&text)?;
    remember(home, current.as_deref(), &text);
    let bytes = text.clone().into_bytes();
    write(home, text)?;
    Ok((with(home, |b| b.generation), Some(bytes)))
}

/// CLI commands waiting for a window, and the file's undo steps, per core home (tests run several cores in one
/// process).
#[derive(Default)]
struct Bus {
    /// Connected windows in connect order; `focused` is the last one the user worked in.
    windows: Vec<u64>,
    focused: Option<u64>,
    next_window: u64,
    next: u64,
    queue: VecDeque<(u64, Vec<String>)>,
    done: BTreeMap<u64, Result<String, String>>,
    /// Earlier file texts for `nunchiro layout undo`, newest last (None: no file, the default layout); valid while
    /// the file is what the core last wrote.
    history: Vec<Option<String>>,
    written: Option<String>,
    /// Bumped on every write or removal the core makes.
    generation: u64,
}
static BUS: Mutex<BTreeMap<PathBuf, Bus>> = Mutex::new(BTreeMap::new());

fn with<T>(home: &Path, f: impl FnOnce(&mut Bus) -> T) -> T {
    let mut all = BUS.lock().unwrap_or_else(|e| e.into_inner());
    f(all.entry(home.to_path_buf()).or_default())
}

impl Bus {
    /// The one window CLI commands go to: the focused one, else the most recently connected.
    fn target(&self) -> Option<u64> {
        self.focused
            .filter(|f| self.windows.contains(f))
            .or(self.windows.last().copied())
    }
}

/// A connected window, counted for as long as it lives.
pub(crate) struct Window(PathBuf, u64);
impl Window {
    pub(crate) fn open(home: &Path) -> Self {
        let id = with(home, |b| {
            b.next_window += 1;
            b.windows.push(b.next_window);
            b.next_window
        });
        Window(home.to_path_buf(), id)
    }
    /// The user is working in this window: CLI layout commands go here from now on.
    pub(crate) fn focus(&self) {
        with(&self.0, |b| b.focused = Some(self.1));
    }
    /// The next CLI command for this window to run, if it is the target and one waits.
    pub(crate) fn next_command(&self) -> Option<(u64, Vec<String>)> {
        with(&self.0, |b| {
            if b.target() == Some(self.1) {
                b.queue.pop_front()
            } else {
                None
            }
        })
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        with(&self.0, |b| b.windows.retain(|w| *w != self.1));
    }
}

pub(crate) fn done(home: &Path, seq: u64, result: Result<String, String>) {
    with(home, |b| {
        if seq < b.next {
            b.done.insert(seq, result);
        }
    });
}

/// True when two layout texts name the same arrangement (a rewrite that changes nothing is not an undo step).
fn same_arrangement(a: &str, b: &str) -> bool {
    match (parse(a), parse(b)) {
        (Ok(a), Ok(b)) => serde_json::to_value(a).ok() == serde_json::to_value(b).ok(),
        _ => false,
    }
}

/// Records `current` (the file before a write) as an undo step. A file changed outside Nunchiro since the core
/// last wrote it starts the history over, so an undo never silently drops a hand edit.
fn remember(home: &Path, current: Option<&str>, next: &str) {
    with(home, |b| {
        if b.written.as_deref() != current {
            b.history.clear();
        }
        if current.is_none_or(|cur| !same_arrangement(cur, next)) {
            b.history.push(current.map(str::to_string));
            let extra = b.history.len().saturating_sub(HISTORY);
            b.history.drain(..extra);
        }
    });
}

fn write(home: &Path, text: String) -> Result<(), String> {
    let result = crate::store::atomic_write(&home.join(FILE), text.as_bytes());
    with(home, |b| {
        b.generation += 1;
        if result.is_ok() {
            b.written = Some(text);
        }
    });
    result
}

/// `nunchiro layout undo`: the file's previous arrangement, independent of any window.
fn undo(home: &Path) -> Result<String, String> {
    let _file = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = current(home)?;
    if let Some(text) = &current {
        parse(text).map_err(|e| format!("{e} (kept untouched)"))?;
    }
    let prev = with(home, |b| {
        if b.written.as_deref() != current.as_deref() {
            b.history.clear();
        }
        b.history.pop()
    })
    .ok_or(format!("nothing to undo (up to {HISTORY} steps)"))?;
    let Some(prev) = prev else {
        // Back to no file: the default layout.
        let removed = std::fs::remove_file(home.join(FILE)).map_err(|e| e.to_string());
        with(home, |b| {
            b.generation += 1;
            if removed.is_ok() {
                b.written = None;
            }
        });
        removed?;
        return Ok("undo".into());
    };
    let layout = parse(&prev)?;
    write(
        home,
        format!(
            "{}{}",
            header(),
            toml::to_string(&layout).map_err(|e| e.to_string())?
        ),
    )?;
    Ok("undo".into())
}

/// `nunchiro layout ...`: `undo` steps back the file itself; anything else goes to the target window, which runs
/// it as its command line would, saves, then answers.
pub fn forward(home: &Path, args: Vec<String>) -> Result<String, String> {
    if args.is_empty() || args.len() > MAX_ARGS || args.iter().any(|a| a.len() > 256) {
        return Err(
            "expected a layout command (at most 32 words); see `nunchiro layout --help`".into(),
        );
    }
    if args == ["undo"] {
        return undo(home);
    }
    let seq = with(home, |b| {
        if b.windows.is_empty() {
            return Err(format!(
                "no Nunchiro window is open: open it, or edit {} by hand",
                home.join(FILE).display()
            ));
        }
        b.next += 1;
        b.queue.push_back((b.next - 1, args));
        Ok(b.next - 1)
    })?;
    crate::pty::wake_windows(); // S9: the target window takes it now, not at its next timed check
    let until = Instant::now() + ANSWER_WITHIN;
    while Instant::now() < until {
        if let Some(result) = with(home, |b| b.done.remove(&seq)) {
            return result;
        }
        thread::sleep(Duration::from_millis(10));
    }
    with(home, |b| b.queue.retain(|(s, _)| *s != seq));
    Err("the window did not answer the layout command".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // An older file: it still has the `locked` line the Lock switch wrote (ticket 1031), which is read and dropped.
    const DEFAULT: &str = r#"version = 1
locked = false

[root]
id = "main"
split = "row"

[[root.children]]
id = "left"
size = 256
split = "column"

[[root.children.children]]
id = "tree"
widgets = ["tree"]

[[root.children.children]]
id = "agents"
size = 190
widgets = ["agents"]

[[root.children]]
id = "centre"
split = "column"

[[root.children.children]]
id = "terminal"
widgets = ["terminal", "terminal@리뷰-03"]
active = 1

[[root.children.children]]
id = "waiting"
widgets = ["waiting"]

[[root.children.children]]
id = "composer"
widgets = ["composer"]
"#;

    #[test]
    fn an_old_locked_line_is_read_and_never_written_back() {
        // Ticket 1031: the Lock switch is gone; a file that still says `locked = true` loads as any other.
        let old = parse(&DEFAULT.replace("locked = false", "locked = true")).unwrap();
        let text = toml::to_string(&old).unwrap();
        assert_eq!(text, DEFAULT.replace("locked = false\n", ""));
        assert!(parse(&text).is_ok(), "a file without the line loads too");
    }

    #[test]
    fn round_trip_keeps_shape_and_order() {
        let now = DEFAULT.replace("locked = false\n", "");
        let layout = parse(&now).unwrap();
        assert_eq!(toml::to_string(&layout).unwrap(), now);
    }

    // v1b-19
    #[test]
    fn widgets_layout_names_missing_user_widget() {
        let with = DEFAULT.replace(
            "widgets = [\"agents\"]",
            "widgets = [\"agents\", \"widget:not-there\", \"widget:pr@리뷰-03\"]",
        );
        let layout = parse(&with).unwrap();
        assert!(
            toml::to_string(&layout)
                .unwrap()
                .contains("widget:not-there")
        );
        for bad in ["widget:", "widget:Bad", "widget:../x", "widgets:x"] {
            let text = DEFAULT.replace("widgets = [\"agents\"]", &format!("widgets = [\"{bad}\"]"));
            assert!(
                parse(&text).err().unwrap().contains("unknown widget"),
                "{bad}"
            );
        }
    }

    // v1b-28: pinned before the kinds moved to one shared list; the text must stay byte-equal.
    #[test]
    fn layout_toml_unknown_widget_message_is_unchanged() {
        let bad = DEFAULT.replace("widgets = [\"agents\"]", "widgets = [\"ask\"]");
        assert_eq!(
            parse(&bad).err().unwrap(),
            "layout.toml line 20: unknown widget \"ask\"; widgets: tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context"
        );
        assert_eq!(
            header(),
            "# Nunchiro layout: written by the window and `nunchiro layout`, editable by hand.\n\
# Widgets: tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context; \"kind@session\" pins one to a session.\n\
# size = pixels along the parent split (absent: share the rest). The window rewrites this file on each change.\n\n"
        );
    }

    // v1b-28: the gate's drift check (web/tests/registry.spec.ts has the same one for the window). It reads each
    // entry's single-quoted kind in registry.tsx (text after "kind", colon, quote).
    #[test]
    fn web_registry_and_rust_list_name_the_same_kinds() {
        let registry = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/layout/registry.tsx"),
        )
        .unwrap();
        let web: Vec<&str> = registry
            .split("kind: '")
            .skip(1)
            .map(|rest| rest.split('\'').next().unwrap())
            .collect();
        assert_eq!(web, WIDGET_KINDS);
    }

    #[test]
    fn errors_name_the_line() {
        let bad = DEFAULT.replace("widgets = [\"agents\"]", "widgets = [\"chat\"]");
        assert_eq!(
            parse(&bad).err().unwrap(),
            "layout.toml line 20: unknown widget \"chat\"; widgets: tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context"
        );
        let syntax = DEFAULT.replace("size = 190", "size = ");
        assert!(
            parse(&syntax)
                .err()
                .unwrap()
                .starts_with("layout.toml line 19:")
        );
        let unknown = DEFAULT.replace("size = 190", "colour = 1");
        assert!(
            parse(&unknown)
                .err()
                .unwrap()
                .starts_with("layout.toml line 19:")
        );
        let dup = DEFAULT.replace("id = \"agents\"", "id = \"tree\"");
        assert!(
            parse(&dup)
                .err()
                .unwrap()
                .starts_with("layout.toml line 18:")
        );
        let both = DEFAULT.replace("id = \"left\"", "id = \"left\"\nwidgets = [\"tree\"]");
        assert!(
            parse(&both)
                .err()
                .unwrap()
                .contains("either split and children, or widgets")
        );
        let past = DEFAULT.replace("active = 1", "active = 2");
        assert!(parse(&past).err().unwrap().contains("past the last widget"));
    }

    #[test]
    fn newer_version_is_named_as_newer() {
        let newer = DEFAULT.replace("version = 1", "version = 2\nfloating = true");
        assert_eq!(
            parse(&newer).err().unwrap(),
            "layout.toml line 1: version 2 is newer than this Nunchiro reads (1)"
        );
    }

    #[test]
    fn a_layout_without_waiting_zone_is_accepted() {
        // The Tree always shows waiting (D5b, needs 31), so a layout with no tree, agents or waiting zone is valid
        // (coordinator decision 2026-11-02, A22 / needs 107).
        let none = DEFAULT
            .replace("widgets = [\"tree\"]", "widgets = [\"terminal\"]")
            .replace("widgets = [\"agents\"]", "widgets = [\"composer\"]")
            .replace("widgets = [\"waiting\"]", "widgets = [\"terminal\"]");
        assert!(parse(&none).is_ok());
    }

    #[test]
    fn save_writes_valid_files_and_never_overwrites_a_broken_one() {
        let home = std::env::temp_dir().join(format!("nunchiro-layout-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let value = serde_json::to_value(parse(DEFAULT).unwrap()).unwrap();
        save(&home, value.clone()).unwrap();
        let written = std::fs::read_to_string(home.join(FILE)).unwrap();
        assert!(written.starts_with("# Nunchiro layout"));
        assert_eq!(event(&home)["layout"], value);
        let mut bad = value.clone();
        bad["root"]["children"][0]["children"][0]["widgets"] = serde_json::json!(["chat"]);
        assert!(save(&home, bad).is_err());
        assert_eq!(std::fs::read_to_string(home.join(FILE)).unwrap(), written);
        std::fs::write(home.join(FILE), "version = 2\n").unwrap();
        let err = save(&home, value).err().unwrap();
        assert!(err.contains("newer") && err.contains("kept untouched"));
        assert_eq!(
            std::fs::read_to_string(home.join(FILE)).unwrap(),
            "version = 2\n"
        );
        assert_eq!(event(&home)["layout"], serde_json::Value::Null);
        std::fs::remove_dir_all(&home).unwrap();
    }

    // Quality audit 1101 D3: a file that cannot be read as text (a hand edit in another encoding) is not "no file".
    #[test]
    fn save_and_undo_never_overwrite_an_unreadable_file() {
        let home = temp_home("layout-unreadable");
        let value = serde_json::to_value(parse(DEFAULT).unwrap()).unwrap();
        save(&home, value.clone()).unwrap();
        save(&home, value.clone()).unwrap();
        let hand = b"version = 1\n# caf\xe9 in Latin-1\n".to_vec();
        std::fs::write(home.join(FILE), &hand).unwrap();
        let err = save(&home, value).err().unwrap();
        assert!(err.contains("kept untouched"), "{err}");
        assert!(undo(&home).is_err());
        assert_eq!(std::fs::read(home.join(FILE)).unwrap(), hand);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn save_then_undo_within_one_poll_interval_emits_an_event() {
        let home = temp_home("layout-generation");
        // A window's loop takes a stamp, then compares it at its next poll.
        let before = stamp(&home);
        save(
            &home,
            serde_json::to_value(parse(DEFAULT).unwrap()).unwrap(),
        )
        .unwrap();
        forward(&home, vec!["undo".into()]).unwrap();
        // Same bytes as before (no file), but two writes happened: the window must hear about it.
        assert!(!home.join(FILE).exists());
        assert_ne!(stamp(&home), before);
        let after = stamp(&home);
        assert_eq!(stamp(&home), after, "no write, no event");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn version_error_names_the_line_of_the_key() {
        let newer = "# version notes: see docs\nlocked = false\nversion = 2\n";
        assert_eq!(
            parse(newer).err().unwrap(),
            "layout.toml line 3: version 2 is newer than this Nunchiro reads (1)"
        );
    }

    fn temp_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("nunchiro-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    /// Every window's loop polls at once, as real windows do; the reply names the window that ran it.
    fn route(home: &Path, windows: &[(&Window, &str)], args: &str) -> String {
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            for (window, name) in windows {
                let stop = &stop;
                scope.spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Some((seq, words)) = window.next_command() {
                            done(&window.0, seq, Ok(format!("{name}: {}", words.join(" "))));
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                });
            }
            let out = forward(home, vec![args.into()]).unwrap();
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            out
        })
    }

    #[test]
    fn forward_goes_to_one_window_the_focused_else_the_newest() {
        let home = PathBuf::from("/nonexistent/forward-route");
        assert!(
            forward(&home, vec!["reset".into()])
                .unwrap_err()
                .contains("no Nunchiro window")
        );
        let a = Window::open(&home);
        let b = Window::open(&home);
        for _ in 0..20 {
            assert_eq!(route(&home, &[(&a, "a"), (&b, "b")], "reset"), "b: reset");
        }
        a.focus();
        for _ in 0..20 {
            assert_eq!(route(&home, &[(&a, "a"), (&b, "b")], "add"), "a: add");
        }
        // The focused window closes: the newest remaining one is the target again.
        drop(a);
        assert_eq!(route(&home, &[(&b, "b")], "reset"), "b: reset");
        drop(b);
        assert!(forward(&home, vec!["reset".into()]).is_err());
    }

    #[test]
    fn cli_undo_steps_back_the_file_and_never_over_a_hand_edit() {
        let home = temp_home("layout-undo");
        let base = parse(DEFAULT).unwrap();
        let step = |id: &str| {
            let mut v = serde_json::to_value(parse(DEFAULT).unwrap()).unwrap();
            v["root"]["children"][0]["id"] = serde_json::json!(id);
            v
        };
        assert_eq!(
            forward(&home, vec!["undo".into()]).unwrap_err(),
            "nothing to undo (up to 3 steps)"
        );
        // The first change can be undone back to no file (the default layout).
        save(
            &home,
            serde_json::to_value(parse(DEFAULT).unwrap()).unwrap(),
        )
        .unwrap();
        forward(&home, vec!["undo".into()]).unwrap();
        assert!(!home.join(FILE).exists());
        save(&home, serde_json::to_value(base).unwrap()).unwrap();
        let first = std::fs::read_to_string(home.join(FILE)).unwrap();
        for id in ["s1", "s2", "s3", "s4"] {
            save(&home, step(id)).unwrap();
        }
        // An older window still sends `locked`: accepted, and the same arrangement again is not a step.
        let mut again = step("s4");
        again["locked"] = serde_json::json!(true);
        save(&home, again).unwrap();
        for back in ["s3", "s2", "s1"] {
            assert_eq!(forward(&home, vec!["undo".into()]).unwrap(), "undo");
            let now = parse(&std::fs::read_to_string(home.join(FILE)).unwrap()).unwrap();
            assert_eq!(now.root.children.as_ref().unwrap()[0].id, back);
        }
        assert!(forward(&home, vec!["undo".into()]).is_err(), "only 3 steps");
        assert_ne!(std::fs::read_to_string(home.join(FILE)).unwrap(), first);
        // A hand edit ends the history: undo refuses instead of dropping it.
        save(&home, step("s5")).unwrap();
        let hand = std::fs::read_to_string(home.join(FILE))
            .unwrap()
            .replace("size = 256", "size = 300");
        std::fs::write(home.join(FILE), &hand).unwrap();
        assert!(
            forward(&home, vec!["undo".into()])
                .unwrap_err()
                .contains("nothing to undo")
        );
        assert_eq!(std::fs::read_to_string(home.join(FILE)).unwrap(), hand);
        // The next change keeps the hand edit as its undo step.
        save(&home, step("s6")).unwrap();
        forward(&home, vec!["undo".into()]).unwrap();
        assert!(
            std::fs::read_to_string(home.join(FILE))
                .unwrap()
                .contains("size = 300")
        );
        // Nothing from before the hand edit comes back.
        assert!(
            forward(&home, vec!["undo".into()])
                .unwrap_err()
                .contains("nothing to undo")
        );
        // Same when the window saves right after a hand edit, with no undo in between.
        save(&home, step("s7")).unwrap();
        let hand = std::fs::read_to_string(home.join(FILE))
            .unwrap()
            .replace("size = 190", "size = 200");
        std::fs::write(home.join(FILE), &hand).unwrap();
        save(&home, step("s8")).unwrap();
        forward(&home, vec!["undo".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(FILE)).unwrap(), hand);
        assert!(
            forward(&home, vec!["undo".into()])
                .unwrap_err()
                .contains("nothing to undo")
        );
        std::fs::remove_dir_all(&home).unwrap();
    }
}
