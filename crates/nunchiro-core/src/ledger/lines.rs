//! A task as plain lines, for a lead's brief and the CLI.
use super::*;

/// A task in a few plain lines, for a lead's brief and the CLI; `whole` (`task show`) gives a review note all its
/// lines, a list its first.
pub fn lines(v: &View, whole: bool) -> String {
    let t = &v.task;
    let mut out = format!("{} [{}", t.id, v.state);
    if v.stale {
        out += ", changed after the review";
    }
    out += &format!("] {}\n", t.title);
    for a in &t.accept {
        out += &format!("  accept: {a}\n");
    }
    for b in &v.blockers {
        out += &format!("  waits for {} \"{}\" ({})\n", b.id, b.title, b.stage);
    }
    if let Some(s) = &v.stuck {
        out += &format!("  asks: {s}\n");
    }
    if let Some(e) = &v.early {
        out += &format!("  {e}\n");
    }
    match v.waiters {
        0 => {}
        1 => out += "  1 task waits for this\n",
        n => out += &format!("  {n} tasks wait for this\n"),
    }
    for w in &t.worktrees {
        out += &format!("  worktree: {}\n", w.display());
    }
    for s in &t.seats {
        let live = if v.live.contains(&s.session) {
            "running"
        } else {
            "ended"
        };
        // Ticket 1081: a running seat's last activity, as the Team view shows it.
        let ago = match v.seen.get(&s.session) {
            Some(at) if v.live.contains(&s.session) => {
                match crate::queue::now_ms().saturating_sub(*at) / 60_000 {
                    0 => ", active now".to_string(),
                    m => format!(", active {m} min ago"),
                }
            }
            _ => String::new(),
        };
        // Ticket 1120: the account the seat runs on, when it is not the default one.
        let on = v
            .accounts
            .get(&s.session)
            .map_or(String::new(), |a| format!(", on {a}"));
        out += &format!(
            "  seat: {} · {} ({}, {live}{ago}{on})\n",
            s.role, s.name, s.session
        );
    }
    for n in &t.told {
        out += &format!("  the user told {}: \"{}\"\n", n.name, n.text);
    }
    for a in &v.asks {
        out += &format!("  open question: {a}\n");
    }
    if let Some(f) = &v.floor {
        out += &format!("  note: {f}\n");
    }
    // Ticket 1081: what the core's auto-advance saw.
    for s in &t.advance.stalled {
        out += &format!("  stalled: {} ({})\n", s.name, s.why);
    }
    match v.waits.as_deref() {
        Some("review") => out += "  waits: its report for a review\n",
        Some("merge") => out += "  waits: the merge\n",
        _ => {}
    }
    if let Some(r) = &t.review {
        let verdict = if r.pass { "pass" } else { "changes asked" };
        let mut parts = r.note.lines();
        let note = match parts.next() {
            None => String::new(),
            Some(first) if whole => {
                let rest: String = parts.map(|l| format!("\n    {l}")).collect();
                format!(": {first}{rest}")
            }
            Some(first) if parts.next().is_some() => {
                format!(": {first} (more: nunchiro task show {})", t.id)
            }
            Some(first) => format!(": {first}"),
        };
        out += &format!("  review by {}: {verdict}{note}\n", r.name);
    }
    for l in &t.learned {
        out += &format!("  lesson proposed by {}: {}\n", l.name, l.text);
    }
    if v.state == "merge" {
        out += "  the user said yes to merging these files\n";
    }
    if whole && let Some(o) = &t.ordered {
        out += &format!("  order set by {}\n", o.by);
    }
    if whole && let Some(p) = &v.package {
        out += &package::lines(p, &t.id);
    }
    out
}
