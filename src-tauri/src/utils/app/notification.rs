use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

pub fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    // Read notifications setting from JsonSettingsManager which caches internally
    let enabled: bool = app
        .try_state::<rcman::JsonSettingsManager>()
        .and_then(|manager| manager.inner().get("general.notifications").ok())
        .unwrap_or(false);

    log::debug!("🔔 Notifications enabled: {enabled}");
    if enabled {
        if let Err(e) = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .auto_cancel()
            .show()
        {
            log::error!("Failed to show notification: {e}");
        }
    } else {
        log::debug!("🔕 Notifications are disabled. Skipping.");
    }
}
