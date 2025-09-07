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
                        let error_msg = "Wrong password for encrypted rclone configuration";
                        error!("❌ {}", error_msg);
                        Err(error_msg.to_string())
                    } else if stderr.contains("Failed to load config file") {
                        let error_msg =
                            format!("Failed to load rclone config file: {}", stderr.trim());
                        error!("❌ {}", error_msg);
                        Err(error_msg)
                    } else if stderr.contains("CRITICAL:")
                        && stderr.contains("using RCLONE_CONFIG_PASS env password")
                    {
                        let error_msg = "Invalid environment password for encrypted configuration";
                        error!("❌ {}", error_msg);
                        Err(error_msg.to_string())
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
                // If we're here, the command timed out. This could mean:
                // 1. The process is waiting for password input despite having RCLONE_CONFIG_PASS
                // 2. The config requires interactive input for some other reason
                // 3. The process is hanging for an unknown reason

                // Let's check if it's specifically waiting for password input
                let is_waiting = self.is_waiting_for_password_input().await;

                if is_waiting {
                    warn!(
                        "🔒 rclone is waiting for password input despite having RCLONE_CONFIG_PASS - likely wrong password format"
                    );
                    Err("Encrypted configuration requires interactive password input - RCLONE_CONFIG_PASS might be in wrong format".to_string())
                } else {
                    warn!("⏱️ rclone listremotes timed out - unexpected delay");
                    Err("Rclone command timed out unexpectedly".to_string())
                }
            }
        }
    }

    /// Quick check if configuration is encrypted without requiring password
    pub async fn is_config_encrypted(&self, _app: &AppHandle) -> bool {
        debug!("🔍 Checking if rclone configuration is encrypted...");

        if !self.rclone_path.exists() {
            warn!("Rclone binary not found, assuming config is not encrypted");
            return false;
        }

        // First method: Try direct check with encryption check command
        let is_encrypted = self.check_encryption_status().await;

        // If we got a definitive answer, return it
        if let Some(encrypted) = is_encrypted {
            return encrypted;
        }

        // Second method: Use a more reliable approach by checking for password prompt
        let is_waiting_for_password = self.is_waiting_for_password_input().await;

        if is_waiting_for_password {
            debug!("🔒 Detected password prompt, configuration is encrypted");
            return true;
        }

        // Default to false - if we can't detect encryption and no password prompt, assume not encrypted
        debug!("✅ No encryption or password prompt detected, assuming not encrypted");
        false
    }

    /// Direct check for encryption status using rclone command
    async fn check_encryption_status(&self) -> Option<bool> {
        let mut cmd = tokio::process::Command::new(&self.rclone_path);
        cmd.args(["config", "encryption", "check"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("RCLONE_CONFIG_PASS"); // Don't use any password for this check

        let result = time::timeout(std::time::Duration::from_secs(1), cmd.output()).await;

        match result {
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                debug!("rclone config encryption check stderr: {}", stderr.trim());

                // Definitive case: NOT encrypted
                if !output.status.success() && stderr.contains("config file is NOT encrypted") {
                    debug!("✅ Configuration is explicitly NOT encrypted");
                    return Some(false);
                }

                // Definitive case: IS encrypted (some versions explicitly say this)
                if stderr.contains("config file is encrypted") {
                    debug!("🔒 Configuration is explicitly encrypted");
                    return Some(true);
                }

                // Inconclusive - need to try other methods
                None
            }
            _ => None, // Any error or timeout is inconclusive
        }
    }

    /// Check if rclone is waiting for password input by monitoring the process
    async fn is_waiting_for_password_input(&self) -> bool {
        debug!("🔍 Checking if rclone is waiting for password input...");

        let mut cmd = tokio::process::Command::new(&self.rclone_path);
        cmd.args(["listremotes"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("RCLONE_CONFIG_PASS"); // Ensure no password is provided

        // Start the process
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                warn!("Failed to spawn rclone process: {}", e);
                return false;
            }
        };

        // Quick check - if the process exits immediately with success, it's not encrypted
        match time::timeout(std::time::Duration::from_millis(100), child.wait()).await {
            Ok(Ok(status)) => {
                if status.success() {
                    debug!("✅ Process exited successfully immediately - not waiting for password");
                    return false;
                }
            }
            _ => {
                // Process is still running or exited with error - continue checking
            }
        }

        // Check if stderr contains password prompt
        // This needs to be done with care as we don't want to block
        if let Some(stderr) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let mut stderr_reader = tokio::io::BufReader::new(stderr);
            let mut stderr_buf = Vec::new();

            // Read a limited amount with timeout
            match time::timeout(
                std::time::Duration::from_millis(500),
                stderr_reader.read_to_end(&mut stderr_buf),
            )
            .await
            {
                Ok(_) => {
                    let stderr_str = String::from_utf8_lossy(&stderr_buf);
                    debug!("Stderr content: {}", stderr_str.trim());

                    if stderr_str.contains("Enter configuration password:")
                        || stderr_str.contains("password:")
                    {
                        debug!("🔒 Password prompt detected in stderr");

                        // Kill the process since we detected what we needed
                        let _ = child.kill().await;
                        return true;
                    }
                }
                Err(_) => {
                    // Timeout reading stderr - this often happens when waiting for password
                    debug!("⏱️ Timeout reading stderr - likely waiting for input");
                }
            }
        }

        // Final check - if the process is still running after all these checks,
        // it's very likely waiting for password input
        let is_still_running = match child.try_wait() {
            Ok(None) => true,     // Process still running
            Ok(Some(_)) => false, // Process exited
            Err(_) => false,      // Error checking process status
        };

        if is_still_running {
            debug!("🔒 Process still running and waiting for input - likely password prompt");
            // Kill the process since we're done with it
            let _ = child.kill().await;
            return true;
        }

        debug!("✅ No password prompt detected");
        false
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
                self.password_error = true;

                // Provide a more user-friendly message based on the error
                let user_message = if e.contains("Wrong password")
                    || e.contains("Invalid environment password")
                {
                    "The password for your encrypted rclone configuration is incorrect. Please update your password."
                } else if e.contains("no password is available") {
                    "Your rclone configuration is encrypted but no password was provided. Please set a password."
                } else if e.contains("Failed to load rclone config file") {
                    "Could not load your rclone configuration file. It may be corrupted or missing."
                } else if e.contains("Rclone binary not found") {
                    "Rclone executable was not found. Please ensure rclone is installed correctly."
                } else {
                    &e // Use the original error message
                };

                if let Err(emit_err) = app.emit(
                    "rclone_engine",
                    serde_json::json!({
                        "status": "password_error",
                        "message": user_message
                    }),
                ) {
                    error!("Failed to emit password error event: {emit_err}");
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
