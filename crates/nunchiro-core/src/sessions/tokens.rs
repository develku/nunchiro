//! Ticket 573 slice 3: what an outside token (`crate::tokens`) may ask. It runs the session-caller path, so every
//! `check_agent` rule holds (a caller closes only the sessions it started, no Skip permissions, the window's features
//! stay the window's); this adds the scope and the project. Peer: T3 Code's MCP grant is read-only or a ceiling, not a
//! scope list, and a read-only grant passes only the tools declared as reads (`McpToolAccess`).
use super::*;
use crate::tokens::{CALLER, Scope};

fn reads(request: &Request) -> bool {
    match request {
        Request::Worktree { operation, .. } => operation == "list",
        request => matches!(
            request,
            Request::List
                | Request::Snapshot
                | Request::Events { .. } // round 3: a project token's are filtered in `server`
                | Request::AgentList { .. }
                | Request::AgentGet { .. }
                | Request::AgentRead { .. }
                | Request::Read { .. }
                | Request::RoomCheck { .. }
                | Request::RoomThread { .. }
                | Request::RoomAnswer { .. }
        ),
    }
}
fn supervises(request: &Request) -> bool {
    matches!(
        request,
        Request::Start { .. }
            | Request::AgentPrompt { .. }
            | Request::AgentSend { .. }
            | Request::SendText { .. }
            | Request::CancelSend { .. }
            | Request::RoomSend { .. }
            | Request::RoomReply { .. }
            | Request::Close { .. }
    )
}
/// No scope answers a permission or a dialog, types keys (Esc, a digit, Enter can pick a dialog option), or changes a
/// setting; the rest a session caller may not do either is refused by `check_agent`.
fn never(request: &Request) -> bool {
    matches!(
        request,
        Request::Answer { .. }
            | Request::SendKeys { .. }
            | Request::AgentKeys { .. }
            | Request::SteerNow { .. }
            | Request::PermissionAnswers { .. }
            | Request::ApprovalGrant { .. }
            | Request::BoardSourceGrant { .. }
            | Request::SetupGrant { .. } // ticket 259
            | Request::Typing { .. } // the owner's own typing and choices on a waiting message
            | Request::SendNow { .. }
            | Request::SendLater { .. }
            | Request::SendAttach { .. }
            | Request::SendDetach { .. }
            | Request::Direct { .. }
            | Request::DraftTaken { .. }
            | Request::DraftPutBack { .. }
            | Request::TakeBack { .. }
            | Request::CodexResetUse { .. }
            | Request::BoardSelf
            | Request::Browser { .. }
            | Request::BrowserNext
            | Request::BrowserDone { .. }
            | Request::RoomRead { .. } // round 3: the whole room is the person's view
            | Request::RoomPin { .. } // ticket 593: as RoomRead
            | Request::Stop // round 4 (security NOTE 5): the core and every agent are the owner's to stop
            | Request::Exit
            | Request::Layout { .. } // the whole window's layout, not one session's
            | Request::Task { .. } // ticket 990 slice g: the ledger is the owner's and its leads'
            | Request::Note { .. } // ticket 990 slice h: the user's notes
            | Request::Role { .. } // ticket 990 slice i: the user's roles
            | Request::ScheduleList // ticket 993: a lead's seat reads and proposes these, never a token
            | Request::SchedulePropose { .. }
            | Request::ScheduleChange { .. }
            | Request::BotOffer { .. } // a bot's seat offers a bot, never a token
            | Request::OutboxStage { .. } // ticket 1002: a token never stages or spends an outward action
            | Request::OutboxSpend { .. }
    )
}
pub(crate) fn is_token(caller: &crate::grants::Caller) -> bool {
    caller.id.starts_with(CALLER)
}

