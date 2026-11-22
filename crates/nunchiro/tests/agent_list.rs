// V2.5-30 (ticket 160, needs 145): the parent link in `agent get`, `session list`, the snapshot, and `agent list --mine`.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Output},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("alist");
        let core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("core.token").exists()
            || UnixStream::connect(h.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn call(&self, token: &str, request: Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.home.join("core.sock")).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        self.call(
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
    /// A shell session that prints its token; started by `token`'s session, or by the owner.
    fn start(&self, token: Option<&str>) -> (String, String) {
        let request = json!({"op":"start","session":{"kind":"shell","project":self.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}});
        let reply = match token {
            Some(token) => self.call(token, request),
            None => self.owner(request),
        }
        .unwrap();
        let id = reply["session"]["id"].as_str().unwrap().to_string();
        let token = self.token(&id);
        (id, token)
    }
    fn token(&self, id: &str) -> String {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id})).unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            if let Some(line) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return line.trim().into();
            }
            assert!(Instant::now() < until, "no token from {id}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn cli(&self, token: Option<&str>, args: &[&str]) -> Output {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN");
        if let Some(t) = token {
            c.env("NUNCHIRO_TOKEN", t);
        }
        c.output().unwrap()
    }
    fn json(&self, token: Option<&str>, args: &[&str]) -> Value {
        let out = self.cli(token, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn snapshot(&self) -> Vec<Value> {
        self.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .clone()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op":"stop"}));
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn ids(list: &Value) -> Vec<String> {
    let mut ids: Vec<String> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().into())
        .collect();
    ids.sort();
    ids
}

#[test]
fn parent_in_agent_get_and_snapshot() {
    let h = Harness::new();
    let (coordinator, token) = h.start(None);
    let (worker, _) = h.start(Some(&token));
    let got = h.json(None, &["agent", "get", &worker, "--json"]);
    assert_eq!(got["parent"], coordinator.as_str());
    let snap = h.snapshot();
    let row = |id: &str| snap.iter().find(|s| s["id"] == id).unwrap().clone();
    assert_eq!(row(&worker)["parent"], coordinator.as_str());
    // A session the owner started keeps its old output: no `parent` key at all.
    assert!(row(&coordinator).get("parent").is_none(), "{snap:?}");
    let listed = h.cli(None, &["session", "list"]);
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    let in_list = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == worker.as_str())
        .unwrap()
        .clone();
    assert_eq!(in_list["parent"], coordinator.as_str());
}

#[test]
fn agent_list_mine_direct_children() {
    let h = Harness::new();
    let (coordinator, coordinator_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&coordinator_token));
    let (sub, _) = h.start(Some(&worker_token));
    let (other, _) = h.start(None);
    // Direct children only, at every level.
    let mine = h.json(
        Some(&coordinator_token),
        &["agent", "list", "--mine", "--json"],
    );
    assert_eq!(ids(&mine), vec![worker.clone()]);
    assert_eq!(mine[0]["parent"], coordinator.as_str());
    assert!(mine[0]["status"].is_string(), "{mine}");
    let mine = h.json(Some(&worker_token), &["agent", "list", "--mine", "--json"]);
    assert_eq!(ids(&mine), vec![sub.clone()]);
    // Without --mine: what `session list` shows.
    let all = h.json(Some(&coordinator_token), &["agent", "list", "--json"]);
    let mut expected = vec![coordinator.clone(), worker.clone(), sub.clone(), other];
    expected.sort();
    assert_eq!(ids(&all), expected);
    // Text: one line per agent, its parent last.
    let text = h.cli(Some(&coordinator_token), &["agent", "list", "--mine"]);
    assert!(text.status.success());
    let text = String::from_utf8_lossy(&text.stdout);
    assert_eq!(text.lines().count(), 1, "{text}");
    assert!(text.starts_with(&format!("{worker}\t")), "{text}");
    assert!(
        text.trim_end().ends_with(&format!("\t{coordinator}")),
        "{text}"
    );
}

#[test]
fn mine_uses_peer_identity() {
    let h = Harness::new();
    let (_, other_token) = h.start(None);
    let (_, other_child_token) = h.start(Some(&other_token));
    drop(other_child_token);
    // Inside a session: start one worker with the session's own token, then ask `--mine` with the owner token (the
    // session's token removed), so only the core's peer check can tell who is asking.
    let out = h.home.join("inside.json");
    let script = r#""$1" session start --kind shell --project "$2" -- /bin/cat > /dev/null || exit 1; env -u NUNCHIRO_TOKEN "$1" agent list --mine --json > "$3.tmp" 2>&1; mv "$3.tmp" "$3"; exec sleep 30"#;
    let inside = h
        .owner(json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c",script,"inside",env!("CARGO_BIN_EXE_nunchiro"),h.home,out]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(20);
    while !out.exists() {
        assert!(Instant::now() < until, "inside list never answered");
        thread::sleep(Duration::from_millis(50));
    }
    let raw = fs::read_to_string(&out).unwrap();
    let mine: Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{e}: {raw}"));
    let children: Vec<String> = h
        .snapshot()
        .iter()
        .filter(|s| s["parent"] == inside.as_str())
        .map(|s| s["id"].as_str().unwrap().into())
        .collect();
    assert_eq!(children.len(), 1, "{children:?}");
    assert_eq!(ids(&mine), children);
    // Outside every session the owner has no "mine"; no option can name a caller; a forged token is refused.
    assert!(!h.cli(None, &["agent", "list", "--mine"]).status.success());
    for flag in ["--as", "--caller", "--session", "--parent"] {
        let r = h.cli(
            Some(&other_token),
            &["agent", "list", "--mine", flag, &inside],
        );
        assert!(!r.status.success(), "{flag} accepted");
    }
    assert!(
        !h.cli(Some("forged"), &["agent", "list", "--mine"])
            .status
            .success()
    );
}

// Sixth look (Home, S2): a seat replaced for another level leaves its ended session under the same label.
#[test]
fn a_label_shared_with_an_ended_session_names_the_running_one() {
    let h = Harness::new();
    for _ in 0..2 {
        h.owner(json!({"op":"start","session":{"kind":"shell","project":h.home,"label":"twin","args":["/bin/cat"],"resume":null}}))
            .unwrap();
    }
    let twins = || -> Vec<(String, String)> {
        h.snapshot()
            .iter()
            .filter(|s| s["label"] == "twin")
            .map(|s| {
                (
                    s["id"].as_str().unwrap().to_owned(),
                    s["state"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let both = twins();
    assert_eq!(both.len(), 2, "{both:?}");
    let refused = h.cli(None, &["agent", "get", "twin", "--json"]);
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("ambiguous agent label"),
        "{refused:?}"
    );
    h.owner(json!({"op":"close","id":both[0].0})).unwrap();
    assert_eq!(
        twins().len(),
        2,
        "the ended session keeps its row and label"
    );
    assert_eq!(
        h.json(None, &["agent", "get", "twin", "--json"])["id"],
        both[1].0
    );
}
