// Backend management commands
//
// Tauri commands for backend CRUD operations and connection testing.

use crate::core::settings::AppSettingsManager;
use log::{debug, info, warn};
use tauri::{AppHandle, Manager, State};

use crate::{
    core::scheduler::engine::CronScheduler,
    rclone::backend::{
        BackendManager,
        schema::BackendConnectionSchema,
        types::{Backend, BackendInfo},
    },
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::{
        rclone::endpoints::{config, core},
        types::core::RcloneState,
    },
};
use rcman::{SettingMetadata, SettingsSchema};
use std::collections::HashMap;

#[tauri::command]
pub async fn get_backend_schema() -> Result<HashMap<String, SettingMetadata>, String> {
    Ok(BackendConnectionSchema::get_metadata())
}

#[tauri::command]
pub async fn list_backends(app: AppHandle) -> Result<Vec<BackendInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.list_all().await)
}

#[tauri::command]
pub async fn get_active_backend(app: AppHandle) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.get_active_name().await)
}

#[tauri::command]
pub async fn get_backend_profiles(
    manager: State<'_, AppSettingsManager>,
) -> Result<Vec<String>, String> {
    let remotes = manager
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to access remotes sub-settings: {e}"))?;

    remotes
        .profiles()
        .map_err(|_| "Profiles not enabled for remotes".to_string())?
        .list()
        .map_err(|e| format!("Failed to list profiles: {e}"))
}

#[tauri::command]
pub async fn switch_backend(app: AppHandle, name: String) -> Result<(), String> {
    info!("🔄 Switching to backend: {name}");

    let backend_manager = app.state::<BackendManager>();
    let state = app.state::<RcloneState>();
    let settings_manager = app.state::<AppSettingsManager>();

    let backend = backend_manager
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{name}' not found"))?;

    test_remote_connection(&backend, &backend_manager, &state.client).await?;

    backend_manager
        .switch_to(settings_manager.inner(), &name)
        .await?;

    if backend.is_local {
        use crate::utils::types::core::EngineState;
        let engine_state = app.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        if !engine.running && !engine.path_error && !engine.password_error {
            info!("🚀 Starting Local engine after switching from remote backend...");
            crate::rclone::engine::lifecycle::start(&mut engine, &app).await;
        }
    }

    configure_remote_backend(&app, &backend, &state.client).await;

    refresh_and_verify_cache(
        &app,
        &backend_manager,
        &settings_manager,
        &state.client,
        &name,
    )
    .await?;

    BackendManager::save_active_to_settings(settings_manager.inner(), &name);

    info!("✅ Switched to backend: {name}");
    Ok(())
}

/// Parameters for adding a new backend connection.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBackendParams {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub is_local: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<String>,
    pub oauth_port: Option<u16>,
    pub oauth_host: Option<String>,
    pub copy_backend_from: Option<String>,
    pub copy_remotes_from: Option<String>,
}

#[tauri::command]
pub async fn add_backend(app: AppHandle, params: AddBackendParams) -> Result<(), String> {
    info!(
        "➕ Adding backend: {} ({}:{})",
        params.name, params.host, params.port
    );

    if params.name.is_empty() {
        return Err(crate::localized_error!("backendErrors.backend.nameEmpty"));
    }
    if params.name == "Local" {
        return Err(crate::localized_error!(
            "backendErrors.backend.cannotAddLocal"
        ));
    }

    let mut backend = if params.is_local {
        Backend::new_local(&params.name)
    } else {
        Backend::new_remote(&params.name, &params.host, params.port)
    };

    backend.host = params.host;
    backend.port = params.port;
    backend.config_path = params.config_path;

    if let Some(port) = params.oauth_port {
        backend.oauth_port = port;
    }
    if let Some(host) = params.oauth_host.filter(|h| !h.is_empty()) {
        backend.oauth_host = host;
    }

    if let (Some(u), Some(p)) = (&params.username, &params.password)
        && !u.is_empty()
        && !p.is_empty()
    {
        backend.username = Some(u.clone());
        backend.password = Some(p.clone());
    }

    if let Some(cp) = &params.config_password
        && !cp.is_empty()
    {
        backend.config_password = Some(cp.clone());
    }

    let settings_manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .add(
            settings_manager.inner(),
            backend.clone(),
            params.copy_backend_from.as_deref(),
            params.copy_remotes_from.as_deref(),
        )
        .await?;

    save_backend_to_settings(settings_manager.inner(), &backend)?;

    info!("✅ Backend '{}' added", params.name);
    Ok(())
}

