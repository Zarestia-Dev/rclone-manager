use crate::{
    core::settings::{
        backup::archive_utils::{find_7z_executable, is_7z_encrypted},
        utils::path_utils::get_rclone_config_path,
    },
    utils::types::{BackupAnalysis, SettingsState},
};
use chrono::Local;
use log::{debug, warn};
use serde_json::json;
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    process::Command,
};
use tauri::{AppHandle, State};
use zip::{write::FileOptions, ZipWriter};

#[tauri::command]
pub async fn backup_settings(
    backup_dir: String,
    export_type: String, // "all", "settings", "remotes", "remote-configs", "specific-remote"
    password: Option<String>,
    remote_name: Option<String>, // New parameter for specific remote
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let backup_path = PathBuf::from(&backup_dir);
    fs::create_dir_all(&backup_path)
        .map_err(|e| format!("Failed to create backup directory: {}", e))?;

    let has_password = password.as_ref().map_or(false, |p| !p.trim().is_empty());
    let timestamp = Local::now();
    let archive_name = match remote_name.clone() {
        Some(name) => format!(
            "remote_{}_export_{}.{}",
            name,
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if has_password { "7z" } else { "zip" }
        ),
        _ => format!(
            "settings_export_{}.{}",
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if has_password { "7z" } else { "zip" }
        ),
    };
    let archive_path = backup_path.join(archive_name);

    // Create a temporary folder and collect files
    let tmp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let export_dir = tmp_dir.path();

    let mut exported_items = vec![];
    let mut config_path: Option<PathBuf> = None;

    if export_type == "all" || export_type == "settings" {
        let settings_path = state.config_dir.join("settings.json");
        if settings_path.exists() {
            fs::copy(&settings_path, export_dir.join("settings.json")).ok();
            exported_items.push("settings");
        }
    }

    if export_type == "all" || export_type == "remote-configs" || export_type == "specific-remote" {
        let remotes_dir = state.config_dir.join("remotes");
        let out_remotes = export_dir.join("remotes");
        fs::create_dir_all(&out_remotes).ok();

        if remotes_dir.exists() {
            for entry in match fs::read_dir(remotes_dir) {
                Ok(rd) => rd,
                Err(_) => {
                    warn!("⚠️ Failed to read remotes directory.");
                    return Err("⚠️ Failed to read remotes directory.".to_string());
                }
            } {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    // For specific remote, only copy that one
                    if export_type == "specific-remote" {
                        if let Some(name) = &remote_name {
                            if path.file_stem().unwrap().to_str().unwrap() == name {
                                fs::copy(&path, out_remotes.join(path.file_name().unwrap())).ok();
                                exported_items.push("remote-config");
                                break;
                            }
                        }
                    } else {
                        // For all remote configs, copy everything
                        fs::copy(&path, out_remotes.join(path.file_name().unwrap())).ok();
                    }
                }
            }
            if export_type != "specific-remote" {
                exported_items.push("remote-configs");
            }
        }
    }

    if (export_type == "all" || export_type == "remotes") && remote_name.is_none() {
        let resolved_config_path = match get_rclone_config_path(&app_handle) {
            Ok(path) => path,
            Err(e) => {
                warn!("⚠️ Failed to get rclone config path: {}", e);
                return Err(format!("⚠️ Failed to get rclone config path: {}", e));
            }
        };
        debug!("Rclone config path: {:?}", resolved_config_path);
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
        "rclone_config_path": config_path
            .as_ref()
            .map(|p| p.to_string_lossy())
            .unwrap_or_else(|| "".into()),
    });
    fs::write(export_dir.join("export_info.json"), export_info.to_string())
        .map_err(|e| format!("Failed to write export_info.json: {}", e))?;

    // Create archive (same as before)
    if let Some(pw) = password.filter(|p| !p.trim().is_empty()) {
        // 7z encrypted
        let seven_zip =
            find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {}", e))?;
        let status = Command::new(seven_zip)
            .current_dir(export_dir)
            .arg("a")
            .arg("-mhe=on")
            .arg(format!("-p{}", pw))
            .arg(archive_path.to_string_lossy().to_string())
            .arg(".")
            .status()
            .map_err(|e| format!("Failed to execute 7z: {}", e))?;

        if !status.success() {
            return Err("7z failed to create encrypted archive.".into());
        }
    } else {
        // Standard ZIP archive
        let file =
            File::create(&archive_path).map_err(|e| format!("Failed to create zip file: {}", e))?;
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
                    .map_err(|e| format!("Failed to start file in zip: {}", e))?;
                zip.write_all(
                    &fs::read(path)
                        .map_err(|e| format!("Failed to read file {}: {}", path.display(), e))?,
                )
                .map_err(|e| format!("Failed to write file {} to zip: {}", path.display(), e))?;
            }
        }

        zip.finish()
            .map_err(|e| format!("Failed to finish zip archive: {}", e))?;
    }

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
        "zip" => {
            // We assume your .zip backups are always unencrypted unless you add zip password support
            Ok(BackupAnalysis {
                is_encrypted: false,
                archive_type: "zip".to_string(),
            })
        }
        _ => Err("Unsupported archive type".into()),
    }
}
