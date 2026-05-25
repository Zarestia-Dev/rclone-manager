use futures::future::join_all;
use log::{error, info, warn};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::settings::remote::manager::delete_remote_settings,
    rclone::{
        backend::BackendManager,
        commands::{
            common::redact_sensitive_values,
            job::stop_job,
            mount::unmount_remote,
            serve::stop_serve,
            system::{clear_fscache, ensure_oauth_process, get_fscache_entries},
        },
        state::automations::AutomationsCache,
    },
    utils::{
        logging::log::log_operation,
        rclone::endpoints::config,
        types::{
            events::REMOTE_CACHE_CHANGED,
            logs::{LogCache, LogLevel},
            state::RcloneState,
        },
    },
};

async fn call_config(app: &AppHandle, endpoint: &str, body: Value) -> Result<Value, String> {
    let state = app.state::<RcloneState>();
    let backend = app.state::<BackendManager>().get_active().await;
    let url = crate::rclone::commands::common::get_config_url(&backend, endpoint);

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(crate::localized_error!(
            "backendErrors.http.error",
            "status" => status,
            "body"   => text
        ));
    }

    Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text })))
}

fn build_opt(user_opt: Option<Value>, protocol_keys: Value) -> Value {
    let mut map = Map::new();

    if let Some(Value::Object(user)) = user_opt {
        map.extend(user);
    }
    if let Value::Object(protocol) = protocol_keys {
        map.extend(protocol);
    }

    Value::Object(map)
}

#[tauri::command]
pub async fn create_remote_interactive(
    app: AppHandle,
    name: String,
    rclone_type: String,
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
) -> Result<Value, String> {
    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Starting interactive config flow".to_string(),
        Some(json!({ "type": rclone_type })),
    );

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
        "type": rclone_type,
        "opt":  build_opt(opt, json!({ "nonInteractive": true })),
    });

    if let Some(params) = parameters {
        body["parameters"] = json!(params);
    }

    let value = call_config(&app, config::CREATE, body).await?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Config step completed".to_string(),
        None,
    );

    Ok(value)
}

#[tauri::command]
pub async fn continue_create_remote_interactive(
    app: AppHandle,
    name: String,
    state_token: String,
    result: Value,
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
) -> Result<Value, String> {
    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Continuing config flow".to_string(),
        Some(json!({ "state": state_token })),
    );

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name": name,
        "opt": build_opt(opt, json!({
            "continue":       true,
            "state":          state_token,
            "result":         result,
            "nonInteractive": true,
        })),
    });

    if let Some(params) = parameters {
        body["parameters"] = json!(params);
    }

    let value = call_config(&app, config::UPDATE, body).await?;

    if let Err(e) = clear_fscache(app.clone()).await {
        warn!("Failed to clear fscache after interactive remote update: {e}");
    }

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Config step answered".to_string(),
        None,
    );

    Ok(value)
}

#[tauri::command]
pub async fn create_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
) -> Result<(), String> {
    let Some(remote_type) = parameters.get("type").and_then(|v| v.as_str()) else {
        return Err("Missing remote type".into());
    };

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote creation".to_string()),
        "Creating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": redact_sensitive_values(&parameters, &app),
        })),
    );

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({
        "name":       name,
        "type":       remote_type,
        "parameters": parameters,
    });

    if let Some(extra) = opt {
        body["opt"] = extra;
    }

    call_config(&app, config::CREATE, body).await.map_err(|e| {
        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("Remote creation".to_string()),
            "Failed to create remote".to_string(),
            Some(json!({ "error": e })),
        );
        match e {
            ref s if s.contains("failed to get oauth token") => {
                "OAuth authentication failed or was not completed".into()
            }
            ref s if s.contains("bind: address already in use") => "Port already in use".into(),
            _ => e,
        }
    })?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote creation".to_string()),
        "Remote created successfully".to_string(),
        None,
    );

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    let _ = get_fscache_entries(app).await;

    Ok(())
}

