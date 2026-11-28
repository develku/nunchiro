//! One window frame's answer on the frame loop: layout, watches, and the requests the loop runs itself.
use super::*;

pub(super) fn answer(
    frame: Frame,
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool, // ticket 39
    watches: &mut BTreeMap<String, (u64, bool, Pace)>,
    home: &Path,
    window: Option<&layout::Window>,
    layout_stamp: &mut layout::Stamp,
) -> serde_json::Value {
    let response: Response = (|| {
        if frame.layout_focus {
            window.ok_or("not allowed from the browser")?.focus();
            return Ok(Reply::Ack);
        }
        if let Some(value) = frame.layout_save {
            // The saving window already shows this layout: no event back to it for its own write.
            return layout::save(home, value).map(|stamp| {
                *layout_stamp = stamp;
                Reply::Ack
            });
        }
        if let Some(seq) = frame.layout_done {
            layout::done(home, seq, frame.error.map_or(Ok(frame.text), Err));
            return Ok(Reply::Ack);
        }
        if let Some(id) = frame.watch {
            if !watches.contains_key(&id) && watches.len() >= MAX_WATCHES {
                return Err("too many watched sessions".into());
            }
            // Only live sessions can be watched; the probe read also rejects a cursor past the end.
            registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .output(&id, frame.after)?;
            // v1a-53: a (re)watch counts from its replay frame, as the window's acks do.
            watches.insert(id, (frame.after, true, Pace::default()));
            return Ok(Reply::Ack);
        }
        if let Some(id) = frame.unwatch {
            watches.remove(&id);
            return Ok(Reply::Ack);
        }
        // The window is the owner, so its "Start anyway" passes a memory hold; a paired page never sends it
        // (`browser::request_allowed`).
        let request = frame.request.ok_or("frame has no request")?;
        let (request, anyway) = crate::pressure::unwrap_anyway(request, true)?;
        match request {
            // The window is a client like the CLI, minus hook intake and core shutdown (ticket 09 owns
            // quit through its own confirmation).
            Request::Hook { .. } | Request::Stop | Request::ExitIfIdle { .. } => {
                Err("not allowed from the window".into())
            }
            // v1b-02
            Request::ChatPage { id, before, after } => {
                read_chat(registry, &id, before, after, None)
            }
            // v2-3a
            Request::HandoffPreview {
                id,
                through,
                last_five,
            } => read_handoff(registry, &id, through.as_deref(), last_five),
            // v2-3b
            Request::HandoffSend {
                from,
                to,
                text,
                acp_agent,
            } => crate::sessions::handoff_send(
                registry,
                Some(stopping),
                &from,
                to,
                acp_agent.as_deref(),
                &text,
            ),
            // V2-4b: the setup requests (the list and the check also run off the frame loop, above).
            request @ (Request::AcpAgents
            | Request::AcpAgentCheck { .. }
            | Request::AcpAgentAdd { .. }
            | Request::AcpAgentLogin { .. }) => {
                crate::acp::setup(home, registry, Some(stopping), request)
            }
            // Ticket 358 (sign-in and sign-out run as jobs, above)
            request @ (Request::AcpAgentSignInState { .. }
            | Request::AcpAgentSignInCancel { .. }) => {
                crate::acp::setup(home, registry, Some(stopping), request)
            }
            // Ticket 358
            Request::AgentCommandCheck {
                agent,
                path,
                args,
                env,
            } => crate::approval::command_check(home, agent, path, args, env)
                .map(|check| Reply::CommandCheck { check }),
            // Ticket 276: the window's extensions requests (the browser role refuses them in `request_allowed`).
            request @ (Request::ExtensionsList
            | Request::ExtensionsMcpAdd { .. }
            | Request::ExtensionsMcpRemove { .. }
            | Request::ExtensionsItemFiles { .. }
            | Request::ExtensionsItemRead { .. }
            | Request::ExtensionsItemSave { .. }
            | Request::ExtensionsSkillNew { .. }
            | Request::ExtensionsItemRemove { .. }) => crate::extensions::owner(home, request),
            // v2-8b
            Request::PrChip { id } => read_pr_chip(registry, &id),
            // V2-CF4
            Request::Subagents { id, open } => read_subagents(registry, &id, open.as_deref()),
            // Q9 en-b-J6-2: an added folder is checked on disk off the registry lock.
            Request::TreeEdit { edit } => {
                let edit = edit.checked()?;
                registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?
                    .handle(Request::TreeEdit { edit })
            }
            // Ticket 1040: the folder stats and a Locate's folder check run off the registry lock too.
            Request::ProjectFolders => crate::sessions::locate::folders(registry),
            Request::ProjectLocate { from, to } => {
                crate::sessions::locate::serve(registry, &from, &to)
            }
            // Q9 en-b-J7-2: a Codex switch's hook check is read off the registry lock.
            request @ Request::SwitchModel { .. } => {
                crate::sessions::switch_model(registry, request)
            }
            // v2-8c
            request @ (Request::PrLive { .. }
            | Request::PrLiveSet { .. }
            | Request::PrWatch { .. }
            | Request::PrFront { .. }) => crate::pr_live::answer(registry, request),
            Request::SessionContext { id, refresh } => {
                crate::session_context::reply(home, registry, &id, refresh)
            }
            Request::ForgetMachine { alias } => crate::sessions::forget_machine(registry, &alias),
            Request::MachineDetails { alias } => crate::machines::discovery::reply(registry, alias),
            Request::MachineAliases => crate::machines::aliases::reply(registry, home),
            Request::MachineProbe { host, user, port } => {
                crate::machines::aliases::probe(&host, user.as_deref(), port)
            }
            Request::MachineShare => crate::machines::share::reply(),
            Request::MachineTrust { alias, link } => {
                crate::machines::share::trust(registry, home, &alias, &link)
            }
            Request::MachineStatus { label, retry } => {
                crate::machines::status(registry, home, label, retry)
            }
            Request::AccountUsage { limits } => crate::usage::reply(home, limits),
            Request::UsageDetail {
                days,
                account,
                sessions,
            } => {
                crate::usage::detail_reply(home, days, crate::usage::Filter::new(account, sessions))
            }
            request @ (Request::CodexResetRead { .. }
            | Request::CodexResetUse { .. }
            | Request::CodexResetLog) => crate::codex_reset::owner(home, request), // needs 225
            // ticket-98: reached by the CLI/owner socket; the window's frame loop runs it as a job (ticket 113).
            Request::UserCommands { kind } => crate::user_commands::reply(kind),
            Request::FirstRun => crate::firstrun::reply(),
            // v2-5b: launch preparation runs off the registry lock.
            Request::ProblemFix { id, fix } => {
                crate::sessions::problem_fix(registry, None, &id, fix)
            }
            // v2-2a: the login start runs off the registry lock (the list runs off the frame loop, above).
            request @ (Request::AccountList
            | Request::AccountCheck { .. }
            | Request::AccountAdd { .. }
            | Request::AccountRename { .. }
            | Request::AccountRemove { .. }) => {
                crate::accounts::handle(home, registry, None, request)
            }
            Request::Start {
                session,
                folder,
                env,
                receipt: _, // ticket 573: the window never retries a start
            } => {
                // Held as the socket's start, at critical only; the window's "Start anyway" passes it.
                let who = crate::pressure::Who::Window;
                if !anyway {
                    crate::plugins::check_start(home, crate::plugins::Asker::Owner, &session)?;
                }
                crate::pressure::check_start(&session, who, anyway, "window start")?;
                window_start(registry, &session, folder, env)
            }
            // The owner's held click waits and starts by itself; the status bar lists it with Start anyway and Cancel.
            Request::StartOrWait { start } => {
                let Request::Start {
                    session,
                    folder,
                    env,
                    ..
                } = *start
                else {
                    return Err("start_or_wait carries a start only".into());
                };
                let who = crate::pressure::Who::Window;
                crate::plugins::check_start(home, crate::plugins::Asker::Owner, &session)?;
                if let Err(held) =
                    crate::pressure::check_start(&session, who, false, "window start")
                {
                    let agent = crate::pressure::kind_name(session.kind).to_string();
                    let project = crate::pressure::place_name(&session.project);
                    // shortcut: no key, so two clicks are two entries, as two clicks are two sessions when memory is free.
                    let key = format!("window:{}", crate::queue::now_ms());
                    let go: crate::pressure::Go = Box::new(move |registry, _, done| match done {
                        crate::pressure::Done::Released | crate::pressure::Done::Anyway => {
                            match window_start(registry, &session, folder, env)? {
                                Reply::Started { session } => Ok(session.id),
                                _ => Err("the core started nothing".into()),
                            }
                        }
                        _ => Err(String::new()),
                    });
                    let from = crate::pressure::from(who);
                    crate::pressure::hold(
                        key,
                        agent,
                        project,
                        crate::pressure::Asker::Owner,
                        from,
                        go,
                    );
                    return Ok(Reply::MemoryWaiting { text: held });
                }
                window_start(registry, &session, folder, env)
            }
            Request::MemoryWaitGo { id } => crate::pressure::answer(registry, stopping, &id, true),
            Request::MemoryWaitCancel { id } => {
                crate::pressure::answer(registry, stopping, &id, false)
            }
            // The window is the owner: a trigger card's "Turn this trigger off", and the list.
            Request::Trigger { action } => {
                crate::schedule::triggers::handle(registry, stopping, home, action)
            }
            Request::MemoryWaitList => Ok(Reply::MemoryWait {
                entries: crate::pressure::shown()
                    .iter()
                    .filter_map(|e| serde_json::to_value(e).ok())
                    .collect(),
            }),
            // Ticket 396: as the owner socket's answer, it waits for a resize redraw off the registry lock.
            request @ Request::Answer { .. } => {
                let reply = Sessions::past_busy_worktree(registry, |sessions| {
                    if stopping.load(Ordering::SeqCst) {
                        return Err("core is stopping".into());
                    }
                    sessions.handle(request.clone())
                })
                .map(|(_, reply)| reply);
                crate::team::wake_goals(registry); // Home view change 4, as the owner socket's answer
                reply
            }
            // v1b-20: the window holds the owner token; the act locks the registry itself.
            request @ Request::WidgetAct { .. } => {
                crate::widgets::act::handle(home, registry, None, request)
            }
            request => {
                let mut sessions = registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                // v1b-19: the window holds the owner token; runs happen after the lock is released.
                if matches!(
                    request,
                    Request::WidgetList | Request::WidgetRun { .. } | Request::WidgetPage { .. } // v1b-22
                ) {
                    return crate::widgets::handle(home, sessions, request);
                }
                // v1b-08: file and git work runs after the registry lock is released.
                if let Some(root) = sessions.file_root(&request) {
                    let root = root?;
                    drop(sessions);
                    return crate::files::run(root, request);
                }
                // v1b-11: diff `git` work too.
                if let Some(root) = sessions.diff_root(&request) {
                    let (dir, base) = root?;
                    drop(sessions);
                    return crate::diff::run(dir, base, request);
                }
                // v1b-05: the image write runs after the registry lock is released.
                if let Some(home) = sessions.image_home(&request) {
                    let home = home?;
                    drop(sessions);
                    return crate::images::run(&home, request);
                }
                // Ticket 1013 F6: the window's own Close keeps the done tab; the owner socket's is a command's.
                if let Request::Close { id } = &request {
                    return sessions.close(id, true, true);
                }
                // The owner's decision: a folder named in a message the owner typed in this window's composer is the
                // Assistant's for the conversation (the app's window only: not the paired browser, a socket, a
                // schedule, a seat, or text the window makes itself such as a pull request's "Fix with agent").
                if window.is_some() {
                    match &request {
                        Request::FolderOffer { id, text } => {
                            return Ok(Reply::FolderOffered {
                                folders: sessions.grant_named_folders(id, text),
                            });
                        }
                        Request::FolderRemove { id, folder } => {
                            return sessions.remove_folder(id, folder);
                        }
                        _ => {}
                    }
                }
                sessions.handle(request)
            }
        }
    })();
    serde_json::json!({ "id": frame.id, "response": response })
}

