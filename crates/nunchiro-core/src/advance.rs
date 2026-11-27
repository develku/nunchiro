//! Ticket 1081 part A (owner-approved "Team auto-advance"): the core sees a stalled seat, nudges it once, tells the
//! owner when the nudge did not help, and wakes the lead on a heartbeat when something waits. Part B: the core starts
//! the Reviewer of a done report (`review_plan`) and forwards its findings to the Builder. Part C (the merge step,
//! clean-up) adds its steps here.
//!
//! One thread, a pass about every `EVERY`: what the registry knows is read under its lock, then the ledger, the
//! reports and the room are read with no lock held, then each action is done under the lock again, right after `recheck` (security look 3: every start, close or
//! line into a session re-validates its own preconditions there, and a change means nothing is done). `plan` and
//! `beat` are pure (the clock is a parameter) and carry the rules; the rest only reads and acts.
use crate::ledger::{Advance, Ledger, Seat, Stalled, Task, View};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const EVERY_MS: u64 = 30_000;
const MIN: u64 = 60_000;
/// A queued row older than this is a stalled seat (rule 1a).
const QUEUED_MS: u64 = 5 * MIN;
/// An idle seat this quiet, its task open and no done report, is stalled (rule 1b).
const QUIET_MS: u64 = 20 * MIN;
/// A seat marked working with no activity this long counts as idle: a turn was seen marked working for hours.
const WORKING_QUIET_MS: u64 = 25 * MIN;
/// Still stalled this long after the nudge: the owner is asked (rule 3).
const CARD_MS: u64 = 5 * MIN;
/// The lead hears what waits at most this often (rule 4).
const BEAT_MS: u64 = 10 * MIN;
/// Done keys kept per task, newest last: enough for every seat's few stalls.
const DONE_KEPT: usize = 50;
/// Part B rule 3: review rounds forwarded to the Builder; one more "changes" asks the user instead.
const ROUNDS: u32 = 3;
/// Review SHOULD 2: failed Reviewer starts tried per revision; then the user is asked once.
const TRIES: usize = 3;
/// The review prompts: the quoted blocks of the guide's review.md, the one text the lead pastes too.
const REVIEW_MD: &str = include_str!("../../nunchiro/guides/orchestration/review.md");

/// What the registry knows about one seat's session now (`Sessions::seat_facts`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Facts {
    pub live: bool,
    pub working: bool,
    /// It waits for someone (a question or permission card, `agent ask --wait`): not stalled.
    pub waits: bool,
    /// Its last activity and its last start or prompt (ms).
    pub last: u64,
    pub since: u64,
    /// Its oldest queued send row: id and time.
    pub queued: Option<(String, u64)>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Act {
    /// Rule 2a: deliver the waiting row again.
    Resend {
        seat: String,
        name: String,
        row: String,
        why: String,
    },
    /// Rule 2b: one line to the quiet seat.
    Nudge {
        seat: String,
        name: String,
        minutes: u64,
    },
    /// Rule 3: the owner's card.
    Card {
        seat: String,
        name: String,
        why: String,
    },
    /// The seat moves again; `card`: the task's card goes with it.
    Moved {
        seat: String,
        name: String,
        card: bool,
    },
    /// Part B rule 2: start one fresh Reviewer (`name`, its seat's name) for the done report at `rev`.
    Staff { name: String, rev: String },
    /// Part B rule 3: the review's changes to the Builder, as review round `round`.
    Forward {
        seat: String,
        name: String,
        rev: String,
        round: u32,
        line: String,
    },
    /// Part B rule 3: a review asked for changes again after `ROUNDS` rounds: the user is asked.
    Rounds { seat: String, name: String },
    /// Review SHOULD 1: the Reviewer the core started recorded its verdict and ended its turn: it is closed.
    Close { seat: String, name: String },
}

pub(crate) fn nudge_line(minutes: u64) -> String {
    format!(
        "Lead: you have been quiet for {minutes} minutes with the task open; finish it or say what blocks you."
    )
}

/// The room line of each act, typed by the core.
fn room_line(act: &Act) -> String {
    match act {
        Act::Resend { name, why, .. } => {
            format!("core sent the waiting message to {name} again ({why})")
        }
        Act::Nudge { name, minutes, .. } => format!("core nudged {name} (quiet {minutes} min)"),
        Act::Card { name, why, .. } => format!("core asked the user about {name} ({why})"),
        Act::Moved { name, .. } => format!("core: {name} moves again"),
        Act::Staff { name, rev } => format!("core started {name} (report done at {})", short(rev)),
        Act::Forward { name, round, .. } => {
            format!("core sent the review's changes to {name} (round {round})")
        }
        Act::Rounds { name, .. } => {
            format!("core asked the user about {name} ({ROUNDS} review rounds without a pass)")
        }
        Act::Close { name, .. } => format!("core closed {name} (its review is recorded)"),
    }
}

