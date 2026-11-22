//! V2.5-15: device approval for the browser listener and the device store (docs/design/v25-web-access.md section 3).
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    net::IpAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(crate) const MAX_PENDING: usize = 3;
pub(crate) const PAIR_LIFE: Duration = Duration::from_secs(5 * 60);
pub(crate) const MAX_FAILURES: usize = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(60 * 60);
pub(crate) const IDLE_EXPIRY_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const LAST_USED_EVERY_MS: u64 = 60 * 60 * 1000;
const MAX_NAME: usize = 64;

/// One approved browser. Only the token's SHA-256 is kept; the token itself lives in that browser alone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Device {
    pub id: String,
    pub name: String,
    pub token_sha256: String,
    pub created_ms: u64,
    pub last_used_ms: u64,
    pub peer: String,
}

/// `NUNCHIRO_HOME/browser-devices.json`, 0600 through the store's atomic write.
pub(crate) struct Devices {
    path: PathBuf,
    pub list: Vec<Device>,
    /// An unreadable file: nothing pairs, and no write replaces what the owner may still want to inspect.
    broken: bool,
}
impl Devices {
    pub fn open(home: &Path) -> Self {
        let path = home.join("browser-devices.json");
        // A broken file pairs nothing (fail closed) and is left for the owner to inspect, never overwritten unread.
        let (list, broken) = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(list) => (list, false),
                Err(e) => {
                    eprintln!("browser-devices.json unreadable, no device is paired: {e}");
                    (vec![], true)
                }
            },
            Err(_) => (vec![], false),
        };
        Self { path, list, broken }
    }
    fn save(&self) -> Result<(), String> {
        if self.broken {
            return Err("browser-devices.json is unreadable; fix or remove it first".into());
        }
        store::atomic_write(
            &self.path,
            serde_json::to_string_pretty(&self.list)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    }
    /// The device a presented token belongs to, if it is paired and was used in the last 30 days. Marks it used.
    pub fn check(&mut self, token: &str, now_ms: u64) -> Option<Device> {
        let hash = store::token_sha256(token);
        let i = self
            .list
            .iter()
            .position(|d| crate::server::token_equal(d.token_sha256.as_bytes(), hash.as_bytes()))?;
        if now_ms.saturating_sub(self.list[i].last_used_ms) > IDLE_EXPIRY_MS {
            return None;
        }
        if now_ms.saturating_sub(self.list[i].last_used_ms) >= LAST_USED_EVERY_MS {
            self.list[i].last_used_ms = now_ms;
            if let Err(e) = self.save() {
                eprintln!("browser device last-used not saved: {e}");
            }
        }
        Some(self.list[i].clone())
    }
    /// Whether `id` is paired and used in the last 30 days.
    pub fn active(&self, id: &str, now_ms: u64) -> bool {
        self.list
            .iter()
            .any(|d| d.id == id && now_ms.saturating_sub(d.last_used_ms) <= IDLE_EXPIRY_MS)
    }
    /// A fresh device and its token, which the caller hands to the browser once and then forgets.
    fn add(&mut self, name: &str, peer: IpAddr, now_ms: u64) -> Result<String, String> {
        let token = (store::new_id()? + &store::new_id()?).replace('-', "");
        self.list.push(Device {
            id: store::new_id()?,
            name: name.to_string(),
            token_sha256: store::token_sha256(&token),
            created_ms: now_ms,
            last_used_ms: now_ms,
            peer: peer.to_string(),
        });
        // An unsaved device must not pair: it would vanish on restart and was never on disk for the owner to see.
        if let Err(e) = self.save() {
            self.list.pop();
            return Err(e);
        }
        crate::logs::register(&token, "browser device");
        Ok(token)
    }
    /// Removes one device (or all with `None`); returns the removed ids.
    pub fn revoke(&mut self, id: Option<&str>) -> Result<Vec<String>, String> {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.list)
            .into_iter()
            .partition(|d| id.is_none_or(|id| d.id == id));
        self.list = kept;
        if id.is_some() && gone.is_empty() {
            return Err("no such device".into());
        }
        // A failed write still revokes in memory: the token stops working now, which is what the owner asked.
        self.save()?;
        Ok(gone.into_iter().map(|d| d.id).collect())
    }
}

/// A pairing waiting for the owner's Allow or Deny in the Mac window.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Request {
    pub id: String,
    pub name: String,
    pub code: String,
    pub peer: String,
    /// W6: a loopback request could come from an agent's own browser view on this Mac.
    pub loopback: bool,
    #[serde(skip)]
    at: Instant,
    #[serde(skip)]
    peer_ip: Option<IpAddr>,
}

enum Outcome {
    Allowed(String),
    Refused,
}

