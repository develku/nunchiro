//! Ticket 1168: the bots store and its move from `team.json`. Owner priority 1: nothing the owner saved is at risk,
//! and a build from before the move still opens the same home.
use super::*;
use crate::api::Reply;
use crate::sessions::Sessions;
use crate::team::{Op, Opener, open_seat, window};
use std::fs;
use std::path::Path;

/// The loader of every build before this ticket, frozen from team.rs at 430e3dd6e: what an older build does with
/// `team.json`. Kept apart from the live structs on purpose: a field added to them later must not reach this copy.
mod v1 {
    use crate::api::AgentKind;
    use serde::{Deserialize, Serialize};
    use std::path::{Path, PathBuf};

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Level {
        Light,
        Standard,
        Deep,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct Teammate {
        pub id: String,
        pub name: String,
        pub job: String,
        pub kind: AgentKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub project: Option<PathBuf>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pub lead: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub level: Option<Level>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub level_max: Option<Level>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next_level: Option<Level>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub agent: Option<String>,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Stored {
        version: u32,
        teammates: Vec<Teammate>,
    }
    pub fn list(home: &Path) -> Result<Vec<Teammate>, String> {
        let bytes = std::fs::read(home.join("team/team.json")).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > 1 << 20 {
            return Err("team.json is too large".into());
        }
        let stored: Stored =
            serde_json::from_slice(&bytes).map_err(|e| format!("team.json: {e}"))?;
        if stored.version != 1 {
            return Err(format!(
                "team.json has version {}, this build reads 1",
                stored.version
            ));
        }
        for t in &stored.teammates {
            if !crate::store::valid_id(&t.id) {
                return Err(format!(
                    "team.json holds an id that is not a teammate id: {:?}",
                    t.id
                ));
            }
            match (t.kind, t.agent.as_deref()) {
                (AgentKind::Claude | AgentKind::Codex, None) => {}
                (AgentKind::Acp, Some(name)) if crate::approval::valid_name(name) => {}
                _ => return Err("team.json: a teammate runs Claude, Codex or an ACP agent".into()),
            }
        }
        Ok(stored.teammates)
    }
}

/// A home as a build before this ticket left it: a Chief, a project's Lead (pinned to a level), a project teammate
/// with an upper limit and a level picked for its next task, and a Home teammate on a custom model. Written by hand,
/// not by this build's serializer, so "byte-identical" means the owner's own bytes.
struct Old {
    home: PathBuf,
    project: PathBuf,
    team_json: Vec<u8>,
}
const CHIEF: &str = "c0000000-0000-4000-8000-000000000001";
const LEAD: &str = "d0000000-0000-4000-8000-000000000002";
const ORI: &str = "e0000000-0000-4000-8000-000000000003";
const BOM: &str = "f0000000-0000-4000-8000-000000000004";
fn old_home() -> Old {
    let home = std::env::temp_dir().join(format!("nunchiro-bots-{}", store::new_id().unwrap()));
    let project = home.join("harbor");
    fs::create_dir_all(&project).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let project = fs::canonicalize(project).unwrap();
    let p = serde_json::to_string(&project).unwrap();
    let team_json = format!(
        r#"{{"version":1,
  "teammates":[
    {{"id":"{CHIEF}","name":"Mina","job":"Runs the office.","kind":"claude","lead":true}},
    {{"id":"{LEAD}","name":"Dalsu","job":"Splits goals into tasks.","kind":"claude","project":{p},"lead":true,"level":"deep"}},
    {{"id":"{ORI}","name":"Ori","job":"Reviews every change.","kind":"codex","project":{p},"effort":"high","level_max":"standard","next_level":"light"}},
    {{"id":"{BOM}","name":"Bom","job":"Writes release notes.","kind":"claude","model":"opus","effort":"high"}}
  ]}}
"#
    )
    .into_bytes();
    fs::create_dir_all(home.join("team")).unwrap();
    fs::write(home.join("team/team.json"), &team_json).unwrap();
    Old {
        home,
        project,
        team_json,
    }
}
fn read(home: &Path, file: &str) -> Vec<u8> {
    fs::read(home.join(file)).unwrap()
}
fn mate(name: &str, project: Option<PathBuf>, lead: bool) -> Teammate {
    Teammate {
        id: String::new(),
        name: name.into(),
        job: format!("{name}'s job."),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project,
        lead,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    }
}
/// The home as an older build sees it: the same `team.json` and ledger, and no `bots.json` (a file it never opens).
fn as_older_build(home: &Path, team_json: &[u8]) -> PathBuf {
    let old = std::env::temp_dir().join(format!("nunchiro-bots-old-{}", store::new_id().unwrap()));
    fs::create_dir_all(old.join("team")).unwrap();
    let old = fs::canonicalize(old).unwrap();
    fs::write(old.join("team/team.json"), team_json).unwrap();
    if let Ok(ledger) = fs::read(home.join("ledger.json")) {
        fs::write(old.join("ledger.json"), ledger).unwrap();
    }
    old
}

