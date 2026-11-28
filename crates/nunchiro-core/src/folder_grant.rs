//! The Assistant's folder grants. The owner's decision: a folder the owner names in a message typed in the window is
//! the Assistant's (the Home seat's) to read and write for that conversation. The Home seat starts `--restricted`, which
//! confines Claude's file tools to its working folders (a hook's allow does not widen them, and a changed `--settings`
//! file is not read again: probe, Claude Code 2.1.332), so the core adds the folder with Claude's own `/add-dir` and
//! answers its two questions for exactly that folder (`step`). Inside a granted folder the seat's lock hook lets Write,
//! Edit and plain `mkdir -p` / `mv -n` lines run unasked (`decide`); every other shell command asks as before. The
//! Remove action on the chat's line ends a grant: the hook then refuses the file tools there. A new conversation is a
//! new run and starts with none.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

/// What the hook reads: the run's granted folders and the ones the owner removed (canonical paths).
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Grants {
    #[serde(default)]
    pub granted: Vec<PathBuf>,
    #[serde(default)]
    pub removed: Vec<PathBuf>,
}

/// The run's grant file, beside its `--settings` file in the core's home (the seat cannot write there unasked).
pub fn file(home: &Path, session: &str) -> PathBuf {
    home.join("folders").join(format!("{session}.json"))
}

/// The hook's read: an absent or unreadable file is no grant (the mode decides, as before).
pub fn load(home: &Path, session: &str) -> Grants {
    std::fs::read(file(home, session))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub(crate) fn save(home: &Path, session: &str, grants: &Grants) -> Result<(), String> {
    crate::store::private_dir(&home.join("folders"))?;
    crate::store::atomic_write(
        &file(home, session),
        &serde_json::to_vec(grants).map_err(|e| e.to_string())?,
    )
}

/// The folders an owner's message names, as they would be granted. `text` is only what the owner typed in the window's
/// composer (pasted text, handoff context and image paths are left out there). Each path in it (starting with `/` or
/// `~/`; in quotes, or with `\ ` for a space, a path may hold spaces), outside `>` quote lines and ``` blocks, gives
/// the folder itself when it is one, or the folder of a file it names; canonical, unless `refused`. A path that does not
/// exist (a placeholder, or one cut at a space) gives none, never its parent.
pub fn named(text: &str, user_home: &Path, core_home: &Path) -> Vec<PathBuf> {
    let mut fenced = false;
    let mut out: Vec<PathBuf> = vec![];
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.starts_with('>') {
            continue;
        }
        for word in paths(line) {
            let path = match word.strip_prefix("~/") {
                Some(rest) => user_home.join(rest),
                None => PathBuf::from(&word),
            };
            if let Some(folder) = named_folder(&path)
                && !refused(&folder, user_home, core_home)
                && !out.contains(&folder)
            {
                out.push(folder);
            }
        }
    }
    out
}

/// The paths in one line: a word that starts with `/` or `~/` after a space or an opening bracket (`\ ` keeps a space
/// in it; trailing punctuation goes), or the whole text between quotes that starts so.
fn paths(line: &str) -> Vec<String> {
    let c: Vec<char> = line.chars().collect();
    let starts =
        |j: usize| c.get(j) == Some(&'/') || c.get(j) == Some(&'~') && c.get(j + 1) == Some(&'/');
    let (mut i, mut out) = (0, vec![]);
    while i < c.len() {
        let after_gap = i == 0 || c[i - 1].is_whitespace() || "([{<".contains(c[i - 1]);
        if after_gap && "\"'`".contains(c[i]) && starts(i + 1) {
            if let Some(end) = c[i + 1..].iter().position(|&q| q == c[i]) {
                out.push(c[i + 1..i + 1 + end].iter().collect());
                i += end + 2;
                continue;
            }
        } else if after_gap && starts(i) {
            let mut word = String::new();
            while i < c.len() && !c[i].is_whitespace() {
                if c[i] == '\\' && c.get(i + 1).is_some_and(|n| n.is_whitespace()) {
                    i += 1;
                }
                word.push(c[i]);
                i += 1;
            }
            out.push(
                word.trim_end_matches(|ch: char| ".,;:!?)]}>\"'`".contains(ch))
                    .to_string(),
            );
            continue;
        }
        i += 1;
    }
    out
}

/// Just before the add and once Claude says it is in: `folder` is still the folder that path names, and allowed.
pub fn still(folder: &Path, user_home: &Path, core_home: &Path) -> bool {
    named_folder(folder).as_deref() == Some(folder) && !refused(folder, user_home, core_home)
}

/// A character never typed into the seat's terminal: a control, format or line/paragraph separator (`\p{Cc}`,
/// `\p{Cf}`, `\p{Zl}`, `\p{Zp}`, as the window's drop of a file path refuses).
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x180E | 0x200B..=0x200F
            | 0x2028..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD
            | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// The folder a typed path names, canonical (links resolved): the path itself when it is a folder, the folder of a
/// file when it is one; `None` when it does not exist or holds `..`.
fn named_folder(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    if real.to_string_lossy().chars().any(unsafe_char) {
        return None;
    }
    if real.is_dir() {
        Some(real)
    } else {
        real.parent().map(Path::to_path_buf)
    }
}

