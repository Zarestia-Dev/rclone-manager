//! Backup and restore module for rcman

mod archive;
mod operations;
mod restore;
mod types;

pub use operations::BackupManager;
pub use restore::{
    RestorePendingItem, RestorePendingReason, RestoreResult, RestoreSkipReason, RestoreSkippedItem,
};

pub use types::{
    BackupAnalysis, BackupContents, BackupInfo, BackupIntegrity, BackupManifest, BackupOptions,
    ExportCategory, ExportCategoryType, ExportSource, ExportType, ExternalConfig,
    ExternalConfigProvider, ImportTarget, MANIFEST_VERSION_CURRENT, MANIFEST_VERSION_MAX_SUPPORTED,
    MANIFEST_VERSION_MIN_SUPPORTED, ProfileEntry, ProgressCallback, RestoreControl, RestoreFlags,
    RestoreOptions, RestoreScope, SubSettingsManifestEntry, is_manifest_version_supported,
};
