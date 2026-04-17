//! # Rclone Updater Module
//!
//! Handles rclone binary updates with intelligent strategy selection:
//!
//! - **In-Place**: Updates rclone directly when write permissions allow
//! - **Download-to-Local**: Downloads to app data directory when in-place isn't possible

use log::{debug, info};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::{get_rclone_binary_path, read_rclone_path};
use crate::core::settings::operations::core::save_setting;
use crate::rclone::backend::BackendManager;
use crate::rclone::queries::get_rclone_info;
use crate::utils::app::notification::{NotificationEvent, notify};
use crate::utils::github_client;
use crate::utils::rclone::endpoints::{core, operations};
use crate::utils::types::core::EngineState;
use crate::utils::types::core::RcloneState;
use crate::utils::types::events::RCLONE_ENGINE_UPDATING;
use crate::utils::types::updater::RcloneUpdateMetadata;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Default)]
enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    fn as_str(&self) -> &'static str {
        match self {
            UpdateChannel::Stable => "stable",
            UpdateChannel::Beta => "beta",
        }
    }
}

impl From<Option<String>> for UpdateChannel {
    fn from(opt: Option<String>) -> Self {
        match opt.as_deref() {
            Some("beta") => UpdateChannel::Beta,
            _ => UpdateChannel::Stable,
        }
    }
}

#[derive(Debug, Clone)]
enum UpdateStrategy {
    /// Update in place; the path is the exact binary file to be written.
    InPlace(PathBuf),
    /// Download to this full file path (directory + binary name).
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

#[tauri::command]
pub async fn check_rclone_update(
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<RcloneUpdateMetadata, String> {
    let current_version = get_rclone_info(app_handle.clone())
        .await
        .map(|info| info.version)
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.versionCheckFailed", "error" => e),
        )?;

    let channel: UpdateChannel = channel.into();
    let result = check_rclone_selfupdate(&app_handle, &channel)
        .await
        .map_err(|e| e.to_string())?;

    let (release_notes, release_date, release_url) = if result.update_available {
        fetch_rclone_release_info(&result.latest_version, &channel)
            .await
            .unwrap_or((None, None, None))
    } else {
        (None, None, None)
    };

    let result_meta = RcloneUpdateMetadata {
        current_version: current_version.clone(),
        latest_version: result.latest_version.clone(),
        update_available: result.update_available,
        current_version_clean: clean_version(&current_version),
        latest_version_clean: clean_version(&result.latest_version),
        channel: channel.as_str().to_string(),
        release_notes,
        release_date,
        release_url,
        update_in_progress: false,
        ready_to_restart: false,
    };

    if result.update_available {
        use crate::utils::types::updater::RcloneUpdaterState;
        if let Ok(mut pending) = app_handle
            .state::<RcloneUpdaterState>()
            .pending_update
            .lock()
        {
            *pending = Some(result_meta.clone());
        }

        if let Err(e) = app_handle.emit(
            crate::utils::types::events::APP_EVENT,
            json!({ "status": "rclone_update_found", "data": result_meta }),
        ) {
            log::warn!("Failed to emit rclone update event: {}", e);
        }

        notify(
            &app_handle,
            NotificationEvent::RcloneUpdateAvailable {
                version: result.latest_version.clone(),
            },
        );
    }

    Ok(result_meta)
}

#[tauri::command]
pub async fn get_rclone_update_info(
    app_handle: tauri::AppHandle,
) -> Result<Option<RcloneUpdateMetadata>, String> {
    use crate::utils::types::updater::RcloneUpdaterState;

    // Check the same candidate paths that activate_pending_rclone_update uses.
    let has_pending_new = find_pending_new_binary(&app_handle).is_some();

    let updater_state = app_handle.state::<RcloneUpdaterState>();
    if let Ok(pending) = updater_state.pending_update.lock()
        && let Some(meta) = &*pending
    {
        let mut meta = meta.clone();
        if has_pending_new {
            meta.ready_to_restart = true;
            meta.update_available = false; // It's already downloaded
        }
        return Ok(Some(meta));
    }

    if has_pending_new {
        // If we have a pending binary but no metadata (lost state),
        // we return a minimal meta object.
        return Ok(Some(RcloneUpdateMetadata {
            current_version: "unknown".to_string(),
            latest_version: "unknown".to_string(),
            update_available: false,
            current_version_clean: "unknown".to_string(),
            latest_version_clean: "unknown".to_string(),
            channel: "stable".to_string(),
            release_notes: None,
            release_date: None,
            release_url: None,
            update_in_progress: false,
            ready_to_restart: true,
        }));
    }

    Ok(None)
}

/// Returns the (active, .new) path pair for the first candidate that has a
/// staged `.new` binary, or `None` if no pending binary exists.
///
/// Mirrors the candidate resolution logic in `activate_pending_rclone_update`
/// so that both functions always agree on where the binary is.
fn find_pending_new_binary(app_handle: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let configured_base: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("system"));

