//! Credential types

use serde::{Deserialize, Serialize};

/// Where to store secret values
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretStorage {
    /// Store in OS keychain (default, most secure)
    #[default]
    Keychain,

    /// Store encrypted in settings file (portable)
    EncryptedFile,

    /// Store in memory only (session-only, not persisted)
    Memory,

    /// Store as plaintext in file (not recommended, for debugging)
    Plaintext,
}

/// How to handle secrets in backups
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackupPolicy {
    /// Never include secrets in backup (safest)
    #[default]
    Exclude,

    /// Include only if backup is encrypted with password
    EncryptedOnly,

    /// Always include (requires explicit confirmation from developer)
    Include,
}

/// Configuration for the credential manager
#[derive(Debug, Clone)]
pub struct CredentialConfig {
    /// Service name for keychain entries
    pub service_name: String,

    /// Default storage for secrets
    pub default_storage: SecretStorage,

    /// Path for encrypted file fallback
    pub fallback_path: Option<std::path::PathBuf>,

    /// Whether to auto-fallback to encrypted file if keychain fails
    pub auto_fallback: bool,
}

impl Default for CredentialConfig {
    fn default() -> Self {
        Self {
            service_name: "rcman".into(),
            default_storage: SecretStorage::Keychain,
            fallback_path: None,
            auto_fallback: true,
        }
    }
}

impl CredentialConfig {
    /// Create with a custom service name
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            ..Default::default()
        }
    }

    /// Set fallback path for encrypted file storage
    pub fn with_fallback(mut self, path: std::path::PathBuf) -> Self {
        self.fallback_path = Some(path);
        self
    }

    /// Disable auto-fallback
    pub fn no_fallback(mut self) -> Self {
        self.auto_fallback = false;
        self
    }
}
