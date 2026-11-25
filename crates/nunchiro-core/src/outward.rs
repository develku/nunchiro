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
}
