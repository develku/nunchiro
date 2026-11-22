//! V2-9a (core): `tree.toml`, the project groups, pins and fold state the core stores and serves to the window.
//! Real cores over their socket and the window's WebSocket; fake shell and Claude sessions only. Tests compare
//! tokens and never print them.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ORIGIN: &str = "http://127.0.0.1:4173";
const DENIED: &str = "operation not granted";

struct Core {
    home: PathBuf,
    process: Option<Child>,
}
impl Core {
    fn new() -> Self {
        let home = home::short("tree");
        fs::create_dir_all(home.join("bin")).unwrap();
        // Fake Claude: answers --version, then idles as the agent.
        let claude = home.join("bin/claude");
        fs::write(
            &claude,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nexec sleep 300\n",
        )
        .unwrap();
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
        let mut core = Self {
            home,
            process: None,
        };
        core.start();
        core
    }
    /// A home with `tree.toml` already written, for the files a hand edit or an older core leaves.
    fn with_file(bytes: &str) -> Self {
        Self::with_files(&[("tree.toml", bytes)])
    }
    fn with_files(files: &[(&str, &str)]) -> Self {
        let mut core = Self::new();
        core.stop();
        for (name, bytes) in files {
            fs::write(core.home.join(name), bytes).unwrap();
        }
        core.start();
        core
    }
    fn start(&mut self) {
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &self.home)
            .env("CLAUDE_CONFIG_DIR", self.home.join("claude-home"))
            .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .env("NUNCHIRO_SSH", "/usr/bin/false")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        self.process = Some(process);
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join("window.json").exists()
            || self.owner(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot"
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = self.owner(json!({"op":"stop"}));
            let until = Instant::now() + Duration::from_secs(10);
            while process.try_wait().ok().flatten().is_none() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = process.kill();
            let _ = process.wait();
            let _ = fs::remove_file(self.home.join("window.json"));
        }
    }
    fn restart(&mut self) {
        self.stop();
        self.start();
    }
    fn owner_token(&self) -> String {
        fs::read_to_string(self.home.join("core.token")).unwrap_or_default()
    }
    fn raw(&self, token: &str, request: Value) -> Value {
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let line = format!("{}\n", json!({"token": token, "request": request}));
        if s.write_all(line.as_bytes()).is_err() {
            return Value::Null;
        }
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(Value::Null)
    }
    fn owner(&self, request: Value) -> Value {
        self.raw(&self.owner_token(), request)
    }
    /// A project folder under the home with one idle shell session in it; returns the project path.
    fn project(&self, name: &str) -> String {
        let dir = self.home.join(name);
        fs::create_dir_all(&dir).unwrap();
        let r = self.owner(json!({"op":"start","session":{
            "kind":"shell","project":dir,"label":name,"args":["/bin/sh","-c","sleep 300"]}}));
        assert_eq!(r["Ok"]["type"], "started", "{r}");
        dir.to_str().unwrap().to_string()
    }
    fn tree_path(&self) -> PathBuf {
        self.home.join("tree.toml")
    }
    fn get(&self) -> Value {
        self.owner(json!({"op":"tree_get"}))
    }
    fn edit(&self, edit: Value) -> Value {
        self.owner(json!({"op":"tree_edit","edit":edit}))
    }
    /// The tree of a successful reply, else the test fails with the reply.
    fn tree(&self, reply: Value) -> Value {
        assert_eq!(reply["Ok"]["type"], "tree", "{reply}");
        reply["Ok"]["tree"].clone()
    }
    fn ws(&self) -> tungstenite::WebSocket<TcpStream> {
        let window = self.owner(json!({"op":"window_auth"}));
        let port = window["Ok"]["port"].as_u64().unwrap() as u16;
        let token = window["Ok"]["token"].as_str().unwrap();
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(ORIGIN).unwrap());
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        tungstenite::client(req, stream).expect("authorized dial").0
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stop();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}
fn window_call(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64, request: Value) -> Value {
    ws.send(Message::Text(
        json!({"id": id, "request": request}).to_string().into(),
    ))
    .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < until, "no reply for {id}");
        if let Message::Text(t) = ws.read().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}
