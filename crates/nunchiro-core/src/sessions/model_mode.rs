//! Model, effort and permission-mode changes: the checks, Claude's picker steps and the Shift+Tab walk.
use super::*;
const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("fable", "Fable"),
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
];
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
pub(super) const PICKER_OPEN: &[u8] = b"\x1bp"; // Claude's `meta+p` (chat:modelPicker); never `/model`
pub(super) struct Switch {
    pub(super) send: String,
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) confirming: bool,
    pub(super) keys: usize,
    /// When the last key went out, and the output offset at that moment.
    pub(super) sent: std::time::Instant,
    pub(super) seen: u64,
    /// The output offset last observed, and since when it has not moved.
    pub(super) last: u64,
    pub(super) quiet: std::time::Instant,
    /// The screen the last key was sent on; an unchanged screen has not answered it yet.
    pub(super) before: String,
}

/// CHAT-MODELIST: Claude's footer names, least to most access (the list's order; not the cycle's). Claude 2.1.318 cycles
/// auto, manual, accept edits, plan, [bypass permissions], auto, ...: `bypass permissions` is in the cycle only for a
/// session launched with `--allow-dangerously-skip-permissions` (checked against the real CLI), and `auto` only where the
/// account has it. A pick is found by pressing and reading the footer, one key at a time.
pub(super) const MODES: [&str; 5] = [
    "manual",
    "accept edits",
    "plan",
    "auto",
    "bypass permissions",
];
pub(super) const BYPASS: &str = "bypass permissions";
pub(super) const MODE_BUSY: &str = "mode change in progress";
/// A full cycle is at most `MODES.len()` presses; one more would only repeat the start.
const WALK_KEYS: u8 = MODES.len() as u8;
/// Claude redraws its footer within a frame of the key; this long without a change means the key did nothing.
const WALK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// A walk whose output viewer stays behind the PTY this long ends (and releases the hold): the footer cannot be trusted.
pub(super) const WALK_BEHIND: std::time::Duration = std::time::Duration::from_secs(10);
/// CHAT-MODELIST r4: see `Entry::skip_hold`. `unreadable_since`: when the footer last stopped being readable (a transient
/// notice over the mode row); the hold gives up on an unreadable footer after `WALK_BEHIND`, never on a readable one.
pub(super) struct SkipHold {
    pub(super) unreadable_since: Option<std::time::Instant>,
}
/// CHAT-MODELIST: a pick in flight. Each press is an ordinary logged `shift+tab` send; the next one goes only after
/// the footer showed the last one's effect.
pub(super) struct Walk {
    pub(super) target: String,
    /// The footer when the walk began: seeing it again before the target means the cycle has no target.
    pub(super) start: String,
    /// The footer at the last press.
    pub(super) before: String,
    /// The owner picked Bypass permissions itself; that counts only if the walk gets there.
    pub(super) chosen: bool,
    /// Set on the walk that brings a failed walk's session back to its start mode: the first walk's target and why it failed.
    pub(super) failure: Option<(String, String)>,
    pub(super) sent: std::time::Instant,
    pub(super) keys: u8,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Wait,
    Keys(&'static [u8]),
    Done,
    Fail(&'static str),
}

pub(crate) fn check_model(
    kind: AgentKind,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let efforts: &[&str] = match kind {
        AgentKind::Shell => return Err("a shell session has no model picker".into()),
        // V2-4a: an ACP agent's model and effort are its own Session Config Options.
        AgentKind::Acp => return Err("an ACP agent has no model picker here".into()),
        AgentKind::Claude => {
            if model.is_some_and(|m| !CLAUDE_MODELS.iter().any(|(alias, _)| *alias == m)) {
                return Err("unknown model".into());
            }
            CLAUDE_EFFORTS
        }
        AgentKind::Codex => match model {
            None => crate::agent_models::CODEX_DEFAULT_EFFORTS,
            Some(m) => {
                // A model Codex dropped from its list since a schedule, role or team row saved it still passes when
                // the fixed list has it (the cache can change at any Codex fetch, not only at a Nunchiro update).
                let listed = crate::agent_models::codex();
                let fixed = crate::agent_models::fallback();
                let efforts = &listed
                    .iter()
                    .chain(&fixed)
                    .find(|row| row.value == m)
                    .ok_or("unknown model")?
                    .efforts;
                return match effort {
                    Some(e) if !efforts.iter().any(|x| x == e) => {
                        Err("unknown effort for this model".into())
                    }
                    _ => Ok(()),
                };
            }
        },
    };
    if effort.is_some_and(|e| !efforts.contains(&e)) {
        return Err("unknown effort for this model".into());
    }
    Ok(())
}

/// Ticket 994: a model as its agent names it in short: Claude's alias by its name ("Opus"), any other by its own id.
pub(crate) fn model_name(kind: AgentKind, model: &str) -> String {
    CLAUDE_MODELS
        .iter()
        .find(|(alias, _)| kind == AgentKind::Claude && *alias == model)
        .map_or(model, |(_, name)| name)
        .to_string()
}

/// Ticket 358: the web's `MODEL_NAME` (newDefaults.ts): one argv word that cannot read as a flag.
pub(crate) fn model_word(m: &str) -> bool {
    m.len() <= 128
        && m.starts_with(|c: char| c.is_ascii_alphanumeric())
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}
impl Sessions {
    /// Ticket 358: `check_model`, also passing an id the owner stored in Settings > Accounts for this agent. A stored
    /// id has no effort list of its own, so it takes the no-model one.
    pub(super) fn check_stored_model(
        &self,
        kind: AgentKind,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let agent = match kind {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            _ => return check_model(kind, model, effort),
        };
        let stored = self
            .settings
            .feature::<serde_json::Value>("agents.custom_models");
        let listed = stored
            .as_ref()
            .and_then(|v| v.get(agent)?.as_array())
            .is_some_and(|list| {
                list.iter()
                    .any(|m| m.get("id").and_then(|i| i.as_str()) == model)
            });
        check_model(kind, model, effort).or_else(|e| {
            if listed && model.is_some_and(model_word) {
                check_model(kind, None, effort)
            } else {
                Err(e)
            }
        })
    }
}

pub(super) fn switch_log(
    id: &str,
    kind: Option<AgentKind>,
    model: &Option<String>,
    effort: &Option<String>,
    result: &str,
) {
    eprintln!(
        "switch session={id} agent={} model={} effort={} result={result}",
        kind.map_or("?".into(), |k| format!("{k:?}").to_lowercase()),
        model.as_deref().unwrap_or("default"),
        effort.as_deref().unwrap_or("default"),
    );
}

/// One step of driving Claude's model picker, read from the current screen only.
pub(crate) fn picker_step(
    screen: &str,
    model: Option<&str>,
    effort: Option<&str>,
    confirming: bool,
) -> Step {
    let lines: Vec<&str> = screen.lines().collect();
    let top = lines.iter().rposition(|l| l.trim() == "Select model");
    let target = model
        .map_or("default", |m| {
            CLAUDE_MODELS
                .iter()
                .find(|(a, _)| *a == m)
                .map_or(m, |(_, label)| label)
        })
        .to_lowercase();
    if confirming {
        // Claude says e.g. "Set model to Sonnet 5.5 for this session only with low effort".
        // Ticket 991 B2 (seen with Claude 2.1.325 at 62 columns): a narrow terminal wraps that line, or cuts it to
        // "Model set to sonnet (claude-sonnet-5-5) for this session…". The screen is read as one run of words; the
        // sentence is what stands between its start and "for this session". Without a start in view, only the whole
        // ending counts (a permission option also says "for this session").
        let flat = flat_words(&lines);
        let confirmed = flat.match_indices("for this session").any(|(at, _)| {
            let said: String = {
                let mut tail: Vec<char> = flat[..at].chars().rev().take(100).collect();
                tail.reverse();
                tail.into_iter().collect()
            };
            let start = ["set model to", "model set to"]
                .iter()
                .filter_map(|k| said.rfind(k))
                .max();
            let whole = flat[at..].starts_with("for this session only");
            let said = start.map_or(said.as_str(), |i| &said[i..]);
            (start.is_some() || whole)
                && !said.contains("currently using")
                && (target == "default" || said.contains(&target))
        }) || {
            // Look 11-17 N3 (Claude 2.1.326 at 44 columns, a narrow Terminal pane): the line is cut before "for this
            // session": "Model set to sonnet (claude-sonnet-5-5)…". Its start, the target and the cut, within one line.
            ["model set to ", "set model to "].iter().any(|start| {
                flat.match_indices(start).any(|(at, _)| {
                    let rest = &flat[at + start.len()..];
                    target != "default"
                        && rest.starts_with(&target)
                        && rest
                            .find('\u{2026}')
                            .is_some_and(|cut| cut < 60 && !rest[..cut].contains("currently using"))
                })
            })
        };
        return if top.is_none() && confirmed {
            Step::Done
        } else {
            Step::Wait
        };
    }
    let Some(top) = top else { return Step::Wait };
    let body = &lines[top + 1..];
    let text = flat_words(body); // ticket 991 B2: the key hints wrap in a narrow terminal
    // A block left in view above the input box is not the live picker (which replaces the box), and without the
    // 2.1.310 key hints a block must carry one 2.1.318 picker line: no key goes to a screen that only looks like it.
    if composer(&lines[top..].join("\n"), AgentKind::Claude).is_some()
        || !(text.contains("to set as default")
            || text.contains("switch between claude models")
            || text.contains("to adjust"))
    {
        return Step::Wait;
    }
    if text.contains("type to search") {
        return Step::Keys(b"\x1b[B"); // leave search mode for the list; letters would filter
    }
    // Rows are `❯ 2. Sonnet   description`; only the focused one carries the cursor.
    let rows: Vec<(usize, bool, String)> = body
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let bare = l.trim_start();
            let rest = bare.strip_prefix('❯').unwrap_or(bare).trim_start();
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            let rest = rest[digits..].strip_prefix('.').filter(|_| digits > 0)?;
            let label = rest
                .trim()
                .split("  ")
                .next()?
                .trim_end_matches([' ', '✔', '✓']);
            Some((i, bare.starts_with('❯'), label.to_lowercase()))
        })
        .collect();
    // Ticket 287: Claude 2.1.318 labels rows with versions ("Sonnet 5.5") and lists older ones below ("Sonnet 5"), so
    // an alias names the family and its first row, the newest.
    let is_target = |label: &str| {
        label == target
            || target == "default" && label.starts_with("default")
            || label.split(' ').next() == Some(target.as_str())
    };
    let Some(focused) = rows.iter().position(|(_, f, _)| *f) else {
        return Step::Fail("the picker shows no focused model row");
    };
    let wanted = rows.iter().position(|(_, _, l)| is_target(l));
    if wanted != Some(focused) {
        return match wanted {
            Some(at) if at < focused => Step::Keys(b"\x1b[A"),
            _ => Step::Keys(b"\x1b[B"),
        };
    }
    if let Some(want) = effort {
        // The effort line sits under the list; a row description may say "effort" too.
        let after = rows.last().map_or(0, |(i, _, _)| i + 1);
        let shown = body[after..].iter().find_map(|l| {
            let words: Vec<String> = l.split_whitespace().map(str::to_lowercase).collect();
            let at = words.iter().position(|w| w == "effort")?;
            Some(if at == 0 {
                "unsupported".to_string()
            } else {
                words[at - 1].clone()
            })
        });
        let Some(shown) = shown else {
            return Step::Fail("the picker shows no effort line");
        };
        let order = |e: &str| CLAUDE_EFFORTS.iter().position(|x| *x == e);
        match (order(&shown), order(want)) {
            (Some(a), Some(b)) if a < b => return Step::Keys(b"\x1b[C"),
            (Some(a), Some(b)) if a > b => return Step::Keys(b"\x1b[D"),
            (Some(_), Some(_)) => {}
            _ => return Step::Fail("the picker does not offer that effort for this model"),
        }
    }
    // Claude 2.1.310 draws "s to use this session only" under the list, 2.1.318 draws no key hints; only the
    // confirmation ("... for this session only") proves the key. A hint line that omits `s` is another picker.
    if text.contains("to set as default") && !text.contains("use this session only") {
        return Step::Fail("the picker offers no session-only choice");
    }
    Step::Keys(b"s")
}
impl Sessions {
    pub(super) fn switch_model(
        &mut self,
        id: &str,
        model: Option<String>,
        effort: Option<String>,
    ) -> Response {
        let meta = self.entry(id)?.meta.clone();
        // Ticket 358: an ACP agent's model is its own config option, set over ACP and only to a value it reported.
        // Ticket 994: its thinking level likewise, only to a value it listed (any other keeps the old refusal).
        if meta.kind == AgentKind::Acp {
            if model.is_none() && effort.is_none() {
                return Err("pick one of the agent's models".into());
            }
            let acp = self.entry(id)?.acp.as_mut().ok_or("agent is not running")?;
            acp.switch(&meta, model, effort)?;
            return Ok(Reply::Ack);
        }
        // Ticket 358: Claude's own picker, which this switch walks, lists only its models, so a custom id starts a
        // new Claude session and never switches one; Codex restarts with `--model` and can take it.
        if meta.kind == AgentKind::Codex {
            self.check_stored_model(meta.kind, model.as_deref(), effort.as_deref())?;
        } else {
            check_model(meta.kind, model.as_deref(), effort.as_deref())?;
        }
        let (snapshot, screen) = self.switch_checks(id, meta.kind)?; // W35: claude_modes.rs
        if meta.kind == AgentKind::Codex {
            let args = carried_codex_args(self.entry(id)?.args.as_deref())?;
            return self.restart_resumed(id, args, model, effort, None); // claude_modes.rs, shared with fast mode
        }
        if !crate::delivery::ready(meta.kind, &snapshot.attention, &snapshot.pending, &screen) {
            return Err("Claude is not at its prompt".into());
        }
        let content = format!(
            "model picker: {} · effort {} · this session only",
            model.as_deref().unwrap_or("default"),
            effort.as_deref().unwrap_or("unchanged")
        );
        let send = self.begin_send("user", id, content, vec![], false, "attempting")?;
        if let Err(error) = self.live(id)?.write(PICKER_OPEN) {
            self.finish_send(id, &send.id, "failed")?;
            return Err(error);
        }
        let now = std::time::Instant::now();
        let entry = self.entry(id)?;
        let seen = entry.observer.output_offset;
        entry.switch = Some(Switch {
            send: send.id.clone(),
            model,
            effort,
            confirming: false,
            keys: 1,
            sent: now,
            seen,
            last: seen,
            quiet: now,
            before: screen.clone(),
        });
        Ok(Reply::Delivery { send })
    }
    /// CHAT-MODELIST: whether other input to this session is held (see `send_inner`).
    /// Held while a walk runs, and after a walk that failed with the footer in (or last seen in) Skip permissions the
    /// owner never confirmed: until a mode other than that is positively read (`settle_walks`), so neither a refused
    /// pick nor a footer notice over the mode row lifts it. A turn must not start in a mode the owner only passed through.
    pub(super) fn walk_hold(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            e.walk.is_some()
                || e.skip_hold.is_some() && !e.skip_chosen && e.meta.state == SessionState::Running
        })
    }
    /// CHAT-MODELIST (ticket 285): starts the walk to `mode`. Only the owner's click gets here (`check_agent` refuses a
    /// session caller, the server's remote list a forwarded one); `sender` is checked again because Skip permissions
    /// turns off every permission prompt. The first press is the same logged `shift+tab` send the chip used, so every
    /// refusal of that path (a dialog on screen, not at the composer, busy, queue blocked) holds here too.
    /// Ticket 362: the stored Claude choice is Ask, whose sessions leave Bypass permissions out of the cycle.
    pub(super) fn claude_asks(&self) -> bool {
        let stored = self
            .settings
            .features
            .get(crate::agent_permission::FEATURE_KEY);
        crate::agent_permission::stored_choice(stored, "claude") == PermissionChoice::Ask
    }
    pub(super) fn set_mode(&mut self, sender: &str, id: &str, mode: &str) -> Response {
        if sender != "user" {
            return Err("operation not granted".into());
        }
        if !MODES.contains(&mode) {
            return Err(format!("unknown mode: {mode}"));
        }
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        if meta.kind != AgentKind::Claude {
            return Err("only Claude sessions have a live permission-mode cycle".into());
        }
        if self.entry(id)?.walk.is_some() {
            return Err("a mode change is already running for this session".into());
        }
        if self.entry(id)?.switch.is_some() {
            return Err("model switch in progress".into());
        }
        self.current(id)?;
        let screen = self.entry(id)?.observer.screen.text();
        let Some(current) = permission_mode(&screen, meta.kind) else {
            return Err("agent is not at its composer; mode not changed".into());
        };
        // Ticket 362: Claude's own settings say no: refused before any key, so the walk never goes looking for it. Read
        // again here because a restored session has no launch to have read them, off this lock's patience (a folder
        // that does not answer counts as no setting; the walk then stops with its usual reason).
        if mode == BYPASS && current != BYPASS {
            let (config, cwd) = (meta.config_dir.clone(), meta.cwd.clone());
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(crate::agent_permission::claude_limits(
                    config.as_deref(),
                    &cwd,
                ));
            });
            let limits = rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .unwrap_or_default();
            self.entry(id)?.bypass_disabled = limits.bypass_disabled;
            if limits.bypass_disabled {
                return Err("bypass permissions is turned off by Claude's settings (disableBypassPermissionsMode)".into());
            }
        }
        if mode == BYPASS {
            let asks = self.claude_asks();
            let what = match skip_state(self.entry(id)?, Some(&current), asks) {
                SkipPermissions::Unavailable => "start a new session to use it",
                SkipPermissions::NeedsSetting => {
                    "change the permission setting and start a new session"
                }
                _ => "",
            };
            if !what.is_empty() {
                return Err(format!(
                    "skip permissions is not in this session's mode cycle: {what}"
                ));
            }
        }
        if current == mode {
            let entry = self.entry(id)?;
            entry.skip_chosen |= mode == BYPASS; // the owner's pick, with the footer already there
            entry.walk_error = None;
            return Ok(Reply::Ack);
        }
        let reply = self.send_inner(
            "user",
            id,
            String::new(),
            vec!["shift+tab".into()],
            false,
            true,
        )?;
        // The pick counts once the walk has reached Bypass permissions (`advance_walks`), not when it starts. The last
        // failure shows until here: a pick refused before its first press leaves it (and the hold) as they were.
        let entry = self.entry(id)?;
        entry.walk_error = None;
        entry.walk = Some(Walk {
            target: mode.into(),
            chosen: mode == BYPASS,
            failure: None,
            start: current.clone(),
            before: current,
            sent: std::time::Instant::now(),
            keys: 1,
        });
        Ok(reply)
    }
    /// CHAT-MODELIST: one verified step per tick: the footer shows the target (done), moved to another mode (press
    /// again), came back to where it started (the cycle has no target), or did not move for `WALK_WAIT` (stop). Never
    /// a key from a stale screen, and never a key while no composer shows.
    pub(super) fn advance_walks(&mut self) {
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.walk.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let Some(entry) = self.entries.get_mut(&id) else {
                continue;
            };
            let walk = entry.walk.as_ref().unwrap();
            let seen = permission_mode(&entry.observer.screen.text(), entry.meta.kind);
            let outcome: Result<bool, String> = if !entry.agent_live() {
                Err("the session ended".into())
            } else if entry.observer.behind {
                if walk.sent.elapsed() > WALK_BEHIND {
                    Err("the terminal output is behind: the footer cannot be trusted; mode not confirmed".into())
                } else {
                    continue;
                }
            } else {
                match seen.as_deref() {
                    Some(m) if m == walk.target => Ok(true),
                    Some(m) if m != walk.before && m == walk.start => {
                        Err(format!("this session's mode cycle has no {}", walk.target))
                    }
                    Some(m) if m != walk.before && walk.keys >= WALK_KEYS => {
                        Err(format!("did not reach {} in a full cycle", walk.target))
                    }
                    Some(m) if m != walk.before => Ok(false),
                    _ if walk.sent.elapsed() > WALK_WAIT => {
                        Err("the footer did not change; mode not changed".into())
                    }
                    _ => continue,
                }
            };
            match outcome {
                Ok(true) => finish_walk(entry),
                Ok(false) => {
                    let m = seen.clone().unwrap();
                    match self.send_inner(
                        "user",
                        &id,
                        String::new(),
                        vec!["shift+tab".into()],
                        false,
                        true,
                    ) {
                        Ok(_) => {
                            let walk = self.entry(&id).unwrap().walk.as_mut().unwrap();
                            walk.before = m;
                            walk.sent = std::time::Instant::now();
                            walk.keys += 1;
                        }
                        Err(error) => self.end_walk(&id, seen, error),
                    }
                }
                Err(error) => self.end_walk(&id, seen, error),
            }
        }
    }
    /// A walk is over the moment the footer the observer has read shows its target: ending it here (every request
    /// observes first) means a pick right after the footer reached the target is not refused as busy, and the confirm
    /// that came with it is already kept.
    pub(super) fn settle_walks(&mut self) {
        for entry in self.entries.values_mut() {
            let reached = entry.walk.as_ref().is_some_and(|w| {
                entry.agent_live()
                    && !entry.observer.behind
                    && permission_mode(&entry.observer.screen.text(), entry.meta.kind).as_deref()
                        == Some(w.target.as_str())
            });
            if reached {
                finish_walk(entry);
            }
            // The hold after a failed walk: lifted by a positive read of another mode (or the owner's confirm, or the
            // session ending); an unreadable footer (or a stale screen: the observer is behind) keeps it, up to
            // `WALK_BEHIND`.
            if entry.skip_hold.is_some() {
                let seen = (!entry.observer.behind)
                    .then(|| permission_mode(&entry.observer.screen.text(), entry.meta.kind))
                    .flatten();
                let over = !entry.agent_live()
                    || entry.skip_chosen
                    || seen.as_deref().is_some_and(|m| m != BYPASS);
                if over {
                    entry.skip_hold = None;
                } else if let Some(hold) = entry.skip_hold.as_mut() {
                    if seen.is_some() {
                        hold.unreadable_since = None;
                    } else {
                        let since = *hold
                            .unreadable_since
                            .get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() > WALK_BEHIND {
                            entry.skip_hold = None;
                        }
                    }
                }
            }
        }
    }
    /// A walk that stopped short. Crossing Skip permissions on the way to another mode must not leave the session
    /// there unconfirmed: a walk back to the start mode follows (its first press is the walk's own key, never held back
    /// by the walk it ends; the hold stays until the footer has left Skip permissions). If even that press fails, the
    /// reason says where the session is left.
    fn end_walk(&mut self, id: &str, seen: Option<String>, error: String) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        let walk = entry.walk.take().unwrap();
        let in_skip = seen.as_deref() == Some(BYPASS) && !entry.skip_chosen;
        // Last read in Skip permissions and now unreadable: it may still be there. Hold either way.
        let maybe_in_skip =
            in_skip || (seen.is_none() && walk.before == BYPASS && !entry.skip_chosen);
        if maybe_in_skip {
            entry.skip_hold = Some(SkipHold {
                unreadable_since: None,
            });
        }
        let (target, mut reason) = match walk.failure.clone() {
            Some((first, why)) => (first, format!("{why}; {error}")),
            None => (walk.target.clone(), error),
        };
        if in_skip {
            if walk.failure.is_none() && walk.start != BYPASS {
                match self.send_inner(
                    "user",
                    id,
                    String::new(),
                    vec!["shift+tab".into()],
                    false,
                    true,
                ) {
                    Ok(_) => {
                        if let Some(entry) = self.entries.get_mut(id) {
                            entry.walk = Some(Walk {
                                target: walk.start.clone(),
                                start: BYPASS.into(),
                                before: BYPASS.into(),
                                chosen: false,
                                failure: Some((target, reason)),
                                sent: std::time::Instant::now(),
                                keys: 1,
                            });
                        }
                        return;
                    }
                    Err(left) => {
                        reason = format!(
                            "{reason}; the session is still in Skip permissions (leaving it failed: {left})"
                        );
                    }
                }
            } else {
                reason = format!("{reason}; the session is still in Skip permissions");
            }
        }
        if let Some(entry) = self.entries.get_mut(id) {
            entry.walk_error = Some(ModeWalk {
                target,
                error: Some(reason),
            });
        }
    }
    pub(super) fn advance_switches(&mut self) -> Result<(), String> {
        let now = std::time::Instant::now();
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.switch.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let entry = self.entry(&id)?;
            let offset = entry.observer.output_offset;
            let ended = !entry.agent_live() || entry.pty.is_none();
            let behind = entry.observer.behind; // v1a-19 r3
            let screen = entry.observer.screen.text();
            let switch = entry.switch.as_mut().unwrap();
            if offset != switch.last {
                (switch.last, switch.quiet) = (offset, now);
            }
            let fresh = offset > switch.seen
                && now - switch.quiet >= SWITCH_SETTLE
                && screen != switch.before;
            let elapsed = now - switch.sent;
            let mut step = if ended {
                Step::Fail("the session ended")
            } else if behind {
                // v1a-19 r3: no key from a stale screen, not even the failure's Esc; the deadline waits too.
                continue;
            } else if !fresh {
                Step::Wait
            } else {
                picker_step(
                    &screen,
                    switch.model.as_deref(),
                    switch.effort.as_deref(),
                    switch.confirming,
                )
            };
            if step == Step::Wait
                && elapsed > std::time::Duration::from_secs(if switch.confirming { 10 } else { 4 })
            {
                step = Step::Fail("the picker did not show what was expected in time");
            }
            if matches!(step, Step::Keys(_)) && switch.keys >= 40 {
                step = Step::Fail("the picker did not reach the choice");
            }
            match step {
                Step::Wait => {}
                Step::Keys(bytes) => {
                    let switch = self.entry(&id)?.switch.as_mut().unwrap();
                    switch.keys += 1;
                    (switch.sent, switch.seen) = (now, offset);
                    switch.before = screen.clone();
                    if bytes == b"s" {
                        switch.confirming = true;
                    }
                    if let Err(error) = self.live(&id)?.write(bytes) {
                        eprintln!("switch write failed: {error}");
                    }
                }
                Step::Done | Step::Fail(_) => {
                    let switch = self.entry(&id)?.switch.take().unwrap();
                    let result = if let Step::Fail(reason) = step {
                        // v1a-22: the key closes the picker or takes back the typed `p`/`s` (meta+p rebound); a dialog
                        // on this tick's screen gets no key and becomes a card, an ended session gets nothing.
                        if ended {
                        } else if let Some(item) = dialog_beside_picker(&screen) {
                            // The send still closes below; a card error must not leave it attempting.
                            if let Err(error) = self.queue.screen(
                                &id,
                                item.kind,
                                item.text,
                                item.choices,
                                queue::now_ms(),
                            ) {
                                eprintln!("switch dialog card failed: {error}");
                            }
                        } else {
                            // Ticket 287: every key the switch can have typed into the box (`p` when meta+p is
                            // rebound, then `s`) is taken back with one Backspace each; otherwise Esc closes the picker.
                            let typed = composer(&screen, AgentKind::Claude)
                                .filter(|t| ["p", "s", "ps"].contains(&t.as_str()));
                            if let Ok(pty) = self.live(&id) {
                                let _ = match typed {
                                    Some(t) => pty.write(&b"\x7f".repeat(t.len())),
                                    None => pty.write(b"\x1b"),
                                };
                            }
                        }
                        format!("failed: {reason}")
                    } else {
                        let entry = self.entry(&id)?;
                        // Default effort leaves Claude's effort alone unless the model changed.
                        if switch.effort.is_some() || entry.meta.model != switch.model {
                            entry.meta.effort = switch.effort.clone();
                        }
                        entry.meta.model = switch.model.clone();
                        "switched".into()
                    };
                    let status = if step == Step::Done {
                        "delivered"
                    } else {
                        "failed"
                    };
                    self.finish_send(&id, &switch.send, status)?;
                    switch_log(
                        &id,
                        Some(AgentKind::Claude),
                        &switch.model,
                        &switch.effort,
                        &result,
                    );
                }
            }
        }
        Ok(())
    }
}