impl Sessions {
    /// Ok for a session caller. For a token caller: the token is still live, its scope allows `request`, and a token
    /// made for one project reaches only that project's sessions, worktrees and room.
    pub(crate) fn check_token(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        let Some(token_id) = self.token_of(caller) else {
            return Ok(());
        };
        let token = crate::tokens::by_caller(&self.home, &token_id).ok_or("unauthorized")?;
        let allowed = match token.scope {
            Scope::Read => reads(request),
            Scope::Supervised => reads(request) || supervises(request),
            Scope::Full => !never(request),
        };
        if !allowed {
            return Err(format!(
                "operation not granted to a {} token",
                serde_json::to_value(token.scope)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default()
            ));
        }
        self.check_token_reach(caller, request)?;
        let Some(project) = &token.project else {
            return Ok(());
        };
        let canonical = |p: &Path| fs::canonicalize(p).ok();
        let inside = match request {
            // filtered by `token_reaches`, and `server`'s events filter
            Request::List
            | Request::Snapshot
            | Request::AgentList { .. }
            | Request::Events { .. } => true,
            Request::Start { session, .. } => canonical(&session.project).as_ref() == Some(project),
            Request::Worktree { project: p, .. } => {
                p.as_deref().and_then(canonical).as_ref() == Some(project)
            }
            Request::RoomSend { project: p, .. }
            | Request::RoomReply { project: p, .. }
            | Request::RoomCheck { project: p }
            | Request::RoomThread { project: p, .. }
            | Request::RoomAnswer { project: p, .. } => {
                // Round 5: a token session's room is its own session's (`room`), whatever it names.
                let room = match is_token(caller) {
                    true => p.clone(),
                    false => self.room_project(&caller.id),
                };
                room.as_deref().and_then(canonical).as_ref() == Some(project)
            }
            request => crate::grants::request_target(request)
                .and_then(|id| self.entries.get(id))
                .is_some_and(|e| self.token_reaches(caller, &e.meta)),
        };
        if inside {
            Ok(())
        } else {
            Err("outside the token's project".into())
        }
    }
    /// Round 2 (both reviews, MUST 1): a token never runs a command line as the user, or it could read core.token and
    /// act as the owner. So, for every scope: no shell start, no launch arguments (no print mode, no settings file, no
    /// permission flag; `check_agent`'s Skip and Codex bypass checks and `check_start_env` still run), no typing into a
    /// shell session, and no text an agent runs itself (`!` runs a shell command in Claude and Codex, `/` is a slash
    /// command that can change permissions). An agent a token started asks the person before it runs a command, and no
    /// token answers that. A token types only into the sessions it started (security SHOULD 3; every scope since round 3).
    fn check_token_reach(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        match request {
            // Round 3: only Claude takes settings that keep it out of the Nunchiro folder (`keep_out`); Codex has no
            // read deny for one folder, and a shell is a command line.
            Request::Start { session, .. } if session.kind != AgentKind::Claude => Err(
                "operation not granted: a token starts only Claude sessions (Codex and shells cannot be kept out of the Nunchiro folder)"
                    .into(),
            ),
            // Round 3: `worktree open` starts a shell in the worktree.
            Request::Worktree { operation, .. } if operation == "open" => {
                Err("operation not granted: a token starts no shell (worktree open)".into())
            }
            Request::Start { session, .. } if !session.args.is_empty() => {
                Err("operation not granted: a token starts agents without launch arguments".into())
            }
            // Round 4 (security SHOULD 4): a folder inside the Nunchiro folder is all denied to the agent, and one
            // that holds it would hold the session's own settings file.
            Request::Start {
                session, folder, ..
            } => {
                self.check_outside_home(&session.project)?;
                if let Some(folder) = folder {
                    self.check_outside_home(folder)?;
                }
                if session.worktree {
                    let project = fs::canonicalize(&session.project).map_err(|e| e.to_string())?;
                    self.check_outside_home(
                        &self.settings.worktree_root_for(&project)?,
                    )
                    .map_err(|_| {
                        "operation not granted: a token's worktree goes under the worktree folder, which is inside the Nunchiro folder; set a worktree folder outside it".to_string()
                    })?;
                }
                Ok(())
            }
            // Round 5 (security r4 NOTE 3): a token's worktree is never made inside the Nunchiro folder.
            Request::Worktree {
                operation,
                path: Some(path),
                ..
            } if operation == "create" => self.check_outside_home(path),
            // Round 4 (security NOTE 5): a token changes only the worktrees it created.
            Request::Worktree {
                operation,
                project,
                path,
                ..
            } if !["list", "branches", "create"].contains(&operation.as_str()) => {
                let created = path.as_ref().is_some_and(|path| {
                    self.worktree_plan(
                        Some(caller),
                        Request::Worktree {
                            operation: "list".into(),
                            project: project.clone(),
                            path: None,
                            branch: None,
                            base: String::new(),
                            label: String::new(),
                            from: None,
                            confirm: None,
                        },
                    )
                    .and_then(WorktreePlan::execute)
                    .is_ok_and(|(worktrees, _)| {
                        worktrees.iter().any(|w| {
                            plain(&w.path) == plain(path)
                                && w.creator.as_deref().is_some_and(|c| self.of_token(c, caller))
                        })
                    })
                });
                if created {
                    Ok(())
                } else {
                    Err("operation not granted: a token changes only the worktrees it created".into())
                }
            }
            Request::AgentSend { id, text }
            | Request::AgentPrompt { id, text }
            | Request::SendText { id, text, .. } => {
                let entry = self.entries.get(id).ok_or("session not found")?;
                let target = &entry.meta;
                // Ticket 286: an agent that quit leaves a shell on its screen, so an ended agent counts as a shell.
                if target.kind == AgentKind::Shell || !self.agent_running(entry) {
                    return Err("operation not granted: a token never types into a shell".into());
                }
                if text.trim_start().starts_with(['!', '/']) {
                    return Err(
                        "operation not granted: a token's text never starts with ! or / (an agent command)".into(),
                    );
                }
                self.check_started(caller, target)
            }
            // Round 4 (security NOTE 5): cancel, close, label and resize act only on the token's own sessions.
            request => match crate::grants::request_target(request) {
                Some(id) if !reads(request) => {
                    let target = &self.entries.get(id).ok_or("session not found")?.meta;
                    self.check_started(caller, target)
                }
                _ => Ok(()),
            },
        }
    }
    fn check_started(
        &self,
        caller: &crate::grants::Caller,
        target: &Session,
    ) -> Result<(), String> {
        // Round 3: for every scope. The owner's agents run without `keep_out`, so a prompt into one could put core.token
        // on a screen. Round 4: a resumed run, a side chat or a child counts by its origin (`token_origin`).
        if self.token_origin(target).is_none() || self.token_origin(target) != self.token_of(caller)
        {
            return Err("a token types only into the sessions it started".into());
        }
        Ok(())
    }
    /// Round 4 (security MUST 1, MUST 2): the token whose session `meta` is, through its parent chain: a resumed run
    /// keeps its first run's parent, a side chat's parent is its main session, and a start made with a token session's
    /// own credential starts is one link below it. A token session stays one for its whole life, whoever resumes it.
    pub(crate) fn token_origin(&self, meta: &Session) -> Option<String> {
        // Round 6 (security r5 MUST 1): the stored origin decides. The walk through live records is a second guard
        // that can add an origin (a record from before round 6), never remove one.
        meta.token_origin
            .clone()
            .or_else(|| self.origin_within(meta, 16))
    }
    /// Round 5 (review r4 NOTE 2): both links, the side chat's main session first, then the parent. A cycle or a chain
    /// deeper than `depth` ends in `None`; no token makes one (each of its starts is one link below a token session).
    fn origin_within(&self, meta: &Session, depth: usize) -> Option<String> {
        let depth = depth.checked_sub(1)?;
        [meta.side_parent.as_ref(), meta.parent.as_ref()]
            .into_iter()
            .flatten()
            .find_map(|up| match up.starts_with(CALLER) {
                true => Some(up.clone()),
                false => self
                    .entries
                    .get(up)
                    .and_then(|e| self.origin_within(&e.meta, depth)),
            })
    }
    /// Round 5 (review r4 MUST 1): the token a caller acts for. An outside token is its own `token-<id>`; a token
    /// session's own credential stays that session's caller (its own room seat, its own children), and carries the
    /// token's limits through its origin.
    pub(crate) fn token_of(&self, caller: &crate::grants::Caller) -> Option<String> {
        match is_token(caller) {
            true => Some(caller.id.clone()),
            false => self
                .entries
                .get(&caller.id)
                .and_then(|e| self.token_origin(&e.meta)),
        }
    }
    /// Whether `id` (a token caller or a session) acts for the same token as `caller`.
    fn of_token(&self, id: &str, caller: &crate::grants::Caller) -> bool {
        let token = self.token_of(caller);
        token.is_some()
            && match id.starts_with(CALLER) {
                true => token.as_deref() == Some(id),
                false => {
                    self.entries
                        .get(id)
                        .and_then(|e| self.token_origin(&e.meta))
                        == token
                }
            }
    }
    fn check_outside_home(&self, folder: &Path) -> Result<(), String> {
        outside_home(&self.home, folder)
    }
    /// Whether a token caller sees `target` in a list: every session, or its project's only.
    pub(crate) fn token_reaches(&self, caller: &crate::grants::Caller, target: &Session) -> bool {
        let Some(token) = self.token_of(caller) else {
            return true;
        };
        match crate::tokens::by_caller(&self.home, &token).and_then(|t| t.project) {
            None => true,
            Some(project) => fs::canonicalize(&target.project).is_ok_and(|p| p == project),
        }
    }
    /// The caller behind a token's secret: `token-<id>`, with the token's project (empty for every project).
    pub(super) fn token_caller(&self, secret: &str) -> Option<crate::grants::Caller> {
        crate::tokens::verify(&self.home, secret).map(|t| crate::grants::Caller {
            id: t.caller_id(),
            project: t.project.unwrap_or_default(),
        })
    }
    /// The live token caller behind a queued send's sender stamp; `None` once the token is revoked or expired.
    pub(super) fn token_sender(&self, sender: &str) -> Option<crate::grants::Caller> {
        crate::tokens::by_caller(&self.home, sender).map(|t| crate::grants::Caller {
            id: t.caller_id(),
            project: t.project.unwrap_or_default(),
        })
    }
}

