//! Confined file access over the window WebSocket (spec B3, Acceptance 9, core half; ticket 08).
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
#[path = "fixtures/hold.rs"]
mod hold;

const ORIGIN: &str = "http://127.0.0.1:4173";
const SECRET: &str = "outside-secret";

struct Fixture {
    home: PathBuf,
    proj: PathBuf,
    /// A second project folder, for the cross-project refusals.
    other: PathBuf,
    process: Child,
    session: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_env(&[])
    }
    /// v1a-14: `env` overrides the core's environment (a hold shim it loads, a `PATH` with a held `git`), for a
    /// test that must hold it mid-request.
    fn with_env(env: &[(&str, std::ffi::OsString)]) -> Self {
        let base = home::short("f");
        let (home, proj, outside) = (base.join("h"), base.join("p"), base.join("o"));
        for d in [&home, &proj.join("src"), &proj.join("build"), &outside] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(outside.join("secret.txt"), SECRET).unwrap();
        // Project files: one per kind, plus links out of and within the project.
        let w = |p: &str, b: &[u8]| fs::write(proj.join(p), b).unwrap();
        w("a.txt", b"hello\n");
        w("README.md", b"# Title\n");
        w("pic.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
        w("logo.svg", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
        w("page.html", b"<!doctype html><p>hi</p>");
        w("blob.bin", &[0, 1, 2, 3, 0, 255]);
        w("big.txt", &b"x".repeat(5 * 1024 * 1024));
        w(".gitignore", b"ignored.log\nbuild/\n");
        w("ignored.log", b"needle in an ignored file\n");
        w("build/out.txt", b"needle in an ignored dir\n");
        w("src/main.rs", b"fn main() {}\n// needle here\n");
        w("src/bin.dat", b"needle\0binary");
        symlink(outside.join("secret.txt"), proj.join("link_out")).unwrap();
        symlink(&outside, proj.join("link_dir_out")).unwrap();
        symlink(proj.join("a.txt"), proj.join("link_in")).unwrap();
        let git = |args: &[&str]| {
            let out = home::git_env::scrubbed("git")
                .arg("-C")
                .arg(&proj)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);
        w("a.txt", b"hello changed\n");
        // Data folder: viewable subfolders (the core writes sessions.json itself once a session starts).
        for (p, b) in [
            ("artifacts/s1/note.md", &b"# note"[..]),
            ("images/x.png", b"\x89PNG\r\n\x1a\n"),
        ] {
            fs::create_dir_all(home.join(p).parent().unwrap()).unwrap();
            fs::write(home.join(p), b).unwrap();
        }
        symlink(home.join("sessions.json"), home.join("artifacts/evil")).unwrap();

        let bin = cli::path();
        let mut command = home::git_env::scrubbed(bin);
        command
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let process = command.spawn().unwrap();
        let other = base.join("q");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("theirs.txt"), "needle of another project").unwrap();
        let mut f = Self {
            home,
            proj,
            other,
            process,
            session: String::new(),
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !f.home.join("window.json").exists()
            || !matches!(call(&f.home, Request::Snapshot), Ok(Reply::Snapshot { .. }))
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        let Reply::Started { session } = call(
            &f.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: f.proj.clone(),
                    worktree: false,
                    label: "files".into(),
                    args: vec!["/bin/cat".into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        f.session = session.id;
        f
    }
    /// Owner request over the unix socket.
    fn owner(&self, request: Request) -> Reply {
        call(&self.home, request).unwrap()
    }
    /// A shell session that prints its own session token, which this returns with the session id.
    fn token_session(&self, project: &Path) -> (String, String) {
        let Reply::Started { session } = self.owner(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.to_path_buf(),
                worktree: false,
                label: "token".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        }) else {
            panic!()
        };
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Reply::Output { data, .. } = self.owner(Request::Read {
                id: session.id.clone(),
                after: 0,
            }) else {
                panic!()
            };
            let text = String::from_utf8_lossy(&data).into_owned();
            // The first line starts with the holder's size mark (ticket 995).
            if let Some((_, line)) = text.lines().find_map(|l| l.split_once("TOKEN:")) {
                return (session.id, line.trim().to_string());
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// One request over the unix socket with an explicit token (a session token, not the owner's).
    fn socket_call(&self, token: &str, request: Value) -> Result<Value, String> {
        use std::io::{BufRead, BufReader, Write};
        let mut s = std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn window(&self) -> (u16, String) {
        let v: Value =
            serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        (
            v["port"].as_u64().unwrap() as u16,
            v["token"].as_str().unwrap().into(),
        )
    }
    fn dial(&self, origin: &str) -> Result<tungstenite::WebSocket<TcpStream>, u16> {
        let (port, token) = self.window();
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        match tungstenite::client(req, stream) {
            Ok((ws, _)) => Ok(ws),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => {
                Err(r.status().as_u16())
            }
            Err(e) => panic!("unexpected handshake error: {e}"),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

struct Window {
    ws: tungstenite::WebSocket<TcpStream>,
    next: u64,
}
impl Window {
    fn open(f: &Fixture) -> Self {
        Self {
            ws: f.dial(ORIGIN).expect("authorized dial"),
            next: 0,
        }
    }
    /// One request, one `response` (`{"Ok":..}` or `{"Err":..}`).
    fn ask(&mut self, request: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.ws
            .send(Message::Text(
                json!({"id":id,"request":request}).to_string().into(),
            ))
            .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < until, "no reply for {id}");
            if let Message::Text(t) = self.ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == id {
                    return v["response"].clone();
                }
            }
        }
    }
    fn read(&mut self, root: &str, path: &str) -> Value {
        self.ask(json!({"op":"file_read","root":root,"path":path}))
    }
    fn list(&mut self, root: &str, path: &str) -> Value {
        self.ask(json!({"op":"files_list","root":root,"path":path}))
    }
}

fn refused(v: &Value) {
    let err = v["Err"]
        .as_str()
        .unwrap_or_else(|| panic!("not refused: {v}"));
    assert!(!err.contains(SECRET), "error leaks content: {err}");
}
fn kind(v: &Value) -> &str {
    v["Ok"]["kind"]
        .as_str()
        .unwrap_or_else(|| panic!("no kind: {v}"))
}
fn entry<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["Ok"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("no entries: {list}"))
        .iter()
        .find(|e| e["name"] == name)
        .unwrap_or_else(|| panic!("no entry {name}: {list}"))
}

#[test]
fn files_dot_dot_paths_are_refused() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let root = f.session.as_str();
    for p in ["../o/secret.txt", "src/../../o/secret.txt", ".."] {
        refused(&w.read(root, p));
        refused(&w.list(root, p));
    }
    refused(&w.ask(json!({"op":"files_search","root":root,"query":"x","path":".."})));
}

#[test]
fn files_absolute_paths_are_refused_even_inside_the_root() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let outside = f.proj.join("../o/secret.txt");
    refused(&w.read(&f.session, outside.to_str().unwrap()));
    refused(&w.read(&f.session, "/etc/hosts"));
    refused(&w.read(&f.session, f.proj.join("a.txt").to_str().unwrap()));
    refused(&w.list(&f.session, "/"));
}

#[test]
fn files_symlinks_out_of_the_project_are_refused() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    refused(&w.read(&f.session, "link_out"));
    refused(&w.read(&f.session, "link_dir_out/secret.txt"));
    refused(&w.list(&f.session, "link_dir_out"));
    // A link that stays inside the root is fine.
    assert_eq!(kind(&w.read(&f.session, "link_in")), "text");
}

#[test]
fn files_unknown_root_is_refused() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    refused(&w.read("no-such-session", "a.txt"));
    refused(&w.read("", "a.txt"));
}

