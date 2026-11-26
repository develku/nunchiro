//! V2.5-20 (WP2): the app's half of `nunchiro browser`. One thread long-polls the core (`browser_next` on the owner
//! socket, no new listener: threat model A5) and hands each job to its space's worker, which runs it on the session's
//! own web view and answers (`browser_done`). Ticket 998 L10 (B9): one space's slow job never holds another's verb; a
//! space's jobs run one at a time (the core hands out its next job only after its last is answered), so its actions
//! never interleave. WKWebView calls stay on the main thread. Page reads go through `snapshot.js` in an isolated content
//! world (A10); clicks and typing are native AppKit events sent to the web view, so pages see trusted input. There is
//! no script verb (owner answer Q1) and no verb for the owner's "you" store (A3). A space's first tab is the view the side
//! pane shows for that session (WP1's label); later tabs share its data store, its profile's (ticket 264).
use std::{
    cell::Cell,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, webview::WebviewBuilder,
};

use super::{control, view};
// Ticket 1162: two parts with their own job moved out; each child says its own in one `//!` line.
mod settle;
mod workers;
use settle::*;
use workers::*;

const SCRIPT: &str = include_str!("snapshot.js");
/// The owner's own store; never an agent's (A3).
pub(super) const YOU: &str = "you";
/// A15: tabs per space.
const TABS_MAX: usize = 8;
/// The core's frame limit is 512 KiB; an answer stays well below it.
const ANSWER_MAX: usize = 400 * 1024;
/// Characters of a done line kept when an action's answer is over ANSWER_MAX (`fit`).
const DONE_MAX: usize = 2000;

/// Ticket 998 L3 (B1): where the app spent one job's time, sent back as `hops` (the CLI prints it with
/// NUNCHIRO_BROWSER_HOPS=1). `main`: waits for the main thread; `call`: page and native calls, main waits included;
/// `settle`: settle waits, their page calls included. `wake`: bringing a throttled page back to full speed before the
/// job (998 L9). One record per space worker (998 L10); a main-thread call adds its wait through the record it captured.
#[derive(Default)]
struct Hops {
    main: Duration,
    call: Duration,
    calls: u32,
    settle: Duration,
    wake: Duration,
}

thread_local! {
    static HOPS: Arc<Mutex<Hops>> = Arc::default();
    /// Ticket 998 L10 (B9): when this worker's job must have its answer ready (`answer`); `None` off a job.
    static UNTIL: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// This thread's record, for a main-thread call to add its wait to (`hop_in`).
fn hops() -> Arc<Mutex<Hops>> {
    HOPS.with(Arc::clone)
}

fn hop(f: impl FnOnce(&mut Hops)) {
    hop_in(&hops(), f)
}

fn hop_in(rec: &Mutex<Hops>, f: impl FnOnce(&mut Hops)) {
    if let Ok(mut h) = rec.lock() {
        f(&mut h);
    }
}

/// Ticket 998 L10 (B9): the job's answer is ready this long after the agent sent it, so it reaches the core before
/// the verb's VERB_WAIT (12 s) and the agent gets an outcome line, never the core's "may have run".
const ANSWER_BY: Duration = Duration::from_secs(11);
/// 998 L10 round 3 (B3): a job starts its action only with this much of its clock left, so the action's answer (or its
/// "outcome unknown" line) still reaches the agent; with less, nothing runs and the agent is told so.
const START_MIN: Duration = Duration::from_secs(1);
const OUT_OF_TIME: &str = "Not run: out of time. This command waited too long behind earlier ones or for the page to wake; nothing ran";

/// Runs `action` (the job's verb) only while START_MIN of the job's clock is left; checked right before it starts.
fn in_time<T>(action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if left() < START_MIN {
        return Err(OUT_OF_TIME.into());
    }
    action()
}

/// Time left on this worker's job (unbounded off a job). Every wait of a job is cut to it.
fn left() -> Duration {
    UNTIL.get().map_or(Duration::MAX, |t| {
        t.saturating_duration_since(Instant::now())
    })
}
/// A view the side pane has not placed yet lives outside the window: laid out and rendering, not on screen. Its size is
/// the default viewport of the browser settings (ticket 255, O-171), so agent snapshots see that size.
const PARKED: (f64, f64) = (-20000.0, 0.0);

/// The app's own closed copy of the core's verb set (C4): an unknown verb or field is refused, never guessed.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "verb", rename_all = "snake_case", deny_unknown_fields)]
enum Verb {
    Open {
        url: String,
    },
    Goto {
        url: String,
    },
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
    Handoff {
        reason: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // `id` is required in the frame; `answer` reads it from the frame so a refused frame is answered too
struct Job {
    id: u64,
    space: String,
    verb: Verb,
    /// When the agent sent it; missing reads as long ago (`control::gate`).
    #[serde(default)]
    queued: u64,
}

/// Tab labels per space, in order; `current` indexes them.
#[derive(Default)]
struct Space {
    tabs: Vec<String>,
    current: usize,
    /// Ticket 307: the address a page last asked to open in a new window (any tab, capped); the next verb's answer carries it.
    popup: Option<String>,
    /// Ticket 307: what the pane's view last asked for, while it is still that page. `Some(None)`: a window that was refused
    /// with nothing to offer. Survives the pane closing; a changed value is the only thing that reaches the window.
    asked: Option<Option<String>>,
    /// Ticket 264: the profile its views use, until Forget or a first open that failed; every later tab uses the same store.
    profile: Option<String>,
    /// Ticket 264 (A13): this page already asked for the camera or microphone once.
    prompted: bool,
    /// Ticket 328 part 2: the owner took over this tab (1-based) and the agent has not heard yet; its next answer says so.
    moved: Option<usize>,
    /// Ticket 553: how many takeovers `owner_on` has seen; a snapshot ends the note only if none came while it ran.
    takeovers: u64,
    /// Ticket 998 L9 (B8): the view label and document of the last page the agent got numbers for; a number is only
    /// ever looked up there.
    seen: Option<(String, String)>,
    /// B8: the first number not yet given to an element in this space (0: none given). Kept across Forget, so a number
    /// from before it never names a new page's element.
    next: u64,
    /// Ticket 998 L9 (idle throttle): a job of this space is running.
    busy: bool,
    /// Since when this space's parked pages have run at full speed with no job; `None`: busy, or already throttled.
    idle: Option<Instant>,
    /// The throttle thread may have hidden some of its pages since the last job: the next job wakes them first.
    asleep: bool,
    /// Ticket 997 L7: when the agent's last verb here ended (a verb refused because the owner holds the space is not one).
    acted: Option<Instant>,
}
static SPACES: Mutex<Vec<(String, Space)>> = Mutex::new(Vec::new());

fn with_space<T>(space: &str, f: impl FnOnce(&mut Space) -> T) -> T {
    let mut all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    if !all.iter().any(|(s, _)| s == space) {
        all.push((space.into(), Space::default()));
    }
    let entry = all.iter_mut().find(|(s, _)| s == space).map(|(_, v)| v);
    f(entry.expect("inserted above"))
}

/// Reads a space without adding it: the pane asks about spaces the agent may never have used.
fn peek<T>(space: &str, f: impl FnOnce(&Space) -> T) -> Option<T> {
    let all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    all.iter().find(|(s, _)| s == space).map(|(_, v)| f(v))
}

/// Ticket 328 part 2: the view label of the pane's tab `n` (1-based) in `space`. `None` and 1 are the side pane's view, as
/// before. A later tab is looked up in this space's own list only, so a number never reaches another space's tab, and
/// The owner's own spaces have no later agent tabs (`refuse_you`). An agent never calls this: its `Tab` verb has its own check.
pub(super) fn tab_of(space: &str, n: Option<u32>) -> Result<String, String> {
    let n = match n {
        None | Some(1) => return Ok(view::label(space)),
        Some(n) => n,
    };
    refuse_you(space)?;
    n.checked_sub(1)
        .and_then(|i| peek(space, |s| s.tabs.get(i as usize).cloned()).flatten())
        .ok_or_else(|| format!("No tab {n} in this browser space"))
}

/// Ticket 328 part 2: the agent's tabs as the pane's strip shows them: number, address and page title of each open tab,
/// and the agent's current one. A space with no agent tab lists none (the pane then shows its one view, as before).
pub(super) fn tabs_state(app: &AppHandle, space: &str) -> Value {
    let mut v = tabs_list(space, |l| nav_state(&app.get_webview(l)?, space).ok());
    v["agent"] = driven(space).into(); // 997 L7: the strip's badge and the space chip's blue dot
    v
}

/// Ticket 997 L7: how long after the agent's last verb its page still shows as driven (Orca's rule): the outline over the
/// page, the badge on its tab and the blue dot on the space chip, all off from then on. Nothing animates.
const DRIVEN_FOR: Duration = Duration::from_secs(20);

/// The agent is using `space`: a verb is running or ended under DRIVEN_FOR ago, and the owner does not hold the space.
fn driven(space: &str) -> bool {
    peek(space, |s| {
        s.busy || s.acted.is_some_and(|t| t.elapsed() < DRIVEN_FOR)
    })
    .unwrap_or(false)
        && !control::held(space)
}

/// 997 L7: view `label` is the one the agent drives in `space`: its current tab (tab 1 before it opened any).
fn drives(space: &str, label: &str) -> bool {
    driven(space)
        && peek(space, |s| {
            s.tabs
                .get(s.current)
                .map_or(label == view::label(space), |l| l == label)
        })
        .unwrap_or(false)
}

/// `tabs_state` with the view read given: `read(label)` is the view's `nav_state`, `None` for a view that is gone.
fn tabs_list(space: &str, read: impl Fn(&str) -> Option<Value>) -> Value {
    let (labels, current) = peek(space, |s| (s.tabs.clone(), s.current)).unwrap_or_default();
    let list: Vec<Value> = labels
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let nav = read(l)?;
            Some(json!({"tab": i + 1, "url": nav["url"], "title": nav["title"]}))
        })
        .collect();
    json!({"tabs": list, "current": current + 1})
}

/// Ticket 328 part 2: the owner acted on view `label` of `space` (a click, a key, the toolbar), so he holds the space and that tab
/// is the agent's current one from now on: after Hand back its verbs act where he left the page, and its first page-changing
/// verb is refused with the news (`moved_gate`). A label that is not one of the agent's tabs changes nothing.
pub(super) fn owner_on(space: &str, label: &str) {
    let mut all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, s)) = all.iter_mut().find(|(s, _)| s == space)
        && let Some(i) = s.tabs.iter().position(|l| l == label)
        && i != s.current
    {
        s.current = i;
        s.moved = Some(i + 1);
        s.takeovers += 1;
    }
}

