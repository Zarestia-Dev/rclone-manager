use std::collections::HashMap;

use crate::context::AppHandle;
use log::{debug, info, warn};
use serde_json::{Value, json};

use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport, types::Backend};
use crate::rclone::endpoints::serve;
use crate::rclone::state::watcher::refresh_serves_quietly;
use crate::services::paths::AppPaths;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::app::notification::ServeStage;
use crate::utils::app::notification::notify;
use crate::utils::logging::log::log_operation;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::remotes::OperationType;
use crate::utils::types::remotes::ProfileParams;

use super::common::{CommonConfigParams, OperationContext, parse_common_config, redact_value};

/// Parameters for starting a serve instance
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ServeParams {
    #[serde(skip)]
    pub backend: Option<Backend>,
    pub remote_name: String,
    pub source: String,
    pub rclone_config: Value,
    pub backend_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub serve_type: String,
    pub origin: Option<crate::utils::types::origin::Origin>,
    pub quick_run_id: Option<String>,
    pub execute_id: Option<String>,
    pub workflow_id: Option<String>,
    pub node_id: Option<String>,
}

impl ServeParams {
    /// Create `ServeParams` from a profile config and settings
    pub fn from_config(
        remote_name: String,
        config: &Value,
        settings: &Value,
    ) -> Result<Self, String> {
        Ok(Self::from_common(
            remote_name,
            parse_common_config(config, settings)?,
        ))
    }

    pub fn from_common(remote_name: String, common: CommonConfigParams) -> Self {
        let rclone_config = &common.rclone_config;
        let serve_type = rclone_config
            .get("type")
            .or_else(|| rclone_config.get("serveType"))
            .and_then(|v| v.as_str())
            .unwrap_or("http")
            .to_string();

        Self {
            backend: None,
            remote_name,
            source: common.first_source(),
            rclone_config: common.rclone_config.clone(),
            backend_options: common.backend_options,
            filter_options: common.filter_options,
            vfs_options: common.vfs_options,
            runtime_remote_options: common.runtime_remote_options,
            profile: common.profile,
            serve_type,
            origin: None,
            quick_run_id: None,
            execute_id: None,
            workflow_id: None,
            node_id: None,
        }
    }

    pub fn to_rclone_body(&self) -> Result<Value, String> {
        let mut builder = crate::rclone::commands::common::RclonePayloadBuilder::from_rclone_config(
            &self.rclone_config,
        );

        // Pre-process serve options to handle "addr" array issue
        if let Some(Value::Array(arr)) = builder.get("addr")
            && arr.len() == 1
            && arr[0].is_string()
        {
            let single = arr[0].clone();
            builder.insert("addr", single);
        }

        builder
            .insert("fs", self.source.as_str())
            .insert("type", self.serve_type.as_str())
            .with_vfs_options(self.vfs_options.as_ref())
            .with_filter_options(self.filter_options.as_ref())
            .with_backend_options(self.backend_options.as_ref());
        builder.with_runtime_remote_options(self.runtime_remote_options.as_ref())?;
        Ok(builder.build())
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

    let backend_manager = app.state::<BackendManager>();
    let backend = match &params.backend {
        Some(backend) => backend.clone(),
        None => backend_manager.get_active().await,
    };
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());

    let serve_type = &params.serve_type;

    debug!("🚀 Starting {serve_type} serve for {}", params.remote_name);

    let mut payload = params.to_rclone_body()?;

