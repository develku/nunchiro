//! V2-8c: PR badge tier 2. `pr_live::Poller` runs the user's `gh` (a PATH shim here) on a fake clock; the ops that
//! drive it are window only.
#[path = "fixtures/gh_pin.rs"]
mod gh_pin;
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{
    api::*,
    chat::pr::{self, PrState},
    pr_live::{self, Live, Poller},
    server::call,
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const A12: &str = "https://github.com/develku/nunchiro/pull/12";
const A13: &str = "https://github.com/develku/nunchiro/pull/13";
const B7: &str = "https://github.com/other/thing/pull/7";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/pr_live")
        .join(name)
}

/// A `gh` on a PATH of its own: each run appends its argv (one line) to `runs`, prints `stdout` and `stderr`, exits
/// with `code`.
struct Shim {
    dir: PathBuf,
}
impl Shim {
    fn new(stdout: &str, stderr: &str, code: i32) -> Self {
        let dir = home::short("prlive");
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("out"), stdout).unwrap();
        fs::write(dir.join("err"), stderr).unwrap();
        let script = format!(
            "#!/bin/sh\nprintf '%s|' \"$@\" >> '{d}/runs'\nprintf '\\n' >> '{d}/runs'\n/usr/bin/env > '{d}/env'\n/bin/cat '{d}/out'\n/bin/cat '{d}/err' >&2\nexit $(/bin/cat '{d}/code')\n",
            d = dir.display()
        );
        fs::write(dir.join("code"), code.to_string()).unwrap();
        let gh = dir.join("bin/gh");
        fs::write(&gh, script).unwrap();
        fs::set_permissions(gh, fs::Permissions::from_mode(0o700)).unwrap();
        Self { dir }
    }
    /// What the next runs print and exit with.
    fn set(&self, stdout: &str, stderr: &str, code: i32) {
        fs::write(self.dir.join("out"), stdout).unwrap();
        fs::write(self.dir.join("err"), stderr).unwrap();
        fs::write(self.dir.join("code"), code.to_string()).unwrap();
    }
    fn fixture(name: &str) -> Self {
        Self::new(&fs::read_to_string(fixture(name)).unwrap(), "", 0)
    }
    fn env(&self) -> Vec<(OsString, OsString)> {
        vec![
            ("PATH".into(), self.dir.join("bin").into()),
            ("HOME".into(), self.dir.clone().into()),
        ]
    }
    fn poller(&self) -> Poller {
        Poller::new(self.env())
    }
    fn runs(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("runs"))
            .unwrap_or_default()
            .lines()
            .map(Into::into)
            .collect()
    }
}
impl Drop for Shim {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn live_status_off_by_default() {
    let shim = Shim::fixture("open.json");
    let mut p = shim.poller();
    p.sync(false, &s(&[A12]));
    p.created([A13.to_string()]);
    let t0 = Instant::now();
    for secs in [0, 30, 61, 125] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
    }
    assert!(shim.runs().is_empty(), "gh ran with the setting off");
    assert_eq!(p.live(A12), None);

    // A fresh core home: the setting reads off and the offer is still to come.
    let core = Core::new();
    let reply = core.window(json!({"op":"pr_live"}));
    assert_eq!(reply["Ok"]["on"], false, "{reply}");
    assert_eq!(reply["Ok"]["offered"], false, "{reply}");
}

#[test]
fn poll_only_when_window_in_front() {
    let shim = Shim::fixture("open.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    // No heartbeat yet.
    p.tick(t0);
    assert_eq!(shim.runs().len(), 0, "ran with no heartbeat");
    // A heartbeat 91 s old is stale.
    p.front(t0, true);
    p.tick(t0 + Duration::from_secs(91));
    assert_eq!(shim.runs().len(), 0, "ran on a stale heartbeat");
    // In the background.
    let t1 = t0 + Duration::from_secs(200);
    p.front(t1, false);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 0, "ran in the background");
    // In front: runs, then not again before 60 s.
    p.front(t1, true);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 1);
    assert_eq!(
        p.live(A12),
        Some(Live {
            state: PrState::Open,
            url: A12.into()
        })
    );
    p.tick(t1 + Duration::from_secs(59));
    assert_eq!(shim.runs().len(), 1, "polled before 60 s");
    p.front(t1 + Duration::from_secs(59), true);
    p.tick(t1 + Duration::from_secs(60));
    assert_eq!(shim.runs().len(), 2);
}

#[test]
fn poll_only_agent_created_or_pinned_prs() {
    let shim = Shim::fixture("merged.json");
    let mut p = shim.poller();
    p.sync(true, &[]);
    // Someone else's PR the agent only looked at.
    let viewed = [
        json!({"kind":"tool_use","tool_id":"v","name":"Bash","input":{"command":"gh pr view 13"}}),
        json!({"kind":"tool_result","tool_id":"v","output":format!("state: OPEN\n{A13}\n"),"is_error":false}),
    ];
    assert!(pr::created(&viewed).is_empty());
    p.created(pr::created(&viewed));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert!(
        shim.runs().is_empty(),
        "polled a PR nobody created or pinned"
    );
    // The agent created 12; the owner pinned 13.
    let made = [
        json!({"kind":"tool_use","tool_id":"c","name":"Bash","input":{"command":"gh pr create --fill"}}),
        json!({"kind":"tool_result","tool_id":"c","output":format!("{A12}\n"),"is_error":false}),
    ];
    assert_eq!(pr::created(&made), vec![A12.to_string()]);
    p.created(pr::created(&made));
    p.sync(true, &s(&[A13]));
    p.tick(t0 + Duration::from_secs(1));
    let runs = shim.runs();
    assert_eq!(runs.len(), 1);
    assert!(
        runs[0].contains("p12:pullRequest(number:12)")
            && runs[0].contains("p13:pullRequest(number:13)"),
        "{runs:?}"
    );
    assert_eq!(p.live(A12).unwrap().state, PrState::Merged);
    assert_eq!(p.live(A13).unwrap().state, PrState::Approved);
    // Unpinned: 13 is no longer polled or shown.
    p.sync(true, &[]);
    assert_eq!(p.live(A13), None);
}

