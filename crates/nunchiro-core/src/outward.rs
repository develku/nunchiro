//! Ticket 1130 S1 (owner yes 2026-11-25, owner-packet-1130 item 1): which tool calls act outside the Mac in the
//! owner's name, so they ask in every session whatever its permission mode (`nunchiro hook outward`). Fail closed
//! (lead, round 2): an MCP tool asks by its operation name whatever its server, and a Bash command asks when its text
//! holds a publisher word in any spelling the text matcher cannot rule out. One extra card is fine; a missed send is
//! not. `git push` and `gh pr create` are the normal work of a project session and stay out.
//! shortcut: a text matcher, so a command built at run time (`$'\x70ublish'`, a variable, an alias, a script that
//! publishes) passes; upgrade to an OS-level guard if an agent is ever seen hiding one.
use serde_json::Value;

/// The claude.ai Gmail connector as the CLI names its tools (`mcp__claude_ai_Gmail__*`).
pub const MAIL: &str = "claude_ai_Gmail";
/// The claude.ai Google Calendar connector.
pub const CALENDAR: &str = "claude_ai_Google_Calendar";
/// A word of an MCP tool's name that starts one of these sends something out (`slack_post_message`, `publishPage`,
/// `reply_all`). Prefixes, so `postgres_query` asks too (safe side).
const VERBS: &[&str] = &["send", "post", "publish", "reply", "forward"];
const PACKAGERS: &[&str] = &["npm", "pnpm", "cargo"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mail,
    Calendar,
    /// Any other MCP tool with a send verb.
    Post,
    /// A package, a release, a repository made public or a public gist.
    Publish,
}

impl Kind {
    /// The card's key (`decisions.outward.<name>` in the window).
    pub fn name(self) -> &'static str {
        match self {
            Kind::Mail => "mail",
            Kind::Calendar => "calendar",
            Kind::Post => "post",
            Kind::Publish => "publish",
        }
    }
    /// Claude shows this as the reason of its own prompt.
    pub fn reason(self) -> &'static str {
        match self {
            Kind::Mail => "Send mail: Nunchiro asks before every outward action, in every session",
            Kind::Calendar => {
                "Create a calendar event: Nunchiro asks before every outward action, in every session"
            }
            Kind::Post => {
                "Send or post: Nunchiro asks before every outward action, in every session"
            }
            Kind::Publish => "Publish: Nunchiro asks before every outward action, in every session",
        }
    }
    /// A connector or MCP call (the Outbox card gates these for a Home seat), not a shell command.
    pub fn mcp(self) -> bool {
        self != Kind::Publish
    }
}

/// Is this call (the hook's `tool_name` and `tool_input`) outward, and of which kind. An MCP tool by its operation name
/// only (Codex 4: a connector registered under another server name keeps its gate).
pub fn kind(tool: &str, input: &Value) -> Option<Kind> {
    if let Some((server, name)) = tool.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
        let w = words(name);
        let starts = |vs: &[&str]| w.iter().any(|x| vs.iter().any(|v| x.starts_with(v)));
        let event = w.iter().any(|x| x == "create") && w.iter().any(|x| x.starts_with("event"));
        if !event && !starts(VERBS) {
            return None;
        }
        return Some(if server == CALENDAR || event {
            Kind::Calendar
        } else if server == MAIL || starts(&["reply", "forward"]) {
            Kind::Mail
        } else {
            Kind::Post
        });
    }
    let command = input.get("command").and_then(Value::as_str);
    (tool == "Bash" && command.is_some_and(publishes)).then_some(Kind::Publish)
}

/// A tool name's words, lower case: `chat_postMessage` is chat, post, message.
fn words(name: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() || (c.is_ascii_uppercase() && prev_lower) {
            out.push(String::new());
        }
        if c.is_ascii_alphanumeric() {
            out.last_mut().unwrap().push(c.to_ascii_lowercase());
        }
        prev_lower = c.is_ascii_lowercase();
    }
    out.retain(|w| !w.is_empty());
    out
}

