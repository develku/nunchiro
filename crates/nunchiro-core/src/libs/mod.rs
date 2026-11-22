//! V2-10c (needs 91): the library cache. An owner-approved `<script src>` on one of the five CDN hosts is fetched
//! once by the core, checked, and pinned by hash; the app then serves it from here with no network.
//!
//! - `libs/libs.json`: the lockfile (internal format, version 2, at most [`ENTRIES_CAP`] entries). A broken,
//!   wrong-shape or newer file is never overwritten and none of its entries are served; pins made then last until
//!   the core exits (like `artifact-grants.json`). Version 2 adds `defaults_offered` (ticket 366 r2); a version 1
//!   file is read, and copied once to `libs.json.v1` before the first version 2 write. An older core sets a version 2
//!   file aside untouched (it reads only version 1), so it serves none of its pins until this core runs again.
//! - `libs/sha384/<96 lowercase hex>`: the content-addressed store, written once (temp file, fsync, rename). A path
//!   is only ever built from validated hex, never from URL text.
//! - `libs/verified.json`: a cache of the stat each store file had when it last hashed to its name (V2-37), so a
//!   resolve after a restart does not rehash it. Not trusted for serving (the app hashes what it serves); a broken
//!   file is ignored and replaced.
//!
//! The key is the canonical tuple from [`grammar::parse`]; the fetch URL is rebuilt from it. Allow, auto-allow and
//! Remove are window-only ([`Op`], never an `api::Request`): the third human-only action in ADR Agent CLI authority.
//! Fetches reuse `themes_online::Client` (the system curl, fixed vector, HTTPS only, no redirects, byte cap).
pub mod grammar;

use crate::{api::Reply, store, themes_online::Client};
use grammar::{CDNJS, Tuple, parse, text};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::Duration,
};

pub const FILE_CAP: usize = 8 * 1024 * 1024;
pub const STORE_CAP: u64 = 256 * 1024 * 1024;
pub const ENTRIES_CAP: usize = 512;
pub const RESOLVE_MAX: usize = 32;
pub const TOTAL: Duration = Duration::from_secs(30);
/// Fetches in flight per core; one more waits for a slot.
const MAX_FETCHES: usize = 2;
/// Auto-allowed fetches started by resolve and not finished, per core.
const AUTO_MAX: usize = 4;
const VERSION: u64 = 2;
const REQUESTER_MAX: usize = 200;
const INTEGRITY_MAX: usize = 4096;
/// The shipped cdnjs manifest (scripts/cdnjs-manifest.py); never fetched by the app.
const MANIFEST: &str = include_str!("../../data/cdnjs-sri.json");
/// Ticket 366 (owner 2026-11-09: "auto-allow common cdnjs libraries, by library, from the verified list, without
/// mermaid"): the cdnjs libraries a new lockfile starts with auto-allow on. Each is in the shipped manifest; only an
/// exact version and file the manifest lists, whose sha512 matches it, is pinned without a click. The owner can turn
/// any off (saved in `libs.json` like any switch). Each default is offered once per lockfile (`defaults_offered`), new
/// or existing: switched on unless it is on already, then never again, so one turned off stays off and one added in a
/// later release reaches every install once. A set-aside lockfile gets none.
pub const DEFAULT_AUTO_ALLOW: &[&str] = &[
    "Chart.js",
    "d3",
    "three.js",
    "plotly.js",
    "lodash.js",
    "PapaParse",
    "tone",
    "KaTeX",
    "highlight.js",
    "marked",
    "leaflet",
];
/// [`DEFAULT_AUTO_ALLOW`] as switches.
pub fn default_auto_allow() -> Vec<AutoAllow> {
    DEFAULT_AUTO_ALLOW
        .iter()
        .map(|l| AutoAllow {
            host: CDNJS.into(),
            library: (*l).into(),
        })
        .collect()
}

