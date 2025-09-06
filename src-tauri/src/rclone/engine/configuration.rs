use log::{debug, error, info, warn};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time;

use crate::{
    core::{
        check_binaries::{is_rclone_available, read_rclone_path},
        security::SafeEnvironmentManager,
    },
    utils::types::all_types::RcApiEngine,
};

impl RcApiEngine {
    /// Validate rclone configuration and password before starting the engine
    /// This prevents engine startup failures due to wrong passwords
    pub async fn validate_config_before_start(&self, app: &AppHandle) -> Result<(), String> {
        info!("🔍 Validating rclone configuration before engine start...");

        // Check if rclone binary exists and is available
        if !self.rclone_path.exists() {
            return Err(format!(
                "Rclone binary not found at: {}",
                self.rclone_path.display()
            ));
        }

        // First, quickly check if config is encrypted
        debug!("🔍 Checking if configuration is encrypted...");
        let mut encryption_cmd = tokio::process::Command::new(&self.rclone_path);
        encryption_cmd
            .args(["config", "encryption", "check"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("RCLONE_CONFIG_PASS"); // Don't use any password for this check

        let encryption_result =
            time::timeout(std::time::Duration::from_secs(3), encryption_cmd.output()).await;

        let is_encrypted = match encryption_result {
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                debug!("Encryption check stderr: {}", stderr.trim());

                // If stderr contains 'config file is NOT encrypted', config is NOT encrypted
                if !output.status.success() && stderr.contains("config file is NOT encrypted") {
                    debug!("✅ Configuration is not encrypted");
                    false
                } else {
                    debug!("🔒 Configuration is encrypted");
                    true
                }
            }
            Ok(Err(e)) => {
                warn!(
                    "Failed to check config encryption: {}, assuming encrypted",
                    e
                );
                true // Assume encrypted on error to be safe
            }
            Err(_timeout) => {
                debug!(
                    "⏱️ Config encryption check timed out - likely encrypted and waiting for password"
                );
                true
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
            return Err("Configuration is encrypted but no password is available".to_string());
        }

        // Run 'rclone listremotes' to test the password
        let mut cmd = tokio::process::Command::new(&self.rclone_path);
        cmd.arg("listremotes")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(&env_vars);

        debug!("🧪 Testing password with: rclone listremotes");

        // Use shorter timeout since we know config is encrypted and we have a password
        let result = time::timeout(std::time::Duration::from_secs(5), cmd.output()).await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                debug!("rclone listremotes stdout: {}", stdout.trim());
                debug!("rclone listremotes stderr: {}", stderr.trim());

                if output.status.success() {
                    info!("✅ Rclone configuration and password validation successful");
                    Ok(())
                } else {
                    // Check for specific error patterns
                    if stderr.contains("Couldn't decrypt configuration")
                        || stderr.contains("most likely wrong password")
                        || stderr.contains("unable to decrypt configuration")
                    {
                        error!("❌ Wrong password for encrypted configuration");
                        Err("Wrong password for encrypted rclone configuration".to_string())
                    } else if stderr.contains("Failed to load config file") {
                        error!("❌ Failed to load rclone config file");
                        Err(format!(
                            "Failed to load rclone config file: {}",
                            stderr.trim()
                        ))
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
            Ok(Err(e)) => {
                error!("❌ Failed to execute rclone listremotes: {}", e);
                Err(format!("Failed to execute rclone command: {}", e))
            }
            Err(_timeout) => {
                warn!("⏱️ rclone listremotes timed out - might be waiting for password input");
                Err("Rclone command timed out - configuration might require password".to_string())
            }
        }
    }

    // /// Quick check if configuration is encrypted without requiring password
    // pub async fn is_config_encrypted(&self, _app: &AppHandle) -> bool {
    //     debug!("🔍 Checking if rclone configuration is encrypted...");

    //     if !self.rclone_path.exists() {
    //         warn!("Rclone binary not found, assuming config is not encrypted");
    //         return false;
    //     }

    //     let mut cmd = tokio::process::Command::new(&self.rclone_path);
    //     cmd.args(["config", "encryption", "check"])
    //         .stdin(Stdio::null())
    //         .stdout(Stdio::piped())
    //         .stderr(Stdio::piped())
    //         .env_remove("RCLONE_CONFIG_PASS"); // Don't use any password for this check

    //     let result = time::timeout(std::time::Duration::from_secs(3), cmd.output()).await;

    //     match result {
    //         Ok(Ok(output)) => {
    //             let stderr = String::from_utf8_lossy(&output.stderr);
    //             debug!("rclone config encryption check stderr: {}", stderr.trim());

    //             // If stderr contains 'config file is NOT encrypted', config is NOT encrypted
    //             if !output.status.success() && stderr.contains("config file is NOT encrypted") {
    //                 debug!("✅ Configuration is not encrypted");
    //                 false
    //             } else {
    //                 debug!("🔒 Configuration is encrypted");
    //                 true
    //             }
    //         }
    //         Ok(Err(e)) => {
    //             warn!("Failed to check config encryption: {}, assuming encrypted", e);
    //             true // Assume encrypted on error to be safe
    //         }
    //         Err(_timeout) => {
    //             debug!("⏱️ Config encryption check timed out - likely encrypted and waiting for password");
    //             true
    //         }
    //     }
    // }

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
                self.password_error = true;
                if let Err(emit_err) = app.emit(
                    "rclone_engine",
                    serde_json::json!({
                        "status": "password_error",
                        "message": format!("Rclone configuration validation failed: {}", e)
                    }),
                ) {
                    error!("Failed to emit password error event: {emit_err}");
                }
                false
            }
        }
    }

    // /// Test configuration and password without starting the engine (async version for monitoring)
    // pub fn test_config_and_password(&mut self, app: &AppHandle) {
    //     info!("🧪 Testing rclone configuration and password...");

    //     // Then validate configuration
    //     if self.validate_config_sync(app) {
    //         info!("✅ Rclone configuration and password are valid");
    //         self.password_error = false;
    //     } else {
    //         error!("❌ Rclone configuration validation failed");
    //         self.password_error = true;
    //         if let Err(emit_err) = app.emit(
    //             "rclone_engine",
    //             serde_json::json!({
    //                 "status": "password_error",
    //                 "message": "Rclone configuration validation failed"
    //             }),
    //         ) {
    //             error!("Failed to emit password error event: {emit_err}");
    //         }
    //     }
    // }
    // pub fn get_config_path(&self, app: &AppHandle) -> Option<PathBuf> {
    //     let app_data_dir = app.path().app_data_dir().ok()?;
    //     let rclone_config_dir = app_data_dir.join("rclone");
    //     let rclone_config_file = rclone_config_dir.join("rclone.conf");

    //     if rclone_config_file.exists() {
    //         Some(rclone_config_file)
    //     } else {
    //         None
    //     }
    // }

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

    pub fn handle_invalid_path(&mut self, app: &AppHandle) {
        error!(
            "❌ Rclone binary does not exist: {}",
            self.rclone_path.display()
        );

        // Try falling back to system rclone
        if is_rclone_available(app.clone(), "") {
            info!("🔄 Rclone is available. Getting the path...");
            self.rclone_path = read_rclone_path(app);
        } else {
            warn!("🔄 Waiting for valid Rclone path...");
            if let Err(e) = app.emit(
                "rclone_engine",
                serde_json::json!({
                    "status": "path_error",
                    "message": "Rclone binary not found",
                }),
            ) {
                error!("Failed to emit event: {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}