/// Ticket 264: held while a space takes its profile and while a removal checks "no live spaces" and writes the list, so a
/// space cannot appear on a profile being removed. Never held across a wait on the main thread: `show` takes it there.
static PROFILES: Mutex<()> = Mutex::new(());

pub(super) fn profiles_lock() -> std::sync::MutexGuard<'static, ()> {
    PROFILES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Builds a view of `space` on its profile, fixed by the space's first view and remembered for it, so a later change of the
/// default or a restart never moves the space to other logins. `picked` is the user's picker in the window; agent paths pass
/// `None` (an agent may not pick). If the first view cannot be built, the space and its row go back as they were.
pub(super) fn with_profile<T>(
    space: &str,
    picked: Option<&str>,
    build: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    on_profile(
        space,
        picked,
        view::Profiles::read,
        |rows| {
            let patch = json!({"features": {"browser.space_profiles": rows}});
            crate::core_call(json!({"op": "quit_settings", "patch": patch}))
                .map(|_| ())
                .ok_or_else(|| "The browser profile could not be saved".to_string())
        },
        || {
            let list = crate::core_call(json!({"op": "list"}))?;
            let ids = list["sessions"].as_array()?.iter();
            Some(
                ids.filter_map(|s| Some(s["id"].as_str()?.to_string()))
                    .collect(),
            )
        },
        build,
    )
}

fn on_profile<T>(
    space: &str,
    picked: Option<&str>,
    read: impl Fn() -> Result<view::Profiles, String>,
    save: impl Fn(Value) -> Result<(), String>,
    known: impl FnOnce() -> Option<Vec<String>>,
    build: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    // `Some(row before)`: this call took the space, and owes it back if the view fails.
    let (profile, took) = {
        let _held = profiles_lock();
        match with_space(space, |s| s.profile.clone()) {
            Some(p) => (p, None),
            None => {
                let profiles = read()?;
                let before = profiles.pick_of(space).map(str::to_string);
                let profile = profiles.resolve(picked.or(before.as_deref()))?.to_string();
                if before.as_deref() != Some(profile.as_str()) {
                    save(profiles.picks_with(space, &profile, known)?)?;
                }
                with_space(space, |s| s.profile = Some(profile.clone()));
                (profile, Some(before))
            }
        }
    };
    let built = build(&profile);
    if built.is_err()
        && let Some(before) = took
    {
        let _held = profiles_lock();
        with_space(space, |s| s.profile = None);
        if before.as_deref() != Some(profile.as_str())
            && let Ok(now) = read()
        {
            let _ = save(now.picks_back(space, before.as_deref()));
        }
    }
    built
}

/// Spaces that hold `profile`, built or being built (call under `profiles_lock`).
pub(super) fn spaces_on(profile: &str) -> usize {
    let all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    all.iter()
        .filter(|(_, s)| s.profile.as_deref() == Some(profile))
        .count()
}

/// True for the first camera or microphone request of the space's page load (A13).
pub(super) fn first_prompt(space: &str) -> bool {
    with_space(space, |s| !std::mem::replace(&mut s.prompted, true))
}

pub(super) fn clear_prompt(space: &str) {
    with_space(space, |s| s.prompted = false);
}

