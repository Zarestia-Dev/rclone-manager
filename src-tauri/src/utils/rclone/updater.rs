//! # Rclone Updater Module
//!
//! Handles rclone binary updates with intelligent strategy selection:
//!
//! - **In-Place**: Updates rclone directly when write permissions allow
//! - **Download-to-Local**: Downloads to app data directory when in-place isn't possible

use log::{debug, info, warn};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::read_rclone_binary;
use crate::core::settings::operations::core::save_setting;
use crate::rclone::backend::BackendManager;
use crate::rclone::engine::lifecycle::{resume_engine, set_engine_updating, shutdown_engine};
use crate::utils::app::notification::{NotificationEvent, UpdateStage, notify};
use crate::utils::github_client;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::events::{APP_EVENT, EngineStatus, RCLONE_ENGINE_STATUS_CHANGED};
use crate::utils::types::state::RcloneState;
use crate::utils::types::updater::{
    RcloneUpdaterState, Result, UpdateInfo, UpdateMetadata, UpdateResult, UpdateState,
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

impl std::fmt::Display for UpdateChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                UpdateChannel::Stable => "stable",
                UpdateChannel::Beta => "beta",
            }
        )
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

        let is_skipped = app_handle
            .try_state::<crate::core::settings::AppSettingsManager>()
            .and_then(|m| m.get_all().ok())
            .is_some_and(|c| {
                c.runtime
                    .rclone_skipped_updates
                    .contains(&result_meta.metadata.version)
            });

        if !is_skipped {
            notify(
                &app_handle,
                NotificationEvent::RcloneUpdate(UpdateStage::Available {
                    version: result_meta.metadata.version.clone(),
                }),
            );
        }
    }

    Ok(result_meta)
}

pub async fn perform_check_rclone_update(
    app_handle: tauri::AppHandle,
    channel: Option<String>,
) -> Result<UpdateInfo> {
    let current_version = get_cached_rclone_version(&app_handle)
        .await
        .unwrap_or_else(|| "unknown".to_string());

    let channel: UpdateChannel = channel.into();

    {
        let state = app_handle.state::<RcloneUpdaterState>();
        let mut d = state.data.lock();
        d.state = UpdateState::Checking;
        d.pending_update = None;
    }

    let (update_available, latest_version) = check_rclone_selfupdate(&app_handle, &channel).await?;

    let (release_notes, release_date, release_url) = if update_available {
        fetch_rclone_release_info(&latest_version, &channel)
            .await
            .unwrap_or((None, None, None))
    } else {
        (None, None, None)
    };

    let metadata = UpdateMetadata {
        current_version: current_version.clone(),
        version: latest_version,
        update_available,
        channel: Some(channel.to_string()),
        release_notes,
        release_date,
        release_url,
        ..Default::default()
    };

    {
        let state = app_handle.state::<RcloneUpdaterState>();
        let mut d = state.data.lock();
        d.state = UpdateState::Idle;
        if update_available {
            d.pending_update = Some(metadata.clone());
        }
    }

    let status = if metadata.update_available {
        UpdateState::Available
    } else {
        UpdateState::Idle
    };

    Ok(UpdateInfo { metadata, status })
}

