//! Diff through a running core: the start commit is recorded when a session starts, and the window
//! asks for it (spec B3 Diff, Acceptance 10; ticket 11). Needs `target/debug/nunchiro` built.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";

struct Core {
    top: PathBuf,
    home: PathBuf,
    process: Child,
}
impl Core {
    fn top() -> PathBuf {
        let top = home::short("ds");
        fs::create_dir_all(top.join("h")).unwrap();
        top
    }
    fn start(top: PathBuf) -> Self {
        let home = top.join("h");
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // The guard first: a readiness timeout below must still stop the daemon.
        let core = Self { top, home, process };
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
        core
    }
    fn session(&self, project: &Path, args: &[&str]) -> String {
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
                    label: "diff".into(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        session.id
    }
    fn window(&self) -> Window {
        let v: Value =
            serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", v["port"])
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
        Window {
            ws: tungstenite::connect(req).unwrap().0,
            next: 0,
        }
    }
    /// One request over the unix socket with an explicit token.
    fn socket_call(&self, token: &str, request: Value) -> Value {
        use std::io::{BufRead, BufReader, Write};
        let mut s = std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn output(&self, id: &str, prefix: &str) -> String {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Ok(Reply::Output { data, .. }) = call(
                &self.home,
                Request::Read {
                    id: id.into(),
                    after: 0,
                },
            ) else {
                panic!()
            };
            // The first line starts with the holder's size mark (ticket 995).
            if let Some((_, l)) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once(prefix))
            {
                return l.trim().to_string();
            }
            assert!(Instant::now() < until, "no {prefix} line");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.top);
    }
}

struct Window {
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    next: u64,
}
impl Window {
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
    fn list(&mut self, session: &str) -> Value {
        self.ask(json!({"op":"diff_list","session":session}))
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = home::git_env::scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(["-c", "gc.auto=0", "-c", "maintenance.auto=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}
fn repo(top: &Path) -> PathBuf {
    let p = top.join("p");
    fs::create_dir_all(&p).unwrap();
    git(&p, &["init", "-q"]);
    fs::write(p.join("a.txt"), "a\n").unwrap();
    git(&p, &["add", "-A"]);
    git(&p, &["commit", "-q", "-m", "init"]);
    p
}
fn paths(v: &Value) -> Vec<String> {
    v["Ok"]["files"]
        .as_array()
        .unwrap_or_else(|| panic!("no files: {v}"))
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn diff_the_start_commit_is_recorded_when_a_session_starts() {
    let core = Core::start(Core::top());
    let p = repo(&core.top);
    let start = git(&p, &["rev-parse", "HEAD"]);
    let id = core.session(&p, &["/bin/cat"]);
    let record = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(record.contains(&start), "start commit not persisted");
    fs::write(p.join("a.txt"), "changed and committed\n").unwrap();
    git(&p, &["commit", "-q", "-am", "after start"]);
    fs::write(p.join("new.txt"), "n\n").unwrap();
    let v = core.window().list(&id);
    assert_eq!(v["Ok"]["base"], json!({"kind":"commit","sha":start}));
    assert_eq!(paths(&v), ["a.txt", "new.txt"]);
    let f = core
        .window()
        .ask(json!({"op":"diff_file","session":id,"path":"a.txt"}));
    assert!(
        f["Ok"]["patch"]
            .as_str()
            .unwrap()
            .contains("+changed and committed")
    );
}

#[test]
fn diff_a_session_in_a_non_git_folder_shows_the_empty_state() {
    let core = Core::start(Core::top());
    let p = core.top.join("plain");
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join("x.txt"), "x").unwrap();
    let id = core.session(&p, &["/bin/cat"]);
    let v = core.window().list(&id);
    assert_eq!(v["Ok"]["base"], json!({"kind":"not_git"}), "{v}");
    assert_eq!(v["Ok"]["files"], json!([]));
}

#[test]
fn diff_a_session_record_from_before_v1b_11_shows_start_commit_unknown() {
    let top = Core::top();
    let p = repo(&top);
    fs::write(p.join("a.txt"), "changed\n").unwrap();
    let legacy = json!({"version":1,"sessions":[{
        "id":"legacy-1","kind":"shell","project":p,"cwd":p,"label":"old","state":"exited",
        "agent_session_id":null,"agent_version":null,"untested":false,"pid":null}]});
    fs::write(top.join("h/sessions.json"), legacy.to_string()).unwrap();
    let core = Core::start(top);
    let v = core.window().list("legacy-1");
    assert_eq!(v["Ok"]["base"], Value::Null, "{v}");
    assert_eq!(v["Ok"]["files"], json!([]));
}

#[test]
fn diff_a_session_token_is_refused() {
    let core = Core::start(Core::top());
    let p = repo(&core.top);
    let id = core.session(
        &p,
        &[
            "/bin/sh",
            "-c",
            "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat",
        ],
    );
    let token = core.output(&id, "TOKEN:");
    for request in [
        json!({"op":"diff_list","session":id}),
        json!({"op":"diff_file","session":id,"path":"a.txt"}),
    ] {
        let r = core.socket_call(&token, request);
        assert!(r["Err"].is_string(), "not refused: {r}");
    }
}

#[test]
fn diff_two_windows_viewing_the_same_diff_both_get_it() {
    let core = Core::start(Core::top());
    let p = repo(&core.top);
    let id = core.session(&p, &["/bin/cat"]);
    fs::write(p.join("a.txt"), "changed\n").unwrap();
    let lists: Vec<Value> = thread::scope(|s| {
        let a = s.spawn(|| core.window().list(&id));
        let b = s.spawn(|| core.window().list(&id));
        vec![a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(paths(&lists[0]), ["a.txt"]);
    assert_eq!(lists[0], lists[1]);
}
