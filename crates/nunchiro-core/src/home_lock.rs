//! Ticket 1002 lane 1 (owner decisions E1 and E2, 2026-11-20): the Home seat lock. A Claude seat in the Home folder, or
//! a session such a seat started (in any folder), keeps the owner's claude.ai mail connector but locks it in two layers:
//! the launch flags deny the connector's known write tools and every other MCP server by wildcard, and a PreToolUse hook
//! (`decide`, run by `nunchiro hook home-lock` without the core) refuses at call time every MCP tool outside the read
//! allow list, so a tool a server adds later is refused too, and makes shell commands ask in every mode.
//! Owner decisions A and B (2026-11-20, later the same day): a yes on an Outbox card really sends, so the send tools stay
//! visible and the hook lets one through only when the core spends that yes for the call's exact content (`spend`);
//! a fourth mode, "Full access, shell included", lets shell commands run without asking.
//! Probe 2026-11-20 (Claude Code 2.1.328, ticket 1002 "Connector probe"): the hook's deny and ask hold under manual,
//! acceptEdits and `--dangerously-skip-permissions`; the Google Calendar connector does not load in the CLI, so v1 has
//! mail only.
use serde_json::Value;
use std::path::Path;

/// Settings > Assistants: the Home seat's mode (`Mode`'s names; absent or unreadable = Ask).
pub(crate) const MODE_KEY: &str = "home.chief_mode";
/// Settings > Assistants: `true` starts the seat with no MCP server at all, so the claude.ai account connectors (mail,
/// calendar) never load (probe 2026-11-28: `--strict-mcp-config` with an empty `--mcp-config` lists no `mcp__` tool).
/// Absent, null or false = the connectors load as before.
pub(crate) const CONNECTORS_OFF_KEY: &str = "home.connectors_off";
/// The two connectors (the Google Calendar one did not load in the CLI on 2026-11-20); one list with the outward hook's.
pub use crate::outward::{CALENDAR, MAIL};
/// The tools the seat may call as the mode allows. No draft tools: a draft is an Outbox card's own hashed copy.
const READ_ALLOW: &[(&str, &str)] = &[
    (MAIL, "search_threads"),
    (MAIL, "get_thread"),
    (MAIL, "get_message"),
    (MAIL, "list_labels"),
    (MAIL, "list_drafts"),
    (MAIL, "get_draft"),
    (CALENDAR, "list_calendars"),
    (CALENDAR, "list_events"),
    (CALENDAR, "get_event"),
    (CALENDAR, "search_events"),
    (CALENDAR, "suggest_time"),
];
/// Look v31 a S2-1: `tool` (the hook's `mcp__<server>__<tool>` name) is on the read allow list, so a locked seat's
/// permission card shows it as a read (`Queue::annotate`).
pub(crate) fn reads(tool: &str) -> bool {
    tool.strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .is_some_and(|t| READ_ALLOW.contains(&t))
}
/// Owner decision A (2026-11-20): a yes on an Outbox card really sends. These run only when the core spends a card the
/// owner said yes to for this exact call (`spend`); they stay visible to the seat, so they are not in layer 1. Fable
/// check M7a: only tools whose recipients are in their own arguments; `reply` and `forward` resolve them from a message
/// id, so they stay denied.
const GATED: &[(&str, &str)] = &[(MAIL, "send_message"), (CALENDAR, "create_event")];
/// The two connectors' other tools as known on 2026-11-20. Layer 1 only: the hook refuses one a later version adds.
const WRITE: &[(&str, &str)] = &[
    (MAIL, "reply"),
    (MAIL, "forward"),
    (MAIL, "create_draft"),
    (MAIL, "update_draft"),
    (MAIL, "delete_draft"),
    (MAIL, "trash_message"),
    (MAIL, "trash_thread"),
    (MAIL, "untrash_message"),
    (MAIL, "untrash_thread"),
    (MAIL, "label_message"),
    (MAIL, "label_thread"),
    (MAIL, "unlabel_message"),
    (MAIL, "unlabel_thread"),
    (MAIL, "update_message_labels"),
    (MAIL, "create_label"),
    (MAIL, "update_label"),
    (MAIL, "delete_label"),
    (MAIL, "mark_message_spam"),
    (MAIL, "mark_thread_spam"),
    (MAIL, "unmark_message_spam"),
    (MAIL, "unmark_thread_spam"),
    (MAIL, "apply_sensitive_message_label"),
    (MAIL, "apply_sensitive_thread_label"),
    (MAIL, "download_gmail_attachment"),
    (CALENDAR, "update_event"),
    (CALENDAR, "delete_event"),
    (CALENDAR, "respond_to_event"),
];
/// Fable check M6: the seat's only built-in tools (`--tools`); the hook refuses every other name, one a later Claude adds
/// too. Agent, WebFetch, RemoteTrigger, SendMessage, Monitor and the rest leave the machine or run code without Bash.
const BUILTIN: &[&str] = &["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
/// The deny flag's first words; `locked` finds the lock in a launch's arguments by them. Claude's own settings files
/// carry hooks that run at the next start without asking, so no mode may write them (probe: Full access did).
/// Final review S6: `.git/**` (hooks run later) and `.mcp.json` (a server started at the next start) too.
const DENY_HEAD: &str = "--disallowedTools=Write(.claude/**),Edit(.claude/**),Write(~/.claude/**),Edit(~/.claude/**),Write(.git/**),Edit(.git/**),Write(.mcp.json),Edit(.mcp.json)";

/// The four modes of Settings > Assistants, stored by these names: never rename one. Fable check M3: no mode is Claude's
/// Skip permissions (`--restricted` refuses it); Full access is the lock hook's `allow` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mode {
    Ask,
    AcceptEdits,
    /// The hook allows MCP reads and the listed `nunchiro` lines; other shell commands ask; edits follow Accept edits.
    Full,
    /// As Full, and every shell command runs unasked: the Outbox card is not enforced (the page says so).
    FullShell,
}
const NAMES: [(&str, Mode); 4] = [
    ("ask", Mode::Ask),
    ("accept-edits", Mode::AcceptEdits),
    ("full-access", Mode::Full),
    ("full-access-shell", Mode::FullShell),
];

