use crate::utils::types::events::{REMOTE_PRESENCE_CHANGED, SYSTEM_SETTINGS_CHANGED};
use crate::{
    core::settings::backup::archive_utils::find_7z_executable,
    rclone::queries::get_rclone_config_file, utils::types::settings::SettingsState,
};
use log::{debug, info};
use serde_json::json;
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

#[tauri::command]
pub async fn restore_settings(
    backup_path: PathBuf,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting restore_settings from {backup_path:?}");

    let file = File::open(&backup_path).map_err(|e| format!("Failed to open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid ZIP: {e}"))?;

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {e}"))?;
        let out_path = temp_dir.path().join(file.name());
        debug!("Extracting file: {out_path:?}");

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent: {e}"))?;
        }

        let mut outfile =
            File::create(&out_path).map_err(|e| format!("Failed to create file: {e}"))?;
        std::io::copy(&mut file, &mut outfile).map_err(|e| format!("Copy error: {e}"))?;
    }

    restore_settings_from_path(temp_dir.path(), state, app_handle).await
}

pub async fn restore_settings_from_path(
    extracted_dir: &Path,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Restoring settings from extracted path: {extracted_dir:?}");

    let export_info_path = extracted_dir.join("export_info.json");
    let export_info: Option<serde_json::Value> = std::fs::read_to_string(&export_info_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let exported_rclone_path = export_info
        .as_ref()
        .and_then(|info| info.get("rclone_config_file"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);

    for entry in walkdir::WalkDir::new(extracted_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let relative_path = entry.path().strip_prefix(extracted_dir).unwrap();
        let file_name = relative_path.to_string_lossy();

        let out_path = match file_name.as_ref() {
            "settings.json" => state.config_dir.join("settings.json"),

            "rclone.conf" => {
                if let Some(ref custom) = exported_rclone_path {
                    custom.clone()
                } else {
                    // fallback to default logic
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
            }

            name if name.starts_with("remotes/") => {
                let remote_name = name.trim_start_matches("remotes/");
                let remotes_dir = state.config_dir.join("remotes");
                fs::create_dir_all(&remotes_dir)
                    .map_err(|e| format!("Failed to create remotes dir: {e}"))?;
                remotes_dir.join(remote_name)
            }

            "export_info.json" => state.config_dir.join("last_import_info.json"),

            _ => {
                debug!("Skipping unknown file: {file_name}");
                continue;
            }
        };

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {e}"))?;
        }

        std::fs::copy(entry.path(), &out_path)
            .map_err(|e| format!("Failed to copy to {out_path:?}: {e}"))?;

        info!("Restored: {out_path:?}");
    }
    // Load the settings from the restored settings.json
    let settings_path = state.config_dir.join("settings.json");
    let settings_content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings file: {e}"))?;
    let new_settings: serde_json::Value = serde_json::from_str(&settings_content)
        .map_err(|e| format!("Failed to parse settings file: {e}"))?;

    app_handle.emit(REMOTE_PRESENCE_CHANGED, ()).ok();
    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            serde_json::to_value(new_settings.get("app_settings")).unwrap(),
        )
        .ok();

    Ok("Settings restored successfully.".to_string())
}

#[tauri::command]
pub async fn restore_encrypted_settings(
    path: PathBuf,
    password: String,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // example: 7z x archive_path -p{password} -o{temp_dir}
    let temp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let out_path = temp_dir.path().to_str().unwrap();

    let seven_zip =
        find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {e}"))?;
    let output = Command::new(seven_zip)
        .args(["x", path.to_str().unwrap()])
        .arg(format!("-p{password}"))
        .arg(format!("-o{out_path}"))
        .output()
        .map_err(|e| format!("Failed to extract archive: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "7z extraction failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Use same logic from `restore_settings` to restore from `out_path`
    restore_settings_from_path(Path::new(out_path), state, app_handle).await
}