#[test]
fn poll_is_batched_per_repo() {
    let shim = Shim::fixture("merged.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12, A13]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(shim.runs().len(), 1, "two PRs of one repo: one gh run");
    p.sync(true, &s(&[A12, A13, B7]));
    let t1 = t0 + Duration::from_secs(60);
    p.front(t1, true);
    p.tick(t1);
    let runs = shim.runs();
    assert_eq!(runs.len(), 3, "two repos: two gh runs");
    assert!(runs[2].contains("owner=other|") && runs[2].contains("name=thing|"));
    // Security review S1: however many repos agents named, one poll runs gh for at most MAX_REPOS of them.
    let many: Vec<String> = (0..pr_live::MAX_REPOS + 5)
        .map(|i| format!("https://github.com/o/r{i}/pull/1"))
        .collect();
    p.created(many);
    let t2 = t1 + Duration::from_secs(60);
    p.front(t2, true);
    p.tick(t2);
    assert_eq!(shim.runs().len(), 3 + pr_live::MAX_REPOS);
}

#[test]
fn gh_argument_vector_is_fixed() {
    let argv = pr_live::argv("develku", "nunchiro", &[12, 13]).unwrap();
    let query = "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){\
p12:pullRequest(number:12){number url state isDraft reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}} \
p13:pullRequest(number:13){number url state isDraft reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}";
    assert_eq!(
        argv,
        s(&[
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            query,
            "-f",
            "owner=develku",
            "-f",
            "name=nunchiro",
        ])
    );
    for bad in [
        "a;b", "$(id)", "a b", "..", "a..b", "-x", "", ".", "a/b", "a`b", "é",
    ] {
        assert!(pr_live::argv(bad, "repo", &[1]).is_err(), "owner {bad:?}");
        assert!(pr_live::argv("owner", bad, &[1]).is_err(), "repo {bad:?}");
    }
    assert!(pr_live::argv("owner", &"r".repeat(101), &[1]).is_err());
    assert!(pr_live::argv("owner", "repo", &[]).is_err());
    assert!(pr_live::argv("owner", "repo", &[0]).is_err());
    // A watch URL with a bad piece is refused before it can reach argv.
    let shim = Shim::fixture("open.json");
    let mut p = shim.poller();
    p.sync(
        true,
        &s(&[
            "https://github.com/a;b/repo/pull/1",
            "https://github.com/-x/repo/pull/1",
            "https://github.com/owner/../pull/1",
            "https://github.com/owner/repo/pull/1x",
            "https://evil.example/owner/repo/pull/1",
        ]),
    );
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert!(shim.runs().is_empty(), "{:?}", shim.runs());

    let src = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/pr_live.rs"))
        .unwrap();
    for banned in ["\"sh\"", "\"-c\"", "shell", "/bin/sh", "bash"] {
        assert!(!src.contains(banned), "pr_live.rs has {banned}");
    }
}

#[test]
fn gh_missing_gives_hint_not_error() {
    // No gh on PATH at all.
    let empty = home::short("prlive");
    let mut p = Poller::new(vec![("PATH".into(), empty.clone().into())]);
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(p.live(A12), None);
    assert!(p.hint().unwrap().contains("not found"), "{:?}", p.hint());
    fs::remove_dir_all(empty).unwrap();

    // gh present, not logged in (exit 4).
    let shim = Shim::new(
        "",
        "To get started with GitHub CLI, please run:  gh auth login\n",
        4,
    );
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(p.live(A12), None);
    assert!(
        p.hint().unwrap().contains("gh auth login"),
        "{:?}",
        p.hint()
    );

    // In the core: the window's settings read carries the hint; the tier-1 chip is untouched.
    let core = Core::new();
    let s1 = core.start();
    core.transcript(&s1, &pr_transcript("gh pr create"));
    let chip = core.window(json!({"op":"pr_chip","id":s1.id}));
    assert_eq!(chip["Ok"]["chip"]["state"], "open", "{chip}");
    assert_eq!(chip["Ok"]["chip"]["url"], A12);
    let reply = core.window_all(&[
        json!({"op":"pr_live_set","on":true}),
        json!({"op":"pr_front","front":true}),
    ]);
    assert_eq!(reply[1]["Ok"]["on"], true, "{reply:?}");
    let until = Instant::now() + Duration::from_secs(10);
    let hint = loop {
        let r = core.window(json!({"op":"pr_live","url":A12}));
        assert!(r["Err"].is_null(), "{r}");
        if r["Ok"]["hint"].is_string() {
            assert_eq!(r["Ok"]["live"], Value::Null);
            break r["Ok"]["hint"].as_str().unwrap().to_string();
        }
        assert!(Instant::now() < until, "no hint: {r}");
        core.window(json!({"op":"pr_front","front":true}));
        thread::sleep(Duration::from_millis(100));
    };
    assert!(hint.contains("not found"), "{hint}");
    let chip = core.window(json!({"op":"pr_chip","id":s1.id}));
    assert_eq!(chip["Ok"]["chip"]["state"], "open", "{chip}");
}

#[test]
fn live_output_is_validated() {
    let ok = |name: &str, numbers: &[u64]| {
        pr_live::parse(
            "develku",
            "nunchiro",
            numbers,
            &fs::read(fixture(name)).unwrap(),
        )
        .unwrap()
    };
    let one = |state| {
        vec![Live {
            state,
            url: A12.into(),
        }]
    };
    assert_eq!(ok("open.json", &[12]), one(PrState::Open));
    assert_eq!(ok("draft.json", &[12]), one(PrState::Draft));
    assert_eq!(ok("failing.json", &[12]), one(PrState::ChecksFail));
    assert_eq!(ok("empty.json", &[12]), vec![]);
    let merged = ok("merged.json", &[12, 13]);
    assert_eq!(merged[0].state, PrState::Merged);
    assert_eq!(merged[1].state, PrState::Approved);
    // ANSI, javascript: URL, markup, wrong number, wrong repo, unknown state: dropped; a title never travels.
    let hostile = ok("hostile.json", &[12, 13, 14, 15, 16, 17, 18]);
    assert_eq!(
        hostile,
        vec![Live {
            state: PrState::Closed,
            url: "https://github.com/develku/nunchiro/pull/18".into()
        }]
    );
    let wire = serde_json::to_string(&hostile).unwrap();
    assert!(
        !wire.contains("title") && !wire.contains('\u{1b}'),
        "{wire}"
    );
    // Not JSON, oversize, rate limited: an error, no values.
    let parse = |b: &[u8]| pr_live::parse("develku", "nunchiro", &[12], b);
    assert!(parse(b"\x1b[31mnot json").is_err());
    let mut big = b"{\"data\":{\"repository\":{}},\"x\":\"".to_vec();
    big.extend(std::iter::repeat_n(
        b'a',
        nunchiro_core::process::OUTPUT_CAP,
    ));
    big.extend(b"\"}");
    assert!(parse(&big).is_err());
    assert!(parse(&fs::read(fixture("rate_limited.json")).unwrap()).is_err());

    // A rate-limited run keeps nothing new and sets no hint.
    let shim = Shim::new(
        &fs::read_to_string(fixture("rate_limited.json")).unwrap(),
        "gh: API rate limit already exceeded\n",
        1,
    );
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    let logged = p.tick(t0);
    assert_eq!(p.live(A12), None);
    assert_eq!(p.hint(), None);
    assert!(
        logged.iter().any(|l| l.contains("rate limit")),
        "{logged:?}"
    );
}

#[test]
fn core_makes_no_other_network_call() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Security review M1: gh's own telemetry is off, and gh sees no user variable outside the allowlist.
    let shim = Shim::fixture("open.json");
    let mut env = shim.env();
    env.push(("GH_CONFIG_DIR".into(), shim.dir.clone().into()));
    let mut p = Poller::new(env);
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    let seen = fs::read_to_string(shim.dir.join("env")).unwrap();
    let mut names: Vec<&str> = seen.lines().filter_map(|l| l.split('=').next()).collect();
    names.sort();
    assert!(seen.lines().any(|l| l == "GH_TELEMETRY=0"), "{seen}");
    for n in &names {
        assert!(
            [
                "PATH",
                "HOME",
                "GH_CONFIG_DIR",
                "GH_TELEMETRY",
                "GH_PROMPT_DISABLED",
                "GH_NO_UPDATE_NOTIFIER",
                "NO_COLOR",
                "PWD",
                "SHLVL",
                "_",
            ]
            .contains(n),
            "gh saw {n}: {seen}"
        );
    }
    let src = fs::read_to_string(root.join("src/pr_live.rs")).unwrap();
    // The one spawn: `gh` through process::output.
    // Ticket 1024: spelled `process::command` (no secret variable inherited), as every spawn of the core.
    assert_eq!(src.matches("process::command(").count(), 1);
    assert_eq!(src.matches("Command::new(").count(), 0);
    // Ticket 424: `gh` found on the PATH gh itself gets, so it starts by posix_spawn.
    assert!(
        src.contains(
            "let program = crate::process::resolve_program(GH, crate::process::env_path(env));"
        ) && src.contains("process::command(program)")
            && src.contains("const GH: &str = \"gh\";")
    );
    assert_eq!(src.matches("process::output(").count(), 1);
    for banned in [
        "TcpStream",
        "UnixStream",
        "std::net",
        "curl",
        ".config/gh",
        "hosts.yml",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
    ] {
        assert!(!src.contains(banned), "pr_live.rs has {banned}");
    }
    // Outside this module and themes_online, no core source names a network client or `gh`.
    let mut stack = vec![root.join("src")];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(dir).unwrap() {
            let path = e.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if matches!(name.as_str(), "pr_live.rs" | "themes_online.rs") {
                continue;
            }
            let mut text = fs::read_to_string(&path).unwrap();
            // V2-8a (needs 82): its one exact gh call is pinned, then the same bans apply to the rest.
            if name == "worktree_clean.rs" {
                text = gh_pin::worktree_clean_without_its_gh(&text);
            }
            for banned in [
                "/usr/bin/curl",
                "Command::new(\"gh\")",
                "Command::new(\"curl\")",
                "process::command(\"gh\")",
                "process::command(\"curl\")",
            ] {
                assert!(!text.contains(banned), "{} has {banned}", path.display());
            }
        }
    }
}

