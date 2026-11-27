//! Ticket 259 (G21): a worktree's setup and cleanup scripts. The owner types them per project (core `features` key
//! `worktree.scripts`: project path -> `Scripts`); a repo supplies a setup script only through an existing `orca.yaml`
//! `scripts.setup` (no Nunchiro project file). An owner script runs as typed; a repo script runs only once the owner
//! approved its exact text (approval kind `setup`, by content hash), so a branch that rewrites it asks again.
//!
//! Every script runs in a visible shell tab of the worktree (`setup` or `cleanup`), never hidden and never in the widget
//! sandbox. The tab's wrapper writes the exit code to `<home>/setup-runs/`, which the window's "wait" and the cleanup
//! read. Shapes after Orca's `orca.yaml` hooks (`scripts.setup`, `scripts.archive`, `setupRunPolicy`,
//! `setupAgentStartupPolicy`; orca/src/shared/orca-yaml-hook-types.ts, MIT License, Copyright (c) 2026 Lovecast Inc.):
//! the policy and wait names and the 120 s archive limit; no code taken.
use crate::{
    api::{AgentKind, Reply, Request, Response, Session, StartSession, Worktree},
    approval::{self, SetupView, State},
    queue::OwnerAsk,
    sessions::Sessions,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const FEATURE: &str = "worktree.scripts";
/// Orca's hook limit: a cleanup that has not ended by then counts as failed and the worktree stays.
pub const CLEANUP_LIMIT: Duration = Duration::from_secs(120);
const ORCA_MAX: u64 = 64 * 1024;

/// Orca's `setupRunPolicy`, of a repo script: "run by default" runs only what was approved unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    /// An unapproved or changed script asks the owner (the approval sheet) and runs once granted.
    #[default]
    Ask,
    /// Runs an approved, unchanged script; anything else is skipped without asking.
    RunWhenApproved,
    /// Never runs a setup script.
    Skip,
}

/// One project's values. Empty text is no script.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Scripts {
    pub setup: String,
    pub cleanup: String,
    pub policy: Policy,
    /// Orca's "wait for setup": the window's start-an-agent waits until the setup tab exits 0.
    pub wait: bool,
}

/// A project's values from the stored map (keyed by the project path as the window lists it, or canonical).
pub fn for_project<T: Clone + Default>(map: Option<BTreeMap<String, T>>, project: &Path) -> T {
    let map = map.unwrap_or_default();
    let canonical = std::fs::canonicalize(project).ok();
    map.iter()
        .find(|(k, _)| {
            let k = Path::new(k.as_str());
            k == project
                || canonical.as_deref() == Some(k)
                || std::fs::canonicalize(k).ok() == canonical
        })
        .map(|(_, s)| s.clone())
        .unwrap_or_default()
}

/// `scripts.setup` of the `orca.yaml` at the worktree root, if there is one this reader understands.
pub fn repo_script(worktree: &Path) -> Option<String> {
    let file = crate::store::open_regular(&worktree.join("orca.yaml")).ok()?;
    let bytes = crate::store::read_capped(file, ORCA_MAX).ok()?;
    orca_setup(&String::from_utf8(bytes).ok()?)
}

