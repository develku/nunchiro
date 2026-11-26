//! `core.start.json`: this core's executable and start environment, kept for the next `serve restart`.
use super::*;
// v1a-23 r2 (S3): this core's executable and start environment (`core.start.json`, 0600), so a `serve restart` asked
// from inside a session starts the next core from them, not from the asker's environment. The dynamic loader's
// `DYLD_*`, the per-session names and the launching Claude Code / Codex session's variables (its messaging token
// among them: a child has `NUNCHIRO_HOME`, and the file outlives that session) are never kept. Ticket 457: a secret
// variable keeps only its name here (`secrets`); its value goes to the keychain (`start_secrets`).
pub(super) fn record_start(home: &Path) -> Result<(), String> {
    let (secrets, env): (Vec<_>, Vec<_>) = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| {
            !k.starts_with("DYLD_")
                && !crate::sessions::is_parent_session_env(std::ffi::OsStr::new(k))
                && ![
                    "NUNCHIRO_TOKEN",
                    "NUNCHIRO_SESSION",
                    "NUNCHIRO_RESTARTER",
                    "NUNCHIRO_MACHINE",
                    crate::start_secrets::UNREAD,
                ]
                .contains(&k.as_str())
        })
        // Ticket 1024: a URL with a password is kept like a secret name, so no file under the home holds it.
        .partition(|(k, v)| {
            crate::start_secrets::is_secret(k) || crate::start_secrets::has_url_password(v)
        });
    // Ticket 1009 round 6: started without secrets the record named (the CLI could not read them): the earlier names
    // and item stay for a start that can, and nothing here replaces or deletes them.
    let unread = std::env::var_os(crate::start_secrets::UNREAD).is_some();
    let earlier: Option<serde_json::Value> = unread
        .then(|| crate::start_secrets::read_record(&home.join("core.start.json")))
        .flatten()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let kept: Vec<String> = earlier
        .as_ref()
        .and_then(|v| {
            v["secrets"].as_array().map(|a| {
                a.iter()
                    .filter_map(|n| n.as_str().map(String::from))
                    .collect()
            })
        })
        .unwrap_or_default();
    let env: serde_json::Map<String, serde_json::Value> =
        env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let mut secrets: std::collections::BTreeMap<String, String> = secrets.into_iter().collect();
    // Round 9: an unread start keeps the earlier generation with the earlier item; any other start takes a new one.
    let generation = match &earlier {
        Some(v) => v["secrets_gen"].as_str().map(String::from),
        None => (!secrets.is_empty()).then(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            format!("{nanos:x}-{:x}", std::process::id())
        }),
    };
    // Ticket 1024 (Codex round 9 NOTE, by design): a record from before generations restores nothing, and no later
    // restart from it will. One line per such start (names are counted, never written here).
    if unread && !kept.is_empty() && generation.is_none() {
        eprintln!(
            "start secrets: the restart record has no generation (its secrets date from a build before generations), so this core started without {} secret variable(s); start the core once from a terminal that has them",
            kept.len()
        );
    }
    let mut names: Vec<&String> = secrets.keys().chain(&kept).collect();
    names.sort();
    names.dedup();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let build = BUILD.get();
    let bytes = serde_json::to_vec(
        &serde_json::json!({"exe": exe, "env": env, "secrets": names, "build": build, "commit": COMMIT.get(), "secrets_gen": generation}),
    )
    .map_err(|e| e.to_string())?;
    store::atomic_write(&home.join("core.start.json"), &bytes)?;
    // Off the start path: a locked keychain may wait on a dialog. Without secrets, an earlier start's item goes.
    // Ticket 1033: a temp (test) home writes no item to the login keychain, only to one `NUNCHIRO_KEYCHAIN` names.
    if let Some(keychain) = crate::start_secrets::keychain(|k| std::env::var(k).ok())
        && !unread
        && (std::env::var_os("NUNCHIRO_KEYCHAIN").is_some()
            || !crate::start_secrets::temp_home(home))
    {
        let home = home.to_path_buf();
        if let Some(g) = generation {
            secrets.insert(crate::start_secrets::GEN.to_string(), g);
        }
        thread::spawn(move || {
            if secrets.is_empty() {
                crate::start_secrets::forget(&keychain, &home);
            } else if let Err(e) = crate::start_secrets::store(&keychain, &home, &secrets) {
                // Round 6: the earlier item stays (`store` replaces it only after the new one reads back, and
                // drops it itself when these values cannot fit one item). Round 9: its generation no longer matches
                // the record, so no restart applies it.
                eprintln!(
                    "start secrets not kept in the keychain ({e}); a restart from a session starts without them"
                );
            }
        });
    }
    Ok(())
}
