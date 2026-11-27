//! The Diff panel's Push, run by the app after the window's confirm strip (web/src/diff/PushStrip.tsx). The strip shows
//! the commits, the remote branch and the head commit; the request carries that head, and the core reads the branch
//! again before anything runs. The push names its remote and destination ref and pushes the confirmed commit itself
//! (`git push <remote> <head>:refs/heads/<branch>`), so neither the folder's push config nor a commit made meanwhile
//! changes what goes out. Never `--force`, never a bare `git push`. The folder's own hooks run, as in a terminal.
//! Window only (sessions.rs, sessions/agent_calls.rs, http/browser.rs); an agent's own `git push` is its normal work
//! and is not gated here (outward.rs).
//!
//! Behaviour after Orca (src/main/git/remotes/remote.ts:44-50, `--set-upstream <remote> HEAD:<branch>`) and T3 Code
//! (apps/server/src/vcs/GitVcsDriverCore.ts:2604-2611); idea only, no code taken. The head re-check is the Merge
//! button's rule (pr/mod.rs `PrMerge`).
use crate::{api::*, diff, sessions::Sessions};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex, time::Duration};

/// How long a push may take: a slow network and a pre-push hook that runs the tests.
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Lines of git's own output kept under a refusal's sentence (a pre-push hook's test run is long).
const TAIL: usize = 20;

/// Where a push of the checked-out branch goes and how many commits it carries; part of `diff::GitFacts`, so the strip
/// shows what the core will push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct PushTo {
    pub remote: String,
    /// The branch name on the remote (`refs/heads/` stripped).
    pub branch: String,
    /// Commits on HEAD the remote branch lacks (against the upstream; without one, against every branch of the remote).
    pub ahead: u64,
    /// The branch has this upstream already; a first push sets it.
    pub upstream: bool,
    /// A fingerprint of the remote's push URL (never the URL, which may hold a token): a URL changed after the strip
    /// showed is caught.
    pub key: String,
}

/// What the strip showed and the window sends back: the push is refused unless all of it still holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Shown {
    #[serde(default)]
    pub head: String,
    #[serde(default)]
    pub remote: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub ahead: u64,
    #[serde(default)]
    pub key: String,
}

/// What the strip shows for `dir` now (the Diff list's git facts); `None` when there is nothing to push to.
pub fn shown(dir: &Path) -> Option<Shown> {
    let facts = diff::facts(dir)?;
    let to = facts.push_to?;
    Some(Shown {
        head: facts.head?,
        remote: to.remote,
        branch: to.branch,
        ahead: to.ahead,
        key: to.key,
    })
}

/// What a push did. `note`: the push went out but setting the branch's upstream failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pushed {
    pub pushed: u64,
    pub remote: String,
    pub branch: String,
    pub note: Option<String>,
}

/// A remote name the core puts on git's command line: no option look, no control characters, no spaces.
fn remote_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
}

