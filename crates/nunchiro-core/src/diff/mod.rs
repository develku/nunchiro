//! A session folder's changes against the commit that was HEAD when the session started, plus
//! untracked files (spec B3 Diff). Read only: `git` runs with optional locks off, so it never
//! refreshes the index, and nothing here adds, stashes or moves a ref (see `changes` for why the
//! plumbing commands).
use crate::api::{Reply, Request, Response};
use crate::files;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
pub(crate) mod stamp;

/// Files listed per reply; the rest is cut off and the reply says `truncated`.
pub const MAX_FILES: usize = 2000;
/// A patch or an untracked file larger than this comes back as "too large": the stdout cap of
/// `process::output`, so git output that reaches it is known to be cut.
const MAX_PATCH: usize = crate::process::OUTPUT_CAP;
const GONE: &str = "start commit no longer exists";
/// Bytes of untracked files read to count their lines for the list.
const COUNT_BUDGET: u64 = 8 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// What the session's folder was when it started. A session record without one (started before
/// v1b-11) has no base: Diff says "start commit unknown" and never falls back to today's HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Base {
    Commit {
        sha: String,
    },
    /// A repository with no commit yet: everything is compared with the empty tree.
    NoCommits,
    NotGit,
}

/// Ticket 374: what a diff request compares with. `Branch` is where HEAD left origin's default branch, from the
/// last fetched origin (no network); behaviour from t3code apps/web/src/components/DiffPanel.tsx:678-700 (MIT).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "DiffScope"))]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    #[default]
    Session,
    Branch,
}

/// Whether the Branch scope can compare in this folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Branch {
    /// `default` is origin's default branch as a remote branch name, such as `origin/main`.
    Ready {
        default: String,
    },
    NoOrigin,
    /// HEAD is on the default branch itself: there is no other branch to compare.
    OnDefault,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Change {
    /// Relative to the session folder.
    pub path: String,
    /// One letter: `M`, `A`, `D`, `R`, `C`, `T`, `U`, or `?` for untracked.
    pub status: String,
    /// The path at the start commit, for a rename or copy.
    pub old_path: Option<String>,
    /// Line counts; null for a binary file or an untracked file not counted.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
    /// Q9 pop-J25-1: the working file's stat as a number; null when it is gone. A second edit with the same counts
    /// changes it, so Diff re-reads that patch.
    #[serde(default)]
    pub stamp: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Patch {
    pub path: String,
    pub status: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    /// Unified patch text (`@@` hunks); null when binary or too large.
    pub patch: Option<String>,
}

/// Ticket 373: what the Diff header's one git button reads (web/src/diff/gitAction.ts, after T3 Code's
/// `resolveQuickAction`). Read only, like the rest of this module: the button only asks the session's agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct GitFacts {
    /// The checked-out branch; null when HEAD is detached.
    pub branch: Option<String>,
    /// Uncommitted changes, untracked files included.
    pub dirty: bool,
    /// The branch has an upstream; `ahead` and `behind` count against it (0 without one).
    pub upstream: bool,
    pub ahead: u64,
    pub behind: u64,
    /// Commits on HEAD that origin's default branch lacks; null when that branch is unknown.
    pub ahead_of_default: Option<u64>,
    /// The checked-out branch is the default branch: one press must never push there.
    pub is_default: bool,
    pub has_remote: bool,
    /// Ticket 393: the branch has an upstream set that cannot be read as an exact `refs/heads/` ref (or the read
    /// failed): where a push lands is unknown, so the button offers no push or PR; a commit still is.
    pub upstream_unknown: bool,
    /// `gh` is on the core's PATH (the PATH the PR poller uses); whether it is logged in is not known here.
    pub gh: bool,
}

/// Default-branch names checked on origin when its HEAD is unknown (`git clone` sets it; `git remote add` does not).
const COMMON_DEFAULTS: [&str; 4] = ["main", "master", "trunk", "develop"];

