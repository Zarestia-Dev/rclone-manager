use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExportType {
    All,
    Settings,
    Remotes,
    RemoteConfigs,
    SpecificRemote,
    RCloneBackend,
}

/// The root structure of the `manifest.json` file
/// found inside a `.rcman` backup archive.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupManifest {
    pub format: FormatInfo,
    pub backup: BackupInfo,
    pub contents: ContentsInfo,
    pub integrity: IntegrityInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MetadataInfo>,
}

/// "format" section of the manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub version: String,
    pub created_by: String,
}

/// "backup" section of the manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// ISO 8601 timestamp
    pub created_at: String,
    /// User-facing type, e.g., "Full Backup", "Settings Only"
    #[serde(rename = "type")]
    pub backup_type: String,
    /// True if the inner data archive (data.7z) is encrypted.
    pub encrypted: bool,
    /// "7z" or "zip"
    pub compression: String,
}

/// "contents" section of the manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentsInfo {
    pub settings: bool,
    pub backend_config: bool,
    pub rclone_config: bool,
    /// Details about exported remote configs, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_configs: Option<RemoteConfigsInfo>,
}

/// "remote_configs" (nested in "contents")
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigsInfo {
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
}

/// "integrity" section of the manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityInfo {
    /// SHA-256 hash of the inner data archive (e.g., data.7z).
    pub sha256: String,
    /// Original uncompressed size of all files.
    pub size_bytes: u64,
    /// Size of the inner data archive (e.g., data.7z).
    pub compressed_size_bytes: u64,
}

/// "metadata" section of the manifest (optional)
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
}

// -----------------------------------------------------------------------------
// Backup Analysis Struct
// -----------------------------------------------------------------------------
// This is the struct returned by the `analyze_backup_file` command.
// It's a "view model" for the UI, combining manifest data and legacy logic.
// (This replaces the simple BackupAnalysis struct from backup_manager.rs)
// -----------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupAnalysis {
    /// Is the backup password protected?
    pub is_encrypted: bool,
    /// The compression format (e.g., "7z", "zip").
    pub archive_type: String,
    /// The manifest format version (e.g., "1.0.0").
    /// Will be "legacy" for old .zip/.7z backups.
    pub format_version: String,
    /// The date the backup was created (from manifest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// The type of backup (e.g., "Full Backup") (from manifest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_type: Option<String>,
    /// Optional metadata (from manifest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MetadataInfo>,
    /// Optional content summary (from manifest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<ContentsInfo>,
}
