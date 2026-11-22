//! V2-3a: the handoff builder (pure) and `handoff_preview` (window only). Fixtures are hand-authored event lists.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, chat::handoff, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

fn fixture(name: &str) -> String {
    fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/handoff")
            .join(name),
    )
    .unwrap()
}
fn events(name: &str) -> Vec<Value> {
    serde_json::from_str(&fixture(name)).unwrap()
}
fn user(text: &str) -> Value {
    json!({"kind":"message","role":"user","text":text})
}
fn final_text(turn: usize, text: &str) -> Value {
    json!({"kind":"final_text","turn_id":format!("t{turn}"),"text":text})
}
fn edit(path: &str, added: u64, removed: u64) -> Value {
    json!({"kind":"edit","tool_id":"e","path":path,"added":added,"removed":removed,"hunks":[]})
}
fn build(events: &[Value]) -> handoff::Handoff {
    build_cut(events, false)
}
fn build_cut(events: &[Value], older_cut: bool) -> handoff::Handoff {
    handoff::build(
        events,
        "Claude",
        "abcd1234-0000",
        Path::new("/project"),
        older_cut,
    )
}

#[test]
fn handoff_fixture_claude() {
    let h = handoff::build(
        &events("claude.events.json"),
        "Claude",
        "10000000-0000-4000-8000-000000000001",
        Path::new("/project"),
        false,
    );
    assert_eq!(h.text, fixture("claude.expected.txt"));
    assert_eq!((h.prompts, h.files, h.bytes), (2, 4, h.text.len()));
}

#[test]
fn handoff_fixture_codex() {
    let h = handoff::build(
        &events("codex.events.json"),
        "Codex",
        "019a1b2c-0000-7000-8000-000000000001",
        Path::new("/project"),
        false,
    );
    assert_eq!(h.text, fixture("codex.expected.txt"));
    assert_eq!((h.prompts, h.files), (1, 1));
}

#[test]
fn handoff_cap_8k() {
    let mut ev = vec![];
    for i in 0..40 {
        ev.push(user(&format!("request-{i:02} {}", "r".repeat(400))));
        ev.push(final_text(i, &format!("result-{i:02} {}", "s".repeat(600))));
    }
    for i in 0..3 {
        ev.push(edit(&format!("/project/src/f{i}.rs"), i + 1, 0));
    }
    let h = build(&ev);
    assert!(h.text.len() <= 8192, "{} bytes", h.text.len());
    assert_eq!(h.bytes, h.text.len());
    let requests = h.text.lines().filter(|l| l.contains(". request-")).count();
    let results = h
        .text
        .lines()
        .filter(|l| l.starts_with("- result-"))
        .count();
    assert!(h.text.contains("request-39"), "newest request kept");
    for i in 0..3 {
        assert!(h.text.contains(&format!("src/f{i}.rs +{} −0", i + 1)));
    }
    assert_eq!(h.files, 3);
    assert_eq!(h.prompts, requests);
    // Oldest Results go first, then oldest Requests; the newest of each kept side stays.
    assert!(!h.text.contains("result-00") && results < 40);
    if results > 0 {
        assert!(
            h.text.contains("request-00"),
            "no request dropped while Results remain"
        );
        assert!(h.text.contains("result-39"));
    }
    let left_out = 80 - requests - results;
    assert!(
        h.text
            .contains(&format!("({left_out} earlier items left out)")),
        "{}",
        h.text
    );
}

#[test]
fn handoff_cap_drops_requests_after_results() {
    let ev: Vec<Value> = (0..40)
        .map(|i| user(&format!("request-{i:02} {}", "r".repeat(400))))
        .collect();
    let h = build(&ev);
    assert!(h.text.len() <= 8192);
    assert!(h.text.contains("request-39") && !h.text.contains("request-00"));
    assert!(
        h.text
            .contains(&format!("({} earlier items left out)", 40 - h.prompts))
    );
}

