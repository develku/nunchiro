//! Browse online (V1A-47): the core's fetcher against a fake HTTP server on 127.0.0.1 started by each test. Waits
//! are on request counts and replies; the one deadline (the stall) only turns a hang into a failure.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::themes_online::{self, PIN, Themes};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const INDEX: &str = "# Licence of every colour scheme.\n#\n# comment lines\n\n'0x96f':\n  license: MIT\n  source: https://github.com/filipjanevski/0x96f-term-theme\nAdventure Time:\n  license: unknown\n  source: ''\n  note: 'Not covered by the research in #638.'\n'Dracula+':\n  license: nonfree\n  source: 'https://example.com/it''s'\nMulti Line:\n  license: MIT\n  source: 'https://github.com/a/b\n\n    https://github.com/c/d'\n'\"><img src=x onerror=alert(1)>':\n  license: MIT\n  source: ''\n";
const THEME: &str =
    "palette = 1=#f38ba8\nbackground = #1e1e2e\nforeground = #cdd6f4\nfont-family = Comic Sans\n";

/// What the fake server answers for one request path.
type Route = Box<dyn Fn(&str) -> Answer + Send + Sync>;
enum Answer {
    Bytes(Vec<u8>),
    /// Holds the connection open without answering until the test ends.
    Stall,
}
struct Server {
    port: u16,
    hits: Arc<Mutex<Vec<String>>>,
}
impl Server {
    fn start(route: Route) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(Mutex::new(vec![]));
        let (h, route) = (hits.clone(), Arc::new(route));
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let (h, route) = (h.clone(), route.clone());
                thread::spawn(move || serve(stream, &h, &route));
            }
        });
        Self { port, hits }
    }
    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
    fn count(&self) -> usize {
        self.hits.lock().unwrap().len()
    }
    fn paths(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}
fn serve(mut stream: TcpStream, hits: &Mutex<Vec<String>>, route: &Route) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() || first.is_empty() {
        return;
    }
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
    }
    let path = first.split(' ').nth(1).unwrap_or("").to_string();
    hits.lock().unwrap().push(path.clone());
    match route(&path) {
        Answer::Bytes(b) => {
            let _ = stream.write_all(&b);
        }
        Answer::Stall => thread::sleep(Duration::from_secs(60)),
    }
}
fn ok(body: &[u8]) -> Answer {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    Answer::Bytes(out)
}
fn chunked(body: &[u8]) -> Answer {
    let mut out =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    for c in body.chunks(4096) {
        out.extend_from_slice(format!("{:x}\r\n", c.len()).as_bytes());
        out.extend_from_slice(c);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"0\r\n\r\n");
    Answer::Bytes(out)
}
fn status(code: u16, extra: &str) -> Answer {
    Answer::Bytes(
        format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\n{extra}Connection: close\r\n\r\n")
            .into_bytes(),
    )
}
/// The index at `/licenses.yml`, `THEME` for every `/ghostty/...` path.
fn good() -> Route {
    Box::new(|p| {
        if p == "/licenses.yml" {
            ok(INDEX.as_bytes())
        } else if p.starts_with("/ghostty/") {
            ok(THEME.as_bytes())
        } else {
            status(404, "")
        }
    })
}

fn home() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!(
            "to-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    home
}
fn themes(home: &std::path::Path, server: &Server) -> Themes {
    Themes::with_origin(home, &server.origin(), Duration::from_secs(5)).unwrap()
}
fn cache(home: &std::path::Path) -> PathBuf {
    home.join("theme-cache").join(PIN)
}
fn cached_files(home: &std::path::Path) -> usize {
    fs::read_dir(cache(home)).map_or(0, |d| d.count())
}

#[test]
fn index_parses_names_licences_and_sources_like_update_py() {
    let server = Server::start(good());
    let home = home();
    let list = themes(&home, &server).index().unwrap();
    let got: Vec<(&str, &str, &str)> = list
        .iter()
        .map(|e| (e.name.as_str(), e.license.as_str(), e.source.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            (
                "0x96f",
                "MIT",
                "https://github.com/filipjanevski/0x96f-term-theme"
            ),
            ("Adventure Time", "unknown", ""),
            ("Dracula+", "nonfree", "https://example.com/it's"),
            (
                "Multi Line",
                "MIT",
                "https://github.com/a/b https://github.com/c/d"
            ),
            ("\"><img src=x onerror=alert(1)>", "MIT", ""),
        ]
    );
    assert_eq!(server.paths(), ["/licenses.yml"]);
}

