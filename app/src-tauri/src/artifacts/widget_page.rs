//! v1b-22: web widget pages on the artifact scheme. The window frames `w-<name>-<hash prefix>`; each request asks
//! the core's `widget_page` again (approved web widget, setting on), serves the entry only while the approval hash
//! still has that prefix, and sends a policy of its own: the artifact default with `connect-src`/`img-src` widened to
//! `https://<host>` for each approved public host. A page that can act (v1b-34) runs only its approved bytes' inline
//! scripts, each by hash, plus the app's own two; no script host, no `'unsafe-inline'`, no worker. No artifact
//! grant, chip or per-project setting applies.
use super::{Artifact, BOOTSTRAP, BRIDGE_KEY, CSP_DEFAULT};
use sha2::{Digest, Sha256};

pub const PREFIX: usize = 16;

/// The frame id for a page whose approval hash is `hash`; the window builds it (web/src/webwidgets/api.ts `frameId`),
/// this pins the rule `page` parses.
#[cfg(test)]
pub fn id(name: &str, hash: &str) -> String {
    format!("w-{name}-{}", &hash[..PREFIX.min(hash.len())])
}
/// review-34: the id of a page framed with act ends in `-act`, so a frame framed under the read policy is never the
/// one that acts.
pub const ACT: &str = "-act";

/// `None` when any host is not a plain lowercase name, so no host can add a source or a directive. `act` is the entry
/// of a page that can act: its scripts are only the entry's inline ones, by hash (v1b-34 r2: CDN files and anything
/// fetched sit outside the approval hash).
pub fn csp(hosts: &[String], act: Option<&str>) -> Option<String> {
    let plain = |h: &String| {
        !h.is_empty()
            && h.len() <= 253
            && h.contains('.')
            && h.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    };
    if !hosts.iter().all(plain) {
        return None;
    }
    let sources: String = hosts.iter().map(|h| format!(" https://{h}")).collect();
    let connect = if hosts.is_empty() {
        "connect-src 'none'".to_string()
    } else {
        format!("connect-src{sources}")
    };
    let mut policy = CSP_DEFAULT.trim().to_string();
    debug_assert!(policy.contains("connect-src 'none'") && policy.contains("img-src data: blob:;"));
    if let Some(entry) = act {
        let script = policy
            .split(';')
            .find(|d| d.trim_start().starts_with("script-src "))?
            .to_string();
        // The page as served: the bridge key and bootstrap the app inserts, then the entry's own scripts.
        let mut hashes: Vec<String> = Vec::new();
        for text in [BRIDGE_KEY.trim(), BOOTSTRAP.trim()]
            .into_iter()
            .chain(inline_scripts(entry))
        {
            let h = source(text);
            if !hashes.contains(&h) {
                hashes.push(h);
            }
        }
        policy = policy
            .replace(&script, &format!(" script-src {}", hashes.join(" ")))
            .replace("worker-src blob:", "worker-src 'none'");
    }
    Some(policy.replace("connect-src 'none'", &connect).replace(
        "img-src data: blob:;",
        &format!("img-src data: blob:{sources};"),
    ))
}