#[tauri::command]
pub async fn get_rclone_update_info(app_handle: tauri::AppHandle) -> Result<Option<UpdateInfo>> {
    let pending_new = find_pending_new_binary(&app_handle);
    let has_pending_new = pending_new.is_some();
    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let (state, pending_metadata) = {
        let d = updater_state.data.lock();
        (d.state, d.pending_update.clone())
    };

    if pending_metadata.is_none() && !has_pending_new {
        return Ok(None);
    }

    let status = if has_pending_new || state == UpdateState::ReadyToRestart {
        UpdateState::ReadyToRestart
    } else if state == UpdateState::Downloading {
        UpdateState::Downloading
    } else if pending_metadata
        .as_ref()
        .is_some_and(|m| m.update_available)
    {
        UpdateState::Available
    } else {
        UpdateState::Idle
    };

    let mut metadata = if let Some(m) = pending_metadata {
        m
    } else {
        let current_version = get_cached_rclone_version(&app_handle)
            .await
            .unwrap_or_else(|| "unknown".to_string());

        let version = if let Some((_, new_path)) = &pending_new {
            get_binary_version(new_path)
                .await
                .unwrap_or_else(|| "unknown".to_string())
        } else {
            "unknown".to_string()
        };

        UpdateMetadata {
            current_version,
            version,
            update_available: false,
            channel: Some("stable".into()),
            ..Default::default()
        }
    };

    if status == UpdateState::ReadyToRestart {
        metadata.update_available = false;
    }

    Ok(Some(UpdateInfo { metadata, status }))
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

    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let cached_update = {
        let d = updater_state.data.lock();
        d.pending_update.clone()
    };

    let update_check = match cached_update {
        Some(metadata)
            if metadata.update_available
                && metadata.channel.as_deref() == Some(&channel_enum.to_string()) =>
        {
            UpdateInfo {
                metadata,
                status: UpdateState::Available,
            }
        }
        _ => perform_check_rclone_update(app_handle.clone(), channel).await?,
    };

    if !update_check.metadata.update_available {
        return Ok(UpdateResult {
            success: false,
            message: Some("No update available".to_string()),
            channel: Some(channel_enum.to_string()),
            ..Default::default()
        });
    }

    let latest_version = &update_check.metadata.version;

    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let state = app_handle.state::<RcloneUpdaterState>();
        state.data.lock().cancel_token = Some(cancel_token.clone());
    }

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

            let result = perform_rclone_selfupdate(
                &app_handle,
                None,
                channel_enum.clone(),
                cancel_token.clone(),
            )
            .await;

            {
                let state = app_handle.state::<RcloneUpdaterState>();
                state.data.lock().cancel_token = None;
            }

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
                        channel: Some(channel_enum.to_string()),
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

    if let Err(e) = app_handle.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::Updating) {
        return Err(Error::Backend(format!("Failed to emit update event: {e}")));
    }

    notify(
        &app_handle,
        NotificationEvent::RcloneUpdate(UpdateStage::Started {
            version: latest_version.clone(),
        }),
    );

    let target_path = resolve_update_target_path(&current_path, &app_handle)?;
    let new_path = PathBuf::from(format!("{}.new", target_path.display()));

    {
        let state = app_handle.state::<RcloneUpdaterState>();
        state.data.lock().state = UpdateState::Downloading;
    }
    info!("Downloading update to: {new_path:?}");
    let update_result =
        perform_rclone_selfupdate(&app_handle, Some(&new_path), channel_enum, cancel_token).await;

    {
        let state = app_handle.state::<RcloneUpdaterState>();
        let mut data = state.data.lock();
        data.cancel_token = None;
        match &update_result {
            Ok(res) if res.success => {
                data.state = UpdateState::ReadyToRestart;
            }
            _ => {
                data.state = UpdateState::Idle;
            }
        }
    }

    match &update_result {
        Ok(res) => {
            if res.success {
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

/// Cancels an in-progress rclone update download.
#[tauri::command]
pub async fn cancel_rclone_update(app_handle: tauri::AppHandle) -> Result<()> {
    let updater_state = app_handle.state::<RcloneUpdaterState>();
    let mut data = updater_state.data.lock();

    if data.state == UpdateState::Downloading {
        if let Some(token) = data.cancel_token.take() {
            info!("Cancelling rclone update download");
            token.cancel();
        }

        data.state = if data.pending_update.is_some() {
            UpdateState::Available
        } else {
            UpdateState::Idle
        };
    }

    Ok(())
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
    set_engine_updating(&app_handle, true).await;

    let pending_version = match activate_pending_rclone_update(&app_handle, true).await {
        Ok(v) => v,
        Err(e) => {
            set_engine_updating(&app_handle, false).await;
            return Err(e);
        }
    };

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
    );

    Ok(())
}

/// Swaps the pending `.new` binary into the active location.
/// Does NOT restart the engine — returns the activated version string.
pub async fn activate_pending_rclone_update(
    app_handle: &AppHandle,
    resume: bool,
) -> Result<String> {
    debug!("Activating rclone update (native binary swap)");
    let (current_path, new_path) = if let Some(paths) = find_pending_new_binary(app_handle) {
        paths
    } else {
        let state = app_handle.state::<RcloneUpdaterState>();
        state.data.lock().pending_update = None;
        return Err(Error::BinaryNotFound);
    };

    info!("Stopping rclone engine for binary swap...");
    shutdown_engine(app_handle).await;

    let old_path = PathBuf::from(format!("{}.old", current_path.display()));
    if current_path.exists() {
        debug!(
            "Backing up current binary: {} -> {}",
            current_path.display(),
            old_path.display()
        );
        std::fs::rename(&current_path, &old_path).map_err(Error::BackupFailed)?;
    }

    info!(
        "Promoting new binary: {} -> {}",
        new_path.display(),
        current_path.display()
    );
    if let Err(e) = std::fs::rename(&new_path, &current_path) {
        if old_path.exists() {
            let _ = std::fs::rename(&old_path, &current_path);
        }
        return Err(Error::Io(e));
    }

    if old_path.exists() {
        let _ = std::fs::remove_file(&old_path);
    }

    if resume {
        resume_engine(app_handle).await;
    }

    {
        let manager = app_handle.state::<crate::core::settings::AppSettingsManager>();
        let current_setting: PathBuf = manager
            .inner()
            .get::<String>("core.rclone_binary")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_default();

        if current_setting != current_path
            && let Err(e) = update_rclone_binary_in_settings(app_handle, &current_path).await
        {
            warn!("Failed to update rclone binary path in settings: {e}");
        }
    }

    let updater = app_handle.state::<RcloneUpdaterState>();
    let meta = {
        let mut d = updater.data.lock();
        d.state = UpdateState::Idle;
        d.pending_update.take()
    };

    if let Some(metadata) = meta {
        Ok(metadata.version)
    } else {
        log::warn!("Rclone binary swap completed but no update metadata was found (state lost?)");
        Ok(get_binary_version(&current_path)
            .await
            .unwrap_or_else(|| "unknown".to_string()))
    }
}

/// Helper to get the version of a specific rclone binary.
async fn get_binary_version(path: &Path) -> Option<String> {
    let output = crate::utils::process::command::Command::new(path)
        .arg("version")
        .output()
        .await
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.lines().next().and_then(|line| {
            line.split_whitespace()
                .nth(1)
                .map(clean_version)
                .map(String::from)
        })
    } else {
        None
    }
}

async fn get_cached_rclone_version(app_handle: &AppHandle) -> Option<String> {
    let backend_manager = app_handle.state::<BackendManager>();
    let active_name = backend_manager.get_active_name().await;

    if let Some(v) = backend_manager
        .get_runtime_info(&active_name)
        .await
        .and_then(|runtime| {
            runtime
                .core_version
                .as_ref()
                .map(|version_info| version_info.version.clone())
                .or(runtime.version)
        })
    {
        return Some(v);
    }

    let active = backend_manager.get_active().await;
    if active.is_local {
        let current_path = read_rclone_binary(app_handle);
        if let Some(v) = get_binary_version(&current_path).await {
            return Some(v);
        }
    }

    None
}

/// Global function to check for and apply any staged rclone updates.
///
/// This checks both the in-memory state and the filesystem for `.new` binaries.
/// Should be called during shutdown, restart, and startup.
pub async fn apply_rclone_update_if_staged(app_handle: &AppHandle) -> Result<bool> {
    if find_pending_new_binary(app_handle).is_some() {
        info!("Applying staged rclone update...");
        activate_pending_rclone_update(app_handle, false).await?;
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

fn clean_version(version: &str) -> &str {
    version.trim_start_matches('v')
}

fn is_writable_dir(path: &Path) -> bool {
    let test_file = path.join(".rclone_manager_write_test");
    if std::fs::write(&test_file, "test").is_ok() {
        if let Err(e) = std::fs::remove_file(&test_file) {
            warn!(
                "Failed to remove write-test file {}: {e}",
                test_file.display()
            );
        }
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
        json!(new_path.to_string_lossy()),
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
) -> Result<(bool, String)> {
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    let os = backend_manager.get_runtime_os(&backend.name).await;
    let payload =
        backend.build_core_command_payload("selfupdate", vec!["--check".to_string()], false, os);

    let response = backend
        .post_json(client, core::COMMAND, Some(&payload))
        .await
        .map_err(Error::RcloneVersionCheck)?;

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

    Ok((update_available, target_version))
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
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<UpdateResult> {
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app_handle.state::<RcloneState>().client;

    let mut args = vec![];
    if let Some(output) = output_path {
        args.push("--output".to_string());
        args.push(output.to_string_lossy().to_string());
    }

    match channel {
        UpdateChannel::Beta => args.push("--beta".to_string()),
        UpdateChannel::Stable => args.push("--stable".to_string()),
    }

    info!("Executing rclone selfupdate via RC ({channel} channel)");

    let os = backend_manager.get_runtime_os(&backend.name).await;
    let payload = backend.build_core_command_payload("selfupdate", args, false, os);

    let response = tokio::select! {
        () = cancel_token.cancelled() => {
            return Err(Error::RcloneSelfUpdate("Download cancelled by user".to_string()));
        }
        res = backend.post_json(client, core::COMMAND, Some(&payload)) => {
            res.map_err(|e| Error::RcloneSelfUpdate(e.clone()))?
        }
    };

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
        channel: Some(channel.to_string()),
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
    fn test_update_channel_display() {
        assert_eq!(UpdateChannel::Stable.to_string(), "stable");
        assert_eq!(UpdateChannel::Beta.to_string(), "beta");
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
