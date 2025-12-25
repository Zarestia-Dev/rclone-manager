//! Credential management module
//!
//! Provides secure storage for sensitive values with multiple backends:
//! - **Keychain**: OS-level secure storage (recommended) - requires `keychain` feature
//! - **Encrypted File**: Encrypted JSON fallback for CI/Docker - requires `encrypted-file` feature
//! - **Memory**: In-memory only for testing

#[cfg(feature = "encrypted-file")]
mod encrypted;
#[cfg(feature = "keychain")]
mod keychain;
mod memory;
mod types;

#[cfg(feature = "encrypted-file")]
pub use encrypted::EncryptedFileBackend;
#[cfg(feature = "keychain")]
pub use keychain::KeychainBackend;
pub use memory::MemoryBackend;
pub use types::*;

use crate::error::Result;
use std::sync::Arc;

/// Trait for credential storage backends
pub trait CredentialBackend: Send + Sync {
    /// Store a credential
    fn store(&self, key: &str, value: &str) -> Result<()>;

    /// Retrieve a credential
    fn get(&self, key: &str) -> Result<Option<String>>;

    /// Remove a credential
    fn remove(&self, key: &str) -> Result<()>;

    /// Check if a credential exists
    fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.get(key)?.is_some())
    }

    /// List all stored credential keys
    fn list_keys(&self) -> Result<Vec<String>>;

    /// Backend name for logging/debugging
    fn backend_name(&self) -> &'static str;
}

/// Credential manager with configurable backend and fallback
pub struct CredentialManager {
    /// Primary backend (typically keychain)
    primary: Arc<dyn CredentialBackend>,

    /// Fallback backend (typically encrypted file)
    fallback: Option<Arc<dyn CredentialBackend>>,

    /// Service name for keychain
    service_name: String,
}

impl CredentialManager {
    /// Create a new credential manager with keychain backend
    #[cfg(feature = "keychain")]
    pub fn new(service_name: impl Into<String>) -> Self {
        let service = service_name.into();
        Self {
            primary: Arc::new(KeychainBackend::new(service.clone())),
            fallback: None,
            service_name: service,
        }
    }

    /// Create a new credential manager with memory backend (when keychain feature is disabled)
    #[cfg(not(feature = "keychain"))]
    pub fn new(service_name: impl Into<String>) -> Self {
        Self::memory_only(service_name)
    }

    /// Create with automatic fallback to encrypted file
    #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
    pub fn with_fallback(
        service_name: impl Into<String>,
        fallback_path: std::path::PathBuf,
        encryption_key: &[u8; 32],
    ) -> Self {
        let service = service_name.into();

        // For fallback, we need to handle salt manually since we already have the key
        let salt = EncryptedFileBackend::read_salt(&fallback_path)
            .ok()
            .flatten()
            .unwrap_or_else(EncryptedFileBackend::generate_salt);

        let fallback = EncryptedFileBackend::new(fallback_path, encryption_key, salt).ok();

        Self {
            primary: Arc::new(KeychainBackend::new(service.clone())),
            fallback: fallback.map(|f| Arc::new(f) as Arc<dyn CredentialBackend>),
            service_name: service,
        }
    }

    /// Create with only memory backend (for testing)
    pub fn memory_only(service_name: impl Into<String>) -> Self {
        Self {
            primary: Arc::new(MemoryBackend::new()),
            fallback: None,
            service_name: service_name.into(),
        }
    }

    /// Create with custom backend
    pub fn with_backend(
        service_name: impl Into<String>,
        backend: Arc<dyn CredentialBackend>,
    ) -> Self {
        Self {
            primary: backend,
            fallback: None,
            service_name: service_name.into(),
        }
    }

    /// Store a credential
    pub fn store(&self, key: &str, value: &str) -> Result<()> {
        let full_key = self.make_key(key);

        match self.primary.store(&full_key, value) {
            Ok(()) => {
                log::debug!(
                    "Stored credential '{}' in {}",
                    key,
                    self.primary.backend_name()
                );
                Ok(())
            }
            Err(e) => {
                if let Some(ref fallback) = self.fallback {
                    log::warn!(
                        "Primary backend failed, using fallback: {}",
                        self.fallback.as_ref().unwrap().backend_name()
                    );
                    fallback.store(&full_key, value)
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Retrieve a credential
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let full_key = self.make_key(key);

        // Try primary first
        match self.primary.get(&full_key) {
            Ok(Some(value)) => return Ok(Some(value)),
            Ok(None) => {}
            Err(e) => {
                log::debug!("Primary backend error: {}", e);
            }
        }

        // Try fallback if available
        if let Some(ref fallback) = self.fallback {
            return fallback.get(&full_key);
        }

        Ok(None)
    }

    /// Remove a credential
    pub fn remove(&self, key: &str) -> Result<()> {
        let full_key = self.make_key(key);

        // Remove from both backends
        let _ = self.primary.remove(&full_key);
        if let Some(ref fallback) = self.fallback {
            let _ = fallback.remove(&full_key);
        }

        Ok(())
    }

    /// Check if a credential exists
    pub fn exists(&self, key: &str) -> bool {
        let full_key = self.make_key(key);

        if self.primary.exists(&full_key).unwrap_or(false) {
            return true;
        }

        if let Some(ref fallback) = self.fallback {
            return fallback.exists(&full_key).unwrap_or(false);
        }

        false
    }

    /// Get service name
    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    /// Get active backend name
    pub fn backend_name(&self) -> &'static str {
        self.primary.backend_name()
    }

    fn make_key(&self, key: &str) -> String {
        format!("{}:{}", self.service_name, key)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_backend_crud() {
        let manager = CredentialManager::memory_only("test-app");

        // Store
        manager.store("api_key", "secret123").unwrap();
        assert!(manager.exists("api_key"));

        // Get
        let value = manager.get("api_key").unwrap();
        assert_eq!(value, Some("secret123".to_string()));

        // Remove
        manager.remove("api_key").unwrap();
        assert!(!manager.exists("api_key"));
    }

    #[test]
    fn test_credential_not_found() {
        let manager = CredentialManager::memory_only("test-app");
        let value = manager.get("nonexistent").unwrap();
        assert_eq!(value, None);
    }
}
