use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::{check_binaries::build_rclone_command, security::SafeEnvironmentManager},
    utils::types::all_types::RcApiEngine,
};

impl RcApiEngine {
    /// Validate rclone configuration and password before starting the engine
    /// This prevents engine startup failures due to wrong passwords
    pub async fn validate_config_before_start(&self, app: &AppHandle) -> Result<(), String> {
        info!("🔍 Validating rclone configuration before engine start...");

        // Check if rclone binary exists and is available using shared helpers
        match crate::core::check_binaries::check_rclone_available(app.clone(), "").await {
            Ok(available) => {
                if !available {
                    let path = crate::core::check_binaries::read_rclone_path(app);
                    let err_msg = format!("Rclone binary not found at: {}", path.display());
                    error!("❌ {}", err_msg);
                    return Err(err_msg);
                }
            }
            Err(e) => {
                let err_msg = format!("Failed to check rclone availability: {}", e);
                error!("❌ {}", err_msg);
                return Err(err_msg);
            }
        }

        // Use dedicated method to check if config is encrypted
        // This uses a combination of methods to reliably detect encryption
        let is_encrypted = self.is_config_encrypted(app).await;

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
            return Err("Configuration is encrypted but no password is available".to_string());
        }

        // Run 'rclone listremotes' to test the password
        let output = build_rclone_command(app, None, None, None)
            .args(["listremotes", "--ask-password=false"])
            .envs(&env_vars)
            .output()
            .await
            .map_err(|e| format!("Failed to execute rclone command: {}", e))?;

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
                let error_msg = "Wrong password for encrypted rclone configuration";
                error!("❌ {}", error_msg);
                Err(error_msg.to_string())
            } else if stderr.contains("Failed to load config file") {
                let error_msg = format!("Failed to load rclone config file: {}", stderr.trim());
                error!("❌ {}", error_msg);
                Err(error_msg)
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

    /// Quick check if configuration is encrypted without requiring password
    pub async fn is_config_encrypted(&self, _app: &AppHandle) -> bool {
        debug!("🔍 Checking if rclone configuration is encrypted...");

        let rclone_command = build_rclone_command(_app, None, None, None);

        // Don't use env_clear() as it removes PATH and prevents rclone from finding
        // system utilities like getent on Linux systems.
        let output = match rclone_command
            .args(["listremotes", "--ask-password=false"])
            .output()
            .await
        {
            Ok(output) => output,
            Err(e) => {
                warn!("Failed to execute rclone command: {}", e);
                return false;
            }
        };

        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!("🔍 rclone listremotes stderr: {}", stderr.trim());

        // Check for encryption error message
        if stderr.contains("unable to decrypt configuration and not allowed to ask for password")
            || stderr.contains("Failed to load config file") && stderr.contains("unable to decrypt")
        {
            debug!("🔒 Configuration is encrypted");
            true
        } else if output.status.success() {
            debug!("🔓 Configuration is NOT encrypted");
            false
        } else {
            // Other error - assume not encrypted if we can't determine
            warn!("⚠️ Unexpected error checking encryption: {}", stderr);
            false
        }
    }

    /// Test configuration and password without starting the engine (synchronous version for init)
    pub fn validate_config_sync(&mut self, app: &AppHandle) -> bool {
        info!("🧪 Testing rclone configuration and password synchronously...");

        // Use blocking call for synchronous validation
        let result = tauri::async_runtime::block_on(self.validate_config_before_start(app));

        match result {
            Ok(_) => {
                info!("✅ Rclone configuration and password are valid");
                self.password_error = false;
                true
            }
            Err(e) => {
                error!("❌ Rclone configuration validation failed: {}", e);

                // Categorize the error type and set appropriate flags
                let (status, user_message) = if e.contains("Rclone binary not found") {
                    // This is a binary path issue, not a password issue
                    self.password_error = false;
                    self.path_error = true;
                    (
                        "path_error",
                        "Rclone executable was not found. Please ensure rclone is installed correctly.",
                    )
                } else if e.contains("Wrong password") || e.contains("Invalid environment password")
                {
                    // This is a password issue
                    self.password_error = true;
                    (
                        "password_error",
                        "The password for your encrypted rclone configuration is incorrect. Please update your password.",
                    )
                } else if e.contains("no password is available") {
                    // This is also a password issue (missing password)
                    self.password_error = true;
                    (
                        "password_error",
                        "Your rclone configuration is encrypted but no password was provided. Please set a password.",
                    )
                } else if e.contains("Failed to load rclone config file") {
                    // This could be a config file issue, not necessarily password
                    self.password_error = false;
                    (
                        "config_error",
                        "Could not load your rclone configuration file. It may be corrupted or missing.",
                    )
                } else {
                    // Unknown error - don't assume it's a password issue
                    self.password_error = false;
                    ("error", e.as_str())
                };

                if let Err(emit_err) = app.emit(
                    "rclone_engine",
                    serde_json::json!({
                        "status": status,
                        "message": user_message
                    }),
                ) {
                    error!("Failed to emit validation error event: {emit_err}");
                }
                false
            }
        }
    }

    pub fn update_port(&mut self, app: &AppHandle, new_port: u16) {
        info!(
            "🔄 Updating Rclone API port from {} to {}",
            self.current_api_port, new_port
        );

        // Import the stop and start methods from lifecycle module
        if let Err(e) = crate::rclone::engine::lifecycle::stop(self) {
            error!("Failed to stop Rclone process: {e}");
        }
        self.current_api_port = new_port;
        crate::rclone::engine::lifecycle::start(self, app);
    }
}
