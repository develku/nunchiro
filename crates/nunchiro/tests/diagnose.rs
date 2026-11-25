//! V2-13b: `nunchiro diagnose` writes a local bundle from an allow-list. Redaction proves patterns and registered
//! tokens only; the sentinels with no known shape prove the files they sit in are never read.
#[path = "../../nunchiro-core/tests/fixtures/git_env.rs"]
mod git_env;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    net::TcpListener,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
const ANT: &str = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
const OPENAI: &str = "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GITHUB: &str = "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SLACK: &str = "xoxb-1234567890-DDDDDDDDDD";
const AWS: &str = "AKIAABCDEFGHIJKLMNOP";
const JWT: &str = "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJlZGF0YQ";
const SESSION_TOKEN: &str = "session-token-0123456789abcdefABCDEF";
const PLAIN: [&str; 6] = [
    "LOGIN-PTY-SENTINEL-line",
    "ENV-SENTINEL-value",
    "CREDENTIAL-FILE-SENTINEL",
    "SCROLLBACK-SENTINEL-text",
    "TRANSCRIPT-SENTINEL-text",
    "UNKNOWN-KEY-SENTINEL",
];

struct Home {
    home: PathBuf,
}
impl Home {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch");
        fs::create_dir_all(&root).unwrap();
        let home = root.canonicalize().unwrap().join(format!(
            "dg{:x}-{:x}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&home).unwrap();
        fs::create_dir(home.join("bin")).unwrap();
        Self { home }
    }
    fn write(&self, rel: &str, text: impl AsRef<[u8]>) {
        let path = self.home.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn cli(&self, name: &str, script: &str) {
        let path = self.home.join("bin").join(name);
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn run(&self) -> Output {
        git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("diagnose")
            .env_clear()
            .env("NUNCHIRO_TEST_OPENER", "record") // ticket 840: env_clear drops what `scrubbed` set
            .env("NUNCHIRO_HOME", &self.home)
            .env("HOME", &self.home)
            .env("PATH", format!("{}/bin:/usr/bin:/bin", self.home.display()))
            .env("SENTINEL_ENV", PLAIN[1])
            .output()
            .unwrap()
    }
    fn bundle(&self) -> PathBuf {
        let out = self.run();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let path = PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
        assert!(path.starts_with(self.home.join("diagnose")), "{path:?}");
        path
    }
    fn tree(&self) -> BTreeSet<String> {
        fn walk(dir: &Path, base: &Path, out: &mut BTreeSet<String>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                out.insert(p.strip_prefix(base).unwrap().display().to_string());
                if e.file_type().unwrap().is_dir() {
                    walk(&p, base, out);
                }
            }
        }
        let mut out = BTreeSet::new();
        walk(&self.home, &self.home, &mut out);
        out
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

fn allowlist() -> Value {
    serde_json::from_str(include_str!("diagnose_allowlist.json")).unwrap()
}
fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}
fn names(v: &Value) -> BTreeSet<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().into())
        .collect()
}
fn json_of(bundle: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(bundle.join(name)).unwrap()).unwrap()
}
fn files(bundle: &Path) -> BTreeSet<String> {
    fs::read_dir(bundle)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect()
}
fn session_row(id: &str, label: &str) -> Value {
    json!({
        "id": id, "kind": "claude", "project": "/work/p", "cwd": "/work/p", "label": label,
        "state": "closed", "agent_session_id": null, "agent_version": "1.0", "untested": false, "pid": null,
        "pending": [{"x": 1}, {"x": 2}],
        "scrollback": PLAIN[3], "transcript": PLAIN[4], "send_log": [{"text": PLAIN[3]}]
    })
}
fn store(sessions: Vec<Value>, live: Value) -> String {
    json!({"version": 2, "sessions": sessions, "live": live}).to_string()
}

