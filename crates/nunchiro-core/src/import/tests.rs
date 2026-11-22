use super::*;
use serde_json::json;
use std::sync::atomic::AtomicU32;

static N: AtomicU32 = AtomicU32::new(0);

/// Fixture agent folders and a Nunchiro home under the repo's `.scratch/`.
struct Fixture {
    base: PathBuf,
    roots: Roots,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../.scratch/import-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let (claude, codex, home) = (
            base.join("claude/projects"),
            base.join("codex/sessions"),
            base.join("home"),
        );
        for d in [&claude, &codex, &home] {
            fs::create_dir_all(d).unwrap();
        }
        Self {
            base,
            roots: Roots { claude, codex },
            home,
        }
    }
    fn claude(&self, project: &str, id: &str, lines: &[serde_json::Value]) -> PathBuf {
        let dir = self.roots.claude.join(project);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        write(&path, lines);
        path
    }
    fn codex(&self, id: &str, cwd: &str, lines: &[serde_json::Value]) -> PathBuf {
        let dir = self.roots.codex.join("2026/10/27");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-10-27T10-00-00-{id}.jsonl"));
        let mut all = vec![json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}})];
        all.extend_from_slice(lines);
        write(&path, &all);
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn write(path: &Path, lines: &[serde_json::Value]) {
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    fs::write(path, text).unwrap();
}
fn user(text: &str) -> serde_json::Value {
    json!({"type":"user","cwd":"/work/app","message":{"role":"user","content":text}})
}
/// Every file under `dir` with its bytes and modification time, for a byte-for-byte comparison.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>, std::time::SystemTime)> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((
                    p.clone(),
                    fs::read(&p).unwrap(),
                    fs::metadata(&p).unwrap().modified().unwrap(),
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn list_reads_both_agents_with_project_and_title() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("Fix the   login\nbug")]);
    f.codex("x1", "/work/api", &[json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add rate limits"}]}})]);
    let items = list(&f.roots, &f.home).unwrap();
    let claude = items.iter().find(|i| i.id == "claude:c1").unwrap();
    assert_eq!(
        (
            claude.project.as_str(),
            claude.title.as_str(),
            claude.imported
        ),
        ("/work/app", "Fix the login bug", false)
    );
    let codex = items.iter().find(|i| i.agent == Agent::Codex).unwrap();
    assert_eq!(codex.project, "/work/api");
    assert_eq!(items.len(), 2);
}

#[test]
fn sub_agent_logs_and_links_are_not_conversations() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("hello")]);
    let deep = f.roots.claude.join("-work-app/c1/subagents");
    fs::create_dir_all(&deep).unwrap();
    write(&deep.join("agent-1.jsonl"), &[user("sub")]);
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("secret")]);
    std::os::unix::fs::symlink(&outside, f.roots.claude.join("-work-app/link.jsonl")).unwrap();
    let ids: Vec<_> = list(&f.roots, &f.home)
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(ids, ["claude:c1"]);
}

#[test]
fn import_read_only() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("needle in claude")]);
    f.codex("x1", "/work/api", &[json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"needle in codex"}]}})]);
    let (claude, codex) = (
        snapshot(&f.base.join("claude")),
        snapshot(&f.base.join("codex")),
    );
    let ids: Vec<String> = list(&f.roots, &f.home)
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(add(&f.roots, &f.home, &ids).unwrap(), 2);
    search_imported(&f.roots, &f.home, "needle", &AtomicBool::new(false)).unwrap();
    // Fixture homes unchanged byte for byte (and no new file, no new modification time); only Nunchiro's home gained one.
    assert!(claude == snapshot(&f.base.join("claude")) && codex == snapshot(&f.base.join("codex")));
    assert_eq!(snapshot(&f.home).len(), 1);
}

