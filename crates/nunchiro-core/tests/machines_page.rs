//! Ticket 41: owner machine settings and read-only discovery over the real socket.
#[path = "fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::client::IntoClientRequest;
/// w25-r: shell the scripted fake ssh masters below share. `hold <file>` waits for `$NUNCHIRO_HOME/<file>` but gives up
/// once the core or the test home is gone, and after 60 s. `ends_at_eof` ends a master, like a real one, when its core
/// closes its stdin (a master that exits first stops that watcher: `kill $eof`); `kill -0 $PPID` alone trusts a PID that
/// can be reused. The gate's 23 leaked masters (11-19, up to 2 days old) ran an older loop that waited for `drop` only.
const FAKE_SH: &str = r#"hold() { i=0; while [ ! -e "$NUNCHIRO_HOME/$1" ] && [ -d "$NUNCHIRO_HOME" ] && kill -0 "$PPID" 2>/dev/null && [ $i -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done; }
ends_at_eof() { exec 3<&0; { cat <&3; kill $$; } >/dev/null 2>&1 & eof=$!; }
"#;
fn write_ssh(root: &Path, body: &str) {
    fs::write(root.join("bin/ssh"), format!("#!/bin/sh\n{FAKE_SH}{body}")).unwrap();
}
struct Core {
    guard: home::ServeGuard,
    root: PathBuf,
}
impl Core {
    fn new(settings: Value, remembered: Value) -> Self {
        Self::before_spawn(settings, remembered, |_| {})
    }
    fn before_spawn(
        settings: Value,
        remembered: Value,
        before: impl FnOnce(&std::path::Path),
    ) -> Self {
        let root = home::short("m41");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("user/.ssh")).unwrap();
        fs::write(
            root.join("user/.ssh/config"),
            "Host macbook\n HostName macbook.local\n",
        )
        .unwrap();
        fs::write(root.join("user/.ssh/known_hosts"), "sentinel known hosts\n").unwrap();
        fs::write(root.join("user/.ssh/id_ed25519"), "sentinel private key\n").unwrap();
        fs::write(root.join("settings.json"), settings.to_string()).unwrap();
        fs::write(root.join("machines.json"), remembered.to_string()).unwrap();
        fs::write(root.join("protocol"), "2").unwrap();
        let fake = r#"#!/bin/sh
printf '%s\n' "$@" >> "$NUNCHIRO_HOME/ssh.log"
if [ "$1" = '-G' ]; then
 printf 'hostname macbook.local\nuser me\nport 22\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_ed25519_work\n'
 exit 0
fi
if [ "$1" = '-lF' ]; then
 printf '256 SHA256:fixture macbook.local (ED25519)\n'
 exit 0
fi
printf '%s\n' "$$" >> "$NUNCHIRO_HOME/masters"
printf '{"type":"hello","protocol":%s,"version":"0.9.4"}\n' "$(cat "$NUNCHIRO_HOME/protocol")"
cat "$NUNCHIRO_HOME/rows"
cat >/dev/null
"#;
        for name in ["ssh", "ssh-keygen"] {
            let p = root.join("bin").join(name);
            fs::write(&p, fake).unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            root.join("rows"),
            "{\"type\":\"sessions\",\"sessions\":[]}\n",
        )
        .unwrap();
        let path = format!("{}:/usr/bin:/bin", root.join("bin").display());
        let user_home = root.join("user");
        let root_str = user_home.to_str().unwrap();
        before(&root);
        let guard = home::spawn_serve(
            &root,
            &[
                ("HOME", root_str),
                ("PATH", &path),
                ("NUNCHIRO_SSH", root.join("bin/ssh").to_str().unwrap()),
            ],
        );
        Self { guard, root }
    }
    fn call(&self, req: Value) -> Value {
        self.raw(
            &fs::read_to_string(self.root.join("core.token")).unwrap(),
            req,
        )
    }
    fn raw(&self, token: &str, req: Value) -> Value {
        let mut sock = UnixStream::connect(self.root.join("core.sock")).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        writeln!(sock, "{}", json!({"token":token.trim(),"request":req})).unwrap();
        let mut line = String::new();
        BufReader::new(sock).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn list(&self) -> Value {
        let r = self.call(json!({"op":"machine_details"}));
        assert!(r["Ok"].is_object(), "{r}");
        r["Ok"]["machines"].clone()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.guard.stop();
        // w25-r: every fake ssh ends once its core is gone; one still running after 5 s fails the test. No signal is
        // sent (a PID from a ps snapshot may be reused): removing the home ends every fake loop on its next check.
        let end = Instant::now() + Duration::from_secs(5);
        let mut left = fakes(&self.root);
        while !left.is_empty() && Instant::now() < end {
            thread::sleep(Duration::from_millis(50));
            left = fakes(&self.root);
        }
        if !thread::panicking() || !left.is_empty() {
            remove_home(&self.root);
        }
        if !thread::panicking() {
            assert!(left.is_empty(), "fake ssh outlived its core: {left:?}");
        }
    }
}
/// The processes still running this home's fake ssh: `/bin/sh <root>/bin/...` (the scripts' shebang). Only that exact
/// start counts, so another process that merely names the path (an editor, a grep) is never matched and killed.
fn fakes(root: &Path) -> Vec<(i32, String)> {
    let out = Command::new("/bin/ps")
        .args(["-Ao", "pid=,command="])
        .output()
        .unwrap();
    let script = format!("/bin/sh {}/bin/", root.display());
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (pid, command) = l.trim_start().split_once(' ')?;
            Some((pid.parse().ok()?, command.trim_start().to_string()))
        })
        .filter(|(_, command)| command.starts_with(&script))
        .collect()
}
/// `guard.stop()` kills only the core. A fake `ssh` it spawned can outlive it and still be starting (its first lines
/// create `ssh.log` and `masters`), so `remove_dir_all` may find a new file and report DirectoryNotEmpty (V2.5-47).
/// It has not yet written its PID anywhere the test can read, so we retry rather than wait for a PID. Any other
/// error, or the 20th failure, panics with the path.
fn remove_home(root: &Path) {
    for tries in 1.. {
        match fs::remove_dir_all(root) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty && tries < 20 => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(e) => panic!(
                "cannot remove test home {} after {tries} tries: {e}",
                root.display()
            ),
        }
    }
}
fn core() -> Core {
    Core::new(json!({}), json!({"version":1,"machines":[]}))
}
fn add(c: &Core) -> Value {
    c.call(
        json!({"op":"add_machine","alias":"macbook","host":"macbook.local","user":"me","port":22}),
    )
}
fn wait(mut check: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(Instant::now() < end, "timed out");
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn add_machine_persists_and_lists() {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    assert_eq!(c.list()[0]["machine"], "macbook");
    let file: Value =
        serde_json::from_slice(&fs::read(c.root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["machines"]["macbook"]["host"], "macbook.local");
    assert!(add(&c)["Err"].as_str().unwrap().contains("already"));
}
// Edit: `replace` saves over a listed alias and keeps its project mappings; the same values write nothing; an
// unknown alias is refused.
#[test]
fn add_machine_replace_edits_in_place() {
    let c = Core::new(
        json!({"machines":{"macbook":{"projects":{"/a":"/b"},"host":"macbook.local","user":"me","port":22}}}),
        json!({"version":1,"machines":[]}),
    );
    let file = || fs::read(c.root.join("settings.json")).unwrap();
    let edit = |port: u32, alias: &str| {
        c.call(json!({"op":"add_machine","alias":alias,"host":"macbook.local","user":"me","port":port,"replace":true}))
    };
    let before = file();
    assert!(edit(22, "macbook")["Ok"].is_object());
    assert_eq!(
        file(),
        before,
        "an edit that changes nothing writes nothing"
    );
    assert!(edit(2222, "macbook")["Ok"].is_object());
    let saved: Value = serde_json::from_slice(&file()).unwrap();
    assert_eq!(saved["machines"]["macbook"]["port"], 2222);
    assert_eq!(saved["machines"]["macbook"]["projects"]["/a"], "/b");
    assert_eq!(c.list().as_array().unwrap().len(), 1);
    assert_eq!(c.list()[0]["saved"]["port"], 2222);
    assert!(
        edit(22, "other")["Err"]
            .as_str()
            .unwrap()
            .contains("not listed")
    );
    assert!(add(&c)["Err"].as_str().unwrap().contains("already"));
}
#[test]
fn add_machine_rejects_bad_input() {
    let c = core();
    let before = fs::read(c.root.join("settings.json")).unwrap();
    for patch in [
        json!({"alias":"-bad"}),
        json!({"host":"bad host"}),
        json!({"host":"-bad"}),
        json!({"user":"-bad"}),
        json!({"user":"bad\nuser"}),
        json!({"port":0}),
        json!({"port":65536}),
    ] {
        let mut r = json!({"op":"add_machine","alias":"mini","host":"mini.local"});
        r.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let reply = c.call(r);
        assert!(
            reply["Err"]
                .as_str()
                .is_some_and(|e| e.contains("invalid") || e.contains("port")),
            "{reply}"
        );
        assert_eq!(fs::read(c.root.join("settings.json")).unwrap(), before);
    }
}
#[test]
fn forget_machine_removes_settings_and_remembered() {
    let c = Core::new(
        json!({"machines":{"macbook":{"projects":{}}},"stale_after_ms":123}),
        json!({"version":1,"machines":["macbook"]}),
    );
    assert!(c.call(json!({"op":"forget_machine","alias":"macbook"}))["Ok"].is_object());
    assert_eq!(c.list(), json!([]));
    let file: Value =
        serde_json::from_slice(&fs::read(c.root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["machines"], json!({}));
    assert_eq!(file["stale_after_ms"], 123);
    let file: Value =
        serde_json::from_slice(&fs::read(c.root.join("machines.json")).unwrap()).unwrap();
    assert_eq!(file["machines"], json!([]));
}

#[test]
fn forget_rollback_failure_reports_divergence() {
    const CHILD: &str = "NUNCHIRO_TEST_FORGET_FILE_LIMIT";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "forget_rollback_failure_reports_divergence",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let settings = json!({"machines":{
        "macbook":{"projects":{}},
        "other":{"projects":{format!("/{}", "x".repeat(512 * 1024)):"/remote"}}
    }});
    let c = Core::before_spawn(
        settings.clone(),
        json!({"version":1,"machines":["macbook"]}),
        |root| {
            // The first replacement fits; both the settings write and the old-store rollback exceed the limit. Each file
            // stays under the core's 1 MiB read cap (`store::READ_MAX`), so the core still starts.
            let path = root.join("machines.json");
            let padded = format!(
                "{}{}",
                fs::read_to_string(&path).unwrap(),
                " ".repeat(512 * 1024)
            );
            fs::write(path, padded).unwrap();
            unsafe {
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                let limit = libc::rlimit {
                    rlim_cur: 256 * 1024,
                    rlim_max: 256 * 1024,
                };
                assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            }
        },
    );
    let reply = c.call(json!({"op":"forget_machine","alias":"macbook"}));
    let error = reply["Err"].as_str().expect("forget must fail");
    assert!(error.contains("stores diverged"), "{error}");
    assert!(
        error.contains("settings.json") && error.contains("machines.json"),
        "{error}"
    );
    let on_disk: Value =
        serde_json::from_slice(&fs::read(c.root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(on_disk, settings);
    let on_disk: Value =
        serde_json::from_slice(&fs::read(c.root.join("machines.json")).unwrap()).unwrap();
    assert_eq!(on_disk, json!({"version":1,"machines":[]}));
}
#[test]
fn core_drop_survives_late_writer() {
    let mut c = core();
    let root = c.root.clone();
    c.guard.stop();
    // A fake ssh that outlives the killed core can still create files; this thread does the same for 150 ms after stop.
    let until = Instant::now() + Duration::from_millis(150);
    let writer = thread::spawn({
        let root = root.clone();
        move || {
            let mut n = 0;
            while Instant::now() < until {
                let _ = fs::write(root.join(format!("late-{n}")), "");
                n += 1;
            }
        }
    });
    drop(c);
    writer.join().unwrap();
    assert!(!root.exists());
}
#[test]
fn core_drop_gives_up_with_path() {
    let c = core();
    let root = c.root.clone();
    let locked = root.join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("file"), "").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c)))
        .expect_err("a home that can never be removed must fail the test");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(&root).unwrap();
    let message = panic.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains(root.to_str().unwrap()), "{message}");
}
#[test]
fn forget_machine_closes_channel() {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    c.call(json!({"op":"snapshot"}));
    wait(|| fs::read_to_string(c.root.join("masters")).is_ok_and(|s| !s.is_empty()));
    let pid: i32 = fs::read_to_string(c.root.join("masters"))
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .parse()
        .unwrap();
    assert!(c.call(json!({"op":"forget_machine","alias":"macbook"}))["Ok"].is_object());
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "master must be gone before removal replies"
    );
    assert_eq!(c.list(), json!([]));
    c.call(json!({"op":"snapshot"}));
    assert_eq!(
        fs::read_to_string(c.root.join("masters"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn forget_never_touches_ssh_config() {
    let c = core();
    let paths = [
        "user/.ssh/config",
        "user/.ssh/known_hosts",
        "user/.ssh/id_ed25519",
    ];
    let before: Vec<_> = paths
        .iter()
        .map(|p| {
            (
                fs::read(c.root.join(p)).unwrap(),
                fs::metadata(c.root.join(p)).unwrap().modified().unwrap(),
            )
        })
        .collect();
    assert!(add(&c)["Ok"].is_object());
    c.list();
    let log = fs::read_to_string(c.root.join("ssh.log")).unwrap();
    assert!(c.call(json!({"op":"forget_machine","alias":"macbook"}))["Ok"].is_object());
    assert_eq!(fs::read_to_string(c.root.join("ssh.log")).unwrap(), log);
    for (p, (b, m)) in paths.iter().zip(before) {
        assert_eq!(fs::read(c.root.join(p)).unwrap(), b);
        assert_eq!(fs::metadata(c.root.join(p)).unwrap().modified().unwrap(), m);
    }
}
#[test]
fn ssh_discovery_read_only() {
    let c = core();
    assert!(c.call(json!({"op":"machine_details","alias":"intruder"}))["Err"].is_string());
    assert!(!c.root.join("ssh.log").exists());
    assert!(add(&c)["Ok"].is_object());
    let before: Vec<_> = [
        "settings.json",
        "machines.json",
        "user/.ssh/config",
        "user/.ssh/known_hosts",
        "user/.ssh/id_ed25519",
    ]
    .map(|p| fs::read(c.root.join(p)).unwrap())
    .into();
    let user_before = fs::metadata(c.root.join("user"))
        .unwrap()
        .modified()
        .unwrap();
    let ssh_before = fs::metadata(c.root.join("user/.ssh"))
        .unwrap()
        .modified()
        .unwrap();
    let rows = c.list();
    assert_eq!(
        rows[0]["keys"],
        json!(["~/.ssh/id_ed25519", "~/.ssh/id_ed25519_work"])
    );
    assert!(
        rows[0]["fingerprint"]
            .as_str()
            .unwrap()
            .contains("SHA256:fixture")
    );
    assert_eq!(
        fs::read_to_string(c.root.join("ssh.log")).unwrap(),
        "-G\nmacbook\n-lF\nmacbook.local\n"
    );
    assert_eq!(
        fs::metadata(c.root.join("user"))
            .unwrap()
            .modified()
            .unwrap(),
        user_before
    );
    assert_eq!(
        fs::metadata(c.root.join("user/.ssh"))
            .unwrap()
            .modified()
            .unwrap(),
        ssh_before
    );
    assert_eq!(fs::read_dir(c.root.join("user")).unwrap().count(), 1);
    assert_eq!(fs::read_dir(c.root.join("user/.ssh")).unwrap().count(), 3);
    for (p, b) in [
        "settings.json",
        "machines.json",
        "user/.ssh/config",
        "user/.ssh/known_hosts",
        "user/.ssh/id_ed25519",
    ]
    .iter()
    .zip(before)
    {
        assert_eq!(fs::read(c.root.join(p)).unwrap(), b);
    }
}

#[test]
fn machine_discovery_error_is_per_row() {
    let c = Core::new(
        json!({"machines":{
            "macbook":{"projects":{}},
            "-bad-alias":{"projects":{}},
            "bad-host":{"host":"bad host"},
            "bad-user":{"user":"bad user"},
            "bad-port":{"port":0}
        }}),
        json!({"version":1,"machines":[]}),
    );
    let rows = c.list();
    assert_eq!(rows.as_array().unwrap().len(), 5);
    let valid = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["machine"] == "macbook")
        .unwrap();
    assert_eq!(valid["host"], "macbook.local");
    assert_eq!(valid["user"], "me");
    assert_eq!(valid["port"], 22);
    assert_eq!(valid["keys"].as_array().unwrap().len(), 2);
    assert_eq!(valid["fingerprint"], "SHA256:fixture (ED25519)");
    assert!(valid["error"].is_null(), "{valid}");
    let log = fs::read_to_string(c.root.join("ssh.log")).unwrap();
    for alias in ["-bad-alias", "bad-host", "bad-user", "bad-port"] {
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["machine"] == alias)
            .unwrap();
        assert!(
            row["error"].as_str().is_some_and(|e| e.contains("invalid")),
            "{row}"
        );
        assert_eq!(row["keys"], json!([]));
        assert!(row["fingerprint"].is_null());
        assert!(
            !log.lines().any(|line| line == alias),
            "spawned for {alias}: {log}"
        );
    }
    assert!(
        !log.contains("bad host") && !log.contains("bad user"),
        "{log}"
    );
}

#[test]
fn ssh_match_exec_documented() {
    let text = include_str!("../../../docs/first-run.md");
    let machines = text
        .split("## Machines over SSH")
        .nth(1)
        .expect("Machines SSH explanation is missing");
    assert!(machines.contains("`ssh -G` evaluates the user's OpenSSH `Match exec` rules"));
    assert!(machines.contains("can execute the commands those rules specify"));
    assert!(machines.contains("Nunchiro edits no SSH config"));
}
#[test]
fn forget_machine_refused_while_session_runs() {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    let started = c.call(
        json!({"op":"start","session":{"kind":"shell","project":c.root,"args":["/bin/cat"]}}),
    );
    let mut row = started["Ok"]["session"].clone();
    assert!(row.is_object(), "{started}");
    row["machine"] = json!("macbook");
    // Q10: the machine's own id (a pushed row with a local id is not shown).
    row["id"] = json!("q10-remote");
    fs::write(
        c.root.join("rows"),
        format!("{}\n", json!({"type":"sessions","sessions":[row]})),
    )
    .unwrap();
    c.call(json!({"op":"snapshot"}));
    wait(|| {
        c.call(json!({"op":"snapshot"}))["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["machine"] == "macbook")
    });
    let before = fs::read(c.root.join("settings.json")).unwrap();
    let r = c.call(json!({"op":"forget_machine","alias":"macbook"}));
    assert!(
        r["Err"]
            .as_str()
            .unwrap()
            .contains("Stop its sessions first"),
        "{r}"
    );
    assert_eq!(fs::read(c.root.join("settings.json")).unwrap(), before);
}
#[test]
fn machine_ops_refused_for_peer_and_agent() {
    let c = core();
    let script = r#"import socket,os,json
h=os.environ['NUNCHIRO_HOME']
out=[]
for token in [os.environ['NUNCHIRO_TOKEN'],open(h+'/core.token').read().strip()]:
 for r in [{'op':'add_machine','alias':'escape','host':'escape'},{'op':'forget_machine','alias':'macbook'},{'op':'machine_details'}]:
  s=socket.socket(socket.AF_UNIX);s.connect(h+'/core.sock');s.sendall((json.dumps({'token':token,'request':r})+'\n').encode());out.append(json.loads(s.makefile().readline()));s.close()
open(h+'/probe.token','w').write(os.environ['NUNCHIRO_TOKEN'])
open(h+'/refused.tmp','w').write(json.dumps(out));os.replace(h+'/refused.tmp',h+'/refused.json')
"#;
    let r=c.call(json!({"op":"start","session":{"kind":"shell","project":c.root,"args":["/bin/sh","-c","/usr/bin/python3 -c \"$1\"; exec cat","probe",script]}}));
    assert!(r["Ok"].is_object(), "{r}");
    wait(|| c.root.join("refused.json").exists());
    let replies: Vec<Value> =
        serde_json::from_slice(&fs::read(c.root.join("refused.json")).unwrap()).unwrap();
    assert_eq!(replies.len(), 6);
    for r in replies {
        assert!(
            r["Err"]
                .as_str()
                .is_some_and(|e| e.contains("granted") || e.contains("owner")),
            "{r}"
        );
    }
    assert_eq!(
        fs::read_to_string(c.root.join("settings.json")).unwrap(),
        "{}"
    );
    let port = c.call(json!({"op":"window_auth"}))["Ok"]["port"]
        .as_u64()
        .unwrap() as u16;
    let mut request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "tauri://localhost".parse().unwrap());
    let token = fs::read_to_string(c.root.join("probe.token")).unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("nunchiro.v1, nunchiro.token.{}", token.trim())
            .parse()
            .unwrap(),
    );
    let socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    match tungstenite::client(request, socket) {
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => {
            assert_eq!(r.status().as_u16(), 401)
        }
        _ => panic!("an HTTP session token must not open the owner window API"),
    }
    assert!(!c.root.join("ssh.log").exists());
}

