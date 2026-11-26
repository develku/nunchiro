use nunchiro_core::{
    api::*,
    chat::{Cache, TESTED_VERSIONS},
};
use serde_json::json;
use std::{fs, io::Write, path::PathBuf, time::Instant};

// Release-mode 113 MB indexing/poll/RSS probe: `cargo test --release -p nunchiro-core --features measure --test chat_performance -- --nocapture`.
#[test]
fn chat_release_100mb_poll_and_memory_budget() {
    if std::env::var_os("CHAT_PERF_CHILD").is_none() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("r2-perf-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "chat_release_100mb_poll_and_memory_budget",
                "--nocapture",
            ])
            .env("CHAT_PERF_CHILD", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
            .status()
            .unwrap();
        assert!(status.success());
        fs::remove_dir_all(home).unwrap();
        return;
    }
    if cfg!(debug_assertions) {
        panic!("run this probe in release mode");
    }
    let home = PathBuf::from(std::env::var_os("CHAT_PERF_CHILD").unwrap());
    let encoded = home
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let dir = home.join("agent/projects").join(encoded);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("benchmark-1.jsonl");
    let mut f = fs::File::create(&path).unwrap();
    let line = json!({"type":"user","message":{"content":"x".repeat(900)}}).to_string() + "\n";
    for _ in 0..120000 {
        f.write_all(line.as_bytes()).unwrap();
    }
    drop(f);
    let session = Session {
        side_chat: false,
        stopped_sends: Vec::new(),
        send_waits: Default::default(),
        side_parent: None,
        teammate: None,
        resumed_from: vec![],
        owned_from: vec![],
        level: None,
        side_split: None,
        machine: None, // v1a-06: existing fixture is local.
        id: "session-1".into(),
        kind: AgentKind::Claude,
        project: home.clone(),
        cwd: home.clone(),
        label: String::new(),
        auto_label: false,
        closed_by_command: false,
        state: SessionState::Running,
        agent_session_id: Some("benchmark-1".into()),
        agent_version: Some(TESTED_VERSIONS[0].1.into()),
        untested: false,
        pid: Some(1),
        completion_seq: 0,
        attention: Box::default(),
        pending: vec![],
        send_log: vec![],
        send_queue: vec![],
        model: None,
        effort: None,
        start_commit: None,
        artifacts: None,     // v1b-07
        blocked: None,       // v1a-33
        holder_status: None, // V2-1b
        config_dir: None,    // V2-2b
        account: None,       // V2-2b
        conversation: None,  // V2-3b
        acp_agent: None,     // V2-4a
        problem: None,       // V2-5b
        without_hooks: false,
        no_history: false,
        account_tab: false,
        home_lock: false,
        home_mode: None,
        permission_mode: None,
        starting: false,
        at_box: false,
        ran_mode: None,
        mode_state: None, // CHAT-MODELIST
        parent: None,
        schedule: None,
        token_origin: None,
        closed_at: None,
        ended_at: None,
        started_at: None,
        agent_ended: false,
        limit: None,
        folder_gone: false,
        ended_ask: None,
        modes: None,
    };
    // Public service seam used by both transports; synthetic source bypasses only discovery.
    let mut cache = Cache::new(&home);
    let start = Instant::now();
    let page = cache
        .plan_source(&session, Some(path.clone()), None, None)
        .unwrap()
        .read()
        .unwrap();
    let indexed_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(page.events.len(), 200);
    let mut polls = vec![];
    for _ in 0..100 {
        let start = Instant::now();
        let p = cache
            .plan_source(&session, Some(path.clone()), None, Some(page.end))
            .unwrap()
            .read()
            .unwrap();
        assert!(p.events.is_empty());
        polls.push(start.elapsed().as_secs_f64() * 1000.);
    }
    polls.sort_by(f64::total_cmp);
    let p95 = polls[94];
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let peak = unsafe { usage.assume_init() }.ru_maxrss as u64;
    let rss = if cfg!(target_os = "macos") {
        peak
    } else {
        peak * 1024
    };
    println!(
        "{}",
        json!({"transcript_bytes":fs::metadata(&path).unwrap().len(),"first_index_ms":indexed_ms,"poll_p95_ms":p95,"poll_max_ms":polls[99],"peak_rss_bytes":rss})
    );
    assert!(p95 < 5., "100 MB warm poll p95 {p95}ms exceeds 5ms");
    assert!(
        rss < 128 * 1024 * 1024,
        "synthetic core probe RSS exceeds 128 MiB: {rss}"
    );
}
