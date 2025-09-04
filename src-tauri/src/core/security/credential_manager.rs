use keyring::{Entry, Error as KeyringError};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const SERVICE_NAME: &str = "rclone-manager";
const CONFIG_PASSWORD_KEY: &str = "rclone_config_password";

/// Thread-safe environment variable manager
#[derive(Debug, Clone)]
pub struct SafeEnvironmentManager {
    env_vars: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialStore {
    service_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CredentialError {
    KeyringError(String),
    NotFound,
    InvalidPassword,
    AccessDenied,
    Unknown(String),
}

impl From<KeyringError> for CredentialError {
    fn from(error: KeyringError) -> Self {
        match error {
            KeyringError::NoEntry => CredentialError::NotFound,
            KeyringError::BadEncoding(_) => CredentialError::InvalidPassword,
            KeyringError::PlatformFailure(err) => {
                error!("Platform keyring failure: {}", err);
                CredentialError::KeyringError(err.to_string())
            }
            _ => CredentialError::Unknown(error.to_string()),
        }
    }
}

impl CredentialStore {
    pub fn new() -> Self {
        Self {
            service_name: SERVICE_NAME.to_string(),
        }
    }

    /// Store the rclone config password securely
    pub fn store_config_password(&self, password: &str) -> Result<(), CredentialError> {
        debug!("Storing rclone config password in system keyring");

        let entry =
            Entry::new(&self.service_name, CONFIG_PASSWORD_KEY).map_err(CredentialError::from)?;

        entry.set_password(password).map_err(|e| {
            error!("Failed to store password: {}", e);
            CredentialError::from(e)
        })?;

        info!("✅ Rclone config password stored securely");
        Ok(())
    }

    /// Retrieve the rclone config password from secure storage
    pub fn get_config_password(&self) -> Result<String, CredentialError> {
        debug!("Retrieving rclone config password from system keyring");

        let entry =
            Entry::new(&self.service_name, CONFIG_PASSWORD_KEY).map_err(CredentialError::from)?;

        match entry.get_password() {
            Ok(password) => {
                debug!("✅ Rclone config password retrieved successfully");
                Ok(password)
            }
            Err(e) => {
                warn!("Failed to retrieve password: {}", e);
                Err(CredentialError::from(e))
            }
        }
    }

    /// Remove the stored rclone config password
    pub fn remove_config_password(&self) -> Result<(), String> {
        debug!("Removing rclone config password from system keyring");

        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY).map_err(|e| {
            error!("Failed to create keyring entry: {}", e);
            e.to_string()
        })?;

        match entry.delete_credential() {
            Ok(()) => {
                info!("✅ Rclone config password removed from keyring");
                Ok(())
            }
            Err(KeyringError::NoEntry) => {
                debug!("Password entry not found (already removed)");
                Ok(())
            }
            Err(e) => {
                error!("Failed to remove password: {}", e);
                Err(e.to_string())
            }
        }
    }

    /// Check if a config password is stored
    pub fn has_config_password(&self) -> bool {
        match self.get_config_password() {
            Ok(_) => true,
            Err(CredentialError::NotFound) => false,
            Err(e) => {
                warn!("Error checking for stored password: {:?}", e);
                false
            }
        }
    }
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Thread-safe environment manager that doesn't use global env vars
impl SafeEnvironmentManager {
    pub fn new() -> Self {
        Self {
            env_vars: Arc::new(Mutex::new(HashMap::new())),
        }
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

    /// Check if password is stored
    pub fn has_config_password(&self) -> bool {
        if let Ok(env_vars) = self.env_vars.lock() {
            env_vars.contains_key("RCLONE_CONFIG_PASS")
        } else {
            false
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
