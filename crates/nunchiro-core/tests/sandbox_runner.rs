use nunchiro_core::{
    approval::{self, Level},
    sandbox::{self, Profile},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "sandbox-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn proof(&self, script: &str) -> approval::Proof {
        let d = self.0.join("sources/demo");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            "version=1\nkind='integration'\ncommand=['/bin/sh','run.sh']\n",
        )
        .unwrap();
        fs::write(d.join("run.sh"), script).unwrap();
        let v = approval::source_status(&self.0, "demo").unwrap();
        approval::grant_source(&self.0, "demo", Level::Read, &v.hash).unwrap();
        approval::check_source(&self.0, "demo").unwrap()
    }
    fn profile(&self) -> Profile {
        Profile::new(
            self.0.join("core-home"),
            self.0.join("cache"),
            self.0.join("fake-home"),
        )
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn sandbox_missing_self_check_refuses_to_run() {
    let h = Home::new();
    let proof = h.proof("echo should-not-run\n");
    let mut p = h.profile();
    p.executable = h.0.join("missing-sandbox-exec");
    // v1a-70: a spawn error (ENOENT from exec), not a child that aborted after fork.
    let e = sandbox::run(&p, &proof).unwrap_err();
    assert!(
        e.contains("sandbox spawn") && e.contains("No such file or directory"),
        "{e}"
    );
}
fn denied_read(name: &str) {
    let h = Home::new();
    let secret = h.0.join("fake-home").join(name);
    fs::create_dir_all(&secret).unwrap();
    fs::write(secret.join("token"), "SECRET-SENTINEL").unwrap();
    let proof = h.proof(&format!(
        "if /bin/cat '{}' ; then exit 42; fi\necho DENIED\n",
        secret.join("token").display()
    ));
    assert_eq!(sandbox::run(&h.profile(), &proof).unwrap(), b"DENIED\n");
    assert_eq!(
        fs::read_to_string(secret.join("token")).unwrap(),
        "SECRET-SENTINEL"
    );
}
#[test]
fn sandbox_denied_claude_read() {
    denied_read(".claude");
}
#[test]
fn sandbox_denied_codex_read() {
    denied_read(".codex");
}
#[test]
fn sandbox_denied_ssh_read() {
    denied_read(".ssh");
}
#[test]
fn sandbox_denied_nunchiro_read() {
    denied_read(".nunchiro");
}
// v1b-21: common credential stores beyond the agent folders (review MUST 1; the read model itself is for the owner).
#[test]
fn sandbox_denied_credential_store_reads() {
    for name in [
        ".aws",
        ".gnupg",
        ".config/gh",
        ".docker",
        ".kube",
        ".netrc",
        ".git-credentials",
        "Library/Keychains",
    ] {
        denied_read(name);
    }
}
#[test]
fn sandbox_denied_write_outside_cache() {
    let h = Home::new();
    let out = h.0.join("outside");
    let proof = h.proof(&format!(
        "if echo bad > '{}' ; then exit 42; fi\necho DENIED\n",
        out.display()
    ));
    assert_eq!(sandbox::run(&h.profile(), &proof).unwrap(), b"DENIED\n");
    assert!(!out.exists());
}
#[test]
fn sandbox_denied_direct_network() {
    let h = Home::new();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let proof = h.proof(&format!(
        "if /usr/bin/nc -z -w 1 127.0.0.1 {port} ; then exit 42; fi\necho DENIED\n"
    ));
    assert_eq!(sandbox::run(&h.profile(), &proof).unwrap(), b"DENIED\n");
    assert!(listener.accept().is_err());
}
#[test]
fn sandbox_approved_snapshot_runs_after_source_changes() {
    let h = Home::new();
    let proof = h.proof("echo '한국어 original'\n");
    fs::write(h.0.join("sources/demo/run.sh"), "echo changed\n").unwrap();
    assert_eq!(
        sandbox::run(&h.profile(), &proof).unwrap(),
        "한국어 original\n".as_bytes()
    );
}
#[test]
fn sandbox_no_session_token_and_only_allowlisted_environment() {
    let h = Home::new();
    let proof = h.proof("/usr/bin/env\n");
    let output = String::from_utf8(sandbox::run(&h.profile(), &proof).unwrap()).unwrap();
    for line in output.lines() {
        let key = line.split('=').next().unwrap();
        assert!(
            [
                "PATH",
                "HOME",
                "TMPDIR",
                "LANG",
                "LC_ALL",
                "NUNCHIRO_CACHE",          // v1b-21
                "__CF_USER_TEXT_ENCODING", // v1b-33 r2: uid and UTF-8, no secret
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "http_proxy",
                "https_proxy",
                "PWD",
                "SHLVL",
                "_"
            ]
            .contains(&key),
            "{line}"
        );
    }
    // v1b-21: NUNCHIRO_CACHE is the one NUNCHIRO_ key; its value is the cache path.
    let other = output.replace("NUNCHIRO_CACHE=", "");
    assert!(!other.contains("NUNCHIRO_") && !output.contains("TOKEN="));
}
#[test]
fn sandbox_timeout_and_output_cap_are_bounded() {
    let h = Home::new();
    let proof = h.proof("/bin/sleep 5\n");
    let mut p = h.profile();
    p.timeout = std::time::Duration::from_millis(100);
    assert!(sandbox::run(&p, &proof).unwrap_err().contains("timeout"));
    let proof = h.proof("while :; do echo 123456789; done\n");
    p.timeout = std::time::Duration::from_secs(2);
    p.output_limit = 100;
    assert!(sandbox::run(&p, &proof).unwrap_err().contains("cap"));
}
#[test]
fn sandbox_proxy_resolved_address_refusals_and_public_allow() {
    use sandbox::proxy::checked_addresses;
    let allowed = vec!["example.com".into()];
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "169.254.1.1",
        "169.254.169.254",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "64:ff9b::7f00:1",
    ] {
        assert!(
            checked_addresses("example.com", &allowed, |_| Ok(vec![ip.parse().unwrap()])).is_err(),
            "{ip}"
        );
    }
    assert!(
        checked_addresses("unapproved.com", &allowed, |_| panic!(
            "must refuse before resolving"
        ))
        .is_err()
    );
    assert_eq!(
        checked_addresses("example.com", &allowed, |_| Ok(vec![
            "93.184.216.34".parse().unwrap()
        ]))
        .unwrap(),
        vec!["93.184.216.34".parse::<std::net::IpAddr>().unwrap()]
    );
    assert!(
        checked_addresses("example.com", &allowed, |_| Ok(vec![
            "93.184.216.34".parse().unwrap(),
            "127.0.0.1".parse().unwrap()
        ]))
        .is_err()
    );
}
#[test]
fn sandbox_proxy_connect_refuses_loopback_and_unapproved_host() {
    use std::io::{Read, Write};
    let proxy = sandbox::proxy::Proxy::start(&["127.0.0.1".into()]).unwrap();
    for host in ["127.0.0.1", "unapproved.example"] {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "CONNECT {host}:443 HTTP/1.1\r\nHost: {host}\r\n\r\n"
        )
        .unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
    }
}
#[test]
fn sandbox_detached_child_cannot_outlive_run_or_hold_output_open() {
    let h = Home::new();
    let mut p = h.profile();
    // v1b-21: warm the once-per-process self-check so the bound measures only the run.
    sandbox::run(&p, &h.proof("echo warm\n")).unwrap();
    let proof = h.proof(
        "/usr/bin/perl -MPOSIX -e 'if(fork()==0){POSIX::setsid(); sleep 2; exit 0}; exit 0'\n",
    );
    p.timeout = std::time::Duration::from_millis(100);
    let start = std::time::Instant::now();
    let _ = sandbox::run(&p, &proof);
    assert!(
        start.elapsed() < std::time::Duration::from_secs(1),
        "detached child held pipes for {:?}",
        start.elapsed()
    );
}
#[test]
fn sandbox_short_output_over_cap_is_never_truncated_success() {
    let h = Home::new();
    let proof = h.proof("/usr/bin/perl -e 'print \"x\" x 100000'\n");
    let mut p = h.profile();
    p.output_limit = 100;
    for _ in 0..5 {
        assert!(sandbox::run(&p, &proof).is_err());
    }
}
// v1a-17: the half-sent request is held under a header deadline only a stop can beat, rather than timed.
#[test]
fn sandbox_proxy_shutdown_does_not_wait_for_an_incomplete_request() {
    use std::{
        io::{Read, Write},
        net::TcpStream,
        time::Duration,
    };
    let proxy = sandbox::proxy::Proxy::start_holding(&[], Duration::from_secs(600)).unwrap();
    let mut held = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
    held.write_all(b"CONNECT ").unwrap();
    // One worker accepts clients in connect order and spawns a handler for each, so a later client answered means
    // the held one's handler exists. Drop joins every handler, so one that waited out its header would hold it.
    let mut later = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
    later
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    later.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
    let mut answer = [0; 12];
    later.read_exact(&mut answer).unwrap();
    assert_eq!(&answer, b"HTTP/1.1 403");
    let (done, dropped) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        drop(proxy);
        let _ = done.send(());
    });
    // The deadline only turns a drop that waits for the 600 s header deadline into a failure.
    assert!(
        dropped.recv_timeout(Duration::from_secs(60)).is_ok(),
        "dropping the proxy waited for the half-sent request"
    );
    drop(held);
}
#[test]
fn sandbox_configured_nunchiro_home_is_denied_except_own_cache() {
    let h = Home::new();
    let p = h.profile();
    fs::create_dir_all(&p.home).unwrap();
    let secret = p.home.join("core.token");
    fs::write(&secret, "FAKE-OWNER-TOKEN").unwrap();
    let proof = h.proof(&format!(
        "if /bin/cat '{}' ; then exit 42; fi\necho DENIED\n",
        secret.display()
    ));
    assert_eq!(sandbox::run(&p, &proof).unwrap(), b"DENIED\n");
}

