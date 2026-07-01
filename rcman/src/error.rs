//! Error types for rcman library

use std::path::PathBuf;
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
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to write file '{path}': {source}")]
    FileWrite {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to create directory '{path}': {source}")]
    DirectoryCreate {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to read directory '{path}': {source}")]
    DirectoryRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to delete file '{path}': {source}")]
    FileDelete {
        path: PathBuf,
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
    #[error("Setting not found: {0}")]
    SettingNotFound(String),

    #[error("Invalid setting value for {key}: {reason}")]
    InvalidSettingValue { key: String, reason: String },

    #[error("Invalid setting metadata for {key}: {reason}")]
    InvalidSettingMetadata { key: String, reason: String },

    #[error("Settings schema not registered")]
    SchemaNotRegistered,

    #[error("Type mismatch for {key}: expected {expected}, got {actual}")]
    TypeMismatch {
        key: String,
        expected: String,
        actual: String,
    },

    // -------------------------------------------------------------------------
    // Sub-Settings Errors
    // -------------------------------------------------------------------------
    #[error("Sub-settings type '{0}' not registered")]
    SubSettingsNotRegistered(String),

    #[error("Sub-settings entry '{0}' not found")]
    SubSettingsEntryNotFound(String),

    // -------------------------------------------------------------------------
    // Backup Errors
    // -------------------------------------------------------------------------
    #[error("Backup failed: {0}")]
    BackupFailed(String),

    #[error("Restore failed: {0}")]
    RestoreFailed(String),

    #[error("Invalid backup: {0}")]
    InvalidBackup(String),

    #[error("Backup password required")]
    PasswordRequired,

    #[error("Invalid backup password")]
    InvalidPassword,

    #[error("Version mismatch: expected {expected}, found {found}")]
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

    // -------------------------------------------------------------------------
    // Profile Errors (profiles feature)
    // -------------------------------------------------------------------------
    #[cfg(feature = "profiles")]
    #[error("Profile '{0}' not found")]
    ProfileNotFound(String),

    #[cfg(feature = "profiles")]
    #[error("Profile '{0}' already exists")]
    ProfileAlreadyExists(String),

    #[cfg(feature = "profiles")]
    #[error("Cannot delete active profile '{0}'")]
    CannotDeleteActiveProfile(String),

    #[cfg(feature = "profiles")]
    #[error("Cannot delete the last remaining profile")]
    CannotDeleteLastProfile,

    #[cfg(feature = "profiles")]
    #[error("Invalid profile name: {0}")]
    InvalidProfileName(String),

    #[cfg(feature = "profiles")]
    #[error("Profiles not enabled")]
    ProfilesNotEnabled,

    #[cfg(feature = "profiles")]
    #[error("Profile migration failed: {0}")]
    ProfileMigrationFailed(String),

    // -------------------------------------------------------------------------
    // Cache Errors
    // -------------------------------------------------------------------------
    #[error("Invalid cache strategy: {0}")]
    InvalidCacheStrategy(String),

    // -------------------------------------------------------------------------
    // Concurrency Errors
    // -------------------------------------------------------------------------
    #[error(
        "Internal lock was poisoned - possible thread panic. The operation may have left data in an inconsistent state."
    )]
    LockPoisoned,

    #[error("Lock error: {0}")]
    LockError(String),
}

impl Error {
    /// Check if this is a "not found" type error
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        matches!(
            self,
            Error::PathNotFound(_) | Error::SettingNotFound(_) | Error::SubSettingsEntryNotFound(_)
        )
    }

    /// Check if this is a backup-related error
    #[must_use]
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

// =============================================================================
// Filesystem Helper Functions (backup feature)
// =============================================================================
// These reduce repetitive map_err patterns in the backup module.

#[cfg(feature = "backup")]
use std::path::Path;

/// Create a directory (and parents) with proper error handling
#[cfg(feature = "backup")]
pub fn create_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| Error::DirectoryCreate {
        path: path.to_path_buf(),
        source: e,
    })
}

/// Copy a file with proper error handling
#[cfg(feature = "backup")]
pub fn copy_file(src: &Path, dest: &Path) -> Result<u64> {
    std::fs::copy(src, dest).map_err(|e| Error::FileRead {
        path: src.to_path_buf(),
        source: e,
    })
}

/// Write content to a file with proper error handling
#[cfg(feature = "backup")]
pub fn write_file(path: &Path, contents: impl AsRef<[u8]>) -> Result<()> {
    std::fs::write(path, contents).map_err(|e| Error::FileWrite {
        path: path.to_path_buf(),
        source: e,
    })
}

/// Read directory entries with proper error handling
#[cfg(feature = "backup")]
pub fn read_dir(path: &Path) -> Result<std::fs::ReadDir> {
    std::fs::read_dir(path).map_err(|e| Error::DirectoryRead {
        path: path.to_path_buf(),
        source: e,
    })
}

/// Get file size (returns 0 if metadata unavailable)
#[cfg(feature = "backup")]
#[inline]
pub fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}
