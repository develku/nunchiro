//! v1b-06: artifacts detected over projected chat events (spec v1b B2). A file the agent wrote or edited with an
//! artifact extension becomes an `artifact` event after the tool result that confirms the write; a
//! `nunchiro-artifact` fenced block in an assistant message becomes one after the caller saved its bytes under
//! `artifacts/<session>/<sha256>.<ext>` of the data folder. Everything here is pure: the caller does the I/O.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Blocks over this are not saved: the file API would not read them back.
pub const MAX_BLOCK: usize = crate::files::MAX_READ as usize;
const MAX_TITLE: usize = 200;

/// The Nunchiro session whose chat this is: blocks are saved under its id, written paths are made relative to its
/// folder (the file API's session root).
pub struct Context<'a> {
    pub session: &'a str,
    pub folder: &'a Path,
    /// v1b-07: the session's artifact folder, `<data folder>/artifacts/<id>` (canonical). Files written there are
    /// read through the data root, and blocks are saved there.
    pub artifacts: &'a Path,
}

/// One detected artifact; `block` holds the bytes the caller must save at the event's `path` (data root) before
/// emitting it.
pub struct Found {
    pub event: Value,
    pub block: Option<Vec<u8>>,
}

fn type_of(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "html" | "htm" => "html",
        "md" => "markdown",
        "svg" => "svg",
        "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
        _ => return None,
    })
}

/// Lexically relative to the session folder; anything else stays as written, so the file API refuses it (an
/// absolute path or `..`) or its confinement does (a symlink out).
// v1b-07: (root, path) of a written file: under the artifact folder it is `artifacts/<id>/<rel>` of the data root, with
// plain components only (no `..`), so another session's folder never maps here.
fn located(path: &str, ctx: &Context) -> (String, String) {
    let p = Path::new(path);
    if let (Ok(rel), Some(id)) = (p.strip_prefix(ctx.artifacts), ctx.artifacts.file_name())
        && p.is_absolute()
        && !rel.as_os_str().is_empty()
        && rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        let rel = Path::new("artifacts").join(id).join(rel);
        return ("data".into(), rel.to_string_lossy().into_owned());
    }
    (ctx.session.into(), relative(path, ctx.folder))
}

/// Only absolute paths below the session's artifacts folder, with no `..`, may come from an exec script.
fn inside_artifacts(path: &str, ctx: &Context) -> bool {
    Path::new(path)
        .strip_prefix(ctx.artifacts)
        .is_ok_and(|rel| {
            Path::new(path).is_absolute()
                && !rel.as_os_str().is_empty()
                && rel
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
        })
}

fn relative(path: &str, folder: &Path) -> String {
    let p = Path::new(path);
    match p.strip_prefix(folder) {
        Ok(rel) if p.is_absolute() && !rel.as_os_str().is_empty() => {
            rel.to_string_lossy().into_owned()
        }
        _ => path.to_string(),
    }
}

