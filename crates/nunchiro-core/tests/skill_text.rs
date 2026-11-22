//! Every key sequence and slash command SKILL.md teaches is accepted by the real core for a session token,
//! and the rules the skill states (Esc-only dialogs, `/clear` and `/compact` only) still hold in the code.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn skill() -> String {
    fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin/skills/nunchiro/SKILL.md"
    ))
    .unwrap()
}
/// Key lists after `agent send-keys <name>` in the skill, one Vec per occurrence.
fn taught_keys(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .filter_map(|l| l.split("agent send-keys ").nth(1))
        .map(|rest| {
            let rest = rest.split(['`', '#']).next().unwrap();
            rest.split_whitespace()
                .skip(1) // <name>
                .filter(|w| !w.starts_with('<') && !w.starts_with('['))
                .map(str::to_string)
                .collect()
        })
        .filter(|keys: &Vec<String>| !keys.is_empty())
        .collect()
}
/// Inline-code words that start with a slash and name a command (`/clear`), not a path or option.
fn taught_slash(text: &str) -> Vec<String> {
    text.split('`')
        .skip(1)
        .step_by(2)
        .filter(|c| {
            c.starts_with('/') && c[1..].chars().all(|ch| ch.is_ascii_lowercase()) && c.len() > 1
        })
        .map(str::to_string)
        .collect()
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("skilltext");
        // Fake claude: a trust dialog with --fixture-dialog, otherwise a ready composer; then it just reads.
        let script = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nfor a in \"$@\"; do [ \"$a\" = --fixture-dialog ] && printf 'Trust this folder?\\n1. Yes, trust this folder\\n2. No, exit\\n' && exec cat; done\nprintf '❯ \\n'\nexec cat\n";
        fs::write(home.join("claude"), script).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("core.token").exists()
            || UnixStream::connect(core.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
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
    /// A coordinator's token, read from the environment of a shell session the owner started.
    fn coordinator_token(&self) -> String {
        let id = self.owner(json!({"op":"start","session":{"kind":"shell","project":self.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}})).unwrap()["session"]["id"].clone();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id})).unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            // The first line starts with the holder's size mark (ticket 995).
            if let Some((_, l)) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:"))
            {
                return l.trim().into();
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn worker(&self, token: &str, args: &[&str]) -> String {
        let id = self
            .call(
                token,
                json!({"op":"start","session":{"kind":"claude","project":self.home,"args":args}}),
            )
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let s = self.call(token, json!({"op":"snapshot"})).unwrap();
            let me = s["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == id)
                .unwrap()
                .clone();
            let shown = self
                .call(
                    token,
                    json!({"op":"agent_read","id":id,"source":"screen","lines":10}),
                )
                .unwrap();
            let screen = shown["text"].as_str().unwrap_or("");
            if screen.contains("Trust this folder") && !me["pending"].as_array().unwrap().is_empty()
                || screen.contains('❯')
            {
                return id;
            }
            assert!(Instant::now() < until, "worker not ready: {screen:?}");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op":"stop"}));
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn skill_teaches_only_keys_the_core_accepts_for_a_dialog() {
    let keys = taught_keys(&skill());
    assert!(!keys.is_empty(), "the skill teaches no send-keys sequence");
    let core = Core::new();
    let token = core.coordinator_token();
    for seq in keys {
        let id = core.worker(&token, &["--fixture-dialog"]);
        let r = core.call(&token, json!({"op":"agent_keys","id":id,"keys":seq}));
        assert!(
            r.is_ok(),
            "skill teaches {seq:?} but the core refuses it: {r:?}"
        );
    }
    // The rule the skill states: other keys are refused while a dialog is open.
    let id = core.worker(&token, &["--fixture-dialog"]);
    let r = core.call(
        &token,
        json!({"op":"agent_keys","id":id,"keys":["2","enter"]}),
    );
    let e = r.unwrap_err();
    assert!(
        e.contains("unverified answer keys") || e.contains("terminal-only"),
        "{e}"
    );
}

#[test]
fn skill_teaches_only_slash_commands_a_session_token_may_send() {
    let slash = taught_slash(&skill());
    assert!(
        slash.contains(&"/clear".to_string()) && slash.contains(&"/compact".to_string()),
        "{slash:?}"
    );
    let core = Core::new();
    let token = core.coordinator_token();
    for cmd in &slash {
        let id = core.worker(&token, &[]);
        let r = core.call(&token, json!({"op":"agent_prompt","id":id,"text":cmd}));
        assert!(
            r.is_ok(),
            "skill teaches {cmd} but the core refuses it: {r:?}"
        );
    }
    let id = core.worker(&token, &[]);
    let r = core.call(
        &token,
        json!({"op":"agent_prompt","id":id,"text":"/model haiku"}),
    );
    assert!(r.unwrap_err().contains("only /clear and /compact"));
}

// v1b-19
#[test]
fn skill_widgets_section_matches_the_core() {
    let text = skill();
    let section = text
        .split("## Widgets\n")
        .nth(1)
        .expect("SKILL.md has a Widgets section")
        .split("\n## ")
        .next()
        .unwrap();
    assert!(section.contains("`nunchiro widget new <name>`"));
    assert!(section.contains("Never run `nunchiro widget allow`"));
    for key in nunchiro_core::widgets::ENV_KEYS {
        assert!(section.contains(&format!("`${key}`")), "{key} not taught");
    }
    assert!(section.contains(&format!(
        "at least {}",
        nunchiro_core::widgets::MIN_INTERVAL_SECS
    )));
    assert!(section.contains("posix_spawn"));
    assert!(!section.contains("NUNCHIRO_TOKEN"));
    // v1b-22: the web widget paragraph names the setting, the entry and exactly the bridge's two methods.
    for taught in [
        "`web_widgets`",
        "kind = \"web\"",
        "entry = \"index.html\"",
        "{nunchiro: 1, id, method, params}",
        "`context`",
        "`act`",
        "click Send",
    ] {
        assert!(section.contains(taught), "{taught} not taught");
    }
}

// v1b-07
fn artifact_skill() -> String {
    fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin/skills/artifacts/SKILL.md"
    ))
    .unwrap()
}

#[test]
fn artifact_skill_cdn_list_equals_the_default_csp() {
    let csp = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../app/src-tauri/src/artifacts/csp-default.txt"
    ))
    .unwrap();
    let mut allowed: Vec<&str> = csp
        .split(';')
        .flat_map(str::split_whitespace)
        .filter(|w| w.starts_with("https://"))
        .collect();
    // v2-10c: script hosts left the default; their tags load through the library cache, whose hosts are the grammar's.
    let libraries: Vec<String> = nunchiro_core::libs::grammar::HOSTS
        .iter()
        .map(|h| format!("https://{h}"))
        .collect();
    allowed.extend(libraries.iter().map(String::as_str));
    let text = artifact_skill();
    let mut taught: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || "`(),".contains(c))
        .filter(|w| w.starts_with("https://"))
        // A host, not an example URL with a path.
        .filter(|w| w.trim_end_matches('.').matches('/').count() == 2)
        .map(|w| w.trim_end_matches('.'))
        .collect();
    allowed.sort();
    allowed.dedup();
    taught.sort();
    taught.dedup();
    assert!(!allowed.is_empty());
    assert_eq!(taught, allowed);
    // Every example URL stays on an allowed host.
    for url in text
        .split(|c: char| c.is_whitespace() || "`()".contains(c))
        .filter(|w| w.starts_with("https://"))
    {
        assert!(allowed.iter().any(|h| url.starts_with(h)), "{url}");
    }
}

#[test]
fn artifact_skill_names_the_folder_the_core_provides() {
    let text = artifact_skill();
    assert!(text.contains("$NUNCHIRO_ARTIFACTS"));
    assert!(text.contains("artifacts/<session>"));
    assert!(text.contains("nunchiro-artifact html"));
    assert!(text.contains("NUNCHIRO_ARTIFACTS is set"));
}