/// Every open view on `profile`, with its space.
pub(super) fn views_on(app: &AppHandle, profile: &str) -> Vec<(String, tauri::Webview)> {
    let all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    all.iter()
        .filter(|(_, s)| s.profile.as_deref() == Some(profile))
        .flat_map(|(space, s)| {
            let tab1 = view::label(space);
            let tabs = s.tabs.iter().filter(|l| **l != tab1).cloned();
            std::iter::once(tab1.clone())
                .chain(tabs)
                .filter_map(|l| app.get_webview(&l))
                .map(|wv| (space.clone(), wv))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Tab 1 is WP1's view for the space (the one the side pane shows); tab n > 1 gets its own label.
fn tab_label(space: &str, n: usize) -> String {
    if n == 1 {
        view::label(space)
    } else {
        view::label(&format!("{space}\ntab{n}"))
    }
}

/// The 1-based number of view `label` in `space`, from the label itself (tab n's label is fixed by n, `tab_label`), so it holds
/// before `open` lists the tab too: its first page load comes before that. 1 for the pane's view and any other label.
pub(super) fn tab_index(space: &str, label: &str) -> usize {
    (2..=TABS_MAX)
        .find(|n| tab_label(space, *n) == label)
        .unwrap_or(1)
}

/// Ticket 998 L9: a parked agent page whose space has had no job for this long is hidden, so WebKit throttles it
/// (997 L4: 1 Hz timers, no animation frames; a parked page runs at full speed, an animated one at about 30% of a core).
/// An agent working on a page sends its next verb within a model turn, mostly a few seconds, so 5 s keeps its page awake
/// between verbs and lets a page it left cost at most 5 s of full speed; a job on a throttled page pays `wake` first.
const IDLE_AFTER: Duration = Duration::from_secs(5);
/// How long a woken page may take to say it is visible again before the job runs anyway.
const WAKE_MAX: Duration = Duration::from_secs(1);
/// Wakes the throttle thread when a space goes idle (`rest`); it waits on SPACES.
static IDLE: Condvar = Condvar::new();

/// A job ended or the pane parked a page: the space's parked pages are throttled IDLE_AFTER later unless a job comes
/// first. During a job this waits for its end.
pub(super) fn rest(space: &str) {
    with_space(space, |s| {
        if !s.busy {
            s.idle = Some(Instant::now());
        }
    });
    IDLE.notify_one();
}

/// A job starts in `space`: none of its pages is throttled from here on, and a throttled one is shown again (and waited
/// for, up to WAKE_MAX, until the page itself says it is visible), so the job and its settle run at full speed.
fn wake(app: &AppHandle, space: &str) {
    let start = Instant::now();
    let asleep = with_space(space, |s| {
        (s.busy, s.idle) = (true, None);
        std::mem::take(&mut s.asleep)
    });
    if !asleep {
        return;
    }
    for n in 1..=TABS_MAX {
        let Some(wv) = app.get_webview(&tab_label(space, n)) else {
            continue;
        };
        let (tx, rx) = mpsc::channel();
        let asked = wv.with_webview(move |pv| {
            let _ = tx.send(unsafe { mac::wake(pv.inner().cast()) });
        });
        // 998 L10 round 3: the wake's waits are the job's time too (B3), so they stop where the job's clock ends.
        if asked.is_err() || !rx.recv_timeout(POLL_WAIT.min(left())).unwrap_or(false) {
            continue;
        }
        while start.elapsed() < WAKE_MAX
            && !left().is_zero()
            && !run_js(
                &wv,
                None,
                SCRIPT,
                json!({"op": "info"}).to_string(),
                POLL_WAIT,
            )
            .is_ok_and(|v| v["shown"] == true)
        {
            thread::sleep(POLL);
        }
    }
    hop(|h| h.wake += start.elapsed());
}

/// The throttle thread: hides the parked pages of each space that has been idle for IDLE_AFTER. A job that starts in
/// between wins: the hide is checked again on the main thread, after `wake` marked the space busy.
fn throttle(app: AppHandle) {
    let mut all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let now = Instant::now();
        let (due, next) = due(&mut all, now);
        if due.is_empty() {
            all = match next {
                Some(at) => {
                    IDLE.wait_timeout(all, at - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => IDLE.wait(all).unwrap_or_else(|e| e.into_inner()),
            };
            continue;
        }
        drop(all);
        for space in due {
            for n in 1..=TABS_MAX {
                let Some(wv) = app.get_webview(&tab_label(&space, n)) else {
                    continue;
                };
                let id = space.clone();
                let _ = wv.with_webview(move |pv| {
                    // Still unused: no job started, and none started and ended, since this space was found idle.
                    if peek(&id, |s| !s.busy && s.idle.is_none()).unwrap_or(false) {
                        unsafe { mac::rest(pv.inner().cast()) }
                    }
                });
            }
        }
        all = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    }
}

/// The spaces idle for IDLE_AFTER at `now` (marked throttled: `asleep`, no longer `idle`), and when the next one will be.
fn due(all: &mut [(String, Space)], now: Instant) -> (Vec<String>, Option<Instant>) {
    let (mut due, mut next) = (Vec::new(), None::<Instant>);
    for (space, s) in all.iter_mut() {
        let Some(at) = s.idle.filter(|_| !s.busy).map(|t| t + IDLE_AFTER) else {
            continue;
        };
        if at <= now {
            (s.idle, s.asleep) = (None, true);
            due.push(space.clone());
        } else {
            next = Some(next.map_or(at, |n| n.min(at)));
        }
    }
    (due, next)
}

/// Starts the poll thread and the throttle thread. They live as long as the app; a core that is down is retried every 2 s.
pub fn start(app: AppHandle) {
    let idle = app.clone();
    thread::spawn(move || throttle(idle));
    thread::spawn(move || {
        // Ticket 998 L10 (B9): one worker per space. The poll thread only hands each job over, so it polls again at once.
        let run = {
            let app = app.clone();
            move |job: Value| {
                let (id, result) = answer(&app, &job);
                if let Some(id) = id {
                    core(json!({"op": "browser_done", "id": id, "result": result}));
                }
            }
        };
        loop {
            let reply = core(json!({"op": "browser_next"}));
            let mut list = WORKERS.lock().unwrap_or_else(|e| e.into_inner());
            prune(&mut list, Instant::now());
            let Some(mut reply) = reply else {
                drop(list);
                thread::sleep(Duration::from_secs(2));
                continue;
            };
            let job = reply["Ok"]["job"].take();
            if job.is_null() {
                drop(list);
                if reply.get("Ok").is_none() {
                    thread::sleep(Duration::from_secs(2));
                }
                continue;
            }
            let space = job["space"].as_str().unwrap_or_default().to_string();
            if let Err(job) = hand(&mut list, &space, job, Instant::now(), &run) {
                drop(list);
                if let Some(id) = job["id"].as_u64() {
                    core(json!({"op": "browser_done", "id": id, "result": {"Err": WORKERS_BUSY}}));
                }
            }
        }
    });
}

/// Forget: the space's worker goes now unless it still has a job (then WORKER_IDLE retires it).
pub(super) fn retire(space: &str) {
    let mut list = WORKERS.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|(s, w)| s != space || !w.idle());
}

/// One job frame to its answer. An id comes back whenever the frame has one, so the waiting verb is answered even when
/// the rest of the frame is refused.
fn answer(app: &AppHandle, frame: &Value) -> (Option<u64>, Result<Value, String>) {
    let picked = control::now_micros();
    hop(|h| *h = Hops::default());
    // The clock starts when the agent sent the verb: a wait behind the space's last job and a wake count too.
    let age = Duration::from_micros(picked.saturating_sub(frame["queued"].as_u64().unwrap_or(0)));
    UNTIL.set(Some(Instant::now() + ANSWER_BY.saturating_sub(age)));
    let id = frame["id"].as_u64();
    let result = serde_json::from_value::<Job>(frame.clone())
        .map_err(|e| format!("The app refused this browser request: {e}"))
        .and_then(|job| {
            let turn = control::Turn {
                space: job.space,
                queued: job.queued,
            };
            if refuse_you(&turn.space).is_err() {
                return handle(app, &turn, job.verb);
            }
            if left() < START_MIN {
                return Err(OUT_OF_TIME.into());
            }
            wake(app, &turn.space);
            let r = in_time(|| handle(app, &turn, job.verb));
            let acted = !matches!(&r, Err(e) if e.starts_with("USER_IN_CONTROL"));
            with_space(&turn.space, |s| {
                s.busy = false;
                if acted {
                    s.acted = Some(Instant::now());
                }
            });
            rest(&turn.space);
            r
        });
    UNTIL.set(None);
    let mut result = result.and_then(fit);
    let rec = hops();
    if let (Ok(Value::Object(o)), Ok(h)) = (&mut result, rec.lock()) {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        o.insert("hops".into(), json!({"queued": frame["queued"], "picked": picked, "answered": control::now_micros(),
            "main_ms": ms(h.main), "call_ms": ms(h.call), "calls": h.calls, "settle_ms": ms(h.settle),
            "wake_ms": ms(h.wake)}));
    }
    (id, result)
}

/// Ticket 998 L5 (B3, B4): an answer over ANSWER_MAX loses rows from the middle (the first 80% and the last 20% stay,
/// and `cut` counts them), then text, then outline lines. An action that still does not fit keeps
/// its done line, so only a reading verb, which changed nothing, can still be refused.
fn fit(mut v: Value) -> Result<Value, String> {
    while v.to_string().len() > ANSWER_MAX {
        if let Some(rows) = v
            .get_mut("rows")
            .and_then(Value::as_array_mut)
            .filter(|r| r.len() > 10)
        {
            let (_, n) = middle(rows);
            v["cut"] = json!(v["cut"].as_u64().unwrap_or(0) + n as u64);
        } else if let Some(text) = v["text"].as_str().filter(|t| t.len() > 1000) {
            let half: String = text.chars().take(text.chars().count() / 2).collect();
            v["text"] = half.into();
        } else if let Some(tree) = v["tree"].as_str().filter(|t| t.lines().count() > 10) {
            let mut lines: Vec<String> = tree.lines().map(String::from).collect();
            let (at, n) = middle(&mut lines);
            lines.insert(at, format!("- … {n} lines cut"));
            v["tree"] = lines.join("\n").into();
        } else if v["done"].is_string() {
            // Round 2 (security MUST): the done line itself is capped, so this answer always fits and arrives (at
            // most 6 bytes per character once escaped).
            let mut done: String = s(&v["done"]).chars().take(DONE_MAX).collect();
            if done.len() < s(&v["done"]).len() {
                done.push('…');
            }
            return Ok(
                json!({"done": format!("{done}; snapshot, page title and address omitted: over the answer budget"),
                "title": "", "url": "", "tab": v["tab"], "tabs": v["tabs"]}),
            );
        } else {
            return Err("The page answer is too large; try without --full".into());
        }
    }
    Ok(v)
}

/// Keeps half of `v`, its first 80% and last 20%; returns where the cut is and how many items went.
fn middle<T>(v: &mut Vec<T>) -> (usize, usize) {
    let keep = v.len() / 2;
    let (head, n) = ((keep * 4).div_ceil(5), v.len() - keep);
    v.drain(head..head + n);
    (head, n)
}

/// The owner socket, as `core_reply` in main.rs but with a read timeout past the core's poll wait.
fn core(request: Value) -> Option<Value> {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };
    let home = crate::home().ok()?;
    let token = std::fs::read_to_string(home.join("core.token")).ok()?;
    let mut stream = UnixStream::connect(home.join("core.sock")).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok()?;
    let line = json!({"token": token.trim(), "request": request}).to_string() + "\n";
    stream.write_all(line.as_bytes()).ok()?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).ok()?;
    serde_json::from_str(&reply).ok()
}

/// Ticket 255 (needs 198, widget-check G04): the page an address opens. `user` is the space the owner types in (`None`: an
/// agent's verb). The owner's empty address opens his home page in his own "you" space only; an agent always names its page,
/// so the home page (perhaps a logged-in page) never loads for an agent, and an agent's text is never a search.
pub(super) fn start_page(
    typed: &str,
    user: Option<&str>,
    prefs: &view::Prefs,
) -> Result<tauri::Url, String> {
    match (user, typed.trim().is_empty(), &prefs.home) {
        (Some(YOU), true, Some(home)) => view::normalize(home.as_str()), // checked again: the guards may have changed
        (Some(_), _, _) => view::normalize_search(typed, prefs.engine),
        (None, _, _) => view::normalize(typed),
    }
}

/// A3: no job runs in the owner's own store, whatever the frame says.
fn refuse_you(space: &str) -> Result<(), String> {
    // Ticket 328: the owner's later tabs (`you:<id>`, mod.rs `rules_of`) are his store too.
    if space == YOU || space.is_empty() || space.starts_with("you:") {
        return Err("browser verbs never run in the owner's own browser".into());
    }
    Ok(())
}

fn handle(app: &AppHandle, turn: &control::Turn, verb: Verb) -> Result<Value, String> {
    let space = turn.space.as_str();
    refuse_you(space)?;
    // WP3: while the owner has the browser every verb is refused, and one sent before his Hand back is dropped, never replayed.
    control::gate(turn)?;
    moved_gate(space, &verb)?;
    match verb {
        Verb::Open { url } => open(app, turn, &url),
        Verb::Goto { url } => {
            let Ok(wv) = current(app, space) else {
                return open(app, turn, &url);
            };
            let before = key(&wv, false);
            let late = unknown(go(&wv, turn, view::normalize(&url)?))?;
            let failed = settle(&wv, before, true);
            done(
                turn,
                &wv,
                loaded("went to the page".into(), late.or(failed)),
            )
        }
        Verb::Snapshot { tree, full } => {
            // Before `current` picks the tab: a takeover in between then costs one more refusal, never a stale click.
            let before = with_space(space, |s| s.takeovers);
            let wv = current(app, space)?;
            let op = if tree { "tree" } else { "snapshot" };
            let next = with_space(space, |s| s.next);
            let mut r = js(&wv, json!({"op": op, "full": full, "next": next}))?;
            snapshot_seen(space, before);
            place(space, wv.label(), &mut r);
            Ok(r)
        }
        Verb::Click { index } => {
            let wv = current(app, space)?;
            let p = point(space, &wv, index)?;
            if !p.3
                && let Some(handed) = sign_in(app, &wv, space, Some(index), false)?
            {
                return Ok(handed);
            }
            let before = key(&wv, true);
            let late = unknown(native(&wv, Some(turn), move |n| n.click(p.0, p.1)))?;
            let failed = settle(&wv, before, false);
            done(
                turn,
                &wv,
                loaded(format!("clicked [{index}] {}", p.2), late.or(failed)),
            )
        }
        Verb::Fill { index, text } => {
            let wv = current(app, space)?;
            let p = point(space, &wv, index)?;
            if !p.3 {
                return Err(format!("[{index}] {} is not a text field", p.2));
            }
            // Round 4: the text goes to whatever has the keyboard focus, and WebKit may handle the click after the text when a
            // field already has it (the owner's, after Hand back). So the named field takes the focus first, under the B8
            // guard (live, listed, this page), and nothing is typed unless it holds it.
            let f = on_ref(space, &wv, Some(turn), json!({"op": "focus", "i": index}))?;
            if f["focused"] != true {
                return Err(format!(
                    "focus_refused: [{index}] {} would not take the keyboard focus; nothing was typed",
                    p.2
                ));
            }
            let typed = text.clone();
            let late = unknown(native(&wv, Some(turn), move |n| {
                n.click(p.0, p.1);
                n.select_all();
                n.insert(&typed);
            }))?;
            // B3: the text went in, so what the field shows now is a note on the done line, never an error.
            let check = match late {
                Some(note) => note,
                None => match on_ref(space, &wv, None, json!({"op": "value", "i": index})) {
                    Ok(got) if got["value"].as_str() == Some(text.as_str()) => String::new(),
                    Ok(_) => ", but the field reads otherwise now (the page may have changed or cut the text)".into(),
                    Err(e) if is_refusal(&e) => ", but the field is no longer on the page".into(),
                    Err(_) => "; outcome unknown: the field did not answer".into(),
                },
            };
            done(turn, &wv, format!("filled [{index}] {}{check}", p.2))
        }
        Verb::Select { index, option } => {
            let wv = current(app, space)?;
            let r = on_ref(
                space,
                &wv,
                Some(turn),
                json!({"op": "select", "i": index, "option": option}),
            );
            let what = match r {
                Err(e) if is_late(&e) => format!("select in [{index}]{UNKNOWN}"),
                r => {
                    let r = r?;
                    format!(
                        "selected {} in [{index}] {}",
                        s(&r["value"]),
                        s(&r["label"])
                    )
                }
            };
            done(turn, &wv, what)
        }
        Verb::Press { key: name } => {
            let wv = current(app, space)?;
            let k =
                keys::of(&name).ok_or_else(|| format!("Unknown key {name}: {}", keys::NAMES))?;
            if matches!(k.0, "\r" | " ")
                && let Some(handed) = sign_in(app, &wv, space, None, k.0 == " ")?
            {
                return Ok(handed);
            }
            let before = key(&wv, true);
            let late = unknown(native(&wv, Some(turn), move |n| n.key(k)))?;
            let failed = settle(&wv, before, false);
            done(
                turn,
                &wv,
                loaded(format!("pressed {name}"), late.or(failed)),
            )
        }
        Verb::Scroll { down } => {
            let wv = current(app, space)?;
            let late = unknown(js_in(
                &wv,
                Some(turn),
                json!({"op": "scroll", "down": down}),
            ))?;
            done(
                turn,
                &wv,
                loaded(
                    format!("scrolled {}", if down { "down" } else { "up" }),
                    late,
                ),
            )
        }
        Verb::Tabs {} => {
            let (labels, cur) = with_space(space, |s| (s.tabs.clone(), s.current));
            let list: Vec<Value> = labels
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    let info = app.get_webview(l).and_then(|wv| js(&wv, json!({"op": "info"})).ok());
                    json!({"tab": i + 1, "current": i == cur,
                        "title": info.as_ref().map(|v| v["title"].clone()), "url": info.map(|v| v["url"].clone())})
                })
                .collect();
            Ok(json!({"list": list}))
        }
        Verb::Tab { tab } => {
            let n = with_space(space, |s| s.tabs.len());
            if tab == 0 || tab as usize > n {
                return Err(format!("No tab {tab}: this space has {n}"));
            }
            with_space(space, |s| (s.current, s.moved) = (tab as usize - 1, None));
            let wv = current(app, space)?;
            done(turn, &wv, format!("switched to tab {tab}"))
        }
        Verb::Handoff { reason } => {
            give_to_owner(app, space, reason.clone());
            #[cfg(debug_assertions)]
            if let Some(secret) = std::env::var("NUNCHIRO_BROWSER_TEST_OWNER")
                .ok()
                .filter(|s| !s.is_empty())
            {
                let r = test_owner(app, space, &secret);
                control::hand_back(app, space);
                return r.map(|()| json!({"done": format!("the owner finished: {reason}")}));
            }
            Ok(json!({"done": format!("the owner has the browser for: {reason}")}))
        }
    }
}

