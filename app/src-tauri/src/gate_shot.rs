//! Ticket 464 follow-up (gate-app-boot-ssh): in a gate run only, the window's page shoots itself.
//!
//! `scripts/gate-app-boot.sh` must see that the page painted, and over ssh it cannot shoot the window (`screencapture`
//! needs a Screen Recording grant that an ssh login never has). WKWebView's `takeSnapshotWithConfiguration:` renders
//! what the page painted from inside the app, with no grant, so a gate run writes that picture to
//! `<NUNCHIRO_HOME>/gate-shot.png` once a second and the stage checks it for blank. `start` is called only when
//! `gate_run()` is true, which an owner build never is (its compiled-in identifier is the owner's).

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The picture's name in the gate run's temp home (`scripts/gate-app-boot.sh` reads this name).
pub const SHOT: &str = "gate-shot.png";
/// Gate-app-boot-front: one line per time a gate run became the active app, in its temp home. The stage fails when
/// this file exists: the run took the owner's front (and its quit would hand the front to another app, Finder).
pub const ACTIVE: &str = "gate-active.log";
/// How long a gate run keeps shooting: past the stage's longest wait, then the thread ends.
const SHOTS: u32 = 600;

/// The red check of the stage: with `NUNCHIRO_GATE_BLANK=1` a gate run hides its page, so the picture is blank.
fn blank_requested(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| v == "1")
}

/// Where the picture goes, beside the core socket in the gate run's own home.
fn shot_path(home: &Path) -> PathBuf {
    home.join(SHOT)
}

/// Where a gate run records that it became active.
fn active_path(home: &Path) -> PathBuf {
    home.join(ACTIVE)
}

/// Gate-app-boot-front: records every `NSApplicationDidBecomeActiveNotification` of a gate run in its home. Call on
/// the main thread before the event loop runs, so an activation at launch is seen too. Only for a gate run.
pub fn watch_active(home: &Path) {
    #[cfg(target_os = "macos")]
    mac::watch_active(active_path(home));
    #[cfg(not(target_os = "macos"))]
    let _ = active_path(home);
}

/// Gate-app-boot-front: a gate run's window goes behind every other window, so it never covers the person's front
/// window; the page still paints for its picture. Only for a gate run.
pub fn behind(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ptr) = w.ns_window() {
                // SAFETY: Tauri hands out the live NSWindow of `w`, used here on the main thread.
                unsafe { mac::order_back(ptr.cast()) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Shoots the "main" page once a second for `SHOTS` seconds. Call only for a gate run.
pub fn start(app: &AppHandle, home: PathBuf) {
    let blank = blank_requested(std::env::var_os("NUNCHIRO_GATE_BLANK").as_deref());
    let app = app.clone();
    let path = shot_path(&home);
    std::thread::spawn(move || {
        for _ in 0..SHOTS {
            std::thread::sleep(Duration::from_secs(1));
            let Some(page) = app.get_webview_window("main") else {
                continue;
            };
            if blank {
                let _ = page.eval("document.documentElement.style.visibility = 'hidden';");
            }
            let path = path.clone();
            let _ = page.with_webview(move |wv| {
                #[cfg(target_os = "macos")]
                // SAFETY: `with_webview` runs this on the main thread with the live WKWebView.
                unsafe {
                    mac::snapshot(wv.inner().cast(), path)
                };
                #[cfg(not(target_os = "macos"))]
                let _ = (wv, path);
            });
        }
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::PathBuf;

    use objc2::{class, msg_send, runtime::AnyObject};

    /// `NSBitmapImageFileTypePNG`.
    const PNG: usize = 4;

    /// `orderBack:`, which never activates the app or makes the window key.
    /// # Safety
    /// `window` is a live NSWindow and this runs on the main thread.
    pub unsafe fn order_back(window: *mut AnyObject) {
        unsafe {
            let _: () = msg_send![window, orderBack: std::ptr::null_mut::<AnyObject>()];
        }
    }

    /// Appends `active <unix seconds>` to `path` at each activation. The observer lives as long as the app.
    pub fn watch_active(path: PathBuf) {
        let note = move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            use std::io::Write;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64());
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = writeln!(f, "active {now:.2}");
            }
        };
        let block = block2::RcBlock::new(note);
        let name = objc2_foundation::NSString::from_str("NSApplicationDidBecomeActiveNotification");
        let center = objc2_foundation::NSNotificationCenter::defaultCenter();
        // SAFETY: a plain observer on the default center; the block only writes a file.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(&name), None, None, &block)
        };
        std::mem::forget(token);
    }

    /// `takeSnapshotWithConfiguration:nil` (the visible page), then the NSImage as PNG to `path`, written beside it and
    /// renamed so the stage never reads half a file.
    /// # Safety
    /// `wk` is a live WKWebView and this runs on the main thread.
    pub unsafe fn snapshot(wk: *mut AnyObject, path: PathBuf) {
        let done = block2::RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            if image.is_null() || !error.is_null() {
                return;
            }
            // SAFETY: WebKit hands a live NSImage to the completion on the main thread.
            let png = unsafe { png(image) };
            if let Some(png) = png {
                let tmp = path.with_extension("png.tmp");
                if std::fs::write(&tmp, png).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
        });
        unsafe {
            let _: () = msg_send![wk, takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(), completionHandler: &*done];
        }
    }

    /// # Safety
    /// `image` is a live NSImage.
    unsafe fn png(image: *mut AnyObject) -> Option<Vec<u8>> {
        unsafe {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return None;
            }
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            if rep.is_null() {
                return None;
            }
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let data: *mut AnyObject =
                msg_send![rep, representationUsingType: PNG, properties: props];
            if data.is_null() {
                return None;
            }
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if bytes.is_null() || len == 0 {
                return None;
            }
            Some(std::slice::from_raw_parts(bytes, len).to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_only_for_the_exact_value() {
        assert!(blank_requested(Some(std::ffi::OsStr::new("1"))));
        assert!(!blank_requested(None));
        assert!(!blank_requested(Some(std::ffi::OsStr::new(""))));
        assert!(!blank_requested(Some(std::ffi::OsStr::new("yes"))));
    }

    #[test]
    fn shot_lies_in_the_run_home() {
        let home = Path::new("/w/.scratch/gAbc123");
        assert_eq!(shot_path(home), home.join("gate-shot.png"));
    }
}
