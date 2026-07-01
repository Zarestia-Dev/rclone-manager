//! Backup/restore types

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use time::OffsetDateTime;

/// Category of exportable data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCategory {
    /// Unique identifier (e.g., "remotes", "backend", "`rclone_config`")
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

    /// External configs to include (by id).
    ///
    /// In `ExportType::Full`, leaving this empty includes all registered external configs.
    /// For other export types, this acts as an explicit allow-list.
    pub include_external_configs: Vec<String>,

    /// Custom filename suffix (e.g. "remotes" -> "`app_timestamp_remotes.rcman`")
    pub filename_suffix: Option<String>,

    /// Progress callback (processed bytes, total bytes)
    pub on_progress: Option<ProgressCallback>,

    /// Profiles to include (if empty, defaults to active or all depending on logic)
    #[cfg(feature = "profiles")]
    pub include_profiles: Vec<String>,

    /// Policy for handling secret values (passwords, tokens)
    pub secret_policy: crate::SecretBackupPolicy,
}

/// Callback function for progress reporting (`current_bytes`, `total_bytes`)
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
            filename_suffix: None,
            on_progress: None,
            #[cfg(feature = "profiles")]
            include_profiles: Vec::new(),
            secret_policy: crate::SecretBackupPolicy::default(),
        }
    }
}

