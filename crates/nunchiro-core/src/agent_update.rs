//! Ticket 358: a tool's update and its new-version mark. `TABLE` is the only place an update command or a latest-version
//! source exists: Rust, one entry per tool, each confirmed in that tool's own docs, selected by the `Tool` enum alone. A
//! command is an argument array run without a shell, and nothing from the network, the window or a settings file reaches
//! it. An entry runs only when the installed binary's real path proves the install kind the command updates; a Homebrew
//! or npm Claude would otherwise run the wrong updater.
//!
//! Behaviour taken from T3 Code (no code): apps/server/src/provider/providerMaintenanceRunner.ts (5-minute cap, capped
//! output, sampled text, unchanged versus succeeded) and packages/provider-core/src/server/ProviderLatestVersions.ts
//! (1 h for a found version, 1 min for a missing one). T3 has no cancel; that part is ours. Update groups share the
//! sign-in records folder, so `account_signin::sweep` ends what a crashed core left.
use crate::{
    account_signin as signin,
    api::{Reply, Request, Response},
    firstrun,
    themes_online::Client,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Claude,
    Codex,
    Gemini,
    Opencode,
    Goose,
    Aider,
    Cursor,
    Grok,
    Antigravity,
}

/// The install an update command belongs to, proved from the binary's real path.
enum Install {
    /// The real path is at or under this folder of the user's home; the tool updates itself.
    Under(&'static str),
    /// The real path is inside `<prefix>/lib/node_modules/<package>/`; `<prefix>/bin/npm` runs the arguments.
    NpmGlobal(&'static str),
}

struct Update {
    args: &'static [&'static str],
    install: Install,
}

struct Entry {
    tool: Tool,
    binary: &'static str,
    /// `None`: no command confirmed in the tool's own docs, so no update.
    update: Option<Update>,
    /// The npm package whose `latest` the tool's docs name; `None`: no confirmed source, so no mark.
    latest: Option<&'static str>,
}

const TABLE: &[Entry] = &[
    // code.claude.com/docs/en/cli-reference and /setup: `claude update`; the launcher links into this folder.
    Entry {
        tool: Tool::Claude,
        binary: "claude",
        update: Some(Update {
            args: &["update"],
            install: Install::Under(".local/share/claude"),
        }),
        latest: Some("@anthropic-ai/claude-code"),
    },
    // developers.openai.com/codex/cli/reference: `codex update`; the standalone installer's tree is this folder.
    Entry {
        tool: Tool::Codex,
        binary: "codex",
        update: Some(Update {
            args: &["update"],
            install: Install::Under(".codex/packages/standalone"),
        }),
        latest: Some("@openai/codex"),
    },
    // github.com/google-gemini/gemini-cli README.
    Entry {
        tool: Tool::Gemini,
        binary: "gemini",
        update: Some(Update {
            args: &["install", "-g", "@google/gemini-cli@latest"],
            install: Install::NpmGlobal("@google/gemini-cli"),
        }),
        latest: Some("@google/gemini-cli"),
    },
    // github.com/anomalyco/opencode README.
    Entry {
        tool: Tool::Opencode,
        binary: "opencode",
        update: Some(Update {
            args: &["i", "-g", "@opencode/cli@latest"],
            install: Install::NpmGlobal("@opencode/cli"),
        }),
        latest: Some("@opencode/cli"),
    },
    // goose-docs.ai/docs/guides/goose-cli-commands: `goose update`; download_cli.sh installs this file.
    Entry {
        tool: Tool::Goose,
        binary: "goose",
        update: Some(Update {
            args: &["update"],
            install: Install::Under(".local/bin/goose"),
        }),
        latest: None,
    },
    // cursor.com/docs/cli/installation: `agent update`; cursor.com/install links the launcher into this folder.
    Entry {
        tool: Tool::Cursor,
        binary: "agent",
        update: Some(Update {
            args: &["update"],
            install: Install::Under(".local/share/cursor-agent/versions"),
        }),
        latest: None,
    },
    Entry {
        tool: Tool::Aider,
        binary: "aider",
        update: None,
        latest: None,
    },
    Entry {
        tool: Tool::Grok,
        binary: "grok",
        update: None,
        latest: None,
    },
    Entry {
        tool: Tool::Antigravity,
        binary: "agy",
        update: None,
        latest: None,
    },
];

/// What the window shows for one tool found on the PATH.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AgentUpdateRow"))]
pub struct Row {
    pub tool: Tool,
    pub path: String,
    pub installed: Option<String>,
    pub latest: Option<String>,
    /// `latest` is strictly above `installed`.
    pub newer: bool,
    pub can_update: bool,
    /// Display text for 명령 복사, only when `can_update`. The runner never reads it; `start` takes the tool alone.
    pub command: Option<String>,
    /// Tools naming the same installer must not update at once (`start` refuses the second); `None`: the tool updates itself.
    pub installer: Option<String>,
    pub run: Option<View>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AgentUpdateView"))]
pub struct View {
    pub phase: Phase,
    /// The last line the updater printed, sampled; installers report no percent.
    pub text: String,
    pub reason: Option<Reason>,
    pub code: Option<i32>,
}

/// A finished update that worked or was cancelled has no run: the row is back on its version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AgentUpdatePhase"))]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Running,
    Failed,
    /// The command exited 0 but the version did not change.
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "AgentUpdateReason"))]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Exited,
    TimedOut,
    StartFailed,
}

