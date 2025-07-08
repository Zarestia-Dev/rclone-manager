use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::RcloneState;

pub fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    let enabled = *app
        .state::<RcloneState>()
        .notifications_enabled
        .read()
        .unwrap();
    log::debug!("🔔 Notifications enabled: {enabled}");
    if enabled {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .auto_cancel()
            .show()
            .unwrap();
    } else {
        log::debug!("🔕 Notifications are disabled. Skipping.");
    }
}
