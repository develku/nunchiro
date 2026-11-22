//! `nunchiro widget allow <name> --read|--act`: the CLI side of the permission sheet (ticket v1b-14).
//! `nunchiro widget new <name>`: a starter script widget (ticket v1b-19).
use nunchiro_core::{api::*, approval::Level};
use std::path::Path;

pub fn run(
    home: &Path,
    args: &[String],
    ensure_core: fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    // v1b-19: only creates files, so it works inside a session; the widget starts unapproved.
    // shortcut: no `author` (shows "unknown"); the core has no session-token request that names the caller,
    // and the brief forbids taking it from an environment variable. Upgrade when such a request exists.
    if let ["new", name] = words.as_slice() {
        let dir = nunchiro_core::widgets::scaffold(home, name, None)?;
        println!(
            "created {}: edit widget.sh, then allow it in the window (or `nunchiro widget allow {name} --read`)",
            dir.display()
        );
        return Ok(());
    }
    let (name, level) = match words.as_slice() {
        ["allow", name, "--read"] => (*name, Level::Read),
        ["allow", name, "--act"] => (*name, Level::Act),
        _ => {
            return Err(
                "usage: nunchiro widget new <name> | nunchiro widget allow <name> --read|--act"
                    .into(),
            );
        }
    };
    // v1a-23 (needs 47): from inside a session the core does not approve; it raises one waiting item for the owner
    // (an agent must not approve what it asks the user to approve).
    ensure_core(home)?;
    let Reply::ApprovalStatus { view } =
        super::call(home, Request::ApprovalStatus { name: name.into() })?
    else {
        return Err("unexpected reply".into());
    };
    let view = match super::call(
        home,
        Request::ApprovalGrant {
            name: name.into(),
            level,
            hash: view.hash,
        },
    )? {
        Reply::ApprovalStatus { view } => view,
        Reply::Waiting { .. } => {
            println!("{}", crate::WAITING);
            return Ok(());
        }
        _ => return Err("unexpected reply".into()),
    };
    let m = &view.manifest;
    let what = if m.entry.is_empty() {
        m.command.join(" ")
    } else {
        m.entry.clone()
    };
    println!(
        "allowed {} for {name} ({what}; network: {})",
        format!("{level:?}").to_lowercase(),
        if m.network.is_empty() {
            "none".into()
        } else {
            m.network.join(", ")
        }
    );
    Ok(())
}
