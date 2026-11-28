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
    /// Whether an agent's or a token's room send or reply would be taken, without writing it: the same seat, project
    /// and reach rules as `room`, so a plugin's check never sees the text of a message that is then refused.
    pub(crate) fn room_may(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        let project = match request {
            Request::RoomSend { project, .. } | Request::RoomReply { project, .. } => {
                project.clone()
            }
            _ => return Ok(()),
        };
        let (seat, project) = if super::tokens::is_token(caller) {
            let project = project.ok_or("a token names the room with --project")?;
            (
                caller.id.clone(),
                fs::canonicalize(project).map_err(|e| e.to_string())?,
            )
        } else {
            (
                caller.id.clone(),
                self.room_project(&caller.id).ok_or("session not found")?,
            )
        };
        match request {
            Request::RoomSend { to, .. } => {
                let to = match to {
                    Some(to) => to.clone(),
                    None => self.room_lead(&seat, &project),
                };
                if to != PERSON && self.room_project(&to).as_deref() != Some(&project) {
                    return Err("outside this project's room".into());
                }
                self.locked_reach(&seat, &to)
            }
            Request::RoomReply { message, .. } => {
                let original = Log::open(&self.home, &project)
                    .find(|m| m.id == *message)?
                    .pop()
                    .ok_or("message not found in this room")?;
                if original.to != seat {
                    return Err("only the seat a message went to replies to it".into());
                }
                self.locked_reach(&seat, &original.from)
            }
            _ => Ok(()),
        }
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
        // A plugin's check changed this send or reply's words (server.rs, `plugins::check_request`): the message
        // names the plugin.
        let changed = match &request {
            Request::RoomSend { to, body, .. } => {
                crate::plugins::take_replaced(&seat, to.as_deref().unwrap_or("room"), body)
            }
            Request::RoomReply { message, body, .. } => {
                crate::plugins::take_replaced(&seat, message, body)
            }
            _ => None,
        };
        let log = Log::open(&self.home, &project).changed_by(changed.map(|r| r.plugin));
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
                delivery: log.delivery(ROOM_READ_MAX, |seat, send| self.waits(seat, send))?,
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
                    // Ticket 1089: the answer reached the asker as its `--wait` output.
                    if reply.to == seat {
                        log.reached(std::slice::from_ref(&reply.id))?;
                    }
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
        if let Some(c) = caller {
            self.hear(&c.id, &messages);
        }
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
    /// Ticket 1089: whether a typed line's send row still waits in `seat`'s queue.
    fn waits(&self, seat: &str, send: &str) -> bool {
        self.entries
            .get(seat)
            .is_some_and(|e| e.meta.send_queue.iter().any(|s| s.id == send))
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
mod tests;
