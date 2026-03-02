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
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::{build_rclone_command, get_rclone_binary_path, read_rclone_path};
use crate::core::settings::operations::core::save_setting;
use crate::rclone::queries::get_rclone_info;
use crate::utils::app::notification::{Notification, send_notification_typed};
use crate::utils::github_client;
use crate::utils::types::core::EngineState;
use crate::utils::types::events::RCLONE_ENGINE_UPDATING;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;

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

#[derive(Debug, serde::Serialize, serde::Deserialize)]
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
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    // Get current version
    let current_version = match get_rclone_info(app_handle.clone()).await {
        Ok(info) => info.version,
        Err(e) => {
            return Err(
                crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => e),
            );
        }
    };

    // Use rclone selfupdate --check
    let channel = channel.unwrap_or_else(|| "stable".to_string());
    let result = check_rclone_selfupdate(&app_handle, &channel)
        .await
        .map_err(|e| e.to_string())?;

    // Fetch release notes if available
    let (release_notes, release_date, release_url) = if result.update_available {
        fetch_rclone_release_info(&result.latest_version, &channel)
            .await
            .unwrap_or_default()
    } else {
        Default::default()
    };

    // Construct the result
    let result_json = json!({
        "current_version": current_version,
        "latest_version": result.latest_version,
        "update_available": result.update_available,
        "current_version_clean": clean_version(&current_version),
        "latest_version_clean": clean_version(&result.latest_version),
        "channel": channel,
        "release_notes": release_notes,
        "release_date": release_date,
        "release_url": release_url
    });

    if result.update_available {
        // Save to managed state
        use crate::utils::types::updater::RcloneUpdaterState;
        let updater_state = app_handle.state::<RcloneUpdaterState>();
        if let Ok(mut pending) = updater_state.pending_version.lock() {
            *pending = Some(result.latest_version.clone());
        }

        // Emit event to frontend
        if let Err(e) = app_handle.emit(
            crate::utils::types::events::APP_EVENT,
            serde_json::json!({ "status": "rclone_update_found", "data": result_json }),
        ) {
            log::warn!("Failed to emit rclone update event: {}", e);
        }

        send_notification_typed(
            &app_handle,
            Notification::localized(
                "notification.title.rcloneUpdateFound",
                "notification.body.rcloneUpdateFound",
                Some(vec![("version", result.latest_version.as_str())]),
                None,
                Some(LogLevel::Info),
            ),
            Some(Origin::System),
        );
    }

    Ok(result_json)
}

