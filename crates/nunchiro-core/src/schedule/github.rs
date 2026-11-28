//! GitHub triggers (docs/triggers.md): while one is on, the core reads its repository with the user's own `gh` every
//! `EVERY` (settings.json `triggers_poll_secs` moves it), and fires the trigger once for each new event: an open pull
//! request whose checks failed or whose review asked for changes (once per head commit), or an open issue or pull
//! request that has the label. What is there when the core first reads a trigger is the starting point and fires
//! nothing; a core restart starts from what is there again. `gh` owns the login; Nunchiro reads no token. The argument
//! vector is constants plus the checked repository and label (`Github::check`).
use super::triggers::{Github, GithubEvent, Source};
use crate::sessions::Sessions;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const EVERY: Duration = Duration::from_secs(120);
const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// Runs `gh` with these arguments and answers its standard output.
type Gh<'a> = &'a dyn Fn(&[String]) -> Result<Vec<u8>, String>;

fn every(home: &Path) -> Duration {
    crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["triggers_poll_secs"].as_u64())
        .map(|s| Duration::from_secs(s.max(1)))
        .unwrap_or(EVERY)
}

/// gh's own filter (`--jq`), so its answer holds only what is needed: a check row is about 300 bytes, and the whole
/// answer of 50 pull requests would pass `process::OUTPUT_CAP` (64 KB) and be refused.
const FAILED_JQ: &str = r#"[.[] | select([.statusCheckRollup[]? | .conclusion, .state] | any(. == "FAILURE" or . == "TIMED_OUT" or . == "ERROR" or . == "STARTUP_FAILURE")) | {url, headRefOid}]"#;
const CHANGES_JQ: &str =
    r#"[.[] | select(.reviewDecision == "CHANGES_REQUESTED") | {url, headRefOid}]"#;
const URL_JQ: &str = "[.[] | {url}]";

