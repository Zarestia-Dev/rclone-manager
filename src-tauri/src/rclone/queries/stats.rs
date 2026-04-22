use log::error;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::core::RcloneState;

fn group_payload(group: Option<String>) -> Value {
    match group {
        Some(g) => json!({ "group": g }),
        None => json!({}),
    }
}

#[tauri::command]
pub async fn get_stats(app: AppHandle, group: Option<String>) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::STATS,
            Some(&group_payload(group)),
        )
        .await
        .map_err(|e| format!("Failed to get core stats: {e}"))
}

#[tauri::command]
pub async fn get_completed_transfers(
    app: AppHandle,
    group: Option<String>,
) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;

    #[allow(unused_mut)]
    let mut value = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::TRANSFERRED,
            Some(&group_payload(group)),
        )
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {e}");
            format!("Failed to get completed transfers: {e}")
        })?;

    #[cfg(target_os = "windows")]
    {
        use crate::utils::json_helpers::normalize_windows_path;
        if let Some(transferred) = value.get_mut("transferred").and_then(|v| v.as_array_mut()) {
            for transfer in transferred.iter_mut() {
                for field in ["dstFs", "srcFs"] {
                    if let Some(fs_value) = transfer.get_mut(field)
                        && let Some(path_str) = fs_value.as_str()
                    {
                        *fs_value = Value::String(normalize_windows_path(path_str));
                    }
                }
            }
        }
    }

    Ok(value)
}
