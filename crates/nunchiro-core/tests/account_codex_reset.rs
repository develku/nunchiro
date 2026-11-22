//! Codex reset tickets (needs 225): against a real `nunchiro serve` with a fake `codex` on PATH. As an agent the fake
//! records its env and waits for one line; as `codex ... app-server` it answers the JSON-RPC lines it is sent from files
//! in its `CODEX_HOME` and records its argv, env and every line (a `read.wait` file there slows its read by that many
//! seconds, an `init.wait` file its `initialize` answer from its second start on;a `break-log` file makes its consume turn the core's use log into a folder, so the next log write fails). Requests go over the core socket as raw JSON lines, so
//! these tests speak the same wire the window and the CLI speak. The last test runs the user's real `codex` (when one is
//! installed) on an empty temp `CODEX_HOME` and checks that it starts no MCP server.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

const FAKE: &str = r#"#!/bin/sh
case "$1" in --version) echo "codex-cli 0.162.1"; exit 0;; esac
for a in "$@"; do last=$a; done
if [ "$last" = app-server ]; then
  d=$CODEX_HOME
  printf '%s\n' "$*" >> "$d/argv"
  env | sort > "$d/env"
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$d/rpc.log"
    case "$line" in
      *'"method":"initialize"'*) [ -f "$d/init.wait" ] && [ "$(wc -l < "$d/argv")" -ge 2 ] && sleep "$(cat "$d/init.wait")"; printf '{"id":1,"result":{"userAgent":"fake"}}\n' ;;
      *'"method":"account/rateLimits/read"'*) [ -f "$d/read.wait" ] && sleep "$(cat "$d/read.wait")"; printf '{"method":"remoteControl/status/changed","params":{}}\n'; cat "$d/read.json"; echo ;;
      *'"method":"account/rateLimitResetCredit/consume"'*) [ -f "$d/break-log" ] && rm -f "$d/../codex-resets.json" && mkdir "$d/../codex-resets.json"; cat "$d/consume.json"; echo ;;
    esac
  done
  exit 0
fi
env > "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" && mv "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" "$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION"
read line
"#;
const ARGV: &str =
    "-c approval_policy=never -c features.plugins=false -s read-only -a never app-server";
const DAY: i64 = 86_400;

