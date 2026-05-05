use crate::utils::github_client;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64};
use tauri_plugin_updater::Update;

#[derive(Debug, thiserror::Error)]
pub enum UpdaterError {
    #[error(transparent)]
    Tauri(#[from] tauri_plugin_updater::Error),
    #[error("GitHub API error: {0}")]
    GitHub(#[from] github_client::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("mutex error: {0}")]
    Mutex(String),
    #[error("no pending update")]
    NoPendingUpdate,
    #[error("update artifact is no longer available: {0}")]
    UpdateUnavailable(String),
    #[error("binary not found")]
    BinaryNotFound,
    #[error("rclone version check failed: {0}")]
    RcloneVersionCheck(String),
    #[error("rclone selfupdate failed: {0}")]
    RcloneSelfUpdate(String),
    #[error("relaunch error: {0}")]
    Relaunch(String),
    #[error("restart error: {0}")]
    Restart(String),
    #[error("backend error: {0}")]
    Backend(String),
    #[error("update path not writable")]
    NotWritable,
}

impl serde::Serialize for UpdaterError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let msg = match self {
            Self::NoPendingUpdate => {
                crate::localized_error!("backendErrors.updater.noPending")
            }
            Self::InvalidUrl(e) => {
                crate::localized_error!("backendErrors.updater.invalidUrl", "error" => e)
            }
            Self::GitHub(e) => {
                crate::localized_error!("backendErrors.updater.github", "error" => e)
            }
            Self::Tauri(e) => {
                crate::localized_error!("backendErrors.updater.updateFailed", "error" => e)
            }
            Self::UpdateUnavailable(e) => {
                crate::localized_error!("backendErrors.updater.updateUnavailable", "error" => e)
            }
            Self::Relaunch(e) => {
                crate::localized_error!("backendErrors.updater.relaunchFailed", "error" => e)
            }
            Self::Mutex(e) => {
                crate::localized_error!("backendErrors.updater.mutex", "error" => e)
            }
            Self::RcloneVersionCheck(e) => {
                crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => e)
            }
            Self::RcloneSelfUpdate(e) => {
                crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e)
            }
            Self::BinaryNotFound => crate::localized_error!("backendErrors.rclone.binaryNotFound"),
            Self::Restart(e) => {
                crate::localized_error!("backendErrors.updater.restartFailed", "error" => e)
            }
            Self::NotWritable => crate::localized_error!("backendErrors.updater.notWritable"),
            Self::Io(e) => {
                crate::localized_error!("backendErrors.updater.ioError", "error" => e)
            }
            Self::Backend(e) => e.clone(),
        };
        serializer.serialize_str(&msg)
    }
}

pub type Result<T> = std::result::Result<T, UpdaterError>;

/// Tracks the in-flight app self-update download and its staged payload.
pub struct AppUpdaterState {
    pub downloaded_bytes: AtomicU64,
    pub total_bytes: AtomicU64,
    pub is_updating: AtomicBool,
    pub is_restart_required: AtomicBool,
    data: Mutex<AppUpdaterData>,
}

#[derive(Default)]
pub struct AppUpdaterData {
    pub failure_message: Option<String>,
    pub pending_action: Option<Update>,
    pub signature: Option<Vec<u8>>,
    pub last_metadata: Option<UpdateMetadata>,
}

impl AppUpdaterState {
    pub fn with_data<R>(&self, f: impl FnOnce(&mut AppUpdaterData) -> R) -> R {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut data)
    }
}

impl Default for AppUpdaterState {
    fn default() -> Self {
        Self {
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            is_updating: AtomicBool::new(false),
            is_restart_required: AtomicBool::new(false),
            data: Mutex::new(AppUpdaterData::default()),
        }
    }
}

/// Static update metadata — used for both App and Rclone updates.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub update_available: bool,

    // Optional metadata
    pub release_tag: Option<String>,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
    pub release_url: Option<String>,
    pub channel: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    #[default]
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "readyToRestart")]
    ReadyToRestart,
    #[serde(rename = "available")]
    Available,
}

/// Unified update info — combines static metadata with live process state.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    #[serde(flatten)]
    pub metadata: UpdateMetadata,
    pub status: UpdateStatus,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub is_complete: bool,
    pub is_failed: bool,
    pub failure_message: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub success: bool,
    pub message: Option<String>,
    pub output: Option<String>,
    pub channel: Option<String>,
    pub manual: bool,
}

/// Holds the rclone update staged for activation at the next engine restart.
pub struct RcloneUpdaterState {
    pub is_updating: AtomicBool,
    pub is_restart_required: AtomicBool,
    data: Mutex<RcloneUpdaterData>,
}

#[derive(Default)]
pub struct RcloneUpdaterData {
    pub pending_update: Option<UpdateMetadata>,
}

impl RcloneUpdaterState {
    pub fn with_data<R>(&self, f: impl FnOnce(&mut RcloneUpdaterData) -> R) -> R {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut data)
    }
}

impl Default for RcloneUpdaterState {
    fn default() -> Self {
        Self {
            is_updating: AtomicBool::new(false),
            is_restart_required: AtomicBool::new(false),
            data: Mutex::new(RcloneUpdaterData::default()),
        }
    }
}