/// Never granted (canonical `folder`, so a link to one of these is refused too): anything but a folder below the
/// user's home, below a volume's top folder or in a temporary folder; the home itself, `~/Library`, `~/Applications` and every
/// `~/.<name>` folder (credentials, settings); the core's home and what holds it; a folder that holds what Claude loads
/// from a working folder (`.claude`, `.mcp.json`, `CLAUDE.md`).
pub fn refused(folder: &Path, user_home: &Path, core_home: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (home, core) = (canon(user_home), canon(core_home));
    let below = |root: &Path, depth: usize| {
        folder
            .strip_prefix(root)
            .is_ok_and(|rest| rest.components().count() >= depth)
    };
    let in_home = folder.strip_prefix(&home).ok().and_then(|rest| {
        let first = rest.components().next()?.as_os_str().to_str()?.to_string();
        Some(!first.starts_with('.') && first != "Library" && first != "Applications")
    });
    let temp = [Path::new("/private/tmp"), Path::new("/private/var/folders")]
        .iter()
        .any(|root| below(root, if root.ends_with("folders") { 4 } else { 1 }));
    // Inside the home only the home's own rule counts (a home under a temporary folder keeps its dot folders out).
    let allowed = match in_home {
        Some(ok) => ok,
        None => below(Path::new("/Volumes"), 2) || temp,
    };
    let loads = [".claude", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md"]
        .iter()
        .any(|name| std::fs::symlink_metadata(folder.join(name)).is_ok());
    // Any dot folder on the way (`~/work/.aws`, `/Volumes/Backup/x/.ssh`): credentials and settings live there.
    let dotted = folder
        .components()
        .any(|c| c.as_os_str().to_str().is_none_or(|n| n.starts_with('.')));
    dotted
        || !allowed
        || home.starts_with(folder)
        || core.starts_with(folder)
        || folder.starts_with(&core)
        || loads
}

/// Where a file tool's path lands, canonical: the path itself when it exists, else its nearest existing parent with the
/// rest joined on. `None` for a relative path, one with `..`, or one through a link that leads nowhere (a write there
/// would land wherever the link points).
fn landing(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    if let Ok(real) = std::fs::canonicalize(path) {
        return Some(real);
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return None;
    }
    let parent = path.parent()?;
    Some(landing(parent)?.join(path.file_name()?))
}

/// Inside a granted folder, and not in what Claude loads or git keeps (the lock's deny list stays in charge there). The
/// last name is no link and no file with a second hard link: a write through either would change a file outside.
fn writable(path: &Path, grants: &Grants) -> bool {
    let plain = std::fs::symlink_metadata(path).map_or(true, |m| {
        !m.file_type().is_symlink() && (m.is_dir() || m.nlink() == 1)
    });
    plain
        && landing(path).is_some_and(|p| {
            grants.granted.iter().any(|g| p.starts_with(g))
                && !grants.removed.iter().any(|r| {
                    p.starts_with(r)
                        && !grants
                            .granted
                            .iter()
                            .any(|g| g.starts_with(r) && p.starts_with(g))
                })
                && !p.components().any(|c| {
                    [
                        ".claude",
                        ".git",
                        ".mcp.json",
                        "CLAUDE.md",
                        "CLAUDE.local.md",
                    ]
                    .iter()
                    // The Mac's disk ignores case: `.CLAUDE` is `.claude` there.
                    .any(|n| {
                        c.as_os_str()
                            .to_str()
                            .is_none_or(|c| c.eq_ignore_ascii_case(n))
                    })
                })
        })
}

/// `mv -n` moves a plain file only (no folder, no link, no second hard link): its folder must be inside, and so the
/// name.
fn movable(path: &Path, grants: &Grants) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file() && m.nlink() == 1)
        && path
            .parent()
            .zip(path.file_name())
            .is_some_and(|(dir, name)| writable(&dir.join(name), grants) && writable(dir, grants))
}

/// One `mkdir -p <paths>` or one `mv -n <files> <target>`, every path full and inside a granted folder. One command
/// only: paths are checked on the disk as it is before the line runs, and a first command could change what a second
/// one's paths lead to. Words are plain (letters, digits and `._/-+,:@%=`, one space between), so the shell reads
/// them as they are: no quote, glob, `~`, `$`, redirect, line break or other separator.
fn file_line(command: &str, grants: &Grants) -> bool {
    std::iter::once(command).all(|part| {
        let words: Vec<&str> = part.trim_matches(' ').split(' ').collect();
        if words.iter().any(|w| {
            w.is_empty()
                || !w
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._/-+,:@%=".contains(&b))
        }) {
            return false;
        }
        let paths = |ws: &[&str]| ws.iter().all(|w| w.starts_with('/'));
        match words.as_slice() {
            ["mkdir", "-p", rest @ ..] => {
                !rest.is_empty()
                    && paths(rest)
                    && rest.iter().all(|p| writable(Path::new(p), grants))
            }
            ["mv", "-n", rest @ ..] if rest.len() >= 2 && paths(rest) => {
                let (target, sources) = rest.split_last().unwrap();
                sources.iter().all(|s| movable(Path::new(s), grants))
                    && writable(Path::new(target), grants)
            }
            _ => false,
        }
    })
}