/// The value of `key` in a `git config --get-regexp` listing (lowercased section and variable, the subsection as
/// written); the last one wins, as `git config --get` reads it.
fn value<'a>(config: &'a str, key: &str) -> Option<&'a str> {
    config
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(' '))
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// The remotes a listing names (`remote.<name>.url`), sorted.
fn remotes(config: &str) -> Vec<&str> {
    let mut names: Vec<&str> = config
        .lines()
        .filter_map(|l| {
            l.split_once(' ')?
                .0
                .strip_prefix("remote.")?
                .strip_suffix(".url")
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Where `branch` pushes, from `facts`' config listing (`remote.*.url`, `branch.*.remote`, `branch.*.pushremote`,
/// `remote.pushdefault`): its upstream's remote and branch when it has one (`merge` is that upstream's exact ref), else
/// `branch.<b>.pushRemote`, `remote.pushDefault`, `origin`, or the only remote. `Err` says why there is none.
/// `ahead` counts against the upstream (`facts`' `branch.ab`); without one it is counted here.
pub(crate) fn target(
    dir: &Path,
    config: &str,
    branch: &str,
    merge: Option<&str>,
    ahead: Option<u64>,
) -> Result<PushTo, String> {
    let known = remotes(config);
    let has = |r: &str| known.contains(&r) && remote_name(r);
    let (remote, to, upstream) = match merge {
        Some(merge) => {
            let remote = value(config, &format!("branch.{branch}.remote")).unwrap_or_default();
            if !has(remote) {
                return Err(
                    "not pushed: this branch tracks a branch that is not on a remote".into(),
                );
            }
            let to = merge
                .strip_prefix("refs/heads/")
                .filter(|b| !b.is_empty())
                .ok_or("not pushed: where this branch pushes is unknown")?;
            (remote.to_string(), to.to_string(), true)
        }
        None => {
            let named = value(config, &format!("branch.{branch}.pushremote"))
                .or_else(|| value(config, "remote.pushdefault"));
            let remote = match named {
                Some(r) if has(r) => r,
                Some(_) => {
                    return Err(
                        "not pushed: the push remote this branch names is not a remote".into(),
                    );
                }
                None if has("origin") => "origin",
                None if known.len() == 1 && has(known[0]) => known[0],
                None if known.is_empty() => {
                    return Err("not pushed: this repository has no remote".into());
                }
                None => {
                    return Err(format!(
                        "not pushed: this branch has no remote set and there are several ({})",
                        known.join(", ")
                    ));
                }
            };
            (remote.to_string(), branch.to_string(), false)
        }
    };
    let ahead = match ahead.filter(|_| upstream) {
        Some(n) => n,
        // Commits no branch of that remote has, as far as this clone knows.
        None => crate::process::git_read(
            dir,
            &[
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                &format!("--remotes={remote}"),
            ],
            READ_TIMEOUT,
        )
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o).trim().parse().ok())
        .ok_or("not pushed: git could not count the commits to push")?,
    };
    let url = crate::process::git_read(
        dir,
        &["remote", "get-url", "--push", "--all", "--", &remote],
        READ_TIMEOUT,
    )
    .map_err(|_| "not pushed: git could not read where the remote pushes")?;
    Ok(PushTo {
        // Every push URL (a push goes to all of them), without a user or password part.
        key: fingerprint(
            crate::process::without_userinfo(&String::from_utf8_lossy(&url)).as_bytes(),
        ),
        remote,
        branch: to,
        ahead,
        upstream,
    })
}

/// A stable fingerprint of `bytes` for this build (SipHash with fixed keys): it only has to tell two URLs apart.
fn fingerprint(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The last `TAIL` lines of git's error (after `git push: `).
fn tail(e: &str) -> String {
    let text = e.strip_prefix("git push:").unwrap_or(e).trim();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(TAIL)..].join("\n")
}

/// git's refusal as a sentence the window maps to its own line, git's lines under it.
fn refusal(e: &str, to: &PushTo, limit: Duration) -> String {
    let (remote, branch) = (&to.remote, &to.branch);
    let said = |s: &str| e.contains(s);
    let sentence = if said("command timed out") {
        return format!(
            "not pushed: git push did not finish in {} seconds",
            limit.as_secs()
        );
    } else if said("[rejected]") && (said("fetch first") || said("non-fast-forward")) {
        format!("not pushed: {remote} has newer commits on {branch}")
    } else if said("[remote rejected]") {
        format!("not pushed: {remote} refused the push")
    } else if said("Authentication failed")
        || said("could not read Username")
        || said("terminal prompts disabled")
        || said("Permission denied (publickey")
    {
        "not pushed: git needs you to sign in".to_string()
    } else if said("failed to push some refs") && !said(" -> ") {
        // A local pre-push hook stops the push before any ref is sent, so git prints no ref line.
        "not pushed: the pre-push hook failed".to_string()
    } else {
        "not pushed: git push failed".to_string()
    };
    format!("{sentence}\n{}", tail(e))
}

/// Pushes the checked-out branch of `dir` when it is still what the window's strip showed: the head commit, the remote,
/// the remote branch, the count and the push URL.
pub fn push(dir: &Path, shown: &Shown) -> Result<Pushed, String> {
    push_within(dir, shown, PUSH_TIMEOUT)
}

/// `push` with its own time limit (a test's).
pub fn push_within(dir: &Path, shown: &Shown, limit: Duration) -> Result<Pushed, String> {
    let head = shown.head.as_str();
    if !diff::valid_sha(head) {
        return Err("push needs the confirmed head commit".into());
    }
    let facts = diff::facts(dir).ok_or("not pushed: git's state could not be read")?;
    let branch = facts
        .branch
        .as_deref()
        .ok_or("not pushed: HEAD is not on a branch")?;
    if facts.is_default {
        return Err("not pushed: this is the default branch".into());
    }
    let now = facts.head.as_deref().unwrap_or_default();
    if now != head {
        let short = now.get(..7).unwrap_or(now);
        return Err(format!(
            "nothing was sent: the branch changed after this was shown (new head {short})"
        ));
    }
    if facts.upstream_unknown {
        return Err("not pushed: where this branch pushes is unknown".into());
    }
    let to = match facts.push_to {
        Some(to) => to,
        None => {
            return Err(facts
                .push_why
                .unwrap_or_else(|| "not pushed: where this branch pushes is unknown".into()));
        }
    };
    if shown.remote.is_empty() || shown.branch.is_empty() || shown.key.is_empty() {
        return Err("push needs what the strip showed".into());
    }
    if (to.remote.as_str(), to.branch.as_str(), to.ahead)
        == (shown.remote.as_str(), shown.branch.as_str(), shown.ahead)
        && to.key != shown.key
    {
        return Err(format!(
            "nothing was sent: the push URL of {} changed after this was shown",
            to.remote
        ));
    }
    if (
        to.remote.as_str(),
        to.branch.as_str(),
        to.ahead,
        to.key.as_str(),
    ) != (
        shown.remote.as_str(),
        shown.branch.as_str(),
        shown.ahead,
        shown.key.as_str(),
    ) {
        return Err(format!(
            "nothing was sent: where this pushes changed after this was shown (now {}/{})",
            to.remote, to.branch
        ));
    }
    // The push remote's own default branch (its recorded HEAD), on any remote, besides the names `facts` guards.
    let remote_default = crate::process::git_read(
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            &format!("refs/remotes/{}/HEAD", to.remote),
        ],
        READ_TIMEOUT,
    )
    .ok()
    .map(|o| String::from_utf8_lossy(&o).trim().to_string());
    if remote_default
        .is_some_and(|d| d.strip_prefix(&format!("{}/", to.remote)) == Some(to.branch.as_str()))
    {
        return Err("not pushed: this is the default branch".into());
    }
    if facts.behind > 0 {
        return Err(format!(
            "not pushed: {} has newer commits on {}",
            to.remote, to.branch
        ));
    }
    if to.ahead == 0 {
        return Err("not pushed: there are no new commits to push".into());
    }
    let refspec = format!("{head}:refs/heads/{}", to.branch);
    // No tags (push.followTags) and no submodule pushes (push.recurseSubmodules): only the shown commits go out.
    crate::process::git_write(
        dir,
        &[
            "push",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--",
            &to.remote,
            &refspec,
        ],
        limit,
    )
    .map_err(|e| refusal(&e, &to, limit))?;
    // A first push sets the upstream as `--set-upstream` would; the source here is a commit, which `-u` skips. The push
    // already went out, so a failure here is a note, not a failed push.
    let mut note = None;
    if !to.upstream {
        for (key, value) in [
            (format!("branch.{branch}.remote"), to.remote.clone()),
            (
                format!("branch.{branch}.merge"),
                format!("refs/heads/{}", to.branch),
            ),
        ] {
            if let Err(e) =
                crate::process::git_write(dir, &["config", "--", &key, &value], READ_TIMEOUT)
            {
                note = Some(format!("the branch's upstream was not set: {e}"));
                break;
            }
        }
    }
    Ok(Pushed {
        pushed: to.ahead,
        remote: to.remote,
        branch: to.branch,
        note,
    })
}

