//! V2-5b: the problem card (proposed glossary term). Why a session failed, in one line, and the one fix the window
//! offers for it. A screen pattern classifies only a session that has ended: a running session never gets a card from
//! what its agent prints, so a crafted line cannot offer a restart or a hook-less start on a working session.
use crate::api::AgentKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Case {
    NotInstalled,
    LoggedOut,
    UsageLimit,
    HookTrust,
    MachineUnreachable,
    VersionMismatch,
    FolderPermission,
    HolderRestart,
    SetAside,
    Unexpected,
    // V2-4b: an ACP agent that never answered the handshake, and a Claude entry refused for lack of an API key.
    AcpNoAnswer,
    AcpRefused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub case: Case,
    /// One line, shown on the band.
    pub cause: String,
    /// Codex usage limit: the reset time as the agent printed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
    /// "Details": redacted, allow-listed lines (never login PTY content).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub details: String,
}

/// A stored `problem` that does not parse (hand-edited, or a case from a later version) loads as none, so the core
/// still starts with that row.
pub fn lenient<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Problem>, D::Error> {
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| serde_json::from_value(v).ok()))
}

/// A fix the window asks for on an ended session. Owner and window only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fix {
    Restart,
    StartWithoutHooks,
}

/// What `ended` reads of a session's last output: the end of its replay.
const SCREEN_BYTES: usize = 64 * 1024;
/// Claude's sign-in choice is a prompt at the bottom of its last screen (5 to 7 lines up when recorded): only these
/// last lines are read for it, so words earlier in a conversation that ended cleanly are no card.
const BOTTOM_LINES: usize = 10;
/// Lines of "Details".
const DETAILS_LINES: usize = 12;

fn name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "Claude",
        AgentKind::Codex => "Codex",
        AgentKind::Shell => "The shell",
        AgentKind::Acp => "The ACP agent",
    }
}

fn problem(case: Case, cause: String, details: String) -> Problem {
    Problem {
        case,
        cause,
        reset: None,
        details,
    }
}

/// The last screen the session showed, as text (bounded; escape sequences applied, not kept), then the last alternate
/// screen it left: a full-screen agent (Codex) restores the empty main screen as it exits.
fn screen(bytes: &[u8]) -> Vec<String> {
    const LEAVE: &[u8] = b"\x1b[?1049l";
    let tail = &bytes[bytes.len().saturating_sub(SCREEN_BYTES)..];
    let text = |bytes: &[u8]| {
        let mut screen = crate::waiting::screen::Screen::new(200, 60);
        screen.feed(bytes);
        screen.text()
    };
    let left = tail.windows(LEAVE.len()).rposition(|w| w == LEAVE);
    [Some(text(tail)), left.map(|at| text(&tail[..at]))]
        .into_iter()
        .flatten()
        .collect()
}

