use keyring::{Entry, Error as KeyringError};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const SERVICE_NAME: &str = "rclone-manager";
const CONFIG_PASSWORD_KEY: &str = "rclone_config_password";

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
        
        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)
            .map_err(CredentialError::from)?;
        
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
        
        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)
            .map_err(CredentialError::from)?;
        
        
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
        
        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)
            .map_err(|e| {
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

    // /// Store multiple credentials (for future expansion)
    // pub fn store_credential(&self, key: &str, value: &str) -> Result<(), CredentialError> {
    //     debug!("Storing credential: {}", key);
        
    //     let entry = Entry::new(&self.service_name, key)
    //         .map_err(CredentialError::from)?;
        
    //     entry.set_password(value).map_err(|e| {
    //         error!("Failed to store credential {}: {}", key, e);
    //         CredentialError::from(e)
    //     })?;
        
    //     info!("✅ Credential '{}' stored securely", key);
    //     Ok(())
    // }

    // /// Retrieve a specific credential
    // pub fn get_credential(&self, key: &str) -> Result<String, CredentialError> {
    //     debug!("Retrieving credential: {}", key);
        
    //     let entry = Entry::new(&self.service_name, key)
    //         .map_err(CredentialError::from)?;
        
    //     match entry.get_password() {
    //         Ok(value) => {
    //             debug!("✅ Credential '{}' retrieved successfully", key);
    //             Ok(value)
    //         }
    //         Err(e) => {
    //             warn!("Failed to retrieve credential {}: {}", key, e);
    //             Err(CredentialError::from(e))
    //         }
    //     }
    // }

    // /// List all stored credential keys (for management)
    // pub fn list_credentials(&self) -> Vec<String> {
    //     // Note: This is platform-dependent and may not be fully supported
    //     // This is a basic implementation that tries common keys
    //     let common_keys = vec![CONFIG_PASSWORD_KEY];
    //     let mut existing_keys = Vec::new();
        
    //     for key in common_keys {
    //         if let Ok(_) = self.get_credential(key) {
    //             existing_keys.push(key.to_string());
    //         }
    //     }
        
    //     existing_keys
    // }

    // /// Clear all stored credentials
    // pub fn clear_all_credentials(&self) -> Result<(), Vec<CredentialError>> {
    //     info!("Clearing all stored credentials");
    //     let keys = self.list_credentials();
    //     let mut errors = Vec::new();
        
    //     for key in keys {
    //         if let Err(e) = self.remove_credential(&key) {
    //             errors.push(e);
    //         }
    //     }
        
    //     if errors.is_empty() {
    //         info!("✅ All credentials cleared successfully");
    //         Ok(())
    //     } else {
    //         error!("❌ Some credentials failed to clear");
    //         Err(errors)
    //     }
    // }

    // /// Remove a specific credential
    // pub fn remove_credential(&self, key: &str) -> Result<(), CredentialError> {
    //     debug!("Removing credential: {}", key);
        
    //     let entry = Entry::new(&self.service_name, key)
    //         .map_err(CredentialError::from)?;
        
    //     match entry.delete_credential() {
    //         Ok(()) => {
    //             info!("✅ Credential '{}' removed from keyring", key);
    //             Ok(())
    //         }
    //         Err(KeyringError::NoEntry) => {
    //             debug!("Credential '{}' not found (already removed)", key);
    //             Ok(())
    //         }
    //         Err(e) => {
    //             error!("Failed to remove credential {}: {}", key, e);
    //             Err(CredentialError::from(e))
    //         }
    //     }
    // }
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper functions for environment variable management
pub struct EnvironmentManager;

impl EnvironmentManager {
    /// Set the RCLONE_CONFIG_PASS environment variable for the current process
    pub fn set_config_password_env(password: &str) {
        unsafe {
            std::env::set_var("RCLONE_CONFIG_PASS", password);
        }
        debug!("✅ RCLONE_CONFIG_PASS environment variable set");
    }

    /// Remove the RCLONE_CONFIG_PASS environment variable
    pub fn clear_config_password_env() {
        unsafe {
            std::env::remove_var("RCLONE_CONFIG_PASS");
        }
        debug!("✅ RCLONE_CONFIG_PASS environment variable cleared");
    }

    /// Check if RCLONE_CONFIG_PASS is set
    pub fn has_config_password_env() -> bool {
        std::env::var("RCLONE_CONFIG_PASS").is_ok()
    }

    /// Get environment variables needed for rclone process
    pub fn get_rclone_env_vars() -> HashMap<String, String> {
        let mut env_vars = HashMap::new();
        
        // Add RCLONE_CONFIG_PASS if it exists
        if let Ok(password) = std::env::var("RCLONE_CONFIG_PASS") {
            env_vars.insert("RCLONE_CONFIG_PASS".to_string(), password);
        }
        
        // Add other rclone-related environment variables if needed
        for (key, value) in std::env::vars() {
            if key.starts_with("RCLONE_") {
                env_vars.insert(key, value);
            }
        }
        
        env_vars
    }
}
