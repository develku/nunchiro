//! Web widgets (ticket v1b-22): a folder with `kind = "web"` whose `entry` HTML file the app serves in the artifact
//! sandbox under a per-widget CSP. This module hands out only what that needs: the entry bytes exactly as they were
//! hashed for the approval, the hash, the manifest hosts that are public names, whether `act` is granted, and the
//! bridge's read data (19's `context.json` shape). Owner only, like the script widget requests, and refused while the
//! `web_widgets` setting is off (ticket 23 turns it on) or the folder is not approved as it is now.
use super::Context;
use crate::{
    api::AgentKind,
    approval::{self, Level},
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const OFF: &str = "web widgets are off until security review (settings.json `web_widgets`)";
/// The entry is served whole or not at all (the artifact scheme's file limit).
pub const MAX_ENTRY: usize = 2 * 1024 * 1024;
/// r2: what a person reads in the confirm box before Send (characters, not bytes).
pub const MAX_CHARS: usize = 1000;
/// v1b-34 (needs 52): the hosts the app's artifact default lets scripts load from (`csp-default.txt` `script-src`).
/// Their files sit outside the approval hash, so a page that can act gets none of them in its CSP, and a manifest
/// naming one (its code could be fetched and run inline) cannot get act.
pub const SCRIPT_HOSTS: [&str; 5] = [
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdn.tailwindcss.com",
    "code.jquery.com",
];

/// Why this manifest cannot get act, for the sheet and the grant; `None` when it can or does not ask for it.
pub fn act_refused(manifest: &approval::Manifest) -> Option<String> {
    let hosts: Vec<&str> = manifest
        .network
        .iter()
        .map(String::as_str)
        .filter(|h| SCRIPT_HOSTS.contains(h))
        .collect();
    let asks = manifest.kind == "web" && manifest.permissions.contains(&Level::Act);
    (asks && !hosts.is_empty()).then(|| {
        format!(
            "act refused: a web widget that can act loads scripts only from its own folder, and {} serves code outside the approval; copy the library into the entry file, or allow read only",
            hosts.join(", ")
        )
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "WebPage"))]
pub struct Page {
    pub name: String,
    /// The approval hash of the folder the entry was read from (the app's frame id carries a prefix of it).
    pub hash: String,
    /// Approved manifest hosts that may appear in the frame's CSP (no IP literal, loopback or local name).
    pub network: Vec<String>,
    /// The widget holds an `act` grant for this content.
    pub act: bool,
    pub entry: String,
    pub context: Context,
}

/// Where a web widget's act goes: a running session labelled `session` in the placement's project, or a new
/// `start` agent there. Exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<AgentKind>,
}

/// v1b-34: the window's frame id for a page (app `widget_page.rs`, web `frameId`): `w-<name>-<16 hex of the hash>`,
/// plus `-act` when the page was framed with act (served only while act is granted, under the act policy).
pub fn frame_id(name: &str, hash: &str, act: bool) -> String {
    let prefix = hash.get(..16).unwrap_or(hash);
    format!("w-{name}-{prefix}{}", if act { "-act" } else { "" })
}

pub fn page(home: &Path, enabled: bool, name: &str, context: Context) -> Result<Page, String> {
    if !enabled {
        return Err(OFF.into());
    }
    let proof = approval::check(home, name).map_err(|e| format!("needs approval: {e}"))?;
    let manifest = proof.manifest();
    if manifest.kind != "web" {
        return Err(format!("{name} is not a web widget"));
    }
    // The bytes the approval hashed, never a second read of the folder.
    let file = proof
        .files()
        .iter()
        .find(|f| f.path() == manifest.entry)
        .ok_or_else(|| format!("entry {} is missing", manifest.entry))?;
    if file.bytes().len() > MAX_ENTRY {
        return Err(format!("entry over {} MiB", MAX_ENTRY / (1024 * 1024)));
    }
    let entry = String::from_utf8(file.bytes().to_vec()).map_err(|_| "entry is not UTF-8")?;
    Ok(Page {
        name: name.into(),
        hash: proof.hash().into(),
        network: proof
            .network()
            .iter()
            .filter(|h| public(h))
            .cloned()
            .collect(),
        act: proof.level() == Level::Act,
        entry,
        context,
    })
}

/// A manifest host (already an exact lowercase name) that names a public site: not an IP literal, not a single label
/// and not a local-only suffix, so an approved host can never point the frame at loopback or the user's network.
/// DNS can still resolve a public name to loopback (the artifact grant's documented limit; `http:` stays out).
pub fn public(host: &str) -> bool {
    // An all-digit last label is an IPv4 literal (or no real name); the rest resolve inside the user's network.
    let local = [
        "localhost",
        "local",
        "lan",
        "internal",
        "localdomain",
        "arpa",
    ];
    match host.rsplit_once('.') {
        Some((_, last)) => !last.bytes().all(|b| b.is_ascii_digit()) && !local.contains(&last),
        None => false,
    }
}

/// The act text rules (20's, plus a web widget's text is one line the header confirm shows whole): no line-leading
/// `/`, `!` or `#`, no control or invisible character, at most MAX_CHARS characters, and (r2) no padding that pushes
/// text out of sight: no space character other than U+0020 and never more than 2 spaces in a row.
pub fn check_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("act text is empty; nothing sent".into());
    }
    if text.chars().count() > MAX_CHARS {
        return Err(format!(
            "act text over {MAX_CHARS} characters; nothing sent"
        ));
    }
    if let Some(c) = text.chars().find(|c| c.is_control()) {
        return Err(format!(
            "act text contains a control character (U+{:04X}); nothing sent",
            c as u32
        ));
    }
    if let Some(c) = text.chars().find(|c| c.is_whitespace() && *c != ' ') {
        return Err(format!(
            "act text contains a space other than U+0020 (U+{:04X}); nothing sent",
            c as u32
        ));
    }
    if text.contains("   ") {
        return Err("act text has more than 2 spaces in a row; nothing sent".into());
    }
    super::act::check_leading(text)?;
    // v1b-31: one rule for stacked marks (`act::MAX_MARKS`, a joiner starts no new base), which ink over the next lines
    // without making the confirm box taller.
    super::act::check_visible(text)
}
