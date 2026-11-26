use super::*;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "nunchiro-ext-{tag}-{}-{}",
        std::process::id(),
        crate::store::new_id().unwrap()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn mcp_list_is_read_only_and_hides_env_values() {
    let home = tmp("home");
    let user = tmp("user");
    std::fs::create_dir_all(user.join(".codex")).unwrap();
    std::fs::create_dir_all(user.join(".claude")).unwrap();
    let claude = r#"{"mcpServers":{"github":{"command":"gh-mcp","args":["--stdio"],"env":{"GITHUB_TOKEN":"SECRET-VALUE-1"}},"remote":{"url":"https://x.test/?token=SECRET-VALUE-3"}}}"#;
    let codex = "[mcp_servers.db]\ncommand = \"db-mcp\"\nargs = [\"-v\"]\n[mcp_servers.db.env]\nDB_PASS = \"SECRET-VALUE-2\"\n";
    std::fs::write(user.join(".claude.json"), claude).unwrap();
    std::fs::write(user.join(".codex/config.toml"), codex).unwrap();
    let before = (
        std::fs::read(user.join(".claude.json")).unwrap(),
        std::fs::read(user.join(".codex/config.toml")).unwrap(),
    );

    let reply = handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap();
    let text = serde_json::to_string(&reply).unwrap();
    assert!(
        !text.contains("SECRET-VALUE"),
        "an env value or URL token left the module: {text}"
    );
    let Reply::Extensions { mcp, .. } = reply else {
        panic!("wrong reply")
    };
    let gh = mcp.iter().find(|s| s.name == "github").unwrap();
    assert_eq!(
        (gh.agent.as_str(), gh.command.clone(), gh.env.clone()),
        (
            "claude",
            vec!["gh-mcp".to_string(), "--stdio".into()],
            vec!["GITHUB_TOKEN".to_string()]
        )
    );
    let db = mcp.iter().find(|s| s.name == "db").unwrap();
    assert_eq!(
        (db.agent.as_str(), db.env.clone()),
        ("codex", vec!["DB_PASS".to_string()])
    );
    // Read only: the agents' files are byte-identical, and `Debug` of the list carries no value either.
    assert!(!format!("{mcp:?}").contains("SECRET-VALUE"));
    assert_eq!(
        before,
        (
            std::fs::read(user.join(".claude.json")).unwrap(),
            std::fs::read(user.join(".codex/config.toml")).unwrap()
        )
    );
    assert_eq!(std::fs::read_dir(user.join(".claude")).unwrap().count(), 0);
}

#[test]
fn mcp_add_goes_per_session_via_mcp_config() {
    let home = tmp("home");
    let user = tmp("user");
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    let add = Request::ExtensionsMcpAdd {
        name: "files".into(),
        command: vec!["files-mcp".into(), "--root".into(), "/tmp/x".into()],
        project: None,
    };
    let Reply::Extensions { own, .. } = handle(&home, &user, Caller::Window, add).unwrap() else {
        panic!()
    };
    assert_eq!(own.len(), 1);
    // Claude gets the verified servers inline, never the path of a file an agent can write.
    let flags = claude_flags(&home, &enabled(None), Path::new("/p"));
    assert_eq!(flags.len(), 1, "{flags:?}");
    let inline = flags[0].to_str().unwrap().strip_prefix("--mcp-config=");
    let inline: serde_json::Value = serde_json::from_str(inline.unwrap()).unwrap();
    assert_eq!(
        inline,
        serde_json::json!({"mcpServers":{"files":{"command":"files-mcp","args":["--root","/tmp/x"]}}})
    );
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(home.join("extensions/mcp.json")).unwrap()).unwrap();
    assert_eq!(file["mcpServers"]["files"]["command"], "files-mcp");
    let codex: Vec<String> = codex_flags(&home, Path::new("/p"))
        .into_iter()
        .map(|o| o.into_string().unwrap())
        .collect();
    assert_eq!(
        codex,
        [
            "-c",
            "mcp_servers.files.command=\"files-mcp\"",
            "-c",
            "mcp_servers.files.args=[\"--root\",\"/tmp/x\"]"
        ]
    );
    // A name that would break out of the TOML key is refused.
    assert!(mcp_add(&home, "a.b=1", &["x".into()], None).is_err());
    assert!(mcp_add(&home, "ok", &[], None).is_err());
    // Remove drops it from the next launch; nothing went into the user's home.
    handle(
        &home,
        &user,
        Caller::Window,
        Request::ExtensionsMcpRemove {
            name: "files".into(),
        },
    )
    .unwrap();
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    assert_eq!(std::fs::read_dir(&user).unwrap().count(), 0);
}

