//! Ticket 573 slice 2: `nunchiro events`, the core's event log as NDJSON on stdout until the reader goes away.
use nunchiro_core::api::{Reply, Request};
use std::{io::Write, path::Path, thread, time::Duration};

// shortcut: the CLI reads the core every POLL (one local socket round trip), so its caller does not poll; upgrade to a
// held connection the core writes to if many streams run at once.
const POLL: Duration = Duration::from_millis(200);

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    const USAGE: &str =
        "usage: nunchiro events [--project DIR] [--since ID] | --history DAYS [--project DIR]";
    let (mut project, mut since, mut history) = (None, None, None);
    let mut it = args.iter();
    while let Some(option) = it.next() {
        let value = it.next().ok_or(USAGE)?;
        match option.as_str() {
            "--project" => {
                project = Some(std::fs::canonicalize(value).map_err(|e| format!("{value}: {e}"))?)
            }
            "--since" => {
                since = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| "--since takes an event id")?,
                )
            }
            "--history" => {
                history = Some(
                    value
                        .parse::<i64>()
                        .ok()
                        .filter(|d| (1..=nunchiro_core::events::JOURNAL_DAYS).contains(d))
                        .ok_or("--history takes a number of days, 1 to 14")?,
                )
            }
            _ => return Err(USAGE.into()),
        }
    }
    if let Some(days) = history {
        if since.is_some() {
            return Err(USAGE.into());
        }
        return print_history(home, days, project.as_deref());
    }
    super::ensure_core(home)?;
    let mut out = std::io::stdout().lock();
    loop {
        let request = Request::Events {
            project: project.clone(),
            since,
        };
        let Reply::Events {
            events,
            latest,
            gap,
        } = super::call(home, request)?
        else {
            return Err("invalid events reply".into());
        };
        let mut lines = vec![];
        if gap {
            lines.push(
                serde_json::json!({"type": "gap", "since": since, "latest": latest}).to_string(),
            );
        }
        for event in &events {
            lines.push(serde_json::to_string(event).map_err(|e| e.to_string())?);
        }
        // The reader closed the pipe: the stream ends without an error.
        if lines.iter().any(|l| writeln!(out, "{l}").is_err()) || out.flush().is_err() {
            return Ok(());
        }
        since = Some(latest);
        thread::sleep(POLL);
    }
}

/// Ticket 1130 C-C3: the journal's events of the last DAYS, oldest first, read from the home's files without a core
/// (it may be the core's restart a script asks about). Every project's events are there, so it is the owner's: a
/// session's token is refused, as `update` refuses it.
fn print_history(home: &Path, days: i64, project: Option<&Path>) -> Result<(), String> {
    if std::env::var_os("NUNCHIRO_TOKEN").is_some() {
        return Err(
            "refused: `nunchiro events --history` is for the owner, not for a session".into(),
        );
    }
    let mut out = std::io::stdout().lock();
    for event in nunchiro_core::events::history(home, days) {
        if project.is_some_and(|p| event["project"].as_str() != p.to_str()) {
            continue;
        }
        if writeln!(out, "{event}").is_err() {
            return Ok(()); // the reader closed the pipe
        }
    }
    Ok(())
}
