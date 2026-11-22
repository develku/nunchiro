//! v1a-13: who is on the other end of the owner socket, and which of this core's sessions it runs inside
//! (ticket 13; v1a-23: an inside peer's owner token is that session's caller). macOS only, like the rest of the core.
use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
};

/// The connecting process as the kernel recorded it at `connect`: its uid, pid and pid version from the
/// socket's audit token, so a pid reused after the peer exits is noticed instead of trusted.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Peer {
    pub uid: u32,
    pub pid: i32,
    version: i32,
}

pub(crate) fn of(stream: &UnixStream) -> io::Result<Peer> {
    let fd = stream.as_raw_fd();
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // `audit_token_t` (bsm/libbsm.h): val[5] is the pid, val[7] the pid version.
    let mut token = [0u32; 8];
    let mut len = std::mem::size_of_val(&token) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERTOKEN,
            token.as_mut_ptr().cast(),
            &mut len,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of_val(&token) {
        return Err(io::Error::other("short peer audit token"));
    }
    Ok(Peer {
        uid,
        pid: token[5] as i32,
        version: token[7] as i32,
    })
}

/// `struct proc_uniqidentifierinfo` (xnu bsd/sys/proc_info.h, flavor 17). Not in the public SDK header;
/// the layout is pinned by `own_pid_version_matches_the_audit_token` below.
#[repr(C)]
#[derive(Default)]
struct Unique {
    uuid: [u8; 16],
    id: u64,
    parent_id: u64,
    version: i32,
    orig_ppid_version: i32,
    reserve2: u64,
    reserve3: u64,
}
const PROC_PIDUNIQIDENTIFIERINFO: libc::c_int = 17;

fn pidinfo<T: Default>(pid: i32, flavor: libc::c_int) -> io::Result<T> {
    let mut out = T::default();
    let size = std::mem::size_of::<T>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, flavor, 0, (&mut out as *mut T).cast(), size) };
    if n != size {
        return Err(if n <= 0 {
            io::Error::last_os_error()
        } else {
            io::Error::other("short proc_pidinfo")
        });
    }
    Ok(out)
}

#[derive(Clone, Copy)]
struct Process {
    pid: i32,
    ppid: i32,
    uid: u32,
    sid: i32,
    id: u64,
    version: i32,
}

/// One process's parent and session id, read between two identity reads: if the pid was reused in
/// between, the unique ids differ and the read fails instead of describing someone else.
fn read(pid: i32) -> io::Result<Process> {
    let before: Unique = pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO)?;
    // V2-1b r6: the short form, which macOS also answers for another user's process (root's `logind`,
    // `sshd-session [priv]`); the full `PROC_PIDTBSDINFO` is refused there (EPERM), and the walks must pass them.
    let info: libc::proc_bsdshortinfo = pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
    let sid = unsafe { libc::getsid(pid) };
    if sid < 0 {
        return Err(io::Error::last_os_error());
    }
    let after: Unique = pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO)?;
    if before.id != after.id {
        return Err(io::Error::other("process changed during read"));
    }
    Ok(Process {
        pid,
        ppid: info.pbsi_ppid as i32,
        uid: info.pbsi_uid,
        sid,
        id: before.id,
        version: before.version,
    })
}

/// Whether `peer` runs inside a live session. `leaders` are the session children's pids, each with the pid of the
/// holder that spawned it (V2-1a; each PTY child calls `setsid`, so it leads its own session). Inside means: the
/// peer's session id is a leader (catches children that outlived their parent), or an ancestor is a leader that is
/// still its holder's child or has a leader as its session id (catches `setsid` while the parent lives). A child that
/// calls `setsid` while its parent exits (one fork; reparented to launchd) or a launch through another service (ssh,
/// launchctl, osascript) leaves; see the crate README and docs/v1/owner-boundary-spike.md (V1A-18).
/// v1a-23: returns that session's leader (not just yes or no), so the core can name the caller.
pub(crate) fn containing(peer: &Peer, leaders: &[(u32, u32)]) -> io::Result<Option<u32>> {
    let leader = |pid: i32| pid > 0 && leaders.iter().any(|(l, _)| *l == pid as u32);
    let mut p = read(peer.pid)?;
    if p.version != peer.version {
        return Err(io::Error::other("peer exited before its check"));
    }
    if leader(p.sid) {
        return Ok(Some(p.sid as u32));
    }
    for _ in 0..256 {
        if p.pid > 0 && p.ppid > 0 && leaders.contains(&(p.pid as u32, p.ppid as u32)) {
            return Ok(Some(p.pid as u32));
        }
        if p.ppid <= 1 {
            return Ok(None);
        }
        let parent = read(p.ppid)?;
        // `parent` was `p`'s parent only if `p` still names it: a parent that exited reparents `p`.
        let again = read(p.pid)?;
        if again.id != p.id || again.ppid != p.ppid {
            return Err(io::Error::other("process tree changed during check"));
        }
        if leader(parent.sid) {
            return Ok(Some(parent.sid as u32));
        }
        p = parent;
    }
    Err(io::Error::other("process tree too deep"))
}

