use super::*;

fn home() -> PathBuf {
    let home = std::env::temp_dir().join(format!("nunchiro-recall-{}", store::new_id().unwrap()));
    fs::create_dir_all(&home).unwrap();
    fs::canonicalize(home).unwrap()
}
fn user(text: &str, at: &str) -> String {
    serde_json::json!({"type":"user","timestamp":at,"message":{"role":"user","content":text}})
        .to_string()
        + "\n"
}
fn assistant(text: &str, at: &str) -> String {
    serde_json::json!({"type":"assistant","timestamp":at,
        "message":{"role":"assistant","content":[{"type":"text","text":text}]}})
    .to_string()
        + "\n"
}
fn source(home: &Path, id: &str, body: &str) -> Source {
    let path = home.join(format!("{id}-transcript.jsonl"));
    fs::write(&path, body).unwrap();
    Source {
        id: id.into(),
        kind: AgentKind::Claude,
        label: "Acme invoices".into(),
        path,
    }
}
fn append(s: &Source, body: &str) {
    let mut f = OpenOptions::new().append(true).open(&s.path).unwrap();
    std::io::Write::write_all(&mut f, body.as_bytes()).unwrap();
}

#[test]
fn index_masks_secrets_and_finds_newest_first() {
    let home = home();
    let a = source(
        &home,
        "s1",
        &(user("What format for Acme invoices?", "2026-11-12T14:00:00Z")
            + &assistant(
                "PDF, PO number in the file name. OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234",
                "2026-11-12T14:05:00Z",
            )),
    );
    refresh(&home, &[a], 7).unwrap();
    let stored = fs::read_to_string(home.join(DIR).join("s1.jsonl")).unwrap();
    assert!(!stored.contains("sk-proj-abcdefghijklmnop1234"), "{stored}");
    let (hits, total) = find(&home, "acme").unwrap();
    assert_eq!(total, 1, "only the user's line holds Acme");
    assert_eq!(hits[0].role, "user");
    let (hits, _) = find(&home, "po number").unwrap();
    assert_eq!(hits[0].at, "2026-11-12T14:05:00Z");
    assert!(hits[0].text.contains("[redacted"), "{}", hits[0].text);
    assert_eq!(
        status(&home, true),
        Status {
            on: true,
            conversations: 1,
            bytes: stored.len() as u64,
            updated_ms: 7
        }
    );
}

#[test]
fn refresh_reads_only_what_changed() {
    let home = home();
    let a = source(&home, "s1", &user("first words", "2026-11-01T00:00:00Z"));
    refresh(&home, std::slice::from_ref(&a), 1).unwrap();
    // A transcript that did not change is not read again: the index file is left as it is.
    let file = home.join(DIR).join("s1.jsonl");
    fs::write(&file, "").unwrap();
    refresh(&home, std::slice::from_ref(&a), 2).unwrap();
    assert_eq!(find(&home, "first").unwrap().1, 0);
    let rebuilt = serde_json::to_string(&Line {
        at: "2026-11-01T00:00:00Z".into(),
        role: "user".into(),
        text: "first words".into(),
    })
    .unwrap();
    fs::write(&file, rebuilt + "\n").unwrap();
    // Appended lines are read from where the last refresh stopped; a half-written last line waits.
    append(
        &a,
        &(user("second words", "2026-11-02T00:00:00Z") + "{\"type\":\"us"),
    );
    refresh(&home, std::slice::from_ref(&a), 3).unwrap();
    assert_eq!(find(&home, "words").unwrap().1, 2);
    append(&a, "er\"}\n");
    refresh(&home, std::slice::from_ref(&a), 4).unwrap();
    assert_eq!(find(&home, "words").unwrap().1, 2, "no line twice");
    // A conversation no longer listed leaves the index.
    refresh(&home, &[], 5).unwrap();
    assert!(!file.exists());
    assert_eq!(status(&home, true).conversations, 0);
}

#[test]
fn forget_removes_lines_and_keeps_them_out() {
    let home = home();
    let a = source(
        &home,
        "s1",
        &(user("Dana prefers short mails", "2026-11-01T00:00:00Z")
            + &user("other words", "2026-11-01T00:01:00Z")),
    );
    refresh(&home, std::slice::from_ref(&a), 1).unwrap();
    forget(&home, "dana PREFERS short mails").unwrap();
    assert_eq!(find(&home, "dana").unwrap().1, 0);
    assert_eq!(find(&home, "other").unwrap().1, 1);
    // A transcript read again from the start (it shrank) keeps the forgotten line out.
    fs::write(
        &a.path,
        user("Dana prefers short mails", "2026-11-01T00:00:00Z"),
    )
    .unwrap();
    refresh(&home, std::slice::from_ref(&a), 2).unwrap();
    assert_eq!(find(&home, "dana").unwrap().1, 0);
    let all = fs::read_to_string(home.join(DIR).join(FORGOTTEN)).unwrap();
    assert!(!all.to_lowercase().contains("dana"), "only hashes are kept");
}

#[test]
fn clear_deletes_the_index() {
    let home = home();
    let a = source(&home, "s1", &user("words", "2026-11-01T00:00:00Z"));
    refresh(&home, &[a], 1).unwrap();
    clear(&home).unwrap();
    assert!(!home.join(DIR).exists());
    assert_eq!(status(&home, false), Status::default());
    clear(&home).unwrap();
}