/// The owner has the browser until pressing Hand back; the chip shows the reason. The `handoff` verb, a sign-in and a site's
/// permission prompt all come through here (ticket 264, A3).
pub(super) fn give_to_owner(app: &AppHandle, space: &str, reason: String) {
    let _ = app.emit("browser-handoff", json!({"space": space, "reason": reason}));
    control::take(app, space, Some(reason));
}

const SIGN_IN: &str = "this page asks for a password";

/// Ticket 264 (A3): a courtesy, not the boundary (password fields are never listed, and no verb types outside a listed text
/// field). A click on a form's submit control, Enter in that form, or Space on a focused submit control, while its visible
/// password is still empty, would send a sign-in: the space goes to the owner instead of the action running. Reading the page,
/// filling the user name, Remember me and Forgot password stay the agent's. `button`: only a focused submit control counts.
fn sign_in(
    app: &AppHandle,
    wv: &tauri::Webview,
    space: &str,
    index: Option<u32>,
    button: bool,
) -> Result<Option<Value>, String> {
    let request = json!({"op": "signin", "i": index, "button": button});
    let asked = match index {
        Some(_) => on_ref(space, wv, None, request)?,
        None => js(wv, request)?,
    }["signin"]
        == true;
    Ok(asked.then(|| {
        give_to_owner(app, space, SIGN_IN.into());
        json!({"done": format!("the owner has the browser for: {SIGN_IN}")})
    }))
}