/// Strips real tags (`<` then a letter, `/`, `!` or `?`, up to `>`), then decodes entities in one pass, so a bare
/// `<` stays text and an escaped tag stays visible.
fn clean(text: &str) -> String {
    let mut plain = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        plain.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let tag = after
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?'));
        match after.find('>').filter(|_| tag) {
            Some(end) => rest = &after[end + 1..],
            None => {
                plain.push('<');
                rest = after;
            }
        }
    }
    plain.push_str(rest);
    let mut out = String::new();
    let mut rest = plain.as_str();
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let entity = after.find(';').filter(|n| *n <= 10).and_then(|n| {
            let name = &after[..n];
            let c = match name {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .map(|h| u32::from_str_radix(h, 16))
                    .or_else(|| name.strip_prefix('#').map(str::parse::<u32>))
                    .and_then(|n| n.ok())
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, n))
        });
        match entity {
            Some((c, n)) => {
                out.push(c);
                rest = &after[n + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE)
        .collect()
}

/// HTML (or SVG) `<title>`, else the first Markdown heading, else the file name.
pub fn title(kind: &str, text: Option<&str>, path: &str) -> String {
    let found = text.and_then(|text| {
        if kind == "markdown" {
            let mut fence = false;
            text.lines().find_map(|line| {
                let l = line.trim_start();
                if l.starts_with("```") || l.starts_with("~~~") {
                    fence = !fence;
                }
                let hashes = l.chars().take_while(|c| *c == '#').count();
                (!fence && (1..=6).contains(&hashes) && l[hashes..].starts_with([' ', '\t']))
                    .then(|| clean(l[hashes..].trim().trim_end_matches('#')))
            })
        } else {
            let lower = text.to_ascii_lowercase();
            let open = lower.find("<title")?;
            let start = open + lower[open..].find('>')? + 1;
            let end = start + lower[start..].find("</title")?;
            Some(clean(&text[start..end]))
        }
    });
    found.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    })
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `nunchiro-artifact` fenced blocks in Markdown text: (extension, body). Unknown types and unclosed blocks are
/// skipped.
pub fn blocks(text: &str) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    let mut open: Option<(char, usize, Option<&'static str>, Vec<&str>)> = None;
    for line in text.lines() {
        let l = line.trim_start();
        let fence = l.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = fence.map_or(0, |c| l.chars().take_while(|x| *x == c).count());
        if let Some((c, n, ext, body)) = open.as_mut() {
            if fence == Some(*c) && run >= *n && l[run..].trim().is_empty() {
                if let Some(ext) = *ext {
                    out.push((ext, body.join("\n")));
                }
                open = None;
            } else {
                body.push(line);
            }
        } else if run >= 3 {
            let mut info = l[run..].split_whitespace();
            let ext = (info.next() == Some("nunchiro-artifact")).then(|| match info.next() {
                None | Some("html") => Some("html"),
                Some("svg") => Some("svg"),
                Some("md") => Some("md"),
                Some(_) => None,
            });
            // Any other fenced block is still a fence: its body is not searched for artifacts.
            open = Some((fence.unwrap(), run, ext.flatten(), vec![]));
        }
    }
    out
}

/// Codex reports apply_patch as plain text or a JSON envelope with an exit code.
fn patched(output: &Value) -> bool {
    let text = output.as_str().unwrap_or_default();
    if let Ok(v) = serde_json::from_str::<Value>(text)
        && v.is_object()
    {
        return match v["metadata"]["exit_code"].as_i64() {
            Some(code) => code == 0,
            None => v["output"]
                .as_str()
                .is_some_and(|o| o.starts_with("Success")),
        };
    }
    text.starts_with("Success") || text.starts_with("Exit code: 0\n")
}

/// v1b-37: the patch text of each `*** Begin Patch` .. `*** End Patch` block of an exec script, and nothing unless
/// the script calls `tools.apply_patch(`. JS string escapes (`\n \r \t \" \\`) are decoded once; the script is
/// never run. shortcut: text-only parse, so an unused block in a script that also calls it still counts.
pub(super) fn exec_patches(script: &str) -> Vec<String> {
    if !script.contains("tools.apply_patch(") {
        return vec![];
    }
    let mut text = String::new();
    let mut chars = script.chars();
    while let Some(c) = chars.next() {
        match (c, chars.clone().next()) {
            ('\\', Some(e @ ('n' | 'r' | 't' | '"' | '\\'))) => {
                chars.next();
                text.push(match e {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    e => e,
                });
            }
            _ => text.push(c),
        }
    }
    let mut out = vec![];
    let mut block: Option<Vec<&str>> = None;
    for line in text.lines() {
        if let Some(lines) = block.as_mut() {
            if line.trim_start().starts_with("*** End Patch") {
                lines.push("*** End Patch");
                out.push(block.take().unwrap_or_default().join("\n"));
            } else {
                lines.push(line);
            }
        } else if line.trim_end().ends_with("*** Begin Patch") {
            block = Some(vec!["*** Begin Patch"]);
        }
    }
    out
}