fn cli() -> PathBuf {
    cli::path()
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// One `rateLimits/read` answer: `available` credits, `expires` their expiry times, weekly used `weekly` percent. A
/// redeemed credit that expires sooner than any is listed too: it must never count as the earliest expiry.
fn read_json(available: u64, expires: &[i64], weekly: f64) -> String {
    let mut credits: Vec<Value> = expires
        .iter()
        .enumerate()
        .map(|(i, e)| json!({"id": format!("c{i}"), "resetType": "codexRateLimits", "status": "available", "grantedAt": 1, "expiresAt": e, "title": null, "description": null}))
        .collect();
    credits.push(json!({"id": "gone", "resetType": "codexRateLimits", "status": "redeemed", "grantedAt": 1, "expiresAt": now() + 60, "title": null, "description": null}));
    json!({"id": 2, "result": {
        "ordinaryUsageAllowed": weekly < 100.0,
        "rateLimits": {"limitId": "codex", "limitName": null, "normalModelSlug": null,
            "primary": {"usedPercent": 26.0, "windowDurationMins": 300, "resetsAt": now() + 3600},
            "secondary": {"usedPercent": weekly, "windowDurationMins": 10080, "resetsAt": now() + 3 * DAY},
            "credits": null, "individualLimit": null, "spendControlReached": null, "planType": "plus", "rateLimitReachedType": null},
        "rateLimitsByLimitId": null,
        "rateLimitResetCredits": {"availableCount": available, "credits": credits},
        "accountId": "acct-secret-id", "rateLimitUpsell": null}})
    .to_string()
}

struct Core {
    home: PathBuf,
    codex: PathBuf,
    project: PathBuf,
    process: Child,
}
impl Core {
    fn new(tag: &str) -> Self {
        Self::with_path(tag, None)
    }
    /// `real`: a folder holding the user's own `codex`, put after the fakes' folder (which then has no `codex`).
    fn with_path(tag: &str, real: Option<&Path>) -> Self {
        let home = home::short(tag);
        let bin = home.join("bin");
        let codex = home.join("codex-home");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&codex).unwrap();
        fs::create_dir_all(home.join("u")).unwrap();
        if real.is_none() {
            fs::write(bin.join("codex"), FAKE).unwrap();
            fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            codex.join("read.json"),
            read_json(2, &[now() + 9 * DAY, now() + 7 * DAY], 40.0),
        )
        .unwrap();
        fs::write(
            codex.join("consume.json"),
            r#"{"id":2,"result":{"outcome":"reset"}}"#,
        )
        .unwrap();
        let project = home.join("proj");
        fs::create_dir_all(&project).unwrap();
        let mut path = bin.display().to_string();
        if let Some(r) = real {
            path = format!("{path}:{}", r.display());
        }
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", home.join("u"))
            .env("CODEX_HOME", &codex)
            .env("PATH", format!("{path}:/usr/bin:/bin"))
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .env_remove("CLAUDE_CONFIG_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            codex,
            project,
            process,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while core.owner(json!({"op": "snapshot"})).get("Ok").is_none() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    /// One raw request line on the core socket with `token`; the `{"Ok":..}` / `{"Err":..}` line back.
    fn raw(&self, token: &str, request: Value) -> Value {
        let Ok(mut s) = UnixStream::connect(self.home.join("core.sock")) else {
            return json!({"Err": "no socket"});
        };
        s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        let line = json!({"token": token, "request": request}).to_string();
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut out = String::new();
        BufReader::new(s).read_line(&mut out).unwrap();
        serde_json::from_str(&out).unwrap_or(json!({"Err": out}))
    }
    fn owner(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        self.raw(token.trim(), request)
    }
    fn ok(&self, request: Value) -> Value {
        let r = self.owner(request.clone());
        r.get("Ok")
            .cloned()
            .unwrap_or_else(|| panic!("{request} -> {r}"))
    }
    fn err(&self, request: Value) -> String {
        let r = self.owner(request.clone());
        r["Err"]
            .as_str()
            .unwrap_or_else(|| panic!("{request} -> {r}"))
            .to_string()
    }
    fn features(&self, f: Value) {
        self.ok(json!({"op": "quit_settings", "patch": {"features": f}}));
    }
    fn on(&self) {
        self.features(json!({"usage.codex_resets": true}));
    }
    /// A fake Codex agent session and its token (from the env it recorded).
    fn agent(&self) -> (String, String) {
        self.started(json!({"kind": "codex", "project": self.project, "label": "add tests", "model": null, "effort": null, "resume": null}))
    }
    /// A plain shell session and its token: it records its env as the fake agent does.
    fn shell_agent(&self) -> (String, String) {
        let record = r#"env > "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" && mv "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" "$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION"; read line"#;
        self.started(json!({"kind": "shell", "project": self.project, "label": "a shell", "args": ["/bin/sh", "-c", record], "model": null, "effort": null, "resume": null}))
    }
    fn started(&self, session: Value) -> (String, String) {
        let r = self.ok(json!({"op": "start", "session": session}));
        let id = r["session"]["id"].as_str().unwrap().to_string();
        let path = self.home.join(format!("env-{id}"));
        let until = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(Instant::now() < until, "session {id} never wrote its env");
            thread::sleep(Duration::from_millis(20));
        }
        let env = fs::read_to_string(path).unwrap();
        let token = env
            .lines()
            .find_map(|l| l.strip_prefix("NUNCHIRO_TOKEN="))
            .unwrap()
            .to_string();
        (id, token)
    }
    /// `nunchiro account codex-reset ARGS` as the agent with `token` runs it, or as the owner when `None`.
    fn reset_cli(&self, token: Option<(&str, &str)>, args: &[&str]) -> std::process::Output {
        let mut cmd = home::git_env::scrubbed(cli());
        cmd.args(["account", "codex-reset"])
            .args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION");
        if let Some((id, t)) = token {
            cmd.env("NUNCHIRO_TOKEN", t).env("NUNCHIRO_SESSION", id);
        }
        cmd.output().unwrap()
    }
    fn rpc(&self) -> Vec<Value> {
        fs::read_to_string(self.codex.join("rpc.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn consumes(&self) -> Vec<Value> {
        self.rpc()
            .into_iter()
            .filter(|m| m["method"] == "account/rateLimitResetCredit/consume")
            .collect()
    }
    fn log(&self) -> Vec<Value> {
        self.ok(json!({"op": "codex_reset_log"}))["entries"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn owner_items(&self) -> Vec<Value> {
        // Omitted from the snapshot when empty.
        self.ok(json!({"op": "snapshot"}))["owner_decisions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    /// Waits until the log has `n` entries, the newest settled (an answer is logged after it returns, and a use is first
    /// logged `unknown` until codex answers).
    fn log_len(&self, n: usize) -> Vec<Value> {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let log = self.log();
            if log.len() >= n && log[0]["outcome"] != "unknown" {
                return log;
            }
            assert!(Instant::now() < until, "log never reached {n}: {log:?}");
            thread::sleep(Duration::from_millis(50));
        }
    }
    /// Every file the core wrote under its home, as text (the token, the count and the account id must be in none).
    fn home_text(&self) -> String {
        let mut out = String::new();
        for e in fs::read_dir(&self.home).unwrap().flatten() {
            if e.path().is_file()
                && let Ok(t) = fs::read_to_string(e.path())
            {
                out.push_str(&t);
            }
        }
        out
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.process.kill();
        let _ = self.process.wait();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

// Off by default: with the setting untouched no `codex` starts for a read, a use or an agent's ask.
#[test]
fn codex_resets_off_by_default_start_no_codex() {
    let core = Core::new("cxoff");
    assert!(
        core.err(json!({"op": "codex_reset_read", "account": "own"}))
            .contains("off")
    );
    assert!(
        core.err(json!({"op": "codex_reset_use", "account": "own", "reason": ""}))
            .contains("off")
    );
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "add tests"]);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("off"),
        "{out:?}"
    );
    assert!(
        !core.codex.join("argv").exists(),
        "a codex app-server started while the setting was off"
    );
}

// The owner's Refresh: the fixed argv, the account's CODEX_HOME, one initialize / initialized / read, the count and the
// earliest expiry among available credits; nothing of the result is written anywhere.
#[test]
fn codex_reset_read_fixed_argv_count_and_earliest_expiry() {
    let core = Core::new("cxread");
    core.on();
    let r = core.ok(json!({"op": "codex_reset_read", "account": "own"}));
    assert_eq!(r["type"], "codex_resets");
    assert_eq!(r["available"], 2);
    let soonest = now() + 7 * DAY;
    assert!(
        (r["next_expires_at"].as_i64().unwrap() - soonest).abs() <= 2,
        "{r}"
    );
    assert_eq!(
        fs::read_to_string(core.codex.join("argv")).unwrap().trim(),
        ARGV
    );
    let env = fs::read_to_string(core.codex.join("env")).unwrap();
    assert!(
        env.contains(&format!("CODEX_HOME={}", core.codex.display())),
        "{env}"
    );
    assert!(
        !env.contains("NUNCHIRO_TOKEN"),
        "the session token leaked into codex: {env}"
    );
    let methods: Vec<String> = core
        .rpc()
        .iter()
        .map(|m| m["method"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(
        methods,
        ["initialize", "initialized", "account/rateLimits/read"]
    );
    let text = core.home_text();
    assert!(
        !text.contains("acct-secret-id") && !text.contains("\"c1\""),
        "a read result was stored"
    );
}

// "Use a reset" from the window or the owner socket: each use is one consume with a fresh UUID key and no credit id,
// recorded in the log as the owner's; the owner CLI asks for --yes first and sends nothing without it.
#[test]
fn codex_reset_owner_use_fresh_key_each_time_and_logged() {
    let core = Core::new("cxuse");
    core.on();
    let out = core.reset_cli(None, &[]);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--yes"),
        "{out:?}"
    );
    assert!(core.consumes().is_empty());
    let r = core.ok(json!({"op": "codex_reset_use", "account": "own", "reason": ""}));
    assert_eq!(r["type"], "codex_reset_used");
    assert_eq!(r["outcome"], "reset");
    assert_eq!(r["after"]["available"], 2, "the use re-reads once: {r}");
    let out = core.reset_cli(None, &["--yes"]);
    assert!(out.status.success(), "{out:?}");
    let consumes = core.consumes();
    assert_eq!(consumes.len(), 2);
    let keys: Vec<&str> = consumes
        .iter()
        .map(|c| c["params"]["idempotencyKey"].as_str().unwrap())
        .collect();
    assert_ne!(keys[0], keys[1]);
    assert!(
        keys.iter()
            .all(|k| k.len() == 36 && k.as_bytes()[14] == b'4'),
        "{keys:?}"
    );
    assert!(
        consumes
            .iter()
            .all(|c| c["params"].get("creditId").is_none())
    );
    let log = core.log();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log.iter()
            .all(|e| e["how"] == "owner" && e["outcome"] == "reset" && e["account"] == "Default")
    );
    let text = core.home_text();
    assert!(!text.contains("acct-secret-id") && !text.contains("usedPercent"));
}

// The agent policy: off refuses (and logs it); a widget-free, owner-only setting decides.
#[test]
fn codex_reset_agent_policy_off_refused_and_logged() {
    let core = Core::new("cxpoff");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "off"}));
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(!out.status.success(), "{out:?}");
    assert!(core.consumes().is_empty());
    let log = core.log();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["how"], "refused");
    assert_eq!(log[0]["rule"], "off");
    assert_eq!(log[0]["session"], id);
    assert_eq!(log[0]["why"], "weekly is out");
    // A session may not read, list or change any of it.
    for op in [
        json!({"op": "codex_reset_read", "account": "own"}),
        json!({"op": "codex_reset_log"}),
        json!({"op": "quit_settings", "patch": {"features": {"usage.codex_reset_agent": "allow"}}}),
    ] {
        assert!(core.raw(&token, op.clone()).get("Err").is_some(), "{op}");
    }
    // An agent names no account: it asks for its own session's.
    let out = core.reset_cli(Some((&id, &token)), &["--account", "own", "--reason", "x"]);
    assert!(!out.status.success());
}

// A session that is not a Codex session has no Codex ticket of its own: even under allow-ahead, with every condition met,
// it never reaches the owner's "Your own" ticket. Refused before the policy: nothing spent, asked or logged.
#[test]
fn codex_reset_non_codex_session_is_refused() {
    let core = Core::new("cxshell");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false}));
    fs::write(
        core.codex.join("read.json"),
        read_json(2, &[now() + 9 * DAY, now() + 8 * DAY], 100.0),
    )
    .unwrap();
    let (id, token) = core.shell_agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(!out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("operation not granted"),
        "{out:?}"
    );
    assert!(core.consumes().is_empty());
    assert!(core.owner_items().is_empty());
    assert!(core.log().is_empty());
}

