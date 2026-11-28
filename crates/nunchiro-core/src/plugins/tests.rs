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
    // It has a check, so its script alone changing asks again (a check reads every message agents send).
    fs::write(dir.join("command.sh"), "#!/bin/sh\necho changed\n").unwrap();
    assert_eq!(
        approval::status(&h, "plugin:x").unwrap().state,
        approval::State::Changed
    );
    // A new part is new access too: every part stops until it is approved again.
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

const SKILL: &str = "---\nname: review\ndescription: Review a change before it is pushed.\n---\n\n# Review\n\nRead the diff and list what is missing.\n";
/// Every file under `dir`, relative and sorted.
fn tree(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                todo.push(e.path());
            } else {
                out.push(
                    e.path()
                        .strip_prefix(dir)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    out.sort();
    out
}

#[test]
fn an_approved_skill_reaches_claude_as_its_skill_md_alone() {
    let h = home("skl");
    let dir = skills::test_plugin(&h, SKILL, false);
    // Not approved yet: nothing reaches a session.
    assert!(skills::claude_skill_flags(&h).is_empty());
    let p = read(&h, "sk").unwrap();
    assert!(access(&p).contains("skill review instructs Claude sessions"));
    assert!(
        hash_only(&p),
        "a skill instructs every new session: any change asks again"
    );
    let view = approval::status(&h, "plugin:sk").unwrap();
    assert!(
        view.extras
            .contains(&"skill review instructs Claude sessions".to_string()),
        "{:?}",
        view.extras
    );
    approval::grant(&h, "plugin:sk", approval::Level::Read, &view.hash).unwrap();
    let flags: Vec<String> = skills::claude_skill_flags(&h)
        .into_iter()
        .map(|o| o.into_string().unwrap())
        .collect();
    assert_eq!(flags.len(), 2, "{flags:?}");
    assert_eq!(flags[0], "--plugin-dir");
    let folder = PathBuf::from(&flags[1]);
    assert!(
        folder.starts_with(&h) && !folder.starts_with(&dir),
        "{}",
        folder.display()
    );
    // Only SKILL.md and the core's own plugin.json: not the plugin's script, hooks, MCP file or plugin.json.
    assert_eq!(
        tree(&folder),
        [".claude-plugin/plugin.json", "skills/review/SKILL.md"]
    );
    assert_eq!(
        fs::read_to_string(folder.join("skills/review/SKILL.md")).unwrap(),
        SKILL
    );
    // The copy is named by the whole approved hash, and rebuilt from the approved bytes at every start: a file planted
    // in it, or the folder swapped for a link, never reaches Claude.
    let hash = approval::status(&h, "plugin:sk").unwrap().hash;
    assert_eq!(
        folder.file_name().unwrap().to_string_lossy(),
        format!("sk-{hash}")
    );
    fs::create_dir_all(folder.join("hooks")).unwrap();
    fs::write(folder.join("hooks/hooks.json"), "{}").unwrap();
    fs::write(folder.join(".mcp.json"), "{}").unwrap();
    fs::write(
        folder.join("skills/review/SKILL.md"),
        "---\nname: review\nhooks: x\n---\n",
    )
    .unwrap();
    assert_eq!(skills::claude_skill_flags(&h).len(), 2);
    assert_eq!(
        tree(&folder),
        [".claude-plugin/plugin.json", "skills/review/SKILL.md"]
    );
    assert_eq!(
        fs::read_to_string(folder.join("skills/review/SKILL.md")).unwrap(),
        SKILL
    );
    let elsewhere = h.join("elsewhere");
    fs::create_dir_all(elsewhere.join("hooks")).unwrap();
    fs::write(elsewhere.join("hooks/hooks.json"), "{}").unwrap();
    fs::remove_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &folder).unwrap();
    assert_eq!(skills::claude_skill_flags(&h).len(), 2);
    assert!(!folder.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(
        tree(&folder),
        [".claude-plugin/plugin.json", "skills/review/SKILL.md"]
    );
    assert!(
        elsewhere.join("hooks/hooks.json").exists(),
        "the link's target is left alone"
    );
    // The review sheet shows the text that will instruct Claude.
    let view = approval::status(&h, "plugin:sk").unwrap();
    assert_eq!(view.skills.len(), 1);
    assert_eq!(
        (view.skills[0].name.as_str(), view.skills[0].text.as_str()),
        ("review", SKILL)
    );
    // Edited: nothing until it is approved again.
    fs::write(
        dir.join("skills/review/SKILL.md"),
        SKILL.replace("missing", "risky"),
    )
    .unwrap();
    assert!(skills::claude_skill_flags(&h).is_empty());
    let view = approval::status(&h, "plugin:sk").unwrap();
    approval::grant(&h, "plugin:sk", approval::Level::Read, &view.hash).unwrap();
    assert_eq!(skills::claude_skill_flags(&h).len(), 2);
    // Off: the next start has none.
    turn_off(&h, "sk").unwrap();
    assert!(skills::claude_skill_flags(&h).is_empty());
    fs::remove_dir_all(&h).unwrap();
}

#[test]
fn a_skill_that_could_run_a_command_is_refused() {
    for (n, (md, why)) in [
        // Claude runs a skill's frontmatter hooks while it is active, and a `!` line's command when it loads.
        (
            "---\nname: review\ndescription: x\nhooks:\n  PreToolUse: []\n---\nbody\n",
            "hooks",
        ),
        (
            "---\nname: review\ndescription: x\nallowed-tools: Bash\n---\nbody\n",
            "allowed-tools",
        ),
        (
            "---\nname: review\ndescription: x\n---\nThe log: !`git log -1`\n",
            "!`",
        ),
        // Claude also runs a fenced block that opens with ```!, and its own escape helper treats `! the same way.
        (
            "---\nname: review\ndescription: x\n---\n```!\ngit log -1\n```\n",
            "!`",
        ),
        (
            "---\nname: review\ndescription: x\n---\nSee `!git log`.\n",
            "!`",
        ),
        // A line break YAML reads but `lines()` does not, or a tab Claude turns into spaces, hides a key.
        (
            "---\nname: review\ndescription: x\rhooks:\r  PreToolUse: []\n---\nbody\n",
            "control",
        ),
        (
            "---\nname: review\ndescription: x\u{85}hooks: []\n---\nbody\n",
            "control",
        ),
        (
            "---\nname: review\ndescription: x\u{2028}hooks: []\n---\nbody\n",
            "hidden",
        ),
        (
            "---\nname: review\ndescription: x\u{2029}hooks: []\n---\nbody\n",
            "hidden",
        ),
        (
            "---\nname: review\ndescription: x\n\thooks: []\n---\nbody\n",
            "control",
        ),
        ("---\nname: \"review'\ndescription: x\n---\nbody\n", "name"),
        ("---\nname: other\ndescription: x\n---\nbody\n", "name"),
        ("# no frontmatter\n", "frontmatter"),
        (
            "---\nname: review\ndescription: x\n---\nhidden\u{E0041}\n",
            "hidden",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let h = home(&format!("skx{n}"));
        skills::test_plugin(&h, md, false);
        let e = approval::status(&h, "plugin:sk").unwrap_err();
        assert!(e.contains(why), "{why}: {e}");
        assert!(skills::claude_skill_flags(&h).is_empty());
        fs::remove_dir_all(&h).unwrap();
    }
}
