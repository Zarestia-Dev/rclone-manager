use chrono::{DateTime, Utc};
use log::{debug, error};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::core::settings::settings::get_remote_settings;

use super::api_query::{get_all_remote_configs, get_mounted_remotes, get_remotes, MountedRemote};

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
];

fn redact_sensitive_values(params: &Vec<std::string::String>) -> Value {
    params
        .iter()
        .map(|k| {
            let value = if SENSITIVE_KEYS
                .iter()
                .any(|sk| k.to_lowercase().contains(sk))
            {
                json!("[RESTRICTED]")
            } else {
                json!(k)
            };
            (k.clone(), value)
        })
        .collect()
}

// Recursively redact sensitive values in a serde_json::Value
fn redact_sensitive_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let redacted_map = map
                .iter()
                .map(|(k, v)| {
                    if SENSITIVE_KEYS
                        .iter()
                        .any(|sk| k.to_lowercase().contains(sk))
                    {
                        (k.clone(), json!("[RESTRICTED]"))
                    } else {
                        (k.clone(), redact_sensitive_json(v))
                    }
                })
                .collect();
            Value::Object(redacted_map)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(redact_sensitive_json).collect()),
        _ => value.clone(),
    }
}

#[derive(Debug)]
pub struct RcloneState {
    pub api_url: Mutex<String>,
    pub api_port: Mutex<u16>,
    pub oauth_url: Mutex<String>,
    pub oauth_port: Mutex<u16>,
}

pub static RCLONE_STATE: Lazy<RcloneState> = Lazy::new(|| RcloneState {
    api_url: Mutex::new(String::new()),
    api_port: Mutex::new(5572),
    oauth_url: Mutex::new(String::new()),
    oauth_port: Mutex::new(5580),
});

impl RcloneState {
    pub fn set_api(&self, url: String, port: u16) -> Result<(), String> {
        *self.api_url.lock().map_err(|e| e.to_string())? = url;
        *self.api_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }

    pub fn get_api(&self) -> (String, u16) {
        (
            self.api_url.lock().unwrap().clone(),
            *self.api_port.lock().unwrap(),
        )
    }

    pub fn set_oauth(&self, url: String, port: u16) -> Result<(), String> {
        *self.oauth_url.lock().map_err(|e| e.to_string())? = url;
        *self.oauth_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }

    pub fn get_oauth(&self) -> (String, u16) {
        (
            self.oauth_url.lock().unwrap().clone(),
            *self.oauth_port.lock().unwrap(),
        )
    }
}

pub struct RemoteCache {
    pub remotes: RwLock<Vec<String>>,
    pub configs: RwLock<serde_json::Value>,
    pub settings: RwLock<serde_json::Value>,
    pub mounted: RwLock<Vec<MountedRemote>>,
}

pub static CACHE: Lazy<RemoteCache> = Lazy::new(|| RemoteCache {
    remotes: RwLock::new(Vec::new()),
    configs: RwLock::new(json!({})),
    settings: RwLock::new(json!({})),
    mounted: RwLock::new(Vec::new()),
});

impl RemoteCache {
    // pub fn new() -> Self {
    //     Self {
    //         remotes: RwLock::new(Vec::new()),
    //         configs: RwLock::new(json!({})),
    // let redacted_configs = redact_sensitive_json(&*configs);
    // debug!("🔄 Updated remotes configs: {:?}", redacted_configs);
    // }

