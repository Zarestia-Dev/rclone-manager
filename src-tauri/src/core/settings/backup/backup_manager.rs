//! Backup management using rcman library
//!
//! This module provides backup and analysis commands using the rcman library.

use crate::core::settings::AppSettingsManager;
use crate::utils::types::backup_types::{BackupAnalysis, BackupContentsInfo, ExportType};
use log::{error, info};
use std::{fs::File, io::BufReader, path::PathBuf};
use tauri::{AppHandle, State};
use zip::ZipArchive;

// =============================================================================
// BACKUP COMMAND
// =============================================================================

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn backup_settings(
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    user_note: Option<String>,
    include_profiles: Option<Vec<String>>,
    manager: State<'_, AppSettingsManager>,
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
        ExportType::Category(_) => rcman::ExportType::SettingsOnly,
    };

    // Build rcman backup options
    let mut options = rcman::BackupOptions::new()
        .output_dir(&backup_dir)
        .export_type(rcman_export_type);

    // Disable settings.json for partial exports (Categories or SpecificRemote)
    if matches!(
        export_type,
        ExportType::Category(_) | ExportType::SpecificRemote
    ) {
        options = options.include_settings(false);
    }

    // Handle dynamic categories
    if let ExportType::Category(ref category) = export_type {
        // Special handling for legacy "remotes" category if needed,
        // but generally we just pass the category name to rcman
        options = options.include_sub_settings(category);

        // If category is "remotes", we should also include rclone.conf
        if category == "remotes" {
            options = options.include_external("rclone.conf");
        }
    }

    // Always include remotes/rclone.conf for Full backup
    if matches!(export_type, ExportType::All) {
        options = options.include_sub_settings("remotes");
        options = options.include_external("rclone.conf");
        options = options.include_sub_settings("backend");
        options = options.include_sub_settings("connections");
    }

    // Single remote export: register dynamic provider for just this remote's config
    if matches!(export_type, ExportType::SpecificRemote)
        && let Some(ref name) = remote_name
    {
        use super::rclone_config_provider::RcloneConfigProvider;
        use crate::rclone::backend::BACKEND_MANAGER;

        let all_configs = BACKEND_MANAGER.remote_cache.get_configs().await;
        let remote_config = all_configs.get(name).cloned();

        let provider = RcloneConfigProvider::for_remote(name, remote_config);
        manager.register_external_provider(Box::new(provider));
        options = options.include_external(format!("remote:{}", name));
    }

    if let Some(ref pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    if let Some(note) = user_note {
        options = options.note(note);
    }

    if let Some(profiles) = include_profiles {
        for profile in profiles {
            options = options.include_profile(profile);
        }
    }

    let backup_path = manager.backup().create(&options).map_err(|e| {
        error!("❌ Backup failed: {}", e);
        format!("Backup failed: {}", e)
    })?;

    info!("Backup complete: {}", backup_path.display());
    Ok(format!("Backup created at: {}", backup_path.display()))
}

// =============================================================================
// BACKUP ANALYSIS
// =============================================================================

#[tauri::command]
pub async fn analyze_backup_file(
    path: PathBuf,
    manager: State<'_, AppSettingsManager>,
) -> Result<BackupAnalysis, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "rcman" {
        return Err(crate::localized_error!(
            "backendErrors.backup.unsupportedArchive"
        ));
    }

    // Read manifest to detect format
    let file = File::open(&path).map_err(|e| format!("Failed to open .rcman: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid .rcman file: {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json")?;

    let manifest_json: serde_json::Value = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest: {e}"))?;

    // Detect format: rcman has root "version" as int
    let is_rcman_format = manifest_json
        .get("version")
        .and_then(|v| v.as_u64())
        .is_some();

    if is_rcman_format {
        let analysis = manager.backup().analyze(&path).map_err(|e| {
            error!("❌ Backup analysis failed: {}", e);
            format!("Analysis failed: {}", e)
        })?;

        let contents =
            BackupContentsInfo {
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
                    .iter()
                    .any(|id| id == "rclone.conf" || id == "rclone_config"),
                remote_count: analysis.manifest.contents.sub_settings.get("remotes").map(
                    |r| match r {
                        rcman::SubSettingsManifestEntry::MultiFile(items) => items.len(),
                        rcman::SubSettingsManifestEntry::SingleFile(_) => 1,
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => profiles
                            .values()
                            .map(|entry| match entry {
                                rcman::ProfileEntry::Single(_) => 1,
                                rcman::ProfileEntry::Multiple(items) => items.len(),
                            })
                            .sum(),
                    },
                ),
                remote_names: analysis.manifest.contents.sub_settings.get("remotes").map(
                    |r| match r {
                        rcman::SubSettingsManifestEntry::MultiFile(items) => items.clone(),
                        rcman::SubSettingsManifestEntry::SingleFile(name) => vec![name.clone()],
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => {
                            let mut names = Vec::new();
                            for (profile, entry) in profiles {
                                match entry {
                                    rcman::ProfileEntry::Single(item) => {
                                        names.push(format!("{}: {}", profile, item));
                                    }
                                    rcman::ProfileEntry::Multiple(items) => {
                                        for item in items {
                                            names.push(format!("{}: {}", profile, item));
                                        }
                                    }
                                }
                            }
                            names
                        }
                    },
                ),
                profiles: analysis
                    .manifest
                    .contents
                    .sub_settings
                    .get("remotes")
                    .and_then(|r| match r {
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => {
                            Some(profiles.keys().cloned().collect())
                        }
                        _ => None,
                    }),
            };

        Ok(BackupAnalysis {
            is_encrypted: analysis.is_encrypted,
            archive_type: if analysis.requires_password {
                "zip-aes".into()
            } else {
                "zip".into()
            },
            format_version: analysis.format_version,
            created_at: Some(analysis.created_at),
            backup_type: Some(analysis.backup_type),
            user_note: analysis.user_note,
            contents: Some(contents),
            is_legacy: Some(false),
        })
    } else {
        // DEPRECATION (2026-2027): Delete this else block when removing legacy support
        use super::legacy_restore::BackupManifest;

        let manifest: BackupManifest = serde_json::from_value(manifest_json)
            .map_err(|e| format!("Failed to parse legacy manifest: {e}"))?;

        Ok(BackupAnalysis {
            is_encrypted: manifest.backup.encrypted,
            archive_type: manifest.backup.compression,
            format_version: manifest.format.version,
            created_at: Some(manifest.backup.created_at),
            backup_type: Some(manifest.backup.backup_type),
            user_note: manifest.metadata.and_then(|m| m.user_note),
            contents: Some(BackupContentsInfo {
                settings: manifest.contents.settings,
                backend_config: manifest.contents.backend_config,
                rclone_config: manifest.contents.rclone_config,
                remote_count: manifest.contents.remote_configs.as_ref().map(|r| r.count),
                remote_names: manifest.contents.remote_configs.and_then(|r| r.names),
                profiles: Some(vec!["default".to_string()]), // Legacy backups always restore to "default"
            }),
            is_legacy: Some(true), // This is a legacy backup without profile support
        })
    }
}
