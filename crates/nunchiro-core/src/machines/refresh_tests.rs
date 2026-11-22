//! Ticket 131: real owner window loops, with per-home file-read and snapshot-pass receipts.
use super::*;
use std::{sync::OnceLock, thread, time::Instant};
use tungstenite::client::IntoClientRequest;

#[derive(Clone, Default)]
struct Counts {
    reads: Vec<Instant>,
    snapshots: usize,
}
static COUNTS: OnceLock<Mutex<BTreeMap<PathBuf, Counts>>> = OnceLock::new();

pub(crate) fn record(home: &Path, snapshot: bool) {
    let mut counts = COUNTS.get_or_init(Mutex::default).lock().unwrap();
    let count = counts.entry(home.into()).or_default();
    if snapshot {
        count.snapshots += 1;
    } else {
        count.reads.push(Instant::now());
    }
}

struct Windows {
    home: PathBuf,
    stopping: Arc<AtomicBool>,
    registry: Arc<Mutex<Sessions>>,
    sockets: Vec<tungstenite::WebSocket<std::net::TcpStream>>,
}
impl Windows {
    fn new(name: &str, count: usize) -> Self {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("{name}-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        fs::write(home.join("machines.json"), r#"{"version":1,"machines":[]}"#).unwrap();
        let registry = Arc::new(Mutex::new(Sessions::open(&home).unwrap()));
        let stopping = Arc::new(AtomicBool::new(false));
        let (port, token) = crate::http::spawn(&home, registry.clone(), stopping.clone()).unwrap();
        let mut sockets = vec![];
        for _ in 0..count {
            let mut request = format!("ws://127.0.0.1:{port}/ws")
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert("Origin", "tauri://localhost".parse().unwrap());
            request.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                format!("nunchiro.v1, nunchiro.token.{token}")
                    .parse()
                    .unwrap(),
            );
            let socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let (mut ws, _) = tungstenite::client(request, socket).unwrap();
            loop {
                if let tungstenite::Message::Text(text) = ws.read().unwrap()
                    && serde_json::from_str::<serde_json::Value>(&text).unwrap()["event"]
                        == "snapshot"
                {
                    break;
                }
            }
            sockets.push(ws);
        }
        Self {
            home,
            stopping,
            registry,
            sockets,
        }
    }
}
impl Drop for Windows {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        for ws in &mut self.sockets {
            let _ = ws.close(None);
        }
        let _ = self.registry.lock().unwrap().stop();
        // The idle HTTP loops see stopping before their next frame pass.
        thread::sleep(Duration::from_millis(100));
        let _ = fs::remove_dir_all(&self.home);
        COUNTS.get().unwrap().lock().unwrap().remove(&self.home);
    }
}

#[test]
fn machine_refresh_reads_bounded_across_windows() {
    let windows = Windows::new("refresh-bounded", 4);
    thread::sleep(Duration::from_millis(1250));
    let count = COUNTS.get().unwrap().lock().unwrap()[&windows.home].clone();
    eprintln!(
        "ticket-131: 4 owner windows, reads={}, snapshot passes={}",
        count.reads.len(),
        count.snapshots
    );
    assert!(
        count.reads.len() >= 2,
        "refresh must continue after one second"
    );
    for pair in count.reads.windows(2) {
        assert!(
            pair[1].duration_since(pair[0]) >= Duration::from_secs(1),
            "machines.json reads only {:?} apart",
            pair[1].duration_since(pair[0])
        );
    }
}

#[test]
fn local_snapshot_cadence_preserved() {
    let windows = Windows::new("refresh-cadence", 1);
    thread::sleep(Duration::from_millis(1250));
    let count = COUNTS.get().unwrap().lock().unwrap()[&windows.home].clone();
    eprintln!(
        "ticket-131: 1 owner window, reads={}, snapshot passes={}",
        count.reads.len(),
        count.snapshots
    );
    assert!(
        count.snapshots >= 10,
        "local snapshots must keep their 100 ms cadence: {} passes",
        count.snapshots
    );
    assert!(
        count.reads.len() <= 2,
        "machine refresh must not follow each local snapshot: {} reads",
        count.reads.len()
    );
}

#[test]
fn machine_refresh_errors_and_stopping_are_bounded() {
    let windows = Windows::new("refresh-errors", 0);
    for broken in [
        r#"[]"#,
        r#"{"version":1,"machines":42}"#,
        r#"{"version":1,"machines":["same","same"]}"#,
    ] {
        fs::write(windows.home.join("machines.json"), broken).unwrap();
        let error =
            ensure_channels(&windows.registry, &windows.home, &windows.stopping).unwrap_err();
        let before = COUNTS.get().unwrap().lock().unwrap()[&windows.home]
            .reads
            .len();
        for _ in 0..4 {
            assert_eq!(
                ensure_channels(&windows.registry, &windows.home, &windows.stopping),
                Err(error.clone())
            );
        }
        assert_eq!(
            COUNTS.get().unwrap().lock().unwrap()[&windows.home]
                .reads
                .len(),
            before
        );
        assert_eq!(
            fs::read_to_string(windows.home.join("machines.json")).unwrap(),
            broken
        );
        assert!(windows.registry.lock().unwrap().remote.channels.is_empty());
    }
    windows.registry.lock().unwrap().remote.channels_checked_at = None;
    windows.stopping.store(true, Ordering::SeqCst);
    let before = COUNTS.get().unwrap().lock().unwrap()[&windows.home]
        .reads
        .len();
    ensure_channels(&windows.registry, &windows.home, &windows.stopping).unwrap();
    assert_eq!(
        COUNTS.get().unwrap().lock().unwrap()[&windows.home]
            .reads
            .len(),
        before
    );
}

