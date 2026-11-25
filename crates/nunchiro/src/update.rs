//! Ticket 1082: the installed app updates itself from a folder of ready builds and keeps every session.
//!
//! The owner names the folder in Settings > About; the app writes it to `<home>/update-source` (one line; no file or an
//! empty one = off). The folder holds a built `Nunchiro.app` and the stamp `nunchiro-build.json` beside it:
//! `{"commit": "<git sha>", "built": "<RFC 3339 time>", "sha256": {"nunchiro": "<hex>", "nunchiro-app": "<hex>"}}`,
//! where `sha256` names every file in `Nunchiro.app/Contents/MacOS` by its name. A stamp whose commit differs from this
//! build's and whose hashes match the bundle is a new build ready.
//!
//! `install` copies that bundle beside the installed one, checks the copy again (hashes, bundle id, `codesign -v`),
//! keeps the installed bundle as a backup, swaps the two and runs the new bundle's `serve update`: the core is replaced
//! and every session stays in its holder. Unless the running core then is the new commit and every session that ran
//! before still runs, the backup goes back. The app's "Install and restart" is this command, then a relaunch.
//!
//! Part B (Codex after-check 2026-11-24; threat model in the ticket): seats run unsandboxed as the owner, so this stops a
//! stray or foreign build and an off-main commit, not a malicious seat. At install the stamp's commit must be on main's
//! first-parent line, fetched live with no user git config or hooks, and later on it than this build's own commit. The
//! owner's Install click is the approval. Ticket 1112: the repository is private; the fetch signs in with gh's token.
//! Ticket 1117: the repository is `NUNCHIRO_UPDATE_REPO` at build time; a build without it refuses to install.
//!
//! Ticket 1107: `install --archive <file>` is the signed feed's way in. The app has verified the archive's signature
//! (tauri-plugin-updater); it holds the same two things as the folder, `Nunchiro.app` and its stamp, and is unpacked
//! inside this transaction, so it gets every check and the rollback above.
use crate::update_claims::{claimant, private, read_small};
use crate::{COMMIT, Reply, Request, SessionState, call};
use std::{
    collections::BTreeMap,
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::Command,
};

/// Ends at the commands: check-cli-docs.sh reads every word of a help line up to a `<`, `[` or option as the command.
pub(crate) const USAGE: &str = "nunchiro update status|install [--archive <file>]";
/// This app's bundle id; a build with another one (the isolated test build) never updates itself.
const OWNER_ID: &str = "dev.nunchiro.app";
const SOURCE: &str = "update-source";
const APP: &str = "Nunchiro.app";
const STAMP: &str = "nunchiro-build.json";
/// Part B round 2: the repository whose main decides which builds are newer (the one RELEASES in rc_update.rs names).
/// Ticket 1117: no default. A fixed URL pointed builds from another line (the local main) at a repository whose history
/// they are not part of, so every install was refused for a misleading reason; such a build now says what is missing.
const REPO: Option<&str> = option_env!("NUNCHIRO_UPDATE_REPO");

fn update_repo(built: Option<&str>) -> Result<&str, String> {
    built.ok_or_else(|| {
        "refused: this build names no update repository; set NUNCHIRO_UPDATE_REPO at build time"
            .into()
    })
}

/// Beside the installed bundle, so each swap is a rename on one volume.
const WORK: &str = ".nunchiro-update";

pub(crate) fn run(home: &Path, args: &[String]) -> Result<(), String> {
    owner_only(std::env::var_os("NUNCHIRO_TOKEN").is_some())?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["status"] => {
            println!("{}", status(home));
            Ok(())
        }
        ["install", rest @ ..] => {
            let archive = match rest {
                [] => None,
                ["--archive", file] if Path::new(file).is_absolute() => Some(Path::new(*file)),
                _ => return Err(USAGE.into()),
            };
            // Both only read, and both pass before anything is touched.
            owner_by_process(home)?;
            let bundle = installed(&current_exe()?)?;
            let claims = crate::passwd::passwd_home().map(|h| crate::update_claims::claims(&h));
            belongs(home, &bundle, claims.as_deref())?;
            let folder;
            let from = match archive {
                Some(file) => Candidate::Archive(file),
                None => {
                    folder = source(home).ok_or("no update folder is set (Settings > About)")?;
                    Candidate::Folder(&folder)
                }
            };
            install(home, &bundle, from, running()?, update_repo(REPO)?, || {
                sessions(home)
            })?;
            println!("replaced");
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

/// A session may not swap the owner's app: an agent's `nunchiro` carries its session token.
fn owner_only(session: bool) -> Result<(), String> {
    if session {
        return Err(
            "refused: `nunchiro update` is for the owner, not for a session; use Settings > About"
                .into(),
        );
    }
    Ok(())
}

/// Security round 1 (MUST 1): the variable alone proves nothing, since an agent can drop it. The core judges the
/// connecting process (`inside_token`): from inside a session the owner token is that session's caller, so an
/// owner-only request is refused. `TokenList` is owner-only and reads only; no core answering refuses too.
fn owner_by_process(home: &Path) -> Result<(), String> {
    call(home, Request::TokenList).map(|_| ()).map_err(|e| {
        format!("refused: `nunchiro update` is for the owner, not for a session; use Settings > About ({e})")
    })
}

/// The bundle the core of `home` was started from, by its record (`core.start.json`, written by that core).
fn recorded_bundle(home: &Path) -> Option<PathBuf> {
    let bytes = read_small(&home.join("core.start.json"), RECORD_MAX)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exe = fs::canonicalize(v["exe"].as_str()?).ok()?;
    Some(exe.ancestors().nth(3)?.to_path_buf())
}

/// Security rounds 2 and 3 (MUST): `owner_by_process` asks the core of `home`, so `home` must be the one this bundle
/// belongs to; an agent could otherwise name a home of its own, with a core it started, and be the owner there. The
/// home's core must have been started from this bundle (its `core.start.json`), and the bundle's claim (written only by
/// the app window, see update_claims.rs) must name this home. Round 2's rules on the account's `~/.nunchiro` record are replaced by the claim: they did
/// not protect an owner who runs a custom home, and refused that owner when `~/.nunchiro` had no record.
fn belongs(home: &Path, bundle: &Path, claims: Option<&Path>) -> Result<(), String> {
    let refused = |why: String| {
        Err(format!(
            "refused: {why}; run the update from the app it belongs to"
        ))
    };
    if recorded_bundle(home).as_deref() != Some(bundle) {
        return refused(format!(
            "{} is not the home of {} (its core was not started from that app)",
            home.display(),
            bundle.display()
        ));
    }
    let Some(claims) = claims else {
        return refused("this account has no home folder for the update claims".into());
    };
    match claimant(claims, bundle) {
        Some(owner) if fs::canonicalize(home).ok() == Some(owner.clone()) => Ok(()),
        Some(owner) => refused(format!(
            "{} is claimed by the home {}",
            bundle.display(),
            owner.display()
        )),
        None => refused(format!(
            "no home has claimed {}: open the Nunchiro app once (it claims its own app for its home), then install again",
            bundle.display()
        )),
    }
}

fn running() -> Result<&'static str, String> {
    COMMIT.ok_or_else(|| "this build does not know its commit, so it cannot tell a new one".into())
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| format!("cannot resolve this executable: {e}"))
}

/// The update folder, when one is set.
fn source(home: &Path) -> Option<PathBuf> {
    // Round 3: bounded, non-blocking, regular files only (a planted FIFO or huge file reads as none).
    let bytes = read_small(&home.join(SOURCE), 4096)?;
    let text = String::from_utf8(bytes).ok()?;
    Some(PathBuf::from(text.trim())).filter(|p| p.is_absolute())
}

/// `{"state": "off" | "none" | "ready" | "refused", "source", "commit", "built", "reason"}`; reads, never changes anything.
fn status(home: &Path) -> serde_json::Value {
    let Some(source) = source(home) else {
        return serde_json::json!({"state": "off"});
    };
    let found = current_exe()
        .and_then(|exe| installed(&exe))
        .and_then(|_| ready(&source, running()?));
    match found {
        Ok(Some(stamp)) => {
            serde_json::json!({"state": "ready", "source": source, "commit": stamp.commit, "built": stamp.built})
        }
        Ok(None) => serde_json::json!({"state": "none", "source": source}),
        Err(reason) => serde_json::json!({"state": "refused", "source": source, "reason": reason}),
    }
}

/// The installed bundle this executable runs from: a `.app` that is not where cargo builds it, with this app's id.
fn installed(exe: &Path) -> Result<PathBuf, String> {
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|b| b.extension().is_some_and(|e| e == "app"))
        .filter(|_| exe.parent().is_some_and(|m| m.ends_with("Contents/MacOS")))
        .filter(|b| !b.parent().is_some_and(|p| p.ends_with("bundle/macos")))
        .ok_or_else(|| format!("{} is not inside an installed Nunchiro.app", exe.display()))?;
    match bundle_id(bundle) {
        Some(id) if id == OWNER_ID => Ok(bundle.to_path_buf()),
        id => Err(format!(
            "this is an isolated test build ({}): it keeps its own home and never updates itself",
            id.as_deref().unwrap_or("no bundle id")
        )),
    }
}

struct Stamp {
    commit: String,
    built: String,
    sha256: BTreeMap<String, String>,
}

fn parse_stamp(bytes: &[u8]) -> Result<Stamp, String> {
    let bad = |why: &str| format!("refused: {STAMP} {why}");
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| bad(&e.to_string()))?;
    let commit = v["commit"]
        .as_str()
        .filter(|c| c.len() >= 7 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| bad("has no commit sha"))?;
    let mut sha256 = BTreeMap::new();
    for (name, hash) in v["sha256"]
        .as_object()
        .ok_or_else(|| bad("has no sha256"))?
    {
        let hash = hash
            .as_str()
            .filter(|h| h.len() == 64)
            .ok_or_else(|| bad("has a bad sha256"))?;
        sha256.insert(name.clone(), hash.to_ascii_lowercase());
    }
    if sha256.is_empty() {
        return Err(bad("lists no executable"));
    }
    Ok(Stamp {
        commit: commit.to_ascii_lowercase(),
        built: v["built"].as_str().unwrap_or_default().to_string(),
        sha256,
    })
}

