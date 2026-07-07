use std::collections::HashMap;

use log::{debug, info, warn};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    core::paths::AppPaths,
    rclone::{backend::BackendManager, state::watcher::refresh_serves_quietly},
    utils::{
        app::notification::{NotificationEvent, ServeStage, notify},
        logging::log::log_operation,
        rclone::endpoints::serve,
        types::{
            logs::LogLevel,
            remotes::{OperationType, ProfileParams},
            state::RcloneState,
        },
    },
};

use super::common::{
    OperationContext, fs_value_with_runtime_overrides, parse_common_config, redact_value,
};

/// Parameters for starting a serve instance
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ServeParams {
    pub remote_name: String,
    pub source: String,
    pub rclone_config: Value,
    pub backend_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub serve_type: String,
}

fn to_serve_vfs_key(s: &str) -> String {
    // 1. Convert camelCase/PascalCase to snake_case and replace '-' with '_'
    let mut cleaned = String::new();
    for (i, c) in s.chars().enumerate() {
        if c == '-' {
            cleaned.push('_');
        } else if c.is_uppercase() {
            if i > 0 && s.chars().nth(i - 1) != Some('-') {
                cleaned.push('_');
            }
            cleaned.push(c.to_ascii_lowercase());
        } else {
            cleaned.push(c);
        }
    }

    if cleaned.starts_with("vfs_") {
        return cleaned;
    }

    // Special VFS read chunk cases
    if cleaned == "chunk_size" {
        return "vfs_read_chunk_size".to_string();
    }
    if cleaned == "chunk_size_limit" {
        return "vfs_read_chunk_size_limit".to_string();
    }
    if cleaned == "chunk_streams" {
        return "vfs_read_chunk_streams".to_string();
    }

    // VFS flags that do not get the vfs_ prefix on the CLI
    let non_prefixed = [
        "no_modtime",
        "no_checksum",
        "no_seek",
        "dir_cache_time",
        "poll_interval",
        "read_only",
        "dir_perms",
        "file_perms",
        "link_perms",
        "umask",
        "uid",
        "gid",
    ];

    if non_prefixed.contains(&cleaned.as_str()) {
        cleaned
    } else {
        format!("vfs_{cleaned}")
    }
}

impl ServeParams {
    /// Create `ServeParams` from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let common = parse_common_config(config, settings)?;
        let rclone_config = config.get("rclone").unwrap_or(config);
        let serve_type = rclone_config
            .get("type")
            .or_else(|| rclone_config.get("serveType"))
            .and_then(|v| v.as_str())
            .unwrap_or("http")
            .to_string();

        Some(Self {
            remote_name,
            source: common.first_source(),
            rclone_config: common.rclone_config.clone(),
            backend_options: common.backend_options,
            filter_options: common.filter_options,
            vfs_options: common.vfs_options,
            runtime_remote_options: common.runtime_remote_options,
            profile: common.profile,
            serve_type,
        })
    }

    pub fn to_rclone_body(&self) -> Value {
        let mut body = match self.rclone_config.clone() {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };

        // 1. Pre-process serve options to handle "addr" array issue
        if let Some(addr_val) = body.get("addr") {
            let final_val = match addr_val {
                Value::Array(arr) if arr.len() == 1 && arr[0].is_string() => arr[0].clone(),
                _ => addr_val.clone(),
            };
            body.insert("addr".to_string(), final_val);
        }

        // 2. Inject runtime remote overrides
        body.insert(
            "fs".to_string(),
            fs_value_with_runtime_overrides(&self.source, self.runtime_remote_options.as_ref()),
        );

        // 3. Inject serve type
        body.insert("type".to_string(), json!(self.serve_type));

        // 4. Merge resolved profile blocks
        if let Some(vfs_opts) = &self.vfs_options {
            for (key, val) in vfs_opts {
                let flat_key = to_serve_vfs_key(key);
                body.insert(flat_key, val.clone());
            }
        }
        if let Some(filter_opts) = &self.filter_options {
            body.insert(
                "_filter".to_string(),
                serde_json::to_value(filter_opts).unwrap(),
            );
        }
        if let Some(backend_opts) = &self.backend_options {
            let mut final_backend = backend_opts.clone();
            final_backend
                .retain(|_, v| !v.is_null() && !matches!(v, Value::String(s) if s.is_empty()));
            if !final_backend.is_empty() {
                body.insert(
                    "_config".to_string(),
                    serde_json::to_value(final_backend).unwrap(),
                );
            }
        }

        Value::Object(body)
    }
}