#[test]
fn handoff_since_last_switch() {
    let ev = vec![
        user("before-one"),
        final_text(0, "old result"),
        edit("/project/old.rs", 1, 1),
        json!({"kind":"switch"}),
        user("between"),
        json!({"kind":"switch"}),
        user("after-switch"),
        json!({"kind":"turn","turn_id":"t","state":"completed"}),
    ];
    let h = build(&ev);
    assert_eq!(
        h.text,
        "Handoff from Claude (1 turns, session abcd1234)\n\n## Requests\n1. after-switch\n"
    );
}

#[test]
fn handoff_hangul_boundary() {
    let hangul = "가나다라마바사아자차카타파하".repeat(100);
    let ev = vec![user(&hangul), final_text(0, &hangul)];
    let h = build(&ev);
    let request = h.text.lines().find(|l| l.starts_with("1. ")).unwrap();
    let result = h.text.lines().find(|l| l.starts_with("- ")).unwrap();
    assert_eq!(request[3..].chars().count(), 300);
    assert_eq!(result[2..].chars().count(), 500);
    assert!(request.ends_with('…') && result.ends_with('…'));
    assert!(!h.text.contains('\u{FFFD}'));
    // The 8192-byte cut: one 9000-byte path cannot be dropped whole, so the byte cap lands inside a 3-byte char.
    let h = build(&[edit(&format!("/project/{}", "한".repeat(3000)), 1, 1)]);
    assert!(
        h.text.len() <= 8192 && h.text.len() > 8192 - 4,
        "{}",
        h.text.len()
    );
    assert!(!h.text.contains('\u{FFFD}') && h.text.ends_with('한'));
}

#[test]
fn handoff_files_over_cap_drop_whole_lines_and_say_so() {
    let mut ev: Vec<Value> = (0..300)
        .map(|i| edit(&format!("/project/dir/{i:03}-{}", "한".repeat(20)), 1, 1))
        .collect();
    ev.push(user("keep me"));
    ev.push(json!({"kind":"tool_use","tool_id":"t","name":"TodoWrite","input":{"todos":[{"content":"todo","status":"pending"}]}}));
    let h = build(&ev);
    assert!(h.text.len() <= 8192 && h.bytes == h.text.len());
    assert!(
        h.text.contains("1. keep me") && h.text.contains("299-"),
        "newest file and request kept"
    );
    let kept = h.text.lines().filter(|l| l.starts_with("- dir/")).count();
    assert_eq!(h.files, kept);
    assert!(
        h.text
            .contains(&format!("({} earlier files left out)", 300 - kept))
    );
    assert!(
        !h.text.contains("000-") && h.text.ends_with('\n') && !h.text.contains("## Open todos")
    );
}

#[test]
fn handoff_odd_inputs() {
    let h = build(&[
        edit("", 1, 0),
        edit("/project", 1, 0),
        edit("/project2/a.rs", 1, 0),
        json!({"kind":"tool_use","tool_id":"t","name":"TodoWrite","input":{"todos":[{"content":"keep","status":"pending"}]}}),
        json!({"kind":"tool_use","tool_id":"u","name":"TodoWrite","input":"oops"}),
    ]);
    assert!(
        h.text
            .contains("- /project +1 −0\n- /project2/a.rs +1 −0\n")
    );
    assert_eq!(h.files, 2);
    assert!(h.text.contains("- [ ] keep"));
}

#[test]
fn handoff_empty_sections_left_out() {
    let h = build(&[]);
    assert_eq!(h.text, "Handoff from Claude (0 turns, session abcd1234)\n");
    assert_eq!((h.prompts, h.files, h.bytes), (0, 0, h.text.len()));
    let h = build(&[user("only"), edit("/project/a.rs", 1, 2)]);
    assert!(h.text.contains("## Requests") && h.text.contains("## Files changed"));
    assert!(!h.text.contains("## Results") && !h.text.contains("## Open todos"));
    // Short ids and non-object events never panic.
    let h = handoff::build(
        &[json!(null), json!("x"), json!({})],
        "Codex",
        "ab",
        Path::new("/"),
        false,
    );
    assert_eq!(h.text, "Handoff from Codex (0 turns, session ab)\n");
}