#[test]
fn imported_searchable() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("the zebra crossing bug")]);
    f.claude("-work-app", "c2", &[user("unrelated")]);
    let cancel = AtomicBool::new(false);
    // Not imported yet: nothing is searched.
    assert!(
        search_imported(&f.roots, &f.home, "zebra", &cancel)
            .unwrap()
            .is_empty()
    );
    add(&f.roots, &f.home, &["claude:c1".into(), "claude:c2".into()]).unwrap();
    let found = search_imported(&f.roots, &f.home, "ZEBRA", &cancel).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].session.as_str(), found[0].status.as_str()),
        ("claude:c1", "ok")
    );
    assert!(found[0].hits[0].text.contains("zebra crossing"));
    // Listed again, the import mark shows.
    let marks: Vec<_> = list(&f.roots, &f.home)
        .unwrap()
        .into_iter()
        .map(|i| (i.id, i.imported))
        .collect();
    assert!(
        marks.contains(&("claude:c1".into(), true)) && marks.contains(&("claude:c2".into(), true))
    );
}

#[test]
fn add_refuses_an_id_the_listing_does_not_hold() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("x")]);
    for ids in [
        vec!["claude:../../etc/passwd".to_string()],
        vec!["claude:nope".into()],
        vec![],
    ] {
        assert!(add(&f.roots, &f.home, &ids).is_err(), "{ids:?}");
    }
    assert!(!f.home.join(STORE).exists());
}

#[test]
fn a_broken_store_is_an_error_and_stays_as_it_was() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("x")]);
    for bad in ["{\"a\":1}", "[{\"id\":5}]", "not json"] {
        fs::write(f.home.join(STORE), bad).unwrap();
        assert!(
            add(&f.roots, &f.home, &["claude:c1".into()]).is_err(),
            "{bad}"
        );
        assert!(list(&f.roots, &f.home).is_err(), "{bad}");
        assert_eq!(fs::read_to_string(f.home.join(STORE)).unwrap(), bad);
    }
}

#[test]
fn a_transcript_replaced_by_a_link_is_skipped_by_search() {
    let f = Fixture::new();
    let path = f.claude("-work-app", "c1", &[user("zebra")]);
    add(&f.roots, &f.home, &["claude:c1".into()]).unwrap();
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("zebra elsewhere")]);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(
        search_imported(&f.roots, &f.home, "zebra", &AtomicBool::new(false))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_browser_role_cannot_express_an_import_frame() {
    for op in [
        json!({"op":"import_list"}),
        json!({"op":"import_list","projects":["/work/app"]}),
        json!({"op":"import_add","ids":["claude:c1"]}),
        json!({"op":"import_search","query":"x"}),
        json!({"op":"import_read","id":"claude:c1"}),
    ] {
        let frame = json!({"id": 1, "request": op}).to_string();
        assert!(crate::http::browser::allowed(&frame).is_err(), "{frame}");
    }
}

#[test]
fn a_tampered_store_path_outside_the_agent_folder_is_not_read() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("zebra")]);
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("zebra elsewhere")]);
    let tampered = json!([{"id":"claude:c1","agent":"claude","project":"","title":"","modified_ms":0,"path":outside}]);
    fs::write(f.home.join(STORE), tampered.to_string()).unwrap();
    assert!(
        search_imported(&f.roots, &f.home, "zebra", &AtomicBool::new(false))
            .unwrap()
            .is_empty()
    );
}

// ---- import_read: the window opens an imported conversation as a read-only view ----

type Read = (Vec<serde_json::Value>, bool, usize);
fn read_of(f: &Fixture, id: &str) -> Result<Read, String> {
    match read(&f.roots, &f.home, id)? {
        Reply::ImportRead {
            entries,
            truncated,
            left_out,
            ..
        } => Ok((entries, truncated, left_out)),
        other => panic!("not an import_read reply: {other:?}"),
    }
}
fn assistant(text: &str) -> serde_json::Value {
    json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}})
}
fn imported(f: &Fixture, ids: &[&str]) {
    let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    add(&f.roots, &f.home, &ids).unwrap();
}

