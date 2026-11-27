//! Plugins: one folder `$NUNCHIRO_HOME/plugins/<id>/` with a `plugin.toml` that adds panels, commands and settings
//! (docs/plugins.md). A plugin is one approval subject, `plugin:<id>`: the whole folder is hashed and approved once
//! through the widget permission sheet, and any change asks again. Each panel and command is a part,
//! `plugin:<id>/<part>`, whose proof carries a widget manifest built from that part and checked by the very rules a
//! `widget.toml` takes, so a part runs in the same sandbox as a script widget and a web panel is served as a web
//! widget. A plugin is off after it is made or copied in; on and approved, its parts run. Owner and window only.
use crate::{
    api::{Reply, Request, Response},
    approval, widgets,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// The approval name prefix of a plugin; `plugin:<id>` is the plugin, `plugin:<id>/<part>` one panel or command.
pub const PREFIX: &str = "plugin:";
pub const FOLDER: &str = "plugins";
pub const MANIFEST: &str = "plugin.toml";
/// Where `plugin.toml` points editors for completion and checks (taplo's `#:schema` line).
pub const SCHEMA_URL: &str =
    "https://raw.githubusercontent.com/develku/nunchiro/main/docs/api/plugin.schema.json";
const STORE: &str = "plugins.json";
const MAX_BYTES: usize = 64 * 1024;
const MAX_PARTS: usize = 32;

/// `plugin.toml`. Unknown keys refuse the whole file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Plugin {
    /// The folder's name: a-z, 0-9, - and _ (up to 64).
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub about: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// The Nunchiro versions the plugin is made for, as written; shown, not enforced yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nunchiro: Option<String>,
    /// Panels in the Widget library: a script that prints text or JSON, or a web page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub panel: Vec<Panel>,
    /// Rows in the command palette.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub command: Vec<Command>,
    /// Values the user sets on the Plugins page; every run gets them as `settings`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setting: Vec<Setting>,
    /// Checks that may refuse a new session or replace a message an agent, a schedule or a token sends.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gate: Vec<Gate>,
}
/// A check run before an action: it answers `{"allow": true}`, `{"allow": false, "reason": "..."}` or, before a
/// message, `{"allow": true, "text": "..."}` to replace it. It can do nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Gate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub on: GateOn,
    /// argv, run from the plugin folder; 5 seconds at most.
    pub command: Vec<String>,
    /// What no answer, a crash or bad JSON means.
    #[serde(default)]
    pub on_error: OnError,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub enum GateOn {
    /// A new agent session is about to start (not a plain terminal, not a resumed conversation).
    #[serde(rename = "session.start.before")]
    SessionStart,
    /// A message an agent, a schedule or a token sends is about to be delivered; never what the owner types.
    #[serde(rename = "prompt.send.before")]
    PromptSend,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    #[default]
    Refuse,
    Allow,
}
/// A widget manifest inside the plugin (the fields of `widget.toml`), named so its plugin can hold several.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Panel {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `script` or `web`.
    pub kind: String,
    /// A script panel's argv, run from the plugin folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    /// A web panel's HTML file in the plugin folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// argv, run from the plugin folder; never a shell string.
    pub command: Vec<String>,
    #[serde(default)]
    pub show: Show,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
}
/// Where a command's output goes: a note, a panel, or the focused agent's composer as a draft (never sent by itself).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Show {
    #[default]
    Note,
    Panel,
    Send,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Setting {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: SettingKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// The values of a `choice` setting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SettingKind {
    Text,
    Number,
    Bool,
    /// `HH:MM`, 24-hour.
    Time,
    Choice,
}

/// `plugin:<id>` or `plugin:<id>/<part>` split into id and part; `None` for every other name.
pub(crate) fn split(name: &str) -> Option<(&str, Option<&str>)> {
    let rest = name.strip_prefix(PREFIX)?;
    Some(match rest.split_once('/') {
        Some((id, part)) => (id, Some(part)),
        None => (rest, None),
    })
}
fn shown(text: &str) -> bool {
    text.chars().all(crate::delivery::shown)
}

