//! Ticket 362 (owner 11-09, following T3 Code and Orca): the permission a session the owner starts runs with, per agent.
//! Stored in `features` under `FEATURE_KEY`; absent means full access, a value that cannot be read means `own` (no
//! flag), so a damaged file never widens anything. Each argument below was checked against the real CLI.
//! A Claude settings file that cannot be read counts as not disabled: Claude itself enforces the setting, so a wrong
//! read here costs the row its reason, not the guard.
use crate::api::{AgentKind, PermissionChoice};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) const FEATURE_KEY: &str = "agents.permission";
pub(crate) const ALLOW_SKIP: &str = "--allow-dangerously-skip-permissions";
pub(crate) const START_IN_SKIP: &str = "--dangerously-skip-permissions";
const CODEX_BYPASS: &str = "--dangerously-bypass-approvals-and-sandbox";
const SETTINGS_MAX: u64 = 1 << 20;

/// The name of `kind` in the stored map; only Claude and Codex have a permission choice.
pub(crate) fn agent_key(kind: AgentKind) -> Option<&'static str> {
    match kind {
        AgentKind::Claude => Some("claude"),
        AgentKind::Codex => Some("codex"),
        AgentKind::Shell | AgentKind::Acp => None,
    }
}

pub(crate) fn stored_choice(stored: Option<&Value>, agent: &str) -> PermissionChoice {
    match stored {
        None => PermissionChoice::FullAccess,
        Some(Value::Object(map)) => map.get(agent).map_or(PermissionChoice::FullAccess, |v| {
            PermissionChoice::deserialize_or_own(v)
        }),
        Some(_) => PermissionChoice::Own,
    }
}

/// What Claude's own settings turn off (T3 Code's `claudeBypassAvailability`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeLimits {
    pub bypass_disabled: bool,
    pub auto_disabled: bool,
}

/// Any layer that says `disable` counts: managed, cached remote, the user's (or the account's) and the folder's. `config`
/// is the account folder; none means Claude's own default, as for the process itself. A file that cannot be read says
/// nothing, and a non-file (a FIFO in a project) is never opened.
pub(crate) fn claude_limits(config: Option<&Path>, cwd: &Path) -> ClaudeLimits {
    let config = claude_config(config);
    let mut files = vec![
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"),
        PathBuf::from("/etc/claude-code/managed-settings.json"),
        cwd.join(".claude/settings.json"),
        cwd.join(".claude/settings.local.json"),
    ];
    if let Some(config) = config {
        files.push(config.join("settings.json"));
        files.push(config.join("remote-settings.json"));
    }
    let mut limits = ClaudeLimits::default();
    for file in files {
        let Some(settings) = read_settings(&file) else {
            continue;
        };
        let says = |v: Option<&Value>| v.and_then(Value::as_str) == Some("disable");
        let permissions = settings.get("permissions");
        limits.bypass_disabled |=
            says(permissions.and_then(|p| p.get("disableBypassPermissionsMode")));
        limits.auto_disabled |= says(settings.get("disableAutoMode"))
            || says(permissions.and_then(|p| p.get("disableAutoMode")));
    }
    limits
}

/// The account folder, or Claude's own default one, as for the process itself.
fn claude_config(config: Option<&Path>) -> Option<PathBuf> {
    config.map(Path::to_path_buf).or_else(|| {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
    })
}

