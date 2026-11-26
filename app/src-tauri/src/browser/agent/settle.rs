//! After an action: the wait for the page to settle, what the wait found, and the words for a late answer.
use super::*;

/// The page before an action: its identity (the document's name + URL, to tell whether the action navigated) and when
/// the action started (a load that fails after it ends the wait).
pub(super) struct Before(pub(super) Option<String>, pub(super) Instant);

/// `watch` (a click or a key): the page notes its changes from here on (B6).
pub(super) fn key(wv: &tauri::Webview, watch: bool) -> Before {
    let key = js(wv, json!({"op": "info", "watch": watch}))
        .ok()
        .map(|v| s(&v["key"]));
    Before(key, Instant::now())
}

/// Ticket 998 L8 (B6): `settle`'s clock. Rust owns every deadline; the page only says how long ago it last changed.
pub(super) const POLL: Duration = Duration::from_millis(20);
/// One poll's page call: a page caught on its way into the back/forward cache answers only when restored (997 L4).
pub(super) const POLL_WAIT: Duration = Duration::from_secs(1);
/// No change for this long after one: the page settled.
pub(super) const QUIET_MS: f64 = 100.0;
/// No change and no load at all: the click or key changed nothing the page shows (a request may still answer later).
pub(super) const NO_CHANGE: Duration = Duration::from_millis(200);
/// A page that keeps changing (an animation, a ticker) settles here.
pub(super) const CHANGING_MAX: Duration = Duration::from_secs(1);
/// A new page that is still loading. Ticket 998 L10 (B9): 8 s, so open's worst case (wake, a wait behind the space's
/// last job, the load, the snapshot) stays inside ANSWER_BY.
pub(super) const LOAD_MAX: Duration = Duration::from_secs(8);
/// The snapshot in an action's answer (B7).
pub(super) const SNAPSHOT_WAIT: Duration = Duration::from_secs(2);

/// Waits for the page an action may have started. A new page counts once it is past loading (up to LOAD_MAX; ticket 998
/// L3, B2); a load that failed since the action ends the wait at once. Ticket 998 L8 (B6): a click or key (`nav`
/// false) that started no load ends on the page's own changes (`verdict`). A load start is the view's
/// didStartProvisionalNavigation, never an awaited page promise (a back/forward-cached page leaves one pending).
/// Returns the done line's note: the load's error, or "outcome unknown" (L5, B3), or what the page did not do.
pub(super) fn settle(wv: &tauri::Webview, before: Before, nav: bool) -> Option<String> {
    let start = Instant::now();
    // B9: the snapshot after it keeps its SNAPSHOT_WAIT of the job's time; each poll's call is cut to what is left.
    let wait = || POLL_WAIT.min(left().saturating_sub(SNAPSHOT_WAIT));
    let note = loop {
        thread::sleep(POLL);
        if let Some(e) = control::failed_since(wv.label(), before.1) {
            break Some(format!(", but the page did not load: {e}"));
        }
        if wait().is_zero() {
            let s = start.elapsed().as_secs_f64();
            break Some(format!(
                "; outcome unknown: the command's time ran out after {s:.1} s of waiting for the page"
            ));
        }
        let info = run_js(wv, None, SCRIPT, json!({"op": "info"}).to_string(), wait()).ok();
        let changed = info
            .as_ref()
            .is_some_and(|v| Some(s(&v["key"])) != before.0 && v["url"] != "about:blank");
        // A load that started and stopped without a page (a download, a stop) is no load: its page did not change.
        // goto/open (`nav`) end on their page alone, so they skip this second main-thread call per poll.
        let going = !nav && control::started_since(wv.label(), before.1) && loading(wv, wait());
        if let Some(note) = verdict(nav, start.elapsed(), info.as_ref(), changed, going) {
            break note;
        }
    };
    hop(|h| h.settle += start.elapsed());
    note
}

/// One poll of `settle`: `Some(note)` ends the wait (`Some(None)`: settled, nothing to say). `info`: the page's `info`
/// answer (None: it did not answer); `changed`: another page or address than before the action; `loading`: a load the
/// action started is still going.
pub(super) fn verdict(
    nav: bool,
    waited: Duration,
    info: Option<&Value>,
    changed: bool,
    loading: bool,
) -> Option<Option<String>> {
    if changed && info.is_some_and(arrived) {
        return Some(None);
    }
    if let (false, false, false, Some(info)) = (nav, changed, loading, info) {
        let ms = waited.as_millis();
        match info["idle"].as_f64() {
            Some(idle) if idle >= QUIET_MS => return Some(None),
            None if waited >= NO_CHANGE => {
                return Some(Some(format!(
                    "; no page change seen in {ms} ms; requests may still be running"
                )));
            }
            _ if waited >= CHANGING_MAX => {
                return Some(Some(format!("; the page was still changing after {ms} ms")));
            }
            _ => {}
        }
    }
    (waited > LOAD_MAX).then(|| {
        Some("; outcome unknown: no page settled within 8 s (it may still be loading)".into())
    })
}

/// WKWebView.isLoading: true while the main frame loads (true when the window does not answer, so the wait goes on).
fn loading(wv: &tauri::Webview, wait: Duration) -> bool {
    let (tx, rx) = mpsc::channel();
    let asked = wv.with_webview(move |pv| {
        let _ = tx.send(unsafe { mac::nav(pv.inner().cast()) }.2);
    });
    asked.is_err() || rx.recv_timeout(wait).unwrap_or(true)
}

/// B2: a new page counts once it is past "loading" (DOMContentLoaded): the agent reads the document, not its late images.
pub(super) fn arrived(info: &Value) -> bool {
    info["ready"].as_str().is_some_and(|r| r != "loading")
}

/// The done line of an action, with the note of a late call or of `settle`.
pub(super) fn loaded(what: String, note: Option<String>) -> String {
    what + note.as_deref().unwrap_or_default()
}

/// The 5 s waits for the main thread and the page. The call may still run after one, so for an action it means
/// "outcome unknown", never "not done" (B3).
pub(super) const LATE_INPUT: &str = "The window did not take the input";
pub(super) const LATE_PAGE: &str = "The page did not answer";
pub(super) const LATE_LOAD: &str = "The window did not take the address";
pub(super) const UNKNOWN: &str =
    "; outcome unknown: the window was busy for 5 s, so the action may still run";

pub(super) fn is_late(e: &str) -> bool {
    [LATE_INPUT, LATE_PAGE, LATE_LOAD].contains(&e)
}

/// Ticket 998 L5 (B3): an action's own call. A refusal (the owner's turn, no view) is an error and nothing ran; a late
/// answer is the UNKNOWN note, so the agent does not repeat an action that may have run.
pub(super) fn unknown<T>(r: Result<T, String>) -> Result<Option<String>, String> {
    match r {
        Ok(_) => Ok(None),
        Err(e) if is_late(&e) => Ok(Some(UNKNOWN.into())),
        Err(e) => Err(e),
    }
}
