//! Q9 en-b-J7-2: a Codex model switch's hook check (`codex_hooks_exclusive`: stats in every ancestor folder) is read
//! off the registry lock, as a plain Codex start's is in `Launch::prepare`: a hung mount must not hold the lock.
use super::*;

/// The folders the check read: the start folder (the row's cwd, else its project), the project, the account folder.
pub(super) type Key = (PathBuf, PathBuf, Option<PathBuf>);

/// The owner's `SwitchModel` (socket and HTTP): a Codex row's check first, then `handle` under the lock, which uses the
/// answer only when the restart starts in exactly those folders (otherwise `spawn` reads it again, as before).
/// Ticket 1150 round 2: the restart's Codex is asked here too, off the lock, whether it runs the outward hook, as the
/// command the restart will start (`restart_resumed`'s account, approved command and folder, read the same way). A no
/// or no answer refuses the switch before the running agent is touched; `spawn` starts only the Codex that said yes.
pub(crate) fn switch_model(registry: &std::sync::Mutex<Sessions>, request: Request) -> Response {
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let row = match &request {
        Request::SwitchModel { id, .. } => {
            let sessions = lock()?;
            (sessions.entries.get(id))
                .filter(|e| e.meta.kind == AgentKind::Codex)
                .map(|e| {
                    (
                        e.meta.cwd.clone(),
                        e.meta.project.clone(),
                        e.meta.config_dir.clone(),
                        sessions.settings.clone(),
                        sessions.home.clone(),
                    )
                })
        }
        _ => None,
    };
    let mut read = None;
    if let Some((cwd, project, config, settings, home)) = row {
        // The switch's resume rule: the folder it ran in, else the project's.
        let cwd = if cwd.is_dir() { cwd } else { project.clone() };
        let clear = codex_hooks_exclusive(&cwd, &project, config.as_deref());
        // What cannot be read here (an account or a command gone) is `restart_resumed`'s to refuse, in its own words.
        let agent = crate::accounts::Agent::Codex;
        let account = (config.as_deref())
            .map(|folder| crate::accounts::folder_again(&home, agent, folder))
            .transpose();
        let command = crate::approval::check_command(&home, AgentKind::Codex);
        if let (Ok(account), Ok(command)) = (account, command) {
            let program = agent_program("codex", command.as_ref());
            let account = account.map(|(folder, _)| (crate::accounts::variable(agent), folder));
            let (kind, env) = (AgentKind::Codex, BTreeMap::new());
            let cmd = seat_command(
                &settings,
                &home,
                &program,
                kind,
                false,
                false,
                account.as_ref(),
                &env,
                &cwd,
            );
            let ask = codex_ask(&cmd, &program, &cwd)?;
            ask.runs_hook()?;
            read = Some(((cwd, project, config), clear, ask));
        }
    }
    let mut sessions = lock()?;
    sessions.switch_hooks = read;
    let reply = sessions.handle(request);
    sessions.switch_hooks = None;
    reply
}
