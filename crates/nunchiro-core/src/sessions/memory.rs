//! A bot's seat and its memory: `nunchiro memory` from the seat, and what its tool calls and its room tell about
//! outside content. The marks fail closed: a seat whose tool calls the core cannot see writes only proposals.
use super::*;
use crate::team::{Added, Source};

/// The owner's socket asks: memory is a bot seat's verb; the user changes it on the bot's Memory tab.
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

    /// A tool call that reads outside content marks its session's conversation.
    pub(super) fn note_outside(&self, session: &str, event: &str, payload: &serde_json::Value) {
        if !matches!(event, "PreToolUse" | "PostToolUse") {
            return;
        }
        if let Some(source) = crate::team::outside_of(
            payload["tool_name"].as_str().unwrap_or_default(),
            &payload["tool_input"],
        ) && let Err(e) = crate::team::mark_outside(&self.home, session, source)
        {
            eprintln!("session {session}: outside read not marked: {e}");
        }
    }

    /// A marked session's words carry its mark: what it types into another session, or says in its room, marks every
    /// session that hears it (the whole room: a message to one may be read by any).
    pub(super) fn pass_outside(&self, caller: &str, request: &Request) {
        let Some(source) = self.read_outside(caller) else {
            return;
        };
        let heard: Vec<String> = match request {
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SendText { id, .. }
            | Request::SteerNow { id, .. } => vec![id.clone()],
            Request::RoomSend { .. } | Request::RoomReply { .. } => {
                let room = self.entries.get(caller).map(|e| e.meta.project.clone());
                self.entries
                    .values()
                    .filter(|e| e.meta.id != caller && Some(&e.meta.project) == room.as_ref())
                    .map(|e| e.meta.id.clone())
                    .collect()
            }
            _ => return,
        };
        for id in heard {
            if let Err(e) = crate::team::mark_outside(&self.home, &id, source) {
                eprintln!("session {id}: outside read not passed on: {e}");
            }
        }
    }
}

/// A Claude seat's deny rules for the files only the core writes: every bot's memory index and topic files, USER.md
/// and the core's memory records. SOUL.md stays the bot's own to write. None when the home's path holds a character the
/// rule syntax could read as a pattern (as `folder_permissions`).
pub(super) fn deny_memory(settings: &mut serde_json::Map<String, serde_json::Value>, home: &Path) {
    let Some(home) = home.to_str().filter(|h| {
        !h.chars()
            .any(|c| "*?[]{}()\\!".contains(c) || c.is_control())
    }) else {
        return;
    };
    let rules = [
        "team/*/MEMORY.md",
        "team/*/memory/**",
        "team/USER.md",
        "memory-state/**",
    ]
    .map(|p| serde_json::Value::String(format!("Edit(/{home}/{p})")));
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
