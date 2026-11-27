//! v25f (F7): Settings › Git's Connected services card. Asks each source-control CLI whether it is installed and signed
//! in. The CLI owns auth: Nunchiro reads and stores no token, and of the CLI's output only a version, an account name
//! and host names reach the window. Sign-in and sign-out are the CLI's own commands in a visible shell tab, their words
//! constants here. Adding a host is the same login: each CLI asks which host in that tab.
use crate::{
    api::{AgentKind, Reply, Response, StartSession},
    sessions::Sessions,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    ffi::OsString,
    path::Path,
    process::{Output, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HOSTS: usize = 16;
const MAX_NAME: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Id {
    Git,
    Github,
    Gitlab,
    Forgejo,
    Azure,
    Gitcafe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "GitProvidersState"))]
#[serde(rename_all = "snake_case")]
pub enum State {
    SignedIn,
    SignedOut,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Provider {
    pub id: Id,
    pub installed: bool,
    pub version: Option<String>,
    pub state: State,
    /// The signed-in name; for git, which has no sign-in, the path it was found at.
    pub account: Option<String>,
    pub hosts: Vec<String>,
}

struct Cli {
    id: Id,
    program: &'static str,
    /// The one variable that moves the CLI's own config; everything else but PATH and HOME is cleared (tokens above all,
    /// so the answer is the CLI's stored login). XDG_CONFIG_HOME is where gh, glab and tea look without their own.
    config: &'static [&'static str],
}
const CLIS: [Cli; 6] = [
    Cli {
        id: Id::Git,
        program: "git",
        config: &[],
    },
    Cli {
        id: Id::Github,
        program: "gh",
        config: &["GH_CONFIG_DIR", "XDG_CONFIG_HOME"],
    },
    Cli {
        id: Id::Gitlab,
        program: "glab",
        config: &["GLAB_CONFIG_DIR", "XDG_CONFIG_HOME"],
    },
    Cli {
        id: Id::Forgejo,
        program: "tea",
        config: &["XDG_CONFIG_HOME"],
    },
    Cli {
        id: Id::Azure,
        program: "az",
        config: &["AZURE_CONFIG_DIR"],
    },
    Cli {
        id: Id::Gitcafe,
        program: "cafe",
        config: &[],
    },
];

/// Owner and window only, off the registry lock: `login` / `logout` open that CLI's tab, neither runs the probe.
pub(crate) fn handle(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    login: Option<Id>,
    logout: Option<Id>,
) -> Response {
    let env = std::env::vars_os().collect::<Vec<_>>();
    match (login, logout) {
        (Some(id), _) => start_tab(registry, stopping, "Login", &login_words(id)?),
        (_, Some(id)) => start_tab(registry, stopping, "Logout", &logout_words(id, &env)?),
        _ => Ok(Reply::GitProviders {
            providers: scan(&env, TIMEOUT),
        }),
    }
}

fn login_words(id: Id) -> Result<Vec<String>, String> {
    let words = match id {
        Id::Github => ["gh", "auth", "login"].as_slice(),
        Id::Gitlab => ["glab", "auth", "login"].as_slice(),
        Id::Forgejo => ["tea", "login", "add"].as_slice(),
        Id::Azure => ["az", "login"].as_slice(),
        Id::Git | Id::Gitcafe => return Err("this service has no sign-in command".into()),
    };
    Ok(words.iter().map(|w| w.to_string()).collect())
}

// shortcut: with several tea logins `tea logout` asks for a name and stops, in the visible tab; pass the name once the
// row can pick a login.
fn logout_words(id: Id, env: &[(OsString, OsString)]) -> Result<Vec<String>, String> {
    let words = match id {
        Id::Github => ["gh", "auth", "logout"].as_slice(),
        Id::Forgejo => ["tea", "logout"].as_slice(),
        Id::Azure => ["az", "logout"].as_slice(),
        Id::Gitlab => {
            // glab refuses a logout without --hostname. The first host, one per click; `is_host` vetted the name.
            let cli = CLIS.iter().find(|c| c.id == id).ok_or("unknown service")?;
            let host = probe(cli, env, TIMEOUT).hosts.into_iter().next();
            let host = host.ok_or("glab reports no signed-in host")?;
            return Ok(["glab", "auth", "logout", "--hostname", &host]
                .map(String::from)
                .to_vec());
        }
        Id::Git | Id::Gitcafe => return Err("this service has no sign-out command".into()),
    };
    Ok(words.iter().map(|w| w.to_string()).collect())
}

