use log::debug;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::check_binaries::{build_rclone_command, get_rclone_binary_path, read_rclone_path};
use crate::utils::rclone::util::safe_copy_rclone;
use crate::{rclone::queries::get_rclone_info, utils::types::all_types::RcloneState};

#[derive(Debug, Clone)]
enum UpdateStrategy {
    /// Update in place (rclone has write permissions to its own location)
    InPlace,
    /// Copy to local app directory and update there
    CopyToLocal(PathBuf),
    /// Download new binary to local app directory
    DownloadToLocal(PathBuf),
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
    use crate::rclone::engine::ENGINE;
    // Set updating to true at the start
    {
        let mut engine = ENGINE
            .lock()
            .map_err(|e| format!("Failed to lock engine: {e}"))?;
        engine.updating = true;
        debug!("🔍 Starting rclone update process {0:?}", engine.updating);
    }

    // First, check if update is available
    let update_check = check_rclone_update(state).await?;
    let update_available = update_check
        .get("update_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !update_available {
        // Set updating to false before returning
        let mut engine = ENGINE
            .lock()
            .map_err(|e| format!("Failed to lock engine: {e}"))?;
        engine.updating = false;
        debug!("🔍 No update available for rclone");
        return Ok(json!({
            "success": false,
            "message": "No update available",
            "current_version": update_check.get("current_version")
        }));
    }

    // Get current rclone path and resolve the actual binary path
    let rclone_state = app_handle.state::<RcloneState>();
    let base_path = rclone_state.rclone_path.read().unwrap().clone();
    let mut current_path = get_rclone_binary_path(&base_path);

    if !current_path.exists() {
        debug!(
            "🔍 Configured rclone binary not found at: {}. Trying system-installed rclone",
            current_path.display()
        );
        // Try to find a system rclone (this will return a binary path if found)
        let system_path = read_rclone_path(&app_handle);
        if system_path.exists() {
            log::info!(
                "Falling back to system rclone at: {}",
                system_path.display()
            );
            current_path = system_path;
        } else {
            // Set updating to false before returning
            let mut engine = ENGINE
                .lock()
                .map_err(|e| format!("Failed to lock engine: {e}"))?;
            engine.updating = false;
            debug!(
                "🔍 Current rclone binary not found at: {}",
                current_path.display()
            );
            return Err(format!(
                "Current rclone binary not found at {}",
                current_path.display()
            ));
        }
    }

    // Stop the engine before updating (to release the binary)
    app_handle
        .emit(
            "rclone_engine",
            json!({
                "status": "updating",
                "message": "Updating rclone to the latest version"
            }),
        )
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // Actually stop the engine process
    {
        use crate::rclone::engine::ENGINE;
        let mut engine = ENGINE
            .lock()
            .map_err(|e| format!("Failed to lock engine: {e}"))?;
        if let Err(e) = engine.kill_process() {
            log::error!("Failed to stop engine before update: {e}");
        }
        engine.running = false;
        engine.process = None;
    }

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
            "rclone_engine",
            json!({
                "status": "updated",
                "message": "Rclone has been updated successfully"
            }),
        )
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // Set updating to false at the end (regardless of success/failure)
    {
        let mut engine = ENGINE
            .lock()
            .map_err(|e| format!("Failed to lock engine: {e}"))?;
        log::info!("Setting updating to false");
        engine.updating = false;
    }

    // If update was successful, restart engine with updated binary
    if success
        && let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
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
        )
    {
        return Err(format!("Failed to restart engine after update: {e}"));
    }

    update_result
}

// /// Get detailed update information including changelog
// #[tauri::command]
// pub async fn get_rclone_update_info(
//     state: State<'_, RcloneState>,
// ) -> Result<serde_json::Value, String> {
//     let update_check = check_rclone_update(state.clone()).await?;

//     if !update_check
//         .get("update_available")
//         .unwrap_or(&json!(false))
//         .as_bool()
//         .unwrap_or(false)
//     {
//         return Ok(update_check);
//     }

//     // Get release notes from GitHub
//     let latest_version = update_check
//         .get("latest_version")
//         .unwrap()
//         .as_str()
//         .unwrap();
//     let release_info = get_release_info(&state, latest_version).await?;

//     info!("Fetched release info for version: {}", latest_version);
//     info!("Download URL: {}", release_info.get("html_url").unwrap_or(&json!(null)));

//     Ok(json!({
//         "current_version": update_check.get("current_version"),
//         "latest_version": update_check.get("latest_version"),
//         "update_available": true,
//         "release_notes": release_info.get("body"),
//         "release_date": release_info.get("published_at"),
//         "download_url": release_info.get("html_url")
//     }))
// }