/// Retrieve the latest update metadata that was previously cached
#[tauri::command]
pub async fn get_rclone_update_info(
    app_handle: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    use crate::utils::types::updater::RcloneUpdaterState;
    let base_path = read_rclone_path(&app_handle);
    let binary_path = get_rclone_binary_path(&base_path);
    let new_path = PathBuf::from(format!("{}.new", binary_path.display()));

    if new_path.exists() {
        return Ok(Some(
            json!({ "update_available": true, "ready_to_restart": true }),
        ));
    }

    let updater_state = app_handle.state::<RcloneUpdaterState>();
    if let Ok(pending_version) = updater_state.pending_version.lock()
        && let Some(version) = &*pending_version
    {
        return Ok(Some(
            json!({ "update_available": true, "latest_version": version, "ready_to_restart": false }),
        ));
    }
    Ok(None)
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
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    set_engine_updating(&app_handle, true).await;
    debug!("🔍 Starting rclone update process");

    // Check availability
    let update_check = check_rclone_update(app_handle.clone(), channel.clone()).await?;
    let update_available = update_check
        .get("update_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !update_available {
        set_engine_updating(&app_handle, false).await;
        return Ok(json!({
            "success": false,
            "message": "No update available",
            "current_version": update_check.get("current_version")
        }));
    }

    let latest_version = update_check
        .get("latest_version")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    // Notify update found
    let _ = app_handle.emit(
        crate::utils::types::events::APP_EVENT,
        serde_json::json!({ "status": "rclone_update_found", "data": update_check }),
    );

    send_notification_typed(
        &app_handle,
        Notification::localized(
            "notification.title.rcloneUpdateFound",
            "notification.body.rcloneUpdateFound",
            Some(vec![("version", latest_version)]),
            None,
            Some(LogLevel::Info),
        ),
        Some(Origin::System),
    );

    // Resolve binary path
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let base_path: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("system"));
    let mut current_path = get_rclone_binary_path(&base_path);

    if !current_path.exists() {
        // Fallback to system rclone
        let system_path = read_rclone_path(&app_handle);
        if system_path.exists() {
            current_path = system_path;
        } else {
            set_engine_updating(&app_handle, false).await;
            return Err(crate::localized_error!(
                "backendErrors.rclone.binaryNotFound"
            ));
        }
    }

    // Wait, do NOT stop the engine yet. Just emit updating event for the UI status.
    app_handle
        .emit(RCLONE_ENGINE_UPDATING, ())
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    send_notification_typed(
        &app_handle,
        Notification::localized(
            "notification.title.rcloneUpdateStarted",
            "notification.body.rcloneUpdateStarted",
            Some(vec![("version", latest_version)]),
            None,
            Some(LogLevel::Info),
        ),
        Some(Origin::System),
    );

    // Execute update to .new
    let update_result = match determine_update_strategy(&current_path, &app_handle).await {
        Ok(strategy) => {
            execute_update_strategy(strategy, &app_handle, channel.clone(), &current_path).await
        }
        Err(e) => Err(e),
    };

    set_engine_updating(&app_handle, false).await;

    // Handle result
    match &update_result {
        Ok(res) if res["success"].as_bool().unwrap_or(false) => {
            send_notification_typed(
                &app_handle,
                Notification::localized(
                    "notification.title.rcloneUpdateComplete",
                    "notification.body.rcloneUpdateComplete",
                    Some(vec![("version", latest_version)]),
                    None,
                    Some(LogLevel::Info),
                ),
                Some(Origin::System),
            );

            // DO NOT Restart engine immediately. Update RcloneUpdaterState
            use crate::utils::types::updater::RcloneUpdaterState;
            let updater_state = app_handle.state::<RcloneUpdaterState>();
            if let Ok(mut pending) = updater_state.pending_version.lock() {
                *pending = Some(latest_version.to_string());
            }
        }
        _ => {
            // Extract error message
            let error_msg = if let Ok(res) = &update_result {
                res["message"]
                    .as_str()
                    .unwrap_or("Unknown error")
                    .to_string()
            } else {
                update_result.as_ref().unwrap_err().clone()
            };

            send_notification_typed(
                &app_handle,
                Notification::localized(
                    "notification.title.rcloneUpdateFailed",
                    "notification.body.rcloneUpdateFailed",
                    Some(vec![("error", error_msg.as_str())]),
                    None,
                    Some(LogLevel::Error),
                ),
                Some(Origin::System),
            );
        }
    }

    update_result
}

/// Apply a previously downloaded rclone update (.new) and restart the engine.
/// This fulfills the ReadyToRestart phase without killing the application midway.
#[tauri::command]
pub async fn apply_rclone_update(app_handle: tauri::AppHandle) -> Result<(), String> {
    activate_pending_rclone_update(&app_handle).await?;

    // 5. Restart engine with the new binary
    let pending_version = {
        let state = app_handle.state::<crate::utils::types::updater::RcloneUpdaterState>();
        let mut pending = state
            .pending_version
            .lock()
            .map_err(|e| format!("Failed to lock pending rclone version: {e}"))?;
        pending.take().unwrap_or_else(|| "unknown".to_string())
    };

    if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
        &app_handle,
        "rclone_update",
        "unknown",
        &pending_version,
    ) {
        return Err(format!("Binary swapped but engine restart failed: {}", e));
    }

    Ok(())
}

