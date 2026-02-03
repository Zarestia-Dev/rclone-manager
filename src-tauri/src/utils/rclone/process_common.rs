use log::info;
use tauri::{AppHandle, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::SafeEnvironmentManager;
use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::CoreSettings;
use rcman::SettingsSchema;

/// Setup environment variables for rclone processes (main engine or OAuth)
/// Password is retrieved from SafeEnvironmentManager (single source of truth)
pub async fn setup_rclone_environment(
    app: &AppHandle,
    mut command: crate::utils::process::command::Command,
    process_type: &str,
) -> Result<crate::utils::process::command::Command, crate::rclone::engine::error::EngineError> {
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
                // Return EngineError variant directly, not localized string
                return Err(crate::rclone::engine::error::EngineError::PasswordRequired);
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
) -> Result<crate::utils::process::command::Command, crate::rclone::engine::error::EngineError> {
    // Get paths for logging (directories already created during app startup)
    let paths = crate::core::paths::AppPaths::from_app_handle(app)
        .map_err(crate::rclone::engine::error::EngineError::SpawnFailed)?;

    // Fetch Local backend to get the configured config path
    // Fetch Local backend to get the configured config path
    use crate::rclone::backend::BackendManager;
    let backend_manager_state = app.state::<BackendManager>();

    let config_path = backend_manager_state
        .get_local_config_path()
        .await
        .unwrap_or(None);

    let command = build_rclone_command(app, None, config_path.as_deref(), None);

    // Retrieve active backend settings to check for valid auth
    let backend = backend_manager_state.get_active().await;

    // Determine port based on process type
    let port = match process_type {
        "main_engine" => backend.port,
        "oauth" => backend.oauth_port.ok_or_else(|| {
            crate::rclone::engine::error::EngineError::SpawnFailed(crate::localized_error!(
                "backendErrors.system.oauthNotConfigured"
            ))
        })?,
        _ => {
            return Err(crate::rclone::engine::error::EngineError::SpawnFailed(
                crate::localized_error!("backendErrors.rclone.unknownProcessType", "type" => process_type),
            ));
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

    // Inject user-defined flags from settings
    {
        let settings_manager = app.state::<AppSettingsManager>();
        // get_all returns the typed AppSettings struct (Result)
        if let Ok(settings) = settings_manager.get_all() {
            let extra_flags = &settings.core.rclone_additional_flags;

            if !extra_flags.is_empty() {
                // Retrieve metadata to validate flags (checks for reserved values)
                let metadata = CoreSettings::get_metadata();
                if let Some(meta) = metadata.get("core.rclone_additional_flags") {
                    let flags_value = serde_json::to_value(extra_flags).map_err(|e| {
                        crate::rclone::engine::error::EngineError::ConfigValidationFailed(
                            e.to_string(),
                        )
                    })?;

                    if let Err(e) = meta.validate(&flags_value) {
                        info!("❌ Blocked reserved/invalid flags: {}", e);
                        return Err(
                            crate::rclone::engine::error::EngineError::ConfigValidationFailed(
                                crate::localized_error!(
                                    "backendErrors.rclone.invalidFlags",
                                    "error" => e
                                ),
                            ),
                        );
                    }
                }

                info!("🚩 Appending user-defined flags: {:?}", extra_flags);

                // Allow space-separated flags (e.g., "--log-level DEBUG") to be passed as separate arguments
                for flag in extra_flags {
                    if let Some((key, value)) = flag.split_once(' ') {
                        // Split only on the FIRST space to preserve spaces in values
                        // e.g. "--user-agent My Agent" -> "--user-agent", "My Agent"
                        args.push(key.to_string());
                        args.push(value.to_string());
                    } else {
                        args.push(flag.clone());
                    }
                }
            }
        } else {
            info!("⚠️ Could not load settings to check for additional flags");
        }
    }

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
