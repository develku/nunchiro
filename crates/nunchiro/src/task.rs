//! Ticket 990 slice g: `nunchiro task`, the job ledger from a session or the owner's shell.
use nunchiro_core::api::*;
use std::path::{Path, PathBuf};

pub const USAGE: &str = "nunchiro task new \"<outcome>\" [--accept \"<condition>\"]... [--after <id>]... [--project DIR]\n\
nunchiro task after <id> <id>... | --none (the lead or the user: the tasks of this place it waits for, set as a whole; --none clears them)\n\
nunchiro task list [--all] [--project DIR] | show <id>\n\
nunchiro task list --all-places [--all] (the Home lead only: every place's tasks, read only)\n\
nunchiro task digest [--json] (the Home lead and the user: each project's lead, open tasks and what waits for the user)\n\
nunchiro task goal \"<goal>\" --project DIR (the Home lead only: asks the user on a card to give that project's lead the goal)\n\
nunchiro task loops [--json] (the Home lead and the user: the open loops kept by Nunchiro, promises and waiting-for)\n\
nunchiro task promise|waiting \"<what>\" --who \"<name>\" [--due YYYY-MM-DD] (the Home lead: asks the user on a card to keep it; the user's own shell keeps it at once)\n\
nunchiro task loop-close <id> [\"<why>\"] (the Home lead: asks the user on a card to close it; the user's own shell closes it at once)\n\
nunchiro task attach <id> --path <worktree> | assign <id> <session>\n\
nunchiro task staff <id> <role> [--path <worktree>] [--prompt \"<first words>\"] [--level light|standard|deep] [--effort <effort>] [--account <label>] (starts a seat of that role; --account: the lead's own account or the place's)\n\
nunchiro task pass [\"<note>\"] [--task <id>] | changes \"<what to change>\" [--task <id>]\n\
nunchiro task learn \"<a lesson in one line>\" [--cites <file>] [--task <id>]\n\
nunchiro task ask-merge <id> (asks the user on a card; needs a passed review of the committed files)\n\
nunchiro task done <id> | drop <id>\n\
nunchiro task package <id> quote \"<words, exactly>\" --who \"<who said it>\" --when \"<when>\" [--image <attached image>]... | unquote <n> | background \"<your text>\" | see \"<what the user will see>\" | shown <n> | approve <n> | link <path or URL> --kind mockup|doc|code|url [--approved] | unlink <n> (the lead or the user: the task's work package; a quote is never edited, only removed and added)\n\
nunchiro task auto on|off --project DIR (the user's choice for a place: the core nudges stalled seats, wakes the lead, starts Reviewers)\n\
nunchiro task account <label>|own --project DIR (the user's choice for a place: the agent account its seats start on, staffed and auto-started alike; own is the lead's own)\n\
nunchiro task merge-ask on|off --project DIR (the user's choice for a place: a merge card before task work merges into the lead's working branch; off by default, the default branch always asks)\n\
nunchiro task cap 2|4|6|8 --project DIR (the user's choice: live seats of the place at which the core stops starting Reviewers; 4 by default)\n\
nunchiro task ask-cap 2|4|6|8 --why \"<what you saw>\" (a lead: asks the user on a card to change its place's live seats)\n\
nunchiro note list\n\
nunchiro role list | propose \"<name>\" --job \"<what it does>\" --why \"<what you counted>\" [--kind claude|codex] [--model M] [--reviews]\n\
(add --json for the record as JSON)";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    // `ask-merge` only files a card for the user. It is not called `merge`: a real Claude lead in auto mode had
    // `nunchiro task merge` refused by its permission classifier as a destructive action. The old word still works.
    let mut operation = match args.first().ok_or(USAGE)?.as_str() {
        "ask-merge" => "merge".to_string(),
        other => other.to_string(),
    };
    let (mut id, mut text, mut accept, mut project, mut path, mut session) =
        (None, String::new(), vec![], None, None, None);
    let mut cites = None;
    let (mut prompt, mut level, mut effort) = (None, None, None);
    let (mut who, mut due) = (None, None); // ticket 1003
    let mut why = None; // ticket 1099 panel 4
    let mut account = None; // ticket 1120
    let (mut after, mut none) = (vec![], false);
    // Ticket 1095: `task package`.
    let (mut when, mut images, mut kind, mut approved) = (None, vec![], None, false);
    let (mut all, mut json, mut places) = (false, false, false);
    let mut plain = vec![];
    let mut words = args[1..].iter();
    while let Some(word) = words.next() {
        let mut value = || words.next().cloned().ok_or("missing task option value");
        match word.as_str() {
            "--all" => all = true,
            "--all-places" => places = true,
            "--json" => json = true,
            "--accept" => accept.push(value()?),
            "--after" => after.push(value()?),
            "--none" => none = true,
            "--task" => id = Some(value()?),
            "--cites" => cites = Some(value()?),
            "--prompt" => prompt = Some(value()?),
            "--who" => who = Some(value()?),
            "--due" => due = Some(value()?),
            "--why" => why = Some(value()?),
            "--account" => account = Some(value()?),
            "--when" => when = Some(value()?),
            "--kind" => kind = Some(value()?),
            "--approved" => approved = true,
            "--image" => images.push(std::path::absolute(value()?).map_err(|e| e.to_string())?),
            "--effort" => effort = Some(value()?), // ticket 1054; the core checks it against the agent's list
            // Ticket 993 rule 9: the level a staffed seat opens at.
            "--level" => {
                level = Some(
                    nunchiro_core::team::Level::parse(&value()?)
                        .ok_or("--level is light, standard or deep")?,
                )
            }
            "--project" => project = Some(PathBuf::from(value()?)),
            // The core runs in another folder: a relative path is the caller's, so it is made absolute here.
            "--path" => path = Some(std::path::absolute(value()?).map_err(|e| e.to_string())?),
            option if option.starts_with("--") => {
                return Err(format!("unknown task option {option}"));
            }
            word => plain.push(word.to_string()),
        }
    }
    let mut plain = plain.into_iter();
    match operation.as_str() {
        "new" | "pass" | "changes" | "learn" | "way" | "grant" | "auto" | "cap" | "account"
        | "merge-ask" | "ask-cap" | "goal" | "promise" | "waiting" => {
            text = plain.next().unwrap_or_default()
        }
        "loop-close" => {
            id = plain.next().or(id);
            text = plain.next().unwrap_or_default();
        }
        "show" | "attach" | "done" | "drop" | "merge" => id = plain.next().or(id),
        "assign" => {
            id = plain.next().or(id);
            session = plain.next();
        }
        "staff" => {
            id = plain.next().or(id);
            text = plain.next().unwrap_or_default();
        }
        // Set as a whole: a bare `task after <id>` names nothing, so it clears nothing by a slip.
        "after" => {
            id = plain.next().or(id);
            after.extend(plain.by_ref());
            if after.is_empty() == !none {
                return Err(USAGE.into());
            }
        }
        "list" | "digest" | "loops" => {}
        "package" => {
            id = plain.next().or(id);
            let part = plain.next().unwrap_or_default();
            if !nunchiro_core::ledger::package::PARTS.contains(&part.as_str()) {
                return Err(USAGE.into());
            }
            operation = format!("package-{part}");
            text = plain.next().unwrap_or_default();
        }
        _ => return Err(USAGE.into()),
    }
    let package = operation
        .starts_with("package-")
        .then(|| nunchiro_core::ledger::package::Fill {
            who: who.take(),
            when,
            images,
            kind,
            approved,
        });
    let operation = if places && operation == "list" {
        "list-all".to_string()
    } else {
        operation
    };
    if plain.next().is_some() {
        return Err(format!("too many words; quote the text\n{USAGE}"));
    }
    let goal = operation == "goal";
    let show = operation == "show" || package.is_some();
    super::ensure_core(home)?;
    let reply = super::call(
        home,
        Request::Task {
            operation,
            id,
            text,
            accept,
            project,
            path,
            session,
            cites,
            all,
            level,
            who,
            due,
            effort,
            package,
            why,
            account,
            after,
        },
    )?;
    // Slice i: the core says what to start for the seat; the start, the seat on a task with no worktree and the first
    // prompt are this caller's own requests, so every start check holds.
    let reply = match reply {
        staff @ Reply::Staff { .. } => {
            let (task, session, why) =
                nunchiro_core::ledger::seat_up(staff, prompt, &mut |r| super::call(home, r))
                    .map_err(|e| {
                        // Ticket 1120: a lead that names another account before the user set it for the place.
                        if e.contains("only on its own account") {
                            format!("{e}; ask the user to set the place's account with `nunchiro task account <label> --project DIR`")
                        } else {
                            e
                        }
                    })?;
            // Ticket 994: the model and effort the seat's level resolved to, as the agent names them.
            let pair = nunchiro_core::team::pick_words(
                session.kind,
                session.model.as_deref(),
                session.effort.as_deref(),
            );
            // Ticket 1120: and the account, when it is not the default one.
            let on = session
                .account
                .as_deref()
                .map_or(String::new(), |a| format!(" · {a}"));
            println!(
                "started {} ({}) on task {task}, on {pair}{on}",
                session.label, session.id
            );
            // Ticket 1055: the level it opened at is not the asked one (Worker models, its builder's level).
            if let Some(why) = why {
                println!("{why}");
            }
            return Ok(());
        }
        reply => reply,
    };
    match reply {
        Reply::Text { text } if !json => println!("{text}"),
        // Ticket 1003: the counts first (the core's, for a brief), then one line per open loop.
        Reply::Loops {
            loops,
            counts,
            today,
        } if !json => {
            println!(
                "Open loops on {today}: {} overdue · {} waiting · {} promised",
                counts.overdue, counts.waiting, counts.promises
            );
            for row in &loops {
                let late = if nunchiro_core::loops::overdue(row, &today) {
                    " · overdue"
                } else {
                    ""
                };
                println!(
                    "{}: {}{late} · from {}",
                    row.id,
                    nunchiro_core::loops::words(row),
                    row.source
                );
            }
        }
        Reply::Digest {
            projects,
            failed_runs,
            outbox,
            loops,
            loop_cards,
        } if !json => {
            if projects.is_empty() {
                println!("No project.");
            }
            // Ticket 993 rule 6: the count first, a failed scheduled run among it, each named in one line.
            // Ticket 1002 lane 2: so is each waiting Outbox card.
            let needs = projects.iter().map(|p| p.needs).sum::<usize>()
                + failed_runs.len()
                + outbox
                + loop_cards;
            if !projects.is_empty() || !failed_runs.is_empty() || outbox + loop_cards > 0 {
                println!("{needs} need the user");
            }
            if outbox > 0 {
                println!("Outbox: {outbox} waiting");
            }
            // Ticket 1003: counted by the core; `nunchiro task loops` names them.
            if !loops.is_zero() {
                println!(
                    "Open loops: {} overdue · {} waiting · {} promised",
                    loops.overdue, loops.waiting, loops.promises
                );
            }
            for run in &failed_runs {
                println!("Scheduled run failed: {} ({})", run.line, run.reason);
            }
            for p in &projects {
                let lead = match (&p.lead, p.lead_state.as_deref()) {
                    (Some(_), Some("failed")) => "a lead (failed)",
                    (Some(_), _) => "a lead",
                    (None, _) => "no leader",
                };
                println!(
                    "{}: {lead} · {} open tasks · {} waiting for the user · {} working{}",
                    p.project.display(),
                    p.open,
                    p.needs,
                    p.working,
                    if p.line.is_empty() {
                        String::new()
                    } else {
                        format!(" · last: {}", p.line)
                    }
                );
            }
        }
        Reply::Tasks { .. } if goal && !json => {
            println!("Asked the user on a card. The answer comes as a line in your room.");
        }
        Reply::Tasks { tasks, place } if !json => {
            if let Some(place) = place {
                let seats = match place.seats.as_str() {
                    "edits" => "may edit files without asking; commands ask the user",
                    _ => "ask the user before each edit and command",
                };
                // Ticket 1081: whether the core nudges stalled seats and tells the lead what waits.
                let auto = if place.auto { "on" } else { "off" };
                // Ticket 1120: the account the place's seats start on, only when the user set one (the default line stays
                // as it was before 1120).
                let account = place.account.as_deref().map_or(String::new(), |a| {
                    format!(" Seats start on the account {a}.")
                });
                println!(
                    "Way of working here: {} (levels.md). Seats here {seats}. Auto-advance: {auto}, up to {} seats at once.{account}",
                    place.way, place.cap
                );
            }
            if tasks.is_empty() {
                println!("No open task.");
            }
            let mut at = None;
            for task in &tasks {
                // Every place's list (`--all-places`): each place's tasks under its folder.
                if places && at != Some(&task.task.place) {
                    at = Some(&task.task.place);
                    println!("{}:", task.task.place.display());
                }
                print!("{}", nunchiro_core::ledger::lines(task, show));
            }
        }
        reply => println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        ),
    }
    Ok(())
}
