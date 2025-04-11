use chrono::Local;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use zip::write::FileOptions;
use std::{
    fs::{self, create_dir_all, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Runtime, State};
use tauri_plugin_store::Store;

use super::settings_store::AppSettings;

/// **Global settings state**
pub struct SettingsState<R: Runtime> {
    pub store: Arc<Mutex<Arc<Store<R>>>>,
    pub config_dir: PathBuf,
}

/// **Load settings from store**
#[tauri::command]
pub async fn load_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store = state.store.lock().unwrap();

    // **Load stored settings**
    let stored_settings = store
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

/// **Save only modified settings**
#[tauri::command]
pub async fn save_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    updated_settings: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let store = state.store.lock().unwrap();

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
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<String, String> {
    let backup_path = PathBuf::from(backup_dir);

    if !backup_path.exists() {
        fs::create_dir_all(&backup_path)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;
    }

    // Add timestamp to the filename
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let backup_file_path = backup_path.join(format!("settings_backup_{}.zip", timestamp));

    let file = File::create(&backup_file_path)
        .map_err(|e| format!("Failed to create backup file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);

    let options: FileOptions<'_, ()> = FileOptions::<'static, ()>::default().compression_method(zip::CompressionMethod::Stored);

    // === settings.json ===
    let store_path = state.config_dir.join("settings.json");
    if store_path.exists() {
        zip.start_file("settings.json", options)
            .map_err(|e| format!("Failed to add settings.json to zip: {}", e))?;
        let store_data = fs::read(&store_path)
            .map_err(|e| format!("Failed to read settings.json: {}", e))?;
        zip.write_all(&store_data)
            .map_err(|e| format!("Failed to write settings.json to zip: {}", e))?;
    }

    // === Remotes ===
    let remotes_dir = state.config_dir.join("remotes");
    if remotes_dir.exists() {
        for entry in fs::read_dir(remotes_dir)
            .map_err(|e| format!("Failed to read remotes directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Error reading file entry: {}", e))?;
            let path = entry.path();

            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let filename = path.file_name().unwrap().to_string_lossy();
                zip.start_file(format!("remotes/{}", filename), options)
                    .map_err(|e| format!("Failed to add remote '{}': {}", filename, e))?;

                let content = fs::read(&path)
                    .map_err(|e| format!("Failed to read remote '{}': {}", filename, e))?;
                zip.write_all(&content)
                    .map_err(|e| format!("Failed to write remote '{}': {}", filename, e))?;
            }
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finish writing zip: {}", e))?;

    Ok(backup_file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn restore_settings(
    backup_path: &Path,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let file = File::open(backup_path).map_err(|e| format!("Failed to open backup file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("Failed to access file in archive: {}", e))?;
        let out_path = match file.name() {
            "settings.json" => state.config_dir.join("settings.json"),
            name if name.starts_with("remotes/") => {
                let remote_name = name.trim_start_matches("remotes/");
                let remote_config_dir = state.config_dir.join("remotes");
                let remote_config_path = remote_config_dir.join(remote_name);
                create_dir_all(&remote_config_dir).map_err(|e| format!("Failed to create remote config directory: {}", e))?;
                remote_config_path
            }
            _ => continue,
        };

        let mut out_file = File::create(out_path).map_err(|e| format!("Failed to create output file: {}", e))?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| format!("Failed to copy file content: {}", e))?;
    }

    app_handle.emit("remote_presence_changed", json!({})).ok();
    app_handle.emit("system_settings_changed", json!({})).ok();
    Ok(())
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