fn bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}
fn group(name: &str, projects: &[&str]) -> Value {
    json!({"name": name, "projects": projects})
}
/// The member lists sorted: the tree orders members by urgency, so their array order is not part of the contract.
fn sorted(mut tree: Value) -> Value {
    for g in tree["groups"].as_array_mut().unwrap() {
        g["projects"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(|p| p.as_str().unwrap().to_string());
    }
    tree
}

#[test]
fn tree_round_trip() {
    let mut core = Core::new();
    let (p1, p2) = (core.project("p1"), core.project("p2"));
    core.tree(core.edit(json!({"op":"group_create","name":"업무","project":p1})));
    core.tree(core.edit(json!({"op":"group_create","name":"B","project":p2})));
    core.tree(core.edit(json!({"op":"pin","project":p1,"pinned":true})));
    core.tree(core.edit(json!({"op":"fold","key":"group:업무","folded":true})));
    core.tree(core.edit(json!({"op":"fold","key":"quiet:","folded":true})));
    let written = core.tree(core.edit(json!({"op":"group_rename","from":"B","to":"C"})));
    assert_eq!(
        written,
        json!({
            "groups": [group("업무", &[&p1]), group("C", &[&p2])],
            "pins": [p1],
            "folded": ["group:업무", "quiet:"],
        })
    );
    assert_eq!(
        fs::metadata(core.tree_path()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let file = String::from_utf8(bytes(&core.tree_path())).unwrap();
    assert!(
        file.contains("version = 1") && file.contains("업무"),
        "{file}"
    );
    core.restart();
    assert_eq!(core.tree(core.get()), written);
}

#[test]
fn tree_unknown_version_set_aside_never_overwritten() {
    let original = "version = 2\n[[groups]]\nname = \"업무\"\nprojects = [\"/x\"]\n";
    let core = Core::with_file(original);
    assert_eq!(
        core.tree(core.get()),
        json!({"groups": [], "pins": [], "folded": []})
    );
    assert!(
        !core.tree_path().exists(),
        "the version 2 file was left in place"
    );
    let asides = |home: &Path| -> Vec<PathBuf> {
        fs::read_dir(home)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().unwrap().to_string_lossy().into_owned();
                n.starts_with("tree.toml.v2.") && n.ends_with(".aside")
            })
            .collect()
    };
    let kept = asides(&core.home);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(bytes(&kept[0]), original.as_bytes());
    // A later edit writes version 1; the aside copy stays byte-identical.
    let p1 = core.project("p1");
    core.tree(core.edit(json!({"op":"pin","project":p1,"pinned":true})));
    assert!(
        String::from_utf8(bytes(&core.tree_path()))
            .unwrap()
            .contains("version = 1")
    );
    assert_eq!(asides(&core.home), kept);
    assert_eq!(bytes(&kept[0]), original.as_bytes());
}

#[test]
fn tree_malformed_file_is_untouched() {
    let cases = [
        "this is = [not toml",
        "version = 1\nbogus = 1\n",
        "version = 1\n[[groups]]\nname = \"a\"\nprojects = []\nextra = true\n",
        "version = 1\n[[groups]]\nname = \"a\"\nprojects = [\"/x\"]\n[[groups]]\nname = \"a\"\nprojects = [\"/y\"]\n",
        "version = 1\n[[groups]]\nname = \"a\"\nprojects = [\"/x\"]\n[[groups]]\nname = \"b\"\nprojects = [\"/x\"]\n",
        "version = \"1\"\n",
        "groups = []\n",
        "version = 1\ngroups = \"x\"\n",
        "version = 1\n[groups]\nname = \"a\"\n",
        "version = 1\npins = \"x\"\n",
        "version = 1\npins = [3]\n",
    ];
    for case in cases {
        let core = Core::with_file(case);
        let p1 = core.project("p1");
        for reply in [
            core.get(),
            core.edit(json!({"op":"pin","project":p1,"pinned":true})),
            core.edit(json!({"op":"group_create","name":"g","project":p1})),
        ] {
            assert!(reply["Err"].is_string(), "{case:?}: {reply}");
        }
        assert_eq!(bytes(&core.tree_path()), case.as_bytes(), "{case:?}");
    }
    // A symlinked tree.toml is refused and not followed: the target stays as it was, the link stays a link.
    let mut core = Core::new();
    core.stop();
    let target = core.home.join("elsewhere.toml");
    let body = "version = 1\npins = [\"/x\"]\n";
    fs::write(&target, body).unwrap();
    symlink(&target, core.tree_path()).unwrap();
    core.start();
    let p1 = core.project("p1");
    assert!(core.get()["Err"].is_string());
    assert!(core.edit(json!({"op":"pin","project":p1,"pinned":true}))["Err"].is_string());
    assert!(
        fs::symlink_metadata(core.tree_path())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(bytes(&target), body.as_bytes());
}

#[test]
fn tree_project_in_two_groups_refused() {
    let core = Core::new();
    let (p1, p2) = (core.project("p1"), core.project("p2"));
    core.tree(core.edit(json!({"op":"group_create","name":"A","project":p1})));
    core.tree(core.edit(json!({"op":"group_create","name":"X","project":p2})));
    core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A"})));
    // A group born with an already grouped project takes it from the old group (never two).
    let tree = core.tree(core.edit(json!({"op":"group_create","name":"B","project":p1})));
    assert_eq!(
        sorted(tree)["groups"],
        json!([group("A", &[&p2]), group("B", &[&p1])])
    );
    // Moving into a second group moves; the emptied group is gone.
    let tree = core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"A"})));
    let mut both = [p1.as_str(), p2.as_str()];
    both.sort();
    assert_eq!(sorted(tree)["groups"], json!([group("A", &both)]));
    // None ungroups; an unknown group is refused and changes nothing.
    let before = bytes(&core.tree_path());
    let reply = core.edit(json!({"op":"project_move","project":p1,"group":"nope"}));
    assert!(reply["Err"].is_string(), "{reply}");
    assert_eq!(bytes(&core.tree_path()), before);
    let tree = core.tree(core.edit(json!({"op":"project_move","project":p1,"group":null})));
    assert_eq!(tree["groups"], json!([group("A", &[&p2])]));
    // Dissolving frees the members.
    let tree = core.tree(core.edit(json!({"op":"group_dissolve","name":"A"})));
    assert_eq!(tree["groups"], json!([]));
    assert!(core.edit(json!({"op":"group_dissolve","name":"A"}))["Err"].is_string());
}

