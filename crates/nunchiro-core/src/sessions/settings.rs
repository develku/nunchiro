//! Settings edits written to settings.json: quit settings, approvals, PR status, permissions, features.
use super::*;
impl Sessions {
    // v1a-09: edits the file as it is now (not the copy read at start), changes only the patched keys and keeps
    // any other key, then writes atomically; the running core follows only after the write succeeded.
    pub(crate) fn quit_settings(&mut self, patch: LifetimePatch) -> Response {
        let override_dir = self.home.join("skills/orchestration");
        let reply = |s: &Settings| {
            Ok(Reply::QuitSettings {
                settings: LifetimeSettings {
                    lifetime: s.session_lifetime,
                    start_at_login: s.start_at_login,
                    disable_hook_injection: s.disable_hook_injection,
                    keep_history: s.history().is_some(),
                    mask_history: s.mask_history,
                    auto_clean_worktrees: s.auto_clean_worktrees,
                    keep_awake: s.keep_awake,
                    script_widgets: s.script_widgets,
                    orchestration: s.orchestration,
                    orchestration_override: override_dir.clone(),
                    features: s.features.clone(),
                    worktrees_dir: s.worktrees_dir.clone(),
                    shell_env_error: crate::user_env::error(), // ticket 260
                    secret_env_names: crate::user_env::secret_names(), // ticket 1008
                },
            })
        };
        // The window's read on opening Settings: nothing to write.
        if patch.lifetime.is_none()
            && patch.start_at_login.is_none()
            && patch.disable_hook_injection.is_none()
            && patch.keep_history.is_none()
            && patch.mask_history.is_none()
            && patch.auto_clean_worktrees.is_none()
            && patch.keep_awake.is_none()
            && patch.script_widgets.is_none()
            && patch.orchestration.is_none()
            && patch.usage_allow_link.is_none()
            && patch.features.is_none()
            && patch.worktrees_dir.is_none()
        {
            return reply(&self.settings);
        }
        // Ticket 250: every feature key and value is checked before anything is written.
        for (k, v) in patch.features.iter().flatten() {
            if !feature_key(k) {
                return Err(format!(
                    "invalid feature key {k:?}: expected dotted lowercase, like terminal.scrollback_lines"
                ));
            }
            let size = serde_json::to_vec(v).map_err(|e| e.to_string())?.len();
            if size > FEATURE_VALUE_MAX {
                return Err(format!(
                    "feature {k} is {size} bytes; a value may be at most {FEATURE_VALUE_MAX} bytes"
                ));
            }
            // Ticket 992: a level's model and effort are what a session start would take.
            if k == crate::team::LEVELS_KEY && !v.is_null() {
                crate::team::check_levels(v, |kind, m, e| self.check_stored_model(kind, m, e))?;
            }
            if k == crate::team::WORKERS_KEY && !v.is_null() {
                crate::team::check_workers(v)?; // ticket 1055
            }
            if k == crate::home_lock::MODE_KEY {
                crate::home_lock::check(v)?; // ticket 1002 lane 1
            }
            if k == crate::home_lock::CONNECTORS_OFF_KEY {
                crate::home_lock::check_connectors_off(v)?;
            }
            // Ticket 456: an item that can run commands goes on only once the owner has read them.
            if k == crate::extensions::ENABLED_KEY {
                crate::extensions::check_enabled(
                    &crate::extensions::enabled(self.settings.feature(k)),
                    v,
                    patch.extensions_confirmed.as_deref().unwrap_or_default(),
                )?;
            }
            // Ticket 253: a shared path outside its project is refused here (and skipped at create).
            if k == crate::worktree_shared::FEATURE && !v.is_null() {
                crate::worktree_shared::check(v)?;
            }
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut next = self.settings.clone();
        if let Some(v) = patch.lifetime {
            next.session_lifetime = v;
            file["session_lifetime"] = serde_json::to_value(v).map_err(|e| e.to_string())?;
        }
        if let Some(v) = patch.start_at_login {
            next.start_at_login = v;
            file["start_at_login"] = v.into();
        }
        if let Some(v) = patch.disable_hook_injection {
            next.disable_hook_injection = v;
            file["disable_hook_injection"] = v.into();
        }
        // v1a-74
        if let Some(v) = patch.keep_history {
            next.keep_history = Some(v);
            file["keep_history"] = v.into();
        }
        if let Some(v) = patch.mask_history {
            next.mask_history = v;
            file["mask_history"] = v.into();
        }
        if let Some(v) = patch.auto_clean_worktrees {
            next.auto_clean_worktrees = v;
            file["auto_clean_worktrees"] = v.into();
        }
        if let Some(v) = patch.keep_awake {
            next.keep_awake = v;
            file["keep_awake"] = v.into();
        }
        if let Some(v) = patch.script_widgets {
            next.script_widgets = v;
            file["script_widgets"] = v.into();
        }
        // v25f: "" clears to the default; anything else passes the folder rule first (a refusal writes nothing).
        if let Some(d) = patch.worktrees_dir.as_deref().map(str::trim) {
            if !d.is_empty() {
                check_worktrees_dir(Path::new(d))?;
            }
            // Older records (no root of their own) are stamped with the root of now first, so they still list after.
            if Some(Path::new(d)) != self.settings.worktrees_dir.as_deref() {
                WorktreePlan::owner(&self.home, &self.worktree_root(), "stamp", None)
                    .run_waiting(false)?;
            }
            if d.is_empty() {
                next.worktrees_dir = None;
                if let Some(m) = file.as_object_mut() {
                    m.remove("worktrees_dir");
                }
            } else {
                next.worktrees_dir = Some(d.into());
                file["worktrees_dir"] = d.into();
            }
        }
        // Ticket 211: one canonical folder, once.
        if let Some(p) = patch.usage_allow_link {
            let root = crate::usage::allow_root(&p)?;
            if !next.usage_link_roots.contains(&root) {
                next.usage_link_roots.push(root);
            }
            file["usage_link_roots"] =
                serde_json::to_value(&next.usage_link_roots).map_err(|e| e.to_string())?;
        }
        if let Some(p) = patch.orchestration {
            if p.create_override == Some(true) {
                fs::create_dir_all(&override_dir)
                    .map_err(|e| format!("{}: {e}", override_dir.display()))?;
            }
            let o = &mut next.orchestration;
            o.enabled = p.enabled.unwrap_or(o.enabled);
            file["orchestration"] = serde_json::to_value(*o).map_err(|e| e.to_string())?;
        }
        // Ticket 250: `null` removes the key; the file's other feature keys stay as they are.
        if let Some(patch) = patch.features {
            let mut stored = match file.get("features") {
                Some(serde_json::Value::Object(m)) => m.clone(),
                _ => serde_json::Map::new(),
            };
            // V2.5-77: refuse a patch that grows the map past the cap; an over-cap file may still shrink or rewrite.
            let after = patch.iter().fold(stored.len(), |n, (k, v)| {
                match (v.is_null(), stored.contains_key(k)) {
                    (true, true) => n - 1,
                    (false, false) => n + 1,
                    _ => n,
                }
            });
            if after > FEATURE_KEYS_MAX && after > stored.len() {
                return Err(format!(
                    "this patch would leave {after} feature keys; settings.json may hold at most {FEATURE_KEYS_MAX}"
                ));
            }
            for (k, v) in patch {
                if v.is_null() {
                    stored.remove(&k);
                    next.features.remove(&k);
                } else {
                    stored.insert(k.clone(), v.clone());
                    next.features.insert(k, v);
                }
            }
            file["features"] = serde_json::Value::Object(stored);
        }
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        let masked = self.settings.history() == Some(true);
        self.settings = next;
        // v1a-74: off takes effect once stored: every file under scrollback/ goes, never through a link.
        if self.settings.history().is_none() {
            self.writes.queued.clear();
            let writing = self.writes.writing.iter().cloned();
            self.writes.dropped.extend(writing);
            crate::scrollback::sweep(&self.home, |_| false);
        }
        // V1A-74 follow-up: masking turned on masks what is already saved. A live PTY's file is written masked at its
        // own next save; every other file (an ended row, a set-aside row) is masked in place by the next drain.
        if !masked && self.settings.history() == Some(true) {
            for (_, write) in &mut self.writes.queued {
                if let Write::Save { mask, .. } = write {
                    *mask = true;
                }
            }
            // A save being written now lands after this; its id is masked again once it has (drains run in order).
            let writing = self.writes.writing.iter().cloned().collect::<Vec<_>>();
            match crate::scrollback::saved_ids(&self.home) {
                Ok(saved) => {
                    // A duplicate is skipped below: its first Remask is queued by then.
                    let ids = saved.into_iter().chain(writing);
                    for id in ids {
                        // An exited PTY stays on its row; only a running one saves again.
                        let live = self.entries.get(&id).is_some_and(|e| {
                            e.pty.is_some() && e.meta.state == SessionState::Running
                        });
                        if !live && !self.writes.queued.iter().any(|(other, _)| *other == id) {
                            self.writes.queued.push((id, Write::Remask));
                        }
                    }
                }
                Err(e) => eprintln!("scrollback mask: {e}"),
            }
        }
        reply(&self.settings)
    }
    // v1a-23: the owner's approval; it also answers the waiting items that asked for this subject.
    pub(super) fn approve(
        &mut self,
        subject: crate::approval::SubjectKind,
        name: &str,
        level: crate::approval::Level,
        hash: &str,
    ) -> Response {
        let view = match subject {
            crate::approval::SubjectKind::Widget => {
                crate::approval::grant(&self.home, name, level, hash)?
            }
            crate::approval::SubjectKind::Source => {
                crate::approval::grant_source(&self.home, name, level, hash)?
            }
            crate::approval::SubjectKind::Agent => {
                return Err("an agent is approved on its own sheet".into()); // V2-4a
            }
            crate::approval::SubjectKind::AgentCommand => {
                return Err("an agent command is approved on its own form".into()); // ticket 358
            }
            crate::approval::SubjectKind::Setup => {
                return Err("a setup script is approved on its own sheet".into()); // ticket 259
            }
            crate::approval::SubjectKind::Plugin => {
                return Err("a plugin is approved as the widget plugin:<id>".into());
            }
        };
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Approval { subject: s, name: n, .. }) if *s == subject && n == name)
        })?;
        Ok(Reply::ApprovalStatus { view })
    }
    /// v2-8c: the live PR settings, written like `quit_settings`; all `None` is a read. `watch` adds or removes one
    /// pin (validated by the caller).
    pub fn pr_live(
        &mut self,
        on: Option<bool>,
        offered: Option<bool>,
        watch: Option<(String, bool)>,
    ) -> Result<(bool, bool, Vec<String>), String> {
        let read = |s: &Settings| (s.live_pr_status, s.live_pr_offered, s.pr_watch.clone());
        if on.is_none() && offered.is_none() && watch.is_none() {
            return Ok(read(&self.settings));
        }
        let mut next = self.settings.clone();
        if let Some(v) = on {
            next.live_pr_status = v;
        }
        if let Some(v) = offered {
            next.live_pr_offered = v;
        }
        if let Some((url, add)) = watch {
            next.pr_watch.retain(|u| *u != url);
            if add {
                if next.pr_watch.len() >= crate::pr_live::MAX_PINNED {
                    return Err("too many watched pull requests".into());
                }
                next.pr_watch.push(url);
            }
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        file["live_pr_status"] = next.live_pr_status.into();
        file["live_pr_offered"] = next.live_pr_offered.into();
        file["pr_watch"] = next.pr_watch.clone().into();
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        self.settings = next;
        Ok(read(&self.settings))
    }
    // v1a-23: the verified-yes option for one canonical project, written like `quit_settings` (the file as it is
    // now, other keys kept, atomic); the running core follows only after the write succeeded.
    pub(super) fn permission_answers(&mut self, project: &Path, on: bool) -> Response {
        let project = fs::canonicalize(project).map_err(|e| e.to_string())?;
        let key = project.to_str().ok_or("project path is not UTF-8")?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        if !file["permission_answers"].is_object() {
            file["permission_answers"] = serde_json::json!({});
        }
        file["permission_answers"][key] = on.into();
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        self.settings.permission_answers.insert(project.clone(), on);
        if on {
            self.queue.answer_owner(|i| {
                i.owner
                    == Some(queue::OwnerAsk::PermissionAnswers {
                        project: project.clone(),
                    })
            })?;
        }
        Ok(Reply::PermissionAnswers { project, on })
    }
    // v1b-19
    pub(crate) fn script_widgets(&self) -> bool {
        self.settings.script_widgets
    }
    // v1b-22
    pub(crate) fn web_widgets(&self) -> bool {
        self.settings.web_widgets
    }
    pub(crate) fn feature<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.settings.feature(key)
    }
    /// Ticket 362: each agent's stored permission; absent is full access.
    pub(super) fn agent_permissions(&self) -> Reply {
        let stored = self
            .settings
            .features
            .get(crate::agent_permission::FEATURE_KEY);
        Reply::AgentPermission {
            claude: crate::agent_permission::stored_choice(stored, "claude"),
            codex: crate::agent_permission::stored_choice(stored, "codex"),
            // The owner's own Claude settings and the managed ones; a project's can still turn it off at its launch.
            claude_bypass_disabled: crate::agent_permission::claude_limits(None, &self.home)
                .bypass_disabled,
        }
    }
    pub(super) fn set_agent_permission(
        &mut self,
        agent: AgentKind,
        choice: PermissionChoice,
    ) -> Response {
        let name = crate::agent_permission::agent_key(agent)
            .ok_or("only Claude and Codex have a permission setting")?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let key = crate::agent_permission::FEATURE_KEY;
        let mut stored = match self.settings.features.get(key) {
            Some(serde_json::Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        };
        stored.insert(
            name.into(),
            serde_json::to_value(choice).map_err(|e| e.to_string())?,
        );
        let stored = serde_json::Value::Object(stored);
        if !file
            .get("features")
            .is_some_and(serde_json::Value::is_object)
        {
            file["features"] = serde_json::json!({});
        }
        file["features"][key] = stored.clone();
        store::write_capped(
            &path,
            &serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?,
            store::SETTINGS_READ_MAX,
        )?;
        self.settings.features.insert(key.into(), stored);
        Ok(self.agent_permissions())
    }
}
/// Ticket 250: the largest serialised feature value `quit_settings` stores.
const FEATURE_VALUE_MAX: usize = 4096;
/// V2.5-77: the most keys `features` holds; a file already past it loads whole and can only shrink or rewrite.
const FEATURE_KEYS_MAX: usize = 256;
/// Ticket 250: `^[a-z0-9]+(\.[a-z0-9_]+)+$`: a lowercase first part, then one or more `.part`s that may hold `_`.
fn feature_key(k: &str) -> bool {
    let mut parts = k.split('.');
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let ok = |p: &str, under: bool| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || (under && b == b'_'))
    };
    ok(first, false) && !rest.is_empty() && rest.iter().all(|p| ok(p, true))
}
// v1a-09 (v1a-23: shared): `settings.json` as it is now, a JSON object; missing reads as empty.
pub(super) fn settings_file(path: &Path) -> Result<serde_json::Value, String> {
    match crate::store::read_settings(path) {
        Ok(b) => serde_json::from_slice::<serde_json::Value>(&b)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or_else(|| "invalid settings: expected a JSON object".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e.to_string()),
    }
}