#[test]
fn an_empty_or_wrong_shape_index_is_refused_and_not_cached() {
    for body in [
        "",
        "# only comments\n",
        "Foo:\n  bar: 1\n",
        "A:\n  license: MIT\nB:\n  source: x\n",
    ] {
        let server = Server::start(Box::new(move |_| ok(body.as_bytes())));
        let home = home();
        assert!(themes(&home, &server).index().is_err(), "{body:?} accepted");
        assert_eq!(cached_files(&home), 0, "{body:?} cached");
    }
}

#[test]
fn concurrent_theme_requests_fetch_the_index_once() {
    // v1a-38b (carried from the v1a-47 review): a second click while the index downloads waits for that download
    // instead of failing "already loading"; the index is still fetched once.
    let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let r = release.clone();
    let server = Server::start(Box::new(move |p| {
        if p == "/licenses.yml" {
            while !r.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            ok(INDEX.as_bytes())
        } else {
            ok(THEME.as_bytes())
        }
    }));
    let home = home();
    let call = |f: fn(&Themes) -> Result<String, String>| {
        let (h, origin) = (home.clone(), server.origin());
        thread::spawn(move || f(&Themes::with_origin(&h, &origin, Duration::from_secs(5)).unwrap()))
    };
    let first = call(|t| t.theme("0x96f").map(|t| t.name));
    let until = Instant::now() + Duration::from_secs(10);
    while server.count() < 1 {
        assert!(
            Instant::now() < until,
            "the index fetch never reached the server"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let second = call(|t| t.theme("Adventure Time").map(|t| t.name));
    let index = call(|t| t.index().map(|l| l.len().to_string()));
    thread::sleep(Duration::from_millis(200));
    assert!(
        !second.is_finished() && !index.is_finished(),
        "a caller gave up while the index was loading"
    );
    release.store(true, Ordering::SeqCst);
    assert_eq!(first.join().unwrap().unwrap(), "0x96f");
    assert_eq!(second.join().unwrap().unwrap(), "Adventure Time");
    assert_eq!(index.join().unwrap().unwrap(), "5");
    let mut paths = server.paths();
    paths.sort();
    assert_eq!(
        paths,
        [
            "/ghostty/0x96f",
            "/ghostty/Adventure%20Time",
            "/licenses.yml"
        ]
    );
}

#[test]
fn a_theme_is_fetched_by_its_encoded_name_and_yields_only_validated_colours() {
    let server = Server::start(good());
    let home = home();
    let t = themes(&home, &server);
    let theme = t.theme("Adventure Time").unwrap();
    assert_eq!(theme.name, "Adventure Time");
    assert_eq!(theme.license, "unknown");
    assert_eq!(
        theme.source,
        format!("{}ghostty/Adventure%20Time", server.origin())
    );
    let colors = serde_json::to_value(&theme.colors).unwrap();
    assert_eq!(colors["background"], "#1e1e2e");
    assert_eq!(colors["palette"][1], "#f38ba8");
    // Only the parser's colour keys, all #rrggbb.
    let keys: Vec<&String> = colors.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "background",
            "cursor",
            "cursorText",
            "foreground",
            "palette",
            "selectionBackground",
            "selectionForeground"
        ]
    );
    assert_eq!(
        server.paths(),
        ["/licenses.yml", "/ghostty/Adventure%20Time"]
    );
    t.theme("Dracula+").unwrap();
    t.theme("\"><img src=x onerror=alert(1)>").unwrap();
    assert_eq!(
        server.paths()[2..],
        [
            "/ghostty/Dracula%2B",
            "/ghostty/%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E"
        ]
    );
}

