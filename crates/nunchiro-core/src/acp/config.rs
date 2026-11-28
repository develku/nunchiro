//! `agents.toml` under NUNCHIRO_HOME: `[[agent]]` tables of `name`, `command` (an absolute path), `args` and `env`
//! (the names of the core's environment variables the agent may see, never values). Any other key refuses the whole
//! file, so a value can never be smuggled in beside a name. An entry runs only once a human approved its exact content
//! (`approval::check_agent`).
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path};

const MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "ConfigEntry"))]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<String>,
    /// Ticket 358: the name the window shows instead of `name`. Only a label: outside the approval hash, so changing it
    /// asks for no new approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

impl Entry {
    /// The same entry as far as the approval goes: everything but the display name.
    pub(crate) fn same_content(&self, other: &Entry) -> bool {
        (&self.name, &self.command, &self.args, &self.env)
            == (&other.name, &other.command, &other.args, &other.env)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    agent: Vec<Entry>,
}

pub(crate) fn env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

pub fn load(home: &Path) -> Result<Vec<Entry>, String> {
    let file = match crate::store::open_regular(&home.join("agents.toml")) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("agents.toml: {e}")),
    };
    let mut text = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("agents.toml: {e}"))?;
    parse(&text)
}

/// The entries `load` reads. A display that passes for another agent is dropped, not refused: that row shows its real name
/// and the other entries still load and run. A file the app wrote can reach this (a later release bundles the same label).
pub(crate) fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let mut entries = parse_entries(text)?;
    let taken: Vec<bool> = entries.iter().map(|e| display_taken(&entries, e)).collect();
    for (entry, taken) in entries.iter_mut().zip(taken) {
        if taken {
            entry.display = None;
        }
    }
    Ok(entries)
}

/// The owner's write: as `parse`, but entry `name`'s display must not pass for another agent. Only that entry is judged, so
/// an old conflict elsewhere blocks no other write, and removing the entry that holds one (no `name` left) always works.
pub(crate) fn parse_for_write(text: &str, name: &str) -> Result<Vec<Entry>, String> {
    let entries = parse_entries(text)?;
    if entries
        .iter()
        .any(|e| e.name == name && display_taken(&entries, e))
    {
        return Err(format!(
            "invalid agents.toml: {name}: display: that name belongs to another agent"
        ));
    }
    Ok(entries)
}

/// The entries of an `agents.toml` text under every rule but the display conflicts.
fn parse_entries(text: &str) -> Result<Vec<Entry>, String> {
    if text.len() as u64 > MAX_BYTES {
        return Err("agents.toml is too large".into());
    }
    let file: File = toml::from_str(text).map_err(|e| format!("invalid agents.toml: {e}"))?;
    let mut names = std::collections::BTreeSet::new();
    for e in &file.agent {
        if !names.insert(&e.name) {
            return Err(format!(
                "invalid agents.toml: bad or repeated name {:?}",
                e.name
            ));
        }
        validate(e)?;
    }
    Ok(file.agent)
}

/// `agents.toml` is agent-writable and `display` sits outside the approval hash, so an entry may not take a name that passes
/// for another agent: Claude's or Codex's own, another entry's name or display, or a bundled agent's other than its own.
// ponytail: compared trimmed and case-folded, so a look-alike in another script (Cyrillic С in "Сlaude") still passes, and the
// collapsed Accounts and New session rows show only the display (ticket 358 Notes has that follow-up). Add a confusables
// table if a look-alike is ever seen.
fn display_taken(entries: &[Entry], e: &Entry) -> bool {
    let Some(display) = e.display.as_deref() else {
        return false;
    };
    let same = |a: &str, b: &str| a.trim().to_lowercase() == b.trim().to_lowercase();
    ["Claude", "Claude Code", "Codex"]
        .iter()
        .any(|n| same(display, n))
        || super::known()
            .iter()
            .filter(|k| k.name != e.name)
            .any(|k| same(display, &k.name) || same(display, &k.label))
        || entries.iter().filter(|o| o.name != e.name).any(|o| {
            same(display, &o.name) || o.display.as_deref().is_some_and(|d| same(display, d))
        })
}

