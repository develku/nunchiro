//! Ticket 1095 slice 1: a task's work package. What the owner asked (quoted lines, never edited), the lead's
//! background, what the owner will see, the linked mockup and documents, and each brief a seat received.
//!
//! One file per task, `<home>/packages/<task id>.json` (0600, in a 0700 folder), never in the worktree and never in
//! `ledger.json`: that file drops its oldest closed tasks to stay under its cap, and a package outlives its task's
//! close. Nothing here reads a file: image paths are stored, never opened.
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One quote, the background, one "you will see" line or one link, in bytes. Refused when over, never cut: a cut quote
/// says less than the owner said.
pub const PART_MAX: usize = 4000;
/// Excerpt, background, see lines and links together, as stored (JSON bytes).
pub const PACKAGE_MAX: usize = 16 * 1024;
/// One brief, in bytes; the newest `BRIEFS_KEPT` are kept.
pub const BRIEF_MAX: usize = 64 * 1024;
pub const BRIEFS_KEPT: usize = 4;
const IMAGES_MAX: usize = 8;
const FILE_MAX: u64 = (PACKAGE_MAX + BRIEFS_KEPT * (BRIEF_MAX + 1024) + 4096) as u64;
const KINDS: [&str; 4] = ["mockup", "doc", "code", "url"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Package {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub excerpt: Vec<Quote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<Background>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub see: Vec<See>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<Link>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub briefs: Vec<Brief>,
}

/// One quoted line of the conversation. Added and removed whole; no verb changes its words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    /// Who said it ("the user", "Lead · Main"), and when, as the lead read it in the conversation.
    pub who: String,
    pub when: String,
    pub text: String,
    /// The owner's attached images, under `<home>/images` only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<PathBuf>,
    /// Who added the line (the lead's seat, or the user).
    pub by: String,
    pub at: u64,
}

/// The lead's own text: what came before, what is decided, what must not change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Background {
    pub text: String,
    pub by: String,
    pub at: u64,
}

/// One thing the owner will see when the work is done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct See {
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shown: bool,
    /// The owner's yes to the line; absent: not approved yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<Approved>,
    pub at: u64,
}

/// An approval, only ever the user's own (no session sets one): who and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approved {
    pub by: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// `mockup`, `doc`, `code` or `url`.
    pub kind: String,
    pub target: String,
    /// A mockup the owner approved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<Approved>,
    pub at: u64,
}

/// The instruction text a seat received with its first prompt from `task staff` (the lead's words, or the core's
/// review prompt), kept as sent. The package block and the notes head in front of it are not repeated here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    pub session: String,
    pub name: String,
    pub text: String,
    pub at: u64,
}

/// What a `task package` verb carries besides its text (`Request::Task.package`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Fill {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approved: bool,
}

/// The parts `task package <id> <part>` takes. There is no verb that edits a quote.
pub const PARTS: [&str; 8] = [
    "quote",
    "unquote",
    "background",
    "see",
    "shown",
    "approve",
    "link",
    "unlink",
];

impl Package {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
    /// What the seat reads: the parts besides the briefs.
    fn told(&self) -> bool {
        !(self.excerpt.is_empty()
            && self.background.is_none()
            && self.see.is_empty()
            && self.links.is_empty())
    }
}

/// A part's text exactly as given, but for a secret in it: the package is read by every seat of the task.
fn masked(text: &str) -> String {
    let mask = |s: &str| String::from_utf8_lossy(&crate::logs::mask(s.as_bytes())).into_owned();
    let flat = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let kept = mask(text);
    // As in the ledger's `note`: a secret on the line after its key is masked in the one-line copy only.
    let joined = mask(&flat(text));
    if flat(&kept) == joined { kept } else { joined }
}