pub fn parse(text: &str, id: &str) -> Result<Plugin, String> {
    if text.len() > MAX_BYTES {
        return Err("plugin.toml is too large".into());
    }
    let p: Plugin =
        toml::from_str(text).map_err(|e| format!("invalid plugin.toml: {}", e.message()))?;
    if p.id != id {
        return Err(format!(
            "plugin.toml id {:?} is not its folder's name {id:?}",
            p.id
        ));
    }
    if !approval::valid_name(&p.id) {
        return Err(
            "invalid plugin id: use a-z, 0-9, - and _ (up to 64, not starting with - or _)".into(),
        );
    }
    for (field, text) in [("name", &p.name), ("version", &p.version)] {
        if text.trim().is_empty() {
            return Err(format!("plugin.toml needs a {field}"));
        }
    }
    let words = [&p.name, &p.version, &p.about]
        .into_iter()
        .chain(p.author.iter())
        .chain(p.panel.iter().filter_map(|x| x.title.as_ref()))
        .chain(p.command.iter().filter_map(|x| x.title.as_ref()))
        .chain(p.gate.iter().filter_map(|x| x.title.as_ref()))
        .chain(p.setting.iter().map(|s| &s.label));
    if words.into_iter().any(|t| !shown(t)) {
        return Err("plugin.toml text has a hidden, control or bidi character".into());
    }
    let parts: Vec<&str> = p
        .panel
        .iter()
        .map(|x| x.name.as_str())
        .chain(p.command.iter().map(|x| x.name.as_str()))
        .chain(p.gate.iter().map(|x| x.name.as_str()))
        .collect();
    if parts.len() > MAX_PARTS {
        return Err(format!(
            "a plugin has at most {MAX_PARTS} panels and commands"
        ));
    }
    let mut seen = BTreeSet::new();
    for name in &parts {
        if !approval::valid_name(name) {
            return Err(format!("invalid part name {name:?}: use a-z, 0-9, - and _"));
        }
        if !seen.insert(*name) {
            return Err(format!("two panels or commands are named {name:?}"));
        }
        part_manifest(&p, name)?;
    }
    let mut keys = BTreeSet::new();
    for s in &p.setting {
        if !approval::valid_name(&s.key) || !keys.insert(s.key.as_str()) {
            return Err(format!("setting key {:?} is invalid or repeated", s.key));
        }
        if s.kind == SettingKind::Choice && s.choices.is_empty() {
            return Err(format!("choice setting {} needs choices", s.key));
        }
        if let Some(d) = &s.default {
            value(s, d).map_err(|e| format!("setting {} default: {e}", s.key))?;
        }
    }
    Ok(p)
}

/// A setting value checked against its type.
fn value(s: &Setting, v: &Value) -> Result<(), String> {
    let ok = match s.kind {
        SettingKind::Text => v.as_str().is_some_and(|t| t.len() <= 1000 && shown(t)),
        SettingKind::Number => v.is_number(),
        SettingKind::Bool => v.is_boolean(),
        SettingKind::Time => v.as_str().is_some_and(|t| {
            let b = t.as_bytes();
            b.len() == 5
                && b[2] == b':'
                && t[..2].parse::<u8>().is_ok_and(|h| h < 24)
                && t[3..].parse::<u8>().is_ok_and(|m| m < 60)
        }),
        SettingKind::Choice => v.as_str().is_some_and(|t| s.choices.iter().any(|c| c == t)),
    };
    ok.then_some(())
        .ok_or_else(|| format!("not a {:?} value", s.kind).to_lowercase())
}

