//! Ticket 455: `nunchiro extensions list|show|new|on|off`, the window's Skills & hooks page from a terminal. Every
//! request goes to the core as the owner's, so inside an agent session the core refuses them as it refuses the window's.
//! Ticket 580: the two switches the window shows above the custom items (`nunchiro-hooks`, `orchestration`) are rows
//! here too, and `new --hook` makes a hook item.
use nunchiro_core::{
    api::*,
    extensions::{ENABLED_KEY, HookLine, Item, enabled},
};
use std::path::Path;

const USAGE: &str = "usage: nunchiro extensions list [--json] | show <id> [<path>] | new <name> --about \"<one line>\" [--hook] | on <id> [--yes] | off <id>";

/// Nunchiro's own two switches (stored in settings.json, not in the `extensions.enabled` list).
const HOOKS: &str = "nunchiro-hooks";
const ORCHESTRATION: &str = "orchestration";
const HOOKS_ABOUT: &str = "The hooks Nunchiro adds to new sessions. They only tell Nunchiro when an agent works, waits or asks.";
const ORCHESTRATION_ABOUT: &str = "Teaches agents to start and read other agents. Read it with `nunchiro skill get orchestration`.";

pub fn run(
    home: &Path,
    args: &[String],
    ensure_core: fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    if matches!(words.as_slice(), [] | ["--help"]) {
        println!("{USAGE}");
        return Ok(());
    }
    if !matches!(
        words.as_slice(),
        ["list"]
            | ["list", "--json"]
            | ["show", _]
            | ["show", _, _]
            | ["new", _, "--about", _]
            | ["new", _, "--about", _, "--hook"]
            | ["on", _]
            | ["on", _, "--yes"]
            | ["off", _]
    ) {
        return Err(USAGE.into());
    }
    ensure_core(home)?;
    if let ["new", name, "--about", about, rest @ ..] = words.as_slice() {
        let hook = rest == ["--hook"];
        let Reply::Extensions { dir, .. } = super::call(
            home,
            Request::ExtensionsSkillNew {
                name: name.to_string(),
                description: about.to_string(),
                hook,
            },
        )?
        else {
            return Err("unexpected reply".into());
        };
        let file = if hook {
            "hooks/hooks.json".to_string()
        } else {
            format!("skills/{name}/SKILL.md")
        };
        println!(
            "created {dir}/{name}; edit {file} there or in the window (Settings > Skills & hooks). It is off: turn it on with `nunchiro extensions on custom:{name}`"
        );
        return Ok(());
    }
    let (dir, items, hooks) = listing(home)?;
    let settings = settings(home)?;
    let mut on = enabled_ids(&settings);
    // Ticket 580: the window's two Nunchiro switches, shown here as rows with their own ids.
    let own = |id: &str| match id {
        HOOKS => Some(!settings.disable_hook_injection),
        ORCHESTRATION => Some(settings.orchestration.enabled),
        _ => None,
    };
    match words.as_slice() {
        ["list"] => {
            for i in &items {
                let about = cut(&i.description);
                println!("{}\t{}\t{}\t{about}", i.id, i.kind, state(&on, &i.id));
            }
            for (id, kind, about) in [
                (HOOKS, "hook", HOOKS_ABOUT),
                (ORCHESTRATION, "skill", ORCHESTRATION_ABOUT),
            ] {
                let about = cut(about);
                println!(
                    "{id}\t{kind}\t{}\t{about}",
                    if own(id) == Some(true) { "on" } else { "off" }
                );
            }
        }
        ["list", "--json"] => {
            let mut rows: Vec<serde_json::Value> = items
                .iter()
                .map(|i| {
                    let mut row = serde_json::to_value(i).unwrap_or_default();
                    row["enabled"] = on.contains(&i.id).into();
                    row
                })
                .collect();
            for (id, kind, about) in [
                (HOOKS, "hook", HOOKS_ABOUT),
                (ORCHESTRATION, "skill", ORCHESTRATION_ABOUT),
            ] {
                rows.push(serde_json::json!({
                    "id": id, "name": id, "kind": kind, "source": "default",
                    "description": about, "enabled": own(id) == Some(true),
                }));
            }
            println!("{}", serde_json::Value::from(rows));
        }
        ["show", id] if own(id).is_some() => {
            let (kind, about) = if *id == HOOKS {
                ("hook", HOOKS_ABOUT)
            } else {
                ("skill", ORCHESTRATION_ABOUT)
            };
            println!(
                "{id} ({kind}, {})",
                if own(id) == Some(true) { "on" } else { "off" }
            );
            println!("{about}");
            if *id == HOOKS {
                println!("hooks (read only; Nunchiro's own):");
                for h in &hooks {
                    print_hook(h);
                }
            }
        }
        ["show", id, _] if own(id).is_some() => {
            return Err(format!(
                "{id} is built into Nunchiro and has no files here; see `nunchiro extensions show {id}`"
            ));
        }
        ["on", id, ..] | ["off", id] if own(id).is_some() => {
            let to = words[0] == "on";
            set_own(home, id, to)?;
            println!("{id} is {} for new sessions", if to { "on" } else { "off" });
        }
        ["show", id] => {
            let item = find(&items, id)?;
            let Reply::ExtensionsFiles { files, more, .. } =
                super::call(home, Request::ExtensionsItemFiles { id: id.to_string() })?
            else {
                return Err("unexpected reply".into());
            };
            println!("{} ({}, {})", item.id, item.kind, state(&on, id));
            if !item.description.is_empty() {
                println!("{}", item.description);
            }
            if item.source == "custom" {
                // Ticket 580: where the files are, so the user can edit them with their own editor.
                println!("folder: {dir}/{}", item.name);
            }
            if !item.skills.is_empty() {
                println!("skills: {}", item.skills.join(", "));
            }
            if !item.hook_lines.is_empty() {
                println!("hooks:");
                print_hooks(item);
            }
            println!("files:");
            for f in files {
                println!("  {}\t{} bytes", f.path, f.bytes);
            }
            if more {
                println!("  (more files not listed)");
            }
        }
        ["show", id, path] => {
            find(&items, id)?;
            let Reply::ExtensionsFile { text, .. } = super::call(
                home,
                Request::ExtensionsItemRead {
                    id: id.to_string(),
                    path: path.to_string(),
                },
            )?
            else {
                return Err("unexpected reply".into());
            };
            // A file's text goes to a terminal: control characters other than line ends and tabs are shown as a mark.
            let plain: String = text
                .chars()
                .map(|c| {
                    if c.is_control() && c != '\n' && c != '\t' {
                        '\u{FFFD}'
                    } else {
                        c
                    }
                })
                .collect();
            print!("{plain}");
        }
        ["on", id, rest @ ..] => {
            let item = find(&items, id)?;
            if on.iter().any(|e| e == id) {
                println!("{id} is already on");
                return Ok(());
            }
            // Anything that can run a command asks first: listed command hooks, hook events with another kind of
            // handler, an item that is a hook item at all, and every custom item (its plugin.json hooks, .mcp.json
            // servers or linked hook files are not all listed here; security look r2, SHOULD 2).
            let hooks =
                !item.hook_lines.is_empty() || !item.hooks.is_empty() || item.kind == "hook";
            if hooks || item.source == "custom" {
                if hooks {
                    println!(
                        "{id} runs commands on agent events. Listed from its hooks/hooks.json:"
                    );
                    print_hooks(item);
                    println!(
                        "  (at most 32 commands, each cut at 300 characters; other hook kinds are not listed: read the files with `nunchiro extensions show {id}`)"
                    );
                } else {
                    println!(
                        "{id} is your own item; its files can run commands (plugin hooks, MCP servers): read them with `nunchiro extensions show {id}`"
                    );
                }
                if rest != ["--yes"] && !confirm() {
                    return Err(format!(
                        "{id} was not turned on; it can run commands, so pass --yes after reading them"
                    ));
                }
            }
            on.push(id.to_string());
            // Ticket 456: asked above (or --yes after the list), so the core is told it was confirmed.
            save(home, on, Some(vec![id.to_string()]))?;
            println!("{id} is on for new sessions");
        }
        ["off", id] => {
            find(&items, id)?;
            on.retain(|e| e != id);
            save(home, on, None)?;
            println!("{id} is off for new sessions");
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}

/// The extensions folder, its items, and Nunchiro's own hook lines.
fn listing(home: &Path) -> Result<(String, Vec<Item>, Vec<HookLine>), String> {
    match super::call(home, Request::ExtensionsList)? {
        Reply::Extensions {
            dir, items, hooks, ..
        } => Ok((dir, items, hooks)),
        _ => Err("unexpected reply".into()),
    }
}

fn settings(home: &Path) -> Result<LifetimeSettings, String> {
    match super::call(
        home,
        Request::QuitSettings {
            patch: Default::default(),
        },
    )? {
        Reply::QuitSettings { settings } => Ok(settings),
        _ => Err("unexpected reply".into()),
    }
}

fn enabled_ids(settings: &LifetimeSettings) -> Vec<String> {
    enabled(
        settings
            .features
            .get(ENABLED_KEY)
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
    )
}

fn set_own(home: &Path, id: &str, on: bool) -> Result<(), String> {
    let patch = if id == HOOKS {
        LifetimePatch {
            disable_hook_injection: Some(!on),
            ..Default::default()
        }
    } else {
        LifetimePatch {
            orchestration: Some(OrchestrationPatch {
                enabled: Some(on),
                create_override: None,
            }),
            ..Default::default()
        }
    };
    super::call(home, Request::QuitSettings { patch })?;
    Ok(())
}

fn save(home: &Path, on: Vec<String>, confirmed: Option<Vec<String>>) -> Result<(), String> {
    let patch = LifetimePatch {
        features: Some([(ENABLED_KEY.to_string(), on.into())].into()),
        extensions_confirmed: confirmed,
        ..Default::default()
    };
    super::call(home, Request::QuitSettings { patch })?;
    Ok(())
}

fn find<'a>(items: &'a [Item], id: &str) -> Result<&'a Item, String> {
    items.iter().find(|i| i.id == id).ok_or_else(|| {
        let known: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        format!("no extension {id}; known: {}", known.join(", "))
    })
}

