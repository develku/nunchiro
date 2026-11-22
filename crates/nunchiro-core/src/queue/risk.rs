//! V2-8e (HIDEROWS): whether a permission request is risky: destructive, outside the session's folder, network, or
//! touching agent or git config. The one place this is decided; the window only shows it. Fail-closed: a tool, a program
//! or a shell form this does not know counts as risky (an allowlist, not a list of known-bad commands).
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Programs that only read, or write inside the folder, when every path they name is inside it (no `awk` or `sed`:
/// their scripts can run commands).
const PLAIN: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "wc",
    "echo",
    "printf",
    "pwd",
    "which",
    "true",
    "false",
    "test",
    "[",
    "date",
    "sort",
    "uniq",
    "diff",
    "cut",
    "tr",
    "jq",
    "stat",
    "file",
    "basename",
    "dirname",
    "realpath",
    "tree",
    "du",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "ln",
    "find",
    "make",
    "tsc",
    "eslint",
    "prettier",
    "pytest",
    "ruff",
    "jest",
    "vitest",
    "rustfmt",
    "clippy-driver",
    "cd",
];
/// Programs whose first word after the name (the subcommand) decides; everything else of theirs is risky.
const SUBCOMMANDS: &[(&str, &[&str])] = &[
    (
        "git",
        &[
            "status",
            "diff",
            "log",
            "show",
            "add",
            "commit",
            "rev-parse",
            "ls-files",
            "blame",
            "grep",
            "branch",
            "shortlog",
            "describe",
            "switch",
        ],
    ),
    (
        "cargo",
        &[
            "build", "test", "check", "clippy", "fmt", "run", "doc", "bench", "tree", "metadata",
            "nextest",
        ],
    ),
    ("npm", &["test", "run", "ls", "list", "outdated"]),
    (
        "pnpm",
        &[
            "test",
            "run",
            "ls",
            "list",
            "outdated",
            "typecheck",
            "lint",
            "build",
        ],
    ),
    ("yarn", &["test", "run", "lint", "build"]),
    ("bun", &["test", "run"]),
    ("pip", &[]),
    ("go", &["test", "build", "vet", "fmt"]),
];
/// Look v34 S3-1: package managers whose version query (`npm --version`, `npm -v`, and nothing after it) only reads.
const VERSION: &[&str] = &["npm", "pnpm", "yarn", "cargo", "pip"];
/// Long options that delete, force, write elsewhere, or run another program, on any allowed program (`--x=v` too).
/// Security review r1: `rg --pre`, `sort --compress-program`, `git grep -O`, `git switch --discard-changes`.
const LONG: &[&str] = &[
    "--pre",
    "--pre-glob",
    "--compress-program",
    "--open-files-in-pager",
    "--discard-changes",
    "--ext-diff",
    "--textconv",
    "--output",
    "--exec",
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--config",
    "--plugin",
    "--rulesdir",
    "--resolve-plugins-relative-to",
    "--files0-from",
    "--force",
    "--delete",
    "--hard",
    "--in-place",
    "--eval",
];
/// Short options (alone or bundled, as in `-rf` or `-O'sh'`) that delete, force, run a program, or name a config or
/// output file, on any allowed program. `grep`/`rg` take `-e`, `-f`, `-i`, `-C` as pattern and context options.
const SHORT: &[char] = &['f', 'D', 'd', 'M', 'O', 'i', 'c', 'e', 'C', 'x', 'o'];
/// Single-dash words `find` and `go` use to run or delete (`-toolexec` is go's runner).
const FLAGS: &[&str] = &[
    "-toolexec",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
];
/// Folders of agent and git configuration: a write there changes how the agent or git behaves (acceptance card).
/// Compared ignoring case: APFS is case-insensitive, so `.GIT/hooks` is `.git/hooks`.
const CONFIG: &[&str] = &[
    ".claude",
    ".codex",
    ".git",
    ".mcp.json",
    ".gitconfig",
    ".npmrc",
];

