//! Accounts as sessions use them: labels after a rename, logout tabs, and which account a start runs on.
use super::*;
impl Sessions {
    /// Ticket 358: every session on account `folder`, and its own Login and Logout tabs, now carry the name `to`. Matched
    /// by folder, never by the old name, so a row a crash left on an earlier name is put right too.
    pub(crate) fn account_relabel(&mut self, folder: &Path, to: &str) {
        for meta in self.entries.values_mut().map(|e| &mut e.meta) {
            if meta.config_dir.as_deref() == Some(folder) {
                meta.account = Some(to.into());
            }
            if meta.account_tab && meta.project == folder {
                for word in ["Login", "Logout"] {
                    if meta.label.starts_with(&format!("{word}: ")) {
                        meta.label = format!("{word}: {to}");
                    }
                }
            }
        }
    }
    /// Ticket 358: an account's new name reaches what the sessions keep. A failed save puts `old` back.
    pub(crate) fn account_renamed(
        &mut self,
        folder: &Path,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        self.account_relabel(folder, new);
        let saved = self.save();
        if saved.is_err() {
            self.account_relabel(folder, old);
        }
        saved
    }
    /// Ticket 76: remember the logout tab of `folder` across a core restart.
    pub(crate) fn logout_mark(&mut self, folder: &Path, tab: &str) {
        self.logouts.insert(folder.into(), tab.into());
        self.save_logouts();
    }
    pub(crate) fn logout_clear(&mut self, folder: &Path) {
        if self.logouts.remove(folder).is_some() {
            self.save_logouts();
        }
    }
    // The tab already started (or the account moved), so a write error cannot refuse anything: print it.
    fn save_logouts(&self) {
        let bytes = serde_json::json!({"version": 1, "logouts": self.logouts}).to_string();
        if let Err(e) = store::atomic_write(&self.home.join("logouts.json"), bytes.as_bytes()) {
            eprintln!("logouts.json not saved: {e}");
        }
    }
    /// A missing file is empty; an unreadable, wrong-version or malformed one is empty and counted.
    pub(super) fn load_logouts(home: &Path) -> (BTreeMap<PathBuf, String>, usize) {
        #[derive(serde::Deserialize)]
        struct File {
            version: u32,
            logouts: BTreeMap<PathBuf, String>,
        }
        match fs::read(home.join("logouts.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (BTreeMap::new(), 0),
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(file) if file.version == 1 => (file.logouts, 0),
                _ => (BTreeMap::new(), 1),
            },
            Err(_) => (BTreeMap::new(), 1),
        }
    }
    /// Ticket 1120: the account the user set for the caller's place (`nunchiro task account`, `ledger::Place`). A
    /// session of that place may start sessions on it as on its own (ACCOUNTPICK widened by the user, per place); a
    /// remote caller never.
    pub(super) fn place_account(
        &self,
        caller: &crate::grants::Caller,
        remote: bool,
    ) -> Option<String> {
        if remote {
            return None;
        }
        let place = self.task_caller(Some(caller), None).ok()?.place?;
        crate::ledger::Ledger::open(&self.home)
            .place(&place)
            .account
    }
    /// Owner 2026-11-25 ("적용하고"): with "Leads may use any of my accounts" on (`accounts::LEADS_ANY`), a team lead's own
    /// seat may start sessions on any registered account and continue itself on one (ticket 451 carry). Never a session
    /// under a lead (a worker or reviewer), a remote caller, an outside token or an ACP session.
    pub(super) fn lead_any(&self, caller: &crate::grants::Caller, remote: bool) -> bool {
        !remote
            && self.token_of(caller).is_none()
            && self.settings.feature::<bool>(crate::accounts::LEADS_ANY) == Some(true)
            && self.entries.get(&caller.id).is_some_and(|e| {
                matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
                    && e.meta.teammate.is_some()
                    && self.team_lead_of(&caller.id) == e.meta.teammate
            })
    }
    /// The room line of a start or move that only `lead_any` admitted, in the lead's place, to the lead. Written
    /// before the start; an error refuses it.
    pub(super) fn lead_any_line(
        &self,
        caller: &crate::grants::Caller,
        launch: &Launch,
        account: &str,
    ) -> Result<(), String> {
        let refused = |why: &str| format!("a start on another account needs its room line ({why})");
        let lead = self
            .team_lead_of(&caller.id)
            .ok_or_else(|| refused("no lead"))?;
        let team = crate::team::Team::open(&self.home);
        let mate = team
            .list()
            .ok()
            .and_then(|l| l.into_iter().find(|t| t.id == lead))
            .ok_or_else(|| refused("the lead is not in the team"))?;
        let label = match launch.start.label.as_str() {
            "" => "a session",
            l => l,
        };
        let place = mate.project.clone().unwrap_or_else(|| team.home());
        let moved = launch.start.resume.is_some()
            && launch.start.resume
                == self
                    .entries
                    .get(&caller.id)
                    .and_then(|e| e.meta.agent_session_id.clone());
        let line = if moved {
            format!(
                "{} continues itself on account {account} (Leads may use any of my accounts)",
                mate.name
            )
        } else {
            format!(
                "{} starts {label} on account {account} (Leads may use any of my accounts)",
                mate.name
            )
        };
        let note = crate::advance::team_note(&line, None);
        crate::room::Log::open(&self.home, &place)
            .team(&lead, line, note)
            .map(|_| ())
            .map_err(|e| refused(&e))
    }
    /// Ticket 1126: the owner's default account for new sessions of `kind` (`accounts::default_label`); a session caller
    /// may start on it as on its own. A remote caller never gets it, as it never gets a place account.
    pub(super) fn default_account(&self, kind: AgentKind, remote: bool) -> Option<Option<String>> {
        if remote {
            return None;
        }
        crate::accounts::default_pick(&self.home, crate::accounts::agent_of(kind)?)
    }
    /// The account label of the caller's own session. A remote caller chooses its id (it may be a local session's), so
    /// it never has one: it counts as "Your own".
    pub(super) fn caller_account(
        &self,
        caller: &crate::grants::Caller,
        remote: bool,
    ) -> Option<String> {
        if remote {
            return None;
        }
        self.entries
            .get(&caller.id)
            .and_then(|e| e.meta.account.clone())
    }
    /// V2-2d: the sessions on account folder `folder`: the labels of those that block its removal (live or resumable on
    /// it, or running inside it, as its login and logout tabs do), and how many others (closed, or ended without a
    /// conversation to resume) lose their history with it.
    pub(crate) fn account_users(&self, folder: &Path) -> (Vec<String>, usize) {
        let mut blocking = vec![];
        let mut others = 0;
        // V2-6d: a close-pending row can still come back by Undo, so it counts like `snapshot` shows it.
        let pending = self.closing.as_ref().map(|c| &c.entry);
        for (meta, closing) in self
            .entries
            .values()
            .map(|e| (&e.meta, false))
            .chain(pending.map(|e| (&e.meta, true)))
        {
            let on = meta.config_dir.as_deref() == Some(folder);
            let live = meta.state == SessionState::Running;
            let inside = meta.cwd.starts_with(folder) || meta.project.starts_with(folder);
            if (on || live && inside)
                && (live
                    || meta.state != SessionState::Closed
                        && resumable(meta) == SessionState::Resumable)
            {
                let name = if meta.label.is_empty() {
                    &meta.id
                } else {
                    &meta.label
                };
                blocking.push(if closing {
                    format!("{name} (closing, Undo window)")
                } else {
                    name.clone()
                });
            } else if on {
                others += 1;
            }
        }
        (blocking, others)
    }
    /// V2-2a: an account's login tab. The override is set here only, never from a `StartSession`.
    pub(crate) fn launch_account(
        &self,
        start: StartSession,
        variable: &'static str,
        folder: PathBuf,
    ) -> Launch {
        let mut launch = self.launch(start);
        launch.config = Some((variable, folder));
        launch
    }
}