/// A part's text, masked, never cut or trimmed: a quote keeps every character the owner typed.
fn part(text: &str, what: &str) -> Result<String, String> {
    let text = masked(text);
    if text.trim().is_empty() {
        return Err(format!("{what} is empty"));
    }
    if text.len() > PART_MAX {
        return Err(format!(
            "{what} is {} bytes, over the {PART_MAX}-byte limit; split it into lines",
            text.len()
        ));
    }
    Ok(text)
}

fn nth<T>(list: &[T], text: &str, what: &str) -> Result<usize, String> {
    let n: usize = text
        .trim()
        .parse()
        .map_err(|_| format!("name the {what} by its number in `nunchiro task show`"))?;
    (1..=list.len())
        .contains(&n)
        .then_some(n - 1)
        .ok_or_else(|| format!("there is no {what} {n}"))
}

/// The owner's attached images only: a path under `<home>/images` after links are followed.
fn image(home: &Path, path: &Path) -> Result<PathBuf, String> {
    let refused = || {
        format!(
            "{} is no attached image: an image is a file under {}",
            path.display(),
            home.join("images").display()
        )
    };
    let root = std::fs::canonicalize(home.join("images")).map_err(|_| refused())?;
    let path = std::fs::canonicalize(path).map_err(|_| refused())?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(refused());
    }
    Ok(path)
}

/// One verb of `task package` on `p`: `op` is one of `PARTS`, `by` the caller's name, `user` true when the caller
/// is the user (no session: the window or the user's own shell). What it did, in one line. Over a limit nothing changes.
#[allow(clippy::too_many_arguments)]
pub fn apply(
    p: &mut Package,
    home: &Path,
    op: &str,
    text: &str,
    fill: &Fill,
    by: &str,
    user: bool,
    now: u64,
) -> Result<String, String> {
    let by = &super::line(by, 200);
    // Security look round 2: an approval says the owner said yes. No agent may set one from its own words, the lead
    // included; the lead asks the user, who marks it.
    let approval = || {
        if user {
            Ok(Some(Approved {
                by: "the user".into(),
                at: now,
            }))
        } else {
            Err("only the user marks a line or a mockup as approved (in the window, or in their own shell: \
                 nunchiro task package <id> approve <n> --project <dir>); ask the user"
                .to_string())
        }
    };
    let one = |s: &Option<String>, what: &str| {
        let s = super::line(s.as_deref().unwrap_or_default(), 100);
        if s.is_empty() {
            Err(format!("a quote needs {what}"))
        } else {
            Ok(s)
        }
    };
    let mut next = p.clone();
    let done = match op {
        "quote" => {
            if fill.images.len() > IMAGES_MAX {
                return Err(format!("a quote takes at most {IMAGES_MAX} images"));
            }
            let images = fill
                .images
                .iter()
                .map(|i| image(home, i))
                .collect::<Result<Vec<_>, _>>()?;
            next.excerpt.push(Quote {
                who: one(&fill.who, "who said it (--who)")?,
                when: one(&fill.when, "when it was said (--when)")?,
                text: part(text, "the quote")?,
                images,
                by: by.into(),
                at: now,
            });
            format!("quote {} added", next.excerpt.len())
        }
        "unquote" => {
            let at = nth(&next.excerpt, text, "quote")?;
            next.excerpt.remove(at);
            format!("quote {} removed", at + 1)
        }
        "background" => {
            next.background = Some(Background {
                text: part(text, "the background")?,
                by: by.into(),
                at: now,
            });
            "background set".into()
        }
        "see" => {
            next.see.push(See {
                text: part(text, "the line")?,
                shown: false,
                approved: None,
                at: now,
            });
            format!("you-will-see line {} added", next.see.len())
        }
        "shown" => {
            let at = nth(&next.see, text, "you-will-see line")?;
            next.see[at].shown = true;
            format!("you-will-see line {} shown", at + 1)
        }
        "approve" => {
            let at = nth(&next.see, text, "you-will-see line")?;
            next.see[at].approved = approval()?;
            format!("you-will-see line {} approved by the user", at + 1)
        }
        "link" => {
            let kind = fill.kind.as_deref().unwrap_or_default();
            if !KINDS.contains(&kind) {
                return Err("a link's --kind is mockup, doc, code or url".into());
            }
            if fill.approved && kind != "mockup" {
                return Err("only a mockup is approved".into());
            }
            let approved = if fill.approved { approval()? } else { None };
            next.links.push(Link {
                kind: kind.into(),
                target: part(text.trim(), "the link")?.trim().into(),
                approved,
                at: now,
            });
            format!("link {} added", next.links.len())
        }
        "unlink" => {
            let at = nth(&next.links, text, "link")?;
            next.links.remove(at);
            format!("link {} removed", at + 1)
        }
        _ => {
            return Err(format!(
                "a package part is one of {}; a quote is never edited (remove it and add the right line)",
                PARTS.join(", ")
            ));
        }
    };
    let told = Package {
        briefs: vec![],
        ..next.clone()
    };
    let size = serde_json::to_vec(&told).map_err(|e| e.to_string())?.len();
    if size > PACKAGE_MAX {
        return Err(format!(
            "the package would be {size} bytes, over its {PACKAGE_MAX}-byte limit; nothing was changed"
        ));
    }
    *p = next;
    Ok(done)
}