/// The `gh` run for `g`, and the events it reads now: each event's key (what makes it new) and its payload.
fn events(g: &Github, run: Gh) -> Result<Vec<(String, Value)>, String> {
    let pulls = |fields: &str, jq: &str| {
        let mut a = vec![
            "pr", "list", "--repo", &g.repo, "--state", "open", "--limit", "50",
        ];
        if !g.any_author {
            a.extend(["--author", "@me"]);
        }
        a.extend(["--json", fields, "--jq", jq]);
        run(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    };
    let out = match g.event {
        GithubEvent::ChecksFailed => pulls("url,headRefOid,statusCheckRollup", FAILED_JQ)?,
        GithubEvent::ChangesRequested => pulls("url,headRefOid,reviewDecision", CHANGES_JQ)?,
        GithubEvent::Labeled => {
            let label = g.label.clone().unwrap_or_default();
            let a = [
                "issue", "list", "--repo", &g.repo, "--state", "open", "--label", &label,
                "--limit", "50", "--json", "url", "--jq", URL_JQ,
            ];
            run(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>())?
        }
    };
    let rows = serde_json::from_slice::<Value>(&out)
        .map_err(|e| format!("gh answered something else: {e}"))?
        .as_array()
        .cloned()
        .ok_or_else(|| "gh answered something else".to_string())?;
    let what = match g.event {
        GithubEvent::ChecksFailed => "checks_failed",
        GithubEvent::ChangesRequested => "changes_requested",
        GithubEvent::Labeled => "labeled",
    };
    Ok(rows
        .iter()
        .map(|r| {
            let url = r["url"].as_str().unwrap_or_default().to_string();
            match g.event {
                GithubEvent::Labeled => (
                    url.clone(),
                    json!({"source": "github", "event": what, "label": g.label, "repo": g.repo, "issue": {"html_url": url}}),
                ),
                _ => (
                    format!("{url}@{}", r["headRefOid"].as_str().unwrap_or_default()),
                    json!({"source": "github", "event": what, "repo": g.repo, "pull_request": {"html_url": url}}),
                ),
            }
        })
        .collect())
}

/// What the poller keeps per trigger, by (home, trigger, what it watches): a trigger removed and added again for
/// another repository starts from its own first read.
#[derive(Default)]
pub(crate) struct Seen {
    /// The events that fired or raised a card; absent until the trigger's first read, which only sets the start.
    fired: BTreeMap<(PathBuf, String, String), BTreeSet<String>>,
    /// The last gh failure each trigger recorded, so a failing gh is one line in its last fire, not one a poll.
    failing: BTreeMap<(PathBuf, String), String>,
}

/// One pass over the GitHub triggers that are on: the new events of each fire it, in order. An event whose fire was
/// held (its cards, its hour, a run of its subject still at work) is not seen yet: the next pass tries it again.
pub(crate) fn poll(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    home: &Path,
    seen: &mut Seen,
    run: Gh,
) {
    let Ok(all) = super::triggers::load(home) else {
        return;
    };
    for t in all.iter().filter(|t| t.on == Source::Github && !t.paused) {
        let Some(g) = &t.github else { continue };
        let named = (home.to_path_buf(), t.name.clone());
        let found = match events(g, run) {
            Ok(found) => found,
            Err(e) => {
                if seen.failing.get(&named) != Some(&e) {
                    let last = super::Last {
                        session: None,
                        at: crate::queue::now_ms(),
                        result: Some(super::Outcome::Failed),
                        reason: Some(e.chars().take(200).collect()),
                    };
                    let _ = super::triggers::record(home, &t.name, last);
                    eprintln!("trigger {}: {e}", t.name);
                    seen.failing.insert(named, e);
                }
                continue;
            }
        };
        seen.failing.remove(&named);
        let key = (
            named.0,
            named.1,
            serde_json::to_string(g).unwrap_or_default(),
        );
        let Some(known) = seen.fired.get_mut(&key) else {
            seen.fired
                .insert(key, found.into_iter().map(|(k, _)| k).collect());
            continue;
        };
        for (k, payload) in found {
            if known.contains(&k) {
                continue;
            }
            let at = crate::queue::now_ms();
            match super::triggers::fire(
                registry,
                stopping,
                home,
                &t.name,
                Source::Github,
                &payload.to_string(),
            ) {
                Ok(_) => {
                    known.insert(k);
                }
                // A start that failed (not one held) fails again on the next read: seen, and the last fire says so.
                Err(e) if failed_since(home, &t.name, at) => {
                    known.insert(k);
                    let last = super::Last {
                        session: None,
                        at,
                        result: Some(super::Outcome::Failed),
                        reason: Some(format!(
                            "{}; not tried again until a new head commit",
                            e.chars().take(150).collect::<String>()
                        )),
                    };
                    let _ = super::triggers::record(home, &t.name, last);
                }
                Err(e) => eprintln!("trigger {}: {e}", t.name),
            }
        }
    }
}

/// The trigger's last fire is a failed start at or after `at` (`triggers::start` records it).
fn failed_since(home: &Path, name: &str, at: u64) -> bool {
    super::triggers::load(home).is_ok_and(|all| {
        all.iter().any(|t| {
            t.name == name
                && t.last
                    .as_ref()
                    .is_some_and(|l| l.at >= at && l.result == Some(super::Outcome::Failed))
        })
    })
}

/// The poller's thread: asleep while no GitHub trigger is on.
pub(crate) fn spawn(
    registry: Arc<Mutex<Sessions>>,
    stopping: Arc<AtomicBool>,
    home: PathBuf,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("github-triggers".into())
        .spawn(move || {
            let mut seen = Seen::default();
            let mut last: Option<Instant> = None;
            while !stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
                let on = super::triggers::load(&home)
                    .is_ok_and(|all| all.iter().any(|t| t.on == Source::Github && !t.paused));
                if !on || last.is_some_and(|l| l.elapsed() < every(&home)) {
                    continue;
                }
                last = Some(Instant::now());
                let run = |a: &[String]| crate::pr_live::run_gh(a, GH_TIMEOUT);
                poll(&registry, &stopping, &home, &mut seen, &run);
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(event: GithubEvent) -> Github {
        Github {
            repo: "o/r".into(),
            event,
            label: None,
            any_author: false,
        }
    }

    #[test]
    fn a_failed_check_is_one_event_per_head_commit_of_the_owners_own_pulls() {
        // gh filters with `--jq`: its answer is the failing pull requests only.
        let answer = r#"[{"url": "https://github.com/o/r/pull/1", "headRefOid": "abc"}]"#;
        let asked = Mutex::new(vec![]);
        let run = |a: &[String]| {
            asked.lock().unwrap().push(a.to_vec());
            Ok(answer.as_bytes().to_vec())
        };
        let found = events(&watch(GithubEvent::ChecksFailed), &run).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "https://github.com/o/r/pull/1@abc");
        assert_eq!(
            found[0].1["pull_request"]["html_url"],
            "https://github.com/o/r/pull/1"
        );
        let asked = asked.lock().unwrap()[0].join(" ");
        assert!(
            asked.starts_with("pr list --repo o/r --state open"),
            "{asked}"
        );
        assert!(
            asked.contains("--author @me") && asked.contains("--jq"),
            "{asked}"
        );
    }

    #[test]
    fn a_mention_is_one_event_per_open_issue_or_pull_that_mentions_the_owner() {
        let answer = r#"[{"url": "https://github.com/o/r/issues/3"}]"#;
        let asked = Mutex::new(vec![]);
        let run = |a: &[String]| {
            asked.lock().unwrap().push(a.to_vec());
            Ok(answer.as_bytes().to_vec())
        };
        let found = events(&watch(GithubEvent::Mentioned), &run).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "https://github.com/o/r/issues/3");
        assert_eq!(found[0].1["event"], "mentioned");
        assert_eq!(
            found[0].1["issue"]["html_url"],
            "https://github.com/o/r/issues/3"
        );
        let asked = asked.lock().unwrap()[0].join(" ");
        assert!(
            asked.starts_with("search issues --repo o/r --mentions @me --state open --include-prs"),
            "{asked}"
        );
    }
}