#[test]
fn bodies_over_the_cap_are_refused_with_or_without_content_length_and_nothing_is_cached() {
    let big_index = vec![b'#'; 512 * 1024 + 1];
    let big_theme = {
        let mut b = THEME.as_bytes().to_vec();
        b.resize(64 * 1024 + 1, b'\n');
        b
    };
    for chunk in [false, true] {
        let (bi, bt) = (big_index.clone(), big_theme.clone());
        let send = move |b: &[u8]| if chunk { chunked(b) } else { ok(b) };
        let server = Server::start(Box::new(move |p| {
            if p == "/licenses.yml" {
                send(&bi)
            } else {
                send(&bt)
            }
        }));
        let home = home();
        let err = themes(&home, &server).index().unwrap_err();
        assert!(err.contains("too large"), "chunked={chunk}: {err}");
        assert_eq!(cached_files(&home), 0);
    }
    // A theme over its cap, after a good index.
    for chunk in [false, true] {
        let bt = big_theme.clone();
        let server = Server::start(Box::new(move |p| {
            if p == "/licenses.yml" {
                ok(INDEX.as_bytes())
            } else if chunk {
                chunked(&bt)
            } else {
                ok(&bt)
            }
        }));
        let home = home();
        let err = themes(&home, &server).theme("Adventure Time").unwrap_err();
        assert!(err.contains("too large"), "chunked={chunk}: {err}");
        assert_eq!(cached_files(&home), 1, "only the index is cached");
    }
    // Exactly at the cap is fine.
    let at = {
        let mut b = THEME.as_bytes().to_vec();
        b.resize(64 * 1024, b'\n');
        b
    };
    let server = Server::start(Box::new(move |p| {
        if p == "/licenses.yml" {
            ok(INDEX.as_bytes())
        } else {
            chunked(&at)
        }
    }));
    themes(&home(), &server).theme("Adventure Time").unwrap();
}

#[test]
fn redirects_are_refused_and_never_followed() {
    let other = Server::start(good());
    for location in [
        format!("{}licenses.yml", other.origin()),
        "/licenses2.yml".to_string(),
    ] {
        for code in [301, 302] {
            let loc = location.clone();
            let server = Server::start(Box::new(move |p| {
                if p == "/licenses.yml" {
                    status(code, &format!("Location: {loc}\r\n"))
                } else {
                    ok(INDEX.as_bytes())
                }
            }));
            let home = home();
            let err = themes(&home, &server).index().unwrap_err();
            assert!(err.contains(&format!("HTTP {code}")), "{err}");
            assert_eq!(server.paths(), ["/licenses.yml"], "same host followed");
            assert_eq!(cached_files(&home), 0);
        }
    }
    assert_eq!(other.count(), 0, "the other host saw a request");
}

#[test]
fn not_found_and_server_errors_are_short_errors() {
    for code in [404, 500] {
        let server = Server::start(Box::new(move |_| status(code, "")));
        let home = home();
        let err = themes(&home, &server).index().unwrap_err();
        assert_eq!(err, format!("theme server answered HTTP {code}"));
        assert_eq!(cached_files(&home), 0);
    }
}

#[test]
fn a_stalled_server_gives_a_timeout_error() {
    let server = Server::start(Box::new(|_| Answer::Stall));
    let home = home();
    let t = Themes::with_origin(&home, &server.origin(), Duration::from_secs(1)).unwrap();
    let started = Instant::now();
    let err = t.index().unwrap_err();
    assert!(err.contains("timed out"), "{err}");
    // Bound only: the fetch must not hang past its own deadline.
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(cached_files(&home), 0);
}

#[test]
fn malformed_theme_bodies_from_the_shared_fixture_are_rejected() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../web/tests/fixtures/themes/ghostty-parse.json"
    ))
    .unwrap();
    for case in fixture["malformed"].as_array().unwrap() {
        let body = match case["hex"].as_str() {
            Some(hex) => (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect(),
            None => case["text"].as_str().unwrap().as_bytes().to_vec(),
        };
        assert!(
            themes_online::parse_theme(&body).is_err(),
            "accepted: {}",
            case["name"]
        );
        // Through the fetcher too: refused and not cached.
        let server = Server::start(Box::new(move |p| {
            if p == "/licenses.yml" {
                ok(INDEX.as_bytes())
            } else {
                ok(&body)
            }
        }));
        let home = home();
        assert!(themes(&home, &server).theme("0x96f").is_err());
        assert_eq!(cached_files(&home), 1, "only the index is cached");
    }
}

