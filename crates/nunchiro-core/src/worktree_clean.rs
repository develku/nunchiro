//! V2-8a: worktree facts and loss (read-only `git`), the window's one-field create, and the opt-in auto-clean of
//! merged worktrees. Every `git` and `gh` call is a fixed argv with no shell; branch and URL pieces are single args.
use crate::api::{BranchRef, WorktreeCleaned, WorktreeFacts, WorktreeLoss};
use crate::sessions::{Sessions, WorktreePlan};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

/// A merge must be seen this long, with the tree clean and idle the whole time, before the folder is removed.
pub const DELAY_MS: u64 = 10 * 60 * 1000;
const EVERY: Duration = Duration::from_secs(30);
const GIT: Duration = Duration::from_secs(10);
/// Lines kept of a loss list; both the shown list and the confirm are cut the same way.
const LIST_MAX: usize = 200;

fn read(dir: &Path, args: &[&str]) -> Result<String, String> {
    crate::process::git_read(dir, args, GIT).map(|o| String::from_utf8_lossy(&o).into_owned())
}
fn lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.is_empty())
        .take(LIST_MAX)
        .map(String::from)
        .collect()
}
/// The project checkout's HEAD commit: what a branch with no upstream is counted against.
fn base(project: &Path) -> Result<String, String> {
    let sha = read(project, &["rev-parse", "--verify", "HEAD"])?
        .trim()
        .to_string();
    if sha.is_empty() || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid base commit".into());
    }
    Ok(sha)
}
/// Ticket 374: commits already on origin are not counted as unpushed: a worktree made from a fresher origin/main owns
/// nothing that removing it would lose. Ticket 394: a PR's fetched head is not "elsewhere": its private ref goes as soon
/// as the branch is made, and a force-pushed PR no longer has those commits.
const ELSEWHERE: [&str; 1] = ["--remotes=origin"];
fn upstream(path: &Path) -> bool {
    read(path, &["rev-parse", "--verify", "--quiet", "@{upstream}"]).is_ok()
}

pub(crate) fn facts(path: &Path, project: &Path) -> Result<WorktreeFacts, String> {
    let uncommitted = read(path, &["status", "--porcelain"])?
        .lines()
        .filter(|l| !l.is_empty())
        .count();
    let upstream = upstream(path);
    let count = if upstream {
        read(path, &["rev-list", "--count", "@{upstream}..HEAD"])?
    } else {
        let base = base(project)?;
        read(
            path,
            &[
                &["rev-list", "--count", "HEAD", "--not", &base],
                &ELSEWHERE[..],
            ]
            .concat(),
        )?
    };
    Ok(WorktreeFacts {
        uncommitted: uncommitted as u32,
        unpushed: count.trim().parse().map_err(|_| "invalid commit count")?,
        upstream,
    })
}

/// V2-8h: a git-ignored file is excused as rebuilt output only when a folder on its path is a known generator's (at
/// any depth, some only beside their project file) or its name is known junk, its name is not secret-shaped, and no
/// folder on its path is `.scratch` (evidence). Every other ignored path (unknown folder, unreadable entry, symlink
/// outside a generator folder, a name git had to quote) counts as unsaved work. Unsure is unsaved.
fn generator(root: &Path, dir: &str, name: &str) -> bool {
    let beside = |files: &[&str]| files.iter().any(|f| root.join(dir).join(f).is_file());
    match name {
        "node_modules" | "dist" | ".next" | "__pycache__" | ".cache" | "coverage"
        | ".pytest_cache" | ".mypy_cache" | ".ruff_cache" | ".turbo" => true,
        "target" => beside(&["Cargo.toml"]),
        "build" => beside(&[
            "package.json",
            "CMakeLists.txt",
            "Cargo.toml",
            "pyproject.toml",
            "build.gradle",
        ]),
        ".venv" | "venv" => beside(&[
            "pyproject.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
        ]),
        _ => false,
    }
}
/// Some folder among `folders` (the path's parts, from the root) is a generator's, and none is `.scratch`.
fn under_generator(root: &Path, folders: &[&str]) -> bool {
    !folders.contains(&".scratch")
        && (0..folders.len()).any(|i| generator(root, &folders[..i].join("/"), folders[i]))
}
/// Rebuilt wherever it sits.
fn junk(name: &str) -> bool {
    name == ".DS_Store" || name.to_ascii_lowercase().ends_with(".pyc")
}
/// Names that can hold secrets, keys or data: listed wherever they sit. ASCII case is folded (`K.PEM` is `k.pem`).
fn secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [".envrc", ".npmrc", ".netrc", ".pypirc"].contains(&n.as_str())
        || n.starts_with(".env.")
        || [
            ".env",
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".crt",
            ".cer",
            ".der",
            ".jks",
            ".p8",
            ".ppk",
            ".gpg",
            ".asc",
            ".keystore",
            ".db",
        ]
        .iter()
        .any(|e| n.ends_with(e))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials"]
            .iter()
            .any(|p| n.starts_with(p))
        || (n.starts_with("id_") && !n.ends_with(".pub"))
        || n.contains(".sqlite")
}
/// The path's plain parts, `None` for anything git should never print (`..`, `.`, empty, absolute, quoted).
fn parts(rel: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = rel.split('/').collect();
    (!rel.starts_with('"')
        && parts
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != ".."))
    .then_some(parts)
}
/// A file (or a symlink, never followed) at `rel`, relative to the worktree root.
fn regenerable(root: &Path, rel: &str) -> bool {
    match parts(rel).as_deref() {
        Some([folders @ .., name]) => {
            !secret(name)
                && !folders.contains(&".scratch")
                && (junk(name) || under_generator(root, folders))
        }
        _ => false,
    }
}
/// Control and shared hidden characters (`board::rights::hidden`) as `\u{..}`: a name or subject cannot hide or reorder
/// what the loss list shows.
fn shown(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || crate::board::rights::hidden(c) {
                c.escape_unicode().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}
/// Entries looked at inside ignored generator folders, per loss; past it the folder is listed whole.
const WALK_MAX: usize = 200_000;
/// The listed files under the ignored folder `rel`, which a generator owns: each secret-shaped file (or symlink) by
/// its path, an unreadable folder or a name that is not UTF-8 by the folder's path with `/`. `Err` when the walk
/// budget runs out.
fn walk(root: &Path, rel: &str, budget: &mut usize, out: &mut Vec<String>) -> Result<(), ()> {
    let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
        out.push([rel, "/"].concat());
        return Ok(());
    };
    for entry in entries {
        *budget = budget.checked_sub(1).ok_or(())?;
        let Ok(entry) = entry else {
            out.push([rel, "/"].concat());
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            out.push([rel, "/"].concat());
            continue;
        };
        let path = [rel, "/", &name].concat();
        match entry.file_type() {
            Ok(t) if t.is_dir() && name == ".scratch" => out.push([&path, "/"].concat()),
            Ok(t) if t.is_dir() => walk(root, &path, budget, out)?,
            Ok(_) if !secret(&name) => {}
            _ => out.push(path),
        }
    }
    Ok(())
}
/// What one `git status --ignored` entry adds to the loss list.
fn ignored_listed(root: &Path, entry: &str, budget: &mut usize, out: &mut Vec<String>) {
    let rel = entry.trim_end_matches('/');
    let Some(parts) = parts(rel) else {
        out.push(entry.to_string());
        return;
    };
    if !entry.ends_with('/') {
        if !regenerable(root, rel) {
            out.push(entry.to_string());
        }
        return;
    }
    // A folder: walked only when a generator owns it and it is a real folder (a symlink is never followed).
    let real_dir = std::fs::symlink_metadata(root.join(rel)).is_ok_and(|m| m.is_dir());
    if !(real_dir && under_generator(root, &parts)) {
        out.push(entry.to_string());
        return;
    }
    let before = out.len();
    if walk(root, rel, budget, out).is_err() {
        out.truncate(before);
        out.push(entry.to_string());
    }
}

