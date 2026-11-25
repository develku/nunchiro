//! Answering a waiting item: a permission, question, dialog or card, from the owner or a session.
use super::*;
impl Sessions {
    pub(super) fn answer(&mut self, id: &str, answer: queue::Answer, confirmed: bool) -> Response {
        /// The deny message Claude reads while its turn stops; the user's own words follow as their next message.
        const DENY_NOTE_FOLLOWS: &str = "The user denied this. Do not retry it; their instruction follows as their next message.";
        /// Look v34 S3-4: a deny with no instruction yet (the card above the composer) stops the turn the same way.
        const DENY_WAIT: &str =
            "The user denied this. Do not retry it; wait for their next message.";
        // V2-8e: a deny with an instruction is a deny; the instruction goes as the hook's message, else as the user's next
        // message once the agent is back at its prompt (the delivery queue waits for that). Empty text sends none.
        let (answer, note) = match answer {
            // Look v10 N10-S2-2: an owner item (a merge card's "Not yet" with a reason) takes the text itself; split
            // here, it was looked up among the agents' items, never found ("not there anymore").
            queue::Answer::DenyWith { text } if self.queue.owner_decision(id).is_none() => {
                (queue::Answer::Deny, Some(queue::deny_note(&text)))
            }
            other => (other, None),
        };
        // Look v34 S3-4: an empty instruction still stops a hooked Claude's turn (as Claude Code's own "No, and tell
        // Claude what to do differently"), so what the owner types next in the composer reaches it at once.
        if note.as_deref() == Some("")
            && let Ok(item) = self.queue.decision(id)
            && item.kind == queue::Kind::Permission
            && self.entry(&item.session_id)?.meta.kind == AgentKind::Claude
        {
            let now = queue::now_ms();
            if self.queue.hook_live(&item, now) {
                self.answer_inner(id, answer, confirmed, Some(DENY_WAIT), true, now)?;
                self.interrupted(&item.session_id)?;
                return Ok(Reply::Ack);
            }
        }
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            // Typed at the agent's prompt, a leading `/` or `!` would run a slash or shell command, and `#` would write
            // the agent's memory (CLAUDE.md, agent config).
            if note.starts_with(['/', '!', '#']) {
                return Err("an instruction cannot start with /, ! or #".into());
            }
            let item = self.queue.decision(id)?;
            if item.kind != queue::Kind::Permission {
                return Err("a deny instruction needs a permission request".into());
            }
            let session = item.session_id.clone();
            let now = queue::now_ms();
            let hooked = self.queue.hook_live(&item, now);
            // Look 11-17 B13: Claude reads a hook's deny message as tool output, not as the user ("That text is not
            // from you"), and runs the command again. So its hook denies and stops the turn, and the note goes in as the
            // user's own next message once Claude is back at its prompt. Another agent's hook takes the note as before.
            let claude = self.entry(&session)?.meta.kind == AgentKind::Claude;
            if hooked && claude {
                self.answer_inner(id, answer, confirmed, Some(DENY_NOTE_FOLLOWS), true, now)?;
                self.interrupted(&session)?;
            } else {
                self.answer_inner(id, answer, confirmed, Some(&note), false, now)?;
            }
            // A hook still waiting takes the note as its own message; nothing is left to send.
            if hooked && !claude {
                return Ok(Reply::Ack);
            }
            // Queued, never written now: the prompt may still be on screen, where typed text would pick its options.
            let send = self.begin_send("user", &session, note, vec![], true, "queued")?;
            self.deny_notes.insert(send.id.clone());
            return Ok(Reply::Delivery { send });
        }
        self.answer_inner(id, answer, confirmed, None, false, queue::now_ms())
    }
    /// V2-8e: an item as the window sees it (`Queue::annotate` with its session's folder); without a session it stays
    /// risky.
    pub(super) fn annotated(&self, mut item: queue::Decision) -> queue::Decision {
        if let Some(entry) = self.entries.get(&item.session_id) {
            self.queue
                .annotate(&mut item, &entry.meta.cwd, entry.meta.home_lock);
        }
        item
    }
    fn answer_inner(
        &mut self,
        id: &str,
        answer: queue::Answer,
        confirmed: bool,
        note: Option<&str>,
        interrupt: bool,
        now: u64,
    ) -> Response {
        // v1a-23: an owner item. Only owner callers get here with one: session callers' `check_agent` looks the item
        // up with `queue.decision`, which never finds owner items.
        if let Some(item) = self.queue.owner_decision(id) {
            // Needs 225: an agent's Codex reset ask. Allow spends one off this lock (codex_reset::answered); both are logged.
            if let Some(ask @ queue::OwnerAsk::CodexReset { .. }) = &item.owner {
                let allow = match answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny => false,
                    _ => return Err("an owner item takes allow_once or deny".into()),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                let title = self
                    .entries
                    .get(&item.session_id)
                    .map(|e| e.meta.label.clone());
                crate::codex_reset::answered(
                    &self.home,
                    ask,
                    &item.session_id,
                    title.as_deref(),
                    allow,
                );
                return Ok(Reply::Ack);
            }
            // Ticket 990 slice h: the merge card. The yes is recorded for the reviewed files only, and the lead
            // hears the answer in the room.
            if let Some(queue::OwnerAsk::Merge {
                task,
                title,
                place,
                revision,
                ..
            }) = &item.owner
            {
                let (yes, why) = match &answer {
                    queue::Answer::AllowOnce => (true, String::new()),
                    queue::Answer::Deny => (false, String::new()),
                    queue::Answer::DenyWith { text } => (false, queue::deny_note(text)),
                    _ => return Err("a merge card takes allow_once or deny".into()),
                };
                let ledger = crate::ledger::Ledger::open(&self.home);
                // The task closed while its card was open (its worktree was removed): the card goes, nothing is merged.
                if ledger
                    .list()?
                    .iter()
                    .any(|t| t.id == *task && t.closed.is_some())
                {
                    self.queue.answer_owner(|i| i.id == id)?;
                    crate::events::tasks(place);
                    return Err(format!("task {task} is closed; there is nothing to merge"));
                }
                // Q9 tt-J4-1: the yes is recorded before the card goes, so a failed write leaves Yes to press again.
                // Codex round 2: a no clears a yes an earlier failed attempt left, so a resumed lead never hears it.
                let recorded = if yes {
                    ledger.merge_ok(task, revision, now).map(|_| ())
                } else {
                    ledger.merge_no(task, now)
                };
                if let Err(e) = recorded {
                    let what = if yes { "yes" } else { "no" };
                    return Err(format!("the {what} was not recorded: {e}"));
                }
                if let Err(e) = self.queue.answer_owner(|i| i.id == id) {
                    // The card stays, so its yes goes too: a yes reaches the lead only with its card answered.
                    if yes && let Err(undo) = ledger.merge_no(task, now) {
                        eprintln!("merge yes for task {task} not taken back: {undo}");
                    }
                    return Err(e);
                }
                // Look 11-17 v5 item 8: answered, the task's cards leave the needs-decision column (a merge then
                // retires them to done).
                if let Some(t) = ledger.list()?.iter().find(|t| t.id == *task)
                    && let Err(e) = crate::board::park_task(&self.home, t, false)
                {
                    eprintln!("board: task {task} cards not moved back: {e}");
                }
                crate::events::tasks(place);
                let body = match (yes, why.is_empty()) {
                    (true, _) => merge_yes_line(task, title, revision),
                    (false, true) => {
                        format!("The user said not yet to merging task {task} ({title}).")
                    }
                    (false, false) => {
                        format!("The user said not yet to merging task {task} ({title}): \"{why}\"")
                    }
                };
                if let Some(lead) = ledger
                    .list()?
                    .iter()
                    .find(|t| t.id == *task)
                    .and_then(|t| t.lead.clone())
                {
                    self.team_note(
                        place,
                        &lead,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "merge_yes" } else { "merge_no" }.into(),
                            worktree: None,
                            name: Some(title.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 990 slice i: the role card. A yes adds the role to the user's roles; the lead hears the answer.
            if let Some(queue::OwnerAsk::Role { role, place, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a role card takes allow_once or deny".into()),
                };
                if yes {
                    crate::roles::Roles::open(&self.home).save(role.clone())?;
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!(
                            "The user added the role {}: staff it with `nunchiro task staff <task> \"{}\"`.",
                            role.name, role.name
                        )
                    } else {
                        format!("The user said not now to the role {}.", role.name)
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "role_yes" } else { "role_no" }.into(),
                            worktree: None,
                            name: Some(role.name.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1113: the owner uses the same close path as their own command. A failed close keeps the card.
            if let Some(queue::OwnerAsk::SessionClose {
                target,
                label,
                place,
                ..
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a close-session card takes allow_once or deny".into()),
                };
                if yes {
                    self.close(target, true, false)?;
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let who = self
                    .task_caller(
                        Some(&crate::grants::Caller {
                            id: item.session_id.clone(),
                            project: place.clone(),
                        }),
                        None,
                    )
                    .ok();
                if let Some(who) = who
                    && let (Some(lead), Some(room)) = (who.lead, who.place)
                {
                    self.team_note(
                        &room,
                        &lead,
                        None,
                        if yes {
                            format!("The user closed {label} ({target}).")
                        } else {
                            format!("The user said not now to closing {label} ({target}).")
                        },
                        crate::room::TeamNote {
                            what: if yes {
                                "session_closed"
                            } else {
                                "session_close_no"
                            }
                            .into(),
                            worktree: None,
                            name: Some(label.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1099 panel 4: the live-seat card. The yes writes the cap as Settings > Team does (`Ledger::set_cap`);
            // a yes that cannot be written keeps the card, as the role card's. The lead hears the answer.
            if let Some(queue::OwnerAsk::Cap { place, cap, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a live-seat card takes allow_once or deny".into()),
                };
                if yes {
                    crate::ledger::Ledger::open(&self.home).set_cap(place, *cap)?;
                    crate::events::tasks(place);
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!("The user changed the live seats here to {cap}.")
                    } else {
                        format!("The user said not now to {cap} live seats.")
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "cap_yes" } else { "cap_no" }.into(),
                            worktree: None,
                            name: Some(cap.to_string()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 993: the schedule card. Only this yes adds or changes the entry; the lead that asked hears the
            // answer in one line. A yes that cannot be applied (the teammate is gone, the date has passed) is an
            // error and the card stays, as the role card's.
            if let Some(queue::OwnerAsk::Schedule {
                change,
                id: entry,
                run,
                when,
                place,
                line,
                ..
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a schedule card takes allow_once or deny".into()),
                };
                // Look 11-17 v8 (Home S2-B): a failed run's card. Yes: it runs again now, off this lock (the schedule
                // timer takes it within a second; a new failure is a new card). No: only the card goes; the entry
                // keeps its failed run until its next good run or an edit.
                if change == "failed" {
                    self.queue.answer_owner(|i| i.id == id)?;
                    let entry = entry.clone().unwrap_or_default();
                    if yes {
                        if !self.schedules.list()?.iter().any(|e| e.id == entry) {
                            return Err("no such schedule".into());
                        }
                        self.schedule_reruns.push(entry);
                    }
                    return Ok(Reply::Ack);
                }
                let (now, offset) = (queue::now_ms(), &crate::usage::local_offset);
                let done = match (change.as_str(), entry) {
                    ("add", None) => "added",
                    ("pause", Some(_)) => "paused",
                    ("resume", Some(_)) => "resumed",
                    ("remove", Some(_)) => "removed",
                    _ => return Err("unknown schedule change".into()),
                };
                match entry {
                    _ if !yes => {}
                    None => {
                        let known = self.known_projects();
                        self.schedules.add_on(
                            run.clone(),
                            when.clone(),
                            None,
                            &known,
                            now,
                            offset,
                        )?;
                    }
                    Some(entry) if done == "removed" => self.schedules.remove(entry)?,
                    Some(entry) => self.schedules.pause(entry, done == "paused", now, offset)?,
                }
                if let (true, "paused", Some(entry)) = (yes, done, entry) {
                    self.drop_failed_card(entry);
                }
                if yes {
                    self.schedules_changed();
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!("The user {done} the schedule: {line}")
                    } else {
                        format!("The user said not now to the schedule ({change}): {line}")
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "schedule_yes" } else { "schedule_no" }.into(),
                            worktree: None,
                            name: Some(run.label.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1005: the tidy card. A yes asks the seat to tidy the file (opened when it is not running, as a sent
            // goal); a no only dismisses it.
            if let Some(queue::OwnerAsk::Tidy { teammate, file, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a tidy card takes allow_once or deny".into()),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                if yes {
                    self.goal_wakes.push((
                        teammate.clone(),
                        format!(
                            "The user asks you to tidy {file} now: it is over the 6 KB your brief quotes, so the rest does not reach you. Keep the user's rules and lasting facts, merge or drop old log lines, and bring it under 6 KB. Then say in one line what you removed."
                        ),
                    ));
                }
                return Ok(Reply::Ack);
            }
            // Home view change 4: the goal card. Send writes the goal into the project's room, marked as from Home and
            // approved by the user, and wakes the project's lead with it; Not now tells the Home lead.
            if let Some(queue::OwnerAsk::Goal {
                place,
                lead,
                from,
                text,
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a goal card takes allow_once or deny".into()),
                };
                let team = crate::team::Team::open(&self.home);
                let name = place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !yes {
                    self.queue.answer_owner(|i| i.id == id)?;
                    if let Some(home_lead) = team.lead_of(None) {
                        self.team_note(
                            &team.home(),
                            &home_lead.id,
                            None,
                            format!(
                                "The user said not now to the goal for {name}'s lead: \"{text}\""
                            ),
                            crate::room::TeamNote {
                                what: "goal_no".into(),
                                worktree: None,
                                name: Some(name),
                                branch: None,
                                merged: None,
                                seat: None,
                            },
                        );
                    }
                    return Ok(Reply::Ack);
                }
                // The card goes only once the goal is in the room: a refusal here (another lead, a full room, a write
                // that failed) leaves it waiting, so the user can try again or say Not now (security look 11-17).
                // The lead it was asked for, still the place's lead: a lead changed meanwhile gets no goal unasked.
                if team.lead_of(Some(place)).is_none_or(|l| l.id != *lead) {
                    return Err(format!(
                        "{name} has another leader or none now: the goal was not sent"
                    ));
                }
                // Look 1117 home S3: "(Steward)" after "the user" read as if Steward were the user.
                let body =
                    format!("Goal from {from} (the Home lead), approved by the user: {text}");
                let to = self.seat_of(lead);
                if let Err(e) = crate::room::Log::open(&self.home, place).team(
                    to.as_deref().unwrap_or(crate::room::PERSON),
                    body.clone(),
                    crate::room::TeamNote {
                        what: "goal".into(),
                        worktree: None,
                        name: Some(from.clone()),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                ) {
                    return Err(format!("the goal was not sent: {e}"));
                }
                self.goal_wakes
                    .push((lead.clone(), format!("{body}\n\n{GOAL_NEXT}")));
                self.queue.answer_owner(|i| i.id == id)?;
                // Look 1117 home S2-6: the Home lead hears Send as it hears Not now.
                if let Some(home_lead) = team.lead_of(None) {
                    self.team_note(
                        &team.home(),
                        &home_lead.id,
                        None,
                        format!("The user sent your goal to {name}'s lead: \"{text}\""),
                        crate::room::TeamNote {
                            what: "goal_yes".into(),
                            worktree: None,
                            name: Some(name),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1003: an open-loop card. A yes keeps the row ("add") or closes it ("close", "overdue"); a no
            // changes nothing in the rows. The Home lead hears the answer to a card it asked for.
            if let Some(queue::OwnerAsk::Loop { change, row, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("an open-loop card takes allow_once or deny".into()),
                };
                let loops = crate::loops::Loops::open(&self.home);
                let now = queue::now_ms();
                let words = crate::loops::words(row);
                // The card goes only once the row is written: a refusal leaves it waiting.
                let (body, what) = match (change.as_str(), yes) {
                    ("add", true) => {
                        let kept = loops.add(row.clone(), now)?;
                        self.loops_checked = 0; // a row kept with a past date is asked about at the next tick
                        (
                            format!(
                                "The user said yes: open loop {} is kept ({words}).",
                                kept.id
                            ),
                            "loop_yes",
                        )
                    }
                    ("add", false) => (
                        format!("The user said no to keeping the open loop: {words}."),
                        "loop_no",
                    ),
                    (_, true) => {
                        // Closed meanwhile (the user's shell, another card): the card just goes.
                        if loops.list()?.iter().any(|r| r.id == row.id) {
                            loops.close(&row.id, now)?;
                        }
                        self.retire_loop_cards(&row.id)?;
                        (
                            format!("The user closed open loop {} ({words}).", row.id),
                            "loop_closed",
                        )
                    }
                    (_, false) => (
                        format!("The user keeps open loop {} open ({words}).", row.id),
                        "loop_no",
                    ),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                if change != "overdue" || yes {
                    self.loop_note(body, what, row);
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1002 lane 2: the Outbox card. Send (allow_once) starts its 10 s undo; Undo (deny within it) puts it
            // back; Discard (deny) is No; Open by hand (choose 1) opens a new message or event from the same arguments.
            if let Some(queue::OwnerAsk::Outward {
                tool,
                args,
                hash,
                yes_at,
                ..
            }) = &item.owner
            {
                let now = queue::now_ms();
                if crate::approval::outward_call_hash(tool, args) != *hash {
                    return Err(
                        "this card's call does not match its hash: nothing was approved".into(),
                    );
                }
                let shown = crate::outbox::check(tool, args)?;
                let what = crate::outbox::words(&shown);
                // Look v20 S1: Undo is honoured until the tick approves the card (`expire_outbox`, under this same
                // lock), not by the clock alone: a card still here is not approved, however late the Undo.
                if yes_at.is_some() {
                    return match answer {
                        queue::Answer::Deny | queue::Answer::DenyWith { .. } => {
                            self.queue.outbox_yes(id, None);
                            Ok(Reply::Ack)
                        }
                        _ => Err("it is already sending: only Undo answers it now".into()),
                    };
                }
                return match answer {
                    queue::Answer::AllowOnce => {
                        self.queue.outbox_yes(id, Some(now));
                        Ok(Reply::Ack)
                    }
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => {
                        self.queue.answer_owner(|i| i.id == id)?;
                        self.outbox_note(
                            format!("The user said no to {what}. Do not send it another way."),
                            "outbox_no",
                            &shown,
                        );
                        Ok(Reply::Ack)
                    }
                    queue::Answer::Choose { index: 1 } => {
                        let target = match shown.kind {
                            "event" => {
                                let dir = self.home.join("outbox");
                                store::private_dir(&dir)?;
                                // shortcut: one small file per opened event is kept; clean the folder if it ever grows.
                                let file = dir.join(format!("{id}.ics"));
                                store::atomic_write(
                                    &file,
                                    crate::outbox::ics(id, &shown, now)?.as_bytes(),
                                )?;
                                file.to_string_lossy().into_owned()
                            }
                            _ => crate::outbox::mailto(&shown),
                        };
                        crate::outbox::open(target)?;
                        self.queue.answer_owner(|i| i.id == id)?;
                        self.keep_domains(&shown);
                        let app = if shown.kind == "event" {
                            "Calendar"
                        } else {
                            "Mail"
                        };
                        self.outbox_note(
                            format!("The user opened {what} in {app} to send or save it themselves. Do not send it."),
                            "outbox_hand",
                            &shown,
                        );
                        Ok(Reply::Ack)
                    }
                    _ => Err("an Outbox card takes allow_once, deny or choose 1".into()),
                };
            }
            return match (answer, item.owner) {
                (queue::Answer::Deny, _) => {
                    self.queue.answer_owner(|i| i.id == id)?;
                    Ok(Reply::Ack)
                }
                (
                    queue::Answer::AllowOnce,
                    Some(queue::OwnerAsk::PermissionAnswers { project }),
                ) => self.permission_answers(&project, true),
                (queue::Answer::AllowOnce, Some(queue::OwnerAsk::LeadAccounts)) => {
                    let on = [(crate::accounts::LEADS_ANY.to_string(), true.into())];
                    self.quit_settings(LifetimePatch {
                        features: Some(on.into()),
                        ..Default::default()
                    })?;
                    self.queue.answer_owner(|i| i.id == id)?;
                    Ok(Reply::Ack)
                }
                // r2 (S2): a widget or integration source is approved only in the permission sheet, at the hash the
                // sheet shows (its `approval_grant` / `board_source_grant` clears the item).
                (
                    queue::Answer::AllowOnce,
                    Some(queue::OwnerAsk::Approval { .. } | queue::OwnerAsk::Setup { .. }),
                ) => Err("review it in the permission sheet to approve it".into()),
                _ => Err("an owner item takes allow_once or deny".into()),
            };
        }
        // Look v20 S1: an Undo that came after the approval says so, not "decision not found".
        if self.queue.outbox_approved(id) {
            return Err(OUTBOX_TOO_LATE.into());
        }
        let item = self.queue.decision(id)?;
        // Seventh look (B S2-1): an answered prompt stays on the agent's screen until the agent draws again. The
        // re-read of a still screen (`tick`) waits that out, so the prompt just answered is never a card a second time
        // (its answer would be typed into whatever the agent shows next).
        if let Some(entry) = self.entries.get_mut(&item.session_id) {
            entry.observer.reread = Some(std::time::Instant::now() + REREAD_AFTER_ANSWER);
        }
        if !item.actionable || item.reconciled || !self.entry(&item.session_id)?.agent_live() {
            return Err("decision needs live reconciliation".into());
        }
        // V2-8e r3: a permission takes allow once or deny only, from every caller: a raw `choose` would type an option's
        // keys past the risky gate below (the window never sends one).
        if item.kind == queue::Kind::Permission && matches!(answer, queue::Answer::Choose { .. }) {
            return Err(
                "a permission takes allow once or deny only (other options: answer in the terminal)".into(),
            );
        }
        // V2-8e: a risky permission is allowed only from the panel card, which confirms it (focus, then Enter); the
        // strip, the chat card, the phone and keys get this refusal.
        if matches!(answer, queue::Answer::AllowOnce)
            && item.kind == queue::Kind::Permission
            && !confirmed
            && self.annotated(item.clone()).risky
        {
            return Err("risky: allow it in the decision card (focus, then Enter)".into());
        }
        // V2-4a: an ACP agent's request is answered over its protocol, never typed.
        if item.sources.contains("acp") {
            let entry = self
                .entries
                .get_mut(&item.session_id)
                .ok_or("session not found")?;
            let acp = entry
                .acp
                .as_mut()
                .ok_or("decision needs live reconciliation")?;
            return acp.answer(&entry.meta, &mut self.queue, &item, &answer);
        }
        if item.kind == queue::Kind::Dialog && !matches!(answer, queue::Answer::Deny) {
            return Err(
                "dialog choices must be answered in the agent terminal; only deny/Esc is allowed"
                    .into(),
            );
        }
        // Ticket 1030: "Allow for this session" goes through the hook with Claude's own rules kept to this session, and
        // only those no broader than the request; the screen's option 2 would write them to its settings.
        let cwd = self.entry(&item.session_id)?.meta.cwd.clone();
        if matches!(answer, queue::Answer::AllowAlways)
            && item.kind == queue::Kind::Permission
            && self.annotated(item.clone()).allow_always.is_some()
            && self.queue.answer_hook_session(&item, &cwd, now)?
        {
            return Ok(Reply::Ack);
        }
        if matches!(answer, queue::Answer::AllowOnce | queue::Answer::Deny)
            && item.kind == queue::Kind::Permission
            && self.queue.answer_hook_with(
                &item,
                matches!(answer, queue::Answer::AllowOnce),
                note,
                interrupt,
                now,
            )?
        {
            return Ok(Reply::Ack);
        }
        // Look 11-17 N20: Codex's async question takes its answer as the user's next message; Cancel only drops the card.
        if queue::answered_by_message(&item) {
            let text = match answer {
                queue::Answer::Choose { index } => Some(
                    item.choices
                        .get(index)
                        .ok_or("invalid answer option")?
                        .label
                        .clone(),
                ),
                queue::Answer::Deny => None,
                _ => return Err("a question takes one of its choices".into()),
            };
            if let Some(text) = &text {
                crate::delivery::check_text(AgentKind::Codex, text)?; // the label is the agent's own text
            }
            let mut queued = None;
            if let Some(text) = text {
                // Queued, never written here: the tick writes it once the input box is on the screen (`steers`).
                // Q9 tt-J4-3: queued before the card goes, so a failed save never drops the card with its answer.
                let send =
                    self.begin_send("user", &item.session_id, text, vec![], true, "queued")?;
                self.steers.insert(send.id.clone());
                queued = Some(send.id);
            }
            if let Err(e) = self.queue.remove(id) {
                // Codex round 2: the card stays, so its answer goes too; a second press would queue a second copy.
                if let Some(send) = queued {
                    self.steers.remove(&send);
                    self.entry(&item.session_id)?
                        .meta
                        .send_queue
                        .retain(|s| s.id != send);
                    if let Err(undo) = self.save() {
                        eprintln!("queued answer {send} not taken back on disk: {undo}");
                    }
                }
                return Err(e);
            }
            return Ok(Reply::Ack);
        }
        self.current(&item.session_id)?; // v1a-19 r2
        // v1b-30: an item the screen never proved (its hook has returned) is never typed; the card shows this.
        if item.screen_text.is_none() {
            return Err("the screen cannot prove this request; answer in the terminal".into());
        }
        // Ticket 396: a blank screen inside the resize grace is the agent's redraw still to come; nothing is typed until
        // the prompt is detected again (the checks below run on the redrawn screen).
        // Seventh look (B S1-1): so is a screen a resize blanked that the tick has not given back yet (`restore_undrawn`,
        // at most one tick after the grace): the answer waits for it, and does not depend on when that tick runs.
        let redrawing = self.queue.redrawing(&item.session_id);
        let entry = self.entry(&item.session_id)?;
        let gone = if redrawing || entry.observer.unredrawn.is_some() {
            SCREEN_REDRAWING
        } else {
            NOT_ON_SCREEN
        };
        let current = entry.observer.screen.detect(entry.meta.kind).ok_or(gone)?;
        if current.kind != item.kind || item.screen_text.as_ref() != Some(&current.text) {
            return Err("decision screen changed; refresh before answering".into());
        }
        let mut typed = None;
        let keys = match answer {
            queue::Answer::Deny => vec!["esc".into()],
            queue::Answer::AllowOnce => {
                if item.kind != queue::Kind::Permission {
                    return Err("allow_once requires a permission request".into());
                }
                let choice = item
                    .choices
                    .iter()
                    .find(|c| c.allows_once()) // v1b-12: one rule, queue::Choice::allows_once
                    .ok_or("no verified allow-once screen option")?;
                choice.keys.clone()
            }
            // V2-8e: only the option `annotate` offered: session-only, on a request that is not risky.
            queue::Answer::AllowAlways => {
                const NONE: &str = "no session-only \"don't ask again\" option for this request";
                let mut view = item.clone();
                let meta = &self.entry(&item.session_id)?.meta;
                let (cwd, lock) = (meta.cwd.clone(), meta.home_lock);
                self.queue.annotate(&mut view, &cwd, lock);
                let label = view.allow_always.ok_or(NONE)?;
                let choice = item
                    .choices
                    .iter()
                    .find(|c| c.label == label && c.session_only())
                    .ok_or(NONE)?;
                choice.keys.clone()
            }
            queue::Answer::DenyWith { .. } => return Err("invalid answer".into()),
            // Home look S2-7 (real Claude 2.1.326): the row's digit opens the dialog's text field; the words and Enter
            // follow there. Only that row takes words, and only from the card.
            queue::Answer::ChooseWith { index, ref text } => {
                let choice = item.choices.get(index).ok_or("invalid answer option")?;
                let text = queue::deny_note(text);
                if item.kind != queue::Kind::Question || !choice.takes_text() || text.is_empty() {
                    return Err("only a question's Type something choice takes words".into());
                }
                typed = Some(text);
                // The row's Enter would send the empty field, which Claude reads as a rejection: the digit alone.
                let mut keys = choice.keys.clone();
                keys.retain(|k| k != "enter");
                keys
            }
            queue::Answer::Choose { index } => {
                let choice = item.choices.get(index).ok_or("invalid answer option")?;
                if choice.changes_settings {
                    if !confirmed {
                        return Err("confirmation_required: option changes user settings".into());
                    }
                    return Err("persistent user configuration changes must be answered in the agent terminal".into());
                }
                // Home look S2-7: its digit and Enter send an empty field, which Claude reads as a rejection.
                if item.kind == queue::Kind::Question && choice.takes_text() {
                    return Err("only a question's Type something choice takes words".into());
                }
                choice.keys.clone()
            }
        };
        let mut bytes = vec![];
        for key in keys {
            if key.bytes().all(|b| b.is_ascii_digit()) && key.len() <= 3 {
                bytes.extend(key.as_bytes());
            } else {
                bytes.extend(key_bytes(&key)?);
            }
        }
        // Remove durably before sending: a crash can lose an answer but can never replay it.
        self.queue.remove(id)?;
        self.live(&item.session_id)?.write(&bytes)?;
        if let Some(text) = typed {
            // Claude reads "3words" in one chunk as the digit alone, so the words wait for its text field: a later tick
            // types them once the screen shows it (`advance_typed`), never a pause under the registry lock.
            let digit = bytes.iter().map(|b| *b as char).collect();
            self.typed_answers.insert(
                item.session_id.clone(),
                TypedAnswer {
                    digit,
                    text,
                    since: std::time::Instant::now(),
                    typed: None,
                },
            );
        }
        Ok(Reply::Ack)
    }
    /// Look 11-17 w10 item 1: a question's "Type something" answer. Its digit is written; the words follow once the
    /// screen shows the text field (the cursor row `❯ <digit>.`), Enter once the field shows the words. Under load
    /// Claude opens the field later, and words typed into the option list pick a row by a leading digit. Bounded by
    /// `TYPED_WAIT`: a field that never shows gets no words, and the question, still on the screen, is a card again.
    pub(super) fn advance_typed(&mut self) {
        let now = std::time::Instant::now();
        for id in self.typed_answers.keys().cloned().collect::<Vec<_>>() {
            let Some(entry) = self.entries.get_mut(&id) else {
                self.typed_answers.remove(&id);
                continue;
            };
            let answer = &self.typed_answers[&id];
            if now.duration_since(answer.since) > TYPED_WAIT || !entry.agent_live() {
                eprintln!(
                    "session {id}: the question's text field did not open; its words were not typed"
                );
                self.typed_answers.remove(&id);
                continue;
            }
            if entry.observer.behind {
                continue;
            }
            let screen = entry.observer.screen.text();
            let field = typed_field(&screen, &answer.digit);
            let step: Option<Vec<u8>> = match (answer.typed, field) {
                (None, Some(_)) => Some(answer.text.as_bytes().to_vec()),
                (Some(at), Some(shown))
                    if now.duration_since(at) >= std::time::Duration::from_millis(100)
                        && shown.to_lowercase().starts_with(
                            &answer
                                .text
                                .chars()
                                .take(20)
                                .collect::<String>()
                                .to_lowercase(),
                        ) =>
                {
                    Some(b"\r".to_vec())
                }
                _ => None,
            };
            let Some(bytes) = step else { continue };
            let enter = bytes == b"\r";
            if let Some(pty) = entry.pty.as_mut()
                && let Err(e) = pty.write(&bytes)
            {
                eprintln!("session {id}: the question's answer was not typed: {e}");
                self.typed_answers.remove(&id);
                continue;
            }
            if enter {
                self.typed_answers.remove(&id);
            } else if let Some(answer) = self.typed_answers.get_mut(&id) {
                answer.typed = Some(now);
            }
        }
    }
}
/// How long that re-read leaves a session's screen alone after one of its requests was answered.
const REREAD_AFTER_ANSWER: std::time::Duration = std::time::Duration::from_secs(5);

/// Look 11-17 w10 item 1: a "Type something" answer between its digit and its Enter.
pub(super) struct TypedAnswer {
    digit: String,
    text: String,
    since: std::time::Instant,
    /// When the words were written.
    typed: Option<std::time::Instant>,
}
/// How long a typed answer waits for Claude's text field.
const TYPED_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// The text in Claude's question text field for option `digit`, when the cursor row `❯ <digit>. …` shows it (its
/// placeholder "Type something." counts as empty).
fn typed_field(screen: &str, digit: &str) -> Option<String> {
    screen.lines().rev().find_map(|l| {
        let rest = l.trim_start().strip_prefix('\u{276f}')?.trim_start();
        let text = rest.strip_prefix(digit)?.strip_prefix('.')?.trim();
        Some(if text == "Type something." {
            String::new()
        } else {
            text.to_string()
        })
    })
}
/// Look 11-17 v4 Home N4: a project lead that needed the user's words asked in chat, where nothing counts it as waiting
/// for the user; the goal's prompt says how to ask, as the Home lead's brief does.
// Look 11-17 v4 Home N10: "The line is also in this project's room" was read as a line of the goal's file.
pub(crate) const GOAL_NEXT: &str = "This goal is also posted as a message in this project's room. Plan it as tasks (`nunchiro task new`). If you need the user to decide or tell you something first, ask with your question tool, one question with its options, so the user sees a card that waits for them; never only as a line in chat.";
/// The lead's line for the user's yes on a merge card. The exact commit: a lead that merges what it is told merges what
/// was reviewed, whatever the worktree holds by now. Look 11-17 v3 (N31): merging a commit id, git's own message is
/// "Merge commit '704fffb…'", which names no task; the line says what to write.
pub(super) fn merge_yes_line(task: &str, title: &str, revision: &str) -> String {
    let short: String = revision.chars().take(7).collect();
    format!(
        "The user said yes: merge task {task} ({title}) as reviewed at {short}. Merge exactly that commit (`git merge \
         {revision}`), not the branch as it is now, and name the task in the merge's message (\"Merge task {task}: \
         {title}\") instead of git's default; if anything changed since, have it reviewed and ask again."
    )
}
pub(super) const NOT_ON_SCREEN: &str = "decision is no longer on screen";
pub(super) const SCREEN_REDRAWING: &str = "decision is redrawing after a resize; answer again"; // ticket 396
