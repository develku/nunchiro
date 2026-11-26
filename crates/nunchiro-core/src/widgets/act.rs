//! Script widget act (ticket v1b-20): a click on a row the window drew renders the approved `[act]` template from
//! the core's own cached run and sends it through the V1A-04 delivery path as `widget:<name>`. The window sends
//! only the row index and the run it saw; it never supplies text. Owner only, like `widget_run`: a session token is
//! refused by `grants::request_target`, which names no widget op.
use crate::{
    api::{AgentKind, Reply, Request, Response, Session, SessionState, StartSession},
    approval::{self, Level},
    sessions::Sessions,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, atomic::AtomicBool},
    time::{Duration, Instant},
};

pub const LEADING: &str =
    "act text may not start a line with /, ! or # (slash commands, bash mode, memory)";
pub const CHANGED: &str = "output changed; click the row again";
/// A second click on the same row of the same run inside this window returns the first send.
pub const AGAIN: Duration = Duration::from_secs(1);
/// v1b-21: the table's caps (`MAX_ROWS`, `MAX_COLUMNS` in web/src/widgets/output.ts; a test pins them equal).
pub const TABLE_ROWS: usize = 500;
pub const TABLE_COLUMNS: usize = 64;
/// v1b-21: running sessions one widget's `start` act may have in a project.
pub const START_LIMIT: usize = 3;
/// v1b-31: combining marks one character may carry; a longer stack can spell text that overflows and clips in a cell.
pub const MAX_MARKS: usize = 4;

/// v1b-21 r3: what no act text carries is everything `delivery::shown` does not allow, except newline, tab and the
/// joiners Hangul and emoji sequences need (ZWNJ, ZWJ, U+FE0E, U+FE0F), whose placement `check_visible` checks.
/// Subdivision flags (tag characters) are refused; accepted in review (round 3).
fn hidden(c: char) -> bool {
    !(crate::delivery::shown(c) || matches!(c, '\n' | '\t') || joiner(c))
}
fn joiner(c: char) -> bool {
    matches!(c, '\u{200C}' | '\u{200D}' | '\u{FE0E}' | '\u{FE0F}')
}
/// The rendered text (template and values) is sent only as the user saw it in the table and on the sheet.
pub fn check_visible(text: &str) -> Result<(), String> {
    if let Some(c) = text.chars().find(|c| hidden(*c)) {
        return Err(format!(
            "act text contains an invisible, bidi or control character (U+{:04X}); nothing sent",
            c as u32
        ));
    }
    // v1b-21 r2: the joiners `hidden` keeps cannot carry a hidden payload: each run directly follows a visible
    // character and is at most one variation selector then one ZWJ/ZWNJ (emoji + U+FE0F + U+200D).
    let mut after = 3; // 0 visible, 1 selector, 2 joiner, 3 start or whitespace
    let mut marks = 0; // v1b-31: marks since the last base; a joiner does not start a new base
    for c in text.chars() {
        if crate::delivery::mark(c) {
            marks += 1;
            if marks > MAX_MARKS {
                return Err(format!(
                    "act text stacks more than {MAX_MARKS} combining marks on one character; nothing sent"
                ));
            }
        } else if !joiner(c) {
            marks = 0;
        }
        after = match c {
            '\u{FE0E}' | '\u{FE0F}' if after == 0 => 1,
            '\u{200C}' | '\u{200D}' if after <= 1 => 2,
            c if joiner(c) => {
                return Err(
                    "act text has a joiner or variation selector run that follows no visible character; nothing sent"
                        .into(),
                );
            }
            c if c.is_whitespace() => 3,
            _ => 0,
        };
    }
    Ok(())
}

/// v1b-21: the act sends only from a row the table shows, in a table that hides no column: the window draws at most
/// TABLE_ROWS rows and TABLE_COLUMNS columns (object keys, plus `value` for any other item) and drops the rest.
pub fn check_shown(rows: &[serde_json::Value], row: usize) -> Result<(), String> {
    if row >= TABLE_ROWS {
        return Err(format!(
            "the table hides rows past {TABLE_ROWS}; act sends only rows it shows"
        ));
    }
    let mut columns = std::collections::BTreeSet::new();
    for item in rows.iter().take(TABLE_ROWS) {
        match item.as_object() {
            Some(o) => columns.extend(o.keys().map(String::as_str)),
            None => _ = columns.insert("value"),
        }
    }
    if columns.len() > TABLE_COLUMNS {
        return Err(format!(
            "the table hides columns past {TABLE_COLUMNS}; act needs output it shows whole"
        ));
    }
    Ok(())
}

