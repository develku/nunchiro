//! V2-2c: tokens per account per local day from the agents' own transcripts. Fixtures are hand-authored; `NOW` is
//! 2026-10-24T12:00Z and the zone is fixed at +09:00, so "today" is local Oct 24 and a line at 15:00Z is past midnight.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    accounts::Agent,
    api::{AgentKind, Reply, Request, StartSession},
    server::call,
    usage::{self, Budget, Totals},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const NOW: i64 = 1_792_843_200;
const SEOUL: i64 = 9 * 3600;
fn root(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/usage")
        .join(name)
}
fn scan(root: &Path, agent: Agent) -> (Totals, Vec<PathBuf>, usize) {
    let mut opened = vec![];
    let (totals, widest) = usage::scan(root, agent, NOW, &|_| SEOUL, &mut |p| {
        opened.push(p.to_path_buf())
    });
    (totals, opened, widest)
}

#[test]
fn usage_fixture_sums() {
    // msg_1 counted once across a.jsonl and the resumed b.jsonl; msg_3 sits at local 00:00 (today), msg_2 one second
    // before it (yesterday); msg_old is outside the 7 days; msg_5 is a half-written last line.
    let (claude, _, _) = scan(&root("claude"), Agent::Claude);
    assert_eq!(
        claude,
        Totals {
            today: 1140,
            week: 1157
        }
    );
    // Codex: a null-info event and a repeat of the same running total add nothing; cached input is inside input.
    let (codex, _, _) = scan(&root("codex"), Agent::Codex);
    assert_eq!(
        codex,
        Totals {
            today: 110,
            week: 180
        }
    );
}

#[test]
fn usage_reads_only_globs() {
    // Beside the transcripts sit .credentials.json, settings.json, auth.json and a notes.txt under projects/.
    let (_, opened, _) = scan(&root("claude"), Agent::Claude);
    let names: Vec<_> = opened
        .iter()
        .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
        .collect();
    assert_eq!(opened.len(), 2, "{names:?}");
    assert!(names.iter().all(|n| n.ends_with(".jsonl")), "{names:?}");
    assert!(
        opened
            .iter()
            .all(|p| p.starts_with(root("claude").join("projects")))
    );
    let (_, opened, _) = scan(&root("codex"), Agent::Codex);
    assert_eq!(opened.len(), 1);
    assert!(opened[0].starts_with(root("codex").join("sessions")));
}

