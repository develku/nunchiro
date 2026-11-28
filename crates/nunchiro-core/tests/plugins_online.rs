// The plugin catalogue (docs/plugins.md, Browse and install) against a local fixture origin: the list, an install
// that writes exactly the catalogued files, a file changed after the catalogue was made (nothing installed), an
// installed plugin that is off and not approved, and an update that sets the old folder aside.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::approval::State;
use nunchiro_core::plugins;
use nunchiro_core::plugins_online::{CATALOG, Catalog};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::{fs, thread};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST: &str = "id = \"hello\"\nname = \"Hello\"\nversion = \"VERSION\"\nabout = \"Says hello.\"\n\n[[command]]\nname = \"hi\"\ncommand = [\"/bin/sh\", \"hi.sh\"]\nshow = \"note\"\n";
const SCRIPT: &str = "#!/bin/sh\necho hello\n";

/// A fake origin: path to body, changeable while it serves.
type Files = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;
fn serve(files: Files) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let files = files.clone();
            thread::spawn(move || answer(stream, &files));
        }
    });
    format!("http://127.0.0.1:{port}/")
}
fn answer(mut stream: TcpStream, files: &Files) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
    }
    let path = first
        .split(' ')
        .nth(1)
        .unwrap_or("")
        .trim_start_matches('/');
    let out = match files.lock().unwrap().get(path) {
        Some(body) => {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            out.extend_from_slice(body);
            out
        }
        None => b"HTTP/1.1 404 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    };
    let _ = stream.write_all(&out);
}
fn sha(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// The origin's files for `hello` at `version`, and a catalogue that names them (plus one entry that is not valid).
fn publish(files: &Files, version: &str) {
    let manifest = MANIFEST.replace("VERSION", version);
    let dir = "examples/hello";
    let catalog = json!({"version": 1, "plugins": [
        {"id": "hello", "name": "Hello", "about": "Says hello.", "version": version, "adds": {"command": 1},
         "network": [], "commit": COMMIT, "dir": dir,
         "files": [{"path": "plugin.toml", "sha256": sha(manifest.as_bytes())}, {"path": "hi.sh", "sha256": sha(SCRIPT.as_bytes())}]},
        {"id": "escape", "name": "Escape", "about": "", "version": "1", "commit": COMMIT, "dir": "../x",
         "files": [{"path": "plugin.toml", "sha256": sha(b"")}]}
    ]});
    let mut f = files.lock().unwrap();
    f.insert(CATALOG.into(), catalog.to_string().into_bytes());
    f.insert(format!("{COMMIT}/{dir}/plugin.toml"), manifest.into_bytes());
    f.insert(format!("{COMMIT}/{dir}/hi.sh"), SCRIPT.as_bytes().to_vec());
}
fn setup(tag: &str) -> (std::path::PathBuf, Files, Catalog) {
    let home = home::short(tag);
    let files: Files = Default::default();
    publish(&files, "1.0.0");
    let catalog = Catalog::with_origin(&home, &serve(files.clone())).unwrap();
    (home, files, catalog)
}

#[test]
fn the_catalogue_lists_its_valid_entries() {
    let (_home, _files, catalog) = setup("pco");
    let entries = catalog.entries().unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}"); // the entry whose folder leaves the repository is left out
    let e = serde_json::to_value(&entries[0]).unwrap();
    assert_eq!(e["id"], "hello");
    assert_eq!(e["version"], "1.0.0");
    assert_eq!(e["adds"], json!({"command": 1}));
}

#[test]
fn an_install_writes_the_files_and_runs_nothing_before_approval() {
    let (home, _files, catalog) = setup("pci");
    catalog.install("hello").unwrap();
    let dir = home.join("plugins/hello");
    assert_eq!(fs::read_to_string(dir.join("hi.sh")).unwrap(), SCRIPT);
    assert!(
        fs::read_to_string(dir.join("plugin.toml"))
            .unwrap()
            .contains("1.0.0")
    );
    let listed = plugins::list(&home, true, false);
    let hello = listed.iter().find(|p| p.id == "hello").unwrap();
    assert!(!hello.on, "an installed plugin is off");
    assert_ne!(hello.state, Some(State::Approved), "and not approved");
    // Not in the catalogue: refused.
    assert!(catalog.install("escape").is_err());
}