// Ask every time (the default): the agent's ask is an owner item (a Decisions card) and nothing is spent; the owner's
// Allow spends one and logs it as approved; Deny spends nothing and logs it.
#[test]
fn codex_reset_agent_ask_card_then_owner_allow_and_deny() {
    let core = Core::new("cxask");
    core.on();
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "add tests"]);
    assert!(out.status.success(), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stdout).contains("waiting for the owner"));
    assert!(core.consumes().is_empty());
    let items = core.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["owner"]["type"], "codex_reset");
    assert_eq!(items[0]["owner"]["reason"], "add tests");
    assert_eq!(items[0]["session_id"], id);
    // The asking session cannot answer its own card.
    let item = items[0]["id"].as_str().unwrap().to_string();
    assert!(
        core.raw(
            &token,
            json!({"op": "answer", "item": item, "answer": {"type": "allow_once"}})
        )
        .get("Err")
        .is_some()
    );
    core.ok(json!({"op": "answer", "item": item, "answer": {"type": "allow_once"}}));
    let log = core.log_len(2);
    assert_eq!(core.consumes().len(), 1);
    assert!(core.owner_items().is_empty());
    assert_eq!(log[0]["how"], "approved", "{log:?}");
    assert_eq!(log[0]["outcome"], "reset");
    assert_eq!(log[1]["how"], "asked");

    core.reset_cli(Some((&id, &token)), &["--reason", "again"]);
    let item = core.owner_items()[0]["id"].as_str().unwrap().to_string();
    core.ok(json!({"op": "answer", "item": item, "answer": {"type": "deny"}}));
    let log = core.log_len(4);
    assert_eq!(log[0]["how"], "denied", "{log:?}");
    assert_eq!(core.consumes().len(), 1);
}

