//! v1a-66: `core.sock` must fit macOS `sun_path` (103 usable bytes).
use nunchiro_core::server;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    thread,
    time::{Duration, Instant},
};
#[path = "fixtures/home.rs"]
mod home;

#[test]
fn short_test_home_helper() {
    // The longest tag a test passes today, a nested `h/` home as files_api uses, and the largest macOS pid (5 digits).
    let home = home::short("logs-startup-target");
    let sock = home.join("h/core.sock");
    let worst = sock.as_os_str().len() + 5 - std::process::id().to_string().len();
    assert!(worst <= 103, "{worst} bytes: {}", sock.display());
    assert!(!home.starts_with(env!("CARGO_MANIFEST_DIR")));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn serve_refuses_long_socket_path() {
    let base = home::short("long");
    let fill = |total: usize| {
        // `<base>/<x...>/core.sock` is exactly `total` bytes.
        let pad = total - base.as_os_str().len() - "/".len() - "/core.sock".len();
        base.join("x".repeat(pad))
    };
    let long = fill(104);
    fs::create_dir_all(&long).unwrap();
    let error = server::serve_recording(&long).unwrap_err();
    let sock = long.join("core.sock");
    assert!(error.contains(sock.to_str().unwrap()), "{error}");
    assert!(error.contains("104") && error.contains("103"), "{error}");
    assert!(!sock.exists());
    // v1a-69: the refusal comes before every file the core would write.
    assert!(!long.join("core.lock").exists());
    assert!(!long.join("logs").exists());

    let fits = fill(103);
    fs::create_dir_all(&fits).unwrap();
    let path = fits.clone();
    let task = thread::spawn(move || server::serve_recording(&path));
    let start = Instant::now();
    while UnixStream::connect(fits.join("core.sock")).is_err() {
        assert!(!task.is_finished(), "{:?}", task.join());
        assert!(start.elapsed() < Duration::from_secs(30));
        thread::sleep(Duration::from_millis(10));
    }
    let token = fs::read_to_string(fits.join("core.token")).unwrap();
    let mut s = UnixStream::connect(fits.join("core.sock")).unwrap();
    writeln!(s, r#"{{"token":"{token}","request":{{"op":"stop"}}}}"#).unwrap();
    BufReader::new(s).read_line(&mut String::new()).unwrap();
    task.join().unwrap().unwrap();
    fs::remove_dir_all(base).unwrap();
}
