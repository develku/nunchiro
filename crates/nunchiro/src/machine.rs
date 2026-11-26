//! v1a-06: public status command and the SSH stdin relay (owner authority on that host).
use nunchiro_core::{api::*, machines};
use std::{
    io::{Read, Write},
    path::Path,
    time::Duration,
};
pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    if args == ["relay", "--stream"] {
        return stream(home);
    }
    if args == ["relay"] {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(512 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        // V2-12m-a: the newer side checks the window, so this side takes its own protocol and the next one; a request
        // without a protocol (v1a) still needs the exact package version.
        let window = value["protocol"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .is_some_and(machines::relay_accepts);
        if !window && value["version"] != env!("CARGO_PKG_VERSION") {
            return Err(format!(
                "version mismatch: remote nunchiro {}",
                env!("CARGO_PKG_VERSION")
            ));
        }
        let request: Request =
            serde_json::from_value(value["request"].clone()).map_err(|e| e.to_string())?;
        if matches!(
            request,
            Request::Remote { .. } | Request::MachineStatus { .. }
        ) {
            return Err("nested remote request refused".into());
        }
        // Service requests are reachable only over the owner-authorized SSH transport.
        if let Request::RemoteService { restart } = request {
            if restart {
                let output =
                    std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                        .args(["serve", "restart"])
                        .output()
                        .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).into());
                }
            } else {
                super::ensure_core(home)?;
            }
            println!(
                "{}",
                serde_json::to_string(&Ok::<_, String>(Reply::Ack)).map_err(|e| e.to_string())?
            );
            return Ok(());
        }
        super::ensure_core(home)?;
        // V2-12m-a r2/r3: one answer per item id. A claim left by an earlier relay means "already answered" only when
        // the item is no longer pending: that relay may have died before applying it, and the queue removes an item
        // before acting on it, so a still-pending item was not applied and its answer goes ahead (the queue's own
        // pending check still stops a second apply). The claim is released whenever the answer did not apply.
        let claim = match answer_item(&request).map(|item| claim(home, item)) {
            Some(Err(e)) => {
                println!(
                    "{}",
                    serde_json::to_string(&Err::<Reply, _>(e)).map_err(|e| e.to_string())?
                );
                return Ok(());
            }
            Some(Ok(path)) => Some(path),
            None => None,
        };
        let response = super::call_once(home, request); // the caller retries (ticket 305)
        if response.is_err()
            && let Some(path) = claim
        {
            let _ = std::fs::remove_file(path);
        }
        println!(
            "{}",
            serde_json::to_string(&response).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let label = match args {
        [status] if status == "status" => None,
        [status, label] if status == "status" => Some(label.clone()),
        _ => return Err("use nunchiro machine status [<label>]".into()),
    };
    super::ensure_core(home)?;
    let reply = super::call(
        home,
        Request::MachineStatus {
            label,
            retry: false,
        },
    )?;
    println!(
        "{}",
        serde_json::to_string(&reply).map_err(|e| e.to_string())?
    );
    Ok(())
}
// V2-12m-a: the long-lived relay on the ControlMaster. It says hello first, then pushes this core's rows whenever
// they change. It reads nothing from the channel and ends when the master closes its stdin or stops reading.
fn stream(home: &Path) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    let hello = serde_json::json!({"type":"hello","protocol":machines::PROTOCOL,"version":env!("CARGO_PKG_VERSION")});
    writeln!(out, "{hello}")
        .and_then(|()| out.flush())
        .map_err(|e| e.to_string())?;
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(0);
    });
    super::ensure_core(home)?;
    let mut last = String::new();
    loop {
        // shortcut: the core has no push API, so this reads it over the local socket every 200 ms (never an SSH
        // request); upgrade to a core event stream when one exists.
        let Reply::Snapshot { sessions, .. } = super::call(home, Request::List)? else {
            return Err("unexpected list reply".into());
        };
        // `ssh_login`: this core cannot read the login keychain; the other side tells the owner (it is read each
        // time, since a restart may have moved the core into the login session).
        let line = serde_json::json!({"type":"sessions","sessions":sessions,"ssh_login":machines::core_in_ssh_login(home)}).to_string();
        if line != last {
            writeln!(out, "{line}")
                .and_then(|()| out.flush())
                .map_err(|e| e.to_string())?;
            last = line;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
fn answer_item(request: &Request) -> Option<&str> {
    match request {
        Request::Answer { item, .. } => Some(item),
        Request::Forwarded { request, .. } => answer_item(request),
        _ => None,
    }
}
// `relay-answered/<item>` is created once (create_new), so two relays cannot both forward one answer.
fn claim(home: &Path, item: &str) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::OpenOptionsExt;
    if item.is_empty()
        || item.len() > 80
        || !item.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid decision id".into());
    }
    let dir = home.join("relay-answered");
    machines::private_dir(&dir)?;
    // shortcut: markers older than a day are swept on each answer; upgrade when the queue records answered ids itself.
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| {
            t.elapsed()
                .is_ok_and(|age| age > Duration::from_secs(86_400))
        }) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let path = dir.join(item);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(_) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let Reply::Snapshot { sessions, .. } = super::call_once(home, Request::List)? else {
                return Err("unexpected list reply".into());
            };
            if sessions
                .iter()
                .any(|s| s.pending.iter().any(|d| d.id == item))
            {
                Ok(path)
            } else {
                Err(machines::ALREADY_ANSWERED.into())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}