/// A revision as a room line shows it: each worktree's commit cut to 9 characters.
fn short(rev: &str) -> String {
    rev.split(' ')
        .map(|r| r.chars().take(9).collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Part B rule 3: the Builder's one line about a review that asked for changes.
pub(crate) fn forward_line(by: &str, rev: &str, note: &str, round: u32) -> String {
    format!(
        "Review round {round} of {ROUNDS} asked for changes at {}: {note}. {by} sends you the full findings as a room \
         message (agent send): read them with `nunchiro agent check`, fix them, commit, and write REPORT.md again.",
        short(rev)
    )
}

/// Part B rule 2: review.md's prompt filled in for this task. `strict`: the security review's block too, for the same
/// one Reviewer. The findings go to the Builder by name, so the core's forwarded line can point at them.
pub(crate) fn review_prompt(
    strict: bool,
    worktree: &Path,
    branch: &str,
    base: &str,
    builder: &Seat,
) -> String {
    let mut blocks: Vec<String> = vec![];
    let mut open = false;
    for line in REVIEW_MD.lines() {
        match line.strip_prefix("> ") {
            Some(text) if open => {
                let last = blocks.last_mut().expect("an open block");
                last.push(' ');
                last.push_str(text);
            }
            Some(text) => blocks.push(text.into()),
            None => {}
        }
        open = line.starts_with("> ");
    }
    let take = if strict { 2 } else { 1 };
    let text = blocks
        .into_iter()
        .take(take)
        .collect::<Vec<_>>()
        .join("\n\nAt level strict you are also the security reviewer: ");
    format!(
        "{}\n\nBefore you record the verdict, send your full findings to {} with \
         `nunchiro agent send --to {} \"<findings>\"`.",
        text.replace("<lane-branch>", branch)
            .replace("<base>", base)
            .replace("<worktree>", &worktree.display().to_string()),
        builder.name,
        builder.session
    )
}

/// Part B rules 2-5 for one open task of a team or strict place (`way`), after part A's `plan` (`adv`). `rev` is the
/// task's revision now (`revision_of`), `free`: the place has a seat under its cap. `reported`: a seat's done report
/// since its last start or prompt.
pub(crate) fn review_plan(
    task: &Task,
    mut adv: Advance,
    way: &str,
    rev: Option<&str>,
    facts: &dyn Fn(&str) -> Facts,
    reported: &dyn Fn(&Facts) -> bool,
    free: bool,
) -> (Vec<Act>, Advance) {
    let mut acts = vec![];
    let writer = task.seats.iter().rev().find(|s| s.writes);
    let (Some(writer), Some(rev), true) = (
        writer,
        rev.filter(|r| !r.is_empty()),
        matches!(way, "team" | "strict"),
    ) else {
        adv.review.clear();
        return (acts, adv);
    };
    // Rule 3: a "changes" for the files as they are now goes to the Builder once.
    if let Some(r) = task
        .review
        .as_ref()
        .filter(|r| !r.pass && r.revision == rev)
    {
        let key = format!("forward:{rev}");
        if !adv.done.contains(&key) {
            adv.done.push(key);
            let (seat, name) = (writer.session.clone(), writer.name.clone());
            if adv.round < ROUNDS {
                adv.round += 1;
                acts.push(Act::Forward {
                    seat,
                    name,
                    rev: rev.into(),
                    round: adv.round,
                    line: forward_line(&r.name, rev, &r.note, adv.round),
                });
            } else if adv.round == ROUNDS {
                adv.round += 1;
                acts.push(Act::Rounds { seat, name });
            }
        }
    }
    // Review SHOULD 1: a Reviewer the core started is closed once its verdict is recorded and its turn is over.
    for s in task.seats.iter().filter(|s| !s.writes) {
        let f = facts(&s.session);
        let key = format!("closed:{}", s.session);
        if adv.done.contains(&format!("reviewer:{}", s.session))
            && task.review.as_ref().is_some_and(|r| r.by == s.session)
            && f.live
            && !f.working
            && !f.waits
            && !adv.done.contains(&key)
        {
            adv.done.push(key);
            acts.push(Act::Close {
                seat: s.session.clone(),
                name: s.name.clone(),
            });
        }
    }
    // Rule 2, and rule 5: a Reviewer still at work (or not yet started on its prompt) holds every new one.
    let reviewing = task.seats.iter().filter(|s| !s.writes).any(|s| {
        let f = facts(&s.session);
        f.live && (f.working || f.waits || f.queued.is_some() || f.last < s.at)
    });
    let turn_done = task.seats.iter().filter(|s| s.writes).all(|s| {
        let f = facts(&s.session);
        !(f.live && f.working)
    });
    let key = format!("review:{rev}");
    let due = !rev.contains('+')
        && task.review.as_ref().is_none_or(|r| r.revision != rev)
        && turn_done
        && reported(&facts(&writer.session))
        && !reviewing
        && !adv.done.contains(&key);
    if due && free {
        adv.done.push(key);
        adv.review = "started".into();
        acts.push(Act::Staff {
            name: crate::roles::seat_name("Reviewer", &task.title),
            rev: rev.into(),
        });
    } else if due {
        adv.review = "waits".into();
    } else if adv.review == "waits" || !reviewing {
        adv.review.clear();
    }
    let extra = adv.done.len().saturating_sub(DONE_KEPT);
    adv.done.drain(..extra);
    (acts, adv)
}

pub(crate) fn auto_line(on: bool) -> String {
    if on {
        "The user turned auto-advance on here: the core nudges a stalled seat, asks the user when that did not help, and tells you what waits.".into()
    } else {
        "The user turned auto-advance off here: the core no longer nudges seats or tells you what waits.".into()
    }
}

/// Why a live seat of open `task` is stalled now: (queued?, the stall's start, a plain reason). `excused`: it has a
/// done report since its last start, or an open ask in the room (read only when asked, it costs a file read).
fn stalled(
    task: &Task,
    seat: &Seat,
    f: &Facts,
    excused: &dyn Fn(&Seat, &Facts) -> bool,
    now: u64,
) -> Option<(bool, u64, String)> {
    if let Some((_, at)) = f.queued
        && now.saturating_sub(at) >= QUEUED_MS
    {
        let m = now.saturating_sub(at) / MIN;
        return Some((
            true,
            at,
            format!("a message has waited {m} min to be delivered"),
        ));
    }
    // A Reviewer that recorded its review is finished; a seat that never moved has no quiet to count.
    if f.waits || f.last == 0 || task.review.as_ref().is_some_and(|r| r.by == seat.session) {
        return None;
    }
    let quiet = now.saturating_sub(f.last);
    let limit = if f.working {
        WORKING_QUIET_MS
    } else {
        QUIET_MS
    };
    if quiet < limit || excused(seat, f) {
        return None;
    }
    Some((false, f.last, format!("quiet for {} min", quiet / MIN)))
}

/// Rules 1-3 for one open task: what to do now, and the task's record after it.
pub(crate) fn plan(
    task: &Task,
    facts: &dyn Fn(&str) -> Facts,
    excused: &dyn Fn(&Seat, &Facts) -> bool,
    now: u64,
) -> (Vec<Act>, Advance) {
    let mut adv = task.advance.clone();
    let mut acts = vec![];
    adv.stalled
        .retain(|s| task.seats.iter().any(|seat| seat.session == s.session));
    for seat in &task.seats {
        let f = facts(&seat.session);
        let why = f
            .live
            .then(|| stalled(task, seat, &f, excused, now))
            .flatten();
        let was = adv.stalled.iter().position(|s| s.session == seat.session);
        let (session, name) = (seat.session.clone(), seat.name.clone());
        match (why, was) {
            (None, None) => {}
            (None, Some(i)) => {
                let gone = adv.stalled.remove(i);
                let card = gone.card && !adv.stalled.iter().any(|s| s.card);
                acts.push(Act::Moved {
                    seat: session,
                    name,
                    card,
                });
            }
            (Some((queued, n, why)), None) => {
                let key = format!("nudge:{session}:{n}");
                if !adv.done.contains(&key) {
                    acts.push(match (&f.queued, queued) {
                        (Some((row, _)), true) => Act::Resend {
                            seat: session.clone(),
                            name: name.clone(),
                            row: row.clone(),
                            why: why.clone(),
                        },
                        _ => Act::Nudge {
                            seat: session.clone(),
                            name: name.clone(),
                            minutes: now.saturating_sub(n) / MIN,
                        },
                    });
                    adv.done.push(key);
                }
                adv.stalled.push(Stalled {
                    session,
                    name,
                    why,
                    n,
                    at: now,
                    card: false,
                });
            }
            (Some(_), Some(i)) => {
                let s = &mut adv.stalled[i];
                let key = format!("card:{session}:{}", s.n);
                if !s.card && now.saturating_sub(s.at) >= CARD_MS {
                    s.card = true;
                    if !adv.done.contains(&key) {
                        acts.push(Act::Card {
                            seat: session,
                            name,
                            why: s.why.clone(),
                        });
                        adv.done.push(key);
                    }
                }
            }
        }
    }
    let extra = adv.done.len().saturating_sub(DONE_KEPT);
    adv.done.drain(..extra);
    (acts, adv)
}

/// Rule 4: the lead's one line about what waits in its open tasks; none when nothing waits.
pub(crate) fn beat(views: &[View]) -> Option<String> {
    let open = || views.iter().filter(|v| v.task.closed.is_none());
    let review = open()
        .filter(|v| v.waits.as_deref() == Some("review"))
        .count();
    let merge = open()
        .filter(|v| v.waits.as_deref() == Some("merge"))
        .count();
    let stalled: usize = open().map(|v| v.task.advance.stalled.len()).sum();
    beat_line(review, merge, stalled)
}

/// The heartbeat's words for these counts. Ticket 1085: one of the automatic line forms the lead's chat folds
/// (`tests/fixtures/automatic-lines.json`, read by a core test and a web spec).
pub(crate) fn beat_line(review: usize, merge: usize, stalled: usize) -> Option<String> {
    let mut parts = vec![];
    if review > 0 {
        parts.push(match review {
            1 => "1 report waits for review".to_string(),
            n => format!("{n} reports wait for review"),
        });
    }
    if merge > 0 {
        parts.push(match merge {
            1 => "1 approved waits to merge".to_string(),
            n => format!("{n} approved wait to merge"),
        });
    }
    if stalled > 0 {
        parts.push(match stalled {
            1 => "1 seat stalled".to_string(),
            n => format!("{n} seats stalled"),
        });
    }
    (!parts.is_empty()).then(|| format!("Team: {}.", parts.join(", ")))
}

/// The core's auto-advance thread; it ends with the core.
pub(crate) fn spawn(
    registry: Arc<Mutex<crate::sessions::Sessions>>,
    home: PathBuf,
    stopping: Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("advance".into())
        .spawn(move || {
            let mut beats = BTreeMap::new();
            let mut last = 0;
            while !stopping.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let now = crate::queue::now_ms();
                if now.saturating_sub(last) < EVERY_MS {
                    continue;
                }
                last = now;
                if let Err(e) = pass(&registry, &home, &mut beats, now) {
                    eprintln!("auto-advance: {e}");
                }
            }
        })
}

/// The open tasks of a lead in a place whose auto-advance is on (rule 5: off, the module does nothing there).
fn watched(ledger: &Ledger) -> Result<Vec<Task>, String> {
    let tasks: Vec<Task> = ledger
        .list()?
        .into_iter()
        .filter(|t| t.closed.is_none() && t.lead.is_some())
        .collect();
    let places: BTreeSet<PathBuf> = tasks.iter().map(|t| t.place.clone()).collect();
    let auto: BTreeSet<PathBuf> = places
        .into_iter()
        .filter(|p| ledger.place(p).auto)
        .collect();
    Ok(tasks
        .into_iter()
        .filter(|t| auto.contains(&t.place))
        .collect())
}

/// Its worktree's REPORT.md says `STATUS: done`, written since its last start or prompt.
fn reported(f: &Facts) -> bool {
    crate::sessions::report_status(&f.cwd, f.since).is_some_and(|s| s.starts_with("STATUS: done"))
}

/// Review NOTE: the live seats of `place` against its cap: the seats of every task there, open or closed, and the
/// tasks' leads, each once.
fn live_seats(
    all: &[Task],
    place: &Path,
    live: &dyn Fn(&str) -> bool,
    lead_seat: &dyn Fn(&str) -> Option<String>,
) -> usize {
    let here = || all.iter().filter(|t| t.place == place);
    here()
        .flat_map(|t| t.seats.iter().map(|s| s.session.clone()))
        .chain(here().filter_map(|t| lead_seat(t.lead.as_deref()?)))
        .filter(|s| live(s))
        .collect::<BTreeSet<_>>()
        .len()
}

/// Review SHOULD 2: a failed Reviewer start (`counted`) is tried again on the next pass, at most `TRIES` times per
/// revision; at the last one its key stays and the user is asked once (true). A start skipped because the task is no
/// longer due counts no try.
fn start_failed(adv: &mut Advance, rev: &str, counted: bool) -> bool {
    adv.review.clear();
    let tried = format!("tried:{rev}");
    if counted {
        adv.done.push(tried.clone());
    }
    if adv.done.iter().filter(|k| **k == tried).count() >= TRIES {
        return true;
    }
    let key = format!("review:{rev}");
    adv.done.retain(|k| *k != key);
    false
}

/// What the core is about to do in a session, for `recheck`.
pub(crate) enum Step<'a> {
    /// Part B: start the Reviewer (the cap too).
    Start,
    /// Part B: type the started Reviewer's first prompt.
    Prompt,
    /// Part A rule 4: the heartbeat line to the lead about this task's place.
    Beat,
    /// A planned act; `was`: what `pass` read of its seat for the plan; `rev`: for a Close, the task's revision read
    /// again (git, so off the lock) just before the lock.
    Act {
        act: &'a Act,
        was: &'a Facts,
        rev: Option<&'a str>,
    },
}

