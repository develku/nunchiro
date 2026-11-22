//! Ticket 260 (G28; needs 198: Orca's way): the login shell's environment for Claude, Codex and shell PTY sessions.
//! `login_path` reads it in the one shell run that also reads PATH (ticket 575: once at `serve` start, 3 s ceiling,
//! fallback on failure) and hands it here. It is held, never set on the core (`set_var`), so the core's own PATH, ACP
//! `allowed_env` (approval binds names, not values) and the widget sandbox (`env_clear`) keep their sources.
//! On (the default) a PTY session gets every shell variable; off, only `LANG`, `LC_*`, `SSH_AUTH_SOCK` and the names
//! the owner listed (Orca's `structured-agent-shell-environment.ts`: PATH, locale and the agent socket always pass).
//! PATH is not taken from here: ticket 575 already merged the login PATH into the core's, which `resolved` and the
//! session's PATH both read, so the program found and the PATH the session gets stay the same list.
use std::{
    ffi::{OsStr, OsString},
    sync::OnceLock,
};

pub type Env = Vec<(OsString, OsString)>;
/// Core `features` keys (absent: on, no names).
pub const INHERIT_KEY: &str = "env.inherit_shell";
pub const NAMES_KEY: &str = "env.names";
/// Ticket 1008: agent sessions start without secret-looking names (absent: on), but for the exact names listed.
pub const STRIP_SECRETS_KEY: &str = "env.strip_secrets";
pub const KEEP_SECRETS_KEY: &str = "env.keep_secrets";

static READ: OnceLock<Result<Env, String>> = OnceLock::new();

/// `login_path::adopt` only, once; a core that never probes (tests in process) holds nothing, so sessions are unchanged.
pub(crate) fn hold(read: Result<Env, String>) {
    let _ = READ.set(read);
}

/// Why the environment was not read, for the Settings row; `None` once read, or in a core that never asked.
pub(crate) fn error() -> Option<String> {
    READ.get()?.as_ref().err().cloned()
}

/// Ticket 1008: the name of every secret variable (`secret_var`) the core and the login shell hold, as OS strings (a
/// name or value that is not UTF-8 is still judged, lossy only for the match, and must not be skipped).
pub(crate) fn secret_vars() -> Vec<OsString> {
    let shell = match READ.get() {
        Some(Ok(env)) => env.clone(),
        _ => Vec::new(),
    };
    let mut names: Vec<OsString> = std::env::vars_os()
        .chain(shell)
        .filter(|(k, v)| secret_var(&k.to_string_lossy(), v))
        .map(|(k, _)| k)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Ticket 1024: whether a program the variable was not meant for must not get it: its name looks secret, or its value
/// holds a URL with a password under any name (`REDIS_URL`). But for a proxy's (`*_PROXY`): the programs that use the
/// network need that one whole, and nothing else can hand it to them.
pub(crate) fn secret_var(name: &str, value: &OsStr) -> bool {
    looks_secret(name)
        || (!name.to_ascii_uppercase().ends_with("_PROXY")
            && crate::start_secrets::has_url_password(&value.to_string_lossy()))
}

/// Ticket 1008 round 2 (Fable M2): whether an agent session leaves `name` out. Wider than `start_secrets::is_secret`
/// (which splits the keychain copy and stays as it is): any word of the name, split at `_`, other punctuation, a
/// lower-to-upper case change and a letter-digit change, that is one of `WORDS`, so `GITHUB_TOKEN_WORK`,
/// `SECRET_KEY_BASE`, `OPENAI_APIKEY`, `DB_PASSWD`, `authToken` and `API_KEY2` count. Whole words only: `AUTH` must not
/// take `GIT_AUTHOR_NAME`, nor `KEY` `NUNCHIRO_KEYCHAIN`. The name's part of the decision; `secret_var` adds the
/// value's (`REDIS_URL` with a password).
pub(crate) fn looks_secret(name: &str) -> bool {
    const WORDS: &[&str] = &[
        "KEY",
        "APIKEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PWD",
        "PASS",
        "PAT",
        "CREDENTIAL",
        "CREDENTIALS",
        "AUTH",
        "PRIVATE",
        "COOKIE",
    ];
    // SSH_AUTH_SOCK: the agent socket's path, passed always since ticket 260 (git over SSH needs it). PWD: the working
    // folder. Nunchiro's own names need no exemption: none matches a word but NUNCHIRO_TOKEN, which is set after the
    // strip (an inherited one is a parent session's and goes).
    if matches!(name, "SSH_AUTH_SOCK" | "PWD") {
        return false;
    }
    if crate::start_secrets::is_secret(name) {
        return true;
    }
    let mut words = Vec::new();
    let mut word = String::new();
    let mut last: Option<char> = None;
    for c in name.chars() {
        let cut = !c.is_ascii_alphanumeric()
            || last.is_some_and(|l| {
                (l.is_ascii_lowercase() && c.is_ascii_uppercase())
                    || (l.is_ascii_alphabetic() != c.is_ascii_alphabetic())
            });
        if cut && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if c.is_ascii_alphanumeric() {
            word.push(c.to_ascii_uppercase());
        }
        last = Some(c);
    }
    words.push(word);
    words.iter().any(|w| WORDS.contains(&w.as_str()))
}

/// Ticket 1008: `secret_vars` for the Settings row (names only, never a value).
pub(crate) fn secret_names() -> Vec<String> {
    secret_vars()
        .iter()
        .map(|k| k.to_string_lossy().into_owned())
        .collect()
}

/// What a PTY session gets from the login shell under the stored settings, set before Nunchiro's own variables.
pub(crate) fn for_session(inherit: bool, names: &[String]) -> Vec<(OsString, OsString)> {
    match READ.get() {
        Some(Ok(env)) => pick(env, inherit, names).cloned().collect(),
        _ => Vec::new(),
    }
}

fn pick<'a>(
    env: &'a [(OsString, OsString)],
    inherit: bool,
    names: &'a [String],
) -> impl Iterator<Item = &'a (OsString, OsString)> {
    env.iter().filter(move |(k, _)| {
        let b = k.as_encoded_bytes();
        !kept_out(k)
            && (inherit
                || b == b"LANG"
                || b.starts_with(b"LC_")
                || b == b"SSH_AUTH_SOCK"
                || names.iter().any(|n| n.as_bytes() == b))
    })
}

