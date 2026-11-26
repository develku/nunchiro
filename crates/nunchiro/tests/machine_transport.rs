#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
struct Harness {
    remote_home: Option<PathBuf>,
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new(shim: &str) -> Self {
        Self::configured(shim, None, None)
    }
    fn configured(shim: &str, settings: Option<Value>, remote: Option<&PathBuf>) -> Self {
        Self::with_env(shim, settings, remote, &[])
    }
    fn with_env(
        shim: &str,
        settings: Option<Value>,
        remote: Option<&PathBuf>,
        env: &[(&str, &str)],
    ) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let home = home::short("machine");
        let ssh = home.join("ssh");
        fs::write(&ssh, format!("#!/bin/sh\n{shim}\n")).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        if let Some(settings) = settings {
            fs::write(home.join("settings.json"), settings.to_string()).unwrap();
        }
        let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        if let Some(remote) = remote {
            command
                .env("NUNCHIRO_FAKE_REMOTE_HOME", remote)
                .env("NUNCHIRO_BIN", env!("CARGO_BIN_EXE_nunchiro"));
        }
        command
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            );
        command.envs(env.iter().copied());
        let core = command
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_SSH", ssh)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_MACHINE")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let h = Self {
            home,
            core,
            remote_home: remote.cloned(),
        };
        let until = Instant::now() + Duration::from_secs(30);
        while std::os::unix::net::UnixStream::connect(h.home.join("core.sock")).is_err() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn cli(&self, args: &[&str]) -> std::process::Output {
        let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        command
            .env("CLAUDE_CONFIG_DIR", self.home.join("claude-data"))
            .env("CODEX_HOME", self.home.join("codex-data"))
            .env("ZDOTDIR", &self.home)
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("NUNCHIRO_SSH", self.home.join("ssh"))
            .env("NUNCHIRO_BIN", env!("CARGO_BIN_EXE_nunchiro"));
        if let Some(remote) = &self.remote_home {
            command.env("NUNCHIRO_FAKE_REMOTE_HOME", remote);
        }
        command
            .args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_MACHINE")
            .output()
            .unwrap()
    }
    fn call(&self, token: Option<&str>, request: Value) -> Result<Value, String> {
        use std::io::{BufRead, BufReader, Write};
        let owner = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut s = std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        writeln!(
            s,
            "{}",
            json!({"token":token.unwrap_or(&owner),"request":request})
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.cli(&["serve", "stop", "--yes"]);
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
#[test]
fn ssh_unreachable_is_clear_and_local_core_keeps_serving() {
    let h = Harness::new("echo 'connection refused' >&2; exit 255");
    let out = h.cli(&["machine", "status", "missing"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["machines"][0]["status"], "unreachable");
    assert!(
        v["machines"][0]["error"]
            .as_str()
            .unwrap()
            .contains("connection refused")
    );
    assert!(h.cli(&["snapshot", "--json"]).status.success());
}
#[test]
fn machine_status_reports_version_mismatch() {
    let h = Harness::new("echo 'version mismatch: remote nunchiro 9.9.9' >&2; exit 42");
    let out = h.cli(&["machine", "status", "old"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["machines"][0]["status"], "version_mismatch");
}

struct Pair {
    local: Harness,
    remote: Harness,
    project: PathBuf,
}
impl Pair {
    fn new() -> Self {
        Self::remote_env(&[])
    }
    /// A pair whose other Mac's core runs with `env`.
    fn remote_env(env: &[(&str, &str)]) -> Self {
        let remote = Harness::with_env("exit 255", None, None, env);
        let project = remote.home.join("한국 프로젝트");
        fs::create_dir(&project).unwrap();
        let local_project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        let settings =
            json!({"machines":{"other":{"projects":{local_project.to_str().unwrap():project}}}});
        let shim = format!(
            "exec '{}' \"$@\"",
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/scenario/fake-ssh")
                .display()
        );
        let local = Harness::configured(&shim, Some(settings), Some(&remote.home));
        Self {
            local,
            remote,
            project,
        }
    }
    fn coordinator(&self) -> String {
        let session=self.local.call(None,json!({"op":"start","session":{"kind":"shell","project":env!("CARGO_MANIFEST_DIR"),"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}})).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            let r = self
                .local
                .call(None, json!({"op":"read","id":session["session"]["id"]}))
                .unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            if let Some(token) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return token.trim().into();
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn call(&self, token: Option<&str>, request: Value) -> Result<Value, String> {
        self.local.call(
            token,
            json!({"op":"remote","machine":"other","request":request}),
        )
    }
    fn start(&self, token: Option<&str>) -> Value {
        self.call(token,json!({"op":"start","session":{"kind":"shell","project":self.project,"label":"원격 작업","args":["/bin/cat"]}})).unwrap()["session"].clone()
    }
}
#[test]
fn coordinator_starts_in_mapped_path_and_records_remote_child() {
    let p = Pair::new();
    let token = p.coordinator();
    let child = p.start(Some(&token));
    assert_eq!(child["machine"], "other");
    assert_eq!(child["project"], p.project.to_str().unwrap());
    assert!(
        p.call(Some(&token), json!({"op":"read","id":child["id"]}))
            .is_ok()
    );
    let rows = p.call(Some(&token), json!({"op":"snapshot"})).unwrap();
    assert_eq!(rows["sessions"].as_array().unwrap().len(), 1);
}

#[test]
fn unmapped_remote_project_is_refused() {
    let p = Pair::new();
    let token = p.coordinator();
    let error=p.call(Some(&token),json!({"op":"start","session":{"kind":"shell","project":"/unmapped","args":["/bin/cat"]}})).unwrap_err();
    assert!(error.contains("mapping"), "{error}");
    let error=p.local.call(Some(&token),json!({"op":"remote","machine":"unknown","request":{"op":"start","session":{"kind":"shell","project":p.project}}})).unwrap_err();
    assert!(error.contains("not mapped"), "{error}");
}
#[test]
fn another_coordinators_remote_worker_refuses_prompt_read_and_stop() {
    let p = Pair::new();
    let a = p.coordinator();
    let b = p.coordinator();
    let child = p.start(Some(&a));
    for op in ["agent_prompt", "agent_read", "close"] {
        let e = p
            .call(
                Some(&b),
                json!({"op":op,"id":child["id"],"text":"intrusion","source":"screen","lines":10}),
            )
            .unwrap_err();
        assert!(e.contains("outside remote session grants"), "{op}: {e}");
    }
    // A worker started by the owner in another project is also unreachable.
    let other=p.remote.call(None,json!({"op":"start","session":{"kind":"shell","project":p.remote.home,"args":["/bin/cat"]}})).unwrap();
    for op in ["agent_prompt", "agent_read", "close"] {
        assert!(p.call(Some(&a),json!({"op":op,"id":other["session"]["id"],"text":"intrusion","source":"screen","lines":10})).is_err());
    }
}
#[test]
fn forged_remote_id_and_owner_only_operations_are_refused() {
    let p = Pair::new();
    let token = p.coordinator();
    for op in [
        "agent_prompt",
        "agent_read",
        "close",
        "stop",
        "quit_settings",
        "forwarded",
    ] {
        assert!(p.call(Some(&token),json!({"op":op,"id":"forged","text":"bad","source":"screen","lines":1,"patch":{},"caller":{"id":"forged","project":p.project},"request":{"op":"list"}})).is_err(),"{op}");
    }
    assert!(p.local.call(Some(&token),json!({"op":"forwarded","caller":{"id":"forged","project":p.project},"request":{"op":"list"}})).is_err());
}
#[test]
fn tokenless_owner_machine_cli_and_korean_names_work_without_ssh_config() {
    let p = Pair::new();
    let out = p.local.cli(&[
        "--machine",
        "other",
        "session",
        "start",
        "--kind",
        "shell",
        "--project",
        p.project.to_str().unwrap(),
        "--label",
        "한국 작업",
        "--",
        "/bin/cat",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["session"]["label"], "한국 작업");
    assert_eq!(value["session"]["machine"], "other");
    let out = p.local.cli(&["machine", "status", "other"]);
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["machines"][0]["status"], "reachable");
}
#[test]
fn two_remote_starts_at_once_keep_distinct_child_grants() {
    let p = Pair::new();
    let token = p.coordinator();
    let (a, b) = thread::scope(|s| {
        let a = s.spawn(|| p.start(Some(&token)));
        let b = s.spawn(|| p.start(Some(&token)));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_ne!(a["id"], b["id"]);
    for child in [a, b] {
        assert!(
            p.call(Some(&token), json!({"op":"read","id":child["id"]}))
                .is_ok()
        );
    }
}
// V2-1b: a local core restart drops the remote child authority (V1A-06: it lapses with the core's epoch), while the
// local coordinator session survives the restart in its holder and its token stays valid locally (spec V2-1 acc. 2).
#[test]
fn local_restart_drops_remote_child_authority_while_the_coordinator_survives() {
    let p = Pair::new();
    let token = p.coordinator();
    let child = p.start(Some(&token));
    assert!(p.local.cli(&["serve", "restart"]).status.success());
    let next = p.coordinator();
    assert!(
        p.call(Some(&next), json!({"op":"read","id":child["id"]}))
            .unwrap_err()
            .contains("outside remote session grants")
    );
    assert!(
        p.call(Some(&token), json!({"op":"read","id":child["id"]}))
            .unwrap_err()
            .contains("outside remote session grants")
    );
    // The old token itself is still a live local session caller.
    assert!(
        p.local.call(Some(&token), json!({"op":"list"})).unwrap()["sessions"]
            .as_array()
            .is_some_and(|s| !s.is_empty())
    );
    assert!(
        p.remote
            .call(None, json!({"op":"read","id":child["id"]}))
            .is_ok()
    );
}
// v1a-17: the ssh probe is held by a gate the test never opens rather than timed, so host load cannot fail it.
#[test]
fn slow_ssh_is_bounded_and_never_delays_local_sessions_or_snapshot() {
    // Held while `hold-ssh` exists (bounded, so a broken core cannot leave it running).
    let h = Harness::new(
        r#"d=$(dirname "$0"); : > "$d/ssh-entered"; i=0; while [ -e "$d/hold-ssh" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i + 1)); done"#,
    );
    fs::write(h.home.join("hold-ssh"), "").unwrap();
    thread::scope(|scope| {
        let pending = scope.spawn(|| h.cli(&["machine", "status", "slow"]));
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("ssh-entered").exists() {
            assert!(Instant::now() < until, "the probe never ran ssh");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(h.cli(&["snapshot", "--json"]).status.success());
        let session=h.call(None,json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/cat"]}})).unwrap();
        assert!(
            h.call(None, json!({"op":"read","id":session["session"]["id"]}))
                .is_ok()
        );
        // Only the core's own 6 s probe timeout can end the held probe, so it is still pending here.
        assert!(
            !pending.is_finished(),
            "local requests waited for the ssh probe"
        );
        let out = pending.join().unwrap();
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(
            v["machines"][0]["error"]
                .as_str()
                .unwrap()
                .contains("timed out")
        );
    });
}
#[test]
fn changed_host_key_is_refused_without_auto_accept() {
    let h = Harness::new(
        "[ \"$6\" = StrictHostKeyChecking=yes ] || exit 3; echo 'REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.' >&2; exit 255",
    );
    let out = h.cli(&["machine", "status", "changed"]);
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["machines"][0]["status"], "unreachable");
    assert!(
        v["machines"][0]["error"]
            .as_str()
            .unwrap()
            .contains("Host key verification failed")
    );
}
#[test]
fn relay_checks_actual_version_before_executing() {
    use std::io::Write;
    let h = Harness::new("exit 255");
    let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["machine", "relay"])
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_MACHINE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        c.stdin.take().unwrap(),
        "{}",
        json!({"version":"9.9.9","request":{"op":"stop"}})
    )
    .unwrap();
    let out = c.wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("version mismatch"));
    assert!(h.cli(&["snapshot", "--json"]).status.success());
}

/// The owner's `--anyway` reaches another Mac: a start held there for low memory starts with it.
#[test]
fn start_anyway_reaches_another_mac() {
    let p = Pair::remote_env(&[("NUNCHIRO_TEST_MEMORY_PRESSURE", "4")]);
    let project = p.project.to_str().unwrap();
    let start = |anyway: bool| {
        let mut args = vec!["--machine", "other", "session", "start", "--kind", "claude"];
        args.extend(["--project", project, "--label", "held"]);
        if anyway {
            args.push("--anyway");
        }
        p.local.cli(&args)
    };
    let held = start(false);
    assert!(!held.status.success());
    assert!(
        String::from_utf8_lossy(&held.stderr).contains("memory"),
        "{held:?}"
    );
    let out = start(true);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["session"]["machine"], "other");
}
#[test]
fn remote_claude_and_codex_start_prompt_wait_and_read_through_cli() {
    let p = Pair::new();
    let token = p.coordinator();
    for kind in ["claude", "codex"] {
        let child = p
            .call(
                Some(&token),
                json!({"op":"start","session":{"kind":kind,"project":p.project,"label":kind}}),
            )
            .unwrap()["session"]
            .clone();
        let id = child["id"].as_str().unwrap();
        let until = Instant::now() + Duration::from_secs(4);
        loop {
            let out = p
                .call(
                    Some(&token),
                    json!({"op":"agent_read","id":id,"source":"screen","lines":50}),
                )
                .unwrap();
            if out["text"].as_str().unwrap().contains("FIXTURE_READY") {
                break;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(30));
        }
        let out = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .args([
                "--machine",
                "other",
                "agent",
                "prompt",
                id,
                "hello",
                "--wait",
                "--until",
                "done",
                "--timeout",
                "5000",
            ])
            .env("NUNCHIRO_HOME", &p.local.home)
            .env("NUNCHIRO_TOKEN", &token)
            .env_remove("NUNCHIRO_MACHINE")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{kind}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let out = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .args([
                "--machine",
                "other",
                "agent",
                "wait",
                id,
                "--until",
                "done",
                "--timeout",
                "1000",
            ])
            .env("NUNCHIRO_HOME", &p.local.home)
            .env("NUNCHIRO_TOKEN", &token)
            .env_remove("NUNCHIRO_MACHINE")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let out = p
            .call(
                Some(&token),
                json!({"op":"agent_read","id":id,"source":"screen","lines":50}),
            )
            .unwrap();
        assert!(out["text"].as_str().unwrap().contains("ACK:hello"));
        assert!(p.call(Some(&token), json!({"op":"close","id":id})).is_ok());
    }
}
#[test]
fn remote_queue_is_labelled_in_local_snapshot_and_filtered_by_parent() {
    let p = Pair::new();
    let token = p.coordinator();
    let other = p.coordinator();
    let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"label":"결정 대기","args":["--fixture-permission"]}})).unwrap()["session"].clone();
    let until = Instant::now() + Duration::from_secs(5);
    let row = loop {
        let rows = p.local.call(None, json!({"op":"snapshot"})).unwrap();
        if let Some(row) = rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == child["id"] && !s["pending"].as_array().unwrap().is_empty())
        {
            break row.clone();
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(row["machine"], "other");
    assert_eq!(row["label"], "결정 대기");
    let rows = p
        .local
        .call(Some(&other), json!({"op":"snapshot"}))
        .unwrap();
    assert!(
        rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["id"] != child["id"])
    );
    let rows = p
        .local
        .call(Some(&token), json!({"op":"snapshot"}))
        .unwrap();
    assert!(
        rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == child["id"])
    );
    let item = &row["pending"][0]["id"];
    assert!(
        p.call(
            Some(&token),
            json!({"op":"answer","item":item,"answer":{"type":"allow_once"},"confirmed":true})
        )
        .is_err()
    );
    let result = p.call(
        Some(&token),
        json!({"op":"answer","item":item,"answer":{"type":"deny"},"confirmed":true}),
    );
    assert!(result.is_ok(), "{result:?}");
}
#[test]
fn remote_transport_repeats_grant_negative_operations_and_composed_model_guard() {
    let p = Pair::new();
    let token = p.coordinator();
    let victim = p.start(None);
    for op in [
        "send_text",
        "send_keys",
        "read",
        "close",
        "label",
        "agent_prompt",
        "agent_send",
        "agent_keys",
        "agent_read",
        "agent_get",
        "cancel_send",
        "resize",
    ] {
        let request = json!({"op":op,"id":victim["id"],"text":"INTRUSION","keys":["enter"],"label":"bad","source":"screen","lines":10,"send":"unknown","cols":80,"rows":24});
        assert!(p.call(Some(&token), request.clone()).is_err(), "{op}");
        assert!(p.call(Some("forged"), request).is_err(), "{op} forged");
    }
    let child = p
        .call(
            Some(&token),
            json!({"op":"start","session":{"kind":"claude","project":p.project}}),
        )
        .unwrap()["session"]
        .clone();
    let until = Instant::now() + Duration::from_secs(4);
    loop {
        let out = p
            .call(
                Some(&token),
                json!({"op":"agent_read","id":child["id"],"source":"screen","lines":50}),
            )
            .unwrap();
        if out["text"].as_str().unwrap().contains("❯") {
            break;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(30));
    }
    assert!(
        p.call(
            Some(&token),
            json!({"op":"agent_prompt","id":child["id"],"text":"/model haiku"})
        )
        .is_err()
    );
    assert!(
        p.call(
            Some(&token),
            json!({"op":"agent_keys","id":child["id"],"keys":["/model haiku","enter"]})
        )
        .is_err()
    );
    assert!(p.call(Some(&token),json!({"op":"start","session":{"kind":"shell","project":p.project,"resume":"unowned-id"}})).is_err());
}
#[test]
fn quit_settings_preserves_machine_project_mapping() {
    let p = Pair::new();
    let before: Value =
        serde_json::from_slice(&fs::read(p.local.home.join("settings.json")).unwrap()).unwrap();
    p.local
        .call(
            None,
            json!({"op":"quit_settings","patch":{"start_at_login":true}}),
        )
        .unwrap();
    let after: Value =
        serde_json::from_slice(&fs::read(p.local.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(before["machines"], after["machines"]);
    assert!(p.local.cli(&["serve", "restart"]).status.success());
    let token = p.coordinator();
    p.start(Some(&token));
}
#[test]
fn malformed_machine_stores_are_left_unchanged() {
    let h = Harness::new("exit 255");
    for bytes in [
        "[]",
        "{\"version\":1,\"machines\":42}",
        "{\"version\":1,\"machines\":[\"same\",\"same\"]}",
        "{\"version\":2,\"machines\":[]}",
        "{\"version\":1,\"machines\":[\"-oBad\"]}",
    ] {
        fs::write(h.home.join("machines.json"), bytes).unwrap();
        // Q9 ko-J8-1: a bad store no longer fails local snapshots; the machines list still names the error.
        assert!(h.call(None, json!({"op":"snapshot"})).is_ok(), "{bytes}");
        let error = h.call(None, json!({"op":"machine_status"})).unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(
            fs::read_to_string(h.home.join("machines.json")).unwrap(),
            bytes
        );
    }
    fs::remove_file(h.home.join("machines.json")).unwrap();
}

#[test]
fn owner_remote_serve_restart_leaves_local_core_running() {
    let p = Pair::new();
    let before = fs::read(p.local.home.join("core.token")).unwrap();
    let out = p.local.cli(&["--machine", "other", "serve", "restart"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(fs::read(p.local.home.join("core.token")).unwrap(), before);
    assert!(p.local.cli(&["snapshot", "--json"]).status.success());
    let token = p.coordinator();
    assert!(
        p.call(Some(&token), json!({"op":"remote_service","restart":true}))
            .is_err()
    );
}

#[test]
fn local_permission_policy_controls_remote_answers_in_both_directions() {
    for local_enabled in [false, true] {
        let remote = Harness::configured(
            "exit 255",
            Some(json!({"permission_answers":{env!("CARGO_MANIFEST_DIR"): !local_enabled}})),
            None,
        );
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        let settings = json!({"permission_answers":{project.to_str().unwrap():local_enabled},"machines":{"other":{"projects":{project.to_str().unwrap():project}}}});
        let shim = format!(
            "exec '{}' \"$@\"",
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/scenario/fake-ssh")
                .display()
        );
        let local = Harness::configured(&shim, Some(settings), Some(&remote.home));
        let p = Pair {
            local,
            remote,
            project,
        };
        let token = p.coordinator();
        for use_keys in [false, true] {
            let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"args":["--fixture-permission"]}})).unwrap()["session"].clone();
            let until = Instant::now() + Duration::from_secs(5);
            let row = loop {
                let rows = p.local.call(None, json!({"op":"snapshot"})).unwrap();
                if let Some(row) = rows["sessions"].as_array().unwrap().iter().find(|s| {
                    s["id"] == child["id"] && !s["pending"].as_array().unwrap().is_empty()
                }) {
                    break row.clone();
                }
                assert!(Instant::now() < until);
                thread::sleep(Duration::from_millis(30));
            };
            let request = if use_keys {
                json!({"op":"agent_keys","id":child["id"],"keys":["1","enter"]})
            } else {
                json!({"op":"answer","item":row["pending"][0]["id"],"answer":{"type":"allow_once"},"confirmed":true})
            };
            let result = p.call(Some(&token), request);
            if local_enabled {
                // V2-8e: past the local policy; the fixture's prompt is screen only (risky), which no agent may allow.
                assert!(
                    result
                        .as_ref()
                        .is_err_and(|e| e.contains("an agent cannot allow a risky request")),
                    "{result:?}"
                );
            } else {
                assert!(result.unwrap_err().contains("permission_answers_disabled"));
            }
        }
    }
}
#[test]
fn remote_queued_send_is_delivered_when_worker_becomes_ready() {
    let p = Pair::new();
    let token = p.coordinator();
    let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"args":["--fixture-busy"]}})).unwrap()["session"].clone();
    let until = Instant::now() + Duration::from_secs(4);
    loop {
        let out = p
            .call(
                Some(&token),
                json!({"op":"agent_read","id":child["id"],"source":"screen","lines":50}),
            )
            .unwrap();
        if out["text"].as_str().unwrap().contains("FIXTURE_READY") {
            break;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(30));
    }
    let result = p
        .call(
            Some(&token),
            json!({"op":"agent_send","id":child["id"],"text":"queued hello"}),
        )
        .unwrap();
    assert_eq!(result["send"]["status"], "queued");
    p.call(
        Some(&token),
        json!({"op":"agent_keys","id":child["id"],"keys":["esc"]}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let row = p
            .call(Some(&token), json!({"op":"agent_get","id":child["id"]}))
            .unwrap();
        if let Some(send) = row["session"]["send_log"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == result["send"]["id"] && s["status"] != "queued")
        {
            assert_eq!(send["status"], "delivered");
            break;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(30));
    }
}
/// A session on another machine that waits at a start question: the machine that drives it shows the question as one
/// card on that session's row (the window reads this snapshot), the owner's prompt is kept in the row's queue and the
/// CLI names the machine and how to drop the prompt; answered in the session's terminal, the prompt goes in.
#[test]
fn remote_start_question_is_one_card_on_the_driving_machine_and_keeps_the_prompt() {
    let p = Pair::new();
    let child = p
        .call(None, json!({"op":"start","session":{"kind":"claude","project":p.project,"label":"worker","args":["--fixture-dialog","--fixture-box-after"]}}))
        .unwrap()["session"]
        .clone();
    let row = || {
        p.local.call(None, json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == child["id"])
            .cloned()
            .unwrap_or_default()
    };
    wait_for("the question's card", || {
        row()["pending"][0]["kind"] == "dialog"
    });
    let out = p.local.cli(&[
        "--machine",
        "other",
        "agent",
        "prompt",
        "worker",
        "hello",
        "--wait",
        "--until",
        "done",
        "--timeout",
        "4000",
    ]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{err}");
    assert!(
        err.contains("worker waits at a question in its terminal on other")
            && err.contains("The prompt is queued")
            && err.contains("nunchiro --machine other agent cancel"),
        "{err}"
    );
    wait_for("the kept prompt on the row", || {
        row()["send_queue"][0]["status"] == "queued"
    });
    let shown = row();
    assert_eq!(shown["machine"], "other");
    assert_eq!(shown["label"], "worker");
    assert_eq!(shown["pending"].as_array().unwrap().len(), 1, "{shown}");
    assert_eq!(shown["send_queue"][0]["content"], "hello");
    // The owner answers in the session's terminal; the kept prompt is delivered.
    p.call(
        None,
        json!({"op":"send_keys","id":child["id"],"keys":["1","enter"]}),
    )
    .unwrap();
    wait_for("the delivery", || {
        p.call(None, json!({"op":"agent_get","id":child["id"]}))
            .unwrap()["session"]["send_log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["content"] == "hello" && s["status"] == "delivered")
    });
}
#[test]
fn stopping_core_reaps_inflight_snapshot_transport() {
    let h = Harness::new("echo $$ > \"$NUNCHIRO_HOME/helper.pid\"; sleep 30");
    fs::write(
        h.home.join("machines.json"),
        "{\"version\":1,\"machines\":[\"slow\"]}",
    )
    .unwrap();
    h.call(None, json!({"op":"snapshot"})).unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    while !h.home.join("helper.pid").exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let pid = fs::read_to_string(h.home.join("helper.pid")).unwrap();
    assert!(h.cli(&["serve", "stop", "--yes"]).status.success());
    let until = Instant::now() + Duration::from_secs(8);
    while h.home.join("core.sock").exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

// Merge invariant: the newly merged window APIs must not acquire an SSH/delegated route.
#[test]
fn merged_chat_files_and_approvals_remain_local_owner_only() {
    let p = Pair::new();
    let token = p.coordinator();
    for request in [
        json!({"op":"chat_page","id":"session-1"}),
        json!({"op":"files_list","root":"data","path":""}),
        json!({"op":"file_read","root":"data","path":"images/example.png"}),
        json!({"op":"files_search","root":"data","query":"example"}),
        json!({"op":"approval_status","name":"example"}),
        json!({"op":"approval_grant","name":"example","level":"read","hash":"0".repeat(64)}),
    ] {
        let error = p.call(None, request.clone()).unwrap_err();
        assert!(
            error.contains("remote forwarding is not permitted"),
            "{error}"
        );
        let error = p.call(Some(&token), request.clone()).unwrap_err();
        assert!(error.contains("operation not granted"), "{error}");
        for caller_token in [None, Some(token.as_str())] {
            let error = p.local.call(caller_token, json!({
                "op":"forwarded",
                "caller":{"id":"merge-caller","project":p.project,"permission_answers":false},
                "request":request
            })).unwrap_err();
            assert!(error.contains("operation not granted"), "{error}");
        }
    }
    assert!(
        !p.local.home.join("machines.json").exists(),
        "refused operations must not reach SSH registration"
    );
}

// V2-12m-a: a local core whose ssh is the scripted fake remote in `nunchiro-core/tests/fixtures/machines/fake-ssh`.
// Nothing connects anywhere; the fake reads and logs under `<home>/fake`.
const PROTOCOL: u32 = nunchiro_core::machines::PROTOCOL;
fn fake_shim() -> String {
    format!(
        "exec '{}' \"$@\"",
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../nunchiro-core/tests/fixtures/machines/fake-ssh")
            .display()
    )
}
fn fake_core(protocol: u32) -> Harness {
    let h = Harness::configured(
        &fake_shim(),
        Some(json!({"machines":{"box":{"projects":{}}}})),
        None,
    );
    fs::create_dir(h.home.join("fake")).unwrap();
    fs::write(h.home.join("fake/protocol"), protocol.to_string()).unwrap();
    h
}
fn spawns(h: &Harness) -> Vec<String> {
    fs::read_to_string(h.home.join("fake/spawns"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}
fn masters(h: &Harness) -> usize {
    spawns(h)
        .iter()
        .filter(|s| s.contains("ControlMaster=yes"))
        .count()
}
fn row(id: &str, items: &[&str]) -> Value {
    let mut s = serde_json::from_str::<Value>(include_str!(
        "../../nunchiro-core/tests/fixtures/board/snapshot-v1a.json"
    ))
    .unwrap()["Ok"]["sessions"][0]
        .clone();
    s["id"] = id.into();
    s["state"] = "running".into();
    s["pending"] = items
        .iter()
        .map(|item| json!({"id":item,"session_id":id,"scope":"tool","kind":"permission","text":"Run ls?","choices":[],"sources":["hook"],"observed_at":1,"actionable":true,"reconciled":false,"hook_event_id":null}))
        .collect();
    s
}
// What the remote core reports now: one line, swapped in whole so the fake never sends half of it.
fn push(h: &Harness, rows: Vec<Value>) {
    let tmp = h.home.join("fake/state.tmp");
    fs::write(&tmp, json!({"type":"sessions","sessions":rows}).to_string()).unwrap();
    fs::rename(tmp, h.home.join("fake/state")).unwrap();
}
fn remote_rows(h: &Harness) -> Vec<Value> {
    h.call(None, json!({"op":"snapshot"})).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["machine"] == "box")
        .cloned()
        .collect()
}
fn pending_ids(h: &Harness) -> Vec<String> {
    let mut ids: Vec<String> = remote_rows(h)
        .iter()
        .flat_map(|s| s["pending"].as_array().unwrap().clone())
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}
fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn machine(h: &Harness, alias: &str) -> Value {
    h.call(None, json!({"op":"machine_status","label":alias}))
        .unwrap()["machines"][0]
        .clone()
}
fn wait_channel(h: &Harness, state: &str) -> Value {
    let mut last = Value::Null;
    wait_for(&format!("channel {state}"), || {
        last = machine(h, "box");
        last["channel"]["state"] == state
    });
    last
}
fn connect(h: &Harness) -> Value {
    h.call(None, json!({"op":"snapshot"})).unwrap();
    wait_channel(h, "up")
}
fn remote(h: &Harness, request: Value) -> Result<Value, String> {
    h.call(
        None,
        json!({"op":"remote","machine":"box","request":request}),
    )
}
#[test]
fn control_path_is_0700_under_nunchiro_home() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let h = fake_core(PROTOCOL);
    connect(&h);
    let dir = h.home.join("mux");
    let meta = fs::symlink_metadata(&dir).unwrap();
    assert!(meta.is_dir());
    assert_eq!(meta.permissions().mode() & 0o777, 0o700);
    let master = spawns(&h)
        .into_iter()
        .find(|s| s.contains("ControlMaster=yes"))
        .unwrap();
    let path = master
        .split(' ')
        .find_map(|a| a.strip_prefix("ControlPath="))
        .unwrap();
    assert_eq!(std::path::Path::new(path).parent().unwrap(), dir);
    // OpenSSH binds `<path>.<16 random characters>` before renaming; macOS sun_path holds 103 bytes.
    assert!(path.len() + 17 <= 103, "{path}");
    for case in ["loose", "symlink"] {
        let h = fake_core(PROTOCOL);
        let dir = h.home.join("mux");
        if case == "loose" {
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        } else {
            let other = h.home.join("elsewhere");
            fs::create_dir(&other).unwrap();
            fs::set_permissions(&other, fs::Permissions::from_mode(0o700)).unwrap();
            symlink(&other, &dir).unwrap();
        }
        h.call(None, json!({"op":"snapshot"})).unwrap();
        let v = wait_channel(&h, "down");
        assert!(
            v["channel"]["error"].as_str().unwrap().contains("refused"),
            "{v}"
        );
        assert_eq!(v["status"], "unreachable");
        assert!(spawns(&h).is_empty(), "{case}: ssh ran");
        let meta = fs::symlink_metadata(&dir).unwrap();
        if case == "loose" {
            assert_eq!(
                meta.permissions().mode() & 0o777,
                0o755,
                "never chmod-fixed"
            );
        } else {
            assert!(meta.file_type().is_symlink());
        }
    }
    let error = nunchiro_core::machines::private_dir(std::path::Path::new("/usr")).unwrap_err();
    assert!(error.contains("owned by another user"), "{error}");
}
#[test]
fn ssh_config_is_untouched() {
    let h = fake_core(PROTOCOL);
    let config = h.home.join("fake/ssh_config");
    fs::write(&config, "Host box\n  HostName 127.0.0.1\n  User me\n").unwrap();
    let before = fs::read(&config).unwrap();
    push(&h, vec![row("r1", &["d1"])]);
    connect(&h);
    wait_for("d1", || pending_ids(&h) == ["d1"]);
    remote(
        &h,
        json!({"op":"answer","item":"d1","answer":{"type":"deny"}}),
    )
    .unwrap();
    assert_eq!(fs::read(&config).unwrap(), before);
    let lines = spawns(&h);
    assert!(
        lines
            .iter()
            .any(|l| l.contains("-o ControlMaster=yes") && l.contains("-o ControlPersist=no"))
    );
    assert!(lines.iter().any(|l| l.contains("-o ControlMaster=no")));
    for line in lines {
        let args: Vec<&str> = line.split(' ').collect();
        for flag in ["-F", "-S", "-M", "-G", "-O"] {
            assert!(!args.contains(&flag), "{line}");
        }
        for (i, arg) in args.iter().enumerate() {
            if arg.starts_with("Control") {
                assert_eq!(args[i - 1], "-o", "{line}");
            }
        }
    }
}
#[test]
fn strict_host_key_and_batch_mode_kept() {
    let h = fake_core(PROTOCOL);
    fs::write(h.home.join("fake/hostkey"), "").unwrap();
    h.call(None, json!({"op":"snapshot"})).unwrap();
    let v = wait_channel(&h, "down");
    assert!(
        v["channel"]["error"]
            .as_str()
            .unwrap()
            .contains("Host key verification failed"),
        "{v}"
    );
    fs::remove_file(h.home.join("fake/hostkey")).unwrap();
    wait_channel(&h, "up");
    let lines = spawns(&h);
    assert!(lines.len() >= 2);
    for line in lines {
        assert!(line.contains("-o BatchMode=yes"), "{line}");
        assert!(line.contains("-o StrictHostKeyChecking=yes"), "{line}");
        assert!(!line.contains("StrictHostKeyChecking=no"));
        assert!(!line.contains("accept-new"));
    }
}
#[test]
fn events_are_pushed_without_polling() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &[])]);
    connect(&h);
    wait_for("the remote row", || remote_rows(&h).len() == 1);
    assert_eq!(spawns(&h).len(), 1, "only the master ran ssh");
    push(&h, vec![row("r1", &["d1"])]);
    wait_for("the pushed item", || pending_ids(&h) == ["d1"]);
    assert_eq!(spawns(&h).len(), 1, "no ssh after the master is up");
    assert!(
        !h.home.join("fake/requests").exists(),
        "no request reached the remote"
    );
}
#[test]
fn version_window_accepts_current_and_previous() {
    for (protocol, state) in [
        (PROTOCOL, "up"),
        (PROTOCOL - 1, "up"),
        (PROTOCOL - 2, "version_mismatch"),
        (PROTOCOL + 1, "version_mismatch"),
        (u32::MAX, "version_mismatch"),
    ] {
        let h = fake_core(protocol);
        h.call(None, json!({"op":"snapshot"})).unwrap();
        let v = wait_channel(&h, state);
        if state == "up" {
            assert_eq!(v["status"], "reachable");
            assert_eq!(v["channel"]["remote_protocol"], protocol);
        } else {
            assert_eq!(v["status"], "version_mismatch");
            let error = v["channel"]["error"].as_str().unwrap();
            assert!(
                error.contains(&format!("remote protocol {protocol}")),
                "{error}"
            );
            assert!(
                error.contains(&format!("local protocol {PROTOCOL}")),
                "{error}"
            );
            let before = spawns(&h).len();
            let refused = remote(&h, json!({"op":"list"})).unwrap_err();
            assert!(refused.contains("version mismatch"), "{refused}");
            assert_eq!(
                spawns(&h).len(),
                before,
                "a mismatched machine gets no request"
            );
        }
        assert_eq!(v["channel"]["local_protocol"], PROTOCOL);
        // Nothing was sent to the remote core, so nothing restarted it.
        assert!(!h.home.join("fake/requests").exists());
    }
}
#[test]
fn remote_answer_through_relay_matches_local() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["allow-me", "deny-me"])]);
    connect(&h);
    wait_for("both items", || pending_ids(&h) == ["allow-me", "deny-me"]);
    let allow =
        json!({"op":"answer","item":"allow-me","answer":{"type":"allow_once"},"confirmed":true});
    let deny = json!({"op":"answer","item":"deny-me","answer":{"type":"deny"},"confirmed":false});
    remote(&h, allow.clone()).unwrap();
    remote(&h, deny.clone()).unwrap();
    // A repeated answer never leaves the local core.
    let before = spawns(&h).len();
    assert!(remote(&h, allow.clone()).is_err());
    assert!(
        remote(
            &h,
            json!({"op":"answer","item":"never-pushed","answer":{"type":"deny"}})
        )
        .is_err()
    );
    assert_eq!(spawns(&h).len(), before);
    let text = fs::read_to_string(h.home.join("fake/requests")).unwrap();
    assert!(!text.contains("always"), "{text}");
    let sent: Vec<Value> = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(sent.len(), 2, "{text}");
    assert_eq!(sent[0]["request"], allow);
    assert_eq!(sent[1]["request"], deny);
    assert!(sent.iter().all(|s| s["protocol"] == PROTOCOL));
    // Both answers rode the master instead of opening their own connection.
    assert_eq!(
        spawns(&h)
            .iter()
            .filter(|s| s.contains("-o ControlMaster=no") && s.contains("ControlPath="))
            .count(),
        2
    );
    assert_eq!(masters(&h), 1);
}
#[test]
fn dropped_master_reconnects_and_misses_nothing() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a"])]);
    connect(&h);
    wait_for("a", || pending_ids(&h) == ["a"]);
    let pid = fs::read_to_string(h.home.join("fake/master.pid")).unwrap();
    assert!(
        Command::new("/bin/kill")
            .args(["-9", pid.trim()])
            .status()
            .unwrap()
            .success()
    );
    // Raised while no master runs.
    push(&h, vec![row("r1", &["a", "b"]), row("r2", &["c"])]);
    let mut seen = false;
    wait_for("reconnect", || {
        let state = machine(&h, "box")["channel"]["state"].clone();
        seen |= state == "reconnecting";
        seen && state == "up"
    });
    wait_for("the gap's items", || pending_ids(&h) == ["a", "b", "c"]);
    assert_eq!(masters(&h), 2);
    for _ in 0..5 {
        assert_eq!(pending_ids(&h), ["a", "b", "c"], "none lost or duplicated");
        thread::sleep(Duration::from_millis(50));
    }
}
#[test]
fn hostile_machine_inputs_rejected() {
    let h = fake_core(PROTOCOL);
    let long = "b".repeat(129);
    for alias in [
        "-oProxyCommand=touch /tmp/nunchiro-pwned",
        "-p",
        "--",
        "box -p 2222",
        " box",
        "box\n",
        "box\u{0}x",
        "ProxyCommand=sh",
        "me@box",
        "box:22",
        "",
        long.as_str(),
    ] {
        let error = h
            .call(
                None,
                json!({"op":"remote","machine":alias,"request":{"op":"list"}}),
            )
            .unwrap_err();
        assert!(
            error.contains("invalid machine alias"),
            "{alias:?}: {error}"
        );
        let error = h
            .call(None, json!({"op":"machine_status","label":alias}))
            .unwrap_err();
        assert!(
            error.contains("invalid machine alias"),
            "{alias:?}: {error}"
        );
    }
    assert!(spawns(&h).is_empty());
    // Hostile aliases in settings never reach ssh either.
    let bad = Harness::configured(
        &fake_shim(),
        Some(json!({"machines":{"-oProxyCommand=x":{"projects":{}},"a b":{"projects":{}}}})),
        None,
    );
    fs::create_dir(bad.home.join("fake")).unwrap();
    bad.call(None, json!({"op":"snapshot"})).unwrap();
    thread::sleep(Duration::from_millis(300));
    assert!(spawns(&bad).is_empty());
    // Hostile relay lines are dropped; only well-formed rows of the remote's own items arrive.
    let mut junk = b"not json\n\xff\xfe\n[1,2]\n{\"type\":\"exec\",\"command\":\"touch /tmp/nunchiro-pwned\"}\n".to_vec();
    junk.extend_from_slice(b"{\"type\":\"hello\",\"protocol\":2,\"version\":\"9\"}\n{\"type\":\"sessions\",\"sessions\":\"nope\"}\n");
    junk.extend_from_slice(
        b"{\"op\":\"answer\",\"item\":\"ok\",\"answer\":{\"type\":\"allow_once\"}}\n",
    );
    fs::write(h.home.join("fake/junk"), junk).unwrap();
    let mut forged = row("r1", &["ok", "ok"]);
    let mut stray = row("other", &["stray"]);
    stray["pending"][0]["session_id"] = "r1".into();
    forged["pending"]
        .as_array_mut()
        .unwrap()
        .push(stray["pending"][0].clone());
    forged["pending"][2]["session_id"] = "elsewhere".into();
    push(
        &h,
        vec![
            forged,
            row("../escape", &["x"]),
            row("r1", &["dup"]),
            row("bad id", &["y"]),
        ],
    );
    connect(&h);
    wait_for("the clean row", || pending_ids(&h) == ["ok"]);
    assert_eq!(remote_rows(&h).len(), 1);
    assert!(
        !h.home.join("fake/requests").exists(),
        "no relay line answered anything"
    );
    assert!(!std::path::Path::new("/tmp/nunchiro-pwned").exists());
    // An oversize line drops the master; the channel reconnects and the core keeps serving.
    fs::write(h.home.join("fake/oversize"), "").unwrap();
    let pid = fs::read_to_string(h.home.join("fake/master.pid")).unwrap();
    Command::new("/bin/kill")
        .args(["-9", pid.trim()])
        .status()
        .unwrap();
    wait_for("the oversize line", || {
        !h.home.join("fake/oversize").exists()
    });
    wait_for("a clean reconnect", || masters(&h) >= 3);
    wait_channel(&h, "up");
    assert_eq!(pending_ids(&h), ["ok"]);
    assert!(h.cli(&["snapshot", "--json"]).status.success());
}
#[test]
fn session_token_cannot_start_a_master() {
    let h = fake_core(PROTOCOL);
    let session = h.call(None, json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}})).unwrap();
    let mut token = String::new();
    wait_for("the session token", || {
        let r = h
            .call(None, json!({"op":"read","id":session["session"]["id"]}))
            .unwrap();
        let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
        if let Some(t) = String::from_utf8_lossy(&data)
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
        {
            token = t.trim().into();
        }
        !token.is_empty()
    });
    h.call(Some(&token), json!({"op":"snapshot"})).unwrap();
    thread::sleep(Duration::from_millis(300));
    assert!(spawns(&h).is_empty(), "a session token started ssh");
    assert!(machine(&h, "box")["channel"].is_null());
    connect(&h);
    assert_eq!(masters(&h), 1);
}
#[test]
fn real_relay_says_hello_and_takes_the_next_protocol_only() {
    use std::io::{BufRead, BufReader, Write};
    let h = Harness::new("exit 255");
    let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["machine", "relay", "--stream"])
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_MACHINE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(c.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let hello: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], PROTOCOL);
    line.clear();
    out.read_line(&mut line).unwrap();
    let rows: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(rows["type"], "sessions");
    assert!(rows["sessions"].is_array());
    // Closing the master's stdin ends the relay.
    drop(c.stdin.take());
    assert!(c.wait().unwrap().success());
    for (protocol, ok) in [
        (PROTOCOL, true),
        (PROTOCOL + 1, true),
        (PROTOCOL + 2, false),
    ] {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .args(["machine", "relay"])
            .env("NUNCHIRO_HOME", &h.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_MACHINE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(
            c.stdin.take().unwrap(),
            "{}",
            json!({"version":"0.0.0-other","protocol":protocol,"request":{"op":"list"}})
        )
        .unwrap();
        let out = c.wait_with_output().unwrap();
        assert_eq!(out.status.success(), ok, "protocol {protocol}");
        if !ok {
            assert!(String::from_utf8_lossy(&out.stderr).contains("version mismatch"));
        }
    }
}
#[test]
fn v1a_remote_without_a_channel_is_a_version_mismatch() {
    let h = fake_core(PROTOCOL);
    fs::write(h.home.join("fake/v1a"), "").unwrap();
    h.call(None, json!({"op":"snapshot"})).unwrap();
    let v = wait_channel(&h, "version_mismatch");
    assert_eq!(v["status"], "version_mismatch");
    assert!(
        v["channel"]["error"]
            .as_str()
            .unwrap()
            .contains("protocol 1"),
        "{v}"
    );
    assert!(!h.home.join("fake/requests").exists());
}
#[test]
fn master_ends_when_the_core_dies() {
    let mut h = fake_core(PROTOCOL);
    connect(&h);
    let pid = fs::read_to_string(h.home.join("fake/master.pid")).unwrap();
    h.core.kill().unwrap();
    h.core.wait().unwrap();
    wait_for("the master to end", || {
        !Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    });
}
#[test]
fn a_push_read_before_the_answer_landed_does_not_offer_it_again() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a", "b"])]);
    connect(&h);
    wait_for("both items", || pending_ids(&h) == ["a", "b"]);
    remote(
        &h,
        json!({"op":"answer","item":"a","answer":{"type":"deny"}}),
    )
    .unwrap();
    // The remote still lists `a` in a push built before the answer reached it.
    push(&h, vec![row("r1", &["a", "b", "c"])]);
    wait_for("c", || pending_ids(&h).contains(&"c".to_string()));
    assert_eq!(pending_ids(&h), ["b", "c"]);
    assert!(
        remote(
            &h,
            json!({"op":"answer","item":"a","answer":{"type":"deny"}})
        )
        .is_err()
    );
    // Once a push no longer holds it, the remote is done with it; a later item with that id shows again.
    push(&h, vec![row("r1", &["b"])]);
    wait_for("a gone", || pending_ids(&h) == ["b"]);
    push(&h, vec![row("r1", &["a", "b"])]);
    wait_for("a again", || pending_ids(&h) == ["a", "b"]);
    let text = fs::read_to_string(h.home.join("fake/requests")).unwrap();
    assert_eq!(text.lines().filter(|l| !l.is_empty()).count(), 1, "{text}");
}
// V2-12m-a r2
#[test]
fn answer_stays_listed_when_remembering_the_machine_fails() {
    use std::os::unix::fs::PermissionsExt;
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a"])]);
    connect(&h);
    wait_for("a", || pending_ids(&h) == ["a"]);
    // `machines.json` cannot be written while the data folder is read-only.
    fs::set_permissions(&h.home, fs::Permissions::from_mode(0o500)).unwrap();
    let result = remote(
        &h,
        json!({"op":"answer","item":"a","answer":{"type":"deny"}}),
    );
    fs::set_permissions(&h.home, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err(), "{result:?}");
    assert_eq!(pending_ids(&h), ["a"]);
    assert!(!h.home.join("fake/requests").exists());
}
#[test]
fn applied_answer_with_a_lost_reply_is_answered_once() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a"])]);
    connect(&h);
    wait_for("a", || pending_ids(&h) == ["a"]);
    let answer = json!({"op":"answer","item":"a","answer":{"type":"deny"}});
    fs::write(h.home.join("fake/lost-reply"), "").unwrap();
    assert!(remote(&h, answer.clone()).is_err());
    // Not known to have landed, so it is offered again.
    assert_eq!(pending_ids(&h), ["a"]);
    fs::remove_file(h.home.join("fake/lost-reply")).unwrap();
    // The relay took the first answer; the retry is not applied again.
    fs::write(h.home.join("fake/reply"), r#"{"Err":"already answered"}"#).unwrap();
    remote(&h, answer.clone()).unwrap();
    assert!(pending_ids(&h).is_empty());
    assert!(remote(&h, answer).is_err(), "the row is gone");
}
#[test]
fn answer_to_an_item_the_remote_no_longer_holds_is_refused_and_dropped() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a", "b"])]);
    connect(&h);
    wait_for("a and b", || pending_ids(&h) == ["a", "b"]);
    fs::write(h.home.join("fake/reply"), r#"{"Err":"decision not found"}"#).unwrap();
    let error = remote(
        &h,
        json!({"op":"answer","item":"a","answer":{"type":"deny"}}),
    )
    .unwrap_err();
    assert!(error.contains("decision not found"), "{error}");
    assert_eq!(pending_ids(&h), ["b"]);
}
#[test]
fn relay_takes_one_answer_per_item() {
    use std::io::Write;
    let p = Pair::new();
    let token = p.coordinator();
    let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"args":["--fixture-permission"]}})).unwrap()["session"].clone();
    let mut item = Value::Null;
    wait_for("the remote item", || {
        let rows = p.local.call(None, json!({"op":"snapshot"})).unwrap();
        if let Some(row) = rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == child["id"] && !s["pending"].as_array().unwrap().is_empty())
        {
            item = row["pending"][0]["id"].clone();
        }
        !item.is_null()
    });
    let answer = json!({"op":"answer","item":item,"answer":{"type":"deny"}});
    p.call(None, answer.clone()).unwrap();
    let relay = |request: &Value| -> Value {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .args(["machine", "relay"])
            .env("NUNCHIRO_HOME", &p.remote.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_MACHINE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(
            c.stdin.take().unwrap(),
            "{}",
            json!({"version":env!("CARGO_PKG_VERSION"),"protocol":PROTOCOL,"request":request})
        )
        .unwrap();
        serde_json::from_slice(&c.wait_with_output().unwrap().stdout).unwrap()
    };
    // The same answer again never reaches the remote queue.
    assert_eq!(relay(&answer)["Err"], "already answered");
    // A refused answer releases its claim: the queue answers each try itself.
    let unknown = json!({"op":"answer","item":"never-pending","answer":{"type":"deny"}});
    for _ in 0..2 {
        assert_eq!(relay(&unknown)["Err"], "decision not found");
    }
    assert_eq!(
        relay(&json!({"op":"answer","item":"../x","answer":{"type":"deny"}}))["Err"],
        "invalid decision id"
    );
}
// V2-12m-a r3
fn remote_item(p: &Pair, child: &Value) -> String {
    let mut item = String::new();
    wait_for("the remote item", || {
        let rows = p.local.call(None, json!({"op":"snapshot"})).unwrap();
        if let Some(row) = rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == child["id"] && !s["pending"].as_array().unwrap().is_empty())
        {
            item = row["pending"][0]["id"].as_str().unwrap().into();
        }
        !item.is_empty()
    });
    // Queue ids are `store::new_id` UUIDs: within the relay claim's 80-character `[A-Za-z0-9-]` limit.
    assert_eq!(item.len(), 36);
    assert!(item.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    item
}
fn listed(p: &Pair, item: &str) -> bool {
    p.local.call(None, json!({"op":"snapshot"})).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| {
            s["pending"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["id"] == item)
        })
}
fn relay_once(home: &PathBuf, request: &Value) -> Value {
    use std::io::Write;
    let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["machine", "relay"])
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_MACHINE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        c.stdin.take().unwrap(),
        "{}",
        json!({"version":env!("CARGO_PKG_VERSION"),"protocol":PROTOCOL,"request":request})
    )
    .unwrap();
    serde_json::from_slice(&c.wait_with_output().unwrap().stdout).unwrap()
}
#[test]
fn stale_claim_with_the_item_still_pending_applies_once() {
    use std::os::unix::fs::PermissionsExt;
    let p = Pair::new();
    let token = p.coordinator();
    let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"args":["--fixture-permission"]}})).unwrap()["session"].clone();
    let item = remote_item(&p, &child);
    // An earlier relay claimed this answer and died before applying it.
    let claims = p.remote.home.join("relay-answered");
    fs::create_dir(&claims).unwrap();
    fs::set_permissions(&claims, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(claims.join(&item), "").unwrap();
    let answer = json!({"op":"answer","item":item,"answer":{"type":"deny"}});
    p.call(None, answer.clone()).unwrap();
    wait_for("the row to go", || !listed(&p, &item));
    // The remote core itself applied it: its queue no longer holds the item.
    let remote_rows = p.remote.call(None, json!({"op":"snapshot"})).unwrap();
    assert!(
        !remote_rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["pending"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["id"] == item)),
        "the stale claim blocked the answer"
    );
    // Applied once: the remote no longer holds it, so another try is "already answered".
    assert_eq!(
        relay_once(&p.remote.home, &answer)["Err"],
        "already answered"
    );
}
#[test]
fn stale_claim_after_the_answer_applied_reports_already_answered() {
    let p = Pair::new();
    let token = p.coordinator();
    let child=p.call(Some(&token),json!({"op":"start","session":{"kind":"claude","project":p.project,"args":["--fixture-permission"]}})).unwrap()["session"].clone();
    let item = remote_item(&p, &child);
    let answer = json!({"op":"answer","item":item,"answer":{"type":"deny"}});
    // Applied by a relay whose reply never got back; its claim stays.
    assert_eq!(relay_once(&p.remote.home, &answer)["Ok"]["type"], "ack");
    // The retry is not applied again (local mapping of this reply: `applied_answer_with_a_lost_reply_is_answered_once`).
    assert_eq!(
        relay_once(&p.remote.home, &answer)["Err"],
        "already answered"
    );
    wait_for("the row to go", || !listed(&p, &item));
}
#[test]
fn a_second_push_still_listing_an_answered_item_shows_it_again() {
    let h = fake_core(PROTOCOL);
    push(&h, vec![row("r1", &["a"])]);
    connect(&h);
    wait_for("a", || pending_ids(&h) == ["a"]);
    remote(
        &h,
        json!({"op":"answer","item":"a","answer":{"type":"deny"}}),
    )
    .unwrap();
    // One push built before the answer landed: still hidden.
    push(&h, vec![row("r1", &["a", "b"])]);
    wait_for("b", || pending_ids(&h).contains(&"b".to_string()));
    assert_eq!(pending_ids(&h), ["b"]);
    // A second push that still lists it: the remote still waits, so it shows again.
    push(&h, vec![row("r1", &["a", "b", "c"])]);
    wait_for("a again", || pending_ids(&h) == ["a", "b", "c"]);
}
#[cfg(target_os = "macos")]
mod ssh_login {
    use super::*;
    // A relay that an SSH login runs must not start the core as that login's child: on macOS such a core, and every agent
    // it starts, cannot read the login keychain. The core is started through the user's login session (a one-shot launchd
    // job); `launchctl` here is a script that stands in for it.
    struct SshLogin {
        local: Harness,
        remote_home: PathBuf,
    }
    impl SshLogin {
        /// `launchctl`: the script's body; it gets the relay's environment (`NUNCHIRO_HOME` is the remote home).
        fn new(launchctl: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let remote_home = home::short("machine");
            let script = remote_home.join("launchctl");
            fs::write(
                &script,
                format!(
                    "#!/bin/sh\necho \"$@\" >> \"$NUNCHIRO_HOME/launchctl.log\"\n{launchctl}\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
            let shim = format!(
                "export SSH_CONNECTION='192.0.2.1 50000 192.0.2.2 22' NUNCHIRO_LAUNCHCTL='{}'\nexec '{}' \"$@\"",
                script.display(),
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../scripts/scenario/fake-ssh")
                    .display()
            );
            let local = Harness::configured(
                &shim,
                Some(json!({"machines":{"other":{"projects":{}}}})),
                Some(&remote_home),
            );
            // The owner's first snapshot opens the channel; its relay finds no core on the other side and starts one.
            local.call(None, json!({"op":"snapshot"})).unwrap();
            wait_for("the remote core", || {
                std::os::unix::net::UnixStream::connect(remote_home.join("core.sock")).is_ok()
            });
            Self { local, remote_home }
        }
        fn started_env(&self) -> Value {
            let record = fs::read(self.remote_home.join("core.start.json")).unwrap();
            serde_json::from_slice::<Value>(&record).unwrap()["env"].clone()
        }
        fn launchctl_log(&self) -> String {
            fs::read_to_string(self.remote_home.join("launchctl.log")).unwrap_or_default()
        }
    }
    impl Drop for SshLogin {
        fn drop(&mut self) {
            let _ = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
                .args(["serve", "stop", "--yes"])
                .env("NUNCHIRO_HOME", &self.remote_home)
                .env_remove("NUNCHIRO_TOKEN")
                .env_remove("NUNCHIRO_MACHINE")
                .output();
            let until = Instant::now() + Duration::from_secs(5);
            while self.remote_home.join("core.sock").exists() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = fs::remove_dir_all(&self.remote_home);
        }
    }
    #[test]
    fn relay_in_an_ssh_login_starts_the_core_through_the_login_session() {
        // launchd runs the job with its own environment: nothing of the SSH login is in it.
        let p = SshLogin::new(
            "[ \"$1\" = bootstrap ] || exit 0\ncp \"$3\" \"$NUNCHIRO_HOME/job.plist\"\nenv -u SSH_CONNECTION -u NUNCHIRO_LAUNCHCTL \"$NUNCHIRO_BIN\" serve start --here >/dev/null 2>&1 &",
        );
        let uid = unsafe { libc::getuid() };
        let log = p.launchctl_log();
        assert!(log.contains(&format!("bootstrap gui/{uid} ")), "{log}");
        let job = fs::read_to_string(p.remote_home.join("job.plist")).unwrap();
        assert!(
            job.contains("<string>serve</string><string>start</string><string>--here</string>"),
            "{job}"
        );
        assert!(
            job.contains(&format!(
                "<key>NUNCHIRO_HOME</key><string>{}</string>",
                p.remote_home.display()
            )),
            "{job}"
        );
        assert!(p.started_env()["SSH_CONNECTION"].is_null());
        // Nothing stays behind: the job is removed from launchd, and its file is gone.
        wait_for("the job's removal", || {
            p.launchctl_log()
                .contains(&format!("bootout gui/{uid}/dev.nunchiro.core-start."))
        });
        let file = log.lines().next().unwrap().rsplit(' ').next().unwrap();
        assert!(
            file.ends_with(".plist") && !std::path::Path::new(file).exists(),
            "{log}"
        );
        // The rows arrive and the machine reads as usual.
        wait_for("the channel", || {
            machine(&p.local, "other")["channel"]["state"] == "up"
        });
        assert!(machine(&p.local, "other")["channel"]["error"].is_null());
    }
    #[test]
    fn core_started_inside_an_ssh_login_is_reported_on_the_driving_machine() {
        // Nobody is logged in at that Mac: launchd has no login session to start the job in.
        let p = SshLogin::new("[ \"$1\" != bootstrap ] || exit 125");
        assert!(p.started_env()["SSH_CONNECTION"].is_string());
        let mut last = Value::Null;
        wait_for("the sign-in note", || {
            last = machine(&p.local, "other");
            last["channel"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("may not be signed in"))
        });
        assert_eq!(last["channel"]["state"], "up", "{last}");
        assert_eq!(last["status"], "reachable", "{last}");
        let note = last["channel"]["error"].as_str().unwrap();
        assert!(
            note.contains("other") && note.contains("serve restart"),
            "{note}"
        );
    }
}