#[test]
fn import_read_returns_entries_in_order() {
    let f = Fixture::new();
    f.claude(
        "-work-app",
        "c1",
        &[user("first"), assistant("second"), user("third")],
    );
    imported(&f, &["claude:c1"]);
    let Reply::ImportRead {
        id,
        agent,
        project,
        title,
        entries,
        truncated,
        left_out,
    } = read(&f.roots, &f.home, "claude:c1").unwrap()
    else {
        panic!("not an import_read reply")
    };
    assert_eq!(
        (id.as_str(), agent, project.as_str(), title.as_str()),
        ("claude:c1", Agent::Claude, "/work/app", "first")
    );
    assert_eq!((truncated, left_out), (false, 0));
    // The chat feed's event shape: schema_version, a running cursor from 1, the projected event as `data`.
    let seen: Vec<_> = entries
        .iter()
        .map(|e| {
            (
                e["schema_version"].as_u64().unwrap(),
                e["cursor"].as_u64().unwrap(),
                e["data"]["role"].as_str().unwrap().to_string(),
                e["data"]["text"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            (1, 1, "user".into(), "first".into()),
            (1, 2, "assistant".into(), "second".into()),
            (1, 3, "user".into(), "third".into()),
        ]
    );
    // A Codex transcript reads the same way.
    f.codex("x1", "/work/api", &[json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"from codex"}]}})]);
    imported(&f, &["codex:rollout-2026-10-27T10-00-00-x1"]);
    let (entries, ..) = read_of(&f, "codex:rollout-2026-10-27T10-00-00-x1").unwrap();
    assert_eq!(entries[0]["data"]["text"], "from codex");
}

#[test]
fn import_read_refuses_a_tampered_path() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("zebra")]);
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("secret elsewhere")]);
    for path in [
        outside.clone(),
        f.roots.claude.join("../../outside.jsonl"),
        f.roots.claude.join("-work-app/../../../outside.jsonl"),
    ] {
        let tampered = json!([{"id":"claude:c1","agent":"claude","project":"","title":"","modified_ms":0,"path":path}]);
        fs::write(f.home.join(STORE), tampered.to_string()).unwrap();
        assert!(read_of(&f, "claude:c1").is_err(), "{path:?}");
    }
    // A folder as the path is not a transcript either.
    let tampered = json!([{"id":"claude:c1","agent":"claude","project":"","title":"","modified_ms":0,"path":f.roots.claude.join("-work-app")}]);
    fs::write(f.home.join(STORE), tampered.to_string()).unwrap();
    assert!(read_of(&f, "claude:c1").is_err());
}

#[test]
fn import_read_refuses_a_symlink_and_a_fifo() {
    let f = Fixture::new();
    let path = f.claude("-work-app", "c1", &[user("zebra")]);
    f.claude("-work-app", "c2", &[user("pipe")]);
    imported(&f, &["claude:c1", "claude:c2"]);
    // The transcript replaced by a link to a file outside the folder.
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("secret elsewhere")]);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(read_of(&f, "claude:c1").is_err());
    // A link to a file inside the folder is refused as well: only a regular file at the stored path is read.
    let inside = f.roots.claude.join("-work-app/c2.jsonl");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&inside, &path).unwrap();
    assert!(read_of(&f, "claude:c1").is_err());
    // A FIFO in place of the transcript is refused before an open could block.
    fs::remove_file(&inside).unwrap();
    let c = std::ffi::CString::new(inside.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(read_of(&f, "claude:c2").is_err());
}

#[test]
fn import_read_refuses_an_id_that_is_not_imported() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("listed, never added")]);
    f.claude("-work-app", "c2", &[user("imported")]);
    imported(&f, &["claude:c2"]);
    for id in ["claude:c1", "claude:nope", "claude:../../etc/passwd", ""] {
        let e = read_of(&f, id).unwrap_err();
        assert_eq!(e, "not imported", "{id}");
    }
    assert!(read_of(&f, "claude:c2").is_ok());
}

