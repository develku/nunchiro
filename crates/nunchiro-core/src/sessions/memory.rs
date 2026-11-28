//! A bot's seat and its memory: `nunchiro memory` from the seat, and what its tool calls and its room tell about
//! outside content. The marks fail closed: a seat whose tool calls the core cannot see writes only proposals.
use super::*;
use crate::team::{Added, Source};

/// The owner's socket asks: memory is a bot seat's verb; the user changes it on the bot's Memory tab.
/// A marked seat's forget.
pub(super) const FORGET_MARKED: &str = "this conversation read outside content, so it cannot forget a memory line: ask the user to remove it on the Memory tab";
pub(super) const OWNER: &str =
    "memory is written from a bot's session; the user changes it on the bot's Memory tab";

impl Sessions {
    /// The bot whose live seat `session` is.
    fn bot_of(&self, session: &str) -> Option<String> {
        self.entries
            .get(session)
            .and_then(|e| e.meta.teammate.clone())
            .filter(|id| self.seat_of(id).as_deref() == Some(session))
    }
    /// The session and the runs it continues (a resume or an Undo gives a seat a new row).
    fn runs_of(&self, session: &str) -> Vec<String> {
        std::iter::once(session.to_string())
            .chain(
                self.entries
                    .get(session)
                    .into_iter()
                    .flat_map(|e| e.meta.resumed_from.iter().cloned()),
            )
            .collect()
    }
    /// What outside content this seat read. A seat whose tool calls do not reach the core (not Claude, started without
    /// hooks, or hooks turned off) counts as one that read another tool's results.
    pub(crate) fn read_outside(&self, session: &str) -> Option<Source> {
        let seen = self.entries.get(session).is_some_and(|e| {
            e.meta.kind == AgentKind::Claude
                && !e.meta.without_hooks
                && !self.settings.disable_hook_injection
        });
        let marked = crate::team::outside(&self.home, &self.runs_of(session));
        match seen {
            true => marked,
            false => marked.max(Some(Source::Tool)),
        }
    }

