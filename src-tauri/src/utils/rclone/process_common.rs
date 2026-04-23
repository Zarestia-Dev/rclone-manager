use log::{debug, info, warn};
use tauri::{AppHandle, Manager};

use crate::core::check_binaries::build_rclone_command;
use crate::core::security::SafeEnvironmentManager;
use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::CoreSettings;
use crate::utils::types::core::{ProcessKind, is_sensitive_field};
use rcman::SettingsSchema;

/// Apply environment variables to the rclone command.
async fn apply_rclone_environment(
    app: &AppHandle,
    mut command: crate::utils::process::command::Command,
) -> Result<crate::utils::process::command::Command, crate::rclone::engine::error::EngineError> {
    let mut password_found = false;

    if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
        let env_vars = env_manager.get_env_vars();
        if env_vars.contains_key("RCLONE_CONFIG_PASS") {
            debug!("Applying environment manager vars to rclone process");
            for (key, value) in env_vars {
                command = command.env(&key, &value);
            }
            password_found = true;
        }
    }

    let settings_manager = app.state::<AppSettingsManager>();
    if let Ok(settings) = settings_manager.get_all() {
        for env_str in &settings.core.rclone_env_vars {
            if let Some((key, value)) = env_str.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                if !key.is_empty() {
                    debug!(
                        "Applying user rclone env: {key}={}",
                        if is_sensitive_field(key) {
                            "***"
                        } else {
                            value
                        }
                    );
                    command = command.env(key, value);
                }
            }
        }
    }

    if !password_found {
        match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(true) => {
                info!("Configuration is encrypted but no password available, aborting start");
                return Err(crate::rclone::engine::error::EngineError::PasswordRequired);
            }
            Ok(false) => {}
            Err(e) => {
                warn!("Could not determine encryption status: {e}, proceeding without password");
            }
        }
    }

    Ok(command)
}

fn build_rclone_base_args(host: &str, port: u16) -> Vec<String> {
    vec![
        "rcd".to_string(),
        "--rc-serve".to_string(),
        format!("--rc-addr={host}:{port}"),
        "--rc-allow-origin".to_string(),
        "*".to_string(),
    ]
}

fn append_user_flags_from_app(
    app: &AppHandle,
    args: &mut Vec<String>,
) -> Result<(), crate::rclone::engine::error::EngineError> {
    let settings_manager = app.state::<AppSettingsManager>();

    let Ok(settings) = settings_manager.get_all() else {
        debug!("Could not load settings to check for additional flags");
        return Ok(());
    };

    let extra_flags = &settings.core.rclone_additional_flags;
    if extra_flags.is_empty() {
        return Ok(());
    }

    let metadata = CoreSettings::get_metadata();
    if let Some(meta) = metadata.get("core.rclone_additional_flags") {
        let flags_value = serde_json::to_value(extra_flags).map_err(|e| {
            crate::rclone::engine::error::EngineError::ConfigValidationFailed(e.to_string())
        })?;

        if let Err(e) = meta.validate(&flags_value) {
            info!("Blocked reserved/invalid flags: {e}");
            return Err(
                crate::rclone::engine::error::EngineError::ConfigValidationFailed(
                    crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => e),
                ),
            );
        }
    }

    debug!("Appending user-defined flags: {extra_flags:?}");

    for flag in extra_flags {
        if let Some((key, value)) = flag.split_once(' ') {
            args.push(key.to_string());
            args.push(value.to_string());
        } else {
            args.push(flag.clone());
        }
    }

    Ok(())
}

fn append_auth_args(args: &mut Vec<String>, username: Option<String>, password: Option<String>) {
    match (username, password) {
        (Some(user), Some(pass)) if !user.is_empty() => {
            debug!("Starting rclone with authentication");
            args.push(format!("--rc-user={user}"));
            args.push(format!("--rc-pass={pass}"));
        }
        _ => {
            debug!("Starting rclone with no authentication");
            args.push("--rc-no-auth".to_string());
        }
    }
}

/// Build the rclone command for the main engine or the OAuth process.
pub async fn build_rclone_process_command(
    app: &AppHandle,
    kind: ProcessKind,
) -> Result<crate::utils::process::command::Command, crate::rclone::engine::error::EngineError> {
    use crate::rclone::backend::BackendManager;
    use std::path::PathBuf;

    let backend_manager_state = app.state::<BackendManager>();
    let config_path = match backend_manager_state.get_local_config_path().await {
        Ok(path) => path,
        Err(e) => {
            warn!("Failed to get local config path, proceeding without it: {e}");
            None
        }
    };

    let backend = backend_manager_state.get_active().await;

    let port = match kind {
        ProcessKind::Engine => backend.port,
        ProcessKind::OAuth => backend.oauth_port,
    };

    let command = build_rclone_command(app, None, config_path.as_deref(), None);
    let mut args = build_rclone_base_args(&backend.host, port);

    if let ProcessKind::Engine = kind {
        let log_file_path = crate::core::paths::AppPaths::from_app_handle(app).map_or_else(
            |_| PathBuf::from("main_engine.log"),
            |paths| paths.get_rclone_log_dir().join("main_engine.log"),
        );

        args.extend([
            "--log-file".to_string(),
            log_file_path.to_string_lossy().to_string(),
            "--log-file-max-size".to_string(),
            "5M".to_string(),
            "--log-file-max-backups".to_string(),
            "5".to_string(),
        ]);

        append_user_flags_from_app(app, &mut args)?;
    }

    let auth_args = if backend.has_valid_auth() {
        Some((
            backend.username.clone().unwrap(),
            backend.password.clone().unwrap_or_default(),
        ))
    } else {
        None
    };

    append_auth_args(
        &mut args,
        auth_args.as_ref().map(|(u, _)| u.clone()),
        auth_args.map(|(_, p)| p),
    );

    apply_rclone_environment(app, command.args(args)).await
}
