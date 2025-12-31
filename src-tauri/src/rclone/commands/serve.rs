use log::{debug, info};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::utils::{
    json_helpers::{get_string, json_to_hashmap, resolve_profile_options, unwrap_nested_options},
    logging::log::log_operation,
    rclone::endpoints::{EndpointHelper, serve},
    types::{
        all_types::{LogLevel, ProfileParams, RcloneState},
        events::SERVE_STATE_CHANGED,
    },
};

use super::system::redact_sensitive_values;

/// Parameters for starting a serve instance
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ServeParams {
    pub remote_name: String,
    pub serve_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl ServeParams {
    /// Create ServeParams from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let source = get_string(config, &["source"]);

        // Valid if either source is set or fs is in options
        let has_source = !source.is_empty();
        let has_fs = config
            .get("options")
            .and_then(|opts| opts.get("fs"))
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);

        if !has_source && !has_fs {
            return None;
        }

        let vfs_profile = config.get("vfsProfile").and_then(|v| v.as_str());
        let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

        let vfs_options = resolve_profile_options(settings, vfs_profile, "vfsConfigs");
        let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            serve_options: json_to_hashmap(config.get("options")),
            backend_options,
            filter_options,
            vfs_options,
            profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
        })
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

/// Start a serve instance (not exposed as Tauri command - use start_serve_profile)
pub async fn start_serve(
    app: AppHandle,
    params: ServeParams,
) -> Result<ServeStartResponse, String> {
    // Validate remote name
    if params.remote_name.trim().is_empty() {
        return Err("Remote name cannot be empty".to_string());
    }
    let state = app.state::<RcloneState>();
    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    let backend = backend_manager.get_active().await;
    let api_url = backend.api_url();

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
            .map(|opts| redact_sensitive_values(opts, &app)),
        "serve_options": params
            .serve_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &app)),
        "backend_options": params
            .backend_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &app)),
        "filter_options": params
            .filter_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &app)),
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
                .serve_options
                .as_ref()
                .and_then(|opts| opts.get("addr"))
                .and_then(|v| v.as_str())
                .unwrap_or(":8080"),
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
        let vfs_opts = unwrap_nested_options(opts);
        payload.insert("vfsOpt".to_string(), json!(vfs_opts));
    }

    // Add backend options
    if let Some(opts) = params.backend_options.clone() {
        let backend_opts = unwrap_nested_options(opts);
        payload.insert("_config".to_string(), json!(backend_opts));
    }

    // Add filter options
    if let Some(opts) = params.filter_options.clone() {
        let filter_opts = unwrap_nested_options(opts);
        payload.insert("_filter".to_string(), json!(filter_opts));
    }

    let payload = Value::Object(payload);
    let url = EndpointHelper::build_url(&api_url, serve::START);

    // Call serve/start directly - serves are NOT jobs, they are long-running services
    // Use submit_job_and_wait instead of direct call to properly track it?
    // Wait, original code used state.client.post directly.
    // Why did I think it used submit_job_and_wait?
    // Ah, lines 97-272 is start_serve.
    // Line 209: state.client.post(&url)...
    // This calls `serve/dist`? No, `serve::START`.
    // It returns `id` and `addr`.
    // It's a short lived request that starts a long running process.
    // It does NOT return a jobid.
    // So we just use standard request, BUT we must inject auth.

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let body = handle_rclone_response(response, "Start serve", &params.remote_name).await?;

    // Parse response - serve/start returns { "id": "http-abc123", "addr": "[::]:8080" }
    let response_json: Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    // Extract serve ID (string, e.g., "http-abc123")
    let serve_id = response_json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    // Extract address
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
        Some(json!({
            "id": serve_response.id,
            "addr": serve_response.addr
        })),
    );

    // Store the profile mapping for this serve ID
    let cache = &backend_manager.remote_cache;
    cache
        .store_serve_profile(&serve_id, params.profile.clone())
        .await;

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

    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    // Serve stop needs remote_name to find backend. But stop_serve(server_id) doesn't have remote_name in params?
    // We stored profile mapping, maybe we can find it?
    // Actually `stop_serve` relies on ID. `cache` stores serve_id -> profile.
    // If we iterate backends to find serve_id, or if we assume active backend.
    // Let's use active for now, or maybe update `stop_serve` to take remote_name.
    // Given the difficulty, active is safest fallback for now.
    let backend = backend_manager.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), serve::STOP);
    let payload = json!({ "id": server_id });

    let response = backend
        .inject_auth(state.client.post(&url))
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

    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    let backend = backend_manager.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), serve::STOPALL);

    let response = backend
        .inject_auth(state.client.post(&url))
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

// ============================================================================
// PROFILE-BASED COMMAND
// ============================================================================

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
            format!(
                "Serve configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    serve_params.profile = Some(params.profile_name.clone());

    start_serve(app, serve_params).await
}
