//! V2-10c: the exact-version grammar of the five library hosts (spec "Exact-version grammar"). A `<script src>` value
//! becomes a canonical [`Tuple`] or a refusal; nothing is normalised, so a URL that is not already in canonical form
//! is refused and never aliases another key.
use serde::{Deserialize, Serialize};

pub const CDNJS: &str = "cdnjs.cloudflare.com";
pub const JSDELIVR: &str = "cdn.jsdelivr.net";
pub const UNPKG: &str = "unpkg.com";
pub const JQUERY: &str = "code.jquery.com";
pub const TAILWIND: &str = "cdn.tailwindcss.com";
pub const HOSTS: [&str; 5] = [CDNJS, JSDELIVR, UNPKG, JQUERY, TAILWIND];
const URL_MAX: usize = 2048;
const NAME_MAX: usize = 214;

/// The cache key: one file at one exact version of one library on one host. Built only by [`parse`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Tuple {
    pub host: String,
    pub library: String,
    pub version: String,
    /// The file path below the version; empty on cdn.tailwindcss.com, whose versioned path is the script.
    pub file: String,
}
impl Tuple {
    /// The request path rebuilt from the tuple, with its leading `/`.
    pub fn path(&self) -> String {
        let (lib, v, f) = (&self.library, &self.version, &self.file);
        match self.host.as_str() {
            CDNJS => format!("/ajax/libs/{lib}/{v}/{f}"),
            JSDELIVR => format!("/npm/{lib}@{v}/{f}"),
            UNPKG => format!("/{lib}@{v}/{f}"),
            JQUERY => format!("/{f}"),
            _ => format!("/{v}"),
        }
    }
    pub fn url(&self) -> String {
        format!("https://{}{}", self.host, self.path())
    }
}

/// Refusal reasons, exact user-facing text (spec "Refusal reasons" 1-9; 10 is the web's). `<lib>`, `<version>` and
/// `<host>` are filled from the parsed tuple only.
pub fn text(n: u8, lib: &str, version: &str, host: &str) -> String {
    match n {
        1 => format!(
            "`{lib}` has no exact version. Only exact versions load, as in Claude.ai artifacts: ask for `{lib}@1.2.3`, not `@4` or `@latest`."
        ),
        2 => format!(
            "`{host}` is not a library host. Libraries load only from cdnjs, jsDelivr, unpkg, Tailwind's CDN and code.jquery.com."
        ),
        3 => "Nunchiro cannot pin this library address: it needs a package, an exact version and a file, with no query or encoded characters.".into(),
        4 => format!(
            "`{lib}` `{version}` from `{host}` changed since you allowed it. Nunchiro kept your copy and refused the new file."
        ),
        5 => format!(
            "`{lib}` `{version}` from `{host}` does not match the hash cdnjs published. It was not saved."
        ),
        6 => format!(
            "`{lib}` `{version}` is larger than 8 MB, took longer than 30 seconds, or the library cache is full (256 MB). It was not saved."
        ),
        7 => format!(
            "`{lib}` `{version}` is not on this Mac yet. Allow it to fetch it once; until then nothing is fetched."
        ),
        // 7, second text: the fetch could not reach the host.
        70 => format!("Could not reach `{host}`. `{lib}` `{version}` loads once it has been fetched."),
        8 => format!("You did not allow `{lib}` `{version}`. The page runs without it."),
        9 => format!(
            "`{lib}` `{version}` does not match the integrity hash in the page. It was not saved."
        ),
        _ => String::new(),
    }
}

/// Why a URL is not a key: the text number and its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub text: u8,
    pub message: String,
}
fn refuse(n: u8, lib: &str, host: &str) -> Refusal {
    Refusal {
        text: n,
        message: text(n, lib, "", host),
    }
}
fn unparseable() -> Refusal {
    refuse(3, "", "")
}