/// The window's start past its memory check: as the owner socket's.
fn window_start(
    registry: &Mutex<Sessions>,
    session: &crate::api::StartSession,
    folder: Option<std::path::PathBuf>,
    env: std::collections::BTreeMap<String, String>,
) -> Response {
    let launch = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .launch(session.clone())
        .owner_start() // ticket 362: the window is the owner
        .with_folder(folder.clone())
        .with_env(env)?;
    // v2-5b: a missing agent still opens a tab, with its card.
    let mut launch = match launch.prepare() {
        Ok(launch) => launch,
        Err(e) => {
            return registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .start_failed_at(session, folder.as_deref(), e);
        }
    };
    let result = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .start(&launch);
    // F15: as the owner socket's Start, the refusal is named off the lock.
    let result = result.map_err(|e| {
        crate::sessions::refused_start(crate::sessions::probe_folder, session.kind, &launch.cwd, e)
    });
    if result.is_ok() {
        launch.committed = true;
    }
    // V2-4b: as the owner socket's Start: a failed ACP agent leaves a row with its card.
    if let Err(e) = &result
        && session.kind == crate::api::AgentKind::Acp
    {
        return registry
            .lock()
            .map_err(|_| "session registry unavailable")?
            .start_failed_at(session, folder.as_deref(), e.clone());
    }
    result.map(|session| Reply::Started { session })
}

/// The requests the frame loop hands to a job: a plugin request (the catalogue and an install fetch,
/// `plugins_online.rs`) and the PR view's `gh` runs.
pub(super) fn off_loop(request: &Request) -> bool {
    matches!(
        request,
        Request::Plugin { .. }
            | Request::PrView { .. }
            | Request::PrList
            | Request::PrMerge { .. }
            | Request::PrBranch { .. }
    )
}
pub(super) fn job(
    registry: &Arc<Mutex<Sessions>>,
    home: &Path,
    request: Request,
) -> impl FnOnce() -> Response + Send + 'static {
    let (registry, home) = (registry.clone(), home.to_path_buf());
    move || match request {
        Request::Plugin { .. } => {
            let sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            crate::plugins::handle(&home, sessions, request)
        }
        _ => crate::pr::answer(&registry, request),
    }
}
