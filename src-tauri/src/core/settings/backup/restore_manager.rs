//! Restore management using rcman library

use crate::core::{bridge, settings::AppSettingsManager};
use crate::rclone::commands::remote::{create_remote, update_remote};
use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Manager};

// -----------------------------------------------------------------------------
// MAIN RESTORE COMMAND
// -----------------------------------------------------------------------------

#[bridge]
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

    restore_rcman_backup(&backup_path, options, &manager, &app, password.as_deref()).await
}

// -----------------------------------------------------------------------------
// RCMAN FORMAT RESTORE
// -----------------------------------------------------------------------------

async fn restore_rcman_backup(
    backup_path: &Path,
    options: rcman::RestoreOptions,
    manager: &AppSettingsManager,
    app_handle: &AppHandle,
    password: Option<&str>,
) -> Result<String, String> {
    info!("Restoring using rcman library...");

    if let Err(e) =
        super::backup_manager::register_rclone_config_provider(app_handle, manager).await
    {
        warn!("Failed to register rclone.conf provider for restore: {e}");
    }

    let result = manager
        .backup()
        .restore(&options)
        .map_err(|e| crate::localized_error!("backendErrors.backup.restoreFailed", "error" => e))?;

    // System refresh will be called at the very end of the process

    let mut remote_restore_count = 0;

    // Handle external rclone.conf restore to mobile device's active config path
    #[cfg(feature = "librclone")]
    if let Ok(config_data) = manager
        .backup()
        .get_external_config_from_backup(backup_path, "rclone.conf", password)
        .or_else(|_| {
            manager
                .backup()
                .get_external_config_from_backup(backup_path, "rclone_config", password)
        })
    {
        info!("Attempting to restore rclone.conf to mobile device config path");
        let target_path =
            match crate::rclone::queries::get_rclone_config_file(app_handle.clone()).await {
                Ok(path) => path,
                Err(_) => {
                    let paths = crate::core::paths::AppPaths::from_app_handle(app_handle)?;
                    paths.config_dir.join("rclone.conf")
                }
            };

        if let Some(parent) = target_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match std::fs::write(&target_path, &config_data) {
            Ok(_) => {
                use crate::utils::rclone::endpoints::config;
                remote_restore_count += 1;
                info!(
                    "Successfully restored rclone.conf to {}",
                    target_path.display()
                );
                let _ = crate::rclone::backend::rclone_ffi::rpc(&serde_json::json!({
                    "_path": config::SETPATH,
                    "path": target_path.to_string_lossy()
                }));
            }
            Err(e) => {
                warn!(
                    "Failed to write restored rclone.conf to {}: {e}",
                    target_path.display()
                );
            }
        }
    }

    for item in &result.external_pending {
        if item.starts_with("remote:") {
            let remote_name = item.trim_start_matches("remote:");
            info!("Attempting to restore external remote config: {remote_name}");

            let archive_filename = format!("{remote_name}_rclone.json");

            if let Ok(config_data) = manager.backup().get_external_config_from_backup(
                backup_path,
                &archive_filename,
                password,
            ) {
                let content =
                    String::from_utf8(config_data).map_err(|e| format!("Invalid UTF-8: {e}"))?;
                let parsed: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse config: {e}"))?;

                match upsert_remote_from_config(remote_name, parsed, app_handle).await {
                    Ok(()) => {
                        remote_restore_count += 1;
                        info!("Restored remote: {remote_name}");
                    }
                    Err(e) => {
                        warn!("Failed to restore remote '{remote_name}': {e}");
                    }
                }
            } else {
                warn!("Could not read external config for: {item}");
            }
        }
    }

    let restored_count = result.restored.len() + remote_restore_count;
    let skipped_count = result.skipped.len();

    // Perform a full system refresh to ensure all components pick up the restored state
    if let Err(e) = crate::core::initialization::refresh_system(app_handle.clone()).await {
        warn!("System refresh partially failed after restore: {e}");
    }

    info!("Restore complete: {restored_count} restored, {skipped_count} skipped");

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

    info!("Upserting remote '{remote_name}'...");

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
