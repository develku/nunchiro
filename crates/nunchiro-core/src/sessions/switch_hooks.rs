//! Q9 en-b-J7-2: a Codex model switch's hook check (`codex_hooks_exclusive`: stats in every ancestor folder) is read
//! off the registry lock, as a plain Codex start's is in `Launch::prepare`: a hung mount must not hold the lock.
use super::*;

/// The folders the check read: the start folder (the row's cwd, else its project), the project, the account folder.
pub(super) type Key = (PathBuf, PathBuf, Option<PathBuf>);

/// The owner's `SwitchModel` (socket and HTTP): a Codex row's check first, then `handle` under the lock, which uses the
/// answer only when the restart starts in exactly those folders (otherwise `spawn` reads it again, as before).
pub(crate) fn switch_model(registry: &std::sync::Mutex<Sessions>, request: Request) -> Response {
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let read = match &request {
        Request::SwitchModel { id, .. } => lock()?
            .entries
            .get(id)
            .filter(|e| e.meta.kind == AgentKind::Codex)
            .map(|e| {
                (
                    e.meta.cwd.clone(),
                    e.meta.project.clone(),
                    e.meta.config_dir.clone(),
                )
            }),
        _ => None,
    }
    .map(|(cwd, project, config)| {
        // The switch's resume rule: the folder it ran in, else the project's.
        let cwd = if cwd.is_dir() { cwd } else { project.clone() };
        let clear = codex_hooks_exclusive(&cwd, &project, config.as_deref());
        ((cwd, project, config), clear)
    });
    let mut sessions = lock()?;
    sessions.switch_hooks = read;
    let reply = sessions.handle(request);
    sessions.switch_hooks = None;
    reply
}