/// Swaps the pending .new binary with the active one.
/// Does NOT restart the engine.
pub async fn activate_pending_rclone_update(app_handle: &AppHandle) -> Result<(), String> {
    use std::fs;

    debug!("🚀 Activating rclone update (swapping binaries)");

    // 1. Resolve current path
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let base_path: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("system"));
    let mut current_path = get_rclone_binary_path(&base_path);

    if !current_path.exists() {
        let system_path = read_rclone_path(app_handle);
        if system_path.exists() {
            current_path = system_path;
        } else {
            return Err(crate::localized_error!(
                "backendErrors.rclone.binaryNotFound"
            ));
        }
    }

    // Determine strategy previously used to find the .new file
    let new_path = match determine_update_strategy(&current_path, app_handle).await? {
        UpdateStrategy::InPlace => PathBuf::from(format!("{}.new", current_path.display())),
        UpdateStrategy::DownloadToLocal(local_path) => {
            let binary_name = if cfg!(windows) {
                "rclone.exe"
            } else {
                "rclone"
            };
            PathBuf::from(format!("{}.new", local_path.join(binary_name).display()))
        }
    };

    if !new_path.exists() {
        // Reset state so user can download again since it was deleted
        use crate::utils::types::updater::RcloneUpdaterState;
        let updater_state = app_handle.state::<RcloneUpdaterState>();
        if let Ok(mut pending) = updater_state.pending_version.lock() {
            *pending = None;
        }
        return Err(
            "The downloaded .new binary was missing or deleted. Please check for updates again."
                .into(),
        );
    }

    // 2. Shut down existing engine so the binary is unlocked (Windows mainly)
    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        engine.set_updating(true); // Signal we are in a critical update phase
        let _ = engine.kill_process(app_handle).await;
    }

    // 3. Swap the binaries
    let old_path = PathBuf::from(format!("{}.old", current_path.display()));

    let swap_result: Result<(), String> = (|| {
        // Try to remove old backup if it exists
        let _ = fs::remove_file(&old_path);

        // Rename current -> old
        if let Err(e) = fs::rename(&current_path, &old_path) {
            log::error!("Failed to backup current rclone binary: {}", e);
            return Err(format!("Failed to backup current rclone binary: {}", e));
        }

        // Rename new -> current
        if let Err(e) = fs::rename(&new_path, &current_path) {
            log::error!("Failed to promote .new binary: {}", e);
            // Rollback
            if let Err(rollback_err) = fs::rename(&old_path, &current_path) {
                log::error!(
                    "CRITICAL: Rollback failed! Original: {}, Rollback: {}",
                    e,
                    rollback_err
                );
                return Err(format!(
                    "CRITICAL: Promoted binary failed, and restoring backup failed. Rclone is broken. {}",
                    rollback_err
                ));
            }
            return Err(format!(
                "Failed to activate new binary, rollback successful: {}",
                e
            ));
        }

        Ok(())
    })();

    // Always clear updating state before returning
    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        engine.set_updating(false);
    }

    swap_result?;

    info!("✅ Binary successfully swapped from .new -> active");

    // 4. Update memory state
    {
        use crate::utils::types::updater::RcloneUpdaterState;
        let updater_state = app_handle.state::<RcloneUpdaterState>();
        if let Ok(mut pending) = updater_state.pending_version.lock() {
            *pending = None;
        }
    }

    Ok(())
}

// ============================================================================
// Update Strategy Logic
// ============================================================================

