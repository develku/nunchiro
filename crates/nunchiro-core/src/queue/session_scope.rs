//! Ticket 1030: the rule "Allow for this session" forwards. The session writes its `permission_suggestions`, so none is
//! forwarded (fail closed). Final scope (coordinator, after Codex looks on d749b565b, 6c5ea953f, 11da67d5d and
//! 801803366): only a Bash request Nunchiro's own risk check calls safe. Look v34 S2-1: real Claude suggests a folder
//! grant or a prefix ("npm *"), never the exact command, so the core builds its own rule: Bash with the exact command
//! text, destination this session, offered only when Claude offers a session option (it sent suggestions). No rule
//! when the command holds a pattern character (Claude would read it as a pattern). No prefix, no file or other tool
//! rule, no folder grant, no mode switch, no removal.
use serde_json::{Value, json};
use std::path::Path;

/// Characters Claude's rule matcher could read as a pattern, and line breaks.
const PATTERN: &[char] = &['*', '?', '[', ']', '{', '}', '\n', '\r'];

/// The rules to forward (one, destination `session`) and the words the card shows for them (the command). Both empty
/// when none is valid: then no "Allow for this session" is offered.
pub fn scoped(
    suggestions: &[Value],
    tool: &str,
    input: &Value,
    cwd: &Path,
) -> (Vec<Value>, Vec<String>) {
    let Some(command) = input["command"]
        .as_str()
        .map(str::trim)
        .filter(|c| tool == "Bash" && !c.is_empty() && !c.contains(PATTERN))
    else {
        return (vec![], vec![]);
    };
    if suggestions.is_empty() || super::risk::risky(Some("Bash"), &input.to_string(), cwd) {
        return (vec![], vec![]);
    }
    let rule = json!({"type":"addRules","behavior":"allow","destination":"session",
        "rules":[{"toolName":"Bash","ruleContent":command}]});
    (vec![rule], vec![command.to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/w/proj";
    fn scope(s: Value, tool: &str, input: Value) -> (Vec<Value>, Vec<String>) {
        scoped(&[s], tool, &input, Path::new(CWD))
    }
    fn rule(tool: &str, content: &str) -> Value {
        json!({"type":"addRules","behavior":"allow","destination":"localSettings","rules":[{"toolName":tool,"ruleContent":content}]})
    }
    fn exact(command: &str) -> Vec<Value> {
        vec![
            json!({"type":"addRules","behavior":"allow","destination":"session","rules":[{"toolName":"Bash","ruleContent":command}]}),
        ]
    }
    fn dirs(d: &[&str]) -> Value {
        json!({"type":"addDirectories","directories":d,"destination":"localSettings"})
    }
    const TOUCH: fn() -> Value = || json!({"command":"touch b.txt"});
    const RISKY: [&str; 3] = ["git push", "rm -rf build", "curl https://example.com"];

    #[test]
    fn a_wider_suggestion_forwards_only_the_exact_command() {
        // Look v34 S2-1: real Claude offers "npm *" or a folder grant; the core forwards Bash(npm test), nothing else.
        let npm = json!({"command":"npm test"});
        for s in [
            rule("Bash", "npm *"),
            rule("Bash", "npm:*"),
            rule("Bash", "*"),
            dirs(&[CWD]),
            dirs(&["/"]),
            json!({"type":"setMode","mode":"bypassPermissions","destination":"session"}),
        ] {
            let (kept, words) = scope(s.clone(), "Bash", npm.clone());
            assert_eq!(kept, exact("npm test"), "{s}");
            assert_eq!(words, vec!["npm test".to_string()], "{s}");
        }
        let all = [
            dirs(&[CWD]),
            rule("Bash", "touch:*"),
            rule("Bash", "touch b.txt"),
        ];
        let (kept, words) = scoped(&all, "Bash", &TOUCH(), Path::new(CWD));
        assert_eq!(
            (kept, words),
            (exact("touch b.txt"), vec!["touch b.txt".to_string()])
        );
    }

    #[test]
    fn no_session_option_or_a_pattern_character_offers_nothing() {
        // Claude offered no session option (no suggestions): no button.
        assert!(scoped(&[], "Bash", &TOUCH(), Path::new(CWD)).0.is_empty());
        for c in [
            "ls *.txt",
            "ls a?.txt",
            "ls [ab].txt",
            "touch {a,b}.txt",
            "touch a\nb",
            "echo a\rb",
            "",
            "   ",
        ] {
            let input = json!({ "command": c });
            assert!(scope(rule("Bash", c), "Bash", input).0.is_empty(), "{c:?}");
        }
    }

    #[test]
    fn a_risky_command_never_gets_a_session_rule() {
        for cmd in RISKY {
            let input = json!({ "command": cmd });
            assert!(
                crate::queue::risk::risky(Some("Bash"), &input.to_string(), Path::new(CWD)),
                "{cmd}"
            );
            assert!(
                scope(rule("Bash", cmd), "Bash", input).0.is_empty(),
                "{cmd}"
            );
        }
    }

    #[test]
    fn no_other_tool_ever_gets_a_session_rule() {
        // Codex looks on 11da67d5d and 801803366: Claude reads file rules as patterns (a bare name matches at any
        // depth), so no file tool gets one, whatever the suggestion says.
        for tool in [
            "Read",
            "Edit",
            "Write",
            "MultiEdit",
            "NotebookEdit",
            "WebFetch",
            "mcp__x__y",
        ] {
            let input = json!({"file_path":"/w/proj/config.json","url":"https://example.com","command":"ls"});
            for c in ["//w/proj/config.json", "config.json", "**", "ls"] {
                assert!(
                    scope(rule(tool, c), tool, input.clone()).0.is_empty(),
                    "{tool} {c}"
                );
            }
        }
    }
}
