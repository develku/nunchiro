//! Ticket 358: the one thing Nunchiro runs of a Claude or Codex command nobody has approved yet: `<path> --version`. No
//! saved argument and no saved env value reaches it. It runs in a fresh empty folder (also its HOME) with an otherwise
//! clear environment, for at most `CAP` (ticket 474: a binary's first run in this core gets `firstrun::limit`'s longer
//! one, as macOS checks a new binary's code then); `process::output` kills its process group on every way out.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const CAP: Duration = Duration::from_secs(5);
const LINE_MAX: usize = 200;

/// Removed on every way out, after the run that used it.
struct Folder(PathBuf);
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The first line `--version` printed, or why there is none.
pub(super) fn version(home: &Path, program: &Path) -> Result<String, String> {
    let parent = home.join("command-check");
    crate::store::private_dir(&parent)?;
    let folder = Folder(parent.join(crate::store::new_id()?));
    crate::store::private_dir(&folder.0)?;
    // An npm install is `#!/usr/bin/env node`: its own folder holds node, so the clear environment needs that one entry.
    let dir = program.parent().ok_or("the path names no folder")?;
    let path = std::env::join_paths([dir, Path::new("/usr/bin"), Path::new("/bin")])
        .map_err(|_| "the path's folder holds a colon")?;
    let mut command = crate::process::command(program);
    command
        .arg("--version")
        .env_clear()
        .env("PATH", path)
        .env("HOME", &folder.0)
        .current_dir(&folder.0)
        .stdin(Stdio::null());
    let limit = crate::firstrun::limit(program, CAP);
    let out = crate::process::output(command, limit.time);
    limit.ran();
    let out = out.map_err(|e| format!("--version did not finish: {e}"))?;
    if !out.status.success() {
        return Err(format!("--version failed ({})", out.status));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line: String = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(LINE_MAX)
        .collect();
    if line.is_empty() {
        return Err("--version printed nothing".into());
    }
    Ok(line)
}
