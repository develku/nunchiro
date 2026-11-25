use super::*;
use crate::api::Request;

#[test]
fn next_at_is_strictly_later_local_time() {
    let utc = |_: i64| 0;
    assert_eq!(next_at("00:00", 0, &utc).unwrap(), DAY_MS);
    assert_eq!(next_at("21:00", 0, &utc).unwrap(), 21 * 3_600_000);
    // UTC+10: 21:00 local is 11:00 UTC.
    assert_eq!(next_at("21:00", 0, &|_| 36_000).unwrap(), 11 * 3_600_000);
    for bad in ["9:00", "24:00", "12:60", "ab:cd", ""] {
        assert!(next_at(bad, 0, &utc).is_err(), "{bad}");
    }
}

fn run(dir: &Path) -> Run {
    Run {
        kind: AgentKind::Claude,
        project: dir.to_path_buf(),
        label: String::new(),
        model: None,
        effort: None,
        task: None,
        teammate: None,
        level: None,
    }
}
fn known(dir: &Path) -> BTreeSet<String> {
    BTreeSet::from([dir.to_string_lossy().into_owned()])
}
fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nunchiro-sched-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}
fn day_s(y: i64, m: i64, d: i64) -> i64 {
    crate::usage::days_from_civil(y, m, d) * 86_400
}

/// Ticket 991 C4: a path through a link (macOS /var -> /private/var) is saved resolved, and that stored path
/// still passes the fire-time check; once the folder is swapped for a link, the check refuses it.
/// C3: `replace` swaps one entry for the edited one in the same write.
#[test]
fn linked_path_is_saved_resolved_and_replace_edits_in_place() {
    let utc = |_: i64| 0;
    let dir = home("linked");
    let real = dir.join("real");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();
    let mut all = Schedules::load(&dir);
    let made = all
        .add(
            run(&dir.join("link")),
            "21:00".into(),
            true,
            None,
            &known(&real),
            0,
            &utc,
        )
        .unwrap();
    assert_eq!(made.run.project, real);
    known_project(&made.run.project, &known(&real)).unwrap();
    let edited = all
        .add(
            run(&real),
            "22:00".into(),
            true,
            Some(&made.id),
            &known(&real),
            0,
            &utc,
        )
        .unwrap();
    let left = all.list().unwrap();
    assert_eq!(
        (left.len(), left[0].id.as_str(), left[0].at.as_str()),
        (1, edited.id.as_str(), "22:00")
    );
    assert!(
        all.add(
            run(&real),
            "22:00".into(),
            true,
            Some("gone"),
            &known(&real),
            0,
            &utc
        )
        .is_err()
    );
    assert_eq!(
        all.list().unwrap().len(),
        1,
        "a failed edit changes nothing"
    );
    std::fs::rename(&real, dir.join("moved")).unwrap();
    std::os::unix::fs::symlink(dir.join("moved"), &real).unwrap();
    assert!(known_project(&made.run.project, &known(&real)).is_err());
}