impl BackupOptions {
    /// Create new backup options with default values
    ///
    /// # Example
    /// ```rust
    /// use rcman::BackupOptions;
    ///
    /// let options = BackupOptions::new()
    ///     .output_dir("backups/")
    ///     .password("secure-password");
    /// ```
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set secret policy for backup export.
    ///
    /// Notes:
    /// - Secret keys are exported in the same schema location where they are declared
    ///   (for example, main-schema secret keys appear in main settings export structure).
    /// - `EncryptedOnly` includes secrets only when backup password is set; otherwise
    ///   export is redacted for secrets.
    /// - With credentials enabled, restoring a backup with included main-schema secrets
    ///   rehydrates those values into credential storage and redacts them in restored
    ///   settings files.
    #[must_use]
    pub fn secret_policy(mut self, policy: crate::SecretBackupPolicy) -> Self {
        self.secret_policy = policy;
        self
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

    /// Set the export type (Full, `SettingsOnly`, or Single)
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
    /// ```rust
    /// use rcman::BackupOptions;
    ///
    /// let options = BackupOptions::new()
    ///     .include_sub_settings_items("remotes", &["gdrive", "s3"]);
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

    /// Include an external config by id.
    ///
    /// Useful for selective exports (for example, `ExportType::SettingsOnly`).
    #[must_use]
    pub fn include_external(mut self, id: impl Into<String>) -> Self {
        self.include_external_configs.push(id.into());
        self
    }

    /// Set a custom filename suffix
    #[must_use]
    pub fn filename_suffix(mut self, suffix: impl Into<String>) -> Self {
        self.filename_suffix = Some(suffix.into());
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

    /// Include specific profile (if profiles enabled)
    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn include_profile(mut self, profile: impl Into<String>) -> Self {
        self.include_profiles.push(profile.into());
        self
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RestoreControl {
    /// Whether to overwrite existing entries
    pub overwrite_existing: bool,
    /// Dry run mode - preview what would be restored without making changes
    pub dry_run: bool,
    /// Whether to verify the data archive checksum
    pub verify_checksum: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct RestoreScope {
    /// Whether to restore main settings
    pub restore_settings: bool,
}

impl Default for RestoreScope {
    fn default() -> Self {
        Self {
            restore_settings: true,
        }
    }
}

/// Options for restoring a backup
/// Flags for restore options
#[derive(Debug, Clone, Default, Copy)]
pub struct RestoreFlags {
    pub control: RestoreControl,
    pub scope: RestoreScope,
}

/// Options for restoring a backup
#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    /// Path to the backup file
    pub backup_path: PathBuf,

    /// Password for decryption (if backup is encrypted)
    pub password: Option<String>,

    /// flags
    pub flags: RestoreFlags,

    /// Sub-settings to restore (category -> items, empty vec = all items in category)
    /// If empty `HashMap`, restores all sub-settings from backup
    pub restore_sub_settings: std::collections::HashMap<String, Vec<String>>,

    /// External config IDs to restore (empty = all from backup)
    pub restore_external_configs: Vec<String>,

    /// Restore specific profile from backup (if profiles enabled)
    #[cfg(feature = "profiles")]
    pub restore_profile: Option<String>,

    /// Rename restored profile to this name (requires `restore_profile`)
    #[cfg(feature = "profiles")]
    pub restore_profile_as: Option<String>,
}

impl RestoreOptions {
    /// Create restore options from a backup file path
    ///
    /// # Example
    /// ```rust
    /// use rcman::RestoreOptions;
    ///
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
        self.flags.control.dry_run = dry_run;
        self
    }

    /// Set whether to overwrite existing entries
    #[must_use]
    pub fn overwrite(mut self, overwrite: bool) -> Self {
        self.flags.control.overwrite_existing = overwrite;
        self
    }

    /// Set whether to verify the backup checksum
    #[must_use]
    pub fn verify_checksum(mut self, verify: bool) -> Self {
        self.flags.control.verify_checksum = verify;
        self
    }

    /// Set whether to restore main settings
    #[must_use]
    pub fn restore_settings(mut self, restore: bool) -> Self {
        self.flags.scope.restore_settings = restore;
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

    /// Set profile to restore (if profiles enabled)
    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn restore_profile(mut self, profile: impl Into<String>) -> Self {
        self.restore_profile = Some(profile.into());
        self
    }

    /// Set target name for restored profile (requires `restore_profile`)
    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn restore_profile_as(mut self, name: impl Into<String>) -> Self {
        self.restore_profile_as = Some(name.into());
        self
    }
}

// =============================================================================
// Dynamic External Config Sources
// =============================================================================

/// How to get data for backup export
///
/// This defines where the content comes from when creating a backup.
#[derive(Debug, Clone)]
pub enum ExportSource {
    /// Read content from a file on disk
    File(PathBuf),
    /// Run a command and capture its stdout
    Command { program: String, args: Vec<String> },
    /// Use provided bytes directly (for API responses, computed data)
    Content(Vec<u8>),
}

/// Handler function for custom restore logic
pub type ImportHandler = std::sync::Arc<dyn Fn(&[u8]) -> crate::error::Result<()> + Send + Sync>;

/// How to restore data from a backup
///
/// This defines what happens when restoring the config from a backup.
#[derive(Clone)]
pub enum ImportTarget {
    /// Write content to a file
    File(PathBuf),
    /// Pipe content to a command's stdin
    Command { program: String, args: Vec<String> },
    /// Custom handler function for complex restore logic
    Handler(ImportHandler),
    /// Read-only export (cannot be restored, e.g., system diagnostics)
    ReadOnly,
}

impl std::fmt::Debug for ImportTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportTarget::File(p) => f.debug_tuple("File").field(p).finish(),
            ImportTarget::Command { program, args } => f
                .debug_struct("Command")
                .field("program", program)
                .field("args", args)
                .finish(),
            ImportTarget::Handler(_) => f.debug_tuple("Handler").field(&"<fn>").finish(),
            ImportTarget::ReadOnly => write!(f, "ReadOnly"),
        }
    }
}

/// External configuration managed by the app
///
/// Use this to register external files, command outputs, or dynamic data
/// that should be available for backup export and restore.
///
/// # Examples
///
/// ## File-based config (traditional)
/// ```rust
/// use rcman::backup::ExternalConfig;
///
/// let config = ExternalConfig::new("rclone_config", "/path/to/rclone.conf")
///     .display_name("Rclone Configuration");
/// ```
///
/// ## Command output
/// ```rust
/// use rcman::backup::ExternalConfig;
///
/// let config = ExternalConfig::from_command("rclone_dump", "rclone_dump.json")
///     .export_command("rclone", &["config", "dump"])
///     .import_read_only() // Cannot restore command output directly
///     .display_name("Rclone Config Dump");
/// ```
///
/// ## In-memory content
/// ```rust
/// use rcman::backup::ExternalConfig;
///
/// let api_data = b"{ \"key\": \"value\" }".to_vec();
/// let config = ExternalConfig::from_content("cloud_config", "cloud.json", api_data)
///     .display_name("Cloud Settings");
/// ```
#[derive(Debug, Clone)]
pub struct ExternalConfig {
    /// Unique identifier for referencing in `BackupOptions`
    pub id: String,

