//! Restore management with format detection
//!
//! Supports both rcman library format and legacy app format backups.

use crate::{
    core::settings::backup::backup_manager::{INNER_DATA_ARCHIVE_NAME, calculate_file_hash},
    rclone::{commands::remote::create_remote, queries::get_rclone_config_file},
    utils::types::{
        all_types::RcloneState,
        backup_types::BackupManifest,
        events::{REMOTE_PRESENCE_CHANGED, SYSTEM_SETTINGS_CHANGED},
    },
};
use log::{debug, error, info, warn};
use serde_json::json;
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

// -----------------------------------------------------------------------------
// BACKUP FORMAT VERSION DETECTION
// -----------------------------------------------------------------------------

/// Backup format versions for backward compatibility
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFormatVersion {
    /// App's original format (manifest with format.version string, data.7z/data.zip)
    AppLegacy,
    /// New rcman library format (manifest with root version int, data.zip)
    Rcman,
    /// Unknown format
    Unknown,
}

/// Detects the backup format by analyzing the manifest JSON structure
fn detect_manifest_format(manifest_json: &serde_json::Value) -> BackupFormatVersion {
    // rcman format has root-level "version" as integer
    if manifest_json
        .get("version")
        .and_then(|v| v.as_u64())
        .is_some()
    {
        return BackupFormatVersion::Rcman;
    }

    // App legacy format has "format.version" as string
    if manifest_json
        .get("format")
        .and_then(|f| f.get("version"))
        .and_then(|v| v.as_str())
        .is_some()
    {
        return BackupFormatVersion::AppLegacy;
    }

    BackupFormatVersion::Unknown
}

