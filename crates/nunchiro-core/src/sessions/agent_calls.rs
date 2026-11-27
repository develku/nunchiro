//! Requests from session callers: who the caller is, what it may ask, and how its own requests run.
use super::*;
impl Sessions {
    /// v1a-23: the leader pid of each live local session, with its token (the owner peer check names the caller).
    pub(crate) fn live_leaders(&mut self) -> Result<BTreeMap<u32, (u32, Option<String>)>, String> {
        self.refresh()?;
        Ok(self
            .entries
            .values()
            .filter(|e| e.meta.machine.is_none() && e.meta.state == SessionState::Running)
            // V2-1a: with its holder's pid, the leader's parent (V2-1b: also an unattached holder's).
            .filter_map(|e| Some((e.meta.pid?, (e.holder()?.0.pid, e.token.clone()))))
            // V2-4a: an ACP agent and its terminals are children of the core, each leading its own session.
            .chain(
                self.entries
                    .values()
                    .filter(|e| e.meta.state == SessionState::Running)
                    .flat_map(|e| {
                        e.acp.iter().flat_map(|acp| {
                            std::iter::once(acp.pid())
                                .chain(acp.terminal_pids())
                                .map(|pid| (pid, (std::process::id(), e.token.clone())))
                        })
                    }),
            )
            .collect())
    }
    pub(crate) fn agent_caller(&self, token: &str) -> Result<crate::grants::Caller, String> {
        // Round 5 (review r4 MUST 1): a token session's own credential stays that session's caller, so it keeps its
        // room seat; `token_of` gives it the token's limits in every check.
        self.entries
            .values()
            .find(|entry| token_matches(entry, token) && self.agent_running(entry)) // ticket 286: not a shell's
            .map(|entry| crate::grants::Caller {
                id: entry.meta.id.clone(),
                project: entry.meta.project.clone(),
            })
            .or_else(|| self.token_caller(token)) // ticket 573: an outside token
            .ok_or_else(|| "unauthorized".into())
    }
    /// Needs 225: a Codex session's label and the account folder its reset ask is for (`None` = "Your own"). Any other
    /// session has no Codex ticket of its own, so it gets no answer here and its ask is refused.
    pub(crate) fn codex_reset_caller(&self, id: &str) -> Option<(String, Option<PathBuf>)> {
        let meta = &self.entries.get(id)?.meta;
        (meta.kind == AgentKind::Codex).then(|| (meta.label.clone(), meta.config_dir.clone()))
    }