#[test]
fn import_read_is_bounded() {
    let f = Fixture::new();
    // More events than the cap: the first MAX_ENTRIES come back, the rest are counted.
    let many: Vec<_> = (0..MAX_ENTRIES + 7)
        .map(|i| user(&format!("m{i}")))
        .collect();
    f.claude("-work-app", "many", &many);
    imported(&f, &["claude:many"]);
    let (entries, truncated, left_out) = read_of(&f, "claude:many").unwrap();
    assert_eq!((entries.len(), truncated, left_out), (MAX_ENTRIES, true, 7));
    assert_eq!(
        entries[MAX_ENTRIES - 1]["data"]["text"],
        format!("m{}", MAX_ENTRIES - 1)
    );
    // A file over the byte limit: whole lines only, and the rest is counted (not parsed).
    let big = "x".repeat(1 << 20);
    let lines: Vec<_> = (0..10).map(|i| user(&format!("{i}{big}"))).collect();
    f.claude("-work-app", "big", &lines);
    imported(&f, &["claude:big"]);
    let (entries, truncated, left_out) = read_of(&f, "claude:big").unwrap();
    assert!(truncated && entries.len() < 10 && !entries.is_empty());
    assert_eq!(entries.len() + left_out, 10);
    assert!(
        entries
            .iter()
            .all(|e| e["data"]["text"].as_str().unwrap().len() > big.len())
    );
    // A sparse file of 1 GiB is cut at the limit, never read whole.
    let path = f.claude("-work-app", "sparse", &[user("head")]);
    imported(&f, &["claude:sparse"]);
    let file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.set_len(1 << 30).unwrap();
    let started = std::time::Instant::now();
    let (entries, truncated, _) = read_of(&f, "claude:sparse").unwrap();
    assert!(truncated);
    assert_eq!(entries[0]["data"]["text"], "head");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn import_read_writes_nothing() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("one"), assistant("two")]);
    f.codex("x1", "/work/api", &[json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"three"}]}})]);
    imported(&f, &["claude:c1", "codex:rollout-2026-10-27T10-00-00-x1"]);
    let before = (
        snapshot(&f.base.join("claude")),
        snapshot(&f.base.join("codex")),
        snapshot(&f.home),
    );
    let tree: Vec<_> = fs::read_dir(&f.base)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    for id in ["claude:c1", "codex:rollout-2026-10-27T10-00-00-x1"] {
        read_of(&f, id).unwrap();
    }
    // Refused reads change nothing either.
    assert!(read_of(&f, "claude:nope").is_err());
    let after = (
        snapshot(&f.base.join("claude")),
        snapshot(&f.base.join("codex")),
        snapshot(&f.home),
    );
    assert!(
        before == after,
        "a file's bytes or modification time changed, or a file appeared"
    );
    let tree_after: Vec<_> = fs::read_dir(&f.base)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    assert_eq!(tree.len(), tree_after.len());
}

// ---- 392: a project's own past conversations, for its row in the tree ----

