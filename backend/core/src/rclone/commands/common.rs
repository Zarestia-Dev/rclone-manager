use std::collections::HashMap;

use crate::context::AppHandle;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::rclone::backend::{BackendManager, RcloneTransport, types::Backend};
use crate::rclone::endpoints::operations;
use crate::services::settings::AppSettingsManager;
use crate::utils::json_helpers::get_string;
use crate::utils::json_helpers::resolve_profile_options;
use crate::utils::json_helpers::{interpolate_shell_commands, interpolate_value};
use crate::utils::types::remotes::helper_config_keys;
use crate::utils::types::remotes::{OperationType, ProfileConfig};
use crate::utils::types::state::RcloneState;

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

/// A validated operation snapshot and the backend that owns it.
pub struct ResolvedProfile {
    pub backend: Backend,
    pub params: CommonConfigParams,
}

/// Select and resolve a saved profile without converting it back to untyped JSON.
pub async fn resolve_profile_settings(
    app: &AppHandle,
    remote_name: &str,
    profile_name: &str,
    operation: OperationType,
    expected_backend: Option<&str>,
) -> Result<ResolvedProfile, String> {
    let manager = app.state::<AppSettingsManager>();
    let (backend, settings) = app
        .state::<BackendManager>()
        .active_remote_settings(manager.inner(), remote_name, expected_backend)
        .await?;
    let config = settings
        .get_configs(operation)
        .and_then(|profiles| profiles.get(profile_name))
        .ok_or_else(|| {
            format!(
                "{} profile '{profile_name}' for '{remote_name}' not found",
                operation.config_key()
            )
        })?;
    // Only provider-defined option collections cross the dynamic JSON boundary.
    let options = json!({
        "name": remote_name,
        "vfsConfigs": settings.vfs_configs,
        "filterConfigs": settings.filter_configs,
        "backendConfigs": settings.backend_configs,
        "runtimeRemoteConfigs": settings.runtime_remote_configs,
    });
    let params = parse_profile_config(config, &options, Some(profile_name.to_string()))?;
    Ok(ResolvedProfile { backend, params })
}

/// Determines if the given fs path is a directory using operations/stat.
pub async fn is_directory(
    transport: &dyn RcloneTransport,
    fs_path: &str,
    runtime_remote_options: Option<&HashMap<String, Value>>,
) -> Result<bool, String> {
    let (base, mut remote) = parse_fs(fs_path).unwrap_or((fs_path.to_string(), String::new()));

    // Normalize remote path: rclone remote paths should not start with a slash.
    if base.ends_with(':') {
        remote = remote.trim_start_matches('/').to_string();
    }

    let payload = RclonePayloadBuilder::new()
        .insert("fs", base)
        .insert("remote", remote)
        .with_runtime_remote_options(runtime_remote_options)?
        .build();

    let val = transport
        .rpc(operations::STAT, Some(&payload))
        .await
        .map_err(
            |error| crate::localized_error!("backendErrors.request.failed", "error" => error),
        )?;

    // rclone operations/stat returns { "item": { ... } } or { "item": null }
    let is_dir = val
        .get("item")
        .and_then(|item| item.get("IsDir"))
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => format!("Cannot determine source type: {fs_path}")))?;

    Ok(is_dir)
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
                if crate::utils::json_helpers::is_path_key(k)
                    || k == "app"
                    || crate::utils::types::remotes::APP_PARTITION_KEYS.contains(&k.as_str())
                {
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
    ) -> Result<&mut Self, String> {
        let Some(opts) = opts else { return Ok(self) };
        for (remote, options) in opts {
            let options = options.as_object().ok_or_else(
                || crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => remote),
            )?;
            let mut connection = remote.clone();
            for (key, value) in options {
                let invalid =
                    || crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => key);
                if key.is_empty()
                    || !key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                {
                    return Err(invalid());
                }
                let value = match value {
                    Value::String(value) => value.clone(),
                    Value::Number(_) | Value::Bool(_) => value.to_string(),
                    _ => return Err(invalid()),
                };
                connection.push_str(&format!(",{key}='{}'", value.replace('\'', "''")));
            }
            let prefix = format!("{remote}:");
            for field in ["fs", "srcFs", "dstFs", "path1", "path2", "src", "dst"] {
                if let Some(root) = self
                    .body
                    .get(field)
                    .and_then(Value::as_str)
                    .and_then(|path| path.strip_prefix(&prefix))
                {
                    let path = format!("{connection}:{root}");
                    self.body.insert(field.to_string(), json!(path));
                }
            }
        }
        Ok(self)
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