/// `tool` is the hook's `tool_name` (none for a screen-only or ACP item), `input` its `tool_input` JSON, `cwd` the
/// session's folder (its worktree).
pub fn risky(tool: Option<&str>, input: &str, cwd: &Path) -> bool {
    let Some(tool) = tool else { return true };
    // A session in `/` or a home folder reaches everything outside a project: nothing it asks is plain.
    if broad(cwd) {
        return true;
    }
    let Ok(Value::Object(input)) = serde_json::from_str::<Value>(input) else {
        return true;
    };
    let field = |k: &str| input.get(k).and_then(Value::as_str);
    let inside = |k: &str, required: bool| match input.get(k) {
        None | Some(Value::Null) => !required,
        Some(Value::String(p)) => within(p, cwd),
        Some(_) => false,
    };
    let writes = |k: &str| match input.get(k) {
        Some(Value::String(p)) => within(p, cwd) && !config(p),
        _ => false,
    };
    match tool {
        "Read" | "Glob" | "Grep" | "LS" | "NotebookRead" => {
            !(inside("file_path", false)
                && inside("path", false)
                && inside("notebook_path", false)
                && field("pattern").is_none_or(|p| !p.starts_with(['/', '~']) && !p.contains("..")))
        }
        "Edit" | "Write" | "MultiEdit" => !writes("file_path"),
        "NotebookEdit" => !writes("notebook_path"),
        "Bash" => field("command").is_none_or(|c| command_risky(c, cwd)),
        // WebFetch, WebSearch, MCP tools and anything new.
        _ => true,
    }
}

/// A path the tool names: inside `cwd` after lexical normalisation (a relative path is read against `cwd`). A session
/// folder of `/` or a home folder has nothing outside a project in it: no path is inside it.
fn within(path: &str, cwd: &Path) -> bool {
    if path.starts_with('~') || path.contains('$') || path.is_empty() || broad(cwd) {
        return false;
    }
    let root = normal(cwd);
    normal(&root.join(path)).starts_with(&root)
}

/// `/`, `/Users`, `/home`, `/var` or one folder under them (a home, `/var/root`), or `$HOME` itself.
fn broad(cwd: &Path) -> bool {
    let root = normal(cwd);
    let parts: Vec<_> = root
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .collect();
    let home = std::env::var_os("HOME").map(|h| normal(Path::new(&h)));
    parts.is_empty()
        || parts.len() <= 2
            && parts
                .first()
                .is_some_and(|p| ["Users", "home", "var"].iter().any(|h| p.as_os_str() == *h))
        || home.is_some_and(|h| h == root)
}

/// A path through agent or git configuration (any component).
fn config(path: &str) -> bool {
    Path::new(path).components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|c| CONFIG.iter().any(|k| k.eq_ignore_ascii_case(c)))
    })
}

