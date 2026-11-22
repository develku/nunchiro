//! V2.5-22 (WP4): the app's half of annotations. `browser_annotate {space, on}` switches the owner's element picker on or off in
//! the space's view. The picker (`picker.js`) runs in its own isolated content world (A10); a poller thread takes the pick
//! it holds and emits `browser-picked` to the main window only (A12): the browser view has no Tauri capability, so it
//! cannot listen, and the page never sees the picker's state. Nothing here sends anything to an agent: the web side puts
//! the Markdown block in the composer draft and the owner's own Enter submits it.
use std::{
    collections::HashSet,
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

const SCRIPT: &str = include_str!("picker.js");
/// A12: a pick larger than this (all fields are cut to 500 characters in the picker) is page-made noise and is dropped.
/// Q9 pop-J23-1: 500 characters of Hangul or kanji are 1500 bytes, so a real pick with nearby paragraphs passes 8 KiB.
const PICK_MAX: usize = 24 * 1024;
const TICK: Duration = Duration::from_millis(250);

/// Views whose picker is on: (space, view label). Ticket 328 part 2: any of the space's tabs, not only tab 1.
static ACTIVE: Mutex<Option<HashSet<(String, String)>>> = Mutex::new(None);
static POLLER: std::sync::Once = std::sync::Once::new();

fn active<T>(f: impl FnOnce(&mut HashSet<(String, String)>) -> T) -> T {
    f(ACTIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashSet::new))
}

/// Runs one `picker.js` op in the picker's world and waits for its JSON answer. Not on the main thread.
fn js(wv: &tauri::Webview, op: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let arg = json!({ "op": op }).to_string();
    wv.with_webview(move |pv| unsafe { mac::call(pv.inner().cast(), SCRIPT, &arg, tx) })
        .map_err(|e| e.to_string())?;
    let text = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "The page did not answer".to_string())??;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// What the picker returned, if it is a pick we pass on: an object, within the size cap.
fn pick_of(answer: &Value) -> Option<&Value> {
    let pick = answer.get("pick").filter(|p| p.is_object())?;
    (pick.to_string().len() <= PICK_MAX).then_some(pick)
}

fn poll(app: &AppHandle) {
    for (space, label) in active(|a| a.iter().cloned().collect::<Vec<_>>()) {
        let Some(wv) = app.get_webview(&label) else {
            // the view is gone (closed, forgotten): a view opened later starts with the picker off
            active(|a| a.remove(&(space.clone(), label.clone())));
            continue;
        };
        if let Some(pick) = poll_view(&space, &label, |op| js(&wv, op)) {
            // The main window only: `emit` would reach every webview that may listen.
            let _ = app.emit_to(
                "main",
                "browser-picked",
                json!({ "space": space, "element": pick }),
            );
        }
    }
}

/// One view's poll; `js` runs a picker op in it (a parameter so a test can answer after an Off).
fn poll_view(
    space: &str,
    label: &str,
    js: impl Fn(&str) -> Result<Value, String>,
) -> Option<Value> {
    let answer = js("poll").ok();
    // Q9 pop-J23-2: `poll` switches the picker on; an `off` that ran before it would leave it on, unpolled, eating clicks.
    if !active(|a| a.contains(&(space.to_string(), label.to_string()))) {
        let _ = js("off");
        return None;
    }
    answer.as_ref().and_then(pick_of).cloned()
}

/// Forgets that the picker is on in any of the space's views (Forget). Never fails.
pub fn clear(space: &str) {
    active(|a| a.retain(|(s, _)| s != space));
}

