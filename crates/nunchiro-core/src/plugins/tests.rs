use super::*;

fn home(tag: &str) -> PathBuf {
    let h = std::env::temp_dir().join(format!("ns-plg-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&h);
    fs::create_dir_all(&h).unwrap();
    h.canonicalize().unwrap()
}
const BASE: &str = "id = \"x\"\nname = \"X\"\nversion = \"1.0.0\"\n";

#[test]
fn a_starter_with_every_part_parses_and_is_one_unapproved_subject() {
    let h = home("new");
    let dir = scaffold(&h, "x", &PARTS).unwrap();
    let p = read(&h, "x").unwrap();
    assert_eq!((p.panel.len(), p.command.len(), p.setting.len()), (1, 1, 1));
    assert!(
        fs::read_to_string(dir.join(MANIFEST))
            .unwrap()
            .starts_with("#:schema ")
    );
    let view = approval::status(&h, "plugin:x").unwrap();
    assert_eq!(view.state, approval::State::Unapproved);
    assert_eq!(view.manifest.kind, "plugin");
    assert_eq!(view.cli, "nunchiro plugin allow x");
    // A part carries the plugin's hash and its own argv.
    let part = approval::trial(&h, "plugin__x__main").unwrap();
    assert_eq!(part.hash(), view.hash);
    assert_eq!(part.argv(), ["/bin/sh", "panel.sh"]);
    assert!(
        scaffold(&h, "x", &[])
            .unwrap_err()
            .contains("already exists")
    );
    assert!(
        scaffold(&h, "y", &["trigger"])
            .unwrap_err()
            .contains("unknown part")
    );
    fs::remove_dir_all(&h).unwrap();
}

#[test]
fn approval_covers_every_part_and_a_change_stops_them() {
    let h = home("appr");
    let dir = scaffold(&h, "x", &PARTS).unwrap();
    let view = approval::status(&h, "plugin:x").unwrap();
    assert!(
        approval::check(&h, "plugin__x__hello")
            .unwrap_err()
            .contains("not approved")
    );
    approval::grant(&h, "plugin:x", approval::Level::Read, &view.hash).unwrap();
    assert_eq!(
        approval::check(&h, "plugin__x__hello").unwrap().argv(),
        ["/bin/sh", "command.sh"]
    );
    assert!(approval::grant(&h, "plugin:x", approval::Level::Act, &view.hash).is_err());
    // Its script alone changes: it asks for nothing new, so it stays approved.
    fs::write(dir.join("command.sh"), "#!/bin/sh\necho changed\n").unwrap();
    assert_eq!(
        approval::status(&h, "plugin:x").unwrap().state,
        approval::State::Approved
    );
    // A new part is new access: every part stops until it is approved again.
    let toml = dir.join("plugin.toml");
    let text = fs::read_to_string(&toml).unwrap();
    fs::write(&toml, format!("{text}\n[[command]]\nname = \"more\"\ncommand = [\"/bin/sh\", \"x.sh\"]\nshow = \"note\"\n")).unwrap();
    assert_eq!(
        approval::status(&h, "plugin:x").unwrap().state,
        approval::State::Changed
    );
    assert!(
        approval::check(&h, "plugin__x__main")
            .unwrap_err()
            .contains("changed")
    );
    fs::remove_dir_all(&h).unwrap();
}

#[test]
fn bad_manifests_are_refused_with_one_sentence() {
    let cases = [
        ("unknown = 1\n", "unknown field"),
        (
            "[[command]]\nname = \"a\"\ncommand = [\"/bin/sh\", \"../x.sh\"]\n",
            "outside",
        ),
        (
            "[[command]]\nname = \"a\"\ncommand = [\"/Users/me/x.sh\"]\n",
            "outside",
        ),
        (
            "[[command]]\nname = \"a\"\ncommand = \"echo hi\"\n",
            "invalid plugin.toml",
        ),
        (
            "[[command]]\nname = \"a\"\ncommand = [\"/bin/sh\", \"-c\", \"echo hi\"]\n",
            "inline",
        ),
        (
            "[[panel]]\nname = \"a\"\nkind = \"web\"\nentry = \"../a.html\"\n",
            "web needs",
        ),
        (
            "[[setting]]\nkey = \"k\"\nlabel = \"K\"\ntype = \"time\"\ndefault = \"25:00\"\n",
            "default",
        ),
        (
            "[[setting]]\nkey = \"k\"\nlabel = \"K\"\ntype = \"choice\"\n",
            "needs choices",
        ),
        (
            "[[command]]\nname = \"a\"\ncommand = [\"a.sh\"]\n[[panel]]\nname = \"a\"\nkind = \"script\"\ncommand = [\"a.sh\"]\n",
            "two panels",
        ),
    ];
    for (extra, want) in cases {
        let err = parse(&format!("{BASE}{extra}"), "x").unwrap_err();
        assert!(err.contains(want), "{extra}: {err}");
        assert!(!err.contains('\n'), "{err}");
    }
    assert!(parse(BASE, "y").unwrap_err().contains("folder's name"));
}

#[test]
fn settings_are_checked_by_type_and_reach_the_input() {
    let h = home("set");
    scaffold(&h, "x", &["setting", "command"]).unwrap();
    let p = read(&h, "x").unwrap();
    assert_eq!(values(&h, &p)["greeting"], "Hello");
    let s = &p.setting[0];
    assert!(value(s, &Value::from(3)).is_err());
    let mut store = load(&h);
    store
        .settings
        .entry("x".into())
        .or_default()
        .insert("greeting".into(), "Hi".into());
    store.on.insert("x".into());
    save(&h, &store).unwrap();
    let input: Value = serde_json::from_slice(
        &input(
            &h,
            &approval::trial(&h, "plugin__x__hello").unwrap(),
            &widgets::Context::default(),
            None,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(input["settings"]["greeting"], "Hi");
    assert_eq!(
        (input["event"].as_str(), input["part"].as_str()),
        (Some("command"), Some("hello"))
    );
    assert!(on(&h, "plugin__x__hello").is_ok());
    assert!(on(&h, "plugin__y__hello").unwrap_err().contains("off"));
    fs::remove_dir_all(&h).unwrap();
}

#[test]
fn only_plugins_that_are_on_show_their_panels() {
    let h = home("pan");
    scaffold(&h, "x", &["panel"]).unwrap();
    assert!(panels(&h).is_empty());
    let mut store = load(&h);
    store.on.insert("x".into());
    save(&h, &store).unwrap();
    let rows = panels(&h);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "plugin__x__main");
    assert_eq!(rows[0].state, Some(approval::State::Unapproved));
    let listed = list(&h, false, false);
    assert_eq!(listed[0].needs.as_deref(), Some("script_widgets"));
    fs::remove_dir_all(&h).unwrap();
}

/// docs/api/plugin.schema.json: the manifest's JSON Schema, written like the API schema
/// (`NUNCHIRO_UPDATE_API_SCHEMA=1` rewrites it).
#[test]
fn plugin_schema_is_current() {
    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/api/plugin.schema.json"
    );
    let mut schema = serde_json::to_value(
        schemars::generate::SchemaSettings::draft2020_12()
            .into_generator()
            .into_root_schema_for::<Plugin>(),
    )
    .unwrap();
    schema["$id"] = SCHEMA_URL.into();
    schema["title"] = "Nunchiro plugin.toml".into();
    let text = serde_json::to_string_pretty(&schema).unwrap() + "\n";
    if std::env::var_os("NUNCHIRO_UPDATE_API_SCHEMA").is_some() {
        fs::write(file, &text).unwrap();
    }
    assert!(
        fs::read_to_string(file).unwrap_or_default() == text,
        "docs/api/plugin.schema.json is out of date; run NUNCHIRO_UPDATE_API_SCHEMA=1 cargo test -p nunchiro-core plugin_schema_is_current"
    );
}

/// The example in docs/api/examples/plugins passes the same checks as a starter.
#[test]
fn the_example_plugin_parses() {
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/api/examples/plugins/quiet-hours/plugin.toml"
    );
    let p = parse(&fs::read_to_string(dir).unwrap(), "quiet-hours").unwrap();
    assert!(!p.panel.is_empty() && !p.command.is_empty() && p.setting.len() >= 2);
}

#[test]
fn a_link_in_the_folder_is_refused() {
    let h = home("lnk");
    let dir = scaffold(&h, "x", &["command"]).unwrap();
    fs::remove_file(dir.join("command.sh")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", dir.join("command.sh")).unwrap();
    let err = approval::status(&h, "plugin:x").unwrap_err();
    assert!(err.contains("symlink"), "{err}");
    fs::remove_dir_all(&h).unwrap();
}

/// `plugin__x___c` would read as plugin `x`, part `_c`: an id ending in `_` could be approved and turned on but never
/// run, and a prefix stop for `x` would reach it. Refused where an id is read and made.
#[test]
fn an_id_ending_in_underscore_is_refused() {
    let err = parse("id = \"x_\"\nname = \"X\"\nversion = \"1.0.0\"\n", "x_").unwrap_err();
    assert!(err.contains("invalid plugin id"), "{err}");
    let h = home("und");
    assert!(
        scaffold(&h, "x_", &[])
            .unwrap_err()
            .contains("invalid plugin id")
    );
    fs::remove_dir_all(&h).unwrap();
}

/// A task seat's prompt gets a header before the checked words (`with_notes`): its send row still names the plugin.
#[test]
fn a_replacement_is_found_behind_a_task_header() {
    replaced().lock().unwrap().push(Pending {
        sender: "lead".into(),
        to: "seat".into(),
        text: "Words a plugin chose.".into(),
        replaced: crate::delivery::Replaced {
            plugin: "Guard".into(),
            original: "raw".into(),
        },
        at: std::time::Instant::now(),
    });
    let content = "Task t1: tidy\n\nWords a plugin chose.";
    assert_eq!(
        take_replaced("lead", "seat", content)
            .map(|r| r.plugin)
            .as_deref(),
        Some("Guard")
    );
    assert!(
        take_replaced("lead", "seat", content).is_none(),
        "taken once"
    );
}
