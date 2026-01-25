//! Restore management with format detection
//!
//! Supports both rcman library format and legacy app format backups.

use crate::core::settings::AppSettingsManager;
use crate::{
    rclone::commands::remote::create_remote,
    utils::types::events::{REMOTE_CACHE_CHANGED, SYSTEM_SETTINGS_CHANGED},
};
use log::{info, warn};
use serde_json::json;
use std::{fs::File, io::BufReader, path::Path};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

// DEPRECATION (2026-2027): Delete this line when removing legacy support
use super::legacy_restore::restore_legacy_backup;

// -----------------------------------------------------------------------------
// BACKUP FORMAT VERSION DETECTION
// -----------------------------------------------------------------------------

/// Backup format versions for backward compatibility
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFormatVersion {
    // DEPRECATION (2026-2027): Delete this variant when removing legacy support
    /// App's original format (manifest with format.version string, data.7z/data.zip)
    AppLegacy,
    /// New rcman library format (manifest with root version int, data.zip)
    Rcman,
    /// Unknown format
    Unknown,
}

/// Detects the backup format by analyzing the manifest JSON structure
fn detect_manifest_format(manifest_json: &serde_json::Value) -> BackupFormatVersion {
    // rcman format has root-level "version" as integer
    if manifest_json
        .get("version")
        .and_then(|v| v.as_u64())
        .is_some()
    {
        return BackupFormatVersion::Rcman;
    }

    // DEPRECATION (2026-2027): Delete this block when removing legacy support
    // App legacy format has "format.version" as string
    if manifest_json
        .get("format")
        .and_then(|f| f.get("version"))
        .and_then(|v| v.as_str())
        .is_some()
    {
        return BackupFormatVersion::AppLegacy;
    }

    BackupFormatVersion::Unknown
}

// -----------------------------------------------------------------------------
// MAIN RESTORE COMMAND (With format routing)
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn restore_settings(
    backup_path: std::path::PathBuf,
    password: Option<String>,
    restore_profile: Option<String>,
    restore_profile_as: Option<String>,
    manager: State<'_, AppSettingsManager>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting restore from: {:?}", backup_path);

    // Open and read manifest to detect format
    let file = File::open(&backup_path).map_err(|e| format!("Failed to open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid .rcman file: {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json")?;

    let manifest_json: serde_json::Value = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest: {e}"))?;

    // Route to appropriate handler based on format
    let format = detect_manifest_format(&manifest_json);
    info!("Detected backup format: {:?}", format);

    match format {
        BackupFormatVersion::Rcman => {
            restore_rcman_backup(
                &backup_path,
                password,
                restore_profile,
                restore_profile_as,
                &manager,
                &app_handle,
            )
            .await
        }
        // DEPRECATION (2026-2027): Delete this match arm when removing legacy support
        // IMPORTANT: Legacy backups are always restored to the "default" profile
        // because they were created before the profile system existed.
        BackupFormatVersion::AppLegacy => {
            restore_legacy_backup(&backup_path, password, &manifest_json, &app_handle).await
        }
        BackupFormatVersion::Unknown => Err(crate::localized_error!(
            "backendErrors.backup.unknownFormat"
        )),
    }
}

// -----------------------------------------------------------------------------
// RCMAN FORMAT RESTORE
// -----------------------------------------------------------------------------

async fn restore_rcman_backup(
    backup_path: &Path,
    password: Option<String>,
    restore_profile: Option<String>,
    restore_profile_as: Option<String>,
    manager: &AppSettingsManager,
    app_handle: &AppHandle,
) -> Result<String, String> {
    info!("Restoring using rcman library...");

    // Build restore options
    let mut options = rcman::RestoreOptions::from_path(backup_path)
        .restore_settings(true)
        .overwrite(true)
        .verify_checksum(true);

    if let Some(pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    if let Some(profile) = restore_profile {
        options = options.restore_profile(profile);
    }

    if let Some(name) = restore_profile_as {
        options = options.restore_profile_as(name);
    }

    // Perform restore
    let result = manager
        .backup()
        .restore(&options)
        .map_err(|e| format!("Restore failed: {}", e))?;

    // Emit events to notify frontend
    app_handle.emit(REMOTE_CACHE_CHANGED, ()).ok();

    if result.restored.iter().any(|s| s == "settings.json") {
        // Reload settings to get new values
        manager.invalidate_cache();
        if let Some(app_settings) = manager
            .get_all()
            .ok()
            .and_then(|s| serde_json::to_value(s).ok())
            .and_then(|v: serde_json::Value| v.get("app_settings").cloned())
        {
            app_handle.emit(SYSTEM_SETTINGS_CHANGED, app_settings).ok();
        }
    }

    // Post-process: Restore external remote configs (they are marked as ReadOnly by rcman)
    // Look for skipped items like "remote:gdrive" in the external_pending list
    let mut remote_restore_count = 0;
    for item in &result.external_pending {
        if item.starts_with("remote:") {
            let remote_name = item.trim_start_matches("remote:");
            info!(
                "📥 Attempting to restore external remote config: {}",
                remote_name
            );

            // The archive filename format is {remote_name}_rclone.json
            let archive_filename = format!("{}_rclone.json", remote_name);

            // Try to read the remote config from backup
            if let Ok(config_data) = manager.backup().get_external_config_from_backup(
                backup_path,
                &archive_filename,
                None,
            ) {
                match restore_remote_from_json(remote_name, &config_data, app_handle).await {
                    Ok(()) => {
                        remote_restore_count += 1;
                        info!("✅ Restored remote: {}", remote_name);
                    }
                    Err(e) => {
                        warn!("⚠️ Failed to restore remote '{}': {}", remote_name, e);
                    }
                }
            } else {
                warn!("⚠️ Could not read external config for: {}", item);
            }
        }
    }

    let restored_count = result.restored.len() + remote_restore_count;
    let skipped_count = result.skipped.len();

    info!(
        "✅ Restore complete: {} restored, {} skipped",
        restored_count, skipped_count
    );

    Ok(format!(
        "Settings restored successfully ({} items restored, {} skipped)",
        restored_count, skipped_count
    ))
}

/// Restores a remote from JSON config data
async fn restore_remote_from_json(
    remote_name: &str,
    config_data: &[u8],
    app_handle: &AppHandle,
) -> Result<(), String> {
    let content =
        String::from_utf8(config_data.to_vec()).map_err(|e| format!("Invalid UTF-8: {e}"))?;

    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))?;

    // The exported format is { "remote_name": { ...config... } }
    // Extract the config for this remote
    let mut config = if let Some(remote_config) = parsed.get(remote_name) {
        remote_config.clone()
    } else {
        // Fallback: use the whole parsed value if it's already the config
        parsed
    };

    // Mark as remote config
    if let Some(obj) = config.as_object_mut() {
        obj.insert("config_is_local".to_string(), json!("false"));
    }

    // Convert to HashMap
    let config_map: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_value(config)
            .map_err(|e| format!("Failed to convert config to map: {e}"))?;

    create_remote(app_handle.clone(), remote_name.to_string(), config_map)
        .await
        .map_err(|e| format!("Failed to create remote: {}", e))?;

    Ok(())
}
