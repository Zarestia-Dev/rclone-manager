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
    blocking(&app, |manager| manager.reset_all())
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
            value: serde_json::Value::Null,
        },
    );

    info!("All settings have been reset to default.");
    Ok(())
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
