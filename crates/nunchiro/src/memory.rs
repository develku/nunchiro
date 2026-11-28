//! `nunchiro memory`: a bot's seat reads and changes its own memory. The core finds the bot by the calling seat, adds
//! the date and the source, and turns a write into a proposal once the seat read outside content.
use nunchiro_core::api::*;
use std::path::Path;

pub const USAGE: &str = "nunchiro memory add|forget|read [<fact>|<words of the line>|<topic>] [--topic <name>] [--user] [--from-user] (inside a bot's session: its own memory)";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let usage = || format!("usage: {USAGE}");
    let (operation, rest) = args.split_first().ok_or_else(usage)?;
    let (mut text, mut topic, mut user, mut from_user) = (None, None, false, false);
    let mut words = rest.iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--topic" => topic = Some(words.next().ok_or_else(usage)?.clone()),
            "--user" => user = true,
            "--from-user" => from_user = true,
            _ if text.is_none() && !word.starts_with("--") => text = Some(word.clone()),
            _ => return Err(usage()),
        }
    }
    let text = match (operation.as_str(), text) {
        // `read <topic>` names the topic without the flag.
        ("read", t) => {
            topic = topic.or(t);
            String::new()
        }
        ("add" | "forget", Some(t)) => t,
        _ => return Err(usage()),
    };
    super::ensure_core(home)?;
    match super::call(
        home,
        Request::BotMemory {
            operation: operation.clone(),
            text,
            topic,
            user,
            from_user,
        },
    )? {
        Reply::Text { text } => println!("{text}"),
        reply => println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        ),
    }
    Ok(())
}