/// One entry under the rules of `load`.
pub(crate) fn validate(e: &Entry) -> Result<(), String> {
    if !crate::approval::valid_name(&e.name) {
        return Err(format!(
            "invalid agents.toml: bad or repeated name {:?}",
            e.name
        ));
    }
    if !Path::new(&e.command).is_absolute() || e.command.contains('\0') {
        return Err(format!(
            "invalid agents.toml: {}: command must be an absolute path",
            e.name
        ));
    }
    if e.args.len() > 64 || e.args.iter().any(|a| a.len() > 4096 || a.contains('\0')) {
        return Err(format!("invalid agents.toml: {}: bad args", e.name));
    }
    let mut seen = std::collections::BTreeSet::new();
    if e.env.len() > 64 || e.env.iter().any(|n| !env_name(n) || !seen.insert(n)) {
        return Err(format!(
            "invalid agents.toml: {}: env holds variable names only",
            e.name
        ));
    }
    // An account name's rule: the file can be edited by an agent, and this text reaches the window's rows.
    if let Some(Err(reason)) = e.display.as_deref().map(crate::accounts::check_label) {
        return Err(format!(
            "invalid agents.toml: {}: display: {}",
            e.name,
            reason.replacen("account name", "display name", 1)
        ));
    }
    Ok(())
}

pub fn find(home: &Path, name: &str) -> Result<Entry, String> {
    load(home)?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("no agent {name:?} in agents.toml"))
}

/// Whether `s` names Claude: for each whitespace token (a shell string holds several) and the value after its first
/// `=`, the last path segment (split on `/` and `\`, minus one `@version` and one known extension) holds "claude", or
/// the package folder under a `node_modules/` does. A folder anywhere else in the path does not count.
// shortcut: a final segment that merely contains the word (`claude-notes`, `my-claude`) is refused; `npx @claude/agent`,
// `foo@claude`, a renamed or wrapped binary and a symlink named otherwise are not seen. The approval hash gates the rest.
fn names_claude(s: &str) -> bool {
    s.split_whitespace()
        .flat_map(|t| std::iter::once(t).chain(t.split_once('=').map(|(_, v)| v)))
        .any(|t| {
            let lower = t.to_ascii_lowercase();
            let segments: Vec<&str> = lower.split(['/', '\\']).collect();
            let base = segments.last().copied().unwrap_or("");
            let base = match base.rfind('@') {
                Some(i) if i > 0 => &base[..i],
                _ => base,
            };
            let base = [".js", ".mjs", ".cjs", ".ts", ".exe", ".cmd", ".bat"]
                .iter()
                .find_map(|x| base.strip_suffix(x))
                .unwrap_or(base);
            let named = |i: usize| segments.get(i).is_some_and(|x| x.contains("claude"));
            let installed = (0..segments.len()).any(|i| {
                segments[i] == "node_modules"
                    && (named(i + 1)
                        || (segments[i + 1..]
                            .first()
                            .is_some_and(|x| x.starts_with('@'))
                            && named(i + 2)))
            });
            base.contains("claude") || installed
        })
}

