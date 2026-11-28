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
    // A YAML reader breaks lines at \r and U+0085 too, and Claude retries a frontmatter with its tabs made spaces:
    // either could show the review one key and Claude another. Only \n is a line break here.
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!(
            "skill {name}: SKILL.md has a tab or control character; only plain lines and spaces"
        ));
    }
    if text.chars().any(crate::board::rights::hidden) {
        return Err(format!(
            "skill {name}: SKILL.md has a hidden or bidi character the review would not show"
        ));
    }
    // Claude runs an inline !`cmd` and a fenced ```! block; its own escape treats `! as one too.
    if text.contains("!`") || text.contains("`!") {
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
                let v = value.trim();
                let unquoted = [('"', '"'), ('\'', '\'')]
                    .iter()
                    .find_map(|(a, b)| v.strip_prefix(*a)?.strip_suffix(*b))
                    .unwrap_or(v);
                if unquoted != name {
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

/// The approved SKILL.md files in `plugin-skills/<id>-<hash>/`, with the core's own plugin.json, rebuilt from the
/// approved bytes at every start: nothing planted or edited there, nor a link in its place, reaches Claude.
/// shortcut: a start that reads the folder while another start swaps it in may miss the skills once; fine for a few KB
/// rebuilt per start, use one folder per start if that is ever seen.
fn copy(home: &Path, id: &str, p: &Plugin, proof: &approval::Proof) -> Result<PathBuf, String> {
    let file = |path: &str| {
        proof
            .files()
            .iter()
            .find(|f| f.path() == path)
            .map(|f| f.bytes())
    };
    check_skills(p, file)?;
    let own = home.join(OWN);
    if own.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
        return Err("the plugin-skills folder is a link or a file".into());
    }
    let root = own.join(format!("{id}-{}", proof.hash()));
    let fresh = own.join(format!(
        ".{id}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
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
    // Whatever is at the copy's name goes (a link itself, never what it points to), then the fresh copy takes it.
    let clear = |at: &Path| match at.symlink_metadata() {
        Ok(m) if m.is_dir() => fs::remove_dir_all(at),
        Ok(_) => fs::remove_file(at),
        Err(_) => Ok(()),
    };
    for _ in 0..3 {
        clear(&root).map_err(|e| e.to_string())?;
        if fs::rename(&fresh, &root).is_ok() {
            return Ok(root);
        }
    }
    let _ = fs::remove_dir_all(&fresh);
    Err("the skills copy could not be put in place".into())
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
