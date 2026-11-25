use nunchiro_core::api::*;
use std::path::{Path, PathBuf};
pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let operation = args.first().ok_or("missing worktree operation")?;
    if !["create", "open", "list", "remove"].contains(&operation.as_str()) {
        return Err("unknown worktree operation".into());
    }
    let mut project = None;
    let mut path = None;
    let mut branch = None;
    let mut base = None;
    let mut label = String::new();
    let mut i = 1;
    while i < args.len() {
        let option = &args[i];
        // The reply is JSON already: `--json` asks for nothing more (it used to be read as an option with a value).
        if option == "--no-focus" || option == "--json" {
            i += 1;
            continue;
        }
        i += 1;
        let value = args.get(i).ok_or("missing worktree option value")?;
        match option.as_str() {
            "--project" => project = Some(PathBuf::from(value)),
            // The core runs in another folder: a relative path is the caller's, so it is made absolute here.
            "--path" => path = Some(std::path::absolute(value).map_err(|e| e.to_string())?),
            "--branch" => branch = Some(value.clone()),
            "--base" => base = Some(value.clone()),
            "--label" => label = value.clone(),
            _ => return Err("unknown worktree option".into()),
        }
        i += 1;
    }
    // Ticket 1054: with no --base a new branch starts at origin's default branch as last fetched, else at HEAD (a
    // lead's main checkout may be a detached HEAD far behind). Read here, not in the core: the core never fetches for a
    // session token's empty base (ticket 374, security r2).
    let base = match base {
        Some(base) => base,
        None if operation == "create" => {
            let base = default_base(project.as_deref());
            eprintln!("base for a new branch: {base}");
            base
        }
        None => "HEAD".into(),
    };
    super::ensure_core(home)?;
    let missing_path = operation == "remove" && path.as_ref().is_some_and(|p| !p.exists());
    let reply = super::call(
        home,
        Request::Worktree {
            operation: operation.clone(),
            project,
            path,
            branch,
            base,
            label,
            from: None,
            confirm: None,
        },
    )?;
    if missing_path {
        eprintln!(
            "Git metadata for missing paths is retained; run `git worktree prune` yourself if needed."
        );
    }
    println!(
        "{}",
        serde_json::to_string(&reply).map_err(|e| e.to_string())?
    );
    // V2-8a: the core removed nothing; the reply lists what removing would lose.
    if let Reply::Worktrees { loss: Some(_), .. } = reply {
        return Err("worktree has uncommitted or unpushed work; nothing was removed".into());
    }
    Ok(())
}

/// `origin/<default>` when the repository knows origin's default branch (`refs/remotes/origin/HEAD`), else `HEAD`.
fn default_base(project: Option<&Path>) -> String {
    let mut git = std::process::Command::new("git");
    if let Some(project) = project {
        git.arg("-C").arg(project);
    }
    git.args([
        "rev-parse",
        "--abbrev-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/HEAD",
    ])
    .output()
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .filter(|b| !b.is_empty())
    .unwrap_or_else(|| "HEAD".into())
}