#[test]
fn handoff_is_deterministic_and_offline() {
    let ev = events("claude.events.json");
    assert_eq!(build(&ev).text, build(&ev).text);
    let source =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/chat/handoff.rs"))
            .unwrap();
    for banned in [
        "std::fs",
        "std::net",
        "std::process",
        "process::command",
        "Command",
        "std::env",
        "SystemTime",
    ] {
        assert!(!source.contains(banned), "handoff.rs uses {banned}");
    }
}

/// The quadratic builder as shipped in V2-3a (one full `render` per dropped item), kept as the oracle.
mod reference {
    use serde_json::Value;
    use std::path::Path;

    fn fold(text: &str, max: usize) -> String {
        let line = text.replace(['\r', '\n'], " ");
        let line = line.trim();
        if line.chars().count() <= max {
            return line.into();
        }
        let mut cut: String = line.chars().take(max - 1).collect();
        cut.push('…');
        cut
    }

    pub fn build(events: &[Value], older_cut: bool) -> (String, usize, usize) {
        const CAP: usize = 8192;
        let start = events
            .iter()
            .rposition(|e| e["kind"] == "switch")
            .map_or(0, |i| i + 1);
        let (mut turns, mut todos) = (0, vec![]);
        let (mut requests, mut results) = (vec![], vec![]);
        let mut files: Vec<(String, u64, u64)> = vec![];
        for e in &events[start..] {
            match e["kind"].as_str() {
                Some("message") if e["role"] == "user" => {
                    let line = fold(e["text"].as_str().unwrap_or_default(), 300);
                    if !line.is_empty() {
                        requests.push(line);
                    }
                }
                Some("final_text") => {
                    let line = fold(e["text"].as_str().unwrap_or_default(), 500);
                    if !line.is_empty() {
                        results.push(line);
                    }
                }
                Some("turn")
                    if matches!(e["state"].as_str(), Some("completed" | "interrupted")) =>
                {
                    turns += 1
                }
                Some("edit") => {
                    let raw = e["path"].as_str().unwrap_or_default();
                    if raw.is_empty() {
                        continue;
                    }
                    let path = match Path::new(raw).strip_prefix("/project") {
                        Ok(p) if !p.as_os_str().is_empty() => p.to_str().unwrap_or(raw),
                        _ => raw,
                    }
                    .to_string();
                    let (added, removed) = (
                        e["added"].as_u64().unwrap_or(0),
                        e["removed"].as_u64().unwrap_or(0),
                    );
                    match files.iter_mut().find(|f| f.0 == path) {
                        Some(f) => (f.1, f.2) = (f.1 + added, f.2 + removed),
                        None => files.push((path, added, removed)),
                    }
                }
                Some("tool_use") if e["name"] == "TodoWrite" => {
                    if let Some(list) = e["input"]["todos"].as_array() {
                        todos = list
                            .iter()
                            .filter(|t| t["status"] != "completed")
                            .filter_map(|t| t["content"].as_str())
                            .map(|s| fold(s, 500))
                            .collect();
                    }
                }
                _ => {}
            }
        }
        let files: Vec<String> = files
            .into_iter()
            .map(|(p, a, r)| format!("{p} +{a} −{r}"))
            .collect();
        let mut header =
            "Handoff from Claude (".to_string() + &format!("{turns} turns, session abcd1234)\n");
        if older_cut {
            header += "(earlier history left out)\n";
        }
        let prompts = requests.len();
        let total = requests.len() + results.len();
        let (mut first_request, mut first_result) = (0, 0);
        let mut text = loop {
            let left = total - (requests.len() - first_request) - (results.len() - first_result);
            let text = render(
                &header,
                left,
                &requests[first_request..],
                &results[first_result..],
                (0, &files),
                &todos,
            );
            if text.len() <= CAP {
                break text;
            }
            if first_result < results.len() {
                first_result += 1;
            } else if first_request + 1 < requests.len() {
                first_request += 1;
            } else {
                break text;
            }
        };
        let mut first_file = 0;
        if text.len() > CAP {
            let left = total - (requests.len() - first_request) - (results.len() - first_result);
            loop {
                text = render(
                    &header,
                    left,
                    &requests[first_request..],
                    &results[first_result..],
                    (first_file, &files),
                    &[],
                );
                if text.len() <= CAP || first_file + 1 >= files.len() {
                    break;
                }
                first_file += 1;
            }
        }
        if text.len() > CAP {
            let mut end = CAP;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        (text, prompts - first_request, files.len() - first_file)
    }

    fn render(
        header: &str,
        left_out: usize,
        requests: &[String],
        results: &[String],
        (files_left_out, files): (usize, &[String]),
        todos: &[String],
    ) -> String {
        let mut text = header.to_string();
        if left_out > 0 {
            text += &format!("\n({left_out} earlier items left out)\n");
        }
        let mut section = |title: &str, lines: Vec<String>| {
            if !lines.is_empty() {
                text += &format!("\n## {title}\n{}\n", lines.join("\n"));
            }
        };
        section(
            "Requests",
            requests
                .iter()
                .enumerate()
                .map(|(i, r)| format!("{}. {r}", i + 1))
                .collect(),
        );
        section(
            "Results",
            results.iter().map(|r| format!("- {r}")).collect(),
        );
        let mut lines: Vec<String> = files[files_left_out..]
            .iter()
            .map(|f| format!("- {f}"))
            .collect();
        if files_left_out > 0 {
            lines.insert(0, format!("({files_left_out} earlier files left out)"));
        }
        section("Files changed", lines);
        section(
            "Open todos",
            todos.iter().map(|t| format!("- [ ] {t}")).collect(),
        );
        text
    }
}

fn todo(n: usize, len: usize) -> Value {
    json!({"kind":"tool_use","tool_id":"t","name":"TodoWrite","input":{"todos":
        (0..n).map(|i| json!({"content":"t".repeat(len + i),"status":"pending"})).collect::<Vec<_>>()}})
}

fn same_as_reference(ev: &[Value], older_cut: bool, what: &str) {
    let h = build_cut(ev, older_cut);
    let (text, prompts, files) = reference::build(ev, older_cut);
    assert_eq!(h.text, text, "{what}");
    assert_eq!(
        (h.prompts, h.files, h.bytes),
        (prompts, files, text.len()),
        "{what}"
    );
}

#[test]
fn handoff_output_unchanged_by_linear_drop() {
    // Deterministic generator (xorshift); item counts 0-60, ASCII and Hangul, short and over-long lines.
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move |n: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % n as u64) as usize
    };
    let mut dropped = 0;
    for case in 0..300 {
        let mut ev = vec![];
        let sections = [next(61), next(61), next(61)];
        for i in 0..sections[0] {
            let unit = if next(2) == 0 { "r" } else { "한" };
            ev.push(user(&format!("q{i} {}", unit.repeat(next(500)))));
        }
        for i in 0..sections[1] {
            let unit = if next(2) == 0 { "s" } else { "결" };
            ev.push(final_text(i, &format!("a{i} {}", unit.repeat(next(700)))));
        }
        for i in 0..sections[2] {
            // A path seen twice keeps its first position and sums its counts.
            let name = format!("/project/d/{}{}", next(40), "파".repeat(next(30)));
            ev.push(edit(&name, i as u64, 1));
            ev.push(edit(&name, 1, i as u64));
        }
        if next(2) == 0 {
            ev.push(todo(next(6), next(200)));
        }
        if next(5) == 0 {
            ev.insert(next(ev.len() + 1), json!({"kind":"switch"}));
        }
        let cut = next(3) == 0;
        dropped += usize::from(build_cut(&ev, cut).text.contains("left out)"));
        same_as_reference(&ev, cut, &format!("case {case}"));
    }
    assert!(
        dropped > 50,
        "the sweep must exercise the drop paths, {dropped}"
    );
    // The fixtures that pin the files-over-cap and todo paths.
    let long_files: Vec<Value> = (0..300)
        .map(|i| edit(&format!("/project/dir/{i:03}-{}", "한".repeat(20)), 1, 1))
        .chain([user("keep me"), todo(2, 10)])
        .collect();
    same_as_reference(&long_files, false, "files over cap");
    same_as_reference(
        &[edit(&format!("/project/{}", "한".repeat(3000)), 1, 1)],
        true,
        "one huge path",
    );
}

