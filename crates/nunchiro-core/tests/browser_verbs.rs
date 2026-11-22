//! V2.5-20 (WP2): `nunchiro browser` through a real core, with a fake app on the owner socket in place of the
//! WKWebView side (the live app run is tests/scenario/browser_tasks.py). Verbs come from real shell sessions, so the
//! caller is resolved exactly as for an agent. Threat model MUSTs: browser_verbs_use_session_caller,
//! browser_verb_targets_own_space_only, browser_verb_without_session_refused, browser_verbs_cannot_grant.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::browser::{Job, Verb};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

fn cli() -> PathBuf {
    cli::path()
}

fn raw(home: &Path, token: &str, request: &str) -> serde_json::Value {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    s.write_all(
        format!(
            "{{\"token\":{},\"request\":{request}}}\n",
            serde_json::json!(token)
        )
        .as_bytes(),
    )
    .unwrap();
    let mut reply = String::new();
    let _ = BufReader::new(s).read_line(&mut reply);
    serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null)
}

fn owner(home: &Path) -> String {
    fs::read_to_string(home.join("core.token"))
        .unwrap()
        .trim()
        .to_string()
}

/// The app's poll loop with the owner token: records every job and answers with the space it was given.
struct FakeApp {
    jobs: Arc<Mutex<Vec<Job>>>,
    stop: Arc<AtomicBool>,
}
impl FakeApp {
    fn start(home: &Path) -> Self {
        let (jobs, stop) = (
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(AtomicBool::new(false)),
        );
        let (h, j, s) = (home.to_path_buf(), jobs.clone(), stop.clone());
        thread::spawn(move || {
            let token = owner(&h);
            while !s.load(Ordering::SeqCst) {
                let r = raw(&h, &token, r#"{"op":"browser_next"}"#);
                let Ok(job) = serde_json::from_value::<Job>(r["Ok"]["job"].clone()) else {
                    if r.get("Ok").is_none() {
                        thread::sleep(Duration::from_millis(50));
                    }
                    continue;
                };
                let answer = serde_json::json!({"done": "ok", "title": job.space, "url": "u",
                    "list": [{"tab": 1, "title": job.space, "url": "u"}]});
                let done = serde_json::json!({"op": "browser_done", "id": job.id, "result": {"Ok": answer}});
                raw(&h, &token, &done.to_string());
                j.lock().unwrap().push(job);
            }
        });
        // Attached once the core has seen a poll.
        thread::sleep(Duration::from_millis(300));
        Self { jobs, stop }
    }
}
impl Drop for FakeApp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Starts a shell session running `script` (with `$CLI`, `$H` and `probe <name> <cmd...>` defined) and waits for it.
/// Returns the session id.
fn session(home: &Path, name: &str, script: &str) -> String {
    let body = format!(
        "CLI='{}'\nH=\"$NUNCHIRO_HOME\"\nprobe() {{ n=$1; shift; \"$@\" > \"$H/$n.out\" 2>&1 < /dev/null; echo \"exit=$?\" >> \"$H/$n.out\"; }}\n{script}\ntouch \"$H/{name}.done\"\nsleep 60\n",
        cli().display()
    );
    let path = home.join(format!("{name}.sh"));
    fs::write(&path, body).unwrap();
    let request = serde_json::json!({"op": "start", "session": {"kind": "shell", "project": home,
        "label": name, "args": ["/bin/sh", path]}});
    let r = raw(home, &owner(home), &request.to_string());
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let id = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    let until = Instant::now() + Duration::from_secs(30);
    while !home.join(format!("{name}.done")).exists() {
        assert!(Instant::now() < until, "{name} never finished");
        thread::sleep(Duration::from_millis(50));
    }
    id
}

fn out(home: &Path, name: &str) -> String {
    fs::read_to_string(home.join(format!("{name}.out"))).unwrap_or_default()
}

#[test]
fn browser_verbs_use_session_caller() {
    let core = home::spawn_serve(&home::short("bv"), &[]);
    let app = FakeApp::start(&core.home);
    let id = session(&core.home, "a", "probe tabs \"$CLI\" browser tabs");
    let text = out(&core.home, "tabs");
    assert!(text.contains("exit=0"), "{text}");
    assert!(
        text.contains(&format!("1 {id} <u>")),
        "the job ran in the caller's own space: {text}"
    );
    let jobs = app.jobs.lock().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        (jobs[0].space.as_str(), &jobs[0].verb),
        (id.as_str(), &Verb::Tabs {})
    );
}

