//! `nunchiro memory`: a bot's seat reads and changes its own memory. The core finds the bot by the calling seat, adds
//! the date and the source, and turns a write into a proposal once the seat read outside content.
use nunchiro_core::api::*;
use std::path::Path;

pub const USAGE: &str = "nunchiro memory add|forget|read [<fact>|<words of the line>|<topic>] [--topic <name>] [--user] [--from-user] (inside a bot's session: its own memory)\nnunchiro memory search <words> [--json] (past conversations of every agent, secrets masked)";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let usage = || format!("usage: {USAGE}");
    let (operation, rest) = args.split_first().ok_or_else(usage)?;
    let (mut text, mut topic, mut user, mut from_user, mut json) =
        (None, None, false, false, false);
    let mut words = rest.iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--topic" => topic = Some(words.next().ok_or_else(usage)?.clone()),
            "--user" => user = true,
            "--from-user" => from_user = true,
            "--json" if operation == "search" => json = true,
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
        ("add" | "forget" | "search", Some(t)) => t,
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
        Reply::MemoryHits { hits, total } if !json => print!("{}", hits_text(&hits, total)),
        reply => println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        ),
    }
    Ok(())
}

/// Hits as a seat reads them: one block per line, newest first.
fn hits_text(hits: &[nunchiro_core::chat::recall::Hit], total: usize) -> String {
    let mut out = match total {
        0 => "No past conversation holds these words.\n".to_string(),
        n if n > hits.len() => format!("{n} lines match; the newest {}:\n", hits.len()),
        n => format!("{n} line{} match:\n", if n == 1 { "" } else { "s" }),
    };
    for h in hits {
        let agent = match h.kind {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
            AgentKind::Acp => "ACP agent",
            AgentKind::Shell => "shell",
        };
        out += &format!(
            "- {} · {agent} · {} · {} (session {})\n  {}\n",
            h.label, h.at, h.role, h.session, h.text
        );
    }
    out
}