/// Flatten legacy UI section maps while preserving RC option blocks and their
/// precedence. `_config`, `_filter`, `mountOpt` and `vfsOpt` are RC data, not UI sections.
pub fn flatten_rclone_config(val: &Value) -> Value {
    if let Value::Object(map) = val {
        let mut flat = serde_json::Map::new();
        for (k, v) in map {
            if k == "app" || crate::utils::types::remotes::APP_PARTITION_KEYS.contains(&k.as_str())
            {
                continue;
            }
            if matches!(k.as_str(), "vfs" | "filter" | "backend")
                && let Value::Object(sub_map) = v
            {
                for (sub_k, sub_v) in sub_map {
                    if crate::utils::types::remotes::APP_PARTITION_KEYS.contains(&sub_k.as_str()) {
                        continue;
                    }
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

pub fn parse_common_config(config: &Value, settings: &Value) -> Result<CommonConfigParams, String> {
    // Raw Quick Run/Workflow input is normalized once at this boundary.
    let profile = if config.get("app").is_some() || config.get("rclone").is_some() {
        serde_json::from_value::<ProfileConfig>(config.clone()).map_err(
            |error| crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => error),
        )?
    } else {
        ProfileConfig::parse_from_value(config)
    };

    let name = Some(interpolate_shell_commands(&get_string(config, &["name"])).into_owned())
        .filter(|s| !s.is_empty());
    parse_profile_config(&profile, settings, name)
}

fn parse_profile_config(
    profile: &ProfileConfig,
    settings: &Value,
    name: Option<String>,
) -> Result<CommonConfigParams, String> {
    let mut app = profile.app.clone();
    for reference in [
        &mut app.vfs_profile,
        &mut app.filter_profile,
        &mut app.backend_profile,
        &mut app.runtime_remote_profile,
    ]
    .into_iter()
    .flatten()
    {
        *reference = interpolate_shell_commands(reference).into_owned();
    }
    let rclone = interpolate_value(&profile.rclone);
    let mut execution_config = rclone.clone();
    if let Some(config) = execution_config.as_object_mut() {
        config.remove("remotes");
        config.remove("runtimeRemote");
    }
    let rclone_config = flatten_rclone_config(&execution_config);

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
        return Err(
            crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => "Missing source path"),
        );
    }

    let dest = crate::utils::types::remotes::DEST_KEYS
        .iter()
        .find_map(|&key| get_paths(key).into_iter().next())
        .unwrap_or_default();

    let get_opts = |profile_name: Option<&str>, section: &str| {
        resolve_profile_options(settings, profile_name, section)
    };

    Ok(CommonConfigParams {
        source,
        dest,
        rclone_config: rclone_config.clone(),
        vfs_options: get_opts(app.vfs_profile.as_deref(), helper_config_keys::VFS)?,
        filter_options: get_opts(app.filter_profile.as_deref(), helper_config_keys::FILTER)?,
        backend_options: get_opts(app.backend_profile.as_deref(), helper_config_keys::BACKEND)?,
        runtime_remote_options: resolve_runtime_remote_options(&app, &rclone, settings, "remotes")?,
        profile: name,
    })
}

pub fn resolve_runtime_remote_options(
    app: &crate::utils::types::remotes::AppConfig,
    rclone_config: &Value,
    settings: &Value,
    inline_remotes_key: &str,
) -> Result<Option<HashMap<String, Value>>, String> {
    let configs = settings.get(helper_config_keys::RUNTIME_REMOTE);
    let profile = app.runtime_remote_profile.as_deref().unwrap_or("Default");
    let mut opts = if let Some(options) = configs.and_then(|configs| configs.get(profile)) {
        scoped_runtime_options(options, settings)?
    } else if profile == "Default" {
        // Forms select Default even when its empty options were never persisted.
        // Like the other helper profiles, an absent Default means no overrides.
        HashMap::new()
    } else {
        return Err(
            crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => profile),
        );
    };
    if let Some(inline) = rclone_config
        .get(inline_remotes_key)
        .or_else(|| rclone_config.get("runtimeRemote"))
    {
        for (remote, values) in scoped_runtime_options(inline, settings)? {
            let target = opts.entry(remote.clone()).or_insert_with(|| json!({}));
            let target = target.as_object_mut().ok_or_else(
                || crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => &remote),
            )?;
            let values = values.as_object().ok_or_else(
                || crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => &remote),
            )?;
            target.extend(values.clone());
        }
    }
    Ok((!opts.is_empty()).then_some(opts))
}

