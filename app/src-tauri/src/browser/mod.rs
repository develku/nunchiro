//! V2.5-19 (WP1): a WKWebView child webview of the main window, glued to the side pane's browser slot. The web UI owns the
//! toolbar and reports the slot's rectangle; this module only creates, moves, shows, hides and navigates the native view.
//! No agent path here (WP2). The view is a plain web view: no Tauri capability names its label, no inspector, no scheme
//! handler, and `view::allowed` guards every navigation (threat model A5, A8, A9).
mod agent; // V2.5-20 (WP2)
mod annotate; // V2.5-22 (WP4)
pub mod control; // V2.5-21 (WP3)
pub mod keys; // ticket 535
mod view;

pub use agent::start as start_agent;
#[cfg(debug_assertions)]
pub use annotate::selftest as annotate_selftest;
pub use control::start as start_control;
#[cfg(debug_assertions)]
pub use control::test_hook;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl,
    webview::{
        NewWindowFeatures, NewWindowResponse, PageLoadEvent, PageLoadPayload, PermissionKind,
        PermissionResponse, WebviewBuilder,
    },
};
pub use view::note_core_port;

/// Ticket 255 (A13, widget-check G04): a site permission answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permit {
    Allow,
    Ask,
    Deny,
}

/// Only the owner's "you" store reads the site list (`kind` is one of `view::SITE_KINDS`); for every agent space the list answers
/// deny, whatever it says, so an agent never rides a permission the owner gave a site (the view's handler then hands the prompt
/// to owner: `handler`).
/// `requester` is the asking frame's host and decides (review round 2): an allowed page that embeds a frame does not
/// lend it its allow. A deny for the top page or the frame wins. `None` (frame unknown) never allows.
/// Camera and microphone with no row for the page or the frame are denied (ticket 255); any other row asks.
pub fn site_permission(
    space: &str,
    top: &str,
    requester: Option<&str>,
    kind: &str,
    prefs: &view::Prefs,
) -> Permit {
    if space != agent::YOU {
        return Permit::Deny;
    }
    let row = |host: &str| {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        prefs
            .sites
            .iter()
            .find(|(h, k, _)| *h == host && *k == kind)
            .map(|r| r.2)
    };
    match (row(top), requester.map(row)) {
        (Some("deny"), _) | (_, Some(Some("deny"))) => Permit::Deny,
        (_, Some(Some("allow"))) => Permit::Allow,
        (None, None | Some(None)) if matches!(kind, "camera" | "microphone") => Permit::Deny,
        _ => Permit::Ask,
    }
}

/// Each view's committed page host, by label. WKWebView.URL is the pending address during a provisional navigation, so a
/// page could point it at an allowed site and ask at once; `permit` reads this instead (review M4).
static COMMITTED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// The view's `on_page_load` hook: wry reports `Started` from didCommitNavigation. `Finished` reads WKWebView.URL again,
/// which may already be the next pending page, so only `Started` records.
fn committed(label: &str, event: PageLoadEvent, url: &tauri::Url) {
    if event != PageLoadEvent::Started {
        return;
    }
    if let Ok(mut c) = COMMITTED.lock() {
        c.retain(|(l, _)| l != label);
        c.push((
            label.to_string(),
            url.host_str().unwrap_or_default().to_string(),
        ));
    }
}

/// "" before the view's first commit, which matches no site row.
fn committed_host(label: &str) -> String {
    COMMITTED
        .lock()
        .ok()
        .and_then(|c| c.iter().find(|(l, _)| l == label).map(|(_, h)| h.clone()))
        .unwrap_or_default()
}

/// The permission handler of a view in `space`, called with the view's label. `read` gives the site list and runs at
/// each request, so a change in Settings applies to open views too (review round 2).
/// The asking frame is unknown: wry 0.57.1 implements WKUIDelegate
/// `webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:` but calls the handler with
/// the `PermissionKind` only (origin and frame dropped), so any request may be a subframe's and an allow row answers
/// Default (WebKit's own prompt), never Allow. Upgrade when wry passes the origin: give it as `requester`.
///
/// Ticket 264 (A3, A13): in an agent space a camera or microphone prompt is the owner's. `hand` pauses the agent with the reason on
/// the chip, once per page load, and answers whether it did; `Default` then leaves the answer to WebKit, never to a verb.
/// Further requests before a navigation are denied, as is anything else and every list row. Ticket 351: app/src-tauri/
/// Info.plist carries the camera and microphone usage strings, so `Default` now reaches WebKit's prompt and then
/// macOS's; without them macOS refuses capture outright. `Allow` stays unreachable while the frame is unknown.
/// How close a camera call must follow a microphone call in the same view to count as the same combined request (wry
/// makes both calls inside one WKUIDelegate callback, microseconds apart). A separate camera request that lands inside
/// it gets the owner's prompt, never a grant.
const PAIR: std::time::Duration = std::time::Duration::from_millis(250);

fn handler<R: Fn() -> view::Prefs, H: Fn(&str) -> bool>(
    space: &str,
    read: R,
    hand: H,
) -> impl Fn(&str, PermissionKind) -> PermissionResponse + use<R, H> {
    let space = space.to_string();
    // The microphone half of the last request in this space: (view label, when, handed to the owner).
    let pair: std::sync::Mutex<Option<(String, std::time::Instant, bool)>> =
        std::sync::Mutex::new(None);
    move |label, kind| {
        if space != agent::YOU {
            let what = match kind {
                PermissionKind::Camera => "camera",
                PermissionKind::Microphone => "microphone",
                _ => return PermissionResponse::Deny,
            };
            let mut last = pair.lock().unwrap_or_else(|e| e.into_inner());
            // Ticket 351 r2: wry splits one getUserMedia({audio, video}) into a microphone call and then a camera
            // call, back to back on the main thread. The camera half shares the microphone half's answer, so one
            // combined request is one prompt for owner, not a prompt plus a refusal.
            let shared = match (what, last.take()) {
                ("camera", Some((l, at, handed))) if l == label && at.elapsed() < PAIR => {
                    Some(handed)
                }
                _ => None,
            };
            let handed = shared.unwrap_or_else(|| hand(what));
            if what == "microphone" {
                *last = Some((label.to_string(), std::time::Instant::now(), handed));
            }
            return if handed {
                PermissionResponse::Default
            } else {
                PermissionResponse::Deny
            };
        }
        let kind = match kind {
            PermissionKind::Camera => "camera",
            PermissionKind::Microphone => "microphone",
            PermissionKind::Geolocation => "location",
            PermissionKind::Notifications => "notifications",
            _ => "",
        };
        match site_permission(&space, &committed_host(label), None, kind, &read()) {
            Permit::Deny => PermissionResponse::Deny,
            Permit::Allow if !kind.is_empty() => PermissionResponse::Allow,
            _ => PermissionResponse::Default, // WebKit asks the owner
        }
    }
}

