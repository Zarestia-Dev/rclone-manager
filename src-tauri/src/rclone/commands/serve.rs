use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

use crate::utils::types::origin::Origin;
use crate::{
    rclone::{backend::BackendManager, state::watcher::force_check_serves},
    utils::{
        app::notification::{Notification, send_notification_typed},
        json_helpers::{
            get_string, json_to_hashmap, resolve_profile_options, unwrap_nested_options,
        },
        logging::log::log_operation,
        rclone::endpoints::serve,
        types::{core::RcloneState, logs::LogLevel, remotes::ProfileParams},
    },
};

use super::common::redact_sensitive_values;

/// Parameters for starting a serve instance
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ServeParams {
    pub remote_name: String,
    pub serve_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

/// Internal struct for Rclone API serialization
#[derive(serde::Serialize)]
struct RcloneServeBody {
    #[serde(flatten)]
    pub serve_options: Option<HashMap<String, Value>>,
    #[serde(rename = "vfsOpt", skip_serializing_if = "Option::is_none")]
    pub vfs_options: Option<HashMap<String, Value>>,
    #[serde(rename = "_config", skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, Value>>,
    #[serde(rename = "_filter", skip_serializing_if = "Option::is_none")]
    pub filter: Option<HashMap<String, Value>>,
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

    pub fn to_rclone_body(&self) -> Value {
        // Pre-process serve options to handle "addr" array issue
        let processed_serve_opts = self.serve_options.clone().map(|mut opts| {
            if let Some(addr_val) = opts.get("addr") {
                let final_val = match addr_val {
                    Value::Array(arr) if arr.len() == 1 && arr[0].is_string() => arr[0].clone(),
                    _ => addr_val.clone(),
                };
                opts.insert("addr".to_string(), final_val);
            }
            opts
        });

        let body = RcloneServeBody {
            serve_options: processed_serve_opts,
            vfs_options: self.vfs_options.clone().map(unwrap_nested_options),
            config: self.backend_options.clone().map(unwrap_nested_options),
            filter: self.filter_options.clone().map(unwrap_nested_options),
        };

        serde_json::to_value(body).unwrap_or(json!({}))
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

    // Check for duplicates
    let serves = backend_manager.remote_cache.get_serves().await;
    if serves.iter().any(|s| {
        let fs_match = s.params.get("fs").and_then(|v| v.as_str()) == Some(&params.remote_name);
        let profile_match = s.profile == params.profile;
        fs_match && profile_match
    }) {
        let profile_msg = params
            .profile
            .clone()
            .map(|p| format!(" (Profile: '{}')", p))
            .unwrap_or_default();
        let msg = format!(
            "Serve is already running for '{}'{}",
            params.remote_name, profile_msg
        );
        warn!("🚫 {}", msg);
        return Err(msg);
    }

    let serve_type = params
        .serve_options
        .as_ref()
        .and_then(|opts| opts.get("type"))
        .ok_or_else(|| crate::localized_error!("backendErrors.serve.typeRequired"))?;

    debug!("🚀 Starting {serve_type} serve for {}", params.remote_name);

    let log_context = json!({
        "remote_name": params.remote_name,
        "serve_options": redact_sensitive_values(&params.serve_options.clone().unwrap_or_default(), &app),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Start serve".to_string()),
        format!("Attempting to start {} serve", serve_type),
        Some(log_context),
    );

    let payload = params.to_rclone_body();
    debug!("📦 Serve request payload: {payload:#?}");

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
            send_notification_typed(
                &app,
                Notification::localized(
                    "notification.title.serveFailed",
                    "notification.body.serveFailed",
                    Some(vec![
                        ("remote", &params.remote_name),
                        ("profile", params.profile.as_deref().unwrap_or("")),
                        ("error", &e.to_string()),
                    ]),
                    None,
                    Some(LogLevel::Error),
                ),
                Some(Origin::Internal),
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

    // Store state and refresh
    let cache = &backend_manager.remote_cache;
    cache
        .store_serve_profile(&serve_id, params.profile.clone())
        .await;
    refresh_serves_safely(&app).await;

    info!(
        "✅ Serve {} started: ID={}, Address={}",
        params.remote_name, serve_response.id, serve_response.addr
    );

    send_notification_typed(
        &app,
        Notification::localized(
            "notification.title.serveStarted",
            "notification.body.serveStarted",
            Some(vec![
                ("remote", &params.remote_name),
                ("profile", params.profile.as_deref().unwrap_or("")),
                ("addr", &serve_response.addr),
            ]),
            None,
            Some(LogLevel::Info),
        ),
        Some(Origin::Internal),
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

    // Get profile from cache before stopping
    let profile = backend_manager
        .remote_cache
        .get_serve_profile(&server_id)
        .await
        .unwrap_or_default();

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
            send_notification_typed(
                &app,
                Notification::localized(
                    "notification.title.stopServeFailed",
                    "notification.body.stopServeFailed",
                    Some(vec![("remote", &remote_name), ("error", &e.to_string())]),
                    None,
                    Some(LogLevel::Error),
                ),
                Some(Origin::Internal),
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

    refresh_serves_safely(&app).await;

    info!("✅ Serve {server_id} stopped successfully");

    send_notification_typed(
        &app,
        Notification::localized(
            "notification.title.serveStopped",
            "notification.body.serveStopped",
            Some(vec![("remote", &remote_name), ("profile", &profile)]),
            None,
            Some(LogLevel::Info),
        ),
        Some(Origin::Internal),
    );

    Ok(crate::localized_success!("backendErrors.serve.stopSuccess", "serverId" => &server_id))
}

/// Stop all running serve instances
#[tauri::command]
pub async fn stop_all_serves(app: AppHandle, context: String) -> Result<String, String> {
    info!("🗑️ Stopping all serves");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // If there are no active serves, use helper for the no-op policy
    let serves = backend_manager.remote_cache.get_serves().await;
    if !should_emit_stop_all_serves_notification(serves.len(), &context) {
        debug!("No active serves to stop — skipping STOPALL");
        if context != "shutdown" {
            refresh_serves_safely(&app).await;
            // Inform the user there's nothing to stop
            send_notification_typed(
                &app,
                Notification::localized(
                    "notification.title.nothingToDo",
                    "notification.body.nothingToDoServes",
                    None,
                    None,
                    Some(LogLevel::Info),
                ),
                Some(Origin::Internal),
            );
        }
        // Silent no-op during shutdown
        return Ok(crate::localized_success!("backendSuccess.serve.stopped"));
    }

    let _ = backend
        .post_json(&app.state::<RcloneState>().client, serve::STOPALL, None)
        .await
        .map_err(|e| {
            let error = format!("Failed to stop all serves: {e}");
             let localized = crate::localized_error!("backendErrors.serve.failed", "operation" => "stop all", "error" => &error);
             send_notification_typed(
                &app,
                Notification::localized(
                    "notification.title.stopAllServesFailed",
                    "notification.body.stopAllServesFailed",
                    Some(vec![("error", &e.to_string())]),
                    None,
                    Some(LogLevel::Error),
                ),
                Some(Origin::Internal),
            );
            localized
        })?;

    if context != "shutdown" {
        refresh_serves_safely(&app).await;
    }

    info!("✅ All serves stopped successfully");

    send_notification_typed(
        &app,
        Notification::localized(
            "notification.title.allServesStopped",
            "notification.body.allServesStopped",
            None,
            None,
            Some(LogLevel::Info),
        ),
        Some(Origin::Internal),
    );

    Ok(crate::localized_success!("backendSuccess.serve.stopped"))
}

async fn refresh_serves_safely(app: &AppHandle) {
    if let Err(e) = force_check_serves(app.clone()).await {
        warn!("Failed to refresh serves: {e}");
    }
}

// Small helper to encapsulate the no-op policy for stopping all serves.
fn should_emit_stop_all_serves_notification(serves_count: usize, context: &str) -> bool {
    serves_count > 0 && context != "shutdown"
}

#[cfg(test)]
mod tests {
    use super::should_emit_stop_all_serves_notification;

    #[test]
    fn test_should_emit_stop_all_serves_notification() {
        // No serves -> silent
        assert!(!should_emit_stop_all_serves_notification(0, "menu"));
        // Active serves -> notify
        assert!(should_emit_stop_all_serves_notification(2, "menu"));
        // Shutdown -> never notify
        assert!(!should_emit_stop_all_serves_notification(2, "shutdown"));
    }
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
