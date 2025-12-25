//! Backup/restore types

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Category of exportable data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCategory {
    /// Unique identifier (e.g., "remotes", "backend", "rclone_config")
    pub id: String,

    /// Human-readable name for display
    pub name: String,

    /// Type of category
    pub category_type: ExportCategoryType,

    /// Whether this category is optional (developer marked)
    #[serde(default)]
    pub optional: bool,

    /// Description of what this category contains
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Type of export category
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportCategoryType {
    /// Main settings.json file
    Settings,
    /// Sub-settings (has items inside, can list)
    SubSettings,
    /// External file/folder (registered separately)
    External,
}

/// Type of backup export
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportType {
    /// Full backup of all settings and sub-settings
    #[default]
    Full,
    /// Only main settings (no sub-settings)
    SettingsOnly,
    /// Single sub-settings entry
    Single {
        /// Sub-settings type (e.g., "remotes")
        settings_type: String,
        /// Entry name (e.g., "gdrive")
        name: String,
    },
}

/// Options for creating a backup
#[derive(Debug, Clone)]
pub struct BackupOptions {
    /// Output directory for the backup file
    pub output_dir: PathBuf,

    /// Type of export
    pub export_type: ExportType,

    /// Password for encryption (optional)
    pub password: Option<String>,

    /// User note to include in backup
    pub user_note: Option<String>,

    /// Include main settings
    pub include_settings: bool,

    /// Sub-settings categories to include (all items)
    pub include_sub_settings: Vec<String>,

    /// Sub-settings with specific items only (category -> items)
    pub include_sub_settings_items: std::collections::HashMap<String, Vec<String>>,

    /// External configs to include (by id)
    pub include_external_configs: Vec<String>,

    /// Progress callback (processed bytes, total bytes)
    pub on_progress: Option<ProgressCallback>,
}

/// Callback function for progress reporting (current_bytes, total_bytes)
#[derive(Clone)]
pub struct ProgressCallback(pub std::sync::Arc<dyn Fn(u64, u64) + Send + Sync>);

impl std::fmt::Debug for ProgressCallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProgressCallback")
    }
}

impl std::ops::Deref for ProgressCallback {
    type Target = dyn Fn(u64, u64) + Send + Sync;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            output_dir: PathBuf::from("."),
            export_type: ExportType::Full,
            password: None,
            user_note: None,
            include_settings: true,
            include_sub_settings: Vec::new(),
            include_sub_settings_items: std::collections::HashMap::new(),
            include_external_configs: Vec::new(),
            on_progress: None,
        }
    }
}

impl BackupOptions {
    /// Create new backup options with default values
    ///
    /// # Example
    /// ```rust,ignore
    /// let options = BackupOptions::new()
    ///     .output_dir("backups/")
    ///     .password("secret")
    ///     .include_sub_settings_items("remotes", &["gdrive", "s3"]);
    /// ```
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the output directory for the backup file
    #[must_use]
    pub fn output_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.output_dir = path.into();
        self
    }

    /// Set an encryption password (creates encrypted ZIP backup with AES-256)
    #[must_use]
    pub fn password(mut self, password: impl Into<String>) -> Self {
        self.password = Some(password.into());
        self
    }

    /// Add a user note to include in the backup manifest
    #[must_use]
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.user_note = Some(note.into());
        self
    }

    /// Set the export type (Full, SettingsOnly, or Single)
    #[must_use]
    pub fn export_type(mut self, export_type: ExportType) -> Self {
        self.export_type = export_type;
        self
    }

    /// Include main settings in backup
    #[must_use]
    pub fn include_settings(mut self, include: bool) -> Self {
        self.include_settings = include;
        self
    }

    /// Include entire sub-settings category (all items)
    #[must_use]
    pub fn include_sub_settings(mut self, category: impl Into<String>) -> Self {
        self.include_sub_settings.push(category.into());
        self
    }

    /// Include specific items from a sub-settings category
    ///
    /// # Example
    /// ```rust,ignore
    /// BackupOptions::new()
    ///     .include_sub_settings_items("remotes", &["gdrive", "s3"])
    /// ```
    #[must_use]
    pub fn include_sub_settings_items(
        mut self,
        category: impl Into<String>,
        items: &[impl AsRef<str>],
    ) -> Self {
        let items: Vec<String> = items.iter().map(|s| s.as_ref().to_string()).collect();
        self.include_sub_settings_items
            .insert(category.into(), items);
        self
    }

    /// Include an external config by id
    #[must_use]
    pub fn include_external(mut self, id: impl Into<String>) -> Self {
        self.include_external_configs.push(id.into());
        self
    }

    /// Set a progress callback
    #[must_use]
    pub fn on_progress<F>(mut self, callback: F) -> Self
    where
        F: Fn(u64, u64) + Send + Sync + 'static,
    {
        self.on_progress = Some(ProgressCallback(std::sync::Arc::new(callback)));
        self
    }
}