/// Debug builds only, for `tests/scenario/browser_tasks.py`: plays the owner at a login handoff (types the password the test
/// gives into the page's password field through the same native input, then Enter). Release builds have no such path.
#[cfg(debug_assertions)]
fn test_owner(app: &AppHandle, space: &str, secret: &str) -> Result<(), String> {
    let wv = current(app, space)?;
    let p = js(&wv, json!({"op": "password"}))?;
    let (x, y) = (
        p["x"].as_f64().ok_or("no password field")?,
        p["y"].as_f64().unwrap_or(0.0),
    );
    let before = key(&wv, false);
    let secret = secret.to_string();
    native(&wv, None, move |n| {
        n.click(x, y);
        n.insert(&secret);
        n.key(keys::of("Enter").expect("listed"));
    })?;
    settle(&wv, before, true);
    Ok(())
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// Ticket 998 L9 (B8): the answer's tab is view `label`, the one that was read. A page answer with numbers (`doc`) makes
/// that view and document the place later numbers must come from, and its `next` moves the space's counter on; the
/// snapshot in an action's answer counts too, but never ends a takeover note (`moved`).
fn place(space: &str, label: &str, r: &mut Value) {
    let (doc, next) = match r.as_object_mut() {
        Some(o) => (o.remove("doc"), o.remove("next")),
        None => (None, None),
    };
    let (tab, n) = with_space(space, |s| {
        if let Some(Value::String(doc)) = doc {
            s.seen = Some((label.into(), doc));
        }
        s.next = s.next.max(next.and_then(|n| n.as_u64()).unwrap_or(0));
        let tab = s.tabs.iter().position(|l| l == label).unwrap_or(s.current);
        (tab, s.tabs.len())
    });
    r["tab"] = json!(tab + 1);
    r["tabs"] = json!(n);
}

/// The document the agent's numbers for view `label` belong to; `None` when its last page was another view's or none.
fn seen_doc(space: &str, label: &str) -> Option<String> {
    with_space(space, |s| s.seen.clone())
        .filter(|(l, _)| l == label)
        .map(|(_, doc)| doc)
}

/// Ticket 998 L9 (B8): `request` on element `i` of the page the agent last got. The page checks, in the same call, that
/// the number is from this document and still names a listed, shown element; only a reason code comes back. A number
/// from another tab or page (`page_moved`) or whose element is gone (`ref_stale`) is refused and nothing runs.
fn on_ref(
    space: &str,
    wv: &tauri::Webview,
    turn: Option<&control::Turn>,
    mut request: Value,
) -> Result<Value, String> {
    let r = match seen_doc(space, wv.label()) {
        Some(doc) => {
            request["doc"] = doc.into();
            js_in(wv, turn, request.clone())?
        }
        None => json!({"refused": "page_moved"}),
    };
    match r["refused"].as_str() {
        None => Ok(r),
        Some(code) => Err(refusal(code, &request["i"])),
    }
}

/// The error text of a B8 refusal: the code first, so the agent can match it.
fn refusal(code: &str, i: &Value) -> String {
    match code {
        "ref_stale" => format!(
            "ref_stale: [{i}] is no longer on the page; nothing was done. Use a number from the last page printed"
        ),
        _ => format!(
            "page_moved: [{i}] is from another tab or an earlier page; nothing was done. Run snapshot for this page's numbers"
        ),
    }
}

fn is_refusal(e: &str) -> bool {
    e.starts_with("ref_stale:") || e.starts_with("page_moved:")
}

/// Ticket 998 L8 (B7): an action's answer is its done line plus the page after it, as `snapshot` reads it (`fit` keeps
/// it under the budget). A page that does not answer costs the snapshot, never the done line (B3). L9 round 2
/// (security MUST): the read goes through `control::gate` with the action's turn, in the same main-thread turn as the
/// call, so a page the owner took over during the action never reaches the agent; the done line still says what ran.
fn done(turn: &control::Turn, wv: &tauri::Webview, what: String) -> Result<Value, String> {
    finish(turn, wv.label(), what, |t, request| {
        run_js(wv, t, SCRIPT, request, SNAPSHOT_WAIT)
    })
}

/// `done` with the page read given: `read(turn, request)` refuses with `control::REFUSED` when `control::gate(turn)`
/// does, as `run_js` does.
fn finish(
    turn: &control::Turn,
    label: &str,
    what: String,
    read: impl FnOnce(Option<&control::Turn>, String) -> Result<Value, String>,
) -> Result<Value, String> {
    let space = turn.space.as_str();
    let next = with_space(space, |s| s.next);
    let request = json!({"op": "snapshot", "next": next}).to_string();
    let blank = || json!({"title": "", "url": ""});
    let (mut r, what) = match read(Some(turn), request) {
        Ok(page) => (page, what),
        Err(e) if e == control::REFUSED => (
            blank(),
            what + "; the page is not shown: the owner took over this browser",
        ),
        Err(_) => (
            blank(),
            what + "; snapshot omitted: the page did not answer",
        ),
    };
    r["done"] = with_popup_note(space, what).into();
    place(space, label, &mut r);
    Ok(r)
}

/// The space's current tab. A space with no tab adopts the side pane's view for the session when the owner opened one.
fn current(app: &AppHandle, space: &str) -> Result<tauri::Webview, String> {
    let label = with_space(space, |s| {
        if s.tabs.is_empty() && app.get_webview(&tab_label(space, 1)).is_some() {
            s.tabs.push(tab_label(space, 1));
        }
        s.tabs.get(s.current).cloned()
    });
    label
        .and_then(|l| app.get_webview(&l))
        .ok_or_else(|| "No tab is open: start with `nunchiro browser open <url>`".into())
}

/// Security review r1 MUST 1: the owner took over another tab, so the agent's page numbers may belong to the old one. Its first
/// verb that changes a page is refused before anything runs, once, and names the tab; reading verbs pass, and a snapshot
/// (fresh numbers of that tab) or its own `tab` verb ends it. `open` makes a new tab and clears it (`add_tab`).
fn moved_gate(space: &str, verb: &Verb) -> Result<(), String> {
    let changes = matches!(
        verb,
        Verb::Goto { .. }
            | Verb::Click { .. }
            | Verb::Fill { .. }
            | Verb::Select { .. }
            | Verb::Press { .. }
            | Verb::Scroll { .. }
    );
    match with_space(space, |s| changes.then(|| s.moved.take()).flatten()) {
        Some(n) => Err(format!(
            "Nothing was done: the owner took over tab {n}, so your verbs act on tab {n} now. Run snapshot first, or tab N to go back"
        )),
        None => Ok(()),
    }
}

/// Ticket 553: only a snapshot that returned gives the agent tab n's numbers, so only then does the takeover note end;
/// a failed one (page loading, script timeout) keeps the refusal for the next verb. `before`: the takeover count when the
/// script started; a takeover while it ran (up to 5 s) is news about another tab, so its note stays. A count, not the tab
/// number: the owner may leave tab n and come back to it while the script runs.
fn snapshot_seen(space: &str, before: u64) {
    with_space(space, |s| {
        if s.takeovers == before {
            s.moved = None;
        }
    });
}

/// A page-chosen address is data in the agent's answer: capped when stored, quoted here, and never advice on what to do with it.
fn with_popup_note(space: &str, what: String) -> String {
    match with_space(space, |s| s.popup.take()) {
        Some(url) => format!("{what}; refused a new-window request from the page for: {url:?}"),
        None => what,
    }
}

/// Characters of a page's address an agent's answer may carry.
const POPUP_NOTE_MAX: usize = 512;

/// Ticket 307: tells the agent about a refused new window, in the answer of its next verb.
pub(super) fn note_popup(space: &str, url: &str) {
    with_space(space, |s| {
        s.popup = Some(url.chars().take(POPUP_NOTE_MAX).collect())
    });
}

/// The owner acted: whatever the agent had not heard yet is no longer news for it.
pub(super) fn clear_popup_note(space: &str) {
    with_space(space, |s| s.popup = None);
}

/// Stores what the pane's view asked for; true when that differs from what is stored, the only time the window hears of it
/// (a `window.open` loop must not reach the main window per call).
pub(super) fn offer_popup(space: &str, target: Option<String>) -> bool {
    with_space(space, |s| {
        let changed = s.asked.as_ref() != Some(&target);
        s.asked = Some(target);
        changed
    })
}

/// A new page, or the owner dismissed the offer: the next request counts as new, even for the same address.
pub(super) fn clear_offer(space: &str) {
    with_space(space, |s| s.asked = None);
}

/// Forget closed the views: the space starts over, so the agent's next `open` is tab 1 again, the view the pane shows.
fn take_tabs(space: &str) -> Vec<String> {
    with_space(space, |s| {
        s.current = 0;
        s.popup = None;
        s.asked = None;
        s.profile = None;
        s.prompted = false;
        s.moved = None;
        s.seen = None;
        std::mem::take(&mut s.tabs)
    })
}

/// Closes the space's later tabs (tab 1 is `forget`'s own).
pub(super) fn close_tabs(app: &AppHandle, space: &str) {
    for label in take_tabs(space) {
        if label != view::label(space)
            && let Some(wv) = app.get_webview(&label)
        {
            let _ = close_view(&wv);
        }
    }
}

/// Tickets 288, 309: what the side pane's toolbar shows, read from the view itself (so it also holds for a page the
/// agent opened, and for history a page changed by script).
/// Ticket 997 L7: the same poll keeps an agent page's outline in step with `drives` (the pane polls the page it shows
/// every 500 ms and the strip every tab each second), so it goes off by itself DRIVEN_FOR after the agent's last verb.
pub(super) fn nav_state(wv: &tauri::Webview, space: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let outline = super::scaled(space) && drives(space, wv.label());
    wv.with_webview(move |pv| {
        unsafe { control::outline(pv.inner().cast(), outline) };
        let _ = tx.send(unsafe { mac::nav(pv.inner().cast()) });
    })
    .map_err(|e| e.to_string())?;
    let (back, forward, loading, progress, url, title) = rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "The window did not answer".to_string())?;
    let popup = with_space(space, |s| s.asked.clone()).map(|url| json!({"url": url})); // a pane opened later still shows it
    Ok(
        json!({"url": url, "title": cap_title(title), "back": back, "forward": forward, "loading": loading, "progress": progress, "popup": popup}),
    )
}

