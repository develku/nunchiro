//! Remote machines: saved aliases, forwarding rights and the remote children this registry owns.
use super::*;

/// Stop this alias' master off the registry lock, then persist removal under it.
pub(crate) fn forget_machine(registry: &std::sync::Mutex<Sessions>, alias: &str) -> Response {
    crate::machines::valid_alias(alias)?;
    {
        let mut s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        s.check_machine_forget(alias)?;
        if !s.remote.forgetting.insert(alias.into()) {
            return Err("machine is already being forgotten".into());
        }
        if let Some(cancel) = s.remote.cancel.get(alias) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let mut s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if !s.remote.refreshing.contains(alias) {
            let result = s.forget_machine(alias);
            s.remote.forgetting.remove(alias);
            return result;
        }
        if std::time::Instant::now() >= until {
            s.remote.forgetting.remove(alias);
            return Err("machine channel is still closing; retry removal".into());
        }
        drop(s);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
impl Sessions {
    // v1a-06
    pub(crate) fn remote_home(&self) -> PathBuf {
        self.home.clone()
    }
    // v1a-06: the local registry is the authority for remote children.
    pub(crate) fn remote_owned(
        &self,
        caller: &crate::grants::Caller,
        alias: &str,
        id: &str,
    ) -> bool {
        self.remote
            .children
            .get(&(alias.into(), id.into()))
            .is_some_and(|c| c.parent == caller.id)
    }
    pub(crate) fn machine_details(
        &self,
        alias: Option<String>,
    ) -> Result<
        Vec<(
            String,
            crate::machines::Config,
            Option<crate::machines::Channel>,
        )>,
        String,
    > {
        let aliases = self.remote_aliases(crate::machines::known(&self.home)?);
        if let Some(alias) = &alias {
            crate::machines::valid_alias(alias)?;
            if !aliases.contains(alias) {
                return Err("machine alias is not listed".into());
            }
        }
        Ok(aliases
            .into_iter()
            .filter(|a| alias.as_ref().is_none_or(|one| one == a))
            .map(|a| {
                let config = self.settings.machines.get(&a).cloned().unwrap_or_default();
                let channel = self.remote.channels.get(&a).cloned();
                (a, config, channel)
            })
            .collect())
    }
    pub(super) fn add_machine(
        &mut self,
        alias: String,
        host: String,
        user: Option<String>,
        port: Option<u32>,
        replace: bool,
    ) -> Response {
        crate::machines::valid_alias(&alias)?;
        crate::machines::discovery::validate(&host, user.as_deref(), port)?;
        let listed = self
            .remote_aliases(crate::machines::known(&self.home)?)
            .contains(&alias);
        if replace && !listed {
            return Err("machine alias is not listed".into());
        }
        if !replace && (listed || self.remote.refreshing.contains(&alias)) {
            return Err("machine alias already listed or closing".into());
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut machines: BTreeMap<String, crate::machines::Config> = match file.get("machines") {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("invalid machines settings: {e}"))?,
            None => BTreeMap::new(),
        };
        if !replace && machines.contains_key(&alias) {
            return Err("machine alias already listed".into());
        }
        let old = machines.get(&alias).cloned().unwrap_or_default();
        // An edit that changes nothing writes nothing. A changed one is read at the next connection
        // (`discovery::options`); the open channel and its sessions stay.
        if replace && (old.host.as_ref(), &old.user, old.port) == (Some(&host), &user, port) {
            return Ok(Reply::Ack);
        }
        machines.insert(
            alias,
            crate::machines::Config {
                projects: old.projects,
                host: Some(host),
                user,
                port,
            },
        );
        file["machines"] = serde_json::to_value(&machines).map_err(|e| e.to_string())?;
        store::write_capped(
            &path,
            &serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?,
            store::SETTINGS_READ_MAX,
        )?;
        self.settings.machines = machines;
        Ok(Reply::Ack)
    }
    fn check_machine_forget(&self, alias: &str) -> Result<(), String> {
        crate::machines::valid_alias(alias)?;
        if self.remote.starting.contains_key(alias) {
            return Err("machine start in progress; retry removal".into());
        }
        if self
            .remote
            .cache
            .get(alias)
            .into_iter()
            .flatten()
            .any(|s| s.state == SessionState::Running)
            || self.entries.values().any(|e| {
                e.meta.machine.as_deref() == Some(alias) && e.meta.state == SessionState::Running
            })
        {
            return Err("Stop its sessions first".into());
        }
        Ok(())
    }
    fn forget_machine(&mut self, alias: &str) -> Response {
        self.check_machine_forget(alias)?;
        let mut known = crate::machines::known(&self.home)?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut machines: BTreeMap<String, crate::machines::Config> = match file.get("machines") {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("invalid machines settings: {e}"))?,
            None => BTreeMap::new(),
        };
        if !known.iter().any(|a| a == alias)
            && !machines.contains_key(alias)
            && !self.settings.machines.contains_key(alias)
        {
            return Err("machine alias is not listed".into());
        }
        machines.remove(alias);
        file["machines"] = serde_json::to_value(&machines).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        let remembered = self.home.join("machines.json");
        let previous = match crate::store::read_regular(&remembered) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        // A pinned key left behind would be trusted for the next machine saved under this alias. Removed before the
        // saves, so a failure here changes nothing; a failed save below writes it back, as the machine stays saved.
        let pin = crate::machines::share::known_hosts(&self.home, alias);
        let pinned = match crate::store::read_regular(&pin) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if pinned.is_some() {
            fs::remove_file(&pin).map_err(|e| e.to_string())?;
        }
        let restore = |e: String| match &pinned {
            Some(b) => match store::write_capped(&pin, b, store::READ_MAX) {
                Ok(()) => e,
                Err(r) => format!("{e}; pinned host key restore failed: {r}"),
            },
            None => e,
        };
        known.retain(|a| a != alias);
        // Remove remembered aliases first: a failed settings write rolls them back; memory changes only on success.
        store::write_capped(
            &remembered,
            &serde_json::to_vec(&serde_json::json!({"version":1,"machines":known}))
                .map_err(|e| e.to_string())?,
            store::READ_MAX,
        )
        .map_err(&restore)?;
        if let Err(e) = store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX) {
            if let Err(rollback) = match previous {
                Some(b) => store::write_capped(&remembered, &b, store::READ_MAX),
                None => fs::remove_file(&remembered).map_err(|e| e.to_string()),
            } {
                return Err(restore(format!(
                    "settings.json write failed: {e}; machines.json rollback failed: {rollback}; stores diverged"
                )));
            }
            return Err(restore(e));
        }
        self.settings.machines = machines;
        if let Some(cancel) = self.remote.cancel.get(alias) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.remote.channels.remove(alias);
        self.remote.cache.remove(alias);
        self.remote.unseen_starts.remove(alias);
        self.remote.answered.remove(alias);
        self.remote
            .children
            .retain(|(machine, _), _| machine != alias);
        Ok(Reply::Ack)
    }
    // v1a-06
    pub(crate) fn remote_aliases(&self, known: Vec<String>) -> Vec<String> {
        known
            .into_iter()
            .chain(self.settings.machines.keys().cloned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    // v1a-06
    pub(crate) fn remote_authorize(
        &mut self,
        caller: Option<&crate::grants::Caller>,
        alias: &str,
        request: &Request,
    ) -> Result<Request, String> {
        let Some(caller) = caller else {
            return Ok(request.clone());
        };
        let project = if let Request::Start { session, .. } = request {
            let mapped = self
                .settings
                .machines
                .get(alias)
                .and_then(|m| m.projects.get(&caller.project))
                .ok_or("remote project is not mapped for this caller")?;
            if !mapped.is_absolute() || &session.project != mapped {
                return Err("outside remote project mapping".into());
            }
            mapped.clone()
        } else if matches!(request, Request::List | Request::Snapshot) {
            self.settings
                .machines
                .get(alias)
                .and_then(|m| m.projects.get(&caller.project))
                .cloned()
                .ok_or("remote project is not mapped for this caller")?
        } else {
            let id = if let Request::Answer { item, answer, .. } = request {
                self.remote
                    .cache
                    .get(alias)
                    .into_iter()
                    .flatten()
                    .find(|s| s.pending.iter().any(|i| &i.id == item))
                    .map(|s| {
                        let decision = s.pending.iter().find(|i| &i.id == item).unwrap();
                        crate::grants::check_answer(
                            decision,
                            answer,
                            self.settings
                                .permission_answers
                                .get(&caller.project)
                                .copied()
                                .unwrap_or(false),
                        )
                        .map(|()| s.id.as_str())
                    })
                    .transpose()?
                    .ok_or("remote decision not found in grants")?
            } else {
                crate::grants::request_target(request).ok_or("remote operation not granted")?
            };
            if !self.remote_owned(caller, alias, id) {
                return Err("outside remote session grants".into());
            }
            self.remote
                .children
                .get(&(alias.into(), id.into()))
                .unwrap()
                .project
                .clone()
        };
        Ok(Request::Forwarded {
            caller: crate::machines::Caller {
                id: format!("{}-{}", self.remote_epoch, caller.id),
                project,
                permission_answers: self
                    .settings
                    .permission_answers
                    .get(&caller.project)
                    .copied()
                    .unwrap_or(false), // v1a-06
            },
            request: Box::new(request.clone()),
        })
    }
    // v1a-06
    pub(crate) fn remote_child(
        &mut self,
        alias: &str,
        caller: &crate::grants::Caller,
        session: &Session,
    ) {
        self.remote.children.insert(
            (alias.into(), session.id.clone()),
            crate::machines::Child {
                parent: caller.id.clone(),
                project: session.project.clone(),
            },
        );
    }
    // v1a-06: forwarding carries the LOCAL permission grant; never inherit remote user settings.
    fn remote_policy<T>(
        &mut self,
        caller: &crate::grants::Caller,
        f: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let enabled = self
            .remote
            .callers
            .get(&caller.id)
            .is_some_and(|c| c.permission_answers);
        // v1a-23: keeps the V1A-04 rule for this caller id. Ticket 32: a start decides by the request's own `remote`
        // flag instead (`launch_as`, `start_granted`), so a local token call of that id is never started as remote.
        self.grants.remote.insert(caller.id.clone());
        let previous = self
            .settings
            .permission_answers
            .insert(caller.project.clone(), enabled);
        let result = f(self);
        if let Some(previous) = previous {
            self.settings
                .permission_answers
                .insert(caller.project.clone(), previous);
        } else {
            self.settings.permission_answers.remove(&caller.project);
        }
        result
    }
    // v1a-06
    pub(crate) fn check_remote_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        self.remote_policy(caller, |s| s.check_agent(caller, request))
    }
    // v1a-06
    pub(crate) fn handle_remote_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: Request,
    ) -> Response {
        self.remote_policy(caller, |s| s.handle_agent(caller, request))
    }
}
