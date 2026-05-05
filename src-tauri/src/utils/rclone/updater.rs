//! # Rclone Updater Module
//!
//! Handles rclone binary updates with intelligent strategy selection:
//!
//! - **In-Place**: Updates rclone directly when write permissions allow
//! - **Download-to-Local**: Downloads to app data directory when in-place isn't possible

use log::{debug, info};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::read_rclone_binary;
use crate::core::settings::operations::core::save_setting;
use crate::rclone::backend::BackendManager;
use crate::rclone::queries::get_rclone_info;
use crate::utils::app::notification::{NotificationEvent, UpdateStage, notify};
use crate::utils::github_client;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::core::EngineState;
use crate::utils::types::core::RcloneState;
use crate::utils::types::events::APP_EVENT;
use crate::utils::types::events::RCLONE_ENGINE_UPDATING;
use crate::utils::types::updater::{
    RcloneUpdaterState, Result, UpdateInfo, UpdateMetadata, UpdateResult, UpdateStatus,
    UpdaterError as Error,
};

struct RcloneVersionInfo {
    current: String,
    stable: String,
    beta: String,
}

impl RcloneVersionInfo {
    fn parse(output: &str) -> std::result::Result<Self, String> {
        let mut info = Self {
            current: String::new(),
            stable: String::new(),
            beta: String::new(),
        };

        for line in output.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }

            match parts[0] {
                "yours:" => info.current = parts[1].to_string(),
                "latest:" => info.stable = parts[1].to_string(),
                "beta:" => info.beta = parts[1].to_string(),
                _ => {}
            }
        }

        if info.current.is_empty() || info.stable.is_empty() {
            return Err(
                "Failed to parse rclone version info: missing current or stable version"
                    .to_string(),
            );
        }

        Ok(info)
    }
}

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
pub enum UpdateChannel {
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
) -> Result<UpdateInfo> {
    let result_meta = perform_check_rclone_update(app_handle.clone(), channel).await?;

    if result_meta.metadata.update_available {
        if let Err(e) = app_handle.emit(
            APP_EVENT,
            json!({ "status": "rclone_update_found", "data": &result_meta }),
        ) {
            log::warn!("Failed to emit rclone update event: {e}");
        }

        notify(
            &app_handle,
            NotificationEvent::RcloneUpdate(UpdateStage::Available {
                version: result_meta.metadata.version.clone(),
            }),
        );
    }

    Ok(result_meta)
}

