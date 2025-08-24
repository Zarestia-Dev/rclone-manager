use keyring::{Entry, Error as KeyringError};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
// no longer using Arc/Mutex in this module

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

// SafeEnvironmentManager removed – runtime RC unlock replaces env propagation
