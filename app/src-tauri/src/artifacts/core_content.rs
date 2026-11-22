//! v1b-09: the [`Content`] behind the artifact scheme for files the window shows (06 reuses it for detected
//! artifacts). The window registers `(root, path)` with `artifact_open` and gets back an opaque id; each request
//! for that id reads the bytes again through the core's `file_read` (root confinement, `.git` and link refusal
//! stay the core's), so the scheme never touches a filesystem path and the hash always matches what is served.
use super::{Artifact, Content, valid_id};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

/// Reads `(root, path)` through the core; `None` unless the core serves it as HTML or SVG text (2 MB at most).
pub type Reader = dyn Fn(&str, &str) -> Option<Vec<u8>> + Send + Sync;
// v1b-22: resolves a `w-` id to a web widget page.
type WidgetReader = dyn Fn(&str) -> Option<Artifact> + Send + Sync;

pub struct CoreContent {
    // shortcut: one entry per file opened in this app run, never evicted; upgrade to an LRU if 06's
    // detection registers many more than a person opens by hand.
    files: Mutex<HashMap<String, (String, String)>>,
    read: Box<Reader>,
    // v1b-22: `w-` ids are web widget pages, asked of the core's `widget_page` on every request.
    widget: Box<WidgetReader>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Same `(root, path)`, same id, so a reopened file keeps its grant while its bytes are unchanged.
fn id_for(root: &str, path: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"nunchiro-file-artifact-v1\0");
    // Length-prefixed, so no (root, path) split of the same bytes can collide.
    h.update((root.len() as u64).to_be_bytes());
    h.update(root.as_bytes());
    h.update(path.as_bytes());
    format!("f{}", &hex(&h.finalize())[..32])
}

pub fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

impl CoreContent {
    pub fn new(read: impl Fn(&str, &str) -> Option<Vec<u8>> + Send + Sync + 'static) -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
            read: Box::new(read),
            widget: Box::new(|id| super::widget_page::page(id, &crate::core_call)), // v1b-22
        }
    }

    // v1b-22: tests answer `widget_page` themselves.
    #[cfg(test)]
    pub fn with_widgets(
        mut self,
        widget: impl Fn(&str) -> Option<Artifact> + Send + Sync + 'static,
    ) -> Self {
        self.widget = Box::new(widget);
        self
    }

    /// Registers the file and returns `(id, hash)` of what the scheme will serve now.
    pub fn open(&self, root: &str, path: &str) -> Result<(String, String), String> {
        let bytes = (self.read)(root, path).ok_or("not an HTML or SVG file the core can read")?;
        let id = id_for(root, path);
        debug_assert!(valid_id(&id));
        self.files
            .lock()
            .map_err(|_| "artifact registry unavailable")?
            .insert(id.clone(), (root.to_string(), path.to_string()));
        Ok((id, hash(&bytes)))
    }
}

impl Content for CoreContent {
    fn get(&self, id: &str) -> Option<Artifact> {
        if id.starts_with("w-") {
            return (self.widget)(id); // v1b-22
        }
        let (root, path) = self.files.lock().ok()?.get(id).cloned()?;
        let bytes = (self.read)(&root, &path)?;
        Some(Artifact {
            hash: hash(&bytes),
            bytes,
            csp: None, // v1b-22
        })
    }
}

/// The window's call to show a file in the sandbox: registers `(root, path)` and returns `{id, hash}` for the frame
/// and the network grant. Only the main window may ask; the core read runs off the main thread.
#[tauri::command]
pub async fn artifact_open(
    webview: tauri::Webview,
    content: tauri::State<'_, std::sync::Arc<CoreContent>>,
    root: String,
    path: String,
) -> Result<serde_json::Value, String> {
    if webview.label() != "main" || root.is_empty() || root.len() > 128 || path.len() > 4096 {
        return Err("refused".into());
    }
    let c = content.inner().clone();
    let (id, hash) = tauri::async_runtime::spawn_blocking(move || c.open(&root, &path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "id": id, "hash": hash }))
}

