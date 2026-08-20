//! User Preset Templates persistence commands using rcman sub-settings

use std::collections::HashMap;

use crate::core::settings::AppSettingsManager;
use crate::utils::constants::SUB_TEMPLATES;
use log::info;
use tauri::{AppHandle, Manager};

/// List all saved user preset templates as a dictionary map (id -> payload)
#[tauri::command]
pub async fn list_user_templates(
    app: AppHandle,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let manager = app.state::<AppSettingsManager>();
    let sub = manager
        .sub_settings(SUB_TEMPLATES)
        .map_err(|e| e.to_string())?;

    Ok(sub.get_all_values().unwrap_or_default())
}

/// Save a new user preset template by id and payload
#[tauri::command]
pub async fn save_user_template(
    app: AppHandle,
    id: String,
    template: serde_json::Value,
) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let sub = manager
        .sub_settings(SUB_TEMPLATES)
        .map_err(|e| e.to_string())?;

    sub.set(&id, &template)
        .map_err(|e| format!("Failed to save user template: {e}"))?;

    info!("User template {id} saved via rcman.");
    Ok(())
}

/// Update an existing user preset template by id and payload
#[tauri::command]
pub async fn update_user_template(
    app: AppHandle,
    id: String,
    template: serde_json::Value,
) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let sub = manager
        .sub_settings(SUB_TEMPLATES)
        .map_err(|e| e.to_string())?;

    sub.set(&id, &template)
        .map_err(|e| format!("Failed to update user template: {e}"))?;

    info!("User template {id} updated via rcman.");
    Ok(())
}

/// Delete a user preset template by id
#[tauri::command]
pub async fn delete_user_template(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let sub = manager
        .sub_settings(SUB_TEMPLATES)
        .map_err(|e| e.to_string())?;

    sub.delete(&id)
        .map_err(|e| format!("Failed to delete user template: {e}"))?;

    info!("User template {id} deleted via rcman.");
    Ok(())
}
