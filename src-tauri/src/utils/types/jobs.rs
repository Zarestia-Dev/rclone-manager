use crate::utils::types::origin::Origin;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

// ─── Core Manager Types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    Sync,
    Copy,
    Move,
    Bisync,
    Mount,
    List,
    Stat,
    Info,
    About,
    Size,
    Hash,
    #[serde(rename = "copy_url")]
    CopyUrl,
    Mkdir,
    Cleanup,
    Delete,
    Rename,
    Rmdirs,
    Upload,
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
    #[must_use]
    pub fn is_meta(&self) -> bool {
        matches!(
            self,
            JobType::List
                | JobType::Stat
                | JobType::Info
                | JobType::About
                | JobType::Size
                | JobType::Hash
                | JobType::Mkdir
                | JobType::Cleanup
                | JobType::Delete
                | JobType::Rename
                | JobType::Rmdirs
                | JobType::Upload
        )
    }

    #[must_use]
    pub fn is_tray_relevant(&self) -> bool {
        matches!(
            self,
            JobType::Sync | JobType::Copy | JobType::Move | JobType::Bisync | JobType::Mount
        )
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
    pub fn is_finished(&self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Stopped
        )
    }

    pub fn is_running(&self) -> bool {
        matches!(self, JobStatus::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    pub job_type: JobType,
    pub remote_name: String,
    pub source: String,
    pub destination: String,
    pub start_time: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<DateTime<Utc>>,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stats: Option<Value>,
    pub group: String,
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,
}

impl JobInfo {
    #[must_use]
    pub fn is_meta(&self) -> bool {
        self.job_type.is_meta()
    }
}

// ─── Rclone RC Response Types ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub bytes: u64,
    pub total_bytes: u64,
    pub speed: f64,
    pub eta: Option<u64>,
    #[serde(rename = "elapsedTime")]
    pub elapsed_time: f64,
    pub errors: u64,
    #[serde(rename = "fatalError")]
    pub fatal_error: bool,
    #[serde(rename = "retryError")]
    pub retry_error: bool,
    pub checks: u64,
    #[serde(rename = "totalChecks")]
    pub total_checks: u64,
    pub transfers: u64,
    #[serde(rename = "totalTransfers")]
    pub total_transfers: u64,
    pub listed: u64,
    pub renames: u64,
    pub deletes: u64,
    #[serde(rename = "deletedDirs")]
    pub deleted_dirs: u64,
    #[serde(default)]
    pub transferring: Vec<ActiveTransfer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTransfer {
    pub name: String,
    pub size: u64,
    pub bytes: u64,
    pub percentage: u8,
    pub speed: f64,
    #[serde(rename = "speedAvg")]
    pub speed_avg: f64,
    pub eta: Option<u64>,
    pub group: String,
    #[serde(rename = "srcFs")]
    pub src_fs: Option<String>,
    #[serde(rename = "dstFs")]
    pub dst_fs: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TransferredResponse {
    pub transferred: Vec<TransferredItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TransferredItem {
    pub name: String,
    pub size: i64,
    pub bytes: i64,
    pub error: String,
    pub checked: bool,
    pub what: String,
    #[serde(rename = "started_at")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(rename = "completed_at")]
    pub completed_at: Option<DateTime<Utc>>,
    pub group: String,
    #[serde(rename = "srcFs")]
    pub src_fs: Option<String>,
    #[serde(rename = "dstFs")]
    pub dst_fs: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatusResponse {
    pub id: u64,
    #[serde(rename = "executeId")]
    pub execute_id: Option<String>,
    pub group: String,
    pub finished: bool,
    pub success: bool,
    pub error: String,
    pub duration: f64,
    #[serde(rename = "startTime")]
    pub start_time: DateTime<Utc>,
    #[serde(rename = "endTime")]
    pub end_time: DateTime<Utc>,
    pub output: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListResponse {
    pub jobids: Vec<u64>,
    #[serde(rename = "executeId")]
    pub execute_id: Option<String>,
}

// ─── State Management ──────────────────────────────────────────────────────

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<HashMap<u64, JobInfo>>,
}
