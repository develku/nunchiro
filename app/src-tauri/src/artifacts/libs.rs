//! V2-10c (needs 91): pinned artifact libraries in the app. `serve` rewrites the `src` of each `<script>` tag the core
//! answers pinned to [`SOURCE`]`<sha384>`; the [`ROUTE`] serves those bytes from the core's store after hashing the
//! buffer it serves. The card list and "Open with <version>" come from the served page bytes and main-window commands,
//! never from a URL, query or frame message.
//!
//! The tag parser reads only what it is sure the browser runs as that tag: a lowercase `<script` start tag outside
//! comments and raw text, before any `<svg>`, `<math>`, `<select>`, `<frameset>` or `<plaintext>`, with one quoted
//! `src` on the five hosts. Anything else is left as written, so the CSP (which no longer lists the hosts) blocks it.
use super::{Content, valid_id};
use serde_json::{Value, json};
use sha2::{Digest, Sha384};
use std::{
    collections::HashMap, io::Read, ops::Range, os::unix::fs::OpenOptionsExt, path::Path,
    sync::Mutex, time::Instant,
};

/// The path the app serves pinned files under; the only path besides `/<id>`.
pub const ROUTE: &str = "/lib/";
/// The CSP source for that path (never the whole scheme), and the start of every rewritten `src`.
pub const SOURCE: &str = "nunchiro-artifact://localhost/lib/";
/// The five library hosts (the core's `libs::grammar::HOSTS`).
const HOSTS: [&str; 5] = [
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdn.tailwindcss.com",
    "code.jquery.com",
];
/// Tags read per page: the core's resolve limit.
pub const MAX_TAGS: usize = 32;
/// The core's per-file cap.
const FILE_CAP: usize = 8 * 1024 * 1024;

/// One request to the core's owner socket (`core_call` in the app).
pub type Call = dyn Fn(Value) -> Option<Value> + Send + Sync;

/// Most "Open with" states held at once; one more drops the oldest.
const OPEN_WITH_CAP: usize = 64;

/// "Open with <version>" for one view: the tag `url` of the page `(id, hash)` is served from `sha384`, to the one
/// request that carries `view`.
struct Substitute {
    hash: String,
    url: String,
    sha384: String,
    /// V2-38: 16 random bytes as hex, held only in the main window's call result.
    view: String,
    at: Instant,
}

pub struct Libs {
    call: Box<Call>,
    open_with: Mutex<HashMap<String, Substitute>>,
}

/// A `<script>` start tag the parser read with certainty.
#[derive(Debug, PartialEq)]
pub struct Tag {
    /// The `src` value inside its quotes, as a byte range of the page.
    pub src: Range<usize>,
    pub url: String,
    /// The `integrity` attribute as written.
    pub integrity: Option<String>,
    /// The tag has a `crossorigin` attribute.
    pub crossorigin: bool,
}