// Review M1: mcp.json is plain JSON an agent can write, so only an entry the owner's window sealed reaches a launch.
#[test]
fn hand_written_or_edited_own_server_never_reaches_a_launch() {
    let home = tmp("home");
    let user = tmp("user");
    let file = home.join("extensions/mcp.json");
    let names = |flags: Vec<OsString>| -> Vec<String> {
        flags
            .into_iter()
            .map(|o| o.into_string().unwrap())
            .collect()
    };
    // Hand-written: no seal, so neither agent launches it, and the list says it changed outside Nunchiro.
    std::fs::create_dir_all(home.join("extensions")).unwrap();
    std::fs::write(
        &file,
        r#"{"mcpServers":{"x":{"command":"sh","args":["-c","evil"]}}}"#,
    )
    .unwrap();
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    assert!(codex_flags(&home, Path::new("/p")).is_empty());
    assert!(
        own_servers(&home)
            .iter()
            .all(|s| s.name == "x" && s.changed)
    );
    // Added from the window: sealed and launched; the hand-written one stays out.
    let add = Request::ExtensionsMcpAdd {
        name: "files".into(),
        command: vec!["files-mcp".into(), "-v".into()],
        project: None,
    };
    handle(&home, &user, Caller::Window, add).unwrap();
    let claude = names(claude_flags(&home, &enabled(None), Path::new("/p")));
    assert_eq!(claude.len(), 1);
    assert!(
        claude[0].contains("files-mcp") && !claude[0].contains("evil"),
        "{claude:?}"
    );
    let files_only = [
        "-c",
        "mcp_servers.files.command=\"files-mcp\"",
        "-c",
        "mcp_servers.files.args=[\"-v\"]",
    ];
    assert_eq!(names(codex_flags(&home, Path::new("/p"))), files_only);
    let mut listed: Vec<(String, bool)> = own_servers(&home)
        .into_iter()
        .map(|s| (s.name, s.changed))
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        [("files".to_string(), false), ("x".to_string(), true)]
    );
    // Edited after the seal (args swapped, seal kept): out again.
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    v["mcpServers"]["files"]["args"] = serde_json::json!(["-c", "evil"]);
    std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    assert!(codex_flags(&home, Path::new("/p")).is_empty());
    assert!(own_servers(&home).iter().all(|s| s.changed));
    // A seal copied onto another name does not verify either; the restored original does.
    v["mcpServers"]["files"]["args"] = serde_json::json!(["-v"]);
    v["mcpServers"]["other"] = v["mcpServers"]["files"].clone();
    std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
    assert_eq!(names(codex_flags(&home, Path::new("/p"))), files_only);
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(user);
}

// Review S3: an mcp.json that cannot be read, is over the cap or is not JSON is never rewritten by Add or Remove.
#[test]
fn unreadable_own_mcp_json_is_never_rewritten() {
    use std::os::unix::fs::PermissionsExt;
    let home = tmp("home");
    let file = home.join("extensions/mcp.json");
    std::fs::create_dir_all(home.join("extensions")).unwrap();
    let big = format!(
        r#"{{"mcpServers":{{}},"pad":"{}"}}"#,
        "x".repeat(MAX_FILE as usize)
    );
    for (what, body, mode) in [
        ("bad JSON", "{not json".to_string(), 0o600),
        ("over the cap", big, 0o600),
        ("unreadable", r#"{"mcpServers":{}}"#.to_string(), 0o000),
    ] {
        std::fs::write(&file, &body).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(
            mcp_add(&home, "files", &["files-mcp".into()], None).unwrap_err(),
            "mcp.json could not be read; nothing was changed",
            "{what}"
        );
        assert_eq!(
            mcp_remove(&home, "files").unwrap_err(),
            "mcp.json could not be read; nothing was changed",
            "{what}"
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body, "{what}");
    }
    // Absent is not an error: the first Add writes it.
    std::fs::remove_file(&file).unwrap();
    mcp_add(&home, "files", &["files-mcp".into()], None).unwrap();
    let _ = std::fs::remove_dir_all(home);
}

// Review SHOULD 1: the user's Claude config often passes 1 MiB (it keeps per-project history); its servers still
// show, and one past the larger cap says so instead of reading as "no servers".
#[test]
fn large_agent_config_is_read() {
    let home = tmp("home");
    let user = tmp("user");
    let config = user.join(".claude.json");
    let body = |pad: usize| {
        format!(
            r#"{{"projects":{{"/p":{{"history":"{}"}}}},"mcpServers":{{"github":{{"command":"gh-mcp"}}}}}}"#,
            "x".repeat(pad)
        )
    };
    std::fs::write(&config, body(3 << 20)).unwrap();
    let Reply::Extensions { mcp, .. } =
        handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        mcp.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["github"]
    );
    // Past the larger cap: not read, and named with its size.
    std::fs::write(&config, body(MAX_AGENT_FILE as usize)).unwrap();
    let size = std::fs::metadata(&config).unwrap().len();
    let Reply::Extensions {
        mcp, mcp_too_large, ..
    } = handle(&home, &user, Caller::Window, Request::ExtensionsList).unwrap()
    else {
        panic!()
    };
    assert!(mcp.is_empty());
    assert_eq!(
        mcp_too_large,
        [TooLarge {
            file: "~/.claude.json".into(),
            bytes: size
        }]
    );
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(user);
}

fn own_names(home: &Path) -> Vec<String> {
    own_raw(home).unwrap().keys().cloned().collect()
}

// Review MUST 2: Add and Remove are one transaction each, whichever transport sent them.
#[test]
fn concurrent_add_and_remove_lose_nothing_and_resurrect_nothing() {
    let home = tmp("race");
    let add = |name: String| {
        let home = home.clone();
        std::thread::spawn(move || mcp_add(&home, &name, &["x-mcp".into()], None).unwrap())
    };
    for i in 0..40 {
        mcp_add(&home, "gone", &["gone-mcp".into()], None).unwrap();
        let h = home.clone();
        let remove = std::thread::spawn(move || mcp_remove(&h, "gone").unwrap());
        let (a, b) = (add(format!("a{i}")), add(format!("b{i}")));
        for t in [remove, a, b] {
            t.join().unwrap();
        }
        let names = own_names(&home);
        assert!(
            !names.contains(&"gone".to_string()),
            "round {i}: a removed server came back: {names:?}"
        );
        for n in [format!("a{i}"), format!("b{i}")] {
            assert!(names.contains(&n), "round {i}: {n} was lost: {names:?}");
        }
    }
    let _ = std::fs::remove_dir_all(home);
}

