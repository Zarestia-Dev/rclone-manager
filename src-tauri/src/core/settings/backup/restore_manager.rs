//! Restore managed settings first, then reconcile opaque rclone imports and runtime state.

use crate::core::{bridge, settings::AppSettingsManager};
use crate::rclone::commands::remote::{create_remote, update_remote};
use crate::utils::context::{AppHandle, Manager};
use log::{debug, info};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

#[bridge]
pub async fn restore_settings(
    app: AppHandle,
    backup_path: std::path::PathBuf,
    password: Option<String>,
    restore_profile: Option<String>,
    restore_profile_as: Option<String>,
) -> Result<String, String> {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    let _operation = state.vault_operation_lock.lock().await;
    let manager = app.state::<AppSettingsManager>();
    if manager.is_locked() {
        return Err(
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => rcman::Error::ConfigLocked),
        );
    }
    let mut options = rcman::RestoreOptions::from_path(&backup_path)
        .restore_settings(true)
        .overwrite(true)
        .verify_checksum(true);
    options.password = password
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    options.restore_profile = restore_profile;
    options.restore_profile_as = restore_profile_as;

    // Resolve the target before restoring settings that can change backend selection.
    let analysis = manager.backup().analyze(&backup_path).map_err(
        |e| crate::localized_error!("backendErrors.backup.restoreFailed", "error" => e.to_string()),
    )?;
    let provider = app.state::<super::rclone_config_provider::RcloneConfigProvider>();
    provider.replace(super::rclone_config_provider::RcloneConfigProvider::default());
    let mut config_path = None;
    if analysis
        .manifest
        .contents
        .external_configs
        .iter()
        .any(|id| matches!(id.as_str(), "rclone.conf" | "rclone_config"))
    {
        let path = crate::rclone::queries::get_rclone_config_file(app.clone()).await?;
        provider.replace(
            super::rclone_config_provider::RcloneConfigProvider::for_restore(path.clone()),
        );
        config_path = Some(path);
    }

    let worker_app = app.clone();
    let worker_options = options.clone();
    let restored = crate::utils::spawn_blocking(move || {
        worker_app
            .state::<AppSettingsManager>()
            .backup()
            .restore(&worker_options)
    })
    .await;
    provider.replace(super::rclone_config_provider::RcloneConfigProvider::default());
    let restored = restored
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| e.to_string()));

    let outcome = match restored {
        Ok(result) => {
            // Reload the active rclone config after the single rcman file replacement.
            let reload = if let Some(path) = config_path {
                state.transport.rpc(crate::utils::rclone::endpoints::config::SETPATH, Some(&json!({ "path": path }))).await.map(|_| ())
                    .map_err(|error| crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => error.to_string()))
            } else {
                Ok(())
            };
            match reload {
                Ok(()) => restore_external_remotes(&app, &options, result).await,
                Err(error) => Err(error),
            }
        }
        Err(error) => {
            Err(crate::localized_error!("backendErrors.backup.restoreFailed", "error" => error))
        }
    };
    // Even an error can follow a managed commit or an incomplete rollback.
    let refresh = crate::core::initialization::refresh_system(app.clone()).await;
    crate::core::settings::vault::emit_vault_state(manager.inner(), "restored");
    match (outcome, refresh) {
        (Ok(message), Ok(())) => Ok(message),
        (Err(error), Ok(())) => Err(error),
        (outcome, Err(error)) => Err(crate::localized_error!(
            "backendErrors.backup.refreshFailed", "error" => error,
            "restoreError" => outcome.err().unwrap_or_default()
        )),
    }
}

// Read-only providers and unresolved IDs both require the application's async RC API.
fn remote_import_ids(result: &rcman::RestoreResult) -> BTreeSet<&str> {
    result
        .external_pending
        .iter()
        .map(String::as_str)
        .chain(
            result
                .skipped_details
                .iter()
                .filter(|item| item.reason == rcman::RestoreSkipReason::ReadOnlyImportTarget)
                .map(|item| item.id.as_str()),
        )
        .filter(|id| id.starts_with("remote:"))
        .collect()
}

async fn restore_external_remotes(
    app: &AppHandle,
    options: &rcman::RestoreOptions,
    result: rcman::RestoreResult,
) -> Result<String, String> {
    let mut imported = 0;
    let mut errors = Vec::new();
    for id in remote_import_ids(&result) {
        let name = id.strip_prefix("remote:").unwrap_or_default();
        let worker_app = app.clone();
        let path = options.backup_path.clone();
        let password = options.password.clone();
        let config_id = id.to_owned();
        let data = crate::utils::spawn_blocking(move || {
            worker_app
                .state::<AppSettingsManager>()
                .backup()
                .get_external_config_from_backup(&path, &config_id, password.as_deref())
        })
        .await;
        let parsed = data
            .map_err(|e| e.to_string())
            .and_then(|data| data.map_err(|e| e.to_string()))
            .and_then(|data| serde_json::from_slice(&data).map_err(|e| e.to_string()));
        let imported_remote = match parsed {
            Ok(value) => upsert_remote_from_config(name, value, app).await,
            Err(error) => Err(error),
        };
        match imported_remote {
            Ok(()) => imported += 1,
            Err(error) => errors.push(format!("{id}: {error}")),
        }
    }
    for id in &result.external_pending {
        if !id.starts_with("remote:") {
            errors.push(id.clone());
        }
    }
    if !errors.is_empty() {
        return Err(
            crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => errors.join("; ")),
        );
    }
    let restored = result.restored.len() + imported;
    info!("Restore complete: {restored} items restored");
    Ok(format!(
        "Settings restored successfully ({restored} items restored)"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_imports_include_read_only_and_pending_but_not_conflicts() {
        let result = rcman::RestoreResult {
            external_pending: vec!["remote:one".into(), "unknown".into()],
            skipped_details: vec![
                rcman::RestoreSkippedItem {
                    id: "remote:two".into(),
                    reason: rcman::RestoreSkipReason::ReadOnlyImportTarget,
                },
                rcman::RestoreSkippedItem {
                    id: "remote:one".into(),
                    reason: rcman::RestoreSkipReason::ReadOnlyImportTarget,
                },
                rcman::RestoreSkippedItem {
                    id: "remote:conflict".into(),
                    reason: rcman::RestoreSkipReason::ExistsConflict,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            remote_import_ids(&result).into_iter().collect::<Vec<_>>(),
            ["remote:one", "remote:two"]
        );
        assert!(remote_import_ids(&rcman::RestoreResult::default()).is_empty());
    }
}
