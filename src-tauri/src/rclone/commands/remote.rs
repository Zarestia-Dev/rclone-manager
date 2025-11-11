use log::{error, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::{engine::ENGINE_STATE, log::clear_remote_logs},
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, config},
        types::{all_types::LogLevel, events::REMOTE_PRESENCE_CHANGED},
    },
};

use super::system::{ensure_oauth_process, redact_sensitive_values};

/// Start non-interactive remote configuration
/// This calls config/create with opt.nonInteractive=true and returns the raw JSON response
#[tauri::command]
pub async fn create_remote_interactive(
    app: AppHandle,
    name: String,
    rclone_type: String,
    parameters: Option<Value>,
    opt: Option<Value>,
    state: State<'_, RcloneState>,
) -> Result<Value, String> {
    // Ensure OAuth/RC helper is running (used for providers requiring OAuth)
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
        "type": rclone_type,
    });

    if let Some(params) = parameters {
        body["parameters"] = params;
    }

    let mut opt_obj = json!({ "nonInteractive": true });
    if let Some(extra) = opt {
        // Merge provided options, overriding defaults
        if let Some(map) = extra.as_object() {
            for (k, v) in map.iter() {
                opt_obj[k] = v.clone();
            }
        }
    }
    body["opt"] = opt_obj;

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
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body_text}"));
    }

    // Return the JSON payload as-is so the UI can drive the flow
    let value: Value =
        serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "raw": body_text }));
    Ok(value)
}

/// Continue non-interactive remote configuration
/// This calls config/update with opt.continue=true, passing state/result and returns the raw JSON response
#[tauri::command]
pub async fn continue_create_remote_interactive(
    app: AppHandle,
    name: String,
    state_token: String,
    result: Value,
    parameters: Option<Value>,
    opt: Option<Value>,
    tauri_state: State<'_, RcloneState>,
) -> Result<Value, String> {
    // Ensure OAuth/RC helper is running
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
    });

    if let Some(params) = parameters.clone() {
        body["parameters"] = params;
    }

    // Build opt object with continue flow
    let mut opt_obj = json!({
        "continue": true,
        "state": state_token,
        "result": result,
        "nonInteractive": true,
    });
    if let Some(extra) = opt
        && let Some(map) = extra.as_object()
    {
        for (k, v) in map.iter() {
            opt_obj[k] = v.clone();
        }
    }
    body["opt"] = opt_obj;

    let url = EndpointHelper::build_url(
        &format!("http://127.0.0.1:{}", ENGINE_STATE.get_oauth().1),
        config::UPDATE,
    );

    let response = tauri_state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body_text}"));
    }

    let value: Value =
        serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "raw": body_text }));

    app.emit(REMOTE_PRESENCE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(value)
}

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

    app.emit(REMOTE_PRESENCE_CHANGED, &name)
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

    app.emit(REMOTE_PRESENCE_CHANGED, &name)
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

    use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;

    match SCHEDULED_TASKS_CACHE.remove_tasks_for_remote(&name).await {
        Ok(removed_ids) => {
            if !removed_ids.is_empty() {
                info!(
                    "Removed {} scheduled task(s) for deleted remote '{}'",
                    removed_ids.len(),
                    name
                );
            }
        }
        Err(e) => {
            warn!(
                "Failed to clean up scheduled tasks for remote '{}': {}",
                name, e
            );
        }
    }

    // 1. The standard presence changed event
    app.emit(REMOTE_PRESENCE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    clear_remote_logs(Some(name.clone()))
        .await
        .unwrap_or_default();
    info!("✅ Remote {name} deleted successfully");
    Ok(())
}