/// The view's permission handler; it reads the site list from the core at each request (main thread, bounded by
/// `core_reply`'s 3 s timeouts; no core reads as an empty list, so camera and microphone are denied).
pub(super) fn permit(
    app: &AppHandle,
    space: &str,
) -> impl Fn(tauri::Webview, PermissionKind) -> PermissionResponse + Send + Sync + 'static {
    let (handle, id) = (app.clone(), space.to_string());
    let h = handler(space, view::Prefs::read, move |what| {
        let first = agent::first_prompt(&id);
        if first {
            agent::give_to_owner(&handle, &id, format!("the page asks for the {what}"));
        }
        first
    });
    move |wv, kind| h(wv.label(), kind)
}

/// Page zoom for a new view: the owner's own store only. Agent verbs post events at CSS px, page zoom 1 (`mac::Input::at`),
/// so a zoomed view an agent drives would take every click and keystroke off target.
fn zoom(space: &str, prefs: &view::Prefs) -> f64 {
    if space == agent::YOU { prefs.zoom } else { 1.0 }
}

/// The address a new-window request may offer: only one the view could load (A13, the navigation guard's own rule).
fn popup_target(url: &tauri::Url) -> Option<String> {
    view::allowed(url).is_ok().then(|| url.to_string())
}

/// Ticket 307 (A13): a `target=_blank` link or `window.open`. No window opens: the pane has one view per space, so it
/// says what the page asked for and offers it (`browser-popup`), and the agent hears it in its verb's answer. `shown`: this is
/// the view the pane shows; a parked tab's request is the agent's to hear, never an offer about a page the owner cannot see.
/// While the owner has the browser the request is his, so the agent is not told.
pub(super) fn popup(
    app: &AppHandle,
    space: &str,
    shown: bool,
) -> impl Fn(tauri::Url, NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static + use<>
{
    let (app, space) = (app.clone(), space.to_string());
    move |url, _| {
        let target = popup_target(&url);
        if let Some(t) = &target
            && !control::held(&space)
        {
            agent::note_popup(&space, t);
        }
        if shown && agent::offer_popup(&space, target.clone()) {
            let _ = app.emit(
                "browser-popup",
                serde_json::json!({"space": space, "url": target}),
            );
        }
        NewWindowResponse::Deny
    }
}

/// The URL bar's `browser-moved`, one per load event of the pane's view. `Started` is a new page, so what the old one asked
/// for is over; `Finished` is the same page, and a request made between the two stands.
pub(super) fn moved(app: &AppHandle, space: &str, p: &PageLoadPayload) {
    let finished = p.event() == PageLoadEvent::Finished;
    if !finished {
        agent::clear_offer(space);
        agent::clear_prompt(space); // committed: a new page may ask once
    }
    let _ = app.emit(
        "browser-moved",
        serde_json::json!({"space": space, "url": p.url().as_str(), "finished": finished}),
    );
}

/// Ticket 328: the owner's own tabs after the first are the spaces `you:<id>` (1 to 16 ASCII letters or digits). Each has its own
/// view (label), events and failures, but the "you" space's rules: its profile, site permissions, zoom and home page. Agent
/// spaces are core session ids (UUIDs, no ':'), so no agent verb can name one; anything else is its own space.
pub(super) fn rules_of(space: &str) -> &str {
    match space.strip_prefix("you:") {
        Some(t) if (1..=16).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric()) => {
            agent::YOU
        }
        _ => space,
    }
}

/// Ticket 997 L6 (A3): an agent space's views keep their page size and are drawn scaled into the slot; the owner's own
/// spaces (`you` and `you:<id>`) lay out at the slot's size as before.
fn scaled(space: &str) -> bool {
    rules_of(space) != agent::YOU
}

/// A1: the scale that fits a `page`-sized view into a `slot`, at most 1, down to a multiple of 1/160 so a 1280x800 page
/// draws at whole points; never 0.
fn fit((w, h): (f64, f64), (pw, ph): (f64, f64)) -> f64 {
    let l = 1f64.min(w / pw).min(h / ph);
    ((l * 160.0).floor() / 160.0).max(1.0 / 160.0)
}

/// A1 with A2: where a `page`-sized agent view draws in the slot (x, y, w, h: window logical px, top-left origin) and at what
/// scale: the fitted size at the top of the slot, centred across it. A CSS pixel (cx, cy) of the page is then at
/// (fx + cx * l, fy + cy * l) in the window, the frame's bounds being the page size (how clicks land, `mac::Input::at`).
fn frame_in((x, y, w, h): (f64, f64, f64, f64), (pw, ph): (f64, f64)) -> (f64, f64, f64, f64, f64) {
    let l = fit((w, h), (pw, ph));
    let (fw, fh) = ((pw * l).round(), (ph * l).round());
    (x + ((w - fw) / 2.0).max(0.0), y, fw, fh, l)
}

/// Shows view `v` of `space` in the slot: scaled for an agent space, at the slot's size for the owner's.
fn place(
    v: &tauri::Webview,
    space: &str,
    (x, y, w, h): (f64, f64, f64, f64),
) -> Result<(), String> {
    if scaled(space) {
        return agent::show_scaled(v, (x, y, w, h));
    }
    v.set_bounds(Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    })
    .map_err(|e| e.to_string())?;
    v.show().map_err(|e| e.to_string())
}

fn find(app: &AppHandle, space: &str) -> Result<tauri::Webview, String> {
    find_tab(app, space, None)
}

/// Ticket 328 part 2: the view of the pane's tab `tab` in `space` (`None`: tab 1, the pane's view as before).
fn find_tab(app: &AppHandle, space: &str, tab: Option<u32>) -> Result<tauri::Webview, String> {
    app.get_webview(&agent::tab_of(space, tab)?)
        .ok_or_else(|| "The browser view is not open".to_string())
}

