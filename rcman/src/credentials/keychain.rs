//! OS Keychain backend.
//!
//! ## Architecture
//!
//! **macOS**: uses `keyring` v3.6 to avoid dyld crash on macOS 10.14.
//! **Other platforms**: uses `keyring-core` v1 and respective platform-native backends.

use super::CredentialBackend;
use crate::error::{Error, Result};
use log::{debug, warn};
use std::collections::HashSet;
use std::sync::RwLock;

#[cfg(not(target_os = "macos"))]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
use keyring::{Entry, Error as KeyringError};

#[cfg(not(target_os = "macos"))]
use keyring_core::{Entry, Error as KeyringError};

/// OS Keychain backend for secure credential storage
pub struct KeychainBackend {
    service_name: String,
    /// Cache of known keys (keychain doesn't support listing).
    known_keys: RwLock<HashSet<String>>,
    /// Global lock to serialize keychain access on Linux to prevent zbus panics
    #[cfg(target_os = "linux")]
    lock: std::sync::Mutex<()>,
}

impl KeychainBackend {
    /// Create a new keychain backend
    pub fn new(service_name: impl Into<String>) -> Self {
        #[cfg(not(target_os = "macos"))]
        {
            static NATIVE_STORE_INIT: OnceLock<()> = OnceLock::new();
            NATIVE_STORE_INIT.get_or_init(|| {
                // v4/core requires a config HashMap for initialization, even if empty
                let config: std::collections::HashMap<&str, &str> =
                    std::collections::HashMap::new();
                let _ = &config;

                // Force Secret Service (Seahorse/KWallet) on Linux
                #[cfg(target_os = "linux")]
                {
                    match dbus_secret_service_keyring_store::Store::new_with_configuration(&config)
                    {
                        Ok(store) => keyring_core::set_default_store(store),
                        Err(e) => {
                            warn!("Failed to initialize Linux Secret Service keyring store: {e}");
                        }
                    }
                }

                // Native Windows Credential Manager on Windows
                #[cfg(target_os = "windows")]
                {
                    match windows_native_keyring_store::Store::new_with_configuration(&config) {
                        Ok(store) => keyring_core::set_default_store(store),
                        Err(e) => warn!("Failed to initialize Windows native store: {e}"),
                    }
                }
            });
        }

        Self {
            service_name: service_name.into(),
            known_keys: RwLock::new(HashSet::new()),
            #[cfg(target_os = "linux")]
            lock: std::sync::Mutex::new(()),
        }
    }

    fn get_entry(&self, key: &str) -> Result<Entry> {
        Entry::new(&self.service_name, key).map_err(|e| {
            Error::Credential(format!("Failed to create keychain entry for {key}: {e}"))
        })
    }

    fn track_key(&self, key: &str) {
        if let Ok(mut keys) = self.known_keys.write() {
            keys.insert(key.to_string());
        }
    }

    fn untrack_key(&self, key: &str) {
        if let Ok(mut keys) = self.known_keys.write() {
            keys.remove(key);
        }
    }
}

impl CredentialBackend for KeychainBackend {
    fn store(&self, key: &str, value: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        let _guard = self.lock.lock().map_err(|_| Error::LockPoisoned)?;

        self.get_entry(key)?.set_password(value).map_err(|e| {
            Error::Credential(format!("Failed to store credential {key} in keychain: {e}"))
        })?;

        self.track_key(key);
        debug!("Credential stored in keychain: {key}");
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        #[cfg(target_os = "linux")]
        let _guard = self.lock.lock().map_err(|_| Error::LockPoisoned)?;

        match self.get_entry(key)?.get_password() {
            Ok(password) => {
                self.track_key(key);
                debug!("Credential retrieved from keychain: {key}");
                Ok(Some(password))
            }
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => {
                warn!("Failed to retrieve credential {key} from keychain: {e}");
                Err(Error::Credential(format!(
                    "Failed to retrieve credential {key}: {e}"
                )))
            }
        }
    }

    fn remove(&self, key: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        let _guard = self.lock.lock().map_err(|_| Error::LockPoisoned)?;

        match self.get_entry(key)?.delete_credential() {
            Ok(()) => {
                self.untrack_key(key);
                debug!("Credential removed from keychain: {key}");
                Ok(())
            }
            Err(KeyringError::NoEntry) => {
                self.untrack_key(key);
                Ok(())
            }
            Err(e) => Err(Error::Credential(format!(
                "Failed to remove credential {key}: {e}"
            ))),
        }
    }

    /// List all stored credential keys tracked in the current session.
    ///
    /// # Warning
    ///
    /// Since the OS keychain does not support listing/enumerating keys,
    /// this backend only returns keys that have been tracked (created or accessed)
    /// during the lifetime of this `KeychainBackend` instance.
    /// Consequently, keys created in previous runs of the application will not
    /// be returned by this method until they are accessed again.
    fn list_keys(&self) -> Result<Vec<String>> {
        self.known_keys
            .read()
            .map(|keys| keys.iter().cloned().collect())
            .map_err(|_| Error::LockPoisoned)
    }

    fn backend_name(&self) -> &'static str {
        "keychain"
    }
}