/// The subset of YAML an `orca.yaml` setup line uses: a top-level `scripts:` map whose `setup:` is a `|` block or a
/// one-line plain or quoted scalar. Anything else reads as no script, never a guess: the sheet shows exactly what runs.
// shortcut: not a YAML parser (no anchors, flow maps or `>` folding); add a crate if repos use more than this.
pub fn orca_setup(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let indent = |l: &str| l.len() - l.trim_start_matches(' ').len();
    let blank = |l: &str| l.trim().is_empty() || l.trim_start().starts_with('#');
    let uncomment = |l: &str| l.split(" #").next().unwrap_or("").trim_end().to_string();
    let start = lines.iter().position(|l| uncomment(l) == "scripts:")?;
    let mut key_indent = None;
    for (i, line) in lines.iter().enumerate().skip(start + 1) {
        if blank(line) {
            continue;
        }
        let at = indent(line);
        if at == 0 {
            return None;
        }
        // The first key fixes the map's indent; deeper lines belong to another key's value.
        if *key_indent.get_or_insert(at) != at {
            continue;
        }
        let Some(value) = line.trim_start().strip_prefix("setup:") else {
            continue;
        };
        let value = value.trim();
        let script = if matches!(uncomment(value).as_str(), "|" | "|-" | "|+") {
            let body: Vec<&str> = lines[i + 1..]
                .iter()
                .take_while(|l| l.trim().is_empty() || indent(l) > at)
                .copied()
                .collect();
            let inner = body
                .iter()
                .find(|l| !l.trim().is_empty())
                .map(|l| indent(l))?;
            body.iter()
                .map(|l| l.get(inner..).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
        } else if let Some(q) = value.strip_prefix('"') {
            let q = q.strip_suffix('"')?;
            if q.contains(['\\', '"']) {
                return None;
            }
            q.to_string()
        } else if let Some(q) = value.strip_prefix('\'') {
            q.strip_suffix('\'')?.replace("''", "'")
        } else {
            uncomment(value)
        };
        let script = script.trim().to_string();
        return (!script.is_empty()).then_some(script);
    }
    None
}

/// What a new worktree gets.
#[derive(Debug)]
pub enum Decision {
    Nothing,
    /// The owner's typed script, or a repo script approved unchanged.
    Run(String),
    /// A repo script the owner has not approved in this text: the sheet asks.
    Ask(SetupView),
    Skip(&'static str),
}

pub fn decide(
    home: &Path,
    scripts: &Scripts,
    project: &Path,
    worktree: &Path,
) -> Result<Decision, String> {
    if scripts.policy == Policy::Skip {
        return Ok(Decision::Skip("setup scripts are off for this project"));
    }
    // The owner's own text needs no approval.
    if !scripts.setup.trim().is_empty() {
        return Ok(Decision::Run(scripts.setup.clone()));
    }
    let Some(script) = repo_script(worktree) else {
        return Ok(Decision::Nothing);
    };
    let view = approval::setup_status(home, project, worktree, &script)?;
    Ok(match (view.state, scripts.policy) {
        (State::Approved, _) => Decision::Run(script),
        (_, Policy::RunWhenApproved) => {
            Decision::Skip("the repo's setup script is not approved in this text")
        }
        _ => Decision::Ask(view),
    })
}

/// Where a tab's wrapper writes its exit code: one file per worktree and tab label.
pub fn exit_file(home: &Path, worktree: &Path, label: &str) -> PathBuf {
    let key = &approval::setup_name(worktree)["setup-".len()..];
    home.join("setup-runs").join(format!("{key}.{label}"))
}
pub fn read_exit(file: &Path) -> Option<i32> {
    use std::io::Read;
    // A regular file only (no link or FIFO to block on) and a small read: the wrapper writes a few digits.
    let mut text = String::new();
    crate::store::open_regular(file)
        .ok()?
        .take(16)
        .read_to_string(&mut text)
        .ok()?;
    text.trim().parse().ok()
}

/// The tab's argv: bash runs the script as its own child (an `exit` in it ends only that), then the wrapper writes the
/// exit code and says in the tab how it ended.
pub fn tab_args(label: &str, exit: &Path, script: &str) -> Vec<String> {
    const WRAP: &str = r#"/bin/bash -c "$2"; c=$?; printf '%s\n' "$c" > "$1"; echo; if [ "$c" = 0 ]; then echo "[nunchiro] $0 finished"; else echo "[nunchiro] $0 failed (exit $c)"; fi; exit $c"#;
    [
        "/bin/bash",
        "-c",
        WRAP,
        label,
        &exit.to_string_lossy(),
        script,
    ]
    .map(String::from)
    .to_vec()
}

/// What the window's start-an-agent does after a create: `Wait` while the setup tab runs, `Start` when no setup ran or it
/// exited 0, `User` when it failed, was skipped or waits for approval (the start is left to the user).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "WorktreeSetupAgent"))]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Start,
    Wait,
    User,
}
pub fn agent(wait: bool, decision_ran: Option<bool>, running: bool, exit: Option<i32>) -> Agent {
    match decision_ran {
        _ if !wait => Agent::Start,
        None => Agent::Start, // no script at all
        Some(false) => Agent::User,
        Some(true) if running => Agent::Wait,
        Some(true) if exit == Some(0) => Agent::Start,
        Some(true) => Agent::User,
    }
}

/// The reply of `setup_status`: the repo script's sheet (absent with no repo script) and what start-an-agent does now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "WorktreeSetupStatus"))]
pub struct Status {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<SetupView>,
    pub agent: Agent,
}

fn project_of(
    registry: &Mutex<Sessions>,
    path: &Path,
) -> Result<(PathBuf, PathBuf, Scripts), String> {
    let sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let project = sessions
        .recorded_worktree_project(&path)
        .ok_or("not a worktree Nunchiro made")?;
    let scripts = for_project(sessions.feature(FEATURE), &project);
    Ok((sessions.home().to_path_buf(), project, scripts))
}

fn running(registry: &Mutex<Sessions>, path: &Path, label: &str) -> bool {
    registry.lock().is_ok_and(|s| {
        s.tab_running(|x| x.kind == AgentKind::Shell && x.label == label && x.cwd == path)
    })
}

/// Starts the visible tab `label` in `worktree` running `script` as the owner's shell. `by_owner` (ticket 1008 round
/// 4): the owner asked for it (his create or his approval), so it keeps his environment; one an agent's create or a
/// remove triggers is stripped like any shell an agent starts.
fn start_tab(
    registry: &Mutex<Sessions>,
    home: &Path,
    project: &Path,
    worktree: &Path,
    label: &str,
    script: &str,
    by_owner: bool,
) -> Result<Session, String> {
    let exit = exit_file(home, worktree, label);
    crate::store::private_dir(exit.parent().ok_or("no setup-runs folder")?)?;
    match std::fs::remove_file(&exit) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    let launch = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: project.to_path_buf(),
            worktree: false,
            label: label.into(),
            args: tab_args(label, &exit, script),
            model: None,
            effort: None,
            resume: None,
        });
    let mut launch = launch.prepare_existing(worktree)?;
    if by_owner {
        launch = launch.owner_terminal();
    }
    let (_sessions, session) = Sessions::past_busy_worktree(registry, |s| s.start(&launch))?;
    launch.committed = true;
    Ok(session)
}

