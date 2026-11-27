//! Ticket 1082, security round 3: the update claims and the safe small reads, shared by the CLI (`update.rs`) and the
//! app (`rc_update.rs`, included with #[path]), so both read, claim and run subprocesses the same way. Std, libc and
//! sha2 only.
//!
//! A claim says which home may install into an installed bundle. Only the app window writes one, for its own bundle
//! and home, when it starts (`rc_update::start`): the CLI and `serve` never do, because an agent may run the CLI with
//! any environment and start a core under a home it controls, where it is that core's owner. The folder is one fixed
//! place per account, from the passwd home, which no variable moves.
use std::{
    fs,
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// A regular file of at most `cap` bytes, opened first (never following a link, never blocking on a FIFO), then
/// checked and read through that one descriptor, so the file cannot be swapped between the check and the read.
pub fn read_small(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let file = open_regular(path, cap).ok()?;
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}

/// `path` opened with O_NOFOLLOW | O_NONBLOCK, then judged on the open descriptor: a regular file of at most `cap`.
pub fn open_regular(path: &Path, cap: u64) -> Result<fs::File, String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > cap {
        return Err(format!(
            "refused: {} is not a regular file of at most {cap} bytes",
            path.display()
        ));
    }
    Ok(file)
}

/// Owned by this user and writable by nobody else, and not a link.
pub fn private(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refused: {} is a symlink", path.display()));
    }
    // Safety: getuid cannot fail.
    if meta.uid() != unsafe { libc::getuid() } {
        return Err(format!("refused: {} is not owned by you", path.display()));
    }
    if meta.permissions().mode() & 0o022 != 0 {
        return Err(format!(
            "refused: {} is writable by group or others",
            path.display()
        ));
    }
    Ok(())
}

/// The claims folder of the account whose passwd home is `user_home`.
pub fn claims(user_home: &Path) -> PathBuf {
    user_home.join("Library/Application Support/Nunchiro/update-claims")
}

/// One file per bundle, named by the sha256 of its canonical path.
pub fn claim_file(claims: &Path, bundle: &Path) -> PathBuf {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(bundle.as_os_str().as_encoded_bytes());
    claims.join(
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    )
}