// -----------------------------------------------------------------------------
// MAIN RESTORE COMMAND (With format routing)
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn restore_settings(
    backup_path: PathBuf,
    password: Option<String>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting restore from: {:?}", backup_path);

    // Open and read manifest to detect format
    let file = File::open(&backup_path).map_err(|e| format!("Failed to open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid .rcman file: {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json")?;

    let manifest_json: serde_json::Value = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest: {e}"))?;

    // Route to appropriate handler based on format
    let format = detect_manifest_format(&manifest_json);
    info!("Detected backup format: {:?}", format);

    match format {
        BackupFormatVersion::Rcman => {
            restore_rcman_backup(&backup_path, password, &manager, &app_handle).await
        }
        BackupFormatVersion::AppLegacy => {
            restore_legacy_backup(&backup_path, password, &manifest_json, &app_handle).await
        }
        BackupFormatVersion::Unknown => Err("Unknown backup format".into()),
    }
}

// -----------------------------------------------------------------------------
// RCMAN FORMAT RESTORE
// -----------------------------------------------------------------------------

async fn restore_rcman_backup(
    backup_path: &Path,
    password: Option<String>,
    manager: &rcman::SettingsManager<rcman::JsonStorage>,
    app_handle: &AppHandle,
) -> Result<String, String> {
    info!("Restoring using rcman library...");

    // Build restore options
    let mut options = rcman::RestoreOptions::from_path(backup_path)
        .restore_settings(true)
        .restore_sub_settings("remotes")
        .overwrite(true)
        .verify_checksum(true);

    if let Some(pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    // Perform restore
    let result = manager
        .backup()
        .restore(options)
        .map_err(|e| format!("Restore failed: {}", e))?;

    // Emit events to notify frontend
    app_handle.emit(REMOTE_PRESENCE_CHANGED, ()).ok();

    let restored_count = result.restored.len();
    let skipped_count = result.skipped.len();

    info!(
        "✅ Restore complete: {} restored, {} skipped",
        restored_count, skipped_count
    );

    Ok(format!(
        "Settings restored successfully ({} items restored, {} skipped)",
        restored_count, skipped_count
    ))
}

// -----------------------------------------------------------------------------
// LEGACY FORMAT RESTORE (For backward compatibility with 7z backups)
// -----------------------------------------------------------------------------

async fn restore_legacy_backup(
    backup_path: &Path,
    password: Option<String>,
    manifest_json: &serde_json::Value,
    app_handle: &AppHandle,
) -> Result<String, String> {
    info!("Restoring legacy app format backup...");

    // Parse legacy manifest
    let manifest: BackupManifest = serde_json::from_value(manifest_json.clone())
        .map_err(|e| format!("Failed to parse legacy manifest: {e}"))?;

    info!(
        "Restoring backup v{}, created {}",
        manifest.format.version, manifest.backup.created_at
    );

    // Validate password
    let validated_password = validate_restore_password(password, manifest.backup.encrypted)?;

    // Create temp workspace
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;

    // Re-open archive to extract inner data
    let file = File::open(backup_path).map_err(|e| format!("Failed to open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid .rcman file: {e}"))?;

    // Extract inner archive
    let inner_archive_filename = format!(
        "{}.{}",
        INNER_DATA_ARCHIVE_NAME, manifest.backup.compression
    );
    let mut inner_archive_file = archive
        .by_name(&inner_archive_filename)
        .map_err(|_| format!("Missing data file: {}", inner_archive_filename))?;

    let inner_archive_path = temp_dir.path().join(&inner_archive_filename);
    let mut extracted_file = File::create(&inner_archive_path)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    std::io::copy(&mut inner_archive_file, &mut extracted_file)
        .map_err(|e| format!("Failed to extract data: {e}"))?;

    // Verify integrity
    info!("Verifying integrity...");
    let (calculated_hash, _) = calculate_file_hash(&inner_archive_path)?;
    if calculated_hash != manifest.integrity.sha256 {
        error!(
            "Integrity check FAILED! Expected: {}, Got: {}",
            manifest.integrity.sha256, calculated_hash
        );
        return Err("Integrity check failed! Backup may be corrupted.".into());
    }
    info!("Integrity verified.");

    // Extract data contents
    let extracted_data_dir = temp_dir.path().join("extracted");
    fs::create_dir_all(&extracted_data_dir)
        .map_err(|e| format!("Failed to create extraction dir: {e}"))?;

    info!("Extracting backup contents...");
    match manifest.backup.compression.as_str() {
        "7z" => extract_7z_archive(
            &inner_archive_path,
            &extracted_data_dir,
            validated_password.as_deref(),
        )?,
        "zip" => extract_zip_archive(&inner_archive_path, &extracted_data_dir)?,
        ext => return Err(format!("Unsupported compression: {}", ext)),
    }

    // Restore files
    info!("Restoring files...");
    restore_legacy_files(&extracted_data_dir, app_handle).await
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/// Validates password for restore operation
fn validate_restore_password(
    password: Option<String>,
    is_encrypted: bool,
) -> Result<Option<String>, String> {
    let has_password = password.as_ref().is_some_and(|p| !p.trim().is_empty());

    match (is_encrypted, has_password) {
        (true, false) => Err("This backup is encrypted. Password required.".into()),
        (false, true) => {
            warn!("Password provided for unencrypted backup. Ignoring.");
            Ok(None)
        }
        (true, true) => Ok(Some(password.unwrap().trim().to_string())),
        (false, false) => Ok(None),
    }
}

/// Extracts a 7z archive with password
///
/// # Deprecation Notice (2024-12)
/// This function is kept for backward compatibility with legacy backups.
/// It will be maintained until approximately **2026-2027**.
fn extract_7z_archive(
    archive_path: &Path,
    extract_to: &Path,
    password: Option<&str>,
) -> Result<(), String> {
    if let Some(pw) = password {
        sevenz_rust2::decompress_file_with_password(archive_path, extract_to, pw.into())
            .map_err(|e| format!("Failed to extract 7z archive: {e}"))
    } else {
        sevenz_rust2::decompress_file(archive_path, extract_to)
            .map_err(|e| format!("Failed to extract 7z archive: {e}"))
    }
}

/// Extracts a zip archive (legacy unencrypted)
fn extract_zip_archive(archive_path: &Path, extract_to: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| format!("Failed to open zip: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {e}"))?;
        let out_path = extract_to.join(file.name());

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("Failed to create dir: {e}"))?;
        } else {
            let mut outfile =
                File::create(&out_path).map_err(|e| format!("Failed to create file: {e}"))?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| format!("Copy error: {e}"))?;
        }
    }
    Ok(())
}