/// Response from starting a serve instance
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ServeStartResponse {
    pub id: String,   // Server ID (e.g., "http-abc123")
    pub addr: String, // Address server is listening on
}

pub async fn start_serve(
    app: AppHandle,
    params: ServeParams,
) -> Result<ServeStartResponse, String> {
    if params.remote_name.trim().is_empty() {
        return Err(crate::localized_error!("backendErrors.serve.remoteEmpty"));
    }

    let transport = app.state::<RcloneState>().transport.clone();
    let backend_manager = app.state::<BackendManager>();

    let serve_type = &params.serve_type;

    debug!("🚀 Starting {serve_type} serve for {}", params.remote_name);

    let mut payload = params.to_rclone_body();

    // Auto-inject our custom template for web-based protocols if not already specified
    if serve_type == "http" || serve_type == "webdav" {
        let app_paths = app.state::<AppPaths>();
        let template_path = app_paths.serve_template_path();

        if template_path.exists()
            && let Some(obj) = payload.as_object_mut()
            && !obj.contains_key("template")
        {
            obj.insert(
                "template".to_string(),
                json!(template_path.to_string_lossy()),
            );
            debug!(
                "🎨 Injected custom serve template: {}",
                template_path.display()
            );
        }
    }

    let log_context = json!({
        "remote_name": params.remote_name,
        "arguments": redact_value(&payload, &app),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Start serve".to_string()),
        format!("Attempting to start {serve_type} serve"),
        Some(log_context),
    );

    debug!("📦 Serve request payload: {payload:#?}");

    let backend_name_for_err = backend_manager.get_active_name().await;

    // Call serve/start via the transport
    let response_json = transport
        .rpc(serve::START, Some(&payload))
        .await
        .map_err(|e| {
            let error = format!("Failed to start serve: {e}");
            log_operation(
                LogLevel::Error,
                Some(params.remote_name.clone()),
                Some("Start serve".to_string()),
                error.clone(),
                None,
            );
            notify(
                &app,
                NotificationEvent::Serve(ServeStage::Failed {
                    backend: backend_name_for_err.clone(),
                    remote: params.remote_name.clone(),
                    profile: params.profile.clone(),
                    protocol: serve_type.clone(),
                    error: e.to_string(),
                }),
            );
            error
        })?;

    // Extract serve details
    let serve_id = response_json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let addr = response_json
        .get("addr")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let serve_response = ServeStartResponse {
        id: serve_id.clone(),
        addr: addr.clone(),
    };

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Start serve".to_string()),
        format!(
            "Serve started with ID {} at {}",
            serve_response.id, serve_response.addr
        ),
        Some(response_json),
    );

    // Refresh first so the entry exists in cache, then attach the profile to it.
    refresh_serves_quietly(&app).await;
    backend_manager
        .remote_cache
        .store_serve_profile(&serve_id, params.profile.clone())
        .await;
    info!(
        "✅ Serve {} started: ID={}, Address={}",
        params.remote_name, serve_response.id, serve_response.addr
    );

    let backend_name = backend_manager.get_active_name().await;
    notify(
        &app,
        NotificationEvent::Serve(ServeStage::Started {
            backend: backend_name,
            remote: params.remote_name.clone(),
            profile: params.profile.clone(),
            protocol: addr.clone(), // Or extracted protocol
        }),
    );

    Ok(serve_response)
}

/// Stop a specific serve instance by ID
#[tauri::command]
pub async fn stop_serve(
    app: AppHandle,
    server_id: String,
    remote_name: String,
) -> Result<String, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Attempting to stop serve with ID {server_id}"),
        None,
    );

    let transport = app.state::<RcloneState>().transport.clone();
    let backend_manager = app.state::<BackendManager>();
    let payload = json!({ "id": server_id });

    // Get serve details from cache before stopping
    let serve_info = backend_manager
        .remote_cache
        .get_serve_by_id(&server_id)
        .await;
    let profile = serve_info.as_ref().and_then(|s| s.profile.clone());
    let protocol = serve_info
        .as_ref()
        .and_then(|s| s.params.get("type").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string();

    let backend_name_for_err = backend_manager.get_active_name().await;

    let _ = transport
        .rpc(serve::STOP, Some(&payload))
        .await
        .map_err(|e| {
            let error = format!("Failed to stop serve: {e}");
            log_operation(
                LogLevel::Error,
                Some(remote_name.clone()),
                Some("Stop serve".to_string()),
                error.clone(),
                None,
            );
            notify(
                &app,
                NotificationEvent::Serve(ServeStage::Failed {
                    backend: backend_name_for_err.clone(),
                    remote: remote_name.clone(),
                    profile: profile.clone(),
                    protocol: protocol.clone(),
                    error: e.to_string(),
                }),
            );
            error
        })?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Successfully stopped serve {server_id}"),
        None,
    );

    refresh_serves_quietly(&app).await;
    info!("✅ Serve {server_id} stopped successfully");

    let backend_name = backend_manager.get_active_name().await;
    notify(
        &app,
        NotificationEvent::Serve(ServeStage::Stopped {
            backend: backend_name,
            remote: remote_name.clone(),
            profile,
            protocol: protocol.clone(),
        }),
    );

    Ok(crate::localized_success!("backendSuccess.serve.stopSuccess", "serverId" => &server_id))
}

