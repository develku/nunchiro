//! One approval mechanism for anything Nunchiro runs on the user's behalf (script and web widgets,
//! board integration commands). An approval is keyed by subject kind, name and a content hash of its whole
//! folder, so any change asks again. This module never runs anything: the only way to learn a subject is
//! approved is `check`, which returns a `Proof` no other code can construct.
//!
//! Only the user's authority grants. The window (its own token) and the token-less CLI call `grant`;
//! a session token never reaches it (a session token reaches only hooks and the `grants` operations, none of them `Approval*`).
mod command;
mod confined;
mod hash;
mod manifest;
pub(crate) mod store;

pub use command::{
    CommandCheck, CommandProof, CommandView, check_command, command_check, command_grant,
    command_reset, command_status,
};
pub use manifest::{Act, Manifest, expand, home_wide}; // v1b-20: Act; v1b-33: expand, home_wide
// A plugin part's manifest is checked by the widget rules (`plugins::part_manifest`).
pub(crate) use manifest::parse as parse_manifest;
// v1b-17
pub(crate) use hash::FileStamp;
pub use hash::SnapshotFile;
pub use hash::outward_call_hash; // ticket 1002 lane 2: the Outbox card, its spend and the seat hook
pub(crate) fn source_metadata(home: &Path, name: &str) -> Result<Vec<FileStamp>, String> {
    if !valid_name(name) {
        return Err("invalid integration source name".into());
    }
    hash::metadata(home, &std::path::Path::new("sources").join(name))
}
#[cfg(test)]
pub(crate) use hash::read_count;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    #[default]
    Widget,
    Source,
    // V2-4a: an `agents.toml` entry (an ACP agent's command, args and env names).
    Agent,
    // Ticket 358: Claude's or Codex's own launch command (`command.rs`).
    AgentCommand,
    // Ticket 259: a worktree setup script read from the repo (`orca.yaml` `scripts.setup`), by the script text's hash.
    Setup,
    /// A plugin folder, stored by its id; asked for and granted as the widget name `plugin:<id>` (`plugins.rs`).
    Plugin,
}
impl SubjectKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Widget => "widget",
            Self::Source => "integration source",
            Self::Agent => "agent",
            Self::AgentCommand => "agent command",
            Self::Setup => "setup script",
            Self::Plugin => "plugin",
        }
    }
    fn folder(self) -> &'static str {
        match self {
            Self::Widget => "widgets",
            Self::Source => "sources",
            Self::Agent => "agents", // never a folder: `subject` refuses this kind
            Self::AgentCommand => "agent-commands", // nor this one
            Self::Setup => "setup",  // nor this one
            Self::Plugin => "plugins", // read through `plugin_subject`
        }
    }
}
use serde::{Deserialize, Serialize};
use std::path::Path;

/// What a user may grant. Never (answer decisions, change settings, touch agent config) has no API,
/// so it is not a level; `Act` implies `Read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "ApprovalLevel"))]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Read,
    Act,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "ApprovalState"))]
#[serde(rename_all = "snake_case")]
pub enum State {
    Unapproved,
    Approved,
    /// Approved once, but a file changed since.
    Changed,
}

/// Everything the permission sheet shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "ApprovalView"))]
pub struct View {
    pub name: String,
    pub state: State,
    pub level: Option<Level>,
    /// The hash a grant must quote, so the user approves exactly what the sheet showed.
    pub hash: String,
    pub manifest: Manifest,
    /// The raw `widget.toml` for the viewer.
    pub manifest_text: String,
    /// The equivalent command line (read level).
    pub cli: String,
    /// v1b-33: a `read` entry covers the user's whole home (`home_wide` against the core's HOME); the sheet warns.
    #[serde(default)]
    pub read_home_wide: bool,
    /// v1b-34: why act cannot be granted for this content (a web widget naming a script CDN host).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub act_refused: Option<String>,
    /// A plugin's panels and commands with what each runs (the sheet lists them; `manifest.command` is empty).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<crate::plugins::Part>,
    /// A plugin approved for its access whose files changed since, asking for nothing new: it stays approved.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub updated: bool,
    /// A plugin's access beyond what was approved (`plugins::access` lines): why it asks again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
}

