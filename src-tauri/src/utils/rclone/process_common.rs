use log::{error, info};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::{CredentialStore, SafeEnvironmentManager};
use crate::rclone::engine::core::ENGINE;

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
    command: &mut std::process::Command,
    process_type: &str,
) -> Result<(), String> {
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
                command.env(key, value);
            }
            password_found = true;
        }
    }

    // If no password found in environment manager, try credential store
    if !password_found {
        if let Some(credential_store) = app.try_state::<CredentialStore>() {
            match credential_store.get_config_password() {
                Ok(password) => {
                    info!(
                        "🔑 Using stored rclone config password for {} process",
                        process_type
                    );
                    command.env("RCLONE_CONFIG_PASS", password.clone());
                    password_found = true;

                    // Also update the environment manager for future use
                    if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
                        env_manager.set_config_password(password);
                    }
                }
                Err(_) => {
                    info!("ℹ️ No stored password found for {} process", process_type);
                }
            }
        } else {
            info!(
                "⚠️ CredentialStore not available for {} process",
                process_type
            );
        }
    }

    // Only check encryption status if no password found and this is main engine
    if !password_found && process_type == "main_engine" {
        // Use cached encryption check for performance
        if is_config_encrypted_cached(app).await {
            info!(
                "🔒 Configuration is encrypted but no password available, emitting password error"
            );
            if let Err(e) = app.emit(
                "rclone_engine",
                serde_json::json!({
                    "status": "password_error",
                    "message": "Rclone configuration requires a password but none is available"
                }),
            ) {
                error!("Failed to emit password error event: {e}");
            }
        } else {
            info!("🔓 Configuration is not encrypted, proceeding without password");
        }
    }

    Ok(())
}

/// Create and configure a new rclone command with standard settings
pub async fn create_rclone_command(
    port: u16,
    app: &AppHandle,
    process_type: &str,
) -> Result<Command, String> {
    let mut command = build_rclone_command(app, None, None, None);

    // Standard rclone daemon arguments
    command.args([
        "rcd",
        "--rc-no-auth",
        "--rc-serve",
        &format!("--rc-addr=127.0.0.1:{}", port),
    ]);

    // Configure stdio
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());

    // Set up environment variables
    setup_rclone_environment(app, &mut command, process_type).await?;

    // Windows-specific console window handling
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00200000);
    }

    Ok(command)
}