pub(crate) fn mode(stored: Option<&Value>) -> Mode {
    named(stored.and_then(Value::as_str).unwrap_or_default())
}

/// A stored or hook-line name; anything else is Ask, the strictest.
pub fn named(name: &str) -> Mode {
    NAMES
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(Mode::Ask, |(_, m)| *m)
}

pub fn name(mode: Mode) -> &'static str {
    NAMES
        .iter()
        .find(|(_, m)| *m == mode)
        .map_or("ask", |(n, _)| n)
}

/// Concept rule 6 and Fable check M8: a seat the owner did not open from the window (a schedule, a lead's open, a
/// session's child) never runs above Accept edits, so a brief read with nobody present never has a free shell.
pub(crate) fn effective(mode: Mode, owner: bool) -> Mode {
    if owner {
        mode
    } else {
        mode.min(Mode::AcceptEdits)
    }
}

/// Settings save: null (back to Ask) or one of the four names.
pub(crate) fn check(value: &Value) -> Result<(), String> {
    match value {
        Value::Null => Ok(()),
        Value::String(s) if NAMES.iter().any(|(n, _)| n == s) => Ok(()),
        _ => Err(format!(
            "{MODE_KEY}: expected \"ask\", \"accept-edits\", \"full-access\" or \"full-access-shell\""
        )),
    }
}

/// The seat is in the Home folder or below it.
pub(crate) fn in_home(home: &Path, cwd: &Path) -> bool {
    cwd.starts_with(crate::team::Team::open(home).home())
}

/// One `--disallowedTools=` word (the flag is variadic: the `=` form ends at its own value; probe: a comma list parses).
pub(crate) fn deny_arg(servers: &[String]) -> String {
    let mut out = DENY_HEAD.to_string();
    for (server, tool) in WRITE {
        out.push_str(&format!(",mcp__{server}__{tool}"));
    }
    for server in servers {
        out.push_str(&format!(",mcp__{server}__*"));
    }
    out
}

