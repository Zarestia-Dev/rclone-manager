//! # Rclone Updater Module
//!
//! This module handles rclone binary updates with intelligent strategy selection:
//!
//! ## Update Strategies:
//! - **In-Place**: Updates rclone directly when write permissions allow
//! - **Download-to-Local**: Downloads to app data directory when in-place isn't possible
//!
//! ## Features:
//! - Cross-platform permission handling
//! - Channel selection (stable/beta)
//! - Settings integration for path management
//! - Engine lifecycle management during updates
//! - Comprehensive error handling and rollback

use log::{debug, info};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::check_binaries::{build_rclone_command, get_rclone_binary_path, read_rclone_path};
use crate::core::settings::operations::core::save_settings;
use crate::{rclone::queries::get_rclone_info, utils::types::all_types::RcloneState};

// ============================================================================
// Types and Constants
// ============================================================================

#[derive(Debug, Clone)]
enum UpdateStrategy {
    /// Update in place (rclone has write permissions to its own location)
    InPlace,
    /// Download new binary to local app directory
    DownloadToLocal(PathBuf),
}

#[derive(Debug)]
struct UpdateCheckResult {
    update_available: bool,
    latest_version: String,
}

// ============================================================================
// Public API Commands
// ============================================================================

/// Check if a newer version of rclone is available using rclone selfupdate --check
#[tauri::command]
pub async fn check_rclone_update(
    app_handle: tauri::AppHandle,
    state: State<'_, RcloneState>,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    // Get current version
    let current_version = match get_rclone_info(state.clone()).await {
        Ok(info) => info.version,
        Err(e) => return Err(format!("Failed to get current rclone version: {e}")),
    };

    // Use rclone selfupdate --check to determine if update is available
    let channel = channel.unwrap_or_else(|| "stable".to_string());
    let update_check_result = check_rclone_selfupdate(&app_handle, &channel).await?;

    Ok(json!({
        "current_version": current_version,
        "latest_version": update_check_result.latest_version,
        "update_available": update_check_result.update_available,
        "current_version_clean": clean_version(&current_version),
        "latest_version_clean": clean_version(&update_check_result.latest_version),
        "channel": channel
    }))
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Clean version string (remove 'v' prefix, etc.)
fn clean_version(version: &str) -> String {
    version.trim_start_matches('v').to_string()
}

/// Update rclone to the latest version with intelligent strategy selection
///
/// This function handles the complete update workflow:
/// 1. Checks if an update is available
/// 2. Stops the running rclone engine
/// 3. Determines the best update strategy (in-place vs local download)
/// 4. Executes the update
/// 5. Updates settings if needed
/// 6. Restarts the engine
#[tauri::command]
pub async fn update_rclone(
    state: State<'_, RcloneState>,
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    use crate::rclone::engine::ENGINE;

    // Step 1: Initialize update process
    {
        let mut engine = ENGINE
            .lock()
            .map_err(|e| format!("Failed to lock engine: {e}"))?;
        engine.updating = true;
        debug!("🔍 Starting rclone update process");
    }

    // Step 2: Check if update is available
    let update_check = check_rclone_update(app_handle.clone(), state, channel.clone()).await?;
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
            execute_update_strategy(strategy, &app_handle, channel.clone()).await
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

// ============================================================================
// Update Strategy Logic
// ============================================================================

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

    // Always download to local directory since rclone selfupdate --output handles this directly
    log::info!("Will download rclone to local directory: {local_rclone_path:?}");
    Ok(UpdateStrategy::DownloadToLocal(local_rclone_path))
}

/// Execute the determined update strategy
async fn execute_update_strategy(
    strategy: UpdateStrategy,
    app_handle: &AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    match strategy {
        UpdateStrategy::InPlace => {
            info!("Executing in-place update");
            perform_rclone_selfupdate(app_handle, None, channel).await
        }

        UpdateStrategy::DownloadToLocal(local_path) => {
            info!("Executing download-to-local strategy to: {local_path:?}");

            // Determine binary name based on platform
            let binary_name = if cfg!(windows) {
                "rclone.exe"
            } else {
                "rclone"
            };
            let dest_file = local_path.join(binary_name);

            // Download rclone to local directory
            let result = perform_rclone_selfupdate(app_handle, Some(&dest_file), channel).await?;

            // Update settings to point to new local installation
            update_rclone_path_in_settings(app_handle, &local_path).await;

            Ok(result)
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

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

/// Update the rclone path in application settings
async fn update_rclone_path_in_settings(app_handle: &AppHandle, new_path: &Path) {
    let settings_update = json!({
        "core": {
            "rclone_path": new_path.display().to_string()
        }
    });

    match save_settings(app_handle.state(), settings_update, app_handle.clone()).await {
        Ok(_) => info!("Updated rclone path in settings to: {new_path:?}"),
        Err(e) => {
            log::error!("Failed to save rclone path to settings: {e}");
            // Don't fail the update process for settings save errors
        }
    }
}

// ============================================================================
// Core Update Logic
// ============================================================================

/// Check for rclone updates using selfupdate --check
async fn check_rclone_selfupdate(
    app_handle: &AppHandle,
    channel: &str,
) -> Result<UpdateCheckResult, String> {
    let output = build_rclone_command(app_handle, None, None, None)
        .arg("selfupdate")
        .arg("--check")
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone selfupdate --check: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(format!("rclone selfupdate --check failed: {}", stderr));
    }

    // Parse the output
    // Example output:
    // yours:  1.71.1
    // latest: 1.71.1                                   (released 2025-09-24)
    // beta:   1.72.0-beta.9155.2bc155a96               (released 2025-10-05)
    //   upgrade: https://beta.rclone.org/v1.72.0-beta.9155.2bc155a96

    let mut current_version = String::new();
    let mut latest_stable = String::new();
    let mut latest_beta = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("yours:") {
            current_version = line.split_whitespace().nth(1).unwrap_or("").to_string();
        } else if line.starts_with("latest:") {
            latest_stable = line.split_whitespace().nth(1).unwrap_or("").to_string();
        } else if line.starts_with("beta:") {
            latest_beta = line.split_whitespace().nth(1).unwrap_or("").to_string();
        }
    }

    // Determine which version to use based on channel
    let target_version = match channel {
        "beta" => {
            if !latest_beta.is_empty() {
                latest_beta
            } else {
                latest_stable // fallback to stable if no beta available
            }
        }
        _ => latest_stable, // "stable" or any other value
    };

    if target_version.is_empty() {
        return Err(
            "Could not parse version information from rclone selfupdate --check".to_string(),
        );
    }

    // Check if update is available by comparing current with target
    let update_available = !current_version.is_empty()
        && !target_version.is_empty()
        && current_version != target_version;

    Ok(UpdateCheckResult {
        update_available,
        latest_version: target_version,
    })
}

/// Perform rclone selfupdate with optional output path
async fn perform_rclone_selfupdate(
    app_handle: &AppHandle,
    output_path: Option<&Path>,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut cmd = build_rclone_command(app_handle, None, None, None);
    cmd = cmd.arg("selfupdate");

    // Configure output destination
    if let Some(output) = output_path {
        cmd = cmd.args(["--output", &output.display().to_string()]);
        info!("Updating rclone with output to: {output:?}");
    } else {
        info!("Updating rclone in place");
    }

    // Configure update channel
    let channel_name = match channel.as_deref() {
        Some("beta") => {
            cmd = cmd.arg("--beta");
            "beta"
        }
        Some("stable") | None => {
            cmd = cmd.arg("--stable");
            "stable"
        }
        Some(other) => {
            return Err(format!("Unsupported update channel: {other}"));
        }
    };

    info!("Using {channel_name} channel");

    debug!("Executing rclone selfupdate");

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone selfupdate: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        info!("Rclone selfupdate completed successfully");
        debug!("Update output: {stdout}");
        if !stderr.is_empty() {
            debug!("Update stderr: {stderr}");
        }

        app_handle
            .emit("rclone-engine", json!({"status": "updated"}))
            .map_err(|e| format!("Failed to emit update event: {e}"))?;

        Ok(json!({
            "success": true,
            "message": "Rclone updated successfully",
            "output": stdout.trim(),
            "channel": channel_name
        }))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Rclone selfupdate failed: {stderr}"))
    }
}