#[test]
fn a_file_changed_after_the_catalogue_installs_nothing() {
    let (home, files, catalog) = setup("pcm");
    files.lock().unwrap().insert(
        format!("{COMMIT}/examples/hello/hi.sh"),
        b"#!/bin/sh\ncurl evil\n".to_vec(),
    );
    let e = catalog.install("hello").unwrap_err();
    assert!(
        e.contains("hi.sh of hello does not match the catalogue")
            && e.contains("nothing was installed"),
        "{e}"
    );
    let left: Vec<_> = fs::read_dir(home.join("plugins"))
        .map(|d| d.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn an_update_sets_the_old_folder_aside_and_asks_again() {
    let (home, files, catalog) = setup("pcu");
    catalog.install("hello").unwrap();
    publish(&files, "1.1.0");
    catalog.install("hello").unwrap();
    assert!(
        fs::read_to_string(home.join("plugins/hello/plugin.toml"))
            .unwrap()
            .contains("1.1.0")
    );
    let aside: Vec<Value> = fs::read_dir(home.join("plugins/.removed"))
        .unwrap()
        .flatten()
        .map(|e| json!(e.file_name().to_string_lossy()))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
}

#[test]
fn installs_of_one_plugin_at_once_leave_it_whole() {
    let (home, _files, catalog) = setup("pcc");
    let catalog = Arc::new(catalog);
    catalog.install("hello").unwrap();
    for _ in 0..5 {
        let runs: Vec<_> = (0..4)
            .map(|_| {
                let c = catalog.clone();
                thread::spawn(move || c.install("hello"))
            })
            .collect();
        for r in runs {
            r.join().unwrap().unwrap();
        }
        let dir = home.join("plugins/hello");
        assert_eq!(fs::read_to_string(dir.join("hi.sh")).unwrap(), SCRIPT);
        assert!(dir.join("plugin.toml").is_file());
    }
    let left: Vec<_> = fs::read_dir(home.join("plugins"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".install"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn a_catalogue_must_say_its_version_and_nothing_unknown() {
    use nunchiro_core::plugins_online::parse;
    let entry = json!({"id": "hello", "name": "Hello", "about": "", "version": "1", "commit": COMMIT, "dir": "a",
        "files": [{"path": "plugin.toml", "sha256": sha(b"")}]});
    assert_eq!(
        parse(
            json!({"version": 1, "plugins": [entry]})
                .to_string()
                .as_bytes()
        )
        .unwrap()
        .len(),
        1
    );
    for bad in [
        json!({"plugins": [entry]}),
        json!({"version": 2, "plugins": [entry]}),
        json!({"version": 1, "plugins": [entry], "extra": true}),
        json!({"version": 1, "plugins": [{"run_after_install": "x", "id": "hello"}]}),
    ] {
        assert!(parse(bad.to_string().as_bytes()).is_err(), "{bad}");
    }
}

#[test]
fn an_update_of_an_approved_plugin_that_was_on_is_off_and_asks_again() {
    let (home, files, catalog) = setup("pca");
    catalog.install("hello").unwrap();
    let view = nunchiro_core::approval::status(&home, "plugin:hello").unwrap();
    nunchiro_core::approval::grant(
        &home,
        "plugin:hello",
        nunchiro_core::approval::Level::Read,
        &view.hash,
    )
    .unwrap();
    fs::write(
        home.join("plugins.json"),
        json!({"on": ["hello"]}).to_string(),
    )
    .unwrap();
    let hello = |home: &std::path::Path| {
        plugins::list(home, true, false)
            .into_iter()
            .find(|p| p.id == "hello")
            .unwrap()
    };
    assert!(hello(&home).on && hello(&home).state == Some(State::Approved));
    publish(&files, "1.1.0");
    catalog.install("hello").unwrap();
    let after = hello(&home);
    assert!(!after.on, "an update is off");
    assert_ne!(after.state, Some(State::Approved), "and asks again");
}

#[test]
fn a_link_where_the_plugin_goes_is_refused_and_leaves_nothing() {
    let (home, _files, catalog) = setup("pcl");
    fs::create_dir_all(home.join("plugins")).unwrap();
    std::os::unix::fs::symlink("/tmp", home.join("plugins/hello")).unwrap();
    let e = catalog.install("hello").unwrap_err();
    assert!(
        e.contains("plugins/hello") && e.contains("in the way"),
        "{e}"
    );
    let left: Vec<_> = fs::read_dir(home.join("plugins"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(left, ["hello"]);
    // A plugins folder that is itself a link is refused, as `plugin new` refuses it.
    let (home, _files, catalog) = setup("pcs");
    let elsewhere = home.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, home.join("plugins")).unwrap();
    assert!(catalog.install("hello").unwrap_err().contains("symlink"));
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
}
