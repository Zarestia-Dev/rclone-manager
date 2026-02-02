//! Remote settings management using rcman sub-settings
//!
//! This module handles remote-specific configuration operations using
//! rcman's sub-settings system, which stores each remote's config in
//! `config/remotes/{remoteName}.json`.
//!
//! Migration from legacy formats is handled automatically by rcman's
//! `with_migrator()` feature when loading entries.

use crate::core::settings::AppSettingsManager;
use log::{info, warn};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::utils::types::events::REMOTE_SETTINGS_CHANGED;
use crate::{
    core::scheduler::engine::CronScheduler, rclone::state::scheduled_tasks::ScheduledTasksCache,
};

/// **Save remote settings (per remote)**
#[tauri::command]
pub async fn save_remote_settings(
    remote_name: String,
    mut settings: Value,
    manager: State<'_, AppSettingsManager>,
    cache: State<'_, ScheduledTasksCache>,
    scheduler: State<'_, CronScheduler>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // Insert name into settings
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // Get remotes sub-settings
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    // Check if remote already exists and merge settings
    // Note: get_value runs the registered migrator automatically
    if let Ok(existing) = remotes.get_value(&remote_name) {
        // Merge new settings on top of existing (already migrated by rcman)
        if let (Some(existing_obj), Some(new_obj)) = (existing.as_object(), settings.as_object()) {
            let mut merged = existing_obj.clone();
            for (key, value) in new_obj {
                merged.insert(key.clone(), value.clone());
            }
            settings = Value::Object(merged);
        }
    }

    // Save to rcman sub-settings
    remotes
        .set(&remote_name, &settings)
        .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    info!("✅ Remote settings saved for '{remote_name}'");

    // Update scheduled tasks
    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    match cache
        .add_or_update_task_for_remote(
            cache.clone(),
            &backend_name,
            &remote_name,
            &settings,
            scheduler,
        )
        .await
    {
        Ok(_) => info!("✅ Scheduled tasks updated for remote '{remote_name}'"),
        Err(e) => warn!("⚠️  Failed to update scheduled tasks for remote '{remote_name}': {e}"),
    }

    app_handle.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Delete remote settings**
#[tauri::command]
pub async fn delete_remote_settings(
    remote_name: String,
    manager: State<'_, AppSettingsManager>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    // Check if exists first
    if remotes.get_value(&remote_name).is_err() {
        warn!("⚠️ Remote settings for '{remote_name}' not found, but that's okay.");
        app_handle.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
        return Ok(());
    }

    remotes.delete(&remote_name).map_err(
        |e| crate::localized_error!("backendErrors.settings.deleteFailed", "error" => e),
    )?;

    info!("✅ Remote settings for '{remote_name}' deleted.");
    app_handle.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Retrieve settings for a specific remote**
///
/// The registered migrator runs automatically when loading, so legacy
/// format migration is handled transparently by rcman.
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn get_remote_settings(
    remote_name: String,
    manager: State<'_, AppSettingsManager>,
) -> Result<serde_json::Value, String> {
    let remotes = manager
        .inner()
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to get remotes sub-settings: {e}"))?;

    // Migration is handled automatically by rcman's registered migrator
    let settings = remotes.get_value(&remote_name).map_err(
        |_| crate::localized_error!("backendErrors.settings.notFound", "name" => remote_name),
    )?;

    info!("✅ Loaded settings for remote '{remote_name}'.");
    Ok(settings)
}

/// **Get all remote settings as a map (for internal use)**
///
/// This is used by modules like scheduler, startup, and sync that need
/// to access all remote settings at once.
pub fn get_all_remote_settings_sync(
    manager: &AppSettingsManager,
    remote_names: &[String],
) -> serde_json::Value {
    let remotes = match manager.sub_settings("remotes") {
        Ok(r) => r,
        Err(_) => return serde_json::json!({}),
    };

    let mut all_settings = serde_json::Map::new();
    for remote_name in remote_names {
        if let Ok(settings) = remotes.get_value(remote_name) {
            all_settings.insert(remote_name.clone(), settings);
        }
    }

    serde_json::Value::Object(all_settings)
}

/// Migrator to convert legacy singular configs to object-based configs.
///
/// This is registered with rcman's `with_migrator()` and runs automatically
/// when loading remote settings entries.
///
/// Migration: `mountConfig: { source: "...", dest: "..." }`
///         → `mountConfigs: { "Default": { source: "...", dest: "..." } }`
pub fn migrate_to_multi_profile(mut settings: Value) -> Value {
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
            if obj.contains_key(old_key)
                && let Some(mut old_config) = obj.remove(old_key)
            {
                if !obj.contains_key(new_key) {
                    let profile_name = old_config
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Default")
                        .to_string();

                    if let Some(config_obj) = old_config.as_object_mut() {
                        config_obj.remove("name");
                    }

                    let mut profiles_obj = serde_json::Map::new();
                    profiles_obj.insert(profile_name.clone(), old_config);
                    obj.insert(new_key.to_string(), Value::Object(profiles_obj));

                    info!(
                        "✨ Migrated legacy {} to {} (profile: '{}')",
                        old_key, new_key, profile_name
                    );
                } else {
                    warn!(
                        "🗑️ Removed legacy {} as {} already exists",
                        old_key, new_key
                    );
                }
            }
        }
    }
    settings
}