/// Never from the shell: Nunchiro's own and the launching session's identity, PATH (see above), and what describes
/// the probe shell itself rather than the user's setup.
fn kept_out(name: &OsStr) -> bool {
    let b = name.as_encoded_bytes();
    b.starts_with(b"NUNCHIRO_")
        || crate::sessions::is_parent_session_env(name)
        || matches!(b, b"PATH" | b"PWD" | b"OLDPWD" | b"SHLVL" | b"_" | b"TERM")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_secret_by_whole_words() {
        for name in [
            "PASSWORD",
            "TOKEN",
            "SECRET",
            "APIKEY",
            "OPENAI_APIKEY",
            "GITHUB_TOKEN_WORK",
            "API_KEY_2",
            "API_KEY2",
            "SECRET_KEY_BASE",
            "AWS_ACCESS_KEY_ID",
            "DB_PASSWD",
            "NPM_AUTH",
            "X_PRIVATE_KEY_PEM",
            "SESSION_COOKIE",
            "BINANCE_API_KEY",
            "BINANCE_API_SECRET",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "GH_TOKEN",
            "authToken",
            "githubPat",
            "MYSQL_PWD",
            "PGPASSWORD",
            "DATABASE_URL",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "SMTP_PASS",
            "aws_credential",
            "NUNCHIRO_TOKEN",
            "NUNCHIRO_UPDATE_KEY",
        ] {
            assert!(looks_secret(name), "{name}");
        }
        for name in [
            "SSH_AUTH_SOCK",
            "PWD",
            "OLDPWD",
            "PATH",
            "MANPATH",
            "HOME",
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "NUNCHIRO_KEYCHAIN",
            "KEYCHAIN",
            "XAUTHORITY",
            "SSH_ASKPASS",
            "GIT_ASKPASS",
            "HOMEBREW_NO_AUTO_UPDATE",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "MAX_THINKING_TOKENS",
            "TERM_SESSION_ID",
            "SECURITYSESSIONID",
            "__CF_USER_TEXT_ENCODING",
            "XPC_SERVICE_NAME",
            "KEYTIMEOUT",
            "LC_CTYPE",
            "COMMAND_MODE",
        ] {
            assert!(!looks_secret(name), "{name}");
        }
    }

    // Ticket 1024: a URL with a password is a secret under any name, a proxy's excepted.
    #[test]
    fn secret_var_by_name_or_url_password() {
        let url = OsStr::new("redis://u:pw@cache.invalid/0");
        assert!(secret_var("GH_TOKEN", OsStr::new("plain")));
        assert!(secret_var("CACHE_URL", url));
        assert!(!secret_var(
            "CACHE_URL",
            OsStr::new("redis://cache.invalid/0")
        ));
        for proxy in ["HTTPS_PROXY", "http_proxy", "ALL_PROXY"] {
            assert!(!secret_var(proxy, url), "{proxy}");
        }
        assert!(secret_var("PROXY_URL", url));
    }

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }
    fn names(picked: Vec<&(OsString, OsString)>) -> Vec<&str> {
        picked.iter().map(|(k, _)| k.to_str().unwrap()).collect()
    }

    #[test]
    fn on_takes_all_but_own_and_probe_names_off_takes_base_and_listed() {
        let e = env(&[
            ("FOO", "1"),
            ("LANG", "ko_KR.UTF-8"),
            ("LC_CTYPE", "UTF-8"),
            ("SSH_AUTH_SOCK", "/s"),
            ("BAR", "2"),
            ("NUNCHIRO_HOME", "/x"),
            ("NUNCHIRO_LOGIN_PATH_PROBE", "1"),
            ("CLAUDECODE", "1"),
            ("PATH", "/p"),
            ("PWD", "/w"),
            ("SHLVL", "2"),
            ("TERM", "dumb"),
        ]);
        let listed = vec!["BAR".to_string()];
        assert_eq!(
            names(pick(&e, true, &[]).collect()),
            ["FOO", "LANG", "LC_CTYPE", "SSH_AUTH_SOCK", "BAR"]
        );
        assert_eq!(
            names(pick(&e, false, &listed).collect()),
            ["LANG", "LC_CTYPE", "SSH_AUTH_SOCK", "BAR"]
        );
        // A listed name never brings back one kept out.
        let own = vec!["NUNCHIRO_HOME".to_string(), "PATH".to_string()];
        assert_eq!(
            names(pick(&e, false, &own).collect()),
            ["LANG", "LC_CTYPE", "SSH_AUTH_SOCK"]
        );
    }
}