#[test]
fn machine_settings_reject_broken_store_without_writes() {
    let c = core();
    for broken in [
        json!([]),
        json!({"machines":[]}),
        json!({"machines":{"bad":{"projects":"wrong"}}}),
    ] {
        fs::write(c.root.join("settings.json"), broken.to_string()).unwrap();
        let before = fs::read(c.root.join("machines.json")).unwrap();
        assert!(add(&c)["Err"].is_string());
        assert_eq!(
            fs::read(c.root.join("settings.json")).unwrap(),
            broken.to_string().as_bytes()
        );
        assert_eq!(fs::read(c.root.join("machines.json")).unwrap(), before);
    }
    fs::write(c.root.join("settings.json"), "{}").unwrap();
    for broken in [
        json!([]),
        json!({"version":1,"machines":4}),
        json!({"version":1,"machines":["macbook","macbook"]}),
    ] {
        fs::write(c.root.join("machines.json"), broken.to_string()).unwrap();
        assert!(add(&c)["Err"].is_string());
        assert_eq!(
            fs::read_to_string(c.root.join("settings.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read(c.root.join("machines.json")).unwrap(),
            broken.to_string().as_bytes()
        );
    }
}

#[test]
fn retry_reconnects_without_remote_restart() {
    let c = core();
    fs::write(c.root.join("protocol"), "99").unwrap();
    assert!(add(&c)["Ok"].is_object());
    c.call(json!({"op":"snapshot"}));
    wait(|| c.list()[0]["channel"]["state"] == "version_mismatch");
    fs::write(c.root.join("protocol"), "2").unwrap();
    let r = c.call(json!({"op":"machine_status","label":"macbook","retry":true}));
    assert_eq!(r["Ok"]["machines"][0]["channel"]["state"], "up", "{r}");
    let log = fs::read_to_string(c.root.join("ssh.log")).unwrap();
    assert!(!log.contains("restart"));
}
#[test]
fn forget_refused_during_remote_start() {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    fs::copy(c.root.join("bin/ssh"), c.root.join("bin/fixture-ssh")).unwrap();
    write_ssh(
        &c.root,
        r#"for last; do :; done
case "$last" in *--stream*) exec "$NUNCHIRO_HOME/bin/fixture-ssh" "$@" ;; esac
touch "$NUNCHIRO_HOME/request-started"
hold release
printf '{"Ok":{"type":"ack"}}\n'
"#,
    );
    thread::scope(|scope| {
        let pending=scope.spawn(||c.call(json!({"op":"remote","machine":"macbook","request":{"op":"start","session":{"kind":"shell","project":"/fixture","args":["/bin/cat"]}}})));
        wait(|| c.root.join("request-started").exists());
        let r = c.call(json!({"op":"forget_machine","alias":"macbook"}));
        fs::write(c.root.join("release"), "").unwrap();
        pending.join().unwrap();
        assert!(
            r["Err"].as_str().is_some_and(|e| e.contains("progress")),
            "{r}"
        );
        assert_eq!(c.list()[0]["machine"], "macbook");
    });
}
#[test]
fn forget_refused_after_started_reply_before_push() {
    started_reply_before_push(false);
}
#[test]
fn answered_start_item_is_not_reoffered_by_stale_push() {
    started_reply_before_push(true);
}
fn started_reply_before_push(answer: bool) {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    let mut started = c.call(
        json!({"op":"start","session":{"kind":"shell","project":c.root,"args":["/bin/cat"]}}),
    );
    assert!(started["Ok"]["session"].is_object(), "{started}");
    // Q10: the machine's own id (a pushed row with a local id is not shown).
    started["Ok"]["session"]["id"] = json!("q10-remote");
    if answer {
        let id = started["Ok"]["session"]["id"].clone();
        started["Ok"]["session"]["pending"] = json!([{"id":"start-item","session_id":id,"scope":"/fixture","kind":"permission","text":"Fixture decision","choices":[],"sources":["fixture"],"observed_at":1,"actionable":true,"reconciled":true,"hook_event_id":null,"risky":false}]);
    }
    fs::write(c.root.join("started-reply"), started.to_string()).unwrap();
    write_ssh(
        &c.root,
        r#"for last; do :; done
case "$last" in *--stream*)
 ends_at_eof
 printf '{"type":"hello","protocol":2,"version":"0.9.4"}\n{"type":"sessions","sessions":[]}\n'
 hold push-empty
 printf '{"type":"sessions","sessions":[]}\n'
 touch "$NUNCHIRO_HOME/pushed-empty"
 hold push-exited
 cat "$NUNCHIRO_HOME/exited-row"
 wait
 ;;
*) request=$(cat)
 case "$request" in *'"op":"answer"'*) printf '{"Ok":{"type":"ack"}}\n' ;; *) cat "$NUNCHIRO_HOME/started-reply" ;; esac
 ;;
