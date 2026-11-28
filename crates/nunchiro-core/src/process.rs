//! Bounded subprocess output for launch preparation, outside the session registry lock.
use std::{
    ffi::OsStr,
    io::Read,
    os::{fd::AsRawFd, unix::ffi::OsStrExt, unix::process::CommandExt},
    path::PathBuf,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};
/// Bytes kept of a child's stdout (and stderr); a caller that sees this many knows the rest was cut.
pub const OUTPUT_CAP: usize = 65536;
/// Ticket 394 round 5: bytes a `drivers` lookup may return (every config name, a repository's whole index listing).
/// One that reaches it is refused, never read cut.
const LISTING_CAP: usize = 64 << 20;

/// Ticket 394: what a read never starts from a folder's own config: a signature check (`gpg.program` under
/// `log.showSignature`). `git_in` already refuses `ext::`. Command-line config wins over the repository's.
const READ_ONLY: [&str; 2] = ["-c", "log.showSignature=false"];

/// `git` in `dir`, read only: no optional locks (no index refresh), no fsmonitor hook, unquoted paths,
/// no prompt, no lazy fetch of a missing object (a promisor remote), nothing in `READ_ONLY`, no filter (`drivers`)
/// and no `merge-tree` while a merge driver is configured. The stdout of a successful run, else git's error.
/// Ticket 403 item 16b: stdout that reaches `OUTPUT_CAP` may be cut, so the read is refused (unknown, never a partial
/// answer); `git_read_cut` is for the callers that handle a cut listing themselves.
pub(crate) fn git_read(
    dir: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    read(dir, args, timeout, true)
}
/// `git_read` that returns stdout cut at `OUTPUT_CAP`: the caller tests `len() >= OUTPUT_CAP` itself.
pub(crate) fn git_read_cut(
    dir: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    read(dir, args, timeout, false)
}
/// Ticket 403 item 12: one deadline for the whole read, the filter listings of every submodule included.
fn read(
    dir: &std::path::Path,
    args: &[&str],
    timeout: Duration,
    whole: bool,
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + timeout;
    let recurse = RECURSES.contains(&subcommand(args));
    let (filters, merge_driver) = drivers(dir, recurse, deadline, LISTING_CAP)?;
    if merge_driver && subcommand(args) == "merge-tree" {
        return Err("git merge-tree: the folder configures a merge driver".into());
    }
    let args = fetch_args(args);
    let mut c = git_in(dir);
    c.args(READ_ONLY).args(&args).env("GIT_NO_LAZY_FETCH", "1");
    switch_off(&mut c, &filters)?;
    git_run(c, &args, left(deadline)?, whole)
}
/// Ticket 403 decision (item 9): a fetch never recurses into submodules, whatever the folder's config says.
fn fetch_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut args = args.to_vec();
    if let Some(at) = args.iter().step_by(2).position(|a| *a != "-c")
        && args[at * 2] == "fetch"
    {
        args.insert(at * 2 + 1, "--no-recurse-submodules");
    }
    args
}
/// The time left before `deadline`; none left is a timeout.
fn left(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "git: the read timed out".into())
}
/// Ticket 394 round 4: `git worktree remove` (no `--force`) runs a status inside `worktree` before removing it. That
/// status gets what a read gets (no fsmonitor, every filter of the worktree and its submodules switched off), and no
/// hook runs.
pub(crate) fn git_worktree_remove(
    project: &std::path::Path,
    worktree: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + timeout;
    // Ticket 403 item 4: `--force` runs no status (and the folder of a failed create may not be there to list).
    let filters = match args.contains(&"--force") {
        true => Default::default(),
        false => drivers(worktree, true, deadline, LISTING_CAP)?.0,
    };
    let mut c = git_in(project);
    c.args(crate::auto_pull::NO_HOOKS)
        .args(READ_ONLY)
        .args(args)
        .env("GIT_NO_LAZY_FETCH", "1");
    switch_off(&mut c, &filters)?;
    git_run(c, args, left(deadline)?, false)
}
/// Ticket 403 items 1, 2, 4: `git worktree add` (`args`) in `project`: what a read gets (`git_in`: scrubbed
/// environment, no fsmonitor, no `ext::`/`git://`/`http://`, git's error without a URL user part), no hook
/// (`post-checkout`), no submodule checkout, and every filter `project`'s config names switched off, so no file's
/// `.gitattributes` picks a program. A partial clone may still fetch the blobs the checkout needs, as in a terminal.
/// Round 2 (coordinator, after herdr, Orca and T3 Code): except `lfs`, so an LFS repository gets its real files; a
/// repo-local `filter.lfs` is trusted like the repo-local `core.sshCommand` kept on 11-11.
pub(crate) fn git_worktree_add(
    project: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let (mut filters, _) = drivers(project, false, deadline, LISTING_CAP)?;
    filters.remove(&b"lfs"[..]);
    let mut c = git_in(project);
    c.args(crate::auto_pull::NO_HOOKS)
        .args(crate::auto_pull::NO_SUBMODULES)
        .args(args);
    switch_off(&mut c, &filters)?;
    git_run(c, args, left(deadline)?, false).map(drop)
}
/// Ticket 403 item 7: what a git the core starts in a new folder (init, first commit, clone) never runs from the user's
/// or system config: no hook, no fsmonitor. `filters_off` switches off the filters.
pub(crate) const NO_PROGRAMS: [&str; 4] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
];
/// Ticket 403 item 7: every filter configured for `dir` (the user's and the system's config, and `dir`'s own when it is
/// inside a repository) switched off in `c`'s environment.
pub(crate) fn filters_off(
    c: &mut Command,
    dir: &std::path::Path,
    timeout: Duration,
) -> Result<(), String> {
    let (filters, _) = drivers(dir, false, Instant::now() + timeout, LISTING_CAP)?;
    switch_off(c, &filters)
}
/// Ticket 394 round 3: each filter switched off through the environment: no name is parsed as a `-c` argument, and git
/// hands these to the `git status` it starts inside a submodule. The count also replaces an inherited one. Round 4: the
/// key is the name's own bytes (a Unix environment carries any byte but NUL, and `-z` names hold none).
/// Ticket 403 item 21: more filter names than this refuse the run with a reason (their switch-offs could pass the
/// system's environment limit, and the spawn would fail with no reason given).
const MAX_FILTERS: usize = 1000;
/// Round 2: the names' total bytes, each written four times into the environment, under the same refusal.
const MAX_FILTER_BYTES: usize = 64 << 10;
fn switch_off(
    c: &mut Command,
    filters: &std::collections::BTreeSet<Vec<u8>>,
) -> Result<(), String> {
    supported()?;
    if filters.len() > MAX_FILTERS || filters.iter().map(Vec::len).sum::<usize>() > MAX_FILTER_BYTES
    {
        return Err("git: too many filters configured to switch off safely".into());
    }
    let mut count = 0;
    for name in filters {
        for (var, value) in [
            ("clean", ""),
            ("smudge", ""),
            ("process", ""),
            ("required", "false"),
        ] {
            let key = [b"filter.", &name[..], b".", var.as_bytes()].concat();
            c.env(
                format!("GIT_CONFIG_KEY_{count}"),
                std::ffi::OsStr::from_bytes(&key),
            )
            .env(format!("GIT_CONFIG_VALUE_{count}"), value);
            count += 1;
        }
    }
    c.env("GIT_CONFIG_COUNT", count.to_string());
    Ok(())
}
/// Ticket 403 item 11: whether this machine's git honours the switch-offs, asked once (`git --version`). A git that
/// cannot start is not remembered: the run itself then fails with git's own error.
fn supported() -> Result<(), String> {
    static CHECKED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    if let Some(known) = CHECKED.get() {
        return known.clone();
    }
    let mut c = command("git");
    c.arg("--version");
    let Ok(out) = output(c, Duration::from_secs(10)) else {
        return Ok(());
    };
    CHECKED
        .get_or_init(|| {
            let warning = minimum(&String::from_utf8_lossy(&out.stdout))?;
            if let Some(w) = warning {
                eprintln!("{w}");
            }
            Ok(())
        })
        .clone()
}
/// Ticket 403 item 11: git below 2.31 ignores `GIT_CONFIG_COUNT`, so no filter switch-off holds: refused. Below 2.44
/// `GIT_NO_LAZY_FETCH` is ignored, so a read in a partial clone may fetch a missing object from the clone's own
/// remote (never over `ext::`): a warning, not a refusal, as Apple's git 2.39 (Xcode 16) sits there. A version that
/// does not parse gets the warning too.
fn minimum(version: &str) -> Result<Option<String>, String> {
    let number = version
        .trim()
        .strip_prefix("git version ")
        .unwrap_or_default();
    let mut parts = number.split('.').map(|p| p.parse::<u32>().ok());
    let found = match (parts.next().flatten(), parts.next().flatten()) {
        (Some(major), Some(minor)) => (major, minor),
        _ => {
            return Ok(Some(format!(
                "git: unknown version {:?}; git 2.44 or later is expected",
                version.trim()
            )));
        }
    };
    if found < (2, 31) {
        return Err(format!(
            "git: version {number} is too old to read safely; git 2.31 or later is needed"
        ));
    }
    Ok((found < (2, 44)).then(|| {
        format!("git: version {number} may fetch a partial clone's missing objects during a read; git 2.44 or later avoids it")
    }))
}
/// Reads that look inside each populated submodule by starting `git status` there.
const RECURSES: [&str; 4] = ["status", "diff-index", "diff", "diff-files"];
/// Populated submodules nested deeper than this refuse such a read.
const SUBMODULE_DEPTH: usize = 3;
/// Ticket 394: every filter name configured for `dir` (its own config, the user's, the system's: git-lfs among them)
/// and whether any merge driver is configured. Round 3: for a read in `RECURSES`, each populated submodule's own config
/// too (`recurse`), nested up to `SUBMODULE_DEPTH`. Names are raw bytes: one need not be text. `cap`: `hardened`.
type Found = (std::collections::BTreeSet<Vec<u8>>, bool);
fn drivers(
    dir: &std::path::Path,
    recurse: bool,
    deadline: Instant,
    cap: usize,
) -> Result<Found, String> {
    let mut found = (std::collections::BTreeSet::new(), false);
    configured(dir, deadline, cap, &mut found)?;
    if recurse {
        submodules(dir, 1, deadline, cap, &mut found)?;
    }
    Ok(found)
}
/// Adds the filter names and whether a merge driver is set in the config git reads for `dir`.
fn configured(
    dir: &std::path::Path,
    deadline: Instant,
    cap: usize,
    (names, merge_driver): &mut Found,
) -> Result<(), String> {
    // Every name, matched here: git's `--get-regexp` misses a name that is not UTF-8 in a UTF-8 locale.
    let out = hardened(
        dir,
        &["config", "-z", "--name-only", "--list"],
        deadline,
        cap,
    )?;
    for key in out.split(|b| *b == 0) {
        // `section.name.variable` (git lowercases the section); `merge.ff` and the like name no driver.
        let Some(last) = key.iter().rposition(|b| *b == b'.') else {
            continue;
        };
        if let Some(name) = key[..last].strip_prefix(b"filter.") {
            names.insert(name.to_vec());
        } else if key[..last].starts_with(b"merge.") {
            *merge_driver = true;
        }
    }
    Ok(())
}
/// An `ls-files` line `submodules` cannot read refuses the read rather than skipping an entry that may be a gitlink.
const UNREAD: &str = "git ls-files: an entry the core cannot read";
/// Each populated submodule of `dir` (a gitlink whose folder holds a `.git`), its config and its own submodules. Round 8:
/// always listed, as git checks every gitlink it holds (no in-process guess at whether there is one).
fn submodules(
    dir: &std::path::Path,
    depth: usize,
    deadline: Instant,
    cap: usize,
    found: &mut Found,
) -> Result<(), String> {
    // `:/`: the whole work tree, as `status` checks it, with paths relative to `dir`.
    let index = hardened(dir, &["ls-files", "-s", "-z", "--", ":/"], deadline, cap)?;
    for entry in index.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        // `<mode> <object> <stage>\t<path>`, the mode in octal as the index holds it. Git takes an entry for a gitlink
        // by its type bits alone (`mode & 0170000 == 0160000`), so `160755` and `37777760000` are gitlinks here too.
        let (meta, path) = entry.split_at(entry.iter().position(|b| *b == b'\t').ok_or(UNREAD)?);
        let mode = meta.split(|b| *b == b' ').next().ok_or(UNREAD)?;
        let mode = std::str::from_utf8(mode)
            .ok()
            .and_then(|m| u64::from_str_radix(m, 8).ok());
        if mode.ok_or(UNREAD)? & 0o170000 != 0o160000 {
            continue;
        }
        let path = &path[1..];
        let sub = dir.join(std::ffi::OsStr::from_bytes(path));
        if sub.join(".git").symlink_metadata().is_err() {
            continue;
        }
        if depth > SUBMODULE_DEPTH {
            return Err("git: submodules nested too deep to read safely".into());
        }
        configured(&sub, deadline, cap, found)?;
        submodules(&sub, depth + 1, deadline, cap, found)?;
    }
    Ok(())
}
/// A listing git runs for `drivers` the way it runs a read; exit 1 (`config`: no such key) is an empty answer. Round 5:
/// up to `cap` bytes (`LISTING_CAP`; a test passes less); a listing that reaches it may be cut, so it is refused.
fn hardened(
    dir: &std::path::Path,
    args: &[&str],
    deadline: Instant,
    cap: usize,
) -> Result<Vec<u8>, String> {
    let mut c = git_in(dir);
    c.args(READ_ONLY).args(args).env("GIT_NO_LAZY_FETCH", "1");
    let out = output_capped(c, left(deadline)?, cap)?;
    if out.stdout.len() >= cap {
        return Err(format!(
            "git {}: the listing is too long to read safely",
            args[0]
        ));
    }
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(without_userinfo(&format!(
            "git {}: {}",
            args[0],
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(out.stdout)
}
/// Auto-pull's fast-forward: a checkout, so LFS files are smudged and a partial clone fetches the blobs it lacks, as
/// a `git merge` in a terminal would (never over `ext::`: `git_in`). Ticket 403 item 6: no signature check, so the
/// folder's `gpg.program` never starts; config from the core's environment is already gone (`scrub`).
pub(crate) fn git_update(
    dir: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut c = git_in(dir);
    c.args(["-c", "merge.verifySignatures=false"]).args(args);
    git_run(c, args, timeout, false)
}
/// The Diff panel's Push and the upstream it sets (git_write.rs): `git_in`'s environment (no `ext::`, no plain
/// `git://` or `http://`, no prompt), stdin closed; the folder's hooks run, as for a push in a terminal.
pub(crate) fn git_write(
    dir: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut c = git_in(dir);
    c.args(args).stdin(Stdio::null());
    git_run(c, args, timeout, false)
}
fn git_in(dir: &std::path::Path) -> Command {
    let mut c = command("git");
    c.arg("-C")
        .arg(dir)
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false"])
        // Ticket 394: an `ext::` URL (a command the folder's config names) never runs, read or update.
        .args(["-c", "protocol.ext.allow=never"])
        // Ticket 403 decision (item 9): no fetch over plain `git://` or `http://`, after `insteadOf` and redirects too.
        .args([
            "-c",
            "protocol.git.allow=never",
            "-c",
            "protocol.http.allow=never",
            // Round 2: ftp(s) is as plain as http.
            "-c",
            "protocol.ftp.allow=never",
            "-c",
            "protocol.ftps.allow=never",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    scrub(&mut c, std::env::vars_os().map(|(k, _)| k));
    c
}
/// Ticket 403 item 8: what no git child of the core inherits: the location variables (a core started from a git hook
/// would otherwise read that hook's repository), and config from the environment: `GIT_CONFIG_COUNT` and each
/// `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` among `inherited` (the core's variable names), `GIT_CONFIG_GLOBAL`,
/// `GIT_NAMESPACE`. A caller that sets its own count does so after this.
pub(crate) fn scrub(c: &mut Command, inherited: impl Iterator<Item = std::ffi::OsString>) {
    for k in crate::projects::HOOK_REPOSITORY_ENV {
        c.env_remove(k);
    }
    for k in inherited.filter(|k| {
        let k = k.as_bytes();
        k.starts_with(b"GIT_CONFIG_KEY_") || k.starts_with(b"GIT_CONFIG_VALUE_")
    }) {
        c.env_remove(k);
    }
}
/// Ticket 394: git's error carries no URL user part (`without_userinfo`), so every caller can log or show it.
/// `whole`: stdout that reaches `OUTPUT_CAP` is refused (`CUT`).
fn git_run(c: Command, args: &[&str], timeout: Duration, whole: bool) -> Result<Vec<u8>, String> {
    let out = output(c, timeout)?;
    if !out.status.success() {
        return Err(without_userinfo(&format!(
            "git {}: {}",
            subcommand(args),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if whole && out.stdout.len() >= OUTPUT_CAP {
        return Err(format!("git {}: {CUT}", subcommand(args)));
    }
    Ok(out.stdout)
}
/// Ticket 403 item 16b: the end of the error of a read whose output reached `OUTPUT_CAP`.
pub(crate) const CUT: &str = "the output is too long to read whole";
/// The subcommand after the callers' leading `-c <pair>`s.
fn subcommand<'a>(args: &[&'a str]) -> &'a str {
    args.iter().step_by(2).find(|a| **a != "-c").unwrap_or(&"")
}
/// `text` with every word cut to what follows its last `@`: a URL's `user:token@` goes in any form git prints it
/// (`https://u:t@host/x`, `u:t@host:9`, a path), never the host. Ticket 403 item 17: words split on whitespace only,
/// as a quote may sit inside the user part (`https://u:pa'ss@host`).
pub(crate) fn without_userinfo(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|w| match w.rsplit_once('@') {
            // The word's opening quotes stay: `'https://u:t@host/x'` prints as `'host/x'`.
            Some((_, host)) => {
                let quotes = w.len() - w.trim_start_matches(['\'', '"', '`']).len();
                [&w[..quotes], host].concat()
            }
            None => w.to_string(),
        })
        .collect()
}
/// V2-1b r3: for a `pre_exec`: the child starts a session of its own, so it is no longer inside the caller's.
pub fn setsid() -> std::io::Result<()> {
    if unsafe { libc::setsid() } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
/// Ticket 424: the file `execvp` would run for `name` on `path`, the PATH the child gets. Rust std forks the whole core
/// to run a bare name once the child's environment is cleared or its PATH set (posix_spawnp would search the core's
/// PATH); an absolute program starts by posix_spawn. Same order and executable check as execvp. The name stays as it
/// is when it holds a `/`, the child gets no PATH, nothing matches, or a relative entry comes first (it resolves
/// against the child's working folder), so such a run starts, or fails, exactly as before.
pub fn resolve_program(name: impl AsRef<OsStr>, path: Option<&OsStr>) -> PathBuf {
    let name = name.as_ref();
    let bare = PathBuf::from(name);
    let Some(path) = path.filter(|_| !name.is_empty() && !name.as_bytes().contains(&b'/')) else {
        return bare;
    };
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            return bare;
        }
        let file = dir.join(name);
        let runnable = std::ffi::CString::new(file.as_os_str().as_bytes())
            .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0);
        if runnable && file.is_file() {
            return file;
        }
    }
    bare
}
/// The PATH among `env`, the pairs a `Command` gets after `env_clear` (the last one wins, as in `Command::envs`).
pub fn env_path<K: AsRef<OsStr>, V: AsRef<OsStr>>(env: &[(K, V)]) -> Option<&OsStr> {
    env.iter()
        .rev()
        .find(|(k, _)| k.as_ref() == "PATH")
        .map(|(_, v)| v.as_ref())
}
/// Ticket 1024: a program the core starts for itself (`git` and every other tool, found on a PATH a restart takes from
/// the editable `core.start.json`) inherits the core's environment without its secret variables
/// (`user_env::secret_var`; the start secrets a restart restored are among them), so neither that program nor
/// `ps eww` of it sees one. Every `Command` of the core is made here (`core_commands_are_made_by_command`); a caller
/// that means to pass a variable sets it afterwards. A session is not made here: its environment is
/// `Sessions::seat_env`'s, and an agent gets its secrets as the owner's settings say.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(program);
    for (name, value) in std::env::vars_os() {
        if crate::user_env::secret_var(&name.to_string_lossy(), &value) {
            c.env_remove(name);
        }
    }
    c
}
/// Ticket 424: how `output`'s error for a run ended by a signal before any output ends.
pub(crate) const KILLED_SILENT: &str = " before it printed anything";
pub fn output(command: Command, timeout: Duration) -> Result<Output, String> {
    output_capped(command, timeout, OUTPUT_CAP)
}
/// Ticket 575: `output` for the login-shell probe. The child gets a session of its own (no controlling terminal: an
/// interactive shell in a process group the terminal does not front stops on SIGTTIN/SIGTTOU and never prints), and on
/// a timeout the whole session gets SIGKILL at once (an interactive shell ignores SIGTERM, and the 2 s grace of
/// `stop_command` would eat the caller's start wait). The session leader's PID is the group id, so the group kill fits.
/// Ticket 260: up to `cap` bytes of stdout (the probe prints the whole environment too).
pub(crate) fn output_detached(
    command: Command,
    timeout: Duration,
    cap: usize,
) -> Result<Output, String> {
    run_capped(command, timeout, cap, true, None, None)
}
/// `output` keeping up to `cap` bytes of stdout and up to `OUTPUT_CAP` of stderr (ticket 403 item 15).
fn output_capped(command: Command, timeout: Duration, cap: usize) -> Result<Output, String> {
    run_capped(command, timeout, cap, false, None, None)
}
/// `output` with `input` written to the child's stdin (a pull request body), then stdin closed.
pub(crate) fn output_with_input(
    command: Command,
    timeout: Duration,
    input: Vec<u8>,
) -> Result<Output, String> {
    run_capped(command, timeout, OUTPUT_CAP, false, Some(input), None)
}
/// `output_with_input` that hands the child's PID (its process group) to `spawned` once it runs, so a caller can stop
/// that run alone (the Diff panel's Write with AI Cancel), and `None` just before the child is reaped, so that PID is
/// forgotten before it can be reused.
pub(crate) fn output_watched(
    command: Command,
    timeout: Duration,
    input: Vec<u8>,
    spawned: &dyn Fn(Option<u32>),
) -> Result<Output, String> {
    run_capped(
        command,
        timeout,
        OUTPUT_CAP,
        false,
        Some(input),
        Some(spawned),
    )
}
fn run_capped(
    mut command: Command,
    timeout: Duration,
    cap: usize,
    detached: bool,
    input: Option<Vec<u8>>,
    spawned: Option<&dyn Fn(Option<u32>)>,
) -> Result<Output, String> {
    // Round 2: the file name only, never a full path, arguments or environment (the error can reach a reply).
    let program = std::path::Path::new(command.get_program())
        .file_name()
        .map_or("command".into(), |n| n.to_string_lossy().into_owned());
    if detached {
        // Not `process_group(0)` too: std makes the child a group leader first, and a leader cannot `setsid`.
        unsafe { command.pre_exec(setsid) };
    } else {
        command.process_group(0);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let forget = || {
        if let Some(spawned) = spawned {
            spawned(None);
        }
    };
    if let Some(spawned) = spawned {
        spawned(Some(child.id()));
    }
    // A writer thread, so a child that reads slowly (or not at all) never blocks the output loop; it ends at EOF or EPIPE.
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        thread::spawn(move || {
            let _ = std::io::Write::write_all(&mut stdin, &bytes);
        });
    }
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            unsafe {
                libc::killpg(child.id() as i32, libc::SIGKILL);
            }
            let _ = child.wait();
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut out_done = false;
    let mut err_done = false;
    let result = loop {
        let mut progress = false;
        for (reader, bytes, done, cap) in [
            (&mut stdout as &mut dyn Read, &mut out, &mut out_done, cap),
            (
                &mut stderr as &mut dyn Read,
                &mut err,
                &mut err_done,
                cap.min(OUTPUT_CAP),
            ),
        ] {
            if *done {
                continue;
            }
            let mut buf = [0; 8192];
            match reader.read(&mut buf) {
                Ok(0) => *done = true,
                Ok(n) => {
                    progress = true;
                    let keep = n.min(cap - bytes.len());
                    bytes.extend_from_slice(&buf[..keep]);
                }
                Err(e)
                    if [
                        std::io::ErrorKind::WouldBlock,
                        std::io::ErrorKind::Interrupted,
                    ]
                    .contains(&e.kind()) => {}
                Err(e) => {
                    if status.is_none() {
                        forget();
                        stop_command(&mut child);
                    }
                    return Err(e.to_string());
                }
            }
        }
        if status.is_none() {
            match ended(child.id()) {
                Ok(true) => {
                    forget();
                    // Retire the group before wait() releases the leader's PID for reuse.
                    unsafe {
                        libc::killpg(child.id() as i32, libc::SIGKILL);
                    }
                    match child.wait() {
                        Ok(exit) => status = Some(exit),
                        Err(e) => break Err(e.to_string()),
                    }
                }
                Ok(false) => {}
                Err(e) => break Err(e.to_string()),
            }
        }

        if status.is_some() && out_done && err_done {
            break Ok(());
        }
        if Instant::now() >= deadline {
            break Err(format!(
                "command timed out after {} ms",
                timeout.as_millis()
            ));
        }
        if !progress {
            wait_for_output(&[(&stdout, out_done), (&stderr, err_done)]);
        }
    };
    if result.is_err() && status.is_none() {
        forget();
        if detached {
            unsafe {
                libc::killpg(child.id() as i32, libc::SIGKILL);
            }
            let _ = child.wait();
        } else {
            stop_command(&mut child);
        }
    }
    result?;
    let status = status.unwrap();
    // Ticket 424: ended by a signal before it printed anything is no answer; say so by name, never an empty `Ok`.
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status)
        && out.is_empty()
        && err.is_empty()
    {
        return Err(format!(
            "{program} was ended by signal {signal}{KILLED_SILENT}"
        ));
    }
    Ok(Output {
        status,
        stdout: out,
        stderr: err,
    })
}
/// Ticket 394 round 8: up to 10 ms for output or end of output on a pipe still open, so a command is read as soon as
/// it ends. A plain 10 ms sleep cost a whole timer slice per command (about 88 ms when the system coalesces timers),
/// and a read now starts up to three git processes. With both pipes closed (the exit status still pending) it naps 1 ms.
fn wait_for_output(pipes: &[(&dyn AsRawFd, bool)]) {
    let mut fds: Vec<libc::pollfd> = pipes
        .iter()
        .filter(|(_, done)| !done)
        .map(|(pipe, _)| libc::pollfd {
            fd: pipe.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    if fds.is_empty() {
        thread::sleep(Duration::from_millis(1));
    } else {
        unsafe {
            libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 10);
        }
    }
}
// WNOWAIT keeps an exited leader reserved until its group has been retired.
pub(crate) fn exited(pid: u32) -> std::io::Result<bool> {
    Ok(reported(pid)?.is_some())
}
/// Ticket 424: `exited` for `output`'s own wait. Darwin's waitid also reports a stopped child (CLD_STOPPED) despite
/// WEXITED alone, so here only an exit, a kill or a core dump counts as ended. Round 2: the holder and the machine
/// transport keep `exited` as it was (a stopped agent's holder is its own ticket).
fn ended(pid: u32) -> std::io::Result<bool> {
    Ok(reported(pid)?
        .is_some_and(|code| [libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED].contains(&code)))
}
/// The `si_code` waitid(WEXITED | WNOHANG | WNOWAIT) reports for `pid`, or `None` while it reports nothing.
fn reported(pid: u32) -> std::io::Result<Option<i32>> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == 0
        {
            return Ok((unsafe { info.si_pid() } != 0).then_some(info.si_code));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
/// Ticket 394: SIGTERM first, so git removes its `.lock` files (a SIGKILL leaves them in the user's repository); the
/// group is killed once the leader ends or after a short grace.
fn stop_command(child: &mut std::process::Child) {
    if exited(child.id()).is_ok() {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_secs(2);
        while matches!(exited(child.id()), Ok(false)) && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
        let _ = child.wait();
    }
}

/// Tests: what a fixture's git never inherits: the location and config variables (ticket 394 round 2).
#[cfg(test)]
pub(crate) const FIXTURE_SCRUB: [&str; 8] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
        path::Path,
    };
    /// A fresh folder under the repo's `.scratch` (as the other tests here), removed first if a past run left it.
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// N26: every git the core builds reads with no optional lock (no index refresh, so no index.lock).
    // Ticket 1024: every program the core starts is made by `command`, so none inherits a secret variable: outside the
    // tests there is no other `Command::new`. A new spawn site that skips the helper fails here.
    #[test]
    fn core_commands_are_made_by_command() {
        fn walk(dir: &std::path::Path, found: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if path.is_dir() {
                    if name != "tests" {
                        walk(&path, found);
                    }
                    continue;
                }
                if !name.ends_with(".rs") || name.ends_with("tests.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                // A test module runs from `#[cfg(test)]` + `mod x {` to the closing brace at the same indent.
                let (mut end, mut before) = (None, "");
                for (n, line) in text.lines().enumerate() {
                    let code = line.trim_start();
                    let indent = &line[..line.len() - code.len()];
                    if end.is_none() {
                        if before == "#[cfg(test)]" && code.contains("mod ") && code.ends_with('{')
                        {
                            end = Some(format!("{indent}}}"));
                        } else if code.contains("Command::new(") && !code.starts_with("//") {
                            found.push(format!("{name}:{}: {code}", n + 1));
                        }
                    } else if end.as_deref() == Some(line) {
                        end = None;
                    }
                    before = code;
                }
            }
        }
        let mut found = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut found,
        );
        assert!(
            matches!(&found[..], [own] if own.starts_with("process.rs:") && own.ends_with("Command::new(program);")),
            "use `crate::process::command`: {found:#?}"
        );
    }

    #[test]
    fn n26_core_git_takes_no_optional_lock() {
        let c = git_in(Path::new("/"));
        assert!(
            c.get_envs()
                .any(|(k, v)| k == "GIT_OPTIONAL_LOCKS" && v == Some(OsStr::new("0")))
        );
    }
    fn file(path: &std::path::Path, mode: u32) {
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    #[test]
    fn resolve_program_finds_the_file_execvp_would_run() {
        let root = scratch("resolve-program");
        let (dir_entry, plain, real, later) = (
            root.join("a"),
            root.join("b"),
            root.join("c"),
            root.join("d"),
        );
        for d in [&dir_entry, &plain, &real, &later] {
            std::fs::create_dir_all(d).unwrap();
        }
        // A folder, then a file without an execute bit, named like the program: execvp passes both.
        std::fs::create_dir_all(dir_entry.join("tool")).unwrap();
        file(&plain.join("tool"), 0o644);
        file(&real.join("tool"), 0o755);
        file(&later.join("tool"), 0o755);
        let path = std::env::join_paths([&dir_entry, &plain, &real, &later]).unwrap();
        let found = resolve_program("tool", Some(&path));
        assert_eq!(found, real.join("tool"));
        assert!(found.is_absolute());
        // Not found anywhere, or no PATH at all: the bare name, so the spawn fails as before.
        assert_eq!(
            resolve_program("missing", Some(&path)),
            PathBuf::from("missing")
        );
        assert_eq!(resolve_program("tool", None), PathBuf::from("tool"));
        // A name with a slash is a path already.
        assert_eq!(
            resolve_program("./tool", Some(&path)),
            PathBuf::from("./tool")
        );
        assert_eq!(
            resolve_program("/bin/sh", Some(&path)),
            PathBuf::from("/bin/sh")
        );
        // A relative or empty entry before the match resolves against the child's folder: left to execvp.
        let relative = std::env::join_paths([Path::new("rel"), &real]).unwrap();
        assert_eq!(
            resolve_program("tool", Some(&relative)),
            PathBuf::from("tool")
        );
        let empty = std::ffi::OsString::from(format!(":{}", real.display()));
        assert_eq!(resolve_program("tool", Some(&empty)), PathBuf::from("tool"));
        // A relative entry after the match changes nothing.
        let after = std::env::join_paths([&real, Path::new("rel")]).unwrap();
        assert_eq!(resolve_program("tool", Some(&after)), real.join("tool"));
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn env_path_is_the_last_path_pair() {
        let env = [("HOME", "/h"), ("PATH", "/a"), ("PATH", "/b")];
        assert_eq!(env_path(&env), Some(OsStr::new("/b")));
        assert_eq!(env_path(&[("HOME", "/h")]), None);
    }
    #[test]
    fn timeout_stops_the_owned_command_group() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch");
        std::fs::create_dir_all(&root).unwrap();
        let pidfile = root.join(format!("timeout-helper-{}", std::process::id()));
        // v1a-17: the helper marks `expired` only if it outlives its 30 s, so a timeout that returns with no mark
        // ended the group rather than waiting it out.
        let expired = root.join(format!("timeout-expired-{}", std::process::id()));
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "(sleep 30; : > \"$2\") & echo $! > \"$1\"; wait",
                "fixture",
            ])
            .arg(&pidfile)
            .arg(&expired);
        let result = output(command, Duration::from_millis(100));
        assert!(result.unwrap_err().contains("timed out"));
        let waited = expired.exists();
        let _ = std::fs::remove_file(&expired);
        assert!(!waited, "the timeout waited for the helper to end");
        let pid = std::fs::read_to_string(&pidfile).unwrap();
        let pid = pid.trim();
        let deadline = Instant::now() + Duration::from_secs(1);
        let alive = || {
            let out = Command::new("/bin/ps")
                .args(["-p", pid, "-o", "stat="])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&out.stdout);
            !state.trim().is_empty() && !state.trim().starts_with('Z')
        };
        while alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let survived = alive();
        if survived {
            Command::new("/bin/kill")
                .args(["-KILL", pid])
                .status()
                .unwrap();
        }
        std::fs::remove_file(pidfile).unwrap();
        assert!(!survived, "timed-out command left its helper running");
    }
    /// A temp repository with one commit of `file`; git runs with no inherited location variable.
    fn repo(tag: &str, file: &str, text: &str) -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("process-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        fixture(&dir, &["init", "-q"]);
        std::fs::write(dir.join(file), text).unwrap();
        fixture(&dir, &["add", "-A"]);
        fixture(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }
    fn fixture(dir: &std::path::Path, args: &[&str]) -> String {
        let mut c = Command::new("git");
        for k in FIXTURE_SCRUB {
            c.env_remove(k);
        }
        let out = c
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository whose one blob is missing and whose config names a promisor remote with an `ext::` URL (and
    /// allows `ext`) that would write the returned marker: (repository, blob, marker).
    fn promisor(tag: &str) -> (std::path::PathBuf, String, std::path::PathBuf) {
        let dir = repo(tag, "a.txt", "hello\n");
        let blob = fixture(&dir, &["rev-parse", "HEAD:a.txt"]);
        std::fs::remove_file(dir.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
        let marker = dir.with_extension("ran");
        let url = format!("ext::sh -c touch% {}", marker.display());
        for (k, v) in [
            ("core.repositoryformatversion", "1"),
            ("extensions.partialclone", "evil"),
            ("remote.evil.url", url.as_str()),
            ("remote.evil.promisor", "true"),
            ("protocol.ext.allow", "always"),
        ] {
            fixture(&dir, &["config", k, v]);
        }
        (dir, blob, marker)
    }

    /// Ticket 394: a folder whose config names a promisor remote with an `ext::` URL (and allows `ext`) runs nothing
    /// when a read meets a missing object.
    #[test]
    fn git_read_never_lazy_fetches_from_a_promisor() {
        let (dir, blob, marker) = promisor("promisor");
        let r = git_read(&dir, &["cat-file", "-p", &blob], Duration::from_secs(10));
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            r.is_err() && !ran,
            "a read ran the promisor's ext:: command"
        );
    }

    /// Ticket 394 round 2: `GIT_NO_LAZY_FETCH` itself, with no `ext::` in play: a blobless clone of a local `file://`
    /// promisor that has the blob. A read fails rather than fetching it, and the blob is still missing after.
    #[test]
    fn git_read_never_lazy_fetches_from_a_file_promisor() {
        let origin = repo("lazy-origin", "a.txt", "hello\n");
        fixture(&origin, &["config", "uploadpack.allowFilter", "true"]);
        let partial = origin.with_extension("partial");
        let _ = std::fs::remove_dir_all(&partial);
        let url = format!("file://{}", origin.display());
        let clone = [
            "clone",
            "-q",
            "--no-checkout",
            "--filter=blob:none",
            &url,
            partial.to_str().unwrap(),
        ];
        fixture(&origin, &clone);
        let blob = fixture(&origin, &["rev-parse", "HEAD:a.txt"]);
        let read = git_read(
            &partial,
            &["cat-file", "-p", &blob],
            Duration::from_secs(10),
        );
        let present = git_read(
            &partial,
            &["cat-file", "-e", &blob],
            Duration::from_secs(10),
        );
        std::fs::remove_dir_all(&partial).unwrap();
        std::fs::remove_dir_all(&origin).unwrap();
        assert!(read.is_err(), "a read lazy-fetched the blob: {read:?}");
        assert!(present.is_err(), "the blob was fetched");
    }

    /// Ticket 403 item 11: git below 2.31 is refused, below 2.44 (or unreadable) is a warning, 2.44 on is quiet.
    #[test]
    fn minimum_git_version() {
        assert!(minimum("git version 2.30.9\n").is_err());
        assert!(minimum("git version 1.99.0").is_err());
        assert!(minimum("git version 2.39.5 (Apple Git-154)\n").is_ok_and(|w| w.is_some()));
        assert!(minimum("not git").is_ok_and(|w| w.is_some()));
        assert_eq!(minimum("git version 2.44.0\n"), Ok(None));
        assert_eq!(minimum("git version 2.54.0 (Apple Git-157)\n"), Ok(None));
        assert_eq!(minimum("git version 3.0.0"), Ok(None));
        // This machine's git passes, so every read in these tests runs.
        assert_eq!(supported(), Ok(()));
    }

    /// Ticket 403 item 6: auto-pull's fast-forward never starts the folder's `gpg.program` through
    /// `merge.verifySignatures`, and still fast-forwards (no signature check refuses it either).
    #[test]
    fn git_update_runs_no_signature_check() {
        let dir = repo("update-gpg", "a.txt", "a\n");
        let marker = dir.with_extension("ran");
        let gpg = dir.with_extension("gpg");
        std::fs::write(
            &gpg,
            format!("#!/bin/sh\necho ran >> {}\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&gpg, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let tree = fixture(&dir, &["rev-parse", "HEAD^{tree}"]);
        let head = fixture(&dir, &["rev-parse", "HEAD"]);
        // A child of HEAD that carries a signature, so a verify would hand it to `gpg.program`.
        let body = format!(
            "tree {tree}\nparent {head}\nauthor t <t@example.com> 0 +0000\ncommitter t <t@example.com> 0 +0000\n\
             gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n"
        );
        let file = dir.with_extension("commit");
        std::fs::write(&file, body).unwrap();
        let signed = fixture(
            &dir,
            &["hash-object", "-t", "commit", "-w", file.to_str().unwrap()],
        );
        fixture(&dir, &["config", "merge.verifySignatures", "true"]);
        fixture(&dir, &["config", "gpg.program", gpg.to_str().unwrap()]);
        let merged = git_update(
            &dir,
            &["merge", "--ff-only", "--quiet", &signed],
            Duration::from_secs(10),
        );
        let now = fixture(&dir, &["rev-parse", "HEAD"]);
        let ran = marker.exists();
        for f in [&marker, &gpg, &file] {
            let _ = std::fs::remove_file(f);
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!ran, "the update ran gpg.program");
        assert!(
            merged.is_ok() && now == signed,
            "no fast-forward: {merged:?}"
        );
    }

    /// Ticket 394 round 2: auto-pull's update may lazy-fetch (a checkout needs the blobs) but never over `ext::`.
    #[test]
    fn git_update_never_runs_an_ext_url() {
        let (dir, blob, marker) = promisor("update-ext");
        let _ = git_update(&dir, &["cat-file", "-p", &blob], Duration::from_secs(10));
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!ran, "an update ran the promisor's ext:: command");
    }

    /// Ticket 394: a file under the LFS filter (a pointer, as a PR worktree checks it out) never starts the LFS
    /// filter from a read, so git-lfs never contacts its server. The stand-in filter only records that it ran.
    #[test]
    fn git_read_never_runs_the_lfs_filter() {
        let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 5\n";
        let dir = repo("lfs", "p.bin", pointer);
        std::fs::write(dir.join(".gitattributes"), "*.bin filter=lfs -text\n").unwrap();
        let marker = dir.with_extension("ran");
        for k in ["clean", "smudge", "process"] {
            let run = format!("sh -c 'echo {k} >> {}; cat'", marker.display());
            fixture(&dir, &["config", &format!("filter.lfs.{k}"), &run]);
        }
        fixture(&dir, &["config", "filter.lfs.required", "true"]);
        std::fs::write(dir.join("p.bin"), [pointer, "x\n"].concat()).unwrap();
        // The reads the Diff view and the worktree facts make over a changed file.
        for args in [
            &["status", "--porcelain=v2", "--branch"][..],
            &["status", "--porcelain", "--ignored"],
            &["diff-index", "-z", "--numstat", "HEAD"],
            &[
                "diff-index",
                "--patch",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ],
        ] {
            let _ = git_read(&dir, args, Duration::from_secs(10));
        }
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(ran, "", "a read started the LFS filter");
    }

    /// Ticket 394 round 2: `log.showSignature=true` with `gpg.program` set in the folder's config never runs that
    /// program from a read of a signed commit (the loss check's `log`, the merged check's `reflog show`).
    #[test]
    fn git_read_never_verifies_a_signature() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo("sig", "a.txt", "a\n");
        let marker = dir.with_extension("ran");
        let gpg = dir.with_extension("gpg");
        let script = format!("#!/bin/sh\necho ran >> '{}'\n", marker.display());
        std::fs::write(&gpg, script).unwrap();
        std::fs::set_permissions(&gpg, std::fs::Permissions::from_mode(0o755)).unwrap();
        let head = fixture(&dir, &["cat-file", "commit", "HEAD"]);
        let (top, msg) = head.split_once("\n\n").unwrap();
        let signed = format!(
            "{top}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n{msg}\n"
        );
        let object = dir.with_extension("commit");
        std::fs::write(&object, signed).unwrap();
        let sha = fixture(
            &dir,
            &[
                "hash-object",
                "-t",
                "commit",
                "-w",
                object.to_str().unwrap(),
            ],
        );
        let branch = fixture(&dir, &["symbolic-ref", "HEAD"]);
        fixture(&dir, &["update-ref", "-m", "signed", &branch, &sha]);
        fixture(&dir, &["config", "log.showSignature", "true"]);
        fixture(&dir, &["config", "gpg.program", gpg.to_str().unwrap()]);
        for args in [
            &["log", "--max-count=200", "--format=%h %s", "HEAD"][..],
            &["reflog", "show", "--format=%H", "--end-of-options", &branch],
        ] {
            let _ = git_read(&dir, args, Duration::from_secs(10));
        }
        let ran = marker.exists();
        for f in [&marker, &gpg, &object] {
            let _ = std::fs::remove_file(f);
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!ran, "a read ran gpg.program");
    }

    /// Ticket 394 round 2: a filter the folder's own config names (`filter=evil` in `.gitattributes`) never runs
    /// from the Diff view's facts, list and patch, the Files list, the worktree facts and loss, or auto-pull's check.
    #[test]
    fn git_read_never_runs_a_configured_filter() {
        use crate::api::Request;
        let dir = repo("filter", "a.txt", "a\n");
        let base = crate::diff::start(&dir);
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        let marker = dir.with_extension("ran");
        for k in ["clean", "smudge", "process"] {
            let run = format!("sh -c 'echo {k} >> {}; cat'", marker.display());
            fixture(&dir, &["config", &format!("filter.evil.{k}"), &run]);
        }
        fixture(&dir, &["config", "filter.evil.required", "true"]);
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        let _ = crate::diff::facts(&dir);
        let scope = crate::diff::Scope::Session;
        let session = "s".to_string();
        for request in [
            Request::DiffList {
                session: session.clone(),
                scope,
                git: true,
                fresh: false,
            },
            Request::DiffFile {
                session,
                path: "a.txt".into(),
                scope,
            },
        ] {
            let _ = crate::diff::run(dir.clone(), Some(base.clone()), request);
        }
        let _ = crate::files::list(&crate::files::Root::Folder(dir.clone()), ".");
        let _ = crate::worktree_clean::facts(&dir, &dir);
        let _ = crate::worktree_clean::loss(&dir, &dir);
        let _ = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        // Round 3: a name `-c` could not carry (`ev=il`) is switched off through the environment, and the read works.
        let odd = format!("sh -c 'echo odd >> {}; cat'", marker.display());
        fixture(&dir, &["config", "filter.ev=il.clean", &odd]);
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=ev=il\n").unwrap();
        let read = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        assert!(read.is_ok(), "{read:?}");
        // Round 4: a name that is not UTF-8 (byte 0xff), written as bytes, is switched off by its own bytes.
        let raw = format!("sh -c 'echo ff >> {}; cat'", marker.display());
        let mut config = std::fs::read(dir.join(".git/config")).unwrap();
        // Quoted: a bare `;` would start a comment.
        config.extend_from_slice(b"[filter \"\xff\"]\n\tclean = \"");
        config.extend_from_slice(raw.as_bytes());
        config.extend_from_slice(b"\"\n");
        std::fs::write(dir.join(".git/config"), config).unwrap();
        std::fs::write(dir.join(".gitattributes"), b"*.txt filter=\xff\n").unwrap();
        let read = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        assert!(read.is_ok(), "{read:?}");
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(ran, "", "a read started the folder's filter");
    }

    /// `top` with `sub` added as the populated submodule `s` (a local `file://` remote, allowed for this setup only).
    fn add_submodule(top: &std::path::Path, sub: &std::path::Path) {
        let url = format!("file://{}", sub.display());
        let add = ["-c", "protocol.file.allow=always", "submodule", "add", "-q"];
        fixture(top, &[&add[..], &[&url, "s"]].concat());
        fixture(top, &["commit", "-q", "-m", "add s"]);
    }

    /// Ticket 394 round 3: a populated submodule's own config (`filter.evil2.clean`, chosen by a `.gitattributes`
    /// inside it) never runs from the Diff view's facts and list, the worktree facts and loss, or a status. A normal
    /// submodule still reads, and its uncommitted change still counts.
    #[test]
    fn git_read_never_runs_a_submodule_filter() {
        use crate::api::Request;
        let sub = repo("sm-sub", "a.txt", "a\n");
        let top = repo("sm-top", "t.txt", "t\n");
        add_submodule(&top, &sub);
        let base = crate::diff::start(&top);
        let inner = top.join("s");
        std::fs::write(inner.join("a.txt"), "b\n").unwrap();
        // A normal submodule: read, and its change is a change.
        let status = git_read(&top, &["status", "--porcelain"], Duration::from_secs(10)).unwrap();
        assert_eq!(String::from_utf8_lossy(&status), " M s\n");
        assert!(crate::diff::facts(&top).unwrap().dirty);
        assert_eq!(
            crate::worktree_clean::facts(&top, &top)
                .unwrap()
                .uncommitted,
            1
        );
        // Hostile: the submodule's own config names the filter.
        let marker = top.with_extension("ran");
        for k in ["clean", "smudge", "process"] {
            let run = format!("sh -c 'echo {k} >> {}; cat'", marker.display());
            fixture(&inner, &["config", &format!("filter.evil2.{k}"), &run]);
        }
        fixture(&inner, &["config", "filter.evil2.required", "true"]);
        std::fs::write(inner.join(".gitattributes"), "*.txt filter=evil2\n").unwrap();
        std::fs::write(inner.join("a.txt"), "c\n").unwrap();
        let _ = crate::diff::facts(&top);
        let request = Request::DiffList {
            session: "s".into(),
            scope: crate::diff::Scope::Session,
            git: true,
            fresh: false,
        };
        let _ = crate::diff::run(top.clone(), Some(base), request);
        let _ = crate::worktree_clean::facts(&top, &top);
        let _ = crate::worktree_clean::loss(&top, &top);
        let status = git_read(&top, &["status", "--porcelain"], Duration::from_secs(10));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        assert_eq!(ran, "", "a read started the submodule's filter");
        assert!(
            status.is_ok_and(|s| s == b" M s\n"),
            "the change no longer counts"
        );
    }

    /// Ticket 394 round 5: a submodule that sorts after about 2,000 files (past 64 KiB of `ls-files` output) is still
    /// found, so its own filter never runs from a status.
    #[test]
    fn git_read_finds_a_submodule_past_a_long_listing() {
        let sub = repo("late-sub", "a.txt", "a\n");
        let top = repo("late-top", "t.txt", "t\n");
        for i in 0..2000 {
            std::fs::write(top.join(format!("file-{i:05}.txt")), "x\n").unwrap();
        }
        fixture(&top, &["add", "-A"]);
        fixture(&top, &["commit", "-q", "-m", "files"]);
        let url = format!("file://{}", sub.display());
        let add = ["-c", "protocol.file.allow=always", "submodule", "add", "-q"];
        fixture(&top, &[&add[..], &[&url, "zzz-last"]].concat());
        fixture(&top, &["commit", "-q", "-m", "add zzz-last"]);
        let inner = top.join("zzz-last");
        let marker = top.with_extension("ran");
        let run = format!("sh -c 'echo late >> {}; cat'", marker.display());
        fixture(&inner, &["config", "filter.late.clean", &run]);
        std::fs::write(inner.join(".gitattributes"), "*.txt filter=late\n").unwrap();
        std::fs::write(inner.join("a.txt"), "b\n").unwrap();
        let status = git_read(&top, &["status", "--porcelain"], Duration::from_secs(20));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        assert_eq!(ran, "", "a late submodule's filter ran");
        assert!(status.is_ok(), "{status:?}");
    }

    /// Ticket 394 round 5: 70 KiB of config keys before a filter (a padded `.git/config`) never hide it.
    #[test]
    fn git_read_finds_a_filter_after_padded_config() {
        let dir = repo("padded", "a.txt", "a\n");
        let marker = dir.with_extension("ran");
        let mut config = std::fs::read(dir.join(".git/config")).unwrap();
        config.extend_from_slice(b"[pad]\n");
        for i in 0..7000 {
            config.extend_from_slice(format!("\tk{i:05} = 1\n").as_bytes());
        }
        let run = format!("sh -c 'echo padded >> {}; cat'", marker.display());
        config.extend_from_slice(format!("[filter \"evil\"]\n\tclean = \"{run}\"\n").as_bytes());
        std::fs::write(dir.join(".git/config"), config).unwrap();
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        let status = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(ran, "", "a filter after 70 KiB of config ran");
        assert!(status.is_ok(), "{status:?}");
    }

    /// Ticket 394 round 5: a lookup that reaches its limit refuses the read; it is never answered from a cut list.
    #[test]
    fn drivers_refuse_a_listing_at_its_limit() {
        let dir = repo("limit", "a.txt", "a\n");
        let ten = || Instant::now() + Duration::from_secs(10);
        let small = drivers(&dir, true, ten(), 16);
        let full = drivers(&dir, true, ten(), LISTING_CAP);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(small.is_err(), "a cut listing was used: {small:?}");
        assert!(full.is_ok(), "{full:?}");
    }

    /// Ticket 394 round 3: populated submodules nested deeper than `SUBMODULE_DEPTH` refuse a status read; three
    /// levels still read.
    #[test]
    fn git_read_refuses_submodules_nested_too_deep() {
        let repos: Vec<std::path::PathBuf> = (0..5)
            .map(|i| repo(&format!("sm-deep{i}"), "a.txt", "a\n"))
            .collect();
        // repos[4] is the innermost; each one adds the next as `s`.
        for i in (0..4).rev() {
            add_submodule(&repos[i], &repos[i + 1]);
        }
        let update = ["-c", "protocol.file.allow=always", "submodule", "update"];
        fixture(
            &repos[0],
            &[&update[..], &["-q", "--init", "--recursive"]].concat(),
        );
        let status = |dir: &std::path::Path| {
            git_read(dir, &["status", "--porcelain"], Duration::from_secs(10))
        };
        let deep = status(&repos[0]);
        let three = status(&repos[0].join("s"));
        for r in &repos {
            std::fs::remove_dir_all(r).unwrap();
        }
        assert!(deep.is_err(), "four nested levels read: {deep:?}");
        assert!(three.is_ok(), "three nested levels were refused: {three:?}");
    }

    /// A marker-writing `filter.evil.clean` in `repo`'s own config, chosen for `*.txt` by its `.gitattributes`, with
    /// `a.txt` changed: the setup a status must not run.
    fn evil_filter(repo: &std::path::Path, marker: &std::path::Path) {
        let run = format!("sh -c 'echo ran >> {}; cat'", marker.display());
        fixture(repo, &["config", "filter.evil.clean", &run]);
        std::fs::write(repo.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
    }

    /// Ticket 394 round 8: git tests only the type bits of an entry's mode (`mode & 0170000 == 0160000`), so a gitlink
    /// stored as `00 00 e1 ed` (160755) is still a submodule to git; its filter never runs from a status.
    #[test]
    fn git_read_finds_a_gitlink_with_odd_mode_bits() {
        let sub = repo("odd-sub", "a.txt", "a\n");
        let top = repo("odd-top", "t.txt", "t\n");
        let url = format!("file://{}", sub.display());
        fixture(&top, &["clone", "-q", &url, "s"]);
        fixture(&top, &["add", "s"]);
        fixture(&top, &["commit", "-q", "-m", "gitlink"]);
        let index = top.join(".git/index");
        let mut bytes = std::fs::read(&index).unwrap();
        let mode = [0, 0, 0xe0, 0];
        assert_eq!(bytes.windows(4).filter(|w| *w == mode).count(), 1);
        let at = bytes.windows(4).position(|w| w == mode).unwrap();
        bytes[at + 2..at + 4].copy_from_slice(&[0xe1, 0xed]);
        // A null checksum: git does not check it.
        let end = bytes.len();
        bytes[end - 20..].fill(0);
        std::fs::write(&index, bytes).unwrap();
        let listed = fixture(&top, &["ls-files", "-s", "--", "s"]);
        assert!(listed.starts_with("160755 "), "{listed}");
        // Stat-dirty (same content, a later mtime): git has to run the clean filter to compare it. A changed size
        // would let git call it modified unread.
        let inner = top.join("s");
        let marker = top.with_extension("ran");
        let run = format!("sh -c 'echo ran >> {}; cat'", marker.display());
        fixture(&inner, &["config", "filter.evil.clean", &run]);
        std::fs::write(inner.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        std::fs::write(inner.join("a.txt"), "a\n").unwrap();
        std::fs::File::options()
            .write(true)
            .open(inner.join("a.txt"))
            .unwrap()
            .set_modified(std::time::SystemTime::now() + Duration::from_secs(10))
            .unwrap();
        let _ = git_read(&top, &["status", "--porcelain"], Duration::from_secs(10));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        assert_eq!(
            ran, "",
            "a status ran the filter of a gitlink stored as 160755"
        );
    }

    /// Ticket 394 round 6: a sparse index whose collapsed folder (a sparse-directory entry) holds a gitlink, populated
    /// on disk: the index file holds no gitlink entry of its own, but `ls-files` (without `--sparse`) lists the expanded
    /// entries, the gitlink among them. Status runs no filter of that submodule.
    #[test]
    fn git_read_sees_a_gitlink_in_a_sparse_directory() {
        let sub = repo("sparse-sub", "a.txt", "a\n");
        let top = repo("sparse-top", "t.txt", "t\n");
        std::fs::create_dir_all(top.join("keep")).unwrap();
        std::fs::write(top.join("keep/k.txt"), "k\n").unwrap();
        std::fs::create_dir_all(top.join("dir")).unwrap();
        std::fs::write(top.join("dir/d.txt"), "d\n").unwrap();
        fixture(&top, &["add", "-A"]);
        fixture(&top, &["commit", "-q", "-m", "dir"]);
        let first = fixture(&top, &["symbolic-ref", "--short", "HEAD"]);
        fixture(&top, &["checkout", "-q", "-b", "with"]);
        let url = format!("file://{}", sub.display());
        fixture(
            &top,
            &[
                "-c",
                "protocol.file.allow=always",
                "clone",
                "-q",
                &url,
                "dir/s",
            ],
        );
        fixture(&top, &["add", "dir/s"]);
        fixture(&top, &["commit", "-q", "-m", "gitlink"]);
        std::fs::remove_dir_all(top.join("dir/s")).unwrap();
        fixture(&top, &["checkout", "-q", &first]);
        fixture(
            &top,
            &["sparse-checkout", "set", "--cone", "--sparse-index", "keep"],
        );
        // The gitlink arrives inside the collapsed `dir/`.
        fixture(&top, &["checkout", "-q", "with"]);
        let listed = fixture(&top, &["ls-files", "-s", "--sparse"]);
        assert!(
            listed.contains("040000") && !listed.contains("160000"),
            "{listed}"
        );
        std::fs::create_dir_all(top.join("dir")).unwrap();
        fixture(
            &top,
            &[
                "-c",
                "protocol.file.allow=always",
                "clone",
                "-q",
                &url,
                "dir/s",
            ],
        );
        let marker = top.with_extension("ran");
        evil_filter(&top.join("dir/s"), &marker);
        let _ = git_read(&top, &["status", "--porcelain"], Duration::from_secs(20));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        std::fs::remove_dir_all(&top).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        assert_eq!(ran, "", "a status ran the sparse submodule's filter");
    }

    /// Ticket 394 round 6: `.git` as a file `gitdir: real \n` names `real ` (git drops only `\n` and `\r`), never a
    /// decoy `real/` beside it.
    #[test]
    fn git_read_follows_a_gitdir_line_as_git_does() {
        let sub = repo("gd-sub", "a.txt", "a\n");
        let top = repo("gd-top", "t.txt", "t\n");
        let decoy = repo("gd-decoy", "t.txt", "t\n");
        let url = format!("file://{}", sub.display());
        // A submodule whose `.git` is its own folder, so moving the parent's `.git` leaves it working.
        fixture(
            &top,
            &["-c", "protocol.file.allow=always", "clone", "-q", &url, "s"],
        );
        fixture(&top, &["add", "s"]);
        fixture(&top, &["commit", "-q", "-m", "gitlink"]);
        std::fs::rename(top.join(".git"), top.join("real ")).unwrap();
        std::fs::rename(decoy.join(".git"), top.join("real")).unwrap();
        std::fs::write(top.join(".git"), "gitdir: real \n").unwrap();
        let marker = top.with_extension("ran");
        evil_filter(&top.join("s"), &marker);
        let _ = git_read(&top, &["status", "--porcelain"], Duration::from_secs(10));
        let ran = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        for d in [&top, &sub, &decoy] {
            std::fs::remove_dir_all(d).unwrap();
        }
        assert_eq!(ran, "", "a status ran the submodule's filter");
    }

    /// A status read of `dir` with a 2 s limit on its own thread: whether it was refused, or `None` when it has not
    /// ended after 20 s (the thread is left).
    fn status_ends(dir: &std::path::Path) -> Option<bool> {
        let (send, receive) = std::sync::mpsc::channel();
        let dir = dir.to_path_buf();
        thread::spawn(move || {
            let read = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(2));
            send.send(read.is_err())
        });
        receive.recv_timeout(Duration::from_secs(20)).ok()
    }

    /// Ticket 394 round 8: an index that is a FIFO: git blocks opening it, and the read is refused at its time limit.
    #[test]
    fn git_read_ends_on_a_fifo_index() {
        let dir = repo("fifo", "a.txt", "a\n");
        let index = dir.join(".git/index");
        std::fs::remove_file(&index).unwrap();
        let path = std::ffi::CString::new(index.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let refused = status_ends(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(refused, Some(true));
    }

    /// Ticket 394 round 8: an index that is a symlink to `/dev/zero`: git refuses it, and the read ends.
    #[test]
    fn git_read_ends_on_a_device_index() {
        let dir = repo("zero", "a.txt", "a\n");
        let index = dir.join(".git/index");
        std::fs::remove_file(&index).unwrap();
        std::os::unix::fs::symlink("/dev/zero", &index).unwrap();
        let refused = status_ends(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(refused, Some(true));
    }

    /// Ticket 394: a git command stopped at its time limit removes its own `.lock` files (SIGTERM first; a bare
    /// SIGKILL left `index.lock` behind, and a fetch's ref locks the same way).
    #[test]
    fn timeout_leaves_no_git_lock() {
        let dir = repo("lock", "a.txt", "a\n");
        std::fs::write(dir.join("a.txt"), "b\n").unwrap();
        // `commit -a` holds index.lock while its editor runs.
        let mut c = Command::new("git");
        for k in FIXTURE_SCRUB {
            c.env_remove(k);
        }
        c.arg("-C")
            .arg(&dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(["commit", "-a"])
            .env("GIT_EDITOR", "sleep 30;:");
        let r = output(c, Duration::from_millis(1500));
        let left = dir.join(".git/index.lock").exists();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(r.unwrap_err().contains("timed out"));
        assert!(!left, "a timed-out git left .git/index.lock");
    }

    /// Ticket 394 round 8: a command that ends at once is read at once: ten runs of `true` take well under one
    /// coalesced timer slice each (they took about 88 ms apiece with a plain 10 ms sleep between looks).
    #[test]
    fn output_returns_as_soon_as_the_command_ends() {
        let start = Instant::now();
        for _ in 0..10 {
            let out = output(Command::new("/usr/bin/true"), Duration::from_secs(10)).unwrap();
            assert!(out.status.success());
        }
        let took = start.elapsed();
        assert!(took < Duration::from_millis(500), "ten runs took {took:?}");
    }

    // Ticket 424: Darwin's waitid(WEXITED | WNOHANG | WNOWAIT) also reports a stopped child; `ended` does not count it.
    #[test]
    fn ended_is_false_for_a_stopped_child() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        unsafe { libc::kill(pid as i32, libc::SIGSTOP) };
        // A stop is asynchronous: wait until the process table shows it.
        let until = Instant::now() + Duration::from_secs(5);
        let stat = || {
            let ps = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&ps.stdout).trim().to_string()
        };
        while !stat().starts_with('T') {
            assert!(Instant::now() < until, "never stopped");
            thread::sleep(Duration::from_millis(5));
        }
        let (ended, exited) = (ended(pid).unwrap(), exited(pid).unwrap());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!ended, "a stopped child was reported as ended");
        assert!(
            exited,
            "round 2: `exited` (holder, transport) keeps main's answer"
        );
    }
    // Ticket 424: a command that is stopped and continued is still waited for, never killed as if it had ended.
    #[test]
    fn output_waits_for_a_stopped_command() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "(sleep 0.3; kill -CONT $$) & kill -STOP $$; echo resumed",
        ]);
        let out = output(command, Duration::from_secs(10)).unwrap();
        assert_eq!(
            (out.status.code(), out.stdout.as_slice()),
            (Some(0), &b"resumed\n"[..])
        );
    }
    // Ticket 424: a run ended by a signal before it printed anything is a named error, not an empty answer.
    #[test]
    fn output_names_a_run_killed_before_it_printed() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "kill -9 $$"]);
        assert_eq!(
            output(command, Duration::from_secs(10)).unwrap_err(),
            "sh was ended by signal 9 before it printed anything"
        );
        // Anything printed first is still the run's answer.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo partial; kill -9 $$"]);
        let out = output(command, Duration::from_secs(10)).unwrap();
        assert_eq!(
            (out.status.code(), out.stdout.as_slice()),
            (None, &b"partial\n"[..])
        );
    }
    /// Ticket 403 item 8: no git child inherits config from the environment, whatever the index `n`.
    #[test]
    fn scrub_drops_config_from_the_environment() {
        let inherited =
            ["GIT_CONFIG_KEY_7", "GIT_CONFIG_VALUE_7", "PATH"].map(std::ffi::OsString::from);
        let mut c = Command::new("git");
        scrub(&mut c, inherited.into_iter());
        let removed: Vec<_> = c
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k)
            .collect();
        for k in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_GLOBAL",
            "GIT_NAMESPACE",
            "GIT_CONFIG_KEY_7",
            "GIT_CONFIG_VALUE_7",
        ]
        .iter()
        .chain(&crate::projects::HOOK_REPOSITORY_ENV)
        {
            assert!(removed.contains(&OsStr::new(k)), "{k}");
        }
        assert!(!removed.contains(&OsStr::new("PATH")));
    }

    /// Ticket 403 item 12: one deadline for a read and every submodule listing it makes. Each submodule's config
    /// includes a FIFO that answers about 300 ms after its last answer, so each listing fits a 1 s limit but all of
    /// them do not: the read is refused within about that 1 s, and the same read with 10 s works.
    #[test]
    fn git_read_shares_one_deadline_across_submodules() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let subs: Vec<PathBuf> = (0..3)
            .map(|i| repo(&format!("dl-sub{i}"), "a.txt", "a\n"))
            .collect();
        let top = repo("dl-top", "t.txt", "t\n");
        let add = ["-c", "protocol.file.allow=always", "submodule", "add", "-q"];
        for (i, sub) in subs.iter().enumerate() {
            let url = format!("file://{}", sub.display());
            fixture(&top, &[&add[..], &[&url, &format!("s{i}")]].concat());
        }
        fixture(&top, &["commit", "-q", "-m", "subs"]);
        let stop = Arc::new(AtomicBool::new(false));
        let mut fifos = vec![];
        let mut writers = vec![];
        for i in 0..3 {
            let fifo = top.with_extension(format!("fifo{i}"));
            let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            fixture(
                &top.join(format!("s{i}")),
                &["config", "include.path", fifo.to_str().unwrap()],
            );
            let (fifo2, stop) = (fifo.clone(), stop.clone());
            writers.push(thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(300));
                    if !stop.load(Ordering::SeqCst) {
                        // Blocks until a git opens the FIFO to read its config; closing it ends that read.
                        let _ = std::fs::OpenOptions::new().write(true).open(&fifo2);
                    }
                }
            }));
            fifos.push(fifo);
        }
        let start = Instant::now();
        let short = git_read(&top, &["status", "--porcelain"], Duration::from_secs(1));
        let took = start.elapsed();
        let long = git_read(&top, &["status", "--porcelain"], Duration::from_secs(10));
        stop.store(true, Ordering::SeqCst);
        // Free a writer blocked on its FIFO with no reader left.
        for w in writers {
            while !w.is_finished() {
                for f in &fifos {
                    let _ = std::fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(f);
                }
                thread::sleep(Duration::from_millis(5));
            }
            w.join().unwrap();
        }
        for f in &fifos {
            std::fs::remove_file(f).unwrap();
        }
        std::fs::remove_dir_all(&top).unwrap();
        for s in &subs {
            std::fs::remove_dir_all(s).unwrap();
        }
        assert!(
            short.is_err(),
            "the submodule listings each took a full limit: {short:?}"
        );
        assert!(
            took < Duration::from_secs(2),
            "the read ran {took:?} past its 1 s"
        );
        assert!(long.is_ok(), "{long:?}");
    }

    /// Ticket 403 item 15: a listing's large stdout cap never applies to stderr, which keeps `OUTPUT_CAP`.
    #[test]
    fn stderr_keeps_output_cap_under_a_listing_cap() {
        let mut c = Command::new("/bin/sh");
        c.args([
            "-c",
            "head -c 200000 /dev/zero >&2; head -c 100000 /dev/zero",
        ]);
        let out = output_capped(c, Duration::from_secs(10), LISTING_CAP).unwrap();
        assert_eq!((out.stdout.len(), out.stderr.len()), (100000, OUTPUT_CAP));
    }

    /// Ticket 403 item 16b: a read whose output reaches `OUTPUT_CAP` is refused, never answered cut; `git_read_cut`
    /// returns the cut output for a caller that handles it.
    #[test]
    fn git_read_refuses_output_at_its_cap() {
        let dir = repo("cut", "big.txt", &"x".repeat(OUTPUT_CAP + 10));
        let args = ["cat-file", "-p", "HEAD:big.txt"];
        let whole = git_read(&dir, &args, Duration::from_secs(10));
        let cut = git_read_cut(&dir, &args, Duration::from_secs(10));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(whole.is_err_and(|e| e.ends_with(CUT)));
        assert_eq!(cut.unwrap().len(), OUTPUT_CAP);
    }

    /// Ticket 403 item 17: a quote inside the user part never keeps part of it.
    #[test]
    fn without_userinfo_reads_past_a_quote_in_the_user_part() {
        assert_eq!(
            without_userinfo("fatal: https://u:pa'ss@host/x failed"),
            "fatal: host/x failed"
        );
        assert_eq!(without_userinfo("at 'https://u:p\"w@h/r'"), "at 'h/r'");
    }

    /// Round 4: a scheme nested in the user part (security review r2) never keeps the password.
    #[test]
    fn without_userinfo_drops_a_nested_scheme() {
        let out = without_userinfo("fatal: https://u:SECRET:https://suffix@127.0.0.1:9/x failed");
        assert!(!out.contains("SECRET"), "{out}");
    }

    /// Ticket 403 item 21: more filter names than `MAX_FILTERS` refuse the read with a reason, never run it with
    /// some filter left on.
    #[test]
    fn git_read_refuses_too_many_filters() {
        let dir = repo("many-filters", "a.txt", "a\n");
        let mut config = std::fs::read(dir.join(".git/config")).unwrap();
        for i in 0..=MAX_FILTERS {
            config.extend_from_slice(format!("[filter \"f{i}\"]\n\tclean = cat\n").as_bytes());
        }
        std::fs::write(dir.join(".git/config"), config).unwrap();
        let read = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(read.is_err_and(|e| e.contains("too many filters")));
    }

    /// Ticket 403 decision (item 9): a fetch never goes over `git://` or `http://`, also when `insteadOf` rewrites a
    /// remote to one, and never recurses into submodules.
    #[test]
    fn git_fetch_refuses_plain_transports_and_submodules() {
        assert_eq!(
            fetch_args(&[
                "-c",
                "core.hooksPath=/dev/null",
                "fetch",
                "--quiet",
                "origin"
            ]),
            [
                "-c",
                "core.hooksPath=/dev/null",
                "fetch",
                "--no-recurse-submodules",
                "--quiet",
                "origin"
            ]
        );
        assert_eq!(fetch_args(&["log", "fetch"]), ["log", "fetch"]);
        let dir = repo("plain", "a.txt", "a\n");
        fixture(&dir, &["config", "remote.h.url", "http://127.0.0.1:9/x"]);
        fixture(&dir, &["config", "remote.g.url", "git://127.0.0.1:9/x"]);
        fixture(
            &dir,
            &["config", "url.http://127.0.0.1:9/.insteadOf", "safe:"],
        );
        fixture(&dir, &["config", "remote.i.url", "safe:x"]);
        let fetch = |r: &str| git_read(&dir, &["fetch", "--quiet", r], Duration::from_secs(10));
        let (h, g, i) = (fetch("h"), fetch("g"), fetch("i"));
        std::fs::remove_dir_all(&dir).unwrap();
        for (r, t) in [(h, "http"), (g, "git"), (i, "http")] {
            assert!(
                r.as_ref()
                    .is_err_and(|e| e.contains(&format!("transport '{t}' not allowed"))),
                "{r:?}"
            );
        }
    }

    /// Round 2 (review S1): an inherited `GIT_ALLOW_PROTOCOL` would override every `protocol.<name>.allow`.
    #[test]
    fn scrub_drops_git_allow_protocol() {
        let mut c = Command::new("git");
        scrub(&mut c, std::iter::empty());
        assert!(
            c.get_envs()
                .any(|(k, v)| k == "GIT_ALLOW_PROTOCOL" && v.is_none())
        );
    }

    /// Round 2 (review S2): `ftp://` and `ftps://` are refused like `http://`.
    #[test]
    fn git_fetch_refuses_ftp() {
        let dir = repo("ftp", "a.txt", "a\n");
        fixture(&dir, &["config", "remote.f.url", "ftp://127.0.0.1:9/x"]);
        fixture(&dir, &["config", "remote.s.url", "ftps://127.0.0.1:9/x"]);
        let fetch = |r: &str| git_read(&dir, &["fetch", "--quiet", r], Duration::from_secs(10));
        let (f, s) = (fetch("f"), fetch("s"));
        std::fs::remove_dir_all(&dir).unwrap();
        for (r, t) in [(f, "ftp"), (s, "ftps")] {
            assert!(
                r.as_ref()
                    .is_err_and(|e| e.contains(&format!("transport '{t}' not allowed"))),
                "{r:?}"
            );
        }
    }

    /// Round 2 (review R4): few filters with long names refuse the read with the same reason, never the system's
    /// bare "Argument list too long".
    #[test]
    fn git_read_refuses_filter_names_past_a_byte_limit() {
        let dir = repo("long-filters", "a.txt", "a\n");
        let mut config = std::fs::read(dir.join(".git/config")).unwrap();
        for i in 0..300 {
            let name = format!("f{i}-{}", "x".repeat(300));
            config.extend_from_slice(format!("[filter \"{name}\"]\n\tclean = cat\n").as_bytes());
        }
        std::fs::write(dir.join(".git/config"), config).unwrap();
        let read = git_read(&dir, &["status", "--porcelain"], Duration::from_secs(10));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            read.as_ref().is_err_and(|e| e.contains("too many filters")),
            "{read:?}"
        );
    }

    // v1a-17: the child holds the pipe for 30 s, past the 10 s timeout, so `Ok` can only come from not waiting
    // for it.
    #[test]
    fn output_is_bounded_even_after_its_leader_exits() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & printf ready"]);
        let result = output(command, Duration::from_secs(10)).unwrap();
        assert_eq!(result.stdout, b"ready");
    }
}
