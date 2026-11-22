//! The network grants, `artifact-grants.json` under `NUNCHIRO_HOME` (internal format, version 1):
//! `{"version":1,"grants":[["<id>","<hash>"],...]}`, oldest first, at most [`CAP`] entries.
//! Written atomically (temp file, rename) as 0600 in a 0700 folder. A file that is not valid version-1
//! JSON (broken, wrong shape, or a newer version) is never overwritten: grants then last until exit.
//! Unknown top-level fields are ignored on read; future versions add fields, never reinterpret these.
use std::{io::Write, path::PathBuf, sync::Mutex};

const CAP: usize = 512;
const VERSION: u64 = 1;

pub struct Grants {
    file: Option<PathBuf>,
    state: Mutex<State>,
}

struct State {
    list: Vec<(String, String)>,
    /// False when the file on disk is not ours to replace.
    writable: bool,
}

impl Grants {
    #[cfg(test)]
    pub fn memory() -> Self {
        Grants {
            file: None,
            state: Mutex::new(State {
                list: Vec::new(),
                writable: false,
            }),
        }
    }

    pub fn open(file: PathBuf) -> Self {
        let (list, writable) = match read(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), true),
            Err(e) => {
                eprintln!("nunchiro: artifact grants not read, kept in memory until exit: {e}");
                (Vec::new(), false)
            }
            Ok(bytes) => match parse(&bytes) {
                Some(list) => (list, true),
                None => (Vec::new(), false),
            },
        };
        Grants {
            file: Some(file),
            state: Mutex::new(State { list, writable }),
        }
    }

    pub fn allows(&self, id: &str, hash: &str) -> bool {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.list.iter().any(|(i, h)| i == id && h == hash)
    }

    /// Replaces any older grant for `id`; a grant for a stale hash is simply never matched again.
    pub fn allow(&self, id: &str, hash: &str) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.list.retain(|(i, _)| i != id);
        s.list.push((id.to_string(), hash.to_string()));
        if s.list.len() > CAP {
            s.list.remove(0);
        }
        if let (Some(file), true) = (&self.file, s.writable)
            && let Err(e) = write(file, &s.list)
        {
            eprintln!("nunchiro: cannot save artifact grants: {e}");
        }
    }
}

fn parse(bytes: &[u8]) -> Option<Vec<(String, String)>> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if v.get("version")?.as_u64()? != VERSION {
        return None;
    }
    let list = v.get("grants")?.as_array()?;
    list.iter()
        .map(|e| {
            let pair = e.as_array().filter(|p| p.len() == 2)?;
            Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string()))
        })
        .collect()
}

/// Q9 psn-J15-2: a regular file only, opened without waiting (a FIFO there used to stop app start) and read up to a cap;
/// a link is followed and its target judged.
fn read(file: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    const MAX: u64 = 1 << 20;
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(file)?;
    if !f.metadata()?.is_file() {
        return Err(std::io::Error::other(format!(
            "{}: not a regular file",
            file.display()
        )));
    }
    let mut bytes = Vec::new();
    f.take(MAX + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX {
        return Err(std::io::Error::other(format!(
            "{}: over the read limit",
            file.display()
        )));
    }
    Ok(bytes)
}

fn write(file: &PathBuf, list: &[(String, String)]) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = file.parent().unwrap_or(std::path::Path::new("."));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let tmp = file.with_extension("json.tmp");
    let body = serde_json::json!({ "version": VERSION, "grants": list }).to_string();
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(body.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nunchiro-grants-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_grant_survives_a_restart_as_a_private_file() {
        let d = dir("roundtrip");
        let f = d.join("artifact-grants.json");
        Grants::open(f.clone()).allow("a", "h1");
        assert!(Grants::open(f.clone()).allows("a", "h1"));
        assert!(!Grants::open(f.clone()).allows("a", "h2"));
        assert_eq!(
            std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&d).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!f.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn regranting_replaces_and_the_list_is_bounded() {
        let g = Grants::memory();
        g.allow("a", "h1");
        g.allow("a", "h2");
        assert!(g.allows("a", "h2") && !g.allows("a", "h1"));
        for i in 0..CAP + 5 {
            g.allow(&format!("x{i}"), "h");
        }
        assert!(!g.allows("a", "h2") && g.allows(&format!("x{}", CAP + 4), "h"));
    }

    #[test]
    fn a_fifo_is_not_waited_on_nor_replaced() {
        let d = dir("fifo");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("artifact-grants.json");
        let c = std::ffi::CString::new(f.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let at = f.clone();
        std::thread::spawn(move || {
            let g = Grants::open(at);
            g.allow("a", "h");
            let _ = tx.send(g.allows("a", "h"));
        });
        let allowed = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a FIFO read blocked");
        assert!(allowed, "in memory until exit");
        assert!(std::fs::symlink_metadata(&f).unwrap().file_type().is_fifo());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn broken_or_newer_files_are_left_untouched() {
        let cases: [&str; 6] = [
            "not json",
            r#"{"version":2,"grants":[["a","h"]]}"#,
            r#"{"version":1,"grants":"x"}"#,
            r#"{"version":1,"grants":[["a"]]}"#,
            r#"{"version":1,"grants":[["a",7]]}"#,
            r#"{"grants":[]}"#,
        ];
        for (n, body) in cases.iter().enumerate() {
            let d = dir(&format!("bad{n}"));
            std::fs::create_dir_all(&d).unwrap();
            let f = d.join("artifact-grants.json");
            std::fs::write(&f, body).unwrap();
            let g = Grants::open(f.clone());
            assert!(!g.allows("a", "h"), "{body}");
            g.allow("b", "h");
            assert!(g.allows("b", "h"), "in memory until exit");
            assert_eq!(std::fs::read_to_string(&f).unwrap(), *body, "{body}");
            let _ = std::fs::remove_dir_all(d);
        }
    }
}
