//! Ticket 1050: a machine share link that carries no secret: host, user, port, the host-key fingerprint, a label.
//! Trust still rests on the user's SSH keys; the link only pins which host key Test may trust for one alias.
use super::{discovery, valid_alias};
use crate::{
    api::{Reply, Response},
    sessions::Sessions,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};

const PREFIX: &str = "nunchiro-machine:v1?";
const MAX_LINK: usize = 1024;

#[derive(Debug, PartialEq)]
pub(crate) struct Link {
    pub host: String,
    pub user: String,
    pub port: u32,
    pub hostkey: String,
    pub label: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Share {
    pub host: String,
    pub link: String,
}

// No percent-decoding anywhere: every allowed character is plain, so a value is exactly what ssh gets.
fn host(s: &str) -> Result<(), String> {
    let ok = (1..=253).contains(&s.len())
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.".contains(&b));
    ok.then_some(())
        .ok_or_else(|| "invalid host in link".into())
}
fn user(s: &str) -> Result<(), String> {
    let ok = (1..=64).contains(&s.len())
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    ok.then_some(())
        .ok_or_else(|| "invalid user in link".into())
}
fn port(p: u32) -> Result<(), String> {
    (1..=65535)
        .contains(&p)
        .then_some(())
        .ok_or_else(|| "invalid port in link (1-65535)".into())
}
fn fingerprint(s: &str) -> Result<(), String> {
    let ok = s.strip_prefix("SHA256:").is_some_and(|b| {
        b.len() == 43
            && b.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/".contains(&c))
    });
    ok.then_some(())
        .ok_or_else(|| "invalid host key fingerprint in link".into())
}

pub(crate) fn parse(text: &str) -> Result<Link, String> {
    let text = text.trim();
    if text.len() > MAX_LINK {
        return Err("link is longer than 1 KB".into());
    }
    let Some(query) = text.strip_prefix(PREFIX) else {
        return Err(if text.starts_with("nunchiro-machine:") {
            "unsupported machine link version".into()
        } else {
            "not a Nunchiro machine link".into()
        });
    };
    let mut fields: [Option<&str>; 5] = [None; 5];
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or("malformed machine link")?;
        let at = ["host", "user", "port", "hostkey", "label"]
            .iter()
            .position(|k| *k == key)
            .ok_or_else(|| format!("unknown field in link: {key}"))?;
        if fields[at].replace(value).is_some() {
            return Err(format!("duplicate field in link: {key}"));
        }
    }
    let [Some(h), Some(u), Some(p), Some(key), label] = fields else {
        return Err("link is missing host, user, port or hostkey".into());
    };
    // u32::from_str takes a leading "+": digits only.
    let p = (!p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
        .then(|| p.parse::<u32>().ok())
        .flatten()
        .ok_or("invalid port in link (1-65535)")?;
    host(h)?;
    user(u)?;
    port(p)?;
    fingerprint(key)?;
    if let Some(l) = label {
        valid_alias(l).map_err(|_| "invalid label in link")?;
    }
    Ok(Link {
        host: h.into(),
        user: u.into(),
        port: p,
        hostkey: key.into(),
        label: label.map(String::from),
    })
}
pub(crate) fn link(l: &Link) -> String {
    let mut out = format!(
        "{PREFIX}host={}&user={}&port={}&hostkey={}",
        l.host, l.user, l.port, l.hostkey
    );
    if let Some(label) = &l.label {
        out.push_str(&format!("&label={label}"));
    }
    out
}

/// First Port line sshd reads: macOS's sshd_config starts with "Include /etc/ssh/sshd_config.d/*", so those first.
// shortcut: only a Port line in those files counts (no Match blocks, no -p in the launchd plist); sshd -T needs root.
fn sshd_port(etc: &Path) -> u32 {
    let mut files: Vec<PathBuf> = std::fs::read_dir(etc.join("sshd_config.d"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .collect();
    files.sort();
    files.push(etc.join("sshd_config"));
    files
        .iter()
        .flat_map(|f| {
            super::aliases::directives(&super::aliases::read_text(f), "port")
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .find_map(|p| p.parse().ok().filter(|p| port(*p).is_ok()))
        .unwrap_or(22)
}
fn output(program: &str, args: &[&str]) -> Option<String> {
    discovery::read(program, args).ok()
}
/// Share this Mac: one link per name it answers to. No network scan: the Bonjour name, and Tailscale's when it runs.
pub(crate) fn reply() -> Response {
    let port = sshd_port(Path::new("/etc/ssh"));
    let addr = SocketAddr::from(([127, 0, 0, 1], port as u16));
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_err() {
        return Ok(Reply::MachineShare {
            remote_login: false,
            shares: vec![],
        });
    }
    let name = std::env::var("USER").map_err(|_| "USER is not set")?;
    user(&name)?;
    let key = output("ssh-keygen", &["-lf", "/etc/ssh/ssh_host_ed25519_key.pub"])
        .and_then(|t| t.split_whitespace().nth(1).map(String::from))
        .ok_or("cannot read this Mac's ed25519 host key")?;
    fingerprint(&key)?;
    let local = output("scutil", &["--get", "LocalHostName"]).map(|n| n.trim().to_string());
    let mut hosts: Vec<String> = local.iter().map(|n| format!("{n}.local")).collect();
    if let Some(dns) = output("tailscale", &["status", "--json"])
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v["Self"]["DNSName"]
                .as_str()
                .map(|n| n.trim_end_matches('.').to_string())
        })
    {
        hosts.push(dns);
    }
    let label = local.filter(|l| valid_alias(l).is_ok());
    let shares = hosts
        .into_iter()
        .filter(|h| host(h).is_ok())
        .map(|h| Share {
            link: link(&Link {
                host: h.clone(),
                user: name.clone(),
                port,
                hostkey: key.clone(),
                label: label.clone(),
            }),
            host: h,
        })
        .collect();
    Ok(Reply::MachineShare {
        remote_login: true,
        shares,
    })
}

/// The Nunchiro-owned known_hosts for one alias. channel.rs and Test pass it as an extra UserKnownHostsFile.
pub(crate) fn known_hosts(home: &Path, alias: &str) -> PathBuf {
    home.join("known_hosts.d").join(alias)
}
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        acc = (acc << 6) | B64.iter().position(|&b| b == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
fn b64_encode(bytes: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(B64[(acc >> bits) as usize & 63] as char);
        }
    }
    if bits > 0 {
        out.push(B64[(acc << (6 - bits)) as usize & 63] as char);
    }
    out
}
/// What "ssh-keygen -l" prints for a public key: SHA-256 of the key blob, unpadded base64.
fn key_fingerprint(blob_b64: &str) -> Option<String> {
    let blob = b64_decode(blob_b64)?;
    Some(format!("SHA256:{}", b64_encode(&Sha256::digest(&blob))))
}
/// The ed25519 key in ssh-keyscan's output for name (host, or [host]:port): equal to want writes it as the alias'
/// one known_hosts line; different writes nothing. Returns the live fingerprint and whether it was trusted.
pub(crate) fn record(
    home: &Path,
    alias: &str,
    name: &str,
    scanned: &str,
    want: &str,
) -> Result<(String, bool), String> {
    // ssh-keyscan prints the host name in lower case; macOS local names are mixed case (adas-Mac-mini.local).
    let (name, blob, live) = scanned
        .lines()
        .filter_map(|l| match l.split_whitespace().collect::<Vec<_>>()[..] {
            [n, "ssh-ed25519", blob, ..] if n.eq_ignore_ascii_case(name) => {
                Some((n, blob, key_fingerprint(blob)?))
            }
            _ => None,
        })
        .next()
        .ok_or_else(|| format!("{name} sent no ed25519 host key"))?;
    if live != want {
        return Ok((live, false));
    }
    let dir = home.join("known_hosts.d");
    crate::store::private_dir(&dir)?;
    crate::store::write_capped(
        &known_hosts(home, alias),
        format!("{name} ssh-ed25519 {blob}\n").as_bytes(),
        crate::store::READ_MAX,
    )?;
    Ok((live, true))
}
/// A link may never write into a saved machine's pin (its label picks the alias). APFS is case-insensitive
/// (known_hosts.d/Studio is known_hosts.d/studio), so the check is as well.
fn refuse_saved(listed: &[String], alias: &str) -> Result<(), String> {
    if listed.iter().any(|a| a.eq_ignore_ascii_case(alias)) {
        return Err(format!(
            "a saved machine is already named {alias}; forget it first or use a link with another label"
        ));
    }
    Ok(())
}
/// record() under the registry lock, the lock Add and Forget hold while they save: the alias is checked again there,
/// so a Test whose ssh-keyscan ended after an Add of the same alias never replaces that machine's pin.
pub(crate) fn commit(
    registry: &Mutex<Sessions>,
    home: &Path,
    alias: &str,
    name: &str,
    scanned: &str,
    want: &str,
) -> Result<(String, bool), String> {
    let s = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    refuse_saved(&s.remote_aliases(super::known(home)?), alias)?;
    record(home, alias, name, scanned, want)
}
/// Test of a pasted link: ssh-keyscan (no login) against the link's fingerprint; equal trusts it and runs the usual
/// batch-mode probe with that file; different refuses with both fingerprints and runs nothing else.
/// A saved alias is refused before any process, and again under the lock before the write (commit).
pub(crate) fn trust(registry: &Mutex<Sessions>, home: &Path, alias: &str, text: &str) -> Response {
    valid_alias(alias)?;
    refuse_saved(&super::aliases::listed(registry, home)?, alias)?;
    let Link {
        host: h,
        user: u,
        port: p,
        hostkey: key,
        ..
    } = parse(text)?;
    let h = h.as_str();
    let mut command = crate::process::command(
        std::env::var_os("NUNCHIRO_SSH_KEYSCAN").unwrap_or_else(|| "ssh-keyscan".into()),
    );
    command
        .args(["-T", "6", "-t", "ed25519", "-p", &p.to_string(), "--", h])
        .stdin(Stdio::null());
    let scan = super::transport::output(command, Duration::from_secs(10))?;
    let name = if p == 22 {
        h.to_string()
    } else {
        format!("[{h}]:{p}")
    };
    let (live, trusted) = commit(
        registry,
        home,
        alias,
        &name,
        &String::from_utf8_lossy(&scan.stdout),
        &key,
    )?;
    let error = if trusted {
        match super::aliases::probe_with(h, Some(&u), Some(p), Some(&known_hosts(home, alias)))? {
            Reply::MachineProbe { error } => error,
            _ => None,
        }
    } else {
        None
    };
    Ok(Reply::MachineTrust {
        live,
        trusted,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    fn good() -> Link {
        Link {
            host: "studio.local".into(),
            user: "me".into(),
            port: 2222,
            hostkey: KEY.into(),
            label: Some("studio".into()),
        }
    }
    #[test]
    fn link_round_trips_and_holds_only_its_five_fields() {
        let text = link(&good());
        assert_eq!(
            text,
            format!(
                "nunchiro-machine:v1?host=studio.local&user=me&port=2222&hostkey={KEY}&label=studio"
            )
        );
        assert_eq!(parse(&text).unwrap(), good());
        let bare = Link {
            label: None,
            ..good()
        };
        assert_eq!(parse(&link(&bare)).unwrap(), bare);
    }
    #[test]
    fn parser_refuses_bad_links() {
        let base = format!("host=h.local&user=me&port=22&hostkey={KEY}");
        let bad = |q: String| parse(&format!("nunchiro-machine:v1?{q}"));
        assert!(
            parse(&format!("nunchiro-machine:v2?{base}"))
                .unwrap_err()
                .contains("version")
        );
        assert!(parse(&format!("https://x?{base}")).is_err());
        for missing in ["host", "user", "port", "hostkey"] {
            let q: Vec<_> = base
                .split('&')
                .filter(|p| !p.starts_with(missing))
                .collect();
            assert!(bad(q.join("&")).is_err(), "{missing}");
        }
        for h in ["-oProxyCommand=x", "a b", "a;b", "a_b", "h$(id)", "", "a:b"] {
            assert!(bad(base.replace("h.local", h)).is_err(), "host {h:?}");
        }
        for u in ["-l", "a b", "a;b", "a@b", "`id`", ""] {
            assert!(
                bad(base.replace("user=me", &format!("user={u}"))).is_err(),
                "user {u:?}"
            );
        }
        for p in ["0", "65536", "-1", "+22", "22a", "", "0000022"] {
            assert!(
                bad(base.replace("port=22", &format!("port={p}"))).is_err(),
                "port {p:?}"
            );
        }
        for k in [
            "MD5:aa",
            "SHA256:short",
            &format!("{KEY}A"),
            &format!("{}=", &KEY[..49]),
            &KEY.replace('a', "-"),
        ] {
            assert!(bad(base.replace(KEY, k)).is_err(), "key {k:?}");
        }
        assert!(
            bad(format!("{base}&host=x"))
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(
            bad(format!("{base}&label=a&label=b"))
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(bad(format!("{base}&token=1")).is_err());
        assert!(bad(format!("{base}&label=-x")).is_err());
        assert!(
            bad(format!("{base}&label={}", "a".repeat(1000)))
                .unwrap_err()
                .contains("1 KB")
        );
        assert!(bad(base.clone()).is_ok());
    }
    #[test]
    fn fingerprint_matches_ssh_keygen() {
        // "ssh-keygen -lf" of this ed25519 public key prints this fingerprint.
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        assert_eq!(
            key_fingerprint(blob).unwrap(),
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        );
    }
    fn home(tag: &str) -> PathBuf {
        let h = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("share-{tag}-{}", crate::store::new_id().unwrap()));
        std::fs::create_dir_all(h.join("user/.ssh")).unwrap();
        h
    }
    #[test]
    fn equal_fingerprint_writes_one_line_and_different_writes_nothing() {
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let want = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
        let scanned = format!(
            "# [studio.local]:2222 SSH-2.0-OpenSSH_9.9\n[studio.local]:2222 ssh-rsa AAAAB3\n[studio.local]:2222 ssh-ed25519 {blob}\n"
        );
        let h = home("trust");
        let nh = h.join("nunchiro");
        let file = known_hosts(&nh, "studio");
        // Different: both values come back, nothing is written.
        let (live, trusted) = record(&nh, "studio", "[studio.local]:2222", &scanned, KEY).unwrap();
        assert_eq!((live.as_str(), trusted), (want, false));
        assert!(!nh.exists());
        // A key for another name is not this host's key.
        assert!(record(&nh, "studio", "other.local", &scanned, want).is_err());
        // ssh-keyscan lower-cases the name: a mixed-case host from the link still matches, written as scanned.
        let (_, trusted) = record(&nh, "studio", "[Studio.Local]:2222", &scanned, want).unwrap();
        assert!(trusted);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("[studio.local]:2222 ssh-ed25519 {blob}\n")
        );
        // Only that file under the Nunchiro home; the user's ~/.ssh stays empty.
        assert_eq!(
            std::fs::read_dir(nh.join("known_hosts.d")).unwrap().count(),
            1
        );
        assert_eq!(std::fs::read_dir(h.join("user/.ssh")).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&h);
    }
    /// Threat 1: the link's values reach ssh only as whole -o arguments before "--"; the remote command stays fixed,
    /// and the trusted file joins the user's own known_hosts without loosening BatchMode or StrictHostKeyChecking.
    #[test]
    fn argv_of_a_linked_machine_keeps_strict_checks_and_adds_its_known_hosts() {
        let h = home("argv");
        std::fs::write(
            h.join("settings.json"),
            r#"{"machines":{"studio":{"host":"studio.local","user":"me","port":2222}}}"#,
        )
        .unwrap();
        let file = known_hosts(&h, "studio");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "[studio.local]:2222 ssh-ed25519 AAAA
",
        )
        .unwrap();
        let args: Vec<String> = super::super::channel::remote_argv(&h, "studio", None)
            .unwrap()
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        let known = format!(
            "UserKnownHostsFile=~/.ssh/known_hosts ~/.ssh/known_hosts2 {}",
            file.display()
        );
        for want in [
            known.as_str(),
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "HostName=studio.local",
            "User=me",
            "Port=2222",
        ] {
            let at = args
                .iter()
                .position(|a| a == want)
                .unwrap_or_else(|| panic!("{want} in {args:?}"));
            assert_eq!(args[at - 1], "-o");
        }
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash + 1..dash + 2], ["studio"]);
        assert_eq!(args.len(), dash + 3);
        assert!(!args[dash + 2].contains("studio") && !args[dash + 2].contains("me"));
        // Without the file, no extra option: a machine added by hand reads only the user's files.
        std::fs::remove_file(&file).unwrap();
        let plain = super::super::channel::remote_argv(&h, "studio", None).unwrap();
        assert!(
            !plain
                .iter()
                .any(|a| a.to_string_lossy().contains("UserKnownHostsFile"))
        );
        let _ = std::fs::remove_dir_all(&h);
    }
    #[test]
    fn a_paired_browser_is_refused_share_and_trust() {
        use crate::api::Request;
        assert!(!crate::http::browser::request_allowed(
            &Request::MachineShare
        ));
        let trust = Request::MachineTrust {
            alias: "s".into(),
            link: link(&good()),
        };
        assert!(!crate::http::browser::request_allowed(&trust));
    }
    fn registry(h: &Path) -> Mutex<Sessions> {
        Mutex::new(Sessions::open(h).unwrap())
    }
    /// As Add saves it: machines.json, which remote_aliases reads from disk on each call.
    fn saved(h: &Path, alias: &str) {
        std::fs::write(
            h.join("machines.json"),
            format!(r#"{{"version":1,"machines":["{alias}"]}}"#),
        )
        .unwrap();
    }
    #[test]
    fn trust_refuses_bad_links_before_any_process() {
        let h = home("bad");
        let r = registry(&h);
        let ok = link(&good());
        assert!(trust(&r, &h, "-s", &ok).is_err());
        for dots in [".", ".."] {
            assert!(trust(&r, &h, dots, &ok).is_err());
            assert!(parse(&ok.replace("label=studio", &format!("label={dots}"))).is_err());
        }
        assert!(trust(&r, &h, "s", &ok.replace("studio.local", "-oProxyCommand=x")).is_err());
        assert!(trust(&r, &h, "s", &ok.replace("user=me", "user=-l")).is_err());
        assert!(trust(&r, &h, "s", &ok.replace("2222", "0")).is_err());
        assert!(trust(&r, &h, "s", &ok.replace(KEY, "SHA256:x")).is_err());
        assert!(!h.join("known_hosts.d").exists());
        let _ = std::fs::remove_dir_all(&h);
    }
    /// Codex round 3: a second link with a saved machine's label never touches that machine's pin, in any case;
    /// a Test that is then cancelled (no Add) leaves only its own new file and saves nothing.
    #[test]
    fn trust_never_overwrites_a_saved_machines_pin() {
        let h = home("collide");
        let r = registry(&h);
        let pin = known_hosts(&h, "studio");
        std::fs::create_dir_all(pin.parent().unwrap()).unwrap();
        std::fs::write(&pin, "[studio.local]:2222 ssh-ed25519 OLD\n").unwrap();
        saved(&h, "studio");
        // No ssh-keyscan runs: the refusal comes before any process (NUNCHIRO_SSH_KEYSCAN is not set here).
        for alias in ["studio", "Studio"] {
            let e = trust(&r, &h, alias, &link(&good())).unwrap_err();
            assert!(e.contains("already named"), "{e}");
        }
        assert_eq!(
            std::fs::read_to_string(&pin).unwrap(),
            "[studio.local]:2222 ssh-ed25519 OLD\n"
        );
        // Cancel case: a trusted Test of a new alias writes its own file only; the saved pin and settings stay.
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let want = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
        let scanned = format!("studio2.local ssh-ed25519 {blob}\n");
        assert!(
            commit(&r, &h, "studio2", "studio2.local", &scanned, want)
                .unwrap()
                .1
        );
        assert_eq!(
            std::fs::read_to_string(&pin).unwrap(),
            "[studio.local]:2222 ssh-ed25519 OLD\n"
        );
        assert!(!h.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&h);
    }
    /// Codex round 4: two Tests of one unsaved alias overlap. The first commits and its machine is added; the
    /// second's ssh-keyscan ends after that Add, and its commit must refuse instead of replacing the added pin.
    #[test]
    fn a_late_test_never_replaces_the_pin_of_a_machine_added_meanwhile() {
        let h = home("race");
        let r = registry(&h);
        let first = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let second = "AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let scan = |blob: &str| format!("studio.local ssh-ed25519 {blob}\n");
        let fp = |blob: &str| key_fingerprint(blob).unwrap();
        // Both Tests passed the first check before either wrote (the alias was not saved yet).
        refuse_saved(&super::super::aliases::listed(&r, &h).unwrap(), "studio").unwrap();
        assert!(
            commit(&r, &h, "studio", "studio.local", &scan(first), &fp(first))
                .unwrap()
                .1
        );
        saved(&h, "studio");
        for alias in ["studio", "Studio"] {
            let e = commit(&r, &h, alias, "studio.local", &scan(second), &fp(second)).unwrap_err();
            assert!(e.contains("already named"), "{e}");
        }
        assert_eq!(
            std::fs::read_to_string(known_hosts(&h, "studio")).unwrap(),
            scan(first)
        );
        let _ = std::fs::remove_dir_all(&h);
    }
}
