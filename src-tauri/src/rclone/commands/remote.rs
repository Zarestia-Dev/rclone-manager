use log::{error, info};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::{ENGINE_STATE, clear_remote_logs},
    utils::{
        log::log_operation,
        rclone::endpoints::{EndpointHelper, config},
        types::LogLevel,
    },
};

use super::oauth::{ensure_oauth_process, redact_sensitive_values};

/// Create a new remote configuration
#[tauri::command]
pub async fn create_remote(
    app: AppHandle,
    name: String,
    parameters: Value,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_map: HashMap<String, Value> = parameters
        .as_object()
        .ok_or("Parameters must be an object")?
        .clone()
        .into_iter()
        .collect();
    let params_obj = redact_sensitive_values(&params_map, &state.restrict_mode);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
        "Creating new remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    // Handle OAuth process
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let body = json!({
        "name": name,
        "type": remote_type,
        "parameters": parameters
    });

    let url = EndpointHelper::build_url(
        &format!("http://127.0.0.1:{}", ENGINE_STATE.get_oauth().1),
        config::CREATE,
    );

    let response = state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    println!("Response: {body}");

    if !status.is_success() {
        let error = if body.contains("failed to get oauth token") {
            "OAuth authentication failed or was not completed".to_string()
        } else if body.contains("bind: address already in use") {
            format!("Port {} already in use", ENGINE_STATE.get_oauth().1)
        } else {
            format!("HTTP {status}: {body}")
        };

        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("New remote creation".to_string()),
            "Failed to create remote".to_string(),
            Some(json!({"response": body})),
        )
        .await;

        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
        "Remote created successfully".to_string(),
        None,
    )
    .await;

    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(())
}

/// Update an existing remote configuration
#[tauri::command]
pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_obj = redact_sensitive_values(&parameters, &state.restrict_mode);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Updating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let url = EndpointHelper::build_url(
        &format!("http://127.0.0.1:{}", ENGINE_STATE.get_oauth().1),
        config::UPDATE,
    );
    let body = json!({ "name": name, "parameters": parameters });

    let response = state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("Remote update".to_string()),
            "Failed to update remote".to_string(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Remote updated successfully".to_string(),
        None,
    )
    .await;

    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_remote(
    app: AppHandle,
    name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    info!("🗑️ Deleting remote: {name}");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::DELETE);

    let response = state
        .client
        .post(&url)
        .query(&[("name", &name)])
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        error!("❌ Failed to delete remote: {error}");
        return Err(error);
    }

    // Emit two events:
    // 1. The standard presence changed event
    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    // 2. A new specific event for deletion
    app.emit("remote_deleted", &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    clear_remote_logs(Some(name.clone()))
        .await
        .unwrap_or_default();
    info!("✅ Remote {name} deleted successfully");
    Ok(())
}