/// One project's answer from the one-scan listing.
fn list_in(roots: &Roots, home: &Path, project: &str) -> Result<Vec<Item>, String> {
    Ok(lists_in(roots, home, &[project.to_string()])?
        .remove(project)
        .unwrap())
}
fn codex_user(text: &str) -> serde_json::Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
}
fn aged(path: &Path, secs_ago: u64) {
    let at = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

#[test]
fn a_project_list_holds_only_that_exact_folder_newest_first() {
    let f = Fixture::new();
    aged(&f.claude("-work-app", "c1", &[user("older")]), 300);
    aged(&f.codex("x1", "/work/app/", &[codex_user("newer")]), 10);
    for (id, cwd) in [
        ("x2", "/work/app-other"),
        ("x3", "/work/app/sub"),
        ("x4", "/work"),
        ("x5", ""),
    ] {
        f.codex(id, cwd, &[codex_user("elsewhere")]);
    }
    let found: Vec<_> = list_in(&f.roots, &f.home, "/work/app")
        .unwrap()
        .into_iter()
        .map(|i| (i.id, i.title, i.imported))
        .collect();
    assert_eq!(
        found,
        [
            (
                "codex:rollout-2026-10-27T10-00-00-x1".to_string(),
                "newer".to_string(),
                false
            ),
            ("claude:c1".into(), "older".into(), false),
        ]
    );
    // Imported once, the mark shows in the project's list too.
    add(&f.roots, &f.home, &["claude:c1".into()]).unwrap();
    assert!(list_in(&f.roots, &f.home, "/work/app/").unwrap()[1].imported);
}

#[test]
fn only_a_project_the_tree_holds_may_be_asked_about() {
    let tree: std::collections::BTreeSet<String> = ["/work/app".to_string()].into();
    assert_eq!(held("/work/app", &tree), Ok(()));
    // Not in the tree, relative, or a parent: one refusal, the tree's own, whatever the agents' folders hold.
    for asked in ["/work/other", "work/app", "/work", "", "/work/app/"] {
        assert_eq!(
            held(asked, &tree),
            Err("unknown project".to_string()),
            "{asked}"
        );
    }
}

#[test]
fn a_linked_transcript_is_not_in_a_project_list() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("mine")]);
    let outside = f.base.join("outside.jsonl");
    write(&outside, &[user("secret")]);
    std::os::unix::fs::symlink(&outside, f.roots.claude.join("-work-app/link.jsonl")).unwrap();
    let ids: Vec<_> = list_in(&f.roots, &f.home, "/work/app")
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(ids, ["claude:c1"]);
}

#[test]
fn a_project_list_writes_nothing() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("x")]);
    f.codex("x1", "/work/app", &[codex_user("y")]);
    let before = snapshot(&f.base);
    assert_eq!(list_in(&f.roots, &f.home, "/work/app").unwrap().len(), 2);
    assert!(before == snapshot(&f.base));
}

#[test]
fn the_list_frame_takes_an_optional_project() {
    let op: Op = serde_json::from_value(json!({"op":"import_list"})).unwrap();
    assert!(matches!(op, Op::ImportList { projects: None }));
    let op: Op =
        serde_json::from_value(json!({"op":"import_list","projects":["/work/app"]})).unwrap();
    assert!(matches!(op, Op::ImportList { projects: Some(p) } if p == ["/work/app"]));
    assert!(serde_json::from_value::<Op>(json!({"op":"import_list","folder":"/"})).is_err());
}

// ---- 392 round 2: every tree project from one scan, in one request ----

fn tree_of(projects: &[&str]) -> std::collections::BTreeSet<String> {
    projects.iter().map(|p| p.to_string()).collect()
}

#[test]
fn one_request_answers_every_tree_project_from_one_scan() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("in app")]);
    f.codex("x1", "/work/api", &[codex_user("in api")]);
    f.codex("x2", "/work/elsewhere", &[codex_user("unrelated")]);
    let before = snapshot(&f.base);
    let asked = vec![
        "/work/app".to_string(),
        "/work/api".into(),
        "/work/none".into(),
    ];
    let tree = tree_of(&["/work/app", "/work/api", "/work/none"]);
    let lists = listed(&f.roots, &f.home, &asked, &tree).unwrap();
    let titles = |p: &str| lists[p].iter().map(|i| i.title.clone()).collect::<Vec<_>>();
    assert_eq!(titles("/work/app"), ["in app"]);
    assert_eq!(titles("/work/api"), ["in api"]);
    // A project with none is answered, empty: known to have no row, not unknown.
    assert!(lists["/work/none"].is_empty());
    assert_eq!(lists.len(), 3);
    assert!(lists.values().flatten().all(|i| i.title != "unrelated"));
    // Read only: the agents' folders and Nunchiro's home are as they were.
    assert!(before == snapshot(&f.base));
}