#[test]
fn files_each_file_kind_is_sniffed() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let s = f.session.as_str();
    for (path, want) in [
        ("a.txt", "text"),
        ("src/main.rs", "text"),
        ("README.md", "markdown"),
        ("pic.png", "image"),
        ("logo.svg", "svg"),
        ("page.html", "html"),
        ("blob.bin", "binary"),
    ] {
        let r = w.read(s, path);
        assert_eq!(kind(&r), want, "{path}: {r}");
        assert_eq!(r["Ok"]["too_large"], false, "{path}");
    }
    assert_eq!(w.read(s, "a.txt")["Ok"]["text"], "hello changed\n");
    assert!(w.read(s, "pic.png")["Ok"]["data"].is_array());
    assert!(w.read(s, "blob.bin")["Ok"]["data"].is_null());
}

#[test]
fn files_read_carries_mtime_that_changes_after_a_same_size_rewrite() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let s = f.session.as_str();
    for path in ["a.txt", "pic.png", "blob.bin", "big.txt"] {
        assert!(w.read(s, path)["Ok"]["mtime_ms"].is_u64(), "{path}");
    }
    let set = |path: &str, ms: u64| {
        let file = fs::File::options()
            .write(true)
            .open(f.proj.join(path))
            .unwrap();
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        file.set_modified(t).unwrap();
    };
    for path in ["a.txt", "big.txt"] {
        set(path, 1_700_000_000_000);
        let before = w.read(s, path)["Ok"].clone();
        assert_eq!(before["mtime_ms"], 1_700_000_000_000u64, "{path}");
        let mut bytes = fs::read(f.proj.join(path)).unwrap();
        bytes[0] ^= 1;
        fs::write(f.proj.join(path), &bytes).unwrap();
        set(path, 1_700_000_001_000);
        let after = w.read(s, path)["Ok"].clone();
        assert_eq!(after["size"], before["size"], "{path}: same size");
        assert_ne!(after["mtime_ms"], before["mtime_ms"], "{path}");
    }
}