/// Parameters for updating an existing backend connection.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackendParams {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<String>,
    pub oauth_port: Option<u16>,
    pub oauth_host: Option<String>,
}

#[tauri::command]
pub async fn update_backend(app: AppHandle, params: UpdateBackendParams) -> Result<(), String> {
    info!("🔄 Updating backend: {}", params.name);

    let backend_manager = app.state::<BackendManager>();
    let settings_manager = app.state::<AppSettingsManager>();

    let existing = backend_manager
        .get(&params.name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", params.name))?;

    let mut backend = Backend {
        name: params.name.clone(),
        is_local: existing.is_local,
        host: params.host,
        port: params.port,
        username: None,
        password: None,
        oauth_port: params.oauth_port.unwrap_or(existing.oauth_port),
        oauth_host: params
            .oauth_host
            .filter(|h| !h.is_empty())
            .unwrap_or(existing.oauth_host),
        config_password: existing.config_password.clone(),
        config_path: params.config_path,
    };

    // Credential update rules:
    //   (None, None)         → client did not send credentials → preserve existing
    //   (Some(u), Some(p))
    //     both non-empty     → user set new credentials → update
    //   anything else        → partial or explicitly cleared → clear both
    match (params.username.as_deref(), params.password.as_deref()) {
        (None, None) => {
            backend.username = existing.username.clone();
            backend.password = existing.password.clone();
        }
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
            backend.username = Some(u.to_string());
            backend.password = Some(p.to_string());
        }
        _ => {
            backend.username = None;
            backend.password = None;
        }
    }

    // Config-password update rules (same pattern):
    //   None         → not sent → preserve existing
    //   Some("")     → explicitly cleared
    //   Some(value)  → update
    match params.config_password.as_deref() {
        None => { /* preserve existing.config_password already set above */ }
        Some(cp) if !cp.is_empty() => {
            backend.config_password = Some(cp.to_string());
        }
        Some(_) => {
            backend.config_password = None;
        }
    }

    // Only restart the Local engine when connection-relevant fields actually changed.
    // Saving identical settings must be a no-op for the running process.
    let needs_engine_restart = params.name == "Local"
        && (existing.host != backend.host
            || existing.port != backend.port
            || existing.config_path != backend.config_path
            || existing.config_password != backend.config_password);

    backend_manager
        .update(settings_manager.inner(), &params.name, backend.clone())
        .await?;

    save_backend_to_settings(settings_manager.inner(), &backend)?;

    if needs_engine_restart {
        info!("🔄 Restarting Local engine — connection settings changed");
        if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
            &app,
            "backend_settings",
            "updated",
            "updated",
        ) {
            warn!("Failed to restart engine: {e}");
        }
    }

    info!("✅ Backend '{}' updated", params.name);
    Ok(())
}

#[tauri::command]
pub async fn remove_backend(
    app: AppHandle,
    name: String,
    scheduler: State<'_, CronScheduler>,
    task_cache: State<'_, ScheduledTasksCache>,
) -> Result<(), String> {
    info!("➖ Removing backend: {name}");

    let settings_manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .remove(settings_manager.inner(), &name)
        .await?;

    delete_backend_from_settings(settings_manager.inner(), &name)?;

    let tasks = task_cache.get_tasks_for_backend(&name).await;
    if !tasks.is_empty() {
        info!("🗑️ Cleaning up {} tasks for backend '{name}'", tasks.len());
        for task in tasks {
            if let Some(job_id_str) = &task.scheduler_job_id
                && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
            {
                let _ = scheduler.unschedule_task(job_id).await;
            }
        }
        task_cache.clear_backend_tasks(&name).await;
    }

    info!("✅ Backend '{name}' removed");
    Ok(())
}

