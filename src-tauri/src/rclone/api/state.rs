use std::sync::Arc;

use log::{debug, error};
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use tauri::Manager;
use tokio::sync::RwLock;

use crate::{
    core::settings::settings::get_remote_settings,
    utils::types::{
        EngineState, JobCache, JobInfo, LogCache, LogEntry, MountedRemote, RcloneState,
        RemoteCache, SENSITIVE_KEYS,
    },
};

use super::api_query::{get_all_remote_configs, get_mounted_remotes, get_remotes};

fn redact_sensitive_values(
    params: &Vec<std::string::String>,
    restrict_mode: &Arc<std::sync::RwLock<bool>>,
) -> Value {
    params
        .iter()
        .map(|k| {
            let value = if *restrict_mode.read().unwrap()
                && SENSITIVE_KEYS
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
fn redact_sensitive_json(value: &Value, restrict_mode: &Arc<std::sync::RwLock<bool>>) -> Value {
    match value {
        Value::Object(map) => {
            let redacted_map = map
                .iter()
                .map(|(k, v)| {
                    if *restrict_mode.read().unwrap()
                        && SENSITIVE_KEYS
                            .iter()
                            .any(|sk| k.to_lowercase().contains(sk))
                    {
                        (k.clone(), json!("[RESTRICTED]"))
                    } else {
                        (k.clone(), redact_sensitive_json(v, restrict_mode))
                    }
                })
                .collect();
            Value::Object(redacted_map)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| redact_sensitive_json(v, restrict_mode))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub static ENGINE_STATE: Lazy<EngineState> = Lazy::new(|| EngineState {
    api_url: std::sync::Mutex::new(String::new()),
    api_port: std::sync::Mutex::new(5572),
    oauth_url: std::sync::Mutex::new(String::new()),
    oauth_port: std::sync::Mutex::new(5580),
});

impl EngineState {
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
            let state = app_handle.state::<RcloneState>();
            let redacted_remotes = redact_sensitive_values(&*remotes, &state.restrict_mode);
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
            let state = app_handle.state::<RcloneState>();
            let redacted_configs = redact_sensitive_json(&*configs, &state.restrict_mode);
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
        let state = app_handle.state::<RcloneState>();
        let redacted_settings = redact_sensitive_json(&*settings, &state.restrict_mode);
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

pub static LOG_CACHE: Lazy<LogCache> = Lazy::new(|| LogCache::new(1000));

impl LogCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: RwLock::new(Vec::with_capacity(max_entries)),
            max_entries,
        }
    }

    pub async fn add_entry(&self, entry: LogEntry) {
        let mut entries = self.entries.write().await;
        entries.push(entry);

        // Maintain max size
        let len = entries.len();
        if len > self.max_entries {
            entries.drain(0..(len - self.max_entries));
        }
    }

    pub async fn get_logs_for_remote(&self, remote_name: Option<&str>) -> Vec<LogEntry> {
        let entries = self.entries.read().await;
        entries
            .iter()
            .filter_map(|e| {
                if let Some(name) = &e.remote_name {
                    if remote_name.is_none() || name == remote_name.unwrap() {
                        Some(LogEntry {
                            timestamp: e.timestamp,
                            remote_name: Some(name.clone()),
                            level: e.level.clone(),
                            message: e.message.clone(),
                            context: e.context.clone(),
                            operation: e.operation.clone(),
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect()
    }

    pub async fn clear_for_remote(&self, remote_name: &str) {
        let mut entries = self.entries.write().await;
        entries.retain(|e| e.remote_name.as_deref() != Some(remote_name));
    }
}

#[tauri::command]
pub async fn get_remote_logs(
    remote_name: Option<String>,
) -> Result<Vec<LogEntry>, String> {
    let logs = LOG_CACHE.get_logs_for_remote(remote_name.as_deref()).await;
    Ok(logs)
}

#[tauri::command]
pub async fn clear_remote_logs(remote_name: Option<String>) -> Result<(), String> {
    if let Some(name) = remote_name {
        LOG_CACHE.clear_for_remote(&name).await;
    }
    Ok(())
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
