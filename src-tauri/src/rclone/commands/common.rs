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
    let manager = app.state::<AppSettingsManager>();
    let cache = &app.state::<BackendManager>().remote_cache;
    let remote_names = cache.get_remotes().await;

    let settings_map = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    let settings = settings_map
        .get(remote_name)
        .ok_or_else(|| format!("Remote '{remote_name}' not found in settings"))?;

    let config = settings
        .get(config_key)
        .and_then(|v| v.get(profile_name))
        .ok_or_else(|| {
            format!("{config_key} profile '{profile_name}' for '{remote_name}' not found")
        })?;

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
use serde_json::json;
use std::collections::HashMap;

/// Determines if the given fs path is a directory using operations/list.
///
/// This is a lightweight check that uses optimized flags to minimize overhead.
pub async fn is_directory(
    app: &AppHandle,
    fs: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Result<bool, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let state = app.state::<RcloneState>();

    let resp = backend
        .inject_auth(
            state
                .client
                .post(backend.url_for(crate::utils::rclone::endpoints::operations::LIST)),
        )
        .json(&json!({
            "fs": fs_value_with_runtime_overrides(fs, runtime_remote_options),
            "remote": "",
            "opt": { "metadata": false, "noModTime": true, "noMimeType": true, "recurse": false }
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        return Ok(false);
    }

    let val: Value = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;
    let list = val
        .get("list")
        .and_then(|l| l.as_array())
        .ok_or("Invalid response")?;

    // If empty, assume directory. If one file, Path is "" and IsDir is false.
    // If one dir, Path is "subdir" or IsDir is true.
    Ok(list.is_empty()
        || list.len() > 1
        || list.iter().any(|item| {
            item.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false)
                || !item
                    .get("Path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .is_empty()
        }))
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
    pub dest: String,
    pub options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl CommonConfigParams {
    pub fn first_source(&self) -> String {
        self.sources.first().cloned().unwrap_or_default()
    }
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
        return json!(fs);
    };

    let Some((base, root)) = parse_fs(fs) else {
        return json!(fs);
    };

    let lookup_keys = [base.clone(), base.trim_end_matches(':').to_string()];
    let remote_override = lookup_keys
        .iter()
        .find_map(|key| overrides.get(key))
        .and_then(|v| v.as_object());

    match remote_override {
        Some(opts) if !opts.is_empty() => {
            let mut fs_obj = opts.clone();
            if base.starts_with(':') {
                fs_obj.insert("type".to_string(), json!(base.trim_matches(':')));
            } else {
                fs_obj.insert("_name".to_string(), json!(base.trim_end_matches(':')));
            }
            fs_obj.insert("_root".to_string(), json!(root));
            Value::Object(fs_obj)
        }
        _ => json!(fs),
    }
}

// Removed ParsedFs enum

/// Parses an rclone fs string into (base, root).
/// Example: "remote:path" -> ("remote:", "path"), ":s3:/bucket" -> (":s3:", "/bucket")
pub fn parse_fs(fs: &str) -> Option<(String, String)> {
    if fs.is_empty() {
        return None;
    }

    // Avoid treating Windows paths (C:\) as remotes
    let is_windows_drive = fs.len() > 2
        && fs.chars().nth(1) == Some(':')
        && matches!(fs.chars().nth(2), Some('\\' | '/'));

    if is_windows_drive || fs.starts_with('/') {
        return Some((fs.to_string(), "".to_string()));
    }

    match fs.find(':') {
        Some(split_idx) => {
            let base = &fs[..=split_idx];
            let root = &fs[split_idx + 1..];

            if base.starts_with(':') {
                let backend_type = base[1..base.len() - 1].split(',').next()?.trim();
                if backend_type.is_empty() {
                    return None;
                }
            } else if base.len() <= 1 {
                // Single character before colon (not a windows drive) - treat as local
                return Some((fs.to_string(), "".to_string()));
            }

            Some((base.to_string(), root.to_string()))
        }
        None => {
            // No colon found - treat as local path
            Some((fs.to_string(), "".to_string()))
        }
    }
}

/// Helper to parse common configuration fields
pub fn parse_common_config(
    config: &Value,
    settings: &Value,
    remote_name: &str,
) -> Option<CommonConfigParams> {
    let config = &interpolate_value(config);

    let get_paths = |key: &str, alt: &str| -> Vec<String> {
        match config.get(key).or_else(|| config.get(alt)) {
            Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .filter(|s| !s.is_empty())
                .collect(),
            _ => vec![],
        }
    };

    let sources = get_paths("sources", "source");
    if sources.is_empty() {
        return None;
    }

    let dest = get_paths("dests", "dest")
        .into_iter()
        .next()
        .unwrap_or_default();

    let get_opts = |key: &str, section: &str| {
        resolve_profile_options(settings, config.get(key).and_then(|v| v.as_str()), section)
    };

    Some(CommonConfigParams {
        sources,
        dest,
        options: json_to_hashmap(config.get("options")),
        vfs_options: get_opts("vfsProfile", "vfsConfigs"),
        filter_options: get_opts("filterProfile", "filterConfigs"),
        backend_options: get_opts("backendProfile", "backendConfigs"),
        runtime_remote_options: resolve_runtime_remote_options(
            config,
            settings,
            remote_name,
            "remotes",
        ),
        profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
    })
}

pub fn resolve_runtime_remote_options(
    config: &Value,
    settings: &Value,
    remote_name: &str,
    inline_remotes_key: &str,
) -> Option<HashMap<String, Value>> {
    let profile = config.get("runtimeRemoteProfile").and_then(|v| v.as_str());
    let mut opts = resolve_profile_options(settings, profile, "runtimeRemoteConfigs")
        .map(|o| normalize_runtime_remote_profile_options(remote_name, o))
        .unwrap_or_default();

    if let Some(inline) = json_to_hashmap(config.get(inline_remotes_key)) {
        opts.extend(inline);
    }

    if opts.is_empty() { None } else { Some(opts) }
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
