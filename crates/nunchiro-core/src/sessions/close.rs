//! Ending sessions: close's checks, leave, stop, and dropping old Closed rows and their files.
use super::*;
impl Sessions {
    /// Ticket 1113: a current local lead reaches only its own place, including Home. Nothing a lead
    /// says about a target counts as no-work evidence; only this registry's untouched startup state does.
    pub(super) fn tidy_session(
        &mut self,
        caller: &crate::grants::Caller,
        id: &str,
        why: &str,
        now: u64,
    ) -> Response {
        let reach = self
            .schedule_reach(caller)?
            .unwrap_or_else(|| crate::team::Team::open(&self.home).home());
        let target = self.entries.get(id).ok_or("session not found")?;
        if target.meta.machine.is_some() || self.room_project(id).as_ref() != Some(&reach) {
            return Err("a lead tidies only local sessions in its place".into());
        }
        let why = queue::deny_note(why);
        if why.trim().is_empty() {
            return Err("say why this session should close (--why)".into());
        }
        let (label, place) = (target.meta.label.clone(), target.meta.project.clone());
        let who = self.task_caller(Some(caller), None)?;
        let lead = who.lead.ok_or("no lead for this session")?;
        let room = who.place.ok_or("no place for this session")?;
        let from = who.name;
        if self.empty_session(id, now) {
            self.close(id, false, false)?;
            let body = format!(
                "Closed empty session {label} ({id}) · {}: {why}",
                place.display()
            );
            self.team_note(
                &room,
                &lead,
                Some(&caller.id),
                body.clone(),
                crate::room::TeamNote {
                    what: "session_empty_closed".into(),
                    worktree: None,
                    // The room renders this field; keep the reason visible as well as in its stored body.
                    name: Some(format!("{label}: {why}")),
                    branch: None,
                    merged: None,
                    seat: None,
                },
            );
            return Ok(Reply::Text { text: body });
        }
        let card = self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::SessionClose {
                from,
                target: id.into(),
                label: label.clone(),
                place,
                why,
            },
        )?;
        Ok(Reply::Text {
            text: format!(
                "Asked the owner to close {label} ({id}), card {card}. It stays open until their Close."
            ),
        })
    }
    /// Positive evidence only: a first-run theme picker in a fresh Claude start with no input or conversation.
    /// The lead approved ten minutes idle instead of adding a focused-pane feed (plan checkpoint m1576).
    /// After a restart `before_box` is false, so missing in-memory evidence always takes the card path.
    pub(super) fn empty_session(&self, id: &str, now: u64) -> bool {
        let Some(e) = self.entries.get(id) else {
            return false;
        };
        let a = self.queue.attention(id);
        let registered = self.queue.registered(id);
        let screen = e.observer.screen.text();
        e.meta.kind == AgentKind::Claude
            && e.meta.machine.is_none()
            && e.agent_live()
            && e.pty.is_some()
            && e.stale.is_none()
            && e.observer.before_box
            && !e.observer.behind
            && e.observer.unredrawn.is_none()
            && screen.contains("Choose the text style")
            && screen.contains("/theme")
            && screen.contains("Dark mode")
            && screen.contains("Light mode")
            && e.meta.agent_session_id.is_none()
            && e.observer.transcript.is_none()
            && a.completion_seq == 0
            && !a.working
            && a.background == 0
            && a.observer_error.is_none()
            && registered > 0
            && now.saturating_sub(registered.max(a.last_activity)) >= 10 * 60_000
            && !self.touched.contains_key(id)
            && !self.composed.contains_key(id)
            && !self.submitted.contains_key(id)
            && !self.pending_enter.contains_key(id)
            && !self.delivery_inflight.contains_key(id)
            && e.meta.send_log.is_empty()
            && e.meta.send_queue.is_empty()
    }
    /// Ends session `id`. V2-1b: the queue is closed only once the agent is stopped (a refused close leaves its
    /// waiting items as they are). For the owner, an agent whose holder no longer answers is ended by the core
    /// itself, only as the recorded process (an agent could stop its own holder to keep a close failing).
    /// `window`: the window's own Close (http), which keeps a running session's row and so its done tab; any other
    /// close marks the row `closed_by_command` (ticket 1013 F6).
    pub(crate) fn close(&mut self, id: &str, owner: bool, window: bool) -> Response {
        self.held_enter.remove(id);
        self.forget_home(id); // words left in its box that never came home
        self.composed.remove(id); // ticket 990: typed and never entered; nothing keeps it after the close
        self.touched.remove(id);
        self.acp_loading.remove(id); // a resume closed before its load ended: the rows it continued stay
        let project = self.entry(id)?.meta.project.clone();
        // An account's Login or Logout tab runs in the account's config folder, which is no project (nightly 11-19:
        // closing the login filed that folder in the tree, accounts-login-filing).
        let account_tab = self.entry(id)?.meta.account_tab;
        // V2-6d: a stopped or done session goes in two phases (its turn is over, so nothing is lost by waiting).
        let reply = if !self.entry(id)?.meta.side_chat
            && self.entry(id)?.meta.state != SessionState::Running
        {
            self.close_later(id, owner)
        } else {
            let before = std::mem::replace(&mut self.entry(id)?.meta.closed_by_command, !window);
            let reply = self.close_now(id, owner);
            if reply.is_err() {
                self.entry(id)?.meta.closed_by_command = before;
            }
            reply
        };
        if reply.is_ok() && !account_tab {
            self.keep_project_head(&project);
        }
        reply
    }
    /// Look 1117 v10 N5: a project stays in the tree until it is removed. The tree drops the head of an unfiled project
    /// whose rows are all closed (web `withoutClosedHeads`, for Remove from tree), so closing its last live session files
    /// it as added. Remove from tree closes every session first and un-adds it last. The Home folder is no project row.
    /// Q9 en-b-J6-1: a pinned, grouped or named project is filed as added too, else the row's removal (close_later,
    /// finish_close) leaves it unknown and the next edit's or start's prune drops its pin, group and name.
    fn keep_project_head(&mut self, project: &Path) {
        let Some(name) = project.to_str() else {
            return;
        };
        let Ok(tree) = &self.tree else {
            return;
        };
        let added = tree.added.iter().any(|p| p == name);
        let live = self
            .entries
            .values()
            .any(|e| e.meta.project == project && e.meta.state != SessionState::Closed);
        if added || live || crate::team::Team::open(&self.home).home() == project {
            return;
        }
        let add = crate::tree::TreeEdit::Add {
            project: name.into(),
            added: true,
        };
        // No folder check here (Q9 en-b-J6-2: under the registry lock; the path came from a session). A full tree is
        // refused: the head then goes as before.
        if let Ok(next) = tree.edited(&add, None)
            && next.save(&self.home).is_ok()
        {
            self.tree = Ok(next);
        }
    }
    /// F24: what `leave` would lose, so an automatic swap waits for it: a running ACP chat (a child of this core), a
    /// queued send (`leave` cancels it), a holder below the next core's protocol floor, a sign-in, a sandbox run.
    pub(super) fn exit_blockers(&self, holder_floor: u16) -> usize {
        let sessions = self
            .entries
            .values()
            .filter(|e| {
                e.acp.is_some()
                    || !e.meta.send_queue.is_empty()
                    || e.holder().is_some_and(|(h, _)| h.protocol < holder_floor)
            })
            .count();
        sessions
            + usize::from(self.launching.is_some()) // F24 r3: an agent mid-launch has no holder record to reattach yet
            + crate::account_signin::running()
            + crate::projects::clone::running()
            + crate::sandbox::running(&self.home)
    }
    /// V2-1b (`exit`): lets go of every session without ending it. The store keeps each live session's holder and
    /// token hash for the next core, which reattaches; queued sends and widget runs end with this core.
    pub fn leave(&mut self) -> Result<(), String> {
        crate::account_signin::stop_all(); // round 2: no headless login outlives the core
        crate::projects::clone::stop_all(); // ticket 370: ends its group, removes its folder
        for entry in self.entries.values_mut() {
            cancel_queue(&mut entry.meta);
            cap_log(&mut entry.meta.send_log);
        }
        // The saved activity times lag up to `ACTIVITY_CHECKPOINT_MS`; the next core reads them for idle rules and seat order.
        // Serve update, restart and rollback reach this through `ExitIfIdle` (tests/activity_exit.rs).
        if let Err(e) = self.queue.flush_activity() {
            eprintln!("queue activity at exit: {e}");
        }
        self.save()?;
        self.left = true;
        for entry in self.entries.values_mut() {
            if let Some(pty) = entry.pty.take() {
                pty.leave();
            }
            // V2-4a: no holder keeps an ACP agent; the next core restores its row stopped.
            if let Some(mut acp) = entry.acp.take() {
                acp.stop();
            }
        }
        crate::sandbox::stop_all(&self.home); // v1b-21 r2: no run outlives the core
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        crate::account_signin::stop_all(); // round 2: no headless login outlives the core
        crate::projects::clone::stop_all(); // ticket 370: ends its group, removes its folder
        self.finish_close(u64::MAX); // V2-6d: a full quit ends the window; nothing waits for a next start
        self.note_asks_ending_at_stop(); // look 11-17 v5 item 3: before the stop closes the items
        if let Err(e) = self.queue.flush_activity() {
            eprintln!("queue activity at stop: {e}"); // as at `leave`
        }
        // v1b-15. S9: the last read before the stop always runs, never held back by the idle board clock.
        self.board_observed = None;
        self.observe_board();
        let mut errors = vec![];
        let mut scrollback = vec![]; // v1a-40
        let mut known = std::collections::BTreeSet::new(); // V2-1b: holders stopped through the registry
        for entry in self.entries.values_mut() {
            if let Some(pty) = entry.pty.as_mut() {
                known.insert(pty.holder().socket.clone());
                match pty.stop() {
                    Ok(()) => {
                        scrollback.push((entry.meta.id.clone(), pty.snapshot()));
                        entry.pty = None;
                        entry.meta.pid = None;
                        if let Err(error) = self.queue.close(&entry.meta.id, false) {
                            eprintln!("queue stop persistence: {error}");
                        }
                        entry.meta.ended_at.get_or_insert(queue::now_ms());
                        entry.meta.state = if entry.meta.kind != AgentKind::Shell
                            && entry.meta.agent_session_id.is_some()
                        {
                            SessionState::Resumable
                        } else {
                            SessionState::Exited
                        };
                        // v1a-14: cancel queued sends under the one save below; left to the next tick, each
                        // would save on its own (seconds for a long queue) and outlast `serve restart`'s wait.
                        cancel_queue(&mut entry.meta);
                        cap_log(&mut entry.meta.send_log);
                        if let Err(e) = remove_hooks(&self.home, &entry.meta.id) {
                            errors.push(e);
                        }
                    }
                    Err(e) => errors.push(e),
                }
            }
        }
        // V2-4a: ACP agents end with the core; a restart restores them stopped (resumable when declared).
        for entry in self.entries.values_mut() {
            if let Some(mut acp) = entry.acp.take() {
                acp.stop();
                entry.meta.pid = None;
                entry.meta.state = resumable(&entry.meta);
                cancel_queue(&mut entry.meta);
                if let Err(error) = self.queue.close(&entry.meta.id, false) {
                    eprintln!("queue stop persistence: {error}");
                }
            }
        }
        // V2-1b: unattached holders too, and then every holder still listening in this data folder (socket scan),
        // so a full quit leaves none, whatever the registry knows.
        for entry in self.entries.values_mut() {
            let Some(stale) = entry.stale.take() else {
                continue;
            };
            known.insert(stale.record.socket.clone());
            if !stop_stale(&stale, true) {
                errors.push("session holder did not stop; the agent still runs".into());
                entry.stale = Some(stale);
                continue;
            }
            entry.meta.pid = None;
            entry.meta.holder_status = None;
            entry.meta.state = resumable(&entry.meta);
            if let Err(error) = self.queue.close(&entry.meta.id, false) {
                eprintln!("queue stop persistence: {error}");
            }
        }
        for socket in crate::holder::sockets(&self.home) {
            if known.contains(&socket) {
                continue;
            }
            if let Err(e) = crate::holder::stop_at(&socket, None) {
                eprintln!("stopping holder {}: {e}", socket.display());
            }
        }
        crate::sandbox::stop_all(&self.home); // v1b-21 r2: no run outlives the core
        // v1a-40: written before the Stop reply so the next core's resume finds them; the server drains them after
        // releasing the registry lock (`drain_scrollback`).
        for (id, bytes) in scrollback {
            self.queue_save(id, bytes);
        }
        // v1b-21: cancel_queue bypasses finish_send; keep only the hashes of sends still queued.
        let queued: std::collections::BTreeSet<String> = self
            .entries
            .values()
            .flat_map(|e| e.meta.send_queue.iter().map(|s| s.id.clone()))
            .collect();
        self.widget_hashes.retain(|id, _| queued.contains(id));
        self.save()?;
        if errors.is_empty() {
            self.halted = true; // only a stop that went through: after a failed one the core keeps serving
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    /// Ticket 991 A2: a removed worktree's ended sessions close with it (their rows and tabs would offer a Restart
    /// in a folder that is gone). No Undo window: the folder they would come back to is gone.
    /// After one Codex look: `caller` (a session that asked for the remove) closes only what it may close anyway,
    /// itself and the sessions it started; another session's ended row stays for the owner. The owner closes all.
    pub(crate) fn close_ended_in(&mut self, path: &Path, caller: Option<&crate::grants::Caller>) {
        let ended: Vec<String> = self
            .entries
            .values()
            .filter(|e| {
                caller.is_none_or(|c| e.meta.id == c.id || self.started_by(&e.meta, &c.id))
                    && e.meta.cwd.starts_with(path)
                    && matches!(
                        e.meta.state,
                        SessionState::Exited
                            | SessionState::Failed
                            | SessionState::Resumable
                            | SessionState::Closed
                    )
            })
            .map(|e| e.meta.id.clone())
            .collect();
        if ended.is_empty() {
            return;
        }
        for id in ended {
            // A row the remove dialog's own "Stop N sessions and remove" closed a moment ago is Closed already (seen
            // in the real app: such rows and tabs stayed and offered a Restart): it goes as an ended one does. A
            // token-started row stays Closed, as in `close_and_drop` (ticket 621).
            if self.entries[&id].meta.state == SessionState::Closed {
                if self.token_origin(&self.entries[&id].meta).is_none() {
                    self.entries.remove(&id);
                    self.closed_views.retain(|other| other != &id);
                    if let Err(e) = self.queue.retain_sessions(|other| other != id) {
                        eprintln!("close {id}: queue state not dropped: {e}");
                    }
                }
                continue;
            }
            self.close_and_drop(&id, true);
        }
        if let Err(e) = self.save() {
            eprintln!("close after worktree remove: record not saved: {e}");
        }
    }
}

pub(super) fn stop_stale(stale: &Stale, owner: bool) -> bool {
    let holder = Some((stale.record.pid, stale.record.started));
    if let Err(e) = crate::holder::stop_at(&stale.record.socket, holder) {
        eprintln!("holder {}: {e}", stale.record.socket.display());
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while crate::peer::running_since(stale.pid, stale.started) && std::time::Instant::now() < until
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    !crate::peer::running_since(stale.pid, stale.started)
        || (owner && end_group(stale.pid, stale.started, &stale.record))
}
/// V2-1b: the owner ends an agent whose holder does not answer: its group, then the holder, each only when the
/// process table shows exactly the recorded process. `true` once the agent is gone.
pub(super) fn end_group(pid: u32, started: Option<u64>, holder: &crate::holder::Record) -> bool {
    let Some(started) = started else {
        return false;
    };
    if crate::peer::is_same(pid, started) {
        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
    }
    if crate::peer::is_same(holder.pid, holder.started) && holder.pid != std::process::id() {
        unsafe { libc::kill(holder.pid as i32, libc::SIGKILL) };
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while crate::peer::running_since(pid, Some(started)) && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    !crate::peer::running_since(pid, Some(started))
}
/// A stop error counts only while the agent still lives: Darwin's killpg can say EPERM after the
/// leader was killed and reaped (a group left with a zombie), and then the restart must still happen.
pub(super) fn agent_stopped(
    result: Result<(), String>,
    pid: u32,
    started: Option<u64>,
) -> Result<(), String> {
    let Err(error) = result else { return Ok(()) };
    // A zombie or a reaped leader counts as dead. V2-1a r2: read from the process table, since the agent is its
    // holder's child, not the core's. V2-1b: another start time on the pid is another process, so the agent is gone.
    let gone = !crate::peer::running_since(pid, started);
    if gone {
        eprintln!("switch: stopping {pid} reported {error}; the agent is gone, restarting");
        Ok(())
    } else {
        Err(format!("Codex did not stop ({error}); nothing changed"))
    }
}
/// Ticket 621: how many Closed rows stay in `entries`, sessions.json and the snapshot, newest first.
pub(super) const CLOSED_KEEP: usize = 50;
/// Ticket 621: the Closed rows older than the newest CLOSED_KEEP that nothing still shows. Kept: a shell whose
/// read-only view is held (`closed_views`), every ancestor (parent or side parent, 16 deep) of a live row, a row that
/// shares a conversation with a live row (the chat chain), and the newest row of each project tree.toml files (a pin,
/// a group or a name; else `Tree::prune` drops that filing at the next `open`). `filed` None (tree.toml unreadable)
/// files every project. Rows in `tokens` (token rows while their records would not fit, ticket 752) are neither dropped
/// nor counted. Their files went at Close.
fn droppable(
    entries: &BTreeMap<String, Entry>,
    views: &std::collections::VecDeque<String>,
    filed: Option<&std::collections::BTreeSet<String>>,
    tokens: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    let closed = |e: &&Entry| e.meta.state == SessionState::Closed && !tokens.contains(&e.meta.id);
    if entries.values().filter(closed).count() <= CLOSED_KEEP {
        return vec![];
    }
    let mut needed: std::collections::BTreeSet<&str> = views.iter().map(String::as_str).collect();
    let mut conversations = std::collections::BTreeSet::new();
    for meta in entries
        .values()
        .map(|e| &e.meta)
        .filter(|m| m.state != SessionState::Closed)
    {
        let mut up: Vec<&str> = [&meta.parent, &meta.side_parent]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for _ in 0..16 {
            let next: Vec<&str> = up
                .iter()
                .filter(|id| needed.insert(id))
                .filter_map(|id| entries.get(*id))
                .flat_map(|e| {
                    [&e.meta.parent, &e.meta.side_parent]
                        .into_iter()
                        .flatten()
                        .map(String::as_str)
                })
                .collect();
            up = next;
        }
        conversations.extend(meta.conversation.as_deref());
    }
    // Oldest first; a row closed before ticket 621 (no time) is older than any timed one.
    let mut old: Vec<&Session> = entries.values().filter(closed).map(|e| &e.meta).collect();
    old.sort_by_key(|m| (m.closed_at, &m.id));
    let mut newest_of_project = BTreeMap::new();
    for meta in &old {
        let project = meta.project.to_string_lossy();
        if filed.is_none_or(|f| f.contains(project.as_ref())) {
            newest_of_project.insert(project, meta.id.as_str());
        }
    }
    needed.extend(newest_of_project.into_values());
    let over = old.len() - CLOSED_KEEP;
    old[..over]
        .iter()
        .filter(|m| {
            !needed.contains(m.id.as_str())
                && m.conversation
                    .as_ref()
                    .is_none_or(|c| !conversations.contains(c.as_str()))
        })
        .map(|m| m.id.clone())
        .collect()
}
/// Ticket 621: the projects tree.toml files by a pin, a group or a name.
fn filed_projects(tree: &crate::tree::Tree) -> std::collections::BTreeSet<String> {
    let groups = tree.groups.iter().flat_map(|g| g.projects.iter());
    groups
        .chain(&tree.pins)
        .chain(tree.names.keys())
        .cloned()
        .collect()
}
impl Sessions {
    /// Ticket 621: drops the `droppable` rows, and their queue state (ticket 750). Ticket 752: a token row counts and
    /// drops like any other, and leaves its conversation and origin in `token_conversations` (saved with the rows in
    /// one write), so a resume of the conversation keeps the token's limits. When every token row's record would not
    /// fit under TOKEN_CONVERSATIONS, no token row is dropped and none counts against CLOSED_KEEP (ticket 621 round 3),
    /// so an origin is never lost.
    pub(super) fn drop_closed(&mut self) {
        let filed = self.tree.as_ref().ok().map(filed_projects);
        let origins: BTreeMap<String, String> = self
            .entries
            .values()
            .filter_map(|e| Some((e.meta.id.clone(), self.token_origin(&e.meta)?)))
            .collect();
        let room = self.token_conversations.len() + origins.len() <= store::TOKEN_CONVERSATIONS;
        let mut kept: std::collections::BTreeSet<String> = match room {
            true => Default::default(),
            false => origins.keys().cloned().collect(),
        };
        // Ticket 1130 B-L3 round 5: nor a row a resume still loads from or an Undo is about to continue (neither
        // dropped nor counted, as the token rows above): a load that fails must find it in History.
        kept.extend(self.acp_loading.values().flatten().cloned());
        kept.extend(self.held_rows.iter().cloned());
        let gone: std::collections::BTreeSet<String> =
            droppable(&self.entries, &self.closed_views, filed.as_ref(), &kept)
                .into_iter()
                .collect();
        if gone.is_empty() {
            return;
        }
        // A row from before round 6 finds its origin only through its parent chain, which a drop can cut: stored now.
        for (id, origin) in &origins {
            let meta = &mut self.entries.get_mut(id).unwrap().meta;
            meta.token_origin.get_or_insert_with(|| origin.clone());
        }
        for id in &gone {
            let meta = &self.entries[id].meta;
            if let (Some(origin), Some(conversation)) = (origins.get(id), &meta.agent_session_id) {
                let record = store::TokenConversation {
                    kind: meta.kind,
                    conversation: conversation.clone(),
                    origin: origin.clone(),
                };
                if !self.token_conversations.contains(&record) {
                    self.token_conversations.push(record);
                }
            }
        }
        self.entries.retain(|id, _| !gone.contains(id));
        // A failed queue save is retried at the next `open`, which drops every state no row owns.
        if let Err(e) = self.queue.retain_sessions(|id| !gone.contains(id)) {
            eprintln!("queue state of dropped sessions not dropped: {e}");
        }
    }
}
/// The session's own files in the core home: its hooks settings and its agent-ended marker (ticket 286).
/// Q9 psn-J4-2: a queue save that fails in `refresh` is logged, as Close's: the pass still saves the scrollback, the
/// rows and the ended card.
/// Ticket 1090: a seat that ends or closes also takes away the owner cards that are its alone: a stall card raised on
/// its check-in and a Codex reset it asked for. Its questions and permissions already leave Decisions (a session that
/// is not live sends no `pending`). Task cards (merge) and cards about other things stay. Not called for the core's own
/// stop or start, where a seat is resumed and its cards still hold.
pub(super) fn close_queue(queue: &mut Queue, id: &str, failed: bool) {
    let seat_only = |i: &queue::Decision| {
        i.session_id == id
            && matches!(
                i.owner,
                Some(queue::OwnerAsk::Stall { .. } | queue::OwnerAsk::CodexReset { .. })
            )
    };
    if let Err(error) = queue
        .close(id, failed)
        .and_then(|()| queue.answer_owner(seat_only))
    {
        eprintln!("queue close persistence: {error}");
    }
}
pub(super) fn remove_hooks(home: &Path, id: &str) -> Result<(), String> {
    for path in [
        home.join(format!("hooks-{id}.json")),
        ended_marker(home, id),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
