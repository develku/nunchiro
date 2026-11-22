//! Ticket 573 slice 2: `nunchiro events`, the core's event log as NDJSON on stdout until the reader goes away.
use nunchiro_core::api::{Reply, Request};
use std::{io::Write, path::Path, thread, time::Duration};

// shortcut: the CLI reads the core every POLL (one local socket round trip), so its caller does not poll; upgrade to a
// held connection the core writes to if many streams run at once.
const POLL: Duration = Duration::from_millis(200);

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    const USAGE: &str = "usage: nunchiro events [--project DIR] [--since ID]";
    let (mut project, mut since) = (None, None);
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
            _ => return Err(USAGE.into()),
        }
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
