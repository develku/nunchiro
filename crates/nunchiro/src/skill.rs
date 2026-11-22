//! V2.5-31 (needs 145): `nunchiro skill get <name> [--file <f>] [--full]` prints a guide compiled into this binary.
//! A file of the same name in `<home>/skills/<name>/` replaces the built-in one. That folder is the user's: this
//! command only reads it, and only the listed names, never through a link, and never more than `MAX_BYTES`.
use std::{fs, io::Read, path::Path};

const MAX_BYTES: u64 = 256 * 1024;
const ORCHESTRATION: [(&str, &str); 5] = [
    ("guide.md", include_str!("../guides/orchestration/guide.md")),
    (
        "brief-template.md",
        include_str!("../guides/orchestration/brief-template.md"),
    ),
    (
        "report-template.md",
        include_str!("../guides/orchestration/report-template.md"),
    ),
    (
        "review.md",
        include_str!("../guides/orchestration/review.md"),
    ),
    (
        "levels.md",
        include_str!("../guides/orchestration/levels.md"),
    ),
];

pub(crate) fn run(skills: &Path, args: &[String]) -> Result<(), String> {
    print!("{}", get(skills, args)?);
    Ok(())
}

fn get(skills: &Path, args: &[String]) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let usage = "usage: nunchiro skill get orchestration [--file NAME] [--full]";
    let (name, rest) = match args.as_slice() {
        ["get", name, rest @ ..] => (*name, rest),
        _ => return Err(usage.into()),
    };
    let files = match name {
        "orchestration" => &ORCHESTRATION,
        _ => return Err(format!("unknown skill: {name}")),
    };
    let dir = skills.join(name);
    match rest {
        [] => file(&dir, files, "guide.md"),
        ["--file", f] => file(&dir, files, f),
        ["--full"] => {
            let mut out = String::new();
            for (f, _) in files {
                out.push_str(&format!("<!-- file: {f} -->\n"));
                out.push_str(&file(&dir, files, f)?);
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Ok(out)
        }
        _ => Err(usage.into()),
    }
}

/// The user's copy of `name` when one is there, else the built-in; `name` must be one of the listed files.
fn file(dir: &Path, files: &[(&str, &str)], name: &str) -> Result<String, String> {
    let builtin = files
        .iter()
        .find(|(f, _)| *f == name)
        .map(|(_, body)| *body)
        .ok_or_else(|| format!("unknown file: {name}"))?;
    // The folders on the way must be real folders too, so a linked `skills/` or `skills/<name>/` cannot redirect reads.
    for folder in [dir.parent().unwrap_or(dir), dir] {
        match fs::symlink_metadata(folder) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(builtin.into()),
            _ => {
                return Err(format!(
                    "{}: not a folder (links are refused)",
                    folder.display()
                ));
            }
        }
    }
    let path = dir.join(name);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(builtin.into()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if !meta.file_type().is_file() {
        return Err(format!(
            "{}: not a regular file (links are refused)",
            path.display()
        ));
    }
    let mut text = String::new();
    fs::File::open(&path)
        .and_then(|f| f.take(MAX_BYTES + 1).read_to_string(&mut text))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if text.len() as u64 > MAX_BYTES {
        return Err(format!("{}: larger than 256 KiB", path.display()));
    }
    Ok(text)
}
