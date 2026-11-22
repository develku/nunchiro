//! V2.5-19 (WP1): the pure parts of the browser view. A space is one agent session's browser; its child webview label
//! is derived from the space id, its WKWebsiteDataStore (cookies, storage) from the profile it uses (ticket 264, needs 198).
use std::{net::IpAddr, sync::Mutex};

use sha2::{Digest, Sha256};
use tauri::Url;

/// The agent view never exposes a web inspector (threat model A5): `WebviewBuilder::devtools` gets this in every build, debug included.
pub fn inspectable() -> bool {
    false
}

/// Ports the core listens on (the window's loopback port, noted at boot; the browser listener of the web-access package).
static CORE_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
const BROWSER_LISTENER: u16 = 7788;

pub fn note_core_port(port: u16) {
    if let Ok(mut p) = CORE_PORTS.lock()
        && !p.contains(&port)
    {
        p.push(port);
    }
}

fn digest16(text: &str) -> [u8; 16] {
    let digest = Sha256::digest(text.as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

/// The profile every space uses until the user adds another; it cannot be removed, and an unknown id falls back to it.
pub const BUILT_IN: &str = "default";

/// 16-byte WKWebsiteDataStore identifier (macOS 14+), one per profile (A7). The built-in profile keeps the identifier the
/// "you" store always had, so the logins already in that store survive; other ids hash under a prefix no space ever used.
pub fn store_id(profile: &str) -> [u8; 16] {
    let text = if profile == BUILT_IN {
        "nunchiro-browser-space:you".to_string()
    } else {
        format!("nunchiro-browser-profile:{profile}")
    };
    // WebKit keeps stores per bundle id and the debug app shares the installed app's: a harness (NUNCHIRO_HOME set) gets
    // stores of its own, so it never reaches the owner's cookies. A plain `cargo tauri dev` is unchanged.
    #[cfg(debug_assertions)]
    let text = match std::env::var("NUNCHIRO_HOME") {
        Ok(home) => format!("{text}\n{home}"),
        Err(_) => text,
    };
    digest16(&text)
}

/// Child webview label for a space (labels allow only `[a-zA-Z0-9-/:_]`, and a session id may hold anything).
pub fn label(space: &str) -> String {
    let id = digest16(&format!("nunchiro-browser-space:{space}"));
    format!(
        "browser-{}",
        id[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// The URL bar's text as a page address. Only http and https load: `file:`, `javascript:` and the app's own schemes
/// never come from the bar. A bare host gets `https://`, a loopback host `http://`.
pub fn normalize(input: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Type an address".into());
    }
    let url = if text.contains("://")
        || text.starts_with("about:")
        || text.starts_with("javascript:")
        || text.starts_with("data:")
    {
        Url::parse(text)
    } else {
        let loopback = ["localhost", "127.0.0.1", "[::1]"].iter().any(|h| {
            text == *h || text.starts_with(&format!("{h}:")) || text.starts_with(&format!("{h}/"))
        });
        Url::parse(&format!(
            "{}://{text}",
            if loopback { "http" } else { "https" }
        ))
    }
    .map_err(|e| format!("Not an address: {e}"))?;
    allowed(&url).map(|()| url)
}

/// Ticket 255 (G04): the address bar's text, where text that does not read as an address becomes a search on `engine`
/// (a `Prefs::engine` base). The built URL goes through `allowed` like any other (widget-check G04).
pub fn normalize_search(input: &str, engine: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() || !looks_like_search(text) {
        return normalize(text);
    }
    let url = search_url(text, engine)?;
    allowed(&url).map(|()| url)
}

/// Words, or one word with no dot, port or scheme (`localhost` stays an address). Text with a colon and no space
/// (`javascript:x`, `host:8080`) is never a search, so a refused scheme stays refused.
fn looks_like_search(text: &str) -> bool {
    let spaced = text.contains(char::is_whitespace);
    if text.contains("://") || (text.contains(':') && !spaced) {
        return false;
    }
    let host = text.split(['/', '?', '#']).next().unwrap_or("");
    spaced || (!host.contains('.') && host != "localhost")
}

/// `engine` (a base ending in `?q=`) with the form-encoded query; `allow` is the caller's (a search never skips it).
fn search_url(text: &str, engine: &str) -> Result<Url, String> {
    let mut url = Url::parse(engine).map_err(|e| format!("Not an address: {e}"))?;
    url.query_pairs_mut().clear().append_pair("q", text);
    Ok(url)
}

/// The search engines the setting offers: stored id, query base. The first is the default.
pub const ENGINES: [(&str, &str); 4] = [
    ("google", "https://www.google.com/search?q="),
    ("duckduckgo", "https://duckduckgo.com/?q="),
    ("bing", "https://www.bing.com/search?q="),
    ("kagi", "https://kagi.com/search?q="),
];
/// User agent choices: stored id, string (`None`: WebKit's own).
pub const USER_AGENTS: [(&str, Option<&str>); 3] = [
    ("default", None),
    (
        "safari",
        Some(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        ),
    ),
    (
        "chrome",
        Some(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        ),
    ),
];
pub const SITE_KINDS: [&str; 4] = ["camera", "microphone", "location", "notifications"];
pub const SITE_DECISIONS: [&str; 3] = ["allow", "ask", "deny"];

/// Ticket 255 (G04): the in-app browser defaults, `browser.*` in the core's `settings.json` `features`. Every value is
/// checked again here (a same-user process can edit the file): one outside its list or range reads as the default.
#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    /// A search base from `ENGINES`.
    pub engine: &'static str,
    /// Loads only in a tab the user opens (agent.rs `start_page`).
    pub home: Option<Url>,
    /// Page zoom of a new view, 0.5 to 3.0.
    pub zoom: f64,
    /// Size of an agent's view before the side pane places it (its snapshots), in logical pixels.
    pub viewport: (f64, f64),
    /// "app", "light" or "dark".
    pub appearance: &'static str,
    pub user_agent: Option<&'static str>,
    /// (host, kind, decision) rows; they apply to the "you" store only (mod.rs `site_permission`).
    pub sites: Vec<(String, &'static str, &'static str)>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            engine: ENGINES[0].1,
            home: None,
            zoom: 1.0,
            viewport: (1280.0, 800.0),
            appearance: "app",
            user_agent: None,
            sites: Vec::new(),
        }
    }
}

/// `v` as one of `list`'s rows, found by id (the `'static` row, so no stored text is kept).
fn pick<T: Copy>(v: &serde_json::Value, list: &[(&'static str, T)]) -> Option<(&'static str, T)> {
    let s = v.as_str()?;
    list.iter().find(|(id, _)| *id == s).copied()
}
fn one_of(v: &serde_json::Value, list: &[&'static str]) -> Option<&'static str> {
    let s = v.as_str()?;
    list.iter().find(|id| **id == s).copied()
}
/// A host as typed in the site list: letters, digits, dots and dashes, lowercased, no trailing dot.
fn site_host(v: &serde_json::Value) -> Option<String> {
    let h = v
        .as_str()?
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    (!h.is_empty()
        && h.len() <= 253
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))
    .then_some(h)
}

impl Prefs {
    /// The core's `features` map; a missing or bad key reads as its default, key by key.
    pub fn from_features(f: &serde_json::Value) -> Prefs {
        let d = Prefs::default();
        let viewport = f["browser.viewport"].as_str().and_then(|s| {
            let (w, h) = s.split_once('x')?;
            let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
            ((320..=3840).contains(&w) && (320..=2160).contains(&h))
                .then_some((f64::from(w), f64::from(h)))
        });
        let sites = f["browser.site_permissions"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .take(200)
                    .filter_map(|r| {
                        Some((
                            site_host(&r["host"])?,
                            one_of(&r["kind"], &SITE_KINDS)?,
                            one_of(&r["decision"], &SITE_DECISIONS)?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Prefs {
            engine: pick(&f["browser.search_engine"], &ENGINES).map_or(d.engine, |e| e.1),
            home: f["browser.home_page"]
                .as_str()
                .and_then(|s| normalize(s).ok()),
            zoom: f["browser.zoom"]
                .as_u64()
                .filter(|z| (50..=300).contains(z))
                .map_or(d.zoom, |z| z as f64 / 100.0),
            viewport: viewport.unwrap_or(d.viewport),
            appearance: one_of(&f["browser.appearance"], &["app", "light", "dark"])
                .unwrap_or(d.appearance),
            user_agent: pick(&f["browser.user_agent"], &USER_AGENTS).and_then(|u| u.1),
            sites,
        }
    }

    /// Read on each new view (`show`, agent `create`), so a change applies to new pages; no core reads as the defaults.
    pub fn read() -> Prefs {
        crate::core_call(serde_json::json!({"op": "quit_settings"}))
            .map(|r| Prefs::from_features(&r["settings"]["features"]))
            .unwrap_or_default()
    }
}

const PROFILES_MAX: usize = 16;
const PROFILE_NAME_MAX: usize = 40;
/// `browser.space_profiles` stays under this, inside the core's 4096-byte limit for one value.
const PICKS_BYTES: usize = 4000;
/// Stable prefix: the pane turns this answer into its picker (BrowserView.tsx).
pub const PROFILE_GONE: &str =
    "PROFILE_REMOVED: this space's browser profile was removed; pick one in the Browser pane";
const PICKS_FULL: &str =
    "Too many browser spaces are remembered; forget one in the Browser pane, then try again";
/// A row with this profile asks again: its profile was removed. A missing row would read as a new space, which takes the default.
const ASK_AGAIN: &str = "";

fn picks_value(rows: &[(String, String)]) -> serde_json::Value {
    serde_json::json!(rows.iter().map(|(s, p)| [s, p]).collect::<Vec<_>>())
}

/// `^[a-z0-9-]{1,32}$`: a same-user process can edit the list in `settings.json`, and this text goes into a store id.
fn profile_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Ticket 264 (needs 198): the core's `browser.profiles` (`{"default": id, "list": [{"id", "name"}]}`) and
/// `browser.space_profiles` (`[[space, profile], ...]`, every space's profile since its first view). Written by the window and by this app only: a
/// session's `quit_settings` is refused by the core. Checked again on every read; a bad row is dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct Profiles {
    /// The id a space without a pick uses; always one of `list`.
    pub default: String,
    /// (id, name), the built-in profile first; an empty name shows as the window's word for the built-in profile.
    pub list: Vec<(String, String)>,
    picks: Vec<(String, String)>,
}

impl Profiles {
    pub fn from_features(f: &serde_json::Value) -> Profiles {
        let stored = &f["browser.profiles"];
        let mut list = vec![(BUILT_IN.to_string(), String::new())];
        for row in stored["list"].as_array().into_iter().flatten() {
            let Some(id) = row["id"].as_str().filter(|id| profile_id(id)) else {
                continue;
            };
            let name: String = row["name"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(PROFILE_NAME_MAX)
                .collect();
            if let Some(known) = list.iter_mut().find(|(i, _)| i == id) {
                known.1 = name;
            } else if list.len() < PROFILES_MAX {
                list.push((id.to_string(), name));
            }
        }
        let default = stored["default"]
            .as_str()
            .filter(|d| list.iter().any(|(id, _)| id == d))
            .unwrap_or(BUILT_IN)
            .to_string();
        let picks = f["browser.space_profiles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r[0].as_str()?.to_string(), r[1].as_str()?.to_string())))
            .collect();
        Profiles {
            default,
            list,
            picks,
        }
    }

    /// No core is an error, not the defaults: a view must not open on the built-in profile's logins because of a failed read.
    pub fn read() -> Result<Profiles, String> {
        crate::core_call(serde_json::json!({"op": "quit_settings"}))
            .map(|r| Profiles::from_features(&r["settings"]["features"]))
            .ok_or_else(|| "The browser profiles could not be read; is the core running?".into())
    }

    pub fn known(&self, id: &str) -> bool {
        self.list.iter().any(|(i, _)| i == id)
    }

    /// The profile a space opens on: the default when nothing was picked. A pick of a profile that no longer exists is an
    /// error, never the default: a separate profile is the opt-out from shared logins (A3).
    pub fn resolve(&self, picked: Option<&str>) -> Result<&str, String> {
        match picked {
            None => Ok(self.default.as_str()),
            Some(p) => self
                .list
                .iter()
                .find(|(id, _)| id == p)
                .map(|(id, _)| id.as_str())
                .ok_or_else(|| PROFILE_GONE.to_string()),
        }
    }

    pub fn pick_of(&self, space: &str) -> Option<&str> {
        self.picks
            .iter()
            .find(|(s, _)| s == space)
            .map(|(_, p)| p.as_str())
    }

    /// The `browser.space_profiles` value with `space` on `profile`. No row is evicted: a space without its row would take
    /// the default after a restart. Near the limit the rows of sessions the core no longer lists go (their spaces cannot come
    /// back; `known` is `None` when the list could not be read, and then nothing goes), and past that this refuses.
    pub fn picks_with(
        &self,
        space: &str,
        profile: &str,
        known: impl FnOnce() -> Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        let mut rows: Vec<_> = self
            .picks
            .iter()
            .filter(|(s, _)| s != space)
            .cloned()
            .collect();
        rows.push((space.to_string(), profile.to_string()));
        if picks_value(&rows).to_string().len() > PICKS_BYTES
            && let Some(known) = known()
        {
            rows.retain(|(s, _)| s == space || s == super::agent::YOU || known.contains(s));
        }
        let value = picks_value(&rows);
        if value.to_string().len() > PICKS_BYTES {
            return Err(PICKS_FULL.into());
        }
        Ok(value)
    }

    /// The value with `space` back as it was before a first open that failed.
    pub fn picks_back(&self, space: &str, before: Option<&str>) -> serde_json::Value {
        let mut rows: Vec<_> = self
            .picks
            .iter()
            .filter(|(s, _)| s != space)
            .cloned()
            .collect();
        rows.extend(before.map(|p| (space.to_string(), p.to_string())));
        picks_value(&rows)
    }

    /// The value after `profile` is removed: its picks are dropped and those spaces ask again.
    pub fn picks_asking_again(&self, profile: &str) -> serde_json::Value {
        let rows: Vec<_> = self
            .picks
            .iter()
            .map(|(s, p)| {
                let p = if p == profile { ASK_AGAIN } else { p.as_str() };
                (s.clone(), p.to_string())
            })
            .collect();
        picks_value(&rows)
    }

    /// The `browser.profiles` value without `profile`; a removed default hands over to the built-in profile.
    pub fn without(&self, profile: &str) -> serde_json::Value {
        let list: Vec<_> = self
            .list
            .iter()
            .filter(|(id, name)| id != profile && !(id == BUILT_IN && name.is_empty()))
            .map(|(id, name)| serde_json::json!({"id": id, "name": name}))
            .collect();
        let default = if self.default == profile {
            BUILT_IN
        } else {
            self.default.as_str()
        };
        serde_json::json!({"default": default, "list": list})
    }
}

/// Ticket 264 (A3): the site the space chip names, when the jar holds a sign-in cookie for the page's host. `cookies` are
/// (name, value) of that URL. ponytail: a name heuristic (a session cookie can exist while signed out, and an unusual name is
/// missed); it errs towards showing the chip, the worry being a login nobody noticed. A per-site list if it misleads.
pub fn signed_in_site(host: &str, cookies: &[(&str, &str)]) -> Option<String> {
    const SIGNS: [&str; 6] = ["sess", "auth", "token", "login", "sid", "jwt"];
    cookies
        .iter()
        .any(|(name, value)| {
            let name = name.to_ascii_lowercase();
            !value.is_empty() && SIGNS.iter().any(|s| name.contains(s))
        })
        .then(|| host.trim_start_matches("www.").to_string())
}

/// macOS major version of a `sw_vers -productVersion` text.
fn macos_major(text: &str) -> Option<u32> {
    text.trim().split('.').next()?.parse().ok()
}

/// `WKWebsiteDataStore(forIdentifier:)` needs macOS 14; older systems refuse to open the browser (A7).
pub fn store_supported() -> Result<(), String> {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|e| e.to_string())?;
    match macos_major(&String::from_utf8_lossy(&out.stdout)) {
        Some(v) if v >= 14 => Ok(()),
        _ => Err("The browser needs macOS 14 or newer (separate data per profile)".into()),
    }
}

/// Loopback, unspecified, or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48): where the core answers.
fn core_host(host: &str) -> bool {
    // `localhost.` is the same name; `::ffff:127.0.0.1` is the same address as `127.0.0.1`.
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(a)) if a.to_ipv4_mapped().is_some() => {
            core_host(&a.to_ipv4_mapped().unwrap().to_string())
        }
        Ok(IpAddr::V4(a)) => {
            a.is_loopback()
                || a.is_unspecified()
                || (a.octets()[0] == 100 && a.octets()[1] & 0xc0 == 64)
        }
        Ok(IpAddr::V6(a)) => {
            a.is_loopback() || a.is_unspecified() || a.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
        Err(_) => false,
    }
}

/// The app's own page hosts (the window UI at `http://tauri.localhost`, artifacts), whatever the case or a trailing dot.
fn app_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "tauri.localhost" || host == "nunchiro-artifact.localhost"
}

/// Every navigation of the agent view (typed, link, redirect, script): web pages only, and never the core's own listener
/// ports on loopback or Tailscale addresses (threat model A8, A9), nor the app's own origins, whose page-load handler hands
/// out the window token (A18; `dev` names the dev-load origin). A fixture on another loopback port loads.
/// shortcut: a DNS name that resolves to loopback is not caught, add a resolver check when the web-access listener ships.
pub fn allow(url: &Url, ports: &[u16], dev: impl Fn(&Url) -> bool) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "Only http and https addresses load here, not {}",
            url.scheme()
        ));
    }
    let host = url.host_str().ok_or("The address has no host")?;
    if app_host(host) || dev(url) {
        return Err("That address is the Nunchiro window's own".into());
    }
    if core_host(host)
        && url
            .port_or_known_default()
            .is_some_and(|p| p == BROWSER_LISTENER || ports.contains(&p))
    {
        return Err("That address is Nunchiro's own listener".into());
    }
    Ok(())
}

pub fn allowed(url: &Url) -> Result<(), String> {
    allow(
        url,
        &CORE_PORTS.lock().map(|p| p.clone()).unwrap_or_default(),
        crate::dev_origin,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_dev(_: &Url) -> bool {
        false
    }

    #[test]
    fn agent_view_refuses_own_origins() {
        for bad in [
            "http://tauri.localhost/",
            "http://tauri.localhost:80/",
            "http://TAURI.LOCALHOST/",
            "http://TAURI.localhost:80/x",
            "http://tauri.localhost./",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://nunchiro-artifact.localhost/",
            "https://Nunchiro-Artifact.localhost.:443/x",
        ] {
            let url = Url::parse(bad).unwrap();
            assert!(allow(&url, &[], no_dev).is_err(), "{bad}");
            assert!(normalize(bad).is_err(), "typed {bad}");
        }
        assert!(
            normalize("tauri.localhost").is_err(),
            "bare host in the bar"
        );
        for ok in ["http://localhost:5173/", "http://127.0.0.1:5731/fixture"] {
            assert!(
                allow(&Url::parse(ok).unwrap(), &[51234], no_dev).is_ok(),
                "{ok}"
            );
        }
    }

    #[test]
    fn agent_view_refuses_dev_origin() {
        let dev = Url::parse("http://localhost:5173/").unwrap();
        let is_dev = |u: &Url| u.origin() == dev.origin();
        for bad in [
            "http://localhost:5173/",
            "http://localhost:5173/src/main.tsx?x=1",
        ] {
            assert!(
                allow(&Url::parse(bad).unwrap(), &[], is_dev).is_err(),
                "{bad}"
            );
        }
        assert!(allow(&Url::parse("http://localhost:5174/").unwrap(), &[], is_dev).is_ok());
    }

    /// Ticket 264: the store follows the profile, never the space; a bad or unknown id reads as the default.
    #[test]
    fn space_store_id_derives_from_profile() {
        let f = serde_json::json!({
            "browser.profiles": {"default": "work", "list": [
                {"id": "work", "name": " Work "},
                {"id": "BAD ID", "name": "x"},
                {"id": "../../etc", "name": "y"},
                {"id": "home", "name": "Home"},
            ]},
            "browser.space_profiles": [["s1", "home"], ["s2", "gone"], [1, 2]],
        });
        let p = Profiles::from_features(&f);
        assert_eq!(
            p.list,
            vec![
                (BUILT_IN.to_string(), String::new()),
                ("work".to_string(), "Work".to_string()),
                ("home".to_string(), "Home".to_string()),
            ]
        );
        // Any two spaces with no pick land on one store; a pick moves only that space.
        let store = |space: &str| store_id(p.resolve(p.pick_of(space)).unwrap());
        assert_eq!(store("s7"), store("s8"));
        assert_eq!(store("s7"), store_id("work"));
        assert_eq!(store("s1"), store_id("home"));
        assert_ne!(store("s1"), store("s7"));
        // A pick of a removed profile asks again, never the default (A3).
        assert_eq!(p.resolve(p.pick_of("s2")).unwrap_err(), PROFILE_GONE);
        assert_eq!(p.resolve(Some("../../etc")).unwrap_err(), PROFILE_GONE);
        // A default that is not in the list, or a tampered value, reads as the built-in profile.
        for bad in [
            serde_json::json!({"browser.profiles": {"default": "nope"}}),
            serde_json::json!({"browser.profiles": "all"}),
            serde_json::Value::Null,
        ] {
            let p = Profiles::from_features(&bad);
            assert_eq!((p.default.as_str(), p.list.len()), (BUILT_IN, 1));
            assert_eq!(p.resolve(None).unwrap(), BUILT_IN);
        }
        // The built-in profile is the store the "you" space always had: existing logins stay; no id can collide with it.
        let you = Sha256::digest(b"nunchiro-browser-space:you");
        if std::env::var_os("NUNCHIRO_HOME").is_none() {
            assert_eq!(store_id(BUILT_IN)[..], you[..16]);
        }
        assert_ne!(store_id("you"), store_id(BUILT_IN));
    }

    #[test]
    fn profile_lists_are_capped_and_a_removed_default_hands_over() {
        let many: Vec<_> = (0..40)
            .map(|i| serde_json::json!({"id": format!("p{i}"), "name": "x".repeat(99)}))
            .collect();
        let p = Profiles::from_features(&serde_json::json!({"browser.profiles": {"list": many}}));
        assert_eq!(p.list.len(), PROFILES_MAX);
        assert_eq!(p.list[1].1.len(), PROFILE_NAME_MAX);
        let two = Profiles::from_features(&serde_json::json!({"browser.profiles": {
            "default": "a", "list": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
        }}));
        let left = two.without("a");
        assert_eq!(left["default"], BUILT_IN);
        assert_eq!(left["list"], serde_json::json!([{"id": "b", "name": "B"}]));
        // Rows are never evicted: past the limit only sessions the core no longer lists go, then it refuses.
        let mut p = Profiles::from_features(&serde_json::Value::Null);
        let none = || None;
        let mut i = 0;
        let full = loop {
            match p.picks_with(&format!("s{i}"), "a", none) {
                Ok(rows) => {
                    p = Profiles::from_features(
                        &serde_json::json!({"browser.space_profiles": rows}),
                    )
                }
                Err(e) => break e,
            }
            i += 1;
        };
        assert_eq!(full, PICKS_FULL);
        assert_eq!(p.pick_of("s0"), Some("a"), "the oldest stays");
        let rows = p
            .picks_with("new", "a", || Some(vec!["s1".to_string()]))
            .unwrap();
        let p = Profiles::from_features(&serde_json::json!({"browser.space_profiles": rows}));
        assert_eq!(
            (p.pick_of("s0"), p.pick_of("s1"), p.pick_of("new")),
            (None, Some("a"), Some("a"))
        );
        // A removed profile's spaces ask again; a missing row would read as a new space and take the default.
        let rows = p.picks_asking_again("a");
        let p = Profiles::from_features(&serde_json::json!({"browser.space_profiles": rows}));
        assert_eq!(p.resolve(p.pick_of("s1")).unwrap_err(), PROFILE_GONE);
    }

    #[test]
    fn signed_in_chip_reads_session_cookies_only() {
        let site = |c: &[(&str, &str)]| signed_in_site("www.github.com", c);
        assert_eq!(
            site(&[("_ga", "1"), ("user_session", "x")]).as_deref(),
            Some("github.com")
        );
        assert_eq!(site(&[("_ga", "1"), ("theme", "dark")]), None);
        assert_eq!(site(&[("SID", "")]), None, "an emptied cookie");
    }

    #[test]
    fn per_space_label() {
        assert_ne!(label("a"), label("b"));
        assert!(
            label("a/../x y")
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        );
    }

    #[test]
    fn browser_refuses_without_store_identifier() {
        assert_eq!(macos_major("13.6.1\n"), Some(13));
        assert_eq!(macos_major("27.0"), Some(27));
        assert_eq!(macos_major(""), None);
        assert!(store_supported().is_ok(), "this host is macOS 14+");
    }

    #[test]
    fn agent_view_refuses_app_schemes() {
        for bad in [
            "tauri://localhost/",
            "nunchiro-artifact://x/y",
            "http://nunchiro-artifact.localhost/x",
            "file:///etc/passwd",
            "ipc://localhost/x",
            "asset://x",
            "blob:https://a/b",
            "about:blank",
        ] {
            let url = Url::parse(bad).unwrap();
            // The scheme-named hosts are loopback names but not listener ports; the schemes themselves are refused.
            if !matches!(url.scheme(), "http" | "https") {
                assert!(allow(&url, &[], no_dev).is_err(), "{bad}");
            }
        }
        assert!(allow(&Url::parse("https://example.com").unwrap(), &[], no_dev).is_ok());
    }

    #[test]
    fn agent_view_refuses_core_ports() {
        let ports = [51234];
        for bad in [
            "http://127.0.0.1:51234/",
            "http://localhost:51234",
            "http://[::1]:51234/x",
            "http://127.0.0.1:7788",
            "http://100.101.102.103:7788/",
            "http://[fd7a:115c:a1e0::1]:51234/",
            "http://0.0.0.0:7788",
            "http://foo.localhost:7788",
        ] {
            assert!(
                allow(&Url::parse(bad).unwrap(), &ports, no_dev).is_err(),
                "{bad}"
            );
        }
        for ok in [
            "http://127.0.0.1:5731/fixture",
            "http://localhost:3000",
            "https://example.com:51234/",
            "http://100.63.0.1:7788",
            "http://10.0.0.5:7788",
        ] {
            assert!(
                allow(&Url::parse(ok).unwrap(), &ports, no_dev).is_ok(),
                "{ok}"
            );
        }
    }

    #[test]
    fn agent_view_not_inspectable_in_release() {
        // The builder gets this constant for every build; a change here is a threat-model change (A5).
        assert!(!inspectable());
    }

    /// Ticket 255: text that is not an address becomes a search on the chosen engine, and the result passes `allow`.
    #[test]
    fn address_bar_text_becomes_search_url_that_passes_allow() {
        let duck = ENGINES[1].1;
        let url = normalize_search("rust borrow checker", duck).unwrap();
        assert_eq!(
            url.as_str(),
            "https://duckduckgo.com/?q=rust+borrow+checker"
        );
        assert!(allow(&url, &[], no_dev).is_ok());
        assert_eq!(
            normalize_search("nunchiro", ENGINES[0].1).unwrap().as_str(),
            "https://www.google.com/search?q=nunchiro"
        );
        assert_eq!(
            normalize_search("a&b=c #x", ENGINES[3].1).unwrap().as_str(),
            "https://kagi.com/search?q=a%26b%3Dc+%23x"
        );
        // Addresses stay addresses.
        for (typed, want) in [
            ("example.com/x", "https://example.com/x"),
            ("localhost:5731/a", "http://localhost:5731/a"),
            ("localhost", "http://localhost/"),
        ] {
            assert_eq!(
                normalize_search(typed, duck).unwrap().as_str(),
                want,
                "{typed}"
            );
        }
        // Refusals stay refusals: a scheme or the app's own host is never turned into a search.
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri.localhost",
            "about:blank",
        ] {
            assert!(normalize_search(bad, duck).is_err(), "{bad}");
        }
    }

    /// Ticket 255 (A9, A18): whatever builds a search URL, `allow` still refuses the core's ports and the app's origin;
    /// a stored engine outside the fixed list reads as the default, never as a base pointing home.
    #[test]
    fn search_url_to_core_port_is_still_refused() {
        for base in [
            "http://127.0.0.1:51234/search?q=",
            "http://localhost:7788/?q=",
            "http://tauri.localhost/?q=",
        ] {
            let url = search_url("hello world", base).unwrap();
            assert!(allow(&url, &[51234], no_dev).is_err(), "{base}");
        }
        // The search branch itself checks: refused with no noted ports, so dropping `allowed` there fails here.
        for base in ["http://localhost:7788/?q=", "http://tauri.localhost/?q="] {
            assert!(normalize_search("hello world", base).is_err(), "{base}");
        }
        let tampered =
            serde_json::json!({"browser.search_engine": "http://127.0.0.1:51234/search?q="});
        assert_eq!(Prefs::from_features(&tampered).engine, ENGINES[0].1);
    }

    /// Ticket 255: each `browser.*` value is checked on read; a bad one reads as the default, key by key.
    #[test]
    fn browser_prefs_revalidated_on_read() {
        let good = serde_json::json!({
            "browser.search_engine": "kagi",
            "browser.home_page": "example.com",
            "browser.zoom": 125,
            "browser.viewport": "1440x900",
            "browser.appearance": "dark",
            "browser.user_agent": "safari",
            "browser.site_permissions": [
                {"host": "Meet.Example.", "kind": "camera", "decision": "allow"},
                {"host": "bad host", "kind": "camera", "decision": "allow"},
                {"host": "a.b", "kind": "usb", "decision": "allow"},
            ],
        });
        let p = Prefs::from_features(&good);
        assert_eq!(p.engine, ENGINES[3].1);
        assert_eq!(p.home.clone().unwrap().as_str(), "https://example.com/");
        assert_eq!(
            (p.zoom, p.viewport, p.appearance),
            (1.25, (1440.0, 900.0), "dark")
        );
        assert!(p.user_agent.unwrap().contains("Safari"));
        assert_eq!(
            p.sites,
            vec![("meet.example".to_string(), "camera", "allow")]
        );
        let bad = serde_json::json!({
            "browser.search_engine": 3,
            "browser.home_page": "http://tauri.localhost/",
            "browser.zoom": 9000,
            "browser.viewport": "99999x1",
            "browser.appearance": "neon",
            "browser.user_agent": "Evil/1.0",
            "browser.site_permissions": "all",
        });
        assert_eq!(Prefs::from_features(&bad), Prefs::default());
        assert_eq!(
            Prefs::from_features(&serde_json::Value::Null),
            Prefs::default()
        );
    }

    #[test]
    fn address_bar_accepts_web_only() {
        assert_eq!(
            normalize("example.com/x").unwrap().as_str(),
            "https://example.com/x"
        );
        assert_eq!(
            normalize(" localhost:5731/a ").unwrap().as_str(),
            "http://localhost:5731/a"
        );
        assert_eq!(normalize("http://127.0.0.1:8080").unwrap().scheme(), "http");
        for bad in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "nunchiro-artifact://x",
            "ftp://h/x",
        ] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
    }
}
