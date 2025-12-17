use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_shell::process::CommandChild;
use tokio::sync::RwLock;

pub struct RcloneState {
    pub client: reqwest::Client,
    pub rclone_config_file: Arc<std::sync::RwLock<String>>,
    pub tray_enabled: Arc<std::sync::RwLock<bool>>,
    pub is_shutting_down: AtomicBool,
    pub notifications_enabled: Arc<std::sync::RwLock<bool>>,
    pub rclone_path: Arc<std::sync::RwLock<PathBuf>>,
    pub restrict_mode: Arc<std::sync::RwLock<bool>>,
    pub terminal_apps: Arc<std::sync::RwLock<Vec<String>>>,
    // New flag for memory optimization
    pub destroy_window_on_close: Arc<std::sync::RwLock<bool>>,
    pub is_restart_required: AtomicBool,
    pub is_update_in_progress: AtomicBool,
    // OAuth process state
    pub oauth_process: tokio::sync::Mutex<Option<CommandChild>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MountedRemote {
    pub fs: String,
    pub mount_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServeInstance {
    pub id: String,
    pub addr: String,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiskUsage {
    pub free: i64,
    pub used: i64,
    pub total: i64,
}

#[derive(Debug, Deserialize)]
pub struct ListOptions {
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthLimitResponse {
    pub bytes_per_second: i64,
    pub bytes_per_second_rx: i64,
    pub bytes_per_second_tx: i64,
    pub rate: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcloneCoreVersion {
    pub version: String,
    pub decomposed: Vec<u32>,
    pub go_version: String,
    pub os: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_kernel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_arch: Option<String>,
    pub is_beta: bool,
    pub is_git: bool,
    pub linking: String,
    pub go_tags: String,
}
pub struct RcApiEngine {
    pub process: Option<tauri_plugin_shell::process::CommandChild>,
    pub should_exit: bool,
    pub running: bool,
    pub updating: bool,
    pub path_error: bool,
    pub password_error: bool,
    // pub rclone_path: std::path::PathBuf,
    pub current_api_port: u16,
    pub config_encrypted: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckResult {
    pub successful: Vec<String>,
    pub failed: HashMap<String, String>,
    pub retries_used: HashMap<String, usize>,
}

/// State Structs (state.rs)
#[derive(Debug)]
pub struct EngineState {
    pub api_url: std::sync::Mutex<String>,
    pub api_port: std::sync::Mutex<u16>,
    pub oauth_url: std::sync::Mutex<String>,
    pub oauth_port: std::sync::Mutex<u16>,
}

pub struct RemoteCache {
    pub remotes: RwLock<Vec<String>>,
    pub configs: RwLock<serde_json::Value>,
    pub settings: RwLock<serde_json::Value>,
    pub mounted: RwLock<Vec<MountedRemote>>,
    pub serves: RwLock<Vec<ServeInstance>>,
    /// Tracks mount_point → profile mapping (since rclone API doesn't return profile)
    pub mount_profiles: RwLock<HashMap<String, String>>,
    /// Tracks serve_id → profile mapping (since rclone API doesn't return profile)
    pub serve_profiles: RwLock<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub remote_name: Option<String>,
    pub level: LogLevel,
    pub message: String,
    pub context: Option<serde_json::Value>,
    pub operation: Option<String>, // e.g., "mount", "sync", "copy"
}

pub struct LogCache {
    pub entries: RwLock<Vec<LogEntry>>,
    pub max_entries: usize,
}

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
    /// Source UI that started this job (e.g., "nautilus", "dashboard", "scheduled")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ui: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

pub struct JobCache {
    pub jobs: RwLock<Vec<JobInfo>>,
}

pub const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "secret",
    "endpoint",
    "token",
    "key",
    "credentials",
    "auth",
    "client_secret",
    "client_id",
    "api_key",
    "drive_id",
];

pub struct LinkChecker {
    pub client: reqwest::Client,
    pub max_retries: usize,
    pub retry_delay: std::time::Duration,
}

pub struct DynamicLogger;

#[derive(serde::Deserialize)]
pub struct JobResponse {
    pub jobid: u64,
    // #[serde(rename = "executeId")]
    // pub execute_id: String,
}

#[derive(Clone, Serialize)]
pub struct NetworkStatusPayload {
    #[serde(rename = "isMetered")]
    pub is_metered: bool,
}

pub const SERVICE_NAME: &str = env!("CARGO_PKG_NAME");
pub const CONFIG_PASSWORD_KEY: &str = "rclone_config_password";

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct ProfileParams {
    pub remote_name: String,
    pub profile_name: String,
}
