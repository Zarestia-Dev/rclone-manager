use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

use crate::utils::types::origin::Origin;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    Sync,
    Copy,
    Move,
    Bisync,
    Mount,
    Serve,
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
    Batch,
    Unknown(String),
}

impl fmt::Display for JobType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Unknown carries an arbitrary string not known to serde.
            JobType::Unknown(s) => f.write_str(s),
            // For all known variants the serde representation is canonical.
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uploaded_files: Vec<String>,
    pub group: String,
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_batch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,
}

impl JobInfo {
    pub fn is_meta(&self) -> bool {
        self.job_type.is_meta()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchMasterJob {
    pub batch_id: String,
    pub job_type: JobType,
    pub total_jobs: usize,
    pub completed_jobs: usize,
    pub failed_jobs: usize,
    pub start_time: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<DateTime<Utc>>,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    pub group: Option<String>,
}

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<HashMap<u64, JobInfo>>,
    pub batch_jobs: tokio::sync::RwLock<HashMap<String, BatchMasterJob>>,
}

#[derive(serde::Deserialize)]
pub struct JobResponse {
    pub jobid: u64,
    #[serde(alias = "executeId")]
    pub execute_id: Option<String>,
}
