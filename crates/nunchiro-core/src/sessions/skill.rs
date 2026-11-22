//! The Nunchiro plugin (skill) written into Nunchiro's data folder for `claude --plugin-dir`.
//! Never under `~/.claude`. Format: `plugin/.claude-plugin/plugin.json` with an integer-string
//! `version` (from 1); a plugin.json that is invalid or newer than this build is left untouched.
use crate::store;
use std::{
    fs,
    path::{Path, PathBuf},
};

const VERSION: u64 = 1;
pub(crate) const FILES: [(&str, &str); 4] = [
    (
        ".claude-plugin/plugin.json",
        include_str!("../../../../plugin/.claude-plugin/plugin.json"),
    ),
    (
        "skills/nunchiro/SKILL.md",
        include_str!("../../../../plugin/skills/nunchiro/SKILL.md"),
    ),
    // v1b-07: version 1 rewrites missing files, so the new skill needs no version bump.
    (
        "skills/artifacts/SKILL.md",
        include_str!("../../../../plugin/skills/artifacts/SKILL.md"),
    ),
    // V2.5-31: only while Settings > Orchestration is on (`install`).
    (
        ORCHESTRATION,
        include_str!("../../../../plugin/skills/orchestration/SKILL.md"),
    ),
];
const ORCHESTRATION: &str = "skills/orchestration/SKILL.md";
/// V2.5-31: Codex's one `-c` launch override pointing at the guide; a constant, so no user or worker text reaches it.
pub(crate) const CODEX_INSTRUCTION: &str = "developer_instructions=\"Nunchiro orchestration: before you split work across Nunchiro worker sessions (parallel lanes, worktrees, another agent kind), run `nunchiro skill get orchestration` and follow it. For a quick lookup or a small edit, use your own tools instead.\"";

/// Returns the plugin directory, (re)writing the embedded files unless the installed copy is newer or unreadable.
/// V2.5-31: with `orchestration` off the orchestration stub is removed, so new Claude sessions do not load it.
pub(super) fn install(home: &Path, orchestration: bool) -> Result<PathBuf, String> {
    let dir = home.join("plugin");
    // Off holds for a newer or unreadable copy too: only the stub goes, nothing else there is touched.
    if !orchestration {
        match fs::remove_file(dir.join(ORCHESTRATION)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    let manifest = dir.join(".claude-plugin/plugin.json");
    if let Ok(text) = fs::read_to_string(&manifest) {
        let installed = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["version"].as_str()?.parse::<u64>().ok());
        if installed.is_none_or(|v| v > VERSION) {
            return Ok(dir);
        }
    }
    for (rel, body) in FILES {
        let path = dir.join(rel);
        if rel == ORCHESTRATION && !orchestration {
            continue;
        }
        if fs::read_to_string(&path).is_ok_and(|current| current == body) {
            continue;
        }
        let mut dirs: Vec<&Path> = path
            .ancestors()
            .skip(1)
            .take_while(|d| *d != home)
            .collect();
        dirs.reverse();
        for d in dirs {
            store::private_dir(d)?;
        }
        store::atomic_write(&path, body.as_bytes())?;
    }
    Ok(dir)
}
