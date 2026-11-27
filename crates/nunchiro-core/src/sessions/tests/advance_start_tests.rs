//! Ticket 1081 part B, security round: the Reviewer the core starts (`advance::in_core`) is started as the lead's own
//! `task staff` start is, and only while its task is still due.
use super::*;
use crate::ledger::{Ledger, Task};

/// A change to the ledger between the plan and the start.
type Change = fn(&Ledger, &Path, &Task);

/// A live lead seat (teammate "lead", on `account`) and its open task in a team place.
fn lead_core(
    name: &str,
    account: Option<&str>,
) -> (std::sync::Mutex<Sessions>, PathBuf, String, Task) {
    let home = fs::canonicalize(scratch(name)).unwrap();
    approve_fake_claude(&home, &[]);
    if let Some(label) = account {
        let id = "0".repeat(8) + "-0000-4000-8000-0000000000aa";
        crate::accounts::real_folder(&home, crate::accounts::Agent::Claude, &id, true).unwrap();
        fs::write(
            home.join("accounts.toml"),
            format!("version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"{id}\"\nlabel = \"{label}\"\n"),
        )
        .unwrap();
    }
    let mut core = Sessions::open(&home).unwrap();
    let lead = cat_as(&mut core, &home, AgentKind::Claude);
    let meta = &mut core.entries.get_mut(&lead).unwrap().meta;
    meta.teammate = Some("lead".into());
    meta.account = account.map(String::from);
    let ledger = Ledger::open(&home);
    ledger.set_place(&home, Some("team"), None, None).unwrap();
    let task = ledger
        .make(&home, Some("lead"), "tax", &[], false, 1)
        .unwrap()
        .0;
    (std::sync::Mutex::new(core), home, lead, task)
}
/// The start step of the core's Reviewer; a task with no worktree reads as revision "".
fn start(registry: &std::sync::Mutex<Sessions>, task: &Task, lead: &str) -> Response {
    crate::advance::in_core(
        registry,
        task,
        lead,
        "",
        Request::Start {
            session: StartSession {
                label: "Reviewer · tax".into(),
                ..claude_start(&task.place, &[])
            },
            folder: None,
            env: Default::default(),
            receipt: None,
        },
    )
}

// Review MUST 1: a lead on a named account gets its Reviewer on that account, never the owner's default (a launch on
// any other account is refused by `start_granted`, so nothing starts then).
#[test]
fn the_reviewer_starts_on_the_leads_account() {
    let (registry, home, lead, task) = lead_core("advance-account", Some("work"));
    let Ok(Reply::Started { session }) = start(&registry, &task, &lead) else {
        panic!("the Reviewer did not start on the lead's account");
    };
    let core = registry.lock().unwrap();
    let meta = &core.entries[&session.id].meta;
    assert_eq!(
        meta.account.as_deref(),
        Some("work"),
        "not the owner's default"
    );
    assert_eq!(meta.parent.as_deref(), Some(lead.as_str()));
    drop(core);
    end_handoff(registry, home);
}

// Review MUST 2: auto-advance turned off, the task closed, or the way changed to solo after the plan: nothing starts,
// and the first prompt is not typed either.
#[test]
fn a_task_no_longer_due_starts_no_reviewer() {
    let changes: [(&str, Change); 3] = [
        ("off", |l, p, _| {
            drop(l.set_place(p, None, None, Some(false)).unwrap())
        }),
        ("closed", |l, _, t| {
            drop(l.close(&t.id, "dropped", 2).unwrap())
        }),
        ("solo", |l, p, _| {
            drop(l.set_place(p, Some("solo"), None, None).unwrap())
        }),
    ];
    for (name, change) in changes {
        let (registry, home, lead, task) = lead_core(&format!("advance-due-{name}"), None);
        change(&Ledger::open(&home), &home, &task);
        let before = registry.lock().unwrap().entries.len();
        let refused = start(&registry, &task, &lead).unwrap_err();
        assert!(refused.starts_with("skipped: "), "{name}: {refused}");
        assert_eq!(registry.lock().unwrap().entries.len(), before, "{name}");
        let prompt = Request::AgentPrompt {
            id: lead.clone(),
            text: "review it".into(),
        };
        assert!(
            crate::advance::in_core(&registry, &task, &lead, "", prompt).is_err(),
            "{name}"
        );
        end_handoff(registry, home);
    }
}

