//! Ticket 98: the composer `/` menu's user-level commands and skills, read from `~/.claude` and `~/.codex/prompts`.
//! The op is read only: these tests run `user_commands::list` on fixture homes and check rows, caps and that the tree
//! is untouched.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::AgentKind,
    user_commands::{Row, list},
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

fn put(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn names(rows: &[Row]) -> Vec<String> {
    rows.iter().map(|r| r.name.clone()).collect()
}

/// The shared fixture: HOME with one command with front matter, a namespaced one without, a skill and a Codex prompt.
fn fixture(tag: &str) -> PathBuf {
    let h = home::short(tag);
    put(
        &h,
        ".claude/commands/a.md",
        "---\ndescription: Ship it\nallowed-tools: Bash\n---\nbody line\n",
    );
    put(
        &h,
        ".claude/commands/ns/b.md",
        "\n\nFirst real line\nsecond\n",
    );
    put(
        &h,
        ".claude/skills/s/SKILL.md",
        "---\nname: s\ndescription: \"Quoted skill\"\n---\n# S\n",
    );
    put(&h, ".codex/prompts/p.md", "Prompt text here\n");
    h
}

fn done(h: &Path) {
    let _ = fs::remove_dir_all(h);
}

#[test]
fn lists_user_commands_and_skills() {
    let h = fixture("ucl");
    let rows = list(&h, AgentKind::Claude);
    let got: Vec<(&str, &str, &str)> = rows
        .iter()
        .map(|r| (r.name.as_str(), r.description.as_str(), r.source.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("a", "Ship it", "command"),
            ("ns:b", "First real line", "command"),
            ("s", "Quoted skill", "skill"),
        ]
    );
    let codex = list(&h, AgentKind::Codex);
    assert_eq!(names(&codex), ["p"]);
    assert_eq!(codex[0].description, "Prompt text here");
    assert_eq!(codex[0].source.as_str(), "prompt");
    assert!(list(&h, AgentKind::Shell).is_empty());
    assert!(list(&h, AgentKind::Acp).is_empty());
    done(&h);
}

#[test]
fn description_is_cut_to_120_characters() {
    let h = home::short("ucd");
    put(
        &h,
        ".claude/commands/long.md",
        &format!("{}\n", "é".repeat(500)),
    );
    let rows = list(&h, AgentKind::Claude);
    assert_eq!(rows[0].description.chars().count(), 120);
    done(&h);
}

/// (path, bytes if a file, mtime with nanoseconds) of every entry, sorted.
fn snapshot(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>, SystemTime)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, Option<Vec<u8>>, SystemTime)>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.path());
        for e in entries {
            let meta = fs::symlink_metadata(e.path()).unwrap();
            let bytes = meta.is_file().then(|| fs::read(e.path()).unwrap());
            out.push((e.path(), bytes, meta.modified().unwrap()));
            if meta.is_dir() {
                walk(&e.path(), out);
            }
        }
    }
    let mut out = vec![(
        root.to_path_buf(),
        None,
        fs::symlink_metadata(root).unwrap().modified().unwrap(),
    )];
    walk(root, &mut out);
    out
}

#[test]
fn never_writes_agent_config() {
    let h = fixture("ucw");
    let before = snapshot(&h);
    for kind in [AgentKind::Claude, AgentKind::Codex, AgentKind::Shell] {
        list(&h, kind);
    }
    assert_eq!(before, snapshot(&h));
    // The module has no call that could write, create, rename, remove or chmod.
    let src = include_str!("../src/user_commands.rs");
    let code = src.split("\n#[cfg(test)]").next().unwrap();
    let code: String = code
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for banned in [
        "create",
        "write",
        "rename",
        "remove",
        "set_permissions",
        "OpenOptions::new().write",
    ] {
        assert!(
            !code.contains(banned),
            "user_commands.rs contains `{banned}`"
        );
    }
    // Ticket 371 round 2: the one call that follows links, only to confirm a plugin root stays in the plugin folder.
    assert_eq!(code.matches("canonicalize").count(), 1);
    done(&h);
}