#[test]
fn browser_verb_targets_own_space_only() {
    let core = home::spawn_serve(&home::short("bo"), &[]);
    let app = FakeApp::start(&core.home);
    // A frame that names another space, or a session, is refused by the closed verb set before any job exists.
    let forged = "printf '{\"token\":\"%s\",\"request\":{\"op\":\"browser\",\"verb\":{\"verb\":\"tabs\",\"space\":\"s1\"}}}\\n' \"$NUNCHIRO_TOKEN\" | /usr/bin/nc -U \"$H/core.sock\" > \"$H/forged.out\"";
    let a = session(
        &core.home,
        "a",
        "probe a \"$CLI\" browser goto http://127.0.0.1:9/a",
    );
    let b = session(
        &core.home,
        "b",
        &format!("probe b \"$CLI\" browser goto http://127.0.0.1:9/b\n{forged}"),
    );
    assert_ne!(a, b);
    let forged = out(&core.home, "forged");
    assert!(
        forged.contains("Err") && forged.contains("unknown field"),
        "{forged}"
    );
    let jobs = app.jobs.lock().unwrap();
    let by: BTreeMap<_, _> = jobs
        .iter()
        .map(|j| (j.space.clone(), j.verb.clone()))
        .collect();
    assert_eq!(jobs.len(), 2, "the forged frame made no job: {jobs:?}");
    assert_eq!(
        by[&a],
        Verb::Goto {
            url: "http://127.0.0.1:9/a".into()
        }
    );
    assert_eq!(
        by[&b],
        Verb::Goto {
            url: "http://127.0.0.1:9/b".into()
        }
    );
}

#[test]
fn browser_verb_without_session_refused() {
    let core = home::spawn_serve(&home::short("bn"), &[]);
    let app = FakeApp::start(&core.home);
    let home = &core.home;
    let verb = r#"{"op":"browser","verb":{"verb":"tabs"}}"#;
    // The owner from outside every session (the owner's terminal, the window's token-less CLI): refused, the owner uses the window.
    let r = raw(home, &owner(home), verb);
    assert!(
        r["Err"]
            .as_str()
            .unwrap()
            .contains("inside an agent session"),
        "{r}"
    );
    // No token, or a wrong one.
    for token in ["", "not-a-token"] {
        let r = raw(home, token, verb);
        assert_eq!(r["Err"], "unauthorized", "{r}");
    }
    // The CLI outside a session prints the refusal and fails.
    let cli_out = home::git_env::scrubbed(cli())
        .args(["browser", "tabs"])
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    assert!(!cli_out.status.success());
    assert!(String::from_utf8_lossy(&cli_out.stderr).contains("inside an agent session"));
    // A session may not take other spaces' jobs or answer them (only the app, the owner, does).
    session(
        home,
        "s",
        "printf '{\"token\":\"%s\",\"request\":{\"op\":\"browser_next\"}}\\n' \"$NUNCHIRO_TOKEN\" | /usr/bin/nc -U \"$H/core.sock\" > \"$H/next.out\"\nprintf '{\"token\":\"%s\",\"request\":{\"op\":\"browser_done\",\"id\":1,\"result\":{\"Ok\":1}}}\\n' \"$NUNCHIRO_TOKEN\" | /usr/bin/nc -U \"$H/core.sock\" > \"$H/done.out\"",
    );
    for name in ["next", "done"] {
        let text = out(home, name);
        assert!(text.contains("operation not granted"), "{name}: {text}");
    }
    // Never forwarded to another machine.
    let r = raw(
        home,
        &owner(home),
        r#"{"op":"remote","machine":"m","request":{"op":"browser","verb":{"verb":"tabs"}}}"#,
    );
    assert!(
        r["Err"].as_str().unwrap().contains("local to this Mac"),
        "{r}"
    );
    assert!(
        app.jobs.lock().unwrap().is_empty(),
        "no refused request reached the app"
    );
}

