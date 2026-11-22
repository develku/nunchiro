//! Discover Codex resume identity from rollout files opened by its own process tree.
//! This is read-only and works with hook injection disabled; no global rollout guessing.
use crate::{api::Request, server, store};
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub fn watch(
    home: PathBuf,
    session: String,
    token: String,
    pid: u32,
    cwd: PathBuf,
    alive: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let started = Instant::now();
        while alive.load(Ordering::SeqCst) {
            if let Some(agent_id) = discover(pid, &cwd) {
                let request = Request::Hook {
                    id: session.clone(),
                    event: "SessionStart".into(),
                    payload: serde_json::json!({"session_id":agent_id}),
                };
                if server::call_with_token(&home, &token, request).is_ok() {
                    return;
                }
            }
            thread::sleep(if started.elapsed().as_secs() < 10 {
                Duration::from_millis(200)
            } else {
                Duration::from_secs(2)
            });
        }
    });
}
fn discover(pid: u32, cwd: &Path) -> Option<String> {
    let ps = crate::process::command("/bin/ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
        .ok()?;
    if !ps.status.success() {
        return None;
    }
    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
        })
        .collect();
    if !pairs.iter().any(|(p, _)| *p == pid) {
        return None;
    }
    let mut owned = vec![pid];
    let mut i = 0;
    while i < owned.len() {
        let parent = owned[i];
        owned.extend(pairs.iter().filter(|(_, p)| *p == parent).map(|(p, _)| *p));
        i += 1;
    }
    let list = owned
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut child = crate::process::command("/usr/sbin/lsof")
        .args(["-n", "-P", "-a", "-p", &list, "-Fn"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let mut names = String::new();
    child
        .stdout
        .take()?
        .take(128 * 1024)
        .read_to_string(&mut names)
        .ok()?;
    let mut ids = std::collections::BTreeSet::new();
    for name in names.lines().filter_map(|line| line.strip_prefix('n')) {
        let path = Path::new(name);
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            continue;
        }
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        let mut line = String::new();
        if BufReader::new(file.take(1024 * 1024))
            .read_line(&mut line)
            .is_err()
        {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let payload = &record["payload"];
        if record["type"] != "session_meta"
            || payload["source"] != "cli"
            || payload["cwd"].as_str().map(Path::new) != Some(cwd)
        {
            continue;
        }
        if let Some(id) = payload["id"].as_str().filter(|id| store::valid_id(id)) {
            ids.insert(id.to_string());
        }
    }
    // Never attach another conversation when provenance is ambiguous.
    if ids.len() == 1 {
        ids.pop_first()
    } else {
        None
    }
}
