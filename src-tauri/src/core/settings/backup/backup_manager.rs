//! Backup management using rcman library
//!
//! This module provides backup and analysis commands using the rcman library.
//! Legacy app-format backups are still supported for analysis/restore.

use crate::utils::types::backup_types::{
    BackupAnalysis, BackupManifest, ContentsInfo, ExportType, MetadataInfo, RemoteConfigsInfo,
};
use log::info;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};
use zip::ZipArchive;

/// Inner data archive name (exported for restore_manager.rs)
pub const INNER_DATA_ARCHIVE_NAME: &str = "data";

// -----------------------------------------------------------------------------
// MAIN BACKUP COMMAND (Using rcman)
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_settings(
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    user_note: Option<String>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
    _app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting backup with rcman to: {}", backup_dir);

    // Map app's ExportType to rcman's ExportType
    let rcman_export_type = match &export_type {
        ExportType::All => rcman::ExportType::Full,
        ExportType::Settings => rcman::ExportType::SettingsOnly,
        ExportType::SpecificRemote => rcman::ExportType::Single {
            settings_type: "remotes".into(),
            name: remote_name.clone().unwrap_or_default(),
        },
        // For other types, treat as Full with sub-settings
        ExportType::Remotes | ExportType::RemoteConfigs => rcman::ExportType::Full,
        ExportType::RCloneBackend => rcman::ExportType::SettingsOnly,
    };

    // Build rcman backup options
    let mut options = rcman::BackupOptions::new()
        .output_dir(&backup_dir)
        .export_type(rcman_export_type);

    // Include remotes sub-settings for full or remote-related exports
    if matches!(
        export_type,
        ExportType::All | ExportType::Remotes | ExportType::RemoteConfigs
    ) {
        options = options.include_sub_settings("remotes");
        options = options.include_external("rclone_config");
    }

    if matches!(export_type, ExportType::All | ExportType::RCloneBackend) {
        options = options.include_sub_settings("backend");
    }

    if matches!(export_type, ExportType::All) {
        options = options.include_sub_settings("connections");
    }

    // Add password if provided
    if let Some(ref pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    // Add user note if provided
    if let Some(note) = user_note {
        options = options.note(note);
    }

    // Create backup using rcman
    let backup_path = manager
        .backup()
        .create(options)
        .map_err(|e| format!("Backup failed: {}", e))?;

    info!("Backup complete: {}", backup_path.display());
    Ok(format!("Backup created at: {}", backup_path.display()))
}

// -----------------------------------------------------------------------------
// BACKUP ANALYSIS COMMAND (Using rcman with format detection)
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_backup_file(
    path: PathBuf,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
) -> Result<BackupAnalysis, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "rcman" {
        return Err("Unsupported archive type. Must be a .rcman file".into());
    }

    // Read manifest to detect format
    let file = File::open(&path).map_err(|e| format!("Failed to open .rcman: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Invalid .rcman file (not a valid zip): {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json".to_string())?;

    let manifest_json: serde_json::Value = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest.json: {e}"))?;

    // Detect format: rcman has root "version" as int, legacy has "format.version" as string
    let is_rcman_format = manifest_json
        .get("version")
        .and_then(|v| v.as_u64())
        .is_some();

    if is_rcman_format {
        // Use rcman's analyze
        let analysis = manager
            .backup()
            .analyze(&path)
            .map_err(|e| format!("Analysis failed: {}", e))?;

        // Map rcman BackupContents to app's ContentsInfo
        let contents = ContentsInfo {
            settings: analysis.manifest.contents.settings,
            backend_config: analysis
                .manifest
                .contents
                .sub_settings
                .contains_key("backend"),
            rclone_config: analysis
                .manifest
                .contents
                .external_configs
                .contains(&"rclone_config".to_string()),
            remote_configs: if analysis
                .manifest
                .contents
                .sub_settings
                .contains_key("remotes")
            {
                let remotes = analysis.manifest.contents.sub_settings.get("remotes");
                Some(RemoteConfigsInfo {
                    count: remotes.map(|v| v.len()).unwrap_or(0),
                    names: remotes.cloned(),
                })
            } else {
                None
            },
        };

        Ok(BackupAnalysis {
            is_encrypted: analysis.requires_password,
            archive_type: if analysis.requires_password {
                "zip-aes".into()
            } else {
                "zip".into()
            },
            format_version: analysis.manifest.version.to_string(),
            created_at: Some(analysis.manifest.backup.created_at.to_rfc3339()),
            backup_type: Some(format!("{:?}", analysis.manifest.backup.export_type)),
            metadata: analysis.manifest.backup.user_note.map(|note| MetadataInfo {
                user_note: Some(note),
            }),
            contents: Some(contents),
        })
    } else {
        // Legacy app format - parse directly
        let manifest: BackupManifest = serde_json::from_value(manifest_json)
            .map_err(|e| format!("Failed to parse legacy manifest: {e}"))?;

        Ok(BackupAnalysis {
            is_encrypted: manifest.backup.encrypted,
            archive_type: manifest.backup.compression,
            format_version: manifest.format.version,
            created_at: Some(manifest.backup.created_at),
            backup_type: Some(manifest.backup.backup_type),
            metadata: manifest.metadata,
            contents: Some(manifest.contents),
        })
    }
}

// -----------------------------------------------------------------------------
// LEGACY HELPER FUNCTIONS (Kept for restore_manager.rs backward compatibility)
// -----------------------------------------------------------------------------

/// Calculates SHA-256 hash and file size
///
/// Used by restore_manager.rs for integrity verification of legacy backups.
pub fn calculate_file_hash(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut hasher = Sha256::new();
    let bytes_copied =
        std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Failed to read file: {e}"))?;
    let hash = format!("{:x}", hasher.finalize());
    Ok((hash, bytes_copied))
}
