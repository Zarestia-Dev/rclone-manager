use log::{debug, error};
use serde_json::json;
use tauri::State;

use crate::rclone::state::ENGINE_STATE;
use crate::utils::rclone::endpoints::{core, EndpointHelper};
use crate::RcloneState;

/// Get RClone core statistics  
#[tauri::command]
pub async fn get_core_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::STATS);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get core stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse core stats: {}", e))
}

/// Get RClone core statistics filtered by group/job
#[tauri::command]
pub async fn get_core_stats_filtered(
    state: State<'_, RcloneState>,
    jobid: Option<u64>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::STATS);

    let mut payload = json!({});

    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📊 Getting core stats for group: {}", group);
    } else if let Some(jobid) = jobid {
        let group_name = format!("job/{}", jobid);
        payload["group"] = json!(group_name);
        debug!("📊 Getting core stats for job: {}", jobid);
    } else {
        debug!("📊 Getting global core stats");
    }

    debug!(
        "📡 Requesting core stats from: {} with payload: {}",
        url, payload
    );

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get filtered core stats: {}", e);
            format!("Failed to get filtered core stats: {}", e)
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!("❌ HTTP error getting core stats: {} - {}", status, body);
        return Err(format!("HTTP {}: {}", status, body));
    }

    debug!("✅ Core stats response: {}", body);
    serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse filtered core stats: {}", e);
        format!("Failed to parse filtered core stats: {}", e)
    })
}

/// Get completed transfers using core/transferred API
#[tauri::command]
pub async fn get_completed_transfers(
    state: State<'_, RcloneState>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::TRANSFERRED);

    let mut payload = json!({});
    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📋 Getting completed transfers for group: {}", group);
    } else {
        debug!("📋 Getting all completed transfers");
    }

    debug!(
        "📡 Requesting completed transfers from: {} with payload: {}",
        url, payload
    );

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {}", e);
            format!("Failed to get completed transfers: {}", e)
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!(
            "❌ HTTP error getting completed transfers: {} - {}",
            status, body
        );
        return Err(format!("HTTP {}: {}", status, body));
    }

    debug!("✅ Completed transfers response: {}", body);
    serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse completed transfers: {}", e);
        format!("Failed to parse completed transfers: {}", e)
    })
}

/// Get job stats with optional group filtering
#[tauri::command]
pub async fn get_job_stats(
    state: State<'_, RcloneState>,
    jobid: u64,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::STATS);

    let mut payload = json!({ "jobid": jobid });
    if let Some(group) = group {
        payload["group"] = json!(group);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to get job stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse job stats: {}", e))
}
