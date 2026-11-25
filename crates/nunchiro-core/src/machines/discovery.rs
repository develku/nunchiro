//! Machine settings use SSH only for read-only configuration and known-host discovery.
use super::{Channel, Config};
use crate::{
    api::{Reply, Response},
    sessions::Sessions,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::OsString, path::Path, sync::Mutex, time::Duration};

pub(crate) fn validate(host: &str, user: Option<&str>, port: Option<u32>) -> Result<(), String> {
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 255
            && !s.starts_with('-')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
    };
    if !valid(host) || user.is_some_and(|u| !valid(u)) {
        return Err("invalid machine host or user".into());
    }
    if port.is_some_and(|p| !(1..=65535).contains(&p)) {
        return Err("invalid machine port (1-65535)".into());
    }
    Ok(())
}
pub(crate) fn options(home: &Path, alias: &str) -> Result<Vec<OsString>, String> {
    #[derive(Default, Deserialize)]
    struct Settings {
        #[serde(default)]
        machines: BTreeMap<String, Config>,
    }
    let config = match crate::store::read_settings(&home.join("settings.json")) {
        Ok(b) => serde_json::from_slice::<Settings>(&b)
            .map_err(|e| format!("invalid machines settings: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => return Err(e.to_string()),
    };
    let mut options = Vec::new();
    // Ticket 1050: a host key trusted from a share link; the user's ~/.ssh files are read too and never written.
    let known = super::share::known_hosts(home, alias);
    if known.exists() {
        options.extend(["-o".into(), known_hosts_option(&known)?.into()]);
    }
    if let Some(c) = config.machines.get(alias) {
        if let Some(host) = &c.host {
            validate(host, c.user.as_deref(), c.port)?;
        } else if c.user.is_some() || c.port.is_some() {
            validate(alias, c.user.as_deref(), c.port)?;
        }
        for (name, value) in [
            ("HostName", c.host.clone().filter(|h| h != alias)),
            ("User", c.user.clone()),
            ("Port", c.port.map(|p| p.to_string())),
        ] {
            if let Some(v) = value {
                options.extend(["-o".into(), format!("{name}={v}").into()]);
            }
        }
    }
    Ok(options)
}
/// UserKnownHostsFile replaces ssh's default list, so the user's two files stay first. ssh splits the value on
/// spaces: a path with one is refused rather than quoted.
pub(crate) fn known_hosts_option(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .filter(|p| !p.contains(char::is_whitespace) && !p.contains('"'));
    let path =
        path.ok_or("the Nunchiro home path has a space; a link's host key cannot be used")?;
    Ok(format!(
        "UserKnownHostsFile=~/.ssh/known_hosts ~/.ssh/known_hosts2 {path}"
    ))
}
/// What settings.json holds for the alias, without what `ssh -G` adds: the Edit form starts from these.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Saved {
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Details {
    pub machine: String,
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<u32>,
    pub keys: Vec<String>,
    pub fingerprint: Option<String>,
    pub channel: Option<Channel>,
    pub error: Option<String>,
    #[serde(default)]
    pub saved: Saved,
}
pub(super) fn read(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = crate::process::command(program);
    command.args(args);
    let output =
        super::transport::output(command, Duration::from_secs(3)).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("{program} discovery failed: {}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}
pub(crate) fn reply(registry: &Mutex<Sessions>, alias: Option<String>) -> Response {
    // Validate against the registry's listed aliases before spawning anything, then release its lock.
    let inputs = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .machine_details(alias)?;
    let mut machines = Vec::new();
    for (alias, c, channel) in inputs {
        let mut d = Details {
            saved: Saved {
                host: c.host.clone(),
                user: c.user.clone(),
                port: c.port,
            },
            machine: alias.clone(),
            host: c.host.filter(|host| host != &alias),
            user: c.user,
            port: c.port,
            keys: vec![],
            fingerprint: None,
            channel,
            error: None,
        };
        if let Err(error) = super::valid_alias(&alias).and_then(|()| {
            validate(
                d.host.as_deref().unwrap_or(&alias),
                d.user.as_deref(),
                d.port,
            )
        }) {
            d.error = Some(error);
            machines.push(d);
            continue;
        }
        match read("ssh", &["-G", &alias]) {
            Ok(text) => {
                for line in text.lines() {
                    let Some((key, value)) = line.split_once(char::is_whitespace) else {
                        continue;
                    };
                    let value = value.trim();
                    if value.is_empty() || value == "none" {
                        continue;
                    }
                    match key {
                        "hostname" if d.host.is_none() => d.host = Some(value.into()),
                        "user" if d.user.is_none() => d.user = Some(value.into()),
                        "port" if d.port.is_none() => {
                            d.port = value
                                .parse::<u32>()
                                .ok()
                                .filter(|p| (1..=65535).contains(p))
                        }
                        "identityfile" => d.keys.push(value.into()),
                        _ => {}
                    }
                }
                if let Some(host) = &d.host {
                    // OpenSSH indexes non-default ports as [host]:port. It reads known_hosts; it never adds a key.
                    let lookup = match d.port {
                        Some(p) if p != 22 => format!("[{host}]:{p}"),
                        _ => host.clone(),
                    };
                    if lookup.starts_with('-') || lookup.chars().any(char::is_control) {
                        d.error = Some("invalid discovered host".into());
                    } else {
                        match read("ssh-keygen", &["-lF", &lookup]) {
                            Ok(output) => {
                                d.fingerprint = output
                                    .lines()
                                    .filter(|l| !l.starts_with('#'))
                                    .find_map(|line| {
                                        let fields: Vec<_> = line.split_whitespace().collect();
                                        (fields.len() >= 2 && fields[1].starts_with("SHA256:"))
                                            .then(|| {
                                                format!(
                                                    "{}{}",
                                                    fields[1],
                                                    fields
                                                        .last()
                                                        .filter(|s| s.starts_with('('))
                                                        .map_or(String::new(), |s| format!(" {s}"))
                                                )
                                            })
                                    })
                            }
                            // Look v9 C1: `ssh-keygen -F` exits 1 for a host not in known_hosts yet. That is no
                            // fingerprint, not a failure; the row showed "ssh-keygen discovery failed: exit status: 1".
                            Err(e) if e.ends_with("exit status: 1") => {}
                            Err(e) => d.error = Some(e),
                        }
                    }
                }
            }
            Err(e) => d.error = Some(e),
        }
        machines.push(d);
    }
    Ok(Reply::MachineDetails { machines })
}
