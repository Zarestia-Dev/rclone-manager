use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::AppHandle;

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
        if let Some(last_attempt) = self.last_attempt 
            && self.failed_attempts >= self.max_attempts {
                let elapsed = last_attempt.elapsed();
                return elapsed < self.lockout_duration;
            }
        
        false
    }

    /// Get remaining lockout time
    pub fn remaining_lockout_time(&self) -> Option<Duration> {
        if let Some(last_attempt) = self.last_attempt && self.failed_attempts >= self.max_attempts {
            let elapsed = last_attempt.elapsed();
            if elapsed < self.lockout_duration {
                return Some(self.lockout_duration - elapsed);
            }
        }
        None
    }

    /// Record a failed password attempt
    pub fn record_failure(&mut self) {
        self.failed_attempts += 1;
        self.last_attempt = Some(Instant::now());
        
        warn!("❌ Password attempt failed ({}/{})", self.failed_attempts, self.max_attempts);
    
        
        if self.is_locked_out() {
            error!("🔒 Account locked out for {} seconds", self.lockout_duration.as_secs());
        }
    }

    /// Record a successful password attempt
    pub fn record_success(&mut self) {
        info!("✅ Password validation successful");
        self.failed_attempts = 0;
        self.last_attempt = None;
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