esac
"#,
    );
    c.call(json!({"op":"snapshot"}));
    wait(|| {
        c.call(json!({"op":"machine_status","label":"macbook"}))["Ok"]["machines"][0]["channel"]["state"]
            == "up"
    });
    let r=c.call(json!({"op":"remote","machine":"macbook","request":{"op":"start","session":{"kind":"shell","project":"/fixture","args":["/bin/cat"]}}}));
    assert_eq!(r["Ok"]["session"]["state"], "running", "{r}");
    let r = c.call(json!({"op":"forget_machine","alias":"macbook"}));
    assert!(
        r["Err"]
            .as_str()
            .is_some_and(|e| e.contains("Stop its sessions first")),
        "{r}"
    );
    if answer {
        let r=c.call(json!({"op":"remote","machine":"macbook","request":{"op":"answer","item":"start-item","answer":{"type":"deny"}}}));
        assert_eq!(r["Ok"]["type"], "ack", "{r}");
    }
    fs::write(c.root.join("push-empty"), "").unwrap();
    wait(|| c.root.join("pushed-empty").exists());
    thread::sleep(Duration::from_millis(50));
    if answer {
        let snapshot = c.call(json!({"op":"snapshot"}));
        let row = snapshot["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["machine"] == "macbook")
            .unwrap();
        assert_eq!(
            row["pending"],
            json!([]),
            "an answered decision must not return from an unseen start clone"
        );
    }
    let r = c.call(json!({"op":"forget_machine","alias":"macbook"}));
    assert!(
        r["Err"]
            .as_str()
            .is_some_and(|e| e.contains("Stop its sessions first")),
        "{r}"
    );
    let mut exited = started["Ok"]["session"].clone();
    exited["state"] = json!("exited");
    fs::write(
        c.root.join("exited-row"),
        format!("{}\n", json!({"type":"sessions","sessions":[exited]})),
    )
    .unwrap();
    fs::write(c.root.join("push-exited"), "").unwrap();
    wait(|| {
        c.call(json!({"op":"snapshot"}))["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["machine"] == "macbook" && s["state"] == "exited")
    });
    assert!(c.call(json!({"op":"forget_machine","alias":"macbook"}))["Ok"].is_object());
}

#[test]
fn window_starts_machine_channel_without_cli_snapshot() {
    let c = core();
    assert!(add(&c)["Ok"].is_object());
    // The fixture's initial owner snapshot ran before this alias existed; no CLI snapshot follows Add.
    let mut ws = window(&c);
    loop {
        if let tungstenite::Message::Text(text) = ws.read().unwrap()
            && serde_json::from_str::<Value>(&text).unwrap()["event"] == "snapshot"
        {
            break;
        }
    }
    wait(|| c.list()[0]["channel"]["state"] == "up");
    let details = c.list();
    assert_eq!(details[0]["channel"]["remote_version"], "0.9.4");
    assert!(details[0]["channel"]["since_ms"].as_u64().unwrap() > 0);
    // The time from starting ssh to the relay hello is the one-shot status time (V2.5-23).
    assert!(details[0]["channel"]["latency_ms"].is_u64());
    ws.close(None).unwrap();
}

fn window(c: &Core) -> tungstenite::WebSocket<std::net::TcpStream> {
    let boot = c.call(json!({"op":"window_auth"}))["Ok"].clone();
    let port = boot["port"].as_u64().unwrap() as u16;
    let mut request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "tauri://localhost".parse().unwrap());
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!(
            "nunchiro.v1, nunchiro.token.{}",
            boot["token"].as_str().unwrap()
        )
        .parse()
        .unwrap(),
    );
    let socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (ws, _) = tungstenite::client(request, socket).unwrap();
    ws
}