/// The reply of `file_read` as bytes to serve: HTML or SVG text only (v1b-06: SVG cards share the frame), never
/// another kind and never a cut-off file.
pub fn html_of(reply: &serde_json::Value) -> Option<Vec<u8>> {
    if !matches!(reply.get("kind")?.as_str()?, "html" | "svg")
        || reply.get("too_large")?.as_bool()?
    {
        return None;
    }
    Some(reply.get("text")?.as_str()?.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::{CSP_DEFAULT, Grants, serve};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn fake() -> (CoreContent, Arc<Mutex<HashMap<String, String>>>) {
        let disk = Arc::new(Mutex::new(HashMap::from([(
            "s1:page.html".to_string(),
            "<!doctype html><p>one</p>".to_string(),
        )])));
        let d = disk.clone();
        let c = CoreContent::new(move |root, path| {
            d.lock()
                .unwrap()
                .get(&format!("{root}:{path}"))
                .map(|t| t.as_bytes().to_vec())
        });
        (c, disk)
    }

    #[test]
    fn ids_are_opaque_stable_and_valid() {
        let (c, _) = fake();
        let (id, h) = c.open("s1", "page.html").unwrap();
        assert!(valid_id(&id) && !id.contains("page"));
        assert_eq!(c.open("s1", "page.html").unwrap(), (id.clone(), h.clone()));
        assert_ne!(id_for("s1", "page.html"), id_for("s2", "page.html"));
        assert_ne!(id_for("s1", "a\0b"), id_for("s1\0a", "b"));
        assert_eq!(h, hash(b"<!doctype html><p>one</p>"));
    }

    #[test]
    fn each_request_reads_through_the_core_again() {
        let (c, disk) = fake();
        let (id, h) = c.open("s1", "page.html").unwrap();
        disk.lock()
            .unwrap()
            .insert("s1:page.html".into(), "<p>two</p>".into());
        let a = c.get(&id).unwrap();
        assert_eq!(a.bytes, b"<p>two</p>");
        assert_ne!(a.hash, h, "a grant for the old hash no longer applies");
        disk.lock().unwrap().clear();
        assert!(c.get(&id).is_none(), "a file gone from the core is a 404");
    }

    // v1b-22
    #[test]
    fn widget_ids_never_reach_file_read() {
        let c = CoreContent::new(|_, _| panic!("a widget id must not read a file")).with_widgets(
            |id| {
                (id == "w-a-0123456789abcdef").then(|| Artifact {
                    bytes: b"w".to_vec(),
                    hash: "h".into(),
                    csp: Some("p".into()),
                })
            },
        );
        assert_eq!(
            c.get("w-a-0123456789abcdef").unwrap().csp.as_deref(),
            Some("p")
        );
        assert!(c.get("w-b-0123456789abcdef").is_none());
    }

    #[test]
    fn unknown_ids_and_refused_files_resolve_nothing() {
        let (c, _) = fake();
        assert!(c.get("fdeadbeef").is_none());
        assert!(c.open("s1", "../etc/passwd").is_err());
        assert!(c.get(&id_for("s1", "../etc/passwd")).is_none());
    }

    #[test]
    fn served_through_the_scheme_with_the_default_policy() {
        let (c, _) = fake();
        let (id, _) = c.open("s1", "page.html").unwrap();
        let req = tauri::http::Request::builder()
            .uri(format!("nunchiro-artifact://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let r = serve(&req, &c, &Grants::memory(), true);
        assert_eq!(r.status(), 200);
        assert_eq!(
            r.headers()
                .get("content-security-policy")
                .and_then(|v| v.to_str().ok()),
            Some(CSP_DEFAULT.trim())
        );
        assert!(
            String::from_utf8(r.into_body())
                .unwrap()
                .contains("<p>one</p>")
        );
    }

    #[test]
    fn only_html_and_svg_text_from_file_read_is_served() {
        let ok = json!({"type":"file","kind":"html","size":3,"too_large":false,"text":"<p>","data":null});
        assert_eq!(html_of(&ok), Some(b"<p>".to_vec()));
        // v1b-06: an SVG artifact card runs in the same sandbox frame as HTML.
        let svg = json!({"type":"file","kind":"svg","size":5,"too_large":false,"text":"<svg>","data":null});
        assert_eq!(html_of(&svg), Some(b"<svg>".to_vec()));
        for bad in [
            json!({"type":"file","kind":"text","size":3,"too_large":false,"text":"<p>","data":null}),
            json!({"type":"file","kind":"image","size":3,"too_large":false,"text":null,"data":[1,2,3]}),
            json!({"type":"file","kind":"svg","size":3,"too_large":true,"text":null,"data":null}),
            json!({"type":"file","kind":"html","size":3,"too_large":true,"text":null,"data":null}),
            json!({"type":"file","kind":"html"}),
        ] {
            assert_eq!(html_of(&bad), None, "{bad}");
        }
    }

    /// v1b-06: an SVG card's file goes through the app's real path, `file_read` reply → `html_of` → the scheme.
    #[test]
    fn svg_artifact_opens_through_the_scheme() {
        let svg =
            r#"<svg xmlns="http://www.w3.org/2000/svg"><title>Chart</title><circle r="4"/></svg>"#;
        let c = CoreContent::new(move |root, path| {
            let kind = if path.ends_with(".svg") {
                "svg"
            } else {
                "binary"
            };
            html_of(
                &json!({"type":"file","kind":kind,"size":svg.len(),"too_large":false,
                "text": (root == "s1").then_some(svg),"data":null}),
            )
        });
        let (id, h) = c.open("s1", "chart.svg").unwrap();
        assert_eq!(h, hash(svg.as_bytes()));
        assert!(c.open("s1", "chart.bin").is_err());
        let req = tauri::http::Request::builder()
            .uri(format!("nunchiro-artifact://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let r = serve(&req, &c, &Grants::memory(), true);
        assert_eq!(r.status(), 200);
        assert_eq!(
            r.headers()
                .get("content-security-policy")
                .and_then(|v| v.to_str().ok()),
            Some(CSP_DEFAULT.trim())
        );
        assert!(
            String::from_utf8(r.into_body())
                .unwrap()
                .contains("<circle r=\"4\"/>")
        );
    }
}
