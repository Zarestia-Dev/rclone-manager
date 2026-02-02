// Backend management commands
//
// Tauri commands for backend CRUD operations and connection testing.

use crate::core::settings::AppSettingsManager;
use log::{debug, info, warn};
use tauri::{AppHandle, Manager, State};

use crate::{
    core::scheduler::engine::CronScheduler,
    rclone::backend::BackendManager,
    rclone::backend::types::{Backend, BackendInfo},
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::{
        rclone::endpoints::{config, core},
        types::core::RcloneState,
    },
};

/// List all backends with their status
#[tauri::command]
pub async fn list_backends(app: AppHandle) -> Result<Vec<BackendInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.list_all().await)
}

/// Get the name of the currently active backend
#[tauri::command]
pub async fn get_active_backend(app: AppHandle) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.get_active_name().await)
}

/// Get list of available backend profiles
#[tauri::command]
pub async fn get_backend_profiles(
    manager: State<'_, AppSettingsManager>,
) -> Result<Vec<String>, String> {
    let remotes = manager
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to access remotes sub-settings: {}", e))?;

    let profiles = remotes
        .profiles()
        .map_err(|_| "Profiles not enabled for remotes".to_string())?
        .list()
        .map_err(|e| format!("Failed to list profiles: {}", e))?;

    Ok(profiles)
}

/// Switch to a different backend
#[tauri::command]
pub async fn switch_backend(app: AppHandle, name: String) -> Result<(), String> {
    info!("🔄 Switching to backend: {}", name);

    let backend_manager = app.state::<BackendManager>();
    let state = app.state::<RcloneState>();
    let settings_manager = app.state::<AppSettingsManager>();

    // Get backend info before switching
    let backend = backend_manager
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    // 1. Test connection (Remote only)
    test_remote_connection(&backend, &backend_manager, &state.client).await?;

    // 2. Perform Switch
    backend_manager
        .switch_to(settings_manager.inner(), &name, None, None)
        .await?;

    // 3. Configure (Set path, Auth)
    configure_remote_backend(&app, &backend, &state.client).await;

    // 4. Refresh Cache & Verify Stability
    refresh_and_verify_cache(
        &app,
        &backend_manager,
        &settings_manager,
        &state.client,
        &name,
    )
    .await?;

    // 5. Persist active backend selection
    if let Err(e) = crate::rclone::backend::BackendManager::save_active_to_settings(
        settings_manager.inner(),
        &name,
    ) {
        warn!("Failed to persist active backend: {}", e);
    }

    info!("✅ Switched to backend: {}", name);
    Ok(())
}

/// Add a new backend
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn add_backend(
    app: AppHandle,
    name: String,
    host: String,
    port: u16,
    is_local: bool,
    username: Option<String>,
    password: Option<String>,
    config_password: Option<String>,
    config_path: Option<String>,
    oauth_port: Option<u16>,
    copy_backend_from: Option<String>,
    copy_remotes_from: Option<String>,
) -> Result<(), String> {
    info!("➕ Adding backend: {} ({}:{})", name, host, port);

    // Validate
    if name.is_empty() {
        return Err(crate::localized_error!("backendErrors.backend.nameEmpty"));
    }
    if name == "Local" {
        return Err(crate::localized_error!(
            "backendErrors.backend.cannotAddLocal"
        ));
    }

    // Create backend
    let mut backend = if is_local {
        Backend::new_local(&name)
    } else {
        Backend::new_remote(&name, &host, port)
    };

    // Set connection details
    backend.host = host;
    backend.port = port;
    backend.oauth_port = oauth_port;
    backend.config_path = config_path;

    // Set auth if both provided and non-empty
    if let (Some(u), Some(p)) = (&username, &password)
        && !u.is_empty()
        && !p.is_empty()
    {
        backend.username = Some(u.clone());
        backend.password = Some(p.clone());
    }

    // Set config password if provided
    if let Some(cp) = &config_password
        && !cp.is_empty()
    {
        backend.config_password = Some(cp.clone());
    }

    // Add to manager with optional copy
    let settings_manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .add(
            settings_manager.inner(),
            backend.clone(),
            copy_backend_from.as_deref(),
            copy_remotes_from.as_deref(),
        )
        .await?;

    // Persist to settings
    save_backend_to_settings(settings_manager.inner(), &backend)?;

    info!("✅ Backend '{}' added", name);
    Ok(())
}