    let current_runtime = read_rclone_path(app_handle);
    let bin_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let local_target = get_local_rclone_path(app_handle).ok()?.join(bin_name);

    let configured_target = (!matches!(configured_base.to_string_lossy().as_ref(), "" | "system"))
        .then(|| get_rclone_binary_path(&configured_base));

    configured_target
        .into_iter()
        .chain([current_runtime, local_target])
        .map(|p| {
            let new = PathBuf::from(format!("{}.new", p.display()));
            (p, new)
        })
        .find(|(_, new)| new.exists())
}

#[tauri::command]
pub async fn update_rclone(
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔍 Starting rclone download/update process");

    let channel: UpdateChannel = channel.into();
    let update_check =
        check_rclone_update(app_handle.clone(), Some(channel.as_str().to_string())).await?;

    let update_available = update_check.update_available;

    if !update_available {
        return Ok(json!({
            "success": false,
            "message": "No update available",
            "current_version": update_check.current_version
        }));
    }

    let latest_version = &update_check.latest_version;

    // --- Remote backend: update in-place, no staging ---
    // On a remote instance we cannot pass a local --output path — the remote
    // process would try to write to that path on the *remote* server's
    // filesystem. Instead, run selfupdate with no output arg so rclone
    // replaces its own binary, then quit so it restarts with the new build.
    {
        let backend_manager = app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        if !backend.is_local {
            notify(
                &app_handle,
                NotificationEvent::RcloneUpdateStarted {
                    version: latest_version.to_string(),
                },
            );

            // No --output: remote rclone updates its own binary in place.
            let channel_str = channel.as_str().to_string();
            let result = perform_rclone_selfupdate(&app_handle, None, channel).await;

            return match result {
                Ok(_) => {
                    notify(
                        &app_handle,
                        NotificationEvent::RcloneUpdateComplete {
                            version: latest_version.to_string(),
                        },
                    );

                    // Gracefully quit the remote process so it restarts with the new binary.
                    let client = &app_handle.state::<RcloneState>().client;
                    let backend_manager = app_handle.state::<BackendManager>();
                    let backend = backend_manager.get_active().await;
                    let _ = backend.post_json(client, core::QUIT, None).await;

                    Ok(json!({
                        "success": true,
                        "immediate": true,
                        "message": "Remote rclone updated and restarted",
                        "channel": channel_str
                    }))
                }
                Err(e) => {
                    notify(
                        &app_handle,
                        NotificationEvent::RcloneUpdateFailed { error: e.clone() },
                    );
                    Err(e)
                }
            };
        }
    }

    // --- Local backend: staged update (.new file + explicit activation) ---

    let latest_version = &update_check.latest_version;

    // Resolve binary path, falling back to system rclone
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let base_path: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("system"));
    let mut current_path = get_rclone_binary_path(&base_path);

    if !current_path.exists() {
        let system_path = read_rclone_path(&app_handle);
        if system_path.exists() {
            current_path = system_path;
        } else {
            return Err(crate::localized_error!(
                "backendErrors.rclone.binaryNotFound"
            ));
        }
    }

    app_handle
        .emit(RCLONE_ENGINE_UPDATING, ())
        .map_err(|e| format!("Failed to emit update event: {e}"))?;

    notify(
        &app_handle,
        NotificationEvent::RcloneUpdateStarted {
            version: latest_version.to_string(),
        },
    );

    let update_result = match determine_update_strategy(&current_path, &app_handle).await {
        Ok(strategy) => execute_update_strategy(strategy, &app_handle, channel).await,
        Err(e) => Err(e),
    };

    if let Ok(res) = &update_result {
        if res["success"].as_bool().unwrap_or(false) {
            notify(
                &app_handle,
                NotificationEvent::RcloneUpdateComplete {
                    version: latest_version.to_string(),
                },
            );
            // The pending_update state is already filled by `check_rclone_update` above;
            // the actual binary swap will occur when the frontend calls `apply_rclone_update`.
        }
    } else if let Err(error_msg) = &update_result {
        notify(
            &app_handle,
            NotificationEvent::RcloneUpdateFailed {
                error: error_msg.clone(),
            },
        );
    }

    update_result
}

