//! Reading an agent's terminal screen: the input box, dialogs, decisions and the permission footer.
use super::*;

/// v1a-24: the text in the agent's input box, or `None` when the screen does not show one. Claude 2.1.310 frames
/// its `❯` row (column 0) with full-width `─` rules, any wrapped or further lines indented between them; Codex
/// 0.161.0 draws `›` (column 0), indented lines, one blank row, then one or two indented footer rows to the end of
/// the screen, the first `<model> <effort> · <cwd>`. v1a-24 r2: a box with a choice under it (a row led by a
/// cursor or radio mark at any indent, a numbered option, both as `waiting::screen::choice_row` reads them; a
/// detected decision) or a mark row inside it is `None`: a dialog may be up. A Codex `›` row or line reading as a
/// numbered option is a menu. Known limits: a highlight-only cursor (no mark, number or phrase) or an unknown mark
/// (`▸`) is not seen, rows above the box are not read (a stale dialog in the transcript would block every
/// Enter), and a dialog drawn more than `SWITCH_SETTLE` after its box, with no output between, meets a settled box. The text is the mark row's (a paste shows its start
/// there); empty-box placeholders count as empty: Claude `Try "…"`, Codex "Ask Codex to do anything" and "Ask a
/// follow-up question".
pub(super) fn composer(screen: &str, kind: AgentKind) -> Option<String> {
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let codex = kind == AgentKind::Codex;
    let mark = if codex { '›' } else { '❯' };
    let at = rows.iter().rposition(|r| r.starts_with(mark))?;
    let below = &rows[at + 1..];
    let inner = below
        .iter()
        .take_while(|r| r.starts_with("  ") || !codex && r.is_empty())
        .count();
    // v1a-24 r3: the same marks and option rows `detect` reads as choices.
    let cursor = |r: &&str| r.trim_start().starts_with(waiting::screen::CHOICE_MARKS);
    let numbered = |r: &&str| waiting::screen::choice_row(r).is_some();
    let choice =
        |rows: &[&str]| rows.iter().any(|r| cursor(r) || numbered(r)) || decision(rows).is_some();
    // Ticket 1121: under the box, a usage ring row (`○ 6%`, `● 100%`: the mark, then a number with `%`) is no
    // choice; read as one, no box showed, every Enter was dropped and the next paste glued behind the last copy. Any
    // other marked row (`● Continue`) is a choice, as before.
    let ring = |r: &&str| {
        r.trim_start()
            .strip_prefix(['○', '●'])
            .map(str::trim_start)
            .is_some_and(|t| t.starts_with(|c: char| c.is_ascii_digit()) && t.contains('%'))
    };
    let footer_choice = |rows: &[&str]| {
        rows.iter().any(|r| cursor(r) && !ring(r) || numbered(r)) || decision(rows).is_some()
    };
    // The footer's own words, as Claude draws them in every permission mode.
    let footer_words = |r: &&str| {
        [
            "(shift+tab to cycle)",
            "? for shortcuts",
            "esc to interrupt",
        ]
        .iter()
        .any(|w| r.contains(w))
    };
    let rule = |r: &&str| !r.is_empty() && r.chars().all(|c| c == '─');
    // Look 11-17 v11 N11-S2-2: Claude 2.1.327 writes a named session's name (a resumed one has one) into the rule over
    // the box (`──── add-plan-txt-file ─`); the rule under it stays plain. Read as no box, a Stop never ended the turn.
    let top = |r: &str, bottom: &str| r == bottom || r.starts_with("──") && r.ends_with(" ─");
    let boxed = if codex {
        let footer = below.get(inner + 1..).unwrap_or_default();
        !numbered(&rows[at])
            && !choice(&below[..inner])
            && below.get(inner).is_some_and(|r| r.is_empty())
            && (1..=2).contains(&footer.len())
            && footer
                .iter()
                .all(|r| r.starts_with("  ") && !r.trim().is_empty())
            && footer[0].contains(" · ")
            && !choice(footer)
    } else {
        // Ticket 1121: a real 2.1.331 seat's screen as the core read it kept the top rule and the `❯` row but lost the
        // bottom rule (blank rows, then footer pieces: `◔ 30%  2  8`, `(shift+tab to cycle) · ← 2 agents`). With
        // the rule right above, an unnumbered row, nothing under it but indented or blank rows that hold no option, and
        // Claude's footer words among them, it is the box: read as none, every Enter there was dropped.
        let lost = at > 0
            && below.get(inner).is_none()
            && (rule(&rows[at - 1])
                || rows[at - 1].starts_with("──") && rows[at - 1].ends_with(" ─"))
            && !numbered(&rows[at])
            && below.iter().any(footer_words)
            && !footer_choice(below);
        at > 0
            && (below
                .get(inner)
                .is_some_and(|r| rule(r) && top(rows[at - 1], r))
                || lost)
            // With the rule lost the rows under the `❯` row are the footer: a ring there (`○ 6%`) is no cursor.
            && !below[..inner].iter().any(|r| cursor(r) && !(lost && ring(r)))
            && !footer_choice(below.get(inner + 1..).unwrap_or_default())
    };
    if !boxed {
        return None;
    }
    let line = rows[at][mark.len_utf8()..].trim();
    let placeholder = match kind {
        AgentKind::Codex => {
            ["Ask Codex to do anything", "Ask a follow-up question"].contains(&line)
        }
        _ => line.starts_with("Try \"") && line.ends_with('"'),
    };
    Some(if placeholder { "" } else { line }.into())
}

