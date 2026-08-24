use std::path::PathBuf;

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::{
    core::bridge,
    rclone::backend::BackendManager,
    utils::rclone::endpoints::{config, core},
};

#[bridge]
pub async fn get_rclone_config_file(app: AppHandle) -> Result<PathBuf, String> {
    let paths = crate::rclone::commands::common::transport(&app)
        .rpc(config::PATHS, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to execute API request: {e}"))?;

    let config_path_str = paths
        .get("config")
        .and_then(|v| v.as_str())
        .ok_or("No config path in response")?;

    let path = PathBuf::from(config_path_str);
    if path.is_absolute() {
        Ok(path)
    } else {
        let app_paths = crate::core::paths::AppPaths::from_app_handle(&app)?;
        Ok(app_paths.config_dir.join(path))
    }
}

#[bridge]
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
#[serde(rename_all = "camelCase")]
pub struct LocalDiskUsageResponse {
    pub free: u64,
    pub total: u64,
    pub used: u64,
    pub dir: String,
}

/// Get local disk usage for a directory using rclone's core/du endpoint
/// This returns disk space info (Available, Free, Total) for a LOCAL directory,
/// useful for checking space on mount points.
#[bridge]
pub async fn get_local_disk_usage(
    app: AppHandle,
    dir: Option<String>,
) -> Result<LocalDiskUsageResponse, String> {
    let mut payload = json!({});
    if let Some(ref d) = dir {
        payload["dir"] = json!(d);
    }

    // Use direct request instead of submit_job_and_wait to avoid creating tracked jobs for polling
    let response_json = crate::rclone::commands::common::transport(&app)
        .rpc(core::DU, Some(&payload))
        .await
        .map_err(|e| format!("Failed to get local disk usage: {e}"))?;

    // Deserializing into a struct is much cleaner and safer than pointer lookups
    let response: RcloneDiskUsageResponse = serde_json::from_value(response_json)
        .map_err(|e| format!("Failed to parse rclone response: {e}"))?;

    let total = response.info.total;
    let used = response.info.total.saturating_sub(response.info.free);
    let free = response.info.free;

    Ok(LocalDiskUsageResponse {
        free,
        total,
        used,
        dir: response.dir,
    })
}

#[bridge]
pub async fn obscure_value(app: AppHandle, clear: String) -> Result<String, String> {
    let payload = json!({
        "clear": clear,
    });

    let response_json = crate::rclone::commands::common::transport(&app)
        .rpc(core::OBSCURE, Some(&payload))
        .await
        .map_err(|e| format!("Failed to obscure value: {e}"))?;

    let obscured = response_json
        .get("obscured")
        .and_then(|v| v.as_str())
        .ok_or("No obscured field in response")?;

    Ok(obscured.to_string())
}
