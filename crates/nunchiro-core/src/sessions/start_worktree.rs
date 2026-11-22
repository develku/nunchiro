//! `session start --worktree`: the new folder starts at the project's default branch tip on its own branch, not at the
//! root checkout's HEAD (which can be days old). Peers: Orca and T3 Code both branch a new worktree off the base branch;
//! none fetches here, so this reads local refs only.
use std::{path::Path, time::Duration};

const READ: Duration = Duration::from_secs(10);

/// The new folder under `parent`: the first 8 characters of the session `id` (the full uuid made a path too long for a
/// unix socket under it), `-2`, `-3`... when that name is taken. Everything later uses the stored cwd, never this name.
pub(super) fn folder(parent: &Path, id: &str) -> std::path::PathBuf {
    let short = &id[..id.len().min(8)];
    (1..)
        .map(|n| {
            if n == 1 {
                short.to_string()
            } else {
                format!("{short}-{n}")
            }
        })
        .map(|name| parent.join(name))
        .find(|p| p.symlink_metadata().is_err())
        .unwrap()
}

/// (`base`, `branch`) for a start whose folder is `cwd`: the newer of local `<default>` and `origin/<default>`, else
/// HEAD; the branch is `nunchiro/<folder name>`.
// shortcut: default is origin/HEAD's branch, else main or master; a repo with neither starts at HEAD as before.
pub(super) fn target(project: &Path, cwd: &Path) -> (String, String) {
    let have = |r: &str| {
        crate::process::git_read(
            project,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("{r}^{{commit}}"),
            ],
            READ,
        )
        .ok()
        .map(|o| String::from_utf8_lossy(&o).trim().to_string())
    };
    let names = crate::auto_pull::origin_default(project)
        .map(|b| vec![b])
        .unwrap_or_else(|_| vec!["main".into(), "master".into()]);
    let base = names.iter().find_map(|b| {
        let (local, origin) = (
            format!("refs/heads/{b}"),
            format!("refs/remotes/origin/{b}"),
        );
        match (have(&local), have(&origin)) {
            (Some(l), Some(o)) => {
                // Origin wins unless local is ahead of it (a diverged pair takes origin).
                let ahead = crate::process::git_read(
                    project,
                    &["merge-base", "--is-ancestor", &o, &l],
                    READ,
                )
                .is_ok();
                Some(if ahead { l } else { o })
            }
            (l, o) => l.or(o),
        }
    });
    (
        base.unwrap_or_else(|| "HEAD".into()),
        format!(
            "nunchiro/{}",
            cwd.file_name().unwrap_or_default().to_string_lossy()
        ),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn worktree_folder_is_short_and_unique_on_collision() {
        let dir = std::env::temp_dir().join(format!("w35-folder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "0123abcd-4567-89ab-cdef-0123456789ab";
        let first = super::folder(&dir, id);
        assert_eq!(first.file_name().unwrap(), "0123abcd");
        std::fs::create_dir(&first).unwrap();
        assert_eq!(super::folder(&dir, id).file_name().unwrap(), "0123abcd-2");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // F3: Claude Code's experimental feature flags pass `--env`; a secret word still wins over that prefix.
    #[test]
    fn experimental_flag_prefix_passes_but_secret_names_stay_refused() {
        let env = |k: &str| [(k.to_string(), "1".to_string())].into();
        assert!(super::super::check_start_env(&env("CLAUDE_CODE_EXPERIMENTAL_CODE_MODE")).is_ok());
        assert!(super::super::check_start_env(&env("CLAUDE_CODE_EXPERIMENTAL_X_TOKEN")).is_err());
    }
}