/// `None` when git's status cannot be read; a part that cannot be read (no upstream, no origin) reads as absent, an
/// upstream that is set but unreadable as `upstream_unknown`.
/// Four git calls (status, config, for-each-ref, rev-list); `diff_list` runs it only when the Diff dock asks.
pub fn facts(dir: &Path) -> Option<GitFacts> {
    let text = |args: &[&str]| git(dir, args).ok().map(|o| lossy(&o).trim().to_string());
    // One status for the branch, its upstream, ahead and behind, and uncommitted changes (header lines start `#`).
    // Ticket 403 round 2: read cut on purpose: the headers come first and `dirty` needs one change line, so a status
    // past `MAX_PATCH` loses nothing used here.
    let status = git_cut(
        dir,
        &["status", "--porcelain=v2", "--branch", "--ahead-behind"],
    )
    .ok()
    .map(|o| lossy(&o).trim().to_string())?;
    let header = |key: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .map(str::to_string)
    };
    let dirty = status.lines().any(|l| !l.starts_with('#'));
    // `branch.head` is the name after `refs/heads/` exactly: never `heads/main`, as `--short` prints beside a tag
    // `main` (tags come with any fetch).
    let branch = header("# branch.head ").filter(|b| !b.is_empty() && b != "(detached)");
    // `branch.ab` is there only when the upstream ref exists.
    let (upstream, ahead, behind) = header("# branch.ab ")
        .and_then(|ab| {
            let (a, b) = ab.split_once(' ')?;
            Some((
                true,
                a.strip_prefix('+')?.parse().ok()?,
                b.strip_prefix('-')?.parse().ok()?,
            ))
        })
        .unwrap_or((false, 0, 0));
    // init.defaultBranch, whether any remote is set and each branch's merge ref, in one read (no match exits 1:
    // none). Should it fail, no remote is known and the ladder offers no push without a readable upstream.
    let config = git(
        dir,
        &[
            "config",
            "--get-regexp",
            r"^(init\.defaultbranch|remote\..*\.url|branch\..*\.merge)$",
        ],
    );
    // Ticket 403 item 16b: a config too long to read whole may hide the branch's merge ref: its upstream is unknown.
    let config_cut = config
        .as_ref()
        .is_err_and(|e| e.ends_with(crate::process::CUT));
    let config = config
        .map(|o| lossy(&o).trim().to_string())
        .unwrap_or_default();
    // Each scope lists its value (system, global, local); the last one wins, as `git config --get` reads it.
    let init = config
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("init.defaultbranch "))
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    let has_remote = config.lines().any(|l| l.starts_with("remote."));
    let merge_set = branch.as_ref().is_some_and(|b| {
        config
            .lines()
            .any(|l| l.starts_with(&format!("branch.{b}.merge ")))
    });
    // Origin's HEAD (the default-branch lookup of auto_pull.rs `update`) and the default names origin has, in one
    // read. Patterns match by prefix, so only exact names count; full refs, never `--short`.
    let names_on_origin: Vec<String> = ["HEAD"]
        .iter()
        .chain(COMMON_DEFAULTS.iter())
        .map(|n| n.to_string())
        .chain(init.clone())
        .map(|n| format!("refs/remotes/origin/{n}"))
        .collect();
    // Ticket 393: the branch's upstream as the exact ref a plain push updates (`%(upstream:remoteref)`, empty when
    // no fetch refspec maps it), in the same read.
    let own = branch.as_ref().map(|b| format!("refs/heads/{b}"));
    let mut args = vec![
        "for-each-ref",
        "--format=%(refname)%00%(symref)%00%(upstream:remoteref)",
        "--end-of-options",
    ];
    args.extend(names_on_origin.iter().chain(&own).map(String::as_str));
    let read = text(&args);
    // On a branch, an upstream that cannot be read (a timeout, a merge ref no remote-tracking ref maps) could land
    // a push anywhere: `upstream_unknown`.
    let unread = own.is_some() && read.is_none();
    let refs: Vec<(String, String, String)> = read
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\0');
            let (r, s, u) = (parts.next()?, parts.next()?, parts.next()?);
            Some((r.to_string(), s.to_string(), u.to_string()))
        })
        .collect();
    let remoteref = refs
        .iter()
        .find(|(r, _, _)| Some(r) == own.as_ref())
        .map(|(_, _, u)| u.as_str())
        // A short merge value (`main`) is not an exact ref: git would guess where the push lands.
        .filter(|u| u.starts_with("refs/heads/"));
    let upstream_unknown =
        unread || (merge_set && remoteref.is_none()) || (own.is_some() && config_cut);
    let on_origin = |n: &str| {
        refs.iter()
            .any(|(r, _, _)| r.strip_prefix("refs/remotes/origin/") == Some(n))
    };
    let head = refs
        .iter()
        .find(|(r, _, _)| r == "refs/remotes/origin/HEAD")
        .and_then(|(_, s, _)| s.strip_prefix("refs/remotes/origin/"))
        .filter(|h| !h.is_empty())
        .map(str::to_string);
    // With origin's HEAD unknown, the common default names origin has.
    let common: Vec<String> = match head {
        Some(_) => vec![],
        None => COMMON_DEFAULTS
            .iter()
            .filter(|n| on_origin(n))
            .map(|n| n.to_string())
            .collect(),
    };
    let default = head
        .clone()
        .or_else(|| common.first().cloned())
        .or(init.clone());
    // The full ref: a name from the remote may start with a dash and must never read as an option.
    let ahead_of_default = default.as_ref().and_then(|d| {
        let base = if head.as_deref() == Some(d.as_str()) || on_origin(d) {
            format!("refs/remotes/origin/{d}..HEAD")
        } else {
            format!("refs/heads/{d}..HEAD")
        };
        text(&["rev-list", "--count", "--end-of-options", &base]).and_then(|n| n.parse().ok())
    });
    // Every name that may be the default is guarded, guarding too much being safe: origin's HEAD, init.defaultBranch,
    // the common names origin has when its HEAD is unknown, and always main and master (a stale origin HEAD after a
    // rename still names the old branch).
    // A branch whose upstream is one of them on any remote (or `.`) counts too: its plain push would land there.
    // Names compare in any case (a case-insensitive disk).
    let names: Vec<&str> = ["main", "master"]
        .into_iter()
        .chain([&head, &init].into_iter().flatten().map(String::as_str))
        .chain(common.iter().map(String::as_str))
        .collect();
    let is_default = branch.as_deref().is_some_and(|b| {
        names.iter().any(|d| d.eq_ignore_ascii_case(b))
            || remoteref.is_some_and(|u| {
                names
                    .iter()
                    .any(|d| u.eq_ignore_ascii_case(&format!("refs/heads/{d}")))
            })
    });
    Some(GitFacts {
        is_default,
        branch,
        dirty,
        upstream,
        ahead,
        behind,
        ahead_of_default,
        has_remote,
        upstream_unknown,
        gh: crate::firstrun::on_path("gh").is_some(),
    })
}