#[test]
fn sandbox_widget_run_through_symlinked_home_succeeds() {
    let h = Home::new();
    let link = h.0.join("linked-home");
    std::os::unix::fs::symlink(&h.0, &link).unwrap();
    let d = h.0.join("widgets/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(d.join("run.sh"), "echo linked-widget\n").unwrap();
    let v = approval::status(&link, "demo").unwrap();
    approval::grant(&link, "demo", Level::Read, &v.hash).unwrap();
    let proof = approval::check(&link, "demo").unwrap();
    let p = Profile::new(
        link.clone(),
        link.join("widgets/demo/cache"),
        h.0.join("fake-home"),
    );
    assert_eq!(sandbox::run(&p, &proof).unwrap(), b"linked-widget\n");
}
#[test]
fn sandbox_duplicate_widget_run_error_names_widget() {
    let h = Home::new();
    let d = h.0.join("widgets/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(
        d.join("run.sh"),
        "echo ready > \"$NUNCHIRO_CACHE/started\"\n/bin/sleep 1\n",
    )
    .unwrap();
    let v = approval::status(&h.0, "demo").unwrap();
    approval::grant(&h.0, "demo", Level::Read, &v.hash).unwrap();
    let proof = approval::check(&h.0, "demo").unwrap();
    let mut p = h.profile();
    p.home = h.0.clone();
    let alias = h.0.join("alias-home");
    std::os::unix::fs::symlink(&h.0, &alias).unwrap();
    let mut alias_profile = p.clone();
    alias_profile.home = alias;
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| sandbox::run(&p, &proof));
        let start = std::time::Instant::now();
        while !p.cache.join("started").exists() {
            assert!(start.elapsed() < std::time::Duration::from_secs(4));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            sandbox::run(&alias_profile, &proof).unwrap_err(),
            "widget already running"
        );
        worker.join().unwrap().unwrap();
    });
}