// Allow ahead: when every checked condition holds the agent's ask spends one at once (logged as automatic with its
// rule); keep-the-last-one sends it to the owner instead; a ticket expiring within 3 days is allowed without asking.
#[test]
fn codex_reset_agent_allow_ahead_conditions() {
    let core = Core::new("cxallow");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false}));
    fs::write(
        core.codex.join("read.json"),
        read_json(2, &[now() + 9 * DAY, now() + 8 * DAY], 100.0),
    )
    .unwrap();
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(core.consumes().len(), 1);
    let log = core.log();
    assert_eq!(log[0]["how"], "auto");
    assert_eq!(log[0]["rule"], "conditions");

    // One left and keep-the-last-one on: asked, not spent.
    fs::write(
        core.codex.join("read.json"),
        read_json(1, &[now() + 9 * DAY], 100.0),
    )
    .unwrap();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("waiting for the owner"),
        "{out:?}"
    );
    assert_eq!(core.consumes().len(), 1);
    assert_eq!(core.log()[0]["rule"], "keep_last");
    let item = core.owner_items()[0]["id"].as_str().unwrap().to_string();
    core.ok(json!({"op": "answer", "item": item, "answer": {"type": "deny"}}));

    // The same last one, expiring tomorrow, with the expiring rule on: used without asking.
    core.features(json!({"usage.codex_reset_expiring": true}));
    fs::write(
        core.codex.join("read.json"),
        read_json(1, &[now() + DAY], 40.0),
    )
    .unwrap();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "expiring"]);
    assert!(out.status.success(), "{out:?}");
    let consumes = core.consumes();
    assert_eq!(consumes.len(), 2);
    assert_eq!(core.log()[0]["rule"], "expiring");
    // The expiring rule spends that very ticket (the earliest available, not the redeemed one); the conditions rule
    // lets codex pick.
    assert!(
        consumes[0]["params"].get("creditId").is_none(),
        "{consumes:?}"
    );
    assert_eq!(consumes[1]["params"]["creditId"], "c0", "{consumes:?}");
    // A read that fails is refused and logged, never used.
    fs::write(
        core.codex.join("read.json"),
        r#"{"id":2,"error":{"code":-32600,"message":"codex account authentication required"}}"#,
    )
    .unwrap();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "again"]);
    assert!(!out.status.success(), "{out:?}");
    assert_eq!(core.log()[0]["rule"], "codex_error");
    assert_eq!(core.consumes().len(), 2);
}

