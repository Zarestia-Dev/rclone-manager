use chrono::Local;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::{
    fs::{self, create_dir_all, File},
    io::{BufReader, Write},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::{write::FileOptions, ZipArchive, ZipWriter};

use crate::{utils::types::{AppSettings, BackupAnalysis, SettingsState}, RcloneState};

/// **Load settings from store**
#[tauri::command]
pub async fn load_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store_arc = &state.store;
    let store_guard = store_arc.lock().await;

    // Reload from disk, but handle missing file gracefully
    if let Err(e) = store_guard.reload() {
        // If file not found, return default settings
        match &e {
            tauri_plugin_store::Error::Io(io_err) if io_err.kind() == std::io::ErrorKind::NotFound => {
                let default_settings = AppSettings::default();
                let metadata = AppSettings::get_metadata();
                let response = json!({
                    "settings": serde_json::to_value(default_settings).unwrap(),
                    "metadata": metadata
                });
                return Ok(response);
            }
            _ => {}
        }
        return Err(format!("Failed to reload settings store: {}", e));
    }

    // **Load stored settings**
    let stored_settings = store_guard
        .get("app_settings")
        .unwrap_or_else(|| json!({}))
        .clone();

    // **Load default settings**
    let default_settings = AppSettings::default();
    let metadata = AppSettings::get_metadata();

    // **Merge stored values while keeping metadata**
    let mut merged_settings = serde_json::to_value(default_settings).unwrap();
    if let Some(merged_obj) = merged_settings.as_object_mut() {
        for (category, values) in merged_obj.iter_mut() {
            if let Some(stored_category) = stored_settings.get(category) {
                if let Some(values_obj) = values.as_object_mut() {
                    for (key, value) in values_obj.iter_mut() {
                        if let Some(stored_value) = stored_category.get(key) {
                            *value = stored_value.clone();
                        }
                    }
                }
            }
        }
    }

    let response = json!({
        "settings": merged_settings,
        "metadata": metadata
    });

    info!("✅ Settings loaded successfully.");
    Ok(response)
}

#[tauri::command]
pub async fn load_setting_value<'a>(
    category: String,
    key: String,
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store_arc = &state.store;
    let store_guard = store_arc.lock().await;

    // Reload from disk
    store_guard
        .reload()
        .map_err(|e| format!("Failed to reload settings store: {}", e))?;

    // Load stored settings
    let stored_settings = store_guard
        .get("app_settings")
        .unwrap_or_else(|| json!({}))
        .clone();

    // Load default settings
    let default_settings = serde_json::to_value(AppSettings::default()).unwrap();

    // Try to get the value from stored settings, else fallback to default
    let value = stored_settings
        .get(&category)
        .and_then(|cat| cat.get(&key))
        .or_else(|| {
            default_settings
                .get(&category)
                .and_then(|cat| cat.get(&key))
        })
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    Ok(value)
}

/// **Save only modified settings**
#[tauri::command]
pub async fn save_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    updated_settings: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let store = state.store.lock().await;

    // Load stored settings
    let mut stored_settings = store.get("app_settings").unwrap_or_else(|| json!({}));

    // Prepare a new object to store only changed values
    let mut changed_settings = serde_json::Map::new();

    // Merge updates dynamically and track changes
    if let Some(settings_obj) = updated_settings.as_object() {
        for (category, new_values) in settings_obj.iter() {
            if let Some(stored_category) = stored_settings.get_mut(category) {
                if let Some(stored_obj) = stored_category.as_object_mut() {
                    let mut category_changes = serde_json::Map::new();

                    for (key, value) in new_values.as_object().unwrap() {
                        // ✅ Only update if the value is different
                        if stored_obj.get(key) != Some(value) {
                            stored_obj.insert(key.clone(), value.clone());
                            category_changes.insert(key.clone(), value.clone());
                        }
                    }

                    // ✅ Only add category if there are changes
                    if !category_changes.is_empty() {
                        changed_settings.insert(
                            category.clone(),
                            serde_json::Value::Object(category_changes),
                        );
                    }
                }
            } else {
                // New category added
                stored_settings
                    .as_object_mut()
                    .unwrap()
                    .insert(category.clone(), new_values.clone());
                changed_settings.insert(category.clone(), new_values.clone());
            }
        }
    }

    // Save only the changed settings
    if !changed_settings.is_empty() {
        store.set("app_settings".to_string(), stored_settings);
        store.save().map_err(|e| {
            error!("❌ Failed to save settings: {}", e);
            e.to_string()
        })?;

        debug!(
            "🟢 Emitting system_settings_changed with payload: {:?}",
            changed_settings
        );

        // ✅ Emit only changed settings
        app_handle
            .emit("system_settings_changed", changed_settings.clone())
            .unwrap();
    } else {
        debug!("⚠️ No changes detected, skipping emission.");
    }

    info!("✅ Settings saved successfully.");
    Ok(())
}

