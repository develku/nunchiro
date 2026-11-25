//! S-m1 (Fable review 11-20, ticket 1002): the environment a PTY session starts with.
use super::*;

/// What a locked seat keeps of the core's own environment (`LC_*` too); PATH, TERM and Nunchiro's own are set after.
/// The agents' config folders stay, so a seat on "Your own" uses the folder the core reads its transcripts from.
const SEAT_KEEP: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

impl Sessions {
    /// Ticket 260: an unlocked session gets the login shell's variables under the stored settings, on top of the
    /// core's own. S-m1: a locked seat (`home_mode`, the Home seat and what it started) gets neither: the owner's
    /// shell, or the terminal a core was started from (CLI auto-start, `serve restart`, `serve update`), may export
    /// tokens and secrets the seat's lock does not cover. It starts from a cleared environment and `SEAT_KEEP`.
    pub(super) fn seat_env(settings: &Settings, cmd: &mut CommandBuilder, locked: bool) {
        if locked {
            // From `cmd`, not the core: it already holds portable-pty's SHELL fallback when the core has none.
            let keep: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
                .map(|(k, _)| k)
                .filter(|k| k.as_encoded_bytes().starts_with(b"LC_"))
                .chain(SEAT_KEEP.iter().map(std::ffi::OsString::from))
                .filter_map(|k| Some((k.clone(), cmd.get_env(&k)?.to_os_string())))
                .collect();
            cmd.env_clear();
            for (key, value) in keep {
                cmd.env(key, value);
            }
            return;
        }
        let names = settings
            .feature::<Vec<String>>(crate::user_env::NAMES_KEY)
            .unwrap_or_default();
        let inherit = settings
            .feature(crate::user_env::INHERIT_KEY)
            .unwrap_or(true);
        for (key, value) in crate::user_env::for_session(inherit, &names) {
            cmd.env(key, value);
        }
    }

    /// Ticket 1008: an agent session (Claude, Codex; ACP already starts from its approved names only), or a shell the
    /// owner did not open, starts without the variables `user_env::secret_var` names, wherever they came from (the
    /// core's environment or the login shell's), unless the owner lists the exact name or turned the setting off.
    pub(super) fn strip_secret_env(settings: &Settings, cmd: &mut CommandBuilder, kind: AgentKind) {
        if !settings
            .feature(crate::user_env::STRIP_SECRETS_KEY)
            .unwrap_or(true)
        {
            return;
        }
        let keep = settings
            .feature::<Vec<String>>(crate::user_env::KEEP_SECRETS_KEY)
            .unwrap_or_default();
        // Round 2 (Codex MUST): from the OS-string names, never a UTF-8 view of `cmd` (portable-pty's skips an entry
        // whose value is not UTF-8, and spawn would still pass it). Lossy only for the match.
        let gone: Vec<std::ffi::OsString> = crate::user_env::secret_vars()
            .into_iter()
            .filter(|k| {
                let name = k.to_string_lossy();
                !keep.iter().any(|n| *n == name) && !sign_in(kind).contains(&&*name)
            })
            .collect();
        for key in gone {
            cmd.env_remove(key);
        }
    }
}

/// Round 7: the names an agent signs in with on "Your own", passed as before ticket 1008 (an account session drops
/// them all with `ACCOUNT_ENV` after the strip). A shell gets none of them back.
fn sign_in(kind: AgentKind) -> &'static [&'static str] {
    match kind {
        AgentKind::Claude => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        AgentKind::Codex => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        AgentKind::Shell | AgentKind::Acp => &[],
    }
}
