use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

use crate::{
    core::paths::AppPaths,
    rclone::{backend::BackendManager, state::watcher::force_check_serves},
    utils::{
        app::notification::{NotificationEvent, ServeStage, notify},
        logging::log::log_operation,
        rclone::endpoints::serve,
        types::{logs::LogLevel, remotes::ProfileParams, state::RcloneState},
    },
};

use super::common::{
    OperationContext, fs_value_with_runtime_overrides, parse_common_config, redact_sensitive_values,
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
            body.insert(
                "vfsOpt".to_string(),
                serde_json::to_value(vfs_opts).unwrap(),
            );
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

    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let serve_type = &params.serve_type;

    debug!("🚀 Starting {serve_type} serve for {}", params.remote_name);

    let serve_opts_map = params
        .rclone_config
        .as_object()
        .map(|obj| {
            obj.clone()
                .into_iter()
                .filter(|(k, _)| k != "fs" && k != "type")
                .collect()
        })
        .unwrap_or_default();

    let log_context = json!({
        "remote_name": params.remote_name,
        "serve_options": redact_sensitive_values(&serve_opts_map, &app),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Start serve".to_string()),
        format!("Attempting to start {serve_type} serve"),
        Some(log_context),
    );

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

    debug!("📦 Serve request payload: {payload:#?}");

    let backend_name_for_err = backend_manager.get_active_name().await;

    // Call serve/start directly
    let response_json = backend
        .post_json(&state.client, serve::START, Some(&payload))
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
                    error: e.clone(),
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
        Some(json!({ "id": serve_response.id, "addr": serve_response.addr })),
    );

    // Refresh first so the entry exists in cache, then attach the profile to it.
    if let Err(e) = force_check_serves(app.clone()).await {
        warn!("Failed to refresh serves: {e}");
    }
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

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
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

    let _ = backend
        .post_json(
            &app.state::<RcloneState>().client,
            serve::STOP,
            Some(&payload),
        )
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
                    error: e.clone(),
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

    if let Err(e) = force_check_serves(app.clone()).await {
        warn!("Failed to refresh serves: {e}");
    }
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

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // If there are no active serves, skip the API call.
    let serves = backend_manager.remote_cache.get_serves().await;
    if serves.is_empty() || context.is_shutdown() {
        debug!("No active serves to stop — skipping STOPALL");
        if !context.is_shutdown()
            && let Err(e) = force_check_serves(app.clone()).await
        {
            warn!("Failed to refresh serves: {e}");
        }
        // Silent no-op during shutdown
        return Ok(crate::localized_success!("backendSuccess.serve.stopped"));
    }

    if let Err(e) = backend
        .post_json(&app.state::<RcloneState>().client, serve::STOPALL, None)
        .await
    {
        warn!("Failed to stop all serves: {e}");
    }

    if !context.is_shutdown()
        && let Err(e) = force_check_serves(app.clone()).await
    {
        warn!("Failed to refresh serves: {e}");
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
        "serveConfigs",
    )
    .await?;

    let mut serve_params = ServeParams::from_config(params.remote_name.clone(), &config, &settings)
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.sync.configIncomplete",
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

        let vfs_opt = obj.get("vfsOpt").unwrap().as_object().unwrap();
        assert_eq!(vfs_opt.get("vfs-cache-mode").unwrap(), "full");

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("exclude").unwrap(), "secret/*");

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("buffer-size").unwrap(), "16M");
    }
}