/// One commit, whether written short or in full.
fn same_commit(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

/// The stamp of a new build in `source`, `None` when there is none or it is this build, or why it is refused.
fn ready(source: &Path, running: &str) -> Result<Option<Stamp>, String> {
    let source = source
        .canonicalize()
        .map_err(|e| format!("update folder {}: {e}", source.display()))?;
    private(&source)?;
    let path = source.join(STAMP);
    // Only "is there one": the type and size are judged on the opened descriptor below, not on this name.
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    let bytes = read_small(&path, 64 * 1024)
        .ok_or_else(|| format!("refused: {} is not a small regular file", path.display()))?;
    let stamp = parse_stamp(&bytes)?;
    if same_commit(&stamp.commit, running) {
        return Ok(None);
    }
    verify(&source.join(APP), &stamp)?;
    Ok(Some(stamp))
}

/// The bundle is a private folder with this app's id whose executables are the ones the stamp names.
fn verify(bundle: &Path, stamp: &Stamp) -> Result<(), String> {
    private(bundle)?;
    if !bundle.is_dir() {
        return Err(format!("refused: {} is not a bundle", bundle.display()));
    }
    // Round 5: the whole bundle first (bounded, no links anywhere), so the id and hash reads below never pass a
    // link, such as a linked Contents or MacOS folder.
    walk(bundle, &LIMITS)?;
    let id = bundle_id(bundle);
    if id.as_deref() != Some(OWNER_ID) {
        return Err(format!(
            "refused: the bundle id is {}, not {OWNER_ID}",
            id.as_deref().unwrap_or("missing")
        ));
    }
    let found = hashes(&bundle.join("Contents/MacOS"))?;
    if let Some(name) = stamp
        .sha256
        .keys()
        .chain(found.keys())
        .find(|n| found.get(*n) != stamp.sha256.get(*n))
    {
        return Err(format!(
            "refused: the sha256 of {name} does not match the stamp"
        ));
    }
    Ok(())
}

/// `CFBundleIdentifier` of an XML `Info.plist` (what tauri writes); a binary plist reads as none.
fn bundle_id(bundle: &Path) -> Option<String> {
    let bytes = read_small(&bundle.join("Contents/Info.plist"), RECORD_MAX)?;
    let plist = String::from_utf8(bytes).ok()?;
    let after = plist
        .split_once("<key>CFBundleIdentifier</key>")?
        .1
        .trim_start();
    let value = after.strip_prefix("<string>")?.split_once("</string>")?.0;
    Some(value.trim().to_string())
}

/// The largest record or plist read (as `read_record`'s ceiling).
const RECORD_MAX: u64 = 1 << 20;

/// At most this many executables, each at most this big: a planted folder cannot make a check read without end.
const MAX_FILES: usize = 32;
const MAX_BYTES: u64 = 1 << 30;

/// The sha256 of every file in `dir`, by name, read in a stream; anything there that is not a regular file is refused.
fn hashes(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    use sha2::Digest as _;
    let mut out = BTreeMap::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if out.len() >= MAX_FILES {
            return Err(format!(
                "refused: {} holds more than {MAX_FILES} files",
                dir.display()
            ));
        }
        // Security round 3: opened first (no link, no FIFO wait), then judged and read through that descriptor.
        let file = crate::update_claims::open_regular(&entry.path(), MAX_BYTES)?;
        let mut hasher = sha2::Sha256::new();
        // take: a file that grows after the size check still stops at the limit, and then hashes wrong.
        let mut file = std::io::Read::take(file, MAX_BYTES + 1);
        let mut buf = vec![0; 1 << 20];
        loop {
            match std::io::Read::read(&mut file, &mut buf).map_err(|e| e.to_string())? {
                0 => break,
                n => hasher.update(&buf[..n]),
            }
        }
        let hex = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        out.insert(entry.file_name().to_string_lossy().into_owned(), hex);
    }
    Ok(out)
}

