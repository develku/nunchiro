//! W35 picker (owner 11-20, mockup docs/design/model-picker-1120 mockup 2): a Claude session's fast mode and ultracode.
//!
//! Claude Code 2.1.329 read-only (`strings` of the installed binary): `/fast` in an interactive session saves
//! `fastMode` into the user's settings (`xr("userSettings",{fastMode:...})` behind `m&&=ape()`, first-party login), so it
//! would change every later session; the toggle restarts this conversation instead (`fast_restart`, through the model
//! switch's restart) with `fastMode` and `fastModePerSessionOptIn` in the session's own `--settings` file.
//! `/effort ultracode on|off` only sets the session's state ("interactive toggles never persist it", the `ultracode`
//! settings key's own description), so a running toggle types it.
//! One user-settings write stays Claude's own: when the account or org refuses fast mode, Claude clears the user's
//! `fastMode` (it never turns fast on elsewhere; Fable review note).
//!
//! Ticket 1010, how Claude says that fast mode is refused or paused. Claude Code 2.1.330 read-only (the JS in the
//! installed binary, `~/.local/share/claude/versions/2.1.330`; nothing was typed into a real session):
//! - A pause (`cmn`, text from `umn(reason, Cn(ms, {hideTrailingZeros}))`) is a footer notice, "Fast limit reached,
//!   fast mode paused · resets in 4m 30s" (`rate_limit`), "Fast mode is busy right now · resets in 5m" (`overloaded`),
//!   "Fast mode paused: your cloud provider refused a fast request · trying again in 45s" (`refused`); its end is
//!   "Fast limit reset · now using fast mode" or "Trying fast mode again". Meanwhile the footer's ↯ is drawn faint
//!   (`Lqe(true, cooldown)`: `dim(promptBorder(↯))`; a screen reader gets "fast mode (cooling down)").
//! - A refusal for the account (`lmn` with `V0`: "Fast mode disabled · Out of usage credits" and its siblings; `amn`
//!   with `D9`/`H0`/`TA`: "Fast mode has been disabled by your organization", "Fast mode requires usage credits",
//!   "Fast mode requires a paid subscription", ...) is a footer notice too, and Claude sets its own `fastMode` false:
//!   the ↯ goes.
//! - Not read here, because Nunchiro runs Claude's terminal and not its stream: the SDK's `fast_mode_state`
//!   ("off" | "cooldown" | "on") and `fast_mode_disabled_reason` on `system/init` and `result`, and the
//!   `{"type":"system","subtype":"notification","key":"fast-mode-overage-rejected","text":...}` event. The status line
//!   JSON (`nunchiro hook statusline`) carries only `fast_mode: <bool>`, with neither the reason nor the pause.
use super::*;

/// Fast mode runs on these only (the catalogue's Opus 5.5 and Fable 5.2); Claude's own `/fast` would switch the model.
pub(crate) fn fast_model(model: Option<&str>) -> bool {
    model.is_none_or(|m| {
        ["opus", "fable", "opus[1m]", "fable[1m]"].contains(&m)
            || m.starts_with("claude-opus-5-5")
            || m.starts_with("claude-fable-5-2")
    })
}

/// The `--settings` keys a start with `modes` carries. Only this session's file: a later session starts without them.
pub(super) fn settings(settings: &mut serde_json::Map<String, serde_json::Value>, modes: &Modes) {
    if let Some(fast) = modes.fast {
        settings.insert("fastMode".into(), fast.into());
        if fast {
            settings.insert("fastModePerSessionOptIn".into(), true.into());
        }
    }
    if modes.ultracode == Some(true) {
        settings.insert("ultracode".into(), true.into());
    }
}

/// Claude's footer: the rows under its input box (after the last `❯` row and the rule that closes the box).
fn footer(screen: &str) -> impl Iterator<Item = &str> {
    let rows: Vec<&str> = screen.lines().collect();
    let box_at = rows.iter().rposition(|r| r.starts_with('❯'));
    rows.into_iter()
        .skip(box_at.map_or(usize::MAX, |at| at + 1))
        .skip_while(|r| !r.starts_with('─'))
}

/// Ticket 1010: fast mode as Claude's footer last said it (the module note has the sentences and their source): a
/// pause with its end counted from `now` (epoch seconds), its end, or a refusal, whose sentence is kept as `fast_note`.
/// `shown`: the pause notice on the last read, so one that stays up counts once. Returns whether `modes` changed.
pub(super) fn fast_read(
    modes: &mut Option<Modes>,
    shown: &mut Option<String>,
    screen: &str,
    now: i64,
) -> bool {
    const PAUSED: &[&str] = &[
        "Fast limit reached, fast mode paused",
        "Fast mode is busy right now",
        "Fast mode paused: your cloud provider refused a fast request",
    ];
    const BACK: &[&str] = &["Fast limit reset", "Trying fast mode again"];
    const REFUSED: &[&str] = &[
        "Fast mode disabled",
        "Fast mode requires ",
        "Fast mode unavailable ",
        "Fast mode has been disabled",
        "Fast mode is currently unavailable",
        "Fast mode is not available",
        "Fast mode needs ",
    ];
    let said = |words: &[&str]| {
        footer(screen).find_map(|row| {
            let at = words.iter().find_map(|w| row.find(w))?;
            Some(row[at..].trim_end().chars().take(200).collect::<String>())
        })
    };
    let before = modes.clone();
    let paused = said(PAUSED);
    if let Some(notice) = paused.as_ref().filter(|n| shown.as_ref() != Some(n)) {
        // "... · resets in 1h 5m": Claude's `Cn` writes days, hours, minutes and seconds, the zero ones left out.
        let end = notice.rsplit_once(" \u{b7} ").and_then(|(text, rest)| {
            let secs = rest
                .rsplit_once(" in ")?
                .1
                .split(' ')
                .try_fold(0, |sum, part| {
                    let unit = match part.chars().last()? {
                        'd' => 86400,
                        'h' => 3600,
                        'm' => 60,
                        's' => 1,
                        _ => return None,
                    };
                    Some(sum + part[..part.len() - 1].parse::<i64>().ok()? * unit)
                })?;
            Some((text.to_string(), now + secs))
        });
        // A notice this build cannot read leaves the faint ↯ to say it (`shown_modes`).
        if let Some((text, until)) = end {
            let modes = modes.get_or_insert_default();
            modes.fast_cooldown = Some(FastCooldown {
                text: Some(text),
                until: Some(until),
            });
            modes.fast_note = None;
        }
    } else if paused.is_none() {
        if let Some(note) = said(REFUSED) {
            let modes = modes.get_or_insert_default();
            (modes.fast_note, modes.fast_cooldown) = (Some(note), None);
        } else if said(BACK).is_some()
            && let Some(modes) = modes
        {
            modes.fast_cooldown = None;
        }
    }
    *shown = paused;
    *modes != before
}