    /// Ticket 286 S2/S3: `agent_live` plus the agent-ended marker itself, for the checks that must hold before
    /// `refresh` has latched it: a restarted core's first request, or a holder not attached (whose marker `refresh`
    /// never reads). Any marker counts, torn or not (the wrapper writes it only after the agent exited); one that
    /// cannot be read counts as ended.
    pub(super) fn agent_running(&self, entry: &Entry) -> bool {
        entry.agent_live()
            && !ended_marker(&self.home, &entry.meta.id)
                .try_exists()
                .unwrap_or(true)
    }
    /// v1a-23 (needs 47): a session caller runs the owner commands (sessions in any project, serve, layout,
    /// worktrees). This keeps what stays the user's: the window's own features, dialog and permission answers (Esc/deny, a verified yes only when the target project's verified-yes option is
    /// on), the launch model check, no hook intake for another session, no window token or transport, and no
    /// approval or verified-yes switch (`ask_owner` turns those into waiting items before this check).
    pub(crate) fn check_agent(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        if self.grants.remote.contains(&caller.id) {
            self.check_owned(caller, request)?;
        }
        self.check_token(caller, request)?; // ticket 573
        if self.locked(&caller.id) {
            self.check_locked(caller, request)?; // ticket 1002 lane 1
        }
        self.check_locked_input(caller, request)?; // look v20 S2
        match request {
            // Ticket 993: a place's lead reads its place's schedules, the Home lead all; any other session none.
            Request::ScheduleList | Request::SessionTidy { .. } => self.schedule_reach(caller).map(drop),
            // Ticket 362: a session caller's child never has Skip permissions in reach, whatever it asks for.
            Request::Start { session, .. }
                if session.kind == AgentKind::Claude && reaches_skip(&session.args) =>
            {
                Err("operation not granted".into())
            }
            Request::Start { session, .. }
                if session.kind == AgentKind::Codex && reaches_codex_bypass(&session.args) =>
            {
                Err("operation not granted".into())
            }
            // v1a-10: session tokens launch only models and efforts the window offers.
            Request::Start { session, .. } if session.model.is_some() || session.effort.is_some() => {
                self.check_stored_model(
                    session.kind,
                    session.model.as_deref(),
                    session.effort.as_deref(),
                )
            }
            Request::Answer { item, answer, .. } => {
                let decision = self.annotated(self.queue.decision(item)?); // V2-8e: its risk, for check_answer
                crate::grants::check_answer(
                    &decision,
                    answer,
                    self.answers_on(&decision.session_id),
                )
            }
            // The window's own features stay the owner's and the window's, as before v1a-23: they were never agent
            // CLI commands (ticket 23 opens the owner commands: sessions, serve, layout, worktrees).
            Request::FilesList { .. }
            | Request::FileRead { .. }
            | Request::FileWrite { .. } // ticket 820: the window's file write is never an agent's
            | Request::FilesSearch { .. }
            | Request::DiffList { .. }
            | Request::DiffFile { .. }
            | Request::ChatPage { .. }
            | Request::HandoffPreview { .. } // v2-3a: transcript text
            | Request::HandoffSend { .. } // v2-3b: starts a session and types into it
            | Request::PrChip { .. } // v2-8b: transcript-derived
            | Request::Subagents { .. } // V2-CF4: transcript-derived, read-only
            | Request::PrLive { .. } // v2-8c: runs the user's gh; the window's own setting
            | Request::PrLiveSet { .. }
            | Request::PrWatch { .. }
            | Request::PrFront { .. }
            | Request::PrView { .. } // V2.5-8/9: runs the user's gh; PrMerge merges as the user
            | Request::PrList
            | Request::PrMerge { .. }
            | Request::PrBranch { .. } // ticket 373: runs the user's gh in a worktree folder
            | Request::GitPush { .. } // pushes as the user after the window's confirm
            | Request::PrDraft { .. }
            | Request::PrCreate { .. } // pushes and runs the user's gh after the window's form
            | Request::AccountList // v2-2a: agent config folders and their login
            | Request::AccountCheck { .. }
            | Request::AccountAdd { .. }
            | Request::AccountRemove { .. } // v2-2d: moves an account folder away
            | Request::AccountRename { .. } // ticket 358: changes what sessions resolve an account by
            | Request::AccountSignIn { .. } // ticket 178 finding 20: browser sign-in, its code, its state
            | Request::AccountSignInCode { .. }
            | Request::AccountSignInCancel { .. }
            | Request::AccountSignInState { .. }
            | Request::AcpAgentSignIn { .. }
            | Request::AcpAgentSignInState { .. }
            | Request::AcpAgentSignInCancel { .. }
            | Request::AcpAgentSignOut { .. }
            | Request::AgentUpdateStart { .. } // ticket 358: runs an installer as the user
            | Request::AgentUpdateCancel { .. }
            | Request::AgentUpdateState
            | Request::SessionContext { .. }
            | Request::AddMachine { .. }
            | Request::ForgetMachine { .. }
            | Request::MachineDetails { .. }
            | Request::MachineAliases // v25f: reads the owner's ~/.ssh, runs ssh
            | Request::MachineProbe { .. }
            | Request::MachineShare // ticket 1050: reads this Mac's host key; Test writes a known_hosts line
            | Request::MachineTrust { .. }
            | Request::AccountUsage { .. } // v2-2c: transcript totals
            | Request::UsageDetail { .. } // v4 Usage page: transcript totals, as AccountUsage
            | Request::CodexResetRead { .. } // needs 225: the owner's Refresh and log; a session only asks to use one
            | Request::CodexResetLog
            | Request::UserCommands { .. } // ticket-98: reads the user's agent config folders
            | Request::ProjectCreate { .. } // V2.5-15: makes a folder, opens an editor, stores an icon
            | Request::ProjectClone { .. } // ticket 370: network I/O from a typed URL, deletes the folder it claimed
            | Request::ProjectCloneState { .. }
            | Request::ProjectCloneCancel { .. }
            | Request::OpenInEditor { .. }
            | Request::EditorApps // ticket 375: reads the owner's Applications folders
            | Request::ProjectIconSet { .. }
            | Request::ProjectIconGet { .. }
            | Request::ProjectFolders // ticket 1040: stats the owner's folders
            | Request::ProjectLocate { .. } // ticket 1040: moves a project's stored records
            | Request::FirstRun // v2-5a: agent detection
            | Request::ProblemFix { .. } // v2-5b: restarts a session, or starts it without hooks
            | Request::LimitResume { .. } // ticket 372: types the fixed continue text into a session at its reset
            | Request::StartOrWait { .. } // the starts waiting for memory: only the owner starts or cancels one
            | Request::MemoryWaitList
            | Request::MemoryWaitGo { .. }
            | Request::MemoryWaitCancel { .. }
            | Request::Typing { .. } // the owner's typing and his choices on a waiting message are his alone
            | Request::SendNow { .. }
            | Request::SendLater { .. }
            | Request::SendAttach { .. }
            | Request::SendDetach { .. }
            | Request::Direct { .. }
            | Request::DraftTaken { .. }
            | Request::DraftPutBack { .. }
            | Request::TakeBack { .. }
            | Request::ImagePut { .. }
            | Request::WidgetList
            | Request::WidgetRun { .. }
            | Request::WidgetAct { .. }
            | Request::WidgetPage { .. }
            | Request::Plugin { .. } // an agent writes a plugin's files; only the owner turns it on or runs it
            // V2.5-35 (ticket 183): BoardSnapshot, BoardPut, BoardMove, BoardTaskPut, BoardDone, BoardAdd, BoardSelf reach
            // `board::rights::serve` with the caller; the window's own board edits stay the owner's.
            | Request::BoardSeen { .. }
            | Request::BoardDelete { .. }
            | Request::BoardColumnsPut { .. }
            | Request::BoardSettingsPut { .. } // V2.5-38: like the columns, the owner's and the window's
            | Request::BoardUndo { .. }
            | Request::BoardResolve { .. }
            | Request::BoardSourceStatus { .. }
            | Request::BoardSourceMove { .. }
            | Request::TreeGet // v2-9a
            | Request::TreeEdit { .. }
            | Request::QuitSettings { .. }
            | Request::GitProviders { .. } // v25f: starts a login tab, and reports the owner's CLI logins
            | Request::QueueConnect
            | Request::SwitchModel { .. }
            | Request::SetMode { .. } // CHAT-MODELIST: a mode change is a person's click, never an agent's
            | Request::AgentPermissionGet // ticket 362: the owner's setting
            | Request::AgentPermissionSet { .. }
            | Request::AgentCommandStatus { .. } // ticket 358: what the owner's sessions run
            | Request::AgentCommandCheck { .. }
            | Request::AgentCommandGrant { .. }
            | Request::AgentCommandReset { .. }
            | Request::CloseUndo { .. } // V2-6d: the window's Undo, as the owner's
            | Request::CloseIdle { .. } // ticket 1130: the composer's restart for a new MCP server
            // V2.5-11: a schedule starts agent work later with the owner's authority, so only the owner makes one.
            | Request::ScheduleAdd { .. }
            | Request::ScheduleRemove { .. }
            | Request::ScheduleRunNow { .. } // ticket 993
            | Request::SchedulePause { .. }
            // V2-1b r3 (S1): only the owner makes the core exit and leave its holders without a core for anyone to
            // attach. `stop` stays a session's (v1a-23, OWNERC D'): it ends every holder with the core.
            | Request::Exit
            | Request::ExitIfIdle { .. }
            | Request::ExitBlockers { .. } // ticket 1130 A-D3: the owner's update asks
            // Ticket 573: tokens are the owner's to make (the server refuses them first).
            | Request::TokenCreate { .. }
            | Request::TokenList
            | Request::TokenRevoke { .. } => Err("operation not granted".into()),
            // Needs 225: a session asks for its own session's account only, and never from another machine.
            Request::CodexResetUse { account, .. }
                if account.is_some() || self.grants.remote.contains(&caller.id) =>
            {
                Err("operation not granted".into())
            }
            Request::Hook { .. }
            | Request::WindowAuth
            | Request::Remote { .. }
            | Request::RemoteService { .. }
            | Request::Forwarded { .. }
            | Request::MachineStatus { .. }
            | Request::ApprovalGrant { .. }
            | Request::BoardSourceGrant { .. }
            // Ticket 259: a setup script is approved by a person in the window (the server refuses these first).
            | Request::SetupStatus { .. }
            | Request::SetupGrant { .. }
            // V2-4a: approving an agent is human-only; never asked of the owner from a session either.
            | Request::AcpAgentStatus { .. }
            | Request::AcpAgentGrant { .. }
            // V2-4b: so are the setup requests (they run the typed command, write agents.toml, open a login tab).
            | Request::AcpAgents
            | Request::AcpAgentCheck { .. }
            | Request::AcpAgentAdd { .. }
            | Request::AcpAgentLogin { .. }
            // Ticket 276: an agent may not list, add or remove extensions.
            | Request::ExtensionsList
            | Request::ExtensionsMcpAdd { .. }
            | Request::ExtensionsMcpRemove { .. }
            | Request::ExtensionsItemFiles { .. }
            | Request::ExtensionsItemRead { .. }
            | Request::ExtensionsItemSave { .. }
            | Request::ExtensionsSkillNew { .. }
            | Request::ExtensionsItemRemove { .. }
            | Request::PermissionAnswers { on: true, .. } => Err("operation not granted".into()),
            // Ticket 286 r6 (Codex security review of 1a7025d4): a session caller closes only itself and the sessions
            // it started (their stored `parent`, which outlives a core restart, or a run it resumed: `started_by`); a
            // user tab or another parent's worker stays the owner's to close. Remote callers already passed
            // `check_owned` (their own workers only).
            Request::Close { id }
                if *id != caller.id
                    && self
                        .entries
                        .get(id)
                        .is_some_and(|e| !self.started_by(&e.meta, &caller.id)) =>
            {
                Err("a session closes only itself and the sessions it started".into())
            }
            _ => Ok(()),
        }
    }
    /// Ticket 1002 lane 1: the session runs with the Home seat lock.
    pub(crate) fn locked(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| e.meta.home_lock)
    }
    /// Ticket 1002 lane 1 (Fable check M5): what a locked session (the Home seat and what it started) may ask the core:
    /// its own work only, by op name (lane 2's outbox ops are named here before they exist on this branch). No shell,
    /// Codex or ACP child, no typed keys, no other machine, no browser, nothing sent to a session it did not start.
    pub(crate) fn check_locked(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        const OPS: &[&str] = &[
            "hook",
            "task",
            "role",
            "note",
            "schedule_list",
            "schedule_propose",
            "schedule_change",
            "bot_offer",
            "room_send",
            "room_reply",
            "room_check",
            "room_thread",
            "room_read",
            "room_pin",
            "room_answer",
            "outbox_stage",
            "outbox_spend",
            "agent_list",
            "list",
            "events",
            "start",
            "team_open",
            "close",
            "session_tidy",
            "agent_send",
            "agent_prompt",
            "steer_now",
            "cancel_send",
            "agent_read",
            "agent_get",
            "read",
        ];
        let op = serde_json::to_value(request)
            .ok()
            .and_then(|v| Some(v.get("op")?.as_str()?.to_string()))
            .unwrap_or_default();
        let refused = || {
            Err(format!(
                "{op}: not for the chief of staff's seat (ticket 1002 seat lock)"
            ))
        };
        // Fable round 3 review M1: another session is its own only when it is locked too (an adopted pre-lock worker is
        // not).
        let own = |id: &str| {
            id == caller.id
                || self
                    .entries
                    .get(id)
                    .is_some_and(|e| e.meta.home_lock && self.started_by(&e.meta, &caller.id))
        };
        match request {
            _ if !OPS.contains(&op.as_str()) => refused(),
            // A child is a Claude start in the Home folder itself (Fable review R1a, final S6: not a subfolder, whose
            // own `.claude` the parent could have written) with no arguments, env, folder or worktree;
            // `launch_as` locks it.
            Request::Start {
                session,
                folder,
                env,
                ..
            } if session.kind != AgentKind::Claude
                || !session.args.is_empty()
                || !env.is_empty()
                || folder.is_some()
                || session.worktree
                || fs::canonicalize(&session.project).ok()
                    != Some(crate::team::Team::open(&self.home).home()) =>
            {
                refused()
            }
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SteerNow { id, .. }
            | Request::CancelSend { id, .. }
            | Request::AgentRead { id, .. }
            | Request::AgentGet { id }
            | Request::Read { id, .. }
                if !own(id) =>
            {
                refused()
            }
            _ => Ok(()),
        }
    }
    /// Look v20 S2: a locked seat takes input (text, keys, a prompt, a send canceled, an answer to its prompt) only from
    /// the owner (the window and the owner socket never come here), itself, and a locked session that started it. A
    /// room line reaches it as the room's own fixed notice.
    fn check_locked_input(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        let target = match request {
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SteerNow { id, .. }
            | Request::AgentKeys { id, .. }
            | Request::SendText { id, .. }
            | Request::SendKeys { id, .. }
            | Request::CancelSend { id, .. } => id.clone(),
            Request::Answer { item, .. } => match self.queue.decision(item) {
                Ok(d) => d.session_id,
                Err(_) => return Ok(()), // not an agent's item: answering it reaches no seat
            },
            _ => return Ok(()),
        };
        let from_its_lead = self.locked(&caller.id)
            && self
                .entries
                .get(&target)
                .is_some_and(|e| self.started_by(&e.meta, &caller.id));
        if self.locked(&target) && target != caller.id && !from_its_lead {
            return Err("refused: the chief of staff's seat is locked and takes input only from you, in the window (ticket 1002 seat lock); nothing was sent".into());
        }
        Ok(())
    }
    /// Whether `caller` started `meta`'s session: its stored `parent` is the caller, or a run the caller resumed. Look
    /// 1117 v13 B N13-S2-2: a seat started before a quit and Resume names its lead's old id, which the core keeps in the
    /// lead's `owned_from` (an owner's or the core's resume only); the lead could not close it or clean up its worktree.
    pub(super) fn started_by(&self, meta: &Session, caller: &str) -> bool {
        meta.parent.as_deref().is_some_and(|p| {
            p == caller
                || self
                    .entries
                    .get(caller)
                    .is_some_and(|c| c.meta.owned_from.iter().any(|r| r == p))
        })
    }
    /// v1a-23: the verified-yes option of the project the target session runs in.
    fn answers_on(&self, session: &str) -> bool {
        self.entries.get(session).is_some_and(|e| {
            self.settings
                .permission_answers
                .get(&e.meta.project)
                .copied()
                .unwrap_or(false)
        })
    }
    /// v1a-23: the two human actions asked by a session caller become one waiting item for the owner (one per
    /// subject or project; a repeat returns the same item). `None` for every other request.
    pub(crate) fn ask_owner(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Option<Response> {
        use crate::approval::SubjectKind;
        let approval =
            |subject, name: &String, level, view: Result<crate::approval::View, String>| {
                view.map(|v| queue::OwnerAsk::Approval {
                    subject,
                    name: name.clone(),
                    level,
                    hash: v.hash,
                })
            };
        let ask = match request {
            Request::ApprovalGrant { name, level, .. } => approval(
                SubjectKind::Widget,
                name,
                *level,
                crate::approval::status(&self.home, name),
            ),
            Request::BoardSourceGrant { name, level, .. } => approval(
                SubjectKind::Source,
                name,
                *level,
                crate::approval::source_status(&self.home, name),
            ),
            Request::PermissionAnswers { project, on: true } => fs::canonicalize(project)
                .map(|project| queue::OwnerAsk::PermissionAnswers { project })
                .map_err(|e| e.to_string()),
            Request::QuitSettings { patch } if crate::account_near::asks_leads_any(patch) => {
                Ok(queue::OwnerAsk::LeadAccounts)
            }
            _ => return None,
        };
        // Ticket 573: an outside token never asks the owner for a setting.
        if self.token_of(caller).is_some() {
            return Some(Err("operation not granted".into()));
        }
        Some(
            ask.and_then(|ask| self.queue.ask_owner(&caller.id, ask))
                .map(|item| Reply::Waiting { item }),
        )
    }
    /// V1A-04 grants, now for remote callers only (V1A-06: `--machine` reach stays the owned workers).
    /// Ticket 573: the sessions a remote-flagged caller may see events of (`owns`, as its snapshot); `None` for any
    /// other caller.
    pub(crate) fn owned_sessions(
        &self,
        caller: &crate::grants::Caller,
    ) -> Option<std::collections::BTreeSet<String>> {
        self.grants.remote.contains(&caller.id).then(|| {
            self.entries
                .values()
                .filter(|e| self.grants.owns(caller, &e.meta))
                .map(|e| e.meta.id.clone())
                .collect()
        })
    }
    fn check_owned(&self, caller: &crate::grants::Caller, request: &Request) -> Result<(), String> {
        if let Request::Start {
            session, folder, ..
        } = request
        {
            let project = fs::canonicalize(&session.project).map_err(|e| e.to_string())?;
            // v1a-16
            if project != caller.project && !self.created_worktree(caller, &project)? {
                return Err("outside session grants".into());
            }
            if let Some(folder) = folder
                && !self.created_worktree(caller, folder)?
            {
                return Err("outside session grants".into());
            }
            // v1a-10: session tokens launch only models and efforts the window offers.
            if session.model.is_some() || session.effort.is_some() {
                self.check_stored_model(
                    session.kind,
                    session.model.as_deref(),
                    session.effort.as_deref(),
                )?;
            }
            if let Some(resume) = &session.resume
                && !self.entries.values().any(|e| {
                    e.meta.agent_session_id.as_ref() == Some(resume)
                        && self.grants.owns(caller, &e.meta)
                })
            {
                return Err("resume outside session grants".into());
            }
            return Ok(());
        }
        if matches!(
            request,
            Request::List | Request::Snapshot | Request::AgentList { .. } // V2.5-30: filtered by `owns`
            | Request::Events { .. } // ticket 573: filtered by `owned_sessions`
        ) {
            return Ok(());
        }
        let id = if let Request::Answer { item, answer, .. } = request {
            let decision = self.annotated(self.queue.decision(item)?); // V2-8e
            crate::grants::check_answer(
                &decision,
                answer,
                self.settings
                    .permission_answers
                    .get(&caller.project)
                    .copied()
                    .unwrap_or(false),
            )?;
            decision.session_id
        } else {
            crate::grants::request_target(request)
                .ok_or("operation not granted")?
                .to_string()
        };
        let entry = self.entries.get(&id).ok_or("session not found")?;
        if !self.grants.owns(caller, &entry.meta) {
            return Err("outside session grants".into());
        }
        Ok(())
    }
    /// `remote`: this request came forwarded from another machine (ticket 32: per request, never remembered).
    pub(crate) fn start_granted(
        &mut self,
        caller: &crate::grants::Caller,
        launch: &Launch,
        remote: bool,
    ) -> Result<Session, String> {
        // v1a-16: re-read the store on every start; a yes is never cached. v1a-23: remote callers only.
        let worktree = launch.project != caller.project;
        if worktree && remote && !self.created_worktree(caller, &launch.project)? {
            return Err("outside session grants".into());
        }
        // Ticket 990: a worktree start now arrives as `folder` (its project is the main checkout). The caller's own
        // folder stays allowed, as it was when the worktree was the project (a worker starting its reviewer).
        if remote
            && let Some(folder) = &launch.folder
            && self
                .entries
                .get(&caller.id)
                .is_none_or(|e| &e.meta.cwd != folder)
            && !self.created_worktree(caller, folder)?
        {
            return Err("outside session grants".into());
        }
        // ACCOUNTPICK: the prepared launch (a resume included) runs on the caller's account; shells use none.
        // Ticket 1120: or the account the user set for the caller's place. Ticket 1126: or the owner's default, read
        // again here, so a launch prepared before the owner changed it is refused rather than started on the old one.
        // An explicit "Your own" default admits no label (None) for a caller on another account.
        let default = self.default_account(launch.start.kind, remote);
        if !matches!(launch.start.kind, AgentKind::Shell | AgentKind::Acp)
            && launch.account != self.caller_account(caller, remote)
            && default.as_ref() != Some(&launch.account)
            && (launch.account.is_none()
                || (launch.account != self.place_account(caller, remote)
                    && !self.lead_any(caller, remote)))
        {
            return Err("a session can start sessions only on its own account".into());
        }
        // Owner 2026-11-25: a start that only "Leads may use any of my accounts" admits says so in the room.
        let lead_line = (launch.account.is_some()
            && !matches!(launch.start.kind, AgentKind::Shell | AgentKind::Acp)
            && launch.account != self.caller_account(caller, remote)
            && launch.account != self.place_account(caller, remote)
            && default.as_ref() != Some(&launch.account))
        .then(|| launch.account.clone())
        .flatten();
        // Ticket 990 slice g: among the seats a lead's side starts, one writer per worktree. A resume continues a seat
        // (`start` moves it); a shell is no seat.
        let ledger = crate::ledger::Ledger::open(&self.home);
        // After one Codex look: only a session that works for the task's own lead is its seat. Any session may start
        // one in any folder; one from another place gets no seat there (no review, no notes of that project).
        let lead = self.team_lead_of(&caller.id);
        let seat_in = (launch.start.kind != AgentKind::Shell && launch.start.resume.is_none())
            .then(|| launch.cwd.clone())
            .filter(|cwd| {
                lead.is_some() && ledger.of_worktree(cwd).is_some_and(|t| t.lead == lead)
            });
        if let Some(cwd) = &seat_in
            && crate::roles::of(&self.home, &launch.start.label).1
        {
            ledger.writer_free(cwd, |s| self.entries.get(s).is_some_and(|e| e.agent_live()))?;
        }
        // Codex security look P2: the line is the audit of the start, so it is written first and a refused write
        // (a full room) refuses the start.
        if let Some(account) = &lead_line {
            self.lead_any_line(caller, launch, account)?;
        }
        let mut child = self.start(launch)?;
        if let Some(cwd) = &seat_in {
            let live = |s: &str| self.entries.get(s).is_some_and(|e| e.agent_live());
            match ledger.seat(cwd, &child.id, &child.label, queue::now_ms(), &live) {
                Ok(Some(task)) => crate::events::tasks(&task.place),
                Ok(None) => {}
                Err(e) => eprintln!("ledger seat not recorded: {e}"),
            }
        }
        self.grants
            .parents
            .insert(child.id.clone(), caller.id.clone());
        if worktree {
            self.grants
                .worktrees
                .insert(child.id.clone(), launch.project.clone());
        }
        // V2.5-30: the parent link on the stored record outlives a core restart (the grants map does not). The child
        // already runs, so a failed save is logged, not returned; the next save writes it.
        child.parent = Some(caller.id.clone());
        // After one Codex look: a session's own start never takes a teammate's seat, also when it resumes a seat's
        // conversation (the resumed run would carry the mark, and a lead's mark opens its place's teammates). A seat
        // is marked only by `team::open_seat`, after this.
        child.teammate = None;
        // Codex security MUST (w20-h): nor the close rights of the run it resumes (a local agent can name any ended
        // run's conversation in its project); `resumed_from` stays, for the room's names only.
        child.owned_from.clear();
        if let Some(entry) = self.entries.get_mut(&child.id) {
            entry.meta.parent = child.parent.clone();
            entry.meta.teammate = None;
            entry.meta.owned_from.clear();
        }
        if let Err(e) = self.save() {
            eprintln!("parent link not saved yet: {e}");
        }
        Ok(child)
    }
    // v1a-16: exactly the path of a present managed worktree of the caller's project that this session created.
    // v1a-21: a busy worktree lock is reported as busy instead of a refusal; v1a-22: `past_busy_worktree` retries it.
    fn created_worktree(
        &self,
        caller: &crate::grants::Caller,
        project: &Path,
    ) -> Result<bool, String> {
        let listed = self
            .worktree_plan(
                Some(caller),
                Request::Worktree {
                    operation: "list".into(),
                    project: Some(caller.project.clone()),
                    path: None,
                    branch: None,
                    base: String::new(),
                    label: String::new(),
                    from: None,
                    confirm: None,
                },
            )
            .and_then(WorktreePlan::execute);
        match listed {
            Err(e) if e == WORKTREE_BUSY => Err(e),
            listed => Ok(listed.is_ok_and(|(worktrees, _)| {
                worktrees.iter().any(|w| {
                    w.path == project && !w.missing && w.creator.as_deref() == Some(&caller.id)
                })
            })),
        }
    }
    /// v1a-22: runs `f` under the registry lock, retrying a busy worktree lock for 500 ms with the registry
    /// released between tries; returns the guard `f` last succeeded under. Ticket 396: an answer waiting for a resize
    /// redraw retries the same way and, still not redrawn, gets the usual refusal.
    pub(crate) fn past_busy_worktree<T>(
        registry: &std::sync::Mutex<Sessions>,
        mut f: impl FnMut(&mut Sessions) -> Result<T, String>,
    ) -> Result<(std::sync::MutexGuard<'_, Sessions>, T), String> {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            let mut sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            match f(&mut sessions) {
                Err(e)
                    if (e == WORKTREE_BUSY || e == SCREEN_REDRAWING)
                        && std::time::Instant::now() < until =>
                {
                    drop(sessions);
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(e) if e == SCREEN_REDRAWING => return Err(NOT_ON_SCREEN.into()),
                result => return result.map(|t| (sessions, t)),
            }
        }
    }
    pub(crate) fn handle_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: Request,
    ) -> Response {
        self.changed(); // as `handle`: an agent's request may change what a window's snapshot reads
        self.refresh()?;
        self.observe()?;
        self.check_agent(caller, &request)?;
        match &request {
            Request::AgentSend { id, text } | Request::SendText { id, text, .. } => {
                return self.send(&caller.id, id, text.clone(), vec![], false);
            }
            Request::AgentPrompt { id, text } => {
                let text = self.with_notes(id, text.clone()); // ticket 990 slice h
                return self.send(&caller.id, id, text, vec![], true);
            }
            // v25-sendkeys: a session caller's steer takes the same checks as its own Esc and prompt.
            Request::SteerNow { id, text, seen } => {
                return self.steer_now(&caller.id, id, text.clone(), seen);
            }
            Request::SendKeys { id, keys, .. } | Request::AgentKeys { id, keys } => {
                // v1a-23: the target's project; r2 (S1): a remote caller also needs the flag its machine delegated
                // (`remote_policy` puts it on `caller.project`), never only this machine's own setting.
                let enabled = self.answers_on(id)
                    && (!self.grants.remote.contains(&caller.id)
                        || self
                            .settings
                            .permission_answers
                            .get(&caller.project)
                            .copied()
                            .unwrap_or(false));
                return self.agent_keys(&caller.id, id, keys.clone(), enabled);
            }
            Request::Answer {
                item,
                answer,
                confirmed,
            } => {
                let target = self.queue.decision(item)?.session_id;
                let send = self.begin_send(
                    &caller.id,
                    &target,
                    format!(
                        "answer: {}",
                        serde_json::to_string(answer).map_err(|e| e.to_string())?
                    ),
                    vec![],
                    false,
                    "attempting",
                )?;
                let result = self.answer(item, answer.clone(), *confirmed);
                self.finish_send(
                    &target,
                    &send.id,
                    if result.is_ok() {
                        "delivered"
                    } else {
                        "failed"
                    },
                )?;
                return result;
            }
            // Ticket 993: only what the caller may read (`check_agent` refused every session that is no lead's seat).
            Request::ScheduleList => {
                let place = self.schedule_reach(caller)?;
                return self
                    .schedules_in(place.as_deref())
                    .map(|schedules| Reply::Schedules { schedules });
            }
            Request::SchedulePropose {
                who,
                when,
                task,
                level,
            } => return self.schedule_propose(caller, who, when, task.clone(), *level),
            Request::ScheduleChange { id, change } => {
                return self.schedule_change(caller, id, change);
            }
            Request::BotOffer { name, job, why } => return self.bot_offer(caller, name, job, why),
            Request::OutboxStage { .. } => return self.outbox_stage(caller, &request), // ticket 1002
            Request::OutboxSpend { tool, args_hash } => {
                return self.outbox_spend(caller, tool, args_hash);
            }
            // V2-1b: a session caller's close never ends an agent its holder no longer answers for.
            Request::Close { id } => return self.close(id, false, false),
            Request::SessionTidy { id, why } => {
                return self.tidy_session(caller, id, why, queue::now_ms());
            }
            Request::Resize { id, cols, rows } => {
                // v1a-75: a session agent's resize never arms the V1A-71 grace, or it could keep a gone prompt's card.
                // Nor does it keep the screen for `restore_undrawn` (which holds the card and arms that grace): after
                // an agent's resize the screen is blank until the agent redraws, as before (Codex look on wave 14).
                self.resize_pty(id, *cols, *rows)?;
                self.entry(id)?.observer.unredrawn = None;
                return Ok(Reply::Ack);
            }
            _ => {}
        }
        // Ticket 571: the room stamps this caller as the sender.
        if room::is_room(&request) {
            return self.room(Some(caller), request);
        }
        // V2.5-35 (ticket 183): a session's board requests carry the caller the core resolved (token, peer check).
        if let Request::BoardSnapshot
        | Request::BoardPut { .. }
        | Request::BoardMove { .. }
        | Request::BoardTaskPut { .. }
        | Request::BoardDone { .. }
        | Request::BoardAdd { .. }
        | Request::BoardSelf = request
        {
            return self.board(crate::board::rights::Writer::Session(&caller.id), request);
        }
        if let Request::List | Request::Snapshot | Request::AgentList { .. } = request {
            // V2.5-30: `--mine` is the caller's direct children; the caller is the token's or the peer-checked session.
            let mine = matches!(request, Request::AgentList { mine: true });
            self.refresh()?;
            self.observe()?;
            return Ok(Reply::Snapshot {
                sessions: self
                    .started_order()
                    .filter(|e| self.grants.owns(caller, &e.meta)) // v1a-23: every session, unless remote
                    .filter(|e| self.token_reaches(caller, &e.meta)) // ticket 573: a project token's project
                    .filter(|e| !mine || self.started_by(&e.meta, &caller.id))
                    .map(|e| self.snapshot_session(&e.meta))
                    .collect(),
                keep_awake_held: crate::keep_awake::held(), // V2-CF5
                problem: None, // v2-5b: the core's own problems are the owner's
                board_decisions: vec![], // v1b-18: board decisions are the owner's
                owner_decisions: vec![], // v1a-23: so are the waiting owner items
            });
        }
        self.handle(request)
    }
    /// V2.5-35: every board request, under the registry lock, with the live sessions the rights check reads.
    pub(super) fn board(&self, writer: crate::board::rights::Writer, request: Request) -> Response {
        let sessions: Vec<_> = self
            .entries
            .values()
            .map(|e| self.snapshot_session(&e.meta))
            .collect();
        let mut reply = crate::board::rights::serve(&self.home, &sessions, writer, request)?;
        if let Reply::BoardSnapshot { board } = &mut reply {
            let merging: Vec<String> = self
                .queue
                .owner_items()
                .into_iter()
                .filter_map(|i| match i.owner {
                    Some(queue::OwnerAsk::Merge { task, .. }) => Some(task),
                    _ => None,
                })
                .collect();
            crate::board::task_cards_by_merge(board, &merging);
        }
        Ok(reply)
    }
    pub fn authorize_hook(&self, token: &str, request: &Request) -> bool {
        match request {
            Request::Hook { id, .. } => self
                .entries
                .get(id)
                .is_some_and(|e| token_matches(e, token)),
            _ => false,
        }
    }
}
/// V2-1b: whether `token` is this session's: its agent's token (by hash, in constant time) or the in-memory alias an
/// inside peer's owner token is swapped for.
fn token_matches(entry: &Entry, token: &str) -> bool {
    let presented = store::token_sha256(token);
    entry
        .token_hash
        .as_ref()
        .is_some_and(|h| crate::server::token_equal(presented.as_bytes(), h.as_bytes()))
        || entry
            .token
            .as_ref()
            .is_some_and(|t| crate::server::token_equal(token.as_bytes(), t.as_bytes()))
}