    pub async fn refresh_remote_list(&self, app_handle: tauri::AppHandle) {
        let mut remotes = self.remotes.write().await;
        if let Ok(remote_list) = get_remotes(app_handle.state()).await {
            *remotes = remote_list;
            // Redact sensitive values in the remote list
            let redacted_remotes = redact_sensitive_values(&*remotes);
            debug!("🔄 Updated remotes: {:?}", redacted_remotes);
        } else {
            error!("Failed to fetch remotes");
        }
    }
    pub async fn refresh_remote_configs(&self, app_handle: tauri::AppHandle) {
        let mut configs = self.configs.write().await;
        if let Ok(remote_list) = get_all_remote_configs(app_handle.state()).await {
            *configs = remote_list;
            // Redact sensitive values in the remote configs
            let redacted_configs = redact_sensitive_json(&*configs);
            debug!("🔄 Updated remotes configs: {:?}", redacted_configs);
        } else {
            error!("Failed to fetch remotes config");
        }
    }
    pub async fn refresh_remote_settings(&self, app_handle: tauri::AppHandle) {
        let remotes = self.remotes.read().await;
        let mut settings = self.settings.write().await;

        let mut all_settings = serde_json::Map::new();

        for remote in remotes.iter() {
            if let Ok(settings) = get_remote_settings(remote.to_string(), app_handle.state()).await
            {
                all_settings.insert(remote.clone(), settings);
            } else {
                error!("❌ Failed to fetch settings for remote: {}", remote);
            }
        }

        *settings = serde_json::Value::Object(all_settings);
        // Redact sensitive values in the remote settings
        let redacted_settings = redact_sensitive_json(&*settings);
        debug!("🔄 Updated remotes settings: {:?}", redacted_settings);
    }
    pub async fn refresh_mounted_remotes(&self, app_handle: tauri::AppHandle) {
        match get_mounted_remotes(app_handle.state()).await {
            Ok(remotes) => {
                let mut mounted = self.mounted.write().await;
                *mounted = remotes;
                debug!("🔄 Updated mounted remotes cache");
            }
            Err(e) => {
                error!("❌ Failed to refresh mounted remotes: {}", e);
            }
        }
    }

    pub async fn refresh_all(&self, app_handle: tauri::AppHandle) {
        self.refresh_remote_list(app_handle.clone()).await;
        self.refresh_remote_configs(app_handle.clone()).await;
        self.refresh_remote_settings(app_handle.clone()).await;
        self.refresh_mounted_remotes(app_handle.clone()).await;
    }
}

#[tauri::command]
pub async fn get_cached_remotes() -> Result<Vec<String>, String> {
    Ok(CACHE.remotes.read().await.clone())
}

#[tauri::command]
pub async fn get_configs() -> Result<serde_json::Value, String> {
    Ok(CACHE.configs.read().await.clone())
}

#[tauri::command]
pub async fn get_settings() -> Result<serde_json::Value, String> {
    Ok(CACHE.settings.read().await.clone())
}