fn normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn command_risky(command: &str, cwd: &Path) -> bool {
    // Substitutions, process substitution, line breaks and globs or escapes this does not expand: not readable.
    if ["$(", "`", "<(", ">(", "\n", "\r", "${"]
        .iter()
        .any(|s| command.contains(s))
    {
        return true;
    }
    let mut start = true;
    let mut program: Option<&str> = None;
    let mut sub: Option<&'static [&'static str]> = None;
    // Q9 psn-J7-2: `cd` with no folder (or `-`) goes outside, and the later paths are judged against `cwd`: it takes
    // exactly one folder, which the path check below keeps inside. The count of words after `cd`.
    let mut cd: Option<u8> = None;
    // A version query was read: any further word of this command is risky.
    let mut version = false;
    let words = words(command);
    for raw in &words {
        if matches!(raw.as_str(), ";" | "&&" | "||" | "|") {
            if cd.take() == Some(0) {
                return true;
            }
            start = true;
            program = None;
            sub = None;
            version = false;
            continue;
        }
        if version {
            return true;
        }
        // A lone `&`, subshells and groups, and shell keywords (`if`, `for`, `!`) are forms this does not read.
        if matches!(raw.as_str(), "&" | "(" | ")" | "{" | "}") {
            return true;
        }
        let word = raw
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '>' || c == '<' || c == '&');
        if start {
            start = false;
            // The program word is read as written: a redirection before it (`>cd cd`, `2>x cmd`) is a form this does
            // not read, so nothing is trimmed here.
            let word = raw.as_str();
            if word.contains(['<', '>']) {
                return true;
            }
            // `FOO=bar cmd`: an environment variable can make the program run another (`GIT_EXTERNAL_DIFF`, `PAGER`,
            // `LD_PRELOAD`), so any assignment is risky (security review r1).
            if raw.contains('=') {
                return true;
            }
            // A path to a program (`./x`, `/bin/rm`) runs something this cannot judge.
            if word.contains('/') {
                return true;
            }
            if let Some((_, subs)) = SUBCOMMANDS.iter().find(|(p, _)| *p == word) {
                program = Some(word);
                sub = Some(subs);
            } else if PLAIN.contains(&word) {
                program = Some(word);
                cd = (word == "cd").then_some(0);
            } else {
                return true;
            }
            continue;
        } else if let Some(subs) = sub {
            if matches!(raw.as_str(), "--version" | "-v")
                && program.is_some_and(|p| VERSION.contains(&p))
            {
                (sub, version) = (None, true);
                continue;
            }
            // The first word after a subcommand program is the subcommand; a flag before it (`git -c`) is risky.
            if !subs.contains(&word) {
                return true;
            }
            sub = None;
            continue;
        }
        // A `cd` with any redirection (`2>/dev/null`, `> x`, `>& x`) is not read: the redirection words make a bare
        // `cd`, which goes home, look like `cd <folder>`.
        if cd.is_some() && raw.contains(['<', '>']) {
            return true;
        }
        if let Some(n) = cd.as_mut() {
            *n += 1;
            if *n > 1 || word.starts_with('-') {
                return true;
            }
        }
        let pattern_flag =
            matches!(program, Some("grep" | "rg")) && matches!(word, "-e" | "-f" | "-i" | "-C");
        let long =
            word.starts_with("--") && LONG.contains(&word.split_once('=').map_or(word, |(k, _)| k));
        let short = !word.starts_with("--")
            && word.len() > 1
            && word.starts_with('-')
            && !word[1..].starts_with(|c: char| c.is_ascii_digit())
            && word[1..]
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .any(|c| SHORT.contains(&c));
        if (long || short || FLAGS.contains(&word)) && !pattern_flag {
            return true;
        }
        // `make VAR=value` overrides a variable such as SHELL; other programs take no such words.
        if program == Some("make") && word.contains('=') {
            return true;
        }
        // Any word that names a path outside the folder, or agent or git config (redirections included).
        let path = word.split_once('=').map_or(word, |(_, v)| v);
        let pathlike = path.starts_with(['/', '~', '$', '.']) || path.contains('/');
        if pathlike && path != "/dev/null" && (!within(path, cwd) || config(path)) {
            return true;
        }
    }
    // Nothing to run, a command that ends waiting for a program, or a subcommand program with no subcommand.
    words.is_empty() || start || sub.is_some() || cd == Some(0)
}

