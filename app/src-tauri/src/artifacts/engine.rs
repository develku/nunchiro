//! Engine-level hardening of the window's WebView (review round 2).
//!
//! CSP does not govern WebRTC (a TURN/STUN URL in `RTCPeerConnection` opens a socket to any host, with replies)
//! nor WebKit's `preconnect` and DNS prefetch. The app uses none of them, so they are switched off in the
//! WKWebView's preferences. The scheme refuses to serve artifacts until [`Engine::harden`] reports success:
//! if a WebKit update renames a switch, artifacts stop loading instead of loading unprotected. Ticket 351 r2: the
//! media-devices switch is required as well as the peer-connection one (`required`).
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct Engine(AtomicBool);

impl Engine {
    /// A new webview exists and is not yet hardened.
    pub fn pending(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn hardened(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `webview` is the platform handle from `with_webview` (a `WKWebView*` on macOS).
    pub fn harden(&self, webview: *mut std::ffi::c_void) {
        match disable(webview) {
            Ok(done) => {
                eprintln!("nunchiro: engine hardened: {}", done.join(", "));
                self.0.store(true, Ordering::SeqCst);
            }
            Err(e) => eprintln!("nunchiro: artifacts disabled, cannot harden the web engine: {e}"),
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn disable(_webview: *mut std::ffi::c_void) -> Result<Vec<String>, String> {
    Err("only the macOS WKWebView is supported".into())
}

#[cfg(target_os = "macos")]
fn disable(webview: *mut std::ffi::c_void) -> Result<Vec<String>, String> {
    use std::ffi::{CStr, CString, c_char, c_void};
    type Id = *mut c_void;
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
    }
    // Raw runtime calls: the app has no Objective-C binding crate and this needs five selectors.
    unsafe fn sel(name: &str) -> Id {
        let c = CString::new(name).unwrap();
        unsafe { sel_registerName(c.as_ptr()) }
    }
    unsafe fn get(obj: Id, name: &str) -> Id {
        let f: unsafe extern "C" fn(Id, Id) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(obj, sel(name)) }
    }
    unsafe fn responds(obj: Id, name: &str) -> bool {
        let f: unsafe extern "C" fn(Id, Id, Id) -> bool =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(obj, sel("respondsToSelector:"), sel(name)) }
    }
    unsafe fn set_bool(obj: Id, name: &str, v: bool) {
        let f: unsafe extern "C" fn(Id, Id, bool) =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(obj, sel(name), v) }
    }
    unsafe fn text(s: Id) -> String {
        if s.is_null() {
            return String::new();
        }
        let f: unsafe extern "C" fn(Id, Id) -> *const c_char =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        let p = unsafe { f(s, sel("UTF8String")) };
        if p.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
        }
    }
    if webview.is_null() {
        return Err("no WKWebView".into());
    }
    let mut done = Vec::new();
    unsafe {
        let prefs = get(get(webview, "configuration"), "preferences");
        if prefs.is_null() {
            return Err("no WKPreferences".into());
        }
        // Private switches (WKPreferencesPrivate.h); each is checked, none is assumed.
        for name in [
            "_setPeerConnectionEnabled:",
            "_setMediaDevicesEnabled:",
            "_setDNSPrefetchingEnabled:",
        ] {
            if responds(prefs, name) {
                set_bool(prefs, name, false);
                done.push(
                    name.trim_start_matches("_set")
                        .trim_end_matches(':')
                        .to_string(),
                );
            }
        }
        // Runtime feature flags: every WebRTC and preconnect flag the running WebKit lists.
        let class = objc_getClass(c"WKPreferences".as_ptr());
        if !class.is_null()
            && responds(class, "_features")
            && responds(prefs, "_setEnabled:forFeature:")
        {
            let list = get(class, "_features");
            let count: usize = {
                let f: unsafe extern "C" fn(Id, Id) -> usize =
                    std::mem::transmute(objc_msgSend as *const ());
                f(list, sel("count"))
            };
            for i in 0..count {
                let at: unsafe extern "C" fn(Id, Id, usize) -> Id =
                    std::mem::transmute(objc_msgSend as *const ());
                let feature = at(list, sel("objectAtIndex:"), i);
                let key = text(get(feature, "key"));
                let lower = key.to_ascii_lowercase();
                if !lower.contains("disabled")
                    && (lower.contains("peerconnection")
                        || lower.contains("webrtc")
                        || lower.contains("preconnect")
                        || lower.contains("mediadevices"))
                {
                    let set: unsafe extern "C" fn(Id, Id, bool, Id) =
                        std::mem::transmute(objc_msgSend as *const ());
                    set(prefs, sel("_setEnabled:forFeature:"), false, feature);
                    done.push(format!("feature {key}"));
                }
            }
        }
    }
    required(done)
}

/// Fail closed: hardened only when a peer-connection switch and (ticket 351 r2) a media-devices switch were both turned
/// off. With the camera and microphone usage strings in Info.plist, macOS no longer refuses capture for the window, so
/// `navigator.mediaDevices` must be gone too, on top of the main window's deny-all permission handler.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn required(done: Vec<String>) -> Result<Vec<String>, String> {
    let has = |what: &str| {
        done.iter()
            .any(|d| d.to_ascii_lowercase().replace(' ', "").contains(what))
    };
    if !has("peerconnection") {
        Err("no peer-connection switch found in WKPreferences".into())
    } else if !has("mediadevices") {
        Err("no media-devices switch found in WKPreferences".into())
    } else {
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::required;

    /// Ticket 351 r2 (security, must): the engine counts as hardened only with both switches off; a WebKit that stops
    /// answering `_setMediaDevicesEnabled:` (and lists no media-devices feature) leaves artifacts unserved.
    #[test]
    fn hardening_requires_peer_connection_and_media_devices() {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(required(v(&["PeerConnectionEnabled", "MediaDevicesEnabled"])).is_ok());
        assert!(
            required(v(&[
                "feature WebRTCPeerConnection",
                "feature MediaDevicesEnabled"
            ]))
            .is_ok()
        );
        assert_eq!(
            required(v(&["PeerConnectionEnabled", "DNSPrefetchingEnabled"])).unwrap_err(),
            "no media-devices switch found in WKPreferences"
        );
        assert_eq!(
            required(v(&["MediaDevicesEnabled"])).unwrap_err(),
            "no peer-connection switch found in WKPreferences"
        );
        assert!(required(Vec::new()).is_err());
    }
}
