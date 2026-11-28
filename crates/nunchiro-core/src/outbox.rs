//! Ticket 1002 lane 2: the Outbox card's rules. The Home lead stages one outward tool call (the exact tool name and
//! arguments it will make, the tool named with its server: a mail `send_message`, a calendar `create_event`) as an owner card
//! (`queue::OwnerAsk::Outward`). Only arguments the card shows are accepted, so what the user approves is the whole
//! call. A yes (after a 10 s undo) lets that one call through once, within 10 minutes (`Request::OutboxSpend`); the
//! card's second button opens a new message (`mailto`) or event (`.ics`) from the same arguments instead.
use serde_json::Value;

/// The most body characters a card takes: percent-encoded, a longer mailto URL may be cut by its handler without a word.
/// Refused at stage time, never cut.
pub const BODY_MAX: usize = 8000;
pub const SUBJECT_MAX: usize = 300;
pub const SOURCE_MAX: usize = 200;
/// Recipients (to, cc, bcc) on one card.
pub const RECIPIENTS_MAX: usize = 50;
/// Outward cards waiting at once, so the 64 owner items keep room for merge, goal and schedule cards.
pub const CARDS_MAX: usize = 20;
/// An unanswered card expires as No.
pub const EXPIRE_MS: u64 = 24 * 60 * 60 * 1000;
/// After the user's yes, the card can be undone for this long; then it is approved to spend.
pub const UNDO_MS: u64 = 10_000;
/// An approved card is spent once within this long, or it lapses as No.
pub const SPEND_MS: u64 = 10 * 60 * 1000;
/// The recipient domains the user said yes to that the core keeps (oldest dropped first).
pub const DOMAINS_MAX: usize = 64;

/// What a card's call does, read from its arguments: who it reaches and what it says.
#[derive(Debug, Default, PartialEq)]
pub struct Shown {
    /// "mail" or "event".
    pub kind: &'static str,
    /// The tool's own name after its server prefix (`send_message`, `create_event`).
    pub op: String,
    /// The recipients (to, then cc and bcc), lowercased.
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// An event's `startTime` and `endTime`, as given.
    pub start: String,
    pub end: String,
}
impl Shown {
    pub fn recipients(&self) -> impl Iterator<Item = &String> {
        self.to.iter().chain(&self.cc).chain(&self.bcc)
    }
}

/// The tool's name after its server prefix (`mcp__gmail__send_message` is `send_message`).
pub fn op(tool: &str) -> &str {
    tool.rsplit_once("__").map_or(tool, |(_, op)| op)
}

/// One line of visible text: no control or hidden characters (they reorder or hide what the user reads). Refused, never
/// cleaned: the stored call must be the call the seat makes.
fn one_line(key: &str, v: &Value, max: usize) -> Result<String, String> {
    let s = v.as_str().ok_or_else(|| format!("`{key}` must be text"))?;
    if s.chars()
        .any(|c| c.is_control() || crate::board::rights::hidden(c))
    {
        return Err(format!("`{key}` has control or hidden characters"));
    }
    if s.chars().count() > max {
        return Err(format!("`{key}` is longer than {max} characters"));
    }
    Ok(s.to_string())
}

/// A body: newlines and tabs allowed, no other control or hidden character, at most `BODY_MAX` characters.
fn body_text(key: &str, v: &Value) -> Result<String, String> {
    let s = v.as_str().ok_or_else(|| format!("`{key}` must be text"))?;
    if s.chars().any(|c| {
        (c.is_control() && c != '\n' && c != '\t' && c != '\r') || crate::board::rights::hidden(c)
    }) {
        return Err(format!("`{key}` has control or hidden characters"));
    }
    let n = s.chars().count();
    if n > BODY_MAX {
        return Err(format!(
            "`{key}` has {n} characters; an Outbox card takes at most {BODY_MAX} (a mail app could cut a longer one): shorten it"
        ));
    }
    Ok(s.to_string())
}

fn addresses(key: &str, v: &Value) -> Result<Vec<String>, String> {
    let list = v
        .as_array()
        .ok_or_else(|| format!("`{key}` must be a list of addresses"))?;
    list.iter()
        .map(|a| {
            let a = a
                .as_str()
                .ok_or_else(|| format!("`{key}` must be a list of addresses"))?;
            if a.contains('<') {
                return Err(format!("`{key}`: {a:?} is not a plain address"));
            }
            address(a)
        })
        .collect()
}

