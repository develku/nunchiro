//! Staffing a task: what to start for a seat, the account it runs on, and the steps that seat it.
use super::*;

/// Slice i: what to start for a seat of `role` on `task` (`Reply::Staff`); `seat_up` then starts it. The lead's
/// `task staff` and the core's auto-advance (ticket 1081 part B) both ask here, so the level floor of ticket 1055
/// holds for both.
#[allow(clippy::too_many_arguments)]
pub(crate) fn staff_plan(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    home: &Path,
    task: &Task,
    role: &str,
    path: Option<PathBuf>,
    asked_level: Option<crate::team::Level>,
    asked_effort: Option<String>,
    asked_account: Option<String>,
) -> crate::api::Response {
    let lock = || {
        registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())
    };
    let ledger = Ledger::open(home);
    if task.closed.is_some() {
        return Err(format!("task {} is closed", task.id));
    }
    let role = crate::roles::Roles::open(home)
            .get(role)
            .ok_or_else(|| {
                let have = crate::roles::Roles::open(home)
                    .list()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|r| r.name)
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "no role named {}; the roles are: {have} (propose a new one with `nunchiro role propose`)",
                    role.trim()
                )
            })?;
    let folder = match (&path, task.worktrees.as_slice()) {
        (Some(path), all) => {
            let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
            if !all.contains(&path) {
                return Err("that folder is no worktree of this task".into());
            }
            Some(path)
        }
        (None, [one]) => Some(one.clone()),
        (None, []) => None,
        (None, _) => {
            return Err("this task uses several worktrees: name one with --path".into());
        }
    };
    // Ticket 993 rule 9: a role's seat opens at a level as a teammate's does (`team::open_seat`): standard
    // when none is asked, the level table gives model and effort. A role with its own model keeps it (it
    // was the agent's own default before, the strongest and dearest model).
    // Ticket 1055: the seat follows Settings > Team > Worker models (`team::Workers`), as a teammate follows
    // its own rule. Rule 2: a seat that does not write (a Reviewer) never opens below the level the task's
    // writing seats (its Builder) opened at; that floor goes over the upper limit too.
    let workers = lock()?
        .feature::<crate::team::Workers>(crate::team::WORKERS_KEY)
        .unwrap_or_default();
    let floor = if role.writes {
        None
    } else {
        let mut sessions = lock()?;
        task.seats
            .iter()
            .filter(|s| s.writes)
            .filter_map(|s| sessions.session_of(&s.session).ok()?.level)
            .max()
    };
    let (level, why) = match role.model {
        Some(_) => (None, None),
        None => {
            let (level, why) =
                crate::team::rule_level(&role.name, workers.level, workers.level_max, asked_level);
            match floor {
                Some(floor) if floor > level => (
                    Some(floor),
                    Some(format!(
                        "{} opens at {}, the level its task's builder opened at",
                        role.name,
                        floor.word()
                    )),
                ),
                _ => (Some(level), why),
            }
        }
    };
    let (model, effort) = match (&role.model, level) {
        (Some(model), _) => (
            Some(model.clone()),
            asked_effort.clone().or(role.effort.clone()),
        ),
        (None, level) => {
            let table = lock()?.feature::<serde_json::Value>(crate::team::LEVELS_KEY);
            let level = level.unwrap_or(crate::team::Level::Standard);
            let agent = crate::team::agent_key(role.kind, None);
            let pick = crate::team::level_pick(table.as_ref(), &agent, level);
            (
                pick.model,
                asked_effort.clone().or(pick.effort).or(role.effort.clone()),
            )
        }
    };
    // Ticket 1120: an asked account must exist for the role's agent; the place's account applies where that agent has
    // one by that label (a Codex Reviewer in a place set to a Claude account runs on the lead's own). Whether the
    // caller may use it is `Sessions::launch_as`'s check (ACCOUNTPICK), at the start.
    let account = match (asked_account, crate::accounts::agent_of(role.kind)) {
        (Some(_), None) => return Err("an account is only for claude or codex seats".into()),
        (Some(label), Some(agent)) => {
            crate::accounts::folder_by_label(home, agent, &label).map_err(|e| {
                format!(
                    "{e}; the {} accounts are: {}",
                    crate::accounts::agent_name(agent),
                    labels_of(home, Some(agent))
                )
            })?;
            Some(label)
        }
        // Ticket 1126: else the owner's default for that agent, else (None) the lead's own.
        (None, agent) => ledger
            .place(&task.place)
            .account
            .filter(|label| {
                agent.is_some_and(|a| crate::accounts::folder_by_label(home, a, label).is_ok())
            })
            .or_else(|| crate::accounts::default_label(home, agent?)),
    };
    // Ticket 1054: an asked effort is one of this agent's (and this model's) own.
    if asked_effort.is_some() {
        crate::sessions::check_model(role.kind, model.as_deref(), effort.as_deref())?;
    }
    Ok(crate::api::Reply::Staff {
        task: task.id.clone(),
        folder,
        session: crate::api::StartSession {
            kind: role.kind,
            project: task.place.clone(),
            worktree: false,
            label: crate::roles::seat_name(&role.name, &task.title),
            // A role that does not write starts without the edit tools.
            // shortcut: Claude only, and its shell can still write; upgrade to a read-only sandbox profile
            // when non-writing seats must be held to it.
            args: match (role.kind, role.writes) {
                (crate::api::AgentKind::Claude, false) => vec![
                    "--disallowedTools".into(),
                    "Edit,Write,MultiEdit,NotebookEdit".into(),
                ],
                // The project's grant, not the role's: where the user said so, a seat that writes edits
                // files without asking (commands still ask). Never more than that from here.
                (crate::api::AgentKind::Claude, true)
                    if ledger.place(&task.place).seats == "edits" =>
                {
                    vec!["--permission-mode".into(), "acceptEdits".into()]
                }
                _ => vec![],
            },
            model,
            effort,
            resume: None,
            account,
        },
        level,
        why,
    })
}