#[test]
fn diagnose_bundle_holds_only_allow_listed_fields() {
    let h = Home::new();
    h.write(
        "settings.json",
        json!({
            "disable_hook_injection": true, "worktrees_dir": "/work/trees", "stale_after_ms": 5,
            "permission_answers": {"/work/p": true}, "session_lifetime": "keep_running", "start_at_login": false,
            "script_widgets": false, "web_widgets": false, "machines": {}, "unknown_key": PLAIN[5],
            "extra_token": ANT
        })
        .to_string(),
    );
    let live = json!({"s1": {"token_sha256": "a".repeat(64),
        "holder": {"socket": "/tmp/h.sock", "protocol": 1, "pid": std::process::id(), "started": 1}}});
    h.write(
        "sessions.json",
        store(vec![session_row("s1", "build")], live),
    );
    h.write("sessions.json.v1", "{}");
    let bundle = h.bundle();
    let list = allowlist();
    assert_eq!(files(&bundle), names(&list["files"]));
    for name in ["versions.json", "snapshot.json", "status.json"] {
        assert_eq!(
            keys(&json_of(&bundle, name)),
            names(&list["exact"][name]),
            "{name}"
        );
    }
    let settings = json_of(&bundle, "settings.json");
    assert!(
        keys(&settings).is_subset(&names(&list["subset"]["settings.json"])),
        "{settings}"
    );
    assert_eq!(settings["dropped"], json!(["extra_token", "unknown_key"]));
    for s in json_of(&bundle, "snapshot.json")["sessions"]
        .as_array()
        .unwrap()
    {
        assert_eq!(keys(s), names(&list["exact"]["session"]));
    }
    let status = json_of(&bundle, "status.json");
    for f in status["state_files"].as_array().unwrap() {
        assert!(
            keys(f).is_subset(&names(&list["subset"]["state_file"])),
            "{f}"
        );
    }
    for holder in status["holders"].as_array().unwrap() {
        assert_eq!(keys(holder), names(&list["exact"]["holder"]));
    }
    assert_eq!(status["holders"][0]["alive"], true);
    assert_eq!(
        json_of(&bundle, "snapshot.json")["sessions"][0]["pending_count"],
        2
    );
}

#[test]
fn diagnose_sentinels_never_appear() {
    let h = Home::new();
    let secrets = [ANT, OPENAI, GITHUB, SLACK, AWS, JWT, SESSION_TOKEN];
    let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string();
    h.write(
        "settings.json",
        json!({"worktrees_dir": ANT, "unknown_key": PLAIN[5]}).to_string(),
    );
    let label = format!("{OPENAI} {GITHUB} {SLACK}");
    let live = json!({"s1": {"token_sha256": hash, "holder": null}});
    h.write(
        "sessions.json",
        store(vec![session_row("s1", &label)], live),
    );
    let log: String = [
        format!("start NUNCHIRO_TOKEN={SESSION_TOKEN}"),
        format!("keys {ANT} {OPENAI} {GITHUB} {SLACK} {AWS} {JWT}"),
        format!("Authorization: Bearer {SESSION_TOKEN}"),
    ]
    .iter()
    .map(|l| format!("{l}\n"))
    .collect();
    h.write("logs/core.log", log);
    h.write("login/pty.log", PLAIN[0]);
    h.write("credentials.json", PLAIN[2]);
    h.write("sessions/s1.scrollback", PLAIN[3]);
    h.write("exports/s1.txt", PLAIN[3]);
    h.write(".claude/projects/p/t.jsonl", PLAIN[4]);
    h.write(".codex/auth.json", PLAIN[2]);
    // The agent CLIs run with PATH only: a leaked environment would put the env sentinel in versions.json.
    h.cli(
        "claude",
        &format!("echo \"claude 1.2.3 $SENTINEL_ENV {ANT}\""),
    );
    h.cli("codex", "echo \"codex $HOME\"");
    let bundle = h.bundle();
    let all: Vec<u8> = files(&bundle)
        .iter()
        .flat_map(|f| fs::read(bundle.join(f)).unwrap())
        .collect();
    let text = String::from_utf8_lossy(&all);
    for s in secrets
        .iter()
        .map(|s| s.to_string())
        .chain(PLAIN.iter().map(|s| s.to_string()))
        .chain([hash])
    {
        assert!(!text.contains(&s), "sentinel {s} leaked into the bundle");
    }
    assert!(text.contains("[redacted:"), "redaction markers expected");
    assert!(
        json_of(&bundle, "versions.json")["claude"]
            .as_str()
            .unwrap()
            .starts_with("claude 1.2.3")
    );
}