/// The `{field}` names of a template. `{` and `}` have no other use; the characters `hidden` names are refused, so
/// the permission sheet shows the text in the order it is sent.
pub fn fields(template: &str) -> Result<Vec<&str>, String> {
    let bad = |why: &str| Err(format!("invalid [act] template: {why}"));
    if template.trim().is_empty() {
        return bad("empty");
    }
    // v1b-31: the sheet refuses what a send would (mark stacks, joiner runs), not only hidden characters.
    if template.chars().any(hidden) || check_visible(template).is_err() {
        return bad("control, bidi or invisible character, or a mark or joiner run");
    }
    let mut names = vec![];
    let mut rest = template;
    while let Some(i) = rest.find(['{', '}']) {
        if rest[i..].starts_with('}') {
            return bad("`}` without `{`");
        }
        let after = &rest[i + 1..];
        let end = after
            .find('}')
            .ok_or("invalid [act] template: `{` without `}`")?;
        let name = &after[..end];
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return bad("a placeholder is {field} with a-z, A-Z, 0-9, _ or -");
        }
        names.push(name);
        rest = &after[end + 1..];
    }
    Ok(names)
}

/// Fills each `{field}` from one output row: a string as is, a number or boolean as JSON prints it. A missing
/// field, null, an array or object, or a value holding a newline is refused.
pub fn render(template: &str, row: &serde_json::Value) -> Result<String, String> {
    fields(template)?;
    let row = row
        .as_object()
        .ok_or("act needs rows that are JSON objects")?;
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let end = rest[i..].find('}').unwrap() + i;
        let name = &rest[i + 1..end];
        let value = match row.get(name) {
            None => return Err(format!("this row has no field {name}")),
            Some(serde_json::Value::String(s)) => s.clone(),
            // v1b-21: only numbers JSON.stringify prints the same: safe integers, and decimals with no exponent.
            Some(serde_json::Value::Number(n)) => {
                let text = n.to_string();
                let safe = |i: u64| i < (1 << 53);
                let same = match (n.as_u64(), n.as_i64()) {
                    (Some(u), _) => safe(u),
                    (None, Some(i)) => safe(i.unsigned_abs()),
                    _ => !text.contains(['e', 'E']) && !text.ends_with(".0"),
                };
                if !same {
                    return Err(format!(
                        "field {name} is a number the table shows differently; print it as a string"
                    ));
                }
                text
            }
            Some(v @ serde_json::Value::Bool(_)) => v.to_string(),
            Some(_) => return Err(format!("field {name} is not a string, number or boolean")),
        };
        if value.contains(['\n', '\r']) {
            return Err(format!("field {name} contains a newline"));
        }
        out.push_str(&value);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// No line may start (after spaces and invisible format characters) with `/`, `!` or `#`, for every agent kind:
/// no `/model` or `/effort`, no bash mode, no memory write through a widget.
pub fn check_leading(text: &str) -> Result<(), String> {
    for line in text.split('\n') {
        let first = line
            .chars()
            .find(|c| !c.is_whitespace() && crate::delivery::shown(*c)); // v1b-21 r3
        if matches!(first, Some('/' | '!' | '#')) {
            return Err(LEADING.into());
        }
    }
    Ok(())
}

/// The one running session labelled `label` in `project`.
pub fn resolve(sessions: &[Session], project: &Path, label: &str) -> Result<String, String> {
    let found: Vec<&Session> = sessions
        .iter()
        .filter(|s| {
            s.machine.is_none()
                && s.state == SessionState::Running
                && s.project == project
                && s.label == label
        })
        .collect();
    match found.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(format!("no session named {label}")),
        many => Err(format!("{} sessions named {label}", many.len())),
    }
}

type Key = (PathBuf, String, PathBuf, usize, u64);
type Recent = Mutex<BTreeMap<Key, (Instant, String, crate::delivery::Send)>>;
/// Recent sends by (home, widget, project, row, run). Held across the send, so two clicks never race.
fn recent() -> &'static Recent {
    static RECENT: OnceLock<Recent> = OnceLock::new();
    RECENT.get_or_init(Default::default)
}