fn start_tab(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    verb: &str,
    words: &[String],
) -> Response {
    let project = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let start = StartSession {
        account: None,
        kind: AgentKind::Shell,
        project: std::fs::canonicalize(project).map_err(|e| e.to_string())?,
        worktree: false,
        label: format!("{verb}: {}", words[0]),
        args: words.to_vec(),
        model: None,
        effort: None,
        resume: None,
    };
    let launch = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .launch(start)
        .without_history(); // the CLI prints codes and URLs: never saved, whatever Terminal History says
    let mut launch = launch.prepare()?;
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    if stopping.is_some_and(|s| s.load(Ordering::SeqCst)) {
        return Err("core is stopping".into());
    }
    let session = sessions.start(&launch)?;
    launch.committed = true;
    Ok(Reply::Started { session })
}

/// One thread per CLI, so one that hangs costs its own timeouts only. `env` is the core's environment.
fn scan(env: &[(OsString, OsString)], timeout: Duration) -> Vec<Provider> {
    thread::scope(|s| {
        let probes: Vec<_> = CLIS
            .iter()
            .map(|cli| s.spawn(move || probe(cli, env, timeout)))
            .collect();
        probes
            .into_iter()
            .zip(&CLIS)
            .map(|(p, cli)| p.join().unwrap_or_else(|_| absent(cli.id)))
            .collect()
    })
}

fn absent(id: Id) -> Provider {
    Provider {
        id,
        installed: false,
        version: None,
        state: State::Missing,
        account: None,
        hosts: vec![],
    }
}

fn probe(cli: &Cli, env: &[(OsString, OsString)], timeout: Duration) -> Provider {
    let kept: Vec<_> = env
        .iter()
        .filter(|(k, _)| ["PATH", "HOME"].iter().chain(cli.config).any(|n| k == n))
        .cloned()
        .collect();
    let on_path = kept
        .iter()
        .find(|(k, _)| k == "PATH")
        .and_then(|(_, paths)| crate::firstrun::in_paths(paths, cli.program));
    let Some(path) = on_path else {
        return absent(cli.id);
    };
    let run = |args: &[&str]| run(&path, args, &kept, timeout);
    let version = run(&["--version"]).and_then(|o| version_of(&both(&o)));
    let (state, account, hosts) = match cli.id {
        Id::Git => (
            State::SignedIn,
            Some(path.to_string_lossy().into_owned()),
            vec![],
        ),
        // shortcut: cafe has no status command we know of, so signed_out only means "cannot tell" and the window says
        // just "Installed"; ask its status once it has one.
        Id::Gitcafe => (State::SignedOut, None, vec![]),
        Id::Github | Id::Gitlab => signed(
            run(&["auth", "status"]).map_or_else(|| (None, vec![]), |o| logged_in(&both(&o))),
        ),
        // csv: the default table's borders depend on the tea version.
        Id::Forgejo => signed(run(&["login", "list", "-o", "csv"]).map_or_else(
            || (None, vec![]),
            |o| tea_logins(&String::from_utf8_lossy(&o.stdout)),
        )),
        Id::Azure => {
            // Without the extension `az` cannot reach Azure DevOps at all: the row is "not installed" like no az.
            let extension = run(&["extension", "show", "--name", "azure-devops", "-o", "json"]);
            if !extension.is_some_and(|o| o.status.success()) {
                (State::Missing, None, vec![])
            } else {
                let name = run(&["account", "show", "-o", "json"])
                    .filter(|o| o.status.success())
                    .and_then(|o| az_user(&o.stdout));
                match name {
                    Some(name) => (State::SignedIn, Some(name), vec![]),
                    None => (State::SignedOut, None, vec![]),
                }
            }
        }
    };
    Provider {
        id: cli.id,
        installed: true,
        version,
        state,
        account,
        hosts,
    }
}

