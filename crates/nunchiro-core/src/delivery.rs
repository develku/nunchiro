//! Visible sends are recorded before delivery; interrupted sends are never replayed.
use crate::{api::AgentKind, queue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Send {
    pub id: String,
    pub sender: String,
    pub at: u64,
    #[serde(default)]
    pub completion_seq: u64,
    #[serde(default)]
    pub last_activity: u64,
    pub content: String,
    pub keys: Vec<String>,
    pub submit: bool,
    pub status: String,
    /// v1a-15: one of `SETTLE_MARKS` when the Enter went at the settle deadline or was dropped; absent
    /// otherwise, so every other row serializes as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle: Option<String>,
    /// Ticket 76: whether a non-user sender was forwarded from another machine when the send was queued; the flush
    /// reads this, not the lasting `grants.remote` set. Absent for `user`; absent on an agent row fails closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
}

/// The largest content of one send row; `validate` refuses a saved row above it, so the core would not load.
pub(crate) const SEND_LIMIT: usize = 65536;
pub fn check_text(_kind: AgentKind, text: &str) -> Result<(), String> {
    if text.len() > SEND_LIMIT
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("invalid send text".into());
    }
    Ok(())
}
pub fn ready(
    kind: AgentKind,
    attention: &queue::Attention,
    pending: &[queue::Decision],
    screen: &str,
) -> bool {
    !blocked(pending)
        && (kind == AgentKind::Shell
            || !attention.working
                && (attention.completion_seq > 0 || screen.lines().any(composer_mark)))
}
/// The input box's mark row: `❯` or `›` in the first column. Ticket 991 (C1): a dialog's cursor row is indented
/// (` ❯ No, exit` of Claude's folder trust) or leads a numbered option (`❯ 1. Yes`); read as the input box, a first
/// prompt was pasted into the dialog and marked failed.
fn composer_mark(line: &str) -> bool {
    line.starts_with(['❯', '›']) && crate::waiting::screen::choice_row(line).is_none()
}
/// v25-sendkeys: the refusal of a Ctrl+Enter on a kind with no running turn to interrupt (an ACP agent, a shell). The
/// prefix is the window's cue; the queue is untouched.
pub const NO_INTERRUPT: &str =
    "no_interrupt: this agent cannot take a message while it works; it stays queued";
/// v25-sendkeys: a send that failed after its bytes may have reached the agent (a partial PTY write). The prefix is the
/// window's cue that this is not a refusal: it keeps the text out of the box instead of retyping it.
pub const UNCERTAIN: &str = "uncertain: the send may have gone in; it is not retyped";
/// Ticket 286 item 1 (card C-20261106-03): composer text or Enter for a session whose agent ended. The shell it left
/// takes only the terminal's own keys. Nothing was written; the prefix is the window's cue.
pub const AGENT_ENDED: &str = "agent_ended: the agent has ended; type in the terminal";
/// Another session's line for a Claude input box that holds words or keys typed by hand. Nothing was written.
pub const EDITED: &str =
    "cannot verify edited Claude composer; token-less owner must submit a replacement";
pub(crate) const SEND_LOG_LIMIT: usize = 256;
/// v1a-15: `settle_timeout` (Enter written at the deadline) or why a pending Enter was dropped (row `failed`).
pub(crate) const SETTLE_MARKS: [&str; 6] = [
    "settle_timeout",
    "enter_dropped_blocked",
    "enter_dropped_switch",
    "enter_dropped_picker",
    "enter_dropped_working",
    "enter_dropped_composer",
];

/// Ticket 1094 r3: `mark` when every core loads it (`SETTLE_MARKS`). A saved row with any other mark made the next
/// start refuse the whole store, so every writer of `Send::settle` goes through here.
pub(crate) fn saved_mark(mark: &str) -> Option<String> {
    SETTLE_MARKS.contains(&mark).then(|| mark.into())
}