// MUST (round 2): a use whose answer is unknown (maybe spent) counts toward the weekly cap on automatic uses.
#[test]
fn codex_reset_unknown_auto_use_counts_toward_the_cap() {
    let core = Core::new("cxcap");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false, "usage.codex_reset_week_max": 1}));
    fs::write(
        core.codex.join("read.json"),
        read_json(
            3,
            &[now() + 9 * DAY, now() + 8 * DAY, now() + 9 * DAY],
            100.0,
        ),
    )
    .unwrap();
    fs::write(
        core.codex.join("consume.json"),
        r#"{"id":2,"result":{"outcome":"somethingNew"}}"#,
    )
    .unwrap();
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(!out.status.success(), "{out:?}");
    assert_eq!(core.consumes().len(), 1);
    assert_eq!(core.log()[0]["outcome"], "unknown");
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("waiting for the owner"),
        "{out:?}"
    );
    assert_eq!(core.consumes().len(), 1, "an unknown use was not counted");
    assert_eq!(core.log()[0]["rule"], "week_max");
}

// MUST (round 2): a use whose log line could not be written leaves the accounting unknown, so the next automatic use is
// refused and nothing is spent.
#[test]
fn codex_reset_log_write_failure_refuses_the_next_auto_use() {
    let core = Core::new("cxlogw");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false, "usage.codex_reset_week_max": 5}));
    fs::write(
        core.codex.join("read.json"),
        read_json(
            3,
            &[now() + 9 * DAY, now() + 8 * DAY, now() + 9 * DAY],
            100.0,
        ),
    )
    .unwrap();
    fs::write(core.codex.join("break-log"), "").unwrap();
    let (id, token) = core.agent();
    core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert_eq!(core.consumes().len(), 1);
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(!out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("log"),
        "{out:?}"
    );
    assert_eq!(
        core.consumes().len(),
        1,
        "an automatic use ran with no accounting"
    );
}