struct Run {
    view: View,
    /// The updater's process group while its leader is not yet reaped (so the id cannot have been reused).
    group: Option<i32>,
    cancel: bool,
    /// A failed or unchanged run stays until the next start or a core restart.
    ended: bool,
    npm: bool,
}

struct Info {
    path: String,
    installed: Option<String>,
    latest: Option<String>,
    can_update: bool,
    command: Option<String>,
    installer: Option<String>,
}

#[derive(Default)]
struct Store {
    runs: HashMap<Tool, Run>,
    info: HashMap<Tool, Info>,
    latest: HashMap<Tool, (Option<String>, Instant)>,
    reading: bool,
    read_at: Option<Instant>,
    /// An update ended during a read, so that read's versions may be old.
    stale: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

const TIMEOUT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(100);
const SAMPLE: Duration = Duration::from_secs(1);
const MAX_TEXT: usize = 200;
const READ_EVERY: Duration = Duration::from_secs(30);
const FOUND_FOR: Duration = Duration::from_secs(3600);
const MISSING_FOR: Duration = Duration::from_secs(60);
const LOOKUP_TOTAL: Duration = Duration::from_secs(8);
/// The largest `latest` answer read; a package's manifest is a few KB.
const LATEST_CAP: usize = 256 * 1024;

fn with<T>(f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let mut guard = STORE.lock().map_err(|_| "update list unavailable")?;
    Ok(f(guard.get_or_insert_with(Store::default)))
}

fn entry(tool: Tool) -> &'static Entry {
    TABLE
        .iter()
        .find(|e| e.tool == tool)
        .expect("every tool has a table entry")
}

/// Updates that have not ended; an unreadable list counts as one, so a core swap waits rather than cuts one.
pub(crate) fn running() -> usize {
    with(|s| s.runs.values().filter(|r| !r.ended).count()).unwrap_or(1)
}

