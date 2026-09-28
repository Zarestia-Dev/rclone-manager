use crate::utils::github_client;
use parking_lot::Mutex;
#[cfg(feature = "updater")]
use tauri_plugin_updater::Update;

#[derive(Debug, thiserror::Error)]
pub enum UpdaterError {
    #[cfg(feature = "updater")]
    #[error(transparent)]
    Tauri(#[from] tauri_plugin_updater::Error),
    #[error("GitHub API error: {0}")]
    GitHub(#[from] github_client::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),
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
    #[error("failed to backup current rclone binary: {0}")]
    BackupFailed(std::io::Error),
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
            Self::GitHub(github_client::Error::RateLimitExceeded) => {
                crate::localized_error!("backendErrors.updater.githubRateLimit")
            }
            Self::GitHub(e) => {
                crate::localized_error!("backendErrors.updater.github", "error" => e)
            }
            #[cfg(feature = "updater")]
            Self::Tauri(e) => {
                crate::localized_error!("backendErrors.updater.updateFailed", "error" => e)
            }
            Self::UpdateUnavailable(e) => {
                crate::localized_error!("backendErrors.updater.updateUnavailable", "error" => e)
            }
            Self::Relaunch(e) => {
                crate::localized_error!("backendErrors.updater.relaunchFailed", "error" => e)
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
            Self::BackupFailed(e) => {
                crate::localized_error!("backendErrors.rclone.backupFailed", "error" => e)
            }
            Self::Backend(e) => e.clone(),
        };
        serializer.serialize_str(&msg)
    }
}

pub type Result<T> = std::result::Result<T, UpdaterError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    ReadyToRestart,
}

/// Tracks the in-flight app self-update download and its staged payload.
#[derive(Default)]
pub struct AppUpdaterState {
    #[cfg(feature = "updater")]
    pub operation: tokio::sync::Mutex<()>,
    pub data: Mutex<AppUpdaterData>,
}

#[derive(Default)]
pub struct AppUpdaterData {
    pub state: UpdateState,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub failure_message: Option<String>,
    #[cfg(feature = "updater")]
    pub pending_action: Option<Update>,
    pub downloaded_payload: Option<Vec<u8>>,
    pub last_metadata: Option<UpdateMetadata>,
    pub download_handle: Option<tokio::task::JoinHandle<()>>,
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

/// Unified update info — combines static metadata with live process state.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    #[serde(flatten)]
    pub metadata: UpdateMetadata,
    pub status: UpdateState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<DownloadStatus>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "status", content = "data")]
pub enum DownloadState {
    InProgress,
    Complete,
    Failed(String),
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub state: DownloadState,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub success: bool,
    pub message: Option<String>,
    pub output: Option<String>,
    pub channel: Option<String>,
    pub manual: bool,
}

/// Holds the rclone update staged for activation at the next engine restart.
#[derive(Default)]
pub struct RcloneUpdaterState {
    /// Serialize checks and downloads without blocking status reads or cancellation.
    pub operation: tokio::sync::Mutex<()>,
    pub data: Mutex<RcloneUpdaterData>,
}

#[derive(Default)]
pub struct RcloneUpdaterData {
    pub state: UpdateState,
    pub pending_update: Option<UpdateMetadata>,
    pub cancel_token: Option<tokio_util::sync::CancellationToken>,
}

#[cfg(feature = "updater")]
impl AppUpdaterState {
    pub async fn cancel_download(&self) {
        let _operation = self.operation.lock().await;
        let handle = {
            let mut data = self.data.lock();
            if data.state != UpdateState::Downloading {
                return;
            }
            data.download_handle.take()
        };
        if let Some(handle) = handle {
            log::info!("Cancelling app update download");
            handle.abort();
            // Aborting is asynchronous; wait before resetting state or allowing a retry.
            let _ = handle.await;
        }
        {
            let mut data = self.data.lock();
            // The worker may have completed before the abort took effect.
            if data.state == UpdateState::Downloading {
                data.state = if data.last_metadata.is_some() {
                    UpdateState::Available
                } else {
                    UpdateState::Idle
                };
                data.downloaded_bytes = 0;
                data.total_bytes = 0;
                data.failure_message = None;
            }
        }
    }
}

impl AppUpdaterData {
    #[cfg(feature = "updater")]
    pub fn take_staged_update(&mut self) -> Option<(Update, Vec<u8>)> {
        if self.state != UpdateState::ReadyToRestart || self.pending_action.is_none() {
            return None;
        }
        let payload = self.downloaded_payload.take()?;
        self.pending_action.take().map(|update| (update, payload))
    }

    pub fn info(&self) -> Option<UpdateInfo> {
        let metadata = self.last_metadata.clone()?;
        Some(UpdateInfo {
            metadata,
            status: self.state,
            download: self.download_status(),
        })
    }

    pub fn download_status(&self) -> Option<DownloadStatus> {
        match self.state {
            UpdateState::Downloading => Some(DownloadState::InProgress),
            UpdateState::ReadyToRestart => Some(DownloadState::Complete),
            _ => self.failure_message.clone().map(DownloadState::Failed),
        }
        .map(|state| DownloadStatus {
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
            percentage: if state == DownloadState::Complete {
                100.0
            } else if self.total_bytes > 0 {
                (self.downloaded_bytes as f64 / self.total_bytes as f64 * 100.0).min(100.0)
            } else {
                0.0
            },
            state,
        })
    }
}

