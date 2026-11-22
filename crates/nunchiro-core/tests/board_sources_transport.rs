//! Source approval uses the existing owner transports and the existing view shape.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
struct Core {
    home: PathBuf,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}
impl Core {
    fn new() -> Self {
        let home = home::short("source-wire");
        let path = home.clone();
        let task = thread::spawn(move || server::serve_recording(&path));
        let start = Instant::now();
        while !home.join("core.sock").exists() {
            assert!(start.elapsed() < Duration::from_secs(30));
            thread::sleep(Duration::from_millis(10));
        }
        Self {
            home,
            task: Some(task),
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = server::call(&self.home, Request::Stop);
        if let Some(t) = self.task.take() {
            t.join().unwrap().unwrap();
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}
#[test]
fn board_sources_owner_api_and_equivalent_source_approval_command() {
    let core = Core::new();
    let d = core.home.join("sources/demo");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/usr/bin/true']\n",
    )
    .unwrap();
    let view = match server::call(
        &core.home,
        Request::BoardSourceStatus {
            name: "demo".into(),
        },
    )
    .unwrap()
    {
        Reply::ApprovalStatus { view } => view,
        _ => panic!("wrong reply"),
    };
    assert_eq!(view.state, nunchiro_core::approval::State::Unapproved);
    let out = std::process::Command::new("/bin/sh")
        .args(["-c", &view.cli])
        .env("NUNCHIRO_HOME", &core.home)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: Response = serde_json::from_slice(&out.stdout).unwrap();
    assert!(reply.is_ok(), "{reply:?}");
    assert!(nunchiro_core::approval::check_source(&core.home, "demo").is_ok());
    assert!(nunchiro_core::approval::check(&core.home, "demo").is_err());
    fs::write(d.join("new-file"), "changed").unwrap();
    assert!(
        server::call(
            &core.home,
            Request::BoardSourceGrant {
                name: "demo".into(),
                level: nunchiro_core::approval::Level::Read,
                hash: view.hash
            }
        )
        .is_err()
    );
}
