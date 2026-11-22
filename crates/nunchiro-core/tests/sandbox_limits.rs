// v1b-21: runner limits, kill reach and the per-run HOME. Limits are read back or proven with tiny overrides; nothing
// here generates load (ruling 05:02).
use nunchiro_core::{
    approval::{self, Level},
    sandbox::{self, Profile},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "limits-{}-{}",
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
            self.0.join("sources/demo/cache"),
            self.0.join("fake-home"),
        )
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// One group SIGKILL can miss a child whose fork is in flight (addendum 07:32: a child outlived its run once; a probe
// outside the sandbox left survivors in 8 of 30 kills). The parent forks across the timeout so the kill lands inside
// the loop; every child records its own pid first, so a survivor is seen even if its parent died before fork returned.
#[test]
fn sandbox_kill_reaches_children_forked_during_the_kill() {
    let h = Home::new();
    let mut p = h.profile();
    // Warm the once-per-process self-check so the clock below measures only the kill.
    sandbox::run(&p, &h.proof("echo warm\n")).unwrap();
    let proof = h.proof(
        "/usr/bin/perl -e 'for (1..100) { my $p = fork(); defined $p or last; if ($p == 0) { open(my $f, \">>\", \"$ENV{NUNCHIRO_CACHE}/pids\"); print $f \"$$\\n\"; close $f; sleep 3; exit 0 } select(undef,undef,undef,0.001) } sleep 3'\n",
    );
    p.timeout = Duration::from_millis(50);
    let pids = p.cache.join("pids");
    for _ in 0..10 {
        let _ = fs::remove_file(&pids);
        let start = Instant::now();
        assert!(sandbox::run(&p, &proof).is_err());
        let elapsed = start.elapsed();
        std::thread::sleep(Duration::from_millis(50));
        let alive: Vec<i32> = fs::read_to_string(&pids)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.parse().ok())
            .filter(|&pid| unsafe { libc::kill(pid, 0) } == 0)
            .collect();
        for &pid in &alive {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(alive.is_empty(), "children outlived the run: {alive:?}");
        assert!(
            elapsed < Duration::from_secs(1),
            "a forked child held the output open for {elapsed:?}"
        );
    }
}

fn run(p: &Profile, proof: &approval::Proof) -> String {
    String::from_utf8(sandbox::run(p, proof).unwrap()).unwrap()
}

#[test]
fn sandbox_planted_zshenv_in_cache_does_not_run() {
    let h = Home::new();
    let p = h.profile();
    fs::create_dir_all(&p.cache).unwrap();
    fs::write(p.cache.join(".zshenv"), "echo PLANTED\n").unwrap();
    fs::write(p.cache.join(".gitconfig"), "[user]\n\tname = PLANTED\n").unwrap();
    let proof = h.proof("/bin/zsh -c 'echo zsh-ok'\n/bin/ls -A \"$HOME\"\necho end\n");
    assert_eq!(run(&p, &proof), "zsh-ok\nend\n");
}

#[test]
fn sandbox_home_is_empty_and_new_each_run() {
    let h = Home::new();
    let p = h.profile();
    let proof = h.proof(
        "echo \"$HOME\"\necho \"$TMPDIR\"\n/bin/ls -A \"$HOME\"\n/usr/bin/stat -f %Lp \"$HOME\"\necho kept > \"$HOME/x\" || exit 9\n",
    );
    let first = run(&p, &proof);
    let second = run(&p, &proof);
    let lines: Vec<&str> = first.lines().collect();
    assert_eq!(lines.len(), 3, "{first}");
    assert_eq!(lines[0], lines[1], "TMPDIR is the run's HOME");
    assert_eq!(lines[2], "700");
    let runs = p.cache.canonicalize().unwrap().join(".runs");
    assert!(lines[0].starts_with(runs.to_str().unwrap()), "{first}");
    assert!(
        !std::path::Path::new(lines[0]).exists(),
        "HOME kept after the run"
    );
    assert_ne!(first.lines().next(), second.lines().next());
    assert_eq!(second.lines().count(), 3, "second HOME not empty: {second}");
}