// SHOULD (round 2): the policy is read again under the gate, after codex's read and before the use: an ask that waited
// while the owner switched to Ask or Off is filed or refused, never spent.
#[test]
fn codex_reset_auto_use_rereads_the_policy_before_spending() {
    let core = Core::new("cxrepol");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false}));
    fs::write(
        core.codex.join("read.json"),
        read_json(
            3,
            &[now() + 9 * DAY, now() + 8 * DAY, now() + 9 * DAY],
            100.0,
        ),
    )
    .unwrap();
    fs::write(core.codex.join("read.wait"), "2").unwrap();
    let (id, token) = core.agent();
    let reads = |core: &Core| {
        core.rpc()
            .iter()
            .filter(|m| m["method"] == "account/rateLimits/read")
            .count()
    };
    for (switch, refused) in [("ask", false), ("off", true)] {
        core.features(json!({"usage.codex_reset_agent": "allow"}));
        let before = reads(&core);
        let ask = {
            let (home, id, token) = (core.home.clone(), id.clone(), token.clone());
            thread::spawn(move || {
                home::git_env::scrubbed(cli())
                    .args(["account", "codex-reset", "--reason", "weekly is out"])
                    .env("NUNCHIRO_HOME", home)
                    .env("NUNCHIRO_TOKEN", token)
                    .env("NUNCHIRO_SESSION", id)
                    .output()
                    .unwrap()
            })
        };
        let until = Instant::now() + Duration::from_secs(15);
        while reads(&core) == before {
            assert!(Instant::now() < until, "the agent's read never started");
            thread::sleep(Duration::from_millis(20));
        }
        core.features(json!({"usage.codex_reset_agent": switch}));
        let out = ask.join().unwrap();
        assert!(
            core.consumes().is_empty(),
            "{switch}: spent after the owner switched"
        );
        assert_eq!(!out.status.success(), refused, "{switch}: {out:?}");
        assert_eq!(core.log()[0]["rule"], if refused { "off" } else { "ask" });
        if !refused {
            let item = core.owner_items()[0]["id"].as_str().unwrap().to_string();
            core.ok(json!({"op": "answer", "item": item, "answer": {"type": "deny"}}));
            core.log_len(2);
        }
    }
}

// SHOULD (round 3): the policy is checked once more after codex has started for the use, right before the consume is
// sent: a switch to Off while codex is slow to start spends nothing, and the reserved line does not count.
#[test]
fn codex_reset_auto_use_rechecks_the_policy_after_codex_starts() {
    let core = Core::new("cxinit");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false}));
    fs::write(
        core.codex.join("read.json"),
        read_json(
            3,
            &[now() + 9 * DAY, now() + 8 * DAY, now() + 9 * DAY],
            100.0,
        ),
    )
    .unwrap();
    // The read is codex's first start; the use's start (the second) waits 2 s before it answers `initialize`.
    fs::write(core.codex.join("init.wait"), "2").unwrap();
    let (id, token) = core.agent();
    let ask = {
        let (home, id, token) = (core.home.clone(), id.clone(), token.clone());
        thread::spawn(move || {
            home::git_env::scrubbed(cli())
                .args(["account", "codex-reset", "--reason", "weekly is out"])
                .env("NUNCHIRO_HOME", home)
                .env("NUNCHIRO_TOKEN", token)
                .env("NUNCHIRO_SESSION", id)
                .output()
                .unwrap()
        })
    };
    let until = Instant::now() + Duration::from_secs(15);
    while core
        .rpc()
        .iter()
        .filter(|m| m["method"] == "initialize")
        .count()
        < 2
    {
        assert!(Instant::now() < until, "the use's codex never started");
        thread::sleep(Duration::from_millis(20));
    }
    core.features(json!({"usage.codex_reset_agent": "off"}));
    let out = ask.join().unwrap();
    assert!(
        core.consumes().is_empty(),
        "spent after the owner switched to Off during codex's start"
    );
    assert!(!out.status.success(), "{out:?}");
    let log = core.log();
    assert_eq!(log[0]["rule"], "off", "{log:?}");
    assert!(
        log.iter().all(|e| e["outcome"] != "unknown"),
        "the use that was never sent still counts: {log:?}"
    );
}