/// Held by whatever runs a subject. Only `check` makes one; re-run `check` right before spawning, because
/// files can change after it returns.
#[derive(Debug)]
pub struct Proof {
    name: String,
    level: Level,
    hash: String,
    manifest: Manifest,
    // v1b-17
    files: Vec<SnapshotFile>,
    kind: SubjectKind,
}
impl Proof {
    // v1b-17
    pub fn files(&self) -> &[SnapshotFile] {
        &self.files
    }
    pub fn kind(&self) -> SubjectKind {
        self.kind
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn level(&self) -> Level {
        self.level
    }
    pub fn hash(&self) -> &str {
        &self.hash
    }
    pub fn argv(&self) -> &[String] {
        &self.manifest.command
    }
    pub fn interval_secs(&self) -> Option<u64> {
        self.manifest.interval_secs
    }
    pub fn network(&self) -> &[String] {
        &self.manifest.network
    }
    // v1b-33
    pub fn read(&self) -> &[String] {
        &self.manifest.read
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
}

struct Subject {
    // v1b-17
    files: Vec<SnapshotFile>,
    manifest: Manifest,
    text: String,
    hash: String,
}

pub(crate) fn valid_name(name: &str) -> bool {
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_';
    !name.is_empty() && name.len() <= 64 && !name.starts_with(['-', '_']) && name.bytes().all(ok)
}

// v1b-17
fn subject(home: &Path, name: &str, kind: SubjectKind) -> Result<Subject, String> {
    if matches!(
        kind,
        SubjectKind::Agent | SubjectKind::AgentCommand | SubjectKind::Setup | SubjectKind::Plugin
    ) {
        return Err("an agent is an agents.toml entry, not a folder".into());
    }
    if kind == SubjectKind::Widget
        && let Some((id, part)) = crate::plugins::split(name)
    {
        return plugin_subject(home, id, part);
    }
    if !valid_name(name) {
        return Err(format!("invalid {} name", kind.label()));
    }
    let dir = home.join(kind.folder()).join(name);
    if dir
        .symlink_metadata()
        .map_err(|e| format!("{} {name}: {e}", kind.label()))?
        .file_type()
        .is_symlink()
    {
        return Err(format!("{} folder must not be a symlink", kind.label()));
    }
    // The manifest is parsed from the very bytes that were hashed.
    let relative = std::path::Path::new(kind.folder()).join(name);
    let (hash, files) = hash::folder(home, &relative).map_err(|e| {
        if kind == SubjectKind::Source {
            e.replace("widget folder", "integration source folder")
                .replace("widgets may not", "integration sources may not")
        } else {
            e
        }
    })?;
    let bytes = files
        .iter()
        .find(|f| f.path() == "widget.toml")
        .ok_or("missing widget.toml")?
        .bytes()
        .to_vec();
    let text = String::from_utf8(bytes).map_err(|_| "widget.toml is not UTF-8")?;
    Ok(Subject {
        manifest: manifest::parse(&text)?,
        text,
        hash,
        files,
    })
}

/// A plugin (`plugin:<id>`) is one subject: its whole folder is hashed, and a part (`plugin__<id>__<part>`) carries that
/// same hash with the part's own manifest, so approving the plugin approves exactly the parts the sheet showed.
fn plugin_subject(home: &Path, id: &str, part: Option<&str>) -> Result<Subject, String> {
    if !valid_name(id) || part.is_some_and(|p| !valid_name(p)) {
        return Err("invalid plugin name".into());
    }
    let relative = std::path::Path::new(crate::plugins::FOLDER).join(id);
    if home
        .join(&relative)
        .symlink_metadata()
        .map_err(|e| format!("plugin {id}: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("plugin folder must not be a symlink".into());
    }
    let (hash, files) = hash::folder(home, &relative).map_err(|e| {
        e.replace("widget folder", "plugin folder")
            .replace("widgets may not", "plugins may not")
    })?;
    let bytes = files
        .iter()
        .find(|f| f.path() == crate::plugins::MANIFEST)
        .ok_or("missing plugin.toml")?
        .bytes()
        .to_vec();
    let text = String::from_utf8(bytes).map_err(|_| "plugin.toml is not UTF-8")?;
    let plugin = crate::plugins::parse(&text, id)?;
    let manifest = match part {
        None => crate::plugins::summary(&plugin),
        Some(part) => crate::plugins::part_manifest(&plugin, part)?,
    };
    Ok(Subject {
        manifest,
        text,
        hash,
        files,
    })
}

/// Where an approval is stored: a plugin and each of its parts under the plugin's id.
fn stored_as(kind: SubjectKind, name: &str) -> (SubjectKind, String) {
    match crate::plugins::split(name) {
        Some((id, _)) if kind == SubjectKind::Widget => (SubjectKind::Plugin, id.into()),
        _ => (kind, name.into()),
    }
}

/// A plugin's access now (`plugins::access`), when `s` is a plugin.
fn access_of(name: &str, s: &Subject) -> Option<std::collections::BTreeSet<String>> {
    let (id, _) = crate::plugins::split(name)?;
    crate::plugins::parse(&s.text, id)
        .ok()
        .map(|p| crate::plugins::access(&p))
}
/// What a plugin asks for beyond its approval: `None` when the stored grant holds no access (anything but a
/// plugin, or a grant from before access was recorded), so only the hash decides.
fn added(name: &str, s: &Subject, a: &store::Approval) -> Option<Vec<String>> {
    if a.access.is_empty() {
        return None;
    }
    let now = access_of(name, s)?;
    Some(now.into_iter().filter(|x| !a.access.contains(x)).collect())
}

fn view(name: &str, s: Subject, stored: Option<&store::Approval>) -> View {
    let act_refused = crate::widgets::web::act_refused(&s.manifest);
    let (state, level) = match stored {
        None => (State::Unapproved, None),
        // review-34: an act grant `check` refuses is not shown as approved; the sheet asks for a review.
        Some(a) if a.hash == s.hash && a.level == Level::Act && act_refused.is_some() => {
            (State::Changed, Some(a.level))
        }
        Some(a) if a.hash == s.hash => (State::Approved, Some(a.level)),
        // Changed, but asking for nothing it was not approved for: still approved (Orca's rule for updates).
        Some(a) if added(name, &s, a).is_some_and(|n| n.is_empty()) => {
            (State::Approved, Some(a.level))
        }
        Some(a) => (State::Changed, Some(a.level)),
    };
    let updated = stored.is_some_and(|a| a.hash != s.hash) && state == State::Approved;
    let new = stored
        .filter(|_| state == State::Changed)
        .and_then(|a| added(name, &s, a))
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let read_home_wide = home.is_some_and(|h| s.manifest.read.iter().any(|e| home_wide(e, &h))); // v1b-33
    let parts = crate::plugins::split(name)
        .and_then(|(id, _)| crate::plugins::parse(&s.text, id).ok())
        .map(|p| crate::plugins::parts(&p))
        .unwrap_or_default();
    View {
        parts,
        updated,
        added: new,
        read_home_wide,
        act_refused,
        name: name.into(),
        state,
        level,
        hash: s.hash,
        manifest: s.manifest,
        manifest_text: s.text,
        cli: match crate::plugins::split(name) {
            Some((id, _)) => format!("nunchiro plugin allow {id}"),
            None => format!("nunchiro widget allow {name} --read"),
        },
    }
}

// v1b-17: existing widget entry points preserve their meaning.
pub fn status(home: &Path, name: &str) -> Result<View, String> {
    status_kind(home, name, SubjectKind::Widget)
}
pub fn source_status(home: &Path, name: &str) -> Result<View, String> {
    status_kind(home, name, SubjectKind::Source)
}
fn source_cli(mut view: View) -> View {
    // The existing widget CLI keeps its namespace; use the owner socket for a source grant.
    view.cli = format!(
        r#"printf '{{"token":"%s","request":{{"op":"board_source_grant","name":"{}","level":"read","hash":"{}"}}}}\n' "$(cat "${{NUNCHIRO_HOME:-$HOME/.nunchiro}}/core.token")" | /usr/bin/nc -U "${{NUNCHIRO_HOME:-$HOME/.nunchiro}}/core.sock""#,
        view.name, view.hash
    );
    view
}
/// What a refusal calls the subject: a plugin part says "plugin", not "widget".
fn label(kind: SubjectKind, name: &str) -> &'static str {
    match crate::plugins::split(name) {
        Some(_) => SubjectKind::Plugin.label(),
        None => kind.label(),
    }
}
/// A plugin is shown and approved whole: a part's name (`plugin__<id>__<part>`) is never a sheet or a grant, so no
/// approval can be asked for with one part's narrower view.
fn whole(name: &str) -> Result<(), String> {
    match crate::plugins::split(name) {
        Some((id, Some(_))) => Err(format!(
            "approve the whole plugin (plugin:{id}), not one of its parts"
        )),
        _ => Ok(()),
    }
}
fn status_kind(home: &Path, name: &str, kind: SubjectKind) -> Result<View, String> {
    whole(name)?;
    let stored = store::load(home)?;
    let (at, key) = stored_as(kind, name); // a plugin part is approved as its plugin
    let view = view(name, subject(home, name, kind)?, stored.find(at, &key));
    Ok(if kind == SubjectKind::Source {
        source_cli(view)
    } else {
        view
    })
}

/// Records a grant for exactly the folder content whose hash the caller saw.
pub fn grant(home: &Path, name: &str, level: Level, seen_hash: &str) -> Result<View, String> {
    grant_kind(home, name, level, seen_hash, SubjectKind::Widget)
}
// v1b-17
pub fn grant_source(
    home: &Path,
    name: &str,
    level: Level,
    seen_hash: &str,
) -> Result<View, String> {
    grant_kind(home, name, level, seen_hash, SubjectKind::Source)
}
fn grant_kind(
    home: &Path,
    name: &str,
    level: Level,
    seen_hash: &str,
    kind: SubjectKind,
) -> Result<View, String> {
    whole(name)?;
    let mut stored = store::load(home)?;
    let s = subject(home, name, kind)?;
    if s.hash != seen_hash {
        return Err(format!(
            "{} changed since it was shown; review it again",
            kind.label()
        ));
    }
    if !s.manifest.permissions.contains(&level) {
        return Err(
            format!("{} does not declare {level:?} permission", kind.label()).to_lowercase(),
        );
    }
    if level == Level::Act
        && let Some(reason) = crate::widgets::web::act_refused(&s.manifest)
    {
        return Err(reason);
    }
    let (at, key) = stored_as(kind, name);
    stored.set(store::Approval {
        kind: at,
        name: key.clone(),
        level,
        hash: s.hash.clone(),
        granted_at_ms: crate::queue::now_ms(),
        access: access_of(name, &s)
            .map(|a| a.into_iter().collect())
            .unwrap_or_default(),
    });
    stored.save(home)?;
    let stored = stored.find(at, &key).cloned();
    let view = view(name, s, stored.as_ref());
    Ok(if kind == SubjectKind::Source {
        source_cli(view)
    } else {
        view
    })
}

/// The proof a runner must hold: the subject is approved right now with its current content.
pub fn check(home: &Path, name: &str) -> Result<Proof, String> {
    check_kind(home, name, SubjectKind::Widget)
}
// v1b-17
pub fn check_source(home: &Path, name: &str) -> Result<Proof, String> {
    check_kind(home, name, SubjectKind::Source)
}
fn check_kind(home: &Path, name: &str, kind: SubjectKind) -> Result<Proof, String> {
    let stored = store::load(home)?;
    let s = subject(home, name, kind)?;
    let (at, key) = stored_as(kind, name);
    // A plugin part is checked against its whole plugin's access.
    let whole = crate::plugins::split(name)
        .map(|(id, _)| format!("{}{id}", crate::plugins::PREFIX))
        .unwrap_or_default();
    match stored.find(at, &key) {
        Some(a)
            if a.hash == s.hash
                || (at == SubjectKind::Plugin
                    && added(&whole, &s, a).is_some_and(|n| n.is_empty())) =>
        {
            // v1b-34: an act grant stored before the rule (or by hand) is no proof.
            if let Some(reason) = crate::widgets::web::act_refused(&s.manifest)
                && a.level == Level::Act
            {
                return Err(reason);
            }
            Ok(Proof {
                name: name.into(),
                level: a.level,
                hash: s.hash,
                manifest: s.manifest,
                files: s.files,
                kind,
            })
        }
        Some(_) => Err(format!(
            "{} changed since it was approved",
            label(kind, name)
        )),
        None => Err(format!("{} is not approved", label(kind, name))),
    }
}

/// A removed plugin's approval is dropped, so the same folder moved back asks again.
pub(crate) fn forget_plugin(home: &Path, id: &str) -> Result<(), String> {
    let mut stored = store::load(home)?;
    stored.remove(SubjectKind::Plugin, id);
    stored.save(home)
}

/// `nunchiro plugin check`: one plugin part as it is now, approved or not, for one confined trial run by its author:
/// the sandbox holds, with no network and no declared reads; nothing is stored. Only `plugins::trial` asks for this; every other run needs `check`.
pub(crate) fn trial(home: &Path, name: &str) -> Result<Proof, String> {
    if !matches!(crate::plugins::split(name), Some((_, Some(_)))) {
        return Err("only a plugin part has a trial run".into());
    }
    let mut s = subject(home, name, SubjectKind::Widget)?;
    // Unapproved code gets none of what it declares: no network and no reads beyond its project and cache.
    s.manifest.network.clear();
    s.manifest.read.clear();
    Ok(Proof {
        name: name.into(),
        level: Level::Read,
        hash: s.hash,
        manifest: s.manifest,
        files: s.files,
        kind: SubjectKind::Widget,
    })
}

// V2-4a: an `agents.toml` entry is approved by the hash of its own content (name, command, args, env names), so any
// change to it asks again. Granting is human-only (`check_agent` in sessions refuses every session caller).

/// What the agent approval sheet shows: the exact command it would run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AgentView {
    pub name: String,
    pub state: State,
    pub hash: String,
    pub entry: crate::acp::config::Entry,
    /// Why this entry can never launch as it is (a Claude entry without an API key or cloud credential set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// Held by whatever launches an ACP agent. Only `check_agent` makes one, right before the spawn.
#[derive(Debug)]
pub struct AgentProof {
    entry: crate::acp::config::Entry,
}
impl AgentProof {
    pub fn entry(&self) -> &crate::acp::config::Entry {
        &self.entry
    }
}

fn agent_view(home: &Path, name: &str) -> Result<AgentView, String> {
    let entry = crate::acp::config::find(home, name)?;
    let hash = hash::entry(&entry);
    let state = match store::load(home)?.find(SubjectKind::Agent, name) {
        None => State::Unapproved,
        Some(a) if a.hash == hash => State::Approved,
        Some(_) => State::Changed,
    };
    Ok(AgentView {
        name: name.into(),
        state,
        refused: crate::acp::config::claude_refusal(&entry),
        hash,
        entry,
    })
}

pub fn agent_status(home: &Path, name: &str) -> Result<AgentView, String> {
    agent_view(home, name)
}

/// Records a grant for exactly the entry content whose hash the caller saw.
pub fn grant_agent(home: &Path, name: &str, seen_hash: &str) -> Result<AgentView, String> {
    let view = agent_view(home, name)?;
    if view.hash != seen_hash {
        return Err("agent changed since it was shown; review it again".into());
    }
    if let Some(reason) = view.refused {
        return Err(reason);
    }
    let mut stored = store::load(home)?;
    stored.set(store::Approval {
        kind: SubjectKind::Agent,
        name: name.into(),
        level: Level::Act,
        hash: view.hash,
        granted_at_ms: crate::queue::now_ms(),
        access: vec![],
    });
    stored.save(home)?;
    agent_view(home, name)
}

/// The proof a launch must hold: the entry is approved right now with its current content, and allowed at all.
// shortcut: the approval binds the entry's text (the command path and its args), not the binary behind the path nor a
// script an arg names: replacing that file keeps the approval. Hash the command file (and named scripts) when agent
// binaries move under paths other programs can write.
pub fn check_agent(home: &Path, name: &str) -> Result<AgentProof, String> {
    let view = agent_view(home, name)?;
    if let Some(reason) = view.refused {
        return Err(reason);
    }
    match view.state {
        State::Approved => Ok(AgentProof { entry: view.entry }),
        State::Changed => Err("agent changed since it was approved".into()),
        State::Unapproved => Err("agent is not approved".into()),
    }
}

// Ticket 259: a repo's worktree setup script (`orca.yaml` `scripts.setup`). One grant per project, bound to the hash of
// the script text, so a branch that rewrites the script asks again. Granting is human-only: the core serves these
// requests to the owner alone (`worktree_setup::serve`).

/// What the setup approval sheet shows: the exact text that would run, and where.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetupView {
    pub project: std::path::PathBuf,
    /// The worktree the script was read from and would run in.
    pub path: std::path::PathBuf,
    pub state: State,
    pub hash: String,
    pub script: String,
}

/// The approval name of a project's setup script: a store name is short and plain, a path is neither.
pub fn setup_name(project: &Path) -> String {
    format!("setup-{}", &hash::text(&project.to_string_lossy())[..40])
}

pub fn setup_status(
    home: &Path,
    project: &Path,
    path: &Path,
    script: &str,
) -> Result<SetupView, String> {
    let hash = hash::text(script);
    let state = match store::load(home)?.find(SubjectKind::Setup, &setup_name(project)) {
        None => State::Unapproved,
        Some(a) if a.hash == hash => State::Approved,
        Some(_) => State::Changed,
    };
    Ok(SetupView {
        project: project.into(),
        path: path.into(),
        state,
        hash,
        script: script.into(),
    })
}

/// Records a grant for exactly the script text whose hash the sheet showed.
pub fn grant_setup(
    home: &Path,
    project: &Path,
    path: &Path,
    script: &str,
    seen_hash: &str,
) -> Result<SetupView, String> {
    if hash::text(script) != seen_hash {
        return Err("setup script changed since it was shown; review it again".into());
    }
    let mut stored = store::load(home)?;
    stored.set(store::Approval {
        kind: SubjectKind::Setup,
        name: setup_name(project),
        level: Level::Act,
        hash: seen_hash.into(),
        granted_at_ms: crate::queue::now_ms(),
        access: vec![],
    });
    stored.save(home)?;
    setup_status(home, project, path, script)
}

#[cfg(test)]
mod setup_tests {
    use super::*;

