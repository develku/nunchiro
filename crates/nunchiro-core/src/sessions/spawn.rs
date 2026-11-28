//! Spawning a session's PTY: the command, env, hooks and shell wrapper it starts with.
use super::*;
impl Sessions {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn spawn(
        &mut self,
        id: &str,
        project: &Path,
        cwd: &Path,
        start: &StartSession,
        version: Option<String>,
        start_commit: Option<crate::diff::Base>,  // v1b-11
        config: Option<&(&'static str, PathBuf)>, // v2-2a
        account: Option<String>,                  // v2-2b
        without_hooks: bool,                      // v2-5b
        no_history: bool,
        account_tab: bool,
        permission: &[String], // ticket 362
        bypass_disabled: bool,
        command: Option<&crate::approval::CommandProof>, // ticket 358
        approved: &[String], // never in `start.args`, which a session stores and replays
        env: &BTreeMap<String, String>, // ticket 573: checked by `Launch::with_env`
        origin: Option<String>, // ticket 573: the caller's token
        codex_read_only: Option<bool>, // Q9 en-b-J7-1: read by `Launch::prepare`, off the lock
        codex_hooks_clear: Option<bool>, // Q9 en-b-J7-2: the same
        home_mode: Option<crate::home_lock::Mode>, // ticket 1002 lane 1: a locked Claude start
        by_owner: bool,      // ticket 1008 round 2: the window or the owner's terminal
        ultracode: Option<bool>, // ticket 1018: as Claude's settings start it
        codex_asked: Option<&crate::outward::CodexAsk>, // ticket 1150: Codex said it runs the outward hook
    ) -> Result<Session, String> {
        let agent;
        let program = match start.kind {
            AgentKind::Claude => {
                agent = agent_program("claude", command);
                agent.as_str()
            }
            AgentKind::Codex => {
                agent = agent_program("codex", command);
                agent.as_str()
            }
            // The user's own shell (fish, bash, ...), as the shell an ended agent leaves (`AGENT_WRAPPER`); it was
            // always zsh until ticket 991.
            AgentKind::Shell => {
                agent = std::env::var("SHELL")
                    .ok()
                    .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
                    .unwrap_or_else(|| "/bin/zsh".into());
                start.args.first().map_or(agent.as_str(), String::as_str)
            }
            AgentKind::Acp => return Err("an ACP agent has no PTY".into()), // V2-4a: `spawn_acp`
        };
        // v1b-02: one version list for launch and chat.
        let tested =
            crate::chat::tested(start.kind, version.as_deref(), crate::chat::TESTED_VERSIONS);
        let agent_session_id = match start.kind {
            AgentKind::Claude => Some(start.resume.clone().unwrap_or(store::new_id()?)),
            AgentKind::Codex => start.resume.clone(),
            AgentKind::Shell | AgentKind::Acp => None,
        };
        if agent_session_id
            .as_deref()
            .is_some_and(|s| !store::valid_id(s))
        {
            return Err("invalid resume session id".into());
        }
        // v1b-07: found before the command is built, which needs the prior run's artifact folder.
        let prior_ids: Vec<String> = self
            .entries
            .values()
            .filter(|entry| {
                start.resume.is_some()
                    && entry.meta.kind == start.kind
                    && entry.meta.project == project
                    && entry.meta.agent_session_id == start.resume
            })
            .map(|entry| entry.meta.id.clone())
            .collect();
        // V2-1a r3: or its agent may still run (a holder that stopped answering or died): never a second one.
        if prior_ids.iter().any(|id| {
            let entry = &self.entries[id];
            entry.meta.state == SessionState::Running
                || entry.pty.as_ref().is_some_and(Pty::agent_running)
        }) {
            return Err("conversation is already running".into());
        }
        // v1b-07: the artifact folder; a resumed conversation keeps the one of the run it continues.
        let artifacts = (start.kind != AgentKind::Shell)
            .then(|| -> Result<(Option<String>, PathBuf), String> {
                let folder_id = prior_ids.first().map(|old| {
                    let meta = &self.entries[old].meta;
                    meta.artifacts.clone().unwrap_or_else(|| meta.id.clone())
                });
                let parent = self.home.join("artifacts");
                store::private_dir(&parent)?;
                let folder = parent.join(folder_id.as_deref().unwrap_or(id));
                store::private_dir(&folder)?;
                Ok((
                    folder_id,
                    fs::canonicalize(&folder).map_err(|e| e.to_string())?,
                ))
            })
            .transpose()?;
        // end v1b-07
        // v2-2b: an agent session's account folder (a login tab is a shell and records none).
        let config_dir = config
            .filter(|_| start.kind != AgentKind::Shell)
            .map(|(_, folder)| folder.clone());
        // w10 item 13: see the Shell arm below.
        let wait_size =
            start.kind == AgentKind::Shell && start.args.is_empty() && self.window_size.is_none();
        let mut cmd = seat_command(
            &self.settings,
            &self.home,
            if wait_size { "/bin/sh" } else { program },
            start.kind,
            home_mode.is_some(),
            by_owner,
            config,
            env,
            cwd,
        );
        // Ticket 1150 round 2: a Codex starts only as the Codex that was asked, off this lock, whether it runs the
        // outward hook (`Launch::ask_codex`, a model switch's `switch_hooks`), and said yes: the same program, folder,
        // environment and hook. Read here, before the session's own identity is added to the command.
        let codex_hook = match start.kind {
            AgentKind::Codex => {
                let ask = codex_ask(&cmd, program, cwd)?;
                if codex_asked != Some(&ask) {
                    return Err("this Codex start changed after Codex was asked whether it runs Nunchiro's outward-action check, or it was never asked; start it again".into());
                }
                Some(ask.command)
            }
            _ => None,
        };
        let token = store::new_id()? + &store::new_id()?;
        crate::logs::register(&token, "session"); // v2-13a
        cmd.env("NUNCHIRO_SESSION", id);
        cmd.env("NUNCHIRO_TOKEN", &token);
        // v1b-07
        if let Some((_, folder)) = &artifacts {
            cmd.env("NUNCHIRO_ARTIFACTS", folder);
        }
        // Ticket 991 (fifth look, S2): zsh marks its prompts, see `ZSH_MARKS`. Only a shell session whose program is
        // zsh; a failed write starts the shell without marks.
        if start.kind == AgentKind::Shell
            && Path::new(program).file_name().is_some_and(|n| n == "zsh")
            && std::env::var_os("NUNCHIRO_SHELL_INTEGRATION").is_none_or(|v| v != "0")
            && let Ok(dir) = zsh_marks_dir(&self.home)
        {
            if let Some(own) = std::env::var_os("ZDOTDIR") {
                cmd.env("NUNCHIRO_USER_ZDOTDIR", own);
            }
            cmd.env("ZDOTDIR", dir);
        }
        match start.kind {
            // V2-4a: an ACP start returned above (`AgentKind::Acp` has no PTY).
            AgentKind::Shell | AgentKind::Acp => {
                // w10 item 13: a plain shell started before any window gave a size (a new home: none stored) would
                // build its prompt for the PTY's first 160 columns, and the window's narrower first open then shows it
                // twice. It waits for the window's size before it starts (the PTY's size changes when a window opens
                // it), for at most `shell_size_wait_tenths` tenths of a second, then starts anyway. Nothing is typed into
                // it: the wait reads only the terminal's size. Ticket 1001: a first size of exactly 160x50 changes
                // nothing, so the wait also ends once the window's first Resize writes `WINDOW_SIZE` ($1). Ticket 1137:
                // and once the core writes into it ($2, see `write_send`): a lead's first prompt runs at once, not 8 s later.
                if wait_size {
                    let sized = self.home.join(WINDOW_SIZE);
                    store::private_dir(&self.home.join("shell"))?;
                    let go = self.home.join("shell").join(format!("{id}.go"));
                    cmd.args([
                        "-c",
                        &format!(
                            "i=0; while [ \"$(stty size 2>/dev/null)\" = \"50 160\" ] && [ ! -e \"$1\" ] && [ ! -e \"$2\" ] && [ $i -lt {} ]; do sleep 0.1; i=$((i+1)); done; rm -f \"$2\"; exec \"$0\"",
                            shell_size_wait_tenths()
                        ),
                        program,
                        &sized.to_string_lossy(),
                        &go.to_string_lossy(),
                    ]);
                    self.size_waits.insert(id.into(), go);
                } else {
                    cmd.args(start.args.iter().skip(1));
                }
            }
            AgentKind::Claude => {
                // v1b-07: Claude's `--add-dir` takes several values (`<directories...>`); ticket 276 round 3: it goes
                // first, so the `--session-id`/`--resume` that always follows ends the list, never the user's prompt.
                if let Some((_, folder)) = &artifacts {
                    cmd.arg("--add-dir");
                    cmd.arg(folder);
                }
                cmd.arg(if start.resume.is_some() {
                    "--resume"
                } else {
                    "--session-id"
                });
                cmd.arg(agent_session_id.as_ref().unwrap());
                if let Some(model) = &start.model {
                    cmd.args(["--model", model]);
                }
                if let Some(effort) = &start.effort {
                    cmd.args(["--effort", effort]);
                }
                cmd.args(permission); // ticket 362
                cmd.args(extension_flags(
                    &self.home,
                    &self.settings,
                    AgentKind::Claude,
                    home_mode.is_some(),
                    project,
                )?); // ticket 276
            }
            AgentKind::Codex => {
                // Ticket 692 r2 (security): a later `-c` wins in Codex, so an approved or typed argument that names the
                // key could turn the update screen back on; any argument naming it is refused, a prompt that says it too.
                if approved
                    .iter()
                    .chain(&start.args)
                    .any(|arg| arg.contains("check_for_update_on_startup"))
                {
                    return Err("Codex arguments cannot set check_for_update_on_startup; Nunchiro keeps Codex's update screen off".into());
                }
                // Ticket 1149: nor may a config or feature argument name hooks: a later one could take the outward
                // hook away (`outward::codex_args`). A person's own hooks go in Codex's config, where they stay theirs.
                if crate::outward::codex_arg_names_hooks(
                    &approved.iter().chain(&start.args).collect::<Vec<_>>(),
                ) {
                    return Err("Codex arguments cannot set hooks; Nunchiro's outward-action check runs as a Codex hook. Keep your own hooks in Codex's config".into());
                }
                cmd.arg("--no-daemon");
                // Ticket 692: Codex's update screen preselects "Update now", so one Enter (the person's, a lead's
                // `agent send`, a script's) runs a machine-wide `brew upgrade` under every running worker. No seat
                // shows it; the person updates Codex outside Nunchiro (Orca does the same for its automated starts).
                cmd.args(["-c", "check_for_update_on_startup=false"]);
                cmd.args(permission); // ticket 362: global options, so before `resume`
                cmd.args(approved); // ticket 358: the same
                // V2.5-31: Codex has no plugin folder; the pointer to the guide rides on this launch only (a global option, so before `resume`).
                // Ticket 276: so do Nunchiro's own MCP servers.
                cmd.args(extension_flags(
                    &self.home,
                    &self.settings,
                    AgentKind::Codex,
                    false,
                    project,
                )?);
                if let Some(resume) = &start.resume {
                    cmd.args(["resume", resume]);
                }
                if let Some(model) = &start.model {
                    cmd.args(["-m", model]);
                }
                if let Some(effort) = &start.effort {
                    cmd.arg("-c");
                    cmd.arg(format!(
                        "model_reasoning_effort={}",
                        serde_json::to_string(effort).unwrap()
                    ));
                }
                // v1b-07: a writable root. v1b-35: Codex 0.161.0 exits at start on `--add-dir` under a read-only
                // sandbox, so a read-only session gets none (the folder and variable stay; it cannot write there).
                // v1b-38: read-only from the launch args or Codex's config layers.
                if let Some((_, folder)) = artifacts.as_ref().filter(|_| {
                    !codex_read_only.unwrap_or_else(|| {
                        crate::codex_sandbox::read_only(
                            &[permission, approved, &start.args[..]].concat(),
                            cwd,
                            config_dir.as_deref(),
                        )
                    })
                }) {
                    cmd.arg("--add-dir");
                    cmd.arg(folder);
                }
            }
        }
        // v1b-07: the per-session settings file also carries the artifact folder's permission rules, with or without
        // hooks.
        let mut settings = serde_json::Map::new();
        if let Some(m) = self
            .start_modes
            .as_ref()
            .filter(|_| start.kind == AgentKind::Claude)
        {
            claude_modes::settings(&mut settings, m); // W35
        }
        if let Some(rules) = artifacts
            .as_ref()
            .filter(|_| start.kind == AgentKind::Claude)
            .and_then(|(_, folder)| folder_permissions(folder))
        {
            settings.insert("permissions".into(), rules);
        }
        // end v1b-07
        if start.kind == AgentKind::Claude {
            memory::deny_memory(&mut settings, &self.home);
        }
        // Round 4 (security MUST 1): a run that continues a token session (a resume by anyone, a problem restart) or a
        // side chat of one is a token session too.
        // Round 6 (security r5 MUST 1): the origin is stored on the record, so a later close or resume of a parent
        // changes nothing.
        // Ticket 621 round 3: a token row is never removed without a replacement that keeps its origin (only marked
        // Closed, replaced by its resume below, or dropped with a `token_conversations` record, ticket 752), so its
        // conversation's origin is found on a row, on the row inside its Undo window (`closing`), or in that record. Round 4: by conversation id and agent kind in every project, not `prior_ids`
        // (same project only): a worktree's conversation resumed from its main folder keeps the token too. A caller
        // acting for another token is refused: the run would carry that token instead of the one it ran under.
        let prior_origin = self
            .entries
            .values()
            .map(|e| &e.meta)
            .chain(self.closing.as_ref().map(|c| &c.entry.meta))
            .filter(|m| {
                start.resume.is_some() && m.kind == start.kind && m.agent_session_id == start.resume
            })
            .find_map(|m| self.token_origin(m))
            .or_else(|| {
                // Ticket 752: a dropped token row's conversation keeps its origin in sessions.json.
                self.token_conversations
                    .iter()
                    .find(|t| {
                        t.kind == start.kind && start.resume.as_ref() == Some(&t.conversation)
                    })
                    .map(|t| t.origin.clone())
            });
        if let (Some(caller), Some(prior)) = (&origin, &prior_origin)
            && caller != prior
        {
            return Err("this conversation ran under another token; it can be resumed only by that token or the owner".into());
        }
        if origin.is_some() && prior_origin.is_none() && start.resume.is_some() && self.origins_lost
        {
            return Err("a set-aside session store could not be read, so this conversation's token is unknown; only the owner can resume it".into());
        }
        let origin = origin.or(prior_origin).or_else(|| {
            side_parent(start)
                .and_then(|p| self.entries.get(&p))
                .and_then(|e| self.token_origin(&e.meta))
        });
        let outside = origin.is_some();
        if outside && start.kind != AgentKind::Claude {
            return Err("a token session runs only Claude".into());
        }
        if outside {
            tokens::keep_out(&self.home, &mut settings)?;
        }
        // Ticket 1149: Nunchiro's own Codex PreToolUse hook, when this start passes it; it rides with the outward hook.
        let mut codex_pre = None;
        if start.kind != AgentKind::Shell && !self.settings.disable_hook_injection && !without_hooks
        {
            let lines = nunchiro_hooks()?;
            if start.kind == AgentKind::Claude {
                let hooks: serde_json::Map<String, serde_json::Value> = lines.into_iter().map(|line| {
                    // Ticket 991 B3: Claude's permission hook may wait for the card's answer (`queue::HOLD_MS`).
                    let handler = if line.event == "PermissionRequest" {
                        serde_json::json!({"type":"command","command":format!("{} --hold", line.command),"timeout":queue::HOLD_MS / 1000 + 10})
                    } else {
                        serde_json::json!({"type":"command","command":line.command,"timeout":2})
                    };
                    let block = if line.matcher.is_empty() { serde_json::json!([{"hooks":[handler]}]) } else { serde_json::json!([{"matcher":line.matcher,"hooks":[handler]}]) };
                    (line.event, block)
                }).collect();
                settings.insert("hooks".into(), hooks.into()); // v1b-07
                // Ticket 1036: Claude Code hands its status line command `rate_limits`; ours keeps them for the usage
                // bar and runs the user's own status line command with the same input, so their line is unchanged.
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                settings.insert(
                    "statusLine".into(),
                    serde_json::json!({"type": "command", "command": format!("{} hook statusline", shell_quote(&exe.to_string_lossy()))}),
                );
            } else if start.args.is_empty()
                && approved.is_empty()
                && codex_hooks_clear
                    .unwrap_or_else(|| codex_hooks_exclusive(cwd, project, config_dir.as_deref()))
            {
                cmd.args(["--enable", "default_mode_request_user_input"]);
                for line in lines {
                    if line.event == "PreToolUse" {
                        codex_pre = Some(line.command);
                        continue;
                    }
                    cmd.arg("-c");
                    cmd.arg(format!(
                        "hooks.{}=[{{hooks=[{{type=\"command\",command={},timeout=2}}]}}]",
                        line.event,
                        serde_json::to_string(&line.command).unwrap()
                    ));
                }
                cmd.arg("--dangerously-bypass-hook-trust");
            }
        }
        // Ticket 1002 lane 1, layer 2: the Home seat lock's own PreToolUse hook, decided in the hook process without the
        // core (a core that is down never opens it), with or without Nunchiro's other hooks (Fable check M2: a locked seat
        // never runs hook-less, whatever `without_hooks` or the hook setting says). M1: a failed or timed-out run blocks
        // the call (`onFailure`, probe 2026-11-20). M3: no settings layer may turn hooks or skill shell lines back on.
        if let Some(mode) = home_mode {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let no_mcp = if permission.iter().any(|a| a == "--strict-mcp-config") {
                format!(" {}", crate::home_lock::NO_MCP_FLAG)
            } else {
                String::new()
            };
            let command = format!(
                "{} hook home-lock --mode {}{no_mcp}",
                shell_quote(&exe.to_string_lossy()),
                crate::home_lock::name(mode)
            );
            let block = serde_json::json!({"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 10, "onFailure": "block"}]});
            settings.insert("disableAllHooks".into(), false.into());
            settings.insert("disableSkillShellExecution".into(), true.into());
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}));
            match hooks.as_object_mut().map(|h| {
                h.entry("PreToolUse")
                    .or_insert_with(|| serde_json::json!([]))
            }) {
                Some(serde_json::Value::Array(pre)) => pre.push(block),
                _ => return Err("the Home seat lock hook could not be written".into()),
            }
        }
        // Ticket 1130 S1: outward actions ask in every Claude session, with or without Nunchiro's other hooks, decided in
        // the hook process (`nunchiro_core::outward`); a failed run blocks the call, as the lock's does. Round 2 (Codex 3):
        // no project, local or user layer may turn it off; `--settings` outranks them all but managed settings.
        if start.kind == AgentKind::Claude {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let lock = if home_mode.is_some() {
                " --home-lock"
            } else {
                ""
            };
            let command = format!("{} hook outward{lock}", shell_quote(&exe.to_string_lossy()));
            let block = serde_json::json!({"matcher": crate::outward::MATCHER, "hooks": [{"type": "command", "command": command, "timeout": 10, "onFailure": "block"}]});
            settings.insert("disableAllHooks".into(), false.into());
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}));
            match hooks.as_object_mut().map(|h| {
                h.entry("PreToolUse")
                    .or_insert_with(|| serde_json::json!([]))
            }) {
                Some(serde_json::Value::Array(pre)) => pre.push(block),
                _ => return Err("the outward hook could not be written".into()),
            }
        }
        // Ticket 1149: and in every Codex session, whatever its arguments, its config or the hook setting. Codex has no
        // "ask", so its hook holds for Nunchiro's own card and refuses the call unless the owner allowed it
        // (`nunchiro hook outward --codex`, `codex_ask`); it is trusted by its own hash, never by the bypass flag.
        if let Some(command) = &codex_hook {
            cmd.args(crate::outward::codex_args(command, codex_pre.as_deref()));
        }
        // v1b-07
        if !settings.is_empty() {
            let path = self.home.join(format!("hooks-{id}.json"));
            store::atomic_write(&path, &serde_json::to_vec(&settings).unwrap())?;
            cmd.arg("--settings");
            cmd.arg(path);
        }
        if start.kind == AgentKind::Claude {
            cmd.args(approved); // ticket 358: where typed arguments go, after `--session-id` ends `--add-dir`'s list
        }
        if start.kind != AgentKind::Shell {
            cmd.args(
                start
                    .args
                    .iter()
                    .take_while(|arg| arg.as_str() != SIDE_CHAT_ARG),
            );
        }
        // Ticket 286 (needs 207, herdr's pane): an agent that quits leaves a shell in its folder on the same PTY leader
        // and group. A side chat ends with its parent and a missing binary must fail the start, so neither is wrapped.
        if start.kind != AgentKind::Shell
            && !start.args.iter().any(|arg| arg == SIDE_CHAT_ARG)
            && resolved(program).is_some()
        {
            let marker = ended_marker(&self.home, id);
            cmd.get_argv_mut().splice(
                0..0,
                ["/bin/sh", "-c", AGENT_WRAPPER, "nunchiro-agent"]
                    .map(std::ffi::OsString::from)
                    .into_iter()
                    .chain([marker.into_os_string()]),
            );
        }
        let resumed = prior_ids
            .iter()
            .max_by_key(|old| {
                let a = self.queue.attention(old);
                (a.completion_seq, a.last_activity)
            })
            .cloned();
        // v1a-40: the reopened terminal shows the continued run's scrollback above the new output: the replay of a
        // run that exited in this core, else the copy saved when it stopped (read at `open`, not under this lock).
        // A run whose PTY was dropped unsaved (a Codex model switch) seeds nothing.
        let seed = match resumed.as_deref().map(|old| &self.entries[old]) {
            Some(Entry { pty: Some(pty), .. }) => pty.snapshot(),
            Some(entry) => entry
                .saved
                .get_or_init(|| load_saved(&self.home, &entry.meta.id))
                .as_ref()
                .map(|saved| saved.bytes())
                .unwrap_or_default(),
            None => vec![],
        };
        let seed = if seed.is_empty() {
            seed
        } else {
            [seed, RESUMED_MARKER.to_vec()].concat()
        };
        // V2-1a: the token's hash is on disk before the agent can use the token.
        self.launching = Some((id.to_string(), store::token_sha256(&token)));
        if let Err(e) = self.save() {
            self.launching = None;
            return Err(e);
        }
        let pty = match Pty::spawn(&self.home, id, cmd, &seed) {
            Ok(pty) => pty,
            Err(e) => {
                self.launching = None;
                if let Err(e) = self.save() {
                    eprintln!("launch record cleanup failed: {e}");
                }
                // F15: the caller names an unreadable folder off the lock (`refused_start`).
                return Err(e);
            }
        };
        self.launching = None;
        // v1a-33: the agent starts either way; a refused or silent folder only marks the session.
        // Past PROBES_MAX parked probe threads new starts go unprobed (shown as today); see `spawn_probe`.
        let probe = spawn_probe(&self.probes, self.folder_probe, cwd)
            .ok()
            .map(|receiver| (std::time::Instant::now(), receiver));
        if start.kind == AgentKind::Codex && agent_session_id.is_none() {
            crate::identity::watch(
                self.home.clone(),
                id.into(),
                token.clone(),
                pty.pid(),
                cwd.into(),
                pty.lifetime(),
            );
        }
        if let Some(old) = &resumed {
            self.queue.prepare_resume(old, id)?;
        } else {
            self.queue.register(id, start.kind, queue::now_ms())?;
        }
        if let Some(v) = &version {
            crate::agent_canary::version_seen(&self.home, start.kind, v); // ticket 1100
        }
        let meta = Session {
            side_chat: start.args.iter().any(|arg| arg == SIDE_CHAT_ARG),
            stopped_sends: Vec::new(),
            send_waits: Default::default(),
            side_parent: side_parent(start),
            side_split: side_split(start),
            machine: None, // v1a-06
            id: id.into(),
            kind: start.kind,
            project: project.into(),
            cwd: cwd.into(),
            label: start.label.clone(),
            closed_by_command: false,
            // Ticket 1017: a resume that keeps the first message's name keeps it numbered as one.
            auto_label: prior_ids.iter().any(|id| {
                let m = &self.entries[id].meta;
                m.auto_label && m.label == start.label
            }),
            state: SessionState::Running,
            agent_session_id,
            agent_version: version,
            untested: !tested,
            pid: Some(pty.pid()),
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            // v1a-10
            model: start
                .model
                .clone()
                .or_else(|| claude_modes::named_model(start)), // W35-picker2 S3
            effort: start.effort.clone(),
            // v1b-11: a resumed conversation keeps the start of the conversation it continues.
            start_commit: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.start_commit.clone())
                .or(start_commit),
            artifacts: artifacts.and_then(|(folder_id, _)| folder_id), // v1b-07
            blocked: None,                                             // v1a-33
            holder_status: None,                                       // V2-1b
            account: account.filter(|_| config_dir.is_some()),         // v2-2b
            config_dir,                                                // v2-2b
            // v2-3b: a resumed run stays in its conversation (a Codex model switch, a handoff back).
            conversation: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.conversation.clone()),
            problem: None,                                                  // v2-5b
            without_hooks: without_hooks && start.kind != AgentKind::Shell, // v2-5b
            home_lock: home_mode.is_some(),                                 // ticket 1002
            home_mode: home_mode.map(|m| crate::home_lock::name(m).to_string()),
            no_history,
            account_tab,
            permission_mode: None, // CHAT-PERMCHIP
            starting: false,
            at_box: false,
            draft_home: None,
            take_back: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            // V2.5-30: a resumed run keeps the session that started the run it continues.
            parent: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.parent.clone()),
            // Ticket 990: a resumed run stays the teammate's seat.
            teammate: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.teammate.clone()),
            // Look 1117 v10 N10-S2-3: the room still names the seat by these ids.
            // shortcut: the newest 64 only, so a seat resumed hundreds of times does not grow its row; more if a room outlives that.
            resumed_from: prior_ids
                .iter()
                .flat_map(|id| {
                    std::iter::once(id.clone())
                        .chain(self.entries[id].meta.resumed_from.iter().cloned())
                })
                .take(64)
                .collect(),
            // `start_granted` clears it: an agent's resume of another run's conversation inherits no close rights.
            owned_from: prior_ids
                .iter()
                .flat_map(|id| {
                    std::iter::once(id.clone())
                        .chain(self.entries[id].meta.owned_from.iter().cloned())
                })
                .take(64)
                .collect(),
            level: prior_ids.iter().find_map(|id| self.entries[id].meta.level),
            // Ticket 993: a resumed run of a scheduled run is still that run until the user speaks to it.
            schedule: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.schedule.clone()),
            started_at: Some(queue::now_ms()),
            token_origin: origin, // ticket 573 round 6
            closed_at: None,      // ticket 621
            ended_at: None,       // lane w59: stamped when the run ends
            acp_agent: None,      // V2-4a
            agent_ended: false,   // ticket 286: set per snapshot
            limit: None,          // ticket 372: set per snapshot
            folder_gone: false,   // look 1117 v13: set per snapshot
            ended_ask: None,      // look 1117 v10 N10-S3-3: set per snapshot
            // Ticket 1018: Ultracode as Claude starts it when Nunchiro set none; Claude's answer to a toggle reads later.
            modes: {
                let mut modes = self.start_modes.clone();
                if let Some(on) = ultracode
                    && modes.as_ref().and_then(|m| m.ultracode).is_none()
                {
                    modes.get_or_insert_default().ultracode = Some(on);
                }
                modes.filter(|_| start.kind == AgentKind::Claude)
            },
        };
        // Ticket 990 slice g: a seat is its session; the resumed run takes the seat of the run it continues.
        if let Err(e) = crate::ledger::Ledger::open(&self.home).reseat(&prior_ids, id) {
            eprintln!("ledger seat not moved: {e}");
        }
        // Ticket 621: the resumed run replaces its prior rows; a token row's origin is on the new row (`origin` above).
        let prior: Vec<_> = prior_ids
            .into_iter()
            .filter_map(|id| self.entries.remove(&id).map(|entry| (id, entry)))
            .collect();
        self.entries.insert(
            id.into(),
            Entry {
                meta: meta.clone(),
                pty: Some(pty),
                pty_size: Some((160, 50)),
                token_hash: Some(store::token_sha256(&token)), // V2-1b
                token: Some(token),
                stale: None, // V2-1b
                // v1a-40: prompt detection starts after the seed, so an old screen in it is never taken as current.
                observer: waiting::Observer {
                    output_offset: seed.len() as u64,
                    // A new Claude start may ask about the artifact folder the core adds: see `observe`.
                    own_folder: (start.kind == AgentKind::Claude).then(std::time::Instant::now),
                    before_box: start.kind == AgentKind::Claude,
                    silent_since: Some(std::time::Instant::now()),
                    ..Default::default()
                },
                input: crate::delivery::Input::default(),
                // v1a-10
                switch: None,
                walk: None,
                walk_error: None,
                // Launched in it by the owner's arguments or stored choice.
                skip_chosen: start
                    .args
                    .iter()
                    .chain(permission)
                    .any(|a| a == START_IN_SKIP),
                skip_hold: None,
                args: (start.resume.is_none() && env.is_empty()).then(|| start.args.clone()), // W35: env is not kept
                launch: env.is_empty().then(|| start.args.clone()),
                permission: permission.to_vec(),
                bypass_disabled,
                saved: Default::default(), // v1a-40
                probe,                     // v1a-33
                version_probe: None,       // V1A-89: `start` hands over a pending one
                acp: None,                 // V2-4a
                agent_ended: false,
                card_due: None,
            },
        );
        if let Err(e) = self.save() {
            self.entries.remove(id);
            self.entries.extend(prior);
            return Err(e);
        }
        // A shell only: an agent keeps its 160 columns until a terminal view shows it, so its prompts and its model
        // picker are read unwrapped while the chat is in front.
        if let Some((cols, rows)) = self.window_size.filter(|_| start.kind == AgentKind::Shell) {
            // Best effort: a failed resize leaves the PTY at 160x50, as before; the window's own resize follows.
            let _ = self.resize_pty(id, cols, rows);
        }
        for (prior_id, entry) in prior {
            if let Err(e) = remove_hooks(&self.home, &prior_id) {
                eprintln!("old hook cleanup failed: {e}");
            }
            // v1a-40: its row is gone; the seeded replay now holds the text.
            self.forget_write(&prior_id);
            if let Err(e) = crate::scrollback::remove(&self.home, &prior_id) {
                eprintln!("old scrollback cleanup failed: {e}");
            }
            if let Err(e) = crate::scrollback_edit::remove(&self.home, &prior_id) {
                eprintln!("old export cleanup failed: {e}"); // v1a-38b
            }
            // v2-13a: the replaced row's token and log go with it.
            if let Some(token) = &entry.token {
                crate::logs::unregister(token);
            }
            if let Err(e) = crate::logs::remove_session(&self.home, &prior_id) {
                eprintln!("old session log cleanup failed: {e}");
            }
        }
        Ok(self.snapshot_session(&meta))
    }
}
pub(super) fn side_parent(start: &StartSession) -> Option<String> {
    let at = start.args.iter().position(|arg| arg == SIDE_CHAT_ARG)?;
    start.args.get(at + 1).cloned()
}
pub(super) fn side_split(start: &StartSession) -> Option<String> {
    let at = start.args.iter().position(|arg| arg == SIDE_CHAT_ARG)?;
    start.args.get(at + 2).cloned()
}