/// Security look 3: what an act's plan read (a builder and a Reviewer seat on the task, the Reviewer's "changes"
/// verdict recorded for the task's revision "", its turn ended since its last input), then one fact changed.
type Fact = fn(&mut Sessions, &Ledger, &Task, &str, &str);
fn two_seats(
    name: &str,
) -> (
    std::sync::Mutex<Sessions>,
    PathBuf,
    String,
    Task,
    String,
    String,
) {
    let (registry, home, lead, task) = lead_core(name, None);
    let mut core = registry.lock().unwrap();
    let builder = cat_as(&mut core, &home, AgentKind::Claude);
    let reviewer = cat_as(&mut core, &home, AgentKind::Claude);
    let ledger = Ledger::open(&home);
    ledger
        .seat_on(&task.id, &builder, "Builder · tax", None, 1, &|_| true)
        .unwrap();
    ledger
        .seat_on(&task.id, &reviewer, "Reviewer · tax", None, 1, &|_| true)
        .unwrap();
    let task = ledger
        .review(
            &task.id,
            crate::ledger::Review {
                revision: String::new(),
                pass: false,
                note: "the test is missing".into(),
                by: reviewer.clone(),
                name: "Reviewer · tax".into(),
                at: 2,
            },
        )
        .unwrap();
    for event in ["UserPromptSubmit", "Stop"] {
        core.handle(Request::Hook {
            id: reviewer.clone(),
            event: event.into(),
            payload: serde_json::json!({}),
        })
        .unwrap();
    }
    core.touched.insert(reviewer.clone(), 0);
    drop(core);
    (registry, home, lead, task, builder, reviewer)
}
/// Every row typed into any session, and which sessions are live.
fn typed_and_live(core: &Sessions) -> (usize, Vec<String>) {
    let rows = core
        .entries
        .values()
        .map(|e| e.meta.send_queue.len() + e.meta.send_log.len())
        .sum();
    let mut live: Vec<String> = core
        .entries
        .values()
        .filter(|e| e.agent_live())
        .map(|e| e.meta.id.clone())
        .collect();
    live.sort();
    (rows, live)
}

#[test]
fn an_act_whose_facts_changed_since_the_plan_does_nothing() {
    let follow_up: Fact = |core, _, _, _, seat| {
        core.handle(Request::SendText {
            id: seat.into(),
            text: "one more thing\r".into(),
            seen: vec![],
            composer: false,
        })
        .unwrap();
        core.handle(Request::Hook {
            id: seat.into(),
            event: "UserPromptSubmit".into(),
            payload: serde_json::json!({}),
        })
        .unwrap();
    };
    let changes: [(&str, Fact); 4] = [
        ("follow-up", follow_up),
        ("off", |_, l, t, _, _| {
            drop(l.set_place(&t.place, None, None, Some(false)).unwrap())
        }),
        ("closed", |_, l, t, _, _| {
            drop(l.close(&t.id, "dropped", 3).unwrap())
        }),
        ("revoked", |core, _, _, lead, _| {
            core.entry(lead).unwrap().meta.token_origin = Some("token-revoked".into())
        }),
    ];
    for kind in ["nudge", "forward", "close"] {
        for (change, set) in changes {
            // A follow-up is no reason to hold a review's findings back.
            if change == "follow-up" && kind == "forward" {
                continue;
            }
            let name = format!("advance-act-{kind}-{change}");
            let (registry, home, lead, task, builder, reviewer) = two_seats(&name);
            let mut core = registry.lock().unwrap();
            let seat = if kind == "close" { &reviewer } else { &builder };
            let act = match kind {
                "nudge" => crate::advance::Act::Nudge {
                    seat: builder.clone(),
                    name: "Builder · tax".into(),
                    minutes: 20,
                },
                "forward" => crate::advance::Act::Forward {
                    seat: builder.clone(),
                    name: "Builder · tax".into(),
                    rev: String::new(),
                    round: 1,
                    line: "review round 1".into(),
                },
                _ => crate::advance::Act::Close {
                    seat: reviewer.clone(),
                    name: "Reviewer · tax".into(),
                },
            };
            let was = core.seat_facts(seat);
            let step = crate::advance::Step::Act {
                act: &act,
                was: &was,
                rev: Some(""),
            };
            assert_eq!(
                crate::advance::recheck(&core, &task, &lead, &step),
                Ok(()),
                "{name}: due as planned"
            );
            set(&mut core, &Ledger::open(&home), &task, &lead, seat);
            let before = typed_and_live(&core);
            let done =
                crate::advance::act(&mut core, &task, &lead, &act, &was, Some(""), &mut vec![]);
            assert!(
                done.as_ref().is_err_and(|e| e.starts_with("skipped: ")),
                "{name}: {done:?}"
            );
            assert_eq!(
                typed_and_live(&core),
                before,
                "{name}: nothing typed or closed"
            );
            drop(core);
            end_handoff(registry, home);
        }
    }
}

// Review NIT: the lead's token revoked after the plan: the core starts no Reviewer with its authority.
#[test]
fn a_revoked_lead_gets_no_reviewer_started() {
    let (registry, home, lead, task) = lead_core("advance-due-revoked", None);
    registry
        .lock()
        .unwrap()
        .entry(&lead)
        .unwrap()
        .meta
        .token_origin = Some("token-revoked".into());
    let before = registry.lock().unwrap().entries.len();
    let refused = start(&registry, &task, &lead).unwrap_err();
    assert!(refused.contains("token was revoked"), "{refused}");
    assert_eq!(registry.lock().unwrap().entries.len(), before);
    end_handoff(registry, home);
}

