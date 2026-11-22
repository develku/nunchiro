//! Ticket 18 (session escape spike): reproduces the V1A-13 residual escape and measures each candidate
//! boundary on this Mac. Nothing here changes product behavior; docs/v1/owner-boundary-spike.md records the
//! results. Fake shell sessions only. Tests compare tokens and never print them.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// v1a-23: what a session caller gets for a human action (needs 47 replaced the V1A-13 refusal hint).
const WAITING: &str = "waiting for the owner in the Nunchiro window";
/// One fork: the child calls `setsid` while its parent exits (reparented to launchd), drops the session
/// token, reads `core.token` through the inherited `NUNCHIRO_HOME` and asks for an owner-only list.
/// It writes its pid to `escape.pid` and stays alive so the test can inspect it.
const ESCAPE: &str = "/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); sleep 1; exec @ARGV' /bin/sh -c 'unset NUNCHIRO_TOKEN; H=\"$1\"; echo $$ > \"$H/escape.pid.tmp\"; mv \"$H/escape.pid.tmp\" \"$H/escape.pid\"; \"$2\" session list > \"$H/escape.out\" 2>&1 < /dev/null; echo \"exit=$?\" >> \"$H/escape.out\"; exec sleep 30' sh \"$H\" \"$CLI\"";

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("ob");
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
            .env("NUNCHIRO_SSH", "/usr/bin/false")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while core.raw(
            &core.home.join("core.sock"),
            &core.token(),
            r#"{"op":"snapshot"}"#,
        )["Ok"]["type"]
            != "snapshot"
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    fn token(&self) -> String {
        fs::read_to_string(self.home.join("core.token")).unwrap_or_default()
    }
    fn raw(&self, sock: &Path, token: &str, request: &str) -> serde_json::Value {
        let Ok(mut s) = UnixStream::connect(sock) else {
            return serde_json::Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let line = format!(
            "{{\"token\":{},\"request\":{request}}}\n",
            serde_json::json!(token)
        );
        s.write_all(line.as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null)
    }
    fn redact(&self, text: &str) -> String {
        text.replace(self.token().trim(), "<core.token>")
    }
    /// Starts `script` as a plain shell session, optionally behind `wrap` (e.g. `sandbox-exec -p ...`).
    fn run_shell(&self, wrap: &[&str], script: &str) {
        let body = format!(
            "CLI='{}'\nH=\"$NUNCHIRO_HOME\"\nprobe() {{ n=$1; shift; \"$@\" > \"$H/$n.out\" 2>&1 < /dev/null; echo \"exit=$?\" >> \"$H/$n.out\"; }}\n{script}\ntouch \"$H/shell.done\"\nsleep 60\n",
            cli().display()
        );
        let path = self.home.join("shell.sh");
        fs::write(&path, body).unwrap();
        let mut args: Vec<String> = wrap.iter().map(|s| s.to_string()).collect();
        args.extend(["/bin/sh".into(), path.display().to_string()]);
        let request = serde_json::json!({"op":"start","session":{
            "kind":"shell","project":self.home,"label":"shell","args":args}});
        let r = self.raw(
            &self.home.join("core.sock"),
            &self.token(),
            &request.to_string(),
        );
        assert_eq!(r["Ok"]["type"], "started", "{r}");
        self.wait("shell.done");
    }
    fn wait(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join(name).exists() {
            assert!(Instant::now() < until, "{name} never appeared");
            thread::sleep(Duration::from_millis(50));
        }
        fs::read_to_string(self.home.join(name)).unwrap_or_default()
    }
    fn out(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(15);
        let mut text = self.wait(&format!("{name}.out"));
        while !text.contains("exit=") {
            assert!(Instant::now() < until, "{name} never finished");
            thread::sleep(Duration::from_millis(50));
            text = fs::read_to_string(self.home.join(format!("{name}.out"))).unwrap();
        }
        self.redact(&text)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        // The escapee left the session tree, so stopping the core does not end it; nor the env -i child.
        let pid = |name: &str| {
            fs::read_to_string(self.home.join(name))
                .ok()
                .and_then(|pid| pid.trim().parse::<i32>().ok())
        };
        let (escapee, clean) = (pid("escape.pid"), pid("clean.pid"));
        for pid in [escapee, clean].into_iter().flatten() {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        let _ = self.raw(
            &self.home.join("core.sock"),
            &self.token(),
            r#"{"op":"stop"}"#,
        );
        let until = Instant::now() + Duration::from_secs(5);
        while self.process.try_wait().ok().flatten().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
        if thread::panicking() {
            return;
        }
        let _ = fs::remove_dir_all(&self.home);
        if let Some(pid) = clean {
            let until = Instant::now() + Duration::from_secs(2);
            while proc(pid).is_some() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                proc(pid).is_none(),
                "the env -i child {pid} outlived the test"
            );
        }
        // Nothing the escapee started may outlive the test (it leads its own session after `setsid`).
        if let Some(sid) = escapee {
            let until = Instant::now() + Duration::from_secs(2);
            while !session_members(sid).is_empty() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            let left = session_members(sid);
            for pid in &left {
                unsafe { libc::kill(*pid, libc::SIGKILL) };
            }
            assert!(
                left.is_empty(),
                "left running in the escapee's session: {left:?}"
            );
        }
    }
}