/// Ticket 1018: Ultracode as Claude's own settings start a session (2.1.329: "New sessions start in ultracode because
/// ultracode is on in your settings"): the highest layer that sets the `ultracode` key, else off. Claude's order, highest
/// first: managed (and its cached remote copy), the folder's local file, the folder's, the user's (or the account's).
/// `None` when a layer that is there cannot be read: then it is not known.
pub(crate) fn claude_ultracode(config: Option<&Path>, cwd: &Path) -> Option<bool> {
    let config = claude_config(config);
    let mut files = vec![
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"),
        PathBuf::from("/etc/claude-code/managed-settings.json"),
    ];
    files.extend(config.as_ref().map(|c| c.join("remote-settings.json")));
    files.extend([
        cwd.join(".claude/settings.local.json"),
        cwd.join(".claude/settings.json"),
    ]);
    files.extend(config.map(|c| c.join("settings.json")));
    for file in files {
        if !fs::metadata(&file).is_ok_and(|m| m.is_file()) {
            continue;
        }
        if let Some(on) = read_settings(&file)?
            .get("ultracode")
            .and_then(Value::as_bool)
        {
            return Some(on);
        }
    }
    Some(false)
}

fn read_settings(file: &Path) -> Option<Value> {
    let meta = fs::metadata(file).ok()?;
    if !meta.is_file() || meta.len() > SETTINGS_MAX {
        return None;
    }
    // Followed: Claude's settings files are often links (a dotfiles folder); a disable in one must still count.
    let file = crate::store::open_regular_following(file).ok()?;
    serde_json::from_slice(&crate::store::read_capped(file, SETTINGS_MAX).ok()?).ok()
}

/// The arguments the owner's stored `choice` adds. Arguments the owner typed that already state a permission win: the
/// stored choice adds nothing to them, except the flag that keeps Bypass permissions in Claude's list.
pub(crate) fn launch_args(
    kind: AgentKind,
    choice: PermissionChoice,
    user: &[String],
    side_chat: bool,
    limits: ClaudeLimits,
) -> Vec<String> {
    match kind {
        _ if side_chat => vec![],
        AgentKind::Claude => claude_args(choice, user, limits),
        AgentKind::Codex => codex_args(choice, user),
        AgentKind::Shell | AgentKind::Acp => vec![],
    }
}

fn names(user: &[String], flag: &str) -> bool {
    user.iter()
        .any(|a| a == flag || a.strip_prefix(flag).is_some_and(|r| r.starts_with('=')))
}

fn claude_args(choice: PermissionChoice, user: &[String], limits: ClaudeLimits) -> Vec<String> {
    // Ask leaves the flag out: on the real CLI any session with it gets a weaker plan mode. Own adds no flag at all
    // (Q9 ja-J22-1: a damaged value reads as Own and must not widen the cycle).
    let allow =
        !limits.bypass_disabled && !matches!(choice, PermissionChoice::Ask | PermissionChoice::Own);
    let mode = |name: &str| {
        let mut args = vec!["--permission-mode".to_string(), name.to_string()];
        if allow {
            args.push(ALLOW_SKIP.into());
        }
        args
    };
    let auto = || {
        mode(if limits.auto_disabled {
            "manual"
        } else {
            "auto"
        })
    };
    if names(user, ALLOW_SKIP) || names(user, START_IN_SKIP) {
        return vec![];
    }
    if names(user, "--permission-mode") {
        return if allow {
            vec![ALLOW_SKIP.into()]
        } else {
            vec![]
        };
    }
    match choice {
        PermissionChoice::Own => vec![],
        PermissionChoice::Ask => mode("manual"),
        PermissionChoice::AcceptEdits => mode("acceptEdits"),
        PermissionChoice::Auto => auto(),
        PermissionChoice::FullAccess if limits.bypass_disabled => auto(),
        PermissionChoice::FullAccess => vec![START_IN_SKIP.into()],
    }
}