/// The owner drives tab `tab` from the toolbar: he has the space (WP3) and that tab becomes the agent's current one (`owner_on`).
/// A tab number outside the space is refused before anything is taken.
fn drive(app: &AppHandle, space: &str, tab: Option<u32>) -> Result<tauri::Webview, String> {
    let label = agent::tab_of(space, tab)?;
    control::take(app, space, None);
    agent::owner_on(space, &label);
    app.get_webview(&label)
        .ok_or_else(|| "The browser view is not open".to_string())
}

/// Ticket 328 part 2: places an agent's later tab in the slot. Only an open tab: the pane never creates an agent's tab.
fn show_tab(
    app: &AppHandle,
    space: &str,
    tab: Option<u32>,
    slot: (f64, f64, f64, f64),
) -> Result<(), String> {
    place(&find_tab(app, space, tab)?, space, slot)
}

/// Shows the space's view in the slot (x, y, w, h in the window's logical pixels), creating it on its profile's data
/// store on first use. `picked` is the user's profile picker and counts only then (ticket 264). `url` loads only when the
/// view is new; an empty one loads the home page (ticket 255: a view the owner opens is the only place it loads). Search engine,
/// zoom and user agent are read here, so they apply to new views; the site list is read at each request (`permit`).
pub fn show(
    app: &AppHandle,
    space: &str,
    url: &str,
    (x, y, w, h): (f64, f64, f64, f64),
    picked: Option<&str>,
) -> Result<(), String> {
    if let Some(v) = app.get_webview(&view::label(space)) {
        return place(&v, space, (x, y, w, h));
    }
    // Without a store identifier (macOS < 14) the view would share the default store: refuse instead (threat model A7).
    view::store_supported()?;
    let prefs = view::Prefs::read();
    let rules = rules_of(space);
    let start = agent::start_page(url, Some(rules), &prefs)?;
    if scaled(space) {
        // A5: an agent space's tab 1 is made as the agent's own `open` makes it, at the page size, then placed.
        let v = agent::create(app, space, &view::label(space), start, picked)?;
        return place(&v, space, (x, y, w, h));
    }
    let (pos, size) = (
        LogicalPosition::new(x, y),
        LogicalSize::new(w.max(1.0), h.max(1.0)),
    );
    let window = app.get_window("main").ok_or("The main window is gone")?;
    let handle = app.clone();
    let id = space.to_string();
    let wv = agent::with_profile(rules, picked, |profile| {
        // The URL bar follows the page: one "browser-moved" event per page load.
        let mut builder = WebviewBuilder::new(view::label(space), WebviewUrl::External(start))
            .data_store_identifier(view::store_id(profile))
            .devtools(view::inspectable())
            .on_navigation(|u| view::allowed(u).is_ok())
            .on_new_window(popup(app, space, true))
            .on_permission_request(permit(app, rules))
            .on_page_load(move |wv, p| {
                committed(wv.label(), p.event(), p.url());
                moved(&handle, &id, &p);
            });
        if let Some(ua) = prefs.user_agent {
            builder = builder.user_agent(ua);
        }
        window
            .add_child(builder, pos, size)
            .map_err(|e| e.to_string())
    })?;
    let _ = wv.set_zoom(zoom(rules, &prefs)); // a page that refuses zoom keeps 100%
    agent::look(&wv, prefs.appearance);
    control::watch(&wv, space); // WP3: the owner's input on it pauses the agent
    Ok(())
}

/// The owner's address bar (ticket 255): text that is not an address searches on his engine; an empty bar in his own space goes home.
pub fn go(app: &AppHandle, space: &str, url: &str) -> Result<(), String> {
    go_in(&find(app, space)?, space, url)
}

fn go_in(wv: &tauri::Webview, space: &str, url: &str) -> Result<(), String> {
    wv.navigate(agent::start_page(
        url,
        Some(rules_of(space)),
        &view::Prefs::read(),
    )?)
    .map_err(|e| e.to_string())
}

/// Ticket 264: closes the space's views, so its history and page are gone and the next open is a new space. The cookies
/// and logins are its profile's, shared with other spaces, and stay (a whole-profile clear is `profile_clear`).
pub fn forget(app: &AppHandle, space: &str) -> Result<(), String> {
    annotate::clear(space); // a view opened after Forget starts with the picker off
    agent::close_tabs(app, space);
    if let Some(v) = app.get_webview(&view::label(space)) {
        agent::close_view(&v)?;
        if let Ok(mut c) = COMMITTED.lock() {
            c.retain(|(l, _)| *l != view::label(space));
        }
    }
    control::unwatch(space); // also when only agent tabs were open (closed above); 998 L5 round 2
    agent::retire(space); // 998 L10 round 2: its job worker ends too
    Ok(())
}

/// Deletes a profile's data store. Blocking (retries with sleeps, waits on the main thread): off the main thread, and never
/// under `profiles_lock`. WebKit refuses a store a view still uses; a store that was never created is already gone.
fn remove_store(app: &AppHandle, profile: &str) -> Result<(), String> {
    let id = view::store_id(profile);
    let stores = tauri::async_runtime::block_on(app.fetch_data_store_identifiers())
        .map_err(|e| e.to_string())?;
    if !stores.contains(&id) {
        return Ok(());
    }
    let mut last = String::new();
    for _ in 0..20 {
        match tauri::async_runtime::block_on(app.remove_data_store(id)) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!("The browser data was not removed: {last}"))
}

/// Empties one profile's store, for every space on it. Open views stay and reload signed out. Blocking.
fn profile_clear(app: &AppHandle, profile: &str) -> Result<(), String> {
    if !view::Profiles::read()?.known(profile) {
        return Err("No such browser profile".into());
    }
    let views = agent::views_on(app, profile);
    let Some((_, first)) = views.first() else {
        return remove_store(app, profile);
    };
    first.clear_all_browsing_data().map_err(|e| e.to_string())?; // the view's store is the profile's
    // ponytail: WebKit's completion is not exposed, so a fixed wait before the reloads; a late reload only shows stale pages.
    std::thread::sleep(std::time::Duration::from_millis(300));
    for (_, v) in &views {
        let _ = v.reload();
    }
    Ok(())
}