/// Ticket 980, real SSH look 11-17: the window's New session on a machine was refused with "transport requires owner
/// dispatch" (its loop had no arm for `remote`). It goes out over ssh, under the owner's forwarding rules.
#[test]
fn window_request_for_a_machine_is_forwarded() {
    let c = core();
    let mut ws = window(&c);
    assert!(add(&c)["Ok"].is_object());
    wait(|| c.list()[0]["channel"]["state"] == "up");
    let mut ask = |id: u64, request: Value| {
        ws.send(tungstenite::Message::Text(
            json!({"id":id,"request":{"op":"remote","machine":"macbook","request":request}})
                .to_string()
                .into(),
        ))
        .unwrap();
        loop {
            if let tungstenite::Message::Text(text) = ws.read().unwrap() {
                let reply: Value = serde_json::from_str(&text).unwrap();
                if reply["id"] == id {
                    return reply["response"].clone();
                }
            }
        }
    };
    let before = fs::read_to_string(c.root.join("ssh.log")).unwrap().len();
    let started = ask(
        7,
        json!({"op":"start","session":{"kind":"shell","project":"/fixture"}}),
    );
    assert!(!started.to_string().contains("owner dispatch"), "{started}");
    let log = fs::read_to_string(c.root.join("ssh.log")).unwrap();
    assert!(
        log[before..].contains("nunchiro machine relay"),
        "the start went out over ssh: {}",
        &log[before..]
    );
    let local = ask(8, json!({"op":"window_auth"}));
    assert!(
        local["Err"]
            .as_str()
            .is_some_and(|e| e.contains("local owner-only")),
        "{local}"
    );
}

