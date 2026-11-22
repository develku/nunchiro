//! v25f-title-hidden: Title bar "Hidden" also hides the traffic lights (close, minimise, zoom); the page calls this on
//! every titleBar change. The window keeps its style mask, so Cmd+M (the Window menu's Minimize) still works.
//!
//! Once `main` holds a child webview (a browser pane, alive even while hidden) Tauri no longer counts it as a
//! `WebviewWindow`: `get_webview_window` returns `None` and a `WebviewWindow` command argument is refused. The main
//! window goes through `get_window` and its page through `get_webview`, which hold with or without a child.

use tauri::{AppHandle, Manager, Runtime, Webview, Window};

/// Shows the main window again; `None` when it does not exist and has to be built.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Result<()>> {
    let window = app.get_window("main")?;
    let _ = window.unminimize();
    Some(window.show().and_then(|()| window.set_focus()))
}

/// Hands a close request to the page, which may show the one-time notice. False when no page could be asked: the
/// caller must close the window itself. A page still loading or crashed closes straight away for the same reason.
pub fn ask_page_to_close<R: Runtime>(window: &Window<R>) -> bool {
    window.get_webview(window.label()).is_some_and(|page| {
        page.eval(
            "window.__nunchiroCloseReady ? window.dispatchEvent(new Event('nunchiro:close-request')) : window.__TAURI_INTERNALS__.invoke('close_window')",
        )
        .is_ok()
    })
}

/// Ticket 372: `alerts` is the page's one bit for the closed-window count alert; a close without it (the page was not
/// ready, `ask_page_to_close`) keeps alerts on.
#[tauri::command]
pub fn close_window<R: Runtime>(webview: Webview<R>, alerts: Option<bool>) -> Result<(), String> {
    crate::cli_install::main_only(&webview)?; // a `WebviewWindow` argument used to keep child webviews out
    crate::CLOSED_ALERTS.store(alerts.unwrap_or(true), std::sync::atomic::Ordering::Relaxed);
    let _ = webview.window().destroy();
    Ok(())
}

#[tauri::command]
pub fn window_buttons<R: tauri::Runtime>(webview: Webview<R>, shown: bool) -> Result<(), String> {
    // A `Window` argument is `main` also for a browser view inside it, so the guard reads the calling webview.
    crate::cli_install::main_only(&webview)?;
    let window = webview.window();
    #[cfg(all(target_os = "macos", not(test)))]
    // the mock runtime has no NSWindow behind its handle
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::{NSWindow, NSWindowButton};
            let Ok(ptr) = w.ns_window() else { return };
            // SAFETY: Tauri hands out the live NSWindow of `w`, read here on the main thread.
            let ns = unsafe { &*(ptr as *const NSWindow) };
            for b in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(button) = ns.standardWindowButton(b) {
                    button.setHidden(!shown);
                }
            }
        });
    }
    #[cfg(any(not(target_os = "macos"), test))]
    let _ = (window, shown);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ask_page_to_close, close_window, show_main, window_buttons};
    use tauri::ipc::{CallbackFn, InvokeResponse};
    use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::webview::{InvokeRequest, WebviewBuilder};
    use tauri::{App, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

    /// `main` with a browser pane attached, the way `browser::show` builds it.
    fn app_with_browser_view() -> App<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![window_buttons, close_window])
            .build(mock_context(noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let url = "http://127.0.0.1/".parse().unwrap();
        app.get_window("main")
            .unwrap()
            .add_child(
                WebviewBuilder::new("browser-a", WebviewUrl::External(url)),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(10.0, 10.0),
            )
            .unwrap();
        app
    }

    /// The command's error through the real IPC path, `None` when it answered.
    fn invoke(view: Webview<MockRuntime>, cmd: &str, body: serde_json::Value) -> Option<String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        view.on_message(
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_, _, response, _, _| {
                let _ = tx.send(match response {
                    InvokeResponse::Err(e) => e.0.as_str().map(String::from),
                    InvokeResponse::Ok(_) => None,
                });
            }),
        );
        rx.recv().unwrap()
    }

    // Owner RC F1: an open browser pane is a child webview of `main`; the title bar setting must still reach the buttons.
    #[test]
    fn window_buttons_answers_with_a_browser_view_open() {
        let app = app_with_browser_view();
        let main = app.get_webview("main").unwrap();
        let body = serde_json::json!({"shown": false});
        assert_eq!(invoke(main, "window_buttons", body), None);
    }

    // F1 follow-up: with a browser pane open the red button did nothing, and the Dock and tray could not reopen.
    #[test]
    fn close_and_reopen_work_with_a_browser_view_open() {
        let app = app_with_browser_view();
        assert!(ask_page_to_close(&app.get_window("main").unwrap()));
        assert!(show_main(app.handle()).unwrap().is_ok());
        let main = app.get_webview("main").unwrap();
        assert_eq!(invoke(main, "close_window", serde_json::json!({})), None);
    }

    #[test]
    fn close_window_refuses_a_browser_view() {
        let app = app_with_browser_view();
        let child = app.get_webview("browser-a").unwrap();
        assert_eq!(
            invoke(child, "close_window", serde_json::json!({})).as_deref(),
            Some("not allowed")
        );
    }
}