#[test]
fn files_content_wins_over_the_extension() {
    let f = Fixture::new();
    fs::write(f.proj.join("fake.png"), "just text").unwrap();
    fs::write(f.proj.join("fake.md"), [0u8, 1, 2]).unwrap();
    let mut w = Window::open(&f);
    assert_eq!(kind(&w.read(&f.session, "fake.png")), "text");
    assert_eq!(kind(&w.read(&f.session, "fake.md")), "binary");
}

#[test]
fn files_a_5_mb_file_returns_metadata_only() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let r = w.read(&f.session, "big.txt");
    assert_eq!(kind(&r), "text");
    assert_eq!(r["Ok"]["size"], 5 * 1024 * 1024);
    assert_eq!(r["Ok"]["too_large"], true);
    assert!(r["Ok"]["text"].is_null() && r["Ok"]["data"].is_null());
}

#[test]
fn files_list_flags_ignored_entries_and_git_status() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let l = w.list(&f.session, "");
    assert_eq!(entry(&l, "a.txt")["git"], "M");
    assert_eq!(entry(&l, "README.md")["git"], "?");
    assert_eq!(entry(&l, "ignored.log")["ignored"], true);
    assert_eq!(entry(&l, "build")["ignored"], true);
    assert_eq!(entry(&l, "build")["kind"], "dir");
    assert_eq!(entry(&l, "a.txt")["ignored"], false);
    assert_eq!(entry(&l, "a.txt")["size"], 14);
    assert!(entry(&l, "a.txt")["git"].is_string());
    assert!(entry(&l, "pic.png")["git"].is_string());
    // `.git` is internal.
    assert!(
        l["Ok"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["name"] != ".git")
    );
    // Ignore state reaches into folders.
    let inside = w.list(&f.session, "build");
    assert_eq!(entry(&inside, "out.txt")["ignored"], true);
    // A folder with changes beneath reports them.
    assert_eq!(entry(&l, "src")["git"], "?");
}

#[test]
fn files_list_outside_a_git_repository_has_no_status() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let l = w.list("data", "artifacts/s1");
    assert!(entry(&l, "note.md")["git"].is_null());
    assert_eq!(entry(&l, "note.md")["ignored"], false);
}

#[test]
fn files_search_honours_gitignore_and_returns_path_and_line() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    let hits = r["Ok"]["matches"]
        .as_array()
        .unwrap_or_else(|| panic!("{r}"));
    assert_eq!(hits.len(), 1, "{r}");
    assert_eq!(hits[0]["path"], "src/main.rs");
    assert_eq!(hits[0]["line"], 2);
    assert_eq!(hits[0]["text"], "// needle here");
    assert_eq!(r["Ok"]["truncated"], false);
}

#[test]
fn files_search_by_name_matches_paths_and_honours_gitignore() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    // Ticket 821: `names` matches the relative path, any case, and reads no file text.
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"MAIN","names":true}));
    let hits = r["Ok"]["matches"]
        .as_array()
        .unwrap_or_else(|| panic!("{r}"));
    assert_eq!(hits.len(), 1, "{r}");
    assert_eq!(hits[0]["path"], "src/main.rs");
    // Ignored files and folders, and a name only in text, are not listed.
    for q in ["ignored", "out.txt", "needle"] {
        let r = w.ask(json!({"op":"files_search","root":f.session,"query":q,"names":true}));
        assert_eq!(r["Ok"]["matches"], json!([]), "{q}: {r}");
    }
}

