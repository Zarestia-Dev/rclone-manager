use log::{error, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    core::scheduler::engine::CronScheduler,
    rclone::{
        backend::BackendManager,
        commands::{common::redact_sensitive_values, system::ensure_oauth_process},
        state::scheduled_tasks::ScheduledTasksCache,
    },
    utils::{
        logging::log::log_operation,
        rclone::endpoints::config,
        types::{
            core::RcloneState,
            events::REMOTE_CACHE_CHANGED,
            logs::{LogCache, LogLevel},
        },
    },
};

/// Start non-interactive remote configuration
/// This calls config/create with opt.nonInteractive=true and returns the raw JSON response
#[tauri::command]
pub async fn create_remote_interactive(
    app: AppHandle,
    name: String,
    rclone_type: String,
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<RcloneState>();
    // Ensure OAuth/RC helper is running (used for providers requiring OAuth)
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
        "type": rclone_type,
    });

    if let Some(params) = parameters {
        body["parameters"] = json!(params);
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

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // For Local backend: use OAuth port (separate rclone instance)
    // For Remote backend: use main API directly (no separate OAuth process)
    let url = if backend.is_local {
        backend
            .oauth_url_for(config::CREATE)
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))?
    } else {
        backend.url_for(config::CREATE)
    };

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text),
        );
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
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
) -> Result<Value, String> {
    let tauri_state = app.state::<RcloneState>();
    // Ensure OAuth/RC helper is running
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
    });

    if let Some(params) = parameters.clone() {
        body["parameters"] = json!(params);
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

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // For Local backend: use OAuth port (separate rclone instance)
    // For Remote backend: use main API directly (no separate OAuth process)
    let url = if backend.is_local {
        backend
            .oauth_url_for(config::UPDATE)
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))?
    } else {
        backend.url_for(config::UPDATE)
    };

    let response = backend
        .inject_auth(tauri_state.client.post(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text),
        );
    }

    let value: Value =
        serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "raw": body_text }));

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(value)
}

/// Create a new remote configuration
#[tauri::command]
pub async fn create_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_obj = redact_sensitive_values(&parameters, &app);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
        "Creating new remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    );

    // Handle OAuth process
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let body = json!({
        "name": name,
        "type": remote_type,
        "parameters": json!(parameters)
    });

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // For Local backend: use OAuth port (separate rclone instance)
    // For Remote backend: use main API directly (no separate OAuth process)
    let url = if backend.is_local {
        backend
            .oauth_url_for(config::CREATE)
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))?
    } else {
        backend.url_for(config::CREATE)
    };

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = if body_text.contains("failed to get oauth token") {
            "OAuth authentication failed or was not completed".to_string()
        } else if body_text.contains("bind: address already in use") {
            "Port already in use".to_string()
        } else {
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text)
        };

        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("New remote creation".to_string()),
            "Failed to create remote".to_string(),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
        "Remote created successfully".to_string(),
        None,
    );

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(())
}

/// Update an existing remote configuration
#[tauri::command]
pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_obj = redact_sensitive_values(&parameters, &app);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Updating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    );

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // For Local backend: use OAuth port (separate rclone instance)
    // For Remote backend: use main API directly (no separate OAuth process)
    let url = if backend.is_local {
        backend
            .oauth_url_for(config::UPDATE)
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))?
    } else {
        backend.url_for(config::UPDATE)
    };
    let body = json!({ "name": name, "parameters": parameters });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text);
        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("Remote update".to_string()),
            "Failed to update remote".to_string(),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Remote updated successfully".to_string(),
        None,
    );

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_remote(
    app: AppHandle,
    name: String,
    cache: State<'_, ScheduledTasksCache>,
    scheduler: State<'_, CronScheduler>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    info!("🗑️ Deleting remote: {name}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let _ = backend
        .post_json(&state.client, config::DELETE, Some(&json!({"name": name})))
        .await
        .map_err(|e| {
            let error = format!("Failed to delete remote: {e}");
            error!("❌ Failed to delete remote: {error}");
            error
        })?;

    match cache
        .remove_tasks_for_remote(&name, scheduler, Some(&app))
        .await
    {
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
    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    let log_cache = app.state::<LogCache>();
    log_cache.clear_for_remote(&name).await;

    info!("✅ Remote {name} deleted successfully");
    Ok(())
}
