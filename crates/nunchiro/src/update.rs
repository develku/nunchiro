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
mod tests;
