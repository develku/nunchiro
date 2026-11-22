//! V2-2a: the account registry, the login tab and the signed-in probe, against a real `nunchiro serve` with fake
//! `claude` and `codex` programs on PATH. The fakes write their env and argv under `NUNCHIRO_HOME` and a marker in
//! the config folder they were pointed at, so a wrong folder shows as a changed tree. No real agent runs here.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    accounts::{self, Agent, SignedIn},
    api::*,
    server::call,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const CRED: &str = "CREDENTIAL-SENTINEL-7f3a";
const PROBE_TOKEN: &str = "sk-ant-oat01-PROBESENTINEL0123456789";
const HOSTILE: &str = "x; touch pwned $(id) `id` \"q\" 'q'";

// $1 $2 select the command; D is the folder the agent would use (the override, else its default under HOME).
const FAKE_CLAUDE: &str = r#"#!/bin/sh
D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1" in --version) echo "2.1.311 (Claude Code)"; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then
  [ -z "$CLAUDE_CONFIG_DIR" ] && echo claude >> "$HOME/own-probes.log"
  [ -e "$D/hang" ] && exec sleep 30
  [ -e "$D/slow" ] && sleep 2
  echo "$PROBE_TOKEN_TEXT" >&2
  if [ -e "$D/.logged-in" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "token": "sk-ant-oat01-PROBESENTINEL0123456789"}'; exit 0; fi
  echo '{"loggedIn": false, "authMethod": "none", "token": "sk-ant-oat01-PROBESENTINEL0123456789"}'; exit 1
fi
if [ "$1 $2" = "auth login" ]; then
  env > "$NUNCHIRO_HOME/login-claude.env.tmp" && mv "$NUNCHIRO_HOME/login-claude.env.tmp" "$NUNCHIRO_HOME/login-claude.env"
  for a in "$0" "$@"; do printf '%s\n' "$a"; done > "$NUNCHIRO_HOME/a.tmp" && mv "$NUNCHIRO_HOME/a.tmp" "$NUNCHIRO_HOME/login-claude.argv"
  touch "$D/.logged-in"
  echo "Login successful."
  exit 0
fi
exit 2
"#;
const FAKE_CODEX: &str = r#"#!/bin/sh
D="${CODEX_HOME:-$HOME/.codex}"
case "$1" in --version) echo "codex-cli 0.161.0"; exit 0;; esac
if [ "$1 $2" = "login status" ]; then
  [ -z "$CODEX_HOME" ] && echo codex >> "$HOME/own-probes.log"
  [ -e "$D/hang" ] && exec sleep 30
  if [ -e "$D/.logged-in" ]; then echo "Logged in using ChatGPT sk-ant-oat01-PROBESENTINEL0123456789" >&2; exit 0; fi
  echo "Not logged in" >&2; exit 1