/// Names mode, round 2: one folder past the per-folder entry cap, or folders past the depth cap, stop the walk early
/// and say so (`truncated`), as the 200-match limit does. The query matches nothing, so only the caps can set it.
#[test]
fn files_search_by_name_stops_early_past_the_folder_and_depth_caps() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let ask = |w: &mut Window| {
        w.ask(json!({"op":"files_search","root":f.session,"query":"zz-none","names":true}))
    };
    assert_eq!(ask(&mut w)["Ok"]["truncated"], false);
    let deep = (0..40).fold(f.proj.join("d"), |p, i| p.join(i.to_string()));
    fs::create_dir_all(&deep).unwrap();
    let r = ask(&mut w);
    assert_eq!(r["Ok"]["truncated"], true, "depth: {r}");
    fs::remove_dir_all(f.proj.join("d")).unwrap();
    fs::create_dir_all(f.proj.join("big")).unwrap();
    for i in 0..5_001 {
        fs::write(f.proj.join(format!("big/f{i}")), "").unwrap();
    }
    let r = ask(&mut w);
    assert_eq!(r["Ok"]["truncated"], true, "folder: {r}");
}

/// Names mode fails closed: a folder whose `.gitignore` is not applied (over the size cap) is left out of the names
/// and reported, so an ignored file never shows because its rules were skipped.
#[test]
fn files_search_by_name_leaves_out_a_folder_whose_ignore_file_is_skipped() {
    let f = Fixture::new();
    fs::create_dir_all(f.proj.join("sub")).unwrap();
    fs::write(f.proj.join("sub/keep-me.txt"), "").unwrap();
    let mut w = Window::open(&f);
    let ask = |w: &mut Window| {
        w.ask(json!({"op":"files_search","root":f.session,"query":"keep-me","names":true}))
    };
    assert_eq!(ask(&mut w)["Ok"]["matches"][0]["path"], "sub/keep-me.txt");
    let lines: String = (0..10_000).map(|i| format!("pattern{i}/\n")).collect();
    fs::write(f.proj.join("sub/.gitignore"), lines).unwrap();
    let r = ask(&mut w);
    assert_eq!(r["Ok"]["matches"], json!([]), "{r}");
    assert_eq!(
        r["Ok"]["skipped_ignore_files"],
        json!(["sub/.gitignore"]),
        "{r}"
    );
}

/// Names mode ranks before it cuts to 200: the file named the query comes first although the walk reaches it last,
/// and folder-only matches never take the place of a name match.
#[test]
fn files_search_by_name_ranks_before_the_200_cap() {
    let f = Fixture::new();
    for d in ["approot", "src", "zzz"] {
        fs::create_dir_all(f.proj.join(d)).unwrap();
    }
    for i in 0..300 {
        fs::write(f.proj.join(format!("approot/x{i}.txt")), "").unwrap();
        fs::write(f.proj.join(format!("src/app{i}.rs")), "").unwrap();
    }
    fs::write(f.proj.join("zzz/app.rs"), "").unwrap();
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"app","names":true}));
    let hits = r["Ok"]["matches"]
        .as_array()
        .unwrap_or_else(|| panic!("{r}"));
    assert_eq!(hits.len(), 200, "{r}");
    assert_eq!(hits[0]["path"], "zzz/app.rs");
    assert!(
        hits.iter()
            .all(|h| !h["path"].as_str().unwrap().starts_with("approot/")),
        "{r}"
    );
    assert_eq!(r["Ok"]["truncated"], true);
}

#[test]
fn files_search_is_bounded() {
    let f = Fixture::new();
    for i in 0..300 {
        fs::write(f.proj.join(format!("many{i}.txt")), "needle\n").unwrap();
    }
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    assert_eq!(r["Ok"]["matches"].as_array().unwrap().len(), 200);
    assert_eq!(r["Ok"]["truncated"], true);
    refused(&w.ask(json!({"op":"files_search","root":f.session,"query":""})));
}

#[test]
fn files_search_does_not_follow_links_out() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":SECRET}));
    assert_eq!(r["Ok"]["matches"].as_array().unwrap().len(), 0, "{r}");
}

#[test]
fn files_data_root_serves_only_artifacts_and_images() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    assert_eq!(kind(&w.read("data", "artifacts/s1/note.md")), "markdown");
    assert_eq!(kind(&w.read("data", "images/x.png")), "image");
    for p in [
        "window.json",
        "sessions.json",
        "core.token",
        "../p/a.txt",
        "artifacts/evil",
    ] {
        refused(&w.read("data", p));
    }
    let top = w.list("data", "");
    let names: Vec<&str> = top["Ok"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["artifacts", "images"]);
    refused(&w.list("data", "queue"));
    refused(&w.ask(json!({"op":"files_search","root":"data","query":"x","path":""})));
}