/// Accept legacy flat options only when the owning remote is known.
fn scoped_runtime_options(
    value: &Value,
    settings: &Value,
) -> Result<HashMap<String, Value>, String> {
    let invalid = || crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => "runtime remote options");
    let options = value.as_object().ok_or_else(invalid)?;
    if options.values().all(Value::is_object) {
        return Ok(options
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect());
    }
    if !options
        .values()
        .all(|value| value.is_string() || value.is_number() || value.is_boolean())
    {
        return Err(invalid());
    }
    let owner = settings
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(invalid)?;
    Ok(HashMap::from([(
        owner.trim_end_matches(':').to_string(),
        value.clone(),
    )]))
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
    fn legacy_and_scoped_inline_runtime_options_encode_the_same_payload() {
        let settings = json!({"name": "drive"});
        let paths = json!({"srcFs": "drive:photos", "dstFs": "/backup"});
        for inline in [
            json!({"runtimeRemote": {"region": "a'b,c", "env_auth": true}}),
            json!({"remotes": {"drive": {"region": "a'b,c", "env_auth": true}}}),
        ] {
            let mut config = paths.clone();
            config
                .as_object_mut()
                .unwrap()
                .extend(inline.as_object().unwrap().clone());
            let common =
                parse_common_config(&json!({"app": {}, "rclone": config}), &settings).unwrap();
            let mut builder = RclonePayloadBuilder::new();
            builder
                .insert("srcFs", "drive:photos")
                .insert("dstFs", "/backup");
            builder
                .with_runtime_remote_options(common.runtime_remote_options.as_ref())
                .unwrap();
            assert_eq!(
                builder.build()["srcFs"],
                "drive,env_auth='true',region='a''b,c':photos"
            );
            assert_eq!(builder.build()["dstFs"], "/backup");
        }
    }

    #[test]
    fn config_errors_preserve_the_missing_profile_and_invalid_field() {
        for key in [
            "vfsProfile",
            "filterProfile",
            "backendProfile",
            "runtimeRemoteProfile",
        ] {
            let mut config = json!({"app": {}, "rclone": {"fs": "drive:", "mountPoint": "/mnt"}});
            config["app"][key] = json!("MissingCustomProfile");
            let error = parse_common_config(&config, &json!({})).err().unwrap();
            assert!(error.contains("MissingCustomProfile"));
        }
        let malformed = json!({"app": {"watchDelay": "invalid"}, "rclone": {"fs": "drive:"}});
        assert!(parse_common_config(&malformed, &json!({})).is_err());
        assert!(
            parse_common_config(&json!({}), &json!({}))
                .err()
                .unwrap()
                .contains("Missing source path")
        );
    }

    struct StatTransport(Option<Value>);

    #[async_trait::async_trait]
    impl RcloneTransport for StatTransport {
        async fn kind(&self) -> crate::rclone::backend::transport::TransportKind {
            crate::rclone::backend::transport::TransportKind::HttpDaemon
        }
        async fn rpc(
            &self,
            _: &str,
            _: Option<&Value>,
        ) -> Result<Value, crate::rclone::backend::BackendError> {
            self.0
                .clone()
                .ok_or_else(|| crate::rclone::backend::BackendError::Rpc {
                    endpoint: "operations/stat".into(),
                    status: 403,
                    message: "denied".into(),
                })
        }
        async fn read_file(
            &self,
            _: &str,
            _: &str,
            _: Option<(u64, Option<u64>)>,
        ) -> Result<
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            crate::rclone::backend::BackendError,
        > {
            Err(crate::rclone::backend::BackendError::Other("unused".into()))
        }
    }

    #[tokio::test]
    async fn source_type_requires_a_successful_stat_response() {
        for value in [true, false] {
            assert_eq!(
                is_directory(
                    &StatTransport(Some(json!({"item": {"IsDir": value}}))),
                    "drive:path",
                    None
                )
                .await
                .unwrap(),
                value
            );
        }
        for value in [None, Some(json!({"item": null})), Some(json!({}))] {
            assert!(
                is_directory(&StatTransport(value), "drive:path", None)
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn empty_default_runtime_profile_requires_no_saved_options() {
        use crate::utils::types::remotes::AppConfig;
        for profile in [None, Some("Default".to_string())] {
            let app = AppConfig {
                runtime_remote_profile: profile,
                ..Default::default()
            };
            for settings in [json!({}), json!({"runtimeRemoteConfigs": {}})] {
                assert!(
                    resolve_runtime_remote_options(&app, &json!({}), &settings, "remotes")
                        .unwrap()
                        .is_none()
                );
                let inline = json!({"remotes": {"drive": {"region": "a'b,c"}}});
                let options = resolve_runtime_remote_options(&app, &inline, &settings, "remotes")
                    .unwrap()
                    .unwrap();
                assert_eq!(options["drive"], inline["remotes"]["drive"]);
            }
        }
    }

    #[test]
    fn missing_named_or_malformed_runtime_profiles_still_fail() {
        use crate::utils::types::remotes::AppConfig;
        for (profile, settings) in [
            ("Custom", json!({})),
            ("Custom", json!({"runtimeRemoteConfigs": {"Default": {}}})),
            (
                "Default",
                json!({"runtimeRemoteConfigs": {"Default": "invalid"}}),
            ),
        ] {
            let app = AppConfig {
                runtime_remote_profile: Some(profile.into()),
                ..Default::default()
            };
            let error =
                resolve_runtime_remote_options(&app, &json!({}), &settings, "remotes").unwrap_err();
            assert!(error.contains("backendErrors.rclone.invalidFlags"));
        }
    }

    #[tokio::test]
    async fn profile_resolution_uses_operation_and_preserves_dynamic_options() {
        let directory = tempfile::tempdir().unwrap();
        let manager: AppSettingsManager = rcman::SettingsManager::builder("profile-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .build()
            .unwrap();
        let sync = json!({"app": {}, "rclone": {"srcFs": "drive:photos", "dstFs": "/backup", "_config": {"Transfers": 2}}});
        let mount = json!({"app": {}, "rclone": {"fs": "drive:", "mountPoint": "/mount"}});
        manager
            .sub_settings("remotes")
            .unwrap()
            .set(
                "drive",
                &json!({
                    "syncConfigs": {"Daily": sync},
                    "mountConfigs": {"Daily": mount},
                    "runtimeRemoteConfigs": {"Default": {"drive": {"region": "a'b,c"}}}
                }),
            )
            .unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(BackendManager::new());
        for (operation, expected) in [(OperationType::Sync, sync), (OperationType::Mount, mount)] {
            let resolved = resolve_profile_settings(&app, "drive", "Daily", operation, None)
                .await
                .unwrap();
            assert_eq!(
                resolved.backend.name,
                crate::rclone::backend::types::LOCAL_BACKEND_NAME
            );
            assert_eq!(resolved.params.profile.as_deref(), Some("Daily"));
            assert_eq!(
                resolved.params.first_source(),
                if operation == OperationType::Sync {
                    "drive:photos"
                } else {
                    "drive:"
                }
            );
            assert_eq!(
                resolved.params.rclone_config.get("_config"),
                expected["rclone"].get("_config")
            );
            assert_eq!(
                resolved.params.runtime_remote_options.unwrap()["drive"]["region"],
                "a'b,c"
            );
        }
        for (operation, profile) in [
            (OperationType::Copy, "Daily"),
            (OperationType::Sync, "Missing"),
        ] {
            assert!(
                resolve_profile_settings(&app, "drive", profile, operation, None)
                    .await
                    .is_err()
            );
        }
        assert!(
            resolve_profile_settings(&app, "drive", "Daily", OperationType::Sync, Some("Other"))
                .await
                .is_err()
        );
    }

    #[test]
    fn resolved_profile_keeps_rc_blocks_through_actual_transfer_encoding() {
        use crate::rclone::commands::sync::{GenericTransferParams, lookup_dry_run};
        use crate::utils::types::remotes::OperationType;
        let profile = json!({
            "app": {"runtimeRemoteProfile":"Default"},
            "rclone": {"srcFs":"source:photos", "dstFs":"target:backup.zip", "format":"zip",
                "_config":{"DryRun":true,"Transfers":2}, "_filter":{"IncludeRule":["*.jpg"]}}
        });
        let settings =
            json!({"name":"source", "runtimeRemoteConfigs":{"Default":{"source":{"region":"us"}}}});
        let common = parse_common_config(&profile, &settings).unwrap();
        for operation in [
            OperationType::Sync,
            OperationType::Archivecreate,
            OperationType::Cryptcheck,
        ] {
            let body = GenericTransferParams {
                source: common.first_source(),
                dest: common.dest.clone(),
                rclone_config: common.rclone_config.clone(),
                filter_options: common.filter_options.clone(),
                backend_options: common.backend_options.clone(),
                runtime_remote_options: common.runtime_remote_options.clone(),
                transfer_type: operation,
                is_dir: true,
                dry_run: Some(lookup_dry_run(
                    &common.rclone_config,
                    common.backend_options.as_ref(),
                    operation,
                )),
            }
            .to_rclone_body()
            .unwrap();
            assert_eq!(body["_config"]["DryRun"], true);
            assert_eq!(body["_config"]["Transfers"], 2);
            assert_eq!(body["_filter"]["IncludeRule"], json!(["*.jpg"]));
            let source_field = if operation == OperationType::Sync {
                "srcFs"
            } else {
                "src"
            };
            assert_eq!(body[source_field], "source,region='us':photos");
        }
    }

    #[test]
    fn runtime_profiles_resolve_the_same_before_and_after_migration() {
        let app = crate::utils::types::remotes::AppConfig::default();
        let flat = json!({"name":"drive", "runtimeRemoteConfigs":{"Default":{"region":"us", "env_auth":true}}});
        let migrated =
            crate::services::settings::remote::manager::migrate_to_multi_profile(flat.clone());
        let before = resolve_runtime_remote_options(&app, &json!({}), &flat, "remotes").unwrap();
        let after = resolve_runtime_remote_options(&app, &json!({}), &migrated, "remotes").unwrap();
        assert_eq!(before, after);
        let mut builder = RclonePayloadBuilder::new();
        builder
            .insert("srcFs", "/local")
            .insert("dstFs", "drive:folder");
        builder.with_runtime_remote_options(after.as_ref()).unwrap();
        assert_eq!(builder.build()["srcFs"], "/local");
        assert_eq!(
            builder.build()["dstFs"],
            "drive,env_auth='true',region='us':folder"
        );
        let inline = json!({"remotes":{"drive":{"region":"eu"}}});
        let resolved = resolve_runtime_remote_options(&app, &inline, &migrated, "remotes")
            .unwrap()
            .unwrap();
        assert_eq!(resolved["drive"], json!({"env_auth":true,"region":"eu"}));
        let missing = crate::utils::types::remotes::AppConfig {
            runtime_remote_profile: Some("missing".into()),
            ..Default::default()
        };
        assert!(resolve_runtime_remote_options(&missing, &json!({}), &flat, "remotes").is_err());
    }

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
            "my_remote".to_string(),
            json!({"region":"us"}),
        )]));

        let payload = RclonePayloadBuilder::from_rclone_config(&rclone_config)
            .insert("fs", "my_remote:")
            .insert("mountPoint", "/mnt/drive")
            .with_runtime_remote_options(runtime_remote_options.as_ref())
            .unwrap()
            .with_vfs_options(vfs_options.as_ref())
            .with_filter_options(filter_options.as_ref())
            .with_backend_options(backend_options.as_ref())
            .build();

        let obj = payload.as_object().unwrap();

        // Base & path keys
        assert_eq!(obj.get("fs").unwrap(), "my_remote,region='us':");
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
        assert!(obj.get("my_remote").is_none());
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

    #[test]
    fn test_flatten_rclone_config_ignores_app_keys() {
        let rclone_config = json!({
            "fs": "OneDrive:Documents",
            "mountPoint": "/mnt/onedrive",
            "autoStart": false,
            "app": {
                "autoStart": false,
                "cronEnabled": false
            },
            "vfs": {
                "vfs-cache-mode": "writes"
            }
        });

        let flattened = flatten_rclone_config(&rclone_config);
        let obj = flattened.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "OneDrive:Documents");
        assert_eq!(obj.get("mountPoint").unwrap(), "/mnt/onedrive");
        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "writes");
        assert!(obj.get("app").is_none());
        assert!(obj.get("autoStart").is_none());
        assert!(obj.get("cronEnabled").is_none());
    }

    #[test]
    fn test_payload_builder_ignores_app_keys() {
        let rclone_config = json!({
            "fs": "OneDrive:Documents",
            "mountPoint": "/mnt/onedrive",
            "autoStart": false,
            "app": {
                "autoStart": false
            }
        });

        let payload = RclonePayloadBuilder::from_rclone_config(&rclone_config)
            .insert("fs", "OneDrive:Documents")
            .insert("mountPoint", "/mnt/onedrive")
            .build();
        let obj = payload.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "OneDrive:Documents");
        assert_eq!(obj.get("mountPoint").unwrap(), "/mnt/onedrive");
        assert!(obj.get("app").is_none());
        assert!(obj.get("autoStart").is_none());
    }
}