#[test]
fn diagnose_never_uploads_or_starts_the_core() {
    let h = Home::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    h.write(
        "settings.json",
        json!({"worktrees_dir": format!("http://127.0.0.1:{port}/")}).to_string(),
    );
    h.write("logs/core.log", "line\n");
    let before = h.tree();
    let out = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .arg("diagnose")
        .env_clear()
        .env("NUNCHIRO_TEST_OPENER", "record") // ticket 840: env_clear drops what `scrubbed` set
        .env("NUNCHIRO_HOME", &h.home)
        .env("HOME", &h.home)
        .env("PATH", "/usr/bin:/bin")
        .env("HTTP_PROXY", format!("http://127.0.0.1:{port}"))
        .env("HTTPS_PROXY", format!("http://127.0.0.1:{port}"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        listener.accept().is_err(),
        "a connection reached the listener"
    );
    let added: Vec<String> = h.tree().difference(&before).cloned().collect();
    assert!(added.iter().all(|p| p.starts_with("diagnose")), "{added:?}");
    assert!(!h.home.join("core.sock").exists());
    let ps = Command::new("ps")
        .args(["-axo", "command"])
        .output()
        .unwrap();
    let ps = String::from_utf8_lossy(&ps.stdout);
    let home = h.home.display().to_string();
    assert!(!ps.lines().any(|l| l.contains("serve") && l.contains(&home)));
}

fn utc_stamp(secs: u64) -> String {
    // Civil date from days since the epoch (Hinnant's algorithm).
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[test]
fn diagnose_dir_and_files_are_owner_only() {
    let h = Home::new();
    fs::create_dir(h.home.join("diagnose")).unwrap();
    fs::set_permissions(h.home.join("diagnose"), fs::Permissions::from_mode(0o755)).unwrap();
    let elsewhere = h.home.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    for t in now - 2..now + 30 {
        let _ = symlink(&elsewhere, h.home.join("diagnose").join(utc_stamp(t)));
    }
    let bundle = h.bundle();
    let mode = |p: &Path| fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&bundle), 0o700);
    assert_eq!(mode(&h.home.join("diagnose")), 0o700);
    for f in files(&bundle) {
        assert_eq!(mode(&bundle.join(f)), 0o600);
    }
    assert!(
        fs::read_dir(&elsewhere).unwrap().next().is_none(),
        "a planted link was followed"
    );
    // The data folder itself a link: refused, nothing written through it.
    let h2 = Home::new();
    let target = h2.home.join("target");
    fs::create_dir(&target).unwrap();
    symlink(&target, h2.home.join("diagnose")).unwrap();
    let out = h2.run();
    assert!(!out.status.success());
    assert!(fs::read_dir(&target).unwrap().next().is_none());
}

#[test]
fn diagnose_log_tail_is_bounded_and_redacted_again() {
    let h = Home::new();
    let mut log = vec![];
    let filler = format!("{}\n", "x".repeat(99));
    while log.len() < 10 * 1024 * 1024 {
        log.extend_from_slice(filler.as_bytes());
    }
    log.extend_from_slice(format!("last OPENAI_API_KEY=plainsecretvalue99 {GITHUB}\n").as_bytes());
    h.write("logs/core.log", log);
    let bundle = h.bundle();
    let tail = fs::read(bundle.join("core.log.tail")).unwrap();
    assert!(tail.len() <= 64 * 1024, "{}", tail.len());
    let text = String::from_utf8(tail).unwrap();
    assert!(text.lines().count() <= 200);
    assert!(text.lines().last().unwrap().starts_with("last "));
    assert!(!text.contains("plainsecretvalue99") && !text.contains(GITHUB));

    // Redaction lengthens a short token into its marker: 200 lines of 320 bytes (under 64 KiB raw) must still fit.
    let h = Home::new();
    let line = format!("{}\n", "sk-ant-aaaaaaaaaa ".repeat(17));
    h.write("logs/core.log", line.repeat(200));
    let tail = fs::read(h.bundle().join("core.log.tail")).unwrap();
    assert!(
        tail.len() <= 64 * 1024 && tail.len() > 32 * 1024,
        "{}",
        tail.len()
    );
}