#[test]
fn broken_machine_store_keeps_local_window_connected() {
    let c = core();
    let mut ws = window(&c);
    fs::write(c.root.join("machines.json"), "broken registry").unwrap();
    let mut snapshots = 0;
    while snapshots < 2 {
        if let tungstenite::Message::Text(text) = ws.read().unwrap()
            && serde_json::from_str::<Value>(&text).unwrap()["event"] == "snapshot"
        {
            snapshots += 1;
            if snapshots == 1 {
                assert!(c.call(json!({"op":"start","session":{"kind":"shell","project":c.root,"args":["/bin/cat"]}}))["Ok"].is_object());
            }
        }
    }
    assert!(c.call(json!({"op":"machine_details"}))["Err"].is_string());
    ws.send(tungstenite::Message::Text(
        json!({"id":41,"request":{"op":"list"}}).to_string().into(),
    ))
    .unwrap();
    loop {
        if let tungstenite::Message::Text(text) = ws.read().unwrap() {
            let reply: Value = serde_json::from_str(&text).unwrap();
            if reply["id"] == 41 {
                assert!(reply["response"]["Ok"].is_object(), "{reply}");
                break;
            }
        }
    }
    ws.close(None).unwrap();
}

#[test]
fn machine_refresh_observes_alias_changes() {
    let mut c = core();
    let mut ws = window(&c);
    // Add after the window's first (empty) refresh: discovery must not be one-shot.
    assert!(add(&c)["Ok"].is_object());
    wait(|| c.list()[0]["channel"]["state"] == "up");
    let pid: i32 = fs::read_to_string(c.root.join("masters"))
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .parse()
        .unwrap();
    assert!(c.call(json!({"op":"forget_machine","alias":"macbook"}))["Ok"].is_object());
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    thread::sleep(Duration::from_millis(1150));
    assert_eq!(c.list(), json!([]));
    assert_eq!(
        fs::read_to_string(c.root.join("masters"))
            .unwrap()
            .lines()
            .count(),
        1,
        "forgotten aliases must not restart after refresh"
    );
    assert!(add(&c)["Ok"].is_object());
    wait(|| c.list()[0]["channel"]["state"] == "up");
    let pid: i32 = fs::read_to_string(c.root.join("masters"))
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .parse()
        .unwrap();
    assert!(c.call(json!({"op":"stop"}))["Ok"].is_object());
    let until = Instant::now() + Duration::from_secs(5);
    while c.guard.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "core shutdown timed out");
        thread::sleep(Duration::from_millis(20));
    }
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "shutdown reaps the channel"
    );
    let _ = ws.close(None);
}