// Security look 4: input composed into the core's new Reviewer between its start and its first prompt, then
// auto-advance turned off: the prompt is not typed and the cleanup leaves the session open with its input. An
// untouched one is closed.
#[test]
fn an_unprompted_reviewer_the_user_typed_into_is_left_open() {
    for used in [true, false] {
        let (registry, home, lead, task) = lead_core(&format!("advance-unprompted-{used}"), None);
        let Ok(Reply::Started { session }) = start(&registry, &task, &lead) else {
            panic!("no Reviewer started");
        };
        let id = session.id;
        let was = registry.lock().unwrap().seat_facts(&id);
        if used {
            registry
                .lock()
                .unwrap()
                .composed
                .insert(id.clone(), "half a sentence".into());
        }
        Ledger::open(&home)
            .set_place(&home, None, None, Some(false))
            .unwrap();
        let prompt = Request::AgentPrompt {
            id: id.clone(),
            text: "review it".into(),
        };
        assert!(crate::advance::in_core(&registry, &task, &lead, "", prompt).is_err());
        crate::advance::unprompted(&registry, &home, &task, &lead, &id, &was);
        let core = registry.lock().unwrap();
        assert_eq!(core.entries[&id].agent_live(), used, "used: {used}");
        if used {
            assert_eq!(
                core.composed.get(&id).map(String::as_str),
                Some("half a sentence")
            );
        }
        drop(core);
        end_handoff(registry, home);
    }
}

/// Ticket 1120: two more Claude accounts, "official" and "other", in the registry; their folders.
fn two_accounts(home: &Path) -> (PathBuf, PathBuf) {
    let ids = [
        "0".repeat(8) + "-0000-4000-8000-0000000000b1",
        "0".repeat(8) + "-0000-4000-8000-0000000000b2",
    ];
    let folders: Vec<PathBuf> = ids
        .iter()
        .map(|id| {
            crate::accounts::real_folder(home, crate::accounts::Agent::Claude, id, true).unwrap()
        })
        .collect();
    fs::write(
        home.join("accounts.toml"),
        format!(
            "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"{}\"\nlabel = \"official\"\n[[accounts]]\nagent = \"claude\"\nid = \"{}\"\nlabel = \"other\"\n",
            ids[0], ids[1]
        ),
    )
    .unwrap();
    (folders[0].clone(), folders[1].clone())
}
fn task_ask(operation: &str, text: &str, project: Option<&Path>) -> Request {
    Request::Task {
        operation: operation.into(),
        id: None,
        text: text.into(),
        accept: vec![],
        project: project.map(Path::to_path_buf),
        path: None,
        session: None,
        cites: None,
        all: false,
        level: None,
        who: None,
        due: None,
        effort: None,
        package: None,
        why: None,
        account: None,
        after: vec![],
    }
}
/// The account a plan of `staff_plan` starts its seat on.
fn planned(
    registry: &std::sync::Mutex<Sessions>,
    home: &Path,
    task: &Task,
    account: Option<&str>,
) -> Result<Option<String>, String> {
    match crate::ledger::staff_plan(
        registry,
        home,
        task,
        "Reviewer",
        None,
        None,
        None,
        account.map(String::from),
    )? {
        Reply::Staff { session, .. } => Ok(session.account),
        _ => Err("no plan".into()),
    }
}
/// The start step of a seat on `account`, as the lead's own start and the core's Reviewer run it (`launch_as`, then
/// `start_granted`, with the lead as the caller).
fn start_on(
    registry: &std::sync::Mutex<Sessions>,
    task: &Task,
    lead: &str,
    account: Option<String>,
) -> Response {
    crate::advance::in_core(
        registry,
        task,
        lead,
        "",
        Request::Start {
            session: StartSession {
                label: "Reviewer · tax".into(),
                account,
                ..claude_start(&task.place, &[])
            },
            folder: None,
            env: Default::default(),
            receipt: None,
        },
    )
}

