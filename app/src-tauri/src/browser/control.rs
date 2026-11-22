//! V2.5-21 (WP3): who drives a space's browser, the owner or the agent. the owner's own mouse-down or key-down on a space's web view
//! hands that space to him (`USER_IN_CONTROL`): every agent verb is refused until he presses Hand back in the side pane.
//! Threat model A11: the flip comes from an AppKit local event monitor, which sees only events that went through the
//! application's event queue (a real person, or the debug test hook below). The agent's input is sent straight to the
//! web view (`agent.rs`, `mac::Input`) and never passes the monitor, so it cannot flip control; Hand back is app
//! chrome (a window command), and no verb reaches it.
//! One serial queue for both: the monitor and every agent input closure run on the main thread, and an agent closure
//! checks `gate` there first, so the owner's event and an agent action are ordered, never interleaved mid-action.
use std::{sync::Mutex, time::Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

/// The agent's answer while the owner has the browser. Stable prefix: the CLI and agents match on it.
pub const REFUSED: &str = "USER_IN_CONTROL: the owner has taken over this browser until he presses Hand back. Stop browser work now and do not retry; the owner tells you when to go on";

/// Spaces the owner controls, with the agent's handoff reason when the agent asked for him.
static OWNER: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());
/// Each space's last Hand back (microseconds since the Unix epoch, as the core's `Job::queued`).
static BACK: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());
/// WKWebView address -> space and view label, for every browser view (side pane and agent tabs).
static VIEWS: Mutex<Vec<(usize, String, String)>> = Mutex::new(Vec::new());
/// The app, for the failed-load callback WebKit makes with no context of ours.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

fn owner() -> std::sync::MutexGuard<'static, Vec<(String, Option<String>)>> {
    OWNER.lock().unwrap_or_else(|e| e.into_inner())
}

fn views() -> std::sync::MutexGuard<'static, Vec<(usize, String, String)>> {
    VIEWS.lock().unwrap_or_else(|e| e.into_inner())
}

fn back() -> std::sync::MutexGuard<'static, Vec<(String, u64)>> {
    BACK.lock().unwrap_or_else(|e| e.into_inner())
}

/// One agent job's hold on its space: the space and when the agent sent the job (`Job::queued`).
#[derive(Clone)]
pub struct Turn {
    pub space: String,
    pub queued: u64,
}

/// `Err(REFUSED)` while the owner has the space, and for a job sent before his last Hand back: it was queued before or during
/// his takeover, so it is dropped, never replayed on the page he changed.
pub fn gate(turn: &Turn) -> Result<(), String> {
    if owner().iter().any(|(s, _)| *s == turn.space)
        || back()
            .iter()
            .any(|(s, at)| *s == turn.space && turn.queued < *at)
    {
        return Err(REFUSED.into());
    }
    Ok(())
}

/// Tests elsewhere in the browser module: the owner holds `space`, as `take` records it.
#[cfg(test)]
pub(super) fn held_by_owner(space: &str) {
    let mut k = owner();
    k.retain(|(s, _)| s != space);
    k.push((space.into(), None));
}

pub(super) fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// Whether the owner has this space's browser now.
pub fn held(space: &str) -> bool {
    owner().iter().any(|(s, _)| s == space)
}

fn state(space: &str) -> Value {
    let k = owner();
    let held = k.iter().find(|(s, _)| s == space);
    json!({"space": space, "user": held.is_some(), "reason": held.and_then(|(_, r)| r.clone())})
}

/// The owner has the space. A handoff's reason is shown; a click or key while he already has it changes nothing.
pub fn take(app: &AppHandle, space: &str, reason: Option<String>) {
    super::agent::clear_popup_note(space); // before the early return: every act of the owner's counts
    {
        let mut k = owner();
        match k.iter_mut().find(|(s, _)| s == space) {
            Some(_) if reason.is_none() => return, // already his: no event per keystroke
            Some((_, r)) => *r = reason,
            None => k.push((space.into(), reason)),
        }
    }
    let _ = app.emit("browser-control", state(space));
}

pub fn hand_back(app: &AppHandle, space: &str) {
    owner().retain(|(s, _)| s != space);
    let mut b = back();
    b.retain(|(s, _)| s != space);
    b.push((space.into(), now_micros()));
    drop(b);
    let _ = app.emit("browser-control", state(space));
}

#[tauri::command]
pub fn browser_control(webview: tauri::Webview, space: String) -> Result<Value, String> {
    crate::cli_install::main_only(&webview)?;
    Ok(state(&space))
}

/// The side pane's Hand back button. Window chrome only: no agent verb maps here (A11).
#[tauri::command]
pub fn browser_hand_back(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    hand_back(&app, &space);
    Ok(())
}

/// Notes a browser view so the owner's events on it are traced to its space.
pub fn watch(wv: &tauri::Webview, space: &str) {
    let (space, label) = (space.to_string(), wv.label().to_string());
    APP.get_or_init(|| wv.app_handle().clone());
    let _ = wv.with_webview(move |pv| {
        // SAFETY: Tauri runs this on the main thread with the live WKWebView.
        unsafe { mac::report_failed_loads(pv.inner().cast()) };
        let at = pv.inner() as usize;
        let mut v = views();
        v.retain(|(p, ..)| *p != at);
        v.push((at, space, label));
    });
}