/// C2: every verb reaches the app as that verb in the caller's space and nothing else; the core's stored state
/// (approvals, grants, settings, stores) is byte-identical before and after.
#[test]
fn browser_verbs_cannot_grant() {
    let core = home::spawn_serve(&home::short("bg"), &[]);
    let app = FakeApp::start(&core.home);
    let state = |home: &Path| -> BTreeMap<PathBuf, Vec<u8>> {
        let mut all = BTreeMap::new();
        let mut dirs = vec![home.to_path_buf()];
        while let Some(d) = dirs.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                let name = p.file_name().unwrap().to_string_lossy().to_string();
                // Our own probe files, logs, the socket and live session bookkeeping are not grants.
                if name.ends_with(".out")
                    || name.ends_with(".done")
                    || name.ends_with(".sh")
                    || name.ends_with(".log")
                    || ["core.sock", "ready", "go"].contains(&name.as_str())
                    || ["sessions", "logs", "scrollback", "holders", "run"].contains(&name.as_str())
                {
                    continue;
                }
                if p.is_dir() {
                    dirs.push(p);
                } else if let Ok(bytes) = fs::read(&p) {
                    all.insert(p, bytes);
                }
            }
        }
        all
    };
    let verbs = [
        "open http://127.0.0.1:9/",
        "goto http://127.0.0.1:9/",
        "snapshot",
        "snapshot --tree --full",
        "click 1",
        "fill 1 text",
        "select 1 Bug",
        "press Enter",
        "scroll down",
        "tabs",
        "tab 1",
        "handoff sign in",
    ];
    // The verbs wait for a go file, so the session's own bookkeeping exists before the "before" picture.
    let script: Vec<String> = verbs
        .iter()
        .enumerate()
        .map(|(i, v)| format!("probe v{i} \"$CLI\" browser {v}"))
        .collect();
    let gated = format!(
        "touch \"$H/ready\"\nwhile [ ! -f \"$H/go\" ]; do sleep 0.05; done\n{}",
        script.join("\n")
    );
    let (home, before) = (core.home.clone(), Arc::new(Mutex::new(BTreeMap::new())));
    let (h, b) = (home.clone(), before.clone());
    let gate = thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(30);
        while !h.join("ready").exists() {
            assert!(Instant::now() < until, "verb session never started");
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(300)); // the start's own writes settle
        *b.lock().unwrap() = state(&h);
        fs::write(h.join("go"), "").unwrap();
    });
    let id = session(&home, "verbs", &gated);
    gate.join().unwrap();
    let before = before.lock().unwrap().clone();
    for (i, verb) in verbs.iter().enumerate() {
        assert!(
            out(&core.home, &format!("v{i}")).contains("exit=0"),
            "{}",
            verb
        );
    }
    let jobs = app.jobs.lock().unwrap();
    assert_eq!(jobs.len(), verbs.len());
    assert!(jobs.iter().all(|j| j.space == id), "{jobs:?}");
    let after = state(&core.home);
    let changed: Vec<_> = after
        .iter()
        .filter(|(p, b)| before.get(*p) != Some(*b))
        .map(|(p, _)| p)
        .collect();
    assert!(
        changed.is_empty(),
        "browser verbs changed stored state: {changed:?}"
    );
}