/// aS2-1: the terminal size a window last gave a session, kept for PTYs that open with no window attached.
pub(super) const WINDOW_SIZE: &str = "terminal-size";
pub(super) fn saved_window_size(home: &Path) -> Option<(u16, u16)> {
    let text = String::from_utf8(store::read_regular(&home.join(WINDOW_SIZE)).ok()?).ok()?;
    let (cols, rows) = text.trim().split_once(' ')?;
    let (cols, rows) = (cols.parse().ok()?, rows.parse().ok()?);
    // The PTY's own bounds (`Pty::resize`).
    (1..=500).contains(&cols).then_some(())?;
    (1..=300).contains(&rows).then_some((cols, rows))
}
/// w10 item 13: how long (tenths of a second) a plain shell started before any window waits for one's size: 8 s (the
/// app opens its window within a few seconds of a CLI start). NUNCHIRO_SHELL_SIZE_WAIT_MS sets it (test fixtures that
/// read a shell no window shows set it to 0).
fn shell_size_wait_tenths() -> u64 {
    std::env::var("NUNCHIRO_SHELL_SIZE_WAIT_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
        .map_or(80, |ms| ms / 100)
}
// v1a-40
const RESUMED_MARKER: &[u8] =
    "\r\n\x1b[0;2m— resumed; earlier output above —\x1b[0m\r\n".as_bytes();
/// Ticket 286: what an agent session runs, as `sh -c AGENT_WRAPPER nunchiro-agent <marker> <agent argv>`. `sh` stays
/// the PTY leader: it survives the Ctrl+C that ends the agent (the agent keeps the default), prints `ENDED_MARK` and
/// writes the agent's exit code to the marker `refresh` reads. It waits until the core answers `seen <code>` there
/// (from then on nothing but the user's keys is written), drops what reached the terminal before that (a send the core
/// wrote to the dead agent), puts back the terminal modes the agent changed, then becomes the user's shell in the same
/// folder. A marker it cannot write, or no answer within 30 s, ends the session instead: no shell the core does not
/// know of.
/// Ticket 507: the drain is POSIX (`read -t/-n` are bash's) and silent. `stty -echo -icanon min 0 time 10` makes each
/// `dd` return what is pending, or nothing after a quiet second, and echoes nothing: `read -n 1` in canonical mode had
/// the terminal reprint the pending line for each byte (one typed line became ~30). It stops at a quiet second or
/// once 3 s have passed, so keys that keep coming cannot hold the shell back. It runs only when `stty` took the
/// terminal (with none, `dd` would wait on whatever stdin is), and the saved modes come back either way. Ticket 512
/// r2: a Ctrl-C kills `dd`, `wc` and `date` (the INT trap is not inherited), so an empty count reads as 0 and an
/// empty time as the bound: the loop ends without a `[` error on the screen.
/// Ticket 991: zsh's first start file for a shell session (the core points ZDOTDIR at its folder). It hands ZDOTDIR
/// back before any other start file is read (so the user's files, and macOS's HISTFILE default, see the user's own
/// value), reads the user's .zshenv, and marks each prompt's start and each command's start with OSC 133. The window
/// erases a marked prompt before its pane narrows and zsh redraws it once (`fitPrompt` in web/src/Terminal.tsx);
/// without marks a prompt row that fills the width (oh-my-posh, powerlevel10k, starship) stayed on screen twice. The
/// mark sits in PS1, so every redraw of the prompt carries it; a hook that runs later may build PS1 again, so the
/// mark is also printed once and the hook moves to the end. The command mark matters as much: it drops the prompt's
/// mark, so the output of a running command is never erased. Kitty's and Orca's zsh integrations work the same way.
/// shortcut: a prompt drawn right after output with no line end takes that row with it when it is erased (first
/// prompt only, or with a hook that always runs after this one); mark in a line-init widget if that is ever seen.
const ZSH_MARKS: &str = r#"# Written by Nunchiro at each shell start; edits are lost. It gives ZDOTDIR back to you, reads your own .zshenv,
# and marks where each prompt starts (OSC 133), so a prompt is drawn once when its pane gets narrower.
# Off: start Nunchiro with NUNCHIRO_SHELL_INTEGRATION=0 in its environment.
if [[ -n ${NUNCHIRO_USER_ZDOTDIR+x} ]]; then
  export ZDOTDIR=$NUNCHIRO_USER_ZDOTDIR
  unset NUNCHIRO_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -o interactive ]]; then
  _nunchiro_prompt_mark() {
    builtin emulate -L zsh
    [[ $PS1 == *$'\e]133;A\a'* ]] || PS1=$'%{\e]133;A\a%}'$PS1
    if [[ ${precmd_functions[-1]} != _nunchiro_prompt_mark ]]; then
      builtin print -n '\e]133;A\a'
      precmd_functions=(${precmd_functions:#_nunchiro_prompt_mark} _nunchiro_prompt_mark)
    fi
  }
  _nunchiro_command_mark() { builtin print -n '\e]133;C\a' }
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(_nunchiro_prompt_mark)
  preexec_functions+=(_nunchiro_command_mark)
fi
[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source ${ZDOTDIR:-$HOME}/.zshenv
"#;

/// The folder `ZSH_MARKS` lives in, written when it is missing or differs (an older core's file). Read and written as
/// the core's other files are (Codex look, wave 12): a link, a FIFO or a file over the read limit at its place is
/// never followed or waited on, it is replaced.
fn zsh_marks_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("shell").join("zsh");
    store::private_dir(&home.join("shell"))?;
    store::private_dir(&dir)?;
    let file = dir.join(".zshenv");
    if store::read_regular(&file).ok().as_deref() != Some(ZSH_MARKS.as_bytes()) {
        store::atomic_write(&file, ZSH_MARKS.as_bytes())?;
    }
    Ok(dir)
}
/// The command a PTY session starts as, before it gets its own identity (session id, token, artifact folder): its
/// program, folder and environment. `Sessions::spawn` builds on it under the registry lock. Ticket 1150 round 2:
/// `Launch::ask_codex` and a Codex model switch build the same one off that lock and ask Codex with it (`codex_ask`),
/// so nothing here may read the registry.
#[allow(clippy::too_many_arguments)]
pub(super) fn seat_command(
    settings: &Settings,
    home: &Path,
    program: &str,
    kind: AgentKind,
    locked: bool,
    by_owner: bool,
    config: Option<&(&'static str, PathBuf)>,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    // Ticket 260: the login shell's variables (held by `user_env`, never set on the core) come first, so every
    // value set or removed below (parent session, account, approved `env`, Nunchiro's own) wins over them.
    Sessions::seat_env(settings, &mut cmd, locked);
    // Ticket 1008: a shell keeps the owner's environment only when the owner opened it; one an agent, a schedule or
    // a peer starts (`nunchiro session start --kind shell`) is stripped like an agent.
    if kind != AgentKind::Shell || !by_owner {
        Sessions::strip_secret_env(settings, &mut cmd, kind);
    }
    // Keep user config locations and credentials; clear the launching session's identity and messaging channel.
    for (key, _) in std::env::vars_os().filter(|(key, _)| is_parent_session_env(key)) {
        cmd.env_remove(key);
    }
    // V2-2a: an account login sees its own folder only, never the core's inherited one for either agent.
    // Nor an API key or token the core inherited, which would sign the login in as someone else. V2-2b: the same
    // for an agent session on an account.
    if let Some((variable, folder)) = config {
        for key in ACCOUNT_ENV {
            cmd.env_remove(key);
        }
        cmd.env(variable, folder);
    }
    // Before the core's own values, so none of those can be replaced even if the check missed one.
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("NUNCHIRO_HOME", home);
    // Ticket 990: `nunchiro` typed in a session is this core's own CLI, so its folder leads the session's PATH. In
    // a trial with real Claude an installed older `nunchiro` came first: it could not read this core's worktree
    // reply ("unknown field team"), and the lead fell back to plain `git worktree add`.
    if let Some(own) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        let rest = std::env::var_os("PATH").unwrap_or_default();
        let parts =
            std::iter::once(own.clone()).chain(std::env::split_paths(&rest).filter(|p| *p != own));
        if let Ok(path) = std::env::join_paths(parts) {
            cmd.env("PATH", path);
        }
    }
    cmd
}
/// Tickets 1149 and 1150: the question a Codex start puts to its Codex, from the command it starts as (`seat_command`):
/// that program, in that folder and environment, with the outward hook every Codex session gets. `|| exit 2`: Codex
/// has no `onFailure`, and a hook that cannot run (this binary replaced by an update, a crash) lets the tool run;
/// exit 2 is the one failure Codex treats as a refusal (probe 2026-11-26).
pub(super) fn codex_ask(
    cmd: &CommandBuilder,
    program: &str,
    cwd: &Path,
) -> Result<crate::outward::CodexAsk, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(crate::outward::CodexAsk {
        program: program.into(),
        cwd: cwd.into(),
        env: cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
        command: format!(
            "{} hook outward --codex || exit 2",
            shell_quote(&exe.to_string_lossy())
        ),
    })
}

pub(super) const AGENT_WRAPPER: &str = r#"trap : INT; m=$1; shift; s=$(stty -g 2>/dev/null); "$@"; c=$?; printf '\033]7700;nunchiro-agent-ended\007'; echo $c > "$m" || exit; i=0; while [ "$(cat "$m" 2>/dev/null)" = "$c" ]; do [ $i -lt 600 ] || exit; sleep 0.05; i=$((i+1)); done; [ -n "$s" ] && stty -echo -icanon min 0 time 10 2>/dev/null && { t=$(($(date +%s)+3)); while n=$(dd bs=4096 count=1 2>/dev/null | wc -c); d=$(date +%s); [ "${n:-0}" -gt 0 ] && [ "${d:-$t}" -lt $t ]; do :; done; }; [ -n "$s" ] && stty "$s" 2>/dev/null; exec "${SHELL:-/bin/zsh}" -i"#;
/// Ticket 209: what a parent Claude Code or Codex session exports to its children. A started agent, shell or login that
/// inherits it would act as that conversation (`CLAUDE_CODE_CHILD_SESSION` also turns its transcript off) or hold its
/// messaging token.
pub(crate) const PARENT_SESSION_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "TRACEPARENT",
    "TRACESTATE",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
];
/// Ticket 209: a name in `PARENT_SESSION_ENV`, or any `CLAUDE_CODE_MESSAGING_*` (socket, token, and whatever follows).
pub(crate) fn is_parent_session_env(name: &std::ffi::OsStr) -> bool {
    let name = name.as_encoded_bytes();
    name.starts_with(b"CLAUDE_CODE_MESSAGING_")
        || PARENT_SESSION_ENV.iter().any(|n| n.as_bytes() == name)
}
/// V2-2a: what a login tab never inherits from the core: either agent's config folder and the credentials that
/// override a folder's login.
pub(crate) const ACCOUNT_ENV: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    // Claude Code 2.1.311 names its Keychain item from this one first (accounts.rs, REPORT r2).
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
];
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];
/// Ticket 455: Nunchiro's own hooks as a launch passes them; the extensions list shows these same lines.
pub(crate) fn nunchiro_hooks() -> Result<Vec<crate::extensions::HookLine>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hook = format!("{} hook", shell_quote(&exe.to_string_lossy()));
    Ok(HOOK_EVENTS
        .iter()
        .map(|event| crate::extensions::HookLine {
            event: (*event).into(),
            matcher: if ["PermissionRequest", "PreToolUse", "PostToolUse"].contains(event) {
                "*".into()
            } else {
                String::new()
            },
            command: format!("{hook} {event}"),
        })
        .collect())
}
/// v1b-07: Claude permission rules for the artifact folder; `//` marks an absolute path. Only `Edit(path)` rules
/// govern writes, the Write tool's too (Claude Code 2.1.318 warns "Write(path) ... is not matched by file permission
/// checks, only Edit(path) rules are" for a `Write(path)` rule, ticket 287), so no `Write` twin is written. Deny (checked before allow) covers every file Claude Code loads
/// configuration from inside an `--add-dir` folder (same doc, "Additional directories grant file access, not
/// configuration": `.claude/` skills, commands, agents and settings; `CLAUDE.md` and `CLAUDE.local.md`), at any depth
/// and in any letter case, since macOS folders are case-insensitive; otherwise an agent could write itself a skill whose
/// `allowed-tools` runs Bash unprompted. The plain lowercase twins hold if a Claude version drops bracket classes.
/// No allow rule when the folder already holds such a file. None when the path holds a character the rule syntax
/// could read as a pattern or a delimiter, so a rule never widens: the folder is still added and writes there ask.
fn folder_permissions(folder: &Path) -> Option<serde_json::Value> {
    let path = folder.to_str()?;
    if path
        .chars()
        .any(|c| "*?[]{}()\\!".contains(c) || c.is_control())
    {
        return None;
    }
    let rule = |p: &str| format!("Edit(/{path}/{p})");
    let deny: Vec<String> = [
        "**/.claude/**",
        "**/.[cC][lL][aA][uU][dD][eE]/**",
        "**/CLAUDE.md",
        "**/[cC][lL][aA][uU][dD][eE].[mM][dD]",
        "**/CLAUDE.local.md",
        "**/[cC][lL][aA][uU][dD][eE].[lL][oO][cC][aA][lL].[mM][dD]",
    ]
    .iter()
    .map(|p| rule(p))
    .collect();
    let planted = fs::read_dir(folder).ok()?.any(|e| {
        e.is_ok_and(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            [".claude", "claude.md", "claude.local.md"].contains(&name.as_str())
        })
    });
    Some(if planted {
        serde_json::json!({"deny": deny})
    } else {
        serde_json::json!({"allow": [rule("**")], "deny": deny})
    })
}
/// Ticket 276: the launch flags for the enabled extensions (core `features` `extensions.enabled`; absent = the shipped
/// skill alone, a custom folder stays off until switched on). Everything points into Nunchiro's own data folder:
/// nothing here writes the agents' home folders. Ticket 362's `agent_permission::claude_limits` is the one read of them,
/// of Claude's settings files only, read-only.
/// `locked` (ticket 1002, owner R2): a Home seat lock gets the shipped skill only: no custom plugin folder (its hooks
/// could rewrite a call after the lock hashed it) and no own MCP server.
pub(super) fn extension_flags(
    home: &Path,
    settings: &Settings,
    kind: AgentKind,
    locked: bool,
    project: &Path,
) -> Result<Vec<std::ffi::OsString>, String> {
    let on = crate::extensions::enabled(settings.feature(crate::extensions::ENABLED_KEY));
    let default_on = crate::extensions::default_on(&on);
    let mut out: Vec<std::ffi::OsString> = vec![];
    match kind {
        AgentKind::Claude => {
            if default_on {
                out.push("--plugin-dir".into());
                out.push(skill::install(home, settings.orchestration.enabled)?.into_os_string());
            }
            if !locked {
                out.extend(crate::extensions::claude_flags(home, &on, project));
            }
        }
        AgentKind::Codex => {
            if default_on && settings.orchestration.enabled {
                out.push("-c".into());
                out.push(skill::CODEX_INSTRUCTION.into());
            }
            out.extend(crate::extensions::codex_flags(home, project));
        }
        AgentKind::Shell | AgentKind::Acp => {}
    }
    Ok(out)
}
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
