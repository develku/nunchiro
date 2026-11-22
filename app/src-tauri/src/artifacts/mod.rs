//! Artifact-only custom scheme `nunchiro-artifact` (spec v1b B2 Sandbox).
//!
//! `serve_html` and `with_bootstrap`/`tag_end` are lifted from MonoCode `src-tauri/src/artifacts.rs`
//! (commit 26465c6, MIT, Copyright (c) 2026 Nick); the full notice is in THIRD_PARTY_NOTICES.md.
//! MonoCode's CSP (it allows `https:` everywhere) and its SQLite/`invoke()` data path are not lifted.
//!
//! Content seam: whoever owns artifact bytes (06 detection, 09 viewer, both reading through the core)
//! puts a [`Content`] into Tauri state. The scheme resolves `<scheme>://localhost/<id>` through it and
//! never touches a filesystem path. `Artifact::hash` is any string that changes when the bytes change.
//!
//! Network grant: the window calls the `artifact_grant` command with `(id, hash)`; the CSP is widened
//! only while the resolved content still has that hash. The grant is state in the app, never in the
//! URL, so a page that navigates itself cannot widen its own policy. See [`grants`] for the stored file.
//!
//! Outside CSP: WebRTC and WebKit preconnect/DNS prefetch open sockets that no policy governs, so [`Engine`]
//! switches them off in the WKWebView and `serve` refuses everything until that succeeded. Known limit: CSP cannot
//! exclude loopback from `https:`, so after a grant a page can open a TLS socket to a loopback port (the core speaks
//! plain HTTP and never parses it); `http:` and `ws:` stay out of the granted policy for that reason.
//!
//! MonoCode licence (applies to the lifted functions):
//!
//! MIT License. Copyright (c) 2026 Nick. Permission is hereby granted, free of charge, to any person
//! obtaining a copy of this software and associated documentation files (the "Software"), to deal in the
//! Software without restriction, including without limitation the rights to use, copy, modify, merge,
//! publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//! Software is furnished to do so, subject to the following conditions: The above copyright notice and
//! this permission notice shall be included in all copies or substantial portions of the Software.
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
//! NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
//! WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//! SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
pub mod core_content; // v1b-09
mod engine;
mod grants;
pub mod libs; // v2-10c
pub mod widget_page; // v1b-22

pub use core_content::{CoreContent, html_of}; // v1b-09
pub use engine::Engine;
pub use grants::Grants;
pub use libs::Libs; // v2-10c

/// Policy strings are plain files so the window specs serve fixtures with exactly this text.
pub const CSP_DEFAULT: &str = include_str!("csp-default.txt");
pub const CSP_NETWORK: &str = include_str!("csp-network.txt");
pub const BOOTSTRAP: &str = include_str!("bootstrap.js");
/// v1b-23: a web widget page's bridge key, run before any of its code (`first`).
pub const BRIDGE_KEY: &str = include_str!("bridge-key.js");
pub const SCHEME: &str = "nunchiro-artifact";

pub struct Artifact {
    pub bytes: Vec<u8>,
    pub hash: String,
    /// v1b-22: a web widget page's own policy (`widget_page::csp`); `None` for artifacts (default or granted).
    pub csp: Option<String>,
}

pub trait Content: Send + Sync {
    fn get(&self, id: &str) -> Option<Artifact>;
}

/// The default until a consumer manages its own: nothing resolves, every request is a 404.
#[cfg(test)] // v1b-09: the app now manages `CoreContent`; this stays as the tests' empty resolver
pub struct NoContent;
#[cfg(test)] // v1b-09
impl Content for NoContent {
    fn get(&self, _id: &str) -> Option<Artifact> {
        None
    }
}

/// WKWebView asks the navigation handler about frame loads too, so the window must let its own frames in.
/// Nothing else is allowed through here, and the token still goes only to `own_origin` pages.
pub fn is_artifact_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        SCHEME => url.host_str() == Some("localhost"),
        "http" => url.host_str() == Some("nunchiro-artifact.localhost") && url.port().is_none(),
        _ => false,
    }
}

/// Ids are what the consumer's resolver hands out; anything path-like never reaches it.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// `serve` with no core behind the library cache: no tag is rewritten and `/lib/` is always 404.
#[cfg(test)] // v2-10c: the app serves through `serve_with`; the existing tests keep this signature
pub fn serve(
    request: &tauri::http::Request<Vec<u8>>,
    content: &dyn Content,
    grants: &Grants,
    engine_hardened: bool,
) -> tauri::http::Response<Vec<u8>> {
    serve_with(
        request,
        content,
        grants,
        engine_hardened,
        &Libs::new(|_| None),
    )
}

