//! V2.5-20 (WP2): the core's half of `nunchiro browser`. A session's verb waits here until the app, which long-polls
//! `browser_next` over the owner socket, runs it on that session's web view and answers with `browser_done`.
//! Threat model (docs/design/v25-threat-model.md): the space is always the caller's own session (A2) and never the
//! "you" store (A3); token-less and window callers are refused (A6, C1); only the owner (the app) takes jobs; nothing
//! here opens a listener (A5) or touches grants (C2); there is no `eval` verb (owner answer Q1).
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::api::{Reply, Request, Response};

/// The owner's own store in the app; no agent verb ever runs in it.
pub const YOU: &str = "you";
/// How long one `browser_next` waits for a job before the app polls again.
pub const POLL: Duration = Duration::from_secs(10);
/// How long a verb waits for the app's answer; below the CLI's 15 s read timeout.
pub const VERB_WAIT: Duration = Duration::from_secs(12);
/// The app counts as attached while it polled within this long.
const ATTACHED: Duration = Duration::from_secs(15);
/// Verbs in flight (queued, or taken by the app and not answered) for one space, and for all spaces together. Each holds
/// one of the owner socket's 32 connection threads for up to `VERB_WAIT`, so the total stays far below that: owner,
/// window-token-less CLI and hook requests always find a thread.
const PENDING_MAX: usize = 4;
pub const TOTAL_MAX: usize = 8;
pub const BUSY: &str = "The browser is busy with earlier commands; wait for them, then try again";

/// The closed verb set (C4). No variant names a space, a session or a grant, and no variant carries script (Q1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verb", rename_all = "snake_case", deny_unknown_fields)]
pub enum Verb {
    /// A new tab in the caller's space, which becomes the current tab.
    Open {
        url: String,
    },
    Goto {
        url: String,
    },
    /// Indexed actionable elements plus visible text, viewport only; `tree` gives the role tree, `full` the whole page.
    Snapshot {
        #[serde(default)]
        tree: bool,
        #[serde(default)]
        full: bool,
    },
    Click {
        index: u32,
    },
    Fill {
        index: u32,
        text: String,
    },
    Select {
        index: u32,
        option: String,
    },
    Press {
        key: String,
    },
    Scroll {
        down: bool,
    },
    Tabs {},
    Tab {
        tab: u32,
    },
    /// The agent needs the owner (a password, a captcha): the app tells the window; the agent stops.
    Handoff {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    pub space: String,
    pub verb: Verb,
    /// V2.5-21 (WP3): when the agent sent it (microseconds since the Unix epoch). The app drops a job sent before the owner's
    /// last Hand back of the space, so a verb queued before or during his takeover never runs on the page he changed.
    #[serde(default)]
    pub queued: u64,
}

/// Microseconds since the Unix epoch; the app compares a job's `queued` with its own Hand back time in the same unit.
pub fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

#[derive(Default)]
struct State {
    next: u64,
    queue: VecDeque<Job>,
    /// In-flight verb ids and their space.
    waiting: HashMap<u64, String>,
    done: HashMap<u64, Result<serde_json::Value, String>>,
    polled: Option<Instant>,
    /// Ticket 998 L10 (B9): jobs the app took and has not answered, with their space and when they were taken. A space's
    /// next job waits here until its taken one is answered, so the app runs one job per space and spaces run side by side.
    taken: HashMap<u64, (String, Instant)>,
}

#[derive(Default)]
struct Broker {
    state: Mutex<State>,
    wake: Condvar,
}

/// One broker per core home (tests run several cores in one process).
fn broker(home: &Path) -> Arc<Broker> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<Broker>>>> = OnceLock::new();
    let mut all = ALL
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    all.entry(home.to_path_buf()).or_default().clone()
}