fn signed((account, hosts): (Option<String>, Vec<String>)) -> (State, Option<String>, Vec<String>) {
    let state = if hosts.is_empty() {
        State::SignedOut
    } else {
        State::SignedIn
    };
    (state, account, hosts)
}

/// None when it could not start or passed `timeout` (`process::output` ends its whole process group).
fn run(
    path: &Path,
    args: &[&str],
    kept: &[(OsString, OsString)],
    timeout: Duration,
) -> Option<Output> {
    let mut c = crate::process::command(path);
    c.args(args)
        .env_clear()
        .envs(kept.iter().map(|(k, v)| (k, v)))
        .env("NO_COLOR", "1")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_TELEMETRY", "0") // as pr_live: no data about the user leaves
        .stdin(Stdio::null());
    crate::process::output(c, timeout).ok()
}

fn both(o: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

/// The first word of the first line that reads like a version: `gh version 2.62.0 (…)`, `azure-cli 2.66.0 *`.
fn version_of(text: &str) -> Option<String> {
    text.lines()
        .find(|l| !l.trim().is_empty())?
        .split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| {
            w.starts_with(|c: char| c.is_ascii_digit())
                && w.contains('.')
                && w.len() <= 32
                && w.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
        })
        .map(String::from)
}

/// CLI output is not trusted to be drawable.
fn shown(name: &str) -> Option<String> {
    let name: String = name
        .chars()
        .filter(|c| crate::delivery::shown(*c))
        .take(MAX_NAME)
        .collect();
    (!name.is_empty()).then_some(name)
}

fn is_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || ".:-".contains(c))
}

/// `gh auth status` and `glab auth status`, whose lines are `… Logged in to HOST account NAME (…)` or `… as NAME (…)`.
/// Only these lines are read: the same output carries a masked token line.
fn logged_in(text: &str) -> (Option<String>, Vec<String>) {
    let mut account = None;
    let mut hosts: Vec<String> = vec![];
    for line in text.lines() {
        let Some((_, rest)) = line.split_once("Logged in to ") else {
            continue;
        };
        let mut words = rest.split_whitespace();
        let Some(host) = words.next().filter(|h| is_host(h)) else {
            continue;
        };
        if matches!(words.next(), Some("account" | "as")) {
            account = account.or(words.next().and_then(shown));
        }
        if !hosts.iter().any(|h| h == host) && hosts.len() < MAX_HOSTS {
            hosts.push(host.into());
        }
    }
    (account, hosts)
}

/// `tea login list -o csv`: a header, then one row per server.
fn tea_logins(text: &str) -> (Option<String>, Vec<String>) {
    let mut rows = text.lines().map(|l| {
        l.split(',')
            .map(|f| f.trim().trim_matches('"'))
            .collect::<Vec<_>>()
    });
    let Some(head) = rows.next() else {
        return (None, vec![]);
    };
    let col = |name: &str| head.iter().position(|h| h.eq_ignore_ascii_case(name));
    let (Some(url), Some(user)) = (col("url"), col("user")) else {
        return (None, vec![]);
    };
    let mut account = None;
    let mut hosts: Vec<String> = vec![];
    for row in rows {
        let host = row.get(url).map(|u| {
            let bare = u.split_once("://").map_or(*u, |(_, rest)| rest);
            bare.split('/').next().unwrap_or("").to_string()
        });
        let Some(host) = host.filter(|h| is_host(h)) else {
            continue;
        };
        account = account.or(row.get(user).and_then(|u| shown(u)));
        if !hosts.contains(&host) && hosts.len() < MAX_HOSTS {
            hosts.push(host);
        }
    }
    (account, hosts)
}

