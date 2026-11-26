//! Ticket 993: `nunchiro schedule`. The user's shell and a place's lead read schedules; a lead proposes one or a
//! change, which is a card for the user (the core stores nothing before the user's yes).
use nunchiro_core::api::*;
use nunchiro_core::schedule::{Entry, Outcome};
use std::path::Path;

pub const USAGE: &str = "nunchiro schedule list [--json] (the user: all; a place's lead: its place's; the Home lead: all)\n\
nunchiro schedule propose --who <teammate> --when \"daily HH:MM | weekdays HH:MM | weekly <day> HH:MM | once YYYY-MM-DD HH:MM\" --task \"<text>\" [--level light|standard|deep] (a lead: asks the user on a card; default light)\n\
nunchiro schedule change <id> pause|resume|remove (a lead: asks the user on a card)";

/// "in 3 h 20 min", from the core's own next time.
fn until(next_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let min = next_ms.saturating_sub(now) / 60_000;
    match (min / 1440, min % 1440 / 60, min % 60) {
        (0, 0, m) => format!("in {m} min"),
        (0, h, m) => format!("in {h} h {m} min"),
        (d, h, _) => format!("in {d} d {h} h"),
    }
}

fn lines(e: &Entry) -> String {
    let mut head = format!("{} · {}", e.run.label, e.when().words());
    if let Some(level) = e.run.level {
        head += &format!(" · {}", level.word());
    }
    if let Some(task) = &e.run.task {
        let flat = task.split_whitespace().collect::<Vec<_>>().join(" ");
        head += &format!(": {}", flat.chars().take(160).collect::<String>());
    }
    let next = match e.paused {
        true => "off".to_string(),
        false => format!("next {}", until(e.next_ms)),
    };
    let last = match &e.last {
        None => "never ran".to_string(),
        Some(l) => match (l.result, &l.reason) {
            (None, _) => "last run: still working".into(),
            (Some(Outcome::Finished), _) => "last run: finished".into(),
            (Some(Outcome::NeedsYou), _) => "last run: waits for the user".into(),
            (Some(Outcome::Failed), Some(why)) => format!("last run: failed ({why})"),
            (Some(Outcome::Failed), None) => "last run: failed".into(),
            (Some(Outcome::Skipped), _) => "last run: skipped (more than 2 h late)".into(),
            (Some(Outcome::Held), _) => "last run: held (the Mac was low on memory)".into(),
        },
    };
    format!("{}  {head}\n  {next} · {last}\n", e.id)
}

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let level = |word: &String| nunchiro_core::team::Level::parse(word).ok_or(USAGE);
    let (request, json) = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["list"] => (Request::ScheduleList, false),
        ["list", "--json"] => (Request::ScheduleList, true),
        ["change", id, change @ ("pause" | "resume" | "remove")] => (
            Request::ScheduleChange {
                id: id.into(),
                change: change.into(),
            },
            false,
        ),
        ["propose", ..] => {
            let (mut who, mut when, mut task, mut asked) = (None, None, None, None);
            let mut words = args[1..].iter();
            while let Some(word) = words.next() {
                let value = words.next().ok_or(USAGE)?;
                match word.as_str() {
                    "--who" => who = Some(value.clone()),
                    "--when" => when = Some(value.clone()),
                    "--task" => task = Some(value.clone()),
                    "--level" => asked = Some(level(value)?),
                    _ => return Err(USAGE.into()),
                }
            }
            (
                Request::SchedulePropose {
                    who: who.ok_or(USAGE)?,
                    when: when.ok_or(USAGE)?,
                    task: task.ok_or(USAGE)?,
                    level: asked,
                },
                false,
            )
        }
        _ => return Err(USAGE.into()),
    };
    super::ensure_core(home)?;
    match super::call(home, request)? {
        Reply::Schedules { schedules } if !json => {
            if schedules.is_empty() {
                println!("No schedule.");
            }
            for e in &schedules {
                print!("{}", lines(e));
            }
        }
        Reply::Text { text } => println!(
            "Asked the user on a card: {text}\nNothing is scheduled or changed before the user's yes. End your turn; the answer arrives as a room message."
        ),
        reply => println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        ),
    }
    Ok(())
}