/// Fable review SHOULD 1: ultracode is what Claude last said on its screen: "Ultracode on (this session only)",
/// "Ultracode off." or a refusal (2.1.329 `N`: "Ultracode needs dynamic workflows ...", "Ultracode isn't available on
/// ..."), whose sentence is kept as `note`. Returns whether `meta` changed.
/// shortcut: the same words typed into the transcript read too; tie it to the send row if that bites.
pub(super) fn ultracode_read(modes: &mut Option<Modes>, screen: &str) -> bool {
    const ON: &str = "Ultracode on (this session only)";
    let said = screen.lines().rev().find_map(|line| {
        let at = line.find("Ultracode ")?;
        let line = line[at..].trim_end();
        if line.starts_with(ON) {
            Some((Some(true), None))
        } else if line.starts_with("Ultracode off.") {
            Some((Some(false), None))
        } else if line.starts_with("Ultracode needs dynamic workflows")
            || line.starts_with("Ultracode isn't available")
        {
            Some((
                modes.as_ref().and_then(|m| m.ultracode),
                Some(line.chars().take(200).collect::<String>()),
            ))
        } else {
            None
        }
    });
    let Some((ultracode, note)) = said else {
        return false;
    };
    let modes = modes.get_or_insert_default();
    let changed = modes.ultracode != ultracode || modes.note != note;
    (modes.ultracode, modes.note) = (ultracode, note);
    changed
}

/// Ticket 1018: a start that asks for Ultracode itself (`--effort ultracode`, 2.1.329: "Ultracode is on from --effort
/// ultracode").
pub(super) fn launched_ultracode(start: &StartSession) -> bool {
    start.effort.as_deref() == Some("ultracode")
        || start
            .args
            .windows(2)
            .any(|w| w[0] == "--effort" && w[1] == "ultracode")
        || start.args.iter().any(|a| a == "--effort=ultracode")
}

/// Fable re-review SHOULD a: the launch arguments a Claude restart repeats. A positional (a first prompt) would be
/// submitted again on every restart, so it refuses, as `carried_codex_args` does; flags repeat as they are. Values are
/// told from positionals by Claude's own flags (2.1.329 `--help`): one value, or a list up to the next flag.
fn carried_claude_args(args: Vec<String>) -> Result<Vec<String>, String> {
    const ONE: &[&str] = &[
        "--permission-mode",
        "--append-system-prompt",
        "--system-prompt",
        "--append-system-prompt-file",
        "--system-prompt-file",
        "--settings",
        "--setting-sources",
        "--model",
        "--effort",
        "--fallback-model",
        "--agent",
        "--agents",
        "--session-id",
        "--resume",
        "-r",
        "--name",
        "--debug-file",
        "--plugin-dir",
        "--max-turns",
    ];
    const LIST: &[&str] = &[
        "--add-dir",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--mcp-config",
        "--betas",
        "--tools",
    ];
    let (mut one, mut list) = (false, false);
    for arg in &args {
        if arg == "--" || !arg.starts_with('-') && !std::mem::take(&mut one) && !list {
            return Err(format!(
                "this session was started with a prompt in its arguments ({arg:?}), which a restart would send again; \
                 turn fast mode on when you start a new session"
            ));
        }
        if arg.starts_with('-') {
            (one, list) = (ONE.contains(&arg.as_str()), LIST.contains(&arg.as_str()));
        }
    }
    Ok(args)
}

/// Codex round 7 MUST (allow list, fail closed): whether a launch record may be written to disk (`store::Live`). Only a
/// Claude session's, and only when every argument is a flag a role or the window gives (ledger.rs role seats, the
/// permission chooser, folders) with a value of a plain shape. Anything else (another flag, a `=` form, inline JSON, a
/// positional, a Codex `--config` key) stays in the running core only; after a core restart its fast toggle is refused.
pub(super) fn storable(kind: AgentKind, args: &[String]) -> bool {
    fn plain(v: &str, extra: &str) -> bool {
        !v.is_empty()
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c) || extra.contains(c))
    }
    fn tools(v: &str) -> bool {
        plain(v, ",:*() ")
    }
    fn path(v: &str) -> bool {
        v.starts_with('/') && plain(v, "/ ")
    }
    fn mode(v: &str) -> bool {
        [
            "default",
            "manual",
            "acceptEdits",
            "plan",
            "auto",
            "bypassPermissions",
        ]
        .contains(&v)
    }
    fn id(v: &str) -> bool {
        plain(v, "")
    }
    type Shape = fn(&str) -> bool;
    // (flag, its value's shape, takes a list of values)
    const VALUE: &[(&str, Shape, bool)] = &[
        ("--disallowedTools", tools, true),
        ("--disallowed-tools", tools, true),
        ("--allowedTools", tools, true),
        ("--allowed-tools", tools, true),
        ("--add-dir", path, true),
        ("--plugin-dir", path, false),
        ("--permission-mode", mode, false),
        ("--model", id, false),
        ("--effort", id, false),
        ("--session-id", id, false),
        ("--resume", id, false),
    ];
    let bare = [
        crate::agent_permission::START_IN_SKIP,
        crate::agent_permission::ALLOW_SKIP,
    ];
    if kind != AgentKind::Claude {
        return false;
    }
    let mut owner: Option<(Shape, bool, bool)> = None; // (shape, list, a value seen)
    for arg in args {
        if arg.starts_with('-') {
            if owner.is_some_and(|(_, _, seen)| !seen) {
                return false; // a flag without its value
            }
            owner = None;
            if bare.contains(&arg.as_str()) {
                continue;
            }
            match VALUE.iter().find(|(flag, _, _)| flag == arg) {
                Some((_, shape, list)) => owner = Some((*shape, *list, false)),
                None => return false, // any other flag, and every `--flag=value`
            }
        } else {
            match owner {
                Some((shape, list, seen)) if (list || !seen) && shape(arg) => {
                    owner = Some((shape, list, true))
                }
                _ => return false, // a positional, or a value of another shape
            }
        }
    }
    owner.is_none_or(|(_, _, seen)| seen)
}

