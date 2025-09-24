use keyring::Entry;
use log::{debug, error, info, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::utils::types::all_types::{CONFIG_PASSWORD_KEY, SERVICE_NAME};

/// Thread-safe environment variable manager
#[derive(Debug, Clone)]
pub struct SafeEnvironmentManager {
    env_vars: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone)]
pub struct CredentialStore {
    service_name: String,
}

impl CredentialStore {
    pub fn new() -> Self {
        Self {
            service_name: SERVICE_NAME.to_string(),
        }
    }

    /// Store the rclone config password securely
    pub fn store_config_password(&self, password: &str) -> Result<(), keyring::Error> {
        debug!("Storing rclone config password in system keyring");

        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)?;

        entry.set_password(password).map_err(|e| {
            error!("Failed to store password: {}", e);
            e
        })?;

        info!("✅ Rclone config password stored securely");
        Ok(())
    }

    /// Retrieve the rclone config password from secure storage
    pub fn get_config_password(&self) -> Result<String, keyring::Error> {
        debug!("Retrieving rclone config password from system keyring");

        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)?;

        match entry.get_password() {
            Ok(password) => {
                debug!("✅ Rclone config password retrieved successfully");
                Ok(password)
            }
            Err(keyring::Error::NoEntry) => Err(keyring::Error::NoEntry),
            Err(e) => {
                warn!("Failed to retrieve password: {}", e);
                Err(e)
            }
        }
    }

    /// Remove the stored rclone config password
    pub fn remove_config_password(&self) -> Result<(), keyring::Error> {
        debug!("Removing rclone config password from system keyring");

        let entry = Entry::new(&self.service_name, CONFIG_PASSWORD_KEY)?;

        match entry.delete_credential() {
            Ok(()) => {
                info!("✅ Rclone config password removed from keyring");
                Ok(())
            }
            Err(keyring::Error::NoEntry) => {
                debug!("Password entry not found (already removed)");
                Ok(())
            }
            Err(e) => {
                error!("Failed to remove password: {}", e);
                Err(e)
            }
        }
    }

    /// Check if a config password is stored
    pub fn has_config_password(&self) -> bool {
        self.get_config_password().is_ok()
    }
}

/// Thread-safe environment manager that doesn't use global env vars
impl SafeEnvironmentManager {
    pub fn new() -> Self {
        Self {
            env_vars: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Initialize with stored credentials from CredentialStore
    pub fn init_with_stored_credentials(
        &self,
        credential_store: &CredentialStore,
    ) -> Result<(), String> {
        match credential_store.get_config_password() {
            Ok(password) => {
                self.set_config_password(password);
                info!("✅ Initialized SafeEnvironmentManager with stored credentials");
                Ok(())
            }
            Err(_) => {
                debug!("No stored credentials found during initialization");
                Ok(())
            }
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
        self.env_vars
            .lock()
            .map(|env_vars| env_vars.contains_key("RCLONE_CONFIG_PASS"))
            .unwrap_or(false)
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

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for SafeEnvironmentManager {
    fn default() -> Self {
        Self::new()
    }
}