/// Records the start state of `dir`. Runs once at session start, outside the registry lock.
pub fn start(dir: &Path) -> Base {
    // A folder an enclosing repository ignores is not under version control either.
    if git(dir, &["rev-parse", "--is-inside-work-tree"]).is_err()
        || git(dir, &["check-ignore", "-q", "."]).is_ok()
    {
        return Base::NotGit;
    }
    match git(dir, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]) {
        Ok(out) => Base::Commit {
            sha: String::from_utf8_lossy(&out).trim().to_string(),
        },
        // `-q`: git says nothing when HEAD names no commit yet.
        Err(e)
            if e.strip_prefix("git rev-parse:")
                .is_some_and(|m| m.trim().is_empty()) =>
        {
            Base::NoCommits
        }
        // Q9 en-a-J6-1: any other failure (a timeout under load) is not "no commits", which is kept for the session's
        // life and shows every tracked file as added; `read` checks a `NotGit` start again on each request.
        Err(_) => Base::NotGit,
    }
}

/// A stored start commit is a full object name: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits.
pub(crate) fn valid_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Ticket 463: how long a list answered from its stamp is kept at most: the bound for what the stamp does not see (an
/// edit inside a submodule, a new file in a folder that holds no tracked or listed file, a pruned start commit).
pub(crate) const FALLBACK: Duration = Duration::from_secs(300);
/// `FALLBACK`, or shorter by `NUNCHIRO_DIFF_FALLBACK_MS` (ticket 501: a test sees the re-read happen).
pub(crate) fn fallback() -> Duration {
    crate::account_signin::wait("NUNCHIRO_DIFF_FALLBACK_MS", FALLBACK)
}
/// Folders whose last list is kept; all are dropped when full.
const KEPT: usize = 64;

/// Ticket 463: the last session-scope list of a folder and start commit, with the stamp read before git ran.
#[derive(Clone)]
struct Kept {
    at: Instant,
    stamp: u64,
    base: Option<Base>,
    base_missing: bool,
    files: Vec<Change>,
    truncated: bool,
    branch: Option<Branch>,
    git: Option<GitFacts>,
}
/// Keyed by folder, start commit and whether the git facts were asked: a list without them never answers one with.
type Lists = HashMap<(PathBuf, Option<Base>, bool), Kept>;
static LISTS: LazyLock<Mutex<Lists>> = LazyLock::new(Default::default);

/// Runs one diff request for the folder `dir`, after the caller dropped the registry lock.
/// Ticket 463: the status bar asks for the list every 30 s and the Artifacts panel on each focus; that list (the
/// session scope) is answered again from the last one while the folder's stamp is unchanged and `FALLBACK` has not
/// passed. Ticket 501: so is the Diff dock's list with its git facts, asked every 30 s too; the stamp sees the refs the
/// facts read (HEAD's branch, origin's, packed refs, the config). A list a person asked for (`fresh`) runs git and
/// replaces the kept one; the Branch list and every patch always run git.
pub fn run(dir: PathBuf, base: Option<Base>, request: Request) -> Response {
    let Request::DiffList {
        scope: Scope::Session,
        git: facts,
        ..
    } = request
    else {
        return read(dir, base, request);
    };
    let key = (dir.clone(), base.clone(), facts);
    let kept = LISTS.lock().ok().and_then(|l| l.get(&key).cloned());
    let untracked = |files: &[Change]| -> Vec<String> {
        files
            .iter()
            .filter(|c| c.status == "?")
            .map(|c| c.path.clone())
            .collect()
    };
    let before = kept.as_ref().map_or(vec![], |k| untracked(&k.files));
    // Read before git runs: a change while it runs makes the next stamp differ.
    let stamp = stamp::stamp(&dir, before.iter().map(String::as_str));
    // A list a person asked for (`fresh`) reads git and replaces the kept one.
    let fresh = matches!(request, Request::DiffList { fresh: true, .. });
    if !fresh
        && let (Some(k), Some(now)) = (kept, stamp)
        && k.stamp == now
        && k.at.elapsed() < fallback()
    {
        return Ok(Reply::Diff {
            base: k.base,
            base_missing: k.base_missing,
            files: k.files,
            truncated: k.truncated,
            branch: k.branch,
            git: k.git,
        });
    }
    let reply = read(dir.clone(), base.clone(), request)?;
    let (stamp, found, base_missing, files, truncated, branch, git) = match (stamp, reply) {
        (
            Some(stamp),
            Reply::Diff {
                base,
                base_missing,
                files,
                truncated,
                branch,
                git,
            },
        ) => (stamp, base, base_missing, files, truncated, branch, git),
        (_, reply) => return Ok(reply),
    };
    // A list with other untracked files is stamped again over them, unless something changed while git ran.
    let after = untracked(&files);
    let stamp = match after == before {
        true => Some(stamp),
        false => stamp::stamp(&dir, after.iter().map(String::as_str))
            .filter(|_| stamp::stamp(&dir, before.iter().map(String::as_str)) == Some(stamp)),
    };
    // RC2b item 7: "not a git folder" inside a repository may be one failed git call; it is never kept.
    if let Some(stamp) = stamp
        && !(found == Some(Base::NotGit) && stamp::top(&dir).is_some())
        && let Ok(mut lists) = LISTS.lock()
    {
        if lists.len() >= KEPT {
            lists.clear();
        }
        let kept = Kept {
            at: Instant::now(),
            stamp,
            base: found.clone(),
            base_missing,
            files: files.clone(),
            truncated,
            branch: branch.clone(),
            git: git.clone(),
        };
        lists.insert(key, kept);
    }
    Ok(Reply::Diff {
        base: found,
        base_missing,
        files,
        truncated,
        branch,
        git,
    })
}

/// One diff request, read from git.
fn read(dir: PathBuf, mut base: Option<Base>, request: Request) -> Response {
    let scope = match &request {
        Request::DiffList { scope, .. } | Request::DiffFile { scope, .. } => *scope,
        _ => Scope::Session,
    };
    // RC2b item 7: `start` runs once, so one failed git call there (a timeout under load, PATH)
    // would say "not a git folder" for the session's life. Re-check per request; a recovered base
    // is the HEAD at request time, not at session start, and is not stored back.
    if base == Some(Base::NotGit) {
        base = Some(start(&dir));
    }
    // `None` with `missing`: the start commit was garbage-collected or history was rewritten.
    // A list says whether Branch can compare; a Branch list where it cannot falls back to the session's changes.
    let branch = (base != Some(Base::NotGit)
        && (scope == Scope::Branch
            || matches!(request, Request::DiffList { .. })
            || matches!(base, Some(Base::Commit { .. }))))
    .then(|| branch(&dir));
    if let (Scope::Branch, Some(Branch::Ready { default })) = (scope, &branch) {
        base = Some(Base::Commit {
            sha: fork_point(&dir, default)?,
        });
    } else if scope == Scope::Branch && matches!(request, Request::DiffFile { .. }) {
        return Err("no branch to compare with".into());
    } else if let (Some(Base::Commit { sha }), Some(Branch::Ready { default })) = (&base, &branch)
        && valid_sha(sha)
        && let Ok(fork) = fork_point(&dir, default)
        && fork != *sha
        && git(&dir, &["merge-base", "--is-ancestor", sha, &fork]).is_ok()
    {
        // Ticket 1013 (F6): a start commit behind the branch point (a stale root HEAD, a session started before ticket
        // 1007) would count every commit the default branch gained since; the session's changes start at the fork.
        base = Some(Base::Commit { sha: fork });
    }
    let (reference, missing) = match &base {
        None | Some(Base::NotGit) => (None, false),
        Some(b) => {
            let r = reference(&dir, b)?;
            let missing = r.is_none();
            (r, missing)
        }
    };
    match request {
        Request::DiffList { git: asked, .. } => {
            let (files, truncated) = match &reference {
                Some(r) => changes(&dir, r)?,
                None => (vec![], false),
            };
            // Only the Diff dock asks (its own list and the press-time recheck); a folder outside version control
            // has no git state to act on.
            let git = (asked && base != Some(Base::NotGit))
                .then(|| facts(&dir))
                .flatten();
            Ok(Reply::Diff {
                base,
                base_missing: missing,
                files,
                truncated,
                branch,
                git,
            })
        }
        Request::DiffFile { path, .. } => {
            if missing {
                return Err(GONE.into());
            }
            let reference = reference.ok_or("no changes to show")?;
            let change = one(&dir, &reference, &path)?.ok_or("not a changed file")?;
            patch(&dir, &reference, change).map(Reply::DiffFile)
        }
        _ => Err("not a diff request".into()),
    }
}

/// Origin's default branch (`origin/main`): origin/HEAD as a clone sets it, else main or master (a remote added
/// later has no origin/HEAD).
fn origin_default(dir: &Path) -> Option<String> {
    let text = |args: &[&str]| git(dir, args).ok().map(|o| lossy(&o).trim().to_string());
    if let Some(name) = text(&[
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
    ]) && name.starts_with("origin/")
    {
        return Some(name);
    }
    ["origin/main", "origin/master"]
        .into_iter()
        .map(String::from)
        .find(|name| {
            text(&[
                "rev-parse",
                "--verify",
                "-q",
                &format!("refs/remotes/{name}^{{commit}}"),
            ])
            .is_some()
        })
}

fn branch(dir: &Path) -> Branch {
    let Some(default) = origin_default(dir) else {
        return Branch::NoOrigin;
    };
    let head = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|o| lossy(&o).trim().to_string());
    if head.ok().as_deref() == default.strip_prefix("origin/") {
        return Branch::OnDefault;
    }
    Branch::Ready { default }
}

