use log::{debug, error, info};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::engine::ENGINE_STATE,
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, serve},
        types::{all_types::LogLevel, events::SERVE_STATE_CHANGED},
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
}

/// Response from starting a serve instance
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ServeStartResponse {
    pub id: String,   // Server ID (e.g., "http-abc123")
    pub addr: String, // Address server is listening on
}

/// Start a serve instance
#[tauri::command]
pub async fn start_serve(
    app: AppHandle,
    params: ServeParams,
    state: State<'_, RcloneState>,
) -> Result<ServeStartResponse, String> {
    debug!("🚀 Starting serve with params: {params:#?}");

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
    )
    .await;

    // Prepare payload
    let mut payload = serde_json::Map::new();

    // Add serve-type specific options directly to payload
    if let Some(opts) = params.serve_options.clone() {
        for (key, value) in opts {
            // Handle arrays by converting to comma-separated string
            let converted_value = if let Value::Array(arr) = value {
                let strings: Vec<String> = arr
                    .iter()
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        Value::Number(n) => n.to_string(),
                        Value::Bool(b) => b.to_string(),
                        _ => v.to_string(),
                    })
                    .collect();
                Value::String(strings.join(","))
            } else {
                value
            };
            payload.insert(key, converted_value);
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

    // Make the request
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, serve::START);
    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            let error = format!("Serve start request failed: {e}");
            let error_for_log = error.clone();
            let remote_name_clone = params.remote_name.clone();
            let payload_clone = payload.clone();
            tauri::async_runtime::spawn(async move {
                log_operation(
                    LogLevel::Error,
                    Some(remote_name_clone),
                    Some("Start serve".to_string()),
                    error_for_log,
                    Some(json!({"payload": payload_clone})),
                )
                .await;
            });
            error
        })?;

    // Handle response
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    debug!("📥 Serve start response: status={}, body={}", status, body);

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Start serve".to_string()),
            format!("Failed to start serve: {error}"),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    // Try to parse the response - handle different possible formats
    let serve_response = if let Ok(response) = serde_json::from_str::<ServeStartResponse>(&body) {
        response
    } else {
        // Try to parse as a response with just addr
        #[derive(serde::Deserialize)]
        struct PartialResponse {
            addr: String,
        }
        let partial: PartialResponse =
            serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

        // Generate ID for partial response
        use uuid::Uuid;
        let id = format!(
            "{}-{}",
            params
                .serve_options
                .as_ref()
                .and_then(|opts| opts.get("type"))
                .unwrap_or(&Value::from("unknown")),
            Uuid::new_v4().simple()
        );
        debug!("🔧 Generated serve ID for partial response: {}", id);

        ServeStartResponse {
            id,
            addr: partial.addr,
        }
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
    )
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
    if server_id.trim().is_empty() {
        return Err("Server ID cannot be empty".to_string());
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Attempting to stop serve with ID {server_id}"),
        None,
    )
    .await;

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, serve::STOP);
    let payload = json!({ "id": server_id });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Stop serve".to_string()),
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        error!("❌ Failed to stop serve {server_id}: {error}");
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop serve".to_string()),
        format!("Successfully stopped serve {server_id}"),
        None,
    )
    .await;

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

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        error!("❌ Failed to stop all serves: {error}");
        return Err(error);
    }

    if context != "shutdown" {
        app.emit(SERVE_STATE_CHANGED, "all")
            .map_err(|e| format!("Failed to emit event: {e}"))?;
    }

    info!("✅ All serves stopped successfully");

    Ok("✅ All serves stopped successfully".to_string())
}