// SHOULD (round 3): a log that cannot be read is shown on the page and moved aside (`codex-resets.json.bad-<ts>`), so the
// owner's own use is logged again; agents' automatic uses stay refused (their weekly count went with the old file).
#[test]
fn codex_reset_corrupt_log_is_shown_set_aside_and_auto_stays_refused() {
    let core = Core::new("cxbad");
    core.features(json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow", "usage.codex_reset_expiring": false, "usage.codex_reset_week_max": 5}));
    fs::write(
        core.codex.join("read.json"),
        read_json(
            3,
            &[now() + 9 * DAY, now() + 8 * DAY, now() + 9 * DAY],
            100.0,
        ),
    )
    .unwrap();
    fs::write(core.home.join("codex-resets.json"), "{not json").unwrap();
    let r = core.ok(json!({"op": "codex_reset_log"}));
    assert_eq!(r["problem"]["unreadable"], true, "{r}");
    // The owner's own use: made and logged on a new log; the bad file kept beside it.
    let used = core.ok(json!({"op": "codex_reset_use", "account": "own", "reason": ""}));
    assert_eq!(used["outcome"], "reset");
    let r = core.ok(json!({"op": "codex_reset_log"}));
    assert_eq!(r["entries"].as_array().unwrap().len(), 1, "{r}");
    assert_eq!(r["entries"][0]["how"], "owner");
    let at = r["problem"]["set_aside_at"]
        .as_i64()
        .expect("no set-aside time");
    assert!((at - now()).abs() <= 5, "{r}");
    assert_eq!(r["problem"]["unreadable"], false, "{r}");
    let bad = core.home.join(format!("codex-resets.json.bad-{at}"));
    assert_eq!(fs::read_to_string(&bad).unwrap(), "{not json");
    // An agent's automatic use: refused, nothing spent.
    let (id, token) = core.agent();
    let out = core.reset_cli(Some((&id, &token)), &["--reason", "weekly is out"]);
    assert!(!out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("log"),
        "{out:?}"
    );
    assert_eq!(
        core.consumes().len(),
        1,
        "an automatic use ran with no weekly count"
    );
}

// What codex answers is shown as fixed words: not signed in, a codex too old for resets; nothing of its text.
#[test]
fn codex_reset_codex_errors_are_fixed_words() {
    let core = Core::new("cxerr");
    core.on();
    fs::write(core.codex.join("read.json"), r#"{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits SECRET"}}"#).unwrap();
    let e = core.err(json!({"op": "codex_reset_read", "account": "own"}));
    assert!(e.contains("not signed in") && !e.contains("SECRET"), "{e}");
    fs::write(
        core.codex.join("read.json"),
        r#"{"id":2,"error":{"code":-32601,"message":"method not found"}}"#,
    )
    .unwrap();
    assert!(
        core.err(json!({"op": "codex_reset_read", "account": "own"}))
            .contains("too old")
    );
    fs::write(
        core.codex.join("consume.json"),
        r#"{"id":2,"result":{"outcome":"somethingNew"}}"#,
    )
    .unwrap();
    let e = core.err(json!({"op": "codex_reset_use", "account": "own", "reason": ""}));
    assert!(e.contains("unknown"), "{e}");
    assert_eq!(core.log()[0]["outcome"], "unknown");
    // An account id that is not registered is refused before codex starts.
    let n = core.rpc().len();
    assert!(
        core.err(json!({"op": "codex_reset_read", "account": "../../x"}))
            .contains("unknown")
    );
    assert_eq!(core.rpc().len(), n);
}

// Brief check (needs 225): the hidden app-server Nunchiro starts does not start the user's MCP servers. The user's own
// `codex` from PATH, an empty temp CODEX_HOME whose config names one MCP server that leaves a marker when it starts.
// Not signed in, so the read is refused and nothing reaches an account. Skips when no `codex` is installed.
#[test]
fn codex_app_server_starts_no_mcp_server() {
    let Some(dir) = std::env::var_os("PATH")
        .and_then(|p| std::env::split_paths(&p).find(|d| d.join("codex").is_file()))
        .or_else(|| {
            ["/opt/homebrew/bin", "/usr/local/bin"]
                .into_iter()
                .map(PathBuf::from)
                .find(|d| d.join("codex").is_file())
        })
    else {
        eprintln!("skipped: no codex installed");
        return;
    };
    let core = Core::with_path("cxmcp", Some(&dir));
    core.on();
    let marker = core.home.join("mcp-started");
    let server = core.home.join("mcp.sh");
    fs::write(
        &server,
        format!(
            "#!/bin/sh\necho started >> {}\ncat > /dev/null\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&server, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        core.codex.join("config.toml"),
        format!(
            "[mcp_servers.marker]\ncommand = \"{}\"\nargs = []\nstartup_timeout_sec = 5\n",
            server.display()
        ),
    )
    .unwrap();
    let e = core.err(json!({"op": "codex_reset_read", "account": "own"}));
    assert!(e.contains("not signed in"), "{e}");
    thread::sleep(Duration::from_secs(2));
    assert!(!marker.exists(), "codex app-server started an MCP server");
}
