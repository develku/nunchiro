//! v1b-06: artifact detection over chat events (ticket 06), through the chat store the window reads.
use nunchiro_core::{
    api::AgentKind,
    chat::{Store, TESTED_VERSIONS, artifacts::Context},
    files::{self, Root},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

const AGENTS: [(AgentKind, &str); 2] = [(AgentKind::Claude, "claude"), (AgentKind::Codex, "codex")];

fn scratch(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("artifact-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(p.join("project")).unwrap();
    p.canonicalize().unwrap()
}

fn fixture(agent: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("tests/fixtures/artifacts/{agent}.jsonl")),
    )
    .unwrap()
}

fn events(store: &Store, kind: AgentKind) -> Vec<Value> {
    store
        .page(
            kind,
            Some(TESTED_VERSIONS.iter().find(|v| v.0 == kind).unwrap().1),
            TESTED_VERSIONS,
            None,
        )
        .unwrap()
        .events
        .into_iter()
        .map(|e| e.data)
        .collect()
}

/// The artifact events the store emits for a transcript, with `/project` standing for the session folder.
fn detect_in(base: &Path, kind: AgentKind, text: &str) -> Vec<Value> {
    let folder = base.join("project");
    let path = base.join("t.jsonl");
    fs::write(&path, text.replace("/project", folder.to_str().unwrap())).unwrap();
    let mut store = Store::open(&base.join("home"), "chat-1").unwrap();
    let artifacts = base.join("home/artifacts/s1"); // v1b-07
    let ctx = Context {
        session: "s1",
        folder: &folder,
        artifacts: &artifacts,
    };
    store.refresh_with(kind, &path, Some(&ctx)).unwrap();
    events(&store, kind)
        .into_iter()
        .filter(|e| e["kind"] == "artifact")
        .collect()
}

fn detect(name: &str, agent: &str, kind: AgentKind) -> (PathBuf, Vec<Value>) {
    let base = scratch(&format!("{name}-{agent}"));
    let found = detect_in(&base, kind, &fixture(agent));
    (base, found)
}

fn by_path<'a>(found: &'a [Value], path: &str) -> Vec<&'a Value> {
    found.iter().filter(|e| e["path"] == path).collect()
}

fn one(found: &[Value], path: &str, source: &str, kind: &str, title: &str) {
    let hits = by_path(found, path);
    assert_eq!(hits.len(), 1, "{path} in {found:#?}");
    let e = hits[0];
    assert_eq!(
        (e["source"].as_str(), e["type"].as_str()),
        (Some(source), Some(kind)),
        "{e}"
    );
    assert_eq!(e["root"], "s1");
    assert_eq!(e["title"], title);
    assert!(e["tool_id"].is_string());
}