/// **Save remote settings (per remote)**
#[tauri::command]
pub async fn save_remote_settings(
    remote_name: String,
    mut settings: Value, // **Accepts dynamic JSON**
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // **Ensure config directory exists**
    if state.config_dir.exists() && !state.config_dir.is_dir() {
        fs::remove_file(&state.config_dir)
            .map_err(|e| format!("❌ Failed to remove file: {}", e))?;
    }
    create_dir_all(&state.config_dir)
        .map_err(|e| format!("❌ Failed to create config dir: {}", e))?;

    let remote_config_dir = state.config_dir.join("remotes");
    let remote_config_path = remote_config_dir.join(format!("{}.json", remote_name));

    // **Ensure "remotes" directory exists**
    if remote_config_dir.exists() && !remote_config_dir.is_dir() {
        fs::remove_file(&remote_config_dir)
            .map_err(|e| format!("❌ Failed to remove file: {}", e))?;
    }
    create_dir_all(&remote_config_dir)
        .map_err(|e| format!("❌ Failed to create remotes directory: {}", e))?;

    // **Merge new settings with existing ones**
    if remote_config_path.exists() {
        let existing_content = fs::read_to_string(&remote_config_path)
            .map_err(|e| format!("❌ Failed to read existing settings: {}", e))?;
        let mut existing_settings: Value = serde_json::from_str(&existing_content)
            .map_err(|e| format!("❌ Failed to parse existing settings: {}", e))?;

        if let (Some(existing_obj), Some(new_obj)) =
            (existing_settings.as_object_mut(), settings.as_object_mut())
        {
            for (key, value) in new_obj {
                existing_obj.insert(key.clone(), value.clone());
            }
            settings = Value::Object(existing_obj.clone());
        }
    }

    // **Save to JSON file**
    let mut file = File::create(&remote_config_path)
        .map_err(|e| format!("❌ Failed to create settings file: {}", e))?;

    file.write_all(settings.to_string().as_bytes())
        .map_err(|e| format!("❌ Failed to save settings: {}", e))?;

    info!("✅ Remote settings saved at {:?}", remote_config_path);

    app_handle.emit("remote_presence_changed", remote_name).ok();
    Ok(())
}

/// **Delete remote settings**
#[tauri::command]
pub async fn delete_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let remote_config_path = state
        .config_dir
        .join("remotes")
        .join(format!("{}.json", remote_name));

    if !remote_config_path.exists() {
        warn!("⚠️ Remote settings for '{}' not found.", remote_name);
        return Err(format!(
            "⚠️ Remote settings for '{}' not found.",
            remote_name
        ));
    }

    fs::remove_file(&remote_config_path).map_err(|e| {
        error!("❌ Failed to delete remote settings: {}", e);
        format!("❌ Failed to delete remote settings: {}", e)
    })?;

    info!("✅ Remote settings for '{}' deleted.", remote_name);

    app_handle.emit("remote_presence_changed", remote_name).ok();
    Ok(())
}

