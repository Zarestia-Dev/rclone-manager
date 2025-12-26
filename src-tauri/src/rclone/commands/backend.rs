// Backend management commands
//
// These Tauri commands provide frontend access to backend CRUD operations
// and connection testing.

use log::{debug, info, warn};
use tauri::{AppHandle, Manager, State};

use crate::{
    rclone::backend::{
        BACKEND_MANAGER,
        types::{BackendInfo, BackendType, RcloneBackend},
    },
    utils::{
        rclone::endpoints::{EndpointHelper, core},
        types::all_types::RcloneState,
    },
};

/// List all backends with their status
#[tauri::command]
pub async fn list_backends() -> Result<Vec<BackendInfo>, String> {
    let names = BACKEND_MANAGER.list_names().await;
    let active_name = BACKEND_MANAGER.get_active_name().await;

    let mut backends = Vec::new();
    for name in names {
        if let Some(backend) = BACKEND_MANAGER.get(&name).await {
            let backend = backend.read().await;
            backends.push(BackendInfo::from_backend(&backend, name == active_name));
        }
    }

    Ok(backends)
}

/// Get the name of the currently active backend
#[tauri::command]
pub async fn get_active_backend() -> Result<String, String> {
    Ok(BACKEND_MANAGER.get_active_name().await)
}

/// Switch to a different backend
/// For remote backends, tests connection and refreshes cache
#[tauri::command]
pub async fn switch_backend(name: String, state: State<'_, RcloneState>) -> Result<(), String> {
    info!("🔄 Switching to backend: {}", name);

    // Get the backend to check its type
    let backend = BACKEND_MANAGER
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    let backend_type = {
        let guard = backend.read().await;
        guard.backend_type.clone()
    };

    // Switch the active backend
    BACKEND_MANAGER.switch_to(&name).await?;

    // For remote backends, test connection and refresh cache
    if backend_type == BackendType::Remote {
        debug!("📡 Switching to remote backend, testing connection...");

        let guard = backend.read().await;
        let backend_copy = guard.clone();
        let cache = guard.remote_cache.clone();
        drop(guard);

        // Test connection
        let url = EndpointHelper::build_url(&backend_copy.api_url(), core::VERSION);
        match backend_copy
            .inject_auth(state.client.post(&url))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                info!("✅ Remote backend '{}' is reachable", name);
                let _ = BACKEND_MANAGER
                    .set_status(
                        &name,
                        crate::rclone::backend::types::BackendStatus::Connected,
                    )
                    .await;

                // Refresh cache
                if let Err(e) = cache.refresh_all(&state.client, &backend_copy).await {
                    warn!("Failed to refresh cache for remote backend: {}", e);
                }
            }
            Ok(response) => {
                let status = response.status();
                warn!("⚠️ Remote backend '{}' returned HTTP {}", name, status);
            }
            Err(e) => {
                warn!("⚠️ Remote backend '{}' is not reachable: {}", name, e);
                // Still switch, but mark as disconnected
                let _ = BACKEND_MANAGER
                    .set_status(
                        &name,
                        crate::rclone::backend::types::BackendStatus::Disconnected,
                    )
                    .await;
            }
        }

        // Refresh cache
        if let Err(e) = cache.refresh_all(&state.client, &backend_copy).await {
            warn!("Failed to refresh cache for remote backend: {}", e);
        }
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
    backend_type: String,
    username: Option<String>,
    password: Option<String>,
    config_password: Option<String>,
) -> Result<(), String> {
    info!("➕ Adding backend: {} ({}:{})", name, host, port);

    // Validate name
    if name.is_empty() {
        return Err("Backend name cannot be empty".to_string());
    }
    if name == "Local" {
        return Err(
            "Cannot add a backend named 'Local' - reserved for the default backend".to_string(),
        );
    }

    // Parse backend type
    let backend_type = match backend_type.to_lowercase().as_str() {
        "local" => BackendType::Local,
        "remote" => BackendType::Remote,
        _ => return Err(format!("Invalid backend type: {}", backend_type)),
    };

    // Create the backend
    let mut backend = match backend_type {
        BackendType::Local => RcloneBackend::new_local(&name),
        BackendType::Remote => RcloneBackend::new_remote(&name, &host, port),
    };

    // Update connection details
    backend.connection.host = host;
    backend.connection.port = port;

    // Set auth if provided
    if let Some(username) = username {
        backend.connection.auth = Some(crate::rclone::backend::types::BackendAuth {
            username,
            password: password.clone(),
        });
    }

    if let Some(cp) = config_password {
        backend.config_password = Some(cp);
    }

    // Add to manager
    BACKEND_MANAGER.add_backend(backend.clone()).await?;

    // Persist to settings
    let settings_manager = app.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    save_backend_to_settings(settings_manager.inner(), &backend).await?;

    info!("✅ Backend '{}' added successfully", name);
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
    backend_type: String,
    username: Option<String>,
    password: Option<String>,
    config_password: Option<String>,
    oauth_host: Option<String>,
    oauth_port: Option<u16>,
) -> Result<(), String> {
    info!("🔄 Updating backend: {} ({}:{})", name, host, port);

    // Parse backend type
    let backend_type = match backend_type.to_lowercase().as_str() {
        "local" => BackendType::Local,
        "remote" => BackendType::Remote,
        _ => return Err(format!("Invalid backend type: {}", backend_type)),
    };

    // Create the updated backend
    let mut backend = match backend_type {
        BackendType::Local => RcloneBackend::new_local(&name),
        BackendType::Remote => RcloneBackend::new_remote(&name, &host, port),
    };

    // Update connection details
    backend.connection.host = host;
    backend.connection.port = port;

    // Set auth if provided
    if let Some(username) = username {
        let auth = crate::rclone::backend::types::BackendAuth {
            username,
            password: password.clone(),
        };
        backend.connection.auth = Some(auth);
    }

    // Set config password if provided
    if let Some(cp) = config_password {
        backend.config_password = Some(cp);
    }

    // Set OAuth config if provided (for Local backends)
    if oauth_host.is_some() || oauth_port.is_some() {
        backend.oauth = Some(crate::rclone::backend::types::OAuthConfig {
            host: oauth_host.unwrap_or_else(|| "127.0.0.1".to_string()),
            port: oauth_port.unwrap_or(51901),
        });
    }

    // Update the backend
    BACKEND_MANAGER.update_backend(backend.clone()).await?;

    // Persist to settings
    let settings_manager = app.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    save_backend_to_settings(settings_manager.inner(), &backend).await?;

    // Restart engine if Local backend was updated
    if name == "Local" {
        info!("🔄 Restarting engine due to Local backend update");
        if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
            &app,
            "backend_settings",
            "updated",
            "updated",
        ) {
            warn!("Failed to restart engine after backend update: {}", e);
        }
    }

    info!("✅ Backend '{}' updated successfully", name);
    Ok(())
}

