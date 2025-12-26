use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri_plugin_shell::process::CommandChild;

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

pub struct RcApiEngine {
    pub process: Option<CommandChild>,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct DiskUsage {
    pub free: i64,
    pub used: i64,
    pub total: i64,
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

#[derive(Clone, Serialize)]
pub struct NetworkStatusPayload {
    #[serde(rename = "isMetered")]
    pub is_metered: bool,
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
