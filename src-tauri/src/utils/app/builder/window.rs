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
        crate::utils::app::platform::update_macos_dock_visibility(app);
    } else {
        create_app_window(app.clone());
    }
}

pub fn create_app_window(app_handle: tauri::AppHandle) {
    let builder =
        tauri::WebviewWindowBuilder::new(&app_handle, "main", tauri::WebviewUrl::default())
            .title("RClone Manager");

    let window = apply_platform_config(builder)
        .build()
        .expect("Failed to build main window");

    focus_window(&window);

    #[cfg(target_os = "macos")]
    crate::utils::app::platform::update_macos_dock_visibility(&app_handle);
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    pub label: String,
    pub url: String,
    pub title: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub remote: Option<String>,
    pub path: Option<String>,
}

use crate::core::bridge;

#[bridge]
pub async fn new_window(app_handle: tauri::AppHandle, opts: WindowOptions) -> bool {
    if let Some(existing) = tauri::Manager::get_webview_window(&app_handle, &opts.label) {
        focus_window(&existing);

        // Special case: if this is a nautilus window, emit BROWSE event with the path
        if opts.label.starts_with("nautilus-") || opts.label == "nautilus" {
            let full_path = match (opts.remote, opts.path) {
                (Some(r), Some(p)) => {
                    let is_local = crate::rclone::state::cache::is_local_path(&r);
                    let sep = if is_local { "/" } else { ":" };
                    format!("{}{}{}", r, sep, p.trim_start_matches('/'))
                }
                (Some(r), None) => r,
                (None, Some(p)) => p,
                _ => String::new(),
            };
            use crate::utils::types::events::BROWSE;
            crate::core::bridge::emit(BROWSE, full_path);
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
    .title(&opts.title)
    .inner_size(w, h)
    .min_inner_size(360.0, 240.0);

    match apply_platform_config(builder).build() {
        Ok(window) => {
            focus_window(&window);
            #[cfg(target_os = "macos")]
            crate::utils::app::platform::update_macos_dock_visibility(&app_handle);
            true
        }
        Err(e) => {
            log::error!("Failed to build window {}: {e}", opts.label);
            false
        }
    }
}