#[test]
fn handoff_drop_is_linear_on_long_transcript() {
    let mut ev = vec![];
    for i in 0..20_000 {
        ev.push(user(&format!("q{i} {}", "r".repeat(400))));
        ev.push(final_text(i, &format!("a{i} {}", "s".repeat(600))));
    }
    for i in 0..5_000 {
        ev.push(edit(&format!("/project/src/module-{i}/file.rs"), 1, 1));
    }
    let small: Vec<Value> = ev[..400]
        .iter()
        .chain(&ev[40_000..40_200])
        .cloned()
        .collect();
    same_as_reference(&small, false, "200-item input");
    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || tx.send(build(&ev)).unwrap());
    // 25 s: about 10x the linear build's debug time (~2 s, headroom for a loaded merge gate) and a fifth of the quadratic loop's extrapolated >130 s.
    let h = rx
        .recv_timeout(Duration::from_secs(25))
        .unwrap_or_else(|_| panic!("build still running after {:?}", started.elapsed()));
    assert!(h.text.len() <= 8192 && h.text.contains("q19999"));
    assert!(h.text.contains("earlier items left out"));
}

#[test]
fn page_cap_marks_left_out() {
    let ev: Vec<Value> = (0..40)
        .map(|i| user(&format!("request-{i:02} {}", "r".repeat(400))))
        .collect();
    let with = build_cut(&ev, true);
    let without = build(&ev);
    assert!(with.text.len() <= 8192 && with.bytes == with.text.len());
    assert!(
        with.text.starts_with(
            "Handoff from Claude (0 turns, session abcd1234)\n(earlier history left out)\n"
        ),
        "{}",
        with.text
    );
    assert!(with.text.contains("1. ") && with.text.contains("request-39"));
    // The marker is counted inside the cap: the same input drops at least as many requests.
    assert!(with.prompts <= without.prompts);
    // A short chat keeps its bytes when nothing was cut.
    let short = [user("only")];
    assert_eq!(
        build_cut(&short, false).text,
        "Handoff from Claude (0 turns, session abcd1234)\n\n## Requests\n1. only\n"
    );
    assert_eq!(
        build_cut(&short, true).text,
        "Handoff from Claude (0 turns, session abcd1234)\n(earlier history left out)\n\n## Requests\n1. only\n"
    );
    // The page walk: 101 pages and no switch is cut at 100; a switch or the start inside the cap is not.
    let page = |generation: u64, before: Option<u64>, kind: &str| nunchiro_core::chat::Page {
        generation,
        schema_version: 1,
        banner: None,
        no_transcript: None,
        skipped: 0,
        events: vec![nunchiro_core::chat::Event {
            schema_version: 1,
            cursor: 1,
            data: json!({"kind":kind,"role":"user","text":"x"}),
        }],
        before,
        end: 0,
    };
    let mut reads = 0;
    let (events, cut) = handoff::collect(|_, _| {
        reads += 1;
        Ok(page(1, Some(5), "message"))
    })
    .unwrap();
    assert_eq!((reads, events.len(), cut), (100, 100, true));
    let mut reads = 0;
    let (_, cut) = handoff::collect(|_, _| {
        reads += 1;
        Ok(page(1, (reads < 100).then_some(5), "message"))
    })
    .unwrap();
    assert!(!cut, "the 100th page reached the start");
    let (events, cut) = handoff::collect(|_, _| Ok(page(1, Some(5), "switch"))).unwrap();
    assert_eq!((events.len(), cut), (1, false));
}