// v25f: the Add form's suggestions and Test answer on the owner socket and in the window, and add nothing.
#[test]
fn aliases_and_probe_on_socket_and_window() {
    let c = core();
    let aliases = c.call(json!({"op":"machine_aliases"}));
    assert!(
        aliases["Ok"]["aliases"]
            .as_array()
            .unwrap()
            .contains(&json!("macbook")),
        "{aliases}"
    );
    let mut ws = window(&c);
    ws.send(tungstenite::Message::Text(
        json!({"id":7,"request":{"op":"machine_probe","host":"macbook","user":"me","port":22}})
            .to_string()
            .into(),
    ))
    .unwrap();
    loop {
        if let tungstenite::Message::Text(text) = ws.read().unwrap() {
            let reply: Value = serde_json::from_str(&text).unwrap();
            if reply["id"] == 7 {
                assert_eq!(
                    reply["response"]["Ok"],
                    json!({"type":"machine_probe","error":null}),
                    "{reply}"
                );
                break;
            }
        }
    }
    ws.close(None).unwrap();
    let log = fs::read_to_string(c.root.join("ssh.log")).unwrap();
    assert!(
        log.contains("BatchMode=yes\n-o\nConnectTimeout=8")
            && log.contains("User=me\n-o\nPort=22\nmacbook\ntrue"),
        "{log}"
    );
    assert_eq!(c.list(), json!([]));
    assert!(add(&c)["Ok"].is_object());
    let after = c.call(json!({"op":"machine_aliases"}));
    assert!(
        !after["Ok"]["aliases"]
            .as_array()
            .unwrap()
            .contains(&json!("macbook")),
        "{after}"
    );
}