/// W35-picker2 S3: the model a Claude launch named in its own arguments (`agent start -- --model haiku`), so the chip
/// names it before the first reply; the start's own `model` wins.
pub(super) fn named_model(start: &StartSession) -> Option<String> {
    if start.kind != AgentKind::Claude {
        return None;
    }
    let args = &start.args;
    let value = args
        .iter()
        .enumerate()
        .find_map(|(i, a)| match a.strip_prefix("--model") {
            Some("") => args.get(i + 1).cloned(),
            Some(rest) => rest.strip_prefix('=').map(str::to_string),
            None => None,
        })?;
    (!value.is_empty() && value.len() <= 100 && !value.starts_with('-')).then_some(value)
}
/// A restart names its model and effort itself (the start's `model`, `effort`, which a switch may have changed since):
/// the launch's own `--model` and `--effort` go.
fn without_model(args: &[String]) -> Vec<String> {
    let mut value = false;
    args.iter()
        .filter(|a| {
            if std::mem::take(&mut value) {
                return false;
            }
            let name = a.split_once('=').map_or(a.as_str(), |(name, _)| name);
            let ours = name == "--model" || name == "--effort";
            value = ours && !a.contains('=');
            !ours
        })
        .cloned()
        .collect()
}

/// Round 5 (fail closed): Claude 2.1.329's permission flags (`--help`). A restart removes every one of them from the
/// recorded and approved arguments and starts in exactly the mode the session is in now (`restart_mode`); the old
/// arguments never decide the mode.
const PERMISSION_FLAGS: &[&str] = &[
    crate::agent_permission::START_IN_SKIP,
    crate::agent_permission::ALLOW_SKIP,
];
const PERMISSION_FLAGS_WITH_VALUE: &[&str] = &[
    "--permission-mode",
    "--inherit-permission-mode",
    "--permission-prompt-tool",
    "--permission-prompts",
];
fn without_permission_flags(args: &[String]) -> Vec<String> {
    let mut value = false;
    args.iter()
        .filter(|a| {
            if std::mem::take(&mut value) {
                return false;
            }
            let name = a.split_once('=').map_or(a.as_str(), |(name, _)| name);
            value = PERMISSION_FLAGS_WITH_VALUE.contains(&name) && !a.contains('=');
            !PERMISSION_FLAGS.contains(&name) && !PERMISSION_FLAGS_WITH_VALUE.contains(&name)
        })
        .cloned()
        .collect()
}
/// The one `--permission-mode` a restart starts with: the mode the footer last showed (`Session::ran_mode`, what the
/// mode chip shows), or none when it is not known.
fn restart_mode(ran: Option<&str>) -> Option<Vec<String>> {
    let mode = match ran? {
        "manual" => "manual",
        "accept edits" => "acceptEdits",
        "plan" => "plan",
        "auto" => "auto",
        "bypass permissions" => "bypassPermissions",
        _ => return None,
    };
    Some(vec!["--permission-mode".into(), mode.into()])
}

/// A restart's launch parts (`restart_permission`).
struct RestartLaunch {
    args: Vec<String>,
    approved: Vec<String>,
    permission: Vec<String>,
    ran_mode: Option<String>,
    bypass_disabled: bool,
}

impl Sessions {
    /// What `start` refuses under its lock, also run by a restart before it stops the agent (Fable re-review SHOULD b):
    /// a worktree removal, a changed agent command, an account removed, signing in or being logged out. Returns the
    /// account's name as registered now.
    pub(super) fn start_checks(
        &self,
        launch: &Launch,
    ) -> Result<(Option<crate::approval::CommandProof>, Option<String>), String> {
        if self
            .removing_worktrees
            .iter()
            .any(|path| launch.cwd.starts_with(path) || launch.project.starts_with(path))
        {
            return Err("worktree removal in progress".into());
        }
        // Ticket 358: the approval read again under the lock that starts the session, because `prepare` ran off it.
        let command = crate::approval::check_command(&self.home, launch.start.kind)?;
        if command.as_ref().map(|c| c.hash()) != launch.command.as_ref().map(|c| c.hash()) {
            return Err(
                "the agent command changed since this start was prepared; start it again".into(),
            );
        }
        // v2-2d: a launch prepared off the lock starts only while its account is still registered (not removed since).
        // Ticket 358: the name read here, under the lock a rename holds, so a launch prepared before one records the new name.
        let mut account = launch.account.clone();
        if let Some((variable, folder)) = &launch.config {
            let label = crate::accounts::still_registered(&self.home, variable, folder)?;
            account = account.map(|_| label);
            // Round 2: nor while the account's browser sign-in runs (its login writes the same folder).
            if crate::account_signin::busy(folder) {
                return Err(format!(
                    "account {:?} is signing in; finish or cancel the sign-in first",
                    launch.account.as_deref().unwrap_or_default()
                ));
            }
            // Ticket 32: nor while the account's logout tab is listed (its remove went past the check): the agent would
            // run logged out. Closing that tab, a login since, or the move ends it.
            if launch.start.kind != AgentKind::Shell
                && let Some(tab) = self.logouts.get(folder).and_then(|id| self.entries.get(id))
                && tab.meta.state != SessionState::Closed
            {
                return Err(format!(
                    "account {:?} is in use by {:?}; close them first",
                    launch.account.as_deref().unwrap_or_default(),
                    tab.meta.label
                ));
            }
        }
        Ok((command, account))
    }

