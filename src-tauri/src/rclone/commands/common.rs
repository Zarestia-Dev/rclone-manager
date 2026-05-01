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
/// * `app` - The Tauri `AppHandle`
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

    let settings_map = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    let settings = settings_map
        .get(remote_name)
        .ok_or_else(|| format!("Remote '{remote_name}' not found in settings"))?;

    let configs = settings
        .get(config_key)
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No {config_key} found for '{remote_name}'"))?;

    let config = configs
        .get(profile_name)
        .ok_or_else(|| format!("{config_key} profile '{profile_name}' not found"))?;

    Ok((config.clone(), settings.clone()))
}

// ============================================================================
// SHARED TRAITS & HELPERS
// ============================================================================

use crate::rclone::backend::types::Backend;
use crate::utils::json_helpers::{
    get_string, interpolate_value, json_to_hashmap, resolve_profile_options,
};
use crate::utils::types::core::RcloneState;
use serde_json::{Map, json};
use std::collections::HashMap;

/// Determines if the given fs path is a directory using operations/list.
///
/// This is a lightweight check that uses optimized flags to minimize overhead.
pub async fn is_directory(
    app: &AppHandle,
    fs: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Result<bool, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let state = app.state::<RcloneState>();

    let fs_val = fs_value_with_runtime_overrides(fs, runtime_remote_options);
    let url = backend.url_for(crate::utils::rclone::endpoints::operations::LIST);

    // Optimized options for speed
    let payload = json!({
        "fs": fs_val,
        "remote": "",
        "opt": {
            "metadata": false,
            "noModTime": true,
            "noMimeType": true,
            "recurse": false,
        }
    });

    let resp = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error during type resolution: {e}"))?;

    if !resp.status().is_success() {
        // If the path doesn't exist or there is an error, we assume it's not a directory
        // or return the error if it's a critical failure.
        return Ok(false);
    }

    let val: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse type resolution response: {e}"))?;

    let list = val
        .get("list")
        .and_then(|l| l.as_array())
        .ok_or_else(|| "Invalid response format from operations/list".to_string())?;

    // If listing returned nothing, it might be an empty directory or non-existent.
    if list.is_empty() {
        // We fallback to checking if it's a directory by trying to list its parent?
        // Actually, rclone lsjson on an empty directory returns [].
        // On a file it returns [{...}].
        // To be safe, if it's empty, we'll assume it's a directory (or at least not a file we can copy individually).
        return Ok(true);
    }

    // If it's a file, rclone returns one item with Path: "" (since we used fs as the full path)
    // or the filename if we used fs as parent.
    // Here we check if any item is a directory.
    let any_is_dir = list
        .iter()
        .any(|item| item.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false));

    // If the list has more than one item, it's definitely a directory.
    if list.len() > 1 || any_is_dir {
        return Ok(true);
    }

    // If there is exactly one item, check if its Path is non-empty.
    // If Path is non-empty, it's a child of the directory we requested -> it's a directory.
    // If Path is empty, it's the file itself.
    if let Some(first) = list.first() {
        let path = first.get("Path").and_then(|p| p.as_str()).unwrap_or("");
        if !path.is_empty() {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Return the URL for a configuration operation on the given backend.
///
/// Local backends route config calls through the OAuth process port so that
/// the OAuth flow can intercept them. Remote backends use the main API port.
pub fn get_config_url(backend: &Backend, operation: &str) -> String {
    if backend.is_local {
        backend.oauth_url_for(operation)
    } else {
        backend.url_for(operation)
    }
}

/// Trait for creating parameter structs from configuration values
pub trait FromConfig: Sized {
    /// Create Params from a profile config and settings
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self>;
}

/// Common resolved parameters used by mount, sync, copy, etc.
pub struct CommonConfigParams {
    pub sources: Vec<String>,
    pub dests: Vec<String>,
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
        .is_some_and(serde_json::Value::is_object)
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
            vec![remote_name.clone(), format!("{remote_name}:")],
            Map::from_iter([
                ("_name".to_string(), Value::String(remote_name)),
                ("_root".to_string(), Value::String(root)),
            ]),
        ),
        ParsedFs::Backend { backend_type, root } => (
            vec![format!(":{backend_type}"), backend_type.clone()],
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

pub enum ParsedFs {
    Named { remote_name: String, root: String },
    Backend { backend_type: String, root: String },
}

impl ParsedFs {
    pub fn into_base_and_root(self) -> (String, String) {
        match self {
            ParsedFs::Named { remote_name, root } => (format!("{remote_name}:"), root),
            ParsedFs::Backend { backend_type, root } => (format!(":{backend_type}:"), root),
        }
    }
}

pub fn parse_fs(fs: &str) -> Option<ParsedFs> {
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
        let backend_type = rest[..split_idx]
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
    // Evaluate any $(date +FORMAT) expressions before reading any field so that
    // source, dest, and all nested options are expanded consistently.
    let config = &interpolate_value(config);

    let sources = match config.get("sources").or_else(|| config.get("source")) {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => vec![],
    };

    let dests = match config.get("dests").or_else(|| config.get("dest")) {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => vec![],
    };

    if sources.is_empty() || dests.is_empty() {
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
        sources,
        dests,
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

/// Redact sensitive values from parameters for logging.
/// Reads restrict setting from `AppSettingsManager` internally.
pub fn redact_sensitive_values(params: &HashMap<String, Value>, app: &AppHandle) -> Value {
    let restrict_enabled: bool = app
        .try_state::<AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.restrict").ok())
        .unwrap_or(false);

    let map: serde_json::Map<String, Value> = params
        .iter()
        .map(|(k, v)| {
            let value = if restrict_enabled && crate::utils::types::core::is_sensitive_field(k) {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect();

    Value::Object(map)
}