pub fn validate(log: &[Send]) -> Result<(), String> {
    if log.len() > SEND_LOG_LIMIT {
        return Err("send log limit exceeded".into());
    }
    validate_rows(log)
}
fn validate_rows(log: &[Send]) -> Result<(), String> {
    let mut ids = std::collections::BTreeSet::new();
    for send in log {
        if !crate::store::valid_id(&send.id)
            || !ids.insert(&send.id)
            || (send.sender != "user"
                && !crate::store::valid_id(&send.sender)
                && !widget_sender(&send.sender))
            || send.content.len() > SEND_LIMIT
            || send.keys.len() > 100
            || !matches!(
                send.status.as_str(),
                "queued" | "attempting" | "delivered" | "canceled" | "failed"
            )
            || (!send.content.is_empty() && !send.keys.is_empty())
            || (send.submit && !send.keys.is_empty())
            // v1a-15
            || send.settle.as_deref().is_some_and(|s| !SETTLE_MARKS.contains(&s))
        {
            return Err("invalid send log relationship".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_queue(queue: &[Send], log: &[Send]) -> Result<(), String> {
    validate_rows(queue)?;
    let ids: std::collections::BTreeSet<_> = log.iter().map(|s| &s.id).collect();
    if queue
        .iter()
        .any(|s| !matches!(s.status.as_str(), "queued" | "attempting") || ids.contains(&s.id))
    {
        return Err("invalid send queue relationship".into());
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(crate) struct Input {
    line: Option<String>,
    typed: String,
    uncertain: bool,
}
impl Input {
    pub fn prepare(&self, screen: &str, send: &Send, restricted: bool) -> Result<Self, String> {
        let mut input = self.clone();
        let mut composer = screen.lines().rev().find_map(|line| {
            line.trim_start()
                .strip_prefix('❯')
                .or_else(|| line.trim_start().strip_prefix('›'))
                .map(str::to_string)
        });
        if input.line.is_none() {
            input.line = Some(composer.clone().unwrap_or_default());
        }
        for c in send.content.chars() {
            if c == '\n' {
                input.submit(composer.as_deref(), restricted)?;
                composer = Some(String::new());
            } else {
                if c == '\t' {
                    input.uncertain = true;
                }
                input.line.get_or_insert_default().push(c);
                input.typed.push(c);
                if let Some(line) = &mut composer {
                    line.push(c);
                }
            }
        }
        for key in &send.keys {
            match key.to_ascii_lowercase().as_str() {
                "enter" => {
                    input.submit(composer.as_deref(), restricted)?;
                    composer = Some(String::new());
                }
                "esc" | "escape" | "ctrl+c" => {
                    if input.uncertain
                        || !input.typed.is_empty()
                        || input
                            .line
                            .as_ref()
                            .is_some_and(|line| !line.trim().is_empty())
                    {
                        input.uncertain = true;
                    }
                    composer = None;
                }
                "backspace" => {
                    if input.typed.pop().is_none() && composer.is_none() {
                        input.uncertain = true;
                    }
                    input.line.get_or_insert_default().pop();
                    if let Some(line) = &mut composer {
                        line.pop();
                    }
                }
                // Claude's mode cycle (sent alone, by the user only: `check_key`) changes no word in the box.
                "shift+tab" => {}
                _ => input.uncertain = true,
            }
        }
        if input.typed.len() > 65536 || input.line.as_ref().is_some_and(|line| line.len() > 65536) {
            return Err("composed input exceeds 64 KiB".into());
        }
        if send.submit {
            input.submit(composer.as_deref(), restricted)?;
        }
        Ok(input)
    }
    /// Text or keys went to the agent's input box and no Enter followed (as far as the core can tell).
    pub fn pending(&self) -> bool {
        self.uncertain || !self.typed.is_empty()
    }
    pub fn mark_uncertain(&mut self) {
        self.uncertain = true;
    }
    /// The box holds words or keys typed by hand: another session's line is refused there (`EDITED`) until the user's
    /// next Enter.
    pub fn edited(&self) -> bool {
        self.uncertain
    }
    fn submit(&mut self, composer: Option<&str>, restricted: bool) -> Result<(), String> {
        if restricted {
            if self.uncertain {
                return Err(EDITED.into());
            }
            for line in [self.line.as_deref(), Some(self.typed.as_str()), composer]
                .into_iter()
                .flatten()
            {
                let normalized: String = line
                    .chars()
                    .filter(|c| shown(*c) || c.is_whitespace()) // v1b-21 r3
                    .flat_map(char::to_lowercase)
                    .collect();
                let normalized = normalized.trim();
                if normalized.starts_with('/')
                    && !matches!(
                        normalized.split_whitespace().next(),
                        Some("/clear" | "/new" | "/compact")
                    )
                {
                    return Err("Claude slash command refused: only /clear and /compact may be submitted by a session token".into());
                }
            }
        }
        *self = Self::default();
        Ok(())
    }
}
// v1b-20: a script widget's act, logged as `widget:<name>` (widget name syntax).
pub(crate) fn widget_sender(sender: &str) -> bool {
    sender
        .strip_prefix("widget:")
        .is_some_and(crate::approval::valid_name)
}
// v1b-21 r3 (ruling: allowlist after four denylist leaks): a character is shown when its General Category is L*, M*,
// N*, P*, S* or Zs and it is not Default_Ignorable, nor a blank that draws nothing (U+2800 braille blank; v1b-31:
// U+16FE4 Khitan filler, U+1D159 null notehead). Everything else (Cc, Cf, Co, Cn, Zl, Zp, every Default_Ignorable
// such as tag characters, variation selectors, Hangul fillers) draws nothing or moves text, so a check that must see
// what the user sees treats it as hidden. Tables: regex-syntax's Unicode 16.0 data (regenerated with each
// regex-syntax release; `cargo update -p regex-syntax` picks up a newer Unicode).
pub fn shown(c: char) -> bool {
    static TABLE: std::sync::OnceLock<Vec<(char, char)>> = std::sync::OnceLock::new();
    in_class(
        &TABLE,
        r"[[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]--[\p{Default_Ignorable_Code_Point}\x{2800}\x{16FE4}\x{1D159}]]",
        c,
    )
}
/// v1b-31: a combining mark (General Category M*), drawn on the character before it.
pub(crate) fn mark(c: char) -> bool {
    static TABLE: std::sync::OnceLock<Vec<(char, char)>> = std::sync::OnceLock::new();
    in_class(&TABLE, r"\p{M}", c)
}
fn in_class(table: &std::sync::OnceLock<Vec<(char, char)>>, class: &str, c: char) -> bool {
    let table = table.get_or_init(|| {
        use regex_syntax::hir::{Class, HirKind};
        let hir = regex_syntax::Parser::new()
            .parse(class)
            .expect("static class");
        match hir.kind() {
            HirKind::Class(Class::Unicode(class)) => class
                .ranges()
                .iter()
                .map(|r| (r.start(), r.end()))
                .collect(),
            _ => unreachable!("a Unicode class"),
        }
    });
    let i = table.partition_point(|(_, end)| *end < c);
    table.get(i).is_some_and(|(start, _)| *start <= c)
}

pub fn blocked(pending: &[queue::Decision]) -> bool {
    pending.iter().any(|p| {
        matches!(
            p.kind,
            queue::Kind::Dialog | queue::Kind::Permission | queue::Kind::Question
        )
    })
}

pub(crate) struct TranscriptRead {
    pub session: crate::api::Session,
    pub path: Option<std::path::PathBuf>,
    pub lines: usize,
}
impl TranscriptRead {
    pub fn read(&self) -> crate::api::Response {
        use std::os::unix::fs::MetadataExt;
        let path = self.path.as_ref().ok_or("transcript source unavailable")?;
        let unavailable = |e: String| format!("transcript source unavailable: {e}");
        let path =
            crate::waiting::transcript::validate_path(&self.session, path).map_err(unavailable)?;
        let meta = std::fs::metadata(&path).map_err(|e| unavailable(e.to_string()))?;
        let key = format!("{}:{}:{}", path.display(), meta.dev(), meta.ino());
        let batch = crate::waiting::transcript::read_batch(
            &path,
            &key,
            meta.len().saturating_sub(1024 * 1024),
            false,
        )
        .map_err(unavailable)?
        .ok_or("transcript source unavailable")?;
        let records = batch
            .records
            .iter()
            .map(|record| serde_json::to_string(record).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(crate::api::Reply::Text {
            text: records[records.len().saturating_sub(self.lines)..].join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Ticket 991 (C1): Claude's folder-trust question has a cursor row (` ❯ No, exit`); read as the input box, a
    /// teammate's brief was pasted into the question and marked failed.
    #[test]
    fn a_dialog_cursor_row_is_not_the_input_box() {
        let idle = queue::Attention::default();
        let ready = |screen: &str| ready(AgentKind::Claude, &idle, &[], screen);
        assert!(ready("────\n❯\u{a0}Try \"write a test\"\n────\n"));
        assert!(ready("› Ask Codex to do anything\n"));
        assert!(!ready(
            " Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n"
        ));
        assert!(!ready(
            "Switch model?\n❯ 1. Yes, switch to Sonnet\n  2. No\n"
        ));
    }
    // v1b-21 r3: a session token's slash command is found behind any character the allowlist does not show.
    #[test]
    fn restricted_slash_command_found_behind_hidden_characters() {
        for hidden in [
            '\u{E0000}',
            '\u{E0080}',
            '\u{FFF0}',
            '\u{200B}',
            '\u{3164}',
            '\u{E000}',
        ] {
            let mut input = Input {
                typed: format!("{hidden}/model opus"),
                ..Input::default()
            };
            assert!(
                input
                    .submit(None, true)
                    .unwrap_err()
                    .contains("slash command"),
                "U+{:04X}",
                hidden as u32
            );
        }
        let mut input = Input {
            typed: "/compact".into(),
            ..Input::default()
        };
        input.submit(None, true).unwrap();
        assert!(shown('한') && shown('é') && !shown('\u{FE0F}') && !shown('\u{0378}'));
    }
}
