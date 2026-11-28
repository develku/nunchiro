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

/// The folders an owner's message names, as they would be granted: each path the owner typed (a word starting with `/`
/// or `~/`, outside `>` quote lines and ``` blocks: text the owner pasted from mail, the web or a tool) gives its nearest
/// existing folder, canonical, unless `refused`.
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
        for word in line.split_whitespace() {
            let word = word.trim_matches(|c: char| "\"'`()[]{}<>,;:!?".contains(c));
            let word = word.trim_end_matches('.');
            let path = match word.strip_prefix("~/") {
                Some(rest) => user_home.join(rest),
                None if word.starts_with('/') => PathBuf::from(word),
                None => continue,
            };
            if let Some(folder) = nearest_folder(&path)
                && !refused(&folder, user_home, core_home)
                && !out.contains(&folder)
            {
                out.push(folder);
            }
        }
    }
    out
}

/// The path itself when it is a folder, else its nearest existing parent folder; canonical (links resolved).
fn nearest_folder(path: &Path) -> Option<PathBuf> {
    if path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let mut at = path;
    loop {
        if at.is_dir() {
            return std::fs::canonicalize(at).ok();
        }
        at = at.parent()?;
    }
}

/// Never granted (canonical `folder`, so a link to one of these is refused too): anything but a folder below the
/// user's home, below a volume's top folder or in a temporary folder; the home itself, `~/Library` and every
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
        Some(!first.starts_with('.') && first != "Library")
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
    !allowed
        || home.starts_with(folder)
        || core.starts_with(folder)
        || folder.starts_with(&core)
        || loads
}

/// Where a file tool's path lands, canonical: the path itself when it exists, else its nearest existing parent with the
/// rest joined on. `None` for a relative path or one with `..`.
fn landing(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    if let Ok(real) = std::fs::canonicalize(path) {
        return Some(real);
    }
    let parent = path.parent()?;
    Some(landing(parent)?.join(path.file_name()?))
}

/// Inside a granted folder, and not in what Claude loads or git keeps (the lock's deny list stays in charge there).
fn writable(path: &Path, grants: &Grants) -> bool {
    landing(path).is_some_and(|p| {
        grants.granted.iter().any(|g| p.starts_with(g))
            && !p.components().any(|c| {
                [
                    ".claude",
                    ".git",
                    ".mcp.json",
                    "CLAUDE.md",
                    "CLAUDE.local.md",
                ]
                .iter()
                .any(|n| c.as_os_str() == *n)
            })
    })
}

/// `mv -n` of a source moves the entry itself (a link is not followed): its folder must be inside, and so the name.
fn movable(path: &Path, grants: &Grants) -> bool {
    std::fs::symlink_metadata(path).is_ok()
        && path
            .parent()
            .zip(path.file_name())
            .is_some_and(|(dir, name)| writable(&dir.join(name), grants) && writable(dir, grants))
}

/// One plain line of `mkdir -p <paths>` and `mv -n <sources> <target>` commands joined by ` && ` or line breaks, every
/// path full and inside a granted folder. Words are plain (letters, digits and `._/-+,:@%=`, one space between), so the
/// shell reads them as they are: no quote, glob, `~`, `$`, redirect or other separator.
fn file_line(command: &str, grants: &Grants) -> bool {
    command
        .split('\n')
        .flat_map(|l| l.split(" && "))
        .all(|part| {
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

/// Why the hook lets a call run, or refuses it; `None` leaves the call to the lock's own rules.
pub enum Verdict {
    Allow(&'static str),
    Deny(&'static str),
}

/// The hook's grant rules for one call: Write, Edit and the plain file line run unasked inside a granted folder; the
/// file tools are refused in a folder the owner removed (it stays one of Claude's working folders).
pub fn decide(tool: &str, input: &Value, grants: &Grants) -> Option<Verdict> {
    let path = |key: &str| input.get(key).and_then(Value::as_str).map(Path::new);
    let target = match tool {
        "Read" | "Write" | "Edit" => path("file_path"),
        "Glob" | "Grep" => path("path"),
        _ => None,
    };
    if let Some(target) = target
        && landing(target).is_some_and(|p| {
            grants.removed.iter().any(|r| p.starts_with(r))
                && !grants.granted.iter().any(|g| p.starts_with(g))
        })
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
                .is_some_and(|c| file_line(c, grants)) =>
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
        && flat.contains(&name)
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

    fn scratch(tag: &str) -> PathBuf {
        let dir = Path::new("/private/tmp")
            .join(format!("nunchiro-folders-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    // The owner's words: a grant comes only from a path the owner typed, as its nearest existing folder; a path in a
    // quote line or a fenced block (pasted mail, web or tool text) gives none.
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
        assert_eq!(
            named(&text, &home, &core),
            vec![run.join("inbox"), run.clone()]
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
        for d in [".ssh", "Library/Keychains", "docs/work", "loads"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(home.join("loads/CLAUDE.md"), "x").unwrap();
        std::os::unix::fs::symlink(home.join(".ssh"), home.join("docs/ssh-link")).unwrap();
        let no = |p: PathBuf| refused(&std::fs::canonicalize(&p).unwrap(), &home, &core);
        assert!(!no(home.join("docs/work")), "an ordinary folder");
        for p in [
            PathBuf::from("/"),
            PathBuf::from("/etc"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/Volumes"),
            home.clone(),
            home.join(".ssh"),
            home.join("Library/Keychains"),
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
            matches!(decide(tool, &input, g), Some(Verdict::Allow(_)))
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
        let i = inside.display();
        assert!(allow(
            "Bash",
            sh(format!(
                "mkdir -p {i}/labels/Billing {i}/labels/Meetings && mv -n {i}/inbox/a.eml {i}/labels/Billing/"
            )),
            &grants
        ));
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
                    decide(tool, &w(inside.join("inbox/a.eml")), &gone),
                    Some(Verdict::Deny(_))
                ),
                "{tool}"
            );
        }
        assert!(matches!(
            decide("Glob", &json!({"path": inside}), &gone),
            Some(Verdict::Deny(_))
        ));
        assert!(decide("Read", &w(outside.join("x")), &gone).is_none());
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
