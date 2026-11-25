//! Starting a session: the caller's launch, the start itself and the folder probes of a refused start.
use super::*;
impl Sessions {
    pub fn launch(&self, start: StartSession) -> Launch {
        let project = fs::canonicalize(&start.project).ok();
        let prior = start.resume.as_ref().and_then(|id| {
            self.entries.values().find(|e| {
                e.meta.kind == start.kind
                    && e.meta.agent_session_id.as_ref() == Some(id)
                    && Some(&e.meta.project) == project.as_ref()
            })
        });
        let start_resume_cwd = prior.map(|e| e.meta.cwd.clone()).filter(|cwd| cwd.is_dir());
        let resume_config = prior.map(|e| e.meta.config_dir.clone()); // v2-2b
        let ran_mode = prior.and_then(|e| e.meta.ran_mode.clone());
        let home_lock = prior
            .into_iter()
            .chain(side_parent(&start).and_then(|p| self.entries.get(&p)))
            .any(|e| e.meta.home_lock);
        Launch {
            home: self.home.clone(),
            settings: self.settings.clone(),
            start,
            id: String::new(),
            project: PathBuf::new(),
            cwd: PathBuf::new(),
            version: None,
            version_probe: Default::default(), // V1A-89
            worktree_created: false,
            committed: false,
            codex_read_only: None,
            codex_hooks_clear: None,
            ultracode: None,
            // v1a-09: a resumed conversation lives in the folder it ran in (a worktree), not the project's.
            folder: None,
            resume_cwd: start_resume_cwd,
            start_commit: None, // v1b-11
            config: None,       // v2-2a
            resume_config,      // v2-2b
            carry_from: None,
            account: None,        // v2-2b
            without_hooks: false, // v2-5b
            no_history: false,
            account_tab: false,
            owner: false,
            owner_terminal: false,
            home_lock,
            home_mode: None,
            permission: vec![],
            ran_mode,
            command: None,
            approved_args: vec![],
            bypass_disabled: false,
            env: BTreeMap::new(),
            origin: None,
        }
    }
    /// ACCOUNTPICK: a session caller (token or remote) starts sessions on its own session's account only: none given
    /// means the caller's; another label is refused before anything is created. The owner (`None`) picks any; none
    /// given means the owner's default (ticket 1126).
    /// `remote`: as in `start_granted`.
    pub(crate) fn launch_as(
        &self,
        caller: Option<&crate::grants::Caller>,
        mut start: StartSession,
        remote: bool,
    ) -> Result<Launch, String> {
        if let Some(caller) = caller {
            let own = self.caller_account(caller, remote);
            match &start.account {
                Some(label)
                    if Some(label) != own.as_ref()
                        && Some(label) != self.place_account(caller, remote).as_ref()
                        && Some(label)
                            != self.default_account(start.kind, remote).flatten().as_ref()
                        && !self.lead_any(caller, remote) =>
                {
                    return Err("a session can start sessions only on its own account".into());
                }
                // Ticket 451 (security look, reproduced): naming its own account on a resume would carry a conversation
                // that ran on another account into the caller's. Only the owner continues a conversation elsewhere.
                Some(_)
                    if start.resume.as_ref().is_some_and(|id| {
                        self.entries.values().any(|e| {
                            e.meta.agent_session_id.as_ref() == Some(id) && e.meta.account != own
                        })
                    }) =>
                {
                    return Err("a session can start sessions only on its own account".into());
                }
                // A resume keeps the account it ran on; `start_granted` checks that it is the caller's.
                // V2-4a (needs 87): an ACP session has no account.
                // Ticket 1126: a new one starts on its place's account (1120) where its agent has one by that label,
                // else on the owner's default (an explicit "Your own" is no label), else on the caller's own.
                None if !matches!(start.kind, AgentKind::Shell | AgentKind::Acp)
                    && start.resume.is_none() =>
                {
                    let agent = crate::accounts::agent_of(start.kind);
                    start.account = self
                        .place_account(caller, remote)
                        .filter(|l| {
                            agent.is_some_and(|a| {
                                crate::accounts::folder_by_label(&self.home, a, l).is_ok()
                            })
                        })
                        .map(Some)
                        .or_else(|| self.default_account(start.kind, remote))
                        .unwrap_or(own);
                }
                _ => {}
            }
        } else if start.account.is_none()
            && start.resume.is_none()
            && !matches!(start.kind, AgentKind::Shell | AgentKind::Acp)
        {
            // Codex security look P2 (1126 round 3): the owner's start with no account named (`session start`, a
            // schedule, a team start) takes the status bar's pick too. The window names its account itself.
            start.account = self.default_account(start.kind, remote).flatten();
        }
        self.check_side_resume(&start)?;
        let mut launch = self.launch(start);
        launch.origin = caller.and_then(|c| self.token_of(c));
        // Ticket 1002 lane 1 (check MUST 1): a session a locked one starts, in any folder, is locked too.
        launch.home_lock |= caller
            .and_then(|c| self.entries.get(&c.id))
            .is_some_and(|e| e.meta.home_lock);
        Ok(launch)
    }
    fn check_side_resume(&self, start: &StartSession) -> Result<(), String> {
        if let Some(resume) = &start.resume
            && self.entries.values().any(|entry| {
                entry.meta.side_chat && entry.meta.agent_session_id.as_ref() == Some(resume)
            })
        {
            return Err("Side chat is temporary; open a new side chat".into());
        }
        Ok(())
    }
    pub fn start(&mut self, launch: &Launch) -> Result<Session, String> {
        // Ticket 1122 B: a start served after the Stop (the window's, in the stop's wake) spawned a holder the stopped
        // core never stops; it outlived the core and wrote into the data folder.
        if self.stopped() {
            return Err("core is stopping; nothing starts".into());
        }
        self.check_side_resume(&launch.start)?;
        let (command, account) = self.start_checks(launch)?; // claude_modes.rs, also a restart's before it stops
        self.refresh()?;
        // Ticket 286 S3: the parent's agent, not its row: never from a shell left after the agent quit.
        if let Some(parent) = side_parent(&launch.start)
            && !self
                .entries
                .get(&parent)
                .is_some_and(|e| self.agent_running(e))
        {
            return Err("Side chat parent is not running".into());
        }
        // Ticket 1002 lane 1: a Home seat, or a session a locked one started, runs only as a Claude start with the lock
        // `prepare` built; a path that skipped it is refused here, under the lock that starts.
        let claude = launch.start.kind == AgentKind::Claude;
        if (launch.home_lock || (claude && crate::home_lock::in_home(&self.home, &launch.cwd)))
            && !(claude
                && launch.home_mode.is_some()
                && crate::home_lock::locked(&launch.permission))
        {
            return Err(if claude {
                "the Home seat lock is missing from this start".into()
            } else {
                "a Home seat starts only Claude sessions (they carry its lock)".into()
            });
        }
        if launch.start.kind == AgentKind::Acp {
            return self.spawn_acp(launch); // V2-4a
        }
        if self.entries.values().filter(|e| e.pty.is_some()).count() >= 32 {
            return Err("maximum 32 retained PTYs; close an exited session first".into());
        }
        let session = self.spawn(
            &launch.id,
            &launch.project,
            &launch.cwd,
            &launch.start,
            launch.version.clone(),
            launch.start_commit.clone(), // v1b-11
            launch.config.as_ref(),      // v2-2a
            account,                     // v2-2b
            launch.without_hooks,        // v2-5b
            launch.no_history,
            launch.account_tab,
            &launch.permission,
            launch.bypass_disabled,
            command.as_ref(),
            &launch.approved_args,
            &launch.env,
            launch.origin.clone(),
            launch.codex_read_only,
            launch.codex_hooks_clear,
            launch
                .home_mode
                .filter(|_| launch.start.kind == AgentKind::Claude),
            launch.owner || launch.owner_terminal, // ticket 1008 round 2
            launch.ultracode,
        )?;
        self.entry(&session.id)?.version_probe = launch.version_probe.take(); // V1A-89
        if launch.start.resume.is_some() {
            self.merge_yes_on_resume(&session.id);
        }
        // Look 11-17 v3 P5: a resume knows its mode before Claude draws its footer.
        self.entry(&session.id)?.meta.ran_mode = launch.ran_mode.clone();
        // Ticket 991 (B6 chip): Codex draws no footer to read it from again, so it is stored now.
        if launch.start.kind == AgentKind::Codex && launch.ran_mode.is_some() {
            if let Err(e) = self.save() {
                eprintln!("start {}: permission mode not saved: {e}", session.id);
            }
            let meta = self.entry(&session.id)?.meta.clone();
            return Ok(self.snapshot_session(&meta));
        }
        Ok(session)
    }
}
// v1a-33: how long a new session's folder probe may take before the session reads as blocked. macOS file access
// (Removable Volumes, Desktop, Documents, Downloads) refuses with EPERM or, for an app-started core, never answers.
pub(crate) const PROBE_BOUND: std::time::Duration = std::time::Duration::from_secs(2);
pub(super) const PROBES_MAX: usize = 32;
pub(super) type Probes = std::sync::Arc<std::sync::atomic::AtomicUsize>;
/// The one probe count of the process: session starts and refused starts (`refused_start`) both count against it.
pub(super) fn shared_probes() -> &'static Probes {
    static PROBES: std::sync::OnceLock<Probes> = std::sync::OnceLock::new();
    PROBES.get_or_init(Default::default)
}
/// Frees a probe's slot when its thread ends (a panic included), or when no thread was spawned.
struct ProbeSlot(Probes);
impl Drop for ProbeSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
pub(super) enum ProbeSkip {
    Full,
    NoThread,
}
/// Probes `folder` off this thread if `probes` has room (at most PROBES_MAX threads not yet answered). A probe stuck
/// in open() cannot be cancelled: it parks its thread, and its slot, until the folder answers or the core exits.
// shortcut: a shared prober thread would bound this at one; move to it if starts into such folders get frequent.
pub(super) fn spawn_probe(
    probes: &Probes,
    probe: fn(&Path) -> std::io::Result<()>,
    folder: &Path,
) -> Result<std::sync::mpsc::Receiver<std::io::Result<()>>, ProbeSkip> {
    let taken = probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let slot = ProbeSlot(probes.clone());
    if taken >= PROBES_MAX {
        return Err(ProbeSkip::Full);
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let folder = folder.to_path_buf();
    // A thread the OS refuses only skips the probe (the closure and its slot drop); a panic here would poison the lock.
    std::thread::Builder::new()
        .name("folder-probe".into())
        .spawn(move || {
            let _slot = slot;
            let _ = sender.send(probe(&folder));
        })
        .map(|_| receiver)
        .map_err(|_| ProbeSkip::NoThread)
}
/// F15: the refusal prefix of a start whose folder the agent could not enter (web/src/PermissionNeeded.tsx). The rest
/// starts with `FILE_MODE` for a folder whose owner or mode refuses (EACCES), else it is macOS privacy (EPERM, no answer).
pub(crate) const FILE_ACCESS: &str = "file_access:";
pub(crate) const FILE_MODE: &str = "file_access: no permission to read";
/// F15: a refused start, as the window is told it and one core.log line. Called off the registry lock: the folder probe
/// waits at most `PROBE_BOUND`, and one that does not answer is the macOS privacy case (an app-started core's TCC wait).
pub(crate) fn refused_start(
    probe: fn(&Path) -> std::io::Result<()>,
    kind: AgentKind,
    cwd: &Path,
    e: String,
) -> String {
    refused_start_capped(shared_probes(), probe, kind, cwd, e)
}
pub(super) fn refused_start_capped(
    probes: &Probes,
    probe: fn(&Path) -> std::io::Result<()>,
    kind: AgentKind,
    cwd: &Path,
    e: String,
) -> String {
    // The probe counts against the starts' cap. A full cap spawns nothing and reads as a probe that did not answer;
    // a thread the OS refuses only skips the probe.
    let answer = match spawn_probe(probes, probe, cwd) {
        Ok(receiver) => receiver
            .recv_timeout(PROBE_BOUND)
            .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into())),
        Err(ProbeSkip::Full) => Err(std::io::ErrorKind::TimedOut.into()),
        Err(ProbeSkip::NoThread) => Ok(()),
    };
    let e = match answer {
        Err(f) if f.raw_os_error() == Some(libc::EACCES) => {
            format!("{FILE_MODE} {}: {e}", cwd.display())
        }
        Err(f)
            if matches!(
                f.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::TimedOut
            ) =>
        {
            format!("{FILE_ACCESS} cannot read {}: {e}", cwd.display())
        }
        _ => e,
    };
    // One log line: a newline in the folder or the reason must not start a second one.
    let line = format!("start refused: {kind:?} in {}: {e}", cwd.display());
    eprintln!("{}", escape_line(&line));
    e
}
pub(super) fn escape_line(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
pub(crate) fn probe_folder(path: &Path) -> std::io::Result<()> {
    fs::read_dir(path)?.next().transpose().map(|_| ())
}
