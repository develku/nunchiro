//! Ticket 575: the PATH of the user's login shell, read once when the core starts. A core started from Finder (the
//! app) gets the launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin) and would not find `claude` or `codex`. Detection,
//! probes and every spawned agent read the core's own PATH, so the fix is to set that variable once, before any thread.
//! Taken from Orca (`hydrate-shell-path`) and T3 Code (`os-jank`): run `$SHELL -ilc` once, read PATH between two
//! markers (rc banners cannot spoil it), 3 s ceiling. The core's own PATH keeps its order and comes first; only the
//! login entries it lacks are appended, so a core started from a terminal or a test keeps the priority it was given.
//! Ticket 260: the same one run also prints the whole environment (`/usr/bin/env -0` between NUL-framed markers, as
//! Orca's `login-shell-environment.ts`); that is never set on the core, only held by `user_env` for PTY sessions.
use std::{
    ffi::{OsStr, OsString},
    os::unix::ffi::{OsStrExt, OsStringExt},
    process::Stdio,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MARK: &[u8] = b"__NUNCHIRO_LOGIN_PATH__";
const ENV_MARK: &[u8] = b"\0__NUNCHIRO_LOGIN_ENV__\0";
/// Ticket 260: the most the probe reads; a larger environment is reported, and PATH (printed first) still counts.
const ENV_CAP: usize = 256 * 1024;
/// The CLI and the app wait 5 s for `core.sock` before they kill the core, and the probe runs before the socket is
/// bound. So the probe gets 3 s (Orca allows 10 s, but its app has no such wait): a slower rc falls back to the
/// common folders, and the session is killed at once, so nothing is left behind.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// An rc file can test this to take a fast path (Orca does the same).
const OFF_ENV: &str = "NUNCHIRO_LOGIN_PATH";
const PROBE_ENV: &str = "NUNCHIRO_LOGIN_PATH_PROBE";
/// Where the usual agent installs live when the probe fails (home-relative entries first).
const COMMON: [&str; 3] = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
static NOTE: OnceLock<String> = OnceLock::new();

static WANTED: AtomicBool = AtomicBool::new(false);

/// Called by the `nunchiro serve` entry only. `serve` then runs `adopt_requested` once it holds `core.lock` (a second
/// `serve` that loses the lock never runs the user's shell). A core a test runs in process never asks.
pub fn request() {
    WANTED.store(true, Ordering::SeqCst);
}

/// `adopt`, when `request` was called. `serve` calls it right after the lock, before `logs::start` and any thread:
/// `set_var` is not safe beside other threads.
pub(crate) fn adopt_requested() {
    if WANTED.load(Ordering::SeqCst) {
        adopt();
    }
}

/// Sets the core's PATH from the login shell (or the fallback); the answer is logged by `note`.
fn adopt() {
    // The escape for a shell that cannot answer in time, and for test cores (a machine's /etc/zprofile adds folders).
    if std::env::var_os(OFF_ENV).is_some_and(|v| v == "off") {
        let _ = NOTE.set("login PATH (off): the core's own PATH is used".into());
        crate::user_env::hold(Err(format!("{OFF_ENV}=off")));
        return;
    }
    let shell = std::env::var_os("SHELL")
        .filter(|s| s.as_bytes().first() == Some(&b'/'))
        .unwrap_or_else(|| default_shell().into());
    let (path, note, env) = resolve(
        &shell,
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref(),
        PROBE_TIMEOUT,
    );
    unsafe { std::env::set_var("PATH", path) };
    // Names counted only: the log never carries a value.
    let held = match &env {
        Ok(vars) => format!("{} variables", vars.len()),
        Err(e) => format!("not read ({e})"),
    };
    let _ = NOTE.set(format!("{note}; login environment: {held}"));
    crate::user_env::hold(env);
}

/// The one log line, once the log is open (`None` in a process that never called `adopt`).
pub(crate) fn note() -> Option<&'static str> {
    NOTE.get().map(String::as_str)
}

fn default_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

/// The PATH to use, the line to log (PATH only, never another variable) and the login shell's environment.
fn resolve(
    shell: &OsStr,
    current: Option<&OsStr>,
    home: Option<&OsStr>,
    timeout: Duration,
) -> (OsString, String, Result<crate::user_env::Env, String>) {
    let current = current.unwrap_or_default();
    let (path, how, env) = match probe(shell, timeout) {
        // Relative entries (".", "bin", "") would resolve in the core's or a project's folder, maybe an untrusted clone.
        Ok((login, env)) => (
            merge(&[current, &absolute_only(&login)]),
            "login shell".to_string(),
            env,
        ),
        Err(e) => {
            let extra = home
                .map(|h| std::path::Path::new(h).join(".local/bin").into_os_string())
                .into_iter()
                .chain(COMMON.map(OsString::from))
                .collect::<Vec<_>>();
            let mut parts: Vec<&OsStr> = vec![current];
            parts.extend(extra.iter().map(OsString::as_os_str));
            (merge(&parts), format!("fallback ({e})"), Err(e))
        }
    };
    let note = format!("login PATH ({how}): {}", path.to_string_lossy());
    (path, note, env)
}