/// The programs a plain read line may run unasked inside a granted folder (the owner's list, nothing else).
const READERS: [&str; 5] = ["ls", "cat", "grep", "head", "wc"];

/// The words of one simple shell command, each with whether it holds an unquoted `*` or `?`; `None` for anything the
/// shell would read as more than words: a pipe, `;`, `&`, a redirect, `$`, a backquote, a subshell, `~`, a brace, a
/// line break or a comment. Single quotes keep anything; double quotes keep text with no `$`, backquote or `\`.
fn words(line: &str) -> Option<Vec<(String, bool)>> {
    let (mut out, mut word, mut chars) = (vec![], None::<(String, bool)>, line.chars());
    while let Some(c) = chars.next() {
        match c {
            ' ' => out.extend(word.take()),
            '\'' => {
                let w = word.get_or_insert_default();
                loop {
                    match chars.next()? {
                        '\'' => break,
                        ch => w.0.push(ch),
                    }
                }
            }
            '"' => {
                let w = word.get_or_insert_default();
                loop {
                    match chars.next()? {
                        '"' => break,
                        '$' | '`' | '\\' | '!' => return None,
                        ch => w.0.push(ch),
                    }
                }
            }
            '*' | '?' => {
                let w = word.get_or_insert_default();
                w.0.push(c);
                w.1 = true;
            }
            c if c.is_ascii_alphanumeric() || "._/-+,:@%=".contains(c) => {
                word.get_or_insert_default().0.push(c)
            }
            _ => return None,
        }
    }
    out.extend(word);
    Some(out)
}

/// `*` and `?` as the shell matches one name (a leading dot is never matched: such names are refused anyway).
fn wild(pattern: &[char], name: &[char]) -> bool {
    match (pattern.split_first(), name.split_first()) {
        (None, None) => true,
        (Some(('*', rest)), _) => wild(rest, name) || !name.is_empty() && wild(pattern, &name[1..]),
        (Some(('?', rest)), Some((_, more))) => wild(rest, more),
        (Some((p, rest)), Some((n, more))) => p == n && wild(rest, more),
        _ => false,
    }
}

/// A path a read may touch: it exists, and resolved it is inside a granted folder, in no dot folder or Claude file
/// there (any letter case), neither in nor above a removed folder, and no file with a second hard link.
fn readable(path: &Path, grants: &Grants) -> bool {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    grants.granted.iter().any(|g| {
        real.strip_prefix(g).is_ok_and(|rest| {
            !rest.components().any(|c| {
                c.as_os_str().to_str().is_none_or(|n| {
                    n.starts_with('.')
                        || n.eq_ignore_ascii_case("CLAUDE.md")
                        || n.eq_ignore_ascii_case("CLAUDE.local.md")
                })
            })
        })
    }) && !grants.removed.iter().any(|r| {
        // A removed folder: nothing in it (unless given again below it), and no read whose start holds it.
        r.starts_with(&real)
            || real.starts_with(r)
                && !grants
                    .granted
                    .iter()
                    .any(|g| g.starts_with(r) && real.starts_with(g))
    }) && std::fs::metadata(&real).is_ok_and(|m| m.is_dir() || m.nlink() == 1)
}

/// One plain `ls`, `cat`, `grep`, `head` or `wc` whose every path (a relative one, or none, from `cwd`) is `readable`.
/// A glob only in the last name, matched here against that folder's entries, each of which must be readable. grep may
/// not read patterns from a file, follow links when recursive, or take `-d`/`-D`; ls may not follow links.
fn read_line(command: &str, cwd: Option<&Path>, grants: &Grants) -> bool {
    let Some(words) = words(command) else {
        return false;
    };
    let Some(((program, _), args)) = words.split_first() else {
        return false;
    };
    if !READERS.contains(&program.as_str()) {
        return false;
    }
    // grep's first plain word is its pattern unless one comes with -e or --regexp (anywhere: GNU grep reorders).
    let given = args.iter().any(|(w, _)| {
        w.starts_with("--reg") || w.starts_with('-') && !w.starts_with("--") && w.contains('e')
    });
    let (mut paths, mut pattern, mut ended, mut args) =
        (vec![], program != "grep" || given, false, args.iter());
    while let Some(arg) = args.next() {
        let w = arg.0.as_str();
        if !ended && w == "--" {
            ended = true;
        } else if !ended && w.len() > 1 && w.starts_with('-') && !arg.1 {
            if let Some(long) = w.strip_prefix("--") {
                let (name, inline) = long
                    .split_once('=')
                    .map_or((long, false), |(n, _)| (n, true));
                let valued = [
                    "regexp",
                    "max-count",
                    "context",
                    "after-context",
                    "before-context",
                    "lines",
                    "bytes",
                ];
                if [
                    "file",
                    "exclude-from",
                    "files0-from",
                    "dereference-recursive",
                    "dereference",
                    "directories",
                    "devices",
                ]
                .iter()
                .any(|f| f.starts_with(name))
                // getopt takes any unique start of a long name
                {
                    return false;
                }
                pattern |= name == "regexp";
                if valued.contains(&name) && !inline && args.next().is_none() {
                    return false;
                }
                continue;
            }
            let flags = &w[1..];
            let value_next = match program.as_str() {
                "grep" if flags.contains(['f', 'R', 'd', 'D']) => return false,
                "grep" => {
                    flags.find(['e', 'm', 'A', 'B', 'C']).map(|at| {
                        pattern |= flags.as_bytes()[at] == b'e';
                        at + 1 == flags.len()
                    }) == Some(true)
                }
                "ls" if flags.contains('L') => return false,
                "head" => flags == "n" || flags == "c",
                _ => false,
            };
            if value_next && args.next().is_none() {
                return false;
            }
        } else if !pattern {
            pattern = true;
        } else {
            paths.push(arg);
        }
    }
    let place = |p: &str| match Path::new(p) {
        p if p.is_absolute() => Some(p.to_path_buf()),
        p => cwd.filter(|c| readable(c, grants)).map(|c| c.join(p)),
    };
    if paths.is_empty() {
        return cwd.is_some_and(|c| readable(c, grants));
    }
    paths.iter().all(|(w, glob)| {
        if !glob {
            return place(w).is_some_and(|p| readable(&p, grants));
        }
        let (dir, name) = w.rsplit_once('/').map_or((".", w.as_str()), |(d, n)| {
            (if d.is_empty() { "/" } else { d }, n)
        });
        if dir.contains(['*', '?']) || name.starts_with('.') || w.contains("..") {
            return false;
        }
        let Some(dir) = place(dir).filter(|d| readable(d, grants)) else {
            return false;
        };
        let pattern: Vec<char> = name.chars().collect();
        std::fs::read_dir(&dir).is_ok_and(|entries| {
            entries.flatten().all(|e| {
                let n: Vec<char> = e.file_name().to_string_lossy().chars().collect();
                n.first() == Some(&'.')
                    || !wild(&pattern, &n)
                    || readable(&dir.join(e.file_name()), grants)
            })
        })
    })
}