#[test]
fn tree_removed_project_drops_out() {
    let mut core = Core::new();
    let (p1, p2) = (core.project("p1"), core.project("p2"));
    core.tree(core.edit(json!({"op":"group_create","name":"gone","project":p1})));
    core.tree(core.edit(json!({"op":"pin","project":p1,"pinned":true})));
    core.tree(core.edit(json!({"op":"group_create","name":"kept","project":p2})));
    core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"kept"})));
    core.tree(core.edit(json!({"op":"group_create","name":"solo","project":p1})));
    // Close p1's session (the core holds no more process), stop, and drop its row from sessions.json.
    let list = core.owner(json!({"op":"list"}));
    for s in list["Ok"]["sessions"].as_array().unwrap() {
        if s["project"] == p1 {
            let id = s["id"].as_str().unwrap();
            assert_eq!(
                core.owner(json!({"op":"close","id":id}))["Ok"]["type"],
                "ack"
            );
        }
    }
    // Remove from tree un-adds it last (closing its last session filed it as added, Q9 en-b-J6-1).
    core.tree(core.edit(json!({"op":"add","project":p1,"added":false})));
    core.stop();
    let path = core.home.join("sessions.json");
    let mut store: Value = serde_json::from_slice(&bytes(&path)).unwrap();
    store["sessions"]
        .as_array_mut()
        .unwrap()
        .retain(|s| s["project"] != p1.as_str());
    store.as_object_mut().unwrap().remove("live");
    fs::write(&path, store.to_string()).unwrap();
    core.start();
    // Out of its group and of pins at start; the emptied group is gone; the file is not rewritten until an edit.
    assert_eq!(
        core.tree(core.get()),
        json!({"groups": [group("kept", &[&p2])], "pins": [], "folded": []})
    );
    let on_disk = String::from_utf8(bytes(&core.tree_path())).unwrap();
    assert!(
        on_disk.contains("solo") && on_disk.contains(&p1),
        "{on_disk}"
    );
    core.tree(core.edit(json!({"op":"fold","key":"group:kept","folded":true})));
    let on_disk = String::from_utf8(bytes(&core.tree_path())).unwrap();
    assert!(
        !on_disk.contains("solo") && !on_disk.contains(&p1),
        "{on_disk}"
    );
}

// Q9 en-b-J6-1: closing the last (ended) session of a pinned, grouped, named project leaves its row out of the
// store at once (close_later); the next edit and the next start still keep its pin, group and name.
#[test]
fn tree_filed_project_keeps_its_place_after_last_close() {
    let mut core = Core::new();
    let dir = core.home.join("p1");
    fs::create_dir_all(&dir).unwrap();
    let r = core.owner(json!({"op":"start","session":{
        "kind":"shell","project":dir,"label":"p1","args":["/bin/sh","-c","exit 0"]}}));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let id = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    let p = dir.to_str().unwrap().to_string();
    let until = Instant::now() + Duration::from_secs(10);
    while core.owner(json!({"op":"list"}))["Ok"]["sessions"][0]["state"] == "running" {
        assert!(Instant::now() < until, "shell did not end");
        thread::sleep(Duration::from_millis(20));
    }
    core.tree(core.edit(json!({"op":"group_create","name":"g","project":p})));
    core.tree(core.edit(json!({"op":"pin","project":p,"pinned":true})));
    core.tree(core.edit(json!({"op":"project_name","project":p,"name":"Mine"})));
    assert_eq!(
        core.owner(json!({"op":"close","id":id}))["Ok"]["type"],
        "ack"
    );
    let placed = |tree: &Value| {
        assert_eq!(tree["groups"], json!([group("g", &[&p])]), "{tree}");
        assert_eq!(tree["pins"], json!([p]), "{tree}");
        assert_eq!(tree["names"][&p], "Mine", "{tree}");
    };
    placed(&core.tree(core.edit(json!({"op":"fold","key":"group:g","folded":true}))));
    core.restart();
    placed(&core.tree(core.get()));
}

