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

use crate::rclone::backend::types::Backend;
use crate::utils::json_helpers::{get_string, json_to_hashmap, resolve_profile_options};
use serde_json::{Map, json};
use std::collections::HashMap;

/// Helper to determine the correct URL for configuration operations
/// Handles the difference between Local (uses OAuth port) and Remote (uses API port) backends
pub fn get_config_url(backend: &Backend, operation: &str) -> Result<String, String> {
    if backend.is_local {
        backend
            .oauth_url_for(operation)
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))
    } else {
        Ok(backend.url_for(operation))
    }
}

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
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

fn normalize_runtime_remote_profile_options(
    remote_name: &str,
    options: HashMap<String, Value>,
) -> HashMap<String, Value> {
    // UI saves flat options for runtime remote profiles.
    // RC override resolution expects options keyed by remote name.
    if options
        .get(remote_name)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        return options;
    }

    let mut wrapped = HashMap::new();
    wrapped.insert(
        remote_name.to_string(),
        Value::Object(options.into_iter().collect()),
    );
    wrapped
}

pub fn fs_value_with_runtime_overrides(
    fs: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Value {
    let Some(overrides) = runtime_remote_options else {
        return Value::String(fs.to_string());
    };

    let Some(parsed_fs) = parse_fs(fs) else {
        return Value::String(fs.to_string());
    };

    let (lookup_keys, mut fs_obj) = match parsed_fs {
        ParsedFs::Named { remote_name, root } => (
            vec![remote_name.clone(), format!("{}:", remote_name)],
            Map::from_iter([
                ("_name".to_string(), Value::String(remote_name)),
                ("_root".to_string(), Value::String(root)),
            ]),
        ),
        ParsedFs::Backend { backend_type, root } => (
            vec![format!(":{}", backend_type), backend_type.clone()],
            Map::from_iter([
                ("type".to_string(), Value::String(backend_type)),
                ("_root".to_string(), Value::String(root)),
            ]),
        ),
    };

    let remote_override = lookup_keys
        .iter()
        .find_map(|key| overrides.get(key))
        .and_then(|value| value.as_object());

    let Some(remote_override) = remote_override else {
        return Value::String(fs.to_string());
    };

    if remote_override.is_empty() {
        return Value::String(fs.to_string());
    }

    for (key, value) in remote_override {
        fs_obj.insert(key.clone(), value.clone());
    }

    Value::Object(fs_obj)
}

enum ParsedFs {
    Named { remote_name: String, root: String },
    Backend { backend_type: String, root: String },
}

fn parse_fs(fs: &str) -> Option<ParsedFs> {
    if fs.is_empty() {
        return None;
    }

    // Windows local paths like C:\foo or C:/foo are not rclone remotes.
    if fs.len() > 2 {
        let mut chars = fs.chars();
        let first = chars.next()?;
        let second = chars.next()?;
        let third = chars.next()?;
        if first.is_ascii_alphabetic() && second == ':' && (third == '\\' || third == '/') {
            return None;
        }
    }

    // Backend style remote: :local:/tmp or :s3,region=us-east-1:/bucket
    if let Some(rest) = fs.strip_prefix(':') {
        let split_idx = rest.find(':')?;
        let backend_with_opts = &rest[..split_idx];
        let backend_type = backend_with_opts
            .split(',')
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let root = rest[split_idx + 1..].to_string();

        return Some(ParsedFs::Backend { backend_type, root });
    }

    // Named remote: remote:path
    let split_idx = fs.find(':')?;
    let remote_name = fs[..split_idx].trim();
    if remote_name.is_empty() {
        return None;
    }

    let root = fs[split_idx + 1..].to_string();
    Some(ParsedFs::Named {
        remote_name: remote_name.to_string(),
        root,
    })
}

/// Helper to parse common configuration fields
pub fn parse_common_config(
    config: &Value,
    settings: &Value,
    remote_name: &str,
) -> Option<CommonConfigParams> {
    let source = get_string(config, &["source"]);
    let dest = get_string(config, &["dest"]);

    if source.is_empty() {
        return None;
    }
    if dest.is_empty() {
        return None;
    }

    let vfs_profile = config.get("vfsProfile").and_then(|v| v.as_str());
    let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
    let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());
    let vfs_options = resolve_profile_options(settings, vfs_profile, "vfsConfigs");
    let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
    let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");
    let runtime_remote_options =
        resolve_runtime_remote_options(config, settings, remote_name, "remotes");

    Some(CommonConfigParams {
        source,
        dest,
        options: json_to_hashmap(config.get("options")),
        vfs_options,
        filter_options,
        backend_options,
        runtime_remote_options,
        profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
    })
}

pub fn resolve_runtime_remote_options(
    config: &Value,
    settings: &Value,
    remote_name: &str,
    inline_remotes_key: &str,
) -> Option<HashMap<String, Value>> {
    let runtime_remote_profile = config.get("runtimeRemoteProfile").and_then(|v| v.as_str());

    let profile_runtime_remote_options =
        resolve_profile_options(settings, runtime_remote_profile, "runtimeRemoteConfigs").and_then(
            |opts| {
                if opts.is_empty() {
                    None
                } else {
                    Some(normalize_runtime_remote_profile_options(remote_name, opts))
                }
            },
        );
    let inline_runtime_remote_options = json_to_hashmap(config.get(inline_remotes_key));

    match (
        profile_runtime_remote_options,
        inline_runtime_remote_options,
    ) {
        (Some(mut profile_opts), Some(inline_opts)) => {
            profile_opts.extend(inline_opts);
            Some(profile_opts)
        }
        (Some(profile_opts), None) => Some(profile_opts),
        (None, Some(inline_opts)) => Some(inline_opts),
        (None, None) => None,
    }
}

/// Redact sensitive values from parameters for logging
/// Reads restrict setting from AppSettingsManager internally
pub fn redact_sensitive_values(params: &HashMap<String, Value>, app: &AppHandle) -> Value {
    let restrict_enabled: bool = app
        .try_state::<AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.restrict").ok())
        .unwrap_or(false);

    params
        .iter()
        .map(|(k, v)| {
            let value = if restrict_enabled && crate::utils::types::core::is_sensitive_field(k) {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect()
}