#[tauri::command]
pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
) -> Result<(), String> {
    let Some(remote_type) = parameters.get("type").and_then(|v| v.as_str()) else {
        return Err("Missing remote type".into());
    };

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Updating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": redact_sensitive_values(&parameters, &app),
        })),
    );

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut body = json!({ "name": name, "parameters": parameters });

    if let Some(extra) = opt {
        body["opt"] = extra;
    }

    call_config(&app, config::UPDATE, body).await.map_err(|e| {
        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("Remote update".to_string()),
            "Failed to update remote".to_string(),
            Some(json!({ "error": e })),
        );
        e
    })?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Remote updated successfully".to_string(),
        None,
    );

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    if let Err(e) = clear_fscache(app.clone()).await {
        warn!("Failed to clear fscache after remote update: {e}");
    }

    let _ = get_fscache_entries(app).await;

    Ok(())
}

#[tauri::command]
pub async fn delete_remote(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let cache = app.state::<AutomationsCache>();
    info!("🗑️ Deleting remote: {name}");

    let state = app.state::<RcloneState>();
    let backend = app.state::<BackendManager>().get_active().await;

    match cache
        .remove_automations_for_remote(&backend.name, &name, Some(&app))
        .await
    {
        Ok(ids) if !ids.is_empty() => {
            info!(
                "Removed {} automation(s) for deleted remote '{name}'",
                ids.len()
            );
        }
        Err(e) => warn!("Failed to clean up automations for remote '{name}': {e}"),
        _ => {}
    }

    let backend_manager = app.state::<BackendManager>();
    let remote_prefix = format!("{name}:");

    // Unmount all associated mounts
    let mounted = backend_manager.remote_cache.get_mounted_remotes().await;
    join_all(
        mounted
            .into_iter()
            .filter(|m| m.fs.starts_with(&remote_prefix))
            .map(|m| {
                let app = app.clone();
                let name = name.clone();
                async move {
                    info!("  - Unmounting: {} at {}", m.fs, m.mount_point);
                    let _ = unmount_remote(app, m.mount_point, name).await;
                }
            }),
    )
    .await;

    // Stop all associated serves
    let serves = backend_manager.remote_cache.get_serves().await;
    join_all(serves.into_iter().filter_map(|s| {
        let fs = s.params.get("fs").and_then(|v| v.as_str())?;
        if !fs.starts_with(&remote_prefix) {
            return None;
        }

        let app = app.clone();
        let name = name.clone();
        Some(async move {
            info!("  - Stopping serve: {}", s.id);
            let _ = stop_serve(app, s.id, name).await;
        })
    }))
    .await;

    // Stop all associated active jobs
    let jobs = backend_manager.job_cache.get_active_jobs().await;
    join_all(jobs.into_iter().filter(|j| j.remote_name == name).map(|j| {
        let app = app.clone();
        let name = name.clone();
        async move {
            info!("  - Stopping job: {}", j.jobid);
            let _ = stop_job(app, j.jobid, name).await;
        }
    }))
    .await;

    // Clean up all associated job results for this remote
    app.state::<BackendManager>()
        .job_cache
        .delete_jobs_by_remote(&name, Some(&app))
        .await;

    match delete_remote_settings(app.clone(), name.clone()).await {
        Ok(()) => {
            info!("✅ Settings for remote '{name}' deleted successfully");
        }
        Err(e) => {
            warn!("⚠️  Failed to delete settings for remote '{name}': {e}");
        }
    }

    backend
        .post_json(
            &state.client,
            config::DELETE,
            Some(&json!({ "name": name })),
        )
        .await
        .map_err(|e| {
            let msg = format!("Failed to delete remote: {e}");
            error!("❌ {msg}");
            msg
        })?;

    app.emit(REMOTE_CACHE_CHANGED, &name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    app.state::<LogCache>().clear_for_remote(&name).await;

    let _ = get_fscache_entries(app).await;

    info!("✅ Remote {name} deleted successfully");
    Ok(())
}
