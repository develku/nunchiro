//! V2-8a: the worktree list with facts, one-field create, label-only rename, remove that asks before losing work, and
//! Undo from the kept branch. Each test runs a real `nunchiro serve` on a short home with a temp git repo in it.
#[path = "fixtures/gh_pin.rs"]
mod gh_pin;
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const ACME: &str = "https://github.com/acme/app.git";
use home::git_env::scrubbed;
fn git(dir: &Path, args: &[&str]) -> String {
    let out = scrubbed("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=f@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}
fn branch_exists(repo: &Path, branch: &str) -> bool {
    scrubbed("git")
        .arg("-C")
        .arg(repo)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .output()
        .unwrap()
        .status
        .success()
}

struct Core {
    home: PathBuf,
    repo: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("wtf");
        fs::create_dir_all(home.join("bin")).unwrap();
        let repo = home.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["commit", "-q", "-m", "initial"]);
        let process = scrubbed(cli::path().to_str().unwrap())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &home)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self {
            home,
            repo,
            process,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    /// An owner request as JSON; the reply as JSON.
    fn op(&self, request: Value) -> Result<Value, String> {
        call(&self.home, serde_json::from_value(request).unwrap())
            .map(|r| serde_json::to_value(r).unwrap())
    }
    fn wt(&self, operation: &str, extra: Value) -> Result<Value, String> {
        let mut r = json!({"op":"worktree","operation":operation,"project":self.repo,"path":null,"branch":null,"base":"HEAD","label":""});
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        self.op(r)
    }
    fn create(&self, branch: &str) -> Value {
        let r = self.wt("create", json!({"branch":branch})).unwrap();
        r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap()
            .clone()
    }
    fn list(&self) -> Vec<Value> {
        self.wt("list", json!({})).unwrap()["worktrees"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn row(&self, path: &Value) -> Option<Value> {
        self.list().into_iter().find(|w| w["path"] == *path)
    }
    fn gh(&self, script: &str) {
        let gh = self.home.join("bin/gh");
        fs::write(
            &gh,
            format!(
                "#!/bin/sh\necho \"$*\" >> \"{}\"\n{script}\n",
                self.home.join("gh.log").display()
            ),
        )
        .unwrap();
        fs::set_permissions(gh, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn gh_calls(&self) -> String {
        fs::read_to_string(self.home.join("gh.log")).unwrap_or_default()
    }
    /// Ticket 374: a local bare repository stands in for github.com/acme/app as the project's origin (a
    /// `url.<path>.insteadOf` rewrite); returns a writer clone that pushes PR heads to it.
    fn github(&self) -> PathBuf {
        let bare = self.home.join("acme-app.git");
        let writer = self.home.join("writer");
        let (repo, b, w) = (
            self.repo.to_str().unwrap(),
            bare.to_str().unwrap(),
            writer.to_str().unwrap(),
        );
        git(&self.home, &["clone", "-q", "--bare", repo, b]);
        git(&self.home, &["clone", "-q", b, w]);
        git(&self.repo, &["remote", "add", "origin", ACME]);
        git(&self.repo, &["config", &format!("url.{b}.insteadOf"), ACME]);
        writer
    }
    /// PR `n`'s head: a new commit only "GitHub" has.
    fn pull(writer: &Path, n: u32) -> String {
        git(
            writer,
            &["commit", "-q", "--allow-empty", "-m", &format!("pr {n}")],
        );
        git(
            writer,
            &["push", "-q", "origin", &format!("HEAD:refs/pull/{n}/head")],
        );
        git(writer, &["rev-parse", "HEAD"]).trim().to_string()
    }
    fn window(&self, request: Value) -> Value {
        let info = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", info["port"])
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                info["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
    /// A session token: a shell session prints its own.
    fn agent_token(&self) -> (String, String) {
        let Reply::Started { session } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.repo.clone(),
                    worktree: false,
                    label: "agent".into(),
                    args: vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
                    ],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let Reply::Output { data, .. } = call(
                &self.home,
                Request::Read {
                    id: session.id.clone(),
                    after: 0,
                },
            )
            .unwrap() else {
                panic!()
            };
            if let Some(l) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return (l.trim().to_string(), session.id);
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn as_token(&self, token: &str, request: Value) -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn path_of(w: &Value) -> PathBuf {
    PathBuf::from(w["path"].as_str().unwrap())
}

#[test]
fn list_includes_sessionless_worktrees() {
    let core = Core::new();
    let w = core.create("facts");
    let p = path_of(&w);
    fs::write(p.join("new.txt"), "x").unwrap();
    fs::write(p.join("b.txt"), "b").unwrap();
    git(&p, &["add", "b.txt"]);
    git(&p, &["commit", "-q", "-m", "one"]);
    let row = core
        .row(&w["path"])
        .expect("a worktree with no session is listed");
    assert_eq!(row["branch"], "facts");
    assert_eq!(row["missing"], false);
    assert_eq!(
        row["facts"],
        json!({"uncommitted":1,"unpushed":1,"upstream":false}),
        "{row}"
    );
    // Counted for the reply only: the store keeps no counts.
    assert!(
        !fs::read_to_string(core.home.join("worktrees.json"))
            .unwrap()
            .contains("uncommitted")
    );
}

#[test]
fn removed_outside_nunchiro_shows_gone() {
    let core = Core::new();
    let w = core.create("gone");
    // The window's record-only clean-up never removes a folder that is there.
    let err = core.wt("forget", json!({"path":w["path"]})).unwrap_err();
    assert!(err.contains("there again"), "{err}");
    assert!(path_of(&w).exists());
    git(
        &core.repo,
        &["worktree", "remove", "--", w["path"].as_str().unwrap()],
    );
    let row = core.row(&w["path"]).unwrap();
    assert_eq!(row["missing"], true);
    assert!(row.get("facts").is_none(), "{row}");
    // Clean up: the record goes, no dialog and no loss asked.
    let r = core.wt("forget", json!({"path":w["path"]})).unwrap();
    assert!(r.get("loss").is_none(), "{r}");
    assert!(core.row(&w["path"]).is_none());
    assert!(branch_exists(&core.repo, "gone"));
}

// Q9 ja-J5-1: a record whose project folder is gone (a deleted repo, an unmounted drive) reads as missing; the store
// still serves every other project, and Forget clears that record.
#[test]
fn gone_project_marks_its_record_missing() {
    let core = Core::new();
    let other = core.home.join("other");
    fs::create_dir_all(&other).unwrap();
    git(&other, &["init", "-q", "-b", "main"]);
    git(&other, &["commit", "-q", "--allow-empty", "-m", "initial"]);
    let r = core
        .wt("create", json!({"project":other,"branch":"elsewhere"}))
        .unwrap();
    let w = r["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["branch"] == "elsewhere")
        .unwrap()
        .clone();
    fs::remove_dir_all(&other).unwrap();
    core.create("still");
    let all = core.wt("list", json!({"project":null})).unwrap();
    let row = all["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["path"] == w["path"])
        .unwrap()
        .clone();
    assert_eq!(row["missing"], true, "{row}");
    core.wt("forget", json!({"project":null,"path":w["path"]}))
        .unwrap();
    let all = core.wt("list", json!({"project":null})).unwrap();
    assert!(
        !all["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["path"] == w["path"]),
        "{all}"
    );
}

#[test]
fn remove_dirty_tree_asks_first() {
    let core = Core::new();
    let dirty = core.create("dirty");
    let ahead = core.create("ahead");
    fs::write(path_of(&dirty).join("lost.txt"), "x").unwrap();
    fs::write(path_of(&ahead).join("c.txt"), "c").unwrap();
    git(&path_of(&ahead), &["add", "c.txt"]);
    git(&path_of(&ahead), &["commit", "-q", "-m", "unpushed work"]);
    let r = core.wt("remove", json!({"path":dirty["path"]})).unwrap();
    assert_eq!(r["loss"]["uncommitted"], json!(["?? lost.txt"]), "{r}");
    assert_eq!(r["loss"]["unpushed"], json!([]));
    assert!(path_of(&dirty).exists(), "removed without a confirm");
    let a = core.wt("remove", json!({"path":ahead["path"]})).unwrap();
    assert_eq!(a["loss"]["uncommitted"], json!([]));
    let unpushed = a["loss"]["unpushed"].as_array().unwrap();
    assert!(
        unpushed.len() == 1 && unpushed[0].as_str().unwrap().ends_with(" unpushed work"),
        "{a}"
    );
    assert!(path_of(&ahead).exists());
    assert_eq!(a["loss"]["unpushed_total"], 1);
    assert_eq!(a["loss"]["kept_on"], "ahead");
    assert_eq!(r["loss"]["uncommitted_total"], 1);
    // Past the 200 lines a list shows, the total still counts every file.
    for i in 0..205 {
        fs::write(path_of(&dirty).join(format!("many-{i}")), "x").unwrap();
    }
    let many = core.wt("remove", json!({"path":dirty["path"]})).unwrap();
    assert_eq!(many["loss"]["uncommitted"].as_array().unwrap().len(), 200);
    assert_eq!(many["loss"]["uncommitted_total"], 206);
    for i in 0..205 {
        fs::remove_file(path_of(&dirty).join(format!("many-{i}"))).unwrap();
    }
    // A detached HEAD: its commits are not on the branch, and the loss says so.
    git(&path_of(&ahead), &["switch", "-q", "--detach"]);
    let detached = core.wt("remove", json!({"path":ahead["path"]})).unwrap();
    assert_eq!(detached["loss"]["kept_on"], Value::Null, "{detached}");
    git(&path_of(&ahead), &["switch", "-q", "ahead"]);
    // A confirm for another list than the one now (the user saw less than is there) removes nothing.
    fs::write(path_of(&dirty).join("later.txt"), "x").unwrap();
    let stale = core
        .wt("remove", json!({"path":dirty["path"],"confirm":r["loss"]}))
        .unwrap();
    assert_eq!(
        stale["loss"]["uncommitted"].as_array().unwrap().len(),
        2,
        "{stale}"
    );
    assert!(path_of(&dirty).exists());
    // The confirm with the list as it is now removes; the branch stays.
    let gone = core
        .wt(
            "remove",
            json!({"path":dirty["path"],"confirm":stale["loss"]}),
        )
        .unwrap();
    assert!(gone.get("loss").is_none(), "{gone}");
    assert!(!path_of(&dirty).exists());
    assert!(branch_exists(&core.repo, "dirty"));
    core.wt("remove", json!({"path":ahead["path"],"confirm":a["loss"]}))
        .unwrap();
    assert!(!path_of(&ahead).exists());
    assert!(
        branch_exists(&core.repo, "ahead"),
        "unpushed commits stay on the kept branch"
    );
}

#[test]
fn clean_remove_no_dialog_branch_kept() {
    let core = Core::new();
    let w = core.create("clean");
    // The window's path, as the tree's remove sends it.
    let r = core.window(json!({"op":"worktree","operation":"remove","project":null,"path":w["path"],"branch":null,"base":"HEAD","label":""}));
    assert!(
        r["Ok"]["worktrees"].is_array() && r["Ok"].get("loss").is_none(),
        "{r}"
    );
    assert!(!path_of(&w).exists());
    assert!(branch_exists(&core.repo, "clean"));
}

#[test]
fn undo_readds_from_kept_branch() {
    let core = Core::new();
    let w = core.create("undo");
    core.wt("remove", json!({"path":w["path"]})).unwrap();
    // No stored data: the branch is the record.
    fs::remove_file(core.home.join("worktrees.json")).unwrap();
    let r = core
        .wt(
            "restore",
            json!({"path":w["path"],"branch":"undo","label":"undo"}),
        )
        .unwrap();
    assert!(
        r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["path"] == w["path"] && x["branch"] == "undo"),
        "{r}"
    );
    assert_eq!(
        git(&path_of(&w), &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "undo"
    );
    // Undo after the branch was deleted: a plain error, nothing changes.
    core.wt("remove", json!({"path":w["path"]})).unwrap();
    git(&core.repo, &["branch", "-D", "undo"]);
    let before = (
        core.list(),
        git(&core.repo, &["worktree", "list", "--porcelain"]),
    );
    let err = core
        .wt(
            "restore",
            json!({"path":w["path"],"branch":"undo","label":"undo"}),
        )
        .unwrap_err();
    assert!(err.contains("branch undo no longer exists"), "{err}");
    assert!(!path_of(&w).exists());
    assert_eq!(
        before,
        (
            core.list(),
            git(&core.repo, &["worktree", "list", "--porcelain"])
        )
    );
    // Restore only re-adds under the worktree root, never at any other path.
    let outside = core.home.join("elsewhere");
    git(&core.repo, &["branch", "spare"]);
    assert!(
        core.wt(
            "restore",
            json!({"path":outside,"branch":"spare","label":""})
        )
        .is_err()
    );
    assert!(!outside.exists());
}

#[test]
fn rename_label_only_inline() {
    let core = Core::new();
    let w = core.create("rename");
    let git_state = || {
        (
            git(&core.repo, &["worktree", "list", "--porcelain"]),
            git(&core.repo, &["branch", "--list"]),
        )
    };
    let before = git_state();
    let sessions = |c: &Core| {
        serde_json::to_value(call(&c.home, Request::Snapshot).unwrap()).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len()
    };
    let n = sessions(&core);
    let r = core
        .wt("rename", json!({"path":w["path"],"label":"Nice name"}))
        .unwrap();
    assert!(
        r["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["path"] == w["path"] && x["label"] == "Nice name"),
        "{r}"
    );
    assert_eq!(before, git_state(), "rename touched git");
    assert_eq!(n, sessions(&core), "rename started a session");
}

#[test]
fn create_one_field_forms() {
    let core = Core::new();
    let made = |from: &str| -> Value {
        let r = core.wt("create", json!({"from":from})).unwrap();
        r["worktrees"].as_array().unwrap().last().unwrap().clone()
    };
    let text = made("Fix the login redirect!");
    assert_eq!(
        (text["branch"].as_str(), text["label"].as_str()),
        (
            Some("fix-the-login-redirect"),
            Some("fix-the-login-redirect")
        )
    );
    let auto = made("  ");
    let b = auto["branch"].as_str().unwrap();
    assert!(
        b.len() == 7 && b.starts_with("wt-") && b[3..].chars().all(|c| c.is_ascii_hexdigit()),
        "{b}"
    );
    // A PR URL becomes the PR's head branch through gh; an issue becomes issue-<n>. Ticket 374: the PR's code comes
    // from the remote that is its repository.
    let writer = core.github();
    for n in [7, 8, 9] {
        Core::pull(&writer, n);
    }
    core.gh(r#"case "$*" in *pull/7*) echo '{"headRefName":"feature/login","title":"Login"}';; *) echo '{"title":"Crash"}';; esac"#);
    assert_eq!(
        made("https://github.com/acme/app/pull/7")["branch"],
        "feature/login"
    );
    assert_eq!(
        made("https://github.com/acme/app/issues/412")["branch"],
        "issue-412"
    );
    assert!(
        core.gh_calls()
            .contains("-- https://github.com/acme/app/pull/7"),
        "{}",
        core.gh_calls()
    );
    // gh answers a flag-shaped branch: refused, the fallback is used.
    core.gh(r#"echo '{"headRefName":"--upload-pack=x","title":"x"}'"#);
    assert_eq!(made("https://github.com/acme/app/pull/8")["branch"], "pr-8");
    // gh failing, then gh absent: the fallback, and create still works.
    core.gh("exit 1");
    assert_eq!(made("https://github.com/acme/app/pull/9")["branch"], "pr-9");
    fs::remove_file(core.home.join("bin/gh")).unwrap();
    assert_eq!(
        made("https://github.com/acme/app/issue/10")["branch"],
        "issue-10"
    );
    // Not the pattern: plain text, never passed to gh.
    core.gh("echo '{}'");
    fs::remove_file(core.home.join("gh.log")).ok();
    let odd = made("https://github.com/acme/app/pull/7;rm -rf x");
    assert_eq!(odd["branch"], "https-github-com-acme-app-pull-7-rm-rf-x");
    assert_eq!(
        made("https://github.com/-x/app/pull/1")["branch"],
        "https-github-com-x-app-pull-1"
    );
    assert_eq!(core.gh_calls(), "", "gh was called for text");
}

// Ticket 374, acceptance 1 and threats 1 and 2: a PR link fetches the PR's head (not local before) from the remote that
// is the PR's repository, into a private ref, named by gh. The person's branches never move and FETCH_HEAD is never
// written. Another repository's PR, or a fetch that fails, makes no branch and no worktree. An Advanced branch name
// gets the PR's code too.
#[test]
fn pr_link_gets_the_prs_code_and_only_from_its_own_repository() {
    let core = Core::new();
    let writer = core.github();
    let pr = Core::pull(&writer, 7);
    // Origin has a PR 9 too: only the repository match can refuse github.com/other/thing/pull/9.
    Core::pull(&writer, 9);
    let heads = || {
        git(
            &core.repo,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
            ],
        )
    };
    let before = heads();
    core.gh(r#"echo '{"headRefName":"feature/login"}'"#);
    let made = |from: &str, branch: Option<&str>| {
        core.wt("create", json!({"from":from,"branch":branch}))
            .map(|r| r["worktrees"].as_array().unwrap().last().unwrap().clone())
    };
    let head = |w: &Value| {
        git(
            Path::new(w["path"].as_str().unwrap()),
            &["log", "-1", "--format=%H"],
        )
    };
    let w = made("https://github.com/acme/app/pull/7", None).unwrap();
    assert_eq!(
        (w["branch"].as_str(), head(&w).trim()),
        (Some("feature/login"), pr.as_str())
    );
    let w = made("https://github.com/acme/app/pull/7", Some("mine")).unwrap();
    assert_eq!(
        (w["branch"].as_str(), head(&w).trim()),
        (Some("mine"), pr.as_str())
    );
    let after: Vec<String> = heads()
        .lines()
        .filter(|l| {
            !l.starts_with("refs/heads/feature/login ") && !l.starts_with("refs/heads/mine ")
        })
        .map(String::from)
        .collect();
    assert_eq!(
        after,
        before.lines().map(String::from).collect::<Vec<_>>(),
        "no branch moved"
    );
    assert!(!core.repo.join(".git/FETCH_HEAD").exists(), "no FETCH_HEAD");
    let n = core.list().len();
    for (url, branch) in [
        ("https://github.com/other/thing/pull/9", "pr-9"),
        ("https://github.com/acme/app/pull/8", "pr-8"), // no such PR: the fetch fails
    ] {
        let e = made(url, None).unwrap_err();
        assert!(e.contains("PR"), "{url}: {e}");
        assert!(!branch_exists(&core.repo, branch), "{url}: no branch");
    }
    assert_eq!(core.list().len(), n, "the refusals made no worktree");
    assert!(
        !core.gh_calls().contains("other/thing"),
        "another repository's PR never reaches gh: {}",
        core.gh_calls()
    );
}

// Ticket 374: a PR whose head is named like a local branch at another commit (a fork's `main`): that branch is never
// moved or checked out; the worktree is `pr-<n>` at the PR's head.
#[test]
fn pr_head_named_like_a_local_branch_never_moves_it() {
    let core = Core::new();
    let writer = core.github();
    let pr = Core::pull(&writer, 3);
    let main = git(&core.repo, &["rev-parse", "refs/heads/main"]);
    core.gh(r#"echo '{"headRefName":"main"}'"#);
    let r = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/3"}),
        )
        .unwrap();
    let w = r["worktrees"].as_array().unwrap().last().unwrap().clone();
    let at = git(
        Path::new(w["path"].as_str().unwrap()),
        &["rev-parse", "HEAD"],
    );
    assert_eq!(
        (w["branch"].as_str(), at.trim()),
        (Some("pr-3"), pr.as_str())
    );
    assert_eq!(
        git(&core.repo, &["rev-parse", "refs/heads/main"]),
        main,
        "the local main never moves"
    );
}

// Ticket 394: a PR worktree leaves no `refs/nunchiro/pr/*` behind, and its PR commits (on no origin branch) count as
// unpushed: removing the folder asks first.
#[test]
fn pr_worktree_keeps_no_private_ref_and_counts_its_commits() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    let made = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/7"}),
        )
        .unwrap();
    let w = made["worktrees"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let private = || git(&core.repo, &["for-each-ref", "refs/nunchiro/"]);
    assert_eq!(private(), "", "a private PR ref was kept");
    let r = core.wt("remove", json!({"path":w["path"]})).unwrap();
    assert_eq!(r["loss"]["unpushed_total"], 1, "{r}");
    assert!(path_of(&w).exists(), "removed without a confirm");
    core.wt("remove", json!({"path":w["path"],"confirm":r["loss"]}))
        .unwrap();
    assert!(!path_of(&w).exists());
    assert_eq!(private(), "");
}

// Ticket 394 round 2: a hostile `.git` whose `refs/nunchiro/pr/7` is a symbolic ref to `main`: the PR fetch never
// writes through it and no delete follows it, so `main` stays where it was.
#[test]
fn pr_private_ref_symref_never_moves_or_deletes_main() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    let main = git(&core.repo, &["rev-parse", "refs/heads/main"]);
    git(
        &core.repo,
        &["symbolic-ref", "refs/nunchiro/pr/7", "refs/heads/main"],
    );
    let made = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/7"}),
        )
        .unwrap();
    let w = made["worktrees"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let r = core.wt("remove", json!({"path":w["path"]})).unwrap();
    if r.get("loss").is_some() {
        core.wt("remove", json!({"path":w["path"],"confirm":r["loss"]}))
            .unwrap();
    }
    assert!(branch_exists(&core.repo, "main"), "main was deleted");
    assert_eq!(git(&core.repo, &["rev-parse", "refs/heads/main"]), main);
    // Ticket 403 item 13: the create used a ref of its own and left the planted one alone.
    let left = git(
        &core.repo,
        &["for-each-ref", "--format=%(refname)", "refs/nunchiro/"],
    );
    assert_eq!(left, "refs/nunchiro/pr/7\n");
}

// Ticket 394 round 4: Remove of a clean worktree (no `--force`, so git runs a status inside it first) never starts the
// folder's fsmonitor or a filter its `.gitattributes` chooses, and still removes the folder.
#[test]
fn worktree_remove_runs_no_fsmonitor_or_filter() {
    let core = Core::new();
    fs::write(core.repo.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
    git(&core.repo, &["add", ".gitattributes"]);
    git(&core.repo, &["commit", "-q", "-m", "attributes"]);
    let w = core.create("guarded");
    let p = path_of(&w);
    let marker = core.home.join("ran");
    let monitor = core.home.join("fsmonitor");
    let hook = format!(
        "#!/bin/sh\necho fsmonitor >> '{}'\nexit 1\n",
        marker.display()
    );
    fs::write(&monitor, hook).unwrap();
    fs::set_permissions(&monitor, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &core.repo,
        &["config", "core.fsmonitor", monitor.to_str().unwrap()],
    );
    let clean = format!("sh -c 'echo filter >> {}; cat'", marker.display());
    git(&core.repo, &["config", "filter.evil.clean", &clean]);
    // Stat-dirty: the same content with a later mtime, so a status has to look at the file.
    fs::write(p.join("a.txt"), "a\n").unwrap();
    fs::File::options()
        .write(true)
        .open(p.join("a.txt"))
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(10))
        .unwrap();
    let r = core.wt("remove", json!({"path":w["path"]}));
    let ran = fs::read_to_string(&marker).unwrap_or_default();
    let r = r.unwrap();
    assert!(r["loss"].is_null(), "a clean worktree asked: {r}");
    assert_eq!(ran, "", "Remove started the folder's fsmonitor or filter");
    assert!(!p.exists(), "the worktree was not removed");
}

// Ticket 394: pasting a PR link again after the PR moved never checks out the kept `pr-<n>` at its old commit.
#[test]
fn pr_link_again_after_the_pr_moved_never_checks_out_the_old_head() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    let link = json!({"from":"https://github.com/acme/app/pull/7"});
    let made = core.wt("create", link.clone()).unwrap();
    let w = made["worktrees"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(w["branch"], "pr-7");
    let r = core.wt("remove", json!({"path":w["path"]})).unwrap();
    if r.get("loss").is_some() {
        core.wt("remove", json!({"path":w["path"],"confirm":r["loss"]}))
            .unwrap();
    }
    assert!(!path_of(&w).exists() && branch_exists(&core.repo, "pr-7"));
    let moved = Core::pull(&writer, 7);
    match core.wt("create", link) {
        Ok(again) => {
            let w = again["worktrees"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .clone();
            let at = git(
                Path::new(w["path"].as_str().unwrap()),
                &["rev-parse", "HEAD"],
            );
            assert_eq!(at.trim(), moved, "the old head was checked out");
        }
        Err(e) => assert_eq!(
            e,
            "this PR's branch already exists at an older commit; delete it to check out the new head: pr-7"
        ),
    }
}

// Ticket 394: worktrees.lock is not held while a PR link waits on the network (here a slow gh): another operation
// meanwhile goes through instead of failing as busy.
#[test]
fn pr_link_network_wait_holds_no_worktree_lock() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    core.gh(r#"sleep 4; echo '{"headRefName":"feature/login"}'"#);
    thread::scope(|scope| {
        let slow = scope.spawn(|| {
            core.wt(
                "create",
                json!({"from":"https://github.com/acme/app/pull/7"}),
            )
        });
        thread::sleep(Duration::from_millis(800));
        let side = core.wt("create", json!({"branch":"side"}));
        assert!(side.is_ok(), "{side:?}");
        assert!(slow.join().unwrap().is_ok());
    });
}

#[test]
fn worktree_counts_use_fixed_argv() {
    let core = Core::new();
    // Flag-shaped or shell-shaped branch names: refused or one argv piece, never a command string.
    for branch in ["--force", "-d", "a b", "x;touch pwned"] {
        let r = core.wt("create", json!({"branch":branch}));
        assert!(r.is_err(), "{branch}: {r:?}");
    }
    assert!(!core.repo.join("pwned").exists() && !core.home.join("pwned").exists());
    assert!(core.list().is_empty());
    let src =
        |p: &str| fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(p)).unwrap();
    let clean = src("src/worktree_clean.rs");
    // The shipped code only: the test module runs `git -c user.name=...` to build its fixtures.
    let clean = gh_pin::shipped(&clean).to_string();
    let sessions = src("src/sessions/worktrees.rs");
    let plan = &sessions[sessions.find("pub(crate) struct WorktreePlan").unwrap()..];
    // To the end of the file since handoff_send moved to sessions/handoff_acp.rs (11-20): more code, never less.
    let plan = &plan[..plan.find("\n/// v2-3b").unwrap_or(plan.len())];
    for (name, code) in [
        ("worktree_clean.rs", clean.as_str()),
        ("WorktreePlan", plan),
    ] {
        assert!(
            !code.contains("Command::new(\"sh\")")
                && !code.contains("process::command(\"sh\")")
                && !code.contains("\"/bin/sh\""),
            "{name} runs a shell"
        );
        assert!(!code.contains("\"-c\""), "{name} passes -c");
        for line in code
            .lines()
            .filter(|l| l.contains(".arg(") || l.contains(".args("))
        {
            assert!(
                !line.contains("format!"),
                "{name}: command piece built by format!: {line}"
            );
        }
    }
}

#[test]
fn worktree_ops_not_for_agent_tokens() {
    let core = Core::new();
    let w = core.create("agent");
    fs::write(path_of(&w).join("x"), "x").unwrap();
    let (token, id) = core.agent_token();
    let loss = core.wt("remove", json!({"path":w["path"]})).unwrap()["loss"].clone();
    let r = core.as_token(&token, json!({"op":"worktree","operation":"remove","project":null,"path":w["path"],"branch":null,"base":"HEAD","label":"","confirm":loss}));
    assert_eq!(r, json!({"Err":"operation not granted"}));
    assert!(path_of(&w).exists());
    // Every V2-8a op and the one-field create (it can run gh) are the owner's; the store and git stay as they were.
    core.gh("echo '{\"headRefName\":\"agent-pr\"}'");
    let before = (
        core.list(),
        git(&core.repo, &["worktree", "list", "--porcelain"]),
        git(&core.repo, &["branch", "--list"]),
    );
    let base = json!({"op":"worktree","project":core.repo,"path":w["path"],"branch":null,"base":"HEAD","label":"x"});
    for extra in [
        json!({"operation":"rename"}),
        json!({"operation":"forget"}),
        json!({"operation":"adopt"}),
        json!({"operation":"restore","branch":"agent"}),
        json!({"operation":"create","path":null,"from":"https://github.com/acme/app/pull/7"}),
        json!({"operation":"create","path":null,"from":"plain text"}),
    ] {
        let mut req = base.clone();
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        assert_eq!(
            core.as_token(&token, req),
            json!({"Err":"operation not granted"}),
            "{extra}"
        );
    }
    assert_eq!(
        before,
        (
            core.list(),
            git(&core.repo, &["worktree", "list", "--porcelain"]),
            git(&core.repo, &["branch", "--list"])
        )
    );
    assert_eq!(core.gh_calls(), "", "a session token ran gh");
    let r = core.as_token(
        &token,
        json!({"op":"quit_settings","patch":{"auto_clean_worktrees":true}}),
    );
    assert_eq!(r, json!({"Err":"operation not granted"}));
    // v25f: an agent neither reads the owner's CLI logins nor opens a login tab.
    for req in [
        json!({"op":"git_providers"}),
        json!({"op":"git_providers","login":"github"}),
    ] {
        assert_eq!(
            core.as_token(&token, req),
            json!({"Err":"operation not granted"})
        );
    }
    let s = core.op(json!({"op":"quit_settings","patch":{}})).unwrap();
    assert_eq!(s["settings"]["auto_clean_worktrees"], false, "{s}");
    call(&core.home, Request::Close { id }).unwrap();
}

// Ticket 374 (security r2): a session token's create with an empty base runs no network fetch and is refused as before
// the default base existed; only the owner's own create fetches origin's default.
#[test]
fn token_create_with_empty_base_fetches_nothing() {
    let core = Core::new();
    let writer = core.github();
    git(&core.repo, &["fetch", "-q", "origin"]);
    git(&core.repo, &["remote", "set-head", "origin", "main"]);
    git(&writer, &["commit", "-q", "--allow-empty", "-m", "ahead"]);
    git(&writer, &["push", "-q", "origin", "HEAD:main"]);
    let seen = git(&core.repo, &["rev-parse", "refs/remotes/origin/main"]);
    let (token, id) = core.agent_token();
    let r = core.as_token(
        &token,
        json!({"op":"worktree","operation":"create","project":core.repo,"path":null,"branch":"tok","base":"","label":""}),
    );
    assert!(
        r["Err"]
            .as_str()
            .is_some_and(|e| e.starts_with("git worktree:")),
        "the old refusal: {r}"
    );
    assert_eq!(
        git(&core.repo, &["rev-parse", "refs/remotes/origin/main"]),
        seen,
        "a session token fetched"
    );
    assert!(!branch_exists(&core.repo, "tok"));
    call(&core.home, Request::Close { id }).unwrap();
}

#[test]
fn an_op_waits_briefly_for_another_ops_lock() {
    // The window's list refresh holds the lock for a moment; a create landing then waits instead of failing as busy.
    let core = Core::new();
    let gate = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(core.home.join("worktrees.lock"))
        .unwrap();
    gate.lock().unwrap();
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        gate.unlock().unwrap();
    });
    let r = core.wt("create", json!({"branch":"waited"}));
    release.join().unwrap();
    assert!(r.is_ok(), "{r:?}");
}

#[test]
fn remove_lists_ignored_files_except_build_output() {
    let core = Core::new();
    fs::write(core.repo.join(".git/info/exclude"), ".env\nnode_modules/\n").unwrap();
    let w = core.create("ignored");
    fs::write(path_of(&w).join(".env"), "SECRET=1").unwrap();
    fs::create_dir_all(path_of(&w).join("node_modules/x")).unwrap();
    fs::write(path_of(&w).join("node_modules/x/i.js"), "1").unwrap();
    let r = core.wt("remove", json!({"path":w["path"]})).unwrap();
    assert_eq!(r["loss"]["ignored"], json!(["!! .env"]), "{r}");
    assert_eq!(
        (&r["loss"]["ignored_total"], &r["loss"]["uncommitted_total"]),
        (&json!(1), &json!(0))
    );
    assert!(path_of(&w).join(".env").exists());
    core.wt("remove", json!({"path":w["path"],"confirm":r["loss"]}))
        .unwrap();
    assert!(!path_of(&w).exists());
    // Build output alone: a one-click remove, no loss asked.
    let b = core.create("built");
    fs::create_dir_all(path_of(&b).join("node_modules")).unwrap();
    fs::write(path_of(&b).join("node_modules/i.js"), "1").unwrap();
    let r = core.wt("remove", json!({"path":b["path"]})).unwrap();
    assert!(r.get("loss").is_none(), "{r}");
    assert!(!path_of(&b).exists()); // V2-8h: a secret-shaped name inside build output is listed by its own path.
    let k = core.create("key-in-modules");
    fs::create_dir_all(path_of(&k).join("node_modules/p")).unwrap();
    fs::write(path_of(&k).join("node_modules/p/i.js"), "1").unwrap();
    fs::write(path_of(&k).join("node_modules/p/deploy.key"), "k").unwrap();
    let r = core.wt("remove", json!({"path":k["path"]})).unwrap();
    assert_eq!(
        r["loss"]["ignored"],
        json!(["!! node_modules/p/deploy.key"]),
        "{r}"
    );
    assert!(path_of(&k).join("node_modules/p/deploy.key").exists());
}

/// V2-CF3: `session start --worktree` makes a detached folder with no record; adopting it gives the row Rename and
/// Remove through the existing ops (record only, no git write), and Remove still asks first.
#[test]
fn adopt_session_worktree_then_rename_and_remove_ask() {
    let core = Core::new();
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.repo.clone(),
                worktree: true,
                label: "fix login".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let path = json!(session.cwd);
    assert!(
        core.row(&path).is_none(),
        "a session's worktree has no record yet"
    );
    let git_before = git(&core.repo, &["worktree", "list", "--porcelain"]);
    let r = core.wt("adopt", json!({"path":path})).unwrap();
    let row = core.row(&path).expect("adopted rows are listed");
    // w35: a `--worktree` start is on its own `nunchiro/<id>` branch now, not detached.
    assert!(
        row["branch"].as_str().unwrap().starts_with("nunchiro/") && row["label"] == "",
        "{r}"
    );
    assert_eq!(
        git_before,
        git(&core.repo, &["worktree", "list", "--porcelain"]),
        "adopt writes no git"
    );
    // Idempotent: a second adopt keeps the one record.
    core.wt("adopt", json!({"path":path})).unwrap();
    assert_eq!(core.list().len(), 1);
    // Only a worktree of the project that sits under the worktree root.
    let other = core.home.join("elsewhere");
    git(
        &core.repo,
        &["worktree", "add", "--detach", other.to_str().unwrap()],
    );
    for bad in [
        json!(other),
        json!(core.repo),
        json!(core.home.join("nope")),
    ] {
        assert!(core.wt("adopt", json!({"path":bad})).is_err(), "{bad}");
    }
    assert_eq!(core.list().len(), 1);
    // Rename is the label; Remove (session closed) asks first, listing the loss.
    core.wt("rename", json!({"path":path,"label":"Login fix"}))
        .unwrap();
    assert_eq!(core.row(&path).unwrap()["label"], "Login fix");
    call(&core.home, Request::Close { id: session.id }).unwrap();
    fs::write(session.cwd.join("lost.txt"), "x").unwrap();
    let asked = core.wt("remove", json!({"path":path})).unwrap();
    assert_eq!(asked["loss"]["uncommitted_total"], 1, "{asked}");
    assert!(session.cwd.exists());
    core.wt("remove", json!({"path":path,"confirm":asked["loss"]}))
        .unwrap();
    assert!(!session.cwd.exists());
    assert!(core.row(&path).is_none());
}

/// V2-CF3 r3: a folder a live agent runs in (or under) is never removed, adopted or not, clean or not; Close comes first.
#[test]
fn remove_refused_while_session_runs() {
    let core = Core::new();
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.repo.clone(),
                worktree: true,
                label: "live".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let path = json!(session.cwd);
    core.wt("adopt", json!({"path":path})).unwrap();
    let err = core.wt("remove", json!({"path":path})).unwrap_err();
    assert!(err.contains("close live worktree sessions first"), "{err}");
    assert!(session.cwd.exists());
    assert!(core.row(&path).is_some());
    // Closed: the same clean folder goes.
    call(&core.home, Request::Close { id: session.id }).unwrap();
    core.wt("remove", json!({"path":path})).unwrap();
    assert!(!session.cwd.exists());
}

/// Adopt a fresh session worktree, close its session, and return its path.
fn closed_session_worktree(core: &Core) -> PathBuf {
    let start = |project: PathBuf, worktree: bool| {
        let Reply::Started { session } = call(
            &core.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project,
                    worktree,
                    label: "live".into(),
                    args: vec!["/bin/cat".into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        session
    };
    let first = start(core.repo.clone(), true);
    core.wt("adopt", json!({"path":first.cwd})).unwrap();
    call(&core.home, Request::Close { id: first.id }).unwrap();
    first.cwd
}

fn start_in(core: &Core, project: PathBuf) -> Session {
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project,
                worktree: false,
                label: "inner".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    session
}

fn assert_remove_refused_then_allowed(core: &Core, wt: &Path, session: Session) {
    let path = json!(wt);
    let err = core.wt("remove", json!({"path":path})).unwrap_err();
    assert!(err.contains("close live worktree sessions first"), "{err}");
    assert!(wt.exists());
    assert!(core.row(&path).is_some());
    call(&core.home, Request::Close { id: session.id }).unwrap();
    core.wt("remove", json!({"path":path})).unwrap();
    assert!(!wt.exists());
}

/// Ticket 991 A2: a removed worktree's ended session closes with it (its row and tab would offer a Restart there).
#[test]
fn remove_closes_ended_sessions_in_the_worktree() {
    let core = Core::new();
    let wt = closed_session_worktree(&core);
    let ended = start_in(&core, wt.clone());
    // The shell ends on its own: an ended row in the worktree, as after Stop.
    call(
        &core.home,
        Request::SendText {
            id: ended.id.clone(),
            text: "\u{4}".into(),
            seen: vec![],
            composer: false,
        },
    )
    .unwrap();
    let state = || match call(&core.home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions
            .into_iter()
            .find(|s| s.id == ended.id)
            .map(|s| s.state),
        _ => panic!(),
    };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while state() == Some(SessionState::Running) {
        assert!(std::time::Instant::now() < until, "the shell never ended");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    core.wt("remove", json!({"path":wt})).unwrap();
    assert!(!wt.exists());
    assert_eq!(state(), None, "the ended row is gone, as after Close");
}

/// Ticket 991 A2, as the remove dialog's "Stop N sessions and remove" does it (seen in the real app: the rows it had
/// just closed stayed, with their tabs and a Restart): a running session closed first, then the remove.
#[test]
fn remove_drops_the_rows_it_was_told_to_stop_first() {
    let core = Core::new();
    let wt = closed_session_worktree(&core);
    let running = start_in(&core, wt.clone());
    call(
        &core.home,
        Request::Close {
            id: running.id.clone(),
        },
    )
    .unwrap();
    let listed = || match call(&core.home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.into_iter().any(|s| s.id == running.id),
        _ => panic!(),
    };
    assert!(listed(), "a closed row stays until its worktree goes");
    core.wt("remove", json!({"path":wt})).unwrap();
    assert!(!wt.exists());
    assert!(!listed(), "the closed row left with its worktree");
}

/// V2-CF3 follow-up: a session running in a subfolder of the worktree still blocks Remove.
#[test]
fn remove_refused_for_subfolder_session() {
    let core = Core::new();
    let wt = closed_session_worktree(&core);
    let sub = wt.join("deep/er");
    fs::create_dir_all(&sub).unwrap();
    let session = start_in(&core, sub);
    assert_remove_refused_then_allowed(&core, &wt, session);
}

/// V2-CF3 follow-up: a session whose cwd is a symlink into the worktree still blocks Remove.
#[test]
fn remove_refused_for_symlinked_session() {
    let core = Core::new();
    let wt = closed_session_worktree(&core);
    let link = core.home.join("via-link");
    std::os::unix::fs::symlink(&wt, &link).unwrap();
    let session = start_in(&core, link);
    assert_remove_refused_then_allowed(&core, &wt, session);
}

/// A detached worktree at `name` under the worktree root; the canonical path.
fn odd_worktree(core: &Core, name: &str, extra: &[&str]) -> PathBuf {
    let root = core.home.join("worktrees");
    fs::create_dir_all(&root).unwrap();
    let path = fs::canonicalize(&root).unwrap().join(name);
    let mut args = vec!["worktree", "add"];
    args.extend(extra);
    args.push(path.to_str().unwrap());
    git(&core.repo, &args);
    path
}

/// v2-69 item 2: `git worktree list --porcelain` prints a newline raw, so a folder named `x\n\nworktree /y` forged a
/// record. Adopt reads `-z`: the odd folder is one record with its exact path and the forged path is not a worktree.
#[test]
fn adopt_parses_porcelain_z_newline() {
    let core = Core::new();
    let ghost = fs::canonicalize({
        fs::create_dir_all(core.home.join("worktrees")).unwrap();
        core.home.join("worktrees")
    })
    .unwrap()
    .join("ghost");
    fs::create_dir_all(&ghost).unwrap(); // a plain folder git does not list
    let plain = odd_worktree(&core, "a\nb", &["--detach"]);
    let forger = odd_worktree(
        &core,
        &format!(
            "c\n\nworktree {}\nbranch refs/heads/forged",
            ghost.display()
        ),
        &["--detach"],
    );
    for path in [&plain, &forger] {
        core.wt("adopt", json!({"path":path})).unwrap();
        assert!(core.row(&json!(path)).is_some(), "{path:?}");
    }
    assert_eq!(core.list().len(), 2);
    assert!(
        core.wt("adopt", json!({"path":ghost})).is_err(),
        "a forged block must not promote a folder git does not list"
    );
    assert!(core.row(&json!(ghost)).is_none());
    assert_eq!(core.list().len(), 2);
}

/// Spaces, a trailing space, a leading dash and non-ASCII names each adopt as one record; a branch is kept.
#[test]
fn adopt_parses_porcelain_z_space_and_unicode() {
    let core = Core::new();
    let names = ["my tree", "나무 ツリー", "-dash", "end "];
    for (i, name) in names.iter().enumerate() {
        let path = odd_worktree(&core, name, &["-b", &format!("br{i}")]);
        core.wt("adopt", json!({"path":path})).unwrap();
        let row = core.row(&json!(path)).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(row["branch"], format!("br{i}"), "{name}");
    }
    assert_eq!(core.list().len(), names.len());
    let detached = odd_worktree(&core, "my detached", &["--detach"]);
    core.wt("adopt", json!({"path":detached})).unwrap();
    assert_eq!(core.row(&json!(detached)).unwrap()["branch"], "");
}

/// A folder under the root that is no worktree of the project is refused with the usual text.
#[test]
fn adopt_rejects_plain_folder() {
    let core = Core::new();
    let plain = odd_worktree(&core, "real", &["--detach"]);
    let folder = plain.parent().unwrap().join("plain");
    fs::create_dir_all(&folder).unwrap();
    let e = core.wt("adopt", json!({"path":folder})).unwrap_err();
    assert!(e.contains("not a worktree of this project"), "{e}");
}

// v25f review fixes: the folder setting changes under existing worktrees.
impl Core {
    fn folder(&self, dir: &str) -> Result<Value, String> {
        self.op(json!({"op":"quit_settings","patch":{"worktrees_dir":dir}}))
    }
    fn git_add(&self, path: &Path) {
        git(
            &self.repo,
            &["worktree", "add", "--detach", path.to_str().unwrap()],
        );
    }
}

#[test]
fn quit_settings_refused_folder_leaves_worktrees_json() {
    let core = Core::new();
    core.create("old");
    let file = core.home.join("worktrees.json");
    // A record from before roots were stored: a stamp would rewrite the file.
    let mut disk: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    disk["worktrees"][0].as_object_mut().unwrap().remove("root");
    fs::write(&file, serde_json::to_vec_pretty(&disk).unwrap()).unwrap();
    let before = fs::read(&file).unwrap();
    assert!(core.folder("../../x").is_err());
    assert_eq!(
        before,
        fs::read(&file).unwrap(),
        "a refused patch rewrote worktrees.json"
    );
}

#[test]
fn restore_after_folder_change() {
    let core = Core::new();
    // The old default root, with no record left.
    let old = core.create("legacy");
    core.wt("remove", json!({"path":old["path"]})).unwrap();
    core.folder("../.wt-a").unwrap();
    let r = core
        .wt(
            "restore",
            json!({"path":old["path"],"branch":"legacy","label":""}),
        )
        .unwrap();
    assert!(path_of(&old).exists(), "{r}");
    // A custom root the setting has left, known from a sibling's record.
    let kept = core.create("kept");
    let gone = core.create("gone");
    assert_eq!(path_of(&gone).parent(), path_of(&kept).parent());
    core.wt("remove", json!({"path":gone["path"]})).unwrap();
    core.folder("../.wt-b").unwrap();
    core.wt(
        "restore",
        json!({"path":gone["path"],"branch":"gone","label":""}),
    )
    .unwrap();
    assert!(path_of(&gone).exists());
    let row = core.row(&gone["path"]).unwrap();
    assert_eq!(
        row["root"], kept["root"],
        "recorded under the root it is really in"
    );
    // A folder outside every known root stays refused.
    git(&core.repo, &["branch", "spare"]);
    let outside = fs::canonicalize(&core.home)
        .unwrap()
        .join("elsewhere/repo/x");
    assert!(
        core.wt(
            "restore",
            json!({"path":outside,"branch":"spare","label":""})
        )
        .is_err()
    );
    assert!(!outside.exists());
}

#[test]
fn adopt_after_folder_change() {
    let core = Core::new();
    let home = fs::canonicalize(&core.home).unwrap();
    // Made under the old default root, by the CLI (no record).
    let legacy = home.join("worktrees/repo/cli-made");
    core.git_add(&legacy);
    core.folder("../.wt-a").unwrap();
    core.wt("adopt", json!({"path":legacy})).unwrap();
    assert!(core.row(&json!(legacy)).is_some());
    // Under a custom root the setting has left, known from a sibling's record.
    let kept = core.create("kept");
    let beside = path_of(&kept).parent().unwrap().join("cli-made-2");
    core.git_add(&beside);
    core.folder("../.wt-b").unwrap();
    core.wt("adopt", json!({"path":beside})).unwrap();
    assert_eq!(core.row(&json!(beside)).unwrap()["root"], kept["root"]);
    // A worktree outside every known root stays refused.
    let other = home.join("elsewhere");
    core.git_add(&other);
    assert!(core.wt("adopt", json!({"path":other})).is_err());
}

/// Ticket 403: a marker file the repository's post-checkout hook, its fsmonitor and a smudge filter its
/// `.gitattributes` picks each append to. Armed after the fixture's own git calls (a commit would start the monitor).
fn armed(core: &Core) -> PathBuf {
    let marker = core.home.join("ran");
    let script = |name: &str| {
        let path = core.home.join(name);
        let body = format!("#!/bin/sh\necho {name} >> '{}'\nexit 1\n", marker.display());
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let hooks = core.repo.join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    fs::copy(script("post-checkout"), hooks.join("post-checkout")).unwrap();
    let monitor = script("fsmonitor");
    git(
        &core.repo,
        &["config", "core.fsmonitor", monitor.to_str().unwrap()],
    );
    let smudge = format!("sh -c 'echo smudge >> {}; cat'", marker.display());
    git(&core.repo, &["config", "filter.evil.smudge", &smudge]);
    let _ = fs::remove_file(&marker);
    marker
}
fn attributes(core: &Core, line: &str) {
    fs::write(core.repo.join(".gitattributes"), line).unwrap();
    git(&core.repo, &["add", ".gitattributes"]);
    git(&core.repo, &["commit", "-q", "-m", "attributes"]);
}

// Ticket 403 item 1: Create's checkout runs no post-checkout hook, fsmonitor or smudge filter, and the file is there.
#[test]
fn create_checkout_runs_no_hook_filter_or_fsmonitor() {
    let core = Core::new();
    attributes(&core, "*.txt filter=evil\n");
    let marker = armed(&core);
    let w = core.create("guarded");
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "");
    assert_eq!(
        fs::read_to_string(path_of(&w).join("a.txt")).unwrap(),
        "a\n"
    );
}

// Ticket 403 item 2: a PR link's checkout gets the same switch-offs (before: only submodules and the LFS skip).
#[test]
fn pr_checkout_runs_no_hook_filter_or_fsmonitor() {
    let core = Core::new();
    attributes(&core, "*.txt filter=evil\n");
    let writer = core.github();
    Core::pull(&writer, 7);
    let marker = armed(&core);
    core.wt(
        "create",
        json!({"from":"https://github.com/acme/app/pull/7"}),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "");
}

// Ticket 403 item 4: `session start --worktree`'s detached checkout gets them too.
#[test]
fn session_worktree_checkout_runs_no_hook_filter_or_fsmonitor() {
    let core = Core::new();
    attributes(&core, "*.txt filter=evil\n");
    let marker = armed(&core);
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.repo.clone(),
                worktree: true,
                label: "guarded".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let ran = fs::read_to_string(&marker).unwrap_or_default();
    call(&core.home, Request::Close { id: session.id }).unwrap();
    assert_eq!(ran, "");
    assert_eq!(
        fs::read_to_string(session.cwd.join("a.txt")).unwrap(),
        "a\n"
    );
}

// w35 F2: `session start --worktree` begins at the default branch tip on its own branch, not at the root's older HEAD.
#[test]
fn session_worktree_starts_at_default_branch_tip_on_a_branch() {
    let core = Core::new();
    let old = git(&core.repo, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(core.repo.join("b.txt"), "b\n").unwrap();
    git(&core.repo, &["add", "b.txt"]);
    git(&core.repo, &["commit", "-q", "-m", "newer"]);
    let tip = git(&core.repo, &["rev-parse", "main"]).trim().to_string();
    git(&core.repo, &["checkout", "-q", "--detach", &old]);
    let Reply::Started { session } = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.repo.clone(),
                worktree: true,
                label: "fresh".into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!()
    };
    let head = git(&session.cwd, &["rev-parse", "HEAD"]).trim().to_string();
    let branch = git(&session.cwd, &["symbolic-ref", "--short", "HEAD"]);
    call(&core.home, Request::Close { id: session.id }).unwrap();
    assert_eq!(head, tip);
    assert!(branch.trim().starts_with("nunchiro/"), "{branch}");
    assert_eq!(git(&core.repo, &["rev-parse", "HEAD"]).trim(), old);
}

// Ticket 403 item 5: a ref read's error (here check-ref-format naming the branch) carries no URL user part.
#[test]
fn ref_read_error_drops_the_url_user_part() {
    let core = Core::new();
    let e = core
        .wt("create", json!({"branch":"https://u:tok3n@host/x"}))
        .unwrap_err();
    assert!(
        e.starts_with("git worktree:") && !e.contains("tok3n"),
        "{e}"
    );
}

// Ticket 403 item 13: a create of a PR never deletes or moves another create's private ref for it.
#[test]
fn pr_create_leaves_another_creates_private_ref() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    let main = git(&core.repo, &["rev-parse", "refs/heads/main"]);
    git(
        &core.repo,
        &["update-ref", "refs/nunchiro/pr/7", main.trim()],
    );
    core.wt(
        "create",
        json!({"from":"https://github.com/acme/app/pull/7"}),
    )
    .unwrap();
    assert_eq!(git(&core.repo, &["rev-parse", "refs/nunchiro/pr/7"]), main);
}

// Ticket 403 item 13: a store that does not read as valid refuses before the PR fetch reaches the network.
#[test]
fn pr_create_with_a_bad_store_fetches_nothing() {
    let core = Core::new();
    let writer = core.github();
    let pr = Core::pull(&writer, 7);
    fs::write(core.home.join("worktrees.json"), "not json").unwrap();
    let e = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/7"}),
        )
        .unwrap_err();
    assert!(e.contains("invalid worktree store"), "{e}");
    let fetched = scrubbed("git")
        .arg("-C")
        .arg(&core.repo)
        .args(["cat-file", "-e", &pr])
        .status()
        .unwrap()
        .success();
    assert!(!fetched, "the PR's commit was fetched");
}

// Ticket 403 items 14, 18: an Advanced branch name on a PR link, kept at another commit, is refused (checked under the
// lock), and the refusal names the branch to delete.
#[test]
fn pr_link_advanced_branch_at_another_commit_is_refused() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    git(&core.repo, &["branch", "mine"]);
    let n = core.list().len();
    let e = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/7","branch":"mine"}),
        )
        .unwrap_err();
    assert_eq!(
        e,
        "this PR's branch already exists at an older commit; delete it to check out the new head: mine"
    );
    assert_eq!(core.list().len(), n);
}

// Ticket 403 item 19: git follows a `refs/nunchiro/pr` folder symlinked into `refs/heads/<dir>`; that layout is
// refused before the first delete, so branch `<dir>/7` stays.
#[test]
fn pr_ref_folder_symlinked_into_heads_deletes_no_branch() {
    let core = Core::new();
    let writer = core.github();
    Core::pull(&writer, 7);
    git(&core.repo, &["branch", "dir/7"]);
    let refs = core.repo.join(".git/refs/nunchiro");
    fs::create_dir_all(&refs).unwrap();
    std::os::unix::fs::symlink("../heads/dir", refs.join("pr")).unwrap();
    let e = core
        .wt(
            "create",
            json!({"from":"https://github.com/acme/app/pull/7"}),
        )
        .unwrap_err();
    assert!(e.contains("PR"), "{e}");
    assert!(branch_exists(&core.repo, "dir/7"), "the branch was deleted");
}

// Coordinator 11-11 (v37-git-env R2): a worktree whose change is too large to read whole still asks first, says so
// (no list, a lower-bound count), and removes after the confirm.
#[test]
fn remove_too_large_to_list_asks_then_removes() {
    let core = Core::new();
    let w = core.create("huge");
    let p = path_of(&w);
    for i in 0..800 {
        fs::write(p.join(format!("{i:0>100}.txt")), "x").unwrap();
    }
    let r = core.wt("remove", json!({"path":w["path"]})).unwrap();
    let loss = &r["loss"];
    assert_eq!(loss["too_large"], true, "{loss}");
    assert_eq!(loss["uncommitted"], json!([]));
    assert!(loss["uncommitted_total"].as_u64().unwrap() > 500, "{loss}");
    assert!(p.exists(), "removed without a confirm");
    core.wt("remove", json!({"path":w["path"],"confirm":loss}))
        .unwrap();
    assert!(!p.exists(), "the confirm did not remove");
}

// Ticket 403 round 2 (coordinator, after herdr, Orca and T3 Code): a worktree checkout runs the `lfs` filter, so an
// LFS repository gets its real files, while every other filter (`evil`), the hook and the fsmonitor stay off.
#[test]
fn checkout_runs_the_lfs_filter_only() {
    let core = Core::new();
    fs::write(core.repo.join("big.bin"), "pointer\n").unwrap();
    git(&core.repo, &["add", "big.bin"]);
    attributes(&core, "*.bin filter=lfs\n*.txt filter=evil\n");
    let marker = armed(&core);
    let lfs = core.home.join("lfs-ran");
    let smudge = format!("sh -c 'echo lfs >> {}; cat'", lfs.display());
    git(&core.repo, &["config", "filter.lfs.smudge", &smudge]);
    let w = core.create("lfs");
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "");
    assert_eq!(fs::read_to_string(&lfs).unwrap_or_default(), "lfs\n");
    assert_eq!(
        fs::read_to_string(path_of(&w).join("big.bin")).unwrap(),
        "pointer\n"
    );
}