#[test]
fn diagnose_survives_missing_and_aside_state() {
    let h = Home::new();
    let bundle = h.bundle();
    assert_eq!(json_of(&bundle, "snapshot.json")["sessions"], json!([]));
    assert_eq!(fs::read(bundle.join("core.log.tail")).unwrap(), b"");
    assert_eq!(json_of(&bundle, "status.json")["state_files"], json!([]));

    let h = Home::new();
    let future = json!({"version": 99, "sessions": []}).to_string();
    h.write("sessions.json", &future);
    h.write("sessions.json.v7.1700000000.aside", "{}");
    let bundle = h.bundle();
    // Read-only: the core's own load would have set the version-99 file aside.
    assert_eq!(
        fs::read_to_string(h.home.join("sessions.json")).unwrap(),
        future
    );
    let files = json_of(&bundle, "status.json")["state_files"].clone();
    let kind = |name: &str| {
        files
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .map(|f| f["kind"].clone())
    };
    assert_eq!(
        kind("sessions.json.v7.1700000000.aside"),
        Some(json!("aside"))
    );
    assert_eq!(kind("sessions.json"), Some(json!("other-version")));
}

// Ticket 752 round 3: a sessions.json with token records is version 3, written by this same build; the bundle lists
// its sessions and calls it the store, not another core's.
#[test]
fn diagnose_reads_a_version_3_store() {
    let h = Home::new();
    let records = json!([{"kind": "claude", "conversation": "c1", "origin": "token-a"}]);
    let body = json!({"version": 3, "sessions": [session_row("s1", "build")], "token_conversations": records});
    h.write("sessions.json", body.to_string());
    let bundle = h.bundle();
    assert_eq!(json_of(&bundle, "snapshot.json")["sessions"][0]["id"], "s1");
    let files = json_of(&bundle, "status.json")["state_files"].clone();
    assert_eq!(files[0]["name"], "sessions.json");
    assert_eq!(files[0]["kind"], "store");
    assert_eq!(files[0]["version"], 3);
}

#[test]
fn diagnose_is_documented() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let run = Command::new("sh")
        .arg("scripts/check-cli-docs.sh")
        .current_dir(&root)
        .env("NUNCHIRO_BIN", env!("CARGO_BIN_EXE_nunchiro"))
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
}

fn bundle_text(bundle: &Path) -> String {
    let all: Vec<u8> = files(bundle)
        .iter()
        .flat_map(|f| fs::read(bundle.join(f)).unwrap())
        .collect();
    String::from_utf8_lossy(&all).into_owned()
}

#[test]
fn diagnose_drops_nested_and_mistyped_settings() {
    let h = Home::new();
    h.write(
        "settings.json",
        json!({
            "machines": {"prod": {"ssh_pass": "hunter2-NESTED"}},
            "worktrees_dir": {"api_note": "opaque-NESTED2"},
            "start_at_login": "pw=xyz-plain",
            "stale_after_ms": "5",
            "session_lifetime": "forever",
            "keep_history": "yes-NESTED4",
            "mask_history": null,
            "live_pr_status": "yes-NESTED5",
            "pr_watch": ["https://github.com/o/r/pull/1", "token-NESTED6"],
            "permission_answers": {"/work/p": "yes-NESTED3"},
            "web_widgets": true
        })
        .to_string(),
    );
    let bundle = h.bundle();
    let text = bundle_text(&bundle);
    for s in [
        "hunter2-NESTED",
        "opaque-NESTED2",
        "pw=xyz-plain",
        "yes-NESTED3",
        "yes-NESTED4",
        "yes-NESTED5",
        "token-NESTED6",
    ] {
        assert!(!text.contains(s), "{s} leaked");
    }
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(
        settings["dropped"],
        json!([
            "keep_history",
            "live_pr_status",
            "machines (1 entries)",
            "mask_history",
            "permission_answers",
            "pr_watch",
            "session_lifetime",
            "stale_after_ms",
            "start_at_login",
            "worktrees_dir"
        ])
    );
    assert_eq!(settings["web_widgets"], true);
}