fn state(on: &[String], id: &str) -> &'static str {
    if on.iter().any(|e| e == id) {
        "on"
    } else {
        "off"
    }
}

/// A list line keeps at most 80 characters: the text is cut at a word end and marked with "…".
/// Ticket 587: a cut inside a word read as a typo. A single word longer than the line is cut where the line ends.
fn cut(about: &str) -> String {
    const WIDTH: usize = 80;
    if about.chars().count() <= WIDTH {
        return about.to_string();
    }
    let room: String = about.chars().take(WIDTH - 1).collect();
    // The word that the room ends in is complete only when a space follows it.
    let whole = about
        .chars()
        .nth(WIDTH - 1)
        .is_some_and(char::is_whitespace);
    let head = match room.rfind(char::is_whitespace) {
        Some(i) if !whole && room[..i].chars().count() >= WIDTH / 2 => &room[..i],
        _ => &room,
    };
    format!("{}…", head.trim_end())
}

fn print_hooks(item: &Item) {
    item.hook_lines.iter().for_each(print_hook);
}

fn print_hook(h: &HookLine) {
    let matcher = if h.matcher.is_empty() {
        String::new()
    } else {
        format!(" [{}]", h.matcher)
    };
    println!("  {}{matcher}: {}", h.event, h.command);
}

