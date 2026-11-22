//! `widget.toml` version 1: the only fields the sheet shows and a runner may act on.
use super::Level;
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    version: u32,
    kind: String,
    author: Option<String>,
    command: Option<Vec<String>>,
    entry: Option<String>,
    interval: Option<u64>,
    #[serde(default = "read_only")]
    permissions: Vec<Level>,
    #[serde(default)]
    network: Vec<String>,
    act: Option<Act>, // v1b-20
    #[serde(default)]
    read: Vec<String>, // v1b-33
}
fn read_only() -> Vec<Level> {
    vec![Level::Read]
}

/// What the sheet shows, from the parsed manifest and never from text the author wrote about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// `script`, `web` or `integration` (a board command approved on the same sheet).
    pub kind: String,
    /// "unknown" when the manifest has no `author`.
    pub author: String,
    /// The exact argv; empty for a web widget.
    pub command: Vec<String>,
    /// The web widget's entry file, relative to its folder; empty for commands.
    pub entry: String,
    pub interval_secs: Option<u64>,
    pub permissions: Vec<Level>,
    pub network: Vec<String>,
    // v1b-20
    pub act: Option<Act>,
    /// v1b-33: extra folders a script widget may read, as written (`~`, `~/...` or absolute), duplicates dropped.
    #[serde(default)]
    pub read: Vec<String>,
}

// v1b-20: a script widget's declarative act (`[act]`): a row click renders `template` from that row and sends it
// to the running session labelled `session` in the placement's project, or starts one `start` agent with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Act {
    pub template: String,
    pub session: Option<String>,
    pub start: Option<crate::api::AgentKind>,
}

pub fn parse(text: &str) -> Result<Manifest, String> {
    if text.len() > MAX_BYTES {
        return Err("widget.toml is too large".into());
    }
    let raw: Raw = toml::from_str(text).map_err(|e| format!("invalid widget.toml: {e}"))?;
    if raw.version != 1 {
        return Err(format!("unsupported widget.toml version {}", raw.version));
    }
    // v1b-31: the sheet shows every command word exactly as it runs.
    if let Some(c) = raw.command.iter().flatten().find_map(|a| unshown(a)) {
        return Err(format!(
            "command has a hidden, control or bidi character (U+{:04X}) the sheet cannot show",
            c as u32
        ));
    }
    let (command, entry) = match (raw.kind.as_str(), raw.command, raw.entry) {
        ("script" | "integration", Some(c), None)
            if !c.is_empty() && c.iter().all(|a| !a.is_empty()) =>
        {
            (c, String::new())
        }
        ("web", None, Some(e)) if safe_relative(&e) => (vec![], e),
        ("script" | "integration", ..) => {
            return Err("script needs a non-empty `command` and no `entry`".into());
        }
        ("web", ..) => return Err("web needs `entry` inside its folder and no `command`".into()),
        _ => return Err("kind must be script, web or integration".into()),
    };
    // v1b-21 r2 (ruling 09:48 Q2): the approval hash covers only the folder, so nothing outside it may be named.
    if let Some(a) = command
        .iter()
        .enumerate()
        .find(|(i, a)| !in_folder(a, *i == 0) || (*i > 0 && names_outside(a))) // v1b-21 r3
        .map(|(_, a)| a)
    {
        return Err(format!(
            "command path {a:?} is outside the widget folder; name a file in the folder, or as the program a binary in {}",
            SYSTEM_BIN.join(", ")
        ));
    }
    inline_script(&command)?; // v1b-21 r3
    if raw.interval == Some(0)
        || raw.interval > Some(86_400)
        || (raw.interval.is_some() && raw.kind == "web")
    {
        return Err("interval must be 1..=86400 seconds and only for commands".into());
    }
    let mut permissions = raw.permissions;
    permissions.sort_by_key(|l| *l as u8);
    permissions.dedup();
    if !permissions.contains(&Level::Read) {
        return Err("permissions must include read".into());
    }
    if let Some(h) = raw.network.iter().find(|h| !valid_host(h)) {
        return Err(format!("invalid network host {h:?}"));
    }
    if raw.author.as_deref().is_some_and(|a| unshown(a).is_some()) {
        return Err("author must not contain hidden, control or bidi characters".into());
    }
    // v1b-20
    if let Some(act) = &raw.act {
        if raw.kind != "script" || !permissions.contains(&Level::Act) {
            return Err("[act] is only for script widgets whose permissions include act".into());
        }
        match (&act.session, act.start) {
            (Some(label), None) if !label.trim().is_empty() && unshown(label).is_none() => {}
            (None, Some(crate::api::AgentKind::Claude | crate::api::AgentKind::Codex)) => {}
            _ => {
                return Err(
                    "[act] needs exactly one of session = \"<label>\" or start = \"claude\"|\"codex\""
                        .into(),
                );
            }
        }
        crate::widgets::act::fields(&act.template)?;
    }
    // v1b-33
    if !raw.read.is_empty() && raw.kind != "script" {
        return Err("read is only for script widgets".into());
    }
    if raw.read.len() > MAX_READ {
        return Err(format!("read lists at most {MAX_READ} paths"));
    }
    if let Some(p) = raw.read.iter().find(|p| !valid_read(p)) {
        return Err(format!(
            "invalid read path {p:?}: use ~, ~/<path> or an absolute path, without . or .. parts"
        ));
    }
    // `~/a/` and `~/a` name one folder: the first spelling stays.
    let same = |p: &str| p.trim_end_matches('/').to_string();
    let mut read: Vec<String> = vec![];
    for p in raw.read {
        if !read.iter().any(|r| same(r) == same(&p)) {
            read.push(p);
        }
    }
    Ok(Manifest {
        read,
        act: raw.act, // v1b-20
        kind: raw.kind,
        author: raw
            .author
            .filter(|a| !a.trim().is_empty())
            .unwrap_or_else(|| "unknown".into()),
        command,
        entry,
        interval_secs: raw.interval,
        permissions,
        network: raw.network,
    })
}

