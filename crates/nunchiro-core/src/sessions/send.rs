//! Sending into a session: the gates, text and keys, steer, widget acts, a resize and the send log.
use super::*;
impl Sessions {
    /// Ticket 1059: the Context widget's Show breakdown types /context through the send queue, as the user's own text
    /// (sender `user`; delivery.rs refuses it to a session token, and `check_agent` refuses the op to one).
    pub(crate) fn context_send(&mut self, id: &str) -> Result<(), String> {
        self.refresh()?;
        self.observe()?;
        let entry = self.entry(id)?;
        if !entry.agent_live() {
            return Err("agent is not running".into());
        }
        let claude = entry.meta.kind == AgentKind::Claude
            && entry.acp.is_none()
            && entry.meta.machine.is_none();
        let typed = entry.input.pending() || !entry.meta.send_queue.is_empty();
        let meta = entry.meta.clone();
        let shown = self.snapshot_session(&meta);
        crate::session_context::may_refresh(
            claude,
            shown.attention.working,
            crate::delivery::blocked(&shown.pending),
            typed,
        )?;
        self.send("user", id, "/context".into(), vec![], true)
            .map(drop)
    }
    pub(super) fn resize_pty(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        // A same-size resize raises no SIGWINCH, so the agent never redraws: blanking the screen would leave it blank.
        let same = self.entry(id)?.pty_size == Some((cols, rows));
        let live = self.live(id)?;
        if same {
            return Ok(());
        }
        if let Err(e) = live.resize(cols, rows) {
            // A holder reply timeout can leave the real size changed or not: unknown, so the next resize is a real one.
            self.entry(id)?.pty_size = None;
            return Err(e);
        }
        let entry = self.entry(id)?;
        entry.pty_size = Some((cols, rows));
        let old = std::mem::replace(
            &mut entry.observer.screen,
            waiting::screen::Screen::new(cols as usize, rows as usize),
        );
        entry.observer.screen.alt = old.alt; // a resize leaves the program in front where it was
        entry.observer.screen.started = old.started().into(); // and a started session past its start dialogs
        // Seventh look (B S1-1): kept for `tick`. A second resize before any redraw keeps the first's screen.
        let last = if old.drawn() {
            Some(old)
        } else {
            entry.observer.unredrawn.take().map(|(screen, _)| screen)
        };
        entry.observer.unredrawn = last.map(|screen| (screen, std::time::Instant::now()));
        Ok(())
    }
    pub(super) fn begin_send(
        &mut self,
        sender: &str,
        id: &str,
        content: String,
        keys: Vec<String>,
        submit: bool,
        status: &str,
    ) -> Result<crate::delivery::Send, String> {
        self.touch_input(id); // ticket 992: a prompt or keys on their way into the box
        let attention = self.queue.attention(id);
        let send = crate::delivery::Send {
            completion_seq: attention.completion_seq,
            last_activity: attention.last_activity,
            id: store::new_id()?,
            sender: sender.into(),
            at: queue::now_ms(),
            content,
            keys,
            submit,
            status: status.into(),
            settle: None, // v1a-15
            // Ticket 76: the flush reads this, not the lasting set (a peer may later forward under the same id).
            remote: (sender != "user").then(|| self.grants.remote.contains(sender)),
        };
        // Ticket 1056: the user's words go ahead of every queued worker wake line, whatever its age.
        let wake_rows = &self.wake_rows;
        let ahead = (sender == "user")
            .then(|| {
                self.entries
                    .get(id)?
                    .meta
                    .send_queue
                    .iter()
                    .position(|s| s.status == "queued" && wake_rows.contains(&s.id))
            })
            .flatten();
        let queue = &mut self.entry(id)?.meta.send_queue;
        let at = ahead.unwrap_or(queue.len());
        queue.insert(at, send.clone());
        if let Err(e) = self.save() {
            self.entry(id)?.meta.send_queue.remove(at);
            return Err(e);
        }
        Ok(send)
    }
    pub(super) fn finish_send(&mut self, id: &str, send: &str, status: &str) -> Result<(), String> {
        self.mark_send(id, send, status)?;
        self.save()
    }