// Ticket 1120: the user sets the place's account; a lead (on its own default account) then staffs on it, with and
// without --account, and the core's Reviewer follows it. The seat runs in that account's config folder, and task show
// names the account.
#[test]
fn seats_start_on_the_place_account_the_user_set() {
    let (registry, home, lead, task) = lead_core("account-place", None);
    let (official, _) = two_accounts(&home);
    let caller = crate::grants::Caller {
        id: lead.clone(),
        project: home.clone(),
    };
    // Only the user sets it; an unknown label is refused with the list.
    let refused = crate::ledger::dispatch(
        &registry,
        Some(&caller),
        task_ask("account", "official", None),
    )
    .unwrap_err();
    assert!(refused.contains("only the user"), "{refused}");
    let unknown =
        crate::ledger::dispatch(&registry, None, task_ask("account", "nope", Some(&home)))
            .unwrap_err();
    assert!(unknown.contains("official, other"), "{unknown}");
    assert_eq!(
        planned(&registry, &home, &task, None).unwrap(),
        None,
        "no place account yet"
    );
    crate::ledger::dispatch(
        &registry,
        None,
        task_ask("account", "official", Some(&home)),
    )
    .unwrap();
    assert_eq!(
        Ledger::open(&home).place(&home).account.as_deref(),
        Some("official")
    );
    // The lead's staff without --account and the core's Reviewer plan the same: the place's account.
    assert_eq!(
        planned(&registry, &home, &task, None).unwrap().as_deref(),
        Some("official")
    );
    assert_eq!(
        planned(&registry, &home, &task, Some("official"))
            .unwrap()
            .as_deref(),
        Some("official")
    );
    let Ok(Reply::Started { session }) = start_on(&registry, &task, &lead, Some("official".into()))
    else {
        panic!("the seat did not start on the place's account");
    };
    let core = registry.lock().unwrap();
    let meta = &core.entries[&session.id].meta;
    assert_eq!(meta.account.as_deref(), Some("official"));
    assert_eq!(
        meta.config_dir.as_deref(),
        Some(official.as_path()),
        "the account's config folder"
    );
    drop(core);
    let ledger = Ledger::open(&home);
    let task = ledger
        .seat_on(&task.id, &session.id, "Reviewer · tax", None, 2, &|_| true)
        .unwrap();
    let view = crate::ledger::views(&registry, &home, vec![task.clone()])
        .unwrap()
        .remove(0);
    assert_eq!(
        view.accounts.get(&session.id).map(String::as_str),
        Some("official")
    );
    assert!(
        crate::ledger::lines(&view, true).contains(", on official)"),
        "{}",
        crate::ledger::lines(&view, true)
    );
    // `own` goes back to the lead's own account.
    crate::ledger::dispatch(&registry, None, task_ask("account", "own", Some(&home))).unwrap();
    assert_eq!(planned(&registry, &home, &task, None).unwrap(), None);
    end_handoff(registry, home);
}

// Ticket 1120: --account with an unknown label is refused with the labels; a registered label that is neither the
// lead's own nor the place's is still refused at the start (ACCOUNTPICK), and nothing starts.
#[test]
fn an_account_not_granted_to_the_place_is_refused() {
    let (registry, home, lead, task) = lead_core("account-refused", None);
    two_accounts(&home);
    let unknown = planned(&registry, &home, &task, Some("nope")).unwrap_err();
    assert!(unknown.contains("official, other"), "{unknown}");
    crate::ledger::dispatch(
        &registry,
        None,
        task_ask("account", "official", Some(&home)),
    )
    .unwrap();
    assert_eq!(
        planned(&registry, &home, &task, Some("other"))
            .unwrap()
            .as_deref(),
        Some("other")
    );
    let before = registry.lock().unwrap().entries.len();
    let refused = start_on(&registry, &task, &lead, Some("other".into())).unwrap_err();
    assert!(refused.contains("only on its own account"), "{refused}");
    assert_eq!(registry.lock().unwrap().entries.len(), before);
    end_handoff(registry, home);
}

// Ticket 1126: the owner's pick in the status bar (`accounts.default.claude`, an account id).
fn set_features(registry: &std::sync::Mutex<Sessions>, pairs: &[(&str, serde_json::Value)]) {
    registry
        .lock()
        .unwrap()
        .quit_settings(crate::api::LifetimePatch {
            features: Some(
                pairs
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
            ),
            ..Default::default()
        })
        .unwrap();
}
fn id_of(folder: &Path) -> String {
    folder.file_name().unwrap().to_str().unwrap().to_string()
}
fn lead_caller(lead: &str, home: &Path) -> crate::grants::Caller {
    crate::grants::Caller {
        id: lead.to_string(),
        project: home.to_path_buf(),
    }
}

