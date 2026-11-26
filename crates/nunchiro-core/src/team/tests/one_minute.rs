//! A bot in one minute: made from a name and one sentence, its first chat writes its SOUL file, a bot offers a new
//! bot on a card, and the owner hands a worktree to a bot. Every request goes in as the window and the CLI send it.
//! Data safety first: nothing here may change the shape of a file an earlier build reads.
use super::*;
use serde_json::{Value, json};

type Reg = std::sync::Mutex<crate::sessions::Sessions>;

/// A window op, and its reply as the window reads it.
fn ask(reg: &Reg, home: &Path, op: Value) -> Result<Value, String> {
    let op: Op = serde_json::from_value(op).map_err(|e| e.to_string())?;
    window(reg, home, op).map(|reply| serde_json::to_value(reply).unwrap())
}
fn made(reply: &Value) -> String {
    reply["made"]
        .as_str()
        .expect("the new bot's id")
        .to_string()
}
fn bot<'a>(reply: &'a Value, id: &str) -> &'a Value {
    reply["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == id)
        .expect("the bot is in the roster")
}
fn keys(v: &Value) -> Vec<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
}
const JOB: &str = "Writes release notes from what landed this week.";
const FIRST: &str = "## Your first chat";
const READY: &str = "says you are ready";

#[test]
fn a_bot_is_made_in_one_step_and_an_earlier_build_still_reads_every_file() {
    let home = home();
    let reg = std::sync::Mutex::new(crate::sessions::Sessions::open(&home).unwrap());
    let face = json!({"shape": "cat", "tile": "peach"});
    let reply = ask(
        &reg,
        &home,
        json!({"op": "bot_new", "name": "  Bom ", "job": JOB, "face": face}),
    )
    .unwrap();
    let id = made(&reply);
    let bom = bot(&reply, &id);
    assert_eq!(
        (&bom["name"], &bom["job"], &bom["face"]),
        (&json!("Bom"), &json!(JOB), &face)
    );
    assert_eq!(
        (&bom["seat"], &bom["agent"], &bom["model"]),
        (
            &json!({"kind": "none"}),
            &json!("claude"),
            &json!({"rule": "follow"})
        ),
        "no seat is asked at the start, and the agent's newest model is followed"
    );
    let team = Team::open(&home);
    assert_eq!(
        fs::read_to_string(team.soul(&id)).unwrap(),
        format!("{JOB}\n")
    );
    assert!(home.join("team").join(&id).join("first.json").is_file());
    // The files earlier builds read keep their shapes: `team.json` holds the bot as a plain teammate, and `bots.json`
    // has no field the build before this one would refuse.
    let v1: Value =
        serde_json::from_slice(&fs::read(home.join("team/team.json")).unwrap()).unwrap();
    assert_eq!(keys(&v1), ["teammates", "version"]);
    assert_eq!(keys(&v1["teammates"][0]), ["id", "job", "kind", "name"]);
    assert_eq!(v1["teammates"][0]["id"], id.as_str());
    let stored: Value =
        serde_json::from_slice(&fs::read(home.join("team/bots.json")).unwrap()).unwrap();
    assert_eq!(keys(&stored), ["bots", "version"]);
    assert_eq!(stored["version"], 1);
    assert_eq!(
        keys(&stored["bots"][0]),
        ["agent", "face", "id", "job", "model", "name", "seat"]
    );
    // A face another bot has is not given twice; a face that is none of the 36 is refused and makes nothing.
    let second = ask(
        &reg,
        &home,
        json!({"op": "bot_new", "name": "Ori", "job": "Reviews every change.", "face": face}),
    )
    .unwrap();
    assert_ne!(bot(&second, &made(&second))["face"], face);
    for (op, why) in [
        (
            json!({"op": "bot_new", "name": "Nuni", "job": "x", "face": {"shape": "dragon", "tile": "peach"}}),
            "a face is",
        ),
        (
            json!({"op": "bot_new", "name": "Nuni", "job": "x", "seat": "owner"}),
            "lead or chief",
        ),
        (
            json!({"op": "bot_new", "name": "bom", "job": "x"}),
            "already exists",
        ),
        (json!({"op": "bot_new", "name": "Nuni", "job": " "}), "job"),
    ] {
        let refused = ask(&reg, &home, op).unwrap_err();
        assert!(refused.contains(why), "{refused}");
    }
    assert_eq!(team.list().unwrap().len(), 2, "a refusal makes no bot");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_first_chat_writes_the_soul_and_the_owner_reads_edits_and_undoes_it() {
    let home = home();
    let reg = std::sync::Mutex::new(crate::sessions::Sessions::open(&home).unwrap());
    let team = Team::open(&home);
    let id = made(
        &ask(
            &reg,
            &home,
            json!({"op": "bot_new", "name": "Bom", "job": JOB}),
        )
        .unwrap(),
    );
    let soul = |op: Value| {
        let mut op = op;
        op["op"] = "bot_soul".into();
        op["id"] = id.as_str().into();
        ask(&reg, &home, op)
    };
    // The first brief: greet and ask one question, do one small job, then write the SOUL file. No "say you are ready".
    let (_, _, brief) = team.brief(&id, None).unwrap();
    assert!(brief.contains(FIRST) && !brief.contains(READY), "{brief}");
    assert!(
        brief
            .split(FIRST)
            .nth(1)
            .unwrap()
            .contains(&team.soul(&id).display().to_string()),
        "the first chat names the file to write"
    );
    // A scheduled run is never a first chat.
    let (_, _, run) = team.brief(&id, Some("sort the mail")).unwrap();
    assert!(!run.contains(FIRST), "{run}");
    assert_eq!(soul(json!({})).unwrap()["first"], json!({"wrote": false}));
    // The bot writes its file, as it writes its memory file.
    let wrote = "I write release notes for users.\nPlain words. No process words.\n";
    fs::write(team.soul(&id), wrote).unwrap();
    let now = soul(json!({})).unwrap();
    assert_eq!(
        (&now["text"], &now["first"]),
        (&json!(wrote), &json!({"wrote": true}))
    );
    let (_, _, later) = team.brief(&id, None).unwrap();
    assert!(!later.contains(FIRST) && later.contains(READY), "{later}");
    // The owner's edit is kept; Undo puts back what the bot was made with, and the file is asked for again.
    let edited = soul(json!({"text": "I write release notes.\nNewest first."})).unwrap();
    assert_eq!(edited["first"], json!({"wrote": true}));
    let undone = soul(json!({"undo": true})).unwrap();
    assert_eq!(
        (&undone["text"], &undone["first"]),
        (&json!(format!("{JOB}\n")), &json!({"wrote": false}))
    );
    assert_eq!(
        fs::read_to_string(team.soul(&id)).unwrap(),
        format!("{JOB}\n")
    );
    assert!(team.brief(&id, None).unwrap().2.contains(FIRST));
    // A teammate made the earlier way has no first chat: its brief is as before, and there is nothing to undo.
    let old = team.save(None, mate("Scout", None)).unwrap();
    let old = old.last().unwrap().id.clone();
    let (_, _, plain) = team.brief(&old, None).unwrap();
    assert!(!plain.contains(FIRST) && plain.contains(READY));
    let op = |undo: bool| json!({"op": "bot_soul", "id": old, "undo": undo});
    assert!(ask(&reg, &home, op(false)).unwrap()["first"].is_null());
    assert!(
        ask(&reg, &home, op(true))
            .unwrap_err()
            .contains("nothing to undo")
    );
    assert_eq!(
        fs::read_to_string(team.soul(&old)).unwrap(),
        "Reviews diffs.\n"
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_lead_or_chief_template_asks_for_the_seat_once_and_any_answer_ends_the_ask() {
    let (home, proj) = (home(), self::home());
    let reg = std::sync::Mutex::new(crate::sessions::Sessions::open(&home).unwrap());
    let new = |name: &str, seat: &str| {
        made(&ask(
            &reg,
            &home,
            json!({"op": "bot_new", "name": name, "job": "Splits goals into tasks.", "seat": seat}),
        )
        .unwrap())
    };
    let first =
        |id: &str| ask(&reg, &home, json!({"op": "bot_soul", "id": id})).unwrap()["first"].clone();
    let (dalsu, mina) = (new("Dalsu", "lead"), new("Mina", "chief"));
    assert_eq!(first(&dalsu), json!({"wrote": false, "seat": "lead"}));
    assert_eq!(first(&mina), json!({"wrote": false, "seat": "chief"}));
    // Nobody sits before the owner's answer, and the bot is told a card asks (it does not ask itself).
    let team = Team::open(&home);
    assert!(team.list().unwrap().iter().all(|t| !t.lead));
    assert!(
        team.brief(&dalsu, None)
            .unwrap()
            .2
            .contains("Lead template")
    );
    // Yes: the seat is taken and the ask is over.
    let seated = ask(
        &reg,
        &home,
        json!({"op": "bot_seat", "id": dalsu, "seat": {"kind": "lead", "project": proj}}),
    )
    .unwrap();
    assert_eq!(bot(&seated, &dalsu)["seat"]["kind"], "lead");
    assert_eq!(first(&dalsu), json!({"wrote": false}));
    // Not now: no seat, and the ask is over as well.
    let stays = ask(
        &reg,
        &home,
        json!({"op": "bot_seat", "id": mina, "seat": {"kind": "none"}}),
    )
    .unwrap();
    assert_eq!(bot(&stays, &mina)["seat"]["kind"], "none");
    assert_eq!(first(&mina), json!({"wrote": false}));
    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(proj).unwrap();
}

/// A bot on the fake agent, made as the window makes one.
fn fake_bot(s: &Seats, name: &str) -> String {
    made(&ask(
        &s.reg,
        &s.home,
        json!({"op": "bot_new", "name": name, "job": JOB, "kind": "acp", "agent": "fake", "project": s.proj}),
    )
    .unwrap())
}

#[test]
fn the_first_chat_ends_when_the_next_conversation_starts() {
    let s = Seats::new();
    let id = fake_bot(&s, "Bom");
    let team = Team::open(&s.home);
    let first =
        || ask(&s.reg, &s.home, json!({"op": "bot_soul", "id": id})).unwrap()["first"].clone();
    ticking(&s.reg, || {
        let seat = s.open(&id);
        until("the first brief arrived", || s.logged().contains(FIRST));
        fs::write(team.soul(&id), "I write release notes for users.\n").unwrap();
        // The same conversation, opened again: the card with Read, Edit and Undo is still the chat's.
        assert_eq!(s.open(&id).id, seat.id);
        assert_eq!(first(), json!({"wrote": true}));
        // A new conversation is no first chat: the card's time is over, and the file stays as the bot wrote it.
        let next = s.now(&id).unwrap();
        s.idle(&next.id);
        assert!(first().is_null());
        assert_eq!(s.logged().matches(FIRST).count(), 1);
    });
    assert_eq!(
        fs::read_to_string(team.soul(&id)).unwrap(),
        "I write release notes for users.\n"
    );
    assert!(!s.home.join("team").join(&id).join("first.json").exists());
    s.end();
}

#[test]
fn a_worktree_is_handed_to_a_bot_as_its_next_prompt() {
    let s = Seats::new();
    let wt = self::home().join("tab-strip");
    fs::create_dir_all(&wt).unwrap();
    let link = wt.with_file_name("link");
    std::os::unix::fs::symlink(&wt, &link).unwrap();
    let hand = |worktree: &Path, goal: Value| {
        ask(
            &s.reg,
            &s.home,
            json!({"op": "bot_hand", "id": s.helper, "worktree": worktree, "goal": goal}),
        )
    };
    ticking(&s.reg, || {
        // Refused before any seat opens: a folder that is not there, a relative one, one through a symlink, and
        // a goal that would hide characters in the prompt.
        for (path, goal) in [
            (wt.join("gone"), json!(null)),
            (PathBuf::from("tab-strip"), json!(null)),
            (link.clone(), json!(null)),
            (wt.clone(), json!("fix\u{1b}[2J it")),
        ] {
            let refused = hand(&path, goal).unwrap_err();
            assert!(
                refused.contains("real folder") || refused.contains("control characters"),
                "{refused}"
            );
        }
        assert_eq!(s.seat(&s.helper), None, "a refusal opens no seat");
        // With a goal: the seat opens (its brief first), then the hand-over is its next prompt.
        let opened = hand(&wt, json!("Finish the tab strip")).unwrap();
        assert_eq!(opened["type"], "team_opened");
        let seat = opened["session"]["id"].as_str().unwrap().to_string();
        assert_eq!(s.seat(&s.helper), Some(seat.clone()));
        let path = wt.display().to_string();
        until("the hand-over arrived", || {
            s.logged().contains("hands you a worktree")
        });
        let logged = s.logged();
        let at = |what: &str| logged.find(what).unwrap_or_else(|| panic!("no {what}"));
        assert!(at("## Your job") < at("hands you a worktree"));
        assert!(at("hands you a worktree") < at(&path) && at(&path) < at("Finish the tab strip"));
        // With none, in the open seat: the bot is told to ask, not to guess.
        s.idle(&seat);
        let again = hand(&wt, json!(null)).unwrap();
        assert_eq!(again["session"]["id"], seat.as_str());
        until("the second hand-over arrived", || {
            s.logged().contains("gave no goal")
        });
    });
    let _ = fs::remove_dir_all(wt.parent().unwrap());
    s.end();
}

#[test]
fn a_bot_offers_a_new_bot_and_nothing_is_made_before_the_owners_yes() {
    use crate::api::{Request, StartSession};
    let s = Seats::new();
    let (home, proj) = (s.home.clone(), s.proj.clone());
    let team = Team::open(&home);
    let offer = |name: &str, why: &str| -> Request {
        serde_json::from_value(json!({
            "op": "bot_offer", "name": name, "job": "Writes release notes from what landed.", "why": why,
        }))
        .expect("the CLI's request")
    };
    let cards = |reg: &Reg| -> Vec<Value> {
        let items = reg.lock().unwrap().queue.owner_items();
        items
            .iter()
            .map(|i| json!({"id": i.id, "owner": i.owner}))
            .filter(|c| c["owner"]["type"] == "bot")
            .collect()
    };
    let answer = |reg: &Reg, item: &Value, answer: crate::queue::Answer| {
        reg.lock().unwrap().handle(Request::Answer {
            item: item["id"].as_str().unwrap().into(),
            answer,
            confirmed: true,
        })
    };
    let notes = |what: &str| {
        crate::room::Log::open(&home, &proj)
            .read()
            .unwrap()
            .into_iter()
            .filter(|m| m.team.as_ref().is_some_and(|n| n.what == what))
            .count()
    };
    let counted = "3 of the last 5 tasks were release notes";
    ticking(&s.reg, || {
        let seat = s.open(&s.helper);
        let helper = crate::grants::Caller {
            id: seat.id.clone(),
            project: s.proj.clone(),
        };
        let ask_as = |who: &crate::grants::Caller, request: Request| {
            s.reg.lock().unwrap().handle_agent(who, request)
        };
        // Refused: no reason, a name a bot of the place has, and a session that is no bot's seat.
        assert!(
            ask_as(&helper, offer("Notes", " "))
                .unwrap_err()
                .contains("--why")
        );
        assert!(
            ask_as(&helper, offer("helper", counted))
                .unwrap_err()
                .contains("already exists")
        );
        let plain = {
            let mut sessions = s.reg.lock().unwrap();
            let start = StartSession {
                account: None,
                kind: AgentKind::Acp,
                project: s.proj.clone(),
                worktree: false,
                label: "plain".into(),
                args: vec!["fake".into()],
                model: None,
                effort: None,
                resume: None,
            };
            let mut launch = sessions
                .launch_as(None, start, false)
                .unwrap()
                .owner_start()
                .prepare()
                .unwrap();
            let session = sessions.start(&launch).unwrap();
            launch.committed = true;
            crate::grants::Caller {
                id: session.id,
                project: s.proj.clone(),
            }
        };
        assert!(
            ask_as(&plain, offer("Notes", counted))
                .unwrap_err()
                .contains("only a bot")
        );
        assert!(cards(&s.reg).is_empty());
        // The offer is one card, however often it is made, and makes nothing.
        ask_as(&helper, offer(" Notes ", counted)).unwrap();
        ask_as(&helper, offer("notes", counted)).unwrap();
        let card = cards(&s.reg);
        assert_eq!(card.len(), 1, "{card:?}");
        let ask = &card[0]["owner"];
        assert_eq!(
            (&ask["name"], &ask["why"], &ask["from"], &ask["place"]),
            (
                &json!("notes"),
                &json!(counted),
                &json!("Helper"),
                &json!(s.proj)
            )
        );
        assert_eq!(team.list().unwrap().len(), 2, "nothing is made by an offer");
        // Not now: nothing is made, and the place's lead hears it.
        answer(&s.reg, &card[0], crate::queue::Answer::Deny).unwrap();
        assert!(cards(&s.reg).is_empty());
        assert_eq!(
            (
                team.list().unwrap().len(),
                notes("bot_no"),
                notes("bot_yes")
            ),
            (2, 1, 0)
        );
        ask_as(&helper, offer("Notes", counted)).unwrap();
    });
    // The card outlives a restart of the core.
    s.reg.lock().unwrap().stop().unwrap();
    drop(s.reg);
    let reg = std::sync::Mutex::new(crate::sessions::Sessions::open(&home).unwrap());
    let card = cards(&reg);
    assert_eq!(card.len(), 1, "the offer is still waiting");
    // Create: the bot is made in the offering bot's place, with its first chat ahead of it and no seat.
    answer(&reg, &card[0], crate::queue::Answer::AllowOnce).unwrap();
    assert!(cards(&reg).is_empty());
    let all = team.list().unwrap();
    let new = all.iter().find(|t| t.name == "Notes").expect("the bot");
    assert_eq!(
        (new.project.as_ref(), new.lead, new.job.as_str()),
        (Some(&proj), false, "Writes release notes from what landed.")
    );
    let first = ask(&reg, &home, json!({"op": "bot_soul", "id": new.id})).unwrap();
    assert_eq!(first["first"], json!({"wrote": false}));
    assert_eq!(notes("bot_yes"), 1);
    let _ = reg.lock().unwrap().stop();
    drop(reg);
    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(proj);
}