/// Serves `<scheme>://localhost/<id>`. The query is ignored on purpose: the policy comes from the grant
/// state alone, so a page that navigates itself to `?net=1` gets nothing. v2-10c: `/lib/<sha384>` serves a pinned
/// library file, and a page whose policy has the library source gets its pinned tags rewritten to it. V2-38: the one
/// query read is `view`, the main window's one-view "Open with" token; it is only compared, never echoed.
pub fn serve_with(
    request: &tauri::http::Request<Vec<u8>>,
    content: &dyn Content,
    grants: &Grants,
    engine_hardened: bool,
    libs: &Libs,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    // Fail closed: WebRTC and preconnect sit outside CSP, so without the engine switches nothing is served.
    if !engine_hardened || request.method() != tauri::http::Method::GET {
        return not_found();
    }
    // v2-10c: public library bytes only, so this response alone carries a CORS header (the webview's SRI check).
    if let Some(hash) = request.uri().path().strip_prefix(libs::ROUTE) {
        return match libs.file(hash) {
            Some(bytes) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/javascript")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap_or_else(|_| not_found()),
            None => not_found(),
        };
    }
    let id = request.uri().path().trim_start_matches('/');
    if !valid_id(id) {
        return not_found();
    }
    let Some(artifact) = content.get(id) else {
        return not_found();
    };
    let csp = match &artifact.csp {
        Some(own) => own.as_str(), // v1b-22: a web widget never takes an artifact grant
        None if grants.allows(id, &artifact.hash) => CSP_NETWORK,
        None => CSP_DEFAULT,
    };
    let mut page = String::from_utf8_lossy(&artifact.bytes).into_owned();
    if csp.contains(libs::SOURCE) {
        // Hex, so no percent-decoding; the first `view=` wins.
        let view = request
            .uri()
            .query()
            .and_then(|q| q.split('&').find_map(|p| p.strip_prefix("view=")));
        page = libs.rewrite_with(id, &artifact.hash, view, &page); // v2-10c: never on an act page
    }
    let mut body = with_bootstrap(&page);
    if artifact.csp.is_some() {
        body = first(&body, BRIDGE_KEY); // v1b-23: widget pages only
    }
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp.trim())
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body.into_bytes())
        .unwrap_or_else(|_| not_found())
}

/// Inserts the bootstrap at the start of `<head>`, else after `<html>` or the
/// doctype. Never before the doctype, which would switch to quirks mode.
fn with_bootstrap(body: &str) -> String {
    // ASCII lowercasing keeps byte offsets, so they index into `body`.
    let lower = body.to_ascii_lowercase();
    let at = tag_end(&lower, "<head")
        .or_else(|| tag_end(&lower, "<html"))
        .or_else(|| {
            let start = lower.len() - lower.trim_start().len();
            lower[start..]
                .starts_with("<!doctype")
                .then(|| lower[start..].find('>').map(|end| start + end + 1))
                .flatten()
        })
        .unwrap_or(0);
    let mut page = String::with_capacity(body.len() + BOOTSTRAP.len() + 20);
    page.push_str(&body[..at]);
    page.push_str("<script>");
    page.push_str(BOOTSTRAP.trim());
    page.push_str("</script>");
    page.push_str(&body[at..]);
    page
}

/// v1b-23: `script` before anything that can run: right after a leading doctype (no quirks mode), else at the start.
fn first(body: &str, script: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let start = lower.len() - lower.trim_start().len();
    let at = lower[start..]
        .starts_with("<!doctype")
        .then(|| lower[start..].find('>').map(|end| start + end + 1))
        .flatten()
        .unwrap_or(0);
    format!(
        "{}<script>{}</script>{}",
        &body[..at],
        script.trim(),
        &body[at..]
    )
}

/// The byte just past the first opening `name` tag, skipping longer names
/// such as `<header>` for `<head`.
fn tag_end(lower: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        let next = start + name.len();
        match lower.as_bytes().get(next) {
            Some(b'>' | b'/') | Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') => {
                return lower[next..].find('>').map(|end| next + end + 1);
            }
            _ => from = next,
        }
    }
    None
}

