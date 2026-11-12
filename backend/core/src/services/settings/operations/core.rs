//! Core settings operations using rcman

use std::sync::Arc;

use crate::context::AppHandle;
use crate::services::settings::access::VaultAccess;
use crate::services::settings::blocking;
use log::{debug, info};
use serde_json::json;

use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;

/// Load all settings with metadata (for UI)
pub async fn load_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let metadata = blocking(&app, |manager| manager.metadata())
        .await?
        .map_err(|e: rcman::Error| crate::localized_error!("backendErrors.settings.loadFailed", "error" => e))?;

    let response = json!({
        "options": metadata
    });

    debug!("Settings loaded and merged successfully.");
    Ok(response)
}

/// Save a single setting
pub async fn save_setting(
    app: AppHandle,
    category: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let (saved_category, saved_key, saved_value) = (category.clone(), key.clone(), value.clone());
    blocking(&app, move |manager| {
        manager.save_setting(&saved_category, &saved_key, &saved_value)
    })
    .await?
    .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    if category == "general" && key == "language" {
        sync_interface_language(&app).await;
    }

    crate::services::bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: category.clone(),
            key: key.clone(),
            value,
        },
    );

    info!("Setting {category}.{key} saved successfully.");
    Ok(())
}

/// Reset a single setting to its default value
pub async fn reset_setting(
    app: AppHandle,
    category: String,
    key: String,
) -> Result<serde_json::Value, String> {
    let (reset_category, reset_key) = (category.clone(), key.clone());
    let default_value = blocking(&app, move |manager| {
        manager.reset_setting(&reset_category, &reset_key)
    })
    .await?
    .map_err(|e| crate::localized_error!("backendErrors.settings.resetFailed", "error" => e))?;

    if category == "general" && key == "language" {
        sync_interface_language(&app).await;
    }

    crate::services::bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: category.clone(),
            key: key.clone(),
            value: default_value.clone(),
        },
    );

    info!("Setting {category}.{key} reset to default.");
    Ok(default_value)
}

/// Reset all settings to defaults
pub async fn reset_settings(app: AppHandle) -> Result<(), String> {
    let changes = blocking(&app, |manager| manager.reset_all())
        .await?
        .map_err(
            |e| crate::localized_error!("backendErrors.settings.resetAllFailed", "error" => e),
        )?;

    sync_interface_language(&app).await;

    crate::services::bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: "*".to_string(),
            key: "*".to_string(),
            value: reset_changes_payload(changes),
        },
    );

    info!("All settings have been reset to default.");
    Ok(())
}

/// The settings a reset changed, as `{"category.key": new value}`, so backend listeners
/// can apply them the way they apply a single saved setting.
fn reset_changes_payload(changes: Vec<rcman::SettingChange>) -> serde_json::Value {
    changes
        .into_iter()
        .map(|change| (change.key, change.new))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// Mirror the saved language into the public cache the locked screen reads.
async fn sync_interface_language(app: &AppHandle) {
    let Some(access) = app
        .try_state::<Arc<VaultAccess>>()
        .map(|access| Arc::clone(access.inner()))
    else {
        return;
    };
    let synced = blocking(app, move |manager| {
        match manager.get::<String>("general.language") {
            Ok(language) => access.set_language(&language, manager.is_vault_enabled()),
            Err(error) => log::warn!("Could not refresh public language cache: {error}"),
        }
    })
    .await;
    if let Err(error) = synced {
        log::warn!("Could not refresh public language cache: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(key: &str, old: serde_json::Value, new: serde_json::Value) -> rcman::SettingChange {
        rcman::SettingChange {
            key: key.to_string(),
            old,
            new,
        }
    }

    #[test]
    fn reset_payload_maps_each_changed_key_to_its_new_value() {
        let payload = reset_changes_payload(vec![
            change("general.tray_enabled", json!(false), json!(true)),
            change("developer.log_level", json!("debug"), json!("info")),
            change("core.bandwidth_limit", json!("10M & 旅行"), json!("")),
            change("core.rclone_additional_flags", json!(["-v"]), json!([])),
        ]);
        assert_eq!(
            payload,
            json!({
                "general.tray_enabled": true,
                "developer.log_level": "info",
                "core.bandwidth_limit": "",
                "core.rclone_additional_flags": [],
            })
        );
    }

    #[test]
    fn reset_payload_is_an_empty_object_when_nothing_changed() {
        assert_eq!(reset_changes_payload(Vec::new()), json!({}));
    }
}