/// 2026-11-05 18:00 at UTC+9 is 09:00 UTC: it fires then, once; a restart in between keeps it. Look 11-17 v8
/// (Home S2-C): fired, it stays listed and switched off, never fires again by itself (nor after a restart), cannot
/// be switched on for its passed date, and an edit to a later time arms it again.
#[test]
fn dated_once_fires_on_its_date_and_survives_restart() {
    let kst = |_: i64| 32_400;
    let dir = home("dated");
    let fire_ms = (day_s(2026, 11, 5) + 9 * 3600) as u64 * 1000;
    let added = Schedules::load(&dir)
        .add(
            run(&dir),
            "2026-11-05 18:00".into(),
            false,
            None,
            &known(&dir),
            0,
            &kst,
        )
        .unwrap();
    assert_eq!(added.next_ms, fire_ms);
    let mut again = Schedules::load(&dir);
    assert!(again.take_due(fire_ms - 1, &kst).is_empty());
    assert_eq!(again.take_due(fire_ms, &kst).len(), 1);
    let ran = Last {
        session: Some("s1".into()),
        at: fire_ms,
        result: None,
        reason: None,
    };
    again.record(&added, ran.clone());
    let mut after = Schedules::load(&dir);
    let listed = after.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].paused, listed[0].daily, &listed[0].last),
        (true, false, &Some(ran.clone()))
    );
    assert!(after.take_due(fire_ms + DAY_MS, &kst).is_empty());
    assert!(after.pause(&added.id, false, fire_ms + 1, &kst).is_err());
    let edit = |all: &mut Schedules, old: &str, at: &str, now| {
        all.add(
            run(&dir),
            at.into(),
            false,
            Some(old),
            &known(&dir),
            now,
            &kst,
        )
    };
    assert!(
        edit(&mut after, &added.id, "2026-11-05 18:00", fire_ms + 1).is_err(),
        "the same passed time"
    );
    let armed = edit(&mut after, &added.id, "2026-11-06 18:00", fire_ms + 1).unwrap();
    assert_eq!(
        (armed.paused, armed.next_ms, &armed.last),
        (false, fire_ms + DAY_MS, &Some(ran)),
        "on again, with its last run"
    );
    // A once entry the user switched off before its time is still off after an edit.
    after.pause(&armed.id, true, fire_ms + 2, &kst).unwrap();
    let still = edit(&mut after, &armed.id, "2026-11-07 18:00", fire_ms + 3).unwrap();
    assert!(still.paused, "the user's own switch");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The offset of the picked date counts, not the offset today (US Eastern, DST ends 2026-11-01).
#[test]
fn dated_once_uses_the_offset_on_that_date() {
    let change = day_s(2026, 11, 1) + 6 * 3600;
    let eastern = move |t: i64| if t < change { -14_400 } else { -18_000 };
    let ms = dated_ms("2026-11-05 18:00", &eastern).unwrap().unwrap();
    assert_eq!(ms, (day_s(2026, 11, 5) + 23 * 3600) * 1000);
}