/// ADR Q3: Claude over ACP is API-key (or cloud provider) only; a Claude.ai subscription login is never used. An entry
/// whose command or adapter names Claude must let one of those credential sets through, or it is refused.
pub fn claude_refusal(entry: &Entry) -> Option<String> {
    let claude = std::iter::once(&entry.command)
        .chain(&entry.args)
        .any(|s| names_claude(s));
    let has = |n: &str| entry.env.iter().any(|e| e == n);
    let keyed = has("ANTHROPIC_API_KEY")
        || (has("CLAUDE_CODE_USE_BEDROCK") && (has("AWS_PROFILE") || has("AWS_ACCESS_KEY_ID")))
        || (has("CLAUDE_CODE_USE_VERTEX") && has("ANTHROPIC_VERTEX_PROJECT_ID"));
    (claude && !keyed).then(|| {
        "a Claude ACP agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK with AWS_PROFILE or AWS_ACCESS_KEY_ID, \
         or CLAUDE_CODE_USE_VERTEX with ANTHROPIC_VERTEX_PROJECT_ID) in its env names; Nunchiro never uses a Claude.ai \
         login over ACP"
            .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(command: &str, args: &[&str], env: &[&str]) -> Entry {
        Entry {
            name: "a".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: env.iter().map(|s| s.to_string()).collect(),
            display: None,
        }
    }
    #[test]
    fn a_display_cannot_pass_for_another_agent() {
        let file = |rows: &[(&str, &str)]| -> String {
            rows.iter()
                .map(|(n, d)| {
                    format!("[[agent]]\nname = {n:?}\ncommand = \"/bin/x\"\ndisplay = {d:?}\n")
                })
                .collect()
        };
        let display_of = |entries: &[Entry], name: &str| {
            entries
                .iter()
                .find(|e| e.name == name)
                .unwrap()
                .display
                .clone()
        };
        for rows in [
            vec![("mine", "Claude Code")],
            vec![("mine", "claude")],
            vec![("mine", "CODEX")],
            vec![("mine", "Gemini CLI")],
            vec![("mine", " gemini cli ")],
            vec![("mine", "gemini")],
            vec![("gemini", "OpenCode")],
            vec![("a", "b"), ("b", "other")],
            vec![("a", "Same"), ("b", "same")],
        ] {
            let text = file(&rows);
            let (name, _) = rows[0];
            // The owner's write is refused.
            let refused = parse_for_write(&text, name).expect_err(&format!("{rows:?}"));
            assert!(refused.contains("display"), "{refused}");
            // Reading the same file loses only the claimed label: every entry still loads.
            let read = parse(&text).unwrap_or_else(|e| panic!("{rows:?}: {e}"));
            assert_eq!(read.len(), rows.len(), "{rows:?}");
            assert_eq!(display_of(&read, name), None, "{rows:?}");
        }
        // Only the conflicting entry loses it, and a write is judged on the entry it writes: an old conflict elsewhere (a
        // label a later release bundled) blocks neither another entry's write nor the removal of the entry itself.
        let text = file(&[("a", "b"), ("b", "other")]);
        let read = parse(&text).unwrap();
        assert_eq!(display_of(&read, "a"), None);
        assert_eq!(display_of(&read, "b").as_deref(), Some("other"));
        parse_for_write(&text, "b").unwrap();
        parse_for_write(&text, "removed").unwrap();
        for rows in [
            vec![("gemini", "Gemini CLI")],
            vec![("gemini", "내 제미니")],
            vec![("mine", "mine")],
            vec![("a", "one"), ("b", "two")],
        ] {
            let text = file(&rows);
            let (name, shown) = rows[0];
            parse_for_write(&text, name).unwrap_or_else(|e| panic!("{rows:?}: {e}"));
            assert_eq!(
                display_of(&parse(&text).unwrap(), name).as_deref(),
                Some(shown)
            );
        }
    }
    #[test]
    fn claude_is_named_by_command_or_adapter_and_needs_a_key_set() {
        assert!(claude_refusal(&entry("/bin/gemini", &["--acp"], &[])).is_none());
        assert!(claude_refusal(&entry("/x/Claude-acp", &[], &["HOME"])).is_some());
        assert!(claude_refusal(&entry("/bin/npx", &["claude-agent-acp"], &[])).is_some());
        assert!(claude_refusal(&entry("/bin/npx", &["claude"], &["ANTHROPIC_API_KEY"])).is_none());
        assert!(claude_refusal(&entry("/bin/claude", &[], &["CLAUDE_CODE_USE_VERTEX"])).is_some());
    }
    #[test]
    fn claude_refusal_allows_claude_in_folder_names() {
        for (command, args) in [
            ("/Users/x/Projects/claude-notes/bin/agent", vec![]),
            ("/bin/agent", vec!["--cwd", "/Users/x/claude-notes/"]),
            ("/bin/agent", vec!["--cwd=/Users/x/claude-notes/"]),
            (
                "/usr/bin/python3",
                vec![
                    "/Users/x/orca/herdr-claude-link/crates/nunchiro-core/tests/fixtures/acp/fake_agent.py",
                ],
            ),
            ("/Users/x/claude/proj/bin/agent", vec![]),
        ] {
            assert!(
                claude_refusal(&entry(command, &args, &[])).is_none(),
                "{command} {args:?}"
            );
        }
    }
    #[test]
    fn claude_refusal_still_catches_every_claude_name() {
        for (command, args) in [
            ("/x/Claude-acp", vec![]),
            ("/bin/npx", vec!["claude-agent-acp"]),
            ("/bin/claude", vec![]),
            ("/usr/bin/npx", vec!["@zed-industries/claude-code-acp"]),
            ("/usr/bin/npx", vec!["claude-agent-acp@latest"]),
            (
                "/usr/bin/node",
                vec!["/opt/x/node_modules/.bin/claude-agent-acp.js"],
            ),
            ("/usr/bin/env", vec!["--agent=claude-agent-acp"]),
            ("/x/CLAUDE", vec![]),
            ("/usr/bin/node", vec![r"C:\tools\claude-agent-acp.cmd"]),
            // Accepted limit (fail-closed): a final segment that merely contains the word is refused.
            ("/usr/bin/npx", vec!["claude-notes-tool"]),
            ("/bin/agent", vec!["my-claude"]),
            ("/bin/agent", vec!["--cwd", "/Users/x/claude-notes"]),
        ] {
            assert!(
                claude_refusal(&entry(command, &args, &["HOME"])).is_some(),
                "{command} {args:?}"
            );
            assert!(
                claude_refusal(&entry(command, &args, &["ANTHROPIC_API_KEY"])).is_none(),
                "{command} {args:?}"
            );
        }
    }
    #[test]
    fn claude_refusal_reads_shell_strings_and_node_modules_packages() {
        for (command, args) in [
            ("/bin/sh", vec!["-c", "npx claude-agent-acp --cwd /home/x"]),
            ("/bin/sh", vec!["-c", "claude-agent-acp; cd /tmp"]),
            ("/bin/sh", vec!["-c", "cd /tmp && --agent=claude-agent-acp"]),
            (
                "/usr/bin/node",
                vec!["/usr/local/lib/node_modules/claude-agent-acp/"],
            ),
            (
                "/usr/bin/node",
                vec!["/usr/local/lib/node_modules/@zed-industries/claude-code-acp/dist/index.js"],
            ),
            (
                "/usr/local/lib/node_modules/claude-agent-acp/bin/run",
                vec![],
            ),
            (
                "/usr/bin/node",
                vec!["--entry=/opt/node_modules/claude-agent-acp//dist/x.js"],
            ),
            (
                "/bin/sh",
                vec!["-c", r"node C:\n\node_modules\claude-agent-acp\x.js"],
            ),
        ] {
            assert!(
                claude_refusal(&entry(command, &args, &["HOME"])).is_some(),
                "{command} {args:?}"
            );
            assert!(
                claude_refusal(&entry(command, &args, &["ANTHROPIC_API_KEY"])).is_none(),
                "{command} {args:?}"
            );
        }
        for (command, args) in [
            ("/bin/sh", vec!["-c", "agent --cwd /Users/x/claude-notes/"]),
            (
                "/usr/bin/node",
                vec!["/usr/local/lib/node_modules/gemini-cli/dist/index.js"],
            ),
            (
                "/usr/bin/node",
                vec!["/Users/x/claude-notes/node_modules/gemini-cli/index.js"],
            ),
        ] {
            assert!(
                claude_refusal(&entry(command, &args, &[])).is_none(),
                "{command} {args:?}"
            );
        }
    }
    #[test]
    fn env_names_only() {
        assert!(env_name("PATH") && env_name("_A1"));
        assert!(!env_name("1A") && !env_name("A=B") && !env_name(""));
    }
}