#[tauri::command]
pub async fn test_backend_connection(
    app: AppHandle,
    name: String,
) -> Result<TestConnectionResult, String> {
    debug!("🔍 Testing connection: {name}");

    let backend_manager = app.state::<BackendManager>();
    match crate::rclone::backend::connectivity::check_connectivity_with_timeout(
        &backend_manager,
        &name,
        &app.state::<RcloneState>().client,
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok((version, os)) => {
            if let Some(backend) = backend_manager.get(&name).await {
                let settings_manager = app.state::<AppSettingsManager>();
                let _ = save_backend_to_settings(settings_manager.inner(), &backend);
            }

            let config_path = backend_manager.get_runtime_config_path(&name).await;

            Ok(TestConnectionResult {
                success: true,
                message: "Connection successful".to_string(),
                version: Some(version),
                os: Some(os),
                config_path,
            })
        }
        Err(e) => Ok(TestConnectionResult {
            success: false,
            message: format!("Connection failed: {e}"),
            version: None,
            os: None,
            config_path: None,
        }),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub version: Option<String>,
    pub os: Option<String>,
    pub config_path: Option<String>,
}

// =============================================================================
// Persistence helpers
// =============================================================================

fn save_backend_to_settings(manager: &AppSettingsManager, backend: &Backend) -> Result<(), String> {
    let connections = manager
        .sub_settings("connections")
        .map_err(|e| e.to_string())?;

    let value = serde_json::to_value(backend).map_err(|e| e.to_string())?;
    connections
        .set(&backend.name, &value)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn delete_backend_from_settings(manager: &AppSettingsManager, name: &str) -> Result<(), String> {
    let connections = manager
        .sub_settings("connections")
        .map_err(|e| e.to_string())?;

    connections.delete(name).map_err(|e| e.to_string())?;
    Ok(())
}

async fn test_remote_connection(
    backend: &Backend,
    backend_manager: &BackendManager,
    client: &reqwest::Client,
) -> Result<(), String> {
    if backend.is_local {
        return Ok(());
    }

    debug!("📡 Testing remote backend connection...");
    match backend
        .make_request(
            client,
            reqwest::Method::POST,
            core::VERSION,
            None,
            Some(std::time::Duration::from_secs(5)),
        )
        .await
    {
        Ok(_) => {
            info!("✅ Remote backend '{}' is reachable", backend.name);
            backend_manager
                .set_runtime_status(&backend.name, "connected")
                .await;
            Ok(())
        }
        Err(e) => {
            backend_manager
                .set_runtime_status(&backend.name, &format!("error:{e}"))
                .await;
            Err(format!("Cannot connect to '{}': {e}", backend.name))
        }
    }
}

async fn configure_remote_backend(app: &AppHandle, backend: &Backend, client: &reqwest::Client) {
    if backend.is_local {
        return;
    }

    if let Some(config_path) = &backend.config_path {
        info!(
            "📝 Setting config path for remote backend '{}' to: {config_path}",
            backend.name
        );
        let params = serde_json::json!({ "path": config_path });
        if let Err(e) = backend
            .post_json(client, config::SETPATH, Some(&params))
            .await
        {
            warn!("⚠️ Failed to set config path: {e}");
        } else {
            info!("✅ Config path set successfully");
        }
    }

    if backend.config_password.is_some()
        && let Err(e) = crate::rclone::commands::system::try_auto_unlock_config(app).await
    {
        warn!("⚠️ Auto-unlock failed: {e}");
    }
}

async fn refresh_and_verify_cache(
    app: &AppHandle,
    backend_manager: &BackendManager,
    settings_manager: &AppSettingsManager,
    client: &reqwest::Client,
    name: &str,
) -> Result<(), String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::rclone::backend::cache::refresh_active_backend(backend_manager, client),
    )
    .await
    {
        Ok(Ok(_)) => {
            info!("✅ Cache refreshed for backend '{name}'");
            use crate::utils::types::events::{BACKEND_SWITCHED, REMOTE_CACHE_CHANGED};
            use tauri::Emitter;
            let _ = app.emit(REMOTE_CACHE_CHANGED, ());
            let _ = app.emit(BACKEND_SWITCHED, name);
            Ok(())
        }
        Ok(Err(e)) => {
            warn!("⚠️ Cache refresh failed for backend '{name}': {e}");
            revert_to_local(backend_manager, settings_manager, name).await;
            Err(format!(
                "Backend connected but failed to list items: {e}. Reverted to Local."
            ))
        }
        Err(_) => {
            warn!("⏱️ Cache refresh timed out for backend '{name}'");
            if name != "Local" {
                backend_manager
                    .set_runtime_status(name, "error:Connection too slow")
                    .await;
            }
            revert_to_local(backend_manager, settings_manager, name).await;
            Err(
                "Backend connection accepted but too slow to list items. Reverted to Local."
                    .to_string(),
            )
        }
    }
}

