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
            Some(&group_payload(group.clone())),
        )
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {e}");
            format!("Failed to get completed transfers: {e}")
        })?;

    // Fallback for manual jobs in our cache
    if let Some(ref group_name) = group {
        let job_cache = &app.state::<BackendManager>().job_cache;
        let all_jobs = job_cache.get_jobs().await;
        if let Some(manual_job) = all_jobs
            .iter()
            .find(|j| j.group == *group_name || format!("job_{}", j.jobid) == *group_name)
            && let Some(completed) = manual_job
                .stats
                .as_ref()
                .and_then(|s| s.get("completed"))
                .and_then(|v| v.as_array())
            && !completed.is_empty()
        {
            let rclone_count = value
                .get("transferred")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if completed.len() > rclone_count {
                value["transferred"] = json!(completed);
            }
        }
    }

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
