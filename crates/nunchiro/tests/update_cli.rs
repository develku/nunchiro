// Ticket 1082, security round 1 (MUST 1): `nunchiro update install` from inside a session is refused by the core's
// judgment of the calling process, with the session token and with it removed, before any file is touched.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
#[path = "../../../app/src-tauri/src/passwd.rs"]
mod passwd;
#[path = "../src/update_claims.rs"]
#[allow(dead_code)]
mod update_claims;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::Child,
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    core: Child,
}
impl Core {
    fn new() -> Self {
        Self::from(std::path::Path::new(env!("CARGO_BIN_EXE_nunchiro")))
    }
    fn from(exe: &std::path::Path) -> Self {
        let home = home::short("upd");
        let core = home::git_env::scrubbed(exe)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap();
        let c = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !c.home.join("core.token").exists()
            || UnixStream::connect(c.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
        c
    }
    fn owner(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op": "stop"}));
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn listing(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_session_cannot_install_with_or_without_its_token() {
    let c = Core::new();
    let builds = c.home.join("builds");
    fs::create_dir_all(builds.join("Nunchiro.app")).unwrap();
    fs::write(builds.join("nunchiro-build.json"), "{}").unwrap();
    fs::write(c.home.join("update-source"), builds.to_str().unwrap()).unwrap();
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_nunchiro"));
    let beside = listing(exe.parent().unwrap());
    let out = c.home.join("inside.txt");
    let script = r#"{ "$1" update install; echo "exit $?"; env -u NUNCHIRO_TOKEN "$1" update install; echo "exit $?"; } > "$3.tmp" 2>&1; mv "$3.tmp" "$3"; exec sleep 30"#;
    c.owner(json!({"op":"start","session":{"kind":"shell","project":c.home,"args":["/bin/sh","-c",script,"inside",exe,c.home,out]}}));
    let until = Instant::now() + Duration::from_secs(20);
    while !out.exists() {
        assert!(Instant::now() < until, "inside install never answered");
        thread::sleep(Duration::from_millis(50));
    }
    let raw = fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = raw.lines().collect();
    assert_eq!(lines.len(), 4, "{raw}");
    for (said, exit) in [(lines[0], lines[1]), (lines[2], lines[3])] {
        assert!(
            said.contains("is for the owner, not for a session"),
            "{raw}"
        );
        assert_eq!(exit, "exit 1", "{raw}");
    }
    // The stripped one reached the core and was judged by its process there.
    assert!(lines[2].contains("operation not granted"), "{raw}");
    // Nothing changed: the update folder, and no work folder beside the executable.
    assert_eq!(listing(&builds), ["Nunchiro.app", "nunchiro-build.json"]);
    assert_eq!(listing(exe.parent().unwrap()), beside);
    // The owner, outside every session, passes the check and stops later: this build is no installed app.
    let owner = std::process::Command::new(&exe)
        .args(["update", "install"])
        .env("NUNCHIRO_HOME", &c.home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&owner.stderr);
    assert!(
        err.contains("is not inside an installed Nunchiro.app"),
        "{err}"
    );
}

// Security round 3 (MUST 1): a plain `serve` never claims. An agent may run the installed CLI with a home it controls;
// here a core starts from an installed-looking bundle with the owner's id under a fresh home, and the account's
// claims folder has no claim for that bundle afterwards. Read only: the claims folder of the real account is looked
// at, never written. The CLI has no command that claims either.
#[test]
fn a_plain_serve_under_an_agent_home_claims_nothing() {
    let place = home::short("upd-app");
    let macos = place.join("Nunchiro.app/Contents/MacOS");
    fs::create_dir_all(&macos).unwrap();
    fs::write(
        place.join("Nunchiro.app/Contents/Info.plist"),
        "<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>dev.nunchiro.app</string>\n</dict></plist>",
    )
    .unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nunchiro"), macos.join("nunchiro")).unwrap();
    let bundle = place.join("Nunchiro.app").canonicalize().unwrap();
    let claims = update_claims::claims(&passwd::passwd_home().unwrap());
    let file = update_claims::claim_file(&claims, &bundle);
    assert!(
        !file.exists(),
        "a claim before the test: {}",
        file.display()
    );
    let c = Core::from(&macos.join("nunchiro"));
    // the core is up and recorded its start (the moment the old code claimed)
    assert!(c.home.join("core.start.json").exists());
    let claimed = file.exists();
    let _ = fs::remove_file(&file); // never leave one behind, even when the check fails
    assert!(!claimed, "a plain serve claimed {}", bundle.display());
    let out = std::process::Command::new(macos.join("nunchiro"))
        .args(["update", "claim"])
        .env("NUNCHIRO_HOME", &c.home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(!file.exists());
    drop(c);
    let _ = fs::remove_dir_all(place);
}