#[test]
fn diagnose_settings_keys_match_core() {
    let core = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nunchiro-core/src/sessions.rs"),
    )
    .unwrap();
    let body = core
        .split("struct Settings {")
        .nth(1)
        .expect("struct Settings")
        .split("\n}")
        .next()
        .unwrap();
    let fields: BTreeSet<String> = body
        .lines()
        .filter(|l| l.starts_with("    ") && !l.trim_start().starts_with("//"))
        .filter(|l| !l.trim_start().starts_with("#[")) // a field's attribute line
        .filter_map(|l| {
            l.trim()
                .split(':')
                .next()
                .map(|n| n.trim_start_matches("pub ").to_string())
        })
        .filter(|n| n != "user_home") // ticket 1083: `serde(skip)`, read from $HOME, never in settings.json
        .collect();
    let listed: BTreeSet<String> = names(&allowlist()["subset"]["settings.json"])
        .into_iter()
        .filter(|k| k != "dropped")
        .collect();
    assert_eq!(
        fields, listed,
        "core Settings fields and the diagnose allow-list differ"
    );
    // Every core field, with a valid value, is kept: the binary's own key list and shape check match the core.
    let valid = json!({
        "machines": {"m": {"projects": {"/a": "/b"}}}, "disable_hook_injection": true, "worktrees_dir": "/w",
        "stale_after_ms": 5, "permission_answers": {"/p": true}, "session_lifetime": "end_with_app",
        "start_at_login": true, "script_widgets": true, "web_widgets": true,
        "keep_history": null, "mask_history": false,
        "live_pr_status": true, "live_pr_offered": false, "pr_watch": ["https://github.com/o/r/pull/1"],
        "auto_clean_worktrees": true, "keep_awake": false, "usage_link_roots": ["/w/links"],
        "orchestration": {"enabled": true, "level": "team", "max_workers": null, "max_depth": 3, "merge": "ask",
            "auto_close_finished": true},
        "features": {}
    });
    assert_eq!(
        fields,
        keys(&valid),
        "add a valid sample for the new Settings field"
    );
    let h = Home::new();
    h.write("settings.json", valid.to_string());
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(settings["dropped"], json!([]));
    assert_eq!(keys(&settings).len(), fields.len() + 1);
    // v2-8c round 2: watched PR links name private repositories; only their count enters a bundle.
    assert_eq!(settings["pr_watch"], json!(1));
    assert!(!bundle_text(&h.bundle()).contains("github.com/o/r"));
    // V2.5-31: a string or path anywhere in `orchestration` drops the whole key.
    for bad in [
        json!({"level": "/Users/me/secret"}),
        json!({"max_workers": "3"}),
        json!({"enabled": true, "note": "x"}),
        json!("team"),
    ] {
        h.write("settings.json", json!({"orchestration": bad}).to_string());
        let settings = json_of(&h.bundle(), "settings.json");
        assert_eq!(settings["dropped"], json!(["orchestration"]), "{bad}");
        assert!(!bundle_text(&h.bundle()).contains("secret"));
    }
}

// Ticket 26 (V2-13b follow-up): `machines.<name>.projects` keys and values must be well-formed absolute paths. One bad
// path (control character, hidden character, relative, non-path, over 4096 bytes) drops that entry only (V2-13b), counted
// in `dropped` without a name, and none of its text reaches the bundle.
#[test]
fn diagnose_machine_project_paths_allow_listed() {
    let h = Home::new();
    let long = format!("/{}", "a".repeat(4096));
    let bad_paths = [
        "/w/ctl\u{7}char-BADPATH",
        "/w/zero\u{200b}width-BADPATH",
        "/w/bidi\u{202e}over-BADPATH",
        "/w/tag\u{e0041}-BADPATH",
        "/w/braille\u{2800}-BADPATH",
        "relative/BADPATH",
        "not a path BADPATH",
        "",
        long.as_str(),
    ];
    for bad in bad_paths {
        for projects in [json!({"/ok": bad}), json!({bad: "/ok"})] {
            h.write(
                "settings.json",
                json!({"machines": {"m": {"projects": projects}}, "web_widgets": true}).to_string(),
            );
            let bundle = h.bundle();
            let settings = json_of(&bundle, "settings.json");
            assert_eq!(
                settings["dropped"],
                json!(["machines (1 entries)"]),
                "{projects}"
            );
            assert_eq!(settings["machines"], json!({"m": {"projects": {}}}));
            assert!(
                !bundle_text(&bundle).contains("BADPATH"),
                "{projects} leaked"
            );
        }
    }
    // One bad path drops that entry only, even next to a good machine.
    h.write(
        "settings.json",
        json!({"machines": {"a": {"projects": {"/ok": "/ok2"}}, "b": {"projects": {"/x": "rel-BADPATH"}}}}).to_string(),
    );
    let bundle = h.bundle();
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["machines (1 entries)"]));
    assert_eq!(
        settings["machines"],
        json!({"a": {"projects": {"/ok": "/ok2"}}, "b": {"projects": {}}})
    );
    assert!(!bundle_text(&bundle).contains("BADPATH"));
}