/// Ticket 1120: the registered account labels (of `agent`, or of both agents), for a refusal; "none" with no account.
fn labels_of(home: &Path, agent: Option<crate::accounts::Agent>) -> String {
    use crate::accounts::Agent;
    let labels: Vec<String> = [Agent::Claude, Agent::Codex]
        .into_iter()
        .filter(|a| agent.is_none_or(|x| x == *a))
        .flat_map(|a| crate::accounts::labels(home, a))
        .collect();
    if labels.is_empty() {
        "none".into()
    } else {
        labels.join(", ")
    }
}

/// Ticket 1120, `task account`: `own` (or nothing) is the lead's own account; a label must be a registered account's.
pub(super) fn known_account(home: &Path, label: &str) -> Result<Option<String>, String> {
    use crate::accounts::Agent;
    if label.is_empty() || label == "own" {
        return Ok(None);
    }
    if [Agent::Claude, Agent::Codex]
        .into_iter()
        .any(|a| crate::accounts::labels(home, a).iter().any(|l| l == label))
    {
        return Ok(Some(label.to_string()));
    }
    Err(format!(
        "unknown account {label:?}; the accounts are: {} (or own)",
        labels_of(home, None)
    ))
}

/// Ticket 1081 part B: the steps after `staff_plan`'s answer, in one place for the lead's `task staff` (the CLI's
/// `call` sends each step as the caller's own request, so every start check holds) and the core's auto-advance
/// (advance.rs runs them in the core, the prompt through its checked core line): start the seat, seat it on a task
/// with no worktree and give it its level, then the first prompt. The task, the started session, and why its level is
/// not the asked one.
pub fn seat_up(
    staff: crate::api::Reply,
    prompt: Option<String>,
    call: &mut dyn FnMut(crate::api::Request) -> crate::api::Response,
) -> Result<(String, crate::api::Session, Option<String>), String> {
    use crate::api::{Reply, Request};
    let Reply::Staff {
        task,
        folder,
        session,
        level,
        why,
    } = staff
    else {
        return Err("no seat to start".into());
    };
    // Refused before the start, so no seat runs without its prompt.
    if let Some(text) = prompt.as_deref().filter(|t| t.len() > package::BRIEF_MAX) {
        return Err(package::too_long(text));
    }
    let seated = folder.is_some();
    let Reply::Started { session } = call(Request::Start {
        session,
        folder,
        env: Default::default(),
        receipt: None,
    })?
    else {
        return Err("the seat did not start".into());
    };
    // A seat on a task with no worktree is seated here; either way the seat's level goes with it.
    if !seated || level.is_some() {
        call(Request::Task {
            operation: "assign".into(),
            id: Some(task.clone()),
            text: String::new(),
            accept: vec![],
            project: None,
            path: None,
            session: Some(session.id.clone()),
            cites: None,
            all: false,
            level,
            who: None,
            due: None,
            effort: None,
            package: None,
            why: None,
            account: None,
            after: vec![],
        })?;
    }
    if let Some(text) = prompt {
        // Ticket 1095: the core keeps the words as the seat's brief and puts the package in front of them.
        let text = match call(Request::Task {
            operation: "brief".into(),
            id: Some(task.clone()),
            text: text.clone(),
            accept: vec![],
            project: None,
            path: None,
            session: Some(session.id.clone()),
            cites: None,
            all: false,
            level: None,
            who: None,
            due: None,
            effort: None,
            package: None,
            why: None,
            account: None,
            after: vec![],
        }) {
            Ok(Reply::Text { text }) => text,
            // The seat runs: it gets the words without the package rather than no prompt at all.
            Ok(_) => text,
            Err(e) => {
                eprintln!("task {task}: the package did not go with the first prompt: {e}");
                text
            }
        };
        call(Request::AgentPrompt {
            id: session.id.clone(),
            text,
        })?;
    }
    Ok((task, session, why))
}
