//! v1b-38: whether a Codex session's effective sandbox is read-only, from its launch args and Codex's config layers.
//! Codex 0.161.0 exits at start when a read-only sandbox meets `--add-dir`, so such a session gets no artifact folder
//! root. Only reads; never writes any Codex config.

use std::{
    fs,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

#[cfg(test)]
thread_local! {
    pub(crate) static IN_READ: std::cell::Cell<Option<Box<dyn FnOnce()>>> = const { std::cell::Cell::new(None) };
}

/// Codex's sandbox for a session started with `args` in `cwd` is read-only, reading its account folder (V2-2b), else
/// `$CODEX_HOME`, else `~/.codex`. An unreadable or invalid config (Codex refuses those itself) answers false and logs
/// one line.
pub(crate) fn read_only(args: &[String], cwd: &Path, config_dir: Option<&Path>) -> bool {
    #[cfg(test)]
    if let Some(hook) = IN_READ.take() {
        hook(); // Q9 en-b-J7-1: a test stalls the read as a hung mount would
    }
    let home = crate::accounts::config_home(crate::api::AgentKind::Codex, config_dir)
        .filter(|home| home.is_absolute());
    // Codex keys trust by the real path it runs in.
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    read_only_in(args, &cwd, home.as_deref())
}

/// Layers, highest first, as measured on codex-cli 0.161.0 (V1B-38 Comments): `-s`/`--sandbox`, then
/// `--approve-for-me` (workspace-write) or `--dangerously-bypass-approvals-and-sandbox`, then `-c sandbox_mode=`; then the nearest `.codex/config.toml` from `cwd` up to its git root when the folder is trusted;
/// then the profile file `<name>.config.toml` chosen by `-p`; then `config.toml`. With none set, a folder without a
/// trust entry is read-only. Not seen: the `[permissions]` / `default_permissions` system, `-c projects...`, system or
/// managed config files, and trust set anywhere but `config.toml`.
fn read_only_in(args: &[String], cwd: &Path, home: Option<&Path>) -> bool {
    let launch = launch(args);
    if let Some(mode) = launch.sandbox {
        return mode == "read-only";
    }
    let Some(home) = home else {
        return false;
    };
    match from_config(home, launch.profile.as_deref(), cwd) {
        // v1a-33 (carried from v1b-38): a folder trusted later at Codex's prompt would otherwise lose its artifact
        // folder without a trace.
        Ok((mode, layer)) if mode == "read-only" => {
            eprintln!(
                "codex sandbox: read-only from {layer}; no --add-dir for the artifact folder"
            );
            true
        }
        Ok(_) => false,
        Err(e) => {
            eprintln!("codex sandbox: {e}; adding the artifact folder");
            false
        }
    }
}

struct Launch {
    sandbox: Option<String>,
    profile: Option<String>,
}

/// v1b-35: `-s`/`--sandbox` wins over `-c sandbox_mode=` in either order, and the last of each wins.
fn launch(args: &[String]) -> Launch {
    let (mut flag, mut config, mut profile, mut preset) = (None, None, None, None);
    let mut rest = args.iter().take_while(|a| *a != "--");
    while let Some(arg) = rest.next() {
        // A flag with its value next (`-s v`) or attached (`--sandbox=v`, `-s=v`, `-sv`).
        let mut value = |names: [&str; 2], attached: [&str; 3]| {
            if names.contains(&arg.as_str()) {
                rest.next().map(String::as_str)
            } else {
                attached
                    .iter()
                    .find_map(|p| arg.strip_prefix(p).filter(|v| !v.is_empty()))
            }
        };
        // v1b-38: each sets the sandbox over `-c` and the config layers; Codex refuses either with `-s`.
        if arg == "--approve-for-me" {
            preset = Some("workspace-write");
        } else if arg == "--dangerously-bypass-approvals-and-sandbox" {
            preset = Some("danger-full-access");
        } else if let Some(v) = value(["-s", "--sandbox"], ["--sandbox=", "-s=", "-s"]) {
            flag = Some(v.to_string());
        } else if let Some(v) = value(["-p", "--profile"], ["--profile=", "-p=", "-p"]) {
            profile = Some(v.to_string());
        } else if let Some(v) = value(["-c", "--config"], ["--config=", "-c=", "-c"])
            && let Some((key, v)) = v.split_once('=')
            && key.trim().trim_matches(['"', '\'']) == "sandbox_mode"
        {
            config = Some(v.trim().trim_matches(['"', '\'']).to_string());
        }
    }
    Launch {
        sandbox: flag.or(preset.map(String::from)).or(config),
        profile,
    }
}

/// The mode and the layer that decided it (a file, or the trust default).
fn from_config(home: &Path, profile: Option<&str>, cwd: &Path) -> Result<(String, String), String> {
    let top = table(&home.join("config.toml"))?.unwrap_or_default();
    let (root, main) = git_roots(cwd);
    // The first of these with an entry decides; a parent folder that is no git root does not count.
    let mut trust = None;
    for path in [Some(cwd), root.as_deref(), main.as_deref()]
        .into_iter()
        .flatten()
    {
        let entry = top
            .get("projects")
            .and_then(|p| p.get(path.to_string_lossy().as_ref()))
            .and_then(|p| p.get("trust_level"));
        if let Some(level) = entry {
            match level.as_str() {
                Some(level @ ("trusted" | "untrusted")) => {
                    trust = Some(level == "trusted");
                    break;
                }
                _ => {
                    return Err(format!(
                        "trust_level for {} is not trusted or untrusted",
                        path.display()
                    ));
                }
            }
        }
    }
    if trust == Some(true) {
        let stop = root.as_deref().unwrap_or(cwd);
        for dir in cwd.ancestors() {
            let path = dir.join(".codex/config.toml");
            if let Some(mode) = sandbox(&table(&path)?.unwrap_or_default(), dir)? {
                return Ok((mode, path.display().to_string()));
            }
            if dir == stop {
                break;
            }
        }
    }
    // A name with a path in it is not a profile file in `home`.
    if let Some(name) = profile.filter(|n| !n.contains('/') && !n.starts_with('.')) {
        let path = home.join(format!("{name}.config.toml"));
        if let Some(mode) = sandbox(&table(&path)?.unwrap_or_default(), &path)? {
            return Ok((mode, path.display().to_string()));
        }
    }
    if let Some(mode) = sandbox(&top, home)? {
        return Ok((mode, home.join("config.toml").display().to_string()));
    }
    Ok(if trust.is_some() {
        (
            "workspace-write".into(),
            "the default for a trusted or untrusted folder".into(),
        )
    } else {
        (
            "read-only".into(),
            "the default for a folder with no trust entry".into(),
        )
    })
}

/// Larger than any real Codex config; a bigger file is refused, not read.
const MAX_CONFIG_BYTES: usize = 1024 * 1024;

/// A config file's table; None when it does not exist.
fn table(path: &Path) -> Result<Option<toml::Table>, String> {
    let Some(text) = read(path)? else {
        return Ok(None);
    };
    text.parse().map(Some).map_err(|e: toml::de::Error| {
        format!("{} is not valid TOML ({})", path.display(), e.message())
    })
}

/// A small regular file's text; None when it does not exist. This runs under the registry lock and a project folder
/// is untrusted content, so a FIFO, device or oversize file is refused without blocking or reading it whole.
fn read(path: &Path) -> Result<Option<String>, String> {
    let refuse = |why: String| Err(format!("cannot read {} ({why})", path.display()));
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return refuse(e.to_string()),
    };
    match file.metadata() {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return refuse("not a regular file".into()),
        Err(e) => return refuse(e.to_string()),
    }
    let mut text = String::new();
    if let Err(e) = file
        .take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_string(&mut text)
    {
        return refuse(e.to_string());
    }
    if text.len() > MAX_CONFIG_BYTES {
        return refuse(format!("over {MAX_CONFIG_BYTES} bytes"));
    }
    Ok(Some(text))
}

