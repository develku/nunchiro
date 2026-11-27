//! The triggers' webhook address (docs/triggers.md): `POST http://127.0.0.1:<port>/hooks/<name>`, bound to loopback
//! only and open only while a webhook trigger is on (the listener is checked every second and dropped when none is).
//! A request is taken only with the trigger's secret: GitHub's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) or
//! `X-Nunchiro-Secret`. Answers: 202 and no body; 401 for a wrong or missing secret (one log line); 404 for no such
//! trigger; 405 for anything but POST; 413 past `BODY_MAX`. A service on the internet reaches it only through the
//! user's own tunnel; Nunchiro runs no server elsewhere.
use crate::sessions::Sessions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The default port; settings.json `triggers_port` moves it.
pub const PORT: u16 = 47800;
pub const BODY_MAX: usize = 256 * 1024;
const HEAD_MAX: usize = 16 * 1024;
/// Requests read at once; a connection past it is closed unanswered.
const LIVE_MAX: usize = 8;
/// One request, head and body, is read within this or dropped.
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn port(home: &Path) -> u16 {
    crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["triggers_port"].as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(PORT)
}

/// The listener's own thread: bound while a webhook trigger is on, closed when none is.
pub(crate) fn spawn(
    registry: Arc<Mutex<Sessions>>,
    stopping: Arc<AtomicBool>,
    home: PathBuf,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("webhook".into())
        .spawn(move || {
            let mut open: Option<TcpListener> = None;
            while !stopping.load(Ordering::SeqCst) {
                let wanted = super::triggers::webhook_on(&home);
                match (&open, wanted) {
                    (None, true) => match TcpListener::bind(("127.0.0.1", port(&home))) {
                        Ok(l) => {
                            let _ = l.set_nonblocking(true);
                            open = Some(l);
                        }
                        Err(e) => eprintln!("webhook: port {}: {e}", port(&home)),
                    },
                    (Some(_), false) => open = None,
                    _ => {}
                }
                // Accept for about a second, then look at the triggers again.
                for _ in 0..20 {
                    if let Some(l) = &open
                        && let Ok((stream, _)) = l.accept()
                    {
                        // At most LIVE_MAX requests are read at once: idle connections cannot pile up threads.
                        if LIVE.fetch_add(1, Ordering::SeqCst) >= LIVE_MAX {
                            LIVE.fetch_sub(1, Ordering::SeqCst);
                            drop(stream);
                            continue;
                        }
                        let (registry, stopping, home) =
                            (registry.clone(), stopping.clone(), home.clone());
                        std::thread::spawn(move || {
                            serve(stream, &registry, &stopping, &home);
                            LIVE.fetch_sub(1, Ordering::SeqCst);
                        });
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        })
}

fn answer(mut s: &TcpStream, status: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
}

fn serve(stream: TcpStream, registry: &Mutex<Sessions>, stopping: &AtomicBool, home: &Path) {
    let _ = stream.set_nonblocking(false);
    let deadline = std::time::Instant::now() + REQUEST_DEADLINE;
    // Each read gets only what is left of the request's deadline.
    let left = || {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        (!left.is_zero()).then_some(left)
    };
    let mut reader = BufReader::new(&stream);
    let mut head = vec![];
    let mut line = String::new();
    loop {
        line.clear();
        let Some(left) = left() else { return };
        let _ = stream.set_read_timeout(Some(left));
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) if line == "\r\n" || line == "\n" => break,
            Ok(n) if head.iter().map(String::len).sum::<usize>() + n > HEAD_MAX => {
                return answer(&stream, "431 Request Header Fields Too Large");
            }
            Ok(_) => head.push(line.trim_end().to_string()),
        }
    }
    let Some(request) = head.first() else { return };
    let mut words = request.split_whitespace();
    let (method, path) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
    let header = |name: &str| {
        head.iter().skip(1).find_map(|h| {
            let (k, v) = h.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case(name)
                .then(|| v.trim().to_string())
        })
    };
    let Some(name) = path
        .strip_prefix("/hooks/")
        .filter(|n| crate::approval::valid_name(n))
    else {
        return answer(&stream, "404 Not Found");
    };
    if method != "POST" {
        return answer(&stream, "405 Method Not Allowed");
    }
    let Some(secret) = super::triggers::secret(home, name) else {
        return answer(&stream, "404 Not Found");
    };
    let length = header("content-length")
        .and_then(|l| l.parse::<usize>().ok())
        .unwrap_or(0);
    if length > BODY_MAX {
        return answer(&stream, "413 Payload Too Large");
    }
    let mut body = vec![0; length];
    let Some(left) = left() else { return };
    let _ = stream.set_read_timeout(Some(left));
    if reader.read_exact(&mut body).is_err() {
        return answer(&stream, "400 Bad Request");
    }
    if !signed(
        &secret,
        &body,
        header("x-hub-signature-256"),
        header("x-nunchiro-secret"),
    ) {
        eprintln!("webhook: trigger {name}: a request without its secret was refused");
        return answer(&stream, "401 Unauthorized");
    }
    // The caller learns only that it was taken; the start or the card follows off this request.
    answer(&stream, "202 Accepted");
    let payload = String::from_utf8_lossy(&body).into_owned();
    if let Err(e) = super::triggers::fire(
        registry,
        stopping,
        home,
        name,
        super::triggers::Source::Webhook,
        &payload,
    ) {
        eprintln!("webhook: trigger {name}: {e}");
    }
}

/// GitHub's signature (`sha256=<hex HMAC of the body>`) or the shared secret itself, compared in constant time.
pub(crate) fn signed(
    secret: &str,
    body: &[u8],
    github: Option<String>,
    plain: Option<String>,
) -> bool {
    if let Some(sig) = github {
        let mac: String = super::hmac(secret.as_bytes(), body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        return super::same(&sig, &format!("sha256={mac}"));
    }
    plain.is_some_and(|p| super::same(&p, secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_github_signature_or_the_secret_is_needed() {
        let secret = "s3cret-s3cret-s3cret";
        let body = br#"{"action":"completed"}"#;
        let mac: String = crate::schedule::hmac(secret.as_bytes(), body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(signed(secret, body, Some(format!("sha256={mac}")), None));
        assert!(!signed(secret, body, Some("sha256=00".into()), None));
        assert!(!signed(
            secret,
            b"changed",
            Some(format!("sha256={mac}")),
            None
        ));
        assert!(signed(secret, body, None, Some(secret.into())));
        assert!(!signed(secret, body, None, Some("wrong".into())));
        assert!(!signed(secret, body, None, None));
    }
}
