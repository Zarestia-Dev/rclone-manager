use crate::core::settings::AppSettingsManager;
use log::{debug, info};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Thread-safe environment variable manager
#[derive(Debug, Clone)]
pub struct SafeEnvironmentManager {
    config_password: Arc<Mutex<Option<String>>>,
}

impl SafeEnvironmentManager {
    pub fn new() -> Self {
        Self {
            config_password: Arc::new(Mutex::new(None)),
        }
    }

    /// Initialize with stored credentials from rcman
    pub fn init_with_stored_credentials(&self, manager: &AppSettingsManager) -> Result<(), String> {
        match manager.sub_settings("connections") {
            Ok(connections) => match connections.get_value("Local") {
                Ok(local) => {
                    if let Some(password) = local.get("config_password").and_then(|v| v.as_str())
                        && !password.is_empty()
                    {
                        self.set_config_password(password.to_string());
                        info!(
                            "✅ Initialized SafeEnvironmentManager with stored credentials from rcman"
                        );
                    } else {
                        debug!("No stored credentials found during initialization");
                    }
                    Ok(())
                }
                Err(e) => {
                    debug!("Failed to load Local connection settings: {}", e);
                    Ok(())
                }
            },
            Err(e) => {
                debug!("Failed to access connections sub-settings: {}", e);
                Ok(())
            }
        }
    }

    /// Store password in internal safe storage instead of global env
    pub fn set_config_password(&self, password: String) {
        if let Ok(mut lock) = self.config_password.lock() {
            *lock = Some(password);
            debug!("✅ RCLONE_CONFIG_PASS stored in safe environment manager");
        }
    }

    /// Remove password from internal storage
    pub fn clear_config_password(&self) {
        if let Ok(mut lock) = self.config_password.lock() {
            *lock = None;
            debug!("✅ RCLONE_CONFIG_PASS removed from safe environment manager");
        }
    }

    /// Get all environment variables for spawning rclone process
    pub fn get_env_vars(&self) -> HashMap<String, String> {
        let mut result = HashMap::new();

        // Add our managed variables
        if let Ok(lock) = self.config_password.lock()
            && let Some(password) = lock.as_ref()
        {
            result.insert("RCLONE_CONFIG_PASS".to_string(), password.clone());
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
