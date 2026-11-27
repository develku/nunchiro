//! V2-8b: the PR badge's last known state from projected chat events. Pure: no I/O, no clock, no network.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Draft,
    Open,
    ChecksPass,
    ChecksFail,
    Approved,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrChip {
    pub state: PrState,
    pub url: String,
    /// The `gh` result's record time; absent on events stored before v2-8b.
    pub at: Option<String>,
    /// The agent whose terminal output the app linked it from (pr_live.rs `link_later`); absent for a chat or app PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Verb {
    Create { draft: bool },
    View,
    Checks,
    Status,
}

/// The words of each simple command in a shell line, split at `; | & ( )`, a backtick and a newline. Quoted text
/// keeps a NUL in its word, so it never equals a bare word; a `#` comment and a heredoc body are dropped.
fn simple_commands(command: &str) -> Vec<Vec<String>> {
    let (mut all, mut words, mut word) = (vec![], vec![], String::new());
    let mut heredocs: Vec<String> = vec![];
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && q == '"' {
                chars.next();
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                word.push('\0');
            }
            '\\' => word.extend(chars.next().filter(|n| *n != '\n')),
            '#' if word.is_empty() => while chars.next_if(|n| *n != '\n').is_some() {},
            // `<<EOF` or `<<-'EOF'`: remember the end word; the body is text (an apostrophe in it opens no quote)
            '<' if chars.peek() == Some(&'<') => {
                chars.next();
                if chars.next_if_eq(&'<').is_some() {
                    word.push_str("<<<");
                    continue;
                }
                chars.next_if_eq(&'-');
                while chars.next_if(|n| " \t".contains(*n)).is_some() {}
                let end = std::iter::from_fn(|| chars.next_if(|n| !" \t\n;|&()<>".contains(*n)));
                heredocs.push(end.filter(|n| !"'\"\\".contains(*n)).collect());
            }
            // only what the shell splits on: a no-break space stays inside its word
            c if " \t\n;|&()`".contains(c) => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                if !" \t".contains(c) {
                    all.push(std::mem::take(&mut words));
                }
                if c == '\n' {
                    for end in heredocs.drain(..) {
                        loop {
                            let line: String =
                                std::iter::from_fn(|| chars.next_if(|n| *n != '\n')).collect();
                            if chars.next().is_none() || line.trim_start_matches('\t') == end {
                                break;
                            }
                        }
                    }
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    all.push(words);
    all
}

/// `gh pr <create|view|checks|status>` as the first words of a simple command, after any `NAME=value` words and
/// shell keywords (`then`, `do`, `time`, ...). A command that only mentions the words (`echo <link> # gh pr create`,
/// or inside quotes) is not a `gh` run.
fn verb(command: &str) -> Option<Verb> {
    const LEAD: [&str; 11] = [
        "then", "do", "else", "elif", "if", "while", "until", "!", "{", "time", "command",
    ];
    let assignment = |w: &String| {
        LEAD.contains(&w.as_str())
            || w.split_once('=').is_some_and(|(n, _)| {
                !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
    };
    simple_commands(command).iter().find_map(|words| {
        let w = &words[words.iter().take_while(|w| assignment(w)).count()..];
        if w.len() < 3 || w[0] != "gh" || w[1] != "pr" {
            return None;
        }
        Some(match w[2].as_str() {
            "create" => Verb::Create {
                draft: w[3..]
                    .iter()
                    .any(|w| matches!(w.as_str(), "--draft" | "-d")),
            },
            "view" => Verb::View,
            "checks" => Verb::Checks,
            "status" => Verb::Status,
            _ => return None,
        })
    })
}

fn command_of(name: &str, input: &Value) -> Option<String> {
    if !matches!(name, "Bash" | "exec_command" | "shell") {
        return None;
    }
    [&input["command"], &input["cmd"]]
        .into_iter()
        .find_map(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Array(a) => {
                let words: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
                // `["bash", "-lc", "<script>"]` (Codex): the script is the command line
                let shell = matches!(
                    words.first().and_then(|w| w.rsplit('/').next()),
                    Some("bash" | "sh" | "zsh" | "dash")
                );
                let script = shell
                    && matches!(words.get(1), Some(f) if f.starts_with('-') && f.ends_with('c'));
                Some(words[if script { 2 } else { 0 }..].join(" "))
            }
            _ => None,
        })
}

fn text_of(output: &Value) -> String {
    match output {
        // older Codex: `{"output":"<text>","metadata":...}` as one string
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| v["output"].as_str().map(String::from))
            .unwrap_or_else(|| s.clone()),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b.as_str().or_else(|| b["text"].as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The first `https://github.com/<owner>/<repo>/pull/<n>` in the text; nothing else is ever a chip link.
fn pr_url(text: &str) -> Option<String> {
    const HEAD: &str = "https://github.com/";
    let name = |c: char| c.is_ascii_alphanumeric() || "-_.".contains(c);
    text.match_indices(HEAD).find_map(|(i, _)| {
        let rest = &text[i + HEAD.len()..];
        let mut parts = rest.splitn(4, '/');
        let (owner, repo, pull, tail) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        let number: String = tail.chars().take_while(char::is_ascii_digit).collect();
        let ok = !owner.is_empty()
            && owner.chars().all(name)
            && !repo.is_empty()
            && repo.chars().all(name);
        (ok && pull == "pull" && !number.is_empty())
            .then(|| format!("{HEAD}{owner}/{repo}/pull/{number}"))
    })
}

/// The PR link that is a whole line of `text`, when every such line names the same PR.
fn only_link_line(text: &str) -> Option<String> {
    let mut links = text
        .lines()
        .filter_map(|l| pr_url(l).filter(|u| u == l.trim()));
    let first = links.next()?;
    links.all(|u| u == first).then_some(first)
}

/// The lines under the unindented "current branch" heading, up to the next unindented line.
fn current_branch_block(low: &str) -> Option<String> {
    let mut lines = low.lines().skip_while(|l| l.trim_end() != "current branch");
    lines.next()?;
    Some(
        lines
            .take_while(|l| l.is_empty() || l.starts_with(char::is_whitespace))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// "Approved" where `gh` states the review: the `reviewDecision` JSON field, a `Review decision:` or reviewer
/// verdict line, or (in `gh pr status`) a summary item. The title and body never count. `low` is lowercased.
fn approved(verb: Verb, low: &str) -> bool {
    if let Ok(json) = serde_json::from_str::<Value>(low.trim()) {
        return json["reviewdecision"] == "approved";
    }
    // shortcut: only piped `gh pr view` output has the `--` body separator; a terminal render has none, so a
    // body line starting `reviewers:` would count there. Upgrade if tier 1 ever reads terminal renders.
    low.lines().take_while(|l| l.trim() != "--").any(|l| {
        let l = l.trim();
        if let Some(who) = l.strip_prefix("reviewers:") {
            who.contains("(approved)")
        } else if let Some(v) = l
            .strip_prefix("review decision:")
            .or_else(|| l.strip_prefix("reviewdecision:"))
        {
            v.trim() == "approved"
        } else {
            verb == Verb::Status
                && l.strip_prefix("- ")
                    .is_some_and(|items| items.split(" - ").any(|i| i.trim() == "approved"))
        }
    })
}

/// Reads `gh` output the way a person would; `None` when it says nothing about the state. `number` is the chip
/// URL's PR number: a `gh pr status` block for another PR says nothing about it.
fn state_of(verb: Verb, text: &str, number: &str) -> Option<PrState> {
    let low = if verb == Verb::Status {
        // `gh pr status` lists several PRs under headings; only the "Current branch" block is this chip's.
        let block = current_branch_block(&text.to_lowercase())?;
        let first = block.lines().find(|l| !l.trim().is_empty())?;
        let listed: String = first
            .trim_start()
            .strip_prefix('#')?
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if listed != number {
            return None;
        }
        block
    } else {
        text.to_lowercase()
    };
    match verb {
        Verb::Create { draft } => Some(if draft { PrState::Draft } else { PrState::Open }),
        Verb::Checks => {
            let marks: Vec<&str> = text.lines().filter_map(|l| l.split('\t').nth(1)).collect();
            let any = |m: &str| marks.iter().any(|c| c.trim() == m);
            if any("fail") || low.contains("some checks were not successful") {
                Some(PrState::ChecksFail)
            } else if any("pending") || low.contains("still running") {
                None
            } else if any("pass") || low.contains("all checks were successful") {
                Some(PrState::ChecksPass)
            } else {
                None
            }
        }
        Verb::View | Verb::Status => {
            let has = |s: &str| low.contains(s);
            let field = |name: &str| {
                low.lines()
                    .find_map(|l| l.trim().strip_prefix(name).map(|v| v.trim().to_string()))
            };
            let state = field("state:").unwrap_or_default();
            if state == "merged" || has("\"state\":\"merged\"") || has("\"state\": \"merged\"") {
                Some(PrState::Merged)
            } else if state == "closed"
                || has("\"state\":\"closed\"")
                || has("\"state\": \"closed\"")
            {
                Some(PrState::Closed)
            } else if state == "draft" || has("\"isdraft\":true") || has("\"isdraft\": true") {
                Some(PrState::Draft)
            } else if approved(verb, &low) && !has("changes requested") {
                Some(PrState::Approved)
            } else if has("checks failing") || has("some checks were not successful") {
                Some(PrState::ChecksFail)
            } else if has("checks passing") || has("all checks were successful") {
                Some(PrState::ChecksPass)
            } else if state == "open" || has("\"state\":\"open\"") || has("\"state\": \"open\"") {
                Some(PrState::Open)
            } else {
                None
            }
        }
    }
}

/// `events` are the `data` of chat events, oldest first. The newest readable `gh pr` result sets the chip;
/// an error result, an unreadable one, or one without a GitHub PR link (and no earlier chip) changes nothing.
pub fn scan(events: &[Value]) -> Option<PrChip> {
    let mut pending: HashMap<&str, Verb> = HashMap::new();
    let mut chip: Option<PrChip> = None;
    for e in events {
        match e["kind"].as_str() {
            Some("tool_use") => {
                if let (Some(id), Some(name)) = (e["tool_id"].as_str(), e["name"].as_str())
                    && let Some(v) = command_of(name, &e["input"]).as_deref().and_then(verb)
                {
                    pending.insert(id, v);
                }
            }
            Some("tool_result") if e["is_error"] == false => {
                let Some(v) = e["tool_id"]
                    .as_str()
                    .and_then(|id| pending.get(id))
                    .copied()
                else {
                    continue;
                };
                let text = text_of(&e["output"]);
                let Some(url) = pr_url(&text).or_else(|| chip.as_ref().map(|c| c.url.clone()))
                else {
                    continue;
                };
                let number = url.rsplit('/').next().unwrap_or_default();
                let Some(state) = state_of(v, &text, number) else {
                    continue;
                };
                chip = Some(PrChip {
                    state,
                    url,
                    at: e["at"].as_str().map(Into::into),
                    linked: None,
                });
            }
            _ => {}
        }
    }
    chip
}

/// V2-8c: the PR links of successful `gh pr create` results in `events`, oldest first; the PRs an agent created are
/// the ones tier 2 may poll without a pin.
pub fn created(events: &[Value]) -> Vec<String> {
    let mut pending: HashMap<&str, Verb> = HashMap::new();
    let mut urls: Vec<String> = vec![];
    for e in events {
        match e["kind"].as_str() {
            Some("tool_use") => {
                if let (Some(id), Some(name)) = (e["tool_id"].as_str(), e["name"].as_str())
                    && let Some(v) = command_of(name, &e["input"]).as_deref().and_then(verb)
                {
                    pending.insert(id, v);
                }
            }
            Some("tool_result") if e["is_error"] == false => {
                if let Some(Verb::Create { .. }) =
                    e["tool_id"].as_str().and_then(|id| pending.get(id))
                    // gh prints the new PR's link as a line of its own, and agents often chain more commands
                    // after it. A link inside other text is a mention; two different link lines are not gh's alone.
                    && let Some(url) = only_link_line(&text_of(&e["output"]))
                    && !urls.contains(&url)
                {
                    urls.push(url);
                }
            }
            _ => {}
        }
    }
    urls
}
