use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use tauri_plugin_updater::Update;

/// App-specific update tracking in Tauri manage state
pub struct AppUpdaterState {
    pub downloaded_bytes: AtomicU64,
    pub total_bytes: AtomicU64,
    pub failure_message: Mutex<Option<String>>,
    pub pending_action: Mutex<Option<Update>>,
    pub signature: Mutex<Option<Vec<u8>>>,
}

impl Default for AppUpdaterState {
    fn default() -> Self {
        Self {
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            failure_message: Mutex::new(None),
            pending_action: Mutex::new(None),
            signature: Mutex::new(None),
        }
    }
}

/// Rclone-specific update tracking in Tauri manage state
pub struct RcloneUpdaterState {
    pub pending_version: Mutex<Option<String>>,
}

impl Default for RcloneUpdaterState {
    fn default() -> Self {
        Self {
            pending_version: Mutex::new(None),
        }
    }
}