/// Remove a backend
#[tauri::command]
pub async fn remove_backend(app: AppHandle, name: String) -> Result<(), String> {
    info!("➖ Removing backend: {}", name);

    if name == "Local" {
        return Err("Cannot remove the default 'Local' backend".to_string());
    }

    // Remove from manager
    BACKEND_MANAGER.remove_backend(&name).await?;

    // Remove from settings
    let settings_manager = app.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    delete_backend_from_settings(settings_manager.inner(), &name).await?;

    info!("✅ Backend '{}' removed successfully", name);
    Ok(())
}

/// Test connection to a backend
#[tauri::command]
pub async fn test_backend_connection(
    name: String,
    state: State<'_, RcloneState>,
) -> Result<TestConnectionResult, String> {
    debug!("🔍 Testing connection to backend: {}", name);

    let backend = BACKEND_MANAGER
        .get(&name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    let backend_guard = backend.read().await;
    let backend_copy = backend_guard.clone();
    drop(backend_guard);

    // Test by calling /core/version endpoint
    let url = EndpointHelper::build_url(&backend_copy.api_url(), core::VERSION);

    match backend_copy
        .inject_auth(state.client.post(&url))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                let body = response.text().await.unwrap_or_default();
                let version = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| {
                        v.get("version")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                // Update status to connected
                let _ = BACKEND_MANAGER
                    .set_status(
                        &name,
                        crate::rclone::backend::types::BackendStatus::Connected,
                    )
                    .await;

                Ok(TestConnectionResult {
                    success: true,
                    message: "Connection successful".to_string(),
                    version,
                })
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(TestConnectionResult {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                    version: None,
                })
            }
        }
        Err(e) => {
            warn!("❌ Connection test failed for '{}': {}", name, e);
            Ok(TestConnectionResult {
                success: false,
                message: format!("Connection failed: {}", e),
                version: None,
            })
        }
    }
}

/// Result of a connection test
#[derive(Debug, Clone, serde::Serialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub version: Option<String>,
}

// =============================================================================
// Persistence Helpers
// =============================================================================

