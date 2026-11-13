use crate::utils::github_client;
use parking_lot::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum UpdaterError {
    #[error("GitHub API error: {0}")]
    GitHub(#[from] github_client::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
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
    #[error("backend error: {0}")]
    Backend(String),
    #[error("failed to backup current rclone binary: {0}")]
    BackupFailed(std::io::Error),
}

impl UpdaterError {
    /// The localized message the frontend translates.
    pub fn localized(&self) -> String {
        match self {
            Self::NoPendingUpdate => {
                crate::localized_error!("backendErrors.updater.noPending")
            }
            Self::GitHub(github_client::Error::RateLimitExceeded) => {
                crate::localized_error!("backendErrors.updater.githubRateLimit")
            }
            Self::GitHub(e) => {
                crate::localized_error!("backendErrors.updater.github", "error" => e)
            }
            Self::UpdateUnavailable(e) => {
                crate::localized_error!("backendErrors.updater.updateUnavailable", "error" => e)
            }
            Self::RcloneVersionCheck(e) => {
                crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => e)
            }
            Self::RcloneSelfUpdate(e) => {
                crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e)
            }
            Self::BinaryNotFound => crate::localized_error!("backendErrors.rclone.binaryNotFound"),
            Self::Io(e) => {
                crate::localized_error!("backendErrors.updater.ioError", "error" => e)
            }
            Self::BackupFailed(e) => {
                crate::localized_error!("backendErrors.rclone.backupFailed", "error" => e)
            }
            Self::Backend(e) => e.clone(),
        }
    }
}

impl serde::Serialize for UpdaterError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.localized())
    }
}

/// An update the supervisor rolled back, shown until the application exits.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RolledBackUpdate {
    pub version: String,
    pub reason: String,
}

/// Everything a viewer needs to rebuild the updater view, also after a reload.
#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub update: Option<UpdateInfo>,
    pub checking: bool,
    /// When the last check finished (RFC 3339), whether started by a user or on schedule.
    pub last_checked_at: Option<String>,
    /// The localized failure of the last check (or, for rclone, the last update).
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rolled_back: Vec<RolledBackUpdate>,
    /// A localized note that outlives the action that produced it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// The time a check finished, as the snapshot reports it.
pub fn check_finished_at() -> String {
    chrono::Utc::now().to_rfc3339()
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
    Installing,
}

/// Progress callback supplied by the shared updater state machine.
#[cfg(feature = "updater")]
pub type DownloadProgress = Box<dyn FnMut(usize, Option<u64>) + Send>;

/// Installation capability supplied by a runtime host, independent of its plugin types.
#[cfg(feature = "updater")]
#[async_trait::async_trait]
pub trait AppUpdate: Send + Sync {
    fn version(&self) -> &str;
    async fn download(&self, on_progress: DownloadProgress)
    -> std::result::Result<Vec<u8>, String>;
    fn install(&self, payload: &[u8]) -> std::result::Result<InstallOutcome, String>;
}

#[cfg(feature = "updater")]
pub enum InstallOutcome {
    Restart,
    #[cfg(unix)]
    RestartBinary {
        executable: std::path::PathBuf,
        previous: std::path::PathBuf,
        arguments: Vec<std::ffi::OsString>,
        working_directory: std::path::PathBuf,
    },
    Exit,
    AwaitingUser,
}

#[cfg(feature = "updater")]
pub type PendingAppUpdate = std::sync::Arc<dyn AppUpdate>;

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
    pub policy: Option<crate::services::updates::policy::UpdatePolicy>,
    #[cfg(feature = "updater")]
    pub pending_action: Option<PendingAppUpdate>,
    pub downloaded_payload: Option<Vec<u8>>,
    pub last_metadata: Option<UpdateMetadata>,
    pub download_handle: Option<tokio::task::JoinHandle<()>>,
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub rolled_back: Vec<RolledBackUpdate>,
}

/// Static update metadata — used for both App and Rclone updates.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub update_available: bool,
    /// The release is a pre-release (beta channel only).
    #[serde(default)]
    pub prerelease: bool,

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<crate::services::updates::policy::UpdatePolicy>,
}

impl UpdateInfo {
    /// An update without download progress or installation policy (rclone).
    pub fn new(metadata: UpdateMetadata, status: UpdateState) -> Self {
        Self {
            metadata,
            status,
            download: None,
            installation: None,
        }
    }
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
    /// A remote backend replaced its own binary and must be restarted by its owner.
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
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
}

#[cfg(feature = "updater")]
impl AppUpdaterState {
    pub async fn cancel_update(&self) {
        let _operation = self.operation.lock().await;
        let handle = {
            let mut data = self.data.lock();
            if data.state == UpdateState::ReadyToRestart {
                data.discard_download();
                return;
            }
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
                data.discard_download();
            }
        }
    }
}

