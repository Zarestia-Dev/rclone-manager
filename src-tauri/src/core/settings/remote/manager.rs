use log::{error, info, warn};
use serde_json::Value;
use std::{
    fs::{self, File, create_dir_all},
    io::Write,
};
use tauri::{AppHandle, Emitter, State};

use crate::utils::types::events::REMOTE_PRESENCE_CHANGED;
use crate::utils::types::settings::SettingsState;

/// **Remote Settings Management**
///
/// This module handles remote-specific configuration operations:
/// - Saving remote configurations  
/// - Loading remote settings
/// - Deleting remote configurations
/// **Save remote settings (per remote)**
#[tauri::command]
pub async fn save_remote_settings(
    remote_name: String,
    mut settings: Value, // **Accepts dynamic JSON**
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<(), String> {
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // **Ensure config directory exists**
    if state.config_dir.exists() && !state.config_dir.is_dir() {
        fs::remove_file(&state.config_dir).map_err(|e| format!("❌ Failed to remove file: {e}"))?;
    }
    create_dir_all(&state.config_dir)
        .map_err(|e| format!("❌ Failed to create config dir: {e}"))?;

    let remote_config_dir = state.config_dir.join("remotes");
    let remote_config_path = remote_config_dir.join(format!("{remote_name}.json"));

    // **Ensure "remotes" directory exists**
    if remote_config_dir.exists() && !remote_config_dir.is_dir() {
        fs::remove_file(&remote_config_dir)
            .map_err(|e| format!("❌ Failed to remove file: {e}"))?;
    }
    create_dir_all(&remote_config_dir)
        .map_err(|e| format!("❌ Failed to create remotes directory: {e}"))?;

    // **Merge new settings with existing ones**
    if remote_config_path.exists() {
        let existing_content = fs::read_to_string(&remote_config_path)
            .map_err(|e| format!("❌ Failed to read existing settings: {e}"))?;
        let mut existing_settings: Value = serde_json::from_str(&existing_content)
            .map_err(|e| format!("❌ Failed to parse existing settings: {e}"))?;

        if let (Some(existing_obj), Some(new_obj)) =
            (existing_settings.as_object_mut(), settings.as_object_mut())
        {
            for (key, value) in new_obj {
                existing_obj.insert(key.clone(), value.clone());
            }
            settings = Value::Object(existing_obj.clone());
        }
    }

    // **Save to JSON file**
    let mut file = File::create(&remote_config_path)
        .map_err(|e| format!("❌ Failed to create settings file: {e}"))?;

    file.write_all(settings.to_string().as_bytes())
        .map_err(|e| format!("❌ Failed to save settings: {e}"))?;

    info!("✅ Remote settings saved at {remote_config_path:?}");

    app_handle.emit(REMOTE_PRESENCE_CHANGED, remote_name).ok();
    Ok(())
}

/// **Delete remote settings**
#[tauri::command]
pub async fn delete_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let remote_config_path = state
        .config_dir
        .join("remotes")
        .join(format!("{remote_name}.json"));

    if !remote_config_path.exists() {
        warn!("⚠️ Remote settings for '{remote_name}' not found, but that's okay.");
        // Don't return an error - just emit the event and return success
        app_handle.emit(REMOTE_PRESENCE_CHANGED, remote_name).ok();
        return Ok(()); // Return success instead of error
    }

    fs::remove_file(&remote_config_path).map_err(|e| {
        error!("❌ Failed to delete remote settings: {e}");
        format!("❌ Failed to delete remote settings: {e}")
    })?;

    info!("✅ Remote settings for '{remote_name}' deleted.");

    app_handle.emit(REMOTE_PRESENCE_CHANGED, remote_name).ok();
    Ok(())
}

/// **Retrieve settings for a specific remote**
#[tauri::command]
pub async fn get_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let remote_config_path = state
        .config_dir
        .join("remotes")
        .join(format!("{remote_name}.json"));

    if !remote_config_path.exists() {
        warn!("⚠️ Remote settings for '{remote_name}' not found.");
        return Err(format!("⚠️ Remote settings for '{remote_name}' not found.",));
    }

    let file_content = fs::read_to_string(&remote_config_path)
        .map_err(|e| format!("❌ Failed to read remote settings: {e}"))?;
    let settings: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|e| format!("❌ Failed to parse remote settings: {e}"))?;

    info!("✅ Loaded settings for remote '{remote_name}'.");
    Ok(settings)
}