/// Asks on a terminal; anything else (a pipe, a script) is a no.
fn confirm() -> bool {
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return false;
    }
    print!("Turn it on? [y/N] ");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).is_ok() && line.trim().eq_ignore_ascii_case("y")
}

#[cfg(test)]
mod tests {
    use super::cut;

    #[test]
    fn cut_keeps_a_short_line_and_ends_a_long_one_at_a_word() {
        let exact = "a".repeat(80);
        assert_eq!(cut(&exact), exact);
        let long = "Writes release notes from merged pull requests and posts them to the team channel every Friday.";
        let out = cut(long);
        assert_eq!(
            out,
            "Writes release notes from merged pull requests and posts them to the team…"
        );
        assert!(out.chars().count() <= 80);
        // The 80th character ends a word: that word stays whole.
        let edge = format!("{} tail words", "word ".repeat(15) + "last");
        assert_eq!(cut(&edge), format!("{}…", "word ".repeat(15) + "last"));
        // Text with one early space (Japanese, Chinese) is cut at the limit, not at that space.
        let ja = format!("Claude Code用の{}", "スキルです。".repeat(20));
        assert_eq!(cut(&ja).chars().count(), 80);
        assert!(cut(&ja).starts_with("Claude Code用の"), "{}", cut(&ja));
        let lead = format!(" {}", "x".repeat(120));
        assert_eq!(cut(&lead), format!(" {}…", "x".repeat(78)));
        // One long word has no word end to cut at.
        assert_eq!(cut(&"x".repeat(120)), format!("{}…", "x".repeat(79)));
    }
}
