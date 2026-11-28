//! V2-13b: `nunchiro diagnose` writes one local bundle under `$NUNCHIRO_HOME/diagnose/<UTC timestamp>/` from a fixed
//! allow-list (`tests/diagnose_allowlist.json`). It reads files only, never starts the core, opens no socket and
//! writes nothing outside `diagnose/`. Every text it keeps passes the V2-13a redactor again at write.
use nunchiro_core::logs;
use serde_json::{Map, Value, json};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CLI_TIMEOUT: Duration = Duration::from_secs(2);
/// A state file or settings read stops here; the core's own files are far smaller.
const READ_MAX: u64 = 16 * 1024 * 1024;
const VERSION_MAX: usize = 200;

pub fn run(home: &Path) -> Result<(), String> {
    let sessions = read_json(&home.join("sessions.json"));
    let bundle = [
        ("versions.json", versions()),
        ("settings.json", settings(home)),
        ("snapshot.json", snapshot(sessions.as_ref())),
        ("status.json", status(home, sessions.as_ref())),
    ];
    let root = home.join("diagnose");
    private_dir(&root)?;
    let dir = new_dir(&root)?;
    for (name, value) in bundle {
        let text = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        write(&dir.join(name), &text)?;
    }
    write(&dir.join("core.log.tail"), &mask_hex(&logs::tail(home)))?;
    println!("{}", dir.display());
    Ok(())
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // create_new fails on an existing name, a planted link included.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("{}: {e}", path.display()))
}
/// A fresh 0700 `<timestamp>[-N]` folder; `mkdir` never follows a link at the name, so a planted one is skipped.
fn new_dir(root: &Path) -> Result<PathBuf, String> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let stamp = utc_stamp(secs);
    for n in 0..1000 {
        let dir = root.join(if n == 0 {
            stamp.clone()
        } else {
            format!("{stamp}-{n}")
        });
        match DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", dir.display())),
        }
    }
    Err("no free diagnose folder name".into())
}
fn utc_stamp(secs: u64) -> String {
    // Civil date from days since the epoch (Hinnant's algorithm).
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn private_dir(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("diagnose folder must not be a symlink".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
/// A regular file's JSON; a link, a non-file or anything unreadable reads as absent.
fn read_json(path: &Path) -> Option<Value> {
    // shortcut: check then open, a link swapped in between is followed; the bytes still only feed allow-listed fields.
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = vec![];
    fs::File::open(path)
        .ok()?
        .take(READ_MAX)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}
/// Redacted text of a JSON string field; anything else reads empty.
fn text(v: &Value, key: &str) -> String {
    logs::excerpt(v[key].as_str().unwrap_or(""))
}

fn versions() -> Value {
    json!({
        "nunchiro": env!("CARGO_PKG_VERSION"),
        "claude": cli("claude", &["--version"]),
        "codex": cli("codex", &["--version"]),
        "os": cli("/usr/bin/uname", &["-sr"]),
    })
}
/// First stdout line of `program args`, redacted and cut; "unavailable" when it is missing, fails or is not done
/// within 2 s (one deadline for output and exit; the child is killed at it). The child sees PATH only; output past
/// the first 4 KiB is read and dropped so the child never blocks on a full pipe.
fn cli(program: &str, args: &[&str]) -> String {
    const UNAVAILABLE: &str = "unavailable";
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    let Ok(mut child) = Command::new(nunchiro_core::process::resolve_program(
        program,
        Some(&path),
    ))
    .arg0(program) // argv[0] stays the bare name
    .args(args)
    .env_clear()
    .env("PATH", path)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn() else {
        return UNAVAILABLE.into();
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return UNAVAILABLE.into();
    };
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut kept = vec![];
        let _ = (&mut stdout).take(4096).read_to_end(&mut kept);
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        let _ = tx.send(kept);
    });
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    let out = match status {
        Some(status) if status.success() => rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok(),
        _ => None,
    };
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let Some(out) = out else {
        return UNAVAILABLE.into();
    };
    let out = String::from_utf8_lossy(&out);
    let line = logs::excerpt(out.lines().next().unwrap_or("").trim());
    match line.char_indices().nth(VERSION_MAX) {
        Some((i, _)) => line[..i].into(),
        None if line.is_empty() => UNAVAILABLE.into(),
        None => line,
    }
}

/// Whether `value` has the shape the core's `Settings` field `key` parses (the fields are in
/// crates/nunchiro-core/src/sessions.rs; `diagnose_settings_keys_match_core` fails when they drift from this match); a nested or mistyped value is dropped
/// whole, so a secret under an allowed key cannot ride along.
fn shaped(key: &str, value: &Value) -> bool {
    let bool_map = |v: &Value| {
        v.as_object()
            .is_some_and(|m| m.values().all(Value::is_boolean))
    };
    match key {
        "disable_hook_injection"
        | "start_at_login"
        | "script_widgets"
        | "web_widgets"
        | "mask_history"
        | "live_pr_status" // v2-8c
        | "live_pr_offered"
        | "auto_clean_worktrees" // V2-8a
        | "keep_awake" => value.is_boolean(), // V2-CF5
        // v2-8c: only exact GitHub pull links (the core's own check), so no other text rides along.
        "pr_watch" => value.as_array().is_some_and(|a| {
            a.iter()
                .all(|u| u.as_str().is_some_and(nunchiro_core::pr_live::valid_url))
        }),
        "keep_history" => value.is_null() || value.is_boolean(),
        "stale_after_ms" | "triggers_port" | "triggers_poll_secs" => value.is_null() || value.is_u64(),
        "worktrees_dir" => value.is_null() || value.is_string(),
        // Ticket 211: folders the owner allowed Usage to read through a link; strings only here; `settings` then keeps
        // the entries that pass `clean` (an ordinary personal path such as /Users/a/proj stays on purpose).
        "usage_link_roots" => value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)),
        "session_lifetime" => matches!(value.as_str(), Some("keep_running" | "end_with_app")),
        "permission_answers" => bool_map(value),
        // V2.5-31: only the known keys, each a bool, a known enum or an optional integer; no text rides along.
        "orchestration" => value.as_object().is_some_and(|m| {
            m.iter().all(|(k, v)| match k.as_str() {
                "enabled" | "auto_close_finished" => v.is_boolean(),
                "level" => matches!(v.as_str(), Some("solo" | "team" | "strict")),
                "merge" => matches!(v.as_str(), Some("ask" | "auto")),
                "max_workers" | "max_depth" => v.is_null() || v.is_u64(),
                _ => false,
            })
        }),
        // V2-13b: a map; its entries are filtered one by one in `settings` (`known_machines`).
        "machines" => value.is_object(),
        // Ticket 250: a map; its entries are filtered one by one in `settings` (`known_features`).
        "features" => value.is_object(),
        _ => false,
    }
}
/// Ticket 250 r3: the `features` entries a bundle may carry: a known feature id (never a path or a sentence, whatever
/// the file holds) with a flag or null (never text, and never a number: the redactor masks shapes, not a port, PID or
/// account id; a feature that needs its number here adds it with its reader and its own review). Returns them and
/// how many were left out.
fn known_features(map: Map<String, Value>, known: &[&str]) -> (Map<String, Value>, usize) {
    let total = map.len();
    let kept: Map<String, Value> = map
        .into_iter()
        .filter(|(k, v)| known.contains(&k.as_str()) && (v.is_boolean() || v.is_null()))
        .collect();
    let gone = total - kept.len();
    (kept, gone)
}
/// V2-13b follow-up (ticket 26): a well-formed project path is absolute, at most 4096 bytes, and every character is one
/// a person sees: the core's own `shown` rule, so there is one list of hidden characters.
fn path(s: &str) -> bool {
    s.starts_with('/') && s.len() <= 4096 && s.chars().all(nunchiro_core::delivery::shown)
}
/// V2-13b: `s` holds a secret-looking word: all hex of length 32, 40 or 64 (any case: a token digest, a git commit id)
/// or 32 or more characters mixing letters and digits (a base64url or base64 token). A word is a run of
/// `[A-Za-z0-9_-]` (so a suffix such as `.git` does not hide one) and also a run of `[A-Za-z0-9_.+=~:@%-]` with the
/// joiners `. + = ~ : @ %` taken out (so a sha cut by `.` or a base64 token cut by `+` is judged whole); `/` always separates.
/// `mask_hex` keeps its narrower rule: the log tail pins that upper-case and 40-hex words stay.
fn secret_segment(s: &str) -> bool {
    let secret = |w: &str| {
        let hex = matches!(w.len(), 32 | 40 | 64) && w.bytes().all(|b| b.is_ascii_hexdigit());
        let has = |f: fn(&u8) -> bool| w.as_bytes().iter().any(f);
        hex || (w.len() >= 32 && has(u8::is_ascii_alphabetic) && has(u8::is_ascii_digit))
    };
    const JOINERS: [char; 7] = ['.', '+', '=', '~', ':', '@', '%'];
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || JOINERS.contains(&c)))
        .any(|w| w.split(JOINERS).any(secret) || secret(&w.replace(JOINERS, "")))
}
/// An IPv4 address anywhere in `s`: split on every char that is neither a digit nor `.`, and a run with four or more
/// dot-separated all-digit parts is one (so `:22`, `user@` or `nas-` around it does not hide it, and `1.2.3.4a` counts).
fn ip(s: &str) -> bool {
    s.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .any(|run| {
            let parts: Vec<&str> = run.trim_matches('.').split('.').collect();
            parts.len() >= 4 && parts.iter().all(|p| !p.is_empty())
        })
}
/// A path-valued setting a bundle may carry: it passes `path`, holds no `secret_segment`, no part of it is an IP
/// address and the redactor leaves it unchanged.
fn clean(s: &str) -> bool {
    path(s) && !secret_segment(s) && !ip(s) && logs::redact(s.as_bytes()) == s.as_bytes()
}
/// A machine name a bundle may show: not an IP address and unchanged by the redactor and the hex mask, so one odd
/// name drops only its own entry.
fn plain_name(name: &str) -> bool {
    !ip(name)
        && logs::redact(name.as_bytes()) == name.as_bytes()
        && mask_hex(name.as_bytes()) == name.as_bytes()
}
/// The redactor leaves `v` unchanged as serialized, so a `"api-token":"x"` pair is judged as the file shows it.
fn unmasked(v: &Value) -> bool {
    let flat = v.to_string();
    logs::redact(flat.as_bytes()) == flat.as_bytes()
}
/// V2-13b: the `machines` entries a bundle may carry. A machine stays when its name passes the core's alias rule and
/// holds no `secret_segment`, and its value is exactly `{"projects": {..}}`; inside it a path pair stays when both
/// sides are `clean`. Whatever fails is counted, never named, so one odd entry no longer hides the others.
fn known_machines(map: Map<String, Value>) -> (Map<String, Value>, usize) {
    let (mut kept, mut gone) = (Map::new(), 0);
    for (name, config) in map {
        let projects = config
            .as_object()
            .filter(|c| c.len() == 1)
            .and_then(|c| c.get("projects"))
            .and_then(Value::as_object);
        let (true, Some(projects)) = (
            nunchiro_core::machines::valid_alias(&name).is_ok()
                && plain_name(&name)
                && !secret_segment(&name),
            projects,
        ) else {
            gone += 1;
            continue;
        };
        let total = projects.len();
        let pairs: Map<String, Value> = projects
            .iter()
            .filter(|(k, v)| {
                clean(k) && v.as_str().is_some_and(clean) && unmasked(&json!({ k.as_str(): v }))
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        gone += total - pairs.len();
        let machine = json!({ name.as_str(): { "projects": pairs } });
        if !unmasked(&machine) {
            gone += 1;
            continue;
        }
        let entry = machine[name.as_str()].clone();
        kept.insert(name, entry);
    }
    (kept, gone)
}
/// Known keys of the right shape whose serialized value the redactor leaves unchanged; the rest are named in
/// `dropped`, never shown.
fn settings(home: &Path) -> Value {
    let mut kept = Map::new();
    let mut dropped = vec![];
    match read_json(&home.join("settings.json")) {
        Some(Value::Object(map)) => {
            for (key, value) in map {
                let flat = value.to_string();
                let (value, flat) = match (key.as_str(), value) {
                    // Ticket 250 r3: only known feature ids with a flag or null survive; the rest are counted, never named.
                    ("features", Value::Object(m)) => {
                        let (map, gone) = known_features(m, nunchiro_core::api::KNOWN_FEATURES);
                        if gone > 0 {
                            dropped.push(format!("features ({gone} entries)"));
                        }
                        let v = Value::Object(map);
                        let f = v.to_string();
                        (v, f)
                    }
                    ("machines", Value::Object(m)) => {
                        let (map, gone) = known_machines(m);
                        if gone > 0 {
                            dropped.push(format!("machines ({gone} entries)"));
                        }
                        // Every entry passed `unmasked` already, and entries are never joined across the `},"` boundary, so the whole-map
                        // redact below would only let one odd entry drop the lot; it is skipped.
                        kept.insert(key, Value::Object(map));
                        continue;
                    }
                    // V2-13b: path-valued settings pass the same `clean` rule as machine project paths.
                    ("worktrees_dir", Value::String(s)) if !clean(&s) => {
                        dropped.push(key.clone());
                        continue;
                    }
                    // A list with a non-string entry falls through, so `shaped` drops the whole key as before.
                    ("usage_link_roots", Value::Array(a)) if a.iter().all(Value::is_string) => {
                        let total = a.len();
                        let a: Vec<Value> = a
                            .into_iter()
                            .filter(|v| v.as_str().is_some_and(clean))
                            .collect();
                        if a.len() < total {
                            dropped.push(format!("usage_link_roots ({} entries)", total - a.len()));
                        }
                        let v = Value::Array(a);
                        let f = v.to_string();
                        (v, f)
                    }
                    (_, v) => (v, flat),
                };
                if shaped(&key, &value) && logs::redact(flat.as_bytes()) == flat.as_bytes() {
                    // v2-8c: watched PR links name (maybe private) repositories; a bundle gets their count only.
                    let value = match key.as_str() {
                        "pr_watch" => json!(value.as_array().map_or(0, Vec::len)),
                        _ => value,
                    };
                    kept.insert(key, value);
                } else {
                    dropped.push(logs::excerpt(&key));
                }
            }
        }
        Some(_) => dropped.push("settings.json".into()),
        None => {}
    }
    dropped.sort();
    kept.insert("dropped".into(), json!(dropped));
    Value::Object(kept)
}

/// From `sessions.json` as a file, so a stopped core is fine and nothing is set aside or rewritten.
fn snapshot(store: Option<&Value>) -> Value {
    let rows = store
        .and_then(|s| s["sessions"].as_array())
        .filter(|_| store.is_some_and(readable))
        .map_or(vec![], |rows| {
            rows.iter()
                .map(|s| {
                    json!({
                        "id": text(s, "id"), "kind": text(s, "kind"), "state": text(s, "state"),
                        "project": text(s, "project"), "cwd": text(s, "cwd"), "label": text(s, "label"),
                        "pending_count": s["pending"].as_array().map_or(0, Vec::len),
                    })
                })
                .collect()
        });
    json!({ "sessions": rows })
}
/// A store version this build reads (1, 2, or 3 when it holds token records, ticket 752).
fn readable(store: &Value) -> bool {
    use nunchiro_core::{STORE_TOKEN_VERSION, STORE_VERSION};
    matches!(store["version"].as_u64(), Some(v) if v == 1 || v == STORE_VERSION || v == STORE_TOKEN_VERSION)
}

fn status(home: &Path, store: Option<&Value>) -> Value {
    let mut files = vec![];
    for entry in fs::read_dir(home).into_iter().flatten().flatten() {
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        if !name.starts_with("sessions.json")
            || !fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_file())
        {
            continue;
        }
        let tag = name
            .strip_prefix("sessions.json.v")
            .map(|rest| rest.split('.').next().and_then(|n| n.parse::<u64>().ok()));
        let shown = logs::excerpt(&name);
        let file = match (name.as_str(), tag) {
            ("sessions.json", _) => match store {
                Some(s) if readable(s) => {
                    json!({"name": shown, "kind": "store", "version": s["version"]})
                }
                Some(s) if s["version"].is_u64() => {
                    json!({"name": shown, "kind": "other-version", "version": s["version"]})
                }
                _ => json!({"name": shown, "kind": "store"}),
            },
            (_, Some(version)) if name.ends_with(".aside") => {
                json!({"name": shown, "kind": "aside", "version": version})
            }
            (_, Some(version)) => {
                json!({"name": shown, "kind": "other-version", "version": version})
            }
            _ => continue,
        };
        files.push(file);
    }
    files.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_string());
    let holders: Vec<Value> = store
        .and_then(|s| s["live"].as_object())
        .into_iter()
        .flatten()
        .filter_map(|(id, live)| {
            let pid = live["holder"]["pid"].as_u64()?;
            Some(json!({"session": logs::excerpt(id), "alive": alive(pid)}))
        })
        .collect();
    json!({ "state_files": files, "holders": holders })
}
/// shortcut: `kill -0` cannot tell a reused pid from the holder (the record's `started` is not compared), and a
/// process of another user reads as gone; upgrade when a status line must be exact.
fn alive(pid: u64) -> bool {
    pid > 1
        && pid <= i32::MAX as u64
        && Command::new("/bin/sh")
            .args(["-c", "kill -0 \"$1\" 2>/dev/null", "sh", &pid.to_string()])
            .env_clear()
            .status()
            .is_ok_and(|s| s.success())
}

