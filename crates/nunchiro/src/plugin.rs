//! `nunchiro plugin new|check|list|on|off|allow|run|remove|catalog|install` (docs/plugins.md). `new` and `check` touch only the
//! plugin's folder, so they work inside a session; the rest go to the core as the owner's, so the core refuses them
//! to an agent (an `allow` from a session becomes one waiting item for the owner, as `widget allow` does).
use nunchiro_core::{
    api::*,
    approval::{Level, State},
    plugins::{self, Action},
};
use std::path::Path;

const USAGE: &str = "usage: nunchiro plugin new <id> [--with panel,command,setting,gate] | check <id> | list [--json] | on <id> | off <id> | allow <id> | run <id> <command> | remove <id> | catalog [--json] | install <id>";

pub fn run(
    home: &Path,
    args: &[String],
    ensure_core: fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["new", id] => return new(home, id, &plugins::PARTS),
        ["new", id, "--with", with] => {
            return new(home, id, &with.split(',').collect::<Vec<_>>());
        }
        ["check", id] => return check(home, id),
        ["list"]
        | ["list", "--json"]
        | ["on", _]
        | ["off", _]
        | ["allow", _]
        | ["run", _, _]
        | ["remove", _]
        | ["catalog"]
        | ["catalog", "--json"]
        | ["install", _] => {}
        _ => return Err(USAGE.into()),
    }
    ensure_core(home)?;
    let action = match words.as_slice() {
        ["on", id] => Action::Set {
            id: id.to_string(),
            on: true,
        },
        ["off", id] => Action::Set {
            id: id.to_string(),
            on: false,
        },
        ["remove", id] => Action::Remove { id: id.to_string() },
        ["catalog", ..] => Action::Catalog,
        ["install", id] => Action::Install { id: id.to_string() },
        ["run", id, command] => Action::Run {
            id: id.to_string(),
            command: command.to_string(),
            session: None,
            poll: false,
        },
        ["allow", id] => return allow(home, id),
        _ => Action::List,
    };
    let mut reply = super::call(
        home,
        Request::Plugin {
            action: action.clone(),
        },
    )?;
    // A run longer than the core's first answer is read again until it ends (the sandbox stops it at its limit).
    while let (Reply::PluginRun { run, .. }, Action::Run { id, command, .. }) = (&reply, &action)
        && run.running
    {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let poll = Action::Run {
            id: id.clone(),
            command: command.clone(),
            session: None,
            poll: true,
        };
        reply = super::call(home, Request::Plugin { action: poll })?;
    }
    match reply {
        Reply::PluginRun { run, .. } => match (run.output, run.error) {
            (_, Some(e)) => Err(e),
            (Some(widgets_output), None) => {
                println!("{}", text(widgets_output).trim_end());
                Ok(())
            }
            (None, None) => Ok(()),
        },
        Reply::PluginCatalog { catalog } if words.last() == Some(&"--json") => {
            println!(
                "{}",
                serde_json::to_string_pretty(&catalog).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Reply::PluginCatalog { catalog } => {
            for e in catalog {
                println!("{}\t{}\t{}: {}", e.id, e.version, e.name, e.about);
            }
            Ok(())
        }
        Reply::Plugins { .. } if words[0] == "install" => {
            println!(
                "installed plugin {0}: off and not approved; it runs nothing until `nunchiro plugin allow {0}` and `nunchiro plugin on {0}`",
                words[1]
            );
            Ok(())
        }
        Reply::Plugins { plugins } if words.last() == Some(&"--json") => {
            println!(
                "{}",
                serde_json::to_string_pretty(&plugins).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Reply::Plugins { plugins } => {
            if plugins.is_empty() {
                println!("no plugins (make one with `nunchiro plugin new <id>`)");
            }
            for p in plugins {
                let state = match (p.state, &p.error) {
                    (_, Some(e)) => format!("broken: {e}"),
                    (Some(State::Approved), _) => "approved".into(),
                    (Some(State::Changed), _) => "changed since approval".into(),
                    _ => "not approved".into(),
                };
                let needs = p
                    .needs
                    .map(|n| format!(", needs the {n} setting"))
                    .unwrap_or_default();
                let on = if p.on { "on" } else { "off" };
                println!("{}\t{on}\t{state}{needs}", p.id);
            }
            Ok(())
        }
        _ => Err("unexpected reply".into()),
    }
}

fn text(o: nunchiro_core::widgets::Output) -> String {
    match o {
        nunchiro_core::widgets::Output::Text { text }
        | nunchiro_core::widgets::Output::Json { text } => text,
    }
}

fn new(home: &Path, id: &str, with: &[&str]) -> Result<(), String> {
    let dir = plugins::scaffold(home, id, with)?;
    println!(
        "created {}: edit plugin.toml, run `nunchiro plugin check {id}`, then review and turn it on in Settings > Plugins (or `nunchiro plugin allow {id}` and `nunchiro plugin on {id}`)",
        dir.display()
    );
    Ok(())
}

fn check(home: &Path, id: &str) -> Result<(), String> {
    let (p, tried) = plugins::trial(home, id)?;
    println!(
        "{} {} ({} panels, {} commands, {} settings)",
        p.name,
        p.version,
        p.panel.len(),
        p.command.len(),
        p.setting.len()
    );
    let mut failed = 0;
    for t in tried {
        match t.result {
            Ok(out) => println!("ok\t{}\t{}", t.part, out.lines().next().unwrap_or("")),
            Err(e) => {
                failed += 1;
                println!("failed\t{}\t{e}", t.part);
            }
        }
    }
    match failed {
        0 => Ok(()),
        n => Err(format!("{n} part(s) of {id} failed")),
    }
}

fn allow(home: &Path, id: &str) -> Result<(), String> {
    let name = format!("{}{id}", plugins::PREFIX);
    let Reply::ApprovalStatus { view } =
        super::call(home, Request::ApprovalStatus { name: name.clone() })?
    else {
        return Err("unexpected reply".into());
    };
    // What is approved, part by part, exactly as the window's sheet shows it.
    let list = |v: &[String]| {
        if v.is_empty() {
            "none".to_string()
        } else {
            v.join(", ")
        }
    };
    for p in &view.parts {
        let every = p
            .interval_secs
            .map(|s| format!(", every {s} s"))
            .unwrap_or_default();
        let draft = if p.writes_draft {
            ", writes into the message box"
        } else {
            ""
        };
        println!("{} {}: {}{every}{draft}", p.kind, p.name, p.runs.join(" "));
        println!(
            "  network: {}; reads beyond its project: {}",
            list(&p.network),
            list(&p.read)
        );
    }
    if view.read_home_wide {
        println!("warning: a read path covers your whole home folder");
    }
    match super::call(
        home,
        Request::ApprovalGrant {
            name,
            level: Level::Read,
            hash: view.hash,
        },
    )? {
        Reply::Waiting { .. } => println!("{}", crate::WAITING),
        Reply::ApprovalStatus { .. } => println!("approved plugin {id}"),
        _ => return Err("unexpected reply".into()),
    }
    Ok(())
}