/// The first home to claim `bundle` keeps it (`Ok(false)`: a home holds it already). Only the app window calls this.
#[allow(dead_code)] // the CLI never claims (only its tests call this); the app does
pub fn claim(claims: &Path, bundle: &Path, home: &Path) -> Result<bool, String> {
    use std::io::Write as _;
    let home = fs::canonicalize(home).map_err(|e| format!("{}: {e}", home.display()))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(claims)
        .map_err(|e| format!("{}: {e}", claims.display()))?;
    private(claims)?;
    let path = claim_file(claims, bundle);
    // create_new (O_EXCL) neither follows a link there nor replaces a claim.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut f) => f
            .write_all(home.as_os_str().as_encoded_bytes())
            .map(|()| true)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The home that claimed `bundle`, read only from a private claims folder.
pub fn claimant(claims: &Path, bundle: &Path) -> Option<PathBuf> {
    private(claims).ok()?;
    let bytes = read_small(&claim_file(claims, bundle), 4096)?;
    Some(PathBuf::from(String::from_utf8(bytes).ok()?))
}

/// The most of each output stream a limited run keeps, and (`Output::KeepBounded`) the most a child may write to
/// any file.
pub const OUTPUT_CAP: u64 = 64 * 1024;

/// What happens to a child's stdout and stderr.
#[allow(dead_code)] // the CLI only discards; the app keeps its own CLI's answer
pub enum Output {
    /// /dev/null: nothing is kept and nothing can grow. The CLI's ditto, codesign and the candidate's serve update.
    Discard,
    /// Two unlinked files, and the child may write no file past `OUTPUT_CAP` (the soft RLIMIT_FSIZE): the app's
    /// `update status`, whose one JSON line is the answer; its git children raise the soft limit for main's fetch.
    KeepBounded,
    /// Two unlinked files with no size limit, read to `OUTPUT_CAP`: only the app's `update install`, whose stderr is
    /// the plain reason the owner reads. The writer is the installed app's own CLI, not a candidate; it cannot be
    /// limited by RLIMIT_FSIZE, which would stop its ditto copying the bundle; its group is killed when it ends.
    Keep,
}

/// How a limited run ended: its exit status and at most `OUTPUT_CAP` bytes of each kept stream.
#[allow(dead_code)] // the CLI reads only the status
pub struct Ran {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Security rounds 6 and 7: runs `cmd` with no pipe (nothing can block on a held pipe) in a process group of its own.
/// Only the direct child is waited for, against `time` and `watch` (checked every 100 ms). Its whole group is killed
/// on a timeout, on a `watch` failure, and also as soon as the direct child has ended (seen with WNOWAIT, so the
/// group's number cannot be reused before the kill), so no background process it left keeps running or writing. A
/// Nunchiro core started by the child is not in that group (it starts with a group of its own and its output on
/// /dev/null), so the kill never ends it.
pub fn run_limited(
    cmd: &mut std::process::Command,
    scratch: &Path,
    time: Option<std::time::Duration>,
    output: Output,
    mut watch: impl FnMut() -> Result<(), String>,
) -> Result<Ran, String> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let files = match output {
        Output::Discard => None,
        Output::Keep | Output::KeepBounded => Some((unlinked(scratch)?, unlinked(scratch)?)),
    };
    let clone = |f: &fs::File| f.try_clone().map(Stdio::from).map_err(|e| e.to_string());
    let (out, err) = match &files {
        None => (Stdio::null(), Stdio::null()),
        Some((o, e)) => (clone(o)?, clone(e)?),
    };
    cmd.stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .process_group(0);
    if matches!(output, Output::KeepBounded) {
        // Safety: getrlimit and setrlimit are async-signal-safe and touch no memory of the parent.
        unsafe {
            cmd.pre_exec(|| {
                let mut cap = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::getrlimit(libc::RLIMIT_FSIZE, &mut cap) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The soft limit only: the child is the app's own CLI, and its status check raises it for git alone.
                cap.rlim_cur = cap.rlim_max.min(OUTPUT_CAP as libc::rlim_t);
                if libc::setrlimit(libc::RLIMIT_FSIZE, &cap) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            })
        };
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let group = child.id() as libc::pid_t;
    // Safety: kill has no memory effects; a negative pid names the child's own group.
    let kill_group = || unsafe { libc::kill(-group, libc::SIGKILL) };
    let until = time.map(|t| std::time::Instant::now() + t);
    loop {
        if ended(group) {
            break;
        }
        let why = match (until, watch()) {
            (Some(u), _) if std::time::Instant::now() >= u => Some(format!(
                "did not end within {} s",
                time.unwrap_or_default().as_secs()
            )),
            (_, Err(why)) => Some(why),
            _ => None,
        };
        if let Some(why) = why {
            kill_group();
            let _ = child.wait();
            return Err(why);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    kill_group(); // what it left behind; the child itself is a zombie until the wait below
    let status = child.wait().map_err(|e| e.to_string())?;
    let read = |f: &fs::File| {
        let mut f = f;
        let mut bytes = Vec::new();
        let _ = f.seek(SeekFrom::Start(0));
        let _ = f.take(OUTPUT_CAP).read_to_end(&mut bytes);
        bytes
    };
    Ok(match files {
        None => Ran {
            status,
            stdout: vec![],
            stderr: vec![],
        },
        Some((o, e)) => Ran {
            status,
            stdout: read(&o),
            stderr: read(&e),
        },
    })
}

/// Whether `pid` has ended, without reaping it (WNOWAIT), so its number stays taken until `wait`.
fn ended(pid: libc::pid_t) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // Safety: info is a valid, zeroed siginfo_t that waitid fills.
    let r = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    r != 0 || info.si_pid != 0
}

/// A new file in `dir` (private, never a link), unlinked at once: only the descriptors keep it.
fn unlinked(dir: &Path) -> Result<fs::File, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(format!(".run-{}-{n}", std::process::id()));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = fs::remove_file(&path);
    Ok(file)
}