// Review r1 MUST: the invisible Hangul fillers are letters to `char::is_alphanumeric` but draw nothing, so the path rule
// must be the core's `shown`, not a second list.
#[test]
fn diagnose_path_refuses_hangul_fillers() {
    let h = Home::new();
    for filler in ['\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}'] {
        h.write(
            "settings.json",
            json!({"machines": {"m": {"projects": {"/ok": format!("/w/a{filler}b-BADPATH")}}}})
                .to_string(),
        );
        let bundle = h.bundle();
        let settings = json_of(&bundle, "settings.json");
        assert_eq!(
            settings["dropped"],
            json!(["machines (1 entries)"]),
            "U+{:04X}",
            filler as u32
        );
        assert!(!bundle_text(&bundle).contains("BADPATH"));
    }
    let ok = json!({"m": {"projects": {"/Users/김/프로젝트": "/srv/한글 폴더"}}});
    h.write("settings.json", json!({"machines": ok}).to_string());
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(settings["dropped"], json!([]));
    assert_eq!(settings["machines"], ok);
}

#[test]
fn diagnose_machine_project_paths_ordinary_kept() {
    let h = Home::new();
    let machines = json!({
        "mini": {"projects": {"/Users/a/proj": "/Users/a/proj", "/w/a b": "/srv/한글 폴더/é"}},
        "book": {"projects": {"/w/a b": "/Users/b/proj-2"}}
    });
    h.write("settings.json", json!({"machines": machines}).to_string());
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(settings["dropped"], json!([]));
    assert_eq!(settings["machines"], machines);
}

// V2-13b (v25-diagnose-machine-names): the keys of `machines` must pass the core's machine-name rule
// (`nunchiro_core::machines::valid_alias`). A path or a sentence as a name drops that machine only, counted as
// `machines (N entries)` without naming it; the other machines stay.
#[test]
fn diagnose_machine_name_shape_checked() {
    let h = Home::new();
    let good = json!({"projects": {"/ok": "/ok2"}});
    for bad in [
        "/Users/me/clients/acme-private-deal-BADNAME",
        "ship acme on 11-20 BADNAME",
        "-leading-dash-BADNAME",
        "",
    ] {
        h.write(
            "settings.json",
            json!({"machines": {"mini": good, bad: good.clone()}}).to_string(),
        );
        let bundle = h.bundle();
        let settings = json_of(&bundle, "settings.json");
        assert_eq!(settings["machines"], json!({"mini": good}), "{bad}");
        assert_eq!(
            settings["dropped"],
            json!(["machines (1 entries)"]),
            "{bad}"
        );
        assert!(!bundle_text(&bundle).contains("BADNAME"), "{bad} leaked");
    }
    // Two bad names count two; a bad value shape (not `{"projects": ...}`) counts as a dropped machine too.
    h.write(
        "settings.json",
        json!({"machines": {"a b": good.clone(), "/p": good.clone(), "ok": {"ssh_pass": "x"}}})
            .to_string(),
    );
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(settings["machines"], json!({}));
    assert_eq!(settings["dropped"], json!(["machines (3 entries)"]));
}