/// The widget manifest of one part, built as a `widget.toml` and parsed by its rules (folder-only paths, argv only,
/// hosts, read paths, hidden characters).
pub(crate) fn part_manifest(p: &Plugin, part: &str) -> Result<approval::Manifest, String> {
    let mut t = toml::Table::new();
    t.insert("version".into(), 1.into());
    t.insert(
        "permissions".into(),
        toml::Value::Array(vec!["read".into()]),
    );
    if let Some(a) = &p.author {
        t.insert("author".into(), a.clone().into());
    }
    let strings = |v: &[String]| toml::Value::Array(v.iter().map(|s| s.clone().into()).collect());
    if let Some(x) = p.panel.iter().find(|x| x.name == part) {
        t.insert("kind".into(), x.kind.clone().into());
        if let Some(c) = &x.command {
            t.insert("command".into(), strings(c));
        }
        if let Some(e) = &x.entry {
            t.insert("entry".into(), e.clone().into());
        }
        if let Some(i) = x.interval_secs {
            t.insert("interval".into(), (i.min(i64::MAX as u64) as i64).into());
        }
        t.insert("network".into(), strings(&x.network));
        if !x.read.is_empty() {
            t.insert("read".into(), strings(&x.read));
        }
    } else if let Some((command, network, read)) = p
        .command
        .iter()
        .find(|x| x.name == part)
        .map(|x| (&x.command, &x.network, &x.read))
        .or_else(|| {
            p.gate
                .iter()
                .find(|x| x.name == part)
                .map(|x| (&x.command, &x.network, &x.read))
        })
    {
        // A command and a check are both a script run on request.
        t.insert("kind".into(), "script".into());
        t.insert("command".into(), strings(command));
        t.insert("network".into(), strings(network));
        if !read.is_empty() {
            t.insert("read".into(), strings(read));
        }
    } else {
        return Err(format!(
            "plugin {} has no panel, command or check {part}",
            p.id
        ));
    }
    let text = toml::to_string(&t).map_err(|e| e.to_string())?;
    approval::parse_manifest(&text)
        .map_err(|e| format!("{part}: {}", e.replace("widget folder", "plugin folder")))
}

/// One part as the permission sheet lists it: what it is and exactly what it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Part {
    pub name: String,
    pub title: String,
    /// `panel`, `command` or `check`.
    pub kind: String,
    /// The argv, or a web panel's entry file as its one word.
    pub runs: Vec<String>,
}
pub(crate) fn parts(p: &Plugin) -> Vec<Part> {
    let panels = p.panel.iter().map(|x| Part {
        name: x.name.clone(),
        title: x.title.clone().unwrap_or_else(|| x.name.clone()),
        kind: "panel".into(),
        runs: x
            .command
            .clone()
            .unwrap_or_else(|| x.entry.iter().cloned().collect()),
    });
    let gates = p.gate.iter().map(|x| Part {
        name: x.name.clone(),
        title: x.title.clone().unwrap_or_else(|| x.name.clone()),
        kind: "check".into(),
        runs: x.command.clone(),
    });
    let commands = p.command.iter().map(|x| Part {
        name: x.name.clone(),
        title: x.title.clone().unwrap_or_else(|| x.name.clone()),
        kind: "command".into(),
        runs: x.command.clone(),
    });
    panels.chain(commands).chain(gates).collect()
}

/// What the permission sheet shows for the whole plugin: every host and read path any part may use.
pub(crate) fn summary(p: &Plugin) -> approval::Manifest {
    let mut network = vec![];
    let mut read = vec![];
    for m in p
        .panel
        .iter()
        .map(|x| &x.name)
        .chain(p.command.iter().map(|x| &x.name))
        .chain(p.gate.iter().map(|x| &x.name))
    {
        if let Ok(m) = part_manifest(p, m) {
            network.extend(m.network);
            read.extend(m.read);
        }
    }
    network.sort();
    network.dedup();
    read.sort();
    read.dedup();
    approval::Manifest {
        kind: "plugin".into(),
        author: p
            .author
            .clone()
            .filter(|a| !a.trim().is_empty())
            .unwrap_or_else(|| "unknown".into()),
        command: vec![],
        entry: String::new(),
        interval_secs: None,
        permissions: vec![approval::Level::Read],
        network,
        act: None,
        read,
    }
}