/// Where the new build comes from: the update folder, or the signed feed's archive (ticket 1107).
#[derive(Clone, Copy)]
enum Candidate<'a> {
    Folder(&'a Path),
    Archive(&'a Path),
}

/// Removes its folder when dropped, on every way out of `install`.
struct Remove(PathBuf);
impl Drop for Remove {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The update itself. `snapshot` lists the sessions that run now; it is taken first, so when it cannot be read
/// nothing is touched (round 7: an empty list would make the "every session is back" check prove nothing).
fn install(
    home: &Path,
    bundle: &Path,
    from: Candidate,
    running: &str,
    repo: &str,
    snapshot: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<(), String> {
    let before = snapshot().map_err(|e| {
        format!("refused: the running sessions cannot be read ({e}), so the update could not check that they are kept; nothing was changed")
    })?;
    let name = bundle
        .file_name()
        .ok_or("the installed bundle has no name")?;
    let work = bundle
        .parent()
        .ok_or("the installed bundle has no folder")?
        .join(WORK);
    own_dir(&work)?;
    // Held until this returns: staging, swap, core replace and rollback all run under it.
    let _lock = lock(&work)?;
    // MUST 3: `new` and `backup` are deleted below; a link there would point the deletes outside this folder.
    own_dir(&work.join("new"))?;
    own_dir(&work.join("backup"))?;
    let unpacked = match from {
        Candidate::Folder(_) => None,
        Candidate::Archive(file) => Some(Remove(unpack(file, &work)?)),
    };
    let source = match (from, &unpacked) {
        (_, Some(dir)) => dir.0.as_path(),
        (Candidate::Folder(dir), None) => dir,
        (Candidate::Archive(_), None) => unreachable!("an archive is unpacked above"),
    };
    let stamp = ready(source, running)?.ok_or("no new build is ready")?;
    // Threat 4: the order comes from main, live, not from anything beside the build.
    if stamp.commit.len() != 40 {
        return Err("refused: the stamp's commit must be a full 40-character sha".into());
    }
    // Ticket 1112: gh's sign-in is for GitHub only, so a test's file:// origin never runs gh.
    let token = repo
        .starts_with("https://github.com/")
        .then(gh_token)
        .flatten();
    newer_on_main(
        &main_line(&work, repo, token.as_deref())?,
        &stamp.commit,
        running,
    )?;
    let staged = work.join("new").join(name);
    let _ = fs::remove_dir_all(&staged);
    let from = source.canonicalize().map_err(|e| e.to_string())?.join(APP);
    // The copy is what installs, so the copy is what is checked: the source may change after the first look.
    let checked = stage(&from, &staged, &LIMITS)
        .and_then(|()| verify(&staged, &stamp))
        .and_then(|()| {
            tool(
                Command::new("/usr/bin/codesign").arg("-v").arg(&staged),
                "codesign -v",
                &work,
                LIMITS.time,
            )
        })
        // Last before the swap, so a chat that starts during the copy is seen too.
        .and_then(|()| wait_until_idle(home, BUSY_LIMIT));
    if let Err(e) = checked {
        let _ = fs::remove_dir_all(&staged);
        return Err(e);
    }
    let backup = work.join("backup").join(name);
    let swapped = swap(bundle, &staged, &backup, || {
        replace_core(home, bundle, &stamp.commit, &before)
    });
    let _ = fs::remove_dir_all(&staged); // nothing is left there on success; on failure the new build is not kept
    match swapped {
        Ok(()) => Ok(()),
        // Round 4 (NOTE 2): the previous build is back on disk; its core must run again too.
        Err(e) if e.contains("The previous build was put back") => Err(
            match after_restore(|| live_commit(home), running, || rollback_core(home)) {
                Ok(()) => format!("{e} Its core runs again."),
                Err(why) => format!("{e} {why}"),
            },
        ),
        Err(e) => Err(e),
    }
}

/// Ticket 1130 A-D3: how long `install` waits for a busy core before it gives up with nothing changed. The app's
/// INSTALL_LIMIT (20 min) covers this plus every other bounded step.
/// shortcut: every open ACP chat counts (exit_blockers), so ACP seats open all day hold every install; handing an idle
/// ACP chat to the next core is its own ticket.
const BUSY_LIMIT: std::time::Duration =
    std::time::Duration::from_secs(if cfg!(test) { 2 } else { 300 });

/// Ticket 1130 A-D3: waits, up to `limit`, until the running core could exit without losing work (a running ACP chat, a
/// queued send, an old holder, a sign-in or another run of the core), so the bundle is not swapped and then put back.
/// Each new count goes to stderr. The swap's own `exit_if_idle` still decides; this only keeps it from failing.
/// Round 2 (Codex MUST): every question is one attempt whose whole reply must be in by the end of `limit`, and an answer
/// read after it is refused, a 0 too, so a core that drips bytes or answers late cannot stretch the wait.
fn wait_until_idle(home: &Path, limit: std::time::Duration) -> Result<(), String> {
    let until = std::time::Instant::now() + limit;
    let holder_floor = nunchiro_core::holder::frame::MIN_COMPATIBLE;
    let mut said = None;
    loop {
        let reply = nunchiro_core::server::call_by(
            home,
            Request::ExitBlockers { holder_floor },
            Some(until),
        );
        if std::time::Instant::now() >= until {
            return Err(match said {
                Some(count) => format!(
                    "refused: {count} chat(s) or job(s) still need the running core after {} s; nothing was changed. Install again when they end",
                    limit.as_secs()
                ),
                None => format!(
                    "refused: the running core did not say within {} s whether chats or jobs still need it; nothing was changed",
                    limit.as_secs()
                ),
            });
        }
        let count = match reply {
            Ok(Reply::ExitBlockers { count }) => count,
            // a core from before this request: the swap's own check is the only one, as before
            Err(e) if e.contains("unknown variant") => return Ok(()),
            Ok(other) => return Err(format!("unexpected reply {other:?}")),
            Err(e) => return Err(e),
        };
        if count == 0 {
            return Ok(());
        }
        if said != Some(count) {
            eprintln!("waiting for {count} chat(s) or job(s) to finish");
            said = Some(count);
        }
        std::thread::sleep(
            until
                .saturating_duration_since(std::time::Instant::now())
                .min(std::time::Duration::from_millis(500)),
        );
    }
}

/// Ticket 1112: the variable that carries gh's token to the fetch, and the helper that answers git's `get` with it.
const TOKEN_VAR: &str = "NUNCHIRO_UPDATE_TOKEN";
const TOKEN_HELPER: &str = r#"!f() { test "$1" = get && printf 'username=x-access-token\npassword=%s\n' "$NUNCHIRO_UPDATE_TOKEN"; }; f"#;

/// Ticket 1112: the owner's GitHub sign-in as `gh auth token` reads it (Orca's updater reads it the same way). git's own
/// sign-in on the owner's Mac is gh's helper in ~/.gitconfig, which the fetch never reads. Only a fixed gh path runs,
/// with a cleared environment and the account's home, for at most 10 s; its answer goes through a pipe, never to disk.
/// None when gh is missing, signed out or slow; the fetch then tries the keychain.
fn gh_token() -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
        .into_iter()
        .find(|p| Path::new(p).is_file())?;
    let mut child = Command::new(gh)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", crate::passwd::passwd_home()?)
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .args(["auth", "token", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            _ => {
                // Killed before it is reaped, so the group's number cannot belong to anyone else yet.
                // Safety: kill has no memory effects; a negative pid names the child's own group.
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                let _ = child.wait();
                return None;
            }
        }
    };
    let mut out = child.stdout.take()?;
    // Non-blocking: a process gh left behind may still hold the pipe open; what gh wrote is already in it.
    // Safety: fcntl only changes the flags of this process's own descriptor.
    unsafe { libc::fcntl(out.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
    let mut text = Vec::new();
    let _ = out.by_ref().take(4096).read_to_end(&mut text);
    let token = String::from_utf8(text).ok()?.trim().to_string();
    // The token goes into git's credential protocol, one line per field: nothing but token characters.
    (status.success()
        && !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_'))
    .then_some(token)
}

/// Part B round 2: the first-parent line of `repo`'s main, oldest first, fetched now into a fresh folder in `work`.
/// Only /usr/bin/git runs, with a cleared environment, no system or user git config (the user's ~/.gitconfig is
/// writable by an agent of the same user) and no hooks; only commits are fetched. The sign-in is `token` (ticket 1112:
/// gh's, given to the fetch alone through one helper for `repo`), else the fixed osxkeychain helper. Offline, or with no
/// sign-in for a private repository, the install is refused.
fn main_line(work: &Path, repo: &str, token: Option<&str>) -> Result<Vec<String>, String> {
    let dir = work.join("main-line");
    let _ = fs::remove_dir_all(&dir);
    own_dir(&dir)?;
    let line = (|| {
        own_dir(&dir.join("home"))?;
        let git = |args: &[&str]| {
            let mut cmd = Command::new("/usr/bin/git");
            cmd.env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", dir.join("home"))
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_TERMINAL_PROMPT", "0")
                .args(["-c", "core.hooksPath=/dev/null"])
                .arg("-C")
                .arg(&dir)
                .args(args);
            cmd
        };
        let limit = std::time::Duration::from_secs(120);
        tool(
            &mut git(&["init", "-q", "--bare", "repo"]),
            "git init",
            &dir,
            limit,
        )?;
        // Only one helper: with osxkeychain beside it, git would store gh's token in the keychain after the fetch.
        let helper = match token {
            Some(_) => format!("credential.{repo}.helper={TOKEN_HELPER}"),
            None => "credential.helper=osxkeychain".into(),
        };
        let mut fetch = git(&[
            "-c",
            &helper,
            "-C",
            "repo",
            "fetch",
            "-q",
            "--no-tags",
            "--filter=tree:0",
            repo,
            "+refs/heads/main:refs/heads/main",
        ]);
        if let Some(token) = token {
            fetch.env(TOKEN_VAR, token); // on this one child only, never in its arguments
        }
        tool(&mut fetch, "git fetch", &dir, limit).map_err(|e| {
            format!("refused: main could not be fetched from {repo} ({e}): the update needs it to judge the build; check the network and the GitHub sign-in")
        })?;
        let out = dir.join("line");
        let to = format!("--output={}", out.display());
        let mut log = git(&[
            "-C",
            "repo",
            "log",
            "--first-parent",
            "--reverse",
            "--format=%H",
            &to,
            "main",
        ]);
        tool(&mut log, "git log", &dir, limit)?;
        let text = read_small(&out, 64 << 20).ok_or("refused: main's history could not be read")?;
        Ok(String::from_utf8_lossy(&text)
            .lines()
            .map(str::to_string)
            .collect())
    })();
    let _ = fs::remove_dir_all(&dir);
    line
}

/// Part B round 2 (threat 4): `candidate` must be on main's first-parent `line` and later on it than `running`. A
/// commit's place on that line is its sequence number (the first-parent count); the running build's comes from its own
/// compiled commit, so nothing beside the build or in the folder sets the floor.
fn newer_on_main(line: &[String], candidate: &str, running: &str) -> Result<(), String> {
    let at = |c: &str| line.iter().position(|l| same_commit(l, c));
    let new = at(candidate).ok_or_else(|| {
        format!("refused: the build's commit {candidate} is not on main's first-parent history")
    })?;
    let now = at(running).ok_or_else(|| {
        format!("refused: this build's commit {running} is not on main's first-parent history, so no build can be judged newer")
    })?;
    if new <= now {
        return Err(format!(
            "refused: the build's commit {candidate} is not newer on main than the installed build {running}"
        ));
    }
    Ok(())
}

/// The commit the home's core recorded at its start.
fn core_commit(home: &Path) -> Option<String> {
    let bytes = read_small(&home.join("core.start.json"), RECORD_MAX)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v["commit"].as_str().map(str::to_string)
}

/// The commit of the core that answers now, or `None` when no core answers. Codex security look (1107): the record
/// alone is not a running core; the old core may have exited and the new one failed before it wrote its own record,
/// leaving the old commit in `core.start.json` with nothing serving. `call_once`: this check never starts a core.
fn live_commit(home: &Path) -> Option<String> {
    matches!(
        crate::call_once(home, Request::List),
        Ok(Reply::Snapshot { .. })
    )
    .then(|| core_commit(home))
    .flatten()
}

/// After a restore: a core must answer and be the restored build (this CLI's own commit, `running`); `commit` is the
/// answering core's commit (`live_commit`). When it is not, `replace` exits whatever core runs and starts the restored
/// one (or starts it when none answers); the commit is then read again. Never assumed.
fn after_restore(
    commit: impl Fn() -> Option<String>,
    running: &str,
    replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if commit().is_some_and(|c| same_commit(&c, running)) {
        return Ok(());
    }
    let replaced = replace();
    let now = commit();
    if replaced.is_ok() && now.as_deref().is_some_and(|c| same_commit(c, running)) {
        return Ok(());
    }
    Err(format!(
        "But {} and not the restored build {running}{}: quit Nunchiro and open it again.",
        now.map_or("no core answers".into(), |c| format!(
            "the running core is {c}"
        )),
        replaced
            .err()
            .map(|e| format!(" ({e})"))
            .unwrap_or_default()
    ))
}

/// Round 4: the rollback's own path. `serve update` refuses to put an older stamp over a newer core, so this asks
/// whatever core runs to exit when idle and starts this CLI's own executable (the restored build, at the same path).
fn rollback_core(home: &Path) -> Result<(), String> {
    let old = crate::core_generation(home);
    let holder_floor = nunchiro_core::holder::frame::MIN_COMPATIBLE;
    match call(home, Request::ExitIfIdle { holder_floor }) {
        Ok(_) => crate::start_after_exit(home, None, old.as_deref()),
        Err(e) if e == nunchiro_core::server::EXIT_BUSY => {
            Err("the new core is busy (a chat or a queued send) and kept running".into())
        }
        // No core answers (the new one did not start, or ended): start the restored one.
        Err(_) => crate::ensure_core(home),
    }
}

/// Ticket 1107: the feed archive as `build-release.sh` makes it, `Nunchiro.app` and its stamp and nothing else, unpacked
/// into `work/feed` under the copy's bounds (time, and bytes taken on the volume). The archive must be a bounded regular
/// file (no FIFO for tar to wait on); bsdtar without -P refuses absolute names, `..` and writing through a link.
/// `ready` and `stage` then walk and check the result as they do a folder build.
fn unpack(archive: &Path, work: &Path) -> Result<PathBuf, String> {
    crate::update_claims::open_regular(archive, LIMITS.bytes)?;
    let dir = work.join("feed");
    let _ = fs::remove_dir_all(&dir);
    own_dir(&dir)?;
    let before = free(&dir)?;
    let mut tar = Command::new("/usr/bin/tar");
    tar.arg("-xzf").arg(archive).arg("-C").arg(&dir);
    let unpacked = crate::update_claims::run_limited(
        &mut tar,
        work,
        Some(LIMITS.time),
        crate::update_claims::Output::Discard,
        || {
            if before.saturating_sub(free(&dir)?) > LIMITS.bytes + LIMITS.slack {
                return Err(format!(
                    "refused: the archive unpacks to more than {} bytes",
                    LIMITS.bytes
                ));
            }
            Ok(())
        },
    )
    .map_err(|why| format!("refused: tar: {why}"))
    .and_then(|ran| {
        if !ran.status.success() {
            return Err(format!(
                "refused: the archive does not unpack ({})",
                ran.status
            ));
        }
        let mut names: Vec<String> = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        names.sort();
        if names != [APP, STAMP] {
            return Err(format!(
                "refused: the archive holds {names:?}, not only {APP} and {STAMP}"
            ));
        }
        Ok(())
    });
    match unpacked {
        Ok(()) => Ok(dir),
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Ceilings for a candidate bundle, well above a real one (about 25 MB in about 1,000 entries).
struct Limits {
    entries: u64,
    bytes: u64,
    /// Space left free on the staging volume after the copy.
    headroom: u64,
    /// How much more than the walked size the copy may take on the volume before it is stopped.
    slack: u64,
    time: std::time::Duration,
}
const LIMITS: Limits = Limits {
    entries: 20_000,
    bytes: 1 << 30,
    headroom: 512 << 20,
    slack: 64 << 20,
    time: std::time::Duration::from_secs(300),
};

/// Round 4 (MUST 1): the whole candidate is walked with bounds before anything is copied: directories and regular
/// files only (round 5: no links), at most `entries` entries and `bytes` bytes. Returns the bytes.
fn walk(root: &Path, limits: &Limits) -> Result<u64, String> {
    let (mut entries, mut bytes) = (0u64, 0u64);
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            entries += 1;
            if entries > limits.entries {
                return Err(format!(
                    "refused: {} has more than {} entries",
                    root.display(),
                    limits.entries
                ));
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            let kind = meta.file_type();
            if kind.is_dir() {
                dirs.push(path);
            } else if kind.is_file() {
                bytes += meta.len();
                if bytes > limits.bytes {
                    return Err(format!(
                        "refused: {} holds more than {} bytes",
                        root.display(),
                        limits.bytes
                    ));
                }
            } else {
                // Round 5: a built Nunchiro.app holds folders and regular files only (no link at all), so anything
                // else, a link of any kind included, is refused: no link is judged, so none can lead outside.
                return Err(format!(
                    "refused: {} is not a folder or a regular file (a bundle holds no links)",
                    path.display()
                ));
            }
        }
    }
    Ok(bytes)
}

/// Bytes free for this user on the volume of `path`.
fn free(path: &Path) -> Result<u64, String> {
    let c =
        std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(format!(
            "{}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(s.f_bavail as u64 * s.f_frsize as u64)
}

/// Copies the candidate `from` to `staged`: walked first, then copied by ditto only when the volume keeps
/// `headroom` free, stopped when it runs past `time` or takes more than the walked size plus `slack` on the
/// volume (the source may grow after the walk), and walked again once copied. Any failure removes `staged`.
fn stage(from: &Path, staged: &Path, limits: &Limits) -> Result<(), String> {
    let bytes = walk(from, limits)?;
    let volume = staged.parent().ok_or("bad staging path")?;
    let before = free(volume)?;
    if before < bytes.saturating_add(limits.headroom) {
        return Err(format!(
            "refused: {} has {before} bytes free; the copy needs {bytes} and leaves {} free",
            volume.display(),
            limits.headroom
        ));
    }
    let copied = run_limited(
        Command::new("/usr/bin/ditto").arg(from).arg(staged),
        "ditto",
        volume,
        limits.time,
        || {
            let used = before.saturating_sub(free(volume)?);
            if used > bytes + limits.slack {
                return Err(format!(
                    "refused: the copy took {used} bytes, more than the {bytes} checked"
                ));
            }
            Ok(())
        },
    )
    .and_then(|_| walk(staged, limits).map(drop));
    if copied.is_err() {
        let _ = fs::remove_dir_all(staged);
    }
    copied
}

/// `cmd` through the shared `update_claims::run_limited` (no pipes, output on /dev/null, own process group killed at
/// `time`, when `watch` fails and when the child ends): success is its exit status only.
fn run_limited(
    cmd: &mut Command,
    name: &str,
    scratch: &Path,
    time: std::time::Duration,
    watch: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    use crate::update_claims::Output;
    let ran = crate::update_claims::run_limited(cmd, scratch, Some(time), Output::Discard, watch)
        .map_err(|why| format!("refused: {name}: {why}"))?;
    if ran.status.success() {
        return Ok(());
    }
    Err(format!("refused: {name} failed ({})", ran.status))
}

/// A real folder of this user (made when missing): not a link, writable by nobody else. Ticket 1061 refused a planted
/// link in the worktree folder the same way.
fn own_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => private(path),
        Ok(_) => Err(format!(
            "refused: {} is a link or not a folder; Nunchiro does not follow links there",
            path.display()
        )),
        Err(_) => fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|e| format!("{}: {e}", path.display())),
    }
}

/// Security round 1 (MUST 2): one install at a time (the CLI's and the app's share `new` and `backup`). A second
/// one fails at once instead of waiting behind the first.
fn lock(work: &Path) -> Result<fs::File, String> {
    let path = work.join("lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        // Round 5: O_NONBLOCK, so a planted FIFO fails at once (ENXIO) instead of waiting for a reader.
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(format!("refused: {} is not a regular file", path.display()));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("refused: another update is installing now; try again when it ends".into());
    }
    Ok(file)
}

fn tool(
    cmd: &mut Command,
    name: &str,
    scratch: &Path,
    time: std::time::Duration,
) -> Result<(), String> {
    run_limited(cmd, name, scratch, time, || Ok(()))
}

/// Puts `staged` where `bundle` is, keeping `bundle` at `backup`, then runs `replace`; when it fails the backup goes back.
fn swap(
    bundle: &Path,
    staged: &Path,
    backup: &Path,
    replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _ = fs::remove_dir_all(backup); // the backup of the update before
    fs::create_dir_all(backup.parent().ok_or("bad backup path")?).map_err(|e| e.to_string())?;
    fs::rename(bundle, backup).map_err(|e| format!("cannot move the running build aside: {e}"))?;
    if let Err(e) = fs::rename(staged, bundle) {
        let _ = fs::rename(backup, bundle);
        return Err(format!("cannot put the new build in place: {e}"));
    }
    let failed = match replace() {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let restored = fs::rename(bundle, staged).and_then(|()| fs::rename(backup, bundle));
    let _ = fs::remove_dir_all(staged);
    match restored {
        Ok(()) => Err(format!("{failed}. The previous build was put back.")),
        Err(e) => Err(format!(
            "{failed}. Putting the previous build back failed too ({e}); it is in {}.",
            backup.display()
        )),
    }
}

/// How long the new build's `serve update` may take: its own waits (the idle exit, the next core's start, 40 s) fit
/// well inside. A candidate that hangs is stopped here and the failure goes through the restore in `swap`.
const SERVE_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Round 7: its output is not read (it goes to /dev/null); `replace_core` decides by the exit status and by what it
/// checks afterwards (the core's commit and every session back).
fn serve_update(home: &Path, bundle: &Path, time: std::time::Duration) -> Result<(), String> {
    run_limited(
        Command::new(bundle.join("Contents/MacOS/nunchiro"))
            .args(["serve", "update"])
            .env("NUNCHIRO_HOME", home)
            .env_remove("NUNCHIRO_TOKEN"),
        "the new build's serve update",
        home,
        time,
        || Ok(()),
    )
}

/// The new bundle's core takes over; it must then run the new commit and serve every session that ran before.
fn replace_core(home: &Path, bundle: &Path, commit: &str, before: &[String]) -> Result<(), String> {
    serve_update(home, bundle, SERVE_LIMIT)?;
    let record: serde_json::Value = read_small(&home.join("core.start.json"), RECORD_MAX)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let core = record["commit"].as_str().unwrap_or_default();
    if !same_commit(core, commit) {
        // The usual cause: serve update keeps a core whose exit would lose a running chat, a queued send or an old
        // session holder (it said "kept"; round 7 no longer reads its words, the commit tells the same).
        return Err(format!(
            "the core still runs {}, not the new build {commit}: a running chat, a queued send or an old session holder keeps it. Install again when it ends",
            if core.is_empty() {
                "an unknown commit"
            } else {
                core
            }
        ));
    }
    // The new core reattaches each holder at start and retries one that is still busy with the old core every few
    // seconds (ticket 385); a session is back once its output can be read again.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let after = sessions(home).map_err(|e| format!("the new core does not answer: {e}"))?;
        let lost: Vec<&String> = before
            .iter()
            .filter(|id| {
                let read = Request::Read {
                    id: (*id).clone(),
                    after: 0,
                };
                !after.contains(id) || call(home, read).is_err()
            })
            .collect();
        if lost.is_empty() {
            break;
        }
        if std::time::Instant::now() >= until {
            return Err(format!(
                "{} session(s) did not come back within 30 s: {lost:?}",
                lost.len()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Ok(())
}

/// The ids of the sessions that run now.
fn sessions(home: &Path) -> Result<Vec<String>, String> {
    match call(home, Request::List)? {
        Reply::Snapshot { sessions, .. } => Ok(sessions
            .into_iter()
            .filter(|s| s.state == SessionState::Running)
            .map(|s| s.id)
            .collect()),
        other => Err(format!("unexpected reply {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update_claims::claim;
    use std::os::unix::fs::PermissionsExt;

    const NEW: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// A folder as the build script leaves it: a bundle with `id` and two executables, and a stamp for them.
    fn folder(name: &str, id: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nunchiro-1082-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let macos = dir.join(APP).join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        for d in [&dir, &dir.join(APP)] {
            fs::set_permissions(d, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            dir.join(APP).join("Contents/Info.plist"),
            format!("<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>{id}</string>\n</dict></plist>"),
        )
        .unwrap();
        fs::write(macos.join("nunchiro"), "cli").unwrap();
        fs::write(macos.join("nunchiro-app"), "app").unwrap();
        let sha256 = hashes(&macos).unwrap();
        let stamp = serde_json::json!({"commit": NEW, "built": "2026-11-23T10:00:00Z", "sha256": sha256, "tree": dir});
        fs::write(dir.join(STAMP), stamp.to_string()).unwrap();
        dir
    }

    #[test]
    fn a_build_without_an_update_repo_refuses_to_install() {
        let why = update_repo(None).unwrap_err();
        assert!(
            why.contains("names no update repository; set NUNCHIRO_UPDATE_REPO"),
            "{why}"
        );
        assert!(!why.contains("github.com"), "{why}");
        assert_eq!(update_repo(Some("file:///o.git")), Ok("file:///o.git"));
    }

    #[test]
    fn a_stamp_of_another_commit_with_matching_hashes_is_ready() {
        let dir = folder("ready", OWNER_ID);
        let stamp = ready(&dir, "aaaaaaaaa").unwrap().unwrap();
        assert_eq!(stamp.commit, NEW);
        // the running build itself, by its short sha
        assert!(ready(&dir, &NEW[..9]).unwrap().is_none());
        fs::remove_file(dir.join(STAMP)).unwrap();
        assert!(ready(&dir, "aaaaaaaaa").unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_hash_mismatch_is_refused() {
        let dir = folder("hash", OWNER_ID);
        fs::write(dir.join(APP).join("Contents/MacOS/nunchiro"), "other").unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("sha256 of nunchiro does not match"), "{why}");
        // an executable the stamp does not name
        let dir = folder("extra", OWNER_ID);
        fs::write(dir.join(APP).join("Contents/MacOS/extra"), "x").unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("sha256 of extra"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wrong_bundle_id_is_refused() {
        let dir = folder("id", "dev.nunchiro.app.rc");
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("bundle id is dev.nunchiro.app.rc"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_world_writable_source_is_refused() {
        let dir = folder("writable", OWNER_ID);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("writable by group or others"), "{why}");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(dir.join(APP), fs::Permissions::from_mode(0o775)).unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("writable by group or others"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_symlinked_bundle_root_is_refused() {
        let dir = folder("link", OWNER_ID);
        let real = dir.join("Real.app");
        fs::rename(dir.join(APP), &real).unwrap();
        std::os::unix::fs::symlink(&real, dir.join(APP)).unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("is a symlink"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_core_replace_puts_the_backup_back() {
        let dir = std::env::temp_dir().join(format!("nunchiro-1082-swap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (bundle, staged, backup) = (
            dir.join(APP),
            dir.join("w/new").join(APP),
            dir.join("w/backup").join(APP),
        );
        for (d, text) in [(&bundle, "old"), (&staged, "new")] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("which"), text).unwrap();
        }
        let why = swap(&bundle, &staged, &backup, || {
            Err("the core did not start".into())
        })
        .unwrap_err();
        assert_eq!(
            why,
            "the core did not start. The previous build was put back."
        );
        assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
        assert!(!staged.exists() && !backup.exists());
        // and a replace that works keeps the new build and the old one as the backup
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("which"), "new").unwrap();
        swap(&bundle, &staged, &backup, || Ok(())).unwrap();
        assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "new");
        assert_eq!(fs::read_to_string(backup.join("which")).unwrap(), "old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_isolated_test_build_never_updates_itself() {
        let dir = folder("isolated", "dev.nunchiro.app.rc");
        let exe = dir.join(APP).join("Contents/MacOS/nunchiro");
        let why = installed(&exe).unwrap_err();
        assert!(
            why.contains("isolated test build (dev.nunchiro.app.rc)"),
            "{why}"
        );
        let dir = folder("owner", OWNER_ID);
        assert_eq!(
            installed(&dir.join(APP).join("Contents/MacOS/nunchiro")).unwrap(),
            dir.join(APP)
        );
        // where cargo and tauri build it is not an install
        for exe in [
            "/n/target/debug/nunchiro",
            "/n/target/release/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro",
        ] {
            assert!(installed(Path::new(exe)).is_err(), "{exe}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// An installed bundle's folder in `dir` and its work folder (not made).
    fn installed_in(dir: &Path) -> (PathBuf, PathBuf) {
        let at = dir.join("installed");
        fs::create_dir_all(&at).unwrap();
        (at.join(APP), at.join(WORK))
    }

    #[test]
    fn a_second_install_fails_at_once_and_touches_nothing() {
        let dir = folder("lock", OWNER_ID);
        let (bundle, work) = installed_in(&dir);
        let theirs = work.join("new").join(APP);
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join("which"), "theirs").unwrap();
        let held = lock(&work).unwrap();
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            "aaaaaaaaa",
            "",
            || Ok(vec![]),
        )
        .unwrap_err();
        assert!(why.contains("another update is installing"), "{why}");
        assert_eq!(fs::read_to_string(theirs.join("which")).unwrap(), "theirs");
        drop(held);
        // free again: the next install gets past the lock (and stops here: the folder holds this build)
        let why = install(&dir, &bundle, Candidate::Folder(&dir), NEW, "", || {
            Ok(vec![])
        })
        .unwrap_err();
        assert_eq!(why, "no new build is ready");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_linked_staging_folder_is_refused_and_its_target_kept() {
        for part in ["backup", "new", ""] {
            let dir = folder(&format!("link-{part}"), OWNER_ID);
            let outside = dir.join("outside");
            fs::create_dir_all(outside.join(APP)).unwrap();
            fs::write(outside.join(APP).join("which"), "keep").unwrap();
            let (bundle, work) = installed_in(&dir);
            if part.is_empty() {
                std::os::unix::fs::symlink(&outside, &work).unwrap();
            } else {
                fs::create_dir_all(&work).unwrap();
                std::os::unix::fs::symlink(&outside, work.join(part)).unwrap();
            }
            let why = install(
                &dir,
                &bundle,
                Candidate::Folder(&dir),
                "aaaaaaaaa",
                "",
                || Ok(vec![]),
            )
            .unwrap_err();
            assert!(why.contains("is a link or not a folder"), "{part}: {why}");
            assert_eq!(
                fs::read_to_string(outside.join(APP).join("which")).unwrap(),
                "keep"
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn hashing_is_bounded_in_files() {
        let dir = folder("many", OWNER_ID);
        let macos = dir.join(APP).join("Contents/MacOS");
        for n in 0..MAX_FILES {
            fs::write(macos.join(format!("f{n}")), "x").unwrap();
        }
        let why = hashes(&macos).unwrap_err();
        assert!(why.contains("more than 32 files"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Bundles `a`, `b`, `c` and an empty claims folder place.
    fn homes(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nunchiro-1082-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for b in ["a", "b", "c"] {
            let macos = dir.join(b).join(APP).join("Contents/MacOS");
            fs::create_dir_all(&macos).unwrap();
            fs::write(macos.join("nunchiro"), "cli").unwrap();
        }
        dir.canonicalize().unwrap()
    }
    /// `home`'s core record says it was started from `<at>/Nunchiro.app`.
    fn record(home: &Path, at: &Path) {
        fs::create_dir_all(home).unwrap();
        let exe = at.join(APP).join("Contents/MacOS/nunchiro");
        fs::write(
            home.join("core.start.json"),
            serde_json::json!({"exe": exe}).to_string(),
        )
        .unwrap();
    }
    fn tree(dir: &Path) -> Vec<String> {
        let mut out = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p.clone());
                }
                out.push(format!(
                    "{} {}",
                    p.display(),
                    fs::read(&p).map(|b| b.len()).unwrap_or(0)
                ));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn an_agent_home_cannot_update_an_app_another_home_claimed() {
        let dir = homes("agent-home");
        let (reg, a) = (dir.join("claims"), dir.join("a").join(APP));
        // the owner runs the app with a custom home, and no ~/.nunchiro exists in this test at all
        let owner = dir.join("owner-custom");
        record(&owner, &dir.join("a"));
        assert!(claim(&reg, &a, &owner).unwrap());
        // the agent's own home, its core started from the owner's app; its later claim takes nothing
        let agent = dir.join("agent");
        record(&agent, &dir.join("a"));
        assert!(!claim(&reg, &a, &agent).unwrap());
        fs::create_dir_all(dir.join("bare")).unwrap();
        let before = tree(&dir);
        let why = belongs(&agent, &a, Some(&reg)).unwrap_err();
        assert!(why.contains("is claimed by the home"), "{why}");
        let why = belongs(&dir.join("bare"), &a, Some(&reg)).unwrap_err();
        assert!(why.contains("is not the home of"), "{why}");
        let why = belongs(&agent, &a, None).unwrap_err();
        assert!(
            why.contains("no home folder for the update claims"),
            "{why}"
        );
        assert_eq!(tree(&dir), before, "a refusal changes no file");
        // the owner's custom home passes
        belongs(&owner, &a, Some(&reg)).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_isolated_copy_updates_its_own_app_only() {
        let dir = homes("iso-home");
        let reg = dir.join("claims");
        let iso = dir.join("iso");
        record(&iso, &dir.join("b"));
        assert!(claim(&reg, &dir.join("b").join(APP), &iso).unwrap());
        belongs(&iso, &dir.join("b").join(APP), Some(&reg)).unwrap();
        for other in ["a", "c"] {
            let why = belongs(&iso, &dir.join(other).join(APP), Some(&reg)).unwrap_err();
            assert!(why.contains("is not the home of"), "{other}: {why}");
        }
        // a home whose core ran from an app nobody claimed
        let new = dir.join("new");
        record(&new, &dir.join("c"));
        let why = belongs(&new, &dir.join("c").join(APP), Some(&reg)).unwrap_err();
        assert!(why.contains("no home has claimed"), "{why}");
        assert!(why.contains("open the Nunchiro app once"), "{why}");
        // a claims folder others can write is not trusted
        fs::set_permissions(&reg, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(belongs(&iso, &dir.join("b").join(APP), Some(&reg)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_planted_fifo_or_huge_file_reads_as_none() {
        let dir = homes("fifo");
        let fifo = |p: &Path| {
            let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        };
        // returns at once: a blocking read of a FIFO with no writer would hang this test
        fifo(&dir.join(SOURCE));
        assert!(source(&dir).is_none());
        fs::remove_file(dir.join(SOURCE)).unwrap();
        fs::write(dir.join(SOURCE), vec![b'/'; (1 << 20) + 1]).unwrap();
        assert!(source(&dir).is_none());
        let plist = dir.join("a").join(APP).join("Contents/Info.plist");
        fifo(&plist);
        assert!(bundle_id(&dir.join("a").join(APP)).is_none());
        fs::remove_file(&plist).unwrap();
        fs::write(&plist, vec![b' '; (1 << 20) + 1]).unwrap();
        assert!(bundle_id(&dir.join("a").join(APP)).is_none());
        // core.start.json as the install check reads it
        fifo(&dir.join("core.start.json"));
        assert!(recorded_bundle(&dir).is_none());
        // an executable or a stamp that is a FIFO is refused at once, not waited on (open first, judge the descriptor)
        let macos = dir.join("b").join(APP).join("Contents/MacOS");
        fifo(&macos.join("extra"));
        let why = hashes(&macos).unwrap_err();
        assert!(why.contains("is not a regular file"), "{why}");
        fifo(&dir.join(STAMP));
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("not a small regular file"), "{why}");
        // a link is not followed either
        fs::remove_file(macos.join("extra")).unwrap();
        std::os::unix::fs::symlink(macos.join("nunchiro"), macos.join("extra")).unwrap();
        assert!(hashes(&macos).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    const SMALL: Limits = Limits {
        entries: 50,
        bytes: 4096,
        headroom: 0,
        slack: 64 << 20,
        time: std::time::Duration::from_secs(60),
    };

    /// A candidate bundle with `files` files of `size` bytes each, and the staging place beside it.
    fn candidate(name: &str, files: usize, size: usize) -> (PathBuf, PathBuf) {
        let dir = folder(name, OWNER_ID);
        let res = dir.join(APP).join("Contents/Resources");
        fs::create_dir_all(&res).unwrap();
        for n in 0..files {
            fs::write(res.join(format!("r{n}")), vec![b'x'; size]).unwrap();
        }
        fs::create_dir_all(dir.join("w")).unwrap();
        (dir.join(APP), dir.join("w").join(APP))
    }

    #[test]
    fn an_oversized_or_crowded_bundle_is_refused_before_any_copy() {
        let (from, staged) = candidate("big", 1, 8192);
        let why = stage(&from, &staged, &SMALL).unwrap_err();
        assert!(why.contains("more than 4096 bytes"), "{why}");
        assert!(!staged.exists(), "nothing was copied");
        let (from2, staged2) = candidate("crowded", 60, 1);
        let why = stage(&from2, &staged2, &SMALL).unwrap_err();
        assert!(why.contains("more than 50 entries"), "{why}");
        assert!(!staged2.exists());
        fs::remove_dir_all(from2.parent().unwrap()).unwrap();
        fs::remove_dir_all(from.parent().unwrap()).unwrap();
        // round 5: any link is refused, even one that stays inside; with it gone the bundle stages
        let (from, staged) = candidate("links", 1, 1);
        let res = from.join("Contents/Resources");
        std::os::unix::fs::symlink("r0", res.join("inside")).unwrap();
        let why = stage(&from, &staged, &SMALL).unwrap_err();
        assert!(why.contains("a bundle holds no links"), "{why}");
        assert!(!staged.exists());
        fs::remove_file(res.join("inside")).unwrap();
        stage(&from, &staged, &SMALL).unwrap();
        fs::remove_dir_all(&staged).unwrap();
        // the free space the copy must leave
        let roomy = Limits {
            headroom: u64::MAX / 2,
            ..SMALL
        };
        let why = stage(&from, &staged, &roomy).unwrap_err();
        assert!(why.contains("bytes free"), "{why}");
        assert!(!staged.exists());
        fs::remove_dir_all(from.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_failed_copy_leaves_no_staging() {
        let (from, staged) = candidate("cut", 200, 4096);
        // a copy stopped by its time limit, after ditto started writing
        let cut = Limits {
            entries: 1000,
            bytes: 1 << 20,
            time: std::time::Duration::ZERO,
            ..SMALL
        };
        let why = stage(&from, &staged, &cut).unwrap_err();
        assert!(why.contains("did not end within"), "{why}");
        assert!(!staged.exists());
        // a copy that fails on its own, part way: a file sits where it must make the Contents folder
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("Contents"), "in the way").unwrap();
        let roomy = Limits {
            entries: 1000,
            bytes: 1 << 20,
            ..SMALL
        };
        let why = stage(&from, &staged, &roomy).unwrap_err();
        assert!(why.contains("ditto failed"), "{why}");
        assert!(!staged.exists());
        fs::remove_dir_all(from.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_restore_checks_that_the_restored_core_runs() {
        use std::cell::RefCell;
        // the old core never left: nothing to replace
        let called = RefCell::new(false);
        after_restore(
            || Some("aaaaaaaaa".into()),
            "aaaaaaaaa",
            || {
                *called.borrow_mut() = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(!*called.borrow());
        // the new (or a newer stamped) core runs: replaced, then read again
        let core = RefCell::new(NEW.to_string());
        after_restore(
            || Some(core.borrow().clone()),
            "aaaaaaaaa",
            || {
                *core.borrow_mut() = "aaaaaaaaa".into();
                Ok(())
            },
        )
        .unwrap();
        // still the new one afterwards, or the replace failed: said plainly
        let why = after_restore(|| Some(NEW.into()), "aaaaaaaaa", || Ok(())).unwrap_err();
        assert!(
            why.contains(&format!(
                "running core is {NEW} and not the restored build aaaaaaaaa"
            )),
            "{why}"
        );
        let why =
            after_restore(|| Some(NEW.into()), "aaaaaaaaa", || Err("kept".into())).unwrap_err();
        assert!(
            why.contains("(kept)") && why.contains("quit Nunchiro and open it again"),
            "{why}"
        );
    }

    #[test]
    fn a_restore_after_the_old_core_exited_and_the_new_one_failed_starts_the_restored_core() {
        use std::cell::RefCell;
        // Codex security look (1107): the old core exited, the new one failed before writing its record, so
        // core.start.json still names the restored commit but nothing answers.
        let dir = std::env::temp_dir().join(format!("nunchiro-1107-stale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("core.start.json"),
            serde_json::json!({"commit": "aaaaaaaaa"}).to_string(),
        )
        .unwrap();
        // a token, so the call reaches the socket and finds nobody there (with or without a session's token)
        fs::write(dir.join("core.token"), "test").unwrap();
        assert_eq!(core_commit(&dir).as_deref(), Some("aaaaaaaaa"));
        assert_eq!(
            live_commit(&dir),
            None,
            "a record with no core answering is no core"
        );
        // nothing restarts it: not reported as running
        let why = after_restore(|| live_commit(&dir), "aaaaaaaaa", || Ok(())).unwrap_err();
        assert!(
            why.contains("no core answers and not the restored build aaaaaaaaa"),
            "{why}"
        );
        // the replace is asked to start the restored core, and only a core that then answers counts
        let started = RefCell::new(false);
        after_restore(
            || started.borrow().then(|| "aaaaaaaaa".to_string()),
            "aaaaaaaaa",
            || {
                *started.borrow_mut() = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(*started.borrow());
        fs::remove_dir_all(dir).unwrap();
    }

    /// A stand-in core on `home`'s socket that answers every request with an empty snapshot, for tests that must not
    /// start a real core. Dropped with the test process. It writes the home's `core.token` too: without a session's
    /// NUNCHIRO_TOKEN (the gate) the CLI reads that file before it connects, and with neither the call fails and the
    /// restore would start a real core from this test binary.
    fn answering_core(home: &Path) {
        busy_core(home, 0, 0);
    }

    /// `answering_core` whose first `busy` exit_blockers answers say `count` (ticket 1130 A-D3); later ones say 0.
    /// Returns how many times it was asked.
    fn busy_core(
        home: &Path,
        count: usize,
        busy: usize,
    ) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
        use std::sync::atomic::Ordering;
        fs::write(home.join("core.token"), "test").unwrap();
        let line = |reply: serde_json::Value| {
            let reply: crate::Reply = serde_json::from_value(reply).unwrap();
            format!(
                "{}\n",
                serde_json::to_string(&Ok::<_, String>(reply)).unwrap()
            )
        };
        let snapshot = line(serde_json::json!({"type": "snapshot", "sessions": []}));
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = asked.clone();
        let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                use std::io::{BufRead, Write};
                let mut request = String::new();
                let _ = std::io::BufReader::new(&stream).read_line(&mut request);
                let reply = if request.contains(r#""op":"exit_blockers""#) {
                    let n = seen.fetch_add(1, Ordering::SeqCst);
                    let count = if n < busy { count } else { 0 };
                    line(serde_json::json!({"type": "exit_blockers", "count": count}))
                } else {
                    snapshot.clone()
                };
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        asked
    }

    // Ticket 1130 A-D3 (p05 U3): a busy core holds the install before the swap. Before, the bundle was swapped, the new
    // build's serve update kept the busy core, and the backup was put back: an install that failed by design.
    #[test]
    fn a_busy_core_holds_the_install_before_the_swap_and_a_freed_one_lets_it_go_on() {
        use std::sync::atomic::Ordering;
        let (url, c) = main_repo();
        for (busy, held) in [(usize::MAX, true), (2, false)] {
            let dir = folder(&format!("busy-{held}"), OWNER_ID);
            let mark = agent_bundle(&dir, &c[4]);
            let (bundle, work) = installed_in(&dir);
            fs::create_dir_all(&bundle).unwrap();
            fs::write(bundle.join("which"), "old").unwrap();
            fs::write(
                dir.join("core.start.json"),
                serde_json::json!({"commit": &c[1][..9]}).to_string(),
            )
            .unwrap();
            let asked = busy_core(&dir, 2, busy);
            let why = install(
                &dir,
                &bundle,
                Candidate::Folder(&dir),
                &c[1][..9],
                url,
                || Ok(vec![]),
            )
            .unwrap_err();
            if held {
                assert!(
                    why.contains("2 chat(s) or job(s) still need the running core after 2 s")
                        && why.contains("nothing was changed"),
                    "{why}"
                );
                assert!(!mark.exists(), "the candidate never ran");
            } else {
                // freed: it went on to the swap; the stand-in core then fails the commit check, as in the feed test
                assert!(why.contains("The previous build was put back"), "{why}");
                assert!(mark.exists(), "the candidate's serve update ran");
            }
            assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
            assert_eq!(fs::read_dir(work.join("new")).unwrap().count(), 0);
            assert!(
                asked.load(Ordering::SeqCst) >= 3,
                "it asked again while busy"
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    /// Ticket 1130 A-D3 round 2: a stand-in core whose every exit_blockers reply is `answer` writing to the open socket.
    fn odd_core(name: &str, answer: fn(&mut std::os::unix::net::UnixStream)) -> PathBuf {
        use std::io::BufRead;
        let home =
            std::env::temp_dir().join(format!("nunchiro-1130-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("core.token"), "test").unwrap();
        let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = String::new();
                let _ = std::io::BufReader::new(&stream).read_line(&mut request);
                answer(&mut stream);
            }
        });
        home
    }

    /// `wait_until_idle` with `limit`, in a thread: its result and how long it took, or a failure 5 s past the limit.
    fn timed_wait(
        home: &Path,
        limit: std::time::Duration,
    ) -> (Result<(), String>, std::time::Duration) {
        let home = home.to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel();
        let start = std::time::Instant::now();
        std::thread::spawn(move || {
            let _ = tx.send(wait_until_idle(&home, limit));
        });
        let result = rx
            .recv_timeout(limit + std::time::Duration::from_secs(5))
            .expect("the wait ran 5 s past its limit");
        (result, start.elapsed())
    }

    fn drip(stream: &mut std::os::unix::net::UnixStream) {
        use std::io::Write;
        for _ in 0..100 {
            if stream.write_all(b" ").is_err() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    fn zero_line() -> String {
        let reply: crate::Reply =
            serde_json::from_value(serde_json::json!({"type": "exit_blockers", "count": 0}))
                .unwrap();
        format!(
            "{}\n",
            serde_json::to_string(&Ok::<_, String>(reply)).unwrap()
        )
    }

    // Ticket 1130 A-D3 round 2 (Codex MUST): a core that drips bytes with no newline cannot hold the updater lock and
    // the staged bundle past the wait limit; before, each byte renewed the 15 s idle read and the wait never ended.
    #[test]
    fn a_reply_that_never_ends_cannot_hold_the_wait_past_its_limit() {
        let home = odd_core("drip", drip);
        let limit = std::time::Duration::from_millis(300);
        let (result, took) = timed_wait(&home, limit);
        let why = result.unwrap_err();
        assert!(why.contains("nothing was changed"), "{why}");
        assert!(
            took < limit + std::time::Duration::from_secs(1),
            "it took {took:?}"
        );
        fs::remove_dir_all(home).unwrap();
    }

    // Ticket 1130 A-D3 round 2 (Codex MUST): a 0 that comes after the limit is refused, whether the core was silent or
    // dripped bytes before it; before, a late 0 let the install go on to the swap.
    #[test]
    fn a_zero_after_the_limit_is_refused() {
        fn silent_then_zero(stream: &mut std::os::unix::net::UnixStream) {
            use std::io::Write;
            std::thread::sleep(std::time::Duration::from_millis(600));
            let _ = stream.write_all(zero_line().as_bytes());
        }
        fn drip_then_zero(stream: &mut std::os::unix::net::UnixStream) {
            use std::io::Write;
            for _ in 0..10 {
                let _ = stream.write_all(b" ");
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = stream.write_all(zero_line().as_bytes());
        }
        for (name, answer) in [
            ("late-silent", silent_then_zero as fn(&mut _)),
            ("late-drip", drip_then_zero),
        ] {
            let home = odd_core(name, answer);
            let (result, took) = timed_wait(&home, std::time::Duration::from_millis(300));
            let why = result.expect_err(name);
            assert!(why.contains("nothing was changed"), "{name}: {why}");
            assert!(
                took < std::time::Duration::from_millis(550),
                "{name}: it took {took:?}"
            );
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn links_anywhere_in_a_candidate_are_refused() {
        // "a -> ../.." and "b -> a/../outside": each passes a lexical check, and b leads outside the bundle
        for under in ["Contents/Resources", "Contents/MacOS"] {
            let dir = folder(&format!("two-links-{}", under.len()), OWNER_ID);
            fs::create_dir_all(dir.join("outside")).unwrap();
            let at = dir.join(APP).join(under);
            fs::create_dir_all(&at).unwrap();
            std::os::unix::fs::symlink("../..", at.join("a")).unwrap();
            std::os::unix::fs::symlink("a/../outside", at.join("b")).unwrap();
            let why = ready(&dir, "aaaaaaaaa").err().unwrap();
            assert!(why.contains("a bundle holds no links"), "{under}: {why}");
            fs::remove_dir_all(dir).unwrap();
        }
        // a linked MacOS folder is refused before any hash is read through it
        let dir = folder("linked-macos", OWNER_ID);
        let macos = dir.join(APP).join("Contents/MacOS");
        fs::rename(&macos, dir.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere"), &macos).unwrap();
        let why = ready(&dir, "aaaaaaaaa").err().unwrap();
        assert!(why.contains("a bundle holds no links"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_planted_fifo_lock_fails_at_once() {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-1082-fifo-lock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let c = std::ffi::CString::new(dir.join("lock").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(lock(&dir).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_candidate_whose_cli_hangs_or_floods_is_rolled_back() {
        let dir = std::env::temp_dir().join(format!("nunchiro-1082-hang-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (bundle, staged, backup) = (
            dir.join(APP),
            dir.join("w/new").join(APP),
            dir.join("w/backup").join(APP),
        );
        let cli = |b: &Path, script: &str| {
            let macos = b.join("Contents/MacOS");
            fs::create_dir_all(&macos).unwrap();
            fs::write(macos.join("nunchiro"), script).unwrap();
            fs::set_permissions(macos.join("nunchiro"), fs::Permissions::from_mode(0o755)).unwrap();
        };
        let alive = |pid: i32| unsafe { libc::kill(pid, 0) } == 0;
        let bg = dir.join("bg.pid");
        let pid = || -> i32 { fs::read_to_string(&bg).unwrap().trim().parse().unwrap() };
        // a hanging CLI with a background child: stopped at 1 s, both gone, the previous build back
        cli(&bundle, "#!/bin/sh\necho old\n");
        cli(
            &staged,
            &format!(
                "#!/bin/sh\nsleep 30 &\necho $! > {}\nexec sleep 30\n",
                bg.display()
            ),
        );
        let started = std::time::Instant::now();
        let why = swap(&bundle, &staged, &backup, || {
            serve_update(&dir, &bundle, std::time::Duration::from_secs(1))
        })
        .unwrap_err();
        assert!(
            why.contains("did not end within 1 s") && why.contains("put back"),
            "{why}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(
            fs::read_to_string(bundle.join("Contents/MacOS/nunchiro"))
                .unwrap()
                .contains("echo old")
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            !alive(pid()),
            "the background child was killed with the group"
        );
        // round 7: a CLI that ends at once but leaves a background child: the child is gone after the call too
        cli(
            &staged,
            &format!(
                "#!/bin/sh\nsleep 30 &\necho $! > {}\nexit 0\n",
                bg.display()
            ),
        );
        serve_update(&dir, &staged, std::time::Duration::from_secs(20)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            !alive(pid()),
            "a background child does not outlive the call"
        );
        // a CLI that writes without end (and a background writer) can grow no file: its output is /dev/null
        let files = || {
            let mut n = vec![];
            for e in fs::read_dir(&dir).unwrap() {
                let e = e.unwrap();
                n.push((e.file_name(), e.metadata().unwrap().len()));
            }
            n.sort();
            n
        };
        fs::remove_file(&bg).unwrap();
        let before = files();
        cli(&staged, "#!/bin/sh\nyes > /dev/stderr &\nexec yes\n");
        let why = serve_update(&dir, &staged, std::time::Duration::from_secs(1)).unwrap_err();
        assert!(why.contains("did not end within 1 s"), "{why}");
        assert_eq!(files(), before, "no file grew in the home");
        // and a failed exit is a failure, whatever it would have printed
        cli(&staged, "#!/bin/sh\necho replaced\nexit 3\n");
        let why = serve_update(&dir, &staged, std::time::Duration::from_secs(20)).unwrap_err();
        assert!(why.contains("failed (exit status: 3)"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_session_snapshot_stops_the_install_with_nothing_changed() {
        let dir = folder("snapshot", OWNER_ID);
        let (bundle, work) = installed_in(&dir);
        let before = tree(&dir);
        // a home with no core: the real snapshot fails, as it does when the core does not answer
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            "aaaaaaaaa",
            "",
            || sessions(&dir),
        )
        .unwrap_err();
        assert!(why.contains("the running sessions cannot be read"), "{why}");
        assert!(why.contains("nothing was changed"), "{why}");
        assert!(!work.exists());
        assert_eq!(tree(&dir), before);
        fs::remove_dir_all(dir).unwrap();
    }

    /// Writes the stamp for the bundle in `dir` as it is now, built from `dir`.
    fn stamp_for(dir: &Path, commit: &str) {
        let sha256 = hashes(&dir.join(APP).join("Contents/MacOS")).unwrap();
        let stamp = serde_json::json!({"commit": commit, "built": "2026-11-24T09:00:00Z", "sha256": sha256, "tree": dir});
        fs::write(dir.join(STAMP), stamp.to_string()).unwrap();
    }

    /// Part B: the bundle an agent builds into the folder: this app's id, a real main executable, a CLI that leaves a
    /// mark when it runs, signed ad hoc, with a stamp whose hashes match (commit `commit`). Returns the mark's path.
    fn agent_bundle(dir: &Path, commit: &str) -> PathBuf {
        let mark = dir.join("candidate-ran");
        let app = dir.join(APP);
        let _ = fs::remove_dir_all(&app);
        let macos = app.join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::set_permissions(&app, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key>\n<string>{OWNER_ID}</string>\n<key>CFBundleExecutable</key><string>nunchiro-app</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        fs::copy("/usr/bin/true", macos.join("nunchiro-app")).unwrap();
        let cli = macos.join("nunchiro");
        fs::write(&cli, format!("#!/bin/sh\ntouch {}\n", mark.display())).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let signed = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "-s", "-"])
            .arg(&app)
            .output()
            .unwrap();
        assert!(signed.status.success(), "{signed:?}");
        let valid = Command::new("/usr/bin/codesign")
            .arg("-v")
            .arg(&app)
            .output()
            .unwrap();
        assert!(
            valid.status.success(),
            "the premise: codesign -v passes ({valid:?})"
        );
        stamp_for(dir, commit);
        mark
    }

    #[test]
    fn an_adhoc_signed_stray_build_off_main_or_older_is_refused_at_install_before_it_runs() {
        // The Codex finding within option 0, in a debug and (cargo test --release) a release build of this check: a
        // correctly hashed, validly ad hoc signed build whose commit is not on main, only a second parent, or older.
        let (url, c) = main_repo();
        for (commit, said) in [
            (
                "cccccccccccccccccccccccccccccccccccccccc",
                "is not on main's first-parent history",
            ),
            (c[2].as_str(), "is not on main's first-parent history"),
            (c[0].as_str(), "is not newer on main"),
        ] {
            let dir = folder("order", OWNER_ID);
            let mark = agent_bundle(&dir, commit);
            let (bundle, _) = installed_in(&dir);
            let why = install(
                &dir,
                &bundle,
                Candidate::Folder(&dir),
                &c[1][..9],
                url,
                || Ok(vec![]),
            )
            .unwrap_err();
            assert!(why.contains(said), "{commit}: {why}");
            assert!(!mark.exists() && !bundle.exists());
            fs::remove_dir_all(dir).unwrap();
        }
        // a short sha in the stamp is refused at install (the order needs the exact commit)
        let dir = folder("short", OWNER_ID);
        agent_bundle(&dir, &c[4][..12]);
        let (bundle, _) = installed_in(&dir);
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            &c[1][..9],
            url,
            || Ok(vec![]),
        )
        .unwrap_err();
        assert!(why.contains("full 40-character sha"), "{why}");
        // offline: refused, with the reason
        stamp_for(&dir, &c[4]);
        let why = install(
            &dir,
            &bundle,
            Candidate::Folder(&dir),
            &c[1][..9],
            "file:///nonexistent/nunchiro-1082b",
            || Ok(vec![]),
        )
        .unwrap_err();
        assert!(why.contains("main could not be fetched"), "{why}");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Ticket 1107: the feed archive exactly as build-release.sh makes it from `dir` (`Nunchiro.app` and the stamp, no
    /// macOS metadata), plus `extra` names in `dir`.
    fn archive_of(dir: &Path, extra: &[&str]) -> PathBuf {
        let archive = dir.join("Nunchiro.app.tar.gz");
        let out = Command::new("/usr/bin/tar")
            .env("COPYFILE_DISABLE", "1")
            .args(["--no-mac-metadata", "-C"])
            .arg(dir)
            .arg("-czf")
            .arg(&archive)
            .args([APP, STAMP])
            .args(extra)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        archive
    }

    #[test]
    fn a_feed_archive_goes_through_the_whole_install_and_an_injected_failure_restores_app_and_core()
    {
        let (url, c) = main_repo();
        let dir = folder("feed", OWNER_ID);
        // the candidate's serve update runs and exits 0, but no new core takes over: the injected failure, found by
        // the commit check after it. Both executables are Mach-O, as in a release: a script's signature lives in
        // extended attributes, which the archive does not carry.
        agent_bundle(&dir, &c[4]);
        let macos = dir.join(APP).join("Contents/MacOS");
        fs::remove_file(macos.join("nunchiro")).unwrap();
        fs::copy("/usr/bin/true", macos.join("nunchiro")).unwrap();
        let signed = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "-s", "-"])
            .arg(dir.join(APP))
            .output()
            .unwrap();
        assert!(signed.status.success(), "{signed:?}");
        stamp_for(&dir, &c[4]);
        let archive = archive_of(&dir, &[]);
        fs::remove_dir_all(dir.join(APP)).unwrap();
        fs::remove_file(dir.join(STAMP)).unwrap();
        let (bundle, work) = installed_in(&dir);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("which"), "old").unwrap();
        // the running core is this build: it answers, and its record says so
        fs::write(
            dir.join("core.start.json"),
            serde_json::json!({"commit": &c[1][..9]}).to_string(),
        )
        .unwrap();
        answering_core(&dir);
        let why = install(
            &dir,
            &bundle,
            Candidate::Archive(&archive),
            &c[1][..9],
            url,
            || Ok(vec!["s1".into()]),
        )
        .unwrap_err();
        // only the check after the candidate's serve update says this: the unpacked build was swapped in and ran
        assert!(
            why.contains(&format!("the core still runs {}", &c[1][..9]))
                && why.contains("The previous build was put back. Its core runs again."),
            "{why}"
        );
        assert_eq!(fs::read_to_string(bundle.join("which")).unwrap(), "old");
        assert!(
            !work.join("feed").exists(),
            "the unpacked archive is removed"
        );
        assert_eq!(fs::read_dir(work.join("new")).unwrap().count(), 0);
        // Part B judges an archive as it judges a folder: the same build is not newer than itself
        let why = install(
            &dir,
            &bundle,
            Candidate::Archive(&archive),
            &c[4][..9],
            url,
            || Ok(vec![]),
        )
        .unwrap_err();
        assert_eq!(why, "no new build is ready");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_feed_archive_with_more_than_the_bundle_and_stamp_or_no_archive_is_refused() {
        let dir = folder("feed-extra", OWNER_ID);
        fs::write(dir.join("extra"), "x").unwrap();
        let archive = archive_of(&dir, &["extra"]);
        let (bundle, work) = installed_in(&dir);
        let refused = |archive: &Path| {
            install(
                &dir,
                &bundle,
                Candidate::Archive(archive),
                "aaaaaaaaa",
                "",
                || Ok(vec![]),
            )
            .unwrap_err()
        };
        let why = refused(&archive);
        assert!(
            why.contains(r#"holds ["Nunchiro.app", "extra", "nunchiro-build.json"]"#),
            "{why}"
        );
        fs::write(&archive, "not a tar").unwrap();
        let why = refused(&archive);
        assert!(why.contains("the archive does not unpack"), "{why}");
        let fifo = dir.join("fifo");
        let path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let why = refused(&fifo);
        assert!(why.contains("is not a regular file"), "{why}");
        assert!(!work.join("feed").exists() && !bundle.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    /// A throwaway origin whose main is c0 - c1 - merge(c2, side) - c3 on its first-parent line, with `side` merged as a
    /// second parent. Its file URL and the commits [c0, c1, side, c2, c3]. Made once per test process.
    fn main_repo() -> &'static (String, Vec<String>) {
        static REPO: std::sync::OnceLock<(String, Vec<String>)> = std::sync::OnceLock::new();
        REPO.get_or_init(|| {
            let dir =
                std::env::temp_dir().join(format!("nunchiro-1082b-origin-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let git = |args: &[&str]| {
                let out = Command::new("/usr/bin/git")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .args([
                        "-c",
                        "user.name=t",
                        "-c",
                        "user.email=t@example.invalid",
                        "-c",
                        "core.hooksPath=/dev/null",
                    ])
                    .arg("-C")
                    .arg(&dir)
                    .args(args)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{args:?}: {out:?}");
                String::from_utf8(out.stdout).unwrap().trim().to_string()
            };
            git(&["init", "-q", "-b", "main"]);
            let commit = |m: &str| {
                git(&["commit", "-q", "--allow-empty", "-m", m]);
                git(&["rev-parse", "HEAD"])
            };
            let (c0, c1) = (commit("c0"), commit("c1"));
            git(&["checkout", "-q", "-b", "side"]);
            let side = commit("side");
            git(&["checkout", "-q", "main"]);
            git(&["merge", "-q", "--no-ff", "-m", "c2", "side"]);
            let c2 = git(&["rev-parse", "HEAD"]);
            let c3 = commit("c3");
            (
                format!("file://{}", dir.display()),
                vec![c0, c1, side, c2, c3],
            )
        })
    }

    #[test]
    fn main_decides_which_build_is_newer() {
        let (url, c) = main_repo();
        let work = std::env::temp_dir().join(format!("nunchiro-1082b-line-{}", std::process::id()));
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work).unwrap();
        fs::set_permissions(&work, fs::Permissions::from_mode(0o700)).unwrap();
        let line = main_line(&work, url, None).unwrap();
        assert_eq!(
            line,
            [c[0].as_str(), &c[1], &c[3], &c[4]],
            "the first-parent line, oldest first; side is not on it"
        );
        assert!(
            !work.join("main-line").exists(),
            "the fetch folder is removed"
        );
        // later on main: newer, also by the short sha a build carries
        newer_on_main(&line, &c[4], &c[1][..9]).unwrap();
        // the same commit, or an older one rebuilt later (no time is read at all): refused
        for older in [&c[1], &c[0]] {
            let why = newer_on_main(&line, older, &c[1][..9]).unwrap_err();
            assert!(why.contains("is not newer on main"), "{why}");
        }
        // a commit only merged in as a second parent, or not on main at all
        for off in [c[2].as_str(), "dddddddddddddddddddddddddddddddddddddddd"] {
            let why = newer_on_main(&line, off, &c[0][..9]).unwrap_err();
            assert!(
                why.contains("is not on main's first-parent history"),
                "{why}"
            );
        }
        // a running build that is not on main cannot judge anything
        let why = newer_on_main(&line, &c[4], "eeeeeeeee").unwrap_err();
        assert!(why.contains("so no build can be judged newer"), "{why}");
        // offline (or no sign-in): refused, with the reason
        let why = main_line(&work, "file:///nonexistent/nunchiro-1082b", None).unwrap_err();
        assert!(why.contains("main could not be fetched"), "{why}");
        assert!(!work.join("main-line").exists());
        fs::remove_dir_all(work).unwrap();
    }

    /// Ticket 1112: a dumb-HTTP copy of `main_repo` on 127.0.0.1 that answers 401 to any request without the
    /// `x-access-token:tok1112` Basic sign-in, as a private GitHub repository does. Its URL. One per test process.
    fn private_repo() -> &'static str {
        static URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        URL.get_or_init(|| {
            let (origin, _) = main_repo();
            let bare =
                std::env::temp_dir().join(format!("nunchiro-1112-bare-{}", std::process::id()));
            let _ = fs::remove_dir_all(&bare);
            for args in [
                &[
                    "clone",
                    "-q",
                    "--bare",
                    origin.as_str(),
                    bare.to_str().unwrap(),
                ][..],
                &["-C", bare.to_str().unwrap(), "update-server-info"],
            ] {
                let out = Command::new("/usr/bin/git")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .args(args)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{args:?}: {out:?}");
            }
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/private.git", server.local_addr().unwrap());
            std::thread::spawn(move || {
                for stream in server.incoming().flatten() {
                    let bare = bare.clone();
                    std::thread::spawn(move || private_repo_request(stream, &bare));
                }
            });
            url
        })
    }

    /// Each connection gets its own worker: an idle connection must not prevent git opening another one.
    /// Only authenticated GETs below the bare repository root can read files.
    fn private_repo_request(mut stream: std::net::TcpStream, bare: &Path) {
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};
        let until = Instant::now() + Duration::from_secs(2);
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let remaining = until.saturating_duration_since(Instant::now());
            if header.len() >= 8192 || remaining.is_zero() {
                return;
            }
            if stream.set_read_timeout(Some(remaining)).is_err() {
                return;
            }
            let mut byte = [0];
            if stream.read_exact(&mut byte).is_err() {
                return;
            }
            header.push(byte[0]);
        }
        let Ok(header) = std::str::from_utf8(&header) else {
            return;
        };
        let signed = header.lines().skip(1).any(|line| {
            line.eq_ignore_ascii_case("authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9rMTExMg==")
        });
        let (status, body) = if !signed {
            (
                "401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"",
                Vec::new(),
            )
        } else {
            let mut request = header.lines().next().unwrap_or("").split_whitespace();
            let method = request.next();
            let path = request.next().unwrap_or("").split('?').next().unwrap_or("");
            let relative = path.strip_prefix("/private.git/").filter(|path| {
                !path.is_empty()
                    && path
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != "..")
                    && Path::new(path)
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_)))
            });
            // Check authorization and the complete path before any file read.
            match relative
                .filter(|_| method == Some("GET"))
                .and_then(|p| fs::read(bare.join(p)).ok())
            {
                Some(body) => ("200 OK", body),
                None => ("404 Not Found", Vec::new()),
            }
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(&body);
    }

    #[test]
    fn private_repo_bounds_and_authenticates_requests() {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpStream};
        use std::time::{Duration, Instant};
        let url = private_repo();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let request = |path: &str, signed: bool| {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let auth = if signed {
                "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9rMTExMg==\r\n"
            } else {
                ""
            };
            write!(stream, "GET {path} HTTP/1.1\r\n{auth}\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        // A connected client with no headers cannot block another authenticated request.
        let mut idle = TcpStream::connect(address).unwrap();
        idle.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        let started = Instant::now();
        assert!(request("/private.git/HEAD", true).starts_with("HTTP/1.1 200"));
        assert!(started.elapsed() < Duration::from_secs(2));
        for path in ["/private.git/HEAD", "/etc/passwd", "/private.git/../HEAD"] {
            assert!(request(path, false).starts_with("HTTP/1.1 401"));
        }
        for path in [
            "/etc/passwd",
            "/private.git//etc/passwd",
            "/private.git/../HEAD",
        ] {
            assert!(request(path, true).starts_with("HTTP/1.1 404"));
        }
        let mut byte = [0];
        assert_eq!(
            idle.read(&mut byte).unwrap(),
            0,
            "idle header read must expire"
        );
        let mut oversized = TcpStream::connect(address).unwrap();
        oversized
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        oversized.write_all(&vec![b'x'; 8193]).unwrap();
        oversized.shutdown(Shutdown::Write).unwrap();
        // Closing a socket with unread input can report either EOF or a reset.
        assert!(!matches!(oversized.read(&mut byte), Ok(n) if n > 0));
    }

    /// Ticket 1112: main of a repository that needs a sign-in is read with the token alone; without it, or with a wrong
    /// one, the install is refused. The user's git config stays unread: the test runs again as a child whose HOME and
    /// GIT_CONFIG_GLOBAL name a config with a credential helper that knows the token, a url rewrite that breaks the
    /// fetch and a hooks folder whose hook leaves a mark.
    #[test]
    fn a_private_main_is_read_with_the_token_only() {
        const CHILD: &str = "NUNCHIRO_TEST_1112_CHILD";
        let name = |s: &str| {
            std::env::temp_dir().join(format!("nunchiro-1112-{s}-{}", std::process::id()))
        };
        let (home, mark) = (name("home"), name("mark"));
        if std::env::var_os(CHILD).is_none() {
            let _ = fs::remove_dir_all(&home);
            fs::create_dir_all(home.join("hooks")).unwrap();
            let hook = home.join("hooks/reference-transaction");
            fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
            let config = home.join(".gitconfig");
            fs::write(
                &config,
                format!(
                    "[credential]\n\thelper = \"!f() {{ echo username=x-access-token; echo password=tok1112; }}; f\"\n\
                     [url \"http://127.0.0.1:1/\"]\n\tinsteadOf = {}\n\
                     [core]\n\thooksPath = {}\n",
                    private_repo().rsplit_once('/').unwrap().0,
                    home.join("hooks").display()
                ),
            )
            .unwrap();
            use std::os::unix::process::CommandExt;
            use std::process::Stdio;
            let log = home.join("child.log");
            let output = fs::File::create(&log).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "update::tests::a_private_main_is_read_with_the_token_only",
                ])
                .args(["--test-threads=1", "--nocapture"])
                .env(CHILD, "1")
                .env("HOME", &home)
                .env("XDG_CONFIG_HOME", &home)
                .env("GIT_CONFIG_GLOBAL", &config)
                .stdin(Stdio::null())
                .stdout(output.try_clone().unwrap())
                .stderr(output)
                .process_group(0)
                .spawn()
                .unwrap();
            let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if std::time::Instant::now() >= until {
                    // Kill only this test child's process group; its HTTP server closes with it.
                    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                    child.wait().unwrap();
                    panic!(
                        "private-repo test exceeded 60 seconds; child stopped: {}",
                        fs::read_to_string(&log).unwrap()
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            let text = fs::read_to_string(&log).unwrap();
            assert!(
                status.success() && text.contains("1 passed"),
                "{status}: {text}"
            );
            fs::remove_dir_all(home).unwrap();
            return;
        }
        let (_, c) = main_repo();
        let url = private_repo();
        let work = name("work");
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work).unwrap();
        fs::set_permissions(&work, fs::Permissions::from_mode(0o700)).unwrap();
        let line = main_line(&work, url, Some("tok1112")).unwrap();
        assert_eq!(line, [c[0].as_str(), &c[1], &c[3], &c[4]]);
        for token in [None, Some("wrong1112")] {
            let why = main_line(&work, url, token).unwrap_err();
            assert!(
                why.contains("main could not be fetched"),
                "{token:?}: {why}"
            );
            assert!(
                !why.contains("tok1112") && !why.contains("wrong1112"),
                "{why}"
            );
        }
        assert!(!mark.exists(), "a hook from the user's config ran");
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn a_session_token_cannot_run_update() {
        let why = owner_only(true).unwrap_err();
        assert!(why.contains("not for a session"), "{why}");
        assert!(owner_only(false).is_ok());
    }
}