/// Ticket 309: the toolbar's Stop.
pub(super) fn stop(wv: &tauri::Webview) -> Result<(), String> {
    wv.with_webview(|pv| unsafe { mac::stop(pv.inner().cast()) })
        .map_err(|e| e.to_string())
}

fn open(app: &AppHandle, turn: &control::Turn, url: &str) -> Result<Value, String> {
    let space = turn.space.as_str();
    let start = start_page(url, None, &view::Prefs::default())?; // an agent's page, never the home page
    view::store_supported()?;
    let n = with_space(space, |s| s.tabs.len()) + 1;
    if n > TABS_MAX {
        return Err(format!("A space holds at most {TABS_MAX} tabs"));
    }
    let label = tab_label(space, n);
    // Q9 fr-J12-1: a view the owner opened first already shows a complete page; settle waits for the next one.
    let (wv, before, late) = match app.get_webview(&label) {
        Some(wv) => {
            let before = key(&wv, false);
            let late = unknown(go(&wv, turn, start))?;
            (wv, before, late)
        }
        None => (
            create(app, space, &label, start, None)?,
            Before(None, Instant::now()),
            None,
        ),
    };
    add_tab(space, label);
    let failed = settle(&wv, before, true);
    done(
        turn,
        &wv,
        loaded(format!("opened tab {n}"), late.or(failed)),
    )
}

/// The agent's new tab is its current one; a takeover note about an older tab is over (security review r1 SHOULD 2).
fn add_tab(space: &str, label: String) {
    with_space(space, |s| {
        s.tabs.push(label);
        s.current = s.tabs.len() - 1;
        s.moved = None;
    });
}

/// Characters of a page title the pane gets: a page picks its title, and the strip polls it every second.
const TITLE_MAX: usize = 200;

fn cap_title(title: String) -> String {
    title.chars().take(TITLE_MAX).collect()
}

/// A new view with WP1's guards: its profile's data store, no inspector, every navigation through `view::allowed`.
/// Ticket 997 L6 (A5): the one maker of an agent space's views, for the agent's `open` and for the side pane's first show
/// (`picked`: the pane's profile picker). The page size is the setting's now and stays the view's for its life.
pub(super) fn create(
    app: &AppHandle,
    space: &str,
    label: &str,
    url: tauri::Url,
    picked: Option<&str>,
) -> Result<tauri::Webview, String> {
    let window = app
        .get_window("main")
        .ok_or("Open the Nunchiro window first")?;
    // Ticket 255: user agent and viewport of the settings apply to the new page; site permissions are denied (A13).
    // No page zoom: `mac::Input::at` posts at CSS px, page zoom 1.
    let prefs = view::Prefs::read();
    let wv = with_profile(space, picked, |profile| {
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .data_store_identifier(view::store_id(profile))
            .devtools(view::inspectable())
            .on_navigation(|u| view::allowed(u).is_ok())
            .on_new_window(super::popup(app, space, label == view::label(space)))
            .on_permission_request(super::permit(app, space));
        if let Some(ua) = prefs.user_agent {
            builder = builder.user_agent(ua);
        }
        // The side pane's URL bar follows tab 1, as for a view the owner opened; every tab's new page may ask again (A13).
        let (handle, id, pane) = (app.clone(), space.to_string(), label == view::label(space));
        builder = builder.on_page_load(move |wv, p| {
            if pane {
                super::moved(&handle, &id, &p);
            } else {
                if p.event() == tauri::webview::PageLoadEvent::Started {
                    clear_prompt(&id);
                }
                // Ticket 328 part 2: the pane may show this tab; its address bar follows it as tab 1's does.
                let _ = handle.emit_to(
                    "main",
                    "browser-moved",
                    json!({"space": id, "tab": tab_index(&id, wv.label()), "url": p.url().as_str(),
                        "finished": p.event() == tauri::webview::PageLoadEvent::Finished}),
                );
            }
        });
        let ((x, y), (w, h)) = (PARKED, prefs.viewport);
        window
            .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
            .map_err(|e| e.to_string())
    })?;
    // A1: in its frame before anything places it, so the page never lays out at a slot's size.
    if super::scaled(space) {
        let _ = wv.with_webview(|pv| unsafe { mac::frame_in(pv.inner().cast()) });
    }
    look(&wv, prefs.appearance);
    control::watch(&wv, space);
    Ok(wv)
}

/// Ticket 997 L6 (A1): draws an agent space's view in the slot (window logical px), scaled from its page size.
pub(super) fn show_scaled(wv: &tauri::Webview, slot: (f64, f64, f64, f64)) -> Result<(), String> {
    wv.with_webview(move |pv| unsafe { mac::place(pv.inner().cast(), slot) })
        .map_err(|e| e.to_string())
}

/// A4: an agent space's view leaves the slot by moving off-screen, at its size and scale. A hidden view would be
/// throttled (L4: 1 Hz timers, no animation frames, +75-139 ms per script call); a parked one runs at full speed.
pub(super) fn park(wv: &tauri::Webview) -> Result<(), String> {
    wv.with_webview(|pv| unsafe { mac::park(pv.inner().cast()) })
        .map_err(|e| e.to_string())
}

/// Closes a view and the frame around it: wry takes only the view out of the window, and an empty frame left at the slot
/// would take the clicks meant for the app under it.
pub(super) fn close_view(wv: &tauri::Webview) -> Result<(), String> {
    let _ = wv.with_webview(|pv| unsafe { mac::unframe(pv.inner().cast()) });
    wv.close().map_err(|e| e.to_string())
}

/// Ticket 255 (T-105): "light" or "dark" forces the new view's appearance; "app" leaves it following the window.
pub(super) fn look(wv: &tauri::Webview, appearance: &str) {
    let dark = match appearance {
        "light" => false,
        "dark" => true,
        _ => return,
    };
    let _ = wv.with_webview(move |pv| unsafe { mac::appearance(pv.inner().cast(), Some(dark)) });
}

/// `point` op: the element's centre after bringing it into view, its description, and whether it takes text.
fn point(space: &str, wv: &tauri::Webview, index: u32) -> Result<(f64, f64, String, bool), String> {
    let p = on_ref(space, wv, None, json!({"op": "point", "i": index}))?;
    let what = format!("{} {}", s(&p["role"]), s(&p["label"]));
    if let Some(cover) = p["covered"].as_str() {
        return Err(format!("[{index}] {what} is covered by {cover}"));
    }
    Ok((
        p["x"].as_f64().unwrap_or(0.0),
        p["y"].as_f64().unwrap_or(0.0),
        what,
        p["editable"].as_bool().unwrap_or(false),
    ))
}

/// Runs one `snapshot.js` op in the isolated world and waits for its JSON answer.
fn js(wv: &tauri::Webview, request: Value) -> Result<Value, String> {
    js_in(wv, None, request)
}

/// `js` for an op that changes the page: refused on the main thread, in order with the owner's events, by `control::gate`.
fn js_in(
    wv: &tauri::Webview,
    turn: Option<&control::Turn>,
    request: Value,
) -> Result<Value, String> {
    run_js(
        wv,
        turn,
        SCRIPT,
        request.to_string(),
        Duration::from_secs(5),
    )
}

/// Debug test hook (`control::hook`): a fixed test script in the isolated world, with `a` as its string argument.
#[cfg(debug_assertions)]
pub(super) fn page_js(wv: &tauri::Webview, body: &'static str, arg: &str) -> Result<Value, String> {
    run_js(wv, None, body, arg.to_string(), Duration::from_secs(5))
}