/// Store backend secrets in the credential manager
fn store_backend_secrets(
    manager: &rcman::SettingsManager<rcman::JsonStorage>,
    backend: &RcloneBackend,
) -> Result<(), String> {
    if let Some(creds) = manager.credentials() {
        // Store password if present
        if let Some(ref auth) = backend.connection.auth
            && let Some(ref password) = auth.password
            && !password.is_empty()
        {
            creds
                .store(&format!("backend:{}:password", backend.name), password)
                .map_err(|e| format!("Failed to store password: {}", e))?;
            info!(
                "🔐 Stored password for backend '{}' in keychain",
                backend.name
            );
        }

        // Store config_password if present
        if let Some(ref config_password) = backend.config_password
            && !config_password.is_empty()
        {
            creds
                .store(
                    &format!("backend:{}:config_password", backend.name),
                    config_password,
                )
                .map_err(|e| format!("Failed to store config_password: {}", e))?;
            info!(
                "🔐 Stored config_password for backend '{}' in keychain",
                backend.name
            );
        }
    }
    Ok(())
}

/// Remove backend secrets from the credential manager
fn remove_backend_secrets(manager: &rcman::SettingsManager<rcman::JsonStorage>, name: &str) {
    if let Some(creds) = manager.credentials() {
        let _ = creds.remove(&format!("backend:{}:password", name));
        let _ = creds.remove(&format!("backend:{}:config_password", name));
        info!("🔐 Removed secrets for backend '{}' from keychain", name);
    }
}

/// Load backend secrets from the credential manager
pub fn load_backend_secrets(
    manager: &rcman::SettingsManager<rcman::JsonStorage>,
    backend: &mut RcloneBackend,
) {
    if let Some(creds) = manager.credentials() {
        // Load password
        if let Ok(Some(password)) = creds.get(&format!("backend:{}:password", backend.name)) {
            if let Some(ref mut auth) = backend.connection.auth {
                auth.password = Some(password);
            } else {
                // Create auth with just password (username might be in JSON)
                backend.connection.auth = Some(crate::rclone::backend::types::BackendAuth {
                    username: String::new(),
                    password: Some(password),
                });
            }
        }

        // Load config_password
        if let Ok(Some(config_password)) =
            creds.get(&format!("backend:{}:config_password", backend.name))
        {
            backend.config_password = Some(config_password);
        }
    }
}

async fn save_backend_to_settings(
    manager: &rcman::SettingsManager<rcman::JsonStorage>,
    backend: &RcloneBackend,
) -> Result<(), String> {
    // Store secrets in credential manager first
    store_backend_secrets(manager, backend)?;

    // Clone backend and strip secrets before saving to JSON
    let mut backend_for_json = backend.clone();
    if let Some(ref mut auth) = backend_for_json.connection.auth {
        auth.password = None; // Don't save password to JSON
    }
    backend_for_json.config_password = None; // Don't save config_password to JSON

    let connections = manager
        .sub_settings("connections")
        .map_err(|e| e.to_string())?;

    let value = serde_json::to_value(&backend_for_json).map_err(|e| e.to_string())?;
    connections
        .set(&backend.name, &value)
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn delete_backend_from_settings(
    manager: &rcman::SettingsManager<rcman::JsonStorage>,
    name: &str,
) -> Result<(), String> {
    // Remove secrets from credential manager
    remove_backend_secrets(manager, name);

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
        // Should always have at least the Local backend
        let backends = list_backends().await.unwrap();
        assert!(!backends.is_empty());

        // Local should be active by default
        let local = backends.iter().find(|b| b.name == "Local");
        assert!(local.is_some());
        assert!(local.unwrap().is_active);
    }

    #[tokio::test]
    async fn test_get_active_backend() {
        let active = get_active_backend().await.unwrap();
        assert_eq!(active, "Local");
    }

    #[tokio::test]
    async fn test_backend_info_from_backend() {
        let backend = RcloneBackend::new_local("TestBackend");
        let info = BackendInfo::from_backend(&backend, true);

        assert_eq!(info.name, "TestBackend");
        assert_eq!(info.backend_type, BackendType::Local);
        assert_eq!(info.host, "127.0.0.1");
        assert_eq!(info.port, 51900);
        assert!(info.is_active);
        assert_eq!(info.status, "disconnected");
    }

    #[tokio::test]
    async fn test_backend_info_remote() {
        let backend = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);
        let info = BackendInfo::from_backend(&backend, false);

        assert_eq!(info.name, "NAS");
        assert_eq!(info.backend_type, BackendType::Remote);
        assert_eq!(info.host, "192.168.1.100");
        assert_eq!(info.port, 51900);
        assert!(!info.is_active);
    }

    #[tokio::test]
    async fn test_test_connection_result() {
        let result = TestConnectionResult {
            success: true,
            message: "OK".to_string(),
            version: Some("1.65.0".to_string()),
        };

        assert!(result.success);
        assert_eq!(result.message, "OK");
        assert_eq!(result.version, Some("1.65.0".to_string()));
    }
}