/// The space's views are closed (Forget): their addresses may be reused, and their failed loads are dropped.
pub fn unwatch(space: &str) {
    let gone: Vec<String> = {
        let mut v = views();
        let gone = v
            .iter()
            .filter(|(_, s, _)| s == space)
            .map(|(.., l)| l.clone())
            .collect();
        v.retain(|(_, s, _)| s != space);
        gone
    };
    fails().retain(|(l, ..)| !gone.contains(l));
    list(&STARTS).retain(|(l, ..)| !gone.contains(l));
}

fn space_of(view: usize) -> Option<String> {
    tab_of_view(view).map(|(s, _)| s)
}

/// The space and the view label of a browser view.
fn tab_of_view(view: usize) -> Option<(String, String)> {
    views()
        .iter()
        .find(|(p, ..)| *p == view)
        .map(|(_, s, l)| (s.clone(), l.clone()))
}

/// Ticket 998 L3 (B2): each view label's last failed load (when, why), so an agent's settle wait ends at once.
/// Ticket 998 L5 round 2 (security MUST): bounded, as views come and go for the app's whole life; Forget drops a
/// space's entries (`unwatch`), and past FAILS_MAX the oldest goes. 8 tabs in 8 spaces fit.
static FAILS: Events = Mutex::new(Vec::new());
const FAILS_MAX: usize = 64;
/// Characters of a failure's text kept; the system's own descriptions are one short sentence.
const FAIL_TEXT_MAX: usize = 300;

/// Ticket 998 L8 (B6): each view label's last main-frame navigation start (didStartProvisionalNavigation), so a click
/// or key that starts a load waits for the new page, and one that starts none ends on the page's own changes. Bounded
/// and dropped at Forget as FAILS is; the text is unused.
static STARTS: Mutex<Vec<(String, Instant, String)>> = Mutex::new(Vec::new());

type Events = Mutex<Vec<(String, Instant, String)>>;

fn list(events: &'static Events) -> std::sync::MutexGuard<'static, Vec<(String, Instant, String)>> {
    events.lock().unwrap_or_else(|e| e.into_inner())
}

fn fails() -> std::sync::MutexGuard<'static, Vec<(String, Instant, String)>> {
    list(&FAILS)
}

/// One entry per label, its latest; past FAILS_MAX the oldest goes.
fn note(events: &'static Events, label: String, text: String) {
    let mut f = list(events);
    f.retain(|(l, ..)| *l != label);
    if f.len() >= FAILS_MAX {
        f.remove(0);
    }
    f.push((label, Instant::now(), text));
}

fn note_failure(label: String, error: &str) {
    note(&FAILS, label, error.chars().take(FAIL_TEXT_MAX).collect());
}

/// Whether view `label` started loading a new page at or after `since`.
pub(super) fn started_since(label: &str, since: Instant) -> bool {
    list(&STARTS)
        .iter()
        .any(|(l, at, _)| l == label && *at >= since)
}

/// Why view `label`'s load failed, when it failed at or after `since`.
pub(super) fn failed_since(label: &str, since: Instant) -> Option<String> {
    fails()
        .iter()
        .find(|(l, at, _)| l == label && *at >= since)
        .map(|(.., e)| e.clone())
}

/// Whether a failed load ends an agent's wait: every failure but a load a newer one replaced (-999).
fn ends_wait(domain: &str, code: isize) -> bool {
    !(domain == "NSURLErrorDomain" && code == -999)
}

/// Whether a failed load is one the user should hear about: the network's errors, not a load a newer one replaced (-999)
/// or WebKit's own policy stops (a download, the navigation guard).
fn shows_failure(domain: &str, code: isize) -> bool {
    domain == "NSURLErrorDomain" && code != -999
}

/// Ticket 288: a page the pane can show could not load; the pane says why, since the view itself stays blank. Ticket 328
/// part 2: the pane can show any agent tab, so each failure names its tab (1 for the pane's own view).
fn failed(view: usize, error: String, code: isize, url: String) {
    if let (Some(app), Some((space, label))) = (APP.get(), tab_of_view(view)) {
        let tab = super::agent::tab_index(&space, &label);
        let _ = app.emit_to(
            "main",
            "browser-failed",
            json!({"space": space, "tab": tab, "error": error, "code": code, "url": url}),
        );
    }
}

/// Installs the event monitor once, on the main thread.
pub fn start(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || unsafe { mac::monitor(handle) });
}

/// Ticket 535: the page a forwarded key came from gets the key focus back. Main thread.
pub fn refocus(view: usize) {
    unsafe { mac::refocus(view) }
}

/// The agent's pointer: a dot over the web view where its last click landed. Main thread; `wk` is a live WKWebView.
pub use mac::{cursor, outline};