#[test]
fn tree_never_hides_a_waiting_item() {
    let core = Core::new();
    let dir = core.home.join("agent");
    fs::create_dir_all(&dir).unwrap();
    let r = core.owner(
        json!({"op":"start","session":{"kind":"claude","project":dir,"label":"a","args":[]}}),
    );
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let (id, project) = (
        r["Ok"]["session"]["id"].as_str().unwrap().to_string(),
        dir.to_str().unwrap().to_string(),
    );
    core.tree(core.edit(json!({"op":"group_create","name":"업무","project":project})));
    core.tree(core.edit(json!({"op":"fold","key":"group:업무","folded":true})));
    let hook = core.owner(json!({"op":"hook","id":id,"event":"PermissionRequest",
        "payload":{"tool_name":"Bash","tool_input":{"command":"touch forbidden"}}}));
    assert!(hook["Ok"].is_object(), "{hook}");
    let waiting = |core: &Core| -> Value {
        let snap = core.owner(json!({"op":"snapshot"}));
        let s = snap["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id.as_str())
            .unwrap()
            .clone();
        json!({"pending": s["pending"], "owner": snap["Ok"]["owner_decisions"]})
    };
    let before = waiting(&core);
    assert!(
        before["pending"].as_array().is_some_and(|p| !p.is_empty()),
        "the request did not raise a waiting item: {before}"
    );
    // The item is the same with the group folded, unfolded, renamed, dissolved and the project pinned.
    for edit in [
        json!({"op":"fold","key":"group:업무","folded":false}),
        json!({"op":"fold_set","folded":["group:업무","quiet:업무","quiet:"]}),
        json!({"op":"pin","project":project,"pinned":true}),
        json!({"op":"group_rename","from":"업무","to":"다른"}),
        json!({"op":"group_dissolve","name":"다른"}),
    ] {
        core.tree(core.edit(edit));
        assert_eq!(waiting(&core), before);
    }
}

#[test]
fn tree_requests_owner_only() {
    let core = Core::new();
    // A session agent's token: a shell session writes its own NUNCHIRO_TOKEN out.
    let dir = core.home.join("agent");
    fs::create_dir_all(&dir).unwrap();
    let script = core.home.join("token.sh");
    fs::write(
        &script,
        format!(
            "printf %s \"$NUNCHIRO_TOKEN\" > '{0}/tok.tmp'; mv '{0}/tok.tmp' '{0}/tok'; sleep 300\n",
            core.home.display()
        ),
    )
    .unwrap();
    let r = core.owner(json!({"op":"start","session":{
        "kind":"shell","project":dir,"label":"s","args":["/bin/sh", script]}}));
    assert_eq!(r["Ok"]["type"], "started", "{r}");
    let until = Instant::now() + Duration::from_secs(30);
    while !core.home.join("tok").exists() {
        assert!(Instant::now() < until, "the session never wrote its token");
        thread::sleep(Duration::from_millis(50));
    }
    let token = fs::read_to_string(core.home.join("tok")).unwrap();
    let project = dir.to_str().unwrap().to_string();
    for request in [
        json!({"op":"tree_get"}),
        json!({"op":"tree_edit","edit":{"op":"pin","project":project,"pinned":true}}),
        json!({"op":"tree_edit","edit":{"op":"group_create","name":"x","project":project}}),
        json!({"op":"tree_edit","edit":{"op":"fold","key":"group:x","folded":true}}),
    ] {
        let reply = core.raw(token.trim(), request);
        assert_eq!(reply["Err"], DENIED, "a session token reached the tree");
    }
    assert!(!core.tree_path().exists(), "a refused edit wrote the file");
    // The owner and the window work.
    core.tree(core.edit(json!({"op":"pin","project":project,"pinned":true})));
    let mut ws = core.ws();
    let reply = window_call(&mut ws, 1, json!({"op":"tree_get"}));
    assert_eq!(
        core.tree(json!({"Ok": reply["Ok"].clone()}))["pins"],
        json!([project])
    );
    let reply = window_call(
        &mut ws,
        2,
        json!({"op":"tree_edit","edit":{"op":"fold","key":"quiet:","folded":true}}),
    );
    assert_eq!(reply["Ok"]["tree"]["folded"], json!(["quiet:"]));
}

#[test]
fn tree_names_and_paths_validated() {
    use nunchiro_core::tree::{Tree, TreeEdit};
    let core = Core::new();
    let p1 = core.project("p1");
    let first = core.tree(core.edit(json!({"op":"group_create","name":"업무","project":p1})));
    let before = bytes(&core.tree_path());
    let long_path = format!("/{}", "a".repeat(4096));
    let bad = [
        json!({"op":"group_create","name":"","project":p1}),
        json!({"op":"group_create","name":"   ","project":p1}),
        json!({"op":"group_create","name":"가".repeat(65),"project":p1}),
        json!({"op":"group_create","name":"a\u{7}b","project":p1}),
        json!({"op":"group_create","name":"a\nb","project":p1}),
        json!({"op":"group_create","name":"업무","project":p1}),
        json!({"op":"group_rename","from":"업무","to":""}),
        json!({"op":"group_create","name":"new","project":"relative/path"}),
        json!({"op":"group_create","name":"new","project":""}),
        json!({"op":"group_create","name":"new","project":"/a\u{0}b"}),
        json!({"op":"group_create","name":"new","project":long_path}),
        json!({"op":"pin","project":"../x","pinned":true}),
        json!({"op":"fold","key":"nope","folded":true}),
        json!({"op":"fold","key":format!("group:{}", "x".repeat(600)),"folded":true}),
        json!({"op":"fold_set","folded":["group:a", "bad\u{1}"]}),
    ];
    for edit in bad {
        let reply = core.edit(edit.clone());
        assert!(reply["Err"].is_string(), "{edit}: {reply}");
        assert_eq!(bytes(&core.tree_path()), before, "{edit}");
        assert_eq!(core.tree(core.get()), first, "{edit}");
    }
    // Exactly 64 characters and exactly 4096 bytes are accepted (the project needs a session to stay in the tree,
    // so the path limit is checked on the module below).
    core.tree(core.edit(json!({"op":"group_rename","from":"업무","to":"가".repeat(64)})));
    let file = String::from_utf8(bytes(&core.tree_path())).unwrap();
    assert!(file.contains(&"가".repeat(64)));
    // The module never stats a project path: a folder that does not exist is accepted as long as a session names it.
    let known = BTreeSet::from([
        "/no/such/folder/ever".to_string(),
        format!("/{}", "a".repeat(4095)),
    ]);
    let tree = Tree::default()
        .edited(
            &TreeEdit::GroupCreate {
                name: "x".into(),
                project: "/no/such/folder/ever".into(),
            },
            Some(&known),
        )
        .unwrap();
    assert_eq!(tree.groups[0].projects, ["/no/such/folder/ever"]);
    Tree::default()
        .edited(
            &TreeEdit::Pin {
                project: format!("/{}", "a".repeat(4095)),
                pinned: true,
            },
            Some(&known),
        )
        .unwrap();
}

#[test]
fn tree_edit_is_atomic() {
    let core = Core::new();
    let (p1, p2) = (core.project("p1"), core.project("p2"));
    // A successful edit is on disk before the reply returns.
    let tree = core.tree(core.edit(json!({"op":"group_create","name":"a","project":p1})));
    let disk: toml::Value =
        toml::from_str(&String::from_utf8(bytes(&core.tree_path())).unwrap()).unwrap();
    assert_eq!(disk["version"].as_integer(), Some(1));
    assert_eq!(disk["groups"][0]["name"].as_str(), Some("a"));
    assert_eq!(disk["groups"][0]["projects"][0].as_str(), Some(p1.as_str()));
    // A failing edit that would otherwise have changed other fields first changes nothing, in memory or on disk.
    let before = bytes(&core.tree_path());
    let reply = core.edit(json!({"op":"group_rename","from":"a","to":"x".repeat(65)}));
    assert!(reply["Err"].is_string(), "{reply}");
    assert_eq!(bytes(&core.tree_path()), before);
    assert_eq!(core.tree(core.get()), tree);
    let reply = core.edit(json!({"op":"group_create","name":"a","project":p2}));
    assert!(reply["Err"].is_string(), "{reply}");
    assert_eq!(bytes(&core.tree_path()), before);
    assert_eq!(core.tree(core.get()), tree);
    // No temporary file is left behind.
    let leftovers: Vec<_> = fs::read_dir(&core.home)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("tree.") && e.file_name() != "tree.toml"
        })
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn tree_survives_set_aside_sessions() {
    // A sessions.json of another version is set aside (the core starts with no sessions): no session names any
    // project then, and that must not empty the tree, at start or on an edit.
    let file = "version = 1\npins = [\"/x\"]\nfolded = [\"group:g\"]\n[[groups]]\nname = \"g\"\nprojects = [\"/x\"]\n";
    let core = Core::with_files(&[("tree.toml", file), ("sessions.json", "{\"version\":99}")]);
    let expected = json!({"groups": [group("g", &["/x"])], "pins": ["/x"], "folded": ["group:g"]});
    assert_eq!(core.tree(core.get()), expected);
    core.tree(core.edit(json!({"op":"fold","key":"quiet:","folded":true})));
    let disk: toml::Value =
        toml::from_str(&String::from_utf8(bytes(&core.tree_path())).unwrap()).unwrap();
    assert_eq!(disk["pins"][0].as_str(), Some("/x"));
    assert_eq!(disk["groups"][0]["projects"][0].as_str(), Some("/x"));
    assert_eq!(disk["folded"].as_array().unwrap().len(), 2);
}