#[test]
fn pages_read_with_generation() {
    let page = |generation: u64, before: Option<u64>, text: &str| nunchiro_core::chat::Page {
        generation,
        schema_version: 1,
        banner: None,
        no_transcript: None,
        skipped: 0,
        events: vec![nunchiro_core::chat::Event {
            schema_version: 1,
            cursor: 1,
            data: json!({"kind":"message","role":"user","text":text}),
        }],
        before,
        end: 0,
    };
    // Stable chat: the first page learns the generation, every later call carries it.
    let mut seen = vec![];
    let (events, cut) = handoff::collect(|before, generation| {
        seen.push((before, generation));
        Ok(match before {
            None => page(3, Some(2), "new"),
            Some(2) => page(3, Some(1), "mid"),
            _ => page(3, None, "old"),
        })
    })
    .unwrap();
    assert_eq!(seen, [(None, None), (Some(2), Some(3)), (Some(1), Some(3))]);
    let texts: Vec<_> = events.iter().map(|e| e["text"].as_str().unwrap()).collect();
    assert_eq!((texts, cut), (vec!["old", "mid", "new"], false));
    // A reset between two pages: the walk restarts on the new generation and no old event survives.
    let mut calls = 0;
    let mut seen = vec![];
    let (events, _) = handoff::collect(|before, generation| {
        calls += 1;
        seen.push(generation);
        Ok(match (calls, before) {
            (1, _) => page(1, Some(9), "gen1-new"),
            (2, _) => page(2, Some(9), "gen2-new"),
            (_, None) => page(2, Some(9), "gen2-new"),
            _ => page(2, None, "gen2-old"),
        })
    })
    .unwrap();
    let texts: Vec<_> = events.iter().map(|e| e["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["gen2-old", "gen2-new"]);
    assert_eq!(seen, [None, Some(1), Some(2), Some(2)]);
    // A second reset is an error, never a mix.
    let mut generation = 0;
    let err = handoff::collect(|_, _| {
        generation += 1;
        Ok(page(generation, Some(9), "x"))
    })
    .unwrap_err();
    assert_eq!(err, "chat changed while reading");
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("handoff");
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake, b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"2.1.310 (Claude Code)\"; exit; fi\nexec /bin/cat\n").unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
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
    fn start(&self, kind: AgentKind, args: Vec<String>) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.join("cwd"),
                    worktree: false,
                    label: "handoff".into(),
                    args,
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            _ => panic!(),
        }
    }
    fn transcript(&self, s: &Session, body: &str) {
        let encoded: String = s
            .cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = self.home.join("agent/projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
        fs::write(&path, body).unwrap();
        call(
            &self.home,
            Request::Hook {
                id: s.id.clone(),
                event: "SessionStart".into(),
                payload: json!({"session_id":s.agent_session_id,"transcript_path":path}),
            },
        )
        .unwrap();
    }
    // v1a-80c: failure-detection deadlines (60 s); a handoff reads up to 100 pages and took over 5 s on a loaded host.
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
            .set_read_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(60);
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
fn handoff_preview_owner_only() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    let line = |text: &str| json!({"type":"user","message":{"content":text}}).to_string() + "\n";
    core.transcript(&s, &(line("hello handoff") + &line("second ask")));
    let reply = core.window(json!({"op":"handoff_preview","id":s.id}));
    let ok = &reply["Ok"];
    let short = &s.id[..8];
    let text = ok["text"].as_str().unwrap_or_else(|| panic!("{reply}"));
    assert!(text.starts_with(&format!("Handoff from Claude (0 turns, session {short})\n")));
    assert!(text.contains("1. hello handoff\n2. second ask\n"), "{text}");
    assert_eq!(
        (ok["prompts"].as_u64(), ok["files"].as_u64()),
        (Some(2), Some(0))
    );
    assert_eq!(ok["bytes"].as_u64(), Some(text.len() as u64));
    assert!(core.window(json!({"op":"handoff_preview","id":"missing"}))["Err"].is_string());

    // A session agent holds a token, not the window's: refused.
    let agent = core.start(
        AgentKind::Shell,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
        ],
    );
    let until = Instant::now() + Duration::from_secs(5);
    let token = loop {
        let Reply::Output { data, .. } = call(
            &core.home,
            Request::Read {
                id: agent.id.clone(),
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
            break l.trim().to_string();
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    };
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(
        sock,
        "{}",
        json!({"token":token,"request":{"op":"handoff_preview","id":s.id}})
    )
    .unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    call(&core.home, Request::Close { id: agent.id }).unwrap();
}

#[test]
fn page_cap_marks_left_out_through_core() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    // 20 600 events with no switch: more than the 100 pages (200 events each) a handoff reads.
    let body: String = (0..20_600)
        .map(|i| json!({"type":"user","message":{"content":format!("ask {i}")}}).to_string() + "\n")
        .collect();
    core.transcript(&s, &body);
    let reply = core.window(json!({"op":"handoff_preview","id":s.id}));
    let text = reply["Ok"]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{reply}"));
    let short = &s.id[..8];
    assert!(
        text.starts_with(&format!(
            "Handoff from Claude (0 turns, session {short})\n(earlier history left out)\n"
        )),
        "{text}"
    );
    assert!(text.len() <= 8192 && text.contains("ask 20599"), "{text}");
}

