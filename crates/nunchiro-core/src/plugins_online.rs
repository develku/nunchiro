//! The plugin catalogue (docs/plugins.md, Browse plugins): `plugins/catalog.json` of this repository, read with the
//! themes' `Client` (one fixed origin, HTTPS, no redirects, byte caps, a deadline). Each entry names a commit, a
//! folder and every file with its SHA-256; Install downloads exactly those files at that commit, checks every hash and
//! writes the plugin only when all of them match. An installed plugin is files on disk: off and not approved, so it
//! runs nothing until the owner reviews it.
//!
//! shortcut: the catalogue is a folder of the main repository, not its own repository; a split only moves `ORIGIN`
//! and `CATALOG`.
use crate::themes_online::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const ORIGIN: &str = "https://raw.githubusercontent.com/develku/nunchiro/";
/// The catalogue itself is read from `main`; what it points at is pinned by commit and hash.
pub const CATALOG: &str = "main/plugins/catalog.json";
const CATALOG_CAP: usize = 256 * 1024;
const FILE_CAP: usize = 256 * 1024;
const MAX_FILES: usize = 50;
const MAX_ENTRIES: usize = 200;
/// One read of the catalogue, and an install's catalogue read and files together: within the CLI's 15 s wait.
const TOTAL: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct File {
    /// Relative to `dir`.
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "CatalogEntry"))]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub about: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub version: String,
    /// How many of each kind it adds (`panel`, `command`, `setting`, `check`).
    #[serde(default)]
    pub adds: BTreeMap<String, u32>,
    /// The hosts its parts may reach.
    #[serde(default)]
    pub network: Vec<String>,
    /// The commit its files are read at (40 hex).
    pub commit: String,
    /// Its folder in the repository at that commit.
    pub dir: String,
    pub files: Vec<File>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    /// The catalogue's format; only 1 is read.
    version: u32,
    plugins: Vec<Entry>,
}

/// A repository path: plain segments of letters, digits, `.`, `_` and `-`, never `.` or `..`.
fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && p.split('/').all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
/// A file's SHA-256 as the catalogue writes it: 64 lowercase hex characters.
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// Short text with no control, bidirectional or hidden characters (what a window row may show).
fn plain(s: &str, max: usize) -> bool {
    s.chars().count() <= max && s.chars().all(crate::delivery::shown)
}
impl Entry {
    fn check(&self) -> Result<(), String> {
        let ok = crate::plugins::valid_id(&self.id)
            && plain(&self.name, 80)
            && plain(&self.about, 400)
            && self.author.as_deref().is_none_or(|a| plain(a, 80))
            && plain(&self.version, 40)
            && self.network.iter().all(|h| plain(h, 253))
            && hex(&self.commit, 40)
            && safe_path(&self.dir)
            && !self.files.is_empty()
            && self.files.len() <= MAX_FILES
            && self
                .files
                .iter()
                .all(|f| safe_path(&f.path) && hex(&f.sha256, 64))
            && self
                .files
                .iter()
                .any(|f| f.path == crate::plugins::MANIFEST);
        if ok {
            Ok(())
        } else {
            Err(format!("the catalogue entry {} is not valid", self.id))
        }
    }
}
/// The entries of a catalogue file; an entry that is not valid is left out.
pub fn parse(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let index: Index =
        serde_json::from_slice(bytes).map_err(|e| format!("the catalogue is not valid: {e}"))?;
    if index.version != 1 {
        return Err(format!(
            "the catalogue's version {} is newer than this Nunchiro reads",
            index.version
        ));
    }
    Ok(index
        .plugins
        .into_iter()
        .take(MAX_ENTRIES)
        .filter(|e| e.check().is_ok())
        .collect())
}