/// v1b-31 (S4): the first character the sheet would not draw: anything outside the shared `delivery::shown`
/// allowlist (controls, bidi, tag characters, zero-width, line separators; the space is Zs and shown), so the sheet
/// and the CLI show text as it runs, in that order, and never move the cursor.
fn unshown(text: &str) -> Option<char> {
    text.chars().find(|c| !crate::delivery::shown(*c))
}

// v1b-21 r2: program folders argv[0] may name; /opt/homebrew/bin and /usr/local/bin are user-writable (ruling 09:48).
const SYSTEM_BIN: [&str; 6] = [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];
/// No `..` component anywhere; absolute only for argv[0] directly inside a SYSTEM_BIN folder.
fn in_folder(arg: &str, program: bool) -> bool {
    if arg.split('/').any(|part| part == "..") {
        return false;
    }
    if !arg.starts_with('/') {
        return true;
    }
    program
        && SYSTEM_BIN.iter().any(|dir| {
            arg.strip_prefix(dir)
                .and_then(|rest| rest.strip_prefix('/'))
                .is_some_and(|name| !name.is_empty() && !name.contains('/'))
        })
}

// v1b-21 r3: characters that end a path inside a word (`--file=/x`, `@/x`, `sh -c '. /x'`).
fn separator(c: char) -> bool {
    c.is_whitespace() || "=@:,;'\"()[]{}<>|&`$".contains(c)
}
/// A path starting anywhere inside the word (at its start or after a separator), or a `..` component. A `//` right
/// after `:` is a URL, not a path. v1b-31 (S2): so is a `file:` URL, a `~` or `~user` home path, and a path under
/// a variable (`$HOME/`, `${HOME}/`), which a shell or the program expands.
fn names_outside(word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    // v1b-31 r2: a path glued to a short option (`-o/x`, `-C/x`, `-I../x`, `-o~/x`) begins right after the one
    // option letter, so it is a start only when a path marker (`/ ~ $ .`) follows it. A glued relative name
    // (`-Ilib/sub`) is not a path (`names_outside` would else read the first `/` as absolute).
    let glued = chars.first() == Some(&'-')
        && chars.get(1).is_some_and(char::is_ascii_alphanumeric)
        && chars
            .get(2)
            .is_some_and(|c| matches!(c, '/' | '~' | '$' | '.'));
    let starts = |k: usize| k == 0 || separator(chars[k - 1]) || (glued && k == 2);
    let absolute = (0..chars.len()).any(|k| {
        chars[k] == '/'
            && starts(k)
            && !(k > 0 && chars[k - 1] == ':' && chars.get(k + 1) == Some(&'/'))
    });
    // v1b-31
    let home = (0..chars.len()).any(|k| {
        starts(k)
            && (chars[k..]
                .iter()
                .take(5)
                .flat_map(|c| c.to_lowercase())
                .eq("file:".chars())
                || (chars[k] == '~'
                    && chars[k + 1..]
                        .iter()
                        .find(|c| !(c.is_alphanumeric() || "_.-".contains(**c)))
                        .is_none_or(|c| *c == '/')))
    });
    // `$NAME/` or `${NAME}/`; a jq `$v` or awk `$3/2` names no path.
    let name = |c: &char| c.is_alphanumeric() || *c == '_';
    let variable = (0..chars.len()).filter(|d| chars[*d] == '$').any(|d| {
        let braced = chars.get(d + 1) == Some(&'{');
        let start = d + 1 + usize::from(braced);
        let end = start
            + chars[start.min(chars.len())..]
                .iter()
                .take_while(|c| name(c))
                .count();
        let close = end + usize::from(braced);
        chars
            .get(start)
            .is_some_and(|c| c.is_alphabetic() || *c == '_')
            && (!braced || chars.get(end) == Some(&'}'))
            && chars.get(close) == Some(&'/')
    });
    // `-` and the option letter are ASCII, so the glued value begins at byte 2.
    let parent = |w: &str| {
        w.split(|c| c == '/' || separator(c))
            .any(|part| part == "..")
    };
    absolute || home || variable || parent(word) || (glued && parent(&word[2..]))
}
/// v1b-31 r4: the option words perl, ruby and python may take: (rule, exact words, flags that take a glued value made
/// of ASCII letters, digits, `_` and the listed characters). Unlisted means not accepted: any other option word is
/// refused as an inline script, so a new interpreter switch (or a cluster of them) never needs a new parse case.
/// `-M` takes only a bare module name (`use Name;`): an import list or an operator would paste code into `use`.
type FlagRow = (
    &'static str,
    &'static [&'static str],
    &'static [(&'static str, &'static str)],
);
const ALLOWED_INTERPRETER_FLAGS: &[FlagRow] = &[
    (
        "perl",
        &["-w", "-W", "-X", "-l", "-n", "-p", "-a", "-s", "-t", "-T"],
        &[("-I", "./:-"), ("-M", ":")],
    ),
    (
        "ruby",
        &["-w", "-W", "-l", "-n", "-p", "-a", "-s", "-Ku"],
        &[("-I", "./:-"), ("-r", "./:-")],
    ),
    (
        "python",
        &["-u", "-B", "-O", "-OO", "-I", "-E", "-s", "-S", "-b", "-q"],
        &[],
    ),
];