#[test]
fn changed_store_is_read_within_budget() {
    let windows = Windows::new("refresh-changed", 0);
    let path = windows.home.join("machines.json");
    let refresh = || ensure_channels(&windows.registry, &windows.home, &windows.stopping);
    let reads = || {
        COUNTS.get().unwrap().lock().unwrap()[&windows.home]
            .reads
            .len()
    };
    refresh().unwrap();
    let before = reads();
    refresh().unwrap();
    assert_eq!(reads(), before, "unchanged valid store stays within budget");

    // Different length must invalidate even if the modified time is unchanged.
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, r#"{"version":1,"machines":[]} "#).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    refresh().unwrap();
    assert_eq!(reads(), before + 1, "length change refreshes immediately");
    refresh().unwrap();
    assert_eq!(reads(), before + 1);

    // Same-length edits use modified time; pin it to avoid host timestamp granularity.
    fs::write(&path, r#"{"version":2,"machines":[]} "#).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH)
        .unwrap();
    let error = refresh().unwrap_err();
    assert_eq!(reads(), before + 2, "same-length changed store is reread");
    assert_eq!(
        refresh(),
        Err(error),
        "unchanged failed state must keep returning its error"
    );
    assert_eq!(reads(), before + 2, "failed reads also share the budget");

    fs::write(&path, r#"{"version":1,"machines":[]} "#).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))
        .unwrap();
    refresh().unwrap();
    assert_eq!(
        reads(),
        before + 3,
        "a repaired store clears the cached error"
    );

    fs::remove_file(&path).unwrap();
    refresh().unwrap();
    assert_eq!(reads(), before + 4, "deletion changes the key to absent");
    refresh().unwrap();
    assert_eq!(reads(), before + 4, "unchanged absence stays within budget");
    fs::write(&path, r#"{"version":1,"machines":[]}"#).unwrap();
    refresh().unwrap();
    assert_eq!(reads(), before + 5, "creation changes the key from absent");

    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("machines.json", &path).unwrap();
    assert!(
        refresh().is_err(),
        "metadata errors must not reuse cached success"
    );
    assert_eq!(reads(), before + 5, "metadata failure stops before reading");
}

#[test]
fn machine_refresh_errors_preserve_window_output_cadence() {
    let windows = Windows::new("refresh-error-cadence", 1);
    let output = crate::http::output_counts(&windows.home);
    fs::write(windows.home.join("machines.json"), "broken store").unwrap();
    let error = ensure_channels(&windows.registry, &windows.home, &windows.stopping).unwrap_err();
    let before = COUNTS.get().unwrap().lock().unwrap()[&windows.home].clone();
    let passes = output.passes.load(Ordering::SeqCst);
    let at = Instant::now();
    thread::sleep(Duration::from_millis(450));
    let elapsed = at.elapsed();
    let passes = output.passes.load(Ordering::SeqCst) - passes;
    let after = COUNTS.get().unwrap().lock().unwrap()[&windows.home].clone();
    assert_eq!(
        ensure_channels(&windows.registry, &windows.home, &windows.stopping),
        Err(error)
    );
    assert_eq!(
        after.reads.len(),
        before.reads.len(),
        "cached errors must not reread the store"
    );
    assert!(
        after.snapshots >= before.snapshots + 2,
        "local snapshot passes continue through cached errors"
    );
    // Existing loop budget: one pass per 2 ms wake batch plus one per 8 ms idle tick.
    let budget = elapsed.as_millis() as u64 / 2 + elapsed.as_millis() as u64 / 8 + 5;
    eprintln!("ticket-131 cached-error cadence: {passes} passes in {elapsed:?}, budget {budget}");
    assert!(
        passes > 0 && passes <= budget,
        "{passes} output passes in {elapsed:?}"
    );
}

/// Q9 ko-J8-1: a broken machines.json leaves the owner socket's snapshot working; the store error stays with
/// `ensure_channels` (and so with MachineDetails).
#[test]
fn broken_store_keeps_owner_snapshot() {
    let windows = Windows::new("refresh-broken-snapshot", 0);
    fs::write(windows.home.join("machines.json"), "[]").unwrap();
    let mut reply = windows.registry.lock().unwrap().snapshot().unwrap();
    snapshot(
        &windows.registry,
        &windows.home,
        "",
        true,
        &mut reply,
        &windows.stopping,
    )
    .unwrap();
    assert!(matches!(reply, Reply::Snapshot { .. }));
    assert!(ensure_channels(&windows.registry, &windows.home, &windows.stopping).is_err());
}