/// `shell -ilc 'print PATH; env -0'`: PATH cut to the part between its markers, and the environment's `NAME=value`
/// records (or why there are none: a shell without `/usr/bin/env`, or one over `ENV_CAP`).
fn probe(
    shell: &OsStr,
    timeout: Duration,
) -> Result<(OsString, Result<crate::user_env::Env, String>), String> {
    // Ticket 1009 round 5 (Codex MUST): the probe runs the program `SHELL` names, which a restart takes from the
    // editable `core.start.json`; it never gets the secret variables the core holds (the restored keychain values
    // among them; ticket 1024: `process::command`, as every program the core starts). It only reads the login
    // shell's own exports, so it needs none.
    let mut command = crate::process::command(shell);
    let mark = String::from_utf8_lossy(MARK);
    let env_mark = "\\0__NUNCHIRO_LOGIN_ENV__\\0";
    command
        .args([
            "-ilc",
            &format!(
                "printf %s {mark}; printf %s \"$PATH\"; printf %s {mark}; printf '{env_mark}'; /usr/bin/env -0; printf '{env_mark}'"
            ),
        ])
        .env(PROBE_ENV, "1")
        .stdin(Stdio::null());
    let out = crate::process::output_detached(command, timeout, ENV_CAP)?;
    let find = |mark: &[u8], from: usize| {
        out.stdout[from..]
            .windows(mark.len())
            .position(|w| w == mark)
            .map(|i| from + i)
    };
    let start = find(MARK, 0).ok_or("no PATH in the shell output")? + MARK.len();
    let end = find(MARK, start).ok_or("no PATH in the shell output")?;
    let path = match &out.stdout[start..end] {
        [] => return Err("the shell printed an empty PATH".into()),
        value => OsString::from_vec(value.to_vec()),
    };
    let env = find(ENV_MARK, end)
        .map(|i| i + ENV_MARK.len())
        .and_then(|from| Some(from..find(ENV_MARK, from)?))
        .map(|body| {
            out.stdout[body]
                .split(|b| *b == 0)
                .filter_map(|record| {
                    let eq = record.iter().position(|b| *b == b'=').filter(|i| *i > 0)?;
                    Some((
                        OsString::from_vec(record[..eq].to_vec()),
                        OsString::from_vec(record[eq + 1..].to_vec()),
                    ))
                })
                .collect()
        })
        .ok_or_else(|| {
            format!(
                "the shell printed no whole environment (no /usr/bin/env -0, or over {} KiB)",
                ENV_CAP / 1024
            )
        });
    Ok((path, env))
}

/// The absolute entries of a PATH, in order.
fn absolute_only(list: &OsStr) -> OsString {
    let kept: Vec<_> = std::env::split_paths(list)
        .filter(|d| d.is_absolute())
        .collect();
    std::env::join_paths(kept).unwrap_or_default()
}

/// The entries of every list in order, each once (the first place wins, as in PATH lookup).
fn merge(lists: &[&OsStr]) -> OsString {
    let mut seen = Vec::new();
    for dir in lists.iter().flat_map(|l| std::env::split_paths(l)) {
        if !dir.as_os_str().is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    std::env::join_paths(seen).unwrap_or_else(|_| lists.last().copied().unwrap_or_default().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, time::Instant};

    /// A shell script that ignores its flags and runs `body`.
    fn fake_shell(tag: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("login-path-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("sh");
        fs::write(&shell, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        shell
    }

    #[test]
    fn login_entries_are_appended_after_the_own_path_and_a_banner_is_ignored() {
        let shell = fake_shell(
            "ok",
            "echo 'welcome to my rc'; printf %s __NUNCHIRO_LOGIN_PATH__/x/bin:/usr/bin:/bin__NUNCHIRO_LOGIN_PATH__; echo bye",
        );
        let (path, note, _) = resolve(
            shell.as_os_str(),
            Some(OsStr::new("/own/bin:/bin:/usr/bin")),
            Some(OsStr::new("/h")),
            Duration::from_secs(5),
        );
        assert_eq!(path, "/own/bin:/bin:/usr/bin:/x/bin");
        assert_eq!(
            note,
            "login PATH (login shell): /own/bin:/bin:/usr/bin:/x/bin"
        );
    }

    #[test]
    fn relative_login_entries_are_dropped_but_the_own_path_is_unchanged() {
        let shell = fake_shell(
            "rel",
            "printf %s __NUNCHIRO_LOGIN_PATH__.:bin:/x/bin::node_modules/.bin:/y/bin__NUNCHIRO_LOGIN_PATH__",
        );
        let (path, _, _) = resolve(
            shell.as_os_str(),
            Some(OsStr::new("/own/bin")),
            None,
            Duration::from_secs(5),
        );
        assert_eq!(path, "/own/bin:/x/bin:/y/bin");
    }

    #[test]
    fn a_slow_shell_times_out_and_the_fallback_adds_the_common_folders() {
        let shell = fake_shell("slow", "sleep 30");
        let started = Instant::now();
        let (path, note, _) = resolve(
            shell.as_os_str(),
            Some(OsStr::new("/usr/bin:/bin")),
            Some(OsStr::new("/h")),
            Duration::from_millis(300),
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(
            path,
            "/usr/bin:/bin:/h/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin"
        );
        assert!(note.starts_with("login PATH (fallback ("), "{note}");
    }

    #[test]
    fn a_shell_that_prints_no_markers_or_does_not_exist_falls_back() {
        for shell in [
            fake_shell("quiet", "echo hello"),
            "/nonexistent/shell".into(),
        ] {
            let (path, note, _) = resolve(
                shell.as_os_str(),
                Some(OsStr::new("/bin")),
                None,
                Duration::from_secs(5),
            );
            assert!(
                path.to_string_lossy().starts_with("/bin:/opt/homebrew/bin"),
                "{path:?}"
            );
            assert!(note.contains("fallback"), "{note}");
        }
    }
}