#[test]
fn usage_streams_large_file() {
    let dir = home::short("usage");
    let sub = dir.join("projects/p");
    fs::create_dir_all(&sub).unwrap();
    let mut out = fs::File::create(sub.join("big.jsonl")).unwrap();
    let (mut size, mut n) = (0, 0u64);
    while size < 5 << 20 {
        let line = format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{{\"id\":\"m{n}\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}},\"pad\":\"{}\"}}}}\n",
            "x".repeat(400)
        );
        out.write_all(line.as_bytes()).unwrap();
        size += line.len();
        n += 1;
    }
    drop(out);
    let (totals, _, widest) = scan(&dir, Agent::Claude);
    assert_eq!(
        totals,
        Totals {
            today: 2 * n,
            week: 2 * n
        }
    );
    assert!(widest < 2 << 20, "reader buffer grew to {widest}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn usage_skips_links_and_oversize_lines() {
    let dir = home::short("usage");
    let p = dir.join("projects/p");
    fs::create_dir_all(&p).unwrap();
    // One line over the cap is skipped whole; the reader resyncs on its newline and counts the next.
    let mut body = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(2 << 20));
    body += "{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{\"id\":\"a\",\"usage\":{\"input_tokens\":3}}}\n";
    fs::write(p.join("a.jsonl"), body).unwrap();
    std::os::unix::fs::symlink(root("claude"), dir.join("projects/link")).unwrap();
    let (totals, opened, widest) = scan(&dir, Agent::Claude);
    assert_eq!(totals.today, 3);
    assert_eq!(opened.len(), 1);
    assert!(widest < 2 << 20);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn usage_rows_cover_own_and_added_accounts() {
    let home = home::short("usage");
    let own = home.join("own");
    let acct = home.join("accounts/claude/abcd1234");
    for (dir, id) in [(&own, "m1"), (&acct, "m2")] {
        fs::create_dir_all(dir.join("projects/p")).unwrap();
        let line = format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{{\"id\":\"{id}\",\"usage\":{{\"input_tokens\":4}}}}}}\n"
        );
        fs::write(dir.join("projects/p/a.jsonl"), line).unwrap();
    }
    fs::write(
        home.join("accounts.toml"),
        "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"abcd1234\"\nlabel = \"Work\"\n",
    )
    .unwrap();
    let rows = usage::rows(
        &home,
        &|agent| (agent == Agent::Claude).then(|| own.clone()),
        NOW,
        &|_| SEOUL,
        &mut Budget::request(),
    )
    .unwrap();
    let got: Vec<_> = rows
        .iter()
        .map(|r| (r.agent, r.id.as_str(), r.today))
        .collect();
    // Codex's own folder is absent, so zero.
    assert_eq!(
        got,
        [
            (Agent::Claude, "own", 4),
            (Agent::Claude, "abcd1234", 4),
            (Agent::Codex, "own", 0)
        ]
    );
    fs::remove_dir_all(&home).unwrap();
}

// Ticket 1031: the status bar's usage block reads limits only. Claude's transcripts carry none, so they are not opened
// (days of them can be gigabytes); Codex's records are, and the rows keep their shape.
#[test]
fn usage_limits_only_reads_codex_and_opens_no_claude_transcript() {
    let home = home::short("usage");
    let (claude, codex) = (home.join("claude"), home.join("codex"));
    fs::create_dir_all(claude.join("projects/p")).unwrap();
    fs::write(
        claude.join("projects/p/a.jsonl"),
        "{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":4}}}\n",
    )
    .unwrap();
    fs::create_dir_all(codex.join("sessions/2026/10/24")).unwrap();
    let reset = NOW + 3600;
    fs::write(
        codex.join("sessions/2026/10/24/r.jsonl"),
        format!(
            "{{\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"total_tokens\":10}},\"last_token_usage\":{{\"input_tokens\":5,\"cached_input_tokens\":0,\"output_tokens\":5}}}},\"rate_limits\":{{\"primary\":{{\"used_percent\":30.0,\"window_minutes\":300,\"resets_at\":{reset}}}}}}}}}\n"
        ),
    )
    .unwrap();
    let read = |limits_only: bool| {
        let mut budget = Budget::request();
        budget.limits_only = limits_only;
        usage::rows(
            &home,
            &|agent| {
                Some(if agent == Agent::Claude {
                    claude.clone()
                } else {
                    codex.clone()
                })
            },
            NOW,
            &|_| SEOUL,
            &mut budget,
        )
        .unwrap()
    };
    let got = |limits_only: bool| -> Vec<_> {
        read(limits_only)
            .iter()
            .map(|r| (r.agent, r.today, r.session.as_ref().map(|l| l.left_pct)))
            .collect()
    };
    assert_eq!(
        got(false),
        [(Agent::Claude, 4, None), (Agent::Codex, 10, Some(70))]
    );
    // The same rows, Claude's uncounted: its transcript was not read.
    assert_eq!(
        got(true),
        [(Agent::Claude, 0, None), (Agent::Codex, 10, Some(70))]
    );
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn third_party_notices_has_usage_row() {
    let notices = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../THIRD_PARTY_NOTICES.md"),
    )
    .unwrap();
    let row = notices
        .lines()
        .find(|l| l.contains("crates/nunchiro-core/src/usage.rs"))
        .expect("usage row");
    assert!(
        row.contains("Orca") && row.contains("claude-usage") && row.contains("MIT"),
        "{row}"
    );
}

const ID: &str = "abcd1234";
fn line(id: &str, tokens: u64) -> String {
    format!(
        "{{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{{\"id\":\"{id}\",\"usage\":{{\"input_tokens\":{tokens}}}}}}}\n"
    )
}
/// A home with a counted "own" folder (4 tokens) and one registered account `ID` (7 tokens).
fn home_with_account(registry: &str) -> (PathBuf, PathBuf) {
    let home = home::short("usage");
    let own = home.join("own");
    for (dir, name, n) in [
        (own.clone(), "o", 4),
        (home.join("accounts/claude").join(ID), "a", 7),
    ] {
        fs::create_dir_all(dir.join("projects/p")).unwrap();
        fs::write(dir.join("projects/p/a.jsonl"), line(name, n)).unwrap();
    }
    fs::write(home.join("accounts.toml"), registry).unwrap();
    (home, own)
}
const REGISTRY: &str =
    "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"abcd1234\"\nlabel = \"Work\"\n";