/// Where HEAD left `default`; the full ref name can never read as an option.
fn fork_point(dir: &Path, default: &str) -> Result<String, String> {
    let out = git(
        dir,
        &["merge-base", "HEAD", &format!("refs/remotes/{default}")],
    )
    .map_err(|_| format!("this branch shares no history with {default}"))?;
    Ok(lossy(&out).trim().to_string())
}

/// The tree-ish to compare with, or `None` when the start commit no longer exists.
fn reference(dir: &Path, base: &Base) -> Result<Option<String>, String> {
    match base {
        Base::Commit { sha } => {
            let object = format!("{sha}^{{commit}}");
            Ok(git(dir, &["cat-file", "-e", "--end-of-options", &object])
                .ok()
                .map(|_| sha.clone()))
        }
        Base::NoCommits => git(dir, &["hash-object", "-t", "tree", "/dev/null"])
            .map(|o| Some(String::from_utf8_lossy(&o).trim().to_string())),
        Base::NotGit => Err("not a git folder".into()),
    }
}

/// Output that reached the cap lost its tail: only whole NUL-terminated records are kept.
fn whole(mut out: Vec<u8>) -> (Vec<u8>, bool) {
    let cut = out.len() >= MAX_PATCH;
    if cut {
        out.truncate(out.iter().rposition(|b| *b == 0).map_or(0, |i| i + 1));
    }
    (out, cut)
}

/// One path's change, without building the whole list (no untracked file is read here).
fn one(dir: &Path, reference: &str, path: &str) -> Result<Option<Change>, String> {
    if let Some(c) = tracked(dir, reference)?
        .0
        .into_iter()
        .find(|c| c.path == path)
    {
        return Ok(Some(c));
    }
    let literal = format!(":(literal){path}");
    let others = git(
        dir,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            &literal,
        ],
    )?;
    Ok(others
        .split(|b| *b == 0)
        .any(|p| p == path.as_bytes())
        .then(|| Change {
            path: path.into(),
            status: "?".into(),
            old_path: None,
            additions: None,
            deletions: None,
            binary: false,
            stamp: None,
        }))
}