/// Live processes whose session id is `sid`.
fn session_members(sid: i32) -> Vec<i32> {
    let mut pids = vec![0i32; 8192];
    let size = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
    pids.truncate(n.max(0) as usize);
    pids.into_iter()
        .filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == sid)
        .collect()
}

/// `struct proc_uniqidentifierinfo` (xnu bsd/sys/proc_info.h, flavor 17), as `peer.rs` reads it.
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
#[derive(Debug)]
struct Proc {
    ppid: i32,
    sid: i32,
    version: i32,
    /// The pid version of the parent that forked this process; unlike `ppid` and `parent_id`, reparenting
    /// to launchd does not change it (measured on macOS 27.0.1).
    orig_ppid_version: i32,
}
fn unique(pid: i32) -> Option<Unique> {
    let mut u = Unique::default();
    let size = std::mem::size_of::<Unique>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, 17, 0, (&mut u as *mut Unique).cast(), size) };
    (n == size).then_some(u)
}
/// Parent, session and unique ids of a same-uid process (launchd's BSD info is not readable as a user).
fn proc(pid: i32) -> Option<Proc> {
    let u = unique(pid)?;
    let mut b: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut b as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (n == size).then(|| Proc {
        ppid: b.pbi_ppid as i32,
        sid: unsafe { libc::getsid(pid) },
        version: u.version,
        orig_ppid_version: u.orig_ppid_version,
    })
}

/// Candidate C, as a test-local function (not product code): walking up from `pid`, is there a process that
/// was reparented to launchd (`ppid` 1, but forked by someone other than launchd) whose original parent got
/// its pid version after the core's? Pid versions come from one counter that grows with every fork and exec.
fn orphaned_after(pid: i32, core: i32) -> Option<bool> {
    let launchd = unique(1)?.version;
    let mut p = proc(pid)?;
    for _ in 0..256 {
        if p.ppid == 1 {
            return Some(
                p.orig_ppid_version != launchd && p.orig_ppid_version.wrapping_sub(core) > 0,
            );
        }
        p = proc(p.ppid)?;
    }
    None
}

fn escapee(core: &Core) -> i32 {
    core.wait("escape.pid").trim().parse().unwrap()
}

#[test]
fn session_process_forks_once_setsid_and_regains_owner_today() {
    let core = Core::new();
    core.run_shell(
        &[],
        &format!(
            "\"$CLI\" widget new w > /dev/null 2>&1\nprobe inside env -u NUNCHIRO_TOKEN \"$CLI\" widget allow w --read\n{ESCAPE}\n"
        ),
    );
    // Control: from inside the session tree the owner token is that session's caller, so a human action only
    // waits for the owner (v1a-23 flip: was a `session list` refused with the V1A-13 hint).
    let inside = core.out("inside");
    assert!(
        inside.contains(WAITING) && inside.contains("exit=0"),
        "{inside}"
    );
    assert!(!core.home.join("approvals.json").exists(), "{inside}");
    // Baseline, before any fix: the escapee regains owner authority.
    let escape = core.out("escape");
    assert!(
        escape.contains("exit=0"),
        "the escape no longer works: {escape}"
    );
    // What the core sees of it: launchd as parent, its own session, its original parent gone.
    let pid = escapee(&core);
    let p = proc(pid).expect("escapee alive");
    assert_eq!((p.ppid, p.sid), (1, pid), "{p:?}");
    let launchd = unique(1).unwrap().version;
    assert!(p.orig_ppid_version != launchd, "{p:?}");
    let leader = core.raw(
        &core.home.join("core.sock"),
        &core.token(),
        r#"{"op":"snapshot"}"#,
    )["Ok"]["sessions"][0]["pid"]
        .as_i64()
        .unwrap() as i32;
    assert_ne!(p.sid, leader, "{p:?} (session leader pid {leader})");
}

