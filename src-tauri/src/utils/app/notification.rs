use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::RcloneState;

pub fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    let enabled = match app.state::<RcloneState>().notifications_enabled.read() {
        Ok(enabled) => *enabled,
        Err(e) => {
            log::error!("Failed to read notifications_enabled: {e}");
            false // Default to disabled if we can't read
        }
    };
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
