//! Ticket 535: the app's own window keys while focus is inside a browser page. A WKWebView child that has the key focus
//! takes every key, so without this ⌘K, ⇧⌘], the prefix and lane 328's tab keys did nothing in a page (Safari and Orca keep
//! them; Orca forwards a fixed set of app actions from Electron's native `before-input-event`,
//! src/main/browser/browser-guest-shortcut-forwarding.ts:24-25). Here the control monitor (`control.rs`, an AppKit local
//! event monitor) asks `forward` for each key-down aimed at a browser view; for a yes it makes the window's own page view
//! the key view and lets the same native event go on, so the window's global key handler gets a real keydown. Page
//! JavaScript never reaches this path (threat model A11).
use std::{collections::HashMap, sync::Mutex};

/// The window-level commands whose keys leave a page (review r2, owner decision 2026-11-13: an allow-list, as Orca's).
/// Every other command's key stays with the page, so a page keeps ⌘B, ⌘/, ⌘D, ⌘I, ⌘U and the like. Undo for the ⌘K
/// trade-off (web apps use ⌘K for "insert link" or search): remove `palette.open` here.
const WINDOW_COMMANDS: &[&str] = &[
    "palette.open",
    "settings.open",
    "session.next",
    "session.prev",
    "session.jump.1",
    "session.jump.2",
    "session.jump.3",
    "session.jump.4",
    "session.jump.5",
    "session.jump.6",
    "session.jump.7",
    "session.jump.8",
    "session.jump.9",
    // Lane 328's browser tab commands: after the prefix by default, forwarded when the user binds a direct chord.
    "browser.tab.next",
    "browser.tab.prev",
    "browser.tab.close",
    "browser.tab.new",
];
/// At most this many chords per command id are read, each at most `CHORD_BYTES` long: `forward` scans them on the main
/// thread for every key-down in a browser view, so a padded keymap must not slow typing.
const PER_ID: usize = 8;
const CHORD_BYTES: usize = 64;
/// The prefix chord that stays with the page even when it is a prefix: ⌃Space is autocomplete in web editors.
const PAGE_PREFIX: &[&str] = &["Control+Space"];

/// The chords `forward` gives the window, resolved from the window's merged keymap by command id (`browser_keys`), in
/// `chordOf` form (`Control+Alt+Shift+Meta+Code`). Empty until the window sends its keymap, so nothing is forwarded before.
#[derive(Default)]
pub struct Bound {
    pub direct: Vec<String>,
    pub prefix: Vec<String>,
}

impl Bound {
    /// The allow-listed commands' own chords (not their keys after the prefix) and the prefix chords but ⌃Space. A rebound
    /// command brings its new chord; its old chord is nobody's here, so it stays with the page.
    pub fn from_keymap(keymap: &HashMap<String, Vec<String>>) -> Bound {
        let chords = |id: &str| {
            keymap
                .get(id)
                .into_iter()
                .flatten()
                .filter(|c| c.len() <= CHORD_BYTES)
                .take(PER_ID)
        };
        Bound {
            direct: WINDOW_COMMANDS
                .iter()
                .flat_map(|id| chords(id))
                .filter(|c| !c.starts_with("prefix "))
                .cloned()
                .collect(),
            prefix: chords("prefix")
                .filter(|c| !PAGE_PREFIX.contains(&c.as_str()))
                .cloned()
                .collect(),
        }
    }
}

static BOUND: Mutex<Bound> = Mutex::new(Bound {
    direct: Vec::new(),
    prefix: Vec::new(),
});

/// Keys that move or act inside a page; they stay with it whatever the modifiers (⌘← is line start, ⌘↵ submits).
const PAGE_BASE: &[&str] = &[
    "Tab",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Enter",
    "NumpadEnter",
    "Escape",
];
/// The page's editing and find chords: kept even when the user binds an allow-listed command to one.
const PAGE_CHORDS: &[&str] = &[
    "Meta+KeyA",
    "Meta+KeyC",
    "Meta+KeyV",
    "Meta+KeyX",
    "Meta+KeyZ",
    "Shift+Meta+KeyZ",
    "Meta+KeyF",
];
/// The letters macOS text fields take with ⌃ (Cocoa's Emacs keys: ⌃A line start, ⌃E end, ⌃K kill, ⌃O open line...), with
/// or without ⇧. A ⌃ chord on one of them without ⌘ stays with the page.
const FIELD_CTRL: &[&str] = &[
    "KeyA", "KeyB", "KeyD", "KeyE", "KeyF", "KeyH", "KeyK", "KeyL", "KeyN", "KeyO", "KeyP", "KeyT",
    "KeyV", "KeyY",
];

