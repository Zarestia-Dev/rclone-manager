use crate::core::settings::AppSettingsManager;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;

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
    let backend_manager = app.state::<BackendManager>();

    let cache = &backend_manager.remote_cache;

    let manager = app.state::<AppSettingsManager>();
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

// ============================================================================
// SHARED TRAITS & HELPERS
// ============================================================================

use crate::utils::json_helpers::{get_string, json_to_hashmap, resolve_profile_options};
use serde_json::json;
use std::collections::HashMap;

/// Trait for creating parameter structs from configuration values
pub trait FromConfig: Sized {
    /// Create Params from a profile config and settings
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self>;
}

/// Common resolved parameters used by mount, sync, copy, etc.
pub struct CommonConfigParams {
    pub source: String,
    pub dest: String,
    pub options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

/// Helper to parse common configuration fields
pub fn parse_common_config(config: &Value, settings: &Value) -> Option<CommonConfigParams> {
    let source = get_string(config, &["source"]);
    // Mount dest is usually empty/different logic, but sync uses it.
    // Mount uses "dest" field for mountpoint? Let's check mount.rs.
    // Yes, mount.rs uses get_string(config, &["dest"]) for mount_point.
    // So "dest" key is consistent.
    let dest = get_string(config, &["dest"]);

    // If source is missing, we might fail early?
    // sync.rs: if source.is_empty() || dest.is_empty() { return None; }
    // mount.rs: if source.is_empty() || dest.is_empty() { return None; }
    // So "source" and "dest" are mandatory for these.
    if source.is_empty() {
        return None;
    }
    // dest can be empty for serve? serve.rs checks source and fs option.
    // For now let's make dest optional in this helper?
    // Or just require it and let serve handle itself (serve doesn't use FromConfig the same way entirely).

    // Let's stick to what Sync/Mount use. They both check both source and dest.
    if dest.is_empty() {
        return None;
    }

    let vfs_profile = config.get("vfsProfile").and_then(|v| v.as_str());
    let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
    let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

    let vfs_options = resolve_profile_options(settings, vfs_profile, "vfsConfigs");
    let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
    let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

    Some(CommonConfigParams {
        source,
        dest,
        options: json_to_hashmap(config.get("options")),
        vfs_options,
        filter_options,
        backend_options,
        profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
    })
}

/// Redact sensitive values from parameters for logging
/// Reads restrict setting from AppSettingsManager internally
pub fn redact_sensitive_values(params: &HashMap<String, Value>, app: &AppHandle) -> Value {
    let restrict_enabled: bool = app
        .try_state::<AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.restrict").ok())
        .unwrap_or(false);

    let sensitive_keys = crate::utils::types::core::SENSITIVE_KEYS;

    params
        .iter()
        .map(|(k, v)| {
            let value = if restrict_enabled
                && sensitive_keys
                    .iter()
                    .any(|sk| k.to_lowercase().contains(sk))
            {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect()
}
