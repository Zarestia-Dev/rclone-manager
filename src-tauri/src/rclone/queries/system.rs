use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::{config, core};
use crate::utils::types::rclone::RcloneCoreVersion;
use crate::utils::types::state::RcloneState;

/// Fetch version information from Rclone
pub async fn fetch_version_info(
    backend: &crate::rclone::backend::types::Backend,
    client: &reqwest::Client,
) -> Result<RcloneCoreVersion, String> {
    let json = backend
        .post_json(client, core::VERSION, None)
        .await
        .map_err(|e| format!("Failed to get Rclone version: {e}"))?;

    serde_json::from_value(json).map_err(|e| format!("Failed to parse version info: {e}"))
}

#[tauri::command]
pub async fn get_rclone_config_file(app: AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let paths = backend
        .post_json(&state.client, config::PATHS, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to execute API request: {e}"))?;

    let config_path = paths
        .get("config")
        .and_then(|v| v.as_str())
        .ok_or("No config path in response")?;

    Ok(PathBuf::from(config_path))
}

#[tauri::command]
pub async fn get_rclone_rc_url(app: AppHandle) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    Ok(backend.api_url())
}

#[derive(serde::Deserialize)]
struct RcloneDiskInfo {
    #[serde(rename = "Free")]
    free: u64,
    #[serde(rename = "Total")]
    total: u64,
}

#[derive(serde::Deserialize)]
struct RcloneDiskUsageResponse {
    dir: String,
    info: RcloneDiskInfo,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalDiskUsageColor {
    Primary,
    Accent,
    Warn,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDiskUsageResponse {
    free: u64,
    total: u64,
    used: u64,
    dir: String,
    pub usage_percentage: f64,
    pub usage_color: LocalDiskUsageColor,
}

/// Get local disk usage for a directory using rclone's core/du endpoint
/// This returns disk space info (Available, Free, Total) for a LOCAL directory,
/// useful for checking space on mount points.
#[tauri::command]
pub async fn get_local_disk_usage(
    app: AppHandle,
    dir: Option<String>,
) -> Result<LocalDiskUsageResponse, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(ref d) = dir {
        payload["dir"] = json!(d);
    }

    // Use direct request instead of submit_job_and_wait to avoid creating tracked jobs for polling
    let response_json = backend
        .post_json(&app.state::<RcloneState>().client, core::DU, Some(&payload))
        .await
        .map_err(|e| format!("Failed to get local disk usage: {e}"))?;

    // Deserializing into a struct is much cleaner and safer than pointer lookups
    let response: RcloneDiskUsageResponse = serde_json::from_value(response_json)
        .map_err(|e| format!("Failed to parse rclone response: {e}"))?;

    let total = response.info.total;
    let used = response.info.total.saturating_sub(response.info.free);
    let free = response.info.free;

    let usage_percentage = if total > 0 {
        (used as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    let ratio = if total > 0 {
        used as f64 / total as f64
    } else {
        0.0
    };

    let usage_color = if ratio > 0.9 {
        LocalDiskUsageColor::Warn
    } else if ratio > 0.7 {
        LocalDiskUsageColor::Accent
    } else {
        LocalDiskUsageColor::Primary
    };

    Ok(LocalDiskUsageResponse {
        free,
        total,
        used,
        dir: response.dir,
        usage_percentage,
        usage_color,
    })
}
