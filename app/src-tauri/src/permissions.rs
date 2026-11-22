//! Ticket 252 (needs 197, G20): the macOS permission status Settings > Permissions shows, read only. Each probe lists
//! one directory (names only, no file is opened) and maps the result to granted / not granted / unknown. No code here
//! requests a grant, but on a home under `/Volumes` the listing can itself raise macOS's removable-volume prompt for
//! an app with no decision yet. The page opens System Settings for changing a grant.
//!
//! The probe idea is ported from Orca `src/main/macos-full-disk-access-status.ts` (`probeMacosFullDiskAccess`: a
//! TCC-protected path is readable only with Full Disk Access; EACCES/EPERM means not granted, anything else unknown),
//! changed to a directory listing so no file contents are read. Orca: MIT License, Copyright (c) 2026 Lovecast Inc.
use std::{
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
};

/// What the page shows; `full_disk: None` is "unknown".
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct Status {
    pub full_disk: Option<bool>,
    pub volumes: Volumes,
}

/// The volume row: `NotNeeded` for a home not under `/Volumes`, `Unknown` when the probe failed (not a refusal) or
/// the home could not be resolved.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Volumes {
    NotNeeded,
    Granted,
    NotGranted,
    Unknown,
}

/// A listing that worked is granted, a permission refusal (EACCES or EPERM) is not; anything else (no such folder) is unknown.
fn state(listing: io::Result<()>) -> Option<bool> {
    match listing {
        Ok(()) => Some(true),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => Some(false),
        Err(_) => None,
    }
}

/// Opens `dir` and reads its first entry name: TCC refuses one or the other without the grant. No file is opened.
fn list(dir: &Path) -> io::Result<()> {
    std::fs::read_dir(dir)?.next().transpose().map(|_| ())
}

/// `/Volumes/<name>` when `home` lives on a mounted volume, else `None`.
fn volume_of(home: &Path) -> Option<PathBuf> {
    let mut parts = home.components();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(Component::RootDir), Some(Component::Normal(v)), Some(Component::Normal(name)))
            if v == "Volumes" =>
        {
            Some(Path::new("/Volumes").join(name))
        }
        _ => None,
    }
}

/// The probes with the lister passed in, so the tests see exactly which directories are touched.
fn status_with(
    user_home: Option<&Path>,
    nunchiro_home: Option<&Path>,
    list: impl Fn(&Path) -> io::Result<()>,
) -> Status {
    Status {
        full_disk: user_home.and_then(|h| state(list(&h.join("Library/Safari")))),
        volumes: match nunchiro_home.map(volume_of) {
            None => Volumes::Unknown,
            Some(None) => Volumes::NotNeeded,
            Some(Some(v)) => match state(list(&v)) {
                Some(true) => Volumes::Granted,
                Some(false) => Volumes::NotGranted,
                None => Volumes::Unknown,
            },
        },
    }
}

