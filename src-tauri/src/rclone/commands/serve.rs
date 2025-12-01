use log::{debug, info};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    RcloneState,
    rclone::{commands::job::submit_job, state::engine::ENGINE_STATE},
    utils::{
        json_helpers::{get_string, json_to_hashmap},
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, serve},
        types::{
            all_types::{JobCache, LogLevel},
            events::SERVE_STATE_CHANGED,
        },
    },
};

use super::system::redact_sensitive_values;
use crate::rclone::commands::job::JobMetadata;

/// Parameters for starting a serve instance
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ServeParams {
    pub remote_name: String,
    pub serve_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
}

impl ServeParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let serve_cfg = settings.get("serveConfig")?;

        let source = get_string(serve_cfg, &["source"]);

        // Valid if either source is set or fs is in options
        let has_source = !source.is_empty();
        let has_fs = serve_cfg
            .get("options")
            .and_then(|opts| opts.get("fs"))
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);

        if !has_source && !has_fs {
            return None;
        }

        Some(Self {
            remote_name,
            serve_options: json_to_hashmap(serve_cfg.get("options")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            vfs_options: json_to_hashmap(settings.get("vfsConfig")),
        })
    }

    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("serveConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

/// Response from starting a serve instance
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ServeStartResponse {
    pub id: String,   // Server ID (e.g., "http-abc123")
    pub addr: String, // Address server is listening on
}

/// Helper function to handle rclone API responses
async fn handle_rclone_response(
    response: reqwest::Response,
    operation: &str,
    remote_name: &str,
) -> Result<String, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("Failed to {}: {error}", operation.to_lowercase()),
            Some(json!({"response": body})),
        );
        return Err(error);
    }

    Ok(body)
}

/// Start a serve instance
#[tauri::command]
pub async fn start_serve(
    app: AppHandle,
    _job_cache: State<'_, JobCache>,
    params: ServeParams,
) -> Result<ServeStartResponse, String> {
    // Validate remote name
    if params.remote_name.trim().is_empty() {
        return Err("Remote name cannot be empty".to_string());
    }
    let state = app.state::<RcloneState>();

    // Validate serve type is specified
    let serve_type = params
        .serve_options
        .as_ref()
        .and_then(|opts| opts.get("type"))
        .ok_or_else(|| "Serve type must be specified".to_string())?;

    debug!("🚀 Starting {serve_type} serve for {}", params.remote_name);

    // Prepare logging context
    let log_context = json!({
        "remote_name": params.remote_name,
        "vfs_options": params
            .vfs_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "serve_options": params
            .serve_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "backend_options": params
            .backend_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "filter_options": params
            .filter_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Start serve".to_string()),
        format!(
            "Attempting to start {} serve at {}",
            params
                .serve_options
                .as_ref()
                .and_then(|opts| opts.get("type"))
                .unwrap_or(&Value::from("unknown")),
            params
                .backend_options
                .as_ref()
                .and_then(|opts| opts.get("ListenAddr"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
        ),
        Some(log_context),
    );

    // Prepare payload
    let mut payload = serde_json::Map::new();

    // Add serve-type specific options directly to payload
    if let Some(opts) = params.serve_options.clone() {
        for (key, value) in opts {
            // Handle 'addr' potentially being a single-element array from frontend config
            let final_value = if key == "addr" {
                match &value {
                    Value::Array(arr) if arr.len() == 1 && arr[0].is_string() => arr[0].clone(),
                    _ => value,
                }
            } else {
                value
            };
            payload.insert(key, final_value);
        }
    }

    debug!("📦 Serve request payload: {payload:#?}");

    // Add VFS options
    if let Some(opts) = params.vfs_options.clone() {
        payload.insert("vfsOpt".to_string(), json!(opts));
    }

    // Add backend options
    if let Some(opts) = params.backend_options.clone() {
        payload.insert("_config".to_string(), json!(opts));
    }

    // Add filter options
    if let Some(opts) = params.filter_options.clone() {
        payload.insert("_filter".to_string(), json!(opts));
    }

    let payload = Value::Object(payload);

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, serve::START);

    // Determine source string for metadata
    let source_str = params
        .serve_options
        .as_ref()
        .and_then(|o| o.get("fs"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let (jobid, response_json) = submit_job(
        app.clone(),
        state.client.clone(),
        url,
        payload,
        JobMetadata {
            remote_name: params.remote_name.clone(),
            job_type: "serve".to_string(),
            operation_name: "Start serve".to_string(),
            source: source_str,
            destination: "Initializing...".to_string(),
        },
    )
    .await?;

    // Extract address from response (Serve specific)
    let addr = response_json
        .get("addr")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let serve_response = ServeStartResponse {
        id: jobid.to_string(), // Or response_json["id"] if jobid was parsed differently
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
        Some(json!({
            "id": serve_response.id,
            "addr": serve_response.addr
        })),
    );

    // Emit event for UI update
    app.emit(SERVE_STATE_CHANGED, &params.remote_name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!(
        "✅ Serve {} started: ID={}, Address={}",
        params.remote_name, serve_response.id, serve_response.addr
    );

    Ok(serve_response)
}
/// Stop a specific serve instance by ID
#[tauri::command]
pub async fn stop_serve(
    app: AppHandle,
    server_id: String,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Attempting to stop serve with ID {server_id}"),
        None,
    );

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, serve::STOP);
    let payload = json!({ "id": server_id });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let _body = handle_rclone_response(response, "Stop serve", &remote_name).await?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Successfully stopped serve {server_id}"),
        None,
    );

    app.emit(SERVE_STATE_CHANGED, &remote_name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!("✅ Serve {server_id} stopped successfully");

    Ok(format!("Successfully stopped serve {server_id}"))
}

/// Stop all running serve instances
#[tauri::command]
pub async fn stop_all_serves(
    app: AppHandle,
    state: State<'_, RcloneState>,
    context: String,
) -> Result<String, String> {
    info!("🗑️ Stopping all serves");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, serve::STOPALL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let _body = handle_rclone_response(response, "Stop all serves", "").await?;

    if context != "shutdown" {
        app.emit(SERVE_STATE_CHANGED, "all")
            .map_err(|e| format!("Failed to emit event: {e}"))?;
    }

    info!("✅ All serves stopped successfully");

    Ok("✅ All serves stopped successfully".to_string())
}