/// A walk reached its target: it ends, its Skip confirm is kept, and a walk back from a failure says so.
fn finish_walk(entry: &mut Entry) {
    let Some(walk) = entry.walk.take() else {
        return;
    };
    entry.skip_chosen |= walk.chosen;
    entry.walk_error = walk.failure.map(|(target, why)| ModeWalk {
        target,
        error: Some(format!("{why}; back in {}", walk.target)),
    });
}
/// CHAT-MODELIST: Claude puts `bypass permissions` into its Shift+Tab cycle only for a session launched with
/// `--allow-dangerously-skip-permissions` (or in it already, `--dangerously-skip-permissions`). `current` is the footer.
pub(super) fn skip_state(entry: &Entry, current: Option<&str>, asks: bool) -> SkipPermissions {
    // A resumed or restored session has no launch args (`None`): its cycle may hold Skip permissions, so it is offered
    // and the walk finds out from the footer, one key at a time (it stops with a reason when the cycle has none).
    let lists = |args: &[String]| args.iter().any(|a| a == ALLOW_SKIP || a == START_IN_SKIP);
    let launched = entry.args.as_deref().is_none_or(lists) || lists(&entry.permission);
    if current == Some(BYPASS) {
        SkipPermissions::Available
    } else if entry.bypass_disabled {
        SkipPermissions::Disabled
    } else if launched {
        SkipPermissions::Available
    } else if asks {
        SkipPermissions::NeedsSetting
    } else {
        SkipPermissions::Unavailable
    }
}