/// The command may publish: its text, read without quotes, backslashes and line continuations (`np""m pub''lish`), lower case (a Mac's file names ignore case), holds `publish` anywhere (a packager, `npx npm@10`, any
/// other publisher), `release create`, a gist created or made public, a repository created or edited with
/// `public` in any spelling (`--public=true`), a visibility change, or `private=false`. Only a plain
/// `<packager> publish --dry-run` is let through (`dry_run`).
fn publishes(command: &str) -> bool {
    let text: String = quiet_removed(command)
        .unwrap_or_else(|| command.to_string())
        .replace("\\\r\n", "")
        .replace("\\\n", "")
        .chars()
        .filter(|c| !matches!(c, '\'' | '"' | '\\'))
        .collect::<String>()
        .to_ascii_lowercase();
    let w: Vec<&str> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |x: &str| w.contains(&x);
    let compact: String = text.split_whitespace().collect();
    (text.contains("publish") && !dry_run(command))
        || (has("release") && has("create"))
        || (has("releases") && has("api"))
        || ((has("gist") || has("gists")) && (has("create") || has("public")))
        || ((has("repo") || has("repos")) && (has("create") || has("edit")) && has("public"))
        || has("visibility")
        || compact.contains("private=false")
        || compact.contains("private:false")
}

/// Round 3: the command with its read-only searches (`grep`, `egrep`, `fgrep`, `rg`, `git grep`, `git log`) and its
/// message text (`git commit -m/--message`, `gh pr create --title/--body`) left out, as one word list per simple
/// command; `None` (scan the whole text) when nothing is left out or the shape is unclear: an expansion (`$`, a
/// backtick), an unclosed quote, or a search that can run a program (`rg --pre`, `git grep -O`). Every other simple
/// command, after any `;`, `|`, `&`, line break or bracket, is kept and scanned.
fn quiet_removed(command: &str) -> Option<String> {
    // `#` and here-documents change what Bash runs in ways this tokenizer does not model (a comment ends at the
    // newline, its quotes and backslashes mean nothing; Codex round-3 look): scan the whole text instead.
    if command.contains(['$', '`', '#']) || command.contains("<<") {
        return None;
    }
    let mut segments: Vec<Vec<String>> = vec![vec![]];
    let (mut word, mut in_word, mut quote) = (String::new(), false, None);
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => word.extend(chars.next()),
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                in_word = true;
            }
            (None, '\\') => {
                if let Some(n) = chars.next().filter(|n| *n != '\n') {
                    word.push(n);
                    in_word = true;
                }
            }
            (None, c) if c.is_whitespace() || ";|&()<>{}\n".contains(c) => {
                if in_word {
                    segments.last_mut()?.push(std::mem::take(&mut word));
                    in_word = false;
                }
                if c != ' ' && c != '\t' {
                    segments.push(vec![]);
                }
            }
            (None, c) => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        segments.last_mut()?.push(word);
    }
    let mut quieted = false;
    let mut kept = vec![];
    for seg in segments {
        let w: Vec<&str> = seg.iter().map(String::as_str).collect();
        let search = matches!(w.first(), Some(&("grep" | "egrep" | "fgrep" | "rg")))
            || matches!(w.get(..2), Some(["git", "grep" | "log"]));
        if search {
            let runs = |x: &&str| {
                (w[0] == "rg" && x.starts_with("--pre"))
                    || (w[0] == "git" && (x.starts_with("-O") || x.starts_with("--open")))
            };
            if w.iter().any(runs) {
                return None;
            }
            quieted = true;
            continue;
        }
        let flags: &[&str] = match w.get(..3) {
            Some(["git", "commit", ..]) => &["-m", "-am", "--message"],
            Some(["gh", "pr", "create"]) => &["-t", "--title", "-b", "--body"],
            _ => &[],
        };
        let mut out = vec![];
        let mut skip = false;
        for x in &w {
            if std::mem::take(&mut skip) {
                quieted = true;
            } else if flags.contains(x) {
                skip = true;
            } else if flags
                .iter()
                .any(|f| f.starts_with("--") && x.starts_with(&format!("{f}=")))
            {
                quieted = true;
            } else {
                out.push(*x);
            }
        }
        kept.push(out.join(" "));
    }
    quieted.then(|| kept.join(" ; "))
}

