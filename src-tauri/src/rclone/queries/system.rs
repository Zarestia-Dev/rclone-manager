use log::debug;
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::{config, core};
use crate::utils::types::core::{BandwidthLimitResponse, RcloneCoreVersion, RcloneState};

#[tauri::command]
pub async fn get_bandwidth_limit(app: AppHandle) -> Result<BandwidthLimitResponse, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let json = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::BWLIMIT,
            Some(&json!({})),
        )
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let response_data: BandwidthLimitResponse =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(response_data)
}

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
pub async fn get_rclone_info(app: AppHandle) -> Result<RcloneCoreVersion, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    fetch_version_info(&backend, &app.state::<RcloneState>().client).await
}

#[tauri::command]
pub async fn get_rclone_pid(app: AppHandle) -> Result<Option<u32>, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    match backend
        .post_json(&app.state::<RcloneState>().client, core::PID, None)
        .await
    {
        Ok(json) => Ok(json.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32)),
        Err(e) => {
            debug!("Failed to query /core/pid: {e}");
            Err(format!("Failed to query /core/pid: {e}"))
        }
    }
}

/// Get RClone memory statistics
#[tauri::command]
pub async fn get_memory_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let json = backend
        .post_json(&app.state::<RcloneState>().client, core::MEMSTATS, None)
        .await
        .map_err(|e| format!("Failed to get memory stats: {e}"))?;

    Ok(json)
}

/// Fetch config path from Rclone
pub async fn fetch_config_path(
    backend: &crate::rclone::backend::types::Backend,
    client: &reqwest::Client,
) -> Result<String, String> {
    let paths = backend
        .post_json(client, config::PATHS, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to execute API request: {e}"))?;

    let config_path = paths
        .get("config")
        .and_then(|v| v.as_str())
        .ok_or("No config path in response")?;

    Ok(config_path.to_string())
}

#[tauri::command]
pub async fn get_rclone_config_file(app: AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    match fetch_config_path(&backend, &state.client).await {
        Ok(path) => Ok(PathBuf::from(path)),
        Err(e) => Err(e),
    }
}

#[cfg(not(feature = "web-server"))]
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

#[derive(serde::Serialize)]
pub struct LocalDiskUsageResponse {
    free: u64,
    total: u64,
    used: u64,
    dir: String,
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

    Ok(LocalDiskUsageResponse {
        free: response.info.free,
        total: response.info.total,
        used: response.info.total.saturating_sub(response.info.free),
        dir: response.dir,
    })
}