fn claude_rows(home: &Path, own: &Path, budget: &mut Budget) -> Vec<(String, u64, bool)> {
    let own = own.to_path_buf();
    usage::rows(
        home,
        &|a| (a == Agent::Claude).then(|| own.clone()),
        NOW,
        &|_| SEOUL,
        budget,
    )
    .unwrap()
    .into_iter()
    .filter(|r| r.agent == Agent::Claude)
    .map(|r| (r.id, r.today, r.partial))
    .collect()
}
fn own_only() -> Vec<(String, u64, bool)> {
    vec![("own".into(), 4, false)]
}

#[test]
fn usage_registry_fifo_does_not_block() {
    let (home, own) = home_with_account("");
    fs::remove_file(home.join("accounts.toml")).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(home.join("accounts.toml"))
            .status()
            .unwrap()
            .success()
    );
    let (tx, rx) = std::sync::mpsc::channel();
    let (h, o) = (home.clone(), own.clone());
    thread::spawn(move || tx.send(claude_rows(&h, &o, &mut Budget::request())));
    let got = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the request blocked on the FIFO");
    assert_eq!(got, own_only());
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn usage_refuses_what_accounts_refuses() {
    let oversized = format!("{REGISTRY}# {}\n", "x".repeat(1 << 20));
    let dup = format!("{REGISTRY}{}", &REGISTRY["version = 1\n".len()..]);
    let cases: [(&str, String); 5] = [
        (
            "another version",
            REGISTRY.replace("version = 1", "version = 2"),
        ),
        ("bad entry", REGISTRY.replace("abcd1234", "../own")),
        ("duplicate entry", dup),
        ("oversized", oversized),
        ("not toml", "[[accounts".into()),
    ];
    for (name, text) in cases {
        let (home, own) = home_with_account(&text);
        assert_eq!(
            claude_rows(&home, &own, &mut Budget::request()),
            own_only(),
            "{name}"
        );
        fs::remove_dir_all(&home).unwrap();
    }
    // A link at the registry name.
    let (home, own) = home_with_account(REGISTRY);
    fs::rename(home.join("accounts.toml"), home.join("real.toml")).unwrap();
    std::os::unix::fs::symlink(home.join("real.toml"), home.join("accounts.toml")).unwrap();
    assert_eq!(
        claude_rows(&home, &own, &mut Budget::request()),
        own_only(),
        "symlink"
    );
    fs::remove_dir_all(&home).unwrap();
    // Control: the same registry as a plain file counts the account.
    let (home, own) = home_with_account(REGISTRY);
    assert_eq!(
        claude_rows(&home, &own, &mut Budget::request()),
        vec![("own".into(), 4, false), (ID.into(), 7, false)]
    );
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn usage_link_at_account_folder_counts_zero() {
    let zero = vec![("own".to_string(), 4, false), (ID.to_string(), 0, false)];
    // The account folder is a link to a folder holding transcripts.
    let (home, own) = home_with_account(REGISTRY);
    let folder = home.join("accounts/claude").join(ID);
    fs::rename(&folder, home.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(home.join("elsewhere"), &folder).unwrap();
    assert_eq!(claude_rows(&home, &own, &mut Budget::request()), zero);
    fs::remove_dir_all(&home).unwrap();
    // `projects` inside the account folder is a link.
    let (home, own) = home_with_account(REGISTRY);
    let projects = home.join("accounts/claude").join(ID).join("projects");
    fs::rename(&projects, home.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(home.join("elsewhere"), &projects).unwrap();
    assert_eq!(claude_rows(&home, &own, &mut Budget::request()), zero);
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn usage_file_swapped_for_fifo_does_not_block() {
    let dir = home::short("usage");
    let fifo = dir.join("a.jsonl");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    std::os::unix::fs::symlink(root("claude/projects/p1/a.jsonl"), dir.join("link.jsonl")).unwrap();
    fs::write(dir.join("plain.jsonl"), "x\n").unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let paths = [fifo, dir.join("link.jsonl"), dir.join("plain.jsonl")];
    thread::spawn(move || tx.send(paths.map(|p| usage::open_regular(&p).map(|(_, m)| m.len()))));
    let got = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the open blocked on a FIFO");
    assert_eq!(got, [None, None, Some(2)]);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn usage_caps_total_work() {
    let (home, own) = home_with_account(REGISTRY);
    for i in 0..5 {
        fs::write(
            home.join("own/projects/p").join(format!("f{i}.jsonl")),
            line(&format!("x{i}"), 1),
        )
        .unwrap();
    }
    // Files: 3 of the 6 own files, so the own row is partial and the account row after it too.
    let mut budget = Budget::new(1000, 3, u64::MAX);
    let got = claude_rows(&home, &own, &mut budget);
    assert!(got.iter().all(|r| r.2), "{got:?}");
    assert!(got[0].1 < 4 + 5, "{got:?}");
    // Bytes: room for no file at all.
    let got = claude_rows(&home, &own, &mut Budget::new(1000, 100, 10));
    assert_eq!(got, vec![("own".into(), 0, true), (ID.into(), 0, true)]);
    // Entries: the walk stops at the third directory entry.
    let got = claude_rows(&home, &own, &mut Budget::new(3, 100, u64::MAX));
    assert!(got.iter().all(|r| r.2), "{got:?}");
    // Plenty of room: nothing is marked.
    let got = claude_rows(&home, &own, &mut Budget::request());
    assert_eq!(
        got,
        vec![("own".into(), 4 + 5, false), (ID.into(), 7, false)]
    );
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn machine_forwarding_refuses_account_usage() {
    let core = Core::new();
    let err = call(
        &core.home,
        Request::Remote {
            machine: "elsewhere".into(),
            request: Box::new(Request::AccountUsage { limits: false }),
        },
    )
    .unwrap_err();
    assert!(err.contains("local owner-only"), "{err}");
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("usage");
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake, b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"2.1.310 (Claude Code)\"; exit; fi\nexec /bin/cat\n").unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        fs::create_dir_all(home.join("user")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
            .env("CODEX_HOME", home.join("codex"))
            // The user's home as the core sees it: the only link root until the owner names another (ticket 211).
            .env("HOME", home.join("user"))
            .env_remove("NUNCHIRO_USAGE_LINK_ROOTS")
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        core
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
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
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
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// The current UTC time as a transcript timestamp, so the line is "today" in whatever zone the test runs.
fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[test]
fn account_usage_is_window_only() {
    let core = Core::new();
    let dir = core.home.join("agent/projects/p");
    fs::create_dir_all(&dir).unwrap();
    let line = json!({"type":"assistant","timestamp":iso_now(),"message":{"id":"w1","usage":{"input_tokens":6,"output_tokens":1}}});
    fs::write(dir.join("a.jsonl"), line.to_string() + "\n").unwrap();
    let reply = core.window(json!({"op":"account_usage"}));
    assert_eq!(reply["Ok"]["type"], "account_usage", "{reply}");
    let own = &reply["Ok"]["rows"][0];
    assert_eq!(
        (
            own["agent"].as_str(),
            own["id"].as_str(),
            own["today"].as_u64(),
            own["week"].as_u64()
        ),
        (Some("claude"), Some("own"), Some(7), Some(7)),
        "{reply}"
    );

    // A session agent holds a token, not the window's: refused.
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.join("cwd"),
                worktree: false,
                label: "usage".into(),
                args: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                ],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let until = Instant::now() + Duration::from_secs(5);
    let token = loop {
        let Reply::Output { data, .. } = call(
            &core.home,
            Request::Read {
                id: session.id.clone(),
                after: 0,
            },
        )
        .unwrap() else {
            panic!()
        };
        let out = String::from_utf8_lossy(&data).into_owned();
        if let Some(l) = out
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
        {
            break l.trim().to_string();
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    };
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(
        sock,
        "{}",
        json!({"token":token,"request":{"op":"account_usage"}})
    )
    .unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    call(&core.home, Request::Close { id: session.id }).unwrap();
}

// ---- Ticket 211 A1 + D1: the owner's own linked default folder is followed read-only, bounded, labelled. ----
fn codex_line(total: u64) -> String {
    format!(
        "{{\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"total_tokens\":{total}}},\"last_token_usage\":{{\"input_tokens\":{total},\"output_tokens\":0}}}}}}}}\n"
    )
}
/// A user home `h` whose `.codex/sessions` links to `target` (a folder holding `files` rollouts of 100 tokens each).
fn linked_codex(target: &Path, files: u64) -> PathBuf {
    let h = home::short("usage");
    let own = h.join(".codex");
    fs::create_dir_all(&own).unwrap();
    fs::create_dir_all(target.join("2026/10/24")).unwrap();
    for i in 0..files {
        fs::write(
            target.join(format!("2026/10/24/r{i}.jsonl")),
            codex_line(100),
        )
        .unwrap();
    }
    std::os::unix::fs::symlink(target, own.join("sessions")).unwrap();
    h
}
/// Ticket 1045: the cap drops the oldest rollouts, so the newest record's limits are still read.
#[test]
fn usage_budget_cap_keeps_the_newest_codex_limits() {
    let h = home::short("usage");
    let own = h.join(".codex");
    let rollout = |day: &str, pct: u32| {
        let dir = own.join(format!("sessions/2026/10/{day}"));
        fs::create_dir_all(&dir).unwrap();
        let reset = NOW + 3600;
        fs::write(
            dir.join("r.jsonl"),
            format!(
                "{{\"timestamp\":\"2026-10-{day}T01:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"total_tokens\":10}},\"last_token_usage\":{{\"input_tokens\":10,\"output_tokens\":0}}}},\"rate_limits\":{{\"primary\":{{\"used_percent\":{pct}.0,\"window_minutes\":300,\"resets_at\":{reset}}}}}}}}}\n"
            ),
        )
        .unwrap();
    };
    rollout("20", 90);
    rollout("24", 30);
    let row = codex_own(&h, &mut Budget::new(1000, 1, u64::MAX));
    assert!(row.partial);
    assert_eq!(row.session.map(|l| l.left_pct), Some(70));
    fs::remove_dir_all(&h).unwrap();
}
fn codex_own(h: &Path, budget: &mut Budget) -> usage::Row {
    let own = h.join(".codex");
    usage::rows(
        h,
        &|a| (a == Agent::Codex).then(|| own.clone()),
        NOW,
        &|_| SEOUL,
        budget,
    )
    .unwrap()
    .into_iter()
    .find(|r| r.agent == Agent::Codex && r.id == "own")
    .unwrap()
}

#[test]
fn usage_codex_link_followed_and_labelled_via_link() {
    let h = home::short("usage");
    let target = h.join("elsewhere/sessions");
    let user = linked_codex(&target, 1);
    let mut budget = Budget::request();
    budget.link_roots = vec![h.clone(), user.clone()];
    let row = codex_own(&user, &mut budget);
    assert_eq!(row.today, 100);
    let link = row.link.expect("a followed link is labelled");
    assert_eq!(link.status, usage::LinkStatus::Followed);
    assert_eq!(link.target, target.to_string_lossy());
    fs::remove_dir_all(&h).unwrap();
    fs::remove_dir_all(&user).unwrap();
}

#[test]
fn usage_link_target_outside_home_refused() {
    let outside = home::short("usage");
    let user = linked_codex(&outside.join("sessions"), 1);
    let mut budget = Budget::request();
    budget.link_roots = vec![user.clone()];
    let row = codex_own(&user, &mut budget);
    assert_eq!(row.today, 0);
    let link = row.link.expect("a refused link says why");
    assert_eq!(link.status, usage::LinkStatus::Outside);
    assert_eq!(link.target, outside.join("sessions").to_string_lossy());
    // Inside a named root but writable by others: refused too.
    let open = user.join("open");
    fs::create_dir_all(open.join("2026/10/24")).unwrap();
    fs::write(open.join("2026/10/24/r.jsonl"), codex_line(100)).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    fs::remove_file(user.join(".codex/sessions")).unwrap();
    std::os::unix::fs::symlink(&open, user.join(".codex/sessions")).unwrap();
    let row = codex_own(&user, &mut budget);
    assert_eq!(row.today, 0);
    assert_eq!(row.link.unwrap().status, usage::LinkStatus::Unsafe);
    fs::remove_dir_all(&outside).unwrap();
    fs::remove_dir_all(&user).unwrap();
}

#[test]
fn usage_nunchiro_account_folder_link_never_followed() {
    let (home, own) = home_with_account(REGISTRY);
    let projects = home.join("accounts/claude").join(ID).join("projects");
    fs::rename(&projects, home.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(home.join("elsewhere"), &projects).unwrap();
    // Even when the link target sits under a named root, the added account's row stays 0 and unlabelled.
    let mut budget = Budget::request();
    budget.link_roots = vec![home.clone()];
    let own = own.to_path_buf();
    let rows = usage::rows(
        &home,
        &|a| (a == Agent::Claude).then(|| own.clone()),
        NOW,
        &|_| SEOUL,
        &mut budget,
    )
    .unwrap();
    let account = rows.iter().find(|r| r.id == ID).unwrap();
    assert_eq!((account.today, account.link.clone()), (0, None));
    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn usage_link_scan_is_capped() {
    let h = home::short("usage");
    let user = linked_codex(&h.join("big"), 5);
    let mut budget = Budget::request();
    budget.link_roots = vec![h.clone(), user.clone()];
    budget.link_cap = (1000, 2, u64::MAX);
    let row = codex_own(&user, &mut budget);
    assert!(row.partial, "{row:?}");
    assert!(row.today < 500, "{row:?}");
    assert_eq!(row.link.unwrap().status, usage::LinkStatus::Capped);
    fs::remove_dir_all(&h).unwrap();
    fs::remove_dir_all(&user).unwrap();
}

// ---- Ticket 211 A2: 5.x and Fable prices from a dated source; an unpriced model is named, not a bare dash. ----
// Pattern after T3 Code `apps/server/src/usage/usagePricing.test.ts` (MIT): known prices per model id.
// Round 2 (review MUST-2): the expected values are the rows of Anthropic's price page as fetched raw on 2026-11-02 from
// https://platform.claude.com/docs/en/about-claude/pricing (columns: base input, 5m cache write, 1h cache write, cache
// hit, output; footnote 2 there: cache hits on Opus 5.5 and Sonnet 5.5 cost 0.05x input, Fable 5.1 0.025x). They are
// parsed here, not copied from `PRICES`, so a wrong literal in the code cannot agree with itself.
const PRICE_PAGE_ROWS: &str = "\
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Opus 4 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
";
/// The API id a page row is priced under (a dated id for the two models the page names without a minor version).
fn page_id(name: &str) -> String {
    let name = name.split(" (").next().unwrap();
    match name {
        "Claude Opus 4" => "claude-opus-4-20250514".into(),
        "Claude Sonnet 4" => "claude-sonnet-4-20250514".into(),
        _ => name.to_lowercase().replace([' ', '.'], "-"),
    }
}
#[test]
fn usage_price_table_has_5x_and_fable_rows_with_dated_source() {
    let mut rows = 0;
    for line in PRICE_PAGE_ROWS.lines() {
        let cells: Vec<&str> = line
            .split('|')
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .collect();
        let usd = |i: usize| -> u64 {
            let v: f64 = cells[i]
                .trim_start_matches('$')
                .split(' ')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            (v * 1000.0).round() as u64
        };
        // [input, output, 5m cache write, cache hit] in milli-dollars per million tokens.
        let want = [usd(1), usd(5), usd(2), usd(4)];
        let id = page_id(cells[0]);
        assert_eq!(
            usage::price_of(&id),
            Some(want),
            "{id} against the price page row {line}"
        );
        // A dated model id (as agents write them) prices the same.
        assert_eq!(
            usage::price_of(&format!("{id}-20261001")),
            Some(want),
            "{id} dated"
        );
        rows += 1;
    }
    assert_eq!(rows, 17);
    assert_eq!(usage::price_of("claude-mystery-9"), None);
    let source = usage::PRICE_SOURCE;
    assert!(
        source.contains("https://platform.claude.com/docs/en/about-claude/pricing"),
        "{source}"
    );
    let date = source
        .split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .find(|w| {
            let b = w.as_bytes();
            b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b[..4].iter().all(u8::is_ascii_digit)
        });
    assert_eq!(date, Some("2026-11-02"), "{source}");
}

#[test]
fn usage_unknown_model_says_cost_unknown_for_model() {
    let h = home::short("usage");
    let own = h.join("own");
    fs::create_dir_all(own.join("projects/p")).unwrap();
    let msg = |id: &str, model: &str| {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-10-24T01:00:00.000Z\",\"message\":{{\"id\":\"{id}\",\"model\":\"{model}\",\"usage\":{{\"input_tokens\":1000000}}}}}}\n"
        )
    };
    fs::write(
        own.join("projects/p/a.jsonl"),
        msg("a", "claude-opus-5-5") + &msg("b", "mystery-1") + &msg("c", "mystery-1"),
    )
    .unwrap();
    let rows = usage::rows(
        &h,
        &|a| (a == Agent::Claude).then(|| own.clone()),
        NOW,
        &|_| SEOUL,
        &mut Budget::request(),
    )
    .unwrap();
    let row = rows.iter().find(|r| r.agent == Agent::Claude).unwrap();
    // Priced: 1M opus-5-5 input = $4.00. The unpriced model is named once, so the page can say what it could not cost.
    assert_eq!(row.last_7d.cost_micro, 4_000_000);
    assert_eq!(row.unpriced_models, ["mystery-1"]);
    fs::remove_dir_all(&h).unwrap();
}

/// Ticket 211 round 2 (review MUST-1), through a real `serve` and the window's own socket: `~/.codex/sessions` is a
/// link into a folder on another volume. It is refused with the target shown, the owner names that folder through the
/// settings request (`quit_settings`, owner and window only), and the next usage reply follows it.
#[test]
fn usage_link_to_other_volume_allowed_after_owner_names_it() {
    let core = Core::new();
    let volume = home::short("usage-vol"); // stands for /Volumes/<name>: outside the core's HOME
    let target = volume.join("Local-Migrations/codex/sessions");
    fs::create_dir_all(target.join("2026/10/24")).unwrap();
    let line = json!({"timestamp":iso_now(),"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"input_tokens":100,"output_tokens":0}}}});
    fs::write(target.join("2026/10/24/r.jsonl"), line.to_string() + "\n").unwrap();
    fs::create_dir_all(core.home.join("codex")).unwrap();
    std::os::unix::fs::symlink(&target, core.home.join("codex/sessions")).unwrap();
    let codex_row = || {
        let reply = core.window(json!({"op":"account_usage"}));
        reply["Ok"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["agent"] == "codex" && r["id"] == "own")
            .unwrap()
            .clone()
    };
    let before = codex_row();
    assert_eq!(before["link"]["status"], "outside", "{before}");
    assert_eq!(
        before["link"]["target"],
        target.to_str().unwrap(),
        "{before}"
    );
    assert_eq!(before["last_24h"]["tokens"], 0, "{before}");

    // Naming something that is not a folder, or a relative path, is refused and stores nothing.
    for bad in [
        volume.join("missing").to_str().unwrap().to_string(),
        "relative/dir".into(),
    ] {
        let r = core.window(json!({"op":"quit_settings","patch":{"usage_allow_link":bad}}));
        assert!(r["Err"].is_string(), "{r}");
    }
    assert_eq!(codex_row()["link"]["status"], "outside");

    let r = core.window(json!({"op":"quit_settings","patch":{"usage_allow_link":target}}));
    assert_eq!(r["Ok"]["type"], "quit_settings", "{r}");
    let after = codex_row();
    assert_eq!(after["link"]["status"], "followed", "{after}");
    assert_eq!(after["last_24h"]["tokens"], 100, "{after}");
    // Stored in the core's settings file, canonical, once even when named twice.
    core.window(json!({"op":"quit_settings","patch":{"usage_allow_link":target}}));
    let saved: Value =
        serde_json::from_slice(&fs::read(core.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["usage_link_roots"], json!([target.to_str().unwrap()]));
    fs::remove_dir_all(&volume).unwrap();
}

// v4 Usage page (usage.html v4): one pass over the own folders sums the range by agent, model, folder and agent session,
// fills the 42-day grid (older days too) and the weekday-by-hour grid, and refuses a range the page does not offer.
#[test]
fn usage_detail_sums_tabs_and_grids() {
    let home = home::short("udetail");
    let claude = home.join("claude");
    let codex = home.join("codex");
    fs::create_dir_all(claude.join("projects/p")).unwrap();
    fs::create_dir_all(codex.join("sessions/2026/10/24")).unwrap();
    let line = |at: &str, id: &str, cwd: &str, sid: &str, model: &str, u: [u64; 4]| {
        json!({"type": "assistant", "timestamp": at, "cwd": cwd, "sessionId": sid, "message": {"id": id, "model": model,
            "usage": {"input_tokens": u[0], "output_tokens": u[1], "cache_creation_input_tokens": u[2], "cache_read_input_tokens": u[3]}}})
        .to_string()
    };
    let body = [
        line(
            "2026-10-21T03:00:00.000Z",
            "m2",
            "/work/lumen",
            "s2",
            "mystery-model",
            [10, 10, 0, 0],
        ),
        line(
            "2026-10-24T11:00:00.000Z",
            "m1",
            "/work/nunchiro",
            "s1",
            "claude-opus-5-5",
            [100, 50, 0, 850],
        ),
        line(
            "2026-09-14T00:00:00.000Z",
            "m3",
            "/work/old",
            "s3",
            "claude-opus-5-5",
            [7, 0, 0, 0],
        ),
    ]
    .join("\n");
    fs::write(claude.join("projects/p/s1.jsonl"), body + "\n").unwrap();
    let rollout = [
        json!({"timestamp": "2026-10-24T09:59:00.000Z", "type": "session_meta", "payload": {"id": "cx1", "cwd": "/work/nunchiro"}}),
        json!({"timestamp": "2026-10-24T09:59:30.000Z", "type": "turn_context", "payload": {"model": "gpt-5"}}),
        json!({"timestamp": "2026-10-24T10:00:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"total_tokens": 300},
            "last_token_usage": {"input_tokens": 200, "cached_input_tokens": 150, "output_tokens": 100}}}}),
    ]
    .map(|v| v.to_string())
    .join("\n");
    fs::write(codex.join("sessions/2026/10/24/r.jsonl"), rollout + "\n").unwrap();
    let own = |a: Agent| {
        Some(if a == Agent::Claude {
            claude.clone()
        } else {
            codex.clone()
        })
    };
    let all = usage::Filter::default();
    let d = usage::detail(
        &home,
        &own,
        NOW,
        &|_| SEOUL,
        30,
        &all,
        &mut Budget::request(),
    )
    .unwrap();
    assert_eq!(d.days, 30);
    assert_eq!(d.total.tokens, 1000 + 20 + 300);
    assert_eq!(d.total.turns, 3);
    assert_eq!(d.total.parts, [100 + 10 + 50, 50 + 10 + 100, 0, 850 + 150]);
    assert_eq!(
        d.total.unpriced, 20,
        "the mystery model is counted in tokens, not priced"
    );
    assert_eq!(d.active_days, 2);
    // The grid: today (local Oct 24) last, Oct 21 three days before, and Sep 14 (40 days back) still drawn.
    assert_eq!(d.daily.len(), 42);
    assert_eq!(d.daily[41], 1300);
    assert_eq!(d.daily[38], 20);
    assert_eq!(d.daily[1], 7);
    assert_eq!(d.hours.len(), 168);
    assert_eq!(d.hours.iter().sum::<u64>(), 1320);
    // 2026-10-24 is a Saturday (Monday = 0); 11:00Z is 20:00 in Seoul.
    assert_eq!(d.hours[5 * 24 + 20], 1000);
    let pick =
        |rows: &[usage::Group], key: &str| rows.iter().find(|g| g.key == key).cloned().unwrap();
    assert_eq!(pick(&d.agents, "claude").sum.tokens, 1020);
    assert_eq!(pick(&d.agents, "codex").sum.tokens, 300);
    assert_eq!(pick(&d.models, "gpt-5").sum.tokens, 300);
    let nunchiro = pick(&d.folders, "/work/nunchiro");
    assert_eq!((nunchiro.sum.tokens, nunchiro.sessions), (1300, 2));
    assert_eq!(nunchiro.top_model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(d.folders[0].key, "/work/nunchiro", "largest first");
    assert_eq!(
        pick(&d.agents, "claude").cwd.as_deref(),
        Some("/work/nunchiro"),
        "an agent's folder is the one with the most tokens, not the first read"
    );
    let s1 = pick(&d.sessions, "claude:s1");
    assert_eq!(
        (s1.sum.tokens, s1.account.as_deref(), s1.cwd.as_deref()),
        (1000, Some("own"), Some("/work/nunchiro"))
    );
    assert_eq!(pick(&d.sessions, "codex:cx1").sum.parts[3], 150);
    assert!(
        !d.folders.iter().any(|g| g.key == "/work/old"),
        "outside the 30 days"
    );
    // The last 24 hours hold only today's two records; a range the page does not offer is refused.
    let day = usage::detail(
        &home,
        &own,
        NOW,
        &|_| SEOUL,
        1,
        &all,
        &mut Budget::request(),
    )
    .unwrap();
    assert_eq!(day.total.tokens, 1300);
    assert!(
        usage::detail(
            &home,
            &own,
            NOW,
            &|_| SEOUL,
            5,
            &all,
            &mut Budget::request()
        )
        .is_err()
    );
    // Ticket 324: an account or a list of sessions narrows every sum, the grids included; an empty list counts nothing.
    let with = |account: Option<&str>, sessions: Option<Vec<&str>>| {
        let filter = usage::Filter::new(
            account.map(String::from),
            sessions.map(|s| s.into_iter().map(String::from).collect()),
        );
        usage::detail(
            &home,
            &own,
            NOW,
            &|_| SEOUL,
            30,
            &filter,
            &mut Budget::request(),
        )
        .unwrap()
    };
    let codex_only = with(Some("codex:own"), None);
    assert_eq!(codex_only.total.tokens, 300);
    assert_eq!(codex_only.daily[41], 300);
    assert_eq!(codex_only.hours.iter().sum::<u64>(), 300);
    assert_eq!(with(Some("claude:own"), None).total.tokens, 1020);
    assert_eq!(with(Some("claude:other"), None).total.tokens, 0);
    let nunchiro_only = with(None, Some(vec!["s1", "cx1"]));
    assert_eq!(nunchiro_only.total.tokens, 1300);
    assert!(!nunchiro_only.sessions.iter().any(|g| g.key == "claude:s2"));
    assert_eq!(with(Some("codex:own"), Some(vec!["s1"])).total.tokens, 0);
    assert_eq!(with(None, Some(vec![])).total.tokens, 0);
    fs::remove_dir_all(&home).unwrap();
}