pub async fn perform_check_rclone_update(
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<UpdateInfo> {
    let current_version = get_rclone_info(app_handle.clone())
        .await
        .map(|info| info.version)
        .map_err(Error::RcloneVersionCheck)?;

    let channel: UpdateChannel = channel.into();

    // Clear any previous pending update state before checking
    app_handle
        .state::<RcloneUpdaterState>()
        .with_data(|d| d.pending_update = None);

    let result = check_rclone_selfupdate(&app_handle, &channel).await?;

    let (release_notes, release_date, release_url) = if result.update_available {
        fetch_rclone_release_info(&result.latest_version, &channel)
            .await
            .unwrap_or((None, None, None))
    } else {
        (None, None, None)
    };

    let metadata = UpdateMetadata {
        current_version: current_version.clone(),
        version: result.latest_version.clone(),
        update_available: result.update_available,
        channel: Some(channel.as_str().to_string()),
        release_notes,
        release_date,
        release_url,
        ..Default::default()
    };

    if result.update_available {
        app_handle
            .state::<RcloneUpdaterState>()
            .with_data(|d| d.pending_update = Some(metadata.clone()));
    }

    let status = if metadata.update_available {
        UpdateStatus::Available
    } else {
        UpdateStatus::Idle
    };

    Ok(UpdateInfo { metadata, status })
}

#[tauri::command]
pub async fn get_rclone_update_info(app_handle: tauri::AppHandle) -> Result<Option<UpdateInfo>> {
    let has_pending_new = find_pending_new_binary(&app_handle).is_some();
    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let is_updating = updater_state.is_updating.load(Ordering::Acquire);
    let is_restart_required = updater_state.is_restart_required.load(Ordering::Acquire);
    let pending_metadata = updater_state.with_data(|d| d.pending_update.clone());

    if let Some(mut metadata) = pending_metadata {
        let mut ready_to_restart = is_restart_required;
        let mut update_in_progress = is_updating;

        if has_pending_new && !ready_to_restart {
            // Self-heal if state was lost but binary exists
            ready_to_restart = true;
            updater_state
                .is_restart_required
                .store(true, Ordering::Release);
        }

        if ready_to_restart {
            metadata.update_available = false;
            update_in_progress = false;
        }

        let status = if ready_to_restart {
            UpdateStatus::ReadyToRestart
        } else if update_in_progress {
            UpdateStatus::Downloading
        } else if metadata.update_available {
            UpdateStatus::Available
        } else {
            UpdateStatus::Idle
        };

        return Ok(Some(UpdateInfo { metadata, status }));
    }

    if has_pending_new || is_restart_required {
        if has_pending_new && !is_restart_required {
            updater_state
                .is_restart_required
                .store(true, Ordering::Release);
        }
        return Ok(Some(UpdateInfo {
            metadata: UpdateMetadata {
                current_version: "unknown".into(),
                version: "unknown".into(),
                update_available: false,
                channel: Some("stable".into()),
                ..Default::default()
            },
            status: UpdateStatus::ReadyToRestart,
        }));
    }

    Ok(None)
}

fn find_pending_new_binary(app_handle: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let current_runtime = read_rclone_binary(app_handle);
    let local_target = get_local_rclone_binary(app_handle).ok()?;

    [current_runtime, local_target]
        .into_iter()
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
) -> Result<UpdateResult> {
    debug!("Starting rclone download/update process");

    let channel_enum: UpdateChannel = channel.clone().into();

    // Try to use cached metadata first to avoid redundant network calls
    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let cached_update = updater_state.with_data(|d| d.pending_update.clone());

    let update_check = match cached_update {
        Some(metadata) if metadata.update_available => UpdateInfo {
            metadata,
            status: UpdateStatus::Available,
        },
        _ => perform_check_rclone_update(app_handle.clone(), channel).await?,
    };

    if !update_check.metadata.update_available {
        return Ok(UpdateResult {
            success: false,
            message: Some("No update available".to_string()),
            channel: Some(channel_enum.as_str().to_string()),
            ..Default::default()
        });
    }

    let latest_version = &update_check.metadata.version;

    // --- Remote backend: update in-place, no staging ---
    {
        let backend_manager = app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        if !backend.is_local {
            notify(
                &app_handle,
                NotificationEvent::RcloneUpdate(UpdateStage::Started {
                    version: latest_version.clone(),
                }),
            );

            let result = perform_rclone_selfupdate(&app_handle, None, channel_enum.clone()).await;

            return match result {
                Ok(res) => {
                    notify(
                        &app_handle,
                        NotificationEvent::RcloneUpdate(UpdateStage::Complete {
                            version: latest_version.clone(),
                        }),
                    );
                    Ok(UpdateResult {
                        success: true,
                        manual: true,
                        message: Some(
                            "Rclone update completed. Please restart it manually.".to_string(),
                        ),
                        channel: Some(channel_enum.as_str().to_string()),
                        output: res.output,
                    })
                }
                Err(e) => {
                    notify(
                        &app_handle,
                        NotificationEvent::RcloneUpdate(UpdateStage::Failed {
                            error: e.to_string(),
                        }),
                    );
                    Err(e)
                }
            };
        }
    }

    let current_path = read_rclone_binary(&app_handle);
    if !current_path.exists() {
        return Err(Error::BinaryNotFound);
    }

    app_handle
        .emit(RCLONE_ENGINE_UPDATING, ())
        .map_err(|e| Error::Backend(format!("Failed to emit update event: {e}")))?;

    notify(
        &app_handle,
        NotificationEvent::RcloneUpdate(UpdateStage::Started {
            version: latest_version.clone(),
        }),
    );

    let target_path = resolve_update_target_path(&current_path, &app_handle)?;
    let new_path = PathBuf::from(format!("{}.new", target_path.display()));

    updater_state.is_updating.store(true, Ordering::Release);
    info!("Downloading update to: {new_path:?}");
    let update_result = perform_rclone_selfupdate(&app_handle, Some(&new_path), channel_enum).await;

    updater_state.is_updating.store(false, Ordering::Release);

    match &update_result {
        Ok(res) => {
            if res.success {
                updater_state
                    .is_restart_required
                    .store(true, Ordering::Release);
                notify(
                    &app_handle,
                    NotificationEvent::RcloneUpdate(UpdateStage::Downloaded {
                        version: latest_version.clone(),
                    }),
                );
            }
        }
        Err(e) => {
            notify(
                &app_handle,
                NotificationEvent::RcloneUpdate(UpdateStage::Failed {
                    error: e.to_string(),
                }),
            );
        }
    }

    update_result
}

/// Apply a previously downloaded rclone update and restart the engine.
#[tauri::command]
pub async fn apply_rclone_update(app_handle: tauri::AppHandle) -> Result<()> {
    debug!("Applying previously downloaded rclone update");

    {
        let backend_manager = app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        if !backend.is_local {
            return Err(Error::Backend(crate::localized_error!(
                "backendErrors.rclone.updateRemoteUnsupported"
            )));
        }
    }
    let pending_version = activate_pending_rclone_update(&app_handle).await?;

    // send a notification that the update has actually been installed
    notify(
        &app_handle,
        NotificationEvent::RcloneUpdate(UpdateStage::Installed {
            version: pending_version.clone(),
        }),
    );

    crate::rclone::engine::lifecycle::restart_for_config_change(
        &app_handle,
        "rclone_update",
        "unknown",
        &pending_version,
    )
    .map_err(|e| Error::Restart(e.to_string()))
}

/// Swaps the pending `.new` binary into the active location.
/// Does NOT restart the engine — returns the activated version string.
pub async fn activate_pending_rclone_update(app_handle: &AppHandle) -> Result<String> {
    debug!("Activating rclone update (native binary swap)");
    let (current_path, new_path) = match find_pending_new_binary(app_handle) {
        Some(paths) => paths,
        None => {
            // Clear state if binary is missing
            app_handle
                .state::<RcloneUpdaterState>()
                .with_data(|d| d.pending_update = None);
            return Err(Error::BinaryNotFound);
        }
    };

    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        info!("Stopping rclone engine for binary swap...");
        engine.shutdown(app_handle).await;
    }

    let old_path = PathBuf::from(format!("{}.old", current_path.display()));
    if current_path.exists() {
        debug!(
            "Backing up current binary: {} -> {}",
            current_path.display(),
            old_path.display()
        );
        let _ = std::fs::rename(&current_path, &old_path);
    }

    info!(
        "Promoting new binary: {} -> {}",
        new_path.display(),
        current_path.display()
    );
    std::fs::rename(&new_path, &current_path).map_err(Error::Io)?;

    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        engine.should_exit = false;
        engine.set_updating(false);
    }

    // Persist new path if needed
    {
        let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
        let current_setting: PathBuf = manager
            .inner()
            .get::<String>("core.rclone_binary")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_default();

        if current_setting != current_path {
            let _ = update_rclone_binary_in_settings(app_handle, &current_path).await;
        }
    }

    let updater = app_handle.state::<RcloneUpdaterState>();
    updater.is_restart_required.store(false, Ordering::Release);
    let meta = updater.with_data(|d| d.pending_update.take());

    if let Some(metadata) = meta {
        Ok(metadata.version)
    } else {
        log::warn!("Rclone binary swap completed but no update metadata was found (state lost?)");
        Ok("unknown".to_string())
    }
}