/// Keeps the brief a seat was sent; the newest `BRIEFS_KEPT`.
pub fn keep_brief(
    p: &mut Package,
    session: &str,
    name: &str,
    text: &str,
    now: u64,
) -> Result<(), String> {
    if text.len() > BRIEF_MAX {
        return Err(too_long(text));
    }
    p.briefs.push(Brief {
        session: session.into(),
        name: super::line(name, 200),
        text: masked(text),
        at: now,
    });
    let over = p.briefs.len().saturating_sub(BRIEFS_KEPT);
    p.briefs.drain(..over);
    Ok(())
}

pub fn too_long(text: &str) -> String {
    format!(
        "the first prompt is {} bytes, over the {BRIEF_MAX}-byte limit of a brief; put the rest in a file in the worktree",
        text.len()
    )
}

/// The package as the seat's first prompt carries it, in full (outside the notes' cap). Empty when nothing but
/// briefs is in it, so the prompt reads as before.
pub fn block(p: &Package) -> String {
    if !p.told() {
        return String::new();
    }
    let indent = |text: &str, by: &str| {
        text.lines()
            .map(|l| format!("{by}{l}\n"))
            .collect::<String>()
    };
    let mut out = String::new();
    if !p.excerpt.is_empty() {
        out += "What was said, quoted exactly (the lead chose these lines; the user's words win over everything below):\n";
        for q in &p.excerpt {
            out += &format!("- {}, {}:\n", q.who, q.when);
            out += &indent(&q.text, "  > ");
            for i in &q.images {
                out += &format!("  image (a file to open if you need it): {}\n", i.display());
            }
        }
    }
    if let Some(b) = &p.background {
        out += &format!(
            "Background, the lead's words (not the user's), by {}:\n",
            b.by
        );
        out += &indent(&b.text, "  ");
    }
    if !p.see.is_empty() {
        out += "The user will see (check the result against each line):\n";
        for s in &p.see {
            let yes = if s.approved.is_some() {
                " (approved by the user)"
            } else {
                ""
            };
            out += &format!("- {}{yes}\n", s.text);
        }
    }
    if !p.links.is_empty() {
        out += "Links:\n";
        for l in &p.links {
            let yes = if l.approved.is_some() {
                ", approved by the user"
            } else {
                ""
            };
            out += &format!("- {}{yes}: {}\n", l.kind, l.target);
        }
    }
    out
}