/// The wordings Codex prints with a usage limit; the problem card and the limit mark (`usage.rs`) both read them.
pub(crate) const CODEX_LIMIT_PHRASES: [&str; 3] = [
    "hit your usage limit",
    "Usage limit reached",
    "reached your usage limit",
];
/// Why an agent session ended, from its last screen and exit code; `None` for a clean end. `failed` is a session the
/// core could not wait on, or whose holder died. A shell is classified by how it ended only: its screen is the user's
/// own command output.
pub fn ended(kind: AgentKind, output: &[u8], exit: Option<i32>, failed: bool) -> Option<Problem> {
    // An ACP agent has no screen (V2-4a); its cards are V2-4b's.
    let screens = if matches!(kind, AgentKind::Shell | AgentKind::Acp) {
        vec![]
    } else {
        screen(output)
    };
    let text = screens.join("\n");
    // The last non-blank lines of each screen.
    let bottom = screens
        .iter()
        .map(|s| {
            let lines: Vec<&str> = s.trim_end().lines().collect();
            lines[lines.len().saturating_sub(BOTTOM_LINES)..].join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let found_in = |text: &str, needles: &[&str]| {
        text.lines()
            .find(|line| needles.iter().any(|n| line.contains(n)))
            .map(|l| l.trim().to_string())
    };
    let found = |needles: &[&str]| found_in(&text, needles);
    let who = name(kind);
    let state = match exit {
        Some(code) => format!("{who} exited with code {code}."),
        None if failed => format!("{who} stopped; no exit code."),
        None => format!("{who} exited."),
    };
    let details = |line: Option<&str>| details(&[&state, line.unwrap_or_default()].join("\n"));
    if kind == AgentKind::Codex
        && let Some(line) = found(&[
            CODEX_LIMIT_PHRASES[0],
            CODEX_LIMIT_PHRASES[1],
            CODEX_LIMIT_PHRASES[2],
            "out of credits",
        ])
    {
        // The agent's own words, so redacted like any text a log quotes.
        let reset = ["try again at ", "Try again at "]
            .iter()
            .find_map(|at| line.find(at).map(|i| &line[i + at.len()..]))
            .map(|t| crate::logs::excerpt(t.trim_end_matches('.').trim()))
            .filter(|t| !t.is_empty() && t.len() <= 40);
        let cause = match &reset {
            Some(at) => format!("Codex usage limit reached. Resets {at} per Codex."),
            None => "Codex usage limit reached.".into(),
        };
        return Some(Problem {
            reset,
            ..problem(Case::UsageLimit, cause, details(Some(&line)))
        });
    }
    let signed_out = match kind {
        AgentKind::Claude => &[
            "Select login method",
            "Not logged in",
            "Please run /login",
            "Invalid API key",
            "OAuth token has expired",
        ][..],
        AgentKind::Codex => &[
            "Sign in with ChatGPT",
            "Provide your own API key",
            "Not logged in",
        ][..],
        AgentKind::Shell | AgentKind::Acp => &[][..],
    };
    // Real Claude leaves its sign-in on exit 0 (two Ctrl-C), so the place on the screen decides, not the code.
    let signed_out_line = match kind {
        AgentKind::Claude => found_in(&bottom, signed_out),
        _ => found(signed_out),
    };
    if let Some(line) = signed_out_line {
        return Some(problem(
            Case::LoggedOut,
            format!("{who} is signed out."),
            details(Some(&line)),
        ));
    }
    // Only Codex gets a hook trust flag, and a refused hook ends its start with a failed code.
    if kind == AgentKind::Codex
        && matches!(exit, Some(c) if c != 0)
        && let Some(line) = found(&[
            "dangerously-bypass-hook-trust",
            "hook trust",
            "hooks are not trusted",
        ])
    {
        return Some(problem(
            Case::HookTrust,
            format!("{who} refused Nunchiro's hooks."),
            details(Some(&line)),
        ));
    }
    match exit {
        Some(0) => None,
        Some(127) if kind != AgentKind::Shell => Some(problem(
            Case::NotInstalled,
            format!("{who} is not installed."),
            details(None),
        )),
        Some(code) if kind != AgentKind::Shell => Some(problem(
            Case::Unexpected,
            format!("Session ended unexpectedly (exit code {code})."),
            details(None),
        )),
        None if failed => Some(problem(
            Case::Unexpected,
            "Session ended unexpectedly.".into(),
            details(None),
        )),
        _ => None,
    }
}

/// A Start the owner asked for whose agent is missing: `error` is the `--version` probe's.
pub fn start_failed(kind: AgentKind, error: &str) -> Option<Problem> {
    let program = match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Shell | AgentKind::Acp => return None,
    };
    (error.starts_with(&format!("{program} --version:"))
        && (error.contains("No such file") || error.contains("not found")))
    .then(|| {
        problem(
            Case::NotInstalled,
            format!(
                "{} is not installed ({program} is not on PATH).",
                name(kind)
            ),
            details(error),
        )
    })
}

/// V2-4b: why an ACP agent failed to start or to finish its handshake, from the exact errors the ACP code produces
/// (`acp agent <command>: <io error>` from the spawn, the client's handshake reasons, the Claude refusal). An entry
/// that is not approved or changed since is no card (the window opens the setup sheet), and neither is any other
/// refusal of the start (a bad project, a busy conversation): those stay plain errors. `label` names the agent.
pub fn acp_failed(label: &str, error: &str) -> Option<Problem> {
    let lower = error.to_lowercase();
    if error.starts_with("a Claude ACP agent needs ") {
        return Some(problem(Case::AcpRefused, error.to_string(), String::new()));
    }
    if error.starts_with("acp agent ")
        && (error.contains("No such file") || error.contains("not found"))
    {
        return Some(problem(
            Case::NotInstalled,
            format!("{label} is not installed."),
            details(error),
        ));
    }
    if lower.contains("auth_required") || lower.contains("authentication required") {
        return Some(problem(
            Case::LoggedOut,
            format!("{label} is not signed in."),
            details(error),
        ));
    }
    const HANDSHAKE: [&str; 6] = [
        "acp agent ",
        "initialize:",
        "session start:",
        "the agent speaks ACP version",
        "the agent closed its output",
        "agent message too large",
    ];
    (HANDSHAKE.iter().any(|h| error.starts_with(h))
        || error.starts_with("session/new answered")
        || error.starts_with("the agent cannot load"))
    .then(|| {
        problem(
            Case::AcpNoAnswer,
            format!("{label} did not answer ACP: check its command."),
            details(error),
        )
    })
}

/// The cards of states other tickets already keep on a session: v1a-33's unreadable folder (while it runs; the agent
/// keeps running) and V2-1b's holder of an older protocol.
pub fn kept(session: &crate::api::Session) -> Option<Problem> {
    if session.state != crate::api::SessionState::Running {
        return None;
    }
    if let Some(blocked) = &session.blocked {
        return Some(problem(
            Case::FolderPermission,
            "macOS has not allowed Nunchiro to read this folder.".into(),
            details(&blocked.path.display().to_string()),
        ));
    }
    (session.holder_status == Some(crate::api::HolderStatus::NeedsRestart)).then(|| {
        problem(
            Case::HolderRestart,
            "Needs restart after update.".into(),
            String::new(),
        )
    })
}

/// v1a-06: a remote machine's rows the last refresh could not renew (`error` is the transport's).
pub fn machine(alias: &str, error: &str) -> Problem {
    if error.contains("version mismatch") {
        problem(
            Case::VersionMismatch,
            format!("{alias} runs another Nunchiro version."),
            details(error),
        )
    } else {
        problem(
            Case::MachineUnreachable,
            format!("Can't reach {alias}."),
            details(error),
        )
    }
}

/// V1B-40: a set-aside `sessions.json` stays until the owner removes it; until then saved scrollback and exports are
/// not swept.
pub fn set_aside(home: &std::path::Path) -> Option<Problem> {
    // S9: every snapshot asks; the folder is listed again only when its mtime moved (any add, remove or rename).
    type Seen = std::collections::BTreeMap<std::path::PathBuf, (std::time::SystemTime, bool)>;
    static SEEN: std::sync::Mutex<Seen> = std::sync::Mutex::new(Seen::new());
    // Stamp first, then list: a change between the two moves the stamp again, so the next call lists anew.
    let stamp = std::fs::metadata(home).and_then(|m| m.modified()).ok();
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let aside = match (stamp, seen.get(home)) {
        (Some(t), Some((at, aside))) if *at == t => *aside,
        _ => {
            let aside = crate::store::kept_aside(home, "sessions.json");
            if let Some(t) = stamp {
                seen.insert(home.to_path_buf(), (t, aside));
            }
            aside
        }
    };
    drop(seen);
    aside.then(|| {
        problem(
            Case::SetAside,
            "A sessions.json of another version was set aside. Saved scrollback and exports are not cleaned up until you remove it.".into(),
            details(&home.display().to_string()),
        )
    })
}

/// V2-5b "Details" under V2-13b's allow-list: at most `DETAILS_LINES` lines, each a redacted log excerpt; login PTY
/// lines (OAuth links and pasted or device codes) are dropped whole, never shown masked.
pub fn details(text: &str) -> String {
    const LOGIN: &[&str] = &[
        "oauth",
        "code=",
        "paste code",
        "device",
        "authorize",
        "auth.openai.com",
        "login code",
        "enter the code",
    ];
    let kept: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let lower = line.to_lowercase();
            !LOGIN.iter().any(|l| lower.contains(l))
        })
        .map(crate::logs::excerpt)
        .collect();
    kept[kept.len().saturating_sub(DETAILS_LINES)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/problems/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// S9: the cached answer follows a set-aside store appearing and going away.
    #[test]
    fn set_aside_follows_the_folder() {
        let home = std::env::temp_dir().join(format!("s9aside{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        assert!(set_aside(&home).is_none());
        assert!(set_aside(&home).is_none());
        let aside = home.join("sessions.json.v9.1.aside");
        std::fs::write(&aside, b"{}").unwrap();
        assert!(set_aside(&home).is_some());
        std::fs::remove_file(&aside).unwrap();
        assert!(set_aside(&home).is_none());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn problem_details_redacted() {
        let log = String::from_utf8(fixture("details-login.log")).unwrap();
        let shown = details(&log);
        assert!(shown.contains("agent pid 4242 started"), "{shown}");
        assert!(shown.contains("core link ended"), "{shown}");
        assert!(shown.contains("[redacted:"), "{shown}");
        for secret in [
            "sk-ant-api03",
            "FAKEoauthCODE",
            "FAKEstate",
            "7Q2X-FAKE",
            "client_id",
            "Paste code",
        ] {
            assert!(!shown.contains(secret), "{secret} in {shown}");
        }
    }

    #[test]
    fn cases_from_fixtures() {
        let p = ended(
            AgentKind::Codex,
            &fixture("usage-limit-codex.bin"),
            Some(1),
            false,
        )
        .unwrap();
        assert_eq!(
            (p.case, p.reset.as_deref()),
            (Case::UsageLimit, Some("2:20 PM"))
        );
        assert_eq!(
            p.cause,
            "Codex usage limit reached. Resets 2:20 PM per Codex."
        );
        assert!(!p.cause.to_lowercase().contains("account"));
        let p = ended(
            AgentKind::Claude,
            &fixture("logged-out-claude.bin"),
            Some(0),
            false,
        )
        .unwrap();
        assert_eq!(
            (p.case, p.cause.as_str()),
            (Case::LoggedOut, "Claude is signed out.")
        );
        let p = ended(
            AgentKind::Codex,
            &fixture("logged-out-codex.bin"),
            None,
            false,
        )
        .unwrap();
        assert_eq!(p.case, Case::LoggedOut);
        // Recorded: codex-cli 0.161.0 with a fresh CODEX_HOME, ended by Ctrl-C; its sign-in was on the alternate
        // screen, which it left on exit (the main screen is empty).
        let p = ended(
            AgentKind::Codex,
            &fixture("logged-out-codex-real.bin"),
            Some(1),
            false,
        )
        .unwrap();
        assert_eq!(p.case, Case::LoggedOut);
        let p = ended(
            AgentKind::Codex,
            &fixture("hook-trust-codex.bin"),
            Some(2),
            false,
        )
        .unwrap();
        assert_eq!(p.case, Case::HookTrust);
        let p = ended(
            AgentKind::Claude,
            &fixture("unknown-exit.bin"),
            Some(3),
            false,
        )
        .unwrap();
        assert_eq!(
            (p.case, p.cause.as_str()),
            (
                Case::Unexpected,
                "Session ended unexpectedly (exit code 3)."
            )
        );
        assert!(
            p.details.contains("Claude exited with code 3."),
            "{}",
            p.details
        );
        let p = ended(AgentKind::Codex, b"", None, true).unwrap();
        assert_eq!(p.case, Case::Unexpected);
        let p = start_failed(
            AgentKind::Claude,
            "claude --version: No such file or directory (os error 2)",
        )
        .unwrap();
        assert_eq!(p.case, Case::NotInstalled);
    }

    #[test]
    fn clean_ends_and_shells_get_no_card() {
        assert_eq!(ended(AgentKind::Claude, b"bye\r\n", Some(0), false), None);
        assert_eq!(ended(AgentKind::Codex, b"", None, false), None);
        // A shell's screen is the user's own output: a pattern there is never read.
        assert_eq!(
            ended(
                AgentKind::Shell,
                &fixture("crafted-running.bin"),
                Some(1),
                false
            ),
            None
        );
        assert_eq!(
            start_failed(AgentKind::Claude, "claude --version: timed out"),
            None
        );
        // A clean exit after the agent merely discussed hook trust is no card.
        assert_eq!(
            ended(
                AgentKind::Codex,
                &fixture("hook-trust-codex.bin"),
                Some(0),
                false
            ),
            None
        );
        assert_eq!(
            start_failed(AgentKind::Shell, "sh --version: No such file"),
            None
        );
    }

    #[test]
    fn hook_trust_is_codex_only() {
        // Nunchiro passes Codex alone a hook trust flag; Claude printing the words is no hook card.
        let line = b"error: hook trust could not be written\r\n";
        let p = ended(AgentKind::Claude, line, Some(2), false).unwrap();
        assert_eq!(p.case, Case::Unexpected);
        assert_eq!(
            ended(AgentKind::Codex, line, Some(2), false).unwrap().case,
            Case::HookTrust
        );
    }

    #[test]
    fn hook_trust_needs_a_failed_exit_code() {
        // No code (a holder from before the exit code): the words alone are no hook card.
        assert_eq!(
            ended(
                AgentKind::Codex,
                &fixture("hook-trust-codex.bin"),
                None,
                false
            ),
            None
        );
        let p = ended(
            AgentKind::Codex,
            &fixture("hook-trust-codex.bin"),
            None,
            true,
        )
        .unwrap();
        assert_eq!(p.case, Case::Unexpected);
    }

    #[test]
    fn claude_signed_out_only_at_the_bottom_of_the_screen() {
        // Recorded through the core (claude 2.1.312, fresh CLAUDE_CONFIG_DIR, two Ctrl-C): exit 0, the login choice
        // 5 to 7 lines above the bottom.
        let p = ended(
            AgentKind::Claude,
            &fixture("logged-out-claude-core.bin"),
            Some(0),
            false,
        )
        .unwrap();
        assert_eq!(p.case, Case::LoggedOut);
        // A conversation that mentioned the words earlier, then ended cleanly: no card.
        let mut talk = b"Invalid API key is what the old error said\r\n".to_vec();
        for _ in 0..20 {
            talk.extend_from_slice(b"more work\r\n");
        }
        talk.extend_from_slice(b"bye\r\n");
        assert_eq!(ended(AgentKind::Claude, &talk, Some(0), false), None);
    }

    #[test]
    fn a_broken_stored_problem_loads_as_none() {
        let row = |problem: serde_json::Value| {
            serde_json::from_value::<crate::api::Session>(serde_json::json!({
                "id": "s", "kind": "claude", "project": "/p", "cwd": "/p", "label": "", "state": "exited",
                "agent_session_id": null, "agent_version": null, "untested": false, "pid": null, "problem": problem,
            }))
            .map(|s| s.problem)
        };
        assert_eq!(row(serde_json::json!("oops")).unwrap(), None);
        assert_eq!(
            row(serde_json::json!({"case": "acp_future", "cause": "x"})).unwrap(),
            None
        );
        assert_eq!(
            row(serde_json::json!({"case": "unexpected", "cause": 3})).unwrap(),
            None
        );
        let p = row(serde_json::json!({"case": "unexpected", "cause": "x"}))
            .unwrap()
            .unwrap();
        assert_eq!(p.case, Case::Unexpected);
    }

    #[test]
    fn kept_and_machine_cards() {
        let mut session: crate::api::Session = serde_json::from_value(serde_json::json!({
            "id": "s", "kind": "claude", "project": "/p", "cwd": "/p", "label": "", "state": "running",
            "agent_session_id": null, "agent_version": null, "untested": false, "pid": 1,
        }))
        .unwrap();
        assert_eq!(kept(&session), None);
        session.holder_status = Some(crate::api::HolderStatus::NeedsRestart);
        assert_eq!(kept(&session).unwrap().case, Case::HolderRestart);
        session.holder_status = Some(crate::api::HolderStatus::UpdateNunchiro);
        assert_eq!(
            kept(&session),
            None,
            "a newer holder keeps running: no card"
        );
        session.blocked = Some(crate::api::Blocked {
            reason: crate::api::BlockedReason::FileAccess,
            path: "/p".into(),
        });
        assert_eq!(kept(&session).unwrap().case, Case::FolderPermission);
        session.state = crate::api::SessionState::Exited;
        assert_eq!(kept(&session), None);
        assert_eq!(
            machine(
                "mini",
                "ssh: connect to host mini port 22: Connection refused"
            )
            .case,
            Case::MachineUnreachable
        );
        let p = machine("mini", "remote protocol version mismatch: 3 != 4");
        assert_eq!(
            (p.case, p.cause.as_str()),
            (Case::VersionMismatch, "mini runs another Nunchiro version.")
        );
    }

    #[test]
    fn reset_time_is_cut_on_the_line_itself_and_redacted() {
        // Lowercasing changes byte lengths ('İ' is 2 bytes, its lowercase 3): an index from it would cut mid-char.
        let line = "İİİİ You've hit your usage limit. Try again at 9:05 AM.";
        let p = ended(AgentKind::Codex, line.as_bytes(), Some(1), false).unwrap();
        assert_eq!(p.reset.as_deref(), Some("9:05 AM"));
        let line = "You've hit your usage limit. try again at sk-ant-api03-FAKEfakeFAKE0000.";
        let p = ended(AgentKind::Codex, line.as_bytes(), Some(1), false).unwrap();
        assert!(!p.cause.contains("sk-ant-api03"), "{}", p.cause);
    }

    #[test]
    fn usage_limit_never_suggests_another_account() {
        for line in [
            "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:05 AM.",
            "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.",
        ] {
            let p = ended(AgentKind::Codex, line.as_bytes(), Some(1), false).unwrap();
            assert_eq!(p.case, Case::UsageLimit);
            assert!(!p.cause.to_lowercase().contains("account"), "{}", p.cause);
        }
    }
}
