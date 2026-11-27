//! Schedules as sessions see them: who may read or propose one, their cards and failed runs.
use super::*;
impl Sessions {
    /// Ticket 993: whose schedules a session reads. Only the live seat of a place's lead reads any: `Some(place)`
    /// for a project's lead, `None` (every place) for the Home lead. A token, a session on another machine and every
    /// other session get the refusal a schedule request always gave.
    pub(crate) fn schedule_reach(
        &self,
        caller: &crate::grants::Caller,
    ) -> Result<Option<PathBuf>, String> {
        let refused = || "operation not granted".to_string();
        if self.grants.remote.contains(&caller.id) || tokens::is_token(caller) {
            return Err(refused());
        }
        let who = self
            .task_caller(Some(caller), None)
            .map_err(|_| refused())?;
        let place = who.place.filter(|_| who.decides).ok_or_else(refused)?;
        Ok((place != crate::team::Team::open(&self.home).home()).then_some(place))
    }
    /// The schedules of `place` (`None`: all). A teammate's schedule is of the place the teammate is in now; any
    /// other is of the folder it runs in.
    pub(crate) fn schedules_in(
        &self,
        place: Option<&Path>,
    ) -> Result<Vec<crate::schedule::Entry>, String> {
        let all = self.schedules.shown()?;
        let Some(place) = place else {
            return Ok(all);
        };
        let team = crate::team::Team::open(&self.home);
        let (mates, home) = (team.list()?, team.home());
        let of = |e: &crate::schedule::Entry| match &e.run.teammate {
            Some(id) => mates
                .iter()
                .find(|t| t.id == *id)
                .map(|t| t.project.clone().unwrap_or_else(|| home.clone())),
            None => Some(e.run.project.clone()),
        };
        Ok(all
            .into_iter()
            .filter(|e| of(e).as_deref() == Some(place))
            .collect())
    }
    /// Ticket 993: who may propose a schedule or a change: the live seat of a place's lead that is not doing a
    /// scheduled run (an unattended run must not make more runs). Gives its reach (`schedule_reach`) and its place's
    /// folder.
    fn schedule_proposer(
        &self,
        caller: &crate::grants::Caller,
    ) -> Result<(Option<PathBuf>, PathBuf), String> {
        let reach = self
            .schedule_reach(caller)
            .map_err(|_| "only the lead of a place proposes or changes a schedule".to_string())?;
        if self
            .entries
            .get(&caller.id)
            .is_some_and(|e| e.meta.schedule.is_some())
        {
            return Err(
                "a scheduled run cannot propose or change schedules: say it in your report, and the user can add it"
                    .into(),
            );
        }
        let place = reach
            .clone()
            .unwrap_or_else(|| crate::team::Team::open(&self.home).home());
        Ok((reach, place))
    }
    /// A schedule in one sentence, as its card says it: who, when, the model and effort its seat opens with (ticket
    /// 994: the level's own pair, never the level's word), the task in one line.
    fn schedule_line(&self, run: &crate::schedule::Run, when: &crate::schedule::When) -> String {
        let mate = run.teammate.as_ref().and_then(|id| {
            let all = crate::team::Team::open(&self.home).list().ok()?;
            all.into_iter().find(|t| t.id == *id)
        });
        let mut line = format!("{} · {}", run.label, when.words());
        if let Some(mate) = mate
            && let Some((level, _)) = crate::team::seat_level(&mate, run.level)
        {
            let table = self.feature::<serde_json::Value>(crate::team::LEVELS_KEY);
            let pick = crate::team::level_pick(table.as_ref(), &mate.agent_key(), level);
            let pair =
                crate::team::pick_words(mate.kind, pick.model.as_deref(), pick.effort.as_deref());
            line += &format!(" · {pair}");
        }
        if let Some(task) = &run.task {
            // One line, no hidden characters (they reorder or hide what the user reads on the card), what the logs
            // mask is masked (the card and the room keep it), and cut.
            let shown: String = task
                .chars()
                .filter(|c| !crate::board::rights::hidden(*c))
                .collect();
            let flat = shown.split_whitespace().collect::<Vec<_>>().join(" ");
            let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
            let cut: String = flat.chars().take(160).collect();
            let more = if cut.len() < flat.len() { "…" } else { "" };
            line += &format!(": {cut}{more}");
        }
        line
    }
    /// Ticket 993: `nunchiro schedule propose`. Checked as the owner's add checks it (the teammate is of the caller's
    /// place, the time, a date still to come, the task's limits), so the card can be applied; then only the card.
    pub(super) fn schedule_propose(
        &mut self,
        caller: &crate::grants::Caller,
        who: &str,
        when: &str,
        task: String,
        level: Option<crate::team::Level>,
    ) -> Response {
        let (reach, place) = self.schedule_proposer(caller)?;
        let name = who.trim().to_lowercase();
        let mate = crate::team::Team::open(&self.home)
            .list()?
            .into_iter()
            .find(|t| t.project == reach && t.name.to_lowercase() == name)
            .ok_or_else(|| format!("no teammate named {} in this place", who.trim()))?;
        let when = crate::schedule::When::parse(when)?;
        // No level asked is Light, as a schedule made by hand starts (ticket 993 rule 3); a custom model has no levels.
        let level = level.or(mate.model.is_none().then_some(crate::team::Level::Light));
        let run = crate::schedule::Run {
            kind: mate.kind,
            project: place.clone(),
            label: mate.name,
            model: None,
            effort: None,
            task: Some(task),
            teammate: Some(mate.id),
            level,
        };
        let entry = self.schedules.checked(
            run,
            when.clone(),
            None,
            &self.known_projects(),
            queue::now_ms(),
            &crate::usage::local_offset,
        )?;
        let line = self.schedule_line(&entry.run, &when);
        self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Schedule {
                change: "add".into(),
                id: None,
                run: entry.run,
                when,
                place,
                line: line.clone(),
                reason: None,
            },
        )?;
        Ok(Reply::Text { text: line })
    }
    /// Ticket 993: `nunchiro schedule change <id> pause|resume|remove`, for an entry the caller may read; a card.
    pub(super) fn schedule_change(
        &mut self,
        caller: &crate::grants::Caller,
        id: &str,
        change: &str,
    ) -> Response {
        let (reach, place) = self.schedule_proposer(caller)?;
        let entry = self
            .schedules_in(reach.as_deref())?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| {
                format!("no schedule {id} in this place (`nunchiro schedule list` shows them)")
            })?;
        match (change, entry.paused) {
            ("pause", false) | ("remove", _) => {}
            ("resume", true) => {
                crate::schedule::resume_ms(&entry, queue::now_ms(), &crate::usage::local_offset)?;
            }
            ("pause", true) => return Err("that schedule is already off".into()),
            ("resume", false) => return Err("that schedule is already on".into()),
            _ => return Err("a schedule change is pause, resume or remove".into()),
        }
        let when = entry.when();
        let line = self.schedule_line(&entry.run, &when);
        self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Schedule {
                change: change.into(),
                id: Some(entry.id),
                run: entry.run,
                when,
                place,
                line: line.clone(),
                reason: None,
            },
        )?;
        Ok(Reply::Text { text: line })
    }
    /// Ticket 993 rule 6: the schedules whose last run failed, for the Home digest. Look 11-17 v9 (Home S2-1): only
    /// while the failure's card waits: a dismissed one is gone from Home too (the schedule row keeps its red dot).
    pub(crate) fn failed_runs(&self) -> Vec<crate::ledger::FailedRun> {
        let all = self.schedules.list().unwrap_or_default();
        let cards = self.queue.owner_items();
        let carded = |entry: &str| {
            cards.iter().any(|i| {
                matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, id: Some(id), .. })
                    if change == "failed" && id == entry)
            })
        };
        all.iter()
            .filter_map(|e| {
                let last = e.last.as_ref()?;
                (last.result == Some(crate::schedule::Outcome::Failed) && carded(&e.id)).then(
                    || crate::ledger::FailedRun {
                        schedule: e.id.clone(),
                        line: self.schedule_line(&e.run, &e.when()),
                        reason: last.reason.clone().unwrap_or_default(),
                        at: last.at,
                        session: last.session.clone(),
                    },
                )
            })
            .collect()
    }
    /// Look 11-17 v8 (Home S2-B): the owner's card for entry `id`, whose run just failed: one per entry, replaced by
    /// a newer failure. It is counted wherever owner cards are (the Decisions pane, the Team badge, the lead's chip),
    /// so a failed run is the same number everywhere. `place` is the entry's place (`schedules_in`).
    pub(crate) fn failed_run_card(&mut self, id: &str, reason: &str) {
        let Some(entry) = self
            .schedules
            .list()
            .ok()
            .and_then(|all| all.into_iter().find(|e| e.id == id))
        else {
            return;
        };
        let team = crate::team::Team::open(&self.home);
        let place = match &entry.run.teammate {
            Some(mate) => team
                .list()
                .ok()
                .and_then(|all| all.into_iter().find(|t| t.id == *mate))
                .map(|t| t.project.unwrap_or_else(|| team.home())),
            None => None,
        }
        .unwrap_or_else(|| entry.run.project.clone());
        let when = entry.when();
        // Ticket 1002 lane 4: the run before this one (a skip is no run) failed too: the card names the streak.
        let twice = entry
            .earlier
            .iter()
            .find(|l| !l.result.is_some_and(crate::schedule::Outcome::no_run))
            .is_some_and(|l| l.result == Some(crate::schedule::Outcome::Failed));
        let reason = if twice {
            format!("{reason} · second time in a row")
        } else {
            reason.into()
        };
        let ask = queue::OwnerAsk::Schedule {
            change: "failed".into(),
            id: Some(entry.id.clone()),
            line: self.schedule_line(&entry.run, &when),
            run: entry.run,
            when,
            place,
            reason: Some(reason),
        };
        // No session asked. The stored item needs an id in `session_id` (`queue::validate`, and a core from before
        // this card must still load the file), so it carries the schedule's own id.
        if let Err(e) = self.queue.ask_owner(id, ask) {
            eprintln!("schedule {id}: no card for its failed run: {e}");
        }
    }
    /// A trigger that asks first fired: the owner's card, with the run its Start starts (the owner's task and the
    /// caller's payload as quoted data). No session asked; the item carries the trigger's own id.
    pub(crate) fn trigger_card(
        &mut self,
        name: &str,
        run: crate::schedule::Run,
        source: crate::schedule::triggers::Source,
        subject: Option<String>,
    ) -> Result<(), String> {
        let from = match source {
            crate::schedule::triggers::Source::Cli => "the command line",
            crate::schedule::triggers::Source::Webhook => "a webhook",
        };
        // All trigger cards together take at most half of the owner's queue, so approvals, proposals and setup cards
        // always fit.
        let all = self
            .queue
            .owner_items()
            .iter()
            .filter(|i| matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, .. }) if change == "trigger"))
            .count();
        if all >= crate::schedule::triggers::CARDS_SHARE {
            return Err(format!(
                "{all} trigger cards wait for your answer in Decisions; this fire of trigger {name} was not added"
            ));
        }
        let waiting = self
            .queue
            .owner_items()
            .iter()
            .filter(|i| matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, id: Some(id), .. }) if change == "trigger" && id == name))
            .count();
        if waiting >= crate::schedule::triggers::CARDS_MAX {
            return Err(format!(
                "trigger {name}: {waiting} cards wait for your answer in Decisions; this fire was not added"
            ));
        }
        // One card per subject: a fire about another subject is another card, never one that replaces it (each card's
        // subject is released by its own Start or Not now).
        let card_key = match &subject {
            Some(s) => {
                use sha2::Digest;
                let h = sha2::Sha256::digest(s.as_bytes());
                format!(
                    "trigger-{name}-{}",
                    h[..6]
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                )
            }
            None => format!("trigger-{name}"),
        };
        let ask = queue::OwnerAsk::Schedule {
            change: "trigger".into(),
            id: Some(name.into()),
            line: format!("Trigger {name} fired from {from}"),
            place: run.project.clone(),
            run,
            when: crate::schedule::When {
                at: String::new(),
                daily: false,
                days: vec![],
            },
            // The subject the fire took (a pull request, an issue), so a Start or a Not now settles it.
            reason: subject,
        };
        self.queue.ask_owner(&card_key, ask).map(|_| ())
    }
    pub(super) fn drop_failed_card(&mut self, entry: &str) {
        self.drop_failed_cards(|id| id == entry);
    }
    fn drop_failed_cards(&mut self, gone: impl Fn(&str) -> bool) {
        let failed = |i: &queue::Decision| {
            matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, id: Some(id), .. })
                if change == "failed" && gone(id))
        };
        if self.queue.owner_items().iter().any(failed)
            && let Err(e) = self.queue.answer_owner(failed)
        {
            eprintln!("a failed run's card not dropped: {e}");
        }
    }
    /// The schedule list changed (an add, an edit, a remove, a switch, a run or its result). The card of a failed run
    /// goes by itself once its entry is gone (removed, or edited: an edit is a new id) or it ran again (its last run
    /// is no failure and no skip: ticket 1002, a slot skipped as too late is no run); a switch-off drops it where the
    /// user switches (`drop_failed_card`). Readers hear of the change (`events::schedules_changed`).
    pub(crate) fn schedules_changed(&mut self) {
        crate::events::schedules_changed();
        // An unreadable schedule file says nothing about any entry: the cards stay.
        let Ok(all) = self.schedules.list() else {
            return;
        };
        self.drop_failed_cards(|id| {
            !all.iter().any(|e| {
                e.id == id
                    && e.last.as_ref().is_some_and(|l| {
                        l.result
                            .is_some_and(|r| r == crate::schedule::Outcome::Failed || r.no_run())
                    })
            })
        });
    }
    /// Ticket 993: a scheduled run started this session or sent its task to it (`Session::schedule`). The session
    /// already runs, so a failed save is logged; the next save writes it.
    pub(crate) fn scheduled_run(&mut self, id: &str, schedule: &str) {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.meta.schedule = Some(schedule.into());
            if let Err(e) = self.save() {
                eprintln!("scheduled run not marked on its session yet: {e}");
            }
        }
    }
}