/// Stop all running serve instances
#[tauri::command]
pub async fn stop_all_serves(app: AppHandle, context: OperationContext) -> Result<String, String> {
    info!("🗑️ Stopping all serves");

    let transport = app.state::<RcloneState>().transport.clone();
    let backend_manager = app.state::<BackendManager>();

    // If there are no active serves, skip the API call.
    let serves = backend_manager.remote_cache.get_serves().await;
    if serves.is_empty() || context.is_shutdown() {
        debug!("No active serves to stop — skipping STOPALL");
        if !context.is_shutdown() {
            refresh_serves_quietly(&app).await;
        }
        // Silent no-op during shutdown
        return Ok(crate::localized_success!("backendSuccess.serve.stopped"));
    }

    if let Err(e) = transport.rpc(serve::STOPALL, None).await {
        warn!("Failed to stop all serves: {e}");
    }

    if !context.is_shutdown() {
        refresh_serves_quietly(&app).await;
    }

    info!("✅ All serves stopped successfully");

    notify(&app, NotificationEvent::Serve(ServeStage::AllStopped));

    Ok(crate::localized_success!("backendSuccess.serve.stopped"))
}

/// Start a serve using a named profile
/// Resolves all options (serve, vfs, filter, backend) from cached settings
#[tauri::command]
pub async fn start_serve_profile(
    app: AppHandle,
    params: ProfileParams,
) -> Result<ServeStartResponse, String> {
    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        OperationType::Serve.config_key(),
    )
    .await?;

    let mut serve_params = ServeParams::from_config(params.remote_name.clone(), &config, &settings)
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.operations.configIncomplete",
                "profile" => &params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    serve_params.profile = Some(params.profile_name.clone());

    start_serve(app, serve_params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_serve_params_from_config() {
        let config = json!({
            "app": {
                "vfsProfile": "vfs_profile",
                "backendProfile": "backend_profile"
            },
            "rclone": {
                "fs": "my_remote:bucket",
                "serveType": "webdav",
                "addr": ["127.0.0.1:8080"]
            }
        });

        let settings = json!({
            "vfsConfigs": {
                "vfs_profile": {
                    "vfs-cache-mode": "full"
                }
            },
            "backendConfigs": {
                "backend_profile": {
                    "buffer-size": "16M"
                }
            }
        });

        let params = ServeParams::from_config("my_remote".to_string(), &config, &settings).unwrap();
        assert_eq!(params.remote_name, "my_remote");
        assert_eq!(params.source, "my_remote:bucket");
        assert_eq!(params.serve_type, "webdav");
        assert!(params.vfs_options.is_some());
        assert_eq!(
            params.vfs_options.unwrap().get("vfs-cache-mode").unwrap(),
            "full"
        );
    }

    #[test]
    fn test_serve_to_rclone_body() {
        let params = ServeParams {
            remote_name: "my_remote".to_string(),
            source: "my_remote:bucket".to_string(),
            rclone_config: json!({
                "addr": ["127.0.0.1:8080"],
                "user": "admin"
            }),
            backend_options: Some(HashMap::from([("buffer-size".to_string(), json!("16M"))])),
            filter_options: Some(HashMap::from([("exclude".to_string(), json!("secret/*"))])),
            vfs_options: Some(HashMap::from([(
                "vfs-cache-mode".to_string(),
                json!("full"),
            )])),
            runtime_remote_options: None,
            profile: Some("serve_profile".to_string()),
            serve_type: "webdav".to_string(),
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "my_remote:bucket");
        assert_eq!(obj.get("type").unwrap(), "webdav");
        assert_eq!(obj.get("user").unwrap(), "admin");

        // Verify "addr" array unwrapping
        assert_eq!(obj.get("addr").unwrap(), "127.0.0.1:8080");

        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "full");
        assert!(obj.get("vfsOpt").is_none());

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("exclude").unwrap(), "secret/*");

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("buffer-size").unwrap(), "16M");
    }
}