// One bad project path drops that path only: the machine's other paths and the other machines stay, and the count
// says how many entries went without naming them.
#[test]
fn diagnose_machines_filtered_per_entry() {
    let h = Home::new();
    h.write(
        "settings.json",
        json!({"machines": {
            "mini": {"projects": {"/w/one": "/r/one", "/w/ctl\u{7}-BADPATH": "/r/two", "/w/three": "rel-BADPATH"}},
            "book": {"projects": {"/w/b": "/r/b"}}
        }})
        .to_string(),
    );
    let bundle = h.bundle();
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(
        settings["machines"],
        json!({"mini": {"projects": {"/w/one": "/r/one"}}, "book": {"projects": {"/w/b": "/r/b"}}})
    );
    assert_eq!(settings["dropped"], json!(["machines (2 entries)"]));
    assert!(!bundle_text(&bundle).contains("BADPATH"));
}

// A machine name that passes `valid_alias` but is shaped like an IP address or a token (one the redactor or the hex mask
// would change) drops that machine only: counted, never named. Before, the final whole-key redact check dropped every
// machine, and an IP or hex name rode into the bundle.
const REDACTED_SHAPES: [&str; 5] = [
    "10.0.0.5",
    "0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
];

#[test]
fn diagnose_machine_name_redacted_shape_drops_one() {
    let h = Home::new();
    let good = json!({"projects": {"/ok": "/ok2"}});
    for bad in REDACTED_SHAPES {
        assert!(nunchiro_core::machines::valid_alias(bad).is_ok(), "{bad}");
        h.write(
            "settings.json",
            json!({"machines": {"macbook": good, bad: good.clone(), "mini": good.clone()}})
                .to_string(),
        );
        let settings = json_of(&h.bundle(), "settings.json");
        assert_eq!(
            settings["machines"],
            json!({"macbook": good, "mini": good}),
            "{bad}"
        );
        assert_eq!(
            settings["dropped"],
            json!(["machines (1 entries)"]),
            "{bad}"
        );
    }
}

#[test]
fn diagnose_machine_name_redacted_shape_absent() {
    let h = Home::new();
    let good = json!({"projects": {"/ok": "/ok2"}});
    for bad in REDACTED_SHAPES {
        h.write(
            "settings.json",
            json!({"machines": {"macbook": good, bad: good.clone()}}).to_string(),
        );
        assert!(!bundle_text(&h.bundle()).contains(bad), "{bad} leaked");
    }
}

#[test]
fn diagnose_machines_good_entry_kept() {
    let h = Home::new();
    let machines = json!({
        "mini": {"projects": {"/Users/a/proj": "/srv/proj", "/w/a b": "/srv/한글 폴더/é"}},
        "book.local": {"projects": {}}
    });
    h.write("settings.json", json!({"machines": machines}).to_string());
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(settings["dropped"], json!([]));
    assert_eq!(settings["machines"], machines);
}