#[test]
fn files_requests_write_nothing() {
    let f = Fixture::new();
    let snapshot = |p: &Path| -> Vec<(PathBuf, u64)> {
        let mut out = vec![];
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(d).unwrap().flatten() {
                let m = e.path().symlink_metadata().unwrap();
                if m.is_dir() {
                    stack.push(e.path());
                } else {
                    out.push((e.path(), m.len()));
                }
            }
        }
        out.sort();
        out
    };
    let before = snapshot(&f.proj);
    let git_index = fs::read(f.proj.join(".git/index")).unwrap();
    let mut w = Window::open(&f);
    w.list(&f.session, "");
    w.read(&f.session, "a.txt");
    w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    assert_eq!(snapshot(&f.proj), before);
    assert_eq!(fs::read(f.proj.join(".git/index")).unwrap(), git_index);
}

#[test]
fn files_a_wrong_origin_is_refused_before_any_file_request() {
    let f = Fixture::new();
    assert_eq!(f.dial("http://evil.example").err(), Some(403));
}

#[test]
fn files_a_non_core_token_cannot_reach_files() {
    // Interim guard from round 1, kept: an unknown token is refused at the socket gate.
    let f = Fixture::new();
    let r = f.socket_call(
        "not-the-core-token",
        json!({"op":"files_list","root":f.session,"path":""}),
    );
    assert_eq!(r, Err("unauthorized".to_string()));
}

/// A coordinator session (its token) that has started a worker, and the ids it could aim at: its own
/// session, its worker, a session of another project, and the data folder.
struct Coordinator {
    token: String,
    targets: Vec<String>,
}
fn coordinator(f: &Fixture) -> Coordinator {
    let (coordinator, token) = f.token_session(&f.proj);
    let started = f
        .socket_call(
            &token,
            json!({"op":"start","session":{"kind":"shell","project":f.proj,"args":["/bin/cat"]}}),
        )
        .expect("a coordinator may start a worker in its own project");
    let worker = started["session"]["id"].as_str().unwrap().to_string();
    let (foreign, _) = f.token_session(&f.other);
    // Control: the grants are live. The coordinator can read its worker, so the refusals below are
    // the file requests' own, not a dead token.
    f.socket_call(&token, json!({"op":"read","id":worker}))
        .expect("coordinator reads its own worker");
    Coordinator {
        token,
        targets: vec![coordinator, worker, foreign, "data".into()],
    }
}
/// Spec: no line gives agents file access. ADR 0001 "Agent CLI authority" lists what a session token
/// may do (start sessions; message or read the sessions it started; answer startup dialogs) and
/// spec-v1b B3 says "File access goes through the core" for the window, so the request stays
/// owner/window-only and `grants::request_target` is not widened.
fn refused_for_every_target(f: &Fixture, request: impl Fn(&str) -> Value, owner_ok: &str) {
    let c = coordinator(f);
    for root in &c.targets {
        let r = f.socket_call(&c.token, request(root));
        assert_eq!(
            r,
            Err("operation not granted".to_string()),
            "session token reached {root}"
        );
    }
    // Control: the same request is valid for the owner, so the refusal is the grant check.
    let own = request(&f.session);
    assert!(
        f.socket_call(&fs::read_to_string(f.home.join("core.token")).unwrap(), own)
            .is_ok(),
        "owner {owner_ok} failed"
    );
}

#[test]
fn files_session_token_is_refused_files_list() {
    let f = Fixture::new();
    refused_for_every_target(
        &f,
        |root| json!({"op":"files_list","root":root,"path":""}),
        "files_list",
    );
}

#[test]
fn files_session_token_is_refused_file_read() {
    let f = Fixture::new();
    refused_for_every_target(
        &f,
        |root| json!({"op":"file_read","root":root,"path":"a.txt"}),
        "file_read",
    );
}

#[test]
fn files_session_token_is_refused_files_search() {
    let f = Fixture::new();
    refused_for_every_target(
        &f,
        |root| json!({"op":"files_search","root":root,"query":"needle"}),
        "files_search",
    );
}

