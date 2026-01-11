use serde::{Deserialize, Serialize};

/// Export types supported by the app
/// These map to rcman's ExportType for backup creation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExportType {
    All,
    Settings,
    SpecificRemote,
    /// Dynamic category export (e.g. "remotes", "connections", "backend")
    Category(String),
}

/// Backup analysis result returned to frontend
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupAnalysis {
    /// Is the backup password protected?
    pub is_encrypted: bool,
    /// The compression format (e.g., "7z", "zip").
    pub archive_type: String,
    /// The manifest format version (e.g., "1.0.0" for legacy, "1" for rcman).
    pub format_version: String,
    /// Is this a legacy backup (without profile support)? If true, should restore to "default" profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_legacy: Option<bool>,
    /// The date the backup was created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// The type of backup (e.g., "Full Backup").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_type: Option<String>,
    /// Optional user note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
    /// Summary of backup contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<BackupContentsInfo>,
}

/// Summary of what's in a backup
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupContentsInfo {
    pub settings: bool,
    pub backend_config: bool,
    pub rclone_config: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<String>>,
}
