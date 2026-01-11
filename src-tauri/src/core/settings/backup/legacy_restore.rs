//! Legacy Backup Restore (For backward compatibility with 7z backups)
//!
//! **DEPRECATION NOTICE (2024-12)**
//! This module is kept for backward compatibility with legacy backups.
//! It will be removed approximately **2026-2027**.
//!
//! **PROFILE MAPPING FOR LEGACY BACKUPS**
//! Legacy backups were created before the profile system was introduced.
//! When restoring, all settings are mapped to the "default" profile:
//! - `backend.json` → `backend/profiles/default.json` (singlefile with profiles)
//! - `remotes/*.json` → `remotes/profiles/default/{remote}.json` (multifile with profiles)
//! - `rclone.conf` → system rclone config (shared across profiles)
//! - `settings.json` → root settings.json (shared across profiles)
//!
//! This ensures that old backups work correctly with the new profile system
//! by treating them as if they were always part of the "default" profile.
//!
//! To remove: Delete this file and remove its `mod` declaration from `mod.rs`.

use crate::core::settings::AppSettingsManager;
use serde::{Deserialize, Serialize};

use crate::{
    rclone::{commands::remote::create_remote, queries::get_rclone_config_file},
    utils::types::{
        core::RcloneState,
        events::{REMOTE_CACHE_CHANGED, SYSTEM_SETTINGS_CHANGED},
    },
};
use log::{debug, error, info, warn};
use serde_json::json;
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

// =============================================================================
// LEGACY MANIFEST TYPES (Only used for parsing old backup format)
// =============================================================================

/// Inner data archive name
const INNER_DATA_ARCHIVE_NAME: &str = "data";

/// The root structure of the legacy `manifest.json` file
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
    pub created_at: String,
    #[serde(rename = "type")]
    pub backup_type: String,
    pub encrypted: bool,
    pub compression: String,
}

/// "contents" section of the manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentsInfo {
    pub settings: bool,
    pub backend_config: bool,
    pub rclone_config: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_configs: Option<RemoteConfigsInfo>,
}

/// "remote_configs" nested in "contents"
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
    pub sha256: String,
    pub size_bytes: u64,
    pub compressed_size_bytes: u64,
}

/// "metadata" section of the manifest (optional)
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
}

/// Calculates SHA-256 hash and file size
fn calculate_file_hash(path: &Path) -> Result<(String, u64), String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut hasher = Sha256::new();
    let bytes_copied =
        std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Failed to read file: {e}"))?;
    let hash = format!("{:x}", hasher.finalize());
    Ok((hash, bytes_copied))
}

// =============================================================================
// RESTORE FUNCTIONALITY
// =============================================================================

/// Restores a legacy app-format backup
///
/// **IMPORTANT: Profile Mapping**
/// Legacy backups were created before the profile system existed.
/// All settings are restored to the "default" profile:
/// - `backend.json` → `backend/profiles/default.json` (singlefile with profiles)
/// - `remotes/*.json` → `remotes/profiles/default/{remote}.json` (multifile with profiles)
/// - `rclone.conf` → system rclone config (shared)
/// - `settings.json` → root settings.json (shared)
pub async fn restore_legacy_backup(
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
        return Err(crate::localized_error!(
            "backendErrors.backup.integrityFailed"
        ));
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
        (true, false) => Err(crate::localized_error!(
            "backendErrors.backup.encryptedPasswordRequired"
        )),
        (false, true) => {
            warn!("Password provided for unencrypted backup. Ignoring.");
            Ok(None)
        }
        (true, true) => Ok(Some(password.unwrap().trim().to_string())),
        (false, false) => Ok(None),
    }
}

/// Extracts a 7z archive with password
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
    let manager = app_handle.state::<AppSettingsManager>();
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

        app_handle.emit(REMOTE_CACHE_CHANGED, ()).ok();
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
        // Legacy backup: backend.json goes to backend/profiles/backend.json (singlefile with profiles)
        "backend.json" => {
            let backend_profiles_dir = config_dir.join("backend").join("profiles");
            fs::create_dir_all(&backend_profiles_dir)
                .map_err(|e| format!("Failed to create backend profiles dir: {e}"))?;
            backend_profiles_dir.join("backend.json")
        }
        "rclone.conf" => get_rclone_config_file(app_handle.clone())
            .await
            .unwrap_or_else(|_| config_dir.join("rclone.conf")),
        // Legacy backup: remotes/*.json goes to remotes/profiles/default/*.json (multifile with profiles)
        name if name.starts_with("remotes/") => {
            let remote_name = name.trim_start_matches("remotes/");
            let remotes_default_dir = config_dir.join("remotes").join("profiles").join("default");
            fs::create_dir_all(&remotes_default_dir)
                .map_err(|e| format!("Failed to create remotes default profile dir: {e}"))?;
            remotes_default_dir.join(remote_name)
        }
        _ => {
            debug!("Skipping unknown file: {}", file_name);
            return Err(format!("Unknown file: {}", file_name));
        }
    };

    Ok(path)
}
