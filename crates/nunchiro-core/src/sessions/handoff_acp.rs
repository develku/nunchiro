//! The end of sessions.rs, moved out whole on 2026-11-20 (the publish scan's 1 MiB limit): `handoff_send`,
//! `problem_fix`, restarts and the ACP sessions' launch and sends.
use super::*;

/// v2-3b: `handoff_send` for the window and the owner socket. Nothing is written to any PTY unless the text passes;
/// a new or resumed target is prepared off the registry lock, like `start`.
pub(crate) fn handoff_send(
    registry: &std::sync::Mutex<Sessions>,
    stopping: Option<&std::sync::atomic::AtomicBool>,
    from: &str,
    to: AgentKind,
    acp_agent: Option<&str>,
    text: &str,
) -> Response {
    let text = crate::chat::handoff::outgoing(text);
    if text.trim().is_empty() {
        return Err("nothing to send".into());
    }
    crate::delivery::check_text(to, &text)?;
    // Ticket 39: before any lookup or prepare, and again under the lock that starts and sends.
    let stopped = || stopping.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst));
    if stopped() {
        return Err("core is stopping".into());
    }
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    // Bound first: a guard taken in a `match` scrutinee would live through `prepare` (version probe, worktree).
    let target = lock()?.handoff_target(from, to, acp_agent)?.1;
    let prepared = match target {
        Ok(_) => None,
        Err(launch) => Some(launch.prepare()?),
    };
    #[cfg(test)]
    if let Some(hook) = BEFORE_DECIDE.take() {
        hook(registry);
    }
    let mut sessions = lock()?;
    if stopped() {
        return Err("core is stopping".into());
    }
    // Decided again under the lock that starts and sends: a handoff that ran meanwhile may have started or resumed
    // the target (then the prepared launch is dropped and rolled back), or given `from` its conversation.
    let (conversation, target) = sessions.handoff_target(from, to, acp_agent)?;
    let target = match (target, prepared) {
        (Ok(id), _) => id,
        // The prepared launch must be the one decided now (a new session, or a resume of the same conversation).
        (Err(now), Some(mut launch)) if same_start(&now.start, &launch.start) => {
            let session = match sessions.start(&launch) {
                Ok(session) => session,
                // V2-4b: an ACP agent that cannot start leaves a failed row with its card (none for an entry that
                // is not approved or changed: the window opens the setup sheet).
                Err(e) if launch.start.kind == AgentKind::Acp => {
                    return sessions.start_failed(&launch.start, e);
                }
                Err(e) => return Err(e),
            };
            launch.committed = true;
            session.id
        }
        // Anything else is dropped here, which rolls the prepared launch back.
        (Err(_), _) => return Err("handoff target changed; try again".into()),
    };
    sessions.handoff_finish(from, &target, &conversation, text)
}
/// Ticket 39: whether a prepared hand-off launch starts what is decided now: every field the start uses (a field
/// added to `StartSession` fails to compile here until it is compared).
pub(super) fn same_start(a: &StartSession, b: &StartSession) -> bool {
    let StartSession {
        kind,
        project,
        worktree,
        label,
        args,
        model,
        effort,
        resume,
        account,
    } = a;
    (
        kind, project, worktree, label, args, model, effort, resume, account,
    ) == (
        &b.kind,
        &b.project,
        &b.worktree,
        &b.label,
        &b.args,
        &b.model,
        &b.effort,
        &b.resume,
        &b.account,
    )
}

