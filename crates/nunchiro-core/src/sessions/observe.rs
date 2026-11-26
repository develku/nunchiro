//! The tick's reads: each session's screen and transcript into state, events, titles and the board.
use super::*;
impl Sessions {
    /// Ticket 573 slice 2: the state changes since the last tick, into the event log.
    pub(super) fn observe_events(&mut self) {
        let rows = self
            .entries
            .values()
            // A closed row stays listed (its view, its Undo); for the log it has ended.
            .filter(|e| e.meta.state != SessionState::Closed)
            .map(|e| {
                let live = e.meta.state == SessionState::Running && !e.agent_ended;
                let asks = if live {
                    self.queue.items_of(&e.meta.id)
                } else {
                    vec![]
                };
                crate::events::Row {
                    id: e.meta.id.clone(),
                    project: e.meta.project.clone(),
                    label: e.meta.label.clone(),
                    state: crate::events::state(
                        e.meta.state,
                        e.agent_ended,
                        live && self.queue.attention(&e.meta.id).working,
                        asks.iter().map(|i| &i.kind),
                    ),
                }
            })
            .collect();
        // Ticket 993: a schedule's last result follows its session, only on a change of that session's state.
        for (id, before, state) in self.events.observe(rows) {
            if !self.schedules.follow(&id, before, state) {
                continue;
            }
            // Look 11-17 v8 (Home S2-B): a run that failed after its start is a failed run too: the same card.
            for e in self.schedules.list().unwrap_or_default() {
                if let Some(last) = &e.last
                    && last.session.as_deref() == Some(id.as_str())
                    && last.result == Some(crate::schedule::Outcome::Failed)
                {
                    self.failed_run_card(&e.id, last.reason.as_deref().unwrap_or_default());
                }
            }
            self.schedules_changed();
        }
    }
    pub(super) fn observe(&mut self) -> Result<(), String> {
        /// The session's artifact folder as Claude was given it, when it holds nothing Claude would load from it
        /// (settings, skills, memory files, a repository): an agent can write there, so a folder that holds one of
        /// these is the user's to judge.
        fn own_artifacts(home: &Path, meta: &crate::api::Session) -> Option<PathBuf> {
            let id = meta.artifacts.as_deref().unwrap_or(&meta.id);
            unloaded(fs::canonicalize(home.join("artifacts").join(id)).ok()?)
        }
        /// Look 11-17 C7: the Home folder the core made for Home teammates, when the session runs in it and it holds
        /// nothing Claude would load: Claude's folder-trust question about it is the core's to answer.
        fn own_home(home: &Path, meta: &crate::api::Session) -> Option<PathBuf> {
            let folder = crate::team::Team::open(home).home();
            (fs::canonicalize(&meta.cwd).ok()? == folder)
                .then_some(folder)
                .and_then(unloaded)
        }
        fn unloaded(folder: PathBuf) -> Option<PathBuf> {
            [
                ".claude",
                ".git",
                ".mcp.json",
                "CLAUDE.md",
                "CLAUDE.local.md",
            ]
            .iter()
            .all(|name| fs::symlink_metadata(folder.join(name)).is_err())
            .then_some(folder)
        }
        // v1b-15. S9 r3: observed by the `refresh` that every call of this one follows, not twice in a row (the board
        // key alone is two stats and a hash of every row); a row this pass moves is observed at the next refresh.
        let now = queue::now_ms();
        let mut ran_changed = false;
        for (id, entry) in &mut self.entries {
            if entry.meta.state != SessionState::Running {
                continue;
            }
            let mut press: Option<&'static [u8]> = None;
            // v1a-19: at most OBSERVE_BYTES per pass.
            if let Some(pty) = &entry.pty
                && let Reply::Output {
                    data,
                    start,
                    end,
                    truncated,
                } = pty.read_at_most(entry.observer.output_offset, OBSERVE_BYTES)?
            {
                entry.observer.behind = start + (data.len() as u64) < end; // v1a-19 r2
                // w10 item 12: a start question the core answers is read again with no new output.
                if data.is_empty() && !std::mem::take(&mut entry.observer.recheck) {
                    continue;
                }
                if truncated {
                    entry.observer.screen.reset();
                }
                entry.observer.screen.feed(&data);
                // Ticket 286: a shell left after its agent quit is fed for the screen gates only: no activity, no
                // decisions read from what the shell prints.
                if entry.agent_ended {
                    entry.observer.output_offset = start + data.len() as u64;
                    continue;
                }
                // Built once for `detect_in` and the limit mark; a shell session has neither reader.
                let text = if entry.meta.kind == AgentKind::Shell {
                    String::new()
                } else {
                    entry.observer.screen.text()
                };
                // Output is activity; a re-read of a still screen is not (the re-read of a working session waits for
                // a still second, and a turn that draws nothing still goes stale).
                if !data.is_empty() {
                    self.queue.activity(id, now)?;
                }
                // Claude 2.1.326 asks about each `--add-dir` folder at start, the cursor on "No, exit". The one folder
                // the core adds is the session's own artifact folder: the core made it, and for exactly that folder,
                // while it holds nothing Claude would load, the core answers yes itself (Down, then Enter once the
                // screen shows the cursor on Yes). Only during the start, once, and on a screen that is current: after
                // Claude's input box showed, the screen can hold an agent's own words. Any other such question stays a
                // dialog for the user.
                let at = std::time::Instant::now();
                // Every pass, also those that read no dialog below: once the box showed, start dialogs are over.
                entry.observer.screen.note_box(&text);
                if waiting::screen::past_start(&text) {
                    entry.observer.own_folder = None;
                    entry.observer.before_box = false;
                }
                // w25-m: a question cut off by a short window takes only "No": no key, a card at once (`detect_in`).
                let starting = entry.observer.own_folder.is_some()
                    && !entry.observer.behind
                    && !waiting::screen::cut_off(&text);
                let trusting = starting
                    && text.contains("Accessing workspace:")
                    && !text.contains("Adding a new directory");
                let adding = starting && text.contains("Adding a new directory") || trusting;
                let folder = if trusting {
                    own_home(&self.home, &entry.meta)
                } else {
                    adding
                        .then(|| own_artifacts(&self.home, &entry.meta))
                        .flatten()
                };
                let own = folder.as_ref().and_then(|folder| {
                    if trusting {
                        waiting::screen::trust_question(&text, folder)
                    } else {
                        waiting::screen::add_dir_question(&text, folder)
                    }
                });
                // The question while it is still being drawn, or about the session's own folder: no card and no
                // "blocked (question)" line to the lead. Each new seat showed the question for a moment, and the
                // lead spent a turn on every one of those lines (real run 11-17). A question that names another
                // folder is a dialog as before.
                let mine = adding
                    && folder.as_ref().is_some_and(|folder| {
                        if trusting {
                            waiting::screen::trust_folder(&text)
                        } else {
                            waiting::screen::add_dir_folder(&text)
                        }
                        .is_none_or(|shown| shown == folder.to_string_lossy())
                    });
                // v1a-10: Claude's own model picker, opened by a switch, is not a decision to queue.
                let mut asking = false;
                // w10 item 12: a question the core could not answer in `OWN_GIVE_UP` (a key Claude did not take, rows it
                // cannot read) is the user's: no more keys, and it shows as a card, never an idle row.
                // Look 11-17 v5 item 10: the clock runs only while a question about the session's own folder is on the
                // screen. The user's own folder-trust question can wait for minutes; the artifact folder's question
                // after it is still the core's.
                let own = if own.is_some() || mine {
                    let since = *entry.observer.own_folder_since.get_or_insert(at);
                    if at.duration_since(since) > waiting::OWN_GIVE_UP {
                        entry.observer.own_folder = None;
                        entry.observer.own_folder_key = None;
                        entry.observer.own_folder_since = None;
                        None
                    } else {
                        own
                    }
                } else {
                    entry.observer.own_folder_since = None;
                    own
                };
                let mine = mine && entry.observer.own_folder.is_some();
                // Look 11-17 v5 item 1 (rule a): while a model switch runs only its own picker is hidden; any other
                // question on the screen (a start question the switch is waiting behind) is a card.
                let picker =
                    entry.switch.is_some() && text.lines().any(|l| l.trim() == "Select model");
                if let Some(on_yes) = own {
                    // Enter only after the core's own Down: a mark the screen model kept from the dialog before
                    // (the folder-trust question, answered on its Yes row) read as "the cursor is on Yes" while
                    // Claude's cursor was on "No, exit", and the Enter ended Claude (real run 11-17, one lead of five).
                    if on_yes && entry.observer.own_folder_key.is_some() {
                        press = Some(b"\r");
                        // The trust question comes first; the artifact folder's question may follow it.
                        if !trusting {
                            entry.observer.own_folder = None;
                        }
                        entry.observer.own_folder_key = None;
                        entry.observer.own_folder_since = None;
                    } else if on_yes {
                        // Not the core's doing: no key. It shows as a dialog once the start window has passed.
                    } else if entry
                        .observer
                        .own_folder_key
                        // 3 s, not 1: Down is a relative key. A second Down sent while Claude's redraw of the first
                        // is only late moves the cursor back to "No, exit", and the Enter that follows ends Claude.
                        .is_none_or(|t| at.duration_since(t) > std::time::Duration::from_secs(3))
                    {
                        press = Some(b"\x1b[B");
                        entry.observer.own_folder_key = Some(at);
                    }
                    self.queue.clear_screen(id)?;
                } else if mine || picker {
                    self.queue.clear_screen(id)?;
                } else if let Some(item) = entry.observer.screen.detect_in(entry.meta.kind, &text) {
                    asking = true;
                    self.queue
                        .screen(id, item.kind, item.text, item.choices, now)?;
                } else if entry.observer.unredrawn.is_some()
                    && (!entry.observer.screen.drawn() || entry.observer.screen.blank())
                {
                    // A screen a resize blanked and nothing has drawn on since says nothing about the question: the
                    // card stays until the agent redraws or `restore_undrawn` gives the screen back. Lane w96: so does
                    // a redraw read between its clear and its text (two writes; the card went and came back re-keyed).
                } else if entry.observer.before_box
                    && waiting::screen::start_question_left(&text)
                    && entry
                        .observer
                        .quiet_since
                        .is_none_or(|t| t.elapsed() < waiting::startup_quiet())
                {
                    // w25-s: a start question still on the screen that the core cannot read (rows a narrow window
                    // split) has not been answered: its card stays. A screen without it clears the card as before;
                    // `starting`'s quiet valve ends this too, so a box the core misses cannot hold the first message.
                } else {
                    self.queue.clear_screen(id)?;
                }
                // Look 11-17 v3 P1: a question on the screen restarts the quiet time that ends a start.
                asking |= own.is_some() || mine;
                entry.observer.silent_since = None; // it drew: the quiet time rules from here
                if asking {
                    entry.observer.quiet_since = None;
                } else if entry.observer.quiet_since.is_none() {
                    entry.observer.quiet_since = Some(at);
                }
                if entry.observer.interrupted.is_some_and(|until| at >= until) {
                    entry.observer.interrupted = None;
                }
                if entry.observer.interrupted.is_none()
                    || entry.observer.behind
                    || !interrupted_at_prompt(&text)
                {
                    entry.observer.at_box = None;
                } else if at.duration_since(*entry.observer.at_box.get_or_insert(at))
                    >= std::time::Duration::from_millis(REREAD_STILL_MS)
                {
                    entry.observer.interrupted = None;
                    entry.observer.at_box = None;
                    self.queue
                        .observe(id, "Interrupted", &serde_json::json!({}), "screen", now)?;
                }
                // W35: ultracode as Claude last answered `/effort ultracode` (claude_modes.rs).
                ran_changed |= entry.meta.kind == AgentKind::Claude
                    && claude_modes::ultracode_read(&mut entry.meta.modes, &text);
                // Ticket 1010: fast mode's pause and refusal as Claude's footer says them.
                ran_changed |= entry.meta.kind == AgentKind::Claude
                    && claude_modes::fast_read(
                        &mut entry.meta.modes,
                        &mut entry.observer.fast_notice,
                        &text,
                        now as i64 / 1000,
                    );
                // Look 11-17 N2: the mode the session runs in, kept for a resume.
                if let Some(mode) = permission_mode(&text, entry.meta.kind) {
                    entry.observer.footer_seen = true;
                    if entry.meta.ran_mode.as_ref() != Some(&mode) {
                        entry.meta.ran_mode = Some(mode);
                        ran_changed = true;
                    }
                }
                // Ticket 1100: the canary watches the first session on a new agent version (flags only).
                if let Some(version) = entry.meta.agent_version.as_deref()
                    && crate::agent_canary::watching(&self.home, entry.meta.kind, Some(version))
                    && crate::agent_canary::observed(
                        &self.home,
                        entry.meta.kind,
                        version,
                        id,
                        crate::agent_canary::Pass {
                            box_read: composer(&text, entry.meta.kind).is_some(),
                            footer_read: entry.observer.footer_seen,
                            dialog: asking,
                        },
                    )
                {
                    crate::agent_canary::fresh_start(&self.home, entry.meta.kind, version);
                }
                // V2-2c: the limit mark reads the same screen and writes only its in-memory mark.
                crate::usage::observe_limit(
                    &self.home,
                    id,
                    entry.meta.kind,
                    entry.meta.config_dir.as_deref(),
                    &text,
                    now as i64 / 1000,
                    &crate::usage::local_offset,
                );
                entry.observer.output_offset = start + data.len() as u64; // v1a-19
            }
            if let (Some(keys), Some(pty)) = (press, entry.pty.as_mut())
                && let Err(e) = pty.write(keys)
            {
                eprintln!("session {id}: the artifact folder question was not answered: {e}");
            }
        }
        if ran_changed {
            self.save()?;
        }
        self.settle_walks(); // CHAT-MODELIST r3
        let live = self
            .entries
            .iter()
            .filter(|(_, e)| e.agent_live())
            .map(|(id, _)| id.clone())
            .collect();
        self.queue.tick(
            now,
            self.settings
                .stale_after_ms
                .unwrap_or(queue::DEFAULT_STALE_MS),
            &live,
        )
    }
    pub(crate) fn transcript_jobs(&mut self) -> Vec<waiting::TranscriptJob> {
        let now = std::time::Instant::now();
        self.entries
            .values_mut()
            .filter_map(|entry| {
                if !entry.agent_live()
                    || entry.meta.kind == AgentKind::Shell
                    || (entry.observer.transcript.is_none() && !entry.observer.search_due(now))
                {
                    return None;
                }
                let (key, offset) = self.queue.transcript_cursor(&entry.meta.id);
                // S9 r3: a followed transcript read to its end, same file, same size: nothing to read, so no job (a
                // row clone, an open and a read per live session every 50 ms). `read_batch` keys a file the same way.
                if let Some(path) = &entry.observer.transcript
                    && let Ok(m) = fs::symlink_metadata(path)
                {
                    use std::os::unix::fs::MetadataExt;
                    if m.len() == offset
                        && key == format!("{}:{}:{}", path.display(), m.dev(), m.ino())
                    {
                        return None;
                    }
                }
                Some(waiting::TranscriptJob {
                    session: entry.meta.clone(),
                    path: entry.observer.transcript.clone(),
                    key,
                    offset,
                    discarding: self.queue.transcript_discarding(&entry.meta.id),
                })
            })
            .collect()
    }
    pub(crate) fn apply_transcript(
        &mut self,
        job: waiting::TranscriptJob,
        path: Option<PathBuf>,
        result: Result<Option<waiting::transcript::Batch>, String>,
    ) -> Result<(), String> {
        // v1b-15
        self.observe_board();
        let Some(entry) = self.entries.get_mut(&job.session.id) else {
            return Ok(());
        };
        // A close/resume, new hook path or newer cursor invalidates this read plan.
        if !entry.agent_live()
            || entry.meta.agent_session_id != job.session.agent_session_id
            || entry.observer.transcript != job.path
            || self.queue.transcript_cursor(&entry.meta.id) != (job.key, job.offset)
            || self.queue.transcript_discarding(&entry.meta.id) != job.discarding
        {
            return Ok(());
        }
        entry.observer.transcript = path;
        match result {
            Ok(Some(batch)) => {
                // Look 11-17 N6: Codex sends no prompt hook, so an unnamed Codex session takes its title from its
                // transcript's first own message (after Codex's context blocks), as a Claude one does from its hook.
                // Named, it keeps that name across a resume instead of a window number ("New Codex session 2").
                // Ticket 1042: Claude Code titles a session itself (its small fast model, after the first prompt) and
                // writes an `ai-title` record to the transcript; read here, it costs no call. It replaces the
                // first-message name but never a hand-set one, and without it (no such record) that name stays.
                let title = match entry.meta.kind {
                    AgentKind::Codex if entry.meta.label.is_empty() => codex_title(&batch.records),
                    AgentKind::Claude if entry.meta.label.is_empty() || entry.meta.auto_label => {
                        claude_ai_title(&batch.records).filter(|t| *t != entry.meta.label)
                    }
                    _ => None,
                };
                if !entry.meta.side_chat
                    && let Some(title) = title
                {
                    entry.meta.label = title;
                    entry.meta.auto_label = true; // ticket 1017
                    self.title_names_branch(&job.session.id);
                    self.save()?;
                }
                let entry = self
                    .entries
                    .get_mut(&job.session.id)
                    .ok_or("session not found")?;
                self.queue
                    .transcript_batch(&entry.meta.id, batch, queue::now_ms())?;
                self.queue.observer_error(&entry.meta.id, None)?;
            }
            Ok(None) => {}
            Err(error) => self.queue.observer_error(&entry.meta.id, Some(error))?,
        }
        Ok(())
    }
    // v1b-15
    pub(super) fn observe_board(&mut self) {
        // S9: the tick reads twice per 50 ms. With no row moved and no board file changed, the board is observed once
        // per BOARD_IDLE: its integration sources are read no faster than its decisions refresh anyway.
        let key = self.board_key();
        if self
            .board_observed
            .is_some_and(|(k, at)| k == key && at.elapsed() < BOARD_IDLE)
        {
            return;
        }
        self.board_observed = Some((key, std::time::Instant::now()));
        // Rows are built again only when what the board reads of them moved.
        let mut cached = self.board_rows.take().filter(|(k, _)| *k == key);
        let error = crate::board::observe(&self.home, || {
            let rows = cached.get_or_insert_with(|| {
                let rows = self
                    .board_entries()
                    .map(|e| {
                        let mut row = self.snapshot_session(&e.meta);
                        // The board never reads these; the cache keeps rows cheap to hand out.
                        (row.send_log, row.send_queue, row.pending) = (vec![], vec![], vec![]);
                        row
                    })
                    .collect();
                (key, rows)
            });
            rows.1.clone()
        })
        .err();
        self.board_rows = cached;
        if error != self.board_error {
            if let Some(error) = &error {
                eprintln!("board observation: {error}");
            } else {
                eprintln!("board observation recovered");
            }
            self.board_error = error;
        }
    }
    /// V2-6d: the closing row's drags hold until the close is final, so the board reads it too.
    fn board_entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries
            .values()
            .chain(self.closing.as_ref().map(|c| &c.entry))
    }
    /// S9: a hash of what the board reads: board.json and board.toml as stamped (any edit reads at once), and of each
    /// row (`board::session_state`, `manual_card`, `release_drags`, `reconcile_sessions`) its id, label, project,
    /// lifecycle, agent ended, and the queue's attention for it; and its parent, which `board::rights` reads (it gets
    /// fresh rows from `Sessions::board`, never these, but the key stays a superset).
    fn board_key(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        use std::os::unix::fs::MetadataExt;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for file in ["board.json", "board.toml"] {
            fs::symlink_metadata(self.home.join(file))
                .ok()
                .map(|m| {
                    (
                        m.ino(),
                        m.len(),
                        m.mtime(),
                        m.mtime_nsec(),
                        m.ctime(),
                        m.ctime_nsec(),
                    )
                })
                .hash(&mut h);
        }
        // S9 r3: a changed integration source moves the key too, so the idle board clock never delays it.
        crate::board::sources::key(&self.home).hash(&mut h);
        for e in self.board_entries() {
            let m = &e.meta;
            (
                &m.id,
                &m.label,
                &m.project,
                &m.parent,
                m.state as u8,
                e.agent_ended,
            )
                .hash(&mut h);
            let a = self.queue.attention(&m.id);
            (
                a.completion_seq,
                a.working,
                a.waiting,
                a.failed,
                a.background,
            )
                .hash(&mut h);
        }
        h.finish()
    }
}
/// S9: how often the board is observed while no row it reads moves and no board file changed. r3: 1 s, not 100 ms: what
/// else moves its decisions is an integration source's read, which comes at most every 30 s (`INTERVAL_FLOOR_SECS`).
const BOARD_IDLE: std::time::Duration = std::time::Duration::from_secs(1);
// v1a-10: model and effort switch. The Claude catalog matches web/src/picker/catalog.ts (a web test compares them);
// ticket 1100: the Codex one is Codex's own (`agent_models`), served to the window by `agent_models`.
// v1a-19: the most terminal output one observer pass feeds the waiting screen per session; the rest waits for the
// next pass, so a session that floods its terminal never holds the registry lock for long.
pub(crate) const OBSERVE_BYTES: usize = 64 * 1024;
/// Seventh look (B S2-1): how long a working session's screen has been still before a question on it with no card is
/// read again (`tick`).
pub(super) const REREAD_STILL_MS: u64 = 1000;

