use log::debug;
use serde_json::json;
use std::process::Command;
use tauri::{Emitter, Manager, State};

use crate::RcloneState;
use crate::rclone::state::ENGINE_STATE;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::{BandwidthLimitResponse, RcloneCoreVersion},
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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::VERSION);

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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::PID);
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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::MEMSTATS);

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

/// Check if a newer version of rclone is available
#[tauri::command]
pub async fn check_rclone_update(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    // Get current version
    let current_version = match get_rclone_info(state.clone()).await {
        Ok(info) => info.version,
        Err(e) => return Err(format!("Failed to get current rclone version: {e}")),
    };

    // Get latest version from GitHub API
    let latest_version = get_latest_rclone_version(&state).await?;

    // Compare versions
    let update_available = is_version_newer(&latest_version, &current_version);

    Ok(json!({
        "current_version": current_version,
        "latest_version": latest_version,
        "update_available": update_available,
        "current_version_clean": clean_version(&current_version),
        "latest_version_clean": clean_version(&latest_version)
    }))
}

/// Get the latest rclone version from GitHub releases
async fn get_latest_rclone_version(state: &State<'_, RcloneState>) -> Result<String, String> {
    let url = "https://api.github.com/repos/rclone/rclone/releases/latest";

    let response = state
        .client
        .get(url)
        .header("User-Agent", "rclone-manager")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest version: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {e}"))?;

    let tag_name = release_data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("No tag_name found in release data")?;

    Ok(tag_name.to_string())
}

/// Clean version string (remove 'v' prefix, etc.)
fn clean_version(version: &str) -> String {
    version.trim_start_matches('v').to_string()
}

/// Compare two version strings to see if the first is newer
fn is_version_newer(latest: &str, current: &str) -> bool {
    let latest_clean = clean_version(latest);
    let current_clean = clean_version(current);

    // Simple version comparison (works for semantic versioning)
    let latest_parts: Vec<u32> = latest_clean
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();

    let current_parts: Vec<u32> = current_clean
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();

    // Pad with zeros if lengths differ
    let max_len = latest_parts.len().max(current_parts.len());
    let mut latest_padded = latest_parts;
    let mut current_padded = current_parts;

    latest_padded.resize(max_len, 0);
    current_padded.resize(max_len, 0);

    latest_padded > current_padded
}

/// Update rclone to the latest version
#[tauri::command]
pub async fn update_rclone(
    state: State<'_, RcloneState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    // First, check if update is available
    let update_check = check_rclone_update(state).await?;
    let update_available = update_check
        .get("update_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !update_available {
        return Ok(json!({
            "success": false,
            "message": "No update available",
            "current_version": update_check.get("current_version")
        }));
    }

    // Get current rclone path
    let rclone_state = app_handle.state::<RcloneState>();
    let current_path = rclone_state.rclone_path.read().unwrap().clone();

    if !current_path.exists() {
        return Err("Current rclone binary not found".to_string());
    }

    // Stop the engine before updating
    app_handle
        .emit(
            "engine_update_started",
            json!({
                "status": "stopping_engine"
            }),
        )
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // Use rclone's self-update feature
    let update_result = perform_rclone_update(&current_path).await?;

    // Restart the engine after update
    app_handle
        .emit(
            "engine_update_completed",
            json!({
                "status": "restarting_engine",
                "success": update_result["success"]
            }),
        )
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // Restart engine with updated binary
    if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
        &app_handle,
        "rclone_update",
        update_check
            .get("current_version")
            .unwrap()
            .as_str()
            .unwrap_or("unknown"),
        update_check
            .get("latest_version")
            .unwrap()
            .as_str()
            .unwrap_or("unknown"),
    ) {
        return Err(format!("Failed to restart engine after update: {e}"));
    }

    Ok(update_result)
}

/// Perform the actual rclone update using rclone's self-update feature
async fn perform_rclone_update(rclone_path: &std::path::Path) -> Result<serde_json::Value, String> {
    let output = Command::new(rclone_path)
        .arg("selfupdate")
        .output()
        .map_err(|e| format!("Failed to execute rclone selfupdate: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        Ok(json!({
            "success": true,
            "message": "Rclone updated successfully",
            "stdout": stdout,
            "stderr": stderr
        }))
    } else {
        Err(format!("Rclone update failed: {stderr}"))
    }
}

/// Get detailed update information including changelog
#[tauri::command]
pub async fn get_rclone_update_info(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let update_check = check_rclone_update(state.clone()).await?;

    if !update_check
        .get("update_available")
        .unwrap_or(&json!(false))
        .as_bool()
        .unwrap_or(false)
    {
        return Ok(update_check);
    }

    // Get release notes from GitHub
    let latest_version = update_check
        .get("latest_version")
        .unwrap()
        .as_str()
        .unwrap();
    let release_info = get_release_info(&state, latest_version).await?;

    Ok(json!({
        "current_version": update_check.get("current_version"),
        "latest_version": update_check.get("latest_version"),
        "update_available": true,
        "release_notes": release_info.get("body"),
        "release_date": release_info.get("published_at"),
        "download_url": release_info.get("html_url")
    }))
}

/// Get release information from GitHub
async fn get_release_info(
    state: &State<'_, RcloneState>,
    version: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/rclone/rclone/releases/tags/{version}");

    let response = state
        .client
        .get(&url)
        .header("User-Agent", "rclone-manager")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {e}"))
}