/// Removes a profile and its data. Refused while a space is open on it, and for the built-in profile. The list is written
/// first and under the lock, so no new space can pick the profile while its store goes.
fn profile_remove(app: &AppHandle, profile: &str) -> Result<(), String> {
    if profile == view::BUILT_IN {
        return Err("The built-in profile cannot be removed".into());
    }
    {
        let _held = agent::profiles_lock();
        let profiles = view::Profiles::read()?;
        if !profiles.known(profile) {
            return Err("No such browser profile".into());
        }
        if agent::spaces_on(profile) > 0 {
            return Err("This profile has open browser spaces; forget them first".into());
        }
        let patch = serde_json::json!({"features": {
            "browser.profiles": profiles.without(profile),
            "browser.space_profiles": profiles.picks_asking_again(profile),
        }});
        crate::core_call(serde_json::json!({"op": "quit_settings", "patch": patch}))
            .ok_or("The profile list could not be saved")?;
    }
    remove_store(app, profile)
}

/// Ticket 264: profile changes are commands of the main window only. There is no core request and no agent verb for them
/// (`profile_clear_refused_from_agent_remote_and_widget`), browser views have no IPC (A5), and this refuses any other webview.
fn main_window_only(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("Only the Nunchiro window can change browser profiles".into())
    }
}

/// Settings and the new-space picker: the list, each profile's open spaces, the default, and `space`'s remembered pick.
#[tauri::command]
pub async fn browser_profiles(
    app: AppHandle,
    webview: tauri::Webview,
    space: Option<String>,
) -> Result<serde_json::Value, String> {
    main_window_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = view::Profiles::read()?;
        let list: Vec<_> = p
            .list
            .iter()
            .map(|(id, name)| {
                let mut spaces: Vec<_> =
                    agent::views_on(&app, id).into_iter().map(|v| v.0).collect();
                spaces.dedup();
                serde_json::json!({"id": id, "name": name, "live": spaces.len()})
            })
            .collect();
        let picked = space.and_then(|s| p.pick_of(&s).map(str::to_string));
        Ok(serde_json::json!({"list": list, "default": p.default, "picked": picked}))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The approval sheet's confirm button in Settings; nothing else calls it (`profile_clear_needs_window_approval_click`).
#[tauri::command]
pub async fn browser_profile_clear(
    app: AppHandle,
    webview: tauri::Webview,
    profile: String,
) -> Result<(), String> {
    main_window_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || profile_clear(&app, &profile))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_profile_remove(
    app: AppHandle,
    webview: tauri::Webview,
    profile: String,
) -> Result<(), String> {
    main_window_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || profile_remove(&app, &profile))
        .await
        .map_err(|e| e.to_string())?
}