/// Round 3 (the round 2 residual): a Claude session a token starts may never read the Nunchiro folder (core.token is
/// the owner's key, tokens.json the token list), even when the user's own settings allow reads or Bash without asking.
/// Deny rules win over every allow and hold in every permission mode, `bypassPermissions` too. A Read deny covers
/// Grep, Glob, `@file` and the file commands Claude knows in Bash; the sandbox (Read denies are merged into its
/// `denyRead`) covers any other Bash command, and refuses to run unsandboxed or to start without a sandbox. Bash
/// still asks the person (`autoAllowBashIfSandboxed: false`).
pub(super) fn keep_out(
    home: &Path,
    settings: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let deny = deny_rules(home)?;
    let permissions = settings
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}));
    let list = permissions
        .as_object_mut()
        .ok_or("permissions")?
        .entry("deny")
        .or_insert_with(|| serde_json::json!([]));
    list.as_array_mut()
        .ok_or("permissions.deny")?
        .extend(deny.into_iter().map(serde_json::Value::from));
    settings.insert(
        "sandbox".into(),
        serde_json::json!({
            "enabled": true,
            "failIfUnavailable": true,
            "allowUnsandboxedCommands": false,
            "autoAllowBashIfSandboxed": false,
        }),
    );
    Ok(())
}
/// macOS reaches every folder of the data volume also as `/System/Volumes/Data<path>`, and `realpath` does not fold it.
const DATA_VOLUME: &str = "/System/Volumes/Data";
/// A token's folder is neither inside the Nunchiro folder `home` nor one that holds it.
pub(super) fn outside_home(home: &Path, folder: &Path) -> Result<(), String> {
    let (folder, home) = (plain(folder), plain(home));
    if folder.starts_with(&home) || home.starts_with(&folder) {
        return Err(
            "operation not granted: a token's session works outside the Nunchiro folder, and not in a folder that holds it"
                .into(),
        );
    }
    Ok(())
}
/// `path` canonical when it exists, without the data volume prefix, so two spellings of one folder compare equal.
fn plain(path: &Path) -> PathBuf {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    match path.strip_prefix(DATA_VOLUME) {
        Ok(rest) if cfg!(target_os = "macos") => Path::new("/").join(rest),
        _ => path,
    }
}
/// `Read` and `Edit` denies for every spelling of the data folder: as configured, canonical, and (macOS) each of those
/// under the data volume.
fn deny_rules(home: &Path) -> Result<Vec<String>, String> {
    let mut dirs = vec![home.to_path_buf()];
    dirs.extend(fs::canonicalize(home).ok());
    if cfg!(target_os = "macos") {
        let data: Vec<_> = dirs
            .iter()
            .filter(|d| !d.starts_with(DATA_VOLUME))
            .map(|d| Path::new(DATA_VOLUME).join(d.strip_prefix("/").unwrap_or(d)))
            .collect();
        dirs.extend(data);
    }
    let mut rules = vec![];
    for dir in dirs {
        let dir = dir
            .to_str()
            .ok_or("the Nunchiro folder path is not UTF-8")?;
        // A glob character in the path would make the rule match another folder.
        if dir
            .chars()
            .any(|c| "*?[]{}()\\!".contains(c) || c.is_control())
        {
            return Err(
                "operation not granted: the Nunchiro folder path has a glob character".into(),
            );
        }
        for tool in ["Read", "Edit"] {
            let rule = format!("{tool}(/{dir}/**)"); // `//abs` is an absolute path
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
    }
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_rules_name_every_spelling_of_the_data_folder() {
        let home = std::env::temp_dir().join(format!("nt-deny-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let canonical = fs::canonicalize(&home).unwrap();
        let rules = deny_rules(&home).unwrap();
        let mut want = vec![home.clone(), canonical.clone()];
        if cfg!(target_os = "macos") {
            want.push(Path::new(DATA_VOLUME).join(home.strip_prefix("/").unwrap()));
            want.push(Path::new(DATA_VOLUME).join(canonical.strip_prefix("/").unwrap()));
        }
        for dir in &want {
            for tool in ["Read", "Edit"] {
                let rule = format!("{tool}(/{}/**)", dir.display());
                assert!(rules.contains(&rule), "{rule} missing: {rules:?}");
            }
        }
        let mut unique = rules.clone();
        unique.dedup();
        assert_eq!(unique.len(), rules.len(), "{rules:?}");
        if cfg!(target_os = "macos") {
            // One folder, two spellings, compare equal.
            let data = Path::new(DATA_VOLUME).join(canonical.strip_prefix("/").unwrap());
            assert_eq!(plain(&data), canonical);
        }
        assert!(deny_rules(Path::new("/tmp/a*b")).is_err());
        let _ = fs::remove_dir_all(&home);
    }
}
