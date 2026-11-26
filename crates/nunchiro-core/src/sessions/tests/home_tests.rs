//! Text left in the terminal comes home (home.rs): one row of the owner's words, Type in terminal off, no key for
//! `TYPING_QUIET`: on disk first, then three Ctrl+U, then the composer gets them and the waiting prompt goes.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn boxed(text: &str) -> String {
    format!(
        "\x1b[?2004h\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} {text}\r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    )
}
const WORDS: &str = "half typed words";
/// A Claude seat whose box shows `first`; once the file `cleared` exists it draws an empty box (as Ctrl+U does).
fn seat(name: &str, first: &str) -> Flood {
    let empty = boxed("");
    let mut f = flood_script(
        name,
        b"",
        &format!(
            "printf '{}'\ncat > got <&0 &\nj=0; while [ ! -f cleared ] && [ $j -lt 6000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            first.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            empty.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
        ),
    );
    wait_end(&f, first.len());
    catch_up(&mut f);
    f.core.tick().unwrap();
    f
}
fn prompt(f: &mut Flood, text: &str) -> crate::delivery::Send {
    match f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: text.into(),
    }) {
        Ok(Reply::Delivery { send }) => send,
        other => panic!("{other:?}"),
    }
}
/// Delivery passes over a still screen, past the settle time.
fn passes(f: &mut Flood) {
    for _ in 0..3 {
        f.core.flush_delivery().unwrap();
        std::thread::sleep(SWITCH_SETTLE + std::time::Duration::from_millis(20));
    }
}
fn aside(f: &Flood) -> PathBuf {
    f.home.join("aside").join(format!("{}.json", f.id))
}
fn draft_home(f: &mut Flood) -> Option<crate::api::DraftHome> {
    let Ok(Reply::Agent { session }) = f.core.handle(Request::AgentGet { id: f.id.clone() }) else {
        panic!("no session")
    };
    session.draft_home
}
fn cleared(f: &mut Flood) {
    fs::write(f.home.join("cleared"), "").unwrap();
    let id = f.id.clone();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !f.core.box_empty(&id) {
        assert!(
            std::time::Instant::now() < until,
            "the empty box never drew"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
        f.core.observe().unwrap();
    }
}

#[test]
fn one_line_of_owner_text_comes_home_before_a_prompt_goes() {
    let mut f = seat("home-one", &boxed(WORDS));
    let mine = prompt(&mut f, "my prompt");
    assert_eq!(mine.status, "queued");
    passes(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15", "three Ctrl+U, nothing else yet");
    let kept: crate::api::DraftHome =
        serde_json::from_slice(&fs::read(aside(&f)).unwrap()).unwrap();
    assert_eq!(kept.words, WORDS);
    assert_eq!(
        fs::metadata(aside(&f)).unwrap().permissions().mode() & 0o777,
        0o600
    );
    cleared(&mut f);
    passes(&mut f);
    enter_1085(&mut f);
    assert_eq!(
        String::from_utf8_lossy(&got(&f)),
        String::from_utf8_lossy(
            &[
                b"\x15\x15\x15".to_vec(),
                paste_1085("my prompt"),
                b"\r".to_vec()
            ]
            .concat()
        )
    );
    assert!(
        !String::from_utf8_lossy(&got(&f)).contains(WORDS),
        "the core never typed his words"
    );
    assert_eq!(draft_home(&mut f).map(|d| d.words).as_deref(), Some(WORDS));
    // An answer to an older hand-over changes nothing; the composer's answer to this one removes the side file.
    let at = draft_home(&mut f).unwrap().at;
    f.core
        .handle(Request::DraftTaken {
            id: f.id.clone(),
            at: at - 1,
        })
        .unwrap();
    assert!(aside(&f).exists());
    f.core
        .handle(Request::DraftTaken {
            id: f.id.clone(),
            at,
        })
        .unwrap();
    assert!(!aside(&f).exists());
    assert_eq!(draft_home(&mut f), None);
}

#[test]
fn a_second_row_or_a_collapsed_label_is_never_touched() {
    let two = format!(
        "\x1b[?2004h\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} line one\r\n  line two\r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    );
    for (i, screen) in [two, boxed("[Pasted text #1 +20 lines]")]
        .into_iter()
        .enumerate()
    {
        let mut f = seat(&format!("home-never-{i}"), &screen);
        let mine = prompt(&mut f, "my prompt");
        passes(&mut f);
        assert_eq!(got(&f), b"", "{i}: not a byte");
        assert!(!aside(&f).exists());
        assert_eq!(send_row(&f, &mine.id).status, "queued");
    }
}

#[test]
fn not_while_he_typed_in_the_last_five_seconds() {
    let mut f = seat("home-typing", &boxed(WORDS));
    f.core.handle(Request::Typing { id: f.id.clone() }).unwrap();
    prompt(&mut f, "my prompt");
    passes(&mut f);
    assert_eq!(got(&f), b"", "he typed a moment ago");
    let id = f.id.clone();
    *f.core.typing_until.get_mut(&id).unwrap() = std::time::Instant::now();
    passes(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15");
}

#[test]
fn not_while_type_in_terminal_is_on() {
    let mut f = seat("home-direct", &boxed(WORDS));
    let direct = |f: &mut Flood, on: bool| {
        f.core
            .handle(Request::Direct {
                id: f.id.clone(),
                on,
            })
            .unwrap()
    };
    direct(&mut f, true);
    prompt(&mut f, "my prompt");
    passes(&mut f);
    assert_eq!(got(&f), b"", "he types in the agent's box");
    // Done: what he left there comes home.
    direct(&mut f, false);
    passes(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15");
}

#[test]
fn a_box_that_stays_full_gets_no_paste() {
    let mut f = seat("home-stuck", &boxed(WORDS));
    let mine = prompt(&mut f, "my prompt");
    passes(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15");
    let id = f.id.clone();
    // The box never redraws: past the wait for the clear, nothing more is written; the side copy stays a while (a late
    // clear still brings the words home), then goes: the box has them.
    std::thread::sleep(home::CLEAR_SHOWS);
    passes(&mut f);
    passes(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15", "no second clear, no paste");
    assert!(aside(&f).exists(), "kept a while");
    f.core.homing.get_mut(&id).unwrap().at -= home::KEEP_STUCK;
    passes(&mut f);
    assert!(!aside(&f).exists(), "the words are still in the box");
    assert_eq!(send_row(&f, &mine.id).status, "queued");
    assert_eq!(draft_home(&mut f), None);
    assert!(f.core.homing.contains_key(&id));
}

#[test]
fn the_file_survives_a_restart() {
    let mut f = seat("home-restart", &boxed(""));
    let dir = f.home.join("aside");
    fs::create_dir_all(&dir).unwrap();
    let kept = crate::api::DraftHome {
        words: WORDS.into(),
        at: 7,
    };
    fs::write(aside(&f), serde_json::to_vec(&kept).unwrap()).unwrap();
    fs::write(
        dir.join("gone-session.json"),
        serde_json::to_vec(&kept).unwrap(),
    )
    .unwrap();
    // As `Sessions::open` reads them: this session's words come back, a closed session's file goes.
    f.core.drafts_home = home::load_aside(&f.home);
    f.core.drop_orphan_asides();
    assert_eq!(draft_home(&mut f), Some(kept));
    assert!(!dir.join("gone-session.json").exists());
}

#[test]
fn draft_put_back_pastes_into_an_empty_box_only() {
    let mut f = seat("home-back", &boxed(WORDS));
    let back = |f: &mut Flood| {
        f.core.handle(Request::DraftPutBack {
            id: f.id.clone(),
            words: WORDS.into(),
        })
    };
    assert!(back(&mut f).is_err(), "the box holds words");
    cleared(&mut f);
    back(&mut f).unwrap();
    assert_eq!(got(&f), paste_1085(WORDS), "the words, no Enter");
}

#[test]
fn words_no_window_took_stay_in_front() {
    let mut f = seat("home-merge", &boxed(WORDS));
    let id = f.id.clone();
    f.core.drafts_home.insert(
        id.clone(),
        crate::api::DraftHome {
            words: "earlier words".into(),
            at: 1,
        },
    );
    prompt(&mut f, "my prompt");
    passes(&mut f);
    cleared(&mut f);
    passes(&mut f);
    assert_eq!(
        draft_home(&mut f).map(|d| d.words).as_deref(),
        Some("earlier words\nhalf typed words")
    );
}