/// V2-5b: a problem card's fix. The ended session starts again as it ran (its conversation resumed when there is one),
/// or once without Nunchiro hooks; a fresh start closes the old row once the new one runs (a resume replaces it).
/// Owner and window only; a running session is refused, so no screen text can restart a working one.
pub(crate) fn problem_fix(
    registry: &std::sync::Mutex<Sessions>,
    stopping: Option<&std::sync::atomic::AtomicBool>,
    id: &str,
    fix: crate::problems::Fix,
) -> Response {
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let mut launch = lock()?.restart_launch(id, fix)?;
    launch.without_hooks = fix == crate::problems::Fix::StartWithoutHooks;
    let mut launch = launch.prepare()?;
    let mut sessions = lock()?;
    // Checked again under the lock that starts: the row may have been closed or restarted meanwhile.
    sessions.restart_launch(id, fix)?;
    if stopping.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst)) {
        return Err("core is stopping".into());
    }
    let session = sessions.start(&launch)?;
    launch.committed = true;
    // The new session runs either way: a failed close of the old row is logged, not returned. V2-6d: the core's own
    // close of a replaced row, so it closes at once (no Undo, and the user's pending close keeps its window).
    if sessions.entries.contains_key(id)
        && let Err(e) = sessions.close_now(id, true)
    {
        eprintln!("problem fix: closing {id} failed: {e}");
    }
    Ok(Reply::Started { session })
}

impl Sessions {
    /// V2-5b: the launch that starts an ended session again, as the window's v1a-33 restart does.
    pub(super) fn restart_launch(
        &self,
        id: &str,
        fix: crate::problems::Fix,
    ) -> Result<Launch, String> {
        let entry = self.entries.get(id).ok_or("unknown session")?;
        let meta = &entry.meta;
        if meta.side_chat {
            return Err("Side chat is temporary; open a new side chat".into());
        }
        // Ticket 286: a session whose agent ended (its shell still Running) restarts like an exited one.
        if meta.state == SessionState::Closed || entry.agent_live() {
            return Err("only an ended session can be restarted".into());
        }
        // A shell keeps no record of a login tab's account folder: started again it could sign in elsewhere.
        if meta.kind == AgentKind::Shell {
            return Err("start this shell again by hand".into());
        }
        // Only the fix the session's own card offers.
        let offered = match fix {
            crate::problems::Fix::Restart => crate::problems::Case::Unexpected,
            crate::problems::Fix::StartWithoutHooks => crate::problems::Case::HookTrust,
        };
        if meta.problem.as_ref().map(|p| p.case) != Some(offered) {
            return Err("this card offers another fix".into());
        }
        let resume = meta.agent_session_id.clone().filter(|_| {
            meta.kind == AgentKind::Codex || self.queue.attention(id).completion_seq > 0
        });
        let args = match (&resume, &entry.args) {
            (None, Some(args)) => args.clone(),
            _ => vec![],
        };
        if resume.is_none() && meta.cwd != meta.project {
            return Err("this session ran in a worktree; start it again there by hand".into());
        }
        Ok(self
            .launch(StartSession {
                kind: meta.kind,
                project: meta.project.clone(),
                worktree: false,
                label: meta.label.clone(),
                args,
                model: meta.model.clone(),
                effort: meta.effort.clone(),
                account: meta.account.clone().filter(|_| resume.is_none()),
                resume,
            })
            .owner_start())
    }
    /// V2-5b: an owner's Start whose agent is missing still gets a tab: a failed session showing its card. Any other
    /// error is returned as it was.
    pub(crate) fn start_failed(&mut self, start: &StartSession, error: String) -> Response {
        self.start_failed_at(start, None, error)
    }
    pub(crate) fn start_failed_at(
        &mut self,
        start: &StartSession,
        folder: Option<&Path>,
        error: String,
    ) -> Response {
        // V2-4b: an ACP agent's card names the agent (`start.args[0]`); an entry not approved or changed is no card.
        let acp_agent = (start.kind == AgentKind::Acp)
            .then(|| start.args.first().cloned())
            .flatten();
        let problem = match &acp_agent {
            Some(name) => crate::problems::acp_failed(&crate::acp::label_of(name), &error),
            None => crate::problems::start_failed(start.kind, &error),
        };
        let (Some(problem), Ok(project)) = (problem, fs::canonicalize(&start.project)) else {
            return Err(error);
        };
        let cwd = folder
            .map(|p| managed_start_folder(&self.home, &self.settings, &project, p))
            .transpose()?
            .unwrap_or_else(|| project.clone());
        let id = store::new_id()?;
        self.queue.register(&id, start.kind, queue::now_ms())?;
        let meta = Session {
            side_chat: start.args.iter().any(|arg| arg == SIDE_CHAT_ARG),
            stopped_sends: Vec::new(),
            side_parent: side_parent(start),
            side_split: side_split(start),
            machine: None,
            id: id.clone(),
            kind: start.kind,
            cwd,
            project,
            label: start.label.clone(),
            auto_label: false,
            closed_by_command: false,
            state: SessionState::Failed,
            agent_session_id: None,
            agent_version: None,
            untested: false,
            pid: None,
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            model: start.model.clone(),
            effort: start.effort.clone(),
            start_commit: None,
            artifacts: None,
            blocked: None,
            holder_status: None,
            config_dir: None,
            account: None,
            conversation: None,
            problem: Some(problem),
            without_hooks: false,
            no_history: false,
            account_tab: false,
            home_lock: false, // ticket 1002: a failed start and an ACP session are never locked
            home_mode: None,
            permission_mode: None, // CHAT-PERMCHIP
            starting: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            parent: None,     // V2.5-30
            teammate: None,
            resumed_from: vec![],
            owned_from: vec![],
            level: None,
            schedule: None,
            token_origin: None, // ticket 573: an ACP agent or a failed start; `spawn_acp` refuses a token's
            closed_at: None,
            ended_at: None,
            started_at: Some(queue::now_ms()),
            agent_ended: false, // ticket 286
            limit: None,        // ticket 372: set per snapshot
            folder_gone: false, // look 1117 v13: set per snapshot
            ended_ask: None,    // look 1117 v10 N10-S3-3: set per snapshot
            modes: None,
            acp_agent, // V2-4b: the sheet and the install page need the name
        };
        self.entries.insert(
            id.clone(),
            Entry {
                meta: meta.clone(),
                pty: None,
                pty_size: None,
                token: None,
                token_hash: None,
                stale: None,
                observer: Default::default(),
                input: Default::default(),
                switch: None,
                walk: None,
                walk_error: None,
                skip_chosen: false,
                skip_hold: None,
                args: Some(start.args.clone()),
                permission: vec![],
                bypass_disabled: false,
                saved: Default::default(),
                probe: None,
                version_probe: None,
                acp: None, // V2-4a
                agent_ended: false,
                card_due: None,
                launch: None,
            },
        );
        self.queue.close(&id, true)?;
        if let Err(e) = self.save() {
            self.entries.remove(&id);
            return Err(e);
        }
        // V2-4b: a Claude entry refused for lack of an API key keeps its V2-4a reply (the refusal as an error) beside
        // the failed row that carries its one-line card.
        if meta.problem.as_ref().map(|p| p.case) == Some(crate::problems::Case::AcpRefused) {
            return Err(error);
        }
        Ok(Reply::Started {
            session: self.snapshot_session(&meta),
        })
    }
}