#[test]
fn pr_live_ops_window_only() {
    let core = Core::new();
    let ops = [
        json!({"op":"pr_live"}),
        json!({"op":"pr_live_set","on":true}),
        json!({"op":"pr_watch","url":A12,"on":true}),
        json!({"op":"pr_front","front":true}),
    ];
    // The window may.
    for op in &ops {
        let r = core.window(op.clone());
        assert!(r["Ok"].is_object(), "{op} {r}");
    }
    let r = core.window(json!({"op":"pr_live","url":A12}));
    assert_eq!(r["Ok"]["watched"], true, "{r}");
    assert_eq!(r["Ok"]["on"], true, "{r}");
    // A bad URL is refused, not stored.
    let r = core.window(json!({"op":"pr_watch","url":"https://github.com/a;b/c/pull/1","on":true}));
    assert!(r["Err"].is_string(), "{r}");
    let stored: Value =
        serde_json::from_slice(&fs::read(core.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(stored["pr_watch"], json!([A12]));
    assert_eq!(stored["live_pr_status"], true);
    // The owner socket answers only through the window dispatch; never forwarded.
    for op in &ops {
        let req: Request = serde_json::from_value(op.clone()).unwrap();
        assert!(call(&core.home, req.clone()).is_err(), "{op}");
        let fwd = call(
            &core.home,
            Request::Remote {
                machine: "nowhere".into(),
                request: Box::new(req),
            },
        );
        assert!(fwd.unwrap_err().contains("local owner-only"), "{op}");
    }
    // A session token is refused.
    let token = core.session_token();
    for op in &ops {
        let mut sock =
            std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":op})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap(),
            json!({"Err":"operation not granted"}),
            "{op}"
        );
    }
    // The settings file still says what the window wrote.
    let stored: Value =
        serde_json::from_slice(&fs::read(core.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(stored["live_pr_status"], true);
}

#[test]
fn error_text_is_redacted() {
    let secret = format!("ghp_{}", "A1b2C3d4E5".repeat(4).get(..36).unwrap());
    let shim = Shim::new("", &format!("HTTP 401: Bad credentials {secret}\n"), 1);
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    let logged = p.tick(t0);
    assert!(!logged.is_empty());
    for l in &logged {
        assert!(!l.contains(&secret), "{l}");
    }
    assert!(logged.iter().any(|l| l.contains("[redacted")), "{logged:?}");
}

// Round 2 (security MUST): each `gh` run of a poll re-checks the setting and the front; turning off mid-poll stops it.
#[test]
fn pr_live_stops_mid_batch_when_turned_off() {
    let shim = Shim::fixture("open.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12, B7]));
    let t0 = Instant::now();
    p.front(t0, true);
    assert!(p.step(t0).is_some());
    assert_eq!(shim.runs().len(), 1);
    p.sync(false, &s(&[A12, B7]));
    assert!(p.step(t0).is_none());
    assert_eq!(
        shim.runs().len(),
        1,
        "a second repo ran after the setting went off"
    );
    // The window going to the back stops the rest of a poll the same way.
    p.sync(true, &s(&[A12, B7]));
    let t1 = t0 + Duration::from_secs(60);
    p.front(t1, true);
    assert!(p.step(t1).is_some());
    assert_eq!(shim.runs().len(), 2);
    p.front(t1, false);
    assert!(p.step(t1).is_none());
    // The dropped rest does not run when the window comes back before the next poll is due.
    p.front(t1, true);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 2, "{:?}", shim.runs());
}

#[test]
fn failed_poll_falls_back_to_tier1() {
    let shim = Shim::fixture("open.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(p.live(A12).unwrap().state, PrState::Open);
    shim.set("", "HTTP 502\n", 1);
    let t1 = t0 + Duration::from_secs(60);
    p.front(t1, true);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 2);
    assert_eq!(p.live(A12), None, "a failed poll left a stale live state");
    assert_eq!(p.hint(), None);
}

#[test]
fn errors_back_off_five_minutes() {
    let shim = Shim::new("", "HTTP 502\n", 1);
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    for (secs, runs) in [(0, 1), (60, 1), (120, 1), (240, 1), (299, 1), (300, 2)] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
        assert_eq!(shim.runs().len(), runs, "at {secs} s");
    }
    // A success clears the back-off: polls return to every 60 s.
    shim.set(&fs::read_to_string(fixture("open.json")).unwrap(), "", 0);
    let t1 = t0 + Duration::from_secs(600);
    p.front(t1, true);
    p.tick(t1);
    let t2 = t1 + Duration::from_secs(60);
    p.front(t2, true);
    p.tick(t2);
    assert_eq!(shim.runs().len(), 4);
    // gh missing or not logged in backs off too.
    let shim = Shim::new(
        "",
        "To get started with GitHub CLI, please run:  gh auth login\n",
        4,
    );
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    for secs in [0, 60, 120] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
    }
    assert_eq!(shim.runs().len(), 1);
    assert!(p.hint().is_some());
}

#[test]
fn merged_or_closed_prs_stop_polling() {
    let shim = Shim::fixture("merged.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12, A13]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    let t1 = t0 + Duration::from_secs(60);
    p.front(t1, true);
    p.tick(t1);
    let runs = shim.runs();
    assert_eq!(runs.len(), 2);
    assert!(runs[0].contains("p12:") && runs[0].contains("p13:"));
    assert!(
        !runs[1].contains("p12:") && runs[1].contains("p13:"),
        "{runs:?}"
    );
    // The final state stays on the chip.
    assert_eq!(p.live(A12).unwrap().state, PrState::Merged);
    // Only merged and closed ones left: no run at all.
    let shim = Shim::fixture("merged.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    for secs in [0, 60, 120] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
    }
    assert_eq!(shim.runs().len(), 1);
}

#[test]
fn reopened_pr_is_polled_again() {
    let open = fs::read_to_string(fixture("open.json")).unwrap();
    let closed = open.replace(r#""state":"OPEN""#, r#""state":"CLOSED""#);
    assert_ne!(open, closed);
    let shim = Shim::new(&closed, "", 0);
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(p.live(A12).unwrap().state, PrState::Closed);
    // Closed is re-checked every 10 minutes, not every minute.
    for secs in [60, 300, 599] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
        assert_eq!(shim.runs().len(), 1, "closed PR re-polled at {secs} s");
    }
    assert_eq!(p.live(A12).unwrap().state, PrState::Closed);
    // Reopened on GitHub: the next re-check shows it, then it is polled every 60 s again.
    shim.set(&open, "", 0);
    let t1 = t0 + Duration::from_secs(600);
    p.front(t1, true);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 2);
    assert_eq!(p.live(A12).unwrap().state, PrState::Open);
    let t2 = t1 + Duration::from_secs(60);
    p.front(t2, true);
    p.tick(t2);
    assert_eq!(shim.runs().len(), 3);
    // Still closed at a re-check: the next one is 10 minutes after it.
    let shim = Shim::new(&closed, "", 0);
    let mut p = shim.poller();
    p.sync(true, &s(&[A12]));
    for (secs, runs) in [(0, 1), (600, 2), (1100, 2), (1200, 3)] {
        let now = t0 + Duration::from_secs(secs);
        p.front(now, true);
        p.tick(now);
        assert_eq!(shim.runs().len(), runs, "at {secs} s");
    }
}

#[test]
fn hint_keeps_or_clears_merged_chips() {
    // Decision: the hint keeps merged chips (a merged PR cannot change back) and clears every other live state.
    let shim = Shim::fixture("merged.json");
    let mut p = shim.poller();
    p.sync(true, &s(&[A12, A13]));
    let t0 = Instant::now();
    p.front(t0, true);
    p.tick(t0);
    assert_eq!(p.live(A12).unwrap().state, PrState::Merged);
    assert_eq!(p.live(A13).unwrap().state, PrState::Approved);
    shim.set(
        "",
        "To get started with GitHub CLI, please run:  gh auth login\n",
        4,
    );
    let t1 = t0 + Duration::from_secs(60);
    p.front(t1, true);
    p.tick(t1);
    assert_eq!(shim.runs().len(), 2);
    assert!(p.hint().unwrap().contains("gh auth login"));
    assert_eq!(
        p.live(A12),
        Some(Live {
            state: PrState::Merged,
            url: A12.into()
        }),
        "the hint dropped a merged chip"
    );
    assert_eq!(p.live(A13), None, "the hint kept an open PR's live state");
}

fn pr_transcript(command: &str) -> String {
    let a = json!({"type":"assistant","timestamp":"2026-10-27T09:59:00.000Z","message":{"content":[{"type":"tool_use","id":"u1","name":"Bash","input":{"command":command}}]}});
    let r = json!({"type":"user","timestamp":"2026-10-27T10:00:00.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":A12}]}});
    format!("{a}\n{r}\n")
}

