//! Send-when-ready delivery: the queue's delivery pass, pending Enters and the checks that a submit landed.
use super::*;
impl Sessions {
    /// S9: `flush_delivery` without its own reads: this tick reads once before delivering and again only when a send
    /// was written, waits for its Enter or was canceled. An idle tick read the same state twice (twice the holder
    /// `alive` round trips and board reads, every 50 ms). Changes are left `unsaved` for the tick's one save.
    pub(super) fn delivery_pass(&mut self) -> Result<(), String> {
        self.refresh_unsaved()?;
        self.observe()?;
        if self.deliver()? {
            self.refresh_unsaved()?;
            self.observe()?;
        }
        Ok(())
    }
    /// v1a-24 r4: the pending-Enter pass of `flush_delivery`, run on the screen its `observe` just fed; gives the
    /// sessions it handled (they take no other queued send this tick).
    pub(super) fn flush_enters(&mut self) -> Result<std::collections::BTreeSet<String>, String> {
        let mut delivered = std::collections::BTreeSet::new();
        // v1a-15: write each pending Enter once the agent echoed the paste into its composer, or at the settle
        // deadline when nothing was drawn since the paste; the session takes no other queued send this tick.
        // The override has a floor: an Enter right behind the paste is the bug this exists to avoid.
        let settle = std::env::var("NUNCHIRO_SETTLE_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map_or(SETTLE, |ms: u64| {
                std::time::Duration::from_millis(ms.max(250))
            });
        for id in self.pending_enter.keys().cloned().collect::<Vec<_>>() {
            delivered.insert(id.clone());
            let Some(meta) = self.entries.get(&id).map(|e| e.meta.clone()) else {
                self.pending_enter.remove(&id);
                continue;
            };
            let snapshot = self.snapshot_session(&meta);
            let offset = self.entries[&id].observer.output_offset;
            let enter = self.pending_enter.get_mut(&id).unwrap();
            if offset != enter.last {
                (enter.last, enter.quiet) = (offset, std::time::Instant::now());
            }
            // v1a-24 r3: the screen is read only once the output stayed quiet; a frame may land in more than one
            // read (the box first, a dialog under it after).
            let settled = enter.quiet.elapsed() >= SWITCH_SETTLE;
            let entry = &self.entries[&id];
            let live = entry.agent_live(); // ticket 286: an Enter is never written into the shell an agent left
            let enter = &self.pending_enter[&id];
            // Echo counts once observe fed it, so the activity it caused is behind the baseline below.
            let echoed = entry.observer.output_offset > enter.offset;
            let late = enter.written.elapsed() >= settle;
            let screen = entry.observer.screen.text();
            // v1a-20: only the composer showing this paste counts; a dialog cursor row (`❯ 1. Yes`) does not.
            let paste = meta
                .send_queue
                .iter()
                .find(|s| s.id == enter.send)
                .map_or("", |s| s.content.as_str());
            // An answer that goes into a running turn (`steers`): a working Codex redraws about 30 times a second, so
            // its output is never quiet. The input box showing the paste on an earlier pass and on this one stands in
            // for the quiet: a frame cut in two by a read is whole by the next pass.
            let steer = self.steers.contains(&enter.send);
            // Ticket 1121: the box showed the paste on an earlier pass and now shows exactly it, every row, past the
            // settle time: the Enter goes though the output is never quiet (an animated footer row redraws while
            // the agent is idle; the paste was dropped after PASTE_WAIT and sat typed in the box). Output not read yet
            // still holds it back (review r2): a dialog or a draft drawn in it would take the Enter.
            let proven = enter.held
                && late
                && box_text(&screen, meta.kind).is_some_and(|t| same_words(&t, paste));
            let holding = (settled || steer && enter.held || proven)
                && composer(&screen, meta.kind).is_some_and(|c| holds_paste(&c, paste));
            // The composer shows words that are not this paste. An empty composer, or none on the screen, is a paste
            // not drawn yet: on a loaded machine Claude drew it after the settle deadline, the Enter was dropped and
            // the prompt sat unsent (real run 11-17), so that case waits `PASTE_WAIT` settle times.
            let other = settled
                && composer(&screen, meta.kind)
                    .is_some_and(|c| !c.trim().is_empty() && !holds_paste(&c, paste));
            let shows = composer(&screen, meta.kind).is_some_and(|c| holds_paste(&c, paste));
            let held = enter.held || shows;
            // The agent began a turn between the paste and its Enter (a wake line that followed another by a
            // moment): nothing is judged while it works. The screen of a working agent is not its composer, so the
            // paste read as lost and the Enter was dropped; the words then stayed in the lead's composer, every later
            // wake line was pasted behind them and dropped too, and the lead heard nothing more (real runs 11-17, six
            // workers ending together). The Enter goes when the turn has ended and the composer holds the paste.
            if live && snapshot.attention.working && !steer {
                continue;
            }
            // Enter on anything but the composer answers it: a dialog's default choice (approve), the picker's
            // model. Such a send is never submitted later.
            let dropped = if !live {
                None
            } else if crate::delivery::blocked(&snapshot.pending) {
                Some("enter_dropped_blocked")
            } else if entry.switch.is_some() {
                Some("enter_dropped_switch")
            } else if screen.lines().any(|l| l.trim() == "Select model") {
                Some("enter_dropped_picker")
            } else if entry.observer.behind {
                // v1a-19 r2: the screen is not current; a dialog may sit in the unfed output.
                (enter.written.elapsed() >= ENTER_CATCH_UP).then_some(BEHIND)
            } else if echoed
                && !holding
                && late
                && (other
                    || held && settled && !shows
                    // A dialog is on the screen: the paste will not show under it (as before, same mark).
                    || dialog_up(&screen, meta.kind)
                    || enter.written.elapsed() >= settle * PASTE_WAIT)
            {
                // The composer holds other words, showed the paste and lost it, or the paste never showed.
                Some("enter_dropped_composer")
            } else if late && dialog_up(&screen, meta.kind) {
                // Ticket 991 (B1): no echo and a dialog on the screen: the deadline's Enter would answer it.
                Some("enter_dropped_blocked")
            } else {
                None
            };
            // v1a-24 r4: output that arrived after this pass's read is unread; the next pass decides on it. What is
            // left is the time from this check to the write below (no screen work between).
            let unread = entry
                .pty
                .as_ref()
                .is_some_and(|pty| pty.end() != entry.observer.output_offset);
            if live
                && dropped.is_none()
                && (entry.observer.behind
                    || unread
                    || !(echoed && holding) && !late
                    // Echo of something, the paste not in the composer yet: wait for it (the drop above ends the wait).
                    || echoed && !holding)
            {
                if shows {
                    self.pending_enter.get_mut(&id).unwrap().held = true;
                }
                continue;
            }
            let enter = self.pending_enter.remove(&id).unwrap();
            let entry = self.entry(&id)?;
            // A stop or restore already finished the row; nothing is left to write.
            let Some(row) = entry
                .meta
                .send_queue
                .iter_mut()
                .find(|s| s.id == enter.send)
            else {
                continue;
            };
            if !live {
                // Ticket 999: nothing is written, so the cancel waits for the delivery pass's one save.
                self.mark_send(&id, &enter.send, "canceled")?;
                self.unsaved
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                continue;
            }
            if let Some(reason) = dropped {
                eprintln!("session {id} Enter dropped: {reason}");
                // Ticket 1085: an automatic line (a wake line, the room's notice, the core's heartbeat) stays typed in the
                // box. It is cleared before the next submit, and the row waits in the queue once more: the owner's next
                // message was typed behind it and both went in as one.
                let automatic = row.sender != "user";
                // Ticket 1094 r3: only a mark every core loads is saved (an unknown one stopped the next start). BEHIND is
                // logged only; the user's row then reads as a composer drop, which the composer shows the same way.
                row.settle = crate::delivery::saved_mark(reason)
                    .or_else(|| (!automatic).then(|| "enter_dropped_composer".into()));
                self.left_typed.insert(id.clone());
                let again = automatic && self.retried.insert(enter.send.clone());
                // Ticket 1094: the user's own message is never left failed out of sight with its words typed in the
                // box (his next send went in glued behind them, three copies at once), whatever the reason of the
                // drop. It waits in the queue, which the composer shows (`settle` names the drop). The first drop
                // tries again at the next ready pass; each later one waits RETRY_FIRST, doubling up to RETRY_MAX, so
                // it is never pasted again and again into a box that keeps refusing it, and never waits for ever.
                if !automatic {
                    self.copy_left.insert(id.clone(), enter.send.clone());
                    self.hand_typed.insert(id.clone(), Some(String::new()));
                    let n = self.drops.entry(enter.send.clone()).or_insert(0);
                    *n = n.saturating_add(1);
                    if *n > 1 {
                        let wait = RETRY_FIRST
                            .saturating_mul(1 << (*n - 2).min(8))
                            .min(RETRY_MAX);
                        self.retry_at
                            .insert(enter.send.clone(), std::time::Instant::now() + wait);
                    }
                }
                let project = self.entry(&id)?.meta.project.clone();
                crate::events::send_dropped(&project, &id, reason, again || !automatic); // ticket 1130 C-C3
                self.finish_send(
                    &id,
                    &enter.send,
                    if again || !automatic {
                        "queued"
                    } else {
                        "failed"
                    },
                )?;
                continue;
            }
            if let Err(error) = self.live(&id)?.write(b"\r") {
                eprintln!("session {id} Enter write failed: {error}");
                self.entry(&id)?.input.mark_uncertain();
                self.finish_send(&id, &enter.send, "failed")?;
                continue;
            }
            let attention = self.queue.attention(&id);
            let entry = self.entry(&id)?;
            entry.input = enter.input;
            // The turn starts at the Enter: the paste's echo is not the agent working on it.
            if let Some(row) = entry
                .meta
                .send_queue
                .iter_mut()
                .find(|s| s.id == enter.send)
            {
                row.completion_seq = attention.completion_seq;
                row.last_activity = attention.last_activity;
                if !echoed {
                    row.settle = crate::delivery::saved_mark("settle_timeout");
                }
            }
            self.delivery_inflight
                .insert(id.clone(), attention.completion_seq);
            self.inflight_at
                .insert(id.clone(), std::time::Instant::now());
            self.submitted(&id, paste);
            self.finish_send(&id, &enter.send, "delivered")?;
        }
        Ok(delivered)
    }
    /// Ticket 1094: the core's own evidence over a lost signal. A Claude the queue reads as working whose screen shows
    /// its input box with no "esc to interrupt" footer, that drew nothing and reported nothing for IDLE_SETTLE_MS, and
    /// that asks nothing, has ended its turn: a hook the core refused, a prompt replayed from the journal after a
    /// restart (its Stop never journaled), a turn end in a shape this build does not read. A working Claude draws its
    /// spinner many times a second, so it never stays still that long.
    pub(super) fn settle_idle(&mut self) -> Result<(), String> {
        let now = queue::now_ms();
        let idle: Vec<String> = self
            .entries
            .iter()
            .filter(|(id, e)| {
                let a = self.queue.attention(id);
                e.meta.kind == AgentKind::Claude
                    && e.acp.is_none()
                    && e.agent_live()
                    && !e.observer.behind
                    && a.working
                    && now.saturating_sub(a.last_activity) >= IDLE_SETTLE_MS
                    && !self.pending_enter.contains_key(*id)
                    && !crate::delivery::blocked(&self.queue.items_of(id))
                    && interrupted_at_prompt(&e.observer.screen.text())
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            self.queue
                .observe(&id, "Interrupted", &serde_json::json!({}), "screen", now)?;
        }
        Ok(())
    }
    /// Ticket 1094 r4: the user's queued row whose dropped paste the core left in session `id`'s box (r5:
    /// `copy_left`, not cleared or pasted over since) and that the box still shows, word for word. His own Enter in the
    /// terminal sends it with his words; sent again by the core, the agent got his message twice. A screen that is
    /// behind proves nothing, so then none: the row goes once more, never lost.
    pub(super) fn taken_by_hand(&self, id: &str) -> Vec<String> {
        let Some(e) = self.entries.get(id) else {
            return vec![];
        };
        let Some(left) = self.copy_left.get(id) else {
            return vec![];
        };
        let Some(Some(typed)) = self.hand_typed.get(id) else {
            return vec![];
        };
        if e.meta.kind != AgentKind::Claude || e.observer.behind {
            return vec![];
        }
        let Some(c) = composer(&e.observer.screen.text(), e.meta.kind) else {
            return vec![];
        };
        e.meta
            .send_queue
            .iter()
            .filter(|s| {
                &s.id == left
                    && s.status == "queued"
                    && s.sender == "user"
                    && proven_copy(&c, &s.content, typed)
            })
            .map(|s| s.id.clone())
            .collect()
    }
    /// Ticket 1121: the core's dropped copy may be in session `id`'s box (`left_typed`, `copy_left`) and the screen
    /// reads no box, so a clear before a paste would write no Ctrl+U.
    pub(super) fn unread_copy(&self, id: &str) -> bool {
        (self.left_typed.contains(id) || self.copy_left.contains_key(id))
            && self
                .entries
                .get(id)
                .is_some_and(|e| composer(&e.observer.screen.text(), e.meta.kind).is_none())
    }
    /// Ticket 1094 r5: the dropped copy can no longer be in session `id`'s box.
    pub(super) fn copy_gone(&mut self, id: &str) {
        self.copy_left.remove(id);
        self.hand_typed.remove(id);
    }
    /// Ticket 1094 r6: a dropped row his own Enter sent with a proven box is delivered once a turn starts after that
    /// Enter (its start time, or more turn ends than the one running then). With no such turn by the time the agent is
    /// idle HAND_PROOF after the Enter, the proof failed: the row stays queued and goes again (one extra copy at worst,
    /// never a message shown delivered that the agent did not get).
    fn settle_hand_sent(&mut self) -> Result<(), String> {
        for id in self.hand_sent.keys().cloned().collect::<Vec<_>>() {
            let (send, seq, working, at_ms, at) = self.hand_sent[&id].clone();
            let queued = self.entries.get(&id).is_some_and(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .any(|s| s.id == send && s.status == "queued")
            });
            let a = self.queue.attention(&id);
            let started = a.working && a.working_since >= at_ms
                || a.completion_seq > seq + u64::from(working);
            if !queued || started || !a.working && at.elapsed() >= HAND_PROOF {
                self.hand_sent.remove(&id);
            }
            if queued && started {
                // The delivery record: his Enter sent it, so it needed a person (counted already if the core had
                // given up on it) and is no resend by the core.
                self.drops.remove(&send);
                if !self.spent.contains(&send) {
                    crate::record::count(&self.home, false, false, true);
                }
                self.finish_send(&id, &send, "delivered")?;
            }
        }
        Ok(())
    }
    /// Ticket 1094 r4: session `id`'s screen shows its input box, and the box is empty: every row of it, not only the
    /// first (a draft may start with a blank line).
    pub(super) fn box_empty(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            box_text(&e.observer.screen.text(), e.meta.kind).is_some_and(|t| t.trim().is_empty())
        })
    }
    /// Ticket 1094: whether session `id` may take its next queued send. A delivery is in flight until a turn ends
    /// after it, or until the agent, with no turn running, shows its input box INFLIGHT_IDLE after the write: an idle
    /// agent that took no turn from it (a dropped or refused submit) never holds every later send for ever.
    pub(super) fn delivery_open(&self, id: &str, snapshot: &Session) -> bool {
        let now = std::time::Instant::now();
        self.delivery_inflight
            .get(id)
            .is_none_or(|seq| snapshot.completion_seq > *seq)
            || !snapshot.attention.working
                && self
                    .inflight_at
                    .get(id)
                    .is_some_and(|t| now.duration_since(*t) >= INFLIGHT_IDLE)
                && self
                    .entries
                    .get(id)
                    .is_some_and(|e| composer(&e.observer.screen.text(), e.meta.kind).is_some())
    }
    /// N1: the core wrote `text` and its Enter into session `id`'s input box; `verify_submits` looks once more.
    pub(super) fn submitted(&mut self, id: &str, text: &str) {
        let agent = self.entries.get(id).is_some_and(|e| {
            e.acp.is_none() && matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
        });
        if !agent || text.trim().is_empty() {
            return;
        }
        let now = std::time::Instant::now();
        self.submitted.insert(
            id.into(),
            Submitted {
                text: text.into(),
                seq: self.queue.attention(id).completion_seq,
                at: now,
                tries: 0,
                last: 0,
                quiet: now,
            },
        );
    }
    /// Look 11-17 v8 N1: a submit is checked, not assumed. `SUBMIT_CHECK` after its Enter, with no turn begun (no hook,
    /// no finished turn) and the input box on a still, current screen holding exactly the words the core sent, Enter
    /// goes once more; `SUBMIT_TRIES` times at most. The words are never typed again. Anything else ends the check: a
    /// turn, a question, an empty box or one with other words (the user's own), a key or text from the user or an agent
    /// (`write_send`, `SendText`, `SendKeys` drop it), a model switch or mode walk.
    fn verify_submits(&mut self) {
        for id in self.submitted.keys().cloned().collect::<Vec<_>>() {
            let a = self.queue.attention(&id);
            let blocked = crate::delivery::blocked(&self.queue.items_of(&id));
            let hold = self.walk_hold(&id);
            let check = self.submitted.get_mut(&id).unwrap();
            let Some(entry) = self.entries.get(&id) else {
                self.submitted.remove(&id);
                continue;
            };
            if !entry.agent_live()
                || a.working
                || a.completion_seq != check.seq
                || blocked
                || hold
                || entry.switch.is_some()
                || self.pending_enter.contains_key(&id)
            {
                self.submitted.remove(&id);
                continue;
            }
            let offset = entry.observer.output_offset;
            if offset != check.last {
                (check.last, check.quiet) = (offset, std::time::Instant::now());
            }
            if check.at.elapsed() < SUBMIT_CHECK {
                continue;
            }
            let current = !entry.observer.behind
                && entry.pty.as_ref().is_some_and(|pty| pty.end() == offset)
                && check.quiet.elapsed() >= SWITCH_SETTLE;
            if !current {
                // An agent that never stops drawing: the check ends unread (as before this check existed).
                if check.at.elapsed() >= SUBMIT_CHECK * 5 {
                    self.submitted.remove(&id);
                }
                continue;
            }
            let holds = box_text(&entry.observer.screen.text(), entry.meta.kind)
                .is_some_and(|shown| same_words(&shown, &check.text));
            if !holds {
                self.submitted.remove(&id);
                continue;
            }
            if check.tries == SUBMIT_TRIES {
                eprintln!(
                    "session {id}: the prompt is still in the input box after {SUBMIT_TRIES} more Enters"
                );
                self.submitted.remove(&id);
                continue;
            }
            (check.tries, check.at) = (check.tries + 1, std::time::Instant::now());
            eprintln!(
                "session {id}: Enter not taken, pressed again ({})",
                check.tries
            );
            if self.live(&id).and_then(|pty| pty.write(b"\r")).is_err() {
                self.submitted.remove(&id);
            }
        }
    }
    /// One delivery pass on freshly read state, as a tick runs it (tests drive it directly; ticket 1081's resend).
    pub(super) fn flush_delivery(&mut self) -> Result<(), String> {
        self.refresh()?;
        self.observe()?;
        self.deliver()?;
        self.save_unsaved()
    }
    /// The delivery step of `flush_delivery`, on state already read; true when it wrote, held an Enter or canceled.
    /// A cancel is left `unsaved` for the caller's save (ticket 999).
    pub(super) fn deliver(&mut self) -> Result<bool, String> {
        // Ticket 300 step 2: each session's queued sends, in queue order, worked as that session's own queue (as each
        // herdr pane's actor owns its input queue): an ended session's cancel walks its own rows only.
        // V2.5-85: only the ids of sessions with a queued row are collected; rows are read in place where the walk
        // reaches them (herdr's `flush_pending_writes_once` peeks at its queue's front), and only the row being
        // written is copied. The tick runs every 50 ms and most ticks write nothing.
        let ids: Vec<String> = self
            .entries
            .values()
            .filter(|e| e.meta.send_queue.iter().any(|s| s.status == "queued"))
            .map(|e| e.meta.id.clone())
            .collect();
        let entries = &self.entries;
        self.deny_notes.retain(|send| {
            entries.values().any(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .any(|s| s.status == "queued" && &s.id == send)
            })
        });
        let waits = |send: &String| {
            entries
                .values()
                .any(|e| e.meta.send_queue.iter().any(|s| &s.id == send))
        };
        self.steers.retain(waits);
        self.wake_rows.retain(waits);
        self.core_rows.retain(waits);
        self.memory_rows.retain(waits);
        self.joined_rows.retain(|send, _| waits(send));
        self.retried.retain(waits);
        self.drops.retain(|send, _| waits(send));
        self.retry_at.retain(|send, _| waits(send));
        self.copy_left.retain(|_, send| waits(send));
        self.spent.retain(waits);
        self.clean_wait.retain(|send, _| waits(send));
        self.now_rows.retain(waits);
        self.later_rows.retain(|send, _| waits(send));
        self.attached.retain(waits);
        let now = std::time::Instant::now();
        self.typing_until.retain(|_, t| now < *t);
        self.direct_until.retain(|_, t| now < *t);
        // Round 6: in-flight times of sessions that are gone (one per session ever started otherwise).
        let live = &self.entries;
        self.inflight_at.retain(|id, _| live.contains_key(id));
        let left = &self.copy_left;
        self.hand_typed.retain(|id, _| left.contains_key(id));
        self.settle_hand_sent()?;
        self.verify_submits();
        let mut delivered = self.flush_enters()?;
        let mut canceled = false;
        // Home.rs: sessions whose row waits only for the owner's text in the box.
        let mut wants_home = Vec::new();
        for id in ids {
            // v1a-10: queued sends wait until a model switch has finished.
            // CHAT-MODELIST r2: and until a mode walk has ended.
            if delivered.contains(&id) || self.entry(&id)?.switch.is_some() || self.walk_hold(&id) {
                continue;
            }
            if !self.entry(&id)?.agent_live() {
                // Ticket 286: also the queue of an agent that quit and left its shell.
                // Ticket 300: out of the queue now, in queue order; saved once by the caller (ticket 999: the tick's one
                // save, or `flush_delivery`'s), or sooner by the "attempting" save of a later send. A save per row held
                // the registry lock for seconds when an agent exited with a long queue. Until that save lands (a crash),
                // the file still lists them queued, and a restart cancels queued rows anyway (`cancel_queue`).
                self.cancel_own_queue(&id)?;
                canceled = true;
                continue;
            }
            // Ticket 300: the session's readiness, read once from one snapshot (a copy per send was quadratic in the
            // queue): nothing below changes it before a write, and a write ends the session's turn this tick.
            let mut ready = None;
            // The row under the walk; a canceled row leaves the queue, so the next one moves into its place.
            let mut at = 0;
            while let Some(send) = self.entries[&id].meta.send_queue.get(at) {
                if send.status != "queued" {
                    at += 1;
                    continue;
                }
                let refused = self.send_refused(&id, send);
                // V2-8e: a deny instruction is never typed while any prompt shows (the denied one may not have redrawn
                // yet, and an answered prompt is not filed again): typed there, its Enter would pick an option.
                let note = self.deny_notes.contains(&send.id);
                let steer = self.steers.contains(&send.id);
                // Another session's line waits while the box holds words or keys typed by hand: written, it would be
                // refused (`delivery::EDITED`) and lost. After a Stop the next submit clears the box itself.
                // Ticket 1094 r3: so does the user's own row once its Enter was dropped: pasted again behind his hand-typed
                // words (the box is not cleared then), it went in glued to its own earlier copy.
                // r4: an empty box holds none of his words (a raw key such as a dialog's digit also marks it edited).
                let edited = (send.sender != "user"
                    || self.drops.contains_key(&send.id) && !self.box_empty(&id))
                    && send.submit
                    && self.box_edited(&id)
                    && !self.entries[&id].observer.clear_box;
                // Ticket 1094 r3: a user row dropped again waits out its own retry time; his newer messages go meanwhile.
                let later = self
                    .retry_at
                    .get(&send.id)
                    .is_some_and(|t| std::time::Instant::now() < *t)
                    // r6: his own Enter may have sent it; it waits for the proof (`settle_hand_sent`).
                    || self.hand_sent.get(&id).is_some_and(|h| h.0 == send.id);
                // Ticket 1121: the drops so far of a row whose Enter was dropped, and its words (the guard below).
                let again = (self.drops.get(&send.id).copied())
                    .or_else(|| self.retried.contains(&send.id).then_some(1))
                    .map(|n| (n, send.content.clone()));
                // The guard also holds any later submit while the box may still hold the core's dropped copy: pasted
                // into a box the screen does not read, the clear writes no Ctrl+U and the new words glue to that copy.
                // A stopped row stays stopped though a later send cleared the copy tracking (review r2).
                let guard = (again.is_some()
                    || self.spent.contains(&send.id)
                    || send.submit
                        && (self.left_typed.contains(&id) || self.copy_left.contains_key(&id)))
                .then(|| (send.id.clone(), send.sender != "user"));
                if refused {
                    let send_id = send.id.clone();
                    self.mark_send(&id, &send_id, "canceled")?;
                    canceled = true;
                    continue; // no `at += 1`: the row left the queue and the next one moved into its slot
                }
                // Gap rule: attached, Later, text in the box, or the owner typing.
                let why = self.gap_hold(&id, &send.id, &send.sender, send.submit, &send.content);
                let gap = why.is_some();
                if why == Some("terminal_text") && !wants_home.contains(&id) {
                    wants_home.push(id.clone());
                }
                let entry = self.entry(&id)?;
                if edited
                    || gap
                    || later
                    || note
                        && entry.acp.is_none()
                        && entry.observer.screen.detect(entry.meta.kind).is_some()
                {
                    at += 1;
                    continue;
                }
                if ready.is_none() {
                    let snapshot = self.snapshot_session(&self.entries[&id].meta);
                    ready = Some(
                        !self.entry(&id)?.observer.behind // v1a-19 r2
                            && self.send_ready(&id, &snapshot)?
                            && self.delivery_open(&id, &snapshot),
                    );
                }
                // An answer to an async question needs only the input box: its turn runs while it waits for the answer.
                if ready == Some(false) && !(steer && self.steer_ready(&id)?) {
                    at += 1;
                    continue;
                }
                // Ticket 1121: a row whose Enter was dropped goes again only into a box the screen reads, free of its
                // earlier copy. Pasted while the box was unread (the clear then wrote no Ctrl+U), the agent got it glued
                // behind that copy, six times over. The copy is cleared and the paste waits for a pass that reads the
                // box without it. A row past REPASTES drops, or with no clean box read for CLEAN_WAIT, is stopped:
                // never pasted again; the user's row waits in the queue (the composer says so), an automatic one fails.
                if let Some((send_id, automatic)) = guard {
                    let (n, content) = again.unwrap_or_default();
                    let shown = composer(
                        &self.entries[&id].observer.screen.text(),
                        self.entries[&id].meta.kind,
                    );
                    let copy = n > 0 && shown.as_ref().is_some_and(|c| holds_paste(c, &content));
                    if copy {
                        self.entry(&id)?.observer.clear_box = true;
                        self.clear_box_first(&id)?;
                    }
                    // A row of its own once dropped goes again only into an empty box: Codex's box held the owner's
                    // half-typed words and the copy behind them, read as free of the copy, and took it twice more.
                    let clean = !copy && shown.is_some() && (n == 0 || self.box_empty(&id));
                    let mut give_up = n > REPASTES;
                    if !give_up && !clean {
                        // The wait counts while the row keeps reaching this guard; a pause (a turn, a dialog) starts it again.
                        let now = std::time::Instant::now();
                        let wait = self.clean_wait.entry(send_id.clone()).or_insert((now, now));
                        *wait = if now.duration_since(wait.1) > CLEAN_GAP {
                            (now, now)
                        } else {
                            (wait.0, now)
                        };
                        give_up = now.duration_since(wait.0) >= CLEAN_WAIT;
                    }
                    // The delivery record: the core gives up on it, so it needs a person, once.
                    if give_up && self.spent.insert(send_id.clone()) {
                        crate::record::count(&self.home, false, false, true);
                    }
                    if self.spent.contains(&send_id) && automatic {
                        self.mark_send(&id, &send_id, "failed")?;
                        canceled = true;
                        continue; // no `at += 1`: the row left the queue
                    }
                    if self.spent.contains(&send_id) || !clean {
                        at += 1;
                        continue;
                    }
                    self.clean_wait.remove(&send_id);
                }
                let mut row = self.entries[&id].meta.send_queue[at].clone();
                // Ticket 1056: queued wake lines go out together as one message, one line per worker; a line whose
                // worker was closed, or whose task is closed, is dropped.
                let mut joined = Vec::new();
                if self.wake_rows.contains(&row.id) {
                    if self.row_gone(&id, &row) {
                        self.mark_send(&id, &row.id, "canceled")?;
                        canceled = true;
                        continue;
                    }
                    let rest: Vec<_> = self.entries[&id]
                        .meta
                        .send_queue
                        .iter()
                        .filter(|s| {
                            s.id != row.id
                                && s.status == "queued"
                                && self.wake_rows.contains(&s.id)
                                && !self.send_refused(&id, s)
                                // Gap rule: a line the owner holds (Later, attached, typing) is not carried along.
                                && self.gap_hold(&id, &s.id, &s.sender, s.submit, &s.content).is_none()
                        })
                        .cloned()
                        .collect();
                    for s in rest {
                        let (send, content) = (s.id.clone(), s.content.clone());
                        if self.row_gone(&id, &s) {
                            self.mark_send(&id, &send, "canceled")?;
                            canceled = true;
                            continue;
                        }
                        // The batch stays inside the send limit; the lines after it go in the next one, in order.
                        if row.content.len() + 1 + content.len() > crate::delivery::SEND_LIMIT {
                            break;
                        }
                        row.content.push('\n');
                        row.content.push_str(&content);
                        joined.push(send);
                    }
                    // The queue row carries the whole text: the paste check of its Enter reads it there.
                    if let Some(queued) = self
                        .entry(&id)?
                        .meta
                        .send_queue
                        .iter_mut()
                        .find(|s| s.id == row.id)
                    {
                        queued.content = row.content.clone();
                    }
                    for send in &joined {
                        self.mark_send(&id, send, "attempting")?;
                    }
                    // A row put back in the queue (an edited box) keeps the lines it already carries.
                    self.joined_rows
                        .entry(row.id.clone())
                        .or_default()
                        .extend(joined);
                }
                // Gap rule: the owner's prompt takes the messages he attached, under his words, in one paste.
                if row.sender == "user" && row.submit && joinable(&row.content) {
                    let rest: Vec<_> = self.entries[&id]
                        .meta
                        .send_queue
                        .iter()
                        .filter(|s| {
                            s.status == "queued"
                                && self.attached.contains(&s.id)
                                && !self.send_refused(&id, s)
                        })
                        .cloned()
                        .collect();
                    let mut joined = Vec::new();
                    for s in rest {
                        let piece = format!(
                            "\n\n[Message from {}, attached by the owner]\n{}",
                            self.sender_name(&s.sender),
                            s.content
                        );
                        if row.content.len() + piece.len() > crate::delivery::SEND_LIMIT {
                            break;
                        }
                        row.content.push_str(&piece);
                        joined.push(s.id);
                    }
                    if !joined.is_empty() {
                        if let Some(queued) =
                            (self.entry(&id)?.meta.send_queue.iter_mut()).find(|s| s.id == row.id)
                        {
                            queued.content = row.content.clone();
                        }
                        for send in &joined {
                            self.attached.remove(send);
                            self.mark_send(&id, send, "attempting")?;
                        }
                        self.joined_rows
                            .entry(row.id.clone())
                            .or_default()
                            .extend(joined);
                    }
                }
                #[cfg(test)]
                self.send_clones
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.finish_send(&id, &row.id, "attempting")?;
                let result = self.write_send(&id, &row);
                // v1a-15: a pasted submit stays attempting until a later tick writes its Enter.
                if result != Ok(true) {
                    let status = match &result {
                        Ok(_) => "delivered",
                        // Refused for the box as it is, before a byte was written: it waits on (the hold above).
                        Err(e) if e == crate::delivery::EDITED && self.box_edited(&id) => "queued",
                        Err(_) => "failed",
                    };
                    self.finish_send(&id, &row.id, status)?;
                }
                // One send per session per tick leaves time for the agent to report it is working.
                delivered.insert(id.clone());
                break;
            }
        }
        // Home.rs: a row that waits only for his text in the box, on a session that would take it now, brings the text
        // home first (and Type in terminal just turned off does too).
        let mut ready_home = Vec::new();
        for id in wants_home {
            if delivered.contains(&id) || self.entry(&id)?.switch.is_some() || self.walk_hold(&id) {
                continue;
            }
            let snapshot = self.snapshot_session(&self.entries[&id].meta);
            if !self.entry(&id)?.observer.behind
                && self.send_ready(&id, &snapshot)?
                && self.delivery_open(&id, &snapshot)
            {
                ready_home.push(id);
            }
        }
        let homed = self.home_pass(&ready_home)?;
        if canceled {
            self.unsaved
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(canceled || homed || !delivered.is_empty())
    }
    /// Gap rule: the owner typed for session `id` (the window's composer or a key in its terminal).
    pub(super) fn typing(&mut self, id: &str) {
        self.typing_until
            .insert(id.into(), std::time::Instant::now() + TYPING_QUIET);
    }
    /// Gap rule: session `id`'s input box shows text the owner put there: not the agent's faint suggestion or
    /// placeholder, not the core's own paste, dropped copy or submit, not a stopped prompt the next submit clears.
    pub(super) fn owner_text(&self, id: &str) -> bool {
        let Some(e) = self.entries.get(id) else {
            return false;
        };
        if e.acp.is_some()
            || !matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
            || e.observer.clear_box
            || self.left_typed.contains(id)
            || self.copy_left.contains_key(id)
            || self.pending_enter.contains_key(id)
        {
            return false;
        }
        // The box's first row: with Claude's bottom rule lost (a real 2.1.331 screen), the rows under it are footer
        // pieces, which `box_text` would read as words.
        let Some(text) = composer(&e.observer.screen.text(), e.meta.kind) else {
            return false;
        };
        !text.trim().is_empty()
            && !e.observer.screen.composer_faint()
            && !self
                .submitted
                .get(id)
                .is_some_and(|s| same_words(&text, &s.text))
    }
    /// Gap rule: session `id` has a queued message the owner attached to his next prompt.
    pub(super) fn has_attached(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            e.meta
                .send_queue
                .iter()
                .any(|s| s.status == "queued" && self.attached.contains(&s.id))
        })
    }
    /// Gap rule: why a queued row of session `id` (`send` is its id, empty for one not queued yet) waits beyond the
    /// turn: attached to his next prompt, Later, text in the box (every sender), or the owner typing (other senders;
    /// an answer into a running turn, a deny note and a widget act do not wait for it). `None`: it may go.
    pub(super) fn gap_hold(
        &self,
        id: &str,
        send: &str,
        sender: &str,
        submit: bool,
        content: &str,
    ) -> Option<&'static str> {
        if self.attached.contains(send) {
            return Some("attached");
        }
        let seq = self.queue.attention(id).completion_seq;
        if self
            .later_rows
            .get(send)
            .is_some_and(|m| m.is_none_or(|at| seq <= at))
        {
            return Some("later");
        }
        let other = sender != "user";
        // Words another send typed and nobody submitted (an agent's text without Enter) are in the box too.
        let unsent = other
            && self.entries.get(id).is_some_and(|e| {
                e.acp.is_none()
                    && e.meta.kind != AgentKind::Shell
                    && e.input.pending()
                    && !e.input.edited()
            })
            && !self.pending_enter.contains_key(id);
        if !content.trim().is_empty() && (self.owner_text(id) || submit && unsent) {
            return Some("terminal_text");
        }
        let exempt = self.now_rows.contains(send)
            || self.steers.contains(send)
            || self.deny_notes.contains(send)
            || crate::delivery::widget_sender(sender);
        // Type in terminal: the owner is in the agent's own box.
        if other
            && !exempt
            && !content.trim().is_empty()
            && self
                .direct_until
                .get(id)
                .is_some_and(|t| std::time::Instant::now() < *t)
        {
            return Some("direct");
        }
        // Keys alone (an Esc, a digit) keep their own checks: a box edited by hand refuses another sender's Enter.
        if other
            && !exempt
            && !content.trim().is_empty()
            && self
                .typing_until
                .get(id)
                .is_some_and(|t| std::time::Instant::now() < *t)
        {
            return Some("typing");
        }
        None
    }
    /// Gap rule: a submit of the owner's went into session `id`: its Later rows go once a turn ends after this.
    pub(super) fn owner_submitted(&mut self, id: &str) {
        self.typing_until.remove(id); // his Enter ends his typing there
        let seq = self.queue.attention(id).completion_seq;
        let Some(e) = self.entries.get(id) else {
            return;
        };
        for s in &e.meta.send_queue {
            if let Some(mark @ None) = self.later_rows.get_mut(&s.id) {
                *mark = Some(seq);
            }
        }
    }
    /// Gap rule: the owner's choice on another sender's queued message (the knock).
    pub(super) fn knock_choice(&mut self, id: &str, send: &str, choice: Knock) -> Response {
        let row = self
            .entry(id)?
            .meta
            .send_queue
            .iter()
            .find(|s| s.id == send)
            .ok_or("send not found")?;
        if row.status != "queued" {
            return Err("send is not queued".into());
        }
        if row.sender == "user" {
            return Err("your own prompt does not wait for you".into());
        }
        if choice == Knock::Attach && (!row.submit || row.content.trim().is_empty()) {
            return Err("only a message with words can be attached".into());
        }
        if choice == Knock::Detach && !self.attached.contains(send) {
            return Err("the message is not attached".into());
        }
        self.now_rows.remove(send);
        self.later_rows.remove(send);
        self.attached.remove(send);
        match choice {
            Knock::Now => {
                self.now_rows.insert(send.into());
            }
            Knock::Later | Knock::Detach => {
                self.later_rows.insert(send.into(), None);
            }
            Knock::Attach => {
                self.attached.insert(send.into());
            }
        }
        Ok(Reply::Ack)
    }
    /// Gap rule: how an attached message is named under the owner's words.
    pub(super) fn sender_name(&self, sender: &str) -> String {
        // The name goes inside a paste: no control character (an ESC would end the paste early, a CR press Enter).
        let name = self.raw_sender_name(sender);
        let shown: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
        if shown.trim().is_empty() {
            "another sender".into()
        } else {
            shown.trim().into()
        }
    }
    fn raw_sender_name(&self, sender: &str) -> String {
        if let Some(e) = self.entries.get(sender) {
            if !e.meta.label.trim().is_empty() {
                return e.meta.label.trim().into();
            }
            if let Some(seat) = &e.meta.teammate {
                return seat.clone();
            }
            return "another session".into();
        }
        if let Some(name) = sender.strip_prefix("widget:") {
            return name.into();
        }
        if sender == CORE {
            return "Nunchiro".into();
        }
        "another sender".into()
    }
    /// A queued row the flush cancels: its sender no longer owns the target, or a widget act lost its grant.
    fn send_refused(&self, id: &str, send: &crate::delivery::Send) -> bool {
        // Ticket 1081: the core's own line has no sender to check; `core_may` checks its target right before the write.
        if self.core_rows.contains(&send.id) || self.memory_rows.contains(&send.id) {
            return false;
        }
        let caller = self
            .entries
            .get(&send.sender)
            // Ticket 286: a sender whose agent quit sends nothing more (its finish line is the core's).
            .filter(|e| e.agent_live() || self.wake_rows.contains(&send.id))
            // Ticket 573 round 6 (review r5 NOTE 3): a token session's send, while its token is live.
            .filter(|e| {
                self.token_origin(&e.meta)
                    .is_none_or(|t| crate::tokens::by_caller(&self.home, &t).is_some())
            })
            .map(|e| crate::grants::Caller {
                id: send.sender.clone(),
                project: e.meta.project.clone(),
            })
            // v1a-06: SSH callers have no PTY entry in this core. Ticket 76: a local stamp is never satisfied by
            // a peer that forwards under the same id after the local session is gone.
            // Ticket 573: an outside token's send, while the token is live.
            .or_else(|| self.token_sender(&send.sender))
            .or_else(|| {
                if send.remote == Some(false) {
                    return None;
                }
                self.remote
                    .callers
                    .get(&send.sender)
                    .map(|c| crate::grants::Caller {
                        id: c.id.clone(),
                        project: c.project.clone(),
                    })
            });
        // v1b-20
        let widget = crate::delivery::widget_sender(&send.sender).then(|| {
            self.widget_hashes
                .get(&send.id)
                .is_some_and(|hash| self.widget_act_current(&send.sender, hash).is_ok())
        });
        widget == Some(false)
            || (widget.is_none()
                        && send.sender != "user"
                        // Ticket 76: the flag stamped at queue time decides; a row without one fails closed.
                        && caller.as_ref().is_none_or(|c| {
                            send.remote.is_none_or(|remote| {
                                !self.grants.owns_as(remote, c, &self.entries[id].meta)
                            })
                        }))
    }
}
/// Gap rule: a prompt that starts with `/ ! # &` (a command, bash mode, memory, a background run) takes no attachment.
pub(super) fn joinable(text: &str) -> bool {
    !text.trim_start().starts_with(['/', '!', '#', '&'])
}
/// Gap rule: the owner's choices on a waiting message.
#[derive(PartialEq, Clone, Copy)]
pub(super) enum Knock {
    Now,
    Later,
    Attach,
    Detach,
}
/// Gap rule: another sender's line waits this long after the owner's last key for the session.
pub(super) const TYPING_QUIET: std::time::Duration = std::time::Duration::from_secs(5);
/// Type in terminal ends by itself this long after the last key in that terminal or the window's last renewal.
pub(super) const DIRECT_QUIET: std::time::Duration = std::time::Duration::from_secs(60);
// A step reads the screen only after the agent redrew it and then stayed quiet, never a stale frame. v1a-24 r3:
// an echoed Enter waits for the same quiet.
pub(super) const SWITCH_SETTLE: std::time::Duration = std::time::Duration::from_millis(100);