/// A window op, sent as `{"id":n,"request":{"op":"libs_allow","url":".."}}`. Not an `api::Request`: the owner
/// socket, the CLI and agents cannot express it.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    /// Settings > Artifact libraries: every entry and the auto-allow switches.
    LibsList,
    /// The card's Allow: fetch, check and pin. `integrity` is the page's attribute, when it has one.
    LibsAllow {
        url: String,
        #[serde(default)]
        integrity: Option<String>,
        #[serde(default)]
        requester: String,
    },
    /// "Auto-allow exact versions that match the manifest", per (host, library); cdnjs only.
    LibsAutoAllow {
        host: String,
        library: String,
        on: bool,
    },
    /// Deletes the entry, then its stored file once no entry names that hash.
    LibsRemove { url: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Badge {
    /// The sha512 equals the hash cdnjs published for this library, version and file.
    Verified,
    /// Pinned at first fetch, not checked against a published hash.
    Unverified,
}

/// One pinned file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub host: String,
    /// The canonical path rebuilt from the tuple, with its leading `/`.
    pub path: String,
    pub library: String,
    pub version: String,
    pub file: String,
    /// The store key, 96 lowercase hex.
    pub sha384: String,
    /// 128 lowercase hex.
    pub sha512: String,
    pub size: u64,
    /// Unix seconds.
    pub fetched_at: u64,
    pub badge: Badge,
    /// The session (or widget) whose page first asked.
    pub first_requester: String,
}
impl Entry {
    fn tuple(&self) -> Tuple {
        Tuple {
            host: self.host.clone(),
            library: self.library.clone(),
            version: self.version.clone(),
            file: self.file.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoAllow {
    pub host: String,
    pub library: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lockfile {
    version: u64,
    entries: Vec<Entry>,
    auto_allow: Vec<AutoAllow>,
    /// Ticket 366 r2: the cdnjs libraries of [`DEFAULT_AUTO_ALLOW`] already offered to this lockfile (version 2).
    #[serde(default)]
    defaults_offered: Vec<String>,
}

/// Ticket 366 r2: switches on each default not offered yet (unless on already) and records it as offered. A default
/// the owner turned off is in `defaults_offered`, so it stays off.
fn offer_defaults(file: &mut Lockfile, defaults: &[&str]) {
    for lib in defaults {
        if file.defaults_offered.iter().any(|o| o == lib) {
            continue;
        }
        let key = AutoAllow {
            host: CDNJS.into(),
            library: (*lib).into(),
        };
        if !file.auto_allow.contains(&key) {
            file.auto_allow.push(key);
        }
        file.defaults_offered.push((*lib).into());
    }
}

/// One answer of [`Libs::resolve`], in the order asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Resolved {
    /// Serve `/lib/<sha384>`: the entry exists and its stored file hashes to the pin.
    Pinned {
        sha384: String,
    },
    /// Not pinned (or its stored file is missing or changed): the card. `listed`: the manifest has this library,
    /// version and file ("cdnjs lists this version"); `auto`: an auto-allowed fetch was started, the card shows
    /// until the pin exists; `other_versions`: pinned versions of the same host, library and file ("Open with").
    NeedsCard {
        url: String,
        host: String,
        library: String,
        version: String,
        file: String,
        listed: bool,
        auto: bool,
        other_versions: Vec<String>,
        message: String,
    },
    Refused {
        text: u8,
        message: String,
    },
}

/// Per core (one per `NUNCHIRO_HOME`): the lockfile in memory, and the fetch slots.
struct Shared {
    state: Mutex<State>,
    /// One fetch per tuple at a time: a second Allow for it waits, then finds the pin.
    tuples: (Mutex<BTreeSet<Tuple>>, Condvar),
    slots: (Mutex<usize>, Condvar),
    /// Auto-allowed fetches: started and not finished, and failed (not retried until the core restarts).
    pending: Mutex<Auto>,
    /// 27b item 7: store files that hashed to their name in a resolve, by the stat of the file read then. Loaded
    /// from and saved to `verified.json` (V2-37).
    verified: Mutex<BTreeMap<String, Stamp>>,
}
/// (device, inode, mtime seconds, mtime nanoseconds, size) of a store file.
type Stamp = (u64, u64, i64, i64, u64);
fn stamp(m: &fs::Metadata) -> Stamp {
    (m.dev(), m.ino(), m.mtime(), m.mtime_nsec(), m.size())
}
#[derive(Default)]
struct Auto {
    running: BTreeSet<Tuple>,
    failed: BTreeSet<Tuple>,
}
struct State {
    file: Lockfile,
    /// False when the file on disk is not ours to replace: pins then last until exit.
    writable: bool,
    /// Bytes of new store files being written outside this lock (V2-37), counted against the store cap.
    reserved: u64,
    /// The version 1 file as read, copied to `libs.json.v1` before the first version 2 write (then `None`).
    v1: Option<Vec<u8>>,
}

#[derive(Clone)]
pub struct Libs {
    dir: PathBuf,
    /// `None`: `https://<host>/`. A loopback origin only from [`Libs::with_origin`] (tests).
    origin: Option<String>,
    total: Duration,
    manifest: Arc<Manifest>,
    shared: Arc<Shared>,
}

static CORES: Mutex<BTreeMap<PathBuf, Arc<Shared>>> = Mutex::new(BTreeMap::new());

impl Libs {
    /// The core's cache for `home`; every caller in this process shares one lockfile state.
    pub fn open(home: &Path) -> Self {
        static SHIPPED: OnceLock<Arc<Manifest>> = OnceLock::new();
        let dir = home.join("libs");
        let shared = CORES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(dir.clone())
            .or_insert_with(|| Arc::new(Shared::load(&dir)))
            .clone();
        Self {
            dir,
            origin: None,
            total: TOTAL,
            manifest: SHIPPED
                .get_or_init(|| {
                    Arc::new(Manifest::parse(MANIFEST).unwrap_or_else(|e| {
                        eprintln!("library manifest unreadable, nothing shows as verified: {e}");
                        Manifest::default()
                    }))
                })
                .clone(),
            shared,
        }
    }
    /// Test seam: every host fetched from one loopback origin, a shorter deadline and a manifest in the shipped
    /// format. A fresh state read from disk (a restart). Debug builds only: `Client` refuses http otherwise.
    pub fn with_origin(
        home: &Path,
        origin: &str,
        total: Duration,
        manifest: &str,
    ) -> Result<Self, String> {
        if !origin.starts_with("http://127.0.0.1:") {
            return Err("a test origin must be http://127.0.0.1:<port>/".into());
        }
        Client::new(origin, total)?;
        let dir = home.join("libs");
        Ok(Self {
            shared: Arc::new(Shared::load(&dir)),
            dir,
            origin: Some(origin.into()),
            total,
            manifest: Arc::new(Manifest::parse(manifest)?),
        })
    }

    /// Up to [`RESOLVE_MAX`] `<script src>` values: pinned, needs a card, or refused. Never waits on the network: an
    /// auto-allowed library is fetched on a thread of its own.
    pub fn resolve(&self, urls: &[String], requester: &str) -> Result<Vec<Resolved>, String> {
        if urls.len() > RESOLVE_MAX {
            return Err(format!("at most {RESOLVE_MAX} libraries per page"));
        }
        let requester = clean(requester);
        Ok(urls
            .iter()
            .map(|u| self.resolve_one(u, &requester))
            .collect())
    }
    fn resolve_one(&self, url: &str, requester: &str) -> Resolved {
        let tuple = match parse(url) {
            Ok(t) => t,
            Err(r) => {
                return Resolved::Refused {
                    text: r.text,
                    message: r.message,
                };
            }
        };
        let (entry, others, auto_on) = {
            let s = self.shared.lock();
            let entry = s.file.entries.iter().find(|e| e.tuple() == tuple).cloned();
            let others = s
                .file
                .entries
                .iter()
                .filter(|e| {
                    e.host == tuple.host
                        && e.library == tuple.library
                        && e.file == tuple.file
                        && e.version != tuple.version
                })
                .map(|e| e.version.clone())
                .collect();
            (entry, others, s.auto_allowed(&tuple))
        };
        if let Some(e) = &entry
            && self.verified(&e.sha384)
        {
            return Resolved::Pinned {
                sha384: e.sha384.clone(),
            };
        }
        let listed = self.manifest.expect(&tuple).is_some();
        // Security review S1/S2: a page picks the files, so at most AUTO_MAX run at once (one thread each) and a
        // failed one is not refetched on every view; past that the card shows and the owner's Allow still works.
        let (auto, start) = {
            let mut p = self.shared.pending();
            let running = p.running.contains(&tuple);
            let start = listed
                && auto_on
                && !running
                && !p.failed.contains(&tuple)
                && p.running.len() < AUTO_MAX;
            if start {
                p.running.insert(tuple.clone());
            }
            (running || start, start)
        };
        if start {
            let (me, t, url, who) = (
                self.clone(),
                tuple.clone(),
                url.to_string(),
                requester.to_string(),
            );
            let started = thread::Builder::new().spawn(move || {
                let failed = me.pin(&url, None, &who, true).is_err_and(|e| {
                    eprintln!("{}", failure_line(&url, &e));
                    true
                });
                let mut p = me.shared.pending();
                p.running.remove(&t);
                if failed {
                    p.failed.insert(t);
                }
            });
            if started.is_err() {
                self.shared.pending().running.remove(&tuple);
            }
        }
        Resolved::NeedsCard {
            url: tuple.url(),
            message: text(7, &tuple.library, &tuple.version, &tuple.host),
            host: tuple.host,
            library: tuple.library,
            version: tuple.version,
            file: tuple.file,
            listed,
            auto,
            other_versions: others,
        }
    }

    /// The card's Allow. The refusal texts 1-9 are the errors.
    pub fn allow(
        &self,
        url: &str,
        integrity: Option<&str>,
        requester: &str,
    ) -> Result<Entry, String> {
        self.pin(url, integrity, &clean(requester), false)
    }

    /// Fetch once, check, pin. `auto`: an auto-allowed fetch, kept only on a manifest match.
    fn pin(
        &self,
        url: &str,
        integrity: Option<&str>,
        requester: &str,
        auto: bool,
    ) -> Result<Entry, String> {
        let tuple = parse(url).map_err(|r| r.message)?;
        let msg = |n| text(n, &tuple.library, &tuple.version, &tuple.host);
        let wanted = match integrity.map(str::trim).filter(|i| !i.is_empty()) {
            Some(i) if i.len() > INTEGRITY_MAX => return Err(msg(9)),
            Some(i) => strongest(i),
            None => None,
        };
        let _one = self.shared.tuple_lock(&tuple);
        let existing = self
            .shared
            .lock()
            .file
            .entries
            .iter()
            .find(|e| e.tuple() == tuple)
            .cloned();
        if let Some(e) = &existing
            && let Some(bytes) = self.stored(&e.sha384)
        {
            // Pinned already (a second Allow, or one that waited for this tuple's fetch).
            return if matches_integrity(&bytes, wanted.as_ref()) {
                Ok(e.clone())
            } else {
                Err(msg(9))
            };
        }
        let expect = self.manifest.expect(&tuple).map(str::to_string);
        if auto && expect.is_none() {
            return Err("not auto-allowed: the manifest does not list this file".into());
        }
        // Security review r1 (SHOULD): a full cache (entries or bytes) refuses before any fetch; the size check after
        // the fetch still applies to what arrives.
        if existing.is_none() {
            let s = self.shared.lock();
            let (used, _) = self.used(&s, "");
            if s.file.entries.len() >= ENTRIES_CAP || used + s.reserved >= STORE_CAP {
                return Err(msg(6));
            }
        }
        let bytes = {
            let _slot = self.shared.slot();
            self.fetch(&tuple).map_err(|e| {
                eprintln!("{}", failure_line(&tuple.url(), &e));
                if e == crate::themes_online::TOO_LARGE || e == crate::themes_online::TIMED_OUT {
                    msg(6)
                } else {
                    msg(70)
                }
            })?
        };
        if bytes.is_empty() {
            eprintln!("{}", failure_line(&tuple.url(), "an empty body"));
            return Err(msg(70));
        }
        let sha384 = hex(&Sha384::digest(&bytes));
        let sha512 = Sha512::digest(&bytes);
        if let Some(e) = &existing
            && e.sha384 != sha384
        {
            return Err(msg(4));
        }
        let badge = match &expect {
            Some(x) if *x == format!("sha512-{}", base64(&sha512)) => Badge::Verified,
            Some(_) => return Err(msg(5)),
            None => Badge::Unverified,
        };
        if !matches_integrity(&bytes, wanted.as_ref()) {
            return Err(msg(9));
        }
        if let Some(e) = existing {
            // The stored file was missing or changed; the refetch equals the pin.
            self.put(&sha384, &bytes)?;
            return Ok(e);
        }
        // V2-37: the store file is written and fsynced outside the state lock; its bytes are reserved meanwhile.
        let new = {
            let mut s = self.shared.lock();
            if s.file.entries.len() >= ENTRIES_CAP {
                return Err(msg(6));
            }
            let (used, stored) = self.used(&s, &sha384);
            let new = if stored { 0 } else { bytes.len() as u64 };
            if used + s.reserved + new > STORE_CAP {
                return Err(msg(6));
            }
            s.reserved += new;
            Reserved(&self.shared, new)
        };
        #[cfg(test)]
        tests::step("before_put", &self.shared);
        let put = self.put(&sha384, &bytes);
        #[cfg(test)]
        tests::step("after_put", &self.shared);
        // Released before the re-lock; the file now on disk counts instead.
        drop(new);
        put?;
        let mut s = self.shared.lock();
        // Another tuple may have taken the last entry meanwhile; the file stays and counts as on disk.
        if s.file.entries.len() >= ENTRIES_CAP {
            return Err(msg(6));
        }
        // Round 2: a Remove of another entry naming these bytes may have deleted the file since `put` (which skips
        // bytes already stored). Refused rather than rewritten, so no fsync runs under the lock; Allow again works.
        if !self.present(&sha384, bytes.len() as u64) {
            return Err("could not save the library: its stored file was removed meanwhile".into());
        }
        let entry = Entry {
            host: tuple.host.clone(),
            path: tuple.path(),
            library: tuple.library.clone(),
            version: tuple.version.clone(),
            file: tuple.file.clone(),
            sha384,
            sha512: hex(&sha512),
            size: bytes.len() as u64,
            fetched_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            badge,
            first_requester: requester.to_string(),
        };
        s.file.entries.push(entry.clone());
        self.save(&mut s);
        Ok(entry)
    }

    /// Bytes the store holds against [`STORE_CAP`]: each entry's file once, plus every other file in the store folder
    /// (files a set-aside lockfile may name, leftover `.tmp` files) by its length. And whether `sha384` is already
    /// counted.
    fn used(&self, s: &State, sha384: &str) -> (u64, bool) {
        let mut seen = BTreeSet::new();
        let mut used: u64 = s
            .file
            .entries
            .iter()
            .filter(|e| seen.insert(e.sha384.as_str()))
            .map(|e| e.size)
            .sum();
        let mut stored = seen.contains(sha384);
        for f in fs::read_dir(self.dir.join("sha384"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if seen.contains(name.as_ref()) {
                continue;
            }
            stored |= name == sha384;
            used += f.metadata().map_or(0, |m| m.len());
        }
        (used, stored)
    }

    fn fetch(&self, tuple: &Tuple) -> Result<Vec<u8>, String> {
        let origin = match &self.origin {
            Some(o) => o.clone(),
            None => format!("https://{}/", tuple.host),
        };
        // The path is the tuple's own: `[A-Za-z0-9._@/-]` only, nothing to encode.
        Client::new(&origin, self.total)?.get(&tuple.path()[1..], FILE_CAP)
    }

    pub fn remove(&self, url: &str) -> Result<(), String> {
        let tuple = parse(url).map_err(|r| r.message)?;
        let _one = self.shared.tuple_lock(&tuple);
        let mut s = self.shared.lock();
        let Some(i) = s.file.entries.iter().position(|e| e.tuple() == tuple) else {
            return Err("that library is not pinned".into());
        };
        let gone = s.file.entries.remove(i);
        self.save(&mut s);
        // A set-aside lockfile may still name the hash (security review S3): its store files stay.
        if s.writable && !s.file.entries.iter().any(|e| e.sha384 == gone.sha384) {
            let _ = fs::remove_file(self.store_path(&gone.sha384));
        }
        Ok(())
    }

    pub fn auto_allow(&self, host: &str, library: &str, on: bool) -> Result<(), String> {
        // Only cdnjs is in the manifest, so the switch exists only for cdnjs libraries.
        if host != CDNJS || !grammar::cdnjs_library(library) {
            return Err("auto-allow is only for cdnjs libraries".into());
        }
        let key = AutoAllow {
            host: host.into(),
            library: library.into(),
        };
        let mut s = self.shared.lock();
        s.file.auto_allow.retain(|a| *a != key);
        if on {
            s.file.auto_allow.push(key);
        }
        self.save(&mut s);
        Ok(())
    }

    /// Every entry, the auto-allow switches, and whether they are saved (false: a lockfile set aside).
    pub fn list(&self) -> (Vec<Entry>, Vec<AutoAllow>, bool) {
        let s = self.shared.lock();
        (
            s.file.entries.clone(),
            s.file.auto_allow.clone(),
            s.writable,
        )
    }

    /// For the app's `/lib/<hash>` route (27b): the entry naming `sha384` and its store path, built from validated
    /// hex only. The caller hashes the bytes it serves; this does not read the file.
    pub fn served(&self, sha384: &str) -> Option<(Entry, PathBuf)> {
        if !valid_hash(sha384) {
            return None;
        }
        let entry = self
            .shared
            .lock()
            .file
            .entries
            .iter()
            .find(|e| e.sha384 == sha384)
            .cloned()?;
        Some((entry, self.store_path(sha384)))
    }

    /// The store file is there as a regular file of `size` bytes (opened without following a link, like a read).
    fn present(&self, sha384: &str, size: u64) -> bool {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.store_path(sha384))
            .and_then(|f| f.metadata())
            .is_ok_and(|m| m.is_file() && m.len() == size)
    }
    fn store_path(&self, sha384: &str) -> PathBuf {
        debug_assert!(valid_hash(sha384));
        self.dir.join("sha384").join(sha384)
    }
    /// The stored bytes, only when they hash to the name.
    fn stored(&self, sha384: &str) -> Option<Vec<u8>> {
        self.read_store(sha384).map(|(bytes, _)| bytes)
    }
    /// The stored bytes and the stat of the file they were read from (fstat, not the path).
    fn read_store(&self, sha384: &str) -> Option<(Vec<u8>, fs::Metadata)> {
        if !valid_hash(sha384) {
            return None;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.store_path(sha384))
            .ok()?;
        // Ticket 421 round 3: only a regular file is read; a FIFO would hold the job (and `tuple_lock`) forever.
        let meta = file.metadata().ok().filter(|m| m.is_file())?;
        let mut bytes = vec![];
        file.take(FILE_CAP as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= FILE_CAP && hex(&Sha384::digest(&bytes)) == sha384).then_some((bytes, meta))
    }
    /// Resolve's check (27b item 7): a store file whose lstat equals the stat it had when it last hashed to its name
    /// is not read again; any other file is read and hashed. The app's `/lib/` route still hashes what it serves.
    /// shortcut: a same-user write that keeps inode, mtime and size (mtime can be set back) is not seen here, as for
    /// any `libs/` write; add ctime once a no-read check other than chmod exists (acceptance 12 uses chmod).
    fn verified(&self, sha384: &str) -> bool {
        let now = fs::symlink_metadata(self.store_path(sha384))
            .ok()
            .filter(|m| m.file_type().is_file())
            .map(|m| stamp(&m));
        let mut seen = self
            .shared
            .verified
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if now.is_some() && seen.get(sha384) == now.as_ref() {
            return true;
        }
        seen.remove(sha384);
        drop(seen);
        let Some((_, meta)) = self.read_store(sha384) else {
            return false;
        };
        let named: BTreeSet<String> = self
            .shared
            .lock()
            .file
            .entries
            .iter()
            .map(|e| e.sha384.clone())
            .collect();
        let mut seen = self
            .shared
            .verified
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        seen.insert(sha384.to_string(), stamp(&meta));
        // Saved only when a file verifies anew, with only the hashes an entry names.
        seen.retain(|h, _| named.contains(h));
        let saved = store::private_dir(&self.dir).and_then(|()| {
            let bytes = serde_json::to_vec(&*seen).map_err(|e| e.to_string())?;
            store::atomic_write(&self.dir.join("verified.json"), &bytes)
        });
        if let Err(e) = saved {
            eprintln!("could not save the library stamps: {e}");
        }
        true
    }
    /// Writes the store file once; a name already holding these bytes is left as it is. A name holding other bytes
    /// (a changed file) is replaced by the pinned bytes, never the reverse.
    fn put(&self, sha384: &str, bytes: &[u8]) -> Result<(), String> {
        if !valid_hash(sha384) {
            return Err("not a store hash".into());
        }
        if self.stored(sha384).is_some() {
            return Ok(());
        }
        let folder = self.dir.join("sha384");
        store::private_dir(&self.dir)?;
        store::private_dir(&folder)?;
        let tmp = folder.join(format!(".{}.tmp", store::new_id()?));
        let result = (|| {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            #[cfg(test)]
            tests::step("fsync", &self.shared);
            fs::rename(&tmp, self.store_path(sha384))?;
            fs::File::open(&folder)?.sync_all()
        })()
        .map_err(|e| format!("could not save the library: {e}"));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
    fn save(&self, s: &mut State) {
        if !s.writable {
            return;
        }
        if let Some(old) = &s.v1 {
            let backup = self.dir.join("libs.json.v1");
            // Kept once: an existing backup (from an earlier upgrade) is not replaced.
            let kept = match fs::symlink_metadata(&backup) {
                Ok(_) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    store::atomic_write(&backup, old)
                }
                Err(e) => Err(e.to_string()),
            };
            if let Err(e) = kept {
                eprintln!(
                    "library lockfile not saved: could not keep the version 1 copy first: {e}"
                );
                s.writable = false;
                return;
            }
            s.v1 = None;
        }
        let result = store::private_dir(&self.dir).and_then(|()| {
            let bytes = serde_json::to_vec_pretty(&s.file).map_err(|e| e.to_string())?;
            store::atomic_write(&self.dir.join("libs.json"), &bytes)
        });
        if let Err(e) = result {
            eprintln!("could not save the library lockfile: {e}");
            // Q9 ja-J13-2: the list then says changes last only until Nunchiro quits, as for a set-aside file.
            s.writable = false;
        }
    }
}

impl Shared {
    fn load(dir: &Path) -> Self {
        let (mut file, writable, v1) = match read_lockfile(dir) {
            Ok(Some((file, v1))) => (file, true, v1),
            // No lockfile yet: the defaults are offered below, saved with the first change (ticket 366).
            Ok(None) => (
                Lockfile {
                    version: VERSION,
                    ..Default::default()
                },
                true,
                None,
            ),
            Err(e) => {
                eprintln!(
                    "library lockfile {} not used, left as it is: {e}",
                    dir.join("libs.json").display()
                );
                (
                    Lockfile {
                        version: VERSION,
                        ..Default::default()
                    },
                    false,
                    None,
                )
            }
        };
        // Ticket 366 r2: new and existing lockfiles alike; a set-aside one is not ours to change.
        if writable {
            file.version = VERSION;
            offer_defaults(&mut file, DEFAULT_AUTO_ALLOW);
        }
        Self {
            state: Mutex::new(State {
                file,
                writable,
                reserved: 0,
                v1,
            }),
            tuples: (Mutex::default(), Condvar::new()),
            slots: (Mutex::new(0), Condvar::new()),
            pending: Mutex::default(),
            verified: Mutex::new(read_stamps(dir)),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn pending(&self) -> std::sync::MutexGuard<'_, Auto> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn tuple_lock(&self, tuple: &Tuple) -> TupleLock<'_> {
        let (busy, freed) = &self.tuples;
        let mut set = busy.lock().unwrap_or_else(|e| e.into_inner());
        while set.contains(tuple) {
            set = freed.wait(set).unwrap_or_else(|e| e.into_inner());
        }
        set.insert(tuple.clone());
        TupleLock(self, tuple.clone())
    }
    fn slot(&self) -> Slot<'_> {
        let (count, freed) = &self.slots;
        let mut n = count.lock().unwrap_or_else(|e| e.into_inner());
        while *n >= MAX_FETCHES {
            n = freed.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        Slot(self)
    }
}
impl State {
    fn auto_allowed(&self, t: &Tuple) -> bool {
        self.file
            .auto_allow
            .iter()
            .any(|a| a.host == t.host && a.library == t.library)
    }
}
struct TupleLock<'a>(&'a Shared, Tuple);
impl Drop for TupleLock<'_> {
    fn drop(&mut self) {
        let (busy, freed) = &self.0.tuples;
        busy.lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.1);
        freed.notify_all();
    }
}
/// Store bytes reserved by a pin writing outside the state lock; released on drop, a panic included.
struct Reserved<'a>(&'a Shared, u64);
impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.0.lock().reserved -= self.1;
    }
}
struct Slot<'a>(&'a Shared);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let (count, freed) = &self.0.slots;
        *count.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        freed.notify_one();
    }
}