#[test]
fn tree_save_respects_file_max() {
    use nunchiro_core::tree::Tree;
    let home = home::short("tree-max");
    let old = "version = 1\n";
    fs::write(home.join("tree.toml"), old).unwrap();
    // 400 valid pins of 4000 bytes serialize to about 1.6 MB, more than the 1 MiB the loader accepts.
    let tree = Tree {
        pins: (0..400)
            .map(|i| format!("/{i:04}{}", "a".repeat(4000)))
            .collect(),
        ..Tree::default()
    };
    assert!(tree.save(&home).is_err());
    assert_eq!(bytes(&home.join("tree.toml")), old.as_bytes());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn tree_fold_keys_follow_groups() {
    let core = Core::new();
    let p1 = core.project("p1");
    core.tree(core.edit(json!({"op":"group_create","name":"old","project":p1})));
    core.tree(core.edit(json!({"op":"fold_set","folded":["group:old","quiet:old","quiet:"]})));
    // Renaming moves the old name's keys to the new name (V2-9a follow-up 2); "quiet:" (the ungrouped line) stays.
    let tree = core.tree(core.edit(json!({"op":"group_rename","from":"old","to":"new"})));
    assert_eq!(tree["folded"], json!(["group:new", "quiet:new", "quiet:"]));
    // A group born with a dissolved group's name starts unfolded.
    core.tree(core.edit(json!({"op":"group_dissolve","name":"new"})));
    let tree = core.tree(core.edit(json!({"op":"group_create","name":"new","project":p1})));
    assert_eq!(tree["folded"], json!(["quiet:"]));
    // A key of a group that never existed is dropped too, so stale keys cannot fill the cap.
    let tree = core.tree(core.edit(json!({"op":"fold","key":"group:never","folded":true})));
    assert_eq!(tree["folded"], json!(["quiet:"]));
}

#[test]
fn rename_folded_group_stays_folded() {
    let core = Core::new();
    let p1 = core.project("p1");
    core.tree(core.edit(json!({"op":"group_create","name":"old","project":p1})));
    core.tree(core.edit(json!({"op":"fold_set","folded":["group:old","quiet:old"]})));
    let tree = core.tree(core.edit(json!({"op":"group_rename","from":"old","to":"new"})));
    assert_eq!(tree["folded"], json!(["group:new", "quiet:new"]));
    // Loads back from disk the same: no `old` key is left.
    assert_eq!(
        core.tree(core.get())["folded"],
        json!(["group:new", "quiet:new"])
    );
}

#[test]
fn rename_folded_group_no_duplicate_fold_key() {
    let mut core = Core::new();
    let p1 = core.project("p1");
    core.tree(core.edit(json!({"op":"group_create","name":"old","project":p1})));
    core.stop();
    let stale = "folded = [\"group:old\", \"quiet:new\", \"quiet:old\", \"group:new\"]\n";
    let text = String::from_utf8(bytes(&core.tree_path())).unwrap();
    let text = text
        .replace("folded = []\n", "")
        .replace("version = 1\n", &format!("version = 1\n{stale}"));
    fs::write(core.tree_path(), text).unwrap();
    core.start();
    let tree = core.tree(core.edit(json!({"op":"group_rename","from":"old","to":"new"})));
    assert_eq!(tree["folded"], json!(["group:new", "quiet:new"]));
}

#[test]
fn refused_rename_keeps_folds() {
    let file = "version = 1\nfolded = [\"group:g\", \"quiet:g\", \"quiet:\"]\n[[groups]]\nname = \"g\"\nprojects = [\"/x\"]\n";
    let core = Core::with_file(file);
    let before = core.tree(core.get());
    for edit in [
        json!({"op":"group_rename","from":"nope","to":"h"}),
        json!({"op":"group_rename","from":"g","to":""}),
    ] {
        let reply = core.edit(edit.clone());
        assert!(reply["Err"].is_string(), "{edit}: {reply}");
        assert_eq!(core.tree(core.get()), before, "{edit}");
    }
}

#[test]
fn tree_edit_unknown_project_errors() {
    let core = Core::new();
    let p1 = core.project("p1");
    core.tree(core.edit(json!({"op":"group_create","name":"g","project":p1})));
    let before = bytes(&core.tree_path());
    for edit in [
        json!({"op":"group_create","name":"h","project":"/no/session/here"}),
        json!({"op":"project_move","project":"/no/session/here","group":"g"}),
        json!({"op":"pin","project":"/no/session/here","pinned":true}),
    ] {
        let reply = core.edit(edit.clone());
        assert!(
            reply["Err"]
                .as_str()
                .is_some_and(|e| e.contains("unknown project")),
            "{edit}: {reply}"
        );
        assert_eq!(bytes(&core.tree_path()), before, "{edit}");
    }
}

/// `index` counts the target group's projects once the moved project has left it, so it is also the final place.
fn members(tree: &serde_json::Value, name: &str) -> Vec<String> {
    let found = tree["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name);
    found.map_or(vec![], |g| {
        g["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect()
    })
}

#[test]
fn project_move_index_places_and_clamps() {
    let core = Core::new();
    let (p1, p2, p3, p4) = (
        core.project("p1"),
        core.project("p2"),
        core.project("p3"),
        core.project("p4"),
    );
    core.tree(core.edit(json!({"op":"group_create","name":"A","project":p1})));
    core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A"})));
    core.tree(core.edit(json!({"op":"project_move","project":p3,"group":"A"})));
    // Index 0 puts it first, index 1 between, an index past the end clamps to the end.
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p4,"group":"A","index":0})));
    assert_eq!(
        members(&tree, "A"),
        [p4.as_str(), p1.as_str(), p2.as_str(), p3.as_str()]
    );
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p4,"group":"A","index":2})));
    assert_eq!(
        members(&tree, "A"),
        [p1.as_str(), p2.as_str(), p4.as_str(), p3.as_str()]
    );
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"A","index":99})));
    assert_eq!(
        members(&tree, "A"),
        [p2.as_str(), p4.as_str(), p3.as_str(), p1.as_str()]
    );
    // No index appends.
    let tree = core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A"})));
    assert_eq!(
        members(&tree, "A"),
        [p4.as_str(), p3.as_str(), p1.as_str(), p2.as_str()]
    );
}