/// The ticket's candidate A is an environment marker read through `KERN_PROCARGS2`. Measured truth on
/// macOS 27.0.1: the kernel returns another process's arguments but not its environment, even for the
/// same uid, so the core cannot read the marker at all; that invisibility is asserted from macOS 27 on.
/// On an older macOS, where it may be readable, the test instead checks the marker survives fork, `setsid` and
/// reparenting and that `env -i` drops it.
#[test]
fn candidate_a_env_marker_is_unreadable_on_macos_27_else_env_i_drops_it() {
    let core = Core::new();
    core.run_shell(
        &[],
        &format!(
            "export NUNCHIRO_V1A18_MARK=1\n{ESCAPE}\n\
             (/usr/bin/env -i /bin/sleep 30 & echo $! > \"$H/clean.pid\")\n"
        ),
    );
    let pid = escapee(&core);
    let clean: i32 = core.wait("clean.pid").trim().parse().unwrap();
    let (marked, visible) = environment_of_sleep(pid, "procargs of the escapee");
    let (cleaned, _) = environment_of_sleep(clean, "procargs of the env -i child");
    let (_, own, _) = environment(std::process::id() as i32).unwrap();
    assert!(own, "a process reads its own environment");
    let version = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .unwrap()
        .stdout;
    let major: u32 = String::from_utf8_lossy(&version)
        .split('.')
        .next()
        .and_then(|m| m.trim().parse().ok())
        .unwrap();
    if major >= 27 {
        assert!(
            !visible && !marked,
            "macOS {major} shows another process's environment"
        );
    } else if visible {
        assert!(
            marked,
            "the marker did not survive fork, setsid and reparent"
        );
        assert!(!cleaned, "env -i kept the marker");
    }
}

/// `environment` of `pid` once it runs `sleep`: the escapee writes its pid before its `session list` and `exec sleep`,
/// and `env -i` runs before its exec, so until then the read can fail (mid-exec) or describe the wrong program.
/// Polled up to 10 s; fails with the last answer.
fn environment_of_sleep(pid: i32, what: &str) -> (bool, bool) {
    wait_for_sleep(pid, Duration::from_secs(10), environment, live_id)
        .unwrap_or_else(|why| panic!("{what}: {why}"))
}