/// The one rule. Forward a key-down to the window only when it is
/// - one of the user's prefix chords but ⌃Space (the window then holds the key focus, so the key after it, lane 328's
///   browser tab keys included, goes there too), or
/// - a ⌘ or ⌃ chord of an allow-listed window command (`WINDOW_COMMANDS`), unless it is a page key above.
///
/// Keep everything else: plain typing, Shift or Option keys, Tab, arrows, Enter, Escape, every other command's chord, and
/// every key while the page composes (IME) or has a password field focused (`guarded`).
pub fn forward(chord: &str, bound: &Bound, guarded: bool) -> bool {
    if guarded {
        return false;
    }
    if bound.prefix.iter().any(|p| p == chord) {
        return true;
    }
    let base = chord.rsplit('+').next().unwrap_or(chord);
    let meta = chord.contains("Meta+");
    (meta || chord.contains("Control+"))
        && !(!meta && FIELD_CTRL.contains(&base))
        && !PAGE_BASE.contains(&base)
        && !PAGE_CHORDS.contains(&chord)
        && bound.direct.iter().any(|d| d == chord)
}

pub fn forwards(chord: &str, guarded: bool) -> bool {
    forward(
        chord,
        &BOUND.lock().unwrap_or_else(|e| e.into_inner()),
        guarded,
    )
}

/// The main window's merged keymap (command id -> bindings), sent on every change. Window chrome only: a browser page has
/// no Tauri capability and the label check refuses every other webview. Only the allow-listed ids are read.
#[tauri::command]
pub fn browser_keys(
    webview: tauri::Webview,
    keymap: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the Nunchiro window sends its keys".into());
    }
    *BOUND.lock().unwrap_or_else(|e| e.into_inner()) = Bound::from_keymap(&keymap);
    Ok(())
}

/// The browser view a forwarded key came from (its address), so the window can give the focus back (`browser_refocus`).
/// Only ever compared with live views, never dereferenced.
static FROM: Mutex<Option<usize>> = Mutex::new(None);

pub fn note_from(view: Option<usize>) {
    *FROM.lock().unwrap_or_else(|e| e.into_inner()) = view;
}

/// The window's answer after a forwarded key: `back` when what it opened closed without acting (Esc on the palette or on
/// the armed prefix), so the page gets the key focus again; otherwise the note is dropped. Main window only.
#[tauri::command]
pub fn browser_refocus(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    back: bool,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the Nunchiro window moves the key focus".into());
    }
    let from = FROM.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let (true, Some(view)) = (back, from) {
        let _ = app.run_on_main_thread(move || super::control::refocus(view));
    }
    Ok(())
}

/// Picks the window's own page view among a window's views in subview order (address, is a WKWebView): the first web view
/// that is not a registered browser view. Tauri builds the window's page first; browser views are added after it.
pub fn page_view(views: &[(usize, bool)], browser: impl Fn(usize) -> bool) -> Option<usize> {
    views
        .iter()
        .find(|(at, web)| *web && !browser(*at))
        .map(|(at, _)| *at)
}

/// A key-down as the window's `chordOf` writes it, from AppKit's virtual key code and modifier flags; `None` for a key the
/// window binds nothing to by code (a modifier alone, media keys).
pub fn chord(key_code: u16, flags: usize) -> Option<String> {
    let code = code(key_code)?;
    let mods = [
        (1 << 18, "Control"),
        (1 << 19, "Alt"),
        (1 << 17, "Shift"),
        (1 << 20, "Meta"),
    ];
    let mut parts: Vec<&str> = mods
        .iter()
        .filter(|(bit, _)| flags & bit != 0)
        .map(|(_, name)| *name)
        .collect();
    parts.push(code);
    Some(parts.join("+"))
}

