//! Core settings operations using rcman

use crate::core::{bridge, settings::AppSettingsManager};
use log::{debug, info};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;

/// Load all settings with metadata (for UI)
#[bridge]
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
#[bridge]
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

    crate::core::bridge::emit(
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
#[bridge]
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

    crate::core::bridge::emit(
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
#[bridge]
pub async fn reset_settings(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    manager.inner().reset_all().map_err(
        |e| crate::localized_error!("backendErrors.settings.resetAllFailed", "error" => e),
    )?;

    crate::core::bridge::emit(
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