/// v1b-21 r3: an interpreter outside the folder (a system binary or a PATH name) never runs inline code, whose
/// text the folder hash cannot cover beyond the sheet line: shells `-c`, `env -S`, python `-c`, perl and ruby
/// `-e`, node `-e`/`--eval`/`-p`/`--print`, osascript `-e`. Other program languages (awk, sed, find -exec) are shown
/// verbatim and not parsed. v1b-31 (S1): every word that names an interpreter is checked, not only argv[0], so
/// wrappers (`env`, `nice`, `timeout`, `nohup`, `xargs`, and any other) never hide one. Only its options count, and
/// a word right after an option may be that option's value (`-o posix`, `-W ignore`, `-I lib`), so the options end
/// at `--` or at the first non-option word that does not directly follow an option (the script; later words go to
/// it). This refuses too much (`python3 -u run.py -c x`) rather than too little.
fn inline_script(command: &[String]) -> Result<(), String> {
    fn program(word: &str) -> Option<&str> {
        (!word.contains('/') || word.starts_with('/'))
            .then(|| word.rsplit('/').next().unwrap_or(word))
    }
    // v1b-31: interpreters sharing an inline flag share a rule. r2: `name` is case folded (see `fold_ascii`), and a
    // family name followed only by digits and dots is that family (`perl5.34`, `bash5`, `node22`); python matches
    // any `python*` name as before.
    fn rule(name: &str) -> Option<&'static str> {
        Some(
            match name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.') {
                "env" => "env",
                "sh" | "bash" | "zsh" | "dash" | "ksh" | "csh" | "tcsh" => "shell",
                "fish" => "fish",
                _ if name.starts_with("python") => "python",
                "perl" => "perl",
                "ruby" => "ruby",
                "node" | "nodejs" => "node",
                "osascript" => "osascript",
                _ => return None,
            },
        )
    }
    // `+o` sets a shell option like `-o`; `-` alone is an operand (read stdin).
    let option = |w: &str| w.len() > 1 && (w.starts_with('-') || w.starts_with('+'));
    let short = |w: &str, f: char| w.starts_with('-') && !w.starts_with("--") && w[1..].contains(f);
    // v1b-31 r4: a perl, ruby or python option word is accepted only when `ALLOWED_INTERPRETER_FLAGS` lists it.
    fn allowed(rule: &str, word: &str) -> bool {
        ALLOWED_INTERPRETER_FLAGS
            .iter()
            .filter(|(r, ..)| *r == rule)
            .any(|(_, flags, valued)| {
                flags.contains(&word)
                    || valued.iter().any(|(flag, extra)| {
                        word.strip_prefix(flag).is_some_and(|v| {
                            !v.is_empty()
                                && v.chars().all(|c| {
                                    c.is_ascii_alphanumeric() || c == '_' || extra.contains(c)
                                })
                        })
                    })
            })
    }
    // fish takes any unambiguous prefix of a long option (`--comm` for `--command`); `--c` already means --command.
    fn fish_long(word: &str, full: &str) -> bool {
        let got = word.split('=').next().unwrap_or(word);
        got.len() >= 3 && full.starts_with(got)
    }
    let long = |w: &str, f: &str| {
        w.strip_prefix(f)
            .is_some_and(|r| r.is_empty() || r.starts_with('='))
    };
    // Where each rule's last scan stopped: a word inside that scan, scanned again with the same rule, sees the same
    // words after it, so each rule reads argv once (`sh -a sh -a ...` stays linear).
    let mut scanned = std::collections::BTreeMap::new();
    for (i, word) in command.iter().enumerate() {
        let Some(name) = program(word) else { continue };
        // v1b-31 r2: APFS matches names after full case folding (`/bin/ſh` runs sh), so the rule does too; a program
        // whose name does not fold to ASCII names no system binary and only hides one on the sheet.
        let Some(folded) = fold_ascii(name) else {
            if i == 0 {
                return Err(format!(
                    "program name {name:?} must be ASCII (after case folding) so the sheet shows which program runs"
                ));
            }
            continue;
        };
        let Some(rule) = rule(&folded) else { continue };
        if scanned.get(rule).is_some_and(|end| i < *end) {
            continue;
        }
        let refuse = |flag: &str| {
            Err(format!(
                "inline script ({flag}) for {name} is refused; put the script in a file in the widget folder"
            ))
        };
        let mut after_option = false;
        let mut end = command.len();
        for (j, word) in command.iter().enumerate().skip(i + 1) {
            if word == "--" {
                end = j;
                break;
            }
            // v1b-31 r2: `--import=data:...`, `-r data:...` and loaders run inline JavaScript, an option or its value.
            if rule == "node" && word.to_lowercase().contains("data:") {
                return refuse(word);
            }
            if !option(word) {
                // env's NAME=VALUE words come before its command.
                if !after_option && !(rule == "env" && word.contains('=')) {
                    end = j;
                    break;
                }
                after_option = false;
                continue;
            }
            after_option = true;
            let inline = match rule {
                // GNU getopt takes any unambiguous prefix (`--sp`); `--s` is already only --split-string.
                "env" => {
                    short(word, 'S')
                        || word
                            .split('=')
                            .next()
                            .is_some_and(|f| f.len() >= 3 && "--split-string".starts_with(f))
                }
                "shell" => short(word, 'c'),
                // v1b-31 r2: fish `-C`/`--init-command` run code (bash `-C` is noclobber); fish takes any
                // unambiguous long-option prefix.
                "fish" => {
                    short(word, 'c')
                        || short(word, 'C')
                        || fish_long(word, "--command")
                        || fish_long(word, "--init-command")
                }
                "perl" | "ruby" | "python" => !allowed(rule, word),
                "node" => {
                    short(word, 'e')
                        || short(word, 'p')
                        || long(word, "--eval")
                        || long(word, "--print")
                }
                _ => short(word, 'e'),
            };
            if inline {
                return refuse(word);
            }
        }
        scanned.insert(rule, end);
    }
    Ok(())
}

