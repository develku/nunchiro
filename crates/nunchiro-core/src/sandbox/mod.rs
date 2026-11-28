//! Shared fail-closed macOS runner. Only approval proofs provide command content.
use crate::approval::Proof;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::DirBuilderExt,
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
pub mod proxy;
#[derive(Debug, Clone)]
pub struct Profile {
    pub home: PathBuf,
    pub cache: PathBuf,
    pub user_home: PathBuf,
    pub executable: PathBuf,
    pub timeout: Duration,
    pub output_limit: usize,
    /// v1b-21: the cache may hold at most this many bytes before a run, and no file a run writes may exceed it.
    pub cache_limit: u64,
    /// v1b-33: `Some` limits file reads to `SYSTEM_READ`, the tool folders, the cache and these paths (a script
    /// widget's project and declared `read`); `None` reads everything but the blocked list (integration sources).
    pub read: Option<Vec<PathBuf>>,
}
impl Profile {
    pub fn new(home: PathBuf, cache: PathBuf, user_home: PathBuf) -> Self {
        Self {
            home,
            cache,
            user_home,
            executable: "/usr/bin/sandbox-exec".into(),
            timeout: Duration::from_secs(5),
            output_limit: 1024 * 1024,
            cache_limit: 64 * 1024 * 1024, // v1b-21
            read: None,                    // v1b-33
        }
    }
}
fn private(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("cache is a symlink".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
fn literal(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("non-UTF-8 sandbox path")?;
    if text
        .chars()
        .any(|c| c.is_control() || c == '"' || c == '\\')
    {
        return Err("invalid sandbox path".into());
    }
    Ok(format!("\"{text}\""))
}
// Preserve the same boundary through both configured and resolved home/cache paths.
fn subpath(path: &Path) -> Result<String, String> {
    let configured = format!("(subpath {})", literal(path)?);
    match path.canonicalize() {
        Ok(resolved) if resolved != path => Ok(format!(
            "(require-any {configured} (subpath {}))",
            literal(&resolved)?
        )),
        Ok(_) => Ok(configured),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(configured),
        Err(e) => Err(e.to_string()),
    }
}
// v1b-33: what any scoped run reads: system and Homebrew folders. Only `/System/Library` and the cryptexes of
// `/System`: `/System/Volumes/Data` is the whole data volume (the kernel reports its files under their firmlinked
// paths, `/Users/...`, but nothing here relies on that).
const SYSTEM_READ: [&str; 13] = [
    "/usr",
    "/bin",
    "/sbin",
    "/System/Library",
    "/System/Cryptexes",
    "/System/Volumes/Preboot/Cryptexes",
    "/Library",
    "/private/var/db",
    "/private/etc",
    "/private/var/select",
    "/dev",
    "/opt/homebrew",
    "/usr/local",
];
// v1b-33: tool folders under the user home a scoped run reads by default.
const USER_TOOLS: [&str; 2] = [".cargo/bin", ".local/bin"];
const HOMEBREW_VAR: [&str; 2] = ["/opt/homebrew/var", "/usr/local/var"];
// setsid, setpgid and posix_spawn can detach descendants from the owned process group.
fn policy(p: &Profile, port: u16) -> Result<String, String> {
    // v1b-33: a scoped run reads the listed folders, and stat()s any path but the blocked list (symlink and realpath
    // lookups need it; it shows that a path exists and its size and times, never its contents or a folder's names).
    let read = match &p.read {
        None => "(allow file-read*)".to_string(),
        Some(extra) => {
            let mut system = vec!["(literal \"/\")".to_string()];
            let tools = USER_TOOLS.iter().map(|t| p.user_home.join(t));
            for path in SYSTEM_READ.iter().map(PathBuf::from).chain(tools) {
                system.push(subpath(&path)?);
            }
            // r2 (review S1): Homebrew's `var` is service data (databases), not tools; a declared `read` (allowed
            // after it) may still name it.
            let var = [
                subpath(Path::new(HOMEBREW_VAR[0]))?,
                subpath(Path::new(HOMEBREW_VAR[1]))?,
            ];
            let mut own = vec![subpath(&p.cache)?];
            for path in extra {
                own.push(subpath(path)?);
            }
            format!(
                "(allow file-read-metadata)\n(allow file-read* {})\n(deny file-read* {})\n(allow file-read* {})",
                system.join(" "),
                var.join(" "),
                own.join(" ")
            )
        }
    };
    let mut s = format!(
        "(version 1)\n(deny default)\n(allow process-fork)\n(allow process-exec)\n(allow syscall-unix)\n(deny syscall-unix (syscall-number 147) (syscall-number 82) (syscall-number 244))\n(allow signal (target self))\n(allow sysctl-read)\n{read}\n(allow file-write* {})\n(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n(allow network-outbound (remote ip \"localhost:{port}\"))\n",
        subpath(&p.cache)?
    );
    let mut denied: Vec<PathBuf> = [".claude", ".codex", ".ssh", ".nunchiro"]
        .iter()
        // v1b-21: common credential stores too. v1b-33: denied after every allow (the last match wins), so a
        // declared `read` never opens them.
        .chain(&[
            ".aws",
            ".gnupg",
            ".config/gh",
            ".docker",
            ".kube",
            ".netrc",
            ".git-credentials",
            "Library/Keychains",
        ])
        .map(|d| p.user_home.join(d))
        .collect();
    denied.push(p.home.clone());
    for dir in denied {
        s.push_str(&format!(
            // v1b-33 r2 (review M1): the metadata operation is named too: a rule naming it beats the global
            // `(allow file-read-metadata)` of a scoped run whatever the order, a `file-read*` rule does not.
            "(deny file-read* file-read-metadata (require-all {} (require-not {})))\n",
            subpath(&dir)?,
            subpath(&p.cache)?
        ));
    }
    // v1b-33: node looks up each folder above its script (realpath, then the nearest package.json) and stops on
    // EPERM; for a scoped run each folder above the cache may be stat()ed and its package.json read, after the denies.
    if p.read.is_some() {
        let above: Vec<&Path> = p.cache.ancestors().skip(1).collect();
        let mut meta = vec![];
        let mut package = vec![];
        for dir in above {
            meta.push(format!("(literal {})", literal(dir)?));
            package.push(format!("(literal {})", literal(&dir.join("package.json"))?));
        }
        s.push_str(&format!(
            "(allow file-read-metadata {})\n(allow file-read* {})\n",
            meta.join(" "),
            package.join(" ")
        ));
    }
    Ok(s)
}
// v1b-21: the user's process count (by real uid) plus this many is the child's RLIMIT_NPROC.
const PROCESS_HEADROOM: libc::rlim_t = 64;
fn user_processes() -> Result<libc::rlim_t, String> {
    const PROC_RUID_ONLY: u32 = 5; // <sys/proc_info.h>, not in libc
    let mut pids = vec![0 as libc::c_int; 8192];
    let bytes = unsafe {
        libc::proc_listpids(
            PROC_RUID_ONLY,
            libc::getuid(),
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<libc::c_int>()) as libc::c_int,
        )
    };
    if bytes <= 0 {
        return Err("sandbox could not count processes".into());
    }
    Ok(pids[..bytes as usize / size_of::<libc::c_int>()]
        .iter()
        .filter(|p| **p > 0)
        .count() as libc::rlim_t)
}
// v1a-70: upper bound (exclusive) of the descriptor numbers the child marks close-on-exec.
const FD_SCAN_CAP: libc::rlim_t = 65_536;
// v1b-21: `home` is the run's own empty HOME and TMPDIR; the persistent cache is NUNCHIRO_CACHE.
fn base(p: &Profile, policy: &str, port: u16, cwd: &Path, home: &Path) -> Result<Command, String> {
    let mut c = crate::process::command(&p.executable);
    c.args(["-p", policy, "--"])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home)
        .env("TMPDIR", home)
        .env("NUNCHIRO_CACHE", &p.cache)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        // v1b-33 r2: without it CoreFoundation asks the directory service (getpwuid) for the user's encoding, a mach
        // lookup the profile refuses, and a program (node) can stall at start on the refused notifyd pipe.
        .env(
            "__CF_USER_TEXT_ENCODING",
            format!("0x{:X}:0x8000100:0x8000100", unsafe { libc::getuid() }),
        );
    let proxy = format!("http://127.0.0.1:{port}");
    c.env("HTTPS_PROXY", &proxy)
        .env("HTTP_PROXY", &proxy)
        .env("https_proxy", &proxy)
        .env("http_proxy", &proxy);
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    // v1b-21: RLIMIT_AS is not enforced on macOS, so memory has no limit beyond the timeout.
    let size = p.cache_limit as libc::rlim_t;
    let processes = user_processes()? + PROCESS_HEADROOM;
    // v1a-70: computed here because the child may not allocate or lock; an unlimited or failed read falls back to the cap.
    let mut nofile = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let open_max = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut nofile) } == 0 {
        nofile.rlim_cur.min(FD_SCAN_CAP)
    } else {
        FD_SCAN_CAP
    } as libc::c_int;
    unsafe {
        c.pre_exec(move || {
            // v1a-70: nothing beyond stdio (0-2) crosses into the run. CLOEXEC, not close(): std's exec-error pipe
            // must survive until exec. fcntl is async-signal-safe; EBADF on a closed slot is expected.
            for fd in 3..open_max {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            for (resource, value) in [(libc::RLIMIT_FSIZE, size), (libc::RLIMIT_NPROC, processes)] {
                let limit = libc::rlimit {
                    rlim_cur: value,
                    rlim_max: value,
                };
                if libc::setrlimit(resource, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(c)
}
// v1b-21: bytes on disk under `dir` (as du counts them, symlinks not followed), stopping once past `limit`.
fn usage(dir: &Path, limit: u64) -> Result<u64, String> {
    use std::os::unix::fs::MetadataExt;
    let (mut total, mut todo) = (0, vec![dir.to_path_buf()]);
    while let Some(d) = todo.pop() {
        for e in fs::read_dir(&d).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let m = e.metadata().map_err(|e| e.to_string())?;
            total += m.blocks() * 512;
            if total > limit {
                return Ok(total);
            }
            if m.is_dir() {
                todo.push(e.path());
            }
        }
    }
    Ok(total)
}
// v1b-21 r2: run groups alive in this process, by group id, with the core home that started them. A core that
// stops kills them (`stop_all`); a core that died is swept at the next open from records under its home (`sweep`).
// v1b-21 r3: plus the homes whose core stopped; a run reaching its spawn for a closed home never starts.
#[derive(Default)]
struct Runs {
    groups: BTreeMap<i32, PathBuf>,
    closed: std::collections::BTreeSet<PathBuf>,
    /// The approval name each live group runs, so turning a plugin off stops its parts (`stop_subjects`).
    subjects: BTreeMap<i32, String>,
}
type Live = Mutex<Runs>;
fn live() -> &'static Live {
    static LIVE: OnceLock<Live> = OnceLock::new();
    LIVE.get_or_init(Default::default)
}
const RECORDS: &str = ".sandbox-runs";
/// The kernel's start time of `pid` (seconds, microseconds) while it leads its own process group.
pub fn group_start(pid: i32) -> Option<(u64, u64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let n =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    (n == size && info.pbi_pgid as i32 == pid)
        .then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}
// The group's members that are not zombies; None when the kernel cannot list them.
fn live_members(pgid: i32) -> Option<Vec<i32>> {
    const PROC_PGRP_ONLY: u32 = 2; // <sys/proc_info.h>, not in libc
    const SZOMB: u32 = 5;
    let mut pids = vec![0 as libc::c_int; 4096];
    let bytes = unsafe {
        libc::proc_listpids(
            PROC_PGRP_ONLY,
            pgid as u32,
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<libc::c_int>()) as libc::c_int,
        )
    };
    if bytes < 0 {
        return None;
    }
    Some(
        pids[..bytes as usize / size_of::<libc::c_int>()]
            .iter()
            .copied()
            .filter(|&pid| {
                let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
                let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
                pid > 0
                    && unsafe {
                        libc::proc_pidinfo(
                            pid,
                            libc::PROC_PIDTBSDINFO,
                            0,
                            (&raw mut info).cast(),
                            size,
                        )
                    } == size
                    && info.pbi_status != SZOMB
                    && info.pbi_pgid as i32 == pgid
            })
            .collect(),
    )
}
// Repeated until no member lives: one group SIGKILL misses a child whose fork is in flight, and Darwin answers a
// group signal with EPERM while the leader is an unreaped zombie or members are still exiting (pty.rs, v1a-14), so
// neither the signal's result nor ESRCH alone says the group is empty. Each member is also signalled by pid.
fn kill_group(pgid: i32, limit: Duration) -> bool {
    let start = Instant::now();
    loop {
        let group = unsafe { libc::kill(-pgid, libc::SIGKILL) };
        let members = match live_members(pgid) {
            Some(m) => m,
            None if group == -1 => {
                return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            }
            None => vec![pgid],
        };
        if members.is_empty() {
            return true;
        }
        for pid in members {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        if start.elapsed() > limit {
            return false;
        }
        thread::sleep(Duration::from_millis(1));
    }
}
/// F24: the run groups the core at `home` started and has not finished.
pub fn running(home: &Path) -> usize {
    let home = home.canonicalize().unwrap_or_else(|_| home.into());
    let live = live().lock().unwrap_or_else(|e| e.into_inner());
    live.groups.values().filter(|h| **h == home).count()
}
/// Kills every run group the core at `home` started and has not finished; for core shutdown.
pub fn stop_all(home: &Path) {
    let home = home.canonicalize().unwrap_or_else(|_| home.into());
    let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
    for (pgid, _) in live.groups.iter().filter(|(_, h)| **h == home) {
        kill_group(*pgid, Duration::from_millis(500));
    }
    live.closed.insert(home); // v1b-21 r3
}
/// Kills the live run groups at `home` whose subject name starts with `prefix` (a plugin turned off or removed).
pub fn stop_subjects(home: &Path, prefix: &str) {
    let home = home.canonicalize().unwrap_or_else(|_| home.into());
    let live = live().lock().unwrap_or_else(|e| e.into_inner());
    for (pgid, _) in live
        .groups
        .iter()
        .filter(|(g, h)| **h == home && live.subjects.get(g).is_some_and(|n| n.starts_with(prefix)))
    {
        kill_group(*pgid, Duration::from_millis(500));
    }
}
/// At core open: kill each run group a dead core at `home` recorded whose leader is still the same process (start
/// time matches), drop the records, and remove the run dirs left in widget and source caches.
pub fn sweep(home: &Path) {
    // v1b-21 r3: an open core runs again in this home.
    let canonical = home.canonicalize().unwrap_or_else(|_| home.into());
    live()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .closed
        .remove(&canonical);
    let records = home.join(RECORDS);
    for e in fs::read_dir(&records).into_iter().flatten().flatten() {
        let recorded = e
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
            .zip(fs::read_to_string(e.path()).ok().and_then(|t| {
                let (s, u) = t.trim().split_once('.')?;
                Some((s.parse().ok()?, u.parse().ok()?))
            }));
        if let Some((pgid, start)) = recorded
            && pgid > 1
            && group_start(pgid) == Some(start)
        {
            kill_group(pgid, Duration::from_secs(2));
        }
        let _ = fs::remove_file(e.path());
    }
    // A plugin part's cache is `plugins/<id>/cache/<part>`: its run dirs are one level deeper.
    let parts = fs::read_dir(home.join("plugins"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.path()
                .join("cache")
                .symlink_metadata()
                .is_ok_and(|m| m.is_dir())
        })
        .flat_map(|e| {
            fs::read_dir(e.path().join("cache"))
                .into_iter()
                .flatten()
                .flatten()
        });
    let subjects = ["widgets", "sources"]
        .into_iter()
        .flat_map(|kind| {
            fs::read_dir(home.join(kind))
                .into_iter()
                .flatten()
                .flatten()
        })
        .map(|e| (e.path(), e.path().join("cache")))
        .chain(parts.map(|e| (e.path(), e.path())));
    {
        for (subject, cache) in subjects {
            let runs = cache.join(".runs");
            // Only real folders: a symlinked subject, cache or .runs is never followed.
            let real = |p: &Path| p.symlink_metadata().is_ok_and(|m| m.is_dir());
            if !(real(&subject) && real(&cache) && real(&runs)) {
                continue;
            }
            for run in fs::read_dir(&runs).into_iter().flatten().flatten() {
                let _ = fs::remove_dir_all(run.path()).or_else(|_| fs::remove_file(run.path()));
            }
        }
    }
}

fn execute(
    mut c: Command,
    timeout: Duration,
    limit: usize,
    owner: Option<&Path>, // v1b-21 r2: the core home of a subject run; none for the self-check
    subject: Option<&str>,
) -> Result<Vec<u8>, String> {
    // v1b-21 r3: spawned and registered under the live lock, so a stopping core either finds the group or refuses
    // the spawn; never a run it cannot see.
    let mut runs = live().lock().unwrap_or_else(|e| e.into_inner());
    if owner.is_some_and(|home| runs.closed.contains(home)) {
        return Err("core is stopping; nothing ran".into());
    }
    let mut child = c.spawn().map_err(|e| format!("sandbox spawn: {e}"))?;
    let pid = child.id();
    if let Some(home) = owner {
        runs.groups.insert(pid as i32, home.to_path_buf());
    }
    if let Some(name) = subject {
        runs.subjects.insert(pid as i32, name.into());
    }
    drop(runs);
    let record = owner.map(|home| {
        let record = home.join(RECORDS).join(pid.to_string());
        if let Some((s, u)) = group_start(pid as i32)
            && fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(home.join(RECORDS))
                .is_ok()
        {
            let _ = fs::write(&record, format!("{s}.{u}"));
        }
        record
    });
    let out = child.stdout.take().ok_or("missing stdout")?;
    let err = child.stderr.take().ok_or("missing stderr")?;
    let exceeded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    fn collect(
        mut r: impl Read,
        limit: usize,
        flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Vec<u8> {
        let mut b = vec![];
        let mut buf = [0; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if b.len() + n > limit {
                        flag.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                    b.extend_from_slice(&buf[..n]);
                }
                Err(_) => break,
            }
        }
        b
    }
    let flag = exceeded.clone();
    let stdout = thread::spawn(move || collect(out, limit, flag));
    let flag = exceeded.clone();
    let stderr = thread::spawn(move || collect(err, limit, flag));
    let start = Instant::now();
    let mut failure = None;
    loop {
        if start.elapsed() > timeout || exceeded.load(std::sync::atomic::Ordering::Relaxed) {
            failure = Some("sandbox timeout or output cap exceeded");
            break;
        }
        // WNOWAIT keeps this PID reserved until the entire process group is killed.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if observed < 0 {
            failure = Some("sandbox wait failed");
            break;
        }
        if unsafe { info.si_pid() } != 0 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let result = child.wait().map_err(|e| e.to_string());
    // v1b-21: one group kill misses a child whose fork is in flight; kill until the group is empty. Under the live
    // lock, so `stop_all` never signals a group id the kernel has already given to another process.
    {
        let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
        let emptied = kill_group(pid as i32, Duration::from_secs(2));
        live.groups.remove(&(pid as i32));
        live.subjects.remove(&(pid as i32));
        if let Some(record) = &record {
            let _ = fs::remove_file(record);
        }
        if !emptied {
            return Err("sandbox could not stop the run".into());
        }
    }
    let bytes = stdout.join().map_err(|_| "stdout reader failed")?;
    let errors = stderr.join().map_err(|_| "stderr reader failed")?;
    if exceeded.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("sandbox output cap exceeded".into());
    }
    if let Some(e) = failure {
        return Err(e.into());
    }
    if !result?.success() {
        return Err(format!(
            "sandbox command failed: {}",
            String::from_utf8_lossy(&errors)
        ));
    }
    Ok(bytes)
}
static CHECKS: OnceLock<Mutex<BTreeMap<PathBuf, Result<(), String>>>> = OnceLock::new();
fn self_check(p: &Profile, policy: &str, port: u16) -> Result<(), String> {
    let mut checks = CHECKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(result) = checks.get(&p.executable) {
        return result.clone();
    }
    // The denied path and listener are stand-ins, never real credential folders.
    let denied = p
        .cache
        .parent()
        .ok_or("cache parent missing")?
        .join(format!("denied-{}", crate::store::new_id()?));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let target = listener.local_addr().map_err(|e| e.to_string())?.port();
    let empty = Path::new("/var/empty"); // v1b-21
    let mut c = base(p, policy, port, &p.cache, empty)?;
    if !Path::new("/usr/bin/nc").is_file() {
        return Err("sandbox self-check: nc missing".into());
    }
    c.args(["/bin/sh","-c","if /usr/bin/touch \"$1\" 2>/dev/null; then exit 11; fi; /usr/bin/nc -z -w 1 127.0.0.1 \"$2\" 2>/dev/null && exit 12; exit 0","self-check"]).arg(&denied).arg(target.to_string());
    let result = execute(c, Duration::from_secs(3), 8192, None, None).and_then(|_| {
        let mut c=base(p,policy,port,&p.cache,empty)?;
        c.args(["/usr/bin/perl","-MPOSIX","-e","my $p=fork(); defined($p) or exit 15; if($p==0){POSIX::setsid()==-1 or exit 13; defined(POSIX::setpgid(0,0)) and exit 14; syscall(244,0,0,0,0,0,0); $!==1 or exit 16; exit 0}; wait; exit($? >> 8)"]);
        execute(c,Duration::from_secs(3),8192,None,None).map(|_|())
    });
    let wrote = denied.exists();
    if wrote {
        let _ = fs::remove_file(&denied);
    }
    let result = if wrote {
        Err("sandbox self-check allowed a denied write".into())
    } else {
        result.map_err(|e| format!("sandbox self-check failed: {e}"))
    };
    // Q9 fr-J15-1: a timeout or spawn error on a busy Mac is checked again next run, never kept until a restart.
    if result.is_ok() || wrote {
        checks.insert(p.executable.clone(), result.clone());
    }
    result
}
/// Run only the exact immutable content carried by a current approval proof.
/// The caller must serialize runs per subject and check approval immediately before this call.
pub fn run(p: &Profile, proof: &Proof) -> Result<Vec<u8>, String> {
    run_env(p, proof, &[])
}
// v1b-19: script widgets add exactly these keys on top of the runner's list; any other key is refused.
pub const EXTRA_ENV: [&str; 2] = ["NUNCHIRO_CONTEXT", "NUNCHIRO_PROJECT_DIR"];
/// `run` with extra environment, limited to `EXTRA_ENV` keys.
pub fn run_env(
    p: &Profile,
    proof: &Proof,
    extra: &[(&str, std::ffi::OsString)],
) -> Result<Vec<u8>, String> {
    if let Some((key, _)) = extra.iter().find(|(k, _)| !EXTRA_ENV.contains(k)) {
        return Err(format!("sandbox environment key {key} not allowed"));
    }
    // A proof can be shared by callers, but never run twice concurrently for one subject.
    type Key = (PathBuf, crate::approval::SubjectKind, String);
    static RUNNING: OnceLock<Mutex<std::collections::HashSet<Key>>> = OnceLock::new();
    let key = (
        p.home.canonicalize().unwrap_or_else(|_| p.home.clone()),
        proof.kind(),
        proof.name().to_string(),
    );
    let running = RUNNING.get_or_init(Default::default);
    if !running
        .lock()
        .map_err(|_| "runner unavailable")?
        .insert(key.clone())
    {
        return Err(format!("{} already running", proof.kind().label()));
    }
    struct RunGuard<'a>(&'a Mutex<std::collections::HashSet<Key>>, Key);
    impl Drop for RunGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut active) = self.0.lock() {
                active.remove(&self.1);
            }
        }
    }
    let _guard = RunGuard(running, key);
    private(&p.cache)?;
    let mut resolved = p.clone();
    resolved.cache = p.cache.canonicalize().map_err(|e| e.to_string())?;
    let p = &resolved;
    let proxy = proxy::Proxy::start(proof.network())?;
    let policy = policy(p, proxy.port)?;
    self_check(p, &policy, proxy.port)?;
    let runs = p.cache.join(".runs");
    private(&runs)?;
    // v1b-21: runs of one subject are serialized (RUNNING), so any entry here was left by a killed core.
    for e in fs::read_dir(&runs).map_err(|e| e.to_string())? {
        let path = e.map_err(|e| e.to_string())?.path();
        // remove_dir_all removes a symlink itself, never its target.
        fs::remove_dir_all(&path)
            .or_else(|_| fs::remove_file(&path))
            .map_err(|e| e.to_string())?;
    }
    if usage(&p.cache, p.cache_limit)? > p.cache_limit {
        return Err(format!("cache over {} MiB", p.cache_limit / (1024 * 1024)));
    }
    let run_dir = runs.join(crate::store::new_id()?);
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _temp = Temp(run_dir.clone());
    // v1b-21: the snapshot runs in `work`; `home` is the run's fresh, empty HOME.
    let (dir, home) = (run_dir.join("work"), run_dir.join("home"));
    for d in [&run_dir, &dir, &home] {
        fs::create_dir(d).map_err(|e| e.to_string())?;
        fs::set_permissions(d, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    for f in proof.files() {
        let dest = dir.join(f.path());
        if let Some(parent) = dest.parent() {
            private(parent)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if f.executable() { 0o700 } else { 0o600 })
            .open(&dest)
            .map_err(|e| e.to_string())?;
        file.write_all(f.bytes()).map_err(|e| e.to_string())?;
    }
    let mut c = base(p, &policy, proxy.port, &dir, &home)?;
    c.envs(extra.iter().map(|(k, v)| (k, v))); // v1b-19
    c.args(proof.argv());
    let owner = p.home.canonicalize().unwrap_or_else(|_| p.home.clone()); // v1b-21 r2
    execute(
        c,
        p.timeout,
        p.output_limit,
        Some(&owner),
        Some(proof.name()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    // Q9 fr-J15-1: a stand-in "sandbox" that fails its first run (as a timed-out first check would) and passes after.
    #[test]
    fn a_failed_self_check_is_not_kept() {
        let dir = std::env::temp_dir().join(format!("ns-selfcheck-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("cache")).unwrap();
        let fake = dir.join("sandbox-exec");
        let first = dir.join("first");
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\n[ -e '{0}' ] && exit 0\n: > '{0}'\nexit 1\n",
                first.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let mut p = Profile::new(dir.clone(), dir.join("cache"), dir.clone());
        p.executable = fake;
        let once = self_check(&p, "(version 1)", 9);
        let again = self_check(&p, "(version 1)", 9);
        fs::remove_dir_all(&dir).unwrap();
        assert!(once.is_err(), "{once:?}");
        assert_eq!(again, Ok(()));
    }
    // v1b-21 r2: a member behind an exited, unreaped leader is found and killed. The EPERM window while killed
    // members exit (probe .scratch/probes/eperm2.py: 280 of 4000 signals after the reap) cannot be forced here.
    #[test]
    fn kill_group_reaches_a_member_behind_a_zombie_leader() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 30 >/dev/null & echo $!; exit 0"])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut out = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        let member: i32 = out.trim().parse().unwrap();
        let pgid = child.id() as i32;
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pgid as u32,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            },
            0
        );
        assert_eq!(live_members(pgid), Some(vec![member]));
        assert!(kill_group(pgid, Duration::from_secs(2)));
        child.wait().unwrap();
        // The killed member stays a zombie until launchd reaps it.
        let start = Instant::now();
        while unsafe { libc::kill(member, 0) } == 0 {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "member {member} survived"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}