// Ticket 250 r3: a bundle keeps a `features` entry only when its key is a known feature id
// (`nunchiro_core::api::KNOWN_FEATURES`) and its value a flag or null. Any other entry (a number included) is dropped
// and counted under `dropped` without its key, so neither a path key, a text value nor a number reaches the bundle.
// The unit test `known_features_keep_only_known_ids_with_flags` holds the known-id half too; the bundle half below holds
// the count line and the redaction.
#[test]
fn diagnose_features_drop_numbers() {
    // Needs 225: the Codex reset flags are known ids. A flag survives; the agent mode (a word) and the weekly cap (a
    // number) under their own keys are counted and dropped like any other value.
    // v25f: `git.branch_prefix` holds text, which a bundle drops like any text value (the last case below).
    assert_eq!(
        nunchiro_core::api::KNOWN_FEATURES,
        [
            "git.branch_prefix",
            "git.auto_pull",
            "usage.codex_resets",
            "usage.codex_reset_weekly_only",
            "usage.codex_reset_keep_last",
            "usage.codex_reset_expiring",
            "env.inherit_shell",
            "env.names",
            "env.strip_secrets",
            "env.keep_secrets",
        ],
        "add a known id below when one ships"
    );
    let h = Home::new();
    h.write(
        "settings.json",
        json!({"features": {"usage.codex_resets": true, "usage.codex_reset_keep_last": null,
            "usage.codex_reset_agent": "allow", "usage.codex_reset_week_max": 48213}})
        .to_string(),
    );
    let settings = json_of(&h.bundle(), "settings.json");
    assert_eq!(
        settings["features"],
        json!({"usage.codex_resets": true, "usage.codex_reset_keep_last": null})
    );
    assert_eq!(settings["dropped"], json!(["features (2 entries)"]));
    assert!(!bundle_text(&h.bundle()).contains("48213"));
    // The reviewer's case: a path as the key, and a sentence as the key.
    for bad in [
        json!({"/Users/me/clients/acme-private-deal": true}),
        json!({"note.ship acme on 11-20": 1}),
        json!({"/Users/me/clients/acme-private-deal": true, "note.ship acme on 11-20": 1}),
        json!({"terminal.scrollback_lines": "/Users/me/clients/acme-private-deal"}),
        json!({"terminal.scrollback_lines": {"p": "acme"}}),
        json!({"terminal.scrollback_lines": 48213, "net.port": 48213}),
        json!({"git.branch_prefix": "acme/"}),
    ] {
        h.write("settings.json", json!({"features": bad}).to_string());
        let settings = json_of(&h.bundle(), "settings.json");
        let n = bad.as_object().unwrap().len();
        assert_eq!(settings["features"], json!({}), "{bad}");
        assert_eq!(
            settings["dropped"],
            json!([format!("features ({n} entries)")]),
            "{bad}"
        );
        assert!(!bundle_text(&h.bundle()).contains("acme"), "{bad}");
        assert!(!bundle_text(&h.bundle()).contains("48213"), "{bad}");
        assert!(!bundle_text(&h.bundle()).contains("scrollback"), "{bad}");
    }
    // Not a map at all: the whole field goes.
    h.write("settings.json", json!({"features": "acme"}).to_string());
    let settings = json_of(&h.bundle(), "settings.json");
    assert!(settings.get("features").is_none());
    assert_eq!(settings["dropped"], json!(["features"]));
    assert!(!bundle_text(&h.bundle()).contains("acme"));
}

#[test]
fn diagnose_masks_bare_hex_tokens() {
    let h = Home::new();
    let (h64, h32) = ("0123456789abcdef".repeat(4), "fedcba9876543210".repeat(2));
    let (short, long, upper) = ("ab".repeat(15), "ab".repeat(33), "AB".repeat(16));
    h.write(
        "logs/core.log",
        format!("core started token {h64}\nsession {h32} attached\nkeep {short} {long} {upper}\n"),
    );
    let text = fs::read_to_string(h.bundle().join("core.log.tail")).unwrap();
    assert!(!text.contains(&h64) && !text.contains(&h32), "{text}");
    assert!(
        text.contains("core started token [hex-redacted]\nsession [hex-redacted] attached\n"),
        "{text}"
    );
    assert!(
        text.contains(&format!("keep {short} {long} {upper}")),
        "other lengths and cases stay: {text}"
    );
}

#[test]
fn diagnose_cli_probe_is_bounded() {
    // A CLI that closes stdout and sleeps: the deadline kills it, the run does not wait for the sleep.
    let h = Home::new();
    h.cli("claude", "exec >&-\nexec sleep 20");
    let start = std::time::Instant::now();
    let bundle = h.bundle();
    assert!(start.elapsed().as_secs() < 8, "{:?}", start.elapsed());
    assert_eq!(json_of(&bundle, "versions.json")["claude"], "unavailable");
    // A CLI that prints 200 KB after its version line: drained, so it finishes and exits 0.
    let h = Home::new();
    h.cli(
        "codex",
        "echo codex 9.9.9 filler; head -c 200000 /dev/zero | tr '\\0' x",
    );
    let start = std::time::Instant::now();
    let bundle = h.bundle();
    assert!(start.elapsed().as_secs() < 8, "{:?}", start.elapsed());
    assert_eq!(
        json_of(&bundle, "versions.json")["codex"],
        "codex 9.9.9 filler"
    );
}