#[test]
fn symlink_out_of_dir_not_followed() {
    let h = fixture("ucs");
    let outside = home::short("ucs-out");
    put(&outside, "evil.md", "Outside file\n");
    put(&outside, "dir/deep.md", "Outside deep\n");
    put(&outside, "skilldir/SKILL.md", "Outside skill\n");
    symlink(outside.join("evil.md"), h.join(".claude/commands/link.md")).unwrap();
    symlink(outside.join("dir"), h.join(".claude/commands/linkdir")).unwrap();
    symlink(outside.join("skilldir"), h.join(".claude/skills/linkskill")).unwrap();
    // A skill dir whose SKILL.md is a link out.
    fs::create_dir_all(h.join(".claude/skills/t")).unwrap();
    symlink(outside.join("evil.md"), h.join(".claude/skills/t/SKILL.md")).unwrap();
    symlink(outside.join("evil.md"), h.join(".codex/prompts/lp.md")).unwrap();
    let before = names(&list(&h, AgentKind::Claude));
    assert_eq!(before, ["a", "ns:b", "s"]);
    assert_eq!(names(&list(&h, AgentKind::Codex)), ["p"]);

    // The targets are unreadable: a follower would fail to open them, a core that only skips never tries; the other
    // rows come back either way.
    fs::set_permissions(outside.join("evil.md"), fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(outside.join("dir"), fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(names(&list(&h, AgentKind::Claude)), ["a", "ns:b", "s"]);
    fs::set_permissions(outside.join("dir"), fs::Permissions::from_mode(0o755)).unwrap();
    done(&h);
    done(&outside);
}

#[test]
fn caps_hold() {
    let h = home::short("ucc");
    // 4 folders x 100 files: 400 files, none over the 200-per-folder cap, so only the 300-row cap bites.
    for d in 0..4 {
        for f in 0..100 {
            put(&h, &format!(".claude/commands/d{d}/c{f:03}.md"), "x\n");
        }
    }
    assert_eq!(list(&h, AgentKind::Claude).len(), 300);

    // A 1 MiB file is skipped, a small neighbour is not.
    put(&h, ".codex/prompts/big.md", &"y".repeat(1 << 20));
    put(&h, ".codex/prompts/ok.md", "fine\n");
    assert_eq!(names(&list(&h, AgentKind::Codex)), ["ok"]);

    // Depth: four levels under commands are listed, a fifth is not.
    let d = home::short("ucc-depth");
    put(&d, ".claude/commands/l1/l2/l3/four.md", "x\n");
    put(&d, ".claude/commands/l1/l2/l3/l4/five.md", "x\n");
    assert_eq!(names(&list(&d, AgentKind::Claude)), ["l1:l2:l3:four"]);
    done(&d);

    // 10 000 entries in one folder: examined up to 200, and the op returns at once.
    let big = home::short("ucc-wide");
    fs::create_dir_all(big.join(".claude/commands")).unwrap();
    for i in 0..10_000 {
        fs::write(big.join(format!(".claude/commands/f{i:05}.md")), "x\n").unwrap();
    }
    let start = Instant::now();
    let rows = list(&big, AgentKind::Claude);
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(rows.len(), 200);
    done(&big);
    done(&h);
}

#[test]
fn missing_dir_is_empty() {
    let h = home::short("ucm");
    assert!(list(&h, AgentKind::Claude).is_empty());
    assert!(list(&h, AgentKind::Codex).is_empty());
    assert!(list(&h.join("nowhere"), AgentKind::Claude).is_empty());

    let h2 = fixture("ucm2");
    let locked = h2.join(".claude/commands");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let got = names(&list(&h2, AgentKind::Claude));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(got, ["s"]);
    assert_eq!(names(&list(&h2, AgentKind::Codex)), ["p"]);
    done(&h);
    done(&h2);
}

#[test]
fn fifo_and_unreadable_files_are_skipped() {
    let h = fixture("ucf");
    let fifo = h.join(".claude/commands/pipe.md");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    put(&h, ".claude/commands/secret.md", "no\n");
    fs::set_permissions(
        h.join(".claude/commands/secret.md"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    assert_eq!(names(&list(&h, AgentKind::Claude)), ["a", "ns:b", "s"]);
    done(&h);
}

/// Ticket 113: a tree of empty folders far larger than the visit budget stops at the budget; the first folder's
/// command is found, the last folder's is not. A small tree still returns every command.
#[test]
fn walk_stops_at_visit_budget() {
    let h = home::short("ucb");
    let commands = h.join(".claude/commands");
    // 20 x 20 x 20 leaf folders plus their parents: 8420 directories, each at most 200 entries.
    for a in 0..20 {
        for b in 0..20 {
            for c in 0..20 {
                fs::create_dir_all(commands.join(format!("d{a:02}/e{b:02}/f{c:02}"))).unwrap();
            }
        }
    }
    put(&h, ".claude/commands/d00/early.md", "Early\n");
    put(&h, ".claude/commands/d19/e19/f19/late.md", "Late\n");
    let found = names(&list(&h, AgentKind::Claude));
    assert_eq!(found, ["d00:early"]);
    done(&h);

    let h = home::short("ucn");
    for i in 0..50 {
        put(&h, &format!(".claude/commands/n{i:02}/c.md"), "x\n");
    }
    assert_eq!(list(&h, AgentKind::Claude).len(), 50);
    done(&h);
}

/// Ticket 113: a hard link is a regular file with the same inode, so it is read like any command: its first line shows.
#[test]
fn hard_link_first_line() {
    let h = home::short("uch");
    put(
        &h,
        "elsewhere/orig.md",
        "First line of the original\nsecond\n",
    );
    fs::create_dir_all(h.join(".claude/commands")).unwrap();
    fs::hard_link(
        h.join("elsewhere/orig.md"),
        h.join(".claude/commands/linked.md"),
    )
    .unwrap();
    let rows = list(&h, AgentKind::Claude);
    assert_eq!(names(&rows), ["linked"]);
    assert_eq!(rows[0].description, "First line of the original");
    done(&h);
}

// Ticket 371 item 16: rows from the user's enabled Claude plugins. installPath comes from a JSON file, so every refusal
// below is a row that must not appear, and nothing may hang.
fn plugin_files(h: &Path, installed: serde_json::Value, enabled: serde_json::Value) {
    let doc = serde_json::json!({ "version": 2, "plugins": installed });
    put(
        h,
        ".claude/plugins/installed_plugins.json",
        &doc.to_string(),
    );
    let settings = serde_json::json!({ "enabledPlugins": enabled });
    put(h, ".claude/settings.json", &settings.to_string());
}

fn user_install(root: &Path) -> serde_json::Value {
    serde_json::json!([{ "scope": "user", "installPath": root, "version": "1.0.0" }])
}

/// A plugin root with one command and one skill.
fn plugin_root(h: &Path, name: &str) -> PathBuf {
    let root = h.join(".claude/plugins/cache").join(name);
    put(
        &root,
        "commands/go.md",
        "---\ndescription: Go now\n---\nSECRET BODY\n",
    );
    put(
        &root,
        "skills/kf/SKILL.md",
        "---\nname: kf\ndescription: Runs the flow\n---\nSECRET BODY\n",
    );
    root
}

#[test]
fn plugin_rows_are_named_and_described() {
    let h = fixture("upn");
    let owner = plugin_root(&h, "owner");
    put(
        &owner,
        ".claude-plugin/plugin.json",
        r#"{"name":"buildFlow"}"#,
    );
    let other = plugin_root(&h, "other");
    plugin_files(
        &h,
        serde_json::json!({ "owner@market": user_install(&owner), "other@market": user_install(&other) }),
        serde_json::json!({ "owner@market": true, "other@market": true }),
    );
    let before = snapshot(&h);
    let rows = list(&h, AgentKind::Claude);
    assert_eq!(before, snapshot(&h), "the fixture tree is untouched");
    assert_eq!(
        names(&rows),
        [
            "a",
            "buildFlow:go",
            "buildFlow:kf",
            "ns:b",
            "other:go",
            "other:kf",
            "s"
        ]
    );
    let kf = rows.iter().find(|r| r.name == "buildFlow:kf").unwrap();
    assert_eq!(kf.description, "Runs the flow");
    assert_eq!(kf.source, "skill");
    assert!(rows.iter().all(|r| !r.description.contains("SECRET")));
    assert_eq!(names(&list(&h, AgentKind::Codex)), ["p"]);
    done(&h);
}

#[test]
fn plugin_refusals_give_no_row_and_no_hang() {
    let h = home::short("upr");
    let good = plugin_root(&h, "good");
    let off = plugin_root(&h, "off");
    let stringy = plugin_root(&h, "stringy");
    let project = plugin_root(&h, "project");
    let target = plugin_root(&h, "target");
    let link = h.join(".claude/plugins/cache/link");
    symlink(&target, &link).unwrap();
    // A real root whose `commands` and `skills` are links out.
    let linked_dirs = h.join(".claude/plugins/cache/dirs");
    fs::create_dir_all(&linked_dirs).unwrap();
    symlink(target.join("commands"), linked_dirs.join("commands")).unwrap();
    symlink(target.join("skills"), linked_dirs.join("skills")).unwrap();
    let c = std::ffi::CString::new(good.join("commands/pipe.md").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    plugin_files(
        &h,
        serde_json::json!({
            "good@m": user_install(&good),
            "off@m": user_install(&off),
            "stringy@m": user_install(&stringy),
            "absent@m": user_install(&target),
            "project@m": [{ "scope": "project", "installPath": project, "projectPath": "/x" }],
            "relative@m": [{ "scope": "user", "installPath": ".claude/plugins/cache/target" }],
            "link@m": user_install(&link),
            "dirs@m": user_install(&linked_dirs),
            "notalist@m": { "scope": "user", "installPath": target },
        }),
        serde_json::json!({
            "good@m": true, "off@m": false, "stringy@m": "true", "project@m": true,
            "relative@m": true, "link@m": true, "dirs@m": true, "notalist@m": true,
        }),
    );
    let before = snapshot(&h);
    assert_eq!(names(&list(&h, AgentKind::Claude)), ["good:go", "good:kf"]);
    assert_eq!(before, snapshot(&h));
    done(&h);
}

/// Round 2: `installPath` may name any folder, so a root outside `<home>/.claude/plugins` is never walked, however it
/// gets there: named outright, through `..`, or through a linked parent.
#[test]
fn plugin_root_outside_the_plugin_folder_gives_no_row() {
    let h = home::short("upo");
    let good = plugin_root(&h, "good");
    let outside = h.join("elsewhere/out");
    put(&outside, "commands/leak.md", "Outside command\n");
    put(&outside, "skills/leak/SKILL.md", "Outside skill\n");
    let dotted = h.join(".claude/plugins/../../elsewhere/out");
    symlink(h.join("elsewhere"), h.join(".claude/plugins/cache/linked")).unwrap();
    let through_link = h.join(".claude/plugins/cache/linked/out");
    plugin_files(
        &h,
        serde_json::json!({
            "good@m": user_install(&good),
            "outside@m": user_install(&outside),
            "dotted@m": user_install(&dotted),
            "parent@m": user_install(&through_link),
        }),
        serde_json::json!({ "good@m": true, "outside@m": true, "dotted@m": true, "parent@m": true }),
    );
    assert_eq!(names(&list(&h, AgentKind::Claude)), ["good:go", "good:kf"]);
    done(&h);
}

#[test]
fn plugin_json_files_over_the_cap_or_not_regular_give_no_row() {
    let padded = |doc: serde_json::Value| format!("{doc}{}", " ".repeat((4 << 20) + 1));
    let h = home::short("upc");
    let root = plugin_root(&h, "p");
    let installed = serde_json::json!({ "p@m": user_install(&root) });
    let enabled = serde_json::json!({ "p@m": true });
    plugin_files(&h, installed.clone(), enabled.clone());
    assert_eq!(names(&list(&h, AgentKind::Claude)), ["p:go", "p:kf"]);

    let settings = h.join(".claude/settings.json");
    let over = padded(serde_json::json!({ "enabledPlugins": enabled }));
    fs::write(&settings, over).unwrap();
    assert!(list(&h, AgentKind::Claude).is_empty());

    plugin_files(&h, installed.clone(), enabled.clone());
    let file = h.join(".claude/plugins/installed_plugins.json");
    let doc = serde_json::json!({ "version": 2, "plugins": installed });
    fs::write(&file, padded(doc)).unwrap();
    assert!(list(&h, AgentKind::Claude).is_empty());

    // A FIFO and broken JSON in its place: no row, and the open does not wait for a writer.
    fs::remove_file(&file).unwrap();
    let c = std::ffi::CString::new(file.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(list(&h, AgentKind::Claude).is_empty());
    fs::remove_file(&file).unwrap();
    fs::write(&file, "{not json").unwrap();
    assert!(list(&h, AgentKind::Claude).is_empty());
    done(&h);
}

#[test]
fn plugin_name_falls_back_to_the_key_when_unusable() {
    let h = home::short("upb");
    let root = plugin_root(&h, "p");
    put(
        &root,
        ".claude-plugin/plugin.json",
        r#"{"name":"bad name\n"}"#,
    );
    plugin_files(
        &h,
        serde_json::json!({ "from-key@m": user_install(&root) }),
        serde_json::json!({ "from-key@m": true }),
    );
    assert_eq!(
        names(&list(&h, AgentKind::Claude)),
        ["from-key:go", "from-key:kf"]
    );
    done(&h);
}

#[test]
fn plugin_rows_never_push_out_the_users_own() {
    let h = home::short("upm");
    for f in 0..150 {
        put(&h, &format!(".claude/commands/d0/z{f:03}.md"), "x\n");
        put(&h, &format!(".claude/commands/d1/z{f:03}.md"), "x\n");
    }
    let root = plugin_root(&h, "aaa");
    plugin_files(
        &h,
        serde_json::json!({ "aaa@m": user_install(&root) }),
        serde_json::json!({ "aaa@m": true }),
    );
    let rows = list(&h, AgentKind::Claude);
    assert_eq!(rows.len(), 300);
    assert!(rows.iter().all(|r| !r.name.starts_with("aaa:")));

    fs::remove_file(h.join(".claude/commands/d1/z149.md")).unwrap();
    let rows = list(&h, AgentKind::Claude);
    assert_eq!(rows.len(), 300);
    assert_eq!(
        rows.iter().filter(|r| r.name.starts_with("aaa:")).count(),
        1
    );
    done(&h);
}