    /// Filename used inside the backup archive
    pub archive_filename: String,

    /// Human-readable name for display
    pub display_name: String,

    /// Description of what this config contains
    pub description: Option<String>,

    /// How to get the data for export
    pub export_source: ExportSource,

    /// How to restore the data on import
    pub import_target: ImportTarget,

    /// Whether this config contains sensitive data
    pub is_sensitive: bool,

    /// Whether this config is optional for export (default: false)
    pub optional: bool,

    /// Whether this is a directory (for File source, default: false)
    pub is_directory: bool,
}

impl ExternalConfig {
    /// Create a new file-based external config (backward compatible)
    ///
    /// This is the traditional way to register a config file.
    /// Both export and import will use the same file path.
    ///
    /// # Arguments
    /// * `id` - Unique identifier (used in `BackupOptions::include_external`)
    /// * `path` - Path to the file or directory
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        let id = id.into();
        let path = path.into();
        let archive_filename = path
            .file_name()
            .map_or_else(|| format!("{id}.dat"), |s| s.to_string_lossy().to_string());
        Self {
            display_name: id.clone(),
            id,
            archive_filename,
            export_source: ExportSource::File(path.clone()),
            import_target: ImportTarget::File(path),
            description: None,
            is_sensitive: false,
            optional: false,
            is_directory: false,
        }
    }

    /// Create a config that exports from a command's stdout
    ///
    /// # Arguments
    /// * `id` - Unique identifier
    /// * `archive_filename` - Filename to use inside the backup archive
    pub fn from_command(id: impl Into<String>, archive_filename: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            archive_filename: archive_filename.into(),
            export_source: ExportSource::Command {
                program: String::new(),
                args: Vec::new(),
            },
            import_target: ImportTarget::ReadOnly,
            description: None,
            is_sensitive: false,
            optional: false,
            is_directory: false,
        }
    }

    /// Create a config from in-memory content
    ///
    /// # Arguments
    /// * `id` - Unique identifier
    /// * `archive_filename` - Filename to use inside the backup archive
    /// * `content` - The bytes to include in the backup
    pub fn from_content(
        id: impl Into<String>,
        archive_filename: impl Into<String>,
        content: Vec<u8>,
    ) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            archive_filename: archive_filename.into(),
            export_source: ExportSource::Content(content),
            import_target: ImportTarget::ReadOnly,
            description: None,
            is_sensitive: false,
            optional: false,
            is_directory: false,
        }
    }

    /// Set the export command (for Command source)
    #[must_use]
    pub fn export_command(mut self, program: impl Into<String>, args: &[&str]) -> Self {
        self.export_source = ExportSource::Command {
            program: program.into(),
            args: args.iter().map(std::string::ToString::to_string).collect(),
        };
        self
    }

    /// Set import to write to a file
    #[must_use]
    pub fn import_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.import_target = ImportTarget::File(path.into());
        self
    }

    /// Set import to pipe to a command's stdin
    #[must_use]
    pub fn import_command(mut self, program: impl Into<String>, args: &[&str]) -> Self {
        self.import_target = ImportTarget::Command {
            program: program.into(),
            args: args.iter().map(std::string::ToString::to_string).collect(),
        };
        self
    }

    /// Set import to use a custom handler
    #[must_use]
    pub fn import_handler<F>(mut self, handler: F) -> Self
    where
        F: Fn(&[u8]) -> crate::error::Result<()> + Send + Sync + 'static,
    {
        self.import_target = ImportTarget::Handler(std::sync::Arc::new(handler));
        self
    }

    /// Mark import as read-only (cannot be restored)
    #[must_use]
    pub fn import_read_only(mut self) -> Self {
        self.import_target = ImportTarget::ReadOnly;
        self
    }

    /// Set a human-readable display name
    #[must_use]
    pub fn display_name(mut self, name: impl Into<String>) -> Self {
        self.display_name = name.into();
        self
    }

    /// Set a description
    #[must_use]
    pub fn description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Mark this config as containing sensitive data
    #[must_use]
    pub fn sensitive(mut self) -> Self {
        self.is_sensitive = true;
        self
    }

    /// Mark this config as optional (not included by default in full backup)
    #[must_use]
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// Mark this as a directory instead of a file (only for File source)
    #[must_use]
    pub fn directory(mut self) -> Self {
        self.is_directory = true;
        self
    }

    /// Check if the source exists (only meaningful for File source)
    #[must_use]
    pub fn exists(&self) -> bool {
        match &self.export_source {
            ExportSource::File(path) => path.exists(),
            ExportSource::Command { .. } | ExportSource::Content(_) => true,
        }
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
#[must_use]
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
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,

    /// Export type (full, partial, etc.)
    pub export_type: ExportType,

    /// Whether the data is encrypted
    pub encrypted: bool,

    /// User note
    pub user_note: Option<String>,

    /// Secret export policy used when creating this backup.
    ///
    /// `None` indicates a legacy backup manifest created before this field
    /// was introduced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_policy: Option<crate::SecretBackupPolicy>,
}