/// Q10: an SSH machine whose master can be dropped (`drop`) and whose one-shot requests a small Python remote answers:
/// `read` replays the file `out` from the cursor; every other request is logged to `requests` and acknowledged.
fn remote_machine(root: &Path) {
    fs::write(
        root.join("one-shot.py"),
        r#"import json, os, sys
h = os.environ['NUNCHIRO_HOME']
r = json.load(sys.stdin)['request']
open(h + '/requests', 'a').write(json.dumps(r) + '\n')
if r['op'] == 'read':
    out = open(h + '/out', 'rb').read()
    after = r.get('after', 0)
    data = list(out[after:])
    print(json.dumps({'Ok': {'type': 'output', 'data': data, 'start': after, 'end': after + len(data), 'truncated': False}}))
else:
    print(json.dumps({'Ok': {'type': 'ack'}}))
"#,
    )
    .unwrap();
    fs::write(root.join("out"), "remote$ ").unwrap();
    write_ssh(
        root,
        r#"for last; do :; done
case "$last" in *--stream*)
 ends_at_eof
 printf '%s\n' "$$" >> "$NUNCHIRO_HOME/masters"
 printf '{"type":"hello","protocol":2,"version":"0.9.4"}\n'
 cat "$NUNCHIRO_HOME/rows"
 hold drop
 kill $eof
 rm "$NUNCHIRO_HOME/drop"
 exit 255 ;;
esac
exec /usr/bin/python3 "$NUNCHIRO_HOME/one-shot.py"
"#,
    );
}
/// A remote row: a real row of this core with another id, pushed by the machine (and `local`, a pushed copy of a local id).
fn push_rows(c: &Core, id: &str) -> Value {
    let started = c.call(
        json!({"op":"start","session":{"kind":"shell","project":c.root,"args":["/bin/cat"]}}),
    );
    let local = started["Ok"]["session"].clone();
    assert!(local.is_object(), "{started}");
    let mut row = local.clone();
    row["id"] = json!(id);
    row["pending"] = json!([{"id":"q10-item","session_id":id,"scope":"/fixture","kind":"permission","text":"Fixture decision","choices":[],"sources":["fixture"],"observed_at":1,"actionable":true,"reconciled":true,"hook_event_id":null,"risky":false}]);
    fs::write(
        c.root.join("rows"),
        format!("{}\n", json!({"type":"sessions","sessions":[row, local]})),
    )
    .unwrap();
    local
}
enum Got {
    Text(Value),
    Output(Value, Vec<u8>),
}
fn next(ws: &mut tungstenite::WebSocket<std::net::TcpStream>) -> Got {
    loop {
        match ws.read().unwrap() {
            tungstenite::Message::Text(text) => {
                return Got::Text(serde_json::from_str(&text).unwrap());
            }
            tungstenite::Message::Binary(b) => {
                let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
                return Got::Output(
                    serde_json::from_slice(&b[4..4 + n]).unwrap(),
                    b[4 + n..].to_vec(),
                );
            }
            _ => {}
        }
    }
}
fn send(ws: &mut tungstenite::WebSocket<std::net::TcpStream>, frame: Value) {
    ws.send(tungstenite::Message::Text(frame.to_string().into()))
        .unwrap();
}
/// The next pushed snapshot event for which `check` holds.
fn snapshot_until(
    ws: &mut tungstenite::WebSocket<std::net::TcpStream>,
    mut check: impl FnMut(&[Value]) -> bool,
) -> Vec<Value> {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < end, "timed out");
        if let Got::Text(v) = next(ws)
            && v["event"] == "snapshot"
            && check(v["sessions"].as_array().unwrap())
        {
            return v["sessions"].as_array().unwrap().clone();
        }
    }
}
fn reply(ws: &mut tungstenite::WebSocket<std::net::TcpStream>, id: u64) -> Value {
    loop {
        if let Got::Text(v) = next(ws)
            && v["id"] == id
        {
            return v["response"].clone();
        }
    }
}
fn output(ws: &mut tungstenite::WebSocket<std::net::TcpStream>, session: &str) -> (Value, Vec<u8>) {
    loop {
        if let Got::Output(head, data) = next(ws)
            && head["session"] == session
        {
            return (head, data);
        }
    }
}

