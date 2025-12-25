//! Error types for rcman library

use thiserror::Error;

/// Result type alias for rcman operations
pub type Result<T> = std::result::Result<T, Error>;

/// Main error type for rcman library
#[derive(Error, Debug)]
pub enum Error {
    // -------------------------------------------------------------------------
    // I/O Errors
    // -------------------------------------------------------------------------
    #[error("Failed to read file '{path}': {source}")]
    FileRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to write file '{path}': {source}")]
    FileWrite {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to create directory '{path}': {source}")]
    DirectoryCreate {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to delete file '{path}': {source}")]
    FileDelete {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Path not found: {0}")]
    PathNotFound(String),

    // -------------------------------------------------------------------------
    // Serialization Errors
    // -------------------------------------------------------------------------
    #[error("Failed to serialize data: {0}")]
    Serialize(#[from] serde_json::Error),

    #[error("Failed to parse settings: {0}")]
    Parse(String),

    // -------------------------------------------------------------------------
    // Settings Errors
    // -------------------------------------------------------------------------
    #[error("Setting not found: {category}.{key}")]
    SettingNotFound { category: String, key: String },

    #[error("Invalid setting value for {category}.{key}: {reason}")]
    InvalidSettingValue {
        category: String,
        key: String,
        reason: String,
    },

    #[error("Settings schema not registered")]
    SchemaNotRegistered,

    // -------------------------------------------------------------------------
    // Sub-Settings Errors
    // -------------------------------------------------------------------------
    #[error("Sub-settings type '{0}' not registered")]
    SubSettingsNotRegistered(String),

    #[error("Sub-settings entry '{name}' not found in '{settings_type}'")]
    SubSettingsEntryNotFound { settings_type: String, name: String },

    // -------------------------------------------------------------------------
    // Backup Errors
    // -------------------------------------------------------------------------
    #[error("Backup failed: {0}")]
    BackupFailed(String),

    #[error("Restore failed: {0}")]
    RestoreFailed(String),

    #[error("Invalid backup file: {0}")]
    InvalidBackup(String),

    #[error("Backup password required")]
    PasswordRequired,

    #[error("Invalid backup password")]
    InvalidPassword,

    #[error("Backup version mismatch: expected {expected}, found {found}")]
    VersionMismatch { expected: String, found: String },

    // -------------------------------------------------------------------------
    // Archive Errors (backup feature)
    // -------------------------------------------------------------------------
    #[cfg(feature = "backup")]
    #[error("Archive error: {0}")]
    Archive(String),

    #[cfg(feature = "backup")]
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    // -------------------------------------------------------------------------
    // Configuration Errors
    // -------------------------------------------------------------------------
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Manager not initialized")]
    NotInitialized,

    // -------------------------------------------------------------------------
    // Credential Errors
    // -------------------------------------------------------------------------
    #[error("Credential error: {0}")]
    Credential(String),
}

impl Error {
    /// Check if this is a "not found" type error
    pub fn is_not_found(&self) -> bool {
        matches!(
            self,
            Error::PathNotFound(_)
                | Error::SettingNotFound { .. }
                | Error::SubSettingsEntryNotFound { .. }
        )
    }

    /// Check if this is a backup-related error
    pub fn is_backup_error(&self) -> bool {
        matches!(
            self,
            Error::BackupFailed(_)
                | Error::RestoreFailed(_)
                | Error::InvalidBackup(_)
                | Error::PasswordRequired
                | Error::InvalidPassword
                | Error::VersionMismatch { .. }
        )
    }
}