impl Default for BackupInfo {
    fn default() -> Self {
        Self {
            app_name: String::new(),
            app_version: String::new(),
            created_at: OffsetDateTime::now_utc(),
            export_type: ExportType::Full,
            encrypted: false,
            user_note: None,
            secret_policy: None,
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

/// Profile entry - polymorphic: String for single item, Array for multiple
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ProfileEntry {
    Single(String),
    Multiple(Vec<String>),
}

/// Manifest entry for sub-settings
///
/// Item names stored WITHOUT extensions (format-agnostic: .json, .toml, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum SubSettingsManifestEntry {
    /// Single item: `"backend"`
    SingleFile(String),
    /// Multiple items: `["gdrive", "s3"]`
    MultiFile(Vec<String>),
    /// Profiled: `{"default": "backend"}` or `{"default": ["item1", "item2"]}`
    #[cfg(feature = "profiles")]
    Profiled {
        profiles: std::collections::HashMap<String, ProfileEntry>,
    },
}

/// What's included in the backup
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackupContents {
    pub settings: bool,
    pub sub_settings: std::collections::HashMap<String, SubSettingsManifestEntry>,
    /// External config IDs included in backup.
    ///
    /// Deprecation plan (target: v0.2.0, breaking):
    /// - Remove this ID-only list
    /// - Rename `external_config_files` -> `external_configs`
    /// - New `external_configs` will be the canonical `id -> archive_filename` map
    ///
    /// Keep this field until v0.2.0 for backward compatibility with existing
    /// manifests and consumers that still read the legacy list format.
    pub external_configs: Vec<String>,
    /// Canonical mapping of external config id to archive filename.
    ///
    /// Introduced to make external restore robust when config ID differs from
    /// archived filename or when source/target paths differ.
    ///
    /// Deprecation plan (target: v0.2.0, breaking): rename this field to
    /// `external_configs` after removing the legacy `Vec<String>` field above.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub external_config_files: std::collections::HashMap<String, String>,
    #[cfg(feature = "profiles")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<String>>,
    pub file_count: u32,
}

impl BackupContents {
    /// Convert to `HashMap` for restore processing
    #[must_use]
    pub fn sub_settings_list(&self) -> std::collections::HashMap<String, Vec<String>> {
        self.sub_settings
            .iter()
            .map(|(k, v)| {
                let items = match v {
                    SubSettingsManifestEntry::SingleFile(_) => Vec::new(), // Empty = all items
                    SubSettingsManifestEntry::MultiFile(items) => items.clone(),
                    #[cfg(feature = "profiles")]
                    SubSettingsManifestEntry::Profiled { .. } => Vec::new(), // Restore handles profiles
                };
                (k.clone(), items)
            })
            .collect()
    }
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

    // =========================================================================
    // Display/convenience fields (pre-formatted for direct frontend use)
    // =========================================================================
    /// Creation timestamp formatted as RFC3339 string
    pub created_at: String,

    /// Human-readable backup type (e.g., "Full Backup", "Settings Only")
    pub backup_type: String,

    /// Whether the backup is encrypted (convenience copy from manifest)
    pub is_encrypted: bool,

    /// Manifest format version as string
    pub format_version: String,

    /// User note (convenience copy from manifest)
    pub user_note: Option<String>,
}