mod mac {
    use objc2::{
        Encode, Encoding, class, ffi, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool, Imp, Sel},
        sel,
    };
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    /// `webView:didFailProvisionalNavigation:withError:`: main frame only, a page that never started (DNS, TLS, offline).
    unsafe extern "C-unwind" fn did_fail(
        _this: *mut AnyObject,
        _sel: Sel,
        wk: *mut AnyObject,
        _navigation: *mut AnyObject,
        error: *mut AnyObject,
    ) {
        unsafe {
            let domain: *mut NSString = msg_send![error, domain];
            let domain = (*domain).to_string();
            let code: isize = msg_send![error, code];
            let text: *mut NSString = msg_send![error, localizedDescription];
            if super::ends_wait(&domain, code)
                && let Some((_, label)) = super::tab_of_view(wk as usize)
            {
                super::note_failure(label, &(*text).to_string());
            }
            if super::shows_failure(&domain, code) {
                // The pane names the cause from `code` (the text follows the system language) and retries this URL: after a
                // failed load the view still holds the page before it.
                let info: *mut AnyObject = msg_send![error, userInfo];
                let key = NSString::from_str("NSErrorFailingURLKey"); // an NSURL; WebKit sets no string form
                let url: *mut AnyObject = msg_send![info, objectForKey: &*key];
                let url: *mut NSString = msg_send![url, absoluteString];
                let url = url.as_ref().map(|u| u.to_string()).unwrap_or_default();
                super::failed(wk as usize, (*text).to_string(), code, url);
            }
        }
    }

    /// `webView:didStartProvisionalNavigation:`: main frame only, a new page was asked for (ticket 998 L8, B6). wry
    /// reports a page only from its commit, after the server answered.
    unsafe extern "C-unwind" fn did_start(
        _this: *mut AnyObject,
        _sel: Sel,
        wk: *mut AnyObject,
        _navigation: *mut AnyObject,
    ) {
        if let Some((_, label)) = super::tab_of_view(wk as usize) {
            super::note(&super::STARTS, label, String::new());
        }
    }

    /// wry's navigation delegate has no failed-load or load-start method and Tauri no event for them, so a page that could
    /// not load was a silent white view (ticket 288). Adds both to the delegate's class (a second add is refused,
    /// harmlessly).
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn report_failed_loads(wk: *mut AnyObject) {
        unsafe {
            let delegate: *mut AnyObject = msg_send![wk, navigationDelegate];
            if delegate.is_null() {
                return;
            }
            let imp = std::mem::transmute::<
                unsafe extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                    *mut AnyObject,
                    *mut AnyObject,
                ),
                Imp,
            >(did_fail);
            ffi::class_addMethod(
                ffi::object_getClass(delegate).cast_mut(),
                sel!(webView:didFailProvisionalNavigation:withError:),
                imp,
                c"v@:@@@".as_ptr(),
            );
            let start = std::mem::transmute::<
                unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject),
                Imp,
            >(did_start);
            ffi::class_addMethod(
                ffi::object_getClass(delegate).cast_mut(),
                sel!(webView:didStartProvisionalNavigation:),
                start,
                c"v@:@@".as_ptr(),
            );
            // WebKit reads which methods a delegate has when it is set, so set it again.
            let _: () = msg_send![wk, setNavigationDelegate: delegate];
        }
    }

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
    #[repr(transparent)]
    #[derive(Clone, Copy)]
    struct CgColor(*mut std::ffi::c_void);
    unsafe impl Encode for CgColor {
        const ENCODING: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    const LEFT_DOWN: usize = 1;
    const RIGHT_DOWN: usize = 3;
    const KEY_DOWN: usize = 10;
    const OTHER_DOWN: usize = 25;
    const MASK: u64 = 1 << LEFT_DOWN | 1 << RIGHT_DOWN | 1 << KEY_DOWN | 1 << OTHER_DOWN;

    /// # Safety
    /// Main thread.
    pub unsafe fn monitor(app: AppHandle) {
        let block = block2::RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            // Ticket 535: an app key goes on to the window's own view; it is not the owner's input to the page.
            if unsafe { to_window(event) } {
                return event;
            }
            // A click puts the key focus where the owner wants it: no later Esc hands it back to a page.
            let kind: usize = unsafe { msg_send![event, type] };
            if kind != KEY_DOWN {
                super::super::keys::note_from(None);
            }
            if let Some(view) = unsafe { target(event) }
                && let Some((space, label)) = super::tab_of_view(view)
            {
                super::super::agent::owner_on(&space, &label); // the tab he acts on is the agent's from now on
                super::take(&app, &space, None);
            }
            event
        });
        let m: Option<Retained<AnyObject>> = unsafe {
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: MASK, handler: &*block]
        };
        std::mem::forget(m); // lives as long as the app
    }

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        /// On while any password field has the keyboard (WebKit turns it on for a focused password field).
        fn IsSecureEventInputEnabled() -> u8;
    }

    /// The window's views below its content view, in subview order: (address, is a WKWebView). A web view's own inner
    /// views are not listed. Only views alive in the window now, so no address goes stale (a Dock reopen builds a new
    /// window and page).
    unsafe fn views_of(window: *mut AnyObject) -> Vec<(usize, bool)> {
        unsafe fn walk(view: *mut AnyObject, depth: u8, out: &mut Vec<(usize, bool)>) {
            unsafe {
                let subs: *mut AnyObject = msg_send![view, subviews];
                let n: usize = msg_send![subs, count];
                for i in 0..n {
                    let v: *mut AnyObject = msg_send![subs, objectAtIndex: i];
                    let web: Bool = msg_send![v, isKindOfClass: class!(WKWebView)];
                    out.push((v as usize, web.as_bool()));
                    if !web.as_bool() && depth > 0 {
                        walk(v, depth - 1, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        unsafe {
            let content: *mut AnyObject = msg_send![window, contentView];
            if content.is_null() {
                return out;
            }
            let web: Bool = msg_send![content, isKindOfClass: class!(WKWebView)];
            out.push((content as usize, web.as_bool()));
            if !web.as_bool() {
                walk(content, 3, &mut out);
            }
        }
        out
    }

    /// The registered browser view that holds `view` (itself or an ancestor).
    unsafe fn browser_of(mut view: *mut AnyObject) -> Option<usize> {
        unsafe {
            while !view.is_null() && msg_send![view, isKindOfClass: class!(NSView)] {
                if super::space_of(view as usize).is_some() {
                    return Some(view as usize);
                }
                view = msg_send![view, superview];
            }
        }
        None
    }

    /// Ticket 535: a key-down aimed at a browser view that `keys::forward` gives the window. The window's own page view,
    /// found in the event's window now (never a stored pointer), becomes the key view, so this same native event (returned
    /// by the monitor) is dispatched to it, as if pressed there; a page script cannot make one, since only queued AppKit
    /// events pass a local monitor.
    unsafe fn to_window(event: *mut AnyObject) -> bool {
        unsafe {
            let kind: usize = msg_send![event, type];
            let window: *mut AnyObject = msg_send![event, window];
            if kind != KEY_DOWN || window.is_null() {
                return false;
            }
            let responder: *mut AnyObject = msg_send![window, firstResponder];
            let Some(from) = browser_of(responder) else {
                return false;
            };
            let key_code: u16 = msg_send![event, keyCode];
            let flags: usize = msg_send![event, modifierFlags];
            let Some(chord) = super::super::keys::chord(key_code, flags) else {
                return false;
            };
            let marks: Bool = msg_send![responder, respondsToSelector: sel!(hasMarkedText)];
            let composing = marks.as_bool() && {
                let has: Bool = msg_send![responder, hasMarkedText];
                has.as_bool()
            };
            let guarded = composing || IsSecureEventInputEnabled() != 0;
            if !super::super::keys::forwards(&chord, guarded) {
                return false;
            }
            let page = super::super::keys::page_view(&views_of(window), |at| {
                super::space_of(at).is_some()
            });
            let Some(page) = page else {
                return false;
            };
            let moved: Bool = msg_send![window, makeFirstResponder: page as *mut AnyObject];
            if moved.as_bool() {
                super::super::keys::note_from(Some(from));
            }
            moved.as_bool()
        }
    }

    /// Gives the key focus back to browser view `view` if it is still in one of the app's windows (looked up live, so a
    /// closed view or window is simply not found).
    /// # Safety
    /// Main thread.
    pub unsafe fn refocus(view: usize) {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let windows: *mut AnyObject = msg_send![app, windows];
            let n: usize = msg_send![windows, count];
            for i in 0..n {
                let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                if super::space_of(view).is_some()
                    && views_of(w).iter().any(|(at, web)| *at == view && *web)
                {
                    let _: Bool = msg_send![w, makeFirstResponder: view as *mut AnyObject];
                    return;
                }
            }
        }
    }

    /// The browser view this mouse-down hits or this key-down goes to.
    unsafe fn target(event: *mut AnyObject) -> Option<usize> {
        unsafe {
            let kind: usize = msg_send![event, type];
            let window: *mut AnyObject = msg_send![event, window];
            if window.is_null() {
                return None;
            }
            let view: *mut AnyObject = if kind == KEY_DOWN {
                msg_send![window, firstResponder]
            } else {
                let content: *mut AnyObject = msg_send![window, contentView];
                let root: *mut AnyObject = msg_send![content, superview];
                let root = if root.is_null() { content } else { root };
                let at: Point = msg_send![event, locationInWindow];
                msg_send![root, hitTest: at]
            };
            browser_of(view)
        }
    }

    pub(super) const CURSOR: &str = "nunchiro-agent-cursor";

    /// # Safety
    /// Main thread; `wk` is a live, layer-backed WKWebView.
    pub unsafe fn cursor(wk: *mut AnyObject, x: f64, y: f64) {
        unsafe {
            let host: *mut AnyObject = msg_send![wk, layer];
            if host.is_null() {
                return;
            }
            // Round 3: in the view's own layer tree, as the outline (`sublayer`), never in a map by address.
            let dot = sublayer(host, CURSOR, |dot| {
                let blue: *mut AnyObject = msg_send![class!(NSColor), systemBlueColor];
                let white: *mut AnyObject = msg_send![class!(NSColor), whiteColor];
                let (blue, white): (CgColor, CgColor) =
                    (msg_send![blue, CGColor], msg_send![white, CGColor]);
                let _: () = msg_send![dot, setBackgroundColor: blue];
                let _: () = msg_send![dot, setBorderColor: white];
                let _: () = msg_send![dot, setOpacity: 0.85f32];
                let _: () = msg_send![dot, setZPosition: 1000.0f64];
            });
            // Ticket 997 L6: 16 window points across however the page is scaled (16/l page px in a scaled frame).
            let one = Rect {
                origin: Point { x: 0.0, y: 0.0 },
                size: Point { x: 16.0, y: 16.0 },
            };
            let d: Rect =
                msg_send![wk, convertRect: one, fromView: std::ptr::null_mut::<AnyObject>()];
            let d = if d.size.x.is_finite() && d.size.x.abs() >= 1.0 {
                d.size.x.abs()
            } else {
                16.0
            };
            let _: () = msg_send![dot, setBounds: Rect { origin: Point { x: 0.0, y: 0.0 }, size: Point { x: d, y: d } }];
            let _: () = msg_send![dot, setCornerRadius: d / 2.0];
            let _: () = msg_send![dot, setBorderWidth: d / 8.0];
            let flipped: Bool = msg_send![host, isGeometryFlipped];
            let bounds: Rect = msg_send![wk, bounds];
            let y = if flipped.as_bool() {
                y
            } else {
                bounds.size.y - y
            };
            let _: () = msg_send![dot, setPosition: Point { x, y }];
        }
    }

    pub(super) const OUTLINE: &str = "nunchiro-agent-outline";

    /// `host`'s own sublayer named `name`, or null.
    /// # Safety
    /// Main thread; `host` is a live CALayer.
    pub(super) unsafe fn found(host: *mut AnyObject, name: &str) -> *mut AnyObject {
        unsafe {
            let subs: *mut AnyObject = msg_send![host, sublayers];
            let n: usize = if subs.is_null() {
                0
            } else {
                msg_send![subs, count]
            };
            for i in 0..n {
                let l: *mut AnyObject = msg_send![subs, objectAtIndex: i];
                let at: *mut NSString = msg_send![l, name];
                if !at.is_null() && (*at).to_string() == name {
                    return l;
                }
            }
            std::ptr::null_mut()
        }
    }

    /// `host`'s sublayer `name`, made there (and given its look by `style`) when it has none. The agent's pointer and outline
    /// live only in the view's own layer tree: nothing outside holds them, so they go with their view, and a later view at
    /// a reused address starts without them (security r2 MUST: no map keyed by address).
    /// # Safety
    /// Main thread; `host` is a live CALayer.
    pub(super) unsafe fn sublayer(
        host: *mut AnyObject,
        name: &str,
        style: impl FnOnce(*mut AnyObject),
    ) -> *mut AnyObject {
        unsafe {
            let l = found(host, name);
            if !l.is_null() {
                return l;
            }
            let l: Retained<AnyObject> = msg_send![class!(CALayer), layer];
            let at = Retained::as_ptr(&l) as *mut AnyObject;
            let _: () = msg_send![at, setName: &*NSString::from_str(name)];
            style(at);
            let _: () = msg_send![host, addSublayer: at]; // the host retains it from here; our `l` is released on return
            at
        }
    }

    /// Ticket 997 L7: a still 2 pt outline in the agent pointer's blue over the edge of `wk`'s page while the agent drives
    /// it (no animation: Claude in Chrome's glow costs about 50% CPU). A layer of the page's own, as `cursor`'s dot: the
    /// page keeps its 1280x800 and every click still lands where it is aimed (a layer takes no events).
    /// # Safety
    /// Main thread; `wk` is a live WKWebView.
    pub unsafe fn outline(wk: *mut AnyObject, on: bool) {
        unsafe {
            let host: *mut AnyObject = msg_send![wk, layer];
            if host.is_null() {
                return;
            }
            let line = if on {
                sublayer(host, OUTLINE, |l| {
                    let blue: *mut AnyObject = msg_send![class!(NSColor), systemBlueColor];
                    let blue: CgColor = msg_send![blue, CGColor];
                    let _: () = msg_send![l, setBorderColor: blue];
                    let _: () = msg_send![l, setZPosition: 999.0f64]; // under the pointer's dot
                })
            } else {
                found(host, OUTLINE) // never drawn: nothing to take away
            };
            if line.is_null() {
                return;
            }
            let _: () = msg_send![line, setHidden: Bool::new(!on)];
            if !on {
                return;
            }
            // 2 window points, however the page is scaled (2/l page px in a frame), measured as `cursor` measures its dot.
            let two = Rect {
                origin: Point { x: 0.0, y: 0.0 },
                size: Point { x: 2.0, y: 2.0 },
            };
            let d: Rect =
                msg_send![wk, convertRect: two, fromView: std::ptr::null_mut::<AnyObject>()];
            let d = if d.size.x.is_finite() && d.size.x.abs() > 0.0 {
                d.size.x.abs()
            } else {
                2.0
            };
            let bounds: Rect = msg_send![wk, bounds];
            let _: () = msg_send![line, setFrame: bounds];
            let _: () = msg_send![line, setBorderWidth: d];
        }
    }

    /// Debug test hook: whether `wk` shows the agent's outline, and its width in page px.
    #[cfg(debug_assertions)]
    pub unsafe fn outline_at(wk: *mut AnyObject) -> Option<f64> {
        unsafe {
            let host: *mut AnyObject = msg_send![wk, layer];
            if host.is_null() {
                return None;
            }
            let line = found(host, OUTLINE);
            if line.is_null() {
                return None;
            }
            let hidden: Bool = msg_send![line, isHidden];
            if hidden.as_bool() {
                return None;
            }
            let w: f64 = msg_send![line, borderWidth];
            Some(w)
        }
    }

    /// Debug test hook: the number of `wk`'s window.
    #[cfg(debug_assertions)]
    pub unsafe fn window_number(wk: *mut AnyObject) -> isize {
        unsafe {
            let window: *mut AnyObject = msg_send![wk, window];
            if window.is_null() {
                0
            } else {
                msg_send![window, windowNumber]
            }
        }
    }

    /// Debug test hook: whether `wk` shows the cursor, and where (layer coordinates).
    #[cfg(debug_assertions)]
    pub unsafe fn cursor_at(wk: *mut AnyObject) -> Option<(f64, f64)> {
        unsafe {
            let host: *mut AnyObject = msg_send![wk, layer];
            if host.is_null() {
                return None;
            }
            let dot = found(host, CURSOR);
            if dot.is_null() {
                return None;
            }
            let p: Point = msg_send![dot, position];
            Some((p.x, p.y))
        }
    }

    /// Debug test hook: posts a mouse click (CSS point of `wk`) or typed characters through the app's event queue, the
    /// way a person's input arrives (so it passes the monitor). The window becomes key first, as for a real click.
    #[cfg(debug_assertions)]
    pub unsafe fn post(wk: *mut AnyObject, click: Option<(f64, f64)>, text: &str) {
        unsafe {
            let window: *mut AnyObject = msg_send![wk, window];
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
            let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
            let number: isize = msg_send![window, windowNumber];
            let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            let now: f64 = msg_send![info, systemUptime];
            let mut events: Vec<*mut AnyObject> = Vec::new();
            if let Some((x, y)) = click {
                let flipped: Bool = msg_send![wk, isFlipped];
                let bounds: Rect = msg_send![wk, bounds];
                let local = Point {
                    x,
                    y: if flipped.as_bool() {
                        y
                    } else {
                        bounds.size.y - y
                    },
                };
                let at: Point =
                    msg_send![wk, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()];
                for kind in [1usize, 2] {
                    events.push(msg_send![class!(NSEvent), mouseEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: now, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32]);
                }
            }
            for ch in text.chars() {
                let s = NSString::from_str(&ch.to_string());
                for kind in [10usize, 11] {
                    events.push(msg_send![class!(NSEvent), keyEventWithType: kind, location: Point { x: 0.0, y: 0.0 }, modifierFlags: 0usize, timestamp: now, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), characters: &*s, charactersIgnoringModifiers: &*s, isARepeat: Bool::NO, keyCode: 0u16]);
                }
            }
            for e in events {
                let _: () = msg_send![app, postEvent: e, atStart: Bool::NO];
            }
        }
    }

    /// Debug test hook: focuses a scratch text box in the window's own UI (the owner typing in Nunchiro, not in the page).
    #[cfg(debug_assertions)]
    pub unsafe fn ui_focus(ui: *mut AnyObject) {
        unsafe {
            let window: *mut AnyObject = msg_send![ui, window];
            let _: Bool = msg_send![window, makeFirstResponder: ui];
        }
    }
}

/// Debug builds only, for `tests/scenario/browser_couse.py`: plays the owner's hands. With `NUNCHIRO_BROWSER_TEST_HUMAN` set,
/// the app reads `<NUNCHIRO_HOME>/human/<n>.cmd` (one line: `place|click|keys|ui|ui-value|hand-back|state|cursor ...`),
/// runs it and writes `<n>.out`. Input goes through the real event queue; release builds have no such path.
#[cfg(debug_assertions)]
pub fn test_hook(app: AppHandle) {
    if std::env::var("NUNCHIRO_BROWSER_TEST_HUMAN").is_err() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(dir) = crate::home().map(|h| h.join("human")) else {
            return;
        };
        let _ = std::fs::create_dir_all(&dir);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Ok(list) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut cmds: Vec<_> = list
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "cmd"))
                .collect();
            cmds.sort();
            for path in cmds {
                let line = std::fs::read_to_string(&path).unwrap_or_default();
                let _ = std::fs::remove_file(&path);
                let out = hook(&app, line.trim()).unwrap_or_else(|e| json!({"error": e}));
                let tmp = path.with_extension("tmp");
                let _ = std::fs::write(&tmp, out.to_string());
                let _ = std::fs::rename(&tmp, path.with_extension("out"));
            }
        }
    });
}

