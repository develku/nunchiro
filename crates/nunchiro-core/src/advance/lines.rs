//! The lines auto-advance types into a lead's or a seat's box (ticket 1085: each is an automatic line form the lead's
//! chat folds, `tests/fixtures/automatic-lines.json`).

pub(crate) fn nudge_line(minutes: u64) -> String {
    format!(
        "Lead: you have been quiet for {minutes} minutes with the task open; finish it or say what blocks you."
    )
}

/// What the lead is told when a stalled seat's card goes to the user: the seat, why, and the step to take, so the lead
/// acts without the user relaying the card. It may wait in the lead's queue while the lead works: the lead checks the
/// seat is still stalled first.
pub(crate) fn stall_line(name: &str, seat: &str, task: &str, role: &str, why: &str) -> String {
    format!(
        "Stalled: {name} ({seat}): {why}, still after one nudge. If `nunchiro task show {task}` still lists it as stalled, replace it now without asking the user: nunchiro session close {seat}, then nunchiro task staff {task} {role} with its brief. Ask the user instead only if your brief or the user says so, or it is a teammate you did not open."
    )
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
