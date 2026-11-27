//! Opening the registry from the store, saving it, reattaching held sessions and scrollback files.
use super::*;
impl Sessions {
    /// Ticket 1083: a core that treats `user_home` as the user's home (tests give a temp folder; the default
    /// worktrees folder is `<user home>/nunchiro/worktrees`).
    pub fn with_user_home(mut self, user_home: &Path) -> Self {
        self.settings.user_home = user_home.to_path_buf();
        self
    }
    pub fn open(home: &Path) -> Result<Self, String> {
        crate::sandbox::sweep(home); // v1b-21 r2: runs a dead core left
        let (mut rows, live, token_conversations, origins_lost) = store::load_all(home)?;
        // Ticket 358: a crash between a rename's two saves left these on the old name; the registry's wins.
        let names = crate::accounts::labels_by_folder(home);
        for meta in &mut rows {
            if let Some(label) = meta.config_dir.as_ref().and_then(|f| names.get(f)) {
                meta.account = Some(label.clone());
            }
        }
        let entries: BTreeMap<String, Entry> = rows
            .into_iter()
            .map(|meta| {
                (
                    meta.id.clone(),
                    Entry {
                        meta,
                        pty: None,
                        pty_size: None,
                        token: None,
                        token_hash: None, // V2-1b
                        stale: None,      // V2-1b
                        observer: waiting::Observer::default(),
                        input: crate::delivery::Input::default(),
                        // v1a-10
                        switch: None,
                        walk: None,
                        walk_error: None,
                        skip_chosen: false,
                        skip_hold: None,
                        args: None,
                        launch: None,              // from its live record below
                        permission: vec![],        // ticket 362
                        bypass_disabled: false,    // read at the first pick (`set_mode`)
                        saved: Default::default(), // v1a-40
                        probe: None,               // v1a-33
                        version_probe: None,       // V1A-89
                        acp: None,                 // V2-4a: ACP agents end with the core
                        agent_ended: false,
                        card_due: None,
                    },
                )
            })
            .collect();
        let mut entries = entries;
        for entry in entries.values_mut() {
            crate::delivery::validate(&entry.meta.send_log)?;
            crate::delivery::validate_queue(&entry.meta.send_queue, &entry.meta.send_log)?;
            cancel_queue(&mut entry.meta);
            for send in &mut entry.meta.send_log {
                if matches!(send.status.as_str(), "queued" | "attempting") {
                    send.status = "canceled".into();
                }
            }
            entry.meta.send_log.sort_by_key(|s| s.at);
            cap_log(&mut entry.meta.send_log);
            entry.meta.holder_status = None; // V2-1b: found again below
        }
        // V2-1b: sessions whose holders outlived the last core come back running, with their tokens (by hash).
        let mut kept = std::collections::BTreeSet::new();
        for (id, live) in &live {
            let (Some(entry), Some(record), Some(pid)) =
                (entries.get_mut(id), &live.holder, live.agent_pid)
            else {
                continue;
            };
            if live.past_start {
                entry.observer.screen.mark_started(); // `reattach` keeps it
            }
            if reattach(
                entry,
                record,
                pid,
                live.agent_started,
                live.run_start,
                crate::pty::QUICK_WAIT,
                true,
            ) {
                entry.token_hash = Some(live.token_sha256.clone());
                entry.launch = live.launch_args.clone(); // W35
                entry.token = Some(store::new_id()? + &store::new_id()?);
                kept.insert(id.clone());
            }
        }
        // Ticket 1130 C-C3: what this start kept of the last core's running sessions.
        let (lost, exited) = live
            .keys()
            .filter(|id| !kept.contains(*id))
            .filter_map(|id| entries.get(id))
            .partition::<Vec<_>, _>(|e| resumable(&e.meta) == SessionState::Resumable);
        crate::events::core_started(kept.len(), lost.len(), exited.len());
        // The delivery record: the agents the last core ran (a row it saved running), and whether each came back.
        crate::record::sweep(home);
        let running: Vec<(String, bool)> = live
            .iter()
            .filter_map(|(id, l)| {
                let pid = l.agent_pid?;
                entries.contains_key(id).then(|| {
                    (
                        format!("{pid}:{}", l.agent_started.unwrap_or(0)),
                        kept.contains(id),
                    )
                })
            })
            .collect();
        crate::record::restart(home, &running);
        // V1A-91: a `--version` probe ends with its core. A row the last core left running without a version probes
        // again when its agent came back, and otherwise reads `unknown` (and so `untested`, as any unknown version
        // does), so the field is never left empty. A row with no live record was not running then: kept as stored.
        for (id, entry) in entries.iter_mut() {
            // Ticket 358: only a version read of a session already running, so a refused command falls back to PATH.
            let proof = crate::approval::check_command(home, entry.meta.kind)
                .ok()
                .flatten();
            let program = match entry.meta.kind {
                AgentKind::Claude => agent_program("claude", proof.as_ref()),
                AgentKind::Codex => agent_program("codex", proof.as_ref()),
                _ => continue,
            };
            if entry.meta.agent_version.is_some()
                || entry.meta.state == SessionState::Closed
                || !live.contains_key(id)
            {
                continue;
            }
            match kept
                .contains(id)
                .then(|| version_probe(&program, VERSION_CEILING))
            {
                Some(Ok(probe)) => entry.version_probe = Some(probe),
                answer => {
                    let reason = answer.and_then(Result::err);
                    let reason = reason
                        .as_deref()
                        .unwrap_or("the probe ended with the last core");
                    eprintln!("session {id}: version unknown: {reason}");
                    entry.meta.agent_version = Some("unknown".into());
                    entry.meta.untested = true;
                }
            }
        }
        let recorded: std::collections::BTreeSet<PathBuf> = entries
            .values()
            .filter_map(|e| e.holder().map(|(h, _)| h.socket.clone()))
            .collect();
        for socket in crate::holder::clean(home, &recorded) {
            eprintln!("unknown holder {}: not adopted", socket.display());
        }
        // v1a-40: before the registry is shared, so no file IO waits under its lock: drop files no open row
        // owns, then read each open row's saved scrollback once.
        let open_row = |id: &str| {
            entries
                .get(id)
                .is_some_and(|e| e.meta.state != SessionState::Closed)
        };
        let mut settings: Settings = match store::read_settings(&home.join("settings.json")) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("invalid settings: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.to_string()),
        };
        settings.user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        // v1a-74: with history off no scrollback file stays, a set-aside sessions.json's included.
        if settings.history().is_none() {
            crate::scrollback::sweep(home, |_| false);
        }
        // v1b-40 r2: rows of a set-aside sessions.json keep their files; nothing is swept while one is kept.
        if store::kept_aside(home, "sessions.json") {
            eprintln!(
                "a set-aside sessions.json is kept; saved scrollback and exports are not swept"
            );
        } else {
            crate::scrollback::sweep(home, open_row);
            crate::scrollback_edit::sweep(home, open_row); // v1a-38b
            sweep_rowless(home, |id| entries.contains_key(id)); // V2-6d
        }
        // v1b-38 (V1A-40 review): most recently active rows first, under one total.
        let mut open: Vec<&Entry> = entries
            .values()
            .filter(|e| e.meta.state != SessionState::Closed)
            .collect();
        open.sort_by_key(|e| std::cmp::Reverse(e.meta.attention.last_activity));
        let open: Vec<String> = open.into_iter().map(|e| e.meta.id.clone()).collect();
        for (id, saved) in open.iter().zip(preload(home, &open, PRELOAD_BYTES)) {
            let _ = entries.get_mut(id).unwrap().saved.set(saved);
        }
        let (mut logouts, bad) = Self::load_logouts(home);
        // Ticket 76 r2: a mark whose tab is gone or Closed ends there.
        logouts.retain(|_, tab| {
            entries
                .get(tab)
                .is_some_and(|e| e.meta.state != SessionState::Closed)
        });
        // Ticket 750: a queue.json over its session limit keeps only the states of these rows (none dropped while a
        // set-aside sessions.json is kept, v1b-40), so the core starts and the next register can save.
        let aside = store::kept_aside(home, "sessions.json");
        let mut queue = Queue::open_owned(home, |id| aside || entries.contains_key(id))?;
        for entry in entries.values() {
            queue.register(&entry.meta.id, entry.meta.kind, queue::now_ms())?;
        }
        let (events, mut recovery_warnings) = match queue::journal::recover(home, queue::now_ms()) {
            Ok(batch) => batch,
            Err(error) => {
                eprintln!("hook journal recovery/quarantine failed: {error}");
                (vec![], 1)
            }
        };
        recovery_warnings += bad;
        // v1b-02: recover unacknowledged Stop text after replaying its queue effect.
        let mut chat = crate::chat::Cache::new(home);
        let replayed = !events.is_empty();
        for (path, event) in events {
            if let Err(error) = queue.replay(&event) {
                recovery_warnings += 1;
                match queue::journal::quarantine(home, &path, &error) {
                    Ok(pruned) => recovery_warnings += pruned,
                    Err(error) => eprintln!("hook journal quarantine failed: {error}"),
                }
            } else {
                if event.event == "Stop"
                    && event.payload["agent_id"].as_str().is_none_or(str::is_empty)
                    && let Some(text) = event.payload["last_assistant_message"].as_str()
                    && let Some(entry) = entries.get(&event.session_id)
                {
                    let turn = crate::chat::stop_turn(
                        &event.payload,
                        queue.attention(&event.session_id).completion_seq,
                    );
                    if let Err(error) = chat
                        .stop_plan(&entry.meta, turn, text.into())
                        .and_then(|p| p.persist_bounded())
                    {
                        eprintln!("Stop chat recovery deferred: {error}");
                        recovery_warnings += 1;
                        continue;
                    }
                }
                if let Err(error) = fs::remove_file(path) {
                    eprintln!("hook journal acknowledgement cleanup failed: {error}");
                }
            }
        }
        if replayed {
            queue.flush()?; // ticket 1133: the replayed ids, which `replay` alone does not save
        }
        // V2-1b: a reattached session's items stay waiting, marked as restored until fresh evidence proves them;
        // r3 (S2): so do items the journal replay above raised again (a hook that fired while no core ran).
        for id in &kept {
            queue.checking(id)?;
        }
        for entry in entries.values().filter(|e| !kept.contains(&e.meta.id)) {
            queue.close(&entry.meta.id, entry.meta.state == SessionState::Failed)?;
        }
        let tree = crate::tree::Tree::load(home);
        if let Err(error) = &tree {
            eprintln!("{error}");
        }
        let mut sessions = Self {
            // v1a-06
            remote: crate::machines::State::default(),
            remote_epoch: store::new_id()?,
            start_modes: None,
            home: home.into(),
            token_conversations,
            origins_lost,
            chat,
            settings,
            entries,
            queue,
            recovery_warnings,
            grants: crate::grants::Grants::default(),
            schedules: crate::schedule::Schedules::load(home), // V2.5-11
            schedule_reruns: vec![],
            check_ins: vec![],
            delivery_inflight: BTreeMap::new(),
            wakes: BTreeMap::new(),
            room: room::State::default(),
            pending_enter: BTreeMap::new(),                // v1a-15
            size_waits: BTreeMap::new(),                   // ticket 1137
            widget_hashes: BTreeMap::new(),                // v1b-20
            deny_notes: std::collections::BTreeSet::new(), // V2-8e
            steers: std::collections::BTreeSet::new(),
            wake_rows: std::collections::BTreeSet::new(),
            core_rows: std::collections::BTreeSet::new(),
            memory_rows: std::collections::BTreeSet::new(),
            joined_rows: BTreeMap::new(),
            left_typed: std::collections::BTreeSet::new(),
            retried: std::collections::BTreeSet::new(),
            inflight_at: BTreeMap::new(),
            retry_at: BTreeMap::new(),
            drops: BTreeMap::new(),
            copy_left: BTreeMap::new(),
            hand_typed: BTreeMap::new(),
            spent: std::collections::BTreeSet::new(),
            clean_wait: BTreeMap::new(),
            hand_sent: BTreeMap::new(),
            typing_until: BTreeMap::new(),
            now_rows: std::collections::BTreeSet::new(),
            later_rows: BTreeMap::new(),
            attached: std::collections::BTreeSet::new(),
            direct_until: BTreeMap::new(),
            homing: BTreeMap::new(),
            drafts_home: home::load_aside(home),
            home_ask: std::collections::BTreeSet::new(),
            home_quiet: BTreeMap::new(),
            goal_wakes: vec![],
            loops_checked: 0,
            removing_worktrees: std::collections::BTreeSet::new(),
            branch_titles: vec![],
            typed_answers: BTreeMap::new(),
            window_size: saved_window_size(home),
            logouts,
            // v1b-15
            board_error: None,
            board_rows: None,                // S9
            board_observed: None,            // S9
            folder_probe: probe_folder,      // v1a-33
            probes: shared_probes().clone(), // v1a-33
            launching: None,                 // v2-1a
            left: false,                     // v2-1b
            switch_hooks: None,
            halted: false,
            composed: Default::default(),
            held_enter: Default::default(),
            submitted: Default::default(),
            touched: Default::default(),
            acp_loading: BTreeMap::new(),
            held_rows: Default::default(),
            outbox_sending: Default::default(),
            closed_views: Default::default(), // v1a-68
            closing: None,                    // V2-6d
            ran: std::sync::Mutex::new(crate::import::Ran::load(home)), // ticket 1073
            unsaved: Default::default(),      // ticket 999
            #[cfg(test)]
            saves: Default::default(),
            revision: Default::default(),
            #[cfg(test)]
            exit_walked: Default::default(),
            #[cfg(test)]
            send_clones: Default::default(),
            #[cfg(test)]
            snapshots: Default::default(),
            tree, // v2-9a
            writes: Default::default(),
            limit_resumes: BTreeMap::new(), // ticket 372
            events: Default::default(),
        };
        // Ticket 990: the stored parent links, so a lead still hears its workers after a core restart.
        sessions.restore_parents();
        // Ticket 1073 round 4: once per home, the conversations of sessions closed before ran.json existed (before
        // drop_closed below, which may drop old Closed rows).
        let known: Vec<String> = sessions
            .entries
            .values()
            .filter_map(|e| e.meta.agent_session_id.clone())
            .chain(
                sessions
                    .token_conversations
                    .iter()
                    .map(|t| t.conversation.clone()),
            )
            .collect();
        if let Ok(ran) = sessions.ran.get_mut()
            && let Err(e) = ran.seed(home, known.iter().map(String::as_str))
        {
            eprintln!("{}: not seeded: {e}", crate::import::RAN);
        }
        // A set-aside sessions.json leaves no session to name a project or own queue state: then nothing is pruned (v1b-40).
        if !aside {
            // Ticket 621: a store from before the limit shrinks here; sessions.json follows at the next save.
            sessions.drop_closed();
            // Ticket 750: queue state no row owns (rows dropped or closed before the queue forgot them).
            let rows = &sessions.entries;
            if let Err(error) = sessions.queue.retain_sessions(|id| rows.contains_key(id)) {
                eprintln!("queue state of gone sessions not dropped: {error}");
            }
            // v2-9a: pruned in memory only; the file is rewritten by the next edit.
            let known = project_set(&sessions.entries);
            if let Ok(tree) = &mut sessions.tree {
                tree.prune(&known);
            }
        }
        sessions.end_pre_lock_home_seats();
        sessions.drop_orphan_asides(); // a closed session's words that never came home
        Ok(sessions)
    }
    pub(super) fn save(&self) -> Result<(), String> {
        self.changed();
        #[cfg(test)]
        self.saves.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // V2-1b: after `exit` the file keeps what the next core reattaches.
        if self.left {
            return Ok(());
        }
        // V2-1a: a session's token hash and holder are kept while it has a PTY (V2-1b: or an unattached live holder);
        // closing drops them (revoked).
        let mut live: BTreeMap<String, store::Live> = self
            .entries
            .iter()
            .filter_map(|(id, e)| {
                let (holder, agent_started) = e.holder()?;
                let holder = holder.clone();
                let run_start = match (&e.pty, &e.stale) {
                    (Some(pty), _) => pty.run_start(),
                    (None, Some(stale)) => stale.run_start,
                    (None, None) => 0,
                };
                let live = store::Live {
                    token_sha256: e.token_hash.clone()?,
                    holder: Some(holder),
                    agent_started,
                    run_start,
                    launch_args: e
                        .launch
                        .clone()
                        .filter(|a| claude_modes::storable(e.meta.kind, a)), // W35: allow list only
                    past_start: e.observer.screen.started(),
                    agent_pid: None,
                };
                Some((id.clone(), live))
            })
            .collect();
        if let Some((id, hash)) = &self.launching {
            live.insert(
                id.clone(),
                store::Live {
                    token_sha256: hash.clone(),
                    holder: None,
                    agent_started: None,
                    run_start: 0,
                    launch_args: None,
                    past_start: false,
                    agent_pid: None,
                },
            );
        }
        // Ticket 621 round 3: a token row inside its Undo window is stored as Closed, so a core that ends in the window
        // keeps the row (and its origin) instead of losing it with phase 1's removal.
        let pending = self
            .closing
            .as_ref()
            .map(|c| &c.entry.meta)
            .filter(|m| self.token_origin(m).is_some())
            .map(|m| {
                let mut m = m.clone();
                (m.state, m.closed_at, m.pid) = (SessionState::Closed, Some(queue::now_ms()), None);
                m
            });
        store::save_all(
            &self.home,
            self.entries
                .values()
                .map(|e| e.meta.clone())
                .chain(pending)
                .collect(),
            live,
            self.token_conversations.clone(),
        )?;
        // Ticket 1073: the conversations of the rows (and of the one in its close window) are Nunchiro's; logged, not
        // fatal: a lost write only lets History call that conversation "started in a terminal" after its close.
        if let Ok(mut ran) = self.ran.lock()
            && let Err(e) = ran.note(
                &self.home,
                self.entries
                    .values()
                    .map(|e| &e.meta)
                    .chain(self.closing.as_ref().map(|c| &c.entry.meta))
                    .filter_map(|m| m.agent_session_id.as_deref()),
            )
        {
            eprintln!("{}: {e}", crate::import::RAN);
        }
        // Ticket 999: this save wrote every row, so whatever a pass left unsaved went with it. Only once written: a
        // failed save keeps the mark and the next tick (or `refresh`) tries again.
        self.unsaved
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    /// v1a-74: `None` from `Settings::history` writes nothing; nor does a `no_history` session (a sign-in tab).
    pub(super) fn queue_save(&mut self, id: String, bytes: Vec<u8>) {
        if self.entries.get(&id).is_some_and(|e| e.meta.no_history) {
            return;
        }
        if let Some(mask) = self.settings.history() {
            self.queue_write(id, Write::Save { bytes, mask });
        }
    }
    /// A newer write of an id replaces its queued one.
    fn queue_write(&mut self, id: String, write: Write) {
        self.writes.queued.retain(|(other, _)| *other != id);
        self.writes.queued.push((id, write));
    }
    /// The id's file goes (Close, a replaced row): no queued write of it runs, and one being written is removed
    /// again once written.
    pub(super) fn forget_write(&mut self, id: &str) {
        self.writes.queued.retain(|(other, _)| other != id);
        if self.writes.writing.contains(id) {
            self.writes.dropped.insert(id.to_string());
        }
    }
    pub(crate) fn scrollback_pending(&self) -> bool {
        !self.writes.queued.is_empty()
    }
    /// V1A-74 follow-up: does the queued scrollback writes (`logs::mask`, fsync) with the registry lock released.
    /// The caller holds no lock; the server calls it from the tick (on its own thread) and before the Stop reply.
    pub(crate) fn drain_scrollback(registry: &std::sync::Mutex<Sessions>) {
        let _one = DRAINING.lock().unwrap_or_else(|e| e.into_inner());
        let (home, batch) = {
            let Ok(mut sessions) = registry.lock() else {
                return;
            };
            let batch = std::mem::take(&mut sessions.writes.queued);
            let ids = batch.iter().map(|(id, _)| id.clone());
            sessions.writes.writing.extend(ids);
            (sessions.home.clone(), batch)
        };
        if batch.is_empty() {
            return;
        }
        write_scrollback(&home, &batch, std::thread::Builder::new);
        let Ok(mut sessions) = registry.lock() else {
            return;
        };
        for (id, _) in &batch {
            sessions.writes.writing.remove(id);
            if sessions.writes.dropped.remove(id)
                && let Err(e) = crate::scrollback::remove(&home, id)
            {
                eprintln!("scrollback remove {id}: {e}");
            }
        }
    }
}
/// V2-1b: takes a session whose holder outlived the last core back; `true` when it runs (attached, or kept unattached
/// while its agent runs). A holder of this protocol is attached; one of another protocol keeps its agent with a status
/// line. A holder that is gone took its agent (killed here as the holder would, only the recorded process); one that
/// is alive but not answering is tried again while its agent runs. Nothing else ends an agent.
pub(super) fn reattach(
    entry: &mut Entry,
    record: &crate::holder::Record,
    pid: u32,
    started: Option<u64>,
    run_start: u64,
    wait: std::time::Duration,
    retry: bool,
) -> bool {
    // V1A-79: only `open` waits out a holder that has not yet noticed the last core leave; `refresh` runs under the
    // registry lock and stays single-shot.
    let attached = if retry {
        Pty::attach_retrying(record, wait)
    } else {
        Pty::attach(record, wait)
    };
    let busy_before = entry.stale.as_ref().map_or(0, |s| s.busy);
    let mut busy = busy_before;
    let status = match attached {
        // The holder's agent must be the recorded one (a store that names another is never trusted with it).
        Attach::Attached(pty) if pty.pid() != pid || pty.agent_started() != started => {
            eprintln!(
                "session {}: its holder runs another agent; not attached",
                entry.meta.id
            );
            pty.leave();
            None
        }
        Attach::Attached(mut pty) => {
            pty.set_run_start(run_start);
            // Detection starts after what the ring held: only output after the reattach can prove a request.
            // A start that was over stays over: the agent's first screens are long gone.
            let past = entry.observer.screen.started();
            entry.observer = waiting::Observer::default();
            entry.observer.screen.started = past.into();
            entry.observer.screen.feed(&pty.snapshot());
            entry.observer.output_offset = pty.end();
            entry.meta.pid = Some(pty.pid());
            entry.meta.state = SessionState::Running;
            entry.meta.holder_status = None;
            entry.pty = Some(*pty);
            entry.pty_size = None;
            entry.stale = None;
            entry.saved = Default::default();
            return true;
        }
        Attach::Older(version) => {
            eprintln!(
                "session {}: holder speaks protocol {version}; needs restart",
                entry.meta.id
            );
            Some(HolderStatus::NeedsRestart)
        }
        Attach::Newer(version) => {
            eprintln!(
                "session {}: holder speaks protocol {version}; update Nunchiro",
                entry.meta.id
            );
            Some(HolderStatus::UpdateNunchiro)
        }
        // Ticket 385: one line, when it is given up; a status stops the retries in `refresh`.
        Attach::Gone(why) if why == crate::holder::PEER_CHECK_BUSY => {
            busy += 1;
            (busy >= BUSY_TRIES).then(|| {
                eprintln!(
                    "session {}: holder stayed busy; needs restart",
                    entry.meta.id
                );
                HolderStatus::NeedsRestart
            })
        }
        Attach::Gone(why) => {
            // Ticket 385: retried every few seconds while its agent runs, so only the first failure is logged.
            if entry.stale.is_none() {
                eprintln!("session {}: holder not reattached: {why}", entry.meta.id);
            }
            if !crate::peer::is_same(record.pid, record.started)
                && let Some(started) = started
                && crate::peer::is_same(pid, started)
            {
                unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                let until = std::time::Instant::now() + std::time::Duration::from_millis(200);
                while crate::peer::running_since(pid, Some(started))
                    && std::time::Instant::now() < until
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            None
        }
    };
    // Without a recorded start time the pid cannot be told from a later process on it: not reattached.
    if started.is_none() || !crate::peer::running_since(pid, started) {
        return false;
    }
    entry.meta.pid = Some(pid);
    entry.meta.state = SessionState::Running;
    entry.meta.holder_status = status;
    entry.stale = Some(Stale {
        record: record.clone(),
        pid,
        started,
        run_start,
        retry: std::time::Instant::now() + STALE_RETRY * 2u32.pow(busy.saturating_sub(1)),
        busy,
    });
    true
}
/// v1a-40: a thread per file, at most `WRITERS` at once, so the fsyncs overlap without a thread (and a masked copy)
/// per saved file when masking turns on. A failure is logged, never fatal: the stop goes on.
/// v1b-38: a thread that cannot start saves its file inline (logged) instead of panicking.
pub(super) fn write_scrollback(
    home: &Path,
    batch: &[(String, Write)],
    thread: impl Fn() -> std::thread::Builder,
) {
    let save = |id: &str, write: &Write| {
        let result = match write {
            Write::Save { bytes, mask } => crate::scrollback::save(home, id, bytes, *mask),
            Write::Remask => crate::scrollback::remask(home, id),
        };
        if let Err(e) = result {
            eprintln!("scrollback save {id}: {e}");
        }
    };
    const WRITERS: usize = 4;
    for writes in batch.chunks(WRITERS) {
        std::thread::scope(|scope| {
            for (id, write) in writes {
                if let Err(e) = thread().spawn_scoped(scope, || save(id, write)) {
                    eprintln!("scrollback save {id}: no thread ({e}); saving inline");
                    save(id, write);
                }
            }
        });
    }
}
/// v1b-38 (V1A-40 review): the most saved scrollback `open` holds in memory at once (64 sessions at the full
/// `REPLAY_BYTES`). A row past it seeds nothing and its terminal reads "no live replay"; its file stays for the next
/// core. Reading it lazily would put file IO under the registry lock.
pub(super) const PRELOAD_BYTES: usize = 64 * 1024 * 1024;
/// Each id's saved scrollback in order, until the total would pass `cap`; that row and the rest get None.
pub(super) fn preload(home: &Path, ids: &[String], cap: usize) -> Vec<Option<crate::pty::Saved>> {
    let mut left = Some(cap);
    ids.iter()
        .map(|id| {
            let room = left?;
            let bytes = match crate::scrollback::load(home, id) {
                Ok(bytes) => bytes,
                Err(e) => {
                    eprintln!("scrollback load {id}: {e}");
                    None
                }
            }?;
            left = room.checked_sub(bytes.len());
            if left.is_none() {
                eprintln!("scrollback preload: over {cap} bytes; {id} and later rows seed nothing");
                return None;
            }
            Some(crate::pty::Saved::new(bytes))
        })
        .collect()
}
pub(super) fn load_saved(home: &Path, id: &str) -> Option<crate::pty::Saved> {
    match crate::scrollback::load(home, id) {
        Ok(bytes) => bytes.map(crate::pty::Saved::new),
        Err(e) => {
            eprintln!("scrollback load {id}: {e}");
            None
        }
    }
}
/// v1a-40: the live PTY's replay, else the scrollback saved when it stopped.
pub(super) fn read_replay(home: &Path, entry: &Entry, after: u64) -> Response {
    if let Some(pty) = &entry.pty {
        return pty.read(after);
    }
    // Rows restored at `open` were read there; this reads only for a row that lost its PTY in this core.
    entry
        .saved
        .get_or_init(|| load_saved(home, &entry.meta.id))
        .as_ref()
        .ok_or("session has no live replay after restart")?
        .read(after)
}
/// V2-6d: a close the last core left pending dropped its row first; the hooks file and holder log it kept go now.
fn sweep_rowless(home: &Path, row: impl Fn(&str) -> bool) {
    let names = |dir: PathBuf| {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
    };
    let hooks = names(home.to_path_buf()).filter_map(|n| {
        n.strip_prefix("hooks-")
            .and_then(|n| n.strip_suffix(".json"))
            .or_else(|| n.strip_prefix("agent-ended-")) // ticket 286
            .map(str::to_string)
    });
    let logs = names(home.join("logs").join("sessions"))
        .filter_map(|n| n.split_once(".log").map(|(id, _)| id.to_string()));
    let ids: std::collections::BTreeSet<String> = hooks.chain(logs).collect();
    for id in ids {
        if !store::valid_id(&id) || row(&id) {
            continue;
        }
        if let Err(e) =
            remove_hooks(home, &id).and_then(|()| crate::logs::remove_session(home, &id))
        {
            eprintln!("files of closed session {id}: {e}");
        }
    }
}
