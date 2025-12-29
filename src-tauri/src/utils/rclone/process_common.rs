use log::info;
use tauri::{AppHandle, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::SafeEnvironmentManager;

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
        && let Some(ref password) = backend.config_password
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

    // Only check encryption status if no password found and this is main engine
    if !password_found && process_type == "main_engine" {
        // Always run fresh check to detect external config changes
        match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(true) => {
                info!("🔒 Configuration is encrypted but no password available, stopping start");
                return Err("Configuration is encrypted and no password provided".to_string());
            }
            Ok(false) => {
                info!("🔓 Configuration is not encrypted, proceeding without password");
            }
            Err(e) => {
                info!("⚠️ Could not determine encryption status: {e}, proceeding without password");
            }
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

    // Retrieve active backend settings to check for valid auth
    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    let backend = backend_manager.get_active().await;

    // Only use auth if properly configured (non-empty username AND password)
    let auth_args = if backend.has_valid_auth() {
        Some((
            backend.username.clone().unwrap(),
            backend.password.clone().unwrap_or_default(),
        ))
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