/// Queues `verb` for `space` and waits for the app's answer. A verb the app has not taken by the deadline is dropped,
/// never replayed later.
pub fn run(
    home: &Path,
    space: &str,
    verb: Verb,
    wait: Duration,
) -> Result<serde_json::Value, String> {
    // Ticket 328: the owner's later tabs are `you:<id>` spaces on his own store and rules.
    if space == YOU || space.is_empty() || space.starts_with("you:") {
        return Err("browser verbs never run in the owner's own browser".into());
    }
    let b = broker(home);
    let mut s = b.state.lock().map_err(|_| "browser broker unavailable")?;
    if !s.polled.is_some_and(|t| t.elapsed() < ATTACHED) {
        return Err("The browser needs the Nunchiro app open on this Mac".into());
    }
    if s.waiting.len() >= TOTAL_MAX
        || s.waiting.values().filter(|v| *v == space).count() >= PENDING_MAX
    {
        return Err(BUSY.into());
    }
    s.next += 1;
    let id = s.next;
    s.queue.push_back(Job {
        id,
        space: space.into(),
        verb,
        queued: now_micros(),
    });
    s.waiting.insert(id, space.into());
    b.wake.notify_all();
    let until = Instant::now() + wait;
    loop {
        if let Some(result) = s.done.remove(&id) {
            s.waiting.remove(&id);
            return result;
        }
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            s.waiting.remove(&id);
            let queued = s.queue.iter().any(|j| j.id == id);
            s.queue.retain(|j| j.id != id);
            // A job the app already took may still finish in the page: say so, so the agent looks before repeating it.
            return Err(if queued { NOT_STARTED } else { MAY_HAVE_RUN }.into());
        }
        s = b
            .wake
            .wait_timeout(s, left)
            .map_err(|_| "browser broker unavailable")?
            .0;
    }
}

pub const NOT_STARTED: &str = "The browser did not start this command in time; nothing ran";
pub const MAY_HAVE_RUN: &str = "The browser took this command but gave no answer in time: it may still have run. Take a snapshot to see the page before doing anything again";

/// The app's poll: the next job of a space with no job in the app, or `None` after `wait`. The app polls again as soon
/// as it handed a job to that space's worker, so `polled` stays fresh while jobs run (B9).
pub fn next(home: &Path, wait: Duration) -> Option<Job> {
    let b = broker(home);
    let mut s = b.state.lock().ok()?;
    let until = Instant::now() + wait;
    loop {
        s.polled = Some(Instant::now());
        // A taken job past VERB_WAIT has no waiter left (an app that quit mid-job never answers); its space is free.
        s.taken.retain(|_, (_, at)| at.elapsed() < VERB_WAIT);
        let State { queue, taken, .. } = &mut *s;
        if let Some(at) = queue
            .iter()
            .position(|j| !taken.values().any(|(space, _)| *space == j.space))
            && let Some(job) = queue.remove(at)
        {
            taken.insert(job.id, (job.space.clone(), Instant::now()));
            return Some(job);
        }
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        s = b.wake.wait_timeout(s, left).ok()?.0;
    }
}

/// The app's answer; one for a job nobody waits on any more is dropped.
pub fn finish(home: &Path, id: u64, result: Result<serde_json::Value, String>) {
    let b = broker(home);
    let Ok(mut s) = b.state.lock() else { return };
    s.taken.remove(&id);
    if s.waiting.contains_key(&id) {
        s.done.insert(id, result);
    }
    // Wakes the waiter, and the poll for a job its space held back.
    b.wake.notify_all();
}

fn is_browser(request: &Request) -> bool {
    matches!(
        request,
        Request::Browser { .. } | Request::BrowserNext | Request::BrowserDone { .. }
    )
}