impl AppUpdaterData {
    /// Return to the state implied by the last discovered update.
    pub fn settle(&mut self) {
        self.state = if self.last_metadata.is_some() {
            UpdateState::Available
        } else {
            UpdateState::Idle
        };
    }

    /// Drop a staged or interrupted download; the discovered release stays offered.
    #[cfg(feature = "updater")]
    fn discard_download(&mut self) {
        self.settle();
        self.downloaded_payload = None;
        self.download_handle = None;
        self.downloaded_bytes = 0;
        self.total_bytes = 0;
        self.failure_message = None;
    }

    #[cfg(feature = "updater")]
    pub fn take_staged_update(&mut self) -> Option<(PendingAppUpdate, Vec<u8>)> {
        if self.state != UpdateState::ReadyToRestart || self.pending_action.is_none() {
            return None;
        }
        let payload = self.downloaded_payload.take()?;
        self.pending_action.take().map(|update| (update, payload))
    }

    pub fn snapshot(&self) -> UpdaterSnapshot {
        UpdaterSnapshot {
            update: self.info(),
            checking: self.state == UpdateState::Checking,
            last_checked_at: self.last_checked_at.clone(),
            error: self.last_error.clone(),
            rolled_back: self.rolled_back.clone(),
            notice: None,
        }
    }

    pub fn info(&self) -> Option<UpdateInfo> {
        let metadata = self.last_metadata.clone()?;
        Some(UpdateInfo {
            metadata,
            status: self.state,
            download: self.download_status(),
            installation: self.policy.clone(),
        })
    }