/// Words of exactly 32 or 64 lowercase hex characters (a session token or its SHA-256) become `[hex-redacted]`:
/// the core is stopped, so no token is registered for the redactor to match.
fn mask_hex(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if !text[i].is_ascii_alphanumeric() {
            out.push(text[i]);
            i += 1;
            continue;
        }
        let end = i + text[i..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric())
            .count();
        let word = &text[i..end];
        if matches!(word.len(), 32 | 64)
            && word.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            out.extend_from_slice(b"[hex-redacted]");
        } else {
            out.extend_from_slice(word);
        }
        i = end;
    }
    out
}

#[cfg(test)]
mod segment_tests {
    use super::secret_segment;

    // V2-13b: the length floors, the exact hex lengths, case, and a word inside a longer path or file name.
    #[test]
    fn secret_segment_boundaries() {
        let mixed = |n: usize| "a1".repeat(n).chars().take(n).collect::<String>();
        assert!(
            !secret_segment(&format!("/w/{}", mixed(31))),
            "31 mixed stays"
        );
        assert!(
            secret_segment(&format!("/w/{}", mixed(32))),
            "32 mixed goes"
        );
        for (n, secret) in [
            (31, false),
            (32, true),
            (39, false),
            (40, true),
            (41, false),
            (64, true),
            (65, false),
        ] {
            for hex in ["1".repeat(n), "a".repeat(n), "A".repeat(n)] {
                assert_eq!(
                    secret_segment(&format!("/srv/{hex}/repo")),
                    secret,
                    "{n} hex {hex}"
                );
            }
        }
        assert!(
            secret_segment(&format!("/srv/{}/", "0123456789ABCDEF".repeat(4))),
            "upper-case 64-hex, trailing /"
        );
        assert!(
            secret_segment(&format!("/srv/build-{}", "1".repeat(40))),
            "hex inside a longer word"
        );
        assert!(
            secret_segment(&format!("/srv/{}.git", "9f".repeat(20))),
            "hex before a suffix"
        );
        // Joined across `.`, `+`, `=`: 32 goes, 31 stays; `/` still separates, so short directories pass.
        assert!(secret_segment(&format!("/w/{}.{}", mixed(16), mixed(16))));
        assert!(secret_segment(&format!("/w/{}+{}==", mixed(16), mixed(16))));
        assert!(!secret_segment(&format!("/w/{}.{}", mixed(15), mixed(16))));
        assert!(!secret_segment(&format!(
            "/w/{}/{}",
            "1".repeat(20),
            "2".repeat(20)
        )));
        for word in [
            "/w/project",
            "/w/my-long-project-name-without-digits",
            "/w/a1b2",
            "/w/deadbeef",
            "/",
        ] {
            assert!(!secret_segment(word), "{word} stays");
        }
    }
}

#[cfg(test)]
mod features_tests {
    use super::known_features;
    use serde_json::json;

    // V2.5-77: with a known id, a flag and null are kept; a number (a port, PID or account id the redactor cannot
    // see), a text value, an object and an unknown key are left out and counted.
    #[test]
    fn known_features_keep_only_known_ids_with_flags() {
        let map = json!({"terminal.scrollback_lines": 5000, "pr.strip_agent_credits": false, "x.unset": null,
            "/Users/me/clients/acme-private-deal": true, "git.branch_prefix": "acme/", "a.obj": {"p": "acme"}});
        let known = [
            "terminal.scrollback_lines",
            "pr.strip_agent_credits",
            "x.unset",
            "git.branch_prefix",
            "a.obj",
        ];
        let (kept, gone) = known_features(map.as_object().unwrap().clone(), &known);
        assert_eq!(
            serde_json::Value::Object(kept),
            json!({"pr.strip_agent_credits": false, "x.unset": null})
        );
        assert_eq!(gone, 4);
    }
}