#[test]
fn files_korean_names_and_paths_work_in_list_read_and_search() {
    let f = Fixture::new();
    fs::create_dir_all(f.proj.join("한글 폴더")).unwrap();
    fs::write(
        f.proj.join("한글 폴더/눈치 파일.txt"),
        "첫 줄\n눈치 needle 찾기\n",
    )
    .unwrap();
    let mut w = Window::open(&f);
    let l = w.list(&f.session, "한글 폴더");
    assert_eq!(entry(&l, "눈치 파일.txt")["kind"], "file");
    let r = w.read(&f.session, "한글 폴더/눈치 파일.txt");
    assert_eq!(kind(&r), "text");
    assert_eq!(r["Ok"]["text"], "첫 줄\n눈치 needle 찾기\n");
    let hits = w.ask(json!({"op":"files_search","root":f.session,"query":"눈치"}));
    let hits = hits["Ok"]["matches"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0]["path"], "한글 폴더/눈치 파일.txt");
    assert_eq!(hits[0]["line"], 2);
    assert_eq!(hits[0]["text"], "눈치 needle 찾기");
    refused(&w.read(&f.session, "한글 폴더/../../o/secret.txt"));
}

#[test]
fn files_two_concurrent_searches_on_one_project_both_complete() {
    let f = Fixture::new();
    for i in 0..60 {
        fs::write(f.proj.join(format!("c{i}.txt")), "needle\nother\n").unwrap();
    }
    thread::scope(|s| {
        let run = |query: &'static str, want: usize| {
            let f = &f;
            s.spawn(move || {
                let mut w = Window::open(f);
                let r = w.ask(json!({"op":"files_search","root":f.session,"query":query}));
                assert_eq!(r["Ok"]["matches"].as_array().unwrap().len(), want, "{r}");
                assert_eq!(r["Ok"]["truncated"], false);
            })
        };
        let a = run("needle", 61); // 60 files plus src/main.rs
        let b = run("other", 60);
        a.join().unwrap();
        b.join().unwrap();
    });
}

/// `dirs` folders of `per` small files, none matching "needle": a search must walk all of it.
fn big_tree(f: &Fixture, dirs: usize, per: usize) {
    for d in 0..dirs {
        let dir = f.proj.join(format!("big/d{d}"));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..per {
            fs::write(dir.join(format!("f{i}.txt")), "nothing to see\n").unwrap();
        }
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

// v1a-14: held by a gate rather than timed, so host load cannot fail it.
#[cfg(target_os = "macos")]
#[test]
fn files_slow_search_does_not_delay_snapshot() {
    let shim = hold::Shim::build(&fixture("hold-search.c"));
    let f = Fixture::with_env(&[("DYLD_INSERT_LIBRARIES", shim.dylib.clone().into())]);
    fs::write(f.proj.join("held-search.txt"), "nothing to see\n").unwrap();
    thread::scope(|s| {
        let held = hold::Hold::new(f.home.join("hold-search"), "");
        let search = s.spawn(|| {
            let mut w = Window::open(&f);
            w.ask(json!({"op":"files_search","root":f.session,"query":"needle-absent"}))
        });
        hold::reached(
            &f.home.join("search-held"),
            "the search never reached the held file",
        );
        // The search is parked inside its walk; a registry it held would make this time out instead.
        let snapshot = call(&f.home, Request::Snapshot);
        assert!(
            matches!(snapshot, Ok(Reply::Snapshot { .. })),
            "{snapshot:?}"
        );
        assert!(!search.is_finished(), "the search must still be held");
        held.release();
        let found = search.join().unwrap();
        assert_eq!(found["Ok"]["matches"], json!([]), "{found}");
    });
}

// v1a-17: git is held by a gate rather than timed, so host load cannot fail it.
#[test]
fn files_list_does_not_hold_the_registry_while_git_runs() {
    let path = format!("{}:/usr/bin:/bin", fixture("hold-git").display());
    let f = Fixture::with_env(&[("PATH", path.into())]);
    thread::scope(|s| {
        let held = hold::Hold::new(f.home.join("hold-git"), "");
        let list = s.spawn(|| Window::open(&f).list(&f.session, ""));
        hold::reached(&f.home.join("git-held"), "files_list never ran git");
        // git is parked inside the listing; a registry it held would keep this waiting until git timed out.
        let snapshot = call(&f.home, Request::Snapshot);
        assert!(
            matches!(snapshot, Ok(Reply::Snapshot { .. })),
            "{snapshot:?}"
        );
        held.release();
        let listed = list.join().unwrap();
        // A status shows only when git ran to its end after the release, so it was still held for the snapshot.
        assert_eq!(entry(&listed, "a.txt")["git"], "M", "{listed}");
    });
}

// v1a-17: counted rather than timed. The search reads the file once as a hidden file to search; parsing it as
// an ignore file would be a second open.
#[cfg(target_os = "macos")]
#[test]
fn files_an_oversized_ignore_file_is_skipped_reported_and_cannot_stall_the_core() {
    let shim = hold::Shim::build(&fixture("hold-open.c"));
    let f = Fixture::with_env(&[("DYLD_INSERT_LIBRARIES", shim.dylib.clone().into())]);
    let lines: String = (0..300_000).map(|i| format!("pattern{i}/\n")).collect();
    fs::write(f.proj.join(".gitignore"), lines).unwrap();
    fs::write(f.home.join("hold-suffix"), "/.gitignore").unwrap();
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    assert_eq!(
        fs::read(f.home.join("opened")).unwrap().len(),
        1,
        "the oversized ignore file was opened to be parsed"
    );
    assert_eq!(
        r["Ok"]["skipped_ignore_files"],
        json!([".gitignore"]),
        "{r}"
    );
    // Its rules were not applied, so previously ignored files now show up.
    let paths: Vec<&str> = r["Ok"]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"ignored.log"), "{paths:?}");
    assert!(matches!(
        call(&f.home, Request::Snapshot),
        Ok(Reply::Snapshot { .. })
    ));
}