/// Options for restoring a backup
#[derive(Debug, Clone)]
pub struct RestoreOptions {
    /// Path to the backup file
    pub backup_path: PathBuf,

    /// Password for decryption (if backup is encrypted)
    pub password: Option<String>,

    /// Whether to restore main settings
    pub restore_settings: bool,

    /// Sub-settings to restore (category -> items, empty vec = all items in category)
    /// If empty HashMap, restores all sub-settings from backup
    pub restore_sub_settings: std::collections::HashMap<String, Vec<String>>,

    /// External config IDs to restore (empty = all from backup)
    pub restore_external_configs: Vec<String>,

    /// Whether to overwrite existing entries
    pub overwrite_existing: bool,

    /// Dry run mode - preview what would be restored without making changes
    pub dry_run: bool,

    /// Whether to verify the data archive checksum
    pub verify_checksum: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        Self {
            backup_path: PathBuf::new(),
            password: None,
            restore_settings: true,
            restore_sub_settings: std::collections::HashMap::new(),
            restore_external_configs: Vec::new(),
            overwrite_existing: false,
            dry_run: false,
            verify_checksum: true,
        }
    }
}

impl RestoreOptions {
    /// Create restore options from a backup file path
    ///
    /// # Example
    /// ```rust,ignore
    /// let options = RestoreOptions::from_path("backups/my-backup.rcman")
    ///     .password("secret")
    ///     .dry_run(true);
    /// ```
    #[must_use]
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self {
            backup_path: path.into(),
            ..Default::default()
        }
    }

    /// Set the decryption password
    #[must_use]
    pub fn password(mut self, password: impl Into<String>) -> Self {
        self.password = Some(password.into());
        self
    }

    /// Enable dry run mode (preview without making changes)
    #[must_use]
    pub fn dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }

    /// Set whether to overwrite existing entries
    #[must_use]
    pub fn overwrite(mut self, overwrite: bool) -> Self {
        self.overwrite_existing = overwrite;
        self
    }

    /// Set whether to verify the backup checksum
    #[must_use]
    pub fn verify_checksum(mut self, verify: bool) -> Self {
        self.verify_checksum = verify;
        self
    }

    /// Set whether to restore main settings
    #[must_use]
    pub fn restore_settings(mut self, restore: bool) -> Self {
        self.restore_settings = restore;
        self
    }

    /// Include an external config to restore by id
    #[must_use]
    pub fn restore_external(mut self, id: impl Into<String>) -> Self {
        self.restore_external_configs.push(id.into());
        self
    }

    /// Set specific sub-settings category to restore (all items in that category)
    #[must_use]
    pub fn restore_sub_settings(mut self, category: impl Into<String>) -> Self {
        self.restore_sub_settings
            .insert(category.into(), Vec::new());
        self
    }

    /// Set specific items from a sub-settings category to restore
    #[must_use]
    pub fn restore_sub_settings_items(
        mut self,
        category: impl Into<String>,
        items: &[impl AsRef<str>],
    ) -> Self {
        let items: Vec<String> = items.iter().map(|s| s.as_ref().to_string()).collect();
        self.restore_sub_settings.insert(category.into(), items);
        self
    }
}

/// External configuration file managed by the app
///
/// Use this to register external files (like rclone.conf) that should
/// be available for backup export.
///
/// # Example
///
/// ```rust
/// use rcman::ExternalConfig;
///
/// let config = ExternalConfig::new("rclone_config", "/path/to/rclone.conf")
///     .display_name("Rclone Configuration")
///     .description("Main rclone remote configurations");
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalConfig {
    /// Unique identifier for referencing in BackupOptions
    pub id: String,

    /// Path to the config file or directory
    pub path: PathBuf,

    /// Human-readable name for display
    pub display_name: String,

    /// Description of what this config contains
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Whether this config contains sensitive data
    #[serde(default)]
    pub is_sensitive: bool,

    /// Whether this config is optional for export (default: false)
    #[serde(default)]
    pub optional: bool,

    /// Whether this is a directory (default: false = file)
    #[serde(default)]
    pub is_directory: bool,
}