fn changes(dir: &Path, reference: &str) -> Result<(Vec<Change>, bool), String> {
    let (mut out, mut truncated) = tracked(dir, reference)?;
    let (untracked, cut) = whole(git_cut(
        dir,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?);
    truncated |= cut;
    let root = files::Root::Folder(dir.to_path_buf());
    let mut budget = COUNT_BUDGET;
    for path in untracked.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let path = lossy(path);
        let (mut additions, mut binary) = (None, false);
        if budget > 0
            && let Ok(content) = files::read(&root, &path)
        {
            budget = budget.saturating_sub(content.size);
            binary = content.kind == files::Kind::Binary || content.kind == files::Kind::Image;
            additions = content.text.as_deref().map(|t| t.lines().count() as u64);
        }
        out.push(Change {
            path,
            status: "?".into(),
            old_path: None,
            additions,
            deletions: additions.map(|_| 0),
            binary,
            stamp: None,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    if out.len() > MAX_FILES {
        out.truncate(MAX_FILES);
        truncated = true;
    }
    for c in &mut out {
        c.stamp = stamp::file(&dir.join(&c.path));
    }
    Ok((out, truncated))
}

/// Tracked changes (staged and unstaged) against `reference`, with line counts.
fn tracked(dir: &Path, reference: &str) -> Result<(Vec<Change>, bool), String> {
    let diff = |kind: &str| {
        git_cut(
            dir,
            &[
                "diff-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--relative",
                "-M",
                kind,
                "-z",
                "--end-of-options",
                reference,
                "--",
            ],
        )
        .map(whole)
    };
    // Plumbing on purpose: porcelain `git diff` rewrites the index after finding stat-only changes,
    // even with optional locks off. `diff-index` never writes, but lists a stat-only change in
    // `--name-status`; `--numstat` compares content, so a path it leaves out did not change.
    let (names, names_cut) = diff("--name-status")?;
    let (counts, counts_cut) = diff("--numstat")?;

    let mut stat: HashMap<String, (Option<u64>, Option<u64>)> = HashMap::new();
    let mut fields = counts.split(|b| *b == 0);
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        // A rename leaves the path field empty and puts old and new in the next two records.
        let path = if path.is_empty() {
            fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        let n = |b: &[u8]| std::str::from_utf8(b).ok().and_then(|s| s.parse().ok());
        stat.insert(lossy(path), (n(a), n(d)));
    }

    let mut out = Vec::new();
    let mut fields = names.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(code) = fields.next() {
        let status = lossy(&code[..1]);
        let old_path = (code[0] == b'R' || code[0] == b'C')
            .then(|| fields.next().map(lossy))
            .flatten();
        let Some(path) = fields.next().map(lossy) else {
            break;
        };
        let Some(&(additions, deletions)) = stat.get(&path) else {
            continue;
        };
        out.push(Change {
            // numstat marks a binary file `-\t-`.
            binary: additions.is_none() && deletions.is_none(),
            path,
            status,
            old_path,
            additions,
            deletions,
            stamp: None,
        });
    }
    Ok((out, names_cut || counts_cut))
}

fn patch(dir: &Path, reference: &str, change: Change) -> Result<Patch, String> {
    let mut reply = Patch {
        path: change.path,
        status: change.status,
        old_path: change.old_path,
        binary: change.binary,
        too_large: false,
        patch: None,
    };
    if reply.binary {
        return Ok(reply);
    }
    if reply.status == "?" {
        // Untracked content is read through the files confinement, never by git or by path.
        let content = files::read(&files::Root::Folder(dir.to_path_buf()), &reply.path)?;
        reply.binary = content.kind == files::Kind::Binary || content.kind == files::Kind::Image;
        reply.too_large = content.too_large || content.size as usize > MAX_PATCH;
        if !reply.binary && !reply.too_large {
            reply.patch = Some(added(&reply.path, content.text.as_deref().unwrap_or("")));
        }
        return Ok(reply);
    }
    let mut args = vec![
        "diff-index",
        "--patch",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--relative",
        "-M",
        "--end-of-options",
        reference,
        "--",
    ];
    let new = format!(":(literal){}", reply.path);
    let old = reply.old_path.as_ref().map(|p| format!(":(literal){p}"));
    args.push(&new);
    if let Some(old) = &old {
        args.push(old);
    }
    let out = git_cut(dir, &args)?;
    if out.len() >= MAX_PATCH {
        reply.too_large = true;
    } else {
        reply.patch = Some(String::from_utf8_lossy(&out).into_owned());
    }
    Ok(reply)
}

/// A unified patch that adds `text` as a new file.
fn added(path: &str, text: &str) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut out = format!("--- /dev/null\n+++ b/{path}\n");
    if lines.is_empty() {
        return out;
    }
    out += &format!("@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        out.push('+');
        out += line;
    }
    if !text.ends_with('\n') {
        out += "\n\\ No newline at end of file\n";
    }
    out
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    crate::process::git_read(dir, args, GIT_TIMEOUT)
}
/// `git` for a listing or patch whose caller handles a cut at `MAX_PATCH` itself.
fn git_cut(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    crate::process::git_read_cut(dir, args, GIT_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each git call that takes the reference reads an option-looking one as a revision, never as
    /// `--output` (which would truncate the named file).
    #[test]
    fn diff_git_calls_never_read_the_reference_as_an_option() {
        let top = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("diff-eoo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        std::fs::create_dir_all(top.join("repo")).unwrap();
        let dir = top.join("repo");
        let sh = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        sh(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        let victim = top.join("victim.txt");
        std::fs::write(&victim, "keep me\n").unwrap();
        let evil = format!("--output={}", victim.display());
        assert!(tracked(&dir, &evil).is_err());
        let change = Change {
            path: "a.txt".into(),
            status: "M".into(),
            old_path: None,
            additions: Some(1),
            deletions: Some(1),
            binary: false,
            stamp: None,
        };
        assert!(patch(&dir, &evil, change).is_err());
        assert!(
            reference(&dir, &Base::Commit { sha: evil.clone() })
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me\n");
        std::fs::remove_dir_all(top).unwrap();
    }

    fn scratch(tag: &str) -> PathBuf {
        let top = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("diff-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        std::fs::create_dir_all(&top).unwrap();
        top
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let mut c = std::process::Command::new("git");
        for k in crate::process::FIXTURE_SCRUB {
            c.env_remove(k);
        }
        let ok = c
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn list(dir: &Path, base: Base) -> (Option<Base>, Vec<Change>) {
        let request = Request::DiffList {
            session: "s".into(),
            scope: Scope::Session,
            git: false,
            fresh: false,
        };
        match run(dir.to_path_buf(), Some(base), request).unwrap() {
            Reply::Diff { base, files, .. } => (base, files),
            other => panic!("not a diff reply: {other:?}"),
        }
    }

    /// Ticket 1013 (F6): a session whose start commit is far behind the default branch (a stale root HEAD) counts from
    /// where its branch left the default branch, not every commit the default branch gained since; the file patch
    /// agrees with the list. A start commit after the branch point is kept.
    #[test]
    fn diff_stale_start_counts_from_the_branch_point() {
        let top = scratch("stale-start");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        let head = || {
            lossy(&git(&dir, &["rev-parse", "HEAD"]).unwrap())
                .trim()
                .to_string()
        };
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "a"]);
        let stale = head();
        std::fs::write(dir.join("landed.txt"), "landed elsewhere\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "landed"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "main"]);
        let fork = head();
        git_in(
            &dir,
            &["checkout", "-q", "-b", "fix", "--no-track", "origin/main"],
        );
        std::fs::write(dir.join("a.txt"), "mine\n").unwrap();

        let (base, files) = list(&dir, Base::Commit { sha: stale.clone() });
        let paths: Vec<_> = files.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(
            paths,
            ["a.txt"],
            "the default branch's own commits are not the session's"
        );
        assert_eq!(base, Some(Base::Commit { sha: fork.clone() }));
        let file = Request::DiffFile {
            session: "s".into(),
            path: "landed.txt".into(),
            scope: Scope::Session,
        };
        assert!(run(dir.clone(), Some(Base::Commit { sha: stale }), file).is_err());

        // A start after the branch point (the session's own commit) stays the base.
        git_in(&dir, &["commit", "-q", "-am", "mine"]);
        let own = head();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        let (base, files) = list(&dir, Base::Commit { sha: own.clone() });
        assert_eq!(base, Some(Base::Commit { sha: own }));
        assert_eq!(
            files.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
            ["b.txt"]
        );
        std::fs::remove_dir_all(top).unwrap();
    }

    /// RC2b item 7: a start that failed once (git timed out, PATH) stored `NotGit` for a repo; the
    /// next request re-checks and shows the repo's changes instead of "not a git repository".
    #[test]
    fn diff_base_recovers_after_failed_start() {
        let top = scratch("recover");
        let dir = top.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();

        let (base, files) = list(&dir, Base::NotGit);
        assert!(
            matches!(&base, Some(Base::Commit { sha }) if valid_sha(sha)),
            "{base:?}"
        );
        assert_eq!(
            files
                .iter()
                .map(|c| (c.path.as_str(), c.status.as_str()))
                .collect::<Vec<_>>(),
            [("a.txt", "M")]
        );
        let request = Request::DiffFile {
            session: "s".into(),
            path: "a.txt".into(),
            scope: Scope::Session,
        };
        match run(dir.clone(), Some(Base::NotGit), request).unwrap() {
            Reply::DiffFile(p) => assert!(p.patch.unwrap().contains("+changed"), "patch"),
            other => panic!("not a patch reply: {other:?}"),
        }
        std::fs::remove_dir_all(top).unwrap();
    }

    /// Ticket 373 threat: a checkout on the default branch reads `is_default`, so the Diff button is disabled
    /// there; a worktree branch reads its upstream counts, the default-branch delta and a dirty tree.
    #[test]
    fn diff_git_facts_mark_the_default_branch_and_count_a_branch() {
        let top = scratch("facts");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "init"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "main"]);
        git_in(&dir, &["remote", "set-head", "origin", "main"]);

        let on_main = facts(&dir).unwrap();
        assert_eq!(on_main.branch.as_deref(), Some("main"));
        assert!(on_main.is_default && on_main.has_remote && on_main.upstream && !on_main.dirty);

        git_in(&dir, &["checkout", "-q", "-b", "fix"]);
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "b"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "fix"]);
        std::fs::write(dir.join("c.txt"), "c\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "c"]);
        std::fs::write(dir.join("d.txt"), "d\n").unwrap();
        let fix = facts(&dir).unwrap();
        assert_eq!(fix.branch.as_deref(), Some("fix"));
        assert!(!fix.is_default && fix.upstream && fix.dirty);
        assert_eq!(
            (fix.ahead, fix.behind, fix.ahead_of_default),
            (1, 0, Some(2))
        );

        // With origin's HEAD unknown, a branch named main still counts as the default.
        git_in(&dir, &["checkout", "-q", "main"]);
        git_in(&dir, &["remote", "set-head", "origin", "-d"]);
        assert!(facts(&dir).unwrap().is_default);
        // Detached HEAD has no branch; a repository with no remote says so.
        git_in(&dir, &["checkout", "-q", "--detach"]);
        git_in(&dir, &["remote", "remove", "origin"]);
        let loose = facts(&dir).unwrap();
        assert!(
            loose.branch.is_none() && !loose.is_default && !loose.has_remote && !loose.upstream
        );
        std::fs::remove_dir_all(top).unwrap();
    }

    /// Round 2: every name that may be the default is guarded: a stale origin HEAD still leaves main guarded,
    /// init.defaultBranch counts, and with origin's HEAD unknown so do the common names origin has.
    #[test]
    fn diff_git_facts_guard_every_default_name() {
        let top = scratch("defaults");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        for b in ["main", "next", "develop", "feature"] {
            git_in(
                &dir,
                &["push", "-q", "origin", &format!("HEAD:refs/heads/{b}")],
            );
        }
        git_in(&dir, &["fetch", "-q", "origin"]);
        let on = |branch: &str| {
            git_in(&dir, &["checkout", "-q", "-B", branch]);
            facts(&dir).unwrap().is_default
        };

        // A stale origin HEAD after a rename (main to next): main is still guarded, next too, a feature is not.
        git_in(&dir, &["remote", "set-head", "origin", "next"]);
        assert!(on("main") && on("next") && !on("feature"));
        // origin's HEAD known: develop is an ordinary branch.
        assert!(!on("develop"));

        // origin's HEAD unknown: the common names origin has are guarded.
        git_in(&dir, &["remote", "set-head", "origin", "-d"]);
        assert!(on("develop") && !on("feature"));

        // init.defaultBranch counts, with or without origin's HEAD.
        git_in(&dir, &["config", "init.defaultBranch", "feature"]);
        assert!(on("feature"));
        git_in(&dir, &["remote", "set-head", "origin", "main"]);
        assert!(on("feature") && !on("develop"));
        std::fs::remove_dir_all(top).unwrap();
    }

    /// Round 3: the guard holds against a tag named like the default branch (`--short` would print `heads/main`), a
    /// branch whose upstream is the default branch (a push would land there), and a default name in other case.
    #[test]
    fn diff_git_facts_guard_holds_against_tags_upstreams_and_case() {
        let top = scratch("guard3");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "main"]);
        git_in(&dir, &["remote", "set-head", "origin", "main"]);

        // A tag `main` (tags come with every fetch) leaves the branch the default.
        git_in(&dir, &["tag", "main"]);
        let tagged = facts(&dir).unwrap();
        assert_eq!(tagged.branch.as_deref(), Some("main"));
        assert!(tagged.is_default, "a tag named main switched the guard off");

        // A branch made from origin's default tracks it: a plain push would land on main.
        git_in(&dir, &["checkout", "-q", "-b", "fix", "origin/main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "fix"]);
        assert!(
            facts(&dir).unwrap().is_default,
            "upstream origin/main not guarded"
        );
        // The same branch with no upstream is an ordinary branch.
        git_in(&dir, &["branch", "-q", "--unset-upstream"]);
        assert!(!facts(&dir).unwrap().is_default);

        // A default name in other case (a case-insensitive disk resolves `Master` to master).
        git_in(&dir, &["checkout", "-q", "-b", "Master"]);
        assert!(facts(&dir).unwrap().is_default, "Master not guarded");
        std::fs::remove_dir_all(top).unwrap();
    }

    /// Ticket 403 round 2 (review R1): a change whose status passes 64 KiB still has facts, and reads as dirty.
    #[test]
    fn diff_git_facts_survive_a_large_change() {
        let dir = scratch("large-change");
        git_in(&dir, &["init", "-q", "-b", "main"]);
        let name = |i: usize| format!("{i:04}-{}.txt", "n".repeat(100));
        for i in 0..600 {
            std::fs::write(dir.join(name(i)), "a\n").unwrap();
        }
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "files"]);
        for i in 0..600 {
            std::fs::write(dir.join(name(i)), "b\n").unwrap();
        }
        let f = facts(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        let f = f.expect("no facts on a large change");
        assert!(f.dirty && f.branch.as_deref() == Some("main"), "{f:?}");
    }

    /// Ticket 403 item 16b: more than 64 KiB of `remote.*.url` lines before the branch's short merge value: the config
    /// read is too long to read whole, so the upstream is unknown and no push is offered (it read as no upstream).
    #[test]
    fn diff_git_facts_treat_a_cut_config_as_unknown() {
        let top = scratch("cut-config");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "main"]);
        git_in(&dir, &["checkout", "-q", "-B", "x7", "main"]);
        let mut config = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        for i in 0..2000 {
            config.push_str(&format!(
                "[remote \"p{i}\"]\n\turl = https://example.invalid/{i:040}\n"
            ));
        }
        config.push_str("[branch \"x7\"]\n\tremote = origin\n\tmerge = main\n");
        std::fs::write(dir.join(".git/config"), config).unwrap();
        let f = facts(&dir);
        std::fs::remove_dir_all(top).unwrap();
        assert!(f.unwrap().upstream_unknown, "a cut config offered a push");
    }

    /// Ticket 393: the upstream is matched as an exact ref: `feat/main`, `Main-x` and `mainline` push freely, a
    /// default name on any remote (or `remote = .`) is guarded, and an upstream that cannot be mapped is refused.
    #[test]
    fn diff_git_facts_read_the_upstream_as_an_exact_ref() {
        let top = scratch("upstream");
        git_in(&top, &["init", "-q", "--bare", "-b", "main", "origin"]);
        git_in(&top, &["clone", "-q", "origin", "work"]);
        let dir = top.join("work");
        git_in(&dir, &["checkout", "-q", "-B", "main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git_in(&dir, &["push", "-q", "-u", "origin", "main"]);
        git_in(&dir, &["remote", "set-head", "origin", "main"]);
        git_in(&dir, &["remote", "add", "fork", "../origin"]);
        for b in ["feat/main", "Main-x", "mainline"] {
            git_in(
                &dir,
                &["push", "-q", "origin", &format!("HEAD:refs/heads/{b}")],
            );
        }
        git_in(&dir, &["fetch", "-q", "fork"]);
        // (branch, remote, merge, guarded)
        let rows = [
            ("feat/main", "origin", "refs/heads/feat/main", false),
            ("x1", "origin", "refs/heads/Main-x", false),
            ("x2", "origin", "refs/heads/mainline", false),
            ("x3", "fork", "refs/heads/main", true),
            ("x4", ".", "refs/heads/main", true),
            ("x5", ".", "refs/heads/MAIN", true),
        ];
        for (branch, remote, merge, guarded) in rows {
            git_in(&dir, &["checkout", "-q", "-B", branch, "main"]);
            git_in(
                &dir,
                &["config", &format!("branch.{branch}.remote"), remote],
            );
            git_in(&dir, &["config", &format!("branch.{branch}.merge"), merge]);
            let f = facts(&dir).unwrap();
            assert_eq!(f.is_default, guarded, "{branch} -> {remote} {merge}");
        }
        // A pruned remote-tracking ref still names where a push lands: main is guarded, a feature is not.
        git_in(&dir, &["checkout", "-q", "-B", "x6", "main"]);
        git_in(&dir, &["config", "branch.x6.remote", "origin"]);
        git_in(&dir, &["config", "branch.x6.merge", "refs/heads/main"]);
        git_in(&dir, &["update-ref", "-d", "refs/remotes/origin/main"]);
        assert!(facts(&dir).unwrap().is_default, "pruned origin/main");
        git_in(&dir, &["config", "branch.x6.merge", "refs/heads/gone"]);
        assert!(!facts(&dir).unwrap().is_default, "pruned feature");
        // A merge ref no fetch refspec maps (or a URL remote): where a push lands is unknown, so no push is offered;
        // the facts still come back, so a commit of the changes still is.
        git_in(&dir, &["config", "branch.x6.merge", "refs/heads/main"]);
        git_in(&dir, &["config", "branch.x6.remote", "file:///nowhere"]);
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();
        let unmapped = facts(&dir).expect("facts of a changed tree");
        assert!(unmapped.upstream_unknown, "unmapped upstream was offered");
        assert!(unmapped.dirty && !unmapped.is_default, "{unmapped:?}");
        // A short merge value (`main`, not `refs/heads/main`) that a fetch refspec maps: git reports `main` as the
        // remote ref, which is not an exact ref, so it reads as unknown too.
        git_in(&dir, &["config", "branch.x6.remote", "origin"]);
        git_in(&dir, &["config", "branch.x6.merge", "main"]);
        git_in(
            &dir,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "main:refs/remotes/origin/main",
            ],
        );
        assert!(
            facts(&dir).unwrap().upstream_unknown,
            "short merge value was offered"
        );
        std::fs::remove_dir_all(top).unwrap();
    }

    /// Round 5: `diff_list` reads the git facts only when asked (the Diff dock); every other list skips them.
    #[test]
    fn diff_list_reads_git_facts_only_when_asked() {
        let top = scratch("asked");
        let dir = top.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q", "-b", "main"]);
        git_in(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let sha = lossy(&git(&dir, &["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string();
        let facts_of = |asked: bool| {
            let request = Request::DiffList {
                session: "s".into(),
                scope: Scope::Session,
                git: asked,
                fresh: false,
            };
            match run(
                dir.clone(),
                Some(Base::Commit { sha: sha.clone() }),
                request,
            )
            .unwrap()
            {
                Reply::Diff { git, .. } => git,
                other => panic!("not a diff reply: {other:?}"),
            }
        };
        assert_eq!(facts_of(false), None);
        let asked = facts_of(true).expect("asked for facts");
        assert_eq!(asked.branch.as_deref(), Some("main"));
        assert!(asked.is_default && !asked.dirty);
        std::fs::remove_dir_all(top).unwrap();
    }

    /// The retry never turns a folder that is not under version control into a repo.
    #[test]
    fn diff_not_git_stays_for_plain_folder() {
        // The system temp dir sits in no repository; it is only read, nothing is created there.
        let plain = std::env::temp_dir();
        assert!(git(&plain, &["rev-parse", "--is-inside-work-tree"]).is_err());
        // A folder inside a repo that ignores it (under `.scratch/`, itself ignored by this repo).
        let top = scratch("plain");
        let repo = top.join("repo");
        let ignored = repo.join("build");
        std::fs::create_dir_all(&ignored).unwrap();
        git_in(&repo, &["init", "-q"]);
        std::fs::write(repo.join(".gitignore"), "build/\n").unwrap();
        git_in(&repo, &["add", "-A"]);
        git_in(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::write(ignored.join("out.txt"), "x\n").unwrap();

        for dir in [&plain, &ignored] {
            let (base, files) = list(dir, Base::NotGit);
            assert_eq!(base, Some(Base::NotGit), "{}", dir.display());
            assert!(files.is_empty(), "{files:?}");
        }
        std::fs::remove_dir_all(top).unwrap();
    }
}