#[derive(Default)]
pub(crate) struct Pairs {
    pub pending: Vec<Request>,
    /// Answered pairings whose browser has not polled yet: an Allow's token is given out once.
    answered: BTreeMap<String, (Instant, Outcome)>,
    failures: BTreeMap<IpAddr, Vec<Instant>>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Poll {
    Waiting,
    Allowed(String),
    Refused,
}

impl Pairs {
    fn expire(&mut self, now: Instant) {
        let (old, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|r| now.duration_since(r.at) >= PAIR_LIFE);
        self.pending = kept;
        for r in old {
            self.fail(r.peer_ip, now);
            self.answered.insert(r.id, (now, Outcome::Refused));
        }
        self.answered
            .retain(|_, (at, _)| now.duration_since(*at) < PAIR_LIFE);
        for list in self.failures.values_mut() {
            list.retain(|t| now.duration_since(*t) < FAILURE_WINDOW);
        }
        self.failures.retain(|_, l| !l.is_empty());
    }
    pub fn expire_now(&mut self) {
        self.expire(Instant::now());
    }
    fn fail(&mut self, peer: Option<IpAddr>, now: Instant) {
        if let Some(ip) = peer {
            self.failures.entry(ip).or_default().push(now);
        }
    }
    /// `POST /pair`: a new pending request, or why not.
    pub fn start(&mut self, name: &str, peer: IpAddr, now: Instant) -> Result<Request, String> {
        self.expire(now);
        if self.failures.get(&peer).map_or(0, Vec::len) >= MAX_FAILURES {
            return Err("too many refused pairings from this address; try later".into());
        }
        // One pending pairing per peer, so one device cannot fill the queue for everyone else.
        if self.pending.iter().any(|r| r.peer_ip == Some(peer)) {
            return Err(
                "a pairing from this address is already waiting; answer it on the Mac first".into(),
            );
        }
        if self.pending.len() >= MAX_PENDING {
            return Err("too many pairings waiting; answer them on the Mac first".into());
        }
        let name: String = name
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_NAME)
            .collect();
        let name = if name.trim().is_empty() {
            "Browser".to_string()
        } else {
            name.trim().to_string()
        };
        let id = store::new_id()?;
        // Six digits from fresh random bytes; display-only confirmation, the token comes after the Mac click.
        let n = u64::from_str_radix(&store::new_id()?.replace('-', "")[..12], 16)
            .map_err(|e| e.to_string())?;
        let request = Request {
            id,
            name,
            code: format!("{:06}", n % 1_000_000),
            peer: peer.to_string(),
            loopback: peer.is_loopback(),
            at: now,
            peer_ip: Some(peer),
        };
        self.pending.push(request.clone());
        Ok(request)
    }
    /// The Mac window's Allow or Deny. Allow makes the device; its token waits for the browser's next poll.
    pub fn answer(
        &mut self,
        id: &str,
        allow: bool,
        devices: &mut Devices,
        now: Instant,
        now_ms: u64,
    ) -> Result<(), String> {
        self.expire(now);
        let i = self
            .pending
            .iter()
            .position(|r| r.id == id)
            .ok_or("this pairing request has expired")?;
        let r = self.pending.remove(i);
        let outcome = if allow {
            let peer = r.peer_ip.ok_or("pairing has no peer")?;
            Outcome::Allowed(devices.add(&r.name, peer, now_ms)?)
        } else {
            self.fail(r.peer_ip, now);
            Outcome::Refused
        };
        self.answered.insert(r.id, (now, outcome));
        Ok(())
    }
    /// `GET /pair/<id>`: the token exactly once, then the entry is gone.
    pub fn poll(&mut self, id: &str, now: Instant) -> Poll {
        self.expire(now);
        if self.pending.iter().any(|r| r.id == id) {
            return Poll::Waiting;
        }
        match self.answered.remove(id) {
            Some((_, Outcome::Allowed(token))) => Poll::Allowed(token),
            _ => Poll::Refused,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("ns-pair-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }
    const PEER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(100, 64, 0, 7));

    #[test]
    fn pair_needs_mac_approval() {
        let h = home("approval");
        let mut devices = Devices::open(&h);
        let mut pairs = Pairs::default();
        let t0 = Instant::now();
        let r = pairs.start("Phone", PEER, t0).unwrap();
        assert_eq!(r.code.len(), 6);
        assert_eq!(
            pairs.poll(&r.id, t0),
            Poll::Waiting,
            "no token before Allow"
        );
        assert!(devices.list.is_empty());
        pairs.answer(&r.id, true, &mut devices, t0, 1).unwrap();
        let Poll::Allowed(token) = pairs.poll(&r.id, t0) else {
            panic!("allowed")
        };
        assert_eq!(
            pairs.poll(&r.id, t0),
            Poll::Refused,
            "the token is returned once"
        );
        assert_eq!(devices.check(&token, 2).unwrap().name, "Phone");
        // Deny.
        let d = pairs.start("Other", PEER, t0).unwrap();
        pairs.answer(&d.id, false, &mut devices, t0, 1).unwrap();
        assert_eq!(pairs.poll(&d.id, t0), Poll::Refused);
        // Expiry: no answer in 5 minutes, and a late Allow finds nothing.
        let e = pairs.start("Late", PEER, t0).unwrap();
        let later = t0 + PAIR_LIFE;
        assert_eq!(pairs.poll(&e.id, later), Poll::Refused);
        assert!(pairs.answer(&e.id, true, &mut devices, later, 1).is_err());
        assert_eq!(devices.list.len(), 1);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn pair_limits_pending_and_failures() {
        let h = home("limits");
        let mut devices = Devices::open(&h);
        let mut pairs = Pairs::default();
        let t0 = Instant::now();
        let peers: Vec<IpAddr> = (1..=MAX_PENDING as u8 + 1)
            .map(|n| IpAddr::V4(std::net::Ipv4Addr::new(100, 64, 1, n)))
            .collect();
        let ids: Vec<_> = peers[..MAX_PENDING]
            .iter()
            .map(|p| pairs.start("x", *p, t0).unwrap().id)
            .collect();
        assert!(
            pairs.start("x", peers[MAX_PENDING], t0).is_err(),
            "at most 3 pending"
        );
        for id in &ids {
            pairs.answer(id, false, &mut devices, t0, 1).unwrap();
        }
        for _ in 0..MAX_FAILURES {
            let id = pairs.start("x", PEER, t0).unwrap().id;
            pairs.answer(&id, false, &mut devices, t0, 1).unwrap();
        }
        assert!(
            pairs.start("x", PEER, t0).is_err(),
            "10 refusals block the IP"
        );
        let other: IpAddr = "100.64.0.8".parse().unwrap();
        assert!(
            pairs.start("x", other, t0).is_ok(),
            "another IP is not blocked"
        );
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn pair_pending_per_ip() {
        let mut pairs = Pairs::default();
        let t0 = Instant::now();
        let first = pairs.start("Phone", PEER, t0).unwrap();
        assert!(
            pairs.start("Phone again", PEER, t0).is_err(),
            "one pending per peer"
        );
        let other: IpAddr = "100.64.0.9".parse().unwrap();
        assert!(
            pairs.start("Laptop", other, t0).is_ok(),
            "another peer still pairs"
        );
        assert_eq!(
            pairs.poll(&first.id, t0),
            Poll::Waiting,
            "the first is untouched"
        );
    }

    #[test]
    fn pair_sheet_labels_loopback_peer() {
        let mut pairs = Pairs::default();
        let r = pairs
            .start("Agent?", "127.0.0.1".parse().unwrap(), Instant::now())
            .unwrap();
        assert!(r.loopback);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["loopback"], true);
        assert_eq!(json["peer"], "127.0.0.1");
        assert!(!pairs.start("Phone", PEER, Instant::now()).unwrap().loopback);
    }

    #[test]
    fn device_store_holds_hash_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let h = home("store");
        let mut devices = Devices::open(&h);
        let token = devices.add("Phone", PEER, 1).unwrap();
        let path = h.join("browser-devices.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&token), "the token is never stored");
        assert!(text.contains(&store::token_sha256(&token)));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(
            Devices::open(&h).check(&token, 2).is_some(),
            "survives a reload"
        );
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn device_idle_expiry_30_days() {
        let h = home("idle");
        let mut devices = Devices::open(&h);
        let token = devices.add("Phone", PEER, 0).unwrap();
        assert!(
            devices.check(&token, IDLE_EXPIRY_MS).is_some(),
            "used on day 30"
        );
        let used = devices.list[0].last_used_ms;
        assert_eq!(used, IDLE_EXPIRY_MS, "use moves last used");
        assert!(devices.check(&token, used + IDLE_EXPIRY_MS + 1).is_none());
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn broken_device_store_pairs_nothing() {
        let h = home("broken");
        std::fs::write(h.join("browser-devices.json"), b"{not json").unwrap();
        assert!(Devices::open(&h).list.is_empty());
        std::fs::write(h.join("browser-devices.json"), br#"[{"id":1}]"#).unwrap();
        let mut devices = Devices::open(&h);
        assert!(devices.list.is_empty());
        assert!(
            devices.add("Phone", PEER, 1).is_err(),
            "no write over a broken store"
        );
        assert!(devices.list.is_empty(), "nor an unsaved device");
        assert_eq!(
            std::fs::read(h.join("browser-devices.json")).unwrap(),
            br#"[{"id":1}]"#,
            "left unchanged"
        );
        let _ = std::fs::remove_dir_all(&h);
    }
}
