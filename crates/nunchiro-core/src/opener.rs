//! Ticket 800: a test core records what it would hand to macOS `open` instead of launching a real app (TextEdit,
//! the editor, the browser) on the owner's desktop. `serve` reads the switch once at start.
use crate::store;
use std::{
    ffi::OsStr,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

pub const ENV: &str = "NUNCHIRO_TEST_OPENER";
pub const RECORD: &str = "opened.argv";
static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
/// One read-append-replace at a time, so two opens at once both land.
static WRITE: Mutex<()> = Mutex::new(());

/// Only a debug build asked by `NUNCHIRO_TEST_OPENER=record`, with a home whose resolved path has no `.nunchiro*`
/// folder in it (the owner's `~/.nunchiro`, a `~/.nunchiro-*` copy, or anything inside or reached through one),
/// records; anything else, an unresolvable home included, opens for real.
fn chosen(value: Option<&OsStr>, home: &Path, debug: bool) -> Option<PathBuf> {
    if !debug || value != Some(OsStr::new("record")) {
        return None;
    }
    let home = home.canonicalize().ok()?;
    let owner = home
        .components()
        .any(|c| c.as_os_str().as_encoded_bytes().starts_with(b".nunchiro"));
    (!owner).then(|| home.join(RECORD))
}

pub(crate) fn init(home: &Path, asked: bool) {
    // Ticket 841: a test that runs `serve` in its own process asks here, since it cannot set its own environment.
    let value = std::env::var_os(ENV).or_else(|| asked.then(|| "record".into()));
    let file = chosen(value.as_deref(), home, cfg!(debug_assertions));
    if value.is_some() && file.is_none() {
        eprintln!("{ENV}: ignored (release build or owner home); `open` runs for real");
    }
    let _ = FILE.set(file);
}

/// The record file when this core records instead of opening. The first `serve` in a process decides it.
pub(crate) fn record() -> Option<&'static Path> {
    FILE.get()?.as_deref()
}

/// Appends `open` and `args`, one a line, to the record and returns `Some`; `None` when this core opens for real.
pub(crate) fn recorded(args: &[String]) -> Option<Result<(), String>> {
    Some(append(record()?, args).map_err(|e| format!("test opener: {e}")))
}

/// The record can carry a sign-in link with a token, so an existing one must be a plain 0600 file with no other
/// link; the new contents replace it through `atomic_write` (a fresh 0600 file renamed over it).
fn append(file: &Path, args: &[String]) -> Result<(), String> {
    let _one = WRITE.lock().map_err(|_| "record lock poisoned")?;
    let mut text = match store::open_regular(file) {
        Ok(f) => {
            let m = f.metadata().map_err(|e| e.to_string())?;
            if m.nlink() > 1 || m.mode() & 0o777 & !0o600 != 0 {
                return Err(format!(
                    "{} has another link or is wider than 0600",
                    file.display()
                ));
            }
            store::read_capped(f, store::READ_MAX).map_err(|e| e.to_string())?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("{}: {e}", file.display())),
    };
    text.extend_from_slice(b"open\n");
    for a in args {
        text.extend_from_slice(a.as_bytes());
        text.push(b'\n');
    }
    store::atomic_write(file, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ns-opener-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn only_a_debug_build_with_a_test_home_records() {
        let root = dir("home");
        let test = root.join("p1-abc");
        fs::create_dir_all(&test).unwrap();
        let rec = Some(OsStr::new("record"));
        assert_eq!(chosen(rec, &test, true), Some(test.join(RECORD)));
        assert_eq!(chosen(rec, &test, false), None, "release build");
        assert_eq!(chosen(None, &test, true), None);
        assert_eq!(chosen(Some(OsStr::new("1")), &test, true), None);
        assert_eq!(chosen(rec, &root.join("missing"), true), None);
        // Review r1 MUST 1: the owner check judges the resolved path, not the name as written.
        for owner in [".nunchiro", ".nunchiro-rc"] {
            let child = root.join(owner).join("child");
            fs::create_dir_all(&child).unwrap();
            for home in [root.join(owner), child.clone(), child.join("..")] {
                assert_eq!(chosen(rec, &home, true), None, "{home:?}");
            }
        }
        fs::create_dir_all(root.join("away")).unwrap();
        std::os::unix::fs::symlink(root.join(".nunchiro"), root.join("away/link")).unwrap();
        assert_eq!(
            chosen(rec, &root.join("away/link"), true),
            None,
            "a link into the owner home"
        );
        let _ = fs::remove_dir_all(root);
    }

    // Review r1 MUST 3: only a plain 0600 file with one link is appended to; anything else is refused unchanged.
    #[test]
    fn the_record_is_a_private_plain_file() {
        let d = dir("rec");
        let args = |s: &str| vec![s.to_string()];
        let file = d.join(RECORD);
        append(&file, &args("a")).unwrap();
        append(&file, &args("b")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "open\na\nopen\nb\n");
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);

        let wide = d.join("wide");
        fs::write(&wide, "x").unwrap();
        fs::set_permissions(&wide, fs::Permissions::from_mode(0o644)).unwrap();
        let target = d.join("target");
        fs::write(&target, "keep").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let hard = d.join("hard");
        fs::hard_link(&target, &hard).unwrap();
        let soft = d.join("soft");
        std::os::unix::fs::symlink(&target, &soft).unwrap();
        let folder = d.join("folder");
        fs::create_dir(&folder).unwrap();
        for bad in [&wide, &hard, &soft, &folder] {
            assert!(append(bad, &args("token")).is_err(), "{bad:?}");
        }
        assert_eq!(fs::read_to_string(&wide).unwrap(), "x");
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        assert!(
            fs::symlink_metadata(&soft)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let _ = fs::remove_dir_all(d);
    }
}
