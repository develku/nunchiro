//! Session callers (a session token, or the owner token from inside a session) run the owner commands, not the human
//! set (v1a-23, needs 47). Remote callers keep the V1A-04 rule: their own project and directly started workers.
use crate::{api::*, queue, sessions::Sessions};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Clone)]
pub(crate) struct Caller {
    pub id: String,
    pub project: PathBuf,
}
#[derive(Default)]
pub(crate) struct Grants {
    pub parents: BTreeMap<String, String>,
    /// v1a-16: child id -> the created worktree it was started in, checked against the store at start.
    pub worktrees: BTreeMap<String, PathBuf>,
    /// v1a-23: callers forwarded from another machine (V1A-06), the only ones still held to the V1A-04 rule.
    pub remote: BTreeSet<String>,
}
impl Grants {
    /// Whether `caller` may reach `target`: any session for a local session caller (v1a-23), the caller's own
    /// workers for a remote one.
    pub fn owns(&self, caller: &Caller, target: &Session) -> bool {
        self.owns_as(self.remote.contains(&caller.id), caller, target)
    }
    /// Ticket 76: `owns` with the remote flag given, for a queued send that carries its own.
    pub fn owns_as(&self, remote: bool, caller: &Caller, target: &Session) -> bool {
        !remote
            || (target.project == caller.project
                || self.worktrees.get(&target.id) == Some(&target.project))
                && self.parents.get(&target.id) == Some(&caller.id)
    }
}

pub(crate) fn check_answer(
    item: &queue::Decision,
    answer: &queue::Answer,
    enabled: bool,
) -> Result<(), String> {
    // V2-8e: "don't ask again" and a deny with an instruction are the owner's and the window's only.
    if matches!(
        answer,
        queue::Answer::AllowAlways
            | queue::Answer::DenyWith { .. }
            | queue::Answer::ChooseWith { .. }
    ) {
        return Err("this answer is for the window only".into());
    }
    if item.kind == queue::Kind::Permission {
        if !enabled && !matches!(answer, queue::Answer::Deny) {
            return Err("permission_answers_disabled".into());
        }
        // V2-8e: an agent never allows a risky request, confirmed or not (`item` is annotated by the caller; a stored
        // item is risky by default, so a caller that forgets fails closed).
        if item.risky && matches!(answer, queue::Answer::AllowOnce) {
            return Err("an agent cannot allow a risky request".into());
        }
        if let queue::Answer::Choose { .. } = answer {
            return Err("permission requires allow_once or deny".into());
        }
    }
    // Codex look of wave 17 (MUST): a plan approval is a question card, but any yes to it lets the agent start work;
    // as it was when it was a risky permission, an agent only declines it (Esc). The owner answers it in the window.
    if queue::is_plan(item) && !matches!(answer, queue::Answer::Deny) {
        return Err("an agent cannot approve a plan; only the owner can".into());
    }
    if item.kind == queue::Kind::Dialog && !matches!(answer, queue::Answer::Deny) {
        return Err("dialog choices are terminal-only; only deny/Esc is allowed".into());
    }
    Ok(())
}

pub(crate) fn request_target(request: &Request) -> Option<&str> {
    match request {
        Request::AgentSend { id, .. }
        | Request::AgentPrompt { id, .. }
        | Request::SteerNow { id, .. }
        | Request::AgentKeys { id, .. }
        | Request::AgentRead { id, .. }
        | Request::AgentGet { id }
        | Request::CancelSend { id, .. }
        | Request::Read { id, .. }
        | Request::SendText { id, .. }
        | Request::SendKeys { id, .. }
        | Request::Close { id }
        | Request::Label { id, .. }
        | Request::Resize { id, .. } => Some(id),
        _ => None,
    }
}

/// v1a-06: a session caller's `--machine` request; every other session-caller request runs the owner path in
/// `server::connection` with its caller checks.
pub(crate) fn dispatch_remote(
    registry: &std::sync::Mutex<Sessions>,
    token: &str,
    machine: String,
    request: Request,
    stopping: &std::sync::atomic::AtomicBool,
) -> Response {
    let home = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .remote_home();
    crate::machines::dispatch(registry, &home, false, token, machine, request, stopping)
}
