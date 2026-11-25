//! The per-tick refresh: which sessions still run, and an ended agent's marker and card.
use super::*;
impl Sessions {
    pub(super) fn refresh(&mut self) -> Result<(), String> {
        self.refresh_unsaved()?;
        self.save_unsaved()
    }
    /// Ticket 999: a save only when a pass left rows unsaved (`refresh_unsaved`, `deliver`) and none ran since.
    pub(super) fn save_unsaved(&mut self) -> Result<(), String> {
        if self.unsaved.load(std::sync::atomic::Ordering::SeqCst) {
            return self.save();
        }
        Ok(())
    }
    /// `refresh` without its save: a change is marked `unsaved`, for a tick that saves once after its whole pass.
    pub(super) fn refresh_unsaved(&mut self) -> Result<(), String> {
        // v1b-15
        self.observe_board();
        let mut changed = false;
        let mut saves = vec![];
        let mut finished_workers = vec![];
        let mut acp_settled = vec![]; // ticket 1130 round 3: resumed ACP sessions whose load ended, and how
        for entry in self.entries.values_mut() {
            // V1A-89: a probe that outlived Start's wait; a failed or hung one reads as a failed `--version` does.
            let answer = entry
                .version_probe
                .as_ref()
                .and_then(|probe| match probe.try_recv() {
                    Ok(answer) => Some(answer),
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        Some(Err("version probe ended without an answer".into()))
                    }
                });
            if let Some(answer) = answer {
                entry.version_probe = None;
                let version = answer.unwrap_or_else(|e| {
                    eprintln!("session {}: {e}", entry.meta.id);
                    "unknown".into()
                });
                entry.meta.untested = !crate::chat::tested(
                    entry.meta.kind,
                    Some(&version),
                    crate::chat::TESTED_VERSIONS,
                );
                crate::agent_canary::version_seen(&self.home, entry.meta.kind, &version); // ticket 1100
                entry.meta.agent_version = Some(version);
                changed = true;
            }
            if entry.meta.state != SessionState::Running {
                continue;
            }
            // v1a-33: EPERM/EACCES or no answer within the bound is macOS file access; any other answer is not ours.
            let denied = entry
                .probe
                .as_ref()
                .and_then(|(since, answer)| match answer.try_recv() {
                    Ok(Err(e)) => Some(e.kind() == std::io::ErrorKind::PermissionDenied),
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        (since.elapsed() >= PROBE_BOUND).then_some(true)
                    }
                    Ok(Ok(())) | Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(false),
                });
            if let Some(denied) = denied {
                entry.probe = None;
                if denied {
                    entry.meta.blocked = Some(crate::api::Blocked {
                        reason: crate::api::BlockedReason::FileAccess,
                        path: entry.meta.cwd.clone(),
                    });
                    changed = true;
                }
            }
            // V2-1b: an unattached holder: the session runs while its agent does; a silent one is tried again.
            if entry.pty.is_none()
                && let Some(stale) = entry.stale.as_mut()
            {
                if crate::peer::running_since(stale.pid, stale.started) {
                    if entry.meta.holder_status.is_none()
                        && std::time::Instant::now() >= stale.retry
                    {
                        stale.retry = std::time::Instant::now() + STALE_RETRY;
                        let (record, pid, started, run_start) = (
                            stale.record.clone(),
                            stale.pid,
                            stale.started,
                            stale.run_start,
                        );
                        // Under the registry lock: a short bound, so a silent holder costs little per retry.
                        changed |= reattach(
                            entry,
                            &record,
                            pid,
                            started,
                            run_start,
                            std::time::Duration::from_millis(200),
                            false,
                        );
                    }
                    continue;
                }
                entry.stale = None;
                entry.meta.state = resumable(&entry.meta);
                entry.meta.pid = None;
                entry.meta.holder_status = None;
                close_queue(&mut self.queue, &entry.meta.id, false);
                changed = true;
                continue;
            }
            // V2-4a: an ACP agent's messages since the last pass; it ends exited (resumable when it declared
            // `loadSession`) or failed.
            if let Some(acp) = entry.acp.as_mut() {
                let before = (
                    entry.meta.agent_session_id.clone(),
                    entry.meta.model.clone(),
                    entry.meta.effort.clone(),
                );
                let state = match acp.pump(&mut entry.meta, &mut self.queue)? {
                    Ok(true) => {
                        if acp.handshaken() && self.acp_loading.contains_key(&entry.meta.id) {
                            acp_settled.push((entry.meta.id.clone(), true));
                        }
                        changed |= before
                            != (
                                entry.meta.agent_session_id.clone(),
                                entry.meta.model.clone(),
                                entry.meta.effort.clone(),
                            );
                        continue;
                    }
                    Ok(false) => resumable(&entry.meta),
                    Err(reason) => {
                        eprintln!("session {}: {reason}", entry.meta.id);
                        // V2-4b: its card, from the handshake's own reason; a running session never gets one.
                        // Only before the handshake finished: a running session's later failure is no "no answer".
                        entry.meta.problem = entry
                            .meta
                            .acp_agent
                            .as_deref()
                            .filter(|_| !acp.handshaken())
                            .and_then(|name| {
                                crate::problems::acp_failed(&crate::acp::label_of(name), &reason)
                            });
                        SessionState::Failed
                    }
                };
                acp_settled.push((entry.meta.id.clone(), false));
                acp.stop();
                entry.acp = None;
                entry.meta.state = state;
                entry.meta.ended_at.get_or_insert(queue::now_ms());
                entry.meta.pid = None;
                close_queue(
                    &mut self.queue,
                    &entry.meta.id,
                    state == SessionState::Failed,
                );
                changed = true;
                continue;
            }
            let state = match entry.pty.as_mut().map(|p| (p.alive(), p.lost())) {
                Some((Ok(true), _)) => {
                    // Ticket 286: the agent quit and left its shell: what an exit did (below), without the exit.
                    if card_judged(entry, false) {
                        // Ticket 286 r5: a worker (a session another session started) leaves no shell; a session
                        // the user started keeps it. r6: a worker that failed keeps its shell and the why-it-ended
                        // card just raised (Close would clear it).
                        if entry.meta.parent.is_some() && entry.meta.problem.is_none() {
                            finished_workers.push(entry.meta.id.clone());
                        }
                        changed = true;
                        continue;
                    }
                    if !entry.agent_ended
                        && entry.meta.kind != AgentKind::Shell
                        && let Some(code) = read_marker(&ended_marker(&self.home, &entry.meta.id))
                        // Whole lines only: the wrapper's `echo` truncates before it writes.
                        && code.ends_with('\n')
                    {
                        entry.agent_ended = true;
                        // An answered marker ("seen") is an end an earlier core saw: its time is not now.
                        if !code.starts_with("seen ") {
                            entry.meta.ended_at.get_or_insert(queue::now_ms());
                        }
                        let marker = ended_marker(&self.home, &entry.meta.id);
                        let code = code.trim().trim_start_matches("seen ").to_string();
                        // The wrapper's go-ahead: from here every agent path refuses this session (`agent_live`).
                        if let Err(e) = answer_marker(&marker, &code) {
                            eprintln!("session {}: agent end not answered: {e}", entry.meta.id);
                        }
                        // Queued sends and a pending Enter are canceled by the next delivery pass.
                        close_queue(&mut self.queue, &entry.meta.id, false);
                        // A core restarted since keeps the card the first read raised (the screen is the shell's now).
                        // Ticket 488: else the card waits for the agent's last output (`card_judged`), never here.
                        if entry.meta.problem.is_none() && entry.pty.is_some() {
                            entry.card_due = Some((
                                std::time::Instant::now() + ENDED_MARK_WAIT,
                                code.parse().ok(),
                            ));
                        } else if entry.meta.parent.is_some() && entry.meta.problem.is_none() {
                            finished_workers.push(entry.meta.id.clone()); // as `card_judged` below, with no card to wait for
                        }
                        changed = true;
                    }
                    continue;
                }
                // V2-1b: a holder that died took its agent: resumable from the transcript, never running.
                Some((Ok(false), true)) => resumable(&entry.meta),
                Some((Ok(false), false)) => SessionState::Exited,
                status => {
                    eprintln!("session {} wait failed: {:?}", entry.meta.id, status);
                    SessionState::Failed
                }
            };
            // Ticket 488: the shell quit before the agent's card was judged: judged now, as the agent's. Ticket 512: a
            // worker it leaves without a card is finished, as when the card is judged while its shell runs (above).
            if card_judged(entry, true)
                && entry.meta.parent.is_some()
                && entry.meta.problem.is_none()
            {
                finished_workers.push(entry.meta.id.clone());
                changed = true;
                continue;
            }
            // v1a-40: the replay is saved after the registry lock is released (`drain_scrollback`).
            if let Some(pty) = &entry.pty {
                let bytes = pty.snapshot();
                // V2-5b: why it ended, read only now that it has (a running session never gets a card from its screen).
                // Ticket 286: after the agent's shell quits, the card is the agent's, raised when it ended.
                if !entry.agent_ended {
                    entry.meta.problem = crate::problems::ended(
                        entry.meta.kind,
                        &bytes,
                        pty.exit_code(),
                        state == SessionState::Failed || pty.lost(),
                    );
                }
                saves.push((entry.meta.id.clone(), bytes));
            }
            entry.meta.state = state;
            entry.meta.ended_at.get_or_insert(queue::now_ms());
            entry.meta.pid = None;
            close_queue(
                &mut self.queue,
                &entry.meta.id,
                state == SessionState::Failed,
            );
            changed = true;
        }
        for (id, bytes) in saves {
            self.queue_save(id, bytes);
        }
        // Ticket 1130 round 3: the rows a resumed ACP session continues leave only now, once its load succeeded (as
        // `spawn_acp` dropped them at once before); a session that ended before that leaves them where they are.
        for (id, loaded) in acp_settled {
            if let Some(prior) = self.acp_loading.remove(&id)
                && loaded
            {
                for old in prior {
                    self.entries.remove(&old);
                }
                changed = true;
            }
        }
        for id in finished_workers {
            if let Err(e) = self.close_unsaved(&id, true) {
                eprintln!("session {id}: finished worker not closed: {e}");
            }
        }
        let ended: Vec<_> = self
            .entries
            .values()
            .filter(|e| {
                e.meta.side_chat
                    && e.meta.state != SessionState::Closed
                    && e.meta.side_parent.as_ref().is_some_and(|parent| {
                        !self.entries.get(parent).is_some_and(Entry::agent_live) // ticket 286: a side chat ends with its parent's agent
                    })
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for id in ended {
            // Q9 psn-J4-1: a close that fails is logged, as a finished worker's: it never fails every request.
            if let Err(e) = self.close_unsaved(&id, true) {
                eprintln!("session {id}: side chat not closed: {e}");
            }
            changed = true;
        }
        if changed {
            self.unsaved
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }
}
/// V2-1b: the state a session takes when its run ended without an exit of its own (a stop, a holder that died).
pub(super) fn resumable(meta: &Session) -> SessionState {
    if !meta.side_chat && meta.kind != AgentKind::Shell && meta.agent_session_id.is_some() {
        SessionState::Resumable
    } else {
        SessionState::Exited
    }
}
/// Ticket 488: what `AGENT_WRAPPER` prints into the terminal after the agent exits and before it writes the marker, an
/// OSC terminals ignore. In the replay it follows all the agent's output, as the marker file cannot.
pub(super) const ENDED_MARK: &[u8] = b"\x1b]7700;nunchiro-agent-ended\x07";
/// Ticket 488: the longest an ended agent's card waits for `ENDED_MARK`, from when the core saw its marker; it is
/// usually in within a few milliseconds. A wrapper from before 488 (a core restarted on old sessions) never prints it.
/// No pass sleeps for it: the card is judged on the first pass that finds the mark or this time gone.
const ENDED_MARK_WAIT: std::time::Duration = std::time::Duration::from_millis(300);
/// Ticket 488: whether the replay's last 4 KiB hold `ENDED_MARK` (keys echoed after it stay within that). An agent that
/// prints the mark itself only gets the read it had before 488. Ticket 505: only this run's output counts; a resumed
/// session's seed holds the earlier run's mark.
fn ended_mark_in(pty: &crate::pty::Pty) -> bool {
    let from = pty.end().saturating_sub(4096).max(pty.run_start());
    matches!(pty.read_at_most(from, 4096), Ok(crate::api::Reply::Output { data, .. })
        if data.windows(ENDED_MARK.len()).any(|w| w == ENDED_MARK))
}
/// Ticket 488: raises an ended agent's pending card once its last output is in (`ENDED_MARK`), its wait is over, or
/// `now` (the session is ending); `true` when it judged one.
pub(super) fn card_judged(entry: &mut Entry, now: bool) -> bool {
    let (Some((due, code)), Some(pty)) = (entry.card_due, &entry.pty) else {
        return false;
    };
    if !now && std::time::Instant::now() < due && !ended_mark_in(pty) {
        return false;
    }
    entry.card_due = None;
    // Ticket 512 (488 review): a card raised meanwhile (a sign-in or start failure) says more than how it ended.
    if entry.meta.problem.is_some() {
        return true;
    }
    // Ticket 505: this run's output only, so a card judged before this run's mark never cuts at an earlier run's.
    let run = match pty.read_at_most(pty.run_start(), usize::MAX) {
        Ok(crate::api::Reply::Output { data, .. }) => data,
        _ => pty.snapshot(),
    };
    entry.meta.problem = crate::problems::ended(entry.meta.kind, agent_output(&run), code, false);
    true
}
/// Ticket 505: the replay up to the last `ENDED_MARK`, the agent's own output. What follows is the wrapper's and the
/// shell's: keys typed into the dead agent, reprinted once per byte the wrapper drains, pushed the agent's sign-in line
/// out of the card's bottom lines when the card was judged after them. With no mark (a pre-488 wrapper), all of it.
pub(super) fn agent_output(replay: &[u8]) -> &[u8] {
    let end = replay
        .windows(ENDED_MARK.len())
        .rposition(|w| w == ENDED_MARK);
    &replay[..end.unwrap_or(replay.len())]
}

pub(super) fn ended_marker(home: &Path, id: &str) -> PathBuf {
    home.join(format!("agent-ended-{id}"))
}
/// Ticket 436: `refresh` runs under the registry mutex, so the marker is read only as a regular file (a FIFO or device
/// there is refused by a non-blocking open, never waited on), and at most 64 bytes of it (an exit code line).
pub(super) fn read_marker(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut code = String::new();
    crate::store::open_regular(path)
        .ok()?
        .take(64)
        .read_to_string(&mut code)
        .ok()?;
    Some(code)
}
/// Ticket 436: the wrapper's go-ahead, written as `read_marker` reads: a non-blocking open (a FIFO swapped in without
/// a reader fails at once instead of waiting for one) and a regular file only. A link at the path is refused, never
/// written through (v37-store-nofollow), and the old text is cut only once the handle is known to be a regular file.
pub(super) fn answer_marker(path: &Path, code: &str) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    file.set_len(0)?;
    file.write_all(format!("seen {code}\n").as_bytes())
}