/// A version 1 lockfile's bytes as read, kept for its one-time copy.
type V1Bytes = Option<Vec<u8>>;
/// `Ok(None)`: no lockfile yet. `Err`: one that is not ours to read or replace (broken, wrong shape, a broken
/// relation between fields, or a newer version). With the file, its bytes when it is version 1 (for the backup).
fn read_lockfile(dir: &Path) -> Result<Option<(Lockfile, V1Bytes)>, String> {
    store::private_dir(dir)?;
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join("libs.json"))
    {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        r => r.map_err(|e| e.to_string())?,
    };
    // Ticket 421 round 3: a FIFO or device is refused, not read (it would hold `CORES` forever).
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("libs.json: not a regular file".into());
    }
    let mut bytes = vec![];
    file.take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let v1 = match value["version"].as_u64() {
        Some(VERSION) => false,
        // Version 1 has no `defaults_offered`.
        Some(1) if value.get("defaults_offered").is_none() => true,
        _ => return Err(format!("version {} is not read here", value["version"])),
    };
    let file: Lockfile = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let mut keys = BTreeSet::new();
    // One hash names one file: its sha512 and size agree wherever it appears.
    let mut files: BTreeMap<&str, (&str, u64)> = BTreeMap::new();
    for e in &file.entries {
        let t = parse(&format!("https://{}{}", e.host, e.path)).map_err(|r| r.message)?;
        if t != e.tuple()
            || !valid_hash(&e.sha384)
            || e.sha512.len() != 128
            || !lower_hex(&e.sha512)
            || e.size == 0
            || e.size > FILE_CAP as u64
            || !keys.insert(t)
            || (e.badge == Badge::Verified && e.host != CDNJS)
            || *files.entry(&e.sha384).or_insert((&e.sha512, e.size)) != (e.sha512.as_str(), e.size)
        {
            return Err(format!("entry {}{} is not consistent", e.host, e.path));
        }
    }
    if file.entries.len() > ENTRIES_CAP {
        return Err("too many entries".into());
    }
    let mut libraries = BTreeSet::new();
    if file.auto_allow.iter().any(|a| {
        a.host != CDNJS || !grammar::cdnjs_library(&a.library) || !libraries.insert(&a.library)
    }) {
        return Err("auto-allow names something other than one cdnjs library".into());
    }
    let mut offered = BTreeSet::new();
    if file.defaults_offered.len() > ENTRIES_CAP
        || file
            .defaults_offered
            .iter()
            .any(|l| !grammar::cdnjs_library(l) || !offered.insert(l))
    {
        return Err("defaults_offered names something other than distinct cdnjs libraries".into());
    }
    Ok(Some((file, v1.then_some(bytes))))
}