#[test]
fn files_concurrent_searches_are_bounded() {
    let f = Fixture::new();
    big_tree(&f, 400, 100);
    let results: Vec<Value> = thread::scope(|s| {
        let all: Vec<_> = (0..8)
            .map(|_| {
                s.spawn(|| {
                    let mut w = Window::open(&f);
                    w.ask(json!({"op":"files_search","root":f.session,"query":"needle-absent"}))
                })
            })
            .collect();
        all.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let busy = results
        .iter()
        .filter(|r| r["Err"].as_str().is_some_and(|e| e.contains("busy")))
        .count();
    assert!(busy >= 1, "8 simultaneous searches all ran: {results:?}");
    assert!(
        results.iter().any(|r| r["Ok"].is_object()),
        "none completed"
    );
}

#[test]
fn files_search_includes_hidden_files_but_never_git() {
    let f = Fixture::new();
    fs::create_dir_all(f.proj.join(".hidden")).unwrap();
    fs::write(f.proj.join(".hidden/x.txt"), "a needle in a dotfolder\n").unwrap();
    fs::write(f.proj.join(".env.sample"), "needle=1\n").unwrap();
    fs::create_dir_all(f.proj.join("src/.git")).unwrap();
    fs::write(f.proj.join("src/.git/config"), "url = needle-token\n").unwrap();
    let mut cfg = fs::read(f.proj.join(".git/config")).unwrap();
    cfg.extend(b"\n# needle-token\n");
    fs::write(f.proj.join(".git/config"), cfg).unwrap();
    let mut w = Window::open(&f);
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    let mut paths: Vec<&str> = r["Ok"]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["path"].as_str().unwrap())
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        [".env.sample", ".hidden/x.txt", "src/main.rs"],
        "{r}"
    );
    // `.gitignore` still applies to hidden files.
    fs::write(f.proj.join(".gitignore"), ".env.sample\n").unwrap();
    let r = w.ask(json!({"op":"files_search","root":f.session,"query":"needle"}));
    assert!(
        r["Ok"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["path"] != ".env.sample")
    );
}

#[test]
fn files_git_folder_is_refused_at_any_depth() {
    let f = Fixture::new();
    fs::create_dir_all(f.proj.join("src/.git")).unwrap();
    fs::write(f.proj.join("src/.git/config"), "x").unwrap();
    symlink(f.proj.join(".git/config"), f.proj.join("link_git")).unwrap();
    let mut w = Window::open(&f);
    for p in [
        ".git/config",
        ".GIT/config",
        "src/.git/config",
        "./.git/HEAD",
        "link_git",
    ] {
        refused(&w.read(&f.session, p));
    }
    refused(&w.list(&f.session, ".git"));
    refused(&w.ask(json!({"op":"files_search","root":f.session,"query":"url","path":".git"})));
}

fn sha256(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}
/// Ticket 820: a save with the hash `file_read` returned.
fn save(w: &mut Window, root: &str, path: &str, text: &str, hash: &Value) -> Value {
    w.ask(json!({"op":"file_write","root":root,"path":path,"text":text,"hash":hash}))
}

