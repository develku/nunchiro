//! V2-10c (needs 91): the library cache. `Libs` against a fake CDN on 127.0.0.1 (fixtures/libs/origin.rs); the
//! window-only ops against a real core. Fixture hashes were computed with `openssl dgst` (an independent source).
#[path = "fixtures/gh_pin.rs"]
mod gh_pin;
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
#[path = "fixtures/libs/origin.rs"]
mod origin;
use nunchiro_core::{
    api::{AgentKind, Reply, Request, StartSession},
    libs::{
        self, Badge, ENTRIES_CAP, FILE_CAP, Libs, Manifest, Resolved, STORE_CAP,
        grammar::{self, Tuple},
    },
    server::call,
};
use origin::{Answer, Origin, ok, ok_bytes, status};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const CHART: &str = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const CHART_PATH: &str = "/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const HELPERS: &str = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/helpers.js";
const JSDELIVR: &str = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
/// `openssl dgst -sha384` of fixtures/libs/chart.umd.min.js.
const CHART_SHA384: &str = "f3b21d57324b58b9038c88a7c7fc54356dfe9eca01745dd7dfb5f861ef1702dcc99e4e90ea025ffaca1090086e2687bd";
const CHART_SHA384_B64: &str = "87IdVzJLWLkDjIinx/xUNW3+nsoBdF3X37X4Ye8XAtzJnk6Q6gJf+soQkAhuJoe9";
const CHART_SHA256_B64: &str = "UmvksS/Hbqo+OwSfsvLYcPjXkSDd02IJjJOGAxZPxQ4=";
const TEXT3: &str = "Nunchiro cannot pin this library address: it needs a package, an exact version and a file, with no query or encoded characters.";

fn fixture(name: &str) -> Vec<u8> {
    fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/libs")
            .join(name),
    )
    .unwrap()
}
fn chart() -> Vec<u8> {
    fixture("chart.umd.min.js")
}
/// The shipped manifest's shape around the cdnjs API answer kept in fixtures/libs (`{"sri": {...}}`).
fn manifest() -> String {
    let api: Value = serde_json::from_slice(&fixture("cdnjs-Chart.js-4.4.1.json")).unwrap();
    json!({"version":1,"source":"fixture","generated":"2026-10-28",
        "libraries":{"Chart.js":{"4.4.1":api["sri"]}}})
    .to_string()
}
fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!(
            "lb-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    home
}
fn libs_at(home: &Path, origin: &Origin) -> Libs {
    Libs::with_origin(home, &origin.origin(), Duration::from_secs(5), &manifest()).unwrap()
}
/// Serves the Chart.js fixture at both its cdnjs and jsDelivr paths, 404 elsewhere.
fn chart_origin() -> Origin {
    Origin::start(Box::new(|p| {
        if p == CHART_PATH || p == "/npm/chart.js@4.4.1/dist/chart.umd.min.js" {
            ok(&chart())
        } else {
            status(404, "")
        }
    }))
}
/// Ticket 366: Chart.js is auto-allowed by default; tests about something else turn it off first, so no background
/// fetch runs beside them.
fn chart_auto_off(libs: &Libs) {
    libs.auto_allow("cdnjs.cloudflare.com", "Chart.js", false)
        .unwrap();
}
fn resolve1(libs: &Libs, url: &str) -> Resolved {
    libs.resolve(&[url.to_string()], "session-1")
        .unwrap()
        .remove(0)
}
fn pinned(r: &Resolved) -> bool {
    matches!(r, Resolved::Pinned { .. })
}
fn store_files(home: &Path) -> usize {
    fs::read_dir(home.join("libs/sha384")).map_or(0, |d| d.count())
}
fn wait_pinned(libs: &Libs, url: &str) {
    let until = Instant::now() + Duration::from_secs(10);
    while !pinned(&resolve1(libs, url)) {
        assert!(Instant::now() < until, "{url} never pinned");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn unpinned_version_is_refused_with_reason() {
    let text1 = |lib: &str| {
        format!(
            "`{lib}` has no exact version. Only exact versions load, as in Claude.ai artifacts: ask for `{lib}@1.2.3`, not `@4` or `@latest`."
        )
    };
    let cases = [
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/latest/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/^4.4.1/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/~4.4.1/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.x/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/>=4.0.0/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1+build/chart.min.js",
        ),
        (
            "Chart.js",
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/chart.min.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@4.4/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@latest/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@next/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@^4.4.1/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js@~4.4.1/dist/chart.umd.js",
        ),
        (
            "chart.js",
            "https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js",
        ),
        (
            "@tailwindcss/browser",
            "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
        ),
        ("chart.js", "https://unpkg.com/chart.js@4/dist/chart.umd.js"),
        (
            "chart.js",
            "https://unpkg.com/chart.js@latest/dist/chart.umd.js",
        ),
        ("chart.js", "https://unpkg.com/chart.js@*/dist/chart.umd.js"),
        ("chart.js", "https://unpkg.com/chart.js/dist/chart.umd.js"),
        ("jquery", "https://code.jquery.com/jquery-3.js"),
        ("jquery", "https://code.jquery.com/jquery-3.7.min.js"),
        ("jquery", "https://code.jquery.com/jquery-latest.min.js"),
        ("jquery", "https://code.jquery.com/jquery.js"),
        ("tailwindcss", "https://cdn.tailwindcss.com"),
        ("tailwindcss", "https://cdn.tailwindcss.com/"),
        (
            "tailwindcss",
            "https://cdn.tailwindcss.com?plugins=forms,typography",
        ),
        ("tailwindcss", "https://cdn.tailwindcss.com/?plugins=forms"),
        ("tailwindcss", "https://cdn.tailwindcss.com/3"),
        ("tailwindcss", "https://cdn.tailwindcss.com/3.4"),
    ];
    for (lib, url) in cases {
        let r = grammar::parse(url).expect_err(url);
        assert_eq!(
            (r.text, r.message.as_str()),
            (1, text1(lib).as_str()),
            "{url}"
        );
    }
    let r = grammar::parse("https://cdn.example.com/chart.js@4.4.1/a.js").unwrap_err();
    assert_eq!(
        (r.text, r.message.as_str()),
        (
            2,
            "`cdn.example.com` is not a library host. Libraries load only from cdnjs, jsDelivr, unpkg, Tailwind's CDN and code.jquery.com."
        )
    );
    let r = grammar::parse("https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/a.js?v=1")
        .unwrap_err();
    assert_eq!((r.text, r.message.as_str()), (3, TEXT3));
    // Each host's exact form is a key, and the URL rebuilt from it is the one asked for.
    let exact = [
        (
            CHART,
            (
                "cdnjs.cloudflare.com",
                "Chart.js",
                "4.4.1",
                "chart.umd.min.js",
            ),
        ),
        (
            "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.0-beta.2/dist/index.global.js",
            (
                "cdn.jsdelivr.net",
                "@tailwindcss/browser",
                "4.1.0-beta.2",
                "dist/index.global.js",
            ),
        ),
        (
            "https://unpkg.com/d3@7.9.0/dist/d3.min.js",
            ("unpkg.com", "d3", "7.9.0", "dist/d3.min.js"),
        ),
        (
            "https://code.jquery.com/jquery-3.7.1.slim.min.js",
            (
                "code.jquery.com",
                "jquery",
                "3.7.1",
                "jquery-3.7.1.slim.min.js",
            ),
        ),
        (
            "https://cdn.tailwindcss.com/3.4.16",
            ("cdn.tailwindcss.com", "tailwindcss", "3.4.16", ""),
        ),
    ];
    for (url, (host, library, version, file)) in exact {
        let t = grammar::parse(url).unwrap();
        assert_eq!(
            t,
            Tuple {
                host: host.into(),
                library: library.into(),
                version: version.into(),
                file: file.into()
            }
        );
        assert_eq!(t.url(), url);
    }
}

#[test]
fn cache_key_rejects_traversal_and_encoding_tricks() {
    for url in [
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/%2e%2e/x.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart%2Emin.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/../x.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/./chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/../libs/Chart.js/4.4.1/chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1//chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js/",
        "https://cdnjs.cloudflare.com//ajax/libs/Chart.js/4.4.1/chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1\\chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js?",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js#x",
        "https://user@cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "https://cdnjs.cloudflare.com:443/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "http://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "//cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "HTTPS://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "https://CDNJS.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chärt.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/a@b.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1",
        // npm: scope confusion, upper case, no file, the refused forms.
        "https://cdn.jsdelivr.net/npm/@org@1.2.3/a.js",
        "https://cdn.jsdelivr.net/npm/@Org/pkg@1.2.3/a.js",
        "https://cdn.jsdelivr.net/npm/@org/@pkg@1.2.3/a.js",
        "https://cdn.jsdelivr.net/npm/Chart.js@4.4.1/dist/chart.umd.js",
        "https://cdn.jsdelivr.net/npm/chart.js@4.4.1",
        "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/",
        "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm",
        "https://cdn.jsdelivr.net/gh/chartjs/Chart.js@4.4.1/dist/chart.umd.js",
        "https://cdn.jsdelivr.net/combine/npm/chart.js@4.4.1/a.js",
        "https://unpkg.com/chart.js@4.4.1/dist/chart.umd.js?module",
        "https://unpkg.com/.bin@1.2.3/a.js",
        "https://unpkg.com/_x@1.2.3/a.js",
        "https://code.jquery.com/ui/1.13.2/jquery-ui.min.js",
        "https://code.jquery.com/jquery-3.7.1.css",
        "https://cdn.tailwindcss.com/3.4.16/",
        "https://cdn.tailwindcss.com/3.4.16/x.js",
    ] {
        let r = grammar::parse(url);
        assert!(r.is_err(), "{url} gave {r:?}");
        assert_ne!(
            r.unwrap_err().text,
            2,
            "{url}: a library host, not an unknown one"
        );
    }
    // Scope confusion never aliases: `org/pkg` is not `@org/pkg`.
    let scoped = grammar::parse("https://cdn.jsdelivr.net/npm/@org/pkg@1.2.3/a.js").unwrap();
    assert_eq!(scoped.library, "@org/pkg");
    assert!(grammar::parse("https://cdn.jsdelivr.net/npm/org/pkg@1.2.3/a.js").is_err());
    // cdnjs keeps case: two different keys, two different paths.
    let upper = grammar::parse(CHART).unwrap();
    let lower =
        grammar::parse("https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js")
            .unwrap();
    assert_ne!(upper, lower);
    assert_ne!(upper.path(), lower.path());
    // Store paths come from 96 lowercase hex characters only.
    assert!(libs::valid_hash(CHART_SHA384));
    for bad in [
        CHART_SHA384.to_uppercase(),
        CHART_SHA384[..95].to_string(),
        format!("{CHART_SHA384}0"),
        format!("../{}", &CHART_SHA384[3..]),
        format!("{}/", &CHART_SHA384[..95]),
        "g".repeat(96),
    ] {
        assert!(!libs::valid_hash(&bad), "{bad}");
    }
    let home = scratch();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    l.allow(CHART, None, "s").unwrap();
    let (entry, path) = l.served(CHART_SHA384).unwrap();
    assert_eq!(path, home.join("libs/sha384").join(CHART_SHA384));
    assert_eq!(entry.library, "Chart.js");
    assert!(l.served(&CHART_SHA384.to_uppercase()).is_none());
    assert!(l.served("../libs.json").is_none());
    assert!(
        l.served(&"0".repeat(96)).is_none(),
        "a valid hash no entry names"
    );
}

#[test]
fn approved_library_is_fetched_once_and_served_offline() {
    let home = scratch();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    assert!(matches!(resolve1(&l, CHART), Resolved::NeedsCard { .. }));
    assert_eq!(o.count(), 0, "resolve fetches nothing without Allow");
    let entry = l.allow(CHART, None, "session-1").unwrap();
    assert_eq!(entry.sha384, CHART_SHA384);
    assert_eq!(entry.size, chart().len() as u64);
    assert_eq!(entry.first_requester, "session-1");
    assert_eq!(o.count(), 1);
    o.stop();
    assert_eq!(
        resolve1(&l, CHART),
        Resolved::Pinned {
            sha384: CHART_SHA384.into()
        }
    );
    // A second Allow and a restarted core serve it with no request.
    l.allow(CHART, None, "session-2").unwrap();
    let again = libs_at(&home, &o);
    assert_eq!(
        resolve1(&again, CHART),
        Resolved::Pinned {
            sha384: CHART_SHA384.into()
        }
    );
    assert_eq!(again.list().0[0].first_requester, "session-1");
    assert_eq!(o.count(), 1);
    assert_eq!(
        fs::read(home.join("libs/sha384").join(CHART_SHA384)).unwrap(),
        chart()
    );
    let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(home.join("libs")), 0o700);
    assert_eq!(mode(home.join("libs/sha384")), 0o700);
    assert_eq!(mode(home.join("libs/libs.json")), 0o600);
    assert_eq!(mode(home.join("libs/sha384").join(CHART_SHA384)), 0o600);
    let lock: Value =
        serde_json::from_slice(&fs::read(home.join("libs/libs.json")).unwrap()).unwrap();
    assert_eq!(lock["version"], 2);
    assert_eq!(lock["entries"][0]["path"], CHART_PATH);
    assert_eq!(lock["entries"][0]["badge"], "verified");
    let _ = fs::remove_dir_all(home);
}