    /// The refusals a switch and a mode toggle share: a walk, a switch already running, a submit in flight, a waiting
    /// decision, a working agent and a draft in the box. Returns the snapshot and the screen they were read from.
    pub(super) fn switch_checks(
        &mut self,
        id: &str,
        kind: AgentKind,
    ) -> Result<(Session, String), String> {
        // CHAT-MODELIST r3: the picker is input too: no switch while a walk (or its hold) is on, as `set_mode` refuses
        // the reverse.
        if self.walk_hold(id) {
            return Err(MODE_BUSY.into());
        }
        if !self.entry(id)?.agent_live() || self.entry(id)?.pty.is_none() {
            return Err("agent is not running".into());
        }
        if self.entry(id)?.switch.is_some() {
            return Err("a model switch is already running for this session".into());
        }
        self.current(id)?; // v1a-19 r3
        // v1a-15: the pending Enter would land in the picker.
        if self.pending_enter.contains_key(id) {
            return Err("a prompt is being submitted; switch when it is idle".into());
        }
        let meta = self.entry(id)?.meta.clone();
        let snapshot = self.snapshot_session(&meta);
        if crate::delivery::blocked(&snapshot.pending) {
            return Err("answer the waiting decision first".into());
        }
        if snapshot.attention.working {
            return Err("the agent is working; switch when it is idle".into());
        }
        // The Claude switch never touches a draft, but refusing it keeps the picker out of the user's way;
        // a Codex restart would lose it.
        let screen = self.entry(id)?.observer.screen.text();
        // Ticket 991 (B2): Claude draws its suggested next prompt (`commit this`) faint in the box after a turn; read
        // as a draft, it refused every switch and the chat had nothing to clear.
        let suggested = self.entry(id)?.observer.screen.composer_faint();
        match composer(&screen, kind) {
            Some(text) if !text.is_empty() && !suggested => {
                return Err(format!(
                    "text is in {kind:?}'s input box; send or clear it first"
                ));
            }
            // v1a-24: a box not found may hold a draft the Codex restart would lose.
            None if kind == AgentKind::Codex => {
                return Err("Codex's input box is not on the screen; switch when it shows".into());
            }
            _ => {}
        }
        Ok((snapshot, screen))
    }

    /// The modes the window shows: what the start chose, with fast mode as Claude draws it while its box shows.
    pub(super) fn shown_modes(&self, meta: &Session, live: bool) -> Option<Modes> {
        let mut modes = meta.modes.clone();
        // Ticket 1010: a pause whose end has passed says nothing any more.
        let now = queue::now_ms() as i64 / 1000;
        if let Some(modes) = &mut modes {
            modes
                .fast_cooldown
                .take_if(|c| c.until.is_none_or(|until| until <= now));
        }
        // Claude's ↯ under its box (`Screen::fast_mark`): none is off, faint is on but paused.
        let drawn = self
            .entries
            .get(&meta.id)
            .filter(|_| live && meta.kind == AgentKind::Claude)
            .and_then(|e| {
                e.observer
                    .screen
                    .read_fast(|text| composer(text, AgentKind::Claude).is_some())
            });
        if let Some(mark) = drawn {
            let modes = modes.get_or_insert_default();
            modes.fast = Some(mark.is_some());
            match mark {
                Some(true) => {
                    modes.fast_cooldown.get_or_insert_default();
                }
                Some(false) => (modes.fast_cooldown, modes.fast_note) = (None, None),
                None => modes.fast_cooldown = None,
            }
        }
        modes
    }

    /// Ultracode on or off in a running Claude session: `/effort ultracode on|off` as one send row, idle only.
    pub(super) fn ultracode_toggle(&mut self, id: &str, on: bool) -> Response {
        if self.entry(id)?.meta.kind != AgentKind::Claude {
            return Err("ultracode is Claude's only".into());
        }
        let (snapshot, screen) = self.switch_checks(id, AgentKind::Claude)?;
        if !crate::delivery::ready(
            AgentKind::Claude,
            &snapshot.attention,
            &snapshot.pending,
            &screen,
        ) {
            return Err("Claude is not at its prompt".into());
        }
        let text = format!("/effort ultracode {}", if on { "on" } else { "off" });
        // The state comes from Claude's answer (`ultracode_read`), never from the send alone.
        let reply = self.send("user", id, text, vec![], true)?;
        // W35-picker2 S2-2: a control command goes in now or not at all: never queued behind a turn, where it would reach
        // Claude later as it pleases (a queued row is sent when a turn ends).
        if let Reply::Delivery { send } = &reply
            && send.status == "queued"
        {
            self.finish_send(id, &send.id, "canceled")?;
            return Err(
                "Claude is still answering an earlier message; switch when it is idle".into(),
            );
        }
        Ok(reply)
    }