// 1
#[test]
fn the_first_write_leaves_team_json_byte_identical_and_an_older_build_still_reads_it() {
    let Old {
        home,
        project,
        team_json,
    } = old_home();
    let before = v1::list(&home).unwrap();
    let team = Team::open(&home);
    assert!(!home.join("team/bots.json").exists());
    // The move: any change of the roster. Then every other kind of change the store has.
    let mut mina = team.seat(CHIEF).unwrap().0;
    mina.name = "Mina the Chief".into();
    team.save(Some(CHIEF.into()), mina).unwrap();
    assert!(
        home.join("team/bots.json").is_file(),
        "bots.json is the roster now"
    );
    assert_eq!(
        read(&home, "team/team.json"),
        team_json,
        "team.json after the move"
    );
    assert_eq!(read(&home, "team/team.json.v1.bak"), team_json, "its copy");
    team.set_next_level(ORI, Some(Level::Deep)).unwrap();
    team.remove(BOM).unwrap();
    let moved = home.join("harbor-2");
    fs::create_dir_all(&moved).unwrap();
    team.locate(&project, &moved).unwrap();
    assert_eq!(
        read(&home, "team/team.json"),
        team_json,
        "team.json after every kind of write"
    );
    assert_eq!(
        v1::list(&home).unwrap(),
        before,
        "an older build reads what it read before"
    );
    // The new build reads its own file.
    let names: Vec<String> = team.list().unwrap().into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["Mina the Chief", "Dalsu", "Ori"]);
    fs::remove_dir_all(home).unwrap();
}

