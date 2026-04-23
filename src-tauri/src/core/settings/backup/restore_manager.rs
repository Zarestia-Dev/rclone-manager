//! Restore management with format detection
//!
//! Supports both rcman library format and legacy app format backups.

use crate::core::settings::AppSettingsManager;
use crate::{
    rclone::commands::remote::{create_remote, update_remote},
    utils::types::events::{REMOTE_CACHE_CHANGED, SYSTEM_SETTINGS_CHANGED},
};
use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::{fs::File, io::BufReader, path::Path};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

use super::legacy_restore::restore_legacy_backup;

// -----------------------------------------------------------------------------
// BACKUP FORMAT VERSION DETECTION
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFormatVersion {
    AppLegacy,
    Rcman,
    Unknown,
}

fn detect_manifest_format(manifest_json: &serde_json::Value) -> BackupFormatVersion {
    if manifest_json
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some()
    {
        return BackupFormatVersion::Rcman;
    }

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
    app: AppHandle,
    backup_path: std::path::PathBuf,
    password: Option<String>,
    restore_profile: Option<String>,
    restore_profile_as: Option<String>,
) -> Result<String, String> {
    let manager = app.state::<AppSettingsManager>();
    info!("Starting restore from: {backup_path:?}");

    let mut options = rcman::RestoreOptions::from_path(&backup_path)
        .restore_settings(true)
        .overwrite(true)
        .verify_checksum(true);

    if let Some(ref pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    if let Some(ref profile) = restore_profile {
        options = options.restore_profile(profile);
    }

    if let Some(ref name) = restore_profile_as {
        options = options.restore_profile_as(name);
    }

    if let Ok(result) = manager.backup().analyze(&backup_path)
        && result.format_version.parse::<u64>().unwrap_or(0) >= 1
    {
        return restore_rcman_backup(
            &backup_path,
            password,
            restore_profile,
            restore_profile_as,
            options,
            &manager,
            &app,
        )
        .await;
    }

    let file = File::open(&backup_path)
        .map_err(|e| crate::localized_error!("backendErrors.backup.openFailed", "error" => e))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(
        |e| crate::localized_error!("backendErrors.backup.invalidArchive", "error" => e),
    )?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| crate::localized_error!("backendErrors.backup.missingManifest"))?;

    let manifest_json: serde_json::Value = serde_json::from_reader(manifest_file).map_err(
        |e| crate::localized_error!("backendErrors.backup.manifestParseFailed", "error" => e),
    )?;

    let format = detect_manifest_format(&manifest_json);
    info!("Detected backup format via fallback: {format:?}");

    match format {
        BackupFormatVersion::Rcman => {
            restore_rcman_backup(
                &backup_path,
                password,
                restore_profile,
                restore_profile_as,
                options,
                &manager,
                &app,
            )
            .await
        }
        BackupFormatVersion::AppLegacy => {
            restore_legacy_backup(&backup_path, password, &manifest_json, &app).await
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
    _password: Option<String>,
    _restore_profile: Option<String>,
    _restore_profile_as: Option<String>,
    options: rcman::RestoreOptions,
    manager: &AppSettingsManager,
    app_handle: &AppHandle,
) -> Result<String, String> {
    info!("Restoring using rcman library...");

    if let Err(e) =
        super::backup_manager::register_rclone_config_provider(app_handle, manager).await
    {
        warn!("⚠️ Failed to register rclone.conf provider for restore: {e}");
    }

    let result = manager
        .backup()
        .restore(&options)
        .map_err(|e| crate::localized_error!("backendErrors.backup.restoreFailed", "error" => e))?;

    app_handle.emit(REMOTE_CACHE_CHANGED, ()).ok();

    if result.restored.iter().any(|s| s == "settings.json") {
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

    let mut remote_restore_count = 0;
    for item in &result.external_pending {
        if item.starts_with("remote:") {
            let remote_name = item.trim_start_matches("remote:");
            info!("📥 Attempting to restore external remote config: {remote_name}");

            let archive_filename = format!("{remote_name}_rclone.json");

            if let Ok(config_data) = manager.backup().get_external_config_from_backup(
                backup_path,
                &archive_filename,
                None,
            ) {
                let content =
                    String::from_utf8(config_data).map_err(|e| format!("Invalid UTF-8: {e}"))?;
                let parsed: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse config: {e}"))?;

                match upsert_remote_from_config(remote_name, parsed, app_handle).await {
                    Ok(()) => {
                        remote_restore_count += 1;
                        info!("✅ Restored remote: {remote_name}");
                    }
                    Err(e) => {
                        warn!("⚠️ Failed to restore remote '{remote_name}': {e}");
                    }
                }
            } else {
                warn!("⚠️ Could not read external config for: {item}");
            }
        }
    }

    let restored_count = result.restored.len() + remote_restore_count;
    let skipped_count = result.skipped.len();

    info!("✅ Restore complete: {restored_count} restored, {skipped_count} skipped");

    Ok(format!(
        "Settings restored successfully ({restored_count} items restored, {skipped_count} skipped)"
    ))
}

pub(super) async fn upsert_remote_from_config(
    remote_name: &str,
    mut config: serde_json::Value,
    app_handle: &AppHandle,
) -> Result<(), String> {
    if let Some(nested) = config.get(remote_name) {
        config = nested.clone();
    }

    if let Some(obj) = config.as_object_mut() {
        obj.insert("config_is_local".to_string(), json!("false"));
    }

    let config_map: HashMap<String, Value> =
        serde_json::from_value(config).map_err(|e| format!("Invalid config map format: {e}"))?;

    info!("🔄 Upserting remote '{remote_name}'...");

    if let Err(e) = update_remote(
        app_handle.clone(),
        remote_name.to_string(),
        config_map.clone(),
        None,
    )
    .await
    {
        debug!("Update failed (likely remote doesn't exist), attempting create: {e}");
        create_remote(
            app_handle.clone(),
            remote_name.to_string(),
            config_map,
            None,
        )
        .await
        .map_err(|e| format!("Failed to create remote '{remote_name}': {e}"))?;
    }

    Ok(())
}