/// Q10 (real SSH look 11-17): the window's pushed snapshot had this Mac's rows only. It now carries the machine's rows
/// with their machine; a pushed row with a local id is not shown twice. Its tab's terminal gets the remote bytes,
/// typing, resize and close go to the machine in order, and close takes the row away.
#[test]
fn window_shows_and_drives_a_remote_session() {
    let c = core();
    remote_machine(&c.root);
    let local = push_rows(&c, "q10-remote");
    let local_id = local["id"].as_str().unwrap().to_string();
    let mut ws = window(&c);
    assert!(add(&c)["Ok"].is_object());
    let rows = snapshot_until(&mut ws, |rows| {
        rows.iter().any(|s| s["machine"] == "macbook")
    });
    let remote: Vec<_> = rows.iter().filter(|s| s["id"] == "q10-remote").collect();
    assert_eq!(remote.len(), 1);
    assert_eq!(remote[0]["machine"], "macbook");
    let same: Vec<_> = rows
        .iter()
        .filter(|s| s["id"] == local_id.as_str())
        .collect();
    assert_eq!(same.len(), 1, "a pushed copy of a local id is not shown");
    assert!(same[0]["machine"].is_null());

    send(&mut ws, json!({"id":1,"watch":"q10-remote","after":0}));
    assert_eq!(reply(&mut ws, 1)["Ok"]["type"], "ack");
    let (head, data) = output(&mut ws, "q10-remote");
    assert_eq!(
        (head["replay"].clone(), data),
        (json!(true), b"remote$ ".to_vec())
    );
    for (id, request) in [
        (2, json!({"op":"send_text","id":"q10-remote","text":"l"})),
        (3, json!({"op":"send_text","id":"q10-remote","text":"s"})),
        (
            4,
            json!({"op":"send_keys","id":"q10-remote","keys":["Enter"]}),
        ),
        (
            5,
            json!({"op":"resize","id":"q10-remote","cols":100,"rows":30}),
        ),
    ] {
        send(&mut ws, json!({"id":id,"request":request}));
        assert_eq!(reply(&mut ws, id)["Ok"]["type"], "ack", "{request}");
    }
    // Keys sent faster than the machine answers go in order (queued ones may go together in one request).
    for (id, text) in [(11, "a"), (12, "b"), (13, "c")] {
        send(
            &mut ws,
            json!({"id":id,"request":{"op":"send_text","id":"q10-remote","text":text}}),
        );
    }
    for id in [11, 12, 13] {
        assert_eq!(reply(&mut ws, id)["Ok"]["type"], "ack");
    }
    // The remote screen moves on after the keys (written here: a reply loop above skips output frames).
    fs::write(c.root.join("out"), "remote$ ls\r\n").unwrap();
    let (head, data) = output(&mut ws, "q10-remote");
    assert_eq!(
        (head["replay"].clone(), head["start"].clone(), data),
        (json!(false), json!(8), b"ls\r\n".to_vec())
    );
    let sent: Vec<Value> = fs::read_to_string(c.root.join("requests"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .filter(|r: &Value| r["op"] != "read")
        .collect();
    assert_eq!(
        sent[..4]
            .iter()
            .map(|r| r["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["send_text", "send_text", "send_keys", "resize"],
        "in order"
    );
    let typed: String = sent[4..]
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect();
    assert_eq!(typed, "abc");
    assert_eq!(
        (sent[0]["text"].clone(), sent[1]["text"].clone()),
        (json!("l"), json!("s"))
    );
    // A local session of an id the machine also pushed stays this core's: its watch never goes out.
    let before = fs::read_to_string(c.root.join("requests")).unwrap();
    send(
        &mut ws,
        json!({"id":6,"request":{"op":"resize","id":local_id,"cols":90,"rows":20}}),
    );
    assert!(reply(&mut ws, 6)["Ok"].is_object());
    assert_eq!(fs::read_to_string(c.root.join("requests")).unwrap(), before);

    // The pushed decision's answer (the strip's plain `answer`) goes to the machine.
    send(
        &mut ws,
        json!({"id":8,"request":{"op":"answer","item":"q10-item","answer":{"type":"deny"}}}),
    );
    assert_eq!(reply(&mut ws, 8)["Ok"]["type"], "ack");
    assert!(
        fs::read_to_string(c.root.join("requests"))
            .unwrap()
            .contains(r#""item": "q10-item""#)
    );
    send(
        &mut ws,
        json!({"id":7,"request":{"op":"close","id":"q10-remote"}}),
    );
    assert_eq!(reply(&mut ws, 7)["Ok"]["type"], "ack");
    // The machine's next push (here: none) decides; until then the closed row is gone from the cache.
    snapshot_until(&mut ws, |rows| {
        !rows.iter().any(|s| s["id"] == "q10-remote")
    });
    ws.close(None).unwrap();
}

/// Q10: a master that dies leaves the rows with the machine's problem card and nothing is lost; the next master brings
/// them back and an open tab's terminal goes on from its cursor, without a new window or a core restart.
#[test]
fn remote_tab_survives_a_dropped_master() {
    let c = core();
    remote_machine(&c.root);
    push_rows(&c, "q10-remote");
    let mut ws = window(&c);
    assert!(add(&c)["Ok"].is_object());
    snapshot_until(&mut ws, |rows| {
        rows.iter().any(|s| s["machine"] == "macbook")
    });
    send(&mut ws, json!({"id":1,"watch":"q10-remote","after":0}));
    output(&mut ws, "q10-remote");
    fs::write(c.root.join("drop"), "").unwrap();
    let rows = snapshot_until(&mut ws, |rows| {
        rows.iter()
            .any(|s| s["id"] == "q10-remote" && s["problem"].is_object())
    });
    let row = rows.iter().find(|s| s["id"] == "q10-remote").unwrap();
    assert_eq!(row["problem"]["case"], "machine_unreachable", "{row}");
    fs::write(c.root.join("out"), "remote$ back\r\n").unwrap();
    // The tab's read goes on once the channel is up, which can be before the window's next snapshot: the output
    // frame and the snapshot that clears the card come in either order.
    let (mut cleared, mut back) = (false, None);
    let end = Instant::now() + Duration::from_secs(10);
    while !cleared || back.is_none() {
        assert!(Instant::now() < end, "timed out");
        match next(&mut ws) {
            Got::Text(v) if v["event"] == "snapshot" => {
                cleared |= v["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["id"] == "q10-remote" && s["problem"].is_null());
            }
            Got::Output(head, data) if head["session"] == "q10-remote" => back = Some((head, data)),
            _ => {}
        }
    }
    let (head, data) = back.unwrap();
    assert_eq!(
        (head["replay"].clone(), data),
        (json!(false), b"back\r\n".to_vec())
    );
    assert_eq!(
        fs::read_to_string(c.root.join("masters"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    ws.close(None).unwrap();
}
/// w25-r: a fake master ends without its core, like a real ssh: when its stdin closes even though its parent still
/// runs (here the test; on a gate a reused core PID), and when its test home is gone.
#[test]
fn fake_master_ends_without_its_core() {
    let root = home::short("m41");
    let gone = home::short("m41");
    fs::create_dir_all(root.join("bin")).unwrap();
    remote_machine(&root);
    fs::set_permissions(root.join("bin/ssh"), fs::Permissions::from_mode(0o700)).unwrap();
    let start = |home: &Path| {
        fs::write(home.join("rows"), "").unwrap();
        Command::new(root.join("bin/ssh"))
            .args(["--", "nunchiro machine relay --stream"])
            .env("NUNCHIRO_HOME", home)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut masters = [("stdin closed", start(&root)), ("home gone", start(&gone))];
    wait(|| root.join("masters").exists() && gone.join("masters").exists());
    drop(masters[0].1.stdin.take());
    remove_home(&gone);
    let end = Instant::now() + Duration::from_secs(5);
    while masters
        .iter_mut()
        .any(|(_, m)| m.try_wait().unwrap().is_none())
        && Instant::now() < end
    {
        thread::sleep(Duration::from_millis(20));
    }
    let mut running = vec![];
    for (case, m) in &mut masters {
        if m.try_wait().unwrap().is_none() {
            running.push(*case);
            // Not yet waited for, so its group is still ours.
            unsafe { libc::killpg(m.id() as i32, libc::SIGKILL) };
            let _ = m.wait();
        }
    }
    assert!(
        running.is_empty(),
        "fake master still runs after: {running:?}"
    );
    remove_home(&root);
}