/// Security look 3: the module's one gate. Every act that starts, closes or writes into a session runs it under the
/// registry lock immediately before it acts (`in_core`, `act`): `pass` planned from older reads, and when a fact the
/// act stands on changed since (a follow-up, auto-advance off, the task closed, the lead's token revoked), nothing is
/// done and a later pass plans again.
pub(crate) fn recheck(
    sessions: &crate::sessions::Sessions,
    task: &Task,
    lead: &str,
    step: &Step,
) -> Result<(), String> {
    let ledger = Ledger::open(sessions.home());
    let all = ledger.list()?;
    let now = all
        .iter()
        .find(|t| t.id == task.id)
        .ok_or("skipped: the task is gone")?;
    let place = ledger.place(&now.place);
    let live = |s: &str| sessions.seat_facts(s).live;
    let lead_seat = |l: &str| sessions.seat_of(l);
    let part_b = !matches!(
        step,
        Step::Beat
            | Step::Act {
                act: Act::Nudge { .. } | Act::Resend { .. },
                ..
            }
    );
    let why = if now.closed.is_some() {
        "the task was closed"
    } else if !place.auto {
        "auto-advance was turned off"
    } else if part_b && !matches!(place.way.as_str(), "team" | "strict") {
        "the way of working is no longer team or strict"
    } else if now.lead != task.lead
        || now.lead.as_deref().and_then(lead_seat).as_deref() != Some(lead)
    {
        "the lead's seat is not running"
    } else if sessions.core_may(lead).is_err() {
        // The lead's token revoked: the core acts with the lead's authority, so it acts no more.
        "the lead's seat may not be acted for (its token was revoked)"
    } else {
        match step {
            Step::Start
                if live_seats(&all, &now.place, &live, &lead_seat) >= place.cap as usize =>
            {
                "the place is at its seat cap"
            }
            Step::Act {
                act: Act::Nudge { seat, .. },
                was,
                ..
            } if moved(&sessions.seat_facts(seat), was) => "the seat moved since the plan",
            Step::Act {
                act: Act::Resend { seat, row, .. },
                ..
            } if sessions.seat_facts(seat).queued.map(|q| q.0).as_ref() != Some(row) => {
                "the message is no longer the one waiting"
            }
            Step::Act {
                act: Act::Forward { seat, rev, .. },
                ..
            } if now
                .seats
                .iter()
                .rev()
                .find(|s| s.writes)
                .map(|s| &s.session)
                != Some(seat)
                || !now
                    .review
                    .as_ref()
                    .is_some_and(|r| !r.pass && r.revision == *rev) =>
            {
                "the review changed since the plan"
            }
            Step::Act {
                act: Act::Close { seat, .. },
                rev,
                ..
            } if !now
                .review
                .as_ref()
                .is_some_and(|r| r.by == *seat && Some(r.revision.as_str()) == *rev) =>
            {
                "its verdict is not for the files as they are now"
            }
            _ => return Ok(()),
        }
    };
    Err(format!("skipped: {why}"))
}

/// A planned act, done only when `recheck` passes under the same lock right before it. A Resend the delivery checks
/// canceled adds its seat to `refused`. Owner cards (Card, Moved, Rounds) start, close and type nothing.
pub(crate) fn act(
    sessions: &mut crate::sessions::Sessions,
    task: &Task,
    lead: &str,
    act: &Act,
    was: &Facts,
    rev: Option<&str>,
    refused: &mut Vec<String>,
) -> Result<(), String> {
    if matches!(
        act,
        Act::Resend { .. } | Act::Nudge { .. } | Act::Forward { .. } | Act::Close { .. }
    ) {
        recheck(sessions, task, lead, &Step::Act { act, was, rev })?;
    }
    match act {
        Act::Resend { seat, row, .. } => match sessions.resend_queued(seat, row) {
            Ok(false) => {
                refused.push(seat.clone());
                Err("the delivery checks refused the waiting message and canceled it".into())
            }
            r => r.map(drop),
        },
        Act::Nudge { seat, minutes, .. } => sessions.core_line(seat, nudge_line(*minutes)),
        Act::Card { seat, name, why } => {
            sessions.stall_card(
                &check_in(task, seat, name, format!("{why}, still after one nudge")),
                true,
            );
            Ok(())
        }
        Act::Moved {
            seat,
            name,
            card: true,
        } => {
            sessions.stall_card(&check_in(task, seat, name, String::new()), false);
            Ok(())
        }
        Act::Moved { .. } => Ok(()),
        Act::Forward { seat, line, .. } => sessions.core_line(seat, line.clone()),
        Act::Rounds { seat, name } => {
            sessions.stall_card(
                &check_in(
                    task,
                    seat,
                    name,
                    format!("{ROUNDS} review rounds without a pass"),
                ),
                true,
            );
            Ok(())
        }
        Act::Close { seat, .. } => close_guarded(sessions, seat, was, false),
        Act::Staff { .. } => Err("a Reviewer is started by staff".into()),
    }
}

/// Part A's stall rule: the seat did nothing since `was` (no turn, no activity, no question).
fn moved(f: &Facts, was: &Facts) -> bool {
    !f.live || f.waits || f.working != was.working || f.last != was.last || f.since != was.since
}

