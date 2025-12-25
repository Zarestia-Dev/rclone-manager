//! OS Keychain backend using keyring crate

use super::CredentialBackend;
use crate::error::{Error, Result};
use keyring::Entry;
use log::{debug, warn};
use std::sync::RwLock;

/// OS Keychain backend for secure credential storage
pub struct KeychainBackend {
    service_name: String,
    /// Cache of known keys (keychain doesn't support listing)
    known_keys: RwLock<Vec<String>>,
}

impl KeychainBackend {
    /// Create a new keychain backend
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            known_keys: RwLock::new(Vec::new()),
        }
    }

    fn get_entry(&self, key: &str) -> Result<Entry> {
        Entry::new(&self.service_name, key)
            .map_err(|e| Error::Credential(format!("Failed to create keychain entry: {}", e)))
    }

    fn track_key(&self, key: &str) {
        if let Ok(mut keys) = self.known_keys.write() {
            if !keys.contains(&key.to_string()) {
                keys.push(key.to_string());
            }
        }
    }

    fn untrack_key(&self, key: &str) {
        if let Ok(mut keys) = self.known_keys.write() {
            keys.retain(|k| k != key);
        }
    }
}

impl CredentialBackend for KeychainBackend {
    fn store(&self, key: &str, value: &str) -> Result<()> {
        let entry = self.get_entry(key)?;

        entry.set_password(value).map_err(|e| {
            Error::Credential(format!("Failed to store credential in keychain: {}", e))
        })?;

        self.track_key(key);
        debug!("✅ Credential stored in keychain: {}", key);
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        let entry = self.get_entry(key)?;

        match entry.get_password() {
            Ok(password) => {
                debug!("✅ Credential retrieved from keychain: {}", key);
                Ok(Some(password))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => {
                warn!("Failed to retrieve credential from keychain: {}", e);
                Err(Error::Credential(format!(
                    "Failed to retrieve credential: {}",
                    e
                )))
            }
        }
    }

    fn remove(&self, key: &str) -> Result<()> {
        let entry = self.get_entry(key)?;

        match entry.delete_credential() {
            Ok(()) => {
                self.untrack_key(key);
                debug!("✅ Credential removed from keychain: {}", key);
                Ok(())
            }
            Err(keyring::Error::NoEntry) => {
                self.untrack_key(key);
                Ok(()) // Already gone
            }
            Err(e) => Err(Error::Credential(format!(
                "Failed to remove credential: {}",
                e
            ))),
        }
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        // Keychain doesn't support listing, return tracked keys
        Ok(self
            .known_keys
            .read()
            .map(|k| k.clone())
            .unwrap_or_default())
    }

    fn backend_name(&self) -> &'static str {
        "keychain"
    }
}