/// Codex 1: `--dry-run` counts only as the publisher's own argument, so only in one plain simple command (no quote,
/// comment, expansion, operator or line break that could move it away: `npm publish # --dry-run`, `sh -c 'npm
/// publish' --dry-run`) whose program is a packager by its bare name and whose next word is `publish` (`yarn npm
/// publish`), with no other word that names dry run (`--no-dry-run`, `--dry-run=false`) and no `--`.
fn dry_run(command: &str) -> bool {
    if !command
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " -_./@=:".contains(c))
    {
        return false;
    }
    let w: Vec<&str> = command.split(' ').filter(|w| !w.is_empty()).collect();
    // Round 3: plain `yarn publish` (Yarn classic) has no documented --dry-run, so it asks; `yarn npm publish` has one.
    let sub = if w.first() == Some(&"yarn") && w.get(1) == Some(&"npm") {
        2
    } else {
        1
    };
    w.first().is_some_and(|p| PACKAGERS.contains(p) || sub == 2)
        && w.get(sub) == Some(&"publish")
        && w.contains(&"--dry-run")
        && w.iter().filter(|x| x.contains("dry")).count() == 1
        && !w.contains(&"--")
}

/// The tools the hook is run for, in Claude's settings and in Codex's `hooks.PreToolUse` alike (probe 2026-11-26, Codex
/// 0.161.0: a shell command arrives as `Bash` with `tool_input.command`, an MCP tool as `mcp__<server>__<tool>`).
pub const MATCHER: &str = "Bash|mcp__.*";
/// Where Codex keeps a `-c` hook's trust: the session-flags layer, PreToolUse, first group, first handler.
const CODEX_KEY: &str = "/<session-flags>/config.toml:pre_tool_use:0:0";

/// Ticket 1149: the arguments that give every Codex start the outward hook `command` (`nunchiro hook outward
/// --codex`), with or without Nunchiro's other hooks; `general` is Nunchiro's own PreToolUse hook when this start
/// passes it (a second `-c hooks.PreToolUse` would replace the first, so both ride in one list, the outward hook
/// first). Codex runs an untrusted hook only under `--dangerously-bypass-hook-trust`, which would also run a
/// project's unreviewed hooks, so this one hook is trusted by its own hash instead (`hooks.state`, as Orca's
/// `computeCodexTrustedHash`); `enabled=true` and `features.hooks=true` keep a config layer from turning it off
/// (session flags outrank the user's and the project's config). All are `-c` values, which a Codex that does not know
/// a key ignores (`--enable` of an unknown feature ends the start), so the hook-less start still starts. Probe
/// 2026-11-26: Codex has no "ask", and a hook that fails or times out lets the tool run, so the hook holds for the
/// card itself and its timeout is longer than its own wait.
/// shortcut: the hash is Codex 0.161's rule (sha256 of the hook's identity as sorted JSON); a Codex that changes it
/// leaves the hook untrusted and off. Upgrade to asking `codex app-server` (`hooks/list`) when a release changes it;
/// `t1149_codex_args_trust_only_the_outward_hook` pins the value the real 0.161.0 reports.
pub fn codex_args(command: &str, general: Option<&str>) -> Vec<String> {
    use sha2::{Digest, Sha256};
    let text = |s: &str| serde_json::to_string(s).unwrap();
    let timeout = crate::queue::HOLD_MS / 1000 + 10;
    let identity = format!(
        r#"{{"event_name":"pre_tool_use","hooks":[{{"async":false,"command":{},"timeout":{timeout},"type":"command"}}],"matcher":{}}}"#,
        text(command),
        text(MATCHER)
    );
    let hash: String = Sha256::digest(identity.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let general = general
        .map(|g| {
            format!(
                ",{{hooks=[{{type=\"command\",command={},timeout=2}}]}}",
                text(g)
            )
        })
        .unwrap_or_default();
    vec![
        "-c".into(),
        "features.hooks=true".into(),
        "-c".into(),
        format!(
            "hooks.PreToolUse=[{{matcher={},hooks=[{{type=\"command\",command={},timeout={timeout}}}]}}{general}]",
            text(MATCHER),
            text(command)
        ),
        "-c".into(),
        format!(
            "hooks.state={{{}={{trusted_hash=\"sha256:{hash}\",enabled=true}}}}",
            text(CODEX_KEY)
        ),
    ]
}

/// Ticket 1150: `codex app-server`'s `hooks/list` answer says the outward hook will run: it is listed under the
/// session-flags key, on, and trusted (its hash is the one `codex_args` named). Probe 2026-11-26, Codex 0.161.0: under
/// a managed policy that allows managed hooks only (`allow_managed_hooks_only` in `/etc/codex/requirements.toml`, a
/// device profile or the workspace's cloud requirements) the list is empty, the hook never runs and a shell command
/// and an MCP tool run with no card; with another hash the hook is listed as "modified" and does not run either.
fn codex_hook_listed(list: &Value) -> bool {
    let hooks = |cwd: &Value| cwd["hooks"].as_array().cloned().unwrap_or_default();
    let mut all = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(hooks);
    all.any(|h| h["key"] == CODEX_KEY && h["enabled"] == true && h["trustStatus"] == "trusted")
}

/// How long the asked Codex may take to answer `initialize`, then `hooks/list`. Live 0.161.0 answers both in 24 to
/// 176 ms (60 runs, median 38; the slowest while the whole test gate ran beside it). 5 s each is about thirty times
/// the slowest seen, for a cold start, a busy Mac or a cloud-managed account's policy read, before a start is
/// refused as unanswered. The wait is off the registry lock (`Launch::ask_codex`), so it holds that one start only.
const CODEX_INIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const CODEX_LIST_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Ticket 1150: what a Codex start asks its Codex with: the session's program, folder and environment (before its own
/// identity) and the outward hook's command (`sessions::spawn::codex_ask`). Two that are equal are the same start:
/// `Sessions::spawn` starts a Codex only when the one it is about to run equals one that answered yes off the lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexAsk {
    pub(crate) program: String,
    pub(crate) cwd: std::path::PathBuf,
    pub(crate) env: std::collections::BTreeMap<String, String>,
    pub(crate) command: String,
}

