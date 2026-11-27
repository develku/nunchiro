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

fn every(home: &Path) -> Duration {
    crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["triggers_poll_secs"].as_u64())
        .map(|s| Duration::from_secs(s.max(1)))
        .unwrap_or(EVERY)
}

/// The `gh` run for `g`, and the events it reads now: each event's key (what makes it new) and its payload.
fn events(
    g: &Github,
    run: &dyn Fn(&[String]) -> Result<Vec<u8>, String>,
) -> Result<Vec<(String, Value)>, String> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rows = |out: Vec<u8>| -> Result<Vec<Value>, String> {
        serde_json::from_slice::<Value>(&out)
            .map_err(|e| format!("gh answered something else: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "gh answered something else".to_string())
    };
    let pull = |r: &Value, what: &str| {
        let url = r["url"].as_str().unwrap_or_default().to_string();
        (
            format!("{url}@{}", r["headRefOid"].as_str().unwrap_or_default()),
            json!({"source": "github", "event": what, "repo": g.repo, "pull_request": {"html_url": url}}),
        )
    };
    Ok(match g.event {
        GithubEvent::ChecksFailed => {
            let out = run(&args(&[
                "pr",
                "list",
                "--repo",
                &g.repo,
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "url,headRefOid,statusCheckRollup",
            ]))?;
            rows(out)?
                .iter()
                .filter(|r| {
                    r["statusCheckRollup"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|c| {
                            let bad = |v: &Value| {
                                matches!(
                                    v.as_str(),
                                    Some("FAILURE" | "TIMED_OUT" | "ERROR" | "STARTUP_FAILURE")
                                )
                            };
                            bad(&c["conclusion"]) || bad(&c["state"])
                        })
                })
                .map(|r| pull(r, "checks_failed"))
                .collect()
        }
        GithubEvent::ChangesRequested => {
            let out = run(&args(&[
                "pr",
                "list",
                "--repo",
                &g.repo,
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "url,headRefOid,reviewDecision",
            ]))?;
            rows(out)?
                .iter()
                .filter(|r| r["reviewDecision"] == "CHANGES_REQUESTED")
                .map(|r| pull(r, "changes_requested"))
                .collect()
        }
        GithubEvent::Labeled => {
            let label = g.label.clone().unwrap_or_default();
            let out = run(&args(&[
                "issue", "list", "--repo", &g.repo, "--state", "open", "--label", &label,
                "--limit", "50", "--json", "url",
            ]))?;
            rows(out)?
                .iter()
                .map(|r| {
                    let url = r["url"].as_str().unwrap_or_default().to_string();
                    (url.clone(), json!({"source": "github", "event": "labeled", "label": label, "repo": g.repo, "issue": {"html_url": url}}))
                })
                .collect()
        }
    })
}

/// The events each trigger has seen, by (home, trigger); absent until its first read, which only sets the start.
type Seen = BTreeMap<(PathBuf, String), BTreeSet<String>>;

/// One pass over the GitHub triggers that are on: the new events of each fire it, in order.
pub(crate) fn poll(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    home: &Path,
    seen: &mut Seen,
    run: &dyn Fn(&[String]) -> Result<Vec<u8>, String>,
) {
    let Ok(all) = super::triggers::load(home) else {
        return;
    };
    for t in all.iter().filter(|t| t.on == Source::Github && !t.paused) {
        let Some(g) = &t.github else { continue };
        let found = match events(g, run) {
            Ok(found) => found,
            Err(e) => {
                eprintln!("trigger {}: {e}", t.name);
                continue;
            }
        };
        let key = (home.to_path_buf(), t.name.clone());
        let first = !seen.contains_key(&key);
        let known = seen.entry(key).or_default();
        for (k, payload) in found {
            if known.insert(k) && !first {
                if let Err(e) = super::triggers::fire(
                    registry,
                    stopping,
                    home,
                    &t.name,
                    Source::Github,
                    &payload.to_string(),
                ) {
                    eprintln!("trigger {}: {e}", t.name);
                }
            }
        }
    }
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
            let mut seen = Seen::new();
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
        }
    }

    #[test]
    fn a_failed_check_is_one_event_per_head_commit() {
        let answer = r#"[{"url": "https://github.com/o/r/pull/1", "headRefOid": "abc", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]},
                          {"url": "https://github.com/o/r/pull/2", "headRefOid": "def", "statusCheckRollup": [{"conclusion": "SUCCESS"}]}]"#;
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
        assert_eq!(
            asked.lock().unwrap()[0][..4],
            ["pr", "list", "--repo", "o/r"]
        );
    }
}