// 2
#[test]
fn with_no_bots_json_the_roster_is_team_json_with_seats_mapped_and_a_read_writes_nothing() {
    let Old { home, project, .. } = old_home();
    let team = Team::open(&home);
    let bots = team.bots().unwrap();
    let old = v1::list(&home).unwrap();
    assert_eq!(bots.len(), old.len());
    for (b, t) in bots.iter().zip(&old) {
        assert_eq!((&b.id, &b.name, &b.job), (&t.id, &t.name, &t.job));
    }
    // A face is the id's own; Bom's id derives the Lead's, so Bom has the next free one, and no two are the same.
    for b in &bots[..3] {
        assert_eq!(b.face, face_of(&b.id), "{}: its id's face", b.name);
    }
    assert_eq!(face_of(BOM), face_of(LEAD));
    for (i, b) in bots.iter().enumerate() {
        assert!(
            bots[..i].iter().all(|o| o.face != b.face),
            "{}: a face of its own",
            b.name
        );
    }
    let agents: Vec<&str> = bots.iter().map(|b| b.agent.as_str()).collect();
    assert_eq!(agents, ["claude", "claude", "codex", "claude"]);
    assert_eq!(
        bots[0].seat,
        Seat::Chief,
        "a lead with no project is the Chief"
    );
    assert_eq!(
        bots[1].seat,
        Seat::Lead {
            project: project.clone()
        }
    );
    assert_eq!((&bots[2].seat, &bots[3].seat), (&Seat::None, &Seat::None));
    assert_eq!(
        bots[2].v1.project.as_ref(),
        Some(&project),
        "a seat-less bot keeps its project"
    );
    // The teammate view is the older build's list, field for field.
    assert_eq!(
        serde_json::to_value(team.list().unwrap()).unwrap(),
        serde_json::to_value(&old).unwrap()
    );
    let files: Vec<_> = fs::read_dir(home.join("team"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(files, ["team.json"], "a read made no file");
    fs::remove_dir_all(home).unwrap();
}

// 3
#[test]
fn a_bots_json_this_build_cannot_read_is_refused_and_team_json_is_never_read_in_its_place() {
    let Old {
        home, team_json, ..
    } = old_home();
    let team = Team::open(&home);
    let bot = r#"{"id":"c0000000-0000-4000-8000-000000000001","name":"Mina","job":"Runs the office.","face":{"shape":"bun","tile":"lilac"},"seat":{"kind":"chief"},"agent":"claude","model":{"rule":"follow"}}"#;
    assert_eq!(
        {
            fs::write(
                home.join("team/bots.json"),
                format!(r#"{{"version":1,"bots":[{bot}]}}"#),
            )
            .unwrap();
            team.list().unwrap().len()
        },
        1,
        "the good file reads"
    );
    let with =
        |from: &str, to: &str| format!(r#"{{"version":1,"bots":[{}]}}"#, bot.replace(from, to));
    let bad = [
        (
            "a later version",
            format!(r#"{{"version":2,"bots":[{bot}]}}"#),
            "bots.json has version 2, this build reads 1",
        ),
        (
            "an unknown top field",
            format!(r#"{{"version":1,"bots":[{bot}],"rooms":[]}}"#),
            "unknown field `rooms`",
        ),
        (
            "an unknown bot field",
            with(r#""name""#, r#""mood":"calm","name""#),
            "unknown field `mood`",
        ),
        (
            "an unknown face field",
            with(r#""tile":"lilac""#, r#""tile":"lilac","hat":1"#),
            "unknown field `hat`",
        ),
        (
            "an unknown seat field",
            with(r#"{"kind":"chief"}"#, r#"{"kind":"chief","floor":2}"#),
            "unknown field `floor`",
        ),
        (
            "an unknown seat",
            with(r#"{"kind":"chief"}"#, r#"{"kind":"owner"}"#),
            "unknown variant `owner`",
        ),
        (
            "an unknown model field",
            with(r#"{"rule":"follow"}"#, r#"{"rule":"follow","budget":3}"#),
            "unknown field `budget`",
        ),
        (
            "an unknown model rule",
            with(r#"{"rule":"follow"}"#, r#"{"rule":"best"}"#),
            "unknown variant `best`",
        ),
        (
            "an id that is a path",
            with("c0000000-0000-4000-8000-000000000001", "../../etc"),
            "not a bot id",
        ),
        (
            "a shell for an agent",
            with(r#""agent":"claude""#, r#""agent":"shell""#),
            "runs Claude, Codex or an ACP agent",
        ),
        (
            "a seat and another project",
            with(
                r#""model":{"rule":"follow"}"#,
                r#""model":{"rule":"follow"},"v1":{"project":"/x"}"#,
            ),
            "no other project",
        ),
        ("not JSON", "{".to_string(), "bots.json"),
        ("an empty file", String::new(), "bots.json"),
    ];
    for (what, text, says) in bad {
        fs::write(home.join("team/bots.json"), &text).unwrap();
        for err in [
            team.list().map(drop).unwrap_err(),
            team.bots().map(drop).unwrap_err(),
            team.save(None, mate("Nuni", None, false))
                .map(drop)
                .unwrap_err(),
            team.remove(CHIEF).map(drop).unwrap_err(),
        ] {
            assert!(
                err.contains("bots.json") && err.contains(says),
                "{what}: {err}"
            );
        }
        assert_eq!(
            read(&home, "team/bots.json"),
            text.as_bytes(),
            "{what}: not written over"
        );
        assert_eq!(
            read(&home, "team/team.json"),
            team_json,
            "{what}: team.json"
        );
    }
    fs::remove_dir_all(home).unwrap();
}

// 4
#[test]
fn a_ledger_lead_and_a_schedule_teammate_still_resolve_after_the_move_and_their_files_keep_their_bytes()
 {
    let Old { home, project, .. } = old_home();
    // Before the move, as the older build left them: the Chief's two brief schedules and a task of the project's Lead.
    let mut core = Sessions::open(&home).unwrap();
    crate::schedule::seed_presets(&mut core, 0, &|_| 0);
    let ledger = crate::ledger::Ledger::open(&home);
    let (task, _) = ledger
        .make(&project, Some(LEAD), "Ship the harbor", &[], false, 1)
        .unwrap();
    let (schedules, ledger_json) = (read(&home, "schedules.json"), read(&home, "ledger.json"));
    assert_eq!(core.schedules.list().unwrap().len(), 2);

    let team = Team::open(&home);
    let mut mina = team.seat(CHIEF).unwrap().0;
    mina.name = "Mina B".into();
    team.save(Some(CHIEF.into()), mina).unwrap();
    assert!(home.join("team/bots.json").is_file());

    // The schedule's teammate id is the bot: its row reads the bot's name as it is now, and its seat is found.
    let shown = crate::schedule::Schedules::load(&home).shown().unwrap();
    assert_eq!(shown.len(), 2);
    for e in &shown {
        assert_eq!(
            (e.run.teammate.as_deref(), e.run.label.as_str()),
            (Some(CHIEF), "Mina B")
        );
    }
    assert_eq!(team.seat(CHIEF).unwrap().1, team.home());
    // The task's lead is the bot in the Lead seat of its project.
    let kept = ledger.list().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        (kept[0].id.as_str(), kept[0].lead.as_deref()),
        (task.id.as_str(), Some(LEAD))
    );
    assert_eq!(team.lead_of(Some(&project)).unwrap().id, LEAD);
    let lead = team
        .bots()
        .unwrap()
        .into_iter()
        .find(|b| b.id == LEAD)
        .unwrap();
    assert_eq!(lead.seat, Seat::Lead { project });
    assert_eq!(read(&home, "schedules.json"), schedules, "schedules.json");
    assert_eq!(read(&home, "ledger.json"), ledger_json, "ledger.json");
    fs::remove_dir_all(home).unwrap();
}

// 5
// The 1166 plan said "a pinned level becomes an exact pin, level_max is not carried". Built otherwise, on purpose:
// lane 1 keeps today's controls working (the brief), and an upper limit the owner set must not vanish in a move. So a
// custom model is the pin, Auto is follow, and the level rule is carried whole under `v1` until lane 3 retires it.
#[test]
fn the_model_rule_maps_both_ways_and_nothing_the_owner_set_is_dropped() {
    let Old { home, project, .. } = old_home();
    let team = Team::open(&home);
    let before = team.list().unwrap();
    // Every teammate, and a grid of every field a teammate can hold, comes back the same.
    let mut grid = before.clone();
    for (model, effort, level, level_max, next_level, lead, place, acp) in [
        (None, None, None, None, None, false, None, None),
        (
            Some("opus"),
            Some("high"),
            None,
            None,
            None,
            true,
            None,
            None,
        ),
        (
            Some("sonnet"),
            None,
            Some(Level::Light),
            Some(Level::Deep),
            Some(Level::Standard),
            false,
            Some(project.clone()),
            None,
        ),
        (
            None,
            Some("low"),
            Some(Level::Deep),
            None,
            None,
            true,
            Some(project.clone()),
            None,
        ),
        (
            None,
            None,
            None,
            Some(Level::Standard),
            Some(Level::Light),
            false,
            None,
            Some("gemini"),
        ),
        (
            Some("gemini-3"),
            Some("max"),
            None,
            None,
            None,
            false,
            Some(project.clone()),
            Some("gemini"),
        ),
    ] {
        grid.push(Teammate {
            id: store::new_id().unwrap(),
            model: model.map(Into::into),
            effort: effort.map(Into::into),
            level,
            level_max,
            next_level,
            kind: if acp.is_some() {
                AgentKind::Acp
            } else {
                AgentKind::Codex
            },
            agent: acp.map(Into::into),
            ..mate("Grid", place, lead)
        });
    }
    for t in &grid {
        let bot = Bot::of(t, face_of(&t.id));
        assert_eq!(&bot.teammate().unwrap(), t, "{bot:?}");
        // Through the file's own text too.
        let text = serde_json::to_string(&bot).unwrap();
        assert_eq!(serde_json::from_str::<Bot>(&text).unwrap(), bot);
    }
    // The move itself, read back from the file.
    team.set_next_level(ORI, Some(Level::Light)).unwrap();
    assert_eq!(team.list().unwrap(), before, "the roster after the move");
    let stored: serde_json::Value = serde_json::from_slice(&read(&home, "team/bots.json")).unwrap();
    let bot = |id: &str| {
        stored["bots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(stored["version"], 1);
    // A custom model is that pin; Auto is follow.
    assert_eq!(
        bot(BOM)["model"],
        serde_json::json!({"rule": "pinned", "model": "opus", "effort": "high"})
    );
    assert_eq!(bot(CHIEF)["model"], serde_json::json!({"rule": "follow"}));
    assert_eq!(bot(CHIEF).get("v1"), None, "nothing to carry, no key");
    assert_eq!(bot(BOM).get("v1"), None);
    // The level rule is carried whole: the pin, the upper limit, the next task's pick and Auto's effort.
    assert_eq!(bot(LEAD)["v1"], serde_json::json!({"level": "deep"}));
    assert_eq!(
        bot(ORI)["v1"],
        serde_json::json!({"project": project, "effort": "high", "level_max": "standard", "next_level": "light"})
    );
    assert_eq!(bot(ORI)["agent"], "codex");
    // And the seat opens by the same rule as before the move.
    let ori = team.seat(ORI).unwrap().0;
    assert_eq!(
        crate::team::seat_level(&ori, Some(Level::Deep)).unwrap().0,
        Level::Standard
    );
    fs::remove_dir_all(home).unwrap();
}

// 6
#[test]
fn a_second_chief_or_a_second_lead_of_a_project_is_refused_and_names_the_holder() {
    let Old { home, project, .. } = old_home();
    let team = Team::open(&home);
    let err = team.sit(BOM, Seat::Chief).unwrap_err();
    assert_eq!(err, "Mina is the Chief; one office has one Chief");
    let lead = Seat::Lead {
        project: project.clone(),
    };
    let err = team.sit(ORI, lead.clone()).unwrap_err();
    assert_eq!(err, "Dalsu leads harbor; one project has one Lead");
    assert!(
        !home.join("team/bots.json").exists(),
        "a refusal wrote nothing"
    );
    // The holder leaves its seat (and stays in its project); then the seat is free.
    let bots = team.sit(LEAD, Seat::None).unwrap();
    let dalsu = bots.iter().find(|b| b.id == LEAD).unwrap();
    assert_eq!(
        (&dalsu.seat, dalsu.v1.project.as_ref()),
        (&Seat::None, Some(&project))
    );
    let bots = team.sit(ORI, lead.clone()).unwrap();
    assert_eq!(bots.iter().find(|b| b.id == ORI).unwrap().seat, lead);
    assert_eq!(team.lead_of(Some(&project)).unwrap().id, ORI);
    // A bot already in the seat may be seated there again; another project's Lead seat is its own.
    team.sit(ORI, lead).unwrap();
    team.sit(CHIEF, Seat::Chief).unwrap();
    let other = home.join("kappa");
    fs::create_dir_all(&other).unwrap();
    team.sit(
        LEAD,
        Seat::Lead {
            project: other.clone(),
        },
    )
    .unwrap();
    assert_eq!(team.lead_of(Some(&other)).unwrap().id, LEAD);
    // The window's op is the same rule.
    let reg = std::sync::Mutex::new(Sessions::open(&home).unwrap());
    let op: Op = serde_json::from_value(
        serde_json::json!({"op": "bot_seat", "id": BOM, "seat": {"kind": "chief"}}),
    )
    .unwrap();
    assert_eq!(
        window(&reg, &home, op).unwrap_err(),
        "Mina is the Chief; one office has one Chief"
    );
    fs::remove_dir_all(home).unwrap();
}

// 7
#[test]
fn a_failure_between_the_backup_and_the_write_leaves_team_json_whole_and_no_partial_bots_json() {
    let Old {
        home, team_json, ..
    } = old_home();
    let team = Team::open(&home);
    FAIL_BETWEEN.set(Some("bots.json: the disk failed"));
    let err = team.save(None, mate("Nuni", None, false)).unwrap_err();
    FAIL_BETWEEN.set(None);
    assert!(err.contains("the disk failed"), "{err}");
    let mut files: Vec<String> = fs::read_dir(home.join("team"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|f| !home.join("team").join(f).is_dir())
        .collect();
    files.sort();
    assert_eq!(
        files,
        ["USER.md", "team.json", "team.json.v1.bak"],
        "no bots.json, no temp file"
    );
    assert_eq!(read(&home, "team/team.json"), team_json);
    assert_eq!(read(&home, "team/team.json.v1.bak"), team_json);
    // Still the old roster, and the next try moves: the copy that is already there is the copy.
    assert_eq!(team.list().unwrap().len(), 4);
    team.save(None, mate("Nuni", None, false)).unwrap();
    assert_eq!(team.list().unwrap().len(), 5);
    assert_eq!(read(&home, "team/team.json.v1.bak"), team_json);
    assert!(!home.join("team/team.json.v1.bak.1").exists());
    // A copy with other bytes (an older build wrote team.json since) is never written over.
    fs::remove_file(home.join("team/bots.json")).unwrap();
    fs::write(
        home.join("team/team.json.v1.bak"),
        b"the owner's older copy",
    )
    .unwrap();
    let now = read(&home, "team/team.json");
    team.save(None, mate("Sol", None, false)).unwrap();
    assert_eq!(
        read(&home, "team/team.json.v1.bak"),
        b"the owner's older copy"
    );
    assert_eq!(read(&home, "team/team.json.v1.bak.1"), now);
    fs::remove_dir_all(home).unwrap();
}

// The risk named in the 1166 plan, part 1 (what an older build does today, with no help from this one): a bot made
// after the move is in `bots.json` only. An older build's `team.json` does not hold its id, and a schedule of that
// bot fails its run there: `open_seat` says "no teammate <id>", which the scheduler records as a failed run ("<name>
// is no longer a teammate", schedule/mod.rs `start`). The ledger still loads and keeps the task; the project just has
// no lead. So without a mirror the owner's schedule stops on a step back to an older build.
#[test]
fn an_older_build_that_never_heard_of_a_bot_fails_its_schedule_and_loses_its_lead() {
    let Old {
        home,
        project,
        team_json,
    } = old_home();
    // "Nuni" exists in no team.json: the roster as it was before the move is all an unhelped older build has.
    let nuni = store::new_id().unwrap();
    crate::ledger::Ledger::open(&home)
        .make(&project, Some(&nuni), "Watch the peers", &[], false, 1)
        .unwrap();
    let old = as_older_build(&home, &team_json);
    assert!(v1::list(&old).unwrap().iter().all(|t| t.id != nuni));
    let reg = std::sync::Mutex::new(Sessions::open(&old).unwrap());
    let err = open_seat(
        &reg,
        &nuni,
        Some("Watch the peers."),
        None,
        Opener::Schedule("s1"),
    )
    .map(drop)
    .unwrap_err();
    assert_eq!(
        err,
        format!("no teammate {nuni}"),
        "the scheduled run fails"
    );
    // The ledger is not hurt: the task is there, with a lead nobody is.
    let tasks = crate::ledger::Ledger::open(&old).list().unwrap();
    assert_eq!(tasks[0].lead.as_deref(), Some(nuni.as_str()));
    assert_ne!(Team::open(&old).lead_of(Some(&project)).unwrap().id, nuni);
    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(old).unwrap();
}

// The risk, part 2 (the answer): a bot made after the move is also added to `team.json`, in the exact v1 shape, so an
// older build finds its seat and its lead. Nothing already in `team.json` is changed except the lead flag a new lead
// takes, as an older build's own save takes it.
#[test]
fn an_older_build_still_finds_a_bot_made_after_the_move() {
    let Old {
        home,
        project,
        team_json,
    } = old_home();
    let team = Team::open(&home);
    let before = v1::list(&home).unwrap();
    // The move (no new bot: team.json untouched), then a new bot with no seat and a new Lead for the project.
    team.set_next_level(ORI, None).unwrap();
    assert_eq!(read(&home, "team/team.json"), team_json);
    let all = team.save(None, mate("Nuni", None, false)).unwrap();
    let nuni = all.last().unwrap().id.clone();
    team.sit(LEAD, Seat::None).unwrap();
    let all = team
        .save(
            None,
            Teammate {
                level_max: Some(Level::Standard),
                ..mate("Sol", Some(project.clone()), true)
            },
        )
        .unwrap();
    let sol = all.last().unwrap().id.clone();
    crate::ledger::Ledger::open(&home)
        .make(&project, Some(&sol), "Ship the harbor", &[], false, 1)
        .unwrap();

    // An older build: its own loader reads the file, and holds both bots in its own shape (a field it does not know
    // would have failed `deny_unknown_fields`).
    let old = as_older_build(&home, &read(&home, "team/team.json"));
    let seen = v1::list(&old).unwrap();
    assert_eq!(seen.len(), before.len() + 2);
    let of = |id: &str| seen.iter().find(|t| t.id == id).unwrap();
    assert_eq!(
        (of(&nuni).name.as_str(), of(&nuni).lead, &of(&nuni).project),
        ("Nuni", false, &None)
    );
    assert_eq!(
        (of(&sol).lead, of(&sol).project.as_ref(), of(&sol).level_max),
        (true, Some(&project), Some(v1::Level::Standard))
    );
    // What it already held is as it was, but for the lead flag the new Lead took (one lead per place, as its own save).
    for t in &before {
        let mut was = t.clone();
        was.lead = t.lead && t.id != LEAD;
        assert_eq!(of(&t.id), &was);
    }
    // And its code paths find them: the seat a schedule opens, the lead a task belongs to.
    let older = Team::open(&old);
    assert_eq!(older.seat(&nuni).unwrap().1, older.home());
    assert_eq!(older.lead_of(Some(&project)).unwrap().id, sol);
    let tasks = crate::ledger::Ledger::open(&old).list().unwrap();
    assert_eq!(tasks[0].lead.as_deref(), Some(sol.as_str()));
    // The copy from before the move still holds the owner's bytes.
    assert_eq!(read(&home, "team/team.json.v1.bak"), team_json);
    // A team.json this build cannot read by the v1 rules is left alone, and the bot is still saved.
    fs::write(home.join("team/team.json"), b"{ not json").unwrap();
    team.save(None, mate("Bada", None, false)).unwrap();
    assert_eq!(read(&home, "team/team.json"), b"{ not json");
    assert!(team.list().unwrap().iter().any(|t| t.name == "Bada"));
    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(old).unwrap();
}

#[test]
fn a_new_home_keeps_both_files_and_a_bot_keeps_its_face() {
    let home = fs::canonicalize({
        let dir = std::env::temp_dir().join(format!("nunchiro-bots-{}", store::new_id().unwrap()));
        fs::create_dir_all(&dir).unwrap();
        dir
    })
    .unwrap();
    let team = Team::open(&home);
    let id = team.save(None, mate("Mina", None, true)).unwrap()[0]
        .id
        .clone();
    assert!(
        !home.join("team/team.json.v1.bak").exists(),
        "nothing to copy"
    );
    assert_eq!(
        v1::list(&home).unwrap()[0].id,
        id,
        "an older build knows the bot"
    );
    // The face is the id's, the same on every call, and one of the drawn shapes and tiles.
    let face = team.bots().unwrap()[0].face.clone();
    assert_eq!(face, face_of(&id));
    assert!(SHAPES.contains(&face.shape.as_str()) && TILES.contains(&face.tile.as_str()));
    assert_eq!(
        face_of("c0000000-0000-4000-8000-000000000001"),
        face_of(CHIEF)
    );
    assert_eq!(
        (face_of(CHIEF), face_of(LEAD)),
        (
            Face {
                shape: "bear".into(),
                tile: "mint".into()
            },
            Face {
                shape: "bot".into(),
                tile: "slate".into()
            }
        ),
        "pinned: a change of the hash would give every bot another face"
    );
    // A face the file holds is kept through later writes, also one a later build picked (any plain word).
    let text = String::from_utf8(read(&home, "team/bots.json")).unwrap();
    fs::write(
        home.join("team/bots.json"),
        text.replace(&format!("\"{}\"", face.shape), "\"owl\""),
    )
    .unwrap();
    team.save(None, mate("Bom", None, false)).unwrap();
    assert_eq!(team.bots().unwrap()[0].face.shape, "owl");
    fs::remove_dir_all(home).unwrap();
}

// Coordinator's look at the first shots (ticket 1168): Mina and Dalsu had one face. A face is who a bot is on the
// roster, so no two bots of one home share one while a free one is left.
#[test]
fn two_ids_with_the_same_derived_face_get_two_faces_and_keep_them() {
    // The two ids of the first shots: both derive the same face.
    let (mina, dalsu) = ("bot-mina", "bot-dalsu");
    assert_eq!(
        face_of(mina),
        face_of(dalsu),
        "the test needs two ids that collide"
    );
    let home = fs::canonicalize({
        let dir = std::env::temp_dir().join(format!("nunchiro-bots-{}", store::new_id().unwrap()));
        fs::create_dir_all(dir.join("team")).unwrap();
        dir
    })
    .unwrap();
    fs::write(
        home.join("team/team.json"),
        format!(
            r#"{{"version":1,"teammates":[
            {{"id":"{mina}","name":"Mina","job":"Runs the office.","kind":"claude","lead":true}},
            {{"id":"{dalsu}","name":"Dalsu","job":"Leads.","kind":"claude"}}]}}"#
        ),
    )
    .unwrap();
    let faces =
        |team: &Team| -> Vec<Face> { team.bots().unwrap().into_iter().map(|b| b.face).collect() };
    // Before the move: the first keeps its id's face, the second takes a free one. A reload (the file read again)
    // gives the same two.
    let before = faces(&Team::open(&home));
    assert_eq!(before[0], face_of(mina));
    assert_ne!(before[0], before[1], "two bots, two faces");
    assert!(SHAPES.contains(&before[1].shape.as_str()) && TILES.contains(&before[1].tile.as_str()));
    assert_eq!(faces(&Team::open(&home)), before, "the same after a reload");
    assert!(!home.join("team/bots.json").exists());
    // The move stores exactly those faces, and a later reload reads them.
    let team = Team::open(&home);
    let all = team.save(None, mate("Sol", None, false)).unwrap();
    let sol = all.last().unwrap().id.clone();
    let after = faces(&Team::open(&home));
    assert_eq!(
        after[..2],
        before[..],
        "the move keeps the faces the roster showed"
    );
    assert!(
        !before.contains(&after[2]),
        "a new bot takes a face nobody has"
    );
    // Once assigned, a face stays: the first bot leaves, the second keeps its own (not the freed one).
    team.remove(mina).unwrap();
    let left = team.bots().unwrap();
    assert_eq!((left[0].id.as_str(), &left[0].face), (dalsu, &before[1]));
    assert_eq!(
        (left[1].id.as_str(), &left[1].face),
        (sol.as_str(), &after[2])
    );
    // A full roster: all 36 faces are used once before any is used twice.
    let mut seen = vec![];
    for i in 0..36 - 2 {
        team.save(None, mate(&format!("Bot {i}"), None, false))
            .unwrap();
    }
    for b in team.bots().unwrap() {
        assert!(!seen.contains(&b.face), "{} repeats a face", b.name);
        seen.push(b.face);
    }
    assert_eq!(seen.len(), 36);
    team.save(None, mate("One more", None, false)).unwrap();
    assert_eq!(
        team.bots().unwrap().len(),
        37,
        "the 37th bot still gets a face"
    );
    fs::remove_dir_all(home).unwrap();
}

// Codex look, round 2 (P2, data safety): a seat change read the roster and checked the seat before it took the
// store's lock, so another request could land between its check and its write.
type Arrived =
    std::sync::Arc<std::sync::Mutex<Option<std::thread::JoinHandle<Result<(), String>>>>>;
/// Another request, made on its own thread while this thread's seat change is between its check and its write. It is
/// given 300 ms to finish there (it does, when nothing holds it back); joined afterwards for its answer.
fn arrives_at_the_seat_check(
    other: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Arrived {
    let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let kept = slot.clone();
    AT_SEAT_CHECK.set(Some(Box::new(move || {
        let handle = std::thread::spawn(other);
        for _ in 0..30 {
            if handle.is_finished() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if let Ok(mut slot) = kept.lock() {
            *slot = Some(handle);
        }
    })));
    slot
}
#[test]
fn two_seat_changes_at_once_seat_one_bot_and_refuse_the_other() {
    let Old { home, .. } = old_home();
    let team = Team::open(&home);
    team.sit(CHIEF, Seat::None).unwrap(); // the Chief's seat is free
    let there = home.clone();
    let other =
        arrives_at_the_seat_check(move || Team::open(&there).sit(BOM, Seat::Chief).map(drop));
    let mine = team.sit(ORI, Seat::Chief).map(drop);
    let theirs = other.lock().unwrap().take().unwrap().join().unwrap();
    // One of the two has the seat and the other was told who: never two yeses with one of them undone.
    let chiefs: Vec<String> = team
        .bots()
        .unwrap()
        .into_iter()
        .filter(|b| b.seat == Seat::Chief)
        .map(|b| b.name)
        .collect();
    assert_eq!(chiefs.len(), 1, "{chiefs:?}");
    assert!(
        mine.is_ok() != theirs.is_ok(),
        "mine {mine:?}, theirs {theirs:?}"
    );
    let refused = mine.err().or(theirs.err()).unwrap();
    assert_eq!(
        refused,
        format!("{} is the Chief; one office has one Chief", chiefs[0])
    );
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn an_edit_that_lands_during_a_seat_change_is_not_written_over() {
    let Old { home, project, .. } = old_home();
    let team = Team::open(&home);
    team.sit(LEAD, Seat::None).unwrap(); // the project's Lead seat is free
    // The window's edit of Ori, whole as `team_save` sends it, arrives while Ori's seat change is under way.
    let mut edit = team.seat(ORI).unwrap().0;
    edit.name = "Oriole".into();
    edit.job = "Reviews twice.".into();
    let there = home.clone();
    let other = arrives_at_the_seat_check(move || {
        Team::open(&there).save(Some(ORI.into()), edit).map(drop)
    });
    team.sit(ORI, Seat::Lead { project }).unwrap();
    other
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
    // Both said yes, so the roster is what one of them after the other gives. In either order the edit's name and job
    // are there (before the fix the seat change wrote the roster it had read before the edit: the edit was gone).
    let ori = team.seat(ORI).unwrap().0;
    assert_eq!(
        (ori.name.as_str(), ori.job.as_str()),
        ("Oriole", "Reviews twice.")
    );
    fs::remove_dir_all(home).unwrap();
}

// Codex look, round 2 (P2): a new bot is written to two files, and a crash between them must not leave a bot this
// build has and an older build cannot find (its schedules and its ledger lead would be lost there).
#[test]
fn a_failure_between_the_two_files_leaves_no_bot_an_older_build_cannot_find() {
    let Old {
        home, team_json, ..
    } = old_home();
    let team = Team::open(&home);
    team.set_next_level(ORI, None).unwrap(); // the move
    FAIL_BETWEEN.set(Some("the disk failed between the two files"));
    let err = team.save(None, mate("Nuni", None, false)).unwrap_err();
    FAIL_BETWEEN.set(None);
    assert!(err.contains("between the two files"), "{err}");
    let known = v1::list(&home).unwrap();
    for b in team.bots().unwrap() {
        assert!(
            known.iter().any(|t| t.id == b.id),
            "{} is in bots.json and not in team.json",
            b.name
        );
    }
    // The change did not happen, and the older builds' file is as it was.
    assert!(team.list().unwrap().iter().all(|t| t.name != "Nuni"));
    assert_eq!(read(&home, "team/team.json"), team_json);
    // The next try writes both.
    let id = team
        .save(None, mate("Nuni", None, false))
        .unwrap()
        .last()
        .unwrap()
        .id
        .clone();
    assert!(v1::list(&home).unwrap().iter().any(|t| t.id == id));
    assert!(team.bots().unwrap().iter().any(|b| b.id == id));
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn a_failed_write_of_team_json_is_the_changes_error_and_a_missing_bot_is_added_by_the_next_write() {
    let Old {
        home, team_json, ..
    } = old_home();
    let team = Team::open(&home);
    team.set_next_level(ORI, None).unwrap(); // the move
    FAIL_MIRROR.set(Some("team.json: the disk failed"));
    let failed = team.save(None, mate("Nuni", None, false)).map(drop);
    FAIL_MIRROR.set(None);
    // Not swallowed: the caller hears it, and nothing was changed in either file.
    assert_eq!(failed.unwrap_err(), "team.json: the disk failed");
    assert!(team.list().unwrap().iter().all(|t| t.name != "Nuni"));
    assert_eq!(read(&home, "team/team.json"), team_json);
    // Repair: a bot team.json does not hold (an earlier crash, a file put back from a copy) is added by the next
    // write, whatever that write is about.
    let id = team
        .save(None, mate("Nuni", None, false))
        .unwrap()
        .last()
        .unwrap()
        .id
        .clone();
    fs::write(home.join("team/team.json"), &team_json).unwrap();
    assert!(v1::list(&home).unwrap().iter().all(|t| t.id != id));
    let mut mina = team.seat(CHIEF).unwrap().0;
    mina.job = "Runs the office, briefly.".into();
    team.save(Some(CHIEF.into()), mina).unwrap();
    assert!(
        v1::list(&home).unwrap().iter().any(|t| t.id == id),
        "the next write repairs team.json"
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_soul_is_seeded_from_the_job_edited_by_the_owner_and_named_in_the_brief() {
    let Old { home, .. } = old_home();
    let team = Team::open(&home);
    // A teammate from before the move has no SOUL file yet: it reads as its job, and the read writes nothing.
    assert_eq!(team.soul_text(BOM).unwrap(), "Writes release notes.\n");
    assert!(!team.soul(BOM).exists());
    // Its brief seeds the file and names it.
    let (_, _, prompt) = team.brief(BOM, None).unwrap();
    assert_eq!(
        fs::read_to_string(team.soul(BOM)).unwrap(),
        "Writes release notes.\n"
    );
    assert!(
        prompt.contains(&format!("SOUL file: {}", team.soul(BOM).display())),
        "{prompt}"
    );
    assert_eq!(
        team.soul(BOM).parent(),
        team.memory(BOM).parent(),
        "beside MEMORY.md"
    );
    // The owner's edit is kept, and a later brief or save never writes over it.
    let reg = std::sync::Mutex::new(Sessions::open(&home).unwrap());
    let ask = |text: Option<&str>| {
        let op: Op =
            serde_json::from_value(serde_json::json!({"op": "bot_soul", "id": BOM, "text": text}))
                .unwrap();
        match window(&reg, &home, op) {
            Ok(Reply::BotSoul { id, text, .. }) => Ok((id, text)),
            Ok(_) => panic!("not a SOUL reply"),
            Err(e) => Err(e),
        }
    };
    let said = "I write for users.\r\nPlain words, no ticket numbers.  \n\n";
    assert_eq!(
        ask(Some(said)).unwrap().1,
        "I write for users.\nPlain words, no ticket numbers.\n"
    );
    team.brief(BOM, None).unwrap();
    let mut bom = team.seat(BOM).unwrap().0;
    bom.job = "Writes the changelog.".into();
    team.save(Some(BOM.into()), bom).unwrap();
    assert_eq!(
        ask(None).unwrap(),
        (
            BOM.to_string(),
            "I write for users.\nPlain words, no ticket numbers.\n".to_string()
        )
    );
    // Refused: nothing, too much, control characters, a bot that is not there, an id that is a path.
    assert!(ask(Some("  \n")).unwrap_err().contains("at least one line"));
    assert!(
        ask(Some(&"x".repeat(16 * 1024 + 1)))
            .unwrap_err()
            .contains("at most 16 KB")
    );
    assert!(
        ask(Some("a\u{1b}[2Jb"))
            .unwrap_err()
            .contains("no control characters")
    );
    assert_eq!(
        team.soul_save("nobody", "x").unwrap_err(),
        "no teammate nobody"
    );
    assert_eq!(
        team.soul_text("../../etc").unwrap_err(),
        "no teammate ../../etc"
    );
    // A new bot has its file from the start.
    let id = team
        .save(None, mate("Nuni", None, false))
        .unwrap()
        .last()
        .unwrap()
        .id
        .clone();
    assert_eq!(fs::read_to_string(team.soul(&id)).unwrap(), "Nuni's job.\n");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_team_list_reply_carries_the_bots_and_makes_no_file() {
    let Old { home, .. } = old_home();
    let reg = std::sync::Mutex::new(Sessions::open(&home).unwrap());
    let Reply::Team {
        teammates, bots, ..
    } = window(&reg, &home, Op::TeamList).unwrap()
    else {
        panic!("not a team reply")
    };
    assert_eq!(teammates.len(), 4);
    let ids: Vec<&str> = teammates.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(bots.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ids);
    assert!(
        !home.join("team/bots.json").exists(),
        "a window that connects moves nothing"
    );
    // As the window reads it.
    let json = serde_json::to_value(&bots[1]).unwrap();
    assert_eq!(json["seat"]["kind"], "lead");
    assert_eq!(json["face"], serde_json::to_value(face_of(LEAD)).unwrap());
    fs::remove_dir_all(home).unwrap();
}