fn sandbox(table: &toml::Table, at: &Path) -> Result<Option<String>, String> {
    match table.get("sandbox_mode") {
        None => Ok(None),
        Some(toml::Value::String(mode)) => Ok(Some(mode.clone())),
        Some(_) => Err(format!("sandbox_mode in {} is not a string", at.display())),
    }
}

/// The git root above `cwd` and, for a worktree (`.git` file naming `<main>/.git/worktrees/<name>`), its main repo.
fn git_roots(cwd: &Path) -> (Option<PathBuf>, Option<PathBuf>) {
    for dir in cwd.ancestors() {
        let git = dir.join(".git");
        let Ok(meta) = fs::symlink_metadata(&git) else {
            continue;
        };
        let main = meta
            .is_file()
            .then(|| read(&git).ok().flatten())
            .flatten()
            .and_then(|text| {
                let gitdir = dir.join(text.strip_prefix("gitdir:")?.trim());
                let worktrees = gitdir.parent()?;
                (worktrees.file_name()? == "worktrees")
                    .then(|| worktrees.parent()?.parent().map(Path::to_path_buf))
                    .flatten()
            });
        return (Some(dir.to_path_buf()), main);
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const RO: &str = "sandbox_mode = \"read-only\"\n";
    const WW: &str = "sandbox_mode = \"workspace-write\"\n";

    /// A temp CODEX_HOME and project under this checkout's `.scratch/`; never the real `~/.codex`.
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.scratch")
                .join(format!("codex-sandbox-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("home")).unwrap();
            fs::create_dir_all(root.join("proj")).unwrap();
            Self {
                root: root.canonicalize().unwrap(),
            }
        }
        fn home(&self) -> PathBuf {
            self.root.join("home")
        }
        fn proj(&self) -> PathBuf {
            self.root.join("proj")
        }
        fn write(&self, path: impl AsRef<Path>, text: &str) {
            let path = self.root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn trust(&self, path: &Path, level: &str) -> String {
            format!(
                "[projects.\"{}\"]\ntrust_level = \"{level}\"\n",
                path.display()
            )
        }
        fn git(&self, rel: &str) -> PathBuf {
            fs::create_dir_all(self.root.join(rel).join(".git")).unwrap();
            self.root.join(rel)
        }
        /// `rel` becomes a worktree of the repo at `main` (a `.git` file naming `<main>/.git/worktrees/<name>`).
        fn worktree(&self, main: &str, rel: &str) -> PathBuf {
            let gitdir = self.root.join(main).join(".git/worktrees/wt");
            fs::create_dir_all(&gitdir).unwrap();
            self.write(
                Path::new(rel).join(".git"),
                &format!("gitdir: {}\n", gitdir.display()),
            );
            self.root.join(rel)
        }
        fn check(&self, args: &[&str], cwd: &Path) -> bool {
            let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            read_only_in(&args, cwd, Some(&self.home()))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// Each row was measured on codex-cli 0.161.0 with `codex debug prompt-input` (its `sandbox_mode` line) in a temp
    /// CODEX_HOME, and the read-only and writable ends in a pty with `--add-dir` (exit 256 in about 1 s / up 10 s).
    #[test]
    fn codex_sandbox_config_layers() {
        let f = Fixture::new("layers");
        let proj = f.proj();
        let trusted = f.trust(&proj, "trusted");
        // Top-level config.toml (a key after a table header belongs to that table, so the sandbox goes first).
        f.write("home/config.toml", &(RO.to_string() + &trusted));
        assert!(f.check(&[], &proj), "config read-only");
        f.write("home/config.toml", &(trusted.clone() + RO));
        assert!(!f.check(&[], &proj), "not top-level");
        assert!(
            !f.check(&["-s", "workspace-write"], &proj),
            "-s over config"
        );
        assert!(
            !f.check(&["-c", "sandbox_mode=\"workspace-write\""], &proj),
            "-c over config"
        );
        assert!(!f.check(&["-s", "danger-full-access"], &proj));
        // Both flags set the sandbox over `-c` and config.toml (Codex refuses either with `-s`).
        for flag in [
            "--approve-for-me",
            "--dangerously-bypass-approvals-and-sandbox",
        ] {
            assert!(!f.check(&[flag], &proj), "{flag}");
            assert!(
                !f.check(&["-c", "sandbox_mode=\"read-only\"", flag], &proj),
                "{flag} over -c"
            );
        }
        // A profile file `<name>.config.toml`, chosen by `-p`/`--profile`, sits over config.toml.
        f.write("home/config.toml", &(WW.to_string() + &trusted));
        f.write("home/ro.config.toml", RO);
        for args in [
            &["-p", "ro"][..],
            &["--profile", "ro"],
            &["--profile=ro"],
            &["-pro"],
            &["-p=ro"],
        ] {
            assert!(f.check(args, &proj), "{args:?}");
        }
        assert!(!f.check(&[], &proj), "no profile chosen");
        assert!(
            !f.check(&["-p", "nope"], &proj),
            "missing profile file is ignored"
        );
        assert!(
            !f.check(&["-p", "ro", "-s", "workspace-write"], &proj),
            "-s over profile"
        );
        f.write("home/config.toml", &(RO.to_string() + &trusted));
        f.write("home/w.config.toml", WW);
        assert!(!f.check(&["-p", "w"], &proj), "profile over config");
        f.write("home/m.config.toml", "model = \"x\"\n");
        assert!(f.check(&["-p", "m"], &proj), "profile without a sandbox");
        // A legacy `[profiles.x]` table is not a layer.
        f.write(
            "home/config.toml",
            &(WW.to_string() + &trusted + "[profiles.ro]\n" + RO),
        );
        assert!(!f.check(&[], &proj));
    }

    #[test]
    fn codex_sandbox_names_the_layer_that_decided() {
        let f = Fixture::new("layer");
        let proj = f.proj();
        let decided = |profile| from_config(&f.home(), profile, &proj).unwrap();
        assert_eq!(
            decided(None),
            (
                "read-only".into(),
                "the default for a folder with no trust entry".into()
            )
        );
        f.write(
            "home/config.toml",
            &(RO.to_string() + &f.trust(&proj, "trusted")),
        );
        let top = f.home().join("config.toml").display().to_string();
        assert_eq!(decided(None), ("read-only".into(), top));
        f.write("home/ro.config.toml", RO);
        let profile = f.home().join("ro.config.toml").display().to_string();
        assert_eq!(decided(Some("ro")).1, profile);
        f.write("proj/.codex/config.toml", WW);
        let project = proj.join(".codex/config.toml").display().to_string();
        assert_eq!(decided(None), ("workspace-write".into(), project));
    }
    #[test]
    fn codex_sandbox_trust_and_project_layers() {
        let f = Fixture::new("trust");
        // No config at all: an undecided folder defaults to read-only; a trust entry (either level) to writable.
        let plain = f.proj();
        assert!(f.check(&[], &plain), "no config");
        assert!(!f.check(&["-s", "workspace-write"], &plain));
        f.write("home/config.toml", &f.trust(&plain, "trusted"));
        assert!(!f.check(&[], &plain), "trusted, nothing set");
        f.write("home/config.toml", &f.trust(&plain, "untrusted"));
        assert!(!f.check(&[], &plain), "untrusted, nothing set");
        // Only the folder itself and its git root count, not a parent that is no git root.
        fs::create_dir_all(plain.join("sub")).unwrap();
        f.write("home/config.toml", &f.trust(&plain, "trusted"));
        assert!(f.check(&[], &plain.join("sub")), "parent trust, no git");
        // In git the repo root's entry covers a subfolder; a folder above the root does not.
        let repo = f.git("repo");
        fs::create_dir_all(repo.join("sub")).unwrap();
        f.write("home/config.toml", &f.trust(&repo, "trusted"));
        assert!(!f.check(&[], &repo.join("sub")));
        f.write("home/config.toml", &f.trust(&f.root, "trusted"));
        assert!(f.check(&[], &repo), "trust above the git root");
        // A worktree is covered by its main repo's entry, or by its own.
        let wt = f.worktree("repo", "wt");
        f.write("home/config.toml", &f.trust(&repo, "trusted"));
        assert!(!f.check(&[], &wt), "main repo trusted");
        f.write("home/config.toml", &f.trust(&wt, "trusted"));
        assert!(!f.check(&[], &wt), "worktree trusted");
        // A trailing slash is a different key.
        f.write(
            "home/config.toml",
            &format!(
                "[projects.\"{}/\"]\ntrust_level = \"trusted\"\n",
                repo.display()
            ),
        );
        assert!(f.check(&[], &repo));
        // Project `.codex/config.toml` layers load only when trusted; the nearest folder wins; they sit over the
        // profile and config.toml, under the launch args.
        f.write("repo/.codex/config.toml", RO);
        f.write(
            "home/config.toml",
            &(WW.to_string() + &f.trust(&repo, "trusted")),
        );
        assert!(f.check(&[], &repo), "project layer");
        assert!(
            f.check(&[], &repo.join("sub")),
            "root layer reaches a subfolder"
        );
        f.write("repo/sub/.codex/config.toml", WW);
        assert!(!f.check(&[], &repo.join("sub")), "nearest layer wins");
        f.write("home/w.config.toml", WW);
        assert!(f.check(&["-p", "w"], &repo), "project over profile");
        assert!(
            !f.check(&["-s", "workspace-write"], &repo),
            "-s over project"
        );
        f.write(
            "home/config.toml",
            &(WW.to_string() + &f.trust(&repo, "untrusted")),
        );
        assert!(!f.check(&[], &repo), "untrusted project layer ignored");
        f.write("home/config.toml", WW);
        assert!(!f.check(&[], &repo), "undecided project layer ignored");
        // A worktree reads its own `.codex`, not the main repo's.
        f.write(
            "home/config.toml",
            &(WW.to_string() + &f.trust(&repo, "trusted")),
        );
        assert!(!f.check(&[], &wt), "main repo layer not read in a worktree");
        f.write("wt/.codex/config.toml", RO);
        assert!(f.check(&[], &wt), "worktree layer");
    }

    #[test]
    fn codex_sandbox_unreadable_config_keeps_the_folder() {
        let f = Fixture::new("broken");
        let proj = f.proj();
        // Codex itself refuses to start on these; Nunchiro keeps today's behaviour (adds the folder).
        f.write("home/config.toml", "sandbox_mode = \n");
        assert!(!f.check(&[], &proj), "invalid TOML");
        f.write("home/config.toml", "sandbox_mode = 1\n");
        assert!(!f.check(&[], &proj), "wrong type");
        f.write("home/config.toml", &f.trust(&proj, "maybe"));
        assert!(!f.check(&[], &proj), "unknown trust level");
        f.write("home/config.toml", &f.trust(&proj, "trusted"));
        f.write("home/ro.config.toml", "sandbox_mode = \n");
        assert!(!f.check(&["-p", "ro"], &proj), "invalid profile");
        f.write("proj/.codex/config.toml", "[\n");
        assert!(!f.check(&[], &proj), "invalid project layer");
        fs::remove_file(f.root.join("proj/.codex/config.toml")).unwrap();
        fs::create_dir_all(f.root.join("proj/.codex/config.toml")).unwrap();
        assert!(!f.check(&[], &proj), "unreadable project layer");
        // A layer that is no regular file (a FIFO would block the read forever, /dev/zero never ends) or is too
        // large is refused at once, never read.
        fs::remove_dir_all(f.root.join("proj/.codex/config.toml")).unwrap();
        let fifo = std::ffi::CString::new(f.root.join("proj/.codex/config.toml").to_str().unwrap())
            .unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let (done, wait) = std::sync::mpsc::channel();
        let (home, cwd) = (f.home(), proj.clone());
        std::thread::spawn(move || done.send(read_only_in(&[], &cwd, Some(&home))).unwrap());
        assert_eq!(
            wait.recv_timeout(std::time::Duration::from_secs(5)),
            Ok(false),
            "FIFO layer"
        );
        fs::remove_file(f.root.join("proj/.codex/config.toml")).unwrap();
        std::os::unix::fs::symlink("/dev/zero", f.root.join("proj/.codex/config.toml")).unwrap();
        assert!(!f.check(&[], &proj), "/dev/zero layer");
        fs::remove_file(f.root.join("proj/.codex/config.toml")).unwrap();
        f.write(
            "proj/.codex/config.toml",
            &(RO.to_string() + &"#".repeat(MAX_CONFIG_BYTES)),
        );
        assert!(!f.check(&[], &proj), "oversize layer");
        f.write("proj/.codex/config.toml", RO);
        assert!(f.check(&[], &proj), "a plain layer still reads");
        fs::remove_file(f.root.join("proj/.codex/config.toml")).unwrap();
        // No usable home: nothing to read, keep the folder.
        let args: Vec<String> = Vec::new();
        assert!(!read_only_in(&args, &proj, None));
        // A profile name that is a path is not read.
        f.write("ro.config.toml", RO);
        assert!(!f.check(&["-p", "../ro"], &proj));
    }
}
