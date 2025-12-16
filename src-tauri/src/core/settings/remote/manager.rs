use log::{error, info, warn};
use serde_json::Value;
use std::{
    fs::{self, File, create_dir_all},
    io::Write,
};
use tauri::{AppHandle, Emitter, State};

use crate::utils::types::events::REMOTE_PRESENCE_CHANGED;
use crate::utils::types::settings::SettingsState;
use crate::{
    core::scheduler::engine::CronScheduler, rclone::state::scheduled_tasks::ScheduledTasksCache,
};

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
    cache: State<'_, ScheduledTasksCache>,
    scheduler: State<'_, CronScheduler>,
    app_handle: AppHandle,
) -> Result<(), String> {
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // Sanitize input: Migrate legacy keys in the incoming payload so they don't get merged back in.
    migrate_to_multi_profile(&mut settings);

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

        // Migrate legacy settings to ensure clean merge and scheduler compatibility
        migrate_to_multi_profile(&mut existing_settings);

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

    match cache
        .add_or_update_task_for_remote(&remote_name, &settings, scheduler)
        .await
    {
        Ok(_) => info!("✅ Scheduled tasks updated for remote '{remote_name}'"),
        Err(e) => warn!("⚠️  Failed to update scheduled tasks for remote '{remote_name}': {e}"),
    }

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
        return Err(format!("⚠️ Remote settings for '{remote_name}' not found.",));
    }

    let file_content = fs::read_to_string(&remote_config_path)
        .map_err(|e| format!("❌ Failed to read remote settings: {e}"))?;
    let mut settings: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|e| format!("❌ Failed to parse remote settings: {e}"))?;

    // Migrate legacy singular configs to profile arrays
    if migrate_to_multi_profile(&mut settings) {
        // Persist the clean settings back to disk immediately
        let json_string = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("❌ Failed to serialize cleaned settings: {e}"))?;

        let mut file = File::create(&remote_config_path)
            .map_err(|e| format!("❌ Failed to open settings file for cleanup: {e}"))?;

        file.write_all(json_string.as_bytes())
            .map_err(|e| format!("❌ Failed to write cleaned settings: {e}"))?;

        info!("💾 Persisted cleaned/migrated settings for remote '{remote_name}'");
    }

    info!("✅ Loaded settings for remote '{remote_name}'.");
    Ok(settings)
}

/// Helper to migrate legacy singular configs (e.g. mountConfig) to object-based configs (e.g. mountConfigs)
/// Returns true if any changes were made.
///
/// Migration: mountConfig: { source: "...", dest: "..." }
///         → mountConfigs: { "Default": { source: "...", dest: "..." } }
fn migrate_to_multi_profile(settings: &mut Value) -> bool {
    let mut changed = false;
    if let Some(obj) = settings.as_object_mut() {
        let migration_map = [
            ("mountConfig", "mountConfigs"),
            ("syncConfig", "syncConfigs"),
            ("copyConfig", "copyConfigs"),
            ("moveConfig", "moveConfigs"),
            ("bisyncConfig", "bisyncConfigs"),
            ("serveConfig", "serveConfigs"),
            ("filterConfig", "filterConfigs"),
            ("backendConfig", "backendConfigs"),
            ("vfsConfig", "vfsConfigs"),
        ];

        for (old_key, new_key) in migration_map {
            // Check if we need to migrate (if old key exists)
            if obj.contains_key(old_key)
                && let Some(mut old_config) = obj.remove(old_key)
            {
                changed = true;
                // Only create new object if it doesn't exist
                if !obj.contains_key(new_key) {
                    // Get profile name from config, or use "Default"
                    let profile_name = old_config
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Default")
                        .to_string();

                    // Remove 'name' property since it's now the object key
                    if let Some(config_obj) = old_config.as_object_mut() {
                        config_obj.remove("name");
                    }

                    // Create object-based structure: { "ProfileName": config }
                    let mut profiles_obj = serde_json::Map::new();
                    profiles_obj.insert(profile_name.clone(), old_config);
                    obj.insert(new_key.to_string(), Value::Object(profiles_obj));

                    info!(
                        "✨ Migrated legacy {} to {} (profile: '{}')",
                        old_key, new_key, profile_name
                    );
                } else {
                    // If new key already exists, simply dropping the old one is the safest clean-up
                    // as the new object structure takes precedence.
                    warn!(
                        "🗑️ Removed legacy {} as {} already exists",
                        old_key, new_key
                    );
                }
            }
        }
    }
    changed
}
