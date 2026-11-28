//! The Home lead's Outbox and open loops: staging, spending, expiry and their cards.
use super::*;
impl Sessions {
    /// Ticket 1002 lane 2: `nunchiro outbox stage`. Only the Home lead's live seat stages (a scheduled run of it too:
    /// a routine may draft, never answer). The call is checked as it is, never cleaned (`outbox::check`), so the call
    /// approved is the call the seat makes; then only the card.
    pub(super) fn outbox_stage(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Response {
        let Request::OutboxStage { tool, args, source } = request else {
            return Err("not an outbox request".into());
        };
        let from = self.home_lead_caller(caller)?;
        crate::outbox::check(tool, args)?;
        // A command card binds the files its line names, as they are now (`bound`); a call's arguments are unchanged.
        let args = &crate::outbox::bound(tool, args)?;
        let shown = crate::outbox::check(tool, args)?;
        let waiting = self.outbox_count();
        if waiting >= crate::outbox::CARDS_MAX {
            return Err(format!(
                "{waiting} Outbox cards already wait for the user: stage more once they answer"
            ));
        }
        let mut new_domains: Vec<String> = shown
            .recipients()
            .map(|a| crate::outbox::domain(a).to_string())
            .filter(|d| !self.queue.outbox_domain_known(d))
            .collect();
        new_domains.sort();
        new_domains.dedup();
        let source = source
            .as_deref()
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .map(|s| {
                s.chars()
                    .filter(|c| !c.is_control() && !crate::board::rights::hidden(*c))
                    .take(crate::outbox::SOURCE_MAX)
                    .collect::<String>()
            })
            .filter(|s| !s.is_empty());
        let id = self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Outward {
                tool: tool.clone(),
                args: args.clone(),
                source,
                new_domains,
                from,
                hash: crate::approval::outward_call_hash(tool, args),
                yes_at: None,
            },
        )?;
        Ok(Reply::Text {
            text: format!("{} as card {id}", crate::outbox::words(&shown)),
        })
    }
    /// Ticket 1002 lane 2: the Home lead's name, when `caller` is its live seat (a token or a remote caller never is).
    fn home_lead_caller(&self, caller: &crate::grants::Caller) -> Result<String, String> {
        let refused = || "only the Home lead's seat stages or sends an Outbox card".to_string();
        if !matches!(self.schedule_reach(caller), Ok(None)) {
            return Err(refused());
        }
        crate::team::Team::open(&self.home)
            .lead_of(None)
            .map(|l| l.name)
            .ok_or_else(refused)
    }
    /// Ticket 1002 lane 2: `Request::OutboxSpend`, asked by the Home lead seat's hook before an outward call runs.
    /// Fail closed: only an approved, unspent card with exactly this call lets it through, once.
    pub(super) fn outbox_spend(
        &mut self,
        caller: &crate::grants::Caller,
        tool: &str,
        args_hash: &str,
    ) -> Response {
        self.home_lead_caller(caller)?;
        let spent = self
            .queue
            .outbox_spend(&caller.id, tool, args_hash, queue::now_ms())
            .ok_or(
                "no approved Outbox card of this session has exactly this call: it must not run",
            )?;
        if let Err(e) = self.queue.keep_outbox_domains(&spent.domains) {
            eprintln!("outbox: recipient domains not kept: {e}");
        }
        // Ticket 1003: the waiting-for row is made once the connector reports the mail sent (`outbox_sent`).
        if spent.mail.is_some() {
            let now = queue::now_ms();
            let before = self.outbox_sending.len();
            self.outbox_sending
                .retain(|(at, _)| now.saturating_sub(*at) < OUTBOX_SENDING_MS);
            let over = (self.outbox_sending.len() + 1).saturating_sub(OUTBOX_SENDING_MAX);
            self.outbox_sending.drain(..over);
            if self.outbox_sending.len() < before {
                eprintln!(
                    "open loops: {} spent Outbox mail(s) never reported sent, no waiting row made",
                    before - self.outbox_sending.len()
                );
            }
            self.outbox_sending.push((now, spent.clone()));
        }
        let team = crate::team::Team::open(&self.home);
        if let Some(lead) = team.lead_of(None) {
            self.team_note(
                &team.home(),
                &lead.id,
                None,
                // Final review S8: the spend allows the call; whether the connector then sent it is not known here.
                format!(
                    "Outbox card {} was allowed to send, as the user approved.",
                    spent.id
                ),
                crate::room::TeamNote {
                    what: "outbox_sent".into(),
                    worktree: None,
                    name: Some(spent.id.clone()),
                    branch: None,
                    merged: None,
                    seat: None,
                },
            );
        }
        Ok(Reply::Text { text: spent.id })
    }
    /// Ticket 1003: the user's yes went out as a mail (its PostToolUse came back without an error), so the user now
    /// waits for its reply. A row that cannot be kept never holds anything back.
    pub(super) fn outbox_sent(&mut self, session: &str, event: &str, payload: &serde_json::Value) {
        if !payload["agent_id"].as_str().is_none_or(str::is_empty)
            || !matches!(event, "PostToolUse" | "Stop")
        {
            return;
        }
        // The turn's Stop drops what is left of this session's sends (none of them reported back).
        if event == "Stop" {
            self.outbox_sending.retain(|(_, a)| a.session != session);
            return;
        }
        // The call is matched by the content its card was bound to (the hook's spend hashed the same `tool_input`),
        // never by tool name alone: two sends of one session may end in any order.
        let Some(tool) = payload["tool_name"].as_str() else {
            return;
        };
        let hash = crate::approval::outward_call_hash(tool, &payload["tool_input"]);
        let Some(at) = self.outbox_sending.iter().position(|(_, a)| {
            a.session == session && a.tool == tool && crate::schedule::same(&a.hash, &hash)
        }) else {
            return;
        };
        let (_, spent) = self.outbox_sending.remove(at);
        let response = &payload["tool_response"];
        if response["isError"] == true || response["is_error"] == true {
            return;
        }
        let Some((who, subject)) = &spent.mail else {
            return;
        };
        let kept = crate::loops::draft(
            "waiting",
            who,
            &format!("a reply to \"{subject}\""),
            None,
            &format!("Outbox card {}", spent.id),
        )
        .and_then(|row| crate::loops::Loops::open(&self.home).add(row, queue::now_ms()));
        if let Err(e) = kept {
            eprintln!(
                "open loops: the waiting row of card {} not kept: {e}",
                spent.id
            );
        }
    }
    /// Ticket 1003: the Home lead asks the user, on a card, to keep a new open loop (`change` "add") or to close one
    /// ("close", with `why`). Nothing is stored before the yes.
    pub(crate) fn ask_loop(
        &mut self,
        session: &str,
        change: &str,
        row: crate::loops::Row,
        from: String,
        why: Option<String>,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Loop {
                change: change.into(),
                row,
                from,
                why,
            },
        )
    }
    /// Ticket 1003: the open-loop cards waiting for the user.
    pub(crate) fn loop_card_count(&self) -> usize {
        self.queue
            .owner_items()
            .iter()
            .filter(|i| matches!(i.owner, Some(queue::OwnerAsk::Loop { .. })))
            .count()
    }
    /// Ticket 1003: the rows changed, so the next tick reads them for overdue ones.
    pub(crate) fn loops_changed(&mut self) {
        self.loops_checked = 0;
    }
    /// Ticket 1003: a closed loop has no close or overdue card left.
    pub(crate) fn retire_loop_cards(&mut self, loop_id: &str) -> Result<(), String> {
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Loop { change, row, .. }) if change != "add" && row.id == loop_id)
        })
    }
    /// Ticket 1003, each tick (the store is read once a minute; no timer of its own): an open loop whose due date
    /// passed gets one card (`loops::raise_overdue`).
    pub(super) fn loops_overdue(&mut self, now: u64) {
        if now < self.loops_checked + 60_000 {
            return;
        }
        self.loops_checked = now;
        crate::loops::raise_overdue(&self.home, &mut self.queue, &crate::loops::today(now));
    }
    /// Ticket 1003: the Home lead hears what became of its open-loop card, in its room.
    pub(super) fn loop_note(&mut self, body: String, what: &str, row: &crate::loops::Row) {
        let team = crate::team::Team::open(&self.home);
        let Some(home_lead) = team.lead_of(None) else {
            return;
        };
        self.team_note(
            &team.home(),
            &home_lead.id,
            None,
            body,
            crate::room::TeamNote {
                what: what.into(),
                worktree: None,
                name: Some(row.who.clone()),
                branch: None,
                merged: None,
                seat: None,
            },
        );
    }
    /// Ticket 1002 lane 2 (check M7f): whether `id` is an Outbox card, which only the owner's window answers.
    pub(crate) fn outward_card(&self, id: &str) -> bool {
        matches!(
            self.queue.owner_decision(id).and_then(|i| i.owner),
            Some(queue::OwnerAsk::Outward { .. })
        )
    }
    /// Ticket 1002 lane 2: the Outbox cards waiting for the user.
    pub(crate) fn outbox_count(&self) -> usize {
        self.queue
            .owner_items()
            .iter()
            .filter(|i| matches!(i.owner, Some(queue::OwnerAsk::Outward { .. })))
            .count()
    }
    pub(super) fn keep_domains(&mut self, shown: &crate::outbox::Shown) {
        let domains: Vec<String> = shown
            .recipients()
            .map(|a| crate::outbox::domain(a).to_string())
            .collect();
        if let Err(e) = self.queue.keep_outbox_domains(&domains) {
            eprintln!("outbox: recipient domains not kept: {e}");
        }
    }
    /// Ticket 1002 lane 2, each tick: a yes past its undo time is approved and wakes the Home lead to send it; an
    /// approved card unspent for 10 minutes lapses; a card unanswered for 24 h expires. Each is a line in Home's room.
    pub(super) fn expire_outbox(&mut self, now: u64) {
        let shown_of = |i: &queue::Decision| match &i.owner {
            Some(queue::OwnerAsk::Outward { tool, args, .. }) => {
                crate::outbox::check(tool, args).ok()
            }
            _ => None,
        };
        let ripe =
            self.queue
                .outbox_ripe(now, crate::outbox::UNDO_MS, crate::outbox::SPEND_MS, |i| {
                    shown_of(i).map_or(vec![], |s| {
                        s.recipients()
                            .map(|a| crate::outbox::domain(a).to_string())
                            .collect()
                    })
                });
        let team = crate::team::Team::open(&self.home);
        for item in ripe.unwrap_or_else(|e| {
            eprintln!("outbox: approved cards not moved: {e}");
            vec![]
        }) {
            let (Some(shown), Some(queue::OwnerAsk::Outward { tool, .. })) =
                (shown_of(&item), &item.owner)
            else {
                continue;
            };
            let what = crate::outbox::words(&shown);
            // Final review S7: only the run that staged it can spend it, so a gone run is not woken (that would open a
            // new seat as a window open); the owner's line below says so.
            let live = self
                .entries
                .get(&item.session_id)
                .is_some_and(|e| e.agent_live());
            // Fable round 3 review S3: and it is still the Home lead's seat.
            let lead = team.lead_of(None).filter(|lead| {
                live && self.seat_of(&lead.id).as_deref() == Some(item.session_id.as_str())
            });
            // Round 4 S-r4a: straight into that run (never `open_seat`, which could open a new seat if it ended).
            let go = if tool == crate::outbox::COMMAND {
                format!(
                    "The user approved Outbox card {}: {what}. Run it now: one Bash call with exactly this line, once, and its files as they are: {}. It is allowed once, within 10 minutes; any other line asks the user.",
                    item.id, shown.subject
                )
            } else {
                format!(
                    "The user approved Outbox card {}: {what}. Send it now: call {tool} once, with exactly the arguments you staged for this card. It is allowed once, within 10 minutes; any other call is refused.",
                    item.id
                )
            };
            let woken = lead.is_some() && self.prompt_as_user(&item.session_id, go).is_ok();
            self.outbox_note(
                format!("The user approved {what}; send it now."),
                "outbox_yes",
                &shown,
            ); // Fable lane 2 review S5: only the staging session may spend it; when that run is gone, the owner hears it
            // in the window too (the card then lapses as No), not only a lead that cannot send it.
            if !woken {
                // S-r4b: a live run that is no longer the lead's seat has not ended.
                let why = if live {
                    "is no longer the lead's seat"
                } else {
                    "has ended"
                };
                let line = format!(
                    "You approved {what}, but the chief of staff's run that staged it {why}, so it cannot be sent; it will lapse as No. Ask the chief to stage it again."
                );
                if let Err(e) = crate::room::Log::open(&self.home, &team.home()).team(
                    crate::room::PERSON,
                    line,
                    crate::room::TeamNote {
                        what: "outbox_orphan".into(),
                        worktree: None,
                        name: Some(item.id.clone()),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                ) {
                    eprintln!("outbox: the owner's line not written: {e}");
                }
            }
        }
        for lapsed in self.queue.outbox_lapsed(now) {
            if let Some(lead) = team.lead_of(None) {
                self.team_note(
                    &team.home(),
                    &lead.id,
                    None,
                    format!("Outbox card {} was not sent within 10 minutes of the user's yes: it counts as No. Do not send it another way.", lapsed.id),
                    crate::room::TeamNote {
                        what: "outbox_lapsed".into(),
                        worktree: None,
                        name: Some(lapsed.id),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                );
            }
        }
        let gone = match self.queue.expire_owner(now, crate::outbox::EXPIRE_MS, |i| {
            matches!(i.owner, Some(queue::OwnerAsk::Outward { yes_at: None, .. }))
        }) {
            Ok(gone) => gone,
            Err(e) => return eprintln!("outbox: expired cards not dropped: {e}"),
        };
        for item in gone {
            if let Some(shown) = shown_of(&item) {
                let what = crate::outbox::words(&shown);
                self.outbox_note(
                    format!("The user did not answer {what} within 24 hours: it counts as No. Do not send it another way."),
                    "outbox_expired",
                    &shown,
                );
            }
        }
    }
    /// Ticket 1002 lane 2: the Home lead hears what became of its Outbox card, in its room.
    pub(super) fn outbox_note(&mut self, body: String, what: &str, shown: &crate::outbox::Shown) {
        let team = crate::team::Team::open(&self.home);
        let Some(home_lead) = team.lead_of(None) else {
            return;
        };
        let name = match shown.kind {
            "event" => shown.subject.clone(),
            _ => shown.to.join(", "),
        };
        self.team_note(
            &team.home(),
            &home_lead.id,
            None,
            body,
            crate::room::TeamNote {
                what: what.into(),
                worktree: None,
                name: Some(name),
                branch: None,
                merged: None,
                seat: None,
            },
        );
    }
}
/// Ticket 1003: how long a spent Outbox mail waits for its PostToolUse, and how many may wait at once (an approval
/// lives 10 minutes; a send runs in seconds).
const OUTBOX_SENDING_MS: u64 = 15 * 60 * 1000;
const OUTBOX_SENDING_MAX: usize = 16;