/// A core whose PATH holds no `gh` (only the fake claude), so a live poll sets the "not found" hint.
struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        // `cargo test -p nunchiro-core` does not rebuild the `nunchiro` binary these tests spawn; a stale one
        // predates the PR view ops and fails far from the cause (round 2 of ticket 149).
        let bin = cli::path();
        let bytes = fs::read(&bin).expect("target/debug/nunchiro: run `cargo build -p nunchiro`");
        assert!(
            bytes.windows(8).any(|w| w == b"pr_merge"),
            "stale target/debug/nunchiro (no pr_merge op): run `cargo build -p nunchiro`"
        );
        let home = home::short("prlive");
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake, b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"2.1.310 (Claude Code)\"; exit; fi\nexec /bin/cat\n").unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
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
    fn start_kind(&self, kind: AgentKind, args: Vec<String>) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.join("cwd"),
                    worktree: false,
                    label: "prlive".into(),
                    args,
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
    fn start(&self) -> Session {
        self.start_kind(AgentKind::Claude, vec![])
    }
    fn session_token(&self) -> String {
        let agent = self.start_kind(
            AgentKind::Shell,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
            ],
        );
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Reply::Output { data, .. } = call(
                &self.home,
                Request::Read {
                    id: agent.id.clone(),
                    after: 0,
                },
            )
            .unwrap() else {
                panic!()
            };
            let out = String::from_utf8_lossy(&data).into_owned();
            // The first line starts with the holder's size mark (ticket 995).
            if let Some((_, t)) = out.lines().find_map(|l| l.split_once("TOKEN:")) {
                return t.trim().to_string();
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn transcript(&self, s: &Session, body: &str) {
        let encoded: String = s
            .cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = self.home.join("agent/projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
        fs::write(&path, body).unwrap();
        call(
            &self.home,
            Request::Hook {
                id: s.id.clone(),
                event: "SessionStart".into(),
                payload: json!({"session_id":s.agent_session_id,"transcript_path":path}),
            },
        )
        .unwrap();
    }
    fn window(&self, request: Value) -> Value {
        self.window_all(&[request]).remove(0)
    }
    fn window_all(&self, requests: &[Value]) -> Vec<Value> {
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
        // Ticket 484: a short read timeout only paces the deadline loop below; a fixed 5 s timeout on the socket was
        // the wait, and it ran out before a reply the core may take up to its own bound to send.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.get_ref()
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut out = vec![];
        for (i, request) in requests.iter().enumerate() {
            let id = 100 + i as u64;
            ws.send(Message::Text(
                json!({"id":id,"request":request}).to_string().into(),
            ))
            .unwrap();
            // The core's own bound for the slowest op here: `pr_view` runs `gh` twice, each up to 15 s
            // (`VIEW_TIMEOUT`), so a reply is due within 30 s; a core past that is a failure the reply names.
            let until = Instant::now() + Duration::from_secs(35);
            loop {
                let message = match ws.read() {
                    Ok(message) => message,
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        assert!(
                            Instant::now() < until,
                            "no reply to {request} within the core's bound"
                        );
                        continue;
                    }
                    Err(e) => panic!("window socket for {request}: {e}"),
                };
                if let Message::Text(t) = message {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["id"] == id {
                        out.push(v["response"].clone());
                        break;
                    }
                }
            }
        }
        out
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

/// Ticket 484: writes the core's fake `gh` and runs it once, then clears its log. macOS checks a new executable at its
/// first run, and on a busy gate machine that check queued for seconds (S4 flakes 4): inside the core's request, past
/// the window's wait. A real `gh` has run before; this one now has too, outside any bound.
fn install_gh(core: &Core, script: &str) {
    let gh = core.home.join("bin/gh");
    fs::write(&gh, script).unwrap();
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
    let ran = std::process::Command::new(&gh).output().unwrap();
    assert!(ran.status.success(), "{ran:?}");
    let _ = fs::remove_file(core.home.join("gh-runs"));
}

/// V2.5-8/9: a `gh` in the core's PATH that logs each argv line to `<home>/gh-runs` and answers per subcommand.
fn gh_shim(core: &Core) {
    let h = core.home.display();
    let view = json!({"number":12,"title":"Add the PR view","url":A12,"state":"OPEN","isDraft":false,"author":"develku",
        "body":"Body","createdAt":"2026-10-30T10:00:00Z","headRefOid":"0123456789abcdef0123456789abcdef01234567",
        "headRefName":"herdr/v25-pr-view","baseRefName":"main","reviewDecision":"APPROVED","mergeable":"MERGEABLE",
        "additions":3,"deletions":1,"labels":["ui"],"requested":["bob"],"latest":[{"who":"amy","state":"APPROVED"}],
        "checks":[{"status":"COMPLETED","conclusion":"SUCCESS","state":""}],
        "commits":[{"at":"2026-10-30T10:01:00Z","who":"develku","text":"first"}],
        "comments":[{"at":"2026-10-30T10:03:00Z","who":"bob","text":"looks fine"}],
        "reviews":[{"at":"2026-10-30T10:02:00Z","who":"amy","state":"APPROVED","text":""}],
        "files":[{"path":"web/src/pr/PrView.tsx","additions":3,"deletions":1}]});
    fs::write(core.home.join("gh-view"), view.to_string()).unwrap();
    let script = format!(
        "#!/bin/sh\nprintf '%s|' \"$@\" >> '{h}/gh-runs'\nprintf '\\n' >> '{h}/gh-runs'\ncase \"$2\" in\n  view) /bin/cat '{h}/gh-view' ;;\n  diff) printf '+added\\n-removed\\n' ;;\n  list) printf '[]' ;;\nesac\n"
    );
    install_gh(core, &script);
}
fn gh_runs(core: &Core) -> Vec<String> {
    fs::read_to_string(core.home.join("gh-runs"))
        .unwrap_or_default()
        .lines()
        .map(Into::into)
        .collect()
}
const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn pr_view_reads_through_gh() {
    let core = Core::new();
    gh_shim(&core);
    // Off: no gh run.
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert!(r["Err"].as_str().unwrap().starts_with("off:"), "{r}");
    assert!(gh_runs(&core).is_empty());
    core.window(json!({"op":"pr_live_set","on":true}));
    // needs 82: a repository no agent PR or pin names is refused before any gh run.
    let r = core.window(json!({"op":"pr_view","url":B7}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    let r = core.window(json!({"op":"pr_merge","url":B7,"method":"squash","head":HEAD}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    assert!(gh_runs(&core).is_empty(), "{:?}", gh_runs(&core));
    core.window(json!({"op":"pr_watch","url":A12,"on":true}));
    let r = core.window(json!({"op":"pr_view","url":A12}));
    let v = &r["Ok"]["view"];
    assert_eq!(v["title"], "Add the PR view", "{r}");
    assert_eq!(v["merge"], true, "a pinned PR keeps its merge (ticket 373)");
    assert_eq!(v["checks"], "pass");
    assert_eq!(v["head"], HEAD);
    assert_eq!(v["diff"], "+added\n-removed\n");
    assert_eq!(
        v["reviewers"],
        json!([{"who":"amy","state":"APPROVED"},{"who":"bob","state":"requested"}])
    );
    let kinds: Vec<_> = v["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].clone())
        .collect();
    assert_eq!(kinds, [json!("commit"), json!("review"), json!("comment")]);
    // A link that is not a GitHub pull is refused before any gh run.
    let n = gh_runs(&core).len();
    let r = core.window(json!({"op":"pr_view","url":"https://github.com/a;b/c/pull/1"}));
    assert!(r["Err"].is_string(), "{r}");
    assert_eq!(gh_runs(&core).len(), n);
}

#[test]
fn merge_needs_confirm() {
    let core = Core::new();
    gh_shim(&core);
    core.window(json!({"op":"pr_live_set","on":true}));
    // needs 82: a repository no agent PR or pin names is refused before any gh run.
    let r = core.window(json!({"op":"pr_view","url":B7}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    let r = core.window(json!({"op":"pr_merge","url":B7,"method":"squash","head":HEAD}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    assert!(gh_runs(&core).is_empty(), "{:?}", gh_runs(&core));
    core.window(json!({"op":"pr_watch","url":A12,"on":true}));
    // No confirmed head commit (the confirm step sends it): refused, gh never runs.
    for head in [
        None,
        Some(""),
        Some("abc"),
        Some("zz23456789abcdef0123456789abcdef01234567"),
    ] {
        let mut op = json!({"op":"pr_merge","url":A12,"method":"squash"});
        if let Some(h) = head {
            op["head"] = json!(h);
        }
        let r = core.window(op);
        assert!(
            r["Err"].as_str().unwrap().contains("confirmed head commit"),
            "{r}"
        );
    }
    let r = core.window(json!({"op":"pr_merge","url":A12,"method":"--admin","head":HEAD}));
    assert!(r["Err"].is_string(), "{r}");
    assert!(gh_runs(&core).is_empty(), "{:?}", gh_runs(&core));
    // Confirmed: one gh run, pinned to the head commit the user saw.
    let r = core.window(json!({"op":"pr_merge","url":A12,"method":"squash","head":HEAD}));
    assert_eq!(r["Ok"]["url"], A12, "{r}");
    assert_eq!(
        gh_runs(&core),
        [format!(
            "pr|merge|{A12}|--squash|--match-head-commit|{HEAD}|"
        )]
    );
}

#[test]
fn merge_owner_only() {
    let core = Core::new();
    gh_shim(&core);
    core.window(json!({"op":"pr_live_set","on":true}));
    let ops = [
        json!({"op":"pr_view","url":A12}),
        json!({"op":"pr_list"}),
        json!({"op":"pr_merge","url":A12,"method":"squash","head":HEAD}),
        json!({"op":"git_push","session":"s","head":HEAD}),
        json!({"op":"pr_draft","session":"s"}),
        json!({"op":"pr_create","session":"s","head":HEAD,"title":"t","body":"b","base":"main"}),
    ];
    // A session token is refused.
    let token = core.session_token();
    for op in &ops {
        let mut sock =
            std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":op})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap(),
            json!({"Err":"operation not granted"}),
            "{op}"
        );
    }
    // The owner socket answers only through the window dispatch; never forwarded.
    for op in &ops {
        let req: Request = serde_json::from_value(op.clone()).unwrap();
        assert!(call(&core.home, req.clone()).is_err(), "{op}");
        let fwd = call(
            &core.home,
            Request::Remote {
                machine: "nowhere".into(),
                request: Box::new(req),
            },
        );
        assert!(fwd.unwrap_err().contains("local owner-only"), "{op}");
    }
    assert!(gh_runs(&core).is_empty(), "{:?}", gh_runs(&core));
}

/// The Diff panel's Push: the window's request, with the head commit its strip showed, pushes the session's branch to
/// a local bare remote; without that head nothing runs.
#[test]
fn git_push_from_the_window_moves_the_remote() {
    let core = Core::new();
    let dir = core.home.join("cwd");
    let git = |args: &[&str]| {
        let out = home::git_env::scrubbed("git")
            .arg("-C")
            .arg(&dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let origin = core.home.join("origin.git");
    git(&[
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        origin.to_str().unwrap(),
    ]);
    git(&["init", "-q", "-b", "main"]);
    git(&["commit", "-q", "--allow-empty", "-m", "base"]);
    git(&["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&["push", "-q", "-u", "origin", "main"]);
    git(&["checkout", "-q", "-b", "parser-fix"]);
    git(&["commit", "-q", "--allow-empty", "-m", "one"]);
    git(&["commit", "-q", "--allow-empty", "-m", "two"]);
    let head = git(&["rev-parse", "HEAD"]);
    let s = core.start();
    let r = core.window(json!({"op":"git_push","session":s.id}));
    assert_eq!(r["Err"], "push needs the confirmed head commit", "{r}");
    let r = core.window(json!({"op":"git_push","session":s.id,"head":head}));
    assert_eq!(
        r["Ok"],
        json!({"type":"git_pushed","pushed":2,"remote":"origin","branch":"parser-fix"}),
        "{r}"
    );
    assert_eq!(git(&["rev-parse", "origin/parser-fix"]), head);
}

/// A session folder on branch `fix-lexer` with `n` commits ahead of `origin/main`; origin's URL is a GitHub one for gh,
/// and pushes go to a local bare repository (`pushInsteadOf`), so nothing reaches the network.
fn pr_repo(core: &Core, n: usize) -> PathBuf {
    let dir = core.home.join("cwd");
    let origin = core.home.join("origin.git");
    let git = |args: &[&str]| pr_git(&dir, args);
    git(&[
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        origin.to_str().unwrap(),
    ]);
    git(&["init", "-q", "-b", "main"]);
    git(&["commit", "-q", "--allow-empty", "-m", "base"]);
    git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/develku/nunchiro.git",
    ]);
    git(&[
        "config",
        &format!("url.{}.pushInsteadOf", origin.display()),
        "https://github.com/develku/nunchiro.git",
    ]);
    git(&["push", "-q", "-u", "origin", "main"]);
    git(&["remote", "set-head", "origin", "main"]);
    git(&["checkout", "-q", "-b", "fix-lexer"]);
    for i in 0..n {
        git(&[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            &format!("Fix lexer step {i}"),
        ]);
    }
    dir
}
fn pr_git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = home::git_env::scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
/// A `gh` that answers `auth status` from `<home>/gh-auth` (an exit code), and for `pr create` logs its argv (one
/// `|`-joined line) to `gh-runs` and its stdin to `gh-stdin`, then prints `gh-out` and `gh-err` and exits `gh-code`.
fn gh_create_shim(core: &Core) {
    let h = core.home.display();
    for (f, v) in [
        ("gh-auth", "0"),
        ("gh-out", "https://github.com/develku/nunchiro/pull/58\n"),
        ("gh-err", ""),
        ("gh-code", "0"),
    ] {
        fs::write(core.home.join(f), v).unwrap();
    }
    let script = format!(
        "#!/bin/sh\nif [ \"$1 $2\" = 'auth status' ]; then exit $(/bin/cat '{h}/gh-auth'); fi\nprintf '%s|' \"$@\" >> '{h}/gh-runs'\nprintf '\\n' >> '{h}/gh-runs'\n/bin/cat > '{h}/gh-stdin'\n/bin/cat '{h}/gh-out'\n/bin/cat '{h}/gh-err' >&2\nexit $(/bin/cat '{h}/gh-code')\n"
    );
    install_gh(core, &script);
}

/// The Create PR form: the draft holds the commit subjects; Create pushes first, then gh gets the edited title as one
/// argument and the body on stdin byte for byte; the session's chip shows the new PR.
#[test]
fn pr_create_pushes_then_hands_gh_the_text_unchanged() {
    let core = Core::new();
    let dir = pr_repo(&core, 2);
    gh_create_shim(&core);
    let s = core.start();
    let r = core.window(json!({"op":"pr_draft","session":s.id}));
    let d = &r["Ok"]["draft"];
    assert_eq!(d["title"], "Fix lexer", "{r}");
    assert_eq!(d["body"], "- Fix lexer step 0\n- Fix lexer step 1", "{r}");
    assert_eq!(d["bases"], json!(["main"]), "{r}");
    assert_eq!(d["push"]["ahead"], 2, "{r}");
    assert!(d["gh_why"].is_null(), "{r}");
    let head = d["head"].as_str().unwrap().to_string();
    let title = "-x Fix $(rm -rf ~) `id` \"quoted\"";
    let body = "$(touch /tmp/pwned)\n`id`\n--admin\n- item\r\n\ttab ünïcode";
    let r = core.window(json!({"op":"pr_create","session":s.id,"head":head,"title":title,"body":body,"base":"main","draft":false}));
    assert_eq!(
        r["Ok"],
        json!({"type":"pr_created","url":"https://github.com/develku/nunchiro/pull/58","number":58,"pushed":2}),
        "{r}"
    );
    assert_eq!(
        fs::read_to_string(core.home.join("gh-runs")).unwrap(),
        format!(
            "pr|create|--repo=develku/nunchiro|--head=fix-lexer|--base=main|--title={title}|--body-file=-|\n"
        )
    );
    assert_eq!(
        fs::read(core.home.join("gh-stdin")).unwrap(),
        body.as_bytes()
    );
    assert_eq!(pr_git(&dir, &["rev-parse", "origin/fix-lexer"]), head);
    let chip = core.window(json!({"op":"pr_chip","id":s.id}));
    assert_eq!(
        chip["Ok"]["chip"]["url"], "https://github.com/develku/nunchiro/pull/58",
        "{chip}"
    );
    assert_eq!(chip["Ok"]["chip"]["state"], "open", "{chip}");
    // Pushed already: Create as draft runs gh alone, with --draft.
    fs::remove_file(core.home.join("gh-runs")).unwrap();
    let r = core.window(json!({"op":"pr_create","session":s.id,"head":head,"title":"T","body":"","base":"main","draft":true}));
    assert_eq!(r["Ok"]["pushed"], 0, "{r}");
    assert!(
        fs::read_to_string(core.home.join("gh-runs"))
            .unwrap()
            .ends_with("|--body-file=-|--draft|\n")
    );
}

#[test]
fn pr_create_refusals_say_what_happened() {
    let core = Core::new();
    let dir = pr_repo(&core, 1);
    gh_create_shim(&core);
    let s = core.start();
    let head = pr_git(&dir, &["rev-parse", "HEAD"]);
    let create = |title: &str| {
        core.window(json!({"op":"pr_create","session":s.id,"head":head,"title":title,"body":"b","base":"main"}))
    };
    // A title over two lines, or empty: nothing runs, nothing is pushed.
    for bad in ["two\nlines", "", "   "] {
        let r = create(bad);
        assert!(
            r["Err"]
                .as_str()
                .unwrap()
                .starts_with("no pull request: the title"),
            "{r}"
        );
    }
    assert!(!core.home.join("gh-runs").exists());
    assert!(pr_git(&dir, &["for-each-ref", "refs/remotes/origin/fix-lexer"]).is_empty());
    // gh signed out: the push happened, the sentence says so.
    fs::write(core.home.join("gh-code"), "4").unwrap();
    fs::write(core.home.join("gh-out"), "").unwrap();
    let r = create("Fix lexer");
    let e = r["Err"].as_str().unwrap();
    assert!(
        e.starts_with("pushed, but the pull request was not created: gh is not logged in"),
        "{r}"
    );
    assert_eq!(pr_git(&dir, &["rev-parse", "origin/fix-lexer"]), head);
    // A PR for the branch exists: its number, no second create.
    fs::write(core.home.join("gh-code"), "1").unwrap();
    fs::write(
        core.home.join("gh-err"),
        "a pull request for branch \"fix-lexer\" into branch \"main\" already exists:\nhttps://github.com/develku/nunchiro/pull/57\n",
    )
    .unwrap();
    let r = create("Fix lexer");
    assert_eq!(
        r["Err"],
        "a pull request for this branch already exists: #57 https://github.com/develku/nunchiro/pull/57",
        "{r}"
    );
    // The default branch is refused by the core, the draft too.
    pr_git(&dir, &["checkout", "-q", "main"]);
    let main = pr_git(&dir, &["rev-parse", "HEAD"]);
    let r = core.window(
        json!({"op":"pr_create","session":s.id,"head":main,"title":"T","body":"","base":"main"}),
    );
    assert_eq!(r["Err"], "not pushed: this is the default branch", "{r}");
    let r = core.window(json!({"op":"pr_draft","session":s.id}));
    assert_eq!(r["Err"], "not pushed: this is the default branch", "{r}");
}

/// "Agent made" opens Merge for that PR, so only a real `gh pr create` run that prints one PR link on its own line counts.
#[test]
fn created_needs_a_real_gh_run_and_its_own_link_line() {
    let ran = |cmd: &str, out: String| {
        pr::created(&[
            json!({"kind":"tool_use","tool_id":"c","name":"Bash","input":{"command":cmd}}),
            json!({"kind":"tool_result","tool_id":"c","output":out,"is_error":false}),
        ])
    };
    for cmd in [
        "echo done # gh pr create",
        "echo gh pr create",
        "echo 'x; gh pr create --fill'",
        "echo \"x && gh pr create --fill\"",
        "gh pr create\u{a0}--help; echo",
    ] {
        assert!(ran(cmd, format!("{A12}\n")).is_empty(), "{cmd}");
    }
    assert!(ran("gh\rpr\rcreate; echo", format!("{A12}\n")).is_empty());
    // A heredoc body is text: it runs no gh, and its apostrophe hides nothing after it.
    assert!(
        ran(
            "cat <<EOF\ngh pr create\nEOF\necho",
            format!("gh pr create\n{A12}\n")
        )
        .is_empty()
    );
    assert_eq!(
        ran(
            "cat > b.md <<'EOF'\nit's done\nEOF\ngh pr create --body-file b.md",
            format!("{A12}\n")
        ),
        vec![A12.to_string()]
    );
    // Two different link lines: neither is known to be gh's.
    assert!(
        ran(
            "git log -3 && gh pr create --fill",
            format!("    {A13}\n{A12}\n")
        )
        .is_empty()
    );
    // More commands after the create: gh's own line still counts.
    assert_eq!(
        ran(
            "gh pr create --fill && gh pr view --json state",
            format!("{A12}\n{{\"state\":\"OPEN\"}}\n")
        ),
        vec![A12.to_string()]
    );
    assert!(ran("gh pr create --fill", format!("see {A12}\n")).is_empty());
    // A Codex array is a script only under a shell: echo's "-c" argument is text.
    let array = |argv: Value, out: &str| {
        pr::created(&[
            json!({"kind":"tool_use","tool_id":"c","name":"shell","input":{"command":argv}}),
            json!({"kind":"tool_result","tool_id":"c","output":out,"is_error":false}),
        ])
    };
    assert!(array(json!(["echo", "-c", "gh pr create"]), A12).is_empty());
    let wrapped = json!({"output": format!("{A12}\n"), "metadata": {"exit_code": 0}}).to_string();
    assert_eq!(
        array(json!(["/bin/zsh", "-lc", "gh pr create --fill"]), &wrapped),
        vec![A12.to_string()]
    );
    for cmd in [
        "git push -u origin b && gh pr create --fill",
        "GH_PROMPT_DISABLED=1 gh pr create --fill",
        "cd repo\ngh pr create --title \"a; b\" --body 'gh pr view # x'",
        "if true; then gh pr create --fill; fi",
    ] {
        assert_eq!(
            ran(
                cmd,
                format!("remote: pushed\n{A12}\nShell cwd was reset to /x/proj\n")
            ),
            vec![A12.to_string()],
            "{cmd}"
        );
    }
}

/// Ticket 373: a repository whose branch `fix-login` tracks `origin/fix-login` on github.com/develku/nunchiro, with
/// `origin/HEAD` at `main`; returns the folder, checked out on `fix-login`.
fn branch_repo(core: &Core) -> PathBuf {
    let dir = core.home.join("wt");
    fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let out = home::git_env::scrubbed("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
    ]);
    git(&[
        "remote",
        "add",
        "origin",
        "git@github.com:develku/nunchiro.git",
    ]);
    git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    git(&["checkout", "-q", "-b", "fix-login"]);
    git(&["config", "branch.fix-login.remote", "origin"]);
    git(&["config", "branch.fix-login.merge", "refs/heads/fix-login"]);
    git(&["config", "branch.main.remote", "origin"]);
    git(&["config", "branch.main.merge", "refs/heads/main"]);
    dir
}

/// Ticket 373: a `gh` that logs its folder and argv, answers the by-branch lookup from `<home>/gh-branch` and any other
/// `pr view` from `<home>/gh-view`.
fn gh_branch_shim(core: &Core, head_owner: &str) {
    let h = core.home.display();
    let pr = json!({"number":12,"url":A12,"state":"OPEN","isDraft":false,"reviewDecision":"REVIEW_REQUIRED",
        "headRefName":"fix-login","headOwner":head_owner,"headRepo":"nunchiro",
        "checks":[{"status":"COMPLETED","conclusion":"FAILURE","state":"","name":"build","url":"https://github.com/develku/nunchiro/actions/runs/1/job/2"},
            {"status":"","conclusion":"","state":"ERROR","name":"lint","url":"javascript:alert(1)"},
            {"status":"COMPLETED","conclusion":"SUCCESS","state":"","name":"docs","url":"https://example.com/docs"}]});
    fs::write(core.home.join("gh-branch"), pr.to_string()).unwrap();
    gh_shim(core);
    let script = format!(
        "#!/bin/sh\nprintf '%s|' \"$PWD\" \"$@\" >> '{h}/gh-runs'\nprintf '\\n' >> '{h}/gh-runs'\ncase \"$*\" in\n  *headRepositoryOwner*) /bin/cat '{h}/gh-branch' ;;\n  *' view '*) /bin/cat '{h}/gh-view' ;;\n  *' diff '*) printf '' ;;\nesac\n"
    );
    install_gh(core, &script);
}

#[test]
fn pr_branch_window_only_and_off_by_default() {
    let core = Core::new();
    let dir = branch_repo(&core);
    gh_branch_shim(&core, "develku");
    let op = json!({"op":"pr_branch","path":dir});
    // Off: refused, and gh never runs.
    let r = core.window(op.clone());
    assert!(r["Err"].as_str().unwrap().starts_with("off:"), "{r}");
    core.window(json!({"op":"pr_live_set","on":true}));
    // A session token is refused.
    let token = core.session_token();
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":op})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    // The owner socket answers only through the window dispatch; never forwarded.
    let req: Request = serde_json::from_value(op.clone()).unwrap();
    assert!(call(&core.home, req.clone()).is_err());
    let fwd = call(
        &core.home,
        Request::Remote {
            machine: "nowhere".into(),
            request: Box::new(req),
        },
    );
    assert!(fwd.unwrap_err().contains("local owner-only"));
    assert!(gh_runs(&core).is_empty(), "{:?}", gh_runs(&core));
}

#[test]
fn pr_branch_shows_outside_pr_with_failing_checks() {
    let core = Core::new();
    let dir = branch_repo(&core);
    gh_branch_shim(&core, "develku");
    core.window(json!({"op":"pr_live_set","on":true}));
    // No agent made it, so the PR view refuses it until the branch lookup finds it.
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    let r = core.window(json!({"op":"pr_branch","path":dir}));
    let pr = &r["Ok"]["pr"];
    assert_eq!(pr["url"], A12, "{r}");
    assert_eq!(pr["number"], 12);
    assert_eq!(pr["state"], "checks_fail");
    // Failing checks only, by name; a link that is not https is dropped.
    assert_eq!(
        pr["failed"],
        json!([{"name":"build","url":"https://github.com/develku/nunchiro/actions/runs/1/job/2"},{"name":"lint","url":""}])
    );
    // gh ran in the worktree folder, asking for the pushed branch after `--`.
    let runs = gh_runs(&core);
    assert_eq!(runs.len(), 1, "{runs:?}");
    let folder = fs::canonicalize(&dir).unwrap();
    assert!(
        runs[0].starts_with(&format!("{}|pr|view|--json|", folder.display())),
        "{runs:?}"
    );
    assert!(runs[0].ends_with("|--|fix-login|"), "{runs:?}");
    // The list asks every 30 s: a second ask inside the cache window runs no gh.
    let again = core.window(json!({"op":"pr_branch","path":dir}));
    assert_eq!(again["Ok"]["pr"], *pr);
    assert_eq!(gh_runs(&core).len(), 1);
    // Found, so shown: the PR view opens it, but offers no merge, and the merge op refuses it before any gh run.
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert_eq!(r["Ok"]["view"]["number"], 12, "{r}");
    assert_eq!(r["Ok"]["view"]["merge"], false, "{r}");
    let n = gh_runs(&core).len();
    let r = core.window(json!({"op":"pr_merge","url":A12,"method":"squash","head":HEAD}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    assert_eq!(gh_runs(&core).len(), n, "{:?}", gh_runs(&core));
    assert!(!gh_runs(&core).iter().any(|l| l.contains("|merge|")));
}

#[test]
fn pr_branch_ignores_a_fork_pr_and_the_default_branch() {
    let core = Core::new();
    let dir = branch_repo(&core);
    // A fork's PR from a branch of the same name: not this worktree's.
    gh_branch_shim(&core, "someone-else");
    core.window(json!({"op":"pr_live_set","on":true}));
    let r = core.window(json!({"op":"pr_branch","path":dir}));
    assert_eq!(r["Ok"]["pr"], Value::Null, "{r}");
    assert_eq!(gh_runs(&core).len(), 1);
    // Not found is an answer and stays unknown to the PR view.
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert!(
        r["Err"].as_str().unwrap().contains("not a repository"),
        "{r}"
    );
    // The default branch is never looked up.
    let out = home::git_env::scrubbed("git")
        .arg("-C")
        .arg(&dir)
        .args(["checkout", "-q", "main"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let r = core.window(json!({"op":"pr_branch","path":dir}));
    assert_eq!(r["Ok"]["pr"], Value::Null, "{r}");
    assert_eq!(gh_runs(&core).len(), 1, "{:?}", gh_runs(&core));
}

/// The agent creates A12, then `filler` 100 KiB messages (about 20 fill a 2 MiB chat page), then views A12: the chip.
fn create_then_view(filler: usize) -> String {
    let text = "x".repeat(100 << 10);
    let filler: String = (0..filler)
        .map(|_| format!("{}\n", json!({"type":"assistant","timestamp":"2026-10-27T10:01:00.000Z","message":{"content":[{"type":"text","text":text}]}})))
        .collect();
    let view = json!({"type":"assistant","timestamp":"2026-10-27T10:02:00.000Z","message":{"content":[{"type":"tool_use","id":"u2","name":"Bash","input":{"command":"gh pr view 12"}}]}});
    let seen = json!({"type":"user","timestamp":"2026-10-27T10:02:01.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"u2","content":format!("state:\tOPEN\nurl:\t{A12}\n")}]}});
    format!("{}{filler}{view}\n{seen}\n", pr_transcript("gh pr create"))
}
/// The session's chat pages, newest first, counted.
fn chat_pages(core: &Core, s: &Session) -> usize {
    let mut page = core.window(json!({"op":"chat_page","id":s.id}));
    let mut pages = 1;
    while let Some(before) = page["Ok"]["page"]["before"].as_u64() {
        page = core.window(json!({"op":"chat_page","id":s.id,"before":before}));
        pages += 1;
    }
    pages
}

// Ticket 419: the agent's create sits on an older chat page (pages hold 2 MiB) than the chip's view; it still merges.
#[test]
fn created_on_an_older_page_still_offers_merge() {
    let core = Core::new();
    gh_shim(&core);
    core.window(json!({"op":"pr_live_set","on":true}));
    let s1 = core.start();
    core.transcript(&s1, &create_then_view(25));
    assert!(
        chat_pages(&core, &s1) >= 2,
        "the create is on an older page"
    );
    let chip = core.window(json!({"op":"pr_chip","id":s1.id}));
    assert_eq!(chip["Ok"]["chip"]["url"], A12, "{chip}");
    assert_eq!(
        chip["Ok"]["chip"]["at"], "2026-10-27T10:02:01.000Z",
        "{chip}"
    );
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert_eq!(r["Ok"]["view"]["merge"], true, "{r}");
}

// Round 3: past the chip's page the read stops after 4 more pages, so a create further back is never reached.
#[test]
fn created_past_the_page_cap_is_not_read() {
    let core = Core::new();
    gh_shim(&core);
    core.window(json!({"op":"pr_live_set","on":true}));
    let s1 = core.start();
    core.transcript(&s1, &create_then_view(140));
    let pages = chat_pages(&core, &s1);
    assert!(pages >= 7, "the create is 6 or more pages back: {pages}");
    let chip = core.window(json!({"op":"pr_chip","id":s1.id}));
    assert_eq!(chip["Ok"]["chip"]["url"], A12, "{chip}");
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert!(
        r["Err"]
            .as_str()
            .unwrap_or_default()
            .contains("not a repository"),
        "{r}"
    );
}

/// Ticket 373 round 2: merge is per PR. A pinned PR in the same repository (another number) does not make the PR found
/// by branch mergeable; the pinned one keeps its merge.
#[test]
fn pr_branch_found_pr_is_not_merged_beside_a_pinned_one() {
    let core = Core::new();
    let dir = branch_repo(&core);
    gh_branch_shim(&core, "develku");
    core.window(json!({"op":"pr_live_set","on":true}));
    core.window(json!({"op":"pr_watch","url":A13,"on":true}));
    let r = core.window(json!({"op":"pr_branch","path":dir}));
    assert_eq!(r["Ok"]["pr"]["url"], A12, "{r}");
    // The found PR: shown, no merge, and the merge op refuses it before any gh run.
    let r = core.window(json!({"op":"pr_view","url":A12}));
    assert_eq!(r["Ok"]["view"]["number"], 12, "{r}");
    assert_eq!(r["Ok"]["view"]["merge"], false, "{r}");
    let n = gh_runs(&core).len();
    let r = core.window(json!({"op":"pr_merge","url":A12,"method":"squash","head":HEAD}));
    assert!(r["Err"].is_string(), "{r}");
    assert_eq!(gh_runs(&core).len(), n, "{:?}", gh_runs(&core));
    // The pinned PR in the same repository still offers merge.
    let view: Value =
        serde_json::from_slice(&fs::read(core.home.join("gh-view")).unwrap()).unwrap();
    let mut pinned = view.clone();
    pinned["number"] = json!(13);
    pinned["url"] = json!(A13);
    fs::write(core.home.join("gh-view"), pinned.to_string()).unwrap();
    let r = core.window(json!({"op":"pr_view","url":A13}));
    assert_eq!(r["Ok"]["view"]["merge"], true, "{r}");
    assert!(!gh_runs(&core).iter().any(|l| l.contains("|merge|")));
}