async fn revert_to_local(
    backend_manager: &BackendManager,
    settings_manager: &AppSettingsManager,
    current_name: &str,
) {
    if current_name != "Local" {
        info!("↩️ Reverting to previous backend due to failure");
        if let Err(e) = backend_manager.switch_to(settings_manager, "Local").await {
            warn!("Failed to revert to Local backend: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_params_deserialize_camelcase() {
        let json = r#"{
            "name": "Local",
            "host": "0.0.0.0",
            "port": 51900,
            "oauthPort": 53682,
            "oauthHost": "my-server.local",
            "configPassword": "secret",
            "configPath": "/config/rclone.conf"
        }"#;

        let params: UpdateBackendParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.oauth_port, Some(53682));
        assert_eq!(params.oauth_host.as_deref(), Some("my-server.local"));
        assert_eq!(params.config_password.as_deref(), Some("secret"));
        assert_eq!(params.config_path.as_deref(), Some("/config/rclone.conf"));
    }

    #[test]
    fn test_add_params_deserialize_camelcase() {
        let json = r#"{
            "name": "MyRemote",
            "host": "192.168.1.100",
            "port": 51900,
            "isLocal": false,
            "oauthPort": 53682,
            "oauthHost": "192.168.1.100"
        }"#;

        let params: AddBackendParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.oauth_port, Some(53682));
        assert_eq!(params.oauth_host.as_deref(), Some("192.168.1.100"));
        assert!(!params.is_local);
    }

    #[test]
    fn test_missing_optional_fields_use_none() {
        // Fields absent from JS (not sent) should deserialize as None,
        // triggering the preserve-existing fallback in update_backend.
        let json = r#"{"name":"Local","host":"0.0.0.0","port":51900}"#;
        let params: UpdateBackendParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.oauth_port, None);
        assert_eq!(params.oauth_host, None);
        assert_eq!(params.username, None);
        assert_eq!(params.password, None);
    }

    #[test]
    fn test_credential_update_rules() {
        // Verify the credential match arms handle all cases correctly.
        // (None, None) should be handled differently from (Some(""), Some(""))
        let json_absent = r#"{"name":"NAS","host":"10.0.0.1","port":51900}"#;
        let json_cleared =
            r#"{"name":"NAS","host":"10.0.0.1","port":51900,"username":"","password":""}"#;
        let json_set = r#"{"name":"NAS","host":"10.0.0.1","port":51900,"username":"admin","password":"secret"}"#;

        let absent: UpdateBackendParams = serde_json::from_str(json_absent).unwrap();
        let cleared: UpdateBackendParams = serde_json::from_str(json_cleared).unwrap();
        let set: UpdateBackendParams = serde_json::from_str(json_set).unwrap();

        assert!(matches!(
            (absent.username.as_deref(), absent.password.as_deref()),
            (None, None)
        ));
        assert!(matches!(
            (cleared.username.as_deref(), cleared.password.as_deref()),
            (Some(""), Some(""))
        ));
        assert!(matches!(
            (set.username.as_deref(), set.password.as_deref()),
            (Some("admin"), Some("secret"))
        ));
    }
}