/// `plugins.json`: which plugins are on and their setting values. Written by the core alone; turning a plugin on
/// still needs its approval to run anything, so this file is not a trust boundary.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    on: BTreeSet<String>,
    #[serde(default)]
    settings: BTreeMap<String, BTreeMap<String, Value>>,
}
fn load(home: &Path) -> Store {
    fs::read(home.join(STORE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn save(home: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    crate::store::atomic_write(&home.join(STORE), &bytes)
}
/// A part's plugin is on (the switch on the Plugins page); its approval is checked separately.
pub(crate) fn on(home: &Path, name: &str) -> Result<(), String> {
    match split(name) {
        Some((id, _)) if !load(home).on.contains(id) => Err(format!("plugin {id} is off")),
        _ => Ok(()),
    }
}
/// The values a run gets: the stored ones, else the defaults.
fn values(home: &Path, p: &Plugin) -> BTreeMap<String, Value> {
    let stored = load(home).settings.remove(&p.id).unwrap_or_default();
    p.setting
        .iter()
        .filter_map(|s| {
            let v = stored
                .get(&s.key)
                .filter(|v| value(s, v).is_ok())
                .or(s.default.as_ref());
            v.map(|v| (s.key.clone(), v.clone()))
        })
        .collect()
}
/// The JSON a part reads from `$NUNCHIRO_CONTEXT`: the widget context plus which part runs and the settings.
pub(crate) fn input(
    home: &Path,
    name: &str,
    context: &widgets::Context,
    extra: Option<&Value>,
) -> Result<Vec<u8>, String> {
    let (id, part) = split(name).ok_or("not a plugin part")?;
    let p = read(home, id)?;
    let mut v = serde_json::to_value(context).map_err(|e| e.to_string())?;
    let event = if p.panel.iter().any(|x| Some(x.name.as_str()) == part) {
        "panel"
    } else {
        "command"
    };
    v["event"] = event.into();
    v["plugin"] = id.into();
    v["part"] = part.unwrap_or_default().into();
    v["settings"] = serde_json::to_value(values(home, &p)).map_err(|e| e.to_string())?;
    // A check's event (`session.start.before`, `prompt.send.before`) and what it is about.
    for (k, x) in extra.and_then(Value::as_object).into_iter().flatten() {
        v[k] = x.clone();
    }
    serde_json::to_vec(&v).map_err(|e| e.to_string())
}

fn dir(home: &Path) -> PathBuf {
    home.join(FOLDER)
}
fn read(home: &Path, id: &str) -> Result<Plugin, String> {
    if !approval::valid_name(id) {
        return Err("invalid plugin id".into());
    }
    let path = dir(home).join(id).join(MANIFEST);
    let text = fs::read_to_string(&path).map_err(|e| format!("plugin {id}: {e}"))?;
    parse(&text, id)
}
/// The plugin ids on disk, sorted; none when the folder is a link.
pub fn ids(home: &Path) -> Vec<String> {
    let dir = dir(home);
    if dir
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return vec![];
    }
    let mut ids: Vec<String> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    ids.sort();
    ids
}

/// One row of the Plugins page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Listed {
    pub id: String,
    pub on: bool,
    /// Absent when the folder or its manifest cannot be read (`error` says why).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<approval::State>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<Plugin>,
    /// The current value of each setting (stored, else the default).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The setting that is off and stops this plugin's parts (`script_widgets` or `web_widgets`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<String>,
}
pub fn list(home: &Path, script_on: bool, web_on: bool) -> Vec<Listed> {
    let store = load(home);
    ids(home)
        .into_iter()
        .map(|id| {
            let on = store.on.contains(&id);
            let name = format!("{PREFIX}{id}");
            let parsed = approval::status(home, &name)
                .and_then(|v| Ok((v.state, parse(&v.manifest_text, &id)?)));
            match parsed {
                Ok((state, p)) => {
                    let scripts =
                        p.command.len() + p.panel.iter().filter(|x| x.kind == "script").count();
                    let needs = if scripts > 0 && !script_on {
                        Some("script_widgets".into())
                    } else if p.panel.iter().any(|x| x.kind == "web") && !web_on {
                        Some("web_widgets".into())
                    } else {
                        None
                    };
                    Listed {
                        values: values(home, &p),
                        id,
                        on,
                        state: Some(state),
                        plugin: Some(p),
                        error: None,
                        needs,
                    }
                }
                Err(e) => Listed {
                    id,
                    on,
                    state: None,
                    plugin: None,
                    values: BTreeMap::new(),
                    error: Some(e),
                    needs: None,
                },
            }
        })
        .collect()
}

/// The panels of plugins that are on, as Widget library rows (`plugin:<id>/<panel>`).
pub(crate) fn panels(home: &Path) -> Vec<widgets::Listed> {
    let store = load(home);
    let mut rows = vec![];
    for id in ids(home).into_iter().filter(|id| store.on.contains(id)) {
        let name = format!("{PREFIX}{id}");
        let Ok(view) = approval::status(home, &name) else {
            continue;
        };
        let Ok(p) = parse(&view.manifest_text, &id) else {
            continue;
        };
        for x in &p.panel {
            rows.push(widgets::Listed {
                name: format!("{name}/{}", x.name),
                state: Some(view.state),
                kind: Some(x.kind.clone()),
                author: Some(view.manifest.author.clone()),
                interval_secs: x.interval_secs,
                error: None,
                act: None,
                title: Some(x.title.clone().unwrap_or_else(|| x.name.clone())),
                plugin: Some(p.name.clone()),
            });
        }
    }
    rows
}

/// What the window and the CLI ask of plugins (owner and window only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    List,
    /// Turns a plugin on or off; on runs nothing until it is approved.
    Set {
        id: String,
        on: bool,
    },
    /// Sets one setting; a value of the wrong type is refused.
    Setting {
        id: String,
        key: String,
        value: Value,
    },
    /// Runs one command now for the project of `session` (none = no project).
    Run {
        id: String,
        command: String,
        #[serde(default)]
        session: Option<String>,
    },
    /// Moves the folder to `plugins/.removed/`, so a removal can be undone by moving it back.
    Remove {
        id: String,
    },
}