#[cfg(debug_assertions)]
fn hook(app: &AppHandle, line: &str) -> Result<Value, String> {
    use std::{sync::mpsc, time::Duration};
    let mut words = line.splitn(3, ' ');
    let (op, space, rest) = (
        words.next().unwrap_or(""),
        words.next().unwrap_or("").to_string(),
        words.next().unwrap_or("").to_string(),
    );
    let view = |label: &str| app.get_webview(label).ok_or(format!("no view {label}"));
    // Runs `f` on the main thread with the WKWebView of `label` and waits for its answer.
    fn on<T: Send + 'static>(
        wv: &tauri::Webview,
        f: impl FnOnce(*mut objc2::runtime::AnyObject) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        wv.with_webview(move |pv| {
            let _ = tx.send(f(pv.inner().cast()));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "main thread did not answer".to_string())
    }
    let tab1 = || view(&super::view::label(&space));
    match op {
        // The side pane shows the space's tab 1 on screen (as when the owner opens the Browser tab); `rest`: the slot's
        // "w h" at (40, 80), or "x y w h" (default 700 500).
        "place" => {
            let n: Vec<f64> = rest.split(' ').filter_map(|n| n.parse().ok()).collect();
            let slot = match n[..] {
                [x, y, w, h] => (x, y, w, h),
                [w, h] => (40.0, 80.0, w, h),
                _ => (40.0, 80.0, 700.0, 500.0),
            };
            super::show(app, &space, "", slot, None).map(|()| json!({}))
        }
        // The side pane closes (ticket 997 L6: an agent space's view parks).
        "hide" => super::hide(app, &space, None).map(|()| json!({})),
        // The page's CSS viewport and the window number (for a screenshot of the window).
        "viewport" => {
            let wv = tab1()?;
            let mut v = super::agent::page_js(
                &wv,
                "return JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vis: document.visibilityState});",
                "",
            )?;
            v["window"] = json!(on(&wv, |wk| unsafe { mac::window_number(wk) })?);
            Ok(v)
        }
        // A click at the centre of the element `rest` (CSS selector) in tab 1.
        "click" => {
            let wv = tab1()?;
            let r = super::agent::page_js(
                &wv,
                "const r = document.querySelector(a).getBoundingClientRect(); return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2});",
                &rest,
            )?;
            let (x, y) = (
                r["x"].as_f64().unwrap_or(0.0),
                r["y"].as_f64().unwrap_or(0.0),
            );
            on(&wv, move |wk| unsafe { mac::post(wk, Some((x, y)), "") })?;
            Ok(json!({"x": x, "y": y}))
        }
        // Characters typed by the owner to whatever has his focus (`space` names the window's view to post through).
        "keys" => on(&tab1()?, move |wk| unsafe { mac::post(wk, None, &rest) }).map(|()| json!({})),
        // The owner's focus goes to a scratch text box in Nunchiro's own window.
        "ui" => {
            let main = view("main")?;
            main.eval("(() => { let t = document.getElementById('couse-owner'); if (!t) { t = document.createElement('textarea'); t.id = 'couse-owner'; t.style.cssText = 'position:fixed;left:0;bottom:0;width:200px;height:40px;z-index:99999'; document.body.append(t); } t.focus(); })()").map_err(|e| e.to_string())?;
            on(&main, |ui| unsafe { mac::ui_focus(ui) })?;
            Ok(json!({}))
        }
        "ui-value" => super::agent::page_js(
            &view("main")?,
            "const t = document.getElementById('couse-owner'); return JSON.stringify({value: t ? t.value : null, focused: document.activeElement === t});",
            "",
        ),
        "value" => super::agent::page_js(
            &tab1()?,
            "return JSON.stringify({value: document.querySelector(a).value});",
            &rest,
        ),
        "url" => super::agent::page_js(
            &tab1()?,
            "return JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 300)});",
            "",
        ),
        "hand-back" => {
            hand_back(app, &space);
            Ok(state(&space))
        }
        "state" => Ok(state(&space)),
        "cursor" => {
            let wv = tab1()?;
            let at = on(&wv, |wk| unsafe { mac::cursor_at(wk) })?;
            Ok(json!({"cursor": at.map(|(x, y)| json!([x, y]))}))
        }
        // Ticket 997 L7: tab 1's outline after one pane poll (`nav_state` keeps it in step): its width in page px, or null.
        "outline" => {
            let wv = tab1()?;
            super::agent::nav_state(&wv, &space)?;
            let w = on(&wv, |wk| unsafe { mac::outline_at(wk) })?;
            Ok(json!({"outline": w}))
        }
        _ => Err(format!("unknown hook {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ticket 997 L7 rounds 2-3 (security MUST): the agent's pointer and outline live only in their view's own layer tree:
    /// never drawn = none, drawn twice = one, none for another view (an address reused), freed with the view's layer.
    #[test]
    fn agent_layers_belong_to_their_view_only() {
        use objc2::{
            class, msg_send,
            rc::{Retained, Weak, autoreleasepool},
            runtime::AnyObject,
        };
        for name in [mac::CURSOR, mac::OUTLINE] {
            let gone = autoreleasepool(|_| unsafe {
                let a: Retained<AnyObject> = msg_send![class!(CALayer), layer];
                let host = Retained::as_ptr(&a) as *mut AnyObject;
                assert!(mac::found(host, name).is_null(), "{name}: never drawn");
                let mut styled = 0;
                let line = mac::sublayer(host, name, |_| styled += 1);
                assert_eq!(
                    mac::sublayer(host, name, |_| styled += 1),
                    line,
                    "{name}: one per view"
                );
                assert_eq!(styled, 1);
                let subs: *mut AnyObject = msg_send![host, sublayers];
                let n: usize = msg_send![subs, count];
                assert_eq!(n, 1);
                let b: Retained<AnyObject> = msg_send![class!(CALayer), layer];
                let other = Retained::as_ptr(&b) as *mut AnyObject;
                assert!(
                    mac::found(other, name).is_null(),
                    "{name}: another view starts clean"
                );
                Weak::from_retained(&Retained::retain(line).unwrap())
            });
            // Core Animation's implicit transaction holds changed layers until it commits (a run loop turn; none in a test).
            autoreleasepool(|_| unsafe {
                let _: () = msg_send![class!(CATransaction), flush];
            });
            assert!(gone.load().is_none(), "{name}: freed with its view's layer");
        }
    }

    /// Ticket 998 L3 (B2): a failed load ends the settle wait of its own view, only when it came after the action.
    #[test]
    fn failed_load_ends_its_views_wait() {
        let (label, other) = ("t-fail-a".to_string(), "t-fail-b");
        let before = Instant::now();
        note_failure(label.clone(), "offline");
        assert_eq!(failed_since(&label, before).as_deref(), Some("offline"));
        assert_eq!(failed_since(other, before), None, "another view's failure");
        std::thread::sleep(std::time::Duration::from_millis(1));
        assert_eq!(
            failed_since(&label, Instant::now()),
            None,
            "a failure before the action"
        );
        // Round 2 (security MUST): Forget drops a space's failures, the text is capped, and the list is bounded.
        // One test, as the list is shared: a parallel test filling it could evict another's entry.
        views().push((0xfa110, "t-fail-space".into(), "t-fail-c".into()));
        note_failure("t-fail-c".into(), &"x".repeat(10_000));
        assert_eq!(
            failed_since("t-fail-c", before).map(|e| e.chars().count()),
            Some(FAIL_TEXT_MAX)
        );
        unwatch("t-fail-space");
        assert_eq!(
            failed_since("t-fail-c", before),
            None,
            "forgotten with its space"
        );
        for i in 0..FAILS_MAX + 10 {
            note_failure(format!("t-fail-n{i}"), "offline");
        }
        assert_eq!(fails().len(), FAILS_MAX);
        assert_eq!(
            failed_since("t-fail-n0", before),
            None,
            "the oldest went first"
        );
        assert!(failed_since(&format!("t-fail-n{}", FAILS_MAX + 9), before).is_some());
        assert!(
            !ends_wait("NSURLErrorDomain", -999),
            "a newer load replaced it"
        );
        assert!(ends_wait("NSURLErrorDomain", -1009));
        assert!(ends_wait("WebKitErrorDomain", 102));
    }

    /// Ticket 998 L8 (B6): a load start counts for its own view only, when it came after the action, and Forget drops it.
    #[test]
    fn load_start_counts_for_its_own_view_after_the_action() {
        let before = Instant::now();
        views().push((0x57a27, "t-start-space".into(), "t-start-a".into()));
        note(&STARTS, "t-start-a".into(), String::new());
        assert!(started_since("t-start-a", before));
        assert!(!started_since("t-start-b", before), "another view's load");
        std::thread::sleep(std::time::Duration::from_millis(1));
        assert!(
            !started_since("t-start-a", Instant::now()),
            "a load before the action"
        );
        unwatch("t-start-space");
        assert!(
            !started_since("t-start-a", before),
            "forgotten with its space"
        );
    }

    fn give(space: &str, reason: Option<&str>) {
        let mut k = owner();
        k.retain(|(s, _)| s != space);
        k.push((space.into(), reason.map(Into::into)));
    }

    /// human_input_pauses_agent (state half; the live half is tests/scenario/browser_couse.py): while the owner holds the space
    /// every agent verb gets the stable refusal; other spaces are not held up.
    #[test]
    fn human_input_pauses_agent() {
        let turn = |space: &str| Turn {
            space: space.into(),
            queued: now_micros(),
        };
        give("t-pause", None);
        let e = gate(&turn("t-pause")).unwrap_err();
        assert!(
            e.starts_with("USER_IN_CONTROL:")
                && e.contains("Hand back")
                && e.contains("do not retry")
        );
        assert!(gate(&turn("t-other")).is_ok());
        owner().retain(|(s, _)| s != "t-pause");
        assert!(gate(&turn("t-pause")).is_ok(), "hand back frees the space");
    }

    /// queued_actions_dropped_on_takeover (review MUST): a job the agent sent before the owner's Hand back still waits in the
    /// core while the app is busy; when the app reaches it after the Hand back it is refused, never run on his page.
    /// A job sent after the Hand back runs.
    #[test]
    fn job_sent_before_hand_back_is_dropped() {
        let queued_before = Turn {
            space: "t-stale".into(),
            queued: now_micros(),
        };
        give("t-stale", None);
        assert!(gate(&queued_before).is_err(), "the owner has it");
        owner().retain(|(s, _)| s != "t-stale");
        back().push(("t-stale".into(), now_micros() + 1));
        assert_eq!(
            gate(&queued_before).unwrap_err(),
            REFUSED,
            "still dropped after Hand back"
        );
        let fresh = Turn {
            space: "t-stale".into(),
            queued: now_micros() + 2,
        };
        assert!(gate(&fresh).is_ok());
        assert!(
            gate(&Turn {
                space: "t-elsewhere".into(),
                queued: 0
            })
            .is_ok(),
            "other spaces unaffected"
        );
    }

    #[test]
    fn control_state_reports_reason() {
        give("t-reason", Some("sign in needs the password"));
        assert_eq!(
            state("t-reason"),
            json!({"space": "t-reason", "user": true, "reason": "sign in needs the password"})
        );
        owner().retain(|(s, _)| s != "t-reason");
        assert_eq!(state("t-reason")["user"], false);
    }

    #[test]
    fn failed_load_shown_for_network_errors_only() {
        assert!(shows_failure("NSURLErrorDomain", -1003), "no such host");
        assert!(shows_failure("NSURLErrorDomain", -1200), "TLS");
        assert!(
            !shows_failure("NSURLErrorDomain", -999),
            "replaced by a newer load"
        );
        assert!(!shows_failure("WebKitErrorDomain", 102), "policy stop");
        // Security review r1 NOTE 4: a failure names an agent tab's address; it goes to the main window only.
        let code: String = include_str!("control.rs").split_whitespace().collect();
        assert!(code.contains(r#"emit_to("main","browser-failed""#));
    }

    #[test]
    fn events_trace_to_their_space() {
        views().push((0xdead0, "t-view".into(), "browser-x".into()));
        assert_eq!(space_of(0xdead0).as_deref(), Some("t-view"));
        unwatch("t-view");
        assert_eq!(
            space_of(0xdead0),
            None,
            "forgotten views no longer flip a space"
        );
    }
}