// v1a-15: the Enter goes this long after the pasted text at the latest, echoed or not.
pub(super) const SETTLE: std::time::Duration = std::time::Duration::from_secs(3);
// v1a-19 r2: a pending Enter waits this long after the paste for the observer to catch up, then is dropped.
pub(super) const ENTER_CATCH_UP: std::time::Duration = std::time::Duration::from_secs(10);
/// How long a pasted prompt may take to show in the composer before its Enter is dropped, in settle times
/// (3 s each: 21 s; a test's shorter settle shortens it alike).
pub(super) const PASTE_WAIT: u32 = 7;
// Logged only: the persisted settle marks are a fixed list (`delivery::SETTLE_MARKS`), so the row has none.
pub(super) const BEHIND: &str = "enter_dropped_behind";
/// Ticket 1094 r6: how long an idle agent may show no turn after his own Enter before the dropped row goes again.
pub(super) const HAND_PROOF: std::time::Duration = std::time::Duration::from_secs(15);
/// Ticket 1094: an idle agent that shows its input box this long after a write took no turn from it.
pub(super) const INFLIGHT_IDLE: std::time::Duration = std::time::Duration::from_secs(15);
/// Ticket 1094: the wait before a user message whose Enter was dropped twice is tried again, doubled each time.
const RETRY_FIRST: std::time::Duration = std::time::Duration::from_secs(15);
const RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(300);
/// Ticket 1121: how many times a row whose Enter was dropped is pasted again; after that it waits in the queue.
pub(super) const REPASTES: u32 = 2;
/// Ticket 1121: how long a guarded row waits for a box the screen reads clean before it is stopped, and the pause
/// between two passes that starts that wait again.
pub(super) const CLEAN_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
const CLEAN_GAP: std::time::Duration = std::time::Duration::from_secs(5);
/// Ticket 1094: a Claude the queue reads as working that shows its idle input box and drew nothing this long has
/// ended its turn (ms), whatever signal was lost.
pub(crate) const IDLE_SETTLE_MS: u64 = 30_000;
/// Look 11-17 v8 N1: how long after an Enter the core looks at the input box again, and how many more Enters it
/// writes for one message.
const SUBMIT_CHECK: std::time::Duration = std::time::Duration::from_secs(2);
const SUBMIT_TRIES: u8 = 2;
/// A submit the core wrote: its words and its Enter. Real run 11-18: Claude was sent its first message while it still
/// drew its first screen; the Enter was read in one piece with the words (a paste, to Claude) and the message sat in
/// the input box with the session "running" for minutes.
pub(super) struct Submitted {
    text: String,
    /// The turns finished when the Enter went: one more, or a turn running, is the message taken.
    seq: u64,
    at: std::time::Instant,
    tries: u8,
    /// The output offset last seen and when it last changed (the box is read from a still screen only).
    last: u64,
    quiet: std::time::Instant,
}
pub(super) struct PendingEnter {
    pub(super) send: String,
    // The composer state once the Enter is written; the text-only state is in effect until then.
    pub(super) input: crate::delivery::Input,
    pub(super) offset: u64,
    pub(super) written: std::time::Instant,
    /// v1a-24 r3: the output offset last seen and when it last changed.
    pub(super) last: u64,
    pub(super) quiet: std::time::Instant,
    /// The composer showed this paste at some pass: a composer that stops showing it took something else in.
    pub(super) held: bool,
}