/// Dispatch for `Request::Plugin` (server.rs and http/answer.rs, after their owner checks); runs after the lock.
pub(crate) fn handle(
    home: &Path,
    mut sessions: std::sync::MutexGuard<'_, crate::sessions::Sessions>,
    request: Request,
) -> Response {
    let Request::Plugin { action } = request else {
        return Err("not a plugin request".into());
    };
    let (script_on, web_on) = (sessions.script_widgets(), sessions.web_widgets());
    let all = match &action {
        Action::Run { .. } => match sessions.handle(Request::Snapshot)? {
            Reply::Snapshot { sessions, .. } => sessions,
            _ => return Err("unexpected snapshot reply".into()),
        },
        _ => vec![],
    };
    drop(sessions);
    let listed = |home: &Path| {
        Ok(Reply::Plugins {
            plugins: list(home, script_on, web_on),
        })
    };
    match action {
        Action::List => listed(home),
        Action::Set { id, on } => {
            read(home, &id)?;
            let mut store = load(home);
            if on {
                store.on.insert(id);
            } else {
                store.on.remove(&id);
            }
            save(home, &store)?;
            listed(home)
        }
        Action::Setting { id, key, value: v } => {
            let p = read(home, &id)?;
            let s = p
                .setting
                .iter()
                .find(|s| s.key == key)
                .ok_or_else(|| format!("plugin {id} has no setting {key}"))?;
            value(s, &v)?;
            let mut store = load(home);
            store.settings.entry(id).or_default().insert(key, v);
            save(home, &store)?;
            listed(home)
        }
        Action::Run {
            id,
            command,
            session,
        } => {
            let p = read(home, &id)?;
            let c = p
                .command
                .iter()
                .find(|c| c.name == command)
                .ok_or_else(|| format!("plugin {id} has no command {command}"))?;
            let show = c.show;
            let config = widgets::Config::core(script_on)?;
            let project = widgets::project(&all, session.as_deref())?;
            let name = format!("{PREFIX}{id}/{command}");
            let run = widgets::run_now(home, &config, &name, project, &widgets::context(&all))?;
            Ok(Reply::PluginRun { run, show })
        }
        Action::Remove { id } => {
            if !approval::valid_name(&id) {
                return Err("invalid plugin id".into());
            }
            let from = dir(home).join(&id);
            if !from.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                return Err(format!("no plugin {id}"));
            }
            let removed = dir(home).join(".removed");
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&removed)
                .map_err(|e| e.to_string())?;
            fs::rename(
                &from,
                removed.join(format!("{id}-{}", crate::queue::now_ms())),
            )
            .map_err(|e| e.to_string())?;
            let mut store = load(home);
            store.on.remove(&id);
            store.settings.remove(&id);
            save(home, &store)?;
            listed(home)
        }
    }
}