/// `tab`: the pane's tab (`None`: tab 1); a number outside the space is refused (`agent::tab_of`).
pub fn set(app: &AppHandle, space: &str, tab: Option<u32>, on: bool) -> Result<(), String> {
    let label = super::agent::tab_of(space, tab);
    if !on {
        // first: a view that is already gone must still leave ACTIVE
        active(|a| a.retain(|(s, l)| !(s == space && label.as_ref().is_ok_and(|x| x == l))));
    }
    let Some(wv) = label.ok().and_then(|l| app.get_webview(&l)) else {
        return if on {
            Err("The browser view is not open".to_string())
        } else {
            Ok(())
        };
    };
    if on {
        js(&wv, "on")?;
        active(|a| a.insert((space.to_string(), wv.label().to_string())));
        let app = app.clone();
        POLLER.call_once(move || {
            thread::spawn(move || {
                loop {
                    thread::sleep(TICK);
                    poll(&app);
                }
            });
        });
        Ok(())
    } else {
        js(&wv, "off").map(|_| ())
    }
}

/// Debug builds only, for `tests/scenario/browser_annotate.py`: a file `$NUNCHIRO_HOME/annotate-forget` holding a space id
/// runs Forget on it, `annotate-show` ("<space> <url>") opens the space's first view as the side pane does, and a file `annotate-on` holding a space id switches that space's picker on (the main window's button is not reachable from a script), and every
/// `browser-picked` event is printed to stderr as the main window would receive it.
#[cfg(debug_assertions)]
pub fn selftest(app: AppHandle) {
    use tauri::Listener;
    if std::env::var("NUNCHIRO_ANNOTATE_TEST").is_err() {
        return;
    }
    app.listen_any("browser-picked", |e| {
        eprintln!("annotate-picked {}", e.payload())
    });
    let Ok(home) = std::env::var("NUNCHIRO_HOME") else {
        return;
    };
    thread::spawn(move || {
        let file = std::path::Path::new(&home).join("annotate-on");
        let forget = std::path::Path::new(&home).join("annotate-forget");
        let show = std::path::Path::new(&home).join("annotate-show");
        loop {
            thread::sleep(Duration::from_millis(200));
            if let Ok(text) = std::fs::read_to_string(&show) {
                let _ = std::fs::remove_file(&show);
                // "<space> <url>": the side pane's own way to (re)open the space's first view.
                if let Some((space, url)) = text.trim().split_once(' ')
                    && let Err(e) = super::show(&app, space, url, (0.0, 0.0, 400.0, 300.0), None)
                {
                    eprintln!("annotate-selftest: show: {e}");
                }
            }
            if let Ok(space) = std::fs::read_to_string(&forget) {
                let _ = std::fs::remove_file(&forget);
                if let Err(e) = super::forget(&app, space.trim()) {
                    eprintln!("annotate-selftest: forget: {e}");
                }
                eprintln!("annotate-forgotten");
            }
            if let Ok(space) = std::fs::read_to_string(&file) {
                let _ = std::fs::remove_file(&file);
                if let Err(e) = set(&app, space.trim(), None, true) {
                    eprintln!("annotate-selftest: {e}");
                }
            }
        }
    });
}

/// AppKit and WebKit through the Objective-C runtime, as in `agent.rs` but in a world of its own so the picker and the
/// agent's snapshot cannot see each other's state. Main thread only.
mod mac {
    use std::sync::mpsc::Sender;

    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::NSString;

    thread_local! {
        /// Held for the app's life: WebKit drops a named world's state once its last WKContentWorld object is released.
        static WORLD: std::cell::OnceCell<Retained<AnyObject>> = const { std::cell::OnceCell::new() };
    }