// /// Get release information from GitHub
// async fn get_release_info(
//     state: &State<'_, RcloneState>,
//     version: &str,
// ) -> Result<serde_json::Value, String> {
//     let url = format!("https://api.github.com/repos/rclone/rclone/releases/tags/{version}");

//     let response = state
//         .client
//         .get(&url)
//         .header("User-Agent", "rclone-manager")
//         .send()
//         .await
//         .map_err(|e| format!("Failed to fetch release info: {e}"))?;

//     if !response.status().is_success() {
//         return Err(format!("GitHub API returned status: {}", response.status()));
//     }

//     response
//         .json()
//         .await
//         .map_err(|e| format!("Failed to parse release info: {e}"))
// }

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
            // current_path is the binary path; pass its parent directory as the base
            if let Some(parent) = current_path.parent() {
                perform_rclone_selfupdate(app_handle, parent).await
            } else {
                Err("Failed to determine rclone base directory for in-place update".into())
            }
        }
        UpdateStrategy::CopyToLocal(local_path) => {
            log::info!("Executing copy-to-local strategy");

            // First, copy the current rclone binary into the local install directory
            copy_rclone_to_local(current_path, &local_path)?;

            // Update the app state to use the local copy
            update_rclone_path_in_state(app_handle, &local_path)?;

            // Now update the local copy (local_path is an install directory)
            perform_rclone_selfupdate(app_handle, &local_path).await
        }
        UpdateStrategy::DownloadToLocal(local_path) => {
            log::info!("Executing download-to-local strategy");

            // Download the latest rclone binary into the local install directory
            download_latest_rclone(app_handle, &local_path).await?;

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
    // Prefer any configured rclone_path in application state (if not "system" or empty)
    let rclone_state = app_handle.state::<RcloneState>();
    let configured = rclone_state.rclone_path.read().unwrap().clone();
    let configured_str = configured.to_string_lossy();

    if !configured_str.is_empty() && configured_str != "system" {
        log::info!("Using configured rclone install path from state: {configured:?}");
        return Ok(configured);
    }

    // Fallback to the app data directory (same default as provision_rclone)
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    Ok(app_data_dir)
}

/// Copy system rclone to local directory
fn copy_rclone_to_local(source_path: &Path, dest_path: &Path) -> Result<(), String> {
    log::info!("Copying rclone from {source_path:?} to install dir {dest_path:?}");

    // Use safe_copy_rclone which expects the destination directory and binary name
    let binary_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    safe_copy_rclone(source_path, dest_path, binary_name)
}

/// Update the rclone path in the application state
fn update_rclone_path_in_state(app_handle: &AppHandle, new_path: &Path) -> Result<(), String> {
    let rclone_state = app_handle.state::<RcloneState>();
    let mut path_guard = rclone_state.rclone_path.write().unwrap();
    *path_guard = new_path.to_path_buf();

    log::info!("Updated rclone path in state to: {new_path:?}");
    Ok(())
}

/// Download the latest rclone binary via rclone selfupdate
async fn download_latest_rclone(app_handle: &AppHandle, dest_dir: &Path) -> Result<(), String> {
    let binary_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let dest_file = dest_dir.join(binary_name);

    let output = build_rclone_command(app_handle, None, None, None)
        .args(["selfupdate", "--output", &dest_file.display().to_string()])
        .output()
        .map_err(|e| format!("Failed to download rclone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to download rclone: {stderr}"));
    }

    Ok(())
}

/// Perform rclone selfupdate on the specified binary
async fn perform_rclone_selfupdate(
    app_handle: &AppHandle,
    rclone_base: &Path,
) -> Result<serde_json::Value, String> {
    log::info!("Performing selfupdate on rclone in base dir: {rclone_base:?}");

    let base_str = rclone_base
        .to_str()
        .ok_or_else(|| "Failed to convert rclone base path to string".to_string())?;

    let mut update_rclone = build_rclone_command(app_handle, Some(base_str), None, None);

    update_rclone.arg("selfupdate");

    // This is a workaround for Windows to avoid showing a console window
    // when starting the Rclone process.
    // It uses the CREATE_NO_WINDOW and DETACHED_PROCESS flags.
    // But it may not work in all cases. Like when app build for terminal
    // and not for GUI. Rclone may still try to open a console window.
    // You can see the flashing of the console window when starting the app.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        update_rclone.creation_flags(0x08000000 | 0x00200000);
    }

    let output = update_rclone.output().map_err(|e| {
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
            "path": rclone_base.display().to_string()
        }))
    } else {
        log::error!("Rclone selfupdate failed: {stderr}");
        Err(format!("Rclone selfupdate failed: {stderr}"))
    }
}