impl ExternalConfig {
    /// Create a new external config registration
    ///
    /// # Arguments
    /// * `id` - Unique identifier (used in BackupOptions::include_external)
    /// * `path` - Path to the file or directory
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            path: path.into(),
            description: None,
            is_sensitive: false,
            optional: false,
            is_directory: false,
        }
    }

    /// Set a human-readable display name
    pub fn display_name(mut self, name: impl Into<String>) -> Self {
        self.display_name = name.into();
        self
    }

    /// Set a description
    pub fn description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Mark this config as containing sensitive data
    pub fn sensitive(mut self) -> Self {
        self.is_sensitive = true;
        self
    }

    /// Mark this config as optional (not included by default in full backup)
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// Mark this as a directory instead of a file
    pub fn directory(mut self) -> Self {
        self.is_directory = true;
        self
    }

    /// Check if the file/directory exists
    pub fn exists(&self) -> bool {
        self.path.exists()
    }
}

/// Trait for external config providers
pub trait ExternalConfigProvider: Send + Sync {
    /// Get all external configs to include in backup
    fn get_configs(&self) -> Vec<ExternalConfig>;
}

// =============================================================================
// Manifest Versioning
// =============================================================================

/// Current manifest version used when creating backups
pub const MANIFEST_VERSION_CURRENT: u32 = 1;

/// Minimum manifest version this library can restore from
pub const MANIFEST_VERSION_MIN_SUPPORTED: u32 = 1;

/// Maximum manifest version this library can restore from
pub const MANIFEST_VERSION_MAX_SUPPORTED: u32 = 1;

/// Check if a manifest version is supported for restore
pub fn is_manifest_version_supported(version: u32) -> bool {
    version >= MANIFEST_VERSION_MIN_SUPPORTED && version <= MANIFEST_VERSION_MAX_SUPPORTED
}

/// Backup manifest embedded in .rcman files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Manifest format version
    pub version: u32,

    /// Backup metadata (app info, creation time, etc.)
    pub backup: BackupInfo,

    /// Contents info
    pub contents: BackupContents,

    /// Integrity info (checksums, sizes)
    pub integrity: BackupIntegrity,
}

impl Default for BackupManifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION_CURRENT,
            backup: BackupInfo::default(),
            contents: BackupContents::default(),
            integrity: BackupIntegrity::default(),
        }
    }
}

/// Backup metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    /// Application name
    pub app_name: String,

    /// Application version that created the backup
    pub app_version: String,

    /// When the backup was created
    pub created_at: DateTime<Utc>,

    /// Export type (full, partial, etc.)
    pub export_type: ExportType,

    /// Whether the data is encrypted
    pub encrypted: bool,

    /// User note
    pub user_note: Option<String>,
}

impl Default for BackupInfo {
    fn default() -> Self {
        Self {
            app_name: String::new(),
            app_version: String::new(),
            created_at: Utc::now(),
            export_type: ExportType::Full,
            encrypted: false,
            user_note: None,
        }
    }
}

/// Backup integrity information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackupIntegrity {
    /// SHA-256 checksum of the data archive
    pub sha256: Option<String>,

    /// Uncompressed size in bytes
    pub size_bytes: u64,

    /// Compressed size in bytes (if applicable)
    pub compressed_size_bytes: Option<u64>,
}

/// What's included in the backup
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackupContents {
    /// Main settings.json included
    pub settings: bool,

    /// Sub-settings included (category -> list of item names, empty vec means all items)
    pub sub_settings: std::collections::HashMap<String, Vec<String>>,

    /// External configs included (by id)
    pub external_configs: Vec<String>,

    /// Total file count
    pub file_count: u32,
}

/// Result of analyzing a backup file
#[derive(Debug, Clone)]
pub struct BackupAnalysis {
    /// The manifest from the backup
    pub manifest: BackupManifest,

    /// Is the backup valid
    pub is_valid: bool,

    /// Any warnings about the backup
    pub warnings: Vec<String>,

    /// Whether password is required
    pub requires_password: bool,
}