// Ticket 1126: a lead (on "Your own") starts a session and a seat with no account named: both take the owner's
// default; the core's auto Reviewer (`staff_plan` with no account) plans the same. Naming the default is admitted,
// naming another registered label is still refused (ACCOUNTPICK), and a remote caller never gets the default.
#[test]
fn starts_without_an_account_take_the_owner_default() {
    let (registry, home, lead, task) = lead_core("account-default", None);
    let (official, other) = two_accounts(&home);
    let caller = lead_caller(&lead, &home);
    let start = |account: Option<&str>, remote: bool| {
        registry.lock().unwrap().launch_as(
            Some(&caller),
            StartSession {
                account: account.map(String::from),
                ..claude_start(&home, &[])
            },
            remote,
        )
    };
    assert_eq!(
        start(None, false).unwrap().start.account,
        None,
        "no default yet: the lead's own"
    );
    assert_eq!(planned(&registry, &home, &task, None).unwrap(), None);
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!(id_of(&other)))],
    );
    assert_eq!(
        start(None, false).unwrap().start.account.as_deref(),
        Some("other")
    );
    assert!(
        start(Some("other"), false).is_ok(),
        "the default is admitted"
    );
    let Err(refused) = start(Some("official"), false) else {
        panic!("a label neither own, place nor default was admitted");
    };
    assert!(refused.contains("only on its own account"), "{refused}");
    assert_eq!(
        start(None, true).unwrap().start.account,
        None,
        "a remote caller never gets it"
    );
    assert!(start(Some("other"), true).is_err());
    // A shell and an ACP session have no account.
    let shell = registry
        .lock()
        .unwrap()
        .launch_as(
            Some(&caller),
            StartSession {
                kind: AgentKind::Shell,
                ..claude_start(&home, &[])
            },
            false,
        )
        .unwrap();
    assert_eq!(shell.start.account, None);
    // The staffed seat and the core's Reviewer plan on the default and start there.
    assert_eq!(
        planned(&registry, &home, &task, None).unwrap().as_deref(),
        Some("other")
    );
    let Ok(Reply::Started { session }) = start_on(&registry, &task, &lead, Some("other".into()))
    else {
        panic!("the seat did not start on the default");
    };
    {
        let core = registry.lock().unwrap();
        let meta = &core.entries[&session.id].meta;
        assert_eq!(meta.account.as_deref(), Some("other"));
        assert_eq!(meta.config_dir.as_deref(), Some(other.as_path()));
    }
    // The place account the owner set (1120) wins over the default.
    crate::ledger::dispatch(
        &registry,
        None,
        task_ask("account", "official", Some(&home)),
    )
    .unwrap();
    assert_eq!(
        planned(&registry, &home, &task, None).unwrap().as_deref(),
        Some("official")
    );
    assert_eq!(
        start(None, false).unwrap().start.account.as_deref(),
        Some("official")
    );
    let _ = official;
    end_handoff(registry, home);
}

// Codex security look P2 (round 3): the owner's own start (`nunchiro session start` without --account, a schedule, a
// team start: no caller) takes the status bar's pick too; a named account and a resume keep theirs.
#[test]
fn an_owner_start_without_an_account_takes_the_default() {
    let (registry, home, _lead, _task) = lead_core("account-default-owner", None);
    let (_official, other) = two_accounts(&home);
    let owner = |account: Option<&str>, resume: Option<&str>| {
        registry
            .lock()
            .unwrap()
            .launch_as(
                None,
                StartSession {
                    account: account.map(String::from),
                    resume: resume.map(String::from),
                    ..claude_start(&home, &[])
                },
                false,
            )
            .unwrap()
            .start
            .account
            .clone()
    };
    assert_eq!(owner(None, None), None, "no pick: Your own");
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!(id_of(&other)))],
    );
    assert_eq!(owner(None, None).as_deref(), Some("other"));
    assert_eq!(owner(Some("official"), None).as_deref(), Some("official"));
    assert_eq!(
        owner(Some(""), None).as_deref(),
        Some(""),
        "Your own, named"
    );
    assert_eq!(
        owner(None, Some("conv-1")),
        None,
        "a resume keeps its account"
    );
    let shell = registry
        .lock()
        .unwrap()
        .launch_as(
            None,
            StartSession {
                kind: AgentKind::Shell,
                ..claude_start(&home, &[])
            },
            false,
        )
        .unwrap();
    assert_eq!(shell.start.account, None);
    // An explicit "Your own" pick stays Your own.
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!("own"))],
    );
    assert_eq!(owner(None, None), None);
    end_handoff(registry, home);
}

// Ticket 1126: a launch prepared on the default is refused at the start when the owner changed the default meanwhile
// (read again under the session lock); a session cannot write the default or any of the near-limit keys.
#[test]
fn a_default_changed_after_launch_is_refused_and_no_session_writes_it() {
    let (registry, home, lead, _task) = lead_core("account-default-late", None);
    let (official, other) = two_accounts(&home);
    let caller = lead_caller(&lead, &home);
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!(id_of(&other)))],
    );
    let launch = registry
        .lock()
        .unwrap()
        .launch_as(Some(&caller), claude_start(&home, &[]), false)
        .unwrap()
        .prepare()
        .unwrap();
    assert_eq!(launch.account.as_deref(), Some("other"));
    set_features(
        &registry,
        &[(
            "accounts.default.claude",
            serde_json::json!(id_of(&official)),
        )],
    );
    let before = registry.lock().unwrap().entries.len();
    let Err(refused) = registry
        .lock()
        .unwrap()
        .start_granted(&caller, &launch, false)
    else {
        panic!("a launch on the old default started");
    };
    assert!(refused.contains("only on its own account"), "{refused}");
    assert_eq!(registry.lock().unwrap().entries.len(), before);
    for key in [
        "default",
        "auto_switch",
        "hold",
        "near",
        "switched",
        "all_near",
    ] {
        let patch = crate::api::LifetimePatch {
            features: Some([(format!("accounts.{key}.claude"), serde_json::json!("x"))].into()),
            ..Default::default()
        };
        let asked = Request::QuitSettings { patch };
        assert!(
            registry
                .lock()
                .unwrap()
                .check_agent(&caller, &asked)
                .is_err(),
            "a session wrote accounts.{key}.claude"
        );
    }
    // Round 4: the card's level is the owner's too.
    let patch = crate::api::LifetimePatch {
        features: Some(
            [(
                crate::account_near::NEAR_PERCENT.to_string(),
                serde_json::json!(50),
            )]
            .into(),
        ),
        ..Default::default()
    };
    let asked = Request::QuitSettings { patch };
    assert!(
        registry
            .lock()
            .unwrap()
            .check_agent(&caller, &asked)
            .is_err(),
        "a session wrote accounts.near_percent"
    );
    end_handoff(registry, home);
}