/// Determine the best update strategy based on current rclone path and permissions
async fn determine_update_strategy(
    current_path: &Path,
    app_handle: &AppHandle,
) -> Result<UpdateStrategy, String> {
    // Check if we can write to the current rclone location
    if current_path.parent().is_some_and(is_writable_dir) {
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
    current_path: &Path,
) -> Result<serde_json::Value, String> {
    match strategy {
        UpdateStrategy::InPlace => {
            // Output to current_path + .new
            let new_path_str = format!("{}.new", current_path.display());
            let new_path = PathBuf::from(new_path_str);
            info!("Executing in-place update to: {:?}", new_path);
            perform_rclone_selfupdate(app_handle, Some(&new_path), channel).await
        }

        UpdateStrategy::DownloadToLocal(local_path) => {
            let binary_name = if cfg!(windows) {
                "rclone.exe"
            } else {
                "rclone"
            };
            let new_path_str = format!("{}.new", local_path.join(binary_name).display());
            let dest_file = PathBuf::from(new_path_str);

            info!("Executing download-to-local strategy to: {:?}", dest_file);
            let result = perform_rclone_selfupdate(app_handle, Some(&dest_file), channel).await?;

            // Update settings to point to new local installation (the real one, not .new)
            update_rclone_path_in_settings(app_handle, &local_path).await;

            Ok(result)
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Helper to set engine updating state
async fn set_engine_updating(app_handle: &AppHandle, updating: bool) {
    app_handle
        .state::<EngineState>()
        .lock()
        .await
        .set_updating(updating);
}

/// Check if a directory is writable by attempting to create a test file
fn is_writable_dir(path: &Path) -> bool {
    let test_file = path.join(".rclone_manager_write_test");
    if std::fs::write(&test_file, "test").is_ok() {
        let _ = std::fs::remove_file(&test_file);
        true
    } else {
        false
    }
}

/// Get the local rclone path in the app's data directory
fn get_local_rclone_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    // Prefer any configured rclone_path in settings (if not "system" or empty)
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let configured: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_default();
    let configured_str = configured.to_string_lossy();

    if !matches!(configured_str.as_ref(), "" | "system") {
        if is_writable_dir(&configured) {
            log::info!("Using configured rclone install path from settings: {configured:?}");
            return Ok(configured);
        }
        log::warn!("Configured path {configured:?} is not writable, falling back to app data dir");
    }

    // Fallback to the app's config directory (same default as provision_rclone)
    Ok(crate::core::paths::AppPaths::from_app_handle(app_handle)?.config_dir)
}

/// Update the rclone path in application settings
async fn update_rclone_path_in_settings(app_handle: &AppHandle, new_path: &Path) {
    // Note: In-memory caching is no longer used - we read from AppSettingsManager which caches internally
    // Persist to settings store
    match save_setting(
        "core".to_string(),
        "rclone_path".to_string(),
        serde_json::json!(new_path.display().to_string()),
        app_handle.state(),
        app_handle.clone(),
    )
    .await
    {
        Ok(_) => info!("Updated rclone path in settings to: {:?}", new_path),
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
        .map_err(
            |e: std::io::Error| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
        )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(
            crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => stderr),
        );
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
            crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => "Parse error"),
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

/// Fetch release notes from Rclone's GitHub repository.
async fn fetch_rclone_release_info(
    version: &str,
    channel: &str,
) -> Result<(Option<String>, Option<String>, Option<String>), github_client::Error> {
    let version_clean = clean_version(version);
    let tag = format!("v{version_clean}");

    // Fetch release metadata from GitHub
    // This will provide the release notes body for both stable and beta
    match github_client::get_release_by_tag("rclone", "rclone", &tag).await {
        Ok(release) => {
            // Beta releases are not published on GitHub, but their tags might exist.
            // Rclone's `selfupdate --check` gets beta info from beta.rclone.org,
            // but the release notes are often just in the tag body on GitHub.
            if channel == "beta" {
                return Ok((release.body, release.published_at, Some(release.html_url)));
            }

            // For stable releases, try to get the detailed changelog.md
            match fetch_stable_changelog(version, &release.published_at, &release.html_url).await {
                Ok(changelog) => Ok((
                    Some(changelog),
                    release.published_at,
                    Some(release.html_url),
                )),
                Err(e) => {
                    log::warn!(
                        "Failed to fetch stable changelog, falling back to release body: {e}"
                    );
                    // Fallback to the release body if changelog.md fails
                    Ok((release.body, release.published_at, Some(release.html_url)))
                }
            }
        }
        Err(e) => {
            log::warn!("Failed to fetch GitHub release by tag {}: {}", tag, e);
            // Can't get any info, return None
            Ok((None, None, None))
        }
    }
}

/// Fetch changelog for stable releases from changelog.md
async fn fetch_stable_changelog(
    version: &str,
    release_date: &Option<String>,
    release_url: &str,
) -> Result<String, github_client::Error> {
    let version_clean = clean_version(version);
    let tag = format!("v{version_clean}");
    let path = "docs/content/changelog.md";

    // Try to fetch and parse changelog
    match github_client::get_raw_file_content("rclone", "rclone", &tag, path).await {
        Ok(content) => {
            let changelog = extract_version_changelog(&content, version).unwrap_or_else(|| {
                log::warn!("Could not parse changelog.md, falling back to release URL.");
                format!(
                    "## Rclone {}\n\n[View full changelog]({})",
                    version, release_url
                )
            });
            Ok(changelog)
        }
        Err(e) => {
            log::debug!("Failed to fetch changelog.md: status {}", e);
            // Fallback message
            Ok(format!(
                "## Rclone {}\n\nReleased: {}\n\n[View full changelog]({})",
                version,
                release_date.as_deref().unwrap_or("N/A"),
                release_url
            ))
        }
    }
}

/// Extract changelog section for a specific version from changelog.md
fn extract_version_changelog(changelog: &str, version: &str) -> Option<String> {
    let version_clean = clean_version(version);
    let header = format!("## v{}", version_clean);

    let start = changelog.find(&header)?;
    let after_header = &changelog[start..];

    // Find next version header or use rest of file
    let end = after_header[header.len()..]
        .find("\n## ")
        .map(|i| header.len() + i)
        .unwrap_or(after_header.len());

    Some(after_header[..end].trim().to_string())
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
            return Err(
                crate::localized_error!("backendErrors.rclone.unsupportedChannel", "channel" => other),
            );
        }
    };

    info!("Using {channel_name} channel");

    debug!("Executing rclone selfupdate");

    let output = cmd.output().await.map_err(
        |e: std::io::Error| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
    )?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        info!("Rclone selfupdate completed successfully");
        debug!("Update output: {stdout}");
        if !stderr.is_empty() {
            debug!("Update stderr: {stderr}");
        }

        // Note: Update completion is signaled by ENGINE_RESTARTED event

        Ok(json!({
            "success": true,
            "message": "Rclone updated successfully",
            "output": stdout.trim(),
            "channel": channel_name
        }))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Tests for clean_version()
    // -------------------------------------------------------------------------

    #[test]
    fn test_clean_version_removes_v_prefix() {
        assert_eq!(clean_version("v1.71.1"), "1.71.1");
    }

    #[test]
    fn test_clean_version_no_prefix() {
        assert_eq!(clean_version("1.71.1"), "1.71.1");
    }

    #[test]
    fn test_clean_version_beta() {
        assert_eq!(
            clean_version("v1.72.0-beta.9155.2bc155a96"),
            "1.72.0-beta.9155.2bc155a96"
        );
    }

    // -------------------------------------------------------------------------
    // Tests for extract_version_changelog()
    // -------------------------------------------------------------------------

    #[test]
    fn test_extract_version_changelog_finds_section() {
        let changelog = r#"
## v1.71.1 - 2025-09-24

Bug fixes and improvements.

## v1.71.0 - 2025-08-01

Major release notes here.
"#;
        let result = extract_version_changelog(changelog, "v1.71.1");
        assert!(result.is_some());
        let section = result.unwrap();
        assert!(section.contains("v1.71.1"));
        assert!(section.contains("Bug fixes"));
        // Should NOT include v1.71.0 section
        assert!(!section.contains("v1.71.0"));
    }

    #[test]
    fn test_extract_version_changelog_not_found() {
        let changelog = "## v1.70.0 - Old version\n\nOld notes.";
        let result = extract_version_changelog(changelog, "v1.71.1");
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_version_changelog_last_section() {
        let changelog = r#"
## v1.71.1 - 2025-09-24

This is the last section with no following header.
"#;
        let result = extract_version_changelog(changelog, "v1.71.1");
        assert!(result.is_some());
        assert!(result.unwrap().contains("last section"));
    }

    #[test]
    fn test_is_writable_dir() {
        let temp_dir = std::env::temp_dir().join("rclone_manager_test_writable");
        std::fs::create_dir_all(&temp_dir).unwrap();
        assert!(is_writable_dir(&temp_dir));
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