/// Global function to check for and apply any staged rclone updates.
///
/// This checks both the in-memory state and the filesystem for `.new` binaries.
/// Should be called during shutdown, restart, and startup.
pub async fn apply_rclone_update_if_staged(app_handle: &AppHandle) -> Result<bool> {
    if find_pending_new_binary(app_handle).is_some() {
        info!("Applying staged rclone update...");
        activate_pending_rclone_update(app_handle).await?;
        return Ok(true);
    }

    Ok(false)
}

fn resolve_update_target_path(current_path: &Path, app_handle: &AppHandle) -> Result<PathBuf> {
    if current_path.parent().is_some_and(is_writable_dir) {
        return Ok(current_path.to_path_buf());
    }

    let local_path = get_local_rclone_binary(app_handle)?;
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(local_path)
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

fn get_local_rclone_binary(app_handle: &AppHandle) -> Result<PathBuf> {
    let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
    let configured: PathBuf = manager
        .inner()
        .get::<String>("core.rclone_binary")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_default();

    let bin_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };

    if !matches!(configured.to_string_lossy().as_ref(), "" | "system") {
        let dir = if configured.is_dir() {
            configured.clone()
        } else {
            configured
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default()
        };

        if !dir.as_os_str().is_empty() && is_writable_dir(&dir) {
            log::info!("Using configured rclone install directory: {dir:?}");
            return Ok(dir.join(bin_name));
        }
        log::warn!("Configured path {configured:?} is not writable, falling back to app data dir");
    }

    let app_dir = crate::core::paths::AppPaths::from_app_handle(app_handle)
        .map_err(Error::Backend)?
        .config_dir;
    Ok(app_dir.join(bin_name))
}