/// The owner socket's browser requests, answered off the registry lock. `owner` is already false for a peer inside a
/// session (`server::connection`), so a session's own copy of the owner token is that session's caller. `caller`
/// resolves a session token to its session id.
pub(crate) fn serve(
    home: &Path,
    owner: bool,
    request: &Request,
    caller: impl FnOnce() -> Result<String, String>,
) -> Option<Response> {
    Some(match request {
        // Never forwarded to or from another machine: a space is a web view in this Mac's app.
        Request::Remote { request, .. } | Request::Forwarded { request, .. }
            if is_browser(request) =>
        {
            Err("browser verbs are local to this Mac".into())
        }
        Request::Browser { .. } if owner => Err(
            "browser verbs run from inside an agent session; the owner drives the browser in the window"
                .into(),
        ),
        Request::Browser { verb } => caller().and_then(|space| {
            run(home, &space, verb.clone(), VERB_WAIT).map(|result| Reply::Browser { result })
        }),
        Request::BrowserNext | Request::BrowserDone { .. } if !owner => {
            Err("operation not granted".into())
        }
        Request::BrowserNext => Ok(Reply::BrowserJob {
            job: next(home, POLL),
        }),
        Request::BrowserDone { id, result } => {
            finish(home, *id, result.clone());
            Ok(Reply::Ack)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn home(tag: &str) -> PathBuf {
        PathBuf::from(format!("/nonexistent/browser-test-{tag}"))
    }

    /// A fake app: takes one job and answers with its space and verb.
    fn app(home: PathBuf) -> thread::JoinHandle<Job> {
        thread::spawn(move || {
            loop {
                if let Some(job) = next(&home, Duration::from_millis(200)) {
                    finish(&home, job.id, Ok(serde_json::json!({"space": job.space})));
                    return job;
                }
            }
        })
    }

    fn attach(home: &Path) {
        assert!(next(home, Duration::ZERO).is_none());
    }

    #[test]
    fn verb_reaches_the_app_and_its_answer_comes_back() {
        let h = home("roundtrip");
        attach(&h);
        let app = app(h.clone());
        let got = run(&h, "s1", Verb::Tabs {}, Duration::from_secs(5)).unwrap();
        assert_eq!(got["space"], "s1");
        assert_eq!(app.join().unwrap().verb, Verb::Tabs {});
    }

    #[test]
    fn no_app_attached_refuses_at_once() {
        let h = home("noapp");
        let t = Instant::now();
        let e = run(&h, "s1", Verb::Tabs {}, Duration::from_secs(5)).unwrap_err();
        assert!(e.contains("app open"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn unanswered_verb_is_dropped_not_replayed() {
        let h = home("drop");
        attach(&h);
        let e = run(&h, "s1", Verb::Tabs {}, Duration::from_millis(100)).unwrap_err();
        assert_eq!(e, NOT_STARTED, "a job the app never took did not run");
        assert!(
            next(&h, Duration::ZERO).is_none(),
            "the timed-out job must not reach the app later"
        );
        finish(&h, 1, Ok(serde_json::json!(1))); // a late answer is dropped, not stored
        assert!(broker(&h).state.lock().unwrap().done.is_empty());
    }

    #[test]
    fn a_space_cannot_flood_the_queue() {
        let h = home("flood");
        attach(&h);
        let waiters: Vec<_> = (0..PENDING_MAX)
            .map(|_| {
                let h = h.clone();
                thread::spawn(move || run(&h, "s1", Verb::Tabs {}, Duration::from_secs(2)))
            })
            .collect();
        let until = Instant::now() + Duration::from_secs(2);
        while broker(&h).state.lock().unwrap().queue.len() < PENDING_MAX {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        let e = run(&h, "s1", Verb::Tabs {}, Duration::from_secs(1)).unwrap_err();
        assert!(e.contains("busy"), "{e}");
        // Another session is not held up by this one.
        let other = thread::spawn({
            let h = h.clone();
            move || run(&h, "s2", Verb::Tabs {}, Duration::from_millis(200))
        });
        assert_eq!(other.join().unwrap().unwrap_err(), NOT_STARTED);
        for w in waiters {
            let _ = w.join();
        }
    }

    /// Fills the broker with `n` in-flight verbs spread over spaces (at most `PENDING_MAX` each); returns their threads.
    fn in_flight(
        h: &Path,
        n: usize,
        wait: Duration,
    ) -> Vec<thread::JoinHandle<Result<serde_json::Value, String>>> {
        let threads = (0..n)
            .map(|i| {
                let (h, space) = (h.to_path_buf(), format!("s{}", i % 3));
                thread::spawn(move || run(&h, &space, Verb::Tabs {}, wait))
            })
            .collect();
        let until = Instant::now() + Duration::from_secs(2);
        while broker(h).state.lock().unwrap().waiting.len() < n {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        threads
    }

    /// Round 2 MUST: waiting plus running verbs across every space stay at `TOTAL_MAX`, so they can never take the
    /// owner socket's 32 connection threads. A job the app took and has not answered still counts.
    #[test]
    fn browser_global_pending_cap() {
        let h = home("global");
        attach(&h);
        let threads = in_flight(&h, TOTAL_MAX, Duration::from_millis(800));
        let taken = next(&h, Duration::ZERO).expect("the app takes one job; it is still in flight");
        for space in ["s0", "s9", "fresh"] {
            assert_eq!(
                run(&h, space, Verb::Tabs {}, Duration::from_secs(1)).unwrap_err(),
                BUSY,
                "{space}"
            );
        }
        assert_eq!(broker(&h).state.lock().unwrap().waiting.len(), TOTAL_MAX);
        finish(&h, taken.id, Ok(serde_json::json!({})));
        for t in threads {
            let _ = t.join();
        }
        // Once they are answered or dropped, the cap is free again.
        assert!(broker(&h).state.lock().unwrap().waiting.is_empty());
        let app = app(h.clone());
        assert!(run(&h, "s0", Verb::Tabs {}, Duration::from_secs(2)).is_ok());
        app.join().unwrap();
    }

    /// Ticket 998 L10 (B9): a space's job held by the app never holds another space's verb; the space's own next verb
    /// waits until the app answers the first, so one space's jobs never interleave.
    #[test]
    fn spaces_run_side_by_side_one_job_each() {
        let h = home("perspace");
        attach(&h);
        let verb = |space: &'static str| {
            let h = h.clone();
            thread::spawn(move || run(&h, space, Verb::Tabs {}, Duration::from_secs(3)))
        };
        let (a1, a2) = (verb("a"), verb("a"));
        let slow = next(&h, Duration::from_secs(1)).expect("a's first job");
        assert_eq!(slow.space, "a");
        let until = Instant::now() + Duration::from_secs(2);
        while broker(&h).state.lock().unwrap().queue.is_empty() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            next(&h, Duration::from_millis(100)).is_none(),
            "a's second job waits for its first"
        );
        let b = verb("b");
        let t = Instant::now();
        let other = next(&h, Duration::from_secs(1)).expect("b is not held by a's slow job");
        assert_eq!(other.space, "b");
        assert!(t.elapsed() < Duration::from_millis(500));
        finish(&h, other.id, Ok(serde_json::json!({"space": "b"})));
        assert_eq!(b.join().unwrap().unwrap()["space"], "b");
        finish(&h, slow.id, Ok(serde_json::json!({})));
        let second =
            next(&h, Duration::from_secs(1)).expect("a's second job, once the first is answered");
        assert_eq!(second.space, "a");
        finish(&h, second.id, Ok(serde_json::json!({})));
        assert!(a1.join().unwrap().is_ok() && a2.join().unwrap().is_ok());
    }

    /// Round 2 MUST: a verb whose job the app took but never answered may have run in the page; the error says so and
    /// does not read as a plain "no answer" that invites a blind retry.
    #[test]
    fn timeout_says_may_have_run() {
        let h = home("ran");
        attach(&h);
        let waiter = {
            let h = h.clone();
            thread::spawn(move || {
                run(
                    &h,
                    "s1",
                    Verb::Click { index: 3 },
                    Duration::from_millis(300),
                )
            })
        };
        let job = loop {
            if let Some(job) = next(&h, Duration::from_millis(50)) {
                break job;
            }
        };
        assert_eq!(job.verb, Verb::Click { index: 3 });
        let e = waiter.join().unwrap().unwrap_err();
        assert_eq!(e, MAY_HAVE_RUN);
        assert!(
            e.contains("may still have run")
                && e.contains("snapshot")
                && !e.contains("did not answer")
        );
        assert!(
            broker(&h).state.lock().unwrap().waiting.is_empty(),
            "a late answer is dropped"
        );
    }

    /// Round 2: the threat model records what WP2 left for later (A15) and the owner-token scope of the job poll.
    #[test]
    fn threat_model_lines() {
        let doc = include_str!("../../../../docs/design/v25-threat-model.md");
        let a15 = doc
            .lines()
            .find(|l| l.starts_with("A15 follow-up"))
            .expect("A15 follow-up line");
        assert!(
            a15.contains("2 spaces per session")
                && a15.contains("not built yet")
                && a15.contains("8 in total")
        );
        let scope = doc
            .lines()
            .find(|l| l.contains("owner token's scope"))
            .expect("owner-token scope line");
        assert!(
            scope.contains("browser_next")
                && scope.contains("browser_done")
                && scope.contains("same user")
        );
        let uncovered = doc.find("## What this does not cover").unwrap();
        assert!(
            doc.find(scope).unwrap() > uncovered,
            "listed as not covered"
        );
    }

    /// WP3: the app tells a stale job (sent before the owner's Hand back) by this stamp.
    #[test]
    fn job_carries_its_queue_time() {
        let h = home("queued");
        attach(&h);
        let before = now_micros();
        let waiter = {
            let h = h.clone();
            thread::spawn(move || run(&h, "s1", Verb::Tabs {}, Duration::from_millis(300)))
        };
        let job = loop {
            if let Some(job) = next(&h, Duration::from_millis(50)) {
                break job;
            }
        };
        assert!(
            job.queued >= before && job.queued <= now_micros(),
            "{}",
            job.queued
        );
        let _ = waiter.join();
        let old: Job =
            serde_json::from_str(r#"{"id":1,"space":"s","verb":{"verb":"tabs"}}"#).unwrap();
        assert_eq!(
            old.queued, 0,
            "a frame without the stamp reads as sent long ago"
        );
    }

    #[test]
    fn agent_verbs_refuse_you_store() {
        let h = home("you");
        attach(&h);
        for space in [YOU, "", "you:a1"] {
            let e = run(&h, space, Verb::Tabs {}, Duration::from_secs(1)).unwrap_err();
            assert!(e.contains("the owner's own"), "{e}");
        }
        assert!(
            next(&h, Duration::ZERO).is_none(),
            "nothing queued for the you store"
        );
    }

    /// Ticket 264: picking, clearing and removing a profile exist only as main-window commands of the app. An agent's verb
    /// cannot name one, no core request carries one (so a remote or paired caller has nothing to send, forwarded or not),
    /// and the web widget bridge has no such message.
    #[test]
    fn profile_clear_refused_from_agent_remote_and_widget() {
        for verb in [
            r#"{"verb":"profile_clear","profile":"default"}"#,
            r#"{"verb":"profile_remove","profile":"default"}"#,
            r#"{"verb":"profile_create","name":"x"}"#,
            r#"{"verb":"profile_pick","profile":"default"}"#,
            r#"{"verb":"open","url":"https://a","profile":"work"}"#,
            r#"{"verb":"goto","url":"https://a","profile":"work"}"#,
        ] {
            assert!(serde_json::from_str::<Verb>(verb).is_err(), "{verb}");
        }
        for op in [
            "browser_profiles",
            "browser_profile_clear",
            "browser_profile_remove",
        ] {
            let frame = serde_json::json!({"op": op, "profile": "default"});
            assert!(serde_json::from_value::<Request>(frame).is_err(), "{op}");
        }
        let bridge = include_str!("../../../../web/src/webwidgets/bridge.ts");
        assert!(
            bridge.contains("METHODS = ['context', 'act']") && !bridge.contains("browser_profile"),
            "the widget bridge stays two methods"
        );
        // The app's half: every profile command is behind the main-window check.
        let app = include_str!("../../../../app/src-tauri/src/browser/mod.rs");
        for command in [
            "browser_profiles",
            "browser_profile_clear",
            "browser_profile_remove",
        ] {
            let body = app
                .split(&format!("pub async fn {command}("))
                .nth(1)
                .expect(command);
            let body = &body[..body.find("spawn_blocking").expect(command)];
            assert!(body.contains("main_window_only(&webview)?"), "{command}");
        }
    }

    /// Ticket 264: the profile list and the picks live in `features`, so an agent that could write settings could add,
    /// repoint or pick a profile. A session caller's `quit_settings` is refused, and nothing reaches the file.
    #[test]
    fn agent_cannot_write_the_profile_list() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("browser-profile-agent-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let mut core = crate::sessions::Sessions::open(&home).unwrap();
        let caller = crate::grants::Caller {
            id: "s1".into(),
            project: home.clone(),
        };
        for key in ["browser.profiles", "browser.space_profiles"] {
            let patch = serde_json::from_value(serde_json::json!({"features": {key: []}})).unwrap();
            assert_eq!(
                core.handle_agent(&caller, Request::QuitSettings { patch })
                    .unwrap_err(),
                "operation not granted",
                "{key}"
            );
        }
        let settings = std::fs::read_to_string(home.join("settings.json")).unwrap_or_default();
        assert!(!settings.contains("browser."), "{settings}");
        drop(core);
        let _ = std::fs::remove_dir_all(home);
    }

    /// C4: the verb set is closed; a frame naming a space, a session or an unknown verb (`eval`) does not parse.
    #[test]
    fn app_browser_link_typed_variants_only() {
        for bad in [
            r#"{"verb":"eval","script":"document.cookie"}"#,
            r#"{"verb":"goto","url":"https://a","space":"s2"}"#,
            r#"{"verb":"tabs","session":"s2"}"#,
            r#"{"verb":"click","index":1,"grant":"act"}"#,
        ] {
            assert!(serde_json::from_str::<Verb>(bad).is_err(), "{bad}");
        }
        assert_eq!(
            serde_json::from_str::<Verb>(r#"{"verb":"snapshot"}"#).unwrap(),
            Verb::Snapshot {
                tree: false,
                full: false
            }
        );
    }
}
