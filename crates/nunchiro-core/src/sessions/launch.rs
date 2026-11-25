//! A prepared launch (`Launch`): the folder, args, env and permission reach a start is checked for.
use super::*;

/// The launch args a Codex restart may pass again: Codex 0.161.0 `resume` options that neither name a model
/// or effort nor carry a prompt. Anything else (`--`, a positional, an unknown flag) refuses the switch.
pub(super) fn carried_codex_args(args: Option<&[String]>) -> Result<Vec<String>, String> {
    let args = args.ok_or(
        "this Codex session was resumed or restored, so its launch arguments are not known; restart it by hand",
    )?;
    let refuse = || {
        format!(
            "the session's launch arguments ({}) cannot be passed to a restart: only -s, -a, --add-dir, \
             --enable, --disable, -c without model keys and the sandbox, approval and search flags carry \
             over; restart it by hand",
            args.join(" ")
        )
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (arg.as_str(), None),
        };
        let flag = [
            "--search",
            "--no-alt-screen",
            "--approve-for-me",
            "--dangerously-bypass-approvals-and-sandbox",
            "--no-daemon",
        ];
        if flag.contains(&name) && inline.is_none() {
            continue;
        }
        let value = match name {
            "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "-c" | "--config" | "--add-dir"
            | "--enable" | "--disable" => inline
                .or(rest.next().map(String::as_str))
                .ok_or_else(refuse)?,
            _ => return Err(refuse()),
        };
        let ok = match name {
            "-s" | "--sandbox" => {
                ["read-only", "workspace-write", "danger-full-access"].contains(&value)
            }
            "-a" | "--ask-for-approval" => ["on-request", "never"].contains(&value),
            // A model, or a profile that may name one; TOML quotes around the key do not hide it.
            "-c" | "--config" => value.split_once('=').is_some_and(|(key, _)| {
                let key = key.trim().trim_matches(['"', '\'']);
                !key.starts_with("model") && !key.starts_with("profile")
            }),
            _ => !value.is_empty() && !value.starts_with('-'),
        };
        if !ok {
            return Err(refuse());
        }
    }
    Ok(args.to_vec())
}
pub struct Launch {
    pub(super) home: PathBuf,
    pub(super) settings: Settings,
    pub(super) start: StartSession,
    pub(super) id: String,
    pub(super) project: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(super) version: Option<String>,
    // V1A-89: a `--version` probe that outlived `VERSION_WAIT`; `start` hands it to the session's entry.
    pub(super) version_probe: std::cell::Cell<Option<VersionProbe>>,
    pub(super) worktree_created: bool,
    pub(super) folder: Option<PathBuf>, // V2-8f: an existing managed worktree, not a new checkout
    pub(super) resume_cwd: Option<PathBuf>,
    pub(super) start_commit: Option<crate::diff::Base>, // v1b-11
    // v2-2a: (variable, account folder) for a login tab; v2-2b: or an agent session on an account.
    pub(super) config: Option<(&'static str, PathBuf)>,
    // v2-2b: the account folder of the run a resume continues (inner None: "Your own"); None when nothing is resumed.
    pub(super) resume_config: Option<Option<PathBuf>>,
    /// Ticket 451: the account folder a resumed conversation ran on, when the resume names another (None: "Your own").
    pub(super) carry_from: Option<Option<PathBuf>>,
    // v2-2b: the label of the account `config` names for an agent session.
    pub(super) account: Option<String>,
    // V2-5b: "Start without Nunchiro hooks" (this launch only; the setting stays).
    pub(super) without_hooks: bool,
    // Round 3: a sign-in tab; its output is never saved as scrollback (`Session::no_history`).
    pub(super) no_history: bool,
    pub(super) account_tab: bool,
    /// Ticket 362: started by the owner in the app (`owner_start`).
    pub(super) owner: bool,
    /// Ticket 1008 round 2: started from the owner's own terminal (the socket without a session token).
    pub(super) owner_terminal: bool,
    /// Ticket 1002 lane 1: this start carries the Home seat lock whatever its folder: it resumes a locked run, is a side
    /// chat of one, or a locked session starts it (`launch_as`). `prepare` also sets it for a Claude start in Home.
    pub(super) home_lock: bool,
    /// Ticket 1002 lane 1: the lock's mode for this start (`home_lock::effective`), set by `prepare`; the hook gets it.
    pub(super) home_mode: Option<crate::home_lock::Mode>,
    pub(super) permission: Vec<String>,
    /// Look 11-17 N2: the mode a resumed Claude row last showed (`Session::ran_mode`).
    pub(super) ran_mode: Option<String>,
    pub(super) bypass_disabled: bool,
    /// Ticket 1018: a Claude start's Ultracode as its settings and arguments start it, read by `prepare` off the lock.
    pub(super) ultracode: Option<bool>,
    // Ticket 358: the approved command read by `prepare`, and the arguments this start takes from it.
    pub(super) command: Option<crate::approval::CommandProof>,
    pub(super) approved_args: Vec<String>,
    pub(super) env: BTreeMap<String, String>, // ticket 573: never stored with the session
    /// Ticket 573: the token the caller of this start acts for (round 6: its stored origin); its settings keep the
    /// agent out of the Nunchiro folder.
    pub(super) origin: Option<String>,
    pub committed: bool,
    /// Q9 en-b-J7-1: a Codex start's sandbox is read-only (`codex_sandbox::read_only`), read by `prepare` off the
    /// registry lock; None when this launch was not prepared, and `spawn` reads it then.
    pub(super) codex_read_only: Option<bool>,
    /// Q9 en-b-J7-2: `codex_hooks_exclusive` for a plain Codex start (no args), read with the sandbox.
    pub(super) codex_hooks_clear: Option<bool>,
}
pub(super) fn managed_start_folder(
    home: &Path,
    settings: &Settings,
    project: &Path,
    folder: &Path,
) -> Result<PathBuf, String> {
    let root = settings.legacy_worktree_root(home);
    let mut plan = WorktreePlan::owner(home, &root, "list", None);
    plan.project = Some(project.to_path_buf());
    let (worktrees, _, _) = plan.run()?;
    worktrees
        .into_iter()
        .find(|w| w.path == folder && !w.missing)
        .map(|w| w.path)
        .ok_or_else(|| "start folder is not a managed worktree of this project".into())
}

impl Launch {
    /// Ticket 362 (owner 11-09): a start the owner made in the app runs with the owner's stored permission (`prepare`).
    /// Opt-in per call site, so a scheduled run, a widget act, a session caller or a remote one never gets it.
    /// Full access is same-user trust: an agent under it can edit Nunchiro's settings file, and no file guard is claimed.
    pub(crate) fn owner_start(mut self) -> Self {
        self.owner = true;
        self
    }
    /// Ticket 1008 round 2: a start from the owner's own terminal; only a shell's environment depends on it.
    pub(crate) fn owner_terminal(mut self) -> Self {
        self.owner_terminal = true;
        self
    }
    /// Ticket 322: a login or logout tab the core starts for an account; the window files it on Settings > Accounts.
    pub(crate) fn with_account_tab(mut self) -> Self {
        self.account_tab = true;
        self
    }
    /// Round 3: a sign-in tab keeps no saved scrollback, whatever the Terminal History setting says.
    pub(crate) fn without_history(mut self) -> Self {
        self.no_history = true;
        self
    }
    pub(crate) fn with_folder(mut self, folder: Option<PathBuf>) -> Self {
        self.folder = folder;
        self
    }
    /// Ticket 573: `agent start --env`, checked here so every caller (socket, window, forwarded) gets one rule.
    pub(crate) fn with_env(mut self, env: BTreeMap<String, String>) -> Result<Self, String> {
        // `spawn_acp` never reads it: refused, not dropped without a word.
        if self.start.kind == AgentKind::Acp && !env.is_empty() {
            return Err(
                "--env: an ACP agent does not take --env yet; set its environment in agents.toml"
                    .into(),
            );
        }
        check_start_env(&env)?;
        self.env = env;
        Ok(self)
    }
    pub(crate) fn prepare_existing(self, path: &Path) -> Result<Self, String> {
        let mut launch = self.prepare()?;
        launch.cwd = fs::canonicalize(path).map_err(|e| e.to_string())?;
        launch.start_commit = Some(crate::diff::start(&launch.cwd)); // v1b-11
        launch.read_codex_sandbox(); // for this folder
        Ok(launch)
    }
    /// V1A-89: Start waits `VERSION_WAIT` for `--version`; a slower probe goes on under `VERSION_CEILING` and
    /// `refresh` fills the version in, so host load alone never fails a start.
    fn version_of(&mut self, program: &str) -> Result<Option<String>, String> {
        let probe = version_probe(program, VERSION_CEILING)?;
        match probe.recv_timeout(VERSION_WAIT) {
            Ok(version) => version.map(Some),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.version_probe = std::cell::Cell::new(Some(probe));
                Ok(None)
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(format!(
                "{program} --version: probe ended without an answer"
            )),
        }
    }
    pub fn prepare(mut self) -> Result<Self, String> {
        if self.start.args.iter().any(|arg| arg == SIDE_CHAT_ARG) {
            let expected = match self.start.kind {
                AgentKind::Claude => ["--permission-mode", "plan", SIDE_CHAT_ARG],
                AgentKind::Codex => ["--sandbox", "read-only", SIDE_CHAT_ARG],
                _ => return Err("Side chat requires Claude or Codex".into()),
            };
            if self.start.resume.is_some()
                || !matches!(self.start.args.len(), 3..=5)
                || self.start.args[..3] != expected
            {
                return Err("invalid temporary Side chat launch".into());
            }
        }
        #[cfg(test)]
        if let Some(hook) = IN_PREPARE.take() {
            hook();
        }
        if self.start.label.len() > 256 {
            return Err("label exceeds 256 bytes".into());
        }
        // Ticket 358: refused here, before any worktree exists; `start` reads it again under the lock.
        self.command = crate::approval::check_command(&self.home, self.start.kind)?;
        // v1a-10: a model or effort is one argv value after `--model`/`-m`; it can never read as a flag.
        if [&self.start.model, &self.start.effort]
            .into_iter()
            .flatten()
            .any(|v| {
                v.is_empty()
                    || v.len() > 100
                    || v.starts_with('-')
                    || v.chars().any(|c| c.is_whitespace() || c.is_control())
            })
        {
            return Err("invalid model or effort".into());
        }
        // v25f F10: a shell needs no project; none given starts it in the user's home (the window does not know $HOME).
        if self.start.kind == AgentKind::Shell && self.start.project.as_os_str().is_empty() {
            self.start.project = std::env::var_os("HOME").ok_or("no HOME")?.into();
        }
        self.project = fs::canonicalize(&self.start.project).map_err(|e| e.to_string())?;
        if !self.project.is_dir() {
            return Err("project is not a directory".into());
        }
        // Ticket 990: a start in a recorded worktree (`agent start --project <worktree>`, the orchestration guide's way)
        // belongs to that worktree's project, as one the window starts there with `folder`. Without this the tree drew
        // the worker as a project of its own, named by the worktree's folder.
        // The record is read without worktrees.lock, so a start never waits on a create that holds it (v1a-23).
        let mut recorded = false;
        if self.folder.is_none()
            && !self.start.worktree
            && self.start.resume.is_none()
            && self.config.is_none()
            && let Some(project) =
                recorded_worktree_project(&self.home, &self.settings, &self.project)
        {
            self.folder = Some(std::mem::replace(&mut self.project, project));
            self.start.project = self.project.clone();
            recorded = true;
        }
        // v2-2a: the folder the override names is the one the tab runs in (a link swapped in since is refused).
        if let Some((_, folder)) = &self.config
            && (self.start.kind != AgentKind::Shell
                || self.start.worktree
                || &self.project != folder)
        {
            return Err("invalid account login launch".into());
        }
        // v2-2b: an account by label from the registry only; a resumed conversation keeps the account it ran on.
        if self.config.is_none() {
            let agent = crate::accounts::agent_of(self.start.kind);
            let chosen = match (&self.start.account, agent) {
                (None, _) => None,
                (Some(_), None) => {
                    return Err("an account is only for claude or codex sessions".into());
                }
                // Ticket 451: "Your own", named (absent keeps a resumed conversation's account).
                (Some(label), Some(_)) if label.is_empty() => None,
                (Some(label), Some(agent)) => {
                    Some(crate::accounts::folder_by_label(&self.home, agent, label)?)
                }
            };
            let folder = match (self.resume_config.take(), agent) {
                // Ticket 451 step 2: a resume that names another account continues the conversation there. Its record
                // is copied below, once the conversation id has been checked.
                (Some(prior), Some(_))
                    if self.start.account.is_some()
                        && prior.as_ref() != chosen.as_ref().map(|(folder, _)| folder) =>
                {
                    self.carry_from = Some(prior);
                    chosen
                }
                (Some(Some(prior)), Some(agent)) => {
                    Some(crate::accounts::folder_again(&self.home, agent, &prior)?)
                }
                _ => chosen,
            };
            if let Some(((folder, label), agent)) = folder.zip(agent) {
                self.config = Some((crate::accounts::variable(agent), folder));
                self.account = Some(label);
            }
        } else if self.start.account.is_some() {
            return Err("invalid account login launch".into());
        }
        if self
            .start
            .resume
            .as_deref()
            .is_some_and(|s| !store::valid_id(s))
        {
            return Err("invalid resume session id".into());
        }
        if let Some(prior) = self.carry_from.take() {
            if self.start.kind != AgentKind::Claude {
                return Err("continuing on another account is for Claude sessions for now".into());
            }
            let id = self
                .start
                .resume
                .as_deref()
                .ok_or("no conversation to continue")?;
            let from = crate::accounts::config_home(self.start.kind, prior.as_deref())
                .ok_or("HOME missing")?;
            let to = crate::accounts::config_home(
                self.start.kind,
                self.config.as_ref().map(|(_, folder)| folder.as_path()),
            )
            .ok_or("HOME missing")?;
            crate::account_carry::claude(&from, &to, id)?;
        }
        self.id = store::new_id()?;
        self.cwd = self.project.clone();
        if let Some(folder) = &self.folder {
            if self.start.worktree || self.start.resume.is_some() {
                return Err("folder cannot be combined with worktree or resume".into());
            }
            self.cwd = if recorded {
                folder.clone()
            } else {
                managed_start_folder(&self.home, &self.settings, &self.project, folder)?
            };
        } else if let Some(cwd) = self.resume_cwd.clone() {
            self.cwd = cwd;
        } else if self.start.worktree {
            let repo = self.project.file_name().ok_or("invalid repository name")?;
            let root = self.settings.worktree_root_for(&self.project)?;
            let parent = worktree_parent(&root, repo, self.settings.default_base().as_deref())?;
            // Security (ticket 1061): the resolved folder, so a link swapped in after check_token_reach is still caught.
            if self.origin.is_some() {
                tokens::outside_home(&self.home, &parent)?;
            }
            self.cwd = start_worktree::folder(&parent, &self.id);
            self.worktree_created = true;
            // Ticket 403 item 4: the same checkout helper as a create.
            let cwd = self.cwd.to_string_lossy();
            let (base, branch) = start_worktree::target(&self.project, &self.cwd);
            let add = ["worktree", "add", "-b", &branch, "--", &cwd, &base];
            crate::process::git_worktree_add(&self.project, &add, GIT_WORKTREE)
                .map_err(|e| format!("worktree start failed: {e}"))?;
            self.cwd = fs::canonicalize(&self.cwd).map_err(|e| e.to_string())?;
        }
        self.version = match self.start.kind {
            AgentKind::Shell => None,
            AgentKind::Claude => {
                let program = agent_program("claude", self.command.as_ref());
                self.version_of(&program)?
            }
            AgentKind::Codex => {
                let program = agent_program("codex", self.command.as_ref());
                self.version_of(&program)?
            }
            AgentKind::Acp => None, // V2-4a
        };
        // v1b-11: HEAD of the folder the agent runs in, read here because prepare runs off the lock.
        self.start_commit = Some(crate::diff::start(&self.cwd));
        // Ticket 362: read here, off the lock. The row's reason needs it for every Claude session, owner's or not.
        let limits = if self.start.kind == AgentKind::Claude {
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            crate::agent_permission::claude_limits(config, &self.cwd)
        } else {
            Default::default()
        };
        self.bypass_disabled = limits.bypass_disabled;
        if self.start.kind == AgentKind::Claude {
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            self.ultracode = claude_modes::launched_ultracode(&self.start)
                .then_some(true)
                .or_else(|| crate::agent_permission::claude_ultracode(config, &self.cwd));
        }
        // Ticket 991 (B6 chip): a Codex start says its own mode below; a resumed row's earlier one is not this start's.
        if self.start.kind == AgentKind::Codex {
            self.ran_mode = None;
        }
        // Ticket 1002 lane 1 (owner E1, E2): a Claude seat in the Home folder, or a start that carries the lock, runs in the
        // Settings > Assistants mode with the lock's deny list and hook, on every path (window, resume, schedule, lead,
        // a session's child). A resume takes the chosen mode, never the footer's last one.
        let in_home = crate::home_lock::in_home(&self.home, &self.cwd);
        self.home_lock |= self.start.kind == AgentKind::Claude && in_home;
        // Fable review R6: v1's Home seats are Claude only (a Codex or ACP seat there would sit unlocked in the locked
        // seat's room). A shell (the owner's own terminal there) stays.
        if in_home && matches!(self.start.kind, AgentKind::Codex | AgentKind::Acp) {
            return Err(
                "Home seats are Claude in v1 (the chief of staff's lock is for Claude seats)"
                    .into(),
            );
        }
        // Fable review R1a: every locked session is in the Home folder, so a child cannot edit a folder of its choice.
        if self.home_lock && !in_home {
            return Err("a session the chief of staff starts stays in the Home folder".into());
        }
        if self.home_lock {
            if self.start.kind != AgentKind::Claude {
                return Err("a Home seat starts only Claude sessions (they carry its lock)".into());
            }
            let side = self.start.args.iter().any(|a| a == SIDE_CHAT_ARG);
            let approved = match &self.command {
                Some(command) if self.owner && !side => command.args().to_vec(),
                _ => vec![],
            };
            if let Some(flag) = crate::home_lock::widening(&approved)
                .or_else(|| crate::home_lock::widening(&self.start.args).filter(|_| !side))
            {
                return Err(format!(
                    "{flag}: a Home seat runs with the mode in Settings > Assistants and its lock; this argument is not taken"
                ));
            }
            self.approved_args = approved;
            let user_home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            let user = crate::extensions::agent_servers(&user_home)
                .0
                .into_iter()
                .filter(|s| s.agent == "claude")
                .map(|s| s.name)
                .chain(crate::extensions::sealed_names(&self.home)) // owner R2: not loaded, denied too
                .collect();
            let servers = crate::home_lock::deny_servers(
                user,
                crate::extensions::claude_connectors(&user_home),
            );
            let stored = self.settings.features.get(crate::home_lock::MODE_KEY);
            let mode = match side {
                true => crate::home_lock::Mode::Ask, // its plan mode stays
                false => crate::home_lock::effective(crate::home_lock::mode(stored), self.owner),
            };
            let args = crate::home_lock::args(mode, &servers);
            self.permission = if side { args[2..].to_vec() } else { args };
            self.home_mode = Some(mode);
            self.ran_mode = (!side)
                .then(|| crate::agent_permission::claude_start_mode(&self.permission))
                .flatten()
                .map(String::from);
        } else if self.owner
            && let Some(agent) = crate::agent_permission::agent_key(self.start.kind)
        {
            let stored = self
                .settings
                .features
                .get(crate::agent_permission::FEATURE_KEY);
            let side = self.start.args.iter().any(|a| a == SIDE_CHAT_ARG);
            // Owner starts only, as with the stored permission: an approved argument may be a skip flag, which a session
            // caller's child must not reach (`reaches_skip`), and a side chat stays read-only.
            if !side && let Some(command) = &self.command {
                self.approved_args = command.args().to_vec();
            }
            let choice = crate::agent_permission::stored_choice(stored, agent);
            let user = [&self.approved_args[..], &self.start.args[..]].concat();
            let resumed = self
                .ran_mode
                .as_deref()
                .filter(|_| self.start.kind == AgentKind::Claude && !side)
                .and_then(|ran| {
                    crate::agent_permission::claude_resume_args(ran, choice, &user, limits)
                });
            self.permission = resumed.unwrap_or_else(|| {
                crate::agent_permission::launch_args(self.start.kind, choice, &user, side, limits)
            });
            if self.start.kind == AgentKind::Codex && !side {
                self.ran_mode =
                    crate::agent_permission::codex_mode(choice, &user).map(String::from);
            }
            // Look 1117 v9 N-S3-3: a new Claude start names its mode before the first footer (a trust question, then a
            // turn, can hide it for the whole first turn).
            if self.start.kind == AgentKind::Claude && !side && self.ran_mode.is_none() {
                self.ran_mode =
                    crate::agent_permission::claude_start_mode(&self.permission).map(String::from);
            }
        }
        self.read_codex_sandbox();
        Ok(self)
    }
    /// Q9 en-b-J7-1: canonical path, ancestor stats and config reads; a hung mount must not hold the registry lock.
    pub(super) fn read_codex_sandbox(&mut self) {
        if self.start.kind == AgentKind::Codex {
            let args = [
                &self.permission[..],
                &self.approved_args[..],
                &self.start.args[..],
            ]
            .concat();
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            self.codex_read_only = Some(crate::codex_sandbox::read_only(&args, &self.cwd, config));
            self.codex_hooks_clear = (self.start.args.is_empty() && self.approved_args.is_empty())
                .then(|| codex_hooks_exclusive(&self.cwd, &self.project, config));
        }
    }
}
impl Drop for Launch {
    fn drop(&mut self) {
        if self.committed {
            // Ticket 573: a `--worktree` start's folder is a worktree created, as `worktree create`'s is.
            if self.worktree_created {
                crate::events::worktree("created", &self.project, &self.cwd);
            }
            return;
        }
        let _ = fs::remove_file(self.home.join(format!("hooks-{}.json", self.id)));
        if self.worktree_created {
            let cwd = self.cwd.to_string_lossy();
            let remove = ["worktree", "remove", "--force", "--", &cwd];
            if let Err(e) =
                crate::process::git_worktree_remove(&self.project, &self.cwd, &remove, GIT_WORKTREE)
            {
                eprintln!("worktree rollback failed: {e}");
            }
        }
    }
}
/// Ticket 595: what `agent start --env` may set, as an allow list (ticket 573's deny list missed any name nobody thought
/// of, such as `SSL_CERT_FILE` or `PERL5OPT`). The 11-14 survey found no guide, skill, spec or loop script passing any
/// name; the list is the task context a lead hands a worker (`TASK_*`, `LANE_*`) and the log, colour, CI and locale
/// names a test run reads. A secret word is refused even inside those prefixes. cmux takes any name; this does not.
pub(crate) fn check_start_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    const ALLOW: &[&str] = &[
        "RUST_LOG",
        "RUST_BACKTRACE",
        "NO_COLOR",
        "FORCE_COLOR",
        "CI",
        "TZ",
        "LANG",
        "LC_ALL",
    ];
    const ALLOW_PREFIX: &[&str] = &["TASK_", "LANE_", "CLAUDE_CODE_EXPERIMENTAL_"];
    if env.len() > 64 {
        return Err("at most 64 --env values".into());
    }
    for (key, value) in env {
        let upper = key.to_ascii_uppercase();
        let well_formed = key.len() <= 128
            && key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !well_formed || value.len() > 4096 || value.contains('\0') {
            return Err(format!("--env {key}: invalid name or value"));
        }
        if ["TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL", "AUTH"]
            .iter()
            .any(|word| upper.contains(word))
            || crate::start_secrets::is_secret(key)
        {
            return Err(format!("--env {key}: secrets are not passed this way"));
        }
        if !ALLOW.contains(&upper.as_str()) && !ALLOW_PREFIX.iter().any(|p| upper.starts_with(p)) {
            return Err(format!(
                "--env {key}: not on the allow list (TASK_*, LANE_*, CLAUDE_CODE_EXPERIMENTAL_*, RUST_LOG, RUST_BACKTRACE, NO_COLOR, FORCE_COLOR, CI, TZ, LANG, LC_ALL); pass task context as a TASK_ name, or ask the owner to add the name (docs/cli.md)"
            ));
        }
    }
    Ok(())
}
/// Ticket 362: launch args that put Claude in Skip permissions or in reach of it. `--settings` counts: such a file can set
/// `permissions.defaultMode`.
pub(super) fn reaches_skip(args: &[String]) -> bool {
    args.iter().enumerate().any(|(i, a)| {
        a.starts_with(ALLOW_SKIP)
            || a.starts_with(START_IN_SKIP)
            || a == "--settings"
            || a.starts_with("--settings=")
            || a == "--permission-mode=bypassPermissions"
            || a == "--permission-mode" && args.get(i + 1).is_some_and(|m| m == "bypassPermissions")
    })
}
/// Ticket 362: the Codex half of `reaches_skip`: launch args that turn off its approvals or its sandbox.
pub(super) fn reaches_codex_bypass(args: &[String]) -> bool {
    let next = |i: usize| args.get(i + 1).map(String::as_str);
    args.iter().enumerate().any(|(i, a)| match a.as_str() {
        "--dangerously-bypass-approvals-and-sandbox"
        | "--yolo"
        | "--full-auto"
        | "--ask-for-approval=never"
        | "-a=never"
        | "-anever"
        | "--sandbox=danger-full-access"
        | "-s=danger-full-access"
        | "-sdanger-full-access" => true,
        "-a" | "--ask-for-approval" => next(i) == Some("never"),
        "-s" | "--sandbox" => next(i) == Some("danger-full-access"),
        // Q9 tt-J5-1: `-c approval_policy=never` and `-c sandbox_mode=danger-full-access` (also `--config`, `=` or
        // attached, a quoted key or value, a profile's key) set the same through Codex's config overrides.
        "-c" | "--config" => next(i).is_some_and(bypass_override),
        a => a
            .strip_prefix("--config=")
            .or_else(|| {
                a.strip_prefix("-c")
                    .map(|v| v.strip_prefix('=').unwrap_or(v))
            }) // `-c=k=v` as `-a=never`
            .is_some_and(bypass_override),
    })
}
/// One `-c key=value` override that turns off Codex's approvals or its sandbox. The value is read as Codex reads it: a
/// TOML value (escapes, an inline table such as `profiles={x={approval_policy="never"}}`), else the bare text.
fn bypass_override(kv: &str) -> bool {
    // The whole override as one TOML line decodes a quoted or escaped key (`"approval\u005fpolicy"="never"`) and dotted
    // keys; a bare value (`never`) does not parse as TOML and is read below.
    if kv
        .parse::<toml::Table>()
        .is_ok_and(|doc| doc.iter().any(|(k, v)| bypasses(k, v)))
    {
        return true;
    }
    let Some((key, value)) = kv.split_once('=') else {
        return false;
    };
    let value = value.trim();
    let value = format!("v = {value}")
        .parse::<toml::Table>()
        .ok()
        .and_then(|mut t| t.remove("v"))
        .unwrap_or_else(|| toml::Value::String(value.into()));
    let key = key.rsplit('.').next().unwrap_or_default();
    bypasses(key.trim().trim_matches(['"', '\'']), &value)
}
fn bypasses(key: &str, value: &toml::Value) -> bool {
    match value {
        toml::Value::String(v) => matches!(
            (key, v.as_str()),
            ("approval_policy", "never") | ("sandbox_mode", "danger-full-access")
        ),
        toml::Value::Table(table) => table.iter().any(|(k, v)| bypasses(k, v)),
        _ => false,
    }
}
