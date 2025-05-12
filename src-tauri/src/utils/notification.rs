use std::sync::{Arc, RwLock};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone)]
pub struct NotificationService {
    pub enabled: Arc<RwLock<bool>>,
}

impl NotificationService {
    pub fn send(&self, app: &tauri::AppHandle, title: &str, body: &str) {
        let enabled = *self.enabled.read().unwrap();
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
}
