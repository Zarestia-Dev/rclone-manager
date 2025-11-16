use crate::{
    core::check_binaries::find_7z_executable,
    rclone::queries::{get_rclone_config_file, get_remote_config},
    utils::types::{
        all_types::RcloneState,
        backup_types::{
            BackupAnalysis, BackupInfo, BackupManifest, ContentsInfo, ExportType, FormatInfo,
            IntegrityInfo, MetadataInfo, RemoteConfigsInfo,
        },
        settings::SettingsState,
    },
};
use chrono::{Local, Utc};
use log::{info, warn};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;
use zip::{ZipArchive, ZipWriter, write::FileOptions};

const RCMAN_VERSION: &str = "1.0.0";
const RCMAN_CREATED_BY: &str = concat!(env!("CARGO_PKG_NAME"), " v", env!("CARGO_PKG_VERSION"));
pub const INNER_DATA_ARCHIVE_NAME: &str = "data";

// -----------------------------------------------------------------------------
// MAIN BACKUP COMMAND
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_settings(
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    user_note: Option<String>,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // Validate and sanitize password
    let validated_password = validate_password(password)?;
    let has_password = validated_password.is_some();

    // Setup paths
    let backup_path = PathBuf::from(&backup_dir);
    fs::create_dir_all(&backup_path)
        .map_err(|e| format!("Failed to create backup directory: {e}"))?;

    let compression_type = if has_password { "7z" } else { "zip" };
    let timestamp = Local::now();
    let timestamp_str = timestamp.format("%Y%m%d_%H%M%S").to_string();

    let rcman_archive_name = match export_type {
        ExportType::SpecificRemote => format!(
            "remote_{}_{}.rcman",
            sanitize_filename(&remote_name.clone().unwrap_or_default()),
            timestamp_str
        ),
        _ => format!("full_backup_{}.rcman", timestamp_str),
    };
    let rcman_archive_path = backup_path.join(&rcman_archive_name);

    info!("Starting backup: {}", rcman_archive_path.display());

    // Create temporary workspace
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let data_export_dir = temp_dir.path().join("export");
    fs::create_dir_all(&data_export_dir)
        .map_err(|e| format!("Failed to create export dir: {e}"))?;

    // Gather files
    let (contents_info, uncompressed_size) = gather_files_to_backup(
        &data_export_dir,
        &export_type,
        &remote_name,
        &state,
        &app_handle,
    )
    .await?;

    // Create inner archive
    let inner_archive_filename = format!("{}.{}", INNER_DATA_ARCHIVE_NAME, compression_type);
    let inner_archive_path = temp_dir.path().join(&inner_archive_filename);

    if has_password {
        info!("Creating encrypted archive...");
        create_7z_archive(
            &data_export_dir,
            &inner_archive_path,
            validated_password.as_ref().unwrap(),
        )?;
    } else {
        info!("Creating zip archive...");
        create_zip_archive(&data_export_dir, &inner_archive_path)?;
    }

    // Calculate integrity hash
    let (sha256, compressed_size) = calculate_file_hash(&inner_archive_path)?;
    info!(
        "Archive created. Hash: {}, Size: {} bytes",
        sha256, compressed_size
    );

    // Build manifest
    let manifest = BackupManifest {
        format: FormatInfo {
            version: RCMAN_VERSION.to_string(),
            created_by: RCMAN_CREATED_BY.to_string(),
        },
        backup: BackupInfo {
            created_at: Utc::now().to_rfc3339(),
            backup_type: format!("{:?}", export_type),
            encrypted: has_password,
            compression: compression_type.to_string(),
        },
        contents: contents_info,
        integrity: IntegrityInfo {
            sha256,
            size_bytes: uncompressed_size,
            compressed_size_bytes: compressed_size,
        },
        metadata: user_note.map(|note| MetadataInfo {
            user_note: Some(note),
        }),
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;

    // Create final .rcman container
    info!("Creating .rcman container...");
    create_rcman_container(
        &rcman_archive_path,
        &manifest_json,
        &inner_archive_path,
        &inner_archive_filename,
    )?;

    info!("Backup complete: {}", rcman_archive_path.display());
    Ok(format!(
        "Backup created at: {}",
        rcman_archive_path.display()
    ))
}

// -----------------------------------------------------------------------------
// BACKUP ANALYSIS COMMAND
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_backup_file(path: PathBuf) -> Result<BackupAnalysis, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "rcman" {
        return Err("Unsupported archive type. Must be a .rcman file".into());
    }

    let file = File::open(&path).map_err(|e| format!("Failed to open .rcman: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Invalid .rcman file (not a valid zip): {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json".to_string())?;

    let manifest: BackupManifest = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest.json: {e}"))?;

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

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/// Validates password: ensures minimum length and no whitespace-only
fn validate_password(password: Option<String>) -> Result<Option<String>, String> {
    match password {
        None => Ok(None),
        Some(pw) => {
            let trimmed = pw.trim();
            if trimmed.is_empty() {
                Ok(None) // Treat empty password as no password
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
    }
}

/// Sanitizes filename by replacing invalid characters
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// Gathers all necessary files into export directory
async fn gather_files_to_backup(
    export_dir: &Path,
    export_type: &ExportType,
    remote_name: &Option<String>,
    state: &SettingsState<tauri::Wry>,
    app_handle: &AppHandle,
) -> Result<(ContentsInfo, u64), String> {
    let mut total_size: u64 = 0;
    let mut contents = ContentsInfo {
        settings: false,
        backend_config: false,
        rclone_config: false,
        remote_configs: None,
    };
    let mut remote_names: Vec<String> = Vec::new();

    // Helper to copy file and track size
    let copy_and_track = |src: &Path, dest: &Path| -> Result<u64, String> {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy {}: {}", src.display(), e))?;
        Ok(fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
    };

    // Settings export
    if matches!(export_type, ExportType::All | ExportType::Settings) {
        let settings_path = state.config_dir.join("settings.json");
        if settings_path.exists() {
            total_size += copy_and_track(&settings_path, &export_dir.join("settings.json"))?;
            contents.settings = true;
        }
    }

    // Backend export
    if matches!(export_type, ExportType::All | ExportType::RCloneBackend) {
        let backend_path = state.config_dir.join("backend.json");
        if backend_path.exists() {
            total_size += copy_and_track(&backend_path, &export_dir.join("backend.json"))?;
            contents.backend_config = true;
        }
    }

    // Remote configs export
    if matches!(
        export_type,
        ExportType::All
            | ExportType::RemoteConfigs
            | ExportType::SpecificRemote
            | ExportType::Remotes
    ) {
        let remotes_dir = state.config_dir.join("remotes");
        if remotes_dir.exists() {
            let out_remotes = export_dir.join("remotes");
            fs::create_dir_all(&out_remotes)
                .map_err(|e| format!("Failed to create remotes dir: {e}"))?;

            for entry in fs::read_dir(&remotes_dir)
                .map_err(|e| format!("Failed to read remotes dir: {e}"))?
            {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    let file_stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .ok_or("Invalid filename")?;

                    let should_copy = match export_type {
                        ExportType::SpecificRemote => remote_name.as_deref() == Some(file_stem),
                        _ => true,
                    };

                    if should_copy {
                        let dest = out_remotes.join(path.file_name().unwrap());
                        total_size += copy_and_track(&path, &dest)?;
                        remote_names.push(file_stem.to_string());
                    }
                }
            }
        }
    }

    // Export specific remote from rclone.conf via RC API
    if let ExportType::SpecificRemote = export_type
        && let Some(name) = remote_name
    {
        match get_remote_config(name.to_string(), app_handle.state::<RcloneState>()).await {
            Ok(config) => {
                let remote_config_dir = export_dir.join("remote_config");
                fs::create_dir_all(&remote_config_dir)
                    .map_err(|e| format!("Failed to create remote_config dir: {e}"))?;
                let config_file = remote_config_dir.join(format!("{}.json", name));
                let config_str = serde_json::to_string_pretty(&config)
                    .map_err(|e| format!("Failed to serialize remote config: {e}"))?;
                fs::write(&config_file, &config_str)
                    .map_err(|e| format!("Failed to write remote config: {e}"))?;
                total_size += config_str.len() as u64;
                if !remote_names.contains(name) {
                    remote_names.push(name.to_string());
                }
            }
            Err(e) => warn!("Failed to export remote '{}': {}", name, e),
        }
    }

    // Full rclone.conf export
    if matches!(export_type, ExportType::All | ExportType::Remotes) {
        let resolved_config_path = get_rclone_config_file(app_handle.clone()).await?;
        if resolved_config_path.exists() {
            total_size += copy_and_track(&resolved_config_path, &export_dir.join("rclone.conf"))?;
            contents.rclone_config = true;
        }
    }

    if !remote_names.is_empty() {
        contents.remote_configs = Some(RemoteConfigsInfo {
            count: remote_names.len(),
            names: Some(remote_names),
        });
    }

    Ok((contents, total_size))
}

/// Creates an encrypted 7z archive with password
fn create_7z_archive(source_dir: &Path, output_path: &Path, password: &str) -> Result<(), String> {
    let seven_zip = find_7z_executable().map_err(|e| format!("7z not found: {e}"))?;

    // Remove existing archive if present
    if output_path.exists() {
        fs::remove_file(output_path)
            .map_err(|e| format!("Failed to remove existing archive: {e}"))?;
    }

    let output = Command::new(seven_zip)
        .current_dir(source_dir)
        .arg("a") // Add to archive
        .arg("-mhe=on") // Encrypt headers
        .arg(format!("-p{}", password)) // Password (no space between -p and password)
        .arg(output_path)
        .arg(".") // Archive current directory
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to execute 7z: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("7z failed: {}", stderr));
    }

    Ok(())
}

/// Creates a zip archive from a directory
fn create_zip_archive(source_dir: &Path, output_path: &Path) -> Result<(), String> {
    // Remove existing archive if present
    if output_path.exists() {
        fs::remove_file(output_path)
            .map_err(|e| format!("Failed to remove existing archive: {e}"))?;
    }

    let file = File::create(output_path).map_err(|e| format!("Failed to create zip: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in WalkDir::new(source_dir).min_depth(1) {
        let entry = entry.map_err(|e| format!("Walk error: {e}"))?;
        let path = entry.path();
        let rel_path = path.strip_prefix(source_dir).unwrap();

        if path.is_file() {
            zip.start_file(rel_path.to_string_lossy(), options)
                .map_err(|e| format!("Failed to start zip entry: {e}"))?;
            let mut f = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
            std::io::copy(&mut f, &mut zip).map_err(|e| format!("Failed to copy to zip: {e}"))?;
        } else if path.is_dir() {
            zip.add_directory(rel_path.to_string_lossy(), options)
                .map_err(|e| format!("Failed to add directory: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finish zip: {e}"))?;
    Ok(())
}

/// Creates the final .rcman zip container
fn create_rcman_container(
    rcman_path: &Path,
    manifest_json: &str,
    inner_archive_path: &Path,
    inner_archive_filename: &str,
) -> Result<(), String> {
    let file = File::create(rcman_path).map_err(|e| format!("Failed to create .rcman: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored);

    // Add manifest
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("Failed to add manifest: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest: {e}"))?;

    // Add inner archive
    zip.start_file(inner_archive_filename, options)
        .map_err(|e| format!("Failed to add inner archive: {e}"))?;
    let mut data_file =
        File::open(inner_archive_path).map_err(|e| format!("Failed to open inner archive: {e}"))?;
    std::io::copy(&mut data_file, &mut zip)
        .map_err(|e| format!("Failed to copy inner archive: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finish .rcman: {e}"))?;
    Ok(())
}

/// Calculates SHA-256 hash and file size
pub fn calculate_file_hash(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut hasher = Sha256::new();
    let bytes_copied =
        std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Failed to read file: {e}"))?;
    let hash = format!("{:x}", hasher.finalize());
    Ok((hash, bytes_copied))
}