/// `MAJOR.MINOR.PATCH` with an optional `-` prerelease of `[0-9A-Za-z.-]`; no `+build`.
pub fn exact_version(v: &str) -> bool {
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}
/// A file segment: `[A-Za-z0-9._-]+`, never `.` or `..`.
fn segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= NAME_MAX
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
/// A cdnjs library name, case kept (`Chart.js`).
pub fn cdnjs_library(name: &str) -> bool {
    segment(name)
}
/// An npm name part (scope or name): lowercase, `[a-z0-9][a-z0-9._-]*`.
fn npm_part(s: &str) -> bool {
    s.len() <= NAME_MAX
        && s.as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// One `<script src>` value to its canonical tuple, or the refusal (texts 1-3).
pub fn parse(url: &str) -> Result<Tuple, Refusal> {
    // Only printable ASCII; everything below is matched byte for byte.
    if url.len() > URL_MAX || !url.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(unparseable());
    }
    let rest = url.strip_prefix("https://").ok_or_else(unparseable)?;
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let (authority, query_on_host) = match authority.split_once(['?', '#']) {
        Some((a, _)) => (a, true),
        None => (authority, false),
    };
    // Userinfo and ports are never part of a library host.
    if authority.contains(['@', ':']) {
        return Err(unparseable());
    }
    let Some(host) = HOSTS.iter().find(|h| **h == authority) else {
        let shown = authority
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'));
        return Err(if shown && !authority.is_empty() {
            refuse(2, "", authority)
        } else {
            unparseable()
        });
    };
    // Tailwind's Play CDN with no version (bare host, `/`, `?plugins=`) is unpinned, not unparseable.
    if *host == TAILWIND {
        let bare = path.split(['?', '#']).next().unwrap_or("");
        if query_on_host || bare.is_empty() || bare == "/" {
            return Err(refuse(1, "tailwindcss", host));
        }
    }
    if query_on_host || path.contains(['?', '#', '%', '\\']) {
        return Err(unparseable());
    }
    let segs: Vec<&str> = path
        .strip_prefix('/')
        .ok_or_else(unparseable)?
        .split('/')
        .collect();
    let tuple = |library: &str, version: &str, file: &[&str]| {
        if !exact_version(version) {
            return Err(refuse(1, library, host));
        }
        // A file is required, except Tailwind's versioned path, which is the script itself.
        if file.iter().all(|s| segment(s)) && (!file.is_empty() || *host == TAILWIND) {
            Ok(Tuple {
                host: host.to_string(),
                library: library.into(),
                version: version.into(),
                file: file.join("/"),
            })
        } else {
            Err(unparseable())
        }
    };
    match *host {
        CDNJS => match segs.as_slice() {
            ["ajax", "libs", lib, version, file @ ..] if segment(lib) => tuple(lib, version, file),
            _ => Err(unparseable()),
        },
        JSDELIVR | UNPKG => {
            let segs = if *host == JSDELIVR {
                match segs.as_slice() {
                    ["npm", rest @ ..] => rest,
                    _ => return Err(unparseable()),
                }
            } else {
                &segs[..]
            };
            npm(segs, tuple)
        }
        JQUERY => match segs.as_slice() {
            [file] => {
                let base = [".slim.min.js", ".min.js", ".slim.js", ".js"]
                    .iter()
                    .find_map(|s| file.strip_suffix(s))
                    .ok_or_else(unparseable)?;
                match base.strip_prefix("jquery") {
                    Some("") => tuple("jquery", "", &[file]),
                    Some(v) if v.starts_with('-') => tuple("jquery", &v[1..], &[file]),
                    _ => Err(unparseable()),
                }
            }
            _ => Err(unparseable()),
        },
        _ => match segs.as_slice() {
            [version] => tuple("tailwindcss", version, &[]),
            _ => Err(unparseable()),
        },
    }
}

/// `[@scope/]name@version/file...`, a file path required (no default-file resolution).
fn npm(
    segs: &[&str],
    tuple: impl Fn(&str, &str, &[&str]) -> Result<Tuple, Refusal>,
) -> Result<Tuple, Refusal> {
    let (scope, rest) = match segs.first() {
        Some(s) if s.starts_with('@') => (Some(&s[1..]), &segs[1..]),
        _ => (None, segs),
    };
    let [head, file @ ..] = rest else {
        return Err(unparseable());
    };
    if scope.is_some_and(|s| !npm_part(s)) {
        return Err(unparseable());
    }
    let (name, version) = match head.split_once('@') {
        Some((n, v)) => (n, Some(v)),
        None => (*head, None),
    };
    if !npm_part(name) {
        return Err(unparseable());
    }
    let library = match scope {
        Some(s) => format!("@{s}/{name}"),
        None => name.to_string(),
    };
    tuple(&library, version.unwrap_or(""), file)
}