impl RcloneUpdaterData {
    pub fn info(&self) -> Option<UpdateInfo> {
        self.pending_update.clone().map(|metadata| UpdateInfo {
            metadata,
            status: self.state,
            download: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> UpdateMetadata {
        UpdateMetadata {
            version: "1.2.0".into(),
            update_available: true,
            ..Default::default()
        }
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn cancelling_waits_for_the_worker_to_drop_before_resetting_progress() {
        let state = AppUpdaterState::default();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
        let handle = crate::utils::spawn(async move {
            let _dropped_tx = dropped_tx;
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        {
            let mut data = state.data.lock();
            data.state = UpdateState::Downloading;
            data.last_metadata = Some(metadata());
            data.downloaded_bytes = 42;
            data.download_handle = Some(handle);
        }
        started_rx.await.unwrap();
        state.cancel_download().await;
        assert!(dropped_rx.await.is_err());
        let data = state.data.lock();
        assert_eq!(data.state, UpdateState::Available);
        assert_eq!(data.downloaded_bytes, 0);
        assert!(data.download_handle.is_none());
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn cancelling_preserves_an_already_staged_payload() {
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.downloaded_payload = Some(vec![1, 2, 3]);
        }
        state.cancel_download().await;
        let data = state.data.lock();
        assert_eq!(data.state, UpdateState::ReadyToRestart);
        assert_eq!(
            data.downloaded_payload.as_deref(),
            Some([1, 2, 3].as_slice())
        );
    }

    #[cfg(feature = "updater")]
    #[test]
    fn incomplete_staged_updates_do_not_consume_the_payload() {
        let mut data = AppUpdaterData {
            state: UpdateState::ReadyToRestart,
            downloaded_payload: Some(vec![1, 2, 3]),
            ..Default::default()
        };
        assert!(data.take_staged_update().is_none());
        assert_eq!(
            data.downloaded_payload.as_deref(),
            Some([1, 2, 3].as_slice())
        );
    }

    #[test]
    fn progress_is_clamped_and_does_not_require_release_metadata() {
        let data = AppUpdaterData {
            state: UpdateState::Downloading,
            downloaded_bytes: 150,
            total_bytes: 100,
            ..Default::default()
        };
        assert!(data.info().is_none());
        assert_eq!(data.download_status().unwrap().percentage, 100.0);
        assert!(AppUpdaterData::default().download_status().is_none());
    }

    #[test]
    fn app_snapshot_restores_download_progress() {
        let data = AppUpdaterData {
            state: UpdateState::Downloading,
            last_metadata: Some(metadata()),
            downloaded_bytes: 42,
            total_bytes: 100,
            ..Default::default()
        };
        let info = data.info().unwrap();
        assert_eq!(info.status, UpdateState::Downloading);
        assert_eq!(info.metadata.version, "1.2.0");
        let progress = info.download.unwrap();
        assert_eq!(progress.downloaded_bytes, 42);
        assert_eq!(progress.percentage, 42.0);
        assert_eq!(progress.state, DownloadState::InProgress);
    }

    #[test]
    fn app_snapshot_handles_unknown_size_completion_and_failure() {
        let mut data = AppUpdaterData {
            state: UpdateState::Downloading,
            last_metadata: Some(metadata()),
            ..Default::default()
        };
        assert_eq!(data.info().unwrap().download.unwrap().percentage, 0.0);
        data.state = UpdateState::ReadyToRestart;
        let progress = data.info().unwrap().download.unwrap();
        assert_eq!(progress.percentage, 100.0);
        assert_eq!(progress.state, DownloadState::Complete);
        data.state = UpdateState::Available;
        data.failure_message = Some("failed".into());
        assert_eq!(
            data.info().unwrap().download.unwrap().state,
            DownloadState::Failed("failed".into())
        );
        data.failure_message = None;
        assert!(data.info().unwrap().download.is_none());
        data.last_metadata = None;
        assert!(data.info().is_none());
    }

    #[test]
    fn rclone_snapshot_preserves_all_worker_states() {
        let mut data = RcloneUpdaterData {
            pending_update: Some(metadata()),
            ..Default::default()
        };
        for state in [
            UpdateState::Available,
            UpdateState::Downloading,
            UpdateState::ReadyToRestart,
            UpdateState::Checking,
        ] {
            data.state = state;
            let info = data.info().unwrap();
            assert_eq!(info.status, state);
            assert_eq!(info.metadata.version, "1.2.0");
            assert!(info.download.is_none());
        }
        data.pending_update = None;
        assert!(data.info().is_none());
    }

    #[test]
    fn update_snapshot_serialization_keeps_the_existing_metadata_fields() {
        let data = AppUpdaterData {
            state: UpdateState::Downloading,
            last_metadata: Some(metadata()),
            downloaded_bytes: 1,
            total_bytes: 2,
            ..Default::default()
        };
        let json = serde_json::to_value(data.info().unwrap()).unwrap();
        assert_eq!(json["version"], "1.2.0");
        assert_eq!(json["status"], "downloading");
        assert_eq!(json["download"]["downloadedBytes"], 1);
        assert_eq!(json["download"]["state"]["status"], "inProgress");
        let old = serde_json::json!({ "version": "1.2.0", "currentVersion": "1.1.0", "updateAvailable": true, "status": "available" });
        assert!(
            serde_json::from_value::<UpdateInfo>(old)
                .unwrap()
                .download
                .is_none()
        );
    }
}