/// The window's `git_push` (window only); runs git, so off the frame loop.
pub(crate) fn answer(registry: &Mutex<Sessions>, request: Request) -> Response {
    let Request::GitPush { session, shown } = request else {
        return Err("not a git op".into());
    };
    if !diff::valid_sha(&shown.head) {
        return Err("push needs the confirmed head commit".into());
    }
    let dir = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .session_folder(&session)?;
    let Pushed {
        pushed,
        remote,
        branch,
        note,
    } = push(&dir, &shown)?;
    Ok(Reply::GitPushed {
        pushed,
        remote,
        branch,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_names_never_read_as_options() {
        assert!(remote_name("origin") && remote_name("my.fork") && remote_name("team/up"));
        for bad in ["", "-u", "--force", "a b", "a\nb", "a;b"] {
            assert!(!remote_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn git_errors_become_sentences() {
        let to = PushTo {
            remote: "origin".into(),
            branch: "fix".into(),
            ahead: 1,
            upstream: true,
            key: String::new(),
        };
        let r = |e: &str| {
            refusal(e, &to, PUSH_TIMEOUT)
                .lines()
                .next()
                .unwrap()
                .to_string()
        };
        assert_eq!(
            r(
                "git push: ! [rejected] abc -> fix (fetch first)\nerror: failed to push some refs to 'x'"
            ),
            "not pushed: origin has newer commits on fix"
        );
        assert_eq!(
            r("git push: ! [remote rejected] abc -> fix (pre-receive hook declined)"),
            "not pushed: origin refused the push"
        );
        assert_eq!(
            r(
                "git push: fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            ),
            "not pushed: git needs you to sign in"
        );
        assert_eq!(
            r("git push: tests failed\nerror: failed to push some refs to 'x'"),
            "not pushed: the pre-push hook failed"
        );
        assert_eq!(
            r("git push: fatal: something else"),
            "not pushed: git push failed"
        );
    }
}
