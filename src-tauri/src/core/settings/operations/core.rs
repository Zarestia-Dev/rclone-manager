//! Core settings operations using rcman
//!
//! These commands use the rcman SettingsManager for settings operations.

use crate::core::settings::AppSettingsManager;
use log::info;
use serde_json::json;
use tauri::{Emitter, State};

use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;

/// Load all settings with metadata (for UI)
#[tauri::command]
pub async fn load_settings(
    manager: State<'_, AppSettingsManager>,
) -> Result<serde_json::Value, String> {
    let metadata = manager
        .inner()
        .metadata()
        .map_err(|e: rcman::Error| crate::localized_error!("backendErrors.settings.loadFailed", "error" => e))?;

    let response = json!({
        "options": metadata
    });

    info!("✅ Settings loaded and merged successfully.");
    Ok(response)
}

/// Save a single setting
#[tauri::command]
pub async fn save_setting(
    category: String,
    key: String,
    value: serde_json::Value,
    manager: State<'_, AppSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    manager
        .inner()
        .save_setting(&category, &key, &value)
        .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    // Emit strongly typed change event
    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            crate::utils::types::events::SettingsChangeEvent {
                category: category.clone(),
                key: key.clone(),
                value: value.clone(),
            },
        )
        .map_err(
            |e| crate::localized_error!("backendErrors.settings.eventEmitFailed", "error" => e),
        )?;

    info!("✅ Setting {}.{} saved successfully.", category, key);
    Ok(())
}

/// Reset a single setting to its default value
#[tauri::command]
pub async fn reset_setting(
    category: String,
    key: String,
    manager: State<'_, AppSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let default_value = manager
        .inner()
        .reset_setting(&category, &key)
        .map_err(|e| crate::localized_error!("backendErrors.settings.resetFailed", "error" => e))?;

    // Emit strongly typed change event
    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            crate::utils::types::events::SettingsChangeEvent {
                category: category.clone(),
                key: key.clone(),
                value: default_value.clone(),
            },
        )
        .map_err(|e| format!("Failed to emit settings change event: {e}"))?;

    info!("✅ Setting {}.{} reset to default.", category, key);
    Ok(default_value)
}

/// Reset all settings to defaults
#[tauri::command]
pub async fn reset_settings(
    manager: State<'_, AppSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    manager.inner().reset_all().map_err(
        |e| crate::localized_error!("backendErrors.settings.resetAllFailed", "error" => e),
    )?;

    // Emit event indicating a full reset
    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            crate::utils::types::events::SettingsChangeEvent {
                category: "*".to_string(),
                key: "*".to_string(),
                value: serde_json::Value::Null,
            },
        )
        .map_err(
            |e| crate::localized_error!("backendErrors.settings.eventEmitFailed", "error" => e),
        )?;

    info!("✅ All settings have been reset to default.");
    Ok(())
}