/// Restores legacy format files from extracted directory
async fn restore_legacy_files(
    extracted_dir: &Path,
    app_handle: &AppHandle,
) -> Result<String, String> {
    info!("Restoring from: {:?}", extracted_dir);

    // Get config directory from rcman manager
    let manager = app_handle.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    let config_dir = manager.config().config_dir.clone();

    // Restore rclone remotes via RC API
    let remote_config_dir = extracted_dir.join("remote_config");
    if remote_config_dir.exists() {
        info!("Restoring rclone remotes via RC API");
        for entry in walkdir::WalkDir::new(&remote_config_dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json")
                && let Err(e) = restore_remote_from_file(path, app_handle).await
            {
                warn!("Failed to restore remote from {:?}: {}", path, e);
            }
        }
    }

    // Restore config files
    for entry in walkdir::WalkDir::new(extracted_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let relative_path = entry.path().strip_prefix(extracted_dir).unwrap();
        let file_name = relative_path.to_string_lossy();

        // Skip remote_config (already handled)
        if file_name.starts_with("remote_config") {
            continue;
        }

        let dest_path = determine_restore_path(&file_name, &config_dir, app_handle).await?;

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
        }

        fs::copy(entry.path(), &dest_path)
            .map_err(|e| format!("Failed to copy {}: {}", file_name, e))?;

        info!("Restored: {:?}", dest_path);
    }

    // Emit events
    let settings_path = config_dir.join("settings.json");
    if settings_path.exists() {
        let settings_content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {e}"))?;
        let new_settings: serde_json::Value = serde_json::from_str(&settings_content)
            .map_err(|e| format!("Failed to parse settings: {e}"))?;

        app_handle.emit(REMOTE_PRESENCE_CHANGED, ()).ok();
        app_handle
            .emit(
                SYSTEM_SETTINGS_CHANGED,
                serde_json::to_value(new_settings.get("app_settings")).unwrap(),
            )
            .ok();
    }

    Ok("Settings restored successfully".into())
}

/// Restores a remote from a JSON config file
async fn restore_remote_from_file(path: &Path, app_handle: &AppHandle) -> Result<(), String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;

    let mut config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))?;

    // Mark as remote config
    if let Some(obj) = config.as_object_mut() {
        obj.insert("config_is_local".to_string(), json!("false"));
    }

    let remote_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid filename")?
        .to_string();

    create_remote(
        app_handle.clone(),
        remote_name.clone(),
        config,
        app_handle.state::<RcloneState>(),
    )
    .await
    .map_err(|e| format!("Failed to create remote '{}': {}", remote_name, e))?;

    info!("Restored remote: {}", remote_name);
    Ok(())
}

/// Determines the correct restore path for a file
async fn determine_restore_path(
    file_name: &str,
    config_dir: &Path,
    app_handle: &AppHandle,
) -> Result<PathBuf, String> {
    let path = match file_name {
        "settings.json" => config_dir.join("settings.json"),
        "backend.json" => config_dir.join("backend.json"),
        "rclone.conf" => get_rclone_config_file(app_handle.clone())
            .await
            .unwrap_or_else(|_| config_dir.join("rclone.conf")),
        name if name.starts_with("remotes/") => {
            let remote_name = name.trim_start_matches("remotes/");
            let remotes_dir = config_dir.join("remotes");
            fs::create_dir_all(&remotes_dir)
                .map_err(|e| format!("Failed to create remotes dir: {e}"))?;
            remotes_dir.join(remote_name)
        }
        _ => {
            debug!("Skipping unknown file: {}", file_name);
            return Err(format!("Unknown file: {}", file_name));
        }
    };

    Ok(path)
}
