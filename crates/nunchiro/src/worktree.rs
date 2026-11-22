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
    let mut base = "HEAD".to_string();
    let mut label = String::new();
    let mut i = 1;
    while i < args.len() {
        let option = &args[i];
        if option == "--no-focus" {
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
            "--base" => base = value.clone(),
            "--label" => label = value.clone(),
            _ => return Err("unknown worktree option".into()),
        }
        i += 1;
    }
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
