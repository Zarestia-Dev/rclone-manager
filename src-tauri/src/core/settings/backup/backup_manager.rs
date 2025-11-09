use crate::{
    core::settings::backup::archive_utils::{find_7z_executable, is_7z_encrypted},
    rclone::queries::{get_rclone_config_file, get_remote_config},
    utils::types::{
        all_types::{BackupAnalysis, ExportType, RcloneState},
        settings::SettingsState,
    },
};
use chrono::Local;
use log::{debug, info, warn};
use serde_json::json;
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    process::Command,
};
use tauri::{AppHandle, Manager, State};
use zip::{ZipWriter, write::FileOptions};

#[tauri::command]
pub async fn backup_settings(
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let backup_path = PathBuf::from(&backup_dir);
    debug!("Creating backup directory at: {}", backup_path.display());
    fs::create_dir_all(&backup_path)
        .map_err(|e| format!("Failed to create backup directory: {e}"))?;

    let has_password = password.as_ref().is_some_and(|p| !p.trim().is_empty());
    let timestamp = Local::now();
    let archive_name = match remote_name.clone() {
        Some(name) => format!(
            "remote_{}_export_{}.{}",
            name.replace(" ", "_"),
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if has_password { "7z" } else { "zip" }
        ),
        _ => format!(
            "settings_export_{}.{}",
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if has_password { "7z" } else { "zip" }
        ),
    };
    let archive_path = backup_path.join(&archive_name);

    info!(
        "Starting backup process. Archive will be created at: {}",
        archive_path.display()
    );

    let tmp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let export_dir = tmp_dir.path();
    debug!(
        "Temporary export directory created at: {}",
        export_dir.display()
    );

    let mut exported_items = vec![];
    let mut config_path: Option<PathBuf> = None;

    // Settings export
    if export_type == ExportType::All || export_type == ExportType::Settings {
        let settings_path = state.config_dir.join("settings.json");
        debug!("Checking for settings.json at: {}", settings_path.display());
        if settings_path.exists() {
            fs::copy(&settings_path, export_dir.join("settings.json")).ok();
            info!("settings.json copied to export directory.");
            exported_items.push("settings");
        }
    }

    // Backend export
    if export_type == ExportType::All || export_type == ExportType::RCloneBackend {
        let backend_path = state.config_dir.join("backend.json");
        debug!("Checking for backend.json at: {}", backend_path.display());
        if backend_path.exists() {
            fs::copy(&backend_path, export_dir.join("backend.json")).ok();
            info!("backend.json copied to export directory.");
            exported_items.push("rclone-backend");
        }
    }

    // Remote configs export (JSON files in remotes/ directory)
    if export_type == ExportType::All
        || export_type == ExportType::RemoteConfigs
        || export_type == ExportType::SpecificRemote
    {
        let remotes_dir = state.config_dir.join("remotes");
        let out_remotes = export_dir.join("remotes");
        debug!(
            "Preparing to copy remote configs from: {}",
            remotes_dir.display()
        );
        fs::create_dir_all(&out_remotes).ok();

        if remotes_dir.exists() {
            for entry in match fs::read_dir(&remotes_dir) {
                Ok(rd) => rd,
                Err(_) => {
                    warn!("⚠️ Failed to read remotes directory.");
                    return Err("⚠️ Failed to read remotes directory.".to_string());
                }
            } {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if export_type == ExportType::SpecificRemote {
                        if let Some(name) = &remote_name
                            && path.file_stem().unwrap().to_str().unwrap() == name
                        {
                            fs::copy(&path, out_remotes.join(path.file_name().unwrap())).ok();
                            info!("Copied remote config for '{}': {}", name, path.display());
                            exported_items.push("remote-config");
                            break;
                        }
                    } else {
                        fs::copy(&path, out_remotes.join(path.file_name().unwrap())).ok();
                        debug!("Copied remote config: {}", path.display());
                    }
                }
            }
            if export_type != ExportType::SpecificRemote {
                exported_items.push("remote-configs");
            }
        }
    }

    // **NEW: Export specific remote from rclone.conf via RC API**
    if export_type == ExportType::SpecificRemote {
        if let Some(ref name) = remote_name {
            info!("Attempting to export specific remote '{}' via RC API", name);

            match get_remote_config(name.to_string(), app_handle.state::<RcloneState>()).await {
                Ok(config) => {
                    let rclone_remotes_dir = export_dir.join("rclone_remotes");
                    fs::create_dir_all(&rclone_remotes_dir)
                        .map_err(|e| format!("Failed to create rclone_remotes dir: {}", e))?;

                    let config_file =
                        rclone_remotes_dir.join(format!("{}.json", name.replace(" ", "_")));
                    fs::write(
                        &config_file,
                        serde_json::to_string_pretty(&config)
                            .map_err(|e| format!("Failed to serialize config: {}", e))?,
                    )
                    .map_err(|e| format!("Failed to write rclone config: {}", e))?;

                    info!(
                        "Exported rclone remote '{}' configuration to: {:?}",
                        name, config_file
                    );
                    exported_items.push("rclone-remote-config");
                }
                Err(e) => {
                    warn!("Failed to export remote '{}' from rclone: {}", name, e);
                    // Continue anyway - maybe the remote only exists in JSON files
                }
            }
        }
    }

    // Full rclone.conf export
    if export_type == ExportType::All || export_type == ExportType::Remotes {
        debug!("Attempting to resolve rclone config path for export.");
        let resolved_config_path = match get_rclone_config_file(app_handle.clone()).await {
            Ok(path) => {
                info!("Resolved rclone config path: {}", path.display());
                path
            }
            Err(e) => {
                warn!("⚠️ Failed to get rclone config path: {e}");
                return Err(format!("⚠️ Failed to get rclone config path: {e}"));
            }
        };

        if resolved_config_path.exists() {
            fs::copy(&resolved_config_path, export_dir.join("rclone.conf")).ok();
            exported_items.push("remotes");
        }
        config_path = Some(resolved_config_path);
    }

    // Write export_info.json
    let export_info = json!({
        "exported": exported_items,
        "timestamp": timestamp.to_rfc3339(),
        "remote_name": remote_name,
        "rclone_config_file": config_path,
        "export_type": format!("{:?}", export_type)
    });

    fs::write(export_dir.join("export_info.json"), export_info.to_string())
        .map_err(|e| format!("Failed to write export_info.json: {e}"))?;

    // Create archive
    if let Some(pw) = password.filter(|p| !p.trim().is_empty()) {
        info!(
            "Creating encrypted 7z archive at: {}",
            archive_path.display()
        );
        let seven_zip =
            find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {e}"))?;
        let status = Command::new(seven_zip)
            .current_dir(export_dir)
            .arg("a")
            .arg("-mhe=on")
            .arg(format!("-p{pw}"))
            .arg(archive_path.to_string_lossy().to_string())
            .arg(".")
            .status()
            .map_err(|e| format!("Failed to execute 7z: {e}"))?;

        if !status.success() {
            return Err("7z failed to create encrypted archive.".into());
        }
    } else {
        info!(
            "Creating standard ZIP archive at: {}",
            archive_path.display()
        );
        let file =
            File::create(&archive_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let options = FileOptions::<'static, ()>::default()
            .compression_method(zip::CompressionMethod::Stored);

        for entry in walkdir::WalkDir::new(export_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.is_file() {
                let rel_path = path.strip_prefix(export_dir).unwrap();
                zip.start_file(rel_path.to_string_lossy(), options)
                    .map_err(|e| format!("Failed to start file in zip: {e}"))?;
                zip.write_all(&fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?)
                    .map_err(|e| format!("Failed to write to zip: {e}"))?;
            }
        }

        zip.finish()
            .map_err(|e| format!("Failed to finish zip archive: {e}"))?;
    }

    info!("Backup completed: {}", archive_path.display());
    Ok(format!("Backup created at: {}", archive_path.display()))
}

#[tauri::command]
pub async fn analyze_backup_file(path: PathBuf) -> Result<BackupAnalysis, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "7z" => {
            let encrypted = is_7z_encrypted(&path)?;
            Ok(BackupAnalysis {
                is_encrypted: encrypted,
                archive_type: "7z".to_string(),
            })
        }
        "zip" => Ok(BackupAnalysis {
            is_encrypted: false,
            archive_type: "zip".to_string(),
        }),
        _ => Err("Unsupported archive type".into()),
    }
}