pub struct Catalog {
    origin: String,
    home: PathBuf,
}
impl Catalog {
    pub fn new(home: &Path) -> Self {
        Self {
            origin: ORIGIN.into(),
            home: home.into(),
        }
    }
    /// Test seam: a loopback origin (debug builds; `Client` refuses any other non-HTTPS origin).
    pub fn with_origin(home: &Path, origin: &str) -> Result<Self, String> {
        Client::new(origin, TOTAL)?;
        Ok(Self {
            origin: origin.into(),
            home: home.into(),
        })
    }
    pub fn entries(&self) -> Result<Vec<Entry>, String> {
        parse(&get(&self.origin, TOTAL, CATALOG, CATALOG_CAP)?)
    }
    /// Downloads `id`'s files at its commit, checks each hash, and only then puts the folder in `plugins/<id>`
    /// (an older one goes to `plugins/.removed/`, as Remove does). One mismatch installs nothing.
    pub fn install(&self, id: &str) -> Result<(), String> {
        let until = Instant::now() + TOTAL;
        let entry = self
            .entries()?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| format!("no plugin {id} in the catalogue"))?;
        let mut got = vec![];
        for f in &entry.files {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(crate::themes_online::TIMED_OUT.into());
            }
            let path = format!("{}/{}/{}", entry.commit, entry.dir, f.path);
            let bytes = get(&self.origin, left, &path, FILE_CAP)?;
            if sha256(&bytes) != f.sha256 {
                return Err(format!(
                    "{} of {id} does not match the catalogue (it changed after the catalogue was made); nothing was installed",
                    f.path
                ));
            }
            got.push((f.path.clone(), bytes));
        }
        // One install at a time: two of one id would share the folder they write and the one they set aside.
        let _one = INSTALL.lock().map_err(|_| "plugin installs unavailable")?;
        let plugins = self.home.join(crate::plugins::FOLDER);
        if plugins
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("plugins folder must not be a symlink".into());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&plugins)
            .map_err(|e| e.to_string())?;
        let to = plugins.join(id);
        if to.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
            return Err(format!(
                "a link or a file is in the way at plugins/{id}: move it away first"
            ));
        }
        let fresh = plugins.join(format!(".install-{id}"));
        let _ = fs::remove_dir_all(&fresh);
        // shortcut: files are written 0644, so an executable bit in the repository is lost (parts run `/bin/sh x.sh`);
        // keep the mode in the catalogue when a plugin needs one.
        let written = (|| {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&fresh)
                .map_err(|e| e.to_string())?;
            for (path, bytes) in &got {
                let to = fresh.join(path);
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(to.parent().unwrap_or(&fresh))
                    .map_err(|e| e.to_string())?;
                fs::write(&to, bytes).map_err(|e| e.to_string())?;
            }
            let manifest = fs::read_to_string(fresh.join(crate::plugins::MANIFEST))
                .map_err(|e| e.to_string())?;
            crate::plugins::parse(&manifest, id)?;
            if to.symlink_metadata().is_ok() {
                crate::plugins::set_aside(&self.home, id)?;
            }
            fs::rename(&fresh, &to).map_err(|e| e.to_string())
        })();
        if written.is_err() {
            let _ = fs::remove_dir_all(&fresh);
        }
        written?;
        // An update that asks for nothing beyond its approval stays as it was (Orca's rule); anything else is off
        // until the owner reviews it and turns it on.
        let approved =
            crate::approval::status(&self.home, &format!("{}{id}", crate::plugins::PREFIX))
                .is_ok_and(|v| v.state == crate::approval::State::Approved);
        if approved {
            return Ok(());
        }
        crate::plugins::turn_off(&self.home, id)
    }
}
/// A catalogue fetch; its errors name the plugin list, not the theme server the client was first written for. One
/// literal reason, so the window's error check sees it (web/tests/core-reasons.ts).
fn get(origin: &str, total: Duration, path: &str, cap: usize) -> Result<Vec<u8>, String> {
    Client::new(origin, total)?
        .get(path, cap)
        .map_err(|e| format!("the plugin list could not be read: {}", ours(&e)))
}
fn ours(e: &str) -> String {
    e.replace("theme server", "the plugin catalogue")
}
static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    /// The repository's own catalogue: every entry is valid, and its hashes are the files now in its folder (so
    /// editing a catalogued plugin without running `scripts/plugin-catalog.py` fails here).
    #[test]
    fn the_repositorys_catalogue_matches_its_files() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let bytes = fs::read(root.join("plugins/catalog.json")).unwrap();
        let entries = parse(&bytes).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            entries.len(),
            raw["plugins"].as_array().unwrap().len(),
            "an entry is not valid"
        );
        for e in entries {
            for f in &e.files {
                let file = fs::read(root.join(&e.dir).join(&f.path)).unwrap();
                assert_eq!(
                    sha256(&file),
                    f.sha256,
                    "{}/{}: run scripts/plugin-catalog.py",
                    e.dir,
                    f.path
                );
            }
        }
    }

    #[test]
    fn paths_stay_inside_the_folder() {
        for bad in ["", "..", "a/../b", "/abs", "a//b", "a/./b", "a b", "a\\b"] {
            assert!(!safe_path(bad), "{bad}");
        }
        assert!(safe_path("docs/api/examples/plugins/quiet-hours"));
        assert!(safe_path("plugin.toml"));
    }
}