/// Update an existing backend
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_backend(
    app: AppHandle,
    name: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    config_password: Option<String>,
    config_path: Option<String>,
    oauth_port: Option<u16>,
) -> Result<(), String> {
    info!("🔄 Updating backend: {}", name);

    let backend_manager = app.state::<BackendManager>();
    // Get existing backend to preserve is_local
    let existing = backend_manager
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    let mut backend = Backend {
        name: name.clone(),
        is_local: existing.is_local,
        host,
        port,
        username: None,
        password: None,
        oauth_port,
        config_password: None,
        config_path, // Updated from argument
        version: existing.version.clone(),
        os: existing.os.clone(),
    };

    let settings_manager = app.state::<AppSettingsManager>();

    // Handle auth
    match (username.as_deref(), password.as_deref()) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
            backend.username = Some(u.to_string());
            backend.password = Some(p.to_string());
        }
        (Some(_), _) | (_, Some(_)) => {
            // Clear auth from keychain (desktop only)
            #[cfg(desktop)]
            if let Some(creds) = settings_manager.credentials() {
                let _ = creds.remove(&format!("backend:{}:password", name));
            }
        }
        _ => {}
    }

    // Handle config password
    match config_password.as_deref() {
        Some(cp) if !cp.is_empty() => {
            backend.config_password = Some(cp.to_string());
        }
        Some(_) => {
            // Clear from keychain (desktop only)
            #[cfg(desktop)]
            if let Some(creds) = settings_manager.credentials() {
                let _ = creds.remove(&format!("backend:{}:config_password", name));
            }
        }
        None => {}
    }

    // Update manager
    backend_manager
        .update(settings_manager.inner(), &name, backend.clone())
        .await?;

    // Persist
    save_backend_to_settings(settings_manager.inner(), &backend)?;

    // Restart engine if Local backend AND configuration changed
    if name == "Local" {
        // Check if critical settings changed that require a restart
        let restart_required = existing.host != backend.host
            || existing.port != backend.port
            || existing.username != backend.username
            || existing.password != backend.password
            || existing.config_path != backend.config_path
            || existing.config_password != backend.config_password;

        if restart_required {
            info!("🔄 Restarting engine for Local backend update");
            if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
                &app,
                "backend_settings",
                "updated",
                "updated",
            ) {
                warn!("Failed to restart engine: {}", e);
            }
        } else {
            info!("✨ Skipping engine restart (only non-critical settings changed)");
        }
    }

    info!("✅ Backend '{}' updated", name);
    Ok(())
}

/// Remove a backend
#[tauri::command]
pub async fn remove_backend(
    app: AppHandle,
    name: String,
    scheduler: State<'_, CronScheduler>,
    task_cache: State<'_, ScheduledTasksCache>,
) -> Result<(), String> {
    info!("➖ Removing backend: {}", name);

    let settings_manager = app.state::<AppSettingsManager>();

    // Remove from manager
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .remove(settings_manager.inner(), &name)
        .await?;

    // Remove from settings
    delete_backend_from_settings(settings_manager.inner(), &name)?;

    // Cleanup tasks
    let tasks = task_cache.get_tasks_for_backend(&name).await;
    if !tasks.is_empty() {
        info!(
            "🗑️ Cleaning up {} tasks for backend '{}'",
            tasks.len(),
            name
        );
        for task in tasks {
            if let Some(job_id_str) = &task.scheduler_job_id
                && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
            {
                let _ = scheduler.unschedule_task(job_id).await;
            }
        }
        task_cache.clear_backend_tasks(&name).await;
    }

    info!("✅ Backend '{}' removed", name);
    Ok(())
}

