//! Read-only views: a session's output and transcript plans, the pushed snapshot, and facts tickers ask.
use super::*;
impl Sessions {
    /// CHAT-USAGE: copy only transcript identity; no file I/O or send-path access under the registry lock.
    pub(crate) fn context_target(&self, id: &str) -> Option<crate::session_context::Target> {
        let meta = &self.entries.get(id)?.meta;
        if meta.machine.is_some() || !matches!(meta.kind, AgentKind::Claude | AgentKind::Codex) {
            return None;
        }
        Some(crate::session_context::Target {
            kind: meta.kind,
            agent_session_id: meta.agent_session_id.clone()?,
            config_dir: meta.config_dir.clone(),
            cwd: meta.cwd.clone(),
            transcript: self.entries.get(id)?.observer.transcript.clone(),
        })
    }
    // v1b-02: capture under the registry lock; execute after releasing it.
    pub(crate) fn chat_plan(
        &mut self,
        id: &str,
        before: Option<u64>,
        after: Option<u64>,
    ) -> Result<crate::chat::ReadPlan, String> {
        let entry = self.entry(id)?;
        let meta = entry.meta.clone();
        let path = entry.observer.transcript.clone();
        self.chat.plan_source(&meta, path, before, after)
    }
    pub(crate) fn chat_stop_plan(
        &mut self,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<Option<crate::chat::StopPlan>, String> {
        if payload["agent_id"].as_str().is_some_and(|s| !s.is_empty()) {
            return Ok(None);
        }
        let Some(text) = payload["last_assistant_message"].as_str() else {
            return Ok(None);
        };
        let turn = crate::chat::stop_turn(payload, self.queue.attention(id).completion_seq);
        let meta = self.entry(id)?.meta.clone();
        self.chat.stop_plan(&meta, turn, text.into()).map(Some)
    }
    // v1b-11
    /// For a diff request: the session's folder and start commit, so the caller can drop the lock
    /// before `diff::run` (all `git` work). `None` for any other request.
    pub(crate) fn diff_root(
        &self,
        request: &Request,
    ) -> Option<Result<(PathBuf, Option<crate::diff::Base>), String>> {
        let (Request::DiffList { session, .. } | Request::DiffFile { session, .. }) = request
        else {
            return None;
        };
        Some(
            self.entries
                .get(session)
                .map(|e| (e.meta.cwd.clone(), e.meta.start_commit.clone()))
                .ok_or_else(|| "session not found".into()),
        )
    }
    /// The folder a session runs in, for the Diff panel's Push (`git_write`), which runs after the lock is released.
    pub(crate) fn session_folder(&self, id: &str) -> Result<PathBuf, String> {
        self.entries
            .get(id)
            .map(|e| e.meta.cwd.clone())
            .ok_or_else(|| "session not found".into())
    }
    /// A session's record, for the form's Write with AI (`text_gen`), which runs after the lock is released.
    pub(crate) fn session_meta(&self, id: &str) -> Result<crate::api::Session, String> {
        self.entries
            .get(id)
            .map(|e| e.meta.clone())
            .ok_or_else(|| "session not found".into())
    }
    // v1b-05: the data home for an upload to a known session; the write runs after the lock is released.
    pub(crate) fn image_home(
        &self,
        request: &Request,
    ) -> Option<Result<std::path::PathBuf, String>> {
        let Request::ImagePut { session, .. } = request else {
            return None;
        };
        Some(if self.entries.contains_key(session) {
            Ok(self.home.clone())
        } else {
            Err("session not found".into())
        })
    }
    // v1b-08
    /// For a files request: its root, resolved here so the caller can drop the registry lock and run
    /// `files::run` (all file and `git` work) outside it. A session id names its folder or worktree;
    /// `data` names Nunchiro's data folder. `None` for any other request.
    pub(crate) fn file_root(&self, request: &Request) -> Option<Result<files::Root, String>> {
        let (Request::FilesList { root, .. }
        | Request::FileRead { root, .. }
        | Request::FileWrite { root, .. }
        | Request::FilesSearch { root, .. }) = request
        else {
            return None;
        };
        Some(if root == "data" {
            Ok(files::Root::Data(self.home.clone()))
        } else {
            self.entries
                .get(root)
                .map(|e| files::Root::Folder(e.meta.cwd.clone()))
                .ok_or_else(|| "session not found".into())
        })
    }
    pub(crate) fn transcript_read(
        &mut self,
        id: &str,
        lines: usize,
    ) -> Result<crate::delivery::TranscriptRead, String> {
        if lines == 0 || lines > 10000 {
            return Err("lines must be 1..10000".into());
        }
        let entry = self.entry(id)?;
        Ok(crate::delivery::TranscriptRead {
            session: entry.meta.clone(),
            path: entry.observer.transcript.clone(),
            lines,
        })
    }
    pub(crate) fn transcript_read_current(&self, plan: &crate::delivery::TranscriptRead) -> bool {
        self.entries.get(&plan.session.id).is_some_and(|entry| {
            entry.meta.project == plan.session.project
                && entry.meta.cwd == plan.session.cwd
                && entry.meta.agent_session_id == plan.session.agent_session_id
                && entry.observer.transcript == plan.path
        })
    }
    pub(super) fn agent_read(&mut self, id: &str, source: &str, lines: usize) -> Response {
        if lines == 0 || lines > 10000 {
            return Err("lines must be 1..10000".into());
        }
        let text = match source {
            "screen" => self.entry(id)?.observer.screen.text(),
            "transcript" => return Err("transcript read requires off-lock preparation".into()),
            _ => return Err("unknown read source".into()),
        };
        let rows: Vec<_> = text.trim_end().lines().collect();
        Ok(Reply::Text {
            text: rows[rows.len().saturating_sub(lines)..].join("\n"),
        })
    }
    /// Q10: a row of this core (a pushed remote row of the same id never takes its place).
    pub(crate) fn is_local(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
    pub(super) fn entry(&mut self, id: &str) -> Result<&mut Entry, String> {
        self.entries
            .get_mut(id)
            .ok_or_else(|| "session not found".into())
    }
    pub(super) fn live(&mut self, id: &str) -> Result<&mut Pty, String> {
        self.entry(id)?
            .pty
            .as_mut()
            .ok_or_else(|| "session is not running".into())
    }
    /// Window terminal stream: replay bytes only, without the refresh and screen observation that
    /// `handle` runs (the core tick already does both every 50 ms).
    pub(crate) fn output(&self, id: &str, after: u64) -> Response {
        read_replay(
            &self.home,
            self.entries.get(id).ok_or("session not found")?,
            after,
        )
    }
    /// v1a-27: lets a window loop see new output for `id` without taking the registry.
    pub(crate) fn tail(&self, id: &str) -> Option<crate::pty::Tail> {
        let entry = self.entries.get(id)?;
        match &entry.pty {
            Some(pty) => Some(pty.tail()),
            None => entry.saved.get()?.as_ref().map(|s| s.tail()), // v1a-40
        }
    }
    /// V2-CF5: whether any session is working right now, read-only. `attention.working` is set by the queue's hook
    /// and transcript paths; this only filters it, exactly as `snapshot_session` reports it.
    pub fn any_working(&self) -> bool {
        self.entries
            .keys()
            .any(|id| self.queue.attention(id).working)
    }
    /// V2-CF5: what the keep-awake ticker needs: the setting and whether any session works.
    pub(crate) fn keep_awake_view(&self) -> (bool, bool) {
        (self.settings.keep_awake, self.any_working())
    }
    /// V2-8a: what the auto-clean pass needs: the setting, the worktree root and the folders sessions run in.
    pub(crate) fn auto_clean_view(&self) -> (bool, PathBuf, Vec<PathBuf>) {
        (
            self.settings.auto_clean_worktrees,
            self.worktree_root(),
            self.entries
                .values()
                .filter(|e| e.meta.state == SessionState::Running)
                .map(|e| e.meta.cwd.clone())
                .collect(),
        )
    }
    /// Ticket 335: while `git.auto_pull` is on, the project checkouts and where sessions are running now.
    pub(crate) fn auto_pull_view(
        &self,
    ) -> Option<(std::collections::BTreeSet<String>, Vec<PathBuf>)> {
        self.settings.feature::<bool>("git.auto_pull")?.then(|| {
            let running = self
                .entries
                .values()
                .filter(|e| e.meta.state == SessionState::Running)
                .map(|e| e.meta.cwd.clone())
                .collect();
            (self.project_roots(), running)
        })
    }
    /// v25f: the root of records made before a record kept its own (the auto-clean pass and a plan start from it).
    pub(super) fn worktree_root(&self) -> PathBuf {
        self.settings.legacy_worktree_root(&self.home)
    }
    /// Ticket 259: whether a running session matches `f` (the setup and cleanup tabs).
    pub(crate) fn tab_running(&self, f: impl Fn(&Session) -> bool) -> bool {
        self.entries
            .values()
            .any(|e| e.meta.state == SessionState::Running && f(&e.meta))
    }
    pub(crate) fn home(&self) -> &Path {
        &self.home
    }
    /// True once the owner's Stop or an exit ran: nothing starts after it.
    pub(crate) fn stopped(&self) -> bool {
        self.left || self.halted
    }
    /// Home view change 1: what the digest reads of the registry, per project (a worktree session's is its main
    /// checkout): its working seats, its pending decisions as the tree and Decisions count them (its sessions' asks
    /// and the owner cards about it) and its newest activity (ms, with the session's name). With the registered projects.
    pub(crate) fn digest_facts(&self) -> (Vec<PathBuf>, BTreeMap<PathBuf, DigestFacts>) {
        let mut by: BTreeMap<PathBuf, DigestFacts> = BTreeMap::new();
        // The owner cards about one project (a merge, a role, a goal) are its decisions too, as in Decisions.
        for i in self.queue.owner_items() {
            let place = match &i.owner {
                Some(
                    queue::OwnerAsk::Merge { place, .. }
                    | queue::OwnerAsk::Role { place, .. }
                    | queue::OwnerAsk::Goal { place, .. }
                    | queue::OwnerAsk::Schedule { place, .. } // ticket 993
                    | queue::OwnerAsk::Stall { place, .. } // ticket 1004
                    | queue::OwnerAsk::Tidy { place, .. } // ticket 1005
                    | queue::OwnerAsk::NightTidy { place, .. }
                    | queue::OwnerAsk::Cap { place, .. } // ticket 1099
                    | queue::OwnerAsk::Bot { place, .. }
                    | queue::OwnerAsk::SessionClose { place, .. }, // ticket 1113
                ) => place.clone(),
                _ => continue,
            };
            by.entry(place)
                .or_default()
                .pending
                .push((i.id, i.observed_at, i.session_id));
        }
        for e in self.entries.values() {
            if e.meta.state == SessionState::Closed || e.meta.machine.is_some() {
                continue;
            }
            let f = by.entry(e.meta.project.clone()).or_default();
            let live = e.agent_live();
            let attention = self.queue.attention(&e.meta.id);
            let asks = f.pending.len();
            // Look 11-17 v4f N-B: only a live session's asks, as the snapshot's `pending` (Decisions, the tree) counts
            // them; an ended one's items stay on disk as resume evidence only and answer nothing.
            for i in self.queue.items_of(&e.meta.id).into_iter().filter(|_| live) {
                if !matches!(
                    i.kind,
                    queue::Kind::Stale | queue::Kind::Background | queue::Kind::Owner
                ) {
                    f.pending.push((i.id, i.observed_at, e.meta.id.clone()));
                }
            }
            // As the tree reads a session: one that waits for the user is not working (look 1117 v3 N2: a row said
            // "1 working" while its only session sat at a permission card).
            if crate::ledger::working_now(live, &attention, f.pending.len() - asks) {
                f.working += 1;
            }
            if attention.last_activity > f.last.0 {
                f.last = (attention.last_activity, e.meta.label.clone());
            }
            // Look 11-17 v5 item 4: a seat whose session failed, unless another of its sessions runs.
            if let Some(mate) = &e.meta.teammate {
                if live {
                    f.seats_live.insert(mate.clone());
                } else if e.meta.state == SessionState::Failed {
                    f.seats_failed.insert(mate.clone());
                }
            }
        }
        let roots = self
            .project_roots()
            .into_iter()
            .map(PathBuf::from)
            .collect();
        (roots, by)
    }
    /// V2.5-17: the snapshot of the state `tick` keeps current, without another refresh and observe pass; each open
    /// window reads one every 100 ms.
    /// Ticket 991: the sessions in the order they were started (the queue's registration time, then the id, which was
    /// the whole order before: random). A window that first sees several sessions together opens their tabs in this
    /// order; it used the pid, which is not the start order once the system's pids wrap around.
    pub(super) fn started_order(&self) -> impl Iterator<Item = &Entry> {
        let mut entries: Vec<&Entry> = self.entries.values().collect();
        entries.sort_by_key(|e| self.queue.registered(&e.meta.id));
        entries.into_iter()
    }
    pub(crate) fn snapshot(&self) -> Response {
        if self.left {
            return Err("core is stopping".into());
        }
        Ok(Reply::Snapshot {
            sessions: self
                .started_order()
                .map(|e| self.snapshot_session(&e.meta))
                .collect(),
            keep_awake_held: crate::keep_awake::held(), // V2-CF5
            board_decisions: crate::board::decisions(&self.home), // v1b-18
            owner_decisions: self.queue.owner_items(),  // v1a-23
            // v2-5b; ticket 1100: else the canary's card
            problem: crate::problems::set_aside(&self.home)
                .or_else(|| crate::agent_canary::problem(&self.home)),
        })
    }
    pub(super) fn snapshot_session(&self, meta: &Session) -> Session {
        #[cfg(test)]
        self.snapshots
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut meta = meta.clone();
        meta.send_log.extend(meta.send_queue.iter().cloned());
        meta.send_log.sort_by_key(|s| s.at);
        cap_log(&mut meta.send_log);
        meta.attention = Box::new(self.queue.attention(&meta.id));
        // Ticket 1121: shown only, so an older core never meets it in a store.
        meta.stopped_sends = (meta.send_queue.iter())
            .filter(|s| s.status == "queued" && self.spent.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();
        if self.recovery_warnings > 0 {
            let warning = format!(
                "hook journal: {} recovery events quarantined or unavailable",
                self.recovery_warnings
            );
            meta.attention.observer_error = Some(match meta.attention.observer_error.take() {
                Some(error) => format!("{warning}; {error}"),
                None => warning,
            });
        }
        // Look 1117 v9 (A S3-3): a shell has no turns; a command it runs in the foreground reads as working. Shown
        // only, not stored, so the queue's stale clock and turn alerts stay an agent's. A program on the alternate screen
        // (vim, less) stays working too (look 1117 v11 A-S3-7 left open): the window closes an idle shell without asking,
        // and an editor may hold unsaved work (Codex w25-b MUST).
        if meta.kind == AgentKind::Shell
            && meta.state == SessionState::Running
            && let Some(pty) = self.entries.get(&meta.id).and_then(|e| e.pty.as_ref())
            && crate::peer::foreground_job(pty.pid())
        {
            meta.attention.working = true;
        }
        // Look 1117 v12 B N11-S2-3: a turn blocked in `agent ask --wait` reads as waiting for its answer at once (tab,
        // tree row, status bar); shown only, so the turn's own clock, alerts and held messages still see it working.
        meta.attention.asking = meta.attention.working && self.asks_waiting(&meta.id);
        // v19-Q9-cx: shown only, like `asking`.
        meta.attention.input_blocked = meta.state == SessionState::Running
            && self
                .entries
                .get(&meta.id)
                .and_then(|e| e.pty.as_ref())
                .is_some_and(|p| p.input_blocked());
        meta.completion_seq = meta.attention.completion_seq;
        // Ticket 286: a shell left after its agent quit has no agent footer and answers nothing.
        let shell_left = self.entries.get(&meta.id).is_some_and(|e| e.agent_ended);
        meta.agent_ended = shell_left;
        let live = meta.state == SessionState::Running && !shell_left;
        // CHAT-PERMCHIP: read from the live screen, never stored. S9: read once per screen change, not per snapshot.
        meta.starting = live
            && self.entries.get(&meta.id).is_some_and(|e| {
                e.observer.before_box
                    && e.observer
                        .quiet_since
                        .is_none_or(|t| t.elapsed() < waiting::startup_quiet())
                    && e.observer
                        .silent_since
                        .is_none_or(|t| t.elapsed() < waiting::STARTUP_SILENT)
            });
        meta.permission_mode = self
            .entries
            .get(&meta.id)
            .filter(|_| live && meta.kind == AgentKind::Claude)
            .and_then(|e| {
                e.observer
                    .screen
                    .read_once(|screen| permission_mode(screen, meta.kind))
            })
            // Look 11-17 v3 P5: a resume, before this core read any footer of it, shows the mode it ran in. From the first
            // footer on, a screen without one (a dialog over it) gives none, as before.
            .or_else(|| {
                meta.ran_mode.clone().filter(|_| {
                    live && meta.kind == AgentKind::Claude
                        && self
                            .entries
                            .get(&meta.id)
                            .is_some_and(|e| !e.observer.footer_seen)
                })
            })
            // Ticket 991 (B6 chip): Codex cannot change its mode in a running session; its chip reads the mode this
            // start gave it (`agent_permission::codex_mode`, the names of Settings > Providers).
            .or_else(|| {
                meta.ran_mode
                    .clone()
                    .filter(|_| live && meta.kind == AgentKind::Codex)
            });
        meta.modes = self.shown_modes(&meta, live); // W35
        meta.mode_state = self
            .entries
            .get(&meta.id)
            .filter(|_| live && meta.kind == AgentKind::Claude)
            .map(|e| ModeState {
                skip: skip_state(e, meta.permission_mode.as_deref(), self.claude_asks()),
                walk: e
                    .walk
                    .as_ref()
                    .map(|w| ModeWalk {
                        target: w.target.clone(),
                        error: None,
                    })
                    .or_else(|| e.walk_error.clone()),
            }); // CHAT-MODELIST
        meta.limit = self.session_limit(&meta.id, live, queue::now_ms() as i64 / 1000); // ticket 372
        // Look 1117 v13 (Home S3-5): only an ended local row is looked at, so a live one costs no stat per snapshot.
        meta.folder_gone = !live
            && meta.state != SessionState::Closed
            && meta.machine.is_none()
            && fs::metadata(&meta.cwd).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        // Look 1117 v10 N10-S3-3: an ask the stop (or the agent's end) closed unanswered stays in the queue as resume
        // evidence; an ended row names it so the person learns it is gone. Only ended rows are read.
        meta.ended_ask = (!live && meta.state != SessionState::Closed)
            .then(|| {
                self.queue.items_of(&meta.id).into_iter().find(|i| {
                    matches!(
                        i.kind,
                        queue::Kind::Permission | queue::Kind::Question | queue::Kind::Dialog
                    )
                })
            })
            .flatten()
            .map(|ask| room::ask_words(&ask));
        // V2.5-87: an ended session answers nothing; its closed items stay on disk only as resume evidence (V1A-03).
        // S9: so only a live session's own items are read, not a clone of every item of every row.
        meta.pending = (if live {
            self.queue.items_of(&meta.id)
        } else {
            vec![]
        })
        .into_iter()
        .map(|mut i| {
            self.queue.annotate(&mut i, &meta.cwd, meta.home_lock); // V2-8e
            i
        })
        .collect();
        // Gap rule: why each queued row waits. Shown only, like `stopped_sends`.
        let blocked = crate::delivery::blocked(&meta.pending);
        meta.draft_home = self.drafts_home.get(&meta.id).cloned(); // home.rs
        meta.take_back = live && self.taken_back_row(&meta.id).is_some(); // home.rs
        // Type in terminal: the agent's box is on a current screen and nothing asks.
        meta.at_box = live
            && !blocked
            && self.entries.get(&meta.id).is_some_and(|e| {
                e.acp.is_none()
                    && matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
                    && !e.observer.behind
                    && composer(&e.observer.screen.text(), e.meta.kind).is_some()
            });
        meta.send_waits = (meta.send_queue.iter())
            .filter(|s| s.status == "queued")
            .filter_map(|s| {
                let why = self
                    .gap_hold(&meta.id, &s.id, &s.sender, s.submit, &s.content)
                    .or_else(|| blocked.then_some("dialog"))
                    .or_else(|| meta.attention.working.then_some("turn"))?;
                Some((s.id.clone(), why.to_string()))
            })
            .collect();
        // V2-5b: the cards of states v1a-33 and V2-1b keep.
        if meta.problem.is_none() {
            meta.problem = crate::problems::kept(&meta);
        }
        meta
    }
}
/// Look 11-17 v8 (area B S2-1): how long a question a hook or the transcript made is kept from the window while the
/// screen has not brought its choices yet (Claude and Codex draw their dialog a moment after the hook; the choices'
/// keys are read there). Past it the question is a card with Cancel only, as before.
const QUESTION_HOLD_MS: u64 = 1000;
/// A question with no choices yet that the screen is about to pair. Only the snapshot a window is pushed leaves it
/// out (http/mod.rs): the core's own gates and the owner socket's snapshot (`nunchiro agent wait` reads "blocked"
/// from it) still see the item, so nothing is typed into its dialog meanwhile and no caller reads the agent as idle.
pub(crate) fn question_held(item: &queue::Decision, now: u64) -> bool {
    item.kind == queue::Kind::Question
        && item.choices.is_empty()
        && !item.sources.contains("screen")
        && item.sources.iter().any(|s| s == "hook" || s == "transcript")
        // A Codex async question is answered by a message: no dialog brings it choices.
        && !queue::answered_by_message(item)
        && now.saturating_sub(item.observed_at) < QUESTION_HOLD_MS
}

/// A session's metadata and its observed transcript path, if any, for the sub-agent view to fold off the lock.
pub(crate) type KidsFold = (Session, Option<PathBuf>);
/// v2-9a: the projects some session record names, as the tree keeps them.
impl Sessions {
    /// V2.5-11: the projects of the sessions this core knows, as `project_set`.
    pub(crate) fn known_projects(&self) -> std::collections::BTreeSet<String> {
        project_set(&self.entries)
    }
    /// F15: the session projects and the ones added from the tree (`Open in editor`, `Set icon`).
    pub(super) fn project_roots(&self) -> std::collections::BTreeSet<String> {
        let known = project_set(&self.entries);
        match &self.tree {
            Ok(tree) => tree.known(&known),
            Err(_) => known,
        }
    }
    /// Ticket 375: what Open in editor may open: the project roots, each local session's folder and each project's
    /// managed worktree folder (`<root>/<project folder name>`, never the whole root, which may be a shared folder).
    /// Editor only: project icons and schedules keep `project_roots`.
    pub(super) fn editor_roots(&self) -> std::collections::BTreeSet<String> {
        let mut roots = self.project_roots();
        let worktrees: Vec<String> = roots
            .iter()
            .flat_map(|p| {
                let p = Path::new(p);
                // Ticket 1061: worktrees made before the default moved still lie under the old root.
                let roots = [
                    self.settings.worktree_root_for(p).ok(),
                    worktree_root_for(
                        Some(Path::new(PREVIOUS_DEFAULT_DIR)),
                        p,
                        &self.settings.user_home,
                    )
                    .ok(),
                    Some(self.settings.legacy_worktree_root(&self.home)),
                ];
                roots
                    .into_iter()
                    .flatten()
                    .filter_map(|root| Some(root.join(p.file_name()?)))
                    .collect::<Vec<_>>()
            })
            // Codex look 11-20: a link there would make its target a root; only a real folder counts.
            .filter(|r| std::fs::symlink_metadata(r).is_ok_and(|m| m.is_dir()))
            .filter_map(|r| r.to_str().map(String::from))
            .collect();
        roots.extend(worktrees);
        roots.extend(
            self.entries
                .values()
                .filter(|e| e.meta.machine.is_none())
                .filter_map(|e| e.meta.cwd.to_str().map(String::from)),
        );
        roots
    }
}
/// Home view change 1: one project's registry facts for the digest (`Sessions::digest_facts`).
#[derive(Default)]
pub(crate) struct DigestFacts {
    pub working: usize,
    /// (decision id, observed at ms, session id).
    pub pending: Vec<(String, u64, String)>,
    pub last: (u64, String),
    /// Teammate ids with a failed seat session, and with a running one (which wins).
    pub seats_failed: std::collections::BTreeSet<String>,
    pub seats_live: std::collections::BTreeSet<String>,
}
pub(super) fn project_set(entries: &BTreeMap<String, Entry>) -> std::collections::BTreeSet<String> {
    entries
        .values()
        .filter_map(|e| e.meta.project.to_str().map(String::from))
        .collect()
}
