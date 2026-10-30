//! Restore managed settings first, then reconcile opaque rclone imports and runtime state.

use super::rclone_externals::{
    deferred_remote, is_rclone_conf_id, rclone_conf_targets, remote_name,
};
use crate::context::AppHandle;
use crate::rclone::commands::remote::{create_remote, update_remote};
use crate::services::settings::AppSettingsManager;
use log::{debug, info};
use serde_json::{Value, json};
use std::collections::HashMap;

pub async fn restore_settings(
    app: AppHandle,
    backup_path: std::path::PathBuf,
    password: Option<String>,
    restore_profile: Option<String>,
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

    // Resolve the target before restoring settings that can change backend selection.
    let analysis = manager.backup().analyze(&backup_path).map_err(
        |e| crate::localized_error!("backendErrors.backup.restoreFailed", "error" => e.to_string()),
    )?;
    let external_ids = &analysis.manifest.contents.external_configs;
    let mut config_path = None;
    if external_ids.iter().any(|id| is_rclone_conf_id(id)) {
        let path = crate::rclone::queries::get_rclone_config_file(app.clone()).await?;
        for config in rclone_conf_targets(path.clone()) {
            options = options.external(config);
        }
        config_path = Some(path);
    }
    // Remote definitions go through rclone's async API after the restore.
    for id in external_ids.iter().filter(|id| remote_name(id).is_some()) {
        options = options.external(deferred_remote(id));
    }

    let worker_app = app.clone();
    let worker_options = options.clone();
    let restored = crate::utils::spawn_blocking(move || {
        worker_app
            .state::<AppSettingsManager>()
            .backup()
            .restore(&worker_options)
    })
    .await
    .map_err(|e| restore_failed(&e))
    .and_then(|result| result.map_err(|e| restore_error(&e)));

    let outcome = match restored {
        Ok(result) => {
            // Reload the active rclone config after the single rcman file replacement.
            let reload = if let Some(path) = config_path {
                state.transport.rpc(crate::rclone::endpoints::config::SETPATH, Some(&json!({ "path": path }))).await.map(|_| ())
                    .map_err(|error| crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => error.to_string()))
            } else {
                Ok(())
            };
            match reload {
                Ok(()) => import_deferred_remotes(&app, result).await,
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    // Even an error can follow a managed commit or an incomplete rollback.
    let refresh = crate::services::initialization::refresh_system(app.clone()).await;
    crate::services::settings::vault::emit_vault_state(&app, "restored");
    match (outcome, refresh) {
        (Ok(message), Ok(())) => Ok(message),
        (Err(error), Ok(())) => Err(error),
        (outcome, Err(error)) => Err(crate::localized_error!(
            "backendErrors.backup.refreshFailed", "error" => error,
            "restoreError" => outcome.err().unwrap_or_default()
        )),
    }
}

fn restore_failed(error: &dyn std::fmt::Display) -> String {
    crate::localized_error!("backendErrors.backup.restoreFailed", "error" => error.to_string())
}

/// The password cases get their own message so the restore dialog can show them
/// next to the password field.
fn restore_error(error: &rcman::Error) -> String {
    match error {
        rcman::Error::InvalidPassword => {
            crate::localized_error!("backendErrors.backup.wrongPassword")
        }
        rcman::Error::PasswordRequired => {
            crate::localized_error!("backendErrors.backup.passwordRequired")
        }
        other => restore_failed(other),
    }
}

/// The remote a deferred definition belongs to, and its config.
fn parse_deferred_remote(
    item: &rcman::backup::DeferredImport,
) -> Result<(&str, serde_json::Value), String> {
    let name = remote_name(&item.id).ok_or_else(|| item.id.clone())?;
    let config = serde_json::from_slice(&item.data).map_err(|e| e.to_string())?;
    Ok((name, config))
}

async fn import_deferred_remotes(
    app: &AppHandle,
    result: rcman::RestoreResult,
) -> Result<String, String> {
    let mut imported = 0;
    let mut errors = Vec::new();
    for item in &result.deferred {
        let imported_remote = match parse_deferred_remote(item) {
            Ok((name, config)) => upsert_remote_from_config(name, config, app).await,
            Err(error) => Err(error),
        };
        match imported_remote {
            Ok(()) => imported += 1,
            Err(error) => errors.push(format!("{}: {error}", item.id)),
        }
    }
    errors.extend(result.external_pending.iter().cloned());
    if !errors.is_empty() {
        return Err(
            crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => errors.join("; ")),
        );
    }
    let restored = result.restored.len() + imported;
    info!("Restore complete: {restored} items restored");
    Ok(crate::localized_success!(
        "backendSuccess.backup.restored",
        "count" => restored
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
        serde_json::from_value(config).map_err(|e| e.to_string())?;

    info!("Upserting remote '{remote_name}'...");

    if let Err(e) = update_remote(
        app_handle.clone(),
        remote_name.to_string(),
        config_map.clone(),
        None,
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
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcman::backup::DeferredImport;

    fn deferred(id: &str, data: &[u8]) -> DeferredImport {
        DeferredImport {
            id: id.into(),
            data: data.to_vec(),
        }
    }

    #[test]
    fn password_failures_have_their_own_messages() {
        assert_eq!(
            restore_error(&rcman::Error::InvalidPassword),
            "backendErrors.backup.wrongPassword"
        );
        assert_eq!(
            restore_error(&rcman::Error::PasswordRequired),
            "backendErrors.backup.passwordRequired"
        );
        let other = restore_error(&rcman::Error::InvalidBackup("bad".into()));
        let other: serde_json::Value = serde_json::from_str(&other).unwrap();
        assert_eq!(other["key"], "backendErrors.backup.restoreFailed");
        assert!(other["params"]["error"].as_str().unwrap().contains("bad"));
    }

    #[test]
    fn a_deferred_remote_yields_its_name_and_config() {
        let item = deferred("remote:drive", br#"{"drive":{"type":"drive"}}"#);
        let (name, config) = parse_deferred_remote(&item).unwrap();
        assert_eq!(name, "drive");
        assert_eq!(config["drive"]["type"], "drive");
    }

    #[test]
    fn malformed_or_foreign_deferred_items_are_errors() {
        assert!(parse_deferred_remote(&deferred("remote:drive", b"not json")).is_err());
        assert_eq!(
            parse_deferred_remote(&deferred("rclone.conf", b"{}")).unwrap_err(),
            "rclone.conf"
        );
    }
}
