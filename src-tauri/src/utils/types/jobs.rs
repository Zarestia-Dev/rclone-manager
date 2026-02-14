use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

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
    #[serde(rename = "delete_file")]
    DeleteFile,
    Purge,
    Rmdirs,
    #[serde(rename = "copy_file")]
    CopyFile,
    #[serde(rename = "move_file")]
    MoveFile,
    #[serde(rename = "copy_dir")]
    CopyDir,
    #[serde(rename = "move_dir")]
    MoveDir,
    Unknown(String),
}

impl fmt::Display for JobType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
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
                | JobType::DeleteFile
                | JobType::Purge
                | JobType::Rmdirs
                | JobType::CopyFile
                | JobType::MoveFile
                | JobType::CopyDir
                | JobType::MoveDir
        )
    }

    pub fn can_track(&self) -> bool {
        !matches!(self, JobType::Mount | JobType::Serve)
    }

    pub fn as_str(&self) -> &str {
        match self {
            JobType::Sync => "sync",
            JobType::Copy => "copy",
            JobType::Move => "move",
            JobType::Bisync => "bisync",
            JobType::Mount => "mount",
            JobType::Serve => "serve",
            JobType::List => "list",
            JobType::Stat => "stat",
            JobType::Info => "info",
            JobType::About => "about",
            JobType::Size => "size",
            JobType::Hash => "hash",
            JobType::CopyUrl => "copy_url",
            JobType::Mkdir => "mkdir",
            JobType::Cleanup => "cleanup",
            JobType::DeleteFile => "delete_file",
            JobType::Purge => "purge",
            JobType::Rmdirs => "rmdirs",
            JobType::CopyFile => "copy_file",
            JobType::MoveFile => "move_file",
            JobType::CopyDir => "copy_dir",
            JobType::MoveDir => "move_dir",
            JobType::Unknown(s) => s,
        }
    }
}

impl From<String> for JobType {
    fn from(s: String) -> Self {
        match s.as_str() {
            "sync" => JobType::Sync,
            "copy" => JobType::Copy,
            "move" => JobType::Move,
            "bisync" => JobType::Bisync,
            "mount" => JobType::Mount,
            "serve" => JobType::Serve,
            "list" => JobType::List,
            "stat" => JobType::Stat,
            "info" => JobType::Info,
            "about" => JobType::About,
            "size" => JobType::Size,
            "hash" => JobType::Hash,
            "copy_url" => JobType::CopyUrl,
            "mkdir" => JobType::Mkdir,
            "cleanup" => JobType::Cleanup,
            "delete_file" => JobType::DeleteFile,
            "purge" => JobType::Purge,
            "rmdirs" => JobType::Rmdirs,
            "copy_file" => JobType::CopyFile,
            "move_file" => JobType::MoveFile,
            "copy_dir" => JobType::CopyDir,
            "move_dir" => JobType::MoveDir,
            _ => JobType::Unknown(s),
        }
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
    pub status: JobStatus, // "running", "completed", "failed", "stopped"
    pub stats: Option<Value>,
    pub group: String, // Add this field to track the job group
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>, // Rclone async execute ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The backend instance this job belongs to (e.g., "Local", "NAS")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_name: Option<String>,
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

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<HashMap<u64, JobInfo>>,
}

#[derive(serde::Deserialize)]
pub struct JobResponse {
    pub jobid: u64,
    #[serde(alias = "executeId")]
    pub execute_id: Option<String>,
}
