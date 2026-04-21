use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use tauri_plugin_updater::Update;

/// Tracks the in-flight app self-update download and its staged payload.
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

/// Rclone update metadata — mirrors the frontend `RcloneUpdateInfo` interface.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct RcloneUpdateMetadata {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub current_version_clean: String,
    pub latest_version_clean: String,
    pub channel: String,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
    pub release_url: Option<String>,
    pub ready_to_restart: bool,
}

/// Holds the rclone update staged for activation at the next engine restart.
#[derive(Default)]
pub struct RcloneUpdaterState {
    pub pending_update: Mutex<Option<RcloneUpdateMetadata>>,
}