/// Waits for `pid` to run `sleep`. A process that is still starting (mid-exec, or running another program) is polled
/// for `patience`; a process that is gone fails at once: `identity` (the kernel's never-reused id) is `None`, or it
/// changed because another program took the pid. `identity` is read around every read, so another program's
/// arguments are never taken for the escapee's.
fn wait_for_sleep(
    pid: i32,
    patience: Duration,
    mut read: impl FnMut(i32) -> std::io::Result<(bool, bool, Vec<u8>)>,
    mut identity: impl FnMut(i32) -> Option<u64>,
) -> Result<(bool, bool), String> {
    let (first, until) = (Instant::now(), Instant::now() + patience);
    let mut seen: Option<(u64, String)> = None; // identity, what it last ran
    loop {
        let before = identity(pid);
        let mut last = String::new();
        let mut answer = None;
        if before.is_some() {
            match read(pid) {
                Ok((marked, visible, arg)) if arg.ends_with(b"sleep") => {
                    answer = Some((marked, visible))
                }
                Ok((_, _, arg)) => last = format!("runs {}", String::from_utf8_lossy(&arg)),
                Err(e) => last = format!("procargs says {e}"), // mid-exec reads fail like this
            }
        }
        // The read counts only if the same process held the pid before and after it.
        let after = identity(pid);
        let reused = match (&seen, before, after) {
            (Some((id, _)), Some(b), _) if *id != b => Some(b),
            (_, Some(b), Some(a)) if a != b => Some(a),
            _ => None,
        };
        if before.is_none() || after.is_none() || reused.is_some() {
            let why = match (reused, &seen) {
                (Some(now), Some((id, _))) => format!("pid reused: unique id {id} became {now}"),
                (Some(now), None) => format!("pid reused: unique id {before:?} became {now}"),
                _ => "no live process holds the pid".to_string(),
            };
            let known = match &seen {
                Some((id, ran)) => format!(
                    "seen alive as unique id {id}, last ran {ran}, {:?} after the first read",
                    first.elapsed()
                ),
                None => "never seen alive".to_string(),
            };
            return Err(format!("process {pid} is gone ({why}; {known}; {last})"));
        }
        if let Some(done) = answer {
            return Ok(done);
        }
        seen = Some((before.unwrap(), last.clone()));
        if Instant::now() >= until {
            return Err(format!("process {pid} never ran sleep: {last}"));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// The kernel's never-reused id of the live (not zombie) process holding `pid`; `None` once it is gone.
fn live_id(pid: i32) -> Option<u64> {
    unique(pid).map(|u| u.id)
}

/// `(has marker, environment readable, first argument)` for `pid`, from `KERN_PROCARGS2`: argc, exec path, argv,
/// then env.
fn environment(pid: i32) -> std::io::Result<(bool, bool, Vec<u8>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = 0usize;
    let mut call = |buf: *mut libc::c_void, size: &mut usize| unsafe {
        libc::sysctl(mib.as_mut_ptr(), 3, buf, size, std::ptr::null_mut(), 0)
    };
    if call(std::ptr::null_mut(), &mut size) != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut buf = vec![0u8; size];
    if call(buf.as_mut_ptr().cast(), &mut size) != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let argc = i32::from_ne_bytes(buf[..4].try_into().unwrap()) as usize;
    let words: Vec<&[u8]> = buf[4..size]
        .split(|b| *b == 0)
        .filter(|w| !w.is_empty())
        .collect();
    let env = words.get(1 + argc..).unwrap_or_default();
    Ok((
        env.iter().any(|w| w.starts_with(b"NUNCHIRO_V1A18_MARK=")),
        !env.is_empty(),
        words.get(1).map(|w| w.to_vec()).unwrap_or_default(),
    ))
}

/// Candidate B: the session under `(allow default)` plus a deny of `connect` to `core.sock`, with a stand-in
/// token-only socket (a relay in this test that refuses the owner token) as the agent CLI's path.
#[test]
fn candidate_b_seatbelt_denies_core_sock_but_agent_cli_still_works() {
    let core = Core::new();
    let relay = core.home.join("relay");
    fs::create_dir_all(&relay).unwrap();
    let listener = UnixListener::bind(relay.join("core.sock")).unwrap();
    let (real, owner) = (core.home.join("core.sock"), core.token());
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let (real, owner) = (real.clone(), owner.clone());
            thread::spawn(move || {
                let mut line = String::new();
                let mut reader = BufReader::new(client.try_clone().unwrap());
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let token =
                    serde_json::from_str::<serde_json::Value>(&line).unwrap_or_default()["token"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                let mut client = client;
                if token.trim() == owner.trim() {
                    let _ = client
                        .write_all(b"{\"Err\":\"owner token refused on the session socket\"}\n");
                    return;
                }
                let Ok(mut up) = UnixStream::connect(&real) else {
                    return;
                };
                let _ = up.write_all(line.as_bytes());
                let mut reply = String::new();
                let _ = BufReader::new(up).read_line(&mut reply);
                let _ = client.write_all(reply.as_bytes());
            });
        }
    });
    let profile = format!(
        "(version 1)(allow default)(deny network-outbound (remote unix-socket (path-literal \"{}\")))",
        core.home.join("core.sock").display()
    );
    let owner_via_relay = "printf '{\"token\":\"%s\",\"request\":{\"op\":\"snapshot\"}}\\n' \"$(cat \"$H/core.token\")\" | /usr/bin/nc -U \"$H/relay/core.sock\"";
    core.run_shell(
        &["/usr/bin/sandbox-exec", "-p", &profile],
        &format!(
            "probe agent env NUNCHIRO_HOME=\"$H/relay\" \"$CLI\" session list\n\
             probe direct \"$CLI\" session list\n\
             probe nested /usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/echo nested\n\
             {ESCAPE}\n\
             /usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); sleep 1; exec @ARGV' /bin/sh -c '{}' sh \"$H\"\n",
            format!("H=\"$1\"; {owner_via_relay} > \"$H/relayed.out\" 2>&1; echo \"exit=$?\" >> \"$H/relayed.out\"")
                .replace('\'', "'\\''")
        ),
    );
    // The agent CLI with its session token works through the token-only socket.
    let agent = core.out("agent");
    assert!(agent.contains("exit=0"), "{agent}");
    // Without that socket the agent CLI cannot reach the core at all.
    let direct = core.out("direct");
    assert!(!direct.contains("exit=0"), "{direct}");
    // The forked + setsid child cannot connect to core.sock: the profile is inherited and cannot be dropped.
    let escape = core.out("escape");
    assert!(!escape.contains("exit=0"), "{escape}");
    // The owner token sent to the session socket is refused by that socket.
    let relayed = core.out("relayed");
    assert!(relayed.contains("owner token refused"), "{relayed}");
    // Cost: no seatbelt inside the session, so agent CLIs' own sandboxes (Codex, Claude Code) cannot apply.
    let nested = core.out("nested");
    assert!(
        nested.contains("sandbox_apply: Operation not permitted"),
        "{nested}"
    );
}

/// Spike record (V1A-18): candidate C was dropped by OWNERC = D' (needs 47, v1a-23); this measurement stays.
/// Candidate C: refuse owner authority to a peer whose tree was reparented to launchd from a process forked
/// after the core. Closes the one-fork escape, admits the test process itself; the cost is any daemon
/// (tmux, herdr) started after the core.
#[test]
fn candidate_c_orphaned_after_core_refuses_the_escapee_only() {
    let core = Core::new();
    core.run_shell(&[], &format!("{ESCAPE}\n"));
    let start = proc(core.process.id() as i32).unwrap().version;
    let pid = escapee(&core);
    // Strict, but retried on None: `proc_pidinfo` fails for a moment while the escapee execs `sleep`.
    let escaped = (0..40).find_map(|_| {
        let r = orphaned_after(pid, start);
        r.or_else(|| {
            thread::sleep(Duration::from_millis(50));
            None
        })
    });
    assert_eq!(escaped, Some(true), "escapee");
    // `!= Some(true)`, not `Some(false)`: over ssh the chain ends in root's `sshd-session [priv]`, whose BSD
    // info is unreadable (EPERM), so the walk is None. The claim is only that this process is not orphaned-after.
    let me = orphaned_after(std::process::id() as i32, start);
    assert_ne!(me, Some(true), "this test process (outside every session)");
}

// V2-2d acceptance `account_remove_owner_only`: a session token and a remote forward are refused every remove step,
// and "Your own" is never checked or moved, even for the owner; the account folder and the registry stay as they were.
#[test]
fn account_remove_owner_only() {
    let core = Core::new();
    fs::write(
        core.home.join("accounts.toml"),
        "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"a1\"\nlabel = \"work\"\n",
    )
    .unwrap();
    fs::create_dir_all(core.home.join("accounts/claude/a1")).unwrap();
    let registry = fs::read_to_string(core.home.join("accounts.toml")).unwrap();
    core.run_shell(&[], "printf %s \"$NUNCHIRO_TOKEN\" > \"$H/session.token\"");
    let session = core.wait("session.token");
    let sock = core.home.join("core.sock");
    for step in ["check", "logout", "move"] {
        let request = serde_json::json!({"op":"account_remove","agent":"claude","id":"a1","step":step,"leftovers":true});
        assert_eq!(
            core.raw(&sock, &session, &request.to_string()),
            serde_json::json!({"Err":"operation not granted"}),
            "{step}"
        );
        let remote = serde_json::json!({"op":"remote","machine":"elsewhere","request":request});
        assert_eq!(
            core.raw(&sock, &core.token(), &remote.to_string()),
            serde_json::json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "{step}"
        );
        let own = serde_json::json!({"op":"account_remove","agent":"claude","id":"own","step":step,"leftovers":true});
        // Ticket 322: "Your own" can sign out, but only for the owner, here and never through a session or a remote.
        assert_eq!(
            core.raw(&sock, &session, &own.to_string()),
            serde_json::json!({"Err":"operation not granted"}),
            "own {step}"
        );
        let remote = serde_json::json!({"op":"remote","machine":"elsewhere","request":own});
        assert_eq!(
            core.raw(&sock, &core.token(), &remote.to_string()),
            serde_json::json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "own {step}"
        );
        if step == "logout" {
            continue; // the owner's sign-out: account_remove.rs own_logout_has_no_override
        }
        let r = core.raw(&sock, &core.token(), &own.to_string());
        assert!(
            r["Err"]
                .as_str()
                .is_some_and(|e| e.contains("the agent's own")),
            "{step}: {r}"
        );
    }
    assert!(core.home.join("accounts/claude/a1").is_dir());
    assert!(!core.home.join("accounts/.trash").exists());
    assert_eq!(
        fs::read_to_string(core.home.join("accounts.toml")).unwrap(),
        registry
    );
}

/// V2-4a: approving an `agent` subject (an `agents.toml` entry) is human-only. The agent CLI inside a session, with its
/// session token or with the owner token read from `core.token` (swapped for its session's), is refused, and nothing
/// is recorded; the owner outside every session approves.
#[test]
fn acp_agent_approval_human_only() {
    let core = Core::new();
    fs::write(
        core.home.join("agents.toml"),
        "[[agent]]\nname = \"evil\"\ncommand = \"/bin/sh\"\nargs = [\"-c\", \"touch /tmp/evil\"]\nenv = []\n",
    )
    .unwrap();
    let sock = core.home.join("core.sock");
    let view = core.raw(
        &sock,
        &core.token(),
        r#"{"op":"acp_agent_status","name":"evil"}"#,
    );
    let hash = view["Ok"]["view"]["hash"].as_str().unwrap().to_string();
    let grant = format!(r#"{{"op":"acp_agent_grant","name":"evil","hash":"{hash}"}}"#);
    fs::write(
        core.home.join("grant.tpl"),
        format!("{{\"token\":\"TOKEN\",\"request\":{grant}}}\n"),
    )
    .unwrap();
    let send = |token: &str| {
        format!(
            "/bin/sh -c 'sed \"s/TOKEN/{token}/\" \"$NUNCHIRO_HOME/grant.tpl\" | /usr/bin/nc -U \"$NUNCHIRO_HOME/core.sock\"'"
        )
    };
    core.run_shell(
        &[],
        &format!(
            "probe session {}\nprobe owner {}\n",
            send("$NUNCHIRO_TOKEN"),
            send("$(cat \"$NUNCHIRO_HOME/core.token\")"),
        ),
    );
    for name in ["session", "owner"] {
        let out = core.out(name);
        assert!(out.contains("operation not granted"), "{name}: {out}");
    }
    assert!(!core.home.join("approvals.json").exists());
    let view = core.raw(
        &sock,
        &core.token(),
        r#"{"op":"acp_agent_status","name":"evil"}"#,
    );
    assert_eq!(view["Ok"]["view"]["state"], "unapproved", "{view}");
    // Remote forwarding of the grant stays refused too.
    let remote = core.raw(
        &sock,
        &core.token(),
        &format!(r#"{{"op":"remote","machine":"m","request":{grant}}}"#),
    );
    assert!(
        remote["Err"]
            .as_str()
            .unwrap_or_default()
            .contains("local owner-only"),
        "{remote}"
    );
    // The owner outside every session approves.
    let r = core.raw(&sock, &core.token(), &grant);
    assert_eq!(r["Ok"]["view"]["state"], "approved", "{r}");
}

/// V2-5b: a problem card's fixes are the owner's. A session's token is refused for Restart and Start without Nunchiro
/// hooks on an ended session, and for Restart core (`exit`, what `serve restart` sends); the ended row stays as it was.
#[test]
fn problem_fix_requests_owner_only() {
    let core = Core::new();
    let sock = core.home.join("core.sock");
    let ended = serde_json::json!({"op":"start","session":{"kind":"shell","project":core.home,"label":"ended",
        "args":["/bin/sh","-c","exit 3"]}});
    let r = core.raw(&sock, &core.token(), &ended.to_string());
    let id = r["Ok"]["session"]["id"]
        .as_str()
        .expect("started")
        .to_string();
    let until = Instant::now() + Duration::from_secs(30);
    let row = |core: &Core| {
        core.raw(&sock, &core.token(), r#"{"op":"snapshot"}"#)["Ok"]["sessions"]
            .as_array()
            .and_then(|rows| rows.iter().find(|s| s["id"] == id.as_str()).cloned())
            .unwrap_or_default()
    };
    while row(&core)["state"] == "running" {
        assert!(Instant::now() < until, "the ended shell never ended");
        thread::sleep(Duration::from_millis(50));
    }
    core.run_shell(
        &[],
        "printf %s \"$NUNCHIRO_TOKEN\" > \"$H/session.token\"\n",
    );
    let session = core.wait("session.token");
    assert!(!session.is_empty());
    for request in [
        serde_json::json!({"op":"problem_fix","id":id,"fix":"restart"}),
        serde_json::json!({"op":"problem_fix","id":id,"fix":"start_without_hooks"}),
        serde_json::json!({"op":"exit"}),
    ] {
        let r = core.raw(&sock, &session, &request.to_string());
        assert_eq!(r["Err"], "operation not granted", "{request}: {r}");
    }
    let rows = core.raw(&sock, &core.token(), r#"{"op":"snapshot"}"#)["Ok"]["sessions"].clone();
    assert_eq!(rows.as_array().map(Vec::len), Some(2), "{rows}");
    assert_eq!(row(&core)["state"], "exited", "{rows}");
    // Control: the owner's request reaches the fix itself, which starts no shell again (a login tab's account folder
    // is not on its row).
    let r = core.raw(
        &sock,
        &core.token(),
        &serde_json::json!({"op":"problem_fix","id":id,"fix":"restart"}).to_string(),
    );
    assert_eq!(r["Err"], "start this shell again by hand", "{r}");
}

/// A child that ended, with the unique id it had while alive: reaped (its pid is free) or a zombie (its pid is still
/// listed but has no arguments). It blocks on its stdin, so the id is read before it ends, never racing its exit.
fn ended_child(reaped: bool) -> (i32, u64, Option<Child>) {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "read x"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id() as i32;
    let until = Instant::now() + Duration::from_secs(10);
    let id = loop {
        match live_id(pid) {
            Some(id) => break id,
            None => assert!(
                Instant::now() < until,
                "process {pid} never showed a unique id"
            ),
        }
        thread::sleep(Duration::from_millis(5));
    };
    drop(child.stdin.take()); // end of input: `read` returns and the shell exits
    if reaped {
        child.wait().unwrap();
        return (pid, id, None);
    }
    while live_id(pid) == Some(id) {
        assert!(Instant::now() < until, "process {pid} never ended");
        thread::sleep(Duration::from_millis(5));
    }
    (pid, id, Some(child))
}

/// `wait_for_sleep` on `pid`, but only the process holding the pid with unique id `pinned` counts; a program that
/// took the pid over reads as gone, so a freed pid handed to an unrelated `sleep` cannot answer for the ended child.
fn wait_pinned(
    pid: i32,
    pinned: u64,
    read: impl FnMut(i32) -> std::io::Result<(bool, bool, Vec<u8>)>,
    mut identity: impl FnMut(i32) -> Option<u64>,
) -> Result<(bool, bool), String> {
    wait_for_sleep(pid, Duration::from_secs(10), read, |p| {
        identity(p).filter(|id| *id == pinned)
    })
}

fn probe(pid: i32) -> (Result<(bool, bool), String>, Duration) {
    let start = Instant::now();
    let answer = wait_for_sleep(pid, Duration::from_secs(10), environment, live_id);
    (answer, start.elapsed())
}

/// `procargs_gone_process_named`: an exited pid (freed, or a zombie nobody reaped yet) fails at once and says so. The
/// ended child's unique id is pinned while it is alive, so a freed pid taken by an unrelated `sleep` still reads as gone.
#[test]
fn procargs_gone_process_named() {
    for reaped in [true, false] {
        let (pid, id, child) = ended_child(reaped);
        let start = Instant::now();
        let answer = wait_pinned(pid, id, environment, live_id);
        let took = start.elapsed();
        let why = answer.expect_err("an exited process has no sleep arguments");
        assert!(why.contains(&format!("process {pid} is gone")), "{why}");
        assert!(
            took < Duration::from_secs(2),
            "reaped={reaped}: took {took:?}"
        );
        if let Some(mut child) = child {
            child.wait().unwrap();
        }
    }
}

/// `procargs_gone_named_survives_pid_reuse`: the pid of an ended child is handed to another `sleep` (unique id 9, not
/// the child's 7) and the probe still says gone, never `Ok`.
#[test]
fn procargs_gone_named_survives_pid_reuse() {
    let answer = wait_pinned(42, 7, |_| Ok((true, true, b"sleep".to_vec())), |_| Some(9));
    let why = answer.expect_err("an unrelated sleep took the pid of the ended child");
    assert!(why.contains("process 42 is gone"), "{why}");
}

/// A pid seen alive that then ends is gone too, and the message says what it last ran.
#[test]
fn procargs_gone_after_seen_alive() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 0.6; true"])
        .spawn()
        .unwrap();
    let pid = child.id() as i32;
    let (answer, took) = probe(pid);
    let why = answer.expect_err("the process ended before it ran sleep");
    assert!(why.contains(&format!("process {pid} is gone")), "{why}");
    assert!(why.contains("last ran"), "{why}");
    assert!(took < Duration::from_secs(5), "took {took:?}");
    child.wait().unwrap();
}

/// `procargs_starting_process_still_polled`: a process that runs another program first, then `sleep`, is waited for.
#[test]
fn procargs_starting_process_still_polled() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 0.4; exec /bin/sleep 5"])
        .spawn()
        .unwrap();
    let (answer, took) = probe(child.id() as i32);
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    assert!(
        took >= Duration::from_millis(300),
        "returned before the exec: {took:?}"
    );
}

/// A pid taken over by another program is gone for the escapee; the new program's arguments are never returned.
#[test]
fn procargs_reused_pid_is_not_read() {
    let ids = std::cell::RefCell::new(vec![7u64, 7, 9, 9].into_iter());
    let reads = std::cell::Cell::new(0);
    let answer = wait_for_sleep(
        42,
        Duration::from_secs(10),
        |_| {
            reads.set(reads.get() + 1);
            // The first holder runs sh; the program that took the pid over runs sleep.
            let first: &[u8] = if reads.get() == 1 { b"sh" } else { b"sleep" };
            Ok((true, true, first.to_vec()))
        },
        |_| ids.borrow_mut().next(),
    );
    let why = answer.expect_err("the pid changed hands");
    assert!(
        why.contains("process 42 is gone") && why.contains("reused"),
        "{why}"
    );
}

/// Ticket 372 threat 2: Resume at <time> types into a session, so only the owner arms it. A session's token is refused,
/// for its own row too, and so is a remote forward; the owner's request reaches the handler, which arms nothing here
/// because no limit line is on the screen.
#[test]
fn limit_resume_owner_only() {
    let core = Core::new();
    let sock = core.home.join("core.sock");
    core.run_shell(&[], "printf %s \"$NUNCHIRO_TOKEN\" > \"$H/session.token\"");
    let session = core.wait("session.token");
    let rows = core.raw(&sock, &core.token(), r#"{"op":"snapshot"}"#)["Ok"]["sessions"].clone();
    let id = rows[0]["id"].as_str().expect("the shell row").to_string();
    for on in [true, false] {
        let request = serde_json::json!({"op":"limit_resume","id":id,"on":on});
        assert_eq!(
            core.raw(&sock, &session, &request.to_string()),
            serde_json::json!({"Err":"operation not granted"}),
            "{request}"
        );
        let remote = serde_json::json!({"op":"remote","machine":"elsewhere","request":request});
        assert_eq!(
            core.raw(&sock, &core.token(), &remote.to_string()),
            serde_json::json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "{request}"
        );
    }
    let own = serde_json::json!({"op":"limit_resume","id":id,"on":true});
    assert_eq!(
        core.raw(&sock, &core.token(), &own.to_string())["Err"],
        "no usage limit with a reset time ahead is on this session's screen"
    );
}
