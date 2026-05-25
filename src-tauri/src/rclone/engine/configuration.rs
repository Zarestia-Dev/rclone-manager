use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::{check_binaries::build_rclone_command, security::SafeEnvironmentManager},
    rclone::backend::BackendManager,
    utils::types::{
        events::{RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR, RCLONE_ENGINE_PATH_ERROR},
        state::RcApiEngine,
    },
};

use super::error::{EngineError, EngineResult};

impl RcApiEngine {
    pub async fn validate_config_before_start(&self, app: &AppHandle) -> EngineResult<()> {
        info!("Validating rclone configuration before engine start");

        if !crate::core::check_binaries::check_rclone_available(app.clone(), String::new())
            .await
            .unwrap_or(false)
        {
            return Err(EngineError::RcloneNotFound);
        }

        let is_encrypted = match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(encrypted) => encrypted,
            Err(e) => {
                warn!("Unexpected error checking encryption: {e}");
                false
            }
        };

        if !is_encrypted {
            info!("Configuration is not encrypted, validation successful");
            return Ok(());
        }

        info!("Configuration is encrypted, testing password");

        let env_vars = if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
            env_manager.get_env_vars()
        } else {
            warn!("SafeEnvironmentManager not available, using system environment");
            std::env::vars().collect()
        };

        if !env_vars.contains_key("RCLONE_CONFIG_PASS") {
            warn!("No password available for encrypted configuration");
            return Err(EngineError::PasswordRequired);
        }

        let backend_manager = app.state::<BackendManager>();
        let config_path_string = backend_manager.get_local_config_path().await.map_err(|e| {
            EngineError::ConfigValidationFailed(format!("Local backend error: {e}"))
        })?;

        let output = build_rclone_command(app, None, config_path_string.as_deref(), None)
            .args(["listremotes", "--ask-password=false"])
            .envs(&env_vars)
            .output()
            .await
            .map_err(|e| {
                EngineError::ConfigValidationFailed(format!(
                    "Failed to execute rclone command: {e}"
                ))
            })?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            info!("Rclone configuration and password validation successful");
            return Ok(());
        }

        if stderr.contains("unable to decrypt configuration and not allowed to ask for password")
            || stderr.contains("Couldn't decrypt configuration")
            || stderr.contains("most likely wrong password")
            || stderr.contains("unable to decrypt configuration")
        {
            error!("Wrong password for encrypted rclone configuration");
            return Err(EngineError::WrongPassword);
        }

        if stderr.contains("Failed to load config file") {
            let msg = format!("Failed to load rclone config file: {}", stderr.trim());
            error!("{msg}");
            return Err(EngineError::ConfigValidationFailed(msg));
        }

        warn!(
            "Unexpected rclone error, attempting to continue: {}",
            stderr.trim()
        );
        Ok(())
    }

    pub async fn validate_config(&mut self, app: &AppHandle) -> bool {
        info!("Testing rclone configuration and password");

        match self.validate_config_before_start(app).await {
            Ok(()) => {
                info!("Rclone configuration and password are valid");
                self.clear_errors();
                true
            }
            Err(ref e) => {
                error!("Rclone configuration validation failed: {e}");

                match e {
                    EngineError::RcloneNotFound => {
                        self.set_password_error(false);
                        self.set_path_error(true);
                    }
                    EngineError::WrongPassword | EngineError::PasswordRequired => {
                        self.set_password_error(true);
                        self.set_path_error(false);
                    }
                    _ => {
                        self.clear_errors();
                    }
                }

                let event = if self.path_error {
                    RCLONE_ENGINE_PATH_ERROR
                } else if self.password_error {
                    RCLONE_ENGINE_PASSWORD_ERROR
                } else {
                    RCLONE_ENGINE_ERROR
                };

                if let Err(emit_err) = app.emit(event, ()) {
                    error!("Failed to emit validation error event: {emit_err}");
                }

                false
            }
        }
    }
}
