//! Script widget requests through the core's unix socket: owner only, session tokens refused, setting off by default.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}
impl Core {
    fn new(tag: &str, settings: &str) -> Self {
        let home = home::short(&format!("wt-{tag}"));
        fs::write(home.join("settings.json"), settings).unwrap();
        let path = home.clone();
        let task = thread::spawn(move || server::serve_recording(&path));
        let start = Instant::now();
        while !home.join("core.sock").exists() {
            assert!(start.elapsed() < Duration::from_secs(30));
            thread::sleep(Duration::from_millis(10));
        }
        Self {
            home,
            task: Some(task),
        }
    }
    fn owner(&self, request: Request) -> Response {
        raw(
            &self.home,
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            let _ = self.owner(Request::Stop);
            t.join().unwrap().unwrap();
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn raw(home: &Path, token: &str, request: Request) -> Response {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    let mut line = serde_json::to_vec(&Envelope {
        token: token.into(),
        request,
    })
    .unwrap();
    line.push(b'\n');
    s.write_all(&line).unwrap();
    let mut reply = String::new();
    BufReader::new(s).read_line(&mut reply).unwrap();
    serde_json::from_str(&reply).unwrap()
}
fn widget(home: &Path) {
    let d = home.join("widgets/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(
        d.join("run.sh"),
        "echo ran > \"$NUNCHIRO_CACHE/marker\"\necho \"$NUNCHIRO_PROJECT_DIR\"\n",
    )
    .unwrap();
    let v = nunchiro_core::approval::status(home, "demo").unwrap();
    nunchiro_core::approval::grant(home, "demo", nunchiro_core::approval::Level::Read, &v.hash)
        .unwrap();
}

#[test]
fn widgets_owner_runs_and_session_token_is_refused() {
    let core = Core::new("on", r#"{"script_widgets":true}"#);
    widget(&core.home);
    let project = core.home.join("proj");
    fs::create_dir_all(&project).unwrap();
    let Reply::Started { session } = core
        .owner(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.clone(),
                worktree: false,
                label: "w".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf %s \"$NUNCHIRO_TOKEN\" > .token; exec /bin/cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    else {
        panic!("not started")
    };
    let start = Instant::now();
    while !project.join(".token").exists() {
        assert!(start.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(20));
    }
    let token = fs::read_to_string(project.join(".token")).unwrap();
    assert!(!token.is_empty());
    for request in [
        Request::WidgetList,
        Request::WidgetRun {
            name: "demo".into(),
            session: Some(session.id.clone()),
        },
    ] {
        assert_eq!(
            raw(&core.home, &token, request).unwrap_err(),
            "operation not granted"
        );
    }
    assert!(!core.home.join("widgets/demo/cache/marker").exists());
    let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
        panic!()
    };
    assert!(list.enabled);
    assert_eq!(list.widgets[0].name, "demo");
    // The answer comes within 250 ms; a run still going is reported as running and cached for the next call.
    let start = Instant::now();
    let run = loop {
        let Reply::WidgetRun { run } = core
            .owner(Request::WidgetRun {
                name: "demo".into(),
                session: Some(session.id.clone()),
            })
            .unwrap()
        else {
            panic!()
        };
        if !run.running {
            break run;
        }
        assert!(start.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        run.output,
        Some(nunchiro_core::widgets::Output::Text {
            text: format!("{}\n", project.canonicalize().unwrap().display())
        }),
        "{run:?}"
    );
    assert_eq!(run.project.as_deref(), Some("proj"));
    let err = core
        .owner(Request::WidgetRun {
            name: "demo".into(),
            session: Some("no-such".into()),
        })
        .unwrap_err();
    assert_eq!(err, "session not found");
}

#[test]
fn widgets_setting_defaults_off_over_the_socket() {
    let core = Core::new("off", "{}");
    widget(&core.home);
    let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
        panic!()
    };
    assert!(!list.enabled);
    assert_eq!(list.widgets.len(), 1);
    let err = core
        .owner(Request::WidgetRun {
            name: "demo".into(),
            session: None,
        })
        .unwrap_err();
    assert_eq!(err, nunchiro_core::widgets::OFF);
    assert!(!core.home.join("widgets/demo/cache/marker").exists());
    // Ticket 872: the Settings switch turns runs on in the running core and stores the key; off again refuses again.
    for on in [true, false] {
        let Reply::QuitSettings { settings } = core
            .owner(Request::QuitSettings {
                patch: LifetimePatch {
                    script_widgets: Some(on),
                    ..Default::default()
                },
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(settings.script_widgets, on);
        let Reply::Widgets { list } = core.owner(Request::WidgetList).unwrap() else {
            panic!()
        };
        assert_eq!(list.enabled, on);
        let file: serde_json::Value =
            serde_json::from_slice(&fs::read(core.home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(file["script_widgets"], on);
    }
}

// v1a-17: the run is held by a gate file in its cache (outside the approved hash) rather than timed.
#[test]
fn widgets_slow_run_answers_quickly_and_caches() {
    let core = Core::new("slow", r#"{"script_widgets":true}"#);
    let d = core.home.join("widgets/demo");
    fs::create_dir_all(d.join("cache")).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    // Bounded so a broken test cannot leave the run going.
    fs::write(
        d.join("run.sh"),
        ": > \"$NUNCHIRO_CACHE/entered\"\ni=0\nwhile [ -e \"$NUNCHIRO_CACHE/hold\" ] && [ $i -lt 3000 ]; do /bin/sleep 0.01; i=$((i + 1)); done\necho slow\n",
    )
    .unwrap();
    let held = Hold(d.join("cache/hold"));
    fs::write(&held.0, "").unwrap();
    let v = nunchiro_core::approval::status(&core.home, "demo").unwrap();
    nunchiro_core::approval::grant(
        &core.home,
        "demo",
        nunchiro_core::approval::Level::Read,
        &v.hash,
    )
    .unwrap();
    let ask = || {
        let Reply::WidgetRun { run } = core
            .owner(Request::WidgetRun {
                name: "demo".into(),
                session: None,
            })
            .unwrap()
        else {
            panic!()
        };
        run
    };
    // The command cannot finish while held, so an answer at all is an answer before it ended.
    let first = ask();
    assert!(first.running && first.output.is_none(), "{first:?}");
    // Other requests are not held up while it runs.
    assert!(matches!(
        core.owner(Request::WidgetList).unwrap(),
        Reply::Widgets { .. }
    ));
    let entered = d.join("cache/entered");
    let until = Instant::now() + Duration::from_secs(30);
    while !entered.exists() {
        assert!(Instant::now() < until, "the widget command never started");
        thread::sleep(Duration::from_millis(10));
    }
    fs::remove_file(&held.0).unwrap();
    let start = Instant::now();
    let done = loop {
        let r = ask();
        if !r.running {
            break r;
        }
        assert!(start.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        done.output,
        Some(nunchiro_core::widgets::Output::Text {
            text: "slow\n".into()
        })
    );
    assert_eq!(ask().ran_at_ms, done.ran_at_ms, "early call ran again");
}

// v1b-21 r2: a core that stops during a run takes the run's process group with it; nothing keeps cache write access.
#[test]
fn widgets_core_stop_kills_a_run_in_progress() {
    let mut core = Core::new("stoprun", r#"{"script_widgets":true}"#);
    let d = core.home.join("widgets/slow");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n",
    )
    .unwrap();
    fs::write(
        d.join("run.sh"),
        "/bin/sleep 30 &\necho $! > \"$NUNCHIRO_CACHE/pids\"\necho $$ >> \"$NUNCHIRO_CACHE/pids\"\n/bin/sleep 30\n",
    )
    .unwrap();
    let v = nunchiro_core::approval::status(&core.home, "slow").unwrap();
    nunchiro_core::approval::grant(
        &core.home,
        "slow",
        nunchiro_core::approval::Level::Read,
        &v.hash,
    )
    .unwrap();
    let Reply::WidgetRun { run } = core
        .owner(Request::WidgetRun {
            name: "slow".into(),
            session: None,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(run.running);
    let pids = d.join("cache/pids");
    let start = Instant::now();
    while fs::read_to_string(&pids).map_or(true, |p| p.lines().count() < 2) {
        assert!(start.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(20));
    }
    let pids: Vec<i32> = fs::read_to_string(&pids)
        .unwrap()
        .lines()
        .map(|l| l.trim().parse().unwrap())
        .collect();
    core.owner(Request::Stop).unwrap();
    core.task.take().unwrap().join().unwrap().unwrap();
    // Well inside the 5 s run timeout, which only a live core would enforce.
    thread::sleep(Duration::from_millis(200));
    let alive: Vec<i32> = pids
        .iter()
        .copied()
        .filter(|&p| unsafe { libc::kill(p, 0) } == 0)
        .collect();
    for &p in &alive {
        unsafe { libc::kill(p, libc::SIGKILL) };
    }
    assert!(
        alive.is_empty(),
        "run processes outlived the core: {alive:?}"
    );
}

/// v1a-17: a hold file the widget command waits on; dropping it releases a failing test's run too.
struct Hold(PathBuf);
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