pub fn valid_hash(h: &str) -> bool {
    h.len() == 96
        && h.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Libs {
    pub fn new(call: impl Fn(Value) -> Option<Value> + Send + Sync + 'static) -> Self {
        Self {
            call: Box::new(call),
            open_with: Mutex::new(HashMap::new()),
        }
    }

    /// The core's answer per distinct url, in page order; `None` when the core does not answer.
    fn resolve(&self, id: &str, tags: &[Tag]) -> Option<HashMap<String, Value>> {
        let mut urls: Vec<&str> = Vec::new();
        for t in tags {
            if !urls.contains(&t.url.as_str()) {
                urls.push(&t.url);
            }
        }
        let reply = (self.call)(json!({
            "op": "libs_resolve",
            "urls": urls,
            "requester": format!("artifact:{id}"),
        }))?;
        let results = reply.get("results")?.as_array()?;
        (results.len() == urls.len()).then(|| {
            urls.iter()
                .map(|u| u.to_string())
                .zip(results.iter().cloned())
                .collect()
        })
    }

    #[cfg(test)] // the app serves through `rewrite_with`; the existing tests keep this signature
    pub fn rewrite(&self, id: &str, hash: &str, html: &str) -> String {
        self.rewrite_with(id, hash, None, html)
    }

    /// The page as served: each pinned tag's `src` replaced, nothing else. Consumes this view's "Open with" when
    /// `view` is its token.
    pub fn rewrite_with(&self, id: &str, hash: &str, view: Option<&str>, html: &str) -> String {
        let substitute = view.and_then(|view| {
            let mut map = self.open_with.lock().unwrap_or_else(|e| e.into_inner());
            // V2-38: another id, or no or a wrong token, leaves it in place. With its token it is consumed when it is
            // for this content; a content change drops it.
            map.get(id).filter(|s| same_token(&s.view, view))?;
            map.remove(id).filter(|s| s.hash == hash)
        });
        let tags = tags(html);
        if tags.is_empty() {
            return html.to_string();
        }
        let results = self.resolve(id, &tags).unwrap_or_default();
        let mut page = String::with_capacity(html.len());
        let mut at = 0;
        for t in &tags {
            let pinned = results
                .get(&t.url)
                .filter(|r| r["state"] == "pinned")
                .and_then(|r| r["sha384"].as_str())
                .filter(|h| valid_hash(h));
            let open_with = substitute
                .as_ref()
                .filter(|s| {
                    s.url == t.url
                        && results
                            .get(&t.url)
                            .is_some_and(|r| r["state"] == "needs_card")
                })
                .map(|s| s.sha384.as_str());
            if let Some(sha384) = pinned.or(open_with) {
                page.push_str(&html[at..t.src.start]);
                page.push_str(SOURCE);
                page.push_str(sha384);
                at = t.src.end;
                // V2-37: SRI never passes on a no-cors load, and `/lib/` is another origin than the sandboxed page.
                if t.integrity.is_some() && !t.crossorigin {
                    page.push_str(&html[at..at + 1]); // the closing quote
                    page.push_str(" crossorigin=\"anonymous\"");
                    at += 1;
                }
            }
        }
        page.push_str(&html[at..]);
        page
    }

    /// The bytes for [`ROUTE`]`<hash>`: only a hash a lockfile entry names, read once without following a link, and
    /// served only when that same buffer hashes to it.
    pub fn file(&self, hash: &str) -> Option<Vec<u8>> {
        if !valid_hash(hash) {
            return None;
        }
        let reply = (self.call)(json!({"op": "libs_entry", "sha384": hash}))?;
        if reply.get("entry")?.get("sha384")?.as_str()? != hash {
            return None;
        }
        let path = Path::new(reply.get("path")?.as_str()?);
        if path.file_name()?.to_str()? != hash {
            return None;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(FILE_CAP as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        let sum: String = Sha384::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        (bytes.len() <= FILE_CAP && sum == hash).then_some(bytes)
    }

    /// The parse of the served bytes of `(id, hash)` and the core's answers; `Err` for anything but the main window
    /// and the current content.
    fn page(
        &self,
        label: &str,
        content: &dyn Content,
        id: &str,
        hash: &str,
    ) -> Result<(Vec<Tag>, HashMap<String, Value>), String> {
        let refused = || "refused".to_string();
        if label != "main" || !valid_id(id) {
            return Err(refused());
        }
        let artifact = content.get(id).ok_or_else(refused)?;
        if artifact.hash != hash {
            return Err(refused());
        }
        // A page whose policy has no library source (an act page) gets no rewrite and so no cards.
        if artifact.csp.as_ref().is_some_and(|p| !p.contains(SOURCE)) {
            return Ok((Vec::new(), HashMap::new()));
        }
        let tags = tags(&String::from_utf8_lossy(&artifact.bytes));
        if tags.is_empty() {
            return Ok((tags, HashMap::new()));
        }
        let results = self.resolve(id, &tags).ok_or_else(refused)?;
        Ok((tags, results))
    }

    /// `artifact_lib_cards`: `{cards, refused, pinned}` from the served bytes. Read-only.
    pub fn cards(
        &self,
        label: &str,
        content: &dyn Content,
        id: &str,
        hash: &str,
    ) -> Result<Value, String> {
        let (tags, results) = self.page(label, content, id, hash)?;
        Ok(cards_of(&tags, &results))
    }

    /// `artifact_open_with`: the next serve of `(id, hash)` with `?view=<token>` serves the card tag `url` from the
    /// pinned `sha384`, a different version of the same host, library and file. Returns the token; a new one for the
    /// same id replaces the old.
    pub fn set_open_with(
        &self,
        label: &str,
        content: &dyn Content,
        id: &str,
        hash: &str,
        url: &str,
        sha384: &str,
    ) -> Result<String, String> {
        let refused = || "refused".to_string();
        let (tags, results) = self.page(label, content, id, hash)?;
        if !valid_hash(sha384) {
            return Err(refused());
        }
        let cards = cards_of(&tags, &results);
        let card = cards["cards"]
            .as_array()
            .and_then(|c| c.iter().find(|c| c["url"] == url))
            .ok_or_else(refused)?;
        let reply =
            (self.call)(json!({"op": "libs_entry", "sha384": sha384})).ok_or_else(refused)?;
        let entry = &reply["entry"];
        let same = |k: &str| entry[k].is_string() && entry[k] == card[k];
        if entry["sha384"] != sha384
            || !entry["version"].is_string()
            || !same("host")
            || !same("library")
            || !same("file")
            || same("version")
        {
            return Err(refused());
        }
        let view = view_token().ok_or_else(refused)?;
        let mut map = self.open_with.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(id) && map.len() >= OPEN_WITH_CAP {
            let oldest = map.iter().min_by_key(|(_, s)| s.at).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                map.remove(&k);
            }
        }
        map.insert(
            id.to_string(),
            Substitute {
                hash: hash.to_string(),
                url: url.to_string(),
                sha384: sha384.to_string(),
                view: view.clone(),
                at: Instant::now(),
            },
        );
        Ok(view)
    }
}

/// 128 bits from the OS CSPRNG, as hex. `None` when it cannot be read. Like the core's `store::new_id`, which this
/// crate cannot use (it stays out of the core workspace).
fn view_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Token equality in time independent of where the first difference is.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

fn cards_of(tags: &[Tag], results: &HashMap<String, Value>) -> Value {
    let (mut cards, mut refused, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    let mut pinned = 0;
    for t in tags {
        let Some(r) = results.get(&t.url) else {
            continue;
        };
        // Counted as `rewrite` rewrites: a pinned answer with a malformed hash is served as written.
        if r["state"] == "pinned" && r["sha384"].as_str().is_some_and(valid_hash) {
            pinned += 1;
        }
        if seen.contains(&t.url) {
            continue;
        }
        seen.push(t.url.clone());
        match r["state"].as_str() {
            Some("needs_card") => cards.push(json!({
                "url": r["url"], "host": r["host"], "library": r["library"], "version": r["version"],
                "file": r["file"], "listed": r["listed"], "auto": r["auto"],
                "other_versions": r["other_versions"], "message": r["message"], "integrity": t.integrity,
            })),
            Some("refused") => {
                refused.push(json!({"url": t.url, "text": r["text"], "message": r["message"]}))
            }
            _ => {}
        }
    }
    json!({"cards": cards, "refused": refused, "pinned": pinned})
}

/// Start tags after which the tree builder reads input in a way this parser does not follow (foreign content, select
/// and frameset modes, plain text): nothing after them is read (security review 27b SHOULD-1).
const STOP: [&str; 5] = ["svg", "math", "select", "frameset", "plaintext"];
/// Elements whose content the tokenizer reads as text up to their end tag.
const RAW: [&str; 9] = [
    "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
];

/// (lowercase name, value range inside quotes or bare, quoted)
type Attr = (String, Option<(Range<usize>, bool)>);
struct StartTag {
    name: Range<usize>,
    attrs: Vec<Attr>,
    end: usize,
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

/// Reads a start or end tag from its name to just past `>` as the HTML tokenizer does; `None` at end of input.
fn read_tag(b: &[u8], name_at: usize) -> Option<StartTag> {
    let mut i = name_at;
    while i < b.len() && !is_space(b[i]) && b[i] != b'/' && b[i] != b'>' {
        i += 1;
    }
    let name = name_at..i;
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && (is_space(b[i]) || b[i] == b'/') {
            // A `/` directly before `>` closes the tag; elsewhere it is skipped like a space.
            if b[i] == b'/' && b.get(i + 1) == Some(&b'>') {
                return Some(StartTag {
                    name,
                    attrs,
                    end: i + 2,
                });
            }
            i += 1;
        }
        if *b.get(i)? == b'>' {
            return Some(StartTag {
                name,
                attrs,
                end: i + 1,
            });
        }
        // Attribute name: a leading `=` belongs to it.
        let start = i;
        i += 1;
        while i < b.len() && !is_space(b[i]) && !matches!(b[i], b'/' | b'>' | b'=') {
            i += 1;
        }
        let attr = String::from_utf8_lossy(&b[start..i]).to_ascii_lowercase();
        while i < b.len() && is_space(b[i]) {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            attrs.push((attr, None));
            continue;
        }
        i += 1;
        while i < b.len() && is_space(b[i]) {
            i += 1;
        }
        let value = match b.get(i)? {
            q @ (b'"' | b'\'') => {
                let close = b[i + 1..].iter().position(|c| c == q)? + i + 1;
                let v = i + 1..close;
                i = close + 1;
                Some((v, true))
            }
            b'>' => None,
            _ => {
                let s = i;
                while i < b.len() && !is_space(b[i]) && b[i] != b'>' {
                    i += 1;
                }
                Some((s..i, false))
            }
        };
        attrs.push((attr, value));
    }
}

/// The index just past the end tag `</name` (any case, then a space, `/` or `>`) at or after `from`. The end tag's
/// own attributes are read like a start tag's, quotes included (security review 27b MUST-1).
fn close_of(lower: &str, from: usize, name: &str) -> Option<usize> {
    let needle = format!("</{name}");
    let mut at = from;
    loop {
        let k = lower[at..].find(&needle)? + at;
        let after = k + needle.len();
        match lower.as_bytes().get(after) {
            Some(&c) if is_space(c) || c == b'/' || c == b'>' => {
                return read_tag(lower.as_bytes(), k + 2).map(|t| t.end);
            }
            _ => at = after,
        }
    }
}

/// The first [`MAX_TAGS`] `<script>` tags with a `src` on the five hosts that the parser reads with certainty.
pub fn tags(html: &str) -> Vec<Tag> {
    let b = html.as_bytes();
    // ASCII lowercasing keeps byte offsets.
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut i = 0;
    while out.len() < MAX_TAGS {
        let Some(k) = html[i..].find('<') else {
            break;
        };
        let at = i + k;
        let rest = &lower[at..];
        let skip_to =
            |from: usize, end: &str| lower[from..].find(end).map(|e| from + e + end.len());
        let next = if rest.starts_with("<!--") {
            // The browser ends a comment at or before the first `-->`.
            skip_to(at + 4, "-->")
        } else if rest.starts_with("<!")
            || rest.starts_with("<?")
            || (rest.starts_with("</") && !b.get(at + 2).is_some_and(u8::is_ascii_alphabetic))
        {
            // Doctype, bogus comment, or `</` not followed by a letter: up to the first `>`.
            skip_to(at, ">")
        } else if !b
            .get(at + 1)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'/')
        {
            Some(at + 1)
        } else {
            let end_tag = rest.starts_with("</");
            let Some(tag) = read_tag(b, at + if end_tag { 2 } else { 1 }) else {
                break;
            };
            let name = &lower[tag.name.clone()];
            if end_tag {
                Some(tag.end)
            } else if STOP.contains(&name) {
                break;
            } else if RAW.contains(&name) {
                let end = close_of(&lower, tag.end, name);
                if name == "script" {
                    // A `<!--` in a script body can change where the browser ends it: stop reading the page.
                    if end.is_none_or(|e| lower[tag.end..e].contains("<!--")) {
                        break;
                    }
                    if &html[tag.name.clone()] == "script"
                        && let Some(t) = candidate(html, &tag)
                    {
                        out.push(t);
                    }
                }
                end
            } else {
                Some(tag.end)
            }
        };
        let Some(next) = next else {
            break;
        };
        i = next;
    }
    out
}

/// The tag when it has exactly one quoted `src` on the five hosts, no character reference, space or control in
/// it, and a type that runs (none, `text/javascript` or `module`).
fn candidate(html: &str, tag: &StartTag) -> Option<Tag> {
    let named = |n: &str| tag.attrs.iter().filter(|(a, _)| a == n).collect::<Vec<_>>();
    let [(_, Some((src, true)))] = named("src")[..] else {
        return None;
    };
    let url = &html[src.clone()];
    if url
        .bytes()
        .any(|c| c == b'&' || c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return None;
    }
    let host = url
        .strip_prefix("https://")?
        .split(['/', '?', '#', '\\'])
        .next()?;
    if !HOSTS.contains(&host) {
        return None;
    }
    // `nomodule` never runs in these webviews; a `language` without `type` may name another script language.
    if !named("nomodule").is_empty() || !named("language").is_empty() {
        return None;
    }
    match named("type")[..] {
        [] => {}
        [(_, Some((t, _)))]
            if matches!(
                html[t.clone()].to_ascii_lowercase().as_str(),
                "" | "text/javascript" | "module"
            ) => {}
        _ => return None,
    }
    let integrity = tag
        .attrs
        .iter()
        .find(|(a, _)| a == "integrity")
        .map(|(_, v)| v.as_ref().map_or("", |(r, _)| &html[r.clone()]).to_string());
    Some(Tag {
        src: src.clone(),
        url: url.to_string(),
        integrity,
        crossorigin: !named("crossorigin").is_empty(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::{Artifact, CSP_DEFAULT, CSP_NETWORK, Grants, serve_with, widget_page};
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
    };
    use tauri::http::{Method, Request, Response};

    const LIB1: &[u8] = b"window.lib = 1;\n";
    /// `openssl dgst -sha384` of LIB1 and of `window.lib = 2;\n`.
    const H1: &str = "84a08574beb81de97862e232648923bd3496ee9a04cb3bc00e3d889f0487544899bc3c931d4dbd89fde39ca1e36953c7";
    const H2: &str = "d94491f805e822f2f58946aa452ebd40c61611d91133b1e5414e08adfec464f384c6b860c1d5396ec5727b42a0118db7";
    const CHART: &str = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
    const CHART2: &str = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.2/chart.umd.min.js";
    const JQ: &str = "https://code.jquery.com/jquery-3.7.1.min.js";
    const BADPIN: &str = "https://unpkg.com/bad@1.0.0/x.js";
    const LOOSE: &str = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4/chart.min.js";
    /// The CSP_NETWORK literal before V2-10c.
    const NETWORK_BEFORE: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; font-src data: https:; img-src data: blob: https:; media-src data: blob: https:; worker-src blob:; connect-src https: wss:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    const FIVE: [&str; 5] = [
        "cdnjs.cloudflare.com",
        "cdn.jsdelivr.net",
        "unpkg.com",
        "cdn.tailwindcss.com",
        "code.jquery.com",
    ];

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("libs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(host: &str, library: &str, version: &str, file: &str, sha384: &str) -> Value {
        json!({"host": host, "library": library, "version": version, "file": file, "sha384": sha384})
    }
    fn needs_card(url: &str, version: &str, auto: bool, others: &[&str]) -> Value {
        json!({"state": "needs_card", "url": url, "host": "cdnjs.cloudflare.com", "library": "Chart.js",
            "version": version, "file": "chart.umd.min.js", "listed": true, "auto": auto,
            "other_versions": others, "message": format!("`Chart.js` `{version}` is not on this Mac yet.")})
    }

    /// The core's owner socket: `libs_resolve` and `libs_entry` from tables, every request recorded.
    struct Core {
        calls: Mutex<Vec<Value>>,
        resolve: Mutex<HashMap<String, Value>>,
        entries: HashMap<String, (Value, PathBuf)>,
    }
    impl Core {
        fn new(store: &Path) -> Arc<Self> {
            std::fs::write(store.join(H1), LIB1).unwrap();
            let chart = |v: &str, h: &str| {
                entry("cdnjs.cloudflare.com", "Chart.js", v, "chart.umd.min.js", h)
            };
            let other = |c: char| c.to_string().repeat(96);
            Arc::new(Self {
                calls: Mutex::default(),
                resolve: Mutex::new(HashMap::from([
                    (CHART.to_string(), json!({"state": "pinned", "sha384": H1})),
                    (
                        BADPIN.to_string(),
                        json!({"state": "pinned", "sha384": H1.to_ascii_uppercase()}),
                    ),
                    (
                        CHART2.to_string(),
                        needs_card(CHART2, "4.4.2", false, &["4.4.1"]),
                    ),
                    (
                        LOOSE.to_string(),
                        json!({"state": "refused", "text": 1, "message": "`Chart.js` has no exact version."}),
                    ),
                    (
                        JQ.to_string(),
                        json!({"state": "needs_card", "url": JQ, "host": "code.jquery.com", "library": "jquery",
                            "version": "3.7.1", "file": "jquery-3.7.1.min.js", "listed": false, "auto": true,
                            "other_versions": [], "message": "m"}),
                    ),
                ])),
                entries: HashMap::from([
                    (H1.to_string(), (chart("4.4.1", H1), store.join(H1))),
                    // Not stored: H2's entry names a file that is missing.
                    (H2.to_string(), (chart("4.3.0", H2), store.join(H2))),
                    (
                        other('a'),
                        (
                            entry(
                                "cdn.jsdelivr.net",
                                "Chart.js",
                                "4.4.1",
                                "chart.umd.min.js",
                                &other('a'),
                            ),
                            store.join(other('a')),
                        ),
                    ),
                    (
                        other('b'),
                        (chart_file("4.4.1", &other('b')), store.join(other('b'))),
                    ),
                    (
                        other('c'),
                        (chart("4.4.2", &other('c')), store.join(other('c'))),
                    ),
                    (
                        other('d'),
                        (
                            entry(
                                "cdnjs.cloudflare.com",
                                "chart.js",
                                "4.4.1",
                                "chart.umd.min.js",
                                &other('d'),
                            ),
                            store.join(other('d')),
                        ),
                    ),
                    (
                        other('f'),
                        (
                            json!({"host": "cdnjs.cloudflare.com", "library": "Chart.js", "file": "chart.umd.min.js", "sha384": other('f')}),
                            store.join(other('f')),
                        ),
                    ),
                    // An entry whose path is not named by its hash.
                    (other('e'), (chart("4.4.1", &other('e')), store.join(H1))),
                ]),
            })
        }
        fn answer(&self, request: Value) -> Option<Value> {
            self.calls.lock().unwrap().push(request.clone());
            match request["op"].as_str()? {
                "libs_resolve" => {
                    let table = self.resolve.lock().unwrap();
                    let results: Vec<Value> = request["urls"]
                        .as_array()?
                        .iter()
                        .map(|u| {
                            let u = u.as_str().unwrap();
                            table
                                .get(u)
                                .cloned()
                                .unwrap_or_else(|| needs_card(u, "9.9.9", false, &[]))
                        })
                        .collect();
                    Some(json!({"type": "libs_resolve", "results": results}))
                }
                "libs_entry" => Some(match self.entries.get(request["sha384"].as_str()?) {
                    Some((e, p)) => json!({"type": "libs_entry", "entry": e, "path": p}),
                    None => json!({"type": "libs_entry", "entry": null, "path": null}),
                }),
                _ => None,
            }
        }
        fn resolves(&self) -> Vec<Value> {
            let calls = self.calls.lock().unwrap();
            calls
                .iter()
                .filter(|c| c["op"] == "libs_resolve")
                .cloned()
                .collect()
        }
    }
    fn chart_file(version: &str, h: &str) -> Value {
        entry(
            "cdnjs.cloudflare.com",
            "Chart.js",
            version,
            "chart.min.js",
            h,
        )
    }
    fn libs(core: &Arc<Core>) -> Libs {
        let core = core.clone();
        Libs::new(move |r| core.answer(r))
    }

    /// Pages by id; the hash is the served-bytes hash, like `CoreContent`.
    struct Pages(Mutex<HashMap<String, (String, Option<String>)>>);
    impl Pages {
        fn new(pages: &[(&str, &str)]) -> Self {
            Self(Mutex::new(
                pages
                    .iter()
                    .map(|(id, html)| (id.to_string(), (html.to_string(), None)))
                    .collect(),
            ))
        }
        fn set(&self, id: &str, html: &str, csp: Option<String>) {
            self.0.lock().unwrap().insert(id.into(), (html.into(), csp));
        }
        fn hash(&self, id: &str) -> String {
            self.get(id).unwrap().hash
        }
    }
    impl Content for Pages {
        fn get(&self, id: &str) -> Option<Artifact> {
            let (html, csp) = self.0.lock().unwrap().get(id).cloned()?;
            Some(Artifact {
                hash: crate::artifacts::core_content::hash(html.as_bytes()),
                bytes: html.into_bytes(),
                csp,
            })
        }
    }

    fn get(uri: &str, pages: &Pages, grants: &Grants, libs: &Libs) -> Response<Vec<u8>> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Vec::new())
            .unwrap();
        serve_with(&request, pages, grants, true, libs)
    }
    fn page(id: &str, pages: &Pages, libs: &Libs) -> String {
        String::from_utf8(
            get(
                &format!("nunchiro-artifact://localhost/{id}"),
                pages,
                &Grants::memory(),
                libs,
            )
            .into_body(),
        )
        .unwrap()
    }
    /// The page as the main window's frame loads it after "Open with": `?view=<token>`.
    fn viewed(id: &str, view: &str, pages: &Pages, libs: &Libs) -> String {
        let r = get(
            &format!("nunchiro-artifact://localhost/{id}?view={view}"),
            pages,
            &Grants::memory(),
            libs,
        );
        // The token is never echoed back.
        assert!(
            view.is_empty()
                || r.headers().iter().all(|(_, v)| {
                    !v.as_bytes()
                        .windows(view.len())
                        .any(|w| w == view.as_bytes())
                })
        );
        let body = String::from_utf8(r.into_body()).unwrap();
        assert!(view.is_empty() || !body.contains(view));
        unbooted(&body)
    }
    fn header<'a>(r: &'a Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        r.headers().get(name).and_then(|v| v.to_str().ok())
    }
    fn lib(h: &str) -> String {
        format!("{SOURCE}{h}")
    }
    /// The served page without the bootstrap the app inserts.
    fn unbooted(served: &str) -> String {
        let script = format!("<script>{}</script>", crate::artifacts::BOOTSTRAP.trim());
        served.replacen(&script, "", 1)
    }

    #[test]
    fn rewrite_changes_only_src_of_pinned_tags() {
        let store = scratch("rewrite");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!(
            "<!doctype html><head><script src=\"{CHART}\" integrity=\"sha384-x\" crossorigin=\"anonymous\" defer></script>\n\
             <script type=\"module\" src='{CHART}' async></script><script src=\"{CHART2}\"></script></head>\
             <body><p>{CHART}</p><a href=\"{CHART}\">x</a><script>var u = \"{CHART}\";</script></body>"
        );
        let pages = Pages::new(&[("a1", &html), ("plain", "<p>no libraries</p>")]);
        let expected = html
            .replacen(
                &format!("src=\"{CHART}\""),
                &format!("src=\"{}\"", lib(H1)),
                1,
            )
            .replacen(&format!("src='{CHART}'"), &format!("src='{}'", lib(H1)), 1);
        assert_eq!(unbooted(&page("a1", &pages, &l)), expected);
        // One resolve per page load, distinct urls in page order, the artifact as the requester.
        assert_eq!(
            core.resolves(),
            vec![
                json!({"op": "libs_resolve", "urls": [CHART, CHART2], "requester": "artifact:a1"})
            ]
        );
        // The grant still keys on the original bytes' hash.
        let grants = Grants::memory();
        grants.allow("a1", &crate::artifacts::core_content::hash(html.as_bytes()));
        let r = get("nunchiro-artifact://localhost/a1", &pages, &grants, &l);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_NETWORK.trim())
        );
        // A web widget read page is rewritten the same way.
        pages.set(
            "w-x-0123456789abcdef",
            &html,
            widget_page::csp(&["api.example.com".into()], None),
        );
        assert!(unbooted(&page("w-x-0123456789abcdef", &pages, &l)).contains(&lib(H1)));
        // A page without library tags asks the core nothing and is served as before.
        let before = core.calls.lock().unwrap().len();
        assert_eq!(unbooted(&page("plain", &pages, &l)), "<p>no libraries</p>");
        assert_eq!(core.calls.lock().unwrap().len(), before);
        // No core answer: every tag stays as written.
        let silent = Libs::new(|_| None);
        assert_eq!(unbooted(&page("a1", &pages, &silent)), html);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn rewrite_parser_edge_cases_stay_blocked() {
        let store = scratch("edges");
        let core = Core::new(&store);
        let l = libs(&core);
        let blocked = [
            format!("<!-- <script src=\"{CHART}\"></script> -->"),
            format!("<!-- a --!> <script src=\"{CHART}\"></script> -->"),
            format!("<script src={CHART}></script>"),
            format!("<SCRIPT src=\"{CHART}\"></SCRIPT>"),
            format!("<Script src=\"{CHART}\"></Script>"),
            format!("<script src=\"{CHART}\" src=\"{CHART}\"></script>"),
            format!("<script src=\"{CHART}\" SRC=\"https://example.com/x.js\"></script>"),
            format!("<script src=\"{CHART}&amp;\"></script>"),
            format!("<script src=\" {CHART}\"></script>"),
            "<script src=\"HTTPS://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js\"></script>"
                .to_string(),
            "<script src=\"https://cdnjs.cloudflare.com.evil.example/x.js\"></script>".to_string(),
            format!("<script type=\"text/plain\" src=\"{CHART}\"></script>"),
            format!("<script type=\"module\" type=\"text/plain\" src=\"{CHART}\"></script>"),
            format!("<textarea><script src=\"{CHART}\"></script></textarea>"),
            format!("<noscript><script src=\"{CHART}\"></script></noscript>"),
            format!("<style>a{{}}</style><title><script src=\"{CHART}\"></title>"),
            format!("<svg><script src=\"{CHART}\"></script></svg>"),
            format!("<svg><svg></svg><script src=\"{CHART}\"></script></svg>"),
            format!("<svg></math><script src=\"{CHART}\"></script></svg>"),
            format!("<svg><![CDATA[</svg>]]><script src=\"{CHART}\"></script></svg>"),
            format!("<math><script src=\"{CHART}\"></script></math>"),
            format!("<script>/*<!--*/</script><script src=\"{CHART}\"></script>"),
            format!("<div title='<script src=\"{CHART}\">'></div>"),
            format!("</ <script src=\"{CHART}\"></script>"),
            format!("<plaintext><script src=\"{CHART}\"></script>"),
            // Security review 27b: end tags read their quoted attributes; tree-builder modes stop the read.
            format!("<script></script x='><script src=\"{CHART}\"></script>'>"),
            format!("<style></style x='><script src=\"{CHART}\"></script>'>"),
            format!("<select><iframe><option title='</iframe><script src=\"{CHART}\"></script>'></select>"),
            format!("<svg><p><![CDATA[x><b title='\"]]></svg><script src=\"{CHART}\"></script>'>"),
            format!("<svg/><script src=\"{CHART}\"></script>"),
            format!("<frameset><script src=\"{CHART}\"></script>"),
            format!("<script nomodule src=\"{CHART}\"></script>"),
            format!("<script language=\"vbscript\" src=\"{CHART}\"></script>"),
            format!("<script src=\"{CHART}\">"),
        ];
        for html in &blocked {
            assert_eq!(tags(html), vec![], "{html}");
            assert_eq!(l.rewrite("a1", "h", html), *html, "{html}");
        }
        // The forms the parser reads (controls for the cases above).
        let read = [
            format!("<script src=\"{CHART}\"></script>"),
            format!("<script\tsrc = '{CHART}' type=\"MODULE\"></script>"),
            format!("<script defer src=\"{CHART}\" integrity></script>"),
            format!("<!-- x --><script src=\"{CHART}\"></script><svg></svg>"),
            format!("<script></script x='>'><script src=\"{CHART}\"></script>"),
            format!("<style><script src=x></style><script src=\"{CHART}\"/></script>"),
            format!("<!doctype html><p a=\">\"><script src=\"{CHART}\"></script>"),
        ];
        for html in &read {
            assert_eq!(tags(html).len(), 1, "{html}");
            assert_eq!(
                l.rewrite("a1", "h", html).matches(&lib(H1)).count(),
                1,
                "{html}"
            );
        }
        assert_eq!(tags(&read[2])[0].integrity.as_deref(), Some(""));
        // A tag past the 32nd is left as written.
        let many: String = (0..33)
            .map(|_| format!("<script src=\"{CHART}\"></script>"))
            .collect();
        let out = l.rewrite("a1", "h", &many);
        assert_eq!(out.matches(&lib(H1)).count(), 32);
        assert!(out.ends_with(&format!("<script src=\"{CHART}\"></script>")));
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn integrity_without_crossorigin_loads_pinned() {
        let store = scratch("crossorigin");
        let core = Core::new(&store);
        let l = libs(&core);
        let cases = [
            // integrity, no crossorigin: the attribute is added after the rewritten src, nothing else changes.
            (
                format!("<script src=\"{CHART}\" integrity=\"sha384-x\" defer></script>"),
                format!(
                    "<script src=\"{}\" crossorigin=\"anonymous\" integrity=\"sha384-x\" defer></script>",
                    lib(H1)
                ),
            ),
            (
                format!("<script integrity='sha384-x' src='{CHART}'></script>"),
                format!(
                    "<script integrity='sha384-x' src='{}' crossorigin=\"anonymous\"></script>",
                    lib(H1)
                ),
            ),
            (
                format!("<script src=\"{CHART}\" integrity></script>"),
                format!(
                    "<script src=\"{}\" crossorigin=\"anonymous\" integrity></script>",
                    lib(H1)
                ),
            ),
            // A crossorigin as written is kept as written.
            (
                format!("<script src=\"{CHART}\" integrity=\"sha384-x\" CROSSORIGIN></script>"),
                format!(
                    "<script src=\"{}\" integrity=\"sha384-x\" CROSSORIGIN></script>",
                    lib(H1)
                ),
            ),
            // No integrity: only the src.
            (
                format!("<script src=\"{CHART}\"></script>"),
                format!("<script src=\"{}\"></script>", lib(H1)),
            ),
            // Not pinned: left as written.
            (
                format!("<script src=\"{CHART2}\" integrity=\"sha384-x\"></script>"),
                format!("<script src=\"{CHART2}\" integrity=\"sha384-x\"></script>"),
            ),
        ];
        for (html, served) in &cases {
            assert_eq!(l.rewrite("a1", "h", html), *served, "{html}");
        }
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn hash_is_checked_on_the_bytes_served() {
        let store = scratch("served");
        let core = Core::new(&store);
        let l = libs(&core);
        let pages = Pages::new(&[]);
        let uri = format!("nunchiro-artifact://localhost/lib/{H1}");
        let r = get(&uri, &pages, &Grants::memory(), &l);
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), LIB1);
        // The stored file swapped after pinning: not served.
        std::fs::write(store.join(H1), b"window.lib = 666;\n").unwrap();
        assert_eq!(get(&uri, &pages, &Grants::memory(), &l).status(), 404);
        // A symlink at the store path is not followed, even to the pinned bytes.
        std::fs::write(store.join("elsewhere"), LIB1).unwrap();
        std::fs::remove_file(store.join(H1)).unwrap();
        std::os::unix::fs::symlink(store.join("elsewhere"), store.join(H1)).unwrap();
        assert_eq!(get(&uri, &pages, &Grants::memory(), &l).status(), 404);
        // A missing stored file, and a path not named by its hash, are not served.
        assert_eq!(
            get(
                &format!("nunchiro-artifact://localhost/lib/{H2}"),
                &pages,
                &Grants::memory(),
                &l
            )
            .status(),
            404
        );
        std::fs::remove_file(store.join(H1)).unwrap();
        std::fs::write(store.join(H1), LIB1).unwrap();
        let e = "e".repeat(96);
        assert_eq!(
            get(
                &format!("nunchiro-artifact://localhost/lib/{e}"),
                &pages,
                &Grants::memory(),
                &l
            )
            .status(),
            404
        );
        assert_eq!(get(&uri, &pages, &Grants::memory(), &l).status(), 200);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn lib_route_serves_only_lockfile_hashes() {
        let store = scratch("route");
        let core = Core::new(&store);
        let l = libs(&core);
        let pages = Pages::new(&[]);
        let r = get(
            &format!("nunchiro-artifact://localhost/lib/{H1}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(r.status(), 200);
        let mut headers: Vec<(String, String)> = r
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap().to_string()))
            .collect();
        headers.sort();
        assert_eq!(
            headers,
            [
                ("access-control-allow-origin", "*"),
                ("cache-control", "no-store"),
                ("content-type", "text/javascript"),
                ("x-content-type-options", "nosniff"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string()))
        );
        let unknown = "0".repeat(96);
        for bad in [
            format!("/lib/{}", H1.to_ascii_uppercase()),
            format!("/lib/{}", &H1[..95]),
            format!("/lib/{H1}0"),
            format!("/lib/{unknown}"),
            format!("/lib/{}g", &H1[..95]),
            format!("/lib/../{H1}"),
            format!("/lib/%2e%2e/{H1}"),
            format!("/lib/{H1}/"),
            format!("/lib//{H1}"),
            format!("/lib/{H1}%00"),
            format!("/lib%2f{H1}"),
            format!("/LIB/{H1}"),
            format!("/x/lib/{H1}"),
            format!("/{H1}"),
            "/lib/".to_string(),
        ] {
            assert_eq!(
                get(
                    &format!("nunchiro-artifact://localhost{bad}"),
                    &pages,
                    &Grants::memory(),
                    &l
                )
                .status(),
                404,
                "{bad}"
            );
        }
        // Only GET, and only once the engine is hardened.
        let post = Request::builder()
            .method(Method::POST)
            .uri(format!("nunchiro-artifact://localhost/lib/{H1}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            serve_with(&post, &pages, &Grants::memory(), true, &l).status(),
            404
        );
        let soft = Request::builder()
            .uri(format!("nunchiro-artifact://localhost/lib/{H1}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            serve_with(&soft, &pages, &Grants::memory(), false, &l).status(),
            404
        );
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn page_html_has_no_cors_header() {
        let store = scratch("cors");
        let core = Core::new(&store);
        let l = libs(&core);
        let pages = Pages::new(&[("a1", &format!("<script src=\"{CHART}\"></script>"))]);
        let r = get(
            "nunchiro-artifact://localhost/a1",
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(r.status(), 200);
        assert!(String::from_utf8_lossy(r.body()).contains(&lib(H1)));
        assert!(
            r.headers()
                .keys()
                .all(|k| !k.as_str().starts_with("access-control-"))
        );
        let r = get(
            &format!("nunchiro-artifact://localhost/lib/{H1}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn default_csp_adds_only_the_lib_path_source() {
        let directive = |p: &str, name: &str| {
            p.split(';')
                .map(str::trim)
                .find(|d| d.starts_with(&format!("{name} ")))
                .map(str::to_string)
        };
        assert_eq!(
            directive(CSP_DEFAULT, "script-src").as_deref(),
            Some("script-src 'unsafe-inline' nunchiro-artifact://localhost/lib/")
        );
        let widget = widget_page::csp(&["api.example.com".into()], None).unwrap();
        for p in [CSP_DEFAULT.trim(), widget.as_str()] {
            assert_eq!(p.matches("nunchiro-artifact").count(), 1, "{p}");
            assert!(p.contains(SOURCE));
            assert!(
                !p.split([' ', ';']).any(|t| matches!(
                    t,
                    "nunchiro-artifact:"
                        | "nunchiro-artifact://localhost"
                        | "nunchiro-artifact://localhost/"
                        | "nunchiro-artifact://*"
                )),
                "never the whole scheme: {p}"
            );
            for host in FIVE {
                assert!(!p.contains(host), "{host} in {p}");
            }
        }
        // Everything but the script hosts is as before.
        assert_eq!(
            CSP_DEFAULT
                .trim()
                .replacen(SOURCE, &FIVE.map(|h| format!("https://{h}")).join(" "), 1),
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
        );
    }

    #[test]
    fn act_page_csp_has_no_lib_source() {
        let store = scratch("act");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!("<!doctype html><script>r()</script><script src=\"{CHART}\"></script>");
        let act = widget_page::csp(&["api.example.com".into()], Some(&html)).unwrap();
        assert!(!act.contains("nunchiro-artifact"), "{act}");
        let script = act.split(';').find(|d| d.contains("script-src")).unwrap();
        assert!(
            script.trim().starts_with("script-src 'sha256-") && !script.contains("'unsafe-inline'")
        );
        let id = "w-x-0123456789abcdef-act";
        let pages = Pages::new(&[]);
        pages.set(id, &html, Some(act.clone()));
        let r = get(
            &format!("nunchiro-artifact://localhost/{id}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(header(&r, "content-security-policy"), Some(act.as_str()));
        let body = String::from_utf8(r.into_body()).unwrap();
        assert!(body.contains(&format!("src=\"{CHART}\"")) && !body.contains(SOURCE));
        assert!(body.contains(crate::artifacts::BRIDGE_KEY.trim()));
        assert_eq!(
            l.cards("main", &pages, id, &pages.hash(id)).unwrap(),
            json!({"cards": [], "refused": [], "pinned": 0})
        );
        assert!(
            core.resolves().is_empty(),
            "an act page asks the core nothing"
        );
        let _ = std::fs::remove_dir_all(store);
    }

    // Ticket 366 (V1B-34 unchanged): Chart.js is auto-allowed by default, so the core would start its fetch on a
    // resolve. A page that can act never resolves: no fetch starts, no card, the tag stays unrewritten under a CSP with
    // no library source, so the browser loads nothing.
    #[test]
    fn act_page_never_resolves_a_default_library() {
        let store = scratch("act-default");
        let core = Core::new(&store);
        core.resolve
            .lock()
            .unwrap()
            .insert(CHART2.into(), needs_card(CHART2, "4.4.2", true, &[]));
        let l = libs(&core);
        let html = format!("<!doctype html><script src=\"{CHART2}\"></script><script>r()</script>");
        let act = widget_page::csp(&["api.example.com".into()], Some(&html)).unwrap();
        let id = "w-x-0123456789abcdef-act";
        let pages = Pages::new(&[]);
        pages.set(id, &html, Some(act.clone()));
        let r = get(
            &format!("nunchiro-artifact://localhost/{id}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(header(&r, "content-security-policy"), Some(act.as_str()));
        assert!(
            !act.contains("nunchiro-artifact") && !act.contains("cdnjs"),
            "{act}"
        );
        let body = String::from_utf8(r.into_body()).unwrap();
        assert!(body.contains(&format!("src=\"{CHART2}\"")) && !body.contains(SOURCE));
        assert_eq!(
            l.cards("main", &pages, id, &pages.hash(id)).unwrap(),
            json!({"cards": [], "refused": [], "pinned": 0})
        );
        assert!(core.resolves().is_empty(), "{:?}", core.resolves());
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn page_cannot_request_cards_it_does_not_contain() {
        let store = scratch("cards");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!(
            "<script src=\"{CHART2}\" integrity=\"sha384-abc\" crossorigin=\"anonymous\"></script><script src=\"{LOOSE}\"></script>\
             <script src=\"{CHART}\"></script><script src=\"{CHART}\"></script><script src=\"{CHART2}\"></script>\
             <!-- <script src=\"{JQ}\"></script> --><script src=\"{BADPIN}\"></script>"
        );
        let pages = Pages::new(&[("a1", &html), ("b2", "<p>other</p>")]);
        let hash = pages.hash("a1");
        let cards = l.cards("main", &pages, "a1", &hash).unwrap();
        let mut card = needs_card(CHART2, "4.4.2", false, &["4.4.1"]);
        card.as_object_mut().unwrap().remove("state");
        card["integrity"] = json!("sha384-abc");
        assert_eq!(
            cards,
            json!({"cards": [card], "refused": [{"url": LOOSE, "text": 1, "message": "`Chart.js` has no exact version."}], "pinned": 2})
        );
        // A stale or foreign hash, another window, a bad id: refused.
        let refused = Err("refused".to_string());
        assert_eq!(l.cards("main", &pages, "a1", "stale"), refused);
        assert_eq!(l.cards("main", &pages, "a1", &pages.hash("b2")), refused);
        assert_eq!(l.cards("main", &pages, "b2", &hash), refused);
        assert_eq!(l.cards("artifact", &pages, "a1", &hash), refused);
        assert_eq!(l.cards("", &pages, "a1", &hash), refused);
        assert_eq!(l.cards("main", &pages, "../a1", &hash), refused);
        assert_eq!(l.cards("main", &pages, "nope", &hash), refused);
        // At most 32 tags are read.
        let many: String = (0..40)
            .map(|i| format!("<script src=\"https://unpkg.com/p{i}@1.0.0/x.js\"></script>"))
            .collect();
        pages.set("m", &many, None);
        let cards = l.cards("main", &pages, "m", &pages.hash("m")).unwrap();
        assert_eq!(cards["cards"].as_array().unwrap().len(), 32);
        assert_eq!(
            core.resolves().last().unwrap()["urls"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn open_with_cannot_be_set_by_page_url_or_message() {
        let store = scratch("openwith");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!("<script src=\"{CHART2}\"></script><script src=\"{CHART}\"></script>");
        let pages = Pages::new(&[("a1", &html)]);
        let hash = pages.hash("a1");
        let served = |l: &Libs| unbooted(&page("a1", &pages, l));
        let with_h1 = html
            .replacen(CHART2, &lib(H1), 1)
            .replacen(CHART, &lib(H1), 1);
        let without = html.replacen(CHART, &lib(H1), 1);
        // A query or path names no substitute.
        let r = get(
            &format!("nunchiro-artifact://localhost/a1?open_with={H1}&url={CHART2}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(
            unbooted(&String::from_utf8(r.into_body()).unwrap()),
            without
        );
        assert_eq!(
            get(
                &format!("nunchiro-artifact://localhost/a1/{H1}"),
                &pages,
                &Grants::memory(),
                &l
            )
            .status(),
            404
        );
        // Another window sets nothing.
        let refused = Err("refused".to_string());
        assert_eq!(
            l.set_open_with("artifact", &pages, "a1", &hash, CHART2, H1),
            refused
        );
        assert_eq!(served(&l), without);
        // Checks: a card tag of this page, a pinned entry of the same host, library and file, another version.
        let x = |c: char| c.to_string().repeat(96);
        for (url, sha384) in [
            (CHART2, x('a')),         // another host
            (CHART2, x('b')),         // another file
            (CHART2, x('c')),         // the same version
            (CHART2, x('d')),         // another library (case kept)
            (CHART2, x('f')),         // an entry with no version
            (CHART2, "0".repeat(96)), // no entry
            (CHART2, H1.to_ascii_uppercase()),
            (CHART, H1.to_string()), // a pinned tag is not a card
            (JQ, H1.to_string()),    // not on this page
        ] {
            assert_eq!(
                l.set_open_with("main", &pages, "a1", &hash, url, &sha384),
                refused,
                "{url} {sha384}"
            );
        }
        assert_eq!(
            l.set_open_with("main", &pages, "a1", "stale", CHART2, H1),
            refused
        );
        assert_eq!(served(&l), without);
        // Set: the cards stay as they were (read-only), the next serve shows it once, the one after does not.
        let view = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        l.cards("main", &pages, "a1", &hash).unwrap();
        assert_eq!(viewed("a1", &view, &pages, &l), with_h1);
        assert_eq!(viewed("a1", &view, &pages, &l), without);
        // A content change drops it, even when the content changes back.
        let view = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        pages.set("a1", &format!("{html}<p>edited</p>"), None);
        assert_eq!(
            viewed("a1", &view, &pages, &l),
            format!("{without}<p>edited</p>")
        );
        pages.set("a1", &html, None);
        assert_eq!(viewed("a1", &view, &pages, &l), without);
        let _ = std::fs::remove_dir_all(store);
    }

    /// Two pages with the same card tag; `(store, core, libs, pages, with H1, without)`.
    fn two_pages(name: &str) -> (PathBuf, Arc<Core>, Libs, Pages, String, String) {
        let store = scratch(name);
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!("<script src=\"{CHART2}\"></script>");
        let pages = Pages::new(&[("a1", &html), ("a2", &html)]);
        let with_h1 = html.replacen(CHART2, &lib(H1), 1);
        (store, core, l, pages, with_h1, html)
    }

    #[test]
    fn open_with_is_not_consumed_by_another_id() {
        let (store, _core, l, pages, with_h1, without) = two_pages("otherid");
        let set = |id: &str| {
            l.set_open_with("main", &pages, id, &pages.hash(id), CHART2, H1)
                .unwrap()
        };
        let (v1, v2) = (set("a1"), set("a2"));
        // The ticket's bug: a frame showing a2 navigates itself to /a1 with no token, or with its own.
        assert_eq!(unbooted(&page("a1", &pages, &l)), without);
        assert_eq!(viewed("a1", &v2, &pages, &l), without);
        // A frame on another id, with or without the stolen token, gets its own page and consumes nothing.
        assert_eq!(unbooted(&page("a2", &pages, &l)), without);
        assert_eq!(viewed("a2", &v1, &pages, &l), without);
        assert_eq!(viewed("a1", &v1, &pages, &l), with_h1);
        assert_eq!(viewed("a2", &v2, &pages, &l), with_h1);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn open_with_needs_the_view_token() {
        let (store, _core, l, pages, with_h1, without) = two_pages("needview");
        let view = l
            .set_open_with("main", &pages, "a1", &pages.hash("a1"), CHART2, H1)
            .unwrap();
        let wrong = "0".repeat(view.len());
        assert_eq!(unbooted(&page("a1", &pages, &l)), without);
        for bad in [wrong.as_str(), "", &view[1..], &view.to_ascii_uppercase()] {
            assert_eq!(viewed("a1", bad, &pages, &l), without, "{bad}");
        }
        // Only the `view` parameter names it.
        let r = get(
            &format!("nunchiro-artifact://localhost/a1?v={view}&open_with={view}"),
            &pages,
            &Grants::memory(),
            &l,
        );
        assert_eq!(
            unbooted(&String::from_utf8(r.into_body()).unwrap()),
            without
        );
        assert_eq!(viewed("a1", &view, &pages, &l), with_h1);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn open_with_token_is_single_use_and_unguessable() {
        let (store, _core, l, pages, with_h1, without) = two_pages("single");
        let hash = pages.hash("a1");
        let first = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        let view = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        // 16 random bytes as hex; a fresh one per call, naming no substitute.
        assert_ne!(first, view);
        assert!(view.len() >= 32 && view.bytes().all(|b| b.is_ascii_hexdigit()));
        for t in [&first, &view] {
            assert!(!t.contains(H1) && !H1.contains(t.as_str()) && !t.contains(CHART2));
        }
        // A new "Open with" for the same id replaces the old token.
        assert_eq!(viewed("a1", &first, &pages, &l), without);
        assert_eq!(viewed("a1", &view, &pages, &l), with_h1);
        assert_eq!(viewed("a1", &view, &pages, &l), without);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn open_with_token_bound_to_hash() {
        let (store, _core, l, pages, with_h1, without) = two_pages("hash");
        let hash = pages.hash("a1");
        let view = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        // A stale content hash, another window or a refused check is refused, stores nothing and leaves the live
        // token unconsumed.
        let refused = Err("refused".to_string());
        assert_eq!(
            l.set_open_with("main", &pages, "a1", "stale", CHART2, H1),
            refused
        );
        assert_eq!(
            l.set_open_with("artifact", &pages, "a2", &hash, CHART2, H1),
            refused
        );
        assert_eq!(
            l.set_open_with("main", &pages, "a2", &hash, CHART2, &"0".repeat(96)),
            refused
        );
        assert_eq!(l.open_with.lock().unwrap().len(), 1);
        assert_eq!(viewed("a1", &view, &pages, &l), with_h1);
        // Served under other content, the token substitutes nothing and is dropped, even when the content changes back.
        let view = l
            .set_open_with("main", &pages, "a1", &hash, CHART2, H1)
            .unwrap();
        pages.set("a1", &format!("{without}<p>edited</p>"), None);
        assert_eq!(
            viewed("a1", &view, &pages, &l),
            format!("{without}<p>edited</p>")
        );
        pages.set("a1", &without, None);
        assert_eq!(viewed("a1", &view, &pages, &l), without);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn open_with_state_is_capped() {
        let store = scratch("cap");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!("<script src=\"{CHART2}\"></script>");
        let ids: Vec<String> = (0..=OPEN_WITH_CAP).map(|i| format!("p{i}")).collect();
        let pages = Pages::new(
            &ids.iter()
                .map(|i| (i.as_str(), html.as_str()))
                .collect::<Vec<_>>(),
        );
        let views: Vec<String> = ids
            .iter()
            .map(|i| {
                l.set_open_with("main", &pages, i, &pages.hash(i), CHART2, H1)
                    .unwrap()
            })
            .collect();
        // One past the cap drops the oldest; the rest still work.
        let with_h1 = html.replacen(CHART2, &lib(H1), 1);
        assert_eq!(viewed(&ids[0], &views[0], &pages, &l), html);
        for (i, v) in ids.iter().zip(&views).skip(1) {
            assert_eq!(viewed(i, v, &pages, &l), with_h1, "{i}");
        }
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn network_on_keeps_todays_policy_and_still_serves_pinned_from_cache() {
        let store = scratch("network");
        let core = Core::new(&store);
        let l = libs(&core);
        // Today's policy plus only the library path, so a rewritten tag still loads under the grant.
        assert_eq!(
            CSP_NETWORK
                .trim()
                .replacen(" nunchiro-artifact://localhost/lib/", "", 1),
            NETWORK_BEFORE
        );
        let html = format!("<script src=\"{CHART}\"></script><script src=\"{CHART2}\"></script>");
        let pages = Pages::new(&[("a1", &html)]);
        let grants = Grants::memory();
        grants.allow("a1", &pages.hash("a1"));
        let r = get("nunchiro-artifact://localhost/a1", &pages, &grants, &l);
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(CSP_NETWORK.trim())
        );
        assert_eq!(
            unbooted(&String::from_utf8(r.into_body()).unwrap()),
            html.replacen(CHART, &lib(H1), 1)
        );
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn auto_allowed_tag_is_served_unrewritten_until_pinned() {
        let store = scratch("auto");
        let core = Core::new(&store);
        let l = libs(&core);
        let html = format!("<script src=\"{JQ}\"></script>");
        let pages = Pages::new(&[("a1", &html)]);
        assert_eq!(unbooted(&page("a1", &pages, &l)), html);
        assert_eq!(core.resolves().len(), 1, "one resolve, no waiting");
        let cards = l.cards("main", &pages, "a1", &pages.hash("a1")).unwrap();
        assert_eq!(cards["cards"][0]["auto"], true);
        core.resolve
            .lock()
            .unwrap()
            .insert(JQ.into(), json!({"state": "pinned", "sha384": H1}));
        assert_eq!(
            unbooted(&page("a1", &pages, &l)),
            html.replacen(JQ, &lib(H1), 1)
        );
        let _ = std::fs::remove_dir_all(store);
    }
}