// Review SHOULD (:315): a planted `extensions` link (or `mcp.json` link) never sends a write or read elsewhere.
#[test]
fn symlinked_extensions_folder_or_mcp_json_is_refused() {
    let home = tmp("home");
    let agent = tmp("agent-home");
    std::fs::create_dir_all(agent.join("plug")).unwrap();
    std::os::unix::fs::symlink(&agent, home.join("extensions")).unwrap();
    let err = mcp_add(&home, "files", &["files-mcp".into()], None).unwrap_err();
    assert_eq!(err, LINKED);
    assert_eq!(mcp_remove(&home, "files").unwrap_err(), LINKED);
    let left: Vec<_> = std::fs::read_dir(&agent)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["plug"], "a write went into the agent home");
    // The linked folder's subfolders are not items, so no launch gets `--plugin-dir` into it.
    assert_eq!(items(&home).len(), 1);
    assert!(claude_flags(&home, &[format!("{CUSTOM}plug")], Path::new("/p")).is_empty());

    // A real folder with `mcp.json` linked to a file elsewhere: refused, the target untouched.
    std::fs::remove_file(home.join("extensions")).unwrap();
    std::fs::create_dir(home.join("extensions")).unwrap();
    let target = agent.join("config.json");
    std::fs::write(&target, r#"{"mcpServers":{}}"#).unwrap();
    std::os::unix::fs::symlink(&target, home.join("extensions/mcp.json")).unwrap();
    assert_eq!(
        mcp_add(&home, "files", &["files-mcp".into()], None).unwrap_err(),
        LINKED
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        r#"{"mcpServers":{}}"#
    );
    assert!(
        home.join("extensions/mcp.json")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(agent);
}

// Review SHOULD (:132): a FIFO in place of `mcp.json`, even one swapped in between a check and the open, never
// blocks a list, a launch or an Add.
#[test]
fn fifo_in_place_of_mcp_json_never_hangs() {
    use std::time::{Duration, Instant};
    let home = tmp("fifo");
    let file = home.join("extensions/mcp.json");
    std::fs::create_dir_all(home.join("extensions")).unwrap();
    let fifo = |p: &Path| {
        let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    };
    fifo(&file);
    let (tx, rx) = std::sync::mpsc::channel();
    let h = home.clone();
    std::thread::spawn(move || {
        let add = mcp_add(&h, "files", &["files-mcp".into()], None);
        let list = handle(&h, &h, Caller::Window, Request::ExtensionsList).map(|_| ());
        let flags = (
            claude_flags(&h, &enabled(None), Path::new("/p")),
            codex_flags(&h, Path::new("/p")),
        );
        tx.send((add, list, flags)).unwrap();
    });
    let (add, list, flags) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a FIFO mcp.json blocked");
    assert_eq!(add.unwrap_err(), UNREAD);
    assert!(list.is_ok());
    assert!(flags.0.is_empty() && flags.1.is_empty());

    // Swapped between a regular file and a FIFO while being read: every read still returns.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (s, f) = (stop.clone(), file.clone());
    let swapper = std::thread::spawn(move || {
        while !s.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = std::fs::remove_file(&f);
            let _ = std::fs::write(&f, r#"{"mcpServers":{}}"#);
            let _ = std::fs::remove_file(&f);
            fifo(&f);
        }
    });
    let (tx, rx) = std::sync::mpsc::channel();
    let h = home.clone();
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            let _ = own_raw(&h);
        }
        tx.send(()).unwrap();
    });
    let hung = rx.recv_timeout(Duration::from_secs(10)).is_err();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(!hung, "a FIFO swapped in after the check blocked the open");
    swapper.join().unwrap();
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn extension_ops_refused_from_agent_remote_and_widget() {
    let home = tmp("home");
    let user = tmp("user");
    for caller in [Caller::Agent, Caller::Remote, Caller::Widget] {
        for request in [
            Request::ExtensionsList,
            Request::ExtensionsMcpAdd {
                name: "evil".into(),
                command: vec!["sh".into()],
                project: None,
            },
            Request::ExtensionsMcpRemove {
                name: "evil".into(),
            },
            Request::ExtensionsItemFiles {
                id: DEFAULT_ID.into(),
            },
            Request::ExtensionsItemRead {
                id: DEFAULT_ID.into(),
                path: "skills/nunchiro/SKILL.md".into(),
            },
            Request::ExtensionsItemSave {
                id: "custom:evil".into(),
                path: "SKILL.md".into(),
                text: "x".into(),
                base: None,
            },
            Request::ExtensionsSkillNew {
                name: "evil".into(),
                description: "x".into(),
                hook: false,
            },
        ] {
            let op = format!("{request:?}");
            assert_eq!(
                handle(&home, &user, caller, request).unwrap_err(),
                "operation not granted",
                "{caller:?} {op}"
            );
        }
    }
    assert!(
        !home.join("extensions").exists(),
        "a refused add, save or new skill wrote a file"
    );
    // The browser-role allowlist and the agent check refuse the ops too (tables in http/browser_tests.rs).
    for op in [
        r#"{"op":"extensions_list"}"#,
        r#"{"op":"extensions_mcp_add","name":"x","command":["x"]}"#,
        r#"{"op":"extensions_mcp_remove","name":"x"}"#,
        r#"{"op":"extensions_item_files","id":"nunchiro"}"#,
        r#"{"op":"extensions_item_read","id":"nunchiro","path":"x"}"#,
        r#"{"op":"extensions_item_save","id":"custom:x","path":"x","text":"x"}"#,
        r#"{"op":"extensions_skill_new","name":"x","description":"x"}"#,
        r#"{"op":"extensions_skill_new","name":"x","description":"x","hook":true}"#,
    ] {
        let frame = format!(r#"{{"id":1,"request":{op}}}"#);
        assert!(crate::http::browser::allowed(&frame).is_err(), "{frame}");
    }
    // Remote: the ops sit in server.rs's local owner-only list, so they are never forwarded to another machine.
    // The agent half (`check_agent`) is `sessions::tests::extension_ops_refused_to_session_callers`.
    let server = include_str!("../server.rs");
    let local = &server[..server
        .find("operation is local owner-only; remote forwarding is not permitted")
        .unwrap()];
    for op in [
        "Request::ExtensionsList",
        "Request::ExtensionsMcpAdd",
        "Request::ExtensionsMcpRemove",
        "Request::ExtensionsItemFiles",
        "Request::ExtensionsItemRead",
        "Request::ExtensionsItemSave",
        "Request::ExtensionsSkillNew",
        "Request::ExtensionsItemRemove",
    ] {
        assert!(
            local.contains(op),
            "{op} is not in the local owner-only list"
        );
    }
    // Widget: the web widget bridge serves read data only; no extensions op is reachable from it.
    assert!(!include_str!("../widgets/web.rs").contains("Extensions"));
}

// Ticket 452
fn window(home: &Path, request: Request) -> Result<Reply, String> {
    handle(home, home, Caller::Window, request)
}
fn read(home: &Path, id: &str, path: &str) -> Result<String, String> {
    match window(
        home,
        Request::ExtensionsItemRead {
            id: id.into(),
            path: path.into(),
        },
    )? {
        Reply::ExtensionsFile { text, .. } => Ok(text),
        _ => panic!("wrong reply"),
    }
}
fn save(home: &Path, path: &str, text: &str) -> Result<Reply, String> {
    window(
        home,
        Request::ExtensionsItemSave {
            id: "custom:mine".into(),
            path: path.into(),
            text: text.into(),
            base: None,
        },
    )
}
fn listed(home: &Path, id: &str) -> (Vec<String>, bool, bool) {
    match window(home, Request::ExtensionsItemFiles { id: id.into() }).unwrap() {
        Reply::ExtensionsFiles {
            files,
            more,
            editable,
            ..
        } => (files.into_iter().map(|f| f.path).collect(), more, editable),
        _ => panic!("wrong reply"),
    }
}
fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn items_say_what_they_hold() {
    let home = tmp("summary");
    let mine = home.join("extensions/mine");
    write(
        &mine.join("skills/zeta/SKILL.md"),
        "---\nname: zeta\ndescription: \"Zeta: second.\"\n---\nbody\n",
    );
    write(
        &mine.join("skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: Alpha does the first thing.\n---\nbody\n",
    );
    std::fs::create_dir_all(mine.join("skills/empty")).unwrap();
    write(
        &mine.join("hooks/hooks.json"),
        r#"{"hooks":{"PreToolUse":[],"Stop":[]}}"#,
    );
    write(&mine.join("hooks/run.sh"), "echo hi\n");
    let all = items(&home);
    let mine = all.iter().find(|i| i.id == "custom:mine").unwrap();
    // No plugin.json: the first skill's frontmatter gives the description.
    assert_eq!(mine.description, "Alpha does the first thing.");
    assert_eq!(mine.skills, ["alpha", "zeta"]);
    assert_eq!(mine.hooks, ["PreToolUse", "Stop"]);
    assert_eq!(mine.files, 4);
    // plugin.json wins, clipped to 300 characters.
    write(
        &home.join("extensions/mine/.claude-plugin/plugin.json"),
        &format!(r#"{{"name":"mine","description":"{}"}}"#, "é".repeat(400)),
    );
    let mine = items(&home).remove(1);
    assert_eq!(mine.description, "é".repeat(300));
    assert_eq!(mine.files, 5);
    // The shipped skill: from the embedded files, not from disk.
    let shipped = &all[0];
    assert_eq!(shipped.id, DEFAULT_ID);
    assert!(shipped.description.starts_with("How to start, prompt"));
    assert_eq!(shipped.skills, ["artifacts", "nunchiro", "orchestration"]);
    assert!(shipped.hooks.is_empty());
    assert_eq!(shipped.files, 4);
    // An old reader's shape still parses, and empty fields are left out.
    let old: Item =
        serde_json::from_str(r#"{"id":"custom:x","name":"x","kind":"plugin","source":"custom"}"#)
            .unwrap();
    assert_eq!(
        serde_json::to_string(&old).unwrap(),
        r#"{"id":"custom:x","name":"x","kind":"plugin","source":"custom"}"#
    );
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn files_are_listed_bounded_and_links_never_followed() {
    let home = tmp("list");
    let outside = tmp("outside");
    write(&outside.join("secret.txt"), "secret");
    let mine = home.join("extensions/mine");
    write(&mine.join("b.md"), "b");
    write(&mine.join("a/b/c/d/e/f.md"), "six names");
    write(&mine.join("a/b/c/d/e/g/h.md"), "seven names");
    std::os::unix::fs::symlink(outside.join("secret.txt"), mine.join("file-link")).unwrap();
    std::os::unix::fs::symlink(&outside, mine.join("folder-link")).unwrap();
    let (files, more, editable) = listed(&home, "custom:mine");
    assert_eq!(files, ["a/b/c/d/e/f.md", "b.md"]);
    assert!(more, "the seventh level was cut");
    assert!(editable);
    let Reply::ExtensionsFiles { files, .. } = window(
        &home,
        Request::ExtensionsItemFiles {
            id: "custom:mine".into(),
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(files[1].bytes, 1);
    // At most 200 files.
    for i in 0..205 {
        write(&mine.join(format!("many/{i:03}.md")), "x");
    }
    let (files, more, _) = listed(&home, "custom:mine");
    assert_eq!(files.len(), MAX_LIST);
    assert!(more);
    // The shipped skill: the embedded files, read-only.
    let (files, more, editable) = listed(&home, DEFAULT_ID);
    assert_eq!(
        files,
        [
            ".claude-plugin/plugin.json",
            "skills/artifacts/SKILL.md",
            "skills/nunchiro/SKILL.md",
            "skills/orchestration/SKILL.md"
        ]
    );
    assert!(!more && !editable);
    assert!(
        window(
            &home,
            Request::ExtensionsItemFiles {
                id: "custom:../x".into()
            }
        )
        .is_err()
    );
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn reads_are_refused_outside_the_item_through_links_and_past_the_caps() {
    let home = tmp("read");
    let outside = tmp("outside");
    write(&outside.join("secret.txt"), "secret");
    let mine = home.join("extensions/mine");
    write(&mine.join("skills/s/SKILL.md"), "hello");
    write(&home.join("extensions/other/x.md"), "other item");
    assert_eq!(
        read(&home, "custom:mine", "skills/s/SKILL.md").unwrap(),
        "hello"
    );
    let Reply::ExtensionsFile { editable, .. } = window(
        &home,
        Request::ExtensionsItemRead {
            id: DEFAULT_ID.into(),
            path: "skills/nunchiro/SKILL.md".into(),
        },
    )
    .unwrap() else {
        panic!()
    };
    assert!(!editable);
    for bad in [
        "../other/x.md",
        "skills/../../other/x.md",
        "./x",
        "/etc/passwd",
        "a//b",
        "",
        "a\u{1}b",
    ] {
        assert!(
            read(&home, "custom:mine", bad)
                .unwrap_err()
                .starts_with("path:"),
            "{bad}"
        );
    }
    assert!(read(&home, "custom:mine", &["a"; 7].join("/")).is_err());
    assert!(read(&home, "custom:mine", &"a".repeat(101)).is_err());
    std::os::unix::fs::symlink(&outside, mine.join("mid")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), mine.join("last")).unwrap();
    for linked in ["mid/secret.txt", "last"] {
        let err = read(&home, "custom:mine", linked).unwrap_err();
        assert!(err.contains("link"), "{linked}: {err}");
    }
    // The item itself a link: refused too.
    std::os::unix::fs::symlink(&outside, home.join("extensions/linked")).unwrap();
    assert!(read(&home, "custom:linked", "secret.txt").is_err());
    write(&mine.join("big.md"), &"x".repeat(MAX_TEXT as usize + 1));
    assert!(
        read(&home, "custom:mine", "big.md")
            .unwrap_err()
            .contains("256 KiB")
    );
    std::fs::write(mine.join("bin"), [0xff, 0xfe, 0]).unwrap();
    assert!(
        read(&home, "custom:mine", "bin")
            .unwrap_err()
            .contains("UTF-8")
    );
    assert!(
        read(&home, "custom:mine", "skills")
            .unwrap_err()
            .contains("regular file")
    );
    assert!(
        read(&home, "custom:mine", "gone.md")
            .unwrap_err()
            .contains("not found")
    );
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn saves_replace_in_place_and_never_go_through_a_link() {
    use std::os::unix::fs::PermissionsExt;
    let home = tmp("save");
    let outside = tmp("outside");
    let mine = home.join("extensions/mine");
    write(&mine.join("hooks/run.sh"), "old\n");
    std::fs::set_permissions(
        mine.join("hooks/run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    // Replaces, keeps the mode, and the reply is the file read back.
    let Reply::ExtensionsFile {
        text,
        editable,
        path,
        ..
    } = save(&home, "hooks/run.sh", "new\n").unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (text.as_str(), editable, path.as_str()),
        ("new\n", true, "hooks/run.sh")
    );
    assert_eq!(
        std::fs::metadata(mine.join("hooks/run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    // Q9 en-b-J13-4: with the text it opened, a save over a file changed on disk since, or now unreadable, is refused.
    let based = |base: &str| {
        window(
            &home,
            Request::ExtensionsItemSave {
                id: "custom:mine".into(),
                path: "hooks/run.sh".into(),
                text: "mine\n".into(),
                base: Some(base.into()),
            },
        )
    };
    write(&mine.join("hooks/run.sh"), "theirs\n");
    assert_eq!(
        based("new\n").unwrap_err(),
        "the file changed on disk since it was opened; nothing was saved"
    );
    std::fs::write(mine.join("hooks/run.sh"), [0xff, 0xfe]).unwrap();
    assert!(based("").is_err());
    write(&mine.join("hooks/run.sh"), "theirs\n");
    based("theirs\n").unwrap();
    assert_eq!(
        read(&home, "custom:mine", "hooks/run.sh").unwrap(),
        "mine\n"
    );
    // Writes a new file and makes the folders on the way.
    save(&home, "skills/fresh/SKILL.md", "fresh").unwrap();
    assert_eq!(
        std::fs::read_to_string(mine.join("skills/fresh/SKILL.md")).unwrap(),
        "fresh"
    );
    // No temporary file is left anywhere.
    let (files, _, _) = listed(&home, "custom:mine");
    assert_eq!(files, ["hooks/run.sh", "skills/fresh/SKILL.md"]);
    let hidden = std::fs::read_dir(mine.join("hooks"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.')
        })
        .count();
    assert_eq!(hidden, 0);
    // The shipped skill is never written.
    assert_eq!(
        window(
            &home,
            Request::ExtensionsItemSave {
                id: DEFAULT_ID.into(),
                path: "skills/nunchiro/SKILL.md".into(),
                text: "x".into(),
                base: None,
            },
        )
        .unwrap_err(),
        SHIPPED
    );
    // Through a link (in the middle or as the file): refused, nothing written outside.
    write(&outside.join("target.md"), "untouched");
    std::os::unix::fs::symlink(&outside, mine.join("mid")).unwrap();
    std::os::unix::fs::symlink(outside.join("target.md"), mine.join("last.md")).unwrap();
    assert!(save(&home, "mid/new.md", "x").unwrap_err().contains("link"));
    assert!(
        save(&home, "mid/target.md", "x")
            .unwrap_err()
            .contains("link")
    );
    assert!(save(&home, "last.md", "x").unwrap_err().contains("link"));
    assert!(save(&home, "../other.md", "x").is_err());
    assert_eq!(
        std::fs::read_to_string(outside.join("target.md")).unwrap(),
        "untouched"
    );
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
    assert!(!home.join("extensions/other.md").exists());
    // A folder as the target, too large, or a missing item: refused.
    assert!(save(&home, "skills", "x").unwrap_err().contains("folder"));
    assert!(save(&home, "big.md", &"x".repeat(MAX_TEXT as usize + 1)).is_err());
    assert!(!mine.join("big.md").exists());
    std::fs::remove_dir_all(&mine).unwrap();
    assert!(save(&home, "a.md", "x").is_err());
    assert!(!mine.exists(), "a save never makes the item itself");
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn new_skill_is_made_listed_and_left_off() {
    let home = tmp("new");
    let new = |name: &str, description: &str| {
        window(
            &home,
            Request::ExtensionsSkillNew {
                name: name.into(),
                description: description.into(),
                hook: false,
            },
        )
    };
    let Reply::Extensions { items, .. } = new("review", "Checks a \"diff\" before merge.").unwrap()
    else {
        panic!()
    };
    let item = items.iter().find(|i| i.id == "custom:review").unwrap();
    assert_eq!(item.skills, ["review"]);
    // Ticket 580: what New skill makes reads as a skill, not a plugin.
    assert_eq!(item.kind, "skill");
    assert_eq!(item.description, "Checks a \"diff\" before merge.");
    assert_eq!(item.files, 2);
    let skill = read(&home, "custom:review", "skills/review/SKILL.md").unwrap();
    assert!(
        skill.starts_with(
            "---\nname: review\ndescription: \"Checks a \\\"diff\\\" before merge.\"\n---\n"
        ),
        "{skill}"
    );
    assert_eq!(skill.lines().skip(5).count(), 3, "{skill}");
    let manifest: serde_json::Value =
        serde_json::from_str(&read(&home, "custom:review", ".claude-plugin/plugin.json").unwrap())
            .unwrap();
    assert_eq!(manifest["name"], "review");
    // Off: no launch flag for it with the default enabled list.
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    // An existing name in any form, a bad name or a bad description: refused.
    assert!(
        new("review", "again")
            .unwrap_err()
            .contains("already exists")
    );
    std::os::unix::fs::symlink("/nowhere", home.join("extensions/dangling")).unwrap();
    assert!(new("dangling", "x").unwrap_err().contains("already exists"));
    std::fs::write(home.join("extensions/plain"), "").unwrap();
    assert!(new("plain", "x").unwrap_err().contains("already exists"));
    for bad in ["../x", "a b", "", "a.b"] {
        assert!(new(bad, "x").is_err(), "{bad}");
    }
    for bad in ["", "two\nlines", &"x".repeat(301)] {
        assert!(new("ok", bad).is_err(), "{bad:?}");
    }
    assert!(!home.join("extensions/ok").exists());
    let _ = std::fs::remove_dir_all(home);
}

/// Ticket 991 C11: Remove moves a custom item's folder under `.removed/` (its files kept), and the list drops it; the
/// shipped skill, a missing item and a linked item are refused.
#[test]
fn remove_moves_a_custom_item_aside_and_keeps_its_files() {
    let home = tmp("remove");
    let ask = |request| window(&home, request);
    ask(Request::ExtensionsSkillNew {
        name: "review".into(),
        description: "x".into(),
        hook: false,
    })
    .unwrap();
    let remove = |id: &str| ask(Request::ExtensionsItemRemove { id: id.into() });
    let Reply::Extensions { items, .. } = remove("custom:review").unwrap() else {
        panic!()
    };
    assert!(items.iter().all(|i| i.id != "custom:review"));
    let kept: Vec<_> = std::fs::read_dir(home.join("extensions/.removed"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].starts_with("review-"));
    let moved = home.join("extensions/.removed").join(&kept[0]);
    assert!(moved.join("skills/review/SKILL.md").is_file());
    assert_eq!(remove("nunchiro").unwrap_err(), SHIPPED);
    assert!(
        remove("custom:review")
            .unwrap_err()
            .contains("no extension")
    );
    assert!(remove("custom:../x").is_err());
    std::os::unix::fs::symlink(&moved, home.join("extensions/linked")).unwrap();
    assert!(remove("custom:linked").is_err());
    assert!(
        home.join("extensions/linked").is_symlink(),
        "a link is not moved"
    );
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn new_hook_is_made_listed_with_its_command_and_left_off() {
    let home = tmp("newhook");
    let Reply::Extensions { items, .. } = window(
        &home,
        Request::ExtensionsSkillNew {
            name: "log-stop".into(),
            description: "Prints a line when a turn ends.".into(),
            hook: true,
        },
    )
    .unwrap() else {
        panic!()
    };
    let item = items.iter().find(|i| i.id == "custom:log-stop").unwrap();
    assert_eq!(item.kind, "hook");
    assert_eq!(item.description, "Prints a line when a turn ends.");
    assert_eq!(item.hooks, ["Stop"]);
    assert_eq!(item.hook_lines.len(), 1);
    assert_eq!(item.hook_lines[0].event, "Stop");
    assert!(item.skills.is_empty());
    assert_eq!(item.files, 2);
    assert!(claude_flags(&home, &enabled(None), Path::new("/p")).is_empty());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn a_control_character_in_a_hook_command_is_shown_as_a_mark() {
    // A terminal escape that would erase the line: the owner must see that something is there.
    let v = serde_json::json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "rm -rf ~ #\u{1b}[2K\r./done.sh"}]}]}});
    let lines = hook_lines(&v);
    assert_eq!(lines.len(), 1);
    assert!(
        !lines[0].command.chars().any(char::is_control),
        "{:?}",
        lines[0].command
    );
    assert!(
        lines[0]
            .command
            .starts_with("rm -rf ~ #\u{FFFD}[2K\u{FFFD}./done.sh")
    );
    assert_eq!(clip("a\u{7}b".into()), "a\u{FFFD}b");
}

#[test]
fn hook_lines_show_each_command_bounded() {
    let home = tmp("hooklines");
    let hooks = home.join("extensions/guard/hooks/hooks.json");
    write(
        &hooks,
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./check.sh"},{"type":"command","command":"./log.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"./done.sh"}]}]}}"#,
    );
    let line = |event: &str, matcher: &str, command: &str| HookLine {
        event: event.into(),
        matcher: matcher.into(),
        command: command.into(),
    };
    let lines = || items(&home).remove(1).hook_lines;
    assert_eq!(
        lines(),
        [
            line("PreToolUse", "Bash", "./check.sh"),
            line("PreToolUse", "Bash", "./log.sh"),
            line("Stop", "", "./done.sh"),
        ]
    );
    let many: Vec<serde_json::Value> = (0..33)
        .map(|n| serde_json::json!({"type":"command","command":format!("c{n}")}))
        .collect();
    let long = "x".repeat(400);
    let body = serde_json::json!({"hooks":{
        "A": [{"matcher": "m".repeat(70), "hooks": [{"type":"command","command": long}]}],
        "B": [{"hooks": many}],
    }});
    write(&hooks, &body.to_string());
    let got = lines();
    assert_eq!(got.len(), 32);
    assert_eq!(got[0].command, "x".repeat(300));
    assert_eq!(got[0].matcher, "m".repeat(64));
    assert_eq!(got[31].command, "c30");
    write(&hooks, "not json {");
    assert!(lines().is_empty());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn claude_flags_never_open_an_item_file() {
    let home = tmp("flagsfifo");
    let item = home.join("extensions/held/hooks");
    std::fs::create_dir_all(&item).unwrap();
    let fifo = c(item.join("hooks.json").as_os_str()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let flags = claude_flags(&home, &["custom:held".into()], Path::new("/p"));
    assert_eq!(
        flags,
        [
            OsString::from("--plugin-dir"),
            home.join("extensions/held").into_os_string()
        ]
    );
    let _ = std::fs::remove_dir_all(home);
}

fn strings(flags: Vec<OsString>) -> Vec<String> {
    flags
        .into_iter()
        .map(|o| o.into_string().unwrap())
        .collect()
}
/// The server names one Claude launch in `project` gets (from its inline `--mcp-config`).
fn claude_names(home: &Path, project: &str) -> Vec<String> {
    let flags = strings(claude_flags(home, &enabled(None), Path::new(project)));
    let Some(inline) = flags.iter().find_map(|f| f.strip_prefix("--mcp-config=")) else {
        return vec![];
    };
    let v: serde_json::Value = serde_json::from_str(inline).unwrap();
    v["mcpServers"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}
/// The server names one Codex launch in `project` gets.
fn codex_names(home: &Path, project: &str) -> Vec<String> {
    strings(codex_flags(home, Path::new(project)))
        .iter()
        .filter_map(|f| f.strip_prefix("mcp_servers.")?.split_once(".command="))
        .map(|(name, _)| name.to_string())
        .collect()
}

// A server added for one project reaches that project's sessions only, Claude and Codex alike; listed with its project;
// removed like any other.
#[test]
fn mcp_for_one_project_reaches_only_that_projects_sessions() {
    let home = tmp("home");
    let user = tmp("user");
    let add = |name: &str, project: Option<&str>| {
        handle(
            &home,
            &user,
            Caller::Window,
            Request::ExtensionsMcpAdd {
                name: name.into(),
                command: vec![format!("{name}-mcp")],
                project: project.map(PathBuf::from),
            },
        )
    };
    add("all", None).unwrap();
    let Reply::Extensions { own, .. } = add("mine", Some("/work/a")).unwrap() else {
        panic!()
    };
    let mut listed: Vec<(String, Option<String>)> =
        own.into_iter().map(|s| (s.name, s.project)).collect();
    listed.sort();
    assert_eq!(
        listed,
        [
            ("all".to_string(), None),
            ("mine".to_string(), Some("/work/a".to_string()))
        ]
    );
    assert_eq!(claude_names(&home, "/work/a"), ["all", "mine"]);
    assert_eq!(codex_names(&home, "/work/a"), ["all", "mine"]);
    assert_eq!(claude_names(&home, "/work/b"), ["all"]);
    assert_eq!(codex_names(&home, "/work/b"), ["all"]);
    // A folder inside the project or one that only starts with its name is another project.
    assert_eq!(claude_names(&home, "/work/ab"), ["all"]);
    // The same name for all projects and for one project, either way round, is refused with one plain line.
    let both = add("all", Some("/work/a")).unwrap_err();
    assert_eq!(
        both,
        "a server named all is already added for all projects; remove it first or pick another name"
    );
    let both = add("mine", None).unwrap_err();
    assert_eq!(
        both,
        "a server named mine is already added for /work/a; remove it first or pick another name"
    );
    assert!(add("mine", Some("/work/b")).is_err());
    assert!(!both.contains('\n'));
    // Added again for the same project: replaced, as a global one is.
    add("mine", Some("/work/a")).unwrap();
    // A project must be a full path.
    assert!(add("rel", Some("work/a")).is_err());
    // Remove takes it out of that project's next launch.
    handle(
        &home,
        &user,
        Caller::Window,
        Request::ExtensionsMcpRemove {
            name: "mine".into(),
        },
    )
    .unwrap();
    assert_eq!(claude_names(&home, "/work/a"), ["all"]);
    assert_eq!(codex_names(&home, "/work/a"), ["all"]);
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(user);
}

// The seal covers the project: an entry whose project was edited by hand (moved, added, dropped) is never started.
#[test]
fn an_own_server_whose_project_was_edited_is_not_started() {
    let home = tmp("home");
    let file = home.join("extensions/mcp.json");
    mcp_add(
        &home,
        "mine",
        &["mine-mcp".into()],
        Some(Path::new("/work/a")),
    )
    .unwrap();
    mcp_add(&home, "all", &["all-mcp".into()], None).unwrap();
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let edits: [(&str, serde_json::Value); 4] = [
        ("mine", serde_json::json!("/work/b")), // moved to another project
        ("mine", serde_json::Value::Null),      // made "all projects" by a null
        ("all", serde_json::json!("/work/a")),  // a global one pinned to a project
        ("mine", serde_json::json!(7)),         // not a path
    ];
    for (name, project) in edits {
        let mut v = original.clone();
        v["mcpServers"][name]["project"] = project.clone();
        std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
        for p in ["/work/a", "/work/b"] {
            assert!(
                !claude_names(&home, p).contains(&name.to_string())
                    && !codex_names(&home, p).contains(&name.to_string()),
                "{name} with project {project} started in {p}"
            );
        }
        assert!(
            own_servers(&home)
                .iter()
                .any(|s| s.name == name && s.changed)
        );
    }
    // The project key taken away: the entry reads as global, and its seal (made with the project) fails.
    let mut v = original.clone();
    v["mcpServers"]["mine"]
        .as_object_mut()
        .unwrap()
        .remove("project");
    std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();
    assert_eq!(claude_names(&home, "/work/a"), ["all"]);
    assert_eq!(codex_names(&home, "/work/b"), ["all"]);
    let _ = std::fs::remove_dir_all(home);
}

/// The seal today's released build checks (before servers had a project), kept here word for word so the new file is
/// checked against it.
fn older_build_seal(key: &[u8], name: &str, command: &str, args: &[String]) -> String {
    let msg = serde_json::to_vec(&("extensions.mcp", name, command, args)).unwrap_or_default();
    crate::schedule::hmac(key, &msg)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// Backward reading both ways: a file of three global servers in the older format reads and starts the same, Add writes
// a global entry in exactly that format, and the older build's seal check passes every global entry of a file the new
// build wrote while it fails (so never starts) the one-project entry.
#[test]
fn global_servers_keep_the_older_format_both_ways() {
    let home = tmp("home");
    let file = home.join("extensions/mcp.json");
    let key = crate::schedule::key(&home.join(KEY_FILE)).unwrap();
    let older = |names: &[&str]| -> serde_json::Value {
        let servers: serde_json::Map<String, serde_json::Value> = names
            .iter()
            .map(|n| {
                let command = format!("{n}-mcp");
                let args = vec!["--stdio".to_string()];
                let seal = older_build_seal(&key, n, &command, &args);
                (
                    n.to_string(),
                    serde_json::json!({ "command": command, "args": args, "seal": seal }),
                )
            })
            .collect();
        serde_json::json!({ "mcpServers": servers })
    };
    std::fs::create_dir_all(home.join("extensions")).unwrap();
    std::fs::write(
        &file,
        serde_json::to_vec_pretty(&older(&["a", "b", "c"])).unwrap(),
    )
    .unwrap();
    for p in ["/work/a", "/anything"] {
        assert_eq!(claude_names(&home, p), ["a", "b", "c"]);
        assert_eq!(codex_names(&home, p), ["a", "b", "c"]);
    }
    assert!(
        own_servers(&home)
            .iter()
            .all(|s| !s.changed && s.project.is_none())
    );
    // Written again by Add (global): byte for byte what the older build writes.
    std::fs::remove_file(&file).unwrap();
    for n in ["a", "b", "c"] {
        mcp_add(&home, n, &[format!("{n}-mcp"), "--stdio".into()], None).unwrap();
    }
    assert_eq!(
        std::fs::read(&file).unwrap(),
        serde_json::to_vec_pretty(&older(&["a", "b", "c"])).unwrap()
    );
    // A one-project entry beside them: the older build's check passes a, b, c and fails it, so it never starts there.
    mcp_add(
        &home,
        "mine",
        &["mine-mcp".into()],
        Some(Path::new("/work/a")),
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let older_starts: Vec<&String> = v["mcpServers"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, e)| {
            let args: Vec<String> = serde_json::from_value(e["args"].clone()).unwrap();
            e["seal"] == older_build_seal(&key, name, e["command"].as_str().unwrap(), &args)
        })
        .map(|(name, _)| name)
        .collect();
    assert_eq!(older_starts, ["a", "b", "c"]);
    let _ = std::fs::remove_dir_all(home);
}

// A project named through a link is stored as the folder it points to, the path a session of that project carries.
#[test]
fn a_project_given_through_a_link_is_stored_as_its_real_folder() {
    let home = tmp("home");
    let real = tmp("real").canonicalize().unwrap();
    let link = tmp("links").join("proj");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    mcp_add(&home, "mine", &["mine-mcp".into()], Some(&link)).unwrap();
    let listed = own_servers(&home);
    assert_eq!(listed[0].project.as_deref(), real.to_str());
    assert!(!listed[0].changed);
    assert_eq!(claude_names(&home, real.to_str().unwrap()), ["mine"]);
    assert_eq!(codex_names(&home, real.to_str().unwrap()), ["mine"]);
    // A folder that is not there is kept as given (no session can be in it).
    mcp_add(
        &home,
        "gone",
        &["gone-mcp".into()],
        Some(Path::new("/no/such/folder")),
    )
    .unwrap();
    assert!(
        own_servers(&home)
            .iter()
            .any(|s| s.project.as_deref() == Some("/no/such/folder"))
    );
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(real);
}