/// `wait`: how long the page has to answer; past it the answer is LATE_PAGE.
fn run_js(
    wv: &tauri::Webview,
    turn: Option<&control::Turn>,
    body: &'static str,
    arg: String,
    wait: Duration,
) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let turn = turn.cloned();
    let (sent, rec) = (Instant::now(), hops());
    wv.with_webview(move |pv| {
        hop_in(&rec, |h| h.main += sent.elapsed());
        if let Some(Err(e)) = turn.as_ref().map(control::gate) {
            let _ = tx.send(Err(e));
            return;
        }
        unsafe { mac::call(pv.inner().cast(), body, &arg, tx) }
    })
    .map_err(|e| e.to_string())?;
    let text = rx.recv_timeout(wait.min(left()));
    hop(|h| (h.call, h.calls) = (h.call + sent.elapsed(), h.calls + 1));
    let text = text.map_err(|_| LATE_PAGE.to_string())??;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Loads `url` in the same main-thread turn as the `gate` check, so the agent never navigates away from a page the owner has
/// just taken (his click is either before the check, and refuses this, or after the load started).
fn go(wv: &tauri::Webview, turn: &control::Turn, url: tauri::Url) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let turn = turn.clone();
    let (sent, rec) = (Instant::now(), hops());
    wv.with_webview(move |pv| {
        hop_in(&rec, |h| h.main += sent.elapsed());
        let r = control::gate(&turn);
        if r.is_ok() {
            unsafe { mac::load(pv.inner().cast(), url.as_str()) };
        }
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    let r = rx.recv_timeout(Duration::from_secs(5).min(left()));
    hop(|h| (h.call, h.calls) = (h.call + sent.elapsed(), h.calls + 1));
    r.map_err(|_| LATE_LOAD.to_string())?
}

/// Native input on the main thread, through `mac::Input`. The whole action runs in one main-thread turn after `gate`:
/// The owner's events queue behind it and reach his own focus (restored before the turn ends), never the middle of it.
/// No `turn`: the debug stand-in for the owner, whose input is not the agent's.
fn native(
    wv: &tauri::Webview,
    turn: Option<&control::Turn>,
    f: impl FnOnce(&mac::Input) + Send + 'static,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let turn = turn.cloned();
    let (sent, rec) = (Instant::now(), hops());
    wv.with_webview(move |pv| {
        hop_in(&rec, |h| h.main += sent.elapsed());
        if let Some(Err(e)) = turn.as_ref().map(control::gate) {
            let _ = tx.send(Err(e));
            return;
        }
        let input = unsafe { mac::Input::new(pv.inner().cast()) };
        f(&input);
        input.restore();
        let _ = tx.send(Ok(()));
    })
    .map_err(|e| e.to_string())?;
    let r = rx.recv_timeout(Duration::from_secs(5).min(left()));
    hop(|h| (h.call, h.calls) = (h.call + sent.elapsed(), h.calls + 1));
    r.map_err(|_| LATE_INPUT.to_string())?
}

mod keys {
    /// (characters, key code) for the keys `press` accepts.
    pub type Key = (&'static str, u16);
    pub const NAMES: &str = "Enter, Tab, Escape, Backspace, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown, Home, End";
    pub fn of(name: &str) -> Option<Key> {
        Some(match name {
            "Enter" | "Return" => ("\r", 36),
            "Tab" => ("\t", 48),
            "Space" => (" ", 49),
            "Backspace" => ("\u{7f}", 51),
            "Escape" => ("\u{1b}", 53),
            "ArrowLeft" => ("\u{f702}", 123),
            "ArrowRight" => ("\u{f703}", 124),
            "ArrowDown" => ("\u{f701}", 125),
            "ArrowUp" => ("\u{f700}", 126),
            "PageUp" => ("\u{f72c}", 116),
            "PageDown" => ("\u{f72d}", 121),
            "Home" => ("\u{f729}", 115),
            "End" => ("\u{f72b}", 119),
            _ => return None,
        })
    }
}

/// AppKit and WebKit through the Objective-C runtime (objc2 is already in the tree through wry). Main thread only.
mod mac {
    use std::sync::mpsc::Sender;

    use objc2::{
        Encode, Encoding, class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::NSString;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        origin: Point,
        size: Point,
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[
                Point::ENCODING,
                Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    thread_local! {
        /// The world is held for the app's life: WebKit drops a named world's state (the element table) once its last
        /// WKContentWorld object is released.
        static WORLD: std::cell::OnceCell<Retained<AnyObject>> = const { std::cell::OnceCell::new() };
    }

    /// `callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:` in the "nunchiro-agent" world, with
    /// the request as the string argument `a`; the answer (or the exception text) goes to `tx`.
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn call(
        wk: *mut AnyObject,
        body: &str,
        arg: &str,
        tx: Sender<Result<String, String>>,
    ) {
        unsafe {
            let world = WORLD.with(|w| {
                &**w.get_or_init(|| msg_send![class!(WKContentWorld), worldWithName: &*NSString::from_str("nunchiro-agent")])
                    as *const AnyObject
            });
            let dict: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: &*NSString::from_str(arg), forKey: &*NSString::from_str("a")];
            let block =
                block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let _ = tx.send(if !error.is_null() {
                        Err(error_text(error))
                    } else if result.is_null()
                        || !msg_send![result, isKindOfClass: class!(NSString)]
                    {
                        Err("The page returned no text".into())
                    } else {
                        Ok((*result.cast::<NSString>()).to_string())
                    });
                });
            let _: () = msg_send![wk, callAsyncJavaScript: &*NSString::from_str(body), arguments: dict, inFrame: std::ptr::null_mut::<AnyObject>(), inContentWorld: world, completionHandler: &*block];
        }
    }

    /// Ticket 255 (T-105): the view's own NSAppearance, which its pages read as `prefers-color-scheme`; `None` keeps
    /// the window's (the app's theme).
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn appearance(wk: *mut AnyObject, dark: Option<bool>) {
        unsafe {
            let look: *mut AnyObject = match dark {
                None => std::ptr::null_mut(),
                Some(d) => {
                    let name = if d {
                        "NSAppearanceNameDarkAqua"
                    } else {
                        "NSAppearanceNameAqua"
                    };
                    msg_send![class!(NSAppearance), appearanceNamed: &*NSString::from_str(name)]
                }
            };
            let _: () = msg_send![wk, setAppearance: look];
        }
    }

    /// Ticket 309: (canGoBack, canGoForward, isLoading, estimatedProgress, URL, title; ticket 328 part 2). Ticket 349: the URL is read here because
    /// `Webview::url` panics inside wry, on the main thread, while WKWebView.URL is nil (before the first commit); nil reads as "".
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn nav(wk: *mut AnyObject) -> (bool, bool, bool, f64, String, String) {
        unsafe {
            let back: Bool = msg_send![wk, canGoBack];
            let forward: Bool = msg_send![wk, canGoForward];
            let loading: Bool = msg_send![wk, isLoading];
            let progress: f64 = msg_send![wk, estimatedProgress];
            let url: Option<Retained<AnyObject>> = msg_send![wk, URL];
            let text: Option<Retained<NSString>> = url.and_then(|u| msg_send![&*u, absoluteString]);
            let title: Option<Retained<NSString>> = msg_send![wk, title];
            (
                back.as_bool(),
                forward.as_bool(),
                loading.as_bool(),
                progress,
                text.map_or_else(String::new, |t| t.to_string()),
                title.map_or_else(String::new, |t| t.to_string()),
            )
        }
    }

    /// Ticket 997 L6 (L4 way c): the frame an agent space's view lives in. Its bounds are the page size, so the page lays
    /// out at that size wherever the frame is and however small it is drawn; Input::at and the owner's clicks convert
    /// through it. Tauri's set_bounds is never used on such a view: it would size the view, not the frame.
    const FRAME: &str = "nunchiro-agent-frame";

    /// `wk`'s frame, or null when it has none.
    unsafe fn frame_of(wk: *mut AnyObject) -> *mut AnyObject {
        unsafe {
            let c: *mut AnyObject = msg_send![wk, superview];
            if c.is_null() {
                return c;
            }
            let id: *mut NSString = msg_send![c, identifier];
            if !id.is_null() && (*id).to_string() == FRAME {
                c
            } else {
                std::ptr::null_mut()
            }
        }
    }

    /// Puts a new view, parked at its page size, into a frame at the same place and scale 1.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn frame_in(wk: *mut AnyObject) {
        unsafe {
            let parent: *mut AnyObject = msg_send![wk, superview];
            if parent.is_null() || !frame_of(wk).is_null() {
                return;
            }
            let f: Rect = msg_send![wk, frame];
            let c: Retained<AnyObject> = msg_send![class!(NSView), new];
            let _: () = msg_send![&*c, setIdentifier: &*NSString::from_str(FRAME)];
            let _: () = msg_send![&*c, setFrame: f];
            let _: () = msg_send![&*c, setWantsLayer: Bool::YES];
            let _: () = msg_send![&*c, setAutoresizesSubviews: Bool::NO];
            let _: () = msg_send![&*c, setAutoresizingMask: 8usize]; // NSViewMinYMargin: kept at the top, as wry's views
            let _: () = msg_send![parent, addSubview: &*c, positioned: 1isize, relativeTo: wk]; // NSWindowAbove
            let page = Rect {
                origin: Point { x: 0.0, y: 0.0 },
                size: f.size,
            };
            let _: () = msg_send![wk, setAutoresizingMask: 0usize];
            let _: () = msg_send![wk, setFrame: page];
            let _: () = msg_send![&*c, addSubview: wk]; // moves it out of `parent`
        }
    }

    /// Draws the page in the slot (x, y, w, h: window logical px, top-left origin): the frame gets the fitted size at the
    /// top of the slot, centred across it, and keeps the page size as its bounds. Both change in this one main-thread
    /// turn, so the page never lays out at the slot's size.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn place(wk: *mut AnyObject, (x, y, w, h): (f64, f64, f64, f64)) {
        unsafe {
            let c = frame_of(wk);
            let parent: *mut AnyObject = if c.is_null() {
                c
            } else {
                msg_send![c, superview]
            };
            if parent.is_null() {
                return; // made before 997 L6 or closing: nothing to place
            }
            let page: Rect = msg_send![wk, frame];
            let (fx, _, fw, fh, _) =
                super::super::frame_in((x, y, w, h), (page.size.x, page.size.y));
            let flipped: Bool = msg_send![parent, isFlipped];
            let pb: Rect = msg_send![parent, bounds];
            let fy = if flipped.as_bool() {
                y
            } else {
                pb.size.y - y - fh
            };
            let at = Rect {
                origin: Point { x: fx, y: fy },
                size: Point { x: fw, y: fh },
            };
            let _: () = msg_send![c, setFrame: at];
            let _: () =
                msg_send![c, setBounds: Rect { origin: Point { x: 0.0, y: 0.0 }, size: page.size }];
            let _: () = msg_send![wk, setHidden: Bool::NO];
        }
    }

    /// Moves the frame off-screen; size, scale and layout stay.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn park(wk: *mut AnyObject) {
        unsafe {
            let c = frame_of(wk);
            if !c.is_null() {
                let f: Rect = msg_send![c, frame];
                let _: () =
                    msg_send![c, setFrameOrigin: Point { x: super::PARKED.0, y: f.origin.y }];
            }
        }
    }

    /// Ticket 998 L9: hides a parked view so WebKit throttles its page (1 Hz timers, no animation frames). A view in the
    /// slot, or one without a frame (the owner's), is left alone.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn rest(wk: *mut AnyObject) {
        unsafe {
            let c = frame_of(wk);
            if c.is_null() {
                return;
            }
            let f: Rect = msg_send![c, frame];
            if f.origin.x == super::PARKED.0 {
                let _: () = msg_send![wk, setHidden: Bool::YES];
            }
        }
    }

    /// Shows a view `rest` hid; true when it was hidden.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn wake(wk: *mut AnyObject) -> bool {
        unsafe {
            if frame_of(wk).is_null() {
                return false;
            }
            let hidden: Bool = msg_send![wk, isHidden];
            if hidden.as_bool() {
                let _: () = msg_send![wk, setHidden: Bool::NO];
            }
            hidden.as_bool()
        }
    }

    /// Before the view closes: back into the window's view, off-screen, and the frame removed.
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn unframe(wk: *mut AnyObject) {
        unsafe {
            let c = frame_of(wk);
            let parent: *mut AnyObject = if c.is_null() {
                c
            } else {
                msg_send![c, superview]
            };
            if parent.is_null() {
                return;
            }
            let f: Rect = msg_send![wk, frame];
            let off = Rect {
                origin: Point {
                    x: super::PARKED.0,
                    y: 0.0,
                },
                size: f.size,
            };
            let _: () = msg_send![wk, setFrame: off];
            let _: () = msg_send![parent, addSubview: wk, positioned: 1isize, relativeTo: c];
            let _: () = msg_send![c, removeFromSuperview];
        }
    }

    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn stop(wk: *mut AnyObject) {
        let _: () = unsafe { msg_send![wk, stopLoading] };
    }

    /// `loadRequest:`; the view's navigation guard (`view::allowed`) still decides, as for every load.
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn load(wk: *mut AnyObject, url: &str) {
        unsafe {
            let u: *mut AnyObject =
                msg_send![class!(NSURL), URLWithString: &*NSString::from_str(url)];
            if u.is_null() {
                return;
            }
            let req: *mut AnyObject = msg_send![class!(NSURLRequest), requestWithURL: u];
            let _: Option<Retained<AnyObject>> = msg_send![wk, loadRequest: req];
        }
    }

    unsafe fn error_text(error: *mut AnyObject) -> String {
        unsafe {
            let info: *mut AnyObject = msg_send![error, userInfo];
            let message: *mut AnyObject = if info.is_null() {
                std::ptr::null_mut()
            } else {
                msg_send![info, objectForKey: &*NSString::from_str("WKJavaScriptExceptionMessage")]
            };
            let text: *mut AnyObject = if message.is_null() {
                msg_send![error, localizedDescription]
            } else {
                message
            };
            let text = (*text.cast::<NSString>()).to_string();
            text.trim_start_matches("Error: ").to_string()
        }
    }

    /// Native events for one web view. The previous first responder (the owner's composer, say) gets focus back afterwards.
    pub struct Input {
        wk: *mut AnyObject,
        window: *mut AnyObject,
        previous: Option<Retained<AnyObject>>,
    }

    impl Input {
        /// # Safety
        /// `wk` is a live WKWebView in a window, on the main thread.
        pub unsafe fn new(wk: *mut AnyObject) -> Self {
            unsafe {
                let window: *mut AnyObject = msg_send![wk, window];
                let previous: Option<Retained<AnyObject>> = msg_send![window, firstResponder];
                let _: Bool = msg_send![window, makeFirstResponder: wk];
                Self {
                    wk,
                    window,
                    previous,
                }
            }
        }

        pub fn restore(&self) {
            if let Some(p) = &self.previous
                && !std::ptr::eq(&**p, self.wk)
            {
                let _: Bool = unsafe { msg_send![self.window, makeFirstResponder: &**p] };
            }
        }

        fn now() -> f64 {
            unsafe {
                let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
                msg_send![info, systemUptime]
            }
        }

        fn number(&self) -> isize {
            unsafe { msg_send![self.window, windowNumber] }
        }

        /// The CSS pixel (page zoom 1) as a point in the window.
        fn at(&self, x: f64, y: f64) -> Point {
            unsafe {
                let flipped: Bool = msg_send![self.wk, isFlipped];
                let bounds: Rect = msg_send![self.wk, bounds];
                let local = Point {
                    x,
                    y: if flipped.as_bool() {
                        y
                    } else {
                        bounds.size.y - y
                    },
                };
                msg_send![self.wk, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()]
            }
        }

        pub fn click(&self, x: f64, y: f64) {
            unsafe { super::control::cursor(self.wk, x, y) };
            let at = self.at(x, y);
            for (kind, sel) in [(1usize, "down"), (2, "up")] {
                unsafe {
                    let event: *mut AnyObject = msg_send![class!(NSEvent), mouseEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: Self::now(), windowNumber: self.number(), context: std::ptr::null_mut::<AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32];
                    if sel == "down" {
                        let _: () = msg_send![self.wk, mouseDown: event];
                    } else {
                        let _: () = msg_send![self.wk, mouseUp: event];
                    }
                }
            }
        }

        pub fn key(&self, (chars, code): super::keys::Key) {
            for kind in [10usize, 11] {
                unsafe {
                    let text = NSString::from_str(chars);
                    let event: *mut AnyObject = msg_send![class!(NSEvent), keyEventWithType: kind, location: Point { x: 0.0, y: 0.0 }, modifierFlags: 0usize, timestamp: Self::now(), windowNumber: self.number(), context: std::ptr::null_mut::<AnyObject>(), characters: &*text, charactersIgnoringModifiers: &*text, isARepeat: Bool::NO, keyCode: code];
                    if kind == 10 {
                        let _: () = msg_send![self.wk, keyDown: event];
                    } else {
                        let _: () = msg_send![self.wk, keyUp: event];
                    }
                }
            }
        }

        pub fn select_all(&self) {
            let _: () = unsafe { msg_send![self.wk, selectAll: std::ptr::null_mut::<AnyObject>()] };
        }

        /// Text through the web view's text input, as an input method would deliver it (trusted `input` events).
        pub fn insert(&self, text: &str) {
            let _: () = unsafe { msg_send![self.wk, insertText: &*NSString::from_str(text)] };
        }
    }
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