#[test]
fn sandbox_symlinked_home_denies_resolved_token_and_allows_cache() {
    let h = Home::new();
    let link = h.0.join("linked-home");
    std::os::unix::fs::symlink(&h.0, &link).unwrap();
    fs::write(h.0.join("core.token"), "FAKE-OWNER-TOKEN").unwrap();
    let proof = h.proof(&format!(
        "if /bin/cat '{}' 2>/dev/null; then exit 42; fi\nif /bin/cat '{}' 2>/dev/null; then exit 43; fi\necho cached > \"$NUNCHIRO_CACHE/result\" || exit 44\necho DENIED\n",
        h.0.join("core.token").display(),
        link.join("core.token").display()
    ));
    let p = Profile::new(
        link.clone(),
        link.join("sources/demo/cache"),
        h.0.join("fake-home"),
    );
    assert_eq!(sandbox::run(&p, &proof).unwrap(), b"DENIED\n");
    assert_eq!(
        fs::read_to_string(h.0.join("sources/demo/cache/result")).unwrap(),
        "cached\n"
    );
}
// v1b-33 r2: CoreFoundation reads the user's text encoding from `__CF_USER_TEXT_ENCODING` and otherwise asks the
// directory service (getpwuid), a mach lookup the sandbox refuses; node then stalls at start on the refused notifyd
// pipe. The runner sets it (uid, UTF-8), so no run asks.
#[test]
fn sandbox_sets_cf_user_text_encoding() {
    let h = Home::new();
    let proof = h.proof("echo \"$__CF_USER_TEXT_ENCODING\"\n");
    let uid = unsafe { libc::getuid() };
    assert_eq!(
        String::from_utf8(sandbox::run(&h.profile(), &proof).unwrap()).unwrap(),
        format!("0x{uid:X}:0x8000100:0x8000100\n")
    );
}
// v1a-70: a descriptor the core holds without close-on-exec (a socket pair made non-atomically) must not reach a run.
#[test]
fn sandbox_run_inherits_no_descriptors_beyond_stdio() {
    let h = Home::new();
    let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
    let fd = std::os::fd::AsRawFd::as_raw_fd(&a);
    assert!(fd >= 3);
    unsafe { assert_eq!(libc::fcntl(fd, libc::F_SETFD, 0), 0) };
    let proof = h.proof(
        // perl, not sh: the shell keeps its own fd 10 for redirections.
        "/usr/bin/perl -e 'for (3..1024) { print \"open $_\\n\" if open(my $f, \"<&=\", $_) }'\necho probed\n",
    );
    assert_eq!(sandbox::run(&h.profile(), &proof).unwrap(), b"probed\n");
}