/// Ticket 264 (A3): the site this space's current page is signed in to, for the chip. Off the main thread: the cookie read
/// waits for an answer from there.
#[tauri::command]
pub async fn browser_signed_in(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<Option<String>, String> {
    crate::cli_install::main_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(wv) = find_tab(&app, &space, tab) else {
            return Ok(None);
        };
        // `nav_state`, not `Webview::url`: wry unwraps a view that has no URL yet.
        let state = agent::nav_state(&wv, &space)?;
        let Some(url) = state["url"]
            .as_str()
            .and_then(|u| tauri::Url::parse(u).ok())
        else {
            return Ok(None);
        };
        let Some(host) = url.host_str().map(str::to_string) else {
            return Ok(None); // about:blank and the like hold no cookies
        };
        let cookies = wv.cookies_for_url(url).map_err(|e| e.to_string())?;
        let pairs: Vec<_> = cookies.iter().map(|c| (c.name(), c.value())).collect();
        Ok(view::signed_in_site(&host, &pairs))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(clippy::too_many_arguments)] // the names are the IPC call's fields
#[tauri::command]
pub fn browser_show(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    profile: Option<String>,
    tab: Option<u32>,
) -> Result<(), String> {
    main_window_only(&webview)?; // it carries the profile pick
    if tab.is_some_and(|n| n != 1) {
        return show_tab(&app, &space, tab, (x, y, w, h));
    }
    show(&app, &space, &url, (x, y, w, h), profile.as_deref())
}

/// Hides the view (tab not shown, pane closed); the page stays loaded. A tab that is gone is already hidden.
#[tauri::command]
pub fn browser_hide(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    hide(&app, &space, tab)
}

/// A4: an agent space's view parks (full speed, same layout); the owner's is hidden.
fn hide(app: &AppHandle, space: &str, tab: Option<u32>) -> Result<(), String> {
    match find_tab(app, space, tab) {
        Ok(v) if scaled(space) => {
            agent::rest(space); // 998 L9: throttled once unused for a while
            agent::park(&v)
        }
        Ok(v) => v.hide().map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
pub fn browser_go(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    url: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    // WP3: the owner driving from the toolbar pauses the agent too
    go_in(&drive(&app, &space, tab)?, &space, &url)
}

pub fn back(app: &AppHandle, space: &str) -> Result<(), String> {
    find(app, space)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

pub fn reload(app: &AppHandle, space: &str) -> Result<(), String> {
    find(app, space)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_back(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    drive(&app, &space, tab)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_forward(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    drive(&app, &space, tab)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_stop(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    agent::stop(&drive(&app, &space, tab)?)
}

/// Tickets 288, 309: the space's view as the toolbar shows it, `None` while it has none. Off the main thread: it waits
/// for an answer from there. Whoever opened the view (the owner or the agent), the pane finds it here.
#[tauri::command]
pub async fn browser_nav(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<Option<serde_json::Value>, String> {
    crate::cli_install::main_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        find_tab(&app, &space, tab)
            .ok()
            .map(|wv| agent::nav_state(&wv, &space))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ticket 328 part 2: the agent's tabs in `space` for the pane's strip (`agent::tabs_state`). Window chrome only.
#[tauri::command]
pub async fn browser_tabs(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
) -> Result<serde_json::Value, String> {
    main_window_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || agent::tabs_state(&app, &space))
        .await
        .map_err(|e| e.to_string())
}

/// Ticket 997 L7: the toolbar's "Take over and open full size". The owner takes tab `tab` of the space as his click in its
/// page would; the window maximises the pane itself, from the button only (A8: never on `control::take`, which fires on
/// many events). Window chrome only: no agent verb maps here (A11).
#[tauri::command]
pub fn browser_take(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    drive(&app, &space, tab)?;
    Ok(())
}

/// Ticket 307: the owner answered the notice, so the same request later is new again (a link must not go dead after Dismiss).
#[tauri::command]
pub fn browser_popup_clear(webview: tauri::Webview, space: String) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    agent::clear_offer(&space);
    Ok(())
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    drive(&app, &space, tab)?
        .reload()
        .map_err(|e| e.to_string())
}

/// V2.5-22: switches the owner's element picker on or off in the view of the space's tab `tab` (see `annotate`).
#[tauri::command]
pub async fn browser_annotate(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
    tab: Option<u32>,
    on: bool,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || annotate::set(&app, &space, tab, on))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_forget(
    app: AppHandle,
    webview: tauri::Webview,
    space: String,
) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?;
    tauri::async_runtime::spawn_blocking(move || forget(&app, &space))
        .await
        .map_err(|e| e.to_string())?
}

/// Debug builds only: `NUNCHIRO_BROWSER_SELFTEST=<fixture base>` runs the isolation, IPC and forget checks of
/// `scripts/browser-selftest.py` against real WKWebViews, since a headless test cannot create one.
#[cfg(debug_assertions)]
pub fn selftest(app: AppHandle) {
    let Ok(base) = std::env::var("NUNCHIRO_BROWSER_SELFTEST") else {
        return;
    };
    std::thread::spawn(move || {
        let wait = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
        let rect = (0.0, 0.0, 400.0, 300.0);
        let step = |r: Result<(), String>, what: &str| {
            if let Err(e) = r {
                eprintln!("selftest {what}: {e}");
            }
        };
        while app.get_window("main").is_none() {
            wait(200);
        }
        wait(2500);
        // Ticket 264: throwaway profiles, the first one set as the default. WebKit keeps stores per bundle id, not per
        // NUNCHIRO_HOME, so this run must never open the built-in profile: that store holds the owner's real logins. If the
        // isolated core did not take them, stop here.
        let patch = serde_json::json!({"features": {"browser.profiles": {
            "default": "st-a", "list": [{"id": "st-a", "name": "A"}, {"id": "st-b", "name": "B"}],
        }}});
        crate::core_call(serde_json::json!({"op": "quit_settings", "patch": patch}));
        if !view::Profiles::read().is_ok_and(|p| p.default == "st-a" && p.known("st-b")) {
            eprintln!("selftest profiles: the test profiles were not stored");
            eprintln!("selftest done");
            return;
        }
        for p in ["st-a", "st-b"] {
            step(remove_store(&app, p), "clean start");
        }
        step(
            show(&app, "A", &format!("{base}/probe?tag=A0"), rect, None),
            "show A",
        );
        wait(1500);
        step(go(&app, "A", &format!("{base}/set?v=secret")), "set A");
        wait(1500);
        step(go(&app, "A", &format!("{base}/probe?tag=A1")), "probe A");
        wait(1500);
        // spaces_on_default_profile_share_cookies: B has no pick, so it reads A's cookie (B0).
        step(
            show(&app, "B", &format!("{base}/probe?tag=B0"), rect, None),
            "show B",
        );
        wait(1500);
        // profiles_do_not_share_cookies: C picked the other profile, so it does not (C0).
        step(
            show(
                &app,
                "C",
                &format!("{base}/probe?tag=C0"),
                rect,
                Some("st-b"),
            ),
            "show C",
        );
        wait(1500);
        // space_forget_keeps_shared_profile_data: A's view goes, the profile's cookie stays (A2).
        step(forget(&app, "A"), "forget A");
        wait(500);
        step(
            show(&app, "A", &format!("{base}/probe?tag=A2"), rect, None),
            "reopen A",
        );
        wait(1500);
        step(
            go(&app, "A", "http://127.0.0.1:7788/")
                .map(|_| eprintln!("selftest: core port NOT refused"))
                .or(Ok(())),
            "core port",
        );
        // nav_controls: two pages, back to the first, reload it (each load reports once).
        step(
            show(&app, "N", &format!("{base}/probe?tag=N1"), rect, None),
            "show N",
        );
        wait(1500);
        step(go(&app, "N", &format!("{base}/probe?tag=N2")), "go N2");
        wait(1500);
        step(back(&app, "N"), "back N");
        wait(1500);
        step(reload(&app, "N"), "reload N");
        wait(1500);
        // V2.5-41 (A18): the app's own origin never loads in the agent view, typed, by redirect or by page script.
        step(
            show(&app, "T", &format!("{base}/probe?tag=T0"), rect, None),
            "show T",
        );
        wait(3000);
        if go(&app, "T", "http://tauri.localhost/probe?tag=T1").is_ok() {
            eprintln!("selftest: own origin NOT refused");
        }
        wait(3000);
        for tag in ["T2", "T3", "T4", "T5"] {
            step(go(&app, "T", &format!("{base}/away?tag={tag}")), "away T");
            wait(3000);
        }
        // A whole-profile clear reaches every space on it (B1); `profile_clear` is what the approval sheet calls.
        step(profile_clear(&app, "st-a"), "clear profile");
        wait(1000);
        step(go(&app, "B", &format!("{base}/probe?tag=B1")), "probe B");
        wait(1500);
        for space in ["A", "B", "C", "N", "T"] {
            step(forget(&app, space), "cleanup");
        }
        wait(500);
        for p in ["st-a", "st-b"] {
            step(remove_store(&app, p), "cleanup"); // leave no test store behind
        }
        eprintln!("selftest done");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ticket 328 part 2: the strip's read is window chrome (A5: a page gets no new IPC); the pane only places a tab the
    /// agent opened (no builder in `show_tab`); a tab number outside the space is refused before the owner takes anything; every
    /// toolbar command that drives a view goes through `drive`, so the agent's current tab follows him.
    #[test]
    fn pane_tab_commands_keep_their_bounds() {
        let code: String = include_str!("mod.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .split_whitespace()
            .collect();
        let body = |f: &str| {
            code.split(f)
                .nth(1)
                .unwrap()
                .split("fn")
                .next()
                .unwrap()
                .to_string()
        };
        assert!(body("pubasyncfnbrowser_tabs(").contains("main_window_only(&webview)?"));
        assert!(!body("fnshow_tab(").contains("WebviewBuilder"));
        let drive = body("fndrive(");
        assert!(drive.find("agent::tab_of(").unwrap() < drive.find("control::take(").unwrap());
        for cmd in [
            "browser_go(",
            "browser_back(",
            "browser_forward(",
            "browser_stop(",
            "browser_reload(",
            "browser_take(",
        ] {
            let b = body(&format!("pubfn{cmd}"));
            assert!(b.contains("drive(&app,&space,tab)?"), "{cmd}");
            assert!(
                !b.contains("control::take("),
                "{cmd} takes only through drive"
            );
        }
    }

    /// Ticket 328: the owner's extra tabs take his rules; nothing else does (agent ids, near misses, an empty or long tab id).
    #[test]
    fn rules_of_maps_only_owners_tabs() {
        for t in ["you", "you:a1", "you:Z", "you:0123456789abcdef"] {
            assert_eq!(rules_of(t), agent::YOU, "{t:?}");
        }
        for t in [
            "s1",
            "you:",
            "you:a-b",
            "you:a:b",
            "you :a",
            "You:a",
            "you:0123456789abcdefg",
            "x-you:a",
            "you:é",
        ] {
            assert_eq!(rules_of(t), t, "{t:?}");
        }
    }

    fn meet_allowed() -> view::Prefs {
        view::Prefs::from_features(&serde_json::json!({"browser.site_permissions": [
            {"host": "meet.example", "kind": "camera", "decision": "allow"},
            {"host": "meet.example", "kind": "location", "decision": "deny"},
        ]}))
    }

    /// Ticket 255 (O-172, T-106): the owner's list answers in his own store: allow and deny; an unlisted camera or microphone is denied.
    #[test]
    fn site_permission_allow_applies_to_you_store_only() {
        let p = meet_allowed();
        assert_eq!(
            site_permission("you", "meet.example", Some("meet.example"), "camera", &p),
            Permit::Allow
        );
        assert_eq!(
            site_permission("you", "Meet.Example.", Some("Meet.Example."), "camera", &p),
            Permit::Allow
        );
        assert_eq!(
            site_permission("you", "meet.example", Some("meet.example"), "location", &p),
            Permit::Deny
        );
        assert_eq!(
            site_permission(
                "you",
                "meet.example",
                Some("meet.example"),
                "microphone",
                &p
            ),
            Permit::Deny
        );
        assert_eq!(
            site_permission("you", "other.example", Some("other.example"), "camera", &p),
            Permit::Deny
        );
        assert_eq!(
            site_permission("s1", "meet.example", Some("meet.example"), "camera", &p),
            Permit::Deny
        );
    }

    /// Threat model A13 (widget-check G04 failure case): the owner allows the camera for meet.example; an agent's space that
    /// navigates there is still denied, for every kind, with or without a list.
    #[test]
    fn agent_space_denies_site_permissions_even_when_allowed_for_you() {
        let p = meet_allowed();
        for space in ["s1", "session-7", "", "You", "you "] {
            for kind in view::SITE_KINDS.iter().chain(&[""]) {
                assert_eq!(
                    site_permission(space, "meet.example", Some("meet.example"), kind, &p),
                    Permit::Deny,
                    "{space:?} {kind}"
                );
                assert_eq!(
                    site_permission(
                        space,
                        "meet.example",
                        Some("meet.example"),
                        kind,
                        &view::Prefs::default()
                    ),
                    Permit::Deny
                );
            }
        }
    }

    /// Ticket 264 (A13): a camera or microphone prompt in an agent space goes to the owner through WebKit's own dialog; the agent
    /// is paused first; nothing is granted; other kinds are denied, and the owner's site list is not consulted.
    #[test]
    fn agent_permission_prompt_hands_off_and_never_grants() {
        let asked = std::cell::RefCell::new(Vec::new());
        let read = || -> view::Prefs { panic!("an agent space reads no site list") };
        let h = handler("s1", read, |what: &str| {
            asked.borrow_mut().push(what.to_string());
            true
        });
        assert!(matches!(
            h("test-agent", PermissionKind::Camera),
            PermissionResponse::Default
        ));
        assert!(matches!(
            h("test-agent", PermissionKind::Microphone),
            PermissionResponse::Default
        ));
        assert!(matches!(
            h("test-agent", PermissionKind::Geolocation),
            PermissionResponse::Deny
        ));
        assert_eq!(*asked.borrow(), ["camera", "microphone"]);
    }

    /// Review M1, ticket 997 L6 (A3): the owner's spaces (`you`, `you:<id>`) zoom and lay out at the slot's size; an agent
    /// space's view (always made by agent `create`) stays at 100% and is scaled whole, never zoomed.
    #[test]
    fn agent_views_never_zoom() {
        let p = view::Prefs::from_features(&serde_json::json!({"browser.zoom": 125}));
        for space in [agent::YOU, "you:a1", "you:Tab16charsXXXXX"] {
            assert_eq!(zoom(rules_of(space), &p), 1.25, "{space:?}");
            assert!(!scaled(space), "{space:?}");
        }
        for space in [
            "4b1f0c2e-9d3a-4f6b-8a1e-2c5d7e9f0a1b",
            "s1",
            "",
            "You",
            "you:",
            "you:a-1",
        ] {
            assert_eq!(zoom(rules_of(space), &p), 1.0, "{space:?}");
            assert!(scaled(space), "{space:?}");
        }
        assert!(
            !include_str!("agent.rs").contains("set_zoom")
                && !include_str!("agent.rs").contains("setPageZoom"),
            "agent views must not zoom: Input::at posts at page zoom 1 through the frame's scale"
        );
    }

    /// A1: a 1280x800 page fits the slot at a scale of whole 1/160 steps, so it draws at whole points; at most 1 (a large
    /// slot letterboxes the page at full size), never 0.
    #[test]
    fn fit_scales_the_page_down_to_whole_points() {
        let page = (1280.0, 800.0);
        assert_eq!(fit((420.0, 600.0), page), 0.325); // 416x260
        assert_eq!(fit((2000.0, 1500.0), page), 1.0);
        assert_eq!(fit((1280.0, 400.0), page), 0.5); // the height binds
        assert_eq!(fit((0.0, 600.0), page), 1.0 / 160.0);
        assert_eq!(fit((-5.0, -5.0), page), 1.0 / 160.0);
        for w in 1..1400 {
            let l = fit((f64::from(w), 900.0), page);
            let whole = |x: f64| (x - x.round()).abs() < 1e-9;
            assert!((1280.0 * l).round() <= f64::from(w).max(8.0), "{w}");
            assert!(whole(1280.0 * l) && whole(800.0 * l), "{w}");
        }
    }

    /// Ticket 997 (look v22 e): full size draws the page 1:1 when the slot holds 1280x800, and a CSS pixel lands where it is
    /// in the page; a smaller slot (the widget, a small window) fits it and the same pixel lands on the scaled spot.
    #[test]
    fn frame_in_is_one_to_one_at_full_size_and_fitted_in_the_widget() {
        let page = (1280.0, 800.0);
        let land = |(fx, fy, _, _, l): (f64, f64, f64, f64, f64), (cx, cy): (f64, f64)| {
            (fx + cx * l, fy + cy * l)
        };
        // Full size in a 1440x940 window: the slot under the title row and the pane's two rows is 1318x824 (web spec l7).
        let full = frame_in((61.0, 113.0, 1318.0, 824.0), page);
        assert_eq!(full, (80.0, 113.0, 1280.0, 800.0, 1.0));
        assert_eq!(land(full, (640.0, 400.0)), (720.0, 513.0));
        // A 1440x900 window leaves 1318x784: only as small as needed.
        assert_eq!(
            frame_in((61.0, 113.0, 1318.0, 784.0), page),
            (96.0, 113.0, 1248.0, 780.0, 0.975)
        );
        // The widget slot: 416x260, centred.
        let widget = frame_in((900.0, 146.0, 420.0, 600.0), page);
        assert_eq!(widget, (902.0, 146.0, 416.0, 260.0, 0.325));
        assert_eq!(land(widget, (640.0, 400.0)), (1110.0, 276.0));
    }

    /// Review M4: the owner allows the camera for meet.example; evil.example points the view at meet.example (WKWebView.URL
    /// moves, nothing commits) and asks at once. The handler reads the committed host, so evil.example gets no allow.
    #[test]
    fn permission_host_is_the_committed_page_not_the_pending_one() {
        let label = "test-permit-host";
        let evil = tauri::Url::parse("https://evil.example/").unwrap();
        let meet = tauri::Url::parse("https://meet.example/x").unwrap();
        let camera = |l: &str| {
            site_permission(
                agent::YOU,
                &committed_host(l),
                Some(&committed_host(l)),
                "camera",
                &meet_allowed(),
            )
        };
        assert_eq!(camera(label), Permit::Deny, "no commit yet");
        committed(label, PageLoadEvent::Started, &evil);
        committed(label, PageLoadEvent::Finished, &meet);
        assert_eq!(committed_host(label), "evil.example");
        assert_eq!(camera(label), Permit::Deny);
        committed(label, PageLoadEvent::Started, &meet);
        assert_eq!(camera(label), Permit::Allow);
        assert_eq!(camera("test-permit-other"), Permit::Deny, "per view");
    }

    /// Codex security review (round 2, MUST): allowed.example embeds evil.example with allow="camera"; the asking frame is
    /// evil.example, so the owner's allow for the top page is not its allow. A frame the owner denied stays denied.
    #[test]
    fn permission_is_decided_by_the_requesting_frame() {
        let p = view::Prefs::from_features(&serde_json::json!({"browser.site_permissions": [
            {"host": "allowed.example", "kind": "camera", "decision": "allow"},
            {"host": "evil.example", "kind": "camera", "decision": "deny"},
        ]}));
        let camera = |top, req| site_permission(agent::YOU, top, req, "camera", &p);
        assert_ne!(
            camera("allowed.example", Some("evil.example")),
            Permit::Allow
        );
        assert_eq!(
            camera("allowed.example", Some("evil.example")),
            Permit::Deny
        );
        assert_eq!(
            camera("allowed.example", Some("other.example")),
            Permit::Ask
        );
        assert_eq!(
            camera("evil.example", Some("allowed.example")),
            Permit::Deny
        );
        assert_eq!(
            camera("allowed.example", Some("allowed.example")),
            Permit::Allow
        );
        // The pinned wry passes no origin, so the asking frame is unknown: never an automatic allow.
        assert_eq!(camera("allowed.example", None), Permit::Ask);
    }

    /// The handler as WebKit calls it: the asking frame is unknown (wry 0.57 gives a kind only), so an allowed page gets
    /// WebKit's own prompt, not a grant; a denied page is still refused.
    #[test]
    fn handler_never_grants_without_the_asking_origin() {
        let label = "test-permit-frame";
        committed(
            label,
            PageLoadEvent::Started,
            &tauri::Url::parse("https://meet.example/").unwrap(),
        );
        for kind in [PermissionKind::Camera, PermissionKind::Microphone] {
            let allow_all = || {
                view::Prefs::from_features(&serde_json::json!({"browser.site_permissions": [
                    {"host": "meet.example", "kind": "camera", "decision": "allow"},
                    {"host": "meet.example", "kind": "microphone", "decision": "allow"},
                ]}))
            };
            assert!(matches!(
                handler(agent::YOU, allow_all, |_: &str| false)(label, kind),
                PermissionResponse::Default
            ));
        }
    }

    /// Ticket 351, the decision table (kind x setting x space) as WebKit calls the handler: off by default, an Allow or
    /// Ask row in the owner's browser hands the choice to WebKit's prompt (then macOS's), Deny refuses with no prompt;
    /// an agent space ignores every row, hands its first camera or microphone prompt to the owner and refuses the rest.
    /// No combination is a silent grant.
    #[test]
    fn media_decision_table() {
        let label = "test-permit-table";
        committed(
            label,
            PageLoadEvent::Started,
            &tauri::Url::parse("https://meet.example/").unwrap(),
        );
        let name = |r: PermissionResponse| match r {
            PermissionResponse::Allow => "allow",
            PermissionResponse::Deny => "deny",
            PermissionResponse::Default => "prompt",
        };
        for (kind, word) in [
            (PermissionKind::Camera, "camera"),
            (PermissionKind::Microphone, "microphone"),
        ] {
            for (row, you, agent_first, agent_again) in [
                (None, "deny", "prompt", "deny"),
                (Some("allow"), "prompt", "prompt", "deny"),
                (Some("ask"), "prompt", "prompt", "deny"),
                (Some("deny"), "deny", "prompt", "deny"),
            ] {
                let prefs = || {
                    view::Prefs::from_features(&serde_json::json!({"browser.site_permissions":
                        row.map(|d| vec![serde_json::json!({"host": "meet.example", "kind": word, "decision": d})])
                            .unwrap_or_default()}))
                };
                let case = format!("{word} row={row:?}");
                assert_eq!(
                    name(handler(agent::YOU, prefs, |_: &str| true)(label, kind)),
                    you,
                    "you {case}"
                );
                assert_eq!(
                    name(handler("s1", prefs, |_: &str| true)(label, kind)),
                    agent_first,
                    "agent first {case}"
                );
                assert_eq!(
                    name(handler("s1", prefs, |_: &str| false)(label, kind)),
                    agent_again,
                    "agent again {case}"
                );
            }
        }
        // A row for the other kind does not open this one.
        let mic_only = || {
            view::Prefs::from_features(&serde_json::json!({"browser.site_permissions": [
                {"host": "meet.example", "kind": "microphone", "decision": "allow"},
            ]}))
        };
        assert_eq!(
            name(handler(agent::YOU, mic_only, |_: &str| true)(
                label,
                PermissionKind::Camera
            )),
            "deny"
        );

        // Ticket 351 r2: one getUserMedia({audio, video}). wry calls microphone then camera and combines them: both
        // Allow grants, any Deny refuses, anything else prompts.
        let combined = |h: &dyn Fn(&str, PermissionKind) -> PermissionResponse, l: &str| {
            let (mic, cam) = (
                h(l, PermissionKind::Microphone),
                h(l, PermissionKind::Camera),
            );
            match (mic, cam) {
                (PermissionResponse::Allow, PermissionResponse::Allow) => "allow",
                (PermissionResponse::Deny, _) | (_, PermissionResponse::Deny) => "deny",
                _ => "prompt",
            }
        };
        // The owner's browser: a combined request needs an Allow (or Ask) row for both kinds.
        for (rows, want) in [
            (vec![], "deny"),
            (vec![("microphone", "allow")], "deny"),
            (vec![("camera", "allow")], "deny"),
            (vec![("camera", "allow"), ("microphone", "allow")], "prompt"),
            (vec![("camera", "allow"), ("microphone", "deny")], "deny"),
        ] {
            let prefs = || {
                view::Prefs::from_features(&serde_json::json!({"browser.site_permissions":
                    rows.iter().map(|(k, d)| serde_json::json!({"host": "meet.example", "kind": k, "decision": d}))
                        .collect::<Vec<_>>()}))
            };
            let h = handler(agent::YOU, prefs, |_: &str| true);
            assert_eq!(combined(&h, label), want, "you combined {rows:?}");
        }
        // An agent space, whatever the rows say: the first combined request is one prompt for the owner (hand called once,
        // for the microphone half); the next combined request on the same page load is refused.
        for row in [None, Some("allow"), Some("deny")] {
            let asked = std::cell::RefCell::new(Vec::<String>::new());
            let prefs = || {
                view::Prefs::from_features(&serde_json::json!({"browser.site_permissions":
                    row.map(|d| vec![
                        serde_json::json!({"host": "meet.example", "kind": "camera", "decision": d}),
                        serde_json::json!({"host": "meet.example", "kind": "microphone", "decision": d}),
                    ]).unwrap_or_default()}))
            };
            // `agent::first_prompt`: true once per page load.
            let h = handler("s1", prefs, |what: &str| {
                asked.borrow_mut().push(what.to_string());
                asked.borrow().len() == 1
            });
            assert_eq!(
                combined(&h, label),
                "prompt",
                "agent first combined {row:?}"
            );
            assert_eq!(combined(&h, label), "deny", "agent again combined {row:?}");
            assert_eq!(*asked.borrow(), ["microphone", "microphone"], "{row:?}");
        }
        // The camera half is shared only right after the microphone half of the same view.
        let asked = std::cell::Cell::new(0);
        let h = handler("s1", view::Prefs::default, |_: &str| {
            asked.set(asked.get() + 1);
            asked.get() == 1
        });
        assert_eq!(name(h(label, PermissionKind::Microphone)), "prompt");
        assert_eq!(
            name(h("test-permit-other-view", PermissionKind::Camera)),
            "deny"
        );
        assert_eq!(
            name(h(label, PermissionKind::Camera)),
            "deny",
            "the pair is used up"
        );
        assert_eq!(asked.get(), 3);
        let asked = std::cell::Cell::new(0);
        let h = handler("s1", view::Prefs::default, |_: &str| {
            asked.set(asked.get() + 1);
            asked.get() == 1
        });
        assert_eq!(name(h(label, PermissionKind::Microphone)), "prompt");
        std::thread::sleep(PAIR + std::time::Duration::from_millis(50));
        assert_eq!(
            name(h(label, PermissionKind::Camera)),
            "deny",
            "a later camera request is its own"
        );
        assert_eq!(asked.get(), 2);
    }

    /// Review round 2 (SHOULD): Settings switches meet.example's camera from allow to deny while the view is open; the
    /// next request is denied, without reopening the view.
    #[test]
    fn handler_reads_the_site_list_at_each_request() {
        let label = "test-permit-live";
        committed(
            label,
            PageLoadEvent::Started,
            &tauri::Url::parse("https://meet.example/").unwrap(),
        );
        let decision = std::cell::Cell::new("allow");
        let read = || {
            view::Prefs::from_features(&serde_json::json!({"browser.site_permissions": [
                {"host": "meet.example", "kind": "camera", "decision": decision.get()},
            ]}))
        };
        let h = handler(agent::YOU, read, |_: &str| false);
        assert!(!matches!(
            h(label, PermissionKind::Camera),
            PermissionResponse::Deny
        ));
        decision.set("deny");
        assert!(matches!(
            h(label, PermissionKind::Camera),
            PermissionResponse::Deny
        ));
    }

    /// Ticket 307 (A13): a page's new window never offers the app's own origin or a scheme that cannot load here.
    #[test]
    fn popup_offers_only_what_the_view_can_load() {
        let target = |u: &str| popup_target(&tauri::Url::parse(u).unwrap());
        assert_eq!(
            target("https://example.com/a?b=1").as_deref(),
            Some("https://example.com/a?b=1")
        );
        for bad in [
            "http://tauri.localhost/",
            "http://nunchiro-artifact.localhost/x",
            "http://127.0.0.1:7788/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "about:blank",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
    }

    /// address_follows_page: the page subscribes to `browser-moved` through `plugin:event|listen`, which the main window's
    /// capability must allow; the capability must stay local to the main window, so a page in the browser view gets none.
    #[test]
    fn address_follows_page() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(
            perms.contains(&"core:event:allow-listen")
                && perms.contains(&"core:event:allow-unlisten")
        );
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert!(
            cap.get("remote").is_none() && cap.get("webviews").is_none(),
            "no remote origin may use these permissions"
        );
    }
}
