//! Ticket 1002 lane 1 (Fable round 3 review M1, round 4 M1-r4): an agent seat in the Home folder from before the lock
//! (its record has no `home_lock`) cannot be locked while it runs, and the owner's tab, a team note or typed keys would
//! reach it unlocked. At core start it ends, its conversation resumable, so the next open resumes it locked and keeps its
//! chat. That holds whether `open` attached its holder or not: a stale row (a slow, busy or silent holder that `refresh`
//! would attach later) and a failed stop end the recorded agent as `end_group` does, and the row is not Running.
use super::*;

impl Sessions {
    pub(super) fn end_pre_lock_home_seats(&mut self) {
        let home = self.home.clone();
        let mut ended = false;
        for entry in self.entries.values_mut() {
            let meta = &entry.meta;
            if meta.state != SessionState::Running
                || meta.kind == AgentKind::Shell
                || meta.home_lock
                || !crate::home_lock::in_home(&home, &meta.cwd)
            {
                continue;
            }
            let gone = match (entry.pty.as_mut(), entry.stale.as_ref()) {
                (Some(pty), _) => match pty.stop() {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!(
                            "pre-lock Home seat {}: stop failed ({e}); ending its agent",
                            meta.id
                        );
                        end_group(pty.pid(), pty.agent_started(), &pty.holder().clone())
                    }
                },
                (None, Some(stale)) => end_group(stale.pid, stale.started, &stale.record),
                (None, None) => continue,
            };
            if !gone {
                // Still alive (no recorded start time to check it by): never attached later as a usable seat.
                eprintln!("pre-lock Home seat {} could not be ended", entry.meta.id);
            }
            entry.pty = None;
            entry.stale = None;
            entry.meta.pid = None;
            entry.meta.state = resumable(&entry.meta);
            cancel_queue(&mut entry.meta);
            if let Err(e) = self.queue.close(&entry.meta.id, false) {
                eprintln!("pre-lock Home seat queue: {e}");
            }
            if let Err(e) = remove_hooks(&home, &entry.meta.id) {
                eprintln!("pre-lock Home seat hooks: {e}");
            }
            eprintln!(
                "ended pre-lock Home seat {} (resumes locked)",
                entry.meta.id
            );
            ended = true;
        }
        if ended && let Err(e) = self.save() {
            eprintln!("pre-lock Home seats not saved as ended: {e}");
        }
    }
}
