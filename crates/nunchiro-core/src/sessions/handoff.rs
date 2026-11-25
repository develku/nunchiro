//! Where a handoff between agents goes and how it finishes (`handoff_send` is in handoff_acp.rs).
use super::*;
impl Sessions {
    /// v2-3a: what the handoff header and paths need from a session.
    pub(crate) fn handoff_meta(&mut self, id: &str) -> Result<(AgentKind, PathBuf), String> {
        let meta = &self.entry(id)?.meta;
        Ok((meta.kind, meta.cwd.clone()))
    }
    /// v2-3b: where a handoff from `from` to `to` goes: the conversation's newest session of `to` when it runs (reused,
    /// same id) or can resume (resumed, not duplicated), else a new one in `from`'s folder with the model, effort and
    /// account `to` last ran with. Changes nothing; `handoff_finish` records the conversation once the target exists.
    pub(super) fn handoff_target(
        &mut self,
        from: &str,
        to: AgentKind,
        acp_agent: Option<&str>,
    ) -> Result<(String, Result<String, Box<Launch>>), String> {
        let meta = self.entry(from)?.meta.clone();
        // Ticket 1002 lane 1 (Fable review R4): the target would be an unlocked Codex or ACP agent fed the locked seat's
        // transcript.
        if meta.home_lock {
            return Err("the chief of staff's seat is not handed off in v1".into());
        }
        // V2-4b: a hand-off to an ACP agent names its `agents.toml` entry (the start checks it is approved); no other
        // target takes a name. Handing from one ACP agent to another is a switch.
        match (to, acp_agent) {
            (AgentKind::Acp, Some(name)) if !name.is_empty() => {}
            (AgentKind::Acp, _) => return Err("hand off to an ACP agent by name".into()),
            (_, Some(_)) => return Err("only a hand-off to an ACP agent names an agent".into()),
            _ => {}
        }
        let same =
            to == meta.kind && (to != AgentKind::Acp || acp_agent == meta.acp_agent.as_deref());
        if same || to == AgentKind::Shell || meta.kind == AgentKind::Shell {
            return Err("hand off to another agent: Claude, Codex or an ACP agent".into());
        }
        // An ACP session takes its agent's name only: no model, effort or account.
        let (args, acp) = match acp_agent {
            Some(name) => (vec![name.to_string()], true),
            None => (vec![], false),
        };
        let conversation = match meta.conversation.clone() {
            Some(c) => c,
            None => store::new_id()?,
        };
        let newest = |e: &&Entry| {
            let a = self.queue.attention(&e.meta.id);
            (a.last_activity, a.completion_seq)
        };
        let earlier = self
            .entries
            .values()
            .filter(|e| {
                e.meta.kind == to
                    && e.meta.conversation.as_ref() == Some(&conversation)
                    && (!acp || e.meta.acp_agent.as_deref() == acp_agent)
            })
            .max_by_key(newest);
        if let Some(e) = earlier {
            if e.meta.state == SessionState::Running && (e.pty.is_some() || e.acp.is_some()) {
                return Ok((conversation, Ok(e.meta.id.clone())));
            }
            // A Claude conversation exists on disk only after its first finished turn (`--resume` fails before).
            if let Some(resume) = e.meta.agent_session_id.clone().filter(|_| {
                to != AgentKind::Claude || self.queue.attention(&e.meta.id).completion_seq > 0
            }) {
                let start = StartSession {
                    kind: to,
                    project: e.meta.project.clone(),
                    worktree: false,
                    label: e.meta.label.clone(),
                    args: args.clone(),
                    model: e.meta.model.clone().filter(|_| !acp),
                    effort: e.meta.effort.clone().filter(|_| !acp),
                    resume: Some(resume),
                    account: None, // a resume keeps the account it ran on
                };
                return Ok((
                    conversation,
                    Err(Box::new(self.launch(start).owner_start())),
                ));
            }
        }
        let last = self
            .entries
            .values()
            .filter(|e| e.meta.kind == to)
            .max_by_key(newest)
            .map(|e| e.meta.clone());
        let start = StartSession {
            kind: to,
            project: meta.project.clone(),
            worktree: false,
            label: meta.label.clone(),
            args,
            model: last.as_ref().and_then(|m| m.model.clone()).filter(|_| !acp),
            effort: last
                .as_ref()
                .and_then(|m| m.effort.clone())
                .filter(|_| !acp),
            resume: None,
            account: last.and_then(|m| m.account).filter(|_| !acp),
        };
        let mut launch = self.launch(start).owner_start();
        // The same folder or worktree as the session handed off from.
        launch.resume_cwd = Some(meta.cwd.clone()).filter(|c| c.is_dir());
        Ok((conversation, Err(Box::new(launch))))
    }
    /// v2-3b: both sessions join the conversation, then `text` goes to `target` as one user message through the
    /// delivery path (queued until the agent is at its prompt).
    pub(super) fn handoff_finish(
        &mut self,
        from: &str,
        target: &str,
        conversation: &str,
        text: String,
    ) -> Response {
        for id in [from, target] {
            if let Some(entry) = self.entries.get_mut(id) {
                entry.meta.conversation = Some(conversation.into());
            }
        }
        self.save()?;
        let Reply::Delivery { send } = self.send("user", target, text, vec![], true)? else {
            return Err("handoff not sent".into());
        };
        let meta = self.entry(target)?.meta.clone();
        Ok(Reply::Switched {
            session: self.snapshot_session(&meta),
            send,
        })
    }
}