/// Files an apply_patch call adds (with their content) or updates; deletions are no artifact.
fn patch_files(patch: &str) -> Vec<(&'static str, String, Option<String>)> {
    let mut out: Vec<(&'static str, String, Option<String>)> = vec![];
    for line in patch.lines() {
        if let Some(p) = line.strip_prefix("*** Add File: ") {
            out.push(("written", p.trim().into(), Some(String::new())));
        } else if let Some(p) = line.strip_prefix("*** Update File: ") {
            out.push(("edited", p.trim().into(), None));
        } else if let Some(p) = line.strip_prefix("*** Move to: ") {
            if let Some(last) = out.last_mut() {
                last.1 = p.trim().into();
            }
        } else if line.starts_with("*** ") {
            if line.starts_with("*** Delete File: ") {
                out.push(("deleted", String::new(), None));
            }
        } else if let Some((_, _, Some(content))) = out.last_mut()
            && let Some(added) = line.strip_prefix('+')
        {
            content.push_str(added);
            content.push('\n');
        }
    }
    out.retain(|f| f.0 != "deleted");
    out
}

fn event(
    tool_id: Value,
    source: &str,
    kind: &str,
    root: &str,
    path: String,
    title: String,
) -> Value {
    json!({"kind":"artifact","tool_id":tool_id,"source":source,"type":kind,"root":root,"path":path,"title":title})
}

/// The artifacts one projected event confirms. `call` finds the `tool_use` event of a tool id among earlier events.
pub fn detect(data: &Value, call: impl Fn(&str) -> Option<Value>, ctx: &Context) -> Vec<Found> {
    let mut out = vec![];
    if data["kind"] == "message" && data["role"] == "assistant" {
        for (ext, body) in blocks(data["text"].as_str().unwrap_or_default()) {
            if body.len() > MAX_BLOCK {
                continue;
            }
            // v1b-07: the artifact folder's id, which a resumed session shares with the run it continues.
            let id = ctx
                .artifacts
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| ctx.session.into());
            let path = format!("artifacts/{id}/{}.{ext}", sha256(body.as_bytes()));
            let kind = type_of(&path).unwrap_or("html");
            let t = title(kind, Some(&body), &path);
            out.push(Found {
                event: event(Value::Null, "block", kind, "data", path, t),
                block: Some(body.into_bytes()),
            });
        }
    }
    if data["kind"] != "tool_result" || data["is_error"] != false {
        return out;
    }
    let Some(id) = data["tool_id"].as_str() else {
        return out;
    };
    let Some(use_) = call(id) else {
        return out;
    };
    let input = &use_["input"];
    let files = match use_["name"].as_str() {
        Some(name @ ("Write" | "Edit" | "MultiEdit")) => input["file_path"]
            .as_str()
            .map(|p| {
                let source = if name == "Write" { "written" } else { "edited" };
                vec![(
                    source,
                    p.to_string(),
                    input["content"].as_str().map(str::to_string),
                )]
            })
            .unwrap_or_default(),
        Some("apply_patch") if patched(&data["output"]) => patch_files(
            input
                .as_str()
                .or_else(|| input["patch"].as_str())
                .or_else(|| input["input"].as_str())
                .unwrap_or_default(),
        ),
        // v1b-36: Codex 0.161.0 runs `tools.apply_patch(patch)` inside the code-mode `exec` script (v1b-37: read through
        // `exec_patches`; the script is never run).
        Some("exec")
            if data["output"][0]["text"]
                .as_str()
                .is_some_and(|t| t.starts_with("Script completed")) =>
        {
            let mut files: Vec<_> = exec_patches(input.as_str().unwrap_or_default())
                .iter()
                .flat_map(|patch| patch_files(patch))
                .collect();
            files.retain(|f| inside_artifacts(&f.1, ctx));
            files
        }
        _ => vec![],
    };
    for (source, path, content) in files {
        let Some(kind) = type_of(&path) else { continue };
        let t = title(kind, content.as_deref(), &path);
        let (root, rel) = located(&path, ctx); // v1b-07
        out.push(Found {
            event: event(json!(id), source, kind, &root, rel, t),
            block: None,
        });
    }
    out
}

/// Saves a block at `rel` under the data folder: 0600 in 0700 folders, atomic, and once (the name is its hash).
/// shortcut: saved blocks are never pruned; add pruning with the Artifacts widget's delete (ticket 13).
pub fn save(home: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let path = home.join(rel);
    if path.symlink_metadata().is_ok() {
        return Ok(());
    }
    let dir = path.parent().ok_or("invalid artifact path")?;
    crate::store::private_dir(&home.join("artifacts"))?;
    crate::store::private_dir(dir)?;
    crate::store::atomic_write(&path, bytes)
}

pub(super) fn valid(data: &Value) -> bool {
    (data["tool_id"].is_null() || data["tool_id"].is_string())
        && matches!(
            data["source"].as_str(),
            Some("written" | "edited" | "block")
        )
        && matches!(
            data["type"].as_str(),
            Some("html" | "svg" | "markdown" | "image")
        )
        && data["root"].as_str().is_some_and(|r| !r.is_empty())
        && data["path"].as_str().is_some_and(|p| !p.is_empty())
        && data["title"].is_string()
}
