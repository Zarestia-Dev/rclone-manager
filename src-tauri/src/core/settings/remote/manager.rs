//! Remote settings management using rcman sub-settings
//!
//! This module handles remote-specific configuration operations using
//! rcman's sub-settings system, which stores each remote's config in
//! `config/remotes/{remoteName}.json`.

use crate::core::{bridge, settings::AppSettingsManager};
use log::{info, warn};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::rclone::state::automations::AutomationsCache;
use crate::utils::types::events::{AUTOMATIONS_CACHE_CHANGED, REMOTE_SETTINGS_CHANGED};
use crate::utils::types::remotes::OperationType;

/// **Save remote settings (per remote)**
#[bridge]
pub async fn save_remote_settings(
    app: AppHandle,
    remote_name: String,
    mut settings: Value,
) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();

    // Insert name into settings
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // Get remotes sub-settings
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    // Fetch existing settings once
    let existing = remotes.get_value(&remote_name).ok();

    // Check if remote already exists and merge settings
    if let Some(existing_obj) = existing.as_ref().and_then(|v| v.as_object())
        && let Some(new_obj) = settings.as_object_mut()
    {
        let mut merged = existing_obj.clone();
        merged.append(new_obj);
        settings = Value::Object(merged);
    }

    // Validate the settings structure and canonicalize it
    let parsed: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(settings)
        .map_err(|e| format!("Invalid remote settings structure: {e}"))?;

    let cleaned_settings = serde_json::to_value(&parsed)
        .map_err(|e| format!("Failed to serialize remote settings: {e}"))?;

    // Save to rcman sub-settings
    remotes
        .set(&remote_name, &cleaned_settings)
        .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    info!("Remote settings saved for '{remote_name}'");

    // Detect deleted profiles
    if let Some(ref existing_val) = existing {
        for config_key in OperationType::ALL {
            let key = config_key.config_key();
            if let Some(old_configs) = existing_val.get(key).and_then(|v| v.as_object()) {
                let new_configs = cleaned_settings.get(key).and_then(|v| v.as_object());
                for profile_name in old_configs.keys() {
                    let was_deleted = new_configs.is_none_or(|new| !new.contains_key(profile_name));

                    if was_deleted {
                        info!(
                            "Profile '{profile_name}' deleted for remote '{remote_name}', cleaning up jobs..."
                        );
                        app.state::<crate::rclone::backend::BackendManager>()
                            .job_cache
                            .delete_jobs_by_profile(&remote_name, profile_name, Some(&app))
                            .await;
                    }
                }
            }
        }
    }

    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    match cache
        .add_or_update_automation_for_remote(&backend_name, &remote_name, &cleaned_settings)
        .await
    {
        Ok(result) if result.has_changes() => {
            use crate::core::automation::engine::AutomationScheduler;
            let scheduler = app.state::<AutomationScheduler>();
            if let Err(e) = scheduler.apply_cache_result(&result, cache).await {
                warn!("Automation sync incomplete for remote '{remote_name}': {e}");
            } else {
                info!("Automation updated for remote '{remote_name}'");
            }

            let watcher_manager = app.state::<crate::core::automation::watcher::WatcherManager>();
            if let Err(e) = watcher_manager.sync_watchers(app.clone()).await {
                warn!("Watcher sync incomplete for remote '{remote_name}': {e}");
            }

            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "remote_settings_update");
        }
        _ => {}
    }

    app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Delete remote settings**
#[bridge]
pub async fn delete_remote_settings(app: AppHandle, remote_name: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    if remotes.get_value(&remote_name).is_err() {
        warn!("Remote settings for '{remote_name}' not found, but that's okay.");
        app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
        return Ok(());
    }

    remotes.delete(&remote_name).map_err(
        |e| crate::localized_error!("backendErrors.settings.deleteFailed", "error" => e),
    )?;

    info!("Remote settings for '{remote_name}' deleted.");
    app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Get all remote settings as a map (for internal use)**
pub fn get_all_remote_settings_sync(
    manager: &AppSettingsManager,
    remote_names: &[String],
) -> serde_json::Value {
    let all_settings =
        crate::utils::types::remotes::RemoteSettings::load_all(manager, remote_names);
    serde_json::to_value(all_settings).unwrap_or_default()
}