#[test]
fn sandbox_cache_path_env_set() {
    let h = Home::new();
    let p = h.profile();
    let proof = h.proof("echo \"$NUNCHIRO_CACHE\"\necho saved > \"$NUNCHIRO_CACHE/note\"\n");
    assert_eq!(
        run(&p, &proof).trim_end(),
        p.cache.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(fs::read_to_string(p.cache.join("note")).unwrap(), "saved\n");
}

#[test]
fn sandbox_file_size_limit_reads_back_and_stops_a_large_write() {
    let h = Home::new();
    let mut p = h.profile();
    let proof = h.proof("ulimit -f\n");
    // Default: 64 MiB in the 1024-byte blocks /bin/sh reports.
    assert_eq!(run(&p, &proof), "65536\n");
    p.cache_limit = 1024 * 1024;
    assert_eq!(run(&p, &proof), "1024\n");
    let proof = h.proof(
        "/bin/dd if=/dev/zero of=\"$NUNCHIRO_CACHE/big\" bs=65536 count=32 2>/dev/null && exit 9\necho stopped\n",
    );
    assert_eq!(run(&p, &proof), "stopped\n");
    assert!(fs::metadata(p.cache.join("big")).unwrap().len() <= 1024 * 1024);
}

#[test]
fn sandbox_cache_over_cap_refuses_and_keeps_the_cache() {
    let h = Home::new();
    let mut p = h.profile();
    p.cache_limit = 1024 * 1024;
    fs::create_dir_all(&p.cache).unwrap();
    fs::write(p.cache.join("old"), vec![7u8; 2 * 1024 * 1024]).unwrap();
    let proof = h.proof("echo should-not-run\n");
    assert_eq!(sandbox::run(&p, &proof).unwrap_err(), "cache over 1 MiB");
    assert_eq!(
        fs::metadata(p.cache.join("old")).unwrap().len(),
        2 * 1024 * 1024
    );
    fs::remove_file(p.cache.join("old")).unwrap();
    assert_eq!(run(&p, &proof), "should-not-run\n");
}

// RLIMIT_NPROC is per user on macOS: the child gets the user's current count plus headroom, so it bounds only the
// widget's forks; this process (and every other process of the user) keeps its own limit.
#[test]
fn sandbox_process_limit_reads_back_and_leaves_the_caller_alone() {
    let h = Home::new();
    let p = h.profile();
    let mut before: libc::rlimit = unsafe { std::mem::zeroed() };
    unsafe { libc::getrlimit(libc::RLIMIT_NPROC, &mut before) };
    let limit: u64 = run(&p, &h.proof("ulimit -u\n")).trim().parse().unwrap();
    let mut after: libc::rlimit = unsafe { std::mem::zeroed() };
    unsafe { libc::getrlimit(libc::RLIMIT_NPROC, &mut after) };
    assert_eq!(
        (before.rlim_cur, before.rlim_max),
        (after.rlim_cur, after.rlim_max)
    );
    let users = std::process::Command::new("/bin/ps")
        .args(["-U", &unsafe { libc::getuid() }.to_string(), "-o", "pid="])
        .output()
        .unwrap()
        .stdout
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .count() as u64;
    assert!(
        limit < before.rlim_cur,
        "{limit} not below {}",
        before.rlim_cur
    );
    assert!(
        limit >= users && limit <= users + 64 + 64,
        "{limit} vs {users} user processes"
    );
}

#[test]
fn sandbox_symlink_planted_in_cache_cannot_write_outside() {
    let h = Home::new();
    let p = h.profile();
    let outside = h.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(&p.cache).unwrap();
    std::os::unix::fs::symlink(&outside, p.cache.join("link")).unwrap();
    let proof = h.proof(
        "if echo bad > \"$NUNCHIRO_CACHE/link/x\" 2>/dev/null; then exit 42; fi\necho DENIED\n",
    );
    assert_eq!(run(&p, &proof), "DENIED\n");
    assert!(!outside.join("x").exists());
}

#[test]
fn sandbox_runs_never_share_a_run_dir_and_leave_none_behind() {
    let h = Home::new();
    let mut p = h.profile();
    let proof = h.proof("/bin/pwd -P\n");
    let (a, b) = (run(&p, &proof), run(&p, &proof));
    assert_ne!(a, b);
    let runs = p.cache.join(".runs");
    // A run dir left by a killed core is swept by the next run of the subject.
    fs::create_dir_all(runs.join("stale/home")).unwrap();
    let slow = h.proof("/bin/sleep 3\n");
    p.timeout = Duration::from_millis(100);
    assert!(sandbox::run(&p, &slow).is_err());
    p.timeout = Duration::from_secs(5);
    run(&p, &proof);
    assert_eq!(fs::read_dir(&runs).unwrap().count(), 0);
}

#[test]
fn sandbox_hangul_cache_path_and_output() {
    let h = Home::new();
    let mut p = h.profile();
    p.cache = h.0.join("sources/demo/캐시");
    let proof = h.proof(
        "echo \"한글 출력\" > \"$NUNCHIRO_CACHE/메모\"\n/bin/cat \"$NUNCHIRO_CACHE/메모\"\n",
    );
    assert_eq!(run(&p, &proof), "한글 출력\n");
    assert!(p.cache.join("메모").exists());
}

// v1b-21 r2: a core that died mid-run left a record in its home (never in the widget-writable cache). The next open
// kills that group only while its leader is the same process, and removes the run dirs the dead core left.
#[test]
fn sandbox_sweep_kills_recorded_runs_and_removes_stale_run_dirs() {
    use std::os::unix::process::CommandExt;
    let h = Home::new();
    let spawn = || {
        std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap()
    };
    let (mut ours, mut other) = (spawn(), spawn());
    let records = h.0.join(".sandbox-runs");
    fs::create_dir_all(&records).unwrap();
    let (s, u) = sandbox::group_start(ours.id() as i32).unwrap();
    fs::write(records.join(ours.id().to_string()), format!("{s}.{u}")).unwrap();
    // A reused id: same pid, another start time. Never killed.
    let (s, u) = sandbox::group_start(other.id() as i32).unwrap();
    fs::write(
        records.join(other.id().to_string()),
        format!("{s}.{}", u + 1),
    )
    .unwrap();
    let stale = h.0.join("widgets/w/cache/.runs/old/home");
    fs::create_dir_all(&stale).unwrap();
    let outside = h.0.join("outside");
    fs::create_dir_all(outside.join("keep")).unwrap();
    fs::create_dir_all(h.0.join("sources/s/cache")).unwrap();
    std::os::unix::fs::symlink(&outside, h.0.join("sources/s/cache/.runs")).unwrap();

    sandbox::sweep(&h.0);

    std::thread::sleep(Duration::from_millis(100));
    assert!(ours.try_wait().unwrap().is_some(), "recorded run survived");
    let survived = other.try_wait().unwrap().is_none();
    let _ = other.kill();
    let _ = other.wait();
    assert!(survived, "a mismatched record killed an unrelated process");
    assert_eq!(fs::read_dir(&records).unwrap().count(), 0);
    assert_eq!(
        fs::read_dir(h.0.join("widgets/w/cache/.runs"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        outside.join("keep").exists(),
        "sweep followed a symlinked .runs"
    );
}

// v1b-21 r3: a run that reaches its spawn after the core stopped (its self-check done outside the live lock) never
// starts; the next open of that home runs again.
#[test]
fn sandbox_run_after_stop_never_spawns() {
    let h = Home::new();
    let p = h.profile();
    sandbox::run(&p, &h.proof("echo warm\n")).unwrap();
    let proof = h.proof("echo ran > \"$NUNCHIRO_CACHE/marker\"\n/bin/sleep 30\n");
    sandbox::stop_all(&p.home);
    assert!(sandbox::run(&p, &proof).unwrap_err().contains("stopping"));
    assert!(!p.cache.join("marker").exists());
    sandbox::sweep(&p.home);
    assert_eq!(run(&p, &h.proof("echo again\n")), "again\n");
}
