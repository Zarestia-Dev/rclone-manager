use crate::utils::types::origin::Origin;
use crate::utils::types::starter::Starter;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;

// Core Manager Types

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    Sync,
    Copy,
    Move,
    Bisync,
    Check,
    Mount,
    List,
    Stat,
    Info,
    About,
    Size,
    Hash,
    CopyUrl,
    Mkdir,
    Cleanup,
    Delete,
    Rename,
    Rmdirs,
    Index,
    Upload,
    ArchiveCreate,
    ArchiveExtract,
    ArchiveList,
    CryptCheck,
    Unknown(String),
}

impl fmt::Display for JobType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JobType::Unknown(s) => f.write_str(s),
            _ => f.write_str(
                serde_json::to_value(self)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .as_deref()
                    .unwrap_or_default(),
            ),
        }
    }
}

impl JobType {
    /// Whether a change of this job can alter the tray: the jobs that profiles start.
    #[must_use]
    pub fn is_tray_relevant(&self) -> bool {
        crate::utils::types::remotes::OperationType::ALL
            .iter()
            .any(|op| op.as_job_type().as_ref() == Some(self))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl JobStatus {
    #[must_use]
    pub fn is_finished(&self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Stopped
        )
    }

    #[must_use]
    pub fn is_running(&self) -> bool {
        matches!(self, JobStatus::Running)
    }
}

/// Stable wire values shared with the activity panel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Completed,
    Checked,
    Failed,
    Partial,
    MissingDst,
    MissingSrc,
}

/// Rclone may add activities; keep unknown values intact for older clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RcloneActivity {
    Transferring,
    Checking,
    Deleting,
    Moving,
    Renaming,
    Hashing,
    Listing,
    Importing,
    Merging,
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveState {
    pub status: JobStatus,
    pub percentage: u8,
    pub is_preparing: bool,
    pub bytes: i64,
    pub size: i64,
    pub speed: f64,
    pub eta: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTransfer {
    pub name: String,
    pub size: i64,
    pub bytes: i64,
    pub checked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub what: Option<RcloneActivity>,
    pub error: String,
    pub jobid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src_fs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dst_fs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub status: TransferStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_job_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_state: Option<ResolveState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
    /// Orders telemetry and snapshot updates within this execution.
    #[serde(default)]
    pub stats_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    pub job_type: JobType,
    pub remote_name: String,
    pub source: Vec<String>,
    pub destination: String,
    pub start_time: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<DateTime<Utc>>,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stats: Option<Value>,
    pub group: String,
    /// What started this job; none for ad hoc work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starter: Option<Starter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,
    /// Whether this job was started with the `--dry-run` flag (no actual changes).
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_job_id: Option<u64>,
    /// The file reports rclone returned for a sync, copy or move, exactly as it returned them.
    /// They can be large, so they never travel with the job; `get_job_report` fetches them.
    #[serde(skip)]
    pub report: Option<Arc<Value>>,
    /// How many files each report in `report` lists, so a view knows what it can ask for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_counts: Option<BTreeMap<String, usize>>,
}

// State Management

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<HashMap<u64, JobInfo>>,
    pub(crate) uploads: parking_lot::Mutex<HashMap<u64, UploadCancellation>>,
    /// Woken whenever a job changes, so that waiting for a job to finish need not poll.
    pub(crate) changed: tokio::sync::Notify,
}

#[derive(Debug, Clone)]
pub(crate) struct UploadCancellation {
    pub token: tokio_util::sync::CancellationToken,
    pub result: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
}

#[cfg(test)]
impl JobInfo {
    /// A running job for tests: set what a test cares about, take the rest from here
    /// (`JobInfo { jobid: 2, ..JobInfo::for_test() }`), so a new field is added once.
    pub(crate) fn for_test() -> Self {
        Self {
            stats_revision: 0,
            jobid: 1,
            execute_id: None,
            job_type: JobType::Sync,
            remote_name: "drive:".into(),
            source: Vec::new(),
            destination: String::new(),
            start_time: Utc::now(),
            end_time: None,
            status: JobStatus::Running,
            error: None,
            stats: None,
            group: "g".into(),
            starter: None,
            origin: None,
            backend_name: crate::rclone::backend::types::default_backend_name(),
            dry_run: false,
            parent_job_id: None,
            report: None,
            report_counts: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JobType;

    #[test]
    fn only_the_jobs_a_profile_starts_refresh_the_tray() {
        for job in [
            JobType::Sync,
            JobType::Mount,
            JobType::Delete,
            JobType::CryptCheck,
            JobType::CopyUrl,
            JobType::ArchiveCreate,
            JobType::Index,
        ] {
            assert!(job.is_tray_relevant(), "{job:?}");
        }
        for job in [
            JobType::List,
            JobType::Upload,
            JobType::Rename,
            JobType::Rmdirs,
            JobType::ArchiveExtract,
        ] {
            assert!(!job.is_tray_relevant(), "{job:?}");
        }
    }
}