#[test]
fn project_move_back_restores_order() {
    let core = Core::new();
    let (p1, p2, p3, p4) = (
        core.project("p1"),
        core.project("p2"),
        core.project("p3"),
        core.project("p4"),
    );
    core.tree(core.edit(json!({"op":"group_create","name":"A","project":p1})));
    core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A"})));
    core.tree(core.edit(json!({"op":"project_move","project":p3,"group":"A"})));
    core.tree(core.edit(json!({"op":"group_create","name":"B","project":p4})));
    let before = ["A", "B"].map(|g| members(&core.tree(core.get()), g));
    // The middle project goes to B and comes back to its old index 1 in A.
    core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"B"})));
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A","index":1})));
    assert_eq!(["A", "B"].map(|g| members(&tree, g)), before);
    // Moving inside its own group by one edit lands at the index, not one off.
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"A","index":1})));
    assert_eq!(members(&tree, "A"), [p2.as_str(), p1.as_str(), p3.as_str()]);
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"A","index":0})));
    assert_eq!(members(&tree, "A"), [p1.as_str(), p2.as_str(), p3.as_str()]);
}

#[test]
fn project_move_without_index_unchanged() {
    let core = Core::new();
    let (p1, p2) = (core.project("p1"), core.project("p2"));
    core.tree(core.edit(json!({"op":"group_create","name":"A","project":p1})));
    // An old client's frame carries no `index` (null is the same as absent); both append.
    let tree = core.tree(core.edit(json!({"op":"project_move","project":p2,"group":"A"})));
    assert_eq!(members(&tree, "A"), [p1.as_str(), p2.as_str()]);
    let tree =
        core.tree(core.edit(json!({"op":"project_move","project":p1,"group":"A","index":null})));
    assert_eq!(members(&tree, "A"), [p2.as_str(), p1.as_str()]);
}

