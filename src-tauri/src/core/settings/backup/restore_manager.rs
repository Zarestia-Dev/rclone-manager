use crate::{
    core::{
        check_binaries::find_7z_executable,
        settings::backup::backup_manager::{INNER_DATA_ARCHIVE_NAME, calculate_file_hash},
    },
    rclone::{commands::remote::create_remote, queries::get_rclone_config_file},
    utils::types::{
        backup_types::BackupManifest,
        events::{REMOTE_PRESENCE_CHANGED, SYSTEM_SETTINGS_CHANGED},
        settings::SettingsState,
    },
};
use log::{debug, error, info, warn};
use serde_json::json;
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

// -----------------------------------------------------------------------------
// MAIN RESTORE COMMAND
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn restore_settings(
    backup_path: PathBuf,
    password: Option<String>,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting restore from: {:?}", backup_path);

    // Create workspace
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;

    // Open and validate .rcman
    let file = File::open(&backup_path).map_err(|e| format!("Failed to open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid .rcman file: {e}"))?;

    let manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Invalid .rcman: Missing manifest.json")?;

    let manifest: BackupManifest = serde_json::from_reader(manifest_file)
        .map_err(|e| format!("Failed to parse manifest: {e}"))?;

    info!(
        "Restoring backup v{}, created {}",
        manifest.format.version, manifest.backup.created_at
    );

    // Validate password
    let validated_password = validate_restore_password(password, manifest.backup.encrypted)?;

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
    restore_files(&extracted_data_dir, state, app_handle).await
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
fn extract_7z_archive(
    archive_path: &Path,
    extract_to: &Path,
    password: Option<&str>,
) -> Result<(), String> {
    let seven_zip = find_7z_executable().map_err(|e| format!("7z not found: {e}"))?;

    let mut cmd = Command::new(seven_zip);
    cmd.arg("x") // Extract with paths
        .arg(archive_path)
        .arg(format!("-o{}", extract_to.display()))
        .arg("-y") // Yes to all prompts
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    if let Some(pw) = password {
        // Pass password directly with -p flag (no space between -p and password)
        cmd.arg(format!("-p{}", pw));
    } else {
        // Explicitly no password
        cmd.arg("-p-");
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute 7z: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Wrong password") || stderr.contains("Cannot open encrypted") {
            return Err("Wrong password".into());
        }
        return Err(format!("7z extraction failed: {}", stderr));
    }

    Ok(())
}

/// Extracts a zip archive
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

/// Restores files from extracted directory
async fn restore_files(
    extracted_dir: &Path,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Restoring from: {:?}", extracted_dir);

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
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Err(e) = restore_remote_from_file(path, &app_handle).await {
                    warn!("Failed to restore remote from {:?}: {}", path, e);
                }
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

        let dest_path = determine_restore_path(&file_name, &state, &app_handle).await?;

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
        }

        fs::copy(entry.path(), &dest_path)
            .map_err(|e| format!("Failed to copy {}: {}", file_name, e))?;

        info!("Restored: {:?}", dest_path);
    }

    // Emit events
    let settings_path = state.config_dir.join("settings.json");
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
        app_handle.state::<crate::RcloneState>(),
    )
    .await
    .map_err(|e| format!("Failed to create remote '{}': {}", remote_name, e))?;

    info!("Restored remote: {}", remote_name);
    Ok(())
}

/// Determines the correct restore path for a file
async fn determine_restore_path(
    file_name: &str,
    state: &SettingsState<tauri::Wry>,
    app_handle: &AppHandle,
) -> Result<PathBuf, String> {
    let path = match file_name {
        "settings.json" => state.config_dir.join("settings.json"),
        "backend.json" => state.config_dir.join("backend.json"),
        "rclone.conf" => {
            // Get configured rclone path
            let store = state.store.lock().await;
            let settings = store.get("app_settings").unwrap_or_else(|| json!({}));
            let custom_path = settings
                .get("core")
                .and_then(|c| c.get("rclone_config_file"))
                .and_then(|p| p.as_str())
                .filter(|s| !s.trim().is_empty());

            if let Some(custom) = custom_path {
                PathBuf::from(custom)
            } else {
                get_rclone_config_file(app_handle.clone())
                    .await
                    .unwrap_or_else(|_| state.config_dir.join("rclone.conf"))
            }
        }
        name if name.starts_with("remotes/") => {
            let remote_name = name.trim_start_matches("remotes/");
            let remotes_dir = state.config_dir.join("remotes");
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