pub async fn update_rclone_binary_in_settings(
    app_handle: &tauri::AppHandle,
    new_path: &Path,
) -> std::result::Result<(), Error> {
    save_setting(
        app_handle.clone(),
        "core".to_string(),
        "rclone_binary".to_string(),
        json!(new_path.display().to_string()),
    )
    .await
    .map_err(Error::Backend)
}

// ============================================================================
// Core Update Logic
// ============================================================================

async fn check_rclone_selfupdate(
    app_handle: &AppHandle,
    channel: &UpdateChannel,
) -> Result<UpdateCheckResult> {
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    // Call `rclone selfupdate --check` through the running RC daemon.
    let os = backend_manager.get_runtime_os(&backend.name).await;
    let payload =
        backend.build_core_command_payload("selfupdate", vec!["--check".to_string()], false, os);

    let response = backend
        .post_json(client, core::COMMAND, Some(&payload))
        .await
        .map_err(Error::RcloneVersionCheck)?;

    // core/command returns { "result": "<combined stdout+stderr>", "error": bool }
    let output = response
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let info = RcloneVersionInfo::parse(output).map_err(Error::RcloneVersionCheck)?;

    let target_version = match channel {
        UpdateChannel::Beta if !info.beta.is_empty() => info.beta,
        _ => info.stable,
    };

    let update_available =
        !info.current.is_empty() && clean_version(&info.current) != clean_version(&target_version);

    Ok(UpdateCheckResult {
        update_available,
        latest_version: target_version,
    })
}

pub async fn fetch_rclone_release_info(
    version: &str,
    channel: &UpdateChannel,
) -> std::result::Result<(Option<String>, Option<String>, Option<String>), github_client::Error> {
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

    match fetch_stable_changelog(version, &release.html_url).await {
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
    release_url: &str,
) -> std::result::Result<String, github_client::Error> {
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
        Err(e) => Err(e),
    }
}

fn extract_version_changelog(changelog: &str, version: &str) -> Option<String> {
    let header = format!("## v{}", clean_version(version));
    let start = changelog.find(&header)?;
    let after_header = &changelog[start..];
    let end = after_header[header.len()..]
        .find("\n## ")
        .map_or(after_header.len(), |i| header.len() + i);
    Some(after_header[..end].trim().to_string())
}

async fn perform_rclone_selfupdate(
    app_handle: &AppHandle,
    output_path: Option<&Path>,
    channel: UpdateChannel,
) -> Result<UpdateResult> {
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

    let os = backend_manager.get_runtime_os(&backend.name).await;
    let payload = backend.build_core_command_payload("selfupdate", args, false, os);

    let response = backend
        .post_json(client, core::COMMAND, Some(&payload))
        .await
        .map_err(Error::RcloneSelfUpdate)?;

    let error = response
        .get("error")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let result = response
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if error {
        return Err(Error::RcloneSelfUpdate(result.to_string()));
    }

    info!("Rclone selfupdate finished via RC (binary downloaded)");
    Ok(UpdateResult {
        success: true,
        message: Some("Rclone update downloaded successfully".to_string()),
        output: Some(result.trim().to_string()),
        channel: Some(channel.as_str().to_string()),
        manual: false,
    })
}

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
        assert_eq!(UpdateChannel::from(None), UpdateChannel::Stable);
        assert_eq!(
            UpdateChannel::from(Some("stable".to_string())),
            UpdateChannel::Stable
        );
        assert_eq!(
            UpdateChannel::from(Some("beta".to_string())),
            UpdateChannel::Beta
        );
        assert_eq!(
            UpdateChannel::from(Some("unknown".to_string())),
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
        let temp_dir = tempfile::tempdir().unwrap();
        assert!(is_writable_dir(temp_dir.path()));

        let file_path = temp_dir.path().join("file.txt");
        std::fs::write(&file_path, "not a dir").unwrap();
        assert!(!is_writable_dir(&file_path));
    }
}
