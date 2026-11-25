//! v25f (owner F8): the Add machine form's host suggestions and its Test. Both read only; neither writes machines.json.
use super::discovery::validate;
use crate::{
    api::{Reply, Response},
    sessions::Sessions,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    rc::Rc,
    sync::Mutex,
    time::Duration,
};

const MAX_FILE: u64 = 256 * 1024;
const MAX_FILES: usize = 64;
const MAX_NAMES: usize = 2000;
// Longer HostName or User values are dropped (the alias keeps its name): a crafted config must not make big copies.
const MAX_HOST: usize = 255;
const MAX_USER: usize = 64;

/// Text of a regular file up to `MAX_FILE` bytes; empty for anything else. A FIFO or device (an `Include` can name
/// one) would block a read, so the type is checked on the opened handle and the open itself never waits.
pub(super) fn read_text(path: &Path) -> String {
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

/// Ticket 1068: an alias with the `HostName` and `User` its config Host block names (first value wins, as in ssh).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alias {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

/// Host aliases from `<home>/.ssh/config` (and files it `Include`s, one level) and plain `known_hosts` names,
/// sorted, without patterns, hashed entries, names that are not a valid alias, or `listed` ones.
pub(crate) fn discover(home: &Path, listed: &[String]) -> Vec<Alias> {
    let ssh = home.join(".ssh");
    let mut found = BTreeMap::new();
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
            add(&mut found, name);
        }
    }
    found
        .into_iter()
        .filter(|(a, _)| super::valid_alias(a).is_ok() && !listed.contains(a))
        .take(MAX_NAMES)
        .map(|(name, (host, user))| Alias {
            name,
            host: host.map(|v| v.to_string()),
            user: user.map(|v| v.to_string()),
        })
        .collect()
}
// One shared value per config line, not one copy per name of its Host block.
type Found = BTreeMap<String, (Option<Rc<str>>, Option<Rc<str>>)>;
/// Keeps a valid name; stops collecting new names at `MAX_NAMES`, before any value is attached.
fn add(found: &mut Found, name: &str) {
    if found.len() < MAX_NAMES && super::valid_alias(name).is_ok() {
        found.entry(name.to_string()).or_default();
    }
}
/// `Key value…` or `Key=value…` of one config line.
fn split_line(line: &str) -> Option<(&str, &str)> {
    let (key, rest) = line
        .trim()
        .split_once(|c: char| c.is_whitespace() || c == '=')?;
    Some((
        key,
        rest.trim_start_matches(|c: char| c.is_whitespace() || c == '='),
    ))
}
/// Values of every `keyword` line (`Key value…` or `Key=value…`, any case), split on whitespace.
pub(super) fn directives<'a>(text: &'a str, keyword: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    for (key, rest) in text.lines().filter_map(split_line) {
        if key.eq_ignore_ascii_case(keyword) {
            out.extend(rest.split_whitespace());
        }
    }
    out
}
fn hosts(text: &str, found: &mut Found) {
    // The names of the Host line whose block the next HostName and User lines belong to.
    let mut block: Vec<&str> = vec![];
    for (key, rest) in text.lines().filter_map(split_line) {
        if key.eq_ignore_ascii_case("host") {
            block = rest
                .split_whitespace()
                .filter(|n| !n.contains(['*', '?', '!']))
                .take(MAX_NAMES)
                .collect();
            for name in &block {
                add(found, name);
            }
        } else if key.eq_ignore_ascii_case("match") {
            block.clear();
        } else if key.eq_ignore_ascii_case("hostname") || key.eq_ignore_ascii_case("user") {
            let is_user = key.len() == 4;
            let limit = if is_user { MAX_USER } else { MAX_HOST };
            let value: Option<Rc<str>> = rest
                .split_whitespace()
                .next()
                .filter(|v| v.len() <= limit)
                .map(Rc::from);
            let Some(value) = value else { continue };
            for name in &block {
                let Some((host, user)) = found.get_mut(*name) else {
                    continue;
                };
                let slot = if is_user { user } else { host };
                slot.get_or_insert_with(|| Rc::clone(&value));
            }
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
/// The saved aliases: machines.json and settings.json machines.
pub(crate) fn listed(
    registry: &Mutex<Sessions>,
    nunchiro_home: &Path,
) -> Result<Vec<String>, String> {
    Ok(registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .remote_aliases(super::known(nunchiro_home)?))
}
pub(crate) fn reply(registry: &Mutex<Sessions>, nunchiro_home: &Path) -> Response {
    let listed = listed(registry, nunchiro_home)?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    Ok(Reply::MachineAliases {
        aliases: discover(&home, &listed),
    })
}
/// One batch-mode `ssh … true`: `error` is ssh's last stderr line, none when it connected.
pub(crate) fn probe(host: &str, user: Option<&str>, port: Option<u32>) -> Response {
    probe_with(host, user, port, None)
}
/// Ticket 1050: `known`, a Nunchiro-owned known_hosts a link's Test wrote, is read beside the user's own two files.
pub(crate) fn probe_with(
    host: &str,
    user: Option<&str>,
    port: Option<u32>,
    known: Option<&Path>,
) -> Response {
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
    if let Some(known) = known {
        command.args(["-o", &super::discovery::known_hosts_option(known)?]);
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
    fn names(h: &Path, listed: &[String]) -> Vec<String> {
        discover(h, listed).into_iter().map(|a| a.name).collect()
    }
    #[test]
    fn alias_carries_hostname_and_user_from_its_block_and_includes() {
        let h = home("login");
        fs::write(
            h.join(".ssh/config"),
            "Include config.d/*\nHost macbook\n  HostName Adas-MacBook-Pro.local\n  User me\n  User other\nHost bare\nMatch host x\n  User no\n",
        )
        .unwrap();
        fs::write(
            h.join(".ssh/config.d/w"),
            "Host two names\n  hostname=w.local\n",
        )
        .unwrap();
        let a = |name: &str, host: Option<&str>, user: Option<&str>| Alias {
            name: name.into(),
            host: host.map(Into::into),
            user: user.map(Into::into),
        };
        assert_eq!(
            discover(&h, &[]),
            [
                a("bare", None, None),
                a("macbook", Some("Adas-MacBook-Pro.local"), Some("me")),
                a("names", Some("w.local"), None),
                a("two", Some("w.local"), None),
            ]
        );
        let _ = fs::remove_dir_all(&h);
    }
    #[test]
    fn many_names_and_one_huge_hostname_stay_bounded() {
        let h = home("huge");
        let names: String = (0..MAX_NAMES + 500).map(|i| format!(" n{i}")).collect();
        let long = "h".repeat(131_072);
        fs::write(
            h.join(".ssh/config"),
            format!(
                "Host{names}\n  HostName {long}\n  User {}\n",
                "u".repeat(65)
            ),
        )
        .unwrap();
        let found = discover(&h, &[]);
        assert_eq!(found.len(), MAX_NAMES);
        assert!(found.iter().all(|a| a.host.is_none() && a.user.is_none()));
        let _ = fs::remove_dir_all(&h);
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
            names(&h, &[]),
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
        assert_eq!(names(&h, &[]), ["10.0.0.9", "box.local", "nas"]);
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
        assert_eq!(names(&h, &["mini".into()]), ["studio"]);
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
        std::thread::spawn(move || tx.send(names(&dir, &[])).unwrap());
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