/// Checks a staged call: the tool is one the Outbox knows, named in full with its server; every argument is one the
/// card shows (an allow list: anything else is refused, so no recipient or content can ride in unseen); each value is
/// well formed. Returns what the card shows.
pub fn check(tool: &str, args: &Value) -> Result<Shown, String> {
    if tool == COMMAND {
        return check_command(args);
    }
    // The full name with its server (`mcp__<server>__<tool>`): the hash and the hook's gate are about that exact tool.
    let server = tool
        .strip_prefix("mcp__")
        .and_then(|rest| rest.rsplit_once("__"))
        .map(|(server, _)| server);
    if tool.len() > 200
        || server.is_none_or(str::is_empty)
        || !tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "{tool:?} is not a full MCP tool name (mcp__<server>__<tool>)"
        ));
    }
    let map = args
        .as_object()
        .ok_or("the arguments must be one JSON object")?;
    let op = op(tool).to_string();
    // Only calls whose whole effect is in their arguments: a reply or forward takes a message id, and Gmail then picks
    // recipients and content the card never showed (check M7a). A reply is a send_message with its replyThreadId.
    let (kind, allowed): (&'static str, &[&str]) = match op.as_str() {
        "send_message" => (
            "mail",
            &["to", "cc", "bcc", "subject", "body", "replyThreadId"],
        ),
        "create_event" => (
            "event",
            &[
                "summary",
                "startTime",
                "endTime",
                "description",
                "location",
                "timeZone",
                "calendarId",
            ],
        ),
        _ => {
            return Err(format!(
                "{tool} is not an Outbox call: only a mail's send_message (a reply too, with its replyThreadId) and a calendar's create_event"
            ));
        }
    };
    let mut shown = Shown {
        kind,
        op: op.clone(),
        ..Shown::default()
    };
    for (key, v) in map {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "`{key}` is not shown on an Outbox card, so it cannot be staged (allowed for {op}: {})",
                allowed.join(", ")
            ));
        }
        match key.as_str() {
            "to" => shown.to = addresses(key, v)?,
            "cc" => shown.cc = addresses(key, v)?,
            "bcc" => shown.bcc = addresses(key, v)?,
            "subject" | "summary" => shown.subject = one_line(key, v, SUBJECT_MAX)?,
            "body" | "description" => shown.body = body_text(key, v)?,
            "startTime" | "endTime" => {
                let at = one_line(key, v, 40)?;
                event_time(&at)?;
                *if key == "startTime" {
                    &mut shown.start
                } else {
                    &mut shown.end
                } = at;
            }
            // Another calendar than the user's own is not one the card can name.
            "calendarId" if v != "primary" => {
                return Err(
                    "`calendarId` other than \"primary\" is not shown on an Outbox card".into(),
                );
            }
            "calendarId" => {}
            _ => {
                one_line(key, v, 300)?;
            }
        }
    }
    let need = |key: &str| {
        map.contains_key(key)
            .then_some(())
            .ok_or_else(|| format!("{op} needs `{key}`"))
    };
    if kind == "mail" {
        need("subject")?;
        if shown.to.is_empty() {
            return Err(format!("{op} needs `to`"));
        }
    } else {
        need("summary")?;
        need("startTime")?;
        need("endTime")?;
        if event_time(&shown.end)? <= event_time(&shown.start)? {
            return Err("the event ends before it starts".into());
        }
    }
    if shown.recipients().count() > RECIPIENTS_MAX {
        return Err(format!(
            "an Outbox card reaches at most {RECIPIENTS_MAX} recipients"
        ));
    }
    Ok(shown)
}

/// A command card's tool: the seat runs its line with Claude's Bash tool, once, after the owner's yes.
pub const COMMAND: &str = "Bash";
/// The longest line, and the most words, a command card takes.
const LINE_MAX: usize = 2000;
const WORDS_MAX: usize = 32;

/// The largest file a command card reads (the program and each file it names), checked before any read.
pub const FILE_MAX: u64 = 32 * 1024;

