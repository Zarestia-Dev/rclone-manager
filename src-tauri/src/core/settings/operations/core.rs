//! Core settings operations using rcman
//!
//! These commands use the rcman SettingsManager for settings operations.

use crate::core::settings::schema::AppSettings;
use log::info;
use rcman::JsonSettingsManager;
use serde_json::json;
use tauri::{Emitter, State};

use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;

/// Load all settings with metadata (for UI)
#[tauri::command]
pub async fn load_settings(
    manager: State<'_, JsonSettingsManager>,
) -> Result<serde_json::Value, String> {
    let metadata = manager
        .inner()
        .load_settings::<AppSettings>()
        .map_err(|e| format!("Failed to load settings: {e}"))?;

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
    manager: State<'_, JsonSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    manager
        .inner()
        .save_setting::<AppSettings>(&category, &key, value.clone())
        .map_err(|e| format!("Failed to save setting: {e}"))?;

    // Emit change event for UI updates
    let change_payload = json!({ category.clone(): { key.clone(): value } });
    app_handle
        .emit(SYSTEM_SETTINGS_CHANGED, change_payload)
        .map_err(|e| format!("Failed to emit settings change event: {e}"))?;

    info!("✅ Setting {}.{} saved successfully.", category, key);
    Ok(())
}

/// Reset a single setting to its default value
#[tauri::command]
pub async fn reset_setting(
    category: String,
    key: String,
    manager: State<'_, JsonSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let default_value = manager
        .inner()
        .reset_setting::<AppSettings>(&category, &key)
        .map_err(|e| format!("Failed to reset setting: {e}"))?;

    // Emit change event
    let change_payload = json!({ category.clone(): { key.clone(): default_value.clone() } });
    app_handle
        .emit(SYSTEM_SETTINGS_CHANGED, change_payload)
        .map_err(|e| format!("Failed to emit settings change event: {e}"))?;

    info!("✅ Setting {}.{} reset to default.", category, key);
    Ok(default_value)
}

/// Reset all settings to defaults
#[tauri::command]
pub async fn reset_settings(
    manager: State<'_, JsonSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    manager
        .inner()
        .reset_all()
        .map_err(|e| format!("Failed to reset all settings: {e}"))?;

    // Emit event with default settings
    let default_settings = AppSettings::default();
    app_handle
        .emit(SYSTEM_SETTINGS_CHANGED, &default_settings)
        .map_err(|e| format!("Failed to emit settings reset event: {e}"))?;

    info!("✅ All settings have been reset to default.");
    Ok(())
}

/// Load startup settings (blocking, for initialization)
pub fn load_startup_settings(manager: &JsonSettingsManager) -> Result<AppSettings, String> {
    manager
        .load_startup::<AppSettings>()
        .map_err(|e| format!("Failed to load startup settings: {e}"))
}
