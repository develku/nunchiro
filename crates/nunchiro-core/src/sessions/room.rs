//! Ticket 571: the room requests on the session registry. The sender is the caller the core resolved (token or peer
//! check), the room is the caller's project, and a new message reaches its seat as one fixed notice line through the
//! send-when-ready queue; the body never goes to a terminal.
use super::*;
use crate::room::{
    ASK_SENT, ASK_TAIL, ASK_TTL_MS, By, Draft, Kind, Log, NOTICE_ONE, NOTICE_TAIL, PERSON, notice,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct State {
    /// Seats whose notice was refused before anything was written (seat blocked, screen behind).
    due: std::collections::BTreeSet<String>,
    /// (room, ask id) -> last poll of an `ask --wait` and the asker: its reply comes back as output, so it needs no notice.
    waits: BTreeMap<(PathBuf, String), (Instant, String)>,
    /// Seat -> the newest unread message (id, time) its last PostToolUse context line counted: one line per batch.
    told: BTreeMap<String, (String, u64)>,
    /// Ended seats whose open asks already got their `lost` event (checked once per ending).
    lost: std::collections::BTreeSet<String>,
    /// When the rooms were last looked at for asks past their deadline.
    scanned: Option<Instant>,
    /// Tests only: a shorter deadline (ms) than `ASK_TTL_MS`.
    ttl_ms: Option<u64>,
}
/// The window shows the newest messages only; a room is capped at 10000 and the panel polls.
const ROOM_READ_MAX: usize = 500;
const WAIT_SEEN: Duration = Duration::from_secs(3);
/// Deadlines are read from the log (so a restarted core keeps them) this often: a timeout comes up to this late.
const TIMEOUT_SCAN: Duration = Duration::from_secs(15);

pub(crate) fn is_room(request: &Request) -> bool {
    matches!(
        request,
        Request::RoomSend { .. }
            | Request::RoomReply { .. }
            | Request::RoomCheck { .. }
            | Request::RoomThread { .. }
            | Request::RoomRead { .. }
            | Request::RoomPin { .. }
            | Request::RoomAnswer { .. }
    )
}

/// The core's own inbox notice, "<count> new messages: …". A person's queued prompt that only ends with the same words is not one.
fn is_notice(content: &str) -> bool {
    content
        .strip_suffix(NOTICE_TAIL)
        .or_else(|| content.strip_suffix(NOTICE_ONE))
        .is_some_and(|n| n.trim_end().parse::<u32>().is_ok())
}

impl Sessions {
    /// A session's room: the project of the top of its parent chain, so a worker in a worktree shares its lead's room.
    // shortcut: a worktree tab the person opened has no parent and gets its own room; map worktrees to their project
    // through the worktree store when the room panel needs that.
    pub(crate) fn room_project(&self, id: &str) -> Option<PathBuf> {
        let mut meta = &self.entries.get(id)?.meta;
        for _ in 0..32 {
            match meta.parent.as_ref().and_then(|p| self.entries.get(p)) {
                Some(parent) => meta = &parent.meta,
                None => break,
            }
        }
        Some(meta.project.clone())
    }
    /// Ticket 990 slice g: a session's name, for a task's open questions.
    pub(crate) fn label_of(&self, id: &str) -> Option<String> {
        self.entries.get(id).map(|e| e.meta.label.clone())
    }
    /// Ticket 990 slice g: a session a lead puts on a task: its name and folder, when it is in the task's place.
    pub(crate) fn seat_place(&self, id: &str, place: &Path) -> Result<(String, PathBuf), String> {
        let meta = &self.entries.get(id).ok_or("unknown session")?.meta;
        if self.room_project(id).as_deref() != Some(place) && meta.project != place {
            return Err("that session is outside this task's place".into());
        }
        Ok((meta.label.clone(), meta.cwd.clone()))
    }
    /// Unaddressed goes to the lead: the sender's parent when it shares the room; else, for a teammate's seat, the live
    /// seat of its place's lead (ticket 990); else the person.
    fn room_lead(&self, seat: &str, project: &Path) -> String {
        self.entries
            .get(seat)
            .and_then(|e| e.meta.parent.clone())
            .or_else(|| self.place_lead_seat(seat))
            .filter(|p| self.room_project(p).as_deref() == Some(project))
            .unwrap_or_else(|| PERSON.into())
    }
    /// Ticket 990: for the seat of a teammate that is not the lead, the live seat of its place's lead.
    fn place_lead_seat(&self, seat: &str) -> Option<String> {
        let mine = self.entries.get(seat)?.meta.teammate.as_deref()?;
        let all = crate::team::Team::open(&self.home).list().ok()?;
        let me = all.iter().find(|t| t.id == mine).filter(|t| !t.lead)?;
        let lead = all.iter().find(|t| t.lead && t.project == me.project)?;
        self.seat_of(&lead.id)
    }
    /// Two agent seats where neither started the other (a worker and a reviewer); a lead and its own worker are not.
    fn room_peers(&self, a: &str, b: &str) -> bool {
        let parent = |s: &str| self.entries.get(s).and_then(|e| e.meta.parent.clone());
        a != PERSON
            && b != PERSON
            && parent(a).as_deref() != Some(b)
            && parent(b).as_deref() != Some(a)
    }
    pub(super) fn room(
        &mut self,
        caller: Option<&crate::grants::Caller>,
        request: Request,
    ) -> Response {
        let request_project = match &request {
            Request::RoomSend { project, .. }
            | Request::RoomReply { project, .. }
            | Request::RoomCheck { project }
            | Request::RoomThread { project, .. }
            | Request::RoomRead { project, .. }
            | Request::RoomPin { project, .. }
            | Request::RoomAnswer { project, .. } => project.clone(),
            _ => None,
        };
        let (seat, by, project) = match caller {
            // Ticket 573: an outside token has a seat of its own (`token-<id>`) in the room it names.
            Some(c) if super::tokens::is_token(c) => {
                let project = request_project.ok_or("a token names the room with --project")?;
                (
                    c.id.clone(),
                    By::Agent,
                    fs::canonicalize(project).map_err(|e| e.to_string())?,
                )
            }
            Some(c) => (
                c.id.clone(),
                By::Agent,
                self.room_project(&c.id).ok_or("session not found")?,
            ),
            None => {
                let project =
                    request_project.ok_or("outside a session the room needs --project")?;
                let project = fs::canonicalize(project).map_err(|e| e.to_string())?;
                (PERSON.to_string(), By::Person, project)
            }
        };
        let log = Log::open(&self.home, &project);
        if matches!(request, Request::RoomRead { .. } | Request::RoomPin { .. }) && by != By::Person
        {
            return Err("the whole room is the owner's to read".into());
        }
        if let Request::RoomRead { since, log: id, .. } = &request {
            let (messages, reset, id) = log.page(since.zip(*id), ROOM_READ_MAX)?;
            return Ok(Reply::RoomRead {
                messages,
                reset,
                log: id,
                pins: log.pins()?,
                names: log.names(),
            });
        }
        if let Request::RoomPin {
            message, pinned, ..
        } = &request
        {
            return Ok(Reply::RoomPins {
                pins: log.pin(message, *pinned)?,
            });
        }
        let messages = match request {
            Request::RoomSend {
                to,
                thread,
                body,
                ask,
                ..
            } => {
                let to = match to {
                    Some(to) => to,
                    None if by == By::Agent => self.room_lead(&seat, &project),
                    None => return Err("name a seat with --to".into()),
                };
                if to != PERSON && self.room_project(&to).as_deref() != Some(&project) {
                    return Err("outside this project's room".into());
                }
                self.locked_reach(&seat, &to)?;
                let message = log.add(Draft {
                    kind: if ask { Kind::Ask } else { Kind::Message },
                    peers: self.room_peers(&seat, &to),
                    from: seat,
                    to,
                    thread,
                    reply_to: None,
                    body,
                    created_by: by,
                })?;
                self.room_notice(&project, &message);
                vec![message]
            }
            Request::RoomReply { message, body, .. } => {
                let original = log
                    .find(|m| m.id == message)?
                    .pop()
                    .ok_or("message not found in this room")?;
                if original.to != seat {
                    return Err("only the seat a message went to replies to it".into());
                }
                self.locked_reach(&seat, &original.from)?;
                let message = log.add(Draft {
                    kind: Kind::Reply,
                    peers: self.room_peers(&seat, &original.from),
                    from: seat,
                    to: original.from,
                    thread: Some(original.thread),
                    reply_to: Some(message),
                    body,
                    created_by: by,
                })?;
                self.room_notice(&project, &message);
                vec![message]
            }
            Request::RoomCheck { .. } => {
                let read = log.check(&seat)?;
                // The seat has read its inbox: a notice still queued for it would tell it about messages it has
                // (seen with a real lead: "2 new messages" after its own check cost one more turn).
                if let Some(entry) = self.entries.get_mut(&seat) {
                    entry
                        .meta
                        .send_queue
                        .retain(|s| !(s.status == "queued" && is_notice(&s.content)));
                }
                self.room.due.remove(&seat);
                read
            }
            Request::RoomThread { thread, .. } => log.find(|m| m.thread == thread)?,
            Request::RoomAnswer { ask, give_up, .. } => {
                // The ask, then its reply and its timeout, if any, in log order.
                let all = log.find(|m| m.id == ask || m.reply_to.as_deref() == Some(&ask))?;
                let asked = all
                    .iter()
                    .find(|m| m.id == ask && m.kind == Kind::Ask)
                    .ok_or("ask not found in this room")?;
                if asked.from != seat {
                    return Err("only the asker waits for its answer".into());
                }
                let key = (project.clone(), ask.clone());
                let reply = all
                    .iter()
                    .find(|m| m.kind == Kind::Reply && m.reply_to.as_deref() == Some(&ask))
                    .cloned();
                // Q9 tt-J7-1: a plain thread answer or a `lost` event also closes the ask (`open_ask`); the asker
                // gets that message instead of polling on to a false timeout. Its own timeout stays below.
                let reply = match reply {
                    Some(reply) => Some(reply),
                    None => log
                        .find(|m| {
                            m.thread == asked.thread && m.id != ask && m.kind != Kind::Timeout
                        })?
                        .into_iter()
                        .find(|m| !open_ask(std::slice::from_ref(m), asked)),
                };
                if let Some(reply) = reply {
                    self.room.waits.remove(&key);
                    vec![reply]
                } else if give_up {
                    self.room.waits.remove(&key);
                    // Once per ask, and through the seat and room caps: an asker cannot fill another inbox this way.
                    if all.iter().any(|m| m.kind == Kind::Timeout) {
                        return Err(format!("ask {ask} already timed out"));
                    }
                    log.event(Draft {
                        kind: Kind::Timeout,
                        from: seat,
                        to: PERSON.into(), // an unanswered ask goes to the person
                        thread: Some(asked.thread.clone()),
                        reply_to: Some(ask),
                        body: "the asker stopped waiting for a reply".into(),
                        created_by: By::Core,
                        peers: false,
                    })?;
                    vec![]
                } else {
                    self.room.waits.insert(key, (Instant::now(), seat));
                    vec![]
                }
            }
            _ => return Err("not a room request".into()),
        };
        Ok(Reply::Room { messages })
    }
    /// Look 1117 v12 B N11-S2-3: the seat blocks in `agent ask --wait` on its open ask now (it polled within
    /// `WAIT_SEEN`); its turn runs that command, but it waits for the answer, as the ledger's `asking` says.
    pub(crate) fn asks_waiting(&self, seat: &str) -> bool {
        self.room
            .waits
            .values()
            .any(|(at, s)| s == seat && at.elapsed() < WAIT_SEEN)
    }
    fn room_notice(&mut self, project: &Path, message: &crate::room::Message) {
        if message.to == PERSON {
            return; // the person reads the room in the window or with `agent check --project`
        }
        if let Some(ask) = &message.reply_to {
            let key = (project.to_path_buf(), ask.clone());
            if self
                .room
                .waits
                .get(&key)
                .is_some_and(|(at, _)| at.elapsed() < WAIT_SEEN)
            {
                return; // the asker's `--wait` returns it as output
            }
        }
        self.room_notify(&message.to);
    }
    /// Ticket 1002 lane 1 (Fable round 3 review M1): a locked seat's room line reaches the person or a locked seat only,
    /// never a seat from before the lock that would act on it unlocked.
    fn locked_reach(&self, from: &str, to: &str) -> Result<(), String> {
        if to != PERSON && self.locked(from) && !self.locked(to) {
            return Err(
                "the chief of staff's room lines go only to you and to locked seats".into(),
            );
        }
        Ok(())
    }
    /// Ticket 990: a team note for `seat` landed in its room: the same notice as any message.
    pub(super) fn room_told(&mut self, seat: &str) {
        self.room_notify(seat);
    }
    /// The fixed line only. A notice still queued for the seat gets the new count instead of a second line.
    fn room_notify(&mut self, seat: &str) {
        self.room.due.remove(seat);
        let Some(project) = self.room_project(seat) else {
            return;
        };
        let unread = Log::open(&self.home, &project).unread(seat).unwrap_or(0);
        let Some(entry) = self.entries.get_mut(seat) else {
            return;
        };
        // Agents only, as `wake_parents`: a shell would run the line as a command.
        if unread == 0
            || !matches!(
                entry.meta.kind,
                AgentKind::Claude | AgentKind::Codex | AgentKind::Acp
            )
        {
            return;
        }
        let text = notice(unread);
        if let Some(row) = entry
            .meta
            .send_queue
            .iter_mut()
            .find(|s| s.status == "queued" && is_notice(&s.content))
        {
            row.content = text;
            return;
        }
        // Sent as the seat itself: not as the message sender, whose ended agent would make the flush drop a queued row
        // (ticket 286), and never as `user`, which skips the session gate in `write_send` and would submit whatever
        // another session left typed (a slash command) with the owner's standing.
        // A blocked seat refuses before writing: the notice never answers a dialog or a permission; it is tried again.
        // A box edited by hand: the notice waits in the seat's queue (`send_line`), never refused and dropped.
        if let Err(e) = self.send_line(seat, seat, text)
            && (e == "agent_blocked" || e == "screen not current, try again")
        {
            self.room.due.insert(seat.into());
        }
    }
    /// Look 11-17 v5 item 3: a stop of the core ends every running session; a request one of them was waiting on (a
    /// permission, a question, a dialog) ends with it and its row only reads "Resumable" afterwards. The place's lead
    /// hears it in one room line, from the ended seat (as a `lost` event comes): "<seat>'s request ended when the core
    /// restarted: <first words>". No lead for the place: nothing is written.
    pub(super) fn note_asks_ending_at_stop(&mut self) {
        let team = crate::team::Team::open(&self.home);
        let ended: Vec<(String, PathBuf, String, String)> = self
            .entries
            .values()
            .filter(|e| e.agent_live())
            .filter_map(|e| {
                let ask = self.queue.items_of(&e.meta.id).into_iter().find(|i| {
                    matches!(
                        i.kind,
                        crate::queue::Kind::Permission
                            | crate::queue::Kind::Question
                            | crate::queue::Kind::Dialog
                    )
                })?;
                let lead = self
                    .recorded_worktree(&e.meta.cwd)
                    .and_then(|w| w.team)
                    .or_else(|| self.team_lead_of(&e.meta.id))
                    .or_else(|| team.lead_of(Some(&e.meta.project)).map(|t| t.id))?;
                let words = ask_words(&ask);
                let name = if e.meta.label.is_empty() {
                    e.meta.id[..e.meta.id.len().min(6)].to_string()
                } else {
                    e.meta.label.clone()
                };
                Some((
                    e.meta.id.clone(),
                    e.meta.project.clone(),
                    lead,
                    format!("{name}'s request ended when the core restarted: {words}"),
                ))
            })
            .collect();
        for (id, project, lead, body) in ended {
            let to = self
                .seat_of(&lead)
                .filter(|s| *s != id)
                .unwrap_or_else(|| PERSON.to_string());
            let sent = Log::open(&self.home, &project).event(Draft {
                kind: Kind::Message,
                from: id,
                to,
                thread: None,
                reply_to: None,
                body,
                created_by: By::Core,
                peers: false,
            });
            if let Err(e) = sent {
                eprintln!("room: the ended request was not noted: {e}");
            }
        }
    }
    /// Ticket 571: an ask is open until a reply, a timeout or a `lost` event names it. When a seat ends (exited or
    /// failed or closed) every open ask it sent or was sent gets one `lost` event, from the ended seat
    /// to the ask's other party, so the room shows that no answer will come. A seat is checked once per ending.
    // shortcut: an ask sent to a seat after it ended is not marked; it stays open until the asker gives up.
    fn room_lost(&mut self) {
        let ended = |state: SessionState| match state {
            SessionState::Failed => Some("failed"),
            SessionState::Exited | SessionState::Resumable => Some("exited"),
            // Ticket 990 (seen with a real lead that closed a worker whose question was open): a closed seat can get
            // no answer either, so its open asks say so. Ticket 571 kept a closed tab silent.
            SessionState::Closed => Some("closed"),
            _ => None,
        };
        // A seat that runs again is checked when it ends again; only seats not yet checked are looked at below.
        let entries = &self.entries;
        self.room.lost.retain(|id| {
            entries
                .get(id)
                .is_some_and(|e| ended(e.meta.state).is_some())
        });
        let fresh: Vec<(String, &str)> = self
            .entries
            .iter()
            .filter(|(id, _)| !self.room.lost.contains(*id))
            .filter_map(|(id, e)| Some((id.clone(), ended(e.meta.state)?)))
            .collect();
        for (id, word) in fresh {
            self.room.lost.insert(id.clone());
            let Some(project) = self.room_project(&id) else {
                continue;
            };
            let log = Log::open(&self.home, &project);
            let Ok(mine) = log.find(|m| m.from == id || m.to == id) else {
                self.room.lost.remove(&id); // unreadable now: try the next tick
                continue;
            };
            let asks: Vec<_> = mine.iter().filter(|m| m.kind == Kind::Ask).collect();
            if asks.is_empty() {
                continue;
            }
            // An answer can be a plain message: the window's composer and `agent send` carry no `reply_to`.
            let threads: Vec<&str> = asks.iter().map(|m| m.thread.as_str()).collect();
            let Ok(talk) = log.find(|m| threads.contains(&m.thread.as_str())) else {
                self.room.lost.remove(&id);
                continue;
            };
            for ask in asks {
                if !open_ask(&talk, ask) {
                    continue;
                }
                let to = if ask.from == id {
                    ask.to.clone()
                } else {
                    ask.from.clone()
                };
                let sent = log.event(Draft {
                    kind: Kind::Lost,
                    from: id.clone(),
                    to: to.clone(),
                    thread: Some(ask.thread.clone()),
                    reply_to: Some(ask.id.clone()),
                    body: format!("the seat ended ({word}) with this ask open"),
                    created_by: By::Agent,
                    peers: false,
                });
                // Ticket 594: the party still waiting hears it by the usual notice (the person reads the window).
                if sent.is_ok() {
                    self.room_notify(&to);
                }
            }
        }
    }
    /// Ticket 571: every ask has a deadline. An ask that is still open `ASK_TTL_MS` after it was sent gets one `timeout`
    /// event addressed to the person (the window shows the thread under Needs you, and the person can answer it as any
    /// ask), and its asker is told through the notice. Read from the log, so a restart neither forgets nor repeats one
    /// (a timeout closes the ask, as a reply or `lost` does). Skipped: an ask a live `--wait` still polls (that call times
    /// out by its own `--timeout`), and an ask to or from the person, who already has it.
    // shortcut: only rooms of a known session are looked at; the room of a token with no session never times out.
    fn room_timeouts(&mut self) {
        let ttl = self.room.ttl_ms.unwrap_or(ASK_TTL_MS);
        if self.room.scanned.is_some_and(|at| {
            at.elapsed() < Duration::from_millis(TIMEOUT_SCAN.as_millis().min(ttl as u128) as u64)
        }) {
            return;
        }
        self.room.scanned = Some(Instant::now());
        let now = crate::queue::now_ms();
        let rooms: std::collections::BTreeSet<_> = self
            .entries
            .keys()
            .filter_map(|id| self.room_project(id))
            .collect();
        for project in rooms {
            let log = Log::open(&self.home, &project);
            let Ok(late) = log.scan(|all| late_asks(all, now, ttl)) else {
                continue;
            };
            for ask in late {
                let key = (project.clone(), ask.id.clone());
                if self
                    .room
                    .waits
                    .get(&key)
                    .is_some_and(|(at, _)| at.elapsed() < WAIT_SEEN)
                {
                    continue;
                }
                let sent = log.event(Draft {
                    kind: Kind::Timeout,
                    from: ask.from.clone(),
                    to: PERSON.into(),
                    thread: Some(ask.thread.clone()),
                    reply_to: Some(ask.id.clone()),
                    body: format!(
                        "no reply to {} from {} in {} min; the person decides",
                        ask.id,
                        ask.to,
                        ttl / 60_000
                    ),
                    created_by: By::Core,
                    peers: false,
                });
                if sent.is_ok() {
                    self.room_notify(&ask.from);
                }
            }
        }
    }
    /// Each tick: notices that were refused before anything was written.
    pub(super) fn room_notices(&mut self) {
        self.room_lost();
        self.room_timeouts();
        let due = std::mem::take(&mut self.room.due);
        for seat in due {
            self.room_notify(&seat);
        }
        self.room
            .waits
            .retain(|_, (at, _)| at.elapsed() < WAIT_SEEN);
        let entries = &self.entries;
        self.room.told.retain(|seat, _| entries.contains_key(seat));
    }
    /// Hooks slice: a question tool call (Claude `AskUserQuestion`, Codex `request_user_input` or, ticket 589, the
    /// `request_user_input_async` that Codex 0.161 offers its default model instead) of a session whose
    /// parent is a live agent in the same room becomes an ask to that parent, and the hook denies the call with the
    /// fixed reason. `id` is the hook's session, the one its token authorized; the parent is the core's record, never
    /// a payload field. Peers: T3's DelegatedTaskQuestionReactor (a child's question goes to its parent) and Orca's
    /// worker rule "use ask instead of a local question the coordinator cannot answer", enforced here, not asked.
    /// `None` keeps today's path (the person answers in the app): no parent, a parent that is not a running agent (a
    /// shell tab cannot run `agent check`), or an ask the room's guards refuse (the guard's note reaches the person).
    /// One thread per child (`q-<child>`), so the round cap stops a child that keeps asking. The caller
    /// (`server::connection`) calls this only while the deny can still reach the bridge, and hands the hook to the
    /// normal path when the deny's write fails.
    pub(crate) fn room_question(
        &mut self,
        id: &str,
        event: &str,
        payload: &Value,
    ) -> Option<Value> {
        let tool = payload["tool_name"].as_str()?;
        let entry = self.entries.get(id).filter(|e| e.agent_live())?;
        let mine: &[&str] = match entry.meta.kind {
            AgentKind::Claude => &["AskUserQuestion"],
            AgentKind::Codex => &["request_user_input", "request_user_input_async"],
            _ => return None,
        };
        if event != "PreToolUse" || !mine.contains(&tool) {
            return None;
        }
        let parent = entry.meta.parent.clone()?;
        let project = self.room_project(id)?;
        // An agent seat, as `room_notify` delivers to: only these hear the notice and can answer.
        let agent = |e: &Entry| {
            e.agent_live()
                && matches!(
                    e.meta.kind,
                    AgentKind::Claude | AgentKind::Codex | AgentKind::Acp
                )
        };
        if self.room_lead(id, &project) != parent || !self.entries.get(&parent).is_some_and(agent) {
            return None;
        }
        let ask = Log::open(&self.home, &project)
            .add(Draft {
                kind: Kind::Ask,
                from: id.into(),
                to: parent,
                // Session ids are 36 characters; the cut keeps any longer id inside the 40-character thread name.
                thread: Some(format!("q-{}", &id[..id.len().min(38)])),
                reply_to: None,
                body: question_body(&payload["tool_input"]),
                created_by: By::Agent,
                peers: false,
            })
            .ok()?;
        self.room_notice(&project, &ask);
        Some(json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": format!(
                "{ASK_SENT}{}{ASK_TAIL}",
                ask.id.strip_prefix('m').unwrap_or(&ask.id)
            ),
        }}))
    }
    /// Look v9 B N2-S2-1: an ask from `seat` to `lead` is open in their room (`open_ask`, the room log's own rule).
    pub(crate) fn asks_lead(&self, seat: &str, lead: &str) -> bool {
        self.room_project(seat).is_some_and(|project| {
            Log::open(&self.home, &project)
                .scan(|all| {
                    all.iter().any(|m| {
                        m.kind == Kind::Ask && m.from == seat && m.to == lead && open_ask(all, m)
                    })
                })
                .unwrap_or(false)
        })
    }
    /// Hooks slice: a Claude seat with unread room messages hears the fixed notice as PostToolUse context, so a long
    /// turn learns of them before its turn ends (the PTY notice waits for ready). Once per batch: again only when a
    /// newer message is unread. The rules of `board::nudge`: the core's session, fixed text, no payload field read.
    pub(super) fn room_context(&mut self, id: &str) -> Option<Value> {
        if self.entries.get(id)?.meta.kind != AgentKind::Claude {
            return None;
        }
        let project = self.room_project(id)?;
        let inbox = Log::open(&self.home, &project).inbox(id).ok()?;
        let last = inbox.last()?;
        let batch = (last.id.clone(), last.ts);
        if self.room.told.get(id) == Some(&batch) {
            return None;
        }
        self.room.told.insert(id.into(), batch);
        Some(json!({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": notice(inbox.len()),
        }}))
    }
}