/// One part's result in `plugin check`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tried {
    pub part: String,
    /// What the part printed, or why it did not run.
    pub result: Result<String, String>,
}
/// `nunchiro plugin check <id>`: the manifest by the core's rules, then each script part once in the widget sandbox
/// on the sample input (no sessions, the current settings), before and without any approval. A web panel is only
/// checked (its entry is in the folder). Runs nothing in a session and changes no approval.
pub fn trial(home: &Path, id: &str) -> Result<(Plugin, Vec<Tried>), String> {
    let p = read(home, id)?;
    let config = widgets::Config::core(true)?;
    let mut tried = vec![];
    for (part, script) in p
        .panel
        .iter()
        .map(|x| (&x.name, x.kind == "script"))
        .chain(p.command.iter().map(|x| (&x.name, true)))
        .chain(p.gate.iter().map(|x| (&x.name, true)))
    {
        let gate = p.gate.iter().find(|g| &g.name == part);
        let name = format!("{PREFIX}{id}/{part}");
        let result = match approval::trial(home, &name) {
            Err(e) => Err(e),
            Ok(proof) if !script => proof
                .files()
                .iter()
                .any(|f| f.path() == proof.manifest().entry)
                .then(|| format!("web page {}", proof.manifest().entry))
                .ok_or_else(|| format!("entry {} is missing", proof.manifest().entry)),
            Ok(proof) => {
                let sample = gate.map(|g| sample_event(g.on));
                widgets::execute(
                    home,
                    &config,
                    &proof,
                    None,
                    &widgets::Context::default(),
                    sample.as_ref(),
                )
                .map(|o| match o {
                    widgets::Output::Text { text } | widgets::Output::Json { text } => text,
                })
                .and_then(|text| match gate {
                    None => Ok(text),
                    // A check must answer in the one shape the core reads.
                    Some(_) => match answer(&text) {
                        Some(Answer { allow: true, .. }) => Ok("allowed the sample".into()),
                        Some(Answer { reason, .. }) => Ok(format!(
                            "refused the sample: {}",
                            reason.unwrap_or_default()
                        )),
                        None => Err(format!(
                            "answered {:?}, not {{\"allow\": true|false, \"reason\": \"...\"}}",
                            text.trim()
                        )),
                    },
                })
            }
        };
        tried.push(Tried {
            part: part.clone(),
            result,
        });
    }
    Ok((p, tried))
}

/// The input `plugin check` gives a check: a made-up start or message, so it runs nothing real.
fn sample_event(on: GateOn) -> Value {
    match on {
        GateOn::SessionStart => {
            serde_json::json!({"event": "session.start.before", "asker": "agent",
            "start": {"kind": "claude", "project": "/tmp/sample-project", "worktree": false, "label": "sample"}})
        }
        GateOn::PromptSend => serde_json::json!({"event": "prompt.send.before", "asker": "agent",
            "to": "sample", "text": "A sample message."}),
    }
}

/// A check's answer, read from what it printed.
#[derive(Debug, Deserialize)]
struct Answer {
    allow: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    text: Option<String>,
}
fn answer(printed: &str) -> Option<Answer> {
    serde_json::from_str(printed.trim()).ok()
}

/// Who asks for a start or a send, as a check reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Asker {
    Owner,
    Agent,
    Schedule,
    Token,
}
/// A replaced message is cut to this many bytes.
const MAX_TEXT: usize = 16 * 1024;