fi
if [ "$1" = "login" ] && [ $# = 1 ]; then
  env > "$NUNCHIRO_HOME/login-codex.env.tmp" && mv "$NUNCHIRO_HOME/login-codex.env.tmp" "$NUNCHIRO_HOME/login-codex.env"
  for a in "$0" "$@"; do printf '%s\n' "$a"; done > "$NUNCHIRO_HOME/a.tmp" && mv "$NUNCHIRO_HOME/a.tmp" "$NUNCHIRO_HOME/login-codex.argv"
  touch "$D/.logged-in"
  echo "Successfully logged in"
  exit 0
fi
exit 2
"#;

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    user: PathBuf,
    process: Child,
}
impl Core {
    /// `core_vars`: the core itself runs with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` set (to folders under the home).
    fn new(core_vars: bool) -> Self {
        let home = home::short("acct");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, body) in [("claude", FAKE_CLAUDE), ("codex", FAKE_CODEX)] {
            fs::write(bin.join(name), body).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // The user's own trees, with an unreadable credential file holding a sentinel.
        let user = home.join("u");
        for (dir, cred) in [(".claude", ".credentials.json"), (".codex", "auth.json")] {
            fs::create_dir_all(user.join(dir).join("skills/mine")).unwrap();
            fs::write(user.join(dir).join("skills/mine/SKILL.md"), "own skill").unwrap();
            fs::write(user.join(dir).join("settings.json"), "{}").unwrap();
            fs::write(user.join(dir).join(cred), CRED).unwrap();
            fs::set_permissions(user.join(dir).join(cred), fs::Permissions::from_mode(0o000))
                .unwrap();
        }
        let mut command = home::git_env::scrubbed(cli());
        command
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &user)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("PROBE_TOKEN_TEXT", PROBE_TOKEN)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap());
        if core_vars {
            fs::create_dir_all(home.join("core-claude")).unwrap();
            fs::create_dir_all(home.join("core-codex")).unwrap();
            command
                .env("CLAUDE_CONFIG_DIR", home.join("core-claude"))
                .env("CODEX_HOME", home.join("core-codex"))
                .env("ANTHROPIC_API_KEY", "core-anthropic-key")
                .env("CLAUDE_CODE_OAUTH_TOKEN", "core-oauth-token")
                .env("OPENAI_API_KEY", "core-openai-key");
        }
        let process = command.spawn().unwrap();
        let core = Self {
            home,
            user,
            process,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn list(&self) -> Vec<Value> {
        match call(&self.home, Request::AccountList) {
            Ok(Reply::Accounts { accounts }) => serde_json::to_value(accounts)
                .unwrap()
                .as_array()
                .unwrap()
                .clone(),
            other => panic!("{other:?}"),
        }
    }
    fn add(&self, agent: Agent, label: &str) -> Response {
        call(
            &self.home,
            Request::AccountAdd {
                agent,
                label: label.into(),
            },
        )
    }
    fn added(&self, agent: Agent, label: &str) -> (Value, Session) {
        match self.add(agent, label) {
            Ok(Reply::AccountAdded { account, session }) => {
                (serde_json::to_value(account).unwrap(), session)
            }
            other => panic!("{other:?}"),
        }
    }
    fn wait(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = fs::read_to_string(self.home.join(name))
                && text.ends_with('\n')
            {
                return text;
            }
            assert!(Instant::now() < until, "{name} never appeared");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// The fake login's last step: its marker in the folder it was pointed at.
    fn logged_in(&self, account: &Value) {
        let marker = PathBuf::from(account["folder"].as_str().unwrap()).join(".logged-in");
        let until = Instant::now() + Duration::from_secs(15);
        while !marker.exists() {
            assert!(Instant::now() < until, "login never finished");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn screen(&self, id: &str) -> String {
        match call(
            &self.home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
            other => panic!("{other:?}"),
        }
    }
    fn session(&self, id: &str) -> Session {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
            _ => panic!(),
        }
    }
    fn shell(&self, script: &str) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.clone(),
                    worktree: false,
                    label: "plain".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            _ => panic!(),
        }
    }
    /// The token a session's own process holds (printed by its shell).
    fn session_token(&self) -> String {
        let s = self.shell("printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat");
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(l) = self
                .screen(&s.id)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return l.trim().to_string();
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn raw(&self, token: &str, request: Value) -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
    fn owner(&self, request: Value) -> Value {
        self.raw(
            fs::read_to_string(self.home.join("core.token"))
                .unwrap()
                .trim(),
            request,
        )
    }
    fn window(&self, request: Value) -> Value {
        let info = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", info["port"])
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                info["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < until);
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
    fn log(&self) -> String {
        fs::read_to_string(self.home.join("core.log")).unwrap_or_default()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        // The planted credential files are mode 000; the folder removal needs them readable only to unlink.
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// Every file under `dir` (relative path, mode, size, mtime, link target), so any write in the tree shows.
fn tree(dir: &Path) -> BTreeMap<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).unwrap().flatten() {
            let m = fs::symlink_metadata(entry.path()).unwrap();
            let rel = entry.path().strip_prefix(dir).unwrap().to_path_buf();
            out.insert(
                rel,
                format!(
                    "{:o} {} {}.{} {:?}",
                    m.mode(),
                    m.size(),
                    m.mtime(),
                    m.mtime_nsec(),
                    fs::read_link(entry.path()).ok()
                ),
            );
            if m.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    out
}
fn env_map(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn account_add_login_visible_tab() {
    let core = Core::new(false);
    let before = (
        tree(&core.user.join(".claude")),
        tree(&core.user.join(".codex")),
    );
    for (agent, var, argv) in [
        (Agent::Claude, "CLAUDE_CONFIG_DIR", "claude\nauth\nlogin\n"),
        (Agent::Codex, "CODEX_HOME", "codex\nlogin\n"),
    ] {
        let name = accounts::agent_name(agent);
        let (account, session) = core.added(agent, "work");
        let folder = PathBuf::from(account["folder"].as_str().unwrap());
        assert_eq!(
            folder,
            core.home
                .join("accounts")
                .join(name)
                .join(account["id"].as_str().unwrap())
        );
        assert_eq!(mode(&folder), 0o700);
        assert_eq!(
            (account["default"].clone(), account["signed_in"].clone()),
            (json!(false), json!("no"))
        );
        // A visible tab: a shell session the window lists, named for the account, in the account folder.
        assert_eq!(session.kind, AgentKind::Shell);
        assert_eq!(session.label, "Login: work");
        assert_eq!(
            (session.project.clone(), session.cwd.clone()),
            (folder.clone(), folder.clone())
        );
        let env = env_map(&core.wait(&format!("login-{name}.env")));
        assert_eq!(
            env.get(var).map(PathBuf::from),
            Some(folder.clone()),
            "{env:?}"
        );
        let other = if var == "CODEX_HOME" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "CODEX_HOME"
        };
        assert_eq!(env.get(other), None);
        // The fixed argv: the program found on PATH and its own login words.
        let argv_seen = core.wait(&format!("login-{name}.argv"));
        let (program, words) = argv_seen.split_once('\n').unwrap();
        assert!(program.ends_with(&format!("/bin/{name}")), "{program}");
        assert_eq!(format!("{name}\n{words}"), argv);
        core.logged_in(&account);
        let until = Instant::now() + Duration::from_secs(10);
        while !core.screen(&session.id).contains("uccess") {
            assert!(Instant::now() < until, "the tab never showed the login");
            thread::sleep(Duration::from_millis(20));
        }
        assert!(core.session(&session.id).state != SessionState::Failed);
    }
    let rows = core.list();
    let signed: Vec<_> = rows
        .iter()
        .filter(|r| r["default"] == false)
        .map(|r| r["signed_in"].clone())
        .collect();
    assert_eq!(signed, [json!("yes"), json!("yes")], "{rows:?}");
    assert_eq!(
        (
            tree(&core.user.join(".claude")),
            tree(&core.user.join(".codex"))
        ),
        before,
        "the user's own trees changed"
    );
}

#[test]
fn account_override_not_inherited_or_public() {
    let core = Core::new(true);
    let (account, _) = core.added(Agent::Claude, "work");
    let env = env_map(&core.wait("login-claude.env"));
    assert_eq!(
        env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        account["folder"].as_str()
    );
    // The core's own CODEX_HOME does not reach a Claude login either.
    assert_eq!(env.get("CODEX_HOME"), None, "{env:?}");
    let (codex, _) = core.added(Agent::Codex, "work");
    let env = env_map(&core.wait("login-codex.env"));
    assert_eq!(
        env.get("CODEX_HOME").map(String::as_str),
        codex["folder"].as_str()
    );
    assert_eq!(env.get("CLAUDE_CONFIG_DIR"), None, "{env:?}");
    // Nor a key or token the core inherited: the login signs in to the folder, not as the core's user.
    for key in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
    ] {
        assert_eq!(env.get(key), None, "{key}");
    }
    assert!(!core.home.join("core-claude/.logged-in").exists());
    assert!(!core.home.join("core-codex/.logged-in").exists());

    // A normal start afterwards: the core's own variables as before (inherited), no account folder.
    core.shell("env > \"$NUNCHIRO_HOME/plain.env\"");
    let plain = env_map(&core.wait("plain.env"));
    let own = |name: &str| Some(core.home.join(name).display().to_string());
    assert_eq!(plain.get("CLAUDE_CONFIG_DIR").cloned(), own("core-claude"));
    assert_eq!(plain.get("CODEX_HOME").cloned(), own("core-codex"));
    assert_eq!(
        plain.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some("core-anthropic-key")
    );
    // `StartSession` has no env field; an `env` key in its JSON is ignored (serde, no deny_unknown_fields).
    let reply = core.owner(json!({"op":"start","session":{
        "kind":"shell","project":core.home,"label":"env-key",
        "args":["/bin/sh","-c","env > \"$NUNCHIRO_HOME/keyed.env\""],
        "env":{"CLAUDE_CONFIG_DIR": account["folder"], "CODEX_HOME": "/tmp/elsewhere"}}}));
    assert_eq!(reply["Ok"]["type"], "started", "{reply}");
    let keyed = env_map(&core.wait("keyed.env"));
    assert_eq!(keyed.get("CLAUDE_CONFIG_DIR").cloned(), own("core-claude"));
    assert_eq!(keyed.get("CODEX_HOME").cloned(), own("core-codex"));
}

#[test]
fn account_no_credential_open() {
    let core = Core::new(false);
    let (account, _) = core.added(Agent::Claude, "work");
    core.logged_in(&account);
    let folder = PathBuf::from(account["folder"].as_str().unwrap());
    fs::write(folder.join(".credentials.json"), CRED).unwrap();
    fs::set_permissions(
        folder.join(".credentials.json"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let (codex, _) = core.added(Agent::Codex, "work");
    core.logged_in(&codex);
    let cfolder = PathBuf::from(codex["folder"].as_str().unwrap());
    fs::write(cfolder.join("auth.json"), CRED).unwrap();
    fs::set_permissions(cfolder.join("auth.json"), fs::Permissions::from_mode(0o000)).unwrap();
    let rows = core.list();
    let text = serde_json::to_string(&rows).unwrap();
    let added: Vec<_> = rows.iter().filter(|r| r["default"] == false).collect();
    assert!(
        added.len() == 2 && added.iter().all(|r| r["signed_in"] == "yes"),
        "{text}"
    );
    let window = core.window(json!({"op":"account_list"})).to_string();
    let out = home::git_env::scrubbed(cli())
        .args(["account", "list", "--json"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    for seen in [
        text,
        window,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        core.log(),
    ] {
        assert!(!seen.contains(CRED), "credential sentinel leaked: {seen}");
        assert!(
            !seen.contains("PROBESENTINEL"),
            "probe output leaked: {seen}"
        );
    }
    // The module never names the credential paths, the Keychain or the usage endpoint.
    let source =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/accounts.rs"))
            .unwrap();
    for banned in [
        "security find-generic-password",
        "Keychain",
        "keychain",
        "oauth/usage",
        ".credentials.json",
        "auth.json",
    ] {
        assert!(!source.contains(banned), "accounts.rs names {banned}");
    }
}

#[test]
fn account_id_path_guard() {
    let core = Core::new(false);
    // A symlinked `accounts/<agent>` pointing at the user's own tree: refused, nothing created there.
    fs::create_dir_all(core.home.join("accounts")).unwrap();
    std::os::unix::fs::symlink(core.user.join(".claude"), core.home.join("accounts/claude"))
        .unwrap();
    let before = tree(&core.user.join(".claude"));
    let err = core.add(Agent::Claude, "work").unwrap_err();
    assert!(err.contains("link"), "{err}");
    assert_eq!(tree(&core.user.join(".claude")), before);
    assert!(!core.home.join("login-claude.env").exists());
    assert!(
        !fs::read_to_string(core.home.join("accounts.toml"))
            .unwrap_or_default()
            .contains("work")
    );
    fs::remove_file(core.home.join("accounts/claude")).unwrap();
    // A symlinked `accounts`: refused too.
    fs::remove_dir(core.home.join("accounts")).unwrap();
    std::os::unix::fs::symlink(core.user.join(".codex"), core.home.join("accounts")).unwrap();
    let before = tree(&core.user.join(".codex"));
    assert!(core.add(Agent::Codex, "work").unwrap_err().contains("link"));
    assert_eq!(tree(&core.user.join(".codex")), before);
    fs::remove_file(core.home.join("accounts")).unwrap();

    // Ids from the registry file reach a path only after `valid_id`: `..`, `/` and others refuse the whole file.
    for id in [
        "..",
        "../../u/.claude",
        "a/b",
        "",
        "own",
        "a b",
        &"a".repeat(81),
    ] {
        let file = format!(
            "version = 1\n[[accounts]]\nagent = \"claude\"\nid = {}\nlabel = \"x\"\n",
            json!(id)
        );
        fs::write(core.home.join("accounts.toml"), &file).unwrap();
        let reply = call(&core.home, Request::AccountList);
        assert!(reply.is_err(), "{id:?}: {reply:?}");
        assert_eq!(
            fs::read_to_string(core.home.join("accounts.toml")).unwrap(),
            file
        );
    }
    // A registered id whose folder is a link: never probed (no write through it), shown as unknown.
    let id = "11111111-2222-4333-8444-555555555555";
    fs::create_dir_all(core.home.join("accounts/claude")).unwrap();
    std::os::unix::fs::symlink(
        core.user.join(".claude"),
        core.home.join("accounts/claude").join(id),
    )
    .unwrap();
    fs::write(
        core.home.join("accounts.toml"),
        format!("version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"{id}\"\nlabel = \"x\"\n"),
    )
    .unwrap();
    fs::write(core.user.join(".claude/.logged-in"), "").unwrap();
    let before = tree(&core.user.join(".claude"));
    let rows = core.list();
    let row = rows.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(row["signed_in"], "unknown", "{rows:?}");
    assert_eq!(tree(&core.user.join(".claude")), before);
    // Fresh account folders and their parents are owner-only.
    fs::remove_file(core.home.join("accounts/claude").join(id)).unwrap();
    fs::remove_file(core.home.join("accounts.toml")).unwrap();
    let (account, _) = core.added(Agent::Claude, "work");
    for path in [
        core.home.join("accounts"),
        core.home.join("accounts/claude"),
        PathBuf::from(account["folder"].as_str().unwrap()),
    ] {
        assert_eq!(mode(&path), 0o700, "{}", path.display());
    }
}

#[test]
fn account_status_probe() {
    let fixture = |name: &str| {
        fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/accounts")
                .join(name),
        )
        .unwrap()
    };
    let cases = [
        (
            Agent::Claude,
            Some(0),
            fixture("claude-2.1.311-signed-in.stdout"),
            vec![],
            SignedIn::Yes,
        ),
        (
            Agent::Claude,
            Some(1),
            fixture("claude-2.1.311-signed-out.stdout"),
            vec![],
            SignedIn::No,
        ),
        (
            Agent::Codex,
            Some(0),
            vec![],
            fixture("codex-0.161.0-signed-in.stderr"),
            SignedIn::Yes,
        ),
        (
            Agent::Codex,
            Some(1),
            vec![],
            fixture("codex-0.161.0-signed-out.stderr"),
            SignedIn::No,
        ),
        // Anything else is unknown: a crash, a new output shape, a mismatched exit, no exit (killed).
        (
            Agent::Claude,
            Some(0),
            b"{\"loggedIn\": false}".to_vec(),
            vec![],
            SignedIn::Unknown,
        ),
        (
            Agent::Claude,
            Some(1),
            b"{\"loggedIn\": true}".to_vec(),
            vec![],
            SignedIn::Unknown,
        ),
        (
            Agent::Claude,
            Some(0),
            b"Logged in".to_vec(),
            vec![],
            SignedIn::Unknown,
        ),
        (
            Agent::Claude,
            None,
            fixture("claude-2.1.311-signed-in.stdout"),
            vec![],
            SignedIn::Unknown,
        ),
        (
            Agent::Codex,
            Some(0),
            vec![],
            b"Not logged in\n".to_vec(),
            SignedIn::Unknown,
        ),
        (
            Agent::Codex,
            Some(1),
            vec![],
            b"Logged in using ChatGPT\n".to_vec(),
            SignedIn::Unknown,
        ),
        (
            Agent::Codex,
            Some(2),
            vec![],
            b"error: unexpected argument\n".to_vec(),
            SignedIn::Unknown,
        ),
        (Agent::Codex, None, vec![], vec![], SignedIn::Unknown),
    ];
    for (agent, code, stdout, stderr, want) in cases {
        assert_eq!(
            accounts::parse_status(agent, code, &stdout, &stderr),
            want,
            "{agent:?} {code:?} {:?} {:?}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
    }

    // A hanging status command is unknown after two 5 s runs (accounts probe 11-10: one retry), plus slack; the other
    // rows still answer.
    let core = Core::new(false);
    let (account, _) = core.added(Agent::Claude, "slow");
    core.logged_in(&account);
    fs::write(
        PathBuf::from(account["folder"].as_str().unwrap()).join("hang"),
        "",
    )
    .unwrap();
    let started = Instant::now();
    let rows = core.list();
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(10) && took < Duration::from_secs(13),
        "{took:?}"
    );
    let row = rows.iter().find(|r| r["id"] == account["id"]).unwrap();
    assert_eq!(row["signed_in"], "unknown");
    // The fake prints a token-shaped string on every status run: no reply carries it.
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("PROBESENTINEL")
    );
}

#[test]
fn account_requests_owner_only() {
    let core = Core::new(false);
    let token = core.session_token();
    for request in [
        json!({"op":"account_list"}),
        json!({"op":"account_add","agent":"claude","label":"agent-made"}),
        json!({"op":"account_rename","agent":"claude","id":"0123456789abcdef0123456789abcdef","label":"agent-made"}),
    ] {
        assert_eq!(
            core.raw(&token, request),
            json!({"Err":"operation not granted"})
        );
    }
    assert!(!core.home.join("accounts").exists());
    assert!(!core.home.join("accounts.toml").exists());
    // The window and the owner work.
    let listed = core.window(json!({"op":"account_list"}));
    assert_eq!(listed["Ok"]["type"], "accounts", "{listed}");
    let added = core.window(json!({"op":"account_add","agent":"codex","label":"from window"}));
    assert_eq!(added["Ok"]["type"], "account_added", "{added}");
    assert_eq!(added["Ok"]["session"]["label"], "Login: from window");
    let owner = core.owner(json!({"op":"account_list"}));
    assert_eq!(
        owner["Ok"]["accounts"].as_array().unwrap().len(),
        3,
        "{owner}"
    );
}

#[test]
fn account_label_never_reaches_a_shell() {
    let core = Core::new(false);
    for label in [HOSTILE, "$(id)", "회사 계정", "-rf --help"] {
        let _ = fs::remove_file(core.home.join("login-claude.argv"));
        let _ = fs::remove_file(core.home.join("login-claude.env"));
        let (account, session) = core.added(Agent::Claude, label);
        assert_eq!(account["label"], label);
        assert_eq!(session.label, format!("Login: {label}"));
        let argv = core.wait("login-claude.argv");
        assert_eq!(argv.split_once('\n').unwrap().1, "auth\nlogin\n", "{label}");
        let env = env_map(&core.wait("login-claude.env"));
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            account["folder"].as_str()
        );
        assert!(
            env.values().all(|v| !v.contains(label)),
            "{label} reached the env"
        );
        assert!(!account["folder"].as_str().unwrap().contains(label));
    }
    assert!(!core.home.join("pwned").exists() && !core.home.join("accounts/claude/pwned").exists());
    let stored = fs::read_to_string(core.home.join("accounts.toml")).unwrap();
    let rows = core.list();
    for label in [HOSTILE, "회사 계정"] {
        assert!(rows.iter().any(|r| r["label"] == label), "{rows:?}");
        let parsed: toml::Table = toml::from_str(&stored).unwrap();
        assert!(
            parsed["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["label"].as_str() == Some(label))
        );
    }
    // Refused labels: empty, blank, control characters, too long.
    for label in [
        "",
        "   ",
        "a\nb",
        "a\tb",
        "\u{1b}[31m",
        "a\u{202E}b",
        "\u{2066}x",
        &"가".repeat(65),
    ] {
        assert!(core.add(Agent::Claude, label).is_err(), "{label:?}");
    }
    assert!(core.add(Agent::Claude, &"가".repeat(64)).is_ok());
}

#[test]
fn account_registry_file_rules() {
    let core = Core::new(false);
    let path = core.home.join("accounts.toml");
    let (account, _) = core.added(Agent::Codex, "회사");
    let stored = fs::read_to_string(&path).unwrap();
    assert_eq!(mode(&path), 0o600);
    assert!(stored.starts_with("version = 1\n"), "{stored}");
    assert!(stored.contains("회사"));
    assert_eq!(
        core.list().iter().filter(|r| r["label"] == "회사").count(),
        1
    );
    assert_eq!(account["agent"], "codex");

    // Another version: set aside beside it (never overwritten), the registry starts empty.
    let newer =
        "version = 2\n[[accounts]]\nagent = \"claude\"\nid = \"x\"\nlabel = \"x\"\nfuture = true\n";
    fs::write(&path, newer).unwrap();
    assert_eq!(core.list().len(), 2);
    let asides: Vec<_> = fs::read_dir(&core.home)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("accounts.toml.v2.")
        })
        .collect();
    assert_eq!(asides.len(), 1);
    assert_eq!(fs::read_to_string(asides[0].path()).unwrap(), newer);
    assert!(!path.exists());
    core.added(Agent::Claude, "after");
    assert_eq!(fs::read_to_string(asides[0].path()).unwrap(), newer);

    // Malformed, an unknown key, a wrong field type, a duplicate: refused, file untouched.
    let id = "11111111-2222-4333-8444-555555555555";
    let entry = |extra: &str| {
        format!("[[accounts]]\nagent = \"claude\"\nid = \"{id}\"\nlabel = \"x\"\n{extra}")
    };
    for bad in [
        "version = 1\n[[accounts]\n".to_string(),
        format!("version = 1\n{}", entry("color = \"red\"\n")),
        format!("version = 1\nextra = 1\n{}", entry("")),
        format!("version = \"1\"\n{}", entry("")),
        entry(""),
        format!("version = 1\n[[accounts]]\nagent = \"shell\"\nid = \"{id}\"\nlabel = \"x\"\n"),
        "version = 1\n[[accounts]]\nagent = \"claude\"\nid = 7\nlabel = \"x\"\n".to_string(),
        format!("version = 1\n{}{}", entry(""), entry("")),
    ] {
        fs::write(&path, &bad).unwrap();
        assert!(call(&core.home, Request::AccountList).is_err(), "{bad}");
        assert!(core.add(Agent::Claude, "y").is_err(), "{bad}");
        assert_eq!(fs::read_to_string(&path).unwrap(), bad);
    }
    // The same id under two agents is two accounts.
    fs::write(
        &path,
        format!(
            "version = 1\n{}[[accounts]]\nagent = \"codex\"\nid = \"{id}\"\nlabel = \"x\"\n",
            entry("")
        ),
    )
    .unwrap();
    assert_eq!(core.list().len(), 4);

    // A symlinked registry: refused, the link and its target untouched.
    fs::remove_file(&path).unwrap();
    let target = core.home.join("elsewhere.toml");
    let body = format!("version = 1\n{}", entry(""));
    fs::write(&target, &body).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(
        call(&core.home, Request::AccountList)
            .unwrap_err()
            .contains("link")
    );
    assert!(core.add(Agent::Claude, "y").is_err());
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), body);
}

#[test]
fn your_own_row_first_and_not_removable() {
    let core = Core::new(false);
    let rows = core.list();
    assert_eq!(rows.len(), 2, "{rows:?}");
    for (row, agent, dir) in [
        (&rows[0], "claude", ".claude"),
        (&rows[1], "codex", ".codex"),
    ] {
        assert_eq!(row["agent"], agent);
        assert_eq!(
            (row["id"].clone(), row["label"].clone()),
            (json!("own"), json!("Default"))
        );
        assert_eq!(row["default"], true);
        assert_eq!(
            row["folder"].as_str().map(PathBuf::from),
            Some(core.user.join(dir))
        );
        // V2-2a r2: never probed by a list; only the owner's check (own_probe_runs_only_on_request_and_is_throttled).
        assert_eq!(row["signed_in"], "unknown");
    }
    fs::write(core.user.join(".claude/.logged-in"), "").unwrap();
    core.added(Agent::Codex, "b");
    core.added(Agent::Claude, "a");
    let rows = core.list();
    let order: Vec<_> = rows
        .iter()
        .map(|r| (r["agent"].clone(), r["default"].clone()))
        .collect();
    assert_eq!(
        order,
        [
            (json!("claude"), json!(true)),
            (json!("claude"), json!(false)),
            (json!("codex"), json!(true)),
            (json!("codex"), json!(false)),
        ]
    );
    assert_eq!(rows[0]["signed_in"], "unknown");
}

#[test]
fn account_cli_list_documented() {
    let core = Core::new(false);
    let (account, _) = core.added(Agent::Claude, "회사 계정");
    core.logged_in(&account);
    let run = |args: &[&str]| {
        let out = home::git_env::scrubbed(cli())
            .args(args)
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        String::from_utf8(out.stdout).unwrap()
    };
    let text = run(&["account", "list"]);
    let lines: Vec<Vec<&str>> = text.lines().map(|l| l.split('\t').collect()).collect();
    assert_eq!(lines[0], ["agent", "id", "label", "folder", "signed_in"]);
    assert_eq!(lines.len(), 4, "{text}");
    assert_eq!(lines[1][..3], ["claude", "own", "Default"]);
    assert_eq!(lines[2][0], "claude");
    assert_eq!(lines[2][2], "회사 계정");
    assert!(lines[2][3].ends_with(&format!("accounts/claude/{}", lines[2][1])));
    assert_eq!(lines[2][4], "yes");
    let json: Value = serde_json::from_str(&run(&["account", "list", "--json"])).unwrap();
    assert_eq!(json["accounts"].as_array().unwrap().len(), 3);
    assert_eq!(json["accounts"][1]["label"], "회사 계정");
    let docs =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/cli.md"))
            .unwrap();
    assert!(docs.contains("### `nunchiro account list [--json]`"));
}

#[test]
fn own_probe_runs_only_on_request_and_is_throttled() {
    let core = Core::new(false);
    let probes = || {
        fs::read_to_string(core.user.join("own-probes.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    fs::write(core.user.join(".claude/.logged-in"), "").unwrap();
    let (account, _) = core.added(Agent::Claude, "work");
    core.logged_in(&account);
    // Lists (owner socket, window, CLI) probe added accounts only.
    for _ in 0..3 {
        assert_eq!(core.list()[0]["signed_in"], "unknown");
    }
    assert_eq!(
        core.window(json!({"op":"account_list"}))["Ok"]["type"],
        "accounts"
    );
    let out = home::git_env::scrubbed(cli())
        .args(["account", "list"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(probes().is_empty(), "{:?}", probes());
    // The owner's check probes once; another within the minute returns that result without probing.
    let check = |agent: &str| core.owner(json!({"op":"account_check","agent":agent}));
    let r = check("claude");
    assert_eq!(r["Ok"]["type"], "account_checked", "{r}");
    let own = &r["Ok"]["account"];
    assert_eq!(
        (
            own["id"].clone(),
            own["default"].clone(),
            own["signed_in"].clone()
        ),
        (json!("own"), json!(true), json!("yes"))
    );
    assert_eq!(probes(), ["claude"]);
    assert_eq!(check("claude")["Ok"]["account"]["signed_in"], "yes");
    let windowed = core.window(json!({"op":"account_check","agent":"claude"}));
    assert_eq!(windowed["Ok"]["account"]["signed_in"], "yes", "{windowed}");
    assert_eq!(probes(), ["claude"]);
    // A list shows the last check, still without probing; each agent has its own minute.
    assert_eq!(core.list()[0]["signed_in"], "yes");
    assert_eq!(check("codex")["Ok"]["account"]["signed_in"], "no");
    assert_eq!(probes(), ["claude", "codex"]);
    // A session's check is refused like the other account requests.
    let token = core.session_token();
    assert_eq!(
        core.raw(&token, json!({"op":"account_check","agent":"claude"})),
        json!({"Err":"operation not granted"})
    );
    assert_eq!(probes().len(), 2);
    // Accounts probe 11-10: the owner's Check (`force`) probes even within the minute, once per request; a session's is
    // refused too.
    let forced = |agent: &str| core.owner(json!({"op":"account_check","agent":agent,"force":true}));
    assert_eq!(forced("claude")["Ok"]["account"]["signed_in"], "yes");
    assert_eq!(probes(), ["claude", "codex", "claude"]);
    assert_eq!(
        core.raw(
            &token,
            json!({"op":"account_check","agent":"claude","force":true})
        ),
        json!({"Err":"operation not granted"})
    );
    // An unforced check after it is answered from the forced one.
    assert_eq!(check("claude")["Ok"]["account"]["signed_in"], "yes");
    assert_eq!(probes().len(), 3);
}

// Accounts probe 11-10 round 2: a check that arrives while another caller's check of the same "Your own" runs gets that
// check's answer, never the stored "unknown" of a check in flight; a forced one joins it too. One status run in all.
#[test]
fn own_checks_at_once_share_one_probe() {
    let core = Core::new(false);
    let probes = || {
        fs::read_to_string(core.user.join("own-probes.log"))
            .unwrap_or_default()
            .lines()
            .count()
    };
    fs::write(core.user.join(".claude/.logged-in"), "").unwrap();
    fs::write(core.user.join(".claude/slow"), "").unwrap();
    let core = &core;
    let answers: Vec<Value> = thread::scope(|s| {
        let first = s.spawn(move || core.owner(json!({"op":"account_check","agent":"claude"})));
        thread::sleep(Duration::from_millis(500));
        let joined = [false, true].map(|force| {
            s.spawn(move || {
                core.owner(json!({"op":"account_check","agent":"claude","force":force}))
            })
        });
        std::iter::once(first)
            .chain(joined)
            .map(|t| t.join().unwrap())
            .collect()
    });
    for r in &answers {
        assert_eq!(r["Ok"]["account"]["signed_in"], "yes", "{r}");
    }
    assert_eq!(probes(), 1);
}

#[test]
fn machine_forwarding_refuses_accounts() {
    let core = Core::new(false);
    for request in [
        json!({"op":"account_list"}),
        json!({"op":"account_check","agent":"claude"}),
        json!({"op":"account_add","agent":"claude","label":"remote"}),
        json!({"op":"account_rename","agent":"claude","id":"0123456789abcdef0123456789abcdef","label":"remote"}),
    ] {
        let reply = core.owner(json!({"op":"remote","machine":"elsewhere","request":request}));
        assert_eq!(
            reply,
            json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "{request}"
        );
    }
    assert!(!core.home.join("accounts").exists() && !core.home.join("accounts.toml").exists());
    assert!(fs::read_to_string(core.user.join("own-probes.log")).is_err());
}

// Ticket 178 threat 1: the close-then-remove path is owner and window only. A session caller can neither remove the
// account at any step, so its credentials folder stays. (Close itself is the sessions' own grant and is not changed here.)
#[test]
fn close_and_remove_refused_for_session_caller() {
    let core = Core::new(false);
    let token = core.session_token();
    let added = core.owner(json!({"op":"account_add","agent":"claude","label":"work"}));
    let account = &added["Ok"]["account"];
    for step in ["check", "logout", "move"] {
        assert_eq!(
            core.raw(&token, json!({"op":"account_remove","agent":"claude","id":account["id"],"step":step,"leftovers":true})),
            json!({"Err":"operation not granted"}),
            "{step}"
        );
    }
    assert!(Path::new(account["folder"].as_str().unwrap()).is_dir());
}

// Ticket 323: the plan word from the Claude status JSON and nothing else from it.
#[test]
fn plan_word_from_status() {
    let signed_in: &[u8] = include_bytes!("fixtures/accounts/claude-2.1.311-signed-in.stdout");
    assert_eq!(
        accounts::parse_plan(Agent::Claude, signed_in).as_deref(),
        Some("max")
    );
    let others: [&[u8]; 5] = [
        br#"{"subscriptionType":null}"#,
        br#"{"loggedIn":true,"email":"a@b.c"}"#,
        br#"{"subscriptionType":"a@b.c"}"#,
        br#"{"subscriptionType":""}"#,
        b"not json",
    ];
    for other in others {
        assert_eq!(accounts::parse_plan(Agent::Claude, other), None);
    }
    assert_eq!(accounts::parse_plan(Agent::Codex, signed_in), None);
}

// Ticket 358: an agent that stays up until one line arrives, so a session is "already running" on an account.
fn stay_up(core: &Core) {
    fs::write(
        core.home.join("bin/claude"),
        FAKE_CLAUDE.replace("exit 2\n", "read line\n"),
    )
    .unwrap();
}
fn claude_on(core: &Core, account: Option<&str>, resume: Option<String>) -> Response {
    call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: account.map(str::to_string),
                kind: AgentKind::Claude,
                project: core.user.clone(),
                worktree: false,
                label: "on account".into(),
                args: vec![],
                model: None,
                effort: None,
                resume,
            },
        },
    )
}
fn started_on(core: &Core, account: Option<&str>, resume: Option<String>) -> Session {
    match claude_on(core, account, resume) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    }
}
fn end(core: &Core, id: &str) {
    let send = |text: &str| {
        let _ = call(
            &core.home,
            Request::SendText {
                id: id.into(),
                text: text.into(),
                composer: false,
                seen: vec![],
            },
        );
    };
    send("\r");
    let until = Instant::now() + Duration::from_secs(15);
    while core.session(id).state == SessionState::Running {
        assert!(Instant::now() < until, "session {id} never exited");
        send("exit\r"); // the agent's wrapper leaves a shell
        thread::sleep(Duration::from_millis(1500));
    }
}
fn rename(core: &Core, agent: &str, id: &Value, label: &str) -> Value {
    core.owner(json!({"op":"account_rename","agent":agent,"id":id,"label":label}))
}
fn row(core: &Core, id: &Value) -> Value {
    core.list().into_iter().find(|a| a["id"] == *id).unwrap()
}

// Ticket 358 threat 1: sessions store the label and starts resolve by it. After a rename the running session, a new
// start and a resume all stay on the same folder, and the account's own login tab keeps matching it.
#[test]
fn rename_then_launch_same_folder() {
    let core = Core::new(false);
    stay_up(&core);
    let (account, login) = core.added(Agent::Claude, "회사");
    core.logged_in(&account);
    let folder = PathBuf::from(account["folder"].as_str().unwrap());
    let running = started_on(&core, Some("회사"), None);
    let ended = started_on(&core, Some("회사"), None);
    let conversation = ended.agent_session_id.clone().unwrap();
    end(&core, &ended.id);

    let reply = rename(&core, "claude", &account["id"], "본사");
    assert!(reply.get("Ok").is_some(), "{reply}");

    let renamed = row(&core, &account["id"]);
    assert_eq!(renamed["label"], "본사");
    assert_eq!(renamed["folder"], account["folder"]);
    let registry = fs::read_to_string(core.home.join("accounts.toml")).unwrap();
    assert!(
        registry.contains("본사") && !registry.contains("회사"),
        "{registry}"
    );

    let kept = core.session(&running.id);
    assert_eq!(kept.state, SessionState::Running);
    assert_eq!(kept.account.as_deref(), Some("본사"));
    assert_eq!(kept.config_dir.as_ref(), Some(&folder));
    assert_eq!(core.session(&login.id).label, "Login: 본사");

    let fresh = started_on(&core, Some("본사"), None);
    assert_eq!(fresh.config_dir.as_ref(), Some(&folder));
    assert_eq!(fresh.account.as_deref(), Some("본사"));
    let old = claude_on(&core, Some("회사"), None).unwrap_err();
    assert!(old.contains("unknown account"), "{old}");

    let resumed = started_on(&core, None, Some(conversation.clone()));
    assert_eq!(resumed.config_dir.as_ref(), Some(&folder));
    assert_eq!(resumed.account.as_deref(), Some("본사"));
    assert_eq!(
        resumed.agent_session_id.as_deref(),
        Some(conversation.as_str())
    );

    // What a later core reads back carries the new name too.
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(
        stored.contains("본사") && !stored.contains("회사"),
        "{stored}"
    );
}

// Owner 11-16: the agent's own account is named "Default" and takes the owner's name like any other. The name lives in
// the core's settings only: no registry entry, nothing written under the agent's own config folders.
#[test]
fn own_account_is_renamed_in_settings_only() {
    let core = Core::new(false);
    let (_work, _) = core.added(Agent::Claude, "회사");
    let own = json!("own");
    let label = |agent: &str| {
        core.list()
            .into_iter()
            .find(|a| a["id"] == "own" && a["agent"] == agent)
            .unwrap()["label"]
            .clone()
    };
    assert_eq!(label("claude"), "Default");
    let (config, registry) = (
        tree(&core.user),
        fs::read(core.home.join("accounts.toml")).unwrap(),
    );

    let reply = rename(&core, "claude", &own, " 개인 ");
    assert!(reply.get("Ok").is_some(), "{reply}");
    assert_eq!(label("claude"), "개인");
    assert_eq!(label("codex"), "Default"); // each agent has its own

    for bad in ["회사", "a\u{202E}b"] {
        let reply = rename(&core, "claude", &own, bad);
        assert!(reply.get("Err").is_some(), "{bad:?}: {reply}");
    }
    let dup = rename(&core, "claude", &own, "회사");
    assert!(dup["Err"].as_str().unwrap().contains("already"), "{dup}");
    assert_eq!(label("claude"), "개인");

    let reply = rename(&core, "claude", &own, "  ");
    assert!(reply.get("Ok").is_some(), "{reply}");
    assert_eq!(label("claude"), "Default");
    let settings = fs::read_to_string(core.home.join("settings.json")).unwrap();
    assert!(!settings.contains("own_label"), "{settings}");

    assert_eq!(tree(&core.user), config, "the agent's own config changed");
    assert_eq!(fs::read(core.home.join("accounts.toml")).unwrap(), registry);
}

// Ticket 358 threat 2: two accounts of one agent never share a name, and a refused name changes nothing.
#[test]
fn rename_refuses_bad_names() {
    let core = Core::new(false);
    let (work, _) = core.added(Agent::Claude, "회사");
    let (personal, _) = core.added(Agent::Claude, "개인");
    let (codex, _) = core.added(Agent::Codex, "회사");
    let before = fs::read(core.home.join("accounts.toml")).unwrap();
    for label in ["회사", " 회사 ", "   ", "a\u{202E}b"] {
        let reply = rename(&core, "claude", &personal["id"], label);
        assert!(reply.get("Err").is_some(), "{label:?}: {reply}");
    }
    let dup = rename(&core, "claude", &personal["id"], "회사");
    assert!(dup["Err"].as_str().unwrap().contains("already"), "{dup}");
    for (agent, id) in [
        ("claude", json!("../x")),
        ("codex", work["id"].clone()), // another agent's id
    ] {
        let reply = rename(&core, agent, &id, "mine");
        assert!(reply.get("Err").is_some(), "{id}: {reply}");
    }
    assert_eq!(fs::read(core.home.join("accounts.toml")).unwrap(), before);
    // The same name under another agent is no clash, and keeping a name is not a refusal.
    let reply = rename(&core, "codex", &codex["id"], "개인");
    assert!(reply.get("Ok").is_some(), "{reply}");
    let same = rename(&core, "claude", &personal["id"], "개인");
    assert!(same.get("Ok").is_some(), "{same}");
}

// Ticket 358 threat 3: a save that fails, in the registry or in the session store, leaves the old name everywhere.
#[test]
fn rename_failed_save_leaves_old_name() {
    let core = Core::new(false);
    stay_up(&core);
    let (account, login) = core.added(Agent::Claude, "회사");
    core.logged_in(&account);
    let running = started_on(&core, Some("회사"), None);
    let registry = core.home.join("accounts.toml");
    let before = fs::read(&registry).unwrap();
    let unchanged = |reply: Value| {
        assert!(reply.get("Err").is_some(), "{reply}");
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(row(&core, &account["id"])["label"], "회사");
        assert_eq!(core.session(&running.id).account.as_deref(), Some("회사"));
        assert_eq!(core.session(&login.id).label, "Login: 회사");
    };

    // The registry cannot be replaced: no new file can be made beside it.
    let mode = fs::metadata(&core.home).unwrap().permissions();
    fs::set_permissions(&core.home, fs::Permissions::from_mode(0o500)).unwrap();
    let reply = rename(&core, "claude", &account["id"], "본사");
    fs::set_permissions(&core.home, mode).unwrap();
    unchanged(reply);

    // The session store cannot be replaced after the registry was: a folder with a file in it sits at its name.
    let sessions = core.home.join("sessions.json");
    let aside = core.home.join("sessions.aside");
    fs::rename(&sessions, &aside).unwrap();
    fs::create_dir(&sessions).unwrap();
    fs::write(sessions.join("x"), "").unwrap();
    let reply = rename(&core, "claude", &account["id"], "본사");
    fs::remove_dir_all(&sessions).unwrap();
    fs::rename(&aside, &sessions).unwrap();
    unchanged(reply);

    // Once the store is back the same rename goes through.
    let reply = rename(&core, "claude", &account["id"], "본사");
    assert!(reply.get("Ok").is_some(), "{reply}");
}

// Ticket 358: a pick whose account is gone falls back to "Your own", so no new session starts on a guess.
#[test]
fn removed_default_falls_back_to_your_own() {
    let core = Core::new(false);
    let (account, _) = core.added(Agent::Claude, "회사");
    fs::write(
        core.home.join("settings.json"),
        json!({"features": {"accounts.default.claude": "0123456789abcdef0123456789abcdef"}})
            .to_string(),
    )
    .unwrap();
    let own = core
        .list()
        .into_iter()
        .find(|a| a["agent"] == "claude" && a["default"] == true)
        .unwrap();
    assert_eq!(own["session_default"], true, "{own}");
    assert_eq!(own["fell_back"], true, "{own}");
    assert_eq!(row(&core, &account["id"])["session_default"], false);
}

// Ticket 358 threat 1: a custom model id is one argv word; only what the owner stored, and only word-shaped.
#[test]
fn a_session_launches_only_stored_custom_model_ids() {
    let core = Core::new(false);
    let reply = core.owner(json!({"op":"quit_settings","patch":{"features":{"agents.custom_models":{
        "claude":[{"id":"claude-x-preview","name":"내 모델"},{"id":"--dangerously-skip-permissions"}],
        "codex":[{"id":"gpt-x-preview"}],
    }}}}));
    assert!(reply.get("Ok").is_some(), "{reply}");
    let token = core.session_token();
    let start = |kind: &str, model: &str, effort: Value| {
        core.raw(&token, json!({"op":"start","session":{"kind":kind,"project":core.home,"label":"m","model":model,"effort":effort,"resume":null}}))
    };
    assert!(
        start("claude", "claude-x-preview", Value::Null)
            .get("Ok")
            .is_some()
    );
    assert_eq!(
        start("claude", "--dangerously-skip-permissions", Value::Null)["Err"],
        "unknown model"
    );
    assert_eq!(
        start("claude", "claude-not-stored", Value::Null)["Err"],
        "unknown model"
    );
    // Stored for Codex only.
    assert_eq!(
        start("claude", "gpt-x-preview", Value::Null)["Err"],
        "unknown model"
    );
    // A custom Codex id takes the efforts of no model: `ultra` belongs to named models.
    assert!(
        start("codex", "gpt-x-preview", json!("high"))
            .get("Ok")
            .is_some()
    );
    assert_eq!(
        start("codex", "gpt-x-preview", json!("ultra"))["Err"],
        "unknown effort for this model"
    );
}

// Ticket 358 round 2: a settings file from before custom models has no key; launches read as they did.
#[test]
fn an_old_settings_file_without_custom_models_keeps_the_catalogue() {
    let core = Core::new(false);
    let token = core.session_token();
    let start = |model: &str| {
        core.raw(&token, json!({"op":"start","session":{"kind":"claude","project":core.home,"label":"m","model":model,"effort":null,"resume":null}}))
    };
    assert!(start("opus").get("Ok").is_some());
    assert_eq!(start("claude-x-preview")["Err"], "unknown model");
}