/// `verified.json`, or nothing when it is missing, a link, too large, or not a map of store hashes to stamps.
fn read_stamps(dir: &Path) -> BTreeMap<String, Stamp> {
    let read = || -> Option<BTreeMap<String, Stamp>> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(dir.join("verified.json"))
            .ok()
            .filter(|f| f.metadata().is_ok_and(|m| m.is_file()))?; // ticket 421 round 3
        let mut bytes = vec![];
        file.take(1024 * 1024).read_to_end(&mut bytes).ok()?;
        let stamps: BTreeMap<String, Stamp> = serde_json::from_slice(&bytes).ok()?;
        stamps.keys().all(|h| valid_hash(h)).then_some(stamps)
    };
    read().unwrap_or_default()
}

/// The shipped manifest: `libraries.<Lib>.<version>.<file>` is cdnjs's `sri` value for that file
/// (`https://api.cdnjs.com/libraries/<Lib>/<version>?fields=sri`).
#[derive(Debug, Default)]
pub struct Manifest {
    libraries: BTreeMap<String, BTreeMap<String, BTreeMap<String, String>>>,
}
impl Manifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct File {
            version: u64,
            libraries: BTreeMap<String, BTreeMap<String, BTreeMap<String, String>>>,
        }
        let f: File = serde_json::from_str(text).map_err(|e| format!("manifest: {e}"))?;
        if f.version != 1 {
            return Err("manifest: version 1 expected".into());
        }
        Ok(Self {
            libraries: f.libraries,
        })
    }
    /// cdnjs's published `sha512-<base64>` for the tuple; none for every other host.
    pub fn expect(&self, t: &Tuple) -> Option<&str> {
        if t.host != CDNJS {
            return None;
        }
        self.libraries
            .get(&t.library)?
            .get(&t.version)?
            .get(&t.file)
            .map(String::as_str)
            .filter(|v| v.starts_with("sha512-"))
    }
}