/// Apply a previously downloaded rclone update and restart the engine.
#[tauri::command]
pub async fn apply_rclone_update(app_handle: tauri::AppHandle) -> Result<(), String> {
    debug!("🎯 Applying previously downloaded rclone update");

    // Same restriction as update_rclone: the binary swap operates on local
    // filesystem paths and must not be attempted via a remote RC instance.
    {
        let backend_manager = app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        if !backend.is_local {
            return Err(crate::localized_error!(
                "backendErrors.rclone.updateRemoteUnsupported"
            ));
        }
    }
    let pending_version = activate_pending_rclone_update(&app_handle).await?;

    // send a notification that the update has actually been installed
    notify(
        &app_handle,
        NotificationEvent::RcloneUpdateInstalled {
            version: pending_version.to_string(),
        },
    );

    crate::rclone::engine::lifecycle::restart_for_config_change(
        &app_handle,
        "rclone_update",
        "unknown",
        &pending_version,
    )
    .map_err(|e| format!("Binary swapped but engine restart failed: {}", e))
}

/// Swaps the pending `.new` binary into the active location.
/// Does NOT restart the engine — returns the activated version string.
pub async fn activate_pending_rclone_update(app_handle: &AppHandle) -> Result<String, String> {
    debug!("🚀 Activating rclone update (swapping binaries via RC)");

    let (current_path, new_path) = find_pending_new_binary(app_handle).ok_or_else(|| {
        use crate::utils::types::updater::RcloneUpdaterState;
        if let Ok(mut pending) = app_handle
            .state::<RcloneUpdaterState>()
            .pending_update
            .lock()
        {
            *pending = None;
        }
        "The downloaded .new binary was missing or deleted. Please check for updates again."
            .to_string()
    })?;

    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    let old_path = PathBuf::from(format!("{}.old", current_path.display()));

    // 1. Backup current binary
    if current_path.exists() {
        let src_fs = current_path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy();
        let src_remote = current_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let dst_fs = old_path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy();
        let dst_remote = old_path.file_name().unwrap_or_default().to_string_lossy();

        let _ = backend
            .post_json(
                client,
                operations::MOVEFILE,
                Some(&serde_json::json!({
                    "srcFs": src_fs,
                    "srcRemote": src_remote,
                    "dstFs": dst_fs,
                    "dstRemote": dst_remote,
                })),
            )
            .await;
    }

    // 2. Promote new binary
    {
        let src_fs = new_path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy();
        let src_remote = new_path.file_name().unwrap_or_default().to_string_lossy();
        let dst_fs = current_path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy();
        let dst_remote = current_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();

        backend
            .post_json(
                client,
                operations::MOVEFILE,
                Some(&serde_json::json!({
                    "srcFs": src_fs,
                    "srcRemote": src_remote,
                    "dstFs": dst_fs,
                    "dstRemote": dst_remote,
                })),
            )
            .await
            .map_err(|e| format!("Failed to promote new binary via RC: {e}"))?;
    }

    // 3. Graceful quit
    info!("✅ Binary successfully swapped via RC. Quitting engine for restart...");
    let _ = backend.post_json(client, core::QUIT, None).await;

    // Update engine state to reflect that we are updating
    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        engine.set_updating(false); // We've finished the swap, restart will happen next
    }

    // Persist new path if needed
    if let Some(new_parent) = current_path.parent() {
        let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
        let current_setting: PathBuf = manager
            .inner()
            .get::<String>("core.rclone_path")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_default();

        if current_setting != new_parent {
            update_rclone_path_in_settings(app_handle, new_parent).await;
        }
    }

    use crate::utils::types::updater::RcloneUpdaterState;
    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let mut pending = updater_state
        .pending_update
        .lock()
        .map_err(|e| format!("Failed to lock pending rclone version: {e}"))?;

    let meta = pending
        .take()
        .ok_or_else(|| "No pending update metadata".to_string())?;

    Ok(meta.latest_version)
}

// ============================================================================
// Update Strategy
// ============================================================================

async fn determine_update_strategy(
    current_path: &Path,
    app_handle: &AppHandle,
) -> Result<UpdateStrategy, String> {
    if current_path.parent().is_some_and(is_writable_dir) {
        log::info!("Can update rclone in place at: {current_path:?}");
        return Ok(UpdateStrategy::InPlace(current_path.to_path_buf()));
    }

    let local_dir = get_local_rclone_path(app_handle)?;
    if let Some(parent) = local_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create local rclone directory: {e}"))?;
    }

    let bin_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let full_path = local_dir.join(bin_name);
    log::info!("Will download rclone to local path: {full_path:?}");
    Ok(UpdateStrategy::DownloadToLocal(full_path))
}