/// The core's one close of a session (review Close, and a Reviewer whose first prompt was not typed), under the lock:
/// only a seat that did nothing since `was` and holds no input. `fresh`: nothing ever went into its input box
/// (`seat_untouched`); else a turn ended since its last input (`seat_idle`). Sessions::close stops the process and
/// drops composed text, so any doubt leaves the seat open.
fn close_guarded(
    sessions: &mut crate::sessions::Sessions,
    seat: &str,
    was: &Facts,
    fresh: bool,
) -> Result<(), String> {
    let idle = if fresh {
        sessions.seat_untouched(seat)
    } else {
        sessions.seat_idle(seat)
    };
    if moved(&sessions.seat_facts(seat), was) || !idle {
        return Err("skipped: the Reviewer has work or input since the plan".into());
    }
    sessions.close(seat, false, false).map(drop)
}

/// Security look 4: the Reviewer `staff` started whose first prompt was not typed is closed only through
/// `close_guarded`; one the user typed into or started work in since its start (`was`) stays open, and the room says
/// so.
pub(crate) fn unprompted(
    registry: &Mutex<crate::sessions::Sessions>,
    home: &Path,
    task: &Task,
    lead: &str,
    id: &str,
    was: &Facts,
) {
    let closed = registry
        .lock()
        .map_err(|_| "session registry unavailable".to_string())
        .and_then(|mut sessions| close_guarded(&mut sessions, id, was, true));
    match closed {
        Ok(()) => {}
        Err(e) if e.starts_with("skipped") => {
            let name = crate::roles::seat_name("Reviewer", &task.title);
            let line = format!("core left {name} open: it was used");
            if let Err(e) = crate::room::Log::open(home, &task.place).team(
                lead,
                line.clone(),
                team_note(&line, Some(id)),
            ) {
                eprintln!("auto-advance: room line not written: {e}");
            }
        }
        Err(e) => eprintln!("auto-advance: the unprompted Reviewer {id} was not closed: {e}"),
    }
}

/// A skipped act is planned again by a later pass: its done key goes.
fn undo(adv: &mut Advance, act: &Act) {
    match act {
        Act::Nudge { seat, .. } | Act::Resend { seat, .. } => {
            if let Some(i) = adv.stalled.iter().position(|s| s.session == *seat) {
                let key = format!("nudge:{seat}:{}", adv.stalled.remove(i).n);
                adv.done.retain(|k| *k != key);
            }
        }
        Act::Forward { rev, .. } => {
            let key = format!("forward:{rev}");
            adv.done.retain(|k| *k != key);
            adv.round = adv.round.saturating_sub(1);
        }
        Act::Close { seat, .. } => {
            let key = format!("closed:{seat}");
            adv.done.retain(|k| *k != key);
        }
        _ => {}
    }
}

fn beat_due(last: Option<u64>, now: u64) -> bool {
    last.is_none_or(|at| now.saturating_sub(at) >= BEAT_MS)
}

/// The seats that wait for an answer to their open ask in the place's room.
fn open_asks(home: &Path, place: &Path) -> BTreeSet<String> {
    let all = crate::room::Log::open(home, place)
        .read()
        .unwrap_or_default();
    all.iter()
        .filter(|m| m.kind == crate::room::Kind::Ask && crate::sessions::open_ask(&all, m))
        .map(|m| m.from.clone())
        .collect()
}

/// One pass. `beats`: when each place's lead last heard a heartbeat (memory only: a restart may send one early).
pub(crate) fn pass(
    registry: &Mutex<crate::sessions::Sessions>,
    home: &Path,
    beats: &mut BTreeMap<PathBuf, u64>,
    now: u64,
) -> Result<(), String> {
    let ledger = Ledger::open(home);
    let tasks = watched(&ledger)?;
    let all = ledger.list()?;
    // Under the lock: the leads' seats, what each seat does now, and (part B rule 4) each place's live seats.
    let (leads, facts, mut busy) = {
        let sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        let leads: BTreeMap<String, String> = tasks
            .iter()
            .filter_map(|t| t.lead.as_ref())
            .filter_map(|l| Some((l.clone(), sessions.seat_of(l)?)))
            .collect();
        let facts: BTreeMap<String, Facts> = tasks
            .iter()
            .flat_map(|t| &t.seats)
            .map(|s| (s.session.clone(), sessions.seat_facts(&s.session)))
            .collect();
        let live = |s: &str| sessions.seat_facts(s).live;
        let lead_seat = |l: &str| sessions.seat_of(l);
        let busy: BTreeMap<PathBuf, usize> = tasks
            .iter()
            .map(|t| {
                (
                    t.place.clone(),
                    live_seats(&all, &t.place, &live, &lead_seat),
                )
            })
            .collect();
        (leads, facts, busy)
    };
    let lead_of = |t: &Task| t.lead.as_ref().and_then(|l| leads.get(l)).cloned();
    let mut asks: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    for task in tasks.iter().filter(|t| lead_of(t).is_some()) {
        let lead = lead_of(task).unwrap_or_default();
        let asks = std::cell::RefCell::new(&mut asks);
        let excused = |seat: &Seat, f: &Facts| {
            reported(f)
                || asks
                    .borrow_mut()
                    .entry(task.place.clone())
                    .or_insert_with(|| open_asks(home, &task.place))
                    .contains(&seat.session)
        };
        let fact = |s: &str| facts.get(s).cloned().unwrap_or_default();
        let (acts, adv) = plan(task, &fact, &excused, now);
        // Part B, its git read with no lock held.
        let place = ledger.place(&task.place);
        let rev = matches!(place.way.as_str(), "team" | "strict")
            .then(|| crate::ledger::revision_of(task))
            .flatten();
        let free = busy.get(&task.place).copied().unwrap_or(0) < place.cap as usize;
        let (more, adv) = review_plan(
            task,
            adv,
            &place.way,
            rev.as_deref(),
            &fact,
            &reported,
            free,
        );
        let acts: Vec<Act> = acts.into_iter().chain(more).collect();
        if adv != task.advance {
            ledger.set_advance(&task.id, adv.clone())?;
        }
        let saved = adv.clone();
        let mut adv = adv;
        if acts.is_empty() {
            continue;
        }
        // Security look 3: a Close stands on the verdict's revision, read again (git, so off the lock) right before it.
        let rev_now = acts
            .iter()
            .any(|a| matches!(a, Act::Close { .. }))
            .then(|| crate::ledger::revision_of(task))
            .flatten();
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        // Seats whose waiting row the delivery checks canceled: that row stalls them no more.
        let mut refused = vec![];
        for a in &acts {
            if matches!(a, Act::Staff { .. }) {
                continue; // started below, with no lock held
            }
            let seat = match a {
                Act::Resend { seat, .. } | Act::Nudge { seat, .. } | Act::Close { seat, .. } => {
                    fact(seat)
                }
                _ => Facts::default(),
            };
            match act(
                &mut sessions,
                task,
                &lead,
                a,
                &seat,
                rev_now.as_deref(),
                &mut refused,
            ) {
                Ok(()) => note(home, &task.place, &lead, a, None),
                // Nothing was done: no room line; a later pass plans it again.
                Err(e) if e.starts_with("skipped") => {
                    eprintln!("auto-advance: task {}: {e}", task.id);
                    undo(&mut adv, a);
                }
                // The room says what happened: an act that failed says so with its reason (review SHOULD 1).
                Err(e) => {
                    eprintln!("auto-advance: task {}: {e}", task.id);
                    note(home, &task.place, &lead, a, Some(&e));
                }
            }
        }
        drop(sessions);
        for act in &acts {
            let Act::Staff { rev, .. } = act else {
                continue;
            };
            match staff(registry, home, task, &lead, rev, place.way == "strict") {
                Ok(id) => {
                    *busy.entry(task.place.clone()).or_default() += 1;
                    adv.done.push(format!("reviewer:{id}"));
                    note(home, &task.place, &lead, act, None);
                }
                Err(e) => {
                    // A memory hold has its own once-per-task line (`pressure::check_once`).
                    if !e
                        .strip_prefix("skipped: ")
                        .is_some_and(crate::pressure::is_held)
                    {
                        eprintln!("auto-advance: task {}: {e}", task.id);
                    }
                    if !e.starts_with("skipped") {
                        note(home, &task.place, &lead, act, Some(&e));
                    }
                    if start_failed(&mut adv, rev, !e.starts_with("skipped"))
                        && let Some(w) = task.seats.iter().rev().find(|s| s.writes)
                    {
                        let why =
                            format!("the core could not start its Reviewer {TRIES} times: {e}");
                        registry
                            .lock()
                            .map_err(|_| "session registry unavailable")?
                            .stall_card(&check_in(task, &w.session, &w.name, why), true);
                    }
                }
            }
        }
        adv.stalled.retain(|s| !refused.contains(&s.session));
        if adv != saved {
            ledger.set_advance(&task.id, adv)?;
        }
        crate::events::tasks(&task.place);
    }
    // Rule 4: per place with a live lead, at most every BEAT_MS, only when something waits.
    let mut by_place: BTreeMap<(PathBuf, String), Vec<Task>> = BTreeMap::new();
    for t in tasks {
        if let Some(lead) = lead_of(&t) {
            by_place.entry((t.place.clone(), lead)).or_default().push(t);
        }
    }
    for ((place, lead), tasks) in by_place {
        if !beat_due(beats.get(&place).copied(), now) {
            continue;
        }
        // Re-read: this pass may have changed the stalled seats.
        let ids: BTreeSet<String> = tasks.iter().map(|t| t.id.clone()).collect();
        let fresh = ledger
            .list()?
            .into_iter()
            .filter(|t| ids.contains(&t.id))
            .collect();
        let Some(line) = beat(&crate::ledger::views(registry, home, fresh)?) else {
            continue;
        };
        let sent = {
            let mut sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            // Security look 4: the heartbeat goes through the one gate too, for any of its tasks still due.
            let due = tasks
                .iter()
                .map(|t| recheck(&sessions, t, &lead, &Step::Beat))
                .find(Result::is_ok)
                .unwrap_or_else(|| Err("skipped: no task of the place is still due".into()));
            due.and_then(|()| sessions.core_line(&lead, line.clone()))
        };
        // A skipped heartbeat waits its 10 minutes too: the log says so once then, not every pass.
        beats.insert(place.clone(), now);
        match sent {
            Ok(()) => {
                let said = format!("core told the lead: {line}");
                if let Err(e) = crate::room::Log::open(home, &place).team(
                    &lead,
                    said.clone(),
                    team_note(&said, None),
                ) {
                    eprintln!("auto-advance: room line not written: {e}");
                }
            }
            Err(e) => eprintln!("auto-advance: heartbeat to {lead} not sent ({e})"),
        }
    }
    Ok(())
}