    #[test]
    fn setup_subject_kind_separate_from_widget_and_source() {
        let home = std::env::temp_dir().join(format!("nunchiro-setup-kind-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let project = Path::new("/tmp/p");
        let name = setup_name(project);
        assert!(valid_name(&name), "{name}");
        let view = grant_setup(&home, project, project, "make", &hash::text("make")).unwrap();
        assert_eq!(view.state, State::Approved);
        let stored = store::load(&home).unwrap();
        // The grant is the setup kind's alone: no widget, source or agent of that name is approved by it.
        for kind in [
            SubjectKind::Widget,
            SubjectKind::Source,
            SubjectKind::Agent,
            SubjectKind::AgentCommand,
        ] {
            assert!(stored.find(kind, &name).is_none(), "{kind:?}");
        }
        assert!(stored.find(SubjectKind::Setup, &name).is_some());
        // Nor is it a folder subject: the widget paths refuse the kind.
        assert!(subject(&home, &name, SubjectKind::Setup).is_err());
        assert_eq!(serde_json::to_value(SubjectKind::Setup).unwrap(), "setup");
        // A store written with it reads back (the kind round-trips and stays apart from a widget of the same name).
        let mut stored = stored;
        stored.set(store::Approval {
            kind: SubjectKind::Widget,
            name: name.clone(),
            level: Level::Read,
            hash: hash::text("w"),
            granted_at_ms: 0,
            access: vec![],
        });
        stored.save(&home).unwrap();
        let again = store::load(&home).unwrap();
        assert_eq!(
            again.find(SubjectKind::Setup, &name).unwrap().hash,
            hash::text("make")
        );
        assert_eq!(
            again.find(SubjectKind::Widget, &name).unwrap().hash,
            hash::text("w")
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
