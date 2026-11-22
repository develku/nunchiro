//! V2.5-8/9 (needs 132): the PR view (summary, timeline, changed code, reviewers, labels), the PR list sorted by the
//! window, and merge behind the window's confirm step. All through the user's own `gh` (needs 82: only with live PR
//! status on, window only). Ticket 373: the app still creates no PR itself and runs no commit or push; an agent may,
//! when the person presses a button that sends it a prompt. Output is cut by `--jq` to what the view shows and parsed
//! into fixed types, so only those fields reach the window, as text.
use crate::{api::*, chat::pr::PrState, pr_live, sessions::Sessions};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

const VIEW_TIMEOUT: Duration = Duration::from_secs(15);
/// A merge waits on GitHub; `--match-head-commit` makes a late one refuse rather than merge newer commits.
const MERGE_TIMEOUT: Duration = Duration::from_secs(60);
/// Per-repository list length.
const LIST: &str = "30";
const VIEW_FIELDS: &str = "number,title,url,state,isDraft,author,body,createdAt,headRefOid,headRefName,baseRefName,reviewDecision,mergeable,additions,deletions,labels,reviewRequests,latestReviews,statusCheckRollup,commits,comments,reviews,files";
const LIST_FIELDS: &str =
    "number,title,url,isDraft,author,updatedAt,reviewDecision,mergeable,statusCheckRollup";
/// The check fields `checks` reads; StatusContext has `state`, CheckRun `status` and `conclusion`.
/// Ticket 373: a CheckRun's `name` and `detailsUrl`, a StatusContext's `context` and `targetUrl`.
const CHECKS: &str = r#"[(.statusCheckRollup // [])[]|{status:(.status // ""),conclusion:(.conclusion // ""),state:(.state // ""),name:(.name // .context // ""),url:(.detailsUrl // .targetUrl // "")}][0:100]"#;

/// One check context as `CHECKS` cuts it.
#[derive(Debug, Deserialize)]
pub struct Check {
    status: String,
    conclusion: String,
    state: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: String,
}

/// Ticket 373: one failing check, outside text: the window shows it as text and a link, and the fix prompt wraps it as
/// untrusted data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failed {
    pub name: String,
    /// An `https://` link, or empty.
    pub url: String,
}

fn failing(c: &Check) -> bool {
    [
        "FAILURE",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
    ]
    .contains(&c.conclusion.as_str())
        || ["FAILURE", "ERROR"].contains(&c.state.as_str())
}

/// Ticket 373: the failing checks by name; a name is cut to 200 characters with control characters dropped, and a link
/// that is not plain `https://` is left out.
pub fn failed(all: &[Check]) -> Vec<Failed> {
    all.iter()
        .filter(|c| failing(c))
        .map(|c| Failed {
            name: c
                .name
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect(),
            url: if c.url.starts_with("https://")
                && c.url.len() <= 2000
                && !c.url.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                c.url.clone()
            } else {
                String::new()
            },
        })
        .collect()
}

