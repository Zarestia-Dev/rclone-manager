use crate::core::settings::AppSettingsManager;
use serde::{Deserialize, Serialize};
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
    let remotes = manager
        .inner()
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to get remotes sub-settings: {e}"))?;

    let settings = remotes
        .get_value(remote_name)
        .map_err(|_| format!("Remote '{remote_name}' not found in settings"))?;

    let config = settings
        .get(config_key)
        .and_then(|v| v.get(profile_name))
        .ok_or_else(|| {
            format!("{config_key} profile '{profile_name}' for '{remote_name}' not found")
        })?;

    Ok((config.clone(), settings))
}

// ============================================================================
// SHARED TRAITS & HELPERS
// ============================================================================

use crate::rclone::backend::types::Backend;
use crate::utils::json_helpers::{
    get_string, interpolate_value, json_to_hashmap, resolve_profile_options,
};
use crate::utils::types::state::RcloneState;
use serde_json::json;
use std::collections::HashMap;

/// Determines if the given fs path is a directory using operations/stat.
pub async fn is_directory(
    app: &AppHandle,
    fs_path: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Result<bool, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let state = app.state::<RcloneState>();

    let (base, remote) = parse_fs(fs_path).unwrap_or((fs_path.to_string(), String::new()));

    let resp = backend
        .inject_auth(
            state
                .client
                .post(backend.url_for(crate::utils::rclone::endpoints::operations::STAT)),
        )
        .json(&json!({
            "fs": fs_value_with_runtime_overrides(&base, runtime_remote_options),
            "remote": remote,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        return Ok(false);
    }

    let val: Value = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

    // rclone operations/stat returns { "item": { ... } } or { "item": null }
    let is_dir = val
        .get("item")
        .and_then(|item| item.get("IsDir"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    Ok(is_dir)
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
    pub source: Vec<String>,
    pub dest: String,
    pub rclone_config: Value,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl CommonConfigParams {
    pub fn first_source(&self) -> String {
        self.source.first().cloned().unwrap_or_default()
    }
}

/// Context for bulk mount/serve stop operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationContext {
    Normal,
    Shutdown,
}

impl OperationContext {
    #[must_use]
    pub fn is_shutdown(self) -> bool {
        matches!(self, Self::Shutdown)
    }
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

    let trimmed_base = base.trim_end_matches(':');
    let matched_key = [&base, trimmed_base]
        .into_iter()
        .find(|&key| overrides.contains_key(key));

    let remote_override = matched_key.and_then(|key| {
        let val = overrides.get(key);
        val.and_then(|v| {
            if v.is_object() {
                v.as_object()
            } else {
                log::warn!(
                    "⚠️ Runtime override for '{key}' ignored: expected JSON object, found {v:?}"
                );
                None
            }
        })
    });

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
/// Example: "remote:path" -> ("remote:", "path"), ":<s3:/bucket>" -> (":s3:", "/bucket")
pub fn parse_fs(fs: &str) -> Option<(String, String)> {
    if fs.is_empty() {
        return None;
    }

    // Avoid treating Windows paths (C:\) as remotes
    let bytes = fs.as_bytes();
    let is_windows_drive =
        bytes.len() > 2 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');

    if is_windows_drive || fs.starts_with('/') {
        return Some((fs.to_string(), String::new()));
    }

    let split_idx = if let Some(stripped) = fs.strip_prefix(':') {
        stripped.find(':').map(|idx| idx + 1)
    } else {
        fs.find(':')
    };

    match split_idx {
        Some(split_idx) => {
            let base = &fs[..=split_idx];
            let root = &fs[split_idx + 1..];

            if base.starts_with(':') {
                if base.len() < 2 {
                    return None;
                }
                let backend_type = base[1..base.len() - 1].split(',').next()?.trim();
                if backend_type.is_empty() {
                    return None;
                }
            } else if base.len() <= 2 {
                // Single character before colon (e.g., C: or a:) - treat as local
                return Some((fs.to_string(), String::new()));
            }

            Some((base.to_string(), root.to_string()))
        }
        None => {
            // No colon found - treat as local path
            Some((fs.to_string(), String::new()))
        }
    }
}

pub fn parse_common_config(config: &Value, settings: &Value) -> Option<CommonConfigParams> {
    let config = &interpolate_value(config);

    let app_config = config.get("app").unwrap_or(config);
    let rclone_config = config.get("rclone").unwrap_or(config);

    let get_paths = |key: &str| -> Vec<String> {
        match rclone_config.get(key) {
            Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(std::string::ToString::to_string))
                .filter(|s| !s.is_empty())
                .collect(),
            _ => vec![],
        }
    };

    let source = ["srcFs", "path1", "fs"]
        .iter()
        .find_map(|&key| {
            let paths = get_paths(key);
            if paths.is_empty() { None } else { Some(paths) }
        })
        .unwrap_or_default();

    if source.is_empty() {
        return None;
    }

    let dest = get_paths("dstFs")
        .into_iter()
        .next()
        .or_else(|| get_paths("path2").into_iter().next())
        .or_else(|| get_paths("mountPoint").into_iter().next())
        .unwrap_or_default();

    let get_opts = |key: &str, section: &str| {
        resolve_profile_options(
            settings,
            app_config.get(key).and_then(|v| v.as_str()),
            section,
        )
    };

    Some(CommonConfigParams {
        source,
        dest,
        rclone_config: rclone_config.clone(),
        vfs_options: get_opts("vfsProfile", "vfsConfigs"),
        filter_options: get_opts("filterProfile", "filterConfigs"),
        backend_options: get_opts("backendProfile", "backendConfigs"),
        runtime_remote_options: resolve_runtime_remote_options(
            app_config,
            rclone_config,
            settings,
            "remotes",
        ),
        profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
    })
}

pub fn resolve_runtime_remote_options(
    app_config: &Value,
    rclone_config: &Value,
    settings: &Value,
    inline_remotes_key: &str,
) -> Option<HashMap<String, Value>> {
    let profile = app_config
        .get("runtimeRemoteProfile")
        .and_then(|v| v.as_str());
    let mut opts =
        resolve_profile_options(settings, profile, "runtimeRemoteConfigs").unwrap_or_default();

    if let Some(inline) = json_to_hashmap(rclone_config.get(inline_remotes_key)) {
        opts.extend(inline);
    }

    // Filter to ensure only objects are returned as overrides
    let filtered: HashMap<String, Value> =
        opts.into_iter().filter(|(_, v)| v.is_object()).collect();

    if filtered.is_empty() {
        None
    } else {
        Some(filtered)
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
            let value = if restrict_enabled && crate::utils::security::is_sensitive_field(k) {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect();

    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_fs_local() {
        assert_eq!(parse_fs(""), None);
        assert_eq!(
            parse_fs("/var/tmp"),
            Some(("/var/tmp".to_string(), "".to_string()))
        );
        assert_eq!(
            parse_fs("C:\\Users\\admin"),
            Some(("C:\\Users\\admin".to_string(), "".to_string()))
        );
        assert_eq!(
            parse_fs("C:/Users/admin"),
            Some(("C:/Users/admin".to_string(), "".to_string()))
        );
        assert_eq!(
            parse_fs("C:Users/admin"),
            Some(("C:Users/admin".to_string(), "".to_string()))
        );
        assert_eq!(parse_fs("a:"), Some(("a:".to_string(), "".to_string())));
    }

    #[test]
    fn test_parse_fs_remote() {
        assert_eq!(
            parse_fs("my_remote:bucket/path"),
            Some(("my_remote:".to_string(), "bucket/path".to_string()))
        );
        assert_eq!(
            parse_fs(":s3:bucket"),
            Some((":s3:".to_string(), "bucket".to_string()))
        );
        assert_eq!(
            parse_fs("remote:"),
            Some(("remote:".to_string(), "".to_string()))
        );
    }

    #[test]
    fn test_fs_value_with_runtime_overrides() {
        let overrides = HashMap::from([
            (
                "my_remote:".to_string(),
                json!({ "type": "s3", "provider": "AWS" }),
            ),
            (
                "s3_backend".to_string(),
                json!({ "type": "s3", "env_auth": true }),
            ),
        ]);

        // No overrides
        assert_eq!(
            fs_value_with_runtime_overrides("my_remote:bucket", None),
            json!("my_remote:bucket")
        );

        // Match with colon
        let overridden1 = fs_value_with_runtime_overrides("my_remote:bucket", Some(&overrides));
        let obj1 = overridden1.as_object().unwrap();
        assert_eq!(obj1.get("_name").unwrap(), "my_remote");
        assert_eq!(obj1.get("_root").unwrap(), "bucket");
        assert_eq!(obj1.get("provider").unwrap(), "AWS");

        // Match without colon
        let overridden2 = fs_value_with_runtime_overrides("s3_backend:bucket", Some(&overrides));
        let obj2 = overridden2.as_object().unwrap();
        assert_eq!(obj2.get("_name").unwrap(), "s3_backend");
        assert_eq!(obj2.get("_root").unwrap(), "bucket");
        assert_eq!(obj2.get("env_auth").unwrap(), &json!(true));

        // No match in overrides
        assert_eq!(
            fs_value_with_runtime_overrides("other:bucket", Some(&overrides)),
            json!("other:bucket")
        );
    }
}