/// V2-1b: stops an unattached holder through the frozen stop (only the recorded process) and waits briefly for its
/// agent; for the owner, an agent still running is then ended by the core. `true` once the agent is gone.
/// Peer item 2 (ticket 991): a session title from a prompt's first line, cut to about 40 characters at a word boundary.
/// None for a prompt that is not the user's own words (a slash command, a tagged or handoff message).
/// Look 11-17 N6: a Codex session's title, from the first own message in its transcript records.
pub(super) fn codex_title(records: &[serde_json::Value]) -> Option<String> {
    records.iter().find_map(|record| {
        crate::chat::project(AgentKind::Codex, record)
            .iter()
            .find(|e| e["kind"] == "message" && e["role"] == "user")
            .and_then(|e| e["text"].as_str())
            .and_then(|text| auto_title(crate::chat::after_codex_context(text)))
    })
}
/// Ticket 1042: the last title Claude Code wrote for the session (`{"type":"ai-title","aiTitle":…}`), held to the
/// rules of a first-message title (one line, masked, cut to about 40 characters).
fn claude_ai_title(records: &[serde_json::Value]) -> Option<String> {
    records
        .iter()
        .rev()
        .find(|r| r["type"] == "ai-title")
        .and_then(|r| r["aiTitle"].as_str())
        .and_then(auto_title)
}
pub(super) fn auto_title(prompt: &str) -> Option<String> {
    let first = prompt.lines().map(str::trim).find(|l| !l.is_empty())?;
    // Typed words hold no control character: a line with one (a pasted colour code) gives no title. Stripping it
    // would leave its letters joined to the next word, which hid a token from the mask below (after two Codex looks).
    if first.chars().any(char::is_control) {
        return None;
    }
    // A title is stored and shown wider than the conversation (sessions.json, the tree, events): a key-like value in
    // the first line is masked as in the logs.
    let line = String::from_utf8_lossy(&crate::logs::mask(first.as_bytes())).into_owned();
    let line = line.trim();
    if line.is_empty()
        || line.starts_with(['/', '<', '\u{1b}'])
        || line.starts_with("Handoff from ")
    {
        return None;
    }
    const MAX: usize = 40;
    if line.chars().count() <= MAX {
        return Some(line.to_string());
    }
    let cut: String = line.chars().take(MAX).collect();
    let words = cut
        .rfind(' ')
        .filter(|&i| i >= MAX / 2)
        .map_or(cut.as_str(), |i| &cut[..i]);
    Some(format!(
        "{}…",
        words.trim_end_matches([' ', ',', '.', ':', ';'])
    ))
}