/// The checks rolled up: `fail` beats `pending` beats `pass`; `none` when the PR has no checks.
pub fn checks(all: &[Check]) -> &'static str {
    let fail = failing;
    let pending = |c: &Check| {
        (!c.status.is_empty() && c.status != "COMPLETED")
            || ["PENDING", "EXPECTED"].contains(&c.state.as_str())
    };
    if all.is_empty() {
        "none"
    } else if all.iter().any(fail) {
        "fail"
    } else if all.iter().any(pending) {
        "pending"
    } else {
        "pass"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reviewer {
    pub who: String,
    /// `requested`, or the review state (APPROVED, CHANGES_REQUESTED, COMMENTED, ...).
    pub state: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub at: String,
    /// `commit`, `review` or `comment`.
    pub kind: String,
    pub who: String,
    /// For a review its state.
    #[serde(default)]
    pub state: String,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

/// What the PR view shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub url: String,
    pub number: u64,
    pub title: String,
    /// OPEN, CLOSED or MERGED.
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// The head commit the confirm step names; a merge carries it back.
    pub head: String,
    pub head_ref: String,
    pub base_ref: String,
    pub review: String,
    pub mergeable: String,
    pub checks: String,
    /// Ticket 373: the failing checks, in gh's order.
    pub failed: Vec<Failed>,
    /// Ticket 373: whether merge may be offered: a PR only the by-branch lookup found gets no Merge.
    #[serde(default)]
    pub merge: bool,
    pub additions: u64,
    pub deletions: u64,
    pub labels: Vec<String>,
    pub reviewers: Vec<Reviewer>,
    /// Oldest first.
    pub timeline: Vec<Event>,
    pub files: Vec<File>,
    /// `gh pr diff`, cut at the core's output cap (`diff_cut`).
    pub diff: String,
    pub diff_cut: bool,
}

/// One row of the PR list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub draft: bool,
    pub author: String,
    pub updated_at: String,
    pub review: String,
    pub mergeable: String,
    pub checks: String,
}

pub fn head_ok(head: &str) -> bool {
    head.len() == 40 && head.bytes().all(|b| b.is_ascii_hexdigit())
}

fn view_jq() -> String {
    format!(
        r#"{{number,title,url,state,isDraft,author:(.author.login // ""),body:((.body // "")[0:8000]),createdAt,headRefOid,headRefName,baseRefName,reviewDecision:(.reviewDecision // ""),mergeable:(.mergeable // ""),additions,deletions,labels:[(.labels // [])[].name][0:30],requested:[(.reviewRequests // [])[]|(.login // .name // "")][0:30],latest:[(.latestReviews // [])[]|{{who:(.author.login // ""),state}}][0:30],checks:{CHECKS},commits:[(.commits // [])[]|{{at:(.committedDate // ""),who:(.authors[0].login // .authors[0].name // ""),text:(.messageHeadline // "")}}][-50:],comments:[(.comments // [])[]|{{at:(.createdAt // ""),who:(.author.login // ""),text:((.body // "")[0:1000])}}][-20:],reviews:[(.reviews // [])[]|{{at:(.submittedAt // ""),who:(.author.login // ""),state,text:((.body // "")[0:1000])}}][-20:],files:[(.files // [])[]|{{path,additions,deletions}}][0:200]}}"#
    )
}

pub fn view_argv(url: &str) -> Vec<String> {
    ["pr", "view", url, "--json", VIEW_FIELDS, "--jq", &view_jq()]
        .map(String::from)
        .to_vec()
}
pub fn diff_argv(url: &str) -> Vec<String> {
    ["pr", "diff", url, "--color", "never"]
        .map(String::from)
        .to_vec()
}
pub fn list_argv(owner: &str, repo: &str) -> Vec<String> {
    let jq = format!(
        r#"[.[]|{{number,title,url,isDraft,author:(.author.login // ""),updatedAt,reviewDecision:(.reviewDecision // ""),mergeable:(.mergeable // ""),checks:{}}}]"#,
        CHECKS
    );
    [
        "pr",
        "list",
        "--repo",
        &format!("{owner}/{repo}"),
        "--state",
        "open",
        "--limit",
        LIST,
        "--json",
        LIST_FIELDS,
        "--jq",
        &jq,
    ]
    .map(String::from)
    .to_vec()
}
/// `method` is merge, squash or rebase; `head` the commit the confirm step showed.
pub fn merge_argv(url: &str, method: &str, head: &str) -> Vec<String> {
    [
        "pr",
        "merge",
        url,
        &format!("--{method}"),
        "--match-head-commit",
        head,
    ]
    .map(String::from)
    .to_vec()
}

/// G34 (ticket 270): the core `features` key that turns the agent-credit strip on (off by default).
pub const STRIP_CREDITS: &str = "pr.strip_agent_credits";
/// The exact addresses agents sign with; a person at the same company, or with a similar name, is never matched.
const AGENT_ADDRESSES: [&str; 3] = [
    "noreply@anthropic.com",
    "codex@openai.com",
    "noreply@openai.com",
];

