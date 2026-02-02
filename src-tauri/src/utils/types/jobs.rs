use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
    pub job_type: String, // "sync" or "copy"
    pub remote_name: String,
    pub source: String,
    pub destination: String,
    pub start_time: DateTime<Utc>,
    pub status: JobStatus, // "running", "completed", "failed", "stopped"
    pub stats: Option<Value>,
    pub group: String, // Add this field to track the job group
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>, // Rclone async execute ID
    /// Source UI that started this job (e.g., "nautilus", "dashboard", "scheduled")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ui: Option<String>,
    /// The backend instance this job belongs to (e.g., "Local", "NAS")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<Vec<JobInfo>>,
}

#[derive(serde::Deserialize)]
pub struct JobResponse {
    pub jobid: u64,
    #[serde(alias = "executeId")]
    pub execute_id: Option<String>,
}
