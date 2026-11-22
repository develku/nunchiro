//! Observer diagnostics through a real core process, without agent processes or user config.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::api::*;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("board-log");
        let snapshot: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/board/snapshot-v1a.json")).unwrap();
        fs::write(
            home.join("sessions.json"),
            serde_json::json!({"version":1,"sessions":snapshot["Ok"]["sessions"]}).to_string(),
        )
        .unwrap();
        // Run the linked core in this test binary so the core-only check needs no prebuilt CLI.
        let process = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "board_observation_logs_each_error_once_and_recovers_once",
                "--nocapture",
            ])
            .env("NUNCHIRO_BOARD_LOG_FIXTURE", "1")
            .env("NUNCHIRO_HOME", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("stderr.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        core.wait_for(|| {
            core.home.join("window.json").exists() && core.home.join("core.sock").exists()
        });
        core
    }
    fn request(&self, request: Request) -> Response {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut stream = UnixStream::connect(self.home.join("core.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = serde_json::to_vec(&Envelope { token, request }).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn log(&self) -> String {
        fs::read_to_string(self.home.join("stderr.log")).unwrap()
    }
    fn install(&self, bytes: &[u8]) {
        let next = self.home.join("next.json");
        fs::write(&next, bytes).unwrap();
        fs::rename(next, self.home.join("board.json")).unwrap();
    }
    fn wait_for(&self, condition: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(30);
        while !condition() {
            assert!(
                Instant::now() < until,
                "condition not reached; stderr: {}",
                self.log()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn poll_legacy(&self) {
        for _ in 0..20 {
            assert!(matches!(
                self.request(Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            ));
        }
        thread::sleep(Duration::from_millis(120));
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        if self.process.try_wait().unwrap().is_none() {
            let _ = self.request(Request::Stop);
        }
        let until = Instant::now() + Duration::from_secs(3);
        while self.process.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
        fs::remove_dir_all(&self.home).unwrap();
    }
}

#[test]
fn board_observation_logs_each_error_once_and_recovers_once() {
    if std::env::var_os("NUNCHIRO_BOARD_LOG_FIXTURE").is_some() {
        nunchiro_core::server::serve_recording(&PathBuf::from(
            std::env::var_os("NUNCHIRO_HOME").unwrap(),
        ))
        .unwrap();
        return;
    }
    let core = Core::new();
    let path = core.home.join("board.json");
    core.install(b"[]");
    core.wait_for(|| core.log().contains("board observation:"));
    core.poll_legacy();
    let first = core.log();
    assert_eq!(
        first
            .lines()
            .filter(|l| l.starts_with("board observation:"))
            .count(),
        1
    );
    assert_eq!(fs::read(&path).unwrap(), b"[]");
    core.install(b"{broken");
    core.wait_for(|| {
        core.log()
            .lines()
            .filter(|l| l.starts_with("board observation:"))
            .count()
            >= 2
    });
    core.poll_legacy();
    let errors = core.log();
    assert_eq!(
        errors
            .lines()
            .filter(|l| l.starts_with("board observation:"))
            .count(),
        2
    );
    fs::remove_file(&path).unwrap();
    core.wait_for(|| core.log().contains("board observation recovered"));
    core.poll_legacy();
    assert_eq!(core.log().matches("board observation recovered").count(), 1);
    assert!(
        !path.exists(),
        "observation without board data must stay a no-op"
    );
}

#[test]
fn board_stale_completion_markers_recover_once_without_losing_manual_cards() {
    use serde_json::{Value, json};
    let core = Core::new();
    core.request(Request::BoardPut {
        id: None,
        title: "Keep".into(),
        note: "Evidence".into(),
        session_id: Some("s".into()),
        column: Some("review".into()),
    })
    .unwrap();
    core.request(Request::BoardMove {
        source: nunchiro_core::board::Source::Session,
        id: "s".into(),
        column: "review".into(),
    })
    .unwrap();
    let path = core.home.join("board.json");
    let good: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut seen = good.clone();
    seen["seen"] = json!({"s":999});
    let mut held = good.clone();
    held["held"]["s"]["completion_seq"] = json!(999);
    let mut seen_only = seen.clone();
    seen_only["held"] = json!({});
    for (index, mut stale) in [seen, held, seen_only].into_iter().enumerate() {
        stale["future"] = json!({"keep":true});
        core.install(&serde_json::to_vec(&stale).unwrap());
        core.wait_for(|| {
            core.log()
                .matches("board: stale completion markers reset")
                .count()
                == index + 1
        });
        core.poll_legacy();
        let Reply::BoardSnapshot { board } = core.request(Request::BoardSnapshot).unwrap() else {
            panic!()
        };
        let session = board
            .cards
            .iter()
            .find(|c| c["source"] == "session")
            .unwrap();
        assert_eq!(
            session["column"], "done",
            "stale markers must release the held column"
        );
        let repaired: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(repaired["seen"]["s"].is_null());
        assert!(repaired["held"]["s"].is_null());
        assert_eq!(repaired["manual"], good["manual"]);
        assert_eq!(repaired["columns"], good["columns"]);
        assert_eq!(repaired["future"], json!({"keep":true}));
        assert_eq!(
            core.log()
                .matches("board: stale completion markers reset")
                .count(),
            index + 1
        );
    }
    assert!(
        !core.log().contains("board observation:"),
        "stale stamps must not be treated as store errors"
    );
}