// V2-3b: what goes to the target agent: redacted, and no control characters but newline and tab.
#[test]
fn handoff_text_is_redacted_before_send() {
    let events = vec![
        json!({"kind":"message","role":"user","text":"use key=sk-0123456789abcdefghij please"}),
        json!({"kind":"final_text","text":"done with sk-0123456789abcdefghij"}),
    ];
    let h = build(&events);
    assert!(
        h.text.contains("sk-0123456789abcdefghij"),
        "the builder keeps the transcript as is"
    );
    let sent = handoff::outgoing(&(h.text + "\n\tnext\x1b[2J ask\x07\r\u{9b}"));
    assert!(!sent.contains("sk-0123456789abcdefghij"), "{sent}");
    assert!(sent.contains("[redacted:openai]"), "{sent}");
    assert!(sent.ends_with("\n\tnext[2J ask"), "{sent:?}");
}

#[test]
fn fork_handoff_stops_at_message() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    let body: String = (1..=5)
        .map(|i| {
            json!({"type":"user","message":{"content":format!("fork-message-{i}")}}).to_string()
                + "\n"
        })
        .collect();
    core.transcript(&s, &body);
    let page = core.window(json!({"op":"chat_page","id":s.id}));
    let cursor = page["Ok"]["page"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["data"]["text"] == "fork-message-3")
        .unwrap()["cursor"]
        .as_u64()
        .unwrap();
    let cut = core.window(json!({"op":"handoff_preview","id":s.id,"through":format!("{}:{cursor}", page["Ok"]["page"]["generation"])}));
    let text = cut["Ok"]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{cut}"));
    for i in 1..=3 {
        assert!(text.contains(&format!("fork-message-{i}")), "{text}");
    }
    for i in 4..=5 {
        assert!(!text.contains(&format!("fork-message-{i}")), "{text}");
    }
    let all = core.window(json!({"op":"handoff_preview","id":s.id}));
    for i in 1..=5 {
        assert!(
            all["Ok"]["text"]
                .as_str()
                .unwrap()
                .contains(&format!("fork-message-{i}"))
        );
    }
    for through in [
        "missing".to_string(),
        format!("{}:{}", page["Ok"]["page"]["generation"], cursor + 100_000),
    ] {
        assert!(
            core.window(json!({"op":"handoff_preview","id":s.id,"through":through}))["Err"]
                .is_string()
        );
    }
}