#[test]
fn files_write_inside_the_root_replaces_the_text_and_keeps_the_mode() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let mut w = Window::open(&f);
    fs::set_permissions(
        f.proj.join("src/main.rs"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let read = w.read(&f.session, "src/main.rs");
    let r = save(
        &mut w,
        &f.session,
        "src/main.rs",
        "fn main() { saved() }\n",
        &read["Ok"]["hash"],
    );
    assert_eq!(r["Ok"]["text"], "fn main() { saved() }\n", "{r}");
    assert_ne!(r["Ok"]["hash"], read["Ok"]["hash"]);
    assert_eq!(
        fs::read_to_string(f.proj.join("src/main.rs")).unwrap(),
        "fn main() { saved() }\n"
    );
    let mode = fs::metadata(f.proj.join("src/main.rs"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o640);
    // No temp file is left in the folder.
    let names: Vec<_> = fs::read_dir(f.proj.join("src"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    // A link inside the root is written at its target and stays a link.
    let read = w.read(&f.session, "link_in");
    assert!(
        save(
            &mut w,
            &f.session,
            "link_in",
            "via link\n",
            &read["Ok"]["hash"]
        )["Ok"]
            .is_object()
    );
    assert!(
        fs::symlink_metadata(f.proj.join("link_in"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(f.proj.join("a.txt")).unwrap(),
        "via link\n"
    );
}

#[test]
fn files_write_outside_the_root_is_refused() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let any = json!("0");
    let abs = f.proj.join("../o/secret.txt");
    for p in [
        "../o/secret.txt",
        "src/../../o/secret.txt",
        "/etc/hosts",
        abs.to_str().unwrap(),
        ".git/config",
        "..",
    ] {
        refused(&save(&mut w, &f.session, p, "x", &any));
    }
    // The data root and a folder are never written.
    refused(&save(&mut w, "data", "artifacts/s1/note.md", "x", &any));
    refused(&save(&mut w, &f.session, "src", "x", &any));
    assert_eq!(
        fs::read_to_string(f.proj.join("../o/secret.txt")).unwrap(),
        SECRET
    );
    assert_eq!(
        fs::read_to_string(f.home.join("artifacts/s1/note.md")).unwrap(),
        "# note"
    );
}

#[test]
fn files_write_through_a_link_out_is_refused() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let hash = json!(sha256(SECRET.as_bytes()));
    for p in ["link_out", "link_dir_out/secret.txt"] {
        assert_eq!(
            save(&mut w, &f.session, p, "x", &hash)["Err"],
            "outside root"
        );
    }
    assert_eq!(
        fs::read_to_string(f.proj.join("../o/secret.txt")).unwrap(),
        SECRET
    );
}

#[test]
fn files_write_refuses_a_file_changed_on_disk_and_binary_or_large_files() {
    let f = Fixture::new();
    let mut w = Window::open(&f);
    let read = w.read(&f.session, "README.md");
    fs::write(f.proj.join("README.md"), "# changed by an agent\n").unwrap();
    let r = save(
        &mut w,
        &f.session,
        "README.md",
        "# mine\n",
        &read["Ok"]["hash"],
    );
    assert_eq!(
        r["Err"],
        "the file changed on disk since it was opened; nothing was saved"
    );
    assert_eq!(
        fs::read_to_string(f.proj.join("README.md")).unwrap(),
        "# changed by an agent\n"
    );
    let any = json!("0");
    assert_eq!(
        save(&mut w, &f.session, "blob.bin", "x", &any)["Err"],
        "not a text file; it is not edited here"
    );
    assert_eq!(
        save(&mut w, &f.session, "big.txt", "x", &any)["Err"],
        "file is over 512 KiB; it is not edited here"
    );
    let read = w.read(&f.session, "a.txt");
    let big = "x".repeat(512 * 1024 + 1);
    assert_eq!(
        save(&mut w, &f.session, "a.txt", &big, &read["Ok"]["hash"])["Err"],
        "the text is over 512 KiB; nothing was saved"
    );
}

#[test]
fn files_session_token_is_refused_file_write() {
    let f = Fixture::new();
    let before = fs::read(f.proj.join("a.txt")).unwrap();
    let hash = sha256(&before);
    refused_for_every_target(
        &f,
        |root| json!({"op":"file_write","root":root,"path":"a.txt","text":"hello changed\n","hash":hash}),
        "file_write",
    );
}