    /// `callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:` in the "nunchiro-picker" world with the
    /// request as the string argument `a`; the answer (or the exception text) goes to `tx`.
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
                &**w.get_or_init(|| msg_send![class!(WKContentWorld), worldWithName: &*NSString::from_str("nunchiro-picker")])
                    as *const AnyObject
            });
            let dict: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: &*NSString::from_str(arg), forKey: &*NSString::from_str("a")];
            let block =
                block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let _ = tx.send(if !error.is_null() {
                        Err("The picker failed in the page".into())
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// picked_event_main_only: the pick goes out by `emit_to("main", ..)` and by no broadcast, and the capability that lets a
    /// webview listen belongs to the main window alone, so the browser view (a child webview with its own label) cannot.
    #[test]
    fn picked_event_main_only() {
        let src = include_str!("annotate.rs");
        let code: String = src
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .split_whitespace()
            .collect();
        assert!(code.contains(r#"emit_to("main","browser-picked""#));
        assert!(
            !code.contains(".emit(") && !code.contains("emit_filter") && !code.contains("emit_str")
        );
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(cap["windows"], json!(["main"]));
        assert!(cap.get("webviews").is_none() && cap.get("remote").is_none());
    }

    /// annotate_off_when_view_gone: leaving ACTIVE does not depend on the view existing, and Forget clears it.
    #[test]
    fn annotate_off_when_view_gone() {
        active(|a| a.insert(("gone".into(), "browser-1".into())));
        active(|a| a.insert(("gone".into(), "browser-2".into())));
        clear("gone");
        assert!(active(|a| !a.iter().any(|(s, _)| s == "gone")));
        let src = include_str!("annotate.rs");
        let set = src.split("pub fn set(").nth(1).unwrap();
        assert!(set.find("a.retain(").unwrap() < set.find("get_webview").unwrap());
        let poll = src
            .split("fn poll(")
            .nth(1)
            .unwrap()
            .split("pub fn clear")
            .next()
            .unwrap();
        assert!(poll.contains("a.remove(&(space.clone(), label.clone()))"));
        let forget = include_str!("mod.rs")
            .split("pub fn forget(")
            .nth(1)
            .unwrap();
        assert!(
            forget
                .split("Err(format!")
                .next()
                .unwrap()
                .contains("annotate::clear(space)")
        );
    }

    /// Q9 pop-J23-2: the owner's Off lands while a poll is on its way; the poll's answer switched the picker back on in
    /// the page, so the poller switches it off again and passes no pick.
    #[test]
    fn a_poll_answered_after_off_switches_the_picker_off_again() {
        let view = ("late-off".to_string(), "browser-late".to_string());
        active(|a| a.insert(view.clone()));
        let ops = std::cell::RefCell::new(Vec::new());
        let pick = poll_view(&view.0, &view.1, |op| {
            ops.borrow_mut().push(op.to_string());
            if op == "poll" {
                clear(&view.0); // Off ran while the page was answering
            }
            Ok(json!({ "pick": { "tag": "a" } }))
        });
        assert_eq!(pick, None);
        assert_eq!(ops.into_inner(), ["poll", "off"]);
        // A view still on passes its pick and sends no off.
        active(|a| a.insert(view.clone()));
        let ops = std::cell::RefCell::new(Vec::new());
        let pick = poll_view(&view.0, &view.1, |op| {
            ops.borrow_mut().push(op.to_string());
            Ok(json!({ "pick": { "tag": "a" } }))
        });
        assert_eq!(pick, Some(json!({ "tag": "a" })));
        assert_eq!(ops.into_inner(), ["poll"]);
        clear(&view.0);
    }

    #[test]
    fn oversized_or_malformed_picks_are_dropped() {
        assert!(pick_of(&json!({ "pick": null })).is_none());
        assert!(pick_of(&json!({ "pick": "text" })).is_none());
        assert!(pick_of(&json!({ "pick": { "a": "x".repeat(PICK_MAX) } })).is_none());
        assert!(pick_of(&json!({ "pick": { "a": 1 } })).is_some());
    }

    /// The picker never leaves the isolated world and only counts trusted clicks (A10, A12).
    #[test]
    fn picker_script_rules() {
        assert!(SCRIPT.contains("e.isTrusted"));
        assert!(!SCRIPT.contains("window.__nunchiro") && !SCRIPT.contains("postMessage"));
        assert!(SCRIPT.contains("slice(0, CAP)"));
    }
}
