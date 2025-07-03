use log::debug;
use serde_json::json;
use tauri::State;

use crate::RcloneState;
use crate::rclone::state::ENGINE_STATE;
use crate::utils::{
    rclone::endpoints::{core, EndpointHelper},
    types::{BandwidthLimitResponse, RcloneCoreVersion},
};

#[tauri::command]
pub async fn get_bandwidth_limit(
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::BWLIMIT);

    let response = state
        .client
        .post(&url)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(response_data)
}

#[tauri::command]
pub async fn get_rclone_info(state: State<'_, RcloneState>) -> Result<RcloneCoreVersion, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::VERSION);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get Rclone version: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse version info: {}", e))
}

#[tauri::command]
pub async fn get_rclone_pid(state: State<'_, RcloneState>) -> Result<Option<u32>, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::PID);
    match state.client.post(&url).send().await {
        Ok(resp) => {
            debug!("📡 Querying rclone /core/pid: {}", url);
            debug!("rclone /core/pid response status: {}", resp.status());
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => Ok(json.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32)),
                    Err(e) => {
                        debug!("Failed to parse /core/pid response: {}", e);
                        Err(format!("Failed to parse /core/pid response: {}", e))
                    }
                }
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                debug!("rclone /core/pid returned non-success status");
                Err(format!(
                    "rclone /core/pid returned non-success status: {}: {}",
                    status, body
                ))
            }
        }
        Err(e) => {
            debug!("Failed to query /core/pid: {}", e);
            Err(format!("Failed to query /core/pid: {}", e))
        }
    }
}

/// Get RClone memory statistics
#[tauri::command]
pub async fn get_memory_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::MEMSTATS);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get memory stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse memory stats: {}", e))
}