// V2-4a: ACP sessions. The agent is a stdio child of the core (no PTY, no holder); it launches only at the
// `agents.toml` content a human approved, checked again right here under the lock that spawns it.
impl Sessions {
    pub(super) fn spawn_acp(&mut self, launch: &Launch) -> Result<Session, String> {
        if launch.origin.is_some() {
            return Err("a token session runs only Claude".into()); // ticket 573
        }
        let start = &launch.start;
        let [name] = start.args.as_slice() else {
            return Err("an ACP session takes its agent name only (acp:<name>)".into());
        };
        if start.model.is_some() || start.effort.is_some() {
            return Err("an ACP agent's model and effort are set in the agent".into());
        }
        if start.account.is_some() || launch.account.is_some() || launch.config.is_some() {
            return Err("an ACP agent has no account; it signs in on its own".into());
        }
        let proof = crate::approval::check_agent(&self.home, name)?;
        // Resumed only through `session/load` of a conversation this core recorded for the same agent.
        let prior: Vec<String> = match &start.resume {
            None => vec![],
            Some(resume) => {
                let prior: Vec<String> = self
                    .entries
                    .values()
                    .filter(|e| {
                        e.meta.kind == AgentKind::Acp
                            && e.meta.acp_agent.as_deref() == Some(name.as_str())
                            && e.meta.project == launch.project
                            && e.meta.agent_session_id.as_ref() == Some(resume)
                    })
                    .map(|e| e.meta.id.clone())
                    .collect();
                if prior.is_empty() {
                    return Err("no resumable session of this agent".into());
                }
                if prior
                    .iter()
                    .any(|id| self.entries[id].meta.state == SessionState::Running)
                {
                    return Err("conversation is already running".into());
                }
                prior
            }
        };
        let acp = crate::acp::Acp::spawn(&proof, &launch.cwd, &self.home, start.resume.clone())?;
        let id = launch.id.clone();
        match prior.first() {
            Some(old) => self.queue.prepare_resume(old, &id)?,
            None => self.queue.register(&id, AgentKind::Acp, queue::now_ms())?,
        }
        // In memory only: the agent never sees it (its env is the allowed names); an inside peer's owner token is
        // swapped for it, so the agent CLI run from the agent acts as this session.
        let token = store::new_id()? + &store::new_id()?;
        crate::logs::register(&token, "session"); // v2-13a
        let meta = Session {
            side_chat: start.args.iter().any(|arg| arg == SIDE_CHAT_ARG),
            stopped_sends: Vec::new(),
            side_parent: side_parent(start),
            side_split: side_split(start),
            machine: None,
            id: id.clone(),
            kind: AgentKind::Acp,
            project: launch.project.clone(),
            cwd: launch.cwd.clone(),
            label: start.label.clone(),
            auto_label: false,
            closed_by_command: false,
            state: SessionState::Running,
            agent_session_id: None,
            agent_version: None,
            untested: false,
            pid: Some(acp.pid()),
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            model: None,
            effort: None,
            start_commit: launch.start_commit.clone(),
            artifacts: None,
            blocked: None,
            holder_status: None,
            config_dir: None,
            account: None,
            conversation: prior
                .iter()
                .find_map(|id| self.entries[id].meta.conversation.clone()),
            acp_agent: Some(name.clone()),
            problem: None,        // V2-5b
            without_hooks: false, // V2-5b
            no_history: false,
            account_tab: false,
            home_lock: false, // ticket 1002: a failed start and an ACP session are never locked
            home_mode: None,
            permission_mode: None, // CHAT-PERMCHIP
            starting: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            parent: None,     // V2.5-30
            teammate: None,
            resumed_from: vec![],
            owned_from: vec![],
            level: None,
            schedule: None,
            token_origin: None, // ticket 573: an ACP agent or a failed start; `spawn_acp` refuses a token's
            closed_at: None,
            ended_at: None,
            started_at: Some(queue::now_ms()),
            agent_ended: false, // ticket 286
            limit: None,
            folder_gone: false, // look 1117 v13: set per snapshot
            ended_ask: None,    // look 1117 v10 N10-S3-3: set per snapshot
            modes: None,
        };
        let removed: Vec<_> = prior
            .iter()
            .filter_map(|old| self.entries.remove(old).map(|e| (old.clone(), e)))
            .collect();
        self.entries.insert(
            id.clone(),
            Entry {
                meta: meta.clone(),
                pty: None,
                pty_size: None,
                token_hash: Some(store::token_sha256(&token)),
                token: Some(token),
                stale: None,
                observer: waiting::Observer::default(),
                input: crate::delivery::Input::default(),
                switch: None,
                walk: None,
                walk_error: None,
                skip_chosen: false,
                skip_hold: None,
                args: None,
                permission: vec![],
                bypass_disabled: false,
                saved: Default::default(),
                probe: None,
                version_probe: None,
                acp: Some(acp),
                agent_ended: false,
                card_due: None,
                launch: None,
            },
        );
        if let Err(e) = self.save() {
            if let Some(mut entry) = self.entries.remove(&id)
                && let Some(acp) = entry.acp.as_mut()
            {
                acp.stop();
            }
            self.entries.extend(removed);
            return Err(e);
        }
        Ok(self.snapshot_session(&meta))
    }
    /// A queued send may go now: an ACP agent takes a prompt between turns, other agents by `delivery::ready`.
    pub(super) fn send_ready(&mut self, id: &str, snapshot: &Session) -> Result<bool, String> {
        let entry = self.entry(id)?;
        Ok(match &entry.acp {
            Some(acp) => acp.ready() && !crate::delivery::blocked(&snapshot.pending),
            None => {
                let screen = entry.observer.screen.text();
                crate::delivery::ready(
                    snapshot.kind,
                    &snapshot.attention,
                    &snapshot.pending,
                    &screen,
                ) && !dialog_up(&screen, snapshot.kind)
            }
        })
    }
    /// Whether an answer to an async question can go in while the turn runs: the screen is current and shows the input
    /// box (so no dialog), and no request waits (a permission's hook is known before its dialog draws).
    pub(super) fn steer_ready(&mut self, id: &str) -> Result<bool, String> {
        let blocked = crate::delivery::blocked(&self.queue.items_of(id));
        let entry = self.entry(id)?;
        Ok(!blocked
            && !entry.observer.behind
            && composer(&entry.observer.screen.text(), entry.meta.kind).is_some())
    }
    /// An ACP send: Esc or Ctrl+C cancels the turn; text is one prompt. No other key reaches the agent.
    pub(super) fn acp_send(
        &mut self,
        id: &str,
        send: &crate::delivery::Send,
    ) -> Result<(), String> {
        let entry = self.entries.get_mut(id).ok_or("session not found")?;
        let acp = entry.acp.as_mut().ok_or("session is not running")?;
        let keys: Vec<String> = send.keys.iter().map(|k| k.to_ascii_lowercase()).collect();
        if keys.len() == 1
            && matches!(keys[0].as_str(), "esc" | "escape" | "ctrl+c")
            && send.content.is_empty()
        {
            return acp.cancel(&mut self.queue);
        }
        if !keys.iter().all(|k| k == "enter") || send.content.trim().is_empty() {
            return Err("an ACP agent takes a text prompt or Esc".into());
        }
        acp.prompt(&entry.meta, &mut self.queue, &send.content)
    }
    /// An ACP session's chat, from its `session/update`s; `None` for other sessions (their chat is the transcript).
    pub(crate) fn acp_chat(
        &self,
        id: &str,
        before: Option<u64>,
        after: Option<u64>,
    ) -> Option<Result<crate::chat::Page, String>> {
        let entry = self.entries.get(id)?;
        (entry.meta.kind == AgentKind::Acp).then(|| match &entry.acp {
            Some(acp) => acp.chat(before, after),
            // shortcut: the chat of an ended ACP run is kept in memory only; a restored or ended row shows none until
            // a resume replays it through `session/load`. Persist the feed if V2-4b needs ended chats.
            None => crate::chat::Feed::default().page(None),
        })
    }
    /// V2-CF4: what the tree needs to show a session's sub-agents, read-only: the children an ACP agent announced
    /// (`subagent_update`, in memory), else the metadata and transcript path the caller folds outside this lock.
    pub(crate) fn kids_source(
        &mut self,
        id: &str,
    ) -> Result<(crate::chat::kids::Kids, Option<KidsFold>), String> {
        let entry = self.entry(id)?;
        if entry.meta.kind == AgentKind::Acp {
            let kids = entry
                .acp
                .as_ref()
                .map_or_else(Default::default, |a| a.kids().clone());
            return Ok((kids, None));
        }
        let meta = entry.meta.clone();
        // The chat reads the same file: its own path when one was found. Look 11-17 v4 B S1-1: the confined locate
        // (a walk of the agent's sessions folder, which can be on a volume macOS holds behind a dialog) runs in the
        // caller, after this lock is released; under it every request waited on the walk.
        let path = entry.observer.transcript.clone();
        Ok((Default::default(), Some((meta, path))))
    }
}