/// G34: the text GitHub would write for a squash of this PR (it follows the repository's squash-message setting), the
/// field gh's own merge command reads. It comes whole: no commit list, so no 100-commit or length cut.
fn squash_text_argv(pull: &pr_live::Pull) -> Vec<String> {
    const QUERY: &str = "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){viewerMergeBodyText(mergeType:SQUASH)}}}";
    vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        QUERY.to_string(),
        "-f".to_string(),
        format!("owner={}", pull.owner),
        "-f".to_string(),
        format!("repo={}", pull.repo),
        "-F".to_string(),
        format!("number={}", pull.number),
    ]
}

/// G34: the text from `squash_text_argv`'s stdout. Output too long to read whole is an error: the merge stops, nothing is cut.
fn parse_squash_text(stdout: &[u8]) -> Result<String, String> {
    too_big(stdout)?;
    serde_json::from_slice::<serde_json::Value>(stdout)
        .ok()
        .and_then(|v| {
            v.pointer("/data/repository/pullRequest/viewerMergeBodyText")?
                .as_str()
                .map(String::from)
        })
        .ok_or_else(|| "gh gave no squash message for this PR".to_string())
}

/// G34: a `Co-Authored-By:` trailer with an agent's address. Any other line, other co-authors included, is not one.
fn agent_credit(line: &str) -> bool {
    let l = line.trim();
    let Some(prefix) = l.get(..15) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("co-authored-by:") {
        return false;
    }
    let rest = l[15..].trim();
    let addr = match (rest.rfind('<'), rest.ends_with('>')) {
        (Some(i), true) => rest[i + 1..rest.len() - 1].trim().to_ascii_lowercase(),
        _ => return false,
    };
    AGENT_ADDRESSES.contains(&addr.as_str())
}

/// G34: `text` without its agent credit lines, every other line byte for byte; trailing blank lines left behind go too.
/// `None` when there was nothing to remove, so GitHub writes its own message.
pub fn strip_credits(text: &str) -> Option<String> {
    let kept: Vec<&str> = text
        .split_inclusive('\n')
        .filter(|l| !agent_credit(l))
        .collect();
    (kept.len() != text.split_inclusive('\n').count()).then(|| kept.concat().trim_end().to_string())
}

/// G34: `merge_argv`, plus the body as one `--body=` argument when there is one (so a body starting with `-` stays a
/// value). `None` is byte-identical to `merge_argv`.
pub fn merge_argv_with(url: &str, method: &str, head: &str, body: Option<&str>) -> Vec<String> {
    let mut argv = merge_argv(url, method, head);
    if let Some(body) = body {
        argv.push(format!("--body={body}"));
    }
    argv
}

/// G34: whether a merge may carry a rewritten body: only a squash with the setting on. A merge commit's body is empty by
/// default and rebase replays the commits; in both the commits keep their own lines.
pub fn wants_body(method: &str, on: bool) -> bool {
    on && method == "squash"
}