/// Shell words with simple quoting; separators are their own words.
fn words(command: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
    };
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => quote = Some(c),
            (None, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            (None, c) if c.is_whitespace() => flush(&mut cur, &mut out),
            // Q9 psn-J7-1: an unquoted brace is a group or a brace expansion (`{/etc/passwd,x}`): its own word,
            // which `command_risky` refuses.
            (None, ';' | '(' | ')' | '{' | '}') => {
                flush(&mut cur, &mut out);
                out.push(c.to_string());
            }
            // Q9 psn-J7-1: `x>/etc/hosts` redirects to `/etc/hosts`: the operator starts a new word so the target is
            // judged as a path. A file descriptor before it (`2>`, `&>`, `>>`) stays with it.
            (None, '<' | '>') => {
                if cur
                    .chars()
                    .any(|c| !c.is_ascii_digit() && !matches!(c, '<' | '>' | '&'))
                {
                    flush(&mut cur, &mut out);
                }
                cur.push(c);
            }
            (None, '&' | '|') => {
                // `2>&1` and `&>` are redirections, not separators.
                if c == '&' && (cur.ends_with('>') || chars.peek() == Some(&'>')) {
                    cur.push(c);
                    continue;
                }
                flush(&mut cur, &mut out);
                let mut op = c.to_string();
                if chars.peek() == Some(&c) {
                    op.push(chars.next().unwrap());
                }
                out.push(op);
            }
            (None, c) => cur.push(c),
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash(c: &str) -> bool {
        risky(
            Some("Bash"),
            &serde_json::json!({ "command": c }).to_string(),
            Path::new("/w/proj"),
        )
    }
    fn tool(t: &str, input: Value) -> bool {
        risky(Some(t), &input.to_string(), Path::new("/w/proj"))
    }

    #[test]
    fn plain_commands_inside_the_folder_are_not_risky() {
        for c in [
            "npm test",
            "cargo test --workspace",
            "ls -la src",
            "head -n 5 src/a.rs",
            "git log -p --stat",
            "git status",
            "git diff --stat",
            "git commit -m 'fix: x'",
            "touch done && ls -l done",
            "cat src/a.rs | grep -n foo",
            "cargo build 2>&1 | tail -5",
            "echo hi > out.txt",
            "grep -e pattern src/a.rs",
            "ls /w/proj/src",
            "echo x > /dev/null",
            "pnpm run typecheck",
        ] {
            assert!(!bash(c), "{c}");
        }
    }

    #[test]
    fn a_package_managers_version_query_is_not_risky() {
        // Look v34 S3-1: `npm --version` drew the red Caution card.
        for c in [
            "npm --version",
            "npm -v",
            "pnpm --version",
            "pnpm -v",
            "yarn --version",
            "yarn -v",
            "cargo --version",
            "cargo -v",
            "pip --version",
            "pip -v",
            "npm --version && cargo --version",
        ] {
            assert!(!bash(c), "{c}");
        }
        // Only the version flag alone: anything after it, another flag or program, or pip's other commands stay risky.
        for c in [
            "npm --version install zod",
            "npm -v x",
            "npm --version 2>&1",
            "npm --versions",
            "npm -V",
            "pip",
            "pip install requests",
            "pip -v install requests",
            "npx --version",
            "node --version",
            "bun --version",
            "npm -v; npm install zod",
        ] {
            assert!(bash(c), "{c}");
        }
    }

    #[test]
    fn destructive_commands_are_risky() {
        for c in [
            "rm -rf build/",
            "rm a.txt",
            "git reset --hard HEAD~1",
            "git push --force",
            "git clean -fdx",
            "git checkout -- .",
            "git branch -D old",
            "find . -name '*.o' -delete",
            "sudo make install",
            "chmod -R 777 .",
            "dd if=/dev/zero of=x",
            "cargo build; rm -rf target",
            "ls && /bin/rm x",
            "echo $(rm x)",
            "echo `rm x`",
            "bash -c 'ls'",
            "xargs rm < list",
            "python3 -c 'import os'",
            "node -e 'x'",
            "cp -f a b",
            "ls\nrm x",
            // Wrappers and shell forms (spec review r1): unknown programs and keywords are risky.
            "time rm -rf build",
            "timeout 5 rm -rf src",
            "nice rm -rf src",
            "! rm -rf src",
            "for f in a; do rm -rf src; done",
            "if true; then rm -rf src; fi",
            "git -c core.sshCommand=x push origin",
            "git -c alias.x='!rm -rf src' x",
            "awk 'BEGIN{system(\"rm -rf src\")}'",
            "sed 'e rm -rf src' a.txt",
            "perl -ne 'unlink'",
            "python3 -Ic 'x'",
            "node --eval=1",
            "sed -i s/a/b/ src/a.rs",
            "./script.sh",
            "ls & rm x",
            "(rm x)",
            "git",
            "cargo install ripgrep",
        ] {
            assert!(bash(c), "{c}");
        }
    }

    // Security review r1: allowlisted programs with an option that runs a command, env assignments that run one,
    // and destructive options that were missed.
    #[test]
    fn options_and_env_that_run_commands_are_risky() {
        for c in [
            "RUST_LOG=debug cargo run",
            "GIT_EXTERNAL_DIFF='sh -c \"rm -rf src\"' git diff",
            "FOO=1 ls",
            "rg --pre sh x",
            "rg --pre-glob '*' --pre sh x",
            "sort --compress-program=sh a",
            "git grep -O'sh' x",
            "git grep --open-files-in-pager=sh x",
            "git switch --discard-changes main",
            "git branch -M x main",
            "git diff --ext-diff",
            "git log --output=../x",
            "find . -fprint ../x",
            "make -f ../Makefile",
            "tree -o ../x",
            // Round 2 own pass: option spellings and forms.
            "rg --pre=sh x",
            "rg -uu --pre sh x",
            "git -c core.pager=sh diff",
            "git -C ../other status",
            "git diff --textconv",
            "git log --ext-diff -p",
            "git show --output=../x HEAD",
            "git switch -C main",
            "git switch -fc x",
            "ln -s /etc x",
            "ln -s ../.. up",
            "jq --rawfile a /etc/passwd .",
            "sort -T /tmp a",
            "cp a ../x",
            "mv a .git/config",
            "cargo --config 'target.x.runner=\"sh\"' test",
            "go test -exec sh ./...",
            "go build -toolexec sh",
        ] {
            assert!(bash(c), "{c}");
        }
    }

    // Q9 psn-J7-1 and psn-J7-2: a redirection glued to a word, a brace expansion, and a `cd` that leaves the folder.
    #[test]
    fn glued_redirections_braces_and_cd_out_are_risky() {
        for c in [
            "echo x>/etc/hosts",
            "echo x>~/.bashrc",
            "echo x>>/etc/hosts",
            "cat a<~/.ssh/id_rsa",
            "cat {/etc/passwd,x}",
            "cd && cat .ssh/id_rsa",
            "cd; echo x > .bashrc",
            "cd - && cat x",
            "cd -P && cat x",
            "cd",
            "cd a b",
            "cd >/dev/null",
            "cd 2>/dev/null",
            "cd 2>&1",
            "cd 2>/dev/null && echo x > .zshrc",
            "cd &>/dev/null; cat .ssh/id_rsa",
            "cd > /dev/null && echo x > .zshrc",
            "cd 2> x && echo x > .zshrc",
            "cd &> x && echo x > .zshrc",
            "cd >> x && echo x > .zshrc",
            "cd < x && echo x > .zshrc",
            "cd >| x && echo x > .zshrc",
            "cd 2>&1 && echo x > .zshrc",
            "cd >& /dev/null && echo x > .zshrc",
            "cd 2>& x && echo x > .zshrc",
            ">cd cd && echo x > .zshrc",
            "2>cd cd && echo x > .zshrc",
            "&>cd cd && echo x > .zshrc",
            "<cd cd && echo x > .zshrc",
            "cd src > /dev/null && ls",
            "cd src 2>/dev/null && ls",
            "cd src 2> /dev/null && ls",
            "cd > /dev/null src && ls",
        ] {
            assert!(bash(c), "{c}");
        }
        for c in [
            "cd src && cargo test",
            "cd src && ls",
            "cargo build 2>&1",
            "cd src && cargo build 2>&1",
            "cargo build 2>&1 | tail -5",
            "echo x>out.txt",
            "echo hi &>out.txt",
            "git commit -m 'a -> {b}'",
        ] {
            assert!(!bash(c), "{c}");
        }
    }

    #[test]
    fn config_paths_match_ignoring_case() {
        for c in [
            "echo x > .GIT/hooks/pre-commit",
            "cp a .Claude/settings.json",
            "cat x > .Codex/config.toml",
        ] {
            assert!(bash(c), "{c}");
        }
        assert!(tool(
            "Write",
            serde_json::json!({"file_path":"/w/proj/.CLAUDE/settings.json","content":"{}"})
        ));
        assert!(tool(
            "Edit",
            serde_json::json!({"file_path":".Git/config","old_string":"a","new_string":"b"})
        ));
    }

    #[test]
    fn a_home_or_root_session_folder_makes_everything_risky() {
        for root in ["/", "/Users/me", "/Users/me/"] {
            let r = |c: &str| {
                risky(
                    Some("Bash"),
                    &serde_json::json!({ "command": c }).to_string(),
                    Path::new(root),
                )
            };
            assert!(r("ls"), "{root}");
            assert!(r("touch a"), "{root}");
            assert!(
                risky(
                    Some("Write"),
                    &serde_json::json!({"file_path":"a.txt","content":""}).to_string(),
                    Path::new(root)
                ),
                "{root}"
            );
        }
    }

    #[test]
    fn paths_outside_the_folder_or_in_config_are_risky() {
        for c in [
            "cat ~/.ssh/id_rsa",
            "ls /etc",
            "echo x > /tmp/out",
            "cat ../other/secret",
            "ls $HOME",
            "cp a /w/proj2/b",
            "cat src/../../x",
            "echo x > .git/hooks/pre-commit",
            "cp a .claude/settings.json",
        ] {
            assert!(bash(c), "{c}");
        }
        assert!(tool("Read", serde_json::json!({"file_path":"/etc/passwd"})));
        assert!(tool(
            "Edit",
            serde_json::json!({"file_path":"/w/other/a.rs","old_string":"a","new_string":"b"})
        ));
        assert!(tool(
            "Write",
            serde_json::json!({"file_path":"../a.rs","content":""})
        ));
        assert!(tool(
            "Write",
            serde_json::json!({"file_path":"/w/proj/.claude/settings.json","content":"{}"})
        ));
        assert!(tool(
            "Edit",
            serde_json::json!({"file_path":".git/hooks/pre-commit","old_string":"a","new_string":"b"})
        ));
        assert!(tool(
            "Glob",
            serde_json::json!({"pattern":"/Users/**/*.key"})
        ));
        assert!(!tool(
            "Read",
            serde_json::json!({"file_path":"/w/proj/src/a.rs"})
        ));
        assert!(!tool(
            "Edit",
            serde_json::json!({"file_path":"src/a.rs","old_string":"a","new_string":"b"})
        ));
        assert!(!tool(
            "Grep",
            serde_json::json!({"pattern":"fn main","path":"src"})
        ));
    }

    #[test]
    fn network_commands_and_tools_are_risky() {
        for c in [
            "curl https://example.com",
            "wget x",
            "git push origin main",
            "git fetch",
            "npm install zod",
            "pnpm add react",
            "cargo install ripgrep",
            "pip install requests",
            "gh pr create",
            "ssh host",
            "npx some-tool",
        ] {
            assert!(bash(c), "{c}");
        }
        assert!(tool(
            "WebFetch",
            serde_json::json!({"url":"https://example.com","prompt":"x"})
        ));
        assert!(tool("WebSearch", serde_json::json!({"query":"x"})));
    }

    #[test]
    fn what_cannot_be_read_is_risky() {
        assert!(
            risky(None, r#"{"command":"ls"}"#, Path::new("/w/proj")),
            "a screen-only item"
        );
        assert!(risky(Some("Bash"), "not json", Path::new("/w/proj")));
        assert!(
            risky(Some("Bash"), r#"{"cmd":"ls"}"#, Path::new("/w/proj")),
            "no command field"
        );
        assert!(tool(
            "mcp__github__create_issue",
            serde_json::json!({"title":"x"})
        ));
        assert!(tool("SomeNewTool", serde_json::json!({})));
        assert!(
            tool("Edit", serde_json::json!({"old_string":"a"})),
            "an edit with no path"
        );
        assert!(tool("Read", serde_json::json!({"file_path": 3})));
        assert!(bash(""), "an empty command");
        assert!(bash("FOO=1"), "only an assignment");
    }
}