/// A command card's line: one space between plain words (letters, digits and `._/-+,:@%=`), so the shell runs exactly
/// the words the card shows: no quote, glob, `~`, `$`, redirect, separator or line break. Every word is a full path
/// (`bound` then requires a regular file): a bare word could name more code the card does not bind (a launcher's
/// `python3 -m mod`, `sh -c name`, `make target`), and zsh reads a word that starts with `=` as a PATH lookup.
pub fn command_words(line: &str) -> Result<Vec<&str>, String> {
    let words: Vec<&str> = line.split(' ').collect();
    if line.len() > LINE_MAX || words.len() > WORDS_MAX {
        return Err(format!(
            "a command card takes one line of at most {WORDS_MAX} words and {LINE_MAX} characters"
        ));
    }
    if words.iter().any(|w| {
        w.is_empty()
            || !w
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-+,:@%=".contains(&b))
    }) {
        return Err("a command card's line is plain words with one space between: letters, digits and ._/-+,:@%= only (no quotes, globs, ~, $, redirects or separators); put text in a file the command reads".into());
    }
    if words.iter().any(|w| !w.starts_with('/')) {
        return Err("a command card is a program and the files it uses, each named by its full path (/...): no other word, so put recipients and text in a file".into());
    }
    Ok(words)
}

/// The call a card binds and the seat's hook checks: an MCP call's arguments as they are; a command's line with every
/// file it names (`command_words`), read now. Each is a regular file of at most `FILE_MAX` bytes (the size is checked
/// before the read), bound by its hash and its whole text, which must be UTF-8: the program too, so a binary program
/// (code the card cannot show) is refused. The card shows every text. A file that changes after the owner's yes makes
/// another call, which the card does not allow.
pub fn bound(tool: &str, args: &Value) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    if tool != COMMAND {
        return Ok(args.clone());
    }
    let line = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or("a command card needs `command`")?;
    let words = command_words(line)?;
    let mut files = vec![];
    for word in &words {
        let meta = std::fs::metadata(word).map_err(|e| format!("{word}: {e}"))?;
        if !meta.is_file() {
            return Err(format!(
                "{word} is not a regular file: a command card names the program and the files it uses"
            ));
        }
        if meta.len() > FILE_MAX {
            return Err(format!(
                "{word} is larger than {} KB, more than a card shows",
                FILE_MAX / 1024
            ));
        }
        let mut bytes = vec![];
        std::io::Read::read_to_end(
            &mut std::io::Read::take(
                std::fs::File::open(word).map_err(|e| format!("{word}: {e}"))?,
                FILE_MAX + 1,
            ),
            &mut bytes,
        )
        .map_err(|e| format!("{word}: {e}"))?;
        if bytes.len() as u64 > FILE_MAX {
            return Err(format!("{word} grew while it was read"));
        }
        let mut file = serde_json::json!({"path": word, "sha256": hex(&Sha256::digest(&bytes))});
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{word} is not text, so the card cannot show it"))?;
        file["text"] = file_text(word, text)?.into();
        files.push(file);
    }
    Ok(serde_json::json!({"command": line, "files": files}))
}

/// A file's text as a card shows it: newlines and tabs, no other control or hidden character (refused, never cleaned).
fn file_text(word: &str, text: String) -> Result<String, String> {
    if text.chars().any(|c| {
        (c.is_control() && !matches!(c, '\n' | '\t' | '\r')) || crate::board::rights::hidden(c)
    }) {
        return Err(format!("{word} has control or hidden characters"));
    }
    Ok(text)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `check` for a command card (`bound`'s form; `files` is the core's own reading).
fn check_command(args: &Value) -> Result<Shown, String> {
    let map = args
        .as_object()
        .ok_or("the arguments must be one JSON object")?;
    if let Some(key) = map
        .keys()
        .find(|k| !["command", "files"].contains(&k.as_str()))
    {
        return Err(format!(
            "`{key}` is not shown on an Outbox card (a command card takes `command`)"
        ));
    }
    let line = map
        .get("command")
        .and_then(Value::as_str)
        .ok_or("a command card needs `command`")?;
    command_words(line)?;
    let body = map
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| Some(format!("{}\n{}", f["path"].as_str()?, f["text"].as_str()?)))
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(Shown {
        kind: "command",
        op: "command".into(),
        subject: line.into(),
        body,
        ..Shown::default()
    })
}

