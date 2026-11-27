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
pub struct File {
    /// Relative to `dir`.
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "CatalogEntry"))]
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
struct Index {
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
fn plain(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.chars().any(char::is_control)
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
        parse(&Client::new(&self.origin, TOTAL)?.get(CATALOG, CATALOG_CAP)?)
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
            let bytes = Client::new(&self.origin, left)?.get(&path, FILE_CAP)?;
            if sha256(&bytes) != f.sha256 {
                return Err(format!(
                    "{} of {id} does not match the catalogue (it changed after the catalogue was made); nothing was installed",
                    f.path
                ));
            }
            got.push((f.path.clone(), bytes));
        }
        let plugins = self.home.join(crate::plugins::FOLDER);
        let fresh = plugins.join(format!(".install-{id}"));
        let _ = fs::remove_dir_all(&fresh);
        let written = (|| {
            for (path, bytes) in &got {
                let to = fresh.join(path);
                fs::create_dir_all(to.parent().unwrap_or(&fresh)).map_err(|e| e.to_string())?;
                fs::write(&to, bytes).map_err(|e| e.to_string())?;
            }
            let manifest = fs::read_to_string(fresh.join(crate::plugins::MANIFEST))
                .map_err(|e| e.to_string())?;
            crate::plugins::parse(&manifest, id).map(|_| ())
        })();
        if let Err(e) = written {
            let _ = fs::remove_dir_all(&fresh);
            return Err(e);
        }
        let to = plugins.join(id);
        if to.symlink_metadata().is_ok() {
            crate::plugins::set_aside(&self.home, id)?;
        }
        fs::rename(&fresh, &to).map_err(|e| {
            let _ = fs::remove_dir_all(&fresh);
            e.to_string()
        })
    }
}

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
