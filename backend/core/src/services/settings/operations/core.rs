//! Core settings operations using rcman

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use log::{debug, info};
use serde_json::json;

use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;

/// Load all settings with metadata (for UI)
pub async fn load_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let manager = app.state::<AppSettingsManager>();
    let metadata = manager
        .inner()
        .metadata()
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
    let manager = app.state::<AppSettingsManager>();
    manager
        .inner()
        .save_setting(&category, &key, &value)
        .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    if category == "general" && key == "language" {
        sync_interface_language(&app, manager.inner());
    }

    crate::services::bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: category.clone(),
            key: key.clone(),
            value: value.clone(),
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
    let manager = app.state::<AppSettingsManager>();
    let default_value = manager
        .inner()
        .reset_setting(&category, &key)
        .map_err(|e| crate::localized_error!("backendErrors.settings.resetFailed", "error" => e))?;

    if category == "general" && key == "language" {
        sync_interface_language(&app, manager.inner());
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
    let manager = app.state::<AppSettingsManager>();
    manager.inner().reset_all().map_err(
        |e| crate::localized_error!("backendErrors.settings.resetAllFailed", "error" => e),
    )?;

    sync_interface_language(&app, manager.inner());

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

fn sync_interface_language(app: &AppHandle, manager: &AppSettingsManager) {
    if let Some(access) = app.try_state::<std::sync::Arc<super::super::access::VaultAccess>>() {
        match manager.get::<String>("general.language") {
            Ok(language) => access.set_language(&language, manager.is_vault_enabled()),
            Err(error) => log::warn!("Could not refresh public language cache: {error}"),
        }
    }
}
