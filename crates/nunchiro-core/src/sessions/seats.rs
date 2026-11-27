//! Team seats: a teammate's seat session, its lead, and the cards and notes a lead's work raises.
use super::*;
impl Sessions {
    /// Ticket 990: the live session that is this teammate's seat, by the id the core stored on it when it opened the
    /// seat (a renamed tab is still the seat; a tab that only shares the name is not).
    pub(crate) fn seat_of(&self, teammate: &str) -> Option<String> {
        self.entries
            .values()
            .find(|e| e.agent_live() && e.meta.teammate.as_deref() == Some(teammate))
            .map(|e| e.meta.id.clone())
    }
    /// Ticket 992: the level of the teammate's newest seat when only its run ended (see `seat_to_resume`).
    pub(crate) fn last_seat_level(&self, teammate: &str) -> Option<crate::team::Level> {
        self.entries
            .values()
            .filter(|e| e.meta.teammate.as_deref() == Some(teammate))
            .max_by_key(|e| {
                let a = self.queue.attention(&e.meta.id);
                (a.last_activity, a.completion_seq)
            })
            .filter(|e| e.meta.state == SessionState::Resumable)
            .and_then(|e| e.meta.level)
    }
    /// The conversation a plain open of this teammate continues: its newest seat's, when that seat ended without being
    /// closed (a core restart leaves it Resumable) and can resume in `start`'s agent and folder. Claude writes its
    /// transcript at the first finished turn, so before that there is nothing to resume (as `handoff_target`).
    /// Ticket 992: only a seat that ran at `level`, the level this open uses, so the model never changes inside a
    /// conversation.
    /// Ticket 1130 B-L3: `undo` names the seat instead (the window's Undo of a new conversation): any seat of this
    /// teammate that no longer runs, a closed one too.
    pub(crate) fn seat_to_resume(
        &self,
        teammate: &str,
        start: &StartSession,
        level: Option<crate::team::Level>,
        undo: Option<&str>,
    ) -> Option<String> {
        let project = fs::canonicalize(&start.project).ok();
        let newest = |e: &&Entry| {
            let a = self.queue.attention(&e.meta.id);
            (a.last_activity, a.completion_seq)
        };
        let mut seats = self
            .entries
            .values()
            .filter(|e| e.meta.teammate.as_deref() == Some(teammate));
        let last = match undo {
            Some(old) => seats.find(|e| e.meta.id == old && !e.agent_live())?,
            None => seats.max_by_key(newest)?,
        };
        let meta = &last.meta;
        ((meta.state == SessionState::Resumable || undo.is_some())
            && meta.kind == start.kind
            && (meta.level.is_none() || meta.level == level) // a seat from before levels has none
            && Some(&meta.project) == project.as_ref()
            && (meta.kind == AgentKind::Codex || self.queue.attention(&meta.id).completion_seq > 0))
            .then(|| meta.agent_session_id.clone())
            .flatten()
    }
    /// Ticket 992: text or keys go to this session's input box now (see `touched`).
    pub(super) fn touch_input(&mut self, id: &str) {
        let a = self.queue.attention(id);
        self.touched
            .insert(id.to_string(), a.completion_seq + u64::from(a.working));
    }
    /// Ticket 992 rule 4: a seat with no turn running, no question waiting, nothing queued or on its way, and a turn
    /// finished since the last text or key went to its input box (so no draft and no just-sent task is in it: ending
    /// the seat would drop them). Only such a seat is ended for a task at another level.
    pub(crate) fn seat_idle(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        !a.working
            && !a.waiting
            && !self.composed.contains_key(id)
            && self
                .delivery_inflight
                .get(id)
                .is_none_or(|seq| a.completion_seq > *seq)
            && self
                .touched
                .get(id)
                .is_some_and(|mark| a.completion_seq > *mark)
            && self
                .entries
                .get(id)
                .is_some_and(|e| e.meta.send_queue.is_empty() && !e.input.pending())
    }
    /// Ticket 1130 B-L3: a turn runs or waits at a question: "New conversation" stops such a seat at once. One between
    /// turns is not busy (a Lead then hands over first).
    pub(crate) fn seat_busy(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        a.working || a.waiting
    }
    /// Ticket 1130 B-L3 round 2: ends a seat for a new conversation; its row always stays (History). A seat whose run
    /// ended a moment ago is left as it is: `close` takes the two-phase path for such a row (`close_later`), and the
    /// row with its conversation id would be gone ten seconds later.
    /// Round 5: otherwise it is the ordinary close, as the window's Close and ticket 1096 make it. An ACP seat's chat
    /// feed ends with its run there too (`acp_chat`'s shortcut: kept in memory only), and an agent without
    /// `loadSession` leaves no conversation id; neither is changed here.
    pub(crate) fn end_seat(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.meta.state != SessionState::Running {
            return Ok(());
        }
        self.close(id, true, false).map(|_| ())
    }
    /// Ticket 1130 B-L3 round 5: holds row `id` out of the Closed-row bound while an Undo that continues it runs.
    pub(crate) fn hold_row(&mut self, id: &str, on: bool) {
        if on {
            self.held_rows.insert(id.into());
        } else {
            self.held_rows.remove(id);
        }
    }
    /// Ticket 1130 B-L3 round 2: a teammate's new conversation keeps the session that started its old seat (its Lead),
    /// as a resumed run does (V2.5-30), so its wake lines and questions still reach that Lead.
    pub(crate) fn seat_parent(&mut self, id: &str, parent: &str) -> Result<Session, String> {
        self.entry(id)?.meta.parent = Some(parent.into());
        self.grants.parents.insert(id.into(), parent.into());
        if let Err(e) = self.save() {
            eprintln!("parent link not saved yet: {e}");
        }
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 1081 (security look 4): a seat the core started that nothing went into since: no text or key ever reached
    /// its input box, nothing composed, queued or on its way, no turn and no question. Only such a seat is closed when
    /// its first prompt was not typed.
    pub(crate) fn seat_untouched(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        !a.working
            && !a.waiting
            && !self.touched.contains_key(id)
            && !self.composed.contains_key(id)
            && !self.delivery_inflight.contains_key(id)
            && self
                .entries
                .get(id)
                .is_some_and(|e| e.meta.send_queue.is_empty() && !e.input.pending())
    }
    /// Ticket 990: the teammate a lead may open: the caller is the live seat of its place's lead, and `name` is another
    /// teammate of that place. Gives the teammate's id.
    pub(crate) fn lead_may_open(
        &self,
        caller: &crate::grants::Caller,
        name: &str,
    ) -> Result<String, String> {
        let all = crate::team::Team::open(&self.home).list()?;
        let seat = self
            .entries
            .get(&caller.id)
            .filter(|e| e.agent_live())
            .and_then(|e| e.meta.teammate.as_deref());
        let lead = all
            .iter()
            .find(|t| t.lead && Some(t.id.as_str()) == seat)
            .ok_or("only the lead of a place opens its teammates")?;
        all.iter()
            .find(|t| {
                t.id != lead.id
                    && t.project == lead.project
                    && t.name.to_lowercase() == name.trim().to_lowercase()
            })
            .map(|t| t.id.clone())
            .ok_or_else(|| format!("no teammate named {} in this place", name.trim()))
    }
    /// Ticket 990: the lead (teammate id) a session works for: itself when it is a lead's seat, else the first lead's
    /// seat up its parent chain. A worktree such a session makes joins that lead's team.
    pub(crate) fn team_lead_of(&self, id: &str) -> Option<String> {
        let leads: Vec<String> = crate::team::Team::open(&self.home)
            .list()
            .ok()?
            .into_iter()
            .filter(|t| t.lead)
            .map(|t| t.id)
            .collect();
        let mut meta = &self.entries.get(id)?.meta;
        for _ in 0..32 {
            if let Some(t) = meta.teammate.as_ref().filter(|t| leads.contains(t)) {
                return Some(t.clone());
            }
            meta = &self.entries.get(meta.parent.as_ref()?)?.meta;
        }
        None
    }
    /// Ticket 1081: what advance.rs reads of a seat's session; a session the registry does not hold is not live.
    pub(crate) fn seat_facts(&self, id: &str) -> crate::advance::Facts {
        let Some(e) = self.entries.get(id) else {
            return Default::default();
        };
        let s = self.snapshot_session(&e.meta);
        crate::advance::Facts {
            live: e.agent_live(),
            working: s.attention.working,
            waits: s.attention.asking || crate::delivery::blocked(&s.pending),
            last: s.attention.last_activity,
            since: s.attention.working_since,
            queued: e
                .meta
                .send_queue
                .iter()
                .filter(|r| r.status == "queued")
                .min_by_key(|r| r.at)
                .map(|r| (r.id.clone(), r.at)),
            cwd: e.meta.cwd.clone(),
        }
    }
    /// Ticket 1081 (security look 2): the one check an auto-advance line passes, before it is written now and again
    /// before its queued row is written. The line is the core's, sent under no seat's or token's identity, so it goes
    /// only to a live session that is a seat (or the lead's seat) of an open task, in a place that still exists with
    /// auto-advance on, and whose own token (or the token it was started under) is not revoked.
    pub(crate) fn core_may(&self, id: &str) -> Result<(), String> {
        let meta = &self
            .entries
            .get(id)
            .filter(|e| e.agent_live())
            .ok_or("skipped: the seat is not running")?
            .meta;
        if self
            .token_origin(meta)
            .is_some_and(|t| crate::tokens::by_caller(&self.home, &t).is_none())
        {
            return Err("skipped: the seat's token was revoked".into());
        }
        let ledger = crate::ledger::Ledger::open(&self.home);
        ledger
            .list()?
            .iter()
            .filter(|t| t.closed.is_none())
            .filter(|t| {
                t.seats.iter().any(|s| s.session == id)
                    || t.lead.is_some() && t.lead == meta.teammate
            })
            .any(|t| t.place.is_dir() && ledger.place(&t.place).auto)
            .then_some(())
            .ok_or_else(|| {
                "skipped: the seat is on no open task of a place with auto-advance on".into()
            })
    }
    /// Ticket 1056 + 1081: a queued wake or core line no longer to be written: a wake line's worker was closed or its
    /// task closed; a core line's target fails `core_may` now.
    pub(super) fn row_gone(&self, id: &str, row: &crate::delivery::Send) -> bool {
        if self.memory_rows.contains(&row.id) {
            return false;
        }
        if self.core_rows.contains(&row.id) {
            return self.core_may(id).is_err();
        }
        self.wake_gone(&row.sender)
    }
    /// A start that waited for memory tells its asker how it ended (`pressure::wait`): a line as `CORE` through the
    /// normal send path, queued behind the user's rows as a wake line is. Unlike `core_line` it needs no task.
    pub(crate) fn memory_line(&mut self, id: &str, text: String) -> Result<(), String> {
        if let Reply::Delivery { send } = self.send_line(CORE, id, text)?
            && send.status == "queued"
        {
            self.wake_rows.insert(send.id.clone());
            self.memory_rows.insert(send.id);
        }
        Ok(())
    }
    /// Ticket 1081: a line the core itself types into `id` through the normal send path, as `CORE` (no seat's or
    /// token's identity is borrowed). `core_may` decides before the write here and before a queued row is written
    /// (`row_gone`). A queued one waits behind the user's own rows as a worker's wake line does (ticket 1056), and
    /// replaces an older queued core line there.
    pub(crate) fn core_line(&mut self, id: &str, text: String) -> Result<(), String> {
        self.core_may(id)?;
        let older: Vec<String> = self
            .entries
            .get(id)
            .map(|e| {
                e.meta
                    .send_queue
                    .iter()
                    // A stall line names one seat and its step: a newer core line does not replace it.
                    .filter(|s| s.status == "queued" && self.core_rows.contains(&s.id))
                    .filter(|s| !s.content.starts_with("Stalled: "))
                    .map(|s| s.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if let Reply::Delivery { send } = self.send_line(CORE, id, text)?
            && send.status == "queued"
        {
            self.wake_rows.insert(send.id.clone());
            self.core_rows.insert(send.id);
            for old in older {
                self.finish_send(id, &old, "canceled")?;
            }
        }
        Ok(())
    }
    /// Ticket 1081: the stalled row `row` of `id` goes through the delivery tick's own pass once more (fresh reads,
    /// then the tick's checks on the original row: its sender's liveness and token, ownership, its local or remote
    /// stamp). Nothing new is typed for another sender (security look: a re-sent copy skipped those checks). False when
    /// the checks canceled the row.
    pub(crate) fn resend_queued(&mut self, id: &str, row: &str) -> Result<bool, String> {
        let status = |s: &Self| {
            s.entries.get(id).and_then(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .chain(&e.meta.send_log)
                    .find(|s| s.id == row)
                    .map(|s| s.status.clone())
            })
        };
        if status(self).as_deref() != Some("queued") {
            return Ok(true);
        }
        self.flush_delivery()?;
        Ok(status(self).as_deref() != Some("canceled"))
    }
    /// Ticket 990 slice g: what the registry knows about a session now, for a task's state word.
    pub(crate) fn seat_now(&self, id: &str) -> crate::ledger::SeatNow {
        let Some(e) = self.entries.get(id) else {
            return Default::default();
        };
        let live = e.agent_live();
        let asks = if live {
            self.queue.items_of(id)
        } else {
            vec![]
        };
        crate::ledger::SeatNow {
            live,
            state: crate::events::state(
                e.meta.state,
                e.agent_ended,
                live && self.queue.attention(id).working,
                asks.iter().map(|i| &i.kind),
            ),
        }
    }
    /// Ticket 990 slice h: the merge card for the owner, from the lead's seat.
    pub(crate) fn ask_merge(
        &mut self,
        session: &str,
        task: &crate::ledger::Task,
        revision: &str,
    ) -> Result<String, String> {
        let id = self.queue.ask_owner(
            session,
            queue::OwnerAsk::Merge {
                task: task.id.clone(),
                title: task.title.clone(),
                place: task.place.clone(),
                revision: revision.into(),
                learned: task.learned.clone(),
            },
        )?;
        // Look 11-17 v5 item 8: the task's board cards wait with the card, in the needs-decision column.
        if let Err(e) = crate::board::park_task(&self.home, task, true) {
            eprintln!(
                "board: task {} cards not moved to needs-decision: {e}",
                task.id
            );
        }
        Ok(id)
    }
    /// A closed task has no merge card: a task the user dropped kept its card, and a yes there would have kept
    /// lessons of a dropped branch (real look 11-17).
    pub(crate) fn retire_merge_card(&mut self, task: &str) -> Result<(), String> {
        // N24: its board cards leave Needs you too.
        let ledger = crate::ledger::Ledger::open(&self.home);
        if let Some(t) = ledger.list()?.into_iter().find(|t| t.id == task)
            && let Some(closed) = &t.closed
        {
            let seats: Vec<String> = t.seats.iter().map(|s| s.session.clone()).collect();
            if let Err(e) = crate::board::retire_task(&self.home, &seats, &closed.how) {
                eprintln!("board: task {task} cards not retired: {e}");
            }
        }
        // Ticket 1004: nor a stall card.
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Merge { task: t, .. } | queue::OwnerAsk::Stall { task: t, .. }) if t == task)
        })
    }
    /// Ticket 1004: a check-in's answer (`ledger::CheckIn::stalled`), on the task's card: raised once per stall,
    /// taken away when the task moved again.
    pub(crate) fn stall_card(&mut self, c: &crate::ledger::CheckIn, stalled: bool) {
        let task = &c.task;
        let done = if stalled {
            let ask = queue::OwnerAsk::Stall {
                task: task.id.clone(),
                title: task.title.clone(),
                place: task.place.clone(),
                seat: c.name.clone(),
                error: c.error.clone(),
            };
            self.queue.ask_owner(&c.session, ask).map(|_| ())
        } else {
            self.queue.answer_owner(
                |i| matches!(&i.owner, Some(queue::OwnerAsk::Stall { task: t, .. }) if *t == task.id),
            )
        };
        if let Err(e) = done {
            eprintln!("task {}: stall card not changed: {e}", task.id);
        }
    }
    /// Ticket 1004: a check-in waits for the judge. One per task: a newer one takes the place of one not judged yet,
    /// so what waits is bounded by the open tasks however many turns end while the judge is busy (they count as one).
    pub(crate) fn check_in_due(&mut self, c: crate::ledger::CheckIn) {
        self.check_ins.retain(|o| o.task.id != c.task.id);
        self.check_ins.push(c);
    }
    /// Ticket 1004: the server's loop after a tick. One judge at a time (`busy`), on its own thread: it takes what
    /// waits, judges each check-in with no lock held (git) and sets its card under the lock, until nothing waits.
    /// While it runs, a tick starts no other: one thread, one worktree read at a time.
    pub(crate) fn start_judge(
        registry: &std::sync::Arc<std::sync::Mutex<Sessions>>,
        home: &Path,
        busy: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        use std::sync::atomic::Ordering::SeqCst;
        let waits = registry.lock().is_ok_and(|s| !s.check_ins.is_empty());
        if !waits || busy.swap(true, SeqCst) {
            return;
        }
        let (registry, home, running) = (registry.clone(), home.to_path_buf(), busy.clone());
        let spawned = std::thread::Builder::new().spawn(move || {
            // Cleared on the way out even if a judge panics, so a later tick starts one again.
            struct Done(std::sync::Arc<std::sync::atomic::AtomicBool>);
            impl Drop for Done {
                fn drop(&mut self) {
                    self.0.store(false, SeqCst);
                }
            }
            let _done = Done(running);
            loop {
                let due = match registry.lock() {
                    Ok(mut sessions) => std::mem::take(&mut sessions.check_ins),
                    Err(_) => return,
                };
                if due.is_empty() {
                    return;
                }
                for c in due {
                    if let Some(stalled) = c.stalled(&home)
                        && let Ok(mut sessions) = registry.lock()
                    {
                        sessions.stall_card(&c, stalled);
                    }
                }
            }
        });
        if let Err(e) = spawned {
            eprintln!("check-ins: no thread ({e}); trying at the next tick");
            busy.store(false, SeqCst);
        }
    }
    /// The lessons on the task's open merge card, as the user sees them; `None` with no card.
    pub(crate) fn merge_lessons(&self, task: &str) -> Option<Vec<crate::ledger::Lesson>> {
        self.queue
            .owner_items()
            .into_iter()
            .find_map(|i| match i.owner {
                Some(queue::OwnerAsk::Merge {
                    task: t, learned, ..
                }) if t == task => Some(learned),
                _ => None,
            })
    }
    /// Ticket 990 slice h: the notes a seat reads, in front of the first prompt a lead sends it. Once per seat.
    pub(crate) fn with_notes(&self, id: &str, text: String) -> String {
        let ledger = crate::ledger::Ledger::open(&self.home);
        let Some(task) = ledger.of_seat(id) else {
            return text;
        };
        let Some(seat) = task.seats.iter().find(|s| s.session == id && !s.briefed) else {
            return text;
        };
        if let Err(e) = ledger.briefed(id) {
            eprintln!("ledger: seat not marked as briefed: {e}");
        }
        // Slice i: the seat's role and its task open the prompt, so a seat needs no brief of its own to know them.
        let mut head = String::new();
        if let Some(role) = crate::roles::Roles::open(&self.home).get(&seat.role) {
            head += &format!("You sit on a task as {}. {}\n", role.name, role.job);
        }
        head += &format!("Task {}: {}\n", task.id, task.title);
        for a in &task.accept {
            head += &format!("- accept: {a}\n");
        }
        for n in &task.told {
            head += &format!("- the user told {}: \"{}\"\n", n.name, n.text);
        }
        let notes =
            crate::notes::Notes::open(&self.home).for_seat(Some(&task.place), Some(&seat.role));
        head += &crate::notes::quote(&notes);
        format!("{head}\n{text}")
    }
    /// Ticket 990 slice i: a lead's proposal of a new role, as a card for the owner.
    pub(crate) fn ask_role(
        &mut self,
        session: &str,
        role: crate::roles::Role,
        why: String,
        place: PathBuf,
    ) -> Result<String, String> {
        self.queue
            .ask_owner(session, queue::OwnerAsk::Role { role, why, place })
    }
    /// A bot offers the user a new bot, as a card for the owner. Only the session the core itself marked as a bot's
    /// seat may: a worker says it to its lead, and a session that only carries a bot's name is no seat.
    pub(super) fn bot_offer(
        &mut self,
        caller: &crate::grants::Caller,
        name: &str,
        job: &str,
        why: &str,
    ) -> Response {
        let team = crate::team::Team::open(&self.home);
        let from = self
            .entries
            .get(&caller.id)
            .and_then(|e| e.meta.teammate.clone())
            .filter(|id| self.seat_of(id).as_deref() == Some(caller.id.as_str()))
            .and_then(|id| team.list().ok()?.into_iter().find(|t| t.id == id))
            .ok_or("only a bot offers a bot: a worker says it to its lead")?;
        let (name, job, why, by) = team.offer(&from, name, job, why)?;
        let place = from.project.clone().unwrap_or_else(|| team.home());
        self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Bot {
                name,
                job,
                why,
                from: by,
                place,
            },
        )?;
        Ok(Reply::Ack)
    }
    /// Ticket 1099 panel 4: a lead's ask to change its place's live seats, as a card for the owner.
    pub(crate) fn ask_cap(
        &mut self,
        session: &str,
        place: PathBuf,
        was: u32,
        cap: u32,
        why: String,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Cap {
                place,
                was,
                cap,
                why,
            },
        )
    }
    /// Home view change 4: the Home lead's goal for a project's lead, as a card for the owner.
    pub(crate) fn ask_goal(
        &mut self,
        session: &str,
        place: PathBuf,
        lead: String,
        from: String,
        text: String,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Goal {
                place,
                lead,
                from,
                text,
            },
        )
    }
    /// Ticket 990 slice g: who asks the ledger. The owner names a project (none: every place); a session's place is
    /// its lead's, or its own room's project when it works for no lead.
    pub(crate) fn task_caller(
        &self,
        caller: Option<&crate::grants::Caller>,
        project: Option<&Path>,
    ) -> Result<crate::ledger::Who, String> {
        let team = crate::team::Team::open(&self.home);
        let Some(caller) = caller else {
            let place = project
                .map(fs::canonicalize)
                .transpose()
                .map_err(|e| e.to_string())?;
            let lead = place
                .as_ref()
                .and_then(|p| team.lead_of(team.place(p).as_deref()))
                .map(|t| t.id);
            return Ok(crate::ledger::Who {
                place,
                lead,
                decides: true,
                session: None,
                name: "user".into(),
            });
        };
        let meta = &self.entries.get(&caller.id).ok_or("unknown session")?.meta;
        let lead = self.team_lead_of(&caller.id);
        let place = match &lead {
            Some(lead) => team
                .list()?
                .into_iter()
                .find(|t| t.id == *lead)
                .map(|t| t.project.unwrap_or_else(|| team.home())),
            None => self.room_project(&caller.id),
        };
        Ok(crate::ledger::Who {
            place: Some(place.ok_or("no place for this session")?),
            decides: lead
                .as_ref()
                .is_some_and(|l| self.seat_of(l).as_deref() == Some(caller.id.as_str())),
            lead,
            session: Some(caller.id.clone()),
            name: meta.label.clone(),
        })
    }
    /// Ticket 990: one line in the project's room about a lead's team, to the lead's live seat (the person when the
    /// lead is not running, or did it itself): the window draws the lead's list of delegated work from these, and the
    /// lead hears what it did not do itself.
    /// Look 1117 v12 S2-B: a yes on a merge card while the lead's seat was not running went to the room log only, and
    /// a resumed conversation gets no brief, so the lead never heard it. The yes is kept in the ledger: a resumed run
    /// of a lead's seat hears each yes still waiting on it, as its next prompt.
    pub(super) fn merge_yes_on_resume(&mut self, id: &str) {
        let Some(lead) = self.entries.get(id).and_then(|e| e.meta.teammate.clone()) else {
            return;
        };
        let tasks = match crate::ledger::Ledger::open(&self.home).list() {
            Ok(tasks) => tasks,
            Err(e) => {
                eprintln!("merge yes for {id} not read: {e}");
                return;
            }
        };
        for t in tasks
            .iter()
            .filter(|t| t.closed.is_none() && t.lead.as_deref() == Some(lead.as_str()))
        {
            if let Some(yes) = &t.merge
                && let Err(e) =
                    self.prompt_as_user(id, merge_yes_line(&t.id, &t.title, &yes.revision))
            {
                eprintln!("merge yes for task {} not sent to {id}: {e}", t.id);
            }
        }
    }
    pub(crate) fn team_note(
        &mut self,
        project: &Path,
        lead: &str,
        actor: Option<&str>,
        body: String,
        note: crate::room::TeamNote,
    ) {
        let seat = self.seat_of(lead).filter(|s| Some(s.as_str()) != actor);
        let to = seat.as_deref().unwrap_or(crate::room::PERSON);
        match crate::room::Log::open(&self.home, project).team(to, body, note) {
            Ok(_) => {
                if let Some(seat) = seat {
                    self.room_told(&seat);
                }
            }
            Err(e) => eprintln!("team note not written: {e}"),
        }
    }
    /// Ticket 990: the user spoke to a sub-bot directly (the window's prompt to a session that works for a lead):
    /// the lead learns it in one line. A prompt to the lead itself, or with no lead running, says nothing.
    pub(super) fn told(&mut self, id: &str, text: &str) {
        // Ticket 993: the user is here now, so the session is no unattended scheduled run any more.
        if self
            .entries
            .get_mut(id)
            .is_some_and(|e| e.meta.schedule.take().is_some())
            && let Err(e) = self.save()
        {
            eprintln!("scheduled-run mark not cleared on disk yet: {e}");
        }
        let Some(meta) = self.entries.get(id).map(|e| &e.meta) else {
            return;
        };
        let lead = self
            .recorded_worktree(&meta.cwd)
            .and_then(|w| w.team)
            .or_else(|| self.team_lead_of(id));
        let (label, project, cwd) = (meta.label.clone(), meta.project.clone(), meta.cwd.clone());
        // After one Codex look: the line goes into the room's log and to another agent, so what the logs mask (known
        // tokens, key-like values) is masked here too, before the cut.
        let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = String::from_utf8_lossy(&crate::logs::mask(line.as_bytes())).into_owned();
        let name = if label.is_empty() {
            id[..id.len().min(6)].to_string()
        } else {
            label
        };
        // Ticket 990 slice g: the task's record takes the user's words whether a lead runs or not, so a lead's next
        // conversation reads them.
        match crate::ledger::Ledger::open(&self.home).told(id, &cwd, &name, &line, queue::now_ms())
        {
            Ok(true) => {
                if let Some(task) = crate::ledger::Ledger::open(&self.home).of_seat(id) {
                    crate::events::tasks(&task.place);
                }
            }
            Ok(false) => {}
            Err(e) => eprintln!("ledger: what the user told {name} was not recorded: {e}"),
        }
        let Some(lead) = lead else { return };
        let Some(seat) = self.seat_of(&lead).filter(|s| s != id) else {
            return;
        };
        let Some(room) = self.room_project(&seat).filter(|r| *r == project) else {
            return;
        };
        let cut: String = line.chars().take(300).collect();
        let more = if cut.len() < line.len() { "…" } else { "" };
        self.team_note(
            &room,
            &lead,
            None,
            format!("The user told {name} directly: \"{cut}{more}\""),
            crate::room::TeamNote {
                what: "told".into(),
                worktree: None,
                name: None,
                branch: None,
                merged: None,
                seat: Some(id.into()),
            },
        );
    }
    pub(crate) fn session_of(&mut self, id: &str) -> Result<Session, String> {
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 994: an ACP seat's model and thinking level, set once its agent has listed its options.
    pub(crate) fn seat_wants(&mut self, id: &str, model: Option<String>, effort: Option<String>) {
        if let Some(acp) = self.entries.get_mut(id).and_then(|e| e.acp.as_mut()) {
            acp.want(model, effort);
        }
    }
    /// Look v9 B N-S3-6: the level a role's seat on a task opened at (`task staff`), as a teammate's seat has it. A
    /// teammate's own seat keeps the level its teammate opened it at.
    pub(crate) fn role_seat_level(
        &mut self,
        id: &str,
        level: crate::team::Level,
    ) -> Result<(), String> {
        let meta = &mut self.entry(id)?.meta;
        if meta.teammate.is_some() || meta.level == Some(level) {
            return Ok(());
        }
        meta.level = Some(level);
        self.save()
    }
    /// Ticket 990: marks a session as a teammate's seat. The session already runs, so a failed save is logged; the
    /// next save writes it.
    pub(crate) fn seat_session(
        &mut self,
        id: &str,
        teammate: &str,
        level: Option<crate::team::Level>,
    ) -> Result<Session, String> {
        self.entry(id)?.meta.teammate = Some(teammate.into());
        self.entry(id)?.meta.level = level; // ticket 992
        self.adopt_workers(id, teammate);
        if let Err(e) = self.save() {
            eprintln!("teammate seat not saved yet: {e}");
        }
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 990 slice g (seen in the recovery experiment with real Claude: reviewers finished and the lead's new
    /// conversation never heard it, because their wake lines went to the closed session that had started them). A
    /// teammate's new seat takes over the running sessions its earlier seats started, and the seats of its tasks:
    /// their parent is this seat from now, so wake lines, unaddressed room messages and the room's project follow.
    fn adopt_workers(&mut self, seat: &str, teammate: &str) {
        let ledger = crate::ledger::Ledger::open(&self.home)
            .list()
            .unwrap_or_default();
        let earlier = |parent: &str| {
            parent != seat
                && self
                    .entries
                    .get(parent)
                    .is_none_or(|p| !p.agent_live() && p.meta.teammate.as_deref() == Some(teammate))
        };
        let adopted: Vec<String> = self
            .entries
            .values()
            .filter(|e| e.meta.id != seat && e.agent_live())
            .filter(|e| match e.meta.parent.as_deref() {
                // Started by an earlier seat of this teammate that no longer runs.
                Some(parent) if self.entries.contains_key(parent) => earlier(parent),
                // Its starter's row is gone: it is this teammate's when it sits on one of its tasks.
                Some(_) => ledger.iter().any(|t| {
                    t.closed.is_none()
                        && t.lead.as_deref() == Some(teammate)
                        && t.seats.iter().any(|s| s.session == e.meta.id)
                }),
                None => false,
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for child in adopted {
            if let Some(entry) = self.entries.get_mut(&child) {
                entry.meta.parent = Some(seat.into());
            }
            self.grants.parents.insert(child, seat.into());
        }
    }
    /// Ticket 981: a schedule's task, sent as the owner's own prompt (the schedule is the owner's).
    /// A session at a question refuses a send (a new seat may show a startup question at once: a seat's Open failed
    /// with "agent_blocked" 1 to 3 times in 16 under load, look 11-17). The prompt then waits in the session's queue
    /// and goes in once the agent takes input, as the window's held message does.
    pub(crate) fn prompt_as_user(&mut self, id: &str, text: String) -> Result<(), String> {
        match self.send("user", id, text.clone(), vec![], true) {
            Err(e) if e == "agent_blocked" || e == "screen not current, try again" => self
                .begin_send("user", id, text, vec![], true, "queued")
                .map(|_| ()),
            sent => sent.map(|_| ()),
        }
    }
    /// Ticket 1034: a renamed teammate's seats (open, or resumable) take the new name as their label, which the tab,
    /// the header and the room read. A seat whose tab the user renamed no longer carries the old name and keeps its own.
    pub(crate) fn teammate_renamed(
        &mut self,
        teammate: &str,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        let mut changed = false;
        for e in self.entries.values_mut() {
            if e.meta.teammate.as_deref() == Some(teammate)
                && e.meta.state != SessionState::Closed
                && e.meta.label == old
            {
                e.meta.label = new.to_string();
                changed = true;
            }
        }
        if changed { self.save() } else { Ok(()) }
    }
    /// Look 1117 v11 (C NC3): a removed teammate leaves nothing running as it. Its seat closes as Close session does
    /// (a running one is stopped, then its Closed row goes, so no tab or Resume is left), and its schedules switch off:
    /// they stay listed, and one switched on again after a teammate of the same name was added runs as that teammate
    /// (`schedule::teammate_of`).
    /// Codex look of wave 18 (NOTE): what could not be stopped is returned, so the owner is told instead of a success.
    /// Look 1117 v13 Home S3-1: the room keeps each closed seat's `name`, as its row goes while its lines stay.
    pub(crate) fn teammate_removed(&mut self, teammate: &str, name: &str) -> Result<(), String> {
        let mut left: Vec<String> = vec![];
        let seats: Vec<String> = self
            .entries
            .values()
            .filter(|e| {
                e.meta.teammate.as_deref() == Some(teammate) && e.meta.state != SessionState::Closed
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for id in seats {
            if let Some(room) = self.room_project(&id)
                && let Err(e) = crate::room::Log::open(&self.home, &room).name_seat(&id, name)
            {
                eprintln!("teammate {teammate} removed: the room keeps no name for seat {id}: {e}");
            }
            let running = self.entries[&id].meta.state == SessionState::Running;
            let closed = self.close(&id, true, false).and_then(|r| {
                if running && self.entries.contains_key(&id) {
                    self.close(&id, true, false)
                } else {
                    Ok(r)
                }
            });
            if let Err(e) = closed {
                eprintln!("teammate {teammate} removed: seat {id} not closed: {e}");
                left.push(format!(
                    "its seat could not be stopped ({e}); stop it from its row"
                ));
            }
        }
        let listed = self.schedules.list().unwrap_or_else(|e| {
            left.push(format!(
                "its schedules could not be read ({e}); switch them off in Schedules"
            ));
            vec![]
        });
        let on: Vec<String> = listed
            .into_iter()
            .filter(|e| e.run.teammate.as_deref() == Some(teammate) && !e.paused)
            .map(|e| e.id)
            .collect();
        for id in &on {
            match self.schedules.pause(
                id,
                true,
                crate::queue::now_ms(),
                &crate::usage::local_offset,
            ) {
                Ok(()) => self.drop_failed_card(id),
                Err(e) => {
                    eprintln!("teammate {teammate} removed: schedule {id} not switched off: {e}");
                    left.push(format!(
                        "a schedule could not be switched off ({e}); switch it off in Schedules"
                    ));
                }
            }
        }
        if !on.is_empty() {
            self.schedules_changed();
        }
        if left.is_empty() {
            Ok(())
        } else {
            Err(format!("The teammate is removed, but {}.", left.join("; ")))
        }
    }
}