/// Owner-only dispatch for `widget_act` (server.rs and http/mod.rs, after their auth checks). `stopping` is the
/// socket server's flag (the window path has none, as for its `start`).
pub(crate) fn handle(
    home: &Path,
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    request: Request,
) -> Response {
    let Request::WidgetAct {
        name,
        session,
        row,
        ran_at_ms,
        text,
        target,
        hash,
        frame,
    } = request
    else {
        return Err("not a widget act".into());
    };
    // v1b-22: the web form carries the text the user confirmed; the row form never does.
    let (row, ran_at_ms) = match (row, ran_at_ms, text, target, hash) {
        (Some(row), Some(ran_at_ms), None, None, None) if frame.is_none() => (row, ran_at_ms),
        (None, None, Some(text), Some(target), Some(hash)) => {
            let form = WebForm {
                name,
                session,
                text,
                target,
                hash,
                frame,
            };
            return web_act(home, registry, stopping, form);
        }
        _ => {
            return Err(
                "widget_act takes row and ran_at_ms (script) or text, target and hash (web)".into(),
            );
        }
    };
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let (enabled, all) = {
        let mut sessions = lock()?;
        let Reply::Snapshot { sessions: all, .. } = sessions.handle(Request::Snapshot)? else {
            return Err("unexpected snapshot reply".into());
        };
        (sessions.script_widgets(), all)
    };
    if !enabled {
        return Err(super::OFF.into());
    }
    let proof = approval::check(home, &name).map_err(|e| format!("needs approval: {e}"))?;
    let act = match (&proof.manifest().act, proof.manifest().kind.as_str()) {
        (Some(act), "script") => act.clone(),
        _ => return Err(format!("{name} has no [act] in widget.toml")),
    };
    if proof.level() != Level::Act {
        return Err(format!(
            "act is not allowed for {name}: turn on act in its permission sheet"
        ));
    }
    let project = super::project(&all, session.as_deref())?
        .ok_or("act needs the placement's session for its project")?;
    let output =
        super::cached_output(home, &name, &project.dir, proof.hash(), ran_at_ms).ok_or(CHANGED)?;
    let super::Output::Json { text } = output else {
        return Err("act needs JSON array output".into());
    };
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|_| "act needs JSON array output")?;
    let item = rows.get(row).ok_or(CHANGED)?;
    check_shown(&rows, row)?; // v1b-21
    let text = render(&act.template, item)?;
    check_leading(&text)?;
    let (kind, target) = match (&act.session, act.start) {
        (Some(label), _) => {
            let id = resolve(&all, &project.dir, label)?;
            // A shell would run `$(...)` or `;` from a value once a newline submits the line.
            match all.iter().find(|s| s.id == id).map(|s| s.kind) {
                Some(kind @ (AgentKind::Claude | AgentKind::Codex)) => (kind, Some(id)),
                _ => {
                    return Err(format!(
                        "session {label} is a shell; act sends only to Claude or Codex sessions"
                    ));
                }
            }
        }
        (None, Some(kind)) => (kind, None),
        (None, None) => return Err(format!("{name} has no [act] target")),
    };
    crate::delivery::check_text(kind, &text)?;
    check_visible(&text)?;

    let key = (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        name.clone(),
        project.dir.clone(),
        row,
        ran_at_ms,
    );
    let mut recent = recent()
        .lock()
        .map_err(|_| "widget act state unavailable")?;
    recent.retain(|_, (at, ..)| at.elapsed() < AGAIN);
    if let Some((_, session, send)) = recent.get(&key) {
        return Ok(Reply::WidgetAct {
            session: session.clone(),
            send: send.clone(),
        });
    }
    let (id, submit) = match target {
        Some(id) => (id, false),
        None => {
            if kind != AgentKind::Shell {
                crate::pressure::check(crate::pressure::Who::Window, false, "widget action")?;
            }
            let launch = lock()?.launch(StartSession {
                account: None,
                kind,
                project: project.dir.clone(),
                worktree: false,
                label: name.clone(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            });
            let mut launch = launch.prepare()?;
            let started = {
                let mut sessions = lock()?;
                if stopping.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst)) {
                    return Err("core is stopping".into());
                }
                // v1b-21: counted under the lock that starts, so two clicks never pass the cap together.
                let Reply::Snapshot { sessions: now, .. } = sessions.handle(Request::Snapshot)?
                else {
                    return Err("unexpected snapshot reply".into());
                };
                let running = now
                    .iter()
                    .filter(|s| {
                        s.machine.is_none()
                            && s.state == SessionState::Running
                            && s.project == project.dir
                            && s.label == name
                    })
                    .count();
                if running >= START_LIMIT {
                    return Err(format!(
                        "{name} already has {running} running sessions in this project; stop one first"
                    ));
                }
                sessions.start(&launch)?
            };
            launch.committed = true;
            // The first prompt waits in the delivery queue until the new agent is ready.
            (started.id, true)
        }
    };
    let Reply::Delivery { send } = send_or_close(lock()?, &name, &id, text, submit, proof.hash())?
    else {
        return Err("unexpected delivery reply".into());
    };
    recent.insert(key, (Instant::now(), id.clone(), send.clone()));
    Ok(Reply::WidgetAct { session: id, send })
}

/// `submit` marks a session this act just started: a send the core refuses (a grant changed during the launch) closes
/// it, so no agent is left running without its prompt (Q9 zh-hant-J12-1).
fn send_or_close(
    mut sessions: std::sync::MutexGuard<'_, Sessions>,
    name: &str,
    id: &str,
    text: String,
    submit: bool,
    hash: &str,
) -> Response {
    let sent = sessions.widget_send(name, id, text, submit, hash);
    if sent.is_err() && submit {
        let _ = sessions.close(id, true, false); // the core started it, so the core may end it
    }
    sent
}

