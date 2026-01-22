// Backend management commands
//
// Tauri commands for backend CRUD operations and connection testing.

use crate::core::settings::AppSettingsManager;
use log::{debug, info, warn};
use tauri::{AppHandle, Manager, State};

use crate::{
    core::scheduler::engine::CronScheduler,
    rclone::backend::{
        BACKEND_MANAGER,
        types::{Backend, BackendInfo},
    },
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::{
        rclone::endpoints::{config, core},
        types::core::RcloneState,
    },
};

/// List all backends with their status
#[tauri::command]
pub async fn list_backends() -> Result<Vec<BackendInfo>, String> {
    Ok(BACKEND_MANAGER.list_all().await)
}

/// Get the name of the currently active backend
#[tauri::command]
pub async fn get_active_backend() -> Result<String, String> {
    Ok(BACKEND_MANAGER.get_active_name().await)
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
pub async fn switch_backend(
    app: AppHandle,
    name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    info!("🔄 Switching to backend: {}", name);

    // Get backend info before switching
    let backend = BACKEND_MANAGER
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    // For remote backends: test connection BEFORE switching
    if !backend.is_local {
        debug!("📡 Testing remote backend connection...");

        let result = backend
            .make_request(
                &state.client,
                reqwest::Method::POST,
                core::VERSION,
                None,
                Some(std::time::Duration::from_secs(5)),
            )
            .await;

        match result {
            Ok(_) => {
                info!("✅ Remote backend '{}' is reachable", name);
                BACKEND_MANAGER.set_runtime_status(&name, "connected").await;
            }

            Err(e) => {
                let err = format!("error:{}", e);
                BACKEND_MANAGER.set_runtime_status(&name, &err).await;
                return Err(format!("Cannot connect to '{}': {}", name, e));
            }
        }
    }

    // Switch (only if connection test passed for remote backends)
    let settings_manager = app.state::<AppSettingsManager>();
    BACKEND_MANAGER
        .switch_to(settings_manager.inner(), &name, None, None)
        .await?;

    // Set config path if configured (Remote only)
    if !backend.is_local
        && let Some(config_path) = &backend.config_path
    {
        info!(
            "📝 Setting config path for remote backend '{}' to: {}",
            name, config_path
        );
        // Parameters: path
        let params = serde_json::json!({
            "path": config_path
        });

        match backend
            .post_json(&state.client, config::SETPATH, Some(&params))
            .await
        {
            Ok(_) => {
                info!("✅ Config path set successfully");
            }
            Err(e) => {
                warn!("⚠️ Failed to set config path: {}", e);
            }
        }
    }

    // Auto-unlock if config_password is set (Remote only)
    if !backend.is_local
        && backend.config_password.is_some()
        && let Err(e) = crate::rclone::commands::system::try_auto_unlock_config(&app).await
    {
        warn!("⚠️ Auto-unlock failed: {}", e);
    }

    // Always Refresh cache (for both Local and Remote)
    // Local backend also needs remotes refreshed from rclone
    // Use unified refresh logic
    let refresh_future = BACKEND_MANAGER.refresh_active_backend(&state.client);

    match tokio::time::timeout(std::time::Duration::from_secs(15), refresh_future).await {
        Ok(Ok(_)) => {
            info!("✅ Cache refreshed for backend '{}'", name);
            // Notify frontend that cache is updated
            use crate::utils::types::events::{BACKEND_SWITCHED, REMOTE_CACHE_CHANGED};
            use tauri::Emitter;
            let _ = app.emit(REMOTE_CACHE_CHANGED, ());
            let _ = app.emit(BACKEND_SWITCHED, &name);
        }
        Ok(Err(e)) => {
            warn!("⚠️ Cache refresh failed for backend '{}': {}", name, e);
            // Revert to previous backend if this wasn't Local (Local is always safe)
            if name != "Local" {
                info!("↩️ Reverting to previous backend due to cache failure");
                // We're essentially failing the switch, but manager state was already updated
                // best effort to switch back to Local for safety
                if let Err(revert_err) = BACKEND_MANAGER
                    .switch_to(settings_manager.inner(), "Local", None, None)
                    .await
                {
                    warn!("Failed to revert to Local backend: {}", revert_err);
                }
                return Err(format!(
                    "Backend connected but failed to list items: {}. Reverted to Local.",
                    e
                ));
            }
        }
        Err(_) => {
            warn!("⏱️ Cache refresh timed out for backend '{}'", name);
            // Revert to previous backend
            if name != "Local" {
                info!("↩️ Reverting to previous backend due to timeout");
                if let Err(revert_err) = BACKEND_MANAGER
                    .switch_to(settings_manager.inner(), "Local", None, None)
                    .await
                {
                    warn!("Failed to revert to Local backend: {}", revert_err);
                }
                BACKEND_MANAGER
                    .set_runtime_status(&name, "error:Connection too slow")
                    .await;
                return Err(
                    "Backend connection accepted but too slow to list items. Reverted to Local."
                        .to_string(),
                );
            }
        }
    }

    // Persist active backend selection
    // let settings_manager = app.state::<AppSettingsManager>(); // Already retrieved above
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
    BACKEND_MANAGER
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

    // Get existing backend to preserve is_local
    let existing = BACKEND_MANAGER
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
    BACKEND_MANAGER
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
    BACKEND_MANAGER
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
    state: State<'_, RcloneState>,
) -> Result<TestConnectionResult, String> {
    debug!("🔍 Testing connection: {}", name);

    // Use 5s timeout for testing connections
    match BACKEND_MANAGER
        .check_connectivity_with_timeout(&name, &state.client, std::time::Duration::from_secs(5))
        .await
    {
        Ok((version, os)) => {
            // Persist to settings (optional but good)
            if let Some(backend) = BACKEND_MANAGER.get(&name).await {
                let settings_manager = app.state::<AppSettingsManager>();
                let _ = save_backend_to_settings(settings_manager.inner(), &backend);
            }

            // Get config_path from runtime cache (was set during check_connectivity)
            let config_path = BACKEND_MANAGER.get_runtime_config_path(&name).await;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_list_backends() {
        let backends = list_backends().await.unwrap();
        assert!(!backends.is_empty());

        let local = backends.iter().find(|b| b.name == "Local");
        assert!(local.is_some());
        assert!(local.unwrap().is_active);
    }

    #[tokio::test]
    async fn test_get_active_backend() {
        let active = get_active_backend().await.unwrap();
        assert_eq!(active, "Local");
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
