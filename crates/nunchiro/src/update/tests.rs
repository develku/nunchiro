use super::*;
use crate::update_claims::claim;
use std::os::unix::fs::PermissionsExt;

const NEW: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// A folder as the build script leaves it: a bundle with `id` and two executables, and a stamp for them.
fn folder(name: &str, id: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nunchiro-1082-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let macos = dir.join(APP).join("Contents/MacOS");
    fs::create_dir_all(&macos).unwrap();
    for d in [&dir, &dir.join(APP)] {
        fs::set_permissions(d, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        dir.join(APP).join("Contents/Info.plist"),
        format!(
            "<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>{id}</string>\n</dict></plist>"
        ),
    )
    .unwrap();
    fs::write(macos.join("nunchiro"), "cli").unwrap();
    fs::write(macos.join("nunchiro-app"), "app").unwrap();
    let sha256 = hashes(&macos).unwrap();
    let stamp = serde_json::json!({"commit": NEW, "built": "2026-11-23T10:00:00Z", "sha256": sha256, "tree": dir});
    fs::write(dir.join(STAMP), stamp.to_string()).unwrap();
    dir
}

#[test]
fn a_build_without_an_update_repo_refuses_to_install() {
    let why = update_repo(None).unwrap_err();
    assert!(
        why.contains("names no update repository; set NUNCHIRO_UPDATE_REPO"),
        "{why}"
    );
    assert!(!why.contains("github.com"), "{why}");
    assert_eq!(update_repo(Some("file:///o.git")), Ok("file:///o.git"));
}

#[test]
fn a_stamp_of_another_commit_with_matching_hashes_is_ready() {
    let dir = folder("ready", OWNER_ID);
    let stamp = ready(&dir, "aaaaaaaaa").unwrap().unwrap();
    assert_eq!(stamp.commit, NEW);
    // the running build itself, by its short sha
    assert!(ready(&dir, &NEW[..9]).unwrap().is_none());
    fs::remove_file(dir.join(STAMP)).unwrap();
    assert!(ready(&dir, "aaaaaaaaa").unwrap().is_none());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_hash_mismatch_is_refused() {
    let dir = folder("hash", OWNER_ID);
    fs::write(dir.join(APP).join("Contents/MacOS/nunchiro"), "other").unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("sha256 of nunchiro does not match"), "{why}");
    // an executable the stamp does not name
    let dir = folder("extra", OWNER_ID);
    fs::write(dir.join(APP).join("Contents/MacOS/extra"), "x").unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("sha256 of extra"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_wrong_bundle_id_is_refused() {
    let dir = folder("id", "dev.nunchiro.app.rc");
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("bundle id is dev.nunchiro.app.rc"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_world_writable_source_is_refused() {
    let dir = folder("writable", OWNER_ID);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("writable by group or others"), "{why}");
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(dir.join(APP), fs::Permissions::from_mode(0o775)).unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("writable by group or others"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_symlinked_bundle_root_is_refused() {
    let dir = folder("link", OWNER_ID);
    let real = dir.join("Real.app");
    fs::rename(dir.join(APP), &real).unwrap();
    std::os::unix::fs::symlink(&real, dir.join(APP)).unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("is a symlink"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_core_replace_puts_the_backup_back() {
    let dir = std::env::temp_dir().join(format!("nunchiro-1082-swap-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let (bundle, staged, backup) = (
        dir.join(APP),
        dir.join("w/new").join(APP),
        dir.join("w/backup").join(APP),
    );
    for (d, text) in [(&bundle, "old"), (&staged, "new")] {
        fs::create_dir_all(d).unwrap();
        fs::write(d.join("which"), text).unwrap();
    }
    let why = swap(&bundle, &staged, &backup, || {
        Err("the core did not start".into())
    })
    .unwrap_err();
    assert_eq!(
        why,
        "the core did not start. The previous build was put back."
    );
    assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
    assert!(!staged.exists() && !backup.exists());
    // and a replace that works keeps the new build and the old one as the backup
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join("which"), "new").unwrap();
    swap(&bundle, &staged, &backup, || Ok(())).unwrap();
    assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "new");
    assert_eq!(fs::read_to_string(backup.join("which")).unwrap(), "old");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_isolated_test_build_never_updates_itself() {
    let dir = folder("isolated", "dev.nunchiro.app.rc");
    let exe = dir.join(APP).join("Contents/MacOS/nunchiro");
    let why = installed(&exe).unwrap_err();
    assert!(
        why.contains("isolated test build (dev.nunchiro.app.rc)"),
        "{why}"
    );
    let dir = folder("owner", OWNER_ID);
    assert_eq!(
        installed(&dir.join(APP).join("Contents/MacOS/nunchiro")).unwrap(),
        dir.join(APP)
    );
    // where cargo and tauri build it is not an install
    for exe in [
        "/n/target/debug/nunchiro",
        "/n/target/release/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro",
    ] {
        assert!(installed(Path::new(exe)).is_err(), "{exe}");
    }
    fs::remove_dir_all(dir).unwrap();
}

/// An installed bundle's folder in `dir` and its work folder (not made).
fn installed_in(dir: &Path) -> (PathBuf, PathBuf) {
    let at = dir.join("installed");
    fs::create_dir_all(&at).unwrap();
    (at.join(APP), at.join(WORK))
}

#[test]
fn a_second_install_fails_at_once_and_touches_nothing() {
    let dir = folder("lock", OWNER_ID);
    let (bundle, work) = installed_in(&dir);
    let theirs = work.join("new").join(APP);
    fs::create_dir_all(&theirs).unwrap();
    fs::write(theirs.join("which"), "theirs").unwrap();
    let held = lock(&work).unwrap();
    let why = install(
        &dir,
        &bundle,
        Candidate::Folder(&dir),
        "aaaaaaaaa",
        "",
        || Ok(vec![]),
    )
    .unwrap_err();
    assert!(why.contains("another update is installing"), "{why}");
    assert_eq!(fs::read_to_string(theirs.join("which")).unwrap(), "theirs");
    drop(held);
    // free again: the next install gets past the lock (and stops here: the folder holds this build)
    let why = install(&dir, &bundle, Candidate::Folder(&dir), NEW, "", || {
        Ok(vec![])
    })
    .unwrap_err();
    assert_eq!(why, "no new build is ready");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_linked_staging_folder_is_refused_and_its_target_kept() {
    for part in ["backup", "new", ""] {
        let dir = folder(&format!("link-{part}"), OWNER_ID);
        let outside = dir.join("outside");
        fs::create_dir_all(outside.join(APP)).unwrap();
        fs::write(outside.join(APP).join("which"), "keep").unwrap();
        let (bundle, work) = installed_in(&dir);
        if part.is_empty() {
            std::os::unix::fs::symlink(&outside, &work).unwrap();
        } else {
            fs::create_dir_all(&work).unwrap();
            std::os::unix::fs::symlink(&outside, work.join(part)).unwrap();
        }
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            "aaaaaaaaa",
            "",
            || Ok(vec![]),
        )
        .unwrap_err();
        assert!(why.contains("is a link or not a folder"), "{part}: {why}");
        assert_eq!(
            fs::read_to_string(outside.join(APP).join("which")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn hashing_is_bounded_in_files() {
    let dir = folder("many", OWNER_ID);
    let macos = dir.join(APP).join("Contents/MacOS");
    for n in 0..MAX_FILES {
        fs::write(macos.join(format!("f{n}")), "x").unwrap();
    }
    let why = hashes(&macos).unwrap_err();
    assert!(why.contains("more than 32 files"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

/// Bundles `a`, `b`, `c` and an empty claims folder place.
fn homes(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nunchiro-1082-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    for b in ["a", "b", "c"] {
        let macos = dir.join(b).join(APP).join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("nunchiro"), "cli").unwrap();
    }
    dir.canonicalize().unwrap()
}
/// `home`'s core record says it was started from `<at>/Nunchiro.app`.
fn record(home: &Path, at: &Path) {
    fs::create_dir_all(home).unwrap();
    let exe = at.join(APP).join("Contents/MacOS/nunchiro");
    fs::write(
        home.join("core.start.json"),
        serde_json::json!({"exe": exe}).to_string(),
    )
    .unwrap();
}
fn tree(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p.clone());
            }
            out.push(format!(
                "{} {}",
                p.display(),
                fs::read(&p).map(|b| b.len()).unwrap_or(0)
            ));
        }
    }
    out.sort();
    out
}

#[test]
fn an_agent_home_cannot_update_an_app_another_home_claimed() {
    let dir = homes("agent-home");
    let (reg, a) = (dir.join("claims"), dir.join("a").join(APP));
    // the owner runs the app with a custom home, and no ~/.nunchiro exists in this test at all
    let owner = dir.join("owner-custom");
    record(&owner, &dir.join("a"));
    assert!(claim(&reg, &a, &owner).unwrap());
    // the agent's own home, its core started from the owner's app; its later claim takes nothing
    let agent = dir.join("agent");
    record(&agent, &dir.join("a"));
    assert!(!claim(&reg, &a, &agent).unwrap());
    fs::create_dir_all(dir.join("bare")).unwrap();
    let before = tree(&dir);
    let why = belongs(&agent, &a, Some(&reg)).unwrap_err();
    assert!(why.contains("is claimed by the home"), "{why}");
    let why = belongs(&dir.join("bare"), &a, Some(&reg)).unwrap_err();
    assert!(why.contains("is not the home of"), "{why}");
    let why = belongs(&agent, &a, None).unwrap_err();
    assert!(
        why.contains("no home folder for the update claims"),
        "{why}"
    );
    assert_eq!(tree(&dir), before, "a refusal changes no file");
    // the owner's custom home passes
    belongs(&owner, &a, Some(&reg)).unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_isolated_copy_updates_its_own_app_only() {
    let dir = homes("iso-home");
    let reg = dir.join("claims");
    let iso = dir.join("iso");
    record(&iso, &dir.join("b"));
    assert!(claim(&reg, &dir.join("b").join(APP), &iso).unwrap());
    belongs(&iso, &dir.join("b").join(APP), Some(&reg)).unwrap();
    for other in ["a", "c"] {
        let why = belongs(&iso, &dir.join(other).join(APP), Some(&reg)).unwrap_err();
        assert!(why.contains("is not the home of"), "{other}: {why}");
    }
    // a home whose core ran from an app nobody claimed
    let new = dir.join("new");
    record(&new, &dir.join("c"));
    let why = belongs(&new, &dir.join("c").join(APP), Some(&reg)).unwrap_err();
    assert!(why.contains("no home has claimed"), "{why}");
    assert!(why.contains("open the Nunchiro app once"), "{why}");
    // a claims folder others can write is not trusted
    fs::set_permissions(&reg, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(belongs(&iso, &dir.join("b").join(APP), Some(&reg)).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_planted_fifo_or_huge_file_reads_as_none() {
    let dir = homes("fifo");
    let fifo = |p: &Path| {
        let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    };
    // returns at once: a blocking read of a FIFO with no writer would hang this test
    fifo(&dir.join(SOURCE));
    assert!(source(&dir).is_none());
    fs::remove_file(dir.join(SOURCE)).unwrap();
    fs::write(dir.join(SOURCE), vec![b'/'; (1 << 20) + 1]).unwrap();
    assert!(source(&dir).is_none());
    let plist = dir.join("a").join(APP).join("Contents/Info.plist");
    fifo(&plist);
    assert!(bundle_id(&dir.join("a").join(APP)).is_none());
    fs::remove_file(&plist).unwrap();
    fs::write(&plist, vec![b' '; (1 << 20) + 1]).unwrap();
    assert!(bundle_id(&dir.join("a").join(APP)).is_none());
    // core.start.json as the install check reads it
    fifo(&dir.join("core.start.json"));
    assert!(recorded_bundle(&dir).is_none());
    // an executable or a stamp that is a FIFO is refused at once, not waited on (open first, judge the descriptor)
    let macos = dir.join("b").join(APP).join("Contents/MacOS");
    fifo(&macos.join("extra"));
    let why = hashes(&macos).unwrap_err();
    assert!(why.contains("is not a regular file"), "{why}");
    fifo(&dir.join(STAMP));
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("not a small regular file"), "{why}");
    // a link is not followed either
    fs::remove_file(macos.join("extra")).unwrap();
    std::os::unix::fs::symlink(macos.join("nunchiro"), macos.join("extra")).unwrap();
    assert!(hashes(&macos).is_err());
    fs::remove_dir_all(dir).unwrap();
}

const SMALL: Limits = Limits {
    entries: 50,
    bytes: 4096,
    headroom: 0,
    slack: 64 << 20,
    time: std::time::Duration::from_secs(60),
};

/// A candidate bundle with `files` files of `size` bytes each, and the staging place beside it.
fn candidate(name: &str, files: usize, size: usize) -> (PathBuf, PathBuf) {
    let dir = folder(name, OWNER_ID);
    let res = dir.join(APP).join("Contents/Resources");
    fs::create_dir_all(&res).unwrap();
    for n in 0..files {
        fs::write(res.join(format!("r{n}")), vec![b'x'; size]).unwrap();
    }
    fs::create_dir_all(dir.join("w")).unwrap();
    (dir.join(APP), dir.join("w").join(APP))
}

#[test]
fn an_oversized_or_crowded_bundle_is_refused_before_any_copy() {
    let (from, staged) = candidate("big", 1, 8192);
    let why = stage(&from, &staged, &SMALL).unwrap_err();
    assert!(why.contains("more than 4096 bytes"), "{why}");
    assert!(!staged.exists(), "nothing was copied");
    let (from2, staged2) = candidate("crowded", 60, 1);
    let why = stage(&from2, &staged2, &SMALL).unwrap_err();
    assert!(why.contains("more than 50 entries"), "{why}");
    assert!(!staged2.exists());
    fs::remove_dir_all(from2.parent().unwrap()).unwrap();
    fs::remove_dir_all(from.parent().unwrap()).unwrap();
    // round 5: any link is refused, even one that stays inside; with it gone the bundle stages
    let (from, staged) = candidate("links", 1, 1);
    let res = from.join("Contents/Resources");
    std::os::unix::fs::symlink("r0", res.join("inside")).unwrap();
    let why = stage(&from, &staged, &SMALL).unwrap_err();
    assert!(why.contains("a bundle holds no links"), "{why}");
    assert!(!staged.exists());
    fs::remove_file(res.join("inside")).unwrap();
    stage(&from, &staged, &SMALL).unwrap();
    fs::remove_dir_all(&staged).unwrap();
    // the free space the copy must leave
    let roomy = Limits {
        headroom: u64::MAX / 2,
        ..SMALL
    };
    let why = stage(&from, &staged, &roomy).unwrap_err();
    assert!(why.contains("bytes free"), "{why}");
    assert!(!staged.exists());
    fs::remove_dir_all(from.parent().unwrap()).unwrap();
}

#[test]
fn a_failed_copy_leaves_no_staging() {
    let (from, staged) = candidate("cut", 200, 4096);
    // a copy stopped by its time limit, after ditto started writing
    let cut = Limits {
        entries: 1000,
        bytes: 1 << 20,
        time: std::time::Duration::ZERO,
        ..SMALL
    };
    let why = stage(&from, &staged, &cut).unwrap_err();
    assert!(why.contains("did not end within"), "{why}");
    assert!(!staged.exists());
    // a copy that fails on its own, part way: a file sits where it must make the Contents folder
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join("Contents"), "in the way").unwrap();
    let roomy = Limits {
        entries: 1000,
        bytes: 1 << 20,
        ..SMALL
    };
    let why = stage(&from, &staged, &roomy).unwrap_err();
    assert!(why.contains("ditto failed"), "{why}");
    assert!(!staged.exists());
    fs::remove_dir_all(from.parent().unwrap()).unwrap();
}

#[test]
fn a_restore_checks_that_the_restored_core_runs() {
    use std::cell::RefCell;
    // the old core never left: nothing to replace
    let called = RefCell::new(false);
    after_restore(
        || Some("aaaaaaaaa".into()),
        "aaaaaaaaa",
        || {
            *called.borrow_mut() = true;
            Ok(())
        },
    )
    .unwrap();
    assert!(!*called.borrow());
    // the new (or a newer stamped) core runs: replaced, then read again
    let core = RefCell::new(NEW.to_string());
    after_restore(
        || Some(core.borrow().clone()),
        "aaaaaaaaa",
        || {
            *core.borrow_mut() = "aaaaaaaaa".into();
            Ok(())
        },
    )
    .unwrap();
    // still the new one afterwards, or the replace failed: said plainly
    let why = after_restore(|| Some(NEW.into()), "aaaaaaaaa", || Ok(())).unwrap_err();
    assert!(
        why.contains(&format!(
            "running core is {NEW} and not the restored build aaaaaaaaa"
        )),
        "{why}"
    );
    let why = after_restore(|| Some(NEW.into()), "aaaaaaaaa", || Err("kept".into())).unwrap_err();
    assert!(
        why.contains("(kept)") && why.contains("quit Nunchiro and open it again"),
        "{why}"
    );
}

#[test]
fn a_restore_after_the_old_core_exited_and_the_new_one_failed_starts_the_restored_core() {
    use std::cell::RefCell;
    // Codex security look (1107): the old core exited, the new one failed before writing its record, so
    // core.start.json still names the restored commit but nothing answers.
    let dir = std::env::temp_dir().join(format!("nunchiro-1107-stale-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("core.start.json"),
        serde_json::json!({"commit": "aaaaaaaaa"}).to_string(),
    )
    .unwrap();
    // a token, so the call reaches the socket and finds nobody there (with or without a session's token)
    fs::write(dir.join("core.token"), "test").unwrap();
    assert_eq!(core_commit(&dir).as_deref(), Some("aaaaaaaaa"));
    assert_eq!(
        live_commit(&dir),
        None,
        "a record with no core answering is no core"
    );
    // nothing restarts it: not reported as running
    let why = after_restore(|| live_commit(&dir), "aaaaaaaaa", || Ok(())).unwrap_err();
    assert!(
        why.contains("no core answers and not the restored build aaaaaaaaa"),
        "{why}"
    );
    // the replace is asked to start the restored core, and only a core that then answers counts
    let started = RefCell::new(false);
    after_restore(
        || started.borrow().then(|| "aaaaaaaaa".to_string()),
        "aaaaaaaaa",
        || {
            *started.borrow_mut() = true;
            Ok(())
        },
    )
    .unwrap();
    assert!(*started.borrow());
    fs::remove_dir_all(dir).unwrap();
}

/// A stand-in core on `home`'s socket that answers every request with an empty snapshot, for tests that must not
/// start a real core. Dropped with the test process. It writes the home's `core.token` too: without a session's
/// NUNCHIRO_TOKEN (the gate) the CLI reads that file before it connects, and with neither the call fails and the
/// restore would start a real core from this test binary.
fn answering_core(home: &Path) {
    busy_core(home, 0, 0);
}

/// `answering_core` whose first `busy` exit_blockers answers say `count` (ticket 1130 A-D3); later ones say 0.
/// Returns how many times it was asked.
fn busy_core(
    home: &Path,
    count: usize,
    busy: usize,
) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
    use std::sync::atomic::Ordering;
    fs::write(home.join("core.token"), "test").unwrap();
    let line = |reply: serde_json::Value| {
        let reply: crate::Reply = serde_json::from_value(reply).unwrap();
        format!(
            "{}\n",
            serde_json::to_string(&Ok::<_, String>(reply)).unwrap()
        )
    };
    let snapshot = line(serde_json::json!({"type": "snapshot", "sessions": []}));
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = asked.clone();
    let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            use std::io::{BufRead, Write};
            let mut request = String::new();
            let _ = std::io::BufReader::new(&stream).read_line(&mut request);
            let reply = if request.contains(r#""op":"exit_blockers""#) {
                let n = seen.fetch_add(1, Ordering::SeqCst);
                let count = if n < busy { count } else { 0 };
                line(serde_json::json!({"type": "exit_blockers", "count": count}))
            } else {
                snapshot.clone()
            };
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    asked
}

// Ticket 1130 A-D3 (p05 U3): a busy core holds the install before the swap. Before, the bundle was swapped, the new
// build's serve update kept the busy core, and the backup was put back: an install that failed by design.
#[test]
fn a_busy_core_holds_the_install_before_the_swap_and_a_freed_one_lets_it_go_on() {
    use std::sync::atomic::Ordering;
    let (url, c) = main_repo();
    for (busy, held) in [(usize::MAX, true), (2, false)] {
        let dir = folder(&format!("busy-{held}"), OWNER_ID);
        let mark = agent_bundle(&dir, &c[4]);
        let (bundle, work) = installed_in(&dir);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("which"), "old").unwrap();
        fs::write(
            dir.join("core.start.json"),
            serde_json::json!({"commit": &c[1][..9]}).to_string(),
        )
        .unwrap();
        let asked = busy_core(&dir, 2, busy);
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            &c[1][..9],
            url,
            || Ok(vec![]),
        )
        .unwrap_err();
        if held {
            assert!(
                why.contains("2 chat(s) or job(s) still need the running core after 2 s")
                    && why.contains("nothing was changed"),
                "{why}"
            );
            assert!(!mark.exists(), "the candidate never ran");
        } else {
            // freed: it went on to the swap; the stand-in core then fails the commit check, as in the feed test
            assert!(why.contains("The previous build was put back"), "{why}");
            assert!(mark.exists(), "the candidate's serve update ran");
        }
        assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
        assert_eq!(fs::read_dir(work.join("new")).unwrap().count(), 0);
        assert!(
            asked.load(Ordering::SeqCst) >= 3,
            "it asked again while busy"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

/// Ticket 1130 A-D3 round 2: a stand-in core whose every exit_blockers reply is `answer` writing to the open socket.
fn odd_core(name: &str, answer: fn(&mut std::os::unix::net::UnixStream)) -> PathBuf {
    use std::io::BufRead;
    let home = std::env::temp_dir().join(format!("nunchiro-1130-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("core.token"), "test").unwrap();
    let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = String::new();
            let _ = std::io::BufReader::new(&stream).read_line(&mut request);
            answer(&mut stream);
        }
    });
    home
}

/// `wait_until_idle` with `limit`, in a thread: its result and how long it took, or a failure 5 s past the limit.
fn timed_wait(
    home: &Path,
    limit: std::time::Duration,
) -> (Result<(), String>, std::time::Duration) {
    let home = home.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let start = std::time::Instant::now();
    std::thread::spawn(move || {
        let _ = tx.send(wait_until_idle(&home, limit));
    });
    let result = rx
        .recv_timeout(limit + std::time::Duration::from_secs(5))
        .expect("the wait ran 5 s past its limit");
    (result, start.elapsed())
}

fn drip(stream: &mut std::os::unix::net::UnixStream) {
    use std::io::Write;
    for _ in 0..100 {
        if stream.write_all(b" ").is_err() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn zero_line() -> String {
    let reply: crate::Reply =
        serde_json::from_value(serde_json::json!({"type": "exit_blockers", "count": 0})).unwrap();
    format!(
        "{}\n",
        serde_json::to_string(&Ok::<_, String>(reply)).unwrap()
    )
}

// Ticket 1130 A-D3 round 2 (Codex MUST): a core that drips bytes with no newline cannot hold the updater lock and
// the staged bundle past the wait limit; before, each byte renewed the 15 s idle read and the wait never ended.
#[test]
fn a_reply_that_never_ends_cannot_hold_the_wait_past_its_limit() {
    let home = odd_core("drip", drip);
    let limit = std::time::Duration::from_millis(300);
    let (result, took) = timed_wait(&home, limit);
    let why = result.unwrap_err();
    assert!(why.contains("nothing was changed"), "{why}");
    assert!(
        took < limit + std::time::Duration::from_secs(1),
        "it took {took:?}"
    );
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1130 A-D3 round 2 (Codex MUST): a 0 that comes after the limit is refused, whether the core was silent or
// dripped bytes before it; before, a late 0 let the install go on to the swap.
#[test]
fn a_zero_after_the_limit_is_refused() {
    fn silent_then_zero(stream: &mut std::os::unix::net::UnixStream) {
        use std::io::Write;
        std::thread::sleep(std::time::Duration::from_millis(600));
        let _ = stream.write_all(zero_line().as_bytes());
    }
    fn drip_then_zero(stream: &mut std::os::unix::net::UnixStream) {
        use std::io::Write;
        for _ in 0..10 {
            let _ = stream.write_all(b" ");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = stream.write_all(zero_line().as_bytes());
    }
    for (name, answer) in [
        ("late-silent", silent_then_zero as fn(&mut _)),
        ("late-drip", drip_then_zero),
    ] {
        let home = odd_core(name, answer);
        let (result, took) = timed_wait(&home, std::time::Duration::from_millis(300));
        let why = result.expect_err(name);
        assert!(why.contains("nothing was changed"), "{name}: {why}");
        assert!(
            took < std::time::Duration::from_millis(550),
            "{name}: it took {took:?}"
        );
        fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn links_anywhere_in_a_candidate_are_refused() {
    // "a -> ../.." and "b -> a/../outside": each passes a lexical check, and b leads outside the bundle
    for under in ["Contents/Resources", "Contents/MacOS"] {
        let dir = folder(&format!("two-links-{}", under.len()), OWNER_ID);
        fs::create_dir_all(dir.join("outside")).unwrap();
        let at = dir.join(APP).join(under);
        fs::create_dir_all(&at).unwrap();
        std::os::unix::fs::symlink("../..", at.join("a")).unwrap();
        std::os::unix::fs::symlink("a/../outside", at.join("b")).unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("a bundle holds no links"), "{under}: {why}");
        fs::remove_dir_all(dir).unwrap();
    }
    // a linked MacOS folder is refused before any hash is read through it
    let dir = folder("linked-macos", OWNER_ID);
    let macos = dir.join(APP).join("Contents/MacOS");
    fs::rename(&macos, dir.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(dir.join("elsewhere"), &macos).unwrap();
    let why = ready(&dir, "aaaaaaaaa").err().unwrap();
    assert!(why.contains("a bundle holds no links"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_planted_fifo_lock_fails_at_once() {
    let dir = std::env::temp_dir().join(format!("nunchiro-1082-fifo-lock-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let c = std::ffi::CString::new(dir.join("lock").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();
    assert!(lock(&dir).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_candidate_whose_cli_hangs_or_floods_is_rolled_back() {
    let dir = std::env::temp_dir().join(format!("nunchiro-1082-hang-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let (bundle, staged, backup) = (
        dir.join(APP),
        dir.join("w/new").join(APP),
        dir.join("w/backup").join(APP),
    );
    let cli = |b: &Path, script: &str| {
        let macos = b.join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("nunchiro"), script).unwrap();
        fs::set_permissions(macos.join("nunchiro"), fs::Permissions::from_mode(0o755)).unwrap();
    };
    let alive = |pid: i32| unsafe { libc::kill(pid, 0) } == 0;
    let bg = dir.join("bg.pid");
    let pid = || -> i32 { fs::read_to_string(&bg).unwrap().trim().parse().unwrap() };
    // a hanging CLI with a background child: stopped at 1 s, both gone, the previous build back. Under load the 1 s can
    // pass before the stand-in's shell has even started its child: no bg.pid, and no child to check. That run is
    // not the case under test, so it runs again (the stop, the message and the rollback are checked every time).
    cli(&bundle, "#!/bin/sh\necho old\n");
    cli(
        &staged,
        &format!(
            "#!/bin/sh\nsleep 30 &\necho $! > {b}.tmp && mv {b}.tmp {b}\nexec sleep 30\n",
            b = bg.display()
        ),
    );
    let mut tries = 0;
    while !bg.exists() {
        tries += 1;
        assert!(
            tries <= 5,
            "the stand-in never started its child within the 1 s limit"
        );
        let started = std::time::Instant::now();
        let why = swap(&bundle, &staged, &backup, || {
            serve_update(&dir, &bundle, std::time::Duration::from_secs(1))
        })
        .unwrap_err();
        assert!(
            why.contains("did not end within 1 s") && why.contains("put back"),
            "{why}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(
            fs::read_to_string(bundle.join("Contents/MacOS/nunchiro"))
                .unwrap()
                .contains("echo old")
        );
        if !staged.exists() {
            cli(
                &staged,
                &format!(
                    "#!/bin/sh\nsleep 30 &\necho $! > {b}.tmp && mv {b}.tmp {b}\nexec sleep 30\n",
                    b = bg.display()
                ),
            );
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        !alive(pid()),
        "the background child was killed with the group"
    );
    // round 7: a CLI that ends at once but leaves a background child: the child is gone after the call too
    cli(
        &staged,
        &format!(
            "#!/bin/sh\nsleep 30 &\necho $! > {}\nexit 0\n",
            bg.display()
        ),
    );
    serve_update(&dir, &staged, std::time::Duration::from_secs(20)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        !alive(pid()),
        "a background child does not outlive the call"
    );
    // a CLI that writes without end (and a background writer) can grow no file: its output is /dev/null
    let files = || {
        let mut n = vec![];
        for e in fs::read_dir(&dir).unwrap() {
            let e = e.unwrap();
            n.push((e.file_name(), e.metadata().unwrap().len()));
        }
        n.sort();
        n
    };
    fs::remove_file(&bg).unwrap();
    let before = files();
    cli(&staged, "#!/bin/sh\nyes > /dev/stderr &\nexec yes\n");
    let why = serve_update(&dir, &staged, std::time::Duration::from_secs(1)).unwrap_err();
    assert!(why.contains("did not end within 1 s"), "{why}");
    assert_eq!(files(), before, "no file grew in the home");
    // and a failed exit is a failure, whatever it would have printed
    cli(&staged, "#!/bin/sh\necho replaced\nexit 3\n");
    let why = serve_update(&dir, &staged, std::time::Duration::from_secs(20)).unwrap_err();
    assert!(why.contains("failed (exit status: 3)"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_session_snapshot_stops_the_install_with_nothing_changed() {
    let dir = folder("snapshot", OWNER_ID);
    let (bundle, work) = installed_in(&dir);
    let before = tree(&dir);
    // a home with no core: the real snapshot fails, as it does when the core does not answer
    let why = install(
        &dir,
        &bundle,
        Candidate::Folder(&dir),
        "aaaaaaaaa",
        "",
        || sessions(&dir),
    )
    .unwrap_err();
    assert!(why.contains("the running sessions cannot be read"), "{why}");
    assert!(why.contains("nothing was changed"), "{why}");
    assert!(!work.exists());
    assert_eq!(tree(&dir), before);
    fs::remove_dir_all(dir).unwrap();
}

/// Writes the stamp for the bundle in `dir` as it is now, built from `dir`.
fn stamp_for(dir: &Path, commit: &str) {
    let sha256 = hashes(&dir.join(APP).join("Contents/MacOS")).unwrap();
    let stamp = serde_json::json!({"commit": commit, "built": "2026-11-24T09:00:00Z", "sha256": sha256, "tree": dir});
    fs::write(dir.join(STAMP), stamp.to_string()).unwrap();
}

/// Part B: the bundle an agent builds into the folder: this app's id, a real main executable, a CLI that leaves a
/// mark when it runs, signed ad hoc, with a stamp whose hashes match (commit `commit`). Returns the mark's path.
fn agent_bundle(dir: &Path, commit: &str) -> PathBuf {
    let mark = dir.join("candidate-ran");
    let app = dir.join(APP);
    let _ = fs::remove_dir_all(&app);
    let macos = app.join("Contents/MacOS");
    fs::create_dir_all(&macos).unwrap();
    fs::set_permissions(&app, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key>\n<string>{OWNER_ID}</string>\n<key>CFBundleExecutable</key><string>nunchiro-app</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
    fs::copy("/usr/bin/true", macos.join("nunchiro-app")).unwrap();
    let cli = macos.join("nunchiro");
    fs::write(&cli, format!("#!/bin/sh\ntouch {}\n", mark.display())).unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    let signed = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "-s", "-"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(signed.status.success(), "{signed:?}");
    let valid = Command::new("/usr/bin/codesign")
        .arg("-v")
        .arg(&app)
        .output()
        .unwrap();
    assert!(
        valid.status.success(),
        "the premise: codesign -v passes ({valid:?})"
    );
    stamp_for(dir, commit);
    mark
}

#[test]
fn an_adhoc_signed_stray_build_off_main_or_older_is_refused_at_install_before_it_runs() {
    // The Codex finding within option 0, in a debug and (cargo test --release) a release build of this check: a
    // correctly hashed, validly ad hoc signed build whose commit is not on main, only a second parent, or older.
    let (url, c) = main_repo();
    for (commit, said) in [
        (
            "cccccccccccccccccccccccccccccccccccccccc",
            "is not on main's first-parent history",
        ),
        (c[2].as_str(), "is not on main's first-parent history"),
        (c[0].as_str(), "is not newer on main"),
    ] {
        let dir = folder("order", OWNER_ID);
        let mark = agent_bundle(&dir, commit);
        let (bundle, _) = installed_in(&dir);
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            &c[1][..9],
            url,
            || Ok(vec![]),
        )
        .unwrap_err();
        assert!(why.contains(said), "{commit}: {why}");
        assert!(!mark.exists() && !bundle.exists());
        fs::remove_dir_all(dir).unwrap();
    }
    // a short sha in the stamp is refused at install (the order needs the exact commit)
    let dir = folder("short", OWNER_ID);
    agent_bundle(&dir, &c[4][..12]);
    let (bundle, _) = installed_in(&dir);
    let why = install(
        &dir,
        &bundle,
        Candidate::Folder(&dir),
        &c[1][..9],
        url,
        || Ok(vec![]),
    )
    .unwrap_err();
    assert!(why.contains("full 40-character sha"), "{why}");
    // offline: refused, with the reason
    stamp_for(&dir, &c[4]);
    let why = install(
        &dir,
        &bundle,
        Candidate::Folder(&dir),
        &c[1][..9],
        "file:///nonexistent/nunchiro-1082b",
        || Ok(vec![]),
    )
    .unwrap_err();
    assert!(why.contains("main could not be fetched"), "{why}");
    fs::remove_dir_all(dir).unwrap();
}

/// Ticket 1107: the feed archive exactly as build-release.sh makes it from `dir` (`Nunchiro.app` and the stamp, no
/// macOS metadata), plus `extra` names in `dir`.
fn archive_of(dir: &Path, extra: &[&str]) -> PathBuf {
    let archive = dir.join("Nunchiro.app.tar.gz");
    let out = Command::new("/usr/bin/tar")
        .env("COPYFILE_DISABLE", "1")
        .args(["--no-mac-metadata", "-C"])
        .arg(dir)
        .arg("-czf")
        .arg(&archive)
        .args([APP, STAMP])
        .args(extra)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    archive
}

#[test]
fn a_feed_archive_goes_through_the_whole_install_and_an_injected_failure_restores_app_and_core() {
    let (url, c) = main_repo();
    let dir = folder("feed", OWNER_ID);
    // the candidate's serve update runs and exits 0, but no new core takes over: the injected failure, found by
    // the commit check after it. Both executables are Mach-O, as in a release: a script's signature lives in
    // extended attributes, which the archive does not carry.
    agent_bundle(&dir, &c[4]);
    let macos = dir.join(APP).join("Contents/MacOS");
    fs::remove_file(macos.join("nunchiro")).unwrap();
    fs::copy("/usr/bin/true", macos.join("nunchiro")).unwrap();
    let signed = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "-s", "-"])
        .arg(dir.join(APP))
        .output()
        .unwrap();
    assert!(signed.status.success(), "{signed:?}");
    stamp_for(&dir, &c[4]);
    let archive = archive_of(&dir, &[]);
    fs::remove_dir_all(dir.join(APP)).unwrap();
    fs::remove_file(dir.join(STAMP)).unwrap();
    let (bundle, work) = installed_in(&dir);
    fs::create_dir_all(&bundle).unwrap();
    fs::write(bundle.join("which"), "old").unwrap();
    // the running core is this build: it answers, and its record says so
    fs::write(
        dir.join("core.start.json"),
        serde_json::json!({"commit": &c[1][..9]}).to_string(),
    )
    .unwrap();
    answering_core(&dir);
    let why = install(
        &dir,
        &bundle,
        Candidate::Archive(&archive),
        &c[1][..9],
        url,
        || Ok(vec!["s1".into()]),
    )
    .unwrap_err();
    // only the check after the candidate's serve update says this: the unpacked build was swapped in and ran
    assert!(
        why.contains(&format!("the core still runs {}", &c[1][..9]))
            && why.contains("The previous build was put back. Its core runs again."),
        "{why}"
    );
    assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
    assert!(
        !work.join("feed").exists(),
        "the unpacked archive is removed"
    );
    assert_eq!(fs::read_dir(work.join("new")).unwrap().count(), 0);
    // Part B judges an archive as it judges a folder: the same build is not newer than itself
    let why = install(
        &dir,
        &bundle,
        Candidate::Archive(&archive),
        &c[4][..9],
        url,
        || Ok(vec![]),
    )
    .unwrap_err();
    assert_eq!(why, "no new build is ready");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_feed_archive_with_more_than_the_bundle_and_stamp_or_no_archive_is_refused() {
    let dir = folder("feed-extra", OWNER_ID);
    fs::write(dir.join("extra"), "x").unwrap();
    let archive = archive_of(&dir, &["extra"]);
    let (bundle, work) = installed_in(&dir);
    let refused = |archive: &Path| {
        install(
            &dir,
            &bundle,
            Candidate::Archive(archive),
            "aaaaaaaaa",
            "",
            || Ok(vec![]),
        )
        .unwrap_err()
    };
    let why = refused(&archive);
    assert!(
        why.contains(r#"holds ["Nunchiro.app", "extra", "nunchiro-build.json"]"#),
        "{why}"
    );
    fs::write(&archive, "not a tar").unwrap();
    let why = refused(&archive);
    assert!(why.contains("the archive does not unpack"), "{why}");
    let fifo = dir.join("fifo");
    let path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let why = refused(&fifo);
    assert!(why.contains("is not a regular file"), "{why}");
    assert!(!work.join("feed").exists() && !bundle.exists());
    fs::remove_dir_all(dir).unwrap();
}

/// A throwaway origin whose main is c0 - c1 - merge(c2, side) - c3 on its first-parent line, with `side` merged as a
/// second parent. Its file URL and the commits [c0, c1, side, c2, c3]. Made once per test process.
fn main_repo() -> &'static (String, Vec<String>) {
    static REPO: std::sync::OnceLock<(String, Vec<String>)> = std::sync::OnceLock::new();
    REPO.get_or_init(|| {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-1082b-origin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("/usr/bin/git")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.invalid",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {out:?}");
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        let commit = |m: &str| {
            git(&["commit", "-q", "--allow-empty", "-m", m]);
            git(&["rev-parse", "HEAD"])
        };
        let (c0, c1) = (commit("c0"), commit("c1"));
        git(&["checkout", "-q", "-b", "side"]);
        let side = commit("side");
        git(&["checkout", "-q", "main"]);
        git(&["merge", "-q", "--no-ff", "-m", "c2", "side"]);
        let c2 = git(&["rev-parse", "HEAD"]);
        let c3 = commit("c3");
        (
            format!("file://{}", dir.display()),
            vec![c0, c1, side, c2, c3],
        )
    })
}

#[test]
fn main_decides_which_build_is_newer() {
    let (url, c) = main_repo();
    let work = std::env::temp_dir().join(format!("nunchiro-1082b-line-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).unwrap();
    fs::set_permissions(&work, fs::Permissions::from_mode(0o700)).unwrap();
    let line = main_line(&work, url, None, &AT_INSTALL).unwrap();
    assert_eq!(
        line,
        [c[0].as_str(), &c[1], &c[3], &c[4]],
        "the first-parent line, oldest first; side is not on it"
    );
    assert!(
        !work.join("main-line").exists(),
        "the fetch folder is removed"
    );
    // later on main: newer, also by the short sha a build carries
    newer_on_main(&line, &c[4], &c[1][..9]).unwrap();
    // the same commit, or an older one rebuilt later (no time is read at all): refused
    for older in [&c[1], &c[0]] {
        let why = newer_on_main(&line, older, &c[1][..9]).unwrap_err();
        assert!(why.contains("is not newer on main"), "{why}");
    }
    // a commit only merged in as a second parent, or not on main at all
    for off in [c[2].as_str(), "dddddddddddddddddddddddddddddddddddddddd"] {
        let why = newer_on_main(&line, off, &c[0][..9]).unwrap_err();
        assert!(
            why.contains("is not on main's first-parent history"),
            "{why}"
        );
    }
    // a running build that is not on main cannot judge anything
    let why = newer_on_main(&line, &c[4], "eeeeeeeee").unwrap_err();
    assert!(why.contains("so no build can be judged newer"), "{why}");
    // offline (or no sign-in): refused, with the reason
    let why = main_line(
        &work,
        "file:///nonexistent/nunchiro-1082b",
        None,
        &AT_INSTALL,
    )
    .unwrap_err();
    assert!(why.contains("main could not be fetched"), "{why}");
    assert!(!work.join("main-line").exists());
    fs::remove_dir_all(work).unwrap();
}

#[test]
fn status_offers_only_a_build_install_would_take() {
    // A stale update folder holding an older build was offered as "New build ready", then refused at install.
    let (url, c) = main_repo();
    let dir = folder("offer", OWNER_ID);
    let work = dir.join("work");
    let running = &c[1][..9];
    for (commit, repo, said) in [
        (c[0].as_str(), Some(url.as_str()), "is not newer on main"),
        (c[1].as_str(), Some(url.as_str()), ""),
        (
            c[2].as_str(),
            Some(url.as_str()),
            "is not on main's first-parent history",
        ),
        (&c[4][..12], Some(url.as_str()), "full 40-character sha"),
        (
            c[4].as_str(),
            Some("file:///nonexistent/nunchiro-1082b"),
            "main could not be fetched",
        ),
        (c[4].as_str(), None, "names no update repository"),
    ] {
        stamp_for(&dir, commit);
        let said_now = offer(&dir, &work, running, repo);
        assert_eq!(said_now["state"], "none", "{commit}: {said_now}");
        let reason = said_now["reason"].as_str().unwrap_or_default();
        assert!(reason.contains(said), "{commit}: {said_now}");
    }
    stamp_for(&dir, &c[4]);
    let said_now = offer(&dir, &work, running, Some(url));
    assert_eq!(said_now["state"], "ready", "{said_now}");
    assert_eq!(said_now["commit"], c[4].as_str());
    // The last verdict main gave is remembered for its pair of commits: no second fetch (the next could not reach main).
    let gone = Some("file:///nonexistent/nunchiro-1082b");
    assert_eq!(offer(&dir, &work, running, gone)["state"], "ready");
    stamp_for(&dir, &c[0]);
    offer(&dir, &work, running, Some(url));
    let said_now = offer(&dir, &work, running, gone);
    let reason = said_now["reason"].as_str().unwrap_or_default();
    assert!(reason.contains("is not newer on main"), "{said_now}");
    // Off main is not remembered: that commit may still land on main.
    stamp_for(&dir, &c[2]);
    let said_now = offer(&dir, &work, running, gone);
    let reason = said_now["reason"].as_str().unwrap_or_default();
    assert!(reason.contains("main could not be fetched"), "{said_now}");
    let left: Vec<_> = fs::read_dir(&work)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        left,
        ["status-verdict"],
        "only the remembered verdict stays"
    );
    fs::remove_dir_all(dir).unwrap();
}

/// The app runs `update status` under its output cap (`Output::KeepBounded`), so the status check's git runs under
/// it too: a newer build must still read as ready there.
#[test]
fn status_judges_a_build_under_the_apps_output_cap() {
    let (url, c) = main_repo();
    let dir = folder("offer-cap", OWNER_ID);
    stamp_for(&dir, &c[4]);
    let work = dir.join("work");
    let args = serde_json::json!({"dir": dir, "work": work, "running": &c[1], "repo": url});
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.env("NUNCHIRO_TEST_OFFER", args.to_string()).args([
        "--exact",
        "update::tests::offer_in_a_child",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]);
    let ran = crate::update_claims::run_limited(
        &mut cmd,
        &dir,
        Some(std::time::Duration::from_secs(60)),
        crate::update_claims::Output::KeepBounded,
        || Ok(()),
    )
    .unwrap();
    let out = String::from_utf8_lossy(&ran.stdout);
    let said = out
        .split_once("offer: ")
        .and_then(|(_, rest)| rest.lines().next())
        .unwrap_or_else(|| panic!("{out}"));
    let said: serde_json::Value = serde_json::from_str(said).unwrap();
    assert_eq!(said["state"], "ready", "{said}");
    fs::remove_dir_all(dir).unwrap();
}

/// Run only by the test above, in a child under the cap.
#[test]
#[ignore]
fn offer_in_a_child() {
    let args: serde_json::Value =
        serde_json::from_str(&std::env::var("NUNCHIRO_TEST_OFFER").unwrap()).unwrap();
    let path = |k: &str| PathBuf::from(args[k].as_str().unwrap());
    let said = offer(
        &path("dir"),
        &path("work"),
        args["running"].as_str().unwrap(),
        args["repo"].as_str(),
    );
    println!("offer: {said}");
}

/// Ticket 1112: a smart-HTTP copy of `main_repo` on 127.0.0.1 that answers 401 to any request without the
/// `x-access-token:tok1112` Basic sign-in, as a private GitHub repository does. Its URL. One per test process.
/// Ticket 1142: smart HTTP (`git http-backend`), as GitHub serves, so `main_line`'s `--filter=tree:0` is honoured;
/// over dumb HTTP the filter was ignored and git made hundreds of lazy promisor fetches (over 60 s on CI).
fn private_repo() -> &'static str {
    static URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    URL.get_or_init(|| {
        let (origin, _) = main_repo();
        let root = std::env::temp_dir().join(format!("nunchiro-1112-bare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bare = root.join("private.git");
        for args in [
            &[
                "clone",
                "-q",
                "--bare",
                origin.as_str(),
                bare.to_str().unwrap(),
            ][..],
            &["-C", bare.to_str().unwrap(), "update-server-info"],
        ] {
            let out = Command::new("/usr/bin/git")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {out:?}");
        }
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/private.git", server.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in server.incoming().flatten() {
                let root = root.clone();
                std::thread::spawn(move || private_repo_request(stream, &root));
            }
        });
        url
    })
}

/// Each connection gets its own worker: an idle connection must not prevent git opening another one.
/// Only authenticated GETs and POSTs below the bare repository root reach `git http-backend` (`root` holds the
/// one repository, private.git).
fn private_repo_request(mut stream: std::net::TcpStream, root: &Path) {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};
    let until = Instant::now() + Duration::from_secs(2);
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let remaining = until.saturating_duration_since(Instant::now());
        if header.len() >= 8192 || remaining.is_zero() {
            return;
        }
        if stream.set_read_timeout(Some(remaining)).is_err() {
            return;
        }
        let mut byte = [0];
        if stream.read_exact(&mut byte).is_err() {
            return;
        }
        header.push(byte[0]);
    }
    let Ok(header) = std::str::from_utf8(&header) else {
        return;
    };
    let signed = header.lines().skip(1).any(|line| {
        line.eq_ignore_ascii_case("authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9rMTExMg==")
    });
    if !signed {
        let _ = write!(
            stream,
            "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    }
    let mut request = header.lines().next().unwrap_or("").split_whitespace();
    let method = request.next();
    let target = request.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let relative = path.strip_prefix("/private.git/").filter(|path| {
        !path.is_empty()
            && path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && Path::new(path)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
    });
    // Check authorization and the complete path before git reads anything.
    let Some(relative) = relative.filter(|_| matches!(method, Some("GET" | "POST"))) else {
        let _ = write!(
            stream,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    };
    let field = |name: &str| {
        header.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    };
    // shortcut: a request body only by Content-Length (git's small fetch requests); a chunked one is not read.
    let length = field("Content-Length")
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length.min(1 << 20)];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    let mut cgi = Command::new("/usr/bin/git");
    cgi.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["-c", "uploadpack.allowFilter=true", "http-backend"])
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", method.unwrap())
        .env("PATH_INFO", format!("/private.git/{relative}"))
        .env("QUERY_STRING", query)
        .env("CONTENT_LENGTH", body.len().to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for (name, variable) in [
        ("Content-Type", "CONTENT_TYPE"),
        ("Content-Encoding", "HTTP_CONTENT_ENCODING"),
        ("Git-Protocol", "GIT_PROTOCOL"),
    ] {
        if let Some(value) = field(name) {
            cgi.env(variable, value);
        }
    }
    let Ok(mut child) = cgi.spawn() else { return };
    let mut input = child.stdin.take().unwrap();
    let feed = std::thread::spawn(move || input.write_all(&body));
    let Ok(out) = child.wait_with_output() else {
        return;
    };
    let _ = feed.join();
    // CGI output: header lines, a blank line, the body; "Status:" becomes the status line.
    let Some(at) = out.stdout.windows(4).position(|w| w == b"\r\n\r\n") else {
        return;
    };
    let head = String::from_utf8_lossy(&out.stdout[..at]).into_owned();
    let mut status = "200 OK".to_string();
    let mut fields = String::new();
    for line in head.split("\r\n") {
        match line.split_once(':') {
            Some((key, value)) if key.eq_ignore_ascii_case("Status") => {
                status = value.trim().to_string()
            }
            _ => fields.push_str(&format!("{line}\r\n")),
        }
    }
    let body = &out.stdout[at + 4..];
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\n{fields}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
}

#[test]
fn private_repo_bounds_and_authenticates_requests() {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};
    use std::time::{Duration, Instant};
    let url = private_repo();
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let request = |path: &str, signed: bool| {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let auth = if signed {
            "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9rMTExMg==\r\n"
        } else {
            ""
        };
        write!(stream, "GET {path} HTTP/1.1\r\n{auth}\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    };
    // A connected client with no headers cannot block another authenticated request.
    let mut idle = TcpStream::connect(address).unwrap();
    idle.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
    let started = Instant::now();
    assert!(request("/private.git/HEAD", true).starts_with("HTTP/1.1 200"));
    assert!(started.elapsed() < Duration::from_secs(2));
    for path in ["/private.git/HEAD", "/etc/passwd", "/private.git/../HEAD"] {
        assert!(request(path, false).starts_with("HTTP/1.1 401"));
    }
    for path in [
        "/etc/passwd",
        "/private.git//etc/passwd",
        "/private.git/../HEAD",
    ] {
        assert!(request(path, true).starts_with("HTTP/1.1 404"));
    }
    let mut byte = [0];
    assert_eq!(
        idle.read(&mut byte).unwrap(),
        0,
        "idle header read must expire"
    );
    let mut oversized = TcpStream::connect(address).unwrap();
    oversized
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    oversized.write_all(&vec![b'x'; 8193]).unwrap();
    oversized.shutdown(Shutdown::Write).unwrap();
    // Closing a socket with unread input can report either EOF or a reset.
    assert!(!matches!(oversized.read(&mut byte), Ok(n) if n > 0));
}

/// Ticket 1112: main of a repository that needs a sign-in is read with the token alone; without it, or with a wrong
/// one, the install is refused. The user's git config stays unread: the test runs again as a child whose HOME and
/// GIT_CONFIG_GLOBAL name a config with a credential helper that knows the token, a url rewrite that breaks the
/// fetch and a hooks folder whose hook leaves a mark.
#[test]
fn a_private_main_is_read_with_the_token_only() {
    const CHILD: &str = "NUNCHIRO_TEST_1112_CHILD";
    let name =
        |s: &str| std::env::temp_dir().join(format!("nunchiro-1112-{s}-{}", std::process::id()));
    let (home, mark) = (name("home"), name("mark"));
    if std::env::var_os(CHILD).is_none() {
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("hooks")).unwrap();
        let hook = home.join("hooks/reference-transaction");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let config = home.join(".gitconfig");
        fs::write(
                &config,
                format!(
                    "[credential]\n\thelper = \"!f() {{ echo username=x-access-token; echo password=tok1112; }}; f\"\n\
                     [url \"http://127.0.0.1:1/\"]\n\tinsteadOf = {}\n\
                     [core]\n\thooksPath = {}\n",
                    private_repo().rsplit_once('/').unwrap().0,
                    home.join("hooks").display()
                ),
            )
            .unwrap();
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let log = home.join("child.log");
        let output = fs::File::create(&log).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "update::tests::a_private_main_is_read_with_the_token_only",
            ])
            .args(["--test-threads=1", "--nocapture"])
            .env(CHILD, "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", &home)
            .env("GIT_CONFIG_GLOBAL", &config)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .process_group(0)
            .spawn()
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= until {
                // Kill only this test child's process group; its HTTP server closes with it.
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                child.wait().unwrap();
                panic!(
                    "private-repo test exceeded 60 seconds; child stopped: {}",
                    fs::read_to_string(&log).unwrap()
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let text = fs::read_to_string(&log).unwrap();
        assert!(
            status.success() && text.contains("1 passed"),
            "{status}: {text}"
        );
        fs::remove_dir_all(home).unwrap();
        return;
    }
    let (_, c) = main_repo();
    let url = private_repo();
    let work = name("work");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).unwrap();
    fs::set_permissions(&work, fs::Permissions::from_mode(0o700)).unwrap();
    let line = main_line(&work, url, Some("tok1112"), &AT_INSTALL).unwrap();
    assert_eq!(line, [c[0].as_str(), &c[1], &c[3], &c[4]]);
    for token in [None, Some("wrong1112")] {
        let why = main_line(&work, url, token, &AT_INSTALL).unwrap_err();
        assert!(
            why.contains("main could not be fetched"),
            "{token:?}: {why}"
        );
        assert!(
            !why.contains("tok1112") && !why.contains("wrong1112"),
            "{why}"
        );
    }
    assert!(!mark.exists(), "a hook from the user's config ran");
    fs::remove_dir_all(work).unwrap();
}

#[test]
fn a_session_token_cannot_run_update() {
    let why = owner_only(true).unwrap_err();
    assert!(why.contains("not for a session"), "{why}");
    assert!(owner_only(false).is_ok());
}