/// Round 2 MUST `browser_global_pending_cap`, through a real core: with an app that takes jobs and never answers,
/// three sessions fire 12 verbs at once; exactly `TOTAL_MAX` (8) wait, the rest are refused as busy, and owner and
/// hook requests still get a connection thread and answer at once. Ticket 998 L10 (B9): the app gets one job per space
/// at a time, so it holds the first job of every space with a waiting verb, and that space's others wait in the core.
#[test]
fn browser_global_pending_cap_leaves_owner_and_hooks_served() {
    let core = home::spawn_serve(&home::short("bc"), &[]);
    let home = core.home.clone();
    let taken = Arc::new(Mutex::new(Vec::<Job>::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (h, t, s) = (home.clone(), taken.clone(), stop.clone());
    thread::spawn(move || {
        let token = owner(&h);
        while !s.load(Ordering::SeqCst) {
            let r = raw(&h, &token, r#"{"op":"browser_next"}"#);
            match serde_json::from_value::<Job>(r["Ok"]["job"].clone()) {
                Ok(job) => t.lock().unwrap().push(job), // taken, never answered
                Err(_) if r.get("Ok").is_none() => thread::sleep(Duration::from_millis(50)),
                Err(_) => {}
            }
        }
    });
    thread::sleep(Duration::from_millis(300));
    let fire = |n: &str| {
        format!("for i in 1 2 3 4; do \"$CLI\" browser tabs > \"$H/{n}-$i.out\" 2>&1 & done")
    };
    let ids: Vec<String> = ["x", "y", "z"]
        .iter()
        .map(|n| session(&home, n, &fire(n)))
        .collect();
    let outs = |h: &Path| -> Vec<String> {
        ["x", "y", "z"]
            .iter()
            .flat_map(|n| (1..=4).map(move |i| format!("{n}-{i}")))
            .map(|f| out(h, &f))
            .collect()
    };
    // The spaces with a verb still waiting (no answer yet), by session id.
    let waiting = |h: &Path| -> Vec<String> {
        let o = outs(h);
        ids.iter()
            .enumerate()
            .filter(|(k, _)| o[k * 4..k * 4 + 4].iter().any(|o| o.is_empty()))
            .map(|(_, id)| id.clone())
            .collect()
    };
    let taken_spaces = || -> Vec<String> {
        let mut s: Vec<String> = taken
            .lock()
            .unwrap()
            .iter()
            .map(|j| j.space.clone())
            .collect();
        s.sort();
        s
    };
    let until = Instant::now() + Duration::from_secs(8);
    while outs(&home).iter().filter(|o| o.contains("busy")).count() < 4
        || taken_spaces() != {
            let mut w = waiting(&home);
            w.sort();
            w
        }
    {
        assert!(
            Instant::now() < until,
            "taken {:?}, outs {:?}",
            taken.lock().unwrap().len(),
            outs(&home)
        );
        thread::sleep(Duration::from_millis(20));
    }
    // The cap is hit: 8 verbs hold their threads, 4 were refused at once. The app holds one job of each space with a
    // waiting verb, none lost and none twice.
    let o = outs(&home);
    assert_eq!(
        o.iter().filter(|o| o.is_empty()).count(),
        nunchiro_core::browser::TOTAL_MAX,
        "{o:?}"
    );
    let spaces = taken_spaces();
    let mut once = spaces.clone();
    once.dedup();
    assert_eq!(once, spaces, "one job per space at a time");
    assert!(!spaces.is_empty());
    for o in outs(&home).iter().filter(|o| o.contains("busy")) {
        assert!(o.contains(nunchiro_core::browser::BUSY), "{o}");
    }
    // Owner and hook requests still connect and answer while those 8 wait.
    let t0 = Instant::now();
    let snap = raw(&home, &owner(&home), r#"{"op":"snapshot"}"#);
    assert_eq!(snap["Ok"]["type"], "snapshot", "{snap}");
    let hook = raw(
        &home,
        &owner(&home),
        &serde_json::json!({"op":"hook","id":ids[0],"event":"Stop","payload":{}}).to_string(),
    );
    assert!(hook["Ok"].is_object(), "{hook}");
    let list = raw(&home, &owner(&home), r#"{"op":"list"}"#);
    assert!(list["Ok"].is_object(), "{list}");
    assert!(
        t0.elapsed() < Duration::from_secs(2),
        "owner requests waited {:?}",
        t0.elapsed()
    );
    assert_eq!(taken_spaces(), spaces, "and nothing else reached the app");
    stop.store(true, Ordering::SeqCst);
}