    /// A fast mode toggle: this conversation restarts through the model switch's own restart (`restart_resumed`), from
    /// the session's recorded launch, with the mode in its settings file. Refused, with the run untouched, when that launch
    /// is not fully known (Codex security MUST, round 3: a Reviewer seat's `--disallowedTools` must come back).
    pub(super) fn fast_restart(&mut self, id: &str, on: bool) -> Response {
        let meta = self.entry(id)?.meta.clone();
        if meta.kind != AgentKind::Claude {
            return Err("fast mode is Claude's only".into());
        }
        if on && !fast_model(meta.model.as_deref()) {
            return Err("fast mode runs on Opus 5.5 or Fable 5.2; pick one of them first".into());
        }
        // A Home seat's lock and a side chat's plan mode are built by `prepare`, which this restart does not run.
        if meta.home_lock || meta.side_chat {
            return Err("this session keeps the settings it started with".into());
        }
        // The row keeps what this run was started with (a resume's own, after a core restart too). Round 5, fail closed:
        // no record (a start with --env, whose values are never kept, or a row from before the record) is refused,
        // never restarted with less than it had.
        let entry = self.entry(id)?;
        let args = entry.launch.clone().ok_or(
            "this session's launch arguments are not on record (it was started with --env, with values Nunchiro does \
             not write to disk and the core has restarted since, or before Nunchiro kept them), so a restart could not \
             repeat them; turn fast mode on when you start a new session",
        )?;
        let args = carried_claude_args(args)?;
        // Codex round-6 MUST: a Claude conversation is on disk only after its first finished turn (`--resume` fails
        // before); a fresh start would leave the row's seat, parent and ledger writer behind, so fast mode waits for it.
        if self.queue.attention(id).completion_seq == 0 {
            return Err("fast mode is available after Claude's first reply".into());
        }
        let (snapshot, screen) = self.switch_checks(id, AgentKind::Claude)?;
        if !crate::delivery::ready(
            AgentKind::Claude,
            &snapshot.attention,
            &snapshot.pending,
            &screen,
        ) {
            return Err("Claude is not at its prompt".into());
        }
        let modes = Modes {
            fast: Some(on),
            ultracode: meta.modes.as_ref().and_then(|m| m.ultracode),
            ..Default::default() // ticket 1010: a restart asks Claude again, so its last refusal and pause go
        };
        self.restart_resumed(
            id,
            args,
            meta.model.clone(),
            meta.effort.clone(),
            Some(modes),
        )
    }

    /// What a restart starts with: Codex keeps its arguments and what its permission added (ticket 362; it has no live
    /// mode). Claude (round 5, fail closed): its arguments and the approved ones without any permission flag, and one
    /// `--permission-mode` for the mode it is in now; refused, before anything stops, when that mode is not known.
    fn restart_permission(
        &self,
        id: &str,
        args: Vec<String>,
        approved: Vec<String>,
        account: Option<&(PathBuf, String)>,
        cwd: &Path,
    ) -> Result<RestartLaunch, String> {
        let entry = self.entries.get(id).ok_or("session not found")?;
        if entry.meta.kind != AgentKind::Claude {
            return Ok(RestartLaunch {
                args,
                approved,
                permission: entry.permission.clone(),
                ran_mode: None,
                bypass_disabled: entry.bypass_disabled,
            });
        }
        // Fable SHOULD 1 (round 6): Skip permissions comes back only for a session given it at its start (its own
        // arguments or what its permission added) or by the owner's pick; a footer line alone never grants it.
        let skip = |a: &String| {
            let name = a.split_once('=').map_or(a.as_str(), |(n, _)| n);
            PERMISSION_FLAGS.contains(&name) || a.ends_with("bypassPermissions")
        };
        if entry.meta.ran_mode.as_deref() == Some("bypass permissions")
            && !(entry.skip_chosen || args.iter().chain(&entry.permission).any(skip))
        {
            return Err("this session was not given Skip permissions when it started, so a restart will not start it \
                        there; pick another mode first"
                .into());
        }
        let permission = restart_mode(entry.meta.ran_mode.as_deref()).ok_or(
            "Claude's permission mode has not been read from its screen yet, so a restart could not keep it; \
             try again once its footer shows the mode",
        )?;
        let limits = crate::agent_permission::claude_limits(
            account.map(|(folder, _)| folder.as_path()),
            cwd,
        );
        Ok(RestartLaunch {
            args: without_model(&without_permission_flags(&args)),
            approved: without_permission_flags(&approved),
            permission,
            ran_mode: entry.meta.ran_mode.clone(),
            bypass_disabled: limits.bypass_disabled,
        })
    }