async fn execute_update_strategy(
    strategy: UpdateStrategy,
    app_handle: &AppHandle,
    channel: UpdateChannel,
) -> Result<serde_json::Value, String> {
    match strategy {
        UpdateStrategy::InPlace(target_file) => {
            let new_path = PathBuf::from(format!("{}.new", target_file.display()));
            info!("Downloading update in-place to: {:?}", new_path);
            perform_rclone_selfupdate(app_handle, Some(&new_path), channel).await
        }

        UpdateStrategy::DownloadToLocal(full_path) => {
            let new_path = PathBuf::from(format!("{}.new", full_path.display()));
            info!("Downloading update to local path: {:?}", new_path);
            // Do NOT save settings here — that would trigger the rclone_path event
            // listener and restart the engine before the binary is promoted.
            // The path is saved in activate_pending_rclone_update after the swap.
            perform_rclone_selfupdate(app_handle, Some(&new_path), channel).await
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn clean_version(version: &str) -> String {
    version.trim_start_matches('v').to_string()
}

fn is_writable_dir(path: &Path) -> bool {
    let test_file = path.join(".rclone_manager_write_test");
    if std::fs::write(&test_file, "test").is_ok() {
        let _ = std::fs::remove_file(&test_file);
        true
    } else {
        false
    }
}

fn get_local_rclone_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let configured: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_path")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_default();

    if !matches!(configured.to_string_lossy().as_ref(), "" | "system") {
        if is_writable_dir(&configured) {
            log::info!("Using configured rclone install path: {configured:?}");
            return Ok(configured);
        }
        log::warn!("Configured path {configured:?} is not writable, falling back to app data dir");
    }

    Ok(crate::core::paths::AppPaths::from_app_handle(app_handle)?.config_dir)
}

async fn update_rclone_path_in_settings(app_handle: &AppHandle, new_path: &Path) {
    match save_setting(
        "core".to_string(),
        "rclone_path".to_string(),
        json!(new_path.display().to_string()),
        app_handle.state(),
        app_handle.clone(),
    )
    .await
    {
        Ok(_) => info!("Updated rclone path in settings to: {:?}", new_path),
        Err(e) => log::error!("Failed to save rclone path to settings: {e}"),
    }
}

// ============================================================================
// Core Update Logic
// ============================================================================

async fn check_rclone_selfupdate(
    app_handle: &AppHandle,
    channel: &UpdateChannel,
) -> Result<UpdateCheckResult, String> {
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    // Call `rclone selfupdate --check` through the running RC daemon.
    // The RC endpoint core/command runs any rclone sub-command and returns its
    // COMBINED_OUTPUT in the "result" field.
    let response = backend
        .post_json(
            client,
            core::COMMAND,
            Some(&serde_json::json!({
                "command": "selfupdate",
                "arg": ["--check"]
            })),
        )
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
        )?;

    // core/command returns { "result": "<combined stdout+stderr>", "error": bool }
    let output = response
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Example output:
    //   yours:  1.71.1
    //   latest: 1.71.1   (released 2025-09-24)
    //   beta:   1.72.0-beta.9155.2bc155a96  (released 2025-10-05)
    let mut current_version = String::new();
    let mut latest_stable = String::new();
    let mut latest_beta = String::new();

    for line in output.lines() {
        let line = line.trim();
        let version_field = || line.split_whitespace().nth(1).unwrap_or("").to_string();
        if line.starts_with("yours:") {
            current_version = version_field();
        } else if line.starts_with("latest:") {
            latest_stable = version_field();
        } else if line.starts_with("beta:") {
            latest_beta = version_field();
        }
    }

    let target_version = match channel {
        UpdateChannel::Beta if !latest_beta.is_empty() => latest_beta,
        _ => latest_stable,
    };

    if target_version.is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.rclone.versionCheckFailed",
            "error" => "Parse error"
        ));
    }

    let update_available = !current_version.is_empty()
        && clean_version(&current_version) != clean_version(&target_version);

    Ok(UpdateCheckResult {
        update_available,
        latest_version: target_version,
    })
}

async fn fetch_rclone_release_info(
    version: &str,
    channel: &UpdateChannel,
) -> Result<(Option<String>, Option<String>, Option<String>), github_client::Error> {
    let tag = format!("v{}", clean_version(version));

    let release = match github_client::get_release_by_tag("rclone", "rclone", &tag).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("Failed to fetch GitHub release for tag {tag}: {e}");
            return Ok((None, None, None));
        }
    };

    if *channel == UpdateChannel::Beta {
        return Ok((release.body, release.published_at, Some(release.html_url)));
    }

    match fetch_stable_changelog(version, &release.published_at, &release.html_url).await {
        Ok(changelog) => Ok((
            Some(changelog),
            release.published_at,
            Some(release.html_url),
        )),
        Err(e) => {
            log::warn!("Failed to fetch stable changelog, using release body: {e}");
            Ok((release.body, release.published_at, Some(release.html_url)))
        }
    }
}