/// The page's `integrity` as SRI reads it: the values of the strongest algorithm named (sha512 > sha384 > sha256),
/// options after `?` dropped. `None` when no value names a known algorithm (SRI then does not block).
fn strongest(integrity: &str) -> Option<(u8, Vec<String>)> {
    let values: Vec<(u8, String)> = integrity
        .split_ascii_whitespace()
        .filter_map(|v| {
            let (alg, rest) = v.split_once('-')?;
            let rank = match alg {
                "sha256" => 1,
                "sha384" => 2,
                "sha512" => 3,
                _ => return None,
            };
            Some((rank, rest.split('?').next().unwrap_or("").to_string()))
        })
        .collect();
    let best = values.iter().map(|(r, _)| *r).max()?;
    Some((
        best,
        values
            .into_iter()
            .filter(|(r, _)| *r == best)
            .map(|(_, v)| v)
            .collect(),
    ))
}
fn matches_integrity(bytes: &[u8], wanted: Option<&(u8, Vec<String>)>) -> bool {
    let Some((alg, values)) = wanted else {
        return true;
    };
    let got = match alg {
        1 => base64(&Sha256::digest(bytes)),
        2 => base64(&Sha384::digest(bytes)),
        _ => base64(&Sha512::digest(bytes)),
    };
    values.contains(&got)
}

