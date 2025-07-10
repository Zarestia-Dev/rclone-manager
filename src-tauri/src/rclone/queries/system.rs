use log::debug;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::RcloneState;
use crate::rclone::state::ENGINE_STATE;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::{BandwidthLimitResponse, RcloneCoreVersion},
};

#[derive(Debug, Clone)]
enum UpdateStrategy {
    /// Update in place (rclone has write permissions to its own location)
    InPlace,
    /// Copy to local app directory and update there
    CopyToLocal(PathBuf),
    /// Download new binary to local app directory
    DownloadToLocal(PathBuf),
}

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

/// Update rclone to the latest version with cross-platform permission handling
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

    // Determine the best update strategy based on current path and permissions
    let update_result = match determine_update_strategy(&current_path, &app_handle).await {
        Ok(strategy) => {
            log::info!("Using update strategy: {strategy:?}");
            execute_update_strategy(strategy, &current_path, &app_handle).await
        }
        Err(e) => {
            log::error!("Failed to determine update strategy: {e}");
            Err(e)
        }
    };

    // Emit completion event regardless of success/failure
    let success = update_result
        .as_ref()
        .map(|r| r["success"].as_bool().unwrap_or(false))
        .unwrap_or(false);

    app_handle
        .emit(
            "engine_update_completed",
            json!({
                "status": "restarting_engine",
                "success": success
            }),
        )
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // If update was successful, restart engine with updated binary
    if success {
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
    }

    update_result
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

/// Determine the best update strategy based on current rclone path and permissions
async fn determine_update_strategy(
    current_path: &Path,
    app_handle: &AppHandle,
) -> Result<UpdateStrategy, String> {
    // Try to check if we can write to the current rclone location
    if can_update_in_place(current_path) {
        log::info!("Can update rclone in place at: {current_path:?}");
        return Ok(UpdateStrategy::InPlace);
    }

    // Get the app's local data directory
    let local_rclone_path = get_local_rclone_path(app_handle)?;

    // Ensure the directory exists
    if let Some(parent) = local_rclone_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create local rclone directory: {e}"))?;
    }

    // If current rclone exists and we can read it, copy it to local directory
    if current_path.exists() && current_path.is_file() {
        log::info!("Will copy system rclone to local directory: {local_rclone_path:?}");
        Ok(UpdateStrategy::CopyToLocal(local_rclone_path))
    } else {
        log::info!("Will download rclone to local directory: {local_rclone_path:?}");
        Ok(UpdateStrategy::DownloadToLocal(local_rclone_path))
    }
}

/// Execute the determined update strategy
async fn execute_update_strategy(
    strategy: UpdateStrategy,
    current_path: &Path,
    app_handle: &AppHandle,
) -> Result<serde_json::Value, String> {
    match strategy {
        UpdateStrategy::InPlace => {
            log::info!("Executing in-place update");
            perform_rclone_selfupdate(current_path).await
        }
        UpdateStrategy::CopyToLocal(local_path) => {
            log::info!("Executing copy-to-local strategy");

            // First, copy the current rclone to local directory
            copy_rclone_to_local(current_path, &local_path)?;

            // Update the app state to use the local copy
            update_rclone_path_in_state(app_handle, &local_path)?;

            // Now update the local copy
            perform_rclone_selfupdate(&local_path).await
        }
        UpdateStrategy::DownloadToLocal(local_path) => {
            log::info!("Executing download-to-local strategy");

            // Download the latest rclone binary
            download_latest_rclone(&local_path).await?;

            // Update the app state to use the local copy
            update_rclone_path_in_state(app_handle, &local_path)?;

            Ok(json!({
                "success": true,
                "message": "Rclone downloaded and installed successfully",
                "path": local_path.display().to_string()
            }))
        }
    }
}

/// Check if we can update rclone in its current location
fn can_update_in_place(rclone_path: &Path) -> bool {
    // Get the directory containing the rclone binary
    let parent_dir = match rclone_path.parent() {
        Some(dir) => dir,
        #[allow(non_snake_case)]
        None => return false,
    };

    // Check if we can write to the directory
    let test_file = parent_dir.join(".rclone_manager_write_test");
    match std::fs::write(&test_file, "test") {
        Ok(_) => {
            // Clean up test file
            let _ = std::fs::remove_file(&test_file);
            true
        }
        Err(_) => false,
    }
}

/// Get the local rclone path in the app's data directory
fn get_local_rclone_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let mut rclone_path = app_data_dir.join("bin");

    // Add platform-specific extension
    #[cfg(target_os = "windows")]
    {
        rclone_path = rclone_path.join("rclone.exe");
    }
    #[cfg(not(target_os = "windows"))]
    {
        rclone_path = rclone_path.join("rclone");
    }

    Ok(rclone_path)
}

/// Copy system rclone to local directory
fn copy_rclone_to_local(source_path: &Path, dest_path: &Path) -> Result<(), String> {
    log::info!("Copying rclone from {source_path:?} to {dest_path:?}");

    std::fs::copy(source_path, dest_path)
        .map_err(|e| format!("Failed to copy rclone to local directory: {e}"))?;

    // Set executable permissions on Unix-like systems
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest_path)
            .map_err(|e| format!("Failed to get file permissions: {e}"))?
            .permissions();
        perms.set_mode(0o755); // rwxr-xr-x
        std::fs::set_permissions(dest_path, perms)
            .map_err(|e| format!("Failed to set executable permissions: {e}"))?;
    }

    Ok(())
}

/// Update the rclone path in the application state
fn update_rclone_path_in_state(app_handle: &AppHandle, new_path: &Path) -> Result<(), String> {
    let rclone_state = app_handle.state::<RcloneState>();
    let mut path_guard = rclone_state.rclone_path.write().unwrap();
    *path_guard = new_path.to_path_buf();

    log::info!("Updated rclone path in state to: {new_path:?}");
    Ok(())
}

/// Download the latest rclone binary
async fn download_latest_rclone(dest_path: &Path) -> Result<(), String> {
    // This is a simplified implementation - you might want to implement
    // a more robust download mechanism
    log::warn!("Download functionality not yet implemented - using rclone selfupdate as fallback");

    // For now, we'll try to use any available rclone to download itself
    // This is a fallback - ideally you'd implement direct binary download
    let output = Command::new("rclone")
        .args(["selfupdate", "--output", &dest_path.display().to_string()])
        .output()
        .map_err(|e| format!("Failed to download rclone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to download rclone: {stderr}"));
    }

    Ok(())
}

/// Perform rclone selfupdate on the specified binary
async fn perform_rclone_selfupdate(rclone_path: &Path) -> Result<serde_json::Value, String> {
    log::info!("Performing selfupdate on rclone at: {rclone_path:?}");

    let output = Command::new(rclone_path)
        .arg("selfupdate")
        .output()
        .map_err(|e| {
            log::error!("Failed to execute rclone selfupdate: {e}");
            format!("Failed to execute rclone selfupdate: {e}")
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        log::info!("Rclone selfupdate completed successfully");
        Ok(json!({
            "success": true,
            "message": "Rclone updated successfully",
            "stdout": stdout,
            "stderr": stderr,
            "path": rclone_path.display().to_string()
        }))
    } else {
        log::error!("Rclone selfupdate failed: {stderr}");
        Err(format!("Rclone selfupdate failed: {stderr}"))
    }
}
