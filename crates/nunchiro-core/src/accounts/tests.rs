use super::*;
// V2-2a r2: the cap holds across callers: many threads asking at once never run more than PROBES_AT_ONCE.
#[test]
fn probe_cap_is_global() {
    use std::sync::atomic::AtomicUsize;
    static NOW: AtomicUsize = AtomicUsize::new(0);
    static MOST: AtomicUsize = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..40 {
            scope.spawn(|| {
                let _slot = PROBES.take(None).unwrap();
                let n = NOW.fetch_add(1, Ordering::SeqCst) + 1;
                MOST.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                NOW.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let most = MOST.load(Ordering::SeqCst);
    assert!(most > 1 && most <= PROBES_AT_ONCE, "{most}");
    assert_eq!(PROBES.state.lock().unwrap().0, 0);
}
/// Ticket 424: the probe runs `claude` by its absolute path on the probe's own PATH (posix_spawn, not a fork of
/// the core), with the same arguments and environment.
#[test]
fn probe_command_runs_an_absolute_program() {
    use std::{ffi::OsStr, os::unix::fs::PermissionsExt};
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("probe-command-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("claude"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(dir.join("claude"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths(["/nonexistent-424".as_ref(), dir.as_path()]).unwrap();
    let core = |key: &str| (key == "PATH").then(|| path.clone());
    let command = probe_command(Agent::Claude, Some(Path::new("/acct")), core);
    assert_eq!(command.get_program(), dir.join("claude").as_os_str());
    assert!(Path::new(command.get_program()).is_absolute());
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, ["auth", "status", "--json"]);
    // Round 2: argv[0] is still the bare name (std has no getter; its Debug prints `[program] "argv0" args`).
    let shown = format!("{command:?}");
    let argv = format!(
        "[{:?}] \"claude\" \"auth\" \"status\" \"--json\"",
        dir.join("claude")
    );
    assert!(shown.ends_with(&argv), "{shown}");
    let envs: Vec<_> = command.get_envs().collect();
    assert!(envs.contains(&(OsStr::new("PATH"), Some(path.as_os_str()))));
    assert!(envs.contains(&(OsStr::new("CLAUDE_CONFIG_DIR"), Some(OsStr::new("/acct")))));
    assert_eq!(envs.len(), 2);
    // Not on that PATH: the bare name, so the run fails as it did before.
    let none = probe_command(Agent::Codex, None, |key| {
        (key == "PATH").then(|| "/nonexistent-424".into())
    });
    assert_eq!(none.get_program(), "codex");
    fs::remove_dir_all(&dir).unwrap();
}
#[test]
fn own_probe_passes_securestorage_dir() {
    let core = |key: &str| match key {
        "PATH" => Some("/bin".into()),
        "HOME" => Some("/h".into()),
        "CLAUDE_SECURESTORAGE_CONFIG_DIR" => Some("/x".into()),
        _ => None,
    };
    let has = |env: &[(&str, OsString)], key: &str| env.iter().any(|(k, _)| *k == key);
    let own = probe_env(Agent::Claude, None, core);
    assert!(own.contains(&("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/x".into())));
    assert!(has(&own, "HOME") && has(&own, "PATH"));
    let account = probe_env(Agent::Claude, Some(Path::new("/acct")), core);
    assert!(!has(&account, "CLAUDE_SECURESTORAGE_CONFIG_DIR"));
    assert!(account.contains(&("CLAUDE_CONFIG_DIR", "/acct".into())));
    let codex = probe_env(Agent::Codex, None, core);
    assert!(!has(&codex, "CLAUDE_SECURESTORAGE_CONFIG_DIR"));
    assert!(!has(
        &probe_env(Agent::Codex, Some(Path::new("/c")), core),
        "CLAUDE_SECURESTORAGE_CONFIG_DIR"
    ));
}
// Ticket 449: every probe names the user as the login did, so the agent finds the login it stored.
#[test]
fn probe_passes_the_cores_user() {
    let core = |key: &str| match key {
        "PATH" => Some("/bin".into()),
        "USER" => Some("me".into()),
        _ => None,
    };
    for agent in [Agent::Claude, Agent::Codex] {
        for folder in [None, Some(Path::new("/acct"))] {
            assert!(probe_env(agent, folder, core).contains(&("USER", "me".into())));
        }
    }
    // A core with no USER adds none: the login had none either.
    let none = probe_env(Agent::Claude, Some(Path::new("/acct")), |_: &str| None);
    assert!(none.iter().all(|(k, _)| *k != "USER"));
}
// V2-2b: what a core started from a session drops is what a launch on an account clears.
#[test]
fn config_env_is_in_the_launch_list() {
    assert!(
        CONFIG_ENV
            .iter()
            .all(|k| crate::sessions::ACCOUNT_ENV.contains(k))
    );
}
// V2-2d threat 2 (TOCTOU): a link or another folder swapped in after the account folder was opened, before the
// move, is put back and nothing is removed: the link's target is never entered or moved, the registry keeps the
// account. Without a swap the same call moves the folder.
#[test]
fn to_trash_refuses_a_folder_swapped_after_open() {
    use std::os::unix::fs::symlink;
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("acct-swap-{}", store::new_id().unwrap()));
    fs::create_dir_all(&home).unwrap();
    let home = fs::canonicalize(&home).unwrap();
    let account = add(&home, Agent::Claude, "work").unwrap();
    let outside = home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("file"), "precious").unwrap();
    let aside = home.join("aside");
    let swaps: [&dyn Fn(); 2] = [&|| symlink(&outside, &account.folder).unwrap(), &|| {
        fs::create_dir(&account.folder).unwrap()
    }];
    for swap in swaps {
        let err = to_trash(&home, Agent::Claude, &account.id, 7, || {
            fs::rename(&account.folder, &aside).unwrap();
            swap();
        })
        .unwrap_err();
        assert!(err.contains("changed"), "{err}");
        assert_eq!(
            fs::read_to_string(outside.join("file")).unwrap(),
            "precious"
        );
        assert_eq!(
            fs::read_dir(home.join("accounts/.trash")).unwrap().count(),
            0
        );
        assert_eq!(registered(&home).unwrap().len(), 1);
        // Put the real folder back for the next round.
        let m = fs::symlink_metadata(&account.folder).unwrap();
        if m.is_dir() {
            fs::remove_dir(&account.folder).unwrap();
        } else {
            fs::remove_file(&account.folder).unwrap();
        }
        fs::rename(&aside, &account.folder).unwrap();
    }
    let moved = to_trash(&home, Agent::Claude, &account.id, 7, || {}).unwrap();
    assert_eq!(
        moved,
        home.join(format!("accounts/.trash/{}-7", account.id))
    );
    assert!(moved.is_dir() && !account.folder.exists());
    assert!(registered(&home).unwrap().is_empty());
    fs::remove_dir_all(&home).unwrap();
}
/// A fake `codex login status` in a fresh folder: it counts its runs in `runs` (`$n` is this run's number), then
/// follows `script`.
fn fake_status(name: &str, script: &str) -> (PathBuf, PathBuf) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("probe-{name}-{}", store::new_id().unwrap()));
    fs::create_dir_all(&dir).unwrap();
    let dir = fs::canonicalize(&dir).unwrap();
    let program = dir.join("codex");
    let runs = dir.join("runs");
    fs::write(
        &program,
        format!(
            "#!/bin/sh\necho run >> '{0}'\nn=$(wc -l < '{0}')\n{script}\n",
            runs.display()
        ),
    )
    .unwrap();
    fs::set_permissions(
        &program,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    (dir, program)
}
fn runs(dir: &Path) -> usize {
    fs::read_to_string(dir.join("runs")).map_or(0, |s| s.lines().count())
}
/// For runs that never answer: short, so two of them stay quick.
const LIMIT: Duration = Duration::from_millis(400);
/// For runs that must answer: seconds, so a slow machine still answers inside it (round 2: 400 ms flaked under load).
const ANSWER_LIMIT: Duration = Duration::from_secs(4);
// Accounts probe 11-10: a status run that timed out is run once more, under the same limit, and its answer kept. The
// first run sleeps far past the limit; the counter file makes the second answer at once.
#[test]
fn probe_retries_once_after_a_timeout() {
    let (dir, program) = fake_status(
        "slow-once",
        "[ \"$n\" -le 1 ] && exec sleep 60\necho 'Logged in using ChatGPT' >&2; exit 0",
    );
    let started = Instant::now();
    let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
    let took = started.elapsed();
    assert_eq!(state, SignedIn::Yes);
    assert_eq!(runs(&dir), 2);
    // The first run used its whole limit; the second did not need another.
    assert!(took >= ANSWER_LIMIT && took < ANSWER_LIMIT * 2, "{took:?}");
    fs::remove_dir_all(&dir).unwrap();
}
// A run that never started is run once more too.
#[test]
fn probe_retries_once_after_a_start_failure() {
    let (dir, program) = fake_status("start", "echo 'Not logged in' >&2; exit 1");
    let tries = std::cell::Cell::new(0);
    let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || {
        tries.set(tries.get() + 1);
        Command::new(if tries.get() == 1 {
            dir.join("missing")
        } else {
            program.clone()
        })
    });
    assert_eq!(state, SignedIn::No);
    assert_eq!((tries.get(), runs(&dir)), (2, 1));
    fs::remove_dir_all(&dir).unwrap();
}
// Two timeouts: unknown, after two runs, inside two limits plus the time to stop each run.
#[test]
fn probe_gives_up_after_two_timeouts() {
    let (dir, program) = fake_status("slow", "exec sleep 5");
    let started = Instant::now();
    let (state, plan) = probe_runs(Agent::Codex, LIMIT, || Command::new(&program));
    let took = started.elapsed();
    assert_eq!((state, plan), (SignedIn::Unknown, None));
    assert_eq!(runs(&dir), 2);
    // The upper bound only says "it does not wait out the 5 s sleep twice": 30 s, because under a full parallel
    // test run stopping the two children took more than 5 s once (gate run 11-17; `runs == 2` is the real check).
    assert!(
        took >= LIMIT * 2 && took < LIMIT * 2 + Duration::from_secs(30),
        "{took:?}"
    );
    fs::remove_dir_all(&dir).unwrap();
}
// An answer is never asked again: signed out, a garbled answer, a run killed by a signal after it printed: one run each.
#[test]
fn probe_keeps_any_answer_after_one_run() {
    for (name, script, want) in [
        ("out", "echo 'Not logged in' >&2; exit 1", SignedIn::No),
        ("odd", "echo 'what' >&2; exit 3", SignedIn::Unknown),
        (
            "killed-late",
            "echo 'Not logged in' >&2; kill -9 $$",
            SignedIn::Unknown,
        ),
    ] {
        let (dir, program) = fake_status(name, script);
        let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
        assert_eq!((name, state, runs(&dir)), (name, want, 1));
        fs::remove_dir_all(&dir).unwrap();
    }
}
// Round 2 (captured under load: a status run killed by SIGKILL before it printed anything): a run killed before any
// output gave no answer, like one that timed out, so it is run once more; killed twice is unknown after two runs.
#[test]
fn probe_retries_once_after_a_silent_kill() {
    for (name, script, want) in [
        (
            "killed-once",
            "[ \"$n\" -le 1 ] && kill -9 $$\necho 'Logged in using ChatGPT' >&2; exit 0",
            SignedIn::Yes,
        ),
        ("killed-twice", "kill -9 $$", SignedIn::Unknown),
    ] {
        let (dir, program) = fake_status(name, script);
        let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
        assert_eq!((name, state, runs(&dir)), (name, want, 2));
        fs::remove_dir_all(&dir).unwrap();
    }
}
/// Round 3: a fake "Your own" probe the test drives: it says when it started, then answers what the test sends.
#[allow(clippy::type_complexity)] // a test helper's three-part handle
fn driven(
    runs: &std::sync::atomic::AtomicUsize,
) -> (
    std::sync::mpsc::Sender<Answer>,
    std::sync::mpsc::Receiver<()>,
    impl FnOnce(&dyn Fn()) -> Option<Answer> + Send + '_,
) {
    let (answer, answers) = std::sync::mpsc::channel::<Answer>();
    let (started, starts) = std::sync::mpsc::channel();
    // Holds its probe slot at once (ticket 423: a joiner's bound counts from there).
    let probe = move |slotted: &dyn Fn()| {
        slotted();
        runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        started.send(()).unwrap();
        Some(answers.recv().unwrap_or((SignedIn::Unknown, None)))
    };
    (answer, starts, probe)
}
fn own_running(e: &OwnEntry) -> bool {
    e.running.is_some()
}
fn own_state(e: &OwnEntry) -> SignedIn {
    e.state
}
/// `n` callers hold the running check's completion besides the cache and the check itself.
fn joined(cache: &OwnCache, n: usize) -> bool {
    matches!(&cache.entries.lock().unwrap()[0], Some(OwnEntry { running: Some(c), .. }) if Arc::strong_count(c) == 2 + n)
}
fn running(cache: &OwnCache) -> bool {
    matches!(&cache.entries.lock().unwrap()[0], Some(e) if own_running(e))
}
fn stored(cache: &OwnCache) -> Option<SignedIn> {
    cache.entries.lock().unwrap()[0].as_ref().map(own_state)
}
const BOUND: Duration = Duration::from_secs(10);
// Round 3, finding 2: A runs; a sign-in tab clears the entry; B starts a replacement; A finishes. A's answer must not
// finish B: B is still running, a caller that arrives joins B (no new probe) and gets B's answer, which the cache
// keeps.
#[test]
fn own_old_check_never_finishes_a_newer_one() {
    let cache = OwnCache::new();
    let runs = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(|| own_check(&cache, 0, false, BOUND, a));
        a_started.recv().unwrap();
        cache.entries.lock().unwrap()[0] = None; // as `own_tab` does
        let (to_b, b_started, b) = driven(&runs);
        let b = s.spawn(|| own_check(&cache, 0, false, BOUND, b));
        b_started.recv().unwrap();
        to_a.send((SignedIn::Yes, None)).unwrap();
        assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
        assert!(running(&cache), "A's answer finished B's check");
        let (_to_c, _c_started, c) = driven(&runs);
        let c = s.spawn(|| own_check(&cache, 0, true, BOUND, c));
        while !joined(&cache, 1) {
            std::thread::yield_now();
        }
        to_b.send((SignedIn::No, None)).unwrap();
        assert_eq!(b.join().unwrap().unwrap().0, SignedIn::No);
        assert_eq!(c.join().unwrap().unwrap().0, SignedIn::No);
    });
    assert_eq!(runs.into_inner(), 2);
    assert_eq!(stored(&cache), Some(SignedIn::No));
    assert!(!running(&cache));
}
// Round 3, finding 1: B joined A; A finishes; a forced C then starts a new check. B returns A's answer at once and
// never follows C.
#[test]
fn own_joiner_takes_its_own_check_answer() {
    let cache = OwnCache::new();
    let cache = &cache;
    let runs = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
        a_started.recv().unwrap();
        let (b_done, b_answer) = std::sync::mpsc::channel();
        s.spawn(move || {
            b_done
                .send(own_check(cache, 0, false, BOUND, |_| {
                    unreachable!("a joiner runs no probe")
                }))
                .unwrap()
        });
        while !joined(cache, 1) {
            std::thread::yield_now();
        }
        to_a.send((SignedIn::Yes, Some("max".into()))).unwrap();
        assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
        let (to_c, c_started, c) = driven(&runs);
        let c = s.spawn(|| own_check(cache, 0, true, BOUND, c));
        c_started.recv().unwrap();
        assert!(running(cache));
        // C still runs: B must already have A's answer.
        let got = b_answer
            .recv_timeout(Duration::from_secs(5))
            .expect("B followed C");
        assert_eq!(got, Some((SignedIn::Yes, Some("max".into()))));
        to_c.send((SignedIn::No, None)).unwrap();
        assert_eq!(c.join().unwrap().unwrap().0, SignedIn::No);
    });
    assert_eq!(runs.into_inner(), 2);
    assert_eq!(stored(cache), Some(SignedIn::No));
}
// Round 3: a check that panics wakes its joiners with unknown and stores nothing; one whose probe gave no answer
// stores that unknown (the real "Couldn't check"), never a false yes or no.
#[test]
fn own_failed_check_wakes_its_joiners() {
    let cache = OwnCache::new();
    let cache = &cache;
    let runs = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(move || {
            own_check(cache, 0, false, BOUND, |slotted| {
                let _ = a(slotted);
                panic!("probe panicked")
            })
        });
        a_started.recv().unwrap();
        let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
        while !joined(cache, 1) {
            std::thread::yield_now();
        }
        to_a.send((SignedIn::Yes, None)).unwrap();
        assert!(a.join().is_err());
        assert_eq!(b.join().unwrap(), Some((SignedIn::Unknown, None)));
    });
    assert_eq!(stored(cache), None);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
        a_started.recv().unwrap();
        let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
        while !joined(cache, 1) {
            std::thread::yield_now();
        }
        to_a.send((SignedIn::Unknown, None)).unwrap();
        assert_eq!(a.join().unwrap(), Some((SignedIn::Unknown, None)));
        assert_eq!(b.join().unwrap(), Some((SignedIn::Unknown, None)));
    });
    assert_eq!(stored(cache), Some(SignedIn::Unknown));
    assert!(!running(cache));
}
// Round 3: a joiner waits at most its bound for a check that never lands, then answers unknown and stores nothing.
#[test]
fn own_joiner_is_released_at_its_bound() {
    let cache = OwnCache::new();
    let cache = &cache;
    let runs = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
        a_started.recv().unwrap();
        let started = Instant::now();
        let bound = Duration::from_millis(300);
        let got = own_check(cache, 0, true, bound, |_| unreachable!());
        let took = started.elapsed();
        // The check held its slot for the whole bound (it slotted before the join): overdue, so unknown.
        assert_eq!(got, Some((SignedIn::Unknown, None)));
        assert!(
            took >= bound && took < bound + Duration::from_secs(5),
            "{took:?}"
        );
        assert!(running(cache), "the joiner stored something");
        to_a.send((SignedIn::Yes, None)).unwrap();
        a.join().unwrap();
    });
    assert_eq!(stored(cache), Some(SignedIn::Yes));
}
// Round 3: joiners start no process: five callers, forced or not, during one check share its one probe.
#[test]
fn own_joiners_start_no_probe() {
    let cache = OwnCache::new();
    let cache = &cache;
    let runs = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
        a_started.recv().unwrap();
        let joiners: Vec<_> = (0..5)
            .map(|n| s.spawn(move || own_check(cache, 0, n % 2 == 0, BOUND, |_| unreachable!())))
            .collect();
        while !joined(cache, 5) {
            std::thread::yield_now();
        }
        to_a.send((SignedIn::No, None)).unwrap();
        assert_eq!(a.join().unwrap().unwrap().0, SignedIn::No);
        for j in joiners {
            assert_eq!(j.join().unwrap().unwrap().0, SignedIn::No);
        }
    });
    assert_eq!(runs.into_inner(), 1);
}
// Ticket 423 round 2: with the real probe queue held full past four bounds, every ask that joins the queued check is
// released at its bound with "still checking" (None), never unknown, and stores nothing. Once the queue frees, the
// check runs once and the next ask gets its real answer. Unknown needs the slot held for a whole bound.
#[test]
fn own_joiner_bound_starts_at_the_probe_slot() {
    let cache = OwnCache::new();
    let cache = &cache;
    let runs = std::sync::atomic::AtomicUsize::new(0);
    let full: Vec<_> = (0..PROBES_AT_ONCE)
        .map(|_| PROBES.take(None).unwrap())
        .collect();
    let bound = Duration::from_millis(300);
    std::thread::scope(|s| {
        let (to_a, a_started, a) = driven(&runs);
        let a = s.spawn(move || {
            own_check(cache, 0, false, bound, |slotted| {
                let _slot = PROBES.take(None).unwrap();
                a(slotted)
            })
        });
        while !running(cache) {
            std::thread::yield_now();
        }
        for _ in 0..4 {
            let got = own_check(cache, 0, true, bound, |_| unreachable!());
            assert_eq!(got, None, "the queue alone gave an answer");
            assert!(running(cache));
        }
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(full);
        a_started.recv().unwrap();
        to_a.send((SignedIn::Yes, Some("max".into()))).unwrap();
        assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
        let got = own_check(cache, 0, false, bound, |_| unreachable!());
        assert_eq!(got, Some((SignedIn::Yes, Some("max".into()))));
    });
    assert_eq!(runs.into_inner(), 1);
    assert_eq!(stored(cache), Some(SignedIn::Yes));
}
// Ticket 423 round 2: a check that has no slot yet releases its joiner at the bound with "still checking", storing
// nothing; a later ask, after the check landed, gets the real answer without a new probe.
#[test]
fn own_joiner_is_released_still_checking_while_queued() {
    let cache = OwnCache::new();
    let cache = &cache;
    let (free, freed) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|s| {
        let a = s.spawn(move || {
            own_check(cache, 0, false, BOUND, |_| {
                freed.recv().unwrap(); // never slotted: the queue stays full until then
                Some((SignedIn::No, None))
            })
        });
        while !running(cache) {
            std::thread::yield_now();
        }
        let bound = Duration::from_millis(300);
        let started = Instant::now();
        let got = own_check(cache, 0, true, bound, |_| unreachable!());
        let took = started.elapsed();
        assert_eq!(got, None);
        assert!(
            took >= bound && took < bound + Duration::from_secs(5),
            "{took:?}"
        );
        assert!(running(cache), "the joiner stored something");
        free.send(()).unwrap();
        assert_eq!(a.join().unwrap().unwrap().0, SignedIn::No);
        let got = own_check(cache, 0, false, bound, |_| unreachable!());
        assert_eq!(got, Some((SignedIn::No, None)));
    });
    assert_eq!(stored(cache), Some(SignedIn::No));
}
// Ticket 423 round 2: the thread hold. 31 joiners of one queued check (the local API's other request threads) each
// return within the bound plus a margin, whatever the queue does.
#[test]
fn own_joiners_each_free_their_thread_at_the_bound() {
    let cache = OwnCache::new();
    let cache = &cache;
    let (free, freed) = std::sync::mpsc::channel::<()>();
    let bound = Duration::from_millis(300);
    std::thread::scope(|s| {
        let a = s.spawn(move || {
            own_check(cache, 0, false, BOUND, |_| {
                freed.recv().unwrap();
                Some((SignedIn::Yes, None))
            })
        });
        while !running(cache) {
            std::thread::yield_now();
        }
        let joiners: Vec<_> = (0..31)
            .map(|n| {
                s.spawn(move || {
                    let started = Instant::now();
                    let got = own_check(cache, 0, n % 2 == 0, bound, |_| unreachable!());
                    (got, started.elapsed())
                })
            })
            .collect();
        for j in joiners {
            let (got, took) = j.join().unwrap();
            assert_eq!(got, None);
            assert!(took < bound + Duration::from_secs(2), "{took:?}");
        }
        free.send(()).unwrap();
        a.join().unwrap();
    });
}
// Ticket 435: a FIFO with no writer at `settings.json` is refused at once (a plain read waits for a writer forever),
// so it marks no session default.
#[test]
fn session_defaults_refuse_a_fifo_at_once() {
    let dir = std::env::temp_dir().join(format!("ns-acct-fifo-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let fifo = CString::new(
        dir.join("settings.json")
            .into_os_string()
            .into_encoded_bytes(),
    )
    .unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let asked = Instant::now();
    let picked = session_defaults(&dir);
    let took = asked.elapsed();
    fs::remove_dir_all(&dir).unwrap();
    assert_eq!(picked, [None, None]);
    assert!(took < Duration::from_secs(1), "{took:?}");
}
/// Waiters in a queue's line.
fn in_line(queue: &ProbeQueue) -> usize {
    queue.state.lock().unwrap().1.len()
}
// Ticket 431: with every place held, waiters that arrive one after another take the places in arrival order as
// they free one at a time.
#[test]
fn probe_places_go_in_arrival_order() {
    let queue = ProbeQueue::new();
    let queue = &queue;
    let mut full: Vec<_> = (0..PROBES_AT_ONCE)
        .map(|_| queue.take(None).unwrap())
        .collect();
    let order = Mutex::new(Vec::new());
    let order = &order;
    let (hold, held) = std::sync::mpsc::channel::<()>();
    let held = Mutex::new(held);
    let held = &held;
    std::thread::scope(|s| {
        for n in 0..6 {
            s.spawn(move || {
                let _slot = queue.take(None).unwrap();
                order.lock().unwrap().push(n);
                let _ = held.lock().unwrap().recv(); // keeps the place until the test is done
            });
            while in_line(queue) < n + 1 {
                std::thread::yield_now();
            }
        }
        for n in 1..=6 {
            drop(full.pop());
            while order.lock().unwrap().len() < n {
                std::thread::yield_now();
            }
        }
        drop(hold);
    });
    assert_eq!(*order.lock().unwrap(), (0..6).collect::<Vec<_>>());
    drop(full);
    assert_eq!(queue.state.lock().unwrap().0, 0);
}
// Ticket 431: an initiating wait is bounded: with every place held it leaves the line at its bound, and the waiter
// behind it is not held up by it (it gets the next free place).
#[test]
fn probe_wait_is_bounded_and_leaves_the_line() {
    let queue = ProbeQueue::new();
    let queue = &queue;
    let mut full: Vec<_> = (0..PROBES_AT_ONCE)
        .map(|_| queue.take(None).unwrap())
        .collect();
    let bound = Duration::from_millis(300);
    std::thread::scope(|s| {
        let first = s.spawn(move || {
            let asked = Instant::now();
            (queue.take(Some(bound)).is_some(), asked.elapsed())
        });
        while in_line(queue) < 1 {
            std::thread::yield_now();
        }
        let behind = s.spawn(move || queue.take(None).is_some());
        let (got, took) = first.join().unwrap();
        assert!(!got);
        assert!(
            took >= bound && took < bound + Duration::from_secs(2),
            "{took:?}"
        );
        assert_eq!(in_line(queue), 1, "only the waiter behind is left");
        drop(full.pop());
        assert!(behind.join().unwrap());
    });
    drop(full);
    assert_eq!(
        *queue.state.lock().unwrap(),
        (0, VecDeque::new(), 2 + PROBES_AT_ONCE as u64)
    );
}
// Ticket 431: a check that gave up its queue place stores nothing; it and its joiner answer "still checking" (None),
// and the next ask starts a new check.
#[test]
fn own_check_that_gave_up_its_place_stores_nothing() {
    let cache = OwnCache::new();
    let cache = &cache;
    let (go, gone) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|s| {
        let a = s.spawn(move || {
            own_check(cache, 0, false, BOUND, |_| {
                gone.recv().unwrap();
                None
            })
        });
        while !running(cache) {
            std::thread::yield_now();
        }
        let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
        while !joined(cache, 1) {
            std::thread::yield_now();
        }
        go.send(()).unwrap();
        assert_eq!(a.join().unwrap(), None);
        assert_eq!(b.join().unwrap(), None);
    });
    assert!(cache.entries.lock().unwrap()[0].is_none());
    let got = own_check(cache, 0, false, BOUND, |_| Some((SignedIn::Yes, None)));
    assert_eq!(got, Some((SignedIn::Yes, None)));
}
// Ticket 358: when the rollback fails too, the owner is told the registry kept the new name.
#[test]
fn rename_failed_says_when_the_new_name_stayed() {
    assert_eq!(rename_failed("no".into(), Ok(()), "new"), "no");
    let both = rename_failed("no".into(), Err("disk".into()), "new");
    assert!(both.starts_with("no;") && both.contains("disk"), "{both}");
    assert!(both.contains("keeps the new name \"new\""), "{both}");
}
#[test]
fn label_refuses_format_characters() {
    for bad in [
        "a\u{202E}b",
        "a\u{200B}b",
        "\u{2066}x",
        "a\u{FEFF}",
        "a\u{E000}",
        "a\u{2028}b",
        "a\tb",
    ] {
        assert!(check_label(bad).is_err(), "{bad:?}");
    }
    for good in [
        "회사 계정",
        "work (2)",
        "x; touch pwned $(id)",
        "Ünïcödé ✓",
        "-rf --help",
    ] {
        assert!(check_label(good).is_ok(), "{good:?}");
    }
}