#[test]
fn one_project_outside_the_tree_refuses_the_whole_request() {
    let f = Fixture::new();
    f.claude("-work-app", "c1", &[user("in app")]);
    let tree = tree_of(&["/work/app"]);
    for asked in [
        vec!["/work/app".to_string(), "/work/other".into()],
        vec!["/work/app".to_string(), "work/app".into()],
    ] {
        // No partial answer: the same refusal whichever entry is not in the tree.
        assert_eq!(
            listed(&f.roots, &f.home, &asked, &tree).err().as_deref(),
            Some("unknown project"),
            "{asked:?}"
        );
    }
}

#[test]
fn a_request_carries_at_most_max_projects() {
    let f = Fixture::new();
    let many: Vec<String> = (0..=MAX_PROJECTS).map(|i| format!("/work/p{i}")).collect();
    let tree: std::collections::BTreeSet<String> = many.iter().cloned().collect();
    assert!(listed(&f.roots, &f.home, &many, &tree).is_err());
    assert!(listed(&f.roots, &f.home, &many[..MAX_PROJECTS], &tree).is_ok());
}

// ---- 378: the title is the person's first request ----

fn title_of(f: &Fixture, id: &str) -> String {
    let items = list(&f.roots, &f.home).unwrap();
    items.into_iter().find(|i| i.id == id).unwrap().title
}

#[test]
fn a_resumed_conversation_is_titled_by_its_real_request() {
    let f = Fixture::new();
    f.claude(
        "-work-app",
        "c1",
        &[
            user("This session is being continued from a previous conversation that ran out of context."),
            user("Add a dark mode"),
        ],
    );
    assert_eq!(title_of(&f, "claude:c1"), "Add a dark mode");
}

#[test]
fn a_compacted_conversation_skips_its_summary() {
    let f = Fixture::new();
    let mut summary = user("Summary: the work so far");
    summary["isCompactSummary"] = true.into();
    summary["isVisibleInTranscriptOnly"] = true.into();
    let mut meta = user("Base directory for this skill");
    meta["isMeta"] = true.into();
    f.claude("-work-app", "c1", &[summary, meta, user("Now ship it")]);
    assert_eq!(title_of(&f, "claude:c1"), "Now ship it");
}

#[test]
fn a_slash_command_start_is_not_the_title() {
    let f = Fixture::new();
    let mut caveat = user("<local-command-caveat>Caveat</local-command-caveat>");
    caveat["isMeta"] = true.into();
    f.claude(
        "-work-app",
        "c1",
        &[
            caveat,
            user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
            user("<local-command-stdout></local-command-stdout>"),
            user("Rename the module"),
        ],
    );
    assert_eq!(title_of(&f, "claude:c1"), "Rename the module");
}

#[test]
fn codex_context_blocks_before_the_request_are_not_the_title() {
    let f = Fixture::new();
    f.codex(
        "x1",
        "/work/api",
        &[codex_user(
            "<user_instructions>\nBe brief\n</user_instructions>\n\n<environment_context>\n<cwd>/work/api</cwd>\n</environment_context>\n\nAdd rate limits",
        )],
    );
    assert_eq!(
        title_of(&f, "codex:rollout-2026-10-27T10-00-00-x1"),
        "Add rate limits"
    );
}

#[test]
fn only_skipped_text_is_still_a_title() {
    let f = Fixture::new();
    f.claude(
        "-work-app",
        "c1",
        &[user(
            "This session is being continued from a previous conversation.",
        )],
    );
    assert_eq!(
        title_of(&f, "claude:c1"),
        "This session is being continued from a previous conversation."
    );
}

/// Look 11-17 (area A): a lead's start brief is a long paste; its title is the first real line, never the paste mark.
#[test]
fn a_pasted_brief_is_titled_by_its_first_real_line() {
    let f = Fixture::new();
    f.claude(
        "-work-app",
        "c1",
        &[user("<pasted_content id=\"p1\" lines=\"40\">\n\nYou lead this project.\nSecond line\n</pasted_content>")],
    );
    assert_eq!(title_of(&f, "claude:c1"), "You lead this project.");
}
