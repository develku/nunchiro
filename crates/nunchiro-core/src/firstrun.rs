//! V2-5a: what the first-run checklist shows about each agent: is it on the core's PATH, what `--version` says, and how
//! many session transcripts its own folder lists. Read only: nothing under `~/.claude` or `~/.codex` is opened, the
//! count only lists transcript names (regular `.jsonl` files, never through a link). Owner and window only.
use crate::{
    accounts::{Agent, agent_name, variable},
    api::{Reply, Response},
    usage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
/// Ticket 474: the limit of a binary's first run in this core. macOS checks a new or replaced binary's code on its first
/// run (2.06 s against 0.033 s on the second, measured 11-12; longer under load or with several at once).
const FIRST_RUN: Duration = Duration::from_secs(8);
/// Binaries already run once; a full set starts over (every binary then gets one longer run again).
const SEEN_MAX: usize = 256;

/// One binary file as it is now: a replaced or rewritten file (an update) is a new one.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    path: PathBuf,
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

static SEEN: Mutex<Option<HashSet<Key>>> = Mutex::new(None);

/// Ticket 474: how long one run of `binary` may take. `normal` once this core has run this exact file; `FIRST_RUN`
/// (never less than `normal`) for its first run, whatever that run's end. Only the time changes, never what runs.
pub(crate) struct Limit {
    pub(crate) time: Duration,
    key: Option<Key>,
}

pub(crate) fn limit(binary: &Path, normal: Duration) -> Limit {
    let key = key(binary);
    let seen = key.as_ref().is_none_or(|k| {
        SEEN.lock()
            .ok()
            .is_none_or(|s| s.as_ref().is_some_and(|s| s.contains(k)))
    });
    Limit {
        time: if seen { normal } else { normal.max(FIRST_RUN) },
        key,
    }
}

impl Limit {
    /// The run is over, however it ended: this file's next run gets the normal limit.
    pub(crate) fn ran(self) {
        let Some(key) = self.key else { return };
        if let Ok(mut seen) = SEEN.lock() {
            let seen = seen.get_or_insert_with(HashSet::new);
            if seen.len() >= SEEN_MAX {
                seen.clear();
            }
            seen.insert(key);
        }
    }
}

/// The file `binary` names after every link; `None` (the normal limit) when it cannot be read.
fn key(binary: &Path) -> Option<Key> {
    let path = fs::canonicalize(binary).ok()?;
    let m = fs::metadata(&path).ok()?;
    Some(Key {
        path,
        dev: m.dev(),
        ino: m.ino(),
        size: m.size(),
        mtime: (m.mtime(), m.mtime_nsec()),
        ctime: (m.ctime(), m.ctime_nsec()),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "FirstrunFound"))]
pub struct Found {
    pub agent: Agent,
    pub found: bool,
    /// The binary on the core's PATH (Settings > Accounts shows it).
    #[serde(default)]
    pub path: Option<String>,
    /// `--version` output of the binary found; `None` when missing or when the probe failed.
    pub version: Option<String>,
    /// Transcripts the agent's own folder lists.
    pub sessions: usize,
}

pub(crate) fn reply() -> Response {
    Ok(Reply::FirstRun {
        agents: detect_all(),
        git: git_found(),
    })
}

/// Claude and Codex as the checklist shows them (V2-4b: Settings > Agents lists the same two).
/// Ticket 421: one after the other on the caller's own (job) thread, never a thread of its own. Ticket 474: two
/// just-installed binaries' first runs then add up to at most 2 x `FIRST_RUN`.
pub(crate) fn detect_all() -> Vec<Found> {
    [Agent::Claude, Agent::Codex].map(detect).into()
}

/// Q7 point 18 (Orca's preflight): git answers `--version`. macOS's /usr/bin/git stub without the Command Line Tools
/// fails that, so a stub alone is no git.
fn git_found() -> bool {
    let Some(git) = on_path("git") else {
        return false;
    };
    // Apple's stub, run without the tools, opens the system's install dialog: the first-run page must never do that.
    // `xcode-select -p` answers whether the tools are there with no dialog.
    if git == std::path::Path::new("/usr/bin/git") {
        let mut command = crate::process::command("/usr/bin/xcode-select");
        command.arg("-p").stdin(Stdio::null());
        // Bounded as `version`: a hung probe would hold a job slot per focus (Q9 en-a-J12-4).
        return crate::process::output(command, VERSION_TIMEOUT).is_ok_and(|o| o.status.success());
    }
    version(&git).is_some()
}

fn detect(agent: Agent) -> Found {
    let binary = on_path(agent_name(agent));
    let version = binary.as_deref().and_then(version);
    Found {
        agent,
        found: binary.is_some(),
        path: binary.as_deref().map(|p| p.display().to_string()),
        version,
        sessions: transcripts(agent),
    }
}

/// The first executable file named `name` in an absolute PATH entry (a relative entry would resolve against the
/// core's working folder).
pub(crate) fn on_path(name: &str) -> Option<PathBuf> {
    in_paths(&std::env::var_os("PATH")?, name)
}
pub(crate) fn in_paths(paths: &std::ffi::OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(paths)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

pub(crate) fn version(binary: &Path) -> Option<String> {
    let mut command = crate::process::command(binary);
    // As the account probes: PATH and HOME only.
    command.arg("--version").env_clear().stdin(Stdio::null());
    command.envs(
        ["PATH", "HOME"]
            .into_iter()
            .filter_map(|k| Some((k, std::env::var_os(k)?))),
    );
    let limit = limit(binary, VERSION_TIMEOUT);
    let out = crate::process::output(command, limit.time);
    limit.ran();
    let out = out.ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn transcripts(agent: Agent) -> usize {
    let folder = std::env::var_os(variable(agent))
        .map(PathBuf::from)
        .or_else(|| {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            Some(home.join(match agent {
                Agent::Claude => ".claude",
                Agent::Codex => ".codex",
            }))
        });
    let Some(folder) = folder else { return 0 };
    let root = folder.join(match agent {
        Agent::Claude => "projects",
        Agent::Codex => "sessions",
    });
    // A link as the folder itself is not followed either.
    if !fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
        return 0;
    }
    let mut files = Vec::new();
    usage::walk(&root, 0, &mut files, &mut usage::Budget::request());
    match agent {
        // Claude keeps `projects/<p>/<id>.jsonl`; deeper files (`<id>/subagents/agent-*.jsonl`) are not sessions.
        Agent::Claude => files
            .iter()
            .filter(|f| f.parent().and_then(Path::parent) == Some(root.as_path()))
            .count(),
        Agent::Codex => files.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_gets_the_longer_limit_on_its_first_run_only_and_again_once_replaced() {
        let dir = std::env::temp_dir().join(format!("nunchiro-474-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("tool");
        fs::write(&bin, "#!/bin/sh\necho 1.0.0\n").unwrap();
        let normal = Duration::from_secs(3);
        let first = limit(&bin, normal);
        assert_eq!(first.time, FIRST_RUN);
        first.ran();
        assert_eq!(limit(&bin, normal).time, normal);
        // Through a link it is the same file.
        let link = dir.join("link");
        std::os::unix::fs::symlink(&bin, &link).unwrap();
        assert_eq!(limit(&link, normal).time, normal);
        // An update writes a new file over it.
        fs::write(dir.join("new"), "#!/bin/sh\necho 2.0.0\n").unwrap();
        fs::rename(dir.join("new"), &bin).unwrap();
        assert_eq!(limit(&bin, normal).time, FIRST_RUN);
        // A limit above the first-run one is never cut; a missing file gets the normal limit.
        assert_eq!(
            limit(&bin, Duration::from_secs(20)).time,
            Duration::from_secs(20)
        );
        assert_eq!(limit(&dir.join("missing"), normal).time, normal);
        let _ = fs::remove_dir_all(&dir);
    }
}