impl CodexAsk {
    /// Ticket 1150: a Codex that will not run the outward hook is not started (nothing silent: its outward actions
    /// would run with no card). No config file is read for this, since the policy can come from a file, a device
    /// profile or the account's workspace: the Codex about to start is asked itself, with the same hook arguments,
    /// which hooks it would run. Plugins are off for the question (as the reset reader's, `codex_reset::ARGV`): they
    /// are not what is asked, and Codex then skips their network reads. Round 2 (Codex look P1): only a yes starts
    /// it. No answer, a slow one, a program that is no app-server and any error refuse the start, as a no does;
    /// `Err` is the reason, for the person who started it. Never called under the registry lock (P2).
    /// shortcut: the answer is read once, at the start; a policy that reaches a running session later is not seen
    /// until its next start. Upgrade to asking again on Codex's own config-change notice if it ever sends one.
    pub(crate) fn runs_hook(&self) -> Result<(), String> {
        // A unit test that forgot its fake would run the installed codex on the owner's own Codex folder.
        #[cfg(test)]
        assert!(
            self.program.contains('/'),
            "a unit test asked the real codex"
        );
        let ask = |method: &str, params: Value| {
            let mut codex = crate::process::command(&self.program);
            codex
                .env_clear()
                .envs(&self.env)
                .current_dir(&self.cwd)
                .args(["app-server", "-c", "features.plugins=false"])
                .args(codex_args(&self.command, None));
            let (init, wait) = (CODEX_INIT_WAIT, CODEX_LIST_WAIT);
            crate::codex_reset::app_server(codex, init, method, params, wait, &|| true)
        };
        let cwds = serde_json::json!({"cwds": [self.cwd.to_string_lossy()]});
        Err(match ask("hooks/list", cwds) {
            Ok(list) if codex_hook_listed(&list) => return Ok(()),
            Ok(_) => match ask("configRequirements/read", Value::Null)
                .is_ok_and(|r| r["requirements"]["allowManagedHooksOnly"] == true)
            {
                true => "This Codex is under a managed policy that allows managed hooks only, so it would not run Nunchiro's outward-action check and the session was not started. Its administrator sets that policy",
                false => "This Codex would not run Nunchiro's outward-action check (its hook is missing, off or not trusted), so the session was not started",
            },
            Err((crate::codex_reset::Fail::NoCodex, _)) => "Codex was not found, so it could not be asked whether it runs Nunchiro's outward-action check and the session was not started",
            Err(_) => "Codex did not say whether it runs Nunchiro's outward-action check (`codex app-server` gave no answer in time), so the session was not started. Try again; a Codex too old to answer needs an update",
        }
        .into())
    }
}