fn az_user(stdout: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(stdout).ok()?;
    shown(v.get("user")?.get("name")?.as_str()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Instant};

    /// A folder of stub CLIs, the only thing on the probe's PATH.
    struct Stubs(PathBuf);
    impl Stubs {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nunchiro-gp-{tag}-{}-{}",
                std::process::id(),
                crate::store::new_id().unwrap()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn add(&self, name: &str, body: &str) {
            let path = self.0.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fn env(&self, extra: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
            [
                ("PATH", self.0.to_str().unwrap()),
                ("HOME", "/nonexistent-home"),
            ]
            .iter()
            .chain(extra)
            .map(|(k, v)| (k.into(), v.into()))
            .collect()
        }
        fn scan(&self, extra: &[(&str, &str)], timeout: Duration) -> Vec<Provider> {
            scan(&self.env(extra), timeout)
        }
    }
    impl Drop for Stubs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn row(rows: &[Provider], id: Id) -> Provider {
        rows.iter().find(|p| p.id == id).unwrap().clone()
    }
    const LONG: Duration = Duration::from_secs(5);

    #[test]
    fn glab_logout_names_the_signed_in_host() {
        let s = Stubs::new("logout");
        s.add(
            "glab",
            r#"echo "  ✓ Logged in to gitlab.example.com as dev-user""#,
        );
        assert_eq!(
            logout_words(Id::Gitlab, &s.env(&[])).unwrap(),
            ["glab", "auth", "logout", "--hostname", "gitlab.example.com"]
        );
        s.add("glab", "exit 1");
        assert!(logout_words(Id::Gitlab, &s.env(&[])).is_err());
    }

    #[test]
    fn signed_in_each_cli() {
        let s = Stubs::new("in");
        s.add("git", r#"echo "git version 2.47.1 (Apple Git-154)""#);
        s.add(
            "gh",
            r#"[ "$1" = --version ] && { echo "gh version 2.62.0 (2024-11-14)"; exit 0; }
echo "github.com"
echo "  ✓ Logged in to github.com account dev-user (keyring)"
echo "  - Token: gho_************"
echo "  ✓ Logged in to ghe.corp.example account other (keyring)""#,
        );
        s.add(
            "glab",
            r#"[ "$1" = --version ] && { echo "glab version 1.46.1"; exit 0; }
echo "  ✓ Logged in to gitlab.com as gl-user (/x/config.yml)" >&2
echo "  ✓ Token: *****" >&2"#,
        );
        s.add(
            "tea",
            r#"[ "$1" = --version ] && { echo "Version: 0.16.1"; exit 0; }
echo '"Name","URL","SSHHost","User","Default"'
echo '"home","https://code.example/","code.example","tea-user","true"'"#,
        );
        s.add(
            "az",
            r#"case "$1" in
--version) echo "azure-cli  2.66.0 *";;
extension) echo '{"version":"1.0"}';;
account) echo '{"user":{"name":"me@example.com","type":"user"}}';;
esac"#,
        );
        let rows = s.scan(&[], LONG);
        assert_eq!(
            rows.iter().map(|p| p.id).collect::<Vec<_>>(),
            [
                Id::Git,
                Id::Github,
                Id::Gitlab,
                Id::Forgejo,
                Id::Azure,
                Id::Gitcafe
            ]
        );
        let gh = row(&rows, Id::Github);
        assert_eq!(gh.state, State::SignedIn);
        assert_eq!(gh.version.as_deref(), Some("2.62.0"));
        assert_eq!(gh.account.as_deref(), Some("dev-user"));
        assert_eq!(gh.hosts, ["github.com", "ghe.corp.example"]);
        assert!(!format!("{rows:?}").contains("gho_"), "no token line");
        let glab = row(&rows, Id::Gitlab);
        assert_eq!(
            (glab.state, glab.account.as_deref()),
            (State::SignedIn, Some("gl-user"))
        );
        let tea = row(&rows, Id::Forgejo);
        assert_eq!(tea.state, State::SignedIn);
        assert_eq!(tea.version.as_deref(), Some("0.16.1"));
        assert_eq!(tea.account.as_deref(), Some("tea-user"));
        assert_eq!(tea.hosts, ["code.example"]);
        let az = row(&rows, Id::Azure);
        assert_eq!(az.version.as_deref(), Some("2.66.0"));
        assert_eq!(
            (az.state, az.account.as_deref()),
            (State::SignedIn, Some("me@example.com"))
        );
        let git = row(&rows, Id::Git);
        assert_eq!(
            (git.state, git.version.as_deref()),
            (State::SignedIn, Some("2.47.1"))
        );
        assert!(
            git.account.unwrap().ends_with("/git"),
            "git's line is its path"
        );
    }

    #[test]
    fn signed_out_each_cli() {
        let s = Stubs::new("out");
        s.add(
            "gh",
            r#"[ "$1" = --version ] && { echo "gh version 2.62.0"; exit 0; }
echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1"#,
        );
        s.add(
            "tea",
            r#"[ "$1" = --version ] && exit 0
echo '"Name","URL","SSHHost","User","Default"'"#,
        );
        s.add(
            "az",
            r#"case "$1" in
--version) echo "azure-cli  2.66.0 *";;
extension) echo '{"version":"1.0"}';;
account) echo "Please run 'az login' to setup account." >&2; exit 1;;
esac"#,
        );
        let rows = s.scan(&[], LONG);
        for id in [Id::Github, Id::Forgejo, Id::Azure] {
            let p = row(&rows, id);
            assert!(p.installed, "{id:?}");
            assert_eq!((p.state, p.account), (State::SignedOut, None), "{id:?}");
        }
        assert_eq!(row(&rows, Id::Github).version.as_deref(), Some("2.62.0"));
    }

    #[test]
    fn missing_and_azure_without_extension() {
        let s = Stubs::new("miss");
        s.add(
            "az",
            r#"[ "$1" = extension ] && exit 1
echo "azure-cli  2.66.0 *""#,
        );
        s.add("cafe", r#"echo "cafe 1.2.0""#);
        let rows = s.scan(&[], LONG);
        for id in [Id::Git, Id::Github, Id::Gitlab, Id::Forgejo] {
            assert_eq!(row(&rows, id), absent(id));
        }
        let az = row(&rows, Id::Azure);
        assert!(az.installed);
        assert_eq!(az.state, State::Missing);
        let cafe = row(&rows, Id::Gitcafe);
        assert_eq!(
            (cafe.installed, cafe.state),
            (true, State::SignedOut),
            "presence only"
        );
        assert_eq!(cafe.version.as_deref(), Some("1.2.0"));
    }

    #[test]
    fn hanging_cli_times_out_as_signed_out() {
        let s = Stubs::new("hang");
        s.add(
            "gh",
            r#"[ "$1" = --version ] && { echo "gh version 2.62.0"; exit 0; }
/bin/sleep 30"#,
        );
        let began = Instant::now();
        let gh = row(&s.scan(&[], Duration::from_millis(300)), Id::Github);
        assert!(
            began.elapsed() < Duration::from_secs(10),
            "{:?}",
            began.elapsed()
        );
        assert_eq!((gh.installed, gh.state), (true, State::SignedOut));
    }

    #[test]
    fn env_holds_no_token_variables() {
        let s = Stubs::new("env");
        let dump = s.0.join("seen");
        s.add("gh", &format!("/usr/bin/env >> {}", dump.display()));
        s.scan(
            &[
                ("GH_TOKEN", "secret-1"),
                ("GITHUB_TOKEN", "secret-2"),
                ("GH_ENTERPRISE_TOKEN", "secret-3"),
                ("GLAB_TOKEN", "secret-4"),
                ("GITLAB_TOKEN", "secret-5"),
                ("AZURE_DEVOPS_EXT_PAT", "secret-6"),
                ("ANTHROPIC_API_KEY", "secret-7"),
                ("GH_CONFIG_DIR", "/kept-config"),
            ],
            LONG,
        );
        let seen = fs::read_to_string(&dump).unwrap();
        assert!(!seen.contains("secret-"), "{seen}");
        assert!(!seen.to_ascii_uppercase().contains("TOKEN"), "{seen}");
        assert!(seen.contains("GH_CONFIG_DIR=/kept-config"), "{seen}");
        assert!(seen.contains("HOME=/nonexistent-home"), "{seen}");
    }

    #[test]
    fn output_is_read_narrowly() {
        assert_eq!(logged_in("Logged in to bad/host account x"), (None, vec![]));
        let (name, _) = logged_in("Logged in to a.example as we\u{202e}ird (x)");
        assert_eq!(
            name.as_deref(),
            Some("weird"),
            "no bidi control reaches the window"
        );
        assert_eq!(tea_logins("no,columns\n1,2"), (None, vec![]));
        assert_eq!(
            version_of("no version here\n1.2.3"),
            None,
            "first line only"
        );
        assert_eq!(az_user(b"not json"), None);
    }
}
