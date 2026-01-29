use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::{check_binaries::build_rclone_command, security::SafeEnvironmentManager},
    utils::types::{
        core::RcApiEngine,
        events::{RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR, RCLONE_ENGINE_PATH_ERROR},
    },
};

impl RcApiEngine {
    /// Validate rclone configuration and password before starting the engine
    /// This prevents engine startup failures due to wrong passwords
    pub async fn validate_config_before_start(
        &self,
        app: &AppHandle,
    ) -> super::error::EngineResult<()> {
        use super::error::EngineError;

        info!("🔍 Validating rclone configuration before engine start...");

        // Check if rclone binary exists and is available using shared helpers
        match crate::core::check_binaries::check_rclone_available(app.clone(), "").await {
            Ok(available) => {
                if !available {
                    let path = crate::core::check_binaries::read_rclone_path(app);
                    error!("❌ Rclone binary not found at: {}", path.display());
                    return Err(EngineError::RcloneNotFound);
                }
            }
            Err(e) => {
                error!("❌ Failed to check rclone availability: {}", e);
                return Err(EngineError::RcloneNotFound);
            }
        }

        // Use shared method from core security to check if config is encrypted
        let is_encrypted = match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(encrypted) => encrypted,
            Err(e) => {
                warn!("⚠️ Unexpected error checking encryption: {}", e);
                false
            }
        };

        // If config is not encrypted, we're done - no password needed
        if !is_encrypted {
            info!("✅ Configuration is not encrypted, validation successful");
            return Ok(());
        }

        // Config is encrypted, test with current password
        info!("🔐 Configuration is encrypted, testing password...");

        // Get environment variables from SafeEnvironmentManager
        let env_vars = if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
            env_manager.get_env_vars()
        } else {
            warn!("SafeEnvironmentManager not available, using system environment");
            std::env::vars().collect()
        };

        // Check if we have a password to test
        if !env_vars.contains_key("RCLONE_CONFIG_PASS") {
            warn!("🔑 No password available for encrypted configuration");
            return Err(EngineError::ConfigValidationFailed(
                "Configuration is encrypted but no password is available".to_string(),
            ));
        }

        // Run 'rclone listremotes' to test the password

        // Fetch Local backend to get the configured config path
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let config_path_string = backend_manager.get_local_config_path().await.map_err(|e| {
            EngineError::ConfigValidationFailed(format!("Local backend error: {}", e))
        })?;

        let config_path = config_path_string.as_deref();

        let output = build_rclone_command(app, None, config_path, None)
            .args(["listremotes", "--ask-password=false"])
            .envs(&env_vars)
            .output()
            .await
            .map_err(|e| {
                EngineError::ConfigValidationFailed(format!(
                    "Failed to execute rclone command: {}",
                    e
                ))
            })?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            info!("✅ Rclone configuration and password validation successful");
            Ok(())
        } else {
            // Check for specific error patterns
            if stderr
                .contains("unable to decrypt configuration and not allowed to ask for password")
                || stderr.contains("Couldn't decrypt configuration")
                || stderr.contains("most likely wrong password")
                || stderr.contains("unable to decrypt configuration")
            {
                error!("❌ Wrong password for encrypted rclone configuration");
                Err(EngineError::WrongPassword)
            } else if stderr.contains("Failed to load config file") {
                let error_msg = format!("Failed to load rclone config file: {}", stderr.trim());
                error!("❌ {}", error_msg);
                Err(EngineError::ConfigValidationFailed(error_msg))
            } else {
                // Unknown error, but we can still try to start the engine
                warn!(
                    "⚠️ Unexpected rclone error, but attempting to continue: {}",
                    stderr.trim()
                );
                Ok(())
            }
        }
    }

    /// Test configuration and password without starting the engine (async)
    pub async fn validate_config(&mut self, app: &AppHandle) -> bool {
        use super::error::EngineError;

        info!("🧪 Testing rclone configuration and password...");

        let result = self.validate_config_before_start(app).await;

        match result {
            Ok(_) => {
                info!("✅ Rclone configuration and password are valid");
                self.clear_errors();
                true
            }
            Err(ref e) => {
                error!("❌ Rclone configuration validation failed: {}", e);

                // Match on error type - no string parsing needed
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
                        // Generic error, clear specific flags
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