// v1b-22: one web act per widget per AGAIN; held across the send, so two acts never race past it.
type Last = Mutex<BTreeMap<(PathBuf, String), Instant>>;
fn last_web() -> &'static Last {
    static LAST: OnceLock<Last> = OnceLock::new();
    LAST.get_or_init(Default::default)
}

/// v1b-22: the web form of `widget_act`; `hash` is the approval hash of the page the confirm was drawn for (r2).
struct WebForm {
    name: String,
    session: Option<String>,
    text: String,
    target: super::web::Target,
    hash: String,
    frame: Option<String>,
}

/// v1b-22: a web widget's act, sent after the user clicked Send on the widget's header confirm in the window. Same
/// grant rule, text checks, targets and delivery path as the row form; the text is the widget's, checked here.
fn web_act(
    home: &Path,
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    form: WebForm,
) -> Response {
    let WebForm {
        name,
        session,
        text,
        target,
        hash: shown,
        frame,
    } = form;
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let (enabled, all) = {
        let mut sessions = lock()?;
        let Reply::Snapshot { sessions: all, .. } = sessions.handle(Request::Snapshot)? else {
            return Err("unexpected snapshot reply".into());
        };
        (sessions.web_widgets(), all)
    };
    if !enabled {
        return Err(super::web::OFF.into());
    }
    let proof = approval::check(home, &name).map_err(|e| format!("needs approval: {e}"))?;
    if proof.manifest().kind != "web" {
        return Err(format!("{name} is not a web widget"));
    }
    if proof.level() != Level::Act {
        return Err(format!(
            "act is not allowed for {name}: turn on act in its permission sheet"
        ));
    }
    // r2: only for the content the confirm was drawn for; `widget_send` holds the send to this same hash.
    if proof.hash() != shown {
        return Err(format!(
            "widget changed since the confirm; nothing sent (review {name} again)"
        ));
    }
    // v1b-34 r2: a page framed under the read policy (CDN scripts) never acts, whatever the window decided.
    if frame.as_deref() != Some(super::web::frame_id(&name, &shown, true).as_str()) {
        return Err(format!(
            "the page was framed without act; nothing sent (reload {name})"
        ));
    }
    let project = super::project(&all, session.as_deref())?
        .ok_or("act needs the placement's session for its project")?;
    super::web::check_text(&text)?;
    let (kind, id) = match (&target.session, target.start) {
        (Some(label), None) => {
            let id = resolve(&all, &project.dir, label)?;
            match all.iter().find(|s| s.id == id).map(|s| s.kind) {
                Some(kind @ (AgentKind::Claude | AgentKind::Codex)) => (kind, Some(id)),
                _ => {
                    return Err(format!(
                        "session {label} is a shell; act sends only to Claude or Codex sessions"
                    ));
                }
            }
        }
        (None, Some(kind @ (AgentKind::Claude | AgentKind::Codex))) => (kind, None),
        _ => return Err("act target is one of session = <label> or start = claude|codex".into()),
    };
    crate::delivery::check_text(kind, &text)?;

    let key = (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        name.clone(),
    );
    let mut last = last_web()
        .lock()
        .map_err(|_| "widget act state unavailable")?;
    if last.get(&key).is_some_and(|at| at.elapsed() < AGAIN) {
        return Err("one act per second; nothing sent".into());
    }
    last.insert(key, Instant::now());
    let (id, submit) = match id {
        Some(id) => (id, false),
        None => {
            if kind != AgentKind::Shell {
                crate::pressure::check(crate::pressure::Who::Window, false, "widget action")?;
            }
            let launch = lock()?.launch(StartSession {
                account: None,
                kind,
                project: project.dir.clone(),
                worktree: false,
                label: name.clone(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            });
            let mut launch = launch.prepare()?;
            let started = {
                let mut sessions = lock()?;
                if stopping.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst)) {
                    return Err("core is stopping".into());
                }
                let Reply::Snapshot { sessions: now, .. } = sessions.handle(Request::Snapshot)?
                else {
                    return Err("unexpected snapshot reply".into());
                };
                let running = now
                    .iter()
                    .filter(|s| {
                        s.machine.is_none()
                            && s.state == SessionState::Running
                            && s.project == project.dir
                            && s.label == name
                    })
                    .count();
                if running >= START_LIMIT {
                    return Err(format!(
                        "{name} already has {running} running sessions in this project; stop one first"
                    ));
                }
                sessions.start(&launch)?
            };
            launch.committed = true;
            (started.id, true)
        }
    };
    let Reply::Delivery { send } = send_or_close(lock()?, &name, &id, text, submit, proof.hash())?
    else {
        return Err("unexpected delivery reply".into());
    };
    Ok(Reply::WidgetAct { session: id, send })
}