#[test]
fn fork_includes_assistant_message_at_cutoff() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    let body = [
        json!({"type":"user","uuid":"u1","message":{"content":"earlier-user"}}),
        json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"selected-assistant"}]}}),
        json!({"type":"user","uuid":"u2","message":{"content":"later-user"}}),
    ].iter().map(|v| v.to_string() + "\n").collect::<String>();
    core.transcript(&s, &body);
    let page = core.window(json!({"op":"chat_page","id":s.id}));
    let cursor = page["Ok"]["page"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["data"]["text"] == "selected-assistant")
        .unwrap()["cursor"]
        .as_u64()
        .unwrap();
    let reply = core.window(json!({"op":"handoff_preview","id":s.id,"through":format!("{}:{cursor}", page["Ok"]["page"]["generation"])}));
    let text = reply["Ok"]["text"].as_str().unwrap();
    assert!(
        text.contains("earlier-user") && text.contains("selected-assistant"),
        "{text}"
    );
    assert!(!text.contains("later-user"));
}

#[test]
fn fork_cutoff_pages_and_stale_message_fail_closed() {
    let page = |generation, before, events: Vec<(u64, Value)>| nunchiro_core::chat::Page {
        generation,
        schema_version: 1,
        banner: None,
        no_transcript: None,
        skipped: 0,
        events: events
            .into_iter()
            .map(|(cursor, data)| nunchiro_core::chat::Event {
                schema_version: 1,
                cursor,
                data,
            })
            .collect(),
        before,
        end: 9,
    };
    let mut seen = vec![];
    let (events, cut) = handoff::collect_through(Some("7:3"), |before, generation| {
        seen.push((before, generation));
        Ok(match before {
            None => page(
                7,
                Some(5),
                vec![(6, json!({"kind":"switch"})), (7, user("later"))],
            ),
            Some(5) => page(
                7,
                Some(2),
                vec![(3, user("selected")), (4, user("excluded"))],
            ),
            _ => page(7, None, vec![(1, user("earlier"))]),
        })
    })
    .unwrap();
    assert_eq!(seen, [(None, None), (Some(5), Some(7)), (Some(2), Some(7))]);
    assert_eq!(events, [user("earlier"), user("selected")]);
    assert!(!cut);
    for through in ["bad", "7:99", "7:2", "6:1"] {
        assert!(
            handoff::collect_through(Some(through), |_, _| Ok(page(
                7,
                None,
                vec![(1, user("one")), (2, json!({"kind":"switch"}))]
            )))
            .is_err(),
            "{through}"
        );
    }
    let mut calls = 0;
    assert!(
        handoff::collect_through(Some("7:3"), |_, _| {
            calls += 1;
            Ok(page(
                if calls == 1 { 7 } else { 8 },
                Some(2),
                vec![(3, user("selected"))],
            ))
        })
        .is_err()
    );
}

