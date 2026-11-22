//! Ticket v1b-05: images pasted in the composer are saved by the core, content-addressed, in pieces.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, images, server::call};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn scratch(tag: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!(
            "img{}-{}-{tag}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn png(len: usize) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    b.extend((0..len.saturating_sub(b.len())).map(|i| (i * 7 % 251) as u8));
    b
}

fn hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// Standard base64 with padding: what the window's `btoa` sends.
fn b64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() {
                T[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

fn put(home: &Path, upload: &str, bytes: &[u8], piece: usize) -> Result<Option<String>, String> {
    let sha = hex(bytes);
    let mut offset = 0;
    let pieces: Vec<&[u8]> = bytes.chunks(piece).collect();
    let mut last_reply = None;
    for (i, c) in pieces.iter().enumerate() {
        let last = i + 1 == pieces.len();
        let reply = images::put(home, "s1", upload, offset, &b64(c), last, &sha)?;
        let Reply::Image { received, path } = reply else {
            panic!("unexpected reply")
        };
        offset += c.len() as u64;
        assert_eq!(received, offset);
        last_reply = path;
    }
    Ok(last_reply)
}

fn parts(home: &Path) -> Vec<String> {
    let Ok(dir) = fs::read_dir(home.join("images/s1")) else {
        return vec![];
    };
    dir.flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect()
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn images_put_saves_content_addressed_0600() {
    let home = scratch("ca");
    let bytes = png(5000);
    let path = put(&home, "up-one-0001", &bytes, 1500).unwrap().unwrap();
    let want = home.join("images/s1").join(format!("{}.png", hex(&bytes)));
    assert_eq!(PathBuf::from(&path), want);
    assert_eq!(fs::read(&want).unwrap(), bytes);
    assert_eq!(mode(&want), 0o600);
    // A fresh install has no images folder: created 0700, as is the session folder.
    assert_eq!(mode(&home.join("images")), 0o700);
    assert_eq!(mode(&home.join("images/s1")), 0o700);
    // The same image again (another upload, or another window) saves once and names the same path.
    let again = put(&home, "up-two-0002", &bytes, 4096).unwrap().unwrap();
    assert_eq!(again, path);
    assert_eq!(fs::read_dir(home.join("images/s1")).unwrap().count(), 1);
    assert!(parts(&home).is_empty());
}

#[test]
fn images_put_refuses_what_is_not_an_image() {
    let home = scratch("magic");
    for bad in [
        &b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
        b"<!doctype html><script>alert(1)</script>",
        b"plain text pretending to be a png",
    ] {
        let err = put(&home, "up-bad-0001", bad, 4096).unwrap_err();
        assert!(err.contains("not a PNG, JPEG, GIF or WebP"), "{err}");
    }
    // Magic is checked on the first piece, before anything more is accepted.
    let mut lie = b"GIF8".to_vec();
    lie.extend(png(100));
    assert!(put(&home, "up-bad-0002", &lie, 10).is_err());
    assert!(parts(&home).is_empty());
    assert!(fs::read_dir(home.join("images/s1")).map_or(0, |d| d.count()) == 0);
}

#[test]
fn images_put_refuses_over_cap() {
    let home = scratch("cap");
    let sha = "0".repeat(64);
    let chunk = b64(&png(192 * 1024));
    let piece = 192 * 1024u64;
    let mut offset = 0;
    let mut err = None;
    while offset <= images::MAX_IMAGE {
        // Only the first piece carries the magic; later pieces are any bytes.
        match images::put(&home, "s1", "up-cap-0001", offset, &chunk, false, &sha) {
            Ok(_) => offset += piece,
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    assert!(err.unwrap().contains("over 20 MiB"));
    assert!(offset <= images::MAX_IMAGE);
    assert!(parts(&home).is_empty(), "the refused upload leaves no part");
}

#[test]
fn images_put_checks_order_size_and_hash() {
    let home = scratch("order");
    let bytes = png(3000);
    let sha = hex(&bytes);
    let first = b64(&bytes[..1500]);
    images::put(&home, "s1", "up-ord-0001", 0, &first, false, &sha).unwrap();
    // A gap or a repeat is refused and drops the upload.
    let err = images::put(
        &home,
        "s1",
        "up-ord-0001",
        3000,
        &b64(&bytes[1500..]),
        true,
        &sha,
    )
    .unwrap_err();
    assert!(err.contains("offset"), "{err}");
    assert!(parts(&home).is_empty());
    // A wrong hash at the end saves nothing.
    images::put(
        &home,
        "s1",
        "up-ord-0002",
        0,
        &first,
        false,
        &"a".repeat(64),
    )
    .unwrap();
    let err = images::put(
        &home,
        "s1",
        "up-ord-0002",
        1500,
        &b64(&bytes[1500..]),
        true,
        &"a".repeat(64),
    )
    .unwrap_err();
    assert!(err.contains("sha256"), "{err}");
    assert!(parts(&home).is_empty());
    assert_eq!(fs::read_dir(home.join("images/s1")).unwrap().count(), 0);
    // Oversized pieces, bad base64, bad ids and unsafe names are refused before any write.
    let big = "A".repeat(images::MAX_PIECE_B64 + 4);
    assert!(images::put(&home, "s1", "up-ord-0003", 0, &big, false, &sha).is_err());
    assert!(images::put(&home, "s1", "up-ord-0004", 0, "@@@@", false, &sha).is_err());
    assert!(images::put(&home, "s1", "../x", 0, &first, false, &sha).is_err());
    assert!(images::put(&home, "../s1", "up-ord-0005", 0, &first, false, &sha).is_err());
    assert!(images::put(&home, "s1", "up-ord-0006", 0, &first, false, "nothex").is_err());
}

#[test]
fn images_put_saves_900k_and_9m_in_pieces() {
    let home = scratch("big");
    // 192 KiB of bytes is 256 KiB of base64: one piece under both transport caps.
    for size in [900 * 1024, 9 * 1024 * 1024] {
        let bytes = png(size);
        let path = put(&home, &format!("up-big-{size}"), &bytes, 192 * 1024)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(path).unwrap().len(), size);
    }
}

#[test]
fn images_interrupted_upload_is_cleaned_at_start() {
    let home = scratch("int");
    let bytes = png(3000);
    images::put(
        &home,
        "s1",
        "up-int-0001",
        0,
        &b64(&bytes[..1500]),
        false,
        &hex(&bytes),
    )
    .unwrap();
    assert_eq!(parts(&home).len(), 1);
    images::clean(&home);
    assert!(parts(&home).is_empty());
    assert_eq!(fs::read_dir(home.join("images/s1")).unwrap().count(), 0);
    // Saved images stay.
    let path = put(&home, "up-int-0002", &bytes, 4096).unwrap().unwrap();
    images::clean(&home);
    assert!(Path::new(&path).exists());
    // No images folder at all is fine.
    images::clean(&scratch("none"));
}

#[test]
fn images_two_writers_do_not_clash() {
    let home = scratch("two");
    let bytes = png(400_000);
    let threads: Vec<_> = (0..4)
        .map(|i| {
            let (home, bytes) = (home.clone(), bytes.clone());
            thread::spawn(move || {
                put(&home, &format!("up-two-{i:04}"), &bytes, 65536)
                    .unwrap()
                    .unwrap()
            })
        })
        .collect();
    let paths: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(paths.iter().all(|p| *p == paths[0]));
    assert_eq!(fs::read(&paths[0]).unwrap(), bytes);
    assert!(parts(&home).is_empty());
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let until = Instant::now() + Duration::from_secs(5);
        while self.process.try_wait().ok().flatten().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

#[test]
fn images_put_over_the_socket_needs_a_known_session_and_the_owner() {
    let base = home::short("img-sock");
    let home = base.join("h");
    let proj = base.join("p");
    fs::create_dir_all(&proj).unwrap();
    // A part left by an earlier core is removed at start.
    fs::create_dir_all(home.join("images/old")).unwrap();
    fs::write(home.join("images/old/.part-up-old-0001"), b"x").unwrap();
    let bin = cli::path();
    let process = home::git_env::scrubbed(bin)
        .arg("serve")
        .env("NUNCHIRO_HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let core = Core {
        home: home.clone(),
        process,
    };
    let until = Instant::now() + Duration::from_secs(30);
    while !matches!(call(&home, Request::Snapshot), Ok(Reply::Snapshot { .. })) {
        assert!(Instant::now() < until, "core did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!home.join("images/old/.part-up-old-0001").exists());
    let bytes = png(2000);
    let req = |session: &str| Request::ImagePut {
        session: session.into(),
        upload: "up-sock-0001".into(),
        offset: 0,
        chunk_b64: b64(&bytes),
        last: true,
        sha256: hex(&bytes),
    };
    assert_eq!(call(&home, req("nope")).unwrap_err(), "session not found");
    let Reply::Started { session } = call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: proj,
                worktree: false,
                label: "img".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let Reply::Image {
        path: Some(path), ..
    } = call(&home, req(&session.id)).unwrap()
    else {
        panic!()
    };
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // Remote forwarding is refused: owner-local only.
    let remote = Request::Remote {
        machine: "m".into(),
        request: Box::new(req(&session.id)),
    };
    assert!(
        call(&home, remote)
            .unwrap_err()
            .contains("local owner-only")
    );
    drop(core);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn images_put_refuses_an_offset_that_would_overflow() {
    let home = scratch("overflow");
    let bytes = png(100);
    let sha = hex(&bytes);
    let err = images::put(
        &home,
        "s1",
        "up-ovf-0001",
        u64::MAX,
        &b64(&bytes),
        true,
        &sha,
    )
    .unwrap_err();
    assert!(err.contains("over 20 MiB"), "{err}");
    let err = images::put(
        &home,
        "s1",
        "up-ovf-0002",
        u64::MAX - 1,
        &b64(&bytes),
        false,
        &sha,
    )
    .unwrap_err();
    assert!(err.contains("over 20 MiB"), "{err}");
    assert!(parts(&home).is_empty());
}
