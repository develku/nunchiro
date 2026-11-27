//! Ticket 573 slice 3: tokens for outside callers (scripts, other tools, the MCP server), made by the owner with
//! `nunchiro token create`. The secret is printed once; `tokens.json` keeps only its SHA-256 (T3 Code's environment
//! auth: "only the creation response returns the raw credential"). A token resolves to the caller `token-<id>`, which
//! takes every session-caller check plus its scope (`Sessions::check_token`).
use crate::store;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// The caller id prefix of an outside token; never a session id (those are UUIDs).
pub const CALLER: &str = "token-";
/// Every secret starts with this; owner and session tokens are bare UUIDs.
pub const SECRET_PREFIX: &str = "nunchiro_";
const FILE: &str = "tokens.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "TokensScope"))]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// List, get, read, wait, room check and thread read.
    Read,
    /// Read, plus start, prompt/send, room send/ask/reply, and stop of the sessions this token started.
    Supervised,
    /// What a session token may do, except answers, keys and settings (no scope has those); types only into its own.
    Full,
}
impl std::str::FromStr for Scope {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "read" => Ok(Scope::Read),
            "supervised" => Ok(Scope::Supervised),
            "full" => Ok(Scope::Full),
            _ => Err("scope is read, supervised or full".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Token {
    pub id: String,
    pub scope: Scope,
    /// Only sessions, worktrees and the room of this project (canonical); `None` is every project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<PathBuf>,
    pub created_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<u64>,
    /// Lowercase hex SHA-256 of the secret. Never sent in a reply (`listed`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hash: String,
}
impl Token {
    pub fn caller_id(&self) -> String {
        format!("{CALLER}{}", self.id)
    }
    fn live(&self, now: u64) -> bool {
        self.expires_ms.is_none_or(|e| now < e)
    }
    fn listed(mut self) -> Self {
        self.hash.clear();
        self
    }
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    version: u32,
    tokens: Vec<Token>,
}
/// Round 2 (security MUST 2): create and revoke are read-modify-write of one file; one at a time in this core (the only
/// writer: the core holds the home's lifetime lock), so an acknowledged revoke is never undone by a create.
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn load(home: &Path) -> Result<File, String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    // O_NOFOLLOW: a symlink planted at tokens.json is refused, never read through. Writes go through
    // `store::atomic_write` (a new 0600 file, O_EXCL, then rename over the path).
    let read = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(home.join(FILE))
        .and_then(|mut f| {
            let mut bytes = vec![];
            f.read_to_end(&mut bytes).map(|_| bytes)
        });
    match read {
        Ok(bytes) => {
            let file: File = serde_json::from_slice(&bytes).map_err(|e| format!("{FILE}: {e}"))?;
            if file.version != 1 {
                return Err(format!("{FILE}: unknown version {}", file.version));
            }
            Ok(file)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File {
            version: 1,
            tokens: vec![],
        }),
        Err(e) => Err(e.to_string()),
    }
}
fn save(home: &Path, file: &File) -> Result<(), String> {
    store::atomic_write(
        &home.join(FILE),
        &serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?,
    )
}

/// `30m`, `12h` or `7d` from now, in milliseconds.
pub fn parse_expires(text: &str) -> Result<u64, String> {
    let bad = || "expires is a number with m, h or d (30m, 12h, 7d)".to_string();
    let unit = text.chars().last().ok_or_else(bad)?;
    let n: u64 = text[..text.len() - unit.len_utf8()]
        .parse()
        .map_err(|_| bad())?;
    let minutes_per = match unit {
        'm' => 1,
        'h' => 60,
        'd' => 60 * 24,
        _ => return Err(bad()),
    };
    if n == 0 {
        return Err(bad());
    }
    Ok(n.saturating_mul(minutes_per).saturating_mul(60_000))
}

/// The new token's record and its secret, which nothing stores.
pub fn create(
    home: &Path,
    scope: Scope,
    project: Option<&Path>,
    expires_in_ms: Option<u64>,
) -> Result<(Token, String), String> {
    let project = project
        .map(|p| fs::canonicalize(p).map_err(|e| format!("project: {e}")))
        .transpose()?;
    let id = store::new_id()?.replace('-', "")[..12].to_string();
    let secret = format!("{SECRET_PREFIX}{}{}", store::new_id()?, store::new_id()?);
    let now = crate::queue::now_ms();
    let token = Token {
        id,
        scope,
        project,
        created_ms: now,
        expires_ms: expires_in_ms.map(|ms| now.saturating_add(ms)),
        hash: store::token_sha256(&secret),
    };
    let _write = WRITE.lock().map_err(|_| "token store unavailable")?;
    let mut file = load(home)?;
    file.tokens.push(token.clone());
    save(home, &file)?;
    Ok((token.listed(), secret))
}
/// Every token, expired ones too (so they can be revoked), without hashes.
pub fn list(home: &Path) -> Result<Vec<Token>, String> {
    Ok(load(home)?.tokens.into_iter().map(Token::listed).collect())
}
pub fn revoke(home: &Path, id: &str) -> Result<(), String> {
    let _write = WRITE.lock().map_err(|_| "token store unavailable")?;
    let mut file = load(home)?;
    let before = file.tokens.len();
    file.tokens.retain(|t| t.id != id);
    if file.tokens.len() == before {
        return Err("token not found".into());
    }
    save(home, &file)
}
/// Ticket 1040 (Locate): a token limited to a project whose folder moved is revoked, never moved: its limit named the
/// old folder, and the owner makes a new one for the new folder.
pub(crate) fn revoke_project(home: &Path, project: &Path) -> Result<(), String> {
    let _write = WRITE.lock().map_err(|_| "token store unavailable")?;
    let mut file = load(home)?;
    let before = file.tokens.len();
    file.tokens
        .retain(|t| t.project.as_deref() != Some(project));
    if file.tokens.len() == before {
        return Ok(());
    }
    save(home, &file)
}
/// The live token whose secret this is; `None` for an unknown, revoked or expired one, or an unreadable file.
pub fn verify(home: &Path, secret: &str) -> Option<Token> {
    let presented = store::token_sha256(secret);
    let now = crate::queue::now_ms();
    load(home).ok()?.tokens.into_iter().find(|t| {
        crate::server::token_equal(presented.as_bytes(), t.hash.as_bytes()) && t.live(now)
    })
}
/// The live token behind caller id `token-<id>`; `None` once revoked or expired.
pub fn by_caller(home: &Path, caller: &str) -> Option<Token> {
    let id = caller.strip_prefix(CALLER)?;
    let now = crate::queue::now_ms();
    load(home)
        .ok()?
        .tokens
        .into_iter()
        .find(|t| t.id == id && t.live(now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_hash_is_stored_and_the_secret_verifies() {
        let h = home("hash");
        let (token, secret) = create(&h, Scope::Read, None, None).unwrap();
        let stored = fs::read_to_string(h.join(FILE)).unwrap();
        assert!(!stored.contains(&secret), "secret on disk");
        assert!(stored.contains(&store::token_sha256(&secret)));
        assert!(token.hash.is_empty(), "the reply carries no hash");
        assert_eq!(verify(&h, &secret).unwrap().id, token.id);
        assert!(verify(&h, "nunchiro_wrong").is_none());
        assert!(list(&h).unwrap().iter().all(|t| t.hash.is_empty()));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn revoked_and_expired_tokens_stop_verifying() {
        let h = home("life");
        let (a, sa) = create(&h, Scope::Full, None, None).unwrap();
        let (_, sb) = create(&h, Scope::Read, None, Some(60_000)).unwrap();
        assert!(by_caller(&h, &a.caller_id()).is_some());
        revoke(&h, &a.id).unwrap();
        assert!(verify(&h, &sa).is_none());
        assert!(by_caller(&h, &a.caller_id()).is_none());
        assert_eq!(revoke(&h, &a.id).unwrap_err(), "token not found");
        assert!(verify(&h, &sb).is_some());
        let mut file = load(&h).unwrap();
        file.tokens[0].expires_ms = Some(crate::queue::now_ms() - 1);
        save(&h, &file).unwrap();
        assert!(verify(&h, &sb).is_none(), "expired");
        assert_eq!(
            list(&h).unwrap().len(),
            1,
            "an expired token is still listed"
        );
        let _ = fs::remove_dir_all(&h);
    }

    // Round 2 (security MUST 2): an acknowledged revoke is never lost to a create running at the same time.
    #[test]
    fn concurrent_creates_never_undo_a_revoke() {
        let h = home("race");
        for _ in 0..5 {
            let (victim, secret) = create(&h, Scope::Full, None, None).unwrap();
            let creators: Vec<_> = (0..12)
                .map(|_| {
                    let h = h.clone();
                    std::thread::spawn(move || create(&h, Scope::Read, None, None).unwrap())
                })
                .collect();
            revoke(&h, &victim.id).unwrap();
            let made: Vec<_> = creators.into_iter().map(|c| c.join().unwrap()).collect();
            assert!(verify(&h, &secret).is_none(), "a revoked token came back");
            for (_, s) in made {
                assert!(verify(&h, &s).is_some(), "a create was lost");
            }
        }
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn expires_parses_minutes_hours_days() {
        assert_eq!(parse_expires("30m").unwrap(), 30 * 60_000);
        assert_eq!(parse_expires("2h").unwrap(), 2 * 3_600_000);
        assert_eq!(parse_expires("7d").unwrap(), 7 * 86_400_000);
        for bad in [
            "",
            "d",
            "0d",
            "7",
            "7w",
            "-1d",
            "7é",
            "99999999999999999999d",
        ] {
            assert!(parse_expires(bad).is_err(), "{bad}");
        }
    }
}
