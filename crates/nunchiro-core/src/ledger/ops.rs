//! The ledger's requests: who asks and what they ask, and each operation, for the socket and the window alike.
use super::*;

/// Who asks (`Sessions::task_caller`).
pub(crate) struct Who {
    /// `None`: the owner with no project named, who reads every place.
    pub place: Option<PathBuf>,
    /// The lead of the place (the owner's request), or the lead this session is or works for.
    pub lead: Option<String>,
    /// The owner, or the lead's own seat: makes, staffs and closes tasks.
    pub decides: bool,
    pub session: Option<String>,
    pub name: String,
}

/// `Request::Task`, as its fields.
pub(crate) struct Ask {
    pub operation: String,
    pub id: Option<String>,
    pub text: String,
    pub accept: Vec<String>,
    pub project: Option<PathBuf>,
    pub path: Option<PathBuf>,
    pub session: Option<String>,
    pub cites: Option<String>,
    pub all: bool,
    pub level: Option<crate::team::Level>,
    pub who: Option<String>,
    pub due: Option<String>,
    pub effort: Option<String>,
    pub package: Option<package::Fill>,
    pub why: Option<String>,
    pub account: Option<String>,
    pub after: Vec<String>,
}

/// The three requests of slices g to i, for the socket and the window alike.
pub(crate) fn dispatch(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    request: crate::api::Request,
) -> crate::api::Response {
    use crate::api::Request;
    match request {
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
        } => serve(
            registry,
            caller,
            Ask {
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
        ),
        Request::Note {
            operation,
            id,
            text,
            scope,
            task,
            lesson,
        } => crate::notes::serve(registry, caller, operation, id, text, scope, task, lesson),
        Request::Role {
            operation,
            role,
            name,
            why,
        } => crate::roles::serve(registry, caller, operation, role, name, why),
        _ => Err("not a ledger request".into()),
    }
}