/// The window's one control call: allow the network for `(id, hash)`. Only the main window may ask.
#[tauri::command]
pub fn artifact_grant(
    webview: tauri::Webview,
    grants: tauri::State<'_, Grants>,
    id: String,
    hash: String,
) -> Result<(), String> {
    let hash_ok =
        !hash.is_empty() && hash.len() <= 128 && hash.bytes().all(|b| b.is_ascii_graphic());
    if webview.label() != "main" || !valid_id(&id) || !hash_ok {
        return Err("refused".into());
    }
    grants.allow(&id, &hash);
    Ok(())
}

/// v2-10c: the library cards of the page `(id, hash)`, from its served bytes. Only the main window may ask.
#[tauri::command]
pub async fn artifact_lib_cards(
    webview: tauri::Webview,
    content: tauri::State<'_, std::sync::Arc<dyn Content>>,
    libs: tauri::State<'_, std::sync::Arc<Libs>>,
    id: String,
    hash: String,
) -> Result<serde_json::Value, String> {
    let label = webview.label().to_string();
    let (content, libs) = (content.inner().clone(), libs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || libs.cards(&label, &*content, &id, &hash))
        .await
        .map_err(|e| e.to_string())?
}

/// v2-10c: "Open with <version>" for the next view of `(id, hash)`. Only the main window may ask. V2-38: returns the
/// one-view token the frame loads with as `?view=<token>`.
#[tauri::command]
pub async fn artifact_open_with(
    webview: tauri::Webview,
    content: tauri::State<'_, std::sync::Arc<dyn Content>>,
    libs: tauri::State<'_, std::sync::Arc<Libs>>,
    id: String,
    hash: String,
    url: String,
    sha384: String,
) -> Result<String, String> {
    let label = webview.label().to_string();
    let (content, libs) = (content.inner().clone(), libs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        libs.set_open_with(&label, &*content, &id, &hash, &url, &sha384)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tauri::http::{Method, Request};

    struct Fixtures(HashMap<&'static str, (&'static str, &'static str)>);
    impl Content for Fixtures {
        fn get(&self, id: &str) -> Option<Artifact> {
            self.0.get(id).map(|(body, hash)| Artifact {
                bytes: body.as_bytes().to_vec(),
                hash: hash.to_string(),
                csp: None, // v1b-22
            })
        }
    }
    fn fixtures() -> Fixtures {
        Fixtures(HashMap::from([
            (
                "a1",
                (
                    "<!doctype html><head><title>x</title></head><body>hi</body>",
                    "h1",
                ),
            ),
            ("bare", ("<p>no head</p>", "h2")),
        ]))
    }
    fn get(uri: &str, content: &Fixtures, grants: &Grants) -> tauri::http::Response<Vec<u8>> {
        serve(
            &Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Vec::new())
                .unwrap(),
            content,
            grants,
            true,
        )
    }
    fn header<'a>(r: &'a tauri::http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        r.headers().get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn serves_html_with_the_default_policy_and_no_cors() {
        let r = get(
            "nunchiro-artifact://localhost/a1",
            &fixtures(),
            &Grants::memory(),
        );
        assert_eq!(r.status(), 200);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_DEFAULT.trim())
        );
        assert_eq!(header(&r, "content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
        assert!(
            r.headers()
                .keys()
                .all(|k| !k.as_str().starts_with("access-control-"))
        );
        let body = String::from_utf8(r.into_body()).unwrap();
        assert!(body.contains("nunchiro:open-link") && body.contains("hi"));
    }

    #[test]
    fn default_policy_has_no_network() {
        let p = CSP_DEFAULT;
        assert!(p.starts_with("sandbox allow-scripts;"));
        assert!(
            !p.contains("allow-same-origin")
                && !p.contains("allow-popups")
                && !p.contains("allow-top-navigation")
                && !p.contains("allow-forms")
        );
        assert!(
            p.contains("connect-src 'none'")
                && p.contains("form-action 'none'")
                && p.contains("frame-src 'none'")
        );
        let bare = |t: &str| {
            matches!(
                t.trim_end_matches(';'),
                "https:" | "http:" | "ws:" | "wss:" | "*"
            )
        };
        assert!(
            !p.split_whitespace().any(bare),
            "no scheme-wide or wildcard source"
        );
        for host in [
            "cdnjs.cloudflare.com",
            "cdn.jsdelivr.net",
            "unpkg.com",
            "cdn.tailwindcss.com",
            "code.jquery.com",
        ] {
            assert!(!p.contains(&format!("https://{host}")), "{host}"); // v2-10c: hosts left the default
        }
    }

    #[test]
    fn grant_widens_only_for_the_hash_it_was_given_for() {
        let content = fixtures();
        let grants = Grants::memory();
        grants.allow("a1", "h1");
        let r = get("nunchiro-artifact://localhost/a1", &content, &grants);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_NETWORK.trim())
        );
        // Another artifact is untouched, and a changed hash drops the grant.
        let r = get("nunchiro-artifact://localhost/bare", &content, &grants);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_DEFAULT.trim())
        );
        grants.allow("a1", "old");
        let r = get("nunchiro-artifact://localhost/a1", &content, &grants);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_DEFAULT.trim())
        );
    }

    #[test]
    fn network_policy_keeps_the_sandbox_and_closes_loopback() {
        let p = CSP_NETWORK;
        assert!(p.starts_with("sandbox allow-scripts;") && !p.contains("allow-same-origin"));
        assert!(p.contains("connect-src https: wss:") && p.contains("img-src data: blob: https:"));
        assert!(
            p.contains("form-action 'none'")
                && p.contains("frame-src 'none'")
                && p.contains("base-uri 'none'")
        );
        assert!(
            !p.contains(" http:") && !p.contains(" ws:"),
            "plain http/ws would reach the core on loopback"
        );
    }

    #[test]
    fn query_and_path_tricks_neither_grant_nor_traverse() {
        let content = fixtures();
        let g = Grants::memory();
        // A self-navigation with a query cannot ask for the wide policy.
        let r = get(
            "nunchiro-artifact://localhost/a1?net=1&grant=h1",
            &content,
            &g,
        );
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_DEFAULT.trim())
        );
        for bad in [
            "/",
            "/../a1",
            "/a1/",
            "/a1/x",
            "/%2e%2e/a1",
            "/a1%2f",
            "/etc/passwd",
            "/a.html",
            "/a1%00",
            "/a1;x",
            "/a1\\x",
        ] {
            assert_eq!(
                get(&format!("nunchiro-artifact://localhost{bad}"), &content, &g).status(),
                404,
                "{bad}"
            );
        }
    }

    #[test]
    fn only_the_scheme_itself_may_load_in_a_frame() {
        let ok = |u: &str| is_artifact_url(&u.parse().unwrap());
        assert!(
            ok("nunchiro-artifact://localhost/a1") && ok("http://nunchiro-artifact.localhost/a1")
        );
        for bad in [
            "nunchiro-artifact://evil/a1",
            "http://nunchiro-artifact.localhost.evil.example/",
            "http://nunchiro-artifact.localhost:9/",
            "https://nunchiro-artifact.localhost/",
            "http://127.0.0.1:4173/",
            "nunchiro://x",
            "tauri://localhost/",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn nothing_is_served_until_the_engine_is_hardened() {
        let req = Request::builder()
            .uri("nunchiro-artifact://localhost/a1")
            .body(Vec::new())
            .unwrap();
        let r = serve(&req, &fixtures(), &Grants::memory(), false);
        assert_eq!(r.status(), 404);
        assert!(r.body().is_empty());
        assert!(!Engine::default().hardened());
    }

    #[test]
    fn only_get_is_served() {
        let req = Request::builder()
            .method(Method::POST)
            .uri("nunchiro-artifact://localhost/a1")
            .body(b"x".to_vec())
            .unwrap();
        assert_eq!(
            serve(&req, &fixtures(), &Grants::memory(), true).status(),
            404
        );
    }

    #[test]
    fn bootstrap_goes_first_in_head_and_never_before_the_doctype() {
        let page = |id| {
            String::from_utf8(
                get(
                    &format!("nunchiro-artifact://localhost/{id}"),
                    &fixtures(),
                    &Grants::memory(),
                )
                .into_body(),
            )
            .unwrap()
        };
        let p = page("a1");
        assert!(p.starts_with("<!doctype html><head><script>"), "{p}");
        assert!(page("bare").starts_with("<script>"));
    }

    #[test]
    fn unknown_ids_and_no_content_are_404() {
        assert_eq!(
            get(
                "nunchiro-artifact://localhost/nope",
                &fixtures(),
                &Grants::memory()
            )
            .status(),
            404
        );
        let r = serve(
            &Request::builder()
                .uri("nunchiro-artifact://localhost/a1")
                .body(Vec::new())
                .unwrap(),
            &NoContent,
            &Grants::memory(),
            true,
        );
        assert_eq!(r.status(), 404);
    }
}
