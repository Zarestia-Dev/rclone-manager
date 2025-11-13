use log::debug;
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::RcloneState;
use crate::rclone::engine::core::ENGINE;
use crate::utils::rclone::endpoints::config;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::{BandwidthLimitResponse, RcloneCoreVersion},
};

#[tauri::command]
pub async fn get_bandwidth_limit(
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, core::BWLIMIT);

    let response = state
        .client
        .post(&url)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(response_data)
}

#[tauri::command]
pub async fn get_rclone_info(state: State<'_, RcloneState>) -> Result<RcloneCoreVersion, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, core::VERSION);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get Rclone version: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse version info: {e}"))
}

#[tauri::command]
pub async fn get_rclone_pid(state: State<'_, RcloneState>) -> Result<Option<u32>, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, core::PID);
    match state.client.post(&url).send().await {
        Ok(resp) => {
            debug!("📡 Querying rclone /core/pid: {url}");
            debug!("rclone /core/pid response status: {}", resp.status());
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => Ok(json.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32)),
                    Err(e) => {
                        debug!("Failed to parse /core/pid response: {e}");
                        Err(format!("Failed to parse /core/pid response: {e}"))
                    }
                }
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                debug!("rclone /core/pid returned non-success status");
                Err(format!(
                    "rclone /core/pid returned non-success status: {status}: {body}"
                ))
            }
        }
        Err(e) => {
            debug!("Failed to query /core/pid: {e}");
            Err(format!("Failed to query /core/pid: {e}"))
        }
    }
}

/// Get RClone memory statistics
#[tauri::command]
pub async fn get_memory_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, core::MEMSTATS);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get memory stats: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse memory stats: {e}"))
}

#[tauri::command]
pub async fn get_rclone_config_file(app: AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<RcloneState>();
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, config::PATHS);

    let response = state
        .client
        .post(&url)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| format!("Failed to execute API request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "API request failed with status: {}",
            response.status()
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let paths: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    let config_path = paths
        .get("config")
        .and_then(|v| v.as_str())
        .ok_or("No config path in response")?;

    Ok(PathBuf::from(config_path))
}
