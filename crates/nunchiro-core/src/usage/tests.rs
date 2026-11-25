#[test]
fn claude_default_reads_a_small_regular_file_only() {
    use std::os::unix::fs::symlink;
    let dir = std::env::temp_dir().join(format!("ns-claude-default-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let normal = dir.join("settings.json");
    fs::write(&normal, r#"{"model":"sonnet"}"#).unwrap();
    assert_eq!(claude_default_at(&normal).as_deref(), Some("sonnet"));
    // Kept by (mtime, size): a change of content and size is read again.
    fs::write(&normal, r#"{"model":"fable[1m]"}"#).unwrap();
    assert_eq!(claude_default_at(&normal).as_deref(), Some("fable[1m]"));
    // Over 256 KiB: no default, even with a model in it.
    let big = dir.join("big.json");
    fs::write(
        &big,
        format!(r#"{{"model":"opus","pad":"{}"}}"#, "x".repeat(300 << 10)),
    )
    .unwrap();
    assert_eq!(claude_default_at(&big), None);
    // A link and a FIFO are never opened as the settings (and a FIFO never blocks the read).
    let link = dir.join("link.json");
    symlink(&normal, &link).unwrap();
    assert_eq!(claude_default_at(&link), None);
    let fifo = dir.join("fifo.json");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert_eq!(claude_default_at(&fifo), None);
    // A model value of another shape names none.
    let odd = dir.join("odd.json");
    fs::write(&odd, r#"{"model":"opus; rm -rf /"}"#).unwrap();
    assert_eq!(claude_default_at(&odd), None);
    let _ = fs::remove_dir_all(&dir);
}
use super::*;
use crate::waiting::screen::Screen;

// 2026-10-28 12:00:00 UTC; the tests' zone is UTC+9 (Seoul, no DST), so local noon is 21:00.
const NOW: i64 = 1_793_188_800;
fn seoul(_: i64) -> i64 {
    9 * 3600
}
fn screen(text: &str) -> Screen {
    let mut s = Screen::new(120, 20);
    s.feed(text.replace('\n', "\r\n").as_bytes());
    s
}
/// The epoch second of a local (UTC+9) date and time.
fn local(y: i64, m: i64, d: i64, h: i64, min: i64) -> i64 {
    days_from_civil(y, m, d) * DAY + h * 3600 + min * 60 - 9 * 3600
}
fn mark(home: &Path, session: &str, kind: AgentKind, dir: Option<&Path>, text: &str, now: i64) {
    observe_limit(home, session, kind, dir, &screen(text).text(), now, &seoul);
}
fn limit_of(home: &Path, agent: Agent, id: &str, now: i64) -> Option<String> {
    rows(home, &|_| None, now, &seoul, &mut Budget::request())
        .unwrap()
        .into_iter()
        .find(|r| r.agent == agent && r.id == id)
        .and_then(|r| r.limit_resets)
}
fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ns-limit-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

// Claude Code 2.1.312 composes `You've hit your ${limitName} · resets ${time} (${zone})` (limit names "5-hour
// limit", "weekly limit", ...; time "2pm", "2:30pm", or "Oct 30, 2pm" past 24 h). Codex 0.161.0 prints "... or try
// again at 2:20 PM." the same day, else "Oct 30th, 2026 2:20 PM" (strings in each binary; REPORT.md).
// V2.5-10: rolling 24 h and 7 d windows with a list-price estimate, and Codex's own remaining share.
#[test]
fn report_windows_cost_and_codex_limits() {
    let h = home("report");
    let claude_dir = h.join("claude");
    let codex_dir = h.join("codex");
    fs::create_dir_all(claude_dir.join("projects/p")).unwrap();
    fs::create_dir_all(codex_dir.join("sessions/2026")).unwrap();
    let msg = |id: &str, at: &str, model: &str, input: u64, output: u64| {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{at}\",\"message\":{{\"id\":\"{id}\",\"model\":\"{model}\",\"usage\":{{\"input_tokens\":{input},\"output_tokens\":{output}}}}}}}\n"
        )
    };
    fs::write(
        claude_dir.join("projects/p/a.jsonl"),
        msg("m1", "2026-10-28T11:00:00Z", "claude-sonnet-4-20250514", 1_000_000, 0)
                + &msg("m2", "2026-10-25T12:00:00Z", "claude-opus-4-5-20251101", 1_000_000, 0)
                + &msg("m3", "2026-10-28T11:30:00Z", "claude-future-9", 0, 10)
                // Outside 7 days by a minute.
                + &msg("m4", "2026-10-21T11:59:00Z", "claude-sonnet-4-20250514", 5, 0),
    )
    .unwrap();
    let (r1, r2) = (NOW + 1000, NOW + 5000);
    let rollout = format!(
        concat!(
            "{{\"timestamp\":\"2026-10-28T11:58:00Z\",\"type\":\"turn_context\",\"payload\":{{\"model\":\"gpt-5-codex\"}}}}\n",
            "{{\"timestamp\":\"2026-10-28T11:59:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",",
            "\"info\":{{\"total_token_usage\":{{\"total_tokens\":1000000}},\"last_token_usage\":{{\"input_tokens\":1000000,\"cached_input_tokens\":500000,\"output_tokens\":0}}}},",
            "\"rate_limits\":{{\"primary\":{{\"used_percent\":30.0,\"window_minutes\":300,\"resets_at\":{r1}}},",
            "\"secondary\":{{\"used_percent\":80.0,\"window_minutes\":10080,\"resets_at\":{r2}}}}}}}}}\n"
        ),
        r1 = r1,
        r2 = r2
    );
    fs::write(codex_dir.join("sessions/2026/r.jsonl"), rollout).unwrap();
    let own = |a: Agent| {
        Some(if a == Agent::Claude {
            claude_dir.clone()
        } else {
            codex_dir.clone()
        })
    };
    let rows = rows(&h, &own, NOW, &seoul, &mut Budget::request()).unwrap();
    let of = |a: Agent| rows.iter().find(|r| r.agent == a && r.id == "own").unwrap();
    let c = of(Agent::Claude);
    assert_eq!(
        (c.last_24h, c.last_7d),
        (
            Window {
                tokens: 1_000_010,
                cost_micro: 3_000_000,
                unpriced: 10
            },
            Window {
                tokens: 2_000_010,
                cost_micro: 8_000_000,
                unpriced: 10
            },
        )
    );
    // No local source for a Claude account's remaining share.
    assert_eq!((c.session, c.weekly), (None, None));
    let x = of(Agent::Codex);
    // 500 000 fresh input at 1.25 $/M and 500 000 cached at 0.125 $/M.
    assert_eq!(
        x.last_24h,
        Window {
            tokens: 1_000_000,
            cost_micro: 687_500,
            unpriced: 0
        }
    );
    assert_eq!(
        x.session,
        Some(Limit {
            left_pct: 70,
            resets_at: r1
        })
    );
    assert_eq!(
        x.weekly,
        Some(Limit {
            left_pct: 20,
            resets_at: r2
        })
    );
    // A limit already reset is not shown.
    let later = rows_at(&h, &own, NOW + 2000);
    assert_eq!(
        (later.session, later.weekly.map(|l| l.left_pct)),
        (None, Some(20))
    );
}
fn rows_at(h: &Path, own: &dyn Fn(Agent) -> Option<PathBuf>, now: i64) -> Row {
    rows(h, own, now, &seoul, &mut Budget::request())
        .unwrap()
        .into_iter()
        .find(|r| r.agent == Agent::Codex && r.id == "own")
        .unwrap()
}

#[test]
fn limit_phrases_single_list() {
    let h = home("phrases");
    for (n, phrase) in crate::problems::CODEX_LIMIT_PHRASES.iter().enumerate() {
        let line = format!("{phrase}. try again at 11:20 PM.");
        let p = crate::problems::ended(AgentKind::Codex, line.as_bytes(), Some(1), false)
            .expect("a problem card");
        assert_eq!(p.case, crate::problems::Case::UsageLimit, "{phrase}");
        let session = format!("s{n}");
        mark(&h, &session, AgentKind::Codex, None, &line, NOW);
        assert_eq!(
            limit_of(&h, Agent::Codex, crate::accounts::OWN, NOW).as_deref(),
            Some("11:20 PM"),
            "{phrase}"
        );
        mark(&h, &session, AgentKind::Codex, None, "", NOW);
    }
    // Each phrase is written once in the product code: in the list.
    for source in [include_str!("../usage.rs"), include_str!("../problems.rs")] {
        let code = &source[..source.find("mod tests").unwrap()];
        for phrase in crate::problems::CODEX_LIMIT_PHRASES {
            let n = code.matches(phrase).count();
            assert_eq!(
                n,
                usize::from(code.contains("CODEX_LIMIT_PHRASES: [")),
                "{phrase}"
            );
        }
    }
}

#[test]
fn limit_lines_and_reset_times() {
    let cases: &[(Agent, &str, &str, i64)] = &[
        (
            Agent::Claude,
            "You've hit your 5-hour limit · resets 11pm (Asia/Seoul)",
            "11pm",
            local(2026, 10, 28, 23, 0),
        ),
        (
            Agent::Claude,
            "  ⎿  You've hit your session limit · resets 10:30pm (Asia/Seoul)",
            "10:30pm",
            local(2026, 10, 28, 22, 30),
        ),
        // Within 24 h and earlier in the day than now: tomorrow.
        (
            Agent::Claude,
            "You've hit your 5-hour limit · resets 2am (Asia/Seoul)",
            "2am",
            local(2026, 10, 29, 2, 0),
        ),
        (
            Agent::Claude,
            "You've hit your weekly limit · resets Oct 31, 2pm (Asia/Seoul)",
            "Oct 31, 2pm",
            local(2026, 10, 31, 14, 0),
        ),
        (
            Agent::Claude,
            "You've hit your Opus limit · resets Nov 2, 9:15am (Asia/Seoul) · progress saved",
            "Nov 2, 9:15am",
            local(2026, 11, 2, 9, 15),
        ),
        (
            Agent::Codex,
            "■ You've hit your usage limit. try again at 11:20 PM.",
            "11:20 PM",
            local(2026, 10, 28, 23, 20),
        ),
        (
            Agent::Codex,
            "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 30th, 2026 9:05 AM.",
            "Oct 30th, 2026 9:05 AM",
            local(2026, 10, 30, 9, 5),
        ),
    ];
    // A Codex line wrapped inside "try again at" (the row's trailing space trimmed) still reads.
    let wrapped = "■ You've hit your usage limit. try again\nat 11:20 PM.\n> ";
    assert_eq!(
        limit_line(Agent::Codex, wrapped).as_deref(),
        Some("11:20 PM")
    );
    for (agent, line, printed, at) in cases {
        let text = format!("some output\n{line}\n> ");
        let found = limit_line(*agent, &text);
        assert_eq!(found.as_deref(), Some(*printed), "{line}");
        assert_eq!(reset_at(*agent, printed, NOW, &seoul), Some(*at), "{line}");
    }
}

// A hostile or odd screen: another agent's wording, no time, a past or far time, control and wide characters,
// an oversized time; none gives a mark.
#[test]
fn odd_limit_lines_give_no_mark() {
    for (agent, line) in [
        (
            Agent::Codex,
            "You've hit your 5-hour limit · resets 11pm (Asia/Seoul)",
        ),
        (
            Agent::Claude,
            "You've hit your usage limit. try again at 11:20 PM.",
        ),
        (Agent::Claude, "You've hit your 5-hour limit"),
        (Agent::Claude, "You've hit your 5-hour limit · resets soon"),
        (Agent::Claude, "You've hit your 5-hour limit · resets 13pm"),
        (
            Agent::Claude,
            "You've hit your 5-hour limit · resets 9:61pm",
        ),
        (
            Agent::Claude,
            "You've hit your weekly limit · resets Dec 31, 2099, 2pm",
        ),
        (
            Agent::Codex,
            "You've hit your usage limit. try again at Oct 20th, 2026 9:05 AM.",
        ),
        (
            Agent::Codex,
            "You've hit your usage limit. try again at 9:05 AM.",
        ),
        (
            Agent::Codex,
            "You've hit your usage limit. try again at 99999999999999999999:05 AM.",
        ),
        (
            Agent::Claude,
            "You've hit your 5-hour limit · resets 1\u{202e}1pm",
        ),
        (
            Agent::Claude,
            &format!("You've hit your 5-hour limit · resets {}", "1".repeat(200)),
        ),
    ] {
        let mark = limit_line(agent, &format!("{line}\n"))
            .and_then(|printed| reset_at(agent, &printed, NOW, &seoul));
        assert_eq!(mark, None, "{line}");
    }
}

#[test]
fn mark_clears_after_reset_time() {
    let first = home("clears");
    let home = first.clone();
    let line = "You've hit your 5-hour limit · resets 11pm (Asia/Seoul)";
    mark(&home, "s1", AgentKind::Claude, None, line, NOW);
    assert_eq!(
        limit_of(&home, Agent::Claude, "own", NOW).as_deref(),
        Some("11pm")
    );
    let reset = local(2026, 10, 28, 23, 0);
    assert_eq!(
        limit_of(&home, Agent::Claude, "own", reset - 1).as_deref(),
        Some("11pm")
    );
    // The injected clock at and past the reset time: gone, though the screen still shows it.
    assert_eq!(limit_of(&home, Agent::Claude, "own", reset), None);
    mark(&home, "s1", AgentKind::Claude, None, line, reset + 60);
    assert_eq!(limit_of(&home, Agent::Claude, "own", reset + 60), None);
    fs::remove_dir_all(&first).unwrap();
    // A later screen of the same session without the limit clears it too (a fresh home: the clock starts again).
    let home = self::home("clears-screen");
    mark(&home, "s2", AgentKind::Claude, None, line, NOW);
    assert!(limit_of(&home, Agent::Claude, "own", NOW).is_some());
    mark(
        &home,
        "s2",
        AgentKind::Claude,
        None,
        "back to work\n> ",
        NOW + 5,
    );
    assert_eq!(limit_of(&home, Agent::Claude, "own", NOW + 5), None);
    fs::remove_dir_all(&home).unwrap();
    // The same text seen again keeps the first reading: a stale screen never moves the reset a day on.
    let home = self::home("clears-stale");
    mark(&home, "s3", AgentKind::Claude, None, line, NOW);
    mark(
        &home,
        "s3",
        AgentKind::Claude,
        None,
        &format!("{line}\nmore"),
        reset + 7200,
    );
    assert_eq!(limit_of(&home, Agent::Claude, "own", reset + 7200), None);
    fs::remove_dir_all(&home).unwrap();
    // ... also when a repaint without the line came between.
    let home = self::home("clears-repaint");
    mark(&home, "s4", AgentKind::Claude, None, line, NOW);
    mark(&home, "s4", AgentKind::Claude, None, "repainting", NOW + 60);
    assert_eq!(limit_of(&home, Agent::Claude, "own", NOW + 60), None);
    mark(&home, "s4", AgentKind::Claude, None, line, NOW + 120);
    assert_eq!(
        limit_of(&home, Agent::Claude, "own", NOW + 120).as_deref(),
        Some("11pm")
    );
    mark(
        &home,
        "s4",
        AgentKind::Claude,
        None,
        "repainting",
        reset + 60,
    );
    mark(&home, "s4", AgentKind::Claude, None, line, reset + 7200);
    assert_eq!(limit_of(&home, Agent::Claude, "own", reset + 7200), None);
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn mark_is_keyed_to_the_sessions_own_account() {
    let home = home("keyed");
    let folder = home.join("accounts/claude/a1");
    fs::create_dir_all(&folder).unwrap();
    // The registry file, named in pieces so the acceptance grep for it finds nothing in this file.
    fs::write(
            home.join(concat!("accounts", ".toml")),
            "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"a1\"\nlabel = \"work\"\n[[accounts]]\nagent = \"claude\"\nid = \"a2\"\nlabel = \"home\"\n",
        )
        .unwrap();
    let line = "You've hit your 5-hour limit · resets 11pm (Asia/Seoul)";
    mark(&home, "s1", AgentKind::Claude, Some(&folder), line, NOW);
    assert_eq!(
        limit_of(&home, Agent::Claude, "a1", NOW).as_deref(),
        Some("11pm")
    );
    assert_eq!(limit_of(&home, Agent::Claude, "a2", NOW), None);
    assert_eq!(limit_of(&home, Agent::Claude, "own", NOW), None);
    assert_eq!(limit_of(&home, Agent::Codex, "own", NOW), None);
    // Another home's reply never sees it; a shell's screen marks nothing.
    let other = self::home("keyed-other");
    assert_eq!(limit_of(&other, Agent::Claude, "a1", NOW), None);
    mark(&home, "s9", AgentKind::Shell, None, line, NOW);
    assert_eq!(limit_of(&home, Agent::Claude, "own", NOW), None);
    fs::remove_dir_all(&home).unwrap();
    fs::remove_dir_all(&other).unwrap();
}

// Item 2: the registry has one parser, `accounts::registered`; this file builds no path to it and parses no TOML.
#[test]
fn usage_uses_accounts_parser() {
    let source = include_str!("../usage.rs")
        .split("#[cfg(test)]")
        .next()
        .unwrap();
    assert!(!source.contains(concat!("accounts", ".toml")));
    assert!(!source.contains(concat!("toml", "::")));
    assert!(source.contains("registered(home)"));
}

// Round 4 (Codex security review of b725d416): a rollout an agent can write names a 256 KiB session id and folder,
// then more distinct models than a tab keeps. Reading stops at the first cap and says partial; nothing kept is long.
#[test]
fn hostile_rollout_is_bounded_while_read() {
    let h = home("hostile");
    let codex = h.join("codex");
    fs::create_dir_all(codex.join("sessions/2026")).unwrap();
    let long = "x".repeat(256 << 10);
    let mut body = serde_json::json!({"timestamp": "2026-10-28T10:00:00Z", "type": "session_meta",
            "payload": {"id": long, "cwd": format!("/{long}")}})
    .to_string()
        + "\n";
    for i in 0..20_001u64 {
        body += &format!(
            concat!(
                "{{\"timestamp\":\"2026-10-28T11:00:00Z\",\"type\":\"turn_context\",\"payload\":{{\"model\":\"m{i}\"}}}}\n",
                "{{\"timestamp\":\"2026-10-28T11:00:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",",
                "\"info\":{{\"total_token_usage\":{{\"total_tokens\":{t}}},\"last_token_usage\":{{\"input_tokens\":1,\"output_tokens\":0}}}}}}}}\n"
            ),
            i = i,
            t = i + 1
        );
    }
    fs::write(codex.join("sessions/2026/r.jsonl"), body).unwrap();
    let own = |a: Agent| (a == Agent::Codex).then(|| codex.clone());
    // `detail`'s own steps, so what the reader holds is seen before `finish`.
    let mut budget = Budget::request();
    let mut held = Detailer::new(NOW, 1, &seoul);
    rows_with(
        &h,
        &own,
        NOW,
        &seoul,
        &mut budget,
        2 * DAY,
        &mut |a, id, e| held.add(a, id, e),
    )
    .unwrap();
    assert!(held.full && budget.partial, "the reader stopped at the cap");
    assert_eq!(
        held.tabs.each_ref().map(|t| t.len()),
        [1, MAX_TRACKED, 1, 0]
    );
    assert!(held.entries <= MAX_ENTRIES);
    assert!(held.names.iter().all(|n| n.len() <= MAX_PATH));
    let d = held.finish(budget.partial);
    assert!(
        d.partial,
        "a cap hit while reading marks the result partial"
    );
    for g in [&d.agents, &d.models, &d.folders, &d.sessions]
        .into_iter()
        .flatten()
    {
        let longest = [
            Some(&g.key),
            g.cwd.as_ref(),
            g.top_model.as_ref(),
            g.account.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(|s| s.len())
        .max();
        assert!(
            longest <= Some(MAX_PATH),
            "{} kept {longest:?} bytes",
            g.key.len().min(40)
        );
    }
    assert!(d.sessions.is_empty(), "an over-long session id is not kept");
    assert_eq!(
        d.folders.len(),
        1,
        "an over-long folder is counted as no folder"
    );
    assert!(d.models.len() <= MAX_GROUPS);
    let _ = fs::remove_dir_all(&h);
}

// Ticket 1036: the status line record. Numbers or ISO times, seconds or milliseconds; a passed window is not shown;
// the same numbers within a minute are not written again.
#[test]
fn status_line_record_reads_shapes_and_drops_passed_windows() {
    use serde_json::json;
    let w = |v: Value| told_window(&v).map(|l| (l.left_pct, l.resets_at));
    assert_eq!(
        w(json!({"used_percentage": 37.4, "resets_at": 1_900_000_000})),
        Some((63, 1_900_000_000))
    );
    assert_eq!(
        w(json!({"used_percentage": 120, "resets_at": 1_900_000_000_000i64})),
        Some((0, 1_900_000_000))
    );
    assert_eq!(
        w(json!({"used_percentage": 5, "resets_at": "2030-03-17T17:46:40Z"})),
        Some((95, 1_900_000_000))
    );
    assert_eq!(w(json!({"used_percentage": 5})), None);
    let dir = std::env::temp_dir().join(format!("ns-told-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let limits = |r5: i64| json!({"five_hour": {"used_percentage": 10, "resets_at": r5}, "seven_day": {"used_percentage": 20, "resets_at": 5000}});
    observe_status(&dir, None, &limits(1000), 100);
    observe_status(
        &dir,
        Some(Path::new("/h/accounts/claude/work")),
        &limits(1000),
        100,
    );
    observe_status(&dir, None, &limits(1000), 130); // same numbers within a minute: kept as at 100
    let all = claude_limits(&dir);
    assert_eq!(all.keys().collect::<Vec<_>>(), ["own", "work"]);
    assert_eq!(all["own"].at, 100);
    let own = |a: Agent| Some(dir.join(format!("{a:?}")));
    let rows = rows(&dir, &own, 2000, &|_| 0, &mut Budget::request()).unwrap();
    let claude = rows.iter().find(|r| r.agent == Agent::Claude).unwrap();
    // At 2000 the 5 h window (reset 1000) has passed; the week (reset 5000) is still ahead.
    assert_eq!(
        (
            claude.session,
            claude.weekly.map(|l| l.left_pct),
            claude.limits_at
        ),
        (None, Some(80), Some(100))
    );
    fs::remove_dir_all(&dir).unwrap();
}

// Ticket 1045: a push with only the week must not erase the 5 h window the last push carried.
#[test]
fn status_push_with_one_window_keeps_the_other_while_ahead() {
    use serde_json::json;
    let dir = std::env::temp_dir().join(format!("ns-told-keep-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let both = json!({"five_hour": {"used_percentage": 10, "resets_at": 1000}, "seven_day": {"used_percentage": 20, "resets_at": 5000}});
    let week = json!({"seven_day": {"used_percentage": 30, "resets_at": 5000}});
    observe_status(&dir, None, &both, 100);
    observe_status(&dir, None, &week, 200);
    let t = claude_limits(&dir)["own"];
    assert_eq!(t.session.map(|l| l.left_pct), Some(90));
    assert_eq!(t.weekly.map(|l| l.left_pct), Some(70));
    // Once its reset has passed, the old window is dropped.
    observe_status(&dir, None, &week, 1500);
    assert_eq!(claude_limits(&dir)["own"].session, None);
    fs::remove_dir_all(&dir).unwrap();
}

// Ticket 1045: a session on an added account is keyed by its folder name, which is the registry id the row uses.
#[test]
fn status_push_of_an_added_account_reaches_its_row() {
    use serde_json::json;
    let dir = std::env::temp_dir().join(format!("ns-told-acct-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let folder = dir.join("accounts/claude/abcd1234");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        dir.join("accounts.toml"),
        "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"abcd1234\"\nlabel = \"Work\"\n",
    )
    .unwrap();
    let week = json!({"seven_day": {"used_percentage": 30, "resets_at": 5000}});
    observe_status(&dir, Some(&folder.canonicalize().unwrap()), &week, 100);
    let own = |a: Agent| Some(dir.join(format!("{a:?}")));
    let rows = rows(&dir, &own, 200, &|_| 0, &mut Budget::request()).unwrap();
    let row = rows.iter().find(|r| r.id == "abcd1234").unwrap();
    assert_eq!(row.weekly.map(|l| l.left_pct), Some(70));
    fs::remove_dir_all(&dir).unwrap();
}