/// AppKit virtual key codes (Events.h, ANSI layout positions) to `KeyboardEvent.code`: both name the physical key.
#[rustfmt::skip] // one table, read across
fn code(key_code: u16) -> Option<&'static str> {
    Some(match key_code {
        0 => "KeyA", 1 => "KeyS", 2 => "KeyD", 3 => "KeyF", 4 => "KeyH", 5 => "KeyG", 6 => "KeyZ", 7 => "KeyX",
        8 => "KeyC", 9 => "KeyV", 10 => "IntlBackslash", 11 => "KeyB", 12 => "KeyQ", 13 => "KeyW", 14 => "KeyE",
        15 => "KeyR", 16 => "KeyY", 17 => "KeyT", 18 => "Digit1", 19 => "Digit2", 20 => "Digit3", 21 => "Digit4",
        22 => "Digit6", 23 => "Digit5", 24 => "Equal", 25 => "Digit9", 26 => "Digit7", 27 => "Minus", 28 => "Digit8",
        29 => "Digit0", 30 => "BracketRight", 31 => "KeyO", 32 => "KeyU", 33 => "BracketLeft", 34 => "KeyI",
        35 => "KeyP", 36 => "Enter", 37 => "KeyL", 38 => "KeyJ", 39 => "Quote", 40 => "KeyK", 41 => "Semicolon",
        42 => "Backslash", 43 => "Comma", 44 => "Slash", 45 => "KeyN", 46 => "KeyM", 47 => "Period", 48 => "Tab",
        49 => "Space", 50 => "Backquote", 51 => "Backspace", 53 => "Escape", 76 => "NumpadEnter", 96 => "F5",
        97 => "F6", 98 => "F7", 99 => "F3", 100 => "F8", 101 => "F9", 103 => "F11", 109 => "F10", 111 => "F12",
        115 => "Home", 116 => "PageUp", 117 => "Delete", 118 => "F4", 119 => "End", 120 => "F2", 121 => "PageDown",
        122 => "F1", 123 => "ArrowLeft", 124 => "ArrowRight", 125 => "ArrowDown", 126 => "ArrowUp",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window's default keymap, as far as these tests need it (web/src/keys.ts DEFAULT_BINDINGS).
    fn defaults() -> HashMap<String, Vec<String>> {
        let mut m: HashMap<String, Vec<String>> = [
            ("prefix", vec!["Control+Period", "Control+Space"]),
            ("palette.open", vec!["Meta+KeyK", "Shift+Meta+KeyP"]),
            ("settings.open", vec!["Meta+Comma"]),
            (
                "session.next",
                vec!["Shift+Meta+BracketRight", "prefix KeyN"],
            ),
            (
                "session.prev",
                vec!["Shift+Meta+BracketLeft", "prefix KeyP"],
            ),
            ("sidebar.left.toggle", vec!["Meta+KeyB", "prefix KeyB"]),
            ("keys.help", vec!["prefix Shift+Slash", "Meta+Slash"]),
            ("split.right", vec!["Meta+KeyD", "prefix Shift+Digit5"]),
            ("tab.close", vec!["Meta+KeyW"]),
            ("session.new", vec!["Meta+KeyT", "prefix KeyC"]),
            ("chat.cycleView", vec!["Control+KeyO"]),
            ("composer.backgroundSend", vec!["Meta+Enter"]),
            ("session.new.terminal", vec!["Control+Shift+Backquote"]),
            ("browser.tab.next", vec!["prefix Shift+BracketRight"]),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.into_iter().map(String::from).collect()))
        .collect();
        for n in 1..=9 {
            m.insert(
                format!("session.jump.{n}"),
                vec![format!("Meta+Digit{n}"), format!("prefix Digit{n}")],
            );
        }
        m
    }

    #[test]
    fn each_window_command_forwards() {
        let b = Bound::from_keymap(&defaults());
        let mut window = vec![
            "Meta+KeyK",
            "Shift+Meta+KeyP",
            "Meta+Comma",
            "Shift+Meta+BracketRight",
            "Shift+Meta+BracketLeft",
            "Control+Period",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        window.extend((1..=9).map(|n| format!("Meta+Digit{n}")));
        for c in &window {
            assert!(forward(c, &b, false), "{c} is a window command's key");
        }
    }

    #[test]
    fn every_other_key_stays_with_the_page() {
        let b = Bound::from_keymap(&defaults());
        // Bound to other commands, but a page's editor keys: bold, comment, next occurrence, italic, underline,
        // autocomplete; and the rest of the app's chords (⌘W, ⌘T, ⌃O, ⌘↵, ⌃⇧`).
        for c in [
            "Meta+KeyB",
            "Meta+Slash",
            "Meta+KeyD",
            "Meta+KeyI",
            "Meta+KeyU",
            "Control+Space",
            "Meta+KeyW",
            "Meta+KeyT",
            "Control+KeyO",
            "Meta+Enter",
            "Control+Shift+Backquote",
        ] {
            assert!(!forward(c, &b, false), "{c} stays with the page");
        }
        // Keys after the prefix are never chords of their own (lane 328's tab keys arrive after a forwarded ⌃.).
        assert!(!forward("Shift+BracketRight", &b, false));
        assert!(!forward("KeyN", &b, false));
        // Plain typing, Tab, Enter, Escape, arrows.
        for c in [
            "KeyK",
            "Shift+KeyK",
            "Alt+KeyK",
            "Tab",
            "Enter",
            "Escape",
            "ArrowUp",
        ] {
            assert!(!forward(c, &b, false), "{c} stays with the page");
        }
        // Before the window sends its keymap nothing is forwarded.
        assert!(!forward("Meta+KeyK", &Bound::default(), false));
    }

    #[test]
    fn a_rebound_window_key_forwards_and_its_old_chord_stays() {
        let mut m = defaults();
        m.insert("palette.open".into(), vec!["Meta+KeyE".into()]);
        m.insert("prefix".into(), vec!["Control+KeyB".into()]);
        let b = Bound::from_keymap(&m);
        assert!(forward("Meta+KeyE", &b, false));
        assert!(!forward("Meta+KeyK", &b, false));
        assert!(forward("Control+KeyB", &b, false)); // the user's prefix, though ⌃B is a field key
        assert!(!forward("Control+Period", &b, false));
        // A window command rebound onto a page key does not take it: ⌘C stays copy.
        m.insert(
            "palette.open".into(),
            vec!["Meta+KeyC".into(), "Alt+Meta+ArrowLeft".into()],
        );
        let b = Bound::from_keymap(&m);
        assert!(!forward("Meta+KeyC", &b, false));
        assert!(!forward("Alt+Meta+ArrowLeft", &b, false));
    }

    #[test]
    fn a_browser_tab_command_on_a_direct_chord_forwards() {
        let mut m = defaults();
        assert!(!forward(
            "Alt+Meta+BracketRight",
            &Bound::from_keymap(&m),
            false
        ));
        m.insert(
            "browser.tab.next".into(),
            vec![
                "Alt+Meta+BracketRight".into(),
                "prefix Shift+BracketRight".into(),
            ],
        );
        assert!(forward(
            "Alt+Meta+BracketRight",
            &Bound::from_keymap(&m),
            false
        ));
    }

    #[test]
    fn a_padded_keymap_is_cut() {
        let mut m = defaults();
        let padded: Vec<String> = (0..10_000).map(|n| format!("Meta+Pad{n}")).collect();
        m.insert("palette.open".into(), padded);
        m.insert(
            "prefix".into(),
            vec!["Control+".to_string() + &"X".repeat(100)],
        );
        let b = Bound::from_keymap(&m);
        assert!(b.direct.len() <= PER_ID * WINDOW_COMMANDS.len());
        assert!(forward("Meta+Pad0", &b, false));
        assert!(!forward("Meta+Pad9999", &b, false));
        assert!(b.prefix.is_empty()); // a chord over 64 bytes is dropped
    }

    #[test]
    fn a_composing_or_password_field_keeps_every_key() {
        let b = Bound::from_keymap(&defaults());
        assert!(forward("Meta+KeyK", &b, false));
        assert!(!forward("Meta+KeyK", &b, true));
        assert!(!forward("Control+Period", &b, true));
    }

    #[test]
    fn page_view_is_the_first_unregistered_web_view() {
        // Subview order: a non-web view, the window's page, two browser views.
        let views = [(1, false), (2, true), (3, true), (4, true)];
        assert_eq!(page_view(&views, |at| at == 3 || at == 4), Some(2));
        // A browser view listed first is skipped; with only browser views there is no page.
        assert_eq!(page_view(&[(3, true), (2, true)], |at| at == 3), Some(2));
        assert_eq!(page_view(&[(3, true)], |at| at == 3), None);
        assert_eq!(page_view(&[], |_| false), None);
    }

    #[test]
    fn chord_matches_the_window_form() {
        let (shift, ctrl, alt, cmd) = (1 << 17, 1 << 18, 1 << 19, 1 << 20);
        assert_eq!(chord(40, cmd).as_deref(), Some("Meta+KeyK"));
        assert_eq!(
            chord(30, cmd | shift).as_deref(),
            Some("Shift+Meta+BracketRight")
        );
        assert_eq!(chord(47, ctrl).as_deref(), Some("Control+Period"));
        assert_eq!(chord(49, ctrl).as_deref(), Some("Control+Space"));
        assert_eq!(
            chord(123, ctrl | alt | shift | cmd).as_deref(),
            Some("Control+Alt+Shift+Meta+ArrowLeft")
        );
        assert_eq!(chord(18, 0).as_deref(), Some("Digit1"));
        assert_eq!(chord(55, cmd), None); // the ⌘ key alone
    }

    #[test]
    fn key_codes_name_distinct_keys() {
        let all: Vec<_> = (0..128).filter_map(code).collect();
        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(all.len(), sorted.len());
        for n in 0..10 {
            assert!(all.contains(&format!("Digit{n}").as_str()));
        }
        for l in 'A'..='Z' {
            assert!(all.contains(&format!("Key{l}").as_str()));
        }
    }
}
