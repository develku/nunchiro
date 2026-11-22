//! v25f (owner F8): the Add machine form's host suggestions and its Test. Both read only; neither writes machines.json.
use super::discovery::validate;
use crate::{
    api::{Reply, Response},
    sessions::Sessions,
};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};

const MAX_FILE: u64 = 256 * 1024;
const MAX_FILES: usize = 64;
const MAX_NAMES: usize = 2000;

/// Text of a regular file up to `MAX_FILE` bytes; empty for anything else. A FIFO or device (an `Include` can name
/// one) would block a read, so the type is checked on the opened handle and the open itself never waits.
fn read_text(path: &Path) -> String {
    let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
    else {
        return String::new();
    };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = file.take(MAX_FILE).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Host aliases from `<home>/.ssh/config` (and files it `Include`s, one level) and plain `known_hosts` names,
/// sorted, without patterns, hashed entries, names that are not a valid alias, or `listed` ones.
pub(crate) fn discover(home: &Path, listed: &[String]) -> Vec<String> {
    let ssh = home.join(".ssh");
    let mut found = BTreeSet::new();
    let config = read_text(&ssh.join("config"));
    hosts(&config, &mut found);
    // MAX_FILES is a total across every Include pattern, not per pattern.
    for file in directives(&config, "include")
        .into_iter()
        .flat_map(|pattern| include(home, &ssh, pattern))
        .take(MAX_FILES)
    {
        hosts(&read_text(&file), &mut found);
    }
    for line in read_text(&ssh.join("known_hosts")).lines() {
        let line = line.trim();
        let mut fields = line.split_whitespace();
        let first = fields.next().unwrap_or("");
        // `@cert-authority`/`@revoked` lines carry the host field second.
        let names = if first.starts_with('@') {
            fields.next().unwrap_or("")
        } else {
            first
        };
        if names.starts_with('|') || names.starts_with('#') {
            continue;
        }
        for name in names.split(',') {
            // `[host]:port` names the host; the port is the user's to add.
            let name = name
                .strip_prefix('[')
                .and_then(|n| n.split_once("]:"))
                .map_or(name, |(host, _)| host);
            found.insert(name.to_string());
        }
    }
    found
        .into_iter()
        .filter(|a| super::valid_alias(a).is_ok() && !listed.contains(a))
        .take(MAX_NAMES)
        .collect()
}
/// Values of every `keyword` line (`Key value…` or `Key=value…`, any case), split on whitespace.
fn directives<'a>(text: &'a str, keyword: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((key, rest)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        if key.eq_ignore_ascii_case(keyword) {
            out.extend(
                rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                    .split_whitespace(),
            );
        }
    }
    out
}
fn hosts(text: &str, found: &mut BTreeSet<String>) {
    for name in directives(text, "host") {
        if !name.contains(['*', '?', '!']) {
            found.insert(name.to_string());
        }
    }
}
/// The files an `Include` names: `~/` from home, relative from `~/.ssh`.
// shortcut: a `*` glob only in the last path part (`config.d/*`), as ssh configs use it; a full glob if one needs more.
fn include(home: &Path, ssh: &Path, pattern: &str) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => ssh.join(pattern),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let Some((before, after)) = name.split_once('*') else {
        return vec![path];
    };
    let Some(dir) = path.parent().filter(|d| !d.to_string_lossy().contains('*')) else {
        return vec![];
    };
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.len() >= before.len() + after.len() && n.starts_with(before) && n.ends_with(after)
            })
        })
        .collect();
    files.sort();
    files
}
pub(crate) fn reply(registry: &Mutex<Sessions>, nunchiro_home: &Path) -> Response {
    let listed = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .remote_aliases(super::known(nunchiro_home)?);
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    Ok(Reply::MachineAliases {
        aliases: discover(&home, &listed),
    })
}
/// One batch-mode `ssh … true`: `error` is ssh's last stderr line, none when it connected.
pub(crate) fn probe(host: &str, user: Option<&str>, port: Option<u32>) -> Response {
    validate(host, user, port)?;
    let mut command =
        crate::process::command(std::env::var_os("NUNCHIRO_SSH").unwrap_or_else(|| "ssh".into()));
    // The flags of channel.rs `ssh_args`, with a longer timeout: a person waits on this one.
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=yes",
    ]);
    if let Some(user) = user {
        command.args(["-o", &format!("User={user}")]);
    }
    if let Some(port) = port {
        command.args(["-o", &format!("Port={port}")]);
    }
    command.args([host, "true"]);
    command.stdin(Stdio::null());
    let output = super::transport::output(command, Duration::from_secs(12))?;
    let error = (!output.status.success()).then(|| {
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .map_or_else(|| format!("ssh failed: {}", output.status), str::to_string)
    });
    Ok(Reply::MachineProbe { error })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn home(tag: &str) -> PathBuf {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("aliases-{tag}-{}", crate::store::new_id().unwrap()));
        fs::create_dir_all(home.join(".ssh/config.d")).unwrap();
        home
    }
    #[test]
    fn config_hosts_skip_patterns_and_follow_include() {
        let h = home("config");
        fs::write(
            h.join(".ssh/config"),
            "Include config.d/*\nInclude ~/extra\nHost mini studio\n  HostName 10.0.0.2\nhost=lab\nHost *\nHost *.corp !bad dev?\nMatch host x\n",
        )
        .unwrap();
        fs::write(
            h.join(".ssh/config.d/work"),
            "Host work-box\nInclude deeper\n",
        )
        .unwrap();
        fs::write(h.join(".ssh/deeper"), "Host too-deep\n").unwrap();
        fs::write(h.join("extra"), "Host extra-box\n").unwrap();
        assert_eq!(
            discover(&h, &[]),
            ["extra-box", "lab", "mini", "studio", "work-box"]
        );
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn known_hosts_plain_names_only() {
        let h = home("known");
        fs::write(
            h.join(".ssh/known_hosts"),
            "# comment\n|1|abc=|def= ssh-ed25519 AAAA\nbox.local,10.0.0.9 ssh-ed25519 AAAA\n[nas]:2222 ssh-rsa AAAA\n@cert-authority *.corp ssh-rsa AAAA\nfe80::1 ssh-ed25519 AAAA\n",
        )
        .unwrap();
        assert_eq!(discover(&h, &[]), ["10.0.0.9", "box.local", "nas"]);
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn already_added_removed_and_deduplicated() {
        let h = home("listed");
        fs::write(h.join(".ssh/config"), "Host mini studio\n").unwrap();
        fs::write(
            h.join(".ssh/known_hosts"),
            "mini ssh-ed25519 AAAA\nstudio ssh-ed25519 AAAA\n",
        )
        .unwrap();
        assert_eq!(discover(&h, &["mini".into()]), ["studio"]);
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn include_of_a_fifo_does_not_block_and_big_files_are_capped() {
        let h = home("fifo");
        let fifo = h.join(".ssh/pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        fs::write(h.join(".ssh/config"), "Include pipe\nHost after\n").unwrap();
        // A hang here is the failure: run the discovery on a thread and wait for it.
        let (tx, rx) = std::sync::mpsc::channel();
        let dir = h.clone();
        std::thread::spawn(move || tx.send(discover(&dir, &[])).unwrap());
        let found = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("blocked on a FIFO");
        assert_eq!(found, ["after"]);
        let big = format!("{}Host past-cap\n", "# pad\n".repeat(60_000));
        fs::write(h.join(".ssh/config"), big).unwrap();
        assert!(discover(&h, &[]).is_empty());
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn include_file_cap_is_total_across_patterns() {
        let h = home("cap");
        let lines: String = (0..MAX_FILES + 1)
            .map(|i| {
                fs::write(h.join(format!(".ssh/f{i}")), format!("Host h{i:03}\n")).unwrap();
                format!("Include f{i}\n")
            })
            .collect();
        fs::write(h.join(".ssh/config"), lines).unwrap();
        assert_eq!(discover(&h, &[]).len(), MAX_FILES);
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn missing_ssh_folder_is_empty() {
        let h = home("none");
        fs::remove_dir_all(h.join(".ssh")).unwrap();
        assert!(discover(&h, &[]).is_empty());
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn probe_refuses_bad_input_before_ssh() {
        assert!(probe("-oProxyCommand=x", None, None).is_err());
        assert!(probe("mini", Some("a b"), None).is_err());
        assert!(probe("mini", None, Some(70000)).is_err());
    }
}
