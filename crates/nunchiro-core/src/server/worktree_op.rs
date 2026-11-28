//! The worktree ops for the owner socket and the window: planned under the registry lock, run off it.
use super::*;
/// The worktree ops for the owner socket (`token` is a session's, or `None` for the owner) and the window (V2-8a),
/// prepared under the registry lock and run off it.
pub(crate) fn worktree(
    registry: &Mutex<Sessions>,
    token: Option<&str>,
    request: Request,
    stopping: Option<&AtomicBool>,
) -> Response {
    let stopped = || stopping.is_some_and(|s| s.load(Ordering::SeqCst));
    let sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    if stopped() {
        return Err("core is stopping".into());
    }
    let caller = token.map(|t| sessions.agent_caller(t)).transpose()?;
    let mut sessions = sessions;
    let mut plan = sessions.worktree_plan(caller.as_ref(), request)?;
    // V2.5-61 B8: a read of refs only, with no store, lock or reservation.
    if let Some(project) = plan.branches_project() {
        drop(sessions);
        let (branches, branches_dropped, branches_truncated) =
            crate::worktree_clean::branches(project)?;
        return Ok(Reply::Worktrees {
            worktrees: vec![],
            loss: None,
            cleaned: vec![],
            branches,
            branches_dropped,
            branches_truncated,
            default_base: crate::worktree_clean::default_name(project),
        });
    }
    // Ticket 259: the owner's cleanup script runs (visible, waited for) before a remove that goes ahead: at once when
    // nothing would be lost, else on the resend whose confirm names exactly what is there now (`before_remove`).
    let operation = plan.operation().to_string();
    // Codex look 11-15: a caller acting for an outside token (the token itself, or a session it started, by origin)
    // never starts the owner's scripts, which run as an unrestricted owner shell; its create skips setup and its
    // remove skips cleanup, as the auto-clean pass does.
    let outside = caller
        .as_ref()
        .is_some_and(|c| sessions.token_of(c).is_some());
    // A remove the reservation below refuses (a session runs in the folder) never runs the cleanup.
    if let Some(path) = plan
        .path()
        .filter(|p| operation == "remove" && !outside && !sessions.live_in(p))
    {
        let path = path.to_path_buf();
        drop(sessions);
        crate::worktree_setup::before_remove(
            registry,
            &path,
            plan.confirm(),
            stopping,
            caller.is_none(),
        )?;
        sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
    }
    // Ticket 990: the record as it is before the run (a remove deletes it), for the room's line about a lead's team.
    let before = plan
        .path()
        .filter(|_| ["remove", "forget", "team"].contains(&operation.as_str()))
        .and_then(|p| sessions.recorded_worktree(p));
    let handed = (operation == "team").then(|| plan.label().to_string());
    let reservation = sessions.reserve_worktree(&plan)?;
    // Ticket 991 (Q7 point 1): the titles sessions took since the last request name their worktrees' generated
    // branches in this run, under its lock and off the registry's.
    plan.name_branches(sessions.take_branch_titles());
    drop(sessions);
    // Nothing left that the project does not have: read before the folder goes.
    let merged = before
        .as_ref()
        .filter(|w| operation == "remove" && w.team.is_some() && !w.missing)
        .and_then(|w| crate::worktree_clean::loss(&w.path, &w.project).ok())
        .map(|l| l.uncommitted_total == 0 && l.unpushed_total == 0);
    let result = plan.run();
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    // Ticket 991 A2: a remove that went ahead (no loss to confirm) takes the folder's ended sessions with it.
    // Only a remove reserves a folder (`reserve_worktree`), so this is a remove.
    if let (Some(path), Ok((_, _, None))) = (reservation.as_deref(), &result) {
        sessions.close_ended_in(path, caller.as_ref());
        // A setup ask of a removed worktree could never be approved (its script is gone with the folder).
        if let Err(e) = sessions.queue.answer_owner(|i| {
            matches!(&i.owner, Some(crate::queue::OwnerAsk::Setup { path: p, .. }) if p == path)
        }) {
            eprintln!("queue: setup ask of {} not dropped: {e}", path.display());
        }
    }
    sessions.release_worktree(reservation);
    drop(sessions);
    let (worktrees, open, loss) = result?;
    // Ticket 990: one line in the room when a lead's team gains or loses a worktree (a remove that only asked for a
    // confirm, `loss`, changed nothing).
    if loss.is_none() {
        let name = |w: &Worktree| {
            if w.label.is_empty() {
                w.branch.clone()
            } else {
                w.label.clone()
            }
        };
        let note = |what: &str, w: &Worktree, merged: Option<bool>| crate::room::TeamNote {
            what: what.into(),
            worktree: Some(w.path.clone()),
            name: Some(name(w)),
            branch: Some(w.branch.clone()),
            merged,
            seat: None,
        };
        let told = match (operation.as_str(), &before, worktrees.last()) {
            ("create", _, Some(made)) => made.team.clone().map(|lead| {
                let body = format!("Worktree {} ({}) joined the team.", name(made), made.branch);
                (
                    made.project.clone(),
                    lead,
                    body,
                    note("created", made, None),
                )
            }),
            ("remove" | "forget", Some(w), _) => w.team.clone().map(|lead| {
                let how = match merged {
                    Some(true) => "its work is in the project",
                    Some(false) => "its branch is kept",
                    None => "its folder was already gone",
                };
                let body = format!("Worktree {} ({}) was removed: {how}.", name(w), w.branch);
                (w.project.clone(), lead, body, note("removed", w, merged))
            }),
            ("team", Some(w), _) => match handed.as_deref().filter(|l| !l.is_empty()) {
                Some(lead) => Some((
                    w.project.clone(),
                    lead.to_string(),
                    format!(
                        "The user handed worktree {} ({}) to the lead.",
                        name(w),
                        w.branch
                    ),
                    note("handed", w, None),
                )),
                None => w.team.clone().map(|lead| {
                    let body = format!("The user took worktree {} ({}) back.", name(w), w.branch);
                    (w.project.clone(), lead, body, note("taken", w, None))
                }),
            },
            _ => None,
        };
        // Ticket 990 slice g: the ledger follows a lead's worktrees: a new one is its own task (or joins the open task
        // of its name), a removed one leaves its task, a handed one joins, a taken one is no task's.
        {
            let home = registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .home()
                .to_path_buf();
            let ledger = crate::ledger::Ledger::open(&home);
            let now = crate::queue::now_ms();
            let done = match (operation.as_str(), &before, worktrees.last()) {
                ("create", _, Some(made)) => made.team.as_deref().map(|lead| {
                    ledger
                        .worktree_made(&made.project, lead, &made.path, &name(made), now)
                        .map(|_| made.project.clone())
                }),
                ("remove" | "forget", Some(w), _) => Some(
                    ledger
                        .worktree_gone(&w.path, merged, now)
                        .and_then(|closed| {
                            // N24: a task closed with its last worktree retires its merge and board cards.
                            if let Some(id) = closed {
                                registry
                                    .lock()
                                    .map_err(|_| "session registry unavailable")?
                                    .retire_merge_card(&id)?;
                            }
                            Ok(w.project.clone())
                        }),
                ),
                ("team", Some(w), _) => Some(
                    match handed.as_deref().filter(|l| !l.is_empty()) {
                        Some(lead) => ledger
                            .worktree_made(&w.project, lead, &w.path, &name(w), now)
                            .map(|_| ()),
                        None => ledger.worktree_taken(&w.path, now),
                    }
                    .map(|_| w.project.clone()),
                ),
                _ => None,
            };
            match done {
                Some(Ok(project)) => crate::events::tasks(&project),
                Some(Err(e)) => eprintln!("ledger not updated: {e}"),
                None => {}
            }
        }
        if let Some((project, lead, body, note)) = told {
            registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .team_note(
                    &project,
                    &lead,
                    caller.as_ref().map(|c| c.id.as_str()),
                    body,
                    note,
                );
        }
    }
    // Ticket 259: create appends its record last; its setup runs, asks or is skipped, and never fails the create.
    if operation == "create"
        && !outside
        && let Some(made) = worktrees.last()
    {
        crate::worktree_setup::after_create(registry, caller.as_ref().map(|c| c.id.as_str()), made);
    }
    if let Some(worktree) = open {
        let launch = {
            let sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            sessions.launch(StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: worktree.project.clone(),
                worktree: false,
                label: worktree.label.clone(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            })
        };
        let mut launch = launch.prepare_existing(&worktree.path)?;
        if caller.is_none() {
            launch = launch.owner_terminal(); // ticket 1008 round 4: the owner's worktree row or terminal
        }
        let (_sessions, session) = Sessions::past_busy_worktree(registry, |sessions| {
            if stopped() {
                return Err("core is stopping".into());
            }
            if let (Some(caller), Some(token)) = (&caller, token) {
                sessions.agent_caller(token)?;
                sessions.start_granted(caller, &launch, false)
            } else {
                sessions.start(&launch)
            }
        })?; // v1a-22
        launch.committed = true;
        return Ok(Reply::Started { session });
    }
    Ok(Reply::Worktrees {
        worktrees,
        loss,
        cleaned: crate::worktree_clean::recent(),
        branches: vec![],
        branches_dropped: 0,
        branches_truncated: false,
        default_base: None,
    })
}