/// G34: the stored setting, read through the owner's settings read (an empty patch writes nothing).
fn strip_on(registry: &Mutex<Sessions>) -> Result<bool, String> {
    let reply = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .handle(Request::QuitSettings {
            patch: LifetimePatch::default(),
        })?;
    Ok(match reply {
        Reply::QuitSettings { settings } => settings
            .features
            .get(STRIP_CREDITS)
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        _ => false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawView {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    author: String,
    body: String,
    created_at: String,
    head_ref_oid: String,
    head_ref_name: String,
    base_ref_name: String,
    review_decision: String,
    mergeable: String,
    additions: u64,
    deletions: u64,
    labels: Vec<String>,
    requested: Vec<String>,
    latest: Vec<Reviewer>,
    checks: Vec<Check>,
    commits: Vec<RawEvent>,
    comments: Vec<RawEvent>,
    reviews: Vec<RawEvent>,
    files: Vec<File>,
}
#[derive(Deserialize)]
struct RawEvent {
    at: String,
    who: String,
    #[serde(default)]
    state: String,
    text: String,
}

fn too_big(stdout: &[u8]) -> Result<(), String> {
    if stdout.len() >= crate::process::OUTPUT_CAP {
        return Err("gh output too large".into());
    }
    Ok(())
}

/// The view from `view_argv`'s stdout for `url`, and `gh pr diff`'s; a PR that is not `url`, an unknown state or a
/// bad head commit is an error.
pub fn parse_view(url: &str, stdout: &[u8], diff: &[u8]) -> Result<View, String> {
    too_big(stdout)?;
    let r: RawView = serde_json::from_slice(stdout).map_err(|_| "gh output is not a PR")?;
    if !r.url.eq_ignore_ascii_case(url) || !["OPEN", "CLOSED", "MERGED"].contains(&r.state.as_str())
    {
        return Err("gh answered for another PR".into());
    }
    if !head_ok(&r.head_ref_oid) {
        return Err("gh gave no head commit".into());
    }
    let ev = |kind: &'static str, v: Vec<RawEvent>| {
        v.into_iter().map(move |e| Event {
            at: e.at,
            kind: kind.to_string(),
            who: e.who,
            state: e.state,
            text: e.text,
        })
    };
    let mut timeline: Vec<Event> = ev("commit", r.commits)
        .chain(ev("review", r.reviews))
        .chain(ev("comment", r.comments))
        .collect();
    // ISO 8601 times in UTC sort as text.
    timeline.sort_by(|a, b| a.at.cmp(&b.at));
    let mut reviewers = r.latest;
    for who in r.requested.into_iter().filter(|w| !w.is_empty()) {
        if !reviewers.iter().any(|x| x.who == who) {
            reviewers.push(Reviewer {
                who,
                state: "requested".into(),
            });
        }
    }
    let diff_cut = diff.len() >= crate::process::OUTPUT_CAP;
    Ok(View {
        url: url.into(),
        number: r.number,
        title: r.title,
        state: r.state,
        draft: r.is_draft,
        author: r.author,
        body: r.body,
        created_at: r.created_at,
        head: r.head_ref_oid,
        head_ref: r.head_ref_name,
        base_ref: r.base_ref_name,
        review: r.review_decision,
        mergeable: r.mergeable,
        checks: checks(&r.checks).into(),
        failed: failed(&r.checks),
        merge: false,
        additions: r.additions,
        deletions: r.deletions,
        labels: r.labels,
        reviewers,
        timeline,
        files: r.files,
        diff: String::from_utf8_lossy(diff).into_owned(),
        diff_cut,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawItem {
    number: u64,
    title: String,
    url: String,
    is_draft: bool,
    author: String,
    updated_at: String,
    review_decision: String,
    mergeable: String,
    checks: Vec<Check>,
}

/// The rows from `list_argv(owner, repo)`'s stdout; a row whose link is not a pull of that repository is dropped.
pub fn parse_list(owner: &str, repo: &str, stdout: &[u8]) -> Result<Vec<Item>, String> {
    too_big(stdout)?;
    let rows: Vec<RawItem> =
        serde_json::from_slice(stdout).map_err(|_| "gh output is not a PR list")?;
    Ok(rows
        .into_iter()
        .filter(|r| {
            pr_live::clean_url(&r.url).is_some_and(|u| {
                u.eq_ignore_ascii_case(&format!(
                    "https://github.com/{owner}/{repo}/pull/{}",
                    r.number
                ))
            })
        })
        .map(|r| Item {
            repo: format!("{owner}/{repo}"),
            number: r.number,
            title: r.title,
            url: r.url,
            draft: r.is_draft,
            author: r.author,
            updated_at: r.updated_at,
            review: r.review_decision,
            mergeable: r.mergeable,
            checks: checks(&r.checks).into(),
        })
        .collect())
}

/// Ticket 373: the PR of a worktree's own branch, whoever opened it (an agent, or the person on GitHub).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchPr {
    pub url: String,
    pub number: u64,
    /// In the order tier 1 reads a PR (`pr_live::parse`).
    pub state: PrState,
    pub failed: Vec<Failed>,
}

/// Where a worktree's branch is pushed: the GitHub repository of its upstream remote and the branch name there.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Pushed {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

const BRANCH_FIELDS: &str = "number,url,state,isDraft,reviewDecision,headRefName,headRepository,headRepositoryOwner,statusCheckRollup";
/// The worktree list asks every 30 s and the status bar too: one gh run per branch serves both.
pub const BRANCH_FRESH: Duration = Duration::from_secs(25);
const GIT: Duration = Duration::from_secs(10);
/// shortcut: the cache is emptied when it holds this many branches; a per-entry age-out if worktrees ever go past it.
const BRANCH_CACHE: usize = 200;

/// `owner/repo` of a github.com remote: `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` or
/// `ssh://git@github.com/o/r(.git)`; any other host is `None`.
pub fn github_repo(remote: &str) -> Option<(String, String)> {
    let rest = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    (pr_live::piece(owner) && pr_live::piece(repo)).then(|| (owner.into(), repo.into()))
}

/// The worktree's branch as pushed, or `None` when there is nothing to look up: a detached HEAD, no upstream (or a
/// local one), a remote that is not GitHub, or the remote's default branch.
pub fn pushed(dir: &Path) -> Option<Pushed> {
    let git = |args: &[&str]| {
        crate::process::git_read(dir, args, GIT)
            .ok()
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let local = git(&["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let remote = git(&["config", "--get", &format!("branch.{local}.remote")])?;
    let merge = git(&["config", "--get", &format!("branch.{local}.merge")])?;
    let branch = merge.strip_prefix("refs/heads/")?.to_string();
    if remote == "." || remote.starts_with('-') {
        return None;
    }
    let default = git(&[
        "symbolic-ref",
        "--quiet",
        "--short",
        &format!("refs/remotes/{remote}/HEAD"),
    ])
    .and_then(|d| d.strip_prefix(&format!("{remote}/")).map(String::from));
    let is_default = match default {
        Some(d) => d == branch || d == local,
        // No remote HEAD recorded: the usual default names count as default.
        None => ["main", "master"].contains(&branch.as_str()),
    };
    if is_default {
        return None;
    }
    let (owner, repo) = github_repo(&git(&["remote", "get-url", "--", &remote])?)?;
    Some(Pushed {
        owner,
        repo,
        branch,
    })
}

pub fn branch_argv(branch: &str) -> Vec<String> {
    let jq = format!(
        r#"{{number,url,state,isDraft,reviewDecision:(.reviewDecision // ""),headRefName,headOwner:(.headRepositoryOwner.login // ""),headRepo:(.headRepository.name // ""),checks:{CHECKS}}}"#
    );
    [
        "pr",
        "view",
        "--json",
        BRANCH_FIELDS,
        "--jq",
        &jq,
        "--",
        branch,
    ]
    .map(String::from)
    .to_vec()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBranch {
    number: u64,
    url: String,
    state: String,
    is_draft: bool,
    review_decision: String,
    head_ref_name: String,
    head_owner: String,
    head_repo: String,
    checks: Vec<Check>,
}

/// `branch_argv`'s stdout for `at`: `None` unless the PR's head is that very branch of that very repository, so a fork's
/// PR from a branch of the same name is never this worktree's.
pub fn parse_branch(at: &Pushed, stdout: &[u8]) -> Result<Option<BranchPr>, String> {
    too_big(stdout)?;
    let r: RawBranch = serde_json::from_slice(stdout).map_err(|_| "gh output is not a PR")?;
    let same_head = r.head_owner.eq_ignore_ascii_case(&at.owner)
        && r.head_repo.eq_ignore_ascii_case(&at.repo)
        && r.head_ref_name == at.branch;
    let Some(url) = pr_live::clean_url(&r.url).filter(|u| u.eq_ignore_ascii_case(&r.url)) else {
        return Ok(None);
    };
    if !same_head || !url.ends_with(&format!("/pull/{}", r.number)) {
        return Ok(None);
    }
    let rolled = checks(&r.checks);
    let state = match r.state.as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        "OPEN" if r.is_draft => PrState::Draft,
        "OPEN" if r.review_decision == "APPROVED" => PrState::Approved,
        "OPEN" if rolled == "fail" => PrState::ChecksFail,
        "OPEN" if rolled == "pass" => PrState::ChecksPass,
        "OPEN" => PrState::Open,
        _ => return Ok(None),
    };
    Ok(Some(BranchPr {
        url,
        number: r.number,
        state,
        failed: failed(&r.checks),
    }))
}

type BranchCache = HashMap<(PathBuf, Pushed), (Instant, Option<BranchPr>)>;
static BRANCHES: LazyLock<Mutex<BranchCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ticket 463: each folder's last `pushed` answer, with the folder's stamp read before git ran.
type PushedCache = HashMap<PathBuf, (Instant, u64, Option<Pushed>)>;
static PUSHED: LazyLock<Mutex<PushedCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ticket 463: the status bar asks for its branch PR once a minute; `pushed` (up to five git reads) runs again only
/// after the folder's stamp changed (a branch switch, a config or ref change) or `diff::FALLBACK` passed.
fn pushed_kept(dir: &Path) -> Option<Pushed> {
    let stamp = crate::diff::stamp::stamp(dir, []);
    if let (Some(now), Ok(cache)) = (stamp, PUSHED.lock())
        && let Some((at, kept, pushed)) = cache.get(dir)
        && *kept == now
        && at.elapsed() < crate::diff::fallback()
    {
        return pushed.clone();
    }
    let found = pushed(dir);
    if let (Some(stamp), Ok(mut cache)) = (stamp, PUSHED.lock()) {
        if cache.len() >= BRANCH_CACHE {
            cache.clear();
        }
        cache.insert(dir.to_path_buf(), (Instant::now(), stamp, found.clone()));
    }
    found
}

/// The by-branch lookup: `gh pr view <branch>` in the worktree folder, at most once per `BRANCH_FRESH` per branch. No PR
/// is an answer, not an error. A found PR joins the known ones, so the PR view and merge accept it (`known`).
fn branch_pr(dir: &Path) -> Result<Option<BranchPr>, String> {
    let Some(at) = pushed_kept(dir) else {
        return Ok(None);
    };
    let key = (dir.to_path_buf(), at.clone());
    if let Some((when, pr)) = BRANCHES.lock().map_err(|_| "cache unavailable")?.get(&key)
        && when.elapsed() < BRANCH_FRESH
    {
        return Ok(pr.clone());
    }
    let pr = match pr_live::run_gh_in(Some(dir), &branch_argv(&at.branch), VIEW_TIMEOUT) {
        Ok(out) => parse_branch(&at, &out)?,
        Err(e) if e.contains("no pull requests found") => None,
        Err(e) => return Err(e),
    };
    if let Some(pr) = &pr {
        pr_live::note_found(&pr.url);
    }
    let mut cache = BRANCHES.lock().map_err(|_| "cache unavailable")?;
    if cache.len() >= BRANCH_CACHE {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), pr.clone()));
    Ok(pr)
}

/// needs 82: outside traffic only with live PR status on.
fn on(registry: &Mutex<Sessions>) -> Result<(), String> {
    let (on, _, pinned) = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .pr_live(None, None, None)?;
    pr_live::sync_pins(on, &pinned);
    if on {
        Ok(())
    } else {
        Err("off: the PR view uses your gh; turn on live PR status first".into())
    }
}

/// needs 82: only repositories of PRs an agent created or the owner pinned; `found`, also those of PRs the by-branch
/// lookup found (ticket 373: viewed, never merged).
fn known(url: &str, found: bool) -> Result<(), String> {
    if pr_live::known_repo(url) || found && pr_live::shown_repo(url) {
        Ok(())
    } else {
        Err("not a repository of a PR an agent created or you watch".into())
    }
}

/// The window's `pr_view`, `pr_list`, `pr_merge` and `pr_branch` (window only, see `sessions.rs`); runs `gh`, so off the frame loop.
pub(crate) fn answer(registry: &Mutex<Sessions>, request: Request) -> Response {
    match request {
        Request::PrView { url } => {
            let url = pr_live::clean_url(&url).ok_or("not a GitHub pull request link")?;
            on(registry)?;
            known(&url, true)?;
            let out = pr_live::run_gh(&view_argv(&url), VIEW_TIMEOUT)?;
            let diff = pr_live::run_gh(&diff_argv(&url), VIEW_TIMEOUT).unwrap_or_default();
            let mut view = parse_view(&url, &out, &diff)?;
            view.merge = pr_live::mergeable(&url);
            Ok(Reply::PrView { view })
        }
        Request::PrList => {
            on(registry)?;
            let mut prs = vec![];
            let mut hint = None;
            for (owner, repo) in pr_live::known_repos() {
                match pr_live::run_gh(&list_argv(&owner, &repo), VIEW_TIMEOUT)
                    .and_then(|out| parse_list(&owner, &repo, &out))
                {
                    Ok(rows) => prs.extend(rows),
                    Err(e) => hint = Some(e),
                }
            }
            Ok(Reply::PrList { prs, hint })
        }
        Request::PrMerge { url, method, head } => {
            let url = pr_live::clean_url(&url).ok_or("not a GitHub pull request link")?;
            if !["merge", "squash", "rebase"].contains(&method.as_str()) {
                return Err("merge method must be merge, squash or rebase".into());
            }
            // The confirm step: the window sends the head commit it showed; without it nothing runs.
            if !head_ok(&head) {
                return Err("merge needs the confirmed head commit".into());
            }
            on(registry)?;
            known(&url, false)?;
            if !pr_live::mergeable(&url) {
                return Err("merge is only for a PR an agent made or you pinned".into());
            }
            let body = if wants_body(&method, strip_on(registry)?) {
                let pull = pr_live::Pull::parse(&url).ok_or("not a GitHub pull request link")?;
                let out = pr_live::run_gh(&squash_text_argv(&pull), VIEW_TIMEOUT)?;
                strip_credits(&parse_squash_text(&out)?)
            } else {
                None
            };
            pr_live::run_gh(
                &merge_argv_with(&url, &method, &head, body.as_deref()),
                MERGE_TIMEOUT,
            )?;
            Ok(Reply::PrMerged { url })
        }
        Request::PrBranch { path } => {
            let dir = PathBuf::from(&path);
            if !dir.is_absolute() || !dir.is_dir() {
                return Err("not a folder".into());
            }
            on(registry)?;
            Ok(Reply::PrBranch {
                pr: branch_pr(&dir)?,
            })
        }
        _ => Err("not a PR view op".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn c(status: &str, conclusion: &str, state: &str) -> Check {
        Check {
            status: status.into(),
            conclusion: conclusion.into(),
            state: state.into(),
            name: String::new(),
            url: String::new(),
        }
    }
    #[test]
    fn checks_roll_up() {
        assert_eq!(checks(&[]), "none");
        assert_eq!(
            checks(&[c("COMPLETED", "SUCCESS", ""), c("", "", "SUCCESS")]),
            "pass"
        );
        assert_eq!(
            checks(&[c("IN_PROGRESS", "", ""), c("COMPLETED", "SUCCESS", "")]),
            "pending"
        );
        assert_eq!(
            checks(&[c("IN_PROGRESS", "", ""), c("", "", "ERROR")]),
            "fail"
        );
        assert_eq!(checks(&[c("COMPLETED", "TIMED_OUT", "")]), "fail");
    }
    #[test]
    fn merge_argv_is_fixed() {
        let head = "a".repeat(40);
        assert_eq!(
            merge_argv("https://github.com/o/r/pull/1", "squash", &head),
            [
                "pr",
                "merge",
                "https://github.com/o/r/pull/1",
                "--squash",
                "--match-head-commit",
                &head
            ]
        );
        assert!(!head_ok("abc"));
        assert!(!head_ok(&"g".repeat(40)));
    }
    #[test]
    fn merge_strip_credits_removes_agent_coauthor_lines_only() {
        let text = "* one\r\n\r\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\r\nCo-authored-by: Claudette Smith <c@example.com>\nco-authored-by: Codex <codex@openai.com>\nCo-authored-by: Jane <jane@openai.com>\nThanks to Claude <noreply@anthropic.com>\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
        assert_eq!(
            strip_credits(text).unwrap(),
            "* one\r\n\r\nCo-authored-by: Claudette Smith <c@example.com>\nCo-authored-by: Jane <jane@openai.com>\nThanks to Claude <noreply@anthropic.com>"
        );
        // Nothing to strip: no body at all, so GitHub writes its own message.
        for human in [
            "",
            "plain\n",
            "Co-authored-by: Claudette Smith <c@example.com>\n",
            "Co-Authored-By: Claude",
        ] {
            assert_eq!(strip_credits(human), None, "{human}");
        }
        // Only credit lines: an empty body is sent, or GitHub would write them back.
        assert_eq!(
            strip_credits("Co-Authored-By: Claude <noreply@anthropic.com>").as_deref(),
            Some("")
        );
        // GitHub's text is read whole; a reply without it stops the merge.
        let reply = br#"{"data":{"repository":{"pullRequest":{"viewerMergeBodyText":"* one"}}}}"#;
        assert_eq!(parse_squash_text(reply).unwrap(), "* one");
        assert!(parse_squash_text(br#"{"data":{"repository":{"pullRequest":null}}}"#).is_err());
        assert!(parse_squash_text(&vec![b' '; crate::process::OUTPUT_CAP]).is_err());
        // A body starting with `-` stays one value argument.
        let head = "b".repeat(40);
        let argv = merge_argv_with(
            "https://github.com/o/r/pull/1",
            "squash",
            &head,
            Some("--admin"),
        );
        assert_eq!(argv.last().unwrap(), "--body=--admin");
        assert_eq!(argv.len(), 7);
    }
    #[test]
    fn merge_argv_unchanged_when_strip_off() {
        let head = "c".repeat(40);
        for (method, on, want) in [
            ("merge", false, false),
            ("squash", false, false),
            ("rebase", false, false),
            ("merge", true, false),
            ("squash", true, true),
            ("rebase", true, false),
        ] {
            assert_eq!(wants_body(method, on), want, "{method} on={on}");
            assert_eq!(
                merge_argv_with("https://github.com/o/r/pull/2", method, &head, None),
                merge_argv("https://github.com/o/r/pull/2", method, &head)
            );
        }
    }
    /// The `--jq` cuts against the real gh (network; run by hand: `cargo test -p nunchiro-core real_gh -- --ignored`).
    #[test]
    #[ignore]
    fn real_gh_output_parses() {
        let url = std::env::var("PR_URL").unwrap_or("https://github.com/cli/cli/pull/9000".into());
        let run = |a: Vec<String>| pr_live::run_gh(&a, VIEW_TIMEOUT).unwrap();
        let out = run(view_argv(&url));
        let diff = run(diff_argv(&url));
        let v = parse_view(&url, &out, &diff).unwrap();
        eprintln!(
            "{} {} {} files {} events {} cut {}",
            v.title,
            v.state,
            v.checks,
            v.files.len(),
            v.timeline.len(),
            v.diff_cut
        );
        let out = run(list_argv("cli", "cli"));
        let rows = parse_list("cli", "cli", &out).unwrap();
        eprintln!("list {} bytes {}", rows.len(), out.len());
        assert!(!rows.is_empty());
    }
}
