//! Ticket 172 (needs 151): dev web-load. A debug build started with `NUNCHIRO_WEB` set loads the web UI from a
//! folder inside this checkout (`web/dist`, read at each request) or from a dev server on this Mac's loopback, so a
//! web-only change shows after a web build and Develop > Reload UI, with no app rebuild.
//! Compiled only when `debug_assertions` and tauri's `dev` cfg are both on: `tauri build` (custom-protocol, release)
//! drops this module and refuses the variable instead (`main.rs`), because a shipped app reading its UI from disk or
//! a port would run whatever sits there with the core's window token.
//! Same idea as t3code's `VITE_DEV_SERVER_URL` and Orca's `ELECTRON_RENDERER_URL` (both MIT, Electron, no code
//! lifted): those trust any URL; this one takes loopback only and needs a non-default NUNCHIRO_HOME.
use std::{
    borrow::Cow,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::{
    AppHandle, Assets, Manager, Url,
    menu::{MenuItem, Submenu},
    utils::assets::{AssetKey, AssetsIter, CspHash},
};

pub const VAR: &str = "NUNCHIRO_WEB";
pub const RELOAD: &str = "dev_reload";

/// Set once in `apply`: what the window loads, for the menu and `own_origin`.
static ACTIVE: OnceLock<Source> = OnceLock::new();

#[derive(Debug, PartialEq)]
pub enum Source {
    Folder(PathBuf),
    Server(Url),
}

/// A value of `NUNCHIRO_WEB`: an `http://` URL on loopback, or a folder (relative to the working directory) that
/// resolves, symlinks followed, inside `repo` and holds an `index.html`.
pub fn parse(value: &str, repo: &Path) -> Result<Source, String> {
    if value.contains("://") {
        let url =
            Url::parse(value).map_err(|e| format!("dev web-load: {value:?} is not a URL ({e})"))?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "http" || !loopback || url.port().is_none() {
            return Err(format!(
                "dev web-load: {value:?} refused: only http://localhost:<port>, 127.0.0.1 or [::1]"
            ));
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(format!(
                "dev web-load: {value:?} refused: give the origin only, like http://localhost:5173"
            ));
        }
        return Ok(Source::Server(url));
    }
    let root = Path::new(value)
        .canonicalize()
        .map_err(|e| format!("dev web-load: folder {value:?} not found ({e})"))?;
    if !root.starts_with(repo) {
        return Err(format!(
            "dev web-load: {} refused: outside the checkout {}",
            root.display(),
            repo.display()
        ));
    }
    if !root.join("index.html").is_file() {
        return Err(format!(
            "dev web-load: no index.html in {} (run pnpm --filter nunchiro-web build)",
            root.display()
        ));
    }
    Ok(Source::Folder(root))
}

/// The dev app runs on a home of its own: never the user's `~/.nunchiro`, whose core is the live one.
pub fn check_home(home: Option<&OsStr>, user_home: Option<&OsStr>) -> Result<(), String> {
    let home = home.ok_or("dev web-load needs NUNCHIRO_HOME set to a temp home")?;
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if user_home.is_some_and(|u| canon(&Path::new(u).join(".nunchiro")) == canon(Path::new(home))) {
        return Err("dev web-load refused: NUNCHIRO_HOME is ~/.nunchiro; use a temp home".into());
    }
    Ok(())
}

/// Reads `NUNCHIRO_WEB` and points the context at it. `Ok(None)` when unset: the embedded UI, as in a release.
pub fn apply(context: &mut tauri::Context) -> Result<Option<String>, String> {
    let Some(value) = std::env::var_os(VAR) else {
        return Ok(None);
    };
    check_home(
        std::env::var_os("NUNCHIRO_HOME").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )?;
    let value = value
        .to_str()
        .ok_or("dev web-load: NUNCHIRO_WEB is not UTF-8")?;
    let repo = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .canonicalize()
        .map_err(|e| format!("dev web-load: checkout not found ({e})"))?;
    let source = parse(value, &repo)?;
    let shown = match &source {
        Source::Folder(root) => {
            context.set_assets(Box::new(Folder(root.clone())));
            root.display().to_string()
        }
        // Under cfg(dev) tauri resolves `WebviewUrl::App` against devUrl and treats that origin as local (IPC).
        Source::Server(url) => {
            context.config_mut().build.dev_url = Some(url.clone());
            url.to_string()
        }
    };
    let _ = ACTIVE.set(source);
    Ok(Some(format!("dev web-load: UI from {shown}")))
}

/// The dev server's origin counts as the window's own (token hand-off, navigation); a folder keeps tauri://.
pub fn server_origin(url: &Url) -> bool {
    matches!(ACTIVE.get(), Some(Source::Server(dev)) if dev.origin() == url.origin())
}

/// `NUNCHIRO_WINDOW_ORIGINS` for a core this app starts: the core's WebSocket takes only allowlisted origins, so
/// the dev server's origin is added to what is already set. A core already running keeps its own list.
pub fn core_origins(existing: Option<&OsStr>) -> Option<String> {
    origins_for(ACTIVE.get(), existing.and_then(OsStr::to_str))
}

fn origins_for(source: Option<&Source>, existing: Option<&str>) -> Option<String> {
    let Some(Source::Server(url)) = source else {
        return None;
    };
    let origin = url.origin().ascii_serialization();
    Some(match existing.filter(|e| !e.trim().is_empty()) {
        Some(e) => format!("{e},{origin}"),
        None => origin,
    })
}

/// Develop > Reload UI (Cmd+R), only while dev web-load is on.
pub fn menu(app: &AppHandle) -> tauri::Result<Option<Submenu<tauri::Wry>>> {
    if ACTIVE.get().is_none() {
        return Ok(None);
    }
    let reload = MenuItem::with_id(app, RELOAD, "Reload UI", true, Some("CmdOrCtrl+R"))?;
    Submenu::with_items(app, "Develop", true, &[&reload]).map(Some)
}

pub fn reload(app: &AppHandle) {
    if let Some(page) = app.get_webview("main") {
        let _ = page.reload();
    }
}

/// Files under one canonical folder, read at each request so a new web build shows on reload.
pub struct Folder(PathBuf);

impl Folder {
    fn read(&self, key: &str) -> Option<Vec<u8>> {
        // Canonicalize after the join: `..` and symlinks that leave the folder are refused.
        let path = self
            .0
            .join(key.trim_start_matches('/'))
            .canonicalize()
            .ok()?;
        if !path.starts_with(&self.0) || !path.is_file() {
            return None;
        }
        std::fs::read(path).ok()
    }
}

impl<R: tauri::Runtime> Assets<R> for Folder {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.read(key.as_ref()).map(Cow::Owned)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    // No hashes: the built index.html has no inline script; the config CSP still applies to every page.
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::{Folder, Source, check_home, origins_for, parse};
    use std::{ffi::OsStr, fs, path::PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch/dev-load-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    // ticket 172: dev_load_localhost_only
    #[test]
    fn dev_load_localhost_only_urls() {
        let repo = scratch("urls");
        for ok in [
            "http://localhost:5173",
            "http://127.0.0.1:5173/",
            "http://[::1]:4173",
        ] {
            assert!(matches!(parse(ok, &repo), Ok(Source::Server(_))), "{ok}");
        }
        for bad in [
            "http://example.com:5173",
            "https://localhost:5173",
            "http://localhost.evil.example:5173",
            "http://192.168.1.2:5173",
            "http://0.0.0.0:5173",
            "http://localhost",
            "http://user@localhost:5173",
            "http://localhost:5173/x",
            "http://localhost:5173/?a=1",
            "http://localhost:5173/#x",
            "file:///etc",
            "ws://localhost:5173",
        ] {
            let err = parse(bad, &repo).unwrap_err();
            assert!(err.starts_with("dev web-load:"), "{bad}: {err}");
        }
    }

    // ticket 172: dev_load_localhost_only (folders)
    #[test]
    fn dev_load_folder_inside_the_checkout_only() {
        let repo = scratch("folders");
        let dist = repo.join("web/dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.html"), "<p>dev</p>").unwrap();
        assert_eq!(
            parse(dist.to_str().unwrap(), &repo),
            Ok(Source::Folder(dist.clone()))
        );
        let outside = scratch("folders-outside");
        fs::write(outside.join("index.html"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("link")).unwrap();
        for bad in [
            outside.clone(),
            repo.join("link"),
            dist.join("../../../folders-outside"),
            repo.join("web"), // no index.html
            repo.join("missing"),
        ] {
            assert!(
                parse(bad.to_str().unwrap(), &repo).is_err(),
                "{}",
                bad.display()
            );
        }
    }

    #[test]
    fn folder_serves_only_files_inside_it() {
        let repo = scratch("serve");
        let dist = repo.join("dist");
        fs::create_dir_all(dist.join("assets")).unwrap();
        fs::write(dist.join("index.html"), "one").unwrap();
        fs::write(dist.join("assets/a.js"), "js").unwrap();
        fs::write(repo.join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(repo.join("secret"), dist.join("leak")).unwrap();
        let folder = Folder(dist.clone());
        assert_eq!(folder.read("/assets/a.js").as_deref(), Some(&b"js"[..]));
        for bad in [
            "/../secret",
            "/assets/../../secret",
            "//../secret",
            "/leak",
            "/assets",
            "/nope",
        ] {
            assert_eq!(folder.read(bad), None, "{bad}");
        }
        // Read at each request: a rebuild shows without restarting.
        fs::write(dist.join("index.html"), "two").unwrap();
        assert_eq!(folder.read("/index.html").as_deref(), Some(&b"two"[..]));
    }

    #[test]
    fn a_dev_server_origin_reaches_the_core_allowlist() {
        let server = Source::Server("http://localhost:5173/".parse().unwrap());
        assert_eq!(
            origins_for(Some(&server), None).as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(
            origins_for(Some(&server), Some("http://127.0.0.1:4173")).as_deref(),
            Some("http://127.0.0.1:4173,http://localhost:5173")
        );
        assert_eq!(origins_for(Some(&Source::Folder("/x".into())), None), None);
        assert_eq!(origins_for(None, Some("http://127.0.0.1:4173")), None);
    }

    #[test]
    fn dev_load_needs_a_home_of_its_own() {
        let user = scratch("home");
        fs::create_dir_all(user.join(".nunchiro")).unwrap();
        let os = |p: &PathBuf| p.as_os_str().to_owned();
        assert!(check_home(None, Some(OsStr::new("/Users/x"))).is_err());
        assert!(check_home(Some(&os(&user.join(".nunchiro"))), Some(&os(&user))).is_err());
        assert!(check_home(Some(&os(&user.join("./.nunchiro"))), Some(&os(&user))).is_err());
        assert!(check_home(Some(&os(&user.join("tmp-home"))), Some(&os(&user))).is_ok());
    }
}