/// The lock's launch arguments (`mode` already `effective`). Fable check M3: `--restricted` keeps the claude.ai
/// connectors, `--settings` hooks and `--plugin-dir` (probe 2026-11-20), ignores user, project and local settings,
/// confines the file tools to the working folders and refuses Skip permissions; `--tools` names the built-ins.
/// `connectors_off` (`CONNECTORS_OFF_KEY`) adds the strict empty MCP config, after the first two words (a side chat
/// drops those).
pub(crate) fn args(mode: Mode, servers: &[String], connectors_off: bool) -> Vec<String> {
    let claude_mode = if mode == Mode::Ask {
        "manual"
    } else {
        "acceptEdits"
    };
    let mut out = vec![
        "--permission-mode".into(),
        claude_mode.into(),
        "--restricted".into(),
        format!("--tools={}", BUILTIN.join(",")),
        deny_arg(servers),
    ];
    if connectors_off {
        // The `=` form: `--mcp-config` is variadic, so a bare value list could swallow a later word.
        out.push("--strict-mcp-config".into());
        out.push(r#"--mcp-config={"mcpServers":{}}"#.into());
    }
    out
}

/// Settings save for `CONNECTORS_OFF_KEY`: null or a boolean.
pub(crate) fn check_connectors_off(value: &Value) -> Result<(), String> {
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        _ => Err(format!("{CONNECTORS_OFF_KEY}: expected true or false")),
    }
}

/// The arguments carry the lock (`args` or `deny_arg`).
pub(crate) fn locked(args: &[String]) -> bool {
    args.iter().any(|a| a.starts_with(DENY_HEAD))
}

/// A start argument that would widen or replace the lock.
pub(crate) fn widening(args: &[String]) -> Option<&str> {
    const FLAGS: &[&str] = &[
        crate::agent_permission::ALLOW_SKIP,
        crate::agent_permission::START_IN_SKIP,
        "--permission-mode",
        "--settings",
        "--setting-sources",
        "--mcp-config",
        "--strict-mcp-config",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--tools",
        "--permission-prompt-tool",
        "--plugin-dir",
        "--restricted",
        "--safe-mode",
        "--bare",
        "--agents",
        "--add-dir",
    ];
    args.iter().map(String::as_str).find(|a| {
        FLAGS
            .iter()
            .any(|f| a == f || a.strip_prefix(f).is_some_and(|r| r.starts_with('=')))
    })
}