/// The page's one probe. Async, and the listing runs on the blocking pool, so a slow volume holds neither the main
/// thread nor a runtime worker.
#[tauri::command]
pub async fn permission_status<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<Status, String> {
    if webview.label() != "main" {
        return Err("permission_status is for the main window".into());
    }
    // The account's real home: `HOME` may be overridden by whoever started the app, TCC protects the real one.
    let user_home = crate::passwd::passwd_home();
    let nunchiro_home = crate::home().ok();
    tauri::async_runtime::spawn_blocking(move || {
        status_with(user_home.as_deref(), nunchiro_home.as_deref(), list)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Ticket 351: macOS's answer for the app's camera or microphone, which Settings > In-app browser reads to say why an
/// Allow row cannot work. `NotAsked`: macOS asks the first time a page that may have it asks.
#[derive(serde::Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Media {
    Granted,
    NotGranted,
    NotAsked,
    Unknown,
}

/// What `media_status` returns.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct MediaStatus {
    pub camera: Media,
    pub microphone: Media,
}

/// `AVAuthorizationStatus`: 0 not determined, 1 restricted, 2 denied, 3 authorized. Restricted (a profile or parental
/// control) reads as not granted: the owner cannot use it either way.
fn media(status: Option<isize>) -> Media {
    match status {
        Some(0) => Media::NotAsked,
        Some(1 | 2) => Media::NotGranted,
        Some(3) => Media::Granted,
        _ => Media::Unknown,
    }
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVMediaTypeVideo: &'static objc2_foundation::NSString;
    static AVMediaTypeAudio: &'static objc2_foundation::NSString;
}

/// `+[AVCaptureDevice authorizationStatusForMediaType:]`: reads the app's status and never shows a prompt.
#[cfg(target_os = "macos")]
fn av_status(video: bool) -> Option<isize> {
    use objc2::{msg_send, runtime::AnyClass};
    let class = AnyClass::get(c"AVCaptureDevice")?;
    // SAFETY: AVFoundation is linked above, so both constants exist; the method takes an AVMediaType (an NSString)
    // and returns an NSInteger.
    let kind = unsafe {
        if video {
            AVMediaTypeVideo
        } else {
            AVMediaTypeAudio
        }
    };
    Some(unsafe { msg_send![class, authorizationStatusForMediaType: kind] })
}

#[cfg(not(target_os = "macos"))]
fn av_status(_video: bool) -> Option<isize> {
    None
}

/// Ticket 351: Settings > In-app browser's read of the camera and microphone status (main window only). Read only:
/// the prompt is macOS's, shown when a page asks and the site's row lets WebKit ask.
#[tauri::command]
pub fn media_status<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Result<MediaStatus, String> {
    if webview.label() != "main" {
        return Err("media_status is for the main window".into());
    }
    Ok(MediaStatus {
        camera: media(av_status(true)),
        microphone: media(av_status(false)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, os::unix::fs::PermissionsExt};

    fn err(kind: ErrorKind) -> io::Result<()> {
        Err(io::Error::from(kind))
    }

    #[test]
    fn state_maps_listing_results() {
        assert_eq!(state(Ok(())), Some(true));
        assert_eq!(state(err(ErrorKind::PermissionDenied)), Some(false));
        // EPERM, TCC's usual refusal, is PermissionDenied too.
        assert_eq!(
            state(Err(io::Error::from_raw_os_error(libc::EPERM))),
            Some(false)
        );
        assert_eq!(
            state(Err(io::Error::from_raw_os_error(libc::EACCES))),
            Some(false)
        );
        assert_eq!(state(err(ErrorKind::NotFound)), None);
    }

    #[test]
    fn volume_of_finds_the_mounted_volume() {
        assert_eq!(
            volume_of(Path::new("/Volumes/External/.nunchiro")),
            Some(PathBuf::from("/Volumes/External"))
        );
        assert_eq!(
            volume_of(Path::new("/Volumes/External")),
            Some(PathBuf::from("/Volumes/External"))
        );
        assert_eq!(volume_of(Path::new("/Users/me/.nunchiro")), None);
        assert_eq!(volume_of(Path::new("/Volumes")), None);
        assert_eq!(volume_of(Path::new("Volumes/x")), None);
    }

    #[test]
    fn status_with_probes_only_the_two_folders() {
        let seen = RefCell::new(Vec::new());
        let s = status_with(
            Some(Path::new("/Users/me")),
            Some(Path::new("/Volumes/Other/home")),
            |p| {
                seen.borrow_mut().push(p.to_path_buf());
                if p.starts_with("/Users") {
                    err(ErrorKind::PermissionDenied)
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(
            s,
            Status {
                full_disk: Some(false),
                volumes: Volumes::Granted
            }
        );
        assert_eq!(
            *seen.borrow(),
            vec![
                PathBuf::from("/Users/me/Library/Safari"),
                PathBuf::from("/Volumes/Other")
            ]
        );
        // A home on the system disk needs no volume grant: nothing is listed for it.
        seen.borrow_mut().clear();
        let s = status_with(None, Some(Path::new("/Users/me/.nunchiro")), |p| {
            seen.borrow_mut().push(p.to_path_buf());
            Ok(())
        });
        assert_eq!(
            s,
            Status {
                full_disk: None,
                volumes: Volumes::NotNeeded
            }
        );
        assert!(seen.borrow().is_empty());
    }

    // A volume probe that fails for another reason than a refusal is unknown, not "not needed"; so is a home that
    // could not be resolved.
    #[test]
    fn volumes_tells_not_needed_from_a_failed_probe() {
        let on_ssd = Some(Path::new("/Volumes/Other/home"));
        let with = |home, e: ErrorKind| status_with(None, home, |_| err(e)).volumes;
        assert_eq!(with(on_ssd, ErrorKind::NotFound), Volumes::Unknown);
        assert_eq!(
            with(on_ssd, ErrorKind::PermissionDenied),
            Volumes::NotGranted
        );
        assert_eq!(with(None, ErrorKind::NotFound), Volumes::Unknown);
        assert_eq!(
            with(Some(Path::new("/Users/me/.nunchiro")), ErrorKind::NotFound),
            Volumes::NotNeeded
        );
        let json = |v| serde_json::to_value(v).unwrap();
        assert_eq!(json(Volumes::NotNeeded), "not_needed");
        assert_eq!(json(Volumes::NotGranted), "not_granted");
    }

    // A slow or hung volume must not hold a runtime worker: the listing runs on the blocking pool (as fonts.rs does).
    #[test]
    fn permission_status_probes_on_the_blocking_pool() {
        let src = include_str!("permissions.rs");
        let code = &src[..src.find(concat!("#[cfg", "(test)]")).unwrap()];
        assert!(code.contains(concat!("async_runtime::spawn_", "blocking(move ||")));
    }

    /// Ticket 351: each AVAuthorizationStatus maps to what the In-app browser page says; anything else is unknown.
    #[test]
    fn media_maps_the_capture_status() {
        assert_eq!(media(Some(0)), Media::NotAsked);
        assert_eq!(media(Some(1)), Media::NotGranted);
        assert_eq!(media(Some(2)), Media::NotGranted);
        assert_eq!(media(Some(3)), Media::Granted);
        assert_eq!(media(Some(7)), Media::Unknown);
        assert_eq!(media(None), Media::Unknown);
        assert_eq!(
            serde_json::to_value(MediaStatus {
                camera: Media::NotGranted,
                microphone: Media::NotAsked
            })
            .unwrap(),
            serde_json::json!({"camera": "not_granted", "microphone": "not_asked"})
        );
    }

    #[test]
    fn listing_opens_no_file_and_source_names_no_grant_request_call() {
        // A listing works on a folder whose only file nobody may read: the probe opens no file.
        let dir = std::env::temp_dir().join(format!("nunchiro-perms-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("secret");
        std::fs::write(&file, "x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(state(list(&dir)), Some(true));
        std::fs::remove_dir_all(&dir).unwrap();
        // The module's code (not these tests) names none of these calls. This cannot show that macOS stays silent.
        let src = include_str!("permissions.rs");
        let code = &src[..src.find(concat!("#[cfg", "(test)]")).unwrap()];
        for banned in [
            concat!("File", "::open"),
            concat!("read", "_to_string"),
            concat!("fs::", "read("),
            concat!("Open", "Options"),
            concat!("request", "Access"),
            concat!("AXIsProcess", "TrustedWithOptions"),
            concat!("CGRequest", "ScreenCaptureAccess"),
            concat!("ask", "ForMediaAccess"),
            concat!("request", "AccessForMediaType"),
            concat!("osa", "script"),
            concat!("Command", "::new"),
            concat!("Udp", "Socket"),
        ] {
            assert!(!code.contains(banned), "permissions.rs calls {banned}");
        }
    }
}