// Ticket 1126 round 4 (owner 2026-11-25 "사용자가 용량을 지정할수 있게"): the card shows at the owner's level, not below
// it; unset or outside 50..=99 is 98.
#[test]
fn the_card_shows_at_the_owners_level() {
    let (registry, home, _lead, _task) = lead_core("account-near-level", None);
    let (official, _other) = two_accounts(&home);
    let main = id_of(&official);
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!(main))],
    );
    let now = 1_000;
    let card_at = |week: f64, level: Option<serde_json::Value>, at: i64| {
        set_features(
            &registry,
            &[(
                crate::account_near::NEAR_PERCENT,
                level.unwrap_or(serde_json::Value::Null),
            )],
        );
        let told = serde_json::json!({
            "seven_day": {"used_percentage": week, "resets_at": now + 86_400},
        });
        crate::usage::observe_status(&home, Some(&official), &told, at);
        let mut core = registry.lock().unwrap();
        let weekly = crate::account_near::claude_weekly(&home);
        crate::account_near::check(
            &mut core,
            &home,
            crate::accounts::Agent::Claude,
            &weekly,
            now,
        );
        core.feature::<serde_json::Value>("accounts.near.claude")
            .is_some()
    };
    use serde_json::json;
    assert!(!card_at(97.0, None, now), "unset: 98, 97% shows nothing");
    assert!(card_at(98.0, None, now + 1), "unset: 98");
    assert!(!card_at(79.0, Some(json!(80)), now + 2), "below the level");
    assert!(card_at(80.0, Some(json!(80)), now + 3), "at the level");
    for bad in [json!(49), json!(100), json!("80"), json!(-5)] {
        assert!(!card_at(80.0, Some(bad.clone()), now + 4), "{bad} is 98");
    }
    assert!(
        card_at(98.0, Some(json!(100)), now + 5),
        "out of range is 98"
    );
    end_handoff(registry, home);
}