/// The log line of a failed library fetch, redacted like every core log line.
pub fn failure_line(url: &str, error: &str) -> String {
    format!(
        "library fetch failed: {}",
        crate::logs::excerpt(&format!("{url}: {error}"))
    )
}

pub fn valid_hash(h: &str) -> bool {
    h.len() == 96 && lower_hex(h)
}
fn lower_hex(h: &str) -> bool {
    h.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
/// Standard base64 with padding, as SRI writes it.
pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(REQUESTER_MAX)
        .collect()
}

/// The window's `libs::Op`.
pub fn window(home: &Path, op: Op) -> Result<Reply, String> {
    let libs = Libs::open(home);
    let listed = |libs: &Libs| {
        let (entries, auto_allow, saved) = libs.list();
        Reply::Libs {
            entries,
            auto_allow,
            defaults: default_auto_allow(),
            saved,
        }
    };
    match op {
        Op::LibsList => Ok(listed(&libs)),
        Op::LibsAllow {
            url,
            integrity,
            requester,
        } => libs
            .allow(&url, integrity.as_deref(), &requester)
            .map(|entry| Reply::LibPinned { entry }),
        Op::LibsAutoAllow { host, library, on } => {
            libs.auto_allow(&host, &library, on)?;
            Ok(listed(&libs))
        }
        Op::LibsRemove { url } => {
            libs.remove(&url)?;
            Ok(listed(&libs))
        }
    }
}