/// Runs the checks for `on` of every plugin that is on and approved as it is now: plugins in id order, checks in
/// manifest order; the first refusal ends it. `Ok(Some(text))` replaces a message. No plugin on with such a check
/// spawns nothing. A check needs the `script_widgets` setting, as every script part does.
fn gates(
    home: &Path,
    on: GateOn,
    event: Value,
) -> Result<Option<(String, String)>, (String, String)> {
    let store = load(home);
    if store.on.is_empty() {
        return Ok(None);
    }
    let enabled = crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["script_widgets"] == true);
    // Script parts are off: no check runs, as no panel or command does (the Plugins page says so).
    let Ok(config) = widgets::Config::core(enabled) else {
        return Ok(None);
    };
    if !enabled {
        return Ok(None);
    }
    let mut event = event;
    let mut replaced: Option<(String, String)> = None;
    for id in ids(home).into_iter().filter(|id| store.on.contains(id)) {
        let Ok(p) = read(home, &id) else { continue };
        let mine: Vec<&Gate> = p.gate.iter().filter(|g| g.on == on).collect();
        if mine.is_empty() || approval::check(home, &format!("{PREFIX}{id}")).is_err() {
            continue; // off, not approved or changed: runs nothing, so it decides nothing
        }
        for g in mine {
            let name = format!("{PREFIX}{id}/{}", g.name);
            let ran = approval::check(home, &name)
                .and_then(|proof| {
                    widgets::execute(
                        home,
                        &config,
                        &proof,
                        None,
                        &widgets::Context::default(),
                        Some(&event),
                    )
                })
                .ok()
                .and_then(|o| match o {
                    widgets::Output::Text { text } | widgets::Output::Json { text } => {
                        answer(&text)
                    }
                });
            match ran {
                Some(Answer {
                    allow: false,
                    reason,
                    ..
                }) => {
                    let reason = reason
                        .filter(|r| !r.trim().is_empty() && shown(r))
                        .unwrap_or_else(|| "no reason given".into());
                    return Err((
                        p.name,
                        reason.lines().next().unwrap_or_default().to_string(),
                    ));
                }
                Some(Answer {
                    text: Some(text), ..
                }) if on == GateOn::PromptSend => {
                    let mut text = text;
                    if text.len() > MAX_TEXT {
                        let mut end = MAX_TEXT;
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        text.truncate(end);
                    }
                    event["text"] = text.clone().into();
                    replaced = Some((p.name.clone(), text));
                }
                Some(_) => {}
                None if g.on_error == OnError::Allow => {}
                None => return Err((p.name, "its check did not answer".into())),
            }
        }
    }
    Ok(replaced)
}

/// Before a new agent session starts: `Err` is the sentence the asker sees. A plain terminal and a resumed
/// conversation are not checked (as the memory hold).
pub(crate) fn check_start(
    home: &Path,
    asker: Asker,
    start: &crate::api::StartSession,
) -> Result<(), String> {
    if start.kind == crate::api::AgentKind::Shell || start.resume.is_some() {
        return Ok(());
    }
    let event = serde_json::json!({
        "event": "session.start.before",
        "asker": asker,
        "start": {"kind": start.kind, "project": start.project, "worktree": start.worktree, "label": start.label},
    });
    gates(home, GateOn::SessionStart, event).map(|_| ()).map_err(|(plugin, reason)| {
        match asker {
            Asker::Owner => format!("{plugin}{STOPPED_START}{reason}"),
            _ => format!(
                "Not started. The plugin \"{plugin}\" refused it: {}. Only the owner can start it anyway.",
                reason.trim_end_matches('.')
            ),
        }
    })
}
/// The words the window reads to offer Start anyway on the owner's start a check stopped.
pub const STOPPED_START: &str = " stopped this start: ";

/// Before a message an agent, a schedule or a token sends is delivered: the text to deliver (replaced or not), or the
/// refusal. Never called for what the owner types.
pub(crate) fn check_send(
    home: &Path,
    asker: Asker,
    to: &str,
    text: &str,
) -> Result<String, String> {
    let event =
        serde_json::json!({"event": "prompt.send.before", "asker": asker, "to": to, "text": text});
    match gates(home, GateOn::PromptSend, event) {
        Ok(Some((plugin, new))) => {
            eprintln!(
                "plugin {plugin} replaced a message to {to} ({} bytes became {})",
                text.len(),
                new.len()
            );
            Ok(new)
        }
        Ok(None) => Ok(text.into()),
        Err((plugin, reason)) => Err(format!(
            "Not sent. The plugin \"{plugin}\" refused it: {reason}"
        )),
    }
}