/// After a create (window, CLI or an agent's `nunchiro worktree`): runs, asks or skips. Never fails the create, which
/// already happened: a problem is logged and the worktree stays.
pub(crate) fn after_create(registry: &Mutex<Sessions>, asker: Option<&str>, worktree: &Worktree) {
    let run = || -> Result<(), String> {
        let (home, project, scripts) = project_of(registry, &worktree.path)?;
        match decide(&home, &scripts, &project, &worktree.path)? {
            Decision::Run(script) => start_tab(
                registry,
                &home,
                &project,
                &worktree.path,
                "setup",
                &script,
                asker.is_none(),
            )
            .map(drop),
            Decision::Ask(view) => {
                let ask = OwnerAsk::Setup {
                    path: view.path,
                    hash: view.hash,
                };
                let mut sessions = registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?;
                // An owner item names a session; the window's own create has none, so a fresh id stands in.
                let asker = asker.map_or_else(crate::store::new_id, |a| Ok(a.to_string()))?;
                sessions.queue.ask_owner(&asker, ask).map(drop)
            }
            Decision::Skip(_) | Decision::Nothing => Ok(()),
        }
    };
    if let Err(e) = run() {
        eprintln!("worktree setup for {}: {e}", worktree.path.display());
    }
}

/// Before a remove: the owner's cleanup script in a visible tab, waited for up to `CLEANUP_LIMIT`. Anything but exit 0
/// refuses the remove, so the worktree stays and the reason says why.
// shortcut: the CLI's socket read gives up after 15 s, so `nunchiro worktree remove` reports a timeout for a longer
// cleanup while the core still finishes it (and the remove); give the CLI a longer read for this op if that bites.
// shortcut: the auto-clean pass removes merged worktrees without the cleanup script; run it there too if owners ask.
pub(crate) fn before_remove(
    registry: &Mutex<Sessions>,
    path: &Path,
    confirm: Option<&crate::api::WorktreeLoss>,
    stopping: Option<&AtomicBool>,
    by_owner: bool,
) -> Result<(), String> {
    let Ok((home, project, scripts)) = project_of(registry, path) else {
        return Ok(()); // not a recorded worktree: the remove itself refuses it
    };
    if scripts.cleanup.trim().is_empty() {
        return Ok(());
    }
    // Codex looks 11-15: a remove that will ask about unsaved work must ask first. A cleanup such as `git clean` would
    // delete that work before the question; it runs only on the resend whose confirm names exactly what is there now
    // (a stale confirm asks again, as the remove itself does).
    let loss = crate::worktree_clean::loss(path, &project)?;
    let lossy = loss.uncommitted_total > 0 || loss.unpushed_total > 0 || loss.ignored_total > 0;
    if lossy && confirm != Some(&loss) {
        return Ok(());
    }
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let session = start_tab(
        registry,
        &home,
        &project,
        &path,
        "cleanup",
        &scripts.cleanup,
        by_owner,
    )?;
    let until = Instant::now() + CLEANUP_LIMIT;
    while running_id(registry, &session.id) {
        if Instant::now() >= until || stopping.is_some_and(|s| s.load(Ordering::SeqCst)) {
            // Codex look 11-15: the script is stopped with the refusal, so it changes nothing in a worktree the
            // user was told is kept.
            if let Ok(mut sessions) = registry.lock() {
                let _ = sessions.close(&session.id, true, false);
            }
            return Err(format!(
                "cleanup script did not finish in {} s; the worktree is kept",
                CLEANUP_LIMIT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    match read_exit(&exit_file(&home, &path, "cleanup")) {
        Some(0) => Ok(()),
        Some(code) => Err(format!(
            "cleanup script failed (exit {code}); the worktree is kept"
        )),
        None => Err("cleanup script ended without an exit code; the worktree is kept".into()),
    }
}
fn running_id(registry: &Mutex<Sessions>, id: &str) -> bool {
    registry.lock().is_ok_and(|s| s.tab_running(|x| x.id == id))
}

/// `setup_status` and `setup_grant`: the owner's alone (the server refuses every other caller before this).
pub(crate) fn serve(registry: &Mutex<Sessions>, request: Request) -> Response {
    let (path, grant) = match request {
        Request::SetupStatus { path } => (path, None),
        Request::SetupGrant { path, hash } => (path, Some(hash)),
        _ => return Err("expected a setup request".into()),
    };
    let (home, project, scripts) = project_of(registry, &path)?;
    let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let script = repo_script(&path);
    if let Some(hash) = grant {
        let script = script.ok_or("this worktree has no setup script to approve")?;
        if scripts.policy == Policy::Skip {
            return Err("setup scripts are off for this project".into());
        }
        let view = approval::grant_setup(&home, &project, &path, &script, &hash)?;
        {
            let mut sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            sessions.queue.answer_owner(
                |i| matches!(&i.owner, Some(OwnerAsk::Setup { path: p, .. }) if *p == path),
            )?;
        }
        // The owner's own typed script wins over the repo's, as at create.
        if scripts.setup.trim().is_empty() {
            start_tab(registry, &home, &project, &path, "setup", &script, true)?;
        }
        return Ok(Reply::SetupStatus {
            status: Status {
                view: Some(view),
                agent: Agent::Wait,
            },
        });
    }
    let view = script
        .map(|s| approval::setup_status(&home, &project, &path, &s))
        .transpose()?;
    let ran = match decide(&home, &scripts, &project, &path)? {
        Decision::Nothing => None,
        Decision::Run(_) => Some(true),
        Decision::Ask(_) | Decision::Skip(_) => Some(false),
    };
    let exit = read_exit(&exit_file(&home, &path, "setup"));
    Ok(Reply::SetupStatus {
        status: Status {
            view,
            agent: agent(scripts.wait, ran, running(registry, &path, "setup"), exit),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orca_yaml_setup_forms() {
        let block = "scripts:\n  setup: |\n    pnpm install\n    cp .env.example .env\n  archive: |\n    setup: no\n";
        assert_eq!(
            orca_setup(block).as_deref(),
            Some("pnpm install\ncp .env.example .env")
        );
        assert_eq!(
            orca_setup("scripts:\n  setup: make setup # deps\n").as_deref(),
            Some("make setup")
        );
        assert_eq!(
            orca_setup("scripts:\n  setup: \"make\"\n").as_deref(),
            Some("make")
        );
        assert_eq!(
            orca_setup("scripts:\n  setup: 'it''s'\n").as_deref(),
            Some("it's")
        );
        // A `setup:` inside another key's block, or outside `scripts`, is not the setup script.
        assert_eq!(orca_setup("scripts:\n  archive: |\n    setup: x\n"), None);
        assert_eq!(
            orca_setup("setup: x\nscripts:\n  archive: y\nother:\n  setup: z\n"),
            None
        );
        // Forms this reader does not understand run nothing.
        assert_eq!(orca_setup("scripts:\n  setup: \"a\\nb\"\n"), None);
        assert_eq!(orca_setup("scripts: {setup: x}\n"), None);
        assert_eq!(orca_setup("scripts:\n  setup: |\n\n"), None);
    }

    #[test]
    fn agent_start_follows_the_setup_tab() {
        assert_eq!(agent(false, Some(true), true, None), Agent::Start);
        assert_eq!(agent(true, None, false, None), Agent::Start);
        assert_eq!(agent(true, Some(true), true, None), Agent::Wait);
        assert_eq!(agent(true, Some(true), false, Some(0)), Agent::Start);
        assert_eq!(agent(true, Some(true), false, Some(2)), Agent::User);
        assert_eq!(agent(true, Some(true), false, None), Agent::User);
        assert_eq!(agent(true, Some(false), false, None), Agent::User);
    }

    /// Ticket 1013 (F5): this repository supplies its own setup through `orca.yaml`, so a fresh worktree gets its
    /// node_modules and web/dist (tauri's `generate_context!` reads web/dist) without a link into another checkout.
    #[test]
    fn this_repo_sets_up_a_fresh_worktree() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let script = repo_script(&repo).expect("orca.yaml scripts.setup");
        assert_eq!(script, "scripts/setup-worktree.sh");
        let file = repo.join("scripts/setup-worktree.sh"); // a literal join: the gate maps paths from literals
        assert!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o111 != 0);
        let text = std::fs::read_to_string(file).unwrap();
        assert!(text.contains("pnpm install --frozen-lockfile --prefer-offline"));
        assert!(text.contains("pnpm --filter nunchiro-web build"));
        assert!(
            !text.contains("ln -s"),
            "a setup builds its own copy, never a link"
        );
    }
}