// Test only: how many whole-log passes (`open_ask` calls) this thread made; a thread's own, so parallel tests do not mix.
#[cfg(test)]
thread_local! { static OPEN_ASK_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

/// The asks between agents that are still open and were sent `ttl` ms or more before `now`. One pass over the log
/// collects the asks no reply, timeout, `lost` or later message from the asked seat has closed yet; only those few
/// meet `open_ask`, the rule itself, so a room full of answered asks costs one pass, not one pass per ask.
fn late_asks(all: &[crate::room::Message], now: u64, ttl: u64) -> Vec<crate::room::Message> {
    use std::collections::HashMap;
    let mut open: HashMap<&str, &crate::room::Message> = HashMap::new();
    let mut threads: HashMap<&str, Vec<&str>> = HashMap::new();
    for m in all {
        if let (Kind::Reply | Kind::Timeout | Kind::Lost, Some(id)) =
            (m.kind, m.reply_to.as_deref())
        {
            open.remove(id);
        }
        if matches!(m.kind, Kind::Message | Kind::Reply)
            && let Some(ids) = threads.get_mut(m.thread.as_str())
        {
            ids.retain(|id| {
                if open.get(id).is_some_and(|ask| ask.to == m.from) {
                    open.remove(id);
                }
                open.contains_key(id)
            });
        }
        if m.kind == Kind::Ask && m.to != PERSON && m.from != PERSON {
            open.insert(&m.id, m);
            threads.entry(&m.thread).or_default().push(&m.id);
        }
    }
    let mut late: Vec<_> = open
        .into_values()
        .filter(|ask| now.saturating_sub(ask.ts) >= ttl && open_ask(all, ask))
        .cloned()
        .collect();
    late.sort_by(|a, b| (a.ts, a.id.len(), &a.id).cmp(&(b.ts, b.id.len(), &b.id))); // m9 before m10
    late
}

/// An ask is open until a reply, a timeout or a `lost` event names it, or a later message in its thread comes from the seat it
/// was sent to (for the person: any message the person wrote). The window reads an ask the same way (`RoomView` `needs`).
pub(crate) fn open_ask(thread: &[crate::room::Message], ask: &crate::room::Message) -> bool {
    #[cfg(test)]
    OPEN_ASK_CALLS.with(|c| c.set(c.get() + 1));
    // The core numbers messages m1, m2, ...; a hand-edited line whose id does not parse is no answer, and an ask that does not parse is not judged.
    let num = |m: &crate::room::Message| m.id.strip_prefix('m')?.parse::<u64>().ok();
    let Some(asked) = num(ask) else {
        return false;
    };
    !thread.iter().any(|m| {
        (matches!(m.kind, Kind::Reply | Kind::Timeout | Kind::Lost)
            && m.reply_to.as_deref() == Some(&ask.id))
            || (m.thread == ask.thread
                && num(m).is_some_and(|n| n > asked)
                && matches!(m.kind, Kind::Message | Kind::Reply)
                && if ask.to == PERSON {
                    m.created_by == By::Person
                } else {
                    m.from == ask.to
                })
    })
}

/// The question as the ask body: each question, then its numbered options. Both tools send `questions` with
/// `question` and `options[].label` (Codex adds ids and headers, which the lead does not need).
fn question_body(input: &Value) -> String {
    let Some(questions) = input["questions"].as_array() else {
        return input.to_string();
    };
    let mut body = String::new();
    for q in questions {
        // Ticket 589: Codex's async tool names the question `title` and gives options as plain strings.
        let text = q["question"].as_str().or(q["title"].as_str());
        body.push_str(text.unwrap_or_default());
        body.push('\n');
        for (n, o) in q["options"].as_array().into_iter().flatten().enumerate() {
            let label = o["label"].as_str().or(o.as_str());
            body.push_str(&format!("  {}. {}", n + 1, label.unwrap_or_default()));
            if let Some(d) = o["description"].as_str().filter(|d| !d.is_empty()) {
                body.push_str(&format!(": {d}"));
            }
            body.push('\n');
        }
    }
    body
}

/// The first words of an ask, as the Room says it and the window's line for an ask that ended with its session
/// (look 1117 v10 N10-S3-3), masked.
pub(super) fn ask_words(ask: &crate::queue::Decision) -> String {
    // Look 1117 v10 N10-S3-5: a hook's ask is its tool input (JSON): the Room says it in words (the
    // question's first line, a plan's title, the command or file), never the JSON.
    let said = serde_json::from_str::<Value>(&ask.text)
        .ok()
        .filter(Value::is_object)
        .map(|v| {
            let q = &v["questions"][0];
            [
                &q["question"],
                &q["title"],
                &v["question"],
                &v["plan"],
                &v["command"],
                &v["file_path"],
            ]
            .into_iter()
            .find_map(|f| {
                f.as_str()?
                    .lines()
                    .map(|l| l.trim_start_matches('#').trim())
                    .find(|l| !l.is_empty())
            })
            .map_or_else(
                || {
                    if ask.kind == crate::queue::Kind::Question {
                        "a question"
                    } else {
                        "a request"
                    }
                    .to_string()
                },
                str::to_string,
            )
        });
    let words: String = said
        .as_deref()
        .unwrap_or(&ask.text)
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    String::from_utf8_lossy(&crate::logs::mask(words.as_bytes())).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::Message;

    /// Agent sessions that are shell scripts: `cat` prints every byte typed into it, so the screen shows what reached
    /// the terminal. Only the kind decides delivery.
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
            let home = std::env::temp_dir().join(format!("ns-rm-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&home);
            fs::create_dir_all(&home).unwrap();
            let home = fs::canonicalize(home).unwrap();
            let script = home.join("echo.sh");
            fs::write(&script, "#!/bin/sh\nstty raw -echo\nexec cat\n").unwrap();
            fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o700))
                .unwrap();
            Self {
                core: Sessions::open(&home).unwrap(),
                home,
            }
        }
        fn session(&mut self, label: &str, folder: &Path, parent: Option<&str>) -> String {
            fs::create_dir_all(folder).unwrap();
            let mut launch = self
                .core
                .launch(StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: folder.into(),
                    worktree: false,
                    label: label.into(),
                    args: vec![self.home.join("echo.sh").to_str().unwrap().into()],
                    model: None,
                    effort: None,
                    resume: None,
                })
                .prepare()
                .unwrap();
            let id = self.core.start(&launch).unwrap().id;
            launch.committed = true;
            let meta = &mut self.core.entries.get_mut(&id).unwrap().meta;
            meta.kind = AgentKind::Claude;
            if let Some(parent) = parent {
                meta.parent = Some(parent.into());
                self.core.grants.parents.insert(id.clone(), parent.into());
            }
            id
        }
        /// A lead in the project, a worker in its own folder (a worktree stand-in) and a reviewer, both started by it.
        fn room(name: &str) -> (Self, String, String, String) {
            let mut f = Self::new(name);
            let project = f.home.join("p");
            let lead = f.session("lead", &project, None);
            let worker = f.session("w1", &f.home.join("wt1"), Some(&lead));
            let rev = f.session("rev", &f.home.join("wt2"), Some(&lead));
            (f, lead, worker, rev)
        }
        fn caller(&self, id: &str) -> crate::grants::Caller {
            crate::grants::Caller {
                id: id.into(),
                project: self.core.entries[id].meta.project.clone(),
            }
        }
        fn call(&mut self, id: &str, request: Request) -> Result<Vec<Message>, String> {
            let caller = self.caller(id);
            match self.core.handle_agent(&caller, request)? {
                Reply::Room { messages } => Ok(messages),
                other => panic!("{other:?}"),
            }
        }
        fn rows(&self, id: &str) -> Vec<String> {
            let meta = &self.core.entries[id].meta;
            meta.send_log
                .iter()
                .chain(&meta.send_queue)
                .map(|s| s.content.clone())
                .collect()
        }
    }
    fn send(to: Option<&str>, thread: Option<&str>, body: &str) -> Request {
        Request::RoomSend {
            to: to.map(Into::into),
            thread: thread.map(Into::into),
            body: body.into(),
            ask: false,
            project: None,
        }
    }

    /// What reached a session's terminal (its `cat` prints every byte), once the echo is in.
    fn shown(f: &mut Fix, id: &str) -> String {
        std::thread::sleep(Duration::from_millis(200));
        f.core.observe().unwrap();
        f.core.entries[id].observer.screen.text().trim().to_string()
    }
    /// A session's send rows, queue order: (text, status).
    fn sends(f: &Fix, id: &str) -> Vec<(String, String)> {
        let meta = &f.core.entries[id].meta;
        meta.send_log
            .iter()
            .chain(&meta.send_queue)
            .map(|s| (s.content.clone(), s.status.clone()))
            .collect()
    }
    fn turn(f: &mut Fix, id: &str) {
        f.core.queue.acp_turn(id, true).unwrap();
        f.core.queue.acp_turn(id, false).unwrap();
    }
    /// The user's raw key in a session's terminal, as the window sends it.
    fn key(f: &mut Fix, id: &str, text: &str) {
        f.core
            .handle(Request::SendText {
                id: id.into(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
    }
    /// Sixth look B6-S2-1, the rest of it: the user typed a key in the lead's terminal and sent nothing. Its workers'
    /// finish lines were refused by the box, kept as failed rows and counted as told: the lead never heard. They wait:
    /// the room has each line at once and says why, nothing is typed, and after the user's Enter there each goes in
    /// once, in order, also the line of a worker that has exited by then.
    #[test]
    fn a_finish_line_waits_for_a_box_edited_by_hand() {
        let (mut f, lead, worker, rev) = Fix::room("held-wake");
        turn(&mut f, &lead);
        key(&mut f, &lead, "x");
        turn(&mut f, &worker);
        f.core.tick().unwrap();
        f.core.entries.get_mut(&rev).unwrap().meta.state = SessionState::Exited;
        for _ in 0..3 {
            f.core.tick().unwrap();
        }
        let queued = |text: &str| (text.to_string(), "queued".to_string());
        assert_eq!(
            sends(&f, &lead),
            [queued("worker w1 done"), queued("worker rev exited")]
        );
        let screen = shown(&mut f, &lead);
        assert!(
            screen.contains('x') && !screen.contains("worker"),
            "nothing typed behind the key: {screen:?}"
        );
        let room = |f: &Fix| -> Vec<String> {
            let all = Log::open(&f.home, &f.home.join("p")).read().unwrap();
            all.into_iter()
                .filter(|m| m.kind == Kind::Typed && m.to == lead)
                .map(|m| m.body)
                .collect()
        };
        let said = room(&f);
        assert_eq!(said.len(), 2, "{said:?}");
        assert!(
            said[0].starts_with("worker w1 done (waits: the input box of lead was edited by hand"),
            "{said:?}"
        );
        // The user's Enter there: the mark is gone, and the lines go in, one a turn.
        key(&mut f, &lead, "\r");
        f.core.tick().unwrap();
        turn(&mut f, &lead);
        for _ in 0..3 {
            f.core.tick().unwrap();
        }
        let delivered = |text: &str| (text.to_string(), "delivered".to_string());
        assert_eq!(
            sends(&f, &lead),
            [delivered("worker w1 done"), delivered("worker rev exited")]
        );
        assert!(shown(&mut f, &lead).contains("worker rev exited"));
        assert_eq!(room(&f).len(), 2, "no line twice");
    }
    /// The room's notice to such a seat waits the same way: one queued row, nothing typed, delivered after the Enter.
    #[test]
    fn a_notice_waits_for_a_box_edited_by_hand() {
        let (mut f, lead, worker, _) = Fix::room("held-notice");
        turn(&mut f, &lead);
        key(&mut f, &lead, "x");
        f.call(&worker, send(Some(&lead), None, "one")).unwrap();
        f.call(&worker, send(Some(&lead), None, "two")).unwrap();
        for _ in 0..3 {
            f.core.tick().unwrap();
        }
        assert_eq!(
            sends(&f, &lead),
            [(notice(2), "queued".to_string())],
            "one row, with the count"
        );
        let screen = shown(&mut f, &lead);
        assert!(
            screen.contains('x') && !screen.contains("new message"),
            "{screen:?}"
        );
        key(&mut f, &lead, "\r");
        f.core.tick().unwrap();
        assert_eq!(sends(&f, &lead), [(notice(2), "delivered".to_string())]);
    }
    #[test]
    fn sender_is_stamped_by_core() {
        let (mut f, lead, worker, _) = Fix::room("from");
        // The wire has no sender field: a `from` the caller adds is not read.
        let forged: Request = serde_json::from_value(serde_json::json!({
            "op": "room_send", "to": lead, "body": "hi", "from": "person", "created_by": "person"
        }))
        .unwrap();
        let got = f.call(&worker, forged).unwrap();
        assert_eq!(got[0].from, worker);
        assert_eq!(got[0].created_by, By::Agent);
        // The person is whoever calls with no session: the owner path.
        let Reply::Room { messages } = f
            .core
            .handle(Request::RoomSend {
                to: Some(worker.clone()),
                thread: None,
                body: "from the person".into(),
                ask: false,
                project: Some(f.home.join("p")),
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (messages[0].from.as_str(), messages[0].created_by),
            (PERSON, By::Person)
        );
    }
    #[test]
    fn room_read_is_the_owners_and_moves_no_cursor() {
        let (mut f, lead, worker, _) = Fix::room("read");
        f.call(&worker, send(Some(&lead), Some("t"), "one"))
            .unwrap();
        f.call(&lead, send(Some(&worker), Some("t"), "two"))
            .unwrap();
        let read = |f: &mut Fix, since: Option<usize>, log: Option<u64>| {
            let request = Request::RoomRead {
                project: Some(f.home.join("p")),
                since,
                log,
            };
            let Reply::RoomRead {
                messages,
                reset,
                log,
                ..
            } = f.core.handle(request).unwrap()
            else {
                panic!()
            };
            (
                messages.into_iter().map(|m| m.body).collect::<Vec<_>>(),
                reset,
                log,
            )
        };
        let (bodies, reset, log) = read(&mut f, None, None);
        assert_eq!(
            (bodies, reset),
            (["one", "two"].map(String::from).to_vec(), true)
        );
        assert_ne!(log, 0);
        // Nothing new: an empty page, no reset. The window keeps its list.
        assert_eq!(read(&mut f, Some(2), Some(log)), (vec![], false, log));
        f.call(&worker, send(Some(&lead), Some("t"), "three"))
            .unwrap();
        assert_eq!(
            read(&mut f, Some(2), Some(log)),
            (vec!["three".to_string()], false, log)
        );
        // Another log (or a number past this one) is not the window's log: the newest messages again, as a reset.
        let (bodies, reset, _) = read(&mut f, Some(2), Some(log + 1));
        assert_eq!((bodies.len(), reset), (3, true));
        let (bodies, reset, _) = read(&mut f, Some(9), Some(log));
        assert_eq!((bodies.len(), reset), (3, true));
        // An agent never reads the whole room, and the owner's reads left the lead's inbox as it was.
        let err = f
            .call(
                &lead,
                Request::RoomRead {
                    project: None,
                    since: None,
                    log: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, "the whole room is the owner's to read");
        // Ticket 593: pins are the owner's too; the owner's pin comes back with every read.
        let pin = |project| Request::RoomPin {
            project,
            message: "m1".into(),
            pinned: true,
        };
        assert_eq!(
            f.call(&lead, pin(None)).unwrap_err(),
            "the whole room is the owner's to read"
        );
        let project = Some(f.home.join("p"));
        assert!(
            matches!(f.core.handle(pin(project.clone())), Ok(Reply::RoomPins { pins }) if pins == ["m1"])
        );
        let Ok(Reply::RoomRead { pins, .. }) = f.core.handle(Request::RoomRead {
            project,
            since: None,
            log: None,
        }) else {
            panic!()
        };
        assert_eq!(pins, ["m1"]);
        assert_eq!(
            f.call(&lead, Request::RoomCheck { project: None })
                .unwrap()
                .len(),
            2 // "one" and "three"; "two" went the other way
        );
    }
    #[test]
    fn unaddressed_goes_to_lead_then_person() {
        let (mut f, lead, worker, _) = Fix::room("lead");
        let got = f.call(&worker, send(None, None, "q")).unwrap();
        assert_eq!(got[0].to, lead);
        let got = f.call(&lead, send(None, None, "q")).unwrap();
        assert_eq!(
            got[0].to, PERSON,
            "a session with no parent leads to the person"
        );
    }
    #[test]
    fn verbs_check_reply_thread() {
        let (mut f, lead, worker, rev) = Fix::room("verbs");
        let m = f
            .call(&worker, send(Some(&rev), None, "review this"))
            .unwrap()[0]
            .clone();
        let got = f.call(&rev, Request::RoomCheck { project: None }).unwrap();
        assert_eq!(got, std::slice::from_ref(&m));
        assert!(
            f.call(&rev, Request::RoomCheck { project: None })
                .unwrap()
                .is_empty()
        );
        // Only the addressee replies; the reply goes back to the sender in the same thread.
        let reply = Request::RoomReply {
            message: m.id.clone(),
            body: "one finding".into(),
            project: None,
        };
        assert!(f.call(&lead, reply.clone()).is_err());
        let r = f.call(&rev, reply).unwrap()[0].clone();
        assert_eq!(
            (r.to.as_str(), r.thread.as_str()),
            (worker.as_str(), m.thread.as_str())
        );
        assert_eq!(r.reply_to.as_deref(), Some(m.id.as_str()));
        // The lead reads the peer thread on demand.
        let thread = f
            .call(
                &lead,
                Request::RoomThread {
                    thread: m.thread.clone(),
                    project: None,
                },
            )
            .unwrap();
        assert_eq!(thread.len(), 2);
    }
    #[test]
    fn ask_answer_and_timeout_event() {
        let (mut f, lead, worker, _) = Fix::room("ask");
        let ask = f
            .call(
                &worker,
                Request::RoomSend {
                    to: None,
                    thread: None,
                    body: "which branch?".into(),
                    ask: true,
                    project: None,
                },
            )
            .unwrap()[0]
            .clone();
        let poll = |give_up| Request::RoomAnswer {
            ask: ask.id.clone(),
            give_up,
            project: None,
        };
        assert!(f.call(&worker, poll(false)).unwrap().is_empty());
        assert!(f.call(&lead, poll(false)).is_err(), "only the asker waits");
        // Look 1117 v12 B N11-S2-3: the asker reads as waiting for its answer while it polls, the other seat does not.
        assert_eq!(
            (f.core.asks_waiting(&worker), f.core.asks_waiting(&lead)),
            (true, false)
        );
        f.call(
            &lead,
            Request::RoomReply {
                message: ask.id.clone(),
                body: "main".into(),
                project: None,
            },
        )
        .unwrap();
        assert_eq!(f.call(&worker, poll(false)).unwrap()[0].body, "main");
        // The reply came back as output of the wait: no notice line for it.
        assert!(!f.rows(&worker).iter().any(|r| is_notice(r)));
        // A second ask that nobody answers: give_up logs the timeout event.
        let ask2 = f
            .call(
                &worker,
                Request::RoomSend {
                    to: Some(lead.clone()),
                    thread: None,
                    body: "still there?".into(),
                    ask: true,
                    project: None,
                },
            )
            .unwrap()[0]
            .clone();
        let gone = f
            .call(
                &worker,
                Request::RoomAnswer {
                    ask: ask2.id.clone(),
                    give_up: true,
                    project: None,
                },
            )
            .unwrap();
        assert!(gone.is_empty());
        let thread = f
            .call(
                &worker,
                Request::RoomThread {
                    thread: ask2.thread,
                    project: None,
                },
            )
            .unwrap();
        assert_eq!(thread.last().unwrap().kind, Kind::Timeout);
        assert_eq!(thread.last().unwrap().to, PERSON, "the person is told");
        assert_eq!(
            thread.last().unwrap().reply_to.as_deref(),
            Some(ask2.id.as_str())
        );
    }
    fn ask_to(f: &mut Fix, from: &str, to: &str, body: &str) -> Message {
        let request = Request::RoomSend {
            to: Some(to.into()),
            thread: None,
            body: body.into(),
            ask: true,
            project: None,
        };
        f.call(from, request).unwrap().remove(0)
    }
    fn timeouts(f: &mut Fix, seat: &str, ask: &Message) -> Vec<Message> {
        let request = Request::RoomThread {
            thread: ask.thread.clone(),
            project: None,
        };
        let all = f.call(seat, request).unwrap();
        all.into_iter()
            .filter(|m| m.kind == Kind::Timeout)
            .collect()
    }
    fn msg(
        n: usize,
        kind: Kind,
        from: &str,
        to: &str,
        thread: &str,
        reply_to: Option<&str>,
    ) -> Message {
        Message {
            id: format!("m{n}"),
            kind,
            from: from.into(),
            to: to.into(),
            thread: thread.into(),
            reply_to: reply_to.map(Into::into),
            body: format!("b{n}"),
            created_by: By::Agent,
            ts: 1000,
            team: None,
        }
    }
    // A room at its 10000-message cap, nearly every ask answered (by a reply, a plain message from the asked seat, a
    // timeout or `lost`): the scan finds the open ones, the same ones `open_ask` finds, in one pass over the log.
    #[test]
    fn the_timeout_scan_is_one_pass_and_agrees_with_open_ask() {
        let mut log = vec![];
        let mut n = 0;
        let mut add = |log: &mut Vec<Message>,
                       kind,
                       from: &str,
                       to: &str,
                       thread: &str,
                       reply: Option<&str>| {
            n += 1;
            log.push(msg(n, kind, from, to, thread, reply));
            format!("m{n}")
        };
        let mut open = vec![];
        for i in 0..2600 {
            let thread = format!("t{i}");
            let ask = add(&mut log, Kind::Ask, "w", "lead", &thread, None);
            match i % 5 {
                0 => {
                    add(&mut log, Kind::Reply, "lead", "w", &thread, Some(&ask));
                }
                1 => {
                    add(&mut log, Kind::Message, "lead", "w", &thread, None);
                }
                2 => {
                    add(&mut log, Kind::Timeout, "w", PERSON, &thread, Some(&ask));
                }
                3 => {
                    add(&mut log, Kind::Lost, "lead", "w", &thread, Some(&ask));
                }
                _ => open.push(ask), // nobody who was asked wrote: still open
            }
            // Filler that closes nothing: a message from a seat the ask did not go to.
            add(&mut log, Kind::Message, "rev", "w", &thread, None);
            add(&mut log, Kind::Message, "w", "rev", &thread, None);
        }
        assert!(log.len() >= 9800, "{}", log.len());
        OPEN_ASK_CALLS.with(|c| c.set(0));
        let late = late_asks(&log, 1000 + 5, 5);
        // Work, not time: each `open_ask` call is a pass over the whole log, and only the open asks may cost one.
        let passes = OPEN_ASK_CALLS.with(|c| c.get());
        let ids: Vec<_> = late.iter().map(|m| m.id.clone()).collect();
        let mut want = open.clone();
        want.sort_by_key(|id| id[1..].parse::<usize>().unwrap());
        assert_eq!(ids, want);
        // The rule itself, on a prefix (it is one pass per ask, so the whole room would take seconds).
        let head = &log[..600];
        let naive: Vec<_> = head
            .iter()
            .filter(|m| m.kind == Kind::Ask && open_ask(head, m))
            .map(|m| m.id.clone())
            .collect();
        let late_head: Vec<_> = late_asks(head, 1005, 5).into_iter().map(|m| m.id).collect();
        assert!(!naive.is_empty());
        assert_eq!(late_head, naive, "the one pass and the rule agree");
        assert_eq!(
            passes,
            open.len(),
            "a pass per open ask, none for the answered ones"
        );
        // Not yet due, to or from the person: skipped.
        assert!(late_asks(&log, 1000, 5).is_empty());
    }
    #[test]
    fn a_plain_ask_times_out_once_and_goes_to_the_person() {
        let (mut f, lead, worker, _) = Fix::room("ttl");
        f.core.room.ttl_ms = Some(400);
        let ask = ask_to(&mut f, &worker, &lead, "plain");
        f.core.room_notices();
        assert!(
            timeouts(&mut f, &worker, &ask).is_empty(),
            "not before its deadline"
        );
        std::thread::sleep(Duration::from_millis(450));
        f.core.room_notices();
        let t = timeouts(&mut f, &worker, &ask);
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(
            (t[0].from.as_str(), t[0].to.as_str()),
            (worker.as_str(), PERSON)
        );
        assert_eq!(t[0].reply_to.as_deref(), Some(ask.id.as_str()));
        // The asker is told by the usual notice, and its inbox holds the timeout.
        assert!(
            f.rows(&worker).iter().any(|r| is_notice(r)),
            "{:?}",
            f.rows(&worker)
        );
        assert_eq!(
            f.call(&worker, Request::RoomCheck { project: None })
                .unwrap()[0]
                .kind,
            Kind::Timeout
        );
        // Never twice: not on the next tick, and not after the core starts again (the log is the memory).
        std::thread::sleep(Duration::from_millis(450));
        f.core.room_notices();
        f.core.room = State::default();
        f.core.room.ttl_ms = Some(400);
        f.core.room_notices();
        assert_eq!(timeouts(&mut f, &worker, &ask).len(), 1);
    }
    #[test]
    fn an_answered_waited_or_person_ask_never_times_out_by_the_tick() {
        let (mut f, lead, worker, _) = Fix::room("ttl2");
        f.core.room.ttl_ms = Some(400);
        let answered = ask_to(&mut f, &worker, &lead, "one");
        let reply = Request::RoomReply {
            message: answered.id.clone(),
            body: "yes".into(),
            project: None,
        };
        f.call(&lead, reply).unwrap();
        let waited = ask_to(&mut f, &worker, &lead, "two");
        let to_person = ask_to(&mut f, &worker, PERSON, "three");
        // A live `ask --wait` polls: its own --timeout ends it, not the tick.
        let poll = Request::RoomAnswer {
            ask: waited.id.clone(),
            give_up: false,
            project: None,
        };
        std::thread::sleep(Duration::from_millis(450));
        f.call(&worker, poll).unwrap();
        f.core.room_notices();
        for ask in [&answered, &waited, &to_person] {
            assert!(timeouts(&mut f, &worker, ask).is_empty(), "{ask:?}");
        }
    }
    #[test]
    fn an_ended_seat_leaves_one_lost_event_per_open_ask() {
        let (mut f, lead, worker, _) = Fix::room("lost");
        let send = |to: Option<&str>, thread: &str, body: &str| Request::RoomSend {
            to: to.map(Into::into),
            thread: Some(thread.into()),
            body: body.into(),
            ask: true,
            project: None,
        };
        // Open: the worker asked its lead; the lead asked the worker. Answered: a second ask of the worker.
        let open_out = f.call(&worker, send(None, "t1", "which branch?")).unwrap()[0].clone();
        let open_in = f.call(&lead, send(Some(&worker), "t2", "status?")).unwrap()[0].clone();
        let done = f.call(&worker, send(None, "t3", "ok to merge?")).unwrap()[0].clone();
        f.call(
            &lead,
            Request::RoomReply {
                message: done.id.clone(),
                body: "yes".into(),
                project: None,
            },
        )
        .unwrap();
        f.core.room_lost();
        let seen = |f: &mut Fix, thread: &str| {
            f.call(
                &lead,
                Request::RoomThread {
                    thread: thread.into(),
                    project: None,
                },
            )
            .unwrap()
        };
        assert!(
            seen(&mut f, "t1").iter().all(|m| m.kind != Kind::Lost),
            "a running seat loses nothing"
        );
        // Ticket 594: the lead read everything and has no notice; the two lost events below bring one.
        f.call(&lead, Request::RoomCheck { project: None }).unwrap();
        let meta = &mut f.core.entries.get_mut(&lead).unwrap().meta;
        meta.send_queue.clear();
        meta.send_log.clear();
        f.core.entries.get_mut(&worker).unwrap().meta.state = SessionState::Exited;
        f.core.room_lost();
        f.core.room_lost(); // checked once per ending
        assert!(
            f.rows(&lead)
                .iter()
                .any(|r| r == &format!("2 {NOTICE_TAIL}")),
            "{:?}",
            f.rows(&lead)
        );
        let lost = |m: &Message| m.kind == Kind::Lost;
        let out = seen(&mut f, "t1");
        assert_eq!(out.iter().filter(|m| lost(m)).count(), 1);
        let event = out.iter().find(|m| lost(m)).unwrap();
        assert_eq!(
            (event.from.as_str(), event.to.as_str()),
            (worker.as_str(), lead.as_str())
        );
        assert_eq!(event.reply_to.as_deref(), Some(open_out.id.as_str()));
        // The ask sent to the ended seat tells its asker the same.
        let inb = seen(&mut f, "t2");
        let event = inb.iter().find(|m| lost(m)).unwrap();
        assert_eq!(
            (event.from.as_str(), event.to.as_str()),
            (worker.as_str(), lead.as_str())
        );
        assert_eq!(event.reply_to.as_deref(), Some(open_in.id.as_str()));
        // A replied ask is closed already.
        assert!(seen(&mut f, "t3").iter().all(|m| !lost(m)));
        // A closed seat's open ask is lost too (ticket 990): nobody can answer it any more.
        let (mut g, glead, gworker, _) = Fix::room("lost-closed");
        g.call(&gworker, send(None, "t1", "which branch?")).unwrap();
        g.core.entries.get_mut(&gworker).unwrap().meta.state = SessionState::Closed;
        g.core.room_lost();
        g.core.room_lost();
        let thread = g
            .call(
                &glead,
                Request::RoomThread {
                    thread: "t1".into(),
                    project: None,
                },
            )
            .unwrap();
        let lost: Vec<_> = thread.iter().filter(|m| m.kind == Kind::Lost).collect();
        assert_eq!(lost.len(), 1, "{thread:?}");
        assert!(lost[0].body.contains("closed"), "{}", lost[0].body);
    }
    #[test]
    fn an_answered_ask_is_not_lost_when_the_asker_ends() {
        let (mut f, lead, worker, _) = Fix::room("lost-answered");
        let send = |to: &str, thread: &str, ask: bool| Request::RoomSend {
            to: Some(to.into()),
            thread: Some(thread.into()),
            body: if ask { "ship it?" } else { "yes, ship it" }.into(),
            ask,
            project: None,
        };
        // Worker asks the person; the person answers with a plain message (the window composer has no reply_to).
        f.call(&worker, send(PERSON, "t1", true)).unwrap();
        let project = f.core.room_project(&worker).unwrap();
        Log::open(&f.home, &project)
            .add(Draft {
                kind: Kind::Message,
                from: PERSON.into(),
                to: worker.clone(),
                thread: Some("t1".into()),
                reply_to: None,
                body: "yes, ship it".into(),
                created_by: By::Person,
                peers: false,
            })
            .unwrap();
        // Worker asks the lead; the lead answers with `send`, not `reply`.
        f.call(&worker, send(&lead, "t2", true)).unwrap();
        f.call(&lead, send(&worker, "t2", false)).unwrap();
        // A third ask stays open.
        f.call(&worker, send(&lead, "t3", true)).unwrap();
        f.core.entries.get_mut(&worker).unwrap().meta.state = SessionState::Exited;
        f.core.room_lost();
        let lost = |f: &mut Fix, thread: &str| {
            f.call(
                &lead,
                Request::RoomThread {
                    thread: thread.into(),
                    project: None,
                },
            )
            .unwrap()
            .iter()
            .filter(|m| m.kind == Kind::Lost)
            .count()
        };
        assert_eq!(
            lost(&mut f, "t1"),
            0,
            "the person's plain message answered it"
        );
        assert_eq!(lost(&mut f, "t2"), 0, "the lead's plain send answered it");
        assert_eq!(lost(&mut f, "t3"), 1);
    }
    #[test]
    fn a_hand_edited_log_line_with_a_bad_id_does_not_panic_the_check() {
        let (mut f, lead, worker, _) = Fix::room("lost-badid");
        let send = |to: &str, thread: &str, ask: bool, body: &str| Request::RoomSend {
            to: Some(to.into()),
            thread: Some(thread.into()),
            body: body.into(),
            ask,
            project: None,
        };
        f.call(&worker, send(&lead, "t1", true, "which branch?"))
            .unwrap();
        f.call(&worker, send(&lead, "t2", true, "ok to merge?"))
            .unwrap();
        f.call(&lead, send(&worker, "t2", false, "yes")).unwrap();
        // Lines a person edited into the log: ids that are empty or start with a multi-byte character, from the lead in t1.
        let file = fs::read_dir(f.home.join("room"))
            .unwrap()
            .map(|e| e.unwrap().path().join("log.jsonl"))
            .find(|p| p.exists())
            .unwrap();
        let mut log = fs::read_to_string(&file).unwrap();
        for id in ["", "가1"] {
            log.push_str(&format!(
                "{}\n",
                json!({"id": id, "kind": "message", "from": lead, "to": worker, "thread": "t1",
                    "body": "edited", "created_by": "agent", "ts": 1})
            ));
        }
        fs::write(&file, log).unwrap();
        f.core.entries.get_mut(&worker).unwrap().meta.state = SessionState::Exited;
        f.core.room_lost(); // must not panic
        let lost = |f: &mut Fix, thread: &str| {
            f.call(
                &lead,
                Request::RoomThread {
                    thread: thread.into(),
                    project: None,
                },
            )
            .unwrap()
            .iter()
            .filter(|m| m.kind == Kind::Lost)
            .count()
        };
        assert_eq!(
            lost(&mut f, "t1"),
            1,
            "a line with a bad id answers nothing"
        );
        assert_eq!(lost(&mut f, "t2"), 0, "the other ask still works");
    }
    #[test]
    fn notice_reaches_terminal_body_does_not() {
        let (mut f, lead, worker, _) = Fix::room("notice");
        // One finished turn: the lead is at its prompt, so the queue writes into its terminal.
        f.core.queue.acp_turn(&lead, true).unwrap();
        f.core.queue.acp_turn(&lead, false).unwrap();
        let secret = "BODY-7f3a do not type";
        f.call(&worker, send(Some(&lead), None, secret)).unwrap();
        f.call(&worker, send(Some(&lead), None, "second")).unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        let screen = loop {
            f.core.tick().unwrap();
            let screen = f.core.entries[&lead].observer.screen.text();
            if (screen.contains(NOTICE_TAIL) || screen.contains(NOTICE_ONE))
                || Instant::now() > until
            {
                break screen;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            (screen.contains(NOTICE_TAIL) || screen.contains(NOTICE_ONE)),
            "{screen:?}"
        );
        assert!(!screen.contains("BODY-7f3a"), "{screen:?}");
        let rows = f.rows(&lead);
        assert!(rows.iter().all(|r| !r.contains("BODY-7f3a")), "{rows:?}");
        assert!(rows.iter().all(|r| is_notice(r)), "{rows:?}");
        assert!(f.rows(&worker).is_empty(), "the sender gets nothing");
    }
    #[test]
    fn notice_never_answers_a_blocked_seat() {
        let (mut f, lead, worker, _) = Fix::room("blocked");
        let item = f
            .core
            .queue
            .acp_ask(&lead, queue::Kind::Permission, "run rm".into())
            .unwrap();
        // A body that would be an answer if typed.
        f.call(&worker, send(Some(&lead), None, "1")).unwrap();
        f.core.tick().unwrap();
        assert!(f.rows(&lead).is_empty(), "nothing typed while blocked");
        assert!(
            f.core.queue.items().iter().any(|i| i.id == item),
            "still open"
        );
        // Once the prompt is gone the notice goes in.
        f.core.queue.remove(&item).unwrap();
        f.core.tick().unwrap();
        assert!(f.rows(&lead).iter().any(|r| r == &notice(1)));
    }
    #[test]
    fn queued_notice_is_updated_not_repeated() {
        let (mut f, lead, worker, _) = Fix::room("count");
        f.core.queue.acp_turn(&lead, true).unwrap(); // the lead is in a turn: the notice waits in its queue
        f.call(&worker, send(Some(&lead), None, "a")).unwrap();
        f.call(&worker, send(Some(&lead), None, "b")).unwrap();
        let queue = &f.core.entries[&lead].meta.send_queue;
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].content, format!("2 {NOTICE_TAIL}"));
        // The lead reads its inbox inside that turn: the queued notice has nothing new to say and goes.
        f.call(&lead, Request::RoomCheck { project: None }).unwrap();
        assert!(f.core.entries[&lead].meta.send_queue.is_empty());
        // Only the core's own form counts: a person's prompt that ends with the same words stays queued.
        assert!(is_notice(&format!("12 {NOTICE_TAIL}")));
        // Look 11-17 N30: one message is singular, and is still the core's notice.
        assert_eq!(notice(1), "1 new message: run nunchiro agent check");
        assert_eq!(notice(2), "2 new messages: run nunchiro agent check");
        assert!(is_notice(&notice(1)));
        assert!(!is_notice(&format!("tell them: 2 {NOTICE_TAIL}")));
        assert!(!is_notice(NOTICE_TAIL));
    }
    #[test]
    fn give_up_once_per_open_ask() {
        let (mut f, lead, worker, rev) = Fix::room("giveup");
        let ask = f
            .call(
                &worker,
                Request::RoomSend {
                    to: Some(lead.clone()),
                    thread: None,
                    body: "q".into(),
                    ask: true,
                    project: None,
                },
            )
            .unwrap()[0]
            .clone();
        let give_up = |who: &str, f: &mut Fix| {
            f.call(
                who,
                Request::RoomAnswer {
                    ask: ask.id.clone(),
                    give_up: true,
                    project: None,
                },
            )
        };
        assert!(give_up(&rev, &mut f).is_err(), "only the asker");
        assert!(give_up(&worker, &mut f).unwrap().is_empty());
        for _ in 0..5 {
            let err = give_up(&worker, &mut f).unwrap_err();
            assert!(err.contains("already timed out"), "{err}");
        }
        let log = Log::open(&f.home, &f.home.join("p"));
        assert_eq!(log.find(|m| m.kind == Kind::Timeout).unwrap().len(), 1);
        // The timeout goes to the person; the asker is told too, the asked seat keeps only the ask.
        assert_eq!(log.unread(&lead).unwrap(), 1);
        assert_eq!(log.unread(&worker).unwrap(), 1);
    }
    #[test]
    fn plain_thread_answer_ends_the_wait() {
        // Q9 tt-J7-1: the lead answers with `agent send --thread`, no `reply_to`; the asker's wait returns it.
        let (mut f, lead, worker, _) = Fix::room("plainanswer");
        let ask = f
            .call(
                &worker,
                Request::RoomSend {
                    to: Some(lead.clone()),
                    thread: None,
                    body: "which branch?".into(),
                    ask: true,
                    project: None,
                },
            )
            .unwrap()[0]
            .clone();
        let poll = |f: &mut Fix| {
            f.call(
                &worker,
                Request::RoomAnswer {
                    ask: ask.id.clone(),
                    give_up: false,
                    project: None,
                },
            )
            .unwrap()
        };
        assert!(poll(&mut f).is_empty());
        f.call(
            &lead,
            Request::RoomSend {
                to: Some(worker.clone()),
                thread: Some(ask.thread.clone()),
                body: "main".into(),
                ask: false,
                project: None,
            },
        )
        .unwrap();
        let answer = poll(&mut f);
        assert_eq!(answer.len(), 1);
        assert_eq!(answer[0].body, "main");
    }
    #[test]
    fn queued_notice_survives_sender_exit() {
        let (mut f, lead, worker, _) = Fix::room("senderexit");
        f.core.queue.acp_turn(&lead, true).unwrap(); // the lead is in a turn: the notice waits in its queue
        f.call(&worker, send(Some(&lead), None, "final report"))
            .unwrap();
        // The worker reports and ends before the lead's turn does.
        f.core
            .handle(Request::Close { id: worker.clone() })
            .unwrap();
        f.core.queue.acp_turn(&lead, false).unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            f.core.tick().unwrap();
            let meta = &f.core.entries[&lead].meta;
            let row = meta
                .send_log
                .iter()
                .chain(&meta.send_queue)
                .find(|s| is_notice(&s.content))
                .cloned()
                .unwrap();
            assert_ne!(row.status, "canceled", "dropped with its sender");
            if row.status != "queued" {
                assert_eq!(
                    row.sender, lead,
                    "the seat itself, never the message sender or `user`"
                );
                break;
            }
            assert!(Instant::now() < until, "never delivered");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    #[test]
    fn notice_never_submits_text_another_session_typed() {
        let (mut f, lead, worker, _) = Fix::room("slash");
        f.core.queue.acp_turn(&lead, true).unwrap();
        f.core.queue.acp_turn(&lead, false).unwrap(); // the lead is at its prompt
        // A session types a slash command into the Claude seat without submitting it (the legacy `agent send`).
        let caller = f.caller(&worker);
        f.core
            .handle_agent(
                &caller,
                Request::AgentSend {
                    id: lead.clone(),
                    text: "/danger ".into(),
                },
            )
            .unwrap();
        f.call(&worker, send(Some(&lead), None, "hello")).unwrap();
        for _ in 0..10 {
            f.core.tick().unwrap();
            std::thread::sleep(Duration::from_millis(30));
        }
        let meta = &f.core.entries[&lead].meta;
        let notice = meta
            .send_log
            .iter()
            .chain(&meta.send_queue)
            .find(|s| is_notice(&s.content))
            .unwrap();
        assert_eq!(
            notice.status, "failed",
            "the session gate refused the submit"
        );
        let screen = f.core.entries[&lead].observer.screen.text();
        assert!(
            !(screen.contains(NOTICE_TAIL) || screen.contains(NOTICE_ONE)),
            "{screen:?}"
        );
        assert_eq!(notice.sender, lead);
    }
    #[test]
    fn pair_cap_only_between_peers() {
        let (mut f, lead, worker, rev) = Fix::room("peers");
        // A lead and its own worker: 20 messages over several threads, never refused (each thread stays under 6).
        for i in 0..20 {
            let (from, to) = if i % 2 == 0 {
                (&lead, &worker)
            } else {
                (&worker, &lead)
            };
            let thread = format!("t{}", i / 5);
            f.call(from, send(Some(to), Some(&thread), &format!("m{i}")))
                .unwrap();
        }
        // Two peers (both started by the lead): 12 fresh sends, the 13th is refused.
        for i in 0..crate::room::PAIR_CAP {
            let (from, to) = if i % 2 == 0 {
                (&worker, &rev)
            } else {
                (&rev, &worker)
            };
            f.call(from, send(Some(to), None, &format!("p{i}")))
                .unwrap();
        }
        let err = f.call(&worker, send(Some(&rev), None, "p13")).unwrap_err();
        assert!(err.starts_with("round_cap"), "{err}");
    }
    #[test]
    fn scope_is_one_project() {
        let (mut f, lead, worker, _) = Fix::room("scope");
        let other = f.session("other", &f.home.join("q"), None);
        let err = f.call(&worker, send(Some(&other), None, "hi")).unwrap_err();
        assert_eq!(err, "outside this project's room");
        assert!(f.call(&other, send(Some(&lead), None, "hi")).is_err());
        assert!(f.call(&worker, send(Some("no-such"), None, "hi")).is_err());
        // Another project's room has its own ids: a reply by id never reaches across.
        let m = f.call(&worker, send(Some(&lead), None, "x")).unwrap()[0].clone();
        let reply = Request::RoomReply {
            message: m.id,
            body: "y".into(),
            project: None,
        };
        assert!(f.call(&other, reply).is_err());
    }
    #[test]
    fn guards_reach_the_api() {
        let (mut f, lead, worker, rev) = Fix::room("guards");
        assert!(
            f.call(&worker, send(Some(&lead), None, &"x".repeat(9000)))
                .is_err()
        );
        f.call(&worker, send(Some(&lead), Some("t"), "same"))
            .unwrap();
        let err = f
            .call(&worker, send(Some(&lead), Some("t"), "same"))
            .unwrap_err();
        assert!(err.starts_with("repeat dropped"), "{err}");
        for i in 0..5 {
            let (from, to) = if i % 2 == 0 {
                (&rev, &worker)
            } else {
                (&worker, &rev)
            };
            f.call(from, send(Some(to), Some("t"), &format!("r{i}")))
                .unwrap();
        }
        let err = f
            .call(&rev, send(Some(&worker), Some("t"), "more"))
            .unwrap_err();
        assert!(err.starts_with("round_cap"), "{err}");
    }

    /// A hook as `server::connection` serves a session's own hook within the bridge's budget: the question redirect
    /// first, else the normal path.
    fn hook(f: &mut Fix, id: &str, event: &str, payload: Value) -> Option<Value> {
        if let Some(d) = f.core.room_question(id, event, &payload) {
            assert!(crate::room::is_hook_output(event, &d), "{d}");
            return Some(d);
        }
        match f
            .core
            .handle(Request::Hook {
                id: id.into(),
                event: event.into(),
                payload,
            })
            .unwrap()
        {
            Reply::HookDecision { decision } => {
                let d = decision.unwrap();
                assert!(crate::room::is_hook_output(event, &d), "{d}");
                Some(d)
            }
            Reply::Ack => None,
            other => panic!("{other:?}"),
        }
    }
    fn question(tool: &str) -> Value {
        json!({
            "tool_name": tool,
            "tool_input": {"questions": [{"question": "Which port?", "options": [
                {"label": "8080", "description": "the default"}, {"label": "9090"}
            ]}]},
            // A payload cannot name the parent: none of these is read.
            "parent": "x", "to": "x", "session_id": "x", "agent_id": ""
        })
    }
    fn questions(f: &Fix, id: &str) -> usize {
        f.core
            .queue
            .items_of(id)
            .iter()
            .filter(|i| i.kind == crate::queue::Kind::Question)
            .count()
    }
    #[test]
    fn child_question_becomes_ask_to_its_parent() {
        let (mut f, lead, worker, rev) = Fix::room("hq");
        let mut forged = question("AskUserQuestion");
        for key in ["parent", "to", "session_id"] {
            forged[key] = rev.clone().into();
        }
        let d = hook(&mut f, &worker, "PreToolUse", forged).unwrap();
        assert_eq!(
            d["hookSpecificOutput"]["permissionDecisionReason"],
            "sent as ask m1 to your lead; end your turn, the answer arrives as a message"
        );
        let log = Log::open(&f.home, &f.home.join("p")).read().unwrap();
        assert_eq!(log.len(), 1);
        let ask = &log[0];
        assert_eq!(ask.thread, format!("q-{worker}"), "one thread per child");
        assert_eq!(
            (ask.kind, ask.from.as_str(), ask.to.as_str(), ask.created_by),
            (Kind::Ask, worker.as_str(), lead.as_str(), By::Agent),
            "the core's parent record, never the payload's names"
        );
        assert_eq!(ask.body, "Which port?\n  1. 8080: the default\n  2. 9090\n");
        assert_eq!(questions(&f, &worker), 0, "the person is not asked");
        assert!(
            f.rows(&lead)
                .iter()
                .any(|r| r == "1 new message: run nunchiro agent check")
        );
        // The lead's reply reaches the worker through the existing notice.
        let reply = Request::RoomReply {
            message: ask.id.clone(),
            body: "8080".into(),
            project: None,
        };
        f.call(&lead, reply).unwrap();
        assert!(f.rows(&worker).iter().any(|r| is_notice(r)));
    }
    #[test]
    fn question_without_live_parent_stays_with_the_person() {
        let (mut f, lead, worker, _) = Fix::room("hn");
        assert!(hook(&mut f, &lead, "PreToolUse", question("AskUserQuestion")).is_none());
        assert_eq!(questions(&f, &lead), 1, "no parent: today's question");
        // Another tool, or the other agent's tool name, is not a question of this session.
        assert!(hook(&mut f, &worker, "PreToolUse", question("Bash")).is_none());
        assert!(
            hook(
                &mut f,
                &worker,
                "PreToolUse",
                question("request_user_input")
            )
            .is_none()
        );
        // A parent that is a shell tab, or that is gone, cannot answer.
        f.core.entries.get_mut(&lead).unwrap().meta.kind = AgentKind::Shell;
        assert!(hook(&mut f, &worker, "PreToolUse", question("AskUserQuestion")).is_none());
        assert_eq!(
            questions(&f, &worker),
            1,
            "shell parent: the person answers"
        );
        f.core.entries.get_mut(&lead).unwrap().meta.kind = AgentKind::Claude;
        f.core.entries.get_mut(&lead).unwrap().agent_ended = true;
        assert!(hook(&mut f, &worker, "PreToolUse", question("AskUserQuestion")).is_none());
        assert!(
            Log::open(&f.home, &f.home.join("p"))
                .read()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn codex_child_request_user_input_becomes_ask() {
        let (mut f, lead, worker, _) = Fix::room("hc");
        f.core.entries.get_mut(&worker).unwrap().meta.kind = AgentKind::Codex;
        assert!(hook(&mut f, &worker, "PreToolUse", question("AskUserQuestion")).is_none());
        let d = hook(
            &mut f,
            &worker,
            "PreToolUse",
            question("request_user_input"),
        )
        .unwrap();
        assert_eq!(d["hookSpecificOutput"]["permissionDecision"], "deny");
        let log = Log::open(&f.home, &f.home.join("p")).read().unwrap();
        assert_eq!(
            (log[0].from.as_str(), log[0].to.as_str()),
            (worker.as_str(), lead.as_str())
        );
    }
    // Ticket 589, live Codex 0.161.0 with its default model: the question tool is `request_user_input_async`, whose
    // questions carry `title` and plain-string options; the classic `request_user_input` is not offered at all.
    #[test]
    fn codex_child_request_user_input_async_becomes_ask() {
        let (mut f, lead, worker, _) = Fix::room("ha");
        f.core.entries.get_mut(&worker).unwrap().meta.kind = AgentKind::Codex;
        let payload = json!({
            "tool_name": "request_user_input_async",
            "tool_input": {"questions": [{"title": "Which port?", "options": ["8080", "9090"]}]},
        });
        let d = hook(&mut f, &worker, "PreToolUse", payload).unwrap();
        assert_eq!(d["hookSpecificOutput"]["permissionDecision"], "deny");
        let log = Log::open(&f.home, &f.home.join("p")).read().unwrap();
        assert_eq!(log[0].to, lead);
        assert_eq!(log[0].body, "Which port?\n  1. 8080\n  2. 9090\n");
    }
    #[test]
    fn unread_messages_give_one_context_line_per_batch() {
        let (mut f, lead, worker, rev) = Fix::room("hp");
        let post = json!({"tool_name": "Bash", "agent_id": ""});
        assert!(
            hook(&mut f, &lead, "PostToolUse", post.clone()).is_none(),
            "none unread"
        );
        f.call(&worker, send(Some(&lead), None, "done")).unwrap();
        // A subagent's tool call gets nothing and leaves the batch for the main thread.
        let sub = json!({"tool_name": "Bash", "agent_id": "sub-1"});
        assert!(
            hook(&mut f, &lead, "PostToolUse", sub).is_none(),
            "subagent"
        );
        let line = |d: Option<Value>| d.unwrap()["hookSpecificOutput"]["additionalContext"].clone();
        assert_eq!(
            line(hook(&mut f, &lead, "PostToolUse", post.clone())),
            "1 new message: run nunchiro agent check"
        );
        assert!(
            hook(&mut f, &lead, "PostToolUse", post.clone()).is_none(),
            "same batch"
        );
        assert!(
            hook(&mut f, &lead, "PreToolUse", post.clone()).is_none(),
            "PostToolUse only"
        );
        f.call(&rev, send(Some(&lead), None, "found one")).unwrap();
        assert_eq!(
            line(hook(&mut f, &lead, "PostToolUse", post.clone())),
            "2 new messages: run nunchiro agent check"
        );
        f.call(&lead, Request::RoomCheck { project: None }).unwrap();
        assert!(
            hook(&mut f, &lead, "PostToolUse", post.clone()).is_none(),
            "all read"
        );
        // Claude only: Codex hears the PTY notice.
        f.call(&lead, send(Some(&worker), None, "go on")).unwrap();
        f.core.entries.get_mut(&worker).unwrap().meta.kind = AgentKind::Codex;
        assert!(hook(&mut f, &worker, "PostToolUse", post).is_none());
    }
    #[test]
    fn a_child_that_keeps_asking_meets_the_round_cap() {
        let (mut f, lead, worker, _) = Fix::room("hr");
        let ask = |f: &mut Fix, n: usize| {
            let mut q = question("AskUserQuestion");
            q["tool_input"]["questions"][0]["question"] = format!("question {n}").into();
            hook(f, &worker, "PreToolUse", q)
        };
        for n in 0..6 {
            assert!(ask(&mut f, n).is_some(), "ask {n}");
        }
        // The seventh agent message in the child's thread is refused: the person gets the question and a cap note.
        assert!(ask(&mut f, 6).is_none());
        assert_eq!(questions(&f, &worker), 1);
        let log = Log::open(&f.home, &f.home.join("p")).read().unwrap();
        assert!(log.iter().any(|m| m.kind == Kind::Cap && m.to == PERSON));
        assert!(
            log.iter()
                .filter(|m| m.kind == Kind::Ask)
                .all(|m| m.to == lead)
        );
    }

    /// Ticket 1002 lane 1 (Fable round 3 review M1): a locked seat's room line reaches the person and locked seats only.
    #[test]
    fn a_locked_seats_line_does_not_reach_an_unlocked_seat() {
        let (mut f, lead, worker, _) = Fix::room("lock-reach");
        f.core.entries.get_mut(&lead).unwrap().meta.home_lock = true;
        let refused = f
            .call(&lead, send(Some(&worker), None, "send it"))
            .unwrap_err();
        assert!(refused.contains("locked seats"), "{refused}");
        assert!(f.call(&lead, send(Some(PERSON), None, "for you")).is_ok());
        f.core.entries.get_mut(&worker).unwrap().meta.home_lock = true;
        assert!(
            f.call(&lead, send(Some(&worker), None, "now locked"))
                .is_ok()
        );
    }
}
