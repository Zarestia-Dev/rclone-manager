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
use crate::core::paths::get_app_paths;
use crate::core::settings::operations::core::save_setting;
use crate::utils::github_client;
use crate::{
    rclone::queries::get_rclone_info,
    utils::types::{all_types::RcloneState, events::RCLONE_ENGINE_UPDATING},
};

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
        Err(e) => {
            return Err(
                crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => e),
            );
        }
    };

    // Use rclone selfupdate --check to determine if update is available
    let channel = channel.unwrap_or_else(|| "stable".to_string());
    let update_check_result = check_rclone_selfupdate(&app_handle, &channel)
        .await
        .map_err(|e| e.to_string())?;

    // Fetch release notes from GitHub if update is available
    let (release_notes, release_date, release_url) = if update_check_result.update_available {
        fetch_rclone_release_info(&update_check_result.latest_version, &channel)
            .await
            .map_err(|e| e.to_string())?
    } else {
        (None, None, None)
    };

    Ok(json!({
        "current_version": current_version,
        "latest_version": update_check_result.latest_version,
        "update_available": update_check_result.update_available,
        "current_version_clean": clean_version(&current_version),
        "latest_version_clean": clean_version(&update_check_result.latest_version),
        "channel": channel,
        "release_notes": release_notes,
        "release_date": release_date,
        "release_url": release_url
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
    // Step 1: Initialize update process
    // Step 1: Initialize update process
    {
        use crate::utils::types::core::EngineState;
        let engine_state = app_handle.state::<EngineState>();
        engine_state.lock().await.set_updating(true);
    }
    debug!("🔍 Starting rclone update process");

    // Step 2: Check if update is available
    let update_check = check_rclone_update(app_handle.clone(), state, channel.clone()).await?;
    let update_available = update_check
        .get("update_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !update_available {
        // Set updating to false before returning
        {
            use crate::utils::types::core::EngineState;
            app_handle
                .state::<EngineState>()
                .lock()
                .await
                .set_updating(false);
        }
        debug!("🔍 No update available for rclone");
        return Ok(json!({
            "success": false,
            "message": "No update available",
            "current_version": update_check.get("current_version")
        }));
    }

    // Get current rclone path from settings and resolve the actual binary path
    let manager = app_handle.state::<rcman::JsonSettingsManager>();
    let base_path: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("system"));
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
            {
                use crate::utils::types::core::EngineState;
                app_handle
                    .state::<EngineState>()
                    .lock()
                    .await
                    .set_updating(false);
            }
            debug!(
                "🔍 Current rclone binary not found at: {}",
                current_path.display()
            );
            return Err(crate::localized_error!(
                "backendErrors.rclone.binaryNotFound"
            ));
        }
    }

    // Stop the engine before updating (to release the binary)
    app_handle
        .emit(RCLONE_ENGINE_UPDATING, ())
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    // Actually stop the engine process
    {
        use crate::utils::types::core::EngineState;
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        if let Err(e) = engine.kill_process().await {
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

    // Note: Completion is signaled by ENGINE_RESTARTED event with reason 'rclone_update'

    // Set updating to false at the end (regardless of success/failure)
    // Set updating to false at the end (regardless of success/failure)
    log::info!("Setting updating to false");
    {
        use crate::utils::types::core::EngineState;
        app_handle
            .state::<EngineState>()
            .lock()
            .await
            .set_updating(false);
    }

    // If update was successful, restart engine with updated binary
    if success
        && let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
            &app_handle,
            "rclone_update",
            update_check
                .get("current_version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
            update_check
                .get("latest_version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
        )
    {
        return Err(crate::localized_error!("backendErrors.rclone.restartFailed", "error" => e));
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
    // Prefer any configured rclone_path in settings (if not "system" or empty)
    let manager = app_handle.state::<rcman::JsonSettingsManager>();
    let configured: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_default();
    let configured_str = configured.to_string_lossy();

    if !configured_str.is_empty() && configured_str != "system" {
        log::info!("Using configured rclone install path from settings: {configured:?}");
        return Ok(configured);
    }

    // Fallback to the app's config directory (same default as provision_rclone)
    Ok(get_app_paths(app_handle)?.config_dir)
}

/// Update the rclone path in application settings
async fn update_rclone_path_in_settings(app_handle: &AppHandle, new_path: &Path) {
    // Note: In-memory caching is no longer used - we read from JsonSettingsManager which caches internally
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
            |e| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
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
        |e| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
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
}