/// V2-1a: a holder's leaders, read from the process table: every session leader whose parent runs this executable
/// (each holder's agent; in a core that holds its PTYs in process, each PTY child). A holder has no registry, and
/// a file of pids would let an agent delete its own entry. Processes that end during the scan are skipped.
/// Ticket 353: an app update renames the bundle away under a running process and its path then reads ENOENT for good,
/// so no process can be matched by path: holders are told by their first argument, as in `under_holder`. That can only
/// add leaders, and a leader only ever refuses a peer.
pub(crate) fn held_leaders() -> io::Result<Vec<(u32, u32)>> {
    let own = std::process::id() as i32;
    let me = match path(own) {
        Ok(me) => Some(me),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => None,
        Err(e) => return Err(e),
    };
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Err(io::Error::last_os_error());
    }
    // Room for processes started since the count.
    let mut pids = vec![0i32; n as usize + 64];
    let size = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
    if n <= 0 {
        return Err(io::Error::last_os_error());
    }
    pids.truncate(n as usize);
    let mut ours = std::collections::BTreeMap::new();
    let mut out = vec![];
    for pid in pids.into_iter().filter(|p| *p > 1) {
        if unsafe { libc::getsid(pid) } != pid {
            continue;
        }
        let Ok(p) = read(pid) else { continue };
        if p.ppid <= 1 {
            continue;
        }
        let held = *ours.entry(p.ppid).or_insert_with(|| match &me {
            Some(me) => path(p.ppid).is_ok_and(|exe| exe == *me),
            None => {
                p.ppid == own
                    || argv(p.ppid).is_ok_and(|args| args.get(1).is_some_and(|a| a == b"hold"))
            }
        });
        if held {
            out.push((pid as u32, p.ppid as u32));
        }
    }
    Ok(out)
}
/// V2-1b r3 (S1): whether `peer` descends from any Nunchiro holder, whatever executable path that holder runs from
/// (`held_leaders` knows only this executable's): an ancestor of this user whose first argument is `hold`. A read of
/// our own process that fails refuses (fail closed); r4: another user's ancestor is skipped, not read.
pub(crate) fn under_holder(peer: &Peer) -> io::Result<bool> {
    let mut p = read(peer.pid)?;
    if p.version != peer.version {
        return Err(io::Error::other("peer exited before its check"));
    }
    let me = unsafe { libc::geteuid() };
    judge(me, || {
        if p.ppid <= 1 {
            return Ok(None);
        }
        let parent = read(p.ppid)?;
        // Another user's arguments are not read (holders run as this user; `judge` skips that ancestor).
        let args = if parent.uid == me {
            argv(parent.pid)
        } else {
            Ok(vec![])
        };
        // As in `containing`: `parent` (and the arguments read) was `p`'s parent only if `p` still names it.
        let again = read(p.pid)?;
        if again.id != p.id || again.ppid != p.ppid {
            return Err(io::Error::other("process tree changed during check"));
        }
        p = parent;
        Ok(Some((parent.uid, args)))
    })
}
/// One ancestor: its uid and its arguments as read.
type Ancestor = (u32, io::Result<Vec<Vec<u8>>>);
/// Walks the ancestors `next` yields (nearest first; `None` at the top) and says whether one is a holder.
fn judge(me: u32, mut next: impl FnMut() -> io::Result<Option<Ancestor>>) -> io::Result<bool> {
    for _ in 0..256 {
        let Some((uid, args)) = next()? else {
            return Ok(false);
        };
        // Holders run as this user. Another user's process (root's `login` or `sshd-session` above a terminal's
        // shell) is not one, and its arguments are not ours to read: walk on past it. Ours must be readable.
        if uid != me {
            continue;
        }
        if args?.get(1).is_some_and(|a| a == b"hold") {
            return Ok(true);
        }
    }
    Err(io::Error::other("process tree too deep"))
}
/// A process's arguments (`KERN_PROCARGS2`: argc, the executable path, padding, then argv).
fn argv(pid: i32) -> io::Result<Vec<Vec<u8>>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    let ask = |buf: *mut libc::c_void, size: &mut libc::size_t, mib: &mut [libc::c_int; 3]| unsafe {
        libc::sysctl(mib.as_mut_ptr(), 3, buf, size, std::ptr::null_mut(), 0)
    };
    if ask(std::ptr::null_mut(), &mut size, &mut mib) != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buf = vec![0u8; size];
    if ask(buf.as_mut_ptr().cast(), &mut size, &mut mib) != 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(size);
    if buf.len() < 4 {
        return Err(io::Error::other("short process arguments"));
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]).max(0) as usize;
    let rest = &buf[4..];
    // Past the executable path and its padding.
    let start = rest
        .iter()
        .position(|b| *b == 0)
        .and_then(|end| rest[end..].iter().position(|b| *b != 0).map(|n| end + n))
        .unwrap_or(rest.len());
    Ok(rest[start..]
        .split(|b| *b == 0)
        .take(argc)
        .map(<[u8]>::to_vec)
        .collect())
}
/// Ticket 1002 (Fable lane 2 review M1, final review F1): the window token goes only to the app's own binary, judged
/// by the peer's own layout, as the app finds its CLI (app/src-tauri/src/main.rs `cli()`): an executable named
/// `nunchiro-app` with a file `nunchiro` beside it, wherever the core itself was started from. The pid must still
/// run the program that connected (S2). This raises the bar for a process that read `core.token`; it is no
/// signature check. A debug build answers any owner peer, but only for a home outside the owner's `.nunchiro*`
/// folders (S1, as the opener's test hook).
pub(crate) fn is_app(peer: &Peer, home: &std::path::Path) -> bool {
    if cfg!(debug_assertions) && !owner_home(home) {
        return true;
    }
    use std::os::unix::ffi::OsStrExt;
    let Ok(bytes) = path(peer.pid) else {
        return false;
    };
    read(peer.pid).is_ok_and(|p| p.version == peer.version)
        && app_layout(std::path::Path::new(std::ffi::OsStr::from_bytes(&bytes)))
}
/// A home whose resolved path has a `.nunchiro*` folder in it (the owner's, or a copy); unresolvable counts as one.
fn owner_home(home: &std::path::Path) -> bool {
    home.canonicalize().map_or(true, |h| {
        h.components()
            .any(|c| c.as_os_str().as_encoded_bytes().starts_with(b".nunchiro"))
    })
}
fn app_layout(exe: &std::path::Path) -> bool {
    exe.file_name() == Some(std::ffi::OsStr::new("nunchiro-app"))
        && exe
            .parent()
            .is_some_and(|dir| dir.join("nunchiro").is_file())
}
fn path(pid: i32) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(n as usize);
    Ok(buf)
}
/// V2-1a r3: whether `pid` is still the agent that started at `started` (a different start time is another
/// process on a reused pid, so the agent is gone); unreadable for another reason than its absence counts as live.
pub(crate) fn running_since(pid: u32, started: Option<u64>) -> bool {
    match pidinfo::<libc::proc_bsdinfo>(pid as i32, libc::PROC_PIDTBSDINFO) {
        Ok(info) => {
            info.pbi_status != libc::SZOMB
                && started
                    .is_none_or(|t| t == info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
        }
        Err(e) => e.raw_os_error() != Some(libc::ESRCH),
    }
}
/// V2-1a r3: only a live process read back with exactly this start time; what the core may signal.
pub(crate) fn is_same(pid: u32, started: u64) -> bool {
    pidinfo::<libc::proc_bsdinfo>(pid as i32, libc::PROC_PIDTBSDINFO).is_ok_and(|info| {
        info.pbi_status != libc::SZOMB
            && info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec == started
    })
}
/// Look 1117 v9 (A S3-3): another process group than `pid`'s own holds its terminal's foreground: a shell running a
/// command (`sleep 400`) and not at its prompt. Unreadable reads as no.
pub(crate) fn foreground_job(pid: u32) -> bool {
    pidinfo::<libc::proc_bsdinfo>(pid as i32, libc::PROC_PIDTBSDINFO)
        .is_ok_and(|info| info.e_tpgid != 0 && info.e_tpgid != info.pbi_pgid)
}
/// V2-1a: when `pid` started (microseconds since the epoch); with the pid it names one process, not a reused pid.
pub(crate) fn started(pid: u32) -> io::Result<u64> {
    let info: libc::proc_bsdinfo = pidinfo(pid as i32, libc::PROC_PIDTBSDINFO)?;
    Ok(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// V2.5-47 test seam: the next peer check on each listed holder socket fails once, as a busy process table makes it.
/// Keyed by socket path, so another test's holder in this process is not hit.
#[cfg(test)]
pub(crate) static BUSY_ONCE: std::sync::Mutex<Vec<std::path::PathBuf>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(test)]
pub(crate) fn busy_once(stream: &UnixStream) -> io::Result<()> {
    let at = stream.local_addr().ok();
    let Some(at) = at.as_ref().and_then(|a| a.as_pathname()) else {
        return Ok(());
    };
    let mut busy = BUSY_ONCE.lock().unwrap_or_else(|e| e.into_inner());
    match busy.iter().position(|p| p == at) {
        Some(i) => {
            busy.remove(i);
            Err(io::Error::other("process changed during read"))
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_pid_version_matches_the_audit_token() {
        let (a, _b) = UnixStream::pair().unwrap();
        let me = of(&a).unwrap();
        assert_eq!(me.pid, std::process::id() as i32);
        assert_eq!(me.uid, unsafe { libc::geteuid() });
        let p = read(me.pid).unwrap();
        assert_eq!(p.version, me.version, "proc_uniqidentifierinfo layout");
        assert_ne!(p.id, 0);
        assert_eq!(p.ppid, unsafe { libc::getppid() });
        assert_eq!(p.sid, unsafe { libc::getsid(0) });
    }

    #[test]
    fn a_process_outside_every_session_is_not_inside() {
        let (a, _b) = UnixStream::pair().unwrap();
        let me = of(&a).unwrap();
        assert!(containing(&me, &[]).unwrap().is_none());
        // This test process is not a child of itself, so its own pid as a "leader" only counts by session id.
        let sid = unsafe { libc::getsid(0) } as u32;
        assert_eq!(containing(&me, &[(sid, 1)]).unwrap(), Some(sid));
        // V2-1a: nor is it a session leader whose parent runs this executable.
        assert!(containing(&me, &held_leaders().unwrap()).unwrap().is_none());
    }

    #[test]
    fn a_stale_pid_version_fails_closed() {
        let (a, _b) = UnixStream::pair().unwrap();
        let mut me = of(&a).unwrap();
        me.version = me.version.wrapping_add(1);
        assert!(containing(&me, &[]).is_err());
    }

    // V2-1b r4 (security delta MUST): the core started from Terminal or ssh has a root-owned ancestor (`login`,
    // `sshd-session`) whose arguments this user cannot read. That ancestor is not a holder (holders run as this
    // user), so the walk goes on past it; a holder above it is still found.
    fn chain(links: Vec<Ancestor>) -> impl FnMut() -> io::Result<Option<Ancestor>> {
        let mut links = links.into_iter();
        move || Ok(links.next())
    }
    fn unreadable() -> io::Result<Vec<Vec<u8>>> {
        Err(io::Error::from_raw_os_error(libc::EINVAL))
    }
    fn args(words: &[&str]) -> io::Result<Vec<Vec<u8>>> {
        Ok(words.iter().map(|w| w.as_bytes().to_vec()).collect())
    }
    #[test]
    fn a_core_under_a_foreign_uid_ancestor_passes_and_a_holder_above_it_is_still_caught() {
        let me = 501;
        // our core <- zsh (ours) <- login (root, unreadable) <- launchd
        assert!(!judge(me, chain(vec![(me, args(&["-zsh"])), (0, unreadable())])).unwrap());
        // an agent <- sh (ours) <- sudo-like (root, unreadable) <- nunchiro hold (ours)
        assert!(
            judge(
                me,
                chain(vec![
                    (me, args(&["/bin/sh"])),
                    (0, unreadable()),
                    (me, args(&["/x/nunchiro", "hold", "id"])),
                ])
            )
            .unwrap()
        );
        // An ancestor of our own uid whose arguments cannot be read still refuses (fail closed).
        assert!(judge(me, chain(vec![(me, unreadable())])).is_err());
        // A process of another uid claiming `hold` is not one of our holders: holders run as this user.
        assert!(!judge(me, chain(vec![(0, args(&["/x/nunchiro", "hold", "id"]))])).unwrap());
    }
    #[test]
    fn this_test_process_is_not_under_a_holder() {
        let me = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(!under_holder(&of(&me.0).unwrap()).unwrap());
    }

    /// (pid, uid, ppid) of every process, from `ps` (an outside view for the tests below).
    fn table() -> Vec<(i32, u32, i32)> {
        let out = std::process::Command::new("/bin/ps")
            .args(["-A", "-o", "pid=,uid=,ppid="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut w = l.split_whitespace().map(|w| w.parse().ok());
                Some((w.next()??, w.next()?? as u32, w.next()??))
            })
            .collect()
    }
    // V2-1b r6 (security delta MUST): a root-owned process (`logind`, `sshd-session [priv]`) is read with its uid and
    // parent, so the walks can pass it.
    #[test]
    fn read_of_a_root_process_gives_its_uid_and_parent() {
        let roots: Vec<_> = table()
            .into_iter()
            .filter(|(pid, uid, _)| *uid == 0 && *pid > 1)
            .collect();
        if roots.is_empty() {
            eprintln!("skipped: no root process other than launchd on this host");
            return;
        }
        // A root process listed by `ps` may end before it is read (short-lived helpers under load): that one is
        // skipped, but at least one listed root process must read with its uid and parent.
        let read_one = roots
            .iter()
            .find_map(|&(pid, _, ppid)| read(pid).ok().map(|p| (p, ppid)));
        let (p, ppid) = read_one.expect("a root process is readable");
        assert_eq!((p.uid, p.ppid), (0, ppid));
    }
    // V2-1b r6: from a real process of this user whose ancestors include a root process (a shell under ssh's
    // `sshd-session [priv]`, a terminal's under `login`), both walks finish instead of failing.
    #[test]
    fn the_walks_pass_a_real_root_ancestor() {
        let me = unsafe { libc::geteuid() };
        let rows = table();
        let parent = |pid: i32| rows.iter().find(|r| r.0 == pid).map(|r| (r.1, r.2));
        let under_root = rows.iter().find(|(pid, uid, _)| {
            let mut q = parent(*pid).map(|p| p.1);
            *uid == me
                && std::iter::from_fn(|| {
                    let at = q.filter(|q| *q > 1)?;
                    let (uid, up) = parent(at)?;
                    q = Some(up);
                    Some(uid)
                })
                .any(|uid| uid == 0)
        });
        let Some(&(pid, _, _)) = under_root else {
            eprintln!(
                "skipped: no process of this user runs under a root process other than launchd on this host"
            );
            return;
        };
        let unique: Unique = pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO).unwrap();
        let peer = Peer {
            uid: me,
            pid,
            version: unique.version,
        };
        assert!(
            containing(&peer, &[]).is_ok(),
            "{:?}",
            containing(&peer, &[])
        );
        assert!(under_holder(&peer).is_ok(), "{:?}", under_holder(&peer));
    }
}

#[cfg(test)]
mod app_layout_tests {
    use super::*;

    // Final review F1: the app's own layout is accepted wherever it lives; a plain binary, a wrong name or a missing
    // `nunchiro` beside it is refused.
    #[test]
    fn the_window_token_goes_to_the_app_layout_only() {
        let dir = std::env::temp_dir().join(format!("peer-app-{}", std::process::id()));
        let (bundle, plain) = (dir.join("Nunchiro.app/Contents/MacOS"), dir.join("bin"));
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&plain).unwrap();
        for f in [
            bundle.join("nunchiro-app"),
            bundle.join("nunchiro"),
            plain.join("nunchiro-app"),
            plain.join("nc"),
        ] {
            std::fs::write(f, b"").unwrap();
        }
        assert!(app_layout(&bundle.join("nunchiro-app")));
        assert!(
            !app_layout(&plain.join("nunchiro-app")),
            "no nunchiro beside it"
        );
        assert!(!app_layout(&bundle.join("nunchiro")), "the CLI itself");
        assert!(!app_layout(&plain.join("nc")), "a plain binary");
        assert!(!app_layout(&bundle.join("Nunchiro-App")), "a wrong name");
        // S1: the debug bypass never covers the owner's home or a copy of it.
        assert!(
            owner_home(&dir.join("x/.nunchiro"))
                && owner_home(std::path::Path::new("/nonexistent"))
        );
        std::fs::create_dir_all(dir.join(".nunchiro-rc")).unwrap();
        assert!(owner_home(&dir.join(".nunchiro-rc")) && !owner_home(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
