//! Bot memory, layer 3, through a real `serve` and the real CLI: a seat searches past conversations; a hit from a
//! conversation that read outside content marks the reader; turning search off deletes the index and refuses a search.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn start(home: &Path) -> Session {
    match call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: home.join("cwd"),
                worktree: false,
                label: "Acme invoices".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        r => panic!("{r:?}"),
    }
}
fn token_of(home: &Path, id: &str) -> String {
    let mut token = String::new();
    wait("the session printed no token", || {
        let out = match call(
            home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
            _ => String::new(),
        };
        out.split("TOKEN=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .filter(|t| !t.is_empty())
            .map(|t| token = t.to_string())
            .is_some()
    });
    token
}
/// The session's transcript holding `lines`, told to the core as Claude's SessionStart hook tells it.
fn transcript(home: &Path, s: &Session, lines: &[Value]) {
    let encoded: String = s
        .cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = home.join("claude-home/projects").join(encoded);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
    let body: String = lines.iter().map(|l| l.to_string() + "\n").collect();
    fs::write(&path, body).unwrap();
    call(
        home,
        Request::Hook {
            id: s.id.clone(),
            event: "SessionStart".into(),
            payload: json!({"session_id":s.agent_session_id,"transcript_path":path}),
        },
    )
    .unwrap();
}
fn search(home: &Path, token: &str, words: &str) -> (bool, String) {
    let out = Command::new(home::cli::path())
        .args(["memory", "search", words, "--json"])
        .env("NUNCHIRO_HOME", home)
        .env("NUNCHIRO_TOKEN", token)
        .output()
        .unwrap();
    (
        out.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    )
}
fn marked(home: &Path, id: &str) -> bool {
    nunchiro_core::team::outside(home, &[id.to_string()]).is_some()
}

#[test]
fn a_marked_hit_marks_the_reader_and_off_deletes_the_index() {
    let home = home::short("memsrch");
    fs::create_dir_all(home.join("bin")).unwrap();
    fs::create_dir_all(home.join("cwd")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    let _core = home::spawn_serve(
        &home,
        &[
            ("PATH", path.as_str()),
            (
                "CLAUDE_CONFIG_DIR",
                &home.join("claude-home").to_string_lossy(),
            ),
        ],
    );
    let (mail, reader, other) = (start(&home), start(&home), start(&home));
    transcript(
        &home,
        &mail,
        &[
            json!({"type":"user","timestamp":"2026-11-12T14:00:00Z",
                "message":{"role":"user","content":"What did we settle for the Acme invoice format?"}}),
            json!({"type":"assistant","timestamp":"2026-11-12T14:05:00Z",
                "message":{"role":"assistant","content":[{"type":"text",
                    "text":"PDF, PO number in the file name. ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}]}}),
        ],
    );
    let token = token_of(&home, &reader.id);

    // An unmarked conversation's hit leaves the reader unmarked; the secret never leaves the index.
    let (ok, said) = search(&home, &token, "po number");
    assert!(ok, "{said}");
    let reply: Value = serde_json::from_str(said.trim()).unwrap();
    assert_eq!(reply["hits"][0]["session"], mail.id.as_str(), "{said}");
    assert!(
        !said.contains("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"),
        "{said}"
    );
    assert!(!marked(&home, &reader.id));
    assert!(home.join("memory-search/index.json").is_file());

    // The conversation reads a mail; a seat that finds its words through search is marked as if it read them.
    call(
        &home,
        Request::Hook {
            id: mail.id.clone(),
            event: "PreToolUse".into(),
            payload: json!({"tool_name":"mcp__claude_ai_Gmail__get_thread","tool_input":{"threadId":"t1"}}),
        },
    )
    .unwrap();
    let (ok, said) = search(&home, &token, "nothing holds this");
    assert!(ok && said.contains("\"total\":0"), "{said}");
    assert!(!marked(&home, &reader.id), "no hit, no mark");
    let (ok, said) = search(&home, &token, "acme");
    assert!(ok, "{said}");
    assert!(marked(&home, &reader.id), "a marked hit marks the reader");
    assert!(!marked(&home, &other.id));

    // Off: the index goes once stored, and a search is refused.
    match call(
        &home,
        Request::QuitSettings {
            patch: LifetimePatch {
                features: Some(
                    [(
                        "team.memory".to_string(),
                        json!({"keep_days":30,"search":false}),
                    )]
                    .into(),
                ),
                ..Default::default()
            },
        },
    ) {
        Ok(Reply::QuitSettings { .. }) => {}
        other => panic!("{other:?}"),
    }
    assert!(!home.join("memory-search").exists());
    let (ok, said) = search(&home, &token_of(&home, &other.id), "acme");
    assert!(
        !ok && said.contains("search past conversations is off"),
        "{said}"
    );
    assert!(!home.join("memory-search").exists());
    let _ = fs::remove_dir_all(&home);
}