    pub(super) fn memory_op(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Response {
        let Request::BotMemory {
            operation,
            text,
            topic,
            user,
            from_user,
        } = request
        else {
            return Err("not a memory request".into());
        };
        let bot = self
            .bot_of(&caller.id)
            .ok_or("memory belongs to a bot: only a bot's seat reads or writes it")?;
        let team = crate::team::Team::open(&self.home);
        let memory = team.bot_memory(&bot)?;
        let now = queue::now_ms();
        let said = match operation.as_str() {
            "read" => memory.read(topic.as_deref())?,
            // Outside content could have asked for it: what the user's memory holds is the user's to remove then.
            "forget" if self.read_outside(&caller.id).is_some() => {
                return Err(FORGET_MARKED.into());
            }
            "forget" => format!("Forgotten everywhere: {}", memory.forget(text)?),
            "add" => {
                let from = self.read_outside(&caller.id).unwrap_or(if *from_user {
                    Source::You
                } else {
                    Source::Conversation
                });
                let added = match *user {
                    true => memory.add_user(text, from, now)?,
                    false => memory.add(text, from, topic.as_deref(), now)?,
                };
                match added {
                    Added::Kept => format!("Kept (from: {}).", from.words()),
                    Added::Known => "Already in memory; nothing changed.".into(),
                    Added::Proposed => format!(
                        "This conversation read {}, so the line waits for the user's look as a proposal.",
                        from.words()
                    ),
                    Added::NotKept => "Not kept: it reads like an instruction from outside content, and memory never keeps one.".into(),
                }
            }
            _ => return Err("usage: nunchiro memory add|forget|read".into()),
        };
        Ok(Reply::Text { text: said })
    }

    /// A tool call that reads outside content marks its session's conversation. A mark not written is an error, so the
    /// hook keeps its journal copy and the next core start marks it again (`persist`).
    pub(super) fn note_outside(
        &self,
        session: &str,
        event: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        if !matches!(event, "PreToolUse" | "PostToolUse") {
            return Ok(());
        }
        match crate::team::outside_of(
            payload["tool_name"].as_str().unwrap_or_default(),
            &payload["tool_input"],
        ) {
            Some(source) => crate::team::mark_outside(&self.home, session, source)
                .map_err(|e| format!("outside read not marked: {e}")),
            None => Ok(()),
        }
    }

    /// A marked session's words carry its mark, both ways: what it types into another session (or answers there) marks
    /// that session, and reading it (its screen, transcript or row) marks the reader.
    pub(crate) fn pass_outside(&self, caller: &str, request: &Request) {
        let (from, to) = match request {
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SendText { id, .. }
            | Request::SteerNow { id, .. }
            | Request::SendKeys { id, .. }
            | Request::AgentKeys { id, .. } => (caller.to_string(), id.clone()),
            Request::Answer { item, .. } => match self.queue.decision(item) {
                Ok(d) => (caller.to_string(), d.session_id),
                Err(_) => return,
            },
            Request::AgentRead { id, .. } | Request::AgentGet { id } => {
                (id.clone(), caller.to_string())
            }
            _ => return,
        };
        if let Some(source) = self.read_outside(&from)
            && let Err(e) = crate::team::mark_outside(&self.home, &to, source)
        {
            eprintln!("session {to}: outside read not passed on: {e}");
        }
    }

    /// `check_agent` for a read the core serves off its lock (a transcript): a marked seat's transcript marks its reader.
    pub(crate) fn check_reader(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        self.check_agent(caller, request)?;
        self.pass_outside(&caller.id, request);
        Ok(())
    }

    /// A seat read room messages (`agent check`, a thread, an answer): one from a marked seat marks it, and so does one
    /// from a seat the core cannot see.
    pub(super) fn hear(&self, seat: &str, messages: &[crate::room::Message]) {
        let source = messages
            .iter()
            .filter(|m| m.from != seat && m.created_by == crate::room::By::Agent)
            .filter_map(|m| self.read_outside(&m.from))
            .max();
        if let Some(source) = source
            && let Err(e) = crate::team::mark_outside(&self.home, seat, source)
        {
            eprintln!("session {seat}: room read not marked: {e}");
        }
    }
}

/// A Claude seat's deny rules for the files only the core writes: every bot's memory index and topic files, USER.md,
/// the core's memory records, and the SOUL.md of every bot whose first chat is over (the owner edits it on the Bots
/// page). Each rule has a twin that matches any case, as `folder_permissions`. None when the home's path holds a
/// character the rule syntax could read as a pattern.
pub(super) fn deny_memory(settings: &mut serde_json::Map<String, serde_json::Value>, home: &Path) {
    let Some(path) = home.to_str().filter(|h| {
        !h.chars()
            .any(|c| "*?[]{}()\\!".contains(c) || c.is_control())
    }) else {
        return;
    };
    let team = crate::team::Team::open(home);
    let souls = team
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| store::valid_id(&t.id) && team.first(&t.id).is_none())
        .map(|t| format!("team/{}/SOUL.md", t.id));
    let rules: Vec<serde_json::Value> = [
        "team/*/MEMORY.md",
        "team/*/memory/**",
        "team/USER.md",
        "memory-state/**",
    ]
    .map(String::from)
    .into_iter()
    .chain(souls)
    .flat_map(|p| [any_case(&p), p])
    .map(|p| serde_json::Value::String(format!("Edit(/{path}/{p})")))
    .collect();
    let permissions = settings
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(p) = permissions.as_object_mut() {
        let deny = p.entry("deny").or_insert_with(|| serde_json::json!([]));
        if let Some(list) = deny.as_array_mut() {
            list.extend(rules);
        }
    }
}
/// `team/x` as `[tT][eE][aA][mM]/[xX]`: a rule that matches the name in any case (a case-insensitive disk).
fn any_case(pattern: &str) -> String {
    pattern
        .chars()
        .map(|c| match c.is_ascii_alphabetic() {
            true => format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()),
            false => c.to_string(),
        })
        .collect()
}