/// `task show`'s lines of the package; empty for none, so a task without one prints as before.
pub fn lines(p: &Package, id: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    let rest = |text: &str| -> String {
        let mut parts = text.lines();
        let first = parts.next().unwrap_or_default().to_string();
        first + &parts.map(|l| format!("\n      {l}")).collect::<String>()
    };
    let mut out = String::from("  package:\n");
    for (n, q) in p.excerpt.iter().enumerate() {
        out += &format!(
            "    quote {}, {}, {}: \"{}\"\n",
            n + 1,
            q.who,
            q.when,
            rest(&q.text)
        );
        for i in &q.images {
            out += &format!("      image: {}\n", i.display());
        }
    }
    if let Some(b) = &p.background {
        out += &format!(
            "    background by {} (the lead's text): {}\n",
            b.by,
            rest(&b.text)
        );
    }
    for (n, s) in p.see.iter().enumerate() {
        let state = if s.shown { "shown" } else { "not shown yet" };
        let yes = match &s.approved {
            Some(a) => format!(", approved by {} at {}", a.by, a.at),
            None => String::new(),
        };
        out += &format!(
            "    you will see {} [{state}{yes}]: {}\n",
            n + 1,
            rest(&s.text)
        );
    }
    for (n, l) in p.links.iter().enumerate() {
        let yes = match &l.approved {
            Some(a) => format!(", approved by {} at {}", a.by, a.at),
            None => String::new(),
        };
        out += &format!("    link {} {}{yes}: {}\n", n + 1, l.kind, l.target);
    }
    for b in &p.briefs {
        let first: String = b
            .text
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
        out += &format!(
            "    brief to {} ({} bytes): {first} (the whole text: nunchiro task show {id} --json)\n",
            b.name,
            b.text.len()
        );
    }
    out
}

/// The package files of one core.
pub struct Packages {
    dir: PathBuf,
}

