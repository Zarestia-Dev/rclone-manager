use log::{debug, error};
use serde_json::json;
use tauri::State;

use crate::rclone::backend::BACKEND_MANAGER;
use crate::utils::rclone::endpoints::{EndpointHelper, core};
use crate::utils::types::core::RcloneState;

/// Get RClone core statistics  
#[tauri::command]
pub async fn get_core_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), core::STATS);

    let response = backend
        .inject_auth(state.client.post(&url))
        .send()
        .await
        .map_err(|e| format!("Failed to get core stats: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse core stats: {e}"))
}

/// Get RClone core statistics filtered by group/job
#[tauri::command]
pub async fn get_core_stats_filtered(
    state: State<'_, RcloneState>,
    jobid: Option<u64>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), core::STATS);

    let mut payload = json!({});

    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📊 Getting core stats for group: {group}");
    } else if let Some(jobid) = jobid {
        let group_name = format!("job/{jobid}");
        payload["group"] = json!(group_name);
        debug!("📊 Getting core stats for job: {jobid}");
    } else {
        debug!("📊 Getting global core stats");
    }

    debug!("📡 Requesting core stats from: {url} with payload: {payload}");

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get filtered core stats: {e}");
            format!("Failed to get filtered core stats: {e}")
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!("❌ HTTP error getting core stats: {status} - {body}");
        return Err(format!("HTTP {status}: {body}"));
    }

    debug!("✅ Core stats response: {body}");
    serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse filtered core stats: {e}");
        format!("Failed to parse filtered core stats: {e}")
    })
}

/// Get completed transfers using core/transferred API
#[tauri::command]
pub async fn get_completed_transfers(
    state: State<'_, RcloneState>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), core::TRANSFERRED);

    let mut payload = json!({});
    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📋 Getting completed transfers for group: {group}");
    } else {
        debug!("📋 Getting all completed transfers");
    }

    debug!("📡 Requesting completed transfers from: {url} with payload: {payload}");

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {e}");
            format!("Failed to get completed transfers: {e}")
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!("❌ HTTP error getting completed transfers: {status} - {body}");
        return Err(format!("HTTP {status}: {body}"));
    }

    debug!("✅ Completed transfers response: {body}");

    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut value: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse completed transfers: {e}");
        format!("Failed to parse completed transfers: {e}")
    })?;

    // Only normalize on Windows
    #[cfg(target_os = "windows")]
    {
        use crate::utils::json_helpers::normalize_windows_path;
        debug!("📊 Normalizing paths in completed transfers response: {value}");
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