pub fn address(to: &str) -> Result<String, String> {
    let bad = || format!("{to:?} is not one mail address");
    if to
        .chars()
        .any(|c| c.is_control() || ",;?&\"\\%".contains(c))
    {
        return Err(bad());
    }
    // Fable lane 2 review S1: no trim, so a space around the address is refused and never hides the New recipient tag.
    let addr = match to.split_once('<') {
        None => to,
        Some((name, rest)) => {
            let addr = rest.strip_suffix('>').ok_or_else(bad)?;
            if name.contains('>') || addr.contains('<') || addr.contains('>') {
                return Err(bad());
            }
            addr
        }
    };
    let (local, domain) = addr.split_once('@').ok_or_else(bad)?;
    let ok_local = !local.is_empty()
        && local.len() <= 64
        && local
            .bytes()
            .all(|b| b.is_ascii_graphic() && !b"()<>[]:@".contains(&b));
    let ok_domain = domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|p| {
            !p.is_empty()
                && !p.starts_with('-')
                && !p.ends_with('-')
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !ok_local || !ok_domain {
        return Err(bad());
    }
    Ok(addr.to_ascii_lowercase())
}

/// The domain of an address `address` accepted.
pub fn domain(addr: &str) -> &str {
    addr.rsplit_once('@').map_or("", |(_, d)| d)
}

/// RFC 3986 percent-encoding of everything but the unreserved characters.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// RFC 6068: a new message with these recipients (each from `address`), subject and body; a line break is `%0D%0A`.
pub fn mailto(s: &Shown) -> String {
    let list = |l: &[String]| {
        l.iter()
            .map(|a| {
                let (local, domain) = a.split_once('@').unwrap_or((a, ""));
                format!("{}@{}", encode(local), encode(domain))
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut url = format!("mailto:{}?subject={}", list(&s.to), encode(&s.subject));
    for (key, l) in [("cc", &s.cc), ("bcc", &s.bcc)] {
        if !l.is_empty() {
            url += &format!("&{key}={}", list(l));
        }
    }
    url + &format!(
        "&body={}",
        encode(&s.body.replace("\r\n", "\n").replace('\n', "\r\n"))
    )
}

/// `YYYY-MM-DDTHH:MM[:SS]` (or with a space; local, no offset) as the floating iCalendar time `YYYYMMDDTHHMMSS`; the
/// date must exist.
pub fn event_time(at: &str) -> Result<String, String> {
    let bad = || format!("event time {at:?} is not YYYY-MM-DDTHH:MM:SS in local time");
    let b = at.as_bytes();
    if !(b.len() == 16 || b.len() == 19)
        || b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b' ' || b[10] == b'T')
        || b[13] != b':'
        || (b.len() == 19 && b[16] != b':')
        || [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15]
            .iter()
            .chain(if b.len() == 19 { &[17, 18][..] } else { &[] })
            .any(|&i| !b[i].is_ascii_digit())
    {
        return Err(bad());
    }
    let n = |r: std::ops::Range<usize>| at[r].parse::<i64>().unwrap_or(-1);
    let (y, m, d, h, min) = (n(0..4), n(5..7), n(8..10), n(11..13), n(14..16));
    let sec = if b.len() == 19 { n(17..19) } else { 0 };
    let days = crate::usage::days_from_civil(y, m, d);
    if !(1..=12).contains(&m)
        || crate::usage::civil_from_days(days) != (y, m, d)
        || h > 23
        || min > 59
        || sec > 59
    {
        return Err(bad());
    }
    Ok(format!("{y:04}{m:02}{d:02}T{h:02}{min:02}{sec:02}"))
}

/// RFC 5545 TEXT: backslash, `;`, `,` and line breaks escaped.
fn text(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\n")
        .replace('\r', "\n") // a lone CR would end the line for some parsers (Fable lane 2 review M3)
        .replace('\n', "\\n")
}

/// A one-event calendar file for the user's Calendar to open and save.
pub fn ics(uid: &str, s: &Shown, now_ms: u64) -> Result<String, String> {
    let secs = (now_ms / 1000) as i64;
    let (y, m, d) = crate::usage::civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    let stamp = format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        t / 3600,
        t % 3600 / 60,
        t % 60
    );
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        "PRODID:-//Nunchiro//Outbox//EN".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{uid}@nunchiro"),
        format!("DTSTAMP:{stamp}"),
        format!("DTSTART:{}", event_time(&s.start)?),
        format!("DTEND:{}", event_time(&s.end)?),
        format!("SUMMARY:{}", text(&s.subject)),
    ];
    if !s.body.is_empty() {
        lines.push(format!("DESCRIPTION:{}", text(&s.body)));
    }
    lines.extend(["END:VEVENT".into(), "END:VCALENDAR".into()]);
    Ok(lines.join("\r\n") + "\r\n")
}

/// A card in a few words, for the Home lead's room lines.
pub fn words(s: &Shown) -> String {
    match s.kind {
        "event" => format!("the new event \"{}\"", s.subject),
        "command" => format!("the command `{}`", s.subject),
        _ => format!(
            "the {} to {} (\"{}\")",
            s.op.replace('_', " "),
            s.to.join(", "),
            s.subject
        ),
    }
}

/// Hands `target` (a mailto URL or an .ics file) to macOS `open`: the default mail app or Calendar opens it, and the
/// user sends or saves it. A test core records it instead (`opener`).
pub fn open(target: String) -> Result<(), String> {
    if let Some(recorded) = crate::opener::recorded(std::slice::from_ref(&target)) {
        return recorded;
    }
    // Round 2 (Codex note): waited for, so a card whose Mail or Calendar did not open stays (macOS `open` hands it on at
    // once; bounded so the registry lock is never held long).
    let mut command = crate::process::command("open");
    command.arg(&target).stdin(std::process::Stdio::null());
    let out = crate::process::output(command, std::time::Duration::from_secs(3))
        .map_err(|e| format!("it did not open, the card stays: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "it did not open, the card stays: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_address_only() {
        assert_eq!(
            address("Mina Park <Mina.Park@Example.com>").unwrap(),
            "mina.park@example.com"
        );
        for bad in [
            "evil.test@evil.test ",
            " a@b.co",
            "a@b.co, c@d.co",
            "a@b.co;c@d.co",
            "a@b.co?cc=c@d.co",
            "a@b.co&bcc=c@d.co",
            "Name <a@b.co> <c@d.co>",
            "a@b.co\nBcc: c@d.co",
            "a@localhost",
            "a@b.co%0A",
            "",
        ] {
            assert!(address(bad).is_err(), "{bad:?} passed");
        }
    }

    const SEND: &str = "mcp__gmail__send_message";
    const EVENT: &str = "mcp__calendar__create_event";

    #[test]
    fn only_shown_arguments_are_staged() {
        let ok = json!({"to":["Mina.Park@example.com"],"cc":["c@d.co"],"bcc":["b@e.co"],"subject":"Re: Q4","body":"Hi\nthere","replyThreadId":"t1"});
        let s = check(SEND, &ok).unwrap();
        assert_eq!((s.kind, s.op.as_str()), ("mail", "send_message"));
        assert_eq!(s.to, ["mina.park@example.com"]);
        assert_eq!(s.recipients().count(), 3);
        // Unknown keys, other spellings, a draft sent as it is, rich text, attachments, a signature, a send-as address,
        // an address that carries a second one, hidden characters; a reply or forward (Gmail picks their recipients);
        // a tool named without its server; event guests, recurrence, another calendar.
        for (tool, bad) in [
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","Bcc":["x@evil.test"]}),
            ),
            (SEND, json!({"to":["a@b.co"],"subject":"s","draftId":"r-1"})),
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","htmlBody":"<p>x</p>"}),
            ),
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","attachments":[]}),
            ),
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","includeSignature":true}),
            ),
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","from":"boss@b.co"}),
            ),
            (SEND, json!({"to":["a@b.co,x@evil.test"],"subject":"s"})),
            (SEND, json!({"to":["a@b.co"],"subject":"s\u{202E}x"})),
            (
                SEND,
                json!({"to":["a@b.co"],"subject":"s","replyThreadId":7}),
            ),
            (SEND, json!({"subject":"s"})),
            (
                "mcp__gmail__reply",
                json!({"messageId":"m","to":["a@b.co"],"body":"hi"}),
            ),
            (
                "mcp__gmail__forward",
                json!({"messageId":"m","to":["a@b.co"]}),
            ),
            ("mcp__gmail__delete_message", json!({"id":"m"})),
            ("send_message", json!({"to":["a@b.co"],"subject":"s"})),
            (
                EVENT,
                json!({"summary":"s","startTime":"2026-11-24T12:00:00","endTime":"2026-11-24T13:00:00","attendees":[{"email":"a@b.co"}]}),
            ),
            (
                EVENT,
                json!({"summary":"s","startTime":"2026-11-24T12:00:00","endTime":"2026-11-24T13:00:00","recurrenceData":["RRULE:FREQ=DAILY"]}),
            ),
            (
                EVENT,
                json!({"summary":"s","startTime":"2026-11-24T12:00:00","endTime":"2026-11-24T13:00:00","calendarId":"team@b.co"}),
            ),
            (
                EVENT,
                json!({"summary":"s","startTime":"2026-11-24T13:00:00","endTime":"2026-11-24T12:00:00"}),
            ),
        ] {
            assert!(check(tool, &bad).is_err(), "{tool} {bad} passed");
        }
        let long = json!({"to":["a@b.co"],"subject":"s","body":"x".repeat(BODY_MAX + 1)});
        assert!(check(SEND, &long).unwrap_err().contains("at most 8000"));
        let ev = json!({"summary":"Lunch, Mina","startTime":"2026-11-24T12:00:00","endTime":"2026-11-24T13:00:00","calendarId":"primary"});
        assert_eq!(check(EVENT, &ev).unwrap().kind, "event");
    }

    #[test]
    fn the_hash_is_over_canonical_json() {
        let h = crate::approval::outward_call_hash;
        let a = json!({"to":["a@b.co"],"subject":"s","body":"ab"});
        let b: Value =
            serde_json::from_str(r#"{ "body" : "ab", "subject":"s", "to": [ "a@b.co" ] }"#)
                .unwrap();
        assert_eq!(h("send_message", &a), h("send_message", &b));
        assert_ne!(h("send_message", &a), h("reply", &a));
        for other in [
            json!({"to":["a@b.co"],"subject":"s","body":"ab "}),
            json!({"to":["a@b.co"],"subject":"s","body":"ab","bcc":[]}),
            json!({"to":["a@b.co","c@d.co"],"subject":"s","body":"ab"}),
        ] {
            assert_ne!(h("send_message", &a), h("send_message", &other), "{other}");
        }
    }

    #[test]
    fn mailto_encodes_every_field() {
        let s = check(
            SEND,
            &json!({"to":["a@b.co","c@d.co"],"bcc":["e@f.co"],"subject":"Hi?cc=x@y.z&bcc=z@y.z","body":"line 1\nline 2 & more"}),
        )
        .unwrap();
        assert_eq!(
            mailto(&s),
            "mailto:a@b.co,c@d.co?subject=Hi%3Fcc%3Dx%40y.z%26bcc%3Dz%40y.z&bcc=e@f.co&body=line%201%0D%0Aline%202%20%26%20more"
        );
    }

    #[test]
    fn ics_escapes_text_and_checks_times() {
        assert_eq!(
            event_time("2026-11-21T09:30:00").unwrap(),
            "20261121T093000"
        );
        assert_eq!(event_time("2026-11-21 09:30").unwrap(), "20261121T093000");
        for bad in [
            "2026-02-30T09:00:00",
            "2026-11-21T24:00:00",
            "2026-11-21T09:30:00Z",
            "26-11-21 09:30",
        ] {
            assert!(event_time(bad).is_err(), "{bad} passed");
        }
        let s = check(
            EVENT,
            &json!({"summary":"Lunch; Mina, Alex","description":"a\\b\nc","startTime":"2026-11-21T12:00:00","endTime":"2026-11-21T13:00:00"}),
        )
        .unwrap();
        let f = ics("id1", &s, 0).unwrap();
        assert!(f.contains("SUMMARY:Lunch\\; Mina\\, Alex\r\n"), "{f}");
        assert!(f.contains("DESCRIPTION:a\\\\b\\nc\r\n"), "{f}");
        assert!(
            f.contains("DTSTART:20261121T120000\r\nDTEND:20261121T130000\r\n"),
            "{f}"
        );
        assert!(f.contains("DTSTAMP:19700101T000000Z\r\n"), "{f}");
        // A lone carriage return is a line break in the text, never the end of the content line.
        let s = check(
            EVENT,
            &json!({"summary":"x","description":"x\rRRULE:FREQ=DAILY","startTime":"2026-11-21T12:00:00","endTime":"2026-11-21T13:00:00"}),
        )
        .unwrap();
        let f = ics("id2", &s, 0).unwrap();
        assert!(f.contains("DESCRIPTION:x\\nRRULE:FREQ=DAILY\r\n"), "{f}");
        assert!(!f.contains("\rRRULE"), "{f}");
    }
}
