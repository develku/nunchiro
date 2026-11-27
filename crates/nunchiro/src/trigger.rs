//! `nunchiro trigger add|list|fire|pause|resume|remove` (docs/triggers.md). Everything but `fire` is the owner's; `fire`
//! also works with a token of the `trigger` scope (`NUNCHIRO_TOKEN`), which can do nothing else.
use nunchiro_core::{
    api::*,
    schedule::{
        Run,
        triggers::{Action, Mode, Source},
    },
};
use std::io::Read;
use std::path::Path;

const USAGE: &str = "usage: nunchiro trigger add <name> --on cli|webhook --kind claude|codex --project <dir> --task <text> [--label <name>] [--model <m>] [--effort <e>] [--auto] | list [--json] | fire <name> [--data @<file>|-] | pause <name> | resume <name> | remove <name>";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let action = match words.as_slice() {
        ["list"] | ["list", "--json"] => Action::List,
        ["fire", name] => fire(name, None)?,
        ["fire", name, "--data", from] => fire(name, Some(from))?,
        ["pause", name] => Action::Pause {
            name: name.to_string(),
            paused: true,
        },
        ["resume", name] => Action::Pause {
            name: name.to_string(),
            paused: false,
        },
        ["remove", name] => Action::Remove {
            name: name.to_string(),
        },
        ["add", name, rest @ ..] => add(name, rest)?,
        _ => return Err(USAGE.into()),
    };
    let fires = matches!(action, Action::Fire { .. });
    super::ensure_core(home)?;
    match super::call(home, Request::Trigger { action })? {
        Reply::Ack if fires => {
            println!("fired");
            Ok(())
        }
        Reply::Triggers { triggers } if words.last() == Some(&"--json") => {
            println!(
                "{}",
                serde_json::to_string_pretty(&triggers).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Reply::Triggers { triggers } => {
            if triggers.is_empty() {
                println!("no triggers");
            }
            for t in triggers {
                let on = match t.on {
                    Source::Cli => "cli",
                    Source::Webhook => "webhook",
                };
                let mode = if t.mode == Mode::Auto { "auto" } else { "ask" };
                let state = if t.paused { "off" } else { "on" };
                let last = t
                    .last
                    .and_then(|l| l.reason.or(l.session))
                    .unwrap_or_else(|| "-".into());
                println!(
                    "{}\t{on}\t{mode}\t{state}\t{}\t{last}",
                    t.name,
                    t.run.project.display()
                );
            }
            Ok(())
        }
        _ => Err("unexpected reply".into()),
    }
}

fn fire(name: &str, from: Option<&str>) -> Result<Action, String> {
    let data = match from {
        None => None,
        Some("-") => {
            let mut s = String::new();
            std::io::stdin()
                .take(256 * 1024)
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())?;
            Some(s)
        }
        Some(file) => Some(
            std::fs::read_to_string(file.strip_prefix('@').ok_or("--data takes @<file> or -")?)
                .map_err(|e| e.to_string())?,
        ),
    };
    Ok(Action::Fire {
        name: name.into(),
        data,
    })
}

/// The owner's trigger. A webhook trigger's secret is read from stdin (one line), never from the command line.
fn add(name: &str, rest: &[&str]) -> Result<Action, String> {
    let (mut on, mut kind, mut project, mut task, mut label, mut model, mut effort, mut mode) =
        (None, None, None, None, None, None, None, Mode::Ask);
    let mut i = 0;
    while i < rest.len() {
        if rest[i] == "--auto" {
            mode = Mode::Auto;
            i += 1;
            continue;
        }
        let value = rest.get(i + 1).copied().ok_or(USAGE)?;
        match rest[i] {
            "--on" => {
                on = Some(match value {
                    "cli" => Source::Cli,
                    "webhook" => Source::Webhook,
                    _ => return Err("--on is cli or webhook".into()),
                })
            }
            "--kind" => {
                kind = Some(
                    serde_json::from_value(value.into())
                        .map_err(|_| "--kind is claude or codex")?,
                )
            }
            "--project" => project = Some(std::path::absolute(value).map_err(|e| e.to_string())?),
            "--task" => task = Some(value.to_string()),
            "--label" => label = Some(value.to_string()),
            "--model" => model = Some(value.to_string()),
            "--effort" => effort = Some(value.to_string()),
            _ => return Err(USAGE.into()),
        }
        i += 2;
    }
    let on = on.ok_or("--on cli|webhook is required")?;
    let secret = match on {
        Source::Webhook => {
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            Some(line.trim().to_string())
        }
        Source::Cli => None,
    };
    Ok(Action::Add {
        name: name.into(),
        on,
        run: Run {
            kind: kind.ok_or("--kind claude|codex is required")?,
            project: project.ok_or("--project is required")?,
            label: label.unwrap_or_else(|| name.into()),
            model,
            effort,
            task: Some(task.ok_or("--task is required")?),
            teammate: None,
            level: None,
        },
        mode,
        secret,
    })
}