/// A CSP hash source for one inline script: the HTML parser turns CRLF and CR into LF before the browser hashes.
fn source(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    format!("'sha256-{}'", base64(&Sha256::digest(text.as_bytes())))
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = c
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= c.len() {
                A[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// The raw text of each `<script>` element, as the HTML tokenizer ends it (`</script` then a space, `/` or `>`).
/// shortcut: a `<!--` inside a script, a `>` inside a quoted `<script>` attribute or a tag in a comment can make this
/// read differently from the browser; the hash then matches nothing and that script does not run (fails closed).
fn inline_scripts(html: &str) -> Vec<&str> {
    let lower = html.to_ascii_lowercase();
    let ends = |b: Option<&u8>| {
        matches!(
            b,
            Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
        )
    };
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<script") {
        let after = from + found + "<script".len();
        if !ends(lower.as_bytes().get(after)) {
            from = after;
            continue;
        }
        let Some(gt) = lower[after..].find('>') else {
            break;
        };
        let body = after + gt + 1;
        let mut at = body;
        let end = loop {
            match lower[at..].find("</script") {
                Some(k) if ends(lower.as_bytes().get(at + k + "</script".len())) => break at + k,
                Some(k) => at += k + 1,
                None => break html.len(),
            }
        };
        out.push(&html[body..end]);
        from = end;
    }
    out
}

/// Resolves a widget frame id through `call` (the core's owner socket in the app).
pub fn page(
    id: &str,
    call: &dyn Fn(serde_json::Value) -> Option<serde_json::Value>,
) -> Option<Artifact> {
    let rest = id.strip_prefix("w-")?;
    let (rest, act) = match rest.strip_suffix(ACT) {
        Some(r) => (r, true),
        None => (rest, false),
    };
    let (name, prefix) = rest.rsplit_once('-')?;
    if prefix.len() != PREFIX {
        return None;
    }
    let reply = call(serde_json::json!({"op": "widget_page", "name": name}))?;
    let page = reply.get("page")?;
    let hash = page.get("hash")?.as_str()?;
    // review-34: served only under the policy of the grant the id was framed with.
    let granted = page.get("act")?.as_bool()?;
    if page.get("name")?.as_str()? != name || !hash.starts_with(prefix) || granted != act {
        return None;
    }
    let hosts: Vec<String> = page
        .get("network")?
        .as_array()?
        .iter()
        .map(|h| h.as_str().map(String::from))
        .collect::<Option<_>>()?;
    let entry = page.get("entry")?.as_str()?;
    Some(Artifact {
        bytes: entry.as_bytes().to_vec(),
        hash: hash.into(),
        csp: Some(csp(&hosts, act.then_some(entry))?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::{CSP_NETWORK, Grants, serve, valid_id};
    use serde_json::json;

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn core(page: serde_json::Value) -> impl Fn(serde_json::Value) -> Option<serde_json::Value> {
        move |req| {
            assert_eq!(req, json!({"op": "widget_page", "name": "my-w"}));
            Some(json!({"type": "widget_page", "page": page.clone()}))
        }
    }
    fn page_json(hosts: &[&str]) -> serde_json::Value {
        json!({"name": "my-w", "hash": HASH, "network": hosts, "act": false, "entry": "<!doctype html><p>w</p>",
               "context": {"projects": [], "sessions": []}})
    }

    #[test]
    fn widget_csp_is_the_default_plus_approved_hosts_only() {
        assert_eq!(csp(&[], None).unwrap(), CSP_DEFAULT.trim());
        let p = csp(&["api.example.com".into(), "img.example.org".into()], None).unwrap();
        // The same literal the window's test server builds (web/tests/web-widgets.spec.ts).
        assert_eq!(
            p,
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' nunchiro-artifact://localhost/lib/; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: https://api.example.com https://img.example.org; media-src data: blob:; worker-src blob:; connect-src https://api.example.com https://img.example.org; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
        );
        assert!(p.starts_with("sandbox allow-scripts;") && !p.contains("allow-same-origin"));
        // v2-10c: the library path source names the app's own scheme host, not loopback; every other token is checked.
        let p = p.replacen(" nunchiro-artifact://localhost/lib/", "", 1);
        for t in [
            " http:",
            " ws:",
            " wss:",
            " https:;",
            " https: ",
            "*",
            "127.0.0.1",
            "localhost",
        ] {
            assert!(!p.contains(t), "{t}");
        }
        for bad in [
            "a.com; script-src *",
            "A.com",
            "a.com *",
            "",
            "single",
            "a.com/x",
            "a.com:443",
        ] {
            assert_eq!(csp(&[bad.into()], None), None, "{bad}");
        }
    }

    // v1b-34 (needs 52): a page that can act gets no outside script host; a view-only page keeps the default CDNs.
    // r2 (SHOULD-1): an act page runs only the inline scripts of its approved bytes, by hash; nothing it fetches.
    #[test]
    fn v1b_34_an_act_page_runs_only_its_approved_scripts() {
        let hosts = ["api.example.com".to_string()];
        let entry = "<!doctype html><script>r()</script><SCRIPT type=module>r()</SCRIPT><p>w</p>";
        let act = csp(&hosts, Some(entry)).unwrap();
        // The injected bridge key and bootstrap, then the entry's scripts (deduplicated), each by hash.
        let (key, boot) = (
            source(crate::artifacts::BRIDGE_KEY.trim()),
            source(crate::artifacts::BOOTSTRAP.trim()),
        );
        assert_eq!(
            act,
            format!(
                "sandbox allow-scripts; default-src 'none'; script-src {key} {boot} 'sha256-Zln7czyuVsj/kW1SRpvacSCYFjxYqdj9rg7YtRgujO4='; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: https://api.example.com; media-src data: blob:; worker-src 'none'; connect-src https://api.example.com; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
            )
        );
        for no in [
            "'unsafe-inline'",
            "'unsafe-eval'",
            "https:",
            "blob:;",
            "data:;",
            "*",
        ] {
            let script = act.split(';').find(|d| d.contains("script-src")).unwrap();
            assert!(!script.contains(no.trim_end_matches(';')), "{no}");
        }
        assert!(!act.contains("worker-src blob:"));
        // View-only is the r1 policy, byte for byte.
        assert_eq!(
            csp(&hosts, None).unwrap(),
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' nunchiro-artifact://localhost/lib/; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: https://api.example.com; media-src data: blob:; worker-src blob:; connect-src https://api.example.com; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
        );
        let mut p = page_json(&["api.example.com"]);
        p["act"] = json!(true);
        p["entry"] = json!(entry);
        let act_id = format!("{}{ACT}", id("my-w", HASH));
        assert!(valid_id(&act_id));
        assert_eq!(page(&act_id, &core(p.clone())).unwrap().csp.unwrap(), act);
        // review-34 MUST-1: the read id is not served once act is granted, nor the act id while only read is.
        assert!(page(&id("my-w", HASH), &core(p)).is_none());
        assert!(page(&act_id, &core(page_json(&["api.example.com"]))).is_none());
        let mut p = page_json(&[]);
        p["act"] = json!("yes");
        assert!(page(&id("my-w", HASH), &core(p)).is_none());
    }

    // r2: the scripts a browser hashes: each `<script>` element's raw text, newlines normalized (HTML parsing).
    #[test]
    fn v1b_34_inline_scripts_are_found_as_the_browser_reads_them() {
        assert_eq!(
            source(""),
            "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
        );
        assert_eq!(
            source("a\r\nb"),
            "'sha256-fhj3NzEbLcOy8mndeDlrA1HxT7Zu+oefdoyyMYGIPHg='"
        );
        assert_eq!(source("a\rb"), source("a\nb"));
        let html = "<p title='x'>a</p><script>one</script ><scripts>no</scripts><Script\nid=x>two</script/>\
                    <script src=lib.js></script><script>three";
        assert_eq!(inline_scripts(html), ["one", "two", "", "three"]);
        assert_eq!(inline_scripts("<p>no script</p>"), Vec::<&str>::new());
    }

    #[test]
    fn served_under_its_own_policy_and_never_a_grant() {
        let call = core(page_json(&["api.example.com"]));
        let id = id("my-w", HASH);
        assert_eq!(id, "w-my-w-0123456789abcdef");
        assert!(valid_id(&id));
        let a = page(&id, &call).unwrap();
        assert_eq!(a.bytes, b"<!doctype html><p>w</p>");
        // A stored artifact grant for the id does not widen a widget's policy.
        let grants = Grants::memory();
        grants.allow(&id, HASH);
        struct One(Artifact);
        impl crate::artifacts::Content for One {
            fn get(&self, _: &str) -> Option<Artifact> {
                Some(Artifact {
                    bytes: self.0.bytes.clone(),
                    hash: self.0.hash.clone(),
                    csp: self.0.csp.clone(),
                })
            }
        }
        let req = tauri::http::Request::builder()
            .uri(format!("nunchiro-artifact://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let r = serve(&req, &One(a), &grants, true);
        assert_eq!(r.status(), 200);
        let served = r
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(served, csp(&["api.example.com".into()], None).unwrap());
        assert_ne!(served, CSP_NETWORK.trim());
        // Not before the engine is hardened, as for artifacts.
        let req = tauri::http::Request::builder()
            .uri(format!("nunchiro-artifact://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            serve(&req, &One(page(&id, &call).unwrap()), &grants, false).status(),
            404
        );
    }

    // v1b-23 (review-23 S2): the bridge key script runs before any widget code, even code placed before `<head>`, and
    // only on widget pages.
    #[test]
    fn review_23_bridge_key_runs_first_on_widget_pages_only() {
        let body = |entry: &str, own: bool| {
            let mut p = page_json(&[]);
            p["entry"] = json!(entry);
            let mut a = page(&id("my-w", HASH), &core(p)).unwrap();
            if !own {
                a.csp = None;
            }
            let req = tauri::http::Request::builder()
                .uri(format!(
                    "nunchiro-artifact://localhost/{}",
                    id("my-w", HASH)
                ))
                .body(Vec::new())
                .unwrap();
            struct One(std::sync::Mutex<Option<Artifact>>);
            impl crate::artifacts::Content for One {
                fn get(&self, _: &str) -> Option<Artifact> {
                    self.0.lock().unwrap().take()
                }
            }
            let one = One(std::sync::Mutex::new(Some(a)));
            String::from_utf8(serve(&req, &one, &Grants::memory(), true).into_body()).unwrap()
        };
        let key = format!("<script>{}</script>", crate::artifacts::BRIDGE_KEY.trim());
        let early = "<!doctype html><script>location='x'</script><head><title>t</title></head>";
        let b = body(early, true);
        assert!(
            b.starts_with(&format!("<!doctype html>{key}<script>location")),
            "{b}"
        );
        assert_eq!(b.matches("nunchiro:bridge").count(), 1);
        assert!(body("<script>x()</script>", true).starts_with(&key));
        assert!(body("  <!DOCTYPE html><p>", true).starts_with(&format!("  <!DOCTYPE html>{key}")));
        // An artifact never gets it.
        assert!(!body(early, false).contains("nunchiro:bridge"));
    }

    #[test]
    fn a_newer_hash_or_another_name_is_never_served_under_an_id() {
        // The approval moved on (an edit was re-granted): the old id resolves nothing.
        let call = core(page_json(&[]));
        assert!(page("w-my-w-ffffffffffffffff", &call).is_none());
        // A refused page (unapproved, changed, setting off) is no page.
        let refused = |_: serde_json::Value| None;
        assert!(page(&id("my-w", HASH), &refused).is_none());
        for bad in ["my-w-0123456789abcdef", "w-my-w-0123", "w-my-w", "f0123"] {
            assert!(page(bad, &call).is_none(), "{bad}");
        }
        // A reply naming another widget, or a host the policy cannot carry, is refused.
        let mut other = page_json(&[]);
        other["name"] = json!("x");
        assert!(page(&id("my-w", HASH), &core(other)).is_none());
        assert!(
            page(
                &id("my-w", HASH),
                &core(page_json(&["a.com; script-src *"]))
            )
            .is_none()
        );
    }
}