#[test]
fn valid_theme_bodies_from_the_shared_fixture_parse_like_the_window_parser() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../web/tests/fixtures/themes/ghostty-parse.json"
    ))
    .unwrap();
    for case in fixture["valid"].as_array().unwrap() {
        let colors = themes_online::parse_theme(case["text"].as_str().unwrap().as_bytes())
            .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
        assert_eq!(
            serde_json::to_value(colors).unwrap(),
            case["colors"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn bad_names_are_refused_before_any_request() {
    let server = Server::start(good());
    let home = home();
    let t = themes(&home, &server);
    for name in [
        "a/b",
        "..",
        "x..y",
        "100%",
        "tab\there",
        "new\nline",
        "nul\0",
        "",
    ] {
        assert!(t.theme(name).is_err(), "{name:?} accepted");
    }
    assert_eq!(server.count(), 0);
    // Not in the index: the index is fetched once, the theme never.
    assert!(
        t.theme("Not A Theme")
            .unwrap_err()
            .contains("not in the index")
    );
    assert!(t.theme("Not Another").is_err());
    assert_eq!(server.paths(), ["/licenses.yml"]);
}

#[test]
fn callers_queued_behind_a_failed_index_fetch_get_its_error_without_refetching() {
    let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let r = release.clone();
    let server = Server::start(Box::new(move |_| {
        while !r.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(5));
        }
        status(404, "")
    }));
    let home = home();
    let call = |name: &'static str| {
        let (h, origin) = (home.clone(), server.origin());
        thread::spawn(move || {
            Themes::with_origin(&h, &origin, Duration::from_secs(5))
                .unwrap()
                .theme(name)
                .map(|t| t.name)
        })
    };
    let first = call("0x96f");
    let until = Instant::now() + Duration::from_secs(10);
    while server.count() < 1 {
        assert!(Instant::now() < until, "the index fetch never started");
        thread::sleep(Duration::from_millis(5));
    }
    let queued = [call("Adventure Time"), call("Multi Line")];
    thread::sleep(Duration::from_millis(200));
    release.store(true, Ordering::SeqCst);
    assert!(first.join().unwrap().is_err());
    for q in queued {
        assert!(q.join().unwrap().is_err());
    }
    assert_eq!(
        server.paths(),
        ["/licenses.yml"],
        "a queued caller refetched"
    );
    // A later click, after the failure, fetches again.
    assert!(themes(&home, &server).index().is_err());
    assert_eq!(server.count(), 2);
}

#[test]
fn at_most_one_request_per_name_is_in_flight() {
    let server = Server::start(Box::new(|p| {
        if p == "/licenses.yml" {
            ok(INDEX.as_bytes())
        } else {
            Answer::Stall
        }
    }));
    let home = home();
    let origin = server.origin();
    let h = home.clone();
    let first = thread::spawn(move || {
        Themes::with_origin(&h, &origin, Duration::from_secs(2))
            .unwrap()
            .theme("0x96f")
    });
    let until = Instant::now() + Duration::from_secs(10);
    while server.count() < 2 {
        assert!(
            Instant::now() < until,
            "the first fetch never reached the server"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let err = themes(&home, &server).theme("0x96f").unwrap_err();
    assert!(err.contains("already loading"), "{err}");
    assert_eq!(
        server.count(),
        2,
        "a second request for the same name went out"
    );
    assert!(first.join().unwrap().unwrap_err().contains("timed out"));
}

#[test]
fn cache_hits_make_no_request_and_files_are_private() {
    let server = Server::start(good());
    let home = home();
    let t = themes(&home, &server);
    let first = t.theme("0x96f").unwrap();
    assert_eq!(server.count(), 2);
    let again = themes(&home, &server).theme("0x96f").unwrap();
    themes(&home, &server).index().unwrap();
    assert_eq!(server.count(), 2, "a cache hit went to the network");
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&again).unwrap()
    );
    let dir = cache(&home);
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let mut names = vec![];
    for f in fs::read_dir(&dir).unwrap() {
        let f = f.unwrap();
        assert_eq!(f.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        names.push(f.file_name().into_string().unwrap());
    }
    names.sort();
    // The theme file is named by the sha256 of its name, never the name.
    // `printf %s 0x96f | shasum -a 256`
    assert_eq!(
        names,
        [
            "e9951c7c4091174ae97648fc845dbfc937316881626f155edffb71008478d64e",
            "licenses.yml"
        ]
    );
}

#[test]
fn a_symlinked_cache_dir_is_refused() {
    let server = Server::start(good());
    let home = home();
    let elsewhere = home.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, home.join("theme-cache")).unwrap();
    assert!(themes(&home, &server).index().is_err());
    assert_eq!(server.count(), 0);
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
}

#[test]
fn only_https_or_a_loopback_test_origin_is_accepted() {
    let home = home();
    for bad in [
        "http://example.com/",
        "http://127.0.0.1.example.com/",
        "ftp://127.0.0.1/",
        "file:///etc/",
        "http://127.0.0.1:80/../",
        "https://raw.githubusercontent.com/other/repo/",
    ] {
        assert!(
            Themes::with_origin(&home, bad, Duration::from_secs(1)).is_err(),
            "{bad} accepted"
        );
    }
}