/// **Retrieve settings for a specific remote**
#[tauri::command]
pub async fn get_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let remote_config_path = state
        .config_dir
        .join("remotes")
        .join(format!("{}.json", remote_name));

    if !remote_config_path.exists() {
        warn!("⚠️ Remote settings for '{}' not found.", remote_name);
        return Err(format!(
            "⚠️ Remote settings for '{}' not found.",
            remote_name
        ));
    }

    let file_content = fs::read_to_string(&remote_config_path)
        .map_err(|e| format!("❌ Failed to read remote settings: {}", e))?;
    let settings: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|e| format!("❌ Failed to parse remote settings: {}", e))?;

    info!("✅ Loaded settings for remote '{}'.", remote_name);
    Ok(settings)
}

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

    let timestamp = Local::now();
    let archive_name = match remote_name.clone() {
        Some(name) => format!(
            "remote_{}_export_{}.{}",
            name,
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if password.is_some() { "7z" } else { "zip" }
        ),
        None => format!(
            "settings_export_{}.{}",
            timestamp.format("%Y-%m-%d_%H-%M-%S"),
            if password.is_some() { "7z" } else { "zip" }
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
    if let Some(pw) = password {
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

pub fn is_7z_encrypted(path: &Path) -> Result<bool, String> {
    let seven_zip =
        find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {}", e))?;
    let output = Command::new(seven_zip)
        .arg("l")
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run 7z: {}", e))?;

    if !output.status.success() {
        return Ok(true); // possibly encrypted
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if stdout.contains("Headers Encrypted") || stderr.contains("Wrong password") {
        Ok(true)
    } else {
        Ok(false)
    }
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
        find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {}", e))?;
    let output = Command::new(seven_zip)
        .args(&["x", path.to_str().unwrap()])
        .arg(format!("-p{}", password))
        .arg(format!("-o{}", out_path))
        .output()
        .map_err(|e| format!("Failed to extract archive: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "7z extraction failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Use same logic from `restore_settings` to restore from `out_path`
    restore_settings_from_path(Path::new(out_path), state, app_handle).await
}

pub async fn restore_settings_from_path(
    extracted_dir: &Path,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!(
        "Restoring settings from extracted path: {:?}",
        extracted_dir
    );

    let export_info_path = extracted_dir.join("export_info.json");
    let export_info: Option<serde_json::Value> = std::fs::read_to_string(&export_info_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let exported_rclone_path = export_info
        .as_ref()
        .and_then(|info| info.get("rclone_config_path"))
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
                        .and_then(|c| c.get("rclone_config_path"))
                        .and_then(|p| p.as_str())
                        .filter(|s| !s.trim().is_empty());

                    if let Some(custom) = custom_path {
                        PathBuf::from(custom)
                    } else {
                        get_rclone_config_path(&app_handle)
                            .unwrap_or_else(|_| state.config_dir.join("rclone.conf"))
                    }
                }
            }

            name if name.starts_with("remotes/") => {
                let remote_name = name.trim_start_matches("remotes/");
                let remotes_dir = state.config_dir.join("remotes");
                create_dir_all(&remotes_dir)
                    .map_err(|e| format!("Failed to create remotes dir: {}", e))?;
                remotes_dir.join(remote_name)
            }

            "export_info.json" => state.config_dir.join("last_import_info.json"),

            _ => {
                debug!("Skipping unknown file: {}", file_name);
                continue;
            }
        };

        if let Some(parent) = out_path.parent() {
            create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
        }

        std::fs::copy(entry.path(), &out_path)
            .map_err(|e| format!("Failed to copy to {:?}: {}", out_path, e))?;

        info!("Restored: {:?}", out_path);
    }
    // Load the settings from the restored settings.json
    let settings_path = state.config_dir.join("settings.json");
    let settings_content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;
    let new_settings: serde_json::Value = serde_json::from_str(&settings_content)
        .map_err(|e| format!("Failed to parse settings file: {}", e))?;

    app_handle.emit("remote_presence_changed", json!({})).ok();
    app_handle
        .emit(
            "system_settings_changed",
            serde_json::to_value(new_settings.get("app_settings")).unwrap(),
        )
        .ok();

    Ok("Settings restored successfully.".to_string())
}

#[tauri::command]
pub async fn restore_settings(
    backup_path: PathBuf,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    info!("Starting restore_settings from {:?}", backup_path);

    let file = File::open(&backup_path).map_err(|e| format!("Failed to open backup: {}", e))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid ZIP: {}", e))?;

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        let out_path = temp_dir.path().join(file.name());
        debug!("Extracting file: {:?}", out_path);

        if let Some(parent) = out_path.parent() {
            create_dir_all(parent).map_err(|e| format!("Failed to create parent: {}", e))?;
        }

        let mut outfile =
            File::create(&out_path).map_err(|e| format!("Failed to create file: {}", e))?;
        std::io::copy(&mut file, &mut outfile).map_err(|e| format!("Copy error: {}", e))?;
    }

    restore_settings_from_path(temp_dir.path(), state, app_handle).await
}

fn find_7z_executable() -> Result<String, String> {
    for cmd in ["7z", "7za", "7z.exe", "7za.exe"] {
        if which::which(cmd).is_ok() {
            return Ok(cmd.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // use winreg::enums::*;
        // use winreg::RegKey;

        let common_paths = [
            r"C:\Program Files\7-Zip\7z.exe",
            r"C:\Program Files (x86)\7-Zip\7z.exe",
            r"C:\tools\7zip\7z.exe",
        ];

        for path in common_paths.iter() {
            if Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }

        // if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\7-Zip") {
        //     if let Ok(install_path) = hklm.get_value::<String, _>("Path") {
        //         let exe_path = format!("{}\\7z.exe", install_path);
        //         if Path::new(&exe_path).exists() {
        //             return Ok(exe_path);
        //         }
        //     }
        // }
    }

    Err("7z executable not found".into())
}

#[tauri::command]
pub async fn reset_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let default_settings = AppSettings::default();
    let default_settings_value = serde_json::to_value(default_settings)
        .map_err(|e| format!("Failed to serialize default settings: {}", e.to_string()))?;
    save_settings(state, default_settings_value, app_handle.clone()).await?;

    app_handle.emit("remote_presence_changed", json!({})).ok();
    app_handle.emit("system_settings_changed", json!({})).ok();
    Ok(())
}

pub fn get_rclone_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Get default path from rclone
    let rclone_state = app.state::<RcloneState>();
    let rclone_path = rclone_state.rclone_path.read().unwrap().clone();
    let output = Command::new(&rclone_path)
        .arg("config")
        .arg("file")
        .output()
        .map_err(|e| format!("Failed to execute rclone: {}", e))?;

    debug!("Rclone config output: {:?}", output);
    if !output.status.success() {
        return Err("Failed to get rclone config path".to_string());
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid output from rclone: {}", e))?;

    // rclone prints: "Configuration file is stored at:\n/path/to/file\n"
    // Extract the last non-empty line as the path
    let path_str = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("Could not parse rclone config path")?
        .trim()
        .to_string();

    debug!("Rclone config path: {}", path_str);
    Ok(PathBuf::from(path_str))
}