/// What removing the folder loses: uncommitted files, and the commits not pushed (on the kept branch only when HEAD
/// is on it).
pub(crate) fn loss(path: &Path, project: &Path) -> Result<WorktreeLoss, String> {
    let all = crate::process::git_read_cut(path, &["status", "--porcelain", "--ignored"], GIT)?;
    // Coordinator 11-11 (v37-git-env R2): a status past the cap is never listed cut; the confirm says it is too large,
    // counts the whole entries seen (the last may be cut), and lists nothing.
    let too_large = all.len() >= crate::process::OUTPUT_CAP;
    let all = String::from_utf8_lossy(&all);
    if too_large {
        let seen = all.lines().filter(|l| !l.is_empty()).count() - 1;
        let shown = loss_of_commits(path, project)?;
        return Ok(WorktreeLoss {
            uncommitted_total: seen.max(1) as u32,
            too_large,
            ..shown
        });
    }
    // Ticket 253: a shared link to the project's own file is listed as linked, never lost (the project keeps it).
    let root = std::fs::canonicalize(project).ok();
    let linked_entry = |e: &str| crate::worktree_shared::linked(path, root.as_deref(), e);
    let mut linked: Vec<String> = vec![];
    let mut status: Vec<String> = vec![];
    for line in all
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with("!! "))
    {
        match line.strip_prefix("?? ").filter(|e| linked_entry(e)) {
            Some(e) => linked.push(e.to_string()),
            None => status.push(line.to_string()),
        }
    }
    let mut ignored: Vec<String> = vec![];
    let mut budget = WALK_MAX;
    for entry in all.lines().filter_map(|l| l.strip_prefix("!! ")) {
        if linked_entry(entry) {
            linked.push(entry.to_string());
        } else {
            ignored_listed(path, entry, &mut budget, &mut ignored);
        }
    }
    // A shared copy still untracked is an untracked file even when git ignores it: a copied secret is never excused.
    for copy in crate::worktree_shared::copies(path) {
        ignored.retain(|e| *e != copy);
        let line = ["?? ", &copy].concat();
        if !status.contains(&line) {
            status.push(line);
        }
    }
    Ok(WorktreeLoss {
        uncommitted: status.iter().take(LIST_MAX).map(|l| shown(l)).collect(),
        uncommitted_total: status.len() as u32,
        ignored: ignored
            .iter()
            .take(LIST_MAX)
            .map(|e| ["!! ", &shown(e)].concat())
            .collect(),
        ignored_total: ignored.len() as u32,
        linked: linked.iter().take(LIST_MAX).map(|e| shown(e)).collect(),
        ..loss_of_commits(path, project)?
    })
}
/// `loss`'s commit half: the commits not pushed and the branch HEAD is on.
fn loss_of_commits(path: &Path, project: &Path) -> Result<WorktreeLoss, String> {
    let range: Vec<String> = if upstream(path) {
        vec!["@{upstream}..HEAD".into()]
    } else {
        [
            vec!["HEAD".into(), "--not".into(), base(project)?],
            ELSEWHERE.map(String::from).to_vec(),
        ]
        .concat()
    };
    let mut log: Vec<&str> = vec!["log", "--max-count=200", "--format=%h %s"];
    log.extend(range.iter().map(String::as_str));
    let mut count: Vec<&str> = vec!["rev-list", "--count"];
    count.extend(range.iter().map(String::as_str));
    let kept_on = read(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    Ok(WorktreeLoss {
        unpushed: lines(&read(path, &log)?).iter().map(|l| shown(l)).collect(),
        unpushed_total: read(path, &count)?
            .trim()
            .parse()
            .map_err(|_| "invalid commit count")?,
        kept_on,
        ..Default::default()
    })
}

/// Lowercase ASCII words joined by `-`, at most 48 bytes; empty when nothing is left.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(48);
    out.trim_matches('-').to_string()
}
/// Ticket 991 (Q7 point 1): a branch name from a session's title, in the title's own script: Unicode letters and digits
/// (ASCII letters lowercased), every other run of characters one hyphen, none at either end, at most 40 characters.
/// Empty when the title has no letter or digit (emoji only). The caller still asks `git check-ref-format`.
// shortcut: no normalization table without a new dependency, so only Hangul jamo are composed (their rule is arithmetic) and a combining mark is left out (a decomposed "é" reads "e"), use NFC proper once a Unicode crate is in the tree.
pub(crate) fn title_slug(title: &str) -> String {
    let mut out = String::new();
    let mut chars = title.chars().peekable();
    let jamo = |c: Option<&char>, from: u32, to: u32| {
        c.map(|c| *c as u32)
            .filter(|c| (from..=to).contains(c))
            .map(|c| c - from)
    };
    while let Some(mut c) = chars.next() {
        // A leading consonant and a vowel, then an optional final: one syllable, as typed text already has it.
        if let (Some(l), Some(v)) = (
            jamo(Some(&c), 0x1100, 0x1112),
            jamo(chars.peek(), 0x1161, 0x1175),
        ) {
            chars.next();
            let t = jamo(chars.peek(), 0x11A8, 0x11C2).map_or(0, |t| t + 1);
            if t > 0 {
                chars.next();
            }
            c = char::from_u32(0xAC00 + (l * 21 + v) * 28 + t).unwrap_or(c);
        }
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if matches!(c as u32, 0x0300..=0x036F | 0x3099 | 0x309A) {
            // A combining mark belongs to the letter before it: not a break between words.
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(40).collect();
    cut.trim_matches('-').to_string()
}
/// Eighth look (A): the name for the text typed into "New worktree". ASCII text keeps `slug`; text with a letter or digit
/// of another script is named as a title is (`title_slug`): a Korean task gave "wt-xxxx" here while the same words as a
/// first message named the branch.
fn text_slug(text: &str) -> String {
    if text.chars().any(|c| !c.is_ascii() && c.is_alphanumeric()) {
        title_slug(text)
    } else {
        slug(text)
    }
}
/// A conservative branch name: what gh answers is outside text.
fn plain_branch(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 200
        && !b.starts_with(['-', '/', '.'])
        && !b.ends_with(['/', '.'])
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
        && b.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
}
/// `https://github.com/<owner>/<repo>/(pull|issue|issues)/<n>`, nothing more: (is a pull, n, `owner/repo` lowercased).
fn github(url: &str) -> Option<(bool, u64, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [owner, repo, kind, n] = parts[..] else {
        return None;
    };
    let name = |s: &str| {
        !s.is_empty()
            && !s.starts_with(['-', '.'])
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    if !name(owner)
        || !name(repo)
        || n.is_empty()
        || n.len() > 9
        || !n.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let pull = match kind {
        "pull" => true,
        "issue" | "issues" => false,
        _ => return None,
    };
    Some((
        pull,
        n.parse().ok()?,
        [owner, "/", repo].concat().to_ascii_lowercase(),
    ))
}
/// `owner/repo` (lowercased) of a GitHub remote URL in its https, ssh or scp form; `None` for any other host.
fn github_repo(url: &str) -> Option<String> {
    let rest = [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
        "git://github.com/",
    ]
    .iter()
    .find_map(|p| url.strip_prefix(p))
    .or_else(|| {
        // `https://user[:token]@github.com/…`. Ticket 394: the user part holds only RFC 3986 userinfo characters, so
        // a `?`, `#`, `/` or `@` (which would end the host early, as in `https://x?@github.com/`) never reads as GitHub.
        let (user, rest) = url.strip_prefix("https://")?.split_once("@github.com/")?;
        user.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~%!$&'()*+,;=:".contains(c))
            .then_some(rest)
    })?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty() && !repo.contains('/'))
        .then(|| [owner, "/", repo].concat().to_ascii_lowercase())
}
/// The project's remote whose URL is `repo` on GitHub, `origin` first. Never another repository's remote.
fn remote_for(project: &Path, repo: &str) -> Option<String> {
    let urls = read(project, &["config", "--get-regexp", r"^remote\..*\.url$"]).ok()?;
    let mut found: Vec<&str> = urls
        .lines()
        .filter_map(|l| {
            let (key, url) = l.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            (github_repo(url.trim()).as_deref() == Some(repo)).then_some(name)
        })
        .collect();
    found.sort_by_key(|n| *n != "origin");
    found.first().map(|n| n.to_string())
}

/// A pull fetch can wait on the network; a timeout ends git, so this stays well under the window's patience.
const FETCH: Duration = Duration::from_secs(30);
/// Ticket 374 (after Orca's pr-head-tracking-ref and T3 Code's GitManager, behaviour only): a fetch with no hooks, no
/// tags and no FETCH_HEAD (auto-pull merges FETCH_HEAD in the project root), into one explicit destination ref.
/// `extra` goes before the remote (the PR fetch adds `--no-recurse-submodules`).
/// Ticket 394: the error carries no URL user part (`user:token@`, `process::git_run`), so it can be logged.
fn fetch(project: &Path, remote: &str, spec: &str, extra: &[&str]) -> Result<(), String> {
    let head = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head"];
    let tail = ["--end-of-options", remote, spec];
    crate::process::git_read(
        project,
        &[&crate::auto_pull::NO_HOOKS[..], &head, extra, &tail].concat(),
        FETCH,
    )
    .map(drop)
}
fn commit(project: &Path, rev: &str) -> Option<String> {
    let at = [rev, "^{commit}"].concat();
    read(
        project,
        &["rev-parse", "--verify", "--quiet", "--end-of-options", &at],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}
/// Ticket 374: a new worktree's base when none is given: origin's default branch, fetched first. Offline it is the last
/// fetched one, and the branch name comes back for the toast. A project with no `origin/HEAD` keeps HEAD, as before.
// ponytail: an origin added by hand (no `origin/HEAD`) keeps HEAD; `git remote set-head origin --auto` fixes it.
pub(crate) fn default_base(project: &Path) -> (String, Option<String>) {
    let Ok(branch) = crate::auto_pull::origin_default(project) else {
        return ("HEAD".into(), None);
    };
    let tracking = ["refs/remotes/origin/", &branch].concat();
    let fresh = fetch(
        project,
        "origin",
        &["+refs/heads/", &branch, ":", &tracking].concat(),
        &[],
    )
    .is_ok();
    (tracking, (!fresh).then_some(branch))
}
/// What the New worktree dialog names as the default base (`origin/main`), read locally; `None` means HEAD.
pub(crate) fn default_name(project: &Path) -> Option<String> {
    crate::auto_pull::origin_default(project)
        .ok()
        .map(|b| ["origin/", &b].concat())
}
pub(crate) const PR_FOREIGN: &str = "this PR's repository is not a remote of this project";
pub(crate) const PR_FETCH: &str = "could not fetch the PR's code; no branch or folder was made";
/// Ticket 394: fixed text, so the window maps it to its language (web/src/api.ts `PR_REFUSALS`); the New worktree
/// dialog already named the branch.
pub(crate) const PR_STALE: &str =
    "this PR's branch already exists at an older commit; delete it to check out the new head";
/// Ticket 374: the branch and commit a pasted PR link makes; `Ok(None)` when `text` is not a PR link. The PR's head is
/// fetched from the remote that is the PR's own repository into a private ref (never FETCH_HEAD, never a branch), and any
/// failure refuses: no branch or folder is made. A local branch of the head's name at another commit (a fork's `main`)
/// is left alone and the branch is `pr-<n>`.
pub(crate) fn pull_request(project: &Path, text: &str) -> Result<Option<(String, String)>, String> {
    let text = text.trim();
    let Some((true, n, repo)) = github(text) else {
        return Ok(None);
    };
    let remote = remote_for(project, &repo).ok_or(PR_FOREIGN)?;
    // Ticket 403 item 13: a ref of this create's own, so a second create of the same PR never deletes or moves it.
    let private = format!("refs/nunchiro/pr/{n}-{}", crate::store::new_id()?);
    // Ticket 403 item 19: git's files backend follows a folder symlink there (into `refs/heads/<dir>`, say), so the
    // delete below would remove a branch.
    let common = read(
        project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let refs = Path::new(common.trim()).join("refs/nunchiro");
    if [refs.clone(), refs.join("pr")]
        .iter()
        .any(|d| d.symlink_metadata().is_ok_and(|m| !m.is_dir()))
    {
        return Err(PR_FETCH.into());
    }
    let spec = format!("+refs/pull/{n}/head:{private}");
    // Ticket 394: the private ref only carries the head to the branch made from it (the commit stays as an object).
    // `--no-deref`, and once before the fetch: a symbolic ref there (a hostile `.git`) is removed itself, so neither
    // the fetch nor the delete reaches the branch it names; a failed first delete refuses (a missing ref is no error).
    let delete = ["update-ref", "--no-deref", "-d", &private];
    let delete = || {
        read(
            project,
            &[&crate::auto_pull::NO_HOOKS[..], &delete].concat(),
        )
    };
    let fetched =
        delete().and_then(|_| fetch(project, &remote, &spec, &["--no-recurse-submodules"]));
    let sha = fetched
        .as_ref()
        .ok()
        .and_then(|_| commit(project, &private));
    let _ = delete();
    if let Err(e) = fetched {
        eprintln!("worktree pr fetch: {e}");
    }
    let sha = sha.ok_or(PR_FETCH)?;
    let own = format!("pr-{n}");
    let branch = match pr_head(text) {
        Some(head) => match commit(project, &["refs/heads/", &head].concat()) {
            Some(at) if at != sha => own,
            _ => head,
        },
        None => own,
    };
    Ok(Some((branch, sha)))
}
/// Ticket 394: a kept branch at another commit (this PR before it moved) is never checked out in its place. Ticket 403
/// items 14, 18: checked under the lock for every PR link's branch, and the refusal names it (`PR_STALE: <branch>`).
pub(crate) fn pr_stale(project: &Path, branch: &str, sha: &str) -> Result<(), String> {
    if commit(project, &["refs/heads/", branch].concat()).is_some_and(|at| at != sha) {
        return Err(format!("{PR_STALE}: {branch}"));
    }
    Ok(())
}
/// The PR's head branch through the user's gh; `None` when gh is missing, fails, is offline or answers oddly.
fn pr_head(url: &str) -> Option<String> {
    let mut gh = crate::process::command("gh");
    gh.args(["pr", "view", "--json", "headRefName", "--", url])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(std::process::Stdio::null());
    let out = crate::process::output(gh, GIT).ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let b = v["headRefName"].as_str()?;
    plain_branch(b).then(|| b.to_string())
}
/// Ticket 991 (Q7 point 1): `from_text` makes its own name (`wt-xxxx`) for this text: nothing typed, or nothing a
/// branch name can be made of.
pub(crate) fn generated(text: &str) -> bool {
    github(text.trim()).is_none() && text_slug(text).is_empty()
}
/// The window's one field: (branch, label). Empty is an auto name; a GitHub PR is its head branch (fallback
/// `pr-<n>`), an issue `issue-<n>`; anything else is text made into a slug. v25f: `prefix` (Settings › Git, "nunchiro/")
/// goes before a name Nunchiro makes; a PR keeps its head's own name, and the label never carries the prefix.
pub(crate) fn from_text(text: &str, prefix: &str) -> Result<(String, String), String> {
    let text = text.trim();
    let (pr, name) = match github(text) {
        // A create resolves a PR link through `pull_request` first; this name is only the fallback shape.
        Some((true, n, _)) => (true, format!("pr-{n}")),
        Some((false, n, _)) => (false, format!("issue-{n}")),
        None => (false, text_slug(text)),
    };
    let name = if name.is_empty() {
        ["wt-", &crate::store::new_id()?[..4]].concat()
    } else {
        name
    };
    let branch = if pr {
        name.clone()
    } else {
        // Ticket 378: "feature" and "feature/" both give feature/<name>, never feature//<name>.
        match prefix.trim_matches('/') {
            "" => name.clone(),
            p => format!("{p}/{name}"),
        }
    };
    Ok((branch, name))
}

/// V2.5-61 B8: refs the New worktree dialog lists at most.
const BRANCHES_MAX: usize = 500;
/// A listed name the dialog may show and send back as `branch`: never option-like, overlong (255 bytes, the brief's cap;
/// `create` still runs `check-ref-format`), or carrying a control or shared hidden character (a spoof). Looser than
/// `plain_branch`, which gates names the core makes or reads itself (a PR head from `gh`, the auto-clean's merge check). A dropped branch can still be typed by hand.
fn listable(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c.is_control() || crate::board::rights::hidden(c))
}
/// V2.5-61 B8: the project's local then remote branches (each sorted by name, at most 500), the count dropped as
/// unsafe to show, and whether more were there. Read only: fixed `git` reads of the top level, refs, remote names (round
/// 2: config only) and the worktree list, no index or work-tree read, no store or lock. `project` must be a git top level.
pub(crate) fn branches(project: &Path) -> Result<(Vec<BranchRef>, usize, bool), String> {
    let git = |args: &[&str]| crate::process::git_read(project, args, GIT);
    let top = git(&["rev-parse", "--show-toplevel"])?;
    let top = std::os::unix::ffi::OsStrExt::from_bytes(top.strip_suffix(b"\n").unwrap_or(&top));
    if std::fs::canonicalize::<&std::ffi::OsStr>(top)
        .ok()
        .as_deref()
        != Some(project)
    {
        return Err("not a git top level".into());
    }
    let count = format!("--count={}", BRANCHES_MAX + 1);
    let refs = git(&[
        "for-each-ref",
        "--format=%(refname)",
        &count,
        "refs/heads",
        "refs/remotes",
    ])?;
    // A remote's own name may hold a `/` (`team/up`): the longest known remote a ref starts with names it.
    let remotes = git(&["remote"])?;
    let mut remotes: Vec<&[u8]> = remotes
        .split(|b| *b == b'\n')
        .filter(|r| !r.is_empty())
        .collect();
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let worktrees = git(&["worktree", "list", "--porcelain", "-z"])?;
    let checked_out: std::collections::HashSet<&[u8]> = worktrees
        .split(|b| *b == 0)
        .filter_map(|field| field.strip_prefix(b"branch refs/heads/"))
        .collect();
    let lines: Vec<&[u8]> = refs
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .collect();
    let truncated = lines.len() > BRANCHES_MAX;
    let (mut listed, mut dropped) = (Vec::new(), 0);
    for line in lines.into_iter().take(BRANCHES_MAX) {
        let (name, remote) = match (
            line.strip_prefix(b"refs/heads/"),
            line.strip_prefix(b"refs/remotes/"),
        ) {
            (Some(name), _) => (name, false),
            (_, Some(name)) => (name, true),
            _ => continue,
        };
        // After the remote: its longest known name, else (a remote since removed) the first `/`.
        let branch = if remote {
            remotes
                .iter()
                .find_map(|r| name.strip_prefix(*r)?.strip_prefix(b"/"))
                .or_else(|| name.splitn(2, |b| *b == b'/').nth(1))
                .unwrap_or_default()
        } else {
            name
        };
        // A remote's HEAD names another remote ref, not a branch.
        if remote && branch == b"HEAD" {
            continue;
        }
        match (std::str::from_utf8(name), std::str::from_utf8(branch)) {
            (Ok(text), Ok(short)) if listable(text) && listable(short) => listed.push(BranchRef {
                name: text.into(),
                branch: short.into(),
                remote,
                in_worktree: !remote && checked_out.contains(name),
            }),
            _ => dropped += 1,
        }
    }
    Ok((listed, dropped, truncated))
}

/// Merged into the project's HEAD: the branch tip is reachable from it after the branch moved at least once (a
/// fresh branch is reachable too), or every change of the branch is already there (`git cherry` patch-id
/// equality, `squashed`, or a merge of the branch that would change nothing: squash and rebase). Unsure is not merged.
pub fn merged(project: &Path, branch: &str) -> bool {
    if branch.starts_with('-') || !plain_branch(branch) {
        return false;
    }
    let reference = ["refs/heads/", branch].concat();
    let Ok(tip) = read(
        project,
        &["rev-parse", "--verify", "--end-of-options", &reference],
    ) else {
        return false;
    };
    let tip = tip.trim();
    let Ok(base) = base(project) else {
        return false;
    };
    if tip.is_empty() || !tip.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let ahead = read(project, &["rev-list", "--count", tip, "--not", &base]);
    match ahead.as_deref().map(str::trim) {
        Ok("0") => read(
            project,
            &[
                "reflog",
                "show",
                "--format=%H",
                "--end-of-options",
                &reference,
            ],
        )
        .is_ok_and(|log| log.lines().count() >= 2),
        Ok(_) => {
            let cherry = read(project, &["cherry", &base, tip]).unwrap_or_default();
            (!cherry.trim().is_empty() && cherry.lines().all(|l| l.starts_with("- ")))
                || squashed(project, &base, tip)
                || read(project, &["merge-tree", "--write-tree", &base, tip]).is_ok_and(|tree| {
                    let base_tree = read(
                        project,
                        &[
                            "rev-parse",
                            "--verify",
                            "--end-of-options",
                            &[&base, "^{tree}"].concat(),
                        ],
                    );
                    base_tree.is_ok_and(|b| tree.lines().next() == Some(b.trim()))
                })
        }
        Err(_) => false,
    }
}

/// Ticket 403 item 14: every path the branch changed since it forked holds the branch's content (mode and object) in
/// `base`: a squash merge, read from trees alone, so a configured merge driver (refused by `merge-tree`) plays no part.
fn squashed(project: &Path, base: &str, tip: &str) -> bool {
    let hex = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit());
    let Ok(fork) = read(project, &["merge-base", base, tip]) else {
        return false;
    };
    let fork = fork.trim();
    if !hex(fork) {
        return false;
    }
    // `:<old mode> <new mode> <old object> <new object> <status>` then the path, each ended by NUL.
    let changes = |to: &str| {
        let raw = crate::process::git_read(
            project,
            &["diff-tree", "-r", "-z", "--no-renames", fork, to],
            GIT,
        )?;
        let mut parts = raw.split(|b| *b == 0).filter(|p| !p.is_empty());
        let mut out = BTreeMap::new();
        while let (Some(meta), Some(path)) = (parts.next(), parts.next()) {
            let meta: Vec<&[u8]> = meta.split(|b| *b == b' ').collect();
            let (Some(mode), Some(object)) = (meta.get(1), meta.get(3)) else {
                return Err(String::new());
            };
            out.insert(path.to_vec(), (mode.to_vec(), object.to_vec()));
        }
        Ok::<_, String>(out)
    };
    match (changes(tip), changes(base)) {
        (Ok(branch), Ok(there)) => branch
            .iter()
            .all(|(path, now)| there.get(path) == Some(now)),
        _ => false,
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub merged: bool,
    pub uncommitted: u32,
    pub running: bool,
}

/// When each merged, clean, idle worktree was first seen so (memory only: a restart restarts the delay).
#[derive(Default)]
pub struct Cleaner {
    seen: BTreeMap<PathBuf, u64>,
}
impl Cleaner {
    /// The folders due now. Off, or a condition failing once, forgets the time seen.
    pub fn due(&mut self, on: bool, now_ms: u64, all: &[Candidate]) -> Vec<PathBuf> {
        if !on {
            self.seen.clear();
            return vec![];
        }
        let ok: Vec<&Candidate> = all
            .iter()
            .filter(|c| c.merged && c.uncommitted == 0 && !c.running)
            .collect();
        self.seen.retain(|p, _| ok.iter().any(|c| &c.path == p));
        ok.into_iter()
            .filter(|c| {
                now_ms.saturating_sub(*self.seen.entry(c.path.clone()).or_insert(now_ms))
                    >= DELAY_MS
            })
            .map(|c| c.path.clone())
            .collect()
    }
}

/// One look: list, check, and remove what is due through the window's own remove (non-force, no confirm: any
/// unsaved work found at that moment refuses it). `reserve` blocks session starts in the folder until `release`.
#[allow(clippy::too_many_arguments)]
pub fn pass(
    home: &Path,
    root: &Path,
    on: bool,
    now_ms: u64,
    running: &[PathBuf],
    cleaner: &mut Cleaner,
    reserve: &mut dyn FnMut(&Path) -> Result<(), String>,
    release: &mut dyn FnMut(&Path),
    stop: &dyn Fn() -> bool,
) -> Vec<WorktreeCleaned> {
    if stop() {
        return vec![];
    }
    if !on {
        cleaner.due(false, now_ms, &[]);
        return vec![];
    }
    let Ok((list, _, _)) = WorktreePlan::owner(home, root, "list", None).run() else {
        return vec![];
    };
    let candidates: Vec<Candidate> = list
        .iter()
        .filter(|w| !w.missing)
        .map(|w| {
            let uncommitted = w.facts.as_ref().map_or(1, |f| f.uncommitted);
            let running = running.iter().any(|r| r.starts_with(&w.path));
            Candidate {
                path: w.path.clone(),
                merged: uncommitted == 0 && !running && !stop() && merged(&w.project, &w.branch),
                uncommitted,
                running,
            }
        })
        .collect();
    let mut done = vec![];
    for path in cleaner.due(true, now_ms, &candidates) {
        let Some(w) = list.iter().find(|w| w.path == path) else {
            continue;
        };
        // Stopping: nothing new starts; a removal already started runs to its end (the core waits for it).
        if stop() || reserve(&path).is_err() {
            continue;
        }
        // Merged means the branch's commits are in the base; they also stay on the kept branch. Only those are
        // excused (never an uncommitted file, never a detached HEAD), read again at the moment of removal below.
        let excuse = loss(&path, &w.project).ok().filter(|l| {
            l.uncommitted_total == 0
                && l.ignored_total == 0
                && l.kept_on.as_deref() == Some(w.branch.as_str())
        });
        let mut plan = WorktreePlan::owner(home, root, "remove", Some(path.clone()));
        plan.excuse(excuse);
        let removed = plan.run();
        release(&path);
        if let Ok((_, _, None)) = removed {
            done.push(WorktreeCleaned {
                id: 0,
                project: w.project.clone(),
                path: path.clone(),
                branch: w.branch.clone(),
                label: w.label.clone(),
                at_ms: now_ms,
            });
        }
    }
    done
}

/// The last removals, for the window's toasts (each has its own id; the window shows each once).
static RECENT: Mutex<(u64, VecDeque<WorktreeCleaned>)> = Mutex::new((0, VecDeque::new()));
pub(crate) fn recent() -> Vec<WorktreeCleaned> {
    RECENT
        .lock()
        .map(|r| r.1.iter().cloned().collect())
        .unwrap_or_default()
}
fn note(done: Vec<WorktreeCleaned>) {
    let Ok(mut r) = RECENT.lock() else {
        return;
    };
    for mut d in done {
        r.0 += 1;
        d.id = r.0;
        r.1.push_back(d);
        if r.1.len() > 20 {
            r.1.pop_front();
        }
    }
}

/// The core's one auto-clean task: a look every 30 s while the setting is on, nothing while off; ends with the core.
pub(crate) fn spawn(
    home: PathBuf,
    registry: Arc<Mutex<Sessions>>,
    stopping: Arc<AtomicBool>,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("worktree-clean".into())
        .spawn(move || {
            let mut cleaner = Cleaner::default();
            let mut next = Instant::now() + EVERY;
            while !stopping.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(250));
                if Instant::now() < next {
                    continue;
                }
                next = Instant::now() + EVERY;
                let Ok((on, root, running)) = registry.lock().map(|s| s.auto_clean_view()) else {
                    return;
                };
                let now = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64);
                let done = pass(
                    &home,
                    &root,
                    on,
                    now,
                    &running,
                    &mut cleaner,
                    &mut |p| {
                        if stopping.load(Ordering::SeqCst) {
                            return Err("core is stopping".into());
                        }
                        registry
                            .lock()
                            .map_err(|_| "session registry unavailable")?
                            .reserve_path(p)
                    },
                    &mut |p| {
                        if let Ok(mut s) = registry.lock() {
                            s.release_worktree(Some(p.to_path_buf()));
                        }
                    },
                    &|| stopping.load(Ordering::SeqCst),
                );
                note(done);
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{AgentKind, Request, StartSession};
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let mut c = Command::new("git");
        for k in crate::process::FIXTURE_SCRUB {
            c.env_remove(k);
        }
        let ok = c
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=F", "-c", "user.email=f@example.invalid"])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }
    fn home(name: &str) -> PathBuf {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::canonicalize(home).unwrap()
    }

    // Ticket 394 round 2: a merge driver the folder's config names (`merge=evil`) never runs from the merged check,
    // and the check then says not merged (the stand-in driver would keep ours and make the branch look merged).
    // Ticket 403 round 4: any configured merge driver refuses the merge-tree, as on main, including the three ways
    // past an override the security reviews found (`merge.text.driver`, the empty name, `merge.default`).
    #[test]
    fn merged_check_runs_no_merge_driver() {
        let cases: [&[(&str, &str)]; 4] = [
            &[("merge.evil.driver", "D")],
            &[("merge.text.driver", "D")],
            &[("merge..driver", "D")],
            &[("merge.evil.driver", "D"), ("merge.default", "evil")],
        ];
        for (i, config) in cases.into_iter().enumerate() {
            let dir = home(&format!("wtc-driver-{i}"));
            git(&dir, &["init", "-q", "-b", "main"]);
            std::fs::write(dir.join("a.txt"), "a\n").unwrap();
            std::fs::write(dir.join(".gitattributes"), "*.txt merge=evil\n").unwrap();
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-q", "-m", "init"]);
            git(&dir, &["checkout", "-q", "-b", "side"]);
            std::fs::write(dir.join("a.txt"), "side\n").unwrap();
            git(&dir, &["commit", "-q", "-am", "side"]);
            git(&dir, &["checkout", "-q", "main"]);
            std::fs::write(dir.join("a.txt"), "main\n").unwrap();
            git(&dir, &["commit", "-q", "-am", "main"]);
            let marker = dir.with_extension("ran");
            let driver = format!("sh -c 'echo ran >> {}' %A", marker.display());
            for (key, value) in config {
                let value = if *value == "D" {
                    driver.as_str()
                } else {
                    value
                };
                git(&dir, &["config", key, value]);
            }
            let tree = read(&dir, &["merge-tree", "--write-tree", "main", "side"]);
            let merged = merged(&dir, "side");
            let ran = marker.exists();
            let _ = std::fs::remove_file(&marker);
            std::fs::remove_dir_all(&dir).unwrap();
            assert!(!ran, "{config:?}: the merged check ran a merge driver");
            assert!(
                tree.is_err_and(|e| e.contains("configures a merge driver")),
                "{config:?}: merge-tree was not refused"
            );
            assert!(!merged, "{config:?}: reported merged");
        }
    }

    // Ticket 403 item 14: with a merge driver configured (`npm-merge-driver` and the like), a squash-merged branch
    // still reads as merged, without running the driver; one change left out of the squash reads as not merged.
    #[test]
    fn merged_check_sees_a_squash_despite_a_merge_driver() {
        let dir = home("wtc-squash-driver");
        git(&dir, &["init", "-q", "-b", "main"]);
        for f in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(dir.join(f), "x\n").unwrap();
        }
        std::fs::write(dir.join(".gitattributes"), "* merge=evil\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["checkout", "-q", "-b", "side"]);
        for f in ["a.txt", "b.txt"] {
            std::fs::write(dir.join(f), "side\n").unwrap();
            git(&dir, &["commit", "-q", "-am", f]);
        }
        git(&dir, &["checkout", "-q", "-b", "partial"]);
        std::fs::write(dir.join("c.txt"), "partial\n").unwrap();
        git(&dir, &["commit", "-q", "-am", "c"]);
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["merge", "-q", "--squash", "side"]);
        git(&dir, &["commit", "-q", "-m", "squash"]);
        let marker = dir.with_extension("ran");
        let driver = format!("sh -c 'echo ran >> {}' %A", marker.display());
        git(&dir, &["config", "merge.evil.driver", &driver]);
        let side = merged(&dir, "side");
        let partial = merged(&dir, "partial");
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!ran, "the merged check ran a merge driver");
        assert!(side, "the squash-merged branch read as not merged");
        assert!(!partial, "a branch with a change left out read as merged");
    }

    // Ticket 403: `git cherry` (patch ids) never starts a `diff.<driver>.textconv` program. Checked: git hashes the
    // raw blobs, so this held before the ticket too.
    #[test]
    fn merged_check_runs_no_textconv() {
        let dir = home("wtc-textconv");
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["checkout", "-q", "-b", "picked"]);
        std::fs::write(dir.join("a.txt"), "picked\n").unwrap();
        git(&dir, &["commit", "-q", "-am", "picked"]);
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["commit", "-q", "--allow-empty", "-m", "moved"]);
        git(&dir, &["cherry-pick", "picked"]);
        let marker = dir.with_extension("ran");
        let textconv = format!("sh -c 'echo ran >> {}; cat \"$0\"'", marker.display());
        git(&dir, &["config", "diff.evil.textconv", &textconv]);
        let picked = merged(&dir, "picked");
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!ran, "the merged check ran a textconv program");
        assert!(picked, "the cherry-picked branch read as not merged");
    }
    // Ticket 403 item 3: a create whose record cannot be written removes its folder again with a read's protection:
    // the status git runs first starts no fsmonitor.
    #[test]
    fn create_rollback_runs_no_fsmonitor() {
        use std::os::unix::fs::PermissionsExt;
        let home = home("wtc-rollback");
        // Ticket 1061: the default root is beside the repository, so a folder of its own keeps it writable below.
        let repo = home.join("src/repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let repo = std::fs::canonicalize(repo).unwrap();
        let marker = home.with_extension("ran");
        let monitor = home.with_extension("fsmonitor");
        let body = format!("#!/bin/sh\necho ran >> '{}'\nexit 1\n", marker.display());
        std::fs::write(&monitor, body).unwrap();
        std::fs::set_permissions(&monitor, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(
            &repo,
            &["config", "core.fsmonitor", monitor.to_str().unwrap()],
        );
        let registry = Mutex::new(
            Sessions::open(&home)
                .unwrap()
                .with_user_home(&home.join("src")),
        );
        let plan = |operation: &str| {
            registry
                .lock()
                .unwrap()
                .worktree_plan(
                    None,
                    Request::Worktree {
                        operation: operation.into(),
                        project: Some(repo.clone()),
                        path: None,
                        branch: Some("rolled".into()),
                        base: "HEAD".into(),
                        label: String::new(),
                        from: None,
                        confirm: None,
                    },
                )
                .unwrap()
        };
        plan("list").run().unwrap(); // makes the lock file and the root
        let mode = |m| std::fs::set_permissions(&home, std::fs::Permissions::from_mode(m)).unwrap();
        mode(0o500); // worktrees.json cannot be written; the root below still can
        let made = plan("create").run();
        mode(0o700);
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let mut listed = Command::new("git");
        for k in crate::process::FIXTURE_SCRUB {
            listed.env_remove(k);
        }
        let listed = listed
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap()
            .stdout;
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_file(&monitor);
        std::fs::remove_dir_all(&home).unwrap();
        assert!(made.is_err_and(|e| e.contains("worktree metadata failed")));
        assert_eq!(ran, "", "the rollback started the fsmonitor");
        let listed = String::from_utf8_lossy(&listed);
        assert_eq!(listed.matches("worktree ").count(), 1, "{listed}");
    }
    // Tickets 1061, 1083: with no setting, a user home that cannot be written fails with a line that names the
    // setting, and nothing goes into the Nunchiro folder instead.
    #[test]
    fn unwritable_user_home_names_the_setting() {
        use std::os::unix::fs::PermissionsExt;
        let home = home("wtc-noparent");
        let locked = home.join("locked");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&locked).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let repo = std::fs::canonicalize(repo).unwrap();
        let core = Sessions::open(&home).unwrap().with_user_home(&locked);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let made = core
            .worktree_plan(
                None,
                Request::Worktree {
                    operation: "create".into(),
                    project: Some(repo),
                    path: None,
                    branch: Some("b".into()),
                    base: "HEAD".into(),
                    label: String::new(),
                    from: None,
                    confirm: None,
                },
            )
            .and_then(|plan| plan.run());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        let fell_back = home.join("worktrees/repo").exists();
        std::fs::remove_dir_all(&home).unwrap();
        let e = made.err().unwrap_or_default();
        assert!(
            e.contains("Settings > Git & Worktrees") && e.contains("(worktrees_dir)"),
            "{e}"
        );
        assert_eq!(e.lines().count(), 1, "{e}");
        assert!(!fell_back);
    }
    // v25f (F7): Settings › Git's folder and prefix. A bad folder is refused with its reason and nothing is written; a
    // saved one is where the next create goes; the prefix goes on a one-field branch; an older record (default root)
    // still lists after the root moved.
    #[test]
    fn worktree_folder_and_prefix_from_settings() {
        use crate::api::{LifetimePatch, Reply};
        let home = home("wtc-root");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let mut core = Sessions::open(&home).unwrap().with_user_home(&home);
        let dir = |d: &str| LifetimePatch {
            worktrees_dir: Some(d.into()),
            ..Default::default()
        };
        let create = |core: &Sessions, from: &str| {
            core.worktree_plan(
                None,
                Request::Worktree {
                    operation: "create".into(),
                    project: Some(repo.clone()),
                    path: None,
                    branch: None,
                    base: "HEAD".into(),
                    label: String::new(),
                    from: Some(from.into()),
                    confirm: None,
                },
            )
            .unwrap()
            .run()
            .unwrap()
            .0
        };
        let old = create(&core, "before").pop().unwrap();
        assert!(old.path.starts_with(home.join("nunchiro/worktrees/repo")));
        for bad in ["../../elsewhere", "a/../../b", "..", "~/wt", "/abs/../x"] {
            let e = core
                .handle(Request::QuitSettings { patch: dir(bad) })
                .err()
                .unwrap_or_default();
            assert!(!e.is_empty(), "{bad} refused");
            assert!(
                e.contains("leaves") || e.contains("full path") || e.contains(".."),
                "{bad}: {e}"
            );
        }
        let file = || std::fs::read_to_string(home.join("settings.json")).unwrap_or_default();
        assert!(
            !file().contains("worktrees_dir"),
            "a refusal writes nothing"
        );
        let Ok(Reply::QuitSettings { settings }) = core.handle(Request::QuitSettings {
            patch: LifetimePatch {
                worktrees_dir: Some("../.wt".into()),
                features: Some([("git.branch_prefix".into(), "nunchiro/".into())].into()),
                ..Default::default()
            },
        }) else {
            panic!("saved");
        };
        assert_eq!(settings.worktrees_dir.as_deref(), Some(Path::new("../.wt")));
        let listed = create(&core, "Fix login");
        let new = listed.iter().find(|w| w.label == "fix-login").unwrap();
        assert_eq!(new.branch, "nunchiro/fix-login");
        assert!(
            new.path.starts_with(home.join(".wt/repo")),
            "{:?}",
            new.path
        );
        assert!(new.path.is_dir());
        assert!(
            listed.iter().any(|w| w.path == old.path),
            "the older record still lists"
        );
        // A plain one-field name took the prefix; the branch is real in the repo.
        git(
            &repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/heads/nunchiro/fix-login",
            ],
        );
        // An absolute folder: the next create goes there, and both older records still list.
        let abs = home.join("abs-wt");
        core.handle(Request::QuitSettings {
            patch: dir(abs.to_str().unwrap()),
        })
        .unwrap();
        let listed = create(&core, "third");
        assert!(
            listed
                .iter()
                .any(|w| w.path.starts_with(&abs) && w.branch == "nunchiro/third")
        );
        assert!(
            listed.iter().any(|w| w.path == old.path) && listed.iter().any(|w| w.path == new.path)
        );
        // Back to the default: "" clears the key.
        core.handle(Request::QuitSettings { patch: dir("") })
            .unwrap();
        assert!(!file().contains("worktrees_dir"));
        assert_eq!(
            create(&core, "").len(),
            4,
            "every record lists under the default again"
        );
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn worktree_dir_rule() {
        let p = Path::new("/r/repo");
        let at =
            |d: &str| crate::sessions::worktree_root_for(Some(Path::new(d)), p, Path::new("/u"));
        assert_eq!(at("../.worktrees").unwrap(), Path::new("/r/.worktrees"));
        assert_eq!(at(".wt").unwrap(), Path::new("/r/repo/.wt"));
        assert_eq!(at("./a/b").unwrap(), Path::new("/r/repo/a/b"));
        assert_eq!(at("/Volumes/wt").unwrap(), Path::new("/Volumes/wt"));
        for bad in ["../..", "../../x", "a/../b", "", "~", "/a/../b"] {
            assert!(at(bad).is_err(), "{bad}");
        }
        // Ticket 1083: unset is in the user's home, wherever the repository is.
        assert_eq!(
            crate::sessions::worktree_root_for(None, p, Path::new("/u")).unwrap(),
            Path::new("/u/nunchiro/worktrees")
        );
        assert!(
            crate::sessions::worktree_root_for(None, p, Path::new(""))
                .unwrap_err()
                .contains("(worktrees_dir)")
        );
    }
    // Ticket 1083: the unset default is the visible `<user home>/nunchiro/worktrees`, never a `.nunchiro*` folder (peer.rs
    // owner_home() would take it for the owner's data folder); records under the 1061 default (`../.worktrees`) and
    // the older `<home>/worktrees` still list and remove after the default moved.
    #[test]
    fn the_default_folder_is_visible_and_three_roots_keep_working() {
        use crate::api::LifetimePatch;
        let default =
            crate::sessions::worktree_root_for(None, Path::new("/r/repo"), Path::new("/u"))
                .unwrap();
        assert!(
            !default
                .components()
                .any(|c| c.as_os_str().as_encoded_bytes().starts_with(b".nunchiro")),
            "{default:?}"
        );
        let home = home("wtc-three");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let user = home.join("user");
        std::fs::create_dir_all(&user).unwrap();
        let mut core = Sessions::open(&home).unwrap().with_user_home(&user);
        let dir = |d: &str| LifetimePatch {
            worktrees_dir: Some(d.into()),
            ..Default::default()
        };
        let create = |core: &Sessions, from: &str| {
            core.worktree_plan(
                None,
                Request::Worktree {
                    operation: "create".into(),
                    project: Some(repo.clone()),
                    path: None,
                    branch: None,
                    base: "HEAD".into(),
                    label: String::new(),
                    from: Some(from.into()),
                    confirm: None,
                },
            )
            .unwrap()
            .run()
            .unwrap()
            .0
        };
        let mut made = vec![];
        for (setting, under, name) in [
            ("../.worktrees", ".worktrees", "prev"),
            (home.join("worktrees").to_str().unwrap(), "worktrees", "old"),
            ("", "user/nunchiro/worktrees", "new"),
        ] {
            core.handle(Request::QuitSettings {
                patch: dir(setting),
            })
            .unwrap();
            let listed = create(&core, name);
            let w = listed.iter().find(|w| w.label == name).unwrap();
            assert!(
                w.path.starts_with(home.join(under).join("repo")),
                "{:?}",
                w.path
            );
            made.push(w.path.clone());
        }
        for path in made {
            let listed = core
                .worktree_plan(
                    None,
                    Request::Worktree {
                        operation: "remove".into(),
                        project: Some(repo.clone()),
                        path: Some(path.clone()),
                        branch: None,
                        base: String::new(),
                        label: String::new(),
                        from: None,
                        confirm: None,
                    },
                )
                .unwrap()
                .run()
                .unwrap()
                .0;
            assert!(!listed.iter().any(|w| w.path == path), "{path:?} removed");
            assert!(!path.exists());
        }
        std::fs::remove_dir_all(&home).unwrap();
    }
    // Ticket 1083: `<user home>/nunchiro` is made 0755 on first use and holds the 0700 `worktrees`; a link or a file
    // there is refused and nothing lands behind it.
    #[test]
    fn the_nunchiro_folder_in_the_home_is_made_and_never_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let home = home("wtc-base");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let user = home.join("user");
        std::fs::create_dir_all(&user).unwrap();
        let core = Sessions::open(&home).unwrap().with_user_home(&user);
        let create = |core: &Sessions, from: &str| {
            core.worktree_plan(
                None,
                Request::Worktree {
                    operation: "create".into(),
                    project: Some(repo.clone()),
                    path: None,
                    branch: None,
                    base: "HEAD".into(),
                    label: String::new(),
                    from: Some(from.into()),
                    confirm: None,
                },
            )
            .and_then(|plan| plan.run())
        };
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let listed = create(&core, "one").unwrap().0;
        assert!(
            listed
                .iter()
                .any(|w| w.path.starts_with(user.join("nunchiro/worktrees/repo")))
        );
        assert_eq!(mode(&user.join("nunchiro")), 0o755);
        assert_eq!(mode(&user.join("nunchiro/worktrees")), 0o700);
        // A link in its place: refused, and the target stays empty.
        let planted = home.join("planted");
        std::fs::create_dir_all(&planted).unwrap();
        std::fs::remove_dir_all(user.join("nunchiro")).unwrap();
        std::os::unix::fs::symlink(&planted, user.join("nunchiro")).unwrap();
        let e = create(&core, "two").err().unwrap_or_default();
        assert!(
            e.contains("is a link or not a folder") || e.contains("aliased"),
            "{e}"
        );
        assert_eq!(std::fs::read_dir(&planted).unwrap().count(), 0);
        std::fs::remove_dir_all(&home).unwrap();
    }
    // SHOULD 4 (r2): a session that started in the worktree after the pass read its running list: the real
    // `reserve_path` refuses, nothing is removed.
    #[test]
    fn a_real_session_in_the_worktree_refuses_the_reservation() {
        let home = home("wtc-live");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        let repo = std::fs::canonicalize(repo).unwrap();
        let registry = Mutex::new(Sessions::open(&home).unwrap().with_user_home(&home));
        let plan = registry
            .lock()
            .unwrap()
            .worktree_plan(
                None,
                Request::Worktree {
                    operation: "create".into(),
                    project: Some(repo.clone()),
                    path: None,
                    branch: Some("live".into()),
                    base: "HEAD".into(),
                    label: String::new(),
                    from: None,
                    confirm: None,
                },
            )
            .unwrap();
        let path = plan.run().unwrap().0[0].path.clone();
        git(&path, &["commit", "-q", "--allow-empty", "-m", "work"]);
        git(&repo, &["merge", "-q", "--no-ff", "-m", "merge", "live"]);
        let launch = registry.lock().unwrap().launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: repo.clone(),
            worktree: false,
            label: "live".into(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        });
        let mut launch = launch.prepare_existing(&path).unwrap();
        let session = registry.lock().unwrap().start(&launch).unwrap();
        launch.committed = true;
        let (_, root, running) = registry.lock().unwrap().auto_clean_view();
        assert!(
            running.iter().any(|r| r == &path),
            "the session runs in the worktree"
        );
        let mut c = Cleaner::default();
        let mut refused = 0;
        for now in [1, 1 + DELAY_MS] {
            let done = pass(
                &home,
                &root,
                true,
                now,
                &[], // the running list missed it: only the reservation stands in the way
                &mut c,
                &mut |p| {
                    let r = registry.lock().unwrap().reserve_path(p);
                    refused += r.is_err() as u32;
                    r
                },
                &mut |p| {
                    registry
                        .lock()
                        .unwrap()
                        .release_worktree(Some(p.to_path_buf()))
                },
                &|| false,
            );
            assert!(done.is_empty(), "{done:?}");
        }
        assert_eq!(
            refused, 1,
            "the due pass asked for the reservation once and was refused"
        );
        assert!(path.exists());
        registry
            .lock()
            .unwrap()
            .handle(Request::Close { id: session.id })
            .unwrap();
        let _ = std::fs::remove_dir_all(home);
    }

    // SHOULD 5 (r2): the task sees `stopping` within its 250 ms step, so the core's bounded wait ends at once when idle.
    #[test]
    fn the_task_ends_soon_after_stopping() {
        let home = home("wtc-stop");
        let registry = Arc::new(Mutex::new(
            Sessions::open(&home).unwrap().with_user_home(&home),
        ));
        let stopping = Arc::new(AtomicBool::new(false));
        let task = spawn(home.clone(), registry, stopping.clone()).unwrap();
        stopping.store(true, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(2);
        while !task.is_finished() {
            assert!(Instant::now() < until, "the task did not end");
            thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(home);
    }
    // V2-8h: what git never prints is still listed, never excused: `..`, `.`, absolute, quoted, or the folder itself.
    #[test]
    fn odd_ignored_paths_are_listed() {
        let root = home("wtc-odd");
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(root.join("package.json"), "").unwrap();
        for rel in [
            "build/../.env",
            "build/../notes.md",
            "target/./x",
            "/target/x",
            "target//x",
            "\"target/caf\\303\\251\"",
            "target",
            "node_modules",
            "Target/x",
            ".scratch/node_modules/x",
            "node_modules/.scratch/x",
            "venv/lib/x.py",
            "target/ID_RSA.pub",
            "dist/Credentials.json",
            "build/app.DB",
        ] {
            assert!(!regenerable(&root, rel), "{rel}");
        }
        for rel in [
            "target/debug/x",
            "build/out.o",
            "src/node_modules/x",
            "a/.DS_Store",
            "a/m.PYC",
        ] {
            assert!(regenerable(&root, rel), "{rel}");
        }
        assert_eq!(
            shown("a\u{202e}b\tc\u{2066}é"),
            "a\\u{202e}b\\u{9}c\\u{2066}é"
        );
        let _ = std::fs::remove_dir_all(root);
    }
    // V2.5-61 B8: git already hides a control-character ref; the core drops one anyway, and DEL and C1 too.
    #[test]
    fn listable_branch_names() {
        for bad in [
            "",
            "-x",
            "a\u{1}b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{2066}b",
            "a\u{feff}b",
            "a\u{61c}b",
        ] {
            assert!(!listable(bad), "{bad:?}");
        }
        assert!(!listable(&"x".repeat(256)));
        for good in ["main", "feat/x-1", "기능-브랜치", &"x".repeat(255)] {
            assert!(listable(good), "{good:?}");
        }
    }
    #[test]
    fn worktree_listable_uses_shared_hidden_set() {
        for bad in [
            "a\u{2028}b",
            "a\u{2066}b",
            "a\u{206f}b",
            "a\u{e0041}b",
            "a\u{061c}b",
        ] {
            assert!(!listable(bad), "{bad:?}");
        }
        // Korean and a plain emoji stay listed. U+200D (ZWJ) is inside the shared set (U+200B..=U+200F), so a ZWJ
        // sequence was already refused before this change: no behaviour change, flagged in REPORT.
        for good in ["기능-브랜치", "feat/😀"] {
            assert!(listable(good), "{good:?}");
        }
        assert!(!listable("a👨\u{200d}👩b"));
    }
    #[test]
    fn worktree_shown_escapes_shared_hidden_set() {
        for c in [
            '\u{2028}',
            '\u{2066}',
            '\u{206f}',
            '\u{e0041}',
            '\u{061c}',
            '\u{200b}',
        ] {
            assert_eq!(
                shown(&format!("a{c}b")),
                format!("a{}b", c.escape_unicode()),
                "{c:?}"
            );
        }
        assert_eq!(shown("기능 é😀 main"), "기능 é😀 main");
    }
    #[test]
    fn worktree_no_narrow_hidden_copy() {
        let source = include_str!("worktree_clean.rs");
        let code = source.split("mod tests {").next().unwrap();
        for copy in [
            "'\\u{200B}'..=",
            "'\\u{202A}'..=",
            "'\\u{2066}'..=",
            "'\\u{200e}'",
            "'\\u{061c}'",
        ] {
            assert!(!code.contains(copy), "narrow hidden-character copy {copy}");
        }
    }
    /// Ticket 394: the remote forms that name a GitHub repository, and user parts that would end the host early.
    #[test]
    fn github_remote_forms() {
        for (url, repo) in [
            ("https://github.com/Acme/App.git", Some("acme/app")),
            ("https://github.com/acme/app/", Some("acme/app")),
            ("http://github.com/acme/app", Some("acme/app")),
            ("ssh://git@github.com/acme/app.git", Some("acme/app")),
            ("git@github.com:acme/app.git", Some("acme/app")),
            ("git://github.com/acme/app", Some("acme/app")),
            ("https://user@github.com/acme/app.git", Some("acme/app")),
            (
                "https://x-access-token:ghs_A1.b-c~d%40@github.com/acme/app",
                Some("acme/app"),
            ),
            ("https://x?@github.com/acme/app", None),
            ("https://x#@github.com/acme/app", None),
            ("https://evil.example/x@github.com/acme/app", None),
            ("https://evil.example@x@github.com/acme/app", None),
            ("https://a b@github.com/acme/app", None),
            ("https://gitlab.com/acme/app", None),
            ("https://github.com/acme/app/extra", None),
        ] {
            assert_eq!(github_repo(url).as_deref(), repo, "{url}");
        }
    }
    /// Ticket 394: a failed PR fetch's error (logged by `pull_request`) carries no `user:token@`.
    #[test]
    fn fetch_error_drops_the_url_user_part() {
        let top = home("fetch-secret");
        git(&top, &["init", "-q"]);
        // A path, so git names it in its error with no network call (git's own https errors already drop the user).
        let remote = format!("{}/user:tok3n@github.com/acme/app", top.display());
        let e = fetch(&top, &remote, "+refs/pull/1/head:refs/nunchiro/x", &[]).unwrap_err();
        std::fs::remove_dir_all(&top).unwrap();
        assert!(
            e.contains("github.com/acme/app") && !e.contains("tok3n"),
            "{e}"
        );
        assert_eq!(
            crate::process::without_userinfo(
                "fatal: 'https://u:t@github.com/a' and u:t@h:9 (port 9418)"
            ),
            "fatal: 'github.com/a' and h:9 (port 9418)"
        );
    }
    #[test]
    fn a_branch_prefix_joins_with_one_slash() {
        for (prefix, branch) in [
            ("feature", "feature/fix-login"),
            ("feature/", "feature/fix-login"),
            ("nunchiro/", "nunchiro/fix-login"),
            ("feat-", "feat-/fix-login"),
            ("", "fix-login"),
        ] {
            assert_eq!(
                from_text("Fix login", prefix).unwrap(),
                (branch.to_string(), "fix-login".to_string())
            );
        }
    }
    #[test]
    fn typed_text_in_another_script_names_the_branch() {
        // Eighth look (A): the palette's "New worktree" box with a Korean task gave "wt-xxxx".
        let named = |text: &str| from_text(text, "").unwrap().1;
        assert_eq!(
            named("로그인 화면의 버튼 색을 바꿔 줘"),
            "로그인-화면의-버튼-색을-바꿔-줘"
        );
        assert_eq!(named("Fix 로그인 bug"), "fix-로그인-bug");
        assert_eq!(named("Fix login"), "fix-login"); // ASCII text as before
        assert!(!generated("로그인 버그"));
        assert!(generated("🎉 !!") && named("🎉 !!").starts_with("wt-"));
    }
    #[test]
    fn slugs_and_urls() {
        assert_eq!(slug("Fix the login redirect!"), "fix-the-login-redirect");
        assert_eq!(slug("한글만"), "");
        assert_eq!(slug("--a--b--"), "a-b");
        // Ticket 991 (Q7 point 1): a title's name keeps its script.
        assert_eq!(
            title_slug("Fix the Login redirect!"),
            "fix-the-login-redirect"
        );
        assert_eq!(title_slug("로그인 버그를 고쳐 줘"), "로그인-버그를-고쳐-줘");
        assert_eq!(title_slug("Fix 로그인 bug #12…"), "fix-로그인-bug-12");
        assert_eq!(
            title_slug("ログインのバグを直して。"),
            "ログインのバグを直して"
        );
        assert_eq!(title_slug("修复登录错误"), "修复登录错误");
        assert_eq!(title_slug("🎉🎉 !! …"), "");
        assert_eq!(title_slug("..hidden.name.lock"), "hidden-name-lock");
        // Decomposed input (a pasted macOS file name): jamo become syllables, a combining accent joins its letter.
        assert_eq!(
            title_slug("\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}"),
            "한글"
        );
        assert_eq!(title_slug("cafe\u{301} menu"), "cafe-menu");
        // 40 characters, not bytes, and no hyphen left at the cut.
        let long = title_slug(&"가나다라 ".repeat(20));
        assert_eq!(long.chars().count(), 39);
        assert!(long.ends_with('라') && long.len() > 40, "{long}");
        assert_eq!(
            github("https://github.com/acme/app/pull/7"),
            Some((true, 7, "acme/app".into()))
        );
        assert_eq!(
            github("https://github.com/Acme/App/issues/412"),
            Some((false, 412, "acme/app".into()))
        );
        for bad in [
            "https://github.com/acme/app/pull/7;rm",
            "https://github.com/acme/app/pull/7/files",
            "https://github.com/-x/app/pull/1",
            "https://github.com/acme/app/pull/",
            "http://github.com/acme/app/pull/7",
            "https://github.com.evil/acme/app/pull/7",
            "https://github.com/acme/app/pull/7?x=1",
        ] {
            assert_eq!(github(bad), None, "{bad}");
        }
        assert!(
            plain_branch("feature/login")
                && !plain_branch("--upload-pack=x")
                && !plain_branch("a b")
        );
    }
}