    // Auto-inject our custom template for web-based protocols if not already specified
    if backend.is_local
        && (serve_type == "http" || serve_type == "webdav")
        && payload.get("template").is_none()
    {
        let app_paths = app.state::<AppPaths>();
        let template_path = app_paths.serve_template_path()?;

        if template_path.exists()
            && let Some(obj) = payload.as_object_mut()
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

    debug!(
        "📦 Serve request payload: {:#?}",
        redact_value(&payload, &app)
    );

    let backend_name_for_err = backend.name.clone();

    // Call serve/start via the transport
    let response_json = transport
        .rpc(serve::START, Some(&payload))
        .await
        .map_err(|e| {
            let mapped_error =
                crate::rclone::engine::error_mapper::map_or_wrap_serve_error(&e.to_string());
            log_operation(
                LogLevel::Error,
                Some(params.remote_name.clone()),
                Some("Start serve".to_string()),
                mapped_error.clone(),
                None,
            );
            notify(
                &app,
                NotificationEvent::Serve(ServeStage::Failed {
                    backend: backend_name_for_err.clone(),
                    remote: params.remote_name.clone(),
                    profile: params.profile.clone(),
                    protocol: serve_type.clone(),
                    error: mapped_error.clone(),
                }),
            );
            mapped_error
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

    // Pre-seed metadata so the reconciliation attaches profile / quick_run_id atomically
    backend_manager
        .remote_cache_for(&backend.name)
        .preseed_serve_metadata(crate::utils::types::remotes::ServeInstance {
            id: serve_id,
            addr: addr.clone(),
            params: payload,
            profile: params.profile.clone(),
            quick_run_id: params.quick_run_id.clone(),
            origin: params.origin.clone(),
            execute_id: params.execute_id.clone(),
            workflow_id: params.workflow_id.clone(),
            node_id: params.node_id.clone(),
        })
        .await;
    refresh_serves_quietly(&app, &backend).await;
    info!(
        "✅ Serve {} started: ID={}, Address={}",
        params.remote_name, serve_response.id, serve_response.addr
    );

    let backend_name = backend.name.clone();
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
pub async fn stop_serve(
    app: AppHandle,
    server_id: String,
    remote_name: String,
) -> Result<String, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    stop_serve_on_backend(app, backend, server_id, remote_name).await
}

pub(crate) async fn stop_serve_on_backend(
    app: AppHandle,
    backend: Backend,
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

    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let backend_manager = app.state::<BackendManager>();
    let payload = json!({ "id": server_id });

    // Get serve details from cache before stopping
    let serve_info = backend_manager
        .remote_cache_for(&backend.name)
        .get_serve_by_id(&server_id)
        .await;
    let profile = serve_info.as_ref().and_then(|s| s.profile.clone());
    let protocol = serve_info
        .as_ref()
        .and_then(|s| s.params.get("type").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string();

    let backend_name_for_err = backend.name.clone();

    let result = transport
        .rpc(serve::STOP, Some(&payload))
        .await
        .map_err(|e| {
            let err_str = e.to_string();
            let error =
                crate::localized_error!("backendErrors.serve.stopFailed", "error" => &err_str);
            log_operation(
                LogLevel::Error,
                Some(remote_name.clone()),
                Some("Stop serve".to_string()),
                error.clone(),
                None,
            );
            notify(
                &app,
                NotificationEvent::Serve(ServeStage::StopFailed {
                    backend: backend_name_for_err.clone(),
                    remote: remote_name.clone(),
                    profile: profile.clone(),
                    protocol: protocol.clone(),
                    error: error.clone(),
                }),
            );
            error
        });

    if let Err(err) = result {
        refresh_serves_quietly(&app, &backend).await;
        return Err(err);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Successfully stopped serve {server_id}"),
        None,
    );

    refresh_serves_quietly(&app, &backend).await;
    info!("✅ Serve {server_id} stopped successfully");

    let backend_name = backend.name.clone();
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

/// Stop all serves on the backend selected when the command starts.
pub async fn stop_all_serves(app: AppHandle, context: OperationContext) -> Result<String, String> {
    info!("🗑️ Stopping all serves");

    let backend = app.state::<BackendManager>().get_active().await;
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());

    if let Err(e) = transport.rpc(serve::STOPALL, None).await {
        if !context.is_shutdown() {
            // rclone removes server registrations even when Shutdown returns an error.
            refresh_serves_quietly(&app, &backend).await;
            return Err(crate::localized_error!("backendErrors.serve.stopFailed", "error" => e));
        }
        warn!("Failed to stop all serves during shutdown: {e}");
        return Ok(crate::localized_success!("backendSuccess.serve.stopped"));
    }

    if !context.is_shutdown() {
        refresh_serves_quietly(&app, &backend).await;
        notify(&app, NotificationEvent::Serve(ServeStage::AllStopped));
    }

    info!("✅ All serves stopped successfully");

    Ok(crate::localized_success!("backendSuccess.serve.stopped"))
}

/// Start a serve using a named profile
/// Resolves all options (serve, vfs, filter, backend) from cached settings
pub async fn start_serve_profile(
    app: AppHandle,
    params: ProfileParams,
) -> Result<ServeStartResponse, String> {
    let resolved = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        OperationType::Serve,
        params.backend_name.as_deref(),
    )
    .await?;

    let mut serve_params = ServeParams::from_common(params.remote_name.clone(), resolved.params);

    // Ensure profile is set from the function parameter, not the config object
    serve_params.backend = Some(resolved.backend);
    serve_params.profile = Some(params.profile_name.clone());
    serve_params.origin = params
        .source
        .or(Some(crate::utils::types::origin::Origin::Dashboard));
    serve_params.quick_run_id = None;
    serve_params.execute_id = Some(uuid::Uuid::new_v4().to_string());

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
            backend: None,
            remote_name: "my_remote".to_string(),
            source: "my_remote:bucket".to_string(),
            rclone_config: json!({
                "addr": ["127.0.0.1:8080"],
                "user": "admin"
            }),
            backend_options: Some(HashMap::from([
                ("buffer-size".to_string(), json!("16M")),
                ("BufferSize".to_string(), json!("32M")),
            ])),
            filter_options: Some(HashMap::from([
                ("exclude".to_string(), json!("secret/*")),
                ("ExcludeRule".to_string(), json!(["*.bak"])),
            ])),
            vfs_options: Some(HashMap::from([
                ("vfs-cache-mode".to_string(), json!("full")),
                ("CacheMode".to_string(), json!("off")),
            ])),
            runtime_remote_options: None,
            profile: Some("serve_profile".to_string()),
            origin: None,
            quick_run_id: None,
            execute_id: None,
            workflow_id: None,
            node_id: None,
            serve_type: "webdav".to_string(),
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "my_remote:bucket");
        assert_eq!(obj.get("type").unwrap(), "webdav");
        assert_eq!(obj.get("user").unwrap(), "admin");

        // Verify "addr" array unwrapping
        assert_eq!(obj.get("addr").unwrap(), "127.0.0.1:8080");

        // Flat lowercase keys placed directly at root level (normalized)
        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "full");
        assert_eq!(obj.get("exclude").unwrap(), "secret/*");
        assert_eq!(obj.get("buffer_size").unwrap(), "16M");

        // PascalCase nested options placed into their respective blocks
        let vfs_opt = obj.get("vfsOpt").unwrap().as_object().unwrap();
        assert_eq!(vfs_opt.get("CacheMode").unwrap(), "off");

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("ExcludeRule").unwrap(), &json!(["*.bak"]));

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("BufferSize").unwrap(), "32M");
    }
}