/// The op over the real window WebSocket and owner socket (like tests/http_auth.rs). Only paths that refuse before
/// any request are driven here, so the production origin is never contacted.
mod op {
    use nunchiro_core::{api::*, server::call};
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        net::TcpStream,
        os::unix::net::UnixStream,
        path::PathBuf,
        process::{Child, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

    const ORIGIN: &str = "http://127.0.0.1:4173";

    struct Core {
        home: PathBuf,
        process: Child,
    }
    impl Core {
        fn new() -> Self {
            let home = super::home::short("to");
            let bin = super::cli::path();
            let process = super::home::git_env::scrubbed(bin)
                .arg("serve")
                .env("NUNCHIRO_HOME", &home)
                .env("NUNCHIRO_WINDOW_ORIGINS", ORIGIN)
                .env("PATH", "/usr/bin:/bin")
                .env_remove("NUNCHIRO_TOKEN")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let core = Self { home, process };
            let until = Instant::now() + Duration::from_secs(30);
            while !core.home.join("window.json").exists()
                || !matches!(
                    call(&core.home, Request::Snapshot),
                    Ok(Reply::Snapshot { .. })
                )
            {
                assert!(Instant::now() < until, "core did not become ready");
                thread::sleep(Duration::from_millis(10));
            }
            core
        }
        fn dial(&self, token: Option<&str>) -> Result<tungstenite::WebSocket<TcpStream>, u16> {
            let v = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
            let port = v["port"].as_u64().unwrap() as u16;
            let mut req = format!("ws://127.0.0.1:{port}/ws")
                .into_client_request()
                .unwrap();
            req.headers_mut()
                .insert("Origin", HeaderValue::from_static(ORIGIN));
            let protocols = match token {
                Some(t) => format!("nunchiro.v1, nunchiro.token.{t}"),
                None => format!(
                    "nunchiro.v1, nunchiro.token.{}",
                    v["token"].as_str().unwrap()
                ),
            };
            req.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_str(&protocols).unwrap(),
            );
            let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            match tungstenite::client(req, stream) {
                Ok((ws, _)) => Ok(ws),
                Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => {
                    Err(r.status().as_u16())
                }
                Err(e) => panic!("unexpected handshake error: {e}"),
            }
        }
    }
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = call(&self.home, Request::Stop);
            let _ = self.process.kill();
            let _ = self.process.wait();
            let _ = fs::remove_dir_all(&self.home);
        }
    }
    fn reply(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64) -> serde_json::Value {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < until, "no reply for {id}");
            if let Message::Text(t) = ws.read().unwrap() {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["id"] == id {
                    return v["response"].clone();
                }
            }
        }
    }

    #[test]
    fn the_window_op_answers_and_refuses_a_bad_name_before_any_fetch() {
        let core = Core::new();
        let mut ws = core.dial(None).expect("authorized dial");
        for (id, name) in [(1, "../../etc/passwd"), (2, "a/b"), (3, "x%2Fy")] {
            let frame = serde_json::json!({"id":id,"request":{"op":"theme_file","name":name}});
            ws.send(Message::Text(frame.to_string().into())).unwrap();
            assert_eq!(
                reply(&mut ws, id),
                serde_json::json!({"Err":"not a theme name"})
            );
        }
        // Other window requests still work beside it.
        let frame = serde_json::json!({"id":4,"request":{"op":"list"}});
        ws.send(Message::Text(frame.to_string().into())).unwrap();
        assert!(reply(&mut ws, 4).get("Ok").is_some());
        assert!(!core.home.join("theme-cache").exists());
    }

    #[test]
    fn without_the_window_token_the_op_never_runs() {
        let core = Core::new();
        assert_eq!(core.dial(Some("wrong")).err(), Some(401));
        assert_eq!(core.dial(Some("")).err(), Some(401));
        assert!(!core.home.join("theme-cache").exists());
    }

    #[test]
    fn the_owner_socket_refuses_the_op() {
        let core = Core::new();
        let token = fs::read_to_string(core.home.join("core.token")).unwrap();
        for request in [
            serde_json::json!({"op":"theme_index"}),
            serde_json::json!({"op":"theme_file","name":"0x96f"}),
        ] {
            let mut s = UnixStream::connect(core.home.join("core.sock")).unwrap();
            let env = serde_json::json!({"token":token.trim(),"request":request});
            s.write_all(format!("{env}\n").as_bytes()).unwrap();
            let mut line = String::new();
            BufReader::new(&s).read_line(&mut line).unwrap();
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            let err = v["Err"].as_str().unwrap_or_else(|| panic!("accepted: {v}"));
            assert!(err.contains("unknown variant"), "{err}");
        }
        assert!(!core.home.join("theme-cache").exists());
    }
}