/// A `--worktree` start's folder is recorded before the start answers, as a create's is: before, only an open window
/// adopted it, later, and a project Remove read in between took its agent for a plain session (stopped, its history
/// deleted). The record only (`record_only`: git is read once, never written, and no worktree's facts are read, so the
/// start's reply does not wait on the project's other worktrees); a refusal leaves the window's adopt to try again.
pub(crate) fn record_started_worktree(
    registry: &Mutex<Sessions>,
    requested: bool,
    started: &crate::api::Session,
) {
    if !requested || started.cwd == started.project {
        return;
    }
    let adopt = Request::Worktree {
        operation: "adopt".into(),
        project: Some(started.project.clone()),
        path: Some(started.cwd.clone()),
        branch: None,
        base: String::new(),
        label: String::new(),
        from: None,
        confirm: None,
    };
    let plan = registry
        .lock()
        .map_err(|_| "session registry unavailable".to_string())
        .and_then(|sessions| sessions.worktree_plan(None, adopt));
    if let Err(e) = plan.and_then(|plan| plan.record_only().run()) {
        eprintln!("session {}: its worktree was not recorded: {e}", started.id);
    }
}

/// A start's reply, its `--worktree` folder recorded first (`record_started_worktree`), with no registry guard held.
pub(crate) fn started_reply(
    registry: &Mutex<Sessions>,
    worktree: bool,
    result: Result<crate::api::Session, String>,
) -> Response {
    if let Ok(started) = &result {
        record_started_worktree(registry, worktree, started);
    }
    result.map(|session| Reply::Started { session })
}