/// Test connection to a backend
#[tauri::command]
pub async fn test_backend_connection(
    app: AppHandle,
    name: String,
) -> Result<TestConnectionResult, String> {
    debug!("🔍 Testing connection: {}", name);

    // Use 5s timeout for testing connections
    let backend_manager = app.state::<BackendManager>();
    match backend_manager
        .check_connectivity_with_timeout(
            &name,
            &app.state::<RcloneState>().client,
            std::time::Duration::from_secs(5),
        )
        .await
    {
        Ok((version, os)) => {
            // Persist to settings (optional but good)
            if let Some(backend) = backend_manager.get(&name).await {
                let settings_manager = app.state::<AppSettingsManager>();
                let _ = save_backend_to_settings(settings_manager.inner(), &backend);
            }

            // Get config_path from runtime cache (was set during check_connectivity)
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
            message: format!("Connection failed: {}", e),
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
// Persistence Helpers
// =============================================================================

fn save_backend_to_settings(manager: &AppSettingsManager, backend: &Backend) -> Result<(), String> {
    // Store secrets in keychain (desktop only)
    #[cfg(desktop)]
    if let Some(creds) = manager.credentials() {
        // Password
        if let Some(ref password) = backend.password
            && !password.is_empty()
        {
            creds
                .store(&format!("backend:{}:password", backend.name), password)
                .map_err(|e| e.to_string())?;
        }
        // Config password
        if let Some(ref config_password) = backend.config_password
            && !config_password.is_empty()
        {
            creds
                .store(
                    &format!("backend:{}:config_password", backend.name),
                    config_password,
                )
                .map_err(|e| e.to_string())?;
        }
    }

    // Save backend to JSON (secrets are skipped via serde)
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
    // Remove secrets (desktop only)
    #[cfg(desktop)]
    if let Some(creds) = manager.credentials() {
        let _ = creds.remove(&format!("backend:{}:password", name));
        let _ = creds.remove(&format!("backend:{}:config_password", name));
    }

    // Remove from JSON
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
            let err = format!("error:{}", e);
            backend_manager
                .set_runtime_status(&backend.name, &err)
                .await;
            Err(format!("Cannot connect to '{}': {}", backend.name, e))
        }
    }
}

async fn configure_remote_backend(app: &AppHandle, backend: &Backend, client: &reqwest::Client) {
    if backend.is_local {
        return;
    }

    // Set config path
    if let Some(config_path) = &backend.config_path {
        info!(
            "📝 Setting config path for remote backend '{}' to: {}",
            backend.name, config_path
        );
        let params = serde_json::json!({ "path": config_path });
        if let Err(e) = backend
            .post_json(client, config::SETPATH, Some(&params))
            .await
        {
            warn!("⚠️ Failed to set config path: {}", e);
        } else {
            info!("✅ Config path set successfully");
        }
    }

    // Auto-unlock
    if backend.config_password.is_some()
        && let Err(e) = crate::rclone::commands::system::try_auto_unlock_config(app).await
    {
        warn!("⚠️ Auto-unlock failed: {}", e);
    }
}

async fn refresh_and_verify_cache(
    app: &AppHandle,
    backend_manager: &BackendManager,
    settings_manager: &AppSettingsManager,
    client: &reqwest::Client,
    name: &str,
) -> Result<(), String> {
    let refresh_future = backend_manager.refresh_active_backend(client);

    match tokio::time::timeout(std::time::Duration::from_secs(15), refresh_future).await {
        Ok(Ok(_)) => {
            info!("✅ Cache refreshed for backend '{}'", name);
            // Notify frontend
            use crate::utils::types::events::{BACKEND_SWITCHED, REMOTE_CACHE_CHANGED};
            use tauri::Emitter;
            let _ = app.emit(REMOTE_CACHE_CHANGED, ());
            let _ = app.emit(BACKEND_SWITCHED, name);
            Ok(())
        }
        Ok(Err(e)) => {
            warn!("⚠️ Cache refresh failed for backend '{}': {}", name, e);
            revert_to_local(backend_manager, settings_manager, name).await;
            Err(format!(
                "Backend connected but failed to list items: {}. Reverted to Local.",
                e
            ))
        }
        Err(_) => {
            warn!("⏱️ Cache refresh timed out for backend '{}'", name);
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
        if let Err(revert_err) = backend_manager
            .switch_to(settings_manager, "Local", None, None)
            .await
        {
            warn!("Failed to revert to Local backend: {}", revert_err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Ignored: requires AppHandle injection
    async fn test_list_backends() {
        // let backends = list_backends().await.unwrap();
        // assert!(!backends.is_empty());
        //
        // let local = backends.iter().find(|b| b.name == "Local");
        // assert!(local.is_some());
        // assert!(local.unwrap().is_active);
    }

    #[tokio::test]
    #[ignore] // Ignored: requires AppHandle injection
    async fn test_get_active_backend() {
        // let active = get_active_backend().await.unwrap();
        // assert_eq!(active, "Local");
    }

    #[test]
    fn test_connection_result() {
        let result = TestConnectionResult {
            success: true,
            message: "OK".to_string(),
            version: Some("1.65.0".to_string()),
            os: Some("linux".to_string()),
            config_path: None,
        };
        assert!(result.success);
    }
}