#[test]
fn same_version_different_hash_is_refused() {
    let home = scratch();
    let changed = Arc::new(AtomicBool::new(false));
    let c = changed.clone();
    let o = Origin::start(Box::new(move |_| {
        if c.load(Ordering::SeqCst) {
            ok(b"window.Chart = 'swapped';")
        } else {
            ok(&chart())
        }
    }));
    // jsDelivr: off the manifest, so only the pin can catch the change.
    let l = libs_at(&home, &o);
    l.allow(JSDELIVR, None, "s").unwrap();
    let lock = fs::read(home.join("libs/libs.json")).unwrap();
    let stored = home.join("libs/sha384").join(CHART_SHA384);
    // A missing stored file: the card shows again.
    fs::remove_file(&stored).unwrap();
    assert!(matches!(resolve1(&l, JSDELIVR), Resolved::NeedsCard { .. }));
    changed.store(true, Ordering::SeqCst);
    assert_eq!(
        l.allow(JSDELIVR, None, "s").unwrap_err(),
        "`chart.js` `4.4.1` from `cdn.jsdelivr.net` changed since you allowed it. Nunchiro kept your copy and refused the new file."
    );
    assert_eq!(fs::read(home.join("libs/libs.json")).unwrap(), lock);
    assert_eq!(l.list().0[0].sha384, CHART_SHA384);
    assert_eq!(store_files(&home), 0, "nothing of the new file saved");
    // A changed stored file is not served either; a refetch equal to the pin repairs it.
    fs::write(&stored, b"tampered").unwrap();
    assert!(matches!(resolve1(&l, JSDELIVR), Resolved::NeedsCard { .. }));
    changed.store(false, Ordering::SeqCst);
    l.allow(JSDELIVR, None, "s").unwrap();
    assert_eq!(
        resolve1(&l, JSDELIVR),
        Resolved::Pinned {
            sha384: CHART_SHA384.into()
        }
    );
    assert_eq!(fs::read(&stored).unwrap(), chart());
    assert_eq!(fs::read(home.join("libs/libs.json")).unwrap(), lock);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn concurrent_requests_for_one_library_fetch_once() {
    let home = scratch();
    let (now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (n, m) = (now.clone(), most.clone());
    let o = Origin::start(Box::new(move |p| {
        let k = n.fetch_add(1, Ordering::SeqCst) + 1;
        m.fetch_max(k, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(300));
        n.fetch_sub(1, Ordering::SeqCst);
        ok(format!("/* {p} */").as_bytes())
    }));
    let l = libs_at(&home, &o);
    let one = "https://unpkg.com/d3@7.9.0/dist/d3.min.js";
    // A bounded wait: a hang fails the test in a minute instead of holding the run for good.
    let (tx, rx) = std::sync::mpsc::channel();
    for _ in 0..4 {
        let (l, tx) = (l.clone(), tx.clone());
        thread::spawn(move || tx.send(l.allow(one, None, "s").unwrap().sha384));
    }
    let hashes: Vec<String> = (0..4)
        .map(|_| {
            rx.recv_timeout(Duration::from_secs(60))
                .expect("a concurrent allow hung or panicked")
        })
        .collect();
    assert!(hashes.iter().all(|h| *h == hashes[0]));
    assert_eq!(o.count(), 1, "one fetch per tuple");
    // Five different files: at most two fetches in flight.
    let (tx, rx) = std::sync::mpsc::channel();
    for i in 0..5 {
        let (l, tx) = (l.clone(), tx.clone());
        thread::spawn(move || {
            let url = format!("https://unpkg.com/d3@7.9.0/dist/f{i}.js");
            tx.send(l.allow(&url, None, "s").unwrap().sha384)
        });
    }
    for _ in 0..5 {
        rx.recv_timeout(Duration::from_secs(60))
            .expect("a concurrent allow hung or panicked");
    }
    assert_eq!(o.count(), 6);
    assert_eq!(most.load(Ordering::SeqCst), 2);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn broken_lockfile_is_set_aside_not_served() {
    // A real entry to break, and its stored file.
    let seed = scratch();
    let o = chart_origin();
    libs_at(&seed, &o).allow(CHART, None, "s").unwrap();
    let good: Value =
        serde_json::from_slice(&fs::read(seed.join("libs/libs.json")).unwrap()).unwrap();
    let with = |f: &dyn Fn(&mut Value)| {
        let mut v = good.clone();
        f(&mut v);
        v.to_string()
    };
    let cases = [
        "not json".to_string(),
        with(&|v| v["version"] = json!(3)),
        with(&|v| v["entries"] = json!("x")),
        with(&|v| {
            v["entries"][0]
                .as_object_mut()
                .unwrap()
                .remove("sha512")
                .map(drop)
                .unwrap()
        }),
        with(&|v| v["entries"][0]["size"] = json!("1")),
        with(&|v| v["entries"][0]["badge"] = json!("maybe")),
        with(&|v| v["extra"] = json!(1)),
        // Broken relations: the path is another library's, the hash is not a store name, a duplicate key.
        with(&|v| v["entries"][0]["path"] = json!("/ajax/libs/chart.js/4.4.1/chart.umd.min.js")),
        with(&|v| v["entries"][0]["sha384"] = json!(format!("../{}", &CHART_SHA384[3..]))),
        with(&|v| {
            let e = v["entries"][0].clone();
            v["entries"].as_array_mut().unwrap().push(e);
        }),
        with(&|v| v["auto_allow"] = json!([{"host":"unpkg.com","library":"d3"}])),
        // Spec review MUST 1: a verified badge off cdnjs; one hash with two sha512 or two sizes; a bad or repeated
        // auto-allow library.
        with(&|v| {
            let mut e = v["entries"][0].clone();
            e["host"] = json!("cdn.jsdelivr.net");
            e["path"] = json!("/npm/chart.js@4.4.1/dist/chart.umd.min.js");
            e["library"] = json!("chart.js");
            e["file"] = json!("dist/chart.umd.min.js");
            v["entries"] = json!([e]);
        }),
        with(&|v| {
            let mut e = v["entries"][0].clone();
            e["host"] = json!("cdn.jsdelivr.net");
            e["path"] = json!("/npm/chart.js@4.4.1/dist/chart.umd.min.js");
            e["library"] = json!("chart.js");
            e["file"] = json!("dist/chart.umd.min.js");
            e["badge"] = json!("unverified");
            e["sha512"] = json!("0".repeat(128));
            v["entries"].as_array_mut().unwrap().push(e);
        }),
        with(&|v| {
            let mut e = v["entries"][0].clone();
            e["host"] = json!("cdn.jsdelivr.net");
            e["path"] = json!("/npm/chart.js@4.4.1/dist/chart.umd.min.js");
            e["library"] = json!("chart.js");
            e["file"] = json!("dist/chart.umd.min.js");
            e["badge"] = json!("unverified");
            e["size"] = json!(1);
            v["entries"].as_array_mut().unwrap().push(e);
        }),
        with(&|v| v["auto_allow"] = json!([{"host":"cdnjs.cloudflare.com","library":"../x"}])),
        with(&|v| v["auto_allow"] = json!([{"host":"cdnjs.cloudflare.com","library":""}])),
        with(&|v| {
            v["auto_allow"] = json!([{"host":"cdnjs.cloudflare.com","library":"d3"},
                {"host":"cdnjs.cloudflare.com","library":"d3"}])
        }),
    ];
    for body in cases {
        let home = scratch();
        fs::create_dir_all(home.join("libs/sha384")).unwrap();
        fs::copy(
            seed.join("libs/sha384").join(CHART_SHA384),
            home.join("libs/sha384").join(CHART_SHA384),
        )
        .unwrap();
        fs::write(home.join("libs/libs.json"), &body).unwrap();
        let l = libs_at(&home, &o);
        assert!(
            !pinned(&resolve1(&l, CHART)),
            "served from a set-aside lockfile: {body}"
        );
        assert!(l.served(CHART_SHA384).is_none(), "{body}");
        let (entries, _, saved) = l.list();
        assert!(entries.is_empty() && !saved, "{body}");
        // Pins made now last until exit; the file is never overwritten.
        l.allow(JSDELIVR, None, "s").unwrap();
        assert!(pinned(&resolve1(&l, JSDELIVR)), "{body}");
        l.auto_allow("cdnjs.cloudflare.com", "d3", true).unwrap();
        assert_eq!(
            fs::read_to_string(home.join("libs/libs.json")).unwrap(),
            body
        );
        assert!(!pinned(&resolve1(&libs_at(&home, &o), JSDELIVR)), "{body}");
        let _ = fs::remove_dir_all(home);
    }
    let _ = fs::remove_dir_all(seed);
}

#[test]
fn library_fetch_sends_only_the_rebuilt_url() {
    let home = scratch();
    let o = Origin::start(Box::new(|_| ok(&chart())));
    let l = libs_at(&home, &o);
    let urls = [
        CHART,
        JSDELIVR,
        "https://unpkg.com/@scope/pkg@1.0.0-rc.1/dist/a.min.js",
        "https://code.jquery.com/jquery-3.7.1.min.js",
        "https://cdn.tailwindcss.com/3.4.16",
    ];
    for url in urls {
        l.allow(
            url,
            Some(&format!("sha384-{CHART_SHA384_B64}")),
            "artifact-7f3a session-secret-42",
        )
        .unwrap();
    }
    let reqs = o.requests();
    assert_eq!(reqs.len(), urls.len());
    for (raw, url) in reqs.iter().zip(urls) {
        let path = &url[url[8..].find('/').map_or(url.len(), |i| i + 8)..];
        assert_eq!(
            raw[0],
            format!("GET {path} HTTP/1.1"),
            "the URL rebuilt from the tuple"
        );
        let mut names: Vec<String> = raw[1..]
            .iter()
            .map(|h| h.split(':').next().unwrap().to_ascii_lowercase())
            .collect();
        names.sort();
        assert_eq!(names, ["accept", "host", "user-agent"], "{raw:?}");
        let all = raw.join("\n");
        for leak in [
            "artifact",
            "session",
            "secret",
            "Cookie",
            "Referer",
            "Authorization",
            "sha384",
        ] {
            assert!(!all.contains(leak), "{leak} left in {raw:?}");
        }
    }
    let _ = fs::remove_dir_all(home);
}

#[test]
fn fetch_keeps_only_a_non_empty_200_and_follows_no_redirect() {
    let home = scratch();
    let big = vec![b'x'; FILE_CAP + 1];
    let o = Origin::start(Box::new(move |p| match p {
        "/a@1.0.0/redirect.js" => status(301, "Location: /a@1.0.0/target.js\r\n"),
        "/a@1.0.0/found.js" => status(302, "Location: /a@1.0.0/target.js\r\n"),
        "/a@1.0.0/missing.js" => status(404, ""),
        "/a@1.0.0/error.js" => status(500, ""),
        "/a@1.0.0/empty.js" => ok(b""),
        "/a@1.0.0/big.js" => ok(&big),
        "/a@1.0.0/slow.js" => Answer::Late(Duration::from_secs(4), ok_bytes(b"late")),
        _ => ok(b"window.target = 1;"),
    }));
    let l = Libs::with_origin(&home, &o.origin(), Duration::from_secs(1), &manifest()).unwrap();
    let reach = "Could not reach `unpkg.com`. `a` `1.0.0` loads once it has been fetched.";
    let cap = "`a` `1.0.0` is larger than 8 MB, took longer than 30 seconds, or the library cache is full (256 MB). It was not saved.";
    for (file, want) in [
        ("redirect.js", reach),
        ("found.js", reach),
        ("missing.js", reach),
        ("error.js", reach),
        ("empty.js", reach),
        ("big.js", cap),
        ("slow.js", cap),
    ] {
        let url = format!("https://unpkg.com/a@1.0.0/{file}");
        assert_eq!(l.allow(&url, None, "s").unwrap_err(), want, "{file}");
        assert!(!pinned(&resolve1(&l, &url)), "{file}");
    }
    assert!(
        !o.paths().iter().any(|p| p.ends_with("target.js")),
        "a redirect was followed: {:?}",
        o.paths()
    );
    assert!(l.list().0.is_empty());
    assert_eq!(store_files(&home), 0);
    // The upstream Content-Type (text/html here) is ignored: a 200 with a body is kept.
    assert!(
        l.allow("https://unpkg.com/a@1.0.0/ok.js", None, "s")
            .is_ok()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn manifest_match_shows_verified_and_off_manifest_unverified() {
    let home = scratch();
    let o = Origin::start(Box::new(|_| ok(&chart())));
    let l = libs_at(&home, &o);
    chart_auto_off(&l);
    let card = |url: &str| match resolve1(&l, url) {
        Resolved::NeedsCard { listed, auto, .. } => (listed, auto),
        r => panic!("{url}: {r:?}"),
    };
    assert_eq!(card(CHART), (true, false), "cdnjs lists this version");
    assert_eq!(card(JSDELIVR), (false, false));
    let off = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js";
    assert_eq!(card(off), (false, false));
    assert_eq!(l.allow(CHART, None, "s").unwrap().badge, Badge::Verified);
    // Identical bytes from jsDelivr, and an unlisted cdnjs version, stay unverified.
    assert_eq!(
        l.allow(JSDELIVR, None, "s").unwrap().badge,
        Badge::Unverified
    );
    assert_eq!(l.allow(off, None, "s").unwrap().badge, Badge::Unverified);
    // The other versions of a pinned host, library and file are the "Open with" candidates.
    match resolve1(
        &l,
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.2/chart.umd.min.js",
    ) {
        Resolved::NeedsCard {
            mut other_versions,
            message,
            ..
        } => {
            other_versions.sort();
            assert_eq!(other_versions, ["4.4.0", "4.4.1"]);
            assert_eq!(
                message,
                "`Chart.js` `4.4.2` is not on this Mac yet. Allow it to fetch it once; until then nothing is fetched."
            );
        }
        r => panic!("{r:?}"),
    }
    let _ = fs::remove_dir_all(home);
}

#[test]
fn shipped_manifest_is_cdnjs_only_small_and_from_the_cdnjs_api() {
    let text = include_str!("../data/cdnjs-sri.json");
    assert!(text.len() <= 1024 * 1024);
    let v: Value = serde_json::from_str(text).unwrap();
    assert_eq!(
        v["source"],
        "https://api.cdnjs.com/libraries/<Lib>/<version>?fields=sri"
    );
    assert!(v["generated"].as_str().is_some_and(|d| d.len() == 10));
    let m = Manifest::parse(text).unwrap();
    // The value api.cdnjs.com answered for Chart.js 4.4.1 on 2026-10-28.
    let t = grammar::parse(CHART).unwrap();
    assert_eq!(
        m.expect(&t),
        Some(
            "sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw=="
        )
    );
    assert_eq!(
        m.expect(&grammar::parse(JSDELIVR).unwrap()),
        None,
        "cdnjs paths only"
    );
    let lower =
        grammar::parse("https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js")
            .unwrap();
    assert_eq!(m.expect(&lower), None, "case kept");
}

#[test]
fn page_integrity_is_checked_in_its_strongest_algorithm() {
    let home = scratch();
    let o = Origin::start(Box::new(|_| ok(&chart())));
    let l = libs_at(&home, &o);
    let bad384 = "sha384-AAAAVzJLWLkDjIinx/xUNW3+nsoBdF3X37X4Ye8XAtzJnk6Q6gJf+soQkAhuJoe9";
    let refused =
        "`chart.js` `4.4.1` does not match the integrity hash in the page. It was not saved.";
    for integrity in [
        format!("sha256-{CHART_SHA256_B64} {bad384}"),
        format!("sha512-AAAA sha256-{CHART_SHA256_B64}"),
        bad384.to_string(),
    ] {
        assert_eq!(
            l.allow(JSDELIVR, Some(&integrity), "s").unwrap_err(),
            refused,
            "{integrity}"
        );
        assert!(
            l.list().0.is_empty() && store_files(&home) == 0,
            "{integrity}"
        );
    }
    // Several values of the strongest algorithm: any one may match; options after `?` are not part of it.
    l.allow(
        JSDELIVR,
        Some(&format!(
            "{bad384} sha384-{CHART_SHA384_B64}?opt sha256-AAAA"
        )),
        "s",
    )
    .unwrap();
    // A pinned file is checked against each page's own integrity; the entry does not change.
    assert_eq!(l.allow(JSDELIVR, Some(bad384), "s").unwrap_err(), refused);
    assert!(
        l.allow(JSDELIVR, Some(&format!("sha256-{CHART_SHA256_B64}")), "s")
            .is_ok()
    );
    // No known algorithm: SRI does not block, nor does this.
    let other = "https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js";
    assert!(l.allow(other, Some("md5-abc"), "s").is_ok());
    // Each refused fetch kept nothing, so each new Allow fetched; the pinned one was checked without a fetch.
    assert_eq!(o.count(), 5);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn auto_allow_applies_only_to_manifest_matching_exact_versions() {
    let home = scratch();
    let o = Origin::start(Box::new(|p| {
        if p == CHART_PATH {
            ok(&chart())
        } else {
            // helpers.js is listed with the fixture's hash; these bytes do not match it.
            ok(b"window.notTheListedFile = 1;")
        }
    }));
    let l = libs_at(&home, &o);
    let card = |url: &str| match resolve1(&l, url) {
        Resolved::NeedsCard { auto, .. } => auto,
        r => panic!("{url}: {r:?}"),
    };
    // Chart.js is a default (ticket 366); this test turns it off, then on.
    chart_auto_off(&l);
    assert!(!card(CHART), "off once turned off");
    assert_eq!(
        l.auto_allow("cdn.jsdelivr.net", "chart.js", true)
            .unwrap_err(),
        "auto-allow is only for cdnjs libraries"
    );
    assert!(l.auto_allow("cdnjs.cloudflare.com", "../x", true).is_err());
    l.auto_allow("cdnjs.cloudflare.com", "Chart.js", true)
        .unwrap();
    assert_eq!(o.count(), 0, "switching it on fetches nothing");
    assert!(card(CHART));
    wait_pinned(&l, CHART);
    assert_eq!(l.list().0[0].badge, Badge::Verified);
    // Off the manifest (another version), another library, another host, another case: still a card.
    for url in [
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js",
        JSDELIVR,
    ] {
        assert!(!card(url), "{url}");
    }
    assert_eq!(o.count(), 1);
    // A manifest mismatch is refused: by Allow with text 5, and an auto-allowed fetch keeps nothing.
    assert!(card(HELPERS));
    let until = Instant::now() + Duration::from_secs(10);
    while o.count() < 2 {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        l.allow(HELPERS, None, "s").unwrap_err(),
        "`Chart.js` `4.4.1` from `cdnjs.cloudflare.com` does not match the hash cdnjs published. It was not saved."
    );
    assert!(!pinned(&resolve1(&l, HELPERS)));
    assert_eq!(l.list().0.len(), 1);
    // The switch is stored per (host, library) and survives a restart; off stops it.
    let chart_on = |l: &Libs| {
        l.list().1.contains(&libs::AutoAllow {
            host: "cdnjs.cloudflare.com".into(),
            library: "Chart.js".into(),
        })
    };
    let again = libs_at(&home, &o);
    assert!(chart_on(&again));
    chart_auto_off(&again);
    assert!(!chart_on(&libs_at(&home, &o)));
    let _ = fs::remove_dir_all(home);
}

// Ticket 366: a manifest listing the fixture as Chart.js 4.4.1 (a default) and as moment.js 2.30.1 (not a default),
// served at both paths, so the only difference between the two is the default set.
const MOMENT: &str = "https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.30.1/chart.umd.min.js";
fn default_set_at(home: &Path) -> (Libs, Origin) {
    let api: Value = serde_json::from_slice(&fixture("cdnjs-Chart.js-4.4.1.json")).unwrap();
    let manifest = json!({"version":1,"libraries":{"Chart.js":{"4.4.1":api["sri"]},
        "moment.js":{"2.30.1":api["sri"]}}})
    .to_string();
    let o = Origin::start(Box::new(|p| {
        if p == CHART_PATH || p == "/ajax/libs/moment.js/2.30.1/chart.umd.min.js" {
            ok(&chart())
        } else {
            status(404, "")
        }
    }));
    let l = Libs::with_origin(home, &o.origin(), Duration::from_secs(5), &manifest).unwrap();
    (l, o)
}
fn auto_card(l: &Libs, url: &str) -> (bool, bool) {
    match resolve1(l, url) {
        Resolved::NeedsCard { listed, auto, .. } => (listed, auto),
        r => panic!("{url}: {r:?}"),
    }
}

#[test]
fn default_allowed_library_loads_without_a_prompt() {
    let home = scratch();
    let (l, o) = default_set_at(&home);
    // A fresh cache: the default switches, nothing written or fetched yet.
    assert_eq!(l.list().1, libs::default_auto_allow());
    assert!(!home.join("libs/libs.json").exists());
    assert_eq!(o.count(), 0);
    // The first view starts the fetch (the card waits on it, no Allow); the pin follows with no click.
    assert_eq!(auto_card(&l, CHART), (true, true));
    wait_pinned(&l, CHART);
    let e = &l.list().0[0];
    assert_eq!(
        (e.badge, e.sha384.as_str()),
        (Badge::Verified, CHART_SHA384)
    );
    assert_eq!(o.count(), 1);
    // Saved with the pin: a restart keeps the defaults and the pin.
    let again = default_set_at(&home).0;
    assert_eq!(again.list().1, libs::default_auto_allow());
    assert!(pinned(&resolve1(&again, CHART)));
    let _ = fs::remove_dir_all(home);
}

#[test]
fn library_outside_the_default_set_asks_once() {
    let home = scratch();
    let (l, o) = default_set_at(&home);
    assert!(!libs::DEFAULT_AUTO_ALLOW.contains(&"moment.js"));
    // Listed in the manifest, not a default: a card, nothing fetched.
    assert_eq!(auto_card(&l, MOMENT), (true, false));
    assert_eq!(auto_card(&l, MOMENT), (true, false));
    assert_eq!(o.count(), 0);
    // One Allow; then pinned for every later view and every agent.
    assert_eq!(l.allow(MOMENT, None, "s").unwrap().badge, Badge::Verified);
    assert!(pinned(&resolve1(&l, MOMENT)));
    assert!(pinned(&resolve1(&default_set_at(&home).0, MOMENT)));
    assert_eq!(o.count(), 1);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn removed_default_asks_again() {
    let home = scratch();
    let (l, o) = default_set_at(&home);
    chart_auto_off(&l);
    // Saved: a restart does not bring the default back.
    let again = default_set_at(&home).0;
    assert!(!again.list().1.iter().any(|a| a.library == "Chart.js"));
    assert_eq!(again.list().1.len(), libs::DEFAULT_AUTO_ALLOW.len() - 1);
    assert_eq!(auto_card(&again, CHART), (true, false));
    assert_eq!(o.count(), 0, "nothing fetched without the switch");
    // Asked once: Allow pins it, then it is served.
    again.allow(CHART, None, "s").unwrap();
    assert!(pinned(&resolve1(&again, CHART)));
    // On again: the switch is the owner's to restore.
    again
        .auto_allow("cdnjs.cloudflare.com", "Chart.js", true)
        .unwrap();
    assert_eq!(
        default_set_at(&home).0.list().1.len(),
        libs::DEFAULT_AUTO_ALLOW.len()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn default_library_version_outside_the_manifest_asks() {
    let home = scratch();
    let (l, o) = default_set_at(&home);
    // Another version, another file of the listed version, and the same library on another host: all cards.
    for url in [
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/not-listed.js",
        JSDELIVR,
    ] {
        assert_eq!(auto_card(&l, url), (false, false), "{url}");
    }
    thread::sleep(Duration::from_millis(100));
    assert_eq!(o.count(), 0);
    assert!(l.list().0.is_empty());
    let _ = fs::remove_dir_all(home);
}

// Ticket 366 r2: an existing version 1 lockfile (no marker) gets every default once, keeping its own switches and
// pins; the first write is version 2 with the marker, after a copy of the version 1 file.
#[test]
fn existing_lockfile_gets_the_defaults_once() {
    let home = scratch();
    fs::create_dir_all(home.join("libs")).unwrap();
    let v1 = json!({"version":1,"entries":[],"auto_allow":[{"host":"cdnjs.cloudflare.com","library":"jquery"}]})
        .to_string();
    fs::write(home.join("libs/libs.json"), &v1).unwrap();
    let (l, o) = default_set_at(&home);
    let mut want = vec![libs::AutoAllow {
        host: "cdnjs.cloudflare.com".into(),
        library: "jquery".into(),
    }];
    want.extend(libs::default_auto_allow());
    assert_eq!(l.list().1, want);
    assert!(l.list().2);
    // Read, not written: the file on disk is untouched until a change.
    assert_eq!(fs::read_to_string(home.join("libs/libs.json")).unwrap(), v1);
    // The owner turns d3 off: saved as version 2 with the marker, the version 1 file kept beside it.
    l.auto_allow("cdnjs.cloudflare.com", "d3", false).unwrap();
    let disk: Value =
        serde_json::from_slice(&fs::read(home.join("libs/libs.json")).unwrap()).unwrap();
    assert_eq!(disk["version"], 2);
    assert_eq!(disk["defaults_offered"], json!(libs::DEFAULT_AUTO_ALLOW));
    assert_eq!(
        fs::read_to_string(home.join("libs/libs.json.v1")).unwrap(),
        v1
    );
    // Off after a reload, and after a second one; the rest stay on.
    for _ in 0..2 {
        let again = default_set_at(&home).0;
        let on: Vec<String> = again.list().1.into_iter().map(|a| a.library).collect();
        assert!(!on.iter().any(|l| l == "d3"), "{on:?}");
        assert_eq!(on.len(), libs::DEFAULT_AUTO_ALLOW.len());
        let d3 = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";
        assert!(!auto_card(&again, d3).1);
    }
    // A later write keeps the first copy.
    l.auto_allow("cdnjs.cloudflare.com", "d3", true).unwrap();
    assert_eq!(
        fs::read_to_string(home.join("libs/libs.json.v1")).unwrap(),
        v1
    );
    assert_eq!(o.count(), 0);
    let _ = fs::remove_dir_all(home);
}

// Ticket 366 r2: a version 2 lockfile whose owner turned every default off stays that way.
#[test]
fn marked_lockfile_with_defaults_off_stays_off() {
    let home = scratch();
    fs::create_dir_all(home.join("libs")).unwrap();
    fs::write(
        home.join("libs/libs.json"),
        json!({"version":2,"entries":[],"auto_allow":[],"defaults_offered":libs::DEFAULT_AUTO_ALLOW}).to_string(),
    )
    .unwrap();
    let (l, o) = default_set_at(&home);
    assert!(l.list().1.is_empty() && l.list().2);
    assert_eq!(auto_card(&l, CHART), (true, false));
    assert_eq!(o.count(), 0);
    let _ = fs::remove_dir_all(home);
}

// Ticket 366 r2: a set-aside lockfile (broken, newer, a bad marker, a version 1 file with a marker, not a regular file)
// gets no defaults and is left as it is.
#[test]
fn set_aside_lockfile_gets_no_defaults() {
    use std::os::unix::fs::symlink;
    for (i, body) in [
        "not json".to_string(),
        json!({"version":3,"entries":[],"auto_allow":[]}).to_string(),
        json!({"version":2,"entries":[],"auto_allow":[],"defaults_offered":["../x"]}).to_string(),
        json!({"version":2,"entries":[],"auto_allow":[],"defaults_offered":["d3","d3"]})
            .to_string(),
        json!({"version":1,"entries":[],"auto_allow":[],"defaults_offered":[]}).to_string(),
        String::new(),
    ]
    .into_iter()
    .enumerate()
    {
        let home = scratch();
        fs::create_dir_all(home.join("libs")).unwrap();
        if body.is_empty() {
            // Not a regular file: a link to a well-formed one.
            let real = home.join("real.json");
            fs::write(
                &real,
                json!({"version":2,"entries":[],"auto_allow":[]}).to_string(),
            )
            .unwrap();
            symlink(&real, home.join("libs/libs.json")).unwrap();
        } else {
            fs::write(home.join("libs/libs.json"), &body).unwrap();
        }
        let (l, o) = default_set_at(&home);
        assert!(l.list().1.is_empty() && !l.list().2, "case {i}");
        assert_eq!(auto_card(&l, CHART), (true, false), "case {i}");
        assert_eq!(o.count(), 0);
        if !body.is_empty() {
            assert_eq!(
                fs::read_to_string(home.join("libs/libs.json")).unwrap(),
                body
            );
        }
        let _ = fs::remove_dir_all(home);
    }
}

#[test]
fn resolve_never_waits_for_an_auto_allowed_fetch() {
    let home = scratch();
    let o = Origin::start(Box::new(|_| {
        Answer::Late(Duration::from_secs(2), ok_bytes(&chart()))
    }));
    let l = libs_at(&home, &o);
    l.auto_allow("cdnjs.cloudflare.com", "Chart.js", true)
        .unwrap();
    let urls: Vec<String> = vec![CHART.into(); 3];
    let t = Instant::now();
    let r = l.resolve(&urls, "s").unwrap();
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "resolve waited {:?}",
        t.elapsed()
    );
    assert!(
        r.iter()
            .all(|r| matches!(r, Resolved::NeedsCard { auto: true, .. }))
    );
    wait_pinned(&l, CHART);
    assert_eq!(o.count(), 1, "one auto-allowed fetch per tuple");
    assert!(
        l.resolve(&vec![CHART.to_string(); 33], "s").is_err(),
        "at most 32 per call"
    );
    let _ = fs::remove_dir_all(home);
}

/// A lockfile of `n` well-formed entries, each `size` bytes, with no stored files.
fn seed(home: &Path, n: usize, size: u64) {
    let entries: Vec<Value> = (0..n)
        .map(|i| {
            json!({"host":"cdnjs.cloudflare.com","path":format!("/ajax/libs/lib{i}/1.0.0/a.js"),
                "library":format!("lib{i}"),"version":"1.0.0","file":"a.js",
                "sha384":format!("{i:096x}"),"sha512":format!("{i:0128x}"),"size":size,
                "fetched_at":1,"badge":"unverified","first_requester":"seed"})
        })
        .collect();
    fs::create_dir_all(home.join("libs")).unwrap();
    fs::write(
        home.join("libs/libs.json"),
        json!({"version":1,"entries":entries,"auto_allow":[]}).to_string(),
    )
    .unwrap();
}

#[test]
fn store_cap_refuses_past_256_mib() {
    assert_eq!(STORE_CAP, 256 * 1024 * 1024);
    assert_eq!(FILE_CAP, 8 * 1024 * 1024);
    let home = scratch();
    seed(&home, 32, FILE_CAP as u64);
    let o = chart_origin();
    let l = libs_at(&home, &o);
    assert!(l.list().2, "a well-formed seed is read");
    assert_eq!(
        l.allow(JSDELIVR, None, "s").unwrap_err(),
        "`chart.js` `4.4.1` is larger than 8 MB, took longer than 30 seconds, or the library cache is full (256 MB). It was not saved."
    );
    assert_eq!(l.list().0.len(), 32);
    assert_eq!(store_files(&home), 0);
    // Security review r1 (SHOULD): refused before any fetch, by Allow and by an auto-allowed default.
    assert_eq!(o.count(), 0, "refused before any fetch");
    assert!(matches!(
        resolve1(&l, CHART),
        Resolved::NeedsCard { auto: true, .. }
    ));
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until
        && l.resolve(&[CHART.into()], "s")
            .is_ok_and(|r| matches!(r[0], Resolved::NeedsCard { auto: true, .. }))
    {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        o.count(),
        0,
        "the auto-allowed fetch was refused before it too"
    );
    // Removing an entry makes room.
    l.remove("https://cdnjs.cloudflare.com/ajax/libs/lib0/1.0.0/a.js")
        .unwrap();
    l.allow(JSDELIVR, None, "s").unwrap();
    let _ = fs::remove_dir_all(home);
}

#[test]
fn lockfile_holds_at_most_512_entries() {
    let home = scratch();
    seed(&home, ENTRIES_CAP, 1);
    let o = chart_origin();
    let l = libs_at(&home, &o);
    assert_eq!(l.list().0.len(), 512);
    assert!(
        l.allow(JSDELIVR, None, "s")
            .unwrap_err()
            .contains("the library cache is full")
    );
    assert_eq!(o.count(), 0, "refused before any fetch");
    let _ = fs::remove_dir_all(home);
    // A lockfile over the cap is not ours to read.
    let home = scratch();
    seed(&home, ENTRIES_CAP + 1, 1);
    assert!(!libs_at(&home, &o).list().2);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn remove_deletes_entry_then_unreferenced_file() {
    let home = scratch();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    l.allow(CHART, None, "s").unwrap();
    l.allow(JSDELIVR, None, "s").unwrap();
    let stored = home.join("libs/sha384").join(CHART_SHA384);
    l.remove(CHART).unwrap();
    assert!(stored.exists(), "jsDelivr's entry still names the hash");
    assert!(pinned(&resolve1(&l, JSDELIVR)));
    assert!(!pinned(&resolve1(&l, CHART)));
    l.remove(JSDELIVR).unwrap();
    assert!(!stored.exists());
    assert!(l.list().0.is_empty());
    assert!(l.remove(JSDELIVR).is_err());
    let lock: Value =
        serde_json::from_slice(&fs::read(home.join("libs/libs.json")).unwrap()).unwrap();
    assert_eq!(lock["entries"], json!([]));
    // The next page that needs it shows the card again.
    assert!(matches!(resolve1(&l, CHART), Resolved::NeedsCard { .. }));
    let _ = fs::remove_dir_all(home);
}

#[test]
fn error_text_is_redacted() {
    let token = format!("ghp_{}", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5");
    assert_eq!(token.len(), 40);
    let home = scratch();
    let o = Origin::start(Box::new(|_| status(404, "")));
    let l = libs_at(&home, &o);
    let url = format!("https://unpkg.com/a@1.0.0/{token}.js");
    let err = l.allow(&url, None, "s").unwrap_err();
    assert!(!err.contains("ghp_"), "{err}");
    let line = libs::failure_line(
        &url,
        &format!("curl: (22) The requested URL returned error: 404 {token}"),
    );
    assert!(!line.contains(&token[4..]), "{line}");
    assert!(line.contains("redacted"), "{line}");
    let _ = fs::remove_dir_all(home);
}

#[test]
fn core_makes_no_other_network_call() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let module: String = ["libs/mod.rs", "libs/grammar.rs"]
        .iter()
        .map(|f| fs::read_to_string(root.join(f)).unwrap())
        .collect();
    for banned in [
        "Command",
        "process::",
        "TcpStream",
        "UnixStream",
        "std::net",
        "/usr/bin/curl",
        ".config/gh",
        "hosts.yml",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "token",
        "ookie",
        "\"sh\"",
        "\"-c\"",
        "shell",
        "env::",
    ] {
        assert!(!module.contains(banned), "libs has {banned}");
    }
    // The one curl spawn is themes_online's; only it, this module and the version mark build a `Client`.
    let themes = fs::read_to_string(root.join("themes_online.rs")).unwrap();
    // Ticket 1024: the core's spawns are spelled `process::command` (no secret variable inherited).
    assert_eq!(themes.matches("process::command(").count(), 1);
    assert_eq!(themes.matches("Command::new(").count(), 0);
    assert!(
        themes.contains("process::command(CURL)")
            && themes.contains("const CURL: &str = \"/usr/bin/curl\";")
    );
    // Ticket 358: the version mark builds one `Client`, and the npm registry is the only URL in the file.
    let update = fs::read_to_string(root.join("agent_update.rs")).unwrap();
    assert_eq!(update.matches("Client::new(").count(), 1);
    assert_eq!(
        update.matches("://").count(),
        1,
        "agent_update.rs names another URL"
    );
    assert!(update.contains("\"https://registry.npmjs.org/\""));
    // The plugin catalogue reads one origin, this repository's raw files on GitHub (PRIVACY.md).
    let catalogue = fs::read_to_string(root.join("plugins_online.rs")).unwrap();
    assert_eq!(
        catalogue.matches("://").count(),
        1,
        "plugins_online.rs names another URL"
    );
    assert!(catalogue.contains("\"https://raw.githubusercontent.com/nunchiro/nunchiro/\""));
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(dir).unwrap() {
            let path = e.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .to_string();
            let mut text = fs::read_to_string(&path).unwrap();
            if rel == "worktree_clean.rs" {
                text = gh_pin::worktree_clean_without_its_gh(&text);
            }
            if !matches!(
                rel.as_str(),
                "themes_online.rs" | "libs/mod.rs" | "agent_update.rs" | "plugins_online.rs"
            ) {
                assert!(
                    !text.contains("Client::new("),
                    "{rel} builds a network client"
                );
            }
            if !matches!(rel.as_str(), "themes_online.rs" | "pr_live.rs") {
                for banned in [
                    "/usr/bin/curl",
                    "Command::new(\"curl\")",
                    "Command::new(\"gh\")",
                    "process::command(\"curl\")",
                    "process::command(\"gh\")",
                ] {
                    assert!(!text.contains(banned), "{rel} has {banned}");
                }
            }
        }
    }
}

// A real core: the window can express the library ops; the owner socket, the CLI and session tokens cannot.

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("libs");
        fs::create_dir_all(home.join("cwd")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    /// One raw line on the core socket, as any client could send it.
    fn raw(&self, token: &str, request: Value) -> Value {
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.write_all(format!("{}\n", json!({"token":token,"request":request})).as_bytes())
            .unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn owner_token(&self) -> String {
        fs::read_to_string(self.home.join("core.token"))
            .unwrap()
            .trim()
            .to_string()
    }
    fn session_token(&self) -> String {
        let Reply::Started { session } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.join("cwd"),
                    worktree: false,
                    label: "libs".into(),
                    args: vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                    ],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Reply::Output { data, .. } = call(
                &self.home,
                Request::Read {
                    id: session.id.clone(),
                    after: 0,
                },
            )
            .unwrap() else {
                panic!()
            };
            let out = String::from_utf8_lossy(&data).into_owned();
            if let Some(l) = out
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return l.trim().to_string();
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn window(&self, request: Value) -> Value {
        let info = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", info["port"])
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                info["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < until);
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
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

#[test]
fn agent_cli_cannot_approve_or_auto_allow_library() {
    let core = Core::new();
    // Each op parses only off the window; `bad` URLs make sure nothing could be fetched.
    let ops = [
        json!({"op":"libs_allow","url":"https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/a.js?x"}),
        json!({"op":"libs_auto_allow","host":"cdnjs.cloudflare.com","library":"Chart.js","on":true}),
        json!({"op":"libs_remove","url":CHART}),
    ];
    let owner = core.owner_token();
    let session = core.session_token();
    for op in &ops {
        for token in [&owner, &session] {
            let r = core.raw(token, op.clone());
            assert!(
                r["Err"]
                    .as_str()
                    .is_some_and(|e| e.contains("unknown variant")),
                "{op} {r}"
            );
        }
    }
    // Ticket 366: a fresh core lists the default switches, and the same set as `defaults` for Settings.
    let defaults: Vec<Value> = libs::DEFAULT_AUTO_ALLOW
        .iter()
        .map(|l| json!({"host":"cdnjs.cloudflare.com","library":l}))
        .collect();
    let listed = core.window(json!({"op":"libs_list"}));
    assert_eq!(
        listed["Ok"]["auto_allow"],
        json!(defaults),
        "nothing reached the cache: {listed}"
    );
    assert_eq!(listed["Ok"]["defaults"], json!(defaults));
    // Off before any resolve: this core is real, an auto-allowed Chart.js would reach cdnjs.
    let off = core.window(
        json!({"op":"libs_auto_allow","host":"cdnjs.cloudflare.com","library":"Chart.js","on":false}),
    );
    assert_eq!(off["Ok"]["auto_allow"], json!(defaults[1..]), "{off}");
    assert_eq!(off["Ok"]["defaults"], json!(defaults), "{off}");
    // The owner reads the cache (the app's `serve`); a session token cannot, nor can it reach it through `remote`.
    let resolve = json!({"op":"libs_resolve","urls":[CHART],"requester":"s"});
    let r = core.raw(&owner, resolve.clone());
    assert_eq!(r["Ok"]["results"][0]["state"], "needs_card", "{r}");
    let r = core.raw(&owner, json!({"op":"libs_entry","sha384":CHART_SHA384}));
    assert_eq!(r["Ok"]["entry"], Value::Null, "{r}");
    for request in [
        resolve.clone(),
        json!({"op":"libs_entry","sha384":CHART_SHA384}),
    ] {
        let r = core.raw(&session, request.clone());
        assert_eq!(r["Err"], "operation not granted", "{request} {r}");
        let r = core.raw(
            &owner,
            json!({"op":"remote","machine":"m","request":request}),
        );
        assert!(
            r["Err"]
                .as_str()
                .is_some_and(|e| e.contains("local owner-only")),
            "{r}"
        );
    }
    // The window can express all three.
    let r = core.window(ops[0].clone());
    assert_eq!(r["Err"], TEXT3, "{r}");
    let r = core.window(ops[1].clone());
    assert_eq!(
        r["Ok"]["auto_allow"].as_array().unwrap().last(),
        Some(&json!({"host":"cdnjs.cloudflare.com","library":"Chart.js"})),
        "{r}"
    );
    assert_eq!(r["Ok"]["saved"], true);
    let r = core.window(ops[2].clone());
    assert_eq!(r["Err"], "that library is not pinned", "{r}");
    // An unlisted version stays a card with auto off even with the switch on: nothing is fetched.
    let r = core.raw(&owner, json!({"op":"libs_resolve","urls":["https://cdnjs.cloudflare.com/ajax/libs/Chart.js/9.9.9/x.js"]}));
    assert_eq!(r["Ok"]["results"][0]["auto"], false, "{r}");
}

// Security review S1/S2: a page picks the files an auto-allowed library fetches; at most 4 run at once and a failed
// one is not refetched on each view.
#[test]
fn auto_allowed_fetches_are_bounded_and_failures_not_retried() {
    let home = scratch();
    let o = Origin::start(Box::new(|_| {
        Answer::Late(
            Duration::from_millis(500),
            ok_bytes(b"not the listed bytes"),
        )
    }));
    let files: Vec<String> = (0..6).map(|i| format!("f{i}.js")).collect();
    let sri: serde_json::Map<String, Value> = files
        .iter()
        .map(|f| (f.clone(), json!("sha512-AAAA")))
        .collect();
    let manifest = json!({"version":1,"libraries":{"Chart.js":{"4.4.1":sri}}}).to_string();
    let l = Libs::with_origin(&home, &o.origin(), Duration::from_secs(5), &manifest).unwrap();
    l.auto_allow("cdnjs.cloudflare.com", "Chart.js", true)
        .unwrap();
    let urls: Vec<String> = files
        .iter()
        .map(|f| format!("https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/{f}"))
        .collect();
    let autos = |r: Vec<Resolved>| {
        r.iter()
            .filter(|r| matches!(r, Resolved::NeedsCard { auto: true, .. }))
            .count()
    };
    assert_eq!(
        autos(l.resolve(&urls, "s").unwrap()),
        4,
        "at most 4 started"
    );
    let until = Instant::now() + Duration::from_secs(10);
    while autos(l.resolve(&urls[..4], "s").unwrap()) > 0 {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    // The four failed (text 5): not started again; the two left over start now.
    assert_eq!(autos(l.resolve(&urls, "s").unwrap()), 2);
    let until = Instant::now() + Duration::from_secs(10);
    while o.count() < 6 || autos(l.resolve(&urls[4..], "s").unwrap()) > 0 {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(autos(l.resolve(&urls, "s").unwrap()), 0);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(o.count(), 6, "each file fetched once");
    assert!(l.list().0.is_empty());
    let _ = fs::remove_dir_all(home);
}

// Security review S3: Remove under a set-aside lockfile keeps the store file that lockfile may name.
#[test]
fn remove_keeps_store_files_while_the_lockfile_is_set_aside() {
    let home = scratch();
    fs::create_dir_all(home.join("libs")).unwrap();
    let body = json!({"version":3,"entries":[{"sha384":CHART_SHA384}]}).to_string();
    fs::write(home.join("libs/libs.json"), &body).unwrap();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    l.allow(CHART, None, "s").unwrap();
    l.remove(CHART).unwrap();
    assert!(home.join("libs/sha384").join(CHART_SHA384).exists());
    assert!(!pinned(&resolve1(&l, CHART)));
    assert_eq!(
        fs::read_to_string(home.join("libs/libs.json")).unwrap(),
        body
    );
    let _ = fs::remove_dir_all(home);
}

// 27b item 7 (27a SHOULD): resolve remembers a verified store file by (inode, mtime, size) and skips rehashing it
// while that stat is unchanged; any change rehashes. No timing assertion: an unreadable file proves no read.
#[test]
fn resolve_skips_rehash_of_unchanged_store_files() {
    let home = scratch();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    chart_auto_off(&l);
    l.allow(CHART, None, "s").unwrap();
    assert!(pinned(&resolve1(&l, CHART)));
    let stored = home.join("libs/sha384").join(CHART_SHA384);
    let mode = |m: u32| fs::set_permissions(&stored, fs::Permissions::from_mode(m)).unwrap();
    // chmod changes ctime only: same inode, mtime and size, so the file is not opened again.
    mode(0o000);
    assert!(
        fs::read(&stored).is_err(),
        "the test runs as a user chmod binds"
    );
    assert!(
        pinned(&resolve1(&l, CHART)),
        "unchanged stat: not read again"
    );
    // A changed mtime rehashes: the unreadable file is now not served.
    mode(0o600);
    let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    fs::File::options()
        .write(true)
        .open(&stored)
        .unwrap()
        .set_modified(old)
        .unwrap();
    mode(0o000);
    assert!(matches!(resolve1(&l, CHART), Resolved::NeedsCard { .. }));
    // Readable again with the pinned bytes: verified and remembered again.
    mode(0o600);
    assert!(pinned(&resolve1(&l, CHART)));
    // Same size, other bytes (a write moves mtime): rehashed, a wrong hash answers needs-card.
    fs::write(&stored, vec![b'x'; chart().len()]).unwrap();
    assert!(matches!(resolve1(&l, CHART), Resolved::NeedsCard { .. }));
    // A changed size with the old mtime kept: rehashed too.
    let mut longer = chart();
    longer.push(b'\n');
    fs::write(&stored, &longer).unwrap();
    fs::File::options()
        .write(true)
        .open(&stored)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert!(matches!(resolve1(&l, CHART), Resolved::NeedsCard { .. }));
    let _ = fs::remove_dir_all(home);
}

// V2-37 (27a/27b SHOULD): verified stamps outlive the core, so the first resolve after a restart does not rehash up
// to 32x8 MiB on the socket thread; a changed stamp still rehashes. Past the app's 3 s call budget the page is served
// unrewritten (app test `rewrite_changes_only_src_of_pinned_tags`, "No core answer"), so a slow resolve fails closed.
#[test]
fn resolve_reuses_verified_stamps_across_calls() {
    let home = scratch();
    let o = chart_origin();
    let l = libs_at(&home, &o);
    chart_auto_off(&l);
    l.allow(CHART, None, "s").unwrap();
    assert!(pinned(&resolve1(&l, CHART)));
    let stored = home.join("libs/sha384").join(CHART_SHA384);
    let mode = |m: u32| fs::set_permissions(&stored, fs::Permissions::from_mode(m)).unwrap();
    mode(0o000);
    assert!(
        fs::read(&stored).is_err(),
        "the test runs as a user chmod binds"
    );
    assert!(pinned(&resolve1(&l, CHART)), "a second call: not read");
    // A restart (state read afresh from disk) keeps the stamp: still not read.
    assert!(pinned(&resolve1(&libs_at(&home, &o), CHART)));
    // A changed mtime rehashes after a restart too: the unreadable file is not served.
    mode(0o600);
    let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    fs::File::options()
        .write(true)
        .open(&stored)
        .unwrap()
        .set_modified(old)
        .unwrap();
    mode(0o000);
    assert!(matches!(
        resolve1(&libs_at(&home, &o), CHART),
        Resolved::NeedsCard { .. }
    ));
    // A changed inode (the same bytes written anew) rehashes.
    mode(0o600);
    let l = libs_at(&home, &o);
    assert!(pinned(&resolve1(&l, CHART)));
    fs::remove_file(&stored).unwrap();
    fs::write(&stored, chart()).unwrap();
    mode(0o000);
    assert!(matches!(
        resolve1(&libs_at(&home, &o), CHART),
        Resolved::NeedsCard { .. }
    ));
    // A broken stamp file is not trusted: nothing is skipped, and it is replaced once a file verifies again.
    for broken in [
        "not json".to_string(),
        json!({CHART_SHA384: "x"}).to_string(),
        json!({"../x": [0, 0, 0, 0, 0]}).to_string(),
    ] {
        fs::write(home.join("libs/verified.json"), &broken).unwrap();
        assert!(matches!(
            resolve1(&libs_at(&home, &o), CHART),
            Resolved::NeedsCard { .. }
        ));
    }
    mode(0o600);
    assert!(pinned(&resolve1(&libs_at(&home, &o), CHART)));
    mode(0o000);
    assert!(pinned(&resolve1(&libs_at(&home, &o), CHART)));
    mode(0o600);
    let _ = fs::remove_dir_all(home);
}

// V2-37 (27a SHOULD): the store cap counts what is on disk beyond the entries: files a set-aside lockfile may name,
// and leftover `.tmp` files. Sizes are file lengths (sparse files here, nothing is written).
#[test]
fn store_cap_counts_set_aside_and_tmp() {
    let room = STORE_CAP - chart().len() as u64 + 1;
    let fill = |home: &Path, name: &str| {
        fs::create_dir_all(home.join("libs/sha384")).unwrap();
        fs::File::create(home.join("libs/sha384").join(name))
            .unwrap()
            .set_len(room)
            .unwrap();
    };
    let full = "`Chart.js` `4.4.1` is larger than 8 MB, took longer than 30 seconds, or the library cache is full (256 MB). It was not saved.";
    let o = chart_origin();
    // A set-aside lockfile and the store file it names.
    let home = scratch();
    fs::create_dir_all(home.join("libs")).unwrap();
    fs::write(
        home.join("libs/libs.json"),
        json!({"version":3,"entries":[]}).to_string(),
    )
    .unwrap();
    fill(&home, &"a".repeat(96));
    let l = libs_at(&home, &o);
    assert!(!l.list().2);
    assert_eq!(l.allow(CHART, None, "s").unwrap_err(), full);
    let _ = fs::remove_dir_all(home);
    // A leftover temp file.
    let home = scratch();
    fill(&home, ".0123.tmp");
    let l = libs_at(&home, &o);
    assert_eq!(l.allow(CHART, None, "s").unwrap_err(), full);
    assert_eq!(l.list().0.len(), 0);
    // Gone: room again.
    fs::remove_file(home.join("libs/sha384/.0123.tmp")).unwrap();
    l.allow(CHART, None, "s").unwrap();
    let _ = fs::remove_dir_all(home);
}
