//! Script widgets (ticket v1b-19): folders under `~/.nunchiro/widgets/<name>/` whose approved `widget.toml`
//! command runs through the shared sandbox runner. Owner only: the window and the token-less CLI reach
//! `widget_list` and `widget_run`; a session token never does (`grants::request_target` names no widget op).
//!
//! The run is window-driven: a visible placement calls `run`; this module enforces the interval per
//! (widget, project), never overlaps runs of one widget, and answers early calls from the cache.
// v1b-20
pub mod act;
pub mod web; // v1b-22
use crate::{
    api::{Reply, Request, Response, Session, SessionState},
    approval,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const OFF: &str =
    "script widgets are off until security review (settings.json `script_widgets`)";
/// Seconds between runs when the manifest names no interval, and the floor for any interval.
pub const DEFAULT_INTERVAL_SECS: u64 = 60;
pub const MIN_INTERVAL_SECS: u64 = 10;
/// Extra environment a run gets on top of the runner's list; nothing else is added.
pub use crate::sandbox::EXTRA_ENV as ENV_KEYS;
/// Every core request the window makes for widgets (web/src/widgets and the permission sheet).
pub const WINDOW_REQUESTS: [&str; 10] = [
    "widget_list",
    "widget_run",
    "widget_act",  // v1b-20
    "widget_page", // v1b-22
    "approval_status",
    "approval_grant",
    "board_source_status", // v1a-23 r2: the sheet also reviews integration sources
    "board_source_grant",
    "setup_status", // ticket 259: the sheet also reviews a repo's worktree setup script
    "setup_grant",
];

/// How runs are confined. `core` reads the user's HOME; tests point it at a fake home or sandbox.
#[derive(Debug, Clone)]
pub struct Config {
    pub enabled: bool,
    pub user_home: PathBuf,
    pub executable: PathBuf,
    pub timeout: Duration,
    /// v1b-21: a run is refused while the widget's cache holds more than this many bytes (default 64 MiB).
    pub cache_limit: u64,
}
impl Config {
    pub fn new(enabled: bool, user_home: PathBuf) -> Self {
        let p = crate::sandbox::Profile::new(PathBuf::new(), PathBuf::new(), PathBuf::new());
        Self {
            enabled,
            user_home,
            executable: p.executable,
            timeout: p.timeout,
            cache_limit: p.cache_limit, // v1b-21
        }
    }
    fn core(enabled: bool) -> Result<Self, String> {
        let home = std::env::var_os("HOME").ok_or("HOME missing; script widgets disabled")?;
        Ok(Self::new(enabled, home.into()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct List {
    pub enabled: bool,
    /// "script widgets unavailable: <reason>" when the sandbox is missing or failed its self-check.
    pub unavailable: Option<String>,
    pub widgets: Vec<Listed>,
    /// v1b-22: the `web_widgets` setting (`enabled` and `unavailable` are about script widgets only).
    #[serde(default)]
    pub web_enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "WidgetsListed"))]
pub struct Listed {
    pub name: String,
    /// Absent when the folder cannot be read or its manifest does not parse (`error` says why).
    pub state: Option<approval::State>,
    pub kind: Option<String>,
    pub author: Option<String>,
    pub interval_secs: Option<u64>,
    pub error: Option<String>,
    /// v1b-20: the `[act]` table while the widget holds a current act grant; rows are clickable only then.
    #[serde(default)]
    pub act: Option<approval::Act>,
}

/// What a widget printed, never truncated: `json` when the whole output parses as JSON (sent as printed, so
/// the window keeps key order for table columns), else `text`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "format", rename_all = "snake_case")]
pub enum Output {
    Text { text: String },
    Json { text: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "WidgetsRun"))]
pub struct Run {
    pub name: String,
    /// Display name of the project the run saw; absent = no project.
    pub project: Option<String>,
    pub ran_at_ms: u64,
    pub interval_secs: u64,
    /// Another caller's run of this widget is in progress; this is the last cached result.
    pub running: bool,
    pub output: Option<Output>,
    pub error: Option<String>,
}

/// `context.json`: project display names and the session list with states; no paths, ids, transcripts or tokens.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub projects: Vec<ContextProject>,
    pub sessions: Vec<ContextSession>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ContextProject {
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ContextSession {
    pub label: String,
    pub project: String,
    pub state: SessionState,
}
#[derive(Debug, Clone)]
pub struct Project {
    pub name: String,
    pub dir: PathBuf,
}

fn display(dir: &Path) -> String {
    dir.file_name()
        .map_or_else(|| dir.display().to_string(), |n| n.to_string_lossy().into())
}
pub fn context(sessions: &[Session]) -> Context {
    let mut projects: Vec<ContextProject> = vec![];
    for s in sessions {
        let name = display(&s.project);
        if !projects.iter().any(|p| p.name == name) {
            projects.push(ContextProject { name });
        }
    }
    Context {
        projects,
        sessions: sessions
            .iter()
            .map(|s| ContextSession {
                label: s.label.clone(),
                project: display(&s.project),
                state: s.state,
            })
            .collect(),
    }
}
/// The project of the session the placement is pinned to or follows; none without a session.
pub fn project(sessions: &[Session], session: Option<&str>) -> Result<Option<Project>, String> {
    let Some(id) = session else { return Ok(None) };
    let s = sessions
        .iter()
        .find(|s| s.id == id)
        .ok_or("session not found")?;
    Ok(Some(Project {
        name: display(&s.project),
        dir: s.project.clone(),
    }))
}

fn widgets_dir(home: &Path) -> PathBuf {
    home.join("widgets")
}

/// A missing sandbox is known without running; a failed self-check is remembered from the first run.
fn unavailable(config: &Config) -> Option<String> {
    if !config.executable.is_file() {
        return Some(format!(
            "script widgets unavailable: {} not found",
            config.executable.display()
        ));
    }
    failed().lock().ok()?.get(&config.executable).cloned()
}
fn failed() -> &'static Mutex<BTreeMap<PathBuf, String>> {
    static FAILED: OnceLock<Mutex<BTreeMap<PathBuf, String>>> = OnceLock::new();
    FAILED.get_or_init(Default::default)
}

pub fn list(home: &Path, config: &Config) -> List {
    let mut widgets = vec![];
    let dir = widgets_dir(home);
    let linked = dir
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink());
    let mut names: Vec<String> = if linked {
        vec![]
    } else {
        fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect()
    };
    names.sort();
    for name in names {
        widgets.push(match approval::status(home, &name) {
            Ok(v) => Listed {
                name,
                state: Some(v.state),
                kind: Some(v.manifest.kind),
                author: Some(v.manifest.author),
                interval_secs: v.manifest.interval_secs,
                error: None,
                // v1b-20
                act: v.manifest.act.clone().filter(|_| {
                    v.state == approval::State::Approved && v.level == Some(approval::Level::Act)
                }),
            },
            Err(e) => Listed {
                name,
                state: None,
                kind: None,
                author: None,
                interval_secs: None,
                error: Some(e),
                act: None, // v1b-20
            },
        });
    }
    List {
        enabled: config.enabled,
        unavailable: if linked {
            Some("script widgets unavailable: widgets folder must not be a symlink".into())
        } else {
            unavailable(config)
        },
        widgets,
        web_enabled: false, // v1b-22: set by `handle` from the setting
    }
}

const ANSWER: Duration = Duration::from_millis(250);
/// The cached run of `name` for `project`, marked running (a run started by this or another caller is in progress).
fn in_progress(home: &Path, name: &str, project: Option<Project>) -> Run {
    let key = (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        name.to_string(),
    );
    let place = project.as_ref().map(|p| p.dir.clone());
    let cached = states()
        .lock()
        .ok()
        .and_then(|all| all.get(&key)?.cache.get(&place).map(|c| c.run.clone()));
    Run {
        running: true,
        ..cached.unwrap_or(Run {
            name: name.into(),
            project: project.map(|p| p.name),
            ran_at_ms: 0,
            interval_secs: 0,
            running: true,
            output: None,
            error: None,
        })
    }
}

#[derive(Default)]
struct State {
    running: bool,
    cache: BTreeMap<Option<PathBuf>, Cached>,
}
struct Cached {
    started: Instant,
    hash: String,
    run: Run,
}
fn states() -> &'static Mutex<BTreeMap<(PathBuf, String), State>> {
    static STATES: OnceLock<Mutex<BTreeMap<(PathBuf, String), State>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

// v1b-20: the run an act renders from, only while it is the cached run of the same approved content.
pub(crate) fn cached_output(
    home: &Path,
    name: &str,
    project: &Path,
    hash: &str,
    ran_at_ms: u64,
) -> Option<Output> {
    let key = (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        name.to_string(),
    );
    let all = states().lock().ok()?;
    let c = all.get(&key)?.cache.get(&Some(project.to_path_buf()))?;
    (c.hash == hash && c.run.ran_at_ms == ran_at_ms && c.run.error.is_none())
        .then(|| c.run.output.clone())
        .flatten()
}

/// Runs `name` for `project` when it is approved and due; otherwise returns the cached run.
pub fn run(
    home: &Path,
    config: &Config,
    name: &str,
    project: Option<Project>,
    context: &Context,
) -> Result<Run, String> {
    if !config.enabled {
        return Err(OFF.into());
    }
    if let Some(reason) = unavailable(config) {
        return Err(reason);
    }
    let proof = approval::check(home, name).map_err(|e| format!("needs approval: {e}"))?;
    if proof.manifest().kind != "script" {
        return Err(format!("{name} is not a script widget"));
    }
    let interval = proof
        .interval_secs()
        .unwrap_or(DEFAULT_INTERVAL_SECS)
        .max(MIN_INTERVAL_SECS);
    let key = (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        name.to_string(),
    );
    let place = project.as_ref().map(|p| p.dir.clone());
    {
        let mut all = states().lock().map_err(|_| "widget state unavailable")?;
        let state = all.entry(key.clone()).or_default();
        let cached = state.cache.get(&place).filter(|c| c.hash == proof.hash());
        if let Some(c) = cached
            && (state.running || c.started.elapsed() < Duration::from_secs(interval))
        {
            return Ok(Run {
                running: state.running,
                ..c.run.clone()
            });
        }
        if state.running {
            return Ok(Run {
                name: name.into(),
                project: project.map(|p| p.name),
                ran_at_ms: 0,
                interval_secs: interval,
                running: true,
                output: None,
                error: None,
            });
        }
        state.running = true;
    }
    struct Release((PathBuf, String));
    impl Drop for Release {
        fn drop(&mut self) {
            if let Ok(mut all) = states().lock()
                && let Some(s) = all.get_mut(&self.0)
            {
                s.running = false;
            }
        }
    }
    let _release = Release(key.clone());
    let started = Instant::now();
    let ran_at_ms = crate::queue::now_ms();
    let cache = widgets_dir(home).join(name).join("cache");
    let result = execute(home, config, &proof, &cache, project.as_ref(), context);
    if let Err(e) = &result
        && e.starts_with("script widgets unavailable")
    {
        if let Ok(mut f) = failed().lock() {
            f.insert(config.executable.clone(), e.clone());
        }
        return Err(e.clone());
    }
    let (output, error) = match result {
        Ok(o) => (Some(o), None),
        Err(e) => (None, Some(e)),
    };
    let run = Run {
        name: name.into(),
        project: project.map(|p| p.name),
        ran_at_ms,
        interval_secs: interval,
        running: false,
        output,
        error,
    };
    let mut all = states().lock().map_err(|_| "widget state unavailable")?;
    all.entry(key).or_default().cache.insert(
        place,
        Cached {
            started,
            hash: proof.hash().into(),
            run: run.clone(),
        },
    );
    Ok(run)
}

fn execute(
    home: &Path,
    config: &Config,
    proof: &approval::Proof,
    cache: &Path,
    project: Option<&Project>,
    context: &Context,
) -> Result<Output, String> {
    // The cache sits beside the hashed files (`cache` is skipped by the folder hash) and must stay a real folder.
    if cache
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("widget cache must not be a symlink".into());
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(cache)
        .map_err(|e| e.to_string())?;
    let file = cache.join("context.json");
    // A rename replaces whatever the last run left at this name (even a symlink) without following it.
    let bytes = serde_json::to_vec(context).map_err(|e| e.to_string())?;
    crate::store::atomic_write(&file, &bytes)?;
    let mut env = vec![(ENV_KEYS[0], file.into_os_string())];
    if let Some(p) = project {
        env.push((ENV_KEYS[1], p.dir.clone().into_os_string()));
    }
    let mut profile =
        crate::sandbox::Profile::new(home.into(), cache.into(), config.user_home.clone());
    profile.executable = config.executable.clone();
    profile.timeout = config.timeout;
    profile.cache_limit = config.cache_limit; // v1b-21
    // v1b-33: the project and the approved `read` paths; blocked folders stay denied in the profile.
    let declared = proof.read().iter();
    let declared = declared.map(|e| approval::expand(e, &config.user_home));
    profile.read = Some(
        project
            .map(|p| p.dir.clone())
            .into_iter()
            .chain(declared)
            .collect(),
    );
    let limit = profile.output_limit;
    let bytes = crate::sandbox::run_env(&profile, proof, &env).map_err(|e| {
        if e.starts_with("sandbox self-check") || e.starts_with("sandbox spawn") {
            format!("script widgets unavailable: {e}")
        } else if e == "sandbox output cap exceeded" {
            format!("output over {} MiB", limit / (1024 * 1024))
        } else if e == "sandbox timeout or output cap exceeded" {
            format!("timed out after {} s", config.timeout.as_secs())
        } else {
            e
        }
    })?;
    Ok(parse(&bytes))
}

pub fn parse(bytes: &[u8]) -> Output {
    let text = String::from_utf8_lossy(bytes).into_owned();
    if serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok() {
        Output::Json { text }
    } else {
        Output::Text { text }
    }
}

/// `nunchiro widget new <name>`: creates the folder with a starter manifest and script. Never replaces
/// anything; the new widget starts unapproved like any other folder.
pub fn scaffold(home: &Path, name: &str, author: Option<&str>) -> Result<PathBuf, String> {
    if !approval::valid_name(name) {
        return Err(
            "invalid widget name: use a-z, 0-9, - and _ (up to 64, not starting with - or _)"
                .into(),
        );
    }
    let dir = widgets_dir(home);
    match dir.symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => {
            return Err("widgets folder must not be a symlink".into());
        }
        Ok(_) => {}
        Err(_) => fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| e.to_string())?,
    }
    let folder = dir.join(name);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&folder)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("widget {name} already exists: {}", folder.display())
            }
            _ => e.to_string(),
        })?;
    let author = author.map_or(String::new(), |a| {
        format!("author = {}\n", toml::Value::String(a.into()))
    });
    let manifest = format!(
        "version = 1\nkind = \"script\"\n{author}command = [\"/bin/sh\", \"widget.sh\"]\ninterval = 60\npermissions = [\"read\"]\nnetwork = []\n"
    );
    // v1b-21: the cache is $NUNCHIRO_CACHE, not $HOME. v1b-33: reads are scoped.
    let script = "#!/bin/sh\n# Runs in a sandbox after you allow it: writes only to $NUNCHIRO_CACHE (this widget's cache; $HOME is empty\n# and new each run), network only to hosts listed in widget.toml, reads only the project, this cache and system\n# tools unless widget.toml lists more in read = [\"~/folder\"]. $NUNCHIRO_CONTEXT is a JSON file with project names and sessions.\n# Print text, or JSON (an array of objects shows as a table).\ncd \"$NUNCHIRO_PROJECT_DIR\" 2>/dev/null || { echo \"no project\"; exit 0; }\n/bin/ls -1 | /usr/bin/head -20\n";
    for (file, text, mode) in [
        ("widget.toml", manifest.as_str(), 0o600),
        ("widget.sh", script, 0o700),
    ] {
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

/// Owner-only dispatch for `widget_list` and `widget_run` (server.rs and http/mod.rs, after their auth
/// checks). Session data is read under the registry lock; listing and running happen after it is released.
pub(crate) fn handle(
    home: &Path,
    mut sessions: std::sync::MutexGuard<'_, crate::sessions::Sessions>,
    request: Request,
) -> Response {
    let config = Config::core(sessions.script_widgets())?;
    match request {
        Request::WidgetList => {
            let web_enabled = sessions.web_widgets(); // v1b-22
            drop(sessions);
            Ok(Reply::Widgets {
                list: List {
                    web_enabled, // v1b-22
                    ..list(home, &config)
                },
            })
        }
        // v1b-22
        Request::WidgetPage { name } => {
            let Reply::Snapshot { sessions: all, .. } = sessions.handle(Request::Snapshot)? else {
                return Err("unexpected snapshot reply".into());
            };
            let enabled = sessions.web_widgets();
            drop(sessions);
            web::page(home, enabled, &name, context(&all)).map(|page| Reply::WidgetPage { page })
        }
        Request::WidgetRun { name, session } => {
            let Reply::Snapshot { sessions: all, .. } = sessions.handle(Request::Snapshot)? else {
                return Err("unexpected snapshot reply".into());
            };
            drop(sessions);
            let target = project(&all, session.as_deref())?;
            let place = target.clone();
            // A window serves its frames one at a time: answer within ANSWER and let a longer run finish in the
            // background, cached for the next call (which reports `running` until then).
            let (send, receive) = std::sync::mpsc::channel();
            let (home_, name_) = (home.to_path_buf(), name.clone());
            std::thread::spawn(move || {
                let _ = send.send(run(&home_, &config, &name_, target, &context(&all)));
            });
            match receive.recv_timeout(ANSWER) {
                Ok(result) => result,
                Err(_) => Ok(in_progress(home, &name, place)),
            }
            .map(|run| Reply::WidgetRun { run })
        }
        _ => Err("not a widget request".into()),
    }
}