// Ticket 1126: 98% of the week writes the card's record and switches nothing; the 5-hour share alone never does. No
// usage source moves the default by itself (Codex security looks P1, rounds 2 and 3): only the owner's click does.
#[test]
fn the_weekly_limit_shows_the_card_and_never_switches() {
    let (registry, home, lead, _task) = lead_core("account-near", None);
    let (official, other) = two_accounts(&home);
    let (main, next) = (id_of(&official), id_of(&other));
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!(main))],
    );
    let now = 1_000;
    let told = |five: f64, week: f64| {
        serde_json::json!({
            "five_hour": {"used_percentage": five, "resets_at": now + 3_600},
            "seven_day": {"used_percentage": week, "resets_at": now + 86_400},
        })
    };
    let check = || {
        let mut core = registry.lock().unwrap();
        let weekly = crate::account_near::claude_weekly(&home);
        crate::account_near::check(
            &mut core,
            &home,
            crate::accounts::Agent::Claude,
            &weekly,
            now,
        );
    };
    let feature = |k: &str| registry.lock().unwrap().feature::<serde_json::Value>(k);
    crate::usage::observe_status(&home, Some(&official), &told(99.0, 50.0), now);
    check();
    assert_eq!(
        feature("accounts.near.claude"),
        None,
        "the 5-hour share never shows the card"
    );
    crate::usage::observe_status(&home, Some(&official), &told(10.0, 98.0), now + 100);
    check();
    let near = feature("accounts.near.claude").expect("the card's record");
    assert_eq!(
        (
            near["id"].as_str(),
            near["next"].as_str(),
            near["used"].as_u64()
        ),
        (Some(main.as_str()), Some(next.as_str()), Some(98))
    );
    assert_eq!(
        feature("accounts.default.claude"),
        Some(serde_json::json!(main)),
        "off: nothing switches"
    );
    // Codex security look P1: with the owner's switch on, Claude's 98% (only ever what its sessions' status lines
    // told, here the lead's own forged hook on "Your own") gives the card and never moves the default.
    let real = crate::queue::now_ms() as i64 / 1000;
    set_features(
        &registry,
        &[
            ("accounts.auto_switch.claude", serde_json::json!(true)),
            ("accounts.default.claude", serde_json::json!("own")),
        ],
    );
    let forged = registry.lock().unwrap().handle(Request::Hook {
        id: lead.clone(),
        event: "StatusLine".into(),
        payload: serde_json::json!({"rate_limits": {
            "seven_day": {"used_percentage": 98.0, "resets_at": real + 86_400},
        }}),
    });
    assert!(forged.is_ok(), "{forged:?}");
    assert_eq!(
        feature("accounts.default.claude"),
        Some(serde_json::json!("own")),
        "a status line never moves the default"
    );
    assert_eq!(feature("accounts.switched.claude"), None);
    let near = feature("accounts.near.claude").expect("the card");
    assert_eq!(near["id"].as_str(), Some("own"));
    // Codex security look P1 (round 3): Codex's numbers come from rollouts, files a session can write too. A forged
    // 98% rollout on the Codex default, read by the window's usage read, gives the card and never moves the default,
    // even with an `accounts.auto_switch.codex` left on.
    let codex = ["c1", "c2"].map(|n| format!("00000000-0000-4000-8000-0000000000{n}"));
    let first = crate::accounts::real_folder(&home, crate::accounts::Agent::Codex, &codex[0], true)
        .unwrap();
    crate::accounts::real_folder(&home, crate::accounts::Agent::Codex, &codex[1], true).unwrap();
    let registry_toml = fs::read_to_string(home.join("accounts.toml")).unwrap();
    fs::write(
        home.join("accounts.toml"),
        format!(
            "{registry_toml}[[accounts]]\nagent = \"codex\"\nid = \"{}\"\nlabel = \"codex-one\"\n[[accounts]]\nagent = \"codex\"\nid = \"{}\"\nlabel = \"codex-two\"\n",
            codex[0], codex[1]
        ),
    )
    .unwrap();
    set_features(
        &registry,
        &[
            ("accounts.default.codex", serde_json::json!(codex[0])),
            ("accounts.auto_switch.codex", serde_json::json!(true)),
        ],
    );
    let day = first.join("sessions/2026/11/25");
    fs::create_dir_all(&day).unwrap();
    let forged = serde_json::json!({
        "timestamp": "2026-11-25T00:00:00Z",
        "type": "event_msg",
        "payload": {"type": "token_count", "rate_limits": {"secondary": {
            "used_percent": 98.0, "window_minutes": 10_080, "resets_at": real + 86_400,
        }}},
    });
    fs::write(
        day.join("rollout-2026-11-25T00-00-00-forged.jsonl"),
        format!("{forged}\n"),
    )
    .unwrap();
    let mut budget = crate::usage::Budget::request();
    budget.limits_only = true;
    let rows = crate::usage::rows(&home, &|_| None, real, &|_| 0, &mut budget)
        .map(|rows| Reply::AccountUsage { rows });
    crate::account_near::after_usage(&registry, &home, &rows, real);
    assert_eq!(
        feature("accounts.default.codex"),
        Some(serde_json::json!(codex[0])),
        "a rollout never moves the default"
    );
    assert_eq!(feature("accounts.switched.codex"), None);
    let near = feature("accounts.near.codex").expect("the card");
    assert_eq!(
        (
            near["id"].as_str(),
            near["next"].as_str(),
            near["used"].as_u64()
        ),
        (Some(codex[0].as_str()), Some(codex[1].as_str()), Some(98))
    );
    let _ = (main, next);
    end_handoff(registry, home);
}

// Round 2 review MUST 1: the owner's explicit "Your own" pick reaches a lead that runs on another account: a session
// it starts, its staffed seat and the core's Reviewer all start on "Your own" (no label), and the start is admitted.
#[test]
fn an_explicit_your_own_default_reaches_a_lead_on_another_account() {
    let (registry, home, lead, task) = lead_core("account-default-own", Some("work"));
    let caller = lead_caller(&lead, &home);
    let new_one = || {
        registry
            .lock()
            .unwrap()
            .launch_as(Some(&caller), claude_start(&home, &[]), false)
    };
    assert_eq!(
        new_one().unwrap().start.account.as_deref(),
        Some("work"),
        "no pick: the lead's own"
    );
    set_features(
        &registry,
        &[("accounts.default.claude", serde_json::json!("own"))],
    );
    let launch = new_one().unwrap().prepare().unwrap();
    assert_eq!(launch.account, None);
    let session = registry
        .lock()
        .unwrap()
        .start_granted(&caller, &launch, false)
        .unwrap();
    assert_eq!(
        registry.lock().unwrap().entries[&session.id].meta.account,
        None
    );
    assert_eq!(planned(&registry, &home, &task, None).unwrap(), None);
    let Ok(Reply::Started { session }) = start(&registry, &task, &lead) else {
        panic!("the core's Reviewer did not start on Your own");
    };
    {
        let core = registry.lock().unwrap();
        let meta = &core.entries[&session.id].meta;
        assert_eq!(
            (meta.account.as_deref(), meta.config_dir.as_deref()),
            (None, None)
        );
    }
    // A remote caller never gets the default: it stays on "Your own" by its own rule, and names no other label.
    assert!(
        registry
            .lock()
            .unwrap()
            .launch_as(
                Some(&caller),
                StartSession {
                    account: Some("work".into()),
                    ..claude_start(&home, &[])
                },
                true
            )
            .is_err()
    );
    end_handoff(registry, home);
}