#[cfg(test)]
#[allow(dead_code)] // the integration tests' fake CDN; this module uses part of it
#[path = "../../tests/fixtures/libs/origin.rs"]
mod origin;
#[cfg(test)]
mod tests {
    use super::{origin, *};
    use std::{cell::RefCell, rc::Rc};

    type Hook = Box<dyn Fn(&str, &Shared)>;
    thread_local! {
        /// Runs on the pinning thread at each named step of a new pin: "before_put" (bytes reserved), "fsync" (the
        /// store file's fsync, before its rename) and "after_put".
        static HOOK: RefCell<Option<Hook>> = RefCell::new(None);
    }
    pub fn step(name: &str, s: &Shared) {
        HOOK.with(|h| h.borrow().as_ref().map(|h| h(name, s)));
    }
    fn hook(h: Option<Hook>) {
        HOOK.with(|x| *x.borrow_mut() = h);
    }
    fn home() -> PathBuf {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("lbu-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        home
    }
    fn at(home: &Path, o: &origin::Origin) -> Libs {
        Libs::with_origin(
            home,
            &o.origin(),
            Duration::from_secs(5),
            r#"{"version":1,"libraries":{}}"#,
        )
        .unwrap()
    }

    // Ticket 366: every default is a valid cdnjs name the shipped manifest lists (with at least one sha512 file);
    // mermaid is not one of them (owner 2026-11-09); no duplicates.
    #[test]
    fn default_set_is_from_the_verified_list_without_mermaid() {
        let m = Manifest::parse(MANIFEST).unwrap();
        let mut seen = BTreeSet::new();
        for lib in DEFAULT_AUTO_ALLOW {
            assert!(grammar::cdnjs_library(lib), "{lib}");
            assert!(seen.insert(lib.to_ascii_lowercase()), "{lib} twice");
            let versions = m
                .libraries
                .get(*lib)
                .unwrap_or_else(|| panic!("{lib} not in the manifest"));
            assert!(
                versions
                    .values()
                    .flat_map(|f| f.values())
                    .any(|h| h.starts_with("sha512-")),
                "{lib}: no verified file"
            );
        }
        assert!(!seen.contains("mermaid"));
        assert_eq!(default_auto_allow().len(), DEFAULT_AUTO_ALLOW.len());
    }

    // Ticket 366 r2: a default added in a later release is offered once to a lockfile that already has the marker; one
    // turned off stays off; offering again changes nothing.
    #[test]
    fn new_default_is_offered_once_to_a_marked_lockfile() {
        let mut file = Lockfile {
            version: VERSION,
            ..Default::default()
        };
        offer_defaults(&mut file, DEFAULT_AUTO_ALLOW);
        assert_eq!(file.auto_allow, default_auto_allow());
        // The owner turns d3 off.
        file.auto_allow.retain(|a| a.library != "d3");
        let later: Vec<&str> = DEFAULT_AUTO_ALLOW.iter().copied().chain(["vega"]).collect();
        offer_defaults(&mut file, &later);
        let on: Vec<&str> = file.auto_allow.iter().map(|a| a.library.as_str()).collect();
        assert!(on.contains(&"vega") && !on.contains(&"d3"), "{on:?}");
        assert_eq!(file.defaults_offered, later);
        // Turned off after its offer: not offered again.
        file.auto_allow.retain(|a| a.library != "vega");
        let before = (file.auto_allow.clone(), file.defaults_offered.clone());
        offer_defaults(&mut file, &later);
        assert_eq!((file.auto_allow, file.defaults_offered), before);
    }

    // V2-37 (27a SHOULD): other callers (list, resolve, Settings) are not held up by a store file's fsync.
    #[test]
    fn put_does_not_hold_the_state_lock_during_fsync() {
        let home = home();
        let o = origin::Origin::start(Box::new(|_| origin::ok(b"window.x = 1;\n")));
        let l = at(&home, &o);
        let free = Rc::new(RefCell::new(vec![]));
        let f = free.clone();
        hook(Some(Box::new(move |step, s: &Shared| {
            if step == "fsync" {
                f.borrow_mut().push(s.state.try_lock().is_ok())
            }
        })));
        l.allow("https://unpkg.com/x@1.0.0/x.js", None, "s")
            .unwrap();
        hook(None);
        assert_eq!(*free.borrow(), [true], "one store write, lock free");
        assert_eq!(l.list().0.len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    // Round 2 (SHOULD 1): pin Y of bytes already stored for X skips the write; a Remove of X before Y's entry exists
    // deletes the file. Y is refused, not pinned naming a missing file.
    #[test]
    fn remove_during_pin_write_does_not_leave_a_missing_file() {
        let (x, y) = (
            "https://unpkg.com/x@1.0.0/x.js",
            "https://unpkg.com/y@1.0.0/y.js",
        );
        let home = home();
        let o = origin::Origin::start(Box::new(|_| origin::ok(b"window.same = 1;\n")));
        let l = at(&home, &o);
        let pinned = l.allow(x, None, "s").unwrap();
        let other = l.clone();
        hook(Some(Box::new(move |step, _: &Shared| {
            if step == "after_put" {
                other.remove(x).unwrap();
            }
        })));
        let r = l.allow(y, None, "s");
        hook(None);
        assert!(r.is_err(), "{r:?}");
        assert!(l.list().0.is_empty());
        assert!(!l.dir.join("sha384").join(&pinned.sha384).exists());
        // Allow again writes the file and pins.
        l.allow(y, None, "s").unwrap();
        assert!(matches!(
            l.resolve(&[y.to_string()], "s").unwrap()[0],
            Resolved::Pinned { .. }
        ));
        let _ = fs::remove_dir_all(home);
    }

    // Round 2: two pins that each fit but not together; the second checks the cap while the first has reserved its
    // bytes and written nothing yet, so it is refused, and the store stays under the cap.
    #[test]
    fn two_pins_over_the_cap_together_one_is_refused() {
        let home = home();
        let body: &[u8] = b"window.a = 100000000;\n";
        let size = body.len() as u64;
        // Entries filling the cap but for room for one body, not two (no stored files: sizes count from the lockfile).
        let mut left = STORE_CAP - size - size / 2;
        let mut entries = vec![];
        for i in 0.. {
            if left == 0 {
                break;
            }
            let n = left.min(FILE_CAP as u64);
            left -= n;
            entries.push(serde_json::json!({"host":"cdnjs.cloudflare.com",
                "path":format!("/ajax/libs/lib{i}/1.0.0/a.js"),"library":format!("lib{i}"),"version":"1.0.0",
                "file":"a.js","sha384":format!("{i:096x}"),"sha512":format!("{i:0128x}"),"size":n,"fetched_at":1,
                "badge":"unverified","first_requester":"seed"}));
        }
        fs::create_dir_all(home.join("libs")).unwrap();
        fs::write(
            home.join("libs/libs.json"),
            serde_json::json!({"version":1,"entries":entries,"auto_allow":[]}).to_string(),
        )
        .unwrap();
        // Same length, other bytes: two store files.
        let o = origin::Origin::start(Box::new(|p| {
            origin::ok(if p.contains("/b@") {
                b"window.b = 100000000;\n"
            } else {
                b"window.a = 100000000;\n"
            })
        }));
        let l = at(&home, &o);
        assert!(l.list().2);
        let (a, b) = (
            "https://unpkg.com/a@1.0.0/a.js",
            "https://unpkg.com/b@1.0.0/b.js",
        );
        let second = Rc::new(RefCell::new(None));
        let (other, got, once) = (l.clone(), second.clone(), std::cell::Cell::new(true));
        hook(Some(Box::new(move |step, _: &Shared| {
            if step == "before_put" && once.replace(false) {
                *got.borrow_mut() = Some(other.allow(b, None, "s"));
            }
        })));
        let first = l.allow(a, None, "s");
        hook(None);
        let second = second.borrow_mut().take().unwrap();
        assert!(first.is_ok(), "{first:?}");
        assert!(
            second
                .as_ref()
                .is_err_and(|e| e.contains("the library cache is full")),
            "{second:?}"
        );
        assert_eq!(l.list().0.len(), entries.len() + 1);
        assert_eq!(l.shared.lock().reserved, 0);
        let _ = fs::remove_dir_all(home);
    }
}
