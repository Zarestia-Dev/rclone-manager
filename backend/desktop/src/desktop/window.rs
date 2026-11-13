fn apply_platform_config(
    builder: tauri::WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle> {
    let b = builder
        .inner_size(800.0, 630.0)
        .resizable(true)
        .center()
        .shadow(false)
        .devtools(true)
        .min_inner_size(362.0, 240.0);

    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Visible);

    #[cfg(target_os = "windows")]
    let b = b.scroll_bar_style(tauri::webview::ScrollBarStyle::FluentOverlay);

    #[cfg(not(target_os = "macos"))]
    let b = b.decorations(false).transparent(true);

    b
}

pub fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn present_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        focus_window(&window);
        #[cfg(target_os = "macos")]
        crate::native::dock::update_macos_dock_visibility(app);
    } else if let Err(error) = create_app_window(app) {
        // A failed re-creation must not take down a background app.
        log::error!("Failed to recreate the main window: {error}");
    }
}

pub fn create_app_window(app_handle: &tauri::AppHandle) -> tauri::Result<()> {
    let builder =
        tauri::WebviewWindowBuilder::new(app_handle, "main", tauri::WebviewUrl::default())
            .title(crate::app::PRODUCT.display_name);

    let window = apply_platform_config(builder).build()?;
    focus_window(&window);

    #[cfg(target_os = "macos")]
    crate::native::dock::update_macos_dock_visibility(app_handle);
    Ok(())
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    pub label: String,
    pub url: String,
    pub title: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// Where an already open file browser should navigate. Only the tray sets it.
    pub remote: Option<String>,
}

/// The standalone file browser, one window per remote (`nautilus-<remote>`).
#[cfg(feature = "tray")]
pub(crate) fn nautilus_window(remote: Option<&str>) -> WindowOptions {
    let (label, url) = match remote {
        Some(name) => {
            let slug: String = name
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            (
                format!("nautilus-{slug}"),
                format!("index.html#/nautilus/{}", urlencoding::encode(name)),
            )
        }
        None => ("nautilus".to_string(), "index.html#/nautilus".to_string()),
    };
    WindowOptions {
        label,
        url,
        title: "RClone Nautilus".to_string(),
        width: Some(1024.0),
        height: Some(768.0),
        remote: remote.map(str::to_string),
    }
}

/// Opens a window. Returns `true` when a new window was created; `false` when the
/// label already existed (it is focused instead) or the window could not be built.
#[tauri::command]
pub async fn new_window(app_handle: tauri::AppHandle, opts: WindowOptions) -> bool {
    use tauri::{Emitter, Manager};

    if let Some(existing) = app_handle.get_webview_window(&opts.label) {
        focus_window(&existing);

        if opts.label == "nautilus" || opts.label.starts_with("nautilus-") {
            // Only that window navigates: every window's file browser listens for this
            // event, and the others would open yet another window.
            let target = opts.remote.unwrap_or_default();
            if let Err(error) = app_handle.emit_to(
                tauri::EventTarget::webview_window(&opts.label),
                crate::utils::types::events::BROWSE,
                target,
            ) {
                log::error!(
                    "Failed to send the browse target to {}: {error}",
                    opts.label
                );
            }
        }
        return false;
    }

    let w = opts.width.unwrap_or(360.0);
    let h = opts.height.unwrap_or(240.0);

    let builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &opts.label,
        tauri::WebviewUrl::App(opts.url.into()),
    )
    .title(&opts.title);

    // The platform defaults come first: the builder keeps the last size it is given, and
    // they would otherwise override the size the caller asked for.
    match apply_platform_config(builder)
        .inner_size(w, h)
        .min_inner_size(360.0, 240.0)
        .build()
    {
        Ok(window) => {
            focus_window(&window);
            #[cfg(target_os = "macos")]
            crate::native::dock::update_macos_dock_visibility(&app_handle);
            true
        }
        Err(e) => {
            log::error!("Failed to build window {}: {e}", opts.label);
            false
        }
    }
}

#[cfg(all(test, feature = "tray"))]
mod tests {
    use super::*;

    #[test]
    fn nautilus_windows_are_named_per_remote() {
        let all = nautilus_window(None);
        assert_eq!(
            (all.label.as_str(), all.url.as_str()),
            ("nautilus", "index.html#/nautilus")
        );

        let remote = nautilus_window(Some("My Drive:é"));
        assert_eq!(remote.label, "nautilus-My_Drive_é");
        assert_eq!(remote.url, "index.html#/nautilus/My%20Drive%3A%C3%A9");
        assert_eq!(remote.remote.as_deref(), Some("My Drive:é"));
    }
}