/// Ticket 1149: a Codex argument that could displace the outward hook: a later `-c` wins in Codex, so a typed or
/// approved config or feature flag that names hooks is refused (as ticket 692's `check_for_update_on_startup`), and so
/// is one with a TOML unicode escape, the only way to spell a key without its letters (`"ho\u006fks"`).
pub fn codex_arg_names_hooks(args: &[&String]) -> bool {
    let flag = |a: &str| {
        ["-c", "--config", "--enable", "--disable"]
            .iter()
            .any(|f| a.starts_with(f))
    };
    args.iter().enumerate().any(|(n, a)| {
        (a.contains("hooks") || a.contains("\\u") || a.contains("\\U"))
            && (flag(a) || n.checked_sub(1).is_some_and(|p| flag(args[p])))
    })
}

/// Ticket 1149: an ACP agent's `terminal/create` as the one command line the matcher reads.
pub fn acp_command(params: &Value) -> String {
    let args = params["args"].as_array().into_iter().flatten();
    std::iter::once(params["command"].as_str().unwrap_or_default())
        .chain(args.map(|a| a.as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Ticket 1149 round 2: everything of an ACP `terminal/create` that decides what runs, as its card shows it: the
/// command line, then the folder and the variables the agent set, when it set any. Never cut: a request whose text
/// does not fit the card is refused (`Acp::pump`), so the owner never allows what the card does not show.
pub fn acp_card(params: &Value) -> String {
    let mut text = acp_command(params);
    if let Some(cwd) = params["cwd"].as_str() {
        text.push_str(&format!("\nin {cwd}"));
    }
    let text_of = |e: &Value, key: &str| e[key].as_str().unwrap_or_default().to_string();
    let env: Vec<String> = params["env"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| format!("{}={}", text_of(e, "name"), text_of(e, "value")))
        .collect();
    if !env.is_empty() {
        text.push_str(&format!("\nwith {}", env.join(" ")));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash(c: &str) -> Option<Kind> {
        kind("Bash", &json!({ "command": c }))
    }
    fn mcp(t: &str) -> Option<Kind> {
        kind(t, &json!({}))
    }

    #[test]
    fn t1130_outward_kinds() {
        assert_eq!(mcp("mcp__claude_ai_Gmail__send_message"), Some(Kind::Mail));
        assert_eq!(mcp("mcp__claude_ai_Gmail__reply"), Some(Kind::Mail));
        assert_eq!(mcp("mcp__claude_ai_Gmail__forward"), Some(Kind::Mail));
        assert_eq!(
            mcp("mcp__claude_ai_Google_Calendar__create_event"),
            Some(Kind::Calendar)
        );
        for t in [
            "mcp__slack__slack_post_message",
            "mcp__notes__publishPage",
            "mcp__x__chat_postMessage",
            "mcp__mailer__send",
        ] {
            assert_eq!(mcp(t), Some(Kind::Post), "{t}");
        }
        // Reads and drafts stay out.
        for t in [
            "mcp__claude_ai_Gmail__search_threads",
            "mcp__claude_ai_Gmail__create_draft",
            "mcp__claude_ai_Google_Calendar__list_events",
            "mcp__claude_ai_Gmail",
            "Read",
            "Write",
        ] {
            assert_eq!(mcp(t), None, "{t}");
        }
        for c in [
            "npm publish",
            "cd pkg && pnpm publish --access public",
            "/usr/local/bin/cargo publish -p nunchiro-core",
            "yarn npm publish",
            "bash -c 'npm publish'",
            "gh release create v1.0 dist/*",
            "gh repo create me/x --public",
            "gh repo edit --visibility public",
            "gh repo edit --visibility=public",
            "gh gist create -p notes.md",
            "gh gist create --public notes.md",
            "true; npm publish",
            "grep x | npm publish",
            "yarn publish --dry-run",
        ] {
            assert_eq!(bash(c), Some(Kind::Publish), "{c}");
        }
        for c in [
            "git push origin main",
            "git push --force-with-lease origin lead/x",
            "gh pr create --fill",
            "gh pr create --base main --head lead/x",
            "npm publish --dry-run",
            "cargo publish --dry-run -p nunchiro-core",
            "yarn npm publish --dry-run",
            "npm run build",
            "cargo test",
            "gh repo view",
            "gh repo create me/x --private",
            "gh release view v1",
        ] {
            assert_eq!(bash(c), None, "{c}");
        }
        assert_eq!(kind("Bash", &json!({})), None);
        assert_eq!(kind("Edit", &json!({"command": "npm publish"})), None);
    }

    /// Round 2, Codex 1: a dry-run flag that is not the publisher's own argument does not let a publish through.
    #[test]
    fn t1130_dry_run_only_as_the_publishers_argument() {
        for c in [
            "npm publish # --dry-run",
            "sh -c 'npm publish' --dry-run",
            "sh -c \"npm publish\" --dry-run",
            "npm publish --dry-run --no-dry-run",
            "npm publish --dry-run=false --dry-run",
            "npm run publish --dry-run",
            "npm publish -- --dry-run",
            "npm publish --dry-run; npm publish",
            "npm publish --dry-run && npm publish",
            "npm publish \\\n--dry-run",
            "env npm publish --dry-run",
            "npm_config_dry_run=false npm publish --dry-run",
            "npm publish $DRY --dry-run",
        ] {
            assert_eq!(bash(c), Some(Kind::Publish), "{c}");
        }
    }

    /// Round 2, Codex 2: wrappers, boolean option spellings, quote concatenation and escaped line breaks ask.
    #[test]
    fn t1130_publish_spellings_ask() {
        for c in [
            "npx --yes npm@10 publish",
            "npx npm@latest publish --access public",
            "pnpm -r publish",
            "gh repo create demo --public=true",
            "gh gist create --public=true note.md",
            "gh gist create -p=true note.md",
            "gh gist create -wp note.md",
            "gh gist create note.md",
            "np\"\"m pub''lish",
            "\"n\"pm publish",
            "n\\pm pu\\blish",
            "npm \\\npublish",
            "npm pub\\\nlish",
            "NPM PUBLISH",
            "g\"\"h release create v1",
            "gh release \\\n create v1",
            "gh repo edit me/x --visibility private",
            "gh api -X PATCH repos/me/x -f private=false",
            "gh api repos/me/x -F 'private=false'",
            "gh api repos/me/x/releases -f tag_name=v1",
            "gh api gists -f public=true -f files[a]=b",
            "vsce publish",
            "poetry publish --build",
        ] {
            assert_eq!(bash(c), Some(Kind::Publish), "{c}");
        }
    }

    /// Codex round-3 look: a comment or here-document hides a publisher from the tokenizer, so the whole text is scanned.
    #[test]
    fn t1130_comments_and_heredocs_are_scanned_whole() {
        for c in [
            "grep x /dev/null # \\\nnpm publish",
            "grep x /dev/null # '\ngh repo edit --visibility public\n# '",
            "grep x <<EOF\nEOF\nnpm publish",
            "git commit -m 'note' # \\\ncargo publish",
        ] {
            assert!(bash(c).is_some(), "{c:?}");
        }
    }
    /// Round 3: read-only searches and message text do not ask; anything chained after them is still scanned.
    #[test]
    fn t1130_searches_and_messages_do_not_ask() {
        for c in [
            "grep -rn publish src",
            "rg visibility web/src",
            "git commit -m \"fix artifact publish card\"",
            "git log --grep publish",
            "gh pr create --title \"release: create notes\"",
            "gh pr create --title=\"release: create notes\" --body 'gh repo edit --visibility public'",
            "git commit -am 'publish' && git log --oneline --grep=publish | head",
            "git log --pretty=oneline --grep visibility",
        ] {
            assert_eq!(bash(c), None, "{c}");
        }
        for c in [
            "grep x | npm publish",
            "grep x; npm publish",
            "grep x\nnpm publish",
            "grep x && (npm publish)",
            "grep -l x | xargs npm publish",
            "grep x $(npm publish)",
            "git commit -m \"$(npm publish)\"",
            "rg --pre 'npm publish' x",
            "git grep -O'npm publish' x",
            "git commit -m 'fix' && gh release create v1",
            "gh pr create --title x && gh repo edit --visibility public",
            "grep 'x; npm publish",
            "yarn publish --dry-run",
        ] {
            assert_eq!(bash(c), Some(Kind::Publish), "{c}");
        }
    }

    /// Round 2, Codex 4: a reply, a forward or a new event asks under any server name.
    #[test]
    fn t1130_operation_names_ask_under_any_server() {
        assert_eq!(mcp("mcp__gmail__reply"), Some(Kind::Mail));
        assert_eq!(mcp("mcp__gmail__forward"), Some(Kind::Mail));
        assert_eq!(mcp("mcp__mail2__replyAll"), Some(Kind::Mail));
        assert_eq!(mcp("mcp__calendar__create_event"), Some(Kind::Calendar));
        assert_eq!(mcp("mcp__gcal__createCalendarEvent"), Some(Kind::Calendar));
        assert_eq!(mcp("mcp__gmail__send_message"), Some(Kind::Post));
        assert_eq!(mcp("mcp__x__sendgrid_stats"), Some(Kind::Post));
        assert_eq!(mcp("mcp__x__list_posts"), Some(Kind::Post));
        assert_eq!(mcp("mcp__gmail__get_thread"), None);
        assert_eq!(mcp("mcp__calendar__list_events"), None);
    }

    /// Ticket 1149: the Codex arguments trust the outward hook alone, by the hash the real codex-cli 0.161.0 reports
    /// for this hook (`codex app-server` `hooks/list` with these same arguments, probe 2026-11-26), and keep it on.
    #[test]
    fn t1149_codex_args_trust_only_the_outward_hook() {
        let args = codex_args("/opt/n/nunchiro hook outward --codex", None);
        assert_eq!(args[..3], ["-c", "features.hooks=true", "-c"]);
        assert_eq!(
            args[3],
            r#"hooks.PreToolUse=[{matcher="Bash|mcp__.*",hooks=[{type="command",command="/opt/n/nunchiro hook outward --codex",timeout=1810}]}]"#
        );
        assert_eq!(
            args[4..],
            [
                "-c",
                r#"hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:67a388217042691eac7af4d870fbd5612d3a1a4eaa514dd7b057a8af505908b2",enabled=true}}"#
            ]
        );
        assert!(!args.iter().any(|a| a.contains("bypass")));
        // Nunchiro's own PreToolUse hook rides in the same list, after it: the trusted key stays group 0.
        let both = codex_args(
            "/opt/n/nunchiro hook outward --codex",
            Some("n hook PreToolUse"),
        );
        assert!(
            both[3].ends_with(r#"timeout=1810}]},{hooks=[{type="command",command="n hook PreToolUse",timeout=2}]}]"#),
            "{}",
            both[3]
        );
        assert_eq!(both[5], args[5]);
    }

    /// Ticket 1150: the hook runs only when Codex lists it under the session-flags key, on and trusted. The answers
    /// are the real codex-cli 0.161.0's (`hooks/list`, probe 2026-11-26): as Nunchiro starts it, under a managed
    /// policy that allows managed hooks only (an empty list), and with another trust hash ("modified").
    #[test]
    fn t1150_codex_hook_runs_only_when_listed_on_and_trusted() {
        let listed = |hooks: Value| json!({"data": [{"cwd": "/p", "hooks": hooks, "warnings": [], "errors": []}]});
        let hook = |key: &str, enabled: bool, trust: &str| {
            json!({"key": key, "eventName": "preToolUse", "handlerType": "command",
                "command": "'/opt/n/nunchiro' hook outward --codex || exit 2", "async": false,
                "matcher": "Bash|mcp__.*", "timeoutSec": 1810, "statusMessage": null,
                "additionalContextLimit": null, "sourcePath": "/<session-flags>/config.toml",
                "source": "sessionFlags", "pluginId": null, "displayOrder": 0, "enabled": enabled,
                "isManaged": false, "currentHash": "sha256:5ab8", "trustStatus": trust})
        };
        assert!(codex_hook_listed(&listed(json!([hook(
            CODEX_KEY, true, "trusted"
        )]))));
        let user = "/Users/u/.codex/config.toml:pre_tool_use:0:0";
        for not_running in [
            listed(json!([])),
            listed(json!([hook(CODEX_KEY, true, "modified")])),
            listed(json!([hook(CODEX_KEY, true, "untrusted")])),
            listed(json!([hook(CODEX_KEY, false, "trusted")])),
            // The person's own trusted hook is not Nunchiro's.
            listed(json!([hook(user, true, "trusted")])),
            json!({"data": []}),
            json!({}),
            Value::Null,
        ] {
            assert!(!codex_hook_listed(&not_running), "{not_running}");
        }
    }

    /// Ticket 1149: a config or feature argument that names hooks could displace the hook; other arguments pass.
    #[test]
    fn t1149_codex_arguments_naming_hooks_are_found() {
        let named = |args: &[&str]| {
            let owned: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            codex_arg_names_hooks(&owned.iter().collect::<Vec<_>>())
        };
        for args in [
            &["-c", "hooks.PreToolUse=[]"][..],
            &["-c", "hooks.state={}"],
            &["-c", "hooks={}"],
            &["-c", "features.hooks=false"],
            &["-c", "features={hooks=false}"],
            &["-chooks.state={}"],
            &["--config=hooks.state={}"],
            &["--config", "\"hooks\".state={}"],
            &["--disable", "hooks"],
            &["--disable=hooks"],
            &["-m", "x", "--disable", "hooks"],
            &["-c", r#""ho\u006fks".state={}"#],
            &["-c", r#"features={"ho\U0000006fks"=false}"#],
        ] {
            assert!(named(args), "{args:?}");
        }
        for args in [
            &["-c", "plugins.fixture.enabled=true"][..],
            &["-m", "gpt-5"],
            &["fix the git hooks"],
            &["-c", r#"developer_instructions="one\ntwo""#],
            &[r"say \u0041"],
            &["--cd", "hooks"],
            &[],
        ] {
            assert!(!named(args), "{args:?}");
        }
    }

    #[test]
    fn t1149_acp_terminal_command_is_read_as_one_line() {
        let publish = json!({"command": "/bin/sh", "args": ["-c", "npm publish"]});
        assert_eq!(acp_command(&publish), "/bin/sh -c npm publish");
        // Round 2: the card's text is the line itself, plus the folder and the variables the agent set.
        assert_eq!(acp_card(&publish), "/bin/sh -c npm publish");
        let set = json!({"command": "npm", "args": ["publish"], "cwd": "/p/pkg",
            "env": [{"name": "A", "value": "1"}, {"name": "B", "value": "x y"}]});
        assert_eq!(acp_card(&set), "npm publish\nin /p/pkg\nwith A=1 B=x y");
        assert_eq!(bash(&acp_command(&publish)), Some(Kind::Publish));
        assert_eq!(
            bash(&acp_command(
                &json!({"command": "npm", "args": ["publish"]})
            )),
            Some(Kind::Publish)
        );
        assert_eq!(
            bash(&acp_command(
                &json!({"command": "/bin/echo", "args": ["hi"]})
            )),
            None
        );
    }

    /// A fake `codex` in its own folder that waits `wait` seconds before it answers the start check, answering
    /// `listed` to `hooks/list`; its pid goes to `pid` in that folder.
    fn late_codex(wait: u32, listed: bool) -> (CodexAsk, std::path::PathBuf) {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxlate-{}", crate::store::new_id().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let trust = if listed { "trusted" } else { "modified" };
        let script = format!(
            "#!/bin/sh\necho $$ > \"$(dirname \"$0\")/pid\"\n/bin/sleep {wait}\nprintf '%s\\n' '{{\"id\":1,\"result\":{{}}}}' '{{\"id\":2,\"result\":{{\"data\":[{{\"hooks\":[{{\"key\":\"{CODEX_KEY}\",\"enabled\":true,\"trustStatus\":\"{trust}\"}}]}}]}}}}'\nexec /bin/cat >/dev/null\n"
        );
        let program = dir.join("codex");
        std::fs::write(&program, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ask = CodexAsk {
            program: program.to_string_lossy().into(),
            cwd: dir.clone(),
            env: Default::default(),
            command: "/opt/n/nunchiro hook outward --codex".into(),
        };
        (ask, dir)
    }

    /// A Codex that answers yes late, on a busy Mac (CI saw the fake take over 5 s), still starts: the check waits up
    /// to one absolute deadline, not 5 s per question.
    #[test]
    fn codex_that_answers_yes_late_is_started() {
        let (ask, dir) = late_codex(7, true);
        assert_eq!(ask.runs_hook(), Ok(()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A late no is a no.
    #[test]
    fn codex_that_answers_no_late_is_refused() {
        let (ask, dir) = late_codex(7, false);
        let refused = ask.runs_hook().unwrap_err();
        assert!(refused.contains("would not run"), "{refused}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