// Owner 2026-11-25 ("적용하고"): "Leads may use any of my accounts". Off, a lead is held to own/place/default; on, the
// lead's own seat starts on any registered account and the room says so; a worker under it and a remote caller stay
// refused; a session asking to turn it on gets the owner's card, and only the owner's yes turns it on.
#[test]
fn leads_may_use_any_account_only_when_the_owner_turned_it_on() {
    let (registry, home, lead, task) = lead_core("account-lead-any", None);
    two_accounts(&home);
    // The lead's seat belongs to a teammate that leads this place.
    let mate = crate::team::Team::open(&home)
        .save(
            None,
            crate::team::Teammate {
                id: String::new(),
                name: "Lead".into(),
                job: "Leads the place.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: Some(home.clone()),
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    registry
        .lock()
        .unwrap()
        .entries
        .get_mut(&lead)
        .unwrap()
        .meta
        .teammate = Some(mate.id.clone());
    let caller = lead_caller(&lead, &home);
    let named = |who: &crate::grants::Caller, remote: bool| {
        registry.lock().unwrap().launch_as(
            Some(who),
            StartSession {
                account: Some("official".into()),
                ..claude_start(&home, &[])
            },
            remote,
        )
    };
    assert!(
        named(&caller, false).is_err(),
        "off: a lead is held to own, place and default"
    );
    // A session asks to turn it on: a card for the owner, not the setting.
    let on = crate::api::LifetimePatch {
        features: Some(
            [(
                crate::accounts::LEADS_ANY.to_string(),
                serde_json::json!(true),
            )]
            .into(),
        ),
        ..Default::default()
    };
    let asked = Request::QuitSettings { patch: on };
    let item = match registry.lock().unwrap().ask_owner(&caller, &asked) {
        Some(Ok(Reply::Waiting { item })) => item,
        other => panic!("no owner card: {other:?}"),
    };
    assert!(
        registry
            .lock()
            .unwrap()
            .check_agent(&caller, &asked)
            .is_err()
    );
    assert_eq!(
        registry
            .lock()
            .unwrap()
            .feature::<bool>(crate::accounts::LEADS_ANY),
        None
    );
    // The owner's yes on the card turns it on.
    registry
        .lock()
        .unwrap()
        .handle(Request::Answer {
            item,
            answer: crate::queue::Answer::AllowOnce,
            confirmed: false,
        })
        .unwrap();
    assert_eq!(
        registry
            .lock()
            .unwrap()
            .feature::<bool>(crate::accounts::LEADS_ANY),
        Some(true)
    );
    assert!(
        named(&caller, false).is_ok(),
        "on: the lead names any registered account"
    );
    assert!(named(&caller, true).is_err(), "a remote caller never");
    // A worker under the lead stays on own, place and default.
    let worker = {
        let mut core = registry.lock().unwrap();
        let id = cat_as(&mut core, &home, AgentKind::Claude);
        core.entries.get_mut(&id).unwrap().meta.parent = Some(lead.clone());
        id
    };
    assert!(
        named(&lead_caller(&worker, &home), false).is_err(),
        "a worker is refused"
    );
    // Codex security look P2: the room line is written first; a full room refuses the start, so no session runs on
    // the other account without its line.
    let _ = &task;
    let launch = named(&caller, false).unwrap().prepare().unwrap();
    let place = mate.project.clone().unwrap();
    let room = crate::room::Log::open(&home, &place);
    fs::create_dir_all(room.dir()).unwrap();
    let log = room.dir().join("log.jsonl");
    fs::write(&log, " ".repeat(crate::room::LOG_MAX_BYTES as usize) + "\n").unwrap();
    let before = registry.lock().unwrap().entries.len();
    let Err(refused) = registry
        .lock()
        .unwrap()
        .start_granted(&caller, &launch, false)
    else {
        panic!("a lead's start ran without its room line");
    };
    assert!(refused.contains("room line"), "{refused}");
    assert_eq!(registry.lock().unwrap().entries.len(), before);
    fs::remove_file(&log).unwrap();
    // With room, the lead's start runs on the account and writes one room line.
    let session = registry
        .lock()
        .unwrap()
        .start_granted(&caller, &launch, false)
        .unwrap();
    assert_eq!(
        registry.lock().unwrap().entries[&session.id]
            .meta
            .account
            .as_deref(),
        Some("official")
    );
    let lines: Vec<String> = crate::room::Log::open(&home, &place)
        .read()
        .unwrap()
        .into_iter()
        .map(|m| m.body)
        .filter(|b| b.contains("on account official"))
        .collect();
    assert_eq!(lines.len(), 1, "{lines:?}");
    end_handoff(registry, home);
}