async fn fetch_stable_changelog(
    version: &str,
    release_date: &Option<String>,
    release_url: &str,
) -> Result<String, github_client::Error> {
    let tag = format!("v{}", clean_version(version));

    match github_client::get_raw_file_content("rclone", "rclone", &tag, "docs/content/changelog.md")
        .await
    {
        Ok(content) => Ok(
            extract_version_changelog(&content, version).unwrap_or_else(|| {
                log::warn!("Could not parse changelog.md, falling back to release URL.");
                format!("## Rclone {version}\n\n[View full changelog]({release_url})")
            }),
        ),
        Err(e) => {
            log::debug!("Failed to fetch changelog.md: {e}");
            Ok(format!(
                "## Rclone {version}\n\nReleased: {}\n\n[View full changelog]({release_url})",
                release_date.as_deref().unwrap_or("N/A"),
            ))
        }
    }
}

fn extract_version_changelog(changelog: &str, version: &str) -> Option<String> {
    let header = format!("## v{}", clean_version(version));
    let start = changelog.find(&header)?;
    let after_header = &changelog[start..];
    let end = after_header[header.len()..]
        .find("\n## ")
        .map(|i| header.len() + i)
        .unwrap_or(after_header.len());
    Some(after_header[..end].trim().to_string())
}

async fn perform_rclone_selfupdate(
    app_handle: &AppHandle,
    output_path: Option<&Path>,
    channel: UpdateChannel,
) -> Result<serde_json::Value, String> {
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    let mut args = vec![];
    if let Some(output) = output_path {
        args.push("--output".to_string());
        args.push(output.display().to_string());
    }

    match channel {
        UpdateChannel::Beta => args.push("--beta".to_string()),
        UpdateChannel::Stable => args.push("--stable".to_string()),
    }

    info!(
        "Executing rclone selfupdate via RC ({:?} channel)",
        channel.as_str()
    );

    let response = backend
        .post_json(
            client,
            core::COMMAND,
            Some(&serde_json::json!({
                "command": "selfupdate",
                "arg": args
            })),
        )
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => e),
        )?;

    // core/command returns { "result": "...", "error": bool }
    let error = response
        .get("error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let result = response
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if error {
        return Err(
            crate::localized_error!("backendErrors.rclone.selfupdateFailed", "error" => result),
        );
    }

    info!("Rclone selfupdate finished via RC (binary downloaded)");
    Ok(serde_json::json!({
        "success": true,
        "message": "Rclone update downloaded successfully",
        "output": result.trim(),
        "channel": channel.as_str()
    }))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!section.contains("v1.71.0"));
    }

    #[test]
    fn test_extract_version_changelog_not_found() {
        let changelog = "## v1.70.0 - Old version\n\nOld notes.";
        assert!(extract_version_changelog(changelog, "v1.71.1").is_none());
    }

    #[test]
    fn test_extract_version_changelog_last_section() {
        let changelog = "## v1.71.1 - 2025-09-24\n\nThis is the last section.";
        let result = extract_version_changelog(changelog, "v1.71.1");
        assert!(result.is_some());
        assert!(result.unwrap().contains("last section"));
    }

    #[test]
    fn test_update_channel_from_option() {
        assert_eq!(
            UpdateChannel::from(Some("beta".to_string())),
            UpdateChannel::Beta
        );
        assert_eq!(
            UpdateChannel::from(Some("stable".to_string())),
            UpdateChannel::Stable
        );
        assert_eq!(UpdateChannel::from(None::<String>), UpdateChannel::Stable);
        assert_eq!(
            UpdateChannel::from(Some("anything".to_string())),
            UpdateChannel::Stable
        );
    }

    #[test]
    fn test_update_channel_as_str() {
        assert_eq!(UpdateChannel::Stable.as_str(), "stable");
        assert_eq!(UpdateChannel::Beta.as_str(), "beta");
    }

    #[test]
    fn test_is_writable_dir() {
        let temp_dir = std::env::temp_dir().join("rclone_manager_test_writable");
        std::fs::create_dir_all(&temp_dir).unwrap();
        assert!(is_writable_dir(&temp_dir));
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