/// Look 11-17 N2: a resumed Claude starts in the mode its footer last showed (`ran`, the footer's words), not the stored
/// choice for new sessions; `None` when the user's arguments name a mode or when the mode is not one this build knows.
/// Skip permissions comes back only where Claude's settings still allow it.
pub(crate) fn claude_resume_args(
    ran: &str,
    choice: PermissionChoice,
    user: &[String],
    limits: ClaudeLimits,
) -> Option<Vec<String>> {
    if [ALLOW_SKIP, START_IN_SKIP, "--permission-mode"]
        .iter()
        .any(|flag| names(user, flag))
    {
        return None;
    }
    let mode = match ran {
        "bypass permissions" if !limits.bypass_disabled => return Some(vec![START_IN_SKIP.into()]),
        "manual" => "manual",
        "accept edits" => "acceptEdits",
        "plan" => "plan",
        "auto" if !limits.auto_disabled => "auto",
        _ => return None,
    };
    let mut args = vec!["--permission-mode".to_string(), mode.to_string()];
    // As `claude_args`: the cycle keeps Skip permissions unless the choice is Ask or Claude's settings turn it off.
    if !limits.bypass_disabled && !matches!(choice, PermissionChoice::Ask | PermissionChoice::Own) {
        args.push(ALLOW_SKIP.into());
    }
    Some(args)
}

/// The owner's own arguments already state Codex's permission.
fn codex_stated(user: &[String]) -> bool {
    [
        "-a",
        "--ask-for-approval",
        "-s",
        "--sandbox",
        "--approve-for-me",
        CODEX_BYPASS,
    ]
    .iter()
    .any(|flag| names(user, flag))
}

/// Look 1117 v9 N-S3-3: the footer name of the mode Claude's start arguments put it in (`claude_args`,
/// `claude_resume_args`), so the chip and the row's mark name it before Claude first draws its footer. None when they
/// name no mode (the agent's own setting, or the owner's own flags).
pub(crate) fn claude_start_mode(args: &[String]) -> Option<&'static str> {
    match args {
        [flag, ..] if flag == START_IN_SKIP => Some("bypass permissions"),
        [flag, mode, ..] if flag == "--permission-mode" => match mode.as_str() {
            "manual" => Some("manual"),
            "acceptEdits" => Some("accept edits"),
            "plan" => Some("plan"),
            "auto" => Some("auto"),
            _ => None,
        },
        _ => None,
    }
}

/// Ticket 991 (B6 chip): the mode `codex_args` starts a Codex session in, by the stored name Settings > Providers lists
/// (a stored accept-edits is Codex's ask). None when the owner's arguments state the permission: the core chose nothing.
pub(crate) fn codex_mode(choice: PermissionChoice, user: &[String]) -> Option<&'static str> {
    (!codex_stated(user)).then_some(match choice {
        PermissionChoice::Own => "own",
        PermissionChoice::Ask | PermissionChoice::AcceptEdits => "ask",
        PermissionChoice::Auto => "auto",
        PermissionChoice::FullAccess => "full-access",
    })
}