/// Read, change and write one package at a time (one core per home).
static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl Packages {
    pub fn open(home: &Path) -> Self {
        Self {
            dir: home.join("packages"),
        }
    }
    fn file(&self, id: &str) -> Result<PathBuf, String> {
        if !store::valid_id(id) {
            return Err(format!("{id} is no task id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }
    /// Task `id`'s package; an empty one when it has none.
    pub fn get(&self, id: &str) -> Result<Package, String> {
        let file = self.file(id)?;
        match store::open_regular(&file).and_then(|f| store::read_capped(f, FILE_MAX)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{id}.json: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Package::default()),
            Err(e) => Err(format!("{id}.json: {e}")),
        }
    }
    /// Reads, runs `f`, writes. An error leaves the file as it was.
    pub fn change<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Package) -> Result<T, String>,
    ) -> Result<(T, Package), String> {
        let _one = CHANGE
            .lock()
            .map_err(|_| "packages unavailable".to_string())?;
        let mut p = self.get(id)?;
        let out = f(&mut p)?;
        store::private_dir(&self.dir)?;
        let bytes = serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?;
        store::write_capped(&self.file(id)?, &bytes, FILE_MAX)?;
        Ok((out, p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let home =
            std::env::temp_dir().join(format!("nunchiro-package-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("images/s1")).unwrap();
        std::fs::write(home.join("images/s1/a.png"), b"IMAGE-BYTES").unwrap();
        std::fs::canonicalize(home).unwrap()
    }
    fn quote(who: &str) -> Fill {
        Fill {
            who: Some(who.into()),
            when: Some("2026-11-24 09:40".into()),
            ..Fill::default()
        }
    }

    #[test]
    fn no_verb_edits_a_quote() {
        let home = home("edit");
        let mut p = Package::default();
        apply(
            &mut p,
            &home,
            "quote",
            "keep my words",
            &quote("the user"),
            "Lead · Main",
            true,
            1,
        )
        .unwrap();
        let kept = p.excerpt[0].clone();
        let link = Fill {
            kind: Some("mockup".into()),
            approved: true,
            ..Fill::default()
        };
        // Every verb, each with a number that names the quote's place in its list, and words of its own.
        for (op, text, fill) in [
            ("quote", "other words", quote("the user")),
            ("background", "other words", Fill::default()),
            ("see", "other words", Fill::default()),
            ("shown", "1", Fill::default()),
            ("approve", "1", Fill::default()),
            ("link", "docs/design/x.html", link),
            ("unlink", "1", Fill::default()),
            ("unquote", "2", Fill::default()),
        ] {
            apply(&mut p, &home, op, text, &fill, "Lead · Main", true, 2).unwrap();
            assert_eq!(p.excerpt[0], kept, "{op} changed the quote");
        }
        for op in ["edit", "requote", "set", "replace"] {
            let e = apply(&mut p, &home, op, "1", &quote("x"), "Lead", true, 3).unwrap_err();
            assert!(e.contains("never edited"), "{e}");
        }
        assert_eq!(p.excerpt, vec![kept]);
    }

    #[test]
    fn a_quote_needs_who_and_when_and_images_from_the_owner_only() {
        let home = home("images");
        let mut p = Package::default();
        let no_when = Fill {
            who: Some("the user".into()),
            ..Fill::default()
        };
        assert!(
            apply(&mut p, &home, "quote", "x", &no_when, "L", true, 1)
                .unwrap_err()
                .contains("--when")
        );
        let outside = home.join("outside.png");
        std::fs::write(&outside, b"png").unwrap();
        let link = home.join("images/s1/link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        for path in [
            outside.clone(),
            link,
            home.join("images/s1/../../outside.png"),
            home.join("images"),
            PathBuf::from("/etc/hosts"),
        ] {
            let fill = Fill {
                images: vec![path.clone()],
                ..quote("the user")
            };
            let e = apply(&mut p, &home, "quote", "x", &fill, "L", true, 1).unwrap_err();
            assert!(e.contains("no attached image"), "{}: {e}", path.display());
        }
        let fill = Fill {
            images: vec![home.join("images/s1/a.png")],
            ..quote("the user")
        };
        apply(
            &mut p,
            &home,
            "quote",
            "see the picture",
            &fill,
            "L",
            true,
            1,
        )
        .unwrap();
        assert_eq!(p.excerpt[0].images, vec![home.join("images/s1/a.png")]);
        // Only the path reaches a prompt, never the file's bytes.
        assert!(block(&p).contains("images/s1/a.png") && !block(&p).contains("IMAGE-BYTES"));
    }

    #[test]
    fn limits_per_part_and_per_package_refuse_and_never_cut() {
        let home = home("limits");
        let mut p = Package::default();
        let big = "가".repeat(PART_MAX / 3 + 1); // 3 bytes a char
        let e = apply(
            &mut p,
            &home,
            "quote",
            &big,
            &quote("the user"),
            "L",
            true,
            1,
        )
        .unwrap_err();
        assert!(e.contains("over the 4000-byte limit"), "{e}");
        assert!(p.is_empty());
        let fits = "x".repeat(PART_MAX - 100);
        let mut added = 0;
        let e = loop {
            match apply(&mut p, &home, "see", &fits, &Fill::default(), "L", true, 1) {
                Ok(_) => added += 1,
                Err(e) => break e,
            }
        };
        assert!(e.contains("over its 16384-byte limit"), "{e}");
        assert_eq!(p.see.len(), added);
        assert!(serde_json::to_vec(&p).unwrap().len() <= PACKAGE_MAX);
        // A brief: refused over its own limit, the newest four kept, outside the package's 16 KB.
        assert!(keep_brief(&mut p, "s", "B", &"x".repeat(BRIEF_MAX + 1), 1).is_err());
        for n in 0..6 {
            keep_brief(
                &mut p,
                "s",
                "B",
                &format!("{n}{}", "x".repeat(BRIEF_MAX - 10)),
                n,
            )
            .unwrap();
        }
        let firsts: Vec<_> = p.briefs.iter().map(|b| &b.text[..1]).collect();
        assert_eq!(firsts, ["2", "3", "4", "5"]);
    }

    #[test]
    fn a_quote_keeps_every_character_but_a_secret() {
        let home = home("mask");
        let mut p = Package::default();
        let words = "  두 칸 띄우고 \n\tthen a tab, and a trailing space ";
        apply(
            &mut p,
            &home,
            "quote",
            words,
            &quote("the user"),
            "L",
            true,
            1,
        )
        .unwrap();
        assert_eq!(p.excerpt[0].text, words);
        apply(
            &mut p,
            &home,
            "quote",
            "use password: hunter2hunter2",
            &quote("the user"),
            "L",
            true,
            1,
        )
        .unwrap();
        assert!(
            !p.excerpt[1].text.contains("hunter2"),
            "{}",
            p.excerpt[1].text
        );
    }

    /// Security look round 2, MUST 1: no session marks the owner's approval, the lead included; the user does, and the
    /// mark says who and when.
    #[test]
    fn only_the_user_approves_a_line_or_a_mockup() {
        let home = home("approve");
        let mut p = Package::default();
        apply(
            &mut p,
            &home,
            "see",
            "The card says Shown 0 of 1",
            &Fill::default(),
            "Main",
            false,
            1,
        )
        .unwrap();
        let mockup = Fill {
            kind: Some("mockup".into()),
            approved: true,
            ..Fill::default()
        };
        let before = p.clone();
        for (op, text, fill) in [
            ("approve", "1", Fill::default()),
            ("link", "docs/a.html", mockup.clone()),
        ] {
            let e = apply(&mut p, &home, op, text, &fill, "Main", false, 2).unwrap_err();
            assert!(e.contains("only the user marks"), "{op}: {e}");
            assert_eq!(p, before, "{op} changed nothing");
        }
        // A lead may still add the mockup, unapproved.
        let plain = Fill {
            approved: false,
            ..mockup.clone()
        };
        apply(
            &mut p,
            &home,
            "link",
            "docs/a.html",
            &plain,
            "Main",
            false,
            2,
        )
        .unwrap();
        assert_eq!(p.links[0].approved, None);
        apply(
            &mut p,
            &home,
            "approve",
            "1",
            &Fill::default(),
            "user",
            true,
            3,
        )
        .unwrap();
        apply(
            &mut p,
            &home,
            "link",
            "docs/b.html",
            &mockup,
            "user",
            true,
            4,
        )
        .unwrap();
        let yes = |at| {
            Some(Approved {
                by: "the user".into(),
                at,
            })
        };
        assert_eq!(
            (p.see[0].approved.clone(), p.links[1].approved.clone()),
            (yes(3), yes(4))
        );
        assert!(
            lines(&p, "t1").contains("you will see 1 [not shown yet, approved by the user at 3]")
        );
    }

    /// Security look round 2, MUST 2: a secret on the line after its key is masked in every text a package keeps.
    #[test]
    fn every_stored_text_is_masked_across_a_line_break() {
        let home = home("mask-all");
        let secret = "password:\nhunter2hunter2";
        let mut p = Package::default();
        let who = Fill {
            who: Some(secret.into()),
            when: Some(secret.into()),
            ..Fill::default()
        };
        apply(&mut p, &home, "quote", secret, &who, secret, false, 1).unwrap();
        apply(
            &mut p,
            &home,
            "background",
            secret,
            &Fill::default(),
            secret,
            false,
            1,
        )
        .unwrap();
        apply(
            &mut p,
            &home,
            "see",
            secret,
            &Fill::default(),
            secret,
            false,
            1,
        )
        .unwrap();
        let link = Fill {
            kind: Some("doc".into()),
            ..Fill::default()
        };
        apply(&mut p, &home, "link", secret, &link, secret, false, 1).unwrap();
        keep_brief(&mut p, "s1", secret, &format!("Read BRIEF.md\n{secret}"), 1).unwrap();
        let stored = serde_json::to_string(&p).unwrap();
        assert!(!stored.contains("hunter2"), "{stored}");
        assert!(
            p.briefs[0].text.starts_with("Read BRIEF.md"),
            "{}",
            p.briefs[0].text
        );
    }

    #[test]
    fn a_mockup_link_is_approved_and_only_a_mockup() {
        let home = home("links");
        let mut p = Package::default();
        let fill = |kind: &str, approved| Fill {
            kind: Some(kind.into()),
            approved,
            ..Fill::default()
        };
        assert!(
            apply(
                &mut p,
                &home,
                "link",
                "x",
                &fill("picture", false),
                "L",
                true,
                1
            )
            .is_err()
        );
        assert!(apply(&mut p, &home, "link", "x", &fill("doc", true), "L", true, 1).is_err());
        apply(
            &mut p,
            &home,
            "link",
            "docs/design/a.html",
            &fill("mockup", true),
            "L",
            true,
            1,
        )
        .unwrap();
        apply(
            &mut p,
            &home,
            "link",
            "https://example.invalid/x",
            &fill("url", false),
            "L",
            true,
            1,
        )
        .unwrap();
        assert_eq!(
            block(&p),
            "Links:\n- mockup, approved by the user: docs/design/a.html\n- url: https://example.invalid/x\n"
        );
    }

    #[test]
    fn the_block_carries_every_word_and_none_when_only_briefs() {
        let home = home("block");
        let mut p = Package::default();
        keep_brief(&mut p, "s", "Builder · x", "Read BRIEF.md", 1).unwrap();
        assert_eq!(
            block(&p),
            "",
            "a package of briefs only adds nothing to a prompt"
        );
        let long = format!("{}\nsecond line", "말".repeat(1300));
        apply(
            &mut p,
            &home,
            "quote",
            &long,
            &quote("the user"),
            "Lead · Main",
            true,
            1,
        )
        .unwrap();
        apply(
            &mut p,
            &home,
            "background",
            &"b".repeat(3900),
            &Fill::default(),
            "Lead · Main",
            true,
            1,
        )
        .unwrap();
        let b = block(&p);
        assert!(
            b.contains(&format!("  > {}\n  > second line\n", "말".repeat(1300))),
            "{b}"
        );
        assert!(b.contains(&"b".repeat(3900)));
        assert!(b.contains("the lead's words (not the user's), by Lead · Main"));
    }

    #[test]
    fn thirty_closed_tasks_keep_full_packages_in_their_own_files() {
        let home = home("thirty");
        let ledger = super::super::Ledger::open(&home);
        let packages = Packages::open(&home);
        for n in 0..30 {
            let (t, _) = ledger
                .make(&home, None, &format!("task {n}"), &[], false, 1)
                .unwrap();
            packages
                .change(&t.id, |p| {
                    let mut text = format!("{n} ");
                    while apply(
                        p,
                        &home,
                        "see",
                        &format!("{text}{}", "y".repeat(3800)),
                        &Fill::default(),
                        "L",
                        true,
                        1,
                    )
                    .is_ok()
                    {
                        text += "z";
                    }
                    for b in 0..BRIEFS_KEPT {
                        keep_brief(
                            p,
                            "s",
                            "B",
                            &format!("{b}{}", "x".repeat(BRIEF_MAX - 10)),
                            1,
                        )?;
                    }
                    Ok(())
                })
                .unwrap();
            ledger.close(&t.id, "merged", 2).unwrap();
        }
        let stored = std::fs::read(home.join("ledger.json")).unwrap();
        assert!(stored.len() < 64 * 1024, "the ledger holds no package");
        for t in ledger.list().unwrap() {
            let p = packages.get(&t.id).unwrap();
            assert!(
                p.see.len() >= 3 && p.briefs.len() == BRIEFS_KEPT,
                "{}",
                t.id
            );
        }
        assert_eq!(ledger.list().unwrap().len(), 30);
        let mode = |p: &Path| {
            std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(p).unwrap().permissions())
                & 0o777
        };
        assert_eq!(mode(&home.join("packages")), 0o700);
        assert_eq!(mode(&home.join("packages/t1.json")), 0o600);
        assert!(packages.get("../ledger").is_err());
    }
}
