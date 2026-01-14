use log::info;
use tauri::{AppHandle, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::SafeEnvironmentManager;

/// Setup environment variables for rclone processes (main engine or OAuth)
/// Password is retrieved from SafeEnvironmentManager (single source of truth)
pub async fn setup_rclone_environment(
    app: &AppHandle,
    mut command: tauri_plugin_shell::process::Command,
    process_type: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let mut password_found = false;

    // Get password from SafeEnvironmentManager (synced from backend at startup)
    if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
        let env_vars = env_manager.get_env_vars();
        if env_vars.contains_key("RCLONE_CONFIG_PASS") {
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

    // Only check encryption status if no password found and this is main engine
    if !password_found && process_type == "main_engine" {
        // Always run fresh check to detect external config changes
        match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(true) => {
                info!("🔒 Configuration is encrypted but no password available, stopping start");
                return Err(crate::localized_error!(
                    "backendErrors.rclone.configEncrypted"
                ));
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

pub async fn create_rclone_command(
    app: &AppHandle,
    process_type: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    // Get paths for logging (directories already created during app startup)
    let paths = crate::core::paths::AppPaths::from_app_handle(app)?;

    // Fetch Local backend to get the configured config path
    let config_path = crate::rclone::backend::BACKEND_MANAGER
        .get_local_config_path()
        .await
        .unwrap_or(None);

    let command = build_rclone_command(app, None, config_path.as_deref(), None);

    // Retrieve active backend settings to check for valid auth
    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;
    let backend = backend_manager.get_active().await;

    // Determine port based on process type
    let port = match process_type {
        "main_engine" => backend.port,
        "oauth" => backend
            .oauth_port
            .ok_or_else(|| crate::localized_error!("backendErrors.system.oauthNotConfigured"))?,
        _ => {
            return Err(
                crate::localized_error!("backendErrors.rclone.unknownProcessType", "type" => process_type),
            );
        }
    };

    // Only use auth if properly configured (non-empty username AND password)
    let auth_args = if backend.has_valid_auth() {
        Some((
            backend.username.clone().unwrap(),
            backend.password.clone().unwrap_or_default(),
        ))
    } else {
        None
    };

    // Get log file path from centralized locations
    let log_file = paths.get_rclone_log_file(process_type);

    // Standard rclone daemon arguments with built-in log rotation
    let mut args = vec![
        "rcd".to_string(),
        "--rc-serve".to_string(),
        format!("--rc-addr={}:{}", backend.host, port),
        "--rc-allow-origin".to_string(),
        "*".to_string(),
        "--log-file".to_string(),
        log_file.to_string_lossy().to_string(),
        "--log-file-max-size".to_string(),
        "5M".to_string(),
        "--log-file-max-backups".to_string(),
        "5".to_string(),
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
