use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
    /// Useful for testing or secrets that should not survive app restart.
    Memory,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackupPolicy {
    /// Never include secrets in backup (default)
    ///
    /// Secrets will be redacted (set to null) in the export.
    #[default]
    Exclude,

    /// Include secrets only if backup is encrypted
    ///
    /// Safe option: secrets are included but protected by the backup password.
    /// If no password is provided, this falls back to `Exclude`.
    EncryptedOnly,

    /// Always include secrets (Unsafe)
    ///
    /// Secrets will be included in plaintext if backup is not encrypted.
    /// Use with caution.
    Include,
}

/// Source for the master password used to unlock encrypted credential files
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretPasswordSource {
    /// Read password from an environment variable
    Environment(String),
    /// Read password from a file (e.g. Docker secrets /run/secrets/...)
    File(PathBuf),
    /// Provided directly by the application at runtime (e.g. from UI)
    Provided(String),
}

impl SecretPasswordSource {
    /// Resolve the password string from the configured source
    ///
    /// # Errors
    /// Returns error if environment variable is missing or file cannot be read.
    pub fn resolve(&self) -> crate::Result<String> {
        match self {
            Self::Environment(var) => std::env::var(var).map_err(|_| {
                crate::Error::Credential(format!("Environment variable '{var}' not found"))
            }),
            Self::File(path) => std::fs::read_to_string(path)
                .map(|s| s.trim().to_string())
                .map_err(|e| crate::Error::FileRead {
                    path: path.clone(),
                    source: e,
                }),
            Self::Provided(pass) => Ok(pass.clone()),
        }
    }
}