#[tauri::command]
pub async fn get_cached_mounted_remotes() -> Result<Vec<MountedRemote>, String> {
    Ok(CACHE.mounted.read().await.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteError {
    pub timestamp: DateTime<Utc>,
    pub remote_name: String,
    pub operation: String, // "mount", "unmount", "sync", etc.
    pub error: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLogEntry {
    pub timestamp: DateTime<Utc>,
    pub remote_name: Option<String>,
    pub level: String, // "info", "error", "warn", "debug"
    pub message: String,
    pub context: Option<serde_json::Value>,
}

pub struct RemoteErrorCache {
    pub errors: RwLock<Vec<RemoteError>>,
    pub logs: RwLock<Vec<RemoteLogEntry>>,
}

pub static ERROR_CACHE: Lazy<RemoteErrorCache> = Lazy::new(|| RemoteErrorCache {
    errors: RwLock::new(Vec::new()),
    logs: RwLock::new(Vec::new()),
});

impl RemoteErrorCache {
    pub async fn add_error(&self, error: RemoteError) {
        let mut errors = self.errors.write().await;
        errors.push(error);
        // Keep only the last 100 errors to prevent memory bloat
        if errors.len() > 100 {
            errors.remove(0);
        }
    }

    pub async fn add_log(&self, log: RemoteLogEntry) {
        let mut logs = self.logs.write().await;
        logs.push(log);
        // Keep only the last 500 logs
        if logs.len() > 500 {
            let excess = logs.len() - 500;
            logs.drain(0..excess);
        }
    }

    pub async fn get_errors_for_remote(&self, remote_name: &str) -> Vec<RemoteError> {
        let errors = self.errors.read().await;
        errors
            .iter()
            .filter(|e| e.remote_name == remote_name)
            .cloned()
            .collect()
    }

    pub async fn get_logs_for_remote(&self, remote_name: Option<&str>) -> Vec<RemoteLogEntry> {
        let logs = self.logs.read().await;
        match remote_name {
            Some(name) => logs
                .iter()
                .filter(|l| l.remote_name.as_deref() == Some(name))
                .cloned()
                .collect(),
            None => logs.clone(),
        }
    }

    pub async fn clear_remote_errors(&self, remote_name: &str) {
        let mut errors = self.errors.write().await;
        errors.retain(|e| e.remote_name != remote_name);
    }

    pub async fn clear_remote_logs(&self, remote_name: &str) {
        let mut logs = self.logs.write().await;
        logs.retain(|l| l.remote_name.as_deref() != Some(remote_name));
    }
}

// Add these commands to expose the cache to the frontend
#[tauri::command]
pub async fn get_remote_errors(remote_name: Option<String>) -> Result<Vec<RemoteError>, String> {
    let cache = &ERROR_CACHE;
    match remote_name {
        Some(name) => Ok(cache.get_errors_for_remote(&name).await),
        None => Ok(cache.errors.read().await.clone()),
    }
}

#[tauri::command]
pub async fn get_remote_logs(remote_name: Option<String>) -> Result<Vec<RemoteLogEntry>, String> {
    Ok(ERROR_CACHE
        .get_logs_for_remote(remote_name.as_deref())
        .await)
}

#[tauri::command]
pub async fn clear_errors_for_remote(remote_name: String) -> Result<(), String> {
    ERROR_CACHE.clear_remote_errors(&remote_name).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_logs_for_remote(remote_name: String) -> Result<(), String> {
    ERROR_CACHE.clear_remote_logs(&remote_name).await;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
    pub job_type: String, // "sync" or "copy"
    pub remote_name: String,
    pub source: String,
    pub destination: String,
    pub start_time: DateTime<Utc>,
    pub status: String, // "running", "completed", "failed", "stopped"
    pub stats: Option<Value>,
    pub group: String, // Add this field to track the job group
}

pub struct JobCache {
    pub jobs: RwLock<Vec<JobInfo>>,
}

pub static JOB_CACHE: Lazy<JobCache> = Lazy::new(|| JobCache {
    jobs: RwLock::new(Vec::new()),
});

impl JobCache {
    pub async fn add_job(&self, job: JobInfo) {
        let mut jobs = self.jobs.write().await;
        jobs.push(job);
    }

    pub async fn remove_job(&self, jobid: u64) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        let len_before = jobs.len();
        jobs.retain(|j| j.jobid != jobid);
        if jobs.len() < len_before {
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            job.stats = Some(stats);
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    pub async fn complete_job(&self, jobid: u64, success: bool) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            job.status = if success {
                "completed".to_string()
            } else {
                "failed".to_string()
            };
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    pub async fn get_jobs(&self) -> Vec<JobInfo> {
        self.jobs.read().await.clone()
    }

    pub async fn get_active_jobs(&self) -> Vec<JobInfo> {
        let jobs = self.get_jobs().await;
        jobs.into_iter()
            .filter(|job| job.status == "running")
            .collect()
    }

    pub async fn get_job(&self, jobid: u64) -> Option<JobInfo> {
        self.jobs
            .read()
            .await
            .iter()
            .find(|j| j.jobid == jobid)
            .cloned()
    }
}

#[tauri::command]
pub async fn get_jobs() -> Result<Vec<JobInfo>, String> {
    Ok(JOB_CACHE.get_jobs().await)
}

#[tauri::command]
pub async fn get_job_status(jobid: u64) -> Result<Option<JobInfo>, String> {
    Ok(JOB_CACHE.get_job(jobid).await)
}

#[tauri::command]
pub async fn get_active_jobs() -> Result<Vec<JobInfo>, String> {
    Ok(JOB_CACHE.get_active_jobs().await)
}