/// v1b-31 r2: `name` lowercased after full case folding, the way APFS compares names: ASCII lowercases; `ß`/`ẞ` and
/// the Latin ligatures U+FB00-FB06 fold to several ASCII letters (CaseFolding.txt status F); any other character folds
/// to the ASCII letter in its simple case-fold class (`ſ` to s, Kelvin sign to k). None when a character has no ASCII
/// fold.
fn fold_ascii(name: &str) -> Option<String> {
    use regex_syntax::hir::{ClassUnicode, ClassUnicodeRange};
    let mut out = String::new();
    for c in name.chars() {
        let full = match c {
            '\u{DF}' | '\u{1E9E}' => "ss",
            '\u{FB00}' => "ff",
            '\u{FB01}' => "fi",
            '\u{FB02}' => "fl",
            '\u{FB03}' => "ffi",
            '\u{FB04}' => "ffl",
            '\u{FB05}' | '\u{FB06}' => "st",
            _ => "",
        };
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else if !full.is_empty() {
            out.push_str(full);
        } else {
            let mut class = ClassUnicode::new([ClassUnicodeRange::new(c, c)]);
            class.case_fold_simple();
            let ascii = class
                .iter()
                .flat_map(|r| r.start()..=r.end())
                .find(char::is_ascii)?;
            out.push(ascii.to_ascii_lowercase());
        }
    }
    Some(out)
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && unshown(path).is_none()
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
// v1b-33
const MAX_READ: usize = 32;
/// `~`, `~/<path>` or `/<path>`: no `.` or `..` part, nothing the sheet would not draw, and no `"` or `\` (the
/// sandbox profile quotes paths). `~user` and `$HOME` are refused: the runner expands only `~`.
fn valid_read(path: &str) -> bool {
    let rest = if path == "~" {
        ""
    } else if let Some(r) = path.strip_prefix("~/") {
        r
    } else if let Some(r) = path.strip_prefix('/') {
        r
    } else {
        return false;
    };
    path.len() <= 1024
        && unshown(path).is_none()
        && !path.contains(['"', '\\'])
        && rest.split('/').all(|part| part != "." && part != "..")
}
/// v1b-33: `entry` as a path under `user_home` (`~` and `~/` expanded); the runner and `home_wide` share it.
pub fn expand(entry: &str, user_home: &std::path::Path) -> std::path::PathBuf {
    let path = match entry.strip_prefix('~') {
        Some(rest) => user_home.join(rest.trim_start_matches('/')),
        None => entry.into(),
    };
    // Components drop a trailing slash and repeated slashes, so the sandbox sees one spelling.
    path.components().collect()
}
/// v1b-33: whether reading `entry` reads the whole home: it names the home or a folder holding it, as written
/// or after links resolve. The sheet's red warning comes from this, never from the author's text.
pub fn home_wide(entry: &str, user_home: &std::path::Path) -> bool {
    let path = expand(entry, user_home);
    let resolved = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    user_home.starts_with(&path) || resolved(user_home).starts_with(resolved(&path))
}

/// Exact lowercase hostnames only; no wildcard, port, scheme or path.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

#[cfg(test)]
mod tests {
    // v1b-31 r4: each option word against `ALLOWED_INTERPRETER_FLAGS`; refused words are the security reviews' r1-r3
    // bypasses, accepted words the r3 still-allowed list the table keeps.
    #[test]
    fn interpreter_flag_words_follow_the_table() {
        for (program, word, accepted) in [
            ("perl", "-w", true),
            ("perl", "-l", true),
            ("perl", "-Imy/lib", true),
            ("perl", "-Ilib/sub", true),
            ("perl", "-Mstrict", true),
            ("perl", "-MFile::Spec", true),
            ("ruby", "-rsome-thing", true),
            ("ruby", "-Ku", true),
            ("ruby", "-w", true),
            ("python3", "-u", true),
            ("python3", "-B", true),
            ("python3", "-O", true),
            ("python3", "-I", true),
            // r1-r3: code flags, alone or in a cluster
            ("perl", "-e", false),
            ("perl", "-E", false),
            ("perl", "-le", false),
            ("perl", "-Se", false),
            ("perl", "-l0e", false),
            ("perl", "-0777e", false),
            ("perl", "-CSe", false),
            ("perl", "-i.b -eprint 1", false),
            ("perl", "-F, -eprint 1", false),
            ("perl", "-D1 -eprint 1", false),
            ("perl", "-w -Mstrict", false),
            ("perl", "-Mstrict;print 1", false),
            ("perl", "-wMstrict;system q(id)", false),
            ("perl", "-mFoo;x", false),
            ("perl", "-I", false),
            ("perl", "-M", false),
            ("ruby", "-e", false),
            ("ruby", "-Se", false),
            ("ruby", "-Kue", false),
            ("ruby", "-T1e", false),
            ("ruby", "-w -e", false),
            ("python3", "-c", false),
            ("python3", "-bBc", false),
            ("python3", "-W", false),
            // r3 review M1: ruby `-K` eats one character, then reads switches again
            ("ruby", "-KEe", false),
            ("ruby", "-KIe", false),
            ("ruby", "-Kre", false),
            // r3 review S1, S2: perl `-d:` and a delimited `-F` pattern are pasted into code
            ("perl", "-d:PPPort;print(1)", false),
            ("perl", "-d:X=}));print(1);#", false),
            ("perl", "-F/,/);print(1);(/", false),
            // r4: a -M value is a bare module name; an import list (`=`) or an operator is not
            ("perl", "-MList::Util=sum", false),
            ("perl", "-MFoo-CORE::system", false),
            // r4: dropped from the r3 still-allowed list (clusters, unlisted value flags)
            ("perl", "-pi.bak", false),
            ("perl", "-lw", false),
            ("python3", "-Wignore::DeprecationWarning", false),
            ("ruby", "-rx y", false),
            ("perl", "--", true),
        ] {
            let command = [program, word, "run"].map(String::from);
            let result = super::inline_script(&command);
            assert_eq!(result.is_ok(), accepted, "{program} {word:?}: {result:?}");
            if let Err(e) = result {
                assert!(e.contains("inline script"), "{program} {word:?}: {e}");
            }
        }
    }
}
