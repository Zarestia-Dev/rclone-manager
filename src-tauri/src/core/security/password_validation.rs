use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::core::check_binaries::read_rclone_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordValidationResult {
    pub is_valid: bool,
    pub error_type: Option<PasswordErrorType>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PasswordErrorType {
    WrongPassword,
    EmptyPassword,
    WeakPassword,
    ConnectionFailed,
    Timeout,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct PasswordValidator {
    max_attempts: u32,
    lockout_duration: Duration,
    failed_attempts: u32,
    last_attempt: Option<Instant>,
}

impl Default for PasswordValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl PasswordValidator {
    pub fn new() -> Self {
        Self {
            max_attempts: 3,
            lockout_duration: Duration::from_secs(300), // 5 minutes
            failed_attempts: 0,
            last_attempt: None,
        }
    }

    /// Get the number of failed attempts
    pub fn failed_attempts(&self) -> u32 {
        self.failed_attempts
    }

    /// Get the maximum allowed attempts
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    /// Check if we're currently in lockout period
    pub fn is_locked_out(&self) -> bool {
        if let Some(last_attempt) = self.last_attempt {
            if self.failed_attempts >= self.max_attempts {
                let elapsed = last_attempt.elapsed();
                return elapsed < self.lockout_duration;
            }
        }
        false
    }

    /// Get remaining lockout time
    pub fn remaining_lockout_time(&self) -> Option<Duration> {
        if let Some(last_attempt) = self.last_attempt {
            if self.failed_attempts >= self.max_attempts {
                let elapsed = last_attempt.elapsed();
                if elapsed < self.lockout_duration {
                    return Some(self.lockout_duration - elapsed);
                }
            }
        }
        None
    }

    /// Record a failed password attempt
    pub fn record_failure(&mut self, app: &AppHandle) {
        self.failed_attempts += 1;
        self.last_attempt = Some(Instant::now());
        
        warn!("❌ Password attempt failed ({}/{})", self.failed_attempts, self.max_attempts);
        
        // Emit event to UI
        let _ = app.emit("password_attempt_failed", serde_json::json!({
            "attempts": self.failed_attempts,
            "max_attempts": self.max_attempts,
            "locked_out": self.is_locked_out(),
            "lockout_remaining": self.remaining_lockout_time().map(|d| d.as_secs())
        }));
        
        if self.is_locked_out() {
            error!("🔒 Account locked out for {} seconds", self.lockout_duration.as_secs());
            let _ = app.emit("password_lockout", serde_json::json!({
                "lockout_duration": self.lockout_duration.as_secs(),
                "remaining": self.remaining_lockout_time().map(|d| d.as_secs())
            }));
        }
    }

    /// Record a successful password attempt
    pub fn record_success(&mut self, app: &AppHandle) {
        info!("✅ Password validation successful");
        self.failed_attempts = 0;
        self.last_attempt = None;
        
        // Emit success event to UI
        let _ = app.emit("password_validation_success", serde_json::json!({
            "success": true
        }));
    }

    /// Reset the failure counter (e.g., after lockout period)
    pub fn reset(&mut self) {
        debug!("🔄 Resetting password validation state");
        self.failed_attempts = 0;
        self.last_attempt = None;
    }
}

/// Test if a password works with rclone by attempting to connect
pub async fn test_rclone_password(app: &AppHandle, password: &str) -> PasswordValidationResult {

    let rclone_path = read_rclone_path(app);

    // Try to run a simple rclone command to test the password, setting the env var only for this process
    let result = tokio::process::Command::new(rclone_path)
        .args(["listremotes"])
        .env("RCLONE_CONFIG_PASS", password)
        .output()
        .await;

    match result {
        Ok(output) => {
            if output.status.success() {
                info!("✅ Password validation successful");
                PasswordValidationResult {
                    is_valid: true,
                    error_type: None,
                    message: "Password is valid".to_string(),
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!("❌ Password validation failed: {stderr}");
                
                if stderr.contains("wrong password") || stderr.contains("decrypt") {
                    PasswordValidationResult {
                        is_valid: false,
                        error_type: Some(PasswordErrorType::WrongPassword),
                        message: "Incorrect password for rclone configuration".to_string(),
                    }
                } else {
                    PasswordValidationResult {
                        is_valid: false,
                        error_type: Some(PasswordErrorType::Unknown),
                        message: format!("Rclone error: {stderr}"),
                    }
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to execute rclone: {e}");
            PasswordValidationResult {
                is_valid: false,
                error_type: Some(PasswordErrorType::ConnectionFailed),
                message: format!("Failed to test password: {e}"),
            }
        }
    }
}

/// Detect rclone password errors from process output
pub fn detect_password_error(output: &str) -> Option<PasswordErrorType> {
    let output_lower = output.to_lowercase();
    
    if output_lower.contains("bad password") || output_lower.contains("no characters in password") {
        Some(PasswordErrorType::EmptyPassword)
    } else if output_lower.contains("wrong password") || output_lower.contains("decrypt") {
        Some(PasswordErrorType::WrongPassword)
    } else if output_lower.contains("timeout") {
        Some(PasswordErrorType::Timeout)
    } else if output_lower.contains("connection") && output_lower.contains("failed") {
        Some(PasswordErrorType::ConnectionFailed)
    } else {
        None
    }
}

/// Generate a user-friendly error message for password errors
pub fn get_password_error_message(error_type: &PasswordErrorType) -> String {
    match error_type {
        PasswordErrorType::WrongPassword => {
            "The password you entered is incorrect. Please check your rclone configuration password and try again.".to_string()
        }
        PasswordErrorType::EmptyPassword => {
            "Password cannot be empty. Please enter your rclone configuration password.".to_string()
        }
        PasswordErrorType::WeakPassword => {
            "The password is too weak. Please use a stronger password with at least 8 characters.".to_string()
        }
        PasswordErrorType::ConnectionFailed => {
            "Failed to connect to rclone. Please check if rclone is properly installed and accessible.".to_string()
        }
        PasswordErrorType::Timeout => {
            "Password validation timed out. Please try again.".to_string()
        }
        PasswordErrorType::Unknown => {
            "An unknown error occurred during password validation. Please check the logs for more details.".to_string()
        }
    }
}
