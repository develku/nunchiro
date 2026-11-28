//! Plugin skills (docs/plugins.md): a `[[skill]]` names `skills/<name>/`, whose SKILL.md reaches new Claude sessions.
//! At each start the core copies only those SKILL.md files, from the approved copy, into a folder it owns and passes
//! it as `--plugin-dir`; the plugin's own plugin.json, hooks, MCP file, scripts and bin/ never reach Claude. A SKILL.md
//! keeps to `name` and `description` in its frontmatter (Claude runs a `hooks` key's commands, and `allowed-tools`
//! lets commands through) and has no "!`" (Claude runs that command when the skill loads). Nothing is written under
//! ~/.claude. A locked Home seat gets none (`sessions/spawn.rs`).
use super::*;
use std::ffi::OsString;

/// The core's own folder of plugin skills, beside the plugins.
const OWN: &str = "plugin-skills";
const MAX_SKILL: usize = 64 * 1024;

/// A SKILL.md a plugin may ship as skill `name`.
pub(crate) fn check_skill(name: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_SKILL {
        return Err(format!("skill {name}: SKILL.md is over 64 KB"));
    }
    if text.chars().any(crate::board::rights::hidden) {
        return Err(format!(
            "skill {name}: SKILL.md has a hidden or bidi character the review would not show"
        ));
    }
    if text.contains("!`") {
        return Err(format!(
            "skill {name}: SKILL.md has a !`command`, which Claude runs when the skill loads; a plugin skill is text only"
        ));
    }
    let front = text
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map(|(front, _)| front)
        .ok_or_else(|| {
            format!("skill {name}: SKILL.md starts with a --- frontmatter of name and description")
        })?;
    let mut named = false;
    for line in front.lines() {
        // A line that starts with a space continues the key above (a folded description).
        if line.trim().is_empty() || line.starts_with([' ', '\t']) {
            continue;
        }
        let (key, value) = line.split_once(':').unwrap_or((line, ""));
        match key {
            "name" => {
                if value.trim().trim_matches(['"', '\'']) != name {
                    return Err(format!(
                        "skill {name}: its SKILL.md name is not the folder's name"
                    ));
                }
                named = true;
            }
            "description" => {}
            _ => {
                return Err(format!(
                    "skill {name}: SKILL.md frontmatter has {key:?}; only name and description, since keys such as hooks or allowed-tools run commands"
                ));
            }
        }
    }
    if !named {
        return Err(format!("skill {name}: SKILL.md frontmatter needs its name"));
    }
    Ok(())
}

/// Every `[[skill]]` of `p` has a SKILL.md in its folder that `check_skill` takes (`file` finds a file's bytes).
pub(crate) fn check_skills<'a>(
    p: &Plugin,
    file: impl Fn(&str) -> Option<&'a [u8]>,
) -> Result<(), String> {
    for s in &p.skill {
        let path = format!("skills/{}/SKILL.md", s.name);
        let bytes = file(&path).ok_or_else(|| format!("skill {}: no {path}", s.name))?;
        let text = std::str::from_utf8(bytes)
            .map_err(|_| format!("skill {}: SKILL.md is not UTF-8", s.name))?;
        check_skill(&s.name, text)?;
    }
    Ok(())
}

/// The `--plugin-dir` flags of the skills of every plugin that is on, not blocked and approved as it is now.
pub(crate) fn claude_skill_flags(home: &Path) -> Vec<OsString> {
    let store = load(home);
    let mut out = vec![];
    for id in ids(home)
        .into_iter()
        .filter(|id| store.on.contains(id) && blocked(home, id).is_none())
    {
        let Ok(proof) = approval::check(home, &format!("{PREFIX}{id}")) else {
            continue; // off, not approved or changed: runs nothing
        };
        let Some(p) = approved(&proof).filter(|p| !p.skill.is_empty()) else {
            continue;
        };
        match copy(home, &id, &p, &proof) {
            Ok(dir) => out.extend(["--plugin-dir".into(), dir.into_os_string()]),
            Err(e) => eprintln!("plugin {id}: its skills are left out: {e}"),
        }
    }
    out
}

/// The approved SKILL.md files in `plugin-skills/<id>-<hash>/`, with the core's own plugin.json. A folder per approved
/// copy is never rewritten, so a start that reads one while another start writes the next sees a whole folder.
/// shortcut: old copies stay (a few KB each); tidy them when a plugin is removed if the folder ever grows.
fn copy(home: &Path, id: &str, p: &Plugin, proof: &approval::Proof) -> Result<PathBuf, String> {
    let file = |path: &str| {
        proof
            .files()
            .iter()
            .find(|f| f.path() == path)
            .map(|f| f.bytes())
    };
    check_skills(p, file)?;
    let hash: String = proof
        .hash()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(16)
        .collect();
    let root = home.join(OWN).join(format!("{id}-{hash}"));
    if root.join(".claude-plugin/plugin.json").is_file() {
        return Ok(root);
    }
    let fresh = home
        .join(OWN)
        .join(format!(".{id}-{hash}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&fresh);
    let manifest = serde_json::json!({
        "name": format!("plugin-{id}"),
        "version": "1",
        "description": p.about,
    });
    let files = p
        .skill
        .iter()
        .map(|s| {
            let path = format!("skills/{}/SKILL.md", s.name);
            let bytes = file(&path).unwrap_or_default().to_vec();
            (path, bytes)
        })
        .chain([(
            ".claude-plugin/plugin.json".to_string(),
            manifest.to_string().into_bytes(),
        )]);
    for (path, bytes) in files {
        let at = fresh.join(&path);
        if let Some(d) = at.parent() {
            fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        crate::store::atomic_write(&at, &bytes)?;
    }
    match fs::rename(&fresh, &root) {
        Ok(()) => Ok(root),
        // Another start made the same copy first.
        Err(_) if root.join(".claude-plugin/plugin.json").is_file() => {
            let _ = fs::remove_dir_all(&fresh);
            Ok(root)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// A plugin `sk` with skill `review` (`md` its SKILL.md), its own script, hooks, MCP file and plugin.json beside it,
/// and on; `approve` approves it as it is.
#[cfg(test)]
pub(crate) fn test_plugin(home: &Path, md: &str, approve: bool) -> PathBuf {
    let dir = dir(home).join("sk");
    for d in ["skills/review", "hooks", ".claude-plugin"] {
        fs::create_dir_all(dir.join(d)).unwrap();
    }
    fs::write(
        dir.join(MANIFEST),
        "id = \"sk\"\nname = \"Skills\"\nversion = \"1.0.0\"\n\n[[skill]]\nname = \"review\"\n",
    )
    .unwrap();
    fs::write(dir.join("skills/review/SKILL.md"), md).unwrap();
    fs::write(dir.join("skills/review/run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    fs::write(dir.join("hooks/hooks.json"), "{}").unwrap();
    fs::write(dir.join(".mcp.json"), "{}").unwrap();
    fs::write(dir.join(".claude-plugin/plugin.json"), "{\"name\":\"sk\"}").unwrap();
    let mut store = load(home);
    store.on.insert("sk".into());
    save(home, &store).unwrap();
    if approve {
        let view = approval::status(home, "plugin:sk").unwrap();
        approval::grant(home, "plugin:sk", approval::Level::Read, &view.hash).unwrap();
    }
    dir
}
