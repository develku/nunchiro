//! v1b-05: images the user pasted or dropped in the composer, saved under
//! `$NUNCHIRO_HOME/images/<session>/<sha256>.<ext>` so the agent can read them by path.
//! The name is the address: no index file. Uploads arrive in pieces (`Request::ImagePut`) because the
//! window's WebSocket and the unix socket cap one message; a piece is appended to a part file, and the
//! last one is checked (size, sha256, magic) before an atomic rename.
use crate::api::{Reply, Response};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub const MAX_IMAGE: u64 = 20 << 20;
/// 256 KiB of base64 fits the 1 MiB WebSocket and the 512 KiB unix-socket frame caps.
pub const MAX_PIECE_B64: usize = 256 << 10;
const PART: &str = ".part-";

/// PNG, JPEG, GIF or WebP by magic bytes; anything else (SVG, HTML, text) is refused.
fn kind(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

pub(crate) fn decode(s: &str) -> Result<Vec<u8>, String> {
    let bad = || "chunk is not base64".to_string();
    let s = s.as_bytes();
    if !s.len().is_multiple_of(4) {
        return Err(bad());
    }
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for (i, q) in s.chunks(4).enumerate() {
        let pad = q.iter().rev().take_while(|c| **c == b'=').count();
        // Padding only at the very end, at most two.
        if pad > 2 || (pad > 0 && (i + 1) * 4 != s.len()) {
            return Err(bad());
        }
        let mut n = 0u32;
        for &c in &q[..4 - pad] {
            n = n << 6 | val(c).ok_or_else(bad)? as u32;
        }
        n <<= 6 * pad as u32;
        out.extend_from_slice(&n.to_be_bytes()[1..4 - pad]);
    }
    Ok(out)
}

fn safe_name(s: &str) -> bool {
    crate::store::valid_id(s)
}

fn dir(path: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| e.to_string())
}

pub fn run(home: &Path, request: crate::api::Request) -> Response {
    match request {
        crate::api::Request::ImagePut {
            session,
            upload,
            offset,
            chunk_b64,
            last,
            sha256,
        } => put(home, &session, &upload, offset, &chunk_b64, last, &sha256),
        _ => Err("not an image request".into()),
    }
}

/// One piece of an upload. The caller checked that `session` exists and released the registry lock.
pub fn put(
    home: &Path,
    session: &str,
    upload: &str,
    offset: u64,
    chunk_b64: &str,
    last: bool,
    sha256: &str,
) -> Response {
    if !safe_name(session) || !safe_name(upload) || upload.len() < 8 {
        return Err("invalid session or upload id".into());
    }
    if sha256.len() != 64 || !sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("sha256 must be 64 hex digits".into());
    }
    if chunk_b64.len() > MAX_PIECE_B64 {
        return Err("piece over 256 KiB of base64".into());
    }
    let bytes = decode(chunk_b64)?;
    let folder = home.join("images").join(session);
    let part = folder.join(format!("{PART}{upload}"));
    // Any refusal drops the upload: the window starts over or gives up, nothing half-written stays.
    let refuse = |e: String| -> Response {
        let _ = fs::remove_file(&part);
        Err(e)
    };
    if offset == 0 && kind(&bytes).is_none() {
        return refuse("not a PNG, JPEG, GIF or WebP image".into());
    }
    // Checked: an offset near u64::MAX must be a refusal, not an overflow.
    let Some(received) = offset
        .checked_add(bytes.len() as u64)
        .filter(|end| *end <= MAX_IMAGE)
    else {
        return refuse("image over 20 MiB".into());
    };
    dir(&folder)?;
    let mut file = match OpenOptions::new()
        .append(true)
        .create(offset == 0)
        .truncate(false)
        .mode(0o600)
        .open(&part)
    {
        Ok(f) => f,
        Err(_) => return refuse("upload offset does not follow the last piece".into()),
    };
    // A retried first piece starts the part over.
    if offset == 0 {
        file.set_len(0).map_err(|e| e.to_string())?;
    }
    let have = file.metadata().map_err(|e| e.to_string())?.len();
    if have != offset {
        return refuse("upload offset does not follow the last piece".into());
    }
    if let Err(e) = file.write_all(&bytes) {
        return refuse(e.to_string());
    }
    if !last {
        return Ok(Reply::Image {
            received,
            path: None,
        });
    }
    match finish(&folder, &part, sha256) {
        Ok(path) => Ok(Reply::Image {
            received,
            path: Some(path.to_string_lossy().into_owned()),
        }),
        Err(e) => refuse(e),
    }
}

fn finish(folder: &Path, part: &Path, sha256: &str) -> Result<PathBuf, String> {
    let mut f = fs::File::open(part).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut head = Vec::new();
    let mut buf = vec![0; 64 << 10];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if head.len() < 12 {
            head.extend_from_slice(&buf[..n.min(12 - head.len())]);
        }
        hash.update(&buf[..n]);
    }
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(sha256) {
        return Err("sha256 does not match the bytes received".into());
    }
    let ext = kind(&head).ok_or("not a PNG, JPEG, GIF or WebP image")?;
    let path = folder.join(format!("{got}.{ext}"));
    f.sync_all().map_err(|e| e.to_string())?;
    // Same name, same bytes: a second writer's rename replaces an identical file.
    fs::rename(part, &path).map_err(|e| e.to_string())?;
    if let Ok(d) = fs::File::open(folder) {
        let _ = d.sync_all();
    }
    Ok(path)
}

/// At core start: parts of uploads the window never finished (closed, cancelled, core killed).
pub fn clean(home: &Path) {
    let Ok(sessions) = fs::read_dir(home.join("images")) else {
        return;
    };
    for s in sessions.flatten() {
        let Ok(files) = fs::read_dir(s.path()) else {
            continue;
        };
        for f in files.flatten() {
            if f.file_name().to_string_lossy().starts_with(PART) {
                let _ = fs::remove_file(f.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::decode;
    #[test]
    fn base64_decodes_padding_and_refuses_junk() {
        assert_eq!(decode("").unwrap(), b"");
        assert_eq!(decode("TQ==").unwrap(), b"M");
        assert_eq!(decode("TWE=").unwrap(), b"Ma");
        assert_eq!(decode("TWFu").unwrap(), b"Man");
        assert_eq!(decode("TWFuTWE=").unwrap(), b"ManMa");
        for bad in ["TQ=", "T===", "TQ==TWFu", "TW-u", "TWF\n"] {
            assert!(decode(bad).is_err(), "{bad}");
        }
    }
}