#[test]
fn artifact_detects_html() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("html", agent, kind);
        one(
            &found,
            "site/index.html",
            "written",
            "html",
            "눈치로 데모 & עברית",
        );
        if kind == AgentKind::Codex {
            // A moved file is the artifact at its destination.
            one(&found, "final.html", "edited", "html", "final.html");
        }
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_detects_htm() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("htm", agent, kind);
        one(&found, "old/page.htm", "written", "html", "Old page");
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_detects_md() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("md", agent, kind);
        // The first heading outside a code block, raw HTML stripped.
        one(
            &found,
            "docs/notes.md",
            "written",
            "markdown",
            "Release notes",
        );
        one(&found, "README.md", "edited", "markdown", "README.md");
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_detects_svg() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("svg", agent, kind);
        one(&found, "logo.svg", "written", "svg", "Logo");
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_detects_png() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("png", agent, kind);
        let name = if kind == AgentKind::Claude {
            "screen.PNG"
        } else {
            "screen.png"
        };
        one(&found, &format!("shots/{name}"), "written", "image", name);
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_detects_fenced_block() {
    let body = "<!doctype html><title>Block chart</title><p>bars</p>";
    for (kind, agent) in AGENTS {
        let (base, found) = detect("block", agent, kind);
        let blocks: Vec<_> = found.iter().filter(|e| e["source"] == "block").collect();
        assert!(!blocks.is_empty(), "{found:#?}");
        let e = blocks[0];
        assert_eq!(
            (&e["root"], &e["type"], &e["title"], &e["tool_id"]),
            (
                &json!("data"),
                &json!("html"),
                &json!("Block chart"),
                &Value::Null
            )
        );
        let rel = e["path"].as_str().unwrap();
        assert!(
            rel.starts_with("artifacts/s1/") && rel.ends_with(".html"),
            "{rel}"
        );
        let file = base.join("home").join(rel);
        assert_eq!(fs::read_to_string(&file).unwrap(), body);
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for dir in [base.join("home/artifacts"), base.join("home/artifacts/s1")] {
            assert_eq!(
                fs::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        // The data root serves it: the window opens it like any file.
        let read = files::read(&Root::Data(base.join("home")), rel).unwrap();
        assert_eq!(read.text.as_deref(), Some(body));
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_ignores_rs_file() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("rs", agent, kind);
        assert!(
            found
                .iter()
                .all(|e| !e["path"].as_str().unwrap().ends_with(".rs")),
            "{found:#?}"
        );
        // The fixture also writes main.rs: everything detected is an artifact type, and the deletion is no card.
        assert!(by_path(&found, "gone.html").is_empty());
        fs::remove_dir_all(base).unwrap();
    }
}

// Edge cases (REPORT names each).

#[test]
fn artifact_failed_write_yields_no_card() {
    for (kind, agent) in AGENTS {
        let (base, found) = detect("fail", agent, kind);
        assert!(by_path(&found, "fail.html").is_empty(), "{found:#?}");
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_outside_session_folder_cannot_be_read() {
    for (kind, agent) in AGENTS {
        let base = scratch(&format!("outside-{agent}"));
        let folder = base.join("project");
        fs::write(base.join("secret.html"), "<title>secret</title>").unwrap();
        symlink(base.join("secret.html"), folder.join("link.html")).unwrap();
        let link = match kind {
            AgentKind::Claude => format!(
                "{}\n{}\n",
                json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"w-link","name":"Write","input":{"file_path":"/project/link.html","content":"x"}}]}}),
                json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"w-link","content":"ok"}]}})
            ),
            _ => format!(
                "{}\n{}\n",
                json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"p-link","name":"apply_patch","input":"*** Begin Patch\n*** Update File: link.html\n@@\n-a\n+b\n*** End Patch"}}),
                json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"p-link","output":"Success."}})
            ),
        };
        let found = detect_in(&base, kind, &format!("{}{link}", fixture(agent)));
        let root = Root::Folder(folder.clone());
        for path in ["/etc/outside.html", "../sibling/up.html", "link.html"] {
            let hits = by_path(&found, path);
            assert_eq!(hits.len(), 1, "{path}: {found:#?}");
            // The card names it, and the file API (the only way the window reads) refuses it.
            assert!(
                files::read(&root, path).is_err(),
                "{path} must not be readable"
            );
        }
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_block_unknown_type_or_over_2mb_is_not_saved() {
    let base = scratch("block-limits");
    let big = "x".repeat(2 * 1024 * 1024 + 1);
    let text = format!(
        "{}\n",
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":format!("```nunchiro-artifact js\nalert(1)\n```\n\n```nunchiro-artifact\n{big}\n```\n")}]}})
    );
    let found = detect_in(&base, AgentKind::Claude, &text);
    assert!(found.is_empty(), "{} events", found.len());
    assert!(!base.join("home/artifacts").exists());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn artifact_same_block_twice_saves_once() {
    use std::os::unix::fs::MetadataExt;
    for (kind, agent) in AGENTS {
        let base = scratch(&format!("twice-{agent}"));
        let text = fixture(agent);
        let found = detect_in(&base, kind, &text);
        let rel = found.iter().find(|e| e["source"] == "block").unwrap()["path"]
            .as_str()
            .unwrap()
            .to_string();
        let file = base.join("home").join(&rel);
        let first = fs::metadata(&file).unwrap().ino();
        // The same block again in a later read: a second card, the same file, not written again.
        let block = text
            .lines()
            .rfind(|l| l.contains("nunchiro-artifact"))
            .unwrap()
            .to_string();
        let found = detect_in(&base, kind, &format!("{text}{block}\n"));
        let blocks: Vec<_> = found.iter().filter(|e| e["source"] == "block").collect();
        assert!(
            blocks.len() >= 2 && blocks.iter().all(|e| e["path"] == json!(rel)),
            "{blocks:#?}"
        );
        assert_eq!(fs::metadata(&file).unwrap().ino(), first, "not rewritten");
        let saved: Vec<_> = fs::read_dir(base.join("home/artifacts/s1"))
            .unwrap()
            .collect();
        assert_eq!(
            saved.len(),
            1,
            "one file per content address, no temp files left"
        );
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn artifact_cache_from_main_backfills_once() {
    let base = scratch("backfill");
    let folder = base.join("project");
    let path = base.join("t.jsonl");
    fs::write(
        &path,
        fixture("claude").replace("/project", folder.to_str().unwrap()),
    )
    .unwrap();
    let home = base.join("home");
    // Main indexes without artifact detection (no context) and writes no `artifacts` key.
    let mut store = Store::open(&home, "chat-1").unwrap();
    store.refresh(AgentKind::Claude, &path).unwrap();
    let generation = store.generation();
    assert!(
        events(&store, AgentKind::Claude)
            .iter()
            .all(|e| e["kind"] != "artifact")
    );
    drop(store);
    let meta: Value =
        serde_json::from_slice(&fs::read(home.join("chat/chat-1.json")).unwrap()).unwrap();
    assert!(meta.get("artifacts").is_none());
    let artifacts = base.join("home/artifacts/s1"); // v1b-07
    let ctx = Context {
        session: "s1",
        folder: &folder,
        artifacts: &artifacts,
    };
    let mut store = Store::open(&home, "chat-1").unwrap();
    store
        .refresh_with(AgentKind::Claude, &path, Some(&ctx))
        .unwrap();
    assert_eq!(
        store.generation(),
        generation + 1,
        "the window starts over once"
    );
    let all = events(&store, AgentKind::Claude);
    assert!(
        all.iter()
            .any(|e| e["kind"] == "artifact" && e["path"] == "site/index.html")
    );
    // Each artifact follows the tool result that confirmed it.
    let i = all
        .iter()
        .position(|e| e["kind"] == "artifact" && e["tool_id"] == "w-html")
        .unwrap();
    assert_eq!(
        (&all[i - 1]["kind"], &all[i - 1]["tool_id"]),
        (&json!("tool_result"), &json!("w-html"))
    );
    store
        .refresh_with(AgentKind::Claude, &path, Some(&ctx))
        .unwrap();
    assert_eq!(store.generation(), generation + 1, "and only once");
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn artifact_newer_cache_is_refused_untouched() {
    let base = scratch("newer");
    let home = base.join("home");
    let found = detect_in(&base, AgentKind::Claude, &fixture("claude"));
    assert!(!found.is_empty());
    let meta = home.join("chat/chat-1.json");
    let mut v: Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    v["version"] = json!(3);
    let bytes = serde_json::to_vec(&v).unwrap();
    fs::write(&meta, &bytes).unwrap();
    assert!(Store::open(&home, "chat-1").is_err());
    assert_eq!(fs::read(&meta).unwrap(), bytes);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn artifact_call_in_an_earlier_refresh_still_matches() {
    // Live: the tool call and its result arrive in separate reads.
    let base = scratch("split");
    let folder = base.join("project");
    let path = base.join("t.jsonl");
    let text = fixture("claude").replace("/project", folder.to_str().unwrap());
    let lines: Vec<_> = text.lines().collect();
    let artifacts = base.join("home/artifacts/s1"); // v1b-07
    let ctx = Context {
        session: "s1",
        folder: &folder,
        artifacts: &artifacts,
    };
    let mut store = Store::open(&base.join("home"), "chat-1").unwrap();
    fs::write(&path, format!("{}\n", lines[0])).unwrap();
    store
        .refresh_with(AgentKind::Claude, &path, Some(&ctx))
        .unwrap();
    fs::write(&path, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
    store
        .refresh_with(AgentKind::Claude, &path, Some(&ctx))
        .unwrap();
    let found: Vec<_> = events(&store, AgentKind::Claude)
        .into_iter()
        .filter(|e| e["kind"] == "artifact")
        .collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["path"], "site/index.html");
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn artifact_title_keeps_text_and_decodes_entities() {
    use nunchiro_core::chat::artifacts::title;
    // A bare `<` or `>` is text; only real tags are stripped.
    assert_eq!(
        title("markdown", Some("# a < b and c > d\n"), "x.md"),
        "a < b and c > d"
    );
    assert_eq!(
        title("markdown", Some("# 1<2 & <em>x</em> <br/> 3>2\n"), "x.md"),
        "1<2 & x 3>2"
    );
    // Entities decode after tags go, so an escaped tag stays visible text.
    assert_eq!(
        title(
            "html",
            Some("<title>&lt;b&gt; &amp;amp; &#39;q&#x27; &quot;</title>"),
            "x.html"
        ),
        "<b> &amp; 'q' \""
    );
    assert_eq!(
        title("html", Some("<title><!-- c --></title>"), "x.html"),
        "x.html"
    );
}

/// v1b-36: Codex 0.161.0 applies patches through the code-mode `exec` tool; only the patch headers are read.
#[test]
fn artifact_exec_wrapped_apply_patch_makes_cards_for_artifacts_folder_only() {
    let base = scratch("exec-patch");
    let art = base.join("home/artifacts/s1");
    let script = |a: &str, b: &str| {
        format!(
            "const patch = \"*** Begin Patch\\n*** Add File: {a}/chart.html\\n+<title>x</title>\\n*** Update File: {a}/old.md\\n@@\\n-a\\n+b\\n*** Add File: {b}\\n+x\\n*** Add File: {a}/../up.html\\n+x\\n*** Add File: /project/in-folder.html\\n+x\\n*** End Patch\";\ntools.apply_patch(patch);"
        )
    };
    let call = |id: &str, input: String, out: &str| {
        format!(
            "{}\n{}\n",
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":id,"name":"exec","input":input}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":id,"output":[{"type":"input_text","text":out},{"type":"input_text","text":"{}"}]}})
        )
    };
    let text = format!(
        "{}{}",
        call(
            "e1",
            script(art.to_str().unwrap(), "/etc/outside.html"),
            "Script completed\nWall time 0.0 seconds\nOutput:\n"
        ),
        call(
            "e2",
            script(art.to_str().unwrap(), "x.html"),
            "Script failed\nWall time 0.0 seconds\nOutput:\n"
        ),
    );
    let found = detect_in(&base, AgentKind::Codex, &text);
    let mut paths: Vec<_> = found.iter().map(|e| e["path"].as_str().unwrap()).collect();
    paths.sort();
    assert_eq!(
        paths,
        ["artifacts/s1/chart.html", "artifacts/s1/old.md"],
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .all(|e| e["tool_id"] == "e1" && e["root"] == "data")
    );
    fs::remove_dir_all(base).unwrap();
}

/// v1b-37: an exec script yields patch headers only from a `tools.apply_patch(` call's Begin/End blocks.
#[test]
fn artifact_exec_cards_need_a_real_patch() {
    let base = scratch("exec-real");
    let art = base.join("home/artifacts/s1");
    let a = art.to_str().unwrap();
    let block =
        |name: &str| format!("*** Begin Patch\\n*** Add File: {a}/{name}\\n+x\\n*** End Patch");
    let call = "tools.apply_patch(patch);";
    let scripts = [
        // header in a console.log, no apply_patch call
        format!("console.log(\"\\n*** Add File: {a}/log.html\\n\");"),
        // header outside Begin/End in a script that calls apply_patch
        format!(
            "console.log(\"\\n*** Add File: {a}/out.html\\n\");\nconst patch = \"{}\";\n{call}",
            block("in1.html")
        ),
        // full block, no call
        format!("const patch = \"{}\";", block("nocall.html")),
        // two blocks, one call
        format!(
            "const p = \"{}\";\nconst q = \"{}\";\n{call}",
            block("two1.html"),
            block("two2.html")
        ),
        // CRLF
        format!(
            "const patch = \"{}\";\n{call}",
            block("crlf.html").replace("\\n", "\\r\\n")
        ),
    ];
    let text: String = scripts
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let id = format!("e{i}");
            format!(
                "{}\n{}\n",
                json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":id,"name":"exec","input":s}}),
                json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":id,"output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"{}"}]}})
            )
        })
        .collect();
    let found = detect_in(&base, AgentKind::Codex, &text);
    let mut paths: Vec<_> = found.iter().map(|e| e["path"].as_str().unwrap()).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "artifacts/s1/crlf.html",
            "artifacts/s1/in1.html",
            "artifacts/s1/two1.html",
            "artifacts/s1/two2.html"
        ],
        "{found:#?}"
    );
    fs::remove_dir_all(base).unwrap();
}