fn codex_args(choice: PermissionChoice, user: &[String]) -> Vec<String> {
    if codex_stated(user) {
        return vec![];
    }
    let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect();
    match choice {
        PermissionChoice::Own => vec![],
        // Codex has no accept-edits mode: the nearest lower one.
        PermissionChoice::Ask | PermissionChoice::AcceptEdits => words(&[
            "-a",
            "on-request",
            "-s",
            "workspace-write",
            "-c",
            "approvals_reviewer=user",
        ]),
        PermissionChoice::Auto => words(&["--approve-for-me"]),
        PermissionChoice::FullAccess => words(&[CODEX_BYPASS]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Look 11-17 N2: a session set to Normal (manual) resumes in manual, not in the stored Full access.
    #[test]
    fn n2_resume_keeps_the_mode_the_session_ran_in() {
        let none = ClaudeLimits::default();
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            claude_resume_args("manual", PermissionChoice::FullAccess, &[], none),
            Some(args(&["--permission-mode", "manual", ALLOW_SKIP]))
        );
        assert_eq!(
            claude_resume_args("manual", PermissionChoice::Own, &[], none),
            Some(args(&["--permission-mode", "manual"]))
        );
        assert_eq!(
            claude_resume_args("accept edits", PermissionChoice::Ask, &[], none),
            Some(args(&["--permission-mode", "acceptEdits"]))
        );
        assert_eq!(
            claude_resume_args("bypass permissions", PermissionChoice::Ask, &[], none),
            Some(args(&[START_IN_SKIP]))
        );
        let off = ClaudeLimits {
            bypass_disabled: true,
            auto_disabled: true,
        };
        assert_eq!(
            claude_resume_args("bypass permissions", PermissionChoice::FullAccess, &[], off),
            None
        );
        assert_eq!(
            claude_resume_args("auto", PermissionChoice::FullAccess, &[], off),
            None
        );
        assert_eq!(
            claude_resume_args(
                "manual",
                PermissionChoice::FullAccess,
                &args(&["--permission-mode", "plan"]),
                none
            ),
            None
        );
    }
    const FREE: ClaudeLimits = ClaudeLimits {
        bypass_disabled: false,
        auto_disabled: false,
    };
    const NO_BYPASS: ClaudeLimits = ClaudeLimits {
        bypass_disabled: true,
        auto_disabled: false,
    };
    const NEITHER: ClaudeLimits = ClaudeLimits {
        bypass_disabled: true,
        auto_disabled: true,
    };
    fn claude(choice: PermissionChoice, limits: ClaudeLimits) -> String {
        launch_args(AgentKind::Claude, choice, &[], false, limits).join(" ")
    }
    fn codex(choice: PermissionChoice) -> String {
        launch_args(AgentKind::Codex, choice, &[], false, FREE).join(" ")
    }

    #[test]
    fn each_choice_maps_to_its_arguments() {
        use PermissionChoice::*;
        assert_eq!(claude(Own, FREE), "");
        assert_eq!(claude(FullAccess, FREE), START_IN_SKIP);
        assert_eq!(claude(Ask, FREE), "--permission-mode manual");
        assert_eq!(
            claude(AcceptEdits, FREE),
            format!("--permission-mode acceptEdits {ALLOW_SKIP}")
        );
        assert_eq!(
            claude(Auto, FREE),
            format!("--permission-mode auto {ALLOW_SKIP}")
        );
        assert_eq!(codex(Own), "");
        assert_eq!(codex(FullAccess), CODEX_BYPASS);
        assert_eq!(codex(Auto), "--approve-for-me");
        let ask = "-a on-request -s workspace-write -c approvals_reviewer=user";
        assert_eq!(codex(Ask), ask);
        assert_eq!(
            codex(AcceptEdits),
            ask,
            "Codex has no accept-edits: the nearest lower one"
        );
    }

    #[test]
    fn claude_settings_that_disable_bypass_downgrade_the_launch() {
        use PermissionChoice::*;
        assert_eq!(claude(FullAccess, NO_BYPASS), "--permission-mode auto");
        assert_eq!(claude(FullAccess, NEITHER), "--permission-mode manual");
        assert_eq!(claude(Auto, NEITHER), "--permission-mode manual");
        assert_eq!(claude(Ask, NO_BYPASS), "--permission-mode manual");
    }

    #[test]
    fn what_the_owner_typed_wins() {
        let args = |user: &[&str]| {
            let user: Vec<String> = user.iter().map(|s| s.to_string()).collect();
            (
                launch_args(
                    AgentKind::Claude,
                    PermissionChoice::FullAccess,
                    &user,
                    false,
                    FREE,
                ),
                launch_args(
                    AgentKind::Codex,
                    PermissionChoice::FullAccess,
                    &user,
                    false,
                    FREE,
                ),
            )
        };
        assert_eq!(args(&["--permission-mode", "plan"]).0, [ALLOW_SKIP]);
        assert_eq!(args(&["--permission-mode=plan"]).0, [ALLOW_SKIP]);
        assert!(args(&[START_IN_SKIP]).0.is_empty());
        let user = ["--permission-mode".to_string(), "plan".to_string()];
        let asked = launch_args(AgentKind::Claude, PermissionChoice::Ask, &user, false, FREE);
        assert!(asked.is_empty(), "Ask never adds the allow flag");
        let own = launch_args(AgentKind::Claude, PermissionChoice::Own, &user, false, FREE);
        assert!(own.is_empty(), "Own never adds the allow flag");
        assert!(args(&["-s", "read-only"]).1.is_empty());
        assert!(args(&["--sandbox=read-only"]).1.is_empty());
        let side = launch_args(
            AgentKind::Claude,
            PermissionChoice::FullAccess,
            &[],
            true,
            FREE,
        );
        assert!(side.is_empty(), "a side chat stays read-only");
    }

    #[test]
    fn absent_means_full_access_and_damage_means_own() {
        use PermissionChoice::*;
        assert_eq!(stored_choice(None, "claude"), FullAccess);
        assert_eq!(
            stored_choice(Some(&json!({"codex":"ask"})), "claude"),
            FullAccess
        );
        assert_eq!(stored_choice(Some(&json!({"claude":"ask"})), "claude"), Ask);
        assert_eq!(
            stored_choice(Some(&json!({"claude":"accept-edits"})), "claude"),
            AcceptEdits
        );
        assert_eq!(
            stored_choice(Some(&json!({"claude":"nonsense"})), "claude"),
            Own
        );
        assert_eq!(stored_choice(Some(&json!("full-access")), "claude"), Own);
    }

    #[test]
    fn any_layer_that_disables_counts() {
        let dir = std::env::temp_dir().join(format!("np-{}", std::process::id()));
        let (config, cwd) = (dir.join("config"), dir.join("cwd"));
        fs::create_dir_all(cwd.join(".claude")).unwrap();
        fs::create_dir_all(&config).unwrap();
        assert!(!claude_limits(Some(&config), &cwd).bypass_disabled);
        let off = json!({"permissions":{"disableBypassPermissionsMode":"disable"},"disableAutoMode":"disable"});
        fs::write(cwd.join(".claude/settings.local.json"), off.to_string()).unwrap();
        let limits = claude_limits(Some(&config), &cwd);
        assert!(limits.bypass_disabled && limits.auto_disabled);
        fs::remove_file(cwd.join(".claude/settings.local.json")).unwrap();
        fs::write(config.join("settings.json"), off.to_string()).unwrap();
        assert!(claude_limits(Some(&config), &cwd).bypass_disabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ultracode_is_the_highest_layer_that_sets_it() {
        // Ticket 1018 (managed files are the machine's own and are not written here).
        let dir = std::env::temp_dir().join(format!("np-uc-{}", std::process::id()));
        let (config, cwd) = (dir.join("config"), dir.join("cwd"));
        fs::create_dir_all(cwd.join(".claude")).unwrap();
        fs::create_dir_all(&config).unwrap();
        assert_eq!(claude_ultracode(Some(&config), &cwd), Some(false)); // nothing sets it: off
        fs::write(config.join("settings.json"), r#"{"ultracode":true}"#).unwrap();
        assert_eq!(claude_ultracode(Some(&config), &cwd), Some(true));
        fs::write(cwd.join(".claude/settings.json"), r#"{"model":"opus"}"#).unwrap();
        assert_eq!(claude_ultracode(Some(&config), &cwd), Some(true)); // a layer without the key says nothing
        fs::write(
            cwd.join(".claude/settings.local.json"),
            r#"{"ultracode":false}"#,
        )
        .unwrap();
        assert_eq!(claude_ultracode(Some(&config), &cwd), Some(false)); // the folder's local file wins over the user's
        fs::write(cwd.join(".claude/settings.local.json"), "{not json").unwrap();
        assert_eq!(claude_ultracode(Some(&config), &cwd), None); // a layer that cannot be read: not known
        fs::remove_dir_all(dir).unwrap();
    }
}
