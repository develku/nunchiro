// v1a-19: the waiting observer against a real core while a session floods its terminal.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new(name: &str) -> Self {
        let home = home::short(&format!("ol-{name}"));
        // A bounded 4 MiB burst, then a permission dialog, then idle until the stop file or 30 s.
        fs::write(
            home.join("claude"),
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n\
             cat burst.txt\nprintf '\\033[2J\\033[HDo you want to proceed?\\r\\n1. Yes\\r\\n2. No\\r\\n'\n\
             i=0; while [ ! -f stop ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done\n",
        )
        .unwrap();
        fs::write(home.join("burst.txt"), "y\n".repeat(2 * 1024 * 1024)).unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            home.join("settings.json"),
            serde_json::json!({"disable_hook_injection":false}).to_string(),
        )
        .unwrap();
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CODEX_HOME", home.join("codex-home"))
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(core.snapshot(), Ok(Reply::Snapshot { .. })) {
            assert!(Instant::now() < until, "core protocol did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn snapshot(&self) -> Response {
        call(&self.home, Request::Snapshot)
    }
    fn start(&self) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Claude,
                    project: self.home.clone(),
                    worktree: false,
                    label: "flood".into(),
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
            other => panic!("{other:?}"),
        }
    }
}
impl Drop for Core {
    // Stops the firehose session too when a test panics.
    fn drop(&mut self) {
        let _ = fs::write(self.home.join("stop"), "");
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn a_dialog_in_a_firehose_is_still_detected_after_the_backlog_drains() {
    let core = Core::new("dialog");
    let session = core.start();
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let Ok(Reply::Snapshot { sessions, .. }) = core.snapshot() else {
            panic!("snapshot failed")
        };
        let s = sessions.iter().find(|s| s.id == session.id).unwrap();
        if let Some(item) = s.pending.first() {
            assert!(item.sources.contains("screen"), "{item:?}");
            assert!(item.text.contains("Do you want to proceed?"), "{item:?}");
            break;
        }
        assert!(
            Instant::now() < until,
            "the dialog after the burst never reached the queue"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

// The before/after figure for the report (not a gate): the slowest snapshot while the burst drains.
// Run: cargo test -j 2 -p nunchiro-core --features measure --test observe_lock measure_ -- --nocapture
#[cfg(feature = "measure")]
#[test]
fn measure_snapshot_latency_during_a_bounded_firehose() {
    let core = Core::new("measure");
    let session = core.start();
    let (mut worst, mut count) = (Duration::ZERO, 0);
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let at = Instant::now();
        let Ok(Reply::Snapshot { sessions, .. }) = core.snapshot() else {
            panic!("snapshot failed")
        };
        worst = worst.max(at.elapsed());
        count += 1;
        let s = sessions.iter().find(|s| s.id == session.id).unwrap();
        if !s.pending.is_empty() || Instant::now() > until {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    println!("[v1a-19] snapshots={count} worst={worst:?}");
}
