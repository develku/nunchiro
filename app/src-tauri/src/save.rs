//! v1a-68 r5 (needs 78): "Save to file…" for a closed shell's text. The user picks the place in the native save
//! panel (as iTerm2's "Save Contents…"); the page sends only a suggested file name and the text, never a path.
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

/// More than the core's 1 MiB replay, so a whole closed view always fits.
pub const MAX_TEXT: usize = 2 * 1024 * 1024;

/// The page's suggested name as a bare file name: path separators and controls become `-`, at most 200 chars.
pub fn file_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == ':' || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .take(200)
        .collect();
    match name.trim_start_matches('.') {
        "" => "scrollback.txt".into(),
        name => name.into(),
    }
}

/// Writes `text` to the chosen file, replacing it whole (the panel already asked before replacing).
pub fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT {
        return Err("text exceeds 2 MiB".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

static PANEL_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Held while a save panel is up; a second call meanwhile gets None (two quick clicks never stack two panels).
struct OnePanel;
impl Drop for OnePanel {
    fn drop(&mut self) {
        PANEL_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
fn one_panel() -> Option<OnePanel> {
    (!PANEL_OPEN.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(OnePanel)
}

/// Shows the save panel; the chosen path, or None when the user cancels. Main thread only.
#[cfg(target_os = "macos")]
fn pick(name: &str) -> Option<std::path::PathBuf> {
    use objc2_app_kit::{NSModalResponseOK, NSSavePanel};
    use objc2_foundation::{MainThreadMarker, NSArray, NSString};
    let panel = NSSavePanel::savePanel(MainThreadMarker::new()?);
    panel.setNameFieldStringValue(&NSString::from_str(name));
    panel.setCanCreateDirectories(true);
    // setAllowedContentTypes needs UTType (objc2-uniform-type-identifiers, not in the tree); the file-type form
    // does the same for one extension.
    #[allow(deprecated)]
    panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&[NSString::from_str(
        "txt",
    )])));
    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    Some(panel.URL()?.path()?.to_string().into())
}

#[cfg(not(target_os = "macos"))]
fn pick(_name: &str) -> Option<std::path::PathBuf> {
    None
}

/// The chosen file's path, or "cancelled". Only the app's own window may call it; frames inside it cannot reach the
/// IPC (the window CSP, as v1a-67's font commands).
#[tauri::command]
pub async fn save_text<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    name: String,
    text: String,
) -> Result<String, String> {
    if webview.label() != "main" {
        return Err("not allowed".into());
    }
    if text.len() > MAX_TEXT {
        return Err("text exceeds 2 MiB".into());
    }
    let _panel = one_panel().ok_or("a save panel is already open")?;
    let name = file_name(&name);
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(pick(&name));
    })
    .map_err(|e| e.to_string())?;
    let chosen = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "save panel did not answer")?;
    let Some(path) = chosen else {
        return Ok("cancelled".into());
    };
    write_text(&path, &text)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nunchiro-save-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_text_writes_exactly_the_text_and_replaces_the_file() {
        let dir = dir("write");
        let path = dir.join("shut-2026-10-27-1040.txt");
        std::fs::write(&path, "an older, longer file").unwrap();
        write_text(&path, "closed-words\nline-two\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "closed-words\nline-two\n"
        );
        let fresh = dir.join("new.txt");
        write_text(&fresh, "x").unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_text_refuses_over_the_cap_and_leaves_the_file() {
        let dir = dir("cap");
        let path = dir.join("big.txt");
        std::fs::write(&path, "kept").unwrap();
        assert!(write_text(&path, &"x".repeat(MAX_TEXT + 1)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept");
        write_text(&path, &"x".repeat(MAX_TEXT)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_one_save_panel_at_a_time() {
        let first = one_panel().expect("first panel");
        assert!(
            one_panel().is_none(),
            "a second panel opened while one is up"
        );
        drop(first);
        assert!(one_panel().is_some(), "the guard was not released");
    }

    #[test]
    fn the_suggested_name_is_never_a_path() {
        assert_eq!(
            file_name("shut-2026-10-27-1040.txt"),
            "shut-2026-10-27-1040.txt"
        );
        assert_eq!(file_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(file_name("a:b\nc"), "a-b-c");
        assert_eq!(file_name(""), "scrollback.txt");
        assert_eq!(file_name(".."), "scrollback.txt");
        assert_eq!(file_name(&"n".repeat(300)).chars().count(), 200);
    }
}
