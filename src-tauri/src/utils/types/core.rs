use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use tauri_plugin_shell::process::CommandChild;

/// Core application state for Rclone operations.
pub struct RcloneState {
    /// HTTP client for rclone API calls
    pub client: reqwest::Client,
    /// Flag indicating the app is shutting down
    pub is_shutting_down: AtomicBool,
    /// Flag indicating a restart is required (e.g., after update)
    pub is_restart_required: AtomicBool,
    /// Flag indicating an update is in progress
    pub is_update_in_progress: AtomicBool,
    /// OAuth process state for interactive remote creation
    pub oauth_process: tokio::sync::Mutex<Option<CommandChild>>,
}

impl RcloneState {
    /// Check if the application is shutting down
    pub fn is_shutting_down(&self) -> bool {
        self.is_shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Set the application shutdown flag
    pub fn set_shutting_down(&self) {
        self.is_shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

pub struct RcApiEngine {
    pub process: Option<CommandChild>,
    pub should_exit: bool,
    pub running: bool,
    pub updating: bool,
    pub path_error: bool,
    pub password_error: bool,
    pub current_api_port: u16,
}

/// Thread-safe, async-friendly managed state for the engine
pub type EngineState = tokio::sync::Mutex<RcApiEngine>;

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
    "pass",
    "session_id",
    "2fa",
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
