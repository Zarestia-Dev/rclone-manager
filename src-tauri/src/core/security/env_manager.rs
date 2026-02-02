const LOCAL_BACKEND_KEY: &str = "backend:Local:config_password";

use crate::core::settings::AppSettingsManager;
use log::{debug, info};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Thread-safe environment variable manager
#[derive(Debug, Clone)]
pub struct SafeEnvironmentManager {
    env_vars: Arc<Mutex<HashMap<String, String>>>,
}

impl SafeEnvironmentManager {
    pub fn new() -> Self {
        Self {
            env_vars: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Initialize with stored credentials from rcman
    #[cfg(desktop)]
    pub fn init_with_stored_credentials(&self, manager: &AppSettingsManager) -> Result<(), String> {
        // Only try to load if credentials are supported
        if let Some(creds) = manager.credentials() {
            // Strict Unified Key Check
            match creds.get(LOCAL_BACKEND_KEY) {
                Ok(Some(password)) => {
                    self.set_config_password(password);
                    info!(
                        "✅ Initialized SafeEnvironmentManager with stored credentials from rcman"
                    );
                    Ok(())
                }
                Ok(None) => {
                    debug!("No stored credentials found during initialization");
                    Ok(())
                }
                Err(e) => {
                    // Just log warning, don't fail startup
                    debug!("Failed to check stored credentials: {}", e);
                    Ok(())
                }
            }
        } else {
            debug!("Credential storage not available in rcman");
            Ok(())
        }
    }

    /// Initialize with stored credentials (mobile no-op)
    #[cfg(not(desktop))]
    pub fn init_with_stored_credentials(
        &self,
        _manager: &AppSettingsManager,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Store password in internal safe storage instead of global env
    pub fn set_config_password(&self, password: String) {
        if let Ok(mut env_vars) = self.env_vars.lock() {
            env_vars.insert("RCLONE_CONFIG_PASS".to_string(), password);
            debug!("✅ RCLONE_CONFIG_PASS stored in safe environment manager");
        }
    }

    /// Remove password from internal storage
    pub fn clear_config_password(&self) {
        if let Ok(mut env_vars) = self.env_vars.lock() {
            env_vars.remove("RCLONE_CONFIG_PASS");
            debug!("✅ RCLONE_CONFIG_PASS removed from safe environment manager");
        }
    }

    /// Get all environment variables for spawning rclone process
    pub fn get_env_vars(&self) -> HashMap<String, String> {
        let mut result = HashMap::new();

        // Add our managed variables
        if let Ok(env_vars) = self.env_vars.lock() {
            result.extend(env_vars.clone());
        }

        // Add system rclone env vars (excluding our managed ones)
        for (key, value) in std::env::vars() {
            if key.starts_with("RCLONE_") && !result.contains_key(&key) {
                result.insert(key, value);
            }
        }

        result
    }
}

impl Default for SafeEnvironmentManager {
    fn default() -> Self {
        Self::new()
    }
}
