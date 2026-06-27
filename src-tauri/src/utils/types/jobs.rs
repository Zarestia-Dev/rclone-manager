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
                | JobType::ArchiveCreate
                | JobType::ArchiveExtract
                | JobType::ArchiveList
        )
    }

    #[must_use]
    pub fn is_tray_relevant(&self) -> bool {
        matches!(
            self,
            JobType::Sync
                | JobType::Copy
                | JobType::Move
                | JobType::Bisync
                | JobType::Check
                | JobType::Mount
                | JobType::CryptCheck
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveState {
    pub status: String,
    pub percentage: u8,
    pub is_preparing: bool,
    pub bytes: i64,
    pub size: i64,
    pub speed: f64,
    pub speed_class: String,
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
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_job_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_state: Option<ResolveState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
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
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,
    /// Whether this job was started with the `--dry-run` flag (no actual changes).
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_job_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_transfers: Option<Vec<CompletedTransfer>>,
}

impl JobInfo {
    #[must_use]
    pub fn is_meta(&self) -> bool {
        self.job_type.is_meta()
    }

    pub fn recompute_completed_transfers(&mut self) {
        self.completed_transfers = compute_completed_transfers(
            self.jobid,
            &self.job_type,
            &self.group,
            &self.source,
            &self.destination,
            self.end_time,
            &self.stats,
        );
    }
}

pub fn compute_completed_transfers(
    jobid: u64,
    job_type: &JobType,
    group: &str,
    source: &[String],
    destination: &str,
    end_time: Option<DateTime<Utc>>,
    stats: &Option<Value>,
) -> Option<Vec<CompletedTransfer>> {
    let stats = stats.as_ref()?;

    if *job_type == JobType::Check || *job_type == JobType::CryptCheck {
        let check_output = stats.get("checkOutput")?;
        let results_array =
            if let Some(arr) = check_output.get("results").and_then(|v| v.as_array()) {
                arr.clone()
            } else if check_output.is_array() {
                check_output.as_array()?.clone()
            } else {
                vec![check_output.clone()]
            };

        let completed_at = end_time.unwrap_or_else(Utc::now);
        let src_fs = source.first().cloned().unwrap_or_default();
        let dst_fs = destination.to_string();

        let status_map = vec![
            ("missingOnDst", "missing_dst", "Missing on Destination"),
            ("missingOnSrc", "missing_src", "Missing on Source remote"),
            (
                "differ",
                "partial",
                "File contents differ (Mismatched hash/size)",
            ),
        ];

        let mut items = Vec::new();
        for check_results in results_array {
            for (key, status, error_msg) in &status_map {
                if let Some(arr) = check_results.get(*key).and_then(|v| v.as_array()) {
                    for val in arr {
                        if let Some(name) = val.as_str() {
                            items.push(CompletedTransfer {
                                name: name.to_string(),
                                size: 0,
                                bytes: 0,
                                checked: false,
                                error: error_msg.to_string(),
                                jobid,
                                started_at: None,
                                completed_at: Some(completed_at),
                                src_fs: Some(src_fs.clone()),
                                dst_fs: Some(dst_fs.clone()),
                                group: Some(group.to_string()),
                                status: status.to_string(),
                                resolve_job_id: None,
                                resolve_state: None,
                            });
                        }
                    }
                }
            }
        }
        Some(items)
    } else {
        let completed_array = stats.get("completed")?.as_array()?;
        let mut items = Vec::new();
        for val in completed_array {
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let size = val.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let bytes = val.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
            let checked = val
                .get("checked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let started_at = val
                .get("started_at")
                .or_else(|| val.get("startedAt"))
                .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok());

            let completed_at = val
                .get("completed_at")
                .or_else(|| val.get("completedAt"))
                .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok());

            let src_fs = val
                .get("srcFs")
                .or_else(|| val.get("src_fs"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let dst_fs = val
                .get("dstFs")
                .or_else(|| val.get("dst_fs"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let group_val = val
                .get("group")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let mut status = "completed".to_string();
            if !error.is_empty() {
                status = "failed".to_string();
            } else if checked {
                status = "checked".to_string();
            } else if bytes > 0 && bytes < size {
                status = "partial".to_string();
            }

            items.push(CompletedTransfer {
                name,
                size,
                bytes,
                checked,
                error,
                jobid,
                started_at,
                completed_at,
                src_fs,
                dst_fs,
                group: group_val,
                status,
                resolve_job_id: None,
                resolve_state: None,
            });
        }

        items.sort_by(|a, b| {
            let time_a = a.completed_at.map(|t| t.timestamp_millis()).unwrap_or(0);
            let time_b = b.completed_at.map(|t| t.timestamp_millis()).unwrap_or(0);
            time_b.cmp(&time_a)
        });

        Some(items)
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