    /// v1a-10 (moved here, W35): a restart of a running Codex or Claude session into the same conversation, from its
    /// recorded launch: the same arguments and permission arguments, the approved command and account read again, its
    /// token origin, hook choice and start commit. Every check that can refuse runs before the agent is stopped; `start`
    /// keeps its own checks before the spawn. `modes`: a Claude start's fast mode and ultracode (`settings`).
    pub(super) fn restart_resumed(
        &mut self,
        id: &str,
        args: Vec<String>,
        model: Option<String>,
        effort: Option<String>,
        modes: Option<Modes>,
    ) -> Response {
        let meta = self.entry(id)?.meta.clone();
        let name = if meta.kind == AgentKind::Codex {
            "Codex"
        } else {
            "Claude"
        };
        let agent = crate::accounts::agent_of(meta.kind).ok_or("only Claude and Codex restart")?;
        // Ticket 358: a restart runs what is approved now, and a refusal comes before the agent is stopped. An agent's
        // child never gets approved arguments (`Launch::prepare`).
        let command = crate::approval::check_command(&self.home, meta.kind)?;
        let approved_args = command
            .as_ref()
            .filter(|_| meta.parent.is_none())
            .map_or(vec![], |c| c.args().to_vec());
        let resume = meta
            .agent_session_id
            .clone()
            .ok_or(format!("{name} has not reported its conversation id yet"))?;
        // v2-2b: the session's account again from the registry, checked before the agent is stopped.
        let account = meta
            .config_dir
            .as_deref()
            .map(|folder| crate::accounts::folder_again(&self.home, agent, folder))
            .transpose()?;
        let cwd = Some(meta.cwd.clone())
            .filter(|c| c.is_dir())
            .unwrap_or(meta.project.clone()); // the resume rule
        if !cwd.is_dir() {
            return Err(format!(
                "{name}'s folder is gone; resume it from the session"
            ));
        }
        let RestartLaunch {
            args,
            approved: approved_args,
            permission,
            ran_mode,
            bypass_disabled,
        } = self.restart_permission(id, args, approved_args, account.as_ref(), &cwd)?;
        let mut launch = Launch {
            env: Default::default(), // never stored (ticket 573): a start with --env has no launch record and is refused
            origin: meta.token_origin.clone(), // a switch keeps it (and `spawn` refuses it)
            home: self.home.clone(),
            settings: self.settings.clone(),
            start: StartSession {
                account: None,
                kind: meta.kind,
                project: meta.project.clone(),
                worktree: false,
                label: meta.label.clone(),
                args: args.clone(),
                model: model.clone(),
                effort: effort.clone(),
                resume: Some(resume),
            },
            id: store::new_id()?,
            project: meta.project.clone(),
            cwd,
            version: meta.agent_version.clone(),
            version_probe: Default::default(), // set once the agent is stopped
            // v2-2a: a model switch is never an account login; v2-2b: it keeps the session's account.
            config: account
                .clone()
                .map(|(folder, _)| (crate::accounts::variable(agent), folder)),
            resume_config: None,
            carry_from: None,
            account: account.map(|(_, label)| label),
            without_hooks: meta.without_hooks, // v2-5b: a switch keeps a hook-less start hook-less
            no_history: false,
            account_tab: false,
            owner: false,
            owner_terminal: false,
            home_lock: meta.home_lock, // refused above for Claude, never set on Codex: `start` refuses it
            home_mode: None,
            permission,
            command,
            approved_args,
            bypass_disabled,
            ran_mode,
            worktree_created: false,
            folder: None,
            resume_cwd: None,
            committed: false,
            codex_read_only: None,
            codex_hooks_clear: None,
            codex_asked: None,
            ultracode: None,
            // v1b-11 merge: the same conversation keeps its start commit (spawn prefers the prior's too).
            start_commit: meta.start_commit.clone(),
        };
        // Q9 en-b-J7-2 (main, merged here): a Codex switch's off-lock hooks answer, only for the exact folders it read.
        // Ticket 1150 round 2: and its Codex's yes to the outward hook, asked off the lock too (`switch_model`); a
        // restart that was not asked is refused here, before the agent stops (`spawn` compares the whole question).
        if meta.kind == AgentKind::Codex {
            let read = (
                launch.cwd.clone(),
                meta.project.clone(),
                meta.config_dir.clone(),
            );
            let (clear, asked) = (self.switch_hooks.take())
                .filter(|(k, ..)| *k == read)
                .map(|(_, clear, asked)| (clear, asked))
                .unzip();
            launch.codex_hooks_clear = clear;
            launch.codex_asked = asked;
            if launch.codex_asked.is_none() {
                return Err("Codex was not asked whether it runs Nunchiro's outward-action check before this restart; switch again".into());
            }
        }
        // Fable re-review SHOULD b: everything `start` refuses is checked before the agent stops.
        self.start_checks(&launch)?;
        let entry = self.entry(id)?;
        if let Some(pty) = entry.pty.as_mut() {
            let pid = pty.pid();
            let started = pty.agent_started();
            agent_stopped(pty.stop(), pid, started)?;
        }
        entry.pty = None;
        entry.meta.pid = None;
        entry.meta.state = SessionState::Exited;
        let version_probe = entry.version_probe.take(); // V1A-89: the restart's row gets the version
        self.queue.close(id, false)?;
        self.save()?;
        launch.version_probe.set(version_probe);
        self.start_modes = modes;
        let result = self.start(&launch);
        self.start_modes = None;
        launch.committed = result.is_ok(); // a failed start leaves no settings file behind
        if let Ok(session) = &result {
            self.entry(&session.id)?.args = Some(args); // known: this restart chose them
        }
        let result_text = match &result {
            Ok(s) => format!("restarted as {}", s.id),
            Err(e) => format!("failed: {e}"),
        };
        switch_log(id, Some(meta.kind), &model, &effort, &result_text);
        result
            .map(|session| Reply::Started { session })
            .map_err(|e| {
                format!("{name} stopped and did not restart ({e}); resume it from the session")
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_carry_the_keys_only_when_asked() {
        let mut map = serde_json::Map::new();
        settings(&mut map, &Modes::default());
        assert!(map.is_empty());
        settings(
            &mut map,
            &Modes {
                fast: Some(true),
                ultracode: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            serde_json::Value::Object(map),
            serde_json::json!({"fastMode": true, "fastModePerSessionOptIn": true, "ultracode": true})
        );
        let mut off = serde_json::Map::new();
        settings(
            &mut off,
            &Modes {
                fast: Some(false),
                ultracode: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(
            serde_json::Value::Object(off),
            serde_json::json!({"fastMode": false})
        );
    }

    #[test]
    fn ultracode_is_what_claude_last_said() {
        let mut meta = None;
        assert!(!ultracode_read(&mut meta, "❯ hello"));
        assert!(ultracode_read(
            &mut meta,
            "  ⎿  Ultracode on (this session only): dynamic workflows on every task. Effort stays high.\n❯"
        ));
        assert_eq!(meta.as_ref().unwrap().ultracode, Some(true));
        let refused = "⎿ Ultracode on (this session only): x\n  ⎿  Ultracode needs dynamic workflows turned on (see /config). Options: low";
        assert!(ultracode_read(&mut meta, refused));
        let m = meta.clone().unwrap();
        assert_eq!(
            m.ultracode,
            Some(true),
            "a refusal changes nothing it did not say"
        );
        assert!(
            m.note
                .unwrap()
                .starts_with("Ultracode needs dynamic workflows")
        );
        assert!(ultracode_read(
            &mut meta,
            "  ⎿  Ultracode off. Effort stays high."
        ));
        assert_eq!(
            meta.unwrap(),
            Modes {
                ultracode: Some(false),
                ..Default::default()
            }
        );
    }

    /// Ticket 1010. The sentences are Claude Code 2.1.330's own, from its binary (see the module note): the footer
    /// notices of `umn` (a pause), `V0` and `TA` (a refusal) and the "back" notice of `cmn`.
    #[test]
    fn fast_pause_and_refusal_are_what_claudes_footer_says() {
        let footer = |notice: &str| {
            format!(
                "⏺ Fast mode disabled · typed in the chat\n────\n❯ Fast limit reached, fast mode paused · resets in 9m\n────\n  ⏸ plan mode on (shift+tab to cycle)      {notice}"
            )
        };
        let (mut modes, mut last) = (None, None);
        // The same words above the footer (the chat, a draft in the box) say nothing.
        assert!(!fast_read(&mut modes, &mut last, &footer(""), 1000));
        assert_eq!(modes, None);
        let paused = footer("Fast limit reached, fast mode paused · resets in 4m 30s");
        assert!(fast_read(&mut modes, &mut last, &paused, 1000));
        assert_eq!(
            modes.clone().unwrap().fast_cooldown,
            Some(FastCooldown {
                text: Some("Fast limit reached, fast mode paused".into()),
                until: Some(1270)
            })
        );
        // A notice that stays up is read once: its "in 4m 30s" counted from when it came.
        assert!(!fast_read(&mut modes, &mut last, &paused, 1008));
        for (line, text, secs) in [
            (
                "Fast mode is busy right now · resets in 1h 5m",
                "Fast mode is busy right now",
                3900,
            ),
            (
                "Fast mode paused: your cloud provider refused a fast request · trying again in 45s",
                "Fast mode paused: your cloud provider refused a fast request",
                45,
            ),
            (
                "Fast limit reached, fast mode paused · resets in 1d 2h",
                "Fast limit reached, fast mode paused",
                93600,
            ),
        ] {
            assert!(
                fast_read(&mut modes, &mut last, &footer(line), 2000),
                "{line}"
            );
            let cooldown = modes.clone().unwrap().fast_cooldown.unwrap();
            assert_eq!(
                (cooldown.text.as_deref(), cooldown.until),
                (Some(text), Some(2000 + secs))
            );
        }
        for back in [
            "Fast limit reset · now using fast mode",
            "Trying fast mode again",
        ] {
            fast_read(&mut modes, &mut last, &paused, 3000);
            assert!(
                fast_read(&mut modes, &mut last, &footer(back), 3001),
                "{back}"
            );
            assert_eq!(modes.clone().unwrap().fast_cooldown, None);
        }
        for refusal in [
            "Fast mode disabled · Out of usage credits",
            "Fast mode disabled · Usage credits turned off by your organization",
            "Fast mode disabled · usage credit limit reached",
            "Fast mode disabled · Usage credits aren't available for your plan",
            "Fast mode requires usage credits · turn on usage credits at claude.ai/settings/usage",
            "Fast mode requires a paid subscription",
            "Fast mode unavailable during evaluation. Please purchase credits.",
            "Fast mode has been disabled by your organization",
            "Fast mode unavailable due to network connectivity issues",
            "Fast mode is currently unavailable",
            "Fast mode is not available on this provider",
        ] {
            fast_read(&mut modes, &mut last, &paused, 4000);
            assert!(
                fast_read(&mut modes, &mut last, &footer(refusal), 4001),
                "{refusal}"
            );
            let m = modes.clone().unwrap();
            assert_eq!(
                (m.fast_note.as_deref(), m.fast_cooldown),
                (Some(refusal), None)
            );
        }
        // Not a refusal: Claude's own good news and its /fast answers.
        for other in [
            "Fast mode is now available · /fast to turn on",
            "Fast mode ON",
            "Fast mode OFF",
        ] {
            assert!(
                !fast_read(&mut modes, &mut last, &footer(other), 5000),
                "{other}"
            );
        }
    }

    #[test]
    fn a_restart_drops_every_permission_flag_and_names_the_mode_it_is_in() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let launch = v(&[
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--permission-mode",
            "auto",
            "--permission-mode=bypassPermissions",
            "--inherit-permission-mode",
            "acceptEdits",
            "--permission-prompt-tool",
            "mcp__x",
            "--permission-prompts=host",
            "--disallowedTools",
            "Edit",
        ]);
        assert_eq!(
            without_permission_flags(&launch),
            v(&["--disallowedTools", "Edit"])
        );
        assert_eq!(
            restart_mode(Some("plan")),
            Some(v(&["--permission-mode", "plan"]))
        );
        assert_eq!(
            restart_mode(Some("accept edits")),
            Some(v(&["--permission-mode", "acceptEdits"]))
        );
        assert_eq!(restart_mode(None), None);
        assert_eq!(restart_mode(Some("something new")), None);
    }

    #[test]
    fn a_restart_repeats_flags_and_refuses_a_prompt() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for ok in [
            v(&["--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"]),
            v(&[
                "--permission-mode",
                "acceptEdits",
                "--add-dir",
                "/a",
                "/b",
                "--verbose",
            ]),
            v(&["--model=opus", "--fixture-strict-resume"]),
        ] {
            assert_eq!(carried_claude_args(ok.clone()), Ok(ok));
        }
        for prompt in [
            v(&["do the task"]),
            v(&["--verbose", "do it"]),
            v(&["--model", "opus", "go"]),
            v(&["--", "x"]),
        ] {
            assert!(carried_claude_args(prompt).unwrap_err().contains("prompt"));
        }
    }

    #[test]
    fn a_launch_record_is_written_only_for_safe_claude_flags() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Each safe flag, alone and together (a role seat's tools, the window's mode, folders, ids).
        for ok in [
            v(&[]),
            v(&["--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"]),
            v(&["--disallowed-tools", "Edit"]),
            v(&["--allowedTools", "Bash(git status:*)", "Read"]),
            v(&["--allowed-tools", "Read"]),
            v(&["--add-dir", "/a", "/b c"]),
            v(&["--plugin-dir", "/p"]),
            v(&["--permission-mode", "acceptEdits"]),
            v(&["--model", "claude-opus-5-5"]),
            v(&["--effort", "xhigh"]),
            v(&["--session-id", "c94334bc-61fc-4e50-b29f-3eab732a90eb"]),
            v(&["--resume", "c94334bc-61fc-4e50-b29f-3eab732a90eb"]),
            v(&[
                "--dangerously-skip-permissions",
                "--allow-dangerously-skip-permissions",
            ]),
        ] {
            assert!(storable(AgentKind::Claude, &ok), "{ok:?}");
        }
        for not in [
            v(&["--config=mcp_servers.x.env.API_KEY=\"sk-1\""]), // the Codex review example
            v(&["-c", "mcp_servers.x.env.API_KEY=sk-1"]),
            v(&["--mcp-config", "/a.json"]), // an unknown (here: not listed) flag
            v(&["--settings", "/s.json"]),
            v(&["--append-system-prompt", "hi"]),
            v(&["--verbose"]),
            v(&["--model=opus"]), // any `=` form
            v(&["--permission-mode", "whatever"]),
            v(&["--add-dir", "relative"]),
            v(&["--allowedTools", "Bash(curl x?token=1)"]),
            v(&["--model"]),                   // a flag without its value
            v(&["--model", "opus", "sonnet"]), // one value only
            v(&["do the task"]),
        ] {
            assert!(!storable(AgentKind::Claude, &not), "{not:?}");
        }
        // Never a Codex, ACP or shell session's, whatever it holds.
        for kind in [AgentKind::Codex, AgentKind::Acp, AgentKind::Shell] {
            assert!(!storable(kind, &[]), "{kind:?}");
        }
    }

    #[test]
    fn after_a_core_restart_a_session_without_a_written_record_is_refused() {
        let home = std::env::temp_dir().join(format!("ns-w35-record-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let row: Session = serde_json::from_value(serde_json::json!({
            "id": "s1", "kind": "claude", "project": home, "cwd": home, "label": "x", "state": "exited",
            "agent_session_id": "c1", "agent_version": null, "untested": false, "pid": null,
        }))
        .unwrap();
        store::save(&home, vec![row], BTreeMap::new()).unwrap();
        let mut core = Sessions::open(&home).unwrap();
        let refused = core
            .handle(Request::SwitchModel {
                id: "s1".into(),
                model: None,
                effort: None,
                fast: Some(true),
                ultracode: None,
            })
            .unwrap_err();
        assert!(refused.contains("not on record"), "{refused}");
        drop(core);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_home_seat_and_a_side_chat_are_refused() {
        // Fable SHOULD 4 (round 6): their lock and plan mode come from `prepare`, which a restart does not run.
        let home = std::env::temp_dir().join(format!("ns-w35-seat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let row = |id: &str, extra: serde_json::Value| -> Session {
            let mut v = serde_json::json!({
                "id": id, "kind": "claude", "project": home, "cwd": home, "label": "x", "state": "exited",
                "agent_session_id": "c1", "agent_version": null, "untested": false, "pid": null,
            });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(v).unwrap()
        };
        let rows = vec![
            row(
                "seat",
                serde_json::json!({"home_lock": true, "home_mode": "ask"}),
            ),
            row("side", serde_json::json!({"side_chat": true})),
        ];
        store::save(&home, rows, BTreeMap::new()).unwrap();
        let mut core = Sessions::open(&home).unwrap();
        for id in ["seat", "side"] {
            let refused = core
                .handle(Request::SwitchModel {
                    id: id.into(),
                    model: None,
                    effort: None,
                    fast: Some(true),
                    ultracode: None,
                })
                .unwrap_err();
            assert!(
                refused.contains("keeps the settings it started with"),
                "{id}: {refused}"
            );
        }
        drop(core);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_launch_model_names_the_chip_and_a_restart_names_its_own() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let start = |args: &[&str]| StartSession {
            kind: AgentKind::Claude,
            project: "/".into(),
            worktree: false,
            label: String::new(),
            args: v(args),
            model: None,
            effort: None,
            resume: None,
            account: None,
        };
        assert_eq!(
            named_model(&start(&["--model", "haiku"])).as_deref(),
            Some("haiku")
        );
        assert_eq!(
            named_model(&start(&["--model=claude-opus-5-5"])).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(named_model(&start(&["--model"])), None);
        // Ticket 1018: a start that asks for Ultracode itself.
        assert!(launched_ultracode(&start(&["--effort", "ultracode"])));
        assert!(launched_ultracode(&start(&["--effort=ultracode"])));
        assert!(!launched_ultracode(&start(&["--effort", "high"])));
        assert_eq!(named_model(&start(&["--model", "--verbose"])), None);
        assert_eq!(
            without_model(&v(&[
                "--model",
                "haiku",
                "--effort=high",
                "--disallowedTools",
                "Edit"
            ])),
            v(&["--disallowedTools", "Edit"])
        );
    }

    #[test]
    fn fast_runs_on_opus_and_fable_only() {
        for yes in [
            None,
            Some("opus"),
            Some("fable"),
            Some("claude-opus-5-5"),
            Some("claude-fable-5-2[1m]"),
        ] {
            assert!(fast_model(yes), "{yes:?}");
        }
        for no in [
            Some("sonnet"),
            Some("haiku"),
            Some("claude-opus-4-8"),
            Some("my-model"),
        ] {
            assert!(!fast_model(no), "{no:?}");
        }
    }
}