/// Part B rule 2: one fresh Reviewer through the lead's own staffing path (`staff_plan` with its level floor, then
/// `seat_up`); `in_core` runs the steps. The started session; a seat that started but did not get its prompt is closed.
fn staff(
    registry: &Mutex<crate::sessions::Sessions>,
    home: &Path,
    task: &Task,
    lead: &str,
    rev: &str,
    strict: bool,
) -> Result<String, String> {
    let plan = crate::ledger::staff_plan(registry, home, task, "Reviewer", None, None, None, None)?;
    let crate::api::Reply::Staff {
        folder: Some(worktree),
        ..
    } = &plan
    else {
        return Err("the task has no worktree to review".into());
    };
    let builder = task
        .seats
        .iter()
        .rev()
        .find(|s| s.writes)
        .ok_or("the task has no Builder")?;
    let head = |dir: &Path| {
        crate::process::git_read(
            dir,
            &["rev-parse", "--abbrev-ref", "HEAD"],
            std::time::Duration::from_secs(10),
        )
        .ok()
        .and_then(|out| String::from_utf8(out).ok())
        .map(|s| s.trim().to_string())
    };
    let branch = head(worktree).unwrap_or_else(|| "HEAD".into());
    // shortcut: the base is the project's checked-out branch (main when it is detached); the brief names the real
    // base when it differs. Upgrade when a worktree record keeps its base.
    let base = head(&task.place)
        .filter(|b| b != "HEAD")
        .unwrap_or_else(|| "main".into());
    let prompt = review_prompt(strict, worktree, &branch, &base, builder);
    let mut started = None;
    let done = crate::ledger::seat_up(plan, Some(prompt), &mut |r| {
        let reply = in_core(registry, task, lead, rev, r);
        if let Ok(crate::api::Reply::Started { session }) = &reply {
            // What the seat looked like at its start; the cleanup closes it only while it is unchanged.
            let was = registry
                .lock()
                .map(|s| s.seat_facts(&session.id))
                .unwrap_or_default();
            started = Some((session.id.clone(), was));
        }
        reply
    });
    match (done, started) {
        (Ok((_, session, _)), _) => Ok(session.id),
        (Err(e), Some((id, was))) => {
            unprompted(registry, home, task, lead, &id, &was);
            Err(e)
        }
        (Err(e), None) => Err(e),
    }
}

/// `seat_up`'s steps as the core runs them. Review MUST 1: the start is the lead's own `task staff` start: on the lead's
/// account (`launch_as`), through `start_granted` (its account check, its seat on the task, the lead as parent), never
/// on the owner's default account. Review MUST 2: `recheck` under the lock right before the start and the prompt, the
/// revision read again (git, so off the lock) just before that lock; any change starts nothing. The level; the first
/// prompt only through `core_line`.
pub(crate) fn in_core(
    registry: &Mutex<crate::sessions::Sessions>,
    task: &Task,
    lead: &str,
    rev: &str,
    request: crate::api::Request,
) -> crate::api::Response {
    use crate::api::{Reply, Request};
    let lock = || {
        registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())
    };
    match request {
        Request::Start {
            session, folder, ..
        } => {
            // Held under memory pressure as "skipped": a later pass plans it again, and no try is counted.
            // Logged once per task until it starts or the level changes: a pass retries it every 30 s.
            let who = crate::pressure::Who::Session;
            crate::pressure::check_once(&session, who, "reviewer", &task.id)
                .map_err(|e| format!("skipped: {e}"))?;
            // The Reviewer is started for a lead, as the lead's own start would be: a plugin's check holds.
            let home = lock()?.home().to_path_buf();
            crate::plugins::check_start(&home, crate::plugins::Asker::Agent, &session)
                .map_err(|e| format!("skipped: {e}"))?;
            let (caller, launch) = {
                let mut sessions = lock()?;
                recheck(&sessions, task, lead, &Step::Start)?;
                let caller = crate::grants::Caller {
                    id: lead.into(),
                    project: sessions.session_of(lead)?.project,
                };
                let launch = sessions.launch_as(Some(&caller), session, false)?;
                (caller, launch.with_folder(folder))
            };
            let mut launch = launch.prepare()?;
            if crate::ledger::revision_of(task).as_deref() != Some(rev) {
                return Err("skipped: the files changed since the done report".into());
            }
            let mut sessions = lock()?;
            if sessions.stopped() {
                return Err("core is stopping".into());
            }
            recheck(&sessions, task, lead, &Step::Start)?;
            let session = sessions.start_granted(&caller, &launch, false)?;
            launch.committed = true;
            Ok(Reply::Started { session })
        }
        // Ticket 1095: the Reviewer's prompt goes with the task's package and is kept as its brief.
        Request::Task {
            operation,
            id: Some(task_id),
            session: Some(seat),
            text,
            ..
        } if operation == "brief" => {
            let home = lock()?.home().to_path_buf();
            crate::ledger::Ledger::open(&home)
                .brief(&task_id, &seat, &text, crate::queue::now_ms())
                .map(|text| Reply::Text { text })
        }
        // `start_granted` recorded the seat; only its level is left.
        Request::Task {
            session: Some(id),
            level,
            ..
        } => {
            if let Some(level) = level {
                lock()?.role_seat_level(&id, level)?;
            }
            Ok(Reply::Ack)
        }
        Request::AgentPrompt { id, text } => {
            let mut sessions = lock()?;
            recheck(&sessions, task, lead, &Step::Prompt)?;
            sessions.core_line(&id, text).map(|()| Reply::Ack)
        }
        _ => Err("not a staffing step".into()),
    }
}