// F15 r2: a folder picked from "+ Project" is a project with no session: kept across a restart, pinnable, and
// removed again by `add` false (its pin goes with it).
#[test]
fn tree_added_folder_is_a_project_without_a_session() {
    let mut core = Core::new();
    let dir = core.home.join("picked");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.to_str().unwrap().to_string();
    let tree = core.tree(core.edit(json!({"op":"add","project":p,"added":true})));
    assert_eq!(tree["added"], json!([p]));
    assert_eq!(
        core.owner(json!({"op":"list"}))["Ok"]["sessions"],
        json!([])
    );
    core.tree(core.edit(json!({"op":"pin","project":p,"pinned":true})));
    core.restart();
    let tree = core.tree(core.get());
    assert_eq!((&tree["added"], &tree["pins"]), (&json!([p]), &json!([p])));
    let tree = core.tree(core.edit(json!({"op":"add","project":p,"added":false})));
    assert_eq!(tree, json!({"groups": [], "pins": [], "folded": []}));
}

// F15 r2: a refused start says which folder and why in core.log, one line; a chmod-locked folder is the mode case.
#[test]
fn refused_start_is_logged() {
    let core = Core::new();
    let locked = core.home.join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let r = core.owner(json!({"op":"start","session":{
        "kind":"shell","project":locked,"label":"x","args":["/bin/sh","-c","sleep 300"]}}));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let e = r["Err"].as_str().unwrap_or_default();
    assert!(e.starts_with("file_access: no permission to read"), "{r}");
    // The reply can beat the line: stderr reaches core.log through the log route's reader thread.
    let line = format!("start refused: Shell in {}: {e}", locked.display());
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let log = fs::read_to_string(core.home.join("logs/core.log")).unwrap_or_default();
        if log.lines().any(|l| l.ends_with(&line)) {
            break;
        }
        assert!(Instant::now() < end, "{log}");
        thread::sleep(Duration::from_millis(20));
    }
}

// Ticket 1040 (Locate). A 1x1 PNG is enough of an icon; the core only sniffs its first bytes.
const ICON: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/// A project with a group, a pin, a name, an icon, its own settings and one closed session: all that Locate must carry.
fn located_fixture(core: &Core, name: &str) -> String {
    let p = core.project(name);
    core.tree(core.edit(json!({"op":"group_create","name":"Work","project":p})));
    core.tree(core.edit(json!({"op":"pin","project":p,"pinned":true})));
    core.tree(core.edit(json!({"op":"project_name","project":p,"name":"Blog"})));
    let ok = |r: Value| assert!(r["Ok"].is_object(), "{r}");
    ok(core.owner(json!({"op":"project_icon_set","project":p,"data_b64":ICON})));
    ok(core.owner(json!({"op":"quit_settings","patch":{"features":{
        "worktree.scripts": {&p: {"setup":"pnpm install","cleanup":"","policy":"skip","wait":true}},
        "worktree.shared": {&p: {"files":[{"path":".env","mode":"link"}],"sparse":[]}},
    }}})));
    p
}
fn sessions_of(core: &Core, project: &str) -> Vec<Value> {
    let list = core.owner(json!({"op":"list"}));
    let all = list["Ok"]["sessions"].as_array().unwrap().clone();
    all.into_iter()
        .filter(|s| s["project"] == project)
        .collect()
}
fn close_sessions(core: &Core, project: &str) {
    for s in sessions_of(core, project) {
        let r = core.owner(json!({"op":"close","id":s["id"]}));
        assert_eq!(r["Ok"]["type"], "ack", "{r}");
    }
}
fn locate(core: &Core, from: &str, to: &Path) -> Value {
    core.owner(json!({"op":"project_locate","from":from,"to":to}))
}
/// Every store Locate writes, as bytes: equal before and after a refused or failed Locate.
fn stores(core: &Core) -> Vec<Option<Vec<u8>>> {
    ["tree.toml", "sessions.json", "settings.json"]
        .map(|f| fs::read(core.home.join(f)).ok())
        .into()
}