/// Layer 1's wildcard list: the user's own Claude servers, Nunchiro's own sealed servers (owner R2: denied for a locked
/// seat too) and the claude.ai connectors other than mail and calendar. Only names that fit the comma list; any other
/// is refused by the hook.
pub(crate) fn deny_servers(user: Vec<String>, connectors: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = user
        .into_iter()
        .chain(connectors.into_iter().map(|name| {
            // As the CLI names a connector's tools: "claude.ai Claude Docs" is `mcp__claude_ai_Claude_Docs__*`.
            name.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        }))
        .filter(|s| {
            !s.is_empty()
                && s != MAIL
                && s != CALENDAR
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// What the hook does with one tool call.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Claude's own mode decides.
    Mode,
    Allow(&'static str),
    Ask(&'static str),
    Deny(&'static str),
    /// An outward tool: allowed only when the core spends a yes for this exact call (`spend`).
    Spend,
}
pub const NO_CARD: &str = "Home seat: an outward action runs only after the owner's yes on its Outbox card, for exactly this content";
const FULL: &str = "Home seat: Full access (Settings > Assistants)";

/// The `nunchiro` verbs that only ask the core (which judges them, `check_locked`). Fable review R1b: the others act in
/// the CLI before the core sees them (`serve restart` starts a helper outside every session), so they ask.
const UNASKED_VERBS: &[&str] = &[
    "agent", "task", "schedule", "role", "note", "team", "outbox", "events", "skill",
    // The core finds the bot by the seat and turns a write after a mail read into a proposal (`team::memory`).
    "memory",
];

/// Only ASCII letters, digits, marks and the plain space: the shell splits words on its own whitespace only, so a
/// no-break space (or any other Unicode or control space) would join what `split(' ')` reads as two words.
fn plain(command: &str) -> bool {
    command.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

/// Fable check S3: one `nunchiro` command on the verb list and nothing else: no separator, redirect, substitution,
/// subshell, line break, leading `VAR=` or `--machine`.
pub fn nunchiro_line(command: &str) -> bool {
    let command = command.trim_matches(' ');
    let mut words = command.split(' ').filter(|w| !w.is_empty());
    plain(command)
        && words.next() == Some("nunchiro")
        && words
            .next()
            .is_some_and(|verb| UNASKED_VERBS.contains(&verb))
        && !command.split(' ').any(|w| w.starts_with("--machine"))
        && !command.contains([
            ';', '&', '|', '<', '>', '(', ')', '$', '`', '\\', '\n', '\r',
        ])
}

const SETUP: &str = "Home seat: a setup step of its brief";

/// The two setup steps a seat's brief names, unasked in every mode (they asked before the seat was ready):
/// `nunchiro task list`, and `cat` of a bot's SOUL file in this core's `team/<bot>/` folder. Exactly that line, plain
/// ASCII, the path absolute and of `[A-Za-z0-9._/-]` only (no glob, quote or shell mark); the file resolves to
/// `<team>/<bot>/SOUL.md` (a linked bot folder or file resolves elsewhere: another session could plant one) and has one link (a hard link
/// shows another file's content). Anything else asks as before.
pub fn setup_line(home: &Path, command: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    if !plain(command) {
        return false;
    }
    let words: Vec<&str> = command.split(' ').filter(|w| !w.is_empty()).collect();
    match words[..] {
        ["nunchiro", "task", "list"] => true,
        ["cat", path]
            if path.starts_with('/')
                && path.split('/').all(|c| c != ".." && c != ".")
                && path
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b)) =>
        {
            let (Ok(team), Ok(real)) = (
                std::fs::canonicalize(home.join("team")),
                std::fs::canonicalize(path),
            ) else {
                return false;
            };
            real.file_name() == Some("SOUL.md".as_ref())
                && real.parent().and_then(Path::parent) == Some(team.as_path())
                && std::fs::symlink_metadata(&real)
                    .is_ok_and(|m| m.file_type().is_file() && m.nlink() == 1)
        }
        _ => false,
    }
}

/// Fail closed: a built-in runs only from `BUILTIN`, an MCP tool only by exact read name or as a spent outward call.
/// `input` is the call's `tool_input` (a Bash line is read from it). Fable review R3: the file tools are never allowed
/// by the hook (Claude's own mode and `--restricted` decide them), so no path outside the folder gets a hook yes.
pub fn decide(tool: &str, input: &Value, mode: Mode, home: &Path) -> Decision {
    let full = mode >= Mode::Full;
    let allow_full = if full {
        Decision::Allow(FULL)
    } else {
        Decision::Mode
    };
    let Some(rest) = tool.strip_prefix("mcp__") else {
        return match tool {
            "Bash" if mode == Mode::FullShell => Decision::Allow(FULL),
            "Bash"
                if input
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| setup_line(home, c)) =>
            {
                Decision::Allow(SETUP)
            }
            "Bash"
                if full
                    && input
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(nunchiro_line) =>
            {
                Decision::Allow(FULL)
            }
            // E2: shell commands ask in every other case, over any allow rule (probe: a hook ask beats one).
            "Bash" => Decision::Ask("Home seat: shell commands always ask (ticket 1002)"),
            t if BUILTIN.contains(&t) => Decision::Mode,
            _ => Decision::Deny(
                "Home seat: this tool is not on the chief of staff's list (ticket 1002)",
            ),
        };
    };
    let Some((server, name)) = rest.split_once("__") else {
        return Decision::Deny(NO_CARD);
    };
    if GATED.contains(&(server, name)) {
        Decision::Spend
    } else if READ_ALLOW.contains(&(server, name)) {
        allow_full
    } else {
        Decision::Deny(
            "Home seat: mail and calendar are read only and other connectors are off; an outward action needs an Outbox card",
        )
    }
}

/// The hook flag `spawn` adds when the seat started with connectors off (its arguments hold `--strict-mcp-config`).
pub const NO_MCP_FLAG: &str = "--no-mcp";

/// Layer 2 of connectors off: with `no_mcp`, every MCP tool is refused, whatever server it came from; otherwise `decide`.
pub fn decide_locked(tool: &str, input: &Value, mode: Mode, home: &Path, no_mcp: bool) -> Decision {
    if no_mcp && tool.starts_with("mcp__") {
        return Decision::Deny("Home seat: account connectors are off (Settings > Assistants)");
    }
    decide(tool, input, mode, home)
}

/// Asks the core over `sock` to spend the owner's yes for this exact call (`Request::OutboxSpend`, lane 2: the card's
/// id once as `Reply::Text`, else an error), hashed as the card was (`approval::outward_call_hash`). Ok only on that
/// reply; a core that is down, slow, older or refusing, or any other reply, is an Err (fail closed).
pub fn spend(sock: &Path, token: &str, tool: &str, input: &Value) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(sock).map_err(|e| e.to_string())?;
    let wait = Some(std::time::Duration::from_secs(5));
    stream.set_read_timeout(wait).map_err(|e| e.to_string())?;
    stream.set_write_timeout(wait).map_err(|e| e.to_string())?;
    let envelope = crate::api::Envelope {
        token: token.into(),
        request: crate::api::Request::OutboxSpend {
            tool: tool.into(),
            args_hash: crate::approval::outward_call_hash(tool, input),
        },
    };
    let mut bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream.take(65536))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    match serde_json::from_str::<crate::api::Response>(&line).map_err(|e| e.to_string())? {
        Ok(crate::api::Reply::Text { text }) => Ok(text),
        Ok(_) => Err("unexpected core reply".into()),
        Err(e) => Err(e),
    }
}

/// The hook's stdout for a decision (none for `Mode`).
pub fn hook_output(decision: &str, reason: &str) -> Value {
    serde_json::json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn absent_or_unreadable_mode_is_ask() {
        assert_eq!(mode(None), Mode::Ask);
        assert_eq!(mode(Some(&json!(3))), Mode::Ask);
        assert_eq!(mode(Some(&json!("full-access-shell"))), Mode::FullShell);
        assert!(check(&json!("auto")).is_err() && check(&json!("full-access-shell")).is_ok());
    }

    #[test]
    fn connectors_off_adds_the_strict_empty_mcp_config_only_when_set() {
        let strict = |a: &[String]| a.iter().any(|w| w == "--strict-mcp-config");
        for m in [Mode::Ask, Mode::FullShell] {
            assert!(!strict(&args(m, &[], false)));
            let on = args(m, &[], true);
            assert!(strict(&on) && locked(&on), "{on:?}");
            assert!(on.ends_with(&s(&[
                "--strict-mcp-config",
                r#"--mcp-config={"mcpServers":{}}"#
            ])));
        }
        assert!(
            check_connectors_off(&json!(true)).is_ok()
                && check_connectors_off(&json!(null)).is_ok()
        );
        assert!(check_connectors_off(&json!("yes")).is_err());
        // Layer 2: with the flag every MCP tool is refused, a read and a gated send too; built-ins are unchanged.
        let home = Path::new("/nonexistent-home");
        let (read, send) = (
            format!("mcp__{MAIL}__get_thread"),
            format!("mcp__{MAIL}__send_message"),
        );
        for tool in [read.as_str(), send.as_str(), "mcp__fake__list"] {
            assert!(
                matches!(
                    decide_locked(tool, &json!({}), Mode::Full, home, true),
                    Decision::Deny(_)
                ),
                "{tool}"
            );
        }
        assert_eq!(
            decide_locked(&read, &json!({}), Mode::Full, home, false),
            decide(&read, &json!({}), Mode::Full, home)
        );
        assert_eq!(
            decide_locked("Read", &json!({}), Mode::Ask, home, true),
            Decision::Mode
        );
    }

    #[test]
    fn argv_per_mode_and_rule_six() {
        let servers = s(&["memo", "claude_ai_Claude_Docs"]);
        assert_eq!(
            args(Mode::Ask, &servers, false)[..2],
            s(&["--permission-mode", "manual"])
        );
        for m in [Mode::AcceptEdits, Mode::Full, Mode::FullShell] {
            assert_eq!(
                args(m, &servers, false)[..2],
                s(&["--permission-mode", "acceptEdits"])
            );
        }
        // A schedule, a lead's open or a child never runs above Accept edits (rule 6, M8).
        assert_eq!(effective(Mode::FullShell, false), Mode::AcceptEdits);
        assert_eq!(effective(Mode::Full, false), Mode::AcceptEdits);
        assert_eq!(effective(Mode::Ask, false), Mode::Ask);
        assert_eq!(effective(Mode::FullShell, true), Mode::FullShell);
        for m in [Mode::Ask, Mode::AcceptEdits, Mode::Full, Mode::FullShell] {
            let a = args(m, &servers, false);
            assert!(locked(&a) && a.contains(&"--restricted".to_string()));
            assert!(a.contains(&"--tools=Read,Grep,Glob,Edit,Write,Bash".to_string()));
            // No mode is Skip permissions (M3).
            assert!(!a.iter().any(|x| x.contains("dangerously")), "{a:?}");
            let deny = a.last().unwrap();
            assert!(deny.starts_with("--disallowedTools=") && !deny.contains(' '));
            for t in [
                "mcp__claude_ai_Gmail__forward",
                "mcp__claude_ai_Gmail__reply",
                "mcp__claude_ai_Google_Calendar__delete_event",
                "mcp__memo__*",
            ] {
                assert!(deny.split(',').any(|x| x == t), "{t}");
            }
            // Decision A: the gated send tools stay visible (the hook gates them); reads stay too.
            for t in ["send_message", "create_event", "search_threads"] {
                assert!(
                    !deny.split(',').any(|x| x.ends_with(&format!("__{t}"))),
                    "{t}"
                );
            }
        }
        assert!(!locked(&s(&["--permission-mode", "manual"])));
        assert_eq!(widening(&s(&["--restricted"])), Some("--restricted"));
        assert_eq!(widening(&s(&["--add-dir=/"])), Some("--add-dir=/"));
    }

    #[test]
    fn hook_fails_closed_and_shell_follows_the_mode() {
        let none = json!({});
        let bash = |c: &str| json!({"command": c});
        let home = Path::new("/nonexistent-home");
        let d = |tool: &str, m| decide(tool, &none, m, home);
        for tool in [
            "mcp__claude_ai_Gmail__search_threads",
            "mcp__claude_ai_Google_Calendar__list_events",
        ] {
            assert_eq!(d(tool, Mode::AcceptEdits), Decision::Mode, "{tool}");
            assert!(matches!(d(tool, Mode::Full), Decision::Allow(_)), "{tool}");
        }
        // Fable review R3: the file tools are never a hook yes, in any mode.
        for tool in ["Read", "Edit", "Write", "Grep", "Glob"] {
            for m in [Mode::Ask, Mode::Full, Mode::FullShell] {
                assert_eq!(d(tool, m), Decision::Mode, "{tool}");
            }
        }
        for tool in [
            "mcp__claude_ai_Gmail__send_message",
            "mcp__claude_ai_Google_Calendar__create_event",
        ] {
            for m in [Mode::Ask, Mode::FullShell] {
                assert_eq!(d(tool, m), Decision::Spend, "{tool}");
            }
        }
        // A write tool, a tool a later connector version adds, another server (Nunchiro's own sealed ones too: owner R2),
        // a malformed name, a built-in that is not on the list (one a later Claude adds too): refused in every mode.
        for tool in [
            "mcp__claude_ai_Gmail__reply",
            "mcp__claude_ai_Gmail__create_draft",
            "mcp__claude_ai_Gmail__schedule_send",
            "mcp__claude_ai_Claude_Docs__guide",
            "mcp__browser__open",
            "mcp__plugin_x_mail__send",
            "mcp__claude_ai_Gmail",
            "WebFetch",
            "RemoteTrigger",
            "SendMessage",
            "Agent",
            "Monitor",
            "NewToolFromLater",
        ] {
            assert!(
                matches!(d(tool, Mode::FullShell), Decision::Deny(_)),
                "{tool}"
            );
        }
        // Decision B: Bash asks in Full access (one plain `nunchiro` line on the verb list excepted) and not in "Full
        // access, shell included".
        let b = |c: &str, m| decide("Bash", &bash(c), m, home);
        assert!(matches!(b("echo hi", Mode::Full), Decision::Ask(_)));
        for line in [
            "nunchiro task list",
            "nunchiro outbox stage --tool t --args '{}'",
            "nunchiro memory add x",
            "nunchiro agent list",
        ] {
            assert!(matches!(b(line, Mode::Full), Decision::Allow(_)), "{line}");
        }
        assert!(matches!(
            b("nunchiro agent list", Mode::AcceptEdits),
            Decision::Ask(_)
        ));
        for line in [
            "nunchiro x; osascript",
            "nunchiro task $(id)",
            "X=1 nunchiro task list",
            "nunchiro task list\nosascript",
            "nunchiro task list | sh",
            "nunchirox task",
            "nunchiro serve restart",
            "nunchiro worktree open --path /x",
            "nunchiro widget run x",
            "nunchiro machine add x",
            "nunchiro --machine m task list",
            "nunchiro task list --machine=m",
            "nunchiro\u{a0}task\u{a0}x/y",
            "nunchiro task\u{2028}list",
            "nunchiro",
        ] {
            assert!(matches!(b(line, Mode::Full), Decision::Ask(_)), "{line}");
        }
        assert!(matches!(
            b("osascript -e x", Mode::FullShell),
            Decision::Allow(_)
        ));
        assert_eq!(
            (named("full-access-shell"), named("bogus")),
            (Mode::FullShell, Mode::Ask)
        );
    }

    // A bot-task trial: the chief of staff's first turn asked twice before it was ready, for the two setup steps its
    // brief names. Those two run unasked in every mode; any other line, file or form still asks.
    #[test]
    fn the_seats_own_setup_steps_run_unasked() {
        let home = std::env::temp_dir().join(format!("home-lock-setup-{}", std::process::id()));
        let bot = home.join("team/593a1861");
        std::fs::create_dir_all(&bot).unwrap();
        std::fs::write(bot.join("SOUL.md"), "who I am").unwrap();
        std::fs::write(bot.join("MEMORY.md"), "notes").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", bot.join("LINK.md")).unwrap();
        let other = home.join("team/other");
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", other.join("SOUL.md")).unwrap();
        let away = home.join("away");
        std::fs::create_dir_all(&away).unwrap();
        std::fs::write(away.join("SOUL.md"), "not a bot").unwrap();
        std::os::unix::fs::symlink(&away, home.join("team/linked")).unwrap();
        std::fs::create_dir_all(home.join("team/hard")).unwrap();
        std::fs::hard_link(away.join("SOUL.md"), home.join("team/hard/SOUL.md")).unwrap();
        let b = |c: &str, m| decide("Bash", &json!({ "command": c }), m, &home);
        let soul = format!("cat {}", bot.join("SOUL.md").display());
        for m in [Mode::Ask, Mode::AcceptEdits, Mode::Full] {
            assert!(
                matches!(b("nunchiro task list", m), Decision::Allow(_)),
                "{m:?}"
            );
            assert!(matches!(b(&soul, m), Decision::Allow(_)), "{m:?}");
        }
        for line in [
            "nunchiro task list --all-places".to_string(),
            "nunchiro agent list".into(),
            "nunchiro task list; rm -rf x".into(),
            "nunchiro\ntask\nlist".into(),
            soul.replace(' ', "\n"),
            format!("{soul}; rm -rf x"),
            format!("{soul} /etc/hosts"),
            format!("cat {}", bot.join("MEMORY.md").display()),
            format!("cat {}", bot.join("LINK.md").display()),
            format!("cat {}", other.join("SOUL.md").display()),
            format!("cat {}", bot.join("../593a1861/SOUL.md").display()),
            format!("cat {}", home.join("SOUL.md").display()),
            format!("less {}", bot.join("SOUL.md").display()),
            // Acceptance review: Unicode and control spaces the shell does not split on, a glob, a relative path, a
            // linked bot folder, a hard link.
            soul.replace(' ', "\u{a0}"),
            soul.replace(' ', "\u{b}"),
            soul.replace(' ', "\u{c}"),
            soul.replace(' ', "\u{85}"),
            soul.replace(' ', "\u{2028}"),
            soul.replace(' ', "\t"),
            "nunchiro\u{a0}task\u{a0}list".into(),
            format!("cat {}", home.join("team/*/SOUL.md").display()),
            format!("cat {}", home.join("team/59?a1861/SOUL.md").display()),
            "cat team/593a1861/SOUL.md".into(),
            format!("cat {}", home.join("team/linked/SOUL.md").display()),
            format!("cat {}", home.join("team/hard/SOUL.md").display()),
        ] {
            assert!(matches!(b(&line, Mode::Ask), Decision::Ask(_)), "{line}");
        }
        let _ = std::fs::remove_dir_all(home);
    }

    /// A stand-in core for `OutboxSpend` (lane 2's rule: the card id once for the one approved hash, Err otherwise); it
    /// checks the request is the typed one and that the hook hashes as lane 2 does.
    #[test]
    fn spend_allows_an_approved_call_once_and_fails_closed() {
        use std::io::{BufRead, BufReader, Write};
        let dir = std::env::temp_dir().join(format!("home-lock-spend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("core.sock");
        let tool = "mcp__claude_ai_Gmail__send_message";
        let input = json!({"to": "a@example.org", "subject": "Q4", "body": "Draft"});
        let approved = crate::approval::outward_call_hash(tool, &input);
        // Core down: no socket.
        assert!(spend(&sock, "t", tool, &input).is_err());
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let core = std::thread::spawn(move || {
            let mut spent = false;
            for _ in 0..3 {
                let (stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let v: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(
                    (v["token"].as_str(), v["request"]["op"].as_str()),
                    (Some("t"), Some("outbox_spend"))
                );
                let ok = !spent && v["request"]["args_hash"] == approved.as_str();
                spent |= ok;
                let reply = if ok {
                    json!({"Ok": {"type": "text", "text": "c1"}})
                } else {
                    json!({"Err": "no card"})
                };
                (&stream)
                    .write_all(format!("{reply}\n").as_bytes())
                    .unwrap();
            }
        });
        let changed = json!({"to": "a@example.org", "subject": "Q4", "body": "Draft!"});
        assert!(spend(&sock, "t", tool, &changed).is_err(), "changed text");
        assert_eq!(
            spend(&sock, "t", tool, &input).as_deref(),
            Ok("c1"),
            "the approved call"
        );
        assert!(spend(&sock, "t", tool, &input).is_err(), "a second call");
        core.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Ticket 1130 S1: every tool the Outbox gates is one the outward list names, so every other session asks for it.
    #[test]
    fn t1130_gated_tools_are_outward() {
        for (server, name) in GATED {
            assert!(
                crate::outward::kind(&format!("mcp__{server}__{name}"), &serde_json::Value::Null)
                    .is_some(),
                "{name}"
            );
        }
    }

    #[test]
    fn deny_servers_names_all_others() {
        let got = deny_servers(
            s(&["memo", "rea", "own", "bad,name"]),
            s(&[
                "claude.ai Gmail",
                "claude.ai Claude Docs",
                "claude.ai Google Calendar",
            ]),
        );
        assert_eq!(got, s(&["claude_ai_Claude_Docs", "memo", "own", "rea"]));
    }
}