    /// ticket 115, 123 and composer text gate: refuse Stop or composer input unless the screen is current and the window has drawn every pending
    /// request (`seen`, empty when the caller sent none): the tick queues a dialog well before the window renders it.
    /// A hook permission whose dialog the screen has not drawn yet also blocks. An Esc on a dialog the window showed
    /// stays the owner's raw deny.
    pub(super) fn key_gate(&mut self, id: &str, seen: &[String]) -> Result<(), String> {
        let e = self.entry(id)?;
        // Ticket 286: the shell an agent left has no dialog; its closed items guard nothing.
        if e.meta.kind == AgentKind::Shell || e.acp.is_some() || e.agent_ended {
            return Ok(());
        }
        self.current(id)?;
        for p in self.queue.items() {
            if p.session_id != id
                || !matches!(
                    p.kind,
                    queue::Kind::Dialog | queue::Kind::Permission | queue::Kind::Question
                )
            {
                continue;
            }
            if !seen.contains(&p.id) {
                return Err("a request you have not seen is pending: answer it in the Decisions widget, then try again".into());
            }
            if p.kind == queue::Kind::Permission && p.screen_text.is_none() {
                // Ticket 991 B3: a held hook draws no dialog until its card is answered, so "try again" would be wrong.
                // shortcut: reuses the unseen-request words ("answer it first"); give it its own line if people trip.
                if self.queue.hook_live(&p, queue::now_ms()) {
                    return Err("a request you have not seen is pending: answer it in the Decisions widget, then try again".into());
                }
                return Err("a permission request is not on the screen yet: try again".into());
            }
        }
        Ok(())
    }
    /// Look 11-17 v5 item 1: a start question (folder trust, an added folder, any choice prompt the core reads as a
    /// dialog) is on this session's current screen or held as its card. Text typed into one would answer it.
    /// Look 11-17 v11 N11-S2-1: so would an agent's question (Claude's AskUserQuestion): the text went into its "Type
    /// something" row. Look 1117 v13 N13-S2-3: so would a permission prompt (the text rejected Claude's Write): only its
    /// card answers it.
    pub(super) fn dialog_on_screen(&mut self, id: &str) -> Result<bool, String> {
        let entry = self.entry(id)?;
        if entry.acp.is_some() || !matches!(entry.meta.kind, AgentKind::Claude | AgentKind::Codex) {
            return Ok(false);
        }
        self.current(id)?;
        let entry = self.entry(id)?;
        let on_screen = entry
            .observer
            .screen
            .detect(entry.meta.kind)
            .is_some_and(|d| {
                matches!(
                    d.kind,
                    queue::Kind::Dialog | queue::Kind::Question | queue::Kind::Permission
                )
            });
        // The kinds the delivery queue waits behind, so a held send goes in once they are answered.
        Ok(on_screen || crate::delivery::blocked(&self.queue.items_of(id)))
    }
    /// Ticket 1149: a held permission hook ended with no answer. Claude drew its own dialog, which its card pairs with
    /// (`reread_screen`). Codex's only held hook is its outward ask (`nunchiro hook outward --codex`): it has no dialog
    /// and its hook now refuses the call, so its card goes; nothing could answer it.
    pub(crate) fn unanswered_hold(&mut self, id: &str, event: &str) {
        if self
            .entries
            .get(id)
            .is_none_or(|e| e.meta.kind != AgentKind::Codex)
        {
            return;
        }
        for item in self.queue.items_of(id) {
            if item.hook_event_id.as_deref() == Some(event)
                && let Err(error) = self.queue.remove(&item.id)
            {
                eprintln!("unanswered outward card not removed: {error}");
            }
        }
    }
    /// Ticket 990 (fourth real-app look): a hook returned with no answer while the agent's dialog stood on a still
    /// screen. The queue passes over frames while the hook is live, and the screen is fed only on new output, so the
    /// card would stay unpaired until the screen next changes (seen: a question at 62 columns). Read it once more.
    pub(crate) fn reread_screen(&mut self, id: &str) {
        let Some(entry) = self.entries.get(id) else {
            return;
        };
        if entry.meta.state != SessionState::Running
            || entry.agent_ended
            || entry.switch.is_some()
            || entry.meta.kind == AgentKind::Shell
        {
            return;
        }
        let Some(item) = entry.observer.screen.detect(entry.meta.kind) else {
            return;
        };
        if let Err(error) =
            self.queue
                .screen(id, item.kind, item.text, item.choices, queue::now_ms())
        {
            eprintln!("screen reread failed: {error}");
        }
    }
    /// Ticket 286 item 1 (card C-20261106-03): the composer writes to the agent only; once the agent ended its text and
    /// Enter would run in the shell it left. Refused before any write; the terminal's own keys (`composer: false`) pass.
    pub(super) fn composer_live(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.agent_ended {
            return Err(crate::delivery::AGENT_ENDED.into());
        }
        Ok(())
    }
    /// Ticket 372: the limit session `id`'s screen shows while its reset is ahead of `now`, for a live session only.
    pub(super) fn session_limit(&self, id: &str, live: bool, now: i64) -> Option<SessionLimit> {
        let (resets, until, shown) = crate::usage::session_mark(&self.home, id).filter(|_| live)?;
        (shown && until > now).then(|| SessionLimit {
            resets,
            until,
            armed: self.limit_resumes.contains_key(id),
        })
    }
    /// Ticket 372 (owner 11-09): the owner's Resume at <time> on one session (`on`), or its Cancel. Arms only a live session
    /// whose screen shows a limit with a reset still ahead; arming again changes nothing, so one press sends at most once.
    pub(super) fn limit_resume(&mut self, id: &str, on: bool, now: i64) -> Response {
        if !on {
            self.limit_resumes.remove(id);
            return Ok(Reply::Ack);
        }
        let live = self.entry(id)?.agent_live();
        let limit = self
            .session_limit(id, live, now)
            .ok_or("no usage limit with a reset time ahead is on this session's screen")?;
        self.limit_resumes.insert(id.into(), limit.until);
        Ok(Reply::Ack)
    }
    /// Ticket 372: each armed session, once, in the tick after `observe` read its screen. Disarmed without a send when its
    /// agent ended, or its limit line left the screen or changed before the reset (the person moved on). At the reset it
    /// is disarmed first, then sent only with nothing pending (T3 UsageLimitRecoveryWorker.ts:17-33,56-70): the fixed
    /// text alone, through the ordinary delivery path, as the owner.
    pub(super) fn fire_resumes(&mut self, now: i64) {
        let armed: Vec<(String, i64)> = self
            .limit_resumes
            .iter()
            .map(|(id, at)| (id.clone(), *at))
            .collect();
        for (id, at) in armed {
            let live = self.entries.get(&id).is_some_and(|e| e.agent_live());
            // Decided by time first: an ended mark may already be gone, since another session's screen pass in the
            // reset's own tick drops it (`observe_limit`), so the mark is asked about only before the reset.
            if now < at {
                let same = crate::usage::session_mark(&self.home, &id)
                    .is_some_and(|(_, until, shown)| shown && until == at);
                if !live || !same {
                    self.limit_resumes.remove(&id);
                }
                continue;
            }
            self.limit_resumes.remove(&id);
            if !live {
                continue;
            }
            let meta = self.entries[&id].meta.clone();
            if !self.snapshot_session(&meta).pending.is_empty()
                || !meta.send_queue.is_empty()
                || self.pending_enter.contains_key(&id)
            {
                continue;
            }
            match self.send("user", &id, CONTINUE_TEXT.into(), vec![], true) {
                // Q9 pin-J5-3: the observer behind at the reset tick passes; armed again, the next tick sends.
                Err(error) if error == "screen not current, try again" => {
                    self.limit_resumes.insert(id, at);
                }
                Err(error) => eprintln!("resume at reset not sent: {error}"),
                Ok(_) => {}
            }
        }
    }
    // v1a-19 r2: fail closed while the observer is behind the output: the screen and queue may hide a dialog.
    pub(super) fn current(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.observer.behind {
            return Err("screen not current, try again".into());
        }
        Ok(())
    }
    pub(super) fn send(
        &mut self,
        sender: &str,
        id: &str,
        text: String,
        keys: Vec<String>,
        submit: bool,
    ) -> Response {
        let said = (!text.trim().is_empty()).then(|| text.clone());
        // Look v20 S2: words another send typed and nobody submitted are in the box. A prompt pasted behind them had its
        // Enter dropped and went in with the next Enter. Gap rule: `send_inner` queues it (`terminal_text`), after every
        // check a written send takes; it goes once the box is free.
        let reply = self.send_inner(sender, id, text, keys, submit, false)?;
        if let Some(said) = said {
            let row = match &reply {
                Reply::Delivery { send } => Some(send.id.clone()),
                _ => None,
            };
            self.typed(sender, id, &said, crate::room::By::Agent, row);
        }
        Ok(reply)
    }
    /// Ticket 990: the room keeps what one seat typed into another's terminal: a lead's prompt to its worker, a
    /// worker's finish line to its lead (the core types that one for it). Only between two sessions of one room; the
    /// room's own notice (a seat is its own sender there) and the user's prompts are not such lines. Masked as the
    /// logs are, and cut: the terminal has the whole text.
    pub(super) fn typed(
        &mut self,
        sender: &str,
        id: &str,
        text: &str,
        by: crate::room::By,
        send: Option<String>,
    ) {
        if sender == id || !self.entries.contains_key(sender) {
            return;
        }
        let Some(room) = self
            .room_project(id)
            .filter(|r| self.room_project(sender).as_ref() == Some(r))
        else {
            return;
        };
        let line = String::from_utf8_lossy(&crate::logs::mask(text.trim().as_bytes())).into_owned();
        let cut: String = line.chars().take(2000).collect();
        let body = if cut.len() < line.len() {
            cut + "…"
        } else {
            cut
        };
        if let Err(e) = crate::room::Log::open(&self.home, &room).typed(sender, id, body, by, send)
        {
            eprintln!("typed line not kept in the room: {e}");
        }
    }
    /// A line the core itself types into an agent's input box: a worker's finish line, the room's notice. A Claude or
    /// Codex box takes no other session's line while it holds words or keys typed by hand (`delivery::EDITED`). Such a line is
    /// never typed there and never lost: it waits in that session's queue, and `deliver` writes it once the mark is
    /// gone (the user's next Enter there, or the box cleared after a Stop).
    pub(crate) fn send_line(&mut self, sender: &str, id: &str, text: String) -> Response {
        if !self.box_edited(id) {
            return self.send_inner(sender, id, text, vec![], true, false);
        }
        crate::delivery::check_text(AgentKind::Claude, &text)?;
        let send = self.begin_send(sender, id, text, vec![], true, "queued")?;
        Ok(Reply::Delivery { send })
    }
    /// A running Claude or Codex whose input box is marked as edited by hand. Codex's mark ends also when its box reads
    /// empty on a current screen: a Stop (Esc) marks it, and Codex has no box clear after a Stop as Claude has
    /// (`interrupted`), so a lead's wake lines waited for the owner's next Enter.
    pub(crate) fn box_edited(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            hand_edits(e.meta.kind)
                && e.agent_live()
                && e.input.edited()
                && !(e.meta.kind == AgentKind::Codex && !e.observer.behind && self.box_empty(id))
        })
    }
    /// `walking`: this is the mode walk's own Shift+Tab (`set_mode`, `advance_walks`, `end_walk`), the one send a
    /// running walk lets through. Every other send queues behind the walk, as behind a model switch, and a second mode
    /// key is refused: a turn must not start while the footer sits in a mode the owner only passes through.
    pub(super) fn send_inner(
        &mut self,
        sender: &str,
        id: &str,
        text: String,
        keys: Vec<String>,
        submit: bool,
        walking: bool,
    ) -> Response {
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        // Ticket 286: never into the shell an ended agent left; only the user's own terminal keys go there.
        if !self.entry(id)?.agent_live() {
            return Err("agent is not running".into());
        }
        crate::delivery::check_text(meta.kind, &text)?;
        // Ticket 1002 lane 1 (Fable check M5d): agent-sent text never opens a locked seat's bash mode (`!`), a slash
        // command, a memory line or a background run.
        if sender != "user" && meta.home_lock && text.trim_start().starts_with(['!', '/', '#', '&'])
        {
            return Err("text for the chief of staff's seat may not start with ! / # or &".into());
        }
        if keys.len() > 100 {
            return Err("too many keys".into());
        }
        for key in &keys {
            check_key(sender, meta.kind, key)?;
        }
        // CHAT-PERMCHIP r2: a mode change is never queued (it would land after the owner moved on), never mixed with
        // other input, and needs the composer on screen.
        let mode_key = keys.iter().any(|k| k.eq_ignore_ascii_case("shift+tab"));
        let held = !walking && self.walk_hold(id);
        if mode_key {
            if held {
                return Err(MODE_BUSY.into());
            }
            if keys.len() != 1 || !text.is_empty() || submit {
                return Err("shift+tab is sent alone".into());
            }
            if composer(&self.entry(id)?.observer.screen.text(), meta.kind).is_none() {
                return Err("agent is not at its composer; shift+tab not sent".into());
            }
        }
        let snapshot = self.snapshot_session(&meta);
        let interrupt = interrupt_key(&keys);
        if !interrupt {
            self.current(id)?; // v1a-19 r2
        }
        if !interrupt && crate::delivery::blocked(&snapshot.pending) {
            return Err("agent_blocked".into());
        }
        // v1a-15: an interrupt cancels a pending Enter; any other send queues behind it.
        if interrupt && let Some(enter) = self.pending_enter.remove(id) {
            self.finish_send(id, &enter.send, "canceled")?;
        }
        let waiting = self.pending_enter.contains_key(id);
        // Ticket 1121: nor a paste into a box the screen does not read while the core's dropped copy may be in it (the
        // clear would write no Ctrl+U): it waits in the queue for a read box (the delivery walk's guard).
        let unread = submit && !text.is_empty() && self.unread_copy(id);
        // Order is kept: with an earlier row still queued this one goes behind it, and the delivery walk writes both
        // in turn. Written now, it went ahead of a seat's brief queued before the agent drew its box, and the brief
        // then waited behind its turn for ever.
        let behind = !mode_key && meta.send_queue.iter().any(|s| s.status == "queued");
        // Gap rule: nothing is typed behind text in the box, another sender's line waits while the owner types, and
        // his prompt that takes attached messages is joined with them by the delivery walk.
        let gap = !interrupt
            && (self.gap_hold(id, "", sender, submit, &text).is_some()
                || sender == "user"
                    && submit
                    && !text.trim().is_empty()
                    && joinable(&text)
                    && self.has_attached(id));
        let ready = interrupt
            || self.send_ready(&meta.id, &snapshot)?
                && self.delivery_open(id, &snapshot)
                && self.entry(&meta.id)?.switch.is_none() // v1a-10: no typing into the picker
                && !held // CHAT-MODELIST r2: nor into a walk's passing modes
                && !waiting
                && !unread
                && !behind
                && !gap;
        if mode_key && !ready {
            return Err("agent is not at its composer (busy); shift+tab not queued".into());
        }
        let mut send = self.begin_send(
            sender,
            id,
            text,
            keys,
            submit,
            if ready { "attempting" } else { "queued" },
        )?;
        if ready {
            let result = self.write_send(id, &send);
            if interrupt && result.is_ok() {
                self.interrupted(id)?;
            }
            // v1a-15: a pasted submit stays attempting until a later tick writes its Enter.
            if result == Ok(true) {
                return Ok(Reply::Delivery { send });
            }
            send.status = if result.is_ok() {
                "delivered"
            } else {
                "failed"
            }
            .into();
            self.finish_send(id, &send.id, &send.status)?;
            result?;
        }
        Ok(Reply::Delivery { send })
    }
    /// An interrupt key reached a Claude session: for a while its screen may end the turn (see `observe`).
    pub(super) fn interrupted(&mut self, id: &str) -> Result<(), String> {
        let entry = self.entry(id)?;
        if entry.meta.kind == AgentKind::Claude {
            entry.observer.interrupted =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(30));
            entry.observer.clear_box = true;
        }
        Ok(())
    }
    /// Look 11-17 v3 P3: Claude 2.1.326 puts a prompt stopped before any output back into its input box; the next send
    /// was typed after it and both went as one prompt. The first submit after the core's own interrupt clears the box
    /// (Ctrl+U deletes a line, a second one the line break before it) so only the new message goes in.
    /// shortcut: text the user typed into the terminal between the Stop and this send is cleared too; tell it apart
    /// only if that bites.
    pub(super) fn clear_box_first(&mut self, id: &str) -> Result<(), String> {
        // Ticket 1085: an automatic line left typed after its dropped Enter is the core's own words; words typed by hand
        // since then (`edited`) are the owner's, and nothing is cleared.
        let left = self.left_typed.remove(id) && !self.entry(id)?.input.edited();
        let entry = self.entry(id)?;
        if !std::mem::take(&mut entry.observer.clear_box) && !left {
            return Ok(());
        }
        let rows = box_rows(&entry.observer.screen.text());
        if rows == 0 {
            return Ok(());
        }
        self.live(id)?.write(&b"\x15".repeat(2 * rows + 1))?;
        self.copy_gone(id); // Ticket 1094 r5: a dropped copy left in the box is gone
        self.entry(id)?.input = Default::default();
        Ok(())
    }
    /// v25-sendkeys: Ctrl+Enter. Ticket 1056: a working Claude takes the text into its running turn (no Esc). For
    /// other kinds, and for an empty Ctrl+Enter, the turn is interrupted with the Stop key (Esc, through Stop's gate)
    /// and the text is then submitted through the ordinary `send`, so it is written once, after the turn unwinds. A kind with no turn to interrupt refuses with
    /// `NO_INTERRUPT` and keeps the queue; a failed Esc returns before any text is written, so nothing is sent twice.
    pub(super) fn steer_now(
        &mut self,
        sender: &str,
        id: &str,
        text: String,
        seen: &[String],
    ) -> Response {
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        // Ticket 286: never into the shell an ended agent left; only the user's own terminal keys go there.
        if !self.entry(id)?.agent_live() {
            return Err("agent is not running".into());
        }
        // A kind with no interrupt to press keeps the queue and says so: an ACP agent takes keys only to cancel, the
        // delivery path refuses more than one prompt, and a shell has no turn to interrupt.
        if self.entry(id)?.acp.is_some() || meta.kind == AgentKind::Shell {
            return Err(crate::delivery::NO_INTERRUPT.into());
        }
        crate::delivery::check_text(meta.kind, &text)?;
        self.current(id)?;
        // Nothing to interrupt: the queue already goes in now.
        let snapshot = self.snapshot_session(&meta);
        if !snapshot.attention.working {
            if text.is_empty() {
                return Err("nothing to send now".into()); // an interrupt alone has nothing to break
            }
            return self.send(sender, id, text, vec![], true);
        }
        if crate::delivery::blocked(&snapshot.pending) {
            return Err("agent_blocked".into());
        }
        // Ticket 1056: Claude takes text typed while it works and adds it at its next step (the chat's
        // `queued_command`); the turn goes on, as in Claude Code and Orca. No Esc: the tick writes the text once the
        // input box shows (`steers`), never while a request waits. An interrupt alone still presses Esc below.
        if meta.kind == AgentKind::Claude && !text.is_empty() {
            let reply = self.send(sender, id, text, vec![], true)?;
            if let Reply::Delivery { send } = &reply
                && send.status == "queued"
            {
                self.steers.insert(send.id.clone());
            }
            return Ok(reply);
        }
        // Stop's gate: the Esc below answers whatever is focused, so the window must have drawn every request.
        self.key_gate(id, seen)?;
        // The interrupt first, as Claude Code's send-now does; its own Esc refuses when the screen cannot be trusted.
        let esc = self.send(sender, id, String::new(), vec!["esc".into()], false)?;
        if let Reply::Delivery { send } = &esc
            && send.status == "failed"
        {
            return Ok(esc);
        }
        if text.is_empty() {
            return Ok(esc); // an interrupt alone: the agent's own queued input is what goes in now
        }
        // Queued while the turn unwinds, then written once by `flush_delivery` when the agent is at its prompt.
        self.send(sender, id, text, vec![], true)
    }
    // v1b-20: a script widget act (widgets::act) enters the V1A-04 delivery path as `widget:<name>`.
    pub(crate) fn widget_send(
        &mut self,
        name: &str,
        id: &str,
        text: String,
        submit: bool,
        hash: &str,
    ) -> Response {
        // The grant is checked again here, under the lock that also writes: launch preparation can take seconds.
        let sender = format!("widget:{name}");
        self.widget_act_current(&sender, hash)?;
        let reply = self.send(&sender, id, text, vec![], submit)?;
        if let Reply::Delivery { send } = &reply
            && send.status == "queued"
        {
            self.widget_hashes.insert(send.id.clone(), hash.into());
        }
        Ok(reply)
    }
    // v1b-20: an act is sent only while the setting is on and the act grant is the one whose content (`hash`)
    // rendered its text; a re-approval with another template in between refuses it.
    pub(super) fn widget_act_current(&self, sender: &str, hash: &str) -> Result<(), String> {
        let name = sender.strip_prefix("widget:").unwrap_or_default();
        let proof = crate::approval::check(&self.home, name)
            .ok()
            .filter(|p| {
                p.level() == crate::approval::Level::Act
                    // v1b-22: the setting and [act] rule per kind
                    && match p.manifest().kind.as_str() {
                        "web" => self.settings.web_widgets, // v1b-22: a web widget has no [act] table
                        _ => self.settings.script_widgets && p.manifest().act.is_some(),
                    }
            })
            .ok_or("act grant changed before the send; nothing sent")?;
        if proof.hash() != hash {
            return Err(crate::widgets::act::CHANGED.into());
        }
        Ok(())
    }
    /// v1a-15: `Ok(true)` when the text is written and its Enter is pending.
    pub(super) fn write_send(
        &mut self,
        id: &str,
        send: &crate::delivery::Send,
    ) -> Result<bool, String> {
        if self.entry(id)?.acp.is_some() {
            return self.acp_send(id, send).map(|()| false); // V2-4a
        }
        self.submitted.remove(id); // N1: new words or keys (an interrupt) are on their way into the box
        if send.submit && !send.content.is_empty() {
            self.clear_box_first(id)?;
            self.copy_gone(id); // Ticket 1094 r5: pasted over, an Enter now sends this paste as well
        }
        let mut bytes = send.content.as_bytes().to_vec();
        for key in &send.keys {
            bytes.extend(key_bytes(key)?);
        }
        let entry = self.entry(id)?;
        let restricted = send.sender != "user" && entry.meta.kind == AgentKind::Claude;
        let input = entry
            .input
            .prepare(&entry.observer.screen.text(), send, restricted)?;
        // v1a-15: an agent with bracketed paste on gets the text as one paste and Enter as a later write, so
        // a long text is not taken as a paste that swallows the Enter. check_text refuses ESC and C1 controls,
        // so the text cannot end the paste early.
        let paste = send.submit
            && entry.meta.kind != AgentKind::Shell
            && entry.pty.as_ref().is_some_and(Pty::bracketed_paste);
        if paste {
            let typed = entry.input.prepare(
                &entry.observer.screen.text(),
                &crate::delivery::Send {
                    submit: false,
                    ..send.clone()
                },
                restricted,
            )?;
            let bytes = [b"\x1b[200~", &bytes[..], b"\x1b[201~"].concat();
            let pty = self.live(id)?;
            let offset = pty.end();
            if let Err(error) = pty.write(&bytes) {
                // A partial write must not leave the agent inside the paste; best effort, the send fails anyway.
                let _ = pty.write(b"\x1b[201~");
                self.entry(id)?.input.mark_uncertain();
                return Err(error);
            }
            self.entry(id)?.input = typed;
            self.pending_enter.insert(
                id.into(),
                PendingEnter {
                    send: send.id.clone(),
                    input,
                    offset,
                    written: std::time::Instant::now(),
                    last: offset,
                    quiet: std::time::Instant::now(),
                    held: false,
                },
            );
            return Ok(true);
        }
        if send.submit {
            bytes.push(b'\r');
        }
        // Ticket 1137: read before the write, whose echo is output too.
        let waiting = self.live(id)?.end() == 0;
        if let Err(error) = self.live(id)?.write(&bytes) {
            self.entry(id)?.input.mark_uncertain();
            return Err(error);
        }
        // Ticket 1137: the line waits in the terminal's input (written once, never again); the shell starts now and
        // reads it. shortcut: a shell that started but has drawn nothing yet keeps an empty `<id>.go` file; harmless.
        if let Some(go) = self.size_waits.remove(id)
            && waiting
        {
            // create_new: never opens what is already there (a FIFO would block this open under the registry lock,
            // a symlink would be followed); anything already there ends the wait the same way.
            let _ = fs::OpenOptions::new().write(true).create_new(true).open(go);
        }
        self.entry(id)?.input = input;
        if send.submit && send.keys.is_empty() {
            self.submitted(id, &send.content);
        }
        if self.entry(id)?.meta.kind != AgentKind::Shell
            && (send.submit || send.keys.iter().any(|k| k.eq_ignore_ascii_case("enter")))
        {
            self.delivery_inflight
                .insert(id.into(), self.queue.attention(id).completion_seq);
            self.inflight_at
                .insert(id.into(), std::time::Instant::now());
        }
        Ok(false)
    }
    pub(super) fn agent_keys(
        &mut self,
        sender: &str,
        id: &str,
        keys: Vec<String>,
        enabled: bool,
    ) -> Response {
        self.refresh()?;
        self.observe()?;
        self.touch_input(id); // ticket 992: keys from any caller may change the input box
        // V2-4a: an ACP agent has no screen: keys never answer its items (Esc cancels the turn).
        if self.entry(id)?.acp.is_some() {
            return self.send(sender, id, String::new(), keys, false);
        }
        self.current(id)?; // v1a-19 r2
        let decision = self
            .queue
            .items()
            .into_iter()
            .find(|p| {
                p.session_id == id
                    && matches!(
                        p.kind,
                        queue::Kind::Dialog | queue::Kind::Permission | queue::Kind::Question
                    )
            })
            .map(|d| self.annotated(d)); // V2-8e
        if let Some(item) = decision {
            let answer =
                if keys.len() == 1 && matches!(keys[0].to_lowercase().as_str(), "esc" | "escape") {
                    queue::Answer::Deny
                } else {
                    let index = item
                        .choices
                        .iter()
                        .position(|c| c.keys == keys && !c.changes_settings)
                        .ok_or("agent_blocked: unverified answer keys")?;
                    if item.kind == queue::Kind::Permission {
                        // v1b-12: one rule, queue::Choice::allows_once (changes_settings is excluded above).
                        if !item.choices[index].allows_once() {
                            return Err("permission requires verified allow_once or Esc".into());
                        }
                        queue::Answer::AllowOnce
                    } else {
                        queue::Answer::Choose { index }
                    }
                };
            crate::grants::check_answer(&item, &answer, enabled)?;
            let send = self.begin_send(sender, id, String::new(), keys, false, "attempting")?;
            let result = self.answer(&item.id, answer, false);
            self.finish_send(
                id,
                &send.id,
                if result.is_ok() {
                    "delivered"
                } else {
                    "failed"
                },
            )?;
            return result;
        }
        self.send(sender, id, String::new(), keys, false)
    }
}