/// N1: every row of the text in the agent's input box, joined by spaces; `None` when `composer` reads no box.
pub(super) fn box_text(screen: &str, kind: AgentKind) -> Option<String> {
    let first = composer(screen, kind)?;
    let codex = kind == AgentKind::Codex;
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let at = rows
        .iter()
        .rposition(|r| r.starts_with(if codex { '›' } else { '\u{276f}' }))?;
    let more = rows[at + 1..].iter().take_while(|r| {
        if codex {
            r.starts_with("  ")
        } else {
            r.is_empty() || !r.chars().all(|c| c == '\u{2500}')
        }
    });
    Some(
        std::iter::once(first.as_str())
            .chain(more.map(|r| r.trim()))
            .collect::<Vec<_>>()
            .join(" "),
    )
}
/// N1: the box shows exactly the sent words (wrapped as the agent likes), or the placeholder of exactly that paste.
pub(super) fn same_words(shown: &str, sent: &str) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let shown = words(shown);
    shown == words(sent)
        || (shown.starts_with("[Pasted ") || shown.starts_with("[Image #"))
            && holds_paste(&shown, sent)
}

/// The rows of text in Claude's input box (0 when it shows none or only its placeholder): from its `❯` row down to the
/// rule under it.
pub(super) fn box_rows(screen: &str) -> usize {
    if composer(screen, AgentKind::Claude).is_none_or(|t| t.is_empty()) {
        return 0;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let Some(at) = rows.iter().rposition(|r| r.starts_with('\u{276f}')) else {
        return 0;
    };
    rows[at..]
        .iter()
        .take_while(|r| r.is_empty() || !r.chars().all(|c| c == '\u{2500}'))
        .count()
}

/// Look 11-17 N0: after an interrupt key, Claude is back at its input box and its footer no longer offers "esc to
/// interrupt" (the working footer of 2.1.326): the interrupted turn is over.
pub(super) fn interrupted_at_prompt(screen: &str) -> bool {
    composer(screen, AgentKind::Claude).is_some() && !screen.contains("esc to interrupt")
}

/// Ticket 991 (B1, C1): a dialog the queue may not know (Claude's "Switch model?", a trust question just drawn) is
/// on the screen: no input box, and in the last rows an indented cursor row, a marked numbered option, or a decision
/// the detector reads. A send typed now goes into the dialog and its Enter answers it, so it waits.
pub(super) fn dialog_up(screen: &str, kind: AgentKind) -> bool {
    if !matches!(kind, AgentKind::Claude | AgentKind::Codex) || composer(screen, kind).is_some() {
        return false;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let tail = &rows[rows.len().saturating_sub(12)..];
    tail.iter().any(|r| {
        waiting::screen::choice_row(r).is_some_and(|(_, _, marked)| marked)
            || r.starts_with(' ') && r.trim_start().starts_with(['❯', '›'])
    }) || decision(tail).is_some()
}

/// v1a-24: the decision (permission, question or dialog) `lines` show, as Claude's detection reads it. A
/// background line ("1 shell still running") is none, and it does not hide one beside it: the lines are read
/// again without it.
fn decision(lines: &[&str]) -> Option<waiting::screen::Detection> {
    let detect = |lines: &[&str]| {
        let mut part = waiting::screen::Screen::new(500, lines.len().max(1)); // wider than any observer row
        part.feed(lines.join("\r\n").as_bytes());
        part.detect(AgentKind::Claude).filter(|d| {
            matches!(
                d.kind,
                queue::Kind::Permission | queue::Kind::Question | queue::Kind::Dialog
            )
        })
    };
    detect(lines).or_else(|| {
        let rest: Vec<&str> = lines
            .iter()
            .copied()
            .filter(|l| {
                let l = l.to_lowercase();
                !l.contains("shell still running") && !l.contains("shells still running")
            })
            .collect();
        (rest.len() < lines.len()).then(|| detect(&rest)).flatten()
    })
}

/// v1a-20: the composer row holds the paste when, whitespace collapsed and a `…` elision mark trimmed, it is the
/// start of the paste (truncated or wrapped). v1a-24: the agents echo a paste's start, never its end, so a row
/// matching only the end (`Continue` for a prompt ending so) is a menu cursor.
/// v1a-20 r2: Claude 2.1.310 collapses a paste over 800 UTF-16 units or `max(0, min(rows - 10, 2))` newlines into
/// `[Pasted text #N]` (no newline) or `[Pasted text #N +L lines]` (L = its newlines); that exact row holds it. Any
/// newline counts as collapsible, since a short terminal collapses even one.
/// v1a-24: Codex 0.161.0 collapses a paste over 1000 chars into `[Pasted Content C chars]` (C = its chars,
/// newlines included); that exact row holds it.
/// Ticket 1094 r6: the box `row` is the dropped `paste` with exactly the words he typed since (`typed`) after or
/// before it, or alone. The paste shows as its own words or as Claude's placeholder for it ("[Pasted text #n +k
/// lines]", "[Pasted Content n chars]", "[Image #n]"). Words are whole: "hi" is not in "this", and a word he typed
/// glued to the paste ("hix") proves nothing.
pub(super) fn proven_copy(row: &str, paste: &str, typed: &str) -> bool {
    let box_words: Vec<&str> = row.split_whitespace().collect();
    let typed: Vec<&str> = typed.split_whitespace().collect();
    let paste_words = paste.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = typed.len();
    let rest = |r: &[&str]| {
        let r = r.join(" ");
        !r.is_empty()
            && (r == paste_words
                || r.starts_with('[') && r.ends_with(']') && holds_paste(&r, paste))
    };
    box_words.len() > n
        && (box_words.ends_with(&typed) && rest(&box_words[..box_words.len() - n])
            || box_words.starts_with(&typed) && rest(&box_words[n..]))
}
pub(super) fn holds_paste(row: &str, paste: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some(chars) = row
        .strip_prefix("[Pasted Content ")
        .and_then(|r| r.strip_suffix(" chars]"))
    {
        return digits(chars) && chars.parse() == Ok(paste.chars().count());
    }
    if let Some(rest) = row
        .strip_prefix("[Pasted text #")
        .and_then(|r| r.strip_suffix(']'))
    {
        let lines = paste.matches('\n').count();
        return match rest.split_once(" +") {
            None => digits(rest) && lines == 0 && paste.encode_utf16().count() > 800,
            Some((n, count)) => {
                digits(n)
                    && lines > 0
                    && count
                        .strip_suffix(" lines")
                        .is_some_and(|c| digits(c) && c.parse() == Ok(lines))
            }
        };
    }
    // Ticket 1087: a paste that is one image path and nothing else (the composer's image-only message) is drawn as
    // "[Image #N]" by Claude 2.1.330 and Codex 0.161; text with a path, or two paths, stays as typed. Unknown here, the
    // Enter was dropped and the message sat in the agent's box.
    if let Some(n) = row
        .strip_prefix("[Image #")
        .and_then(|r| r.strip_suffix(']'))
    {
        let path = paste.trim();
        return digits(n) && path.starts_with('/') && !path.contains('\n');
    }
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (row, paste) = (words(row.trim_matches('…')), words(paste));
    !row.is_empty() && paste.starts_with(&row)
}

/// v1a-22: a decision on `screen` other than the picker itself (its "Select model" line through its own
/// "Enter to set as default … Esc to cancel" hint), which a failing switch's Esc would answer. v1a-24: a background
/// line is no decision (it does not keep the picker open) and hides none (see `decision`).
pub(super) fn dialog_beside_picker(screen: &str) -> Option<waiting::screen::Detection> {
    let mut lines: Vec<&str> = screen.lines().collect();
    if let Some(top) = lines.iter().rposition(|l| l.trim() == "Select model")
        && let Some(end) = lines[top..].iter().position(|l| {
            let l = l.to_lowercase();
            // 2.1.310 ends the picker with its key hints, 2.1.318 draws none and ends it with the effort line.
            l.contains("enter to set as default") && l.contains("esc to cancel")
                || l.contains("effort") && l.contains("to adjust")
        })
    {
        // The picker alone reads as an unclassified prompt; anything else inside it is a dialog.
        let picker: Vec<&str> = lines.drain(top..=top + end).collect();
        if let Some(found) = decision(&picker).filter(|d| d.kind != queue::Kind::Dialog) {
            return Some(found);
        }
    }
    decision(&lines)
}

/// The lines' words in one lower-case run, so a sentence the terminal wrapped still reads whole.
pub(super) fn flat_words(lines: &[&str]) -> String {
    lines
        .iter()
        .flat_map(|l| l.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// CHAT-PERMCHIP: the permission mode in the footer Claude draws under its input box ("⏸ manual mode on",
/// "⏵⏵ accept edits on (shift+tab to cycle)", ...), or `None` when there is no box (see `composer`: a dialog or
/// choice also gives none), no footer row names a mode, or the name is one this build does not know. Claude 2.1.310.
pub(super) fn permission_mode(screen: &str, kind: AgentKind) -> Option<String> {
    if kind != AgentKind::Claude || composer(screen, kind).is_none() {
        return None;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let rule = rows
        .iter()
        .rposition(|r| !r.is_empty() && r.chars().all(|c| c == '─'))?;
    rows[rule + 1..].iter().find_map(|r| {
        let r = r.trim_start();
        let r = r.strip_prefix("⏵⏵ ").or_else(|| r.strip_prefix("⏸ "))?;
        let name = r.split(" on").next()?;
        [
            "manual",
            "accept edits",
            "plan",
            "auto",
            "bypass permissions",
        ]
        .into_iter()
        .find(|m| name == *m || name.strip_suffix(" mode") == Some(m))
        .map(String::from)
    })
}