#[test]
fn fork_preview_matches_handoff_outgoing() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    let body =
        json!({"type":"user","message":{"content":"use sk-0123456789\u{7}abcdefghij and \x1b[31msk-0123456789abcdefghij\x1b[0m please"}})
            .to_string()
            + "\n";
    core.transcript(&s, &body);
    let page = core.window(json!({"op":"chat_page","id":s.id}));
    let cursor = page["Ok"]["page"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["data"]["kind"] == "message")
        .unwrap()["cursor"]
        .as_u64()
        .unwrap();
    let reply = core.window(json!({"op":"handoff_preview","id":s.id,"through":format!("{}:{cursor}", page["Ok"]["page"]["generation"])}));
    let text = reply["Ok"]["text"].as_str().unwrap();
    assert!(
        !text.contains("sk-0123456789"),
        "preview leaked a known secret"
    );
    assert_eq!(
        text,
        handoff::outgoing(text),
        "Round 2 requires fork preview to match handoff_send outgoing text"
    );
}

#[test]
fn outgoing_redacts_a_secret_split_by_a_control() {
    let text = "use sk-0123456789\u{7}abcdefghij please\n\tkeep layout\x1b[2J";
    let outgoing = handoff::outgoing(text);
    assert_eq!(outgoing, "use [redacted:openai] please\n\tkeep layout[2J");
    assert_eq!(handoff::outgoing(&outgoing), outgoing);
}

#[test]
fn outgoing_redacts_an_ansi_coloured_secret() {
    let outgoing = handoff::outgoing("\x1b[31msk-0123456789abcdefghij\x1b[0m");
    assert!(!outgoing.contains("sk-0123456789"));
    assert!(outgoing.contains("[redacted:openai]"));
    assert!(!outgoing.contains('\x1b'));
    assert_eq!(handoff::outgoing(&outgoing), outgoing);
}
