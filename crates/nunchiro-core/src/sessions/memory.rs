//! A bot's seat and its memory: `nunchiro memory` from the seat, and what its tool calls tell about outside content.
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
                let from = memory.outside(&caller.id).unwrap_or(if *from_user {
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

    /// A seat's tool call that reads outside content marks its conversation, so its memory writes become proposals.
    pub(super) fn note_outside(&self, session: &str, event: &str, payload: &serde_json::Value) {
        if !matches!(event, "PreToolUse" | "PostToolUse") {
            return;
        }
        let Some(source) = crate::team::outside_of(
            payload["tool_name"].as_str().unwrap_or_default(),
            &payload["tool_input"],
        ) else {
            return;
        };
        let Some(bot) = self.bot_of(session) else {
            return;
        };
        let marked = crate::team::Team::open(&self.home)
            .bot_memory(&bot)
            .and_then(|m| m.mark_outside(session, source));
        if let Err(e) = marked {
            eprintln!("seat {session}: outside read not marked: {e}");
        }
    }
}
