//! V2.5-61 B8 (ticket 220): the read-only `worktree` op `branches`, the New worktree dialog's existing-branch list.
//! Each test runs a real `nunchiro serve` on a short home with temp git repos in it.
#[path = "fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::{Duration, Instant, SystemTime},
};

fn git(dir: &Path, args: &[&str]) -> String {
    git_in(dir, args, None)
}
fn git_in(dir: &Path, args: &[&str], stdin: Option<&str>) -> String {
    let mut child = home::git_env::scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=f@example.invalid",
            // Ticket 1142: no detached auto-maintenance from the fixture's commit; on CI its objects/maintenance.lock
            // was still there when the "nothing was created" snapshot was taken.
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.unwrap_or("").as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}
fn repo(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "initial"]);
    dir.canonicalize().unwrap()
}

/// A file's bytes and mtime.
type FileState = (Vec<u8>, SystemTime);

struct Core {
    home: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    fn new(tag: &str) -> Self {
        let home = home::short(tag);
        let serve = home::spawn_serve(&home, &[("HOME", home.to_str().unwrap())]);
        Self {
            home,
            _serve: serve,
        }
    }
    fn raw(&self, token: &str, request: Value) -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
    fn owner_token(&self) -> String {
        fs::read_to_string(self.home.join("core.token"))
            .unwrap()
            .trim()
            .to_string()
    }
    /// A worktree request as `token`: `Ok(reply)` or `Err(message)`.
    fn wt_as(&self, token: &str, operation: &str, extra: Value) -> Result<Value, String> {
        let mut r = json!({"op":"worktree","operation":operation,"project":null,"path":null,"branch":null,"base":"HEAD","label":""});
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        let answer = self.raw(token, r);
        match (answer.get("Ok"), answer.get("Err")) {
            (Some(ok), _) => Ok(ok.clone()),
            (_, Some(Value::String(e))) => Err(e.clone()),
            _ => panic!("unexpected answer {answer}"),
        }
    }
    fn branches(&self, project: &Path) -> Result<Value, String> {
        self.wt_as(&self.owner_token(), "branches", json!({"project": project}))
    }
    /// A shell session in `project` that prints its token; the token.
    fn session_token(&self, project: &Path) -> String {
        let started = self.raw(
            &self.owner_token(),
            json!({"op":"start","folder":null,"session":{"kind":"shell","project":project,"worktree":false,
                "label":"agent","args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}}),
        );
        let id = started["Ok"]["session"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("{started}"))
            .to_string();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let out = self.raw(&self.owner_token(), json!({"op":"read","id":id,"after":0}));
            if let Some(data) = out["Ok"]["data"].as_array() {
                let bytes: Vec<u8> = data.iter().map(|b| b.as_u64().unwrap() as u8).collect();
                // The first line starts with the holder's size mark (ticket 995).
                if let Some((_, l)) = String::from_utf8_lossy(&bytes)
                    .lines()
                    .find_map(|l| l.split_once("TOKEN:"))
                {
                    return l.trim().to_string();
                }
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// What a read must leave as it was: the core's worktree store, lock and root, by bytes and mtime.
    fn store_state(&self) -> Vec<(String, Option<FileState>)> {
        ["worktrees.json", "worktrees.lock", "worktrees"]
            .iter()
            .map(|n| {
                let p = self.home.join(n);
                let state = fs::symlink_metadata(&p)
                    .ok()
                    .map(|m| (fs::read(&p).unwrap_or_default(), m.modified().unwrap()));
                (n.to_string(), state)
            })
            .collect()
    }
}
fn names(reply: &Value) -> Vec<String> {
    reply["branches"]
        .as_array()
        .unwrap_or_else(|| panic!("no branches in {reply}"))
        .iter()
        .map(|b| b["name"].as_str().unwrap().to_string())
        .collect()
}
/// Every file under `dir` with its size and mtime.
fn tree(dir: &Path) -> BTreeMap<PathBuf, (u64, SystemTime)> {
    let mut out = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let e = e.unwrap();
            let m = fs::symlink_metadata(e.path()).unwrap();
            if m.is_dir() {
                todo.push(e.path());
            }
            out.insert(e.path(), (m.len(), m.modified().unwrap()));
        }
    }
    out
}

#[test]
fn worktree_branch_list_is_capped_and_read_only() {
    let core = Core::new("wtb-cap");
    let repo = repo(&core.home.join("repo"));
    let head = git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
    // 600 refs in one transaction: 400 local, 200 remote (plus `main`).
    let mut stdin = String::new();
    for i in 0..400 {
        stdin += &format!("create refs/heads/b{i:03} {head}\n");
    }
    for i in 0..200 {
        stdin += &format!("create refs/remotes/origin/r{i:03} {head}\n");
    }
    git_in(&repo, &["update-ref", "--stdin"], Some(&stdin));
    // A hostile repo config: a program the read must never get to run.
    let marker = core.home.join("ran");
    let hook = core.home.join("hook.sh");
    fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    git(&repo, &["config", "core.fsmonitor", hook.to_str().unwrap()]);
    for name in [
        "post-checkout",
        "reference-transaction",
        "post-index-change",
    ] {
        let p = repo.join(".git/hooks").join(name);
        fs::copy(&hook, &p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let refs = || {
        git(
            &repo,
            &["for-each-ref", "--format=%(refname) %(objectname)"],
        )
    };
    let worktrees = || git(&repo, &["worktree", "list", "--porcelain"]);
    let before = (
        refs(),
        worktrees(),
        core.store_state(),
        tree(&repo.join(".git")),
    );

    let reply = core.branches(&repo).unwrap();

    let after = (
        refs(),
        worktrees(),
        core.store_state(),
        tree(&repo.join(".git")),
    );
    assert_eq!(before.0, after.0, "refs changed");
    assert_eq!(before.1, after.1, "worktrees changed");
    assert_eq!(before.2, after.2, "worktree store changed");
    assert_eq!(before.3, after.3, ".git changed");
    assert!(!marker.exists(), "a repo-config program ran");
    assert_eq!(reply["type"], "worktrees", "{reply}");
    assert_eq!(reply["worktrees"], json!([]));
    assert_eq!(reply["branches_truncated"], true);
    let list = reply["branches"].as_array().unwrap();
    assert_eq!(list.len(), 500);
    // Local first (sorted: `b000`..`b399`, then `main`), then remote (`origin/r000`..`origin/r098`).
    assert_eq!(
        list[0],
        json!({"name":"b000","branch":"b000","remote":false,"in_worktree":false})
    );
    assert_eq!(
        list[400],
        json!({"name":"main","branch":"main","remote":false,"in_worktree":true})
    );
    assert_eq!(
        list[401],
        json!({"name":"origin/r000","branch":"r000","remote":true,"in_worktree":false})
    );
    assert_eq!(list[499]["name"], "origin/r098");
    assert!(list[..401].iter().all(|b| b["remote"] == false));
    assert!(list[401..].iter().all(|b| b["remote"] == true));
}

#[test]
fn worktree_branches_refuses_outside_a_repo() {
    let core = Core::new("wtb-out");
    let repo = repo(&core.home.join("repo"));
    let sub = repo.join("sub");
    fs::create_dir_all(&sub).unwrap();
    let plain = core.home.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let before = (core.store_state(), tree(&repo), tree(&plain));
    // The control: the repo's top level is read.
    assert_eq!(names(&core.branches(&repo).unwrap()), ["main"]);
    for project in [plain.clone(), sub.clone(), core.home.join("missing")] {
        let refused = core.branches(&project);
        assert!(refused.is_err(), "{project:?} read: {refused:?}");
    }
    let owner = core.owner_token();
    let agent = core.session_token(&repo);
    let loss = json!({"uncommitted":[],"unpushed":[],"uncommitted_total":0,"unpushed_total":0,"kept_on":null,
        "ignored":[],"ignored_total":0});
    // The owner and a session caller in its own project alike.
    for token in [&owner, &agent] {
        assert_eq!(
            names(
                &core
                    .wt_as(token, "branches", json!({"project": repo}))
                    .unwrap()
            ),
            ["main"]
        );
        for extra in [
            json!({"path": repo}),
            json!({"branch": "main"}),
            json!({"from": "main"}),
            json!({"label": "x"}),
            json!({"base": "main"}),
            json!({"confirm": loss}),
        ] {
            let mut request = extra.clone();
            request["project"] = json!(repo);
            let refused = core.wt_as(token, "branches", request);
            assert!(refused.is_err(), "{extra} accepted: {refused:?}");
        }
    }
    assert!(
        core.wt_as(&owner, "branches", json!({})).is_err(),
        "owner without a project"
    );
    assert_eq!(
        before,
        (core.store_state(), tree(&repo), tree(&plain)),
        "something was created"
    );
}

#[test]
fn worktree_branches_drop_option_and_hidden_names() {
    let core = Core::new("wtb-drop");
    let repo = repo(&core.home.join("repo"));
    let head = git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
    let long = format!("{}/{}", "x".repeat(200), "y".repeat(100));
    for name in [
        "bi\u{202e}di",
        "zw\u{200b}sp",
        "-x",
        "기능-브랜치",
        long.as_str(),
    ] {
        git(&repo, &["update-ref", &format!("refs/heads/{name}"), &head]);
    }
    // A remote ref's branch is its name after the remote, even when the remote's own name has a `/`.
    git(
        &repo,
        &["remote", "add", "origin", "https://example.invalid/o"],
    );
    git(
        &repo,
        &["remote", "add", "team/up", "https://example.invalid/t"],
    );
    git(&repo, &["update-ref", "refs/remotes/origin/feat", &head]);
    git(&repo, &["update-ref", "refs/remotes/team/up/fix/a", &head]);
    // git refuses to make a control-character ref; a hand-written loose one is what a hostile repo could carry.
    fs::write(repo.join(".git/refs/heads/ct\u{1}rl"), format!("{head}\n")).unwrap();
    let reply = core.branches(&repo).unwrap();
    assert_eq!(
        names(&reply),
        ["main", "기능-브랜치", "origin/feat", "team/up/fix/a"],
        "{reply}"
    );
    let branch_of = |n: &str| {
        reply["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == n)
            .unwrap()["branch"]
            .clone()
    };
    assert_eq!(branch_of("기능-브랜치"), "기능-브랜치");
    assert_eq!(branch_of("origin/feat"), "feat");
    assert_eq!(branch_of("team/up/fix/a"), "fix/a");
    assert_eq!(reply["branches_dropped"], 4, "{reply}");
    assert!(reply.get("branches_truncated").is_none(), "{reply}");
    // A dropped name can still be typed by hand; the create rules stay.
    let refused = core.wt_as(
        &core.owner_token(),
        "create",
        json!({"project": repo, "branch": "-x"}),
    );
    assert_eq!(refused, Err("invalid branch name".into()));
}

#[test]
fn worktree_branches_agent_only_own_project() {
    let core = Core::new("wtb-agent");
    let own = repo(&core.home.join("own"));
    let other = repo(&core.home.join("other"));
    git(&other, &["branch", "other-only"]);
    let token = core.session_token(&own);
    let mine = core.wt_as(&token, "branches", json!({})).unwrap();
    assert_eq!(names(&mine), ["main"]);
    let named = core
        .wt_as(&token, "branches", json!({"project": own}))
        .unwrap();
    assert_eq!(names(&named), ["main"]);
    assert_eq!(
        core.wt_as(&token, "branches", json!({"project": other})),
        Err("operation not granted".into())
    );
    assert_eq!(names(&core.branches(&own).unwrap()), ["main"]);
    assert_eq!(
        names(&core.branches(&other).unwrap()),
        ["main", "other-only"]
    );
}