#[test]
fn past_or_impossible_dates_are_refused() {
    let dir = home("refused");
    let mut all = Schedules::load(&dir);
    let now = day_s(2026, 11, 9) as u64 * 1000;
    let utc = |_: i64| 0;
    for past in ["2026-11-08 23:59", "2026-11-09 00:00", "0001-01-01 00:00"] {
        let refused = all.add(run(&dir), past.into(), false, None, &known(&dir), now, &utc);
        assert_eq!(
            refused.unwrap_err(),
            "schedule date is in the past",
            "{past}"
        );
    }
    for bad in [
        "2026-02-31 10:00",
        "2026-13-01 10:00",
        "2026-1-01 10:00",
        "+026-11-10 10:00",
        "2026-11-10 25:00",
        "2026-11-10 ",
        "2026-11-10 10:00 x",
    ] {
        assert!(
            all.add(run(&dir), bad.into(), false, None, &known(&dir), now, &utc)
                .is_err(),
            "{bad}"
        );
    }
    assert!(
        all.add(
            run(&dir),
            "2026-11-10 10:00".into(),
            true,
            None,
            &known(&dir),
            now,
            &utc
        )
        .is_err(),
        "a daily schedule has no date"
    );
    assert!(all.list().unwrap().is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A file written before dates existed: bare `HH:MM`, once. It loads, and fires at its stored time.
#[test]
fn stored_once_without_a_date_still_loads_and_fires() {
    let dir = home("legacy");
    let key = key(&dir.join(KEY)).unwrap();
    let mut old = Entry {
        id: "old1".into(),
        run: run(&dir),
        at: "21:00".into(),
        daily: false,
        next_ms: 5_000,
        mac: String::new(),
        days: vec![],
        paused: false,
        last: None,
        earlier: vec![],
    };
    old.mac = mac_of(&key, &old);
    let file = serde_json::json!({"version": 1, "schedules": [old]});
    std::fs::write(dir.join(FILE), file.to_string()).unwrap();
    let mut all = Schedules::load(&dir);
    assert_eq!(all.list().unwrap().len(), 1);
    assert_eq!(all.take_due(5_000, &|_| 0)[0].id, "old1");
    assert!(all.take_due(9_000, &|_| 0).is_empty(), "once");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Q9 ja-J12-1: an entry whose model a later release retired loads with the rest; only its own run is refused.
#[test]
fn a_retired_model_fails_its_run_not_the_file() {
    let dir = home("retired");
    let key = key(&dir.join(KEY)).unwrap();
    let mut old = Entry {
        id: "old1".into(),
        run: Run {
            model: Some("retired-model".into()),
            ..run(&dir)
        },
        at: "21:00".into(),
        daily: true,
        next_ms: 5_000,
        mac: String::new(),
        days: vec![],
        paused: false,
        last: None,
        earlier: vec![],
    };
    old.mac = mac_of(&key, &old);
    let file = serde_json::json!({"version": 1, "schedules": [old]});
    std::fs::write(dir.join(FILE), file.to_string()).unwrap();
    let mut all = Schedules::load(&dir);
    assert_eq!(all.list().unwrap().len(), 1);
    all.add(
        run(&dir),
        "22:00".into(),
        true,
        None,
        &known(&dir),
        0,
        &|_| 0,
    )
    .unwrap();
    let due = all.take_due(5_000, &|_| 0);
    assert_eq!(due[0].run.check_model().unwrap_err(), "unknown model");
    all.remove("old1").unwrap();
    assert_eq!(Schedules::load(&dir).list().unwrap().len(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 981: tasks can be long, so a write that would pass the read limit is refused and the file still loads.
#[test]
fn a_write_over_the_read_limit_is_refused_and_the_file_still_loads() {
    let dir = home("big");
    let utc = |_: i64| 0;
    let mut all = Schedules::load(&dir);
    let big = Run {
        task: Some("\u{1F600}".repeat(TASK_MAX)),
        ..run(&dir)
    };
    let mut kept = 0;
    let refused = loop {
        match all.add(
            big.clone(),
            "21:00".into(),
            true,
            None,
            &known(&dir),
            0,
            &utc,
        ) {
            Ok(_) => kept += 1,
            Err(e) => break e,
        }
    };
    assert!(refused.contains("would be too large"), "{refused}");
    assert!(kept > 10 && kept < MAX_ENTRIES, "{kept}");
    assert_eq!(Schedules::load(&dir).list().unwrap().len(), kept);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 993: a file from before days, the switch and the last run loads as it is, reads as "every day, on,
/// never ran", and an entry that uses none of them is written with none of them (so its bytes and MAC stay).
#[test]
fn a_file_from_before_days_and_pause_loads_unchanged() {
    let dir = home("old-file");
    let made = Schedules::load(&dir)
        .add(
            run(&dir),
            "21:00".into(),
            true,
            None,
            &known(&dir),
            0,
            &|_| 0,
        )
        .unwrap();
    // The file as the earlier build wrote it: these six keys and no other.
    let old = serde_json::json!({"version": 1, "schedules": [{
        "id": made.id, "run": made.run, "at": "21:00", "daily": true, "next_ms": made.next_ms, "mac": made.mac,
    }]});
    let bytes = serde_json::to_vec_pretty(&old).unwrap();
    std::fs::write(dir.join(FILE), &bytes).unwrap();
    let all = Schedules::load(&dir);
    let e = &all.list().unwrap()[0];
    assert_eq!(
        (e.days.as_slice(), e.paused, &e.last),
        (&[][..], false, &None)
    );
    assert_eq!(
        std::fs::read(dir.join(FILE)).unwrap(),
        bytes,
        "a load writes nothing"
    );
    let text = serde_json::to_string(e).unwrap();
    for key in ["days", "paused", "last"] {
        assert!(!text.contains(key), "{text}");
    }
    // Days are under the MAC: a hand-edit of them is refused as any other.
    let mut edited = old.clone();
    edited["schedules"][0]["days"] = serde_json::json!([1]);
    std::fs::write(dir.join(FILE), edited.to_string()).unwrap();
    assert!(Schedules::load(&dir).list().is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 993: the day is the user's local day. Monday 00:30 at UTC+9 is Sunday 15:30 UTC; Friday 23:30 at UTC-5
/// is Saturday 04:30 UTC, and after it the next weekday run is Monday's.
#[test]
fn weekly_and_weekdays_follow_the_local_day() {
    let ms = |y, m, d, h: i64, min: i64| ((day_s(y, m, d) + h * 3600 + min * 60) * 1000) as u64;
    let kst = |_: i64| 32_400;
    let sunday_utc = ms(2026, 11, 15, 15, 0); // Monday 00:00 in Seoul
    assert_eq!(
        next_on("00:30", &[1], sunday_utc, &kst).unwrap(),
        ms(2026, 11, 15, 15, 30)
    );
    // Just after it ran: the next Monday, seven days on.
    assert_eq!(
        next_on("00:30", &[1], ms(2026, 11, 15, 15, 30), &kst).unwrap(),
        ms(2026, 11, 22, 15, 30)
    );
    let est = |_: i64| -18_000;
    let friday_evening = ms(2026, 11, 14, 1, 0); // Friday 20:00 in New York
    let weekdays = [1, 2, 3, 4, 5];
    assert_eq!(
        next_on("23:30", &weekdays, friday_evening, &est).unwrap(),
        ms(2026, 11, 14, 4, 30)
    );
    assert_eq!(
        next_on("23:30", &weekdays, ms(2026, 11, 14, 4, 30), &est).unwrap(),
        ms(2026, 11, 17, 4, 30),
        "Saturday and Sunday are skipped"
    );
    assert_eq!(
        next_on("09:00", &[], 0, &|_| 0).unwrap(),
        9 * 3_600_000,
        "no days: every day"
    );

    // Through the store: a weekly entry fires on its day and moves a week on; days are checked on the way in.
    let dir = home("weekly");
    let mut all = Schedules::load(&dir);
    let when = |days: &[u8], daily| When {
        at: "00:30".into(),
        daily,
        days: days.to_vec(),
    };
    let made = all
        .add_on(
            run(&dir),
            when(&[1], true),
            None,
            &known(&dir),
            sunday_utc,
            &kst,
        )
        .unwrap();
    assert_eq!(made.next_ms, ms(2026, 11, 15, 15, 30));
    assert!(all.take_due(made.next_ms - 1, &kst).is_empty());
    assert_eq!(all.take_due(made.next_ms, &kst).len(), 1);
    assert_eq!(all.list().unwrap()[0].next_ms, ms(2026, 11, 22, 15, 30));
    assert_eq!(
        Schedules::load(&dir).list().unwrap()[0].days,
        [1],
        "days survive a reload"
    );
    for (days, daily) in [
        (&[7][..], true),
        (&[2, 1], true),
        (&[1, 1], true),
        (&[1], false),
    ] {
        assert!(
            all.add_on(run(&dir), when(days, daily), None, &known(&dir), 0, &kst)
                .is_err(),
            "{days:?} {daily}"
        );
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 993: a switched-off entry is never due and keeps its place; switched on again it runs at its next time
/// from then, not for the time it missed. An edit keeps the switch.
// Ticket 1040 (Locate): a moved project's schedule follows it switched off, signed as it is now, and another
// project's is as it was.
#[test]
fn a_located_projects_schedule_moves_paused_and_still_loads() {
    let utc = |_: i64| 0;
    let dir = home("located").canonicalize().unwrap();
    let (old, new) = (dir.join("old"), dir.join("new"));
    std::fs::create_dir_all(&old).unwrap();
    let mut all = Schedules::load(&dir);
    let known = BTreeSet::from([
        old.to_string_lossy().into_owned(),
        dir.to_string_lossy().into_owned(),
    ]);
    let run_in = |p: &Path| Run {
        project: p.to_path_buf(),
        ..run(&dir)
    };
    let mine = all
        .add(run_in(&old), "21:00".into(), true, None, &known, 0, &utc)
        .unwrap();
    let other = all
        .add(run_in(&dir), "21:00".into(), true, None, &known, 0, &utc)
        .unwrap();
    all.locate(&old, &new).unwrap();
    for all in [&all, &Schedules::load(&dir)] {
        let list = all.list().unwrap();
        let of = |id: &str| list.iter().find(|e| e.id == id).unwrap();
        assert_eq!(
            (&of(&mine.id).run.project, of(&mine.id).paused),
            (&new, true)
        );
        assert_eq!(
            (&of(&other.id).run.project, of(&other.id).paused),
            (&dir, false)
        );
    }
    // At 21:00 only the other project's runs: the moved one is switched off.
    let due = all.take_due(21 * 3_600_000, &utc);
    assert_eq!(due.iter().map(|e| &e.id).collect::<Vec<_>>(), [&other.id]);
}

#[test]
fn a_paused_entry_does_not_run_and_resumes_at_its_next_time() {
    let utc = |_: i64| 0;
    let dir = home("paused");
    let mut all = Schedules::load(&dir);
    let daily = all
        .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
        .unwrap();
    let once = all
        .add(
            run(&dir),
            "1970-01-01 22:00".into(),
            false,
            None,
            &known(&dir),
            0,
            &utc,
        )
        .unwrap();
    for e in [&daily, &once] {
        all.pause(&e.id, true, 0, &utc).unwrap();
    }
    let day3 = 3 * DAY_MS;
    assert!(all.take_due(day3, &utc).is_empty());
    assert_eq!(
        all.list().unwrap().len(),
        2,
        "a paused once entry is not dropped"
    );
    assert!(
        Schedules::load(&dir)
            .list()
            .unwrap()
            .iter()
            .all(|e| e.paused)
    );
    all.pause(&daily.id, false, day3, &utc).unwrap();
    let on = all
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.id == daily.id)
        .unwrap();
    assert_eq!((on.paused, on.next_ms), (false, day3 + 21 * 3_600_000));
    assert!(
        all.take_due(day3 + 1, &utc).is_empty(),
        "the missed days do not run"
    );
    // A date that passed while it was off cannot be switched on; it says what to do.
    let refused = all.pause(&once.id, false, day3, &utc).unwrap_err();
    assert!(
        refused.contains("in the past: change its time or remove it"),
        "{refused}"
    );
    assert!(all.pause("gone", true, 0, &utc).is_err());
    // An edit of a paused entry stays paused and keeps its last run.
    all.pause(&daily.id, true, day3, &utc).unwrap();
    all.record(
        &daily,
        Last {
            session: Some("s1".into()),
            at: 7,
            result: None,
            reason: None,
        },
    );
    let edited = all
        .add(
            run(&dir),
            "22:00".into(),
            true,
            Some(&daily.id),
            &known(&dir),
            day3,
            &utc,
        )
        .unwrap();
    assert!(edited.paused);
    assert_eq!(edited.last.unwrap().session.as_deref(), Some("s1"));
    // A failed last run does not outlive the edit that answers it.
    all.follow("s1", Some("working"), "failed");
    let again = all
        .add(
            run(&dir),
            "23:00".into(),
            true,
            Some(&edited.id),
            &known(&dir),
            day3,
            &utc,
        )
        .unwrap();
    assert_eq!((again.paused, again.last), (true, None));
    // Switched off is under the entry's MAC: it loads again as it is, and a file edit that switches it on is an
    // entry this core did not write (it would run unattended work the owner stopped).
    assert!(Schedules::load(&dir).list().unwrap()[0].paused);
    let file = std::fs::read_to_string(dir.join(FILE)).unwrap();
    assert!(file.contains("\"paused\": true"));
    std::fs::write(
        dir.join(FILE),
        file.replace("\"paused\": true", "\"paused\": false"),
    )
    .unwrap();
    let forged = Schedules::load(&dir).list().unwrap_err();
    assert!(forged.contains("was not written by this core"), "{forged}");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 993: the last run is recorded, a once entry that fired is switched off (with its reason when it could
/// not start), and the result follows the session's state changes.
#[test]
fn the_last_run_is_recorded_and_follows_its_session() {
    let utc = |_: i64| 0;
    let dir = home("last");
    let mut all = Schedules::load(&dir);
    let daily = all
        .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
        .unwrap();
    let once = all
        .add(
            run(&dir),
            "22:00".into(),
            false,
            None,
            &known(&dir),
            0,
            &utc,
        )
        .unwrap();
    // Both within 2 h of their time (21:00 and 22:00): neither is skipped.
    assert_eq!(all.take_due(22 * 3_600_000 + 1, &utc).len(), 2);
    let failed = |why: &str| Last {
        session: None,
        at: DAY_MS,
        result: Some(Outcome::Failed),
        reason: Some(why.into()),
    };
    all.record(&once, failed("Lister is no longer a teammate"));
    all.record(
        &daily,
        Last {
            session: Some("s1".into()),
            at: DAY_MS,
            result: None,
            reason: None,
        },
    );
    let get = |all: &Schedules, id: &str| {
        all.list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == id)
            .unwrap()
    };
    let back = get(&all, &once.id);
    assert!(back.paused, "it does not run again by itself");
    assert_eq!(back.last, Some(failed("Lister is no longer a teammate")));
    // Its MAC covers "switched off" now, so it is not the fired entry's; the file loads again with it.
    let again = Schedules::load(&dir).list().unwrap();
    assert!(again.iter().any(|e| e.id == once.id && e.paused));
    // An entry removed meanwhile keeps no note.
    let gone = Entry {
        id: "other".into(),
        ..once.clone()
    };
    all.record(
        &gone,
        Last {
            session: Some("s9".into()),
            at: 1,
            result: None,
            reason: None,
        },
    );
    assert_eq!(all.list().unwrap().len(), 2);

    let result = |all: &Schedules| get(all, &daily.id).last.unwrap().result;
    all.follow("s1", None, "waiting"); // the new session's first state: its task is on its way
    assert_eq!(result(&all), None);
    all.follow("s1", Some("waiting"), "working");
    assert_eq!(result(&all), None);
    all.follow("s1", Some("working"), "permission");
    assert_eq!(result(&all), Some(Outcome::NeedsYou));
    all.follow("s1", Some("permission"), "working");
    assert_eq!(result(&all), None);
    all.follow("s1", Some("working"), "waiting");
    assert_eq!(result(&all), Some(Outcome::Finished));
    all.follow("s1", Some("waiting"), "exited");
    assert_eq!(
        result(&all),
        Some(Outcome::Finished),
        "ended after its turn: still finished"
    );
    all.follow("s1", Some("exited"), "working");
    all.follow("s1", Some("working"), "ended");
    let last = get(&all, &daily.id).last.unwrap();
    assert_eq!(last.result, Some(Outcome::Failed));
    assert_eq!(
        last.reason.as_deref(),
        Some("the session ended before the task was done")
    );
    all.follow("s1", Some("ended"), "working");
    all.follow("s1", None, "lost"); // the next app start finds it stopped mid-run
    assert_eq!(
        get(&all, &daily.id).last.unwrap().reason.as_deref(),
        Some("interrupted when the app closed")
    );
    all.follow("s1", Some("lost"), "working");
    all.follow("s1", Some("working"), "failed");
    assert_eq!(
        get(&all, &daily.id).last.unwrap().reason.as_deref(),
        Some("the session failed")
    );
    // Another session's change touches nothing, and the file reloads with what was recorded.
    all.follow("s2", Some("working"), "waiting");
    assert_eq!(
        get(&Schedules::load(&dir), &daily.id).last.unwrap().result,
        Some(Outcome::Failed)
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 993: the words of `schedule propose --when`, and how a card says a time.
#[test]
fn when_parses_the_four_forms_and_reads_in_words() {
    let when = |words: &str| When::parse(words).unwrap();
    assert_eq!(
        when("daily 21:00"),
        When {
            at: "21:00".into(),
            daily: true,
            days: vec![]
        }
    );
    assert_eq!(when("weekdays 09:00").days, [1, 2, 3, 4, 5]);
    assert_eq!(when("weekly Monday 09:00").days, [1]);
    assert_eq!(when("weekly sun 00:05").days, [0]);
    assert_eq!(
        when("once 2026-11-19 09:00"),
        When {
            at: "2026-11-19 09:00".into(),
            daily: false,
            days: vec![]
        }
    );
    for bad in [
        "",
        "21:00",
        "hourly 21:00",
        "weekly 09:00",
        "weekly someday 09:00",
        "weekly mo 09:00",
        "once 09:00",
        "daily 21:00 x",
    ] {
        assert!(When::parse(bad).is_err(), "{bad}");
    }
    for (words, says) in [
        ("daily 21:00", "Every day 9:00 PM"),
        ("weekdays 09:00", "Weekdays 9:00 AM"),
        ("weekly monday 00:05", "Mondays 12:05 AM"),
        ("once 2026-11-19 12:00", "Once, 2026-11-19 12:00 PM"),
    ] {
        assert_eq!(when(words).words(), says);
    }
    let two = When {
        at: "09:00".into(),
        daily: true,
        days: vec![1, 3],
    };
    assert_eq!(two.words(), "Mon, Wed 9:00 AM");
}

/// RFC 4231 test case 2.
/// Ticket 994: a teammate's schedule may be on an ACP agent (the teammate's); a plain one still may not.
#[test]
fn only_a_teammates_schedule_runs_an_acp_agent() {
    let acp = |teammate: Option<&str>| Run {
        kind: AgentKind::Acp,
        task: Some("sort".into()),
        teammate: teammate.map(Into::into),
        ..run(Path::new("/tmp"))
    };
    acp(Some("0123456789abcdef0123456789abcdef"))
        .check()
        .unwrap();
    assert_eq!(
        acp(None).check().unwrap_err(),
        "a schedule runs Claude or Codex only"
    );
}
#[test]
fn hmac_sha256_matches_rfc4231() {
    let mac: String = hmac(b"Jefe", b"what do ya want for nothing?")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        mac,
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}

/// Ticket 1002: a run more than 2 h late is skipped and logged, its time moves on, and it never fires for that
/// time; one under 2 h late runs once, however many of its times passed. The MAC stays what the owner made.
#[test]
fn a_late_run_is_skipped_and_logged_and_a_near_one_runs_once() {
    let utc = |_: i64| 0;
    let hour = 3_600_000;
    let dir = home("late");
    let mut all = Schedules::load(&dir);
    let made = all
        .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
        .unwrap();
    let mac = all.list().unwrap()[0].mac.clone();
    // Asleep from 21:00 to 00:01 the next day: skipped, and the next time is tomorrow's 21:00.
    assert!(all.take_due(24 * hour + 60_000, &utc).is_empty());
    let e = Schedules::load(&dir).list().unwrap()[0].clone();
    let last = e.last.clone().unwrap();
    assert_eq!(
        (last.result, last.session, last.at),
        (Some(Outcome::Skipped), None, 24 * hour + 60_000)
    );
    assert_eq!(e.next_ms, DAY_MS + 21 * hour);
    assert_eq!(e.mac, mac, "a skip is outside the MAC");
    // Days missed, the last one 1 h ago: one run, not one per day.
    let now = 4 * DAY_MS + 22 * hour;
    let due = all.take_due(now, &utc);
    assert_eq!(
        due.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        [made.id.as_str()]
    );
    assert!(all.take_due(now, &utc).is_empty());
    // Exactly 2 h late still runs; a once entry more than 2 h late is switched off, skipped.
    let next = all.list().unwrap()[0].next_ms;
    assert_eq!(all.take_due(next + LATE_MS, &utc).len(), 1);
    let once = all
        .add(
            run(&dir),
            "23:00".into(),
            false,
            None,
            &known(&dir),
            now,
            &utc,
        )
        .unwrap();
    assert!(all.take_due(once.next_ms + LATE_MS + 1, &utc).is_empty());
    let e = all
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.id == once.id)
        .unwrap();
    assert!(e.paused);
    assert_eq!(e.last.unwrap().result, Some(Outcome::Skipped));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 1002: the run log keeps the 9 runs before the last one, newest first, and an edit keeps it.
#[test]
fn the_run_log_keeps_earlier_runs_newest_first() {
    let utc = |_: i64| 0;
    let dir = home("runlog");
    let mut all = Schedules::load(&dir);
    let made = all
        .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
        .unwrap();
    let ran = |at| Last {
        session: Some(format!("s{at}")),
        at,
        result: Some(Outcome::Finished),
        reason: None,
    };
    for at in 1..=12 {
        all.record(&made, ran(at));
    }
    let e = Schedules::load(&dir).list().unwrap()[0].clone();
    assert_eq!(e.last, Some(ran(12)));
    assert_eq!(
        e.earlier.iter().map(|l| l.at).collect::<Vec<_>>(),
        (3..=11).rev().collect::<Vec<_>>()
    );
    let edited = all
        .add(
            run(&dir),
            "22:00".into(),
            true,
            Some(&made.id),
            &known(&dir),
            0,
            &utc,
        )
        .unwrap();
    assert_eq!(edited.earlier.len(), EARLIER_MAX, "an edit keeps the log");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Ticket 1002 lane 3: the Home lead's two briefs arrive once, switched off, and the key is set; with the key
/// cleared they are not added a second time; a removed one does not come back while the key is set.
#[test]
fn brief_presets_arrive_once_and_paused() {
    let utc = |_: i64| 0;
    let dir = home("presets");
    let mut core = Sessions::open(&dir).unwrap();
    seed_presets(&mut core, 0, &utc);
    assert!(
        core.schedules.list().unwrap().is_empty(),
        "no Home lead yet"
    );
    let lead = crate::team::Team::open(&dir)
        .save(
            None,
            crate::team::Teammate {
                id: String::new(),
                name: "Chief".into(),
                job: "Chief of staff.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: None,
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    seed_presets(&mut core, 0, &utc);
    seed_presets(&mut core, 0, &utc);
    let all = core.schedules.list().unwrap();
    assert_eq!(all.len(), 2);
    for e in &all {
        assert!(e.paused, "arrives switched off");
        assert_eq!(e.run.teammate.as_deref(), Some(lead.id.as_str()));
        assert_eq!(e.days, [1, 2, 3, 4, 5]);
    }
    assert_eq!(
        all.iter().map(|e| e.at.as_str()).collect::<Vec<_>>(),
        ["08:30", "18:00"]
    );
    assert_eq!(core.feature::<bool>(PRESETS_KEY), Some(true));
    assert!(
        core.schedules.take_due(u64::MAX / 2, &utc).is_empty(),
        "never runs while off"
    );
    // A key write lost: the next pass adds nothing twice.
    let clear = crate::api::LifetimePatch {
        features: Some([(PRESETS_KEY.to_string(), serde_json::Value::Null)].into()),
        ..Default::default()
    };
    core.quit_settings(clear).unwrap();
    seed_presets(&mut core, 0, &utc);
    assert_eq!(core.schedules.list().unwrap().len(), 2);
    // The owner removes one: it stays removed.
    core.schedules.remove(&all[0].id).unwrap();
    seed_presets(&mut core, 0, &utc);
    assert_eq!(core.schedules.list().unwrap().len(), 1);
    drop(core);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The browser role and agents never reach a schedule request.
#[test]
fn browser_role_refuses_schedule() {
    let add = Request::ScheduleAdd {
        run: Run {
            kind: AgentKind::Claude,
            project: "/tmp".into(),
            label: String::new(),
            model: None,
            effort: None,
            task: None,
            teammate: None,
            level: None,
        },
        at: "21:00".into(),
        daily: true,
        replace: None,
        days: vec![],
    };
    for r in [
        add,
        Request::ScheduleList,
        Request::ScheduleRemove { id: "x".into() },
        Request::ScheduleRunNow { id: "x".into() },
        Request::SchedulePause {
            id: "x".into(),
            paused: true,
        },
    ] {
        assert!(!crate::http::browser::request_allowed(&r), "{r:?}");
    }
}
