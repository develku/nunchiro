//! Ticket 841: a core that a test runs in its own process records `open` instead of launching a real app, and no
//! test file starts one with plain `server::serve` (the first core in a process decides for all of them).
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server, tree::TreeEdit};
use std::{
    fs, thread,
    time::{Duration, Instant},
};

#[test]
fn an_in_process_core_records_open() {
    let home = home::short("op-rec");
    let project = home.join("project");
    fs::create_dir(&project).unwrap();
    let path = home.clone();
    let task = thread::spawn(move || server::serve_recording(&path));
    let until = Instant::now() + Duration::from_secs(30);
    while !matches!(
        server::call(&home, Request::Snapshot),
        Ok(Reply::Snapshot { .. })
    ) {
        assert!(Instant::now() < until, "core did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
    let project_text = project.to_string_lossy().into_owned();
    let edit = TreeEdit::Add {
        project: project_text.clone(),
        added: true,
    };
    server::call(&home, Request::TreeEdit { edit }).unwrap();
    let opened = server::call(
        &home,
        Request::OpenInEditor {
            path: project.clone(),
            line: None,
        },
    );
    server::call(&home, Request::Stop).unwrap();
    task.join().unwrap().unwrap();
    assert!(matches!(opened, Ok(Reply::Ack)), "{opened:?}");
    assert_eq!(
        fs::read_to_string(home.join("opened.argv")).unwrap(),
        format!("open\n-t\n{project_text}\n")
    );
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn no_test_starts_a_core_with_plain_serve() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut plain = Vec::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            let text = fs::read_to_string(&path).unwrap();
            if text.contains(concat!("server::serve", "(")) {
                plain.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
    }
    assert!(
        plain.is_empty(),
        "use server::serve_recording in tests: {plain:?}"
    );
}
