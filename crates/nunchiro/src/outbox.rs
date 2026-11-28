//! Ticket 1002 lane 2: `nunchiro outbox stage`. The Home lead stages one outward tool call (the exact tool and
//! arguments it will call) as the user's Outbox card; nothing is sent. After the user's yes the core wakes the seat to
//! make exactly that call, once.
use nunchiro_core::api::*;
use std::io::Read;
use std::path::Path;

pub const USAGE: &str = "nunchiro outbox stage --tool <tool name> --args '<JSON arguments>'|--args - [--source \"what it answers\"] (the Home lead: one mcp__<server>__send_message or mcp__<server>__create_event call as the user's card), or nunchiro outbox stage --command '<program> <files>' [--source ...] (one plain command line, program and files by full path, which you run once after the yes); nothing is sent before the user's yes";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("stage") {
        return Err(USAGE.into());
    }
    let (mut tool, mut json, mut source) = (None, None, None);
    let mut words = args[1..].iter();
    while let Some(word) = words.next() {
        let value = words.next().ok_or(USAGE)?.clone();
        match word.as_str() {
            "--tool" => tool = Some(value),
            "--command" => {
                tool = Some(nunchiro_core::home_lock::COMMAND.to_string());
                json = Some(serde_json::json!({ "command": value }).to_string());
            }
            "--args" if value == "-" => {
                let mut text = String::new();
                std::io::stdin()
                    .take(1 << 20)
                    .read_to_string(&mut text)
                    .map_err(|e| format!("arguments from stdin: {e}"))?;
                json = Some(text);
            }
            "--args" => json = Some(value),
            "--source" => source = Some(value),
            _ => return Err(USAGE.into()),
        }
    }
    let args = serde_json::from_str(&json.ok_or(USAGE)?)
        .map_err(|e| format!("--args is not JSON: {e}"))?;
    let request = Request::OutboxStage {
        tool: tool.ok_or(USAGE)?,
        args,
        source,
    };
    super::ensure_core(home)?;
    match super::call(home, request)? {
        Reply::Text { text } => println!(
            "Staged {text} for the user. Nothing is sent: after the user's yes you get a message to make exactly this call, once (a command: its line, with its files unchanged). End your turn; the answer comes as a line in your room."
        ),
        reply => println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        ),
    }
    Ok(())
}