/// One ledger request. Git is read with no lock held; the registry is locked only to ask who the caller is and what
/// each seat does now.
pub(crate) fn serve(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    ask: Ask,
) -> crate::api::Response {
    let lock = || {
        registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())
    };
    let now = crate::queue::now_ms();
    let (home, who) = {
        let sessions = lock()?;
        (
            sessions.home().to_path_buf(),
            sessions.task_caller(caller, ask.project.as_deref())?,
        )
    };
    let ledger = Ledger::open(&home);
    let decides = |what: &str| {
        if who.decides {
            Ok(())
        } else {
            Err(format!(
                "only the lead of a place or the user may {what} a task"
            ))
        }
    };
    let orderer = match &who.session {
        None => "the user".to_string(),
        Some(_) => who.name.clone(),
    };
    // A session reaches the tasks of its own place only.
    let mine = |t: &Task| who.place.as_ref().is_none_or(|p| *p == t.place);
    // Home view change 5: the Home lead's own seat reads every place's tasks, and nothing more.
    let team = crate::team::Team::open(&home);
    let home_lead = who.decides
        && who.session.is_some()
        && who
            .lead
            .as_ref()
            .is_some_and(|l| team.lead_of(None).is_some_and(|t| t.id == *l));
    let named = |id: &Option<String>| -> Result<Task, String> {
        let id = id
            .as_deref()
            .ok_or("name the task: its id is in `nunchiro task list`")?;
        let all = ledger.list()?;
        if let Some(t) = all.iter().find(|t| t.id == id && mine(t)) {
            return Ok(t.clone());
        }
        // Look 1117 home S2-5: the Home lead sees every place's tasks, so "no task" read as a missing task. It is a
        // refusal, and says what to do instead.
        match all.iter().find(|t| t.id == id) {
            Some(t) if home_lead => Err(format!(
                "task {id} is in {}: the Home lead reads other projects' tasks; it cannot change them. Send a goal to that project's lead with nunchiro task goal --project {}",
                t.place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                t.place.display()
            )),
            _ => Err(format!("no task {id} in this place")),
        }
    };
    // Look 1117 home S2-4: the Home lead names another project with --project to read that place's tasks (read only).
    let other = match (&ask.project, &who.place) {
        (Some(p), Some(own)) if home_lead => {
            let p = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
            (p != *own).then_some(p)
        }
        _ => None,
    };
    let changed: Vec<Task> = match ask.operation.as_str() {
        // Read only: no task is closed from here (`list` closes the merged ones of its own place).
        "list-all" => {
            if !home_lead {
                return Err("only the Home lead lists every place's tasks".into());
            }
            let mut tasks: Vec<Task> = ledger
                .list()?
                .into_iter()
                .filter(|t| ask.all || t.closed.is_none())
                .collect();
            tasks.sort_by(|a, b| a.place.cmp(&b.place));
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: None,
            });
        }
        // Home view change 1: the user's digest of every registered project. `text` is when the window was last
        // there (ms), for what changed since.
        // Look 1117 home S2-4: the Home lead reads it too (`nunchiro task digest`), to say which project needs the user.
        "digest" => {
            if who.session.is_some() && !home_lead {
                return Err("only the user and the Home lead read the Home digest".into());
            }
            let since = ask.text.trim().parse::<u64>().unwrap_or(0);
            let tasks = ledger.list()?;
            let sessions = lock()?;
            let (roots, facts) = sessions.digest_facts();
            // Ticket 993: both readers of the digest (the user, the Home lead) read every place's schedules.
            let failed_runs = sessions.failed_runs();
            let outbox = sessions.outbox_count(); // ticket 1002 lane 2
            let loop_cards = sessions.loop_card_count(); // ticket 1003
            drop(sessions);
            // Ticket 1003: the open loops' counts; a store that cannot be read counts as none here (`task loops` says why).
            let open = crate::loops::Loops::open(&home).list().unwrap_or_default();
            return Ok(crate::api::Reply::Digest {
                projects: digest(&tasks, roots, facts, &team, since),
                failed_runs,
                outbox,
                loops: crate::loops::counts(&open, &crate::loops::today(now)),
                loop_cards,
            });
        }
        // Ticket 1003: the open loops (`loops.rs`). The user and the Home lead read them. The user's own shell adds
        // and closes rows; the Home lead only asks, on a card, and nothing is stored or closed before the yes.
        "loops" | "promise" | "waiting" | "loop-close" => {
            let owner = who.session.is_none();
            if !owner && !home_lead {
                return Err("only the user and the Home lead reach the open loops".into());
            }
            let loops = crate::loops::Loops::open(&home);
            let text = |text: String| Ok(crate::api::Reply::Text { text });
            let session = who.session.clone().unwrap_or_default();
            return match ask.operation.as_str() {
                "loops" => {
                    let open = loops.list()?;
                    let today = crate::loops::today(now);
                    Ok(crate::api::Reply::Loops {
                        counts: crate::loops::counts(&open, &today),
                        loops: open,
                        today,
                    })
                }
                "loop-close" => {
                    let id = ask
                        .id
                        .as_deref()
                        .ok_or("name the open loop: its id is in `nunchiro task loops`")?;
                    let row = loops
                        .list()?
                        .into_iter()
                        .find(|r| r.id == id)
                        .ok_or_else(|| format!("no open loop {id}"))?;
                    let words = crate::loops::words(&row);
                    if owner {
                        loops.close(id, now)?;
                        lock()?.retire_loop_cards(id)?;
                        return text(format!("Closed open loop {id}: {words}."));
                    }
                    let why = Some(line(&ask.text, 300)).filter(|w| !w.is_empty());
                    lock()?.ask_loop(&session, "close", row, who.name.clone(), why)?;
                    text(format!(
                        "Asked the user to close open loop {id} ({words}). It stays open until their yes; the answer comes as a line in your room."
                    ))
                }
                kind => {
                    let source = if owner {
                        "the user"
                    } else {
                        "the user's words, heard by the Home lead"
                    };
                    let row = crate::loops::draft(
                        kind,
                        ask.who.as_deref().unwrap_or_default(),
                        &ask.text,
                        ask.due.as_deref(),
                        ask.cites.as_deref().unwrap_or(source),
                    )?;
                    let words = crate::loops::words(&row);
                    if owner {
                        let kept = loops.add(row, now)?;
                        lock()?.loops_changed();
                        return text(format!("Kept open loop {}: {words}.", kept.id));
                    }
                    if let Some(open) = loops
                        .list()?
                        .into_iter()
                        .find(|r| crate::loops::same(r, &row))
                    {
                        return text(format!(
                            "Open loop {} already holds this: {}.",
                            open.id,
                            crate::loops::words(&open)
                        ));
                    }
                    lock()?.ask_loop(&session, "add", row, who.name.clone(), None)?;
                    text(format!(
                        "Asked the user to keep this open loop: {words}. Nothing is kept before their yes; the answer comes as a line in your room."
                    ))
                }
            };
        }
        // Ticket 1099 panel 4: a place's lead asks the user to change its live seats. Only the user's yes on the card
        // sets the cap (`Sessions::answer_inner`); the lead never sets it itself (`cap` above).
        "ask-cap" => {
            let (Some(session), true) = (&who.session, who.decides) else {
                return Err(
                    "only the lead of a place asks the user to change its live seats".into(),
                );
            };
            let place = who.place.clone().ok_or("no place for this session")?;
            let cap: u32 = ask
                .text
                .trim()
                .parse()
                .ok()
                .filter(|c| CAPS.contains(c))
                .ok_or("seats at once is 2, 4, 6 or 8")?;
            let was = ledger.place(&place).cap;
            if cap == was {
                return Err(format!("this place already runs {cap} seats at once"));
            }
            let why = line(ask.why.as_deref().unwrap_or_default(), LINE_MAX);
            if why.is_empty() {
                return Err("say why in a line: what you saw (--why)".into());
            }
            lock()?.ask_cap(session, place, was, cap, why)?;
            return Ok(crate::api::Reply::Text {
                text: format!(
                    "Asked the user to change the live seats here from {was} to {cap}. Nothing changes before their yes; the answer comes as a line in your room."
                ),
            });
        }
        // Home view change 4: the Home lead asks to give a project's lead a goal. It becomes the user's card; nothing
        // reaches the project before the yes.
        "goal" => {
            if !home_lead {
                return Err("only the Home lead asks to give a project's lead a goal".into());
            }
            let project = ask
                .project
                .as_deref()
                .ok_or("name the project with --project")?;
            let project = std::fs::canonicalize(project).map_err(|e| e.to_string())?;
            let name = project
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let lead = team.lead_of(Some(&project)).ok_or_else(|| {
                format!(
                    "{name} has no leader: a goal goes to a project's leader, and only the user adds one (the tree or Settings > Team)"
                )
            })?;
            let text = line(&ask.text, 2000);
            if text.is_empty() {
                return Err("say the goal in a line".into());
            }
            let session = who.session.clone().unwrap_or_default();
            lock()?.ask_goal(&session, project, lead.id, who.name.clone(), text)?;
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![],
                place: None,
            });
        }
        "list" if other.is_some() => {
            let tasks = ledger
                .list()?
                .into_iter()
                .filter(|t| Some(&t.place) == other.as_ref() && (ask.all || t.closed.is_none()))
                .collect();
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: None,
            });
        }
        "list" => {
            let mut tasks = ledger.list()?;
            // A task whose approved commit is in the project is closed here, not when its lead gets to say done
            // (real-app look 11-17: a merged task read "merge" for minutes while the lead worked on the next one).
            let mut merged = false;
            for t in tasks.iter_mut().filter(|t| mine(t)) {
                if in_project(t) {
                    *t = ledger.close(&t.id, "merged", now)?;
                    lock()?.retire_merge_card(&t.id)?;
                    crate::events::tasks(&t.place);
                    merged = true;
                }
            }
            if merged {
                crate::advance::release(registry, &home);
            }
            let tasks = tasks
                .into_iter()
                .filter(|t| mine(t) && (ask.all || t.closed.is_none()))
                .collect();
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: who.place.as_deref().map(|p| ledger.place(p)),
            });
        }
        "show" => {
            // Reading is the Home lead's in every place.
            let task = match (home_lead, ask.id.as_deref()) {
                (true, Some(id)) => ledger.list()?.into_iter().find(|t| t.id == id),
                _ => None,
            };
            let task = match task {
                Some(t) => t,
                None => named(&ask.id)?,
            };
            let package = Packages::open(&home).get(&task.id)?;
            let mut tasks = views(registry, &home, vec![task])?;
            tasks[0].package = Some(package);
            return Ok(crate::api::Reply::Tasks {
                tasks,
                place: who.place.as_deref().map(|p| ledger.place(p)),
            });
        }
        // Ticket 1095: the task's package, filled by the place's lead or the user only (threat 1: a worker seat never
        // writes the owner's quotes). `text` is the part's words or a line's number; `package` the rest.
        op if op
            .strip_prefix("package-")
            .is_some_and(|p| package::PARTS.contains(&p)) =>
        {
            decides("fill the package of")?;
            let task = named(&ask.id)?;
            if task.closed.is_some() {
                return Err(format!(
                    "task {} is closed: its package is kept as it is",
                    task.id
                ));
            }
            let fill = ask.package.clone().unwrap_or_default();
            let part = &op["package-".len()..];
            let (_, package) = Packages::open(&home).change(&task.id, |p| {
                package::apply(
                    p,
                    &home,
                    part,
                    &ask.text,
                    &fill,
                    &who.name,
                    who.session.is_none(),
                    now,
                )
            })?;
            crate::events::tasks(&task.place);
            let mut tasks = views(registry, &home, vec![task])?;
            tasks[0].package = Some(package);
            return Ok(crate::api::Reply::Tasks { tasks, place: None });
        }
        // Ticket 1095 rule 3: the first prompt `task staff` sends (`seat_up`): the package's quoted lines and background
        // go in front of it, in full, and the words are kept as the seat's brief. `session` is the seat.
        "brief" => {
            decides("brief a seat of")?;
            let task = named(&ask.id)?;
            let seat = ask.session.as_deref().ok_or("name the seat")?;
            return ledger
                .brief(&task.id, seat, &ask.text, now)
                .map(|text| crate::api::Reply::Text { text });
        }
        // Slice i: the user's choices for this place (`text`): `way` solo|team|strict, `grant` ask|edits. The
        // place's lead hears a new way in the room.
        op @ ("way" | "grant" | "auto" | "cap" | "account" | "merge-ask") => {
            if who.session.is_some() && op == "account" {
                return Err("only the user sets the account a place's seats start on (`nunchiro task account <label> --project DIR` in the user's shell, or Settings > Team)".into());
            }
            if who.session.is_some() && op == "cap" {
                return Err("only the user sets the live seats of a place; ask them on a card with `nunchiro task ask-cap <n> --why \"<reason>\"`".into());
            }
            if who.session.is_some() {
                return Err(
                    "only the user sets a place's way of working and what its seats may do".into(),
                );
            }
            let place = who
                .place
                .as_deref()
                .ok_or("name the project with --project")?;
            let now_is = match op {
                "way" => ledger.set_place(place, Some(ask.text.trim()), None, None)?,
                "grant" => ledger.set_place(place, None, Some(ask.text.trim()), None)?,
                "account" => ledger.set_account(place, known_account(&home, ask.text.trim())?)?,
                "merge-ask" => ledger.set_ask_merge(
                    place,
                    match ask.text.trim() {
                        "on" => true,
                        "off" => false,
                        _ => return Err("asking before merging task work is on or off".into()),
                    },
                )?,
                "cap" => ledger.set_cap(
                    place,
                    ask.text
                        .trim()
                        .parse()
                        .map_err(|_| "seats at once is 2, 4, 6 or 8")?,
                )?,
                _ => {
                    let on = match ask.text.trim() {
                        "on" => true,
                        "off" => false,
                        _ => return Err("auto-advance is on or off".into()),
                    };
                    ledger.set_place(place, None, None, Some(on))?
                }
            };
            crate::events::tasks(place);
            // The cap only holds the core back: the lead is not told.
            if let Some(lead) = who.lead.as_ref().filter(|_| op != "cap") {
                let body = if op == "way" {
                    format!(
                        "The user set the way of working here to {} (`nunchiro skill get orchestration --file levels.md`).",
                        now_is.way
                    )
                } else if op == "auto" {
                    crate::advance::auto_line(now_is.auto)
                } else if op == "merge-ask" {
                    if now_is.ask_merge {
                        "The user wants a merge card again before task work merges here: `nunchiro task ask-merge <id>` asks them.".to_string()
                    } else {
                        "The user lets reviewed task work merge into your working branch here without a card: `nunchiro task ask-merge <id>` then tells you to merge it. Never into the default branch: that still takes the user's card.".to_string()
                    }
                } else if op == "account" {
                    match &now_is.account {
                        Some(label) => format!(
                            "The user set seats here to start on the account {label} (`nunchiro task staff` uses it unless --account names another)."
                        ),
                        None => "The user set seats here to start on your own account.".to_string(),
                    }
                } else if now_is.seats == "edits" {
                    "The user lets seats here edit files in their worktree without asking; commands still ask.".to_string()
                } else {
                    "The user wants seats here to ask before each edit and command.".to_string()
                };
                lock()?.team_note(
                    place,
                    lead,
                    None,
                    body,
                    crate::room::TeamNote {
                        what: op.into(),
                        worktree: None,
                        // Ticket 1081: the window says "Auto-advance is now on" from it.
                        name: (op == "auto").then(|| if now_is.auto { "on" } else { "off" }.into()),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                );
            }
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![],
                place: Some(now_is),
            });
        }
        "new" => {
            decides("make")?;
            let place = who
                .place
                .as_deref()
                .ok_or("name the project with --project")?;
            ledger.check_new_after(place, &ask.after)?;
            let (task, _) = ledger.make(
                place,
                who.lead.as_deref(),
                &ask.text,
                &ask.accept,
                false,
                now,
            )?;
            if ask.after.is_empty() {
                vec![task]
            } else {
                vec![ledger.set_after(&task.id, &ask.after, &orderer, now)?]
            }
        }
        // What a task waits for, set as a whole; none clears it. The lead of the place and the user.
        "after" => {
            decides("change the order of")?;
            let task = named(&ask.id)?;
            let was = blockers(&task, &ledger.list()?);
            let set = ledger.set_after(&task.id, &ask.after, &orderer, now)?;
            // The user's Start anyway or Stop waiting: the lead hears which wait the user ended.
            let ended: Vec<String> = was
                .iter()
                .filter(|b| !set.after.contains(&b.id))
                .map(|b| {
                    format!(
                        "The owner let \"{}\" start without waiting for \"{}\".",
                        set.title, b.title
                    )
                })
                .collect();
            if let (None, Some(lead), false) = (&who.session, &who.lead, ended.is_empty()) {
                lock()?.team_note(
                    &set.place,
                    lead,
                    None,
                    ended.join(" "),
                    crate::room::TeamNote {
                        what: "after".into(),
                        worktree: None,
                        name: None,
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                );
            }
            vec![set]
        }
        "attach" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            let path = ask.path.as_deref().ok_or("requires --path")?;
            let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
            // Only a worktree this core manages for the task's own project.
            if lock()?
                .recorded_worktree(&path)
                .is_none_or(|w| w.project != task.place || w.missing)
            {
                return Err("not a worktree of this task's project".into());
            }
            vec![ledger.attach(&task.id, &path, now)?]
        }
        "assign" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            let session = ask.session.as_deref().ok_or("requires a session id")?;
            let (label, cwd) = lock()?.seat_place(session, &task.place)?;
            // A writer started by hand and assigned waits with its task as a staffed one does.
            if crate::roles::of(&home, &label).1 {
                let waits = blockers(&task, &ledger.list()?);
                if !waits.is_empty() {
                    return Err(not_started(&task, &waits));
                }
            }
            // A seat inside one of the task's worktrees is under the one-writer rule like a start there.
            let worktree = task.worktrees.iter().find(|w| **w == cwd).cloned();
            if let Some(w) = &worktree
                && crate::roles::of(&home, &label).1
            {
                let sessions = lock()?;
                ledger.writer_free(w, |s| s != session && sessions.seat_now(s).live)?;
            }
            let running: std::collections::BTreeSet<String> = {
                let sessions = lock()?;
                task.seats
                    .iter()
                    .filter(|s| sessions.seat_now(&s.session).live)
                    .map(|s| s.session.clone())
                    .collect()
            };
            let seated =
                ledger.seat_on(&task.id, session, &label, worktree.as_deref(), now, &|s| {
                    running.contains(s)
                })?;
            // Look v9 B N-S3-6: the level `staff` opened the seat at, so its rows show the bars and what it runs.
            if let Some(level) = ask.level {
                lock()?.role_seat_level(session, level)?;
            }
            vec![seated]
        }
        verdict @ ("pass" | "changes") => {
            // The task is named, or it is the one the calling seat sits on.
            let task = match (&ask.id, &who.session) {
                (None, Some(session)) => ledger
                    .of_seat(session)
                    .filter(|t| mine(t))
                    .ok_or("this session is no seat of a task of its place; name the task")?,
                _ => named(&ask.id)?,
            };
            // A review is a reviewer's: the user, or a seat of this task that does not write. Never the builder's own.
            let by = match &who.session {
                None => "user".to_string(),
                Some(session) => {
                    let seat = task.seats.iter().find(|s| s.session == *session);
                    if seat.is_none_or(|s| s.writes) {
                        return Err(format!(
                            "only a reviewer seat of task {} reviews it (a session started in its worktree with a \
                             name that starts with `review`)",
                            task.id
                        ));
                    }
                    session.clone()
                }
            };
            // Read now, with no lock: the review speaks for exactly these files.
            let revision = revision_of(&task).ok_or(
                "the task's files cannot be read as one revision now: no review can bind to them",
            )?;
            vec![ledger.review(
                &task.id,
                Review {
                    revision,
                    pass: verdict == "pass",
                    note: ask.text.clone(),
                    by,
                    name: who.name.clone(),
                    at: now,
                },
            )?]
        }
        "learn" => {
            // A lesson is proposed by who learned it: a seat of the task (the task named or its own), or its lead.
            let task = match (&ask.id, &who.session) {
                (None, Some(session)) => ledger
                    .of_seat(session)
                    .filter(|t| mine(t))
                    .ok_or("this session is no seat of a task of its place; name the task")?,
                _ => named(&ask.id)?,
            };
            let seat = who
                .session
                .as_ref()
                .and_then(|s| task.seats.iter().find(|x| x.session == *s));
            let (name, role) = match seat {
                // A seat started by `task staff` is already named by its role ("Builder · tax").
                Some(seat)
                    if seat
                        .name
                        .to_lowercase()
                        .starts_with(&format!("{} ·", seat.role)) =>
                {
                    (seat.name.clone(), seat.role.clone())
                }
                Some(seat) => (
                    format!("{} · {}", cap(&seat.role), seat.name),
                    seat.role.clone(),
                ),
                None if who.decides && who.session.is_some() => {
                    (format!("Lead · {}", who.name), "lead".to_string())
                }
                None if who.decides => ("the user".to_string(), "lead".to_string()),
                None => return Err("only a seat of the task or its lead proposes a lesson".into()),
            };
            vec![ledger.learn(
                &task.id,
                Lesson {
                    text: ask.text.clone(),
                    name,
                    role,
                    cites: ask.cites.clone(),
                    at: now,
                },
            )?]
        }
        "merge" => {
            decides("ask to merge")?;
            let task = named(&ask.id)?;
            if task.worktrees.is_empty() {
                return Err("this task uses no worktree: there is nothing to merge (close it with `task done`)".into());
            }
            // Never a card for files no review saw: the state is read now, from the files as they are.
            let view = views(registry, &home, vec![task])?.remove(0);
            if !matches!(view.state.as_str(), "approved" | "merge") {
                let why = if view.stale {
                    ", the files changed after the review"
                } else {
                    ""
                };
                return Err(format!(
                    "task {} is not approved for the files as they are now (state: {}{why}): have it reviewed \
                     first (`nunchiro task pass` by its reviewer seat)",
                    view.task.id, view.state
                ));
            }
            if view.state == "merge" {
                return Err(format!(
                    "the user already said yes to merging task {} at these files: merge it now",
                    view.task.id
                ));
            }
            let revision = view
                .task
                .review
                .as_ref()
                .map(|r| r.revision.clone())
                .unwrap_or_default();
            // The yes names commits: a reviewed worktree with uncommitted files has nothing exact to merge.
            if revision.contains('+') {
                return Err(format!(
                    "task {} was reviewed with uncommitted files: commit them, have that commit reviewed, then ask \
                     again (the user's yes names the exact commit to merge)",
                    view.task.id
                ));
            }
            // Owner direction: reviewed task work merges into the lead's working branch with no card, unless the user
            // asks for one here. The default branch always takes the card.
            if !ledger.place(&view.task.place).ask_merge
                && let Some(branch) = working_branch(&view.task.place)
            {
                ledger.merge_ok(&view.task.id, &revision, now)?;
                crate::events::tasks(&view.task.place);
                return Ok(crate::api::Reply::Text {
                    text: merged_line(&view.task.id, &view.task.title, &revision, &branch),
                });
            }
            let session = who.session.clone().unwrap_or_default();
            lock()?.ask_merge(&session, &view.task, &revision)?;
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![view],
                place: None,
            });
        }
        // Slice i: what to start for a seat of `text` (a role's name) on this task. The caller then sends the start
        // itself, so every start check holds; the seat is recorded there by its name.
        "staff" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            return staff_plan(
                registry,
                &home,
                &task,
                &ask.text,
                ask.path.clone(),
                ask.level,
                ask.effort.clone(),
                ask.account.clone(),
            );
        }
        how @ ("done" | "drop") => {
            decides("close")?;
            let task = named(&ask.id)?;
            let closed = ledger.close(
                &task.id,
                if how == "done" { "done" } else { "dropped" },
                now,
            )?;
            lock()?.retire_merge_card(&closed.id)?;
            // Its waiters' lead hears it now, not at the next pass.
            crate::advance::release(registry, &home);
            vec![closed]
        }
        _ => return Err("unknown task operation".into()),
    };
    for task in &changed {
        crate::events::tasks(&task.place);
    }
    Ok(crate::api::Reply::Tasks {
        tasks: views(registry, &home, changed)?,
        place: None,
    })
}

fn cap(word: &str) -> String {
    let mut c = word.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// The project checkout's branch a lead may merge reviewed task work into with no card: a named branch that is not the
/// default one (origin's, or `main`/`master`). None for the default branch, a detached HEAD or an unreadable checkout.
pub(super) fn working_branch(project: &Path) -> Option<String> {
    let read = |args: &[&str]| {
        crate::process::git_read(project, args, std::time::Duration::from_secs(10))
            .ok()
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
    };
    let branch = read(&["symbolic-ref", "--quiet", "--short", "HEAD"]).filter(|b| !b.is_empty())?;
    let default = crate::auto_pull::origin_default(project).ok();
    (!["main", "master"].contains(&branch.as_str()) && default.as_deref() != Some(branch.as_str()))
        .then_some(branch)
}

/// What the lead is told when its reviewed task work needs no card.
pub(super) fn merged_line(task: &str, title: &str, revision: &str, branch: &str) -> String {
    format!(
        "No card needed: this project merges reviewed task work into your working branch. Merge task {task} ({title}) \
         now into {branch}, exactly the reviewed commit (`git merge {revision}`), with the message \"Merge task {task}: \
         {title}\". Never into the default branch: it changes only through a pull request."
    )
}
