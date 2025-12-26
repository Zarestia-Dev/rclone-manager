use log::{error, info};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::SafeEnvironmentManager;
use crate::rclone::engine::core::ENGINE;
use crate::utils::types::events::RCLONE_ENGINE_PASSWORD_ERROR;

/// Clear cached encryption status (e.g., when config changes)
pub fn clear_encryption_cache() {
    if let Ok(mut engine_guard) = ENGINE.try_lock() {
        engine_guard.config_encrypted = None;
        info!("🗑️ Cleared cached encryption status");
    }
}

/// Get cached encryption status without checking (returns None if not cached)
pub fn get_cached_encryption_status() -> Option<bool> {
    if let Ok(engine_guard) = ENGINE.try_lock() {
        engine_guard.config_encrypted
    } else {
        None
    }
}

/// Check if config is encrypted, using cached value if available
async fn is_config_encrypted_cached(app: &AppHandle) -> bool {
    // Try to get cached value from engine state first
    if let Ok(engine_guard) = ENGINE.try_lock()
        && let Some(cached_status) = engine_guard.config_encrypted
    {
        info!("🚀 Using cached encryption status: {}", cached_status);
        return cached_status;
    }

    // If not cached, check and cache the result
    match crate::core::security::is_config_encrypted(app.clone()).await {
        Ok(is_encrypted) => {
            info!("🔍 Config encryption status determined: {}", is_encrypted);

            // Cache the result in engine state
            if let Ok(mut engine_guard) = ENGINE.try_lock() {
                engine_guard.config_encrypted = Some(is_encrypted);
                info!("💾 Cached encryption status for future use");
            }

            is_encrypted
        }
        Err(e) => {
            info!(
                "⚠️ Could not determine config encryption status: {}, assuming not encrypted",
                e
            );

            // Cache the "not encrypted" assumption
            if let Ok(mut engine_guard) = ENGINE.try_lock() {
                engine_guard.config_encrypted = Some(false);
            }

            false
        }
    }
}

/// Setup environment variables for rclone processes (main engine or OAuth)
pub async fn setup_rclone_environment(
    app: &AppHandle,
    mut command: tauri_plugin_shell::process::Command,
    process_type: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let mut password_found = false;

    // Try to get password from SafeEnvironmentManager first (GUI context)
    if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
        let env_vars = env_manager.get_env_vars();
        if !env_vars.is_empty() && env_vars.contains_key("RCLONE_CONFIG_PASS") {
            info!(
                "🔑 Using environment manager password for {} process",
                process_type
            );
            for (key, value) in env_vars {
                command = command.env(&key, &value);
            }
            password_found = true;
        }
    }

    // If no password found in environment manager, try retrieving from Local Backend
    // This is the new standard "Unified" storage
    if !password_found
        && let Some(backend) = crate::rclone::backend::BACKEND_MANAGER.get("Local").await
    {
        let guard = backend.read().await;
        if let Some(ref password) = guard.config_password
            && !password.is_empty()
        {
            info!(
                "🔑 Using stored rclone config password (via Local backend) for {} process",
                process_type
            );
            command = command.env("RCLONE_CONFIG_PASS", password);
            password_found = true;

            // Also update the environment manager for future use
            if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
                env_manager.set_config_password(password.clone());
            }
        }
    }

    // Only check encryption status if no password found and this is main engine
    if !password_found && process_type == "main_engine" {
        // Use cached encryption check for performance
        if is_config_encrypted_cached(app).await {
            info!(
                "🔒 Configuration is encrypted but no password available, emitting password error"
            );
            if let Err(e) = app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()) {
                error!("Failed to emit password error event: {e}");
            }
        } else {
            info!("🔓 Configuration is not encrypted, proceeding without password");
        }
    }

    Ok(command)
}

/// Create and configure a new rclone command with standard settings
pub async fn create_rclone_command(
    port: u16,
    app: &AppHandle,
    process_type: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let command = build_rclone_command(app, None, None, None);

    // Retrieve active backend settings to check for auth
    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    let auth_args = if let Some(backend) = backend_manager.get_active().await {
        let guard = backend.read().await;
        if let Some(ref auth) = guard.connection.auth {
            // Use password if present, otherwise fall back to username as password
            let password = auth.password.as_deref().unwrap_or(&auth.username);
            Some((auth.username.clone(), password.to_string()))
        } else {
            None
        }
    } else {
        None
    };

    // Standard rclone daemon arguments
    let mut args = vec![
        "rcd".to_string(),
        "--rc-serve".to_string(),
        format!("--rc-addr=127.0.0.1:{}", port),
        "--rc-allow-origin".to_string(),
        "*".to_string(),
    ];

    if let Some((user, pass)) = auth_args {
        // Use auth args
        info!("🔐 Starting rclone with authentication enabled");
        args.push(format!("--rc-user={}", user));
        args.push(format!("--rc-pass={}", pass));
    } else {
        // No auth (default)
        info!("🔓 Starting rclone with NO authentication");
        args.push("--rc-no-auth".to_string());
    }

    let command = command.args(args);

    // Set up environment variables
    let command = setup_rclone_environment(app, command, process_type).await?;

    Ok(command)
}
