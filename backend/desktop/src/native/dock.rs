use tauri::Manager;
pub fn update_macos_dock_visibility(app_handle: &crate::context::AppHandle) {
    let has_visible_windows = app_handle
        .webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false));

    let policy = if has_visible_windows {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    let _ = app_handle.set_activation_policy(policy);
}