/// The core is stopping: every update's group goes now.
pub(crate) fn stop_all() {
    let _ = with(|s| {
        for run in s.runs.values_mut() {
            run.cancel = true;
            if let Some(group) = run.group.take() {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
    });
}

/// Owner and window only: `check_agent`, the remote list and the browser role refuse these before this runs.
pub(crate) fn handle(home: &Path, request: Request) -> Response {
    match request {
        Request::AgentUpdateStart { tool } => start(home, tool),
        Request::AgentUpdateCancel { tool } => with(|s| {
            let run = s
                .runs
                .get_mut(&tool)
                .filter(|r| !r.ended)
                .ok_or("no update is running")?;
            run.cancel = true;
            Ok(Reply::Ack)
        })?,
        Request::AgentUpdateState => state(),
        _ => Err("not an update request".into()),
    }
}

fn state() -> Response {
    with(|s| {
        if !s.reading && s.read_at.is_none_or(|t| t.elapsed() >= READ_EVERY) {
            s.reading = true;
            s.stale = false;
            thread::spawn(read_all);
        }
        let rows = TABLE
            .iter()
            .filter_map(|e| {
                let info = s.info.get(&e.tool)?;
                Some(Row {
                    tool: e.tool,
                    path: info.path.clone(),
                    installed: info.installed.clone(),
                    latest: info.latest.clone(),
                    newer: newer(info.latest.as_deref(), info.installed.as_deref()),
                    can_update: info.can_update,
                    command: info.command.clone(),
                    installer: info.installer.clone(),
                    run: s.runs.get(&e.tool).map(|r| r.view.clone()),
                })
            })
            .collect();
        Reply::AgentUpdates {
            rows,
            checked: s.read_at.is_some() || s.stale,
        }
    })
}

/// Off the frame loop: each found tool's `--version` (only the table's own name on the PATH, as the Accounts listing
/// runs) and its latest version. A tool that is not installed is never looked up.
fn read_all() {
    let found: Vec<(Tool, Info)> = thread::scope(|scope| {
        let reads: Vec<_> = TABLE
            .iter()
            .map(|e| scope.spawn(move || Some((e.tool, read(e)?))))
            .collect();
        reads
            .into_iter()
            .filter_map(|r| r.join().ok().flatten())
            .collect()
    });
    let _ = with(|s| {
        s.info = found.into_iter().collect();
        s.reading = false;
        s.read_at = (!s.stale).then(Instant::now);
    });
}

fn read(e: &Entry) -> Option<Info> {
    let path = firstrun::on_path(e.binary)?;
    let proven = program(e, &path).is_some();
    Some(Info {
        installed: installed(&path),
        latest: e.latest.and_then(|package| latest(e.tool, package)),
        can_update: proven,
        command: proven.then(|| command(e)).flatten(),
        installer: proven.then(|| installer(e)).flatten(),
        path: path.display().to_string(),
    })
}

/// The table's command as words to read or paste.
fn command(e: &Entry) -> Option<String> {
    let update = e.update.as_ref()?;
    let program = installer(e).unwrap_or_else(|| e.binary.to_string());
    Some(format!("{program} {}", update.args.join(" ")))
}

fn installer(e: &Entry) -> Option<String> {
    match e.update.as_ref()?.install {
        Install::NpmGlobal(_) => Some("npm".into()),
        Install::Under(_) => None,
    }
}

fn installed(path: &Path) -> Option<String> {
    let text = firstrun::version(path)?;
    text.split_whitespace()
        .map(|t| t.trim_start_matches('v'))
        .find(|t| parts(t).is_some())
        .map(str::to_string)
}

/// A strict dotted version: 2 to 4 numeric parts and nothing else. All that is ever taken from a lookup's answer.
fn parts(version: &str) -> Option<[u64; 4]> {
    let mut out = [0; 4];
    let mut count = 0;
    for part in version.split('.') {
        if count == 4
            || part.is_empty()
            || part.len() > 9
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        out[count] = part.parse().ok()?;
        count += 1;
    }
    (count >= 2).then_some(out)
}

fn newer(latest: Option<&str>, installed: Option<&str>) -> bool {
    match (latest.and_then(parts), installed.and_then(parts)) {
        (Some(latest), Some(installed)) => latest > installed,
        _ => false,
    }
}

fn latest(tool: Tool, package: &str) -> Option<String> {
    let cached = with(|s| s.latest.get(&tool).cloned()).ok().flatten();
    if let Some((value, at)) = cached {
        let keep = if value.is_some() {
            FOUND_FOR
        } else {
            MISSING_FOR
        };
        if at.elapsed() < keep {
            return value;
        }
    }
    let value = fetch_latest(package);
    let _ = with(|s| s.latest.insert(tool, (value.clone(), Instant::now())));
    value
}

/// HTTPS only, no redirects, a byte cap and a deadline (`Client::get`).
fn fetch_latest(package: &str) -> Option<String> {
    let client = Client::new(&registry(), LOOKUP_TOTAL).ok()?;
    let body = client.get(&format!("{package}/latest"), LATEST_CAP).ok()?;
    let answer: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let version = answer.get("version")?.as_str()?;
    parts(version).map(|_| version.to_string())
}

/// The npm registry. A debug build's tests may name a fake; `Client` still takes only https or debug-build loopback.
fn registry() -> String {
    if cfg!(debug_assertions)
        && let Ok(origin) = std::env::var("NUNCHIRO_UPDATE_REGISTRY")
    {
        return origin;
    }
    "https://registry.npmjs.org/".into()
}

/// The program that updates this install, when the binary's real path proves the install kind the entry's command is for.
fn program(e: &Entry, found: &Path) -> Option<PathBuf> {
    let update = e.update.as_ref()?;
    let real = fs::canonicalize(found).ok()?;
    match update.install {
        Install::Under(folder) => {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            // A link here would make its target (a Homebrew binary, say) count as this install.
            if fs::symlink_metadata(home.join(folder)).ok()?.is_symlink() {
                return None;
            }
            let root = fs::canonicalize(home.join(folder)).ok()?;
            real.starts_with(root).then(|| found.to_path_buf())
        }
        Install::NpmGlobal(package) => {
            let (prefix, _) = real
                .to_str()?
                .split_once(&format!("/lib/node_modules/{package}/"))?;
            firstrun::in_paths(Path::new(prefix).join("bin").as_os_str(), "npm")
        }
    }
}

fn start(home: &Path, tool: Tool) -> Response {
    let e = entry(tool);
    let update = e
        .update
        .as_ref()
        .ok_or("no confirmed update command for this tool")?;
    let found = firstrun::on_path(e.binary).ok_or("this tool is not installed")?;
    let program = program(e, &found).ok_or("this install is not one its update command is for")?;
    let npm = matches!(update.install, Install::NpmGlobal(_));
    // Before the run is recorded: a failure after it would leave a run that never ends (Q9 ja-J16-1).
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    with(|s| {
        if s.runs.get(&tool).is_some_and(|r| !r.ended) {
            return Err("this tool is already updating".to_string());
        }
        // Two `npm -g` writing one prefix can leave either package broken.
        if npm && s.runs.values().any(|r| !r.ended && r.npm) {
            return Err("another npm update is running".to_string());
        }
        s.runs.insert(
            tool,
            Run {
                view: View {
                    phase: Phase::Running,
                    text: String::new(),
                    reason: None,
                    code: None,
                },
                group: None,
                cancel: false,
                ended: false,
                npm,
            },
        );
        Ok(())
    })??;
    let args = update.args;
    thread::spawn(move || run(&home, tool, &found, &program, args));
    Ok(Reply::Ack)
}

enum End {
    Exited(Option<i32>),
    Cancelled,
    TimedOut,
    StartFailed,
}

fn run(home: &Path, tool: Tool, found: &Path, program: &Path, args: &[&str]) {
    let before = installed(found);
    let (end, text) = update(home, tool, program, args);
    let after = matches!(end, End::Exited(Some(0)))
        .then(|| installed(found))
        .flatten();
    let changed = after.is_some() && after != before;
    let _ = with(|s| {
        s.stale = true;
        s.read_at = None;
        if let (Some(version), Some(info)) = (&after, s.info.get_mut(&tool)) {
            info.installed = Some(version.clone());
        }
        let (phase, reason, code) = match end {
            End::Exited(Some(0)) if changed => {
                s.runs.remove(&tool);
                return;
            }
            End::Cancelled => {
                s.runs.remove(&tool);
                return;
            }
            End::Exited(Some(0)) => (Phase::Unchanged, None, None),
            End::Exited(code) => (Phase::Failed, Some(Reason::Exited), code),
            End::TimedOut => (Phase::Failed, Some(Reason::TimedOut), None),
            End::StartFailed => (Phase::Failed, Some(Reason::StartFailed), None),
        };
        if let Some(run) = s.runs.get_mut(&tool) {
            run.view = View {
                phase,
                text,
                reason,
                code,
            };
            run.ended = true;
        }
    });
}

fn update(home: &Path, tool: Tool, program: &Path, args: &[&str]) -> (End, String) {
    let mut command = crate::process::command(program);
    command.args(args);
    // The env a login gets: the core's, minus the launching session's identity and every account override and key.
    for (k, _) in std::env::vars_os().filter(|(k, _)| crate::sessions::is_parent_session_env(k)) {
        command.env_remove(k);
    }
    for k in crate::sessions::ACCOUNT_ENV
        .iter()
        .chain(&["NUNCHIRO_TOKEN", "NUNCHIRO_SESSION"])
    {
        command.env_remove(k);
    }
    if let Some(user) = std::env::var_os("HOME") {
        command.current_dir(user);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let Ok(child) = command.spawn() else {
        return (End::StartFailed, String::new());
    };
    let record = signin::record(home, child.id() as i32);
    let ended = watch(tool, child);
    if let Some(record) = record {
        record.remove();
    }
    ended
}

/// Runs the updater until it exits, is cancelled or times out. A cancel or timeout ends its whole group.
fn watch(tool: Tool, mut child: Child) -> (End, String) {
    let scan = Arc::new(Mutex::new(String::new()));
    let drains: Vec<_> = [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|out| {
        let scan = scan.clone();
        thread::spawn(move || signin::drain(out, &scan))
    })
    .collect();
    let group = child.id() as i32;
    let _ = with(|s| {
        if let Some(run) = s.runs.get_mut(&tool) {
            run.group = Some(group);
            // A stop that ran before the group was known could not end it: do it here.
            if run.cancel {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
    });
    let started = Instant::now();
    let timeout = signin::wait("NUNCHIRO_UPDATE_TIMEOUT_MS", TIMEOUT);
    let mut sampled = started - SAMPLE;
    let end = loop {
        if signin::exited(&child) {
            break End::Exited(reap(tool, &mut child));
        }
        if with(|s| s.runs.get(&tool).is_none_or(|r| r.cancel)).unwrap_or(true) {
            break stop(tool, &mut child, End::Cancelled);
        }
        if started.elapsed() >= timeout {
            break stop(tool, &mut child, End::TimedOut);
        }
        if sampled.elapsed() >= SAMPLE {
            sampled = Instant::now();
            let text = last_line(&scan);
            let _ = with(|s| {
                if let Some(run) = s.runs.get_mut(&tool) {
                    run.view.text = text;
                }
            });
        }
        thread::sleep(POLL);
    };
    // A child the updater left may hold the pipes open, so the last output gets a moment, not a join.
    let until = Instant::now() + Duration::from_millis(500);
    while Instant::now() < until && !drains.iter().all(|d| d.is_finished()) {
        thread::sleep(Duration::from_millis(10));
    }
    (end, last_line(&scan))
}

fn stop(tool: Tool, child: &mut Child, end: End) -> End {
    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    reap(tool, child);
    end
}

/// Forgets the group under the lock, then reaps the leader: `stop_all` never signals a reaped (reusable) id.
fn reap(tool: Tool, child: &mut Child) -> Option<i32> {
    let _ = with(|s| s.runs.get_mut(&tool).map(|r| r.group = None));
    child.wait().ok().and_then(|s| s.code())
}

/// The last non-empty output line, without escape sequences or control characters, at most `MAX_TEXT` characters.
fn last_line(scan: &Mutex<String>) -> String {
    let Ok(text) = scan.lock().map(|s| signin::strip_ansi(&s)) else {
        return String::new();
    };
    text.rsplit(['\n', '\r'])
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number_and_only_strict_ones_count() {
        assert!(newer(Some("2.1.1000"), Some("2.1.319")));
        assert!(newer(Some("1.2.1"), Some("1.2")));
        assert!(!newer(Some("2.1.319"), Some("2.1.319")));
        assert!(!newer(Some("1.2"), Some("1.2.0")));
        assert!(!newer(Some("0.9.0"), Some("0.10.0")));
        for bad in [
            "9.9.9; touch x",
            "$(touch x)",
            "9",
            "9.",
            ".9",
            "9.9.9-beta",
            "1.2.3.4.5",
            "1.2.3456789012",
            "latest",
            "",
        ] {
            assert!(!newer(Some(bad), Some("1.0.0")), "{bad}");
        }
    }
}