pub(super) fn interrupt_key(keys: &[String]) -> bool {
    matches!(keys, [k] if matches!(k.to_ascii_lowercase().as_str(), "esc" | "escape" | "ctrl+c"))
}
/// ticket 115: any key that resolves to a bare Esc byte (`esc`, `escape`, inside a longer send); arrows only start with one.
pub(super) fn has_bare_esc(keys: &[String]) -> Result<bool, String> {
    for key in keys {
        if key_bytes(key)? == [27] {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn key_bytes(key: &str) -> Result<Vec<u8>, String> {
    Ok(match key.to_ascii_lowercase().as_str() {
        "enter" => b"\r".to_vec(),
        "esc" | "escape" => vec![27],
        "tab" => vec![9],
        "backspace" => vec![127],
        "up" => b"\x1b[A".to_vec(),
        "down" => b"\x1b[B".to_vec(),
        "right" => b"\x1b[C".to_vec(),
        "left" => b"\x1b[D".to_vec(),
        "ctrl+c" => vec![3],
        "ctrl+d" => vec![4],
        "ctrl+space" => vec![0],
        "shift+left" => b"\x1b[1;2D".to_vec(),
        "shift+right" => b"\x1b[1;2C".to_vec(),
        "shift+tab" => b"\x1b[Z".to_vec(), // CHAT-PERMCHIP: Claude's permission-mode cycle
        // Lane w102: a choice's number (docs/cli.md names `1`), so send-keys answers a start question send-text holds for.
        d @ ("0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9") => d.as_bytes().to_vec(),
        _ => return Err(format!("unsupported key: {key}")),
    })
}

/// CHAT-PERMCHIP: Shift+Tab cycles Claude's permission mode (it can reach bypass), so only the user's own click
/// presses it, and only into Claude; every other key keeps today's rule.
pub(super) fn check_key(sender: &str, kind: AgentKind, key: &str) -> Result<(), String> {
    key_bytes(key)?;
    if key.eq_ignore_ascii_case("shift+tab") && (sender != "user" || kind != AgentKind::Claude) {
        return Err(format!("unsupported key: {key}"));
    }
    Ok(())
}

/// Interrupted sends are never replayed: every queued or attempting send is logged as canceled.
pub(super) fn cancel_queue(meta: &mut Session) {
    for mut send in meta.send_queue.drain(..) {
        send.status = "canceled".into();
        meta.send_log.push(send);
    }
}
/// Keeps the newest rows; callers that order by time sort first.
pub(super) fn cap_log(log: &mut Vec<crate::delivery::Send>) {
    let excess = log.len().saturating_sub(crate::delivery::SEND_LOG_LIMIT);
    log.drain(..excess);
}
