use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    core::settings::AppSettingsManager,
    rclone::backend::BackendError,
    utils::{
        json_helpers::{get_string, interpolate_value, json_to_hashmap, resolve_profile_options},
        rclone::endpoints::operations,
        types::{
            remotes::{ProfileConfig, helper_config_keys},
            state::RcloneState,
        },
    },
};

#[must_use]
pub fn transport(app: &AppHandle) -> std::sync::Arc<dyn crate::rclone::backend::RcloneTransport> {
    app.state::<RcloneState>().transport.clone()
}

pub fn ensure_group(payload: &mut Value, group: &str) {
    if let Some(obj) = payload.as_object_mut() {
        obj.entry("_group".to_string())
            .or_insert_with(|| json!(group));
    }
}

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
    let settings =
        crate::utils::types::remotes::RemoteSettings::load(manager.inner(), remote_name)?;
    let settings_val = serde_json::to_value(&settings).map_err(|e| e.to_string())?;

    let config = settings_val
        .get(config_key)
        .and_then(|v| v.get(profile_name))
        .ok_or_else(|| {
            format!("{config_key} profile '{profile_name}' for '{remote_name}' not found")
        })?;

    Ok((config.clone(), settings_val))
}

/// Determines if the given fs path is a directory using operations/stat.
pub async fn is_directory(
    app: &AppHandle,
    fs_path: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Result<bool, String> {
    let transport = app.state::<RcloneState>().transport.clone();

    let (base, mut remote) = parse_fs(fs_path).unwrap_or((fs_path.to_string(), String::new()));

    // Normalize remote path: rclone remote paths should not start with a slash.
    if base.ends_with(':') {
        remote = remote.trim_start_matches('/').to_string();
    }

    let mut payload_map = serde_json::Map::new();
    payload_map.insert("fs".to_string(), json!(base));
    payload_map.insert("remote".to_string(), json!(remote));
    if let Some(opts) = runtime_remote_options {
        for (k, v) in opts {
            let norm_k = crate::utils::json_helpers::normalize_option_key(k);
            if !payload_map.contains_key(norm_k.as_ref()) {
                payload_map.insert(norm_k.into_owned(), v.clone());
            }
        }
    }

    let payload = Value::Object(payload_map);

    let val = match transport.rpc(operations::STAT, Some(&payload)).await {
        Ok(v) => v,
        Err(BackendError::Rpc { .. }) => return Ok(false),
        Err(e) => return Err(format!("Network error: {e}")),
    };

    // rclone operations/stat returns { "item": { ... } } or { "item": null }
    let is_dir = val
        .get("item")
        .and_then(|item| item.get("IsDir"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    Ok(is_dir)
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

/// Builder for constructing rclone RC command payloads with uniform config layering.
///
/// Handles:
/// - Unpacking unpartitioned / legacy `rclone_config` maps.
/// - Separating flat options (starting with lowercase, e.g. `exclude`, `vfs_cache_mode`, `allow_other`)
///   into the top-level payload map for Rclone flat option support.
/// - Routing PascalCase / structured options into nested blocks (`_config`, `_filter`, `vfsOpt`, `mountOpt`).
/// - Merging `runtime_remote_options` overrides.
/// - Merging profile blocks (`vfs_options`, `filter_options`, `backend_options`).
#[derive(Default, Debug, Clone)]
pub struct RclonePayloadBuilder {
    body: serde_json::Map<String, Value>,
}

impl RclonePayloadBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            body: serde_json::Map::new(),
        }
    }

    #[must_use]
    pub fn from_rclone_config(config: &Value) -> Self {
        let mut builder = Self::new();
        builder.merge_rclone_config(config);
        builder
    }

    pub fn insert(&mut self, key: impl Into<String>, val: impl Into<Value>) -> &mut Self {
        self.body.insert(key.into(), val.into());
        self
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.body.get(key)
    }

    pub fn merge_rclone_config(&mut self, config: &Value) -> &mut Self {
        if let Some(extra) = config.as_object() {
            let mut legacy_mount = serde_json::Map::new();
            let mut legacy_vfs = serde_json::Map::new();
            let mut legacy_filter = serde_json::Map::new();
            let mut legacy_config = serde_json::Map::new();

            let insert_normalized_block =
                |opts: &serde_json::Map<String, Value>,
                 target: &mut serde_json::Map<String, Value>| {
                    for (sub_k, sub_v) in opts {
                        let norm_sub = crate::utils::json_helpers::normalize_option_key(sub_k);
                        target.insert(norm_sub.into_owned(), sub_v.clone());
                    }
                };

            for (k, v) in extra {
                if crate::utils::json_helpers::is_path_key(k) {
                    continue;
                }
                if k == "mountOpt"
                    && let Some(opts) = v.as_object()
                {
                    insert_normalized_block(opts, &mut legacy_mount);
                } else if k == "vfsOpt"
                    && let Some(opts) = v.as_object()
                {
                    insert_normalized_block(opts, &mut legacy_vfs);
                } else if k == "_filter"
                    && let Some(opts) = v.as_object()
                {
                    insert_normalized_block(opts, &mut legacy_filter);
                } else if k == "_config"
                    && let Some(opts) = v.as_object()
                {
                    insert_normalized_block(opts, &mut legacy_config);
                } else if crate::utils::json_helpers::is_flat_option_key(k) {
                    let norm_k = crate::utils::json_helpers::normalize_option_key(k);
                    self.body.insert(norm_k.into_owned(), v.clone());
                } else {
                    let norm_k = crate::utils::json_helpers::normalize_option_key(k);
                    legacy_config.insert(norm_k.into_owned(), v.clone());
                }
            }

            if !legacy_mount.is_empty() {
                self.body
                    .insert("mountOpt".to_string(), Value::Object(legacy_mount));
            }
            if !legacy_vfs.is_empty() {
                self.body
                    .insert("vfsOpt".to_string(), Value::Object(legacy_vfs));
            }
            if !legacy_filter.is_empty() {
                self.body
                    .insert("_filter".to_string(), Value::Object(legacy_filter));
            }
            if !legacy_config.is_empty() {
                self.body
                    .insert("_config".to_string(), Value::Object(legacy_config));
            }
        }
        self
    }

    pub fn with_runtime_remote_options(
        &mut self,
        opts: Option<&HashMap<String, Value>>,
    ) -> &mut Self {
        if let Some(opts) = opts {
            for (k, v) in opts {
                let norm_k = crate::utils::json_helpers::normalize_option_key(k);
                if !self.body.contains_key(norm_k.as_ref()) {
                    self.body.insert(norm_k.into_owned(), v.clone());
                }
            }
        }
        self
    }

    pub fn with_vfs_options(&mut self, opts: Option<&HashMap<String, Value>>) -> &mut Self {
        self.merge_options_block("vfsOpt", opts, false);
        self
    }

    pub fn with_filter_options(&mut self, opts: Option<&HashMap<String, Value>>) -> &mut Self {
        self.merge_options_block("_filter", opts, false);
        self
    }

    pub fn with_backend_options(&mut self, opts: Option<&HashMap<String, Value>>) -> &mut Self {
        self.merge_options_block("_config", opts, true);
        self
    }

    fn merge_options_block(
        &mut self,
        block_name: &str,
        opts: Option<&HashMap<String, Value>>,
        filter_empty: bool,
    ) {
        let Some(opts) = opts else {
            return;
        };
        let mut nested_map = self
            .body
            .get(block_name)
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        for (k, v) in opts {
            if filter_empty && (v.is_null() || matches!(v, Value::String(s) if s.is_empty())) {
                continue;
            }
            let norm_k = crate::utils::json_helpers::normalize_option_key(k);
            if crate::utils::json_helpers::is_flat_option_key(k) {
                self.body.insert(norm_k.into_owned(), v.clone());
            } else {
                nested_map.insert(k.clone(), v.clone());
            }
        }

        if !nested_map.is_empty() {
            self.body
                .insert(block_name.to_string(), Value::Object(nested_map));
        } else {
            self.body.remove(block_name);
        }
    }

    #[must_use]
    pub fn build(&self) -> Value {
        Value::Object(self.body.clone())
    }

    pub fn as_map_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        &mut self.body
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

/// Flatten a structured `rclone` object containing section maps (`vfs`, `filter`, `backend`, `runtimeRemote`)
/// into a single flat key-value map for path extractions and command parameters, normalizing option keys.
pub fn flatten_rclone_config(val: &Value) -> Value {
    if let Value::Object(map) = val {
        let is_structured = map.values().any(|v| v.is_object());
        let mut flat = serde_json::Map::new();
        for (k, v) in map {
            if is_structured && let Value::Object(sub_map) = v {
                for (sub_k, sub_v) in sub_map {
                    let norm_sub = crate::utils::json_helpers::normalize_option_key(sub_k);
                    flat.insert(norm_sub.into_owned(), sub_v.clone());
                }
            } else {
                let norm_k = crate::utils::json_helpers::normalize_option_key(k);
                flat.insert(norm_k.into_owned(), v.clone());
            }
        }
        return Value::Object(flat);
    }
    val.clone()
}

pub fn parse_common_config(config: &Value, settings: &Value) -> Option<CommonConfigParams> {
    let config = &interpolate_value(config);

    // Deserialize using ProfileConfig or fall back if unpartitioned
    let profile = ProfileConfig::parse_from_value(config);

    let rclone_config = flatten_rclone_config(&profile.rclone);

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

    let source = crate::utils::types::remotes::SOURCE_KEYS
        .iter()
        .find_map(|&key| {
            let paths = get_paths(key);
            if paths.is_empty() { None } else { Some(paths) }
        })
        .unwrap_or_default();

    if source.is_empty() {
        return None;
    }

    let dest = crate::utils::types::remotes::DEST_KEYS
        .iter()
        .find_map(|&key| get_paths(key).into_iter().next())
        .unwrap_or_default();

    let get_opts = |profile_name: Option<&str>, section: &str| {
        resolve_profile_options(settings, profile_name, section)
    };

    Some(CommonConfigParams {
        source,
        dest,
        rclone_config: rclone_config.clone(),
        vfs_options: get_opts(profile.app.vfs_profile.as_deref(), helper_config_keys::VFS),
        filter_options: get_opts(
            profile.app.filter_profile.as_deref(),
            helper_config_keys::FILTER,
        ),
        backend_options: get_opts(
            profile.app.backend_profile.as_deref(),
            helper_config_keys::BACKEND,
        ),
        runtime_remote_options: resolve_runtime_remote_options(
            &profile.app,
            &rclone_config,
            settings,
            "remotes",
        ),
        profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
    })
}

pub fn resolve_runtime_remote_options(
    app: &crate::utils::types::remotes::AppConfig,
    rclone_config: &Value,
    settings: &Value,
    inline_remotes_key: &str,
) -> Option<HashMap<String, Value>> {
    let profile = app.runtime_remote_profile.as_deref();
    let mut opts = resolve_profile_options(settings, profile, helper_config_keys::RUNTIME_REMOTE)
        .unwrap_or_default();

    if let Some(inline) = json_to_hashmap(
        rclone_config
            .get(inline_remotes_key)
            .or_else(|| rclone_config.get("runtimeRemote")),
    ) {
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

/// Recursively redact sensitive values from any JSON Value for logging.
/// Reads restrict setting from `AppSettingsManager` internally.
///
/// NOTE: `--password-command` CLI flags are **always** redacted, regardless of
/// the `restrict` setting — passwords must never appear in logs.
pub fn redact_value(val: &Value, app: &AppHandle) -> Value {
    let restrict_enabled: bool = app
        .try_state::<AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.restrict").ok())
        .unwrap_or(false);

    fn redact_recursive(val: &Value, restrict_enabled: bool) -> Value {
        match val {
            Value::Object(map) => {
                let mut redacted_map = serde_json::Map::new();
                for (k, v) in map {
                    let new_val =
                        if restrict_enabled && crate::utils::security::is_sensitive_field(k) {
                            json!("[RESTRICTED]")
                        } else {
                            redact_recursive(v, restrict_enabled)
                        };
                    redacted_map.insert(k.clone(), new_val);
                }
                Value::Object(redacted_map)
            }
            Value::Array(arr) => {
                let redacted_arr = arr
                    .iter()
                    .map(|v| redact_recursive(v, restrict_enabled))
                    .collect();
                Value::Array(redacted_arr)
            }
            // Always redact --password-command=... flags — passwords must never
            // appear in logs regardless of the `restrict` setting.
            Value::String(s) if s.starts_with("--password-command") => {
                if let Some(eq_pos) = s.find('=') {
                    let flag = &s[..eq_pos];
                    json!(format!("{flag}=[REDACTED]"))
                } else {
                    // Flag without value (next element carries the value) —
                    // replace the bare flag name so callers know it was present.
                    json!("--password-command=[REDACTED]")
                }
            }
            _ => val.clone(),
        }
    }

    redact_recursive(val, restrict_enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_flatten_rclone_config() {
        let input = json!({
            "srcFs": "dropbox:",
            "mountPoint": "/home/hakan/rclone-manager/drive",
            "attr_timeout": "10s",
            "test": 123,
            "vfs": {
                "vfs_refresh": true,
                "vfs_cache_mode": "full"
            },
            "filter": {
                "delete_excluded": true
            },
            "backend": {
                "buffer_size": "32M"
            }
        });

        let flat = flatten_rclone_config(&input);
        let obj = flat.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "dropbox:");
        assert_eq!(
            obj.get("mountPoint").unwrap(),
            "/home/hakan/rclone-manager/drive"
        );
        assert_eq!(obj.get("attr_timeout").unwrap(), "10s");
        assert_eq!(obj.get("test").unwrap(), 123);
        assert_eq!(obj.get("vfs_refresh").unwrap(), true);
        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "full");
        assert_eq!(obj.get("delete_excluded").unwrap(), true);
        assert_eq!(obj.get("buffer_size").unwrap(), "32M");

        assert!(obj.get("vfs").is_none());
        assert!(obj.get("filter").is_none());
        assert!(obj.get("backend").is_none());
    }

    #[test]
    fn test_rclone_payload_builder() {
        let rclone_config = json!({
            "mountType": "cmount",
            "mountOpt": { "read-only": true },
            "_config": { "AutoConfirm": true },
            "_filter": { "IncludeRule": "*.jpg" },
            "vfsOpt": { "CacheMode": "full" },
            "--value-of-rclone": "custom_val",
            "--bwlimit": "10M",
            "Transfers": 4,
            "allow_other": true,
            "srcFs": "ignore_me:"
        });

        let vfs_options = Some(HashMap::from([
            ("vfs-cache-mode".to_string(), json!("writes")),
            ("ChunkSize".to_string(), json!("16M")),
        ]));
        let filter_options = Some(HashMap::from([
            ("exclude".to_string(), json!("*.doc")),
            ("ExcludeRule".to_string(), json!(["*.bak"])),
        ]));
        let backend_options = Some(HashMap::from([
            ("chunk-size".to_string(), json!("10M")),
            ("empty_flag".to_string(), json!("")),
            ("null_flag".to_string(), json!(null)),
            ("Checkers".to_string(), json!(32)),
        ]));
        let runtime_remote_options = Some(HashMap::from([(
            "my_runtime_flag".to_string(),
            json!("val"),
        )]));

        let payload = RclonePayloadBuilder::from_rclone_config(&rclone_config)
            .insert("fs", "my_remote:")
            .insert("mountPoint", "/mnt/drive")
            .with_runtime_remote_options(runtime_remote_options.as_ref())
            .with_vfs_options(vfs_options.as_ref())
            .with_filter_options(filter_options.as_ref())
            .with_backend_options(backend_options.as_ref())
            .build();

        let obj = payload.as_object().unwrap();

        // Base & path keys
        assert_eq!(obj.get("fs").unwrap(), "my_remote:");
        assert_eq!(obj.get("mountPoint").unwrap(), "/mnt/drive");
        assert!(obj.get("srcFs").is_none());

        // Flat lowercase options at root (including mapped CLI flags and kebab-case)
        assert_eq!(obj.get("mountType").unwrap(), "cmount");
        assert_eq!(obj.get("allow_other").unwrap(), true);
        assert_eq!(obj.get("value_of_rclone").unwrap(), "custom_val");
        assert_eq!(obj.get("bwlimit").unwrap(), "10M");
        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "writes");
        assert_eq!(obj.get("exclude").unwrap(), "*.doc");
        assert_eq!(obj.get("chunk_size").unwrap(), "10M");
        assert_eq!(obj.get("my_runtime_flag").unwrap(), "val");
        assert!(obj.get("empty_flag").is_none());
        assert!(obj.get("null_flag").is_none());

        // Nested blocks
        let mount_opt = obj.get("mountOpt").unwrap().as_object().unwrap();
        assert_eq!(mount_opt.get("read_only").unwrap(), true);

        let vfs_opt = obj.get("vfsOpt").unwrap().as_object().unwrap();
        assert_eq!(vfs_opt.get("CacheMode").unwrap(), "full");
        assert_eq!(vfs_opt.get("ChunkSize").unwrap(), "16M");

        let filter_opt = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter_opt.get("IncludeRule").unwrap(), "*.jpg");
        assert_eq!(filter_opt.get("ExcludeRule").unwrap(), &json!(["*.bak"]));

        let config_opt = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config_opt.get("AutoConfirm").unwrap(), true);
        assert_eq!(config_opt.get("Transfers").unwrap(), 4);
        assert_eq!(config_opt.get("Checkers").unwrap(), 32);
    }
}