/// The stall card's own record (Ledger::Stall's card path, ticket 1004), with the reason as its error.
fn check_in(task: &Task, seat: &str, name: &str, why: String) -> crate::ledger::CheckIn {
    crate::ledger::CheckIn {
        task: task.clone(),
        session: seat.into(),
        name: name.into(),
        error: Some(why),
    }
}

/// `line` rides in `name`: the window draws an "advance" note as that line (lead.note.advance).
pub(crate) fn team_note(line: &str, seat: Option<&str>) -> crate::room::TeamNote {
    crate::room::TeamNote {
        what: "advance".into(),
        worktree: None,
        name: Some(line.into()),
        branch: None,
        merged: None,
        seat: seat.map(Into::into),
    }
}

/// Rule 7: one room line per act, typed by the core, to the lead's seat.
fn note(home: &Path, place: &Path, lead: &str, act: &Act, failed: Option<&str>) {
    let seat = match act {
        Act::Resend { seat, .. }
        | Act::Nudge { seat, .. }
        | Act::Card { seat, .. }
        | Act::Moved { seat, .. }
        | Act::Forward { seat, .. }
        | Act::Rounds { seat, .. }
        | Act::Close { seat, .. } => Some(seat.as_str()),
        Act::Staff { .. } => None,
    };
    let line = match failed {
        None => room_line(act),
        Some(e) => format!("core could not act ({}): {e}", room_line(act)),
    };
    if let Err(e) =
        crate::room::Log::open(home, place).team(lead, line.clone(), team_note(&line, seat))
    {
        eprintln!("auto-advance: room line not written: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 100 * MIN;
    fn task() -> Task {
        serde_json::from_value(serde_json::json!({
            "id": "t1", "place": "/p", "title": "tax", "lead": "lead",
            "seats": [{"session": "b1", "name": "Builder · tax", "role": "builder", "writes": true, "at": 1}],
            "created": 1, "updated": 1
        }))
        .unwrap()
    }
    fn live(last: u64, working: bool) -> Facts {
        Facts {
            live: true,
            working,
            last,
            since: last,
            ..Default::default()
        }
    }
    fn run(t: &Task, f: &Facts, now: u64) -> (Vec<Act>, Task) {
        let (acts, advance) = plan(t, &|_| f.clone(), &|_, _| false, now);
        (
            acts,
            Task {
                advance,
                ..t.clone()
            },
        )
    }
    fn home(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("nunchiro-advance-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_row_queued_five_minutes_stalls_the_seat_and_is_sent_once_more() {
        let f = Facts {
            queued: Some(("r1".into(), NOW - 6 * MIN)),
            ..live(NOW, true)
        };
        let (acts, t) = run(&task(), &f, NOW);
        assert_eq!(
            acts,
            [Act::Resend {
                seat: "b1".into(),
                name: "Builder · tax".into(),
                row: "r1".into(),
                why: "a message has waited 6 min to be delivered".into()
            }]
        );
        assert_eq!(t.advance.stalled.len(), 1);
        assert!(run(&t, &f, NOW + EVERY_MS).0.is_empty(), "one resend");
        let young = Facts {
            queued: Some(("r1".into(), NOW - 4 * MIN)),
            ..live(NOW, true)
        };
        assert!(run(&task(), &young, NOW).0.is_empty());
    }
    #[test]
    fn a_seat_quiet_twenty_minutes_without_a_report_is_nudged_once() {
        assert!(run(&task(), &live(NOW - 19 * MIN, false), NOW).0.is_empty());
        let f = live(NOW - 20 * MIN, false);
        let (acts, t) = run(&task(), &f, NOW);
        assert_eq!(
            acts,
            [Act::Nudge {
                seat: "b1".into(),
                name: "Builder · tax".into(),
                minutes: 20
            }]
        );
        assert_eq!(t.advance.stalled[0].why, "quiet for 20 min");
        assert!(run(&t, &f, NOW + EVERY_MS).0.is_empty(), "one nudge");
        assert!(
            nudge_line(20)
                .starts_with("Lead: you have been quiet for 20 minutes with the task open")
        );
    }
    #[test]
    fn a_finished_report_is_no_stall() {
        let dir = home("report");
        let f = Facts {
            cwd: dir.clone(),
            ..live(NOW - 30 * MIN, false)
        };
        assert!(!reported(&f), "no report");
        std::fs::write(dir.join("REPORT.md"), "STATUS: done\n").unwrap();
        assert!(reported(&f));
        let (acts, _) = plan(&task(), &|_| f.clone(), &|_, f| reported(f), NOW);
        assert!(acts.is_empty());
        // A report from before its last start or prompt speaks for an earlier turn.
        let later = Facts {
            since: crate::queue::now_ms() + MIN,
            ..f
        };
        assert!(!reported(&later));
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_seat_marked_working_but_silent_twenty_five_minutes_is_stalled() {
        assert!(
            run(&task(), &live(NOW - 24 * MIN, true), NOW).0.is_empty(),
            "a working seat gets more time"
        );
        let (acts, _) = run(&task(), &live(NOW - 25 * MIN, true), NOW);
        assert!(
            matches!(acts[..], [Act::Nudge { minutes: 25, .. }]),
            "{acts:?}"
        );
        // One waiting for an answer, or not running, is not stalled.
        assert!(
            run(
                &task(),
                &Facts {
                    waits: true,
                    ..live(NOW - 60 * MIN, false)
                },
                NOW
            )
            .0
            .is_empty()
        );
        assert!(
            run(
                &task(),
                &Facts {
                    live: false,
                    ..live(NOW - 60 * MIN, false)
                },
                NOW
            )
            .0
            .is_empty()
        );
    }
    #[test]
    fn still_stalled_five_minutes_after_the_nudge_asks_the_owner_once() {
        let f = live(NOW - 20 * MIN, false);
        let (_, t) = run(&task(), &f, NOW);
        assert!(run(&t, &f, NOW + 4 * MIN).0.is_empty());
        let (acts, t) = run(&t, &f, NOW + 5 * MIN);
        assert_eq!(
            acts,
            [Act::Card {
                seat: "b1".into(),
                name: "Builder · tax".into(),
                why: "quiet for 20 min".into()
            }]
        );
        assert!(run(&t, &f, NOW + 6 * MIN).0.is_empty(), "one card");
    }
    #[test]
    fn movement_clears_the_stall_and_its_card() {
        let f = live(NOW - 20 * MIN, false);
        let (_, t) = run(&task(), &f, NOW);
        let (_, t) = run(&t, &f, NOW + 5 * MIN);
        let (acts, t) = run(&t, &live(NOW + 5 * MIN, true), NOW + 6 * MIN);
        assert_eq!(
            acts,
            [Act::Moved {
                seat: "b1".into(),
                name: "Builder · tax".into(),
                card: true
            }]
        );
        assert!(t.advance.stalled.is_empty());
    }
    #[test]
    fn a_restart_repeats_nothing() {
        let home = home("restart");
        let l = Ledger::open(&home);
        let made = l
            .make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
            .unwrap()
            .0;
        let t = Task {
            seats: task().seats,
            ..made
        };
        let f = live(NOW - 20 * MIN, false);
        let (acts, t) = run(&t, &f, NOW);
        assert_eq!(acts.len(), 1);
        l.set_advance(&t.id, t.advance.clone()).unwrap();
        // A new core reads the record from the file.
        let read = Ledger::open(&home).list().unwrap().remove(0);
        assert_eq!(read.advance, t.advance);
        let back = Task {
            seats: task().seats,
            ..read
        };
        assert!(run(&back, &f, NOW + EVERY_MS).0.is_empty());
        // Its stall mark lost, the same stall (same start) still gets no second nudge.
        let bare = Task {
            advance: Advance {
                stalled: vec![],
                ..back.advance.clone()
            },
            ..back
        };
        assert!(run(&bare, &f, NOW + EVERY_MS).0.is_empty());
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn the_heartbeat_goes_only_when_something_waits_and_at_most_every_ten_minutes() {
        let view = |waits: Option<&str>, stalled: usize| View {
            task: Task {
                advance: Advance {
                    stalled: (0..stalled)
                        .map(|i| Stalled {
                            session: format!("s{i}"),
                            name: "B".into(),
                            why: "w".into(),
                            n: 1,
                            at: 1,
                            card: false,
                        })
                        .collect(),
                    ..Default::default()
                },
                ..task()
            },
            state: "idle".into(),
            stale: false,
            live: vec![],
            asks: vec![],
            asking: vec![],
            floor: None,
            seen: Default::default(),
            waits: waits.map(Into::into),
            package: None,
            accounts: Default::default(),
        };
        assert_eq!(beat(&[view(None, 0)]), None);
        assert_eq!(
            beat(&[
                view(Some("review"), 0),
                view(Some("review"), 0),
                view(Some("review"), 1),
                view(Some("merge"), 0)
            ])
            .as_deref(),
            Some("Team: 3 reports wait for review, 1 approved waits to merge, 1 seat stalled.")
        );
        assert!(beat_due(None, NOW));
        assert!(!beat_due(Some(NOW - 9 * MIN), NOW));
        assert!(beat_due(Some(NOW - 10 * MIN), NOW));
    }
    // Part B.
    fn built() -> Task {
        serde_json::from_value(serde_json::json!({
            "id": "t1", "place": "/p", "title": "tax", "lead": "lead", "worktrees": ["/w"],
            "seats": [{"session": "b1", "name": "Builder · tax", "role": "builder", "writes": true, "at": 1}],
            "created": 1, "updated": 1
        }))
        .unwrap()
    }
    /// The Builder's turn ended with a done report (`since` 1 reads as reported), the Reviewer `r1` per `reviewer`.
    fn review(t: &Task, way: &str, rev: &str, reviewer: Facts, free: bool) -> (Vec<Act>, Task) {
        let facts = |s: &str| match s {
            "b1" => Facts {
                since: 1,
                ..live(NOW - MIN, false)
            },
            _ => reviewer.clone(),
        };
        let (acts, advance) = review_plan(
            t,
            t.advance.clone(),
            way,
            Some(rev),
            &facts,
            &|f| f.since == 1,
            free,
        );
        (
            acts,
            Task {
                advance,
                ..t.clone()
            },
        )
    }
    fn with_reviewer(t: &Task, at: u64) -> Task {
        let mut t = t.clone();
        t.seats.push(Seat {
            session: "r1".into(),
            name: "Reviewer · tax".into(),
            role: "reviewer".into(),
            writes: false,
            briefed: false,
            worktree: None,
            at,
        });
        t
    }
    fn verdict(t: &Task, rev: &str, pass: bool) -> Task {
        Task {
            review: Some(crate::ledger::Review {
                revision: rev.into(),
                pass,
                note: "the test is missing".into(),
                by: "r1".into(),
                name: "Reviewer · tax".into(),
                at: NOW,
            }),
            ..t.clone()
        }
    }

    #[test]
    fn a_done_report_at_a_clean_revision_starts_one_reviewer() {
        let (acts, t) = review(&built(), "team", "c1", Facts::default(), true);
        assert_eq!(
            acts,
            [Act::Staff {
                name: "Reviewer · tax".into(),
                rev: "c1".into()
            }]
        );
        assert_eq!(t.advance.review, "started");
        assert!(
            review(&t, "team", "c1", Facts::default(), true)
                .0
                .is_empty(),
            "once per revision"
        );
        assert!(
            review(&built(), "team", "c1+0a1b", Facts::default(), true)
                .0
                .is_empty(),
            "a dirty tree"
        );
        assert!(
            review(&built(), "solo", "c1", Facts::default(), true)
                .0
                .is_empty(),
            "solo"
        );
        assert!(
            !review(&built(), "strict", "c1", Facts::default(), true)
                .0
                .is_empty(),
            "strict"
        );
        // No report since the Builder's last prompt, or the Builder still at work: none.
        let (none, _) = review_plan(
            &built(),
            Advance::default(),
            "team",
            Some("c1"),
            &|_| live(NOW, true),
            &|_| true,
            true,
        );
        assert!(none.is_empty());
        let (none, _) = review_plan(
            &built(),
            Advance::default(),
            "team",
            Some("c1"),
            &|_| live(NOW, false),
            &|_| false,
            true,
        );
        assert!(none.is_empty());
        // A review already at this revision: none.
        assert!(
            review(
                &verdict(&built(), "c1", true),
                "team",
                "c1",
                Facts::default(),
                true
            )
            .0
            .is_empty()
        );
    }
    #[test]
    fn changes_go_to_the_builder_once_a_round_and_the_fourth_asks_the_user() {
        let mut t = built();
        for round in 1..=3 {
            let rev = format!("c{round}");
            let (acts, next) = review(
                &verdict(&t, &rev, false),
                "team",
                &rev,
                Facts::default(),
                true,
            );
            let [
                Act::Forward {
                    seat,
                    round: r,
                    line,
                    ..
                },
            ] = &acts[..]
            else {
                panic!("{acts:?}");
            };
            assert_eq!((seat.as_str(), *r), ("b1", round));
            assert!(
                line.contains("the test is missing") && line.contains("agent send"),
                "{line}"
            );
            assert!(
                review(&next, "team", &rev, Facts::default(), true)
                    .0
                    .is_empty(),
                "one line a round"
            );
            t = next;
        }
        let (acts, t) = review(
            &verdict(&t, "c4", false),
            "team",
            "c4",
            Facts::default(),
            true,
        );
        assert!(matches!(acts[..], [Act::Rounds { .. }]), "{acts:?}");
        let (acts, _) = review(
            &verdict(&t, "c5", false),
            "team",
            "c5",
            Facts::default(),
            true,
        );
        assert!(
            !acts
                .iter()
                .any(|a| matches!(a, Act::Forward { .. } | Act::Rounds { .. }))
        );
        // A verdict for an older revision is stale: nothing is forwarded.
        assert!(
            review(
                &verdict(&built(), "c0", false),
                "team",
                "c1",
                Facts::default(),
                true
            )
            .0
            .iter()
            .all(|a| matches!(a, Act::Staff { .. }))
        );
    }
    #[test]
    fn at_the_cap_the_review_waits_then_starts_when_a_seat_closes() {
        let (acts, t) = review(&built(), "team", "c1", Facts::default(), false);
        assert!(acts.is_empty());
        assert_eq!(t.advance.review, "waits");
        let (acts, t) = review(&t, "team", "c1", Facts::default(), true);
        assert!(matches!(acts[..], [Act::Staff { .. }]));
        assert_eq!(t.advance.review, "started");
    }
    #[test]
    fn a_moved_tree_waits_for_the_reviewer_at_work() {
        let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
        let t = with_reviewer(&t, NOW);
        // Started, not yet at its prompt; then at work: no second Reviewer for the new revision.
        assert!(
            review(&t, "team", "c2", live(NOW - MIN, false), true)
                .0
                .is_empty()
        );
        assert!(
            review(&t, "team", "c2", live(NOW + MIN, true), true)
                .0
                .is_empty()
        );
        // Its turn ended: the new revision gets its own.
        let (acts, _) = review(&t, "team", "c2", live(NOW + MIN, false), true);
        assert!(
            matches!(&acts[..], [Act::Staff { rev, .. }] if rev == "c2"),
            "{acts:?}"
        );
    }
    #[test]
    fn a_restart_starts_and_forwards_nothing_twice() {
        let home = home("restart-b");
        let l = Ledger::open(&home);
        let made = l
            .make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
            .unwrap()
            .0;
        let t = Task {
            seats: built().seats,
            worktrees: built().worktrees,
            ..made
        };
        let (acts, t) = review(
            &verdict(&t, "c1", false),
            "team",
            "c1",
            Facts::default(),
            true,
        );
        assert_eq!(acts.len(), 1);
        l.set_advance(&t.id, t.advance.clone()).unwrap();
        let read = Ledger::open(&home).list().unwrap().remove(0);
        assert_eq!(read.advance.round, 1);
        let back = Task {
            advance: read.advance,
            ..t
        };
        assert!(
            review(&back, "team", "c1", Facts::default(), true)
                .0
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn the_review_prompt_is_the_guides_filled_in() {
        let b = &built().seats[0];
        let p = review_prompt(false, Path::new("/w"), "lane-tax", "main", b);
        assert!(
            p.starts_with("Review the diff of branch `lane-tax` against `main` in `/w`"),
            "{p}"
        );
        assert!(
            p.contains("VERDICT: pass")
                && p.contains("--to b1")
                && !p.contains("for security only")
        );
        assert!(review_prompt(true, Path::new("/w"), "x", "main", b).contains("for security only"));
        // Ticket 1095 rule 3: the owner's question, and what of it is a MUST.
        assert!(
            p.contains("\"What did the owner ask or show that I do not see in the result?\"")
                && p.contains("MUST (blocks the merge: wrong behavior, a fault the owner will see, a risk to saved data,"),
            "{p}"
        );
    }
    #[test]
    fn staffing_runs_one_path_start_level_then_the_prompt() {
        use crate::api::{Reply, Request};
        let staff = |folder: Option<PathBuf>, level| Reply::Staff {
            task: "t1".into(),
            folder,
            session: serde_json::from_value(serde_json::json!({
                "kind": "claude", "project": "/p", "label": "Reviewer · tax"
            }))
            .unwrap(),
            level,
            why: None,
        };
        let run = |reply, prompt: Option<&str>| {
            let mut seen = vec![];
            let started = crate::ledger::seat_up(reply, prompt.map(Into::into), &mut |r| {
                let step = match &r {
                    Request::Start { .. } => "start".to_string(),
                    Request::Task {
                        operation, level, ..
                    } => format!("{operation} {level:?}"),
                    Request::AgentPrompt { text, .. } => format!("prompt {text}"),
                    _ => "other".into(),
                };
                seen.push(step);
                Ok(match r {
                    Request::Start { session, .. } => Reply::Started {
                        session: serde_json::from_value(serde_json::json!({
                            "id": "r1", "label": session.label, "kind": "claude", "state": "running",
                            "cwd": "/w", "project": "/p", "agent_session_id": null, "agent_version": null,
                            "untested": false, "pid": null, "attention": {"completion_seq": 0, "working": false,
                            "waiting": false, "stale": false, "failed": false, "last_activity": 0, "background": 0},
                            "pending": []
                        }))
                        .unwrap(),
                    },
                    // Ticket 1095: the core puts the package in front of the words.
                    Request::Task {
                        operation, text, ..
                    } if operation == "brief" => Reply::Text {
                        text: format!("quoted\n{text}"),
                    },
                    _ => Reply::Ack,
                })
            });
            (started.map(|(task, s, _)| (task, s.id)), seen)
        };
        // The core's Reviewer: in its worktree, at the floor level, with the review prompt.
        let (got, seen) = run(
            staff(Some("/w".into()), Some(crate::team::Level::Deep)),
            Some("review it"),
        );
        assert_eq!(got.unwrap(), ("t1".to_string(), "r1".to_string()));
        assert_eq!(
            seen,
            [
                "start",
                "assign Some(Deep)",
                "brief None",
                "prompt quoted\nreview it"
            ]
        );
        // A first prompt over a brief's limit starts no seat.
        let (got, seen) = run(
            staff(Some("/w".into()), None),
            Some(&"x".repeat(64 * 1024 + 1)),
        );
        assert!(got.unwrap_err().contains("limit of a brief"));
        assert!(seen.is_empty());
        // The lead's `task staff` on a task with no worktree, no level, no prompt: seated by `assign`.
        let (_, seen) = run(staff(None, None), None);
        assert_eq!(seen, ["start", "assign None"]);
    }

    #[test]
    fn auto_advance_off_does_nothing_in_that_place() {
        let home = home("auto");
        let l = Ledger::open(&home);
        l.make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
            .unwrap();
        l.make(Path::new("/q"), Some("lead"), "fee", &[], false, 1)
            .unwrap();
        l.make(Path::new("/q"), None, "no lead", &[], false, 1)
            .unwrap();
        assert_eq!(
            watched(&l).unwrap().len(),
            2,
            "on by default; a task with no lead is not watched"
        );
        assert!(l.place(Path::new("/p")).auto);
        l.set_place(Path::new("/p"), None, None, Some(false))
            .unwrap();
        let left: Vec<String> = watched(&l).unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(left, ["fee"]);
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn the_cap_counts_every_live_seat_of_the_place() {
        let mut closed = with_reviewer(&built(), 1);
        closed.id = "t0".into();
        closed.closed = Some(crate::ledger::Closed {
            at: 1,
            how: "done".into(),
        });
        let mut other = built();
        other.place = "/q".into();
        other.seats[0].session = "q1".into();
        let all = [built(), closed, other];
        let live = |s: &str| s != "gone";
        let lead_seat = |l: &str| (l == "lead").then(|| "lead-seat".to_string());
        // b1 (the open task's and the closed one's Builder, once), r1 of the closed task, and the lead's seat.
        assert_eq!(live_seats(&all, Path::new("/p"), &live, &lead_seat), 3);
        assert_eq!(
            live_seats(&all, Path::new("/p"), &|s| s != "r1", &lead_seat),
            2
        );
    }
    #[test]
    fn a_failed_start_is_tried_again_then_asks_the_user_at_the_third() {
        let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
        let mut adv = t.advance.clone();
        // Skipped (no longer due): no try counted, the next pass may plan it again.
        assert!(!start_failed(&mut adv, "c1", false));
        assert!(!adv.done.contains(&"review:c1".to_string()));
        for n in 1..=3 {
            let t = Task {
                advance: adv.clone(),
                ..built()
            };
            let (acts, next) = review(&t, "team", "c1", Facts::default(), true);
            assert!(matches!(acts[..], [Act::Staff { .. }]), "try {n}: {acts:?}");
            adv = next.advance;
            assert_eq!(start_failed(&mut adv, "c1", true), n == 3, "try {n}");
        }
        let t = Task {
            advance: adv,
            ..built()
        };
        assert!(
            review(&t, "team", "c1", Facts::default(), true)
                .0
                .is_empty(),
            "no fourth try"
        );
    }
    #[test]
    fn the_reviewer_the_core_started_is_closed_after_its_verdict() {
        let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
        let mut t = with_reviewer(&t, NOW);
        let judged = |t: &Task, f: Facts| review(&verdict(t, "c1", true), "team", "c1", f, true);
        // A Reviewer the lead started is the lead's to close.
        assert!(judged(&t, live(NOW + MIN, false)).0.is_empty());
        t.advance.done.push("reviewer:r1".into());
        assert!(
            review(&t, "team", "c1", live(NOW + MIN, false), true)
                .0
                .is_empty(),
            "no verdict yet"
        );
        assert!(
            judged(&t, live(NOW + MIN, true)).0.is_empty(),
            "its turn goes on"
        );
        let asking = Facts {
            waits: true,
            ..live(NOW + MIN, false)
        };
        assert!(judged(&t, asking).0.is_empty(), "it waits on an ask");
        let (acts, next) = judged(&t, live(NOW + MIN, false));
        assert_eq!(
            acts,
            [Act::Close {
                seat: "r1".into(),
                name: "Reviewer · tax".into()
            }]
        );
        assert!(judged(&next, live(NOW + MIN, false)).0.is_empty(), "once");
    }
}
