use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BACKEND_MANAGER;

/// Resolves profile settings for a given remote and profile name.
///
/// Returns a tuple containing:
/// 1. The specific profile configuration object (e.g., from `mountConfigs.my_profile`)
/// 2. The entire remote settings object (used for resolving nested profile references like `vfsProfile`)
///
/// # Arguments
/// * `app` - The Tauri AppHandle
/// * `remote_name` - The name of the remote
/// * `profile_name` - The name of the profile to load
/// * `config_key` - The key in settings to look for (e.g., "mountConfigs", "syncConfigs")
pub async fn resolve_profile_settings(
    app: &AppHandle,
    remote_name: &str,
    profile_name: &str,
    config_key: &str,
) -> Result<(Value, Value), String> {
    let backend_manager = &BACKEND_MANAGER;

    // backend_read deleted
    let cache = &backend_manager.remote_cache;

    let manager = app.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    let remote_names = cache.get_remotes().await;

    // We use the sync version of retrieving all settings because rcman's inner implementation
    // might block or be synchronous for this part, or at least that's how it was used in original code.
    let settings_map = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    let settings = settings_map
        .get(remote_name)
        .ok_or_else(|| format!("Remote '{}' not found in settings", remote_name))?;

    let configs = settings
        .get(config_key)
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No {} found for '{}'", config_key, remote_name))?;

    let config = configs
        .get(profile_name)
        .ok_or_else(|| format!("{} profile '{}' not found", config_key, profile_name))?;

    Ok((config.clone(), settings.clone()))
}
