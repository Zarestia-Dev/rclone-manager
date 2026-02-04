use log::error;
use serde_json::json;

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::core::RcloneState;
use tauri::{AppHandle, Manager};

/// Get RClone core statistics  
#[tauri::command]
pub async fn get_stats(app: AppHandle, group: Option<String>) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(group) = group {
        payload["group"] = json!(group);
    }

    backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::STATS,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to get core stats: {e}"))
}

/// Get completed transfers using core/transferred API
#[tauri::command]
pub async fn get_completed_transfers(
    app: AppHandle,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(group) = group {
        payload["group"] = json!(group);
    }

    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut value = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::TRANSFERRED,
            Some(&payload),
        )
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {e}");
            format!("Failed to get completed transfers: {e}")
        })?;

    // Only normalize on Windows
    #[cfg(target_os = "windows")]
    {
        use crate::utils::json_helpers::normalize_windows_path;
        log::debug!("📊 Normalizing paths in completed transfers response: {value}");
        if let Some(transferred) = value.get_mut("transferred").and_then(|v| v.as_array_mut()) {
            for transfer in transferred.iter_mut() {
                for field in ["dstFs", "srcFs"] {
                    if let Some(fs_value) = transfer.get_mut(field)
                        && let Some(path_str) = fs_value.as_str()
                    {
                        *fs_value = serde_json::Value::String(normalize_windows_path(path_str));
                    }
                }
            }
        }
    }

    Ok(value)
}