#[test]
fn locate_moves_everything_and_a_restart_keeps_it() {
    let mut core = Core::new();
    let old = located_fixture(&core, "old-blog");
    let other = core.project("api");
    let moved = core.home.join("blog-2024");
    // Refused with no change: a running session, a folder that is a project, a folder that is not there.
    fs::rename(&old, &moved).unwrap();
    let before = stores(&core);
    let r = locate(&core, &old, &moved);
    assert_eq!(r["Err"], "Stop this project's sessions, then try again.");
    assert_eq!(stores(&core), before);
    close_sessions(&core, &old);
    let before = stores(&core);
    let r = locate(&core, &old, Path::new(&other));
    assert_eq!(r["Err"], "That folder is already a project in Nunchiro.");
    let r = locate(&core, &old, &core.home.join("nowhere"));
    assert_eq!(r["Err"], "not a folder");
    assert_eq!(stores(&core), before);
    let state = |core: &Core, p: &str| {
        core.owner(json!({"op":"project_folders"}))["Ok"]["folders"][p].clone()
    };
    assert_eq!(state(&core, &old), "missing");
    assert_eq!(state(&core, &other), "ok");

    let r = locate(&core, &old, &moved);
    let new = fs::canonicalize(&moved)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(r["Ok"]["type"], "project_located", "{r}");
    assert_eq!(r["Ok"]["project"], new.as_str());
    for round in ["at once", "after a core restart"] {
        let tree = core.tree(core.get());
        assert_eq!(tree["groups"], json!([group("Work", &[&new])]), "{round}");
        assert_eq!(tree["pins"], json!([new]), "{round}");
        assert_eq!(tree["names"], json!({&new: "Blog"}), "{round}");
        let icon = |p: &str| {
            core.owner(json!({"op":"project_icon_get","project":p}))["Ok"]["mime"].clone()
        };
        assert_eq!(
            (icon(&new), icon(&old)),
            (json!("image/png"), Value::Null),
            "{round}"
        );
        let settings = core.owner(json!({"op":"quit_settings"}));
        let features = &settings["Ok"]["settings"]["features"];
        assert_eq!(
            features["worktree.scripts"],
            json!({&new: {"setup":"pnpm install","cleanup":"","policy":"skip","wait":true}}),
            "{round}"
        );
        assert_eq!(
            features["worktree.shared"],
            json!({&new: {"files":[{"path":".env","mode":"link"}],"sparse":[]}}),
            "{round}"
        );
        // The history: the closed session is the project's, in its folder; none is left at the old path.
        let mine = sessions_of(&core, &new);
        assert_eq!(mine.len(), 1, "{round}");
        assert_eq!(mine[0]["cwd"], new.as_str(), "{round}");
        assert!(sessions_of(&core, &old).is_empty(), "{round}");
        assert_eq!(state(&core, &new), "ok", "{round}");
        assert_eq!(state(&core, &old), Value::Null, "{round}");
        for file in ["tree.toml", "sessions.json", "settings.json"] {
            let text = String::from_utf8_lossy(&bytes(&core.home.join(file))).into_owned();
            assert!(
                !text.contains(&format!("{old}\"")),
                "{file} still names the old path {round}"
            );
        }
        core.restart();
    }
}

// Ticket 1040: a Locate that fails at a late step (the icon cannot be written) leaves every store and the running core
// as they were: the project is whole at its old path, never split in two.
#[test]
fn locate_is_all_or_nothing() {
    let core = Core::new();
    let old = located_fixture(&core, "old-blog");
    close_sessions(&core, &old);
    let moved = core.home.join("blog-2024");
    fs::rename(&old, &moved).unwrap();
    let (before, tree) = (stores(&core), core.tree(core.get()));
    let icons = core.home.join("project-icons");
    assert!(
        icons.is_dir(),
        "the icon folder has another name: fix this test"
    );
    fs::set_permissions(&icons, fs::Permissions::from_mode(0o500)).unwrap();
    let r = locate(&core, &old, &moved);
    fs::set_permissions(&icons, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(r["Err"].is_string(), "{r}");
    assert_eq!(stores(&core), before);
    assert_eq!(core.tree(core.get()), tree);
    assert_eq!(sessions_of(&core, &old).len(), 1);
    let icon = core.owner(json!({"op":"project_icon_get","project":old}));
    assert_eq!(icon["Ok"]["mime"], "image/png");
    // The same Locate goes through once the folder can be written.
    assert_eq!(locate(&core, &old, &moved)["Ok"]["type"], "project_located");
}