/// The parts `plugin new --with` can add.
pub const PARTS: [&str; 4] = ["panel", "command", "setting", "gate"];

/// `nunchiro plugin new <id>`: a starter plugin that passes `plugin check`. Writes files only; never replaces any.
pub fn scaffold(home: &Path, id: &str, with: &[&str]) -> Result<PathBuf, String> {
    if !approval::valid_name(id) {
        return Err(
            "invalid plugin id: use a-z, 0-9, - and _ (up to 64, not starting with - or _)".into(),
        );
    }
    if let Some(w) = with.iter().find(|w| !PARTS.contains(w)) {
        return Err(format!("unknown part {w:?}: use {}", PARTS.join(", ")));
    }
    let root = dir(home);
    if root
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("plugins folder must not be a symlink".into());
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .map_err(|e| e.to_string())?;
    let folder = root.join(id);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&folder)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("plugin {id} already exists: {}", folder.display())
            }
            _ => e.to_string(),
        })?;
    let has = |w: &str| with.contains(&w);
    let mut toml = format!(
        "#:schema {SCHEMA_URL}\nid = \"{id}\"\nname = \"{id}\"\nversion = \"0.1.0\"\nabout = \"What this plugin does, in one line.\"\n"
    );
    let mut files: Vec<(&str, &str, u32)> = vec![];
    if has("setting") {
        toml.push_str("\n[[setting]]\nkey = \"greeting\"\nlabel = \"Greeting\"\ntype = \"text\"\ndefault = \"Hello\"\n");
    }
    if has("panel") {
        toml.push_str("\n[[panel]]\nname = \"main\"\ntitle = \"Projects and agents\"\nkind = \"script\"\ncommand = [\"/bin/sh\", \"panel.sh\"]\ninterval_secs = 60\n");
        files.push(("panel.sh", PANEL_SH, 0o700));
    }
    if has("command") {
        toml.push_str("\n[[command]]\nname = \"hello\"\ntitle = \"Say hello\"\ncommand = [\"/bin/sh\", \"command.sh\"]\nshow = \"note\"\n");
        files.push(("command.sh", COMMAND_SH, 0o700));
    }
    if has("gate") {
        toml.push_str("\n[[gate]]\nname = \"start\"\ntitle = \"Before a new session starts\"\non = \"session.start.before\"\ncommand = [\"/bin/sh\", \"gate.sh\"]\non_error = \"allow\"\n");
        files.push(("gate.sh", GATE_SH, 0o700));
    }
    files.push((MANIFEST, &toml, 0o600));
    for (file, text, mode) in files {
        use std::io::Write;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(folder.join(file))
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .map_err(|e| e.to_string())?;
    }
    Ok(folder)
}
const PANEL_SH: &str = "#!/bin/sh\n# A panel: runs in a sandbox once the plugin is approved and on. $NUNCHIRO_CONTEXT is a JSON file with\n# projects, sessions and this plugin's settings; $NUNCHIRO_PROJECT_DIR is the project, if any.\n# Print text, or JSON (an array of objects shows as a table).\ncd \"$NUNCHIRO_PROJECT_DIR\" 2>/dev/null || { echo \"no project\"; exit 0; }\n/bin/ls -1 | /usr/bin/head -20\n";
const GATE_SH: &str = "#!/bin/sh\n# A check: runs before a new session starts. $NUNCHIRO_CONTEXT has event, asker (owner, agent, schedule, token),\n# start (kind, project, worktree, label) and settings. Print {\"allow\": true}, or {\"allow\": false, \"reason\": \"one line\"}.\nprintf '{\"allow\": true}\\n'\n";
const COMMAND_SH: &str = "#!/bin/sh\n# A command: a row in the command palette; what it prints shows as a note (show = \"note\").\ngreeting=$(/usr/bin/sed -n 's/.*\"greeting\":\"\\([^\"]*\\)\".*/\\1/p' \"$NUNCHIRO_CONTEXT\")\necho \"${greeting:-Hello} from a plugin command.\"\n";

#[cfg(test)]
mod tests;