    pub fn download_status(&self) -> Option<DownloadStatus> {
        if let Some(error) = &self.failure_message {
            return Some(DownloadStatus {
                downloaded_bytes: self.downloaded_bytes,
                total_bytes: self.total_bytes,
                percentage: 0.0,
                state: DownloadState::Failed(error.clone()),
            });
        }
        match self.state {
            UpdateState::Downloading => Some(DownloadState::InProgress),
            UpdateState::ReadyToRestart | UpdateState::Installing => Some(DownloadState::Complete),
            _ => None,
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
    /// Return to the state implied by the known update.
    pub fn settle(&mut self) {
        self.state = if self.pending_update.is_some() {
            UpdateState::Available
        } else {
            UpdateState::Idle
        };
    }

    /// A local download stages a binary for the next engine restart. A remote
    /// backend replaces its own binary, so nothing is left to apply here; the
    /// remote still runs the old version until it restarts.
    pub fn finish_update(&mut self, result: &Result<UpdateResult>) {
        match result {
            Ok(result) if result.success && !result.manual => {
                self.state = UpdateState::ReadyToRestart;
                self.last_error = None;
            }
            Ok(result) if result.success => {
                self.pending_update = None;
                self.settle();
                self.last_error = None;
                self.notice = Some(crate::localized_success!(
                    "backendSuccess.rclone.remoteRestartRequired"
                ));
            }
            // Cancelled, or nothing to install.
            Ok(_) => self.settle(),
            Err(error) => {
                self.settle();
                self.last_error = Some(error.localized());
            }
        }
        self.cancel_token = None;
    }

    pub fn snapshot(&self) -> UpdaterSnapshot {
        UpdaterSnapshot {
            update: self.info(),
            checking: self.state == UpdateState::Checking,
            last_checked_at: self.last_checked_at.clone(),
            error: self.last_error.clone(),
            rolled_back: Vec::new(),
            notice: self.notice.clone(),
        }
    }

    pub fn info(&self) -> Option<UpdateInfo> {
        self.pending_update
            .clone()
            .map(|metadata| UpdateInfo::new(metadata, self.state))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "updater")]
    struct StubUpdate;

    #[cfg(feature = "updater")]
    #[async_trait::async_trait]
    impl AppUpdate for StubUpdate {
        fn version(&self) -> &str {
            "1.2.0"
        }

        async fn download(
            &self,
            mut on_progress: DownloadProgress,
        ) -> std::result::Result<Vec<u8>, String> {
            on_progress(3, Some(3));
            Ok(vec![1, 2, 3])
        }

        fn install(&self, payload: &[u8]) -> std::result::Result<InstallOutcome, String> {
            if payload.is_empty() {
                Err("empty payload".into())
            } else {
                Ok(InstallOutcome::Restart)
            }
        }
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn staged_update_uses_a_host_capability_without_native_plugin_state() {
        let update: PendingAppUpdate = std::sync::Arc::new(StubUpdate);
        let payload = update
            .download(Box::new(|bytes, total| {
                assert_eq!(bytes, 3);
                assert_eq!(total, Some(3));
            }))
            .await
            .unwrap();
        let mut data = AppUpdaterData {
            state: UpdateState::ReadyToRestart,
            pending_action: Some(update),
            downloaded_payload: Some(payload),
            ..Default::default()
        };
        let (update, payload) = data.take_staged_update().unwrap();
        assert_eq!(update.version(), "1.2.0");
        assert!(update.install(&[]).is_err());
        assert!(update.install(&payload).is_ok());
        assert!(data.take_staged_update().is_none());
        assert!(data.pending_action.is_none());
        assert!(data.downloaded_payload.is_none());
    }

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
        state.cancel_update().await;
        assert!(dropped_rx.await.is_err());
        let data = state.data.lock();
        assert_eq!(data.state, UpdateState::Available);
        assert_eq!(data.downloaded_bytes, 0);
        assert!(data.download_handle.is_none());
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn cancelling_discards_a_staged_payload_but_preserves_the_release_for_retry() {
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.downloaded_payload = Some(vec![1, 2, 3]);
            data.last_metadata = Some(metadata());
            data.pending_action = Some(std::sync::Arc::new(StubUpdate));
            data.failure_message = Some("Permission denied".into());
            data.downloaded_bytes = 3;
            data.total_bytes = 3;
        }
        state.cancel_update().await;
        let data = state.data.lock();
        assert_eq!(data.state, UpdateState::Available);
        assert!(data.downloaded_payload.is_none());
        assert!(data.pending_action.is_some());
        assert_eq!(data.info().unwrap().metadata.version, "1.2.0");
        assert!(data.download_status().is_none());
        assert_eq!(data.downloaded_bytes, 0);
        assert_eq!(data.total_bytes, 0);
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn cancellation_cannot_discard_an_installation_in_progress() {
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::Installing;
            data.last_metadata = Some(metadata());
        }
        state.cancel_update().await;
        assert_eq!(state.data.lock().state, UpdateState::Installing);
    }

    #[cfg(feature = "updater")]
    #[tokio::test]
    async fn discarding_an_orphaned_payload_returns_to_idle() {
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.downloaded_payload = Some(vec![1, 2, 3]);
        }
        state.cancel_update().await;
        assert_eq!(state.data.lock().state, UpdateState::Idle);
        assert!(state.data.lock().downloaded_payload.is_none());
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
    fn only_local_rclone_downloads_wait_for_an_engine_restart() {
        let done = |manual| -> Result<UpdateResult> {
            Ok(UpdateResult {
                success: true,
                manual,
                ..Default::default()
            })
        };
        let mut data = RcloneUpdaterData {
            state: UpdateState::Downloading,
            pending_update: Some(metadata()),
            cancel_token: Some(Default::default()),
            last_error: Some("old failure".into()),
            ..Default::default()
        };
        data.finish_update(&done(false));
        assert_eq!(data.state, UpdateState::ReadyToRestart);
        assert!(data.pending_update.is_some());
        assert!(data.cancel_token.is_none());
        assert!(data.last_error.is_none());

        // The remote backend already replaced itself: nothing is left to apply,
        // but it keeps running the old version until it restarts.
        data.state = UpdateState::Downloading;
        data.finish_update(&done(true));
        assert_eq!(data.state, UpdateState::Idle);
        assert!(data.info().is_none());
        assert_eq!(
            data.snapshot().notice.as_deref(),
            Some("backendSuccess.rclone.remoteRestartRequired")
        );

        // Failures and cancellations keep offering the known update; only
        // failures are remembered for later viewers.
        data.pending_update = Some(metadata());
        data.state = UpdateState::Downloading;
        data.finish_update(&Ok(UpdateResult::default()));
        assert_eq!(data.state, UpdateState::Available);
        assert!(data.last_error.is_none());
        data.state = UpdateState::Downloading;
        data.finish_update(&Err(UpdaterError::BinaryNotFound));
        assert_eq!(data.state, UpdateState::Available);
        assert_eq!(
            data.snapshot().error.as_deref(),
            Some("backendErrors.rclone.binaryNotFound")
        );
        data.pending_update = None;
        data.finish_update(&Err(UpdaterError::NoPendingUpdate));
        assert_eq!(data.state, UpdateState::Idle);
    }

    #[test]
    fn snapshots_report_checking_and_outlive_a_missing_update() {
        let mut data = AppUpdaterData {
            state: UpdateState::Checking,
            ..Default::default()
        };
        // A first check has no metadata yet, but viewers still see it running.
        let snapshot = data.snapshot();
        assert!(snapshot.update.is_none() && snapshot.checking);
        data.state = UpdateState::Idle;
        data.last_checked_at = Some(check_finished_at());
        data.last_error = Some("backendErrors.updater.githubRateLimit".into());
        data.rolled_back.push(RolledBackUpdate {
            version: "1.2.0".into(),
            reason: "did not start".into(),
        });
        let json = serde_json::to_value(data.snapshot()).unwrap();
        assert_eq!(json["checking"], false);
        assert!(json["update"].is_null());
        assert!(
            chrono::DateTime::parse_from_rfc3339(json["lastCheckedAt"].as_str().unwrap()).is_ok()
        );
        assert_eq!(json["error"], "backendErrors.updater.githubRateLimit");
        assert_eq!(json["rolledBack"][0]["version"], "1.2.0");
        assert!(json.get("notice").is_none());
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
