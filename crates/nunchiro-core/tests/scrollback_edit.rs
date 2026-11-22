//! V1A-38b: scrollback to $EDITOR. The window op writes the session's whole log to a fixed file under
//! `exports/<id>/` and starts a plain shell session that opens it; nothing is typed into any PTY.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, scrollback_edit, server::call};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";

fn scratch(tag: &str) -> PathBuf {
    home::short(&format!("se-{tag}"))
}

/// Records its argument count, its arguments and the file's bytes, then exits (the editor closing).
const FAKE_EDITOR: &str = "#!/bin/sh\nprintf '%s\\n' \"$#\" \"$@\" > \"$0.argv\"\nenv | cut -d= -f1 > \"$0.names\"\ncat \"$1\" > \"$0.content\"\n";

struct Core {
    home: PathBuf,
    /// The core's HOME: no dotfile of the host's user reaches the login shell.
    user: PathBuf,
    editor: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let root = scratch("core");
        let (home, user) = (root.join("home"), root.join("user"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&user).unwrap();
        let editor = root.join("editor");
        fs::write(&editor, FAKE_EDITOR).unwrap();
        fs::set_permissions(&editor, fs::Permissions::from_mode(0o700)).unwrap();
        let process = Self::serve(&home, &user, &editor);
        let core = Self {
            home,
            user,
            editor,
            process,
        };
        core.ready();
        core
    }
    fn serve(home: &Path, user: &Path, editor: &Path) -> Child {
        let bin = cli::path();
        home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", user)
            .env("ZDOTDIR", user)
            .env("EDITOR", editor)
            .env("W36_EDIT_API_KEY", "edit-secret") // ticket 1008 round 4
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    /// The same home with a fresh core.
    fn restart(&mut self) {
        call(&self.home, Request::Stop).unwrap();
        self.process.wait().unwrap();
        let _ = fs::remove_file(self.home.join("window.json"));
        self.process = Self::serve(&self.home, &self.user, &self.editor);
        self.ready();
    }
    fn ready(&self) {
        let core = self;
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists()
            || !matches!(
                call(&core.home, Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            )
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn ws(&self) -> tungstenite::WebSocket<TcpStream> {
        let v = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let port = v["port"].as_u64().unwrap() as u16;
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static(ORIGIN));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                v["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        tungstenite::client(req, stream).unwrap().0
    }
    /// A shell session that prints `script`'s output, then idles as `cat`.
    fn shell(&self, project: &Path, script: &str) -> Session {
        let Reply::Started { session } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: project.into(),
                    worktree: false,
                    label: "src".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), format!("{script}; exec cat")],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        session
    }
    fn read(&self, id: &str) -> Vec<u8> {
        match call(
            &self.home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => data,
            other => panic!("{other:?}"),
        }
    }
    fn wait_for(&self, id: &str, mark: &str) {
        let until = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&self.read(id)).contains(mark) {
            assert!(Instant::now() < until, "no {mark:?} in {id}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn session(&self, id: &str) -> Option<Session> {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&self.home, Request::List) else {
            panic!()
        };
        sessions.into_iter().find(|s| s.id == id)
    }
    fn edit(&self, id: &str) -> serde_json::Value {
        let mut ws = self.ws();
        ws.send(Message::Text(
            serde_json::json!({"id":7,"request":{"op":"scrollback_edit","id":id}})
                .to_string()
                .into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < until, "no reply");
            if let Message::Text(t) = ws.read().unwrap() {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
    /// The fake editor's record once it has run.
    fn opened(&self) -> (Vec<String>, String) {
        let argv = self.editor.with_extension("argv");
        let until = Instant::now() + Duration::from_secs(10);
        while !self.editor.with_extension("content").exists() {
            assert!(Instant::now() < until, "the editor never ran");
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(50));
        (
            fs::read_to_string(argv)
                .unwrap()
                .lines()
                .map(String::from)
                .collect(),
            fs::read_to_string(self.editor.with_extension("content")).unwrap(),
        )
    }
    fn owner_line(&self, token: &str, request: serde_json::Value) -> serde_json::Value {
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        let env = serde_json::json!({"token":token,"request":request});
        s.write_all(format!("{env}\n").as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(&s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn export_files(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![home.join("exports")];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                out.push(e.path());
            }
        }
    }
    out
}

#[test]
fn five_thousand_coloured_lines_land_in_one_plain_file_opened_in_the_editor() {
    let core = Core::new();
    let project = scratch("p1");
    let src = core.shell(
        &project,
        r#"i=0; while [ $i -lt 5000 ]; do printf '\033[1;3%dmline %d\033[0m \033]0;t\007ok\n' $((i % 8)) $i; i=$((i+1)); done; printf DONE"#,
    );
    core.wait_for(&src.id, "DONE");
    let log = |core: &Core| serde_json::to_value(core.session(&src.id).unwrap().send_log).unwrap();
    let before = (core.read(&src.id), log(&core));

    let reply = core.edit(&src.id);
    let ok = &reply["Ok"];
    assert_eq!(ok["type"], "scrollback_edit", "{reply}");
    assert_eq!(ok["truncated"], false);
    let editor = ok["session"]["id"].as_str().unwrap().to_string();
    assert_ne!(editor, src.id);
    assert_eq!(ok["session"]["kind"], "shell");
    assert_eq!(ok["session"]["project"], project.to_str().unwrap());

    // Exactly one file, at the fixed path, private.
    let path = core
        .home
        .join("exports")
        .join(&src.id)
        .join("scrollback.txt");
    assert_eq!(export_files(&core.home), std::slice::from_ref(&path));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for dir in [core.home.join("exports"), path.parent().unwrap().into()] {
        assert_eq!(
            fs::metadata(dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let text = fs::read(&path).unwrap();
    assert!(
        !text.iter().any(|b| *b == 0x1b || *b == b'\r' || *b == 7),
        "escape or control bytes left"
    );
    let text = String::from_utf8(text).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 5001, "{:?}", &lines[..3]);
    for (i, line) in lines[..5000].iter().enumerate() {
        assert_eq!(*line, format!("line {i} ok"));
    }
    assert_eq!(lines[5000], "DONE");

    // The editor got the one path as its only argument and saw the same file.
    let (argv, content) = core.opened();
    assert_eq!(argv, ["1".to_string(), path.to_str().unwrap().to_string()]);
    assert_eq!(content, text);
    // The editor exiting ends its session.
    let until = Instant::now() + Duration::from_secs(10);
    while core.session(&editor).unwrap().state == SessionState::Running {
        assert!(Instant::now() < until, "the editor session did not end");
        thread::sleep(Duration::from_millis(20));
    }
    // Nothing reached the source PTY: same bytes, same send log.
    thread::sleep(Duration::from_millis(200));
    assert_eq!((core.read(&src.id), log(&core)), before);
    // Overwritten, not added to, on the next export.
    fs::remove_file(core.editor.with_extension("content")).unwrap();
    assert_eq!(core.edit(&src.id)["Ok"]["type"], "scrollback_edit");
    core.opened();
    assert_eq!(export_files(&core.home), [path]);
    let _ = fs::remove_dir_all(project);
}

#[test]
fn shell_syntax_in_the_scrollback_reaches_the_editor_only_as_text() {
    let core = Core::new();
    let project = scratch("p6");
    let src = core.shell(
        &project,
        r#"printf '%s\n' '$(touch x)' '`touch y`' "'q' \"d\"" '; touch z #' 'END'"#,
    );
    core.wait_for(&src.id, "END");
    assert!(core.edit(&src.id).get("Ok").is_some());
    let (argv, content) = core.opened();
    assert_eq!(argv.len(), 2, "{argv:?}");
    assert!(
        content.contains("$(touch x)\n`touch y`\n'q' \"d\"\n; touch z #\n"),
        "{content:?}"
    );
    thread::sleep(Duration::from_millis(200));
    for dir in [&project, &core.user, &core.home] {
        for f in ["x", "y", "z"] {
            assert!(!dir.join(f).exists(), "{f} created in {dir:?}");
        }
    }
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_crafted_or_unknown_id_creates_nothing() {
    let core = Core::new();
    for id in ["../x", "/tmp/x", "a\0b", "a/b", "", "no-such-session"] {
        let reply = core.edit(id);
        assert!(reply.get("Err").is_some(), "{id:?} accepted: {reply}");
    }
    assert!(!core.home.join("exports").exists());
    assert!(!core.home.parent().unwrap().join("x").exists());
}

#[test]
fn a_symlinked_exports_folder_is_refused() {
    for nested in [false, true] {
        let core = Core::new();
        let project = scratch("ps");
        let src = core.shell(&project, "printf HELLO");
        core.wait_for(&src.id, "HELLO");
        let elsewhere = scratch("elsewhere");
        let link = if nested {
            fs::create_dir_all(core.home.join("exports")).unwrap();
            core.home.join("exports").join(&src.id)
        } else {
            core.home.join("exports")
        };
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let reply = core.edit(&src.id);
        assert!(reply.get("Err").is_some(), "accepted: {reply}");
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(elsewhere);
    }
}

#[test]
fn the_owner_socket_a_session_token_and_remote_cannot_express_the_op() {
    let core = Core::new();
    let project = scratch("pt");
    let src = core.shell(&project, r#"printf 'TOKEN=%s:' "$NUNCHIRO_TOKEN""#);
    core.wait_for(&src.id, ":");
    let out = String::from_utf8(core.read(&src.id)).unwrap();
    let session_token = out
        .split("TOKEN=")
        .nth(1)
        .unwrap()
        .split(':')
        .next()
        .unwrap()
        .to_string();
    let owner = fs::read_to_string(core.home.join("core.token")).unwrap();
    let op = serde_json::json!({"op":"scrollback_edit","id":src.id});
    for (token, request) in [
        (owner.trim(), op.clone()),
        (session_token.as_str(), op.clone()),
        ("not-a-token", op.clone()),
        (
            owner.trim(),
            serde_json::json!({"op":"remote","machine":"m","request":op}),
        ),
    ] {
        let v = core.owner_line(token, request);
        assert!(v.get("Err").is_some(), "accepted: {v}");
    }
    assert!(!core.home.join("exports").exists());
    let _ = fs::remove_dir_all(project);
}

#[test]
fn plain_strips_escape_sequences_and_controls() {
    let cases: [(&[u8], &str); 9] = [
        (b"\x1b[1;31mred\x1b[0m\r\n", "red\n"),
        (b"a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c", "abc"),
        (b"\x1bP1$r0m\x1b\\d", "d"),
        (b"\x1b(Bx\x1b7y\x1b=z", "xyz"),
        (b"tab\there\x08\x00\x7f!", "tab\there!"),
        (b"\xc2\x9b31mc1\xc2\x9d0;t\xc2\x9c.", "c1."),
        (b"bad \xff utf8", "bad \u{fffd} utf8"),
        // An unterminated OSC stops at the line end, so the rest of the log survives.
        (b"\x1b]0;never ends\nkept", "\nkept"),
        (b"end\x1b", "end"),
    ];
    for (input, want) in cases {
        assert_eq!(scrollback_edit::plain(input), want, "{input:?}");
    }
}

#[test]
fn the_launch_argv_is_fixed_and_carries_the_path_as_a_parameter() {
    let path = Path::new("/n/exports/abc/scrollback.txt");
    let argv = scrollback_edit::argv(path).unwrap();
    assert_eq!(
        argv,
        [
            "/bin/zsh",
            "-l",
            "-c",
            scrollback_edit::SCRIPT,
            "nunchiro-edit",
            "/n/exports/abc/scrollback.txt"
        ]
    );
    assert!(!scrollback_edit::SCRIPT.contains("exports"));
}

/// Runs the constant script as the launch does, without the host's rc files, in `dir`.
fn run_script(dir: &Path, editor: Option<&str>, file: &Path) {
    let mut cmd = Command::new("/bin/zsh");
    cmd.args(["-f", "-c", scrollback_edit::SCRIPT, "nunchiro-edit"])
        .arg(file)
        .current_dir(dir)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", dir.join("bin").display()),
        )
        .env_remove("EDITOR");
    if let Some(e) = editor {
        cmd.env("EDITOR", e);
    }
    assert!(cmd.status().unwrap().success());
}

#[test]
fn without_editor_the_script_falls_back_to_open_t() {
    let dir = scratch("open");
    fs::create_dir_all(dir.join("bin")).unwrap();
    let stub = dir.join("bin/open");
    fs::write(&stub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.argv\"\n").unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();
    let file = dir.join("a b $(touch x).txt");
    fs::write(&file, "x").unwrap();
    run_script(&dir, None, &file);
    assert_eq!(
        fs::read_to_string(stub.with_extension("argv")).unwrap(),
        format!("-t\n{}\n", file.display())
    );
    // An editor with its own flags (`code -w`) is split into words; the path stays one argument.
    let rec = dir.join("bin/ed");
    fs::write(&rec, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.argv\"\n").unwrap();
    fs::set_permissions(&rec, fs::Permissions::from_mode(0o700)).unwrap();
    run_script(&dir, Some(&format!("{} -w", rec.display())), &file);
    assert_eq!(
        fs::read_to_string(rec.with_extension("argv")).unwrap(),
        format!("-w\n{}\n", file.display())
    );
    assert!(!dir.join("x").exists());
    let _ = fs::remove_dir_all(dir);
}

// Ticket 800, review r1 MUST 2: with `$2` (a test core) and no `$EDITOR`, the script runs no `open` and writes
// nothing; the core records through its own checked writer. A path as `$2` shows the shell no longer writes there.
#[test]
fn a_test_core_script_runs_no_open_and_writes_nothing() {
    let dir = scratch("rec");
    fs::create_dir_all(dir.join("bin")).unwrap();
    let stub = dir.join("bin/open");
    fs::write(&stub, "#!/bin/sh\ntouch \"$0.ran\"\n").unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();
    let (file, record) = (dir.join("scrollback.txt"), dir.join("opened.argv"));
    let status = Command::new("/bin/zsh")
        .args(["-f", "-c", scrollback_edit::SCRIPT, "nunchiro-edit"])
        .args([&file, &record])
        .current_dir(&dir)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", dir.join("bin").display()),
        )
        .env_remove("EDITOR")
        .status()
        .unwrap();
    assert!(status.success());
    assert!(!record.exists(), "the shell wrote the record");
    assert!(!stub.with_extension("ran").exists(), "`open` ran");
    let _ = fs::remove_dir_all(dir);
}

// Round 2: the export is kept until its session is deleted, then removed with its folder; never through a link.
#[test]
fn closing_the_session_removes_its_export_and_a_restart_sweeps_orphans() {
    let mut core = Core::new();
    let project = scratch("pc");
    let (a, b) = (
        core.shell(&project, "printf A1"),
        core.shell(&project, "printf B1"),
    );
    core.wait_for(&a.id, "A1");
    core.wait_for(&b.id, "B1");
    for s in [&a, &b] {
        assert!(core.edit(&s.id).get("Ok").is_some());
    }
    let exports = core.home.join("exports");
    let dir = |id: &str| exports.join(id);
    assert!(dir(&a.id).join("scrollback.txt").exists());
    call(&core.home, Request::Close { id: a.id.clone() }).unwrap();
    assert!(!dir(&a.id).exists(), "the closed session's export stayed");
    assert!(dir(&b.id).join("scrollback.txt").exists());
    // A folder left by a session that no longer has an open row (a crash before close) goes at the next start; an
    // open row's export stays.
    let orphan = dir("0rphan-id");
    fs::create_dir_all(&orphan).unwrap();
    fs::set_permissions(&orphan, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(orphan.join("scrollback.txt"), "old").unwrap();
    core.restart();
    assert!(!orphan.exists(), "the orphan export stayed");
    assert!(dir(&b.id).join("scrollback.txt").exists());
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_symlinked_or_shared_export_folder_is_not_followed_on_delete() {
    let mut core = Core::new();
    let project = scratch("pl");
    let (a, b) = (
        core.shell(&project, "printf A1"),
        core.shell(&project, "printf B1"),
    );
    core.wait_for(&a.id, "A1");
    core.wait_for(&b.id, "B1");
    let elsewhere = scratch("victim");
    // A target that passes the owner and mode check (ours, 0700): only the O_NOFOLLOW open keeps it safe.
    fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(elsewhere.join("scrollback.txt"), "keep").unwrap();
    fs::create_dir_all(core.home.join("exports")).unwrap();
    let link = core.home.join("exports").join(&a.id);
    std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
    // Not a private folder: group or other access means it is not one the core made.
    let open = core.home.join("exports").join(&b.id);
    fs::create_dir_all(&open).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(open.join("scrollback.txt"), "keep").unwrap();
    for s in [&a, &b] {
        call(&core.home, Request::Close { id: s.id.clone() }).unwrap();
    }
    core.restart();
    assert_eq!(
        fs::read_to_string(elsewhere.join("scrollback.txt")).unwrap(),
        "keep"
    );
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(
        fs::read_to_string(open.join("scrollback.txt")).unwrap(),
        "keep"
    );
    // A symlinked `exports/` itself is never entered either.
    drop(core);
    let mut core = Core::new();
    let src = core.shell(&project, "printf C1");
    core.wait_for(&src.id, "C1");
    let victim = elsewhere.join("0rphan-id");
    fs::create_dir_all(&victim).unwrap();
    fs::set_permissions(&victim, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(victim.join("scrollback.txt"), "keep").unwrap();
    std::os::unix::fs::symlink(&elsewhere, core.home.join("exports")).unwrap();
    call(&core.home, Request::Close { id: src.id.clone() }).unwrap();
    core.restart();
    assert_eq!(
        fs::read_to_string(victim.join("scrollback.txt")).unwrap(),
        "keep"
    );
    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(elsewhere);
}

// Ticket 1008 round 4: the editor tab is the owner's window op, so it keeps his environment (names only recorded).
#[test]
fn editor_tab_keeps_owner_secret_names() {
    let core = Core::new();
    let project = scratch("p1008");
    let src = core.shell(&project, "printf DONE");
    core.wait_for(&src.id, "DONE");
    assert_eq!(core.edit(&src.id)["Ok"]["type"], "scrollback_edit");
    core.opened();
    let names = fs::read_to_string(core.editor.with_extension("names")).unwrap();
    assert!(names.lines().any(|n| n == "W36_EDIT_API_KEY"), "{names}");
}