/// Why the hook lets a call run, or refuses it; `None` leaves the call to the lock's own rules.
pub enum Verdict {
    Allow(&'static str),
    Deny(&'static str),
}

/// The hook's grant rules for one call: Write, Edit, the plain file line and a plain read line (`read_line`, from the
/// call's working folder `cwd`) run unasked inside a granted folder; the
/// file tools are refused in a folder the owner removed (it stays one of Claude's working folders).
pub fn decide(tool: &str, input: &Value, cwd: Option<&Path>, grants: &Grants) -> Option<Verdict> {
    let path = |key: &str| input.get(key).and_then(Value::as_str).map(Path::new);
    let target = match tool {
        "Read" | "Write" | "Edit" => path("file_path"),
        "Glob" | "Grep" => path("path"),
        _ => None,
    };
    // While a folder is removed, a path the hook cannot place (relative, `..`, a link to nowhere) is refused too, and
    // so is a Glob search whose start (the folder part of its fixed prefix, from `path` or the working folder) lands
    // in it or holds it.
    let start = (tool == "Glob")
        .then(|| input.get("pattern").and_then(Value::as_str))
        .flatten()
        .and_then(|p| {
            let fixed = &p[..p.find(['*', '?', '[', '{']).unwrap_or(p.len())];
            let dir = Path::new(&fixed[..fixed.rfind('/').map_or(0, |at| at + 1)]);
            if p.starts_with(['/', '~']) {
                Some(dir.to_path_buf())
            } else {
                match target.or(cwd) {
                    Some(base) => Some(base.join(dir)),
                    None => p.contains("..").then(|| dir.to_path_buf()),
                }
            }
        });
    let gone = |t: &Path| {
        landing(t).is_none_or(|p| {
            grants
                .removed
                .iter()
                .any(|r| p.starts_with(r) || r.starts_with(&p))
                && !grants.granted.iter().any(|g| p.starts_with(g))
        })
    };
    if !grants.removed.is_empty()
        && target
            .map(Path::to_path_buf)
            .into_iter()
            .chain(start)
            .any(|t| gone(&t))
    {
        return Some(Verdict::Deny(
            "Home seat: the owner removed this folder's access for this conversation",
        ));
    }
    const GIVEN: &str = "Home seat: a folder the owner gave for this conversation";
    match tool {
        "Write" | "Edit" if target.is_some_and(|t| writable(t, grants)) => {
            Some(Verdict::Allow(GIVEN))
        }
        "Bash"
            if input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|c| file_line(c, grants) || read_line(c, cwd, grants)) =>
        {
            Some(Verdict::Allow(GIVEN))
        }
        _ => None,
    }
}

/// One step of adding a folder with Claude's `/add-dir`, read from the current screen.
#[derive(Debug, PartialEq)]
pub enum Step {
    Wait,
    Keys(&'static [u8]),
    Added,
    Failed,
}

/// Claude Code 2.1.332's `/add-dir <folder>`, mid-conversation: first "Adding a new directory: <folder> ... No, leave it
/// out / Yes, add it" (the cursor on No), then "Add directory to workspace ... 1. Yes, for this session" (the cursor on
/// it), then "Added <folder> as a working directory". `downed`: the core's own Down went out for this question (Enter
/// only after it, as the start question's answer does).
pub fn step(screen: &str, folder: &Path, downed: bool) -> Step {
    let flat: String = screen.split_whitespace().collect();
    let name: String = folder.to_string_lossy().split_whitespace().collect();
    if flat.contains(&format!("Added{name}asaworkingdirectory")) {
        return Step::Added;
    }
    if flat.contains(&format!("Didnotadd{name}")) {
        return Step::Failed;
    }
    if crate::waiting::screen::add_dir_folder(screen).as_deref()
        == Some(folder.to_string_lossy().as_ref())
        && screen.contains("No, leave it out")
    {
        let row = |label: &str| {
            screen
                .lines()
                .rev()
                .map(str::trim)
                .find(|l| l.ends_with(label))
                .map(|l| l.starts_with('\u{276f}'))
        };
        return match (row("No, leave it out"), row("Yes, add it")) {
            (Some(false), Some(true)) if downed => Step::Keys(b"\r"),
            (Some(true), Some(false)) if !downed => Step::Keys(b"\x1b[B"),
            _ => Step::Wait,
        };
    }
    if flat.contains("Adddirectorytoworkspace")
        && screen.lines().any(|l| l.trim() == folder.to_string_lossy())
        && screen
            .lines()
            .any(|l| l.trim().starts_with('\u{276f}') && l.contains("1. Yes, for this session"))
    {
        return Step::Keys(b"\r");
    }
    Step::Wait
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nested_for_cd(inside: &Path) -> Grants {
        Grants {
            granted: vec![inside.to_path_buf()],
            removed: vec![inside.join("inbox")],
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = Path::new("/private/tmp")
            .join(format!("nunchiro-folders-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    // The owner's words: a grant comes only from an existing folder, or the folder of an existing file, that the owner
    // typed; a path that does not exist (a placeholder, one cut at a space) gives none, never its parent; a path in a
    // quote line or a fenced block (pasted mail, web or tool text) gives none; a quoted or `\ ` path keeps its spaces.
    #[test]
    fn an_owner_message_names_its_folders() {
        let root = scratch("named");
        let (home, core) = (root.join("home"), root.join("core"));
        std::fs::create_dir_all(root.join("run/inbox")).unwrap();
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(root.join("run/inbox/a.eml"), "x").unwrap();
        let run = root.join("run");
        let text = format!(
            "Sort {}/inbox into {}/labels/Billing/, one label per mail.\n> forwarded: see {}/quoted\n```\n{}/fenced\n```",
            run.display(),
            run.display(),
            root.display(),
            root.display()
        );
        std::fs::create_dir_all(root.join("quoted")).unwrap();
        std::fs::create_dir_all(root.join("fenced")).unwrap();
        assert_eq!(named(&text, &home, &core), vec![run.join("inbox")]);
        std::fs::create_dir_all(root.join("My Orders/2026")).unwrap();
        let orders = root.join("My Orders");
        let r = root.display();
        assert!(
            named(
                &format!("file them in {r}/My Orders/2026 now"),
                &home,
                &core
            )
            .is_empty(),
            "cut at the space: {r}/My does not exist"
        );
        for typed in [
            format!("file them in \"{r}/My Orders\" now"),
            format!("file them in '{r}/My Orders'."),
            format!("file them in {r}/My\\ Orders, please"),
        ] {
            assert_eq!(named(&typed, &home, &core), vec![orders.clone()], "{typed}");
        }
        assert!(
            named(&format!("put it in {r}/run/missing/deeper"), &home, &core).is_empty(),
            "no parent of a missing path"
        );
        assert_eq!(
            named(
                &format!("Read {}/inbox/a.eml.", run.display()),
                &home,
                &core
            ),
            vec![run.join("inbox")]
        );
        assert!(named("no path here, only words", &home, &core).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    // The never list, on canonical paths: a link to a refused folder is refused too.
    #[test]
    fn credential_system_and_core_folders_are_never_granted() {
        let root = scratch("never");
        let home = root.join("home");
        let core = home.join("core-home");
        for d in [
            ".ssh",
            "Library/Keychains",
            "Applications/Some.app",
            "docs/work",
            "loads",
        ] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(home.join("loads/CLAUDE.md"), "x").unwrap();
        std::os::unix::fs::symlink(home.join(".ssh"), home.join("docs/ssh-link")).unwrap();
        let no = |p: PathBuf| refused(&std::fs::canonicalize(&p).unwrap(), &home, &core);
        assert!(!no(home.join("docs/work")), "an ordinary folder");
        for d in ["docs/.aws", "vol/x/.ssh/keys"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
            assert!(no(home.join(d)), "a dot folder below: {d}");
        }
        // A name with a control or format character never reaches the terminal.
        std::fs::create_dir_all(home.join("docs/a\u{202e}b")).unwrap();
        std::fs::create_dir_all(home.join("docs/c\u{7}d")).unwrap();
        assert!(
            named(
                &format!("in {}/docs/a\u{202e}b", home.display()),
                &home,
                &core
            )
            .is_empty()
        );
        assert!(
            named(
                &format!("in '{}/docs/c\u{7}d'", home.display()),
                &home,
                &core
            )
            .is_empty()
        );
        // Checked again just before the add: a folder swapped for a link is no longer the one named.
        let work = std::fs::canonicalize(home.join("docs/work")).unwrap();
        assert!(still(&work, &home, &core));
        std::fs::rename(home.join("docs/work"), home.join("docs/work-old")).unwrap();
        std::os::unix::fs::symlink(home.join(".ssh"), home.join("docs/work")).unwrap();
        assert!(!still(&work, &home, &core));
        for p in [
            PathBuf::from("/"),
            PathBuf::from("/etc"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/Volumes"),
            home.clone(),
            home.join(".ssh"),
            home.join("Library/Keychains"),
            home.join("Applications"),
            home.join("Applications/Some.app"),
            home.join("docs/ssh-link"),
            core.clone(),
            home.join("loads"),
        ] {
            assert!(no(p.clone()), "{}", p.display());
        }
        // A message naming them grants nothing.
        let text = format!(
            "look in {}/docs/ssh-link and ~/.ssh and {} and /etc",
            home.display(),
            core.display()
        );
        assert!(named(&text, &home, &core).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    // Write and the plain file line run unasked inside the folder, never outside it; rm and every other line are left
    // to the lock (they ask); after Remove the file tools are refused there.
    #[test]
    fn writes_inside_a_granted_folder_run_and_others_are_left_to_the_lock() {
        let root = scratch("decide");
        let (inside, outside) = (root.join("run"), root.join("other"));
        std::fs::create_dir_all(inside.join("inbox")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("inbox/a.eml"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, inside.join("away")).unwrap();
        let grants = Grants {
            granted: vec![inside.clone()],
            removed: vec![],
        };
        let allow = |tool: &str, input: Value, g: &Grants| {
            matches!(decide(tool, &input, None, g), Some(Verdict::Allow(_)))
        };
        let w = |p: PathBuf| json!({"file_path": p});
        let sh = |c: String| json!({"command": c});
        assert!(allow("Write", w(inside.join("drafts/reply.eml")), &grants));
        assert!(allow("Edit", w(inside.join("inbox/a.eml")), &grants));
        assert!(
            !allow("Write", w(outside.join("x.txt")), &grants),
            "outside"
        );
        assert!(
            !allow("Write", w(inside.join("away/x.txt")), &grants),
            "a link out"
        );
        assert!(
            !allow("Write", w(inside.join("../other/x.txt")), &grants),
            ".."
        );
        assert!(!allow(
            "Write",
            w(inside.join(".claude/settings.json")),
            &grants
        ));
        for p in [
            ".CLAUDE/settings.json",
            "sub/.Git/hooks/pre-commit",
            "x/Claude.MD",
            "x/.MCP.json",
        ] {
            assert!(!allow("Write", w(inside.join(p)), &grants), "{p}");
        }
        // A link that leads nowhere, as the last name or on the way, and a file with a second hard link outside.
        std::os::unix::fs::symlink(outside.join("new.txt"), inside.join("dangling")).unwrap();
        std::os::unix::fs::symlink(outside.join("newdir"), inside.join("dangling-dir")).unwrap();
        std::fs::write(outside.join("shared.txt"), "x").unwrap();
        std::fs::hard_link(outside.join("shared.txt"), inside.join("shared.txt")).unwrap();
        for p in ["dangling", "dangling-dir/x.txt", "shared.txt"] {
            assert!(!allow("Write", w(inside.join(p)), &grants), "{p}");
            assert!(!allow("Edit", w(inside.join(p)), &grants), "{p}");
        }
        let i = inside.display();
        assert!(allow(
            "Bash",
            sh(format!("mkdir -p {i}/labels/Billing {i}/labels/Meetings")),
            &grants
        ));
        assert!(allow(
            "Bash",
            sh(format!("mv -n {i}/inbox/a.eml {i}/inbox/a2.eml")),
            &grants
        ));
        // One changing command per line, and `mv -n` moves plain files only: a first command can change what a
        // second one's paths lead to (a folder moved onto a name whose link leads out).
        std::fs::create_dir_all(inside.join("d")).unwrap();
        std::os::unix::fs::symlink(&outside, inside.join("d/link")).unwrap();
        std::os::unix::fs::symlink(inside.join("inbox/a.eml"), inside.join("alias.eml")).unwrap();
        for line in [
            format!("rm {i}/inbox/a.eml"),
            format!("rm -rf {i}"),
            format!("mv {i}/inbox/a.eml {i}/labels/"),
            format!("mv -n {i}/inbox/a.eml {}/", outside.display()),
            format!("mkdir -p {}/x", outside.display()),
            format!("mkdir -p {i}/x; rm -rf {i}"),
            format!("mkdir -p {i}/x || rm -rf {i}"),
            format!("mkdir -p {i}/x && cat {i}/inbox/a.eml"),
            "mkdir -p labels".to_string(),
            format!("mkdir -p {i}/labels/Billing && mv -n {i}/inbox/a.eml {i}/labels/Billing/"),
            format!("mv -n {i}/d {i}/e && mv -n {i}/inbox/a.eml {i}/e/link/"),
            format!("mv -n {i}/d {i}/e && mkdir -p {i}/e/link/made"),
            format!("mkdir -p {i}/x\nmkdir -p {i}/y"),
            format!("mv -n {i}/d {i}/e"),
            format!("mv -n {i}/alias.eml {i}/inbox/"),
        ] {
            assert!(!allow("Bash", sh(line.clone()), &grants), "{line}");
        }
        // Removed: the file tools are refused there, writes too.
        let gone = Grants {
            granted: vec![],
            removed: vec![inside.clone()],
        };
        for tool in ["Read", "Write", "Edit"] {
            assert!(
                matches!(
                    decide(tool, &w(inside.join("inbox/a.eml")), None, &gone),
                    Some(Verdict::Deny(_))
                ),
                "{tool}"
            );
        }
        assert!(matches!(
            decide("Glob", &json!({"path": inside}), None, &gone),
            Some(Verdict::Deny(_))
        ));
        assert!(decide("Read", &w(outside.join("x")), None, &gone).is_none());
        // Ways around Remove: `..`, a relative path, and Glob's own pattern.
        let deny = |tool: &str, input: Value| {
            matches!(decide(tool, &input, None, &gone), Some(Verdict::Deny(_)))
        };
        assert!(deny(
            "Read",
            json!({"file_path": format!("{}/../run/inbox/a.eml", outside.display())})
        ));
        assert!(deny("Read", json!({"file_path": "inbox/a.eml"})));
        assert!(deny("Grep", json!({"pattern": "x", "path": "../run"})));
        assert!(deny(
            "Glob",
            json!({"pattern": format!("{}/**/*.eml", inside.display())})
        ));
        assert!(deny("Glob", json!({"pattern": "../run/**"})));
        // A start above the removed folder reaches into it too.
        let r = root.display();
        assert!(deny("Glob", json!({"pattern": format!("{r}/ru*/**")})));
        assert!(deny(
            "Glob",
            json!({"pattern": format!("{r}/*/inbox/a.eml")})
        ));
        assert!(deny("Glob", json!({"path": root, "pattern": "run/**"})));
        assert!(deny("Grep", json!({"pattern": "x", "path": root})));
        assert!(
            decide("Glob", &json!({"pattern": "**/*.eml"}), None, &gone).is_none(),
            "the seat's own folder"
        );
        assert!(
            decide(
                "Glob",
                &json!({"pattern": format!("{}/*", outside.display())}),
                None,
                &gone
            )
            .is_none()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    // The owner's rule: inside a granted folder one plain ls, cat, grep, head or wc runs unasked; anything compound,
    // any other program, and any path that resolves outside the folder or into its never list asks as before.
    #[test]
    fn plain_reads_inside_a_granted_folder_run_and_the_rest_asks() {
        let root = scratch("reads");
        let (inside, outside) = (root.join("run"), root.join("other"));
        std::fs::create_dir_all(inside.join("inbox")).unwrap();
        std::fs::create_dir_all(inside.join("sub/.git")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        for f in ["inbox/a.eml", "inbox/b.eml", "sub/.git/config", "CLAUDE.md"] {
            std::fs::write(inside.join(f), "Subject: x\n").unwrap();
        }
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), inside.join("inbox/link.eml"))
            .unwrap();
        let grants = Grants {
            granted: vec![inside.clone()],
            removed: vec![],
        };
        let (i, o) = (inside.display().to_string(), outside.display().to_string());
        let run = |line: &str, cwd: &Path, g: &Grants| {
            matches!(
                decide("Bash", &json!({"command": line}), Some(cwd), g),
                Some(Verdict::Allow(_))
            )
        };
        for line in [
            format!("ls -la {i}/inbox"),
            format!("cat {i}/inbox/a.eml"),
            format!("grep -l Subject {i}/inbox/a.eml {i}/inbox/b.eml"),
            format!("grep -il 'invoice due' {i}/inbox/a.eml"),
            format!("grep -m3 -iE '^(From|Subject):' {i}/inbox/a.eml"),
            format!("grep -rl Subject {i}/inbox"),
            format!("head -n 20 {i}/inbox/a.eml"),
            format!("wc -l {i}/inbox/a.eml"),
            format!("grep -l Subject {i}/inbox/?.eml"),
            "ls".to_string(),
            "grep -l Subject a.eml b.eml".to_string(),
        ] {
            let cwd = if line.contains('/') {
                &root
            } else {
                &inside.join("inbox")
            };
            assert!(run(&line, cwd, &grants), "{line}");
        }
        for line in [
            format!("ls {i}/inbox | head"),
            format!("ls {i}/inbox; rm -rf {i}"),
            format!("ls {i}/inbox && cat {i}/inbox/a.eml"),
            format!("ls {i}/inbox || true"),
            format!("cat $(ls {i}/inbox)"),
            format!("cat `ls {i}/inbox`"),
            format!("cat {i}/inbox/a.eml > {i}/x"),
            format!("cat < {i}/inbox/a.eml"),
            format!("X=1 cat {i}/inbox/a.eml"),
            format!("(cat {i}/inbox/a.eml)"),
            format!("for f in {i}/inbox/*.eml; do cat $f; done"),
            format!("cat {o}/secret.txt"),
            format!("cat {i}/inbox/link.eml"),
            format!("grep -l x {i}/inbox/*"),
            format!("cat {i}/../other/secret.txt"),
            format!("cat {i}/sub/.git/config"),
            format!("cat {i}/claude.md"),
            "cat ~/.ssh/id_ed25519".to_string(),
            format!("grep -f {o}/secret.txt {i}/inbox/a.eml"),
            format!("grep --file={o}/secret.txt {i}/inbox/a.eml"),
            format!("grep -r Subject {o}"),
            format!("grep {o}/secret.txt -e x {i}/inbox/a.eml"),
            format!("grep --fil={o}/secret.txt {i}/inbox/a.eml"),
            format!("grep -R Subject {i}/inbox"),
            format!("ls -L {i}/inbox"),
            format!("find {i}/inbox"),
            format!("sed -n 1p {i}/inbox/a.eml"),
            format!("tail -f {i}/inbox/a.eml"),
            format!("rm {i}/inbox/a.eml"),
            format!("/bin/cat {i}/inbox/a.eml"),
        ] {
            assert!(!run(&line, &root, &grants), "{line}");
        }
        // One leading `cd <dir> && ` into the folder, then one read whose relative paths start there.
        for line in [
            format!("cd {i}/inbox && cat a.eml b.eml"),
            format!("cd {i}/inbox && grep -l Subject *.eml"),
            format!("cd {i} && ls -la inbox"),
            "cd inbox && wc -l a.eml".to_string(),
        ] {
            assert!(run(&line, &inside, &grants), "{line}");
        }
        for line in [
            format!("cd {i}/inbox && cat a.eml && cat b.eml"),
            format!("cd {i}/inbox; cat a.eml"),
            format!("cd {i}/inbox"),
            "cd - && cat a.eml".to_string(),
            "cd $HOME && cat a.eml".to_string(),
            "cd ~/x && cat a.eml".to_string(),
            format!("cd {o} && cat secret.txt"),
            format!("cd {o} && cat {i}/inbox/a.eml"),
            format!("cd {i}/sub/.git && cat config"),
            format!("cd {i}/inbox && cat ../../other/secret.txt"),
            format!("cd {i}/inbox && rm a.eml"),
            format!("cd {i}/inbox && cd {i} && cat inbox/a.eml"),
            format!("cd {i}/in* && cat a.eml"),
        ] {
            assert!(!run(&line, &root, &grants), "{line}");
        }
        assert!(
            !run(
                &format!("cd {i}/inbox && cat a.eml"),
                &root,
                &nested_for_cd(&inside)
            ),
            "cd into a removed folder"
        );
        // A relative path, or none, counts only with the working folder inside.
        assert!(!run("cat inbox/a.eml", &root, &grants), "cwd outside");
        assert!(
            !run("grep -r Subject", &outside, &grants),
            "no path: the cwd, outside"
        );
        assert!(!run("ls", &outside, &grants));
        // After Remove nothing here runs unasked.
        let gone = Grants {
            granted: vec![],
            removed: vec![inside.clone()],
        };
        assert!(!run(&format!("cat {i}/inbox/a.eml"), &root, &gone));
        assert!(!run("ls", &inside, &gone));
        // A folder removed inside one still given: nothing in it, and no recursive read over it.
        let nested = Grants {
            granted: vec![inside.clone()],
            removed: vec![inside.join("inbox")],
        };
        assert!(!run(&format!("cat {i}/inbox/a.eml"), &root, &nested));
        assert!(!run(&format!("grep -rl Subject {i}"), &root, &nested));
        assert!(!run(&format!("ls {i}/inbox"), &root, &nested));
        let write = |line: String| {
            matches!(
                decide("Bash", &json!({"command": line}), Some(&root), &nested),
                Some(Verdict::Allow(_))
            )
        };
        assert!(!write(format!("mkdir -p {i}/inbox/x")));
        assert!(write(format!("mkdir -p {i}/x")));
        let _ = std::fs::remove_dir_all(root);
    }

    // The two questions of `/add-dir`, as Claude Code 2.1.332 draws them (rows read from a real session).
    #[test]
    fn add_dir_questions_are_answered_for_exactly_the_folder() {
        let folder = Path::new("/Volumes/w/p35/run");
        let first = |cursor_on_yes: bool| {
            format!(
                "Adding a new directory: /Volumes/w/p35/run\nThis session hasn't worked here before.\n\n{} No, leave it out\n{} Yes, add it\nEnter to confirm",
                if cursor_on_yes { " " } else { "\u{276f}" },
                if cursor_on_yes { "\u{276f}" } else { " " }
            )
        };
        assert_eq!(step(&first(false), folder, false), Step::Keys(b"\x1b[B"));
        assert_eq!(
            step(&first(false), folder, true),
            Step::Wait,
            "the Down is on its way"
        );
        assert_eq!(step(&first(true), folder, true), Step::Keys(b"\r"));
        assert_eq!(
            step(&first(true), folder, false),
            Step::Wait,
            "not the core's Down"
        );
        assert_eq!(
            step(&first(false), Path::new("/Volumes/w/other"), false),
            Step::Wait
        );
        let second = "Add directory to workspace\n /Volumes/w/p35/run\n \u{276f} 1. Yes, for this session\n   2. Yes, and remember this directory\n   3. No";
        assert_eq!(step(second, folder, true), Step::Keys(b"\r"));
        // Another folder's question whose name only starts with this one's is not answered.
        let longer = second.replace("/p35/run\n", "/p35/run-other\n");
        assert_eq!(step(&longer, folder, true), Step::Wait);
        assert_eq!(
            step(
                "\u{23bf} Added /Volumes/w/p35/\nrun as a working directory for this session",
                folder,
                true
            ),
            Step::Added
        );
        assert_eq!(
            step(
                "Did not add /Volumes/w/p35/run as a working directory.",
                folder,
                true
            ),
            Step::Failed
        );
    }
}